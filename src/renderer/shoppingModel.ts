// Pure helpers for the Shopping list page (feature F1): filters, grouping by
// scrap.tf bank page and the rows the virtual table renders. The service
// filters, sorts and pages ('shopping.list'); this only shapes the result for
// display, so the page never depends on the order the service returns.
//
// The bank-page URLs are static scrap.tf pages the user opens in their own
// browser (links.open). Nothing here, or anywhere in the app, fetches them.
// 0.7.1 (ACT-9): "Your price" says how old it is (knownObservedAt), and a stale one (knownStale) is not
// counted as at or under the ceiling; rows from an older service read as before.

import { parsePrice } from '../shared/currency';
import { scraptfPageFor } from '../shared/links';
import type { Category, OrderSummary, ProfitSettings, Scrap, ShoppingListResult, ShoppingQuery, ShoppingRow, UnixMs } from '../shared/types';
import { CATEGORIES, CATEGORY_LABELS } from '../shared/types';
import { fmtAgo, fmtDateTime, fmtInt, fmtMoney, fmtPct } from './format';

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** What the filter bar edits; converted to a ShoppingQuery for the service. */
export interface ShoppingFilters {
  search: string;
  categories: Category[];
  /** The minimum ceiling as typed ("2 ref", "1 key"); bare numbers are refined. */
  minCeiling: string;
  onlyBotBuyers: boolean;
}

export const DEFAULT_SHOPPING_FILTERS: Readonly<ShoppingFilters> = Object.freeze<ShoppingFilters>({
  search: '',
  categories: [],
  minCeiling: '',
  onlyBotBuyers: false,
});

/** The service's zod limits for 'shopping.list' (search length, filter text kept short). */
export const MAX_SEARCH_CHARS = 200;
const MAX_MIN_CEILING_CHARS = 40;

/** A fresh copy of the defaults (the frozen arrays must not be handed to state). */
export function defaultShoppingFilters(): ShoppingFilters {
  return { ...DEFAULT_SHOPPING_FILTERS, categories: [] };
}

/** Defensive restore of persisted filters (older or hand-edited values). */
export function sanitizeShoppingFilters(v: unknown): ShoppingFilters {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const cats = Array.isArray(o['categories']) ? o['categories'].filter((c): c is Category => (CATEGORIES as readonly unknown[]).includes(c)) : [];
  return {
    search: typeof o['search'] === 'string' ? o['search'].slice(0, MAX_SEARCH_CHARS) : '',
    categories: [...new Set(cats)],
    minCeiling: typeof o['minCeiling'] === 'string' ? o['minCeiling'].slice(0, MAX_MIN_CEILING_CHARS) : '',
    onlyBotBuyers: o['onlyBotBuyers'] === true,
  };
}

export function activeShoppingFilterCount(f: ShoppingFilters): number {
  let n = 0;
  if (f.search.trim()) n++;
  if (f.categories.length) n++;
  if (f.minCeiling.trim()) n++;
  if (f.onlyBotBuyers) n++;
  return n;
}

export interface MinCeiling {
  /** The minimum in scrap, or null for no minimum (empty or unusable text). */
  scrap: Scrap | null;
  /** Why the text could not be used; null when it is empty or fine. */
  error: string | null;
}

/** Reads the "Pay up to at least" text. Keys need a key price; without one the filter is off and says why. */
export function readMinCeiling(text: string, keyScrap: Scrap | null): MinCeiling {
  const t = text.trim();
  if (!t) return { scrap: null, error: null };
  const p = parsePrice(t, 'ref');
  if (!p) return { scrap: null, error: 'Enter a price, for example 2 ref or 1 key.' };
  if (p.keys && !(keyScrap && keyScrap > 0)) return { scrap: null, error: 'No key price yet, so a minimum in keys cannot be used.' };
  return { scrap: Math.max(0, Math.round(p.keys * (keyScrap ?? 0)) + p.scrap), error: null };
}

/** Quick picks in the minimum-ceiling popover. */
export const MIN_CEILING_PRESETS: readonly string[] = ['1 ref', '5 ref', '10 ref', '1 key'];

