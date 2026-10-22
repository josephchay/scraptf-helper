// Audit banks-1 / xcontract-1 (0.7.3): the drawer's two reads of the user's saves, ItemDetail.bankStock
// (bankStockItemOf) and 'scraptf.itemHistory', for a specialized or professional killstreak weapon or kit.
// The import keys every such card by its sheen and killstreaker, and a SKU never names them, so before the
// fix neither read ever found the item ("Not in your saved scrap.tf pages yet", no stock line). 0.7.2's rule
// (liveCheck isOtherCopy, priceIsForSku): a sheen or killstreaker alone is no extra. Pure rules plus the
// service over a real in-memory repo. Saves are pages the user saved (R10); nothing here touches scrap.tf.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import {
  bankStockIsOwnCopy,
  bankStockItemOf,
  bankStockKeyWithoutKillstreak,
  bankStockSpecialKey,
  bankStockTargetOf,
  diffBankStock,
  type BankStockBankDiff,
} from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import {
  SCRAPTF_ITEM_EVENTS,
  SCRAPTF_ITEM_STOCK_EVENTS,
  SCRAPTF_PRICE_KINDS,
  scraptfChangeEvent,
  scraptfItemCopyOf,
  scraptfItemHistoryOf,
  type ScraptfSaveRows,
} from '../../src/shared/scraptfHistory';
import { scraptfBankCyclesOf, scraptfItemTimingOf } from '../../src/shared/scraptfTiming';
import type { BankStockStored, KeyPriceState, ScraptfBank, ScraptfChangeEvent, UnixMs } from '../../src/shared/types';
import { createStubSchema } from '../import/schemaStub';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 600;
const KEY: KeyPriceState = { valueScrap: K, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const PRO = bankStockSpecialKey({ sheen: 4, killstreaker: 2002 });
const PRO2 = bankStockSpecialKey({ sheen: 1, killstreaker: 2008 });
const SPEC = bankStockSpecialKey({ sheen: 3 });
const PAINT = bankStockSpecialKey({ paint: 15185211 });
const PAINT_PRO = bankStockSpecialKey({ paint: 15185211, sheen: 4, killstreaker: 2002 });
const SPELL_PRO = bankStockSpecialKey({ spells: ['Exorcism'], sheen: 4, killstreaker: 2002 });

const RL = '18;6;kt-3';
const KIT = bankStockTargetOf('6526;6;uncraftable;kt-3;td-205')!.base;

function s(sku: string, costScrap: number | null, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: costScrap === null ? null : 0, costScrap, stock: 1, assetId: null, ...over };
}

function bank(rowsNow: BankStockStored[], rowsBefore: BankStockStored[] | null, at: UnixMs = NOW, name: ScraptfBank = 'killstreaks'): BankStockBankDiff {
  return { bank: name, savedAt: at, previousSavedAt: rowsBefore === null ? null : at - HOUR, diff: diffBankStock(rowsNow, rowsBefore, K) };
}

let batch = 500;
function saveRows(at: UnixMs, rows: BankStockStored[], page = '/buy/killstreaks'): ScraptfSaveRows {
  return { batchId: batch++, savedAt: at, page, rows };
}

describe('the 0.7.2 copy rule as a key (bankStockKeyWithoutKillstreak, bankStockIsOwnCopy)', () => {
  it('sets a sheen and killstreaker aside and keeps every other extra', () => {
    expect(bankStockKeyWithoutKillstreak(PRO)).toBe('');
    expect(bankStockKeyWithoutKillstreak(SPEC)).toBe('');
    expect(bankStockKeyWithoutKillstreak(PAINT_PRO)).toBe(PAINT);
    expect(bankStockKeyWithoutKillstreak(SPELL_PRO)).toBe(bankStockSpecialKey({ spells: ['Exorcism'] }));
    expect(bankStockKeyWithoutKillstreak('')).toBe('');
    expect(bankStockKeyWithoutKillstreak(PAINT)).toBe(PAINT);
    // Not a key the import writes: returned as is, so it never matches a SKU's own copy.
    expect(bankStockKeyWithoutKillstreak('painted')).toBe('painted');
    expect(bankStockKeyWithoutKillstreak('[1,2')).toBe('[1,2');
    expect(bankStockKeyWithoutKillstreak('{"paint":1}')).toBe('{"paint":1}');
  });

  it("a stored copy is a SKU's own when only a sheen or killstreaker sets it apart", () => {
    const plain = bankStockTargetOf(RL)!;
    const painted = bankStockTargetOf(`${RL};p15185211`)!;
    expect(bankStockIsOwnCopy({ sku: RL, specialKey: PRO }, plain)).toBe(true);
    expect(bankStockIsOwnCopy({ sku: RL, specialKey: '' }, plain)).toBe(true);
    expect(bankStockIsOwnCopy({ sku: RL, specialKey: SPELL_PRO }, plain)).toBe(false);
    expect(bankStockIsOwnCopy({ sku: RL, specialKey: PAINT_PRO }, plain)).toBe(false);
    expect(bankStockIsOwnCopy({ sku: RL, specialKey: PAINT_PRO }, painted)).toBe(true);
    expect(bankStockIsOwnCopy({ sku: RL, specialKey: PRO }, painted)).toBe(false);
    expect(bankStockIsOwnCopy({ sku: '19;6;kt-3', specialKey: PRO }, plain)).toBe(false);
  });
});

