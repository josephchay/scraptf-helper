// 0.7.1 (CQ-2): the session baseline a page's newest save is compared with for "What's new", the change
// chips and the New badges (bankStockBaselineOf, bankStockPagePairs in src/shared/bankStock.ts): the newest
// save from before the newest one's session (saves less than 30 minutes apart), else the save just before
// the newest. Daily file saves read exactly as before. Pure; no database, no network.

import { describe, expect, it } from 'vitest';
import { BANK_STOCK_KEEP_SAVES, BANK_STOCK_SESSION_GAP_MS, bankStockBaselineOf, bankStockPagePairs, type BankStockPageSave } from '../../src/shared/bankStock';
import type { UnixMs } from '../../src/shared/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

/** Saves newest first at these ages, batch ids counting down so the newest has the highest. */
function saves(ages: readonly number[], page = '/buy/hats'): (BankStockPageSave & { savedAt: UnixMs })[] {
  return ages.map((age, i) => ({ batchId: 100 - i, savedAt: NOW - age, page, items: 3 }));
}

describe('bankStockBaselineOf', () => {
  it('is the save before the newest one\'s session', () => {
    // Window reads 30 s apart, then yesterday's save.
    const s = saves([0, 30_000, 60_000, DAY]);
    expect(bankStockBaselineOf(s)?.savedAt).toBe(NOW - DAY);
  });

  it('chains the session: each save less than 30 minutes after the one before it', () => {
    // 20-minute steps for an hour are one session; the save 45 minutes before that is not in it.
    const s = saves([0, 20 * MIN, 40 * MIN, 60 * MIN, 105 * MIN]);
    expect(bankStockBaselineOf(s)?.savedAt).toBe(NOW - 105 * MIN);
  });

  it('breaks the session at exactly the gap, not a moment before', () => {
    expect(bankStockBaselineOf(saves([0, BANK_STOCK_SESSION_GAP_MS]))?.savedAt).toBe(NOW - BANK_STOCK_SESSION_GAP_MS);
    expect(bankStockBaselineOf(saves([0, BANK_STOCK_SESSION_GAP_MS - 1, DAY]))?.savedAt).toBe(NOW - DAY);
  });

  it('falls back to the save just before the newest when every save is one session', () => {
    const s = saves([0, 30_000, 60_000]);
    expect(bankStockBaselineOf(s)?.savedAt).toBe(NOW - 30_000);
  });

  it('is the previous save for daily file saves, as F17 compared them', () => {
    const s = saves([0, DAY, 2 * DAY, 3 * DAY]);
    expect(bankStockBaselineOf(s)?.savedAt).toBe(NOW - DAY);
  });

  it('skips the same file imported again (same time) and is null for a first save', () => {
    expect(bankStockBaselineOf(saves([0, 0, 2 * DAY]))?.savedAt).toBe(NOW - 2 * DAY);
    expect(bankStockBaselineOf(saves([0, 0]))).toBeNull();
    expect(bankStockBaselineOf(saves([0]))).toBeNull();
    expect(bankStockBaselineOf([])).toBeNull();
  });
});

describe('bankStockPagePairs: baseline next to previous', () => {
  it('pairs each page with its own baseline and previous save', () => {
    const pairs = bankStockPagePairs([
      ...saves([0, 30_000, DAY], '/items'),
      ...saves([5 * MIN, 2 * DAY], '/items/2').map((s) => ({ ...s, batchId: s.batchId - 50 })),
    ].sort((a, b) => b.savedAt - a.savedAt || b.batchId - a.batchId));
    expect(pairs.map((p) => [p.page, p.newest.savedAt, p.previous?.savedAt, p.baseline?.savedAt])).toEqual([
      ['/items', NOW, NOW - 30_000, NOW - DAY],
      ['/items/2', NOW - 5 * MIN, NOW - 2 * DAY, NOW - 2 * DAY],
    ]);
  });

  it('finds the baseline behind more window reads than it counts, and still counts at most BANK_STOCK_KEEP_SAVES', () => {
    const reads = Array.from({ length: 200 }, (_, i) => i * 20_000);
    const [pair] = bankStockPagePairs(saves([...reads, DAY]));
    expect(pair!.baseline?.savedAt).toBe(NOW - DAY);
    expect(pair!.previous?.savedAt).toBe(NOW - 20_000);
    expect(pair!.saves).toBe(BANK_STOCK_KEEP_SAVES);
  });

  it('daily saves: baseline is the previous save, so nothing changes for file users', () => {
    const [pair] = bankStockPagePairs(saves([0, DAY, 2 * DAY]));
    expect(pair!.baseline).toBe(pair!.previous);
    expect(pair!.saves).toBe(3);
  });
});
