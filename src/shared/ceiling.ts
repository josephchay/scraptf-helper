// Profit status and the "pay up to" ceiling (feature F1), (0.7.4) the scrap.tf
// cost checks against PriceDB, and (0.8) the one buy-side profit path (flipProfit)
// and the backup-buyer check. Shared so the service engine (tiers.ts,
// confidence.ts), the Live market, bank stock, the Live check, the dashboard
// (oppModel.ts) and the browser mock classify an opportunity with exactly the
// same rules.

import { fromObject, fromString, isValidSku } from './sku';
import { CURRENCY_SKUS } from './types';
import type { ExitCosts, NextBuyer, OpportunityStatus, OrderSummary, ProfitSettings, Scrap, SingleExit, UnixMs } from './types';

/** The settings flipProfit and exitCostsOf read. exitReservePct is optional: absent counts as no reserve (0.8). */
export type ExitCostSettings = Pick<ProfitSettings, 'frictionScrap'> & Partial<Pick<ProfitSettings, 'exitReservePct'>>;

/** The settings a buy decision is judged with (0.8: plus the optional price-move reserve, absent = none). */
export type CeilingSettings = Pick<ProfitSettings, 'minProfitScrap' | 'minProfitPctOfCost' | 'minMargin' | 'frictionScrap'> &
  Partial<Pick<ProfitSettings, 'exitReservePct'>>;

/** 0.8 (PC-1): the most profit.exitReservePct may be (settingsSchema's bound). */
export const EXIT_RESERVE_MAX_PCT = 0.5;

/** Minimum profit for an opportunity: max(minProfitScrap, ceil(pct × cost)). */
export function minProfitFor(costScrap: Scrap, p: Pick<ProfitSettings, 'minProfitScrap' | 'minProfitPctOfCost'>): Scrap {
  const pct = Number.isFinite(p.minProfitPctOfCost) && p.minProfitPctOfCost > 0 ? p.minProfitPctOfCost : 0;
  const floor = Number.isFinite(p.minProfitScrap) ? p.minProfitScrap : 0;
  const cost = Number.isFinite(costScrap) ? Math.max(0, costScrap) : 0;
  return Math.max(floor, Math.ceil(cost * pct));
}

/** 'no-buyers' (no revenue), 'unprofitable' (profit ≤ 0), 'below-threshold' or 'profitable'. A free item has an unbounded margin. */
export function profitStatus(
  profitScrap: Scrap | null,
  costScrap: Scrap,
  p: Pick<ProfitSettings, 'minProfitScrap' | 'minProfitPctOfCost' | 'minMargin'>,
): OpportunityStatus {
  if (profitScrap === null || !Number.isFinite(profitScrap)) return 'no-buyers';
  if (profitScrap <= 0) return 'unprofitable';
  const margin = costScrap > 0 ? profitScrap / costScrap : Number.POSITIVE_INFINITY;
  const minMargin = Number.isFinite(p.minMargin) ? p.minMargin : 0;
  if (profitScrap < minProfitFor(costScrap, p) || margin < minMargin) return 'below-threshold';
  return 'profitable';
}

/** Friction as the engine applies it: negative or non-finite counts as none. */
export function frictionOf(p: Pick<ProfitSettings, 'frictionScrap'>): Scrap {
  return Number.isFinite(p.frictionScrap) && p.frictionScrap > 0 ? p.frictionScrap : 0;
}

function finiteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 0.8 (PC-1): the price-move reserve's share as applied: profit.exitReservePct when finite and in (0, 0.5], else 0. */
export function reservePctOf(p: Partial<Pick<ProfitSettings, 'exitReservePct'>>): number {
  const v = p.exitReservePct;
  return finiteNumber(v) && v > 0 && v <= EXIT_RESERVE_MAX_PCT ? v : 0;
}

/**
 * 0.8: float noise reserveOf ignores before rounding up. Settings stores a typed 7 as 7 / 100 = 0.07, and 100 x 0.07
 * is 7.000000000000001, whose ceiling would take 8 (as waitGainBar's 1e-9).
 */
export const RESERVE_FLOAT_TOLERANCE = 1e-9;

