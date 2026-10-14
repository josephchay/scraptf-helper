// Profit status and the "pay up to" ceiling (feature F1). Shared so the
// service engine (tiers.ts), the dashboard (oppModel.ts) and the browser mock
// classify an opportunity with exactly the same rules.

import type { OpportunityStatus, ProfitSettings, Scrap } from './types';

export type CeilingSettings = Pick<ProfitSettings, 'minProfitScrap' | 'minProfitPctOfCost' | 'minMargin' | 'frictionScrap'>;

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

/**
 * The largest integer cost c ≥ 0 that is still 'profitable' against `revenueScrap`
 * (profit = revenue − c − friction, judged by profitStatus), or null when the
 * revenue is missing or no cost qualifies. Profit falls and the profit floor
 * rises as c grows, and the margin (revenue − friction) / c − 1 falls, so the
 * qualifying costs are exactly [0, c*] and a binary search finds c*.
 */
export function maxCostFor(revenueScrap: Scrap | null, p: CeilingSettings): Scrap | null {
  if (revenueScrap === null || typeof revenueScrap !== 'number' || !Number.isFinite(revenueScrap)) return null;
  const friction = frictionOf(p);
  const ok = (c: number): boolean => profitStatus(revenueScrap - c - friction, c, p) === 'profitable';
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
