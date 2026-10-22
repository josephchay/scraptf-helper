// Read-side views: the grouped and paged opportunity list, the item detail
// drawer and the rule preview.

import { categoryOfSkuOnly, scraptfBankForItem } from '../../shared/categories';
import { buildLinks, scraptfSeenOn } from '../../shared/links';
import { scraptfListPriceSaved } from '../../shared/scraptfList';
import { fromObject, fromString, isValidSku, looksLikeSku } from '../../shared/sku';
import { CATEGORIES, CATEGORY_LABELS, CURRENCY_SKUS, EMPTY_SPECIAL, PROFIT_TIER_LABELS } from '../../shared/types';
import type {
  Category,
  GroupBy,
  GroupSummary,
  HistoryPoint,
  ItemDetail,
  ItemRevenue,
  KeyPriceState,
  Listing,
  OppListResult,
  OppQuery,
  Opportunity,
  OrderSummary,
  RuleFilter,
  ScrapPrice,
  ScraptfBuyTiming,
  ScraptfListRow,
  ScraptfTimingBrief,
  Settings,
  UnixMs,
} from '../../shared/types';
import type { Repo, SchemaService } from '../contracts';
import { onceByOrderProfit } from '../../shared/copyExtras';
import type { ScraptfEventBuySide } from '../../shared/scraptfHistory';
import { scraptfOpportunityTiming } from '../../shared/scraptfTiming';
import { explicitInput, revenueOrderOf } from './engine';
import { DEFAULT_KEY_SCRAP } from './keyprice';
import { EXCLUDING_FLAGS, UNVERIFIED_AFTER_MS, anyEffectBaseOf, classifyOrder, dedupeOrders, matchContext, ruleMatches } from './matcher';
import type { MatchContext, MatchTarget } from './matcher';
import { bookBasesOf, canonicalBookBase, mergedBook } from './bookTwins';
import {
  computePrices,
  lookupReferences,
  outlierRefs,
  pickRevenueOrder,
  referencePrices,
  refreshReferenceAge,
  toOrderSummary,
  usableReferences,
  valueOrders,
} from './pricing';
import type { PriceResult, ValuedOrderLike } from './pricing';
import { CONFIDENCE_LABELS, CONFIDENCE_ORDER, INPUT_KIND_LABELS, INPUT_KIND_ORDER, TIER_ORDER, maxCostFor } from './tiers';
import { askSideOf } from '../../shared/holdings';
import { askCandidatesOf } from './asks';

export const DEFAULT_LIST_LIMIT = 500;
export const MAX_LIST_LIMIT = 5000;
const GROUP_BYS: readonly GroupBy[] = ['category', 'tier', 'confidence', 'input'];
const CURRENCY: ReadonlySet<string> = new Set(CURRENCY_SKUS);

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
      return INPUT_KIND_ORDER;
  }
}

export function groupLabel(by: GroupBy, key: string): string {
  const table: Record<string, string> =
    by === 'category' ? CATEGORY_LABELS : by === 'tier' ? PROFIT_TIER_LABELS : by === 'confidence' ? CONFIDENCE_LABELS : INPUT_KIND_LABELS;
  return Object.hasOwn(table, key) ? table[key]! : key;
}

function orderIndex(order: readonly string[], key: string): number {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}

