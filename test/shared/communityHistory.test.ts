// 0.9 (history, RESEARCH #7): recorded backpack.tf community prices (src/shared/communityHistory.ts). The IGetPrices
// rows an answer replaces become history (H7), the drawer's steps join twin SKUs and both sources, and the shared
// valuing rule is pricing.ts's communityScrap exactly (H12). Community prices are accepted price suggestions, never
// sales. Pure.

import { describe, expect, it } from 'vitest';
import { communityScrap } from '../../src/service/domain/pricing';
import {
  COMMUNITY_CURRENCY_MAX,
  COMMUNITY_FEED_MEMO_MAX,
  COMMUNITY_HISTORY_DETAIL_MAX,
  COMMUNITY_NOTE,
  communityHighOf,
  communityHistoryOf,
  communityHistoryPointsOf,
  communityPointKey,
  communityValueScrap,
  sameCommunityPrice,
} from '../../src/shared/communityHistory';
import type { CommunityPoint, CommunityRow } from '../../src/shared/types';

const T = 1_792_000_000_000;
const row = (sku: string, value: number, over: Partial<CommunityRow> = {}): CommunityRow => ({ sku, currency: 'metal', value, valueHigh: null, lastUpdate: 1_791_000_000, ...over });
const point = (over: Partial<CommunityPoint> = {}): CommunityPoint => ({
  sku: '378;6',
  source: 'prices',
  currency: 'metal',
  value: 11.55,
  valueHigh: null,
  lastUpdate: 1_791_000_000,
  recordedAt: T,
  ...over,
});

describe('the constants and the note', () => {
  it('caps the memo and the currency, and says what the prices are', () => {
    expect(COMMUNITY_FEED_MEMO_MAX).toBe(20_000);
    expect(COMMUNITY_CURRENCY_MAX).toBe(16);
    expect(COMMUNITY_NOTE).toMatch(/accepted price suggestions, not sales/);
    expect(COMMUNITY_NOTE).toMatch(/live feed/);
  });
});

describe('sameCommunityPrice and communityPointKey', () => {
  it('compare currency (case aside), value, valueHigh and lastUpdate, null-safe', () => {
    expect(sameCommunityPrice(row('a', 1), row('b', 1))).toBe(true);
    expect(sameCommunityPrice(row('a', 1, { currency: 'Metal' }), row('a', 1))).toBe(true);
    expect(sameCommunityPrice(row('a', 1), row('a', 1.01))).toBe(false);
    expect(sameCommunityPrice(row('a', 1, { valueHigh: 2 }), row('a', 1))).toBe(false);
    expect(sameCommunityPrice(row('a', 1, { lastUpdate: null }), row('a', 1))).toBe(false);
    expect(sameCommunityPrice(row('a', 1, { lastUpdate: null }), row('a', 1, { lastUpdate: null }))).toBe(true);
    expect(sameCommunityPrice(row('a', 1, { currency: 'keys' }), row('a', 1))).toBe(false);
    expect(communityPointKey(row('a', 1.5, { valueHigh: 2 }))).toBe('metal|1.5|2|1791000000');
    expect(communityPointKey(row('a', 3, { currency: 'KEYS', lastUpdate: null }))).toBe('keys|3||');
  });

  it('read a high equal to the low as no range (the feed sends one, IGetPrices leaves value_high out)', () => {
    expect(communityHighOf({ value: 62.11, valueHigh: 62.11 })).toBeNull();
    expect(communityHighOf({ value: 62.11, valueHigh: null })).toBeNull();
    expect(communityHighOf({ value: 62.11, valueHigh: Number.NaN })).toBeNull();
    expect(communityHighOf({ value: 62.11, valueHigh: 70 })).toBe(70);
    expect(sameCommunityPrice(row('a', 62.11, { valueHigh: 62.11 }), row('a', 62.11))).toBe(true);
    expect(communityPointKey(row('a', 62.11, { valueHigh: 62.11 }))).toBe(communityPointKey(row('a', 62.11)));
    expect(communityPointKey(row('a', 62.11, { valueHigh: 62.11 }))).toBe('metal|62.11||1791000000');
  });
});