/** The 'shopping.list' params for these filters; `minCeilingScrap` comes from readMinCeiling. */
export function shoppingQuery(f: ShoppingFilters, minCeilingScrap: Scrap | null, page?: { limit: number; offset?: number }): ShoppingQuery {
  const q: ShoppingQuery = {};
  const s = f.search.trim().slice(0, MAX_SEARCH_CHARS);
  if (s) q.search = s;
  if (f.categories.length) q.categories = [...f.categories];
  if (minCeilingScrap !== null && minCeilingScrap > 0) q.minCeilingScrap = minCeilingScrap;
  if (f.onlyBotBuyers) q.onlyBotBuyers = true;
  if (page) {
    q.limit = page.limit;
    q.offset = page.offset ?? 0;
  }
  return q;
}

/** The export query: the same filters with no paging, so the file has every match. */
export function shoppingExportQuery(q: ShoppingQuery): ShoppingQuery {
  const { limit: _limit, offset: _offset, ...rest } = q;
  return rest;
}

// ---------------------------------------------------------------------------
// Grouping by scrap.tf bank page
// ---------------------------------------------------------------------------

export interface ShoppingGroup {
  category: Category;
  label: string;
  /** Every match in this category (may exceed rows.length when the list is capped). */
  count: number;
  /** Static scrap.tf bank page for the category, opened in the user's browser. */
  bankPageUrl: string;
  rows: ShoppingRow[];
}

function categoryIndex(c: string): number {
  const i = (CATEGORIES as readonly string[]).indexOf(c);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/** Highest ceiling first, then name and SKU, as the service sorts inside a category (domain/shopping.ts). */
export function compareShoppingRows(a: ShoppingRow, b: ShoppingRow): number {
  return b.maxCostScrap - a.maxCostScrap || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
}

/**
 * Buckets rows by category in CATEGORIES order. The service's group summaries
 * give the counts, because they cover every match rather than the loaded page.
 */
export function groupShoppingRows(rows: readonly ShoppingRow[], serverGroups?: ShoppingListResult['groups'] | null): ShoppingGroup[] {
  const buckets = new Map<Category, ShoppingRow[]>();
  for (const r of rows) {
    const arr = buckets.get(r.category);
    if (arr) arr.push(r);
    else buckets.set(r.category, [r]);
  }
  const server = new Map<Category, ShoppingListResult['groups'][number]>();
  for (const g of serverGroups ?? []) if (g.count > 0) server.set(g.category, g);

  const keys = new Set<Category>([...buckets.keys(), ...server.keys()]);
  const out: ShoppingGroup[] = [];
  for (const category of keys) {
    const groupRows = [...(buckets.get(category) ?? [])].sort(compareShoppingRows);
    const s = server.get(category);
    out.push({
      category,
      label: s?.label || CATEGORY_LABELS[category] || category,
      count: Math.max(s?.count ?? 0, groupRows.length),
      bankPageUrl: s?.bankPageUrl || groupRows[0]?.bankPageUrl || scraptfPageFor(category),
      rows: groupRows,
    });
  }
  return out.sort((a, b) => categoryIndex(a.category) - categoryIndex(b.category) || a.category.localeCompare(b.category));
}

export type ShoppingDisplayRow =
  | { type: 'group'; id: string; group: ShoppingGroup; collapsed: boolean }
  | { type: 'item'; id: string; row: ShoppingRow; groupKey: Category }
  /** After a group the loaded page could not hold: a note that points at the CSV export. */
  | { type: 'more'; id: string; group: ShoppingGroup; groupKey: Category };

export function shoppingRowId(sku: string): string {
  return `sku:${sku}`;
}

/** Flattens groups into the rows the virtual table renders. */
export function flattenShoppingGroups(groups: readonly ShoppingGroup[], collapsed: ReadonlySet<string>): ShoppingDisplayRow[] {
  const out: ShoppingDisplayRow[] = [];
  for (const g of groups) {
    const isCollapsed = collapsed.has(g.category);
    out.push({ type: 'group', id: `group:${g.category}`, group: g, collapsed: isCollapsed });
    if (isCollapsed) continue;
    for (const r of g.rows) out.push({ type: 'item', id: shoppingRowId(r.sku), row: r, groupKey: g.category });
    if (g.rows.length < g.count) out.push({ type: 'more', id: `more:${g.category}`, group: g, groupKey: g.category });
  }
  return out;
}

/** The scrap.tf bank page behind any display row (its group's page). */
export function bankPageOf(row: ShoppingDisplayRow | undefined): string | null {
  if (!row) return null;
  return row.type === 'item' ? row.row.bankPageUrl : row.group.bankPageUrl;
}

/** "scrap.tf/buy/hats": the page as the user will see it in their address bar. */
export function bankPageText(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\/$/, '');
}

