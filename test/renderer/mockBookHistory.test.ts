// 0.9 (history) parity in the browser mock: 'item.bookHistory' is the service's shared rule (itemBookHistoryOf) over
// the book's seeded spells and recorded community prices (seedOrderSpells / seedCommunityHistory) and the asked buy
// orders with their seeded listing times (mockOrderListedAt); the seeds give both windows and "not enough data"
// across the catalogue; and the scrap.tf lows on the bank stock rows and the drawer's item history are one shared
// fold (scraptfLowsOf / scraptfCopyLowOf) over the bank's saves. The mock's books and saves are internal: the books are
// rebuilt here as the mock builds them (one RNG over CATALOG), and the lows are checked across its answers and
// against the shared fold over each copy's own history points. Fake data; nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { bookHistoryOrderIds } from '../../src/renderer/bookHistoryModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { CATALOG, createRng, makeBook, mockOrderListedAt, seedCommunityHistory, seedOrderSpells, type MockBook } from '../../src/renderer/mockData';
import { BANK_STOCK_MAX_LIMIT } from '../../src/shared/bankStock';
import { BOOK_HISTORY_ORDERS_MAX, itemBookHistoryOf } from '../../src/shared/orderPersistence';
import { scraptfCopyLowOf, scraptfLowFold } from '../../src/shared/scraptfLows';
import type { BankStockRow, ScraptfBank, ScraptfLowCore } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY = 86_400_000;
/** createMockBridge's default seed. */
const SEED = 20261014;

let bridge: MockBridge | null = null;
function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

/** The catalogue's books as the mock builds them (one RNG, in CATALOG order). Listing ids differ (a module counter); values, flags and references do not. */
function replicaBooks(): Map<string, MockBook> {
  const rng = createRng(SEED);
  const out = new Map<string, MockBook>();
  CATALOG.forEach((item, i) => out.set(item.sku, makeBook(rng, item, T0, i % 17 === 9)));
  return out;
}

describe("0.9 (history): the mock's 'item.bookHistory' is the shared rule over its seeds", () => {
  it('equals itemBookHistoryOf over seedOrderSpells / seedCommunityHistory of the same book, for every catalogue item', async () => {
    const b = make();
    const books = replicaBooks();
    let withOrders = 0;
    let withSteps = 0;
    for (const item of CATALOG) {
      if (/;p\d/.test(item.sku)) continue;
      const d = await b.rpc('item.detail', { sku: item.sku, history: false });
      if (!d) continue;
      const ids = bookHistoryOrderIds(d.buyOrders);
      const got = await b.rpc('item.bookHistory', { sku: item.sku, orders: ids });
      const book = books.get(item.sku)!;
      const expected = itemBookHistoryOf({
        sku: item.sku,
        bases: [item.sku],
        spells: seedOrderSpells(book, T0),
        points: seedCommunityHistory(book, T0),
        current: null,
        orders: ids.map((id) => {
          const o = d.buyOrders.find((x) => x.listingId === id)!;
          return { listingId: id, listing: { intent: 'buy' as const, keys: o.keys, metalScrap: o.metalScrap, isBot: o.isBot, listedAt: mockOrderListedAt(id, T0) } };
        }),
        keyScrap: d.keyPrice?.valueScrap ?? null,
        now: T0,
      });
      expect(got, item.sku).toEqual(expected);
      if (got.orders.length > 0) withOrders++;
      if (got.community.steps.length > 0) withSteps++;
    }
    expect(withOrders).toBeGreaterThan(5);
    expect(withSteps).toBeGreaterThan(3);
  });

  it('the seeds give both an estimate and "not enough data" across the catalogue, and never a SteamID', async () => {
    const b = make();
    const shorts = new Set<string>();
    let windows = 0;
    for (const item of CATALOG) {
      const d = await b.rpc('item.detail', { sku: item.sku, history: false });
      if (!d) continue;
      const h = await b.rpc('item.bookHistory', { sku: item.sku, orders: bookHistoryOrderIds(d.buyOrders) });
      for (const o of h.orders) {
        if (o.persistence.windows.length > 0) windows++;
        if (o.persistence.short) shorts.add(o.persistence.short);
        for (const w of o.persistence.windows) expect(w.atRisk).toBeGreaterThanOrEqual(8);
      }
      expect(JSON.stringify(h)).not.toMatch(/7656119\d{10}/);
    }
    expect(windows).toBeGreaterThan(0);
    expect(shorts.size).toBeGreaterThan(0);
  });

  it('memoises per base, caps and dedupes the asked orders, refuses a bad SKU and creates no book', async () => {
    const b = make();
    const d = (await b.rpc('item.detail', { sku: '378;6', history: false }))!;
    const all = d.buyOrders.filter((o) => o.eligible).map((o) => o.listingId);
    expect(all.length).toBeGreaterThan(1);
    const first = await b.rpc('item.bookHistory', { sku: '378;6', orders: [all[0]!, all[0]!, all[1]!] });
    expect(first.orders.map((o) => o.listingId)).toEqual([all[0], all[1]]);
    expect(await b.rpc('item.bookHistory', { sku: '378;6', orders: [all[0]!, all[0]!, all[1]!] })).toEqual(first);
    // A painted copy reads its base's book; an unknown id and a sell listing are not buy orders of it.
    const painted = await b.rpc('item.bookHistory', { sku: '378;6;p3100495', orders: ['nope', ...d.sellListings.slice(0, 1).map((o) => o.listingId)] });
    expect(painted.sku).toBe('378;6');
    expect(painted.orders).toEqual([]);
    expect(painted.summary).toEqual(first.summary);
    await expect(b.rpc('item.bookHistory', { sku: 'not a sku' })).rejects.toThrow(/Invalid parameters for item\.bookHistory: sku/);
    await expect(b.rpc('item.bookHistory', { sku: '378;6', orders: ['a', 'b', 'c', 'd', 'e', 'f'] })).rejects.toThrow(/orders: at most 5 listing ids/);
    expect(BOOK_HISTORY_ORDERS_MAX).toBe(5);
    // An item with no book: nothing followed, nothing recorded.
    const none = await b.rpc('item.bookHistory', { sku: '30998;6' });
    expect(none.summary.followed).toBe(0);
    expect(none.community.steps).toEqual([]);
  });
});

