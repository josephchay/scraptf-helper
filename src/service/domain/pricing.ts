// Order valuation, outliers and the conservative / instant prices (design brief
// §5.5), plus reference prices valued with the current key price.

import { refToScrap, valueScrap } from '../../shared/currency';
import { COMMUNITY_MIN_MAX_AGE_MS, communityMaxAgeMs } from '../../shared/referenceAge';
import { craftabilityTwin } from '../../shared/ceiling';
import { toLegacy } from '../../shared/sku';
import type {
  CommunityRow,
  Listing,
  OrderSummary,
  PricedbRow,
  ProfitSettings,
  ReferencePrices,
  Scrap,
  UnixMs,
} from '../../shared/types';
import type { Repo, SchemaService } from '../contracts';
import { canonicalBookBase } from './bookTwins';
import type { OrderClass } from './matcher';

export { maxCostFor, minProfitFor, profitStatus, profitTier } from './tiers';
export { craftabilityTwin };

export interface ClassifiedOrder extends OrderClass {
  listing: Listing;
}

export interface ValuedOrderLike {
  listing: Listing;
  valueScrap: Scrap;
}

export type ValuedOrder = ClassifiedOrder & { valueScrap: Scrap };

const DEFAULT_OUTLIER_VS_MEDIAN = 1.3;
const DEFAULT_OUTLIER_VS_REF = 1.5;
/** Orders in the median for outlier detection: the top min(5, n). */
const MEDIAN_TOP = 5;
const MAX_DETAILS_CHARS = 300;

/** Highest value first; ties prefer bots, then the most recently seen, then the id. */
export function compareValued(a: ValuedOrderLike, b: ValuedOrderLike): number {
  return (
    b.valueScrap - a.valueScrap ||
    Number(b.listing.isBot) - Number(a.listing.isBot) ||
    b.listing.lastEventAt - a.listing.lastEventAt ||
    (a.listing.id < b.listing.id ? -1 : a.listing.id > b.listing.id ? 1 : 0)
  );
}

/** Values each order (keys at `keyScrap`) and sorts best first. */
export function valueOrders<T extends { listing: Listing }>(orders: readonly T[], keyScrap: Scrap): (T & { valueScrap: Scrap })[] {
  return orders
    .map((o) => ({ ...o, valueScrap: valueScrap(finiteOr0(o.listing.keys), finiteOr0(o.listing.metalScrap), keyScrap) }))
    .sort(compareValued);
}

