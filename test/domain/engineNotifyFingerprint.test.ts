// 0.7.1 engine toasts (Package C): a toast means something changed and is worth acting on now.
// ACT-2: a stale input never toasts, and past notifications.dedupMs a row toasts again only when its
// fingerprint moved (a new observedAt, another revenue order, or CHANGE_PROFIT_DELTA more profit); the
// record is kept in NOTIFY_META_KEY, where pre-0.7.1 `{ key: ts }` entries still parse. ACT-3: no toast
// for an item the user recorded buying on scrap.tf after its price was seen (EngineDeps.boughtSince).
// ACT-8: no "Candidate:" toast for a base a fresh save of its single-page bank shows is not there
// (EngineDeps.recentBankSaveAt); never for an australium (DC-5: scrap.tf sells them on its items bank too, so the
// category's bank is no proof). Rows and verdicts never change. In-memory repo, fake clock; no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { newestScraptfBuys } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import {
  CHANGE_PROFIT_DELTA,
  NOTIFY_META_KEY,
  createEngine,
  notifyWorthRepeating,
  parseNotifyRecords,
  type EngineDeps,
  type NotifyRecord,
} from '../../src/service/domain/engine';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, JournalEntry, ScraptfBank, Settings } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, recordingLogger } from './helpers';

const K = 567;
const DAY = 24 * HOUR;
const DEDUP = DEFAULT_SETTINGS.notifications.dedupMs;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

type Hooks = Pick<EngineDeps, 'toldElsewhere' | 'boughtSince' | 'recentBankSaveAt'>;

function setup(hooks: Hooks = {}, patch: DeepPartial<Settings> = {}) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  const clock = new FakeClock();
  const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 }, ...patch });
  const events = recordingEvents();
  const log = recordingLogger();
  const engine = createEngine({ ...makeDeps(repo, clock, () => settings, log), schema: createStubSchema(), events, timers: new FakeTimers(clock), ...hooks });
  const books = new Map<string, number>();
  /** Three fresh buyers of `sku` at about `scrap` (a bot first), kept fresh on every sweep. */
  const book = (sku: string, scrap: number): void => {
    books.set(sku, scrap);
    repo.upsertListings(
      [0, 1, 2].map((i) =>
        makeListing({ id: `${sku}-${i}`, sku, baseSku: sku, steamid: `S${sku}-${i}`, metalScrap: scrap - i, isBot: i === 0, uaLastPulse: Math.floor(clock.t / 1000), userOnline: true, lastEventAt: clock.t - MIN }),
      ),
    );
  };
  /** Every buyer of `sku` cancels. */
  const drop = (sku: string): void => {
    books.delete(sku);
    deleteBook(repo, sku);
  };
  /** One periodic sweep `ms` later, with every book still fresh (only time moved). */
  const sweep = async (ms: number): Promise<void> => {
    clock.advance(ms);
    for (const [sku, scrap] of books) book(sku, scrap);
    await engine.runNow();
  };
  const titles = (): string[] => events.notified.map((n) => n.title);
  const meta = (): Record<string, NotifyRecord> => JSON.parse(repo.getMeta(NOTIFY_META_KEY) ?? '{}') as Record<string, NotifyRecord>;
  return { repo, clock, engine, events, log, settings, book, drop, sweep, titles, meta };
}

function deleteBook(repo: Repo, sku: string): void {
  repo.deleteListings([0, 1, 2].map((i) => `${sku}-${i}`));
}

type H = ReturnType<typeof setup>;

function price(h: H, sku: string, costScrap: number, source: 'user' | 'import', observedAt: number, id?: number): number {
  return h.repo.upsertScrapPrice({ ...(id !== undefined ? { id } : {}), sku, name: '', costScrap, source, observedAt }).id;
}

