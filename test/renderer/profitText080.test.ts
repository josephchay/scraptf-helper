// 0.8 (PC-1, PC-2, H2): the wording of the price-move reserve and the next buyer: the profit breakdown, the
// drawer's Next buyer line, the Opportunities Buyers hover, Quick entry's Profit hover, the check popup's titles,
// Holdings' Buyers hover and the 'single-exit' flag. Presence and prices only, never a fill chance.

import { describe, expect, it } from 'vitest';
import { bankStockVerdictPill } from '../../src/renderer/bankStockModel';
import { checkPayUpTo, checkVerdictView } from '../../src/renderer/checkModel';
import { flagInfo } from '../../src/renderer/format';
import { holdingBuyersTitle } from '../../src/renderer/holdingsModel';
import { verdictPill } from '../../src/renderer/marketModel';
import { mockCheckDemo } from '../../src/renderer/mockCheck';
import { exitCostsWords, nextBuyerLine, profitBreakdownText, singleExitTitleOf } from '../../src/renderer/oppModel';
import { previewProfitTitle, profitPreview, type PreviewSettings } from '../../src/renderer/quickModel';
import { maxCostFor, profitBreakdown } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckResult, ItemRevenue, NextBuyer, OrderSummary } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 567;
const P: PreviewSettings = { ...DEFAULT_SETTINGS.profit };