describe('communityHistoryPointsOf (H7)', () => {
  const opts = { delta: true, recordedAt: T };

  it('keeps nothing for an unchanged row and [stored, incoming] for a changed one', () => {
    const before = new Map([['378;6', row('378;6', 11.55)]]);
    expect(communityHistoryPointsOf(before, [row('378;6', 11.55)], opts)).toEqual([]);
    const changed = row('378;6', 12, { lastUpdate: 1_791_100_000 });
    expect(communityHistoryPointsOf(before, [changed], opts)).toEqual([
      { sku: '378;6', source: 'prices', currency: 'metal', value: 11.55, valueHigh: null, lastUpdate: 1_791_000_000, recordedAt: T },
      { sku: '378;6', source: 'prices', currency: 'metal', value: 12, valueHigh: null, lastUpdate: 1_791_100_000, recordedAt: T },
    ]);
    // A full fetch keeps the replaced price too.
    expect(communityHistoryPointsOf(before, [changed], { delta: false, recordedAt: T })).toHaveLength(2);
  });

  it('keeps a new SKU on a delta only: a full fetch with nothing stored is the first fetch (no baseline yet)', () => {
    expect(communityHistoryPointsOf(new Map(), [row('126;6', 2)], opts)).toEqual([
      { sku: '126;6', source: 'prices', currency: 'metal', value: 2, valueHigh: null, lastUpdate: 1_791_000_000, recordedAt: T },
    ]);
    expect(communityHistoryPointsOf(new Map(), [row('126;6', 2)], { delta: false, recordedAt: T })).toEqual([]);
  });

  it('skips bad rows, and lower-cases and cuts the currency', () => {
    const bad = [row('', 1), row('a', Number.NaN), row('b', -1), row('c', Number.POSITIVE_INFINITY), null as unknown as CommunityRow];
    expect(communityHistoryPointsOf(new Map(), bad, opts)).toEqual([]);
    const odd = communityHistoryPointsOf(new Map(), [row('d', 0, { currency: '  A-Very-Long-Currency-Name ', valueHigh: Number.NaN, lastUpdate: Number.NaN })], opts);
    expect(odd).toEqual([{ sku: 'd', source: 'prices', currency: 'a-very-long-curr', value: 0, valueHigh: null, lastUpdate: null, recordedAt: T }]);
  });
});

