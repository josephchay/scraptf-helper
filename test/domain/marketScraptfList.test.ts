// F14 in the Live market index: every row joins the user's saved scrap.tf/items
// price list (pays, stock, limit, full, saved at) at the read's key price, the
// coverage strip gains its "All items" chip, the "On scrap.tf's list" filter
// narrows rows and verdict counts like the mock's shared rule, and a list price
// always beats a rule estimate in the verdict (S5). Real in-memory repo and list
// cache, fake clock and timers. The list only ever comes from pages the user
// saved; nothing here touches scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { MARKET_DIRTY_BATCH_MS, createMarketIndex, type MarketIndex, type MarketIndexDeps } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import { valueScrap } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import { emptyMarketCounts, marketVerdict } from '../../src/shared/market';
import { SCRAPTF_LIST_LABEL, marketListFields, marketListSideMatches } from '../../src/shared/scraptfList';
import type { Listing, MarketQuery, MarketRow, Settings, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, silentLogger } from './helpers';

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

/** One row of a saved scrap.tf/items page. */
interface ListItem {
  sku: string;
  name: string;
  sells: number | null;
  pays: number | null;
  stock: number | null;
  limit: number | null;
  sellsKeys?: number;
  paysKeys?: number;
}

/**
 * What importSavedPage stores for a saved /items page: an 'items-list' batch, a list row for every item
 * (in stock or not), and the existing import price for the in-stock ones. Returns the batch id.
 */
function saveList(repo: Repo, items: readonly ListItem[], at: UnixMs, fileName = 'items.html'): number {
  const batchId = repo.createImportBatch({ fileName, pageKind: 'items-list', fileMtime: at, importedAt: at, itemCount: items.length, categories: null });
  repo.upsertScraptfList(
    items.map((i) => ({
      sku: i.sku,
      name: i.name,
      sellsKeys: i.sells === null ? null : (i.sellsKeys ?? 0),
      sellsScrap: i.sells,
      paysKeys: i.pays === null ? null : (i.paysKeys ?? 0),
      paysScrap: i.pays,
      stock: i.stock,
      stockLimit: i.limit,
      batchId,
      observedAt: at,
    })),
  );
  for (const i of items) {
    if (i.sells === null || !(typeof i.stock === 'number' && i.stock > 0)) continue;
    repo.upsertScrapPrice({ sku: i.sku, name: i.name, costKeys: i.sellsKeys ?? 0, costScrap: i.sells, source: 'import', observedAt: at, importBatch: batchId, stock: i.stock });
  }
  return batchId;
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  timers: FakeTimers;
  settings: { current: Settings };
  list: ScraptfListCache;
  market: MarketIndex;
  changes: number[];
  K(): number;
  /** Starts the index and runs its first build. */
  build(): void;
  rows(q?: MarketQuery): MarketRow[];
  row(sku: string): MarketRow | undefined;
}

/** `dep` replaces the list the index reads (null: no list dependency at all, as in 0.3). */
function setup(opts: { repo?: Repo; dep?: MarketIndexDeps['scraptfList'] | null } = {}): Harness {
  const repo = opts.repo ?? newRepo();
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, {}) };
  const changes: number[] = [];
  let list!: ScraptfListCache;
  // As core wires it: the key price reads the list's key row, the list values rows at the key price.
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now(), list.keyRow());
  list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
  const dep = opts.dep === undefined ? list : (opts.dep ?? undefined);
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings.current),
    schema: createStubSchema(),
    timers,
    keyPrice,
    onChanged: (p) => changes.push(p.changed),
    folderWatchActive: () => false,
    ...(dep ? { scraptfList: dep } : {}),
    // 0.7.3: a constant slice clock keeps each build one slice (MARKET_SLICE_MS is wall-clock time
    // otherwise), so the fake clock alone decides the change pushes.
    sliceNow: () => 0,
  });
  return {
    repo,
    clock,
    timers,
    settings,
    list,
    market,
    changes,
    K: () => keyPrice().valueScrap,
    build() {
      market.start();
      timers.advance(0);
      expect(market.stats().building).toBe(false);
    },
    rows: (q = {}) => market.all(q, clock.now()),
    row: (sku) => market.all({}, clock.now()).find((r) => r.sku === sku),
  };
}

