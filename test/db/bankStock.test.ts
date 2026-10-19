// F17: the bank_stock table (migration V6) and its repo methods: the write the import uses, a bank's
// saves newest first, a save's rows, the newest pair and retention. Local database only; nothing here
// touches the network.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { MIGRATIONS, SCHEMA_VERSION, migrate, userVersion } from '../../src/service/db/migrations';
import { BANK_STOCK_MAX_AGE_MS, BANK_STOCK_MAX_SAVES_PER_PAGE } from '../../src/shared/bankStock';
import type { BankStockStored, ScraptfBank } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_791_958_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function stored(sku: string, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap: 30, stock: 1, assetId: null, ...over };
}

describe('migration V6 on an existing version 5 database', () => {
  function v5Database(): string {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const raw = new DatabaseSync(path);
    expect(migrate(raw, MIGRATIONS.slice(0, 5))).toEqual({ from: 0, to: 5, applied: [1, 2, 3, 4, 5] });
    raw
      .prepare('INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, bank) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(3, 'scrap.tf - Buy Hats.html', 'buy', T0 - 10 * MIN, T0 - 9 * MIN, 1, 'hats');
    raw.prepare("INSERT INTO meta (key, value) VALUES ('kept', 'yes')").run();
    raw.close();
    return path;
  }

  it('adds an empty bank_stock table with the spec columns, key and index, and keeps every row', () => {
    const path = v5Database();
    const repo = openRepo(path);
    cleanups.push(() => repo.close());
    expect(repo.getMeta('kept')).toBe('yes');
    expect(repo.listImportBatches(5).map((b) => [b.id, b.bank])).toEqual([[3, 'hats']]);
    // A 0.5 database has no snapshots: every bank reads "no saves".
    expect(repo.bankStockSaves('hats')).toEqual([]);
    expect(repo.bankStockLatestPair('hats')).toEqual({ newest: null, previous: null });

    const check = new DatabaseSync(path);
    cleanups.push(() => check.close());
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    expect(userVersion(check)).toBe(SCHEMA_VERSION);
    const cols = check.prepare('PRAGMA table_info(bank_stock)').all();
    expect(cols.map((c) => [c['name'], c['type'], c['notnull'], c['dflt_value'], c['pk']])).toEqual([
      ['batch_id', 'INTEGER', 1, null, 1],
      ['bank', 'TEXT', 1, null, 0],
      ['sku', 'TEXT', 1, null, 2],
      ['special_key', 'TEXT', 1, "''", 3],
      ['name', 'TEXT', 1, null, 0],
      ['cost_keys', 'REAL', 0, null, 0],
      ['cost_scrap', 'INTEGER', 0, null, 0],
      ['stock', 'INTEGER', 0, null, 0],
      ['asset_id', 'TEXT', 0, null, 0],
      ['page', 'TEXT', 1, "''", 0],
    ]);
    const index = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bank_stock' AND name NOT LIKE 'sqlite_%'").all();
    expect(index.map((r) => r['name'])).toEqual(['bank_stock_bank_batch']);
    expect(check.prepare('PRAGMA index_info(bank_stock_bank_batch)').all().map((r) => r['name'])).toEqual(['bank', 'batch_id']);
  });
});

describe('bank stock repo', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = openRepo(':memory:');
  });
  afterEach(() => {
    repo.close();
  });

  const batch = (bank: ScraptfBank | null, fileMtime: number, importedAt = fileMtime + 1_000) =>
    repo.createImportBatch({ fileName: 'page.html', pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime, importedAt, itemCount: 1, bank });

  describe('insertBankStock', () => {
    it('writes every row with a SKU, keeps the first of a repeated key, and reads them back by SKU', () => {
      const id = batch('hats', T0);
      const painted = '[5801378,[],[],null,null,false,false]';
      const n = repo.insertBankStock(id, 'hats', [
        stored('378;6', { costKeys: 1, costScrap: 22.4, stock: 3, assetId: '123' }),
        stored('378;6', { specialKey: painted, costScrap: 50 }),
        stored('126;6', { costKeys: null, costScrap: null, stock: 0 }),
        stored('378;6', { costScrap: 1 }), // the same key again: the first row stays
        stored('', { costScrap: 2 }), // no SKU: skipped
        stored('143;6', { stock: -2 }),
      ]);
      expect(n).toBe(4);
      expect(repo.bankStockRows(id)).toEqual([
        stored('126;6', { costKeys: null, costScrap: null, stock: 0 }),
        // A negative stock is not a count.
        stored('143;6', { stock: null }),
        stored('378;6', { costKeys: 1, costScrap: 22, stock: 3, assetId: '123' }),
        stored('378;6', { specialKey: painted, costScrap: 50 }),
      ]);
    });

    it('stores a row without a price to buy as null keys and metal, whatever the keys said', () => {
      const id = batch('list', T0);
      repo.insertBankStock(id, 'list', [stored('126;6', { costKeys: 2, costScrap: null, stock: 0 }), stored('94;6', { costKeys: null, costScrap: 15 })]);
      expect(repo.bankStockRows(id).map((r) => [r.sku, r.costKeys, r.costScrap])).toEqual([
        ['126;6', null, null],
        // A price in metal only: no keys.
        ['94;6', 0, 15],
      ]);
    });

    it('refuses a bad batch id or bank, and writes nothing for no rows', () => {
      const id = batch('hats', T0);
      expect(() => repo.insertBankStock(0, 'hats', [stored('378;6')])).toThrow(TypeError);
      expect(() => repo.insertBankStock(id, 'trading-cards' as ScraptfBank, [stored('378;6')])).toThrow(TypeError);
      expect(() => repo.insertBankStock(id, '__proto__' as ScraptfBank, [stored('378;6')])).toThrow(TypeError);
      expect(repo.insertBankStock(id, 'hats', [])).toBe(0);
      expect(repo.bankStockRows(id)).toEqual([]);
    });

    it('joins the caller transaction: a failed import leaves no rows behind', () => {
      const id = batch('hats', T0);
      expect(() =>
        repo.transaction(() => {
          repo.insertBankStock(id, 'hats', [stored('378;6')]);
          throw new Error('import failed');
        }),
      ).toThrow('import failed');
      expect(repo.bankStockRows(id)).toEqual([]);
    });
  });

  describe('bankStockSaves and bankStockLatestPair', () => {
    it('lists a bank\'s saves newest first by file time, else import time, with their row counts', () => {
      const older = batch('hats', T0 - 3 * HOUR);
      const newer = batch('hats', T0 - 10 * MIN);
      // Imported last but saved earliest (a catch-up scan): it is not the newest save.
      const late = batch('hats', T0 - 5 * HOUR, T0);
      // No file time: dated by its import.
      const noMtime = batch('hats', 0, T0 - 2 * HOUR);
      const other = batch('stranges', T0);
      repo.insertBankStock(older, 'hats', [stored('378;6'), stored('126;6')]);
      repo.insertBankStock(newer, 'hats', [stored('378;6')]);
      repo.insertBankStock(late, 'hats', [stored('94;6'), stored('105;6'), stored('52;6')]);
      repo.insertBankStock(noMtime, 'hats', [stored('94;6')]);
      repo.insertBankStock(other, 'stranges', [stored('200;11')]);
      expect(repo.bankStockSaves('hats')).toEqual([
        { batchId: newer, savedAt: T0 - 10 * MIN, items: 1, page: '' },
        { batchId: noMtime, savedAt: T0 - 2 * HOUR, items: 1, page: '' },
        { batchId: older, savedAt: T0 - 3 * HOUR, items: 2, page: '' },
        { batchId: late, savedAt: T0 - 5 * HOUR, items: 3, page: '' },
      ]);
      expect(repo.bankStockSaves('hats', 2).map((s) => s.batchId)).toEqual([newer, noMtime]);
      expect(repo.bankStockSaves('stranges')).toEqual([{ batchId: other, savedAt: T0, items: 1, page: '' }]);
      expect(repo.bankStockLatestPair('hats')).toEqual({
        newest: { batchId: newer, savedAt: T0 - 10 * MIN, items: 1, page: '' },
        previous: { batchId: noMtime, savedAt: T0 - 2 * HOUR, items: 1, page: '' },
      });
      expect(repo.bankStockLatestPair('stranges')).toEqual({ newest: { batchId: other, savedAt: T0, items: 1, page: '' }, previous: null });
      expect(repo.bankStockLatestPair('skins')).toEqual({ newest: null, previous: null });
    });

    it('breaks a tie in save time by the higher batch id, and reads no save for an unknown bank', () => {
      const a = batch('hats', T0);
      const b = batch('hats', T0);
      repo.insertBankStock(a, 'hats', [stored('378;6')]);
      repo.insertBankStock(b, 'hats', [stored('378;6')]);
      expect(repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([b, a]);
      expect(repo.bankStockSaves('__proto__' as ScraptfBank)).toEqual([]);
    });

    it('leaves out rows whose batch is gone (a damaged database)', () => {
      repo.insertBankStock(999, 'hats', [stored('378;6')]);
      expect(repo.bankStockSaves('hats')).toEqual([]);
      expect(repo.bankStockRows(999)).toHaveLength(1);
    });

    it('keeps which page of the bank each save is (F17: /items and /items/2 are both the list)', () => {
      const first = batch('list', T0 - HOUR);
      const second = batch('list', T0 - 10 * MIN);
      const bare = batch('list', T0 - 2 * HOUR);
      repo.insertBankStock(first, 'list', [stored('378;6'), stored('126;6')], '/items');
      repo.insertBankStock(second, 'list', [stored('5000;6')], '/items/2');
      repo.insertBankStock(bare, 'list', [stored('94;6')]);
      expect(repo.bankStockSaves('list')).toEqual([
        { batchId: second, savedAt: T0 - 10 * MIN, items: 1, page: '/items/2' },
        { batchId: first, savedAt: T0 - HOUR, items: 2, page: '/items' },
        { batchId: bare, savedAt: T0 - 2 * HOUR, items: 1, page: '' },
      ]);
      // A key read from an untrusted page is clipped.
      const long = batch('hats', T0);
      repo.insertBankStock(long, 'hats', [stored('378;6')], `/buy/hats/${'x'.repeat(500)}`);
      expect(repo.bankStockSaves('hats')[0]!.page).toHaveLength(200);
    });
  });

  describe('pruneBankStock (F20 thinning)', () => {
    // Noon UTC, so the hour and day buckets below are easy to read.
    const NOW = Math.floor(T0 / DAY) * DAY + 12 * HOUR;
    const save = (bank: ScraptfBank, at: number, page = '/buy/hats', sku = '378;6') => {
      const id = batch(bank, at);
      repo.insertBankStock(id, bank, [stored(sku), stored('126;6')], page);
      return id;
    };
    const kept = (bank: ScraptfBank) => new Set(repo.bankStockSaves(bank, 10_000).map((s) => s.batchId));

    it('keeps the last 2 h, the newest per 10 minutes to a day, per hour to 7 days and per day to 90 days, and nothing older', () => {
      expect(BANK_STOCK_MAX_AGE_MS).toBe(90 * DAY);
      expect(BANK_STOCK_MAX_SAVES_PER_PAGE).toBe(300);
      const newest = save('hats', NOW - 5 * MIN);
      const previous = save('hats', NOW - 20 * MIN);
      const sameDay = save('hats', NOW - 23 * HOUR);
      // Two in one clock hour two days ago: the newer stays.
      const hourNew = save('hats', NOW - 48 * HOUR + 10 * MIN);
      const hourOld = save('hats', NOW - 48 * HOUR + 5 * MIN);
      // Two on one UTC day ten days ago: the newer stays.
      const dayNew = save('hats', NOW - 10 * DAY + 3 * HOUR);
      const dayOld = save('hats', NOW - 10 * DAY - 3 * HOUR);
      const tooOld = save('hats', NOW - 91 * DAY);
      // Two rows each: three saves go.
      expect(repo.pruneBankStock(NOW)).toBe(6);
      expect(kept('hats')).toEqual(new Set([newest, previous, sameDay, hourNew, dayNew]));
      for (const id of [hourOld, dayOld, tooOld]) expect(repo.bankStockRows(id)).toEqual([]);
      // Nothing more to do: a kept save stays the newest of its bucket.
      expect(repo.pruneBankStock(NOW)).toBe(0);
      expect(repo.pruneBankStock(NOW + HOUR)).toBe(0);
    });

    it("never deletes a page's newest save or the save it is compared with, whatever their age", () => {
      const old = save('weapons', NOW - 200 * DAY, '/buy/weapons');
      const older = save('weapons', NOW - 300 * DAY, '/buy/weapons');
      const oldest = save('weapons', NOW - 400 * DAY, '/buy/weapons');
      expect(repo.pruneBankStock(NOW)).toBe(2);
      expect(kept('weapons')).toEqual(new Set([old, older]));
      expect(repo.bankStockRows(oldest)).toEqual([]);
      // The same file imported again: the copy with the higher batch id is the newest (as bankStockSaves
      // orders them), the older copy at that time is no longer protected, and the previous save is the
      // newest one from strictly before it.
      const again = save('weapons', NOW - 200 * DAY, '/buy/weapons');
      expect(repo.pruneBankStock(NOW)).toBe(2);
      expect(kept('weapons')).toEqual(new Set([again, older]));
    });

    it('thins each page of a bank on its own, so one page saved often never thins another', () => {
      // /items saved every 10 minutes for 30 hours, /items/2 once, 3 days ago.
      const items: number[] = [];
      for (let i = 0; i < 180; i++) items.push(save('list', NOW - i * 10 * MIN, '/items'));
      const page2 = save('list', NOW - 3 * DAY, '/items/2');
      repo.pruneBankStock(NOW);
      const k = kept('list');
      expect(k.has(page2)).toBe(true);
      // The last 24 h all stay (144 saves at 0..23 h 50 min: each alone in its 10 minutes, 0.7.1), then the
      // newest per clock hour for the 6 h before (7 hours touched).
      const recent = items.filter((_, i) => i * 10 * MIN < DAY);
      for (const id of recent) expect(k.has(id)).toBe(true);
      expect([...k].filter((id) => items.includes(id))).toHaveLength(recent.length + 7);
    });

    it('caps a page at the newest maxSaves, keeping the newest and the previous save', () => {
      const ids = Array.from({ length: 12 }, (_, i) => save('stranges', NOW - i * MIN, '/buy/stranges'));
      expect(repo.pruneBankStock(NOW, { maxSaves: 5 })).toBe(14);
      expect(kept('stranges')).toEqual(new Set(ids.slice(0, 5)));
      // maxAgeMs moves the 90-day horizon (the previous save is still kept).
      const a = save('items', NOW - 3 * DAY, '/buy/items');
      const b = save('items', NOW - 4 * DAY, '/buy/items');
      const c = save('items', NOW - 5 * DAY, '/buy/items');
      expect(repo.pruneBankStock(NOW, { maxAgeMs: 2 * DAY })).toBe(2);
      expect(kept('items')).toEqual(new Set([a, b]));
      expect(repo.bankStockRows(c)).toEqual([]);
    });

    it('deletes rows whose batch is gone unless asked not to (the import skips that scan)', () => {
      save('hats', NOW - MIN);
      repo.insertBankStock(999, 'hats', [stored('378;6')]);
      expect(repo.pruneBankStock(NOW, { orphans: false })).toBe(0);
      expect(repo.bankStockRows(999)).toHaveLength(1);
      expect(repo.pruneBankStock(NOW)).toBe(1);
      expect(repo.bankStockRows(999)).toEqual([]);
    });

    it('lists every save with rows, oldest first, from the batches (bankStockSaveIndex) and reads several saves at once', () => {
      const b = save('hats', NOW - HOUR);
      const a = save('stranges', NOW - 2 * HOUR, '/buy/stranges');
      const c = save('list', NOW - HOUR, '/items/2');
      batch('weapons', NOW); // a batch without rows is no save
      expect(repo.bankStockSaveIndex()).toEqual([
        { batchId: a, savedAt: NOW - 2 * HOUR, bank: 'stranges', page: '/buy/stranges' },
        { batchId: b, savedAt: NOW - HOUR, bank: 'hats', page: '/buy/hats' },
        { batchId: c, savedAt: NOW - HOUR, bank: 'list', page: '/items/2' },
      ]);
      const rows = repo.bankStockRowsOf([a, c, 12345, a]);
      expect([...rows.keys()]).toEqual([a, c]);
      expect(rows.get(c)!.map((r) => r.sku)).toEqual(['126;6', '378;6']);
      expect(repo.bankStockRowsOf([]).size).toBe(0);
    });
  });
});

