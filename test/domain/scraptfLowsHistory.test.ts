// 0.9 (history, H9): scrap.tf lows in the history domain (createScraptfHistory with `lows: repo`) over a real
// in-memory repo. importSavedPage's order: the save's rows, its events and its lows in one transaction (recordLows in a
// nested SAVEPOINT, so a failure costs only the lows), then core's refresh. lowsFor merges the retained saves with
// the stored table, so a low only in a thinned save survives, and values both at the key price now. Only pages the
// user saved (R10); nothing here touches scrap.tf or the network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createScraptfHistory, type ScraptfHistory, type ScraptfHistoryDeps } from '../../src/service/domain/scraptfHistory';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { bankStockKey } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { scraptfLowSightingsOf } from '../../src/shared/scraptfLows';
import type { BankStockStored, KeyPriceState, ScraptfBank, UnixMs } from '../../src/shared/types';
import { createStubSchema } from '../import/schemaStub';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const keyPrice = (valueScrap: number): KeyPriceState => ({ valueScrap, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null });

function r(sku: string, keys: number | null, scrap: number | null, stock: number | null = 1): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: keys, costScrap: scrap, stock, assetId: null };
}

interface Harness {
  repo: Repo;
  history: ScraptfHistory;
  key: { v: number };
  /** Saves the save index no longer lists (as if thinned by maintenance). */
  hidden: Set<number>;
  log: ReturnType<typeof recordingLogger>;
  importSave(bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): { batchId: number; lows: number };
}

function setup(opts: { lows?: boolean; wrapLows?: (repo: Repo) => NonNullable<ScraptfHistoryDeps['lows']> } = {}): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const key = { v: 600 };
  const hidden = new Set<number>();
  const log = recordingLogger();
  const view: Repo = { ...repo, bankStockSaveIndex: () => repo.bankStockSaveIndex().filter((s) => !hidden.has(s.batchId)) };
  const lows = opts.lows === false ? undefined : (opts.wrapLows?.(repo) ?? repo);
  const history = createScraptfHistory({
    clock: { now: () => NOW },
    log,
    repo: view,
    market: { entryFor: () => null },
    keyPrice: () => keyPrice(key.v),
    ...(lows ? { lows } : {}),
  });
  return {
    repo,
    history,
    key,
    hidden,
    log,
    importSave(bank, at, rows) {
      let batchId = 0;
      let lowsWritten = 0;
      repo.transaction(() => {
        batchId = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
        repo.insertBankStock(batchId, bank, rows, `/buy/${bank}`);
        history.onImport(batchId);
        lowsWritten = history.recordLows(batchId);
      });
      history.refresh();
      return { batchId, lows: lowsWritten };
    },
  };
}

