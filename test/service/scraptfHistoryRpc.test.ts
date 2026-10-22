// F20 contract: 'scraptf.itemHistory' and 'scraptf.changes' (zod-validated, handed to ctx.scraptfHistory),
// opps.exportCsv kind 'scraptfChanges', the new BankStockQuery and MarketQuery keys, the re-save
// reminder settings, the history and reminders core wires (with nothing saved), and the 'scraptf.changed' push after an
// import that wrote events. Fakes for the service parts; no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine, HttpClient, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { CSV_BOM } from '../../src/service/domain/csv';
import { RESAVE_TICK_MS, createResaveReminders } from '../../src/service/domain/resaveReminders';
import { createScraptfHistory, scraptfChangesCsv } from '../../src/service/domain/scraptfHistory';
import type { MarketIndex } from '../../src/service/domain/market';
import { createRpcHandlers, importSavedPage, type HandlerContext, type RpcHandler } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { PUSH_EVENTS, SERVICE_METHODS } from '../../src/shared/rpc';
import { SCRAPTF_CHANGES_CSV_COLUMNS, scraptfItemHistoryOf } from '../../src/shared/scraptfHistory';
import { applySettingsPatch, parseSettings, parseSettingsWithReport } from '../../src/shared/settingsSchema';
import type { KeyPriceState } from '../../src/shared/types';
import { createStubSchema } from '../import/schemaStub';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

let repo: Repo;
let rpc: RpcHandler;
let history: { onImport: ReturnType<typeof vi.fn>; itemHistory: ReturnType<typeof vi.fn>; changes: ReturnType<typeof vi.fn>; csv: ReturnType<typeof vi.fn> };
let market: { list: ReturnType<typeof vi.fn> };
let bankStock: { list: ReturnType<typeof vi.fn>; all: ReturnType<typeof vi.fn>; detailFor: ReturnType<typeof vi.fn> };

beforeEach(() => {
  repo = openRepo(':memory:');
  history = {
    onImport: vi.fn(() => 0),
    itemHistory: vi.fn((sku: string, special: string | null, now: number) => scraptfItemHistoryOf({ sku, specialKey: special, banks: [], events: [], keyPrice: KEY, now })),
    changes: vi.fn(() => []),
    csv: vi.fn(() => 'csv'),
  };
  market = { list: vi.fn(() => ({})) };
  bankStock = { list: vi.fn(() => ({})), all: vi.fn(() => []), detailFor: vi.fn(() => null) };
  const ctx = {
    clock: { now: () => NOW },
    log: quiet,
    repo,
    http: { isPaused: () => false, hostBlocked: () => null, nextAllowedAt: () => 0 } as unknown as HttpClient,
    schema: {},
    pricedb: {},
    bptfApi: {},
    scm: {},
    engine: { keyPrice: () => KEY } as unknown as Engine,
    market: market as unknown as MarketIndex,
    bankStock,
    scraptfHistory: history,
    settings: () => DEFAULT_SETTINGS,
    secret: () => null,
    push: () => undefined,
  } as unknown as HandlerContext;
  rpc = createRpcHandlers(ctx);
});

afterEach(() => {
  repo.close();
});

describe('the F20 methods and push', () => {
  it('are service methods and a forwarded push', () => {
    expect(SERVICE_METHODS).toEqual(expect.arrayContaining(['scraptf.itemHistory', 'scraptf.changes']));
    expect(PUSH_EVENTS).toContain('scraptf.changed');
  });
});

