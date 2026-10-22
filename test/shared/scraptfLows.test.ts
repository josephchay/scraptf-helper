// 0.9 (history, H9): the lowest price each scrap.tf copy showed on sale in the user's saves (src/shared/scraptfLows.ts).
// Raw keys + metal compared by one total order (rawPriceCompare), folded order-independently, merged (retained saves
// and the stored table), valued only at a read's key price. Sold-out rows, /items family rows and a key's second row
// in a save never count. Pure.

import { describe, expect, it } from 'vitest';
import { bankStockKey } from '../../src/shared/bankStock';
import type { ScraptfSaveRows } from '../../src/shared/scraptfHistory';
import {
  SCRAPTF_LOWS_MAX_AGE_MS,
  rawPriceCompare,
  sameScraptfLow,
  scraptfCopyLowOf,
  scraptfLowFold,
  scraptfLowMerge,
  scraptfLowSightingsOf,
  scraptfLowsOf,
  type ScraptfLowSighting,
} from '../../src/shared/scraptfLows';
import type { BankStockStored, ScraptfLowCore } from '../../src/shared/types';

const T = 1_792_000_000_000;
const DAY = 86_400_000;
const K = 500;

const stored = (sku: string, costKeys: number | null, costScrap: number | null, over: Partial<BankStockStored> = {}): BankStockStored => ({
  sku,
  specialKey: '',
  name: sku,
  costKeys,
  costScrap,
  stock: 1,
  assetId: null,
  ...over,
});

describe('the retention', () => {
  it('keeps a low for 365 days after its last sighting', () => {
    expect(SCRAPTF_LOWS_MAX_AGE_MS).toBe(365 * DAY);
  });
});

describe('rawPriceCompare', () => {
  it('compares the metal at equal keys', () => {
    expect(rawPriceCompare({ keys: 1, scrap: 9 }, { keys: 1, scrap: 10 }, K)).toBe(-1);
    expect(rawPriceCompare({ keys: 1, scrap: 10 }, { keys: 1, scrap: 9 }, 0)).toBe(1);
    expect(rawPriceCompare({ keys: 0, scrap: 9 }, { keys: 0, scrap: 9 }, K)).toBe(0);
  });

  it('values different keys at a key price, then fewer keys first on a tie; without one, fewer keys first', () => {
    expect(rawPriceCompare({ keys: 0, scrap: 600 }, { keys: 1, scrap: 0 }, K)).toBe(1);
    expect(rawPriceCompare({ keys: 0, scrap: 400 }, { keys: 1, scrap: 0 }, K)).toBe(-1);
    // 500 scrap and 1 key are worth the same: fewer keys first, never 0 (a total order).
    expect(rawPriceCompare({ keys: 0, scrap: 500 }, { keys: 1, scrap: 0 }, K)).toBe(-1);
    expect(rawPriceCompare({ keys: 1, scrap: 0 }, { keys: 0, scrap: 500 }, K)).toBe(1);
    expect(rawPriceCompare({ keys: 0, scrap: 9_999 }, { keys: 1, scrap: 0 }, 0)).toBe(-1);
    expect(rawPriceCompare({ keys: 2, scrap: 0 }, { keys: 1, scrap: 9_999 }, Number.NaN)).toBe(1);
  });

  it('reads bad numbers as 0', () => {
    expect(rawPriceCompare({ keys: Number.NaN, scrap: 9 }, { keys: 0, scrap: 9 }, K)).toBe(0);
    expect(rawPriceCompare({ keys: -1, scrap: Number.NaN }, { keys: 0, scrap: 0 }, K)).toBe(0);
  });
});

describe('scraptfLowFold', () => {
  const s = (keys: number, scrap: number, at: number) => ({ keys, scrap, at });

  it('starts at the first sighting, lowers on a lower price, widens on the same price, and tracks since / seenAt', () => {
    let low = scraptfLowFold(null, s(1, 9, T), K);
    expect(low).toEqual({ keys: 1, scrap: 9, firstAt: T, lastAt: T, since: T, seenAt: T });
    low = scraptfLowFold(low, s(1, 9, T + DAY), K);
    expect(low).toEqual({ keys: 1, scrap: 9, firstAt: T, lastAt: T + DAY, since: T, seenAt: T + DAY });
    low = scraptfLowFold(low, s(1, 20, T + 2 * DAY), K);
    expect(low).toEqual({ keys: 1, scrap: 9, firstAt: T, lastAt: T + DAY, since: T, seenAt: T + 2 * DAY });
    low = scraptfLowFold(low, s(0, 400, T + 3 * DAY), K);
    expect(low).toEqual({ keys: 0, scrap: 400, firstAt: T + 3 * DAY, lastAt: T + 3 * DAY, since: T, seenAt: T + 3 * DAY });
    // An older save at a higher price only moves since back.
    low = scraptfLowFold(low, s(2, 0, T - DAY), K);
    expect(low).toEqual({ keys: 0, scrap: 400, firstAt: T + 3 * DAY, lastAt: T + 3 * DAY, since: T - DAY, seenAt: T + 3 * DAY });
  });

  it('gives one result for every order of the same five sightings', () => {
    const five = [s(1, 9, T), s(0, 500, T + DAY), s(1, 0, T + 2 * DAY), s(1, 0, T + 3 * DAY), s(0, 510, T + 4 * DAY)];
    const permutations = (xs: typeof five): (typeof five)[] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
    const results = new Set(permutations(five).map((p) => JSON.stringify(p.reduce<ScraptfLowCore | null>((low, x) => scraptfLowFold(low, x, K), null))));
    expect(results.size).toBe(1);
    // 500 scrap and 1 key tie in value; fewer keys wins.
    expect(JSON.parse([...results][0]!)).toEqual({ keys: 0, scrap: 500, firstAt: T + DAY, lastAt: T + DAY, since: T, seenAt: T + 4 * DAY });
  });
});

