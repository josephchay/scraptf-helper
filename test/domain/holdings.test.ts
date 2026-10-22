// Holdings (F11), service side: the journal's open FIFO lots priced from the
// Live market index (or the same evaluation on demand before it has built),
// statuses, order, totals, CSV and the held bases core adds to the watch list;
// then the "Sell: <name>" notifications: triggers, gates, dedupe across
// restarts and the per-batch limit. Real in-memory repo and market index, fake
// clock and timers; nothing here touches the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { CSV_BOM } from '../../src/service/domain/csv';
import { MAX_NOTIFICATIONS_PER_RUN } from '../../src/service/domain/engine';
import { HOLDINGS_CHECK_MS, HOLDINGS_NOTIFY_META_KEY, createHoldings, holdingsCsv, type Holdings } from '../../src/service/domain/holdings';
import { journalSummary } from '../../src/service/domain/journal';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { MARKET_DIRTY_BATCH_MS, MARKET_NOTIFY_MS, createMarketIndex, type MarketIndex } from '../../src/service/domain/market';
import { formatScrap } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { HOLDINGS_CSV_COLUMNS } from '../../src/shared/holdings';
import type { PushContract } from '../../src/shared/rpc';
import type { DeepPartial, HoldingRow, JournalEntry, Listing, Settings, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingLogger } from './helpers';

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

const NAMES: Record<string, string> = {
  '378;6': 'Team Captain',
  '378;11': 'Strange Team Captain',
  '126;6': "Bill's Hat",
  '205;6': 'Rocket Launcher',
  '15000;6': 'Sniper Rifle',
  '30920;6': 'Taunt: The Bunnyhopper',
  '378;5;u13': 'Burning Flames Team Captain',
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

interface Harness {
  repo: Repo;
  clock: FakeClock;
  timers: FakeTimers;
  settings: { current: Settings };
  log: ReturnType<typeof recordingLogger>;
  market: MarketIndex;
  holdings: Holdings;
  notes: PushContract['notify'][];
  K(): number;
  /** Starts both and lets the first build and the holdings check run. */
  start(): void;
  /** Book change as the feed makes it: stored, marked dirty, batched, pushed, then checked. */
  book(upserts: Listing[], deletes?: string[]): void;
  list(search?: string): ReturnType<Holdings['list']>;
  row(sku: string): HoldingRow | undefined;
}

function setup(opts: { repo?: Repo; settings?: DeepPartial<Settings>; now?: UnixMs } = {}): Harness {
  const repo = opts.repo ?? newRepo();
  const clock = new FakeClock(opts.now ?? T0);
  const timers = new FakeTimers(clock);
  // minConfidence 0: these books are small, and the confidence gate has a test of its own.
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
    // 0.7.3: a constant slice clock keeps each build one slice (MARKET_SLICE_MS is wall-clock time
    // otherwise), so the fake clock alone decides the change pushes.
    sliceNow: () => 0,
  });
  holdings = createHoldings({ ...deps, schema, market, timers, keyPrice, notify: (n) => notes.push(n) });
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
    K: () => keyPrice().valueScrap,
    start() {
      market.start();
      holdings.start();
      timers.advance(0);
      expect(market.stats().building).toBe(false);
      timers.advance(HOLDINGS_CHECK_MS);
    },
    book(upserts, deletes = []) {
      const gone = deletes.map((id) => repo.getListing(id)?.baseSku ?? '');
      if (upserts.length > 0) repo.upsertListings(upserts);
      if (deletes.length > 0) repo.deleteListings(deletes);
      market.markDirty([...upserts.map((l) => l.baseSku), ...gone].filter(Boolean));
      settle();
    },
    list: (search) => holdings.list(search === undefined ? {} : { search }, clock.now()),
    row: (sku) => holdings.list({}, clock.now()).rows.find((r) => r.sku === sku),
  };
}

