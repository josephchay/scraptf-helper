// 0.9 (#3): the risk-aware ranking keys (src/shared/exitRisk.ts) over a book already read: the usable buyers seen in
// the last 24 h (exitDepthOf), buyers at break-even (profitableDepthAt, the same count as the orders at or above
// exits' breakEvenFor), the profit if this buyer leaves (backupProfitOf), the book-depth tag and the risk control's
// gate. Counts of buyers are demand, never a chance of a sale; nothing scales profit by the confidence score.

import { describe, expect, it } from 'vitest';
import { breakEvenFor, flipProfit, type ExitCostSettings, type ExitOrder } from '../../src/shared/ceiling';
import {
  BOOK_DEPTH_MANY_MIN,
  EXIT_DEPTH_CAP,
  MIN_PROFITABLE_DEPTH_MAX,
  backupProfitOf,
  depthGateOk,
  exitDepthOf,
  exitRiskAt,
  liquidityTagOf,
  marketRiskFields,
  minProfitableDepthOf,
  opportunityRiskFields,
  profitableDepthAt,
  type ExitDepth,
} from '../../src/shared/exitRisk';
import type { NextBuyer } from '../../src/shared/types';

const T = Date.UTC(2026, 9, 22, 12, 0, 0);
let seq = 0;

function order(valueScrap: number, over: Partial<ExitOrder> = {}): ExitOrder {
  seq++;
  return {
    id: `o${seq}`,
    buyer: `S${seq}`,
    valueScrap,
    keys: 0,
    metalScrap: valueScrap,
    isBot: false,
    online: null,
    lastEventAt: T - 60_000,
    outlier: false,
    unverified: false,
    ...over,
  };
}

function next(valueScrap: number, over: Partial<NextBuyer> = {}): NextBuyer {
  return { valueScrap, keys: 0, metalScrap: valueScrap, isBot: false, online: null, lastEventAt: T - 60_000, unverified: false, ...over };
}

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

describe('exitDepthOf: the usable buyers seen in the last 24 h', () => {
  it("keeps one value per buyer, their best, highest first", () => {
    const d = exitDepthOf([order(100, { buyer: 'A' }), order(140, { buyer: 'A' }), order(120, { buyer: 'B' }), order(90, { buyer: 'C' })]);
    expect(d).toEqual({ values: [140, 120, 90], buyers: 3 });
  });

  it('leaves out unverified orders, outliers, 0, negative and non-finite values', () => {
    const d = exitDepthOf([
      order(200, { unverified: true }),
      order(500, { outlier: true }),
      order(0),
      order(-5),
      order(Number.NaN),
      order(Number.POSITIVE_INFINITY),
      order(80),
    ]);
    expect(d).toEqual({ values: [80], buyers: 1 });
  });

  it("counts only bots under Instant (buyerDepthOf's candidate rule)", () => {
    const orders = [order(150, { isBot: true }), order(160), order(140, { isBot: true })];
    expect(exitDepthOf(orders, 'instant')).toEqual({ values: [150, 140], buyers: 2 });
    expect(exitDepthOf(orders, 'conservative')).toEqual({ values: [160, 150, 140], buyers: 3 });
    expect(exitDepthOf(orders, 'best')).toEqual({ values: [160, 150, 140], buyers: 3 });
    // The default is conservative.
    expect(exitDepthOf(orders)).toEqual(exitDepthOf(orders, 'conservative'));
  });

  it('keeps at most EXIT_DEPTH_CAP values while `buyers` stays uncapped', () => {
    const orders = Array.from({ length: 27 }, (_, i) => order(10 + i));
    const d = exitDepthOf(orders);
    expect(EXIT_DEPTH_CAP).toBe(20);
    expect(d.buyers).toBe(27);
    expect(d.values).toHaveLength(EXIT_DEPTH_CAP);
    expect(d.values[0]).toBe(36);
    expect(d.values.at(-1)).toBe(17);
  });

  it('gives an empty depth for an empty book', () => {
    expect(exitDepthOf([])).toEqual({ values: [], buyers: 0 });
  });
});

