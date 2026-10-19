// 0.7.1 (DC-2): a bank page is dated and counted by its newest whole look (its newest bank stock save), never
// by a batch a partial or unsettled look recorded; the list, and a bank with no stock save, keep the batches.

import { describe, expect, it } from 'vitest';
import { batchItemCounts, scraptfCoverage, wholeLookNewestSaves, type BankSave, type CoverageBatch, type WholeLookSave } from '../../src/shared/market';
import type { ScraptfBank } from '../../src/shared/types';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

const batch = (id: number, bank: ScraptfBank, at: number, itemCount: number): CoverageBatch => ({ id, bank, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount, categories: null });

describe('wholeLookNewestSaves', () => {
  // Hats: a whole save 3 h ago (batch 1, 33 items), then a partial look a minute ago (batch 2, 2 items).
  const batches = [batch(2, 'hats', T0 - 60_000, 2), batch(1, 'hats', T0 - 3 * HOUR, 33), batch(3, 'skins', T0 - 5 * HOUR, 7), batch(4, 'list', T0 - HOUR, 900)];
  const byBatch = new Map<ScraptfBank, BankSave>([
    ['hats', { at: T0 - 60_000, id: 2, items: 2 }],
    ['skins', { at: T0 - 5 * HOUR, id: 3, items: 7 }],
    ['list', { at: T0 - HOUR, id: 4, items: 900 }],
  ]);
  const looks: Partial<Record<ScraptfBank, WholeLookSave>> = { hats: { batchId: 1, savedAt: T0 - 3 * HOUR, items: 35 }, list: { batchId: 99, savedAt: T0, items: 1 } };
  const wholeLookOf = (bank: ScraptfBank) => looks[bank] ?? null;

  it("dates a bank by its newest stock save, counted by that batch's items", () => {
    const out = wholeLookNewestSaves(byBatch, wholeLookOf, batchItemCounts(batches));
    expect(out.get('hats')).toEqual({ at: T0 - 3 * HOUR, id: 1, items: 33 });
    // No stock save (saved before 0.6): the batches still date it. The list is never re-dated.
    expect(out.get('skins')).toEqual({ at: T0 - 5 * HOUR, id: 3, items: 7 });
    expect(out.get('list')).toEqual({ at: T0 - HOUR, id: 4, items: 900 });
    // The input is not changed.
    expect(byBatch.get('hats')?.id).toBe(2);
  });

  it("falls back to the save's own rows when its batch is not among those read, and to the batches without the hook", () => {
    expect(wholeLookNewestSaves(byBatch, wholeLookOf, () => null).get('hats')).toEqual({ at: T0 - 3 * HOUR, id: 1, items: 35 });
    expect(wholeLookNewestSaves(byBatch, null, batchItemCounts(batches)).get('hats')).toEqual({ at: T0 - 60_000, id: 2, items: 2 });
    // Repo.bankNewestSaves' counts serve batches older than the ones read.
    expect(batchItemCounts([], [{ batchId: 1, itemCount: 33 }])(1)).toBe(33);
  });

  it('feeds the coverage strip the same way', () => {
    const strip = scraptfCoverage(batches, () => [], null, wholeLookOf);
    expect(strip.find((c) => c.label === 'Hats')).toMatchObject({ lastSavedAt: T0 - 3 * HOUR, items: 33 });
    expect(strip.find((c) => c.label === 'Skins')).toMatchObject({ lastSavedAt: T0 - 5 * HOUR, items: 7 });
    expect(scraptfCoverage(batches, () => []).find((c) => c.label === 'Hats')).toMatchObject({ lastSavedAt: T0 - 60_000, items: 2 });
  });
});
