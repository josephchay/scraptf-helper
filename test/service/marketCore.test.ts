// F10 core wiring, end to end: the service core with a real repo, a fake fetch
// serving the captured PriceDB / schema fixtures and a fake websocket replaying
// the captured backpack.tf feed. The Live market fills from the feed with no
// request of its own, values a row like the engine's opportunity, joins typed
// prices on prices.changed, rebuilds on a profit-settings change, and pushes
// 'market.changed'. Nothing here touches the network.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { PricedbSocketLike } from '../../src/service/connectors/pricedb';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { DeepPartial, HealthReport, MarketListResult, MarketRow, OppListResult, ScrapPrice, Settings } from '../../src/shared/types';
import { FakeSocket, type WsSample } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = <T = unknown>(rel: string): T => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8')) as T;
const schemaSubset = load('pricedb/schema-subset.json');
const paintList = load('pricedb/paint-list.json');
const autob = load('pricedb/autob-items.json');
const itemKey = load('pricedb/item-key.json');
const wsSample = load<WsSample>('bptf/ws-sample.json');

const ITEM = '200;11;australium'; // Strange Australium Scattergun: a 39 keys 40.44 ref buy order in the capture

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Serves the captured fixtures for the two keyless hosts and refuses everything else. */
function fakeFetch(): { impl: typeof fetch; hosts: string[] } {
  const hosts: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    hosts.push(u.hostname);
    const p = decodeURIComponent(u.pathname);
    if (u.hostname === 'sku.pricedb.io') {
      if (p === '/api/schema') return jsonResponse(schemaSubset, 200, { etag: 'W/"fixture"' });
      if (p === '/api/paint/list') return jsonResponse(paintList);
      return jsonResponse({ success: false }, 404);
    }
    if (u.hostname === 'pricedb.io') {
      const rl = { 'ratelimit-limit': '360', 'ratelimit-remaining': '350', 'ratelimit-reset': '60' };
      if (p === '/api/autob/items') return jsonResponse(autob, 200, rl);
      if (p === '/api/item/5021;6') return jsonResponse(itemKey, 200, rl);
      if (p === '/api/items-bulk') return jsonResponse([], 200, rl);
      return jsonResponse({ error: 'Item not found' }, 404, rl);
    }
    throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
  }) as typeof fetch;
  return { impl, hosts };
}

function fakeWs(): (url: string, headers: Record<string, string>) => FakeSocket {
  return (url, headers) => {
    const s = new FakeSocket(url, headers);
    setTimeout(() => {
      s.open();
      for (let i = 0; i < wsSample.events.length; i += 50) s.send(wsSample.events.slice(i, i + 50));
    }, 10);
    return s;
  };
}

function fakePricedbSocket(): PricedbSocketLike {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  setTimeout(() => (listeners.get('connect') ?? []).forEach((l) => l()), 5);
  return {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    removeAllListeners() {
      listeners.clear();
    },
    disconnect() {
      listeners.clear();
    },
  };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-market-'));
  temps.push(root);
  const fetch = fakeFetch();
  const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  let settings = mergeSettings(DEFAULT_SETTINGS, { contactUrl: 'https://github.com/flipdesk-test' });
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  const core = createServiceCore({
    dataDir: path.join(root, 'data'),
    version: '0.2.0',
    settings,
    secrets: {},
    log: quiet,
    fetchImpl: fetch.impl,
    wsFactory: fakeWs(),
    socketFactory: () => fakePricedbSocket(),
  });
  cores.push(core);
  core.onPush((event, payload) => pushes.push({ event, payload }));
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const update = (p: DeepPartial<Settings>) => {
    settings = mergeSettings(settings, p);
    core.updateSettings(settings);
  };
  return { core, fetch, pushes, call, update };
}

describe('Live market in the service core', () => {
  it('fills from the feed, values rows like the engine, joins prices and rebuilds on a settings change', async () => {
    const h = setup();
    await h.core.start();
    const K = (
      await waitFor('feed and key price', async () => {
        const r = await h.call<HealthReport>('health.get');
        return r.feed.buyListings > 0 && r.keyPrice?.source === 'pricedb' ? r : null;
      })
    ).keyPrice!.valueScrap;

    const find = async (): Promise<{ list: MarketListResult; row: MarketRow | undefined }> => {
      const list = await h.call<MarketListResult>('market.list', { search: ITEM });
      return { list, row: list.rows.find((r) => r.sku === ITEM) };
    };
    const first = await waitFor('the item in the market', async () => {
      const f = await find();
      return f.row && !f.list.stats.building ? f : null;
    });
    const revenue = 39 * K + 364; // 39 keys 40.44 ref
    expect(first.row).toMatchObject({ name: 'Strange Australium Scattergun', bestScrap: revenue, knownSource: 'none', verdict: 'unchecked' });
    expect(first.list.stats.entries).toBeGreaterThan(1);
    expect(first.list.stats.lastFullAt).not.toBeNull();
    expect(first.list.keyPrice?.valueScrap).toBe(K);
    const changed = h.pushes.filter((p) => p.event === 'market.changed').map((p) => p.payload as { changed: number; total: number; at: number });
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.at(-1)!.total).toBeGreaterThan(0);

    // A typed price: the row's verdict follows at once (prices.changed), and matches the engine's opportunity.
    const price = await h.call<ScrapPrice>('prices.upsert', { sku: ITEM, costKeys: 35, costScrap: 0 });
    const typed = (await find()).row!;
    expect(typed).toMatchObject({ knownSource: 'typed', knownCostScrap: 35 * K, verdict: 'flip', profitScrap: (typed.revenueScrap ?? 0) - 35 * K });
    await h.call('engine.runNow');
    const opp = (await h.call<OppListResult>('opps.list', {})).rows.find((o) => o.sku === ITEM)!;
    expect(typed.revenueScrap).toBe(opp.revenueScrap);
    expect(typed.maxCostScrap).toBe(opp.maxCostScrap);
    expect(typed.buyerCount).toBe(opp.buyerCount);

    const csv = await h.call<{ csv: string; suggestedName: string }>('opps.exportCsv', { kind: 'market', market: { search: ITEM, limit: 1 } });
    expect(csv.suggestedName).toMatch(/^flipdesk-market-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.csv).toContain('Strange Australium Scattergun');

    // A stricter minimum margin lowers every ceiling: the market rebuilds on its own.
    const before = typed.maxCostScrap!;
    h.update({ profit: { minMargin: 0.5 } });
    const rebuilt = await waitFor('the rebuilt ceiling', async () => {
      const r = (await find()).row;
      return r && r.maxCostScrap !== null && r.maxCostScrap < before ? r : null;
    });
    expect(rebuilt.maxCostScrap).toBe(maxCostFor(rebuilt.revenueScrap, { ...DEFAULT_SETTINGS.profit, minMargin: 0.5 }));
    expect(rebuilt.verdict).toBe('over');

    // Deleting the price takes the user's side away again.
    await h.call('prices.delete', { id: price.id });
    expect((await find()).row).toMatchObject({ knownSource: 'none', knownCostScrap: null });

    // The market made no request of its own: only the two keyless hosts were ever contacted (R1).
    expect(new Set(h.fetch.hosts)).toEqual(new Set(['sku.pricedb.io', 'pricedb.io']));
  }, 60_000);
});
