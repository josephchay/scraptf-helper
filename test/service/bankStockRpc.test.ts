// F17 contract: 'scraptf.bankStock' (zod-validated, handed to ctx.bankStock), opps.exportCsv kind
// 'bankStock', MarketQuery.newOnScraptf, the settings switch notifications.newOnScraptf and the
// maintenance job's bank stock prune. Fakes for the service parts; no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BptfApi, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import type { MarketIndex } from '../../src/service/domain/market';
import { createRpcHandlers, type HandlerContext, type RpcHandler } from '../../src/service/rpcHandlers';
import { buildJobs, type JobContext } from '../../src/service/scheduler';
import { CSV_BOM } from '../../src/service/domain/csv';
import { BANK_STOCK_CSV_COLUMNS, BANK_STOCK_MAX_LIMIT, emptyBankStockResult } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SERVICE_METHODS } from '../../src/shared/rpc';
import { applySettingsPatch, parseSettings } from '../../src/shared/settingsSchema';
import type { BankStockQuery, BankStockRow, KeyPriceState, Settings } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const ROW: BankStockRow = {
  sku: '378;6',
  key: '378;6|',
  name: 'Team Captain',
  category: 'hats',
  hasExtras: false,
  costKeys: 0,
  costScrapRaw: 40,
  costScrap: 40,
  stock: 2,
  change: 'new',
  previousCostScrap: null,
  previousStock: null,
  revenueScrap: 100,
  revenueOrder: null,
  buyerCount: 3,
  maxCostScrap: 82,
  profitScrap: 60,
  margin: 1.5,
  verdict: 'flip',
  confidence: 70,
  confidenceLevel: 'high',
  listedSince: null,
  firstSeenAt: null,
  changeSinceListed: null,
};

let repo: Repo;
let rpc: RpcHandler;
let bankStock: { list: ReturnType<typeof vi.fn>; all: ReturnType<typeof vi.fn>; detailFor: ReturnType<typeof vi.fn> };
let market: { list: ReturnType<typeof vi.fn> };

beforeEach(() => {
  repo = openRepo(':memory:');
  bankStock = {
    list: vi.fn((q: BankStockQuery, now: number) => ({ ...emptyBankStockResult(q.bank, KEY, now), rows: [ROW], total: 1 })),
    all: vi.fn(() => [ROW]),
    detailFor: vi.fn(() => null),
  };
  market = { list: vi.fn(() => ({})) };
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
    settings: () => DEFAULT_SETTINGS,
    secret: () => null,
    push: () => undefined,
  } as unknown as HandlerContext;
  rpc = createRpcHandlers(ctx);
});

afterEach(() => {
  repo.close();
});

describe("'scraptf.bankStock'", () => {
  it('is a service method', () => {
    expect(SERVICE_METHODS).toContain('scraptf.bankStock');
  });

  it('hands the validated query and the clock to ctx.bankStock.list', async () => {
    const q = { bank: 'hats', filter: 'new', search: 'captain', sort: 'payUpTo', dir: 'asc', limit: 500, offset: 100 };
    const r = await rpc('scraptf.bankStock', q);
    expect(bankStock.list.mock.calls).toEqual([[q, NOW]]);
    expect(r).toMatchObject({ bank: 'hats', label: 'Hats', rows: [ROW], total: 1, generatedAt: NOW });
    await rpc('scraptf.bankStock', { bank: 'list', search: undefined });
    expect(bankStock.list.mock.calls[1]![0]).toEqual({ bank: 'list' });
  });

  it('refuses a missing or unknown bank and anything out of range', async () => {
    for (const bad of [
      undefined,
      {},
      { bank: 'trading-cards' },
      { bank: '__proto__' },
      { bank: 'hats', filter: 'bogus' },
      { bank: 'hats', sort: 'stock' },
      { bank: 'hats', dir: 'up' },
      { bank: 'hats', search: 'x'.repeat(201) },
      { bank: 'hats', limit: 0 },
      { bank: 'hats', limit: BANK_STOCK_MAX_LIMIT + 1 },
      { bank: 'hats', limit: 2.5 },
      { bank: 'hats', offset: -1 },
    ]) {
      await expect(rpc('scraptf.bankStock', bad), JSON.stringify(bad)).rejects.toThrow(/Invalid parameters for scraptf\.bankStock/);
    }
    expect(bankStock.list).not.toHaveBeenCalled();
  });
});

