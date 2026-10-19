// F20 service history (src/service/domain/scraptfHistory.ts) over a real in-memory repo: S2's events at
// import (the shared rules per page, restocked and stock, none for a first save, an out-of-order save, the
// same file again or a 0-row save, in the import's transaction, multi-page banks), S1's runs index (rows
// read once per save, rebuilt after an import and after thinning, no query per read), S3's item history
// and listed-since joins, S4's feed and CSV, failed reads and a missing key price. A fake entryFor stands
// for the Live market. Saves are pages the user saved (R10); nothing here touches scrap.tf or the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { CSV_BOM } from '../../src/service/domain/csv';
import { DEFAULT_KEY_SCRAP } from '../../src/service/domain/keyprice';
import type { MarketEval } from '../../src/service/domain/market';
import { SCRAPTF_HISTORY_RETRY_MS, createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { bankStockKey, bankStockSpecialKey } from '../../src/shared/bankStock';
import {
  SCRAPTF_CHANGES_CSV_COLUMNS,
  SCRAPTF_CHANGES_DEFAULT_LIMIT,
  SCRAPTF_CHANGES_EXPORT_MAX,
  SCRAPTF_ITEM_EVENTS,
  SCRAPTF_ITEM_STOCK_EVENTS,
  SCRAPTF_PRICE_KINDS,
  scraptfChangeEvent,
  scraptfEventsOf,
  scraptfItemHistoryOf,
  scraptfKeyStatesOf,
  scraptfListedSinceOf,
  scraptfMarkSuperseded,
  scraptfRunsOf,
  type ScraptfSaveRows,
} from '../../src/shared/scraptfHistory';
import type { BankStockStored, ImportPageKind, KeyPriceState, ScraptfBank, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PAINT = bankStockSpecialKey({ paint: 15185211 });

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

function keyPrice(valueScrap: number): KeyPriceState {
  return { valueScrap, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
}

function r(sku: string, price: number | null, stock: number | null = 1, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: price === null ? null : 0, costScrap: price, stock, assetId: null, ...over };
}

/** A price in keys + metal. */
function k(sku: string, keys: number, scrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return r(sku, scrap, 1, { costKeys: keys, ...over });
}

const PAGES: Partial<Record<ScraptfBank, string>> = { hats: '/buy/hats', weapons: '/buy/weapons', list: '/items' };

/** What importSavedPage writes for a recognised page: a batch dated by the file, and its bank_stock rows. */
function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[], page = PAGES[bank] ?? `/buy/${bank}`): number {
  const pageKind: ImportPageKind = bank === 'list' ? 'items-list' : bank === 'unusuals' ? 'unusuals' : 'buy';
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind, fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows, page);
  return id;
}

interface Harness {
  repo: Repo;
  history: ScraptfHistory;
  key: { v: number | null; throws: boolean };
  clock: { t: UnixMs };
  entries: Map<string, Pick<MarketEval, 'revenueScrap' | 'maxCostScrap'>>;
  entryFor: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof recordingLogger>;
  /** importSavedPage's order: the rows and their events in one transaction, then core's refresh. */
  importSave(bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[], page?: string): { batchId: number; events: number };
}

function setup(): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const key = { v: 600 as number | null, throws: false };
  const clock = { t: NOW };
  const entries = new Map<string, Pick<MarketEval, 'revenueScrap' | 'maxCostScrap'>>();
  const entryFor = vi.fn((base: string) => (entries.get(base) ?? null) as Readonly<MarketEval> | null);
  const log = recordingLogger();
  const history = createScraptfHistory({
    clock: { now: () => clock.t },
    log,
    repo,
    market: { entryFor },
    keyPrice: () => {
      if (key.throws) throw new Error('no quotes');
      return keyPrice(key.v as number);
    },
    nameOf: (sku) => (sku === '999;6' ? 'Schema Hat' : sku),
  });
  return {
    repo,
    history,
    key,
    clock,
    entries,
    entryFor,
    log,
    importSave(bank, at, rows, page) {
      let batchId = 0;
      let events = 0;
      repo.transaction(() => {
        batchId = save(repo, bank, at, rows, page);
        events = history.onImport(batchId);
      });
      history.refresh();
      return { batchId, events };
    },
  };
}

/** Every retained save of a bank as the shared rules read them (oldest first), straight from the repo. */
function savesOf(repo: Repo, bank: ScraptfBank): ScraptfSaveRows[] {
  return repo
    .bankStockSaveIndex()
    .filter((s) => s.bank === bank)
    .map((s) => ({ batchId: s.batchId, savedAt: s.savedAt, page: s.page, rows: repo.bankStockRows(s.batchId) }));
}