/** The banks the mock has saved (killstreaks once; skins and items never). */
const SAVED: ScraptfBank[] = ['hats', 'unusuals', 'stranges', 'weapons', 'killstreaks', 'list'];
/** Copies on sale compared per bank. */
const PER_BANK = 8;

/** A row's special key (its key is `${sku}|${specialKey}`, bankStockKey). */
function specialOf(r: Pick<BankStockRow, 'sku' | 'key'>): string {
  return r.key.slice(r.sku.length + 1);
}

describe('0.9 (history): the scrap.tf lows in the mock are the shared fold over its saves', () => {
  it("each bank stock row's low is its item history's low, and the fold of that history's on-sale points", async () => {
    const b = make();
    let compared = 0;
    let lows = 0;
    for (const bank of SAVED) {
      const page = await b.rpc('scraptf.bankStock', { bank, limit: BANK_STOCK_MAX_LIMIT });
      const K = page.keyPrice?.valueScrap ?? 0;
      // An /items family row prices no one copy: never a low.
      for (const r of page.rows) if (r.listFamily) expect(r.low, r.key).toBeUndefined();
      // Each item history read folds every bank's saves: a sample of each bank's copies on sale keeps this quick.
      const sample = page.rows.filter((r) => !r.listFamily && r.change !== 'gone').slice(0, PER_BANK);
      for (const r of sample) {
        const h = await b.rpc('scraptf.itemHistory', { sku: r.sku, special: specialOf(r) });
        if (h.bank !== bank) continue;
        compared++;
        expect(h.low, r.key).toEqual(r.low);
        // The same fold over the copy's own saves in this bank (every point the history kept, valued at the key price).
        let core: ScraptfLowCore | null = null;
        for (const p of h.points) if (p.listed) core = scraptfLowFold(core, { keys: 0, scrap: p.costScrap, at: p.at }, K);
        const expected = scraptfCopyLowOf(core, K);
        if (!expected) {
          expect(r.low, r.key).toBeUndefined();
          continue;
        }
        lows++;
        expect({ valueScrap: r.low!.valueScrap, firstAt: r.low!.firstAt, lastAt: r.low!.lastAt, since: r.low!.since }, r.key).toEqual({
          valueScrap: expected.valueScrap,
          firstAt: expected.firstAt,
          lastAt: expected.lastAt,
          since: expected.since,
        });
        expect(r.low!.since).toBeLessThanOrEqual(r.low!.firstAt);
        expect(r.low!.firstAt).toBeLessThanOrEqual(r.low!.lastAt);
      }
    }
    expect(compared).toBeGreaterThan(10);
    expect(lows).toBeGreaterThan(10);
  });

  it('some copies are on sale at their low and some above it, each low dated within the kept saves', async () => {
    const b = make();
    const page = await b.rpc('scraptf.bankStock', { bank: 'hats', limit: BANK_STOCK_MAX_LIMIT });
    const onSale = page.rows.filter((r) => r.change !== 'gone' && !r.listFamily && r.low);
    expect(onSale.length).toBeGreaterThan(3);
    // Some copy sits at its low now and some above it (the seeded saves move prices both ways).
    expect(onSale.some((r) => r.costScrap <= r.low!.valueScrap)).toBe(true);
    expect(onSale.some((r) => r.costScrap > r.low!.valueScrap)).toBe(true);
    for (const r of onSale) expect(r.low!.since).toBeGreaterThan(T0 - 120 * DAY);
  });
});