function finiteOr0(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface PriceRefs {
  pricedbSellScrap?: Scrap | null;
  communityHighScrap?: Scrap | null;
}

export interface PriceResult<T> {
  best: T | null;
  conservative: T | null;
  instant: T | null;
  /** Listing ids of eligible orders that are outliers. */
  outlierIds: Set<string>;
  /** Median of the top min(5, n) positive values of the verified orders (all orders when none is verified). */
  ref: number | null;
}

function multiplier(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function positive(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 0.7.4: an order classifyOrder flagged 'unverified' (no feed event or snapshot for 24 h). Orders
 * without flags (ValuedOrderLike callers) count as verified.
 */
export function isUnverifiedOrder(o: ValuedOrderLike): boolean {
  const flags = (o as { flags?: unknown }).flags;
  return Array.isArray(flags) && flags.includes('unverified');
}

/**
 * Brief §5.5. An order is an outlier when (n ≥ 3 and value > 1.30 × median of
 * the top five), or value > 1.50 × the PriceDB sell price, or value > 1.50 ×
 * the community high price. Best is the top order, Conservative the first
 * non-outlier, Instant the best non-outlier bot order.
 *
 * 0.7.4 (F13, F21, F47): an order nobody has confirmed for 24 h may have been filled or removed while
 * the app or the feed was off (the feed has no catch-up). When at least one order is verified,
 * Conservative and the median come from the verified orders only; Best stays the overall top order (it
 * keeps its 'unverified' flag). With none verified, Conservative is picked as before (the row is capped
 * at Medium and never toasted). Verified orders are preferred, not exclusive: when every verified order
 * is an outlier (one fresh mistaken order above PriceDB's sell price on an older book), Conservative is
 * the top non-outlier unverified order, as with none verified (it keeps its flag: Medium at most, never
 * toasted), so a fresher book never prices worse than the same book without its fresh order. Instant
 * never picks an unverified bot order: a bot not seen for a day is no instant sale (F23). F19: a
 * zero-valued order (a "0.05 ref" weapon-priced one rounds to 0 scrap) is left out of the median and is
 * never an outlier, so it cannot make every real order one.
 */
export function computePrices<T extends ValuedOrderLike>(
  eligible: readonly T[],
  refs: PriceRefs,
  settings: Pick<ProfitSettings, 'outlierVsMedian' | 'outlierVsRef'>,
): PriceResult<T> {
  const sorted = [...eligible].sort(compareValued);
  const anyVerified = sorted.some((o) => !isUnverifiedOrder(o));
  const inPool = (o: T): boolean => !anyVerified || !isUnverifiedOrder(o);
  const sample = sorted.filter((o) => inPool(o) && o.valueScrap > 0);
  const n = sample.length;
  const ref = median(sample.slice(0, MEDIAN_TOP).map((o) => o.valueScrap));
  const vsMedian = multiplier(settings.outlierVsMedian, DEFAULT_OUTLIER_VS_MEDIAN);
  const vsRef = multiplier(settings.outlierVsRef, DEFAULT_OUTLIER_VS_REF);
  const pdbSell = positive(refs.pricedbSellScrap);
  const commHigh = positive(refs.communityHighScrap);

  const isOutlier = (v: number): boolean =>
    v > 0 &&
    ((n >= 3 && ref !== null && v > vsMedian * ref) || (pdbSell !== null && v > vsRef * pdbSell) || (commHigh !== null && v > vsRef * commHigh));

  const outlierIds = new Set<string>();
  let conservative: T | null = null;
  let instant: T | null = null;
  /** 0.7.4: the top non-outlier order outside the verified pool, for a book whose verified orders are all outliers. */
  let fallback: T | null = null;
  for (const o of sorted) {
    if (isOutlier(o.valueScrap)) {
      outlierIds.add(o.listing.id);
      continue;
    }
    if (!inPool(o)) {
      if (fallback === null) fallback = o;
      continue;
    }
    if (conservative === null) conservative = o;
    if (instant === null && o.listing.isBot && !isUnverifiedOrder(o)) instant = o;
    if (conservative !== null && instant !== null) break;
  }
  // The checks are monotone in value (an outlier is worth more than every non-outlier), so every outlier
  // comes before the conservative and instant orders and none is missed by the early break. The loop only
  // breaks once a pool order is Conservative, so with none `fallback` is the highest non-outlier unverified
  // order. Instant stays verified bots only (F23).
  if (conservative === null) conservative = fallback;
  return { best: sorted[0] ?? null, conservative, instant, outlierIds, ref };
}

/** The order profit is based on, per settings.profit.useOrder. Shared by the engine and item.detail so both agree. */
export function pickRevenueOrder<T>(prices: Pick<PriceResult<T>, 'best' | 'conservative' | 'instant'>, useOrder: ProfitSettings['useOrder']): T | null {
  if (useOrder === 'best') return prices.best;
  if (useOrder === 'instant') return prices.instant;
  return prices.conservative;
}

// ---------------------------------------------------------------------------
// Order summaries
// ---------------------------------------------------------------------------

export function toOrderSummary(o: ValuedOrderLike & Partial<OrderClass>, extraFlags: readonly string[] = []): OrderSummary {
  const l = o.listing;
  const flags = [...(o.flags ?? [])];
  for (const f of extraFlags) if (!flags.includes(f)) flags.push(f);
  const details = typeof l.details === 'string' ? l.details : '';
  return {
    listingId: l.id,
    steamid: l.steamid,
    userName: l.userName,
    keys: finiteOr0(l.keys),
    metalScrap: finiteOr0(l.metalScrap),
    valueScrap: o.valueScrap,
    isBot: l.isBot === true,
    online: l.userOnline ?? null,
    lastEventAt: l.lastEventAt,
    bumpedAt: l.bumpedAt,
    details: details.length > MAX_DETAILS_CHARS ? `${details.slice(0, MAX_DETAILS_CHARS - 1)}…` : details,
    flags,
    eligible: o.eligible ?? true,
  };
}

// ---------------------------------------------------------------------------
// Reference prices
// ---------------------------------------------------------------------------

export interface RawReferences {
  pricedb: PricedbRow | null;
  community: CommunityRow | null;
}

type RefRepo = Pick<Repo, 'getPricedb' | 'getSkuAlias' | 'getCommunity'>;

/**
 * PriceDB row by the canonical v3 SKU, then the alias, then the legacy form; community by v3, then legacy.
 * 0.7.4 (F09): with a schema, a base that is not its book's canonical one (811;1, 833;14, 18;11;australium)
 * and finds no row of a source takes that source's row from the canonical base (SchemaService.bookBase),
 * the copy PriceDB and backpack.tf price the name under. Local reads only, no request.
 */
export function lookupReferences(repo: RefRepo, sku: string, schema?: Pick<SchemaService, 'bookBase'> | null): RawReferences {
  const own = lookupOwnReferences(repo, sku);
  if ((own.pricedb && own.community) || !schema) return own;
  const canonical = canonicalBookBase(schema, sku);
  if (canonical === sku) return own;
  const book = lookupOwnReferences(repo, canonical);
  return { pricedb: own.pricedb ?? book.pricedb, community: own.community ?? book.community };
}

function lookupOwnReferences(repo: RefRepo, sku: string): RawReferences {
  const legacy = toLegacy(sku);
  // pricedb.ts stores rows under our canonical v3 SKU; the alias (PriceDB's own
  // spelling) and the legacy form only cover rows written by older code.
  let pricedb = repo.getPricedb(sku);
  if (!pricedb) {
    const alias = repo.getSkuAlias(sku);
    if (alias && alias !== sku) pricedb = repo.getPricedb(alias);
  }
  if (!pricedb && legacy !== sku) pricedb = repo.getPricedb(legacy);
  let community = repo.getCommunity(sku);
  if (!community && legacy !== sku) community = repo.getCommunity(legacy);
  return { pricedb, community };
}

/** 0.7.4 (F70): the twin's references (lookupReferences on craftabilityTwin(sku)), or null without a twin. */
export function lookupTwinReferences(repo: RefRepo, sku: string): RawReferences | null {
  const twin = craftabilityTwin(sku);
  return twin === null ? null : lookupReferences(repo, twin);
}

/** A community price in scrap; USD (or unknown currencies) cannot be converted. */
export function communityScrap(currency: string, value: number | null, keyScrap: Scrap): Scrap | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const c = typeof currency === 'string' ? currency.toLowerCase() : '';
  if (c === 'metal') return refToScrap(value);
  if (c === 'keys') return Number.isFinite(keyScrap) && keyScrap > 0 ? Math.round(value * keyScrap) : null;
  return null;
}

function pricedbSide(keys: number, scrap: number, keyScrap: Scrap): Scrap | null {
  const v = valueScrap(finiteOr0(keys), finiteOr0(scrap), keyScrap);
  return v > 0 ? v : null;
}

export function referencePrices(raw: RawReferences, keyScrap: Scrap, now: UnixMs): ReferencePrices {
  const p = raw.pricedb;
  const c = raw.community;
  let pricedb: ReferencePrices['pricedb'] = null;
  if (p) {
    const buyScrap = pricedbSide(p.buyKeys, p.buyScrap, keyScrap);
    const sellScrap = pricedbSide(p.sellKeys, p.sellScrap, keyScrap);
    if (buyScrap !== null || sellScrap !== null) {
      const time = Number.isFinite(p.time) && p.time > 0 ? p.time : null;
      const basis = time !== null ? time * 1000 : Number.isFinite(p.fetchedAt) && p.fetchedAt > 0 ? p.fetchedAt : null;
      pricedb = { buyScrap, sellScrap, time, ageMs: basis === null ? null : Math.max(0, now - basis) };
    }
  }
  let community: ReferencePrices['community'] = null;
  if (c) {
    const valueScrap = communityScrap(c.currency, c.value, keyScrap);
    const valueHighScrap = communityScrap(c.currency, c.valueHigh, keyScrap);
    if (valueScrap !== null || valueHighScrap !== null) community = { valueScrap, valueHighScrap, lastUpdate: c.lastUpdate };
  }
  return { pricedb, community };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches DEFAULT_SETTINGS.profit.referenceMaxAgeMs; used when the setting is missing or broken. */
export const DEFAULT_REFERENCE_MAX_AGE_MS = 30 * DAY_MS;
// Lives in src/shared so the item drawer marks a community price ignored exactly when this gate drops it.
export { COMMUNITY_MIN_MAX_AGE_MS };

export interface UsableReferences {
  /** The references with every stale one replaced by null. The same object when nothing is stale. */
  references: ReferencePrices;
  /** One reason per ignored reference, e.g. "PriceDB price is 400 days old, ignored". */
  stale: string[];
}

/**
 * Feature F4. A PriceDB price (ageMs) older than `maxAgeMs`, or a community price
 * (lastUpdate) older than max(maxAgeMs, COMMUNITY_MIN_MAX_AGE_MS), counts as absent:
 * about a third of PriceDB SKUs are months old (brief §2.7), and an old price would
 * mark every current order an outlier. An unknown age counts as current, as before.
 */
export function usableReferences(refs: ReferencePrices, maxAgeMs: number | undefined, now: UnixMs): UsableReferences {
  const limit = typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : DEFAULT_REFERENCE_MAX_AGE_MS;
  const stale: string[] = [];
  let pricedb = refs.pricedb;
  const pAge = pricedb?.ageMs;
  if (pricedb && typeof pAge === 'number' && Number.isFinite(pAge) && pAge > limit) {
    stale.push(`PriceDB price is ${Math.floor(pAge / DAY_MS)} days old, ignored`);
    pricedb = null;
  }
  let community = refs.community;
  const last = community?.lastUpdate;
  const cAge = typeof last === 'number' && Number.isFinite(last) && last > 0 ? now - last * 1000 : null;
  if (community && cAge !== null && cAge > communityMaxAgeMs(limit)) {
    stale.push(`Community price is ${Math.floor(cAge / DAY_MS)} days old, ignored`);
    community = null;
  }
  return { references: stale.length === 0 ? refs : { pricedb, community }, stale };
}

/** True when some reference value can sanity-check an order (any PriceDB or community price). */
export function hasReferenceValue(refs: ReferencePrices): boolean {
  return (
    positive(refs.pricedb?.buyScrap) !== null ||
    positive(refs.pricedb?.sellScrap) !== null ||
    positive(refs.community?.valueScrap) !== null ||
    positive(refs.community?.valueHighScrap) !== null
  );
}

/** The reference values the outlier rules use. A single community price is its own high. Pass usableReferences(...).references. */
export function outlierRefs(refs: ReferencePrices): PriceRefs {
  return {
    pricedbSellScrap: refs.pricedb?.sellScrap ?? null,
    communityHighScrap: refs.community?.valueHighScrap ?? refs.community?.valueScrap ?? null,
  };
}

/** Recomputes the PriceDB age at read time (stored rows keep the age from their last change). */
export function refreshReferenceAge(refs: ReferencePrices, now: UnixMs): ReferencePrices {
  const p = refs.pricedb;
  if (!p || p.time === null || !Number.isFinite(p.time)) return refs;
  return { ...refs, pricedb: { ...p, ageMs: Math.max(0, now - p.time * 1000) } };
}
