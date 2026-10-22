// 0.9 (#2): break-even prices (src/shared/ceiling.ts). 'buy' is the smallest whole-scrap backpack.tf sale price whose
// flipProfit is not negative (friction and the price-move reserve); 'sell' is cost plus friction, never the reserve.
// The other exits are the value a sale must bring in before the venue's fee. A price to clear, never a forecast.

import { describe, expect, it } from 'vitest';
import {
  breakEvenFor,
  breakEvensOf,
  flipProfit,
  frictionOf,
  grossBeforeFee,
  marketplaceFeePctOf,
  reserveOf,
  reservePctOf,
  scmGrossValue,
  type CeilingSettings,
  type ExitCostSettings,
} from '../../src/shared/ceiling';

const PCTS = [0, 0.01, 0.05, 0.07, 0.1, 0.25, 0.5];
const FRICTIONS = [0, 1, 5];

/** A small seeded generator (mulberry32), so the random cases are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("breakEvenFor ('buy'): the smallest whole R with flipProfit(R) >= 0", () => {
  it('holds for every reserve, cost 0..3000 and friction in {0, 1, 5}', () => {
    for (const pct of PCTS) {
      for (const friction of FRICTIONS) {
        const p: ExitCostSettings = { frictionScrap: friction, exitReservePct: pct };
        for (let cost = 0; cost <= 3000; cost++) {
          const be = breakEvenFor(cost, p)!;
          const atBe = flipProfit(be, cost, p)!;
          const below = be === 0 ? null : flipProfit(be - 1, cost, p)!;
          if (!Number.isInteger(be) || atBe < 0 || (below !== null && below >= 0)) {
            expect({ pct, friction, cost, be, atBe, below }).toBe('the smallest whole R with flipProfit >= 0');
          }
        }
      }
    }
  });

  it('gives the worked examples', () => {
    expect(breakEvenFor(100, { frictionScrap: 0, exitReservePct: 0.07 })).toBe(108);
    expect(flipProfit(108, 100, { frictionScrap: 0, exitReservePct: 0.07 })).toBe(0);
    expect(flipProfit(107, 100, { frictionScrap: 0, exitReservePct: 0.07 })).toBe(-1);
    expect(breakEvenFor(100, { frictionScrap: 0, exitReservePct: 0 })).toBe(100);
    expect(breakEvenFor(100, { frictionScrap: 1, exitReservePct: 0.05 })).toBe(107);
    expect(breakEvenFor(100, { frictionScrap: 1, exitReservePct: 0.05 }, 'buy')).toBe(107);
    // A free item loses nothing at any price.
    expect(breakEvenFor(0, { frictionScrap: 0, exitReservePct: 0.5 })).toBe(0);
    // 'sell' (a held lot into a live order): cost plus friction, never the reserve.
    expect(breakEvenFor(100, { frictionScrap: 1, exitReservePct: 0.05 }, 'sell')).toBe(101);
    expect(breakEvenFor(100, { frictionScrap: 0, exitReservePct: 0.5 }, 'sell')).toBe(100);
  });

  it('is null for a missing or non-finite cost, and reads broken settings as the engine does', () => {
    const p = { frictionScrap: 1, exitReservePct: 0.05 };
    for (const cost of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(breakEvenFor(cost, p)).toBeNull();
    // Negative friction counts as none; a reserve over 50% counts as none (reservePctOf).
    expect(breakEvenFor(100, { frictionScrap: -3 })).toBe(100);
    expect(breakEvenFor(100, { frictionScrap: 0, exitReservePct: 0.6 })).toBe(100);
    expect(breakEvenFor(-5, { frictionScrap: 1 })).toBe(0);
  });

  it("is ranking's rule: for random whole R, R >= breakEvenFor exactly when flipProfit(R) >= 0", () => {
    const next = rng(902);
    for (let i = 0; i < 20_000; i++) {
      const pct = PCTS[Math.floor(next() * PCTS.length)]!;
      const friction = FRICTIONS[Math.floor(next() * FRICTIONS.length)]!;
      const cost = Math.floor(next() * 50_000);
      const R = Math.floor(next() * 120_000);
      const p = { frictionScrap: friction, exitReservePct: pct };
      const be = breakEvenFor(cost, p)!;
      if ((R >= be) !== (flipProfit(R, cost, p)! >= 0)) expect({ pct, friction, cost, R, be }).toBe('equivalent');
    }
  });
});

describe('grossBeforeFee and scmGrossValue (value before a venue fee)', () => {
  it('grosses up by the percent fees', () => {
    expect(grossBeforeFee(112, 0.1)).toBe(125);
    expect(grossBeforeFee(112, 0.05)).toBe(118);
    expect(grossBeforeFee(112, 0)).toBe(112);
    expect(grossBeforeFee(0, 0.1)).toBe(0);
    expect(grossBeforeFee(-4, 0.1)).toBe(0);
    // A broken fee is none; float noise never adds a scrap (90 / 0.9 = 100).
    expect(grossBeforeFee(112, Number.NaN)).toBe(112);
    expect(grossBeforeFee(112, 1)).toBe(112);
    expect(grossBeforeFee(90, 0.1)).toBe(100);
    for (let net = 1; net <= 2000; net++) {
      const g = grossBeforeFee(net, 0.1);
      if (g * 0.9 < net - 1e-9 || (g - 1) * 0.9 >= net - 1e-9) expect({ net, g }).toBe('the smallest gross that nets it');
    }
  });

  it('grosses up the Steam Market by 15%', () => {
    expect(scmGrossValue(112)).toBe(129);
    expect(scmGrossValue(100)).toBe(115);
    expect(scmGrossValue(0)).toBe(0);
    expect(scmGrossValue(Number.NaN)).toBe(0);
  });
});

describe('breakEvensOf (every exit)', () => {
  it("takes the reserve on the backpack.tf break-even in 'buy' and none in 'sell'", () => {
    const p = { frictionScrap: 1, exitReservePct: 0.05, marketplaceFeePct: 0.2 };
    const buy = breakEvensOf(100, p, 'buy')!;
    expect(buy).toEqual({
      mode: 'buy',
      costScrap: 100,
      frictionScrap: 1,
      reserveScrap: reserveOf(107, p),
      reservePct: 0.05,
      backpackScrap: 107,
      marketplaceFeePct: 0.2,
      marketplaceScrap: grossBeforeFee(107, 0.2),
      manncoScrap: grossBeforeFee(107, 0.05),
      scmScrap: scmGrossValue(107),
    });
    expect(buy.reserveScrap).toBe(6);
    expect(breakEvensOf(100, p)).toEqual(buy);
    const sell = breakEvensOf(100, p, 'sell')!;
    expect(sell).toMatchObject({ mode: 'sell', backpackScrap: 101, reserveScrap: 0, reservePct: 0, frictionScrap: frictionOf(p) });
    expect(sell.marketplaceScrap).toBe(grossBeforeFee(101, 0.2));
    for (let cost = 0; cost <= 500; cost += 7) {
      const b = breakEvensOf(cost, p, 'buy')!;
      expect(b.reserveScrap).toBe(reserveOf(b.backpackScrap, p));
      expect(b.reservePct).toBe(reservePctOf(p));
    }
  });

  it('is null without a cost, and applies the marketplace.tf fee setting', () => {
    expect(breakEvensOf(null, { frictionScrap: 0 })).toBeNull();
    expect(breakEvensOf(Number.NaN, { frictionScrap: 0 })).toBeNull();
    expect(marketplaceFeePctOf({})).toBe(0.1);
    expect(marketplaceFeePctOf({ marketplaceFeePct: 0.6 })).toBe(0.1);
    expect(marketplaceFeePctOf({ marketplaceFeePct: 0 })).toBe(0);
    expect(breakEvensOf(112, { frictionScrap: 0 })).toMatchObject({ backpackScrap: 112, marketplaceFeePct: 0.1, marketplaceScrap: 125, manncoScrap: 118, scmScrap: 129 });
  });

  it('takes a 4-key CeilingSettings literal (no reserve, no marketplace.tf fee)', () => {
    const c: CeilingSettings = { minProfitScrap: 9, minProfitPctOfCost: 0.1, minMargin: 0.5, frictionScrap: 1 };
    // Thresholds are Pay up to's job, never part of break-even.
    expect(breakEvenFor(100, c)).toBe(101);
    expect(breakEvensOf(100, c)).toMatchObject({ backpackScrap: 101, reserveScrap: 0, reservePct: 0, marketplaceFeePct: 0.1 });
  });
});