const LIST_FIELDS = ['scraptfPaysScrap', 'scraptfStock', 'scraptfStockLimit', 'scraptfFull', 'scraptfListAt'] as const;
const listPart = (r: MarketRow) => Object.fromEntries(LIST_FIELDS.map((f) => [f, r[f]]));
const NONE = { scraptfPaysScrap: null, scraptfStock: null, scraptfStockLimit: null, scraptfFull: false, scraptfListAt: null };

/** Team Captain and Bill's Hat with buyers, a Rocket Launcher with buyers but not on the list, a known-only taunt. */
function seedMarket(repo: Repo): void {
  repo.upsertListings([
    ...['a', 'b', 'c'].map((s, i) => buy('378;6', 120 - i, { id: `tc-${s}`, steamid: `TC${s}` })),
    buy('126;6', 60, { id: 'bh', steamid: 'BH' }),
    buy('205;6', 60, { id: 'rl', steamid: 'RL' }),
  ]);
  repo.upsertScrapPrice({ sku: '30920;6', name: 'Taunt: The Bunnyhopper', costScrap: 200, source: 'user', observedAt: T0 - 2 * MIN });
}

const SAVED: ListItem[] = [
  { sku: '378;6', name: 'Team Captain', sells: 90, pays: 75, stock: 2, limit: 5 },
  // Priced in keys on the list: valued at the read's key price. At its limit: scrap.tf buys no more.
  { sku: '126;6', name: "Bill's Hat", sells: 5, sellsKeys: 1, pays: 0, paysKeys: 1, stock: 5, limit: 5 },
  // Out of stock: still on the list (scrap.tf still buys it), but no import price.
  { sku: '30920;6', name: 'Taunt: The Bunnyhopper', sells: 210, pays: 180, stock: 0, limit: 3 },
];

