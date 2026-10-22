// 0.7.3: V11/V12 deleted the bare kit prices of a killstreaks look that wrote no bank stock save (a partial
// look, an unsettled window snapshot, a file import from before 0.6) but left its item_count, so the Banks
// page and the coverage strip still dated Killstreaks with the deleted kits' count. V13 zeroes those batches.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import { MIGRATIONS, migrate } from '../../src/service/db/migrations';
import { batchItemCounts, mergeBankNewestSaves, wholeLookNewestSaves } from '../../src/shared/market';
import { tempDir } from './helpers';

const T0 = 1_791_958_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function dbAt(version: number): { db: DatabaseSync; file: string } {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const file = t.file();
  const db = new DatabaseSync(file);
  migrate(db, MIGRATIONS.slice(0, version));
  return { db, file };
}

const batch = (db: DatabaseSync, id: number, bank: string, items: number): void => {
  db.prepare("INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, bank, origin) VALUES (?, ?, 'buy', ?, ?, ?, ?, 'window')").run(id, `scrap.tf window /buy/${bank}`, T0 + id, T0 + id, items, bank);
};
const row = (db: DatabaseSync, id: number, bank: string, sku: string): void => {
  db.prepare("INSERT INTO bank_stock (batch_id, bank, sku, name, cost_keys, cost_scrap, stock, page) VALUES (?, ?, ?, 'Kit', 0, 9, 1, ?)").run(id, bank, sku, `/buy/${bank}`);
};
const save = (db: DatabaseSync, id: number, bank: string, items: number): void => {
  db.prepare('INSERT INTO bank_stock_saves (batch_id, bank, page, items) VALUES (?, ?, ?, ?)').run(id, bank, `/buy/${bank}`, items);
};
const price = (db: DatabaseSync, id: number, sku: string): void => {
  db.prepare("INSERT INTO scrap_prices (sku, name, cost_keys, cost_scrap, source, observed_at, import_batch) VALUES (?, 'Kit', 0, 9, 'import', ?, ?)").run(sku, T0 + id, id);
};
const itemCount = (db: DatabaseSync, id: number): number =>
  (db.prepare('SELECT item_count FROM import_batches WHERE id = ?').get(id) as { item_count: number }).item_count;

const KITS = ['6526;6', '6523;6', '6527;6'];

describe('migration V13: killstreaks looks left with no prices and no bank stock save', () => {
  it('is migration 13', () => {
    expect(MIGRATIONS[12]).toMatchObject({ version: 13 });
  });

  it('reads Killstreaks as never saved when a look with no save stored only bare kits (from V10)', () => {
    const { db, file } = dbAt(10);
    // Batch 40: a whole look of bare kits, with its save. Batch 41: a later unsettled or partial look that
    // stored the same bare kits' prices but wrote no save. Batch 30: a hats save beside them.
    batch(db, 40, 'killstreaks', 3);
    for (const sku of KITS) row(db, 40, 'killstreaks', sku);
    save(db, 40, 'killstreaks', 3);
    batch(db, 41, 'killstreaks', 3);
    for (const sku of KITS) price(db, 41, sku);
    batch(db, 30, 'hats', 1);
    row(db, 30, 'hats', '378;6');
    save(db, 30, 'hats', 1);
    price(db, 30, '378;6');
    db.close();

    const repo = openRepo(file);
    cleanups.push(() => repo.close());
    const extra = repo.bankNewestSaves();
    expect(extra.map((s) => s.bank)).not.toContain('killstreaks');
    const newest = wholeLookNewestSaves(mergeBankNewestSaves(new Map(), extra), (b) => repo.bankStockSaves(b, 1)[0], batchItemCounts([], extra));
    expect(newest.get('killstreaks')).toBeUndefined();
    expect(newest.get('hats')).toMatchObject({ id: 30, items: 1 });

    const raw = new DatabaseSync(file);
    cleanups.push(() => raw.close());
    expect(itemCount(raw, 41)).toBe(0);
    expect(itemCount(raw, 30)).toBe(1);
  });

  it("zeroes such a look on the user's database, which has already run V12", () => {
    const { db, file } = dbAt(12);
    // V12 already deleted this look's bare kit prices and it never had a save.
    batch(db, 41, 'killstreaks', 52);
    db.close();

    const repo = openRepo(file);
    cleanups.push(() => repo.close());
    expect(repo.bankNewestSaves().map((s) => s.bank)).not.toContain('killstreaks');
    const raw = new DatabaseSync(file);
    cleanups.push(() => raw.close());
    expect(itemCount(raw, 41)).toBe(0);
  });

  it('keeps the count of a look that still has a price or a save, of other banks and of the /items list', () => {
    const { db } = dbAt(12);
    cleanups.push(() => db.close());
    // 50: killstreaks, no save, a kit with its target still priced under it.
    batch(db, 50, 'killstreaks', 1);
    price(db, 50, '6526;6;kt-3;td-205');
    // 51: killstreaks, a save that still has its row.
    batch(db, 51, 'killstreaks', 1);
    row(db, 51, 'killstreaks', '6526;6;uncraftable;kt-3;td-205');
    save(db, 51, 'killstreaks', 1);
    // 52: hats, no save and no price left under it (an /items list took its row over).
    batch(db, 52, 'hats', 4);
    // 53: the /items list, no save and no price under it.
    batch(db, 53, 'list', 7);

    // V13 alone (0.7.4's V14 zeroes the /items list batches it empties of prices).
    expect(migrate(db, MIGRATIONS.slice(0, 13)).applied).toEqual([13]);
    expect([50, 51, 52, 53].map((id) => itemCount(db, id))).toEqual([1, 1, 4, 7]);
  });
});
