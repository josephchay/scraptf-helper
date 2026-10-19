// 0.7.1 (ACT-10): the Live log's green "Flip" pill only on a copy's newest change while that copy is on
// sale on its page's newest save; an earlier event a later one superseded (or a copy gone since) keeps
// flip false and gets wasFlip, the muted pill. Read from the saves in memory, never a query per read.
// Real in-memory repo and history; a fake entryFor for the Live market. No network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { scraptfEventIsCurrent, scraptfKeyStatesOf } from '../../src/shared/scraptfHistory';
import type { BankStockStored, KeyPriceState, ScraptfBank, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

function r(sku: string, price: number, stock: number | null = 1): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap: price, stock, assetId: null };
}

function setup(): { repo: Repo; history: ScraptfHistory; importSave(at: UnixMs, rows: readonly BankStockStored[], bank?: ScraptfBank): void } {
  const repo = openRepo(':memory:');
  repos.push(repo);
  // Pay up to 100 for every item: any price at or under it is a flip now.
  const history = createScraptfHistory({ clock: { now: () => NOW }, log: recordingLogger(), repo, market: { entryFor: () => ({ revenueScrap: 120, maxCostScrap: 100 }) as unknown as MarketEval }, keyPrice: () => KEY });
  return {
    repo,
    history,
    importSave(at, rows, bank = 'hats') {
      repo.transaction(() => {
        const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
        repo.insertBankStock(id, bank, rows, `/buy/${bank}`);
        history.onImport(id);
      });
      history.refresh();
    },
  };
}

const pills = (h: ReturnType<typeof setup>) => h.history.changes({}, NOW).map((e) => [e.sku, e.kind, e.flip, e.wasFlip === true]);

