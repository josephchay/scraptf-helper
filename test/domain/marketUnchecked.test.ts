// MarketIndex.uncheckedBy (F15): the Live market's "Not checked" rows split by a grouping of their
// category, each group's count and its first rows by Pay up to (above 0, with a revenue), ties by
// name then SKU, as the full rows list() would return. Real in-memory repo, fake clock and timers;
// nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex, type MarketIndex } from '../../src/service/domain/market';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { bankForCategory } from '../../src/shared/links';
import type { Category, Listing } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

// defindex range -> category (5001;6 is reclaimed metal, a currency the market skips, hence 5101), and names chosen to tie.
const CATS: Record<number, Category> = { 1: 'hats', 2: 'weapons', 5: 'taunts', 6: 'other', 7: 'skins' };
const NAMES: Record<string, string> = { '1002;6': 'Zed hat', '1003;6': 'Abe hat' };

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const market: MarketIndex = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    schema: createStubSchema({ items: [], categoryOf: (d) => CATS[Math.floor(d / 1000)] ?? 'other', nameOf: (s) => NAMES[s] ?? `Item ${s}` }),
    timers,
    keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings, clock.now()),
    onChanged: () => undefined,
    folderWatchActive: () => false,
  });
  return { repo, clock, timers, market };
}

let seq = 0;
/** `n` eligible buyers at `scrap` each for a base SKU. */
function buyers(sku: string, scrap: number, n = 3): Listing[] {
  return Array.from({ length: n }, () => {
    seq++;
    return makeListing({ id: `u${seq}`, sku, baseSku: sku, steamid: `S${seq}`, metalScrap: scrap, lastEventAt: T0 - MIN });
  });
}

function seeded() {
  const h = setup();
  h.repo.upsertListings([
    ...buyers('1001;6', 200),
    ...buyers('1002;6', 150),
    ...buyers('1003;6', 150),
    ...buyers('1004;6', 120),
    ...buyers('1005;6', 90),
    // Checked by a typed price: never "Not checked".
    ...buyers('1006;6', 400),
    ...buyers('2001;6', 80),
    ...buyers('5101;6', 60),
    ...buyers('6001;6', 70),
    ...buyers('7001;6', 50),
  ]);
  h.repo.upsertScrapPrice({ sku: '1006;6', name: 'Priced', costScrap: 30, source: 'user', observedAt: T0 });
  h.market.start();
  h.timers.advance(0);
  expect(h.market.stats().building).toBe(false);
  return h;
}

describe('uncheckedBy', () => {
  it('counts the "Not checked" rows per group and returns the top ones as list() would', () => {
    const h = seeded();
    const all = h.market.all({ verdicts: ['unchecked'] }, T0);
    const g = h.market.uncheckedBy(bankForCategory, 3, T0);
    expect([...g.keys()].sort()).toEqual(['hats', 'items', 'skins', 'weapons']);
    expect(g.get('hats')!.count).toBe(5);
    expect(g.get('items')!.count).toBe(2);
    // Highest Pay up to first; the two 150 buyers tie, so by name.
    expect(g.get('hats')!.rows.map((r) => r.sku)).toEqual(['1001;6', '1003;6', '1002;6']);
    expect(g.get('items')!.rows.map((r) => r.sku)).toEqual(['6001;6', '5101;6']);
    // The very rows the Live market lists.
    for (const group of g.values()) for (const r of group.rows) expect(r).toEqual(all.find((x) => x.sku === r.sku));
    expect(all.some((r) => r.sku === '1006;6')).toBe(false);
  });

  it('counts but never returns rows without a Pay up to above 0', () => {
    const h = setup();
    // One cheap buyer: a revenue too small to leave any profitable cost.
    h.repo.upsertListings([...buyers('1001;6', 1, 1), ...buyers('1002;6', 150)]);
    h.market.start();
    h.timers.advance(0);
    const row = h.market.all({ verdicts: ['unchecked'] }, T0).find((r) => r.sku === '1001;6')!;
    expect(row.maxCostScrap === null || row.maxCostScrap <= 0).toBe(true);
    const g = h.market.uncheckedBy(bankForCategory, 5, T0).get('hats')!;
    expect(g.count).toBe(2);
    expect(g.rows.map((r) => r.sku)).toEqual(['1002;6']);
  });

  it('takes a whole number of rows: none for 0 or garbage, counts still', () => {
    const h = seeded();
    for (const top of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const g = h.market.uncheckedBy(bankForCategory, top, T0).get('hats')!;
      expect(g, String(top)).toEqual({ count: 5, rows: [] });
    }
    expect(h.market.uncheckedBy(bankForCategory, 2.9, T0).get('hats')!.rows).toHaveLength(2);
    // Any grouping works: one group for everything.
    expect(h.market.uncheckedBy(() => 'all', 10, T0).get('all')!.count).toBe(9);
  });

  it('follows the market: a price of yours checks a row, a new buyer adds one', () => {
    const h = seeded();
    expect(h.market.uncheckedBy(bankForCategory, 5, T0).get('weapons')!.count).toBe(1);
    h.repo.upsertScrapPrice({ sku: '2001;6', name: 'Priced', costScrap: 30, source: 'user', observedAt: T0 });
    h.market.pricesChanged();
    expect(h.market.uncheckedBy(bankForCategory, 5, T0).get('weapons')).toBeUndefined();
    h.repo.upsertListings(buyers('2002;6', 90));
    h.market.markDirty(['2002;6']);
    h.timers.advance(2_000);
    expect(h.market.uncheckedBy(bankForCategory, 5, T0).get('weapons')).toMatchObject({ count: 1, rows: [{ sku: '2002;6' }] });
  });

  it("leaves list()'s own results alone", () => {
    const h = seeded();
    const q = { sort: 'name' as const, limit: 4 };
    const before = h.market.list(q, T0);
    h.market.uncheckedBy(bankForCategory, 5, T0);
    expect(h.market.list(q, T0)).toEqual(before);
    expect(h.market.list({ limit: 4, offset: 4, sort: 'name' }, T0).rows.map((r) => r.sku)).toEqual(h.market.all({ sort: 'name' }, T0).slice(4, 8).map((r) => r.sku));
  });
});
