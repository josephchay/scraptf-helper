// 0.7.3: a Recent batches row whose stored items an update removed afterwards (the 0.7.2 bare-kit cleanup,
// schema V12, zeroes its item_count but keeps its categories) says so, instead of "it stored no items" with
// the remedy for a page read before its items showed. Built on the user's database shape, as in bareKits.test.ts.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { importBankText, importBatchItemsRemoved } from '../../src/renderer/banksModel';
import { openRepo } from '../../src/service/db';
import { MIGRATIONS, migrate } from '../../src/service/db/migrations';
import { tempDir } from '../db/helpers';

const T0 = 1_791_958_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');

function userDb() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const db = new DatabaseSync(t.file());
  migrate(db, MIGRATIONS.slice(0, 10));
  const batch = (id: number, bank: string, items: number, categories: string): void => {
    db.prepare("INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, categories, bank, origin) VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 'window')").run(
      id,
      `scrap.tf window /buy/${bank}`,
      T0 + id,
      T0 + id,
      items,
      categories,
      bank,
    );
  };
  // Batch 24: a /buy/killstreaks window read that stored its kits bare, written as the importer writes it.
  batch(24, 'killstreaks', 52, '{"killstreaks":52}');
  for (const sku of ['6526;6', '6523;6', '6527;6']) {
    db.prepare("INSERT INTO bank_stock (batch_id, bank, sku, name, cost_keys, cost_scrap, stock, page) VALUES (24, 'killstreaks', ?, 'Kit', 0, 9, 1, '/buy/killstreaks')").run(sku);
    db.prepare("INSERT INTO scrap_prices (sku, name, cost_keys, cost_scrap, source, observed_at, import_batch) VALUES (?, 'Kit', 0, 9, 'import', ?, 24)").run(sku, T0);
  }
  db.prepare("INSERT INTO bank_stock_saves (batch_id, bank, page, items) VALUES (24, 'killstreaks', '/buy/killstreaks', 3)").run();
  // Batch 26: a hats read made before its cards showed (stored nothing; categories {}). Batch 30: a counted hats read.
  batch(26, 'hats', 0, '{}');
  batch(30, 'hats', 2, '{"hats":2}');
  db.close();
  const repo = openRepo(t.file());
  cleanups.push(() => repo.close());
  return repo;
}

describe('Recent batches: a batch whose items an update removed', () => {
  it("names the update, not a page read too early, on the user's database", () => {
    const batches = userDb().listImportBatches(20);
    const b = batches.find((x) => x.id === 24)!;
    expect(b.itemCount).toBe(0);
    expect(b.categories).not.toBeNull();
    expect(importBatchItemsRemoved(b)).toBe(true);

    const t = importBankText(b.bank, b.itemCount, undefined, b.origin === 'window', importBatchItemsRemoved(b))!;
    expect(t.text).toBe('Killstreaks · scrap.tf/buy/killstreaks · not counted');
    expect(t.title).toContain('an update removed the items it stored');
    expect(t.title).not.toContain('it stored no items');
    expect(t.title).not.toContain('before its items showed');
    expect(t.title).not.toContain('Read page now');

    // A read that stored nothing keeps the F18/F21 wording; a counted one still counts.
    const empty = batches.find((x) => x.id === 26)!;
    expect(importBatchItemsRemoved(empty)).toBe(false);
    expect(importBankText(empty.bank, empty.itemCount, undefined, true, importBatchItemsRemoved(empty))!.title).toBe(
      'Not counted as a save of scrap.tf/buy/hats: it stored no items, so the scrap.tf banks page and the Live market strip pass over it. If it was read before its items showed, press Read page now in the window once they show.',
    );
    const hats = batches.find((x) => x.id === 30)!;
    expect(importBatchItemsRemoved(hats)).toBe(false);
    expect(importBankText(hats.bank, hats.itemCount, undefined, true, importBatchItemsRemoved(hats))!.title).toMatch(/^Counted as a save of /);
  });

  it('is only a zero count beside stored categories', () => {
    expect(importBatchItemsRemoved({ itemCount: 0, categories: {} })).toBe(false);
    expect(importBatchItemsRemoved({ itemCount: 0, categories: null })).toBe(false);
    expect(importBatchItemsRemoved({ itemCount: 0 })).toBe(false);
    expect(importBatchItemsRemoved({ itemCount: 3, categories: { hats: 3 } })).toBe(false);
    expect(importBatchItemsRemoved({ itemCount: Number.NaN, categories: { hats: 3 } })).toBe(false);
    expect(importBatchItemsRemoved({ itemCount: 0, categories: { killstreaks: 52 } })).toBe(true);
  });

  it('leaves every other wording as it was', () => {
    expect(importBankText('hats', 0, undefined, false, false)!.title).toBe(
      "Not counted as a save of scrap.tf/buy/hats: it stored no items, so the scrap.tf banks page and the Live market strip pass over it. If it was saved before its items showed, save it again as 'Webpage, Complete'.",
    );
    // The list counts with nothing stored, removed or not.
    expect(importBankText('list', 0, undefined, false, true)!.title).toMatch(/^Counted as a save of /);
    expect(importBankText(null, 0, undefined, false, true)!.text).toBe('Not recognised');
  });

  it('the Import page passes the signal for Recent batches only', () => {
    const page = read('pages/ImportPage.tsx');
    // 0.9 (#13): then false for the Unusuals index and the batch's own "not trading" notice.
    expect(page).toContain("importBankText(b.bank, b.itemCount, undefined, b.origin === 'window', importBatchItemsRemoved(b), false, b.bankNotice === 'unavailable')");
    // A result from this session ran after every migration, so the Last import line passes false (it names
    // the bare Unusuals index instead, from the result's own warnings, and from 0.9 a bank that is not trading).
    expect(page).toContain("importBankText(r.bank, r.stored, importSavedWithoutCards(r), r.origin === 'window', false, importUnusualsIndex(r), importBankUnavailable(r));");
  });
});
