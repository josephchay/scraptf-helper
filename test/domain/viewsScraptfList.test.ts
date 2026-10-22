// F14 in the item drawer: ItemDetail.scraptfList is the base SKU's row from the
// user's saved scrap.tf/items list, as the list cache values it, and an item
// known only from that list still opens (named by the list). Real in-memory repo
// and list cache; nothing here touches scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { buildItemDetail } from '../../src/service/domain/views';
import { baseSku } from '../../src/shared/sku';
import type { KeyPriceState, ScraptfListStored } from '../../src/shared/types';
import { HOUR, MIN, T0, createStubSchema, makeListing, silentLogger, testSettings } from './helpers';

const K = 567;
const KP: KeyPriceState = { valueScrap: K, source: 'pricedb', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };
const snapshot = { lastAt: T0 - HOUR, available: true, nextAllowedAt: null };
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function newRepo(): Repo {
  const r = openRepo(':memory:');
  repos.push(r);
  return r;
}

function stored(over: Partial<ScraptfListStored> & { sku: string }): ScraptfListStored {
  return { name: 'Team Captain', sellsKeys: 0, sellsScrap: 90, paysKeys: 0, paysScrap: 75, stock: 2, stockLimit: 5, batchId: 1, observedAt: T0 - 3 * MIN, ...over };
}

/** As rpcHandlers' 'item.detail' builds it: the base SKU's list row at the drawer's key price. */
function detail(repo: Repo, sku: string) {
  const list = createScraptfListCache({ repo, log: silentLogger, keyPrice: () => KP });
  const base = baseSku(sku);
  return buildItemDetail({ repo, schema: createStubSchema(), sku, keyPrice: KP, settings: testSettings(), now: T0, snapshot, scraptfList: list.rowFor(base, KP.valueScrap) });
}

describe('ItemDetail.scraptfList (F14)', () => {
  it("carries the base SKU's list row as the cache values it, painted copies included", () => {
    const repo = newRepo();
    repo.upsertListings([makeListing({ id: 'tc', steamid: 'A', metalScrap: 120 })]);
    repo.upsertScraptfList([stored({ sku: '378;6' }), stored({ sku: '126;6', name: "Bill's Hat", sellsKeys: 1, sellsScrap: 5, paysKeys: 1, paysScrap: 0, stock: 5, stockLimit: 5 })]);

    const d = detail(repo, '378;6')!;
    expect(d.scraptfList).toEqual({
      sku: '378;6',
      name: 'Team Captain',
      sellsKeys: 0,
      sellsScrapRaw: 90,
      sellsScrap: 90,
      paysKeys: 0,
      paysScrapRaw: 75,
      paysScrap: 75,
      stock: 2,
      stockLimit: 5,
      full: false,
      observedAt: T0 - 3 * MIN,
      // 0.7.4: stored unmarked, so a family row; read for its own SKU, so no match field (exact).
      craft: 'any',
    });
    // A painted copy reads the clean base's row (the list shows plain copies).
    expect(detail(repo, '378;6;p3100495')!.scraptfList).toEqual(d.scraptfList);
    // Keys valued at the drawer's key price; at its limit, so full.
    expect(detail(repo, '126;6')!.scraptfList).toMatchObject({ sellsScrap: K + 5, paysScrap: K, full: true });
    // The list changes nothing else in the drawer.
    const without = buildItemDetail({ repo, schema: createStubSchema(), sku: '378;6', keyPrice: KP, settings: testSettings(), now: T0, snapshot })!;
    expect({ ...d, scraptfList: null }).toEqual(without);
    expect(d.revenue?.revenueScrap).toBe(120);
  });

  it('is null for an item not on the list, and when the caller passes none (0.3 callers)', () => {
    const repo = newRepo();
    repo.upsertScraptfList([stored({ sku: '378;6' })]);
    expect(detail(repo, '205;6')!.scraptfList).toBeNull();
    expect(buildItemDetail({ repo, schema: createStubSchema(), sku: '378;6', keyPrice: KP, settings: testSettings(), now: T0, snapshot })!.scraptfList).toBeNull();
  });

  it('opens an item known only from the saved list, named by it, and still refuses an unknown item', () => {
    const repo = newRepo();
    // Not in the (stub) schema, no orders, no prices: only the list knows it.
    repo.upsertScraptfList([stored({ sku: '99999;6', name: 'Brand New Hat' })]);
    const d = detail(repo, '99999;6')!;
    expect(d).not.toBeNull();
    expect(d).toMatchObject({ sku: '99999;6', name: 'Brand New Hat', scraptfList: { sku: '99999;6', paysScrap: 75 } });
    expect(detail(repo, '99998;6')).toBeNull();
  });

  it("keeps the schema's name over the list's", () => {
    const repo = newRepo();
    repo.upsertScraptfList([stored({ sku: '378;6', name: 'team captain (as listed)' })]);
    expect(detail(repo, '378;6')!.name).toBe('Team Captain');
  });
});
