// 0.8 (PC-1, PC-2) in the engine: the 'single-exit' warning on a flip only the revenue order's buyer makes (a
// 0-delta reason, the score unchanged), the price-move reserve in profit and Pay up to, the rule prefilter's
// bound (flipProfitBound) and the unverified upside. Kept out of the TIMED engine.test.ts.

import { describe, expect, it } from 'vitest';
import { scoreConfidence } from '../../src/service/domain/confidence';
import { evaluateOpportunity, priceBook, ruleInput, unverifiedUpside } from '../../src/service/domain/engine';
import type { EvaluateArgs } from '../../src/service/domain/engine';
import { matchContext } from '../../src/service/domain/matcher';
import { pickRevenueOrder } from '../../src/service/domain/pricing';
import { flipProfit, flipProfitBound, frictionOf, maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, Listing, OrderSummary, Settings } from '../../src/shared/types';
import { HOUR, MIN, T0, makeListing } from './helpers';

const K = 567;
const rule = { id: 3, name: 'r', filter: {}, costKeys: 0, costScrap: 100, observedAt: T0, enabled: true };

function args(over: Partial<EvaluateArgs> = {}, profit: DeepPartial<Settings['profit']> = {}): EvaluateArgs {
  const s = mergeSettings(DEFAULT_SETTINGS, { profit });
  return {
    input: ruleInput(rule, '378;6', 'Team Captain'),
    listings: [
      makeListing({ id: 'whale', steamid: 'W', metalScrap: 400 }),
      makeListing({ id: 'human', steamid: 'H', metalScrap: 150 }),
      makeListing({ id: 'bot', steamid: 'B', metalScrap: 140, isBot: true }),
      makeListing({ id: 'low', steamid: 'L', metalScrap: 130 }),
    ],
    references: { pricedb: null, community: null },
    category: 'hats',
    isUnusual: false,
    settings: s,
    keyScrap: K,
    now: T0,
    match: matchContext(s, T0),
    prev: null,
    ...over,
  };
}

/** The spec's book: A pays 270 (the revenue), B pays `b` (another SteamID); rule cost 225. */
function thin(b: number | null, bOver: Partial<Listing> = {}): EvaluateArgs {
  const listings = [makeListing({ id: 'A', steamid: 'A', metalScrap: 270, lastEventAt: T0 - MIN })];
  if (b !== null) listings.push(makeListing({ id: 'B', steamid: 'B', metalScrap: b, lastEventAt: T0 - MIN, ...bOver }));
  return args({ input: ruleInput({ ...rule, costScrap: 225 }, '378;6', 'Team Captain'), listings });
}

/** scoreConfidence on the same book exactly as evaluateOpportunity calls it, without the single-exit check. */
function confidenceWithoutCheck(a: EvaluateArgs) {
  const p = a.settings.profit;
  const book = priceBook(a.listings, a.input.target, a.references, p, a.keyScrap, a.now, a.match);
  const order = pickRevenueOrder(book.prices, p.useOrder);
  const cost = a.input.costScrapRaw;
  const profit = flipProfit(order?.valueScrap ?? null, cost, p);
  return scoreConfidence({
    order,
    eligible: book.eligible,
    references: a.references,
    inputKind: a.input.inputKind,
    inputObservedAt: a.input.observedAt,
    isUnusual: a.isUnusual,
    revenueScrap: order?.valueScrap ?? null,
    margin: profit === null || cost <= 0 ? null : profit / cost,
    costScrap: cost,
    twin: null,
    keyScrap: a.keyScrap,
    now: a.now,
    profit: p,
  });
}

