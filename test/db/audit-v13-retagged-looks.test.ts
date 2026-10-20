// Reviews rv-import-db-1 / rv-renderer-models-1: V13 zeroed every killstreaks batch with no bank stock save
// and no price tagged to it. But every later look of a bank re-tags the import rows it shares with an
// earlier look (importSavedPage updates them in place under its own batch id), thinning drops older saves
// and a sale deletes prices, so ordinary older looks (an unsettled or partial read, a thinned whole look)
// matched too: their item counts were rewritten to 0 and the Import page blamed the 0.7.2 kit cleanup.
// V13 now zeroes only where a batch count can still date the bank: the bank has no stock save left, and
// the batch is newer than every killstreaks batch that still has a price.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { importBatchItemsRemoved } from '../../src/renderer/banksModel';
import type { Engine, Logger } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { MIGRATIONS, migrate } from '../../src/service/db/migrations';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { createStubSchema } from '../import/schemaStub';
import { tempDir } from './helpers';

const NOW = 1_800_000_000_000;
const T0 = 1_791_958_000_000;
const HOUR = 3_600_000;
const KITS_PAGE = readFileSync(fileURLToPath(new URL('../fixtures/import/buy_killstreaks.html', import.meta.url)), 'utf8');

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function dbAt(version: number): DatabaseSync {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const db = new DatabaseSync(t.file());
  cleanups.push(() => db.close());
  migrate(db, MIGRATIONS.slice(0, version));
  return db;
}

const batch = (db: DatabaseSync, id: number, items: number): void => {
  db.prepare(
    "INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, bank, origin, categories) VALUES (?, 'scrap.tf window /buy/killstreaks', 'buy', ?, ?, ?, 'killstreaks', 'window', ?)",
  ).run(id, T0 + id, T0 + id, items, JSON.stringify({ killstreaks: items }));
};
const save = (db: DatabaseSync, id: number, sku: string): void => {
  db.prepare("INSERT INTO bank_stock (batch_id, bank, sku, name, cost_keys, cost_scrap, stock, page) VALUES (?, 'killstreaks', ?, 'Kit', 0, 9, 1, '/buy/killstreaks')").run(id, sku);
  db.prepare("INSERT INTO bank_stock_saves (batch_id, bank, page, items) VALUES (?, 'killstreaks', '/buy/killstreaks', 1)").run(id);
};
const price = (db: DatabaseSync, id: number, sku: string): void => {
  db.prepare("INSERT INTO scrap_prices (sku, name, cost_keys, cost_scrap, source, observed_at, import_batch) VALUES (?, 'Kit', 0, 9, 'import', ?, ?)").run(sku, T0 + id, id);
};
const itemCount = (db: DatabaseSync, id: number): number =>
  (db.prepare('SELECT item_count FROM import_batches WHERE id = ?').get(id) as { item_count: number }).item_count;

describe('migration V13 keeps the counts of older killstreaks looks', () => {
  it("an unsettled window read whose rows a later save re-tagged keeps its count (the real import, a file database)", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = t.file();
    const repo = openRepo(file);
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      import: { enabled: true, acknowledgedAt: NOW - 4 * HOUR },
      scraptfWindow: { enabled: true, acknowledgedAt: NOW - 4 * HOUR },
    });
    const quiet = () => undefined;
    const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
    const ctx = {
      clock: { now: () => NOW },
      log,
      repo,
      schema: createStubSchema(),
      engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine,
      settings: () => settings,
      push: quiet,
      pricesChanged: quiet,
      scraptfListChanged: quiet,
      scraptfHistory: { onImport: () => 0 },
      bankStockChanged: quiet,
    } as unknown as HandlerContext;
    const first = importSavedPage(ctx, { html: KITS_PAGE, fileName: 'killstreaks.html', mtimeMs: NOW - 3 * HOUR });
    const unsettled = importSavedPage(ctx, {
      html: KITS_PAGE,
      fileName: 'scrap.tf window /buy/killstreaks',
      mtimeMs: NOW - 2 * HOUR,
      address: 'https://scrap.tf/buy/killstreaks',
      origin: 'window',
      settled: false,
    });
    const last = importSavedPage(ctx, { html: KITS_PAGE, fileName: 'killstreaks.html', mtimeMs: NOW - HOUR });
    expect([first.stockSave, unsettled.stockSave, last.stockSave]).toEqual(['written', 'unsettled', 'written']);
    expect(unsettled.stored).toBeGreaterThan(0);
    const stored = unsettled.stored;
    repo.close();

    const raw = new DatabaseSync(file);
    // The later save took the rows over: nothing is tagged to the unsettled look any more.
    expect((raw.prepare('SELECT COUNT(*) AS n FROM scrap_prices WHERE import_batch = ?').get(unsettled.batchId) as { n: number }).n).toBe(0);
    // What the 0.7.3 upgrade does: V13 runs on a database at V12.
    raw.exec('PRAGMA user_version = 12');
    raw.close();
    const again = openRepo(file);
    cleanups.push(() => again.close());
    const b = again.listImportBatches(10).find((x) => x.id === unsettled.batchId)!;
    expect(b.itemCount).toBe(stored);
    expect(importBatchItemsRemoved(b)).toBe(false);
  });

  it('with no killstreaks save, zeroes only the price-less looks newer than the newest one with a price', () => {
    const db = dbAt(12);
    batch(db, 60, 5);
    batch(db, 61, 5);
    price(db, 61, '6526;6;kt-3;td-205');
    batch(db, 62, 9);
    expect(migrate(db).applied).toEqual([13]);
    expect([60, 61, 62].map((id) => itemCount(db, id))).toEqual([5, 5, 0]);
  });

  it('with a killstreaks stock save, keeps every count: the save dates the bank', () => {
    const db = dbAt(12);
    batch(db, 70, 1);
    save(db, 70, '6526;6;uncraftable;kt-3;td-205');
    price(db, 70, '6526;6;uncraftable;kt-3;td-205');
    // A newer look with no save and no price (its rows re-tagged, sold or removed).
    batch(db, 71, 3);
    expect(migrate(db).applied).toEqual([13]);
    expect([70, 71].map((id) => itemCount(db, id))).toEqual([1, 3]);
  });

  it('a thinned look whose price a later saved look re-tagged keeps its count and is not labelled as emptied by an update', () => {
    const db = dbAt(12);
    batch(db, 60, 1);
    batch(db, 61, 1);
    price(db, 61, '6526;6;kt-3;td-205');
    save(db, 61, '6526;6;kt-3;td-205');
    expect(migrate(db).applied).toEqual([13]);
    expect([60, 61].map((id) => itemCount(db, id))).toEqual([1, 1]);
    expect(importBatchItemsRemoved({ itemCount: itemCount(db, 60), categories: { killstreaks: 1 } })).toBe(false);
  });
});
