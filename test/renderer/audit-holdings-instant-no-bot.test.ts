// 0.7.3: Holdings read "no revenue but buyers" as "every order looks unrealistic", and the No buyers
// help said there is no eligible buy order. With Revenue used for profit set to Instant (the best
// realistic bot order), a book of human buyers only also has no revenue, with no outlier at all.
// The row's own flags tell the cases apart: the service flags 'all-outliers' exactly when every
// eligible order is an outlier. Pure helpers on rows built by the shared holdingRow; no network.

import { describe, expect, it } from 'vitest';
import {
  HOLDING_STATUS_HELP,
  holdingExitView,
  holdingSellsForTitle,
  holdingStatusTitle,
  profitNowTitle,
} from '../../src/renderer/holdingsModel';
import { mockHoldingBuySide, type MockBook } from '../../src/renderer/mockData';
import { bookFlags } from '../../src/service/domain/engine';
import { computePrices, pickRevenueOrder, valueOrders, type PriceRefs } from '../../src/service/domain/pricing';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { holdingRow, type HoldingBuySide } from '../../src/shared/holdings';
import { valueScraptfListRow } from '../../src/shared/scraptfList';
import type { JournalPosition, OrderSummary } from '../../src/shared/types';
import { makeListing } from '../domain/helpers';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const KEY = 568;
const P = DEFAULT_SETTINGS.profit;

function order(valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: `l${valueScrap}`,
    steamid: '76561198000000001',
    userName: 'Someone',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: false,
    online: true,
    lastEventAt: T0 - 60_000,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function position(lots: number[]): JournalPosition {
  return {
    sku: '378;6',
    name: 'Team Captain',
    qty: lots.length,
    costScrap: lots.reduce((t, c) => t + c, 0),
    lots: lots.map((costScrap, i) => ({ id: i + 1, ts: T0 - (lots.length - i) * 86_400_000, costScrap, keys: 0, scrap: costScrap, keyPriceScrap: KEY })),
  };
}

/** Instant, two human buyers, no bot: what the service's market entry carries (flags [], no 'all-outliers'). */
function humansOnly(flags: string[] = []): HoldingBuySide {
  return {
    revenueScrap: null,
    bestScrap: 100,
    instantScrap: null,
    revenueOrder: null,
    bestOrder: order(100),
    buyerCount: 2,
    confidence: 40,
    confidenceLevel: 'low',
    flags,
    lastOrderChangeAt: T0,
  };
}

describe('Instant with human buyers only', () => {
  const r = holdingRow(position([90]), 'hats', humansOnly(), P);

  it('does not call the orders unrealistic, and names the Instant setting', () => {
    expect(r).toMatchObject({ status: 'no-buyers', revenueScrap: null, buyerCount: 2, flags: [] });
    const t = holdingSellsForTitle(r, KEY);
    expect(t).not.toMatch(/unrealistic/);
    expect(t).toBe('2 buyers with eligible orders, but no realistic bot order, and Revenue used for profit is Instant (bot orders only), so no sale price is assumed.');
    expect(holdingExitView(r, KEY, T0).title).toBe(t);
  });

  it('the No buyers help and the Profit now tooltip no longer say there is no eligible buy order', () => {
    for (const t of [holdingStatusTitle(r), profitNowTitle(r, KEY, null)]) {
      expect(t).not.toBe(HOLDING_STATUS_HELP['no-buyers']);
      expect(t).not.toContain('No eligible backpack.tf buy order');
      expect(t).toContain('Instant');
    }
  });

  it('beside a fresh scrap.tf exit, says the buyers are not usable instead of absent', () => {
    const list = valueScraptfListRow(
      { sku: '378;6', name: 'Team Captain', sellsKeys: 0, sellsScrap: 120, paysKeys: 0, paysScrap: 100, stock: 1, stockLimit: 3, batchId: 1, observedAt: T0 - 60_000 },
      KEY,
    );
    const s = holdingRow(position([90]), 'hats', humansOnly(), P, KEY, { list, now: T0 });
    expect(s.bestExit).toBe('scraptf');
    const v = holdingExitView(s, KEY, T0);
    expect(v.sub).toEqual({ text: 'no usable backpack.tf buyer', tone: 'muted' });
    expect(v.title).not.toContain('No backpack.tf buyer right now.');
    expect(v.title).toContain('Instant');
  });
});

describe('every eligible order an outlier (flag all-outliers)', () => {
  const r = holdingRow(position([90]), 'hats', humansOnly(['all-outliers']), P);

  it('keeps the unrealistic wording, in the cell and the status help', () => {
    expect(holdingSellsForTitle(r, KEY)).toBe('Every eligible order looks unrealistic, so no sale price is assumed.');
    expect(holdingStatusTitle(r)).toMatch(/unrealistic/);
    expect(profitNowTitle(r, KEY, null)).toMatch(/unrealistic/);
  });
});

describe('no eligible buyer (unchanged)', () => {
  it('keeps the texts exactly', () => {
    const r = holdingRow(position([90]), 'hats', null, P);
    expect(holdingSellsForTitle(r, KEY)).toBe('No eligible backpack.tf buy orders in the live book.');
    expect(holdingStatusTitle(r)).toBe(HOLDING_STATUS_HELP['no-buyers']);
    expect(profitNowTitle(r, KEY, null)).toBe(HOLDING_STATUS_HELP['no-buyers']);
  });
});

describe('the service flags tell the cases apart (what the renderer relies on)', () => {
  function book(values: number[], refs: PriceRefs, isBot = false) {
    const eligible = valueOrders(
      values.map((v, i) => ({ listing: makeListing({ id: `o${i}`, metalScrap: v, isBot }), eligible: true, flags: [] })),
      KEY,
    );
    return { eligible, prices: computePrices(eligible, refs, P) };
  }

  it('Instant with humans only: no revenue, no all-outliers flag; every order an outlier: the flag', () => {
    const humans = book([100, 95], { pricedbSellScrap: 110 });
    expect(pickRevenueOrder(humans.prices, 'instant')).toBeNull();
    expect(bookFlags(humans, [], null, KEY)).not.toContain('all-outliers');
    const outliers = book([400, 380], { pricedbSellScrap: 100 });
    expect(pickRevenueOrder(outliers.prices, 'conservative')).toBeNull();
    expect(bookFlags(outliers, [], null, KEY)).toContain('all-outliers');
  });

  it("the browser mock's holdings carry all-outliers too (else a mock Conservative row would read as Instant)", () => {
    const book = (buy: OrderSummary[]): MockBook => ({
      item: { sku: '378;6', name: 'Team Captain', category: 'hats', value: 100 },
      buy,
      sell: [],
      // Both orders are over 1.5 × the fresh PriceDB sell price of 100.
      references: { pricedb: { buyScrap: 90, sellScrap: 100, time: Math.floor(T0 / 1000), ageMs: 0 }, community: null },
      history: [],
      meta: new Map(),
      snapshotAt: null,
    });
    const outliers = mockHoldingBuySide(book([order(400, { listingId: 'a' }), order(380, { listingId: 'b', steamid: '76561198000000002' })]), DEFAULT_SETTINGS, KEY, T0);
    expect(outliers).toMatchObject({ revenueScrap: null, buyerCount: 2 });
    expect(outliers!.flags).toContain('all-outliers');
    const realistic = mockHoldingBuySide(book([order(120, { listingId: 'a' })]), DEFAULT_SETTINGS, KEY, T0);
    expect(realistic?.revenueScrap).toBe(120);
    expect(realistic!.flags).not.toContain('all-outliers');
  });
});