describe('the Flip pill on superseded events (ACT-10)', () => {
  it('new, then gone: the new event is no flip any more, but was one', () => {
    const h = setup();
    h.importSave(NOW - 3 * HOUR, [r('1;6', 50)]);
    h.importSave(NOW - 2 * HOUR, [r('1;6', 50), r('2;6', 40)]);
    expect(pills(h)).toEqual([['2;6', 'new', true, false]]);
    h.importSave(NOW - HOUR, [r('1;6', 50)]);
    expect(pills(h)).toEqual([
      ['2;6', 'gone', false, false],
      ['2;6', 'new', false, true],
    ]);
  });

  it('new, then cheaper: only the newest event of the copy keeps the pill', () => {
    const h = setup();
    h.importSave(NOW - 3 * HOUR, [r('1;6', 50)]);
    h.importSave(NOW - 2 * HOUR, [r('1;6', 50), r('2;6', 40)]);
    h.importSave(NOW - HOUR, [r('1;6', 50), r('2;6', 30)]);
    expect(pills(h)).toEqual([
      ['2;6', 'cheaper', true, false],
      ['2;6', 'new', false, true],
    ]);
    // A stock move at the same price is the newest stock event; the drop it follows still stands, so it
    // keeps its pill (the feed hides stock moves by default: the drop must not read "was a flip").
    h.importSave(NOW - 30 * MIN, [r('1;6', 50), r('2;6', 30, 4)]);
    expect(pills(h)).toEqual([
      ['2;6', 'stock', true, false],
      ['2;6', 'cheaper', true, false],
      ['2;6', 'new', false, true],
    ]);
    // A second stock move supersedes the first only.
    h.importSave(NOW - 20 * MIN, [r('1;6', 50), r('2;6', 30, 2)]);
    expect(pills(h)).toEqual([
      ['2;6', 'stock', true, false],
      ['2;6', 'stock', false, true],
      ['2;6', 'cheaper', true, false],
      ['2;6', 'new', false, true],
    ]);
    // A price move supersedes the drop and every stock move before it.
    h.importSave(NOW - 10 * MIN, [r('1;6', 50), r('2;6', 35, 2)]);
    expect(pills(h)).toEqual([
      ['2;6', 'pricier', true, false],
      ['2;6', 'stock', false, true],
      ['2;6', 'stock', false, true],
      ['2;6', 'cheaper', false, true],
      ['2;6', 'new', false, true],
    ]);
  });

  it('an event past the copy\'s price is no flip, and never "was" one', () => {
    const h = setup();
    h.importSave(NOW - 3 * HOUR, [r('1;6', 50)]);
    h.importSave(NOW - 2 * HOUR, [r('1;6', 150)]);
    expect(pills(h)).toEqual([['1;6', 'pricier', false, false]]);
  });

  it('holds when the save that showed the change was thinned away (the event sits between kept saves)', () => {
    const states = scraptfKeyStatesOf([
      { batchId: 1, savedAt: NOW - 3 * DAY, page: '/buy/hats', rows: [r('1;6', 50)] },
      // The save at NOW - 2 d 1 h that wrote the 'cheaper' event is gone; the next kept one shows its price.
      { batchId: 3, savedAt: NOW - 2 * DAY, page: '/buy/hats', rows: [r('1;6', 40)] },
      { batchId: 4, savedAt: NOW - DAY, page: '/buy/hats', rows: [r('1;6', 40)] },
    ]);
    const st = states.get('1;6|');
    expect(st).toEqual({ onSale: true, since: NOW - 2 * DAY, prevAt: NOW - 3 * DAY, priceSince: NOW - 2 * DAY, pricePrevAt: NOW - 3 * DAY });
    expect(scraptfEventIsCurrent({ at: NOW - 2 * DAY - HOUR }, st)).toBe(true);
    expect(scraptfEventIsCurrent({ at: NOW - 3 * DAY }, st)).toBe(false);
    expect(scraptfEventIsCurrent({ at: NOW - DAY }, st)).toBe(false);
  });

  it('a stock move alone starts no new price state (the thinned span is the price one)', () => {
    const states = scraptfKeyStatesOf([
      { batchId: 1, savedAt: NOW - 3 * DAY, page: '/buy/hats', rows: [r('1;6', 50, 2)] },
      { batchId: 3, savedAt: NOW - 2 * DAY, page: '/buy/hats', rows: [r('1;6', 40, 2)] },
      { batchId: 4, savedAt: NOW - DAY, page: '/buy/hats', rows: [r('1;6', 40, 1)] },
    ]);
    const st = states.get('1;6|');
    expect(st).toEqual({ onSale: true, since: NOW - DAY, prevAt: NOW - 2 * DAY, priceSince: NOW - 2 * DAY, pricePrevAt: NOW - 3 * DAY });
    // The drop (written by a thinned save) is still the copy's price; the stock move is its newest one.
    expect(scraptfEventIsCurrent({ at: NOW - 2 * DAY - HOUR, kind: 'cheaper' }, st)).toBe(true);
    expect(scraptfEventIsCurrent({ at: NOW - DAY, kind: 'stock' }, st)).toBe(true);
    expect(scraptfEventIsCurrent({ at: NOW - 2 * DAY, kind: 'stock' }, st)).toBe(false);
    // Sold out since: nothing is current.
    const gone = scraptfKeyStatesOf([
      { batchId: 1, savedAt: NOW - 2 * DAY, page: '/buy/hats', rows: [r('1;6', 40, 2)] },
      { batchId: 2, savedAt: NOW - DAY, page: '/buy/hats', rows: [r('1;6', 40, 0)] },
    ]).get('1;6|');
    expect(scraptfEventIsCurrent({ at: NOW - 2 * DAY, kind: 'new' }, gone)).toBe(false);
  });

  it('reads no database row for it: one feed query per read', () => {
    const h = setup();
    h.importSave(NOW - 3 * HOUR, [r('1;6', 50)]);
    h.importSave(NOW - 2 * HOUR, [r('1;6', 50), r('2;6', 40)]);
    h.history.changes({}, NOW);
    const rows = vi.spyOn(h.repo, 'bankStockRowsOf');
    const index = vi.spyOn(h.repo, 'bankStockSaveIndex');
    const events = vi.spyOn(h.repo, 'scraptfEvents');
    h.history.changes({}, NOW);
    expect([rows.mock.calls.length, index.mock.calls.length, events.mock.calls.length]).toEqual([0, 0, 1]);
  });

  it('leaves the pills as they are while the saves cannot be read', () => {
    const h = setup();
    h.importSave(NOW - 3 * HOUR, [r('1;6', 50)]);
    h.importSave(NOW - 2 * HOUR, [r('1;6', 50), r('2;6', 40)]);
    h.importSave(NOW - HOUR, [r('1;6', 50)]);
    vi.spyOn(h.repo, 'bankStockSaveIndex').mockImplementation(() => {
      throw new Error('database is locked');
    });
    h.history.refresh();
    expect(pills(h)).toEqual([
      ['2;6', 'gone', false, false],
      ['2;6', 'new', true, false],
    ]);
  });
});
