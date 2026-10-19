// Helpers for the Live market page (F10): persisted filters, the
// 'market.list' query and its loaded window (one call per read, H2), verdict
// pills and cell text, the header strip (with the rebuild error, H1, and the
// saved-page coverage chips, F13), flash diffing and scroll anchoring. All pure
// except createMarketWindow, whose only side effect is the list call it is handed.
// The scrap.tf price list's cells and "All items" chip (F14) are in scraptfListModel.ts.
// F17 (bank stock, spec S4) joins the Live market and the item detail: the "New" badge, the
// "New on scrap.tf" source filter and the drawer's bank stock line are at the end. F19's link out
// to scrap.tf (each row's bank page button, the one-bank header button) is after them.
// The service filters, sorts and pages; the verdict, filter and order rules
// themselves live in src/shared/market.ts so the page, the mock and the
// service agree.
//
// The scrap.tf side of every row is only what the user typed or saved (R1,
// R10). Nothing here, or anywhere in the app, fetches scrap.tf.

import { bankStockPagePath } from '../shared/bankStock';
import { parsePrice } from '../shared/currency';
import { SCRAPTF_BANKS, bankForCategory, scraptfBankInfo, type ScraptfBankInfo } from '../shared/links';
import { MARKET_DEFAULT_LIMIT, MARKET_MAX_LIMIT, MARKET_MAX_SEARCH_CHARS, MARKET_SORTS } from '../shared/market';
import type {
  Category,
  ConnState,
  ItemBankStock,
  MarketListResult,
  MarketQuery,
  MarketRow,
  MarketSort,
  MarketSource,
  MarketStats,
  MarketVerdict,
  Scrap,
  ScraptfBank,
  ScraptfCoverage,
  UnixMs,
} from '../shared/types';
import { CATEGORIES, MARKET_SOURCES, MARKET_VERDICTS } from '../shared/types';
import { CONN_STATE_LABELS, errorMessage, fmtAge, fmtAgo, fmtCountdown, fmtDateTime, fmtInt, fmtMoney, fmtSignedMoney, type Tone } from './format';
import { SAVE_MODE } from './importModel';
import { scraptfSearchName } from './itemMenuModel';

// ---------------------------------------------------------------------------
// Filters and sort
// ---------------------------------------------------------------------------

/** What the filter bar edits; converted to a MarketQuery for the service. */
export interface MarketFilters {
  search: string;
  categories: Category[];
  verdicts: MarketVerdict[];
  sources: MarketSource[];
  /** The minimum Pay up to as typed ("2 ref", "1 key"); bare numbers are refined (readMinCeiling). */
  minCeiling: string;
  onlyBotBuyers: boolean;
  /** 0 = any. */
  minBuyers: number;
  /** F14: only items on the user's saved scrap.tf/items list (MarketQuery.onScraptfList). */
  onScraptfList: boolean;
  /** F17: only items new on scrap.tf since the previous save of a bank page (MarketQuery.newOnScraptf). */
  newOnScraptf: boolean;
  /** F20: only items the user's saves have listed on sale for at least 24 h (MarketQuery.listedOnScraptf). */
  listedOnScraptf: boolean;
}

export type SortDir = 'asc' | 'desc';

export interface MarketSortState {
  sort: MarketSort;
  dir: SortDir;
}

/** The service's zod bound for minBuyers. */
export const MAX_MIN_BUYERS = 100_000;
const MAX_MIN_CEILING_CHARS = 40;

/** Quick picks in the minimum-buyers popover (0 = any). */
export const MIN_BUYER_STEPS: readonly number[] = [0, 2, 3, 5, 10];

export const DEFAULT_MARKET_FILTERS: Readonly<MarketFilters> = Object.freeze<MarketFilters>({
  search: '',
  categories: [],
  verdicts: [],
  sources: [],
  minCeiling: '',
  onlyBotBuyers: false,
  minBuyers: 0,
  onScraptfList: false,
  newOnScraptf: false,
  listedOnScraptf: false,
});

export const DEFAULT_MARKET_SORT: Readonly<MarketSortState> = Object.freeze<MarketSortState>({ sort: 'ceiling', dir: 'desc' });

/** A fresh copy of the defaults (the frozen arrays must not be handed to state). */
export function defaultMarketFilters(): MarketFilters {
  return { ...DEFAULT_MARKET_FILTERS, categories: [], verdicts: [], sources: [] };
}

/** Known values only, once each, in the canonical order (chips and queries never depend on click order). */
function pickOrdered<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v)) return [];
  const set = new Set<unknown>(v);
  return allowed.filter((a) => set.has(a));
}

function clampBuyers(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(MAX_MIN_BUYERS, Math.floor(v))) : 0;
}

/** Defensive restore of persisted filters (older or hand-edited values). */
export function sanitizeMarketFilters(v: unknown): MarketFilters {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return {
    search: typeof o['search'] === 'string' ? o['search'].slice(0, MARKET_MAX_SEARCH_CHARS) : '',
    categories: pickOrdered(o['categories'], CATEGORIES),
    verdicts: pickOrdered(o['verdicts'], MARKET_VERDICTS),
    sources: pickOrdered(o['sources'], MARKET_SOURCES),
    minCeiling: typeof o['minCeiling'] === 'string' ? o['minCeiling'].slice(0, MAX_MIN_CEILING_CHARS) : '',
    onlyBotBuyers: o['onlyBotBuyers'] === true,
    minBuyers: clampBuyers(o['minBuyers']),
    onScraptfList: o['onScraptfList'] === true,
    // Filters saved before 0.6 have no such key: off.
    newOnScraptf: o['newOnScraptf'] === true,
    // F20: off for filters saved before it.
    listedOnScraptf: o['listedOnScraptf'] === true,
  };
}

/** The minimum-buyers box: blank or junk means any (0); otherwise a whole number within the service's bound. */
export function readMinBuyers(text: string): number {
  const n = Number(String(text).trim());
  return clampBuyers(Number.isFinite(n) ? n : 0);
}

/** Name reads A to Z first; every number reads biggest (or newest) first. */
export function defaultMarketDir(sort: MarketSort): SortDir {
  return sort === 'name' ? 'asc' : 'desc';
}

export function sanitizeMarketSort(v: unknown): MarketSortState {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const sort = MARKET_SORTS.includes(o['sort'] as MarketSort) ? (o['sort'] as MarketSort) : DEFAULT_MARKET_SORT.sort;
  const dir = o['dir'] === 'asc' || o['dir'] === 'desc' ? o['dir'] : defaultMarketDir(sort);
  return { sort, dir };
}

