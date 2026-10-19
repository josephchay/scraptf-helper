// F17 in the item drawer: ItemDetail.bankStock is the item in the newest bank-stock save that lists its
// copy (BankStock.detailFor, which item.detail passes to buildItemDetail): which bank, that save's time,
// its change since the previous save and its stock; null when no kept save lists it. Real in-memory
// repo and bank stock cache; pages the user saved only (R10), no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import { buildItemDetail } from '../../src/service/domain/views';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import type { BankStockStored, KeyPriceState, ScraptfBank, UnixMs } from '../../src/shared/types';
import { HOUR, MIN, T0, createStubSchema, makeListing, silentLogger, testSettings } from './helpers';

const KP: KeyPriceState = { valueScrap: 567, source: 'pricedb', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };
const snapshot = { lastAt: T0 - HOUR, available: true, nextAllowedAt: null };
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: 'Team Captain', costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): void {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows);
}

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertListings([makeListing({ id: 'tc', steamid: 'A', metalScrap: 120 })]);
  const stock = createBankStock({
    clock: { now: () => T0 },
    log: silentLogger,
    repo,
    market: { entryFor: () => null },
    keyPrice: () => KP,
    settings: () => testSettings(),
    categoryOf: () => 'hats',
  });
  // As the 'item.detail' handler builds it: bankStock: ctx.bankStock.detailFor(sku).
  const detail = (sku: string) =>
    buildItemDetail({ repo, schema: createStubSchema(), sku, keyPrice: KP, settings: testSettings(), now: T0, snapshot, bankStock: stock.detailFor(sku) })!;
  return { repo, stock, detail };
}

describe('ItemDetail.bankStock (F17)', () => {
  it('is null when no kept save lists the item, and when the handler passes nothing', () => {
    const h = setup();
    expect(h.detail('378;6').bankStock).toBeNull();
    const plain = buildItemDetail({ repo: h.repo, schema: createStubSchema(), sku: '378;6', keyPrice: KP, settings: testSettings(), now: T0, snapshot })!;
    expect(plain.bankStock).toBeNull();
  });

  it('says where and when the item was on sale, and what changed since the save before', () => {
    const h = setup();
    const painted = bankStockSpecialKey({ paint: 3100495 });
    save(h.repo, 'hats', T0 - 3 * HOUR, [s('378;6', 45, { stock: 2 })]);
    save(h.repo, 'hats', T0 - 12 * MIN, [s('378;6', 40, { stock: 3 }), s('378;6', 70, { specialKey: painted })]);
    expect(h.detail('378;6').bankStock).toEqual({ bank: 'hats', savedAt: T0 - 12 * MIN, change: 'cheaper', previousCostScrap: 45, stock: 3 });
    // The painted copy is its own row: new since the previous save.
    expect(h.detail('378;6;p3100495').bankStock).toEqual({ bank: 'hats', savedAt: T0 - 12 * MIN, change: 'new', previousCostScrap: null, stock: 1 });
  });
});