/** Team Captain 120 (Alice, bot), Bill's Hat 60, Rocket Launcher 40; no order for the Sniper Rifle. */
function seedBooks(repo: Repo): void {
  repo.upsertListings([
    buy('378;6', 120, { id: 'tc', steamid: '76561198000000001', userName: 'Alice', isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true }),
    buy('126;6', 60, { id: 'bh', steamid: '76561198000000002', userName: 'Bob' }),
    buy('205;6', 40, { id: 'rl', steamid: '76561198000000003', userName: 'Cid' }),
  ]);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe('holdings.list', () => {
  it('prices open FIFO lots from the market entries: figures, statuses, order and totals', () => {
    const repo = newRepo();
    seedBooks(repo);
    // FIFO: the sell closes the 80 lot, leaving 90 (next) and 100.
    rec(repo, 'buy', '378;6', 80);
    rec(repo, 'sell', '378;6', 95);
    const next = rec(repo, 'buy', '378;6', 90);
    const later = rec(repo, 'buy', '378;6', 100);
    rec(repo, 'buy', '126;6', 55);
    rec(repo, 'buy', '205;6', 50);
    rec(repo, 'buy', '15000;6', 30);
    // Bought and sold: not held.
    rec(repo, 'buy', '30920;6', 20);
    rec(repo, 'sell', '30920;6', 30);
    const h = setup({ repo });
    h.start();

    const r = h.list();
    expect(r.rows.map((x) => [x.sku, x.status])).toEqual([
      ['378;6', 'sell'],
      ['126;6', 'hold'],
      ['205;6', 'loss'],
      ['15000;6', 'no-buyers'],
    ]);
    const tc = r.rows[0]!;
    expect(tc).toMatchObject({
      name: 'Team Captain',
      category: 'hats',
      qty: 2,
      costScrap: 190,
      nextLotCostScrap: 90,
      heldSince: next.ts,
      revenueScrap: 120,
      bestScrap: 120,
      buyerCount: 1,
      profitNowScrap: 30,
      profitAllScrap: 2 * 120 - 190,
      revenueOrder: { listingId: 'tc', userName: 'Alice', isBot: true },
      bestOrder: { listingId: 'tc' },
    });
    expect(tc.margin).toBeCloseTo(30 / 90);
    expect(tc.heldSince).toBeLessThan(later.ts);
    // Same figures as the Live market's own entry.
    const entry = h.market.entryFor('378;6')!;
    expect(tc).toMatchObject({ revenueScrap: entry.revenueScrap, confidence: entry.confidence, confidenceLevel: entry.confidenceLevel, lastOrderChangeAt: entry.lastOrderChangeAt });
    expect(r.rows[1]).toMatchObject({ profitNowScrap: 5, profitAllScrap: 5 });
    expect(r.rows[2]).toMatchObject({ profitNowScrap: -10, profitAllScrap: -10 });
    expect(r.rows[3]).toMatchObject({ revenueScrap: null, profitNowScrap: null, profitAllScrap: null, margin: null, buyerCount: 0, revenueOrder: null, bestOrder: null });
    expect(r.totals).toEqual({ items: 4, units: 5, costScrap: 190 + 55 + 50 + 30, worthNowScrap: 240 + 60 + 40, profitNowScrap: 50 + 5 - 10, sellable: 1 });
    expect(r.keyPrice?.valueScrap).toBe(h.K());
    expect(r.generatedAt).toBe(h.clock.now());

    // The search narrows the rows, never the totals.
    const s = h.list('CAPTAIN');
    expect(s.rows.map((x) => x.sku)).toEqual(['378;6']);
    expect(s.totals).toEqual(r.totals);
    expect(h.holdings.all({ search: 'rocket' }, T0).map((x) => x.sku)).toEqual(['205;6']);
  });

  it('prices holdings before the index has built, with the same evaluation', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 90);
    rec(repo, 'buy', '126;6', 55);
    rec(repo, 'buy', '15000;6', 30);
    const h = setup({ repo });
    expect(h.market.entryFor('378;6')).toBeNull();
    const before = h.list();
    expect(before.rows.map((x) => [x.sku, x.revenueScrap, x.status])).toEqual([
      ['378;6', 120, 'sell'],
      ['126;6', 60, 'hold'],
      ['15000;6', null, 'no-buyers'],
    ]);
    h.start();
    expect(h.list().rows).toEqual(before.rows);
  });

  it('values key-priced lots at the current key price, like the revenue (keys and metal netted apart, as the journal books a sale)', () => {
    const repo = newRepo();
    repo.upsertListings([buy('30920;6', 0, { id: 'taunt', steamid: 'T1', keys: 2 })]);
    rec(repo, 'buy', '30920;6', 9, { keys: 1, keyPriceScrap: 540 });
    rec(repo, 'buy', '30920;6', 0, { keys: 1, keyPriceScrap: 600 });
    const h = setup({ repo });
    h.start();
    const K = h.K();
    expect(K).not.toBe(540);
    expect(h.row('30920;6')).toMatchObject({
      qty: 2,
      nextLotCostScrap: K + 9,
      costScrap: 2 * K + 9,
      revenueScrap: 2 * K,
      profitNowScrap: K - 9,
      profitAllScrap: 4 * K - (2 * K + 9),
      status: 'sell',
      category: 'taunts',
    });
  });

  it('never reads a key price move as profit: no "Sell:" for a lot sold for the keys it cost, and no loss on one sold above them', () => {
    const repo = newRepo();
    // Key up: bought for 1 key while a key was 500; Kim pays exactly 1 key now.
    repo.upsertListings([buy('30920;6', 0, { id: 'kim', steamid: 'K1', userName: 'Kim', keys: 1 })]);
    rec(repo, 'buy', '30920;6', 0, { keys: 1, keyPriceScrap: 500 });
    // Key down: bought for 10 keys while a key was 600; Lee pays 10 keys and 18 scrap now.
    repo.upsertListings([buy('378;11', 18, { id: 'lee', steamid: 'L1', userName: 'Lee', keys: 10 })]);
    rec(repo, 'buy', '378;11', 0, { keys: 10, keyPriceScrap: 600 });
    const h = setup({ repo });
    h.start();
    const K = h.K();
    expect(K).toBeGreaterThan(500);
    expect(K).toBeLessThan(600);

    const up = h.row('30920;6')!;
    expect(up).toMatchObject({ revenueScrap: K, nextLotCostScrap: K, profitNowScrap: 0, status: 'loss' });
    const down = h.row('378;11')!;
    expect(down).toMatchObject({ revenueScrap: 10 * K + 18, nextLotCostScrap: 10 * K, profitNowScrap: 18 });
    expect(down.status).not.toBe('loss');
    expect(h.notes).toEqual([]);

    // The journal books exactly these figures once the sales are recorded at today's key price.
    rec(repo, 'sell', '30920;6', 0, { keys: 1, keyPriceScrap: K });
    rec(repo, 'sell', '378;11', 18, { keys: 10, keyPriceScrap: K });
    const booked = journalSummary(repo.listJournal()).bySku;
    expect(booked.find((s) => s.sku === '30920;6')?.realizedProfitScrap).toBe(up.profitNowScrap);
    expect(booked.find((s) => s.sku === '378;11')?.realizedProfitScrap).toBe(down.profitNowScrap);
  });

  it('applies friction per unit', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 90);
    rec(repo, 'buy', '378;6', 100);
    const h = setup({ repo, settings: { profit: { frictionScrap: 2 } } });
    h.start();
    expect(h.row('378;6')).toMatchObject({ profitNowScrap: 120 - 90 - 2, profitAllScrap: 240 - 190 - 4 });
  });

  it('prices a painted copy against its clean base, flagged, and an effect only a generic book buys', () => {
    const repo = newRepo();
    seedBooks(repo);
    // The generic "any effect" order buys every effect; the effect has no order (or price) of its own.
    repo.upsertListings([buy('378;5', 0, { id: 'any', steamid: 'G1', keys: 10 })]);
    rec(repo, 'buy', '378;6;p3100495', 95);
    rec(repo, 'buy', '378;5;u13', 0, { keys: 8 });
    const h = setup({ repo });
    h.start();
    const K = h.K();
    const painted = h.row('378;6;p3100495')!;
    expect(painted).toMatchObject({ revenueScrap: 120, profitNowScrap: 25, status: 'sell', category: 'hats' });
    expect(painted.flags).toContain('has-extras');
    // The index lists such an effect only with a price of yours; holdings evaluates it on demand.
    expect(h.market.entryFor('378;5;u13')).toBeNull();
    const effect = h.row('378;5;u13')!;
    expect(effect).toMatchObject({ revenueScrap: 10 * K, buyerCount: 1, category: 'unusuals' });
    expect(effect.revenueOrder?.flags).toContain('any-effect');
    expect(effect.flags).not.toContain('has-extras');
  });

  it('reads no order book per row once the index has built, except for an effect a generic order may buy', () => {
    const repo = newRepo();
    seedBooks(repo);
    repo.upsertListings([buy('378;5', 0, { id: 'any', steamid: 'G1', keys: 10 })]);
    rec(repo, 'buy', '378;6', 90);
    rec(repo, 'buy', '15000;6', 30); // no order at all
    const h = setup({ repo });
    h.start();
    // 0.8 (H4): the first list fills the per-base reference cache.
    h.list();
    const books = vi.spyOn(repo, 'buyListingsByBaseSkus');
    const refs = vi.spyOn(repo, 'getPricedb');
    expect(h.list().rows.map((x) => [x.sku, x.status])).toEqual([
      ['378;6', 'sell'],
      ['15000;6', 'no-buyers'],
    ]);
    expect(books).not.toHaveBeenCalled();
    expect(refs).not.toHaveBeenCalled();

    // The index lists an effect only the generic book buys only with a price of yours: priced on demand.
    rec(repo, 'buy', '378;5;u13', 0, { keys: 8 });
    h.holdings.journalChanged();
    expect(h.row('378;5;u13')?.revenueScrap).toBe(10 * h.K());
    expect(books).toHaveBeenCalledTimes(1);
    expect(books.mock.calls[0]![0]).toEqual(['378;5;u13', '378;5']);
  });

  it('keeps held currencies as rows without a buy side, and survives an unreadable journal', () => {
    const repo = newRepo();
    rec(repo, 'buy', '5021;6', 0, { keys: 1 });
    const h = setup({ repo });
    h.start();
    expect(h.list().rows).toEqual([expect.objectContaining({ sku: '5021;6', qty: 1, costScrap: 567, status: 'no-buyers', revenueScrap: null })]);
    expect(h.holdings.heldBases().size).toBe(0);

    vi.spyOn(repo, 'listJournal').mockImplementation(() => {
      throw new Error('database is locked');
    });
    h.holdings.journalChanged();
    expect(h.list().rows).toEqual([]);
    expect(h.holdings.heldBases()).toEqual(new Set());
    expect(h.log.lines.some((l) => l.level === 'warn' && /journal/.test(l.msg))).toBe(true);
  });

  it('writes the CSV in the shared columns', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 90);
    rec(repo, 'buy', '15000;6', 30);
    const h = setup({ repo });
    h.start();
    const csv = holdingsCsv(h.holdings.all({}, T0), h.K());
    const lines = csv.replace(CSV_BOM, '').trim().split('\r\n');
    expect(lines[0]).toBe(HOLDINGS_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('378;6,Team Captain,1,');
    expect(lines[1]).toContain('Alice (bot)');
    expect(lines[1]).toContain(',sell,');
    expect(lines[2]).toContain(',no-buyers,');
  });
});

