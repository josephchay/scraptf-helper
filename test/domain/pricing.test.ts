import { describe, expect, it } from 'vitest';
import type { CommunityRow, Listing, PricedbRow } from '../../src/shared/types';
import {
  COMMUNITY_MIN_MAX_AGE_MS,
  DEFAULT_REFERENCE_MAX_AGE_MS,
  communityScrap,
  computePrices,
  hasReferenceValue,
  lookupReferences,
  median,
  outlierRefs,
  pickRevenueOrder,
  referencePrices,
  refreshReferenceAge,
  toOrderSummary,
  usableReferences,
  valueOrders,
} from '../../src/service/domain/pricing';
import { confidenceLevel, minProfitFor, profitStatus, profitTier } from '../../src/service/domain/tiers';
import { HOUR, T0, makeListing, testSettings } from './helpers';

const K = 567;
const P = testSettings().profit;

function orders(values: number[], over: (i: number) => Partial<Listing> = () => ({})) {
  return valueOrders(
    values.map((v, i) => ({ listing: makeListing({ id: `o${i}`, steamid: `S${i}`, metalScrap: v, ...over(i) }), eligible: true, flags: [] })),
    K,
  );
}

describe('valueOrders', () => {
  it('values keys with the key price and sorts best first', () => {
    const v = valueOrders(
      [
        { listing: makeListing({ id: 'a', keys: 0, metalScrap: 500 }) },
        { listing: makeListing({ id: 'b', keys: 1, metalScrap: 9 }) },
        { listing: makeListing({ id: 'c', keys: 0.5, metalScrap: 0 }) },
      ],
      K,
    );
    expect(v.map((o) => [o.listing.id, o.valueScrap])).toEqual([
      ['b', 576],
      ['a', 500],
      ['c', 284],
    ]);
  });

  it('breaks value ties by bot, then recency, then id', () => {
    const v = valueOrders(
      [
        { listing: makeListing({ id: 'h-old', metalScrap: 90, lastEventAt: T0 - HOUR }) },
        { listing: makeListing({ id: 'h-new', metalScrap: 90, lastEventAt: T0 }) },
        { listing: makeListing({ id: 'bot', metalScrap: 90, isBot: true, lastEventAt: T0 - 2 * HOUR }) },
      ],
      K,
    );
    expect(v.map((o) => o.listing.id)).toEqual(['bot', 'h-new', 'h-old']);
  });

  it('treats non-finite prices as zero', () => {
    const v = valueOrders([{ listing: makeListing({ keys: Number.NaN, metalScrap: 10 }) }], K);
    expect(v[0]!.valueScrap).toBe(10);
  });
});

