// Shopping list (feature F1): one row per SKU with a "pay up to" ceiling, for
// the user to browse scrap.tf against by hand. Pure; the rows come from the
// stored opportunities. The bank page URLs are only handed to the user's
// browser, never fetched (R1).

import { formatScrap } from '../../shared/currency';
import { scraptfPageFor } from '../../shared/links';
import { CATEGORIES, CATEGORY_LABELS } from '../../shared/types';
import type { Category, KeyPriceState, Opportunity, Scrap, ShoppingListResult, ShoppingQuery, ShoppingRow, UnixMs } from '../../shared/types';
import type { CsvCell } from './csv';
import { toCsv } from './csv';
import { revenueOrderByValue } from './engine';
import { foldText } from './matcher';
import { INPUT_KIND_ORDER } from './tiers';
import { MAX_LIST_LIMIT } from './views';

/** Same cap as the dashboard's search: every token must match (AND). */
const MAX_SEARCH_TOKENS = 20;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A row that can set a SKU's ceiling: a positive ceiling from a real revenue. */
function hasCeiling(o: Opportunity): boolean {
  return finite(o.maxCostScrap) && o.maxCostScrap > 0 && o.status !== 'no-buyers' && finite(o.revenueScrap);
}

/** Highest confidence wins; ties go to the higher ceiling, then the key, so the pick is stable. */
function betterInput(a: Opportunity, b: Opportunity): boolean {
  if (a.confidence !== b.confidence) return a.confidence > b.confidence;
  const ca = a.maxCostScrap ?? 0;
  const cb = b.maxCostScrap ?? 0;
  if (ca !== cb) return ca > cb;
  return a.key < b.key;
}

/** Without a typed or imported chosen row, the newest such price wins (rules are estimates, not prices seen for the item). */
function newerKnown(a: Opportunity, b: Opportunity): boolean {
  if (a.inputObservedAt !== b.inputObservedAt) return a.inputObservedAt > b.inputObservedAt;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.key > b.key;
}

function categoryIndex(c: Category): number {
  const i = CATEGORIES.indexOf(c);
  return i === -1 ? CATEGORIES.length : i;
}

function compareRows(a: ShoppingRow, b: ShoppingRow): number {
  return (
    categoryIndex(a.category) - categoryIndex(b.category) ||
    b.maxCostScrap - a.maxCostScrap ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)
  );
}

function isKnown(o: Opportunity): boolean {
  return o.inputKind !== 'rule' && finite(o.costScrap);
}

function rowFor(top: Opportunity, all: readonly Opportunity[]): ShoppingRow {
  // Painted, spelled and plain copies share the SKU, so a cost is judged only against
  // its own row's ceiling: one copy's price against another copy's ceiling says nothing.
  let known: Opportunity | null = isKnown(top) ? top : null;
  if (known === null) for (const o of all) if (isKnown(o) && (known === null || newerKnown(o, known))) known = o;
  const maxCostScrap = top.maxCostScrap as Scrap;
  const knownCostScrap = known ? known.costScrap : null;
  const knownMaxCostScrap = known && finite(known.maxCostScrap) ? known.maxCostScrap : null;
  return {
    sku: top.sku,
    name: top.name || top.sku,
    category: top.category,
    bankPageUrl: scraptfPageFor(top.category),
    maxCostScrap,
    revenueScrap: top.revenueScrap as Scrap,
    revenueOrder: revenueOrderByValue(top),
    confidence: top.confidence,
    confidenceLevel: top.confidenceLevel,
    buyerCount: top.buyerCount,
    knownCostScrap,
    knownMaxCostScrap,
    underCeiling: knownCostScrap === null ? null : knownMaxCostScrap !== null && knownCostScrap <= knownMaxCostScrap,
    inputKinds: INPUT_KIND_ORDER.filter((k) => all.some((o) => o.inputKind === k)),
    flags: [...top.flags],
    updatedAt: top.updatedAt,
  };
}

