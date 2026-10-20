// F20 rules shared by the service, the mock and the dashboard (src/shared/scraptfHistory.ts): the change
// events of a save against the previous save of its page, an event valued now, the runs index (time
// listed), one item's history, the Live market's listed filter, the feed's CSV cells and the re-save
// reminders' texts. Pure; nothing here touches the network or scrap.tf.

import { describe, expect, it } from 'vitest';
import { bankStockKey } from '../../src/shared/bankStock';
import { SCRAPTF_BANKS, STATIC_EXTERNAL_URLS, isAllowedExternalUrl, isScraptfBankUrl } from '../../src/shared/links';
import {
  SCRAPTF_CHANGES_CSV_COLUMNS,
  SCRAPTF_ITEM_EVENTS,
  SCRAPTF_LONG_LISTED_MS,
  SCRAPTF_RESAVE_HELP,
  marketListedSideMatches,
  scraptfAgoText,
  scraptfChangeCsvCells,
  scraptfChangeEvent,
  scraptfChangesLimit,
  scraptfEventMatches,
  scraptfEventsOf,
  scraptfItemHistoryOf,
  scraptfListedSinceOf,
  scraptfObservationsOf,
  scraptfResaveBanksOf,
  scraptfResaveDue,
  scraptfResaveNotice,
  scraptfRunsOf,
  type ScraptfSaveRows,
} from '../../src/shared/scraptfHistory';
import type { BankStockStored, KeyPriceState, ScraptfChangeEvent, ScraptfEventStored, ScraptfKeyRun } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const K = 600;
const KEY: KeyPriceState = { valueScrap: K, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

function row(sku: string, price: number | null, stock: number | null = 1, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: price === null ? null : 0, costScrap: price, stock, assetId: null, ...over };
}

let batch = 100;
function save(at: number, page: string, rows: BankStockStored[]): ScraptfSaveRows {
  return { batchId: batch++, savedAt: at, page, rows };
}

describe('scraptfEventsOf (S2)', () => {
  const base = { bank: 'hats' as const, page: '/buy/hats', at: NOW, batchId: 9, keyScrap: K };

  it('writes nothing for a first save or a save without rows', () => {
    expect(scraptfEventsOf({ ...base, newest: [row('1;6', 10)], previous: null })).toEqual([]);
    expect(scraptfEventsOf({ ...base, newest: [], previous: [row('1;6', 10)] })).toEqual([]);
  });

  it('one event per change, by F17 matching and rules, plus restocked and stock', () => {
    const previous = [
      row('1;6', 30, 2),
      row('2;6', 40),
      row('3;6', 50),
      row('4;6', 20, 0), // listed sold out
      row('5;6', 10, 3),
      row('6;6', 25, 2), // gone next
      row('9;6', 15, null), // stock unknown
      row('10;6', 0, 1, { costKeys: 1 }), // 1 key
    ];
    const newest = [
      row('1;6', 27, 2), // cheaper
      row('2;6', 45), // pricier
      row('3;6', 50), // unchanged
      row('4;6', 20, 4), // back on sale: seen before, so restocked
      row('5;6', 10, 5), // stock only
      row('7;6', 33), // new
      row('8;6', 12), // absent before, but an earlier save listed it: restocked
      row('9;6', 15, 3), // unknown stock to 3: no change
      row('10;6', 590, 1), // 1 key (600) to 590: cheaper at the key price
    ];
    const events = scraptfEventsOf({ ...base, newest, previous, seenBefore: (key) => key === bankStockKey('8;6', '') });
    expect(events.map((e) => [e.sku, e.kind, e.fromKeys, e.fromScrap, e.toKeys, e.toScrap, e.fromStock, e.toStock])).toEqual([
      ['1;6', 'cheaper', 0, 30, 0, 27, 2, 2],
      ['2;6', 'pricier', 0, 40, 0, 45, 1, 1],
      ['4;6', 'restocked', 0, 20, 0, 20, 0, 4],
      ['5;6', 'stock', 0, 10, 0, 10, 3, 5],
      ['7;6', 'new', null, null, 0, 33, null, 1],
      ['8;6', 'restocked', null, null, 0, 12, null, 1],
      ['10;6', 'cheaper', 1, 0, 0, 590, 1, 1],
      ['6;6', 'gone', 0, 25, null, null, 2, null],
    ]);
    for (const e of events) expect(e).toMatchObject({ at: NOW, bank: 'hats', page: '/buy/hats', batchId: 9, specialKey: '', name: `Item ${e.sku}` });
  });

  it('a row that sells out is gone with the newest stock; a painted copy is its own row', () => {
    const painted = '[5801378,[],[],null,null,false,false]';
    const events = scraptfEventsOf({
      ...base,
      previous: [row('1;6', 30, 2), row('1;6', 90, 1, { specialKey: painted })],
      newest: [row('1;6', 30, 0), row('1;6', 80, 1, { specialKey: painted })],
    });
    expect(events.map((e) => [e.specialKey, e.kind, e.toStock])).toEqual([
      ['', 'gone', 0],
      [painted, 'cheaper', 1],
    ]);
  });
});

