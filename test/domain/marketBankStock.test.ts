// F17 in the Live market index: MarketRow.scraptfNewAt is joined per read from the bank stock cache,
// MarketQuery.newOnScraptf ("New on scrap.tf") narrows rows and verdict counts like the mock's shared
// rule and re-filters after a bank stock refresh, and the bank stock page's buy side (revenue, Pay up
// to, buyers, confidence) is exactly the Live market row's. Real in-memory repo, real index and cache,
// fake clock and timers. Saves are pages the user saved (R10); nothing touches scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex, marketCategoryOf, type MarketIndex, type MarketIndexDeps } from '../../src/service/domain/market';
import { bankStockSpecialKey, marketNewSideMatches } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { emptyMarketCounts } from '../../src/shared/market';
import type { BankStockStored, Listing, MarketQuery, MarketRow, ScraptfBank, Settings, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, silentLogger } from './helpers';

const HOUR = 60 * MIN;

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
});

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows);
  return id;
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  settings: { current: Settings };
  market: MarketIndex;
  stock: BankStock;
  build(): void;
  rows(q?: MarketQuery): MarketRow[];
  row(sku: string): MarketRow | undefined;
}

/** `dep`: what the index reads for F17 (undefined: the real cache, as core wires it; null: none, as in 0.5). */
function setup(dep?: MarketIndexDeps['bankStock'] | null): Harness {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, {}) };
  const schema = createStubSchema();
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now());
  let stock!: BankStock;
  const wired: MarketIndexDeps['bankStock'] = dep === undefined ? { newAtFor: (b) => stock.newAtFor(b), version: () => stock.version() } : (dep ?? undefined);
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings.current),
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    ...(wired ? { bankStock: wired } : {}),
  });
  stock = createBankStock({
    clock,
    log: silentLogger,
    repo,
    market,
    keyPrice,
    settings: () => settings.current,
    categoryOf: (sku) => marketCategoryOf(schema, sku),
  });
  return {
    repo,
    clock,
    settings,
    market,
    stock,
    build() {
      market.start();
      timers.advance(0);
      expect(market.stats().building).toBe(false);
    },
    rows: (q = {}) => market.all(q, clock.now()),
    row: (sku) => market.all({}, clock.now()).find((r) => r.sku === sku),
  };
}

/** Buyers for three hats and a rocket launcher; hats saved 3 h and 10 min ago (Team Captain is new). */
function seed(repo: Repo): void {
  repo.upsertListings([
    ...['a', 'b', 'c'].map((x, i) => buy('378;6', 120 - i, { id: `tc-${x}`, steamid: `TC${x}` })),
    buy('126;6', 60, { id: 'bh', steamid: 'BH' }),
    buy('205;6', 45, { id: 'rl', steamid: 'RL' }),
    buy('205;6', 44, { id: 'rl2', steamid: 'RL2', isBot: true }),
  ]);
  save(repo, 'hats', T0 - 3 * HOUR, [s('126;6', 30)]);
  save(repo, 'hats', T0 - 10 * MIN, [s('126;6', 30), s('378;6', 40), s('378;6', 90, { specialKey: bankStockSpecialKey({ paint: 15185211 }) })]);
}

describe('MarketRow.scraptfNewAt (F17)', () => {
  it('is the save a base SKU is new in, joined per read; null otherwise', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    expect(h.row('378;6')!.scraptfNewAt).toBe(T0 - 10 * MIN);
    expect(h.row('126;6')!.scraptfNewAt).toBeNull();
    expect(h.row('205;6')!.scraptfNewAt).toBeNull();
    // list() pages carry it as all() does.
    expect(h.market.list({ limit: 1 }, T0).rows[0]!.scraptfNewAt).toBe(h.rows()[0]!.scraptfNewAt);
  });

  it('shows a new save on the next read once the cache refreshed, without a rebuild', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    expect(h.row('205;6')!.scraptfNewAt).toBeNull();
    const fullAt = h.market.stats().lastFullAt;
    save(h.repo, 'weapons', T0 - 3 * HOUR, [s('45;6', 3)]);
    save(h.repo, 'weapons', T0 - MIN, [s('45;6', 3), s('205;6', 20)]);
    h.stock.refresh();
    expect(h.row('205;6')!.scraptfNewAt).toBe(T0 - MIN);
    expect(h.market.stats().lastFullAt).toBe(fullAt);
  });

  it('reads no row as new without the bank stock (0.5 wiring), or when it fails', () => {
    const none = setup(null);
    seed(none.repo);
    none.build();
    expect(none.rows().every((r) => r.scraptfNewAt === null)).toBe(true);
    expect(none.rows({ newOnScraptf: true })).toEqual([]);
    const broken = setup({
      newAtFor: () => {
        throw new Error('boom');
      },
      version: () => {
        throw new Error('boom');
      },
    });
    seed(broken.repo);
    broken.build();
    expect(broken.rows().every((r) => r.scraptfNewAt === null)).toBe(true);
    expect(broken.market.list({ newOnScraptf: true }, T0).total).toBe(0);
  });
});

