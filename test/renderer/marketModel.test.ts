// F10 Live market page model (src/renderer/marketModel.ts): persisted filters,
// the 'market.list' query and its loaded window, the window's request races
// (new query, live refresh, Load more, unmount) against a fake list, labels and
// verdict pills, the header strip, flash diffing and scroll anchoring. The last
// block drives the browser mock with the model's own queries, so the page's
// requests are ones the service contract accepts. No network: the mock is in memory.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import {
  BOUNDARY_NOTE,
  COVERAGE_AGING_MS,
  COVERAGE_FRESH_MS,
  COVERAGE_TIP,
  DEFAULT_MARKET_FILTERS,
  DEFAULT_MARKET_SORT,
  MARKET_BANK_ROUTE,
  MARKET_PAGE,
  MARKET_WINDOW_MAX,
  MAX_MIN_BUYERS,
  MORE_ROW_ID,
  PULSE_WINDOW_MS,
  SORT_LABELS,
  SOURCE_LABELS,
  VERDICT_HELP,
  VERDICT_LABELS,
  VERDICT_TONES,
  activeMarketFilterCount,
  addPulse,
  anchoredScrollTop,
  appendMarketRows,
  buildPercent,
  coverageBank,
  coverageChip,
  coverageChips,
  coverageTone,
  createMarketWindow,
  defaultMarketDir,
  defaultMarketFilters,
  diffFlash,
  emptyMarketReason,
  indexStateText,
  lastChangeText,
  liveRateText,
  marketDisplayRows,
  marketErrorText,
  marketExportQuery,
  marketBankPath,
  marketListParams,
  marketLiveState,
  marketPayTitle,
  marketPollMs,
  marketQuery,
  marketRouteIntent,
  marketSellsForTitle,
  marketWindowQuery,
  nextPageRequest,
  pulseRate,
  readMinBuyers,
  readMinPrice,
  sanitizeMarketFilters,
  sanitizeMarketSort,
  scraptfSideText,
  snapshotRows,
  toggleMarketSort,
  toggleVerdict,
  verdictPill,
  waitingText,
  windowRequest,
  yourPriceCell,
  type FlashDir,
  type MarketFilters,
  type MarketWindowBusy,
  type MarketWindowData,
  type MarketWindowQuery,
} from '../../src/renderer/marketModel';
import { readMinCeiling } from '../../src/renderer/shoppingModel';
import { SCRAPTF_BANK_PAGES, scraptfLinkFor } from '../../src/shared/links';
import { MARKET_MAX_LIMIT, MARKET_MAX_SEARCH_CHARS, MARKET_SORTS, marketComparator } from '../../src/shared/market';
import { scraptfListCoverage } from '../../src/shared/scraptfList';
import { CATEGORIES, MARKET_SOURCES, MARKET_VERDICTS, type MarketListResult, type MarketQuery, type MarketRow, type MarketStats, type OrderSummary, type ScraptfCoverage } from '../../src/shared/types';

const KEY = 568;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'BuyBot',
    keys: 0,
    metalScrap: 120,
    valueScrap: 120,
    isBot: true,
    online: true,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function row(over: Partial<MarketRow> & { sku: string }): MarketRow {
  return {
    name: 'Team Captain',
    category: 'hats',
    revenueScrap: 120,
    bestScrap: 130,
    consScrap: 120,
    instantScrap: 110,
    revenueOrder: order(),
    buyerCount: 4,
    maxCostScrap: 100,
    confidence: 72,
    confidenceLevel: 'high',
    flags: [],
    knownCostScrap: null,
    knownSource: 'none',
    knownObservedAt: null,
    stock: null,
    ruleCostScrap: null,
    profitScrap: null,
    verdict: 'unchecked',
    lastOrderChangeAt: NOW - MIN,
    evaluatedAt: NOW,
    scraptfPaysScrap: null,
    scraptfStock: null,
    scraptfStockLimit: null,
    scraptfFull: false,
    scraptfListAt: null,
    scraptfNewAt: null,
    scraptfListedSince: null,
    scraptfLink: scraptfLinkFor(over.category ?? 'hats', null),
    ...over,
  };
}

function stats(over: Partial<MarketStats> = {}): MarketStats {
  return { entries: 1234, building: false, progress: 1, lastFullAt: NOW - 4 * MIN, lastChangeAt: NOW - 12_000, pendingDirty: 0, lastError: null, retryAt: null, ...over };
}

function result(rows: MarketRow[], over: Partial<MarketListResult> = {}): MarketListResult {
  return {
    rows,
    total: rows.length,
    counts: { flip: 0, 'rule-flip': 0, unchecked: rows.length, over: 0, 'no-buyers': 0 },
    scraptf: { typed: 0, pages: 0, newestPageAt: null, importEnabled: false, watchFolder: false, coverage: [], allItems: scraptfListCoverage(null) },
    stats: stats(),
    keyPrice: null,
    generatedAt: NOW,
    ...over,
  };
}

function filters(over: Partial<MarketFilters> = {}): MarketFilters {
  return { ...defaultMarketFilters(), ...over };
}

describe('filters', () => {
  it('starts empty and hands out fresh arrays', () => {
    const a = defaultMarketFilters();
    const b = defaultMarketFilters();
    expect(a).toEqual(DEFAULT_MARKET_FILTERS);
    expect(a.categories).not.toBe(b.categories);
    expect(a.verdicts).not.toBe(DEFAULT_MARKET_FILTERS.verdicts);
    a.verdicts.push('flip');
    expect(DEFAULT_MARKET_FILTERS.verdicts).toEqual([]);
    expect(activeMarketFilterCount(a)).toBe(1);
  });

  it('restores persisted filters defensively, in the canonical order', () => {
    expect(sanitizeMarketFilters(null)).toEqual(DEFAULT_MARKET_FILTERS);
    expect(sanitizeMarketFilters('junk')).toEqual(DEFAULT_MARKET_FILTERS);
    const s = sanitizeMarketFilters({
      search: 'x'.repeat(500),
      categories: ['taunts', 'hats', 'nope', 'hats'],
      verdicts: ['over', 'flip', 'bogus', 'flip'],
      sources: ['none', 'page', 'web'],
      minCeiling: '1 key'.padEnd(80, ' '),
      onlyBotBuyers: 'yes',
      minBuyers: 7.9,
      onScraptfList: 1,
    });
    expect(s.search).toHaveLength(MARKET_MAX_SEARCH_CHARS);
    expect(s.categories).toEqual(['hats', 'taunts']);
    expect(s.verdicts).toEqual(['flip', 'over']);
    expect(s.sources).toEqual(['page', 'none']);
    expect(s.minCeiling.length).toBeLessThanOrEqual(40);
    expect(s.onlyBotBuyers).toBe(false);
    expect(s.minBuyers).toBe(7);
    expect(s.onScraptfList).toBe(false);
    expect(sanitizeMarketFilters({ onScraptfList: true }).onScraptfList).toBe(true);
    expect(sanitizeMarketFilters({ minBuyers: -3 }).minBuyers).toBe(0);
    expect(sanitizeMarketFilters({ minBuyers: 1e9 }).minBuyers).toBe(MAX_MIN_BUYERS);
    expect(sanitizeMarketFilters({ minBuyers: Number.NaN }).minBuyers).toBe(0);
  });

  it('counts each active filter once', () => {
    expect(activeMarketFilterCount(filters())).toBe(0);
    expect(activeMarketFilterCount(filters({ search: '   ' }))).toBe(0);
    expect(
      activeMarketFilterCount(
        filters({ search: 'hat', categories: ['hats', 'taunts'], verdicts: ['flip'], sources: ['page'], minCeiling: '2 ref', onlyBotBuyers: true, minBuyers: 3, onScraptfList: true }),
      ),
    ).toBe(8);
  });

  it('toggles verdict chips in chip order', () => {
    expect(toggleVerdict([], 'over')).toEqual(['over']);
    expect(toggleVerdict(['over'], 'flip')).toEqual(['flip', 'over']);
    expect(toggleVerdict(['flip', 'over'], 'flip')).toEqual(['over']);
    expect(toggleVerdict(['no-buyers', 'flip'], 'unchecked')).toEqual(['flip', 'unchecked', 'no-buyers']);
  });

  it('reads the minimum-buyers box', () => {
    expect(readMinBuyers('')).toBe(0);
    expect(readMinBuyers('  5 ')).toBe(5);
    expect(readMinBuyers('2.9')).toBe(2);
    expect(readMinBuyers('-4')).toBe(0);
    expect(readMinBuyers('abc')).toBe(0);
    expect(readMinBuyers('99999999')).toBe(MAX_MIN_BUYERS);
  });
});