describe('scraptfChangeEvent (S4)', () => {
  const stored: ScraptfEventStored = {
    id: 5,
    at: NOW,
    bank: 'hats',
    page: '/buy/hats',
    sku: '10;6',
    specialKey: '',
    name: 'Ten',
    kind: 'cheaper',
    fromKeys: 1,
    fromScrap: 0,
    toKeys: 0,
    toScrap: 590,
    fromStock: 1,
    toStock: 1,
    batchId: 9,
  };

  it('values both sides at the key price now and joins the live buy side: a flip when at or under Pay up to', () => {
    const e = scraptfChangeEvent(stored, K, { revenueScrap: 700, maxCostScrap: 590 });
    expect(e).toMatchObject({ ...stored, key: '10;6|', hasExtras: false, fromValueScrap: 600, toValueScrap: 590, deltaScrap: -10, revenueScrap: 700, maxCostScrap: 590, flip: true });
    expect(e.pct).toBeCloseTo(-10 / 600);
    expect(scraptfChangeEvent(stored, K, { revenueScrap: 700, maxCostScrap: 589 }).flip).toBe(false);
    expect(scraptfChangeEvent(stored, K, null)).toMatchObject({ revenueScrap: null, maxCostScrap: null, flip: false });
  });

  it('a gone event has no new price and is never a flip; equal raw prices never move', () => {
    const gone = scraptfChangeEvent({ ...stored, kind: 'gone', toKeys: null, toScrap: null }, K, { revenueScrap: 9000, maxCostScrap: 9000 });
    expect(gone).toMatchObject({ toValueScrap: null, deltaScrap: null, pct: null, flip: false });
    const stock = scraptfChangeEvent({ ...stored, kind: 'stock', fromKeys: 1, fromScrap: 5, toKeys: 1, toScrap: 5, specialKey: 'x' }, 613, null);
    expect(stock).toMatchObject({ fromValueScrap: 618, toValueScrap: 618, deltaScrap: 0, pct: 0, hasExtras: true, key: '10;6|x' });
  });

  it('the feed filters and the CSV line', () => {
    expect(scraptfEventMatches(stored, {})).toBe(true);
    expect(scraptfEventMatches(stored, { bank: 'list' })).toBe(false);
    expect(scraptfEventMatches(stored, { kinds: [] })).toBe(true);
    expect(scraptfEventMatches(stored, { kinds: ['new', 'cheaper'] })).toBe(true);
    expect(scraptfEventMatches(stored, { kinds: ['gone'] })).toBe(false);
    expect(scraptfEventMatches(stored, { baseSku: '10;6' })).toBe(true);
    expect(scraptfEventMatches(stored, { baseSku: '11;6' })).toBe(false);
    expect([scraptfChangesLimit(undefined), scraptfChangesLimit(0), scraptfChangesLimit(9_999), scraptfChangesLimit(2.7)]).toEqual([100, 1, 500, 2]);
    const e = scraptfChangeEvent(stored, K, { revenueScrap: 700, maxCostScrap: 590 });
    const cells = scraptfChangeCsvCells(e, K);
    expect(cells).toHaveLength(SCRAPTF_CHANGES_CSV_COLUMNS.length);
    expect(cells).toEqual(['2026-10-16T12:00:00.000Z', 'hats', '/buy/hats', '10;6', 'Ten', '', 'cheaper', '1 key', '65.55 ref', '-1.11 ref', -0.0167, 1, 1, '1 key 11.11 ref', '65.55 ref', 'yes']);
  });
});