describe('MarketQuery.newOnScraptf ("New on scrap.tf")', () => {
  it('keeps only new rows, and counts verdicts over them, as the shared rule says', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    const all = h.rows();
    const only = h.market.list({ newOnScraptf: true }, T0);
    expect(only.rows.map((r) => r.sku)).toEqual(['378;6']);
    expect(only.rows.map((r) => r.sku)).toEqual(all.filter((r) => marketNewSideMatches(r, { newOnScraptf: true })).map((r) => r.sku));
    expect(only.total).toBe(1);
    expect(only.counts).toEqual({ ...emptyMarketCounts(), [only.rows[0]!.verdict]: 1 });
    // false is no filter.
    expect(h.market.list({ newOnScraptf: false }, T0).total).toBe(all.length);
    // It combines with the other filters.
    expect(h.rows({ newOnScraptf: true, categories: ['weapons'] })).toEqual([]);
  });

  it('re-filters its cached pass after a bank stock refresh, and only then', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    expect(h.rows({ newOnScraptf: true }).map((r) => r.sku)).toEqual(['378;6']);
    save(h.repo, 'weapons', T0 - 3 * HOUR, [s('45;6', 3)]);
    save(h.repo, 'weapons', T0 - MIN, [s('45;6', 3), s('205;6', 20)]);
    // Not refreshed: the cache (and so the pass keyed on its version) still says the old.
    expect(h.rows({ newOnScraptf: true }).map((r) => r.sku)).toEqual(['378;6']);
    h.stock.refresh();
    expect(h.rows({ newOnScraptf: true }).map((r) => r.sku).sort()).toEqual(['205;6', '378;6']);
  });
});

describe('bank stock rows read the Live market', () => {
  it('carry exactly the market row’s revenue, Pay up to, buyers, order and confidence (clean copy for extras)', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    const rows = h.stock.list({ bank: 'hats' }, T0).rows;
    expect(rows.map((r) => r.key).sort()).toEqual(['126;6|', '378;6|', `378;6|${bankStockSpecialKey({ paint: 15185211 })}`].sort());
    for (const r of rows) {
      const m = h.row(r.sku)!;
      expect(m).toBeDefined();
      expect({
        revenueScrap: r.revenueScrap,
        maxCostScrap: r.maxCostScrap,
        buyerCount: r.buyerCount,
        revenueOrder: r.revenueOrder,
        confidence: r.confidence,
        confidenceLevel: r.confidenceLevel,
        category: r.category,
      }).toEqual({
        revenueScrap: m.revenueScrap,
        maxCostScrap: m.maxCostScrap,
        buyerCount: m.buyerCount,
        revenueOrder: m.revenueOrder,
        confidence: m.confidence,
        confidenceLevel: m.confidenceLevel,
        category: m.category,
      });
      expect(r.revenueScrap).not.toBeNull();
      // profit = revenue - cost - friction, judged like a flip on the market.
      expect(r.profitScrap).toBe(m.revenueScrap! - r.costScrap);
      expect(r.verdict).toBe(r.costScrap <= m.maxCostScrap! ? 'flip' : 'over');
    }
    expect(rows.find((r) => r.hasExtras)!.costScrap).toBe(90);
  });

  it('reads them with no query per row once loaded (only the key price, once per call)', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    h.stock.list({ bank: 'hats' }, T0);
    const calls: string[] = [];
    // Every repo method, counted (the repo is a plain object of functions).
    const methods = h.repo as unknown as Record<string, unknown>;
    for (const k of Object.keys(methods)) {
      const v = methods[k];
      if (typeof v !== 'function') continue;
      methods[k] = (...args: unknown[]) => {
        calls.push(k);
        return (v as (...a: unknown[]) => unknown).apply(h.repo, args);
      };
    }
    for (const filter of ['all', 'new', 'flips', 'changed', 'gone'] as const) h.stock.list({ bank: 'hats', filter }, T0);
    h.stock.all({ bank: 'hats', sort: 'payUpTo' }, T0);
    h.stock.whatsNew('hats');
    h.stock.detailFor('378;6;p15185211');
    // The test's key price reads its quotes (core's engine.keyPrice() does too): one read per call, not per row.
    expect(calls.filter((c) => c !== 'keyQuotes')).toEqual([]);
    expect(calls.length).toBeGreaterThan(0); // the spies do see the repo
    expect(calls.length).toBeLessThanOrEqual(8);
  });
});