/**
 * 0.8 (PC-1): ceil(revenue x reservePctOf(p)) for a finite revenue above 0, else 0, the product's float noise ignored
 * (RESERVE_FLOAT_TOLERANCE: a 7% reserve on 100 scrap is 7). Never negative, never fractional.
 */
export function reserveOf(revenueScrap: Scrap | null | undefined, p: Partial<Pick<ProfitSettings, 'exitReservePct'>>): Scrap {
  const pct = reservePctOf(p);
  return pct > 0 && finiteNumber(revenueScrap) && revenueScrap > 0 ? Math.max(0, Math.ceil(revenueScrap * pct - RESERVE_FLOAT_TOLERANCE)) : 0;
}

/** 0.8 (PC-1): what a buy decision takes off `revenueScrap`: friction plus the price-move reserve. */
export function exitCostsOf(revenueScrap: Scrap | null | undefined, p: ExitCostSettings): ExitCosts {
  const frictionScrap = frictionOf(p);
  const reserveScrap = reserveOf(revenueScrap, p);
  return { frictionScrap, reserveScrap, reservePct: reservePctOf(p), totalScrap: frictionScrap + reserveScrap };
}

/**
 * 0.8 (PC-1): the one buy-side profit rule: revenue - cost - friction - the price-move reserve (exitCostsOf), or null
 * when either value is missing. Selling what you hold (holdingFigures, Record sale) takes friction only.
 */
export function flipProfit(revenueScrap: Scrap | null | undefined, costScrap: Scrap | null | undefined, p: ExitCostSettings): Scrap | null {
  if (!finiteNumber(revenueScrap) || !finiteNumber(costScrap)) return null;
  return revenueScrap - costScrap - frictionOf(p) - reserveOf(revenueScrap, p);
}

/**
 * 0.8 (PC-1): an upper bound on flipProfit for every revenue up to `maxRevenueScrap` at this cost:
 * maxRevenue x (1 - pct) - cost - friction, plus RESERVE_FLOAT_TOLERANCE when a reserve is set.
 * revenue - ceil(revenue x pct - tolerance) <= revenue x (1 - pct) + tolerance, which grows with the revenue
 * (pct <= 0.5), so a bound <= 0 means no such revenue profits, fractional revenues included. With no reserve it is
 * the engine's 0.7.4 test (maxRevenue - cost - friction).
 */
export function flipProfitBound(maxRevenueScrap: Scrap, costScrap: Scrap, p: ExitCostSettings): number {
  const pct = reservePctOf(p);
  return maxRevenueScrap * (1 - pct) - costScrap - frictionOf(p) + (pct > 0 ? RESERVE_FLOAT_TOLERANCE : 0);
}

/** 0.8 (PC-1): a flip's profit and what was taken off, for the dashboard's breakdowns. */
export interface ProfitBreakdown extends ExitCosts {
  revenueScrap: Scrap;
  costScrap: Scrap;
  profitScrap: Scrap;
}

/** 0.8 (PC-1): flipProfit with its parts; null when revenue or cost is missing. */
export function profitBreakdown(revenueScrap: Scrap | null | undefined, costScrap: Scrap | null | undefined, p: ExitCostSettings): ProfitBreakdown | null {
  const profitScrap = flipProfit(revenueScrap, costScrap, p);
  if (profitScrap === null) return null;
  return { revenueScrap: revenueScrap as Scrap, costScrap: costScrap as Scrap, ...exitCostsOf(revenueScrap, p), profitScrap };
}

/**
 * The largest integer cost c ≥ 0 that is still 'profitable' against `revenueScrap`
 * (profit = flipProfit: revenue − c − friction − the price-move reserve, judged by
 * profitStatus), or null when the revenue is missing or no cost qualifies. The
 * reserve depends on the revenue only, not on c, so profit still falls and the
 * profit floor still rises as c grows, and the margin falls; the qualifying costs
 * are exactly [0, c*] and a binary search finds c*.
 */
