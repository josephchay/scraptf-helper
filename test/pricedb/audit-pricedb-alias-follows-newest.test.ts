// 0.7.3: PriceDB lists some skins in both w/pk token orders. The cached alias (the form /item, /items-bulk
// and /item-history ask for) now follows the newest full-list record, back to the legacy form too, so a
// stale swapped or 404-era alias no longer keeps fetching the older record.

import { afterEach, describe, expect, it } from 'vitest';
import { LOAD_ALL_MIN_INTERVAL_MS, createPriceDb } from '../../src/service/connectors/pricedb';
import type { HttpRequestOptions, HttpResponse, Repo } from '../../src/service/contracts';
import { FakeClock, makeDeps, res } from './helpers';

const W = '15000;15;w1;pk14';
const PK = '15000;15;pk14;w1';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function rec(sku: string, buyMetal: number, time: number) {
  return { sku, name: 'Night Owl Mk.II War Paint', time, buy: { keys: 0, metal: buyMetal }, sell: { keys: 0, metal: buyMetal + 2 } };
}

/** /autob/items serves `list`; /items-bulk and /item answer each SKU with its own record from `bySku` (else 404). */
function route(state: { list: unknown[]; bySku: Record<string, unknown> }) {
  return (url: string, opts: HttpRequestOptions): HttpResponse => {
    if (url.endsWith('/autob/items')) return res({ items: state.list });
    if (url.endsWith('/items-bulk')) {
      const skus = (opts.json as { skus: string[] }).skus;
      return res(skus.filter((s) => s in state.bySku).map((s) => state.bySku[s]));
    }
    const m = /\/item\/(.+)$/.exec(url);
    const sku = m ? decodeURIComponent(m[1]!) : '';
    return sku in state.bySku ? res(state.bySku[sku]) : res({ error: 'Item not found' }, { status: 404 });
  };
}

describe('PriceDB SKU alias follows the newest record', () => {
  it('resets a swapped alias when the legacy form becomes the newer full-list record', async () => {
    const clock = new FakeClock();
    const state = { list: [rec(PK, 30, 1_000_000), rec(W, 20, 900_000)] as unknown[], bySku: {} as Record<string, unknown> };
    const deps = makeDeps(route(state), { clock });
    repos.push(deps.repo);
    const pdb = createPriceDb(deps);

    await pdb.loadAll();
    expect(deps.repo.getSkuAlias(W)).toBe(PK);

    clock.advance(LOAD_ALL_MIN_INTERVAL_MS);
    const newer = rec(W, 40, 2_000_000);
    state.list = [rec(PK, 30, 1_000_000), newer];
    state.bySku = { [PK]: rec(PK, 30, 1_000_000), [W]: newer };
    expect(await pdb.loadAll()).toBe(1);
    expect(deps.repo.getSkuAlias(W) ?? W).toBe(W);
    expect(deps.repo.getPricedb(W)?.time).toBe(2_000_000);

    deps.http.calls.length = 0;
    const rows = await pdb.bulk([W]);
    expect((deps.http.calls[0]!.opts.json as { skus: string[] }).skus).toEqual([W]);
    expect(rows.map((r) => r.time)).toEqual([2_000_000]);
    expect(deps.repo.getPricedb(W)?.time).toBe(2_000_000);
  });

  it('resets an alias cached after the legacy form 404d once, when the full list prices the legacy form', async () => {
    const state = { list: [] as unknown[], bySku: { [PK]: rec(PK, 30, 1_000_000) } as Record<string, unknown> };
    const deps = makeDeps(route(state));
    repos.push(deps.repo);
    const pdb = createPriceDb(deps);

    expect((await pdb.item(W))?.time).toBe(1_000_000);
    expect(deps.repo.getSkuAlias(W)).toBe(PK);

    state.bySku = { [PK]: rec(PK, 30, 1_000_000), [W]: rec(W, 40, 2_000_000) };
    state.list = [rec(W, 40, 2_000_000)];
    await pdb.loadAll();

    deps.http.calls.length = 0;
    expect((await pdb.item(W))?.time).toBe(2_000_000);
    expect(decodeURIComponent(deps.http.calls[0]!.url)).toBe(`https://pricedb.io/api/item/${W}`);
  });

  it('writes no alias rows for items listed only in their legacy form', async () => {
    const state = { list: [rec('5021;6', 50, 1_000_000), rec(W, 40, 1_000_000)] as unknown[], bySku: {} };
    const deps = makeDeps(route(state));
    repos.push(deps.repo);
    await createPriceDb(deps).loadAll();
    expect(deps.repo.getSkuAlias('5021;6')).toBeNull();
    expect(deps.repo.getSkuAlias(W)).toBeNull();
  });
});