describe("opps.exportCsv kind 'bankStock'", () => {
  it("exports the bank's matching rows with the page's filter and sort, paging dropped", async () => {
    const r = (await rpc('opps.exportCsv', { kind: 'bankStock', bankStock: { bank: 'stranges', filter: 'flips', sort: 'cost', limit: 50, offset: 50 } })) as { csv: string; suggestedName: string };
    expect(bankStock.all.mock.calls).toEqual([[{ bank: 'stranges', filter: 'flips', sort: 'cost' }, NOW]]);
    expect(r.suggestedName).toBe('flipdesk-bank-stock-stranges-2026-10-16.csv');
    expect(r.csv.startsWith(CSV_BOM)).toBe(true);
    const lines = r.csv.slice(CSV_BOM.length).trim().split('\r\n');
    expect(lines[0]).toBe(BANK_STOCK_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^378;6,Team Captain,hats,,new,/);
  });

  it('needs the bank', async () => {
    await expect(rpc('opps.exportCsv', { kind: 'bankStock' })).rejects.toThrow(/bankStock: required/);
    await expect(rpc('opps.exportCsv', { kind: 'bankStock', bankStock: { bank: 'nope' } })).rejects.toThrow(/Invalid parameters/);
    expect(bankStock.all).not.toHaveBeenCalled();
  });
});

describe('MarketQuery.newOnScraptf', () => {
  it('passes validation as a boolean and reaches the index', async () => {
    await rpc('market.list', { newOnScraptf: true });
    expect(market.list.mock.calls[0]![0]).toEqual({ newOnScraptf: true });
    await expect(rpc('market.list', { newOnScraptf: 'yes' })).rejects.toThrow(/Invalid parameters for market\.list/);
  });
});

describe('a bank stock with no saves', () => {
  it('answers "no saves" for every bank (test/domain/bankStock.test.ts covers saved banks)', () => {
    const s = createBankStock({ clock: { now: () => NOW }, log: quiet, repo, market: { entryFor: () => null }, keyPrice: () => KEY, settings: () => DEFAULT_SETTINGS, categoryOf: () => 'hats' });
    s.refresh();
    expect(s.list({ bank: 'hats' }, NOW)).toEqual(emptyBankStockResult('hats', KEY, NOW));
    expect(s.all({ bank: 'hats' }, NOW)).toEqual([]);
    expect([s.whatsNew('hats'), s.newAtFor('378;6'), s.detailFor('378;6')]).toEqual([null, null, null]);
  });
});

describe('settings: notifications.newOnScraptf', () => {
  it('defaults on, loads on from a 0.5 file without the key, and takes a patch', () => {
    expect(DEFAULT_SETTINGS.notifications.newOnScraptf).toBe(true);
    const old = structuredClone(DEFAULT_SETTINGS) as unknown as { notifications: Record<string, unknown> };
    delete old.notifications['newOnScraptf'];
    old.notifications['enabled'] = false;
    const loaded: Settings = parseSettings(old);
    expect(loaded.notifications).toMatchObject({ enabled: false, newOnScraptf: true });
    expect(parseSettings({ notifications: { newOnScraptf: 'no' } }).notifications.newOnScraptf).toBe(true);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { notifications: { newOnScraptf: false } }).notifications.newOnScraptf).toBe(false);
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { notifications: { newOnScraptf: 'off' } })).toThrow(/Invalid settings/);
  });
});

describe('maintenance prunes bank stock', () => {
  function job(r: Repo, changed: () => void) {
    const ctx: JobContext = {
      clock: { now: () => NOW },
      log: quiet,
      repo: r,
      http: { nextAllowedAt: () => 0, hostBlocked: () => null } as unknown as HttpClient,
      schema: { isLoaded: () => true } as unknown as SchemaService,
      pricedb: {} as unknown as PriceDb,
      bptfApi: {} as unknown as BptfApi,
      engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
      market: { markDirty: () => undefined, markAllDirty: () => undefined },
      settings: () => DEFAULT_SETTINGS,
      secret: () => null,
      watchedBaseSkus: () => [],
      nextQueuedSnapshot: () => null,
      snapshot: async () => undefined,
      keyQuotesChanged: () => undefined,
      bankStockChanged: changed,
    };
    return buildJobs(ctx).find((j) => j.id === 'maintenance')!;
  }

  it('tells core only when it removed rows', async () => {
    let told = 0;
    const maintenance = job(repo, () => told++);
    await maintenance.run();
    expect(told).toBe(0);
    // F20: past 90 days, and neither the page's newest save nor the one it is compared with.
    const saveAt = (at: number) => {
      const id = repo.createImportBatch({ fileName: 'old.html', pageKind: 'buy', fileMtime: at, importedAt: NOW, itemCount: 1, bank: 'hats' });
      repo.insertBankStock(id, 'hats', [{ sku: '378;6', specialKey: '', name: 'Team Captain', costKeys: 0, costScrap: 30, stock: 1, assetId: null }]);
      return id;
    };
    const old = saveAt(NOW - 100 * 86_400_000);
    const previous = saveAt(NOW - 2 * 3_600_000);
    const newest = saveAt(NOW - 3_600_000);
    await maintenance.run();
    expect(told).toBe(1);
    expect(repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([newest, previous]);
    expect(repo.bankStockRows(old)).toEqual([]);
  });
});
