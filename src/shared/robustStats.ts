// Robust statistics for small samples (0.9): median, interpolated quantile, Theil-Sen line and MAD. Pure; no I/O.
// Owned by holdings-ledger (Holdings' trend size and key move band); any later rule may import it, never edit it.

/** The finite values, sorted ascending (a fresh array). */
function sortedFinite(values: readonly number[]): number[] {
  return (Array.isArray(values) ? values : []).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
}

/** Median of the finite values; an even count averages the middle two (unrounded, unlike journal.medianOf). null when none. */
export function median(values: readonly number[]): number | null {
  const v = sortedFinite(values);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * The q-quantile (0 ≤ q ≤ 1, clamped) of the finite values by linear interpolation between order statistics (R type 7,
 * numpy's default): h = (n-1)q, v[floor h] + (h - floor h)(v[ceil h] - v[floor h]). null when none (or q not a number).
 */
export function quantile(values: readonly number[], q: number): number | null {
  const v = sortedFinite(values);
  if (v.length === 0 || typeof q !== 'number' || Number.isNaN(q)) return null;
  const h = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return v[lo]! + (h - lo) * (v[hi]! - v[lo]!);
}

/**
 * Theil-Sen: slope = median of (yj-yi)/(xj-xi) over i<j with xj !== xi (non-finite points ignored); intercept =
 * median(y - slope·x). null when no such pair. O(n²) pairs: callers cap n (holdingAdvice uses at most 60 points).
 */
export function theilSen(points: readonly { x: number; y: number }[]): { slope: number; intercept: number; pairs: number } | null {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j]!.x - pts[i]!.x;
      if (dx !== 0) slopes.push((pts[j]!.y - pts[i]!.y) / dx);
    }
  }
  const slope = median(slopes);
  if (slope === null) return null;
  const intercept = median(pts.map((p) => p.y - slope * p.x));
  return intercept === null ? null : { slope, intercept, pairs: slopes.length };
}

/** Median absolute deviation from `center` (default: the median): median(|v - center|). null when none. */
export function medianAbsDeviation(values: readonly number[], center?: number): number | null {
  const v = sortedFinite(values);
  const c = typeof center === 'number' && Number.isFinite(center) ? center : median(v);
  if (c === null || v.length === 0) return null;
  return median(v.map((x) => Math.abs(x - c)));
}
