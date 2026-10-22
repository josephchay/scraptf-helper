// Pure filtering, sorting and grouping of opportunities for the dashboard table.
// The service filters and pages; grouping for display is done here so the table
// never depends on the order in which the service returns rows.

import type {
  Category,
  ConfidenceLevel,
  GroupBy,
  GroupSummary,
  InputKind,
  OppQuery,
  Opportunity,
  OpportunityStatus,
  OrderSummary,
  ProfitSettings,
  ProfitTier,
  Scrap,
  ScrapPrice,
  UnixMs,
} from '../shared/types';
import { buyerPresenceText } from '../shared/buyerSeen';
import {
  SINGLE_EXIT_TEXT,
  buyerDepthOf,
  exitOrdersOfSummaries,
  flipProfit,
  profitStatus,
  reservePctOf,
  singleExitOf,
  type CeilingSettings,
  type ProfitBreakdown,
} from '../shared/ceiling';
import { copyExtrasWords, onceByOrderProfit, opportunityCopyKey } from '../shared/copyExtras';
import { CATEGORIES, CATEGORY_LABELS, PROFIT_TIER_LABELS } from '../shared/types';
import { CONFIDENCE_LABELS, INPUT_KIND_LABELS, PAINT_NAMES, fmtMoney, fmtSignedMoney, paintHex, ratioPctText } from './format';

export type SortKey = NonNullable<OppQuery['sort']>;
export type SortDir = NonNullable<OppQuery['dir']>;

export const TIER_ORDER: readonly ProfitTier[] = ['key', 'ref10', 'ref2', 'small', 'loss', 'none'];
export const CONFIDENCE_ORDER: readonly ConfidenceLevel[] = ['high', 'medium', 'low'];
export const INPUT_ORDER: readonly InputKind[] = ['user', 'import', 'rule'];
export const STATUS_ORDER: readonly OpportunityStatus[] = ['profitable', 'below-threshold', 'unprofitable', 'no-buyers'];

export const GROUP_BY_LABELS: Record<GroupBy, string> = {
  category: 'Category',
  tier: 'Profit tier',
  confidence: 'Confidence',
  input: 'Input',
};

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** What the filter bar edits; converted to an OppQuery for the service. */
export interface OppFilters {
  search: string;
  categories: Category[];
  tiers: ProfitTier[];
  minConfidence: number;
  inputKinds: InputKind[];
  status: OpportunityStatus[];
}

export const DEFAULT_FILTERS: Readonly<OppFilters> = Object.freeze<OppFilters>({
  search: '',
  categories: [],
  tiers: [],
  minConfidence: 0,
  inputKinds: [],
  status: ['profitable'],
});

/** 0.7.3: same cap as 'opps.list' and 'opps.exportCsv' (zod: search ≤ 200), which refuse a longer search. */
export const OPP_MAX_SEARCH_CHARS = 200;

/** Defensive restore of persisted filters (older or hand-edited values). */
export function sanitizeFilters(v: unknown): OppFilters {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const pick = <T extends string>(arr: unknown, allowed: readonly T[]): T[] =>
    Array.isArray(arr) ? (arr.filter((x) => (allowed as readonly unknown[]).includes(x)) as T[]) : [];
  const minC = typeof o['minConfidence'] === 'number' && Number.isFinite(o['minConfidence']) ? o['minConfidence'] : 0;
  return {
    search: typeof o['search'] === 'string' ? o['search'].slice(0, OPP_MAX_SEARCH_CHARS) : '',
    categories: pick(o['categories'], CATEGORIES),
    tiers: pick(o['tiers'], TIER_ORDER),
    minConfidence: Math.max(0, Math.min(100, Math.round(minC))),
    inputKinds: pick(o['inputKinds'], INPUT_ORDER),
    status: Array.isArray(o['status']) ? pick(o['status'], STATUS_ORDER) : [...DEFAULT_FILTERS.status],
  };
}

export type EmptyListReason = 'filters' | 'status-hidden' | 'nothing-yet';

/**
 * Why an empty Opportunities list is empty. The default status filter
 * (profitable only) is not an "active" filter, yet with opportunities in the
 * database it is what hides them all, so the empty state has to say so.
 */
export function emptyListReason(f: OppFilters, opportunitiesInDb: number | null | undefined): EmptyListReason {
  if (activeFilterCount(f) > 0) return 'filters';
  if (f.status.length > 0 && (opportunitiesInDb ?? 0) > 0) return 'status-hidden';
  return 'nothing-yet';
}

