// 0.7.4 (F40): a Live market row whose newest look stored a plain copy and a painted or parted copy at the
// same price shows the plain copy (its stock, no 'has-extras'), as the drawer's bankStockItemOf picks it.
// Before, the higher price id won the tie, which is the copy with extras stored after it (the audited
// Antarctic Parka and Strange Australium Axtinguisher rows). A cheaper extras copy still wins and is flagged;
// kits, every copy with a sheen, still tie on the id (marketKitCopies.test.ts). The mock agrees.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { mockKnownAt, mockKnownPrices } from '../../src/renderer/mockData';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { ScrapPrice, SpecialAttrs } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, special } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const SEEN = T0 - 5 * MIN;

function rowFor(prices: { costScrap: number; stock: number; special: SpecialAttrs | null }[]) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  repo.upsertListings([makeListing({ sku: '378;6', baseSku: '378;6', metalScrap: 70, lastEventAt: T0 - MIN })]);
  for (const p of prices) {
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: p.costScrap, source: 'import', observedAt: SEEN, stock: p.stock, special: p.special });
  }
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => DEFAULT_SETTINGS),
    schema: createStubSchema(),
    timers,
    keyPrice: () => selectKeyPrice(repo.keyQuotes(), DEFAULT_SETTINGS, clock.now()),
    onChanged: () => undefined,
    folderWatchActive: () => false,
    sliceNow: () => 0,
  });
  market.start();
  timers.advance(0);
  return market.all({}, clock.now()).find((r) => r.sku === '378;6')!;
}

const plain = (costScrap: number, stock: number) => ({ costScrap, stock, special: null });
const painted = (costScrap: number, stock: number) => ({ costScrap, stock, special: special({ paint: 8154199 }) });
const parted = (costScrap: number, stock: number) => ({ costScrap, stock, special: special({ parts: ['Burning Player Kills'] }) });

describe('Live market: equal-price copies seen at one time (F40)', () => {
  it('shows the plain copy over a painted one stored after it at the same price', () => {
    const r = rowFor([plain(57, 2), painted(57, 1)]);
    expect(r).toMatchObject({ knownCostScrap: 57, stock: 2, knownSource: 'page' });
    expect(r.flags).not.toContain('has-extras');
  });

  it('whatever the order the copies were stored in', () => {
    const r = rowFor([painted(57, 1), plain(57, 2)]);
    expect(r).toMatchObject({ knownCostScrap: 57, stock: 2 });
    expect(r.flags).not.toContain('has-extras');
  });

  it('a strange part counts as extras too', () => {
    const r = rowFor([plain(57, 4), parted(57, 1)]);
    expect(r).toMatchObject({ stock: 4 });
    expect(r.flags).not.toContain('has-extras');
  });

  it('a cheaper copy with extras still wins and is flagged', () => {
    const r = rowFor([plain(57, 2), painted(56, 1)]);
    expect(r).toMatchObject({ knownCostScrap: 56, stock: 1 });
    expect(r.flags).toContain('has-extras');
  });
});

describe('mock parity: mockKnownAt (F40)', () => {
  const price = (id: number, costScrap: number, sp: SpecialAttrs | null): ScrapPrice => ({
    id,
    sku: '378;6',
    name: 'Team Captain',
    costKeys: 0,
    costScrap,
    source: 'import',
    observedAt: SEEN,
    note: null,
    importBatch: null,
    stock: 1,
    assetId: null,
    special: sp,
    bank: null,
  });

  it('picks the plain copy on an equal cost, the cheaper one otherwise', () => {
    const k = mockKnownPrices([price(1, 57, null), price(2, 57, special({ paint: 8154199 }))]).get('378;6');
    expect(mockKnownAt(k, 567)?.id).toBe(1);
    const k2 = mockKnownPrices([price(1, 57, special({ paint: 8154199 })), price(2, 57, null)]).get('378;6');
    expect(mockKnownAt(k2, 567)?.id).toBe(2);
    const k3 = mockKnownPrices([price(1, 57, null), price(2, 56, special({ paint: 8154199 }))]).get('378;6');
    expect(mockKnownAt(k3, 567)?.id).toBe(2);
    // Two plain copies still tie on the higher id.
    const k4 = mockKnownPrices([price(1, 57, null), price(2, 57, null)]).get('378;6');
    expect(mockKnownAt(k4, 567)?.id).toBe(2);
  });
});