/** Restores the persisted collapsed categories. */
export function sanitizeCollapsedCategories(v: unknown): Category[] {
  return Array.isArray(v) ? [...new Set(v.filter((c): c is Category => (CATEGORIES as readonly unknown[]).includes(c)))] : [];
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** ACT-9: the row's own price is older than profit.inputStaleMs (ShoppingRow.knownStale; absent: fresh). */
export function yourPriceStale(r: Partial<Pick<ShoppingRow, 'knownStale'>>): boolean {
  return r.knownStale === true;
}

/**
 * Rows whose latest typed or imported price is at or under the ceiling: flips at the price already seen.
 * ACT-9: only fresh prices count; a stale one may no longer be what scrap.tf charges.
 */
export function countUnderCeiling(rows: readonly ShoppingRow[]): number {
  let n = 0;
  for (const r of rows) if (r.underCeiling === true && !yourPriceStale(r)) n++;
  return n;
}

/**
 * Colour of the "Your price" cell: green at or under the ceiling, red over it, none without a price.
 * ACT-9: a stale price at or under it gets no green (the cell says "stale" instead).
 */
export function yourPriceTone(r: Pick<ShoppingRow, 'underCeiling'> & Partial<Pick<ShoppingRow, 'knownStale'>>): 'good' | 'bad' | null {
  if (r.underCeiling === true) return yourPriceStale(r) ? null : 'good';
  return r.underCeiling === false ? 'bad' : null;
}

/**
 * ACT-9: "3 h ago" for "Your price" (ShoppingRow.knownObservedAt) and whether it is stale; null without a
 * price or a time (an older service), which shows as before.
 */
export function yourPriceAge(r: Pick<ShoppingRow, 'knownCostScrap'> & Partial<Pick<ShoppingRow, 'knownObservedAt' | 'knownStale'>>, now: UnixMs): { text: string; stale: boolean } | null {
  const at = r.knownObservedAt;
  if (r.knownCostScrap === null || typeof at !== 'number' || !Number.isFinite(at)) return null;
  // A time a little ahead of this clock reads "just now", not "in 2 min".
  return { text: fmtAgo(Math.min(at, now), now), stale: yourPriceStale(r) };
}

/**
 * Tooltip for the "Your price" cell. The price is compared with its own row's ceiling
 * (knownMaxCostScrap), the same pair underCeiling and the cell's colour use: a painted or
 * spelled copy can share the SKU with a plain one and sell for something else entirely.
 */
export function yourPriceTitle(
  r: Pick<ShoppingRow, 'knownCostScrap' | 'knownMaxCostScrap' | 'maxCostScrap'> & Partial<Pick<ShoppingRow, 'knownObservedAt' | 'knownStock' | 'knownStale'>>,
  keyScrap: Scrap | null,
): string {
  if (r.knownCostScrap === null) return 'No price typed or imported for this item; only a price-sheet rule matches. Check scrap.tf.';
  // ACT-9: when the price was seen, its stock then, and whether it is too old to count as a flip now.
  const at = typeof r.knownObservedAt === 'number' && Number.isFinite(r.knownObservedAt) ? r.knownObservedAt : null;
  const stock = typeof r.knownStock === 'number' && Number.isFinite(r.knownStock) ? ` ${fmtInt(r.knownStock)} in stock then.` : '';
  const seen = at === null ? '' : ` Seen ${fmtDateTime(at)}.${stock}`;
  const stale = yourPriceStale(r) ? ' Older than your stale-input limit (Settings, Profit), so it is not counted as at or under the ceiling: check scrap.tf again.' : '';
  if (r.knownMaxCostScrap === null) return `No cost clears your thresholds for the copy you priced: not a flip at that price.${seen}${stale}`;
  const ceiling = r.knownMaxCostScrap === r.maxCostScrap ? 'the ceiling' : `that copy's own ceiling (${fmtMoney(r.knownMaxCostScrap, keyScrap)})`;
  const d = r.knownMaxCostScrap - r.knownCostScrap;
  if (d === 0) return `Your latest scrap.tf price is exactly ${ceiling}: still a flip.${seen}${stale}`;
  return d > 0
    ? `Your latest scrap.tf price is ${fmtMoney(d, keyScrap)} under ${ceiling}: a flip at that price.${seen}${stale}`
    : `Your latest scrap.tf price is ${fmtMoney(-d, keyScrap)} over ${ceiling}: not a flip at that price.${seen}${stale}`;
}

export function buyerKindLabel(order: Pick<OrderSummary, 'isBot'>): 'Bot' | 'Human' {
  return order.isBot ? 'Bot' : 'Human';
}

/** Tooltip for the "Sells for" cell: who buys, and how many buyers there are. */
export function sellsForTitle(r: Pick<ShoppingRow, 'revenueScrap' | 'revenueOrder' | 'buyerCount'>, keyScrap: Scrap | null): string {
  const o = r.revenueOrder;
  const online = o ? (o.online === true ? 'online' : o.online === false ? 'offline' : 'online status unknown') : null;
  const who = o ? ` to ${o.userName ?? o.steamid} (${buyerKindLabel(o).toLowerCase()}, ${online})` : '';
  const buyers = `${r.buyerCount} ${r.buyerCount === 1 ? 'buyer' : 'buyers'} with eligible orders.`;
  return `Sells for ${fmtMoney(r.revenueScrap, keyScrap)}${who}. ${buyers}`;
}

/** 0.05 -> "5%", 0.125 -> "12.5%". */
function pctText(ratio: number): string {
  const whole = Math.abs(ratio * 100 - Math.round(ratio * 100)) < 1e-9;
  return fmtPct(ratio, whole ? 0 : 1);
}

/**
 * The thresholds behind every ceiling, in words: "a profit of at least 1.00 ref
 * and 5% of the cost, a margin of at least 8%, against the conservative buy order".
 */
export function thresholdSummary(
  p: Pick<ProfitSettings, 'minProfitScrap' | 'minProfitPctOfCost' | 'minMargin' | 'frictionScrap' | 'useOrder'>,
  keyScrap: Scrap | null,
): string {
  const pct = p.minProfitPctOfCost > 0 ? `${pctText(p.minProfitPctOfCost)} of the cost` : null;
  // With no minimum the engine still needs profit > 0, so "at least 0.00 ref" would undersell it.
  let s =
    p.minProfitScrap > 0
      ? `a profit of at least ${fmtMoney(p.minProfitScrap, keyScrap)}${pct ? ` and ${pct}` : ''}`
      : pct
        ? `a profit of at least ${pct}`
        : 'any profit';
  if (p.minMargin > 0) s += `, a margin of at least ${pctText(p.minMargin)}`;
  if (p.frictionScrap > 0) s += `, after ${fmtMoney(p.frictionScrap, keyScrap)} friction`;
  return `${s}, against the ${p.useOrder} buy order`;
}

export type EmptyShoppingReason = 'filters' | 'nothing-yet';

export function emptyShoppingReason(f: ShoppingFilters): EmptyShoppingReason {
  return activeShoppingFilterCount(f) > 0 ? 'filters' : 'nothing-yet';
}