export function activeFilterCount(f: OppFilters): number {
  let n = 0;
  if (f.search.trim()) n++;
  if (f.categories.length) n++;
  if (f.tiers.length) n++;
  if (f.minConfidence > 0) n++;
  if (f.inputKinds.length) n++;
  if (!sameSet(f.status, DEFAULT_FILTERS.status)) n++;
  return n;
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function filtersToQuery(
  f: OppFilters,
  extra: { sort: SortKey; dir: SortDir; groupBy: GroupBy; limit: number; offset?: number },
): OppQuery {
  const q: OppQuery = { sort: extra.sort, dir: extra.dir, groupBy: extra.groupBy, limit: extra.limit, offset: extra.offset ?? 0 };
  const s = f.search.trim().slice(0, OPP_MAX_SEARCH_CHARS);
  if (s) q.search = s;
  if (f.categories.length) q.categories = [...f.categories];
  if (f.tiers.length) q.tiers = [...f.tiers];
  if (f.minConfidence > 0) q.minConfidence = f.minConfidence;
  if (f.inputKinds.length) q.inputKinds = [...f.inputKinds];
  if (f.status.length) q.status = [...f.status];
  return q;
}

/** Search matches when every whitespace-separated token is in the name or SKU. */
export function matchesSearch(o: Pick<Opportunity, 'name' | 'sku'>, search: string | undefined): boolean {
  const tokens = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = `${o.name} ${o.sku}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

export function matchesQuery(o: Opportunity, q: OppQuery): boolean {
  if (q.status?.length && !q.status.includes(o.status)) return false;
  if (q.categories?.length && !q.categories.includes(o.category)) return false;
  if (q.tiers?.length && !q.tiers.includes(o.profitTier)) return false;
  if (q.inputKinds?.length && !q.inputKinds.includes(o.inputKind)) return false;
  if (q.minConfidence !== undefined && o.confidence < q.minConfidence) return false;
  return matchesSearch(o, q.search);
}

export function filterOpportunities(rows: readonly Opportunity[], q: OppQuery): Opportunity[] {
  return rows.filter((o) => matchesQuery(o, q));
}

/** The list query for 'opps.exportCsv': the same filters and sort, without paging or grouping. */
export function exportQuery(q: OppQuery): OppQuery {
  const { limit: _limit, offset: _offset, groupBy: _groupBy, ...rest } = q;
  return rest;
}

/** True when "/" should jump to the search box: not while typing, and not behind an open dialog. */
export function isSearchShortcut(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  target: { tagName: string; isContentEditable: boolean } | null,
  dialogOpen: boolean,
): boolean {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || dialogOpen) return false;
  return !target || !(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}

// ---------------------------------------------------------------------------
// Revenue order
// ---------------------------------------------------------------------------

export type UseOrder = ProfitSettings['useOrder'];

/**
 * The buy order an opportunity's revenue and profit come from, mirroring the
 * engine's revenueOrderOf for the configured useOrder. If the stored revenue
 * was computed under another setting (just after the setting changed, before
 * the re-evaluation lands), the order whose value matches it wins, as in the
 * CSV export. Null when there is no revenue.
 */
export function revenueOrderOf(o: Pick<Opportunity, 'revenueScrap' | 'bestOrder' | 'consOrder' | 'instantOrder'>, useOrder: UseOrder): OrderSummary | null {
  if (o.revenueScrap === null) return null;
  const preferred = useOrder === 'best' ? o.bestOrder : useOrder === 'instant' ? o.instantOrder : o.consOrder;
  if (preferred && preferred.valueScrap === o.revenueScrap) return preferred;
  return [o.consOrder, o.bestOrder, o.instantOrder].find((x) => x !== null && x.valueScrap === o.revenueScrap) ?? preferred ?? null;
}

/** The summary bar's "N profitable, together +X" (profitableTotals). */
export interface ProfitableTotals {
  /** Summed profit, each revenue buy order counted once at its most profitable row. */
  profit: Scrap;
  /** Profitable rows, every copy counted (the table's own count). */
  profitable: number;
  /** Profitable rows left out of `profit` because a more profitable row sells to the same order. */
  sharedCopies: number;
}

/**
 * 0.7.4 (F27, F33): the profitable rows' total profit, one profit per revenue buy order: copies of one item
 * (a kit's sheen combos, painted copies) and generic orders shared by several items are each valued against
 * the same order, which may buy only one, so only the most profitable row of each order counts. A row with
 * no order (or no listing id) counts on its own. Matches the engine's 'shared-buyer' flag per item.
 */
export function profitableTotals(rows: readonly Opportunity[], useOrder: UseOrder): ProfitableTotals {
  const best = new Map<string, Scrap>();
  let profitable = 0;
  for (const o of rows) {
    if (o.status !== 'profitable' || o.profitScrap === null || !Number.isFinite(o.profitScrap)) continue;
    profitable++;
    const id = revenueOrderOf(o, useOrder)?.listingId;
    const key = id ? `order:${id}` : `row:${o.key}`;
    const cur = best.get(key);
    if (cur === undefined || o.profitScrap > cur) best.set(key, o.profitScrap);
  }
  let profit = 0;
  for (const v of best.values()) profit += v;
  return { profit, profitable, sharedCopies: profitable - best.size };
}

/** 0.7.4 (F27, F33): the summary bar's note: "2 copies share a buyer, counted once". */
export function sharedBuyerNote(sharedCopies: number): string {
  return sharedCopies === 1 ? '1 copy shares a buyer, counted once' : `${sharedCopies} copies share a buyer, counted once`;
}

export const SHARED_BUYER_TITLE =
  "Copies of an item (or items) that sell to the same backpack.tf buy order are counted once in the total, at the best copy's profit: the buyer may take only one. Each row still shows its own profit.";

/** Revenue column header tooltip for each useOrder setting. */
export const REVENUE_ORDER_TITLES: Record<UseOrder, string> = {
  conservative: 'Conservative revenue: the best order that is not an outlier. Hover a value for best and instant.',
  best: 'Best revenue: the highest eligible order, even an outlier. Hover a value for conservative and instant.',
  instant: 'Instant revenue: the best bot order that is not an outlier. Hover a value for conservative and best.',
};

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortValue(o: Opportunity, sort: SortKey): number | string | null {
  switch (sort) {
    case 'profit':
      return o.profitScrap;
    // 0.9 (#3): absent (a row stored before V16, no other buyer) sorts last, as the repo's OPP_SORT.
    case 'backup':
      return o.backupProfitScrap ?? null;
    case 'depth':
      return o.profitableDepth ?? null;
    case 'margin':
      return o.margin;
    case 'confidence':
      return o.confidence;
    case 'updated':
      return o.updatedAt;
    case 'name':
      return o.name.toLowerCase();
  }
}

/** Comparator with nulls always last, then name and key as stable tie-breakers. */
export function compareOpps(sort: SortKey, dir: SortDir): (a: Opportunity, b: Opportunity) => number {
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    const va = sortValue(a, sort);
    const vb = sortValue(b, sort);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) {
      if (typeof va === 'string' && typeof vb === 'string') return sign * va.localeCompare(vb);
      return sign * ((va as number) - (vb as number));
    }
    // 0.9 (#3): the risk keys tie by profit (descending, null last) before the name, as the repo's oppOrder.
    if (sort === 'backup' || sort === 'depth') {
      const pa = a.profitScrap;
      const pb = b.profitScrap;
      if (pa === null && pb !== null) return 1;
      if (pb === null && pa !== null) return -1;
      if (pa !== null && pb !== null && pa !== pb) return pb - pa;
    }
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.key.localeCompare(b.key);
  };
}

/** 0.9 (#3): the Opportunities Sort select's labels, in OPP_SORTS order. */
export const OPP_SORT_LABELS: Record<SortKey, string> = {
  profit: 'Profit',
  backup: 'If this buyer leaves',
  depth: 'Buyers at break-even',
  margin: 'Margin',
  confidence: 'Confidence',
  updated: 'Updated',
  name: 'Name',
};

/** 0.9 (#3): the Opportunities Sort select's hover: what the two risk keys measure (demand, never sales). */
export const OPP_SORT_HELP =
  "If this buyer leaves: the profit at the next buyer seen in the last 24 h, should the buyer your profit uses fill or withdraw. Buyers at break-even: different buyers seen in the last 24 h whose order pays at least break-even at the row's cost. Hover Buyers for each row's figures. Buyer counts show demand, not sales.";

export function sortOpportunities(rows: readonly Opportunity[], sort: SortKey = 'profit', dir: SortDir = 'desc'): Opportunity[] {
  return [...rows].sort(compareOpps(sort, dir));
}

/** Default direction when a column header is first clicked. */
export function defaultDir(sort: SortKey): SortDir {
  return sort === 'name' ? 'asc' : 'desc';
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export function groupKeyOf(o: Opportunity, by: GroupBy): string {
  switch (by) {
    case 'category':
      return o.category;
    case 'tier':
      return o.profitTier;
    case 'confidence':
      return o.confidenceLevel;
    case 'input':
      return o.inputKind;
  }
}

export function groupOrder(by: GroupBy): readonly string[] {
  switch (by) {
    case 'category':
      return CATEGORIES;
    case 'tier':
      return TIER_ORDER;
    case 'confidence':
      return CONFIDENCE_ORDER;
    case 'input':
      return INPUT_ORDER;
  }
}

export function groupLabel(by: GroupBy, key: string): string {
  switch (by) {
    case 'category':
      return (CATEGORY_LABELS as Record<string, string>)[key] ?? key;
    case 'tier':
      return (PROFIT_TIER_LABELS as Record<string, string>)[key] ?? key;
    case 'confidence':
      return (CONFIDENCE_LABELS as Record<string, string>)[key] ?? key;
    case 'input':
      // Brief §5.6: rule matches are candidates the user still has to check on scrap.tf.
      if (key === 'rule') return 'Candidates to check on scrap.tf (rule estimates)';
      return (INPUT_KIND_LABELS as Record<string, string>)[key] ?? key;
  }
}

function orderIndex(by: GroupBy, key: string): number {
  const i = groupOrder(by).indexOf(key);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * 0.7.4 (F27, F33; R27): a group's summed profit, copies of an item that sell to the same buy order counted
 * once at the best copy among `rows` (onceByOrderProfit, by revenueOrderOf), as the service's
 * opportunityGroupStats sums it: a filter that hides the best copy counts the next one, not none.
 */
export function groupProfitOf(rows: readonly Opportunity[], useOrder: UseOrder = 'conservative'): Scrap {
  return onceByOrderProfit(rows, (o) => revenueOrderOf(o, useOrder));
}

/** Group counts and summed profit (null profit counts as 0; groupProfitOf's one buyer once), in display order. */
export function summarizeGroups(rows: readonly Opportunity[], by: GroupBy, useOrder: UseOrder = 'conservative'): GroupSummary[] {
  const buckets = new Map<string, Opportunity[]>();
  for (const o of rows) {
    const key = groupKeyOf(o, by);
    const list = buckets.get(key);
    if (list) list.push(o);
    else buckets.set(key, [o]);
  }
  return [...buckets.entries()]
    .map(([key, list]): GroupSummary => ({ by, key, label: groupLabel(by, key), count: list.length, totalProfitScrap: groupProfitOf(list, useOrder) }))
    .sort((a, b) => orderIndex(by, a.key) - orderIndex(by, b.key) || a.key.localeCompare(b.key));
}

export interface OppGroup {
  key: string;
  label: string;
  /** Total matches in this group (may exceed rows.length when the list is capped). */
  count: number;
  totalProfitScrap: Scrap;
  rows: Opportunity[];
}

/**
 * Buckets rows into groups, keeping their order inside each group. When the
 * service sent group summaries for the same grouping they provide the counts
 * and totals, because they cover every match rather than the loaded page.
 */
export function groupOpportunities(rows: readonly Opportunity[], by: GroupBy, serverGroups?: readonly GroupSummary[] | null, useOrder: UseOrder = 'conservative'): OppGroup[] {
  const buckets = new Map<string, Opportunity[]>();
  for (const o of rows) {
    const k = groupKeyOf(o, by);
    const arr = buckets.get(k);
    if (arr) arr.push(o);
    else buckets.set(k, [o]);
  }
  const server = new Map<string, GroupSummary>();
  for (const g of serverGroups ?? []) if (g.by === by) server.set(g.key, g);

  const keys = new Set<string>([...buckets.keys()]);
  for (const k of server.keys()) if ((server.get(k)?.count ?? 0) > 0) keys.add(k);

  const out: OppGroup[] = [];
  for (const key of keys) {
    const groupRows = buckets.get(key) ?? [];
    const s = server.get(key);
    out.push({
      key,
      label: s?.label || groupLabel(by, key),
      count: s ? Math.max(s.count, groupRows.length) : groupRows.length,
      totalProfitScrap: s ? s.totalProfitScrap : groupProfitOf(groupRows, useOrder),
      rows: groupRows,
    });
  }
  return out.sort((a, b) => orderIndex(by, a.key) - orderIndex(by, b.key) || a.key.localeCompare(b.key));
}

/** Rows ordered by group display order first, keeping their order inside each group (how the service pages a grouped list). */
export function orderByGroup(rows: readonly Opportunity[], by: GroupBy): Opportunity[] {
  return [...rows].sort((a, b) => orderIndex(by, groupKeyOf(a, by)) - orderIndex(by, groupKeyOf(b, by)));
}

/** Most rows one group shows: the service's limit for one request. Past it, the CSV export has every row. */
export const MAX_GROUP_ROWS = 5000;

/** Rows one "Load more" adds to a group. */
export const GROUP_PAGE = 500;

/** Rows the next "Load more" really adds: a page, or less near the end of the group or MAX_GROUP_ROWS. */
export function nextGroupPageSize(g: Pick<OppGroup, 'count' | 'rows'>): number {
  return Math.max(0, Math.min(GROUP_PAGE, g.count - g.rows.length, MAX_GROUP_ROWS - g.rows.length));
}

/**
 * The 'opps.list' request for `want` rows of one group past those the first
 * page holds. A grouped list is ordered by group first, so with more matches
 * than one page the first groups use it all and later groups load nothing.
 * Category, tier and input narrow the query to the group; confidence levels
 * have no query filter, so that grouping skips the earlier groups' rows instead.
 * Null when there is nothing (more) to load.
 */
export function groupPageQuery(base: OppQuery, by: GroupBy, key: string, firstPage: readonly OppGroup[], want: number): OppQuery | null {
  const i = firstPage.findIndex((g) => g.key === key);
  const g = firstPage[i];
  if (!g || !groupOrder(by).includes(key)) return null;
  const limit = Math.min(Math.floor(want), MAX_GROUP_ROWS - g.rows.length, g.count - g.rows.length);
  if (!(limit > 0)) return null;
  const q: OppQuery = { ...base, limit, offset: g.rows.length };
  switch (by) {
    case 'category':
      q.categories = [key as Category];
      break;
    case 'tier':
      q.tiers = [key as ProfitTier];
      break;
    case 'input':
      q.inputKinds = [key as InputKind];
      break;
    case 'confidence':
      q.offset = firstPage.slice(0, i).reduce((n, x) => n + x.count, 0) + g.rows.length;
      break;
  }
  return q;
}

/** The first page plus rows loaded per group; a row in both keeps the first page's (newer) copy. */
export function mergeLoadedRows(first: readonly Opportunity[], extra: Readonly<Record<string, readonly Opportunity[]>>): Opportunity[] {
  const seen = new Set(first.map((o) => o.key));
  const out = [...first];
  for (const rows of Object.values(extra)) {
    for (const o of rows) {
      if (seen.has(o.key)) continue;
      seen.add(o.key);
      out.push(o);
    }
  }
  return out;
}

export type DisplayRow =
  | { type: 'group'; id: string; group: OppGroup; collapsed: boolean }
  | { type: 'opp'; id: string; opp: Opportunity; groupKey: string }
  /** After a group whose count exceeds its loaded rows: "Load more", or a note once MAX_GROUP_ROWS are shown. */
  | { type: 'more'; id: string; group: OppGroup; groupKey: string; capped: boolean };

/** Flattens groups into the rows the virtual table renders. */
export function flattenGroups(groups: readonly OppGroup[], collapsed: ReadonlySet<string>): DisplayRow[] {
  const out: DisplayRow[] = [];
  for (const g of groups) {
    const isCollapsed = collapsed.has(g.key);
    out.push({ type: 'group', id: `group:${g.key}`, group: g, collapsed: isCollapsed });
    if (isCollapsed) continue;
    for (const o of g.rows) out.push({ type: 'opp', id: o.key, opp: o, groupKey: g.key });
    if (g.rows.length < g.count) out.push({ type: 'more', id: `more:${g.key}`, group: g, groupKey: g.key, capped: g.rows.length >= MAX_GROUP_ROWS });
  }
  return out;
}

/** Index of the row with this id, or -1. Any list of rows with ids (the Shopping list uses it too). */
export function indexOfRow(rows: readonly { id: string }[], id: string | null): number {
  if (id === null) return -1;
  return rows.findIndex((r) => r.id === id);
}

/** Moves a keyboard cursor by delta, clamped to the list. */
export function moveCursor(rows: readonly unknown[], current: number, delta: number): number {
  if (!rows.length) return -1;
  if (current < 0) return delta >= 0 ? 0 : rows.length - 1;
  return Math.max(0, Math.min(rows.length - 1, current + delta));
}

// ---------------------------------------------------------------------------
// "Pay up to" cell and the row context menu (F1, F9)
// ---------------------------------------------------------------------------

/**
 * Tooltip for an opportunity's Pay up to cell: the ceiling, and where this row's own price sits against it.
 * 0.7.3: no revenue with buyers says why none is usable, from the row's flags as the Live market's Pay up to
 * hover does (Conservative is null only when every eligible order is an outlier, flagged 'all-outliers'; Best
 * never is with buyers, so the rest is Instant without a realistic bot order).
 */
export function payUpToTitle(
  o: Pick<Opportunity, 'maxCostScrap' | 'costScrap' | 'revenueScrap' | 'inputKind'> & Partial<Pick<Opportunity, 'buyerCount' | 'flags'>>,
  keyScrap: Scrap | null,
): string {
  if (o.maxCostScrap === null) {
    if (o.revenueScrap !== null) return 'No scrap.tf price clears your thresholds against this revenue.';
    if (!((o.buyerCount ?? 0) > 0)) return 'No eligible buy orders, so there is no ceiling.';
    return o.flags?.includes('all-outliers')
      ? 'Every eligible order looks unrealistic, so there is no ceiling.'
      : 'No realistic bot order, and Revenue used for profit is Instant (bot orders only), so there is no ceiling.';
  }
  const head = `Pay up to ${fmtMoney(o.maxCostScrap, keyScrap)} on scrap.tf: the highest price that still clears your thresholds.`;
  if (o.inputKind === 'rule') return `${head} This cost is a rule estimate; check the real price on scrap.tf.`;
  const d = o.maxCostScrap - o.costScrap;
  if (d === 0) return `${head} Your price is exactly at it.`;
  return d > 0 ? `${head} Your price is ${fmtMoney(d, keyScrap)} under it.` : `${head} Your price is ${fmtMoney(-d, keyScrap)} over it.`;
}

/** 0.8 (PC-1): "friction", or "friction and the 5% price-move reserve" when one is set. */
export function exitCostsWords(reservePct: number | null | undefined): string {
  const pct = reservePctOf({ exitReservePct: reservePct ?? 0 });
  return pct > 0 ? `friction and the ${ratioPctText(pct)} price-move reserve` : 'friction';
}

/** "A", "A and B", "A, B and C". */
function andList(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * 0.8 (PC-1): "Sells for 33.33 ref, minus your cost 22.22 ref, friction 0.11 ref and the 5% price-move reserve 1.66 ref:
 * profit +9.33 ref." Friction and the reserve are named only when above 0 (two items: "A and B"; three: "A, B and C").
 * Null for a null breakdown.
 */
export function profitBreakdownText(b: ProfitBreakdown | null, keyScrap: Scrap | null): string | null {
  if (!b) return null;
  // The friction exitCostsOf applied (frictionOf), never the raw setting (profitPath.test.ts rule 1).
  const { revenueScrap, costScrap, frictionScrap: friction, reserveScrap, reservePct, profitScrap } = b;
  const parts = [`your cost ${fmtMoney(costScrap, keyScrap)}`];
  if (friction > 0) parts.push(`friction ${fmtMoney(friction, keyScrap)}`);
  if (reserveScrap > 0) parts.push(`the ${ratioPctText(reservePct)} price-move reserve ${fmtMoney(reserveScrap, keyScrap)}`);
  return `Sells for ${fmtMoney(revenueScrap, keyScrap)}, minus ${andList(parts)}: profit ${fmtSignedMoney(profitScrap, keyScrap)}.`;
}

/** 0.8 (PC-2): the drawer's Next buyer label hover: which buyer the line names (buyerDepthOf's rule in words). */
export const NEXT_BUYER_HELP =
  'If the buyer your profit uses fills or withdraws their order while you buy on scrap.tf: the best other buyer in the book below (another SteamID, not an outlier, one seen in the last 24 h when there is one).';

/** 0.8 (PC-2): the drawer input card's Next buyer line; tone 'warn' when only the revenue order's buyer makes the flip. */
export interface NextBuyerLine {
  text: string;
  title: string;
  tone: 'warn' | null;
}

/**
 * 0.8 (PC-2): the drawer input card's Next buyer line over the drawer's own book (ItemDetail.buyOrders) for the row's
 * revenue order (revenueOrderOf). Null without a revenue order or when that order is not among the book's eligible
 * orders (another copy's classification): then nothing is claimed. Presence and price only, never a fill chance.
 */
export function nextBuyerLine(
  o: Pick<Opportunity, 'revenueScrap' | 'costScrap' | 'bestOrder' | 'consOrder' | 'instantOrder'>,
  buyOrders: readonly OrderSummary[],
  p: CeilingSettings & Pick<ProfitSettings, 'useOrder'>,
  keyScrap: Scrap | null,
  now: UnixMs,
): NextBuyerLine | null {
  const order = revenueOrderOf(o, p.useOrder);
  if (!order || o.revenueScrap === null) return null;
  const depth = buyerDepthOf(exitOrdersOfSummaries(buyOrders), order.listingId, p.useOrder);
  if (depth.revenueBuyer === null) return null;
  const tone = singleExitOf(o.revenueScrap, o.costScrap, depth.nextBuyer, p) !== null ? 'warn' : null;
  const who = order.userName || (order.isBot ? 'this bot' : 'this buyer');
  const next = depth.nextBuyer;
  if (next === null) return { text: 'None: only this buyer', tone, title: `If ${who} fills or withdraws, no other usable buyer is in the book.` };
  const profit = flipProfit(next.valueScrap, o.costScrap, p);
  const ok = profitStatus(profit, o.costScrap, p) === 'profitable';
  const pays = fmtMoney(next.valueScrap, keyScrap);
  const verdict = ok ? (next.unverified ? 'a flip at this cost, if that order is still there' : 'still a flip at this cost') : 'not a flip at this cost';
  return {
    text: `${pays} · profit ${fmtSignedMoney(profit, keyScrap)}${next.unverified ? ' · not seen in 24 h' : ''}`,
    title: `If ${who} fills or withdraws, the next buyer (${next.isBot ? 'bot' : 'human'}, ${buyerPresenceText(next, now)}) pays ${pays}: ${verdict}. Buy orders show demand, not sales.`,
    tone,
  };
}

/** 0.8 (PC-2): the Opportunities Buyers cell's hover for a 'single-exit' row: "N buyers with eligible orders. <reason text>."; undefined otherwise. */
export function singleExitTitleOf(o: Pick<Opportunity, 'flags' | 'reasons' | 'buyerCount'>): string | undefined {
  if (!o.flags.includes('single-exit')) return undefined;
  const reason = o.reasons.find((r) => r.startsWith(`0 ${SINGLE_EXIT_TEXT}`));
  return `${o.buyerCount} ${o.buyerCount === 1 ? 'buyer' : 'buyers'} with eligible orders. ${reason ? reason.slice(2) : SINGLE_EXIT_TEXT}.`;
}

/**
 * On Windows Chromium also sends a contextmenu event for Shift+F10 or the menu
 * key (on key up), after the keydown already opened the item menu: within this
 * window such an event on the grid is the same request and is ignored.
 */
export const MENU_KEY_DEDUPE_MS = 1000;

/** True when a contextmenu event on a grid repeats a keyboard open made at `keyOpenedAt`. */
export function isMenuKeyEcho(keyOpenedAt: number, now: number): boolean {
  return now - keyOpenedAt >= 0 && now - keyOpenedAt < MENU_KEY_DEDUPE_MS;
}

/**
 * The box a keyboard-opened menu anchors to: the cursor row, or (when that row
 * is scrolled out of the rendered window) the top of the table under its header.
 */
export function menuAnchorRect(
  row: { left: number; top: number; width: number; height: number } | null | undefined,
  table: { left: number; top: number; width: number } | null | undefined,
  headerHeight: number,
): { left: number; top: number; width: number; height: number } {
  if (row) return { left: row.left, top: row.top, width: row.width, height: row.height };
  return { left: table?.left ?? 0, top: (table?.top ?? 0) + headerHeight, width: table?.width ?? 0, height: 0 };
}

// ---------------------------------------------------------------------------
// Tier and status (mirrors the engine's rules; used by the mock and for hints)
// ---------------------------------------------------------------------------

/** Brief §5.6 tiers: >= 1 key, 10 ref to 1 key, 2 to 10 ref, under 2 ref. */
export function tierForProfit(profit: Scrap | null, keyScrap: Scrap): ProfitTier {
  if (profit === null) return 'none';
  if (profit <= 0) return 'loss';
  if (profit >= keyScrap) return 'key';
  if (profit >= 90) return 'ref10';
  if (profit >= 18) return 'ref2';
  return 'small';
}

// The engine's own rules (src/shared/ceiling.ts), so hints and the mock never disagree with the service.
export { maxCostFor, minProfitFor } from '../shared/ceiling';

export function statusFor(
  profit: Scrap | null,
  costScrap: Scrap,
  p: Pick<ProfitSettings, 'minProfitScrap' | 'minProfitPctOfCost' | 'minMargin'>,
): OpportunityStatus {
  return profitStatus(profit, costScrap, p);
}

/**
 * 0.7.4 (F66): what tells one copy of an item from another (Opportunity.copyKey): every extra in words
 * ("Noble Hatter's Violet", "Team Shine", "Fire Horns", "Spell: Exorcism", "Strange part: Kills", "Name tag"),
 * or [] for a plain copy or a key it cannot read.
 */
export function copyExtrasText(copyKey: string | null | undefined): string[] {
  return copyExtrasWords(copyKey, (paint) => PAINT_NAMES[paint] ?? `Paint ${paintHex(paint)}`);
}

/**
 * 0.7.4 (F66): the copy tag beside an opportunity's name: its first two extras ("Team Shine, Fire Horns",
 * "+1" past them) and a hover listing them all; null for a plain copy or a rule. 0.7.4 (R30): a paint the
 * row's own SKU carries already has its chip beside the name (itemTags), so the tag leaves it out (null when
 * it was the only extra); the hover still lists it. Each copy's Pay up to comes from the buyers who take that
 * copy (the engine's explicitInput target), so the hover no longer calls it a clean copy's.
 */
export function copyLabelOf(o: Pick<Opportunity, 'copyKey' | 'inputKind'> & Partial<Pick<Opportunity, 'sku'>>): { text: string; title: string } | null {
  if (o.inputKind === 'rule') return null;
  const all = copyExtrasText(o.copyKey);
  if (all.length === 0) return null;
  const chip = paintOfSku(o.sku);
  const shown = chip === null ? all : copyExtrasWords(o.copyKey, (paint) => (paint === chip ? '' : paintWord(paint))).filter((w) => w !== '');
  if (shown.length === 0) return null;
  const text = shown.length > 2 ? `${shown.slice(0, 2).join(', ')} +${shown.length - 2}` : shown.join(', ');
  return {
    text,
    title: `This copy: ${all.join(', ')}. Each copy of an item is its own row, priced against the buyers who take this copy (generic orders and any that ask for its extras).`,
  };
}

function paintWord(paint: number): string {
  return PAINT_NAMES[paint] ?? `Paint ${paintHex(paint)}`;
}

/** The paint decimal in a SKU (";p<decimal>"), else null. */
function paintOfSku(sku: string | undefined): number | null {
  const m = typeof sku === 'string' ? /;p(\d+)(?:;|$)/.exec(sku) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 0.7.4 (F66): the drawer's "other copy" hover names the copy: "The Last Laugh (After Eight)". */
export function otherCopyName(p: Pick<ScrapPrice, 'sku' | 'name' | 'special'>): string {
  const extras = copyExtrasText(opportunityCopyKey(p.sku, p.special));
  return extras.length > 0 ? `${p.name} (${extras.join(', ')})` : p.name;
}

/**
 * 0.7.4 (F68): the drawer's input card title. The `price:<id>` ref is a price row id, never a page: "Imported
 * price #1554 · import #33" names the import batch as the Import page's "#" column and the Price sheet's
 * "Imported #33" do; "Typed price #12" as the Price sheet's "Edit price #12"; "Rule: <name>" (else its id).
 * `price` is the input's own row when the drawer has it (absent, or no batch recorded: no batch part).
 */
export function inputCardLabel(o: Pick<Opportunity, 'inputKind' | 'inputRef'> & Partial<Pick<Opportunity, 'copyKey'>>, price?: { importBatch: number | null } | null, ruleName?: string): string {
  if (o.inputKind === 'rule') return `Rule: ${ruleName ?? o.inputRef.replace('rule:', '#')}`;
  const id = o.inputRef.startsWith('price:') ? o.inputRef.slice('price:'.length) : o.inputRef;
  // 0.7.4 (F66): which copy, e.g. "Imported price #1960 · import #35 · Noble Hatter's Violet".
  const extras = copyExtrasText(o.copyKey);
  const copy = extras.length > 0 ? ` · ${extras.join(', ')}` : '';
  if (o.inputKind === 'user') return `Typed price #${id}${copy}`;
  const batch = price?.importBatch;
  return `Imported price #${id}${typeof batch === 'number' && Number.isSafeInteger(batch) && batch > 0 ? ` · import #${batch}` : ''}${copy}`;
}