describe("'scraptf.itemHistory'", () => {
  it('hands the validated SKU, the copy and the clock to ctx.scraptfHistory.itemHistory', async () => {
    const r = await rpc('scraptf.itemHistory', { sku: ' 378;6 ' });
    expect(history.itemHistory.mock.calls).toEqual([['378;6', null, NOW]]);
    expect(r).toMatchObject({ sku: '378;6', bank: null, points: [], generatedAt: NOW });
    await rpc('scraptf.itemHistory', { sku: '378;6', special: '[5801378,[],[],null,null,false,false]', extra: 1 });
    expect(history.itemHistory.mock.calls[1]).toEqual(['378;6', '[5801378,[],[],null,null,false,false]', NOW]);
    await rpc('scraptf.itemHistory', { sku: '378;6', special: null });
    expect(history.itemHistory.mock.calls[2]![1]).toBeNull();
  });

  it('refuses a missing or invalid SKU and an oversized copy key', async () => {
    for (const bad of [undefined, {}, { sku: '' }, { sku: 'team captain' }, { sku: 378 }, { sku: '378;6', special: 'x'.repeat(2001) }, { sku: '378;6', special: 5 }]) {
      await expect(rpc('scraptf.itemHistory', bad), JSON.stringify(bad)).rejects.toThrow(/Invalid parameters for scraptf\.itemHistory/);
    }
    expect(history.itemHistory).not.toHaveBeenCalled();
  });
});

describe("'scraptf.changes'", () => {
  it('hands the validated filters and the clock to ctx.scraptfHistory.changes; nothing is the whole feed', async () => {
    await rpc('scraptf.changes', undefined);
    await rpc('scraptf.changes', {});
    const q = { bank: 'hats', kinds: ['cheaper', 'restocked'], sku: '378;6', beforeId: 40, limit: 500 };
    await rpc('scraptf.changes', { ...q, junk: true });
    expect(history.changes.mock.calls).toEqual([
      [{}, NOW],
      [{}, NOW],
      [q, NOW],
    ]);
  });

  it('refuses an unknown bank or kind, a bad SKU and paging out of range', async () => {
    for (const bad of [
      { bank: 'trading-cards' },
      { bank: '__proto__' },
      { kinds: ['sold'] },
      { kinds: 'new' },
      { kinds: ['new', 'gone', 'cheaper', 'pricier', 'restocked', 'stock', 'new'] },
      { sku: 'not a sku' },
      { beforeId: 0 },
      { beforeId: 1.5 },
      { limit: 0 },
      { limit: 501 },
      'all',
    ]) {
      await expect(rpc('scraptf.changes', bad), JSON.stringify(bad)).rejects.toThrow(/Invalid parameters for scraptf\.changes/);
    }
    expect(history.changes).not.toHaveBeenCalled();
  });
});

describe("opps.exportCsv kind 'scraptfChanges'", () => {
  it("exports the feed's filters, paging dropped", async () => {
    const r = (await rpc('opps.exportCsv', { kind: 'scraptfChanges', scraptfChanges: { bank: 'list', kinds: ['new'], beforeId: 9, limit: 20 } })) as { csv: string; suggestedName: string };
    expect(history.csv.mock.calls).toEqual([[{ bank: 'list', kinds: ['new'] }, NOW]]);
    expect(r).toEqual({ csv: 'csv', suggestedName: 'flipdesk-scraptf-changes-2026-10-16.csv' });
    await rpc('opps.exportCsv', { kind: 'scraptfChanges' });
    expect(history.csv.mock.calls[1]).toEqual([{}, NOW]);
    await expect(rpc('opps.exportCsv', { kind: 'scraptfChanges', scraptfChanges: { bank: 'moon' } })).rejects.toThrow(/Invalid parameters/);
  });

  it('writes the header line with the BOM when the feed is empty', () => {
    const csv = scraptfChangesCsv([], 600);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(CSV_BOM.length).trim()).toBe(SCRAPTF_CHANGES_CSV_COLUMNS.join(','));
  });
});

