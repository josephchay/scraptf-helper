// F14 in Holdings, service side: a held item's other exit is scrap.tf's bank,
// read from the price list the user saved (the in-memory list cache). Status,
// profit, totals and "Sell:" notifications judge the better exit; backpack.tf
// wins a tie; a full or day-old list is never an exit; the notification names
// the venue and the list's age. Real in-memory repo, market index and list cache,
// fake clock and timers; nothing here touches scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { CSV_BOM } from '../../src/service/domain/csv';
import {
  HOLDINGS_CHECK_MS,
  createHoldings,
  holdingNotification,
  holdingsCsv,
  listAgeText,
  type Holdings,
  type HoldingsDeps,
} from '../../src/service/domain/holdings';
import { journalSummary } from '../../src/service/domain/journal';
import { DEFAULT_KEY_SCRAP, selectKeyPrice } from '../../src/service/domain/keyprice';
import { MARKET_DIRTY_BATCH_MS, MARKET_NOTIFY_MS, createMarketIndex, type MarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import { formatScrap } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { HOLDINGS_CSV_COLUMNS, holdingRow, holdingsTotals, type HoldingBuySide } from '../../src/shared/holdings';
import type { PushContract } from '../../src/shared/rpc';
import type { DeepPartial, HoldingRow, JournalEntry, KeyPriceState, Listing, Settings, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingLogger } from './helpers';

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
});

function newRepo(): Repo {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  return repo;
}

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

const NAMES: Record<string, string> = {
  '378;6': 'Team Captain',
  '126;6': "Bill's Hat",
  '205;6': 'Rocket Launcher',
  '15000;6': 'Sniper Rifle',
  '30920;6': 'Taunt: The Bunnyhopper',
  '378;6;p3100495': 'Team Captain (painted)',
  '5021;6': 'Mann Co. Supply Crate Key',
};

let journalTs = T0 - 20 * HOUR;
/** A journal row as journal.add writes it, each later than the last. */
function rec(repo: Repo, side: JournalEntry['side'], sku: string, scrap: number, over: Partial<Omit<JournalEntry, 'id'>> = {}): JournalEntry {
  journalTs += MIN;
  return repo.addJournal({
    ts: journalTs,
    side,
    venue: side === 'buy' ? 'scrap.tf' : 'backpack.tf',
    sku,
    name: NAMES[sku] ?? sku,
    keys: 0,
    scrap,
    keyPriceScrap: 567,
    note: null,
    ...over,
  });
}

/** One row of a saved scrap.tf/items page, stored as importSavedPage stores it. */
function saveList(
  repo: Repo,
  rows: readonly { sku: string; pays: number | null; paysKeys?: number; stock?: number | null; limit?: number | null }[],
  at: UnixMs,
): void {
  const batchId = repo.createImportBatch({ fileName: 'items.html', pageKind: 'items-list', fileMtime: at, importedAt: at, itemCount: rows.length, categories: null });
  repo.upsertScraptfList(
    rows.map((r) => ({
      sku: r.sku,
      name: NAMES[r.sku] ?? r.sku,
      sellsKeys: 0,
      sellsScrap: (r.pays ?? 0) + 9,
      paysKeys: r.pays === null ? null : (r.paysKeys ?? 0),
      paysScrap: r.pays,
      stock: r.stock === undefined ? 1 : r.stock,
      stockLimit: r.limit === undefined ? 10 : r.limit,
      batchId,
      observedAt: at,
    })),
  );
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  timers: FakeTimers;
  settings: { current: Settings };
  log: ReturnType<typeof recordingLogger>;
  list: ScraptfListCache;
  market: MarketIndex;
  holdings: Holdings;
  notes: PushContract['notify'][];
  K(): number;
  start(): void;
  /** A saved list as core handles it: the cache re-reads, then holdings re-check (core's onChanged). */
  listChanged(): void;
  book(upserts: Listing[], deletes?: string[]): void;
  row(sku: string): HoldingRow | undefined;
}