describe('ItemDetail.bankStock for a killstreak weapon or kit (bankStockItemOf)', () => {
  it('finds a professional, a specialized and a kit copy by its plain SKU', () => {
    const banks = [
      bank(
        [s(RL, 280, { specialKey: PRO }), s('200;6;kt-2', 90, { specialKey: SPEC }), s(KIT, 400, { specialKey: PRO2, stock: 2 })],
        [s(RL, 300, { specialKey: PRO }), s('200;6;kt-2', 90, { specialKey: SPEC })],
      ),
    ];
    expect(bankStockItemOf(banks, RL, K)).toEqual({ bank: 'killstreaks', savedAt: NOW, change: 'cheaper', previousCostScrap: 300, stock: 1 });
    expect(bankStockItemOf(banks, '200;6;kt-2', K)).toEqual({ bank: 'killstreaks', savedAt: NOW, change: null, previousCostScrap: 90, stock: 1 });
    expect(bankStockItemOf(banks, '6526;6;uncraftable;kt-3;td-205', K)).toEqual({ bank: 'killstreaks', savedAt: NOW, change: 'new', previousCostScrap: null, stock: 2 });
  });

  it('of two sheen copies on sale in one save, takes the cheaper', () => {
    const banks = [bank([s(RL, 320, { specialKey: PRO2, stock: 5 }), s(RL, 280, { specialKey: PRO })], [s(RL, 320, { specialKey: PRO2 }), s(RL, 300, { specialKey: PRO })])];
    expect(bankStockItemOf(banks, RL, K)).toEqual({ bank: 'killstreaks', savedAt: NOW, change: 'cheaper', previousCostScrap: 300, stock: 1 });
    // A copy on sale still beats a cheaper one gone from the save.
    const gone = [bank([s(RL, 320, { specialKey: PRO2 })], [s(RL, 280, { specialKey: PRO })])];
    expect(bankStockItemOf(gone, RL, K)).toMatchObject({ change: 'new', stock: 1 });
  });

  it('keeps exact copies for every other extra, and the newest save first', () => {
    // Spells (or paint) with a sheen are another copy: never the plain SKU's.
    expect(bankStockItemOf([bank([s(RL, 280, { specialKey: SPELL_PRO })], null)], RL, K)).toBeNull();
    const painted = [bank([s(RL, 500, { specialKey: PAINT_PRO })], null)];
    expect(bankStockItemOf(painted, RL, K)).toBeNull();
    expect(bankStockItemOf(painted, `${RL};p15185211`, K)).toMatchObject({ bank: 'killstreaks', change: null, stock: 1 });
    // A plain copy and a sheen copy at one price: the plain one (the SKU's exact copy).
    const both = [bank([s('205;6;kt-1', 30, { specialKey: SPEC, stock: 4 }), s('205;6;kt-1', 30)], null)];
    expect(bankStockItemOf(both, '205;6;kt-1', K)).toMatchObject({ stock: 1 });
    // A newer save of another bank still wins, as before.
    const newer = [bank([s(RL, 280, { specialKey: PRO })], null, NOW - HOUR), bank([s(RL, 900)], null, NOW, 'list')];
    expect(bankStockItemOf(newer, RL, K)).toMatchObject({ bank: 'list', savedAt: NOW });
  });
});

