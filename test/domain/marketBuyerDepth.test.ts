// 0.8 (PC-2, H2): evaluateMarketBase carries the book's next buyer (buyerDepthOf over exitOrdersOfBook) and how many
// distinct buyers were seen in the last 24 h. Only adds fields: the entry's flags are as before.

import { describe, expect, it } from 'vitest';
import { evaluateMarketBase } from '../../src/service/domain/market';
import { matchContext } from '../../src/service/domain/matcher';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, Listing, Settings } from '../../src/shared/types';
import { HOUR, MIN, T0, makeListing } from './helpers';

const BASE = '378;6';

function buy(id: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ id, steamid: id, sku: BASE, baseSku: BASE, metalScrap, lastEventAt: T0 - MIN, ...over });
}

function evaluate(listings: Listing[], profit: DeepPartial<Settings['profit']> = {}) {
  const settings = mergeSettings(DEFAULT_SETTINGS, { profit });
  return evaluateMarketBase({ base: BASE, listings, references: { pricedb: null, community: null }, isUnusual: false, settings, keyScrap: 567, now: T0, match: matchContext(settings, T0) })!;
}

describe('evaluateMarketBase: next buyer and verified buyers (0.8, PC-2/H2)', () => {
  const a = buy('A', 100);
  const b = buy('B', 90, { lastEventAt: T0 - 25 * HOUR });
  const c = buy('C', 85, { isBot: true, userOnline: true, lastEventAt: T0 - 2 * MIN });

  it('names the best verified other buyer, passing over a higher unverified one', () => {
    const ev = evaluate([a, b, c]);
    expect(ev.revenueOrder?.listingId).toBe('A');
    expect(ev.nextBuyer).toEqual({ valueScrap: 85, keys: 0, metalScrap: 85, isBot: true, online: true, lastEventAt: T0 - 2 * MIN, unverified: false });
    expect(ev.verifiedBuyerCount).toBe(2);
    expect(ev.buyerCount).toBe(3);
  });

  it('falls back to the unverified buyer, flagged, and to null with no other buyer', () => {
    const two = evaluate([a, b]);
    expect(two.nextBuyer).toMatchObject({ valueScrap: 90, unverified: true });
    expect(two.verifiedBuyerCount).toBe(1);
    const one = evaluate([a]);
    expect(one.nextBuyer).toBeNull();
    expect(one.verifiedBuyerCount).toBe(1);
  });

  it("with useOrder 'instant' reads bots only, after the instant order's own buyer", () => {
    const pulse = Math.floor(T0 / 1000);
    const bots = [
      buy('X', 100, { isBot: true, uaLastPulse: pulse }),
      buy('H', 95),
      buy('Y', 80, { isBot: true, uaLastPulse: pulse }),
    ];
    const ev = evaluate(bots, { useOrder: 'instant' });
    expect(ev.revenueOrder?.listingId).toBe('X');
    expect(ev.nextBuyer).toMatchObject({ valueScrap: 80, isBot: true, unverified: false });
    expect(evaluate(bots).nextBuyer).toMatchObject({ valueScrap: 95, isBot: false });
  });

  it('leaves the entry flags as they were (no single-exit: the market entry has no cost)', () => {
    for (const book of [[a, b, c], [a, b], [a]]) {
      const ev = evaluate(book);
      expect(ev.flags).not.toContain('single-exit');
    }
    // The same flags as before 0.8 for this book: no reference, nothing else.
    expect(evaluate([a, b, c]).flags).toEqual(['no-reference']);
  });
});
