// 0.8 (PC-2, H2): the one next-buyer rule (buyerDepthOf), how a book of order
// summaries is read into it (exitOrdersOfSummaries), and the thin-flip check
// (singleExitOf) with its wording. A robustness check, never a probability.

import { describe, expect, it } from 'vitest';
import {
  buyerDepthOf,
  exitOrdersOfSummaries,
  flipProfit,
  singleExitOf,
  singleExitReason,
  singleExitText,
  SINGLE_EXIT_TEXT,
  type CeilingSettings,
  type ExitOrder,
} from '../../src/shared/ceiling';
import { formatScrap } from '../../src/shared/currency';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { NextBuyer, OrderSummary } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 567;
const money = (v: number): string => formatScrap(v, K);

const P: CeilingSettings = {
  minProfitScrap: DEFAULT_SETTINGS.profit.minProfitScrap,
  minProfitPctOfCost: DEFAULT_SETTINGS.profit.minProfitPctOfCost,
  minMargin: DEFAULT_SETTINGS.profit.minMargin,
  frictionScrap: DEFAULT_SETTINGS.profit.frictionScrap,
};

function order(id: string, valueScrap: number, over: Partial<ExitOrder> = {}): ExitOrder {
  return {
    id,
    buyer: `S-${id}`,
    valueScrap,
    keys: 0,
    metalScrap: valueScrap,
    isBot: false,
    online: null,
    lastEventAt: T0 - MIN,
    outlier: false,
    unverified: false,
    ...over,
  };
}

function next(valueScrap: number, over: Partial<NextBuyer> = {}): NextBuyer {
  return { valueScrap, keys: 0, metalScrap: valueScrap, isBot: false, online: null, lastEventAt: T0 - MIN, unverified: false, ...over };
}

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

describe('buyerDepthOf', () => {
  it("counts one SteamID's orders as one buyer and excludes them all as the revenue buyer's", () => {
    const orders = [order('a1', 100, { buyer: 'A' }), order('a2', 98, { buyer: 'A' }), order('b', 90, { buyer: 'B' })];
    const d = buyerDepthOf(orders, 'a1');
    expect(d.revenueBuyer).toBe('A');
    expect(d.nextBuyer).toMatchObject({ valueScrap: 90, unverified: false });
    expect(d.verifiedBuyerCount).toBe(2);
    // Revenue from A's second order: still A, so B is next.
    expect(buyerDepthOf(orders, 'a2').nextBuyer?.valueScrap).toBe(90);
  });

  it('treats a listing without a SteamID as its own buyer', () => {
    const orders = exitOrdersOfSummaries([summary('x', 100, { steamid: '' }), summary('y', 95, { steamid: '' })]);
    expect(orders.map((o) => o.buyer)).toEqual(['x', 'y']);
    const d = buyerDepthOf(orders, 'x');
    expect(d.revenueBuyer).toBe('x');
    expect(d.nextBuyer?.valueScrap).toBe(95);
    expect(d.verifiedBuyerCount).toBe(2);
  });

  it('never takes an outlier or a zero-valued order as next', () => {
    const orders = [order('a', 100), order('spike', 400, { outlier: true }), order('zero', 0), order('neg', -5), order('nan', Number.NaN), order('c', 60)];
    expect(buyerDepthOf(orders, 'a').nextBuyer?.valueScrap).toBe(60);
    expect(buyerDepthOf(orders.filter((o) => o.id !== 'c'), 'a').nextBuyer).toBeNull();
  });

  it('prefers a verified buyer over a higher unverified one, and flags an unverified pick', () => {
    const a = order('a', 100);
    const b = order('b', 95, { unverified: true });
    const c = order('c', 85);
    expect(buyerDepthOf([a, b, c], 'a').nextBuyer).toEqual(next(85));
    expect(buyerDepthOf([a, b], 'a').nextBuyer).toEqual(next(95, { unverified: true }));
    expect(buyerDepthOf([a], 'a').nextBuyer).toBeNull();
  });

  it("skips humans when useOrder is 'instant' (Instant counts bots only)", () => {
    const orders = [order('a', 100, { isBot: true }), order('b', 95), order('c', 80, { isBot: true })];
    expect(buyerDepthOf(orders, 'a', 'instant').nextBuyer).toMatchObject({ valueScrap: 80, isBot: true });
    expect(buyerDepthOf(orders, 'a', 'conservative').nextBuyer).toMatchObject({ valueScrap: 95, isBot: false });
    expect(buyerDepthOf(orders, 'a').nextBuyer?.valueScrap).toBe(95);
  });

  it("breaks ties as compareValued does: a bot, then the newest lastEventAt, then the lower id", () => {
    const rev = order('rev', 200);
    const human = order('h', 90, { lastEventAt: T0 });
    const bot = order('k', 90, { isBot: true, lastEventAt: T0 - HOUR, online: true });
    expect(buyerDepthOf([rev, human, bot], 'rev').nextBuyer).toEqual(next(90, { isBot: true, online: true, lastEventAt: T0 - HOUR }));
    const older = order('m', 90, { lastEventAt: T0 - HOUR });
    const newer = order('n', 90, { lastEventAt: T0 - MIN, keys: 1, metalScrap: 3 });
    expect(buyerDepthOf([rev, older, newer], 'rev').nextBuyer).toEqual(next(90, { lastEventAt: T0 - MIN, keys: 1, metalScrap: 3 }));
    const z = order('z', 90, { metalScrap: 1 });
    const y = order('y', 90, { metalScrap: 2 });
    expect(buyerDepthOf([rev, z, y], 'rev').nextBuyer?.metalScrap).toBe(2);
  });

  it('gives no revenue buyer and no next buyer without a revenue order among the orders', () => {
    const orders = [order('a', 100), order('b', 90)];
    for (const id of [null, undefined, 'missing']) {
      const d = buyerDepthOf(orders, id);
      expect(d).toEqual({ revenueBuyer: null, nextBuyer: null, verifiedBuyerCount: 2 });
    }
    expect(buyerDepthOf([], 'a')).toEqual({ revenueBuyer: null, nextBuyer: null, verifiedBuyerCount: 0 });
  });

  it('counts distinct buyers not flagged unverified, outliers and zero-valued orders included', () => {
    const orders = [
      order('a', 100, { buyer: 'A' }),
      order('a2', 90, { buyer: 'A' }),
      order('spike', 400, { buyer: 'X', outlier: true }),
      order('zero', 0, { buyer: 'Z' }),
      order('old', 80, { buyer: 'O', unverified: true }),
      // One fresh order is enough for a buyer whose other order is unverified.
      order('mix1', 70, { buyer: 'M', unverified: true }),
      order('mix2', 60, { buyer: 'M' }),
    ];
    expect(buyerDepthOf(orders, 'a').verifiedBuyerCount).toBe(4);
  });
});