/** A header click: the same column flips direction, another starts in its natural direction. */
export function toggleMarketSort(cur: MarketSortState, sort: MarketSort): MarketSortState {
  return cur.sort === sort ? { sort, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { sort, dir: defaultMarketDir(sort) };
}

export function activeMarketFilterCount(f: MarketFilters): number {
  let n = 0;
  if (f.search.trim()) n++;
  if (f.categories.length) n++;
  if (f.verdicts.length) n++;
  if (f.sources.length) n++;
  if (f.minCeiling.trim()) n++;
  if (f.onlyBotBuyers) n++;
  if (f.minBuyers > 0) n++;
  if (f.onScraptfList) n++;
  if (f.newOnScraptf) n++;
  if (f.listedOnScraptf) n++;
  return n;
}

/** The Source button's count: its source choices plus the scrap.tf switches under them (F14, F17, F20). */
export function marketSourceCount(f: Pick<MarketFilters, 'sources' | 'onScraptfList' | 'newOnScraptf'> & Partial<Pick<MarketFilters, 'listedOnScraptf'>>): number {
  return f.sources.length + (f.onScraptfList ? 1 : 0) + (f.newOnScraptf ? 1 : 0) + (f.listedOnScraptf ? 1 : 0);
}

/** Flips one verdict chip, keeping MARKET_VERDICTS order. */
export function toggleVerdict(list: readonly MarketVerdict[], v: MarketVerdict): MarketVerdict[] {
  const on = list.includes(v);
  return MARKET_VERDICTS.filter((x) => (x === v ? !on : list.includes(x)));
}

/**
 * The 'market.list' filters and sort, without paging (the loaded window adds it).
 * `minCeilingScrap` comes from readMinCeiling. Defaults are left out so the query stays short.
 */
export function marketQuery(f: MarketFilters, minCeilingScrap: Scrap | null, s: MarketSortState): MarketQuery {
  const q: MarketQuery = { sort: s.sort, dir: s.dir };
  const search = f.search.trim().slice(0, MARKET_MAX_SEARCH_CHARS);
  if (search) q.search = search;
  const categories = pickOrdered(f.categories, CATEGORIES);
  if (categories.length) q.categories = categories;
  const verdicts = pickOrdered(f.verdicts, MARKET_VERDICTS);
  if (verdicts.length) q.verdicts = verdicts;
  const sources = pickOrdered(f.sources, MARKET_SOURCES);
  if (sources.length) q.sources = sources;
  if (minCeilingScrap !== null && Number.isFinite(minCeilingScrap) && minCeilingScrap > 0) q.minCeilingScrap = Math.round(minCeilingScrap);
  if (f.onlyBotBuyers) q.onlyBotBuyers = true;
  const buyers = clampBuyers(f.minBuyers);
  if (buyers > 0) q.minBuyers = buyers;
  if (f.onScraptfList) q.onScraptfList = true;
  if (f.newOnScraptf) q.newOnScraptf = true;
  if (f.listedOnScraptf) q.listedOnScraptf = true;
  return q;
}

// ---------------------------------------------------------------------------
// F15: "See all" on a scrap.tf bank card
// ---------------------------------------------------------------------------

/** The route segment after 'market' that a bank card's "See all" opens: #/market/bank/<bank>. */
export const MARKET_BANK_ROUTE = 'bank';

/** "market/bank/hats" for a bank page's "See all"; null for the /items list, which sells no category of its own. */
export function marketBankPath(bank: ScraptfBank): string | null {
  const info = scraptfBankInfo(bank);
  return info && info.categories.length ? `market/${MARKET_BANK_ROUTE}/${info.bank}` : null;
}

export interface MarketRouteIntent {
  /** Tells one "See all" from the next. */
  key: string;
  filters: MarketFilters;
  sort: MarketSortState;
}

/**
 * What #/market/bank/<bank> asks for: that bank's categories and Not checked, nothing else, highest
 * Pay up to first, so the table starts with the card's "What to look for" rows and counts what the
 * card's "See all" said. null for any other route.
 */
export function marketRouteIntent(segments: readonly string[]): MarketRouteIntent | null {
  if (segments[0] !== 'market' || segments[1] !== MARKET_BANK_ROUTE) return null;
  const info = scraptfBankInfo(segments[2]);
  if (!info || !info.categories.length) return null;
  return {
    key: `${MARKET_BANK_ROUTE}/${info.bank}`,
    filters: { ...defaultMarketFilters(), categories: pickOrdered(info.categories, CATEGORIES), verdicts: ['unchecked'] },
    sort: { ...DEFAULT_MARKET_SORT },
  };
}

/** The export query: the same filters and sort with no paging, so the file has every match. */
export function marketExportQuery(q: MarketQuery): MarketQuery {
  const { limit: _limit, offset: _offset, ...rest } = q;
  return rest;
}

/** The minimum Pay up to as typed, still in keys and scrap. */
export interface MarketMinPrice {
  keys: number;
  scrap: Scrap;
}

/** The minimum box as keys and scrap (bare numbers are refined); null when blank, unreadable or zero. */
export function readMinPrice(text: string): MarketMinPrice | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const p = parsePrice(t, 'ref');
  if (!p || !(p.keys > 0 || p.scrap > 0)) return null;
  return { keys: p.keys, scrap: p.scrap };
}

/**
 * The query the loaded window answers. A minimum in keys stays in keys here, so a key price move
 * leaves the window's identity alone: it is a live refresh (window, scroll and Freeze kept), not a
 * new query that starts over at the top. marketListParams converts it for each request.
 */
export type MarketWindowQuery = MarketQuery & { minPrice?: MarketMinPrice };

export function marketWindowQuery(f: MarketFilters, minPrice: MarketMinPrice | null, s: MarketSortState): MarketWindowQuery {
  const q: MarketWindowQuery = marketQuery(f, null, s);
  if (minPrice) q.minPrice = { keys: minPrice.keys, scrap: minPrice.scrap };
  return q;
}

/**
 * The 'market.list' params for one request: the minimum converted with the key price of the
 * moment, by readMinCeiling's rule (keys without a key price yet mean no minimum).
 */
export function marketListParams(q: MarketWindowQuery, keyScrap: Scrap | null): MarketQuery {
  const { minPrice, ...rest } = q;
  const out: MarketQuery = rest;
  if (!minPrice) return out;
  if (minPrice.keys > 0 && !(keyScrap !== null && keyScrap > 0)) return out;
  const scrap = Math.max(0, Math.round(minPrice.keys * (keyScrap ?? 0)) + minPrice.scrap);
  if (Number.isFinite(scrap) && scrap > 0) out.minCeilingScrap = Math.round(scrap);
  return out;
}

// ---------------------------------------------------------------------------
// The loaded window (paging by 200, refreshed as a whole)
// ---------------------------------------------------------------------------

/** Rows one "Load more" adds. */
export const MARKET_PAGE = MARKET_DEFAULT_LIMIT;

/**
 * Most rows the page keeps loaded. Every live refresh re-reads the whole window in one
 * 'market.list' call, so it is exactly the most one call returns (H2); past it, filters or the
 * CSV export are the way in.
 */
export const MARKET_WINDOW_MAX = MARKET_MAX_LIMIT;

/**
 * The one request that (re)loads the first `size` rows (H2). A single read comes from one state of
 * the index, so a row moving while the window is read can be neither missed nor shown twice.
 */
export function windowRequest(size: number): { limit: number; offset: number } {
  return { limit: Math.max(1, Math.min(MARKET_WINDOW_MAX, Math.floor(Number.isFinite(size) ? size : MARKET_PAGE))), offset: 0 };
}

/**
 * The rows the next "Load more" adds after `loaded` of `total` (offset = loaded), or null when there
 * is nothing (more) to load. The window then re-reads its first offset + limit rows (createMarketWindow).
 */
export function nextPageRequest(loaded: number, total: number): { limit: number; offset: number } | null {
  const limit = Math.min(MARKET_PAGE, total - loaded, MARKET_WINDOW_MAX - loaded);
  return limit > 0 ? { limit, offset: loaded } : null;
}

