// 0.7.4: migration V14. Every scrap.tf/items read before 0.7.4 stored an unmarked row (one entry for every
// copy scrap.tf sells at its price) as the plain Craftable copy, and nothing later could remove it: the user's
// 5040;6 at 1 key 389 scrap (the Non-Craftable copy's price on /buy/items) read as a +52 ref flip. Stored
// rows cannot tell which copy they priced, so V14 deletes everything the list wrote (its imported prices, its
// rows, its stock saves with their events) and zeroes its batches' counts; the next read rebuilds them with
// each row's craftability (scraptf_list.craft). Typed prices, the bank pages' rows and other banks' history
// stay. It also adds key_prices.price_at. A file database at V13, as the user's.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import { MIGRATIONS, SCHEMA_VERSION, migrate, userVersion } from '../../src/service/db/migrations';
import { bankSavedText } from '../../src/renderer/banksModel';
import { tempDir } from './helpers';

const T0 = 1_792_496_380_093;
const HOUR_MS = 3_600_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function v13(): { db: DatabaseSync; file: string } {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const file = t.file();
  const db = new DatabaseSync(file);
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      // closed by the test already
    }
  });
  migrate(db, MIGRATIONS.slice(0, 13));
  return { db, file };
}

const batch = (db: DatabaseSync, id: number, pageKind: string, bank: string, items: number): void => {
  db.prepare("INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, bank, origin) VALUES (?, ?, ?, ?, ?, ?, ?, 'window')").run(id, `scrap.tf window ${bank}`, pageKind, T0 + id, T0 + id, items, bank);
};
const price = (db: DatabaseSync, batchId: number | null, sku: string, source: string, note: string | null = null): void => {
  db.prepare('INSERT INTO scrap_prices (sku, name, cost_keys, cost_scrap, source, observed_at, note, import_batch) VALUES (?, ?, 1, 389, ?, ?, ?, ?)').run(sku, 'A Distinctive Lack of Hue', source, T0, note, batchId);
};
const stockRow = (db: DatabaseSync, batchId: number, bank: string, page: string, sku: string, stock: number | null): void => {
  db.prepare("INSERT INTO bank_stock (batch_id, bank, sku, name, cost_keys, cost_scrap, stock, page) VALUES (?, ?, ?, 'x', 1, 389, ?, ?)").run(batchId, bank, sku, stock, page);
};
const saveRow = (db: DatabaseSync, batchId: number, bank: string, page: string, items: number): void => {
  db.prepare('INSERT INTO bank_stock_saves (batch_id, bank, page, items) VALUES (?, ?, ?, ?)').run(batchId, bank, page, items);
};
const event = (db: DatabaseSync, batchId: number, bank: string, sku: string): void => {
  db.prepare("INSERT INTO scraptf_events (at, bank, sku, name, kind, batch_id) VALUES (?, ?, ?, 'x', 'gone', ?)").run(T0, bank, sku, batchId);
};
const all = (db: DatabaseSync, sql: string): unknown[] => db.prepare(sql).all().map((r) => ({ ...r }));

/** The user's V13 state, in small: a stockless list save (8), an unsettled list read with prices (33), a /buy/items save (36). */
function seed(db: DatabaseSync): void {
  batch(db, 8, 'items-list', 'list', 698);
  batch(db, 33, 'items-list', 'list', 341);
  batch(db, 36, 'buy', 'items', 2);
  // The mis-keyed list price, a list-only one, and the bank's own Non-Craftable card.
  price(db, 33, '5040;6', 'import');
  price(db, 33, '5039;6', 'import');
  price(db, 36, '5040;6;uncraftable', 'import');
  // Typed prices stay, a "Use as my price" copy of the list included.
  price(db, null, '5040;6', 'user', 'from scrap.tf list');
  price(db, 33, '378;6', 'user');
  db.prepare("INSERT INTO scraptf_list (sku, name, sells_keys, sells_scrap, pays_keys, pays_scrap, stock, stock_limit, batch_id, observed_at) VALUES ('5040;6', 'A Distinctive Lack of Hue', 1, 389, 1, 333, 4, 25, 33, ?)").run(T0);
  // The pre-0.7.1 list save: every row with no stock (read as on sale), with an event of its own.
  stockRow(db, 8, 'list', '/items', '5040;6', null);
  stockRow(db, 8, 'list', '/items', '405;14', null);
  saveRow(db, 8, 'list', '/items', 2);
  event(db, 8, 'list', '405;14');
  // The items bank's save and event stay.
  stockRow(db, 36, 'items', '/buy/items', '5040;6;uncraftable', 2);
  saveRow(db, 36, 'items', '/buy/items', 1);
  event(db, 36, 'items', '5833;6;uncraftable');
}

