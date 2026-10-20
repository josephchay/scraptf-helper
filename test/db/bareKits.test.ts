// 0.7.2: migrations V11 and V12 remove killstreak kits a real /buy/killstreaks window read stored without their
// target weapon (every kit of a tier under one bare SKU and one price), and keeps everything else.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import { MIGRATIONS, migrate } from '../../src/service/db/migrations';
import { tempDir } from './helpers';

const T0 = 1_791_958_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function v10Db(): DatabaseSync {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const db = new DatabaseSync(t.file());
  cleanups.push(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 10));
  return db;
}

const price = (db: DatabaseSync, sku: string, source: string): void => {
  db.prepare('INSERT INTO scrap_prices (sku, name, cost_keys, cost_scrap, source, observed_at, import_batch) VALUES (?, ?, 0, 9, ?, ?, 1)').run(sku, 'Kit', source, T0);
};
const stock = (db: DatabaseSync, sku: string): void => {
  db.prepare("INSERT INTO bank_stock (batch_id, bank, sku, name, cost_keys, cost_scrap, stock, page) VALUES (1, 'killstreaks', ?, 'Kit', 0, 9, 3, '/buy/killstreaks')").run(sku);
};
const event = (db: DatabaseSync, sku: string): void => {
  db.prepare("INSERT INTO scraptf_events (at, bank, sku, name, kind, batch_id) VALUES (?, 'killstreaks', ?, 'Kit', 'new', 1)").run(T0, sku);
};
const skus = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`SELECT sku FROM ${table} ORDER BY sku`).all() as { sku: string }[]).map((r) => r.sku);

describe('migration V11: killstreak kits stored without their target', () => {
  it('is migration 11', () => {
    expect(MIGRATIONS[10]).toMatchObject({ version: 11, name: 'remove killstreak kits stored without their target' });
  });

  it('deletes bare kit prices, stock rows and events of every tier, and keeps kits with a target, typed prices and other items', () => {
    const db = v10Db();
    // The three tiers as a real read stored them, plus a bare kit carrying another token (still no target).
    for (const sku of ['6527;6', '6523;6', '6526;6', '6526;6;kt-3']) {
      price(db, sku, 'import');
      stock(db, sku);
      event(db, sku);
    }
    // Kept: a kit with its target, a typed bare kit (the user's own entry), and unrelated items.
    for (const sku of ['6526;6;kt-3;td-205', '378;6', '65270;6']) {
      price(db, sku, 'import');
      stock(db, sku);
      event(db, sku);
    }
    price(db, '6526;6', 'user');

    expect(migrate(db).to).toBe(MIGRATIONS.length);

    expect(skus(db, 'scrap_prices')).toEqual(['378;6', '6526;6', '6526;6;kt-3;td-205', '65270;6']);
    expect((db.prepare("SELECT source FROM scrap_prices WHERE sku = '6526;6'").get() as { source: string }).source).toBe('user');
    expect(skus(db, 'bank_stock')).toEqual(['378;6', '6526;6;kt-3;td-205', '65270;6']);
    expect(skus(db, 'scraptf_events')).toEqual(['378;6', '6526;6;kt-3;td-205', '65270;6']);
  });
});