// F20-UIPERF-5: the save index walked every import_batches row ever written (never purged) with a seek
// into bank_stock each. From V8 it reads bank_stock_saves, one entry per kept save, kept with the rows.
describe('bank_stock_saves (V8): one entry per kept save, kept with bank_stock', () => {
  function fileRepo(): { repo: Repo; path: string } {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    return { repo: openRepo(path), path };
  }
  const batchOf = (repo: Repo, bank: ScraptfBank | null, at: number) =>
    repo.createImportBatch({ fileName: 'page.html', pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at + 1_000, itemCount: 1, bank });
  function entries(path: string): [number, string, string, number][] {
    const raw = new DatabaseSync(path);
    try {
      return raw
        .prepare('SELECT batch_id, bank, page, items FROM bank_stock_saves ORDER BY batch_id')
        .all()
        .map((r) => [Number(r['batch_id']), String(r['bank']), String(r['page']), Number(r['items'])]);
    } finally {
      raw.close();
    }
  }

  it('is written with the rows, adds a second write, and goes with a thinned save and an orphan', () => {
    const { repo, path } = fileRepo();
    const NOW = T0;
    const a = batchOf(repo, 'hats', NOW - HOUR);
    expect(repo.insertBankStock(a, 'hats', [stored('378;6'), stored('126;6')], '/buy/hats')).toBe(2);
    // Again into the same save: only the new row counts; the first bank and page stay.
    expect(repo.insertBankStock(a, 'hats', [stored('378;6'), stored('5021;6')], '/buy/hats')).toBe(1);
    // No row written, no save.
    const empty = batchOf(repo, 'hats', NOW);
    expect(repo.insertBankStock(empty, 'hats', [])).toBe(0);
    // A failed import leaves no entry behind.
    const failed = batchOf(repo, 'hats', NOW);
    expect(() =>
      repo.transaction(() => {
        repo.insertBankStock(failed, 'hats', [stored('378;6')], '/buy/hats');
        throw new Error('import failed');
      }),
    ).toThrow('import failed');
    const old = batchOf(repo, 'stranges', NOW - 200 * DAY);
    repo.insertBankStock(old, 'stranges', [stored('200;11')], '/buy/stranges');
    const older = batchOf(repo, 'stranges', NOW - 300 * DAY);
    repo.insertBankStock(older, 'stranges', [stored('200;11')], '/buy/stranges');
    const oldest = batchOf(repo, 'stranges', NOW - 400 * DAY);
    repo.insertBankStock(oldest, 'stranges', [stored('200;11')], '/buy/stranges');
    // Rows of a batch that is gone (a damaged database).
    repo.insertBankStock(999, 'hats', [stored('378;6')], '/buy/hats');
    expect(repo.bankStockSaves('hats')).toEqual([{ batchId: a, savedAt: NOW - HOUR, items: 3, page: '/buy/hats' }]);
    repo.close();
    expect(entries(path)).toEqual([
      [a, 'hats', '/buy/hats', 3],
      [old, 'stranges', '/buy/stranges', 1],
      [older, 'stranges', '/buy/stranges', 1],
      [oldest, 'stranges', '/buy/stranges', 1],
      [999, 'hats', '/buy/hats', 1],
    ]);

    const again = openRepo(path);
    // The thinning drops the oldest save (rows and entry); the orphan sweep the batchless rows.
    expect(again.pruneBankStock(NOW)).toBe(2);
    expect(again.bankStockSaveIndex().map((s) => s.batchId)).toEqual([older, old, a]);
    again.close();
    expect(entries(path).map((e) => e[0])).toEqual([a, old, older]);
  });

  it('is backfilled from the rows of a version 7 database', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const raw = new DatabaseSync(path);
    expect(migrate(raw, MIGRATIONS.slice(0, 7)).to).toBe(7);
    const insBatch = raw.prepare('INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, bank) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insBatch.run(3, 'hats.html', 'buy', T0 - 10 * MIN, T0 - 9 * MIN, 2, 'hats');
    insBatch.run(4, 'items2.html', 'items-list', T0 - 5 * MIN, T0 - 4 * MIN, 1, 'list');
    insBatch.run(5, 'dead.html', 'buy', T0 - 3 * MIN, T0 - 2 * MIN, 0, 'hats');
    const insRow = raw.prepare("INSERT INTO bank_stock (batch_id, bank, sku, special_key, name, cost_keys, cost_scrap, stock, asset_id, page) VALUES (?, ?, ?, '', 'x', 0, 30, 1, NULL, ?)");
    insRow.run(3, 'hats', '378;6', '/buy/hats');
    insRow.run(3, 'hats', '126;6', '/buy/hats');
    insRow.run(4, 'list', '5021;6', '/items/2');
    raw.close();

    const repo = openRepo(path);
    cleanups.push(() => repo.close());
    expect(repo.bankStockSaveIndex()).toEqual([
      { batchId: 3, savedAt: T0 - 10 * MIN, bank: 'hats', page: '/buy/hats' },
      { batchId: 4, savedAt: T0 - 5 * MIN, bank: 'list', page: '/items/2' },
    ]);
    expect(repo.bankStockSaves('hats')).toEqual([{ batchId: 3, savedAt: T0 - 10 * MIN, items: 2, page: '/buy/hats' }]);
    expect(repo.bankStockSaves('list', 10, { perPage: 1 })).toEqual([{ batchId: 4, savedAt: T0 - 5 * MIN, items: 1, page: '/items/2' }]);
  });
});