describe('heldBases', () => {
  it('lists the clean base of every open lot, without currencies or closed positions, refreshed on journal changes', () => {
    const repo = newRepo();
    rec(repo, 'buy', '378;6;p3100495', 95);
    rec(repo, 'buy', '378;5;u13', 0, { keys: 8 });
    rec(repo, 'buy', '5021;6', 0, { keys: 1 });
    rec(repo, 'buy', '126;6', 50);
    rec(repo, 'sell', '126;6', 60);
    const h = setup({ repo });
    expect(h.holdings.heldBases()).toEqual(new Set(['378;6', '378;5;u13']));

    rec(repo, 'buy', '205;6', 40);
    expect(h.holdings.heldBases().has('205;6')).toBe(false); // cached until the journal change
    h.holdings.journalChanged();
    expect(h.holdings.heldBases()).toEqual(new Set(['378;6', '378;5;u13', '205;6']));
  });

  // 0.7.4 (F38): a sale of a copy owned before the app no longer settles the next buy of the item.
  it('holds a buy logged after a sale with no buy before it', () => {
    const repo = newRepo();
    rec(repo, 'sell', '5040;6', 198, { keys: 2 });
    rec(repo, 'buy', '5040;6', 389, { keys: 1 });
    const h = setup({ repo });
    expect(h.holdings.heldBases()).toEqual(new Set(['5040;6']));
  });
});