describe('communityHistoryOf', () => {
  it('joins twin SKUs and both sources into one step (sources sorted, the earliest recordedAt)', () => {
    const h = communityHistoryOf(
      [point({ recordedAt: T + 50 }), point({ sku: '378;600', source: 'feed', recordedAt: T + 10 }), point({ source: 'feed', recordedAt: T + 99 })],
      null,
    );
    expect(h).toEqual({
      steps: [{ at: 1_791_000_000_000, currency: 'metal', value: 11.55, valueHigh: null, lastUpdate: 1_791_000_000, sources: ['feed', 'prices'], recordedAt: T + 10 }],
      since: T + 10,
      recorded: 3,
    });
  });

  it('makes one step of a price the feed sent with valueHigh = value and IGetPrices without value_high (review)', () => {
    const at = 1_791_000_000;
    const fromFeed = point({ source: 'feed', value: 62.11, valueHigh: 62.11, lastUpdate: at, recordedAt: T + 20 });
    const fromPrices = point({ value: 62.11, valueHigh: null, lastUpdate: at, recordedAt: T + 10 });
    const stored = row('378;6', 62.11, { valueHigh: null, lastUpdate: at });
    const both = communityHistoryOf([fromPrices, fromFeed], stored);
    expect(both.steps).toEqual([{ at: at * 1000, currency: 'metal', value: 62.11, valueHigh: null, lastUpdate: at, sources: ['feed', 'prices'], recordedAt: T + 10 }]);
    // Feed points only: the stored IGetPrices row is that price, not a second step "backpack.tf now".
    const feedOnly = communityHistoryOf([fromFeed], stored);
    expect(feedOnly.steps).toEqual([{ at: at * 1000, currency: 'metal', value: 62.11, valueHigh: null, lastUpdate: at, sources: ['feed'], recordedAt: T + 20 }]);
    // The other way round: a stored row with a high equal to its low.
    expect(communityHistoryOf([fromPrices], row('378;6', 62.11, { valueHigh: 62.11, lastUpdate: at })).steps).toHaveLength(1);
    // A real range stays a range.
    expect(communityHistoryOf([point({ value: 1, valueHigh: 2 })], null).steps[0]!.valueHigh).toBe(2);
  });

  it('appends the current price (recordedAt null) only when it is new and dated', () => {
    const points = [point()];
    expect(communityHistoryOf(points, row('378;6', 11.55)).steps).toHaveLength(1);
    expect(communityHistoryOf(points, row('378;6', 12, { lastUpdate: null })).steps).toHaveLength(1);
    const h = communityHistoryOf(points, row('378;6', 12, { lastUpdate: 1_791_500_000 }));
    expect(h.steps.map((s) => [s.value, s.recordedAt, s.sources])).toEqual([
      [11.55, T, ['prices']],
      [12, null, ['prices']],
    ]);
    expect(h.recorded).toBe(1);
    // With nothing recorded, the current price alone, and no since.
    expect(communityHistoryOf([], row('378;6', 12))).toMatchObject({ steps: [{ value: 12, recordedAt: null }], since: null, recorded: 0 });
  });

  it('dates a step by lastUpdate, else when it was recorded; orders by that, then recordedAt (null last); keeps the newest 200', () => {
    const h = communityHistoryOf(
      [point({ value: 1, lastUpdate: null, recordedAt: T + 5_000 }), point({ value: 2, lastUpdate: 1_791_000_000 }), point({ value: 3, lastUpdate: (T + 5_000) / 1000, recordedAt: T + 1 })],
      row('378;6', 4, { lastUpdate: (T + 5_000) / 1000 }),
    );
    expect(h.steps.map((s) => s.value)).toEqual([2, 3, 1, 4]);
    const many = Array.from({ length: COMMUNITY_HISTORY_DETAIL_MAX + 30 }, (_, i) => point({ value: i + 1, lastUpdate: 1_700_000_000 + i }));
    const capped = communityHistoryOf(many, null);
    expect(capped.steps).toHaveLength(COMMUNITY_HISTORY_DETAIL_MAX);
    expect(capped.steps[0]!.value).toBe(31);
    expect(capped.steps.at(-1)!.value).toBe(COMMUNITY_HISTORY_DETAIL_MAX + 30);
    expect(capped.recorded).toBe(COMMUNITY_HISTORY_DETAIL_MAX + 30);
  });
});

describe("communityValueScrap is pricing.ts's communityScrap (H12)", () => {
  it('agrees over metal, keys with and without a key price, usd, hat, 0, negative, NaN and null', () => {
    const cases: [string, number | null, number][] = [
      ['metal', 11.55, 500],
      ['Metal', 0.11, 0],
      ['keys', 1.5, 577],
      ['keys', 1.5, 0],
      ['keys', 1.5, Number.NaN],
      ['keys', 2, -3],
      ['usd', 3.2, 577],
      ['hat', 1, 577],
      ['metal', 0, 577],
      ['metal', -1, 577],
      ['metal', Number.NaN, 577],
      ['metal', null, 577],
      ['keys', Number.POSITIVE_INFINITY, 577],
    ];
    for (const [c, v, k] of cases) expect(communityValueScrap(c, v, k), `${c} ${v} ${k}`).toBe(communityScrap(c, v, k));
    expect(communityValueScrap('keys', 1.5, null)).toBeNull();
    expect(communityValueScrap('metal', 1.33, null)).toBe(12);
  });
});
