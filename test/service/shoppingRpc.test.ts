// F1 service wiring: 'shopping.list' hands every stored opportunity, the
// validated query, the engine's key price and the clock to buildShoppingList,
// and the shopping CSV export uses every matching row (no paging). The list
// builder itself is tested with the domain (test/domain); it is mocked here so
// this file checks only the handler contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine, HttpClient, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, type HandlerContext, type RpcHandler } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { KeyPriceState, ShoppingListResult } from '../../src/shared/types';
import { makeOpp } from '../db/helpers';

const mocks = vi.hoisted(() => ({
  buildShoppingList: vi.fn(),
  shoppingCsv: vi.fn(),
}));
vi.mock('../../src/service/domain/shopping', () => mocks);

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const KEY: KeyPriceState = { valueScrap: 450, source: 'bptf', observedAt: NOW, stale: false, quotes: [] };

let repo: Repo;
let rpc: RpcHandler;
const requests: string[] = [];

beforeEach(() => {
  mocks.buildShoppingList.mockReset().mockImplementation(
    (rows: unknown[], _q: unknown, keyPrice: KeyPriceState | null, now: number): ShoppingListResult => ({
      rows: [],
      total: rows.length,
      groups: [],
      keyPrice,
      generatedAt: now,
    }),
  );
  mocks.shoppingCsv.mockReset().mockReturnValue('csv-body');
  repo = openRepo(':memory:');
  repo.upsertOpportunities([makeOpp({ sku: '378;6', maxCostScrap: 70 }), makeOpp({ sku: '5021;6', inputRef: 'rule:1', inputKind: 'rule', maxCostScrap: 400 })]);
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

describe("'shopping.list'", () => {
  it('builds the list from every stored opportunity with the engine key price and the clock', async () => {
    const r = (await rpc('shopping.list', { categories: ['hats'], search: 'captain', minCeilingScrap: 9, onlyBotBuyers: true, limit: 50, offset: 10 })) as ShoppingListResult;
    expect(mocks.buildShoppingList).toHaveBeenCalledTimes(1);
    const [rows, q, keyPrice, now] = mocks.buildShoppingList.mock.calls[0]!;
    expect(rows).toEqual(repo.allOpportunities());
    expect((rows as unknown[]).length).toBe(2);
    expect(q).toEqual({ categories: ['hats'], search: 'captain', minCeilingScrap: 9, onlyBotBuyers: true, limit: 50, offset: 10 });
    expect(keyPrice).toBe(KEY);
    expect(now).toBe(NOW);
    expect(r).toMatchObject({ total: 2, generatedAt: NOW, keyPrice: KEY });
    expect(requests).toEqual([]);
  });

  it('treats missing params as an empty query and drops undefined keys', async () => {
    await rpc('shopping.list', undefined);
    await rpc('shopping.list', { search: undefined });
    expect(mocks.buildShoppingList.mock.calls.map((c) => c[1])).toEqual([{}, {}]);
  });

  it('validates the query', async () => {
    for (const bad of [{ limit: 0 }, { limit: 5001 }, { offset: -1 }, { categories: ['boats'] }, { minCeilingScrap: -1 }, { onlyBotBuyers: 'yes' }, { search: 'x'.repeat(201) }]) {
      await expect(rpc('shopping.list', bad)).rejects.toThrow(/Invalid parameters for shopping\.list/);
    }
    expect(mocks.buildShoppingList).not.toHaveBeenCalled();
  });
});

describe("'opps.exportCsv' kind 'shopping'", () => {
  it('exports every matching row (paging removed) with the key price, under a dated name', async () => {
    const built: ShoppingListResult = { rows: [], total: 0, groups: [], keyPrice: KEY, generatedAt: NOW };
    mocks.buildShoppingList.mockReturnValueOnce(built);
    const r = (await rpc('opps.exportCsv', { kind: 'shopping', shopping: { categories: ['hats'], limit: 25, offset: 50 } })) as { csv: string; suggestedName: string };
    const [rows, q, keyPrice, now] = mocks.buildShoppingList.mock.calls[0]!;
    expect(rows).toEqual(repo.allOpportunities());
    expect(q).toEqual({ categories: ['hats'] });
    expect(keyPrice).toBe(KEY);
    expect(now).toBe(NOW);
    expect(mocks.shoppingCsv).toHaveBeenCalledWith(built.rows, 450);
    expect(r).toEqual({ csv: 'csv-body', suggestedName: expect.stringMatching(/^flipdesk-shopping-\d{4}-\d{2}-\d{2}\.csv$/) });
  });

  it('exports the whole list without shopping filters', async () => {
    await rpc('opps.exportCsv', { kind: 'shopping' });
    expect(mocks.buildShoppingList.mock.calls[0]![1]).toEqual({});
    expect(mocks.shoppingCsv).toHaveBeenCalledTimes(1);
  });
});

describe("'buyer.check' wiring", () => {
  it('validates the SteamID64 and answers through the checker (no token: no request)', async () => {
    await expect(rpc('buyer.check', { steamid: '7656119800000000x' })).rejects.toThrow(/Invalid parameters for buyer\.check/);
    const r = await rpc('buyer.check', { steamid: '76561198000000002' });
    expect(r).toMatchObject({ steamid: '76561198000000002', bptfBanned: null, error: 'Add a backpack.tf access token in Settings' });
    expect(requests).toEqual([]);
  });
});