describe('the new query keys', () => {
  it("BankStockQuery: filters 'long-listed' and 'dropped', minListedMs, sorts 'listed' and 'sinceListed'", async () => {
    const q = { bank: 'hats', filter: 'long-listed', minListedMs: 48 * 3_600_000, sort: 'listed', dir: 'desc' };
    await rpc('scraptf.bankStock', q);
    await rpc('scraptf.bankStock', { bank: 'hats', filter: 'dropped', sort: 'sinceListed' });
    expect(bankStock.list.mock.calls.map((c) => c[0])).toEqual([q, { bank: 'hats', filter: 'dropped', sort: 'sinceListed' }]);
    for (const bad of [{ bank: 'hats', minListedMs: -1 }, { bank: 'hats', minListedMs: 1.5 }, { bank: 'hats', minListedMs: 91 * 86_400_000 }]) {
      await expect(rpc('scraptf.bankStock', bad)).rejects.toThrow(/Invalid parameters for scraptf\.bankStock/);
    }
  });

  it('MarketQuery.listedOnScraptf is a boolean that reaches the index', async () => {
    await rpc('market.list', { listedOnScraptf: true });
    expect(market.list.mock.calls[0]![0]).toEqual({ listedOnScraptf: true });
    await expect(rpc('market.list', { listedOnScraptf: 'yes' })).rejects.toThrow(/Invalid parameters for market\.list/);
  });
});

describe('settings: re-save reminders', () => {
  it('default off with every saved bank, load so from a 0.6 file, and take a valid patch only', () => {
    expect(DEFAULT_SETTINGS.import).toMatchObject({ resaveReminderMin: 0, resaveBanks: [] });
    const old = structuredClone(DEFAULT_SETTINGS) as unknown as { import: Record<string, unknown> };
    delete old.import['resaveReminderMin'];
    delete old.import['resaveBanks'];
    const { settings, invalid } = parseSettingsWithReport(old);
    expect(settings.import).toMatchObject({ resaveReminderMin: 0, resaveBanks: [] });
    expect(invalid).toEqual([]);
    // A broken list keeps its valid, distinct banks.
    expect(parseSettings({ import: { resaveBanks: ['hats', 'moon', 'hats', 7, 'list'] } }).import.resaveBanks).toEqual(['hats', 'list']);
    expect(parseSettings({ import: { resaveReminderMin: 5000 } }).import.resaveReminderMin).toBe(0);
    const set = applySettingsPatch(DEFAULT_SETTINGS, { import: { resaveReminderMin: 90, resaveBanks: ['hats', 'unusuals'] } });
    expect(set.import).toMatchObject({ resaveReminderMin: 90, resaveBanks: ['hats', 'unusuals'] });
    expect(applySettingsPatch(DEFAULT_SETTINGS, { import: { resaveReminderMin: 1440 } }).import.resaveReminderMin).toBe(1440);
    for (const bad of [{ resaveReminderMin: 1441 }, { resaveReminderMin: -1 }, { resaveReminderMin: 2.5 }, { resaveBanks: ['moon'] }, { resaveBanks: 'hats' }]) {
      expect(() => applySettingsPatch(DEFAULT_SETTINGS, { import: bad }), JSON.stringify(bad)).toThrow(/Invalid settings/);
    }
  });
});