describe('scraptfLowMerge and sameScraptfLow', () => {
  const a: ScraptfLowCore = { keys: 0, scrap: 400, firstAt: T + DAY, lastAt: T + 2 * DAY, since: T, seenAt: T + 5 * DAY };
  const b: ScraptfLowCore = { keys: 0, scrap: 450, firstAt: T - 9 * DAY, lastAt: T - 8 * DAY, since: T - 20 * DAY, seenAt: T + 3 * DAY };

  it('keeps the lower low with the widest since and seenAt, and joins first / last at the same price', () => {
    expect(scraptfLowMerge(a, b, K)).toEqual({ ...a, since: T - 20 * DAY, seenAt: T + 5 * DAY });
    expect(scraptfLowMerge(b, a, K)).toEqual({ ...a, since: T - 20 * DAY, seenAt: T + 5 * DAY });
    const same = { ...b, scrap: 400 };
    expect(scraptfLowMerge(a, same, K)).toEqual({ keys: 0, scrap: 400, firstAt: T - 9 * DAY, lastAt: T + 2 * DAY, since: T - 20 * DAY, seenAt: T + 5 * DAY });
    expect(scraptfLowMerge(null, b, K)).toBe(b);
    expect(scraptfLowMerge(a, undefined, K)).toBe(a);
    expect(scraptfLowMerge(null, null, K)).toBeNull();
  });

  it('compares all six fields', () => {
    expect(sameScraptfLow(a, { ...a })).toBe(true);
    for (const k of Object.keys(a) as (keyof ScraptfLowCore)[]) expect(sameScraptfLow(a, { ...a, [k]: a[k] + 1 }), k).toBe(false);
  });
});

describe('scraptfLowSightingsOf', () => {
  it('reads each copy on sale once (its first row), leaving out sold-out rows and /items family rows', () => {
    const rows = [
      stored('378;6', 0, 45),
      stored('378;6', 0, 30), // the same copy again: the save's word is its first row
      stored('126;6', null, null, { stock: 0 }), // sold out
      stored('200;6', 1, 9, { stock: 0 }), // 0 in stock
      stored('378;6', 0, 50, { specialKey: '["p",[],[],null,null,false,false]' }), // another copy
      stored('5021;6', 1, 0, { craft: 'any' }), // a family row on the list
      stored('6;6', 0, 9, { craft: 'craftable' }),
    ];
    const bank = scraptfLowSightingsOf(rows, 'hats', T);
    expect(bank.map((x) => [x.key, x.keys, x.scrap, x.at])).toEqual([
      [bankStockKey('378;6', ''), 0, 45, T],
      [bankStockKey('378;6', '["p",[],[],null,null,false,false]'), 0, 50, T],
      [bankStockKey('5021;6', ''), 1, 0, T],
      [bankStockKey('6;6', ''), 0, 9, T],
    ]);
    // On the /items list only a row proven to price one copy counts (no craft at all is a family row too).
    const list = scraptfLowSightingsOf(rows, 'list', T);
    expect(list).toEqual<ScraptfLowSighting[]>([{ key: '6;6|', sku: '6;6', specialKey: '', keys: 0, scrap: 9, at: T }]);
  });

  it('a first row that is not on sale hides the copy in that save', () => {
    expect(scraptfLowSightingsOf([stored('378;6', null, null), stored('378;6', 0, 9)], 'hats', T)).toEqual([]);
  });
});

describe('scraptfLowsOf and scraptfCopyLowOf', () => {
  const save = (savedAt: number, rows: BankStockStored[], batchId = savedAt): ScraptfSaveRows => ({ batchId, savedAt, page: '', rows });

  it('folds every save in any order, per copy', () => {
    const saves = [save(T, [stored('378;6', 0, 45), stored('126;6', 1, 0)]), save(T + DAY, [stored('378;6', 0, 40)]), save(T - DAY, [stored('378;6', 0, 40)])];
    const lows = scraptfLowsOf(saves, 'hats', K);
    expect(lows.get('378;6|')).toEqual({ keys: 0, scrap: 40, firstAt: T - DAY, lastAt: T + DAY, since: T - DAY, seenAt: T + DAY });
    expect(lows.get('126;6|')).toEqual({ keys: 1, scrap: 0, firstAt: T, lastAt: T, since: T, seenAt: T });
    expect(scraptfLowsOf([...saves].reverse(), 'hats', K)).toEqual(lows);
    expect(scraptfLowsOf([], 'hats', K).size).toBe(0);
  });

  it('values a low at the read’s key price (none: keys count 0), and is null without one', () => {
    const core: ScraptfLowCore = { keys: 2, scrap: 9, firstAt: T, lastAt: T + 1, since: T - 5, seenAt: T + 9 };
    expect(scraptfCopyLowOf(core, K)).toEqual({ keys: 2, scrap: 9, valueScrap: 1009, firstAt: T, lastAt: T + 1, since: T - 5 });
    expect(scraptfCopyLowOf(core, 0)!.valueScrap).toBe(9);
    expect(scraptfCopyLowOf(core, Number.NaN)!.valueScrap).toBe(9);
    expect(scraptfCopyLowOf(null, K)).toBeNull();
    expect(scraptfCopyLowOf(undefined, K)).toBeNull();
  });
});
