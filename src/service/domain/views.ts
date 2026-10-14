// Read-side views: the grouped and paged opportunity list, the item detail
// drawer and the rule preview.

import { categoryOfSkuOnly } from '../../shared/categories';
import { buildLinks } from '../../shared/links';
import { fromObject, fromString, looksLikeSku } from '../../shared/sku';
import { CATEGORIES, CATEGORY_LABELS, CURRENCY_SKUS, EMPTY_SPECIAL, PROFIT_TIER_LABELS } from '../../shared/types';
import type {
  Category,
  GroupBy,
  GroupSummary,
  HistoryPoint,
  ItemDetail,
  KeyPriceState,
  Listing,
  OppListResult,
  OppQuery,
  Opportunity,
  OrderSummary,
  RuleFilter,
  Settings,
  UnixMs,
} from '../../shared/types';
import type { Repo, SchemaService } from '../contracts';
import { explicitInput } from './engine';
import { DEFAULT_KEY_SCRAP } from './keyprice';
import { EXCLUDING_FLAGS, UNVERIFIED_AFTER_MS, anyEffectBaseOf, classifyOrder, dedupeOrders, matchContext, ruleMatches } from './matcher';
import type { MatchContext, MatchTarget } from './matcher';
import { computePrices, lookupReferences, outlierRefs, referencePrices, refreshReferenceAge, toOrderSummary, valueOrders } from './pricing';
import { CONFIDENCE_LABELS, CONFIDENCE_ORDER, INPUT_KIND_LABELS, INPUT_KIND_ORDER, TIER_ORDER } from './tiers';

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
export function summarizeGroups(rows: readonly Opportunity[], by: GroupBy): GroupSummary[] {
  const map = new Map<string, GroupSummary>();
  for (const o of rows) {
    const key = groupKeyOf(o, by);
    let g = map.get(key);
    if (!g) map.set(key, (g = { by, key, label: groupLabel(by, key), count: 0, totalProfitScrap: 0 }));
    g.count++;
    g.totalProfitScrap += typeof o.profitScrap === 'number' && Number.isFinite(o.profitScrap) ? o.profitScrap : 0;
  }
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
 */
export function listOpportunities(repo: Repo, q: OppQuery, keyPrice: KeyPriceState | null, now: UnixMs): OppListResult {
  const query: OppQuery = q && typeof q === 'object' ? q : {};
  const by = typeof query.groupBy === 'string' && GROUP_BYS.includes(query.groupBy) ? query.groupBy : null;

  let groups: GroupSummary[] = [];
  let total: number;
  if (by) {
    const order = groupOrder(by);
    groups = repo
      .opportunityGroupStats(query, by)
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
  const rows = page.map((o) => ({ ...o, references: refreshReferenceAge(o.references, now) }));
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

/**
 * Everything the item drawer shows. Buy orders are classified against the
 * item's most recent scrap.tf price (its extras), or against a clean copy when
 * there is none. Returns null for text that is not a SKU or an item nothing is
 * known about.
 */
export function buildItemDetail(args: ItemDetailArgs): ItemDetail | null {
  const { repo, schema, settings, now } = args;
  if (typeof args.sku !== 'string' || !looksLikeSku(args.sku)) return null;
  const obj = fromString(args.sku.trim());
  const sku = fromObject(obj);
  const base = fromObject({ ...obj, paint: null });
  const keyScrap = args.keyPrice?.valueScrap && args.keyPrice.valueScrap > 0 ? args.keyPrice.valueScrap : DEFAULT_KEY_SCRAP;

  const scrapPrices = repo.scrapPricesForSku(sku);
  const opportunities = repo.opportunitiesForSku(sku);
  const listings = repo.listingsByBaseSku(base);
  const anyBase = anyEffectBaseOf(base);
  // Generic "Unusual <item>" orders buy any effect, so they are exits for this one too.
  const anyEffectBuys = anyBase !== null ? repo.listingsByBaseSku(anyBase, 'buy') : [];
  const buys = [...listings.filter((l) => l.intent === 'buy'), ...anyEffectBuys];
  const sells = listings.filter((l) => l.intent === 'sell');
  const raw = lookupReferences(repo, base);
  const schemaItem = attempt(() => schema.itemByDefindex(obj.defindex), null);
  if (!schemaItem && listings.length === 0 && scrapPrices.length === 0 && opportunities.length === 0 && !raw.pricedb && !raw.community) {
    return null;
  }

  const paint = typeof obj.paint === 'number' && obj.paint > 0 ? obj.paint : null;
  const fromPrice = scrapPrices.length > 0 ? explicitInput(scrapPrices[0]!) : null;
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
  const prices = computePrices(
    valued.filter((o) => o.eligible),
    outlierRefs(references),
    settings.profit,
  );
  const buyOrders = valued
    .map((o) => toOrderSummary(o, prices.outlierIds.has(o.listing.id) ? ['outlier'] : []))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible));

  const schemaName = attempt(() => schema.nameForSku(sku), sku);
  const name =
    schemaName && schemaName !== sku
      ? schemaName
      : (scrapPrices.find((p) => p.name.trim())?.name ?? buys.find((l) => l.itemName)?.itemName ?? sku);
  const rawCategory = attempt<Category | null>(() => schema.categoryForSku(sku), null);
  const category = rawCategory !== null && CATEGORIES.includes(rawCategory) ? rawCategory : categoryOfSkuOnly(obj);

  const links = attempt(
    () =>
      buildLinks({
        sku,
        skuObject: obj,
        fullName: name,
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
    category,
    skuObject: obj,
    buyOrders,
    sellListings: sellSummaries(sells, match, keyScrap),
    references,
    scrapPrices,
    opportunities: opportunities.map((o) => ({ ...o, references: refreshReferenceAge(o.references, now) })),
    history: Array.isArray(args.history) ? args.history : [],
    links,
    snapshot: args.snapshot,
    keyPrice: args.keyPrice,
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
  for (const base of repo.baseSkusWithBuyOrders()) {
    if (CURRENCY.has(base) || explicit.has(base) || !looksLikeSku(base)) continue;
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