describe('ACT-2: toasts repeat only on a material change', () => {
  it('never toasts an unchanged 3-day-old import over 4 sweeps 31 min apart; the row stays in the lists', async () => {
    const h = setup();
    h.book('378;6', 108);
    price(h, '378;6', 60, 'import', T0 - 3 * DAY);
    await h.engine.runNow();
    for (let i = 0; i < 3; i++) await h.sweep(31 * MIN);
    expect(h.titles()).toEqual([]);
    const [row] = h.repo.allOpportunities();
    expect(row).toMatchObject({ status: 'profitable', inputKind: 'import' });
    expect(row!.flags).toContain('stale-input');
    expect(h.repo.listEvents({ kinds: ['appeared'] })).toHaveLength(1);
  });

  it('toasts a fresh unchanged import once in 2 h', async () => {
    const h = setup();
    h.book('378;6', 108);
    price(h, '378;6', 60, 'import', T0 - MIN);
    await h.engine.runNow();
    for (let i = 0; i < 4; i++) await h.sweep(31 * MIN);
    expect(h.titles()).toEqual(['Profit: Team Captain']);
    expect(h.repo.listEvents({ kinds: ['notified'] })).toHaveLength(1);
  });

  it('toasts again for a new observedAt past the window, never inside it', async () => {
    const h = setup();
    h.book('378;6', 108);
    const id = price(h, '378;6', 60, 'import', T0 - MIN);
    await h.engine.runNow();
    // Saved again 10 min later: a new sighting, but inside the window.
    await h.sweep(10 * MIN);
    price(h, '378;6', 60, 'import', h.clock.t, id);
    await h.engine.runNow();
    expect(h.titles()).toHaveLength(1);
    // Past the window, that sighting is news.
    await h.sweep(DEDUP);
    expect(h.titles()).toEqual(['Profit: Team Captain', 'Profit: Team Captain']);
    // Unchanged after that: nothing more.
    await h.sweep(DEDUP + MIN);
    expect(h.titles()).toHaveLength(2);
  });

  it('toasts again for another buy order or 1 ref more profit, not for less profit', async () => {
    const h = setup();
    h.book('378;6', 108);
    price(h, '378;6', 60, 'user', T0 - 10 * MIN);
    await h.engine.runNow();
    const p0 = h.repo.allOpportunities()[0]!.profitScrap!;
    // Less profit, past the window: no toast.
    h.book('378;6', 100);
    await h.sweep(DEDUP);
    expect(h.titles()).toHaveLength(1);
    // Back up, but by less than CHANGE_PROFIT_DELTA over the toasted profit: still none.
    h.book('378;6', 108 + CHANGE_PROFIT_DELTA - 1);
    await h.sweep(MIN);
    expect(h.repo.allOpportunities()[0]!.profitScrap! - p0).toBeLessThan(CHANGE_PROFIT_DELTA);
    expect(h.titles()).toHaveLength(1);
    // CHANGE_PROFIT_DELTA over it: a toast.
    h.book('378;6', 108 + CHANGE_PROFIT_DELTA);
    await h.sweep(MIN);
    expect(h.repo.allOpportunities()[0]!.profitScrap! - p0).toBeGreaterThanOrEqual(CHANGE_PROFIT_DELTA);
    expect(h.titles()).toHaveLength(2);
    // Past the window, other buyers pay the same: the profit is unchanged, but the order is new.
    h.drop('378;6');
    h.clock.advance(DEDUP);
    h.repo.upsertListings(
      [0, 1, 2].map((i) =>
        makeListing({ id: `new-${i}`, steamid: `N${i}`, metalScrap: 108 + CHANGE_PROFIT_DELTA - i, isBot: i === 0, uaLastPulse: Math.floor(h.clock.t / 1000), userOnline: true, lastEventAt: h.clock.t - MIN }),
      ),
    );
    await h.engine.runNow();
    expect(h.repo.allOpportunities()[0]!.profitScrap! - p0).toBe(CHANGE_PROFIT_DELTA);
    expect(h.titles()).toHaveLength(3);
  });

  it('gives 6 unchanged rule candidates 4 toasts in the first run, then none', async () => {
    const h = setup();
    for (let i = 0; i < 6; i++) h.book(`${2000 + i};6`, 100 + i);
    h.repo.upsertRule({ name: 'Hats', filter: { defindexes: [2000, 2001, 2002, 2003, 2004, 2005] }, costScrap: 60, observedAt: T0 - HOUR });
    await h.engine.runNow();
    expect(h.titles().map((t) => t.split(':')[0])).toEqual(['Candidate', 'Candidate', 'Candidate', '3 more candidates to check on scrap.tf']);
    for (let i = 0; i < 4; i++) await h.sweep(31 * MIN);
    expect(h.events.notified).toHaveLength(4);
    // An edited rule is a new estimate (its update time is the fingerprint's obs): told again.
    const rule = h.repo.listRules()[0]!;
    h.repo.upsertRule({ ...rule, observedAt: h.clock.t });
    await h.sweep(MIN);
    expect(h.events.notified).toHaveLength(8);
  });

  it('reads a pre-0.7.1 { key: ts } history: held inside the window, told once past it, then fingerprinted', async () => {
    const h = setup();
    h.book('378;6', 108);
    const id = price(h, '378;6', 60, 'user', T0 - 10 * MIN);
    const key = `378;6|price:${id}`;
    h.repo.setMeta(NOTIFY_META_KEY, JSON.stringify({ [key]: T0 - 10 * MIN }));
    await h.engine.runNow();
    expect(h.titles()).toEqual([]);
    await h.sweep(21 * MIN);
    expect(h.titles()).toEqual(['Profit: Team Captain']);
    expect(h.meta()[key]).toEqual({ t: h.clock.t, f: { obs: T0 - 10 * MIN, lid: expect.any(String) as unknown as string, p: expect.any(Number) as unknown as number } });
    await h.sweep(DEDUP + MIN);
    expect(h.titles()).toHaveLength(1);
  });

  it('keeps a record past the window only while its row is stored', async () => {
    const h = setup();
    h.book('378;6', 108);
    h.book('126;6', 90);
    const tc = price(h, '378;6', 60, 'user', T0 - 10 * MIN);
    await h.engine.runNow();
    expect(Object.keys(h.meta())).toEqual([`378;6|price:${tc}`]);
    // The price is deleted; past the window another toast rewrites the history without it.
    h.repo.deleteScrapPrice(tc);
    await h.sweep(DEDUP);
    price(h, '126;6', 40, 'user', h.clock.t - 10 * MIN);
    await h.engine.runNow();
    expect(h.titles()).toEqual(['Profit: Team Captain', "Profit: Bill's Hat"]);
    expect(Object.keys(h.meta()).map((k) => k.split('|')[0])).toEqual(['126;6']);
  });

  it('keeps F17 one toast per find beyond 30 min: a find told elsewhere is fingerprinted too', async () => {
    let told = true;
    const asked: unknown[] = [];
    const h = setup({
      toldElsewhere: (opp, at) => {
        asked.push({ sku: opp.sku, inputKind: opp.inputKind, inputObservedAt: opp.inputObservedAt, at });
        return told;
      },
    });
    h.book('378;6', 108);
    const id = price(h, '378;6', 60, 'import', T0 - MIN);
    await h.engine.runNow();
    expect(h.titles()).toEqual([]);
    // The hook hears the input's observedAt (ACT-7's rule in core reads it).
    expect(asked).toEqual([{ sku: '378;6', inputKind: 'import', inputObservedAt: T0 - MIN, at: T0 }]);
    told = false;
    await h.sweep(DEDUP + MIN);
    expect(h.titles()).toEqual([]);
    // A new save of the page, past the window, is a new find.
    price(h, '378;6', 60, 'import', h.clock.t, id);
    await h.engine.runNow();
    expect(h.titles()).toEqual(['Profit: Team Captain']);
  });

  it('parses records defensively', () => {
    expect([...parseNotifyRecords(null)]).toEqual([]);
    const r = parseNotifyRecords(
      JSON.stringify({
        legacy: 5,
        now: { t: 6, f: { obs: 1, lid: 'l', p: 9 } },
        noPrint: { t: 7, f: null },
        bad: { t: 'x' },
        worse: 'text',
        badPrint: { t: 8, f: { obs: 1 } },
      }),
    );
    expect(Object.fromEntries(r)).toEqual({ legacy: { t: 5, f: null }, now: { t: 6, f: { obs: 1, lid: 'l', p: 9 } }, noPrint: { t: 7, f: null } });
    expect([...parseNotifyRecords('[1,2]')]).toEqual([]);
    expect(() => parseNotifyRecords('{not json')).toThrow();
  });

  it('repeats only for news', () => {
    const f = { obs: 1, lid: 'a', p: 20 };
    expect(notifyWorthRepeating(null, f)).toBe(true);
    expect(notifyWorthRepeating(f, { ...f })).toBe(false);
    expect(notifyWorthRepeating(f, { ...f, obs: 2 })).toBe(true);
    expect(notifyWorthRepeating(f, { ...f, lid: 'b' })).toBe(true);
    expect(notifyWorthRepeating(f, { ...f, lid: null })).toBe(true);
    expect(notifyWorthRepeating(f, { ...f, p: 20 + CHANGE_PROFIT_DELTA - 1 })).toBe(false);
    expect(notifyWorthRepeating(f, { ...f, p: 20 + CHANGE_PROFIT_DELTA })).toBe(true);
    expect(notifyWorthRepeating(f, { ...f, p: 5 })).toBe(false);
    expect(notifyWorthRepeating({ ...f, p: null }, f)).toBe(true);
  });
});

