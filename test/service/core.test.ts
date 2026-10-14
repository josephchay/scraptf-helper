// Headless end-to-end test of the service core: real repo (temp dir), real
// connectors, engine and scheduler, with a fake fetch serving captured
// PriceDB / sku.pricedb.io fixtures and a fake websocket replaying the
// captured backpack.tf feed. Nothing here touches the network.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { PricedbSocketLike } from '../../src/service/connectors/pricedb';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type {
  AppStatus,
  DeepPartial,
  HealthReport,
  ImportResult,
  ItemDetail,
  OppListResult,
  OpportunityEvent,
  ScrapPrice,
  SecretName,
  Settings,
} from '../../src/shared/types';
import { FakeSocket, type WsSample } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = <T = unknown>(rel: string): T => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8')) as T;

const schemaSubset = load('pricedb/schema-subset.json');
const paintList = load('pricedb/paint-list.json');
const autob = load('pricedb/autob-items.json');
const itemKey = load('pricedb/item-key.json');
const wsSample = load<WsSample>('bptf/ws-sample.json');

const SECRET = 'STEAMKEY-0123456789abcdef-SECRET';
const ITEM = '200;11;australium'; // Strange Australium Scattergun: a 39 keys 40.44 ref buy order in the capture

interface FetchCall {
  url: string;
  method: string;
  ua: string | null;
  headers: Record<string, string>;
}

type ExtraRoute = (u: URL, headers: Headers) => Response | null;

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Serves the captured fixtures for the hosts the core may contact and refuses everything else. */
function fakeFetch(extra?: ExtraRoute): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, method: String(init?.method ?? 'GET'), ua: headers.get('user-agent'), headers: Object.fromEntries(headers) });
    const u = new URL(url);
    const routed = extra?.(u, headers);
    if (routed) return routed;
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
  return { impl, calls };
}

/** Replays the captured feed: opens, then sends the events in frames of 50. */
function fakeWs(): { factory: (url: string, headers: Record<string, string>) => FakeSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory = (url: string, headers: Record<string, string>): FakeSocket => {
    const s = new FakeSocket(url, headers);
    sockets.push(s);
    setTimeout(() => {
      s.open();
      const events = wsSample.events;
      for (let i = 0; i < events.length; i += 50) s.send(events.slice(i, i + 50));
    }, 10);
    return s;
  };
  return { factory, sockets };
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

function setup(patch: DeepPartial<Settings> = {}, secrets: Partial<Record<SecretName, string>> = { steamApiKey: SECRET }, extra?: ExtraRoute) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-core-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const fetch = fakeFetch(extra);
  const ws = fakeWs();
  const logger = createLogger({ dataDir });
  let settings = mergeSettings(DEFAULT_SETTINGS, { contactUrl: 'https://github.com/flipdesk-test', ...patch });
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  const core = createServiceCore({
    dataDir,
    version: '0.1.0',
    settings,
    secrets,
    log: logger,
    fetchImpl: fetch.impl,
    wsFactory: ws.factory,
    socketFactory: () => fakePricedbSocket(),
  });
  cores.push(core);
  core.onPush((event, payload) => pushes.push({ event, payload }));
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const update = (p: DeepPartial<Settings>) => {
    settings = mergeSettings(settings, p);
    core.updateSettings(settings);
  };
  return { root, dataDir, core, fetch, ws, logger, pushes, call, update };
}

