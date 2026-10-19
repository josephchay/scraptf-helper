// F15: the scrap.tf page a saved batch came from (migration V5, import_batches.bank), stored on
// createImportBatch and joined into every ScrapPrice read. Local database only; nothing here
// touches the network.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { SCHEMA_VERSION, openRepo } from '../../src/service/db';
import { MIGRATIONS, migrate, userVersion } from '../../src/service/db/migrations';
import { SCRAPTF_BANK_IDS, type ScraptfBank } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_791_958_000_000;
const MIN = 60_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('migration V5 on an existing version 4 database', () => {
  function v4Database(): string {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const raw = new DatabaseSync(path);
    expect(migrate(raw, MIGRATIONS.slice(0, 4))).toEqual({ from: 0, to: 4, applied: [1, 2, 3, 4] });
    // What 0.4 leaves behind: a bank page batch with its categories, its imported price, a typed price.
    raw
      .prepare('INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, categories) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(7, 'scrap.tf - Buy Hats.html', 'buy', T0 - 10 * MIN, T0 - 9 * MIN, 1, '{"hats":1}');
    raw
      .prepare('INSERT INTO scrap_prices (id, sku, name, cost_keys, cost_scrap, source, observed_at, import_batch, stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(1, '378;6', 'Team Captain', 0, 30, 'import', T0 - 10 * MIN, 7, 2);
    raw
      .prepare('INSERT INTO scrap_prices (id, sku, name, cost_keys, cost_scrap, source, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(2, '378;6', 'Team Captain', 0, 28, 'user', T0 - 5 * MIN);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('kept', 'yes')").run();
    raw.close();
    return path;
  }

  it('adds a NULL bank column and keeps every row', () => {
    const path = v4Database();
    const repo = openRepo(path);
    cleanups.push(() => repo.close());

    expect(repo.getMeta('kept')).toBe('yes');
    expect(repo.listImportBatches(10)).toEqual([
      { id: 7, fileName: 'scrap.tf - Buy Hats.html', pageKind: 'buy', fileMtime: T0 - 10 * MIN, importedAt: T0 - 9 * MIN, itemCount: 1, categories: { hats: 1 }, bank: null },
    ]);
    // Older batches name no page: their prices read bank null and coverage keeps the majority rule.
    expect(repo.scrapPricesForSku('378;6').map((p) => [p.id, p.source, p.importBatch, p.bank])).toEqual([
      [2, 'user', null, null],
      [1, 'import', 7, null],
    ]);

    const check = new DatabaseSync(path);
    cleanups.push(() => check.close());
    // V6 (F17, bank stock) and later migrate on top.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(userVersion(check)).toBe(SCHEMA_VERSION);
    const cols = check
      .prepare('PRAGMA table_info(import_batches)')
      .all()
      .map((r) => r['name']);
    expect(cols).toEqual(['id', 'file_name', 'page_kind', 'file_mtime', 'imported_at', 'item_count', 'categories', 'bank']);
  });

  it('stores the bank of batches imported after the upgrade next to the old ones', () => {
    const path = v4Database();
    const repo = openRepo(path);
    cleanups.push(() => repo.close());
    const id = repo.createImportBatch({ fileName: 'scrap.tf - Buy Stranges.html', pageKind: 'buy', fileMtime: T0, importedAt: T0, itemCount: 1, categories: { stranges: 1 }, bank: 'stranges' });
    repo.upsertScrapPrice({ sku: '200;11', name: 'Strange Scattergun', costScrap: 25, source: 'import', observedAt: T0, importBatch: id, stock: 1 });
    expect(repo.listImportBatches(10).map((b) => [b.id, b.bank])).toEqual([
      [id, 'stranges'],
      [7, null],
    ]);
    expect(repo.scrapPricesForSku('200;11')[0]!.bank).toBe('stranges');
    expect(repo.scrapPricesForSku('378;6').map((p) => p.bank)).toEqual([null, null]);
  });
});

describe('import_batches.bank and ScrapPrice.bank', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = openRepo(':memory:');
  });
  afterEach(() => {
    repo.close();
  });

  const batch = (bank?: ScraptfBank | null) =>
    repo.createImportBatch({ fileName: 'page.html', pageKind: 'buy', fileMtime: T0, importedAt: T0, itemCount: 1, ...(bank === undefined ? {} : { bank }) });

  it('round-trips every bank id, and stores an omitted or unknown one as null', () => {
    for (const bank of SCRAPTF_BANK_IDS) batch(bank);
    batch();
    batch(null);
    // A newer build's id, or damage, must not reach the dashboard as a bank.
    batch('trading-cards' as ScraptfBank);
    expect(
      repo
        .listImportBatches(50)
        .map((b) => b.bank)
        .reverse(),
    ).toEqual([...SCRAPTF_BANK_IDS, null, null, null]);
  });

  it('joins the batch bank into every price read, and typed or orphaned prices read null', () => {
    const hats = batch('hats');
    const list = batch('list');
    const imported = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 30, source: 'import', observedAt: T0 - MIN, importBatch: hats, stock: 2 });
    const fromList = repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 40, source: 'import', observedAt: T0 - 2 * MIN, importBatch: list, stock: 1 });
    const typed = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 27, source: 'user', observedAt: T0 });
    // A batch id with no batch row (a damaged database): no bank, not an error.
    const orphan = repo.upsertScrapPrice({ sku: '30359;6', name: 'Juggernaut Jacket', costScrap: 12, source: 'import', observedAt: T0 - 3 * MIN, importBatch: 999 });

    // The upsert's own answer is a read too.
    expect([imported.bank, fromList.bank, typed.bank, orphan.bank]).toEqual(['hats', 'list', null, null]);
    expect(repo.getScrapPrice(imported.id)!.bank).toBe('hats');
    expect(repo.listScrapPrices().map((p) => [p.id, p.bank])).toEqual([
      [typed.id, null],
      [imported.id, 'hats'],
      [fromList.id, 'list'],
      [orphan.id, null],
    ]);
    // Search still matches the price's own name and SKU (the join adds the batch's columns).
    expect(repo.listScrapPrices('captain').map((p) => [p.id, p.bank])).toEqual([
      [typed.id, null],
      [imported.id, 'hats'],
    ]);
    expect(repo.listScrapPrices('126;6').map((p) => p.bank)).toEqual(['list']);
    expect(repo.scrapPricesForSku('378;6').map((p) => p.bank)).toEqual([null, 'hats']);
  });

  it('keeps the bank following the batch when a later import re-tags the row', () => {
    const hats = batch('hats');
    const list = batch('list');
    const p = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 30, source: 'import', observedAt: T0 - MIN, importBatch: hats });
    // importSavedPage rewrites a shared row in place under the newer batch id.
    const moved = repo.upsertScrapPrice({ id: p.id, sku: '378;6', name: 'Team Captain', costScrap: 29, source: 'import', observedAt: T0, importBatch: list });
    expect(moved.bank).toBe('list');
    // Typing over it keeps the batch id (omitted fields keep their values), but a typed price was seen
    // on no page (spec S3: typed prices have none), on every read.
    const edited = repo.upsertScrapPrice({ id: p.id, sku: '378;6', name: 'Team Captain', costScrap: 28, source: 'user', observedAt: T0 + MIN });
    expect([edited.importBatch, edited.bank]).toEqual([list, null]);
    expect(repo.getScrapPrice(p.id)!.bank).toBeNull();
    expect(repo.listScrapPrices().map((x) => [x.id, x.bank])).toEqual([[p.id, null]]);
    expect(repo.scrapPricesForSku('378;6').map((x) => x.bank)).toEqual([null]);
    // Imported again (a newer save rewrites it in place): the batch's bank again.
    const reimported = repo.upsertScrapPrice({ id: p.id, sku: '378;6', name: 'Team Captain', costScrap: 27, source: 'import', observedAt: T0 + 2 * MIN, importBatch: hats });
    expect(reimported.bank).toBe('hats');
  });
});

describe('an unknown stored bank', () => {
  it('reads as null for the batch and its prices', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const raw = new DatabaseSync(path);
    migrate(raw);
    // Written by a newer build (or damaged): never handed on as a bank.
    raw.prepare("INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, bank) VALUES (1, 'p.html', 'buy', 1, 1, 1, 'trading-cards')").run();
    raw.prepare("INSERT INTO scrap_prices (sku, name, cost_scrap, source, observed_at, import_batch) VALUES ('378;6', 'Team Captain', 30, 'import', 1, 1)").run();
    raw.close();
    const repo = openRepo(path);
    cleanups.push(() => repo.close());
    expect(repo.listImportBatches(1)[0]!.bank).toBeNull();
    expect(repo.scrapPricesForSku('378;6')[0]!.bank).toBeNull();
  });
});
