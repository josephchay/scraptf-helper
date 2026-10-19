// F14 Record trade prefill: a price known only by its value (Holdings' scraptfPaysScrap) becomes
// whole keys plus metal at the key price the row is valued at, the way scrap.tf lists it, and the
// dialog values it back to exactly that amount. Pure; the dialog itself is unchanged.

import { describe, expect, it } from 'vitest';
import { initialPriceText, initialTradeForm, splitAtKey, typedPrice } from '../../src/renderer/recordTradeModel';

const KEY = 568;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

describe('splitAtKey', () => {
  it('keeps a price under a key in metal', () => {
    expect(splitAtKey(100, KEY)).toEqual({ keys: 0, scrap: 100 });
    expect(splitAtKey(KEY - 1, KEY)).toEqual({ keys: 0, scrap: KEY - 1 });
  });

  it('takes whole keys and leaves the rest in metal', () => {
    expect(splitAtKey(KEY, KEY)).toEqual({ keys: 1, scrap: 0 });
    expect(splitAtKey(KEY + 48, KEY)).toEqual({ keys: 1, scrap: 48 });
    expect(splitAtKey(25 * KEY + 30, KEY)).toEqual({ keys: 25, scrap: 30 });
  });

  it('stays metal without a usable key price, and never goes negative or fractional', () => {
    expect(splitAtKey(KEY + 48, null)).toEqual({ keys: 0, scrap: KEY + 48 });
    expect(splitAtKey(KEY + 48, 0)).toEqual({ keys: 0, scrap: KEY + 48 });
    expect(splitAtKey(Number.NaN, KEY)).toEqual({ keys: 0, scrap: 0 });
    expect(splitAtKey(-5, KEY)).toEqual({ keys: 0, scrap: 0 });
    expect(splitAtKey(100.4, KEY)).toEqual({ keys: 0, scrap: 100 });
  });

  it('round-trips through the dialog prefill at the same key price', () => {
    for (const v of [1, 100, KEY, KEY + 1, 3 * KEY + 17, 40 * KEY]) {
      const split = splitAtKey(v, KEY);
      const form = initialTradeForm({ side: 'sell', sku: '143;6', name: 'Earbuds', venue: 'scrap.tf', ...split }, T0);
      expect(typedPrice(form, KEY).value).toBe(v);
    }
    expect(initialPriceText(splitAtKey(KEY + 48, KEY))).toBe('1 key 5.33 ref');
  });
});