describe('scraptfRunsOf (S3 runs index)', () => {
  // One bank, two pages of it. 2;6 moves from /items to /items/2; 1;6 stays on /items.
  const t = (h: number) => NOW - (10 - h) * HOUR;
  const saves = [
    save(t(1), '/items', [row('1;6', 10, 2), row('2;6', 20), row('3;6', 30, 0), row('4;6', 5)]),
    save(t(2), '/items', [row('1;6', 10, 2), row('3;6', 30), row('4;6', 5)]),
    save(t(3), '/items/2', [row('2;6', 18)]),
    save(t(4), '/items', [row('1;6', 9, 3), row('3;6', 30), row('4;6', 5, 0)]),
    save(t(5), '/items/2', [row('2;6', 18)]),
  ];

  it('time listed per copy across the pages of a bank (a move to another page is no break)', () => {
    const runs = scraptfRunsOf(saves);
    expect(runs.get('1;6|')).toEqual<ScraptfKeyRun>({
      key: '1;6|',
      sku: '1;6',
      specialKey: '',
      seenAt: t(1),
      firstSeenAt: t(1),
      lastSeenAt: t(4),
      listedSince: t(1),
      runStart: { keys: 0, scrap: 10 },
      current: { keys: 0, scrap: 9, stock: 3 },
      // 0.7.3: the price at lastSeenAt, kept once off sale (4;6 below).
      lastOnSale: { keys: 0, scrap: 9 },
    });
    // Absent from its home page at t(2): the run breaks there, and starts again on /items/2.
    expect(runs.get('2;6|')).toMatchObject({ seenAt: t(1), firstSeenAt: t(1), lastSeenAt: t(5), listedSince: t(3), runStart: { keys: 0, scrap: 18 } });
    // Listed sold out first: seen, but on sale only from t(2).
    expect(runs.get('3;6|')).toMatchObject({ seenAt: t(1), firstSeenAt: t(2), listedSince: t(2), current: { scrap: 30 } });
    // Sold out on its newest save: no current run.
    expect(runs.get('4;6|')).toMatchObject({ firstSeenAt: t(1), lastSeenAt: t(2), listedSince: null, runStart: null, current: null, lastOnSale: { keys: 0, scrap: 5 } });
    // Order in does not matter.
    expect(scraptfRunsOf([...saves].reverse())).toEqual(runs);
  });

  it('one key at a time reads the same observations (item history and the index agree)', () => {
    expect(scraptfObservationsOf(saves, '2;6|').map((o) => [o.at, o.page, o.onSale])).toEqual([
      [t(1), '/items', true],
      [t(2), '/items', false],
      [t(3), '/items/2', true],
      [t(5), '/items/2', true],
    ]);
    const runs = scraptfRunsOf(saves);
    for (const key of ['1;6|', '2;6|', '3;6|', '4;6|']) {
      const h = scraptfItemHistoryOf({ sku: key.slice(0, -1), specialKey: '', banks: [{ bank: 'list', saves }], events: [], keyPrice: KEY, now: NOW });
      const r = runs.get(key)!;
      expect([h.firstSeenAt, h.lastSeenAt, h.listedSince], key).toEqual([r.firstSeenAt, r.lastSeenAt, r.listedSince]);
    }
  });

  it('MarketRow.scraptfListedSince: the earliest run among the copies listed now', () => {
    const runs = new Map<string, ScraptfKeyRun>([
      ['5;6|', { key: '5;6|', sku: '5;6', specialKey: '', seenAt: 1, firstSeenAt: 1, lastSeenAt: 9, listedSince: 7, runStart: null, current: null }],
      ['5;6|p', { key: '5;6|p', sku: '5;6', specialKey: 'p', seenAt: 1, firstSeenAt: 1, lastSeenAt: 9, listedSince: 4, runStart: null, current: null }],
      ['5;6|q', { key: '5;6|q', sku: '5;6', specialKey: 'q', seenAt: 1, firstSeenAt: 1, lastSeenAt: 3, listedSince: null, runStart: null, current: null }],
      ['6;6|', { key: '6;6|', sku: '6;6', specialKey: '', seenAt: 1, firstSeenAt: 1, lastSeenAt: 9, listedSince: 1, runStart: null, current: null }],
    ]);
    expect(scraptfListedSinceOf(runs, '5;6')).toBe(4);
    expect(scraptfListedSinceOf(runs, '7;6')).toBeNull();
    expect(scraptfListedSinceOf(null, '5;6')).toBeNull();
    expect(marketListedSideMatches({ scraptfListedSince: null }, {}, NOW)).toBe(true);
    expect(marketListedSideMatches({ scraptfListedSince: null }, { listedOnScraptf: true }, NOW)).toBe(false);
    expect(marketListedSideMatches({ scraptfListedSince: NOW - SCRAPTF_LONG_LISTED_MS }, { listedOnScraptf: true }, NOW)).toBe(true);
    expect(marketListedSideMatches({ scraptfListedSince: NOW - 23 * HOUR }, { listedOnScraptf: true }, NOW)).toBe(false);
  });
});

