// 0.9 Foundation: the release's two new RPC methods exist on every side (the contract, the service's router and the
// browser mock), with no new push. It pins only what stays true once ranking and history (Wave 2) replace the stub
// bodies: the methods are routed and zod-checked, and 'opps.list' takes the two new sorts. What the methods answer is
// left to the packages' own tests (reserveSuggestionRpc090, bookHistoryRpc, mockRanking090, mockBookHistory).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_ONLY_PUSH_EVENTS, SERVICE_PUSH_EVENTS } from '../../src/main/serviceHost';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { BOOK_HISTORY_ORDERS_MAX } from '../../src/shared/orderPersistence';
import { MAIN_METHODS, PUSH_EVENTS, SERVICE_METHODS, type RpcMethod } from '../../src/shared/rpc';
import { OPP_SORTS, type OppListResult } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const NEW_METHODS: readonly RpcMethod[] = ['item.bookHistory', 'profit.reserveSuggestion'];

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
const bridges: MockBridge[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  while (bridges.length) bridges.pop()!.dispose();
});

/** The real handlers over a real repo (audit-074-typed-price-replace's harness). */
function service() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    http: { isPaused: () => false },
    engine: { keyPrice: () => ({ valueScrap: 577 }), markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    secret: () => null,
    push: quiet,
    pricesChanged: quiet,
    journalChanged: quiet,
    // 'opps.list' joins buy timing only when the history offers it (Partial: none here).
    scraptfHistory: {},
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  const call = async <T>(method: string, params: unknown) => (await rpc(method, params)) as T;
  const refusal = (method: string, params: unknown): Promise<string> =>
    rpc(method, params).then(
      () => 'answered',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
  return { repo, call, refusal };
}

function mock(): MockBridge {
  const bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW });
  bridges.push(bridge);
  return bridge;
}

const sixOrders = Array.from({ length: BOOK_HISTORY_ORDERS_MAX + 1 }, (_, i) => `440_7656119800000000${i}_abc`);

describe('the 0.9 contract', () => {
  it('lists both new methods as service methods, and adds no push', () => {
    for (const m of NEW_METHODS) {
      expect(SERVICE_METHODS).toContain(m);
      expect(MAIN_METHODS).not.toContain(m);
    }
    // No push in 0.9. The count is read from the contract, not hard-coded: PUSH_EVENTS is exactly PushContract's keys,
    // each once, split between the service's and main's own, and neither new method is one of them.
    const src = readFileSync(fileURLToPath(new URL('../../src/shared/rpc.ts', import.meta.url)), 'utf8');
    const contract = src.slice(src.indexOf('export interface PushContract'), src.indexOf('export type PushEvent'));
    const declared = [...contract.matchAll(/^ {2}'([\w.]+)':/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(declared).size).toBe(declared.length);
    expect(PUSH_EVENTS).toHaveLength(declared.length);
    expect(new Set(PUSH_EVENTS)).toEqual(new Set(declared));
    expect(SERVICE_PUSH_EVENTS.length + MAIN_ONLY_PUSH_EVENTS.length).toBe(PUSH_EVENTS.length);
    for (const m of NEW_METHODS) expect(PUSH_EVENTS as readonly string[]).not.toContain(m);
    expect(BOOK_HISTORY_ORDERS_MAX).toBe(5);
  });

  it("'opps.list' sorts by every OppSort, the two risk keys included", () => {
    expect(OPP_SORTS).toEqual(['profit', 'backup', 'depth', 'margin', 'confidence', 'updated', 'name']);
  });
});

describe('the service routes and zod-checks the new methods', () => {
  it("refuses item.bookHistory's bad params with the method named, before any body runs", async () => {
    const s = service();
    expect(await s.refusal('item.bookHistory', { sku: 7 })).toMatch(/^Invalid parameters for item\.bookHistory: sku: /);
    expect(await s.refusal('item.bookHistory', {})).toMatch(/^Invalid parameters for item\.bookHistory: sku: /);
    expect(await s.refusal('item.bookHistory', { sku: 'not an item' })).toMatch(/^Invalid parameters for item\.bookHistory: sku: not a SKU/);
    expect(await s.refusal('item.bookHistory', { sku: '378;6', orders: sixOrders })).toMatch(/^Invalid parameters for item\.bookHistory: orders/);
    expect(await s.refusal('item.bookHistory', { sku: '378;6', orders: [''] })).toMatch(/^Invalid parameters for item\.bookHistory: orders/);
    expect(await s.refusal('item.bookHistory', { sku: '378;6', orders: ['x'.repeat(201)] })).toMatch(/^Invalid parameters for item\.bookHistory: orders/);
    expect(await s.refusal('item.bookHistory', { sku: '378;6', orders: 'l1' })).toMatch(/^Invalid parameters for item\.bookHistory: orders/);
  });

  it('routes both methods (never "Unknown method")', async () => {
    const s = service();
    for (const [m, params] of [
      ['item.bookHistory', { sku: '378;6', orders: sixOrders.slice(0, BOOK_HISTORY_ORDERS_MAX) }],
      ['profit.reserveSuggestion', undefined],
    ] as const) {
      expect(await s.refusal(m, params), m).not.toMatch(/unknown method/i);
    }
  });

  it("'opps.list' accepts sort 'backup' and 'depth' and refuses another", async () => {
    const s = service();
    for (const sort of ['backup', 'depth'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const res = await s.call<OppListResult>('opps.list', { sort, dir });
        expect(res.rows, `${sort} ${dir}`).toEqual([]);
      }
    }
    expect(await s.refusal('opps.list', { sort: 'nope' })).toMatch(/^Invalid parameters for opps\.list: sort: /);
  });
});

describe('the mock answers the new methods alike', () => {
  it('routes both (each answers or refuses, never "unknown method")', async () => {
    const bridge = mock();
    const params: Record<string, unknown> = {
      'item.bookHistory': { sku: '378;6', orders: ['l1'] },
      'profit.reserveSuggestion': undefined,
    };
    for (const m of NEW_METHODS) {
      const outcome = await bridge.rpc(m, params[m] as never).then(
        () => 'answered',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(outcome, m).not.toMatch(/unknown method/i);
    }
  });

  it("refuses item.bookHistory's bad params as the service does", async () => {
    const bridge = mock();
    await expect(bridge.rpc('item.bookHistory', { sku: 7 as unknown as string })).rejects.toThrow(
      'Invalid parameters for item.bookHistory: sku: not a SKU (pick an item first)',
    );
    await expect(bridge.rpc('item.bookHistory', { sku: '378;6', orders: sixOrders })).rejects.toThrow(/^Invalid parameters for item\.bookHistory: orders/);
    await expect(bridge.rpc('item.bookHistory', { sku: '378;6', orders: [''] })).rejects.toThrow(/^Invalid parameters for item\.bookHistory: orders/);
  });

  it("sorts 'opps.list' by the new keys without refusing", async () => {
    const bridge = mock();
    for (const sort of ['backup', 'depth'] as const) {
      const res = await bridge.rpc('opps.list', { sort });
      expect(Array.isArray(res.rows)).toBe(true);
    }
  });
});