// ---------------------------------------------------------------------------
// S2: events at import
// ---------------------------------------------------------------------------

describe('onImport (S2): one event per change against the previous save of the page', () => {
  const previous = [
    r('1;6', 30, 2),
    r('2;6', 40),
    r('3;6', 50),
    r('4;6', 20, 0), // listed sold out
    r('5;6', 10, 3),
    r('6;6', 25, 2), // gone next
    k('10;6', 1, 0), // 1 key
  ];
  const newest = [
    r('1;6', 27, 2), // cheaper
    r('2;6', 45), // pricier
    r('3;6', 50), // unchanged
    r('4;6', 20, 4), // back on sale: restocked
    r('5;6', 10, 5), // stock only
    r('7;6', 33), // new
    k('10;6', 0, 590), // 1 key (600) to 590: cheaper at the key price
  ];

  it('writes nothing for a first save, then the shared rules’ events for the next, in the same transaction', () => {
    const h = setup();
    expect(h.importSave('hats', NOW - 3 * HOUR, previous).events).toBe(0);
    expect(h.repo.scraptfEvents()).toEqual([]);
    const second = h.importSave('hats', NOW - 10 * MIN, newest);
    // The repo's rows (by SKU) through the shared rule: the service adds nothing of its own on one page.
    const [prevId] = h.repo.bankStockSaveIndex().map((s) => s.batchId);
    const expected = scraptfEventsOf({
      bank: 'hats',
      page: '/buy/hats',
      at: NOW - 10 * MIN,
      batchId: second.batchId,
      newest: h.repo.bankStockRows(second.batchId),
      previous: h.repo.bankStockRows(prevId!),
      keyScrap: 600,
      seenBefore: () => false,
    });
    expect(second.events).toBe(expected.length);
    const stored = h.repo.scraptfEvents().reverse();
    expect(stored.map(({ id: _id, ...e }) => e)).toEqual(expected);
    expect(stored.map((e) => [e.sku, e.kind]).sort()).toEqual([
      ['10;6', 'cheaper'],
      ['1;6', 'cheaper'],
      ['2;6', 'pricier'],
      ['4;6', 'restocked'],
      ['5;6', 'stock'],
      ['6;6', 'gone'],
      ['7;6', 'new'],
    ]);
    // Dated by the save (the file's time), on its page and batch.
    expect(stored.every((e) => e.at === NOW - 10 * MIN && e.page === '/buy/hats' && e.batchId === second.batchId && e.bank === 'hats')).toBe(true);
  });

  it("is 'restocked' when an earlier retained save of the bank listed it, 'new' when none did", () => {
    const h = setup();
    h.importSave('hats', NOW - 5 * HOUR, [r('1;6', 10), r('8;6', 12)]);
    expect(h.importSave('hats', NOW - 3 * HOUR, [r('1;6', 10)]).events).toBe(1); // 8;6 gone
    h.importSave('hats', NOW - HOUR, [r('1;6', 10), r('8;6', 12), r('9;6', 7)]);
    expect(h.repo.scraptfEvents({ sinceAt: NOW - HOUR }).map((e) => [e.sku, e.kind]).sort()).toEqual([
      ['8;6', 'restocked'],
      ['9;6', 'new'],
    ]);
  });

  it('writes nothing for a save older than the page’s newest, or the same file imported again', () => {
    const h = setup();
    h.importSave('hats', NOW - 3 * HOUR, [r('1;6', 10)]);
    h.importSave('hats', NOW - HOUR, [r('1;6', 12)]);
    const before = h.repo.scraptfEvents();
    expect(before).toHaveLength(1);
    // An older page copied into the watch folder late.
    expect(h.importSave('hats', NOW - 2 * HOUR, [r('1;6', 5), r('2;6', 5)]).events).toBe(0);
    // The newest file picked again on the Import page (same mtime).
    expect(h.importSave('hats', NOW - HOUR, [r('1;6', 12), r('3;6', 1)]).events).toBe(0);
    expect(h.repo.scraptfEvents()).toEqual(before);
    // A later save compares with the newest look of the page (the same file twice: the higher batch id).
    expect(h.importSave('hats', NOW - 10 * MIN, [r('1;6', 12)]).events).toBe(1);
    expect(h.repo.scraptfEvents()[0]).toMatchObject({ sku: '3;6', kind: 'gone' });
  });

  it('writes nothing for a 0-row save or a batch that is not a bank stock save, and refuses bad ids', () => {
    const h = setup();
    h.importSave('hats', NOW - 3 * HOUR, [r('1;6', 10)]);
    const empty = h.repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: NOW, importedAt: NOW, itemCount: 0, bank: 'hats' });
    expect(h.repo.insertBankStock(empty, 'hats', [], '/buy/hats')).toBe(0);
    expect(h.history.onImport(empty)).toBe(0);
    for (const bad of [0, -1, 1.5, Number.NaN, 99_999]) expect(h.history.onImport(bad)).toBe(0);
    expect(h.repo.scraptfEvents()).toEqual([]);
  });

  it('a page is compared with its own previous save only; a moved item is not gone from the bank (multi-page)', () => {
    const h = setup();
    const t1 = NOW - 6 * HOUR;
    const t2 = NOW - 3 * HOUR;
    h.importSave('list', t1, [r('1;6', 10), r('2;6', 20), r('5;6', 50)], '/items');
    // /items/2's first save writes nothing, though /items has one.
    expect(h.importSave('list', t1 + MIN, [r('3;6', 30), r('4;6', 40)], '/items/2').events).toBe(0);
    // 2;6 moved to /items/2: new on that page, and an earlier save of the bank listed it.
    expect(h.importSave('list', t2 - MIN, [r('2;6', 20), r('3;6', 30), r('4;6', 40)], '/items/2').events).toBe(1);
    expect(h.repo.scraptfEvents()[0]).toMatchObject({ sku: '2;6', kind: 'restocked', page: '/items/2' });
    // /items no longer lists it, but /items/2's newest save does: no 'gone' (the stock page shows it listed).
    expect(h.importSave('list', t2, [r('1;6', 10), r('5;6', 50)], '/items').events).toBe(0);
    // Gone for real: 1;6 listed sold out on this page, 5;6 absent here and from every other page.
    expect(h.importSave('list', NOW - HOUR, [r('1;6', 10, 0)], '/items').events).toBe(2);
    expect(h.repo.scraptfEvents({ sinceAt: NOW - HOUR }).map((e) => [e.sku, e.kind]).sort()).toEqual([
      ['1;6', 'gone'],
      ['5;6', 'gone'],
    ]);
    // The runs read the pages together: the move is no break.
    expect(h.history.runsFor('list').get(bankStockKey('2;6', ''))).toMatchObject({ firstSeenAt: t1, listedSince: t1, lastSeenAt: t2 - MIN });
  });

  it('shares the import’s transaction: a later failure rolls the events back and leaves the runs without the save', () => {
    const h = setup();
    h.importSave('hats', NOW - 3 * HOUR, [r('1;6', 10)]);
    const ver = h.history.version();
    expect(() =>
      h.repo.transaction(() => {
        const id = save(h.repo, 'hats', NOW - HOUR, [r('1;6', 8), r('2;6', 3)]);
        expect(h.history.onImport(id)).toBe(2);
        throw new Error('a later step of the import failed');
      }),
    ).toThrow(/later step/);
    expect(h.repo.scraptfEvents()).toEqual([]);
    expect(h.repo.bankStockSaveIndex()).toHaveLength(1);
    // onImport never cached the save its transaction was writing.
    expect(h.history.runsFor('hats').has(bankStockKey('2;6', ''))).toBe(false);
    h.history.refresh();
    expect(h.history.version()).toBe(ver);
    expect(h.history.runsFor('hats').has(bankStockKey('2;6', ''))).toBe(false);
  });

  it('throws what the repo throws (the import rolls back), nothing for its own rules', () => {
    const h = setup();
    h.importSave('hats', NOW - 3 * HOUR, [r('1;6', 10)]);
    vi.spyOn(h.repo, 'insertScraptfEvents').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    expect(() => h.importSave('hats', NOW - HOUR, [r('1;6', 8)])).toThrow(/disk I\/O error/);
    expect(h.repo.bankStockSaveIndex()).toHaveLength(1);
  });

  it('decides cheaper / pricier at the last good key price, else the default, when the key price cannot be read', () => {
    const h = setup();
    h.key.throws = true;
    h.importSave('hats', NOW - 3 * HOUR, [k('10;6', 1, 0)]);
    // 1 key at the default 540 scrap against 590 scrap: pricier.
    expect(DEFAULT_KEY_SCRAP).toBe(540);
    expect(h.importSave('hats', NOW - 2 * HOUR, [k('10;6', 0, 590)]).events).toBe(1);
    expect(h.repo.scraptfEvents()[0]!.kind).toBe('pricier');
    // One good read (600) is remembered through a later failure: 1 key is now dearer than 590 scrap.
    h.key.throws = false;
    expect(h.history.itemHistory('10;6', null, NOW).keyPrice).toEqual(keyPrice(600));
    h.key.throws = true;
    expect(h.importSave('hats', NOW - HOUR, [k('10;6', 1, 0)]).events).toBe(1);
    expect(h.repo.scraptfEvents()[0]!.kind).toBe('pricier');
    expect(h.importSave('hats', NOW - 10 * MIN, [k('10;6', 0, 590)]).events).toBe(1);
    expect(h.repo.scraptfEvents()[0]!.kind).toBe('cheaper');
    expect(h.log.lines.filter((l) => l.msg.includes('key price'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// S1: the runs index
// ---------------------------------------------------------------------------

describe('the runs index (S1)', () => {
  it('equals scraptfRunsOf over each bank’s retained saves and is built lazily on first use', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 5 * HOUR, [r('1;6', 10), r('2;6', 20)]);
    save(h.repo, 'hats', NOW - 2 * HOUR, [r('1;6', 9)]);
    save(h.repo, 'list', NOW - HOUR, [r('1;6', 11)], '/items');
    const hats = scraptfRunsOf(savesOf(h.repo, 'hats'));
    const list = scraptfRunsOf(savesOf(h.repo, 'list'));
    const index = vi.spyOn(h.repo, 'bankStockSaveIndex');
    const rows = vi.spyOn(h.repo, 'bankStockRowsOf');
    expect(h.history.runsFor('hats')).toEqual(hats);
    expect(h.history.runsFor('list')).toEqual(list);
    expect(h.history.runsFor('weapons').size).toBe(0);
    // One index read and one rows read for every save at once; later reads ask nothing.
    for (let i = 0; i < 50; i++) {
      h.history.runsFor('hats');
      h.history.listedSinceFor('1;6');
      h.history.listedSinceFor('1;6', 'list');
      h.history.version();
    }
    expect(index).toHaveBeenCalledTimes(1);
    expect(rows).toHaveBeenCalledTimes(1);
  });

  it('reads only a new save’s rows on refresh, rebuilds only its bank, and moves the version only on a change', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 5 * HOUR, [r('1;6', 10)]);
    save(h.repo, 'weapons', NOW - 5 * HOUR, [r('45;6', 3)]);
    const weaponsRuns = h.history.runsFor('weapons');
    const v1 = h.history.version();
    const rows = vi.spyOn(h.repo, 'bankStockRowsOf');
    h.history.refresh();
    expect(h.history.version()).toBe(v1);
    expect(rows).not.toHaveBeenCalled();
    const id = save(h.repo, 'hats', NOW - HOUR, [r('1;6', 8), r('2;6', 4)]);
    h.history.refresh();
    expect(rows.mock.calls).toEqual([[[id]]]);
    expect(h.history.version()).toBeGreaterThan(v1);
    expect(h.history.runsFor('hats').get(bankStockKey('2;6', ''))).toMatchObject({ firstSeenAt: NOW - HOUR, listedSince: NOW - HOUR });
    // The other bank's runs are the same object: nothing of it was rebuilt.
    expect(h.history.runsFor('weapons')).toBe(weaponsRuns);
  });

  it('a committed import shows on the next read even before core refreshes', () => {
    const h = setup();
    h.importSave('hats', NOW - 3 * HOUR, [r('1;6', 10)]);
    expect(h.history.runsFor('hats').size).toBe(1);
    h.repo.transaction(() => {
      const id = save(h.repo, 'hats', NOW - HOUR, [r('1;6', 10), r('2;6', 5)]);
      expect(h.history.onImport(id)).toBe(1);
    });
    expect(h.history.runsFor('hats').get(bankStockKey('2;6', ''))).toMatchObject({ listedSince: NOW - HOUR });
  });

  it('follows the thinning: pruned saves leave the runs, first seen and time listed move to the retained saves', () => {
    const h = setup();
    const at = [NOW - 100 * DAY, NOW - 20 * DAY, NOW - 20 * DAY + HOUR, NOW - 2 * HOUR, NOW - HOUR];
    save(h.repo, 'hats', at[0]!, [r('1;6', 50)]);
    save(h.repo, 'hats', at[1]!, [r('1;6', 48)]);
    save(h.repo, 'hats', at[2]!, [r('1;6', 47)]);
    save(h.repo, 'hats', at[3]!, [r('1;6', 45), r('2;6', 10)]);
    save(h.repo, 'hats', at[4]!, [r('1;6', 44), r('2;6', 10)]);
    expect(h.history.runsFor('hats').get(bankStockKey('1;6', ''))).toMatchObject({ firstSeenAt: at[0], listedSince: at[0], runStart: { keys: 0, scrap: 50 } });
    expect(h.history.itemHistory('1;6', null, NOW).points).toHaveLength(5);
    const v = h.history.version();
    // Older than 90 d goes; of the two saves on one UTC day 20 d ago, the newer stays.
    expect(h.repo.pruneBankStock(NOW)).toBe(2);
    h.history.refresh();
    expect(h.history.version()).toBeGreaterThan(v);
    expect(h.history.runsFor('hats')).toEqual(scraptfRunsOf(savesOf(h.repo, 'hats')));
    expect(h.history.runsFor('hats').get(bankStockKey('1;6', ''))).toMatchObject({ firstSeenAt: at[2], listedSince: at[2], runStart: { keys: 0, scrap: 47 } });
    const item = h.history.itemHistory('1;6', null, NOW);
    expect(item.points.map((p) => p.at)).toEqual(at.slice(2));
    expect(item.change.listed).toEqual({ fromScrap: 47, toScrap: 44, deltaScrap: -3, pct: -3 / 47, since: at[2] });
  });

  it('a failed read keeps the last good index, logs once per streak, retries after the delay or at once on refresh', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - HOUR, [r('1;6', 10)]);
    expect(h.history.runsFor('hats').size).toBe(1);
    const index = vi.spyOn(h.repo, 'bankStockSaveIndex').mockImplementation(() => {
      throw new Error('database is locked');
    });
    h.history.refresh();
    expect(h.history.runsFor('hats').size).toBe(1);
    h.history.runsFor('hats');
    h.history.listedSinceFor('1;6');
    expect(index).toHaveBeenCalledTimes(1);
    h.clock.t += SCRAPTF_HISTORY_RETRY_MS;
    h.history.runsFor('hats');
    expect(index).toHaveBeenCalledTimes(2);
    h.history.refresh();
    expect(index).toHaveBeenCalledTimes(3);
    expect(h.log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    index.mockRestore();
    save(h.repo, 'hats', NOW, [r('1;6', 10), r('2;6', 1)]);
    h.history.refresh();
    expect(h.history.runsFor('hats').size).toBe(2);
  });

  it('a history never loaded answers empty while the database fails, and never throws', () => {
    const h = setup();
    vi.spyOn(h.repo, 'bankStockSaveIndex').mockImplementation(() => {
      throw new Error('database is locked');
    });
    expect(h.history.runsFor('hats').size).toBe(0);
    expect(h.history.listedSinceFor('1;6')).toBeNull();
    expect(h.history.version()).toBe(0);
    expect(h.history.itemHistory('1;6', null, NOW)).toMatchObject({ bank: null, points: [] });
  });
});