describe('sort', () => {
  it('defaults to Pay up to, highest first; name reads A to Z', () => {
    expect(DEFAULT_MARKET_SORT).toEqual({ sort: 'ceiling', dir: 'desc' });
    expect(defaultMarketDir('name')).toBe('asc');
    for (const s of MARKET_SORTS) if (s !== 'name') expect(defaultMarketDir(s)).toBe('desc');
    expect(Object.keys(SORT_LABELS).sort()).toEqual([...MARKET_SORTS].sort());
  });

  it('restores a persisted sort and flips on a second header click', () => {
    expect(sanitizeMarketSort(undefined)).toEqual({ sort: 'ceiling', dir: 'desc' });
    expect(sanitizeMarketSort({ sort: 'margin', dir: 'up' })).toEqual({ sort: 'ceiling', dir: 'desc' });
    expect(sanitizeMarketSort({ sort: 'name' })).toEqual({ sort: 'name', dir: 'asc' });
    expect(sanitizeMarketSort({ sort: 'buyers', dir: 'asc' })).toEqual({ sort: 'buyers', dir: 'asc' });
    expect(toggleMarketSort({ sort: 'ceiling', dir: 'desc' }, 'ceiling')).toEqual({ sort: 'ceiling', dir: 'asc' });
    expect(toggleMarketSort({ sort: 'ceiling', dir: 'asc' }, 'name')).toEqual({ sort: 'name', dir: 'asc' });
    expect(toggleMarketSort({ sort: 'name', dir: 'asc' }, 'updated')).toEqual({ sort: 'updated', dir: 'desc' });
  });
});

describe('query building', () => {
  it('sends only the sort when nothing is filtered', () => {
    expect(marketQuery(filters(), null, DEFAULT_MARKET_SORT)).toEqual({ sort: 'ceiling', dir: 'desc' });
  });

  it('maps every filter, trimmed, ordered and within the service bounds', () => {
    const f = filters({
      search: `  team   captain  `,
      categories: ['taunts', 'hats'],
      verdicts: ['over', 'flip'],
      sources: ['none', 'page'],
      onlyBotBuyers: true,
      minBuyers: 3,
      onScraptfList: true,
    });
    expect(marketQuery(f, 90.4, { sort: 'buyers', dir: 'asc' })).toEqual({
      sort: 'buyers',
      dir: 'asc',
      search: 'team   captain',
      categories: ['hats', 'taunts'],
      verdicts: ['flip', 'over'],
      sources: ['page', 'none'],
      minCeilingScrap: 90,
      onlyBotBuyers: true,
      minBuyers: 3,
      onScraptfList: true,
    });
    const long = marketQuery(filters({ search: 'y'.repeat(400) }), null, DEFAULT_MARKET_SORT);
    expect(long.search).toHaveLength(MARKET_MAX_SEARCH_CHARS);
  });

  it('leaves out a zero or missing minimum and a zero buyer floor', () => {
    expect(marketQuery(filters({ minBuyers: 0 }), 0, DEFAULT_MARKET_SORT)).not.toHaveProperty('minCeilingScrap');
    expect(marketQuery(filters(), null, DEFAULT_MARKET_SORT)).not.toHaveProperty('minBuyers');
    expect(marketQuery(filters({ onScraptfList: false }), null, DEFAULT_MARKET_SORT)).not.toHaveProperty('onScraptfList');
    expect(marketQuery(filters(), Number.NaN, DEFAULT_MARKET_SORT)).not.toHaveProperty('minCeilingScrap');
  });

  it('turns the typed minimum into scrap with the shared reader', () => {
    expect(marketQuery(filters(), readMinCeiling('1 key', KEY).scrap, DEFAULT_MARKET_SORT).minCeilingScrap).toBe(KEY);
    expect(marketQuery(filters(), readMinCeiling('2 ref', KEY).scrap, DEFAULT_MARKET_SORT).minCeilingScrap).toBe(18);
    expect(marketQuery(filters(), readMinCeiling('1 key', null).scrap, DEFAULT_MARKET_SORT)).not.toHaveProperty('minCeilingScrap');
  });

  it('exports the same filters without paging', () => {
    const q = { ...marketQuery(filters({ verdicts: ['flip'] }), 50, DEFAULT_MARKET_SORT), limit: 200, offset: 400 };
    expect(marketExportQuery(q)).toEqual({ sort: 'ceiling', dir: 'desc', verdicts: ['flip'], minCeilingScrap: 50 });
  });
});

describe('loaded window', () => {
  it('reloads the whole window in one request (market.list takes up to 2000 rows, H2)', () => {
    expect(MARKET_PAGE).toBe(200);
    expect(windowRequest(200)).toEqual({ limit: 200, offset: 0 });
    expect(windowRequest(600)).toEqual({ limit: 600, offset: 0 });
    // The whole window fits the service's limit, so there is never a second chunk to miss rows between.
    expect(MARKET_MAX_LIMIT).toBe(MARKET_WINDOW_MAX);
    expect(windowRequest(MARKET_WINDOW_MAX + 5000)).toEqual({ limit: MARKET_WINDOW_MAX, offset: 0 });
    expect(windowRequest(0)).toEqual({ limit: 1, offset: 0 });
    expect(windowRequest(Number.NaN)).toEqual({ limit: 200, offset: 0 });
    for (const n of [1, 199, 777, 1999, 2000]) expect(windowRequest(n)).toEqual({ limit: n, offset: 0 });
  });

  it('pages by 200 up to the window cap', () => {
    expect(nextPageRequest(200, 1000)).toEqual({ limit: 200, offset: 200 });
    expect(nextPageRequest(200, 250)).toEqual({ limit: 50, offset: 200 });
    expect(nextPageRequest(250, 250)).toBeNull();
    expect(nextPageRequest(1900, 50_000)).toEqual({ limit: 100, offset: 1900 });
    expect(nextPageRequest(MARKET_WINDOW_MAX, 50_000)).toBeNull();
  });

  it('appends the rows of a fresh read that are not shown, keeping the shown rows as they are', () => {
    const shown = result([row({ sku: 'a', revenueScrap: 1 }), row({ sku: 'b' })], { total: 9, generatedAt: NOW });
    const fresh = result([row({ sku: 'x' }), row({ sku: 'a', revenueScrap: 2 }), row({ sku: 'c' }), row({ sku: 'x' })], { total: 10, generatedAt: NOW + 5 });
    const out = appendMarketRows(shown, fresh);
    expect(out.rows.map((r) => r.sku)).toEqual(['a', 'b', 'x', 'c']);
    expect(out.rows[0]!.revenueScrap).toBe(1); // not re-sorted or re-valued: a live refresh does that
    expect(out.total).toBe(10);
    expect(out.generatedAt).toBe(NOW + 5);
    // Never past the window cap, whatever the two reads disagree on.
    const many = (prefix: string) => result(Array.from({ length: MARKET_WINDOW_MAX }, (_, i) => row({ sku: `${prefix}${i}` })), { total: 9999 });
    expect(appendMarketRows(many('a'), many('b')).rows).toHaveLength(MARKET_WINDOW_MAX);
  });

  it('adds a Load more row while more match, capped at the window', () => {
    const rows = [row({ sku: 'a' }), row({ sku: 'b' })];
    expect(marketDisplayRows(rows, 2).map((r) => r.id)).toEqual(['a', 'b']);
    const more = marketDisplayRows(rows, 9);
    expect(more.at(-1)).toEqual({ type: 'more', id: MORE_ROW_ID, shown: 2, total: 9, capped: false });
    const many = Array.from({ length: MARKET_WINDOW_MAX }, (_, i) => row({ sku: `s${i}` }));
    expect(marketDisplayRows(many, MARKET_WINDOW_MAX + 1).at(-1)).toMatchObject({ type: 'more', capped: true });
  });
});