describe('Live market rows join the saved scrap.tf list (F14)', () => {
  it('carries each base SKU’s list fields at the read’s key price, exactly as marketListFields reads the cache', () => {
    const h = setup();
    seedMarket(h.repo);
    saveList(h.repo, SAVED, T0 - 3 * MIN);
    h.build();
    const K = h.K();

    expect(listPart(h.row('378;6')!)).toEqual({ scraptfPaysScrap: 75, scraptfStock: 2, scraptfStockLimit: 5, scraptfFull: false, scraptfListAt: T0 - 3 * MIN });
    expect(listPart(h.row('126;6')!)).toEqual({ scraptfPaysScrap: K, scraptfStock: 5, scraptfStockLimit: 5, scraptfFull: true, scraptfListAt: T0 - 3 * MIN });
    // A row without a list row reads none of it.
    expect(listPart(h.row('205;6')!)).toEqual(NONE);
    // A known-only row (no buyers) joins the list too; out of stock is still on the list.
    expect(h.row('30920;6')).toMatchObject({ verdict: 'no-buyers', scraptfPaysScrap: 180, scraptfStock: 0, scraptfStockLimit: 3, scraptfFull: false });

    // Parity: every row is the shared rule over the cache's own row at the same key price.
    // 0.7.4: and the family flag of an unmarked row (stored without craftability here) rides along.
    for (const r of h.rows()) {
      const fields = marketListFields(h.list.rowFor(r.sku, K));
      expect(listPart(r)).toEqual(Object.fromEntries(LIST_FIELDS.map((f) => [f, fields[f]])));
      expect(r.scraptfListFamily).toBe(fields.scraptfListFamily);
    }
    // list() pages carry the same fields as all().
    expect(h.market.list({ limit: 2, offset: 1 }, T0).rows.map(listPart)).toEqual(h.rows().slice(1, 3).map(listPart));
  });

  it('values a key-priced list price at the key price of each read', () => {
    const h = setup();
    seedMarket(h.repo);
    saveList(h.repo, SAVED, T0 - 3 * MIN);
    h.build();
    expect(h.row('126;6')!.scraptfPaysScrap).toBe(h.K());

    // The key price moves (core would also call keyPriceChanged; the read's own K is enough).
    h.repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 600, sellScrap: 603, observedAt: T0 });
    const K2 = h.K();
    expect(K2).not.toBe(567);
    expect(h.row('126;6')!.scraptfPaysScrap).toBe(valueScrap(1, 0, K2));
    expect(h.row('378;6')!.scraptfPaysScrap).toBe(75);
  });

  it('shows a newly saved list on the next read, without a rebuild or a change push', () => {
    const h = setup();
    seedMarket(h.repo);
    h.build();
    expect(h.rows().map(listPart)).toEqual(h.rows().map(() => NONE));
    const pushes = h.changes.length;
    const fullAt = h.market.stats().lastFullAt;

    saveList(h.repo, SAVED, T0 - MIN);
    h.list.refresh();
    h.market.pricesChanged();
    expect(h.row('378;6')).toMatchObject({ scraptfPaysScrap: 75, scraptfListAt: T0 - MIN });
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(h.changes.length).toBe(pushes);
    expect(h.market.stats().lastFullAt).toBe(fullAt);
  });

  it('reads no list data through a failing list, and never fails the read', () => {
    const boom = () => {
      throw new Error('list read failed');
    };
    const h = setup({ dep: { rowFor: boom, has: boom, summary: boom, version: boom } });
    seedMarket(h.repo);
    h.build();
    const r = h.market.list({}, T0);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(listPart(row)).toEqual(NONE);
    expect(r.scraptf.allItems).toEqual({ label: SCRAPTF_LIST_LABEL, url: SCRAPTF_ITEMS_URL, lastSavedAt: null, items: 0 });
    expect(h.market.list({ onScraptfList: true }, T0)).toMatchObject({ rows: [], total: 0, counts: emptyMarketCounts() });
  });

  it('works without a list dependency, as in 0.3', () => {
    const h = setup({ dep: null });
    seedMarket(h.repo);
    saveList(h.repo, SAVED, T0 - MIN);
    h.build();
    for (const r of h.rows()) expect(listPart(r)).toEqual(NONE);
    expect(h.market.list({}, T0).scraptf.allItems).toMatchObject({ lastSavedAt: null, items: 0 });
    expect(h.market.list({ onScraptfList: true }, T0).total).toBe(0);
  });
});

describe('the "All items" chip (F14)', () => {
  it('reports the newest list save and the rows stored, and never counts the list for a bank page', () => {
    const h = setup();
    seedMarket(h.repo);
    h.build();
    expect(h.market.list({}, T0).scraptf.allItems).toEqual({ label: 'All items', url: SCRAPTF_ITEMS_URL, lastSavedAt: null, items: 0 });

    saveList(h.repo, SAVED, T0 - 30 * MIN, 'items.html');
    // A second page of the list (/items/2), saved later: the lists merge by SKU.
    saveList(h.repo, [{ sku: '205;6', name: 'Rocket Launcher', sells: 20, pays: 16, stock: 1, limit: 8 }], T0 - 2 * MIN, 'items_2.html');
    h.list.refresh();
    h.market.pricesChanged();
    const r = h.market.list({}, T0);
    expect(r.scraptf.allItems).toEqual({ label: 'All items', url: SCRAPTF_ITEMS_URL, lastSavedAt: T0 - 2 * MIN, items: 4 });
    // The bank-page strip (F13) is unchanged: an items-list batch counts for no bank page.
    expect(r.scraptf.coverage.every((c) => c.lastSavedAt === null && c.items === 0)).toBe(true);
    // The "pages" count is the saved-page prices behind the rows (in-stock list rows), as before.
    expect(r.scraptf.pages).toBe(3);
  });
});

