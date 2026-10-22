// 0.9 (#17): PriceDb.loadedKeyHistory, the key history Holdings' key move band reads: whatever the key curve cache
// already holds (filled when the drawer's history load prices an item in keys, and now also by history('5021;6')
// itself), never a request of its own. history('5021;6') filling the cache can only save a later identical key
// request. Fake HTTP and clock (audit-key-history-clock-step.test.ts's harness); nothing touches the network.

import { describe, expect, it } from 'vitest';
import { createPriceDb } from '../../src/service/connectors/pricedb';
import type { HttpResponse } from '../../src/service/contracts';
import { refToScrap } from '../../src/shared/currency';
import { KEY_SKU } from '../../src/shared/types';
import { fixture, makeDeps, res } from './helpers';

const MIN = 60_000;
const ITEM = '205;11;australium';

interface Rec {
  time: number;
  buy: { keys?: number; metal?: number };
  sell: { keys?: number; metal?: number };
}

function historyRoute(map: Record<string, unknown>) {
  return (url: string): HttpResponse => {
    const m = /\/item-history\/([^?]+)/.exec(url);
    const sku = m ? decodeURIComponent(m[1]!) : '';
    return sku in map ? res(map[sku]) : res({ error: 'Item not found' }, { status: 404 });
  };
}

function setup() {
  const deps = makeDeps(historyRoute({ '5021;6': fixture('item-history-key.json'), [ITEM]: fixture('item-history-australium.json') }));
  const pdb = createPriceDb(deps);
  const keyFetches = (): number => deps.http.urls().filter((u) => decodeURIComponent(u).includes('/item-history/5021;6')).length;
  return { deps, pdb, keyFetches };
}

/** The key fixture as the key curve holds it: by time, each side's metal-only price in scrap. */
function fixturePoints() {
  const side = (s: Rec['buy']) => ((s.keys ?? 0) === 0 && (s.metal ?? 0) > 0 ? refToScrap(s.metal ?? 0) : null);
  return fixture<Rec[]>('item-history-key.json')
    .filter((r) => r.time > 0)
    .sort((a, b) => a.time - b.time)
    .map((r) => ({ t: Math.floor(r.time), buyScrap: side(r.buy), sellScrap: side(r.sell) }));
}

describe('PriceDb.loadedKeyHistory (0.9, #17)', () => {
  it('is null before any history was loaded', () => {
    const { deps, pdb } = setup();
    expect(pdb.loadedKeyHistory()).toBeNull();
    expect(deps.http.calls).toHaveLength(0);
  });

  it('after an item priced in keys is loaded, holds the key curve that priced it, stamped with its load time', async () => {
    const { deps, pdb, keyFetches } = setup();
    expect((await pdb.history(ITEM)).length).toBeGreaterThan(0);
    expect(keyFetches()).toBe(1);
    const loaded = pdb.loadedKeyHistory();
    expect(loaded).toEqual({ loadedAt: deps.clock.now(), points: fixturePoints() });
    expect(loaded!.points.length).toBeGreaterThan(30);
  });

  it("history('5021;6') fills the cache, so a following item load within 30 min sends no second key request", async () => {
    const { deps, pdb, keyFetches } = setup();
    expect(KEY_SKU).toBe('5021;6');
    expect((await pdb.history(KEY_SKU)).length).toBeGreaterThan(0);
    expect(keyFetches()).toBe(1);
    expect(pdb.loadedKeyHistory()).toEqual({ loadedAt: deps.clock.now(), points: fixturePoints() });
    deps.clock.advance(10 * MIN);
    await pdb.history(ITEM);
    expect(keyFetches()).toBe(1);
  });

  it('reading it sends nothing, and it ignores the cache TTL (the band says when it was loaded)', async () => {
    const { deps, pdb } = setup();
    await pdb.history(ITEM);
    const at = deps.clock.now();
    const calls = deps.http.calls.length;
    deps.clock.advance(3 * 60 * MIN);
    for (let i = 0; i < 3; i++) expect(pdb.loadedKeyHistory()?.loadedAt).toBe(at);
    expect(deps.http.calls).toHaveLength(calls);
  });

  it('falls back to the newest windowed curve when no window-less one is cached', async () => {
    const { deps, pdb } = setup();
    await pdb.history(KEY_SKU, 1_791_000_000, 1_792_000_000);
    const first = deps.clock.now();
    deps.clock.advance(MIN);
    await pdb.history(KEY_SKU, 1_791_500_000, 1_792_000_000);
    expect(pdb.loadedKeyHistory()?.loadedAt).toBe(first + MIN);
    // A window-less load wins over the windows, however old.
    deps.clock.advance(MIN);
    await pdb.history(KEY_SKU);
    const plain = deps.clock.now();
    deps.clock.advance(MIN);
    await pdb.history(KEY_SKU, 1_791_600_000, 1_792_000_000);
    expect(pdb.loadedKeyHistory()?.loadedAt).toBe(plain);
  });

  it('an item load that never priced keys caches no curve', async () => {
    const { pdb, keyFetches } = setup();
    // Not in the route (404): no records, so no key curve was needed or fetched.
    expect(await pdb.history('378;6')).toEqual([]);
    expect(keyFetches()).toBe(0);
    expect(pdb.loadedKeyHistory()).toBeNull();
  });
});