describe('ACT-3: no toast for an item just bought on scrap.tf', () => {
  it('holds back a toast when a scrap.tf buy of the base came at or after the input, without recording it', async () => {
    const buys = new Map<string, number>([
      ['378;6', T0 - MIN],
      ['126;6', T0 - 20 * MIN],
    ]);
    const asked: [string, number][] = [];
    const h = setup({
      boughtSince: (base, at) => {
        asked.push([base, at]);
        const ts = buys.get(base);
        return ts !== undefined && ts >= at;
      },
    });
    h.book('378;6', 108);
    h.book('126;6', 90);
    // Bought at the moment the page was saved (at or after counts), and a buy from before the price.
    const tc = price(h, '378;6', 60, 'import', T0 - MIN);
    price(h, '126;6', 40, 'user', T0 - 10 * MIN);
    await h.engine.runNow();
    expect(h.titles()).toEqual(["Profit: Bill's Hat"]);
    expect(asked.sort()).toEqual([
      ['126;6', T0 - 10 * MIN],
      ['378;6', T0 - MIN],
    ]);
    // Nothing recorded for the bought one, and the row is unchanged.
    expect(Object.keys(h.meta()).some((k) => k.startsWith('378;6'))).toBe(false);
    expect(h.repo.getOpportunity(`378;6|price:${tc}`)).toMatchObject({ status: 'profitable' });
    // A newer save still lists it (another copy): that one is news, toasted at once.
    price(h, '378;6', 60, 'import', T0 + MIN, tc);
    await h.sweep(2 * MIN);
    expect(h.titles()).toEqual(["Profit: Bill's Hat", 'Profit: Team Captain']);
  });

  it('a painted copy counts under its base, and a failing check toasts as before', async () => {
    const asked: string[] = [];
    const h = setup({
      boughtSince: (base) => {
        asked.push(base);
        throw new Error('journal gone');
      },
    });
    h.book('378;6', 108);
    h.repo.upsertScrapPrice({ sku: '378;6;p8208497', name: '', costScrap: 60, source: 'user', observedAt: T0 - 10 * MIN, special: { paint: 8208497, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false } });
    await h.engine.runNow();
    expect(asked).toEqual(['378;6']);
    expect(h.titles()).toHaveLength(1);
    expect(h.log.lines.some((l) => l.level === 'warn' && /notification check failed/.test(l.msg))).toBe(true);
  });

  it('a rule candidate is held back only by a buy within inputStaleMs: a rule is no sighting of the item', async () => {
    const buys = new Map<string, number>([
      ['378;6', T0 - 10 * MIN], // just bought
      ['205;6', T0 - 3 * DAY], // bought days ago, long after the rule was written
    ]);
    const h = setup({ boughtSince: (base, at) => (buys.get(base) ?? Number.NEGATIVE_INFINITY) >= at });
    h.book('378;6', 108);
    h.book('205;6', 108);
    h.repo.upsertRule({ name: 'Look for', filter: { defindexes: [378, 205], hasEffect: false }, costScrap: 60, observedAt: T0 - 30 * DAY });
    await h.engine.runNow();
    expect(h.titles()).toEqual(['Candidate: Rocket Launcher']);
    // Once that buy is older than inputStaleMs (2 h), the other candidate is told too.
    await h.sweep(2 * HOUR);
    expect(h.titles()).toEqual(['Candidate: Rocket Launcher', 'Candidate: Team Captain']);
  });

  it("core's map: the newest scrap.tf buy per base, any case of the venue; sells and other venues do not count", () => {
    const e = (over: Partial<JournalEntry>): JournalEntry => ({ id: 1, ts: T0, side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'x', keys: 0, scrap: 9, keyPriceScrap: K, note: null, ...over });
    const m = newestScraptfBuys([
      e({ ts: T0 - 2 * HOUR }),
      e({ ts: T0 - HOUR, venue: ' Scrap.TF ' }),
      e({ ts: T0, side: 'sell' }),
      e({ ts: T0, venue: 'backpack.tf' }),
      e({ ts: T0 - 3 * HOUR, sku: '126;6;p3100495' }),
      e({ ts: Number.NaN, sku: '205;6' }),
    ]);
    expect(Object.fromEntries(m)).toEqual({ '378;6': T0 - HOUR, '126;6': T0 - 3 * HOUR });
  });
});

