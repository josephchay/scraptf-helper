// 0.9 (#1, #17), service side: the trade lock the user set and the key move band in the holdings module. With '7d' a
// unit bought less than 7 days ago keeps its row Locked, out of Sellable now and out of the "Sell:" notifications until
// it unlocks, when the expiry timer re-checks it; with 'none' (or the default 'unknown') nothing changes. The
// key-exposure reason quotes the band from deps.keyHistory (PriceDB history already in memory), and a failing read
// never takes the rows down. Real in-memory repo and market index, fake clock and timers (holdings.test.ts's harness);
// nothing here touches the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { HOLDINGS_CHECK_MS, createHoldings, type Holdings } from '../../src/service/domain/holdings';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { MARKET_DIRTY_BATCH_MS, MARKET_NOTIFY_MS, createMarketIndex, type MarketIndex } from '../../src/service/domain/market';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { KEY_BAND_MIN_SPANS, TRADE_LOCK_MS, keyMoveBandOf } from '../../src/shared/holdingAdvice';
import type { PushContract } from '../../src/shared/rpc';
import type { DeepPartial, HistoryPoint, HoldingAdviceReason, HoldingRow, JournalEntry, Listing, LoadedKeyHistory, Settings } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingLogger } from './helpers';

const DAY = 24 * HOUR;

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
  vi.restoreAllMocks();
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

/** Alice's bot pays 120 for a Team Captain. */
const ALICE = { id: 'tc', steamid: '76561198000000001', userName: 'Alice', isBot: true } as const;

let journalTs = T0 - 20 * HOUR;
function rec(repo: Repo, side: JournalEntry['side'], sku: string, scrap: number, over: Partial<Omit<JournalEntry, 'id'>> = {}): JournalEntry {
  journalTs += MIN;
  return repo.addJournal({ ts: journalTs, side, venue: side === 'buy' ? 'scrap.tf' : 'backpack.tf', sku, name: sku === '378;6' ? 'Team Captain' : sku, keys: 0, scrap, keyPriceScrap: 567, note: null, ...over });
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  timers: FakeTimers;
  settings: { current: Settings };
  log: ReturnType<typeof recordingLogger>;
  market: MarketIndex;
  holdings: Holdings;
  notes: PushContract['notify'][];
  start(): void;
  book(upserts: Listing[]): void;
  list(): ReturnType<Holdings['list']>;
  row(sku: string): HoldingRow | undefined;
}

function setup(opts: { repo: Repo; settings?: DeepPartial<Settings>; keyHistory?: () => LoadedKeyHistory | null }): Harness {
  const { repo } = opts;
  const clock = new FakeClock(T0);
  const timers = new FakeTimers(clock);
  const settings = { current: mergeSettings(mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } }), opts.settings ?? {}) };
  const log = recordingLogger();
  const schema = createStubSchema();
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now());
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
    sliceNow: () => 0,
  });
  holdings = createHoldings({
    ...deps,
    schema,
    market,
    timers,
    keyPrice,
    notify: (n) => notes.push(n),
    ...(opts.keyHistory ? { keyHistory: opts.keyHistory } : {}),
  });
  const settle = () => timers.advance(MARKET_DIRTY_BATCH_MS + MARKET_NOTIFY_MS + HOLDINGS_CHECK_MS);
  return {
    repo,
    clock,
    timers,
    settings,
    log,
    market,
    holdings,
    notes,
    start() {
      market.start();
      holdings.start();
      timers.advance(0);
      timers.advance(HOLDINGS_CHECK_MS);
    },
    book(upserts) {
      repo.upsertListings(upserts);
      market.markDirty(upserts.map((l) => l.baseSku));
      settle();
    },
    list: () => holdings.list({}, clock.now()),
    row: (sku) => holdings.list({}, clock.now()).rows.find((r) => r.sku === sku),
  };
}

const LOCK_7D = { tradeLock: { mode: '7d', answeredAt: T0 - DAY } } as const;

