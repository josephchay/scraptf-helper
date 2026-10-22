// 0.9 (#3, RESEARCH section 8): risk-aware ranking keys over a book already read. "If this buyer leaves" is the profit
// at the best other buyer seen in the last 24 h (buyerDepthOf's verified pick). "Buyers at break-even" counts the
// distinct buyers seen in the last 24 h whose best usable order clears break-even at a cost. The book-depth tag bands
// the distinct buyers seen in the last 24 h at any price. Counts of buyers show demand, never a chance of a sale, and
// nothing here scales profit by the confidence score. Pure; shared by the engine, the Live market, the bank stock
// notifier, the dashboard and the mock.
//
// Imports only ./ceiling and ./types (settingsSchema reads MIN_PROFITABLE_DEPTH_MAX from here; neither ceiling nor
// venues imports settingsSchema, so there is no cycle).

import { flipProfit, type ExitCostSettings, type ExitOrder } from './ceiling';
import type { LiquidityTag, MarketRow, NextBuyer, Opportunity, ProfitSettings, Scrap } from './types';

/** profitableDepth's cap ("20+"); ExitDepth keeps this many values. */
export const EXIT_DEPTH_CAP = 20;
/** The book-depth tag's 'many' from this many buyers (2 up to it: 'few'). */
export const BOOK_DEPTH_MANY_MIN = 5;
/** notifications.minProfitableDepth's maximum (settingsSchema reads it). */
export const MIN_PROFITABLE_DEPTH_MAX = 10;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 0.9 (#3): a book's usable buyers seen in the last 24 h. */
export interface ExitDepth {
  /** Each distinct usable buyer's best order value, highest first, at most EXIT_DEPTH_CAP. */
  values: Scrap[];
  /** Distinct usable buyers seen in the last 24 h (uncapped): the book-depth count. */
  buyers: number;
}

/**
 * Usable: not unverified, not an outlier, a finite value above 0, and a bot under Instant (buyerDepthOf's candidate
 * rule, the revenue order's buyer included). One value per buyer (their best).
 */
export function exitDepthOf(orders: readonly ExitOrder[], useOrder: ProfitSettings['useOrder'] = 'conservative'): ExitDepth {
  const best = new Map<string, Scrap>();
  for (const o of orders) {
    if (o.unverified || o.outlier || !(finite(o.valueScrap) && o.valueScrap > 0)) continue;
    if (useOrder === 'instant' && !o.isBot) continue;
    const cur = best.get(o.buyer);
    if (cur === undefined || o.valueScrap > cur) best.set(o.buyer, o.valueScrap);
  }
  const values = [...best.values()].sort((a, b) => b - a);
  return { values: values.slice(0, EXIT_DEPTH_CAP), buyers: values.length };
}

/**
 * Values in `d` with flipProfit(v, cost, p) >= 0 (at most EXIT_DEPTH_CAP); null without `d` or a finite cost. The
 * same count as the values at or above breakEvenFor(cost, p, 'buy'), by construction.
 */
export function profitableDepthAt(d: ExitDepth | null | undefined, costScrap: Scrap | null | undefined, p: ExitCostSettings): number | null {
  if (!d || !finite(costScrap)) return null;
  let n = 0;
  for (const v of d.values) {
    const profit = flipProfit(v, costScrap, p);
    if (profit !== null && profit >= 0) n++;
  }
  return n;
}

/** flipProfit at a verified next buyer; null without one (an unverified backup is none, as singleExitOf) or a cost. */
export function backupProfitOf(next: NextBuyer | null | undefined, costScrap: Scrap | null | undefined, p: ExitCostSettings): Scrap | null {
  if (!next || next.unverified) return null;
  return flipProfit(next.valueScrap, costScrap, p);
}

/** 0.9 (#3): the three figures at one cost. */
export interface ExitRisk {
  /** backupProfitOf; null: no other buyer seen in the last 24 h, or no cost. */
  backupProfitScrap: Scrap | null;
  /** profitableDepthAt; null without a cost. */
  profitableDepth: number | null;
  /** ExitDepth.buyers. */
  bookDepth: number;
}

/** The three figures at `costScrap` from an entry's ExitDepth and next buyer; null without an ExitDepth (a hand-built entry, no book). */
export function exitRiskAt(
  e: { exitDepth?: ExitDepth | null; nextBuyer?: NextBuyer | null } | null | undefined,
  costScrap: Scrap | null | undefined,
  p: ExitCostSettings,
): ExitRisk | null {
  const d = e?.exitDepth;
  if (!d) return null;
  const depth = profitableDepthAt(d, costScrap, p);
  return { bookDepth: d.buyers, profitableDepth: depth, backupProfitScrap: depth === null ? null : backupProfitOf(e?.nextBuyer ?? null, costScrap, p) };
}

/** The Opportunity fields (engine and mock alike, and as the repo reads them back): nulls are absent. */
export function opportunityRiskFields(r: ExitRisk | null): Pick<Opportunity, 'backupProfitScrap' | 'profitableDepth' | 'bookDepth'> {
  if (!r) return {};
  return {
    bookDepth: r.bookDepth,
    ...(r.profitableDepth !== null ? { profitableDepth: r.profitableDepth } : {}),
    ...(r.backupProfitScrap !== null ? { backupProfitScrap: r.backupProfitScrap } : {}),
  };
}

/** The MarketRow fields: profitableDepth null without a price to judge; backupProfitScrap only when there is one. */
export function marketRiskFields(r: ExitRisk | null): Pick<MarketRow, 'backupProfitScrap' | 'profitableDepth' | 'bookDepth'> {
  if (!r) return {};
  return { bookDepth: r.bookDepth, profitableDepth: r.profitableDepth, ...(r.backupProfitScrap !== null ? { backupProfitScrap: r.backupProfitScrap } : {}) };
}

/** 0 'none', 1 'one', 2..BOOK_DEPTH_MANY_MIN-1 'few', more 'many'; null for a missing or negative count. */
export function liquidityTagOf(bookDepth: number | null | undefined): LiquidityTag | null {
  if (!finite(bookDepth) || bookDepth < 0) return null;
  if (bookDepth === 0) return 'none';
  if (bookDepth === 1) return 'one';
  return bookDepth < BOOK_DEPTH_MANY_MIN ? 'few' : 'many';
}

/** notifications.minProfitableDepth as applied: a finite number floored into [0, MIN_PROFITABLE_DEPTH_MAX], else 0 (off). */
export function minProfitableDepthOf(v: unknown): number {
  return finite(v) && v > 0 ? Math.min(MIN_PROFITABLE_DEPTH_MAX, Math.floor(v)) : 0;
}

/** The notification gate: off (0) passes; otherwise the depth must be known and at least the minimum. */
export function depthGateOk(depth: number | null | undefined, minDepth: unknown): boolean {
  const need = minProfitableDepthOf(minDepth);
  return need === 0 || (finite(depth) && depth >= need);
}