function summary(listingId: string, valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId,
    steamid: `S-${listingId}`,
    userName: null,
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: false,
    online: null,
    lastEventAt: T0 - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

const A = summary('a', 270);

/** An opportunity's revenue picks: the conservative order is A (30.00 ref), the cost 25.00 ref. */
function opp(cons: OrderSummary | null = A, costScrap = 225) {
  return { revenueScrap: cons?.valueScrap ?? null, costScrap, bestOrder: cons, consOrder: cons, instantOrder: null };
}

describe('0.8 (PC-1): exitCostsWords and profitBreakdownText', () => {
  it('names the reserve only when one is set', () => {
    expect(exitCostsWords(0)).toBe('friction');
    expect(exitCostsWords(null)).toBe('friction');
    expect(exitCostsWords(undefined)).toBe('friction');
    expect(exitCostsWords(0.05)).toBe('friction and the 5% price-move reserve');
    expect(exitCostsWords(0.025)).toBe('friction and the 2.5% price-move reserve');
    // Out of range counts as none, as reservePctOf.
    expect(exitCostsWords(0.6)).toBe('friction');
  });

  it('breaks a flip down into cost, friction and the reserve, each named only above 0', () => {
    expect(profitBreakdownText(profitBreakdown(300, 200, { frictionScrap: 1, exitReservePct: 0.05 }), K)).toBe(
      'Sells for 33.33 ref, minus your cost 22.22 ref, friction 0.11 ref and the 5% price-move reserve 1.66 ref: profit +9.33 ref.',
    );
    expect(profitBreakdownText(profitBreakdown(300, 200, { frictionScrap: 1, exitReservePct: 0 }), K)).toBe(
      'Sells for 33.33 ref, minus your cost 22.22 ref and friction 0.11 ref: profit +11.00 ref.',
    );
    expect(profitBreakdownText(profitBreakdown(300, 200, { frictionScrap: 0, exitReservePct: 0.05 }), K)).toBe(
      'Sells for 33.33 ref, minus your cost 22.22 ref and the 5% price-move reserve 1.66 ref: profit +9.44 ref.',
    );
    expect(profitBreakdownText(profitBreakdown(300, 200, { frictionScrap: 0 }), K)).toBe('Sells for 33.33 ref, minus your cost 22.22 ref: profit +11.11 ref.');
    expect(profitBreakdownText(profitBreakdown(null, 200, { frictionScrap: 0 }), K)).toBeNull();
    expect(profitBreakdownText(null, K)).toBeNull();
  });
});

describe('0.8 (PC-2): nextBuyerLine', () => {
  it('claims nothing without a revenue order, or when that order is not in the book', () => {
    expect(nextBuyerLine(opp(null), [A, summary('b', 261)], P, K, T0)).toBeNull();
    expect(nextBuyerLine(opp(), [summary('b', 261)], P, K, T0)).toBeNull();
    // An ineligible copy of the order is not in the eligible book either.
    expect(nextBuyerLine(opp(), [{ ...A, eligible: false }, summary('b', 261)], P, K, T0)).toBeNull();
  });

  it("says 'None: only this buyer' as a warning when no other buyer is left", () => {
    expect(nextBuyerLine(opp(), [A], P, K, T0)).toEqual({
      text: 'None: only this buyer',
      tone: 'warn',
      title: 'If this buyer fills or withdraws, no other usable buyer is in the book.',
    });
    const named = { ...A, userName: 'Alex' };
    expect(nextBuyerLine(opp(named), [named], P, K, T0)!.title).toBe('If Alex fills or withdraws, no other usable buyer is in the book.');
  });

  it('a verified next buyer that still makes it a flip is not a warning', () => {
    expect(nextBuyerLine(opp(), [A, summary('b', 261)], P, K, T0)).toEqual({
      text: '29.00 ref · profit +4.00 ref',
      tone: null,
      title: 'If this buyer fills or withdraws, the next buyer (human, online status unknown) pays 29.00 ref: still a flip at this cost. Buy orders show demand, not sales.',
    });
  });

  it('a next buyer that pays too little, or one not seen in 24 h, is a warning', () => {
    const low = nextBuyerLine(opp(), [A, summary('b', 180, { isBot: true, online: true })], P, K, T0)!;
    expect(low).toMatchObject({ text: '20.00 ref · profit -5.00 ref', tone: 'warn' });
    expect(low.title).toBe('If this buyer fills or withdraws, the next buyer (bot, online) pays 20.00 ref: not a flip at this cost. Buy orders show demand, not sales.');
    const stale = nextBuyerLine(opp(), [A, summary('b', 261, { lastEventAt: T0 - 25 * HOUR, flags: ['unverified'] })], P, K, T0)!;
    expect(stale).toMatchObject({ text: '29.00 ref · profit +4.00 ref · not seen in 24 h', tone: 'warn' });
    expect(stale.title).toBe(
      'If this buyer fills or withdraws, the next buyer (human, last seen 1 d ago) pays 29.00 ref: a flip at this cost, if that order is still there. Buy orders show demand, not sales.',
    );
  });

  it('a row that is not a flip is never a warning', () => {
    // Cost 29.00 ref: A's 30.00 ref is not profitable, so nothing rests on A alone.
    expect(nextBuyerLine(opp(A, 261), [A], P, K, T0)).toMatchObject({ text: 'None: only this buyer', tone: null });
  });
});

describe("0.8 (PC-2): the Opportunities Buyers hover and the 'single-exit' flag", () => {
  const REASON = '0 Only this buyer makes it a flip: the next buyer pays 20.00 ref (profit -5.00 ref)';

  it("quotes the row's own reason, and is undefined without the flag", () => {
    expect(singleExitTitleOf({ flags: ['single-exit'], reasons: ['+10 Buyer is online', REASON], buyerCount: 2 })).toBe(
      '2 buyers with eligible orders. Only this buyer makes it a flip: the next buyer pays 20.00 ref (profit -5.00 ref).',
    );
    expect(singleExitTitleOf({ flags: ['single-exit'], reasons: [], buyerCount: 1 })).toBe('1 buyer with eligible orders. Only this buyer makes it a flip.');
    expect(singleExitTitleOf({ flags: [], reasons: [REASON], buyerCount: 2 })).toBeUndefined();
  });

  it('is a warning chip', () => {
    expect(flagInfo('single-exit')).toMatchObject({ label: 'One buyer', tone: 'warn' });
    expect(flagInfo('single-exit').help).toContain('not a fill chance');
  });
});

describe("0.8 (PC-1, PC-2): Quick entry's Profit hover", () => {
  function rev(order: OrderSummary | null, p: PreviewSettings = P): ItemRevenue {
    const revenueScrap = order?.valueScrap ?? null;
    return { bestScrap: revenueScrap, consScrap: revenueScrap, instantScrap: null, useOrder: p.useOrder, revenueScrap, order, maxCostScrap: maxCostFor(revenueScrap, p), eligibleCount: order ? 1 : 0 };
  }

  it('is the breakdown, plus the one-buyer warning on a profitable price', () => {
    const r = rev(A);
    const pv = profitPreview(225, r, P);
    expect(pv.status).toBe('profitable');
    expect(previewProfitTitle(pv, r, [A], P, K)).toBe(
      'Sells for 30.00 ref, minus your cost 25.00 ref: profit +5.00 ref. Only this buyer makes it a flip: no other usable buyer is in the book.',
    );
    // A verified backup that still profits: the breakdown alone.
    expect(previewProfitTitle(pv, r, [A, summary('b', 261)], P, K)).toBe('Sells for 30.00 ref, minus your cost 25.00 ref: profit +5.00 ref.');
  });

  it('never warns on a price that is not a flip, and names the reserve when set', () => {
    const r = rev(A);
    expect(previewProfitTitle(profitPreview(261, r, P), r, [A], P, K)).toBe('Sells for 30.00 ref, minus your cost 29.00 ref: profit +1.00 ref.');
    const reserved = { ...P, exitReservePct: 0.05 };
    expect(previewProfitTitle(profitPreview(200, rev(A, reserved), reserved), rev(A, reserved), [A, summary('b', 261)], reserved, K)).toBe(
      'Sells for 30.00 ref, minus your cost 22.22 ref and the 5% price-move reserve 1.55 ref: profit +6.22 ref.',
    );
  });

  it('is undefined without a preview or a revenue', () => {
    expect(previewProfitTitle(null, rev(A), [A], P, K)).toBeUndefined();
    const none = rev(null);
    expect(previewProfitTitle(profitPreview(225, none, P), none, [], P, K)).toBeUndefined();
  });
});

describe('0.8 (PC-1, PC-2): the check popup titles', () => {
  const demo = (): CheckResult => mockCheckDemo('flip', T0, K, DEFAULT_SETTINGS);

  it("the flip title breaks the profit down when the result says what was taken off, else reads as 0.7.4's", () => {
    const r = demo();
    expect(r.exitCosts).toEqual({ frictionScrap: 0, reserveScrap: 0, reservePct: 0, totalScrap: 0 });
    const breakdown = profitBreakdownText({ revenueScrap: r.revenue!.revenueScrap!, costScrap: r.price!.valueScrap, ...r.exitCosts!, profitScrap: r.profitScrap! }, K);
    expect(checkVerdictView(r)!.title).toBe(`Profitable at this price by your profit thresholds. ${breakdown}`);
    const { exitCosts: _gone, ...older } = r;
    expect(checkVerdictView(older)!.title).toBe('Profitable at this price by your profit thresholds, after friction.');
  });

  it('a flip only this buyer makes says so', () => {
    const r: CheckResult = { ...demo(), singleExit: { next: null, nextProfitScrap: null } };
    expect(checkVerdictView(r)!.title).toMatch(/ Only this buyer makes it a flip: no other usable buyer is in the book\.$/);
    const next: NextBuyer = { valueScrap: 180, keys: 0, metalScrap: 180, isBot: false, online: null, lastEventAt: T0, unverified: false };
    expect(checkVerdictView({ ...r, singleExit: { next, nextProfitScrap: -45 } })!.title).toMatch(/ Only this buyer makes it a flip: the next buyer pays 20\.00 ref \(profit -5\.00 ref\)\.$/);
  });

  it("Pay up to's title is 0.7.4's at reserve 0 and names a reserve when one applied", () => {
    const r = demo();
    expect(checkPayUpTo(r).title).toBe('The most to pay on scrap.tf that still clears your profit thresholds (after friction).');
    expect(checkPayUpTo({ ...r, exitCosts: { frictionScrap: 0, reserveScrap: 30, reservePct: 0.05, totalScrap: 30 } }).title).toBe(
      'The most to pay on scrap.tf that still clears your profit thresholds (after friction and the 5% price-move reserve).',
    );
  });
});

describe("0.8 (H2): Holdings' Buyers hover", () => {
  const named = { ...A, userName: 'Alex' };
  const next = (valueScrap: number, over: Partial<NextBuyer> = {}): NextBuyer => ({
    valueScrap,
    keys: 0,
    metalScrap: valueScrap,
    isBot: true,
    online: true,
    lastEventAt: T0 - MIN,
    unverified: false,
    ...over,
  });

  it('says there are none, or the head alone without depth fields', () => {
    expect(holdingBuyersTitle({ buyerCount: 0, revenueScrap: null, revenueOrder: null }, K, T0)).toBe('No eligible backpack.tf buy orders in the live book.');
    expect(holdingBuyersTitle({ buyerCount: 3, revenueScrap: 270, revenueOrder: named }, K, T0)).toBe('3 distinct buyers with eligible orders.');
    expect(holdingBuyersTitle({ buyerCount: 3, revenueScrap: 270, revenueOrder: named, verifiedBuyerCount: 2 }, K, T0)).toBe(
      '3 distinct buyers with eligible orders, 2 of them seen in the last 24 h.',
    );
  });

  it('says what the next buyer pays against this sale', () => {
    const r = { buyerCount: 3, revenueScrap: 270, revenueOrder: named, verifiedBuyerCount: 2 };
    expect(holdingBuyersTitle({ ...r, nextBuyer: next(261) }, K, T0)).toBe(
      '3 distinct buyers with eligible orders, 2 of them seen in the last 24 h. If Alex fills or withdraws, the next buyer (bot, online) pays 29.00 ref (1.00 ref less). Buy orders show demand, not sales.',
    );
    expect(holdingBuyersTitle({ ...r, nextBuyer: next(280, { isBot: false, online: null, lastEventAt: T0 - 25 * HOUR }) }, K, T0)).toBe(
      '3 distinct buyers with eligible orders, 2 of them seen in the last 24 h. If Alex fills or withdraws, the next buyer (human, last seen 1 d ago) pays 31.11 ref (1.11 ref more). Buy orders show demand, not sales.',
    );
    expect(holdingBuyersTitle({ ...r, nextBuyer: next(270) }, K, T0)).toContain('pays 30.00 ref (the same).');
    expect(holdingBuyersTitle({ buyerCount: 1, revenueScrap: 270, revenueOrder: A, verifiedBuyerCount: 1, nextBuyer: null }, K, T0)).toBe(
      '1 distinct buyer with eligible orders, 1 of them seen in the last 24 h. If Human fills or withdraws, no other usable buyer is left.',
    );
  });
});

describe('0.8 (PC-1): the market and bank stock Flip titles name the reserve only when one is set', () => {
  const market: Parameters<typeof verdictPill>[0] = { verdict: 'flip', profitScrap: 45, knownCostScrap: 225, maxCostScrap: 240, ruleCostScrap: null, revenueScrap: 270, buyerCount: 2, flags: [] };
  const bank: Parameters<typeof bankStockVerdictPill>[0] = { verdict: 'flip', profitScrap: 45, margin: 0.2, costScrap: 225, maxCostScrap: 240, hasExtras: false, change: null, buyerCount: 2 };

  it('Live market', () => {
    expect(verdictPill(market, K, 0.05).title).toContain('Profit +5.00 ref after friction and the 5% price-move reserve.');
    // Off (the default) or not given: the 0.7.4 text, no reserve named.
    for (const off of [0, null, undefined]) {
      const title = verdictPill(market, K, off).title;
      expect(title, String(off)).toContain('Profit +5.00 ref after friction.');
      expect(title, String(off)).not.toContain('reserve');
    }
  });

  it('bank stock', () => {
    expect(bankStockVerdictPill(bank, K, null, 0.05).title).toContain('+5.00 ref after friction and the 5% price-move reserve, a 20% margin.');
    for (const off of [0, null, undefined]) {
      const title = bankStockVerdictPill(bank, K, null, off).title;
      expect(title, String(off)).toContain('+5.00 ref after friction, a 20% margin.');
      expect(title, String(off)).not.toContain('reserve');
    }
  });
});
