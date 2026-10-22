// 0.7.4 trading accuracy audit (package PB): computePrices on books with stale orders and zero-valued ones.
// F13/F21/F47: an order nobody has confirmed for 24 h ('unverified') may be gone after a feed gap, so with
// any verified order Conservative and the outlier median come from verified orders; Best stays the top
// order; Instant never picks an unverified bot (F23). F19: "0.05 ref" orders (0 scrap) are out of the
// median and never outliers. No parsing here, so no schema fixture is needed.

import { describe, expect, it } from 'vitest';
import { matchContext, classifyOrder } from '../../src/service/domain/matcher';
import { computePrices, isUnverifiedOrder, valueOrders } from '../../src/service/domain/pricing';
import { evaluateOpportunity, explicitInput } from '../../src/service/domain/engine';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { Listing, ScrapPrice } from '../../src/shared/types';
import { HOUR, MIN, T0, makeListing, testSettings } from './helpers';

const K = 577;
const P = testSettings().profit;

/** Eligible orders classified as the engine does at T0 (so a listing over 24 h old is 'unverified'). */
function book(listings: Listing[]) {
  const match = matchContext(DEFAULT_SETTINGS, T0);
  const target = { baseSku: '378;6', special: null };
  return valueOrders(
    listings.map((listing) => ({ listing, ...classifyOrder(listing, target, match) })).filter((o) => o.eligible),
    K,
  );
}

const at = (id: string, metalScrap: number, ageMs: number, over: Partial<Listing> = {}): Listing =>
  makeListing({ id, steamid: `S-${id}`, metalScrap, lastEventAt: T0 - ageMs, ...over });

describe('computePrices with unverified orders (F13, F21, F47)', () => {
  it('takes Conservative and Instant from verified orders; Best stays the stale top order', () => {
    // 5040;6 (A Distinctive Lack of Hue) in the user's data: percybot's 116 h old order on top, fresh ones below.
    const orders = book([
      at('percybot', 2 * K + 282, 116 * HOUR, { isBot: true }),
      at('maomao', 2 * K + 212, 20 * MIN),
      at('freshbot', 2 * K + 191, 30 * MIN, { isBot: true }),
    ]);
    expect(orders.map((o) => isUnverifiedOrder(o))).toEqual([true, false, false]);
    const r = computePrices(orders, {}, P);
    expect(r.best?.listing.id).toBe('percybot');
    expect(r.conservative?.listing.id).toBe('maomao');
    expect(r.instant?.listing.id).toBe('freshbot');
  });

  it('reproduces Strange Archer\'s Sterling: the fresh book is a loss at the 103 scrap cost', () => {
    const orders = book([
      at('PAYAH', 115, 136 * HOUR, { isBot: true, userOnline: true }),
      at('ZeBro', 114, 140 * HOUR, { isBot: true }),
      at('Dispenser', 106, 92 * HOUR, { isBot: true }),
      at('SpaceBot', 100, 20 * HOUR),
      at('BB-8', 80, 12 * MIN, { isBot: true }),
    ]);
    const r = computePrices(orders, {}, P);
    expect(r.best?.listing.id).toBe('PAYAH');
    expect(r.conservative?.valueScrap).toBe(100);
    expect(r.instant?.listing.id).toBe('BB-8');
    // The median is over the verified orders only: (100 + 80) / 2.
    expect(r.ref).toBe(90);
  });

  it('keeps stale highs from inflating the median, so they are outliers against the verified book', () => {
    const orders = book([at('s1', 140, 30 * HOUR), at('s2', 135, 30 * HOUR), at('s3', 132, 30 * HOUR), at('f1', 100, MIN), at('f2', 98, MIN), at('f3', 96, MIN)]);
    const r = computePrices(orders, {}, P);
    // Over all six the top-five median would be 132 and 140 no outlier; over the verified three it is 98.
    expect(r.ref).toBe(98);
    expect([...r.outlierIds].sort()).toEqual(['s1', 's2', 's3']);
    expect(r.conservative?.listing.id).toBe('f1');
  });

  it('with no verified order picks Conservative as before, but no unverified bot is Instant', () => {
    const orders = book([at('a', 120, 30 * HOUR, { isBot: true }), at('b', 110, 40 * HOUR)]);
    const r = computePrices(orders, {}, P);
    expect(r.best?.listing.id).toBe('a');
    expect(r.conservative?.listing.id).toBe('a');
    expect(r.instant).toBeNull();
  });

  it('counts orders without classifier flags as verified (ValuedOrderLike callers)', () => {
    const plain = valueOrders([{ listing: at('x', 50, 30 * HOUR, { isBot: true }) }], K);
    const r = computePrices(plain, {}, P);
    expect(r.conservative?.listing.id).toBe('x');
    expect(r.instant?.listing.id).toBe('x');
  });
});

