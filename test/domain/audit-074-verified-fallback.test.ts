// 0.7.4 trading accuracy audit, package G2 (review R12): computePrices prefers verified orders for Conservative
// and the median, it does not make them exclusive. When every verified order is an outlier (one fresh order at
// 1.6x PriceDB's sell price on an older book), Conservative falls back to the top non-outlier unverified order,
// as for a book with no verified order at all: the row keeps a revenue and its "Pay up to", the order keeps its
// 'unverified' flag (Medium at most, never toasted), and 'all-outliers' no longer claims every order is
// unrealistic. Instant stays verified bots only (F23). The mock's mockPrices mirrors it. No parsing here.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { bookFlags, createEngine, evaluateOpportunity, explicitInput } from '../../src/service/domain/engine';
import { classifyOrder, matchContext } from '../../src/service/domain/matcher';
import { computePrices, valueOrders } from '../../src/service/domain/pricing';
import { createRng, makeBook, mockPrices, type MockBook } from '../../src/renderer/mockData';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { Listing, OrderSummary, ReferencePrices, ScrapPrice } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, testSettings } from './helpers';

const K = 577;
const P = testSettings().profit;

function book(listings: Listing[]) {
  const match = matchContext(DEFAULT_SETTINGS, T0);
  const target = { baseSku: '378;6', special: null };
  return valueOrders(
    listings.map((listing) => ({ listing, ...classifyOrder(listing, target, match) })).filter((o) => o.eligible),
    K,
  );
}

const at = (id: string, metalScrap: number, ageMs: number, over: Partial<Listing> = {}): Listing =>
  makeListing({ id, steamid: `S-${id}`, sku: '378;6', baseSku: '378;6', metalScrap, lastEventAt: T0 - ageMs, ...over });

/** One fresh (verified) bot order at 1.6x PriceDB's sell price over three day-old ones. */
const mixed = (): Listing[] => [at('v', 160, MIN, { isBot: true }), at('u1', 99, 30 * HOUR, { isBot: true }), at('u2', 97, 30 * HOUR), at('u3', 95, 40 * HOUR)];
const PDB_SELL = 100;

describe('computePrices when every verified order is an outlier (R12)', () => {
  it('takes the top non-outlier unverified order as Conservative; Instant stays a verified bot or none', () => {
    const orders = book(mixed());
    const r = computePrices(orders, { pricedbSellScrap: PDB_SELL }, P);
    expect(r.best?.listing.id).toBe('v');
    expect(r.conservative?.listing.id).toBe('u1');
    expect(r.instant).toBeNull();
    expect([...r.outlierIds]).toEqual(['v']);
    // The best order is an outlier, but not every order is.
    expect(bookFlags({ eligible: orders, prices: r }, [], r.conservative!.valueScrap, K)).toEqual(['outlier-best']);
  });

  it('prices the book as it would without the fresh order', () => {
    const without = computePrices(book(mixed().slice(1)), { pricedbSellScrap: PDB_SELL }, P);
    const withIt = computePrices(book(mixed()), { pricedbSellScrap: PDB_SELL }, P);
    expect(withIt.conservative?.listing.id).toBe(without.conservative?.listing.id);
  });

  it('also falls back against a community high price', () => {
    const r = computePrices(book(mixed()), { communityHighScrap: PDB_SELL }, P);
    expect(r.conservative?.listing.id).toBe('u1');
  });

  it('still prefers a verified non-outlier order over a higher unverified one', () => {
    const r = computePrices(book([at('u', 120, 30 * HOUR), at('v', 100, MIN)]), {}, P);
    expect(r.conservative?.listing.id).toBe('v');
  });

  it('still says all-outliers when no order is realistic, verified or not', () => {
    for (const age of [MIN, 30 * HOUR]) {
      const orders = book([at('lone', 160, age)]);
      const r = computePrices(orders, { pricedbSellScrap: PDB_SELL }, P);
      expect(r.conservative).toBeNull();
      expect(bookFlags({ eligible: orders, prices: r }, [], null, K)).toContain('all-outliers');
    }
    // Every order an outlier, the unverified ones too.
    const r = computePrices(book([at('v', 170, MIN), at('u', 160, 30 * HOUR)]), { pricedbSellScrap: PDB_SELL }, P);
    expect(r.conservative).toBeNull();
  });
});