function setup(
  opts: {
    repo?: Repo;
    settings?: DeepPartial<Settings>;
    now?: UnixMs;
    /** Replaces the list holdings read (null: no list dependency, as in 0.3). */
    dep?: HoldingsDeps['scraptfList'] | null;
    /** Replaces the key price holdings read (the market and the list keep the real one). */
    holdingsKeyPrice?: () => KeyPriceState;
    /** Replaces the key price the list cache values rows at when no key price is passed. */
    listKeyPrice?: () => KeyPriceState;
  } = {},
): Harness {
  const repo = opts.repo ?? newRepo();
  const clock = new FakeClock(opts.now ?? T0);
  const timers = new FakeTimers(clock);
  // minConfidence 0 unless a test sets it: these books are small.
  const settings = { current: mergeSettings(mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } }), opts.settings ?? {}) };
  const log = recordingLogger();
  const schema = createStubSchema();
  let list!: ScraptfListCache;
  // As core wires it: the key price reads the list's key row.
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now(), list.keyRow());
  list = createScraptfListCache({ repo, log, keyPrice: opts.listKeyPrice ?? keyPrice });
  const deps = makeDeps(repo, clock, () => settings.current, log);
  const notes: PushContract['notify'][] = [];
  let holdings!: Holdings;
  const market = createMarketIndex({
    ...deps,
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    onBasesChanged: (b) => holdings.onBasesChanged(b),
    scraptfList: list,
  });
  const dep = opts.dep === undefined ? list : (opts.dep ?? undefined);
  holdings = createHoldings({
    ...deps,
    schema,
    market,
    timers,
    keyPrice: opts.holdingsKeyPrice ?? keyPrice,
    notify: (n) => notes.push(n),
    ...(dep ? { scraptfList: dep } : {}),
  });
  return {
    repo,
    clock,
    timers,
    settings,
    log,
    list,
    market,
    holdings,
    notes,
    K: () => keyPrice().valueScrap,
    start() {
      market.start();
      holdings.start();
      timers.advance(0);
      expect(market.stats().building).toBe(false);
      timers.advance(HOLDINGS_CHECK_MS);
    },
    listChanged() {
      list.refresh();
      holdings.settingsChanged();
      timers.advance(HOLDINGS_CHECK_MS);
    },
    book(upserts, deletes = []) {
      const gone = deletes.map((id) => repo.getListing(id)?.baseSku ?? '');
      if (upserts.length > 0) repo.upsertListings(upserts);
      if (deletes.length > 0) repo.deleteListings(deletes);
      market.markDirty([...upserts.map((l) => l.baseSku), ...gone].filter(Boolean));
      timers.advance(MARKET_DIRTY_BATCH_MS + MARKET_NOTIFY_MS + HOLDINGS_CHECK_MS);
    },
    row: (sku) => holdings.list({}, clock.now()).rows.find((r) => r.sku === sku),
  };
}

/** Team Captain 120 (Alice, bot), Bill's Hat 60 (Bob), Rocket Launcher 40 (Cid); no order for the Sniper Rifle. */
function seedBooks(repo: Repo): void {
  repo.upsertListings([
    buy('378;6', 120, { id: 'tc', steamid: '76561198000000001', userName: 'Alice', isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true }),
    buy('126;6', 60, { id: 'bh', steamid: '76561198000000002', userName: 'Bob' }),
    buy('205;6', 40, { id: 'rl', steamid: '76561198000000003', userName: 'Cid' }),
  ]);
}

/** The buy side the service reads from a market entry (holdings.ts buySideOf). */
function sideOf(market: MarketIndex, base: string): HoldingBuySide | null {
  const e = market.entryFor(base);
  if (!e) return null;
  return {
    revenueScrap: e.revenueScrap,
    bestScrap: e.bestScrap,
    instantScrap: e.instantScrap,
    revenueOrder: e.revenueOrder,
    bestOrder: e.bestOrder ?? null,
    buyerCount: e.buyerCount,
    confidence: e.confidence,
    confidenceLevel: e.confidenceLevel,
    flags: e.flags,
    lastOrderChangeAt: e.lastOrderChangeAt,
  };
}