describe('holdings with a 7-day trade lock (0.9, #1)', () => {
  it('holds back "Sell:" while the unit is locked, and tells it once the expiry timer re-checks it unlocked', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, ALICE)]);
    const bought = rec(repo, 'buy', '378;6', 100, { ts: T0 - 2 * DAY });
    const h = setup({ repo, settings: LOCK_7D });
    h.start();
    expect(h.row('378;6')).toMatchObject({ status: 'sell', profitNowScrap: 20 });
    expect(h.notes).toEqual([]);

    // The feed keeps confirming Alice's order (a buyer unseen for a day is held back on its own, 0.7.4).
    h.timers.advance(T0 + 5 * DAY - HOUR - h.clock.now());
    expect(h.notes).toEqual([]);
    h.book([buy('378;6', 120, { ...ALICE, lastEventAt: h.clock.now() })]);
    expect(h.row('378;6')?.tradeLock?.nextLotTradableAt).toBe(bought.ts + TRADE_LOCK_MS);
    expect(h.notes).toEqual([]);

    // No book change: the unlock alone re-checks it, 1 ms after bought + 7 d.
    h.timers.advance(HOUR + HOLDINGS_CHECK_MS + 1000);
    expect(h.clock.now()).toBeGreaterThan(bought.ts + TRADE_LOCK_MS);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toMatchObject({ title: 'Sell: Team Captain', sku: '378;6' });
    expect(h.row('378;6')).not.toHaveProperty('tradeLock');
  });

  it("with 'none' tells it at start, as 0.8 did", () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, ALICE)]);
    rec(repo, 'buy', '378;6', 100, { ts: T0 - 2 * DAY });
    const h = setup({ repo, settings: { tradeLock: { mode: 'none', answeredAt: T0 - DAY } } });
    h.start();
    expect(h.notes.map((n) => n.title)).toEqual(['Sell: Team Captain']);
    expect(h.row('378;6')).not.toHaveProperty('tradeLock');
  });

  it("with the default ('unknown', not answered) nothing is locked", () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, ALICE)]);
    rec(repo, 'buy', '378;6', 100, { ts: T0 - 2 * DAY });
    const h = setup({ repo });
    h.start();
    expect(h.notes).toHaveLength(1);
    const r = h.list();
    expect(r.rows[0]).not.toHaveProperty('tradeLock');
    expect(r.rows[0]?.advice?.kind).toBe('sell-now');
    expect(r.totals).not.toHaveProperty('locked');
  });

  it('marks the rows: tradeLock, Locked advice, and Sellable now leaving them out', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, ALICE)]);
    const bought = rec(repo, 'buy', '378;6', 100, { ts: T0 - 2 * DAY });
    rec(repo, 'buy', '378;6', 100, { ts: T0 - HOUR });
    const h = setup({ repo, settings: LOCK_7D });
    h.start();
    const r = h.list();
    const tc = r.rows[0]!;
    expect(tc.tradeLock).toEqual({ lockedQty: 2, nextLotTradableAt: bought.ts + TRADE_LOCK_MS, firstTradableAt: bought.ts + TRADE_LOCK_MS });
    expect(tc.advice?.kind).toBe('locked');
    expect(tc.advice?.reasons[0]).toMatchObject({ code: 'trade-locked', tradableAt: bought.ts + TRADE_LOCK_MS, boughtAt: bought.ts, todayKind: 'sell-now' });
    // Prices and profits are unchanged.
    expect(tc).toMatchObject({ status: 'sell', revenueScrap: 120, profitNowScrap: 20, profitAllScrap: 40 });
    expect(r.totals).toMatchObject({ items: 1, units: 2, worthNowScrap: 240, profitNowScrap: 40, sellable: 0, locked: 1 });
  });

  it('switching 7d to none tells the newly sellable row', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, ALICE)]);
    rec(repo, 'buy', '378;6', 100, { ts: T0 - 2 * DAY });
    const h = setup({ repo, settings: LOCK_7D });
    h.start();
    expect(h.notes).toEqual([]);
    h.settings.current = mergeSettings(h.settings.current, { tradeLock: { mode: 'none', answeredAt: T0 } });
    h.holdings.settingsChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.notes.map((n) => n.title)).toEqual(['Sell: Team Captain']);
  });
});