describe('the "On scrap.tf\'s list" filter (F14)', () => {
  function seeded(): Harness {
    const h = setup();
    seedMarket(h.repo);
    h.repo.upsertRule({ name: 'Weapons', filter: { categories: ['weapons'] }, costScrap: 20, observedAt: T0 });
    saveList(h.repo, SAVED, T0 - 3 * MIN);
    h.build();
    return h;
  }

  it('keeps only rows on the list, matching the shared rule over the unfiltered rows, order kept', () => {
    const h = seeded();
    const all = h.rows();
    const listed = h.rows({ onScraptfList: true });
    expect(listed.map((r) => r.sku).sort()).toEqual(['126;6', '30920;6', '378;6']);
    expect(listed.map((r) => r.sku)).toEqual(all.filter((r) => marketListSideMatches(r, { onScraptfList: true })).map((r) => r.sku));
    // Off (or false) filters nothing.
    expect(h.rows({ onScraptfList: false }).map((r) => r.sku)).toEqual(all.map((r) => r.sku));
  });

  it('narrows the verdict counts like a buy-side filter, while a verdict filter still counts every verdict', () => {
    const h = seeded();
    const res = h.market.list({ onScraptfList: true }, T0);
    const expected = emptyMarketCounts();
    for (const r of res.rows) expected[r.verdict]++;
    expect(res.counts).toEqual(expected);
    // 205;6 (rule-flip) is not on the list, so its verdict is not counted.
    expect(res.counts['rule-flip']).toBe(0);
    expect(h.market.list({}, T0).counts['rule-flip']).toBe(1);

    const flips = h.market.list({ onScraptfList: true, verdicts: ['no-buyers'] }, T0);
    expect(flips.rows.map((r) => r.sku)).toEqual(['30920;6']);
    expect(flips.counts).toEqual(res.counts);
  });

  it('re-filters once a new list is saved, and asks the list once per base until it changes', () => {
    const repo = newRepo();
    seedMarket(repo);
    saveList(repo, SAVED, T0 - 3 * MIN);
    let real!: ScraptfListCache;
    const asked: string[] = [];
    const dep: MarketIndexDeps['scraptfList'] = {
      rowFor: (sku, k) => real.rowFor(sku, k),
      has: (sku) => {
        asked.push(sku);
        return real.has(sku);
      },
      summary: () => real.summary(),
      version: () => real.version(),
    };
    const h = setup({ repo, dep });
    real = h.list;
    h.build();

    // An unfiltered read never asks.
    h.market.list({}, T0);
    expect(asked).toEqual([]);

    expect(h.market.list({ onScraptfList: true }, T0).total).toBe(3);
    const first = asked.length;
    expect(first).toBe(4); // every row once: 378;6, 126;6, 205;6 and the known-only 30920;6

    // A book change drops the cached pass; membership is remembered.
    repo.upsertListings([buy('378;6', 121, { id: 'tc-d', steamid: 'TCd' })]);
    h.market.markDirty(['378;6']);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(h.market.list({ onScraptfList: true }, T0).total).toBe(3);
    expect(asked.length).toBe(first);

    // A new save puts the Rocket Launcher on the list: the same query re-filters at once.
    saveList(repo, [{ sku: '205;6', name: 'Rocket Launcher', sells: 20, pays: 16, stock: 1, limit: 8 }], T0 - MIN, 'items_2.html');
    h.list.refresh();
    const after = h.market.list({ onScraptfList: true }, T0);
    expect(after.rows.map((r) => r.sku).sort()).toEqual(['126;6', '205;6', '30920;6', '378;6']);
    expect(asked.length).toBeGreaterThan(first);
  });
});