// ---------------------------------------------------------------------------
// Sell notifications
// ---------------------------------------------------------------------------

describe('sell notifications', () => {
  it("notifies a held item entering 'sell' once, naming the buyer, the revenue and the profit", () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 100);
    rec(repo, 'buy', '126;6', 55); // hold: never notified
    const h = setup({ repo });
    h.start();
    const K = h.K();
    expect(h.notes).toEqual([{ title: 'Sell: Team Captain', body: `Alice pays ${formatScrap(120, K)} (bot), +${formatScrap(20, K)} over your cost`, sku: '378;6' }]);

    // Re-evaluated, still selling: nothing new.
    h.book([buy('378;6', 120, { id: 'tc', steamid: '76561198000000001', userName: 'Alice', isBot: true, lastEventAt: T0 })]);
    h.holdings.settingsChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.notes).toHaveLength(1);
  });

  it('notifies again when profitNow rises by 1 ref or more while selling, once the dedupe window allows', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 100);
    const h = setup({ repo });
    h.start();
    expect(h.notes).toHaveLength(1); // +20

    h.book([buy('378;6', 125, { id: 'b2', steamid: 'S2' })]); // +25: under 1 ref more
    expect(h.notes).toHaveLength(1);
    h.book([buy('378;6', 135, { id: 'b3', steamid: 'S3' })]); // +35: enough, but inside the 30-min window
    expect(h.notes).toHaveLength(1);

    h.clock.advance(30 * MIN);
    h.book([buy('378;6', 136, { id: 'b4', steamid: 'S4', userName: 'Dana' })]); // +36 vs +20 last told
    expect(h.notes).toHaveLength(2);
    expect(h.notes[1]).toMatchObject({ title: 'Sell: Team Captain', body: expect.stringContaining(`+${formatScrap(36, h.K())} over your cost`) });

    // Falling while still selling is quiet; leaving 'sell' and coming back after the window notifies.
    h.clock.advance(31 * MIN);
    h.book([], ['b3', 'b4']);
    expect(h.row('378;6')).toMatchObject({ profitNowScrap: 25, status: 'sell' });
    expect(h.notes).toHaveLength(2);
    h.book([], ['tc', 'b2']);
    expect(h.row('378;6')?.status).toBe('no-buyers');
    h.book([buy('378;6', 130, { id: 'b5', steamid: 'S5' })]);
    expect(h.notes).toHaveLength(3);
  });

  it('dedupes per SKU across restarts through repo meta, for notifications.dedupMs', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 100);
    const first = setup({ repo });
    first.start();
    expect(first.notes).toHaveLength(1);
    first.holdings.stop();
    first.market.stop();
    expect(JSON.parse(repo.getMeta(HOLDINGS_NOTIFY_META_KEY)!)).toEqual({ '378;6': T0 + HOLDINGS_CHECK_MS });

    // A restart 10 minutes later: the item enters 'sell' again for the new process, but was just told.
    const second = setup({ repo, now: T0 + 10 * MIN });
    second.start();
    expect(second.notes).toEqual([]);
    second.holdings.stop();
    second.market.stop();

    // After the window it is a fresh reminder.
    const third = setup({ repo, now: T0 + 30 * MIN });
    third.start();
    expect(third.notes).toHaveLength(1);
    expect(JSON.parse(repo.getMeta(HOLDINGS_NOTIFY_META_KEY)!)).toEqual({ '378;6': T0 + 30 * MIN + HOLDINGS_CHECK_MS });
    third.holdings.stop();
    third.market.stop();

    // A broken history is ignored (and replaced), not fatal.
    repo.setMeta(HOLDINGS_NOTIFY_META_KEY, '{not json');
    const fourth = setup({ repo, now: T0 + 31 * MIN });
    fourth.start();
    expect(fourth.notes).toHaveLength(1);
    expect(fourth.log.lines.some((l) => l.level === 'warn' && /notification history/.test(l.msg))).toBe(true);
  });

  it('sends at most 3 per batch, most profitable first, then one summary', () => {
    const repo = newRepo();
    const skus = ['378;6', '378;11', '126;6', '205;6', '30920;6'];
    skus.forEach((sku, i) => {
      repo.upsertListings([buy(sku, 100 + 10 * i, { id: `o${i}`, steamid: `S${i}`, userName: `Buyer ${i}` })]);
      rec(repo, 'buy', sku, 70);
    });
    const h = setup({ repo });
    h.start();
    expect(MAX_NOTIFICATIONS_PER_RUN).toBe(3);
    expect(h.notes.map((n) => n.sku)).toEqual(['30920;6', '205;6', '126;6', null]);
    expect(h.notes[3]).toEqual({ title: '2 more held items to sell', body: 'They can be sold at a profit now. Open TF2 Flip Desk to see them.', sku: null });
    // Every one of them counts as told.
    expect(Object.keys(JSON.parse(repo.getMeta(HOLDINGS_NOTIFY_META_KEY)!)).sort()).toEqual([...skus].sort());
  });

  it('respects notifications.enabled, notifications.holdings and minConfidence, and does not replay when switched on', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 100);
    const off = setup({ repo, settings: { notifications: { enabled: false } } });
    off.start();
    expect(off.notes).toEqual([]);
    // Switched on: the item was already selling, so nothing is replayed.
    off.settings.current = mergeSettings(off.settings.current, { notifications: { enabled: true } });
    off.holdings.settingsChanged();
    off.timers.advance(HOLDINGS_CHECK_MS);
    expect(off.notes).toEqual([]);
    // A newly sellable item is told.
    rec(repo, 'buy', '205;6', 20);
    off.holdings.journalChanged();
    off.timers.advance(HOLDINGS_CHECK_MS);
    expect(off.notes.map((n) => n.title)).toEqual(['Sell: Rocket Launcher']);

    const muted = setup({ repo, settings: { notifications: { holdings: false } } });
    muted.start();
    expect(muted.notes).toEqual([]);

    const strict = setup({ repo, settings: { notifications: { minConfidence: 100 } } });
    strict.start();
    expect(strict.notes).toEqual([]);
    expect(repo.getMeta(HOLDINGS_NOTIFY_META_KEY)).toContain('205;6'); // only what `off` told
  });

  it('tells an item that entered sell below minConfidence once more buyers lift its confidence', () => {
    const more = [2, 3, 4].map((i) => buy('378;6', 120, { id: `m${i}`, steamid: `S${i}`, userName: `Buyer ${i}` }));
    // The confidence of one buyer and of four, at the same price (so the profit does not move).
    const probe = setup();
    seedBooks(probe.repo);
    probe.start();
    const one = probe.market.entryFor('378;6')!.confidence;
    probe.book(more);
    const four = probe.market.entryFor('378;6')!.confidence;
    expect(four).toBeGreaterThan(one);

    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 100);
    const h = setup({ repo, settings: { notifications: { minConfidence: four } } });
    h.start();
    expect(h.row('378;6')).toMatchObject({ status: 'sell', profitNowScrap: 20, confidence: one });
    expect(h.notes).toEqual([]);

    h.book(more);
    expect(h.row('378;6')).toMatchObject({ profitNowScrap: 20, confidence: four, buyerCount: 4 });
    expect(h.notes.map((n) => n.sku)).toEqual(['378;6']);
    // Told now: the same state stays quiet.
    h.holdings.settingsChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.notes).toHaveLength(1);
  });

  it('checks only held bases on a market change, and a generic book change reaches a held effect', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;5;u13', 0, { keys: 8 });
    const h = setup({ repo });
    h.start();
    expect(h.notes).toEqual([]); // no buyer for it yet
    const K = h.K();

    // Unrelated bases: no check is even scheduled.
    const pending = h.timers.count;
    h.holdings.onBasesChanged(new Set(['126;6', '205;6']));
    expect(h.timers.count).toBe(pending);

    // A generic "any effect" order: only the generic base's entry changes; the held effect follows.
    h.book([buy('378;5', 0, { id: 'any', steamid: 'G1', keys: 10, userName: 'Gus' })]);
    expect(h.notes).toEqual([{ title: 'Sell: Burning Flames Team Captain', body: `Gus pays ${formatScrap(10 * K, K)} (human), +${formatScrap(2 * K, K)} over your cost`, sku: '378;5;u13' }]);
  });

  it('re-checks on journal and settings changes', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '126;6', 55); // +5: hold under the default thresholds
    const h = setup({ repo });
    h.start();
    expect(h.notes).toEqual([]);

    // Lower thresholds make it sellable.
    h.settings.current = mergeSettings(h.settings.current, { profit: { minProfitScrap: 3, minProfitPctOfCost: 0, minMargin: 0.05 } });
    h.holdings.settingsChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.notes.map((n) => n.sku)).toEqual(['126;6']);

    // A recorded buy of a sellable item is told right away.
    rec(repo, 'buy', '378;6', 100);
    h.holdings.journalChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.notes.map((n) => n.sku)).toEqual(['126;6', '378;6']);

    // Sold: gone from the rows; a later buy after the window is a new entry into 'sell'.
    rec(repo, 'sell', '378;6', 120);
    h.holdings.journalChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.row('378;6')).toBeUndefined();
    h.clock.advance(30 * MIN);
    rec(repo, 'buy', '378;6', 100);
    h.holdings.journalChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.notes.map((n) => n.sku)).toEqual(['126;6', '378;6', '378;6']);
  });

  it('coalesces triggers into one check, runs only while started, and survives a failing notify', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 100);
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } });
    const log = recordingLogger();
    const entryFor = vi.fn(() => null);
    const sent: string[] = [];
    const holdings = createHoldings({
      ...makeDeps(repo, clock, () => settings, log),
      schema: createStubSchema(),
      market: { entryFor } as unknown as MarketIndex,
      timers,
      keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings, clock.now()),
      notify: (n) => {
        sent.push(n.title);
        throw new Error('main went away');
      },
    });

    // Before start: remembered, not run.
    holdings.journalChanged();
    holdings.settingsChanged();
    expect(timers.count).toBe(0);
    holdings.start();
    expect(timers.count).toBe(1);
    holdings.onBasesChanged(new Set(['378;6']));
    expect(timers.count).toBe(1);
    timers.advance(HOLDINGS_CHECK_MS);
    expect(sent).toEqual(['Sell: Team Captain']); // priced on demand: the index has no entry
    expect(entryFor).toHaveBeenCalledWith('378;6');
    expect(log.lines.some((l) => l.level === 'warn' && /notification failed/.test(l.msg))).toBe(true);

    holdings.settingsChanged();
    holdings.stop();
    expect(timers.count).toBe(0);
    timers.advance(HOLDINGS_CHECK_MS);
    expect(sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 0.8 (PC-2, H2; PC-1 R-PC1-sell)
// ---------------------------------------------------------------------------

describe('holdings.list: next buyer and the price-move reserve (0.8)', () => {
  /** seedBooks plus a second Team Captain buyer at 100, so one held base has a next buyer and one has none. */
  function seed(repo: Repo): void {
    seedBooks(repo);
    repo.upsertListings([buy('378;6', 100, { id: 'tc2', steamid: '76561198000000009', userName: 'Dee' })]);
    rec(repo, 'buy', '378;6', 90);
    rec(repo, 'buy', '126;6', 55);
    rec(repo, 'buy', '15000;6', 30);
  }

  it("carries the market entry's nextBuyer and verifiedBuyerCount on rows with a buy side", () => {
    const repo = newRepo();
    seed(repo);
    const h = setup({ repo });
    h.start();
    for (const base of ['378;6', '126;6']) {
      const e = h.market.entryFor(base)!;
      const r = h.row(base)!;
      expect(r.nextBuyer).toEqual(e.nextBuyer);
      expect(r.verifiedBuyerCount).toBe(e.verifiedBuyerCount);
    }
    expect(h.row('378;6')).toMatchObject({ verifiedBuyerCount: 2, nextBuyer: { valueScrap: 100, unverified: false } });
    expect(h.row('126;6')).toMatchObject({ verifiedBuyerCount: 1, nextBuyer: null });
    // No order for the Sniper Rifle: no buy side, so no depth either.
    const none = h.row('15000;6')!;
    expect('nextBuyer' in none || 'verifiedBuyerCount' in none).toBe(false);
  });

  it('judges a held row without the price-move reserve (a sale into a live order)', () => {
    const plain = (() => {
      const repo = newRepo();
      seed(repo);
      const h = setup({ repo });
      h.start();
      return h.list().rows;
    })();
    const repo = newRepo();
    seed(repo);
    const h = setup({ repo, settings: { profit: { exitReservePct: 0.3 } } });
    h.start();
    const reserved = h.list().rows;
    expect(reserved.map((r) => [r.sku, r.profitNowScrap, r.status])).toEqual(plain.map((r) => [r.sku, r.profitNowScrap, r.status]));
    expect(reserved.find((r) => r.sku === '378;6')!.profitNowScrap).toBe(120 - 90);
  });
});

// ---------------------------------------------------------------------------
// 0.8 (H5): the user's typical hold on each row
// ---------------------------------------------------------------------------

describe('holdings.list: the typical hold (0.8, H5)', () => {
  it("sets the item's own median at 3 sales, the journal's at 5, and counts every open unit as still held", () => {
    const repo = newRepo();
    seedBooks(repo);
    const at = (hours: number) => ({ ts: T0 - 200 * HOUR + hours * HOUR });
    // Three Team Captain flips held 1, 2 and 6 hours; one Team Captain and one Bill's Hat still held.
    rec(repo, 'buy', '378;6', 80, at(0));
    rec(repo, 'sell', '378;6', 95, at(1));
    rec(repo, 'buy', '378;6', 80, at(10));
    rec(repo, 'sell', '378;6', 95, at(12));
    rec(repo, 'buy', '378;6', 80, at(20));
    rec(repo, 'sell', '378;6', 95, at(26));
    rec(repo, 'buy', '378;6', 90, at(30));
    rec(repo, 'buy', '126;6', 55, at(31));
    // A write-off is not a sale: it never counts toward a hold.
    rec(repo, 'buy', '205;6', 50, at(40));
    rec(repo, 'writeoff', '205;6', 0, at(140));
    const h = setup({ repo });
    h.start();
    expect(h.row('378;6')!.typicalHold).toEqual({ medianMs: 2 * HOUR, count: 3, scope: 'item', stillHeld: 1 });
    // Three sales in all are too few for the journal's median: no key at all.
    expect('typicalHold' in h.row('126;6')!).toBe(false);

    // Two more sales (of another item) make five; the rows follow on the next read after journalChanged.
    rec(repo, 'buy', '30920;6', 20, at(50));
    rec(repo, 'sell', '30920;6', 30, at(53));
    rec(repo, 'buy', '30920;6', 20, at(60));
    rec(repo, 'sell', '30920;6', 30, at(64));
    h.holdings.journalChanged();
    // Holds of 1, 2, 3, 4 and 6 hours; both open units (every position's, not just this row's) were left out.
    expect(h.row('126;6')!.typicalHold).toEqual({ medianMs: 3 * HOUR, count: 5, scope: 'all', stillHeld: 2 });
    expect(h.row('378;6')!.typicalHold).toMatchObject({ scope: 'item', count: 3, stillHeld: 1 });
  });
});
