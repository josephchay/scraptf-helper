// 0.9 (#17): the robust statistics behind Holdings' trend size and key move band (src/shared/robustStats.ts): median,
// the interpolated quantile (R type 7), the Theil-Sen line and the MAD, on the plan's computed vectors. Pure.

import { describe, expect, it } from 'vitest';
import { median, medianAbsDeviation, quantile, theilSen } from '../../src/shared/robustStats';

describe('median', () => {
  it('takes the middle value, or averages the middle two (unrounded)', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([5])).toBe(5);
  });

  it('is null with no finite value, and ignores non-finite ones', () => {
    expect(median([])).toBeNull();
    expect(median([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
    expect(median([1, Number.NaN, 3, Number.NEGATIVE_INFINITY, 2])).toBe(2);
    expect(median(null as unknown as number[])).toBeNull();
  });

  it('leaves its input as it was', () => {
    const v = [3, 1, 2];
    median(v);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe('quantile (R type 7)', () => {
  it('interpolates between order statistics', () => {
    expect(quantile([-10, -5, 0, 5, 10], 0.1)).toBeCloseTo(-8, 12);
    expect(quantile([-10, -5, 0, 5, 10], 0.9)).toBeCloseTo(8, 12);
    expect(quantile([10, -10, 5, 0, -5], 0.5)).toBe(0);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it('gives the one value of a single-value sample at any q', () => {
    expect(quantile([3], 0.1)).toBe(3);
    expect(quantile([3], 0.9)).toBe(3);
  });

  it('clamps q to [0, 1]', () => {
    expect(quantile([1, 2, 3], -1)).toBe(1);
    expect(quantile([1, 2, 3], 2)).toBe(3);
    expect(quantile([1, 2, 3], 0)).toBe(1);
    expect(quantile([1, 2, 3], 1)).toBe(3);
  });

  it('is null with no finite value or no q, and ignores non-finite values', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2], Number.NaN)).toBeNull();
    expect(quantile([Number.NaN, 1, Number.POSITIVE_INFINITY, 3], 0.5)).toBe(2);
  });
});

describe('theilSen', () => {
  it('fits the median pairwise slope, so one outlier does not move it', () => {
    expect(theilSen([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }, { x: 4, y: 100 }])).toEqual({ slope: 2, intercept: 1, pairs: 10 });
  });

  it('skips pairs at the same x and ignores non-finite points', () => {
    const fit = theilSen([{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 1, y: 1 }, { x: Number.NaN, y: 9 }, { x: 2, y: Number.POSITIVE_INFINITY }]);
    // Pairs at distinct x: (0,0)-(1,1) slope 1 and (0,4)-(1,1) slope -3; the median is -1.
    expect(fit).toMatchObject({ slope: -1, pairs: 2 });
  });

  it('is null when every x is the same, or with fewer than two points', () => {
    expect(theilSen([{ x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }])).toBeNull();
    expect(theilSen([{ x: 1, y: 1 }])).toBeNull();
    expect(theilSen([])).toBeNull();
  });
});

describe('medianAbsDeviation', () => {
  it('is the median distance from the median by default', () => {
    expect(medianAbsDeviation([1, 2, 3, 4, 100])).toBe(1);
  });

  it('measures from a given centre', () => {
    expect(medianAbsDeviation([1, 2, 3], 0)).toBe(2);
  });

  it('is null with no finite value', () => {
    expect(medianAbsDeviation([])).toBeNull();
    expect(medianAbsDeviation([Number.NaN])).toBeNull();
  });
});