/** Non-empty groups in display order, with counts and summed profit (null profit counts as 0). */
export function summarizeGroups(rows: readonly Opportunity[], by: GroupBy, useOrder: Settings['profit']['useOrder'] = 'conservative'): GroupSummary[] {
  const map = new Map<string, GroupSummary>();
  const rowsOf = new Map<string, Opportunity[]>();
  for (const o of rows) {
    const key = groupKeyOf(o, by);
    let g = map.get(key);
    if (!g) map.set(key, (g = { by, key, label: groupLabel(by, key), count: 0, totalProfitScrap: 0 }));
    g.count++;
    rowsOf.set(key, [...(rowsOf.get(key) ?? []), o]);
  }
  // 0.7.4 (F27, F33; R27): an item's revenue order counts once per group, at its best copy among these rows
  // (as opportunityGroupStats), so a filter that hid the best copy no longer counts the buyer zero times.
  for (const [key, g] of map) g.totalProfitScrap = onceByOrderProfit(rowsOf.get(key) ?? [], (o) => revenueOrderOf(o, useOrder));
  const order = groupOrder(by);
  return [...map.values()].sort((a, b) => orderIndex(order, a.key) - orderIndex(order, b.key) || a.key.localeCompare(b.key));
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/**
 * Filtered, sorted and paged by the repo in SQL, so only the page is parsed;
 * when grouped, rows are ordered by group first (keeping the requested sort
 * inside each group) so a page holds whole groups in display order. Groups
 * and the total are counted in SQL over every match, not just the page.
 * 0.7.4 (R27): `useOrder` (settings.profit.useOrder) names each row's revenue order for the group totals.
 * 0.8 (T4/T7): `joins.timingForCopy` (the history's, in memory) joins Opportunity.timing on the page's 'import' rows
 * (scraptfOpportunityTiming); a failed join leaves the field out, never the row.
 */
export function listOpportunities(
  repo: Repo,
  q: OppQuery,
  keyPrice: KeyPriceState | null,
  now: UnixMs,
  useOrder?: Settings['profit']['useOrder'],
  joins?: { timingForCopy?(baseSku: string, specialKey: string, buy: ScraptfEventBuySide, now: UnixMs): ScraptfBuyTiming | null },
): OppListResult {
  const query: OppQuery = q && typeof q === 'object' ? q : {};
  const by = typeof query.groupBy === 'string' && GROUP_BYS.includes(query.groupBy) ? query.groupBy : null;

  let groups: GroupSummary[] = [];
  let total: number;
  if (by) {
    const order = groupOrder(by);
    groups = repo
      .opportunityGroupStats(query, by, useOrder)
      .filter((s) => s.count > 0)
      .map((s) => ({ by, key: s.key, label: groupLabel(by, s.key), count: s.count, totalProfitScrap: s.profitScrap }))
      .sort((a, b) => orderIndex(order, a.key) - orderIndex(order, b.key) || a.key.localeCompare(b.key));
    total = groups.reduce((n, g) => n + g.count, 0);
  } else {
    total = repo.countOpportunities(query);
  }

  const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(query.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const page = offset >= total ? [] : repo.queryOpportunities(query, { limit, offset, group: by ? { by, order: groupOrder(by) } : null });
  const timingForCopy = joins?.timingForCopy ? joins.timingForCopy.bind(joins) : null;
  const rows = page.map((o) => {
    let brief: ScraptfTimingBrief | null = null;
    if (timingForCopy) {
      try {
        brief = scraptfOpportunityTiming(o, timingForCopy, now);
      } catch {
        brief = null;
      }
    }
    return { ...o, references: refreshReferenceAge(o.references, now), ...(brief ? { timing: brief } : {}) };
  });
  return { rows, total, groups, keyPrice, generatedAt: now };
}

// ---------------------------------------------------------------------------
// Item detail
// ---------------------------------------------------------------------------

export interface ItemDetailArgs {
  repo: Repo;
  schema: SchemaService;
  sku: string;
  keyPrice: KeyPriceState | null;
  settings: Settings;
  now: UnixMs;
  snapshot: ItemDetail['snapshot'];
  history?: HistoryPoint[];
  /**
   * What the buy book is classified against. 'newest' (default, the drawer): the
   * newest stored copy's extras. 'plain' (quick entry): a clean copy of `sku`,
   * paint from the SKU only, which is the row quick entry's prices.upsert creates.
   */
  target?: 'newest' | 'plain';
  /** F14: the base SKU's saved scrap.tf/items list row (scraptfList.rowFor), passed through as ItemDetail.scraptfList. */
  scraptfList?: ScraptfListRow | null;
  /** F17: the item in the newest bank-stock save listing it (BankStock.detailFor), passed through as ItemDetail.bankStock. */
  bankStock?: ItemDetail['bankStock'];
}

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function sellSummaries(sells: readonly Listing[], match: MatchContext, keyScrap: number): OrderSummary[] {
  const flagged = sells.map((listing) => {
    const flags: string[] = [];
    if (listing.isMarketplace) flags.push('marketplace');
    if (listing.userBanned) flags.push('banned');
    if (match.blocklist.has(listing.steamid)) flags.push('blocklisted');
    if (!Number.isFinite(listing.lastEventAt) || match.now - listing.lastEventAt > UNVERIFIED_AFTER_MS) flags.push('unverified');
    return { listing, flags, eligible: !flags.some((f) => EXCLUDING_FLAGS.has(f)) };
  });
  return valueOrders(flagged, keyScrap)
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.valueScrap - b.valueScrap)
    .map((o) => toOrderSummary(o));
}

/** Feature F2: the engine's revenue for this book (same prices, same useOrder pick) with its "pay up to" ceiling. */
export function itemRevenue<T extends ValuedOrderLike>(prices: PriceResult<T>, eligibleCount: number, settings: Settings): ItemRevenue {
  const useOrder = settings.profit.useOrder;
  const chosen = pickRevenueOrder(prices, useOrder);
  const revenueScrap = chosen?.valueScrap ?? null;
  return {
    bestScrap: prices.best?.valueScrap ?? null,
    consScrap: prices.conservative?.valueScrap ?? null,
    instantScrap: prices.instant?.valueScrap ?? null,
    useOrder,
    revenueScrap,
    order: chosen ? toOrderSummary(chosen, prices.outlierIds.has(chosen.listing.id) ? ['outlier'] : []) : null,
    maxCostScrap: maxCostFor(revenueScrap, settings.profit),
    eligibleCount,
  };
}

/** A painted SKU's prices, newest first: rows stored under it, and the base SKU's rows (`baseRows`) of that paint. */
function pricesOfPaint(repo: Repo, sku: string, base: string, paint: number, baseRows: readonly ScrapPrice[]): ScrapPrice[] {
  const own = sku === base ? [] : repo.scrapPricesForSku(sku);
  const ofPaint = baseRows.filter((p) => p.special?.paint === paint);
  return [...own, ...ofPaint].sort((a, b) => b.observedAt - a.observedAt || b.id - a.id);
}

/**
 * ItemDetail.seenOn (F15): the bank of the newest imported price shown (`prices`). A painted SKU none
 * of whose own prices was imported falls back to the base SKU's other copies, from bank pages only:
 * the bank that sold a plain or other-paint copy sells this item too, while the /items list shows
 * plain copies only, so it is no place to look for a painted one (the category mapping is, then).
 */
export function itemSeenOn(prices: readonly ScrapPrice[], baseRows: readonly ScrapPrice[] | null): ItemDetail['seenOn'] {
  const own = scraptfSeenOn(prices);
  if (own !== null || baseRows === null) return own;
  return scraptfSeenOn(baseRows.filter((p) => p.bank !== 'list'));
}

/**
 * Everything the item drawer shows. Buy orders are classified against the
 * item's most recent scrap.tf price (its extras), or against a clean copy when
 * there is none or `target` is 'plain'. Returns null for text that is not a SKU
 * or an item nothing is known about.
 */
export function buildItemDetail(args: ItemDetailArgs): ItemDetail | null {
  const { repo, schema, settings, now } = args;
  // Strict: "205;11;KT-3" must not show the drawer of plain "205;11".
  if (typeof args.sku !== 'string' || !isValidSku(args.sku)) return null;
  const obj = fromString(args.sku.trim());
  const sku = fromObject(obj);
  const base = fromObject({ ...obj, paint: null });
  const keyScrap = args.keyPrice?.valueScrap && args.keyPrice.valueScrap > 0 ? args.keyPrice.valueScrap : DEFAULT_KEY_SCRAP;

  const paint = typeof obj.paint === 'number' && obj.paint > 0 ? obj.paint : null;
  // Prices are stored under the base SKU with the paint in their extras (prices.upsert, saved pages),
  // so a painted SKU's own prices are the base rows of that paint (plus any stored under it as is).
  // The base rows are read once: the list's "already saved" test and seenOn's fallback read them too.
  const baseRows = paint === null ? null : repo.scrapPricesForSku(base);
  const scrapPrices = paint === null || baseRows === null ? repo.scrapPricesForSku(sku) : pricesOfPaint(repo, sku, base, paint, baseRows);
  const opportunities = repo.opportunitiesForSku(sku);
  // 0.7.4 (F09/F14, F08): the item's book from every twin it is filed under (bookTwins.ts), as the engine reads it.
  const listings = mergedBook(base, bookBasesOf(schema, base), (b) => repo.listingsByBaseSku(b));
  const anyBase = anyEffectBaseOf(base);
  // Generic "Unusual <item>" orders buy any effect, so they are exits for this one too.
  const anyEffectBuys = anyBase !== null ? mergedBook(anyBase, bookBasesOf(schema, anyBase), (b) => repo.listingsByBaseSku(b, 'buy')) : [];
  const buys = [...listings.filter((l) => l.intent === 'buy'), ...anyEffectBuys];
  const sells = listings.filter((l) => l.intent === 'sell');
  const raw = lookupReferences(repo, base, schema);
  const schemaItem = attempt(() => schema.itemByDefindex(obj.defindex), null);
  const scraptfList = args.scraptfList ?? null;
  if (
    !schemaItem &&
    !scraptfList &&
    listings.length === 0 &&
    scrapPrices.length === 0 &&
    opportunities.length === 0 &&
    !raw.pricedb &&
    !raw.community
  ) {
    return null;
  }

  // Quick entry saves a plain copy, so its preview must not inherit a newer painted or spelled import's extras.
  const fromPrice = args.target !== 'plain' && scrapPrices.length > 0 ? explicitInput(scrapPrices[0]!) : null;
  const target: MatchTarget = fromPrice?.target ?? {
    baseSku: base,
    special: { ...EMPTY_SPECIAL, spells: [], parts: [], paint },
    hasExtras: paint !== null,
    anyEffectBase: anyBase,
  };

  const match = matchContext(settings, now);
  const references = referencePrices(raw, keyScrap, now);
  const { kept, duplicates } = dedupeOrders(buys);
  const classified = [
    ...kept.map((listing) => ({ listing, ...classifyOrder(listing, target, match) })),
    ...duplicates.map((listing) => {
      const c = classifyOrder(listing, target, match);
      return { listing, eligible: false, flags: [...c.flags, 'duplicate'] };
    }),
  ];
  const valued = valueOrders(classified, keyScrap);
  const eligible = valued.filter((o) => o.eligible);
  // Stale references are ignored exactly as the engine does (F4), so the drawer agrees with the row.
  const prices = computePrices(eligible, outlierRefs(usableReferences(references, settings.profit.referenceMaxAgeMs, now).references), settings.profit);
  const buyOrders = valued
    .map((o) => toOrderSummary(o, prices.outlierIds.has(o.listing.id) ? ['outlier'] : []))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible));

  const schemaName = attempt(() => schema.nameForSku(sku), sku);
  // The saved scrap.tf list names its items too (F14), so an item known only from it is not shown as a raw SKU.
  const listName = scraptfList && typeof scraptfList.name === 'string' && scraptfList.name.trim() ? scraptfList.name : null;
  const name =
    schemaName && schemaName !== sku
      ? schemaName
      : (scrapPrices.find((p) => p.name.trim())?.name ?? buys.find((l) => l.itemName)?.itemName ?? listName ?? sku);
  const rawCategory = attempt<Category | null>(() => schema.categoryForSku(sku), null);
  const category = rawCategory !== null && CATEGORIES.includes(rawCategory) ? rawCategory : categoryOfSkuOnly(obj);
  // backpack.tf names never include paint (the schema appends "(Paint: …)" for painted SKUs), so
  // a painted item is searched on backpack.tf by its unpainted name.
  const baseName = base === sku ? name : attempt(() => schema.nameForSku(base), base);
  const bptfName = baseName && baseName !== base ? baseName : name;

  const links = attempt(
    () =>
      buildLinks({
        sku,
        skuObject: obj,
        fullName: bptfName,
        baseName: attempt(() => schema.baseNameForSku(sku), ''),
        marketHashName: attempt(() => schema.marketHashName(sku), null),
        effectName: obj.effect !== null ? attempt(() => schema.effectName(obj.effect!), null) : null,
        paintkitName: obj.paintkit !== null ? attempt(() => schema.paintkitName(obj.paintkit!), null) : null,
        assetId: scrapPrices.find((p) => p.assetId)?.assetId ?? null,
        category,
      }),
    [],
  );

  return {
    sku,
    name,
    // The links' fullName.
    bptfName,
    category,
    skuObject: obj,
    revenue: itemRevenue(prices, eligible.length, settings),
    buyOrders,
    sellListings: sellSummaries(sells, match, keyScrap),
    references,
    scrapPrices,
    opportunities: opportunities.map((o) => ({ ...o, references: refreshReferenceAge(o.references, now) })),
    history: Array.isArray(args.history) ? args.history : [],
    links,
    snapshot: args.snapshot,
    keyPrice: args.keyPrice,
    scraptfList,
    // "Use as my price" stores the plain copy under the list's base SKU, which a painted SKU's
    // scrapPrices (pricesOfPaint) never include; read those rows so its drawer sees the save too.
    scraptfListSaved:
      scraptfList !== null &&
      scraptfListPriceSaved(
        scraptfList,
        scraptfList.sku === sku ? scrapPrices : baseRows !== null && scraptfList.sku === base ? baseRows : repo.scrapPricesForSku(scraptfList.sku),
      ),
    // F15: the bank of the newest imported price shown here (ScrapPrice.bank is joined by the repo), for
    // the drawer's "Seen on" and every "Open bank page" (the drawer's and the ItemMenu's item.detail).
    seenOn: itemSeenOn(scrapPrices, baseRows),
    // 0.7.4 (F36): where an item of its kind is sold, for "Open bank page" when no save names a page.
    kindBank: scraptfBankForItem(category, obj, schemaItem),
    bankStock: args.bankStock ?? null,
    // 0.8 (H3, PC-7): the lowest ask for this copy (the drawer SKU's paint, no other extras) from the sell listings
    // already read above; context only, never used in profit, Pay up to or a notification.
    ask: attempt(() => askSideOf(askCandidatesOf(sells, paint, match, keyScrap), now, new Set(settings.ownSteamIds ?? [])), null),
  };
}

