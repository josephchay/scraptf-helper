// 0.9 (#13): the Banks summary's `unavailableAt` (src/service/domain/banks.ts): the bank's newest look said it was not
// trading (an import batch with bankNotice 'unavailable') and no save of the bank is newer. Absent otherwise, so a
// summary without a notice is 0.8's. A real in-memory repo; nothing reads the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { NewImportBatch, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBanksSummary, emptyBankSummary } from '../../src/service/domain/banks';
import type { MarketIndex } from '../../src/service/domain/market';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { BankStockStored, ScraptfBank, ScraptfBankSummary, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, T0, recordingLogger } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const clock = new FakeClock(T0);
  const banks = createBanksSummary({
    clock,
    log: recordingLogger(),
    repo,
    market: { uncheckedBy: (() => new Map()) as unknown as MarketIndex['uncheckedBy'] },
    scraptfList: { summary: () => ({ items: 0, newestAt: null, oldestAt: null, batches: 0 }), all: () => [], version: () => 1 },
    settings: () => DEFAULT_SETTINGS,
    folderWatch: () => ({ active: false, error: null }),
    timers: new FakeTimers(clock),
  });
  const of = (bank: ScraptfBank): ScraptfBankSummary => banks.summary(clock.now()).banks.find((b) => b.bank === bank)!;
  const batch = (over: Partial<NewImportBatch> & { fileMtime: UnixMs }): number =>
    repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', importedAt: over.fileMtime + 1_000, itemCount: 0, categories: null, bank: 'hats', ...over });
  /** A whole save of the hats bank with two cards on sale (its prices and its bank stock save). */
  const wholeSave = (at: UnixMs): number => {
    const id = batch({ fileMtime: at, itemCount: 2 });
    const rows: BankStockStored[] = ['378;6', '126;6'].map((sku) => ({ sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap: 20, stock: 1, assetId: null }));
    for (const r of rows) repo.upsertScrapPrice({ sku: r.sku, name: r.name, costScrap: 20, source: 'import', observedAt: at, importBatch: id, stock: 1 });
    repo.insertBankStock(id, 'hats', rows, '/buy/hats');
    return id;
  };
  return { repo, banks, of, batch, wholeSave };
}

describe('0.9 (#13): ScraptfBankSummary.unavailableAt', () => {
  it('is set for a notice look newer than the newest save, and cleared by a newer whole save', () => {
    const h = setup();
    h.wholeSave(T0 - 3 * HOUR);
    expect(h.of('hats').lastSavedAt).toBe(T0 - 3 * HOUR);
    expect(h.of('hats')).not.toHaveProperty('unavailableAt');
    // The bank's page said it was not trading (a notice look with no cards).
    h.batch({ fileMtime: T0 - 2 * HOUR, bankNotice: 'unavailable' });
    h.banks.invalidate('all');
    const card = h.of('hats');
    expect(card.unavailableAt).toBe(T0 - 2 * HOUR);
    // The stock and the date are still the save's before it.
    expect(card.lastSavedAt).toBe(T0 - 3 * HOUR);
    // Only that bank.
    for (const b of SCRAPTF_BANKS) if (b.bank !== 'hats') expect(h.of(b.bank)).not.toHaveProperty('unavailableAt');
    // A newer whole save: the notice is old news.
    h.wholeSave(T0 - HOUR);
    h.banks.invalidate('all');
    expect(h.of('hats').lastSavedAt).toBe(T0 - HOUR);
    expect(h.of('hats')).not.toHaveProperty('unavailableAt');
  });

  it('a notice of a bank never saved stands; a summary without one is unchanged', () => {
    const h = setup();
    expect(h.of('weapons')).toEqual(emptyBankSummary(SCRAPTF_BANKS.find((b) => b.bank === 'weapons')!));
    h.batch({ fileMtime: T0 - HOUR, bank: 'weapons', bankNotice: 'unavailable' });
    h.banks.invalidate('all');
    expect(h.of('weapons').unavailableAt).toBe(T0 - HOUR);
    expect(h.of('hats')).not.toHaveProperty('unavailableAt');
  });

  it('leaves it absent for notice-less batches and for a notice older than the newest save', () => {
    const h = setup();
    h.batch({ fileMtime: T0 - 4 * HOUR, bankNotice: 'unavailable' });
    h.batch({ fileMtime: T0 - 3 * HOUR });
    h.wholeSave(T0 - 2 * HOUR);
    expect(h.of('hats')).not.toHaveProperty('unavailableAt');
  });
});