/**
 * "Load more" onto the window shown: its rows keep their order and values (a live refresh re-sorts
 * them later, Freeze not at all), then every row of a fresh read of the grown window that is not
 * shown yet, in the fresh order. The fresh read starts at the top, so a row that rose across the
 * window's edge since it was read is appended, not skipped. Totals, counts and stats are the fresh read's.
 */
export function appendMarketRows(shown: MarketListResult, fresh: MarketListResult): MarketListResult {
  const seen = new Set<string>();
  const rows: MarketRow[] = [];
  for (const r of [...shown.rows, ...fresh.rows]) {
    if (seen.has(r.sku)) continue;
    seen.add(r.sku);
    rows.push(r);
  }
  return { ...fresh, rows: rows.slice(0, MARKET_WINDOW_MAX) };
}

export type MarketDisplayRow =
  | { type: 'item'; id: string; row: MarketRow }
  /** After the loaded rows when more match: "Load more", or a note once MARKET_WINDOW_MAX are shown. */
  | { type: 'more'; id: string; shown: number; total: number; capped: boolean };

export const MORE_ROW_ID = 'market:more';

/** The rows the virtual table renders, keyed by SKU so selection and DOM nodes follow the item. */
export function marketDisplayRows(rows: readonly MarketRow[], total: number): MarketDisplayRow[] {
  const out: MarketDisplayRow[] = rows.map((row) => ({ type: 'item', id: row.sku, row }));
  if (rows.length < total) out.push({ type: 'more', id: MORE_ROW_ID, shown: rows.length, total, capped: rows.length >= MARKET_WINDOW_MAX });
  return out;
}

/**
 * The scroll position after a refresh that re-sorted the rows. The rows the user was looking at
 * usually move together (an item appearing above shifts them all), so the median shift of the
 * visible rows is undone; one row jumping elsewhere moves nothing. At the top the view stays at
 * the top, so new leaders show.
 */
export function anchoredScrollTop(prevIds: readonly string[], nextIds: readonly string[], scrollTop: number, rowH: number, visibleRows: number): number {
  if (!(scrollTop > 0) || !(rowH > 0)) return scrollTop;
  const first = Math.floor(scrollTop / rowH);
  const span = Math.max(1, Math.floor(visibleRows));
  const pos = new Map<string, number>();
  nextIds.forEach((id, i) => pos.set(id, i));
  const shifts: number[] = [];
  for (let i = first; i < Math.min(prevIds.length, first + span); i++) {
    const j = pos.get(prevIds[i]!);
    if (j !== undefined) shifts.push(j - i);
  }
  if (!shifts.length) return scrollTop;
  shifts.sort((a, b) => a - b);
  const shift = shifts[Math.floor(shifts.length / 2)]!;
  return shift === 0 ? scrollTop : Math.max(0, scrollTop + shift * rowH);
}

// ---------------------------------------------------------------------------
// Flash: rows whose revenue or ceiling moved since the previous fetch
// ---------------------------------------------------------------------------

export type FlashDir = 'up' | 'down';

export type MarketSnapshot = ReadonlyMap<string, { revenueScrap: Scrap | null; maxCostScrap: Scrap | null }>;

/** How long a changed row stays marked; the CSS animation runs for the same time. */
export const FLASH_MS = 1600;

export function snapshotRows(rows: readonly Pick<MarketRow, 'sku' | 'revenueScrap' | 'maxCostScrap'>[]): Map<string, { revenueScrap: Scrap | null; maxCostScrap: Scrap | null }> {
  const out = new Map<string, { revenueScrap: Scrap | null; maxCostScrap: Scrap | null }>();
  for (const r of rows) out.set(r.sku, { revenueScrap: r.revenueScrap, maxCostScrap: r.maxCostScrap });
  return out;
}

function moved(a: Scrap | null, b: Scrap | null): FlashDir | null {
  if (a === b) return null;
  if (a === null) return 'up';
  if (b === null) return 'down';
  return b > a ? 'up' : 'down';
}

/**
 * Rows to flash and which way: the ceiling decides (it is what the user compares with), else the
 * revenue. Rows new to the window (first load, paging, a filter change) never flash.
 */