describe("'scraptf.itemHistory' for a killstreak weapon or kit (scraptfItemHistoryOf)", () => {
  const saves = [
    saveRows(NOW - HOUR, [s(RL, 300, { specialKey: PRO }), s(RL, 50, { specialKey: SPELL_PRO })]),
    saveRows(NOW - 10 * MIN, [s(RL, 280, { specialKey: PRO }), s(RL, 50, { specialKey: SPELL_PRO })]),
  ];
  const event = (id: number, specialKey: string): ScraptfChangeEvent =>
    scraptfChangeEvent(
      { id, at: NOW - 10 * MIN, bank: 'killstreaks', page: '/buy/killstreaks', sku: RL, specialKey, name: 'Rocket Launcher', kind: 'cheaper', fromKeys: 0, fromScrap: 300, toKeys: 0, toScrap: 280, fromStock: 1, toStock: 1, batchId: 1 },
      K,
      null,
    );

  it('reads the sheen copy when the caller names no copy, with that copy’s own events', () => {
    const h = scraptfItemHistoryOf({ sku: RL, banks: [{ bank: 'killstreaks', saves }], events: [event(1, PRO), event(2, SPELL_PRO), event(3, '')], keyPrice: KEY, now: NOW });
    expect(h).toMatchObject({ sku: RL, specialKey: PRO, bank: 'killstreaks', current: { costScrap: 280, bank: 'killstreaks' }, listedSince: NOW - HOUR });
    expect(h.points.map((p) => p.costScrap)).toEqual([300, 280]);
    expect(h.events.map((e) => e.id)).toEqual([1]);
    // An explicit copy stays exact.
    expect(scraptfItemHistoryOf({ sku: RL, specialKey: '', banks: [{ bank: 'killstreaks', saves }], events: [], keyPrice: KEY, now: NOW })).toMatchObject({ specialKey: '', bank: null, points: [] });
    expect(scraptfItemHistoryOf({ sku: RL, specialKey: SPELL_PRO, banks: [{ bank: 'killstreaks', saves }], events: [], keyPrice: KEY, now: NOW })).toMatchObject({ specialKey: SPELL_PRO, current: { costScrap: 50 } });
  });

  it('picks among sheen copies: on sale now first, then the cheaper; never a spelled one', () => {
    const banks = [
      {
        bank: 'killstreaks' as const,
        saves: [
          saveRows(NOW - HOUR, [s(RL, 200, { specialKey: PRO2 }), s(RL, 330, { specialKey: PRO })]),
          saveRows(NOW - 10 * MIN, [s(RL, 330, { specialKey: PRO }), s(RL, 50, { specialKey: SPELL_PRO })]),
        ],
      },
    ];
    // PRO2 is gone from the newest save (cheaper, but no longer on sale).
    expect(scraptfItemCopyOf({ sku: RL, banks, keyPrice: KEY })).toBe(PRO);
    const two = [{ bank: 'killstreaks' as const, saves: [saveRows(NOW - 10 * MIN, [s(RL, 330, { specialKey: PRO }), s(RL, 0, { specialKey: PRO2, costKeys: 1 })])] }];
    // 1 key (600) against 330 scrap: the cheaper at the key price.
    expect(scraptfItemCopyOf({ sku: RL, banks: two, keyPrice: KEY })).toBe(PRO);
    expect(scraptfItemCopyOf({ sku: RL, banks: two, keyPrice: { ...KEY, valueScrap: 300 } })).toBe(PRO2);
    // Named copies and unknown items keep their key.
    expect(scraptfItemCopyOf({ sku: RL, specialKey: PRO2, banks, keyPrice: KEY })).toBe(PRO2);
    expect(scraptfItemCopyOf({ sku: '19;6;kt-3', banks, keyPrice: KEY })).toBe('');
    expect(scraptfItemCopyOf({ sku: `${RL};p15185211`, banks, keyPrice: KEY })).toBe(PAINT);
    const spelledOnly = [{ bank: 'killstreaks' as const, saves: [saveRows(NOW, [s(RL, 50, { specialKey: SPELL_PRO })])] }];
    expect(scraptfItemHistoryOf({ sku: RL, banks: spelledOnly, events: [], keyPrice: KEY, now: NOW })).toMatchObject({ specialKey: '', bank: null });
  });
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const log = recordingLogger();
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY, nameOf: (sku) => (sku === '999;6' ? 'Schema Hat' : null) });
  const stock = createBankStock({
    clock: { now: () => NOW },
    log,
    repo,
    market: { entryFor: () => null },
    keyPrice: () => KEY,
    settings: () => DEFAULT_SETTINGS,
    categoryOf: () => 'killstreaks',
    history: { runsFor: (b) => history.runsFor(b) },
  });
  const importSave = (bankName: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): void => {
    repo.transaction(() => {
      const id = repo.createImportBatch({ fileName: `${bankName}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank: bankName });
      repo.insertBankStock(id, bankName, rows, `/buy/${bankName}`);
      history.onImport(id);
    });
    history.refresh();
    stock.refresh();
  };
  return { repo, history, stock, importSave };
}

describe('the service reads (createScraptfHistory, createBankStock)', () => {
  it('finds a professional killstreak weapon saved twice: history, its events and the stock line', () => {
    const h = setup();
    h.importSave('killstreaks', NOW - HOUR, [s(RL, 300, { specialKey: PRO }), s(RL, 50, { specialKey: SPELL_PRO })]);
    h.importSave('killstreaks', NOW, [s(RL, 280, { specialKey: PRO }), s(RL, 45, { specialKey: SPELL_PRO })]);
    const spy = vi.spyOn(h.repo, 'scraptfEvents');
    const item = h.history.itemHistory(RL, null, NOW);
    expect(item).toMatchObject({ sku: RL, specialKey: PRO, bank: 'killstreaks', current: { costScrap: 280 } });
    expect(item.points).toHaveLength(2);
    expect(item.events.map((e) => [e.kind, e.specialKey])).toEqual([['cheaper', PRO]]);
    // That copy's events only, read as before (DM-6: price events and stock moves apart).
    expect(spy.mock.calls).toEqual([
      [{ sku: RL, specialKey: PRO, kinds: SCRAPTF_PRICE_KINDS, limit: SCRAPTF_ITEM_EVENTS }],
      [{ sku: RL, specialKey: PRO, kinds: ['stock'], limit: SCRAPTF_ITEM_STOCK_EVENTS }],
    ]);
    spy.mockRestore();
    // The same as the shared rule over every row of the bank's saves.
    const saves = h.repo
      .bankStockSaveIndex()
      .filter((x) => x.bank === 'killstreaks')
      .map((x) => ({ batchId: x.batchId, savedAt: x.savedAt, page: x.page, rows: h.repo.bankStockRows(x.batchId) }));
    const events = h.repo.scraptfEventsForSku(RL, 500).map((e) => scraptfChangeEvent(e, K, null));
    const expected = scraptfItemHistoryOf({ sku: RL, specialKey: null, banks: [{ bank: 'killstreaks', saves }], events, keyPrice: KEY, now: NOW });
    // 0.8 (T3-T5): plus the copy's cycles in its bank (no profit settings wired here, so timing null).
    const cycles = scraptfItemTimingOf(expected, { cyclesOf: (b) => scraptfBankCyclesOf(b, saves, K), buy: null, profit: null, keyScrap: K, now: NOW });
    expect(item).toEqual({ ...expected, ...cycles });
    expect(h.stock.detailFor(RL)).toEqual({ bank: 'killstreaks', savedAt: NOW, change: 'cheaper', previousCostScrap: 300, stock: 1 });
    // Unchanged: an item never saved, and an explicit copy.
    expect(h.history.itemHistory('999;6', null, NOW)).toMatchObject({ sku: '999;6', name: 'Schema Hat', bank: null, points: [], events: [] });
    expect(h.history.itemHistory(RL, '', NOW)).toMatchObject({ specialKey: '', bank: null, points: [] });
    expect(h.history.itemHistory(RL, SPELL_PRO, NOW)).toMatchObject({ specialKey: SPELL_PRO, current: { costScrap: 45 } });
  });

  it('end to end: buy_killstreaks.html saved twice through importSavedPage and the real parser', () => {
    const h = setup();
    const quiet = () => undefined;
    const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
    const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 24 * HOUR } });
    const ctx = {
      clock: { now: () => NOW },
      log,
      repo: h.repo,
      schema: createStubSchema(),
      engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
      settings: () => settings,
      push: quiet,
      pricesChanged: quiet,
      scraptfListChanged: quiet,
      scraptfHistory: h.history,
      bankStockChanged: () => {
        h.history.refresh();
        h.stock.refresh();
      },
    } as unknown as HandlerContext;
    const html = readFileSync(fileURLToPath(new URL('../fixtures/import/buy_killstreaks.html', import.meta.url)), 'utf8');
    importSavedPage(ctx, { html, fileName: 'killstreaks.html', mtimeMs: NOW - HOUR });
    importSavedPage(ctx, { html, fileName: 'killstreaks.html', mtimeMs: NOW - 10 * MIN });
    // Professional (sheen and killstreaker), specialized (sheen) and kits (a copy per combo): found by SKU.
    for (const sku of ['202;6;kt-3', '200;6;kt-2', '6526;6;uncraftable;kt-3;td-205', '6523;6;uncraftable;kt-2;td-200']) {
      const item = h.history.itemHistory(sku, null, NOW);
      expect(item.specialKey, sku).not.toBe('');
      expect(bankStockKeyWithoutKillstreak(item.specialKey), sku).toBe('');
      expect([item.bank, item.points.length], sku).toEqual(['killstreaks', 2]);
      expect(h.stock.detailFor(sku), sku).toMatchObject({ bank: 'killstreaks', savedAt: NOW - 10 * MIN, change: null });
    }
    // The kit's two copies: the cheaper on sale (35 keys, not 37 keys 40 ref).
    expect(h.history.itemHistory('6526;6;uncraftable;kt-3;td-205', null, NOW).specialKey).toBe(bankStockSpecialKey({ sheen: 4, killstreaker: 2003 }));
    // A basic killstreak has no sheen: its clean copy, as before.
    expect(h.history.itemHistory('205;6;kt-1', null, NOW)).toMatchObject({ specialKey: '', bank: 'killstreaks' });
  });
});
