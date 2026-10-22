// 0.9 (history, RESEARCH #7): the feed's item.price.community (wsCommunityPriceOf) over the captured stream. Read for
// history only (never a reference); it reads nothing of `user`, `steam` or `deal`.

import { describe, expect, it } from 'vitest';
import { createMapStats, wsCommunityPriceOf } from '../../src/service/connectors/bptfItem';
import { communityPointKey } from '../../src/shared/communityHistory';
import { loadFixture, type WsSample } from './helpers';

const sample = loadFixture<WsSample>('ws-sample.json');

describe('wsCommunityPriceOf over ws-sample.json', () => {
  it('reads 249 of the 299 live events, the first one exactly', () => {
    const read = sample.events.map((e) => wsCommunityPriceOf(e.payload));
    expect(sample.events).toHaveLength(299);
    expect(read.filter((r) => r !== null)).toHaveLength(249);
    expect(read[0]).toEqual({ currency: 'metal', value: 23.22, valueHigh: 29.33, lastUpdate: 1788973015 });
  });

  it("reads a buy delete's full payload in keys (the Cloudy Moon Pith Helmet)", () => {
    const helmet = sample.events.find((e) => e.event === 'listing-delete' && e.payload.intent === 'buy' && /Pith Helmet/.test(e.payload.item.name))!;
    expect(helmet).toBeDefined();
    // The feed sent valueHigh 390 too: a high equal to the low is no range (IGetPrices leaves value_high out).
    expect(wsCommunityPriceOf(helmet.payload)).toEqual({ currency: 'keys', value: 390, valueHigh: null, lastUpdate: 1741824184 });
  });

  it('reads valueHigh equal to value as null (review: 84 of the 249), so it keys as the IGetPrices row of that price', () => {
    const read = sample.events.map((e) => ({ raw: (e.payload.item['price'] as { community?: { value?: unknown; valueHigh?: unknown } } | undefined)?.community, got: wsCommunityPriceOf(e.payload) }));
    const single = read.filter((r) => r.got !== null && r.raw?.valueHigh === r.raw?.value);
    expect(single).toHaveLength(84);
    expect(single.every((r) => r.got!.valueHigh === null)).toBe(true);
    // Every other read event keeps its range.
    expect(read.filter((r) => r.got !== null && r.got.valueHigh !== null)).toHaveLength(249 - 84);
    const base = sample.events[0]!.payload;
    const feed = wsCommunityPriceOf({ ...base, item: { ...base.item, price: { community: { value: 62.11, valueHigh: 62.11, currency: 'metal', updatedAt: 1_791_000_000 } } } })!;
    expect(communityPointKey(feed)).toBe(communityPointKey({ currency: 'metal', value: 62.11, valueHigh: null, lastUpdate: 1_791_000_000 }));
  });

  it('is null for `price: []`, no community entry, a value that is not positive, or no item', () => {
    const withEmpty = sample.events.find((e) => Array.isArray(e.payload.item['price']))!;
    expect(withEmpty).toBeDefined();
    expect(wsCommunityPriceOf(withEmpty.payload)).toBeNull();
    const base = sample.events[0]!.payload;
    const item = base.item;
    expect(wsCommunityPriceOf({ ...base, item: { ...item, price: { steam: {} } } })).toBeNull();
    expect(wsCommunityPriceOf({ ...base, item: { ...item, price: { community: { value: 0, currency: 'metal' } } } })).toBeNull();
    expect(wsCommunityPriceOf({ ...base, item: { ...item, price: { community: { value: -3, currency: 'metal' } } } })).toBeNull();
    expect(wsCommunityPriceOf({ ...base, item: null })).toBeNull();
    expect(wsCommunityPriceOf(null)).toBeNull();
    expect(wsCommunityPriceOf('x')).toBeNull();
  });

  it('defaults and normalises the currency, reads a string value and a millisecond time, and drops a bad valueHigh', () => {
    const base = sample.events[0]!.payload;
    const at = (community: unknown) => wsCommunityPriceOf({ ...base, item: { ...base.item, price: { community } } });
    expect(at({ value: '2.5' })).toEqual({ currency: 'metal', value: 2.5, valueHigh: null, lastUpdate: null });
    expect(at({ value: 3, currency: ' KEYS ', updatedAt: 1_788_973_015_000 })).toEqual({ currency: 'keys', value: 3, valueHigh: null, lastUpdate: 1_788_973_015 });
    expect(at({ value: 3, currency: '' })).toMatchObject({ currency: 'metal' });
  });

  it("counts a community object of another shape in unknownShapes['item.price.community'] and ignores it", () => {
    const stats = createMapStats();
    const base = sample.events[0]!.payload;
    expect(wsCommunityPriceOf({ ...base, item: { ...base.item, price: { community: { value: 'lots' } } } }, stats)).toBeNull();
    expect(wsCommunityPriceOf({ ...base, item: { ...base.item, price: { community: 'cheap' } } }, stats)).toBeNull();
    expect(stats.unknownShapes['item.price.community']).toBe(2);
  });

  it('never reads `user`, `steam` or `deal`', () => {
    const base = sample.events[0]!.payload;
    const trap = (name: string) => ({
      get() {
        throw new Error(`read ${name}`);
      },
    });
    const price = Object.defineProperty({ community: { value: 4, currency: 'metal' } }, 'steam', { ...trap('steam'), enumerable: true });
    const payload: Record<string, unknown> = { ...base, item: { ...base.item, price } };
    Object.defineProperty(payload, 'user', { ...trap('user'), enumerable: true });
    Object.defineProperty(payload, 'deal', { ...trap('deal'), enumerable: true });
    expect(wsCommunityPriceOf(payload)).toEqual({ currency: 'metal', value: 4, valueHigh: null, lastUpdate: null });
  });
});