// ---------------------------------------------------------------------------
// S3: item history and listed since
// ---------------------------------------------------------------------------

describe('itemHistory (S3)', () => {
  const T = [NOW - 8 * DAY, NOW - 30 * HOUR, NOW - 20 * HOUR, NOW - 3 * HOUR, NOW - 30 * MIN];

  function seeded(): Harness {
    const h = setup();
    h.importSave('hats', T[0]!, [k('1;6', 1, 0, { name: 'Team Captain' }), r('2;6', 10)]);
    h.importSave('hats', T[1]!, [k('1;6', 1, 9, { name: 'Team Captain' }), r('2;6', 10)]);
    h.importSave('hats', T[2]!, [r('2;6', 10)]); // a gap: gone from its page
    h.importSave('hats', T[3]!, [k('1;6', 1, 0, { name: 'Team Captain' }), r('2;6', 10)]);
    h.importSave('hats', T[4]!, [k('1;6', 0, 590, { name: 'Team Captain', stock: 3 }), r('2;6', 10)]);
    return h;
  }

  it('one point per retained save of its page (a gap when not listed), time listed and the changes, on raw prices at the key price now', () => {
    const h = seeded();
    h.entries.set('1;6', { revenueScrap: 700, maxCostScrap: 620 });
    const item = h.history.itemHistory('1;6', null, NOW);
    expect(item).toMatchObject({ sku: '1;6', specialKey: '', name: 'Team Captain', bank: 'hats', firstSeenAt: T[0], listedSince: T[3], lastSeenAt: T[4], generatedAt: NOW });
    expect(item.points.map((p) => [p.at, p.listed, p.costScrap])).toEqual([
      [T[0], true, 600],
      [T[1], true, 609],
      [T[2], false, 0],
      [T[3], true, 600],
      [T[4], true, 590],
    ]);
    expect(item.current).toEqual({ costScrap: 590, stock: 3, bank: 'hats' });
    expect(item.change.h1).toEqual({ fromScrap: 600, toScrap: 590, deltaScrap: -10, pct: -10 / 600, since: T[3] });
    expect(item.change.h24).toEqual({ fromScrap: 609, toScrap: 590, deltaScrap: -19, pct: -19 / 609, since: T[1] });
    expect(item.change.d7).toEqual({ fromScrap: 600, toScrap: 590, deltaScrap: -10, pct: -10 / 600, since: T[0] });
    expect(item.change.listed).toEqual({ fromScrap: 600, toScrap: 590, deltaScrap: -10, pct: -10 / 600, since: T[3] });
    // The copy's feed, newest first, valued now and joined to the live buy side. 0.7.1 (ACT-10): only the
    // newest event of a copy on sale keeps the Flip pill; the ones it superseded say they were one.
    expect(item.events.map((e) => [e.kind, e.toValueScrap, e.flip, e.wasFlip === true])).toEqual([
      ['cheaper', 590, true, false],
      ['restocked', 600, false, true],
      ['gone', null, false, false],
      ['pricier', 609, false, true],
    ]);
    expect(item.keyPrice).toEqual(keyPrice(600));
  });

  it('equals scraptfItemHistoryOf over the same saves and events, at any key price', () => {
    const h = seeded();
    h.importSave('list', NOW - 5 * DAY, [r('1;6', 500)], '/items');
    h.entries.set('1;6', { revenueScrap: 700, maxCostScrap: 620 });
    for (const K of [600, 650]) {
      h.key.v = K;
      const valued = h.repo.scraptfEventsForSku('1;6', 500).map((e) => scraptfChangeEvent(e, K, { revenueScrap: 700, maxCostScrap: 620 }));
      // 0.7.1 (ACT-10): superseded flips by the same shared rule over the same saves.
      const events = scraptfMarkSuperseded(valued, (bank) => scraptfKeyStatesOf(savesOf(h.repo, bank)));
      const expected = scraptfItemHistoryOf({
        sku: '1;6',
        specialKey: null,
        banks: [
          { bank: 'hats', saves: savesOf(h.repo, 'hats') },
          { bank: 'list', saves: savesOf(h.repo, 'list') },
        ],
        events,
        keyPrice: keyPrice(K),
        now: NOW,
      });
      expect(h.history.itemHistory('1;6', null, NOW)).toEqual(expected);
    }
    // A key price move alone moves the values, never an unchanged raw price's change.
    const item = h.history.itemHistory('1;6', null, NOW);
    expect(item.points[0]!.costScrap).toBe(650);
    expect(item.change.d7!.fromScrap).toBe(650);
  });

  it('reads a painted copy by its own rows; the SKU’s paint or the special key names it', () => {
    const h = setup();
    h.importSave('hats', NOW - 2 * HOUR, [r('1;6', 40), r('1;6', 90, 1, { specialKey: PAINT })]);
    h.importSave('hats', NOW - HOUR, [r('1;6', 40), r('1;6', 85, 1, { specialKey: PAINT })]);
    const painted = h.history.itemHistory('1;6;p15185211', null, NOW);
    expect(painted).toMatchObject({ sku: '1;6', specialKey: PAINT, current: { costScrap: 85 } });
    expect(painted.events.map((e) => e.kind)).toEqual(['cheaper']);
    expect(h.history.itemHistory('1;6', PAINT, NOW).current!.costScrap).toBe(85);
    const clean = h.history.itemHistory('1;6', null, NOW);
    expect(clean).toMatchObject({ specialKey: '', current: { costScrap: 40 }, events: [] });
  });

  it('reads the copy’s own newest events: a busy clean copy never pushes a painted copy’s events out', () => {
    const h = setup();
    // The painted copy changes once, long ago; the clean copy's stock moves on every later save.
    h.importSave('hats', NOW - 3 * DAY, [r('1;6', 40, 1), r('1;6', 90, 1, { specialKey: PAINT })]);
    h.importSave('hats', NOW - 3 * DAY + HOUR, [r('1;6', 40, 2), r('1;6', 85, 1, { specialKey: PAINT })]);
    const busy: BankStockStored[][] = [];
    for (let i = 0; i < 520; i++) busy.push([r('1;6', 40, 3 + (i % 2)), r('1;6', 85, 1, { specialKey: PAINT })]);
    h.repo.transaction(() => {
      busy.forEach((rows, i) => {
        const id = save(h.repo, 'hats', NOW - 2 * DAY + i * MIN, rows);
        h.history.onImport(id);
      });
    });
    h.history.refresh();
    expect(h.repo.scraptfEventsForSku('1;6', 600).filter((e) => e.specialKey === PAINT)).toHaveLength(1);
    const spy = vi.spyOn(h.repo, 'scraptfEvents');
    const painted = h.history.itemHistory('1;6;p15185211', null, NOW);
    expect(painted.events.map((e) => [e.specialKey, e.kind, e.toValueScrap])).toEqual([[PAINT, 'cheaper', 85]]);
    // Two reads of that copy's events (0.7.1, DM-6): at most SCRAPTF_ITEM_EVENTS price events and, apart
    // from them, at most SCRAPTF_ITEM_STOCK_EVENTS stock moves.
    expect(spy.mock.calls).toEqual([
      [{ sku: '1;6', specialKey: PAINT, kinds: SCRAPTF_PRICE_KINDS, limit: SCRAPTF_ITEM_EVENTS }],
      [{ sku: '1;6', specialKey: PAINT, kinds: ['stock'], limit: SCRAPTF_ITEM_STOCK_EVENTS }],
    ]);
    const clean = h.history.itemHistory('1;6', null, NOW);
    expect(clean.events).toHaveLength(SCRAPTF_ITEM_STOCK_EVENTS);
    expect(clean.events.every((e) => e.specialKey === '' && e.kind === 'stock')).toBe(true);
  });

  it('an item never saved: an empty history named by the schema; never throws', () => {
    const h = seeded();
    expect(h.history.itemHistory('999;6', null, NOW)).toMatchObject({ sku: '999;6', name: 'Schema Hat', bank: null, points: [], current: null, events: [] });
    expect(h.history.itemHistory('not a sku', undefined, NOW)).toMatchObject({ bank: null, points: [] });
    vi.spyOn(h.repo, 'scraptfEvents').mockImplementation(() => {
      throw new Error('database is locked');
    });
    expect(h.history.itemHistory('1;6', null, NOW)).toMatchObject({ sku: '1;6', bank: null, points: [] });
    expect(h.log.lines.some((l) => l.level === 'warn' && l.msg.includes('item'))).toBe(true);
  });

  it('values with the default key price when it cannot be read, and says so', () => {
    const h = seeded();
    h.key.throws = true;
    const fresh = createScraptfHistory({ clock: { now: () => NOW }, log: h.log, repo: h.repo, market: { entryFor: () => null }, keyPrice: () => null as unknown as KeyPriceState });
    const item = fresh.itemHistory('1;6', null, NOW);
    expect(item.keyPrice).toMatchObject({ valueScrap: DEFAULT_KEY_SCRAP, source: 'default' });
    expect(item.points[0]!.costScrap).toBe(DEFAULT_KEY_SCRAP);
    expect(fresh.changes({}, NOW)[0]).toMatchObject({ kind: 'cheaper', fromValueScrap: DEFAULT_KEY_SCRAP, toValueScrap: 590 });
  });
});