describe('median', () => {
  it('handles odd, even and empty input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('computePrices (brief §5.5)', () => {
  it('uses the top order when there is nothing to compare', () => {
    const r = computePrices(orders([120, 100]), {}, P);
    expect(r.best?.valueScrap).toBe(120);
    expect(r.conservative?.valueScrap).toBe(120);
    expect(r.outlierIds.size).toBe(0);
    expect(r.ref).toBe(110);
  });

  it('only applies the median rule from three orders on', () => {
    expect(computePrices(orders([300, 100]), {}, P).outlierIds.size).toBe(0);
    const r = computePrices(orders([300, 100, 100]), {}, P);
    expect([...r.outlierIds]).toEqual(['o0']);
    expect(r.best?.valueScrap).toBe(300);
    expect(r.conservative?.valueScrap).toBe(100);
  });

  it('takes the median over the top five only', () => {
    // top five 200,100,100,100,100 -> median 100 -> 200 > 130
    const r = computePrices(orders([200, 100, 100, 100, 100, 10, 10, 10]), {}, P);
    expect(r.ref).toBe(100);
    expect([...r.outlierIds]).toEqual(['o0']);
    // exactly 1.3x is not an outlier
    expect(computePrices(orders([130, 100, 100]), {}, P).outlierIds.size).toBe(0);
  });

  it('marks orders above 1.5x the PriceDB sell price, even alone', () => {
    const r = computePrices(orders([160]), { pricedbSellScrap: 100 }, P);
    expect(r.outlierIds.has('o0')).toBe(true);
    expect(r.conservative).toBeNull();
    expect(computePrices(orders([150]), { pricedbSellScrap: 100 }, P).conservative?.valueScrap).toBe(150);
  });

  it('marks orders above 1.5x the community high price', () => {
    const r = computePrices(orders([200, 140, 120]), { communityHighScrap: 100 }, P);
    expect([...r.outlierIds]).toEqual(['o0']);
    expect(r.conservative?.valueScrap).toBe(140);
  });

  it('skips several outliers to reach the conservative price', () => {
    const r = computePrices(orders([400, 390, 100, 100, 100]), {}, P);
    expect([...r.outlierIds].sort()).toEqual(['o0', 'o1']);
    expect(r.conservative?.valueScrap).toBe(100);
  });

  it('picks the best non-outlier bot order as instant', () => {
    const r = computePrices(
      orders([400, 110, 105, 100], (i) => ({ isBot: i === 0 || i === 2 })),
      {},
      P,
    );
    expect(r.best?.listing.id).toBe('o0');
    expect(r.conservative?.listing.id).toBe('o1');
    expect(r.instant?.listing.id).toBe('o2');
  });

  it('has no instant price without bots', () => {
    expect(computePrices(orders([100, 90]), {}, P).instant).toBeNull();
  });

  it('respects configured multipliers and ignores broken ones', () => {
    expect(computePrices(orders([120, 100, 100]), {}, { outlierVsMedian: 1.1, outlierVsRef: 1.5 }).outlierIds.size).toBe(1);
    expect(computePrices(orders([120, 100, 100]), {}, { outlierVsMedian: Number.NaN, outlierVsRef: -1 }).outlierIds.size).toBe(0);
  });

  it('returns nulls for no orders', () => {
    const r = computePrices([], { pricedbSellScrap: 10 }, P);
    expect(r).toMatchObject({ best: null, conservative: null, instant: null, ref: null });
  });
});

describe('order summaries', () => {
  it('copies listing facts and merges extra flags', () => {
    const [o] = valueOrders([{ listing: makeListing({ id: 'x', keys: 1, metalScrap: 3, userOnline: true, isBot: true }), eligible: true, flags: ['notes-flag'] }], K);
    const s = toOrderSummary(o!, ['outlier', 'notes-flag']);
    expect(s).toMatchObject({ listingId: 'x', keys: 1, metalScrap: 3, valueScrap: 570, isBot: true, online: true, eligible: true, flags: ['notes-flag', 'outlier'] });
  });

  it('truncates long notes', () => {
    const [o] = valueOrders([{ listing: makeListing({ details: 'x'.repeat(1000) }) }], K);
    expect(toOrderSummary(o!).details.length).toBe(300);
  });
});

describe('reference prices', () => {
  const pdb: PricedbRow = { sku: '378;6', name: 'Team Captain', buyKeys: 1, buyScrap: 9, sellKeys: 1, sellScrap: 45, time: (T0 - HOUR) / 1000, fetchedAt: T0 };

  it('values PriceDB and community prices with the key price', () => {
    const comm: CommunityRow = { sku: '378;6', currency: 'keys', value: 1.5, valueHigh: 2, lastUpdate: 1 };
    const r = referencePrices({ pricedb: pdb, community: comm }, K, T0);
    expect(r.pricedb).toEqual({ buyScrap: 576, sellScrap: 612, time: pdb.time, ageMs: HOUR });
    expect(r.community).toEqual({ valueScrap: 851, valueHighScrap: 1134, lastUpdate: 1 });
    expect(outlierRefs(r)).toEqual({ pricedbSellScrap: 612, communityHighScrap: 1134 });
  });

  it('converts metal, refuses USD and treats a single community price as its own high', () => {
    expect(communityScrap('metal', 1.33, K)).toBe(12);
    expect(communityScrap('usd', 5, K)).toBeNull();
    expect(communityScrap('keys', 0, K)).toBeNull();
    const r = referencePrices({ pricedb: null, community: { sku: 'x', currency: 'metal', value: 2, valueHigh: null, lastUpdate: null } }, K, T0);
    expect(outlierRefs(r).communityHighScrap).toBe(18);
    expect(referencePrices({ pricedb: null, community: { sku: 'x', currency: 'usd', value: 2, valueHigh: 3, lastUpdate: null } }, K, T0).community).toBeNull();
  });

  it('drops an empty PriceDB row and falls back to fetchedAt for the age', () => {
    expect(referencePrices({ pricedb: { ...pdb, buyKeys: 0, buyScrap: 0, sellKeys: 0, sellScrap: 0 }, community: null }, K, T0).pricedb).toBeNull();
    const r = referencePrices({ pricedb: { ...pdb, time: 0, fetchedAt: T0 - 5000 }, community: null }, K, T0);
    expect(r.pricedb).toMatchObject({ time: null, ageMs: 5000 });
  });

  it('recomputes the PriceDB age at read time', () => {
    const r = referencePrices({ pricedb: pdb, community: null }, K, T0);
    expect(refreshReferenceAge(r, T0 + HOUR).pricedb?.ageMs).toBe(2 * HOUR);
  });

  it('looks PriceDB up under the canonical v3 SKU, then the alias, then legacy', () => {
    // v3 puts the craft number before "uncraftable"; PriceDB keys use the legacy order.
    const rows = new Map<string, PricedbRow>([['160;3;uncraftable;n4', { ...pdb, sku: '160;3;uncraftable;n4' }]]);
    const repo = {
      getSkuAlias: (s: string) => (s === '378;6' ? 'alias-378' : null),
      getPricedb: (s: string) => rows.get(s) ?? (s === 'alias-378' ? { ...pdb, sku: 'alias-378' } : null),
      getCommunity: (s: string) => (s === '378;6' ? { sku: s, currency: 'metal', value: 1, valueHigh: null, lastUpdate: null } : null),
    };
    expect(lookupReferences(repo, '378;6').pricedb?.sku).toBe('alias-378');
    expect(lookupReferences(repo, '378;6').community?.sku).toBe('378;6');
    expect(lookupReferences(repo, '160;3;n4;uncraftable').pricedb?.sku).toBe('160;3;uncraftable;n4');
    expect(lookupReferences(repo, '1;6').pricedb).toBeNull();
    // pricedb.ts stores rows under the canonical SKU even when an alias is recorded.
    rows.set('378;6', { ...pdb, sku: '378;6' });
    expect(lookupReferences(repo, '378;6').pricedb?.sku).toBe('378;6');
  });
});

describe('tiers and thresholds (brief §5.6)', () => {
  it.each([
    [null, 'none'],
    [-5, 'loss'],
    [0, 'loss'],
    [1, 'small'],
    [17, 'small'],
    [18, 'ref2'],
    [89, 'ref2'],
    [90, 'ref10'],
    [566, 'ref10'],
    [567, 'key'],
    [5000, 'key'],
  ] as const)('profit %s -> %s', (profit, tier) => {
    expect(profitTier(profit, K)).toBe(tier);
  });

  it('ignores a broken key price for the key tier', () => {
    expect(profitTier(1000, 0)).toBe('ref10');
  });

  it('minimum profit is max(minProfitScrap, ceil(pct x cost))', () => {
    expect(minProfitFor(100, P)).toBe(9);
    expect(minProfitFor(181, P)).toBe(10);
    expect(minProfitFor(1000, P)).toBe(50);
    expect(minProfitFor(-50, P)).toBe(9);
  });

  it('classifies status', () => {
    expect(profitStatus(null, 100, P)).toBe('no-buyers');
    expect(profitStatus(0, 100, P)).toBe('unprofitable');
    expect(profitStatus(-3, 100, P)).toBe('unprofitable');
    expect(profitStatus(8, 100, P)).toBe('below-threshold'); // under 9 scrap
    expect(profitStatus(9, 100, P)).toBe('profitable'); // 9% margin
    expect(profitStatus(49, 1000, P)).toBe('below-threshold'); // under 5% of cost
    expect(profitStatus(50, 1000, P)).toBe('below-threshold'); // margin 5% < 8%
    expect(profitStatus(80, 1000, P)).toBe('profitable');
    expect(profitStatus(9, 0, P)).toBe('profitable'); // free item: margin is unbounded
  });

  it('maps scores to levels', () => {
    expect(confidenceLevel(100)).toBe('high');
    expect(confidenceLevel(70)).toBe('high');
    expect(confidenceLevel(69)).toBe('medium');
    expect(confidenceLevel(45)).toBe('medium');
    expect(confidenceLevel(44)).toBe('low');
    expect(confidenceLevel(0)).toBe('low');
  });
});

describe('reference age gate (F4) and the revenue pick', () => {
  const DAY = 24 * HOUR;

  it('drops PriceDB and community prices older than the limit, with a reason each', () => {
    const refs = {
      pricedb: { buyScrap: 15, sellScrap: 18, time: 1, ageMs: 31 * DAY },
      community: { valueScrap: 20, valueHighScrap: 25, lastUpdate: Math.floor((T0 - 400 * DAY) / 1000) },
    };
    const r = usableReferences(refs, 30 * DAY, T0);
    expect(r.references).toEqual({ pricedb: null, community: null });
    expect(r.stale).toEqual(['PriceDB price is 31 days old, ignored', 'Community price is 400 days old, ignored']);
    expect(outlierRefs(r.references)).toEqual({ pricedbSellScrap: null, communityHighScrap: null });
    expect(hasReferenceValue(r.references)).toBe(false);

    const kept = usableReferences(refs, 450 * DAY, T0);
    expect(kept.references).toBe(refs);
    expect(kept.stale).toEqual([]);
  });

  it('gives community prices at least a year whatever the PriceDB limit', () => {
    const at = (days: number) => ({ pricedb: null, community: { valueScrap: 20, valueHighScrap: null, lastUpdate: Math.floor((T0 - days * DAY) / 1000) } });
    expect(COMMUNITY_MIN_MAX_AGE_MS).toBe(365 * DAY);
    expect(usableReferences(at(200), 30 * DAY, T0).stale).toEqual([]);
    expect(usableReferences(at(366), 30 * DAY, T0).stale).toEqual(['Community price is 366 days old, ignored']);
    expect(usableReferences(at(366), 400 * DAY, T0).stale).toEqual([]);
  });

  it('keeps references of unknown or exact age, and uses 30 days when the setting is broken', () => {
    const refs = { pricedb: { buyScrap: 15, sellScrap: 18, time: null, ageMs: null }, community: { valueScrap: 20, valueHighScrap: null, lastUpdate: null } };
    expect(usableReferences(refs, 0, T0).references).toBe(refs);
    const exact = { pricedb: { buyScrap: 15, sellScrap: 18, time: null, ageMs: 30 * DAY }, community: null };
    expect(usableReferences(exact, 30 * DAY, T0).stale).toEqual([]);
    expect(usableReferences(exact, 30 * DAY - 1, T0).stale).toHaveLength(1);
    expect(DEFAULT_REFERENCE_MAX_AGE_MS).toBe(P.referenceMaxAgeMs);
    for (const broken of [Number.NaN, -1, undefined]) {
      expect(usableReferences({ ...exact, pricedb: { ...exact.pricedb, ageMs: 31 * DAY } }, broken, T0).stale).toHaveLength(1);
      expect(usableReferences(exact, broken, T0).stale).toHaveLength(0);
    }
  });

  it('counts any positive PriceDB or community value as a reference', () => {
    expect(hasReferenceValue({ pricedb: null, community: null })).toBe(false);
    expect(hasReferenceValue({ pricedb: { buyScrap: null, sellScrap: 0, time: null, ageMs: null }, community: null })).toBe(false);
    expect(hasReferenceValue({ pricedb: { buyScrap: null, sellScrap: 5, time: null, ageMs: null }, community: null })).toBe(true);
    expect(hasReferenceValue({ pricedb: null, community: { valueScrap: null, valueHighScrap: 9, lastUpdate: null } })).toBe(true);
  });

  it('picks the revenue order per useOrder', () => {
    const prices = { best: 'b', conservative: 'c', instant: 'i' };
    expect(pickRevenueOrder(prices, 'best')).toBe('b');
    expect(pickRevenueOrder(prices, 'conservative')).toBe('c');
    expect(pickRevenueOrder(prices, 'instant')).toBe('i');
  });
});
