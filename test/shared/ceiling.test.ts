// "Pay up to" ceiling (F1): the largest cost that is still 'profitable', with
// exactly the engine's and the dashboard's profit-status rules. 0.8 (PC-1): profit
// is flipProfit (friction and the price-move reserve) everywhere.

import { describe, expect, it } from 'vitest';
import { statusFor, minProfitFor as rendererMinProfitFor } from '../../src/renderer/oppModel';
import { maxCostFor as serviceMaxCostFor, profitStatus as serviceProfitStatus } from '../../src/service/domain/tiers';
import {
  exitCostsOf,
  flipProfit,
  flipProfitBound,
  frictionOf,
  maxCostFor,
  minProfitFor,
  profitBreakdown,
  profitStatus,
  reserveOf,
  reservePctOf,
  type CeilingSettings,
} from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { pctTextToRatio } from '../../src/renderer/settingsFields';

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
    exitReservePct: r.next() < 0.5 ? 0 : Math.round(r.next() * 300) / 1000,
  };
}

const profitAt = (rev: number, c: number, p: CeilingSettings) => flipProfit(rev, c, p)!;

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

  it('0.8 (PC-1): includes the price-move reserve, so Pay up to agrees with flipProfit', () => {
    // Revenue 100 at 5%: a 5 scrap reserve, so 100 - 86 - 5 = 9 (the minimum) and 87 gives 8.
    expect(maxCostFor(100, { ...P, exitReservePct: 0.05 })).toBe(86);
    // 600 at 5%: a 30 scrap reserve; the 8% margin binds at 570 / 1.08 = 527.7.
    expect(maxCostFor(600, { ...P, exitReservePct: 0.05 })).toBe(527);
    // No reserve (absent or 0) is exactly 0.7.4's ceiling.
    expect(maxCostFor(100, { ...P, exitReservePct: 0 })).toBe(maxCostFor(100, P));
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

describe('0.8 (PC-1): the price-move reserve and flipProfit', () => {
  it('reserveOf is ceil(revenue x pct) inside (0, 0.5], else 0', () => {
    expect(reserveOf(101, { exitReservePct: 0.05 })).toBe(6);
    expect(reserveOf(100, { exitReservePct: 0.05 })).toBe(5);
    expect(reserveOf(100, { exitReservePct: 0.5 })).toBe(50);
    for (const bad of [0.6, -0.1, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(reserveOf(101, { exitReservePct: bad }), String(bad)).toBe(0);
      expect(reservePctOf({ exitReservePct: bad }), String(bad)).toBe(0);
    }
    expect(reserveOf(101, {})).toBe(0);
    expect(reservePctOf({})).toBe(0);
    // No revenue, or none above 0, takes no reserve.
    expect(reserveOf(null, { exitReservePct: 0.05 })).toBe(0);
    expect(reserveOf(0, { exitReservePct: 0.05 })).toBe(0);
    expect(reserveOf(-40, { exitReservePct: 0.05 })).toBe(0);
    expect(reserveOf(Number.NaN, { exitReservePct: 0.05 })).toBe(0);
  });

  it('reserveOf ignores float noise: a whole-percent reserve takes exactly ceil(revenue x n / 100)', () => {
    // Settings stores a typed 7 as 7 / 100; 100 x 0.07 is 7.000000000000001.
    const seven = { exitReservePct: pctTextToRatio('7') };
    expect(reserveOf(100, seven)).toBe(7);
    expect(reserveOf(200, seven)).toBe(14);
    expect(flipProfit(100, 50, { frictionScrap: 0, ...seven })).toBe(43);
    expect(exitCostsOf(100, { frictionScrap: 0, ...seven }).reserveScrap).toBe(7);
    expect(maxCostFor(100, { ...P, minProfitScrap: 1, minProfitPctOfCost: 0, minMargin: 0, frictionScrap: 0, ...seven })).toBe(92);
    // Integer arithmetic: n x revenue is exact, and a quotient that is not whole is at least 0.01 from one.
    for (let n = 1; n <= 50; n++) {
      const p = { exitReservePct: pctTextToRatio(String(n)) };
      for (let r = 1; r <= 2000; r++) expect(reserveOf(r, p), `${n}% of ${r}`).toBe(Math.ceil((r * n) / 100));
    }
    // A share just over a whole number still rounds up.
    expect(reserveOf(101, { exitReservePct: 0.07 })).toBe(8);
    expect(reserveOf(1, { exitReservePct: 0.01 })).toBe(1);
  });

  it('flipProfitBound stays an upper bound on flipProfit at whole-percent reserves', () => {
    for (let n = 1; n <= 50; n++) {
      const p = { frictionScrap: n % 3, exitReservePct: pctTextToRatio(String(n)) };
      for (let r = 1; r <= 2000; r++) {
        const c = Math.ceil(r * (1 - n / 100)) - (r % 3);
        expect(flipProfit(r, c, p)!, `${n}% of ${r} at cost ${c}`).toBeLessThanOrEqual(flipProfitBound(r, c, p));
      }
    }
  });

  it('flipProfit takes friction and the reserve off, and is null without both values', () => {
    expect(flipProfit(100, 80, { frictionScrap: 2, exitReservePct: 0.05 })).toBe(13);
    expect(flipProfit(null, 1, P)).toBeNull();
    expect(flipProfit(1, null, P)).toBeNull();
    expect(flipProfit(undefined, 1, P)).toBeNull();
    expect(flipProfit(Number.NaN, 1, P)).toBeNull();
    expect(flipProfit(1, Number.POSITIVE_INFINITY, P)).toBeNull();
  });

  it('flipProfit at pct 0 is 0.7.4 revenue - cost - friction', () => {
    const r = rng(808);
    for (let i = 0; i < 1000; i++) {
      const p = { ...randomSettings(r), exitReservePct: r.next() < 0.5 ? 0 : undefined };
      const R = r.int(-50, 200_000);
      const c = r.int(0, 200_000);
      expect(flipProfit(R, c, p)).toBe(R - c - frictionOf(p));
    }
  });

  it('revenue - reserveOf(revenue) never decreases as the revenue grows', () => {
    for (const pct of [0.05, 0.123, 0.3, 0.5]) {
      let prev = Number.NEGATIVE_INFINITY;
      for (let r = 0; r <= 5000; r++) {
        const net = r - reserveOf(r, { exitReservePct: pct });
        expect(net, `pct ${pct} r ${r}`).toBeGreaterThanOrEqual(prev);
        prev = net;
      }
    }
  });

  it('exitCostsOf and profitBreakdown carry what flipProfit took off', () => {
    expect(exitCostsOf(300, { frictionScrap: 1, exitReservePct: 0.05 })).toEqual({ frictionScrap: 1, reserveScrap: 15, reservePct: 0.05, totalScrap: 16 });
    expect(exitCostsOf(null, { frictionScrap: -3, exitReservePct: 0.05 })).toEqual({ frictionScrap: 0, reserveScrap: 0, reservePct: 0.05, totalScrap: 0 });
    expect(profitBreakdown(300, 200, { frictionScrap: 1, exitReservePct: 0.05 })).toEqual({
      revenueScrap: 300,
      costScrap: 200,
      frictionScrap: 1,
      reserveScrap: 15,
      reservePct: 0.05,
      totalScrap: 16,
      profitScrap: 84,
    });
    expect(profitBreakdown(null, 200, P)).toBeNull();
  });
});
