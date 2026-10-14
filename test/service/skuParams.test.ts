// RPC SKU params (skuText): typed SKUs are lower-cased, and tokens fromString
// would silently drop are refused instead of saving a price for another item.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ScrapPrice } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Only the schema host answers; everything else is refused (no other source is enabled). */
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
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
});

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-skuparams-'));
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
  await core.start();
  return <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
}

describe('skuText RPC params', () => {
  it('lower-cases a typed SKU instead of dropping its upper-case tokens', async () => {
    const call = await setup();
    const nc = await call<ScrapPrice>('prices.upsert', { sku: '378;6;UNCRAFTABLE', costScrap: 30 });
    expect(nc.sku).toBe('378;6;uncraftable');
    const ks = await call<ScrapPrice>('prices.upsert', { sku: ' 205;11;KT-3 ', costScrap: 30 });
    expect(ks.sku).toBe('205;11;kt-3');
  });

  it.each(['378;6;uncratable', '378;5;u13;u14', '205;11;kt--3'])('refuses %s as not a SKU', async (sku) => {
    const call = await setup();
    await expect(call('prices.upsert', { sku, costScrap: 30 })).rejects.toThrow(/not a SKU/);
    expect(await call<ScrapPrice[]>('prices.list')).toEqual([]);
  });
});
