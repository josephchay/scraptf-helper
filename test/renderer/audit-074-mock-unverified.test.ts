// 0.7.4 (review R31): the dev mock flags an order 'unverified' from its age, as the service's classifyOrder does
// (no event or snapshot for 24 h). The mock drew the flag at random and then gave such an order an age from
// 30 s to 40 h, so most flagged orders were seen under 24 h ago: the warn clock said "last seen 3 min ago, may
// be gone", the row was left out of Conservative and never toasted, and confidence could still give it "+10
// Order confirmed by the live feed". Nothing cleared the flag when an order was seen again. mockOrderFlags now
// sets it from the age on every read (mockPrices, the drawer's buy orders), and generated ages match it.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { CATALOG, MOCK_UNVERIFIED_AFTER_MS, createRng, evaluateOpportunity, makeBook, mockOrderFlags, mockPrices, type MockBook } from '../../src/renderer/mockData';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const K = 540;
const HOUR = 3_600_000;

function books(seed: number): MockBook[] {
  const rng = createRng(seed);
  return CATALOG.map((item) => makeBook(rng, item, T0));
}

describe("the mock's 'unverified' flag (R31)", () => {
  it('matches the service rule: 24 h without an event', () => {
    expect(MOCK_UNVERIFIED_AFTER_MS).toBe(24 * HOUR);
    expect(mockOrderFlags({ flags: ['unverified', 'notes-flag'], lastEventAt: T0 - 3 * 60_000 }, T0)).toEqual(['notes-flag']);
    expect(mockOrderFlags({ flags: [], lastEventAt: T0 - 25 * HOUR }, T0)).toEqual(['unverified']);
    expect(mockOrderFlags({ flags: [], lastEventAt: Number.NaN }, T0)).toEqual(['unverified']);
  });

  it('every priced order is flagged exactly when it is over 24 h old, for several seeds', () => {
    let flagged = 0;
    for (const seed of [1, 7, 1234, 9001]) {
      for (const book of books(seed)) {
        for (const o of mockPrices(book, DEFAULT_SETTINGS, K, T0).eligible) {
          const old = T0 - o.lastEventAt > MOCK_UNVERIFIED_AFTER_MS;
          expect(o.flags.includes('unverified'), o.listingId).toBe(old);
          if (old) flagged++;
        }
        // The generated data agrees too: a drawn 'unverified' order is over 24 h old, any other under it.
        for (const o of book.buy) expect(o.flags.includes('unverified')).toBe(T0 - o.lastEventAt > MOCK_UNVERIFIED_AFTER_MS);
      }
    }
    expect(flagged).toBeGreaterThan(0);
  });

  it('an order seen again (a feed tick or item.refresh stamps lastEventAt) is verified on the next read', () => {
    const book = books(1234).find((b) => b.buy.some((o) => o.eligible && o.flags.includes('unverified')))!;
    expect(book).toBeDefined();
    for (const o of book.buy) o.lastEventAt = T0;
    expect(mockPrices(book, DEFAULT_SETTINGS, K, T0).eligible.some((o) => o.flags.includes('unverified'))).toBe(false);
  });

  it('no conservative order is both unverified and "confirmed by the live feed"', () => {
    const input = { kind: 'user' as const, ref: 'test', costKeys: 0, costScrapRaw: 1, observedAt: T0, special: null };
    for (const seed of [1, 1234]) {
      for (const book of books(seed)) {
        const p = mockPrices(book, DEFAULT_SETTINGS, K, T0);
        if (!p.cons) continue;
        const o = evaluateOpportunity(book, input, DEFAULT_SETTINGS, K, T0, null);
        const confirmed = o.reasons.some((r) => /confirmed by the live feed/i.test(r));
        if (p.cons.flags.includes('unverified')) expect(confirmed, book.item.sku).toBe(false);
      }
    }
  });
});

describe("the mock drawer's buy orders", () => {
  let b: MockBridge | null = null;
  afterEach(() => {
    b?.dispose();
    b = null;
  });

  it('carry the flag from the age, as the service', async () => {
    b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    let checked = 0;
    for (const item of CATALOG.slice(0, 40)) {
      const d = await b.rpc('item.detail', { sku: item.sku, history: false });
      for (const o of d?.buyOrders ?? []) {
        expect(o.flags.includes('unverified'), `${item.sku} ${o.listingId}`).toBe(T0 - o.lastEventAt > MOCK_UNVERIFIED_AFTER_MS);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
