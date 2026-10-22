// 0.8 (R-3): the lifecycle walk and the estimators stay cheap on a large saved history. TIMED (vitest.config.ts):
// 8 banks x 250 saves x 300 rows walk in at most 3 s in total, and one bank's pooled table plus its turnover take at
// most 300 ms. The bounds are generous; alone each part finishes far under them. Pure; no network, no scrap.tf.

import { describe, expect, it } from 'vitest';
import { scraptfLifecycleOf, type ScraptfSaveRows } from '../../src/shared/scraptfHistory';
import { scraptfBankCyclesOf, scraptfBankTurnover, scraptfTimingTableFor } from '../../src/shared/scraptfTiming';
import type { BankStockStored, ScraptfBank } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const HOUR = 3_600_000;
const K = 600;
const BANKS: readonly ScraptfBank[] = ['hats', 'unusuals', 'stranges', 'weapons', 'list', 'hats', 'unusuals', 'stranges'];

/**
 * One bank's 250 hourly saves of two pages, 300 rows each: items rotate in and out (6 new and 6 gone per save),
 * reprice down on their own period, sometimes up, and are single cards with steady asset ids.
 */
function bankSaves(seed: number): ScraptfSaveRows[] {
  const out: ScraptfSaveRows[] = [];
  let batch = seed * 1000;
  for (let s = 0; s < 250; s++) {
    const page = s % 2 === 0 ? '/buy/hats' : '/buy/hats/2';
    const rows: BankStockStored[] = [];
    for (let j = 0; j < 300; j++) {
      // Each page's window of items moves on by 6 per save of it: 6 new and 6 gone, each listed for 50 of its saves.
      const id = Math.floor(s / 2) * 6 + j + (s % 2) * 100_000;
      const price = 200 + (id % 50) * 7 - Math.floor(s / (5 + (id % 11))) + (s % 37 === 36 ? 3 : 0);
      rows.push({ sku: `${id};6`, specialKey: '', name: `Item ${id}`, costKeys: 0, costScrap: Math.max(1, price), stock: id % 9 === 0 ? 2 : 1, assetId: `a${seed}-${id}` });
    }
    out.push({ batchId: batch++, savedAt: T0 + s * HOUR, page, rows });
  }
  return out;
}

describe('lifecycle performance (TIMED)', () => {
  it('walks 8 banks x 250 saves x 300 rows in at most 3 s; one bank table plus turnover in at most 300 ms', () => {
    const banks = BANKS.map((bank, i) => ({ bank, saves: bankSaves(i + 1) }));
    expect(banks.reduce((n, b) => n + b.saves.reduce((m, s) => m + s.rows.length, 0), 0)).toBe(8 * 250 * 300);

    const t0 = performance.now();
    let copies = 0;
    for (const b of banks) copies += scraptfLifecycleOf(b.saves, { bank: b.bank, keyScrap: K }).copies.size;
    const walk = performance.now() - t0;
    expect(copies).toBeGreaterThan(8 * 300);
    expect(walk).toBeLessThan(3000);

    const c = scraptfBankCyclesOf('hats', banks[0]!.saves, K);
    const t1 = performance.now();
    const table = scraptfTimingTableFor(c, 250, K);
    const turnover = scraptfBankTurnover(c);
    const estimate = performance.now() - t1;
    expect(table.states).toBeGreaterThan(1000);
    expect(turnover.ended + turnover.open + turnover.wideGap + turnover.imprecise).toBeGreaterThan(300);
    expect(estimate).toBeLessThan(300);
  });
});