describe('recordLows: each save that wrote bank stock, in the import transaction', () => {
  it('folds the save’s copies on sale into scraptf_lows, writing only changed rows', () => {
    const h = setup();
    expect(h.importSave('hats', NOW - 2 * DAY, [r('378;6', 0, 45), r('126;6', null, null), r('200;6', 1, 0)]).lows).toBe(2);
    expect(h.repo.scraptfLows('hats')).toEqual([
      { bank: 'hats', sku: '200;6', specialKey: '', keys: 1, scrap: 0, firstAt: NOW - 2 * DAY, lastAt: NOW - 2 * DAY, since: NOW - 2 * DAY, seenAt: NOW - 2 * DAY },
      { bank: 'hats', sku: '378;6', specialKey: '', keys: 0, scrap: 45, firstAt: NOW - 2 * DAY, lastAt: NOW - 2 * DAY, since: NOW - 2 * DAY, seenAt: NOW - 2 * DAY },
    ]);
    // A later save at a higher price only moves seenAt; at the same price lastAt too.
    expect(h.importSave('hats', NOW - DAY, [r('378;6', 0, 50), r('200;6', 1, 0)]).lows).toBe(2);
    expect(h.repo.scraptfLows('hats').find((x) => x.sku === '378;6')).toMatchObject({ scrap: 45, firstAt: NOW - 2 * DAY, lastAt: NOW - 2 * DAY, seenAt: NOW - DAY });
    expect(h.repo.scraptfLows('hats').find((x) => x.sku === '200;6')).toMatchObject({ keys: 1, lastAt: NOW - DAY, seenAt: NOW - DAY });
    // A save with nothing on sale writes nothing; a bad id writes nothing.
    expect(h.importSave('hats', NOW, [r('378;6', null, null)]).lows).toBe(0);
    expect(h.history.recordLows(0)).toBe(0);
    expect(h.history.recordLows(999)).toBe(0);
  });

  it('lowers since and firstAt for an out-of-order older save', () => {
    const h = setup();
    h.importSave('hats', NOW, [r('378;6', 0, 45), r('6;6', 0, 30)]);
    h.importSave('hats', NOW - 3 * DAY, [r('378;6', 0, 45), r('6;6', 0, 27)]);
    const lows = h.repo.scraptfLows('hats');
    expect(lows.find((x) => x.sku === '378;6')).toMatchObject({ scrap: 45, firstAt: NOW - 3 * DAY, lastAt: NOW, since: NOW - 3 * DAY, seenAt: NOW });
    expect(lows.find((x) => x.sku === '6;6')).toMatchObject({ scrap: 27, firstAt: NOW - 3 * DAY, lastAt: NOW - 3 * DAY, since: NOW - 3 * DAY, seenAt: NOW });
  });

  it('is undone with the import it belongs to, and a failure of its own costs only the lows', () => {
    const h = setup();
    expect(() =>
      h.repo.transaction(() => {
        const id = h.repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: NOW, importedAt: NOW, itemCount: 1, bank: 'hats' });
        h.repo.insertBankStock(id, 'hats', [r('378;6', 0, 45)], '/buy/hats');
        expect(h.history.recordLows(id)).toBe(1);
        throw new Error('import failed later');
      }),
    ).toThrow('import failed later');
    expect(h.repo.scraptfLows('hats')).toEqual([]);

    const broken = setup({
      wrapLows: (repo) => ({
        transaction: repo.transaction.bind(repo),
        scraptfLows: (b) => repo.scraptfLows(b),
        upsertScraptfLows: () => {
          throw new Error('disk full');
        },
      }),
    });
    const a = broken.importSave('hats', NOW - DAY, [r('378;6', 0, 45)]);
    const b = broken.importSave('hats', NOW, [r('378;6', 0, 40)]);
    expect([a.lows, b.lows]).toEqual([0, 0]);
    // Both saves were kept; the warning came once for the streak.
    expect(broken.repo.bankStockSaves('hats')).toHaveLength(2);
    expect(broken.log.lines.filter((l) => /lowest prices/.test(l.msg))).toHaveLength(1);
    // The retained saves still give the low.
    expect(broken.history.lowsFor('hats').get('378;6|')).toMatchObject({ scrap: 40 });
  });

  it('runs through importSavedPage right after onImport, for a page that wrote bank stock', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    const quiet = () => undefined;
    const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
    const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => keyPrice(600), lows: repo });
    const order: string[] = [];
    const ctx = {
      clock: { now: () => NOW },
      log,
      repo,
      schema: createStubSchema(),
      engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine,
      settings: () => mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - HOUR } }),
      push: quiet,
      pricesChanged: quiet,
      scraptfListChanged: quiet,
      scraptfHistory: {
        onImport: (id: number) => {
          order.push('onImport');
          return history.onImport(id);
        },
        recordLows: (id: number) => {
          order.push('recordLows');
          return history.recordLows(id);
        },
      },
      bankStockChanged: quiet,
    } as unknown as HandlerContext;
    const html = readFileSync(fileURLToPath(new URL('../fixtures/import/buy_hats.html', import.meta.url)), 'utf8');
    const res = importSavedPage(ctx, { html, fileName: 'buy_hats.html', mtimeMs: NOW - HOUR });
    expect(order).toEqual(['onImport', 'recordLows']);
    const rows = repo.bankStockRows(res.batchId);
    const expected = scraptfLowSightingsOf(rows, 'hats', NOW - HOUR);
    expect(expected.length).toBeGreaterThan(0);
    expect(repo.scraptfLows('hats').map((x) => bankStockKey(x.sku, x.specialKey)).sort()).toEqual(expected.map((s) => s.key).sort());
  });
});

