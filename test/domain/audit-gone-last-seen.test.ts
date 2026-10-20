// Audit rbanks-1 (0.7.3): the Bank stock "Gone" view's Last seen and Last price. Since CQ-2 a gone row is
// judged against the session baseline (the save from before the latest run of saves), which can be a day
// older than the last save that had the item on sale (a scrap.tf window read minutes ago). The runs index
// (the user's own saves, in memory) knows that last sighting; the row now takes its time and price from it.
// Real in-memory repo, createScraptfHistory and createBankStock wired as core does. Saves are pages the
// user saved (R10); nothing here touches scrap.tf or the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { bankStockBuyCopy, bankStockLastSeen, bankStockPriceTitle } from '../../src/renderer/bankStockModel';
import { fmtDateTime } from '../../src/renderer/format';
import { bankStockFilterMatches, bankStockKey, bankStockLongListed } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { scraptfRunsOf, type ScraptfSaveRows } from '../../src/shared/scraptfHistory';
import type { BankStockQuery, BankStockStored, KeyPriceState, ScraptfBank, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

function r(sku: string, costScrap: number, stock: number | null = 1): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock, assetId: null };
}

function setup(withHistory = true): { repo: Repo; stock: BankStock; save(bank: ScraptfBank, at: UnixMs, rows: BankStockStored[], page?: string): void; gone(bank?: ScraptfBank): ReturnType<BankStock['list']> } {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const log = recordingLogger();
  const history = createScraptfHistory({ clock: { now: () => T0 }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY });
  const stock = createBankStock({
    clock: { now: () => T0 },
    log,
    repo,
    market: { entryFor: () => null },
    keyPrice: () => KEY,
    settings: () => DEFAULT_SETTINGS,
    categoryOf: () => 'hats',
    ...(withHistory ? { history: { runsFor: (b: ScraptfBank) => history.runsFor(b) } } : {}),
  });
  return {
    repo,
    stock,
    save(bank, at, rows, page = `/buy/${bank}`) {
      const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank, origin: 'window' });
      repo.insertBankStock(id, bank, rows, page);
    },
    gone: (bank = 'hats') => stock.list({ bank, filter: 'gone', limit: 2000 } as BankStockQuery, T0),
  };
}

describe('the Gone view names the last save that had the item on sale', () => {
  it('one page: the window read 2 min ago, not the baseline a day ago, with its price', () => {
    const h = setup();
    h.save('hats', T0 - DAY, [r('1;6', 10), r('2;6', 20)]);
    h.save('hats', T0 - 2 * MIN, [r('1;6', 10), r('2;6', 25)]);
    h.save('hats', T0, [r('1;6', 10)]);
    const res = h.gone();
    expect(res.rows.map((x) => [x.sku, x.change])).toEqual([['2;6', 'gone']]);
    const row = res.rows[0]!;
    expect(row).toMatchObject({ costScrapRaw: 25, costScrap: 25, lastSeenAt: T0 - 2 * MIN, stock: null });
    // The header still compares with the baseline (CQ-2), and so does the change from it.
    expect(res.previousSavedAt).toBe(T0 - DAY);
    expect(row.previousCostScrap).toBe(20);
    const seen = bankStockLastSeen(row, res.previousSavedAt, T0);
    expect(seen.text).toBe('2 min ago');
    expect(seen.title).toContain(fmtDateTime(T0 - 2 * MIN));
    expect(seen.title).not.toContain('previous save');
    expect(seen.title).toContain('does not list it');
    expect(bankStockPriceTitle(row, 600)).toContain('the last one that listed it on sale');
    expect(bankStockBuyCopy(row, 'hats').note.startsWith('last price 2.77 ref')).toBe(true);
    // Still gone only: never long listed, never in another chip.
    expect(bankStockLongListed(row, T0, 0)).toBe(false);
    expect(bankStockFilterMatches(row, 'all')).toBe(false);
    expect(row.listedSince).toBeNull();
  });

  it('sold out in the newest save: still gone, last seen on the read before', () => {
    const h = setup();
    h.save('hats', T0 - DAY, [r('1;6', 10), r('2;6', 20)]);
    h.save('hats', T0 - 2 * MIN, [r('1;6', 10), r('2;6', 25)]);
    h.save('hats', T0, [r('1;6', 10), r('2;6', 25, 0)]);
    const res = h.gone();
    const row = res.rows.find((x) => x.key === bankStockKey('2;6', ''))!;
    expect(row).toMatchObject({ change: 'gone', stock: 0, costScrapRaw: 25, lastSeenAt: T0 - 2 * MIN });
    expect(bankStockLastSeen(row, res.previousSavedAt, T0)).toMatchObject({ text: '2 min ago' });
    expect(bankStockLastSeen(row, res.previousSavedAt, T0).title).toContain('still lists it, sold out');
  });

  it('several pages: each row by its own page, not the earliest baseline of the bank', () => {
    const h = setup();
    h.save('list', T0 - DAY, [r('1;6', 10)], '/items');
    h.save('list', T0 - 2 * HOUR, [r('7;6', 10), r('8;6', 30)], '/items/2');
    h.save('list', T0 - 5 * MIN, [r('1;6', 10)], '/items');
    h.save('list', T0 - MIN, [r('7;6', 10)], '/items/2');
    const res = h.gone('list');
    const row = res.rows.find((x) => x.sku === '8;6')!;
    expect(row).toMatchObject({ change: 'gone', lastSeenAt: T0 - 2 * HOUR, costScrapRaw: 30 });
    expect(res.previousSavedAt).toBe(T0 - DAY);
    expect(bankStockLastSeen(row, res.previousSavedAt, T0).text).toBe('2 h ago');
  });

  it('without history: the baseline, and it says a later save may have listed it', () => {
    const h = setup(false);
    h.save('hats', T0 - DAY, [r('1;6', 10), r('2;6', 20)]);
    h.save('hats', T0 - 2 * MIN, [r('1;6', 10), r('2;6', 25)]);
    h.save('hats', T0, [r('1;6', 10)]);
    const res = h.gone();
    const row = res.rows[0]!;
    expect(row.lastSeenAt).toBeUndefined();
    expect(row.costScrapRaw).toBe(20);
    const seen = bankStockLastSeen(row, res.previousSavedAt, T0);
    expect(seen.text).toBe('1 d ago');
    expect(seen.title).toContain('before your latest run of saves');
    expect(bankStockPriceTitle(row, 600)).toContain('before your latest run of saves');
  });
});

describe('the runs index keeps the last price on sale (scraptfRunsOf)', () => {
  it('after the copy goes off sale, unlike current', () => {
    let id = 1;
    const save = (at: UnixMs, rows: BankStockStored[]): ScraptfSaveRows => ({ batchId: id++, savedAt: at, page: '/buy/hats', rows });
    const runs = scraptfRunsOf([save(T0 - 3 * HOUR, [r('2;6', 20)]), save(T0 - 2 * HOUR, [r('2;6', 25)]), save(T0 - HOUR, [r('1;6', 5)])]);
    expect(runs.get('2;6|')).toMatchObject({ lastSeenAt: T0 - 2 * HOUR, lastOnSale: { keys: 0, scrap: 25 }, current: null, listedSince: null });
    // Never on sale: none.
    expect(scraptfRunsOf([save(T0, [r('3;6', 5, 0)])]).get('3;6|')).toMatchObject({ lastSeenAt: null, lastOnSale: null });
  });
});
