// F14 service wiring (foundation): 'scraptf.listStatus' is a registered method answering the saved
// scrap.tf/items list plus the import switches, and the list reaches the item drawer, the Live market
// rows and strip, and the key price. Runs the real core against a temp repo seeded with list rows;
// only the schema host answers at start, and nothing here makes a request (scrap.tf never, R1).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import { SERVICE_METHODS } from '../../src/shared/rpc';
import { KEY_SKU, type AppStatus, type DeepPartial, type ItemDetail, type MarketListResult, type ScraptfListStatus, type ScraptfListStored, type Settings } from '../../src/shared/types';
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

const NOW = Date.now();
const MIN = 60_000;

function row(over: Partial<ScraptfListStored> & { sku: string }): ScraptfListStored {
  return { name: over.sku, sellsKeys: 0, sellsScrap: 30, paysKeys: 0, paysScrap: 24, stock: 1, stockLimit: 5, batchId: 7, observedAt: NOW - 3 * MIN, ...over };
}

async function setup(rows: ScraptfListStored[], patch: DeepPartial<Settings> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-list-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  // Rows as a saved list leaves them, written before the service starts (the cache loads on first use).
  const seed = openRepo(path.join(dataDir, DB_FILE_NAME));
  seed.upsertScraptfList(rows);
  seed.close();
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    ...patch,
  });
  const core = createServiceCore({
    dataDir,
    version: '0.4.0',
    settings,
    secrets: {},
    log: createLogger({ dataDir }),
    fetchImpl,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
  });
  cores.push(core);
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  return { core, call, root };
}

describe("'scraptf.listStatus'", () => {
  it('is a registered service method answering the saved list and the import switches', async () => {
    expect(SERVICE_METHODS).toContain('scraptf.listStatus');
    const h = await setup([row({ sku: '378;6', batchId: 7, observedAt: NOW - 3 * MIN }), row({ sku: '126;6', batchId: 8, observedAt: NOW - 40 * MIN })]);
    for (const params of [undefined, null, {}]) {
      expect(await h.call<ScraptfListStatus>('scraptf.listStatus', params)).toEqual({
        items: 2,
        newestAt: NOW - 3 * MIN,
        oldestAt: NOW - 40 * MIN,
        pages: 2,
        importEnabled: false,
        watchFolder: null,
        watchActive: false,
        watchError: null,
      });
    }
    await expect(h.call('scraptf.listStatus', { force: true })).rejects.toThrow(/Invalid parameters for scraptf\.listStatus/);
    expect(requested).toEqual([]);
  });

  it('reports the import switches and a watch folder that is not there', async () => {
    const h = await setup([], { import: { enabled: true, acknowledgedAt: NOW - MIN, watchFolder: path.join(os.tmpdir(), 'flipdesk-no-such-folder-f14') } });
    const s = await h.call<ScraptfListStatus>('scraptf.listStatus');
    expect(s).toMatchObject({ items: 0, newestAt: null, oldestAt: null, pages: 0, importEnabled: true, watchActive: false, watchError: 'Folder not found' });
    expect(s.watchFolder).toContain('flipdesk-no-such-folder-f14');
  });

  it('reports a running folder watch', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-watch-'));
    temps.push(root);
    const h = await setup([], { import: { enabled: true, acknowledgedAt: NOW - MIN, watchFolder: root } });
    expect(await h.call<ScraptfListStatus>('scraptf.listStatus')).toMatchObject({ importEnabled: true, watchFolder: root, watchActive: true, watchError: null });
  });
});

describe('the list reaches every feature', () => {
  it('fills the item drawer, the Live market strip and the key price display', async () => {
    const h = await setup([
      row({ sku: '378;6', name: 'Team Captain', sellsKeys: 1, sellsScrap: 9, paysKeys: 1, paysScrap: 0, stock: 5, stockLimit: 5 }),
      row({ sku: KEY_SKU, name: 'Mann Co. Supply Crate Key', sellsScrap: 560, paysScrap: 548, stock: 40, stockLimit: 400 }),
    ]);
    const d = (await h.call<ItemDetail | null>('item.detail', { sku: '378;6;p15185211', history: false }))!;
    expect(d).not.toBeNull();
    const K = d.keyPrice!.valueScrap;
    expect(d.scraptfList).toMatchObject({ sku: '378;6', sellsScrap: K + 9, paysScrap: K, stock: 5, stockLimit: 5, full: true, observedAt: NOW - 3 * MIN });
    expect(d.keyPrice!.scraptfFromList).toEqual({ sellsScrap: 560, paysScrap: 548, observedAt: NOW - 3 * MIN });

    const m = await h.call<MarketListResult>('market.list', {});
    expect(m.scraptf.allItems).toEqual({ label: 'All items', url: SCRAPTF_ITEMS_URL, lastSavedAt: NOW - 3 * MIN, items: 2 });
    for (const r of m.rows) expect(r).toHaveProperty('scraptfFull');

    const status = await h.call<AppStatus>('status.get');
    expect(status.keyPrice?.scraptfFromList?.paysScrap).toBe(548);
    expect(requested).toEqual([]);
  });

  it('answers no list row for an item the list does not have', async () => {
    const h = await setup([row({ sku: '378;6' })]);
    const d = await h.call<ItemDetail | null>('item.detail', { sku: '126;6', history: false });
    expect(d?.scraptfList ?? null).toBeNull();
    const m = await h.call<MarketListResult>('market.list', { onScraptfList: true });
    expect(m.scraptf.allItems.items).toBe(1);
    await expect(h.call('market.list', { onScraptfList: 'yes' })).rejects.toThrow(/Invalid parameters for market\.list/);
  });
});