describe('ACT-8: no "Candidate:" toast for an item a fresh save shows is not on its page', () => {
  const RULES = { name: 'Look for', filter: { defindexes: [378, 205], hasEffect: false }, costScrap: 60, observedAt: T0 - HOUR };

  it('holds back candidates on a single-page bank saved within inputStaleMs, never rows or typed prices', async () => {
    const saves = new Map<ScraptfBank, number>([
      ['hats', T0 - 10 * MIN],
      ['weapons', T0 - 3 * HOUR],
      ['unusuals', T0 - MIN],
    ]);
    const asked: ScraptfBank[] = [];
    const h = setup({
      recentBankSaveAt: (bank) => {
        asked.push(bank);
        return saves.get(bank) ?? null;
      },
    });
    h.book('378;6', 108); // hats: saved 10 min ago
    h.book('205;6', 108); // weapons: saved 3 h ago
    h.book('378;5;u13', 108); // unusuals: many pages, so one save says nothing
    h.book('126;6', 90); // a typed price on the fresh hats bank
    h.repo.upsertRule(RULES);
    h.repo.upsertRule({ name: 'Unusual', filter: { defindexes: [378], hasEffect: true }, costScrap: 60, observedAt: T0 - HOUR });
    price(h, '126;6', 40, 'user', T0 - 10 * MIN);
    await h.engine.runNow();
    expect(h.titles().sort()).toEqual(["Profit: Bill's Hat", 'Candidate: Burning Flames Team Captain', 'Candidate: Rocket Launcher'].sort());
    expect(asked.sort()).toEqual(['hats', 'weapons']);
    // The held-back candidate is still a profitable row.
    expect(h.repo.opportunitiesForSku('378;6').map((o) => [o.inputKind, o.status])).toEqual([['rule', 'profitable']]);
    expect(Object.keys(h.meta()).some((k) => k.startsWith('378;6|'))).toBe(false);
    // Once that save is older than inputStaleMs (2 h), the candidate is told.
    await h.sweep(2 * HOUR - 10 * MIN + MIN);
    expect(h.titles()).toContain('Candidate: Team Captain');
  });

  it('still toasts an australium after a fresh /buy/stranges save, which is not the one page that sells it (DC-5)', async () => {
    const asked: ScraptfBank[] = [];
    const h = setup({
      recentBankSaveAt: (bank) => {
        asked.push(bank);
        return bank === 'stranges' ? T0 - 10 * MIN : null;
      },
    });
    h.book('205;11;australium', 108);
    h.book('205;11', 108);
    h.repo.upsertRule({ name: 'Australiums', filter: { defindexes: [205], australium: true }, costScrap: 60, observedAt: T0 - HOUR });
    h.repo.upsertRule({ name: 'Stranges', filter: { defindexes: [205], qualities: [11], australium: false }, costScrap: 60, observedAt: T0 - HOUR });
    await h.engine.runNow();
    // Both are 'stranges' by category; only the plain strange is known absent from that fresh save.
    expect(h.titles()).toEqual(['Candidate: Strange Australium Rocket Launcher']);
    expect(asked).toEqual(['stranges']);
    expect(h.repo.opportunitiesForSku('205;11').map((o) => [o.inputKind, o.status, o.category])).toEqual([['rule', 'profitable', 'stranges']]);
    expect(h.repo.opportunitiesForSku('205;11;australium').map((o) => [o.inputKind, o.status, o.category])).toEqual([['rule', 'profitable', 'stranges']]);
  });

  it('reads profit.inputStaleMs, and a failing or empty answer toasts as before', async () => {
    const short = setup({ recentBankSaveAt: () => T0 - 40 * MIN }, { profit: { inputStaleMs: 30 * MIN } });
    short.book('378;6', 108);
    short.repo.upsertRule(RULES);
    await short.engine.runNow();
    expect(short.titles()).toEqual(['Candidate: Team Captain']);

    const none = setup({ recentBankSaveAt: () => null });
    none.book('378;6', 108);
    none.repo.upsertRule(RULES);
    await none.engine.runNow();
    expect(none.titles()).toEqual(['Candidate: Team Captain']);

    const broken = setup({
      recentBankSaveAt: () => {
        throw new Error('db gone');
      },
    });
    broken.book('378;6', 108);
    broken.repo.upsertRule(RULES);
    await broken.engine.runNow();
    expect(broken.titles()).toEqual(['Candidate: Team Captain']);
  });
});