const sellBody = (pays: number, profit: number, K: number | null, age: string) =>
  `scrap.tf's bank pays ${formatScrap(pays, K)} (price list saved ${age}), +${formatScrap(profit, K)} over your cost`;

// ---------------------------------------------------------------------------

describe('holdings rows with the saved scrap.tf list (F14)', () => {
  it('judges each held item on its better exit, exactly as the shared holdingRow reads the list cache', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 100); // backpack.tf pays 120, the list only 90: backpack.tf
    rec(repo, 'buy', '126;6', 55); // backpack.tf 60 (hold), the list pays 75: scrap.tf, sell
    rec(repo, 'buy', '205;6', 50); // backpack.tf 40, the list 40 too: a tie stays backpack.tf (loss)
    rec(repo, 'buy', '15000;6', 30); // no buyers and not on the list
    saveList(
      repo,
      [
        { sku: '378;6', pays: 90 },
        { sku: '126;6', pays: 75 },
        { sku: '205;6', pays: 40 },
      ],
      T0 - 12 * MIN,
    );
    const h = setup({ repo });
    h.start();
    const K = h.K();
    const res = h.holdings.list({}, T0);

    expect(h.row('126;6')).toMatchObject({
      revenueScrap: 60,
      scraptfPaysScrap: 75,
      scraptfFull: false,
      scraptfListAt: T0 - 12 * MIN,
      bestExit: 'scraptf',
      exitScrap: 75,
      exitVenue: 'scrap.tf',
      profitNowScrap: 20,
      status: 'sell',
    });
    expect(h.row('378;6')).toMatchObject({ bestExit: 'backpack', exitScrap: 120, exitVenue: 'backpack.tf', scraptfPaysScrap: 90, status: 'sell', profitNowScrap: 20 });
    expect(h.row('205;6')).toMatchObject({ bestExit: 'backpack', exitScrap: 40, scraptfPaysScrap: 40, status: 'loss' });
    expect(h.row('15000;6')).toMatchObject({ bestExit: null, exitScrap: null, exitVenue: null, scraptfPaysScrap: null, scraptfListAt: null, status: 'no-buyers' });

    // Parity: each row is the shared rule over the same position, buy side and list row (the mock uses it too).
    const open = journalSummary(repo.listJournal()).open;
    for (const r of res.rows) {
      const pos = open.find((p) => p.sku === r.sku)!;
      const expected = holdingRow(pos, r.category, sideOf(h.market, r.sku), h.settings.current.profit, K, { list: h.list.rowFor(r.sku, K), now: T0 });
      expect(r).toEqual(expected);
    }
    // Totals: worth at the better exit.
    expect(res.totals).toEqual(holdingsTotals(res.rows));
    expect(res.totals.worthNowScrap).toBe(120 + 75 + 40);
    expect(res.totals.sellable).toBe(2);

    // Both sellable items were told, each naming its venue (equal profit: by SKU).
    expect(h.notes).toEqual([
      { title: "Sell: Bill's Hat", body: sellBody(75, 20, K, '12 min ago'), sku: '126;6' },
      { title: 'Sell: Team Captain', body: `Alice pays ${formatScrap(120, K)} (bot), +${formatScrap(20, K)} over your cost`, sku: '378;6' },
    ]);
  });

  it('gives a held item without buyers an exit through scrap.tf, and tells it whatever minConfidence says', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '15000;6', 30);
    rec(repo, 'buy', '378;6', 100); // a backpack.tf sell, held back by minConfidence 100
    // Out of stock on scrap.tf, which still buys it.
    saveList(repo, [{ sku: '15000;6', pays: 45, stock: 0, limit: 5 }], T0 - 3 * MIN);
    const h = setup({ repo, settings: { notifications: { minConfidence: 100 } } });
    h.start();
    expect(h.row('15000;6')).toMatchObject({ buyerCount: 0, revenueScrap: null, confidence: 0, bestExit: 'scraptf', exitScrap: 45, profitNowScrap: 15, status: 'sell' });
    expect(h.row('378;6')).toMatchObject({ bestExit: 'backpack', status: 'sell' });
    expect(h.notes).toEqual([{ title: 'Sell: Sniper Rifle', body: sellBody(45, 15, h.K(), '3 min ago'), sku: '15000;6' }]);
  });

  it('checks held items on the list once at start (no market build reports them), deduped across restarts', () => {
    const repo = newRepo();
    rec(repo, 'buy', '15000;6', 30);
    rec(repo, 'buy', '205;6', 20); // not on the list, no buyers: nothing to check
    saveList(repo, [{ sku: '15000;6', pays: 45 }], T0 - 5 * MIN);
    const first = setup({ repo });
    first.start();
    expect(first.notes.map((n) => n.sku)).toEqual(['15000;6']);
    // A stop and start in the same process queues nothing new.
    first.holdings.stop();
    first.holdings.start();
    first.timers.advance(HOLDINGS_CHECK_MS);
    expect(first.notes).toHaveLength(1);
    first.holdings.stop();
    first.market.stop();

    // A restart inside the dedupe window: checked, but just told.
    const second = setup({ repo, now: T0 + 10 * MIN });
    second.start();
    expect(second.row('15000;6')).toMatchObject({ bestExit: 'scraptf', status: 'sell' });
    expect(second.notes).toEqual([]);
    second.holdings.stop();
    second.market.stop();

    // After the window it is a fresh reminder, like a backpack.tf sell after a restart.
    const third = setup({ repo, now: T0 + 40 * MIN });
    third.start();
    expect(third.notes.map((n) => n.body)).toEqual([sellBody(45, 15, third.K(), '45 min ago')]);
  });

  it('never sells into a full or day-old list, and keeps showing its price', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '126;6', 55);
    rec(repo, 'buy', '15000;6', 30);
    saveList(repo, [{ sku: '126;6', pays: 90, stock: 10, limit: 10 }], T0 - 5 * MIN);
    saveList(repo, [{ sku: '15000;6', pays: 60 }], T0 - 25 * HOUR);
    const h = setup({ repo });
    h.start();
    expect(h.row('126;6')).toMatchObject({ scraptfFull: true, scraptfPaysScrap: 90, bestExit: 'backpack', exitScrap: 60, status: 'hold' });
    expect(h.row('15000;6')).toMatchObject({ scraptfFull: false, scraptfPaysScrap: 60, scraptfListAt: T0 - 25 * HOUR, bestExit: null, status: 'no-buyers' });
    expect(h.notes).toEqual([]);
  });

  it('drops the scrap.tf exit once the saved list is more than a day old', () => {
    const repo = newRepo();
    rec(repo, 'buy', '15000;6', 30);
    saveList(repo, [{ sku: '15000;6', pays: 45 }], T0 - 23 * HOUR);
    const h = setup({ repo });
    h.start();
    expect(h.row('15000;6')).toMatchObject({ bestExit: 'scraptf', status: 'sell' });
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.body).toContain('(price list saved 23 h ago)');

    h.clock.advance(2 * HOUR);
    expect(h.row('15000;6')).toMatchObject({ bestExit: null, status: 'no-buyers', scraptfPaysScrap: 45 });
    // The next check sees it leave 'sell': a fresh save brings it back and tells it again.
    h.holdings.settingsChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    saveList(repo, [{ sku: '15000;6', pays: 45 }], h.clock.now());
    h.listChanged();
    expect(h.notes.map((n) => n.body)).toEqual([sellBody(45, 15, h.K(), '23 h ago'), sellBody(45, 15, h.K(), 'just now')]);
  });

  it('re-checks a scrap.tf sell by itself when its list turns a day old, so the next save tells it again', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '15000;6', 30); // only scrap.tf buys it: no market push ever re-checks it
    rec(repo, 'buy', '126;6', 55); // backpack.tf 60 (hold), scrap.tf 75 on a fresher save
    saveList(repo, [{ sku: '15000;6', pays: 45 }], T0 - 23 * HOUR);
    saveList(repo, [{ sku: '126;6', pays: 75 }], T0 - 2 * HOUR);
    const h = setup({ repo });
    h.start();
    expect(h.notes.map((n) => n.sku)).toEqual(['126;6', '15000;6']);

    // Only the timers run: the Sniper Rifle's list turns stale an hour later and is checked then.
    h.timers.advance(HOUR + HOLDINGS_CHECK_MS);
    expect(h.row('15000;6')).toMatchObject({ bestExit: null, status: 'no-buyers' });
    expect(h.row('126;6')).toMatchObject({ bestExit: 'scraptf', status: 'sell' });
    // The next morning's save brings it back: a new 'sell', told again (the dedupe window is long over).
    h.timers.advance(10 * HOUR);
    saveList(repo, [{ sku: '15000;6', pays: 45 }], h.clock.now());
    h.listChanged();
    expect(h.notes.map((n) => n.sku)).toEqual(['126;6', '15000;6', '15000;6']);
    expect(h.notes[2]!.body).toBe(sellBody(45, 15, h.K(), 'just now'));
    // Bill's Hat's list turns stale at T0 + 22 h: backpack.tf (60) only makes it a 'hold', nothing to tell.
    h.timers.advance(T0 + 22 * HOUR + HOLDINGS_CHECK_MS - h.clock.now());
    expect(h.row('126;6')).toMatchObject({ bestExit: 'backpack', status: 'hold' });
    expect(h.notes).toHaveLength(3);

    // A stopped service arms nothing.
    h.holdings.stop();
    h.market.stop();
    expect(h.timers.count).toBe(0);
  });

  it('re-checks on a new saved list, and tells a scrap.tf price that rose by a ref or more after the dedupe window', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '126;6', 55);
    const h = setup({ repo });
    h.start();
    expect(h.row('126;6')).toMatchObject({ bestExit: 'backpack', status: 'hold' });
    expect(h.notes).toEqual([]);

    saveList(repo, [{ sku: '126;6', pays: 75 }], h.clock.now());
    h.listChanged();
    expect(h.notes.map((n) => n.body)).toEqual([sellBody(75, 20, h.K(), 'just now')]);

    // Under a ref more: quiet. A ref more, but inside the 30-min window: quiet.
    h.clock.advance(MIN);
    saveList(repo, [{ sku: '126;6', pays: 80 }], h.clock.now());
    h.listChanged();
    saveList(repo, [{ sku: '126;6', pays: 90 }], h.clock.now());
    h.listChanged();
    expect(h.notes).toHaveLength(1);

    h.clock.advance(30 * MIN);
    saveList(repo, [{ sku: '126;6', pays: 91 }], h.clock.now() - 2 * MIN);
    h.listChanged();
    expect(h.notes.map((n) => n.body)).toEqual([sellBody(75, 20, h.K(), 'just now'), sellBody(91, 36, h.K(), '2 min ago')]);

    // A backpack.tf buyer outbidding the list takes the exit back; the venue in the row follows.
    h.book([buy('126;6', 100, { id: 'bh2', steamid: '76561198000000009', userName: 'Dana' })]);
    expect(h.row('126;6')).toMatchObject({ bestExit: 'backpack', exitScrap: 100, exitVenue: 'backpack.tf', revenueScrap: 100, scraptfPaysScrap: 91 });
  });

  it('values a key-priced scrap.tf price at the key price the lots use: keys in, keys out is no profit', () => {
    const repo = newRepo();
    rec(repo, 'buy', '30920;6', 0, { keys: 1, keyPriceScrap: 500 });
    saveList(repo, [{ sku: '30920;6', pays: 0, paysKeys: 1 }], T0 - MIN);
    const h = setup({ repo });
    h.start();
    const K = h.K();
    expect(h.row('30920;6')).toMatchObject({ bestExit: 'scraptf', exitScrap: K, scraptfPaysScrap: K, nextLotCostScrap: K, profitNowScrap: 0, status: 'loss' });
    expect(h.notes).toEqual([]);

    // The key price moves: both sides move with it, the profit stays 0.
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 600, sellScrap: 603, observedAt: T0 });
    const K2 = h.K();
    expect(K2).not.toBe(K);
    expect(h.row('30920;6')).toMatchObject({ exitScrap: K2, nextLotCostScrap: K2, profitNowScrap: 0 });
  });

  it('still prices rows when the key price cannot be read: lots at their buy-time cost, the list at the cache’s fallback', () => {
    const repo = newRepo();
    rec(repo, 'buy', '15000;6', 30);
    rec(repo, 'buy', '30920;6', 0, { keys: 1, keyPriceScrap: 500 });
    saveList(
      repo,
      [
        { sku: '15000;6', pays: 45 },
        { sku: '30920;6', pays: 0, paysKeys: 1 },
      ],
      T0 - MIN,
    );
    const broken = (): KeyPriceState => {
      throw new Error('key price unavailable');
    };
    const h = setup({ repo, holdingsKeyPrice: broken, listKeyPrice: broken });
    h.start();
    const res = h.holdings.list({}, T0);
    expect(res.keyPrice).toBeNull();
    // Metal prices do not need a key price.
    expect(res.rows.find((r) => r.sku === '15000;6')).toMatchObject({ bestExit: 'scraptf', exitScrap: 45, profitNowScrap: 15, status: 'sell' });
    // A key price in keys falls back to the default key value; the lot keeps its buy-time cost.
    expect(res.rows.find((r) => r.sku === '30920;6')).toMatchObject({ bestExit: 'scraptf', exitScrap: DEFAULT_KEY_SCRAP, nextLotCostScrap: 500 });
    // The notifications are written without a key price (metal only); the lot bought for a key is
    // judged on its buy-time cost (500) against the default key value.
    expect(h.notes.map((n) => [n.sku, n.body])).toEqual([
      ['30920;6', sellBody(DEFAULT_KEY_SCRAP, DEFAULT_KEY_SCRAP - 500, null, '1 min ago')],
      ['15000;6', sellBody(45, 15, null, '1 min ago')],
    ]);
  });

  it("prices a painted copy against its clean base's list row, and never gives a currency a list exit", () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6;p3100495', 100);
    rec(repo, 'buy', '5021;6', 0, { keys: 1 });
    saveList(
      repo,
      [
        { sku: '378;6', pays: 130 },
        { sku: '5021;6', pays: 560 },
      ],
      T0 - MIN,
    );
    const h = setup({ repo });
    h.start();
    const painted = h.row('378;6;p3100495')!;
    expect(painted).toMatchObject({ bestExit: 'scraptf', exitScrap: 130, revenueScrap: 120, status: 'sell' });
    expect(painted.flags).toContain('has-extras');
    expect(h.row('5021;6')).toMatchObject({ bestExit: null, exitScrap: null, scraptfPaysScrap: null, status: 'no-buyers' });
    // The list's key row is scrap.tf's key price: it caps the key value instead (keyprice.ts).
    expect(h.K()).toBe(560);
  });

  it('keeps backpack.tf as the only exit through a failing list, warning once', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 100);
    rec(repo, 'buy', '126;6', 55);
    const h = setup({
      repo,
      dep: {
        rowFor: () => {
          throw new Error('list read failed');
        },
      },
    });
    h.start();
    h.holdings.list({}, T0);
    expect(h.row('378;6')).toMatchObject({ bestExit: 'backpack', exitScrap: 120, scraptfPaysScrap: null, status: 'sell' });
    expect(h.row('126;6')).toMatchObject({ bestExit: 'backpack', status: 'hold' });
    expect(h.log.lines.filter((l) => l.level === 'warn' && /saved scrap\.tf list/.test(l.msg))).toHaveLength(1);
  });

  it('works without a list dependency, as in 0.3', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '126;6', 55);
    saveList(repo, [{ sku: '126;6', pays: 75 }], T0 - MIN);
    const h = setup({ repo, dep: null });
    h.start();
    expect(h.row('126;6')).toMatchObject({ bestExit: 'backpack', exitScrap: 60, scraptfPaysScrap: null, status: 'hold' });
    expect(h.notes).toEqual([]);
  });

  it('writes the exit and its venue to the CSV', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '126;6', 55);
    rec(repo, 'buy', '378;6', 100);
    saveList(repo, [{ sku: '126;6', pays: 75 }], T0 - MIN);
    const h = setup({ repo });
    h.start();
    const K = h.K();
    const lines = holdingsCsv(h.holdings.all({}, T0), K).replace(CSV_BOM, '').trim().split('\r\n');
    expect(lines[0]).toBe(HOLDINGS_CSV_COLUMNS.join(','));
    const col = (line: string, name: string) => line.split(',')[HOLDINGS_CSV_COLUMNS.indexOf(name)];
    const bill = lines.find((l) => l.startsWith('126;6,'))!;
    expect([col(bill, 'sells_for'), col(bill, 'exit'), col(bill, 'exit_venue'), col(bill, 'scraptf_pays')]).toEqual([
      formatScrap(60, K),
      formatScrap(75, K),
      'scrap.tf',
      formatScrap(75, K),
    ]);
    const tc = lines.find((l) => l.startsWith('378;6,'))!;
    expect([col(tc, 'exit'), col(tc, 'exit_venue'), col(tc, 'scraptf_pays')]).toEqual([formatScrap(120, K), 'backpack.tf', '']);
  });
});

