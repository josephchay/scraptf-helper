// 0.7.3 follow-up (fu-clock-2): PriceDB's key-price history, used to value an item's key prices, is cached
// for 30 min. A clock stepped back while running left the cached copy "younger than 30 min" for the size of
// the step plus 30 min; one cached in the future now has no known age and is fetched again.

import { describe, expect, it } from 'vitest';
import { createPriceDb } from '../../src/service/connectors/pricedb';
import type { HttpResponse } from '../../src/service/contracts';
import { fixture, makeDeps, res } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const ITEM = '205;11;australium';

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

describe('PriceDB key-price history cache', () => {
  it('is reused for 30 min', async () => {
    const { deps, pdb, keyFetches } = setup();
    expect((await pdb.history(ITEM)).length).toBeGreaterThan(0);
    expect(keyFetches()).toBe(1);
    deps.clock.advance(29 * MIN);
    await pdb.history(ITEM);
    expect(keyFetches()).toBe(1);
    deps.clock.advance(2 * MIN);
    await pdb.history(ITEM);
    expect(keyFetches()).toBe(2);
  });

  it('is fetched again after the clock stepped back past it, then cached anew', async () => {
    const { deps, pdb, keyFetches } = setup();
    await pdb.history(ITEM);
    expect(keyFetches()).toBe(1);
    deps.clock.advance(10 * MIN);
    deps.clock.advance(-8 * HOUR);
    await pdb.history(ITEM);
    expect(keyFetches()).toBe(2);
    deps.clock.advance(MIN);
    await pdb.history(ITEM);
    expect(keyFetches()).toBe(2);
  });
});