describe('profitableDepthAt: buyers at break-even', () => {
  const d: ExitDepth = { values: [300, 250, 200], buyers: 3 };

  it('is null without a depth or a finite cost', () => {
    const p: ExitCostSettings = { frictionScrap: 0 };
    expect(profitableDepthAt(null, 100, p)).toBeNull();
    expect(profitableDepthAt(undefined, 100, p)).toBeNull();
    expect(profitableDepthAt(d, null, p)).toBeNull();
    expect(profitableDepthAt(d, undefined, p)).toBeNull();
    expect(profitableDepthAt(d, Number.NaN, p)).toBeNull();
    expect(profitableDepthAt(d, 210, p)).toBe(2);
    expect(profitableDepthAt({ values: [], buyers: 0 }, 210, p)).toBe(0);
  });

  it('counts a value exactly at break-even and not one scrap under, at 0 friction, at friction 2 and at a 5% reserve', () => {
    for (const p of [{ frictionScrap: 0 }, { frictionScrap: 2 }, { frictionScrap: 0, exitReservePct: 0.05 }, { frictionScrap: 2, exitReservePct: 0.05 }] as ExitCostSettings[]) {
      for (const cost of [0, 1, 89, 225, 1000, 5670]) {
        const be = breakEvenFor(cost, p, 'buy')!;
        expect(flipProfit(be, cost, p)! >= 0, `${JSON.stringify(p)} ${cost}`).toBe(true);
        if (be > 1) {
          expect(profitableDepthAt({ values: [be], buyers: 1 }, cost, p), `at ${be}`).toBe(1);
          expect(profitableDepthAt({ values: [be - 1], buyers: 1 }, cost, p), `under ${be}`).toBe(0);
        }
      }
    }
    // The 5% reserve moves the boundary: 225 + ceil(237 x 5%) = 237 clears 225, 236 does not.
    expect(breakEvenFor(225, { frictionScrap: 0, exitReservePct: 0.05 }, 'buy')).toBe(237);
    expect(profitableDepthAt({ values: [237, 236], buyers: 2 }, 225, { frictionScrap: 0, exitReservePct: 0.05 })).toBe(1);
    expect(profitableDepthAt({ values: [237, 236], buyers: 2 }, 225, { frictionScrap: 0 })).toBe(2);
  });

  it("equals the brute-force count of flipProfit(v) >= 0 and the count at or above exits' breakEvenFor (seeded sample)", () => {
    const rnd = rng(20261022);
    const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
    for (let i = 0; i < 3000; i++) {
      const p: ExitCostSettings = { frictionScrap: int(0, 8), exitReservePct: rnd() < 0.4 ? 0 : [0.01, 0.05, 0.07, 0.1, 0.25, 0.5][int(0, 5)] };
      const cost = int(0, 4000);
      const orders = Array.from({ length: int(0, 25) }, () => order(int(1, 5000)));
      const depth = exitDepthOf(orders);
      const brute = depth.values.filter((v) => (flipProfit(v, cost, p) ?? -1) >= 0).length;
      const be = breakEvenFor(cost, p, 'buy')!;
      const atOrAbove = depth.values.filter((v) => v >= be).length;
      const got = profitableDepthAt(depth, cost, p);
      expect(got, `case ${i}`).toBe(brute);
      expect(got, `case ${i} (breakEvenFor ${be})`).toBe(atOrAbove);
      expect(got!).toBeLessThanOrEqual(EXIT_DEPTH_CAP);
    }
  });
});

describe('backupProfitOf: the profit if this buyer leaves', () => {
  const p: ExitCostSettings = { frictionScrap: 2, exitReservePct: 0.05 };

  it('is null for no next buyer, an unverified one (none, as singleExitOf), or no cost', () => {
    expect(backupProfitOf(null, 100, p)).toBeNull();
    expect(backupProfitOf(undefined, 100, p)).toBeNull();
    expect(backupProfitOf(next(300, { unverified: true }), 100, p)).toBeNull();
    expect(backupProfitOf(next(300), null, p)).toBeNull();
  });

  it('is flipProfit at the next buyer, negative values kept', () => {
    expect(backupProfitOf(next(300), 100, p)).toBe(flipProfit(300, 100, p));
    expect(backupProfitOf(next(300), 100, p)).toBe(300 - 100 - 2 - 15);
    expect(backupProfitOf(next(90), 100, p)).toBe(flipProfit(90, 100, p));
    expect(backupProfitOf(next(90), 100, p)!).toBeLessThan(0);
  });
});

describe('exitRiskAt: the three figures at one cost', () => {
  const p: ExitCostSettings = { frictionScrap: 0 };
  const exitDepth: ExitDepth = { values: [270, 200], buyers: 2 };

  it('is null without an ExitDepth (a hand-built entry, no book)', () => {
    expect(exitRiskAt(null, 100, p)).toBeNull();
    expect(exitRiskAt(undefined, 100, p)).toBeNull();
    expect(exitRiskAt({}, 100, p)).toBeNull();
    expect(exitRiskAt({ exitDepth: null, nextBuyer: next(200) }, 100, p)).toBeNull();
  });

  it('gives the depth, the backup and the book depth at a cost', () => {
    expect(exitRiskAt({ exitDepth, nextBuyer: next(200) }, 225, p)).toEqual({ bookDepth: 2, profitableDepth: 1, backupProfitScrap: -25 });
    expect(exitRiskAt({ exitDepth, nextBuyer: next(200) }, 150, p)).toEqual({ bookDepth: 2, profitableDepth: 2, backupProfitScrap: 50 });
    expect(exitRiskAt({ exitDepth, nextBuyer: null }, 150, p)).toEqual({ bookDepth: 2, profitableDepth: 2, backupProfitScrap: null });
  });

  it('has a null depth and a null backup without a cost, the book depth kept', () => {
    expect(exitRiskAt({ exitDepth, nextBuyer: next(200) }, null, p)).toEqual({ bookDepth: 2, profitableDepth: null, backupProfitScrap: null });
  });
});

