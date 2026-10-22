// 0.8 Foundation: the release's new RPC methods and push exist on every side (the contract, the service's
// router, main's push filter and the browser mock). It pins only what stays true once holdings (Wave 2) and alerts
// (Wave 3) replace the stub bodies: the methods are routed and zod-checked, and journal.add keeps a fee. What the
// stubs answer is left to holdingsRpc, watchesRpc, mockHoldings08 and mockWatches.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_ONLY_PUSH_EVENTS, SERVICE_PUSH_EVENTS } from '../../src/main/serviceHost';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { PUSH_EVENTS, SERVICE_METHODS, type RpcMethod } from '../../src/shared/rpc';
import { WATCH_SPECIAL_MAX } from '../../src/shared/watches';
import type { JournalEntry } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const NEW_METHODS: readonly RpcMethod[] = ['journal.update', 'holdings.detail', 'watches.list', 'watches.upsert', 'watches.delete', 'watches.restore'];

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

/** The real handlers over a real repo (audit-074-typed-price-replace's harness): no holdings and no watches in ctx. */
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

const FEE_BUY = { side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 0, scrap: 90, feeScrap: 3 } as const;

describe('the 0.8 contract', () => {
  it('lists the new service methods, and watches.changed as a service push (not main only)', () => {
    for (const m of NEW_METHODS) expect(SERVICE_METHODS).toContain(m);
    expect(PUSH_EVENTS).toContain('watches.changed');
    expect(SERVICE_PUSH_EVENTS).toContain('watches.changed');
    expect(MAIN_ONLY_PUSH_EVENTS).not.toContain('watches.changed');
  });
});

describe('the service routes and zod-checks the new methods', () => {
  it('refuses bad params with the method named, before any body runs', async () => {
    const s = service();
    expect(await s.refusal('holdings.detail', { sku: 7 })).toMatch(/^Invalid parameters for holdings\.detail: sku: /);
    expect(await s.refusal('watches.upsert', { sku: '378;6', special: 'x'.repeat(WATCH_SPECIAL_MAX + 1) })).toMatch(/^Invalid parameters for watches\.upsert: special: /);
    expect(await s.refusal('watches.list', { sku: 7 })).toMatch(/^Invalid parameters for watches\.list: sku: /);
    expect(await s.refusal('watches.delete', { id: -1 })).toMatch(/^Invalid parameters for watches\.delete: id: /);
    expect(await s.refusal('watches.restore', { id: 1, sku: '378;6', maxCostScrap: 300, createdAt: -1, updatedAt: 0 })).toMatch(/^Invalid parameters for watches\.restore: createdAt: /);
    expect(await s.refusal('journal.update', { id: 0 })).toMatch(/^Invalid parameters for journal\.update: id: /);
  });

  it('journal.add keeps a fee (feeScrap alone records it, the keys part then 0)', async () => {
    const s = service();
    const row = await s.call<JournalEntry>('journal.add', FEE_BUY);
    expect(row).toMatchObject({ side: 'buy', sku: '378;6', scrap: 90, feeKeys: 0, feeScrap: 3, keyPriceScrap: 577 });
    expect(s.repo.getJournal(row.id)).toEqual(row);
    expect(await s.call<JournalEntry[]>('journal.list', {})).toEqual([row]);
  });
});

describe('the mock answers the new methods alike', () => {
  it('routes all six (each answers or refuses, never "unknown method")', async () => {
    const bridge = mock();
    const added = await bridge.rpc('journal.add', FEE_BUY);
    const params: Record<string, unknown> = {
      'journal.update': { id: added.id, note: 'edited' },
      'holdings.detail': { sku: '378;6' },
      'watches.list': {},
      'watches.upsert': { sku: '378;6', maxCostScrap: 300 },
      'watches.delete': { id: 1 },
      'watches.restore': { id: 99, sku: '378;6', maxCostScrap: 300, createdAt: NOW - 1000, updatedAt: NOW - 1000 },
    };
    for (const m of NEW_METHODS) {
      const outcome = await bridge.rpc(m, params[m] as never).then(
        () => 'answered',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(outcome, m).not.toMatch(/unknown method/i);
    }
  });

  it("refuses holdings.detail's { sku: 7 } as the service does", async () => {
    const bridge = mock();
    await expect(bridge.rpc('holdings.detail', { sku: 7 as unknown as string })).rejects.toThrow(/^Invalid parameters for holdings\.detail: sku: /);
  });

  it('journal.add keeps a fee', async () => {
    const bridge = mock();
    const row = await bridge.rpc('journal.add', FEE_BUY);
    expect(row).toMatchObject({ side: 'buy', sku: '378;6', scrap: 90, feeKeys: 0, feeScrap: 3 });
    const listed = await bridge.rpc('journal.list', { limit: 10_000 });
    expect(listed.find((j) => j.id === row.id)).toEqual(row);
  });
});