export function maxCostFor(revenueScrap: Scrap | null, p: CeilingSettings): Scrap | null {
  if (revenueScrap === null || typeof revenueScrap !== 'number' || !Number.isFinite(revenueScrap)) return null;
  const ok = (c: number): boolean => profitStatus(flipProfit(revenueScrap, c, p), c, p) === 'profitable';
  if (!ok(0)) return null;
  // Profit must stay positive, so no cost above the revenue can qualify.
  let lo = 0;
  let hi = Math.max(0, Math.floor(revenueScrap));
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// 0.8 (PC-2, H2): the next buyer. Who pays if the revenue order's buyer fills or withdraws while the user
// buys on scrap.tf, and whether the flip rests on that one buyer. A robustness check over the book already
// read, never a probability: it changes no score, status or notification.
// ---------------------------------------------------------------------------

/** 0.8 (PC-2, H2): one eligible buy order as buyerDepthOf reads it. */
export interface ExitOrder {
  /** Listing id. */
  id: string;
  /** Who pays: the SteamID, else the listing id (the engine's buyerCountOf rule), so one buyer's orders count once. */
  buyer: string;
  valueScrap: Scrap;
  keys: number;
  metalScrap: Scrap;
  isBot: boolean;
  online: boolean | null;
  lastEventAt: UnixMs;
  /** An outlier of the priced book (PriceResult.outlierIds, or the summary's 'outlier' flag): never a backup. */
  outlier: boolean;
  /** No feed event or snapshot for 24 h ('unverified'). */
  unverified: boolean;
}

/** 0.8 (PC-2, H2): buyerDepthOf's answer for one book and one revenue order. */
export interface BuyerDepth {
  /** The revenue order's buyer; null when no revenue order was given or it is not among the orders. */
  revenueBuyer: string | null;
  nextBuyer: NextBuyer | null;
  /** Distinct buyers with at least one order not flagged unverified. */
  verifiedBuyerCount: number;
}

/** compareValued's order (pricing.ts): higher value, then a bot, then the most recently seen, then the lower listing id. */
function ahead(a: ExitOrder, b: ExitOrder): boolean {
  if (a.valueScrap !== b.valueScrap) return a.valueScrap > b.valueScrap;
  if (a.isBot !== b.isBot) return a.isBot;
  if (a.lastEventAt !== b.lastEventAt) return a.lastEventAt > b.lastEventAt;
  return a.id < b.id;
}

/**
 * 0.8 (PC-2, H2): the best buyer after the revenue order's own (R-PC2/H2 in the spec): another buyer, not an outlier,
 * worth more than 0, a bot when useOrder is 'instant' (Instant counts bots only); a verified one when there is one,
 * else the best unverified one, flagged. Plus how many distinct buyers were seen in the last 24 h (over every order
 * given, outliers and zero-valued ones included: buyerCount's population). One pass each.
 */
export function buyerDepthOf(orders: readonly ExitOrder[], revenueOrderId: string | null | undefined, useOrder: ProfitSettings['useOrder'] = 'conservative'): BuyerDepth {
  const verified = new Set<string>();
  let revenueBuyer: string | null = null;
  for (const o of orders) {
    if (!o.unverified) verified.add(o.buyer);
    if (revenueOrderId != null && o.id === revenueOrderId) revenueBuyer = o.buyer;
  }
  if (revenueBuyer === null) return { revenueBuyer: null, nextBuyer: null, verifiedBuyerCount: verified.size };
  let bestVerified: ExitOrder | null = null;
  let bestUnverified: ExitOrder | null = null;
  for (const o of orders) {
    if (o.buyer === revenueBuyer || o.outlier || !(finiteNumber(o.valueScrap) && o.valueScrap > 0)) continue;
    if (useOrder === 'instant' && !o.isBot) continue;
    if (o.unverified) {
      if (bestUnverified === null || ahead(o, bestUnverified)) bestUnverified = o;
    } else if (bestVerified === null || ahead(o, bestVerified)) bestVerified = o;
  }
  const pick = bestVerified ?? bestUnverified;
  return {
    revenueBuyer,
    nextBuyer: pick
      ? { valueScrap: pick.valueScrap, keys: pick.keys, metalScrap: pick.metalScrap, isBot: pick.isBot, online: pick.online, lastEventAt: pick.lastEventAt, unverified: pick.unverified }
      : null,
    verifiedBuyerCount: verified.size,
  };
}

/**
 * 0.8 (PC-2, H2): order summaries as ExitOrders: eligible ones only, outlier from the summary's 'outlier' flag or
 * `outlierIds` (the mock's pricing, whose summaries do not carry its computed outliers), unverified from the
 * 'unverified' flag. The Live check, the drawer, Quick entry and the mock read a book this way.
 */
export function exitOrdersOfSummaries(orders: readonly OrderSummary[], outlierIds?: ReadonlySet<string> | null): ExitOrder[] {
  const out: ExitOrder[] = [];
  for (const o of orders) {
    if (o.eligible === false) continue;
    out.push({
      id: o.listingId,
      buyer: o.steamid || o.listingId,
      valueScrap: o.valueScrap,
      keys: finiteNumber(o.keys) ? o.keys : 0,
      metalScrap: finiteNumber(o.metalScrap) ? o.metalScrap : 0,
      isBot: o.isBot === true,
      online: o.online ?? null,
      lastEventAt: o.lastEventAt,
      outlier: o.flags.includes('outlier') || outlierIds?.has(o.listingId) === true,
      unverified: o.flags.includes('unverified'),
    });
  }
  return out;
}

/**
 * 0.8 (PC-2): R-PC2 in the spec. Null unless the flip is 'profitable' on its revenue and no verified other buyer would
 * be: thin with no next buyer, an unverified one (never proof the flip is not thin) or a verified one below the
 * thresholds at this cost.
 */
export function singleExitOf(revenueScrap: Scrap | null | undefined, costScrap: Scrap | null | undefined, next: NextBuyer | null, p: CeilingSettings): SingleExit | null {
  const profit = flipProfit(revenueScrap, costScrap, p);
  if (profit === null || profitStatus(profit, costScrap as Scrap, p) !== 'profitable') return null;
  const nextProfitScrap = next ? flipProfit(next.valueScrap, costScrap, p) : null;
  if (next && !next.unverified && profitStatus(nextProfitScrap, costScrap as Scrap, p) === 'profitable') return null;
  return { next, nextProfitScrap };
}

/** 0.8 (PC-2): the start of singleExitText, by which the dashboard finds the reason among a row's reasons. */
export const SINGLE_EXIT_TEXT = 'Only this buyer makes it a flip';

/** 0.8 (PC-2): "Only this buyer makes it a flip: the next buyer pays 20.00 ref (profit -5.00 ref)"; `money` is formatScrap at the key price. */
export function singleExitText(s: SingleExit, money: (v: Scrap) => string): string {
  if (s.next === null) return `${SINGLE_EXIT_TEXT}: no other usable buyer is in the book`;
  const profit = s.nextProfitScrap === null ? '' : ` (profit ${money(s.nextProfitScrap)})`;
  return `${SINGLE_EXIT_TEXT}: the next buyer pays ${money(s.next.valueScrap)}${profit}${s.next.unverified ? ' but was not seen in the last 24 h' : ''}`;
}

/** 0.8 (PC-2): as a confidence reason with a 0 delta (like '0 scrap.tf price is fresh'): shown with the reasons, the score unchanged. */
export function singleExitReason(s: SingleExit, money: (v: Scrap) => string): string {
  return `0 ${singleExitText(s, money)}`;
}

// ---------------------------------------------------------------------------
// 0.7.4 (F22, F70): the scrap.tf cost against PriceDB. scrap.tf charging well under what bots pay
// for this exact item is implausible; it is usually a price for another copy (Non-Craftable, another
// quality or kit tier) stored under this SKU. PriceDB only (age-gated by the caller): community prices
// are set by hand and often a year old. Shared with the browser mock.
// ---------------------------------------------------------------------------

/** 'cost-below-market' when the cost is under this share of the item's own PriceDB buy price... */
export const COST_BELOW_MARKET_RATIO = 0.95;
/** ...and at least this far under it (1 ref), so a few scrap of key-price drift never flags. */
export const COST_BELOW_MARKET_MIN_GAP: Scrap = 9;
/** 'variant-suspect' when the cost is under this share of the low end of the item's own PriceDB band... */
export const VARIANT_SUSPECT_OWN_RATIO = 0.9;
/** ...and within this share of its craftability twin's PriceDB band. */
export const VARIANT_SUSPECT_TWIN_BAND = 0.1;

export interface PriceBand {
  low: Scrap;
  high: Scrap;
}

/**
 * The same item with the other craftability (5040;6 <-> 5040;6;uncraftable), rebuilt from the SKU object
 * so the token order stays canonical; null for an unreadable or currency SKU.
 */
export function craftabilityTwin(sku: string): string | null {
  if (typeof sku !== 'string' || !isValidSku(sku)) return null;
  const obj = fromString(sku);
  const twin = fromObject({ ...obj, craftable: !obj.craftable });
  return twin === sku || CURRENCY_SKUS.includes(fromObject({ ...obj, paint: null })) ? null : twin;
}

export interface PricedbSides {
  buyScrap: Scrap | null;
  sellScrap: Scrap | null;
}

function positiveScrap(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** [min, max] of a PriceDB row's positive sides; null without either. */
export function pricedbBand(p: PricedbSides | null | undefined): PriceBand | null {
  const sides = [positiveScrap(p?.buyScrap), positiveScrap(p?.sellScrap)].filter((v): v is number => v !== null);
  return sides.length === 0 ? null : { low: Math.min(...sides), high: Math.max(...sides) };
}

export type CostSanity =
  | { flag: 'variant-suspect'; own: PriceBand; twin: PriceBand }
  | { flag: 'cost-below-market'; ownBuy: Scrap }
  | null;

/** 0.7.4: the opportunity flags costSanity sets. */
export const COST_SANITY_FLAGS: readonly string[] = Object.freeze(['variant-suspect', 'cost-below-market']);

/** 0.7.4 (F22, F70): a row's cost is probably another copy's price (one of COST_SANITY_FLAGS among its flags). */
export function costSuspectFlagged(flags: readonly string[] | null | undefined): boolean {
  return Array.isArray(flags) && flags.some((f) => COST_SANITY_FLAGS.includes(f));
}

/**
 * The cost check for one scrap.tf price, given the item's own usable PriceDB row and (read only when the
 * cost is under VARIANT_SUSPECT_OWN_RATIO of its own band) its craftability twin's. 'variant-suspect' when
 * the cost is under 0.9x the low end of the item's own band and within 10% of the twin's band (the more
 * specific finding, so it replaces the other); else 'cost-below-market' when it is under 0.95x the own
 * buy price by 1 ref or more. One-directional: a cost above the item's band is normal scrap.tf markup.
 * A free item (cost 0) is never checked.
 */
export function costSanity(costScrap: Scrap | null | undefined, own: PricedbSides | null | undefined, twin: () => PricedbSides | null | undefined): CostSanity {
  const cost = positiveScrap(costScrap);
  const ownBand = pricedbBand(own);
  if (cost === null || ownBand === null) return null;
  if (cost < VARIANT_SUSPECT_OWN_RATIO * ownBand.low) {
    const twinBand = pricedbBand(twin());
    if (twinBand !== null && cost >= (1 - VARIANT_SUSPECT_TWIN_BAND) * twinBand.low && cost <= (1 + VARIANT_SUSPECT_TWIN_BAND) * twinBand.high) {
      return { flag: 'variant-suspect', own: ownBand, twin: twinBand };
    }
  }
  const ownBuy = positiveScrap(own?.buyScrap);
  if (ownBuy !== null && cost < COST_BELOW_MARKET_RATIO * ownBuy && ownBuy - cost >= COST_BELOW_MARKET_MIN_GAP) return { flag: 'cost-below-market', ownBuy };
  return null;
}

/**
 * The confidence reason for a cost check. `twinCraftable` is the twin's craftability (true: the item is
 * Non-Craftable and its twin the craftable copy); `money` formats scrap (formatScrap at the key price).
 */
export function costSanityReason(s: NonNullable<CostSanity>, twinCraftable: boolean, money: (v: Scrap) => string): string {
  const band = (b: PriceBand): string => (b.low === b.high ? money(b.low) : `${money(b.low)} to ${money(b.high)}`);
  if (s.flag === 'variant-suspect') {
    return `scrap.tf price matches the ${twinCraftable ? 'Craftable' : 'Non-Craftable'} copy on PriceDB (${band(s.twin)}), not this item (${band(s.own)}). Check craftability before buying`;
  }
  return `scrap.tf price is under 95% of the PriceDB buy price (${money(s.ownBuy)}): bots pay more than scrap.tf charges. Check craftability, quality and kit tier`;
}
