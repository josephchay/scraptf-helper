// 0.9 (#3) in the Live market: each entry keeps its book's usable buyers seen in the last 24 h (ExitDepth), and each
// read judges the risk keys at the row's cost (marketRiskCost: your price, else a rule flip's estimate), so the
// 'backup' and 'depth' sorts and the shown values agree with the shared marketComparator. The CSV appends the risk
// keys, the book depth and its tag (D10). moved() is not extended: the next read shows a new depth without a push.
// Real in-memory repo, fake clock and timers; nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { CSV_BOM } from '../../src/service/domain/csv';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { MARKET_DIRTY_BATCH_MS, MARKET_NOTIFY_MS, createMarketIndex, marketCsv, type MarketIndex } from '../../src/service/domain/market';
import { flipProfit } from '../../src/shared/ceiling';
import { formatScrap } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { exitRiskAt } from '../../src/shared/exitRisk';
import { MARKET_CSV_COLUMNS, marketComparator, marketRiskCost } from '../../src/shared/market';
import type { DeepPartial, Listing, MarketRow, Settings, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing } from './helpers';

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

interface Harness {
  repo: Repo;
  clock: FakeClock;
  timers: FakeTimers;
  settings: { current: Settings };
  market: MarketIndex;
  changes: { changed: number; total: number; at: UnixMs }[];
  K: () => number;
}

/** market.test's setup: a constant slice clock, so the fake clock alone decides the change pushes. */
function setup(repo: Repo, settings: DeepPartial<Settings> = {}): Harness {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const s = { current: mergeSettings(DEFAULT_SETTINGS, settings) };
  const changes: Harness['changes'] = [];
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), s.current, clock.now());
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => s.current),
    schema: createStubSchema(),
    timers,
    keyPrice,
    onChanged: (p) => changes.push(p),
    folderWatchActive: () => true,
    sliceNow: () => 0,
  });
  return { repo, clock, timers, settings: s, market, changes, K: () => keyPrice().valueScrap };
}

function build(h: Harness): void {
  h.market.start();
  h.timers.advance(0);
  expect(h.market.stats().building).toBe(false);
}

function rowOf(h: Harness, sku: string): MarketRow | undefined {
  return h.market.all({}, h.clock.now()).find((r) => r.sku === sku);
}

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

/** market.test's Team Captain book: a fresh online bot at 108 and two humans at 105 and 102. */
function seedTeamCaptain(repo: Repo, now = T0): void {
  repo.upsertListings([
    makeListing({ id: 'tc-bot', steamid: 'S1', metalScrap: 108, isBot: true, uaLastPulse: Math.floor(now / 1000), userOnline: true, lastEventAt: now - MIN }),
    makeListing({ id: 'tc-h1', steamid: 'S2', metalScrap: 105, lastEventAt: now - MIN }),
    makeListing({ id: 'tc-h2', steamid: 'S3', metalScrap: 102, lastEventAt: now - 2 * MIN }),
  ]);
  repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 100, sellKeys: 0, sellScrap: 120, time: Math.floor(now / 1000), fetchedAt: now }]);
}

const P = DEFAULT_SETTINGS.profit;

