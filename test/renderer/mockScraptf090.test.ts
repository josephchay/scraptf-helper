// 0.9 scraptf mock parity (#9, #13): the browser mock answers as the service does, by the same shared rules. Its
// banks summary dates a "not trading" look with bankNoticeNewestAt / bankUnavailableAt (the seeds carry no notice, so
// unavailableAt is absent, as in the service); its import.report counts hold the service report's keys (the six 0.9
// evidence counts at 0); a stored row's markdown passes through the shared bankStockRows; and the guard reaches every
// Buy now tag of its bank stock rows through the shared timingBadge. The mock sends no toasts. Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { timingBadge } from '../../src/renderer/timingModel';
import { clearImportReports, recordImportReport } from '../../src/service/import/reports';
import { BANK_STOCK_MAX_LIMIT, bankStockRows } from '../../src/shared/bankStock';
import { bankNoticeNewestAt, bankUnavailableAt } from '../../src/shared/banks';
import { CHECKOUT_GUARD_TAG } from '../../src/shared/checkoutGuard';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { BankStockStored, ImportBatch } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;

let bridge: MockBridge | null = null;
function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}
afterEach(() => {
  bridge?.dispose();
  bridge = null;
  clearImportReports();
});

describe('0.9 scraptf: mock parity', () => {
  it("answers scraptf.banks without unavailableAt (no seed batch carries a notice), as the service's summary would", async () => {
    const b = make();
    const res = await b.rpc('scraptf.banks', undefined);
    expect(res.banks.length).toBeGreaterThan(0);
    for (const s of res.banks) expect(s, s.bank).not.toHaveProperty('unavailableAt');
    const batches = await b.rpc('import.batches', { limit: 100 });
    expect(batches.every((x) => (x.bankNotice ?? null) === null)).toBe(true);
  });

  it('dates a notice look with the same shared rules the service uses (a newer save clears it)', () => {
    const batch = (over: Partial<ImportBatch>): Pick<ImportBatch, 'bank' | 'fileMtime' | 'importedAt' | 'bankNotice'> => ({ bank: 'hats', fileMtime: 0, importedAt: T0, bankNotice: null, ...over });
    const batches = [batch({ importedAt: T0 - 30 * MIN }), batch({ importedAt: T0 - 5 * MIN, bankNotice: 'unavailable' }), batch({ bank: 'weapons', importedAt: T0, bankNotice: 'unavailable' })];
    const notice = bankNoticeNewestAt(batches, 'hats');
    expect(notice).toBe(T0 - 5 * MIN);
    expect(bankUnavailableAt(notice, T0 - 30 * MIN)).toBe(T0 - 5 * MIN);
    expect(bankUnavailableAt(notice, T0 - MIN)).toBeNull();
    expect(bankUnavailableAt(bankNoticeNewestAt(batches, 'stranges'), null)).toBeNull();
  });

  it("answers import.report with the service report's count keys (the 0.9 evidence counts at 0) and no notices", async () => {
    const b = make();
    const [rep] = await b.rpc('import.report', undefined);
    const service = recordImportReport({ at: T0, origin: 'file', name: 'x.html', pageKind: 'buy', bank: 'hats', page: '/buy/hats', format: 'html', batchId: 1, diagnostics: null, warnings: [] });
    expect(Object.keys(rep!.counts).sort()).toEqual(Object.keys(service.counts).sort());
    expect(rep!.counts).toMatchObject({ markdownSoon: 0, markdownOff: 0, countdownCards: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 });
    // Absent when none, as the service leaves it (mockParity071's key list stands).
    expect(rep).not.toHaveProperty('notices');
  });

  it("passes a mock-style stored row's markdown through the shared bankStockRows", () => {
    const stored: BankStockStored = { sku: '378;6', specialKey: '', name: 'Team Captain', costKeys: 0, costScrap: 27, stock: 1, assetId: null, markdown: ['off', 'soon'] };
    const rows = bankStockRows({ newest: [stored], previous: null, keyScrap: 568, profit: DEFAULT_SETTINGS.profit, categoryOf: () => 'hats', buySideOf: () => null, bank: 'hats' });
    expect(rows.map((r) => r.markdown)).toEqual([['off', 'soon']]);
    // The mock's seeded rows carry none (no seed change).
  });

  it("the mock's seeded bank stock rows carry no markdown, and its Buy now tags end with the checkout guard", async () => {
    const b = make();
    let buyNow = 0;
    for (const bank of ['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'unusuals', 'items'] as const) {
      const res = await b.rpc('scraptf.bankStock', { bank, limit: BANK_STOCK_MAX_LIMIT });
      for (const r of res.rows) {
        expect(r, r.key).not.toHaveProperty('markdown');
        const tag = timingBadge(r.timing, T0);
        if (r.timing?.verdict === 'buy-now') {
          buyNow++;
          expect(tag!.title.endsWith(CHECKOUT_GUARD_TAG), r.key).toBe(true);
        } else if (tag) expect(tag.title, r.key).not.toContain(CHECKOUT_GUARD_TAG);
      }
    }
    expect(buyNow).toBeGreaterThan(0);
  });
});