export function diffFlash(prev: MarketSnapshot | null, rows: readonly Pick<MarketRow, 'sku' | 'revenueScrap' | 'maxCostScrap'>[]): Map<string, FlashDir> {
  const out = new Map<string, FlashDir>();
  if (!prev) return out;
  for (const r of rows) {
    const p = prev.get(r.sku);
    if (!p) continue;
    const dir = moved(p.maxCostScrap, r.maxCostScrap) ?? moved(p.revenueScrap, r.revenueScrap);
    if (dir) out.set(r.sku, dir);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The loaded window's requests. Framework-free (the page's hook only forwards
// the events to React state), so the races between a new query, a live
// refresh, "Load more" and unmounting are unit-tested.
// ---------------------------------------------------------------------------

/** The loaded window: which query it answers, and when a full read of it last landed. */
export interface MarketWindowData {
  key: string;
  fetchedAt: UnixMs;
  result: MarketListResult;
}

export type MarketWindowBusy = 'reload' | 'more' | null;

export interface MarketWindowEvents {
  /** A window landed. `flash`: rows a live refresh of the same query moved (empty for a new query or an appended page). */
  data(d: MarketWindowData, flash: ReadonlyMap<string, FlashDir>): void;
  /** A full read failed; the rows already shown stay. */
  error(text: string): void;
  /** A "Load more" failed; the rows shown stay and the button re-arms. */
  moreError(text: string): void;
  busy(b: MarketWindowBusy): void;
}

export interface MarketWindow<Q extends MarketQuery = MarketQuery> {
  /** Filters or sort. A different query starts again from its first page and drops every answer still in flight. */
  setQuery(q: Q): void;
  /** A live change: re-read the whole loaded window. Waits for a request in flight instead of cancelling it. */
  refresh(): void;
  /** 200 more rows. Asked during a refresh, it runs once that lands (the refresh would replace it). */
  loadMore(): void;
  /**
   * Freeze. While held, the window shown stays exactly as it is: refresh() does nothing, a refresh
   * already queued is dropped, and one already in flight lands without being shown. A new query
   * (a filter change is the user's own action) and Load more still land. Release, then refresh().
   */
  hold(on: boolean): void;
  /** Unmount: answers still in flight are dropped and nothing more is sent. */
  dispose(): void;
}

export function createMarketWindow<Q extends MarketQuery = MarketQuery>(
  list: (q: Q) => Promise<MarketListResult>,
  ev: MarketWindowEvents,
  clock: () => UnixMs = Date.now,
): MarketWindow<Q> {
  let key: string | null = null;
  let query = {} as Q;
  let data: MarketWindowData | undefined;
  let size = MARKET_PAGE;
  let snapshot: MarketSnapshot | null = null;
  // Every request bumps seq and only the newest may land; `active` is what that request is.
  let seq = 0;
  let active: 'reload' | 'more' | null = null;
  let refreshQueued = false;
  let moreQueued = false;
  let held = false;
  let disposed = false;
  let busy: MarketWindowBusy = null;

  const call = (q: Q): Promise<MarketListResult> => {
    try {
      return list(q);
    } catch (e) {
      return Promise.reject(e);
    }
  };

  /** The first `n` rows of q's order, in one call (H2). */
  const readWindow = (q: Q, n: number): Promise<MarketListResult> => call({ ...q, ...windowRequest(n) });

  /** Held, and the window shown answers the current query (a first read still lands). */
  const holding = (): boolean => held && data !== undefined && data.key === key;

  const emitBusy = (): void => {
    const b: MarketWindowBusy = active === 'more' || moreQueued ? 'more' : active === 'reload' ? 'reload' : null;
    if (b === busy) return;
    busy = b;
    ev.busy(b);
  };

  const commit = (next: MarketWindowData, live: boolean): void => {
    const flash = live ? diffFlash(snapshot, next.result.rows) : new Map<string, FlashDir>();
    snapshot = snapshotRows(next.result.rows);
    data = next;
    ev.data(next, flash);
  };

  /** The newest request finished: run what waited for it. */
  const settle = (ok: boolean): void => {
    active = null;
    if (moreQueued) {
      moreQueued = false;
      if (ok) loadMore();
    }
    if (active === null && refreshQueued) reload();
    emitBusy();
  };

  function reload(): void {
    if (disposed || key === null) return;
    const id = ++seq;
    const k = key;
    const q = query;
    active = 'reload';
    // This read starts after every refresh asked for so far, so it answers them all.
    refreshQueued = false;
    emitBusy();
    readWindow(q, size).then(
      (result) => {
        if (disposed || id !== seq) return;
        const live = data?.key === k;
        // A live refresh that lands while held (sent before Freeze) is not shown.
        if (!(live && held)) commit({ key: k, fetchedAt: clock(), result }, live);
        settle(true);
      },
      (e: unknown) => {
        if (disposed || id !== seq) return;
        ev.error(errorMessage(e));
        settle(false);
      },
    );
  }

  function loadMore(): void {
    if (disposed || active === 'more') return;
    if (active === 'reload') {
      // Only a refresh of the query shown; a new query's first page is not extended before it lands.
      if (data !== undefined && data.key === key) {
        moreQueued = true;
        emitBusy();
      }
      return;
    }
    const cur = data;
    if (!cur || cur.key !== key) return;
    const req = nextPageRequest(cur.result.rows.length, cur.result.total);
    if (!req) return;
    const id = ++seq;
    active = 'more';
    emitBusy();
    // The grown window from the top, in one state: a page cut at offset `loaded` from an order
    // that moved since the window was read would skip a row that rose across the edge.
    readWindow(query, req.offset + req.limit).then(
      (fresh) => {
        if (disposed || id !== seq) return;
        // Nothing else lands while this read is in flight, so `cur` is still the window shown.
        const result = appendMarketRows(cur.result, fresh);
        size = Math.min(MARKET_WINDOW_MAX, Math.max(size, result.rows.length));
        // Same fetchedAt: rows were added, the ones shown were not re-read (Freeze's count keys on it).
        commit({ ...cur, result }, false);
        settle(true);
      },
      (e: unknown) => {
        if (disposed || id !== seq) return;
        ev.moreError(`Could not load more items: ${errorMessage(e)}`);
        settle(false);
      },
    );
  }

  return {
    setQuery(q) {
      const k = JSON.stringify(q);
      if (disposed || k === key) return;
      key = k;
      query = q;
      size = MARKET_PAGE;
      moreQueued = false;
      reload();
    },
    refresh() {
      if (disposed || key === null || holding()) return;
      if (active !== null) refreshQueued = true;
      else reload();
    },
    loadMore,
    hold(on) {
      held = on;
      if (on) refreshQueued = false;
    },
    dispose() {
      disposed = true;
      seq++;
      active = null;
      refreshQueued = false;
      moreQueued = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Labels, pills and cells
// ---------------------------------------------------------------------------

export const VERDICT_LABELS: Record<MarketVerdict, string> = {
  flip: 'Flip',
  'rule-flip': 'Rule flip',
  unchecked: 'Not checked',
  over: 'Over',
  'no-buyers': 'No buyers',
};

export const VERDICT_TONES: Record<MarketVerdict, Tone> = {
  flip: 'good',
  'rule-flip': 'warn',
  unchecked: 'muted',
  over: 'bad',
  'no-buyers': 'muted',
};

/** Chip tooltips. */
export const VERDICT_HELP: Record<MarketVerdict, string> = {
  flip: 'Your scrap.tf price is at or under Pay up to: buy it there, sell to the buyer here.',
  'rule-flip': 'No price of yours, but a price-sheet rule estimates one at or under Pay up to. Check scrap.tf.',
  unchecked: 'Buyers exist and you have no scrap.tf price for the item. Anything at or under Pay up to is a flip.',
  over: 'Your scrap.tf price is above Pay up to, or no price clears your thresholds against these buyers.',
  'no-buyers': 'You priced the item, but no eligible backpack.tf buy orders are in the live book.',
};

export const SOURCE_LABELS: Record<MarketSource, string> = {
  page: 'Seen on scrap.tf',
  typed: 'Typed',
  none: 'None',
};

export const SOURCE_HINTS: Record<MarketSource, string> = {
  page: 'from saved pages',
  typed: 'prices you typed',
  none: 'no price of yours',
};

export const SORT_LABELS: Record<MarketSort, string> = {
  ceiling: 'Pay up to',
  revenue: 'Sells for',
  buyers: 'Buyers',
  profit: 'Profit',
  updated: 'Updated',
  name: 'Name',
};

export interface VerdictPill {
  tone: Tone;
  text: string;
  title: string;
}

/** The Verdict cell: "Flip +1.33 ref", "Over by 2 ref", "Rule flip", "Not checked", "No buyers". */
export function verdictPill(
  r: Pick<MarketRow, 'verdict' | 'profitScrap' | 'knownCostScrap' | 'maxCostScrap' | 'ruleCostScrap'>,
  keyScrap: Scrap | null,
): VerdictPill {
  const tone = VERDICT_TONES[r.verdict];
  const ceiling = r.maxCostScrap;
  switch (r.verdict) {
    case 'flip':
      return {
        tone,
        text: r.profitScrap !== null ? `Flip ${fmtSignedMoney(r.profitScrap, keyScrap)}` : 'Flip',
        title:
          `Your scrap.tf price ${fmtMoney(r.knownCostScrap, keyScrap)} is at or under Pay up to ${fmtMoney(ceiling, keyScrap)}.` +
          (r.profitScrap !== null ? ` Profit ${fmtSignedMoney(r.profitScrap, keyScrap)} after friction.` : ''),
      };
    case 'over':
      if (ceiling !== null && r.knownCostScrap !== null) {
        const by = r.knownCostScrap - ceiling;
        return {
          tone,
          text: `Over by ${fmtMoney(by, keyScrap)}`,
          title: `Your scrap.tf price ${fmtMoney(r.knownCostScrap, keyScrap)} is ${fmtMoney(by, keyScrap)} over Pay up to (${fmtMoney(ceiling, keyScrap)}): not a flip at that price.`,
        };
      }
      return { tone, text: 'Over', title: 'Buyers exist, but no scrap.tf price clears your thresholds against them.' };
    case 'rule-flip':
      return {
        tone,
        text: 'Rule flip',
        title: `A price-sheet rule estimates ${fmtMoney(r.ruleCostScrap, keyScrap)}, at or under Pay up to ${fmtMoney(ceiling, keyScrap)}. Check the real price and stock on scrap.tf.`,
      };
    case 'unchecked':
      return {
        tone,
        text: 'Not checked',
        title:
          ceiling !== null
            ? `No scrap.tf price of yours. On scrap.tf, anything at or under ${fmtMoney(ceiling, keyScrap)} is a flip.`
            : 'No scrap.tf price of yours, and no price clears your thresholds against these buyers.',
      };
    case 'no-buyers':
      return { tone, text: 'No buyers', title: VERDICT_HELP['no-buyers'] };
  }
}

export interface YourPriceCell {
  kind: 'known' | 'rule' | 'none';
  scrap: Scrap | null;
  /** "page", "typed" or "rule"; null without any price. */
  badge: 'page' | 'typed' | 'rule' | null;
  /** "4 min" since the price was typed or the page saved. */
  age: string | null;
  /** "×3": the saved page's stock. */
  stock: string | null;
  tone: 'good' | 'bad' | null;
  title: string;
}

/** The "Your scrap.tf price" cell: the known price with its source and age, else a rule estimate. */
export function yourPriceCell(
  r: Pick<MarketRow, 'knownCostScrap' | 'knownSource' | 'knownObservedAt' | 'stock' | 'ruleCostScrap' | 'verdict' | 'flags'>,
  keyScrap: Scrap | null,
  now: UnixMs,
): YourPriceCell {
  if (r.knownCostScrap !== null && r.knownSource !== 'none') {
    const page = r.knownSource === 'page';
    const age = r.knownObservedAt !== null ? fmtAge(now - r.knownObservedAt) : null;
    const stock = page && r.stock !== null && Number.isFinite(r.stock) ? `×${fmtInt(r.stock)}` : null;
    const when = r.knownObservedAt !== null ? `, ${fmtAgo(r.knownObservedAt, now)}` : '';
    const parts = [
      `${page ? 'From a saved scrap.tf page' : 'Typed by you'}: ${fmtMoney(r.knownCostScrap, keyScrap)}${when}.`,
      stock ? `${fmtInt(r.stock)} in stock on that page.` : null,
      r.flags.includes('has-extras') ? 'That price is for a painted or spelled copy; Pay up to is for a clean one.' : null,
    ];
    return {
      kind: 'known',
      scrap: r.knownCostScrap,
      badge: page ? 'page' : 'typed',
      age,
      stock,
      tone: r.verdict === 'flip' ? 'good' : r.verdict === 'over' ? 'bad' : null,
      title: parts.filter(Boolean).join(' '),
    };
  }
  if (r.ruleCostScrap !== null) {
    return {
      kind: 'rule',
      scrap: r.ruleCostScrap,
      badge: 'rule',
      age: null,
      stock: null,
      tone: null,
      title: `Rule estimate ${fmtMoney(r.ruleCostScrap, keyScrap)}: the lowest of your enabled price-sheet rules that match. Not a price you saw; check scrap.tf.`,
    };
  }
  return {
    kind: 'none',
    scrap: null,
    badge: null,
    age: null,
    stock: null,
    tone: null,
    title: 'No scrap.tf price of yours. Browse scrap.tf in your own browser, then type the price or save the page.',
  };
}

/** Tooltip for "Sells for": the buyer, the three prices and how many buyers there are. */
export function marketSellsForTitle(r: Pick<MarketRow, 'revenueScrap' | 'bestScrap' | 'consScrap' | 'instantScrap' | 'revenueOrder' | 'buyerCount' | 'flags'>, keyScrap: Scrap | null): string {
  if (r.revenueScrap === null) return r.buyerCount > 0 ? 'Every eligible order looks unrealistic, so no revenue is assumed.' : 'No eligible backpack.tf buy orders in the live book.';
  const o = r.revenueOrder;
  const online = o ? (o.online === true ? 'online' : o.online === false ? 'offline' : 'online status unknown') : null;
  const who = o ? ` to ${o.userName || o.steamid} (${o.isBot ? 'bot' : 'human'}, ${online})` : '';
  const best = `${fmtMoney(r.bestScrap, keyScrap)}${r.flags.includes('outlier-best') ? ' (outlier)' : ''}`;
  const buyers = `${fmtInt(r.buyerCount)} ${r.buyerCount === 1 ? 'buyer' : 'buyers'} with eligible orders.`;
  return `Sells for ${fmtMoney(r.revenueScrap, keyScrap)}${who}. Conservative ${fmtMoney(r.consScrap, keyScrap)}, best ${best}, instant ${fmtMoney(r.instantScrap, keyScrap)}. ${buyers}`;
}

/** Tooltip for "Pay up to". */
export function marketPayTitle(r: Pick<MarketRow, 'maxCostScrap' | 'buyerCount'>, keyScrap: Scrap | null): string {
  if (r.maxCostScrap !== null) return `Pay up to ${fmtMoney(r.maxCostScrap, keyScrap)} on scrap.tf: the highest price that still clears your thresholds.`;
  return r.buyerCount > 0 ? 'No scrap.tf price clears your thresholds against these buyers.' : 'No eligible buy orders, so there is no ceiling.';
}

// ---------------------------------------------------------------------------
// Header strip
// ---------------------------------------------------------------------------

export interface LiveState {
  state: ConnState;
  label: string;
  title: string;
}

/** The live dot: the feed's state, with pause and the feed switch taking precedence. */
export function marketLiveState(feed: ConnState | null | undefined, paused: boolean, feedOff: boolean): LiveState {
  if (paused) return { state: 'paused', label: 'Paused', title: 'The network is paused: no buy orders arrive and the market stays as it was.' };
  if (feedOff) return { state: 'off', label: 'Feed off', title: 'The backpack.tf live feed is off (Settings): the market only changes when you refresh items by hand.' };
  const state = feed ?? 'connecting';
  return { state, label: CONN_STATE_LABELS[state] ?? state, title: 'backpack.tf live buy-order feed. Rows update as orders change; nothing is fetched for this page.' };
}

/** One market.changed push as the page saw it. */
export interface Pulse {
  at: UnixMs;
  changed: number;
}

export const PULSE_WINDOW_MS = 60_000;
/** The service pushes at most once per 2 s, so a minute holds about 30. */
const MAX_PULSES = 64;

/** Adds a push and forgets those older than a minute. */
export function addPulse(list: readonly Pulse[], p: Pulse, now: UnixMs): Pulse[] {
  const next = list.filter((x) => now - x.at < PULSE_WINDOW_MS && x.at <= now);
  next.push({ at: p.at, changed: Math.max(0, Math.floor(Number.isFinite(p.changed) ? p.changed : 0)) });
  return next.slice(-MAX_PULSES);
}

/** Pushes and changed rows in the last minute. */
export function pulseRate(list: readonly Pulse[], now: UnixMs): { pushes: number; changed: number } {
  let pushes = 0;
  let changed = 0;
  for (const p of list) {
    if (now - p.at >= PULSE_WINDOW_MS || p.at > now) continue;
    pushes++;
    changed += p.changed;
  }
  return { pushes, changed };
}

/** "38 updates/min", with what it counts in the tooltip. */
export function liveRateText(rate: { pushes: number; changed: number }): { text: string; title: string } {
  return {
    text: `${fmtInt(rate.changed)} ${rate.changed === 1 ? 'update' : 'updates'}/min`,
    title: `${fmtInt(rate.changed)} ${rate.changed === 1 ? 'row' : 'rows'} changed in the last minute (best buyer, Pay up to or buyer count), in ${fmtInt(rate.pushes)} ${rate.pushes === 1 ? 'push' : 'pushes'}.`,
  };
}

/** "Last change 12 s ago", from the newest of the index's own time and the pushes seen. */
export function lastChangeText(lastAt: UnixMs | null, now: UnixMs): string {
  return lastAt === null ? 'No changes yet' : `Last change ${fmtAgo(lastAt, now)}`;
}

/** Whole percent of a 0..1 progress, clamped. */
export function buildPercent(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.floor(progress * 100))) : 0;
}

/**
 * H1: the index's rebuild could not read the local database. "Could not read the local database
 * (<error>). Retrying in 42 s." from MarketStats.lastError and retryAt; null while it is fine.
 */
export function marketErrorText(s: Pick<MarketStats, 'lastError' | 'retryAt'>, now: UnixMs): string | null {
  if (s.lastError === null || s.lastError === undefined) return null;
  const why = s.lastError.trim() || 'unknown error';
  const retry =
    s.retryAt === null || s.retryAt === undefined || !Number.isFinite(s.retryAt) ? 'It is retried shortly.' : s.retryAt - now >= 1000 ? `Retrying in ${fmtCountdown(s.retryAt, now)}.` : 'Retrying now.';
  return `Could not read the local database (${why}). ${retry}`;
}

/** The index part of the strip: "Building 43 %…", "12,345 items with buyers", or the H1 error. */
export function indexStateText(s: MarketStats, now: UnixMs): { text: string; title: string; building: boolean; percent: number | null; error: boolean } {
  const failed = marketErrorText(s, now);
  if (failed !== null) {
    // Not "Building 0 %": the rebuild is waiting for its retry, and the rows shown are the last good ones.
    const kept = s.entries > 0 ? ` The ${fmtInt(s.entries)} ${s.entries === 1 ? 'item' : 'items'} shown are from the last good read.` : '';
    return { text: failed, title: `${failed}${kept} Nothing is downloaded for this; the file is on this computer.`, building: false, percent: null, error: true };
  }
  if (s.building) {
    const pct = buildPercent(s.progress);
    return {
      text: `Building ${pct} %…`,
      title: `Reading the local buy-order book into the market (${fmtInt(s.entries)} items so far). Rows from before stay until it finishes. Nothing is downloaded for this.`,
      building: true,
      percent: pct,
      error: false,
    };
  }
  const parts = [`${fmtInt(s.entries)} ${s.entries === 1 ? 'item has' : 'items have'} eligible buyers in the local book.`];
  if (s.lastFullAt !== null) parts.push(`Last full rebuild ${fmtAgo(s.lastFullAt, now)}; changed items are re-checked within seconds.`);
  if (s.pendingDirty > 0) parts.push(`${fmtInt(s.pendingDirty)} queued.`);
  return { text: `${fmtInt(s.entries)} ${s.entries === 1 ? 'item' : 'items'} with buyers`, title: parts.join(' '), building: false, percent: null, error: false };
}

/**
 * How often the page re-reads the index on its own: every 2 s while the first build runs (its
 * progress moves between pushes), every 5 s while a failed rebuild waits for its retry (a retry
 * that fails again pushes nothing), else never (pushes drive it).
 */
export function marketPollMs(s: Pick<MarketStats, 'building' | 'lastError'> | null | undefined): number | null {
  if (!s) return null;
  if (s.lastError !== null && s.lastError !== undefined) return 5000;
  return s.building ? 2000 : null;
}

// ---------------------------------------------------------------------------
// scrap.tf saved-page coverage strip (F13)
// ---------------------------------------------------------------------------

/** A bank page saved this recently reads green ... */
export const COVERAGE_FRESH_MS = 15 * 60_000;
/** ... this recently amber; older (or never) muted. */
export const COVERAGE_AGING_MS = 2 * 3_600_000;

/** F15: a chip opens its card on the scrap.tf banks page, which has Open in browser for the next save. */
export const COVERAGE_TIP = `See this page on the scrap.tf banks page: its flips, what to look for there, and Open in browser to save it again (Ctrl+S, as '${SAVE_MODE}')`;

export type CoverageTone = 'good' | 'warn' | 'muted';

/** Freshness of a bank page's newest saved copy: green ≤ 15 min, amber ≤ 2 h, muted older or never. */
export function coverageTone(lastSavedAt: UnixMs | null, now: UnixMs): CoverageTone {
  if (lastSavedAt === null || !Number.isFinite(lastSavedAt)) return 'muted';
  // A file time slightly ahead of the clock (another machine's mtime) is as fresh as now.
  const age = Math.max(0, now - lastSavedAt);
  if (age <= COVERAGE_FRESH_MS) return 'good';
  if (age <= COVERAGE_AGING_MS) return 'warn';
  return 'muted';
}

export interface CoverageChip {
  /** 'page': one scrap.tf bank page (F13); 'list': the whole scrap.tf/items price list (F14, allItemsChip). */
  kind: 'page' | 'list';
  label: string;
  /** "saved 4 min ago · 48 items" or "never saved". */
  status: string;
  tone: CoverageTone;
  /** F15: the bank whose card a click opens on the scrap.tf banks page; null for a page the dashboard does not know. */
  bank: ScraptfBank | null;
  /** The static page. The chip no longer opens it: the banks page card does, through links.open. */
  url: string;
  title: string;
  ariaLabel: string;
}

/** The bank a coverage entry stands for: by its static address, else by its category (the items page is 'other'). */
export function coverageBank(c: { url: string; category?: Category | undefined }): ScraptfBank | null {
  const byUrl = SCRAPTF_BANKS.find((b) => b.categories.length > 0 && b.url === c.url);
  if (byUrl) return byUrl.bank;
  return c.category !== undefined && (CATEGORIES as readonly string[]).includes(c.category) ? bankForCategory(c.category) : null;
}

/** One chip of the strip; clicking it opens that bank's card on the scrap.tf banks page (F15). */
export function coverageChip(c: Pick<ScraptfCoverage, 'label' | 'url' | 'lastSavedAt' | 'items'> & Partial<Pick<ScraptfCoverage, 'category'>>, now: UnixMs): CoverageChip {
  const saved = c.lastSavedAt !== null && Number.isFinite(c.lastSavedAt);
  const items = Number.isFinite(c.items) ? Math.max(0, Math.round(c.items)) : 0;
  const status = saved ? `saved ${fmtAgo(Math.min(c.lastSavedAt!, now), now)} · ${fmtInt(items)} ${items === 1 ? 'item' : 'items'}` : 'never saved';
  return {
    kind: 'page',
    label: c.label,
    status,
    tone: coverageTone(c.lastSavedAt, now),
    bank: coverageBank(c),
    url: c.url,
    title: COVERAGE_TIP,
    ariaLabel: `${c.label}: ${status}. Opens its card on the scrap.tf banks page.`,
  };
}

/** The strip's chips, or none when import is off (the strip hides; "Set up Import" stays). */
export function coverageChips(s: Pick<MarketListResult['scraptf'], 'importEnabled' | 'coverage'> | null | undefined, now: UnixMs): CoverageChip[] {
  if (!s?.importEnabled || !Array.isArray(s.coverage)) return [];
  return s.coverage.map((c) => coverageChip(c, now));
}

/**
 * The scrap.tf side in one line: "Your scrap.tf data: 12 typed, 30 from saved pages (newest page
 * 4 min ago). Folder watch on." All of it is what the user typed or saved; the app never visits scrap.tf.
 */
export function scraptfSideText(s: MarketListResult['scraptf'], now: UnixMs): { text: string; watch: 'on' | 'off' | 'import-off' } {
  const newest = s.newestPageAt !== null ? ` (newest page ${fmtAgo(s.newestPageAt, now)})` : '';
  const watch: 'on' | 'off' | 'import-off' = !s.importEnabled ? 'import-off' : s.watchFolder ? 'on' : 'off';
  const watchText = watch === 'on' ? 'Folder watch on.' : watch === 'off' ? 'Folder watch off.' : 'Saved-page import is off.';
  return { text: `Your scrap.tf data: ${fmtInt(s.typed)} typed, ${fmtInt(s.pages)} from saved pages${newest}. ${watchText}`, watch };
}

/** Shown once on the page until dismissed. */
export const BOUNDARY_NOTE = 'The app never visits scrap.tf. Browse it yourself; prices you type or pages you save show up here.';

/** "No updates waiting", "1 update waiting", "38 updates waiting". */
export function waitingText(n: number): string {
  if (!(n > 0)) return 'No updates waiting';
  return `${fmtInt(n)} ${n === 1 ? 'update' : 'updates'} waiting`;
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

export type EmptyMarketReason = 'error' | 'building' | 'paused' | 'feed-off' | 'filters' | 'nothing-yet';

/**
 * Why an empty market is empty. An index that could not read the local database says so (H1),
 * then a build in progress explains itself; an empty index with the feed stopped is the feed's
 * fault whatever the filters say. `knownItems` (items you priced, from MarketListResult.scraptf)
 * tells an empty market from one the filters hide: with no buyers and no prices of yours there
 * is nothing to filter yet.
 */
export function emptyMarketReason(a: {
  filters: MarketFilters;
  stats: (Pick<MarketStats, 'building' | 'entries'> & Partial<Pick<MarketStats, 'lastError'>>) | null;
  paused: boolean;
  feedOff: boolean;
  knownItems?: number;
}): EmptyMarketReason {
  const indexEmpty = (a.stats?.entries ?? 0) === 0;
  if (indexEmpty && a.stats?.lastError !== null && a.stats?.lastError !== undefined) return 'error';
  if (a.stats?.building) return 'building';
  if (indexEmpty && a.paused) return 'paused';
  if (indexEmpty && a.feedOff) return 'feed-off';
  if (indexEmpty && a.knownItems === 0) return 'nothing-yet';
  if (activeMarketFilterCount(a.filters) > 0) return 'filters';
  if (a.paused) return 'paused';
  if (a.feedOff) return 'feed-off';
  return 'nothing-yet';
}

// ---------------------------------------------------------------------------
// F17: bank stock in the Live market and the item drawer (spec S4, U3). Both read
// what the service joined from the user's two newest saves of each scrap.tf page
// (MarketRow.scraptfNewAt, ItemDetail.bankStock); nothing here loads a page (R1).
// ---------------------------------------------------------------------------

/** The Source popover's switch (MarketFilters.newOnScraptf -> MarketQuery.newOnScraptf; spec S4's source 'new'). */
export const NEW_ON_SCRAPTF_LABEL = 'New on scrap.tf';
export const NEW_ON_SCRAPTF_HINT = 'since your previous save';
export const NEW_ON_SCRAPTF_TITLE =
  'Only items on sale in your newest save of a scrap.tf bank page that your previous save of that page did not have (or had sold out). From pages you saved; the app never visits scrap.tf.';

/** A "New" badge from a save older than this reads muted: scrap.tf has had a day to sell it since. */
export const SCRAPTF_NEW_FRESH_MS = 24 * 3_600_000;

export interface ScraptfNewBadge {
  text: string;
  tone: Tone;
  title: string;
}

/**
 * The Item cell's "New" badge for MarketRow.scraptfNewAt (the newest save of a scrap.tf page in which
 * the item is new), or null. It sits in the Item cell: the grid's column budget is test-pinned.
 */
export function scraptfNewBadge(r: Pick<MarketRow, 'scraptfNewAt'>, now: UnixMs): ScraptfNewBadge | null {
  const at = r.scraptfNewAt;
  if (at === null || at === undefined || !Number.isFinite(at)) return null;
  // A file time slightly ahead of the clock (another machine's mtime) is as fresh as now.
  const shown = Math.min(at, now);
  return {
    text: 'New',
    tone: now - shown <= SCRAPTF_NEW_FRESH_MS ? 'info' : 'muted',
    // Per base SKU across every bank (bankStockNewAt), while the drawer names the newest save listing this
    // exact copy (often a later scrap.tf/items save where it is unchanged): say so, or the two read as a
    // contradiction.
    title: `New on scrap.tf: on sale in a scrap.tf page you saved ${fmtAgo(shown, now)} (${fmtDateTime(at)}) that your previous save of the same page did not have, or had sold out (this item or a copy of it with paint or other extras). The item's details show your newest save that lists this exact item, which can be another page. Stock between your saves is unknown; the app never visits scrap.tf.`,
  };
}

/** F20's Source switch (MarketFilters.listedOnScraptf -> MarketQuery.listedOnScraptf; the shared marketListedSideMatches decides). */
export const LISTED_ON_SCRAPTF_LABEL = 'Listed on scrap.tf > 24 h';
export const LISTED_ON_SCRAPTF_HINT = 'in your saves';
export const LISTED_ON_SCRAPTF_TITLE =
  'Only items that every one of your saves of the scrap.tf bank page they were seen on has listed on sale for at least a day, without a break. What happened between two saves is unknown. From pages you saved; the app never visits scrap.tf.';

/** The empty table's advice when the filters hide everything; the F17 and F20 switches say what they need. */
export function emptyFiltersText(f: Pick<MarketFilters, 'newOnScraptf'> & Partial<Pick<MarketFilters, 'listedOnScraptf'>>): string {
  const base = 'Clear the search or the verdict chips, or lower the minimums. Items without buyers show only when you have a scrap.tf price for them.';
  const parts: string[] = [];
  if (f.newOnScraptf) {
    parts.push(
      `${NEW_ON_SCRAPTF_LABEL} (under Source) keeps only items new in your newest save of a scrap.tf page. Save the page again later (Ctrl+S into your watch folder, as '${SAVE_MODE}') to see what changed, or untick it.`,
    );
  }
  if (f.listedOnScraptf) {
    parts.push(`${LISTED_ON_SCRAPTF_LABEL} (under Source) keeps only items your saves have listed on sale for a day or more. Save your bank pages regularly to build that history, or untick it.`);
  }
  return parts.length ? `${parts.join(' ')} ${base}` : base;
}

/** U2's stock page of a bank, "banks/hats/stock" (#/banks/<bank>/stock, under banksModel's BANKS_ROUTE); null for an unknown bank. */
export function bankStockRoute(bank: ScraptfBank | null | undefined): string | null {
  const info = scraptfBankInfo(bank);
  return info ? `banks/${info.bank}/stock` : null;
}

export interface DrawerBankStockLine {
  bank: ScraptfBank;
  /** The line up to its change: "On scrap.tf/buy/hats in your save 12 min ago: 3 in stock, ". */
  prefix: string;
  /** "new since your previous save", "↓ cheaper than before (was 1.33 ref)", ...; null when unchanged or on a first save. */
  change: string | null;
  tone: Tone | null;
  /** prefix + change: the whole line. */
  text: string;
  title: string;
  /** The bank's stock page (bankStockRoute). */
  route: string;
}

const BANK_STOCK_CHANGE_TONES: Record<Exclude<ItemBankStock['change'], null>, Tone> = { new: 'info', cheaper: 'good', pricier: 'warn', gone: 'muted' };

/**
 * The drawer's line for ItemDetail.bankStock: "On scrap.tf/buy/hats in your save 12 min ago: 3 in stock,
 * new since your previous save", "...: 3 in stock, ↓ cheaper than before (was 1.33 ref)", "...: sold out,
 * gone since your previous save (was X)", or "Not on scrap.tf/buy/hats in your save 12 min ago: gone since
 * your previous save (was X)" for a copy that save no longer lists. Static labels and paths only
 * (SCRAPTF_BANKS), whatever the service sent; null without a bank stock save that lists the item.
 */
export function drawerBankStockLine(b: ItemBankStock | null | undefined, keyScrap: Scrap | null, now: UnixMs): DrawerBankStockLine | null {
  const info = scraptfBankInfo(b?.bank);
  const route = bankStockRoute(info?.bank);
  if (!b || !info || route === null) return null;
  const path = bankStockPagePath(info.url);
  const dated = typeof b.savedAt === 'number' && Number.isFinite(b.savedAt);
  const save = dated ? `your save ${fmtAgo(Math.min(b.savedAt, now), now)}` : 'your newest save';
  const stock = typeof b.stock === 'number' && Number.isFinite(b.stock) ? (b.stock > 0 ? `${fmtInt(b.stock)} in stock` : 'sold out') : null;
  const prev = b.previousCostScrap;
  const was = typeof prev === 'number' && Number.isFinite(prev) ? ` (was ${fmtMoney(prev, keyScrap)})` : '';
  let change: string | null = null;
  switch (b.change) {
    case 'new':
      change = 'new since your previous save';
      break;
    case 'cheaper':
      change = `↓ cheaper than before${was}`;
      break;
    case 'pricier':
      change = `↑ pricier than before${was}`;
      break;
    case 'gone':
      change = `gone since your previous save${was}`;
      break;
    default:
      change = null;
  }
  // Gone and absent from the newest save (no stock to show): the item is not on that page any more.
  const lead = `${b.change === 'gone' && stock === null ? 'Not on' : 'On'} ${path} in ${save}`;
  const prefix = change === null ? (stock === null ? lead : `${lead}: ${stock}`) : `${lead}: ${stock === null ? '' : `${stock}, `}`;
  const when = dated ? ` (${fmtDateTime(b.savedAt)})` : '';
  // Without a change, a previous price means the same price (a stock move alone is no change, and
  // ItemBankStock has no previous stock to show); none, a first save (or no price before).
  const compared =
    change !== null
      ? 'Compared with your previous save of it (prices at the current key price).'
      : was
        ? 'Same price as in your previous save of it.'
        : 'Nothing to compare: your first save of it, or the item had no price in your previous save.';
  return {
    bank: info.bank,
    prefix,
    change,
    tone: b.change === null ? null : (BANK_STOCK_CHANGE_TONES[b.change] ?? null),
    text: prefix + (change ?? ''),
    title: `From your saved copy of ${path}${when}. ${compared} Stock between your saves is unknown. The app never visits scrap.tf; save the page again (Ctrl+S, as '${SAVE_MODE}') to update this.`,
    route,
  };
}

// ---------------------------------------------------------------------------
// F19: the Live market's link to scrap.tf (spec U1, U2). Out: a static bank page
// from SCRAPTF_BANKS, whatever a row carries, handed to the user's own browser
// by links.open on a click or a key. Back: the price the user copies there,
// through the Live check. Nothing here loads scrap.tf (R1).
// ---------------------------------------------------------------------------

/** The grid's key for a row's scrap.tf button (no modifier, no repeat). */
export const MARKET_SCRAPTF_KEY = 'o';

export interface MarketScraptfButton {
  bank: ScraptfBank;
  /** The SCRAPTF_BANKS page for `bank`: never a URL taken from the row. */
  url: string;
  /** "scrap.tf/buy/hats". */
  path: string;
  /** The bank's short label: "Hats". */
  label: string;
  /** What is copied for scrap.tf's search, and armed with ('check.arm'). */
  name: string;
  /** A saved page listed the item (MarketRow.scraptfLink.source 'seen'); else its category's bank. */
  seen: boolean;
  title: string;
  ariaLabel: string;
}

/** The SCRAPTF_BANKS entry a row's link names, else its category's bank (a garbled or older row). */
function rowBank(r: Pick<MarketRow, 'category' | 'scraptfLink'>): ScraptfBankInfo {
  return scraptfBankInfo(r.scraptfLink?.bank) ?? scraptfBankInfo(bankForCategory(r.category))!;
}

/**
 * U1: the Item cell's scrap.tf button. "Seen on scrap.tf/buy/hats in your save 12 min ago" when a saved
 * page listed the item, else "scrap.tf's Hats bank (not in your saves yet)"; either way it opens that
 * page and copies the name. The URL is the bank's static one: links.open only ever gets an allowlisted page.
 */
export function marketScraptfButton(r: Pick<MarketRow, 'sku' | 'name' | 'category' | 'scraptfLink'>, now: UnixMs): MarketScraptfButton {
  const info = rowBank(r);
  const path = bankStockPagePath(info.url);
  const link = r.scraptfLink;
  const at = link?.seenAt;
  const seen = link?.source === 'seen' && link.bank === info.bank && typeof at === 'number' && Number.isFinite(at);
  // A file time slightly ahead of the clock (another machine's mtime) reads as just now.
  const where = seen ? `Seen on ${path} in your save ${fmtAgo(Math.min(at, now), now)}.` : `scrap.tf's ${info.label} bank (not in your saves yet).`;
  return {
    bank: info.bank,
    url: info.url,
    path,
    label: info.label,
    name: scraptfSearchName(r),
    seen,
    title: `${where} Opens it and copies the name (${MARKET_SCRAPTF_KEY}). The app never visits scrap.tf.`,
    // Starts with the visible label (WCAG 2.5.3): "click All items" by voice must find the button.
    ariaLabel: `${info.label}: open ${path} in your browser and copy the name`,
  };
}

/**
 * U2: the one scrap.tf bank the category filter covers, a bank card's "See all" route included (its
 * categories); null for every category (no filter) or categories of several banks.
 */
export function marketSingleBank(categories: readonly Category[]): ScraptfBankInfo | null {
  const known = pickOrdered(categories, CATEGORIES);
  if (!known.length) return null;
  const banks = new Set(known.map(bankForCategory));
  return banks.size === 1 ? scraptfBankInfo([...banks][0]) : null;
}

export interface MarketBankLink {
  bank: ScraptfBank;
  url: string;
  /** "Open scrap.tf/buy/hats" (the page shows "↗" after it). */
  text: string;
  title: string;
  ariaLabel: string;
}

/** U2: the header's "Open scrap.tf/buy/<bank> ↗" while the market shows one bank's items; null otherwise. */
export function marketBankLink(categories: readonly Category[]): MarketBankLink | null {
  const info = marketSingleBank(categories);
  if (!info) return null;
  const path = bankStockPagePath(info.url);
  return {
    bank: info.bank,
    url: info.url,
    text: `Open ${path}`,
    title: `Opens scrap.tf's ${info.label} bank in your browser, to look for these items there. The app never visits scrap.tf.`,
    ariaLabel: `Open ${path} in your browser`,
  };
}
