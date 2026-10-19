// 0.7.1 (DM-6): an item's history reads its price events (new, restocked, cheaper, pricier, gone) and its
// stock moves apart, so a page saved every few minutes (a 'stock' event per save) never pushes a price
// drop out of the drawer. ScraptfHistory.itemHistory over a real in-memory repo, and the shared
// scraptfItemHistoryOf cut. No network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { SCRAPTF_ITEM_EVENTS, SCRAPTF_ITEM_STOCK_EVENTS, SCRAPTF_PRICE_KINDS, scraptfChangeEvent, scraptfItemHistoryOf } from '../../src/shared/scraptfHistory';
import type { BankStockStored, KeyPriceState, ScraptfEventStored, UnixMs } from '../../src/shared/types';
import { SCRAPTF_CHANGE_KINDS } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function r(price: number, stock: number): BankStockStored {
  return { sku: '378;6', specialKey: '', name: 'Team Captain', costKeys: 0, costScrap: price, stock, assetId: null };
}

function setup(): { repo: Repo; history: ScraptfHistory; importSave(at: UnixMs, rows: readonly BankStockStored[]): void } {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const history = createScraptfHistory({ clock: { now: () => NOW }, log: recordingLogger(), repo, market: { entryFor: () => null }, keyPrice: () => KEY });
  return {
    repo,
    history,
    importSave(at, rows) {
      repo.transaction(() => {
        const id = repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank: 'hats' });
        repo.insertBankStock(id, 'hats', rows, '/buy/hats');
        history.onImport(id);
      });
    },
  };
}

describe('item history kinds (DM-6)', () => {
  it('60 stock moves do not push out a price drop', () => {
    const h = setup();
    h.importSave(NOW - 5 * HOUR, [r(60, 1)]);
    h.importSave(NOW - 4 * HOUR, [r(55, 1)]); // the price drop
    for (let i = 1; i <= 60; i++) h.importSave(NOW - 4 * HOUR + i * 3 * MIN, [r(55, 1 + (i % 2))]);
    h.history.refresh();
    expect(h.repo.scraptfEventsForSku('378;6', 500).filter((e) => e.kind === 'stock')).toHaveLength(60);
    const item = h.history.itemHistory('378;6', null, NOW);
    const kinds = item.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'stock')).toHaveLength(SCRAPTF_ITEM_STOCK_EVENTS);
    expect(kinds.filter((k) => k !== 'stock')).toEqual(['cheaper']);
    expect(item.events.find((e) => e.kind === 'cheaper')).toMatchObject({ fromScrap: 60, toScrap: 55 });
    // Newest first, whichever kind.
    for (let i = 1; i < item.events.length; i++) expect(item.events[i - 1]!.id).toBeGreaterThan(item.events[i]!.id);
  });

  it('cuts price events and stock moves apart in the shared rule too', () => {
    const events: ScraptfEventStored[] = [];
    let id = 1;
    const ev = (kind: ScraptfEventStored['kind']): ScraptfEventStored => ({
      id: id++,
      at: NOW - (1000 - id) * MIN,
      bank: 'hats',
      page: '/buy/hats',
      sku: '378;6',
      specialKey: '',
      name: 'Team Captain',
      kind,
      fromKeys: 0,
      fromScrap: 50,
      toKeys: 0,
      toScrap: 50,
      fromStock: 1,
      toStock: 2,
      batchId: id,
    });
    for (let i = 0; i < 70; i++) events.push(ev('cheaper'));
    for (let i = 0; i < 30; i++) events.push(ev('stock'));
    const valued = events.map((e) => scraptfChangeEvent(e, 600, null));
    const out = scraptfItemHistoryOf({ sku: '378;6', banks: [], events: valued, keyPrice: KEY, now: NOW });
    expect(out.events.filter((e) => e.kind === 'stock')).toHaveLength(SCRAPTF_ITEM_STOCK_EVENTS);
    expect(out.events.filter((e) => e.kind !== 'stock')).toHaveLength(SCRAPTF_ITEM_EVENTS);
    // The newest of each.
    expect(out.events[0]!.id).toBe(100);
    expect(Math.min(...out.events.filter((e) => e.kind === 'cheaper').map((e) => e.id))).toBe(21);
  });

  it('the price kinds are every change kind but stock', () => {
    expect([...SCRAPTF_PRICE_KINDS].sort()).toEqual(SCRAPTF_CHANGE_KINDS.filter((k) => k !== 'stock').sort());
  });
});