describe('scraptfItemHistoryOf (S3)', () => {
  const hats = [
    save(NOW - 10 * DAY, '/buy/hats', [row('378;6', 40, 1)]),
    save(NOW - 8 * DAY, '/buy/hats', [row('126;6', 5)]),
    save(NOW - 2 * DAY, '/buy/hats', [row('378;6', 36, 1)]),
    save(NOW - 23 * HOUR, '/buy/hats', [row('378;6', 34, 1)]),
    save(NOW - 50 * MIN, '/buy/hats', [row('378;6', 33, 1)]),
    save(NOW - 10 * MIN, '/buy/hats', [row('378;6', 30, 2), row('378;6', 99, 1, { specialKey: 'painted' })]),
  ];
  const list = [save(NOW - 5 * MIN, '/items', [row('378;6', 31, 4)])];
  const event = (id: number, specialKey = ''): ScraptfChangeEvent =>
    scraptfChangeEvent({ id, at: NOW - id * MIN, bank: 'hats', page: '/buy/hats', sku: '378;6', specialKey, name: 'Team Captain', kind: 'cheaper', fromKeys: 0, fromScrap: 33, toKeys: 0, toScrap: 30, fromStock: 1, toStock: 2, batchId: 1 }, K, null);

  it('reads the bank page before the list: a price per save with gaps, time listed, the changes and stock now', () => {
    const h = scraptfItemHistoryOf({
      sku: '378;6',
      banks: [
        { bank: 'list', saves: list },
        { bank: 'hats', saves: hats },
      ],
      events: [event(1), event(2, 'painted'), event(3)],
      keyPrice: KEY,
      now: NOW,
    });
    expect(h).toMatchObject({ sku: '378;6', specialKey: '', name: 'Item 378;6', bank: 'hats', firstSeenAt: NOW - 10 * DAY, listedSince: NOW - 2 * DAY, lastSeenAt: NOW - 10 * MIN, keyPrice: KEY, generatedAt: NOW });
    expect(h.current).toEqual({ costScrap: 30, stock: 2, bank: 'hats' });
    expect(h.points.map((p) => [p.at, p.costScrap, p.listed, p.bank])).toEqual([
      [NOW - 10 * DAY, 40, true, 'hats'],
      [NOW - 8 * DAY, 0, false, 'hats'],
      [NOW - 2 * DAY, 36, true, 'hats'],
      [NOW - 23 * HOUR, 34, true, 'hats'],
      [NOW - 50 * MIN, 33, true, 'hats'],
      [NOW - 10 * MIN, 30, true, 'hats'],
    ]);
    // 1 h: the newest save at or before now - 1 h is the one 23 h ago; 24 h: two days ago; 7 d: not listed then.
    expect(h.change.h1).toMatchObject({ fromScrap: 34, toScrap: 30, deltaScrap: -4, since: NOW - 23 * HOUR });
    expect(h.change.h24).toMatchObject({ fromScrap: 36, toScrap: 30, deltaScrap: -6, since: NOW - 2 * DAY });
    expect(h.change.d7).toBeNull();
    expect(h.change.listed).toMatchObject({ fromScrap: 36, toScrap: 30, deltaScrap: -6, since: NOW - 2 * DAY });
    expect(h.change.listed!.pct).toBeCloseTo(-6 / 36);
    // The copy's own events only, newest first.
    expect(h.events.map((e) => e.id)).toEqual([3, 1]);
  });

  it('a painted copy reads its own rows; the list alone gives the list', () => {
    const painted = scraptfItemHistoryOf({ sku: '378;6', specialKey: 'painted', banks: [{ bank: 'hats', saves: hats }], events: [], keyPrice: KEY, now: NOW });
    expect(painted).toMatchObject({ specialKey: 'painted', bank: 'hats', listedSince: NOW - 10 * MIN, current: { costScrap: 99 } });
    expect(painted.points).toHaveLength(1);
    const listOnly = scraptfItemHistoryOf({ sku: '378;6', banks: [{ bank: 'list', saves: list }], events: [], keyPrice: KEY, now: NOW });
    expect(listOnly).toMatchObject({ bank: 'list', current: { costScrap: 31, stock: 4, bank: 'list' } });
    // A history of one save: nothing to compare with.
    expect(listOnly.change).toEqual({ h1: null, h24: null, d7: null, listed: { fromScrap: 31, toScrap: 31, deltaScrap: 0, pct: 0, since: NOW - 5 * MIN } });
  });

  it('an item gone from its page keeps its history but has no current run', () => {
    const gone = [...hats, save(NOW - MIN, '/buy/hats', [row('126;6', 5)])];
    const h = scraptfItemHistoryOf({ sku: '378;6', banks: [{ bank: 'hats', saves: gone }], events: [], keyPrice: KEY, now: NOW });
    expect(h).toMatchObject({ bank: 'hats', listedSince: null, current: null, lastSeenAt: NOW - 10 * MIN, firstSeenAt: NOW - 10 * DAY });
    expect(h.change).toEqual({ h1: null, h24: null, d7: null, listed: null });
    expect(h.points[h.points.length - 1]).toMatchObject({ at: NOW - MIN, listed: false, costScrap: 0 });
  });

  it('an item never seen in a save: an empty history named by the caller', () => {
    const events = Array.from({ length: SCRAPTF_ITEM_EVENTS + 5 }, (_, i) => event(i + 1));
    const h = scraptfItemHistoryOf({ sku: '5021;6', name: 'Mann Co. Supply Crate Key', banks: [{ bank: 'hats', saves: hats }], events, keyPrice: null, now: NOW });
    expect(h).toEqual({
      sku: '5021;6',
      specialKey: '',
      name: 'Mann Co. Supply Crate Key',
      bank: null,
      points: [],
      firstSeenAt: null,
      listedSince: null,
      lastSeenAt: null,
      current: null,
      change: { h1: null, h24: null, d7: null, listed: null },
      events: [],
      keyPrice: null,
      generatedAt: NOW,
    });
  });
});