function matcher(q: ShoppingQuery): (r: ShoppingRow) => boolean {
  const cats = Array.isArray(q.categories) && q.categories.length > 0 ? new Set<string>(q.categories) : null;
  const tokens = typeof q.search === 'string' ? foldText(q.search).trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS) : [];
  const minCeiling = finite(q.minCeilingScrap) ? q.minCeilingScrap : null;
  const botsOnly = q.onlyBotBuyers === true;
  return (r) => {
    if (cats && !cats.has(r.category)) return false;
    if (minCeiling !== null && r.maxCostScrap < minCeiling) return false;
    if (botsOnly && r.revenueOrder?.isBot !== true) return false;
    if (tokens.length > 0) {
      const name = foldText(r.name);
      const sku = r.sku.toLowerCase();
      if (!tokens.every((t) => name.includes(t) || sku.includes(t))) return false;
    }
    return true;
  };
}

/**
 * Rows with maxCostScrap > 0 and status !== 'no-buyers', one per SKU (the
 * highest-confidence input wins), filtered by `q`, sorted by category order
 * then ceiling descending, and paged (`limit` omitted: every row).
 */
export function buildShoppingList(rows: readonly Opportunity[], q: ShoppingQuery, keyPrice: KeyPriceState | null, now: UnixMs): ShoppingListResult {
  const query: ShoppingQuery = q && typeof q === 'object' ? q : {};
  const bySku = new Map<string, Opportunity[]>();
  for (const o of rows) {
    if (!o || typeof o.sku !== 'string') continue;
    const list = bySku.get(o.sku);
    if (list) list.push(o);
    else bySku.set(o.sku, [o]);
  }

  const keep = matcher(query);
  const matched: ShoppingRow[] = [];
  for (const list of bySku.values()) {
    let top: Opportunity | null = null;
    for (const o of list) if (hasCeiling(o) && (top === null || betterInput(o, top))) top = o;
    if (top === null) continue;
    const row = rowFor(top, list);
    if (keep(row)) matched.push(row);
  }
  matched.sort(compareRows);

  const counts = new Map<Category, number>();
  for (const r of matched) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const groups = [...counts.entries()]
    .sort((a, b) => categoryIndex(a[0]) - categoryIndex(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, count]) => ({ category, label: CATEGORY_LABELS[category] ?? category, count, bankPageUrl: scraptfPageFor(category) }));

  const offset = finite(query.offset) ? Math.max(0, Math.floor(query.offset)) : 0;
  const limit = finite(query.limit) ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(query.limit))) : matched.length;
  return { rows: matched.slice(offset, offset + limit), total: matched.length, groups, keyPrice, generatedAt: now };
}

/** Columns: sku, name, category, pay_up_to, revenue, buyer, confidence, known_cost, under_ceiling, bank_page. */
export function shoppingCsv(rows: readonly ShoppingRow[], keyScrap: Scrap | null): string {
  const key = finite(keyScrap) && keyScrap > 0 ? keyScrap : null;
  // Prices as scrap.tf shows them (keys + ref), since this is what the user compares against while browsing.
  const money = (v: Scrap | null): string => (finite(v) ? formatScrap(v, key) : '');
  const out: CsvCell[][] = [['sku', 'name', 'category', 'pay_up_to', 'revenue', 'buyer', 'confidence', 'known_cost', 'under_ceiling', 'bank_page']];
  for (const r of rows) {
    const o = r.revenueOrder;
    out.push([
      r.sku,
      r.name,
      r.category,
      money(r.maxCostScrap),
      money(r.revenueScrap),
      o ? `${o.userName || o.steamid} (${o.isBot ? 'bot' : 'human'})` : '',
      r.confidence,
      money(r.knownCostScrap),
      r.underCeiling,
      r.bankPageUrl,
    ]);
  }
  return toCsv(out);
}
