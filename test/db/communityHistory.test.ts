// 0.9 (history, RESEARCH #7, schema V16): recorded backpack.tf community prices (bptf_community_history). A
// community price is a price suggestion backpack.tf accepted, never a sale. One row per distinct price per SKU and
// source (the unique expression index folds NULLs), the currency lower case and short; read newest first by
// recorded_at and returned oldest first; pruned by age, per SKU and in all. communityFor reads the current rows
// (bptf_community) of many SKUs at once.

import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { MAX_IN_PARAMS } from '../../src/service/db/db';
import {
  COMMUNITY_CURRENCY_MAX,
  COMMUNITY_HISTORY_DETAIL_MAX,
  COMMUNITY_HISTORY_MAX_AGE_MS,
  COMMUNITY_HISTORY_MAX_ROWS,
  COMMUNITY_HISTORY_PER_SKU_MAX,
} from '../../src/shared/communityHistory';
import type { CommunityPoint, CommunityRow } from '../../src/shared/types';

const T0 = 1_792_496_380_093;
const DAY = 86_400_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repo(): Repo {
  const r = openRepo(':memory:');
  cleanups.push(() => r.close());
  return r;
}

const point = (over: Partial<CommunityPoint> = {}): CommunityPoint => ({
  sku: '378;6',
  source: 'prices',
  currency: 'metal',
  value: 1.33,
  valueHigh: null,
  lastUpdate: null,
  recordedAt: T0,
  ...over,
});

describe('communityFor: the current community rows of many SKUs', () => {
  it('reads past one IN list (chunked by MAX_IN_PARAMS); absent SKUs have none', () => {
    const r = repo();
    const rows: CommunityRow[] = Array.from({ length: MAX_IN_PARAMS + 100 }, (_, i) => ({ sku: `${1000 + i};6`, currency: 'metal', value: i, valueHigh: null, lastUpdate: 1_792_000_000 + i }));
    r.upsertCommunity(rows);
    const asked = [...rows.map((c) => c.sku), 'nope;6', rows[0]!.sku];
    const got = r.communityFor(asked);
    expect(got.size).toBe(rows.length);
    expect(got.get(`${1000 + MAX_IN_PARAMS + 50};6`)).toEqual(rows[MAX_IN_PARAMS + 50]);
    expect(got.has('nope;6')).toBe(false);
    expect(r.communityFor([]).size).toBe(0);
  });
});

describe('insertCommunityHistory: one row per distinct price per SKU and source', () => {
  it('writes the same point once (NULL high and NULL time included), another source or price again', () => {
    const r = repo();
    expect(r.insertCommunityHistory([point(), point({ recordedAt: T0 + 1 })])).toBe(1);
    expect(r.insertCommunityHistory([point({ recordedAt: T0 + 2 })])).toBe(0);
    expect(r.insertCommunityHistory([point({ source: 'feed', recordedAt: T0 + 3 })])).toBe(1);
    expect(r.insertCommunityHistory([point({ valueHigh: 1.44, recordedAt: T0 + 4 }), point({ valueHigh: 1.44, recordedAt: T0 + 5 })])).toBe(1);
    expect(r.insertCommunityHistory([point({ lastUpdate: 1_792_400_000, recordedAt: T0 + 6 }), point({ value: 1.44, recordedAt: T0 + 7 })])).toBe(2);
    expect(r.communityHistory(['378;6'])).toEqual([
      point(),
      point({ source: 'feed', recordedAt: T0 + 3 }),
      point({ valueHigh: 1.44, recordedAt: T0 + 4 }),
      point({ lastUpdate: 1_792_400_000, recordedAt: T0 + 6 }),
      point({ value: 1.44, recordedAt: T0 + 7 }),
    ]);
  });

  it('stores a high equal to the low as NULL, so a price with and without value_high is one row (review)', () => {
    const r = repo();
    expect(r.insertCommunityHistory([point({ source: 'feed', value: 62.11, valueHigh: 62.11, lastUpdate: 1_791_000_000 })])).toBe(1);
    expect(r.insertCommunityHistory([point({ source: 'feed', value: 62.11, valueHigh: null, lastUpdate: 1_791_000_000, recordedAt: T0 + 1 })])).toBe(0);
    expect(r.communityHistory(['378;6'])).toEqual([point({ source: 'feed', value: 62.11, valueHigh: null, lastUpdate: 1_791_000_000 })]);
  });

  it(`lower-cases the currency and cuts it to ${COMMUNITY_CURRENCY_MAX}, so one price never splits by its spelling`, () => {
    const r = repo();
    expect(r.insertCommunityHistory([point({ currency: ' Keys ' }), point({ currency: 'KEYS', recordedAt: T0 + 1 })])).toBe(1);
    expect(r.insertCommunityHistory([point({ currency: 'X'.repeat(40), recordedAt: T0 + 2 })])).toBe(1);
    expect(r.insertCommunityHistory([point({ currency: '', value: 9, recordedAt: T0 + 3 })])).toBe(1);
    expect(r.communityHistory(['378;6']).map((p) => p.currency)).toEqual(['keys', 'x'.repeat(COMMUNITY_CURRENCY_MAX), 'metal']);
  });

  it("skips a point without a SKU, a finite value or a finite time; any source but 'feed' is stored as 'prices'", () => {
    const r = repo();
    const bad = [point({ sku: '' }), point({ sku: '  ' }), point({ value: Number.NaN }), point({ value: Number.POSITIVE_INFINITY }), point({ recordedAt: Number.NaN })];
    expect(r.insertCommunityHistory(bad)).toBe(0);
    expect(r.insertCommunityHistory([point({ source: 'other' as CommunityPoint['source'] })])).toBe(1);
    expect(r.communityHistory(['378;6'])).toEqual([point()]);
    expect(r.insertCommunityHistory([])).toBe(0);
  });
});

