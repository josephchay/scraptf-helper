// 0.7.3: Record buy… and Quick entry read a null revenue as "no buyer". The service also sends one
// when eligible buyers exist but none is usable: every order looks unrealistically high
// (Conservative, the default), or there is no realistic bot order (Instant). Both now say that,
// with the buyer count, instead of "no eligible backpack.tf buyer". Pure; no network.

import { describe, expect, it } from 'vitest';
import { computePrices } from '../../src/service/domain/pricing';
import { itemRevenue } from '../../src/service/domain/views';
import { ceilingVerdict, noRevenueText, previewRevenue, profitPreview } from '../../src/renderer/quickModel';
import { buyComparison } from '../../src/renderer/recordTradeModel';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { OrderSummary } from '../../src/shared/types';
import { makeListing, testSettings } from '../domain/helpers';

const KEY = 500;
const NO_BUYER = 'No eligible backpack.tf buyer right now, so there is no Pay up to to compare with.';

/** Eligible orders as the service values them (metal only). */
function valued(values: number[], isBot: boolean) {
  return values.map((v, i) => ({ listing: makeListing({ id: `o${i}`, metalScrap: v, isBot }), valueScrap: v }));
}

function summary(valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: `l${valueScrap}`,
    steamid: '76561198000000001',
    userName: 'Buyer',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: true,
    online: true,
    lastEventAt: 0,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

describe('eligible buyers, none usable', () => {
  it('Conservative (the default), every order an outlier: says so with the count, and the verdict is "No usable buyer"', () => {
    const s = testSettings();
    expect(DEFAULT_SETTINGS.profit.useOrder).toBe('conservative');
    // A fresh PriceDB sell price of 50 makes all three outliers (over 1.5 × 50).
    const prices = computePrices(valued([100, 95, 90], true), { pricedbSellScrap: 50, communityHighScrap: null }, s.profit);
    const rev = itemRevenue(prices, 3, s);
    expect(rev).toMatchObject({ revenueScrap: null, eligibleCount: 3, maxCostScrap: null });

    const c = buyComparison(40, { revenue: rev, buyOrders: [] }, s.profit, KEY);
    expect(c).toMatchObject({ buyerCount: 3, tone: 'muted', preview: null, payUpToScrap: null });
    expect(c.text).not.toMatch(/^No eligible backpack\.tf buyer/);
    expect(c.text).toBe('3 buyers, but every eligible order looks unrealistically high, so there is no Pay up to to compare with.');

    expect(ceilingVerdict(profitPreview(40, rev, s.profit), KEY, rev.eligibleCount)).toBe('No usable buyer');
  });

  it('Instant, human buyers only: names the setting instead of claiming there is no buyer', () => {
    const s = testSettings({ profit: { useOrder: 'instant' } });
    const prices = computePrices(valued([100, 98], false), {}, s.profit);
    const rev = itemRevenue(prices, 2, s);
    expect(rev).toMatchObject({ revenueScrap: null, eligibleCount: 2, useOrder: 'instant' });

    const c = buyComparison(40, { revenue: rev, buyOrders: [] }, s.profit, KEY);
    expect(c.buyerCount).toBe(2);
    expect(c.text).not.toMatch(/^No eligible backpack\.tf buyer/);
    expect(c.text).toMatch(/^2 buyers, but none is a realistic bot order, and Revenue used for profit is Instant \(bot orders only\), so there is no Pay up to/);
    expect(ceilingVerdict(profitPreview(40, rev, s.profit), KEY, 2)).toBe('No usable buyer');
  });

  it('reads the same from the book when the service sent no revenue', () => {
    const p = { ...DEFAULT_SETTINGS.profit };
    const d = { revenue: null, buyOrders: [summary(100, { flags: ['outlier'] }), summary(95, { listingId: 'b', flags: ['outlier'] })] };
    const rev = previewRevenue(d, p);
    expect(rev).toMatchObject({ revenueScrap: null, eligibleCount: 2 });
    expect(buyComparison(40, d, p, KEY).text).toBe('2 buyers, but every eligible order looks unrealistically high, so there is no Pay up to to compare with.');
    expect(noRevenueText(rev)).toBe('2 buyers, but every eligible order looks unrealistically high');
  });
});

describe('no eligible buyer at all (unchanged)', () => {
  it('keeps the text and the verdict', () => {
    const s = testSettings();
    const rev = itemRevenue(computePrices([], {}, s.profit), 0, s);
    expect(buyComparison(10, { revenue: rev, buyOrders: [] }, s.profit, KEY).text).toBe(NO_BUYER);
    expect(buyComparison(10, null, s.profit, KEY).text).toBe(NO_BUYER);
    const pv = profitPreview(40, rev, s.profit);
    expect(ceilingVerdict(pv, null)).toBe('No buyer');
    expect(ceilingVerdict(pv, null, 0)).toBe('No buyer');
    expect(noRevenueText(null)).toBe('No eligible backpack.tf buyer right now');
    expect(noRevenueText(rev)).toBe('No eligible backpack.tf buyer right now');
  });
});