describe('listedSinceFor (MarketRow.scraptfListedSince)', () => {
  it('is scraptfListedSinceOf of the bank’s runs; without a bank, a bank page before the list; null when not listed now', () => {
    const h = setup();
    h.importSave('list', NOW - 5 * DAY, [r('1;6', 50), r('3;6', 5)], '/items');
    h.importSave('list', NOW - 10 * MIN, [r('1;6', 50), r('3;6', 5)], '/items');
    h.importSave('hats', NOW - 2 * DAY, [r('1;6', 45, 1, { specialKey: PAINT }), r('2;6', 9)]);
    h.importSave('hats', NOW - 3 * HOUR, [r('1;6', 45, 1, { specialKey: PAINT }), r('1;6', 40)]);
    for (const bank of ['hats', 'list'] as const) {
      for (const sku of ['1;6', '2;6', '3;6', '4;6']) expect(h.history.listedSinceFor(sku, bank)).toBe(scraptfListedSinceOf(h.history.runsFor(bank), sku));
    }
    // The earliest run among the copies listed now (the painted one since 2 d).
    expect(h.history.listedSinceFor('1;6', 'hats')).toBe(NOW - 2 * DAY);
    expect(h.history.listedSinceFor('1;6', 'list')).toBe(NOW - 5 * DAY);
    expect(h.history.listedSinceFor('1;6')).toBe(NOW - 2 * DAY);
    expect(h.history.listedSinceFor('1;6', null)).toBe(NOW - 2 * DAY);
    // Gone from hats: not listed now there; the list alone still lists 3;6.
    expect(h.history.listedSinceFor('2;6', 'hats')).toBeNull();
    expect(h.history.listedSinceFor('2;6')).toBeNull();
    expect(h.history.listedSinceFor('3;6')).toBe(NOW - 5 * DAY);
    expect(h.history.listedSinceFor('4;6')).toBeNull();
    expect(h.history.listedSinceFor('1;6', 'weapons')).toBeNull();
    expect(h.history.listedSinceFor(7 as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S4: the change feed and its CSV
// ---------------------------------------------------------------------------

describe('changes and csv (S4)', () => {
  function feed(): Harness {
    const h = setup();
    h.importSave('hats', NOW - 5 * HOUR, [r('1;6', 40), r('2;6', 20), r('1;6', 90, 1, { specialKey: PAINT })]);
    h.importSave('hats', NOW - 3 * HOUR, [r('1;6', 36), r('2;6', 22), r('1;6', 80, 1, { specialKey: PAINT })]);
    h.importSave('weapons', NOW - 4 * HOUR, [r('45;6', 3)]);
    h.importSave('weapons', NOW - HOUR, [r('45;6', 2), r('46;6', 5)]);
    h.entries.set('1;6', { revenueScrap: 60, maxCostScrap: 50 });
    h.entries.set('46;6', { revenueScrap: 4, maxCostScrap: 3 });
    return h;
  }

  it('newest first, valued at the key price now and joined to the live buy side of each base SKU (one lookup per base)', () => {
    const h = feed();
    const all = h.history.changes({}, NOW);
    // Newest save first; within a save, the order the rows were written (by SKU, then copy) reversed.
    expect(all.map((e) => [e.bank, e.sku, e.kind])).toEqual([
      ['weapons', '46;6', 'new'],
      ['weapons', '45;6', 'cheaper'],
      ['hats', '2;6', 'pricier'],
      ['hats', '1;6', 'cheaper'],
      ['hats', '1;6', 'cheaper'],
    ]);
    expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((a, b) => b - a));
    expect(all[3]).toMatchObject({ specialKey: PAINT, hasExtras: true, fromValueScrap: 90, toValueScrap: 80, deltaScrap: -10, revenueScrap: 60, maxCostScrap: 50, flip: false });
    expect(all[4]).toMatchObject({ hasExtras: false, toValueScrap: 36, revenueScrap: 60, maxCostScrap: 50, flip: true });
    expect(all[0]).toMatchObject({ toValueScrap: 5, flip: false });
    expect(all[1]).toMatchObject({ revenueScrap: null, maxCostScrap: null, flip: false });
    expect(h.entryFor.mock.calls.map((c) => c[0]).sort()).toEqual(['1;6', '2;6', '45;6', '46;6']);
  });

  it('filters by bank, kinds and SKU (any copy of its base), pages by id and clamps the limit', () => {
    const h = feed();
    expect(h.history.changes({ bank: 'hats' }, NOW)).toHaveLength(3);
    expect(h.history.changes({ kinds: ['new', 'pricier'] }, NOW).map((e) => e.sku)).toEqual(['46;6', '2;6']);
    expect(h.history.changes({ kinds: [] }, NOW)).toHaveLength(5);
    expect(h.history.changes({ sku: '1;6;p15185211' }, NOW).map((e) => e.specialKey)).toEqual([PAINT, '']);
    const [first, second] = h.history.changes({ limit: 2 }, NOW);
    expect(h.history.changes({ beforeId: second!.id }, NOW).map((e) => e.id)).toEqual(h.history.changes({}, NOW).slice(2).map((e) => e.id));
    expect(first!.id).toBeGreaterThan(second!.id);
    const spy = vi.spyOn(h.repo, 'scraptfEvents');
    h.history.changes({}, NOW);
    h.history.changes({ limit: 10_000 }, NOW);
    expect(spy.mock.calls.map((c) => c[0]!.limit)).toEqual([SCRAPTF_CHANGES_DEFAULT_LIMIT, 500]);
  });

  it('exports the filtered feed (paging dropped, at most SCRAPTF_CHANGES_EXPORT_MAX) with the shared cells', () => {
    const h = feed();
    const spy = vi.spyOn(h.repo, 'scraptfEvents');
    const csv = h.history.csv({ bank: 'hats', beforeId: 1, limit: 1 }, NOW);
    expect(spy.mock.calls[0]![0]).toEqual({ bank: 'hats', limit: SCRAPTF_CHANGES_EXPORT_MAX });
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(CSV_BOM.length).trim().split(/\r?\n/);
    expect(lines[0]).toBe(SCRAPTF_CHANGES_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('hats,/buy/hats,2;6,Item 2;6,,pricier');
    expect(lines.slice(1).every((l) => l.includes(',hats,/buy/hats,'))).toBe(true);
  });

  it('never throws: a failed read is an empty feed and a header-only file', () => {
    const h = feed();
    vi.spyOn(h.repo, 'scraptfEvents').mockImplementation(() => {
      throw new Error('database is locked');
    });
    expect(h.history.changes({}, NOW)).toEqual([]);
    expect(h.history.csv({}, NOW).slice(CSV_BOM.length).trim()).toBe(SCRAPTF_CHANGES_CSV_COLUMNS.join(','));
    expect(h.log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });
});
