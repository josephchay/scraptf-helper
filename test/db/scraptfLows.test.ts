// 0.9 (history, schema V16): the lowest price on sale each scrap.tf copy showed in the user's saves (scraptf_lows),
// one row per bank, SKU and extras, raw keys + metal (valued at a read's key price, so a key move alone never reads as
// a price move). Written at import from data the user saved (R10); nothing is fetched. Pruned a year after the copy
// was last seen on sale.

import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { SCRAPTF_LOWS_MAX_AGE_MS } from '../../src/shared/scraptfLows';
import type { ScraptfBank, ScraptfLowStored } from '../../src/shared/types';

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

const low = (over: Partial<ScraptfLowStored> = {}): ScraptfLowStored => ({
  bank: 'hats',
  sku: '378;6',
  specialKey: '',
  keys: 0,
  scrap: 80,
  firstAt: T0,
  lastAt: T0 + DAY,
  since: T0 - DAY,
  seenAt: T0 + 2 * DAY,
  ...over,
});

describe('scraptf_lows (0.9, V16)', () => {
  it('upserts by (bank, sku, special_key): a later write of the same copy replaces it', () => {
    const r = repo();
    expect(r.upsertScraptfLows([low(), low({ specialKey: 'p:15185211' }), low({ bank: 'stranges', keys: 1, scrap: 9 })])).toBe(3);
    expect(r.upsertScraptfLows([low({ scrap: 70, firstAt: T0 + 3 * DAY, lastAt: T0 + 3 * DAY, seenAt: T0 + 4 * DAY })])).toBe(1);
    expect(r.scraptfLows('hats')).toEqual([low({ scrap: 70, firstAt: T0 + 3 * DAY, lastAt: T0 + 3 * DAY, seenAt: T0 + 4 * DAY }), low({ specialKey: 'p:15185211' })]);
    expect(r.scraptfLows('stranges')).toEqual([low({ bank: 'stranges', keys: 1, scrap: 9 })]);
  });

  it('reads one bank only, ordered by SKU and extras; [] for a bank with none or an unknown bank', () => {
    const r = repo();
    r.upsertScraptfLows([low({ sku: '5021;6' }), low({ sku: '378;6', specialKey: 'b' }), low({ sku: '378;6', specialKey: 'a' }), low({ bank: 'unusuals' })]);
    expect(r.scraptfLows('hats').map((l) => `${l.sku}|${l.specialKey}`)).toEqual(['378;6|a', '378;6|b', '5021;6|']);
    expect(r.scraptfLows('stranges')).toEqual([]);
    expect(r.scraptfLows('bogus' as ScraptfBank)).toEqual([]);
  });

  it('skips a row with an unknown bank, no SKU or a non-finite price or time; rounds the scrap', () => {
    const r = repo();
    const bad = [
      low({ bank: 'bogus' as ScraptfBank }),
      low({ sku: '' }),
      low({ keys: Number.NaN }),
      low({ scrap: Number.POSITIVE_INFINITY }),
      low({ firstAt: Number.NaN }),
      low({ lastAt: Number.NaN }),
      low({ since: Number.NaN }),
      low({ seenAt: Number.NaN }),
    ];
    expect(r.upsertScraptfLows(bad)).toBe(0);
    expect(r.upsertScraptfLows([])).toBe(0);
    expect(r.upsertScraptfLows([low({ scrap: 80.4 })])).toBe(1);
    expect(r.scraptfLows('hats')).toEqual([low({ scrap: 80 })]);
  });

  it('prunes by seen_at: older than now - maxAgeMs (a year by default) goes', () => {
    const r = repo();
    const now = T0 + 400 * DAY;
    r.upsertScraptfLows([
      low({ sku: 'old', seenAt: now - SCRAPTF_LOWS_MAX_AGE_MS - 1 }),
      // First seen long ago, but still on sale lately: kept.
      low({ sku: 'kept', since: T0 - 300 * DAY, firstAt: T0 - 300 * DAY, seenAt: now - DAY }),
      low({ bank: 'stranges', sku: 'old2', seenAt: now - SCRAPTF_LOWS_MAX_AGE_MS - 1 }),
    ]);
    expect(r.pruneScraptfLows(now)).toBe(2);
    expect(r.scraptfLows('hats').map((l) => l.sku)).toEqual(['kept']);
    expect(r.scraptfLows('stranges')).toEqual([]);
    expect(r.pruneScraptfLows(now, DAY / 2)).toBe(1);
    expect(r.pruneScraptfLows(now)).toBe(0);
    expect(SCRAPTF_LOWS_MAX_AGE_MS).toBe(365 * DAY);
  });
});