describe('the engine row on that book (R12)', () => {
  const price: ScrapPrice = {
    id: 1,
    sku: '378;6',
    name: 'Team Captain',
    costKeys: 0,
    costScrap: 60,
    source: 'import',
    observedAt: T0 - MIN,
    note: null,
    importBatch: null,
    special: null,
    assetId: null,
    stock: null,
  };
  const references: ReferencePrices = { pricedb: { buyScrap: 90, sellScrap: PDB_SELL, time: T0 / 1000 - 3600, ageMs: HOUR }, community: null };

  it('keeps a revenue on the unverified order, capped at Medium, with no all-outliers flag', () => {
    const opp = evaluateOpportunity({
      input: explicitInput(price)!,
      listings: mixed(),
      references,
      category: 'hats',
      isUnusual: false,
      settings: DEFAULT_SETTINGS,
      keyScrap: K,
      now: T0,
      match: matchContext(DEFAULT_SETTINGS, T0),
      prev: null,
    });
    expect(opp.revenueScrap).toBe(99);
    expect(opp.consOrder?.listingId).toBe('u1');
    expect(opp.consOrder?.flags).toContain('unverified');
    expect(opp.maxCostScrap).not.toBeNull();
    expect(opp.flags).toContain('outlier-best');
    expect(opp.flags).not.toContain('all-outliers');
    expect(opp.flags).toContain('unverified-orders');
    expect(opp.confidence).toBeLessThanOrEqual(69);
  });

  const repos: Repo[] = [];
  afterEach(() => {
    while (repos.length) repos.pop()!.close();
  });

  it('is listed as profitable but never toasted while its order is unverified', async () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
    repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 90, sellKeys: 0, sellScrap: PDB_SELL, time: Math.floor(T0 / 1000) - 3600, fetchedAt: T0 }]);
    repo.upsertListings(mixed());
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: T0 - MIN });
    const clock = new FakeClock();
    const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } });
    const events = recordingEvents();
    const engine = createEngine({ ...makeDeps(repo, clock, () => settings), schema: createStubSchema(), events, timers: new FakeTimers(clock) });
    await engine.runNow();
    const [row] = repo.allOpportunities();
    expect(row).toMatchObject({ status: 'profitable', revenueScrap: 99 });
    expect(events.notified).toEqual([]);
  });
});

describe('mock parity (R12)', () => {
  const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
  const order = (listingId: string, valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary => ({
    listingId,
    steamid: `S-${listingId}`,
    userName: listingId,
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: false,
    online: null,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  });
  const mockBook = (buy: OrderSummary[]): MockBook => ({
    ...makeBook(createRng(7), { sku: '378;6', name: 'Team Captain', category: 'hats', value: 100 }, NOW),
    buy,
    references: { pricedb: { buyScrap: 90, sellScrap: PDB_SELL, time: null, ageMs: 0 }, community: null },
  });
  const stale = { flags: ['unverified'], lastEventAt: NOW - 30 * HOUR };

  it('falls back to the top non-outlier unverified order as the service does', () => {
    const p = mockPrices(
      mockBook([order('v', 160, { isBot: true }), order('u1', 99, { ...stale, isBot: true }), order('u2', 97, stale), order('u3', 95, stale)]),
      DEFAULT_SETTINGS,
      567,
      NOW,
    );
    expect(p.best?.listingId).toBe('v');
    expect(p.cons?.listingId).toBe('u1');
    expect(p.instant).toBeNull();
    // A lone unrealistic order is still no Conservative.
    expect(mockPrices(mockBook([order('lone', 160)]), DEFAULT_SETTINGS, 567, NOW).cons).toBeNull();
  });
});
