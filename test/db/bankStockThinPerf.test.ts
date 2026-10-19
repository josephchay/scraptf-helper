// F20 S1: the thinning runs after every import, so its cost is measured at the spec's size: 300 saves
// x 8 pages x 300 rows (720,000 bank_stock rows). It must stay well under 100 ms. Listed in TIMED
// (vitest.config.ts): it asserts wall-clock bounds. Local database only; nothing touches the network.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { BANK_STOCK_MAX_SAVES_PER_PAGE } from '../../src/shared/bankStock';
import type { BankStockStored, ScraptfBank } from '../../src/shared/types';
import { tempDir } from './helpers';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const PAGES: readonly [ScraptfBank, string][] = [
  ['hats', '/buy/hats'],
  ['weapons', '/buy/weapons'],
  ['stranges', '/buy/stranges'],
  ['killstreaks', '/buy/killstreaks'],
  ['skins', '/buy/skins'],
  ['items', '/buy/items'],
  ['unusuals', '/unusuals'],
  ['list', '/items'],
];
const ROWS = 300;

let repo: Repo;
let cleanup: () => void;

function rowsOf(save: number): BankStockStored[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    sku: `${1000 + i};6`,
    specialKey: '',
    name: `Item ${i}`,
    costKeys: 0,
    costScrap: 10 + ((i + save) % 50),
    stock: 1 + (i % 4),
    assetId: null,
  }));
}

function ms(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

beforeAll(() => {
  // A file database, as the app runs (WAL, the real page cache), not ':memory:'.
  const t = tempDir();
  cleanup = t.cleanup;
  repo = openRepo(t.file());
  repo.transaction(() => {
    for (const [bank, page] of PAGES) {
      // 300 saves of each page, 4 min apart: all inside the last day, so the thinning keeps every one.
      for (let s = 0; s < BANK_STOCK_MAX_SAVES_PER_PAGE; s++) {
        const at = NOW - s * 4 * MIN;
        const id = repo.createImportBatch({ fileName: `${bank}-${s}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: ROWS, bank });
        repo.insertBankStock(id, bank, rowsOf(s), page);
      }
    }
  });
}, 300_000);

afterAll(() => {
  repo?.close();
  cleanup?.();
});

describe('bank stock thinning at 300 saves x 8 pages x 300 rows', () => {
  it('lists every save from the batches in well under 100 ms', () => {
    expect(repo.bankStockSaveIndex()).toHaveLength(PAGES.length * BANK_STOCK_MAX_SAVES_PER_PAGE);
    const took = ms(() => repo.bankStockSaveIndex());
    console.info(`[perf] bankStockSaveIndex over ${PAGES.length * BANK_STOCK_MAX_SAVES_PER_PAGE} saves: ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(100);
  });

  it('runs after an import (nothing to delete) in well under 100 ms', () => {
    expect(repo.pruneBankStock(NOW, { orphans: false })).toBe(0);
    const runs = Array.from({ length: 5 }, () => ms(() => repo.pruneBankStock(NOW, { orphans: false })));
    console.info(`[perf] pruneBankStock with nothing to delete: ${runs.map((r) => r.toFixed(1)).join(', ')} ms`);
    expect(Math.min(...runs)).toBeLessThan(100);
    expect(Math.max(...runs)).toBeLessThan(250);
  });

  it('deletes the save past the cap of each page (the 301st save) in well under 100 ms', () => {
    repo.transaction(() => {
      for (const [bank, page] of PAGES) {
        const at = NOW + MIN;
        const id = repo.createImportBatch({ fileName: `${bank}-new.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: ROWS, bank });
        repo.insertBankStock(id, bank, rowsOf(-1), page);
      }
    });
    let deleted = 0;
    const took = ms(() => (deleted = repo.pruneBankStock(NOW + MIN, { orphans: false })));
    console.info(`[perf] pruneBankStock deleting ${deleted} rows (8 saves): ${took.toFixed(1)} ms`);
    expect(deleted).toBe(PAGES.length * ROWS);
    expect(took).toBeLessThan(100);
  });

  it("reads every bank's saves, and each page's newest for the F17 cache, from the kept saves (bankStockSaves) within bounds", () => {
    let total = 0;
    const took = ms(() => {
      for (const [bank] of PAGES) total += repo.bankStockSaves(bank, 500).length;
    });
    console.info(`[perf] bankStockSaves x ${PAGES.length} banks (${total} saves): ${took.toFixed(1)} ms`);
    expect(total).toBe(PAGES.length * BANK_STOCK_MAX_SAVES_PER_PAGE);
    expect(took).toBeLessThan(2_000);
    // What the F17 cache reads on each refresh: every page's 10 newest (F20-DC-1).
    let heads = 0;
    const perPage = ms(() => {
      for (const [bank] of PAGES) heads += repo.bankStockSaves(bank, 500, { perPage: 10 }).length;
    });
    console.info(`[perf] bankStockSaves perPage 10 x ${PAGES.length} banks (${heads} saves): ${perPage.toFixed(1)} ms`);
    expect(heads).toBe(PAGES.length * 10);
    expect(perPage).toBeLessThan(500);
  });

  it("maintenance's orphan sweep (a table scan, once a day) stays bounded", () => {
    const took = ms(() => repo.pruneBankStock(NOW + MIN));
    console.info(`[perf] pruneBankStock with the orphan sweep: ${took.toFixed(1)} ms`);
    expect(took).toBeLessThan(2_000);
  });

  // F20-UIPERF-5: import_batches is never purged, and thinning leaves the batches of the saves it drops
  // (saving 8 banks every 10 minutes writes about 100,000 in 90 days). The save index, read 3 times per
  // import and every minute by the reminders, must cost per kept save, not per batch ever written.
  it('lists the saves, and prunes after an import, as fast with 100,000 batches that hold no rows', () => {
    const best = (fn: () => unknown) => Math.min(...Array.from({ length: 5 }, () => ms(fn)));
    const kept = repo.bankStockSaveIndex().length;
    const before = best(() => repo.bankStockSaveIndex());
    repo.transaction(() => {
      for (let i = 0; i < 100_000; i++) {
        const at = NOW - 100 * 24 * 60 * MIN + i * MIN;
        repo.createImportBatch({ fileName: `old-${i}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: ROWS, bank: PAGES[i % PAGES.length]![0] });
      }
    });
    expect(repo.bankStockSaveIndex()).toHaveLength(kept);
    const after = best(() => repo.bankStockSaveIndex());
    const prune = best(() => repo.pruneBankStock(NOW + MIN, { orphans: false }));
    console.info(`[perf] bankStockSaveIndex over ${kept} saves: ${before.toFixed(1)} ms, with 100,000 empty batches ${after.toFixed(1)} ms; prune ${prune.toFixed(1)} ms`);
    expect(after).toBeLessThan(100);
    // About 0.5 µs a batch when it walked them all: 50 ms here.
    expect(after - before).toBeLessThan(15);
    expect(prune).toBeLessThan(100);
  }, 120_000);
});