describe('service core end to end', () => {
  it('ingests the feed, prices an item, logs events, gates import and honours the network pause', async () => {
    const h = setup();
    await h.core.start();

    // Schema from sku.pricedb.io, PriceDB list and key price, then the replayed feed.
    const health = await waitFor('feed, schema and prices', async () => {
      const r = await h.call<HealthReport>('health.get');
      return r.feed.buyListings > 0 && r.schema.items > 0 && (r.pricedb?.rows ?? 0) > 0 && r.keyPrice?.source === 'pricedb' ? r : null;
    });
    expect(health.feed.state).toBe('live');
    expect(health.feed.eventsToday).toBeGreaterThan(0);
    expect(health.budgets.every((b) => typeof b.id === 'string')).toBe(true);
    expect(health.connectors.map((c) => c.id)).toEqual(
      expect.arrayContaining(['bptf-ws', 'bptf-snapshot', 'schema', 'pricedb', 'pricedb-socket', 'scm', 'import-watch']),
    );
    expect(health.recentRequests.some((r) => r.host === 'sku.pricedb.io')).toBe(true);
    // Only the two keyless hosts were contacted, always with the honest User-Agent (R1, R6).
    expect(new Set(h.fetch.calls.map((c) => new URL(c.url).hostname))).toEqual(new Set(['sku.pricedb.io', 'pricedb.io']));
    expect(h.fetch.calls.every((c) => c.ua === 'TF2FlipDesk/0.1.0 (+https://github.com/flipdesk-test)')).toBe(true);
    expect(h.ws.sockets).toHaveLength(1);
    expect(h.ws.sockets[0]!.headers['User-Agent']).toMatch(/^TF2FlipDesk\/0\.1\.0/);

    const K = health.keyPrice!.valueScrap;
    expect(K).toBe(569); // PriceDB 5021;6 buy 63.22 ref

    // Sell listings are only kept for watched SKUs; nothing is watched yet.
    expect(health.feed.sellListings).toBe(0);
    let status = await h.call<AppStatus>('status.get');
    expect(status.setupNeeded).toEqual(['bptf-token', 'bptf-key', 'first-price']);

    // A scrap.tf price for an item with a captured buy order.
    const price = await h.call<ScrapPrice>('prices.upsert', { sku: ITEM, costKeys: 35, costScrap: 0 });
    expect(price).toMatchObject({ sku: ITEM, source: 'user', name: 'Strange Australium Scattergun' });
    await h.call('engine.runNow');

    const list = await h.call<OppListResult>('opps.list', {});
    const opp = list.rows.find((o) => o.sku === ITEM);
    expect(opp).toBeDefined();
    const revenue = 39 * K + 364; // 39 keys 40.44 ref
    expect(opp!.bestScrap).toBe(revenue);
    expect(opp!.costScrap).toBe(35 * K);
    expect(opp!.profitScrap).toBe(revenue - 35 * K);
    expect(opp!.status).toBe('profitable');
    expect(opp!.references.pricedb).not.toBeNull();
    expect(list.keyPrice?.source).toBe('pricedb');

    const detail = await h.call<ItemDetail>('item.detail', { sku: ITEM });
    expect(detail.name).toBe('Strange Australium Scattergun');
    expect(detail.buyOrders.some((o) => o.eligible && o.valueScrap === revenue)).toBe(true);
    expect(detail.opportunities).toHaveLength(1);
    expect(detail.links.length).toBeGreaterThan(3);
    expect(detail.snapshot.available).toBe(false); // no access token

    const events = await h.call<OpportunityEvent[]>('opps.events', {});
    expect(events.some((e) => e.kind === 'appeared' && e.sku === ITEM)).toBe(true);
    expect(h.pushes.some((p) => p.event === 'opps.changed')).toBe(true);

    const logs = readdirSync(path.join(h.root, 'logs'));
    const jsonl = logs.find((f) => /^opportunities-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    expect(jsonl).toBeDefined();
    const lines = readFileSync(path.join(h.root, 'logs', jsonl!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as OpportunityEvent);
    expect(lines.some((e) => e.kind === 'appeared' && e.sku === ITEM)).toBe(true);

    status = await h.call<AppStatus>('status.get');
    expect(status.setupNeeded).toEqual(['bptf-token', 'bptf-key']);
    expect(status.counts.profitable).toBeGreaterThanOrEqual(1);

    // Other read paths.
    const search = await h.call<{ sku: string }[]>('item.search', { q: 'scattergun', limit: 5 });
    expect(search.length).toBeGreaterThan(0);
    expect(await h.call('item.scm', { sku: ITEM })).toBeNull(); // SCM is off by default
    const csv = await h.call<{ csv: string; suggestedName: string }>('opps.exportCsv', { kind: 'opportunities' });
    expect(csv.suggestedName).toMatch(/^flipdesk-opportunities-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.csv).toContain('Strange Australium Scattergun');
    expect((await h.call<{ ok: boolean; message: string }>('secrets.test', { name: 'steamApiKey' })).message).toMatch(/not used yet/);
    await expect(h.call('nope.method')).rejects.toThrow(/Unknown method/);
    await expect(h.call('prices.upsert', { sku: 'not a sku', costScrap: 1 })).rejects.toThrow(/Invalid parameters/);

    // Saved-page import is refused until enabled and acknowledged (R10).
    const html = readFileSync(path.join(FIX, 'import', 'buy_hats.html'), 'utf8');
    await expect(h.call('import.html', { html, fileName: 'buy_hats.html', mtimeMs: Date.now() - 60_000 })).rejects.toThrow(/turned off/);
    h.update({ import: { enabled: true, acknowledgedAt: Date.now() } });
    const imported = await h.call<ImportResult>('import.html', { html, fileName: 'buy_hats.html', mtimeMs: Date.now() - 60_000 });
    expect(imported.parsed).toBeGreaterThan(0);
    expect(imported.stored).toBeGreaterThan(0);
    expect(h.pushes.some((p) => p.event === 'import.done')).toBe(true);
    const batches = await h.call<{ id: number }[]>('import.batches', {});
    expect(batches.map((b) => b.id)).toEqual([imported.batchId]);
    const importedPrices = (await h.call<ScrapPrice[]>('prices.list', {})).filter((p) => p.source === 'import');
    expect(importedPrices).toHaveLength(imported.stored);
    // Importing the same page again replaces those prices instead of duplicating them.
    const again = await h.call<ImportResult>('import.html', { html, fileName: 'buy_hats.html', mtimeMs: Date.now() - 30_000 });
    const afterAgain = (await h.call<ScrapPrice[]>('prices.list', {})).filter((p) => p.source === 'import');
    expect(afterAgain).toHaveLength(again.stored);
    expect(afterAgain.every((p) => p.importBatch === again.batchId)).toBe(true);

    // Network pause: sockets close and no request leaves the process.
    h.update({ networkPaused: true });
    const before = h.fetch.calls.length;
    const refresh = await h.call<{ queued: boolean; reason: string }>('item.refresh', { sku: ITEM });
    expect(refresh.queued).toBe(false);
    await h.call('prices.upsert', { sku: '36;11;australium', costKeys: 1, costScrap: 0 });
    await h.call('item.detail', { sku: '36;11;australium' });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(h.fetch.calls.length).toBe(before);
    const paused = await h.call<HealthReport>('health.get');
    expect(['paused', 'off']).toContain(paused.feed.state);
    expect(h.ws.sockets[0]!.readyState).toBe(3);
    expect((await h.call<AppStatus>('status.get')).networkPaused).toBe(true);

    // The service log is written and redacted (R8).
    h.logger.info(`a line that mentions ${SECRET}`);
    h.logger.flush();
    const serviceLog = readFileSync(path.join(h.root, 'logs', 'service.log'), 'utf8');
    expect(serviceLog).toContain('service started');
    expect(serviceLog).toContain('REDACTED');
    expect(serviceLog).not.toContain(SECRET);
  }, 60_000);

  it('refreshes an item from a backpack.tf snapshot with the access token and reconciles its order book', async () => {
    const token = 'bptf-access-token-0123456789abcdef';
    const snapshotNames: string[] = [];
    const h = setup({}, { bptfAccessToken: token }, (u) => {
      if (u.hostname !== 'api.backpack.tf' || u.pathname !== '/api/classifieds/listings/snapshot') return null;
      snapshotNames.push(u.searchParams.get('sku') ?? '');
      const nowSec = Math.floor(Date.now() / 1000);
      return jsonResponse({
        appid: 440,
        sku: u.searchParams.get('sku'),
        createdAt: nowSec,
        listings: [
          {
            steamid: '76561198000000077',
            offers: 1,
            buyout: 1,
            details: '',
            intent: 'buy',
            timestamp: nowSec - 600,
            bump: nowSec - 60,
            currencies: { keys: 40, metal: 0 },
            userAgent: { client: 'TF2Autobot', lastPulse: nowSec - 30 },
            item: { defindex: 200, quality: 11, quantity: '1', attributes: [{ defindex: 2027, value: 1, float_value: 1 }] },
          },
        ],
      });
    });
    await h.core.start();
    await waitFor('feed and key price', async () => {
      const r = await h.call<HealthReport>('health.get');
      return r.feed.buyListings > 0 && r.keyPrice?.source === 'pricedb';
    });
    const before = await h.call<ItemDetail>('item.detail', { sku: ITEM });
    expect(before.snapshot.available).toBe(true);
    expect(before.buyOrders.map((o) => o.keys)).toEqual([39]);

    const r = await h.call<{ queued: boolean; reason: string | null; etaMs: number | null }>('item.refresh', { sku: ITEM });
    expect(r).toMatchObject({ queued: true, reason: null });
    const after = await waitFor('the snapshot', async () => {
      const d = await h.call<ItemDetail>('item.detail', { sku: ITEM });
      return d.snapshot.lastAt !== null ? d : null;
    });
    // bp.tf names are learned from the feed (no "The ", no paint) and used for the snapshot.
    expect(snapshotNames).toEqual(['Strange Australium Scattergun']);
    // The snapshot is authoritative: the feed-era order it no longer lists is gone, its own order is in.
    expect(after.buyOrders.map((o) => o.keys)).toEqual([40]);
    expect(h.pushes.some((p) => p.event === 'opps.changed')).toBe(true);

    // The token went only to api.backpack.tf, in the header, and never into the request log or the service log (R8).
    const snapCall = h.fetch.calls.find((c) => c.url.includes('/classifieds/listings/snapshot'))!;
    expect(snapCall.headers['x-auth-token']).toBe(token);
    expect(snapCall.url).not.toContain(token);
    expect(h.fetch.calls.filter((c) => JSON.stringify(c.headers).includes(token)).every((c) => new URL(c.url).hostname === 'api.backpack.tf')).toBe(true);
    const health = await h.call<HealthReport>('health.get');
    expect(JSON.stringify(health)).not.toContain(token);
    h.logger.flush();
    expect(readFileSync(path.join(h.root, 'logs', 'service.log'), 'utf8')).not.toContain(token);
  }, 60_000);

  it('imports pages saved into the watch folder once import is enabled, and stops watching when it is turned off', async () => {
    const h = setup({ networkPaused: true });
    const folder = path.join(h.root, 'saved');
    mkdirSync(folder);
    await h.core.start();
    h.update({ import: { enabled: true, acknowledgedAt: Date.now() - 1_000, watchFolder: folder } });
    let health = await h.call<HealthReport>('health.get');
    expect(health.connectors.find((c) => c.id === 'import-watch')!.state).toBe('live');
    const html = readFileSync(path.join(FIX, 'import', 'buy_hats.html'), 'utf8');
    writeFileSync(path.join(folder, 'Buy Hats - Scrap.TF.html'), html);
    const done = await waitFor('the folder import', async () => h.pushes.find((p) => p.event === 'import.done')?.payload as ImportResult | undefined);
    expect(done.fileName).toBe('Buy Hats - Scrap.TF.html');
    expect(done.stored).toBeGreaterThan(0);
    h.update({ import: { enabled: false } });
    health = await h.call<HealthReport>('health.get');
    expect(health.connectors.find((c) => c.id === 'import-watch')!.state).toBe('off');
    // Nothing went out: the network was paused the whole time.
    expect(h.fetch.calls).toHaveLength(0);
  }, 30_000);

  it('reports a clear error instead of crash-looping on a database from a newer version', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-core-'));
    temps.push(root);
    const dataDir = path.join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'flipdesk.sqlite'));
    db.exec('PRAGMA user_version = 999');
    db.close();
    const lines: string[] = [];
    const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: (m: string) => lines.push(m) };
    const core = createServiceCore({ dataDir, version: '0.1.0', settings: DEFAULT_SETTINGS, secrets: {}, log, fetchImpl: fakeFetch().impl });
    cores.push(core);
    await core.start();
    await expect(core.handle('status.get', undefined)).rejects.toThrow(/newer than this app supports/);
    expect(lines.some((l) => /newer than this app supports/.test(l))).toBe(true);
    expect(existsSync(path.join(dataDir, 'flipdesk.sqlite'))).toBe(true);
  });
});
