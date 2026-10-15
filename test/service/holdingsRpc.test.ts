// v0.3 service wiring (foundation): 'holdings.list' is registered with validated
// params and answers a HoldingsResult, the 'holdings' CSV export has its columns,
// journal.add / journal.delete push 'journal.changed', and market.list takes a
// 2000-row window. Runs the real core against a temp repo; only the schema host
// answers, and no request is made for any of this.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { CSV_BOM } from '../../src/service/domain/csv';
import { holdingsCsv } from '../../src/service/domain/holdings';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { HOLDINGS_CSV_COLUMNS } from '../../src/shared/holdings';
import { SERVICE_METHODS, type PushEvent } from '../../src/shared/rpc';
import type { HoldingsResult, JournalEntry, MarketListResult } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

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
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-holdings-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
  });
  const core = createServiceCore({
    dataDir,
    version: '0.3.0',
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
  // Only the schema load at start; nothing below may add a request.
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  return { core, pushes, call };
}

describe("'holdings.list'", () => {
  it('is a registered service method answering a HoldingsResult', async () => {
    const h = await setup();
    expect(SERVICE_METHODS).toContain('holdings.list');
    for (const params of [undefined, {}, { search: 'captain' }]) {
      const r = await h.call<HoldingsResult>('holdings.list', params);
      expect(r).toMatchObject({ rows: expect.any(Array), totals: { items: expect.any(Number), units: expect.any(Number), sellable: expect.any(Number) } });
      expect(typeof r.generatedAt).toBe('number');
      expect(r.keyPrice?.valueScrap).toBeGreaterThan(0);
    }
    expect(requested).toEqual([]);
  });

  it('validates its params', async () => {
    const h = await setup();
    await expect(h.call('holdings.list', { search: 'x'.repeat(201) })).rejects.toThrow(/Invalid parameters for holdings\.list/);
    await expect(h.call('holdings.list', { search: 5 })).rejects.toThrow(/Invalid parameters for holdings\.list/);
    await expect(h.call('opps.exportCsv', { kind: 'holdings', holdings: { search: 7 } })).rejects.toThrow(/Invalid parameters for opps\.exportCsv/);
  });
});

describe("opps.exportCsv kind 'holdings'", () => {
  it('writes the holdings CSV with its columns', async () => {
    const h = await setup();
    const r = await h.call<{ csv: string; suggestedName: string }>('opps.exportCsv', { kind: 'holdings', holdings: { search: 'knife' } });
    expect(r.suggestedName).toMatch(/^flipdesk-holdings-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(r.csv.startsWith(CSV_BOM)).toBe(true);
    expect(r.csv.slice(CSV_BOM.length).split('\r\n')[0]).toBe(HOLDINGS_CSV_COLUMNS.join(','));
    expect(holdingsCsv([], 568)).toBe(`${CSV_BOM}${HOLDINGS_CSV_COLUMNS.join(',')}\r\n`);
  });
});

describe("'journal.changed'", () => {
  it('is pushed after journal.add and journal.delete', async () => {
    const h = await setup();
    const journalPushes = () => h.pushes.filter((p) => p.event === 'journal.changed');
    const row = await h.call<JournalEntry>('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '378;6', scrap: 30 });
    expect(journalPushes()).toEqual([{ event: 'journal.changed', payload: { at: expect.any(Number) } }]);
    await h.call('journal.delete', { id: row.id });
    expect(journalPushes()).toHaveLength(2);
    // A rejected write changes nothing and pushes nothing.
    await expect(h.call('journal.add', { side: 'buy', venue: '', sku: '378;6', scrap: 30 })).rejects.toThrow(/Invalid parameters/);
    expect(journalPushes()).toHaveLength(2);
    expect(requested).toEqual([]);
  });
});

describe("'market.list' window", () => {
  it('takes up to 2000 rows in one call (H2) and refuses more', async () => {
    const h = await setup();
    const r = await h.call<MarketListResult>('market.list', { limit: 2000 });
    expect(r.stats).toMatchObject({ lastError: null, retryAt: null });
    expect(Array.isArray(r.scraptf.coverage)).toBe(true);
    await expect(h.call('market.list', { limit: 2001 })).rejects.toThrow(/Invalid parameters for market\.list/);
  });
});
