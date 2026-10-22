// 0.9 (scrap.tf #13, schema V16): a bank page's own notice (import_batches.bank_notice) and a card's price-drop wording
// (bank_stock.markdown). The wording is stored as text: the known marks, unique, in SCRAPTF_MARKDOWNS order, joined by
// a space; a word a newer build wrote is dropped on read, never shown as something it is not.
// (PLAN_090 B.3's pure helpers, then B.6's repo round trips.)

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { NewImportBatch, Repo } from '../../src/service/contracts';
import { bankStockMarkdownOf, bankStockMarkdownText } from '../../src/shared/bankStock';
import { SCRAPTF_BANK_NOTICES, SCRAPTF_MARKDOWNS, type BankStockStored, type ScraptfBankNotice, type ScraptfMarkdown } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_792_496_380_093;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A repo on a file, so stored values can be read and planted raw between opens. */
function fileRepo(): { repo: () => Repo; file: string } {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const file = t.file();
  return {
    file,
    repo: () => {
      const r = openRepo(file);
      cleanups.push(() => r.close());
      return r;
    },
  };
}

function raw<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const batch = (over: Partial<NewImportBatch> = {}): NewImportBatch => ({
  fileName: 'scrap.tf - Buy Hats.html',
  pageKind: 'buy',
  fileMtime: T0,
  importedAt: T0,
  itemCount: 0,
  bank: 'hats',
  origin: 'file',
  ...over,
});

const stored = (sku: string, over: Partial<BankStockStored> = {}): BankStockStored => ({
  sku,
  specialKey: '',
  name: `Item ${sku}`,
  costKeys: 0,
  costScrap: 30,
  stock: 1,
  assetId: null,
  ...over,
});

describe('bank stock markdown helpers (0.9, #13)', () => {
  it('the known marks and notices', () => {
    expect(SCRAPTF_MARKDOWNS).toEqual(['off', 'soon']);
    expect(SCRAPTF_BANK_NOTICES).toEqual(['unavailable']);
  });

  it('bankStockMarkdownText: known marks, unique, in SCRAPTF_MARKDOWNS order, joined by a space; null for none', () => {
    expect(bankStockMarkdownText(['soon', 'off'])).toBe('off soon');
    expect(bankStockMarkdownText(['soon', 'soon'])).toBe('soon');
    expect(bankStockMarkdownText(['off'])).toBe('off');
    expect(bankStockMarkdownText(['bogus', 'soon', 7, null])).toBe('soon');
    expect(bankStockMarkdownText([])).toBeNull();
    expect(bankStockMarkdownText(['bogus'])).toBeNull();
    expect(bankStockMarkdownText(null)).toBeNull();
    expect(bankStockMarkdownText(undefined)).toBeNull();
    expect(bankStockMarkdownText('soon' as unknown as unknown[])).toBeNull();
  });

  it('bankStockMarkdownOf: a stored text (spaces or commas) or an array read back in order; unknown words dropped; null for none', () => {
    expect(bankStockMarkdownOf('soon off bogus')).toEqual(['off', 'soon']);
    expect(bankStockMarkdownOf('off soon')).toEqual(['off', 'soon']);
    expect(bankStockMarkdownOf('soon,off')).toEqual(['off', 'soon']);
    expect(bankStockMarkdownOf(' soon ')).toEqual(['soon']);
    expect(bankStockMarkdownOf(['soon', 'off'])).toEqual(['off', 'soon']);
    expect(bankStockMarkdownOf('bogus')).toBeNull();
    expect(bankStockMarkdownOf('')).toBeNull();
    expect(bankStockMarkdownOf(null)).toBeNull();
    expect(bankStockMarkdownOf(undefined)).toBeNull();
    expect(bankStockMarkdownOf(3)).toBeNull();
    expect(bankStockMarkdownOf('SOON')).toBeNull();
  });

  it('round-trips every combination', () => {
    for (const marks of [[], ['off'], ['soon'], ['off', 'soon']] as const) {
      const text = bankStockMarkdownText(marks);
      expect(bankStockMarkdownOf(text)).toEqual(marks.length > 0 ? marks : null);
    }
  });
});