describe('0.9 (#3): the Live market entry and rows', () => {
  it("keeps the book's usable buyers seen in the last 24 h on the entry", () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertListings([buy('378;6', 101, { id: 'old', steamid: 'OLD', lastEventAt: T0 - 25 * 60 * MIN })]);
    const h = setup(repo);
    build(h);
    // The 25-hour-old order is in the book (4 buyers) but not usable.
    expect(h.market.entryFor('378;6')).toMatchObject({ buyerCount: 4, exitDepth: { values: [108, 105, 102], buyers: 3 } });
  });

  it('gives the three figures at your price, and judges a rule flip at its estimate', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 104, source: 'user', observedAt: T0 - MIN });
    repo.upsertListings([buy('126;6', 60, { id: 'bh1', steamid: 'BH1' }), buy('126;6', 58, { id: 'bh2', steamid: 'BH2' }), buy('126;6', 30, { id: 'bh3', steamid: 'BH3' })]);
    repo.upsertRule({ name: 'Hats', filter: { defindexes: [126] }, costScrap: 40, observedAt: T0 });
    const h = setup(repo);
    build(h);
    const tc = rowOf(h, '378;6')!;
    // Over Pay up to, yet judged at your price all the same.
    expect(tc).toMatchObject({ verdict: 'over', knownCostScrap: 104, revenueScrap: 108 });
    // The next buyer seen in 24 h pays 105: profit 1 at 104. 108 and 105 clear 104; 102 does not.
    expect(tc).toMatchObject({ backupProfitScrap: flipProfit(105, 104, P), profitableDepth: 2, bookDepth: 3 });
    const bh = rowOf(h, '126;6')!;
    expect(bh).toMatchObject({ verdict: 'rule-flip', knownCostScrap: null, ruleCostScrap: 40, revenueScrap: 60 });
    expect(marketRiskCost(bh)).toBe(40);
    expect(bh).toMatchObject({ backupProfitScrap: 18, profitableDepth: 2, bookDepth: 3 });
  });

  it('an unchecked row with buyers has a null depth and no backup; a known-only row has no fields', () => {
    const repo = newRepo();
    repo.upsertListings([buy('205;6', 60, { id: 'rl1', steamid: 'RL1' }), buy('205;6', 55, { id: 'rl2', steamid: 'RL2' })]);
    repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 40, source: 'user', observedAt: T0 - MIN });
    const h = setup(repo);
    build(h);
    const unchecked = rowOf(h, '205;6')!;
    expect(unchecked.verdict).toBe('unchecked');
    expect(unchecked).toMatchObject({ profitableDepth: null, bookDepth: 2 });
    expect('backupProfitScrap' in unchecked).toBe(false);
    const known = rowOf(h, '126;6')!;
    expect(known.verdict).toBe('no-buyers');
    expect('bookDepth' in known || 'profitableDepth' in known || 'backupProfitScrap' in known).toBe(false);
  });

  it("every row's figures equal exitRiskAt over its entry at marketRiskCost", () => {
    const h = marketOfMany();
    const rows = h.market.all({}, T0);
    expect(rows.length).toBeGreaterThan(100);
    let judged = 0;
    for (const r of rows) {
      const e = h.market.entryFor(r.sku);
      const risk = e ? exitRiskAt(e, marketRiskCost(r), h.settings.current.profit) : null;
      expect(r.bookDepth, r.sku).toBe(risk?.bookDepth);
      expect(r.profitableDepth, r.sku).toBe(risk ? risk.profitableDepth : undefined);
      expect(r.backupProfitScrap, r.sku).toBe(risk?.backupProfitScrap ?? undefined);
      if (risk?.profitableDepth !== null && risk !== null) judged++;
    }
    expect(judged).toBeGreaterThan(20);
  });
});

/** market.test's marketOfMany, with depth: several buyers per item, some unverified, typed prices and a rule. */
function marketOfMany(): Harness {
  const repo = newRepo();
  const listings: Listing[] = [];
  for (let i = 0; i < 160; i++) {
    const sku = `${200_000 + i};6`;
    const v = i % 9 === 0 ? 5 : 20 + (i % 13) * 7;
    listings.push(buy(sku, v, { id: `m${i}`, steamid: `A${i}`, isBot: i % 4 === 0, lastEventAt: T0 - (i % 17) * MIN }));
    if (i % 3 === 0) listings.push(buy(sku, v - 1, { id: `n${i}`, steamid: `B${i}` }));
    if (i % 5 === 0) listings.push(buy(sku, v - 4, { id: `o${i}`, steamid: `C${i}`, isBot: true }));
    if (i % 7 === 0) listings.push(buy(sku, v - 2, { id: `u${i}`, steamid: `D${i}`, lastEventAt: T0 - 30 * 60 * MIN }));
  }
  repo.upsertListings(listings);
  for (let i = 0; i < 160; i += 4) repo.upsertScrapPrice({ sku: `${200_000 + i};6`, name: 'x', costScrap: 10 + (i % 40), source: i % 8 === 0 ? 'import' : 'user', observedAt: T0 - i * MIN, stock: 2 });
  for (let i = 0; i < 10; i++) repo.upsertScrapPrice({ sku: `${300_000 + i};6`, name: 'x', costScrap: 30, source: 'user', observedAt: T0 - i * MIN });
  repo.upsertRule({ name: 'Cheap', filter: { defindexes: Array.from({ length: 40 }, (_, i) => 200_001 + i * 2) }, costScrap: 25, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const s = { current: mergeSettings(DEFAULT_SETTINGS, {}) };
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), s.current, clock.now());
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => s.current),
    schema: createStubSchema({ items: [], categoryOf: (d) => (d % 2 ? 'hats' : 'weapons'), nameOf: (sku) => `Item ${Number(sku.split(';')[0]) % 23}` }),
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => true,
    sliceNow: () => 0,
  });
  const h: Harness = { repo, clock, timers, settings: s, market, changes: [], K: () => keyPrice().valueScrap };
  build(h);
  return h;
}

