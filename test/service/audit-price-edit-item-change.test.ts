// 0.7.3 (audit rpc-2, rpagesA-3): a price edited to another item on the Prices page keeps its id, but the
// old copy's extras, asset id, stock and import page describe the old item: they are dropped, as a new
// typed price of the new item would have none. An edit of the same item still keeps them (Seen now, the
// drawer, a price-only edit), and the old item's opportunity is recomputed at once. Nothing is fetched.

import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ScrapPrice, SpecialAttrs } from '../../src/shared/types';
import { createStubSchema } from '../import/schemaStub';

const NOW = 1_800_000_000_000;
const PINK = 15185211;
const EXTRAS: SpecialAttrs = { paint: PINK, spells: ['Exorcism'], parts: [], sheen: null, killstreaker: null, customName: true, customDesc: false };
const EMPTY: SpecialAttrs = { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const dirty: string[][] = [];
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    http: { isPaused: () => false },
    engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: (skus: Iterable<string>) => dirty.push([...skus].sort()) } as unknown as Engine,
    settings: () => settings,
    secret: () => null,
    push: quiet,
    pricesChanged: quiet,
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  const call = async (method: string, params: unknown) => (await rpc(method, params)) as ScrapPrice;
  return { repo, call, dirty };
}

/** An imported, painted and spelled Team Captain with its asset id, stock and page. */
function importedCaptain(repo: Repo): ScrapPrice {
  const batch = repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: NOW - 3_600_000, importedAt: NOW - 3_600_000, itemCount: 1, bank: 'hats' });
  return repo.upsertScrapPrice({
    sku: '378;6',
    name: 'The Team Captain',
    costKeys: 1,
    costScrap: 10,
    source: 'import',
    observedAt: NOW - 3_600_000,
    note: null,
    importBatch: batch,
    special: EXTRAS,
    assetId: '123',
    stock: 3,
  });
}

/** What the Prices page's form sends for an edit (PriceForm): no extras, asset, stock or batch. */
const formEdit = (p: ScrapPrice, sku: string, name: string, costScrap: number) => ({ id: p.id, sku, name, costKeys: 0, costScrap, source: 'user', observedAt: NOW, note: null });

describe('prices.upsert of a row moved to another item (rpc-2)', () => {
  it("drops the old copy's extras, asset id, stock and page, and keeps the id", async () => {
    const h = setup();
    const before = importedCaptain(h.repo);
    const saved = await h.call('prices.upsert', formEdit(before, '126;6', "Bill's Hat", 30));
    expect(saved).toMatchObject({ id: before.id, sku: '126;6', name: "Bill's Hat", costScrap: 30, source: 'user', special: null, assetId: null, stock: null, importBatch: null, bank: null });
    expect(h.repo.getScrapPrice(before.id)).toEqual(saved);
    // The old item lists it no more; the new one lists it with nothing carried over.
    expect(h.repo.scrapPricesForSku('378;6')).toEqual([]);
    expect(h.repo.scrapPricesForSku('126;6')).toEqual([saved]);
  });

  it('a move to a painted SKU records that paint only', async () => {
    const h = setup();
    const before = importedCaptain(h.repo);
    const saved = await h.call('prices.upsert', formEdit(before, `126;6;p${PINK}`, "Bill's Hat", 30));
    expect(saved).toMatchObject({ id: before.id, sku: '126;6', special: { ...EMPTY, paint: PINK }, assetId: null, stock: null, importBatch: null });
  });

  it('keeps what the caller sends with the move', async () => {
    const h = setup();
    const before = importedCaptain(h.repo);
    const special: SpecialAttrs = { ...EMPTY, spells: ['Halloween Fire'] };
    const saved = await h.call('prices.upsert', { ...formEdit(before, '126;6', "Bill's Hat", 30), special, assetId: '987', stock: 1 });
    expect(saved).toMatchObject({ sku: '126;6', special, assetId: '987', stock: 1 });
  });

  it('an edit of the same item keeps the stored extras, asset id, stock and page', async () => {
    const h = setup();
    const before = importedCaptain(h.repo);
    const saved = await h.call('prices.upsert', formEdit(before, '378;6', 'The Team Captain', 40));
    expect(saved).toMatchObject({ id: before.id, sku: '378;6', costScrap: 40, special: EXTRAS, assetId: '123', stock: 3, importBatch: before.importBatch });
    // Seen now sends the stored row's own source.
    const seen = await h.call('prices.upsert', { id: before.id, sku: '378;6', name: 'The Team Captain', costKeys: 1, costScrap: 10, source: 'import', observedAt: NOW });
    expect(seen).toMatchObject({ source: 'import', special: EXTRAS, assetId: '123', stock: 3, importBatch: before.importBatch, bank: 'hats' });
  });

  it("recomputes the old item's opportunity at once, as a delete does", async () => {
    const h = setup();
    const before = importedCaptain(h.repo);
    await h.call('prices.upsert', formEdit(before, '126;6', "Bill's Hat", 30));
    expect(h.dirty.at(-1)).toEqual(['126;6', '378;6']);
    await h.call('prices.upsert', formEdit({ ...before, sku: '126;6' }, '126;6', "Bill's Hat", 31));
    expect(h.dirty.at(-1)).toEqual(['126;6']);
  });

  it('an unknown id still fails and writes nothing', async () => {
    const h = setup();
    await expect(h.call('prices.upsert', { id: 999, sku: '126;6', costScrap: 30 })).rejects.toThrow(/not found/);
    expect(h.repo.listScrapPrices()).toEqual([]);
  });
});