describe('import_batches.bank_notice (0.9, V16)', () => {
  it("stores a known notice and reads it back; no notice reads absent, as every batch before V16", () => {
    const f = fileRepo();
    const r = f.repo();
    const look = r.createImportBatch(batch({ bankNotice: 'unavailable' }));
    const save = r.createImportBatch(batch({ importedAt: T0 + 1 }));
    const cleared = r.createImportBatch(batch({ importedAt: T0 + 2, bankNotice: null }));
    const byId = new Map(r.listImportBatches(10).map((b) => [b.id, b]));
    expect(byId.get(look)!.bankNotice).toBe('unavailable');
    expect(byId.get(save)).not.toHaveProperty('bankNotice');
    expect(byId.get(cleared)).not.toHaveProperty('bankNotice');
    expect(byId.get(save)).toEqual({ ...batch({ importedAt: T0 + 1 }), id: save, categories: null });
  });

  it("stores NULL for an unknown notice, and reads a stored unknown word (a newer build's) as absent", () => {
    const f = fileRepo();
    const r = f.repo();
    const id = r.createImportBatch(batch({ bankNotice: 'bogus' as ScraptfBankNotice }));
    const other = r.createImportBatch(batch({ importedAt: T0 + 1 }));
    r.close();
    expect(raw(f.file, (db) => db.prepare('SELECT bank_notice FROM import_batches WHERE id = ?').get(id)!['bank_notice'])).toBeNull();
    raw(f.file, (db) => db.prepare("UPDATE import_batches SET bank_notice = 'bogus' WHERE id = ?").run(other));
    const again = f.repo();
    for (const b of again.listImportBatches(10)) expect(b).not.toHaveProperty('bankNotice');
  });
});

describe('bank_stock.markdown (0.9, V16)', () => {
  it("round-trips a bank page card's wording in SCRAPTF_MARKDOWNS order; none reads absent", () => {
    const f = fileRepo();
    const r = f.repo();
    const id = r.createImportBatch(batch({ itemCount: 3 }));
    const n = r.insertBankStock(id, 'hats', [
      stored('378;6', { markdown: ['soon', 'off'] as ScraptfMarkdown[] }),
      stored('5021;6', { markdown: ['soon'] }),
      stored('30469;6', { markdown: [] }),
      stored('126;6'),
    ]);
    expect(n).toBe(4);
    const rows = new Map(r.bankStockRows(id).map((s) => [s.sku, s]));
    expect(rows.get('378;6')!.markdown).toEqual(['off', 'soon']);
    expect(rows.get('5021;6')!.markdown).toEqual(['soon']);
    expect(rows.get('30469;6')).not.toHaveProperty('markdown');
    expect(rows.get('126;6')).toEqual(stored('126;6'));
    r.close();
    expect(
      raw(f.file, (db) =>
        Object.fromEntries(db.prepare('SELECT sku, markdown FROM bank_stock WHERE batch_id = ?').all(id).map((x) => [String(x['sku']), x['markdown']])),
      ),
    ).toEqual({ '126;6': null, '30469;6': null, '378;6': 'off soon', '5021;6': 'soon' });
  });

  it('stores NULL on an /items list row whatever it carries (the list has no cards)', () => {
    const f = fileRepo();
    const r = f.repo();
    const id = r.createImportBatch(batch({ fileName: 'scrap.tf - Items.html', pageKind: 'items-list', bank: 'list', itemCount: 1 }));
    r.insertBankStock(id, 'list', [stored('378;6', { craft: 'craftable', markdown: ['off'] })]);
    expect(r.bankStockRows(id)[0]).not.toHaveProperty('markdown');
    r.close();
    expect(raw(f.file, (db) => db.prepare('SELECT markdown FROM bank_stock WHERE batch_id = ?').get(id)!['markdown'])).toBeNull();
  });

  it("reads a stored word it does not know as nothing (a newer build's), and known ones in order", () => {
    const f = fileRepo();
    const r = f.repo();
    const id = r.createImportBatch(batch({ itemCount: 2 }));
    r.insertBankStock(id, 'hats', [stored('378;6'), stored('5021;6')]);
    r.close();
    raw(f.file, (db) => {
      db.prepare("UPDATE bank_stock SET markdown = 'bogus' WHERE sku = '378;6'").run();
      db.prepare("UPDATE bank_stock SET markdown = 'soon,bogus off' WHERE sku = '5021;6'").run();
    });
    const rows = new Map(f.repo().bankStockRows(id).map((s) => [s.sku, s]));
    expect(rows.get('378;6')).not.toHaveProperty('markdown');
    expect(rows.get('5021;6')!.markdown).toEqual(['off', 'soon']);
  });
});