describe("0.9 (#3): the 'backup' and 'depth' sorts", () => {
  it('order every direction exactly like the shared marketComparator, missing values last', () => {
    const h = marketOfMany();
    const rows = h.market.all({}, T0);
    for (const sort of ['backup', 'depth'] as const) {
      for (const dir of ['asc', 'desc', undefined] as const) {
        const got = h.market.all({ sort, ...(dir ? { dir } : {}) }, T0).map((r) => r.sku);
        const want = [...rows].sort(marketComparator(sort, dir)).map((r) => r.sku);
        expect(got, `${sort} ${dir ?? 'default'}`).toEqual(want);
        // list() pages the same order.
        expect(h.market.list({ sort, ...(dir ? { dir } : {}), limit: 2000 }, T0).rows.map((r) => r.sku)).toEqual(want);
      }
      // Rows with no figure sort last in both directions.
      for (const dir of ['asc', 'desc'] as const) {
        const sorted = h.market.all({ sort, dir }, T0);
        const key = sort === 'backup' ? 'backupProfitScrap' : 'profitableDepth';
        const firstMissing = sorted.findIndex((r) => typeof r[key] !== 'number');
        expect(firstMissing).toBeGreaterThan(0);
        expect(sorted.slice(firstMissing).every((r) => typeof r[key] !== 'number')).toBe(true);
      }
    }
  });
});

describe('0.9 (#3): the market CSV', () => {
  it("appends backup_profit, profitable_depth, book_depth and book_depth_tag", () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 104, source: 'user', observedAt: T0 - MIN });
    repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 40, source: 'user', observedAt: T0 - MIN });
    const h = setup(repo);
    build(h);
    expect(MARKET_CSV_COLUMNS.slice(-4)).toEqual(['backup_profit', 'profitable_depth', 'book_depth', 'book_depth_tag']);
    const rows = h.market.all({ sort: 'name', dir: 'asc' }, T0);
    const csv = marketCsv(rows, h.K());
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(CSV_BOM.length).trimEnd().split('\r\n');
    expect(lines[0]).toBe(MARKET_CSV_COLUMNS.join(','));
    const cells = (sku: string): string[] => lines.find((l) => l.startsWith(`${sku},`))!.split(',');
    expect(cells('378;6').slice(-4)).toEqual([formatScrap(1, h.K()), '2', '3', 'few']);
    // A known-only row (no book): blank.
    expect(cells('126;6').slice(-4)).toEqual(['', '', '', '']);
  });
});

describe('0.9 (#3): moved() is not extended', () => {
  it('a third buyer repricing pushes nothing, yet the next read shows the new depth', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 104, source: 'user', observedAt: T0 - MIN });
    const h = setup(repo);
    build(h);
    expect(rowOf(h, '378;6')).toMatchObject({ profitableDepth: 2, bookDepth: 3 });
    h.timers.advance(MARKET_NOTIFY_MS * 2);
    const pushes = h.changes.length;

    // The third buyer raises 102 to 104: the revenue, its order, the ceiling and the buyer count stay.
    repo.upsertListings([makeListing({ id: 'tc-h2', steamid: 'S3', metalScrap: 104, lastEventAt: h.clock.now() })]);
    h.market.markDirty(['378;6']);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    h.timers.advance(MARKET_NOTIFY_MS * 2);
    expect(h.changes.length).toBe(pushes);
    expect(rowOf(h, '378;6')).toMatchObject({ revenueScrap: 108, profitableDepth: 3, bookDepth: 3 });
    expect(h.market.list({ sort: 'depth' }, h.clock.now()).rows[0]).toMatchObject({ sku: '378;6', profitableDepth: 3 });
  });
});