describe('holdingNotification (F14 wording)', () => {
  const base = (over: Partial<HoldingRow>): HoldingRow =>
    ({
      sku: '126;6',
      name: "Bill's Hat",
      revenueScrap: 60,
      revenueOrder: { userName: 'Bob', steamid: '76561198000000002', isBot: false },
      profitNowScrap: 20,
      bestExit: 'backpack',
      exitScrap: 60,
      exitVenue: 'backpack.tf',
      scraptfPaysScrap: null,
      scraptfListAt: null,
      ...over,
    }) as HoldingRow;

  it('keeps the 0.3 body for a backpack.tf exit', () => {
    expect(holdingNotification(base({}), 568, T0)).toEqual({ title: "Sell: Bill's Hat", body: 'Bob pays 6.66 ref (human), +2.22 ref over your cost', sku: '126;6' });
    expect(holdingNotification(base({ revenueOrder: null }), null).body).toBe('A buyer pays 6.66 ref (human), +2.22 ref over your cost');
  });

  it("names scrap.tf's bank and the list's age for a scrap.tf exit", () => {
    const r = base({ bestExit: 'scraptf', exitScrap: 75, exitVenue: 'scrap.tf', scraptfPaysScrap: 75, scraptfListAt: T0 - 12 * MIN, profitNowScrap: 20 });
    expect(holdingNotification(r, 568, T0)).toEqual({
      title: "Sell: Bill's Hat",
      body: "scrap.tf's bank pays 8.33 ref (price list saved 12 min ago), +2.22 ref over your cost",
      sku: '126;6',
    });
    // Without a time to measure from, it says where the price comes from instead.
    expect(holdingNotification(r, 568).body).toBe("scrap.tf's bank pays 8.33 ref (from your saved price list), +2.22 ref over your cost");
    // Never the buyer's name for a scrap.tf exit.
    expect(holdingNotification(r, 568, T0).body).not.toContain('Bob');
  });

  it('says how old the list is in plain words', () => {
    expect(listAgeText(T0, T0)).toBe('just now');
    expect(listAgeText(T0 - 59_000, T0)).toBe('just now');
    expect(listAgeText(T0 + 5 * MIN, T0)).toBe('just now'); // a clock moved back
    expect(listAgeText(T0 - MIN, T0)).toBe('1 min ago');
    expect(listAgeText(T0 - 59 * MIN - 59_000, T0)).toBe('59 min ago');
    expect(listAgeText(T0 - HOUR, T0)).toBe('1 h ago');
    expect(listAgeText(T0 - 24 * HOUR + 1, T0)).toBe('23 h ago');
    expect(listAgeText(T0 - 50 * HOUR, T0)).toBe('2 d ago');
    expect(listAgeText(null, T0)).toBe('just now');
  });
});