describe('lowsFor: the retained saves merged with the stored lows', () => {
  it('keeps a low only a thinned save showed, through the table', () => {
    const h = setup();
    const old = h.importSave('hats', NOW - 30 * DAY, [r('378;6', 0, 36)]);
    h.importSave('hats', NOW - DAY, [r('378;6', 0, 45)]);
    expect(h.history.lowsFor('hats').get('378;6|')).toEqual({ keys: 0, scrap: 36, valueScrap: 36, firstAt: NOW - 30 * DAY, lastAt: NOW - 30 * DAY, since: NOW - 30 * DAY });
    h.hidden.add(old.batchId);
    h.history.refresh();
    expect(h.history.lowsFor('hats').get('378;6|')).toEqual({ keys: 0, scrap: 36, valueScrap: 36, firstAt: NOW - 30 * DAY, lastAt: NOW - 30 * DAY, since: NOW - 30 * DAY });
    // Without the table the thinned save's low is gone.
    const plain = setup({ lows: false });
    const p = plain.importSave('hats', NOW - 30 * DAY, [r('378;6', 0, 36)]);
    plain.importSave('hats', NOW - DAY, [r('378;6', 0, 45)]);
    plain.hidden.add(p.batchId);
    plain.history.refresh();
    expect(plain.history.lowsFor('hats').get('378;6|')).toMatchObject({ scrap: 45, since: NOW - DAY });
  });

  it('merges a copy only the table knows (a save from before the retained ones) with the saves', () => {
    const h = setup();
    h.repo.upsertScraptfLows([{ bank: 'hats', sku: '6;6', specialKey: '', keys: 0, scrap: 20, firstAt: NOW - 90 * DAY, lastAt: NOW - 80 * DAY, since: NOW - 100 * DAY, seenAt: NOW - 80 * DAY }]);
    h.importSave('hats', NOW - DAY, [r('6;6', 0, 25), r('378;6', 0, 45)]);
    const lows = h.history.lowsFor('hats');
    expect(lows.get('6;6|')).toMatchObject({ scrap: 20, firstAt: NOW - 90 * DAY, since: NOW - 100 * DAY });
    expect(lows.get('378;6|')).toMatchObject({ scrap: 45 });
    expect(h.history.lowsFor('weapons').size).toBe(0);
  });

  it('values at the key price now and rebuilds when it moves', () => {
    const h = setup();
    h.importSave('hats', NOW - 2 * DAY, [r('378;6', 1, 0)]);
    h.importSave('hats', NOW - DAY, [r('378;6', 0, 550)]);
    const first = h.history.lowsFor('hats');
    expect(first.get('378;6|')).toMatchObject({ keys: 0, scrap: 550, valueScrap: 550 });
    // Memoised while nothing moved.
    expect(h.history.lowsFor('hats')).toBe(first);
    h.key.v = 500;
    expect(h.history.lowsFor('hats').get('378;6|')).toMatchObject({ keys: 1, scrap: 0, valueScrap: 500, firstAt: NOW - 2 * DAY });
  });

  it('reads the table again after refresh() (maintenance pruned or another writer changed it)', () => {
    const h = setup();
    h.importSave('hats', NOW - DAY, [r('378;6', 0, 45)]);
    expect(h.history.lowsFor('hats').get('378;6|')!.scrap).toBe(45);
    h.repo.upsertScraptfLows([{ bank: 'hats', sku: '378;6', specialKey: '', keys: 0, scrap: 30, firstAt: NOW - 9 * DAY, lastAt: NOW - 9 * DAY, since: NOW - 9 * DAY, seenAt: NOW - DAY }]);
    expect(h.history.lowsFor('hats').get('378;6|')!.scrap).toBe(45);
    h.history.refresh();
    expect(h.history.lowsFor('hats').get('378;6|')!.scrap).toBe(30);
  });

  it('gives the retained lows alone without deps.lows, and recordLows returns 0', () => {
    const h = setup({ lows: false });
    expect(h.importSave('hats', NOW - DAY, [r('378;6', 0, 45)]).lows).toBe(0);
    expect(h.repo.scraptfLows('hats')).toEqual([]);
    expect(h.history.lowsFor('hats').get('378;6|')).toMatchObject({ scrap: 45, valueScrap: 45 });
  });
});

describe("itemHistory's low", () => {
  it("is the copy's low in the history's bank, and absent for an item never saved", () => {
    const h = setup();
    h.importSave('hats', NOW - 2 * DAY, [r('378;6', 0, 40)]);
    h.importSave('hats', NOW - DAY, [r('378;6', 0, 45)]);
    const item = h.history.itemHistory('378;6', null, NOW);
    expect(item.bank).toBe('hats');
    expect(item.low).toEqual({ keys: 0, scrap: 40, valueScrap: 40, firstAt: NOW - 2 * DAY, lastAt: NOW - 2 * DAY, since: NOW - 2 * DAY });
    const never = h.history.itemHistory('126;6', null, NOW);
    expect(never.bank).toBeNull();
    expect('low' in never).toBe(false);
  });
});