describe('communityHistory: newest first by recorded_at, returned oldest first', () => {
  it('reads these SKUs only, keeps the newest `limit` (ties by id), and returns them oldest first', () => {
    const r = repo();
    r.insertCommunityHistory([
      point({ value: 3, recordedAt: T0 + 3 }),
      point({ value: 1, recordedAt: T0 + 1 }),
      point({ value: 2, recordedAt: T0 + 2 }),
      point({ sku: '5021;6', currency: 'keys', value: 70, recordedAt: T0 + 2 }),
      point({ sku: '30469;6', value: 9, recordedAt: T0 }),
    ]);
    expect(r.communityHistory(['378;6']).map((p) => p.value)).toEqual([1, 2, 3]);
    expect(r.communityHistory(['378;6', '5021;6']).map((p) => p.value)).toEqual([1, 2, 70, 3]);
    expect(r.communityHistory(['378;6'], 2).map((p) => p.value)).toEqual([2, 3]);
    expect(r.communityHistory(['378;6'], 0).map((p) => p.value)).toEqual([3]);
    expect(r.communityHistory([])).toEqual([]);
    expect(COMMUNITY_HISTORY_DETAIL_MAX).toBe(200);
  });
});

describe('pruneCommunityHistory: by age, per SKU and in all (by recorded_at)', () => {
  it('drops points older than maxAgeMs', () => {
    const r = repo();
    const now = T0 + 400 * DAY;
    r.insertCommunityHistory([point({ value: 1, recordedAt: now - COMMUNITY_HISTORY_MAX_AGE_MS - 1 }), point({ value: 2, recordedAt: now - DAY })]);
    expect(r.pruneCommunityHistory(now)).toBe(1);
    expect(r.communityHistory(['378;6']).map((p) => p.value)).toEqual([2]);
    expect(r.pruneCommunityHistory(now, { maxAgeMs: DAY / 2 })).toBe(1);
    expect(r.communityHistory(['378;6'])).toEqual([]);
  });

  it('keeps the newest perSkuMax points of each SKU, then the newest maxRows in all', () => {
    const r = repo();
    r.insertCommunityHistory([
      point({ value: 1, recordedAt: T0 + 1 }),
      point({ value: 2, recordedAt: T0 + 2 }),
      point({ value: 3, recordedAt: T0 + 3 }),
      point({ sku: '5021;6', value: 70, recordedAt: T0 + 5 }),
      point({ sku: '5021;6', value: 71, recordedAt: T0 }),
    ]);
    // 378;6's oldest goes; 5021;6 has only two.
    expect(r.pruneCommunityHistory(T0 + DAY, { perSkuMax: 2 })).toBe(1);
    expect(r.communityHistory(['378;6', '5021;6']).map((p) => p.value)).toEqual([71, 2, 3, 70]);
    expect(r.pruneCommunityHistory(T0 + DAY, { maxRows: 1 })).toBe(3);
    expect(r.communityHistory(['378;6', '5021;6']).map((p) => p.value)).toEqual([70]);
    expect(r.pruneCommunityHistory(T0 + DAY)).toBe(0);
  });

  it('defaults: 365 days, 200 per SKU, 300,000 in all', () => {
    expect([COMMUNITY_HISTORY_MAX_AGE_MS, COMMUNITY_HISTORY_PER_SKU_MAX, COMMUNITY_HISTORY_MAX_ROWS]).toEqual([365 * DAY, 200, 300_000]);
    const r = repo();
    r.insertCommunityHistory(Array.from({ length: COMMUNITY_HISTORY_PER_SKU_MAX + 3 }, (_, i) => point({ value: i, recordedAt: T0 + i })));
    expect(r.pruneCommunityHistory(T0 + DAY)).toBe(3);
    expect(r.communityHistory(['378;6'], 5000)[0]!.value).toBe(3);
  });
});
