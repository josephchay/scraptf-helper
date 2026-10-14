// "Pay up to" ceiling (F1): the largest cost that is still 'profitable', with
// exactly the engine's and the dashboard's profit-status rules.

import { describe, expect, it } from 'vitest';
import { statusFor, minProfitFor as rendererMinProfitFor } from '../../src/renderer/oppModel';
import { maxCostFor as serviceMaxCostFor, profitStatus as serviceProfitStatus } from '../../src/service/domain/tiers';
import { frictionOf, maxCostFor, minProfitFor, profitStatus, type CeilingSettings } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

/** mulberry32: deterministic, so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}

const P: CeilingSettings = {
  minProfitScrap: DEFAULT_SETTINGS.profit.minProfitScrap,
  minProfitPctOfCost: DEFAULT_SETTINGS.profit.minProfitPctOfCost,
  minMargin: DEFAULT_SETTINGS.profit.minMargin,
  frictionScrap: DEFAULT_SETTINGS.profit.frictionScrap,
};

function randomSettings(r: ReturnType<typeof rng>): CeilingSettings {
  return {
    minProfitScrap: r.int(0, 200),
    minProfitPctOfCost: r.next() < 0.2 ? 0 : Math.round(r.next() * 300) / 1000,
    minMargin: r.next() < 0.2 ? 0 : Math.round(r.next() * 1000) / 1000,
    frictionScrap: r.next() < 0.5 ? 0 : r.int(0, 60),
  };
}

const profitAt = (rev: number, c: number, p: CeilingSettings) => rev - c - frictionOf(p);

describe('maxCostFor', () => {
  it('returns null without a usable revenue', () => {
    expect(maxCostFor(null, P)).toBeNull();
    expect(maxCostFor(Number.NaN, P)).toBeNull();
    expect(maxCostFor(Number.POSITIVE_INFINITY, P)).toBeNull();
    expect(maxCostFor(-50, P)).toBeNull();
  });

  it('returns null when even a free item misses the thresholds', () => {
    // 9 scrap minimum profit: 8 scrap of revenue can never qualify.
    expect(maxCostFor(8, P)).toBeNull();
    expect(maxCostFor(0, P)).toBeNull();
    expect(maxCostFor(20, { ...P, frictionScrap: 12 })).toBeNull();
  });

  it('works out the ceiling with the default thresholds', () => {
    // Revenue 100: profit >= 9, >= 5% of cost and margin >= 8% -> cost 92 gives 8 profit (no), 91 gives 9 (9/91 = 9.9%).
    expect(maxCostFor(100, P)).toBe(91);
    expect(profitStatus(100 - 91, 91, P)).toBe('profitable');
    expect(profitStatus(100 - 92, 92, P)).not.toBe('profitable');
    // At 1 key-ish revenue the 8% margin binds: 600 / 1.08 = 555.5 -> 555.
    expect(maxCostFor(600, P)).toBe(555);
    // A free item qualifies on profit alone.
    expect(maxCostFor(9, P)).toBe(0);
  });

  it('applies friction like the engine (negative counts as none)', () => {
    // 100 - 82 - 9 = 9 scrap profit; one scrap more drops under the 9 scrap minimum.
    expect(maxCostFor(100, { ...P, frictionScrap: 9 })).toBe(82);
    expect(maxCostFor(100, { ...P, frictionScrap: -20 })).toBe(maxCostFor(100, P));
  });

  it('is the largest profitable cost, over randomised settings and revenues', () => {
    const r = rng(20261015);
    let ceilings = 0;
    for (let i = 0; i < 4000; i++) {
      const p = randomSettings(r);
      const rev = r.next() < 0.1 ? r.int(-20, 30) : r.int(0, r.next() < 0.5 ? 2_000 : 200_000);
      const c = maxCostFor(rev, p);
      if (c === null) {
        expect(profitStatus(profitAt(rev, 0, p), 0, p), `rev ${rev} ${JSON.stringify(p)}`).not.toBe('profitable');
        continue;
      }
      ceilings++;
      expect(Number.isInteger(c) && c >= 0).toBe(true);
      expect(profitStatus(profitAt(rev, c, p), c, p), `rev ${rev} c ${c} ${JSON.stringify(p)}`).toBe('profitable');
      expect(profitStatus(profitAt(rev, c + 1, p), c + 1, p), `rev ${rev} c+1 ${c + 1} ${JSON.stringify(p)}`).not.toBe('profitable');
    }
    // The generator must exercise both outcomes.
    expect(ceilings).toBeGreaterThan(1000);
  });

  it('matches a brute-force scan for small revenues (every cheaper cost qualifies too)', () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const p = randomSettings(r);
      const rev = r.int(0, 400);
      let brute: number | null = null;
      for (let c = 0; c <= rev; c++) if (profitStatus(profitAt(rev, c, p), c, p) === 'profitable') brute = c;
      expect(maxCostFor(rev, p)).toBe(brute);
      const c = maxCostFor(rev, p);
      if (c !== null) for (let x = 0; x <= c; x++) expect(profitStatus(profitAt(rev, x, p), x, p)).toBe('profitable');
    }
  });
});

describe('one profit-status rule everywhere', () => {
  it('the service tiers and the dashboard use the shared functions', () => {
    expect(serviceProfitStatus).toBe(profitStatus);
    expect(serviceMaxCostFor).toBe(maxCostFor);
    expect(rendererMinProfitFor).toBe(minProfitFor);
  });

  it("the dashboard's statusFor agrees with the engine on randomised inputs", () => {
    const r = rng(99);
    for (let i = 0; i < 2000; i++) {
      const p = randomSettings(r);
      const cost = r.int(0, 5000);
      const profit = r.next() < 0.05 ? null : r.int(-500, 1500);
      expect(statusFor(profit, cost, p)).toBe(profitStatus(profit, cost, p));
    }
  });
});
