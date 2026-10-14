// Profit tiers, thresholds and confidence levels (design brief §5.6, §5.7).

import type {
  ConfidenceLevel,
  InputKind,
  OpportunityStatus,
  ProfitSettings,
  ProfitTier,
  Scrap,
} from '../../shared/types';

/** 10 refined. */
export const REF10_SCRAP: Scrap = 90;
/** 2 refined. */
export const REF2_SCRAP: Scrap = 18;

export const HIGH_CONFIDENCE = 70;
export const MEDIUM_CONFIDENCE = 45;
/** Highest score that is still Medium; used to cap rule estimates and unverified orders. */
export const MEDIUM_CAP = HIGH_CONFIDENCE - 1;

export const TIER_ORDER: readonly ProfitTier[] = ['key', 'ref10', 'ref2', 'small', 'loss', 'none'];
export const CONFIDENCE_ORDER: readonly ConfidenceLevel[] = ['high', 'medium', 'low'];
export const INPUT_KIND_ORDER: readonly InputKind[] = ['user', 'import', 'rule'];
export const STATUS_ORDER: readonly OpportunityStatus[] = ['profitable', 'below-threshold', 'unprofitable', 'no-buyers'];

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = { high: 'High', medium: 'Medium', low: 'Low' };
export const INPUT_KIND_LABELS: Record<InputKind, string> = {
  user: 'Typed price',
  import: 'Imported page',
  // Brief §5.6: rule matches are candidates the user still has to check on scrap.tf.
  rule: 'Candidates to check on scrap.tf (rule estimates)',
};

/** ≥ 1 key, 10 ref – 1 key, 2 – 10 ref, < 2 ref, loss, or no buyers (null profit). */
export function profitTier(profitScrap: Scrap | null, keyScrap: Scrap): ProfitTier {
  if (profitScrap === null || !Number.isFinite(profitScrap)) return 'none';
  if (profitScrap <= 0) return 'loss';
  if (Number.isFinite(keyScrap) && keyScrap > 0 && profitScrap >= keyScrap) return 'key';
  if (profitScrap >= REF10_SCRAP) return 'ref10';
  if (profitScrap >= REF2_SCRAP) return 'ref2';
  return 'small';
}

/** Minimum profit for an opportunity: max(minProfitScrap, ceil(pct × cost)). */
export function minProfitFor(costScrap: Scrap, p: Pick<ProfitSettings, 'minProfitScrap' | 'minProfitPctOfCost'>): Scrap {
  const pct = Number.isFinite(p.minProfitPctOfCost) && p.minProfitPctOfCost > 0 ? p.minProfitPctOfCost : 0;
  const floor = Number.isFinite(p.minProfitScrap) ? p.minProfitScrap : 0;
  const cost = Number.isFinite(costScrap) ? Math.max(0, costScrap) : 0;
  return Math.max(floor, Math.ceil(cost * pct));
}

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

/** High ≥ 70, Medium 45–69, Low < 45. */
export function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= HIGH_CONFIDENCE) return 'high';
  if (score >= MEDIUM_CONFIDENCE) return 'medium';
  return 'low';
}