describe("0.8 (PC-2): 'single-exit' on a flip only the revenue order's buyer makes", () => {
  it('flags the flip and adds the next buyer as the last, 0-delta reason; the confidence is unchanged', () => {
    const a = thin(180);
    const o = evaluateOpportunity(a);
    expect(o).toMatchObject({ revenueScrap: 270, costScrap: 225, profitScrap: 45, status: 'profitable' });
    expect(o.flags).toContain('single-exit');
    const reason = '0 Only this buyer makes it a flip: the next buyer pays 20.00 ref (profit -5.00 ref)';
    expect(o.reasons).toContain(reason);
    expect(o.reasons.at(-1)).toBe(reason);
    const conf = confidenceWithoutCheck(a);
    expect(o.confidence).toBe(conf.score);
    expect(o.confidenceLevel).toBe(conf.level);
    expect(o.reasons).toEqual([...conf.reasons, reason]);
  });

  it('is not raised when a verified next buyer still makes it a flip', () => {
    const o = evaluateOpportunity(thin(261));
    expect(o.status).toBe('profitable');
    expect(o.flags).not.toContain('single-exit');
    expect(o.reasons.some((r) => r.startsWith('0 Only this buyer'))).toBe(false);
  });

  it('is raised when the profitable next buyer was not seen in the last 24 h', () => {
    const o = evaluateOpportunity(thin(261, { lastEventAt: T0 - 25 * HOUR }));
    expect(o.revenueScrap).toBe(270);
    expect(o.flags).toContain('single-exit');
    expect(o.reasons.at(-1)).toBe('0 Only this buyer makes it a flip: the next buyer pays 29.00 ref (profit 4.00 ref) but was not seen in the last 24 h');
  });

  it('is raised with one buyer, naming no other usable buyer', () => {
    const o = evaluateOpportunity(thin(null));
    expect(o.flags).toContain('single-exit');
    expect(o.reasons.at(-1)).toBe('0 Only this buyer makes it a flip: no other usable buyer is in the book');
  });

  it('never flags a row that is not a flip', () => {
    const over = evaluateOpportunity(args({ input: ruleInput({ ...rule, costScrap: 265 }, '378;6'), listings: thin(null).listings }));
    expect(over.status).not.toBe('profitable');
    expect(over.flags).not.toContain('single-exit');
  });
});

describe('0.8 (PC-1): the price-move reserve in the engine', () => {
  it("takes the reserve off profit and Pay up to (engine.test's book: cons 150, rule cost 100)", () => {
    const off = evaluateOpportunity(args());
    expect(off).toMatchObject({ profitScrap: 50, maxCostScrap: 138 });
    const on = evaluateOpportunity(args({}, { exitReservePct: 0.05 }));
    // ceil(150 x 5%) = 8: 150 - 100 - 8 = 42; 142 / 1.08 = 131.5.
    expect(on).toMatchObject({ profitScrap: 42, maxCostScrap: 131 });
    expect(on.maxCostScrap).toBe(maxCostFor(150, { ...DEFAULT_SETTINGS.profit, exitReservePct: 0.05 }));
  });

  it('flipProfitBound <= 0 means no revenue up to the bound profits, and is 0.7.4 maxRaw - cost - friction at pct 0', () => {
    let seed = 20261022 >>> 0;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
    let bounded = 0;
    for (let i = 0; i < 5000; i++) {
      const p = { frictionScrap: int(0, 60), exitReservePct: rnd() < 0.5 ? 0 : rnd() * 0.5 };
      const maxRaw = int(0, 200_000);
      // Half the costs sit within a few scrap of the bound's zero, where an off-by-one would show.
      const edge = Math.ceil(maxRaw * (1 - p.exitReservePct) - frictionOf(p));
      const cost = rnd() < 0.5 ? int(0, maxRaw + 50) : Math.max(0, edge + int(-2, 2));
      const bound = flipProfitBound(maxRaw, cost, p);
      if (p.exitReservePct === 0) expect(bound).toBe(maxRaw - cost - frictionOf(p));
      if (bound > 0) continue;
      bounded++;
      for (const r of [maxRaw, maxRaw - rnd(), rnd() * maxRaw, int(0, maxRaw)]) {
        const profit = flipProfit(r, cost, p);
        expect(profit === null || profit <= 0, `r ${r} cost ${cost} ${JSON.stringify(p)}`).toBe(true);
      }
    }
    expect(bounded).toBeGreaterThan(1000);
  });

  it('unverifiedUpside judges with the reserve and equals flipProfit when profitable', () => {
    const best = (valueScrap: number): OrderSummary => ({
      listingId: 'u',
      steamid: 'U',
      userName: null,
      keys: 0,
      metalScrap: valueScrap,
      valueScrap,
      isBot: true,
      online: null,
      lastEventAt: T0 - 25 * HOUR,
      bumpedAt: null,
      details: '',
      flags: ['unverified'],
      eligible: true,
    });
    const p = mergeSettings(DEFAULT_SETTINGS, { profit: { exitReservePct: 0.05 } }).profit;
    expect(unverifiedUpside({ bestOrder: best(300), costScrap: 200, flags: [] }, p)).toBe(flipProfit(300, 200, p));
    expect(flipProfit(300, 200, p)).toBe(85);
    // 110 - 100 = 10 clears the thresholds without a reserve; 110 - 100 - 6 = 4 does not.
    expect(unverifiedUpside({ bestOrder: best(110), costScrap: 100, flags: [] }, DEFAULT_SETTINGS.profit)).toBe(10);
    expect(unverifiedUpside({ bestOrder: best(110), costScrap: 100, flags: [] }, p)).toBeNull();
  });
});