describe('migration V14: scrap.tf/items data stored without its craftability', () => {
  it('is migration 14', () => {
    expect(MIGRATIONS[13]).toMatchObject({ version: 14, name: 'remove scrap.tf/items list data stored without its craftability' });
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
  });

  it("deletes everything the list wrote and keeps typed prices and the bank pages' data", () => {
    const { db } = v13();
    seed(db);
    expect(migrate(db, MIGRATIONS.slice(0, 14)).applied).toEqual([14]);
    expect(userVersion(db)).toBe(14);

    expect(all(db, 'SELECT sku, source, import_batch FROM scrap_prices ORDER BY id')).toEqual([
      { sku: '5040;6;uncraftable', source: 'import', import_batch: 36 },
      { sku: '5040;6', source: 'user', import_batch: null },
      { sku: '378;6', source: 'user', import_batch: 33 },
    ]);
    expect(all(db, 'SELECT * FROM scraptf_list')).toEqual([]);
    expect(all(db, 'SELECT batch_id, bank, sku FROM bank_stock')).toEqual([{ batch_id: 36, bank: 'items', sku: '5040;6;uncraftable' }]);
    expect(all(db, 'SELECT batch_id, bank FROM bank_stock_saves')).toEqual([{ batch_id: 36, bank: 'items' }]);
    expect(all(db, 'SELECT batch_id, bank FROM scraptf_events')).toEqual([{ batch_id: 36, bank: 'items' }]);
    // The list's batches stay (the Import page's history), counting nothing; the bank's keeps its count.
    expect(all(db, 'SELECT id, item_count FROM import_batches ORDER BY id')).toEqual([
      { id: 8, item_count: 0 },
      { id: 33, item_count: 0 },
      { id: 36, item_count: 2 },
    ]);
  });

  it('adds scraptf_list.craft (unproven by default) and key_prices.price_at', () => {
    const { db } = v13();
    migrate(db);
    const cols = (table: string) => all(db, `PRAGMA table_info(${table})`) as { name: string; dflt_value: unknown; notnull: number }[];
    expect(cols('scraptf_list').find((c) => c.name === 'craft')).toMatchObject({ dflt_value: "'any'", notnull: 1 });
    expect(cols('key_prices').find((c) => c.name === 'price_at')).toMatchObject({ notnull: 0 });
    // 0.7.4 (R01/R06, R02): the list's stock rows carry their craftability (NULL on a card), and a list row
    // the page it was read on ('' when not known).
    expect(cols('bank_stock').find((c) => c.name === 'craft')).toMatchObject({ notnull: 0, dflt_value: null });
    expect(cols('scraptf_list').find((c) => c.name === 'page')).toMatchObject({ dflt_value: "''", notnull: 1 });
    db.prepare("INSERT INTO scraptf_list (sku, name, batch_id, observed_at, sells_scrap) VALUES ('126;6', 'x', 1, ?, 9)").run(T0);
    expect(all(db, "SELECT craft FROM scraptf_list WHERE sku = '126;6'")).toEqual([{ craft: 'any' }]);
  });

  it('is applied once, and the repo reads and writes the new column after it', () => {
    const { db, file } = v13();
    seed(db);
    db.close();
    const repo = openRepo(file);
    cleanups.push(() => repo.close());
    expect(repo.scraptfList()).toEqual([]);
    expect(repo.bankStockSaves('list')).toEqual([]);
    // R08: unlike a V12/V13 bank page, the zeroed list batch still dates the list (BANK_NEWEST_SAVE counts the
    // list with no rows), so the Banks list card says "no rows kept: read scrap.tf/items again".
    const listNewest = repo.bankNewestSaves().find((s) => s.bank === 'list');
    expect(listNewest).toEqual({ bank: 'list', batchId: 33, savedAt: T0 + 33, itemCount: 0 });
    const card = bankSavedText({ lastSavedAt: listNewest!.savedAt, pages: 1, items: 0, inStock: 0 }, T0 + HOUR_MS, true).text;
    expect(card).toMatch(/^read .* · no rows kept: read scrap\.tf\/items again$/);
    repo.upsertScraptfList([
      { sku: '5040;6;uncraftable', name: 'Non-Craftable A Distinctive Lack of Hue', sellsKeys: 1, sellsScrap: 389, paysKeys: 1, paysScrap: 333, stock: 4, stockLimit: 25, batchId: 40, observedAt: T0 + 1000, craft: 'uncraftable' },
      { sku: '5039;6', name: 'An Extraordinary Abundance of Tinge', sellsKeys: 1, sellsScrap: 342, paysKeys: 1, paysScrap: 252, stock: 1, stockLimit: 25, batchId: 40, observedAt: T0 + 1000 },
    ]);
    expect(repo.scraptfList().map((r) => [r.sku, r.craft])).toEqual([
      ['5039;6', 'any'],
      ['5040;6;uncraftable', 'uncraftable'],
    ]);
    const again = new DatabaseSync(file);
    cleanups.push(() => again.close());
    expect(migrate(again)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [] });
  });

  it("stores a list stock row's craft (unknown: unproven) and a list row's page; a card keeps none", () => {
    const repo = openRepo(':memory:');
    cleanups.push(() => repo.close());
    const row = { specialKey: '', name: 'x', costKeys: 1, costScrap: 389, stock: 4, assetId: null };
    const list = repo.createImportBatch({ fileName: 'items.html', pageKind: 'items-list', fileMtime: T0, importedAt: T0, itemCount: 3, bank: 'list' });
    repo.insertBankStock(list, 'list', [
      { ...row, sku: '5040;6', craft: 'any' },
      { ...row, sku: '5039;6', craft: 'craftable' },
      { ...row, sku: '5039;6;uncraftable', craft: 'nope' as never },
      { ...row, sku: '126;6' },
    ], '/items');
    expect(repo.bankStockRows(list).map((r) => [r.sku, r.craft])).toEqual([
      ['126;6', undefined],
      ['5039;6', 'craftable'],
      ['5039;6;uncraftable', 'any'],
      ['5040;6', 'any'],
    ]);
    const bank = repo.createImportBatch({ fileName: 'items bank.html', pageKind: 'buy', fileMtime: T0, importedAt: T0, itemCount: 1, bank: 'items' });
    repo.insertBankStock(bank, 'items', [{ ...row, sku: '5040;6;uncraftable', craft: 'uncraftable' }], '/buy/items');
    expect(repo.bankStockRows(bank)[0]).not.toHaveProperty('craft');
    repo.upsertScraptfList([
      { sku: '5040;6', name: 'x', sellsKeys: 1, sellsScrap: 389, paysKeys: 1, paysScrap: 333, stock: 4, stockLimit: 25, batchId: list, observedAt: T0, craft: 'any', page: '/items' },
      { sku: '5039;6', name: 'y', sellsKeys: 1, sellsScrap: 342, paysKeys: 1, paysScrap: 252, stock: 1, stockLimit: 25, batchId: list, observedAt: T0 },
    ]);
    expect(repo.scraptfListRow('5040;6')).toMatchObject({ page: '/items' });
    expect(repo.scraptfListRow('5039;6')).not.toHaveProperty('page');
  });
});
