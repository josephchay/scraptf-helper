// The F4 reference age gate's limits, shared by the engine (usableReferences in
// src/service/domain/pricing.ts), the item drawer and the mock, so all three
// call the same reference prices stale.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Community prices are set by hand and often stay right for months, so they get at
 * least a year; a 30-day gate would drop most of them and lower confidence across the board.
 */
export const COMMUNITY_MIN_MAX_AGE_MS = 365 * DAY_MS;

/** Age past which a community price counts as absent, for profit.referenceMaxAgeMs = `limitMs`. */
export function communityMaxAgeMs(limitMs: number): number {
  return Math.max(limitMs, COMMUNITY_MIN_MAX_AGE_MS);
}