describe('exitOrdersOfSummaries', () => {
  it("drops ineligible orders and reads the 'outlier' and 'unverified' flags and outlierIds", () => {
    const book = [
      summary('a', 100, { isBot: true, online: true, keys: 1, metalScrap: 9, steamid: 'A' }),
      summary('b', 90, { flags: ['outlier'] }),
      summary('c', 80, { flags: ['unverified'] }),
      summary('d', 70),
      summary('e', 500, { eligible: false, flags: ['blocklisted'] }),
    ];
    const orders = exitOrdersOfSummaries(book, new Set(['d']));
    expect(orders.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(orders[0]).toEqual({ id: 'a', buyer: 'A', valueScrap: 100, keys: 1, metalScrap: 9, isBot: true, online: true, lastEventAt: T0 - MIN, outlier: false, unverified: false });
    expect(orders.map((o) => o.outlier)).toEqual([false, true, false, true]);
    expect(orders.map((o) => o.unverified)).toEqual([false, false, true, false]);
    // Without outlierIds only the flag counts.
    expect(exitOrdersOfSummaries(book).map((o) => o.outlier)).toEqual([false, true, false, false]);
    expect(exitOrdersOfSummaries(book, null).map((o) => o.outlier)).toEqual([false, true, false, false]);
  });
});

describe('singleExitOf', () => {
  it('is null when the flip is not profitable on its own revenue', () => {
    expect(singleExitOf(230, 225, null, P)).toBeNull();
    expect(singleExitOf(null, 225, null, P)).toBeNull();
    expect(singleExitOf(270, null, null, P)).toBeNull();
  });

  it('is thin with no next buyer, an unverified profitable next one, or a verified one below the thresholds', () => {
    expect(singleExitOf(270, 225, null, P)).toEqual({ next: null, nextProfitScrap: null });
    const unverified = next(261, { unverified: true });
    expect(singleExitOf(270, 225, unverified, P)).toEqual({ next: unverified, nextProfitScrap: 36 });
    const low = next(180);
    expect(singleExitOf(270, 225, low, P)).toEqual({ next: low, nextProfitScrap: -45 });
    // Profitable but under the thresholds (230 - 225 = 5 < 9 scrap) is still thin.
    expect(singleExitOf(270, 225, next(230), P)).toEqual({ next: next(230), nextProfitScrap: 5 });
  });

  it('is null with a verified next buyer who still makes it a flip', () => {
    expect(singleExitOf(270, 225, next(261), P)).toBeNull();
  });

  it("judges both buyers with flipProfit, the price-move reserve included", () => {
    const p = { ...P, exitReservePct: 0.05 };
    // 261 - 225 - 14 = 22 at 5%: still a flip; 245 - 225 - 13 = 7: not.
    expect(singleExitOf(270, 225, next(261), p)).toBeNull();
    expect(singleExitOf(270, 225, next(245), p)).toEqual({ next: next(245), nextProfitScrap: flipProfit(245, 225, p) });
    expect(flipProfit(245, 225, p)).toBe(7);
  });
});

describe('singleExitText / singleExitReason', () => {
  it('words the next buyer exactly', () => {
    expect(singleExitReason({ next: next(180), nextProfitScrap: -45 }, money)).toBe('0 Only this buyer makes it a flip: the next buyer pays 20.00 ref (profit -5.00 ref)');
    expect(singleExitText({ next: null, nextProfitScrap: null }, money)).toBe('Only this buyer makes it a flip: no other usable buyer is in the book');
    expect(singleExitText({ next: next(261, { unverified: true }), nextProfitScrap: 36 }, money)).toBe(
      'Only this buyer makes it a flip: the next buyer pays 29.00 ref (profit 4.00 ref) but was not seen in the last 24 h',
    );
    expect(singleExitText({ next: next(180), nextProfitScrap: null }, money)).toBe('Only this buyer makes it a flip: the next buyer pays 20.00 ref');
  });

  it('starts with SINGLE_EXIT_TEXT, and the reason is a 0-delta reason', () => {
    const s = { next: next(180), nextProfitScrap: -45 };
    expect(singleExitText(s, money).startsWith(SINGLE_EXIT_TEXT)).toBe(true);
    expect(singleExitReason(s, money)).toBe(`0 ${singleExitText(s, money)}`);
  });
});