describe('holdings: the key move band on key-exposure (0.9, #17)', () => {
  /** `n` daily PriceDB key points ending at T0 (buy 600 + d). */
  const keyPoints = (n: number): HistoryPoint[] =>
    Array.from({ length: n }, (_, d) => ({ t: Math.floor(T0 / 1000) - (n - 1 - d) * 86_400, buyScrap: 600 + d, sellScrap: 612 + d }));
  const exposure = (r: HoldingRow | undefined) => r?.advice?.reasons.find((x): x is Extract<HoldingAdviceReason, { code: 'key-exposure' }> => x.code === 'key-exposure');

  /** A Team Captain bought for 2 keys; Alice pays 1,200 scrap in metal: the sale nets -2 keys. */
  function keyed(keyHistory?: () => LoadedKeyHistory | null): Harness {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 1200, ALICE)]);
    rec(repo, 'buy', '378;6', 0, { keys: 2, ts: T0 - 2 * DAY });
    const h = setup({ repo, keyHistory });
    h.start();
    return h;
  }

  it('quotes the band of the key history already loaded', () => {
    const loaded: LoadedKeyHistory = { loadedAt: T0 - 10 * MIN, points: keyPoints(45) };
    const h = keyed(() => loaded);
    const band = keyMoveBandOf(loaded.points, loaded.loadedAt);
    expect(band).toMatchObject({ lowScrap: 7, highScrap: 7, spans: 38 });
    expect(exposure(h.row('378;6'))).toEqual({ code: 'key-exposure', netKeys: -2, boughtKeyScrap: 567, nowKeyScrap: 567, band });
  });

  it('gives none for too short a history, and follows a newer load', () => {
    let loaded: LoadedKeyHistory = { loadedAt: T0 - 10 * MIN, points: keyPoints(30) };
    const h = keyed(() => loaded);
    expect(KEY_BAND_MIN_SPANS).toBe(28);
    const e = exposure(h.row('378;6'));
    expect(e).toMatchObject({ code: 'key-exposure', netKeys: -2 });
    expect(e).not.toHaveProperty('band');
    // The drawer loads more history: the next read quotes it.
    loaded = { loadedAt: T0 - MIN, points: keyPoints(45) };
    expect(exposure(h.row('378;6'))?.band).toEqual(keyMoveBandOf(loaded.points, loaded.loadedAt));
  });

  it('gives none without the dep or without loaded history', () => {
    expect(exposure(keyed().row('378;6'))).not.toHaveProperty('band');
    expect(exposure(keyed(() => null).row('378;6'))).not.toHaveProperty('band');
  });

  it('a failing key history read gives no band, and the rows are still built', () => {
    const h = keyed(() => {
      throw new Error('boom');
    });
    const r = h.row('378;6');
    expect(r).toMatchObject({ sku: '378;6', revenueScrap: 1200 });
    expect(exposure(r)).toMatchObject({ code: 'key-exposure', netKeys: -2 });
    expect(exposure(r)).not.toHaveProperty('band');
    expect(h.log.lines.some((l) => l.level === 'warn' && l.msg === 'Holdings could not read the key history')).toBe(true);
  });

  it('never puts a band on a currency row', () => {
    const repo = newRepo();
    rec(repo, 'buy', '5021;6', 567);
    const h = setup({ repo, keyHistory: () => ({ loadedAt: T0, points: keyPoints(45) }) });
    h.start();
    const key = h.row('5021;6');
    expect(key).toBeDefined();
    expect(exposure(key)).toBeUndefined();
  });
});