describe('computePrices with zero-valued orders (F19)', () => {
  const zeros = (values: number[]) => book(values.map((v, i) => at(`o${i}`, v, MIN)));

  it('leaves "0.05 ref" orders (0 scrap) out of the median and never calls them outliers', () => {
    // The Buff Banner's book: one 1-scrap order over three half-scrap ones.
    const buff = computePrices(zeros([1, 0, 0, 0]), {}, P);
    expect(buff.conservative?.valueScrap).toBe(1);
    expect(buff.outlierIds.size).toBe(0);
    const gazer = computePrices(zeros([13, 13, 0, 0]), {}, P);
    expect(gazer.conservative?.valueScrap).toBe(13);
    expect(gazer.outlierIds.size).toBe(0);
    expect(gazer.ref).toBe(13);
  });

  it('still catches a troll order over the positive ones', () => {
    const troll = computePrices(zeros([1000, 13, 13, 0, 0]), {}, P);
    expect([...troll.outlierIds]).toEqual(['o0']);
    expect(troll.conservative?.valueScrap).toBe(13);
    // 12 against the positive median (11 + 7) / 2 = 9 is an outlier; 11 is not.
    expect(computePrices(zeros([12, 11, 7, 7, 0]), {}, P).conservative?.valueScrap).toBe(11);
  });

  it('keeps an all-zero book as it is: the only exit is a weapon-priced order', () => {
    const r = computePrices(zeros([0, 0, 0]), {}, P);
    expect(r.conservative?.valueScrap).toBe(0);
    expect(r.outlierIds.size).toBe(0);
    expect(r.ref).toBeNull();
  });
});

describe('the engine row on a stale book (F21)', () => {
  it('prices The Bitter Taste of Defeat and Lime on the fresh order: below threshold, not profitable', () => {
    const price: ScrapPrice = {
      id: 1,
      sku: '5054;6',
      name: 'The Bitter Taste of Defeat and Lime',
      costKeys: 0,
      costScrap: 874,
      source: 'import',
      observedAt: T0 - MIN,
      note: null,
      importBatch: null,
      special: null,
      assetId: null,
      stock: null,
    };
    const input = explicitInput(price)!;
    const opp = evaluateOpportunity({
      input,
      listings: [at('r2d2', 964, 145 * HOUR, { sku: '5054;6', baseSku: '5054;6', isBot: true }), at('bombino', 928, 16 * HOUR, { sku: '5054;6', baseSku: '5054;6', isBot: true })],
      references: { pricedb: null, community: null },
      category: 'other',
      isUnusual: false,
      settings: DEFAULT_SETTINGS,
      keyScrap: K,
      now: T0,
      match: matchContext(DEFAULT_SETTINGS, T0),
      prev: null,
    });
    expect(opp.revenueScrap).toBe(928);
    expect(opp.profitScrap).toBe(54);
    expect(opp.status).toBe('below-threshold');
    expect(opp.bestOrder?.listingId).toBe('r2d2');
    expect(opp.bestOrder?.flags).toContain('unverified');
    expect(opp.consOrder?.listingId).toBe('bombino');
    // The revenue order is verified, so the row is not 'unverified-orders'.
    expect(opp.flags).not.toContain('unverified-orders');
  });
});