describe('window requests (createMarketWindow)', () => {
  interface Req {
    q: MarketQuery;
    settled: boolean;
    resolve(r: MarketListResult): void;
    reject(e: unknown): void;
  }

  const A: MarketQuery = { sort: 'ceiling', dir: 'desc' };
  const B: MarketQuery = { sort: 'name', dir: 'asc' };
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  /** A service page for q: `total` rows named `${prefix}${i}`, sliced by limit and offset. */
  function answer(q: MarketQuery, total: number, prefix = 's', over: Partial<MarketRow> = {}): MarketListResult {
    const offset = q.offset ?? 0;
    const end = Math.min(total, offset + (q.limit ?? MARKET_PAGE));
    const rows: MarketRow[] = [];
    for (let i = offset; i < end; i++) rows.push(row({ sku: `${prefix}${i}`, ...over }));
    return result(rows, { total });
  }

  function harness() {
    const reqs: Req[] = [];
    const data: MarketWindowData[] = [];
    const flashes: Map<string, FlashDir>[] = [];
    const errors: string[] = [];
    const moreErrors: string[] = [];
    const busy: MarketWindowBusy[] = [];
    let t = NOW;
    const w = createMarketWindow(
      (q) =>
        new Promise<MarketListResult>((resolve, reject) => {
          const r: Req = { q, settled: false, resolve, reject };
          reqs.push(r);
        }),
      {
        data: (d, f) => {
          data.push(d);
          flashes.push(new Map(f));
        },
        error: (text) => errors.push(text),
        moreError: (text) => moreErrors.push(text),
        busy: (b) => busy.push(b),
      },
      () => ++t,
    );
    const open = () => reqs.filter((r) => !r.settled);
    /** Answers the oldest request still waiting. */
    const next = async (fn: (q: MarketQuery) => MarketListResult | Error) => {
      const r = open()[0];
      if (!r) throw new Error('no request waiting');
      r.settled = true;
      const out = fn(r.q);
      if (out instanceof Error) r.reject(out);
      else r.resolve(out);
      await flush();
    };
    /** Answers every request waiting (the pages of one window read). */
    const all = async (fn: (q: MarketQuery) => MarketListResult | Error) => {
      while (open().length) await next(fn);
    };
    return { w, reqs, data, flashes, errors, moreErrors, busy, open, next, all, last: () => data.at(-1) };
  }

  it('drops the answer to an older query, and ignores the same query twice', async () => {
    const h = harness();
    h.w.setQuery(A);
    h.w.setQuery(B);
    expect(h.reqs.map((r) => r.q.sort)).toEqual(['ceiling', 'name']);
    const [a, b] = h.reqs as [Req, Req];
    b.resolve(answer(b.q, 3, 'b'));
    await flush();
    a.resolve(answer(a.q, 3, 'a'));
    await flush();
    expect(h.data).toHaveLength(1);
    expect(h.last()!.key).toBe(JSON.stringify(B));
    expect(h.last()!.result.rows.map((r) => r.sku)).toEqual(['b0', 'b1', 'b2']);
    expect(h.busy.at(-1)).toBeNull();
    h.w.setQuery({ ...B });
    expect(h.reqs).toHaveLength(2);
  });

  it('lets a live refresh wait for Load more, then re-reads the grown window once', async () => {
    const h = harness();
    h.w.setQuery(A);
    await h.next((q) => answer(q, 1000));
    const first = h.last()!;
    expect(first.result.rows).toHaveLength(MARKET_PAGE);

    h.w.loadMore();
    // The grown window from the top, not an offset page of an order that may have moved.
    expect(h.open()[0]!.q).toMatchObject({ ...A, limit: 400, offset: 0 });
    h.w.refresh();
    h.w.refresh();
    expect(h.open()).toHaveLength(1);
    expect(h.busy.at(-1)).toBe('more');

    await h.next((q) => answer(q, 1000));
    const appended = h.data[1]!;
    expect(appended.result.rows).toHaveLength(400);
    // An appended page is not a full read: the freeze's "waiting" count keys on fetchedAt.
    expect(appended.fetchedAt).toBe(first.fetchedAt);
    expect(h.open()).toHaveLength(1);
    expect(h.open()[0]!.q).toMatchObject({ limit: 400, offset: 0 });

    await h.next((q) => answer(q, 1000));
    expect(h.last()!.result.rows).toHaveLength(400);
    expect(h.last()!.fetchedAt).toBeGreaterThan(first.fetchedAt);
    expect(h.open()).toHaveLength(0);
    expect(h.busy.at(-1)).toBeNull();
  });

  it('runs a Load more asked during a refresh once the refresh lands', async () => {
    const h = harness();
    h.w.setQuery(A);
    await h.next((q) => answer(q, 1000));
    h.w.refresh();
    h.w.loadMore();
    expect(h.open()).toHaveLength(1);
    expect(h.busy.at(-1)).toBe('more');
    await h.next((q) => answer(q, 1000));
    expect(h.open()).toHaveLength(1);
    expect(h.open()[0]!.q).toMatchObject({ limit: 400, offset: 0 });
    await h.next((q) => answer(q, 1000));
    expect(h.last()!.result.rows).toHaveLength(400);
    expect(new Set(h.last()!.result.rows.map((r) => r.sku)).size).toBe(400);
  });

  it('does not extend a new query before its first page lands', async () => {
    const h = harness();
    h.w.setQuery(A);
    await h.next((q) => answer(q, 1000));
    h.w.setQuery(B);
    h.w.loadMore();
    expect(h.busy.at(-1)).toBe('reload');
    await h.next((q) => answer(q, 1000, 'b'));
    expect(h.open()).toHaveLength(0);
    expect(h.last()!.result.rows).toHaveLength(MARKET_PAGE);
    // A queued page is dropped by a new query too.
    h.w.refresh();
    h.w.loadMore();
    h.w.setQuery(A);
    await h.next(() => new Error('superseded'));
    await h.next((q) => answer(q, 1000, 'a'));
    expect(h.open()).toHaveLength(0);
    expect(h.errors).toEqual([]);
    expect(h.last()!.result.rows.map((r) => r.sku).slice(0, 2)).toEqual(['a0', 'a1']);
  });

  it('collapses refreshes asked during a read into one follow-up read', async () => {
    const h = harness();
    h.w.setQuery(A);
    h.w.refresh();
    h.w.refresh();
    h.w.refresh();
    expect(h.reqs).toHaveLength(1);
    await h.next((q) => answer(q, 5));
    expect(h.reqs).toHaveLength(2);
    await h.next((q) => answer(q, 5));
    expect(h.reqs).toHaveLength(2);
    expect(h.data).toHaveLength(2);
  });

  it('re-reads a window over 500 rows in one request (H2)', async () => {
    const h = harness();
    h.w.setQuery(A);
    await h.next((q) => answer(q, 5000));
    for (let i = 0; i < 2; i++) {
      h.w.loadMore();
      await h.all((q) => answer(q, 5000));
    }
    expect(h.last()!.result.rows).toHaveLength(600);
    h.w.refresh();
    expect(h.open().map((r) => [r.q.limit, r.q.offset])).toEqual([[600, 0]]);
    await h.next((q) => answer(q, 5000));
    expect(h.last()!.result.rows.map((r) => r.sku)).toEqual(Array.from({ length: 600 }, (_, i) => `s${i}`));
  });

  it('flashes only what a live refresh of the same query moved', async () => {
    const h = harness();
    h.w.setQuery(A);
    await h.next((q) => answer(q, 3, 's', { maxCostScrap: 100 }));
    expect(h.flashes.at(-1)!.size).toBe(0);
    h.w.refresh();
    await h.next((q) => {
      const r = answer(q, 3, 's', { maxCostScrap: 100 });
      r.rows[1] = { ...r.rows[1]!, maxCostScrap: 104 };
      return r;
    });
    expect([...h.flashes.at(-1)!]).toEqual([['s1', 'up']]);
    // A new query (filters, sort) is a different list, not a change.
    h.w.setQuery(B);
    await h.next((q) => answer(q, 3, 's', { maxCostScrap: 90 }));
    expect(h.flashes.at(-1)!.size).toBe(0);
  });

  it('keeps the rows on a failed read or page, and re-arms', async () => {
    const h = harness();
    h.w.setQuery(A);
    await h.next(() => new Error('service restarting'));
    expect(h.errors).toEqual(['service restarting']);
    expect(h.data).toHaveLength(0);
    h.w.refresh();
    await h.next((q) => answer(q, 1000));
    h.w.loadMore();
    await h.next(() => new Error('timed out'));
    expect(h.moreErrors).toEqual(['Could not load more items: timed out']);
    expect(h.last()!.result.rows).toHaveLength(MARKET_PAGE);
    expect(h.busy.at(-1)).toBeNull();
    h.w.loadMore();
    expect(h.open()[0]!.q).toMatchObject({ limit: 400, offset: 0 });
    await h.next((q) => answer(q, 1000));
    expect(h.last()!.result.rows).toHaveLength(400);
    // A Load more queued behind a read that fails is dropped; the button stays.
    h.w.refresh();
    h.w.loadMore();
    await h.next(() => new Error('down'));
    expect(h.open()).toHaveLength(0);
    expect(h.busy.at(-1)).toBeNull();
  });

  it('sends nothing and reports nothing after dispose', async () => {
    const h = harness();
    h.w.setQuery(A);
    h.w.refresh();
    h.w.dispose();
    await h.next((q) => answer(q, 1000));
    expect(h.data).toHaveLength(0);
    h.w.refresh();
    h.w.loadMore();
    h.w.setQuery(B);
    expect(h.reqs).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it('turns a bridge that throws into an error instead of throwing', () => {
    const errors: string[] = [];
    const w = createMarketWindow(
      () => {
        throw new Error('bridge missing');
      },
      { data: () => undefined, error: (t) => errors.push(t), moreError: () => undefined, busy: () => undefined },
    );
    expect(() => w.setQuery(A)).not.toThrow();
    return flush().then(() => expect(errors).toEqual(['bridge missing']));
  });
});

describe('the window against a live order: Load more, Freeze and the key price', () => {
  const A: MarketQuery = { sort: 'ceiling', dir: 'desc' };
  const B: MarketQuery = { sort: 'name', dir: 'asc' };
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  /** A service whose order the test moves between requests, as the live feed does. */
  function liveService(n: number) {
    const order = Array.from({ length: n }, (_, i) => `s${i}`);
    const sent: MarketQuery[] = [];
    let gate: Promise<void> | null = null;
    const list = async (q: MarketQuery): Promise<MarketListResult> => {
      sent.push(q);
      if (gate) await gate;
      const offset = q.offset ?? 0;
      const limit = q.limit ?? MARKET_PAGE;
      return result(
        order.slice(offset, offset + limit).map((sku) => row({ sku })),
        { total: order.length },
      );
    };
    /** Moves `sku` to position `index` (a ceiling rise or fall). */
    const moveTo = (sku: string, index: number): void => {
      order.splice(order.indexOf(sku), 1);
      order.splice(index, 0, sku);
    };
    /** Holds every answer until release() (a read in flight). */
    const pause = (): (() => void) => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    };
    return { list, sent, moveTo, pause };
  }

  function windowOn<Q extends MarketQuery>(list: (q: Q) => Promise<MarketListResult>) {
    const data: MarketWindowData[] = [];
    const w = createMarketWindow<Q>(list, { data: (d) => data.push(d), error: () => undefined, moreError: () => undefined, busy: () => undefined });
    return { w, data, skus: () => data.at(-1)!.result.rows.map((r) => r.sku), last: () => data.at(-1)! };
  }

  it('appends a row that rose from below the window across its edge, instead of skipping it', async () => {
    const svc = liveService(400);
    const h = windowOn(svc.list);
    h.w.setQuery(A);
    await settle();
    expect(h.skus()).toHaveLength(MARKET_PAGE);
    // A ceiling rise puts s300 on top before any refresh ran (frozen, or inside the 2 s throttle).
    svc.moveTo('s300', 0);
    h.w.loadMore();
    await settle();
    expect(h.skus()).toContain('s300');
    expect(h.skus()).toHaveLength(400);
    expect(new Set(h.skus()).size).toBe(400);
    // The rows shown keep their places; the new ones follow them.
    expect(h.skus().slice(0, MARKET_PAGE)).toEqual(Array.from({ length: MARKET_PAGE }, (_, i) => `s${i}`));
    expect(marketDisplayRows(h.last().result.rows, h.last().result.total).some((r) => r.type === 'more')).toBe(false);
  });

  it('keeps the row pushed over the edge when one slips out of the first page', async () => {
    const svc = liveService(400);
    const h = windowOn(svc.list);
    h.w.setQuery(A);
    await settle();
    svc.moveTo('s50', 250);
    h.w.loadMore();
    await settle();
    expect(h.skus()).toContain('s200');
    expect(h.skus()).toHaveLength(400);
  });

  it('adds a full page on every Load more while more match, so the button never goes dead', async () => {
    const svc = liveService(1000);
    const h = windowOn(svc.list);
    h.w.setQuery(A);
    await settle();
    svc.moveTo('s700', 0);
    for (let i = 0; i < 3; i++) {
      const before = h.skus().length;
      h.w.loadMore();
      await settle();
      expect(h.skus().length).toBeGreaterThanOrEqual(before + MARKET_PAGE);
    }
    expect(h.skus()).toContain('s700');
  });

  it('drops a refresh queued behind Load more once held, and re-sorts only after release (Freeze)', async () => {
    const svc = liveService(1000);
    const h = windowOn(svc.list);
    h.w.setQuery(A);
    await settle();
    const release = svc.pause();
    h.w.loadMore(); // in flight
    h.w.refresh(); // queued behind it (a push arrived)
    h.w.hold(true); // Freeze
    svc.moveTo('s500', 0);
    release();
    await settle();
    // Only the Load more went out; its rows were appended below the held ones.
    expect(svc.sent.filter((q) => q.offset === 0)).toHaveLength(2); // the first read and the Load more
    expect(h.skus().slice(0, MARKET_PAGE)).toEqual(Array.from({ length: MARKET_PAGE }, (_, i) => `s${i}`));
    const shown = h.data.length;
    // Further pushes while held send nothing.
    h.w.refresh();
    await settle();
    expect(svc.sent).toHaveLength(2);
    expect(h.data).toHaveLength(shown);
    // Unfreeze: the window is re-read and re-sorted.
    h.w.hold(false);
    h.w.refresh();
    await settle();
    expect(h.skus()[0]).toBe('s500');
    expect(h.last().fetchedAt).toBeGreaterThanOrEqual(h.data[0]!.fetchedAt);
  });

  it('does not show a refresh that was in flight when Freeze was pressed, but still shows a new query', async () => {
    const svc = liveService(1000);
    const h = windowOn(svc.list);
    h.w.setQuery(A);
    await settle();
    const shown = h.data.length;
    const release = svc.pause();
    h.w.refresh(); // in flight
    h.w.hold(true);
    svc.moveTo('s500', 0);
    release();
    await settle();
    expect(h.data).toHaveLength(shown);
    expect(h.skus()[0]).toBe('s0');
    // A filter or sort change is the user's own action: it lands while held.
    h.w.setQuery(B);
    await settle();
    expect(h.last().key).toBe(JSON.stringify(B));
    expect(h.skus()[0]).toBe('s500');
  });

  it('reads the minimum box as keys and scrap, converting it per request exactly like readMinCeiling', () => {
    expect(readMinPrice('')).toBeNull();
    expect(readMinPrice('junk')).toBeNull();
    expect(readMinPrice('0 ref')).toBeNull();
    expect(readMinPrice('1 key')).toEqual({ keys: 1, scrap: 0 });
    expect(readMinPrice('2 ref')).toEqual({ keys: 0, scrap: 18 });
    for (const text of ['1 key', '2 ref', '1.5 keys', '1 key, 4.33 ref', '0.11', 'junk', '']) {
      for (const k of [568, 601, null]) {
        const q = marketListParams(marketWindowQuery(filters(), readMinPrice(text), DEFAULT_MARKET_SORT), k);
        expect(q, `${text} at ${k}`).toEqual(marketQuery(filters(), readMinCeiling(text, k).scrap, DEFAULT_MARKET_SORT));
      }
    }
  });

  it('keeps the loaded window, its query and Freeze when the key price moves under a minimum in keys', async () => {
    const svc = liveService(1000);
    let K = 600;
    const h = windowOn<MarketWindowQuery>((q) => svc.list(marketListParams(q, K)));
    const query = () => marketWindowQuery(filters({ minCeiling: '1 key' }), readMinPrice('1 key'), DEFAULT_MARKET_SORT);
    h.w.setQuery(query());
    await settle();
    h.w.loadMore();
    await settle();
    expect(h.skus()).toHaveLength(400);
    expect(svc.sent.at(-1)).toMatchObject({ minCeilingScrap: 600 });
    const key = h.last().key;

    // The key price moves: the page's query is the same, so nothing starts over.
    K = 601;
    expect(JSON.stringify(query())).toBe(key);
    h.w.setQuery(query());
    expect(svc.sent).toHaveLength(2);
    // The page refreshes in place instead: the whole window, converted at the new key price.
    h.w.refresh();
    await settle();
    expect(svc.sent.at(-1)).toMatchObject({ minCeilingScrap: 601, limit: 400, offset: 0 });
    expect(h.last().key).toBe(key);
    expect(h.skus()).toHaveLength(400);

    // Frozen, a key move changes nothing on screen.
    h.w.hold(true);
    K = 602;
    h.w.refresh();
    await settle();
    expect(svc.sent).toHaveLength(3);
  });
});

describe('scroll anchoring', () => {
  const ids = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it('stays at the top so new leaders show', () => {
    expect(anchoredScrollTop(ids(50), ['new', ...ids(50)], 0, 38, 15)).toBe(0);
  });

  it('undoes a shift of the rows being read', () => {
    const prev = ids(100);
    // Two items appear above: everything visible moved down by two rows.
    expect(anchoredScrollTop(prev, ['x', 'y', ...prev], 40 * 38 + 7, 38, 15)).toBe(42 * 38 + 7);
    // One item above disappeared.
    expect(anchoredScrollTop(prev, prev.filter((id) => id !== 'r3'), 40 * 38, 38, 15)).toBe(39 * 38);
  });

  it('ignores one row jumping elsewhere and unknown rows', () => {
    const prev = ids(100);
    const next = [...prev];
    const [moved] = next.splice(40, 1);
    next.unshift(moved!);
    // r40 left the top of the view for the top of the list; the rest shifted by at most one.
    const top = anchoredScrollTop(prev, next, 40 * 38, 38, 15);
    expect(Math.abs(top - 40 * 38)).toBeLessThanOrEqual(38);
    expect(anchoredScrollTop(prev, ids(100, 'other'), 40 * 38, 38, 15)).toBe(40 * 38);
    expect(anchoredScrollTop(prev, prev, 40 * 38, 38, 15)).toBe(40 * 38);
  });
});

describe('flash diffing', () => {
  it('flashes only rows whose ceiling or revenue moved, with a direction', () => {
    const before = [row({ sku: 'a', maxCostScrap: 100 }), row({ sku: 'b', revenueScrap: 120 }), row({ sku: 'c' }), row({ sku: 'd', maxCostScrap: 50 })];
    const snap = snapshotRows(before);
    const after = [
      row({ sku: 'a', maxCostScrap: 104 }),
      row({ sku: 'b', revenueScrap: 118 }),
      row({ sku: 'c', buyerCount: 9 }),
      row({ sku: 'd', maxCostScrap: null }),
      row({ sku: 'new', maxCostScrap: 999 }),
    ];
    expect([...diffFlash(snap, after)]).toEqual([
      ['a', 'up'],
      ['b', 'down'],
      ['d', 'down'],
    ]);
  });

  it('lets the ceiling decide over revenue, and a ceiling appearing counts as up', () => {
    const snap = snapshotRows([row({ sku: 'a', maxCostScrap: 100, revenueScrap: 120 }), row({ sku: 'b', maxCostScrap: null, revenueScrap: null })]);
    const dirs = diffFlash(snap, [row({ sku: 'a', maxCostScrap: 98, revenueScrap: 125 }), row({ sku: 'b', maxCostScrap: 10, revenueScrap: 30 })]);
    expect(dirs.get('a')).toBe('down');
    expect(dirs.get('b')).toBe('up');
  });

  it('never flashes on the first load', () => {
    expect(diffFlash(null, [row({ sku: 'a' })]).size).toBe(0);
  });
});

describe('labels and verdict pills', () => {
  it('labels every verdict in chip order: Flip, Rule flip, Not checked, Over, No buyers', () => {
    expect(MARKET_VERDICTS.map((v) => VERDICT_LABELS[v])).toEqual(['Flip', 'Rule flip', 'Not checked', 'Over', 'No buyers']);
    expect(VERDICT_TONES).toMatchObject({ flip: 'good', over: 'bad', 'rule-flip': 'warn', unchecked: 'muted' });
    for (const v of MARKET_VERDICTS) expect(VERDICT_HELP[v].length).toBeGreaterThan(20);
    expect(MARKET_SOURCES.map((s) => SOURCE_LABELS[s])).toEqual(['Seen on scrap.tf', 'Typed', 'None']);
  });

  it('shows Flip with its profit and Over by the gap', () => {
    const flip = verdictPill(row({ sku: 'a', verdict: 'flip', knownCostScrap: 80, maxCostScrap: 100, profitScrap: 36 }), KEY);
    expect(flip).toMatchObject({ tone: 'good', text: 'Flip +4.00 ref' });
    expect(flip.title).toContain('at or under Pay up to');
    expect(verdictPill(row({ sku: 'a', verdict: 'flip', knownCostScrap: 80, profitScrap: null }), KEY).text).toBe('Flip');

    const over = verdictPill(row({ sku: 'a', verdict: 'over', knownCostScrap: 118, maxCostScrap: 100 }), KEY);
    expect(over).toMatchObject({ tone: 'bad', text: 'Over by 2.00 ref' });
    expect(over.title).toContain('not a flip');
    expect(verdictPill(row({ sku: 'a', verdict: 'over', knownCostScrap: 118, maxCostScrap: null }), KEY)).toMatchObject({ text: 'Over', tone: 'bad' });
  });

  it('marks rule flips amber and unchecked items muted, with the ceiling to look for', () => {
    const rule = verdictPill(row({ sku: 'a', verdict: 'rule-flip', ruleCostScrap: 15, maxCostScrap: 100 }), KEY);
    expect(rule).toMatchObject({ tone: 'warn', text: 'Rule flip' });
    expect(rule.title).toContain('1.66 ref');
    const unchecked = verdictPill(row({ sku: 'a', verdict: 'unchecked', maxCostScrap: 100 }), KEY);
    expect(unchecked).toMatchObject({ tone: 'muted', text: 'Not checked' });
    expect(unchecked.title).toContain('11.11 ref');
    expect(verdictPill(row({ sku: 'a', verdict: 'unchecked', maxCostScrap: null }), KEY).title).toContain('no price clears');
    expect(verdictPill(row({ sku: 'a', verdict: 'no-buyers' }), KEY)).toMatchObject({ tone: 'muted', text: 'No buyers' });
  });
});

describe('cells', () => {
  it('shows a saved-page price with its age, stock and tone', () => {
    const c = yourPriceCell(row({ sku: 'a', verdict: 'flip', knownCostScrap: 80, knownSource: 'page', knownObservedAt: NOW - 4 * MIN, stock: 3 }), KEY, NOW);
    expect(c).toMatchObject({ kind: 'known', scrap: 80, badge: 'page', age: '4 min', stock: '×3', tone: 'good' });
    expect(c.title).toContain('saved scrap.tf page');
    expect(c.title).toContain('3 in stock');
  });

  it('shows a typed price without stock, and says when it was for a copy with extras', () => {
    const c = yourPriceCell(row({ sku: 'a', verdict: 'over', knownCostScrap: 130, knownSource: 'typed', knownObservedAt: NOW - 2 * 3_600_000, stock: 5, flags: ['has-extras'] }), KEY, NOW);
    expect(c).toMatchObject({ badge: 'typed', age: '2 h', stock: null, tone: 'bad' });
    expect(c.title).toContain('a copy with extras (paint, spells, a sheen or killstreaker)');
    expect(yourPriceCell(row({ sku: 'a', verdict: 'no-buyers', knownCostScrap: 1, knownSource: 'typed', knownObservedAt: null }), KEY, NOW)).toMatchObject({ age: null, tone: null });
  });

  it('falls back to the rule estimate, then to nothing', () => {
    expect(yourPriceCell(row({ sku: 'a', ruleCostScrap: 15 }), KEY, NOW)).toMatchObject({ kind: 'rule', scrap: 15, badge: 'rule', tone: null });
    const none = yourPriceCell(row({ sku: 'a' }), KEY, NOW);
    expect(none).toMatchObject({ kind: 'none', scrap: null, badge: null });
    expect(none.title).toContain('your own browser');
  });

  it('explains Sells for and Pay up to', () => {
    // 0.7.4: presence as of `now`; the order's event a minute old is recent, 23 h old is not.
    const t = marketSellsForTitle(row({ sku: 'a', flags: ['outlier-best'] }), KEY, NOW);
    expect(t).toContain('to BuyBot (bot, online)');
    expect(marketSellsForTitle(row({ sku: 'a' }), KEY, NOW + 23 * 60 * MIN)).toContain('to BuyBot (bot, last seen 23 h ago)');
    expect(t).toContain('best 14.44 ref (outlier)');
    expect(t).toContain('4 buyers');
    expect(marketSellsForTitle(row({ sku: 'a', revenueScrap: null, revenueOrder: null, buyerCount: 0 }), KEY)).toContain('No eligible');
    expect(marketSellsForTitle(row({ sku: 'a', revenueScrap: null, revenueOrder: null, buyerCount: 3, flags: ['all-outliers'] }), KEY)).toContain('unrealistic');
    expect(marketPayTitle(row({ sku: 'a', maxCostScrap: 100 }), KEY)).toContain('11.11 ref');
    expect(marketPayTitle(row({ sku: 'a', maxCostScrap: null, buyerCount: 2 }), KEY)).toContain('No scrap.tf price clears');
    expect(marketPayTitle(row({ sku: 'a', maxCostScrap: null, buyerCount: 0 }), KEY)).toContain('no ceiling');
  });
});

describe('header strip', () => {
  it('puts pause and the feed switch before the feed state', () => {
    expect(marketLiveState('live', true, false)).toMatchObject({ state: 'paused', label: 'Paused' });
    expect(marketLiveState('live', false, true)).toMatchObject({ state: 'off', label: 'Feed off' });
    expect(marketLiveState('live', false, false)).toMatchObject({ state: 'live', label: 'Live' });
    expect(marketLiveState(null, false, false).state).toBe('connecting');
  });

  it('counts updates per minute from the pushes seen', () => {
    let list = addPulse([], { at: NOW - 70_000, changed: 50 }, NOW - 70_000);
    list = addPulse(list, { at: NOW - 30_000, changed: 3 }, NOW - 30_000);
    list = addPulse(list, { at: NOW - 1000, changed: 2 }, NOW);
    expect(list).toHaveLength(2);
    expect(pulseRate(list, NOW)).toEqual({ pushes: 2, changed: 5 });
    expect(pulseRate(list, NOW + PULSE_WINDOW_MS)).toEqual({ pushes: 0, changed: 0 });
    expect(liveRateText({ pushes: 2, changed: 5 }).text).toBe('5 updates/min');
    expect(liveRateText({ pushes: 1, changed: 1 }).text).toBe('1 update/min');
    expect(liveRateText({ pushes: 2, changed: 5 }).title).toContain('2 pushes');
    // A burst never grows the list without bound.
    let burst: ReturnType<typeof addPulse> = [];
    for (let i = 0; i < 500; i++) burst = addPulse(burst, { at: NOW, changed: -2 }, NOW);
    expect(burst.length).toBeLessThanOrEqual(64);
    expect(pulseRate(burst, NOW).changed).toBe(0);
  });

  it('says how recently the market changed', () => {
    expect(lastChangeText(null, NOW)).toBe('No changes yet');
    expect(lastChangeText(NOW - 12_000, NOW)).toBe('Last change 12 s ago');
    expect(lastChangeText(NOW - 1000, NOW)).toBe('Last change just now');
  });

  it('shows the build progress, then the index size', () => {
    expect(buildPercent(0.437)).toBe(43);
    expect(buildPercent(2)).toBe(100);
    expect(buildPercent(Number.NaN)).toBe(0);
    const b = indexStateText(stats({ building: true, progress: 0.43, entries: 900 }), NOW);
    expect(b).toMatchObject({ text: 'Building 43 %…', building: true, percent: 43 });
    expect(b.title).toContain('Nothing is downloaded');
    const done = indexStateText(stats({ entries: 12_345, pendingDirty: 7 }), NOW);
    expect(done).toMatchObject({ text: '12,345 items with buyers', building: false, percent: null });
    expect(done.title).toContain('4 min ago');
    expect(done.title).toContain('7 queued');
    expect(indexStateText(stats({ entries: 1 }), NOW).text).toBe('1 item with buyers');
  });

  it('H1: says the local database could not be read and when it retries, instead of "Building 0 %"', () => {
    // What the service reports after a failed candidate scan: building off, the error and the next attempt.
    const failed = stats({ building: false, progress: 0, entries: 0, lastFullAt: null, lastError: 'SQLITE_BUSY: database is locked', retryAt: NOW + 42_000 });
    const s = indexStateText(failed, NOW);
    expect(s).toMatchObject({ text: 'Could not read the local database (SQLITE_BUSY: database is locked). Retrying in 42 s.', building: false, percent: null, error: true });
    expect(s.text).not.toMatch(/Building/);
    expect(s.title).toContain('Nothing is downloaded');
    // Even if a stale building flag came along, the error wins.
    expect(indexStateText({ ...failed, building: true }, NOW).error).toBe(true);
    expect(marketErrorText(failed, NOW + 30_500)).toBe('Could not read the local database (SQLITE_BUSY: database is locked). Retrying in 12 s.');
    expect(marketErrorText({ ...failed, retryAt: NOW + 9 * 60_000 + 5_000 }, NOW)).toMatch(/Retrying in 9 min 05 s\.$/);
    expect(marketErrorText(failed, NOW + 42_000)).toMatch(/Retrying now\.$/);
    expect(marketErrorText({ ...failed, retryAt: null }, NOW)).toMatch(/It is retried shortly\.$/);
    expect(marketErrorText({ ...failed, lastError: '  ' }, NOW)).toMatch(/^Could not read the local database \(unknown error\)\./);
    // Fine again: the error is cleared and the usual text is back.
    expect(marketErrorText(stats(), NOW)).toBeNull();
    expect(indexStateText(stats(), NOW).error).toBe(false);
    // Rows kept from the last good read are mentioned in the tooltip.
    expect(indexStateText({ ...failed, entries: 1200 }, NOW).title).toContain('1,200 items shown are from the last good read');
  });

  it('polls while building or waiting for a retry, never otherwise', () => {
    expect(marketPollMs(null)).toBeNull();
    expect(marketPollMs(stats())).toBeNull();
    expect(marketPollMs(stats({ building: true }))).toBe(2000);
    // A retry that fails again pushes nothing, so the page has to look.
    expect(marketPollMs(stats({ lastError: 'disk I/O error', retryAt: NOW + 30_000 }))).toBe(5000);
  });

  it('summarises the scrap.tf side as the user supplied it', () => {
    const s = scraptfSideText({ typed: 12, pages: 30, newestPageAt: NOW - 4 * MIN, importEnabled: true, watchFolder: true, coverage: [], allItems: scraptfListCoverage(null) }, NOW);
    expect(s).toEqual({ text: 'Your scrap.tf data: 12 typed, 30 from saved pages (newest page 4 min ago). Folder watch on.', watch: 'on' });
    expect(scraptfSideText({ typed: 1, pages: 0, newestPageAt: null, importEnabled: true, watchFolder: false, coverage: [], allItems: scraptfListCoverage(null) }, NOW)).toEqual({
      text: 'Your scrap.tf data: 1 typed, 0 from saved pages. Folder watch off.',
      watch: 'off',
    });
    expect(scraptfSideText({ typed: 0, pages: 0, newestPageAt: null, importEnabled: false, watchFolder: false, coverage: [], allItems: scraptfListCoverage(null) }, NOW).watch).toBe('import-off');
  });

  it('states the boundary plainly', () => {
    expect(BOUNDARY_NOTE).toBe('Flip Desk never loads scrap.tf on its own. Browse it yourself: prices you type, pages you save show up here.');
  });

  it('counts the updates a freeze holds back', () => {
    expect(waitingText(0)).toBe('No updates waiting');
    expect(waitingText(1)).toBe('1 update waiting');
    expect(waitingText(1234)).toBe('1,234 updates waiting');
  });
});

describe('empty states', () => {
  const base = { filters: filters(), stats: stats(), paused: false, feedOff: false };

  it('explains a build in progress first', () => {
    expect(emptyMarketReason({ ...base, stats: stats({ building: true, entries: 0 }), paused: true, filters: filters({ search: 'x' }) })).toBe('building');
  });

  it('blames the feed when the index is empty, whatever the filters', () => {
    expect(emptyMarketReason({ ...base, stats: stats({ entries: 0 }), paused: true, filters: filters({ search: 'x' }) })).toBe('paused');
    expect(emptyMarketReason({ ...base, stats: stats({ entries: 0 }), feedOff: true, filters: filters({ verdicts: ['flip'] }) })).toBe('feed-off');
  });

  it('points at the filters when the index has items', () => {
    expect(emptyMarketReason({ ...base, filters: filters({ verdicts: ['flip'] }), paused: true })).toBe('filters');
    expect(emptyMarketReason({ ...base, paused: true })).toBe('paused');
    expect(emptyMarketReason({ ...base, feedOff: true })).toBe('feed-off');
    expect(emptyMarketReason(base)).toBe('nothing-yet');
    expect(emptyMarketReason({ ...base, stats: null })).toBe('nothing-yet');
  });

  it('does not blame filters for a market that is still empty', () => {
    const empty = { ...base, stats: stats({ entries: 0 }), filters: filters({ verdicts: ['flip'] }) };
    expect(emptyMarketReason({ ...empty, knownItems: 0 })).toBe('nothing-yet');
    // Items you priced are rows even without buyers, so then the filters are hiding them.
    expect(emptyMarketReason({ ...empty, knownItems: 3 })).toBe('filters');
    expect(emptyMarketReason(empty)).toBe('filters');
  });

  it('H1: an empty index that could not read the database says so, before anything else', () => {
    const failed = stats({ entries: 0, building: false, lastError: 'database disk image is malformed', retryAt: NOW + 30_000 });
    expect(emptyMarketReason({ ...base, stats: failed, paused: true, feedOff: true, filters: filters({ search: 'x' }), knownItems: 0 })).toBe('error');
    // Rows kept from the last good read: the table shows them, and the filters still explain an empty view.
    expect(emptyMarketReason({ ...base, stats: { ...failed, entries: 50 }, filters: filters({ search: 'x' }) })).toBe('filters');
  });
});

describe('scrap.tf saved-page coverage strip (F13)', () => {
  const page = (over: Partial<ScraptfCoverage> = {}): ScraptfCoverage => ({ category: 'hats', label: 'Hats', url: 'https://scrap.tf/buy/hats', lastSavedAt: null, items: 0, ...over });

  it('colours a page green up to 15 min, amber up to 2 h, muted after or never', () => {
    expect(COVERAGE_FRESH_MS).toBe(15 * MIN);
    expect(COVERAGE_AGING_MS).toBe(120 * MIN);
    expect(coverageTone(null, NOW)).toBe('muted');
    expect(coverageTone(NOW, NOW)).toBe('good');
    expect(coverageTone(NOW - 15 * MIN, NOW)).toBe('good');
    expect(coverageTone(NOW - 15 * MIN - 1, NOW)).toBe('warn');
    expect(coverageTone(NOW - 120 * MIN, NOW)).toBe('warn');
    expect(coverageTone(NOW - 120 * MIN - 1, NOW)).toBe('muted');
    expect(coverageTone(NOW - 30 * 86_400_000, NOW)).toBe('muted');
    // A file time a little ahead of the clock is fresh, not broken.
    expect(coverageTone(NOW + 90_000, NOW)).toBe('good');
    expect(coverageTone(Number.NaN, NOW)).toBe('muted');
  });

  it('labels each chip with when it was saved and how many items it had', () => {
    const c = coverageChip(page({ lastSavedAt: NOW - 4 * MIN, items: 48 }), NOW);
    expect(c).toMatchObject({ label: 'Hats', status: 'saved 4 min ago · 48 items', tone: 'good', url: 'https://scrap.tf/buy/hats', bank: 'hats' });
    // F15: a chip opens its card on the scrap.tf banks page, which has Open in browser.
    expect(c.title).toBe(COVERAGE_TIP);
    expect(COVERAGE_TIP).toContain('scrap.tf banks page');
    expect(c.ariaLabel).toBe('Hats: saved 4 min ago · 48 items. Opens its card on the scrap.tf banks page.');
    expect(coverageChip(page({ lastSavedAt: NOW - 1000, items: 1 }), NOW).status).toBe('saved just now · 1 item');
    expect(coverageChip(page({ lastSavedAt: NOW + 60_000, items: 3 }), NOW).status).toBe('saved just now · 3 items');
    expect(coverageChip(page({ lastSavedAt: NOW - 3 * 3_600_000, items: 1234 }), NOW)).toMatchObject({ status: 'saved 3 h ago · 1,234 items', tone: 'muted' });
    expect(coverageChip(page(), NOW)).toMatchObject({ status: 'never saved', tone: 'muted' });
  });

  it('shows one chip per bank page in the service order, and none while import is off', () => {
    const coverage = SCRAPTF_BANK_PAGES.map((p, i) => page({ category: p.category, label: p.label, url: p.url, lastSavedAt: i === 0 ? NOW - MIN : null, items: i === 0 ? 10 : 0 }));
    const on = coverageChips({ importEnabled: true, coverage }, NOW);
    expect(on.map((c) => c.label)).toEqual(['Hats', 'Weapons', 'Stranges', 'Killstreaks', 'Skins', 'Items', 'Unusuals']);
    expect(on.map((c) => c.url)).toEqual(SCRAPTF_BANK_PAGES.map((p) => p.url));
    // Every chip stands for one of the static bank pages the link generator knows, and its bank's card.
    for (const c of on) expect(c.url).toMatch(/^https:\/\/scrap\.tf\/(buy\/[a-z]+|unusuals)$/);
    expect(on.map((c) => c.bank)).toEqual(SCRAPTF_BANK_PAGES.map((p) => p.bank));
    expect(coverageChips({ importEnabled: false, coverage }, NOW)).toEqual([]);
    expect(coverageChips(null, NOW)).toEqual([]);
  });

  it('names the bank by its static page, else by its category (the items page is "other"), else none', () => {
    expect(coverageBank({ url: 'https://scrap.tf/buy/items' })).toBe('items');
    expect(coverageBank({ url: 'https://scrap.tf/unusuals' })).toBe('unusuals');
    expect(coverageBank({ url: 'https://example.com/x', category: 'other' })).toBe('items');
    expect(coverageBank({ url: 'https://example.com/x', category: 'stranges' })).toBe('stranges');
    // The /items list is not a bank page chip; allItemsChip names it itself.
    expect(coverageBank({ url: 'https://scrap.tf/items' })).toBeNull();
    expect(coverageBank({ url: 'https://example.com/x', category: 'nope' as never })).toBeNull();
  });
});

describe('"See all" from a scrap.tf bank card (F15)', () => {
  it('routes a bank page to the Live market by its id, and the /items list nowhere', () => {
    expect(MARKET_BANK_ROUTE).toBe('bank');
    expect(marketBankPath('hats')).toBe('market/bank/hats');
    expect(marketBankPath('items')).toBe('market/bank/items');
    expect(marketBankPath('list')).toBeNull();
    expect(marketBankPath('nope' as never)).toBeNull();
  });

  it("opens that bank's categories and Not checked, nothing else, highest Pay up to first", () => {
    const hats = marketRouteIntent(['market', 'bank', 'hats'])!;
    expect(hats.key).toBe('bank/hats');
    expect(hats.filters).toEqual({ ...defaultMarketFilters(), categories: ['hats'], verdicts: ['unchecked'] });
    expect(hats.sort).toEqual(DEFAULT_MARKET_SORT);
    expect(marketQuery(hats.filters, null, hats.sort)).toEqual({ sort: 'ceiling', dir: 'desc', categories: ['hats'], verdicts: ['unchecked'] });
    // The items bank sells taunts and everything else, in the canonical category order.
    expect(marketRouteIntent(['market', 'bank', 'items'])!.filters.categories).toEqual(CATEGORIES.filter((c) => c === 'taunts' || c === 'other'));
    // The filters are a fresh copy each time (state must not share the frozen defaults).
    expect(marketRouteIntent(['market', 'bank', 'hats'])!.filters).not.toBe(hats.filters);
  });

  it('ignores any other route', () => {
    expect(marketRouteIntent([])).toBeNull();
    expect(marketRouteIntent(['market'])).toBeNull();
    expect(marketRouteIntent(['market', 'bank'])).toBeNull();
    expect(marketRouteIntent(['market', 'bank', 'list'])).toBeNull();
    expect(marketRouteIntent(['market', 'bank', '__proto__'])).toBeNull();
    expect(marketRouteIntent(['market', 'other', 'hats'])).toBeNull();
    expect(marketRouteIntent(['banks', 'bank', 'hats'])).toBeNull();
  });
});

describe('against the browser mock', () => {
  let bridge: MockBridge | null = null;
  const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

  afterEach(() => {
    bridge?.dispose();
    bridge = null;
  });

  /** The window as the page reads it: one call (H2). */
  function fetchWindow(b: MockBridge, q: ReturnType<typeof marketQuery>, size: number): Promise<MarketListResult> {
    return b.rpc('market.list', { ...q, ...windowRequest(size) });
  }

  it('accepts every query the page builds, and the window equals one big request', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    const q = marketQuery(filters({ search: '  ', sources: ['none', 'page', 'typed'] }), null, { sort: 'name', dir: 'asc' });
    const win = await fetchWindow(b, q, MARKET_WINDOW_MAX);
    const big = await b.rpc('market.list', { ...q, limit: 500 });
    expect(win.total).toBe(big.total);
    expect(win.rows.map((r) => r.sku)).toEqual(big.rows.map((r) => r.sku));
    expect(win.rows.map((r) => r.sku)).toEqual([...win.rows].sort(marketComparator('name', 'asc')).map((r) => r.sku));

    const narrow = marketQuery(
      filters({ search: 'x'.repeat(300), verdicts: ['unchecked', 'flip'], categories: ['unusuals'], minBuyers: 2, onlyBotBuyers: true }),
      readMinCeiling('1 ref', KEY).scrap,
      { sort: 'profit', dir: 'desc' },
    );
    await expect(fetchWindow(b, narrow, 600)).resolves.toBeDefined();
    await expect(b.rpc('opps.exportCsv', { kind: 'market', market: marketExportQuery(narrow) })).resolves.toMatchObject({ suggestedName: expect.stringMatching(/\.csv$/) });
  });

  it('pages by 200 and appends without duplicates', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    const q = marketQuery(filters(), null, DEFAULT_MARKET_SORT);
    const first = await fetchWindow(b, q, MARKET_PAGE);
    expect(first.rows).toHaveLength(Math.min(MARKET_PAGE, first.total));
    expect(first.total).toBeGreaterThan(MARKET_PAGE);
    const req = nextPageRequest(first.rows.length, first.total)!;
    // Load more re-reads the grown window from the top, in one call, and appends what is new.
    const merged = appendMarketRows(first, await fetchWindow(b, q, req.offset + req.limit));
    expect(merged.rows).toHaveLength(first.total);
    expect(new Set(merged.rows.map((r) => r.sku)).size).toBe(first.total);
    expect(marketDisplayRows(merged.rows, merged.total).some((r) => r.type === 'more')).toBe(false);
    expect(nextPageRequest(merged.rows.length, merged.total)).toBeNull();
  });

  it('flashes the rows a live push changed', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    const q = marketQuery(filters(), null, DEFAULT_MARKET_SORT);
    let pushes = 0;
    b.on('market.changed', () => pushes++);
    let snap = snapshotRows((await fetchWindow(b, q, MARKET_WINDOW_MAX)).rows);
    let flashed = new Map<string, 'up' | 'down'>();
    for (let i = 0; i < 40 && flashed.size === 0; i++) {
      b.tick();
      const next = await fetchWindow(b, q, MARKET_WINDOW_MAX);
      flashed = diffFlash(snap, next.rows);
      for (const [sku, dir] of flashed) {
        const before = snap.get(sku)!;
        const after = next.rows.find((r) => r.sku === sku)!;
        expect(before.maxCostScrap !== after.maxCostScrap || before.revenueScrap !== after.revenueScrap).toBe(true);
        expect(dir === 'up' || dir === 'down').toBe(true);
      }
      snap = snapshotRows(next.rows);
    }
    expect(flashed.size).toBeGreaterThan(0);
    expect(pushes).toBeGreaterThan(0);
  });
});