describe('the Opportunity and MarketRow shapes', () => {
  it('opportunityRiskFields leaves out null figures (as the repo reads them back)', () => {
    expect(opportunityRiskFields(null)).toEqual({});
    expect(opportunityRiskFields({ bookDepth: 3, profitableDepth: 2, backupProfitScrap: -4 })).toEqual({ bookDepth: 3, profitableDepth: 2, backupProfitScrap: -4 });
    const bare = opportunityRiskFields({ bookDepth: 0, profitableDepth: null, backupProfitScrap: null });
    expect(bare).toEqual({ bookDepth: 0 });
    expect(Object.keys(bare)).toEqual(['bookDepth']);
    expect(opportunityRiskFields({ bookDepth: 1, profitableDepth: 1, backupProfitScrap: null })).toEqual({ bookDepth: 1, profitableDepth: 1 });
  });

  it('marketRiskFields keeps a null depth (no price to judge) and leaves out a null backup', () => {
    expect(marketRiskFields(null)).toEqual({});
    const r = marketRiskFields({ bookDepth: 2, profitableDepth: null, backupProfitScrap: null });
    expect(r).toEqual({ bookDepth: 2, profitableDepth: null });
    expect('profitableDepth' in r).toBe(true);
    expect('backupProfitScrap' in r).toBe(false);
    expect(marketRiskFields({ bookDepth: 5, profitableDepth: 3, backupProfitScrap: 12 })).toEqual({ bookDepth: 5, profitableDepth: 3, backupProfitScrap: 12 });
  });
});

describe('liquidityTagOf: the book-depth tag', () => {
  it('bands 0 none, 1 one, 2-4 few, 5+ many; null for a missing, non-finite or negative count', () => {
    expect(BOOK_DEPTH_MANY_MIN).toBe(5);
    expect(liquidityTagOf(0)).toBe('none');
    expect(liquidityTagOf(1)).toBe('one');
    expect(liquidityTagOf(2)).toBe('few');
    expect(liquidityTagOf(4)).toBe('few');
    expect(liquidityTagOf(5)).toBe('many');
    expect(liquidityTagOf(40)).toBe('many');
    expect(liquidityTagOf(Number.NaN)).toBeNull();
    expect(liquidityTagOf(-1)).toBeNull();
    expect(liquidityTagOf(null)).toBeNull();
    expect(liquidityTagOf(undefined)).toBeNull();
  });
});

describe('the risk control: minProfitableDepthOf and depthGateOk', () => {
  it('applies notifications.minProfitableDepth floored into [0, MIN_PROFITABLE_DEPTH_MAX], else 0 (off)', () => {
    expect(MIN_PROFITABLE_DEPTH_MAX).toBe(10);
    expect(minProfitableDepthOf(undefined)).toBe(0);
    expect(minProfitableDepthOf(-1)).toBe(0);
    expect(minProfitableDepthOf(0)).toBe(0);
    expect(minProfitableDepthOf(2.7)).toBe(2);
    expect(minProfitableDepthOf(11)).toBe(10);
    expect(minProfitableDepthOf('3')).toBe(0);
    expect(minProfitableDepthOf(Number.NaN)).toBe(0);
    expect(minProfitableDepthOf(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('passes everything when off; otherwise needs a known depth at least the minimum', () => {
    expect(depthGateOk(null, 0)).toBe(true);
    expect(depthGateOk(undefined, undefined)).toBe(true);
    expect(depthGateOk(0, 0)).toBe(true);
    expect(depthGateOk(null, 2)).toBe(false);
    expect(depthGateOk(undefined, 2)).toBe(false);
    expect(depthGateOk(Number.NaN, 2)).toBe(false);
    expect(depthGateOk(1, 2)).toBe(false);
    expect(depthGateOk(2, 2)).toBe(true);
    expect(depthGateOk(3, 2.9)).toBe(true);
    expect(depthGateOk(10, 50)).toBe(true);
    expect(depthGateOk(9, 50)).toBe(false);
  });
});