describe('migration V12: bare kits again, and the bank stock saves they left empty', () => {
  function v11Db(): DatabaseSync {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const db = new DatabaseSync(t.file());
    cleanups.push(() => db.close());
    migrate(db, MIGRATIONS.slice(0, 11));
    return db;
  }
  const row = (db: DatabaseSync, batch: number, bank: string, sku: string): void => {
    db.prepare("INSERT INTO bank_stock (batch_id, bank, sku, name, cost_keys, cost_scrap, stock, page) VALUES (?, ?, ?, 'Kit', 0, 9, 1, ?)").run(batch, bank, sku, `/buy/${bank}`);
  };
  const save = (db: DatabaseSync, batch: number, bank: string, items: number): void => {
    db.prepare('INSERT INTO bank_stock_saves (batch_id, bank, page, items) VALUES (?, ?, ?, ?)').run(batch, bank, `/buy/${bank}`, items);
  };
  const batch = (db: DatabaseSync, id: number, bank: string, items: number): void => {
    db.prepare("INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, bank, origin) VALUES (?, ?, 'buy', ?, ?, ?, ?, 'window')").run(id, `scrap.tf window /buy/${bank}`, T0 + id, T0 + id, items, bank);
  };
  const itemCounts = (db: DatabaseSync): { id: number; item_count: number }[] =>
    db.prepare('SELECT id, item_count FROM import_batches ORDER BY id').all() as { id: number; item_count: number }[];
  const saves = (db: DatabaseSync): { batch_id: number; items: number }[] =>
    db.prepare('SELECT batch_id, items FROM bank_stock_saves ORDER BY batch_id').all() as { batch_id: number; items: number }[];

  it('is migration 12', () => {
    expect(MIGRATIONS[11]).toMatchObject({ version: 12 });
  });

  it('removes bare kits a read stored after V11, drops the saves left with no rows and recounts the rest', () => {
    const db = v11Db();
    for (const [id, bank, n] of [[18, 'killstreaks', 52], [24, 'killstreaks', 3], [25, 'killstreaks', 2], [30, 'hats', 2]] as const) batch(db, id, bank, n);
    // Batch 18: a killstreaks save V11 emptied but left listed (as on the user's database).
    save(db, 18, 'killstreaks', 52);
    // Batch 24: the next read, after V11, stored the bare kits again.
    for (const sku of ['6526;6', '6523;6', '6527;6']) {
      row(db, 24, 'killstreaks', sku);
      price(db, sku, 'import');
      event(db, sku);
    }
    save(db, 24, 'killstreaks', 3);
    // Batch 25: bare kits next to a kit with its target: the save stays, with one row.
    row(db, 25, 'killstreaks', '6526;6;kt-3');
    row(db, 25, 'killstreaks', '6526;6;uncraftable;kt-3;td-205');
    save(db, 25, 'killstreaks', 2);
    // Batch 30: another bank, untouched.
    row(db, 30, 'hats', '378;6');
    row(db, 30, 'hats', '30422;6');
    save(db, 30, 'hats', 2);
    price(db, '6526;6', 'user');

    expect(migrate(db).to).toBe(MIGRATIONS.length);

    expect(saves(db)).toEqual([
      { batch_id: 25, items: 1 },
      { batch_id: 30, items: 2 },
    ]);
    expect(skus(db, 'bank_stock')).toEqual(['30422;6', '378;6', '6526;6;uncraftable;kt-3;td-205']);
    expect(skus(db, 'scrap_prices')).toEqual(['6526;6']);
    expect(skus(db, 'scraptf_events')).toEqual([]);
    // The emptied saves' batches count no items, so the bank reads as never saved, not as 52 items in stock.
    expect(itemCounts(db)).toEqual([
      { id: 18, item_count: 0 },
      { id: 24, item_count: 0 },
      { id: 25, item_count: 2 },
      { id: 30, item_count: 2 },
    ]);
  });

  it("leaves no killstreaks save behind on the user's database shape, so the bank reads as never saved", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const db = new DatabaseSync(t.file());
    migrate(db, MIGRATIONS.slice(0, 11));
    // As on the user's database: save 18 emptied by V11, save 24 holding only bare kits; a hats save beside them.
    for (const [id, bank, n] of [[18, 'killstreaks', 52], [24, 'killstreaks', 52], [30, 'hats', 1]] as const) batch(db, id, bank, n);
    save(db, 18, 'killstreaks', 52);
    for (const sku of ['6526;6', '6523;6', '6527;6']) row(db, 24, 'killstreaks', sku);
    save(db, 24, 'killstreaks', 52);
    row(db, 30, 'hats', '378;6');
    save(db, 30, 'hats', 1);
    db.close();
    const repo = openRepo(t.file());
    cleanups.push(() => repo.close());
    expect(repo.bankNewestSaves().map((sv) => sv.bank)).toEqual(['hats']);
    expect(repo.bankStockSaves('killstreaks', 10)).toEqual([]);
  });

  it('changes nothing on a database with no bare kits', () => {
    const db = v11Db();
    row(db, 30, 'hats', '378;6');
    save(db, 30, 'hats', 1);
    price(db, '378;6', 'import');
    migrate(db);
    expect(saves(db)).toEqual([{ batch_id: 30, items: 1 }]);
    expect(skus(db, 'scrap_prices')).toEqual(['378;6']);
  });
});