// ---------------------------------------------------------------------------
// Rule preview
// ---------------------------------------------------------------------------

/** How many base SKUs with buy orders a rule would evaluate (explicit prices win), plus a sample. */
export function previewRule(
  repo: Repo,
  schema: SchemaService,
  filter: RuleFilter,
  sampleLimit = 20,
): { matchingSkus: number; sample: { sku: string; name: string }[] } {
  const explicit = new Set<string>();
  for (const sp of repo.listScrapPrices()) {
    const inp = explicitInput(sp);
    if (inp) explicit.add(inp.sku);
  }
  const limit = clampInt(sampleLimit, 20, 0, 500);
  const sample: { sku: string; name: string }[] = [];
  let matchingSkus = 0;
  // 0.7.4 (F09/F14): one item per book, on its canonical base, as the engine's rule rows are.
  for (const base of new Set(repo.baseSkusWithBuyOrders().map((b) => canonicalBookBase(schema, b)))) {
    if (CURRENCY.has(base) || explicit.has(base) || !looksLikeSku(base)) continue;
    if (bookBasesOf(schema, base).some((t) => explicit.has(t))) continue;
    const obj = fromString(base);
    if (!obj.tradable) continue;
    const rawCategory = attempt<Category | null>(() => schema.categoryForSku(base), null);
    const category = rawCategory !== null && CATEGORIES.includes(rawCategory) ? rawCategory : categoryOfSkuOnly(obj);
    const name = (): string => attempt(() => schema.nameForSku(base), base);
    if (!ruleMatches(filter ?? {}, { obj, category, name })) continue;
    matchingSkus++;
    if (sample.length < limit) sample.push({ sku: base, name: name() });
  }
  return { matchingSkus, sample };
}
