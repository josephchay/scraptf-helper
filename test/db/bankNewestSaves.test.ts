// 0.7.1 (DM-7, CQ-3): Repo.bankNewestSaves, each bank's newest save over every import batch (not only
// the newest 500, which heavy window use fills with one bank), and migration V10, the (bank, save time)
// index it seeks on. Local database only; nothing here touches the network.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewImportBatch, Repo } from '../../src/service/contracts';
import { SCHEMA_VERSION, openRepo } from '../../src/service/db';
import { MIGRATIONS, migrate } from '../../src/service/db/migrations';
import { BANK_NEWEST_SAVE } from '../../src/service/db/repo';
import { scraptfBankSaves } from '../../src/shared/market';
import { SCRAPTF_BANK_IDS, type ScraptfBank } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_791_958_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function memRepo(): Repo {
  const repo = openRepo(':memory:');
  cleanups.push(() => repo.close());
  return repo;
}

function save(repo: Repo, bank: ScraptfBank | null, at: number, over: Partial<NewImportBatch> = {}): number {
  return repo.createImportBatch({
    fileName: `${bank ?? 'page'}.html`,
    pageKind: bank === 'list' ? 'items-list' : bank === 'unusuals' ? 'unusuals' : 'buy',
    fileMtime: at,
    importedAt: at + 5_000,
    itemCount: 3,
    ...(bank === null ? {} : { bank }),
    ...over,
  });
}

describe('migration V10', () => {
  it('adds the bank and save-time index to a V9 database, keeping its batches', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
    expect(MIGRATIONS[9]).toMatchObject({ version: 10, name: 'saved-page batch bank and save time' });
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const raw = new DatabaseSync(path);
    migrate(raw, MIGRATIONS.slice(0, 9));
    raw
      .prepare('INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, categories, bank, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(4, 'scrap.tf - Buy Hats.html', 'buy', T0 - HOUR, T0, 2, '{"hats":2}', 'hats', 'file');
    raw.close();

    const repo = openRepo(path);
    cleanups.push(() => repo.close());
    expect(repo.bankNewestSaves()).toEqual([{ bank: 'hats', batchId: 4, savedAt: T0 - HOUR, itemCount: 2 }]);

    const check = new DatabaseSync(path);
    cleanups.push(() => check.close());
    const idx = check.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_import_batches_bank_saved'").all();
    expect(idx).toEqual([{ name: 'idx_import_batches_bank_saved', tbl_name: 'import_batches' }]);
  });

  it('lets the per-bank query seek the index, with no sort of its own', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const repo = openRepo(path);
    cleanups.push(() => repo.close());
    for (let i = 0; i < 50; i++) save(repo, SCRAPTF_BANK_IDS[i % SCRAPTF_BANK_IDS.length]!, T0 + i * MIN);
    const check = new DatabaseSync(path);
    cleanups.push(() => check.close());
    const plan = check
      .prepare(`EXPLAIN QUERY PLAN ${BANK_NEWEST_SAVE}`)
      .all('hats')
      .map((r) => String(r['detail']))
      .join('\n');
    expect(plan).toContain('idx_import_batches_bank_saved');
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});

describe('Repo.bankNewestSaves', () => {
  it('still dates a bank saved once before 500 saves of another bank (the coverage window would lose it)', () => {
    const repo = memRepo();
    const skins = save(repo, 'skins', T0 - 3 * 24 * HOUR, { itemCount: 7 });
    let lastHats = 0;
    for (let i = 0; i < 500; i++) lastHats = save(repo, 'hats', T0 + i * MIN);
    // What the 500-batch window the coverage strip reads sees: hats only.
    expect(repo.listImportBatches(500).some((b) => b.id === skins)).toBe(false);
    expect(repo.bankNewestSaves()).toEqual([
      { bank: 'hats', batchId: lastHats, savedAt: T0 + 499 * MIN, itemCount: 3 },
      { bank: 'skins', batchId: skins, savedAt: T0 - 3 * 24 * HOUR, itemCount: 7 },
    ]);
  });

  it('skips a bank page save that stored nothing, but counts a list save with no items', () => {
    const repo = memRepo();
    const hats = save(repo, 'hats', T0 - HOUR, { itemCount: 4 });
    save(repo, 'hats', T0, { itemCount: 0 });
    const list = save(repo, 'list', T0, { itemCount: 0 });
    // A bank whose every save stored nothing is absent.
    save(repo, 'weapons', T0, { itemCount: 0 });
    expect(repo.bankNewestSaves()).toEqual([
      { bank: 'hats', batchId: hats, savedAt: T0 - HOUR, itemCount: 4 },
      { bank: 'list', batchId: list, savedAt: T0, itemCount: 0 },
    ]);
  });

  it('breaks a tie on the save time with the higher batch id', () => {
    const repo = memRepo();
    save(repo, 'stranges', T0);
    const second = save(repo, 'stranges', T0, { importedAt: T0 - 9_000 });
    save(repo, 'stranges', T0 - MIN);
    expect(repo.bankNewestSaves()).toEqual([{ bank: 'stranges', batchId: second, savedAt: T0, itemCount: 3 }]);
  });

  it('dates a save by its file time, else its import time, as batchSavedAt', () => {
    const repo = memRepo();
    // No file time: the import time counts, and it is the newer save here.
    const noMtime = save(repo, 'unusuals', 0, { importedAt: T0 + HOUR });
    save(repo, 'unusuals', T0);
    expect(repo.bankNewestSaves()).toEqual([{ bank: 'unusuals', batchId: noMtime, savedAt: T0 + HOUR, itemCount: 3 }]);
  });

  it('ignores batches with no recorded bank (before 0.5, or a page the parser did not recognise)', () => {
    const repo = memRepo();
    save(repo, null, T0 + HOUR);
    save(repo, 'bogus' as ScraptfBank, T0 + HOUR);
    const items = save(repo, 'items', T0);
    expect(repo.bankNewestSaves()).toEqual([{ bank: 'items', batchId: items, savedAt: T0, itemCount: 3 }]);
  });

  it('lists the banks in SCRAPTF_BANK_IDS order and agrees with scraptfBankSaves over every batch', () => {
    const repo = memRepo();
    // A mix of banks, times, empty saves and ties, written out of order.
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let i = 0; i < 400; i++) {
      const bank = SCRAPTF_BANK_IDS[rnd(SCRAPTF_BANK_IDS.length)]!;
      save(repo, bank, T0 - rnd(40) * HOUR, { itemCount: rnd(4), importedAt: T0 + rnd(10) * MIN, ...(rnd(5) === 0 ? { fileMtime: 0 } : {}) });
    }
    const got = repo.bankNewestSaves();
    expect(got.map((s) => s.bank)).toEqual(SCRAPTF_BANK_IDS.filter((b) => got.some((s) => s.bank === b)));
    const { newest } = scraptfBankSaves(repo.listImportBatches(10_000), () => []);
    expect(new Map(got.map((s) => [s.bank, { at: s.savedAt, id: s.batchId, items: s.itemCount }]))).toEqual(newest);
  });
});
