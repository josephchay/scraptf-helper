// Service side of two dashboard contracts: every price-sheet write pushes
// 'prices.changed' (so the dashboard refreshes after a quick-entry save in the
// other window), and the opportunities CSV export honours the list's filters.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { OppListResult, ScrapPrice } from '../../src/shared/types';
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
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-sheet-'));
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

describe('price sheet push', () => {
  it('pushes prices.changed for price and rule writes, so every window refreshes', async () => {
    const h = await setup();
    const count = () => h.pushes.filter((p) => p.event === 'prices.changed').length;
    const price = await h.call<ScrapPrice>('prices.upsert', { sku: '378;6', costScrap: 30 });
    expect(count()).toBe(1);
    expect(h.pushes.find((p) => p.event === 'prices.changed')?.payload).toEqual({ at: expect.any(Number) });
    await h.call('prices.delete', { id: price.id });
    expect(count()).toBe(2);
    const rule = await h.call<{ id: number }>('rules.upsert', { name: 'hats', filter: {}, costScrap: 16 });
    await h.call('rules.delete', { id: rule.id });
    expect(count()).toBe(4);
  });
});

describe('opportunities CSV export', () => {
  it('applies the dashboard filters and sort instead of exporting every row', async () => {
    const h = await setup();
    await h.call('prices.upsert', { sku: '378;6', costScrap: 30 });
    await h.call('prices.upsert', { sku: '200;11', costScrap: 50 });
    await h.call('engine.runNow');
    const list = await h.call<OppListResult>('opps.list', {});
    expect(list.total).toBe(2); // no live feed: both have no buyers

    const rows = (csv: string) => csv.trim().split(/\r?\n/).slice(1);
    const all = await h.call<{ csv: string }>('opps.exportCsv', { kind: 'opportunities' });
    expect(rows(all.csv)).toHaveLength(2);

    // The default dashboard view lists only profitable rows; the export now matches it.
    const profitable = await h.call<{ csv: string }>('opps.exportCsv', { kind: 'opportunities', query: { status: ['profitable'] } });
    expect(rows(profitable.csv)).toHaveLength(0);

    const search = await h.call<{ csv: string }>('opps.exportCsv', { kind: 'opportunities', query: { status: ['no-buyers'], search: '378;6', sort: 'name', dir: 'asc', limit: 1, offset: 0, groupBy: 'tier' } });
    expect(rows(search.csv)).toHaveLength(1);
    expect(rows(search.csv)[0]).toContain('378;6');

    await expect(h.call('opps.exportCsv', { kind: 'opportunities', query: { status: ['nope'] } })).rejects.toThrow(/Invalid parameters/);
  });
});
