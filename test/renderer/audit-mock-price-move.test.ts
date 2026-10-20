// 0.7.3 (follow-up to rpc-2): the dev preview's prices.upsert and prices.bulkUpsert kept a row's
// extras, asset id, stock and import batch when the row was edited to another item, where the service
// (rpcHandlers.ts priceRow, audit-price-edit-item-change.test.ts) reads them null as on a new price. The
// browser mock now follows the same rule. In-memory only; nothing leaves the process.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { ScrapPrice, SpecialAttrs } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const EXTRAS: SpecialAttrs = { paint: 15185211, spells: ['Exorcism'], parts: [], sheen: null, killstreaker: null, customName: true, customDesc: false };

let bridge: MockBridge | null = null;
afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

/** The mock with an imported, painted and spelled Team Captain carrying its asset id, stock and batch. */
async function setup() {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const before = (await b.rpc('prices.upsert', {
    sku: '378;6',
    name: 'The Team Captain',
    costKeys: 1,
    costScrap: 10,
    source: 'import',
    observedAt: T0 - 3_600_000,
    importBatch: 7,
    special: EXTRAS,
    assetId: '123',
    stock: 3,
  })) as ScrapPrice;
  return { b, before };
}

/** What the Prices page's form sends for an edit: no extras, asset, stock or batch. */
const formEdit = (p: ScrapPrice, sku: string, costScrap: number) => ({ id: p.id, sku, costKeys: 0, costScrap, source: 'user' as const, observedAt: T0, note: null });

describe('the browser mock: a price row moved to another item', () => {
  it("prices.upsert drops the old copy's extras, asset id, stock and batch, and keeps the id", async () => {
    const { b, before } = await setup();
    const saved = (await b.rpc('prices.upsert', formEdit(before, '126;6', 30))) as ScrapPrice;
    expect(saved).toMatchObject({ id: before.id, sku: '126;6', costScrap: 30, special: null, assetId: null, stock: null, importBatch: null });
    const listed = (await b.rpc('prices.list', {})).find((p) => p.id === before.id);
    expect(listed).toMatchObject({ sku: '126;6', special: null, assetId: null, stock: null, importBatch: null });
  });

  it('prices.upsert keeps what the caller sends with the move', async () => {
    const { b, before } = await setup();
    const special: SpecialAttrs = { ...EXTRAS, paint: null, spells: ['Halloween Fire'] };
    const saved = (await b.rpc('prices.upsert', { ...formEdit(before, '126;6', 30), special, assetId: '987', stock: 1 })) as ScrapPrice;
    expect(saved).toMatchObject({ sku: '126;6', special, assetId: '987', stock: 1 });
  });

  it('prices.upsert of the same item still keeps them', async () => {
    const { b, before } = await setup();
    const saved = (await b.rpc('prices.upsert', formEdit(before, '378;6', 40))) as ScrapPrice;
    expect(saved).toMatchObject({ id: before.id, costScrap: 40, special: EXTRAS, assetId: '123', stock: 3, importBatch: 7 });
  });

  it('prices.bulkUpsert follows the same rule', async () => {
    const { b, before } = await setup();
    expect(await b.rpc('prices.bulkUpsert', { rows: [{ id: before.id, sku: '378;6', costScrap: 41 }] })).toEqual({ added: 0, updated: 1 });
    let row = (await b.rpc('prices.list', {})).find((p) => p.id === before.id);
    expect(row).toMatchObject({ costScrap: 41, special: EXTRAS, assetId: '123', stock: 3 });
    expect(await b.rpc('prices.bulkUpsert', { rows: [{ id: before.id, sku: '126;6', costScrap: 42 }] })).toEqual({ added: 0, updated: 1 });
    row = (await b.rpc('prices.list', {})).find((p) => p.id === before.id);
    expect(row).toMatchObject({ sku: '126;6', costScrap: 42, special: null, assetId: null, stock: null, importBatch: null });
  });
});
