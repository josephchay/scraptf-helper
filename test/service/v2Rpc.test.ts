// Service wiring of the v0.2 RPC methods: every new method is registered with
// validated params, and the parts that are plain wiring (bulk price writes,
// the local-only item detail) work end to end against a real repo.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SERVICE_METHODS, type PushEvent } from '../../src/shared/rpc';
import type { ItemDetail, ScrapPrice } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Only the schema host answers; any other request fails the test's expectations. */
const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(u.hostname + u.pathname);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
  if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const temps: string[] = [];
const cores: ServiceCore[] = [];

afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-v2rpc-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
  });
  const core = createServiceCore({
    dataDir,
    version: '0.1.0',
    settings,
    secrets: {},
    log: createLogger({ dataDir }),
    fetchImpl,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
  });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  return { core, pushes, call };
}

const NEW_METHODS = ['shopping.list', 'buyer.check', 'prices.parseBulk', 'prices.bulkUpsert', 'prices.exportCsv', 'rules.exportJson', 'rules.importJson'];

describe('v0.2 service methods', () => {
  it('are in SERVICE_METHODS and registered (never "Unknown method")', async () => {
    const h = await setup();
    for (const m of NEW_METHODS) {
      expect(SERVICE_METHODS).toContain(m);
      const err = await h.call(m, {}).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(err ?? '').not.toMatch(/Unknown method/);
    }
  });

  it('validate their params', async () => {
    const h = await setup();
    await expect(h.call('buyer.check', { steamid: '123' })).rejects.toThrow(/Invalid parameters for buyer\.check/);
    await expect(h.call('prices.parseBulk', { text: 'x', bareUnit: 'metal' })).rejects.toThrow(/Invalid parameters for prices\.parseBulk/);
    await expect(h.call('rules.importJson', {})).rejects.toThrow(/Invalid parameters for rules\.importJson/);
    await expect(h.call('shopping.list', { limit: 0 })).rejects.toThrow(/Invalid parameters for shopping\.list/);
    await expect(h.call('opps.exportCsv', { kind: 'shopping', shopping: { categories: ['nope'] } })).rejects.toThrow(/Invalid parameters/);
    await expect(h.call('item.detail', { sku: '378;6', history: 'no' })).rejects.toThrow(/Invalid parameters for item\.detail/);
  });
});

describe('prices.bulkUpsert', () => {
  it('writes typed prices in one go with one prices.changed push', async () => {
    const h = await setup();
    const existing = await h.call<ScrapPrice>('prices.upsert', { sku: '378;6', costScrap: 30, source: 'import' });
    const before = h.pushes.filter((p) => p.event === 'prices.changed').length;
    const r = await h.call('prices.bulkUpsert', {
      rows: [
        { sku: '200;11', costScrap: 27 },
        { sku: '378;6;p15185211', costKeys: 1, costScrap: 9 },
        { id: existing.id, sku: '378;6', costScrap: 25, source: 'import' },
      ],
    });
    expect(r).toEqual({ added: 2, updated: 1 });
    expect(h.pushes.filter((p) => p.event === 'prices.changed').length).toBe(before + 1);
    const list = await h.call<ScrapPrice[]>('prices.list', {});
    expect(list).toHaveLength(3);
    expect(list.every((p) => p.source === 'user')).toBe(true);
    expect(list.find((p) => p.id === existing.id)).toMatchObject({ costScrap: 25 });
    // Paint moves into the extras, like a single upsert.
    expect(list.find((p) => p.special?.paint === 15185211)).toMatchObject({ sku: '378;6', costKeys: 1, costScrap: 9 });
  });

  it('writes nothing when any row fails, and refuses more than 500 rows', async () => {
    const h = await setup();
    await expect(h.call('prices.bulkUpsert', { rows: [{ sku: '200;11', costScrap: 27 }, { id: 424242, sku: '378;6', costScrap: 1 }] })).rejects.toThrow();
    expect(await h.call<ScrapPrice[]>('prices.list', {})).toEqual([]);
    const many = Array.from({ length: 501 }, () => ({ sku: '378;6', costScrap: 1 }));
    await expect(h.call('prices.bulkUpsert', { rows: many })).rejects.toThrow(/500/);
    await expect(h.call('prices.bulkUpsert', { rows: [{ sku: 'Team Captain', costScrap: 1 }] })).rejects.toThrow(/Invalid parameters/);
    await expect(h.call('prices.bulkUpsert', { rows: [] })).resolves.toEqual({ added: 0, updated: 0 });
  });
});

describe('item.detail', () => {
  it('carries the backpack.tf name, and history: false stays local', async () => {
    const h = await setup();
    await h.call('prices.upsert', { sku: '378;6', costScrap: 30 });
    const d = await h.call<ItemDetail>('item.detail', { sku: '378;6', history: false });
    expect(d.sku).toBe('378;6');
    expect(typeof d.bptfName).toBe('string');
    expect(d.bptfName.length).toBeGreaterThan(0);
    expect(d.history).toEqual([]);
    expect('revenue' in d).toBe(true);
    expect(requested.every((r) => r.startsWith('sku.pricedb.io'))).toBe(true);
  });

  it("takes quick entry's target: 'plain' (a clean copy, not the newest stored copy's extras)", async () => {
    const h = await setup();
    await h.call('prices.upsert', { sku: '378;6;p15185211', costScrap: 30, observedAt: Date.now() + 1_000 });
    const plain = await h.call<ItemDetail>('item.detail', { sku: '378;6', history: false, target: 'plain' });
    expect(plain.sku).toBe('378;6');
    await expect(h.call('item.detail', { sku: '378;6', target: 'painted' })).rejects.toThrow(/Invalid parameters for item\.detail/);
  });
});