describe('S5: a saved list price beats a rule estimate in the verdict', () => {
  it('judges an in-stock list item on its list price (an import price), never on a cheaper rule', () => {
    const repo = newRepo();
    repo.upsertListings([
      ...['a', 'b', 'c'].map((s, i) => buy('378;6', 120 - i, { id: `tc-${s}`, steamid: `TC${s}` })),
      ...['a', 'b'].map((s, i) => buy('126;6', 60 - i, { id: `bh-${s}`, steamid: `BH${s}` })),
      buy('205;6', 60, { id: 'rl', steamid: 'RL' }),
      buy('15000;6', 80, { id: 'sr', steamid: 'SR' }),
    ]);
    // A rule cheap enough to call every item a rule-flip.
    repo.upsertRule({ name: 'Everything', filter: {}, costScrap: 5, observedAt: T0 });
    const h = setup({ repo });
    h.build();
    for (const sku of ['378;6', '126;6', '205;6', '15000;6']) expect(h.row(sku)).toMatchObject({ verdict: 'rule-flip', ruleCostScrap: 5, knownSource: 'none' });

    saveList(
      repo,
      [
        // Above the ceiling: 'over', even though the rule (5) is under it.
        { sku: '378;6', name: 'Team Captain', sells: 300, pays: 250, stock: 1, limit: 5 },
        // Under the ceiling: 'flip' on the list price.
        { sku: '126;6', name: "Bill's Hat", sells: 30, pays: 25, stock: 4, limit: 10 },
        // Out of stock: nothing to buy, so no import price; the row still shows the list's stock.
        { sku: '205;6', name: 'Rocket Launcher', sells: 40, pays: 30, stock: 0, limit: 5 },
      ],
      T0 - 5 * MIN,
    );
    h.list.refresh();
    h.market.pricesChanged();

    const tc = h.row('378;6')!;
    expect(tc).toMatchObject({ knownSource: 'page', knownCostScrap: 300, stock: 1, ruleCostScrap: 5, verdict: 'over' });
    expect(tc.maxCostScrap).not.toBeNull();
    expect(tc.maxCostScrap!).toBeLessThan(300);
    expect(tc.maxCostScrap!).toBeGreaterThanOrEqual(5);
    expect(h.row('126;6')).toMatchObject({ knownSource: 'page', knownCostScrap: 30, verdict: 'flip', scraptfStock: 4 });
    expect(h.row('205;6')).toMatchObject({ knownSource: 'none', scraptfStock: 0, scraptfPaysScrap: 30, verdict: 'rule-flip' });
    // Not on the list at all: unchanged.
    expect(h.row('15000;6')).toMatchObject({ knownSource: 'none', verdict: 'rule-flip', scraptfListAt: null });

    for (const r of h.rows()) {
      expect(r.verdict).toBe(marketVerdict(r));
      // A known price is never a rule-flip, and an in-stock list row is always a known price.
      if (r.knownCostScrap !== null) expect(r.verdict).not.toBe('rule-flip');
      if (r.scraptfListAt !== null && (r.scraptfStock ?? 0) > 0) expect(r.knownCostScrap).not.toBeNull();
    }
    // The verdict filter agrees.
    expect(h.rows({ verdicts: ['rule-flip'] }).map((r) => r.sku).sort()).toEqual(['15000;6', '205;6']);
  });

  it('a newer typed price still wins over an older saved list, and a newer list over an older typed price', () => {
    const repo = newRepo();
    repo.upsertListings(['a', 'b', 'c'].map((s, i) => buy('378;6', 120 - i, { id: `tc-${s}`, steamid: `TC${s}` })));
    repo.upsertRule({ name: 'Everything', filter: {}, costScrap: 5, observedAt: T0 });
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 70, source: 'user', observedAt: T0 - HOUR });
    const h = setup({ repo });
    saveList(repo, [{ sku: '378;6', name: 'Team Captain', sells: 80, pays: 66, stock: 2, limit: 5 }], T0 - 10 * MIN);
    h.build();
    expect(h.row('378;6')).toMatchObject({ knownSource: 'page', knownCostScrap: 80 });
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 75, source: 'user', observedAt: T0 - MIN });
    h.market.pricesChanged();
    expect(h.row('378;6')).toMatchObject({ knownSource: 'typed', knownCostScrap: 75, scraptfPaysScrap: 66 });
    expect(h.row('378;6')!.verdict).not.toBe('rule-flip');
  });
});