describe('re-save reminders (S5)', () => {
  it('says how long ago in the reminder words', () => {
    expect([scraptfAgoText(65 * MIN), scraptfAgoText(45 * MIN), scraptfAgoText(2 * DAY + 3 * HOUR + 59 * MIN), scraptfAgoText(-5), scraptfAgoText(Number.NaN)]).toEqual(['1 h 05 m', '45 m', '2 d 3 h', '0 m', '0 m']);
  });

  it('reminds of the chosen banks, [] being every bank saved at least once, never of a bank never saved', () => {
    expect(scraptfResaveBanksOf([], ['hats', 'list'])).toEqual(['hats', 'list']);
    expect(scraptfResaveBanksOf(null, ['hats'])).toEqual(['hats']);
    expect(scraptfResaveBanksOf(['hats', 'weapons'], ['hats', 'list'])).toEqual(['hats']);
    expect(scraptfResaveBanksOf(['hats'], [])).toEqual([]);
  });

  it('is due once per N minutes after N minutes without a save', () => {
    const due = (lastSavedAt: number | null, lastRemindedAt: number | null, minutes = 60) => scraptfResaveDue({ minutes, lastSavedAt, lastRemindedAt, now: NOW });
    expect(due(NOW - 2 * HOUR, null, 0)).toBe(false);
    expect(due(null, null)).toBe(false);
    expect(due(NOW - 59 * MIN, null)).toBe(false);
    expect(due(NOW - 60 * MIN, null)).toBe(true);
    expect(due(NOW - 3 * HOUR, NOW - 10 * MIN)).toBe(false);
    expect(due(NOW - 3 * HOUR, NOW - 60 * MIN)).toBe(true);
    // Reminded before the latest save: that save started over.
    expect(due(NOW - 61 * MIN, NOW - 2 * HOUR)).toBe(true);
    // At most a day apart, whatever was stored.
    expect(due(NOW - DAY, NOW - DAY + MIN, 99_999)).toBe(false);
    expect(due(NOW - 2 * DAY, NOW - DAY, 99_999)).toBe(true);
  });

  it("names the bank's page and opens only its static, allowlisted URL", () => {
    const n = scraptfResaveNotice('hats', NOW - 65 * MIN, NOW)!;
    expect(n).toEqual({
      title: 'Re-save scrap.tf/buy/hats',
      body: "Last saved 1 h 05 m ago. Save it again (Ctrl+S, 'Webpage, Complete') to refresh prices and see what changed",
      sku: null,
      openUrl: 'https://scrap.tf/buy/hats',
    });
    for (const info of SCRAPTF_BANKS) {
      const url = scraptfResaveNotice(info.bank, NOW - HOUR, NOW)!.openUrl;
      expect(url).toBe(info.url);
      expect(STATIC_EXTERNAL_URLS).toContain(url);
      expect(isAllowedExternalUrl(url)).toBe(true);
    }
    expect(scraptfResaveNotice('__proto__' as never, NOW, NOW)).toBeNull();
    // Main's click-time check: the exact static bank URLs only.
    for (const info of SCRAPTF_BANKS) expect(isScraptfBankUrl(info.url)).toBe(true);
    for (const bad of ['https://scrap.tf/buy/hats/', 'https://scrap.tf/buy/hats?x=1', 'https://scrap.tf/terms', 'https://evil.example/buy/hats', 'HTTPS://SCRAP.TF/BUY/HATS', null, 5]) {
      expect(isScraptfBankUrl(bad), String(bad)).toBe(false);
    }
    expect(SCRAPTF_RESAVE_HELP).toBe("Flip Desk can't refresh scrap.tf for you; this reminds you to save the page again");
  });
});