// The full behaviour: test/domain/scraptfHistory.test.ts, resaveReminders.test.ts and scraptfHistoryCore.test.ts.
describe('the history and reminders core wires, with nothing saved', () => {
  it('a history with nothing indexed answers empty, never throws, and writes no event', () => {
    const h = createScraptfHistory({ clock: { now: () => NOW }, log: quiet, repo, market: { entryFor: () => null }, keyPrice: () => KEY });
    expect(h.onImport(1)).toBe(0);
    expect(h.itemHistory('378;6', null, NOW)).toMatchObject({ sku: '378;6', bank: null, points: [], events: [], keyPrice: KEY, generatedAt: NOW });
    expect(h.changes({}, NOW)).toEqual([]);
    expect(h.runsFor('hats').size).toBe(0);
    expect(h.listedSinceFor('378;6')).toBeNull();
    expect(() => h.refresh()).not.toThrow();
    expect(h.csv({}, NOW).slice(CSV_BOM.length).trim()).toBe(SCRAPTF_CHANGES_CSV_COLUMNS.join(','));
    expect(h.version()).toBe(0);
    expect(repo.scraptfEvents()).toEqual([]);
  });

  it('0.8: with nothing saved, no verdict, no cycles, no turnover and no asset ids, and nothing throws', () => {
    const h = createScraptfHistory({ clock: { now: () => NOW }, log: quiet, repo, market: { entryFor: () => null }, keyPrice: () => KEY, profit: () => DEFAULT_SETTINGS.profit });
    const buy = { revenueScrap: 120, maxCostScrap: 111 };
    expect(h.timingFor('hats', '378;6|', buy, NOW)).toBeNull();
    expect(h.timingForBase('378;6', null, buy, NOW)).toBeNull();
    expect(h.timingForBase('378;6', 'hats', buy, NOW)).toBeNull();
    expect(h.timingForCopy('378;6', '', buy, NOW)).toBeNull();
    expect(h.turnoverFor('hats')).toBeNull();
    expect(h.assetStability()).toEqual([]);
    const item = h.itemHistory('378;6', null, NOW);
    expect(item).not.toHaveProperty('cycles');
    expect(item).not.toHaveProperty('timing');
  });

  it('the reminders (off by default) start, tick and stop without a notification', () => {
    const notify = vi.fn();
    const r = createResaveReminders({ clock: { now: () => NOW }, log: quiet, repo, settings: () => DEFAULT_SETTINGS, networkPaused: () => false, notify });
    r.start();
    expect(r.tick(NOW)).toBe(0);
    r.stop();
    expect(notify).not.toHaveBeenCalled();
    expect(RESAVE_TICK_MS).toBe(60_000);
  });
});

describe("importSavedPage and the change feed (S2's hook)", () => {
  const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

  function setup(written: number) {
    const calls: string[] = [];
    const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 3_600_000 } });
    const onImport = vi.fn((batchId: number) => {
      // Inside the import's transaction, right after the save's rows were written.
      calls.push(`onImport:${repo.bankStockRows(batchId).length > 0}`);
      return written;
    });
    const ctx = {
      clock: { now: () => NOW },
      log: quiet,
      repo,
      schema: createStubSchema(),
      engine: { keyPrice: () => KEY, markDirty: () => undefined } as unknown as Engine,
      settings: () => settings,
      push: (event: string, payload: unknown) => calls.push(`push:${event}:${JSON.stringify(payload)}`),
      pricesChanged: () => calls.push('pricesChanged'),
      scraptfListChanged: () => undefined,
      scraptfHistory: { onImport },
      bankStockChanged: () => calls.push('bankStockChanged'),
    } as unknown as HandlerContext;
    return { ctx, calls, onImport };
  }

  it("pushes 'scraptf.changed' with the save time and count after the bank stock and before the prices", () => {
    const h = setup(4);
    const r = importSavedPage(h.ctx, { html: fixture('buy_hats.html'), fileName: 'hats.html', mtimeMs: NOW - 60_000 });
    expect(h.onImport.mock.calls).toEqual([[r.batchId]]);
    expect(h.calls.slice(0, 4)).toEqual(['onImport:true', 'bankStockChanged', `push:scraptf.changed:${JSON.stringify({ at: NOW - 60_000, count: 4 })}`, 'pricesChanged']);
  });

  it('pushes nothing when the save wrote no event, and asks nothing of a page that stored no bank stock', () => {
    const h = setup(0);
    importSavedPage(h.ctx, { html: fixture('buy_hats.html'), fileName: 'hats.html', mtimeMs: NOW - 60_000 });
    expect(h.calls.some((c) => c.startsWith('push:scraptf.changed'))).toBe(false);
    const other = setup(5);
    importSavedPage(other.ctx, { html: '<html><body>nothing here</body></html>', fileName: 'x.html', mtimeMs: NOW });
    expect(other.onImport).not.toHaveBeenCalled();
  });
});
