// F10 service wiring: 'market.list' validates its query and hands it to the
// market index with the clock; the 'market' CSV export takes every matching row
// (paging removed) from index.all and writes it with marketCsv. The index is a
// fake here, so this file checks only the handler contract; no request is made.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine, HttpClient, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { marketCsv, type MarketIndex } from '../../src/service/domain/market';
import { createRpcHandlers, type HandlerContext, type RpcHandler } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { CSV_BOM } from '../../src/service/domain/csv';
import { MARKET_CSV_COLUMNS, emptyMarketCounts } from '../../src/shared/market';
import { scraptfLinkFor } from '../../src/shared/links';
import { scraptfListCoverage } from '../../src/shared/scraptfList';
import type { KeyPriceState, MarketListResult, MarketRow } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const KEY: KeyPriceState = { valueScrap: 568, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const ROW: MarketRow = {
  sku: '378;6',
  name: 'Team Captain',
  category: 'hats',
  revenueScrap: 600,
  bestScrap: 610,
  consScrap: 600,
  instantScrap: 600,
  revenueOrder: null,
  buyerCount: 4,
  maxCostScrap: 580,
  confidence: 71,
  confidenceLevel: 'high',
  flags: [],
  knownCostScrap: 550,
  knownSource: 'typed',
  knownObservedAt: NOW - 60_000,
  stock: null,
  ruleCostScrap: null,
  profitScrap: 50,
  verdict: 'flip',
  lastOrderChangeAt: NOW - 30_000,
  evaluatedAt: NOW,
  scraptfPaysScrap: 560,
  scraptfStock: 2,
  scraptfStockLimit: 6,
  scraptfFull: false,
  scraptfListAt: NOW - 120_000,
  scraptfNewAt: null,
  scraptfListedSince: null,
  scraptfLink: scraptfLinkFor('hats', null),
};

let repo: Repo;
let rpc: RpcHandler;
let market: { list: ReturnType<typeof vi.fn>; all: ReturnType<typeof vi.fn> };
const requests: string[] = [];

beforeEach(() => {
  repo = openRepo(':memory:');
  const listResult = (now: number): MarketListResult => ({
    rows: [ROW],
    total: 1,
    counts: { ...emptyMarketCounts(), flip: 1 },
    scraptf: { typed: 1, pages: 0, newestPageAt: null, importEnabled: false, watchFolder: false, coverage: [], allItems: scraptfListCoverage(null) },
    stats: { entries: 1, building: false, progress: 1, lastFullAt: NOW, lastChangeAt: null, pendingDirty: 0, lastError: null, retryAt: null },
    keyPrice: KEY,
    generatedAt: now,
  });
  market = { list: vi.fn((_q: unknown, now: number) => listResult(now)), all: vi.fn(() => [ROW]) };
  const http = {
    request: async (url: string) => {
      requests.push(url);
      throw new Error('no network in this test');
    },
    isPaused: () => false,
    hostBlocked: () => null,
    nextAllowedAt: () => 0,
  } as unknown as HttpClient;
  const engine = { keyPrice: () => KEY, markDirty: () => {}, markAllDirty: () => {} } as unknown as Engine;
  const ctx = {
    clock: { now: () => NOW },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    repo,
    http,
    schema: {},
    pricedb: {},
    bptfApi: { usersInfo: async () => new Map() },
    scm: {},
    engine,
    market: market as unknown as MarketIndex,
    settings: () => DEFAULT_SETTINGS,
    secret: () => null,
    push: () => {},
    status: () => ({}),
    health: () => ({}),
    pricesChanged: () => {},
    queueSnapshot: () => {},
    snapshot: async () => {},
    snapshotStale: () => false,
    hostUnblocked: () => {},
  } as unknown as HandlerContext;
  rpc = createRpcHandlers(ctx);
});

afterEach(() => {
  repo.close();
  requests.length = 0;
});

describe("'market.list'", () => {
  it('hands the validated query and the clock to the index', async () => {
    const q = {
      search: 'captain',
      categories: ['hats'],
      verdicts: ['flip', 'rule-flip'],
      sources: ['typed', 'page'],
      minCeilingScrap: 9,
      onlyBotBuyers: true,
      minBuyers: 2,
      sort: 'profit',
      dir: 'asc',
      limit: 500,
      offset: 200,
    };
    const r = (await rpc('market.list', q)) as MarketListResult;
    expect(market.list).toHaveBeenCalledTimes(1);
    expect(market.list.mock.calls[0]).toEqual([q, NOW]);
    expect(r).toMatchObject({ total: 1, generatedAt: NOW, keyPrice: KEY });
    expect(requests).toEqual([]);
  });

  it('treats missing params as an empty query and drops undefined keys', async () => {
    await rpc('market.list', undefined);
    await rpc('market.list', { search: undefined, sort: undefined });
    expect(market.list.mock.calls.map((c) => c[0])).toEqual([{}, {}]);
  });

  it('validates the query', async () => {
    for (const bad of [
      { limit: 0 },
      { limit: 2001 },
      { limit: 2.5 },
      { offset: -1 },
      { search: 'x'.repeat(201) },
      { categories: ['boats'] },
      { verdicts: ['maybe'] },
      { sources: ['steam'] },
      { sort: 'margin' },
      { dir: 'up' },
      { minCeilingScrap: -1 },
      { minBuyers: -1 },
      { onlyBotBuyers: 'yes' },
    ]) {
      await expect(rpc('market.list', bad)).rejects.toThrow(/Invalid parameters for market\.list/);
    }
    expect(market.list).not.toHaveBeenCalled();
  });
});

describe("'opps.exportCsv' kind 'market'", () => {
  it('exports every matching row (paging removed) under a dated name', async () => {
    const r = (await rpc('opps.exportCsv', { kind: 'market', market: { categories: ['hats'], sort: 'name', limit: 25, offset: 50 } })) as { csv: string; suggestedName: string };
    expect(market.all).toHaveBeenCalledTimes(1);
    expect(market.all.mock.calls[0]).toEqual([{ categories: ['hats'], sort: 'name' }, NOW]);
    expect(r.suggestedName).toMatch(/^flipdesk-market-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(r.csv).toBe(marketCsv([ROW], KEY.valueScrap));
  });

  it('exports the whole market without a query, and validates it', async () => {
    await rpc('opps.exportCsv', { kind: 'market' });
    expect(market.all.mock.calls[0]![0]).toEqual({});
    await expect(rpc('opps.exportCsv', { kind: 'market', market: { verdicts: ['nope'] } })).rejects.toThrow(/Invalid parameters/);
  });
});

describe('marketCsv', () => {
  it('writes the BOM, the header and one CRLF line per row', () => {
    const csv = marketCsv([ROW], 568);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(CSV_BOM.length).trimEnd().split('\r\n');
    expect(lines[0]).toBe(MARKET_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    // F14 appended the saved scrap.tf/items list's columns (pays, stock, limit, saved) at the end.
    expect(lines[1]).toBe(
      `378;6,Team Captain,hats,flip,1 key 3.55 ref,,4,1 key 1.33 ref,61.11 ref,typed,,,5.55 ref,71,${new Date(NOW - 30_000).toISOString()},62.22 ref,2,6,${new Date(NOW - 120_000).toISOString()}`,
    );
  });
});
