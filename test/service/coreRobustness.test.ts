// Service core behaviour across restarts and under adversarial timing: request
// budgets and job cadences survive relaunches, snapshots never resurrect what
// the feed deleted, the opportunity log is bounded and never skips events, and
// a failed folder watch is reported and restarted. Real repo and connectors;
// fake fetch, websocket and fs.watch. Nothing here touches the network.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { PricedbSocketLike } from '../../src/service/connectors/pricedb';
import { META_SCHEMA_CHECKED_AT, META_SCHEMA_EXTRAS, buildSchemaSnapshot } from '../../src/service/connectors/schema';
import type { Clock } from '../../src/service/contracts';
import { META_OPP_LOG_LAST_ID, META_WATCH_IMPORTING, createServiceCore, serviceTimers, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import type { WatchFactory } from '../../src/service/import';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { DeepPartial, HealthReport, ImportResult, ItemDetail, MarketListResult, OpportunityEvent, SecretName, Settings } from '../../src/shared/types';
import { FakeSocket, type WsEvent, type WsSample } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = <T = unknown>(rel: string): T => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8')) as T;

const schemaSubset = load('pricedb/schema-subset.json');
const paintList = load('pricedb/paint-list.json');
const autob = load('pricedb/autob-items.json');
const itemKey = load('pricedb/item-key.json');
const wsSample = load<WsSample>('bptf/ws-sample.json');
const currencies = load<{ objectForm: unknown }>('bptf/igetcurrencies-v1.json');
const prices = load('bptf/igetprices-v4.json');

const ITEM = '200;11;australium'; // Strange Australium Scattergun
const ITEM_NAME = 'Strange Australium Scattergun';
const TOKEN = 'bptf-access-token-0123456789abcdef';
const API_KEY = 'bptfapikey0123456789abcdef012345';
const DAY = 24 * 60 * 60_000;

type Route = (u: URL) => Response | null;

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeFetch(extra?: Route): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const u = new URL(url);
    const routed = extra?.(u);
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

function fakeWs(): { factory: (url: string, headers: Record<string, string>) => FakeSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory = (url: string, headers: Record<string, string>): FakeSocket => {
    const s = new FakeSocket(url, headers);
    sockets.push(s);
    setTimeout(() => {
      s.open();
      for (let i = 0; i < wsSample.events.length; i += 50) s.send(wsSample.events.slice(i, i + 50));
    }, 10);
    return s;
  };
  return { factory, sockets };
}

function fakePricedbSocket(): PricedbSocketLike {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
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

/** Fake fs.watch: tests fail it by hand; every created watch is recorded. */
function fakeWatch(): { factory: WatchFactory; fail(err: Error): void; created: () => number } {
  let onError: ((err: Error) => void) | null = null;
  let created = 0;
  return {
    factory: () => {
      created++;
      return {
        close: () => undefined,
        on: (_event: 'error', fn: (err: Error) => void) => {
          onError = fn;
        },
      };
    },
    fail: (err) => onError?.(err),
    created: () => created,
  };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
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
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const temps: string[] = [];
const cores: ServiceCore[] = [];

afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-core2-'));
  temps.push(root);
  return root;
}

/** A clock the test can move forward while real timers keep running. */
function offsetClock(): Clock & { offset: number } {
  const c = { offset: 0, now: () => Date.now() + c.offset };
  return c;
}

/** Real timers, but the 10 s status tick runs every 100 ms. */
const fastStatusTimers = { ...serviceTimers, setInterval: (fn: () => void, ms: number) => serviceTimers.setInterval(fn, Math.min(ms, 100)) };

interface SetupOptions {
  root?: string;
  patch?: DeepPartial<Settings>;
  secrets?: Partial<Record<SecretName, string>>;
  extra?: Route;
  clock?: Clock;
  fastStatus?: boolean;
  watchFactory?: WatchFactory;
  /** Item data cached by an earlier run, so the folder watch starts with the network paused (P3). */
  cachedSchema?: boolean;
}

/** The item schema as an earlier run cached it in the data folder's database. */
function seedCachedSchema(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const repo = openRepo(path.join(dataDir, 'flipdesk.sqlite'));
  const now = Date.now();
  const built = buildSchemaSnapshot(schemaSubset, paintList, now, 'W/"fixture"');
  repo.replaceSchema(built.snapshot);
  repo.setMeta(META_SCHEMA_EXTRAS, JSON.stringify(built.extras));
  repo.setMeta(META_SCHEMA_CHECKED_AT, String(now));
  repo.close();
}

function setup(o: SetupOptions = {}) {
  const root = o.root ?? newRoot();
  const dataDir = path.join(root, 'data');
  if (o.cachedSchema) seedCachedSchema(dataDir);
  const fetch = fakeFetch(o.extra);
  const ws = fakeWs();
  const logger = createLogger({ dataDir });
  let settings = mergeSettings(DEFAULT_SETTINGS, { contactUrl: 'https://github.com/flipdesk-test', ...(o.patch ?? {}) });
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  const core = createServiceCore({
    dataDir,
    version: '0.1.0',
    settings,
    secrets: o.secrets ?? {},
    log: logger,
    fetchImpl: fetch.impl,
    wsFactory: ws.factory,
    socketFactory: () => fakePricedbSocket(),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.fastStatus ? { timers: fastStatusTimers } : {}),
    ...(o.watchFactory ? { watchFactory: o.watchFactory } : {}),
  });
  cores.push(core);
  core.onPush((event, payload) => pushes.push({ event, payload }));
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const update = (p: DeepPartial<Settings>) => {
    settings = mergeSettings(settings, p);
    core.updateSettings(settings);
  };
  const serviceLog = (): string => {
    logger.flush();
    try {
      return readFileSync(logger.file, 'utf8');
    } catch {
      return '';
    }
  };
  const stop = async () => {
    cores.splice(cores.indexOf(core), 1);
    await core.stop();
  };
  return { root, dataDir, core, fetch, ws, logger, pushes, call, update, serviceLog, stop };
}

const count = (calls: string[], part: string) => calls.filter((c) => c.includes(part)).length;

describe('request budgets and job cadences across restarts', () => {
  it('does not call IGetCurrencies or IGetPrices again when the app is relaunched minutes later', async () => {
    const root = newRoot();
    const clock = offsetClock();
    const bptf: Route = (u) => {
      if (u.hostname !== 'api.backpack.tf') return null;
      if (u.pathname === '/api/IGetCurrencies/v1') return jsonResponse(currencies.objectForm);
      if (u.pathname === '/api/IGetPrices/v4') return jsonResponse(prices);
      return null;
    };
    const opts: SetupOptions = { root, clock, secrets: { bptfApiKey: API_KEY }, extra: bptf, patch: { liveFeed: { enabled: false } } };

    const first = setup(opts);
    await first.core.start();
    await waitFor('IGetCurrencies', () => count(first.fetch.calls, '/IGetCurrencies/') === 1);
    clock.offset += 31_000; // bptf-prices waits 30 s after start
    await waitFor('IGetPrices', () => count(first.fetch.calls, '/IGetPrices/') === 1);
    await first.stop();

    // Relaunched two minutes later, and it runs past the first jobs' start delays.
    clock.offset += 2 * 60_000;
    const second = setup(opts);
    await second.core.start();
    await sleep(1_500);
    clock.offset += 31_000;
    await sleep(2_500);
    expect(count(second.fetch.calls, '/IGetCurrencies/')).toBe(0);
    expect(count(second.fetch.calls, '/IGetPrices/')).toBe(0);
    // The request log of the first process counts against the second one's budgets.
    const health = await second.call<HealthReport>('health.get');
    expect(health.budgets.find((b) => b.id === 'bptf-currencies')!.usedLastHour).toBe(1);
    expect(health.budgets.find((b) => b.id === 'bptf-prices')!.usedLastHour).toBe(1);
  }, 60_000);
});

describe('snapshots never undo newer feed data', () => {
  const snapshotRoute = (body: () => unknown, names: string[]): Route => (u) => {
    if (u.hostname !== 'api.backpack.tf' || u.pathname !== '/api/classifieds/listings/snapshot') return null;
    names.push(u.searchParams.get('sku') ?? '');
    return jsonResponse(body());
  };
  const buyOrder = (steamid: string, keys: number, nowSec: number) => ({
    steamid,
    offers: 1,
    buyout: 1,
    details: '',
    intent: 'buy',
    timestamp: nowSec - 600,
    bump: nowSec - 60,
    currencies: { keys, metal: 0 },
    userAgent: { client: 'TF2Autobot', lastPulse: nowSec - 30 },
    item: { defindex: 200, quality: 11, quantity: '1', attributes: [{ defindex: 2027, value: 1, float_value: 1 }] },
  });
  const feedReady = async (h: ReturnType<typeof setup>) => {
    await h.core.start();
    await waitFor('feed and key price', async () => {
      const r = await h.call<HealthReport>('health.get');
      return r.feed.buyListings > 0 && r.keyPrice?.source === 'pricedb';
    });
  };
  const detail = (h: ReturnType<typeof setup>) => h.call<ItemDetail>('item.detail', { sku: ITEM });

  it('a cached snapshot (second refresh within 10 min) does not bring back an order the feed deleted', async () => {
    const names: string[] = [];
    const h = setup({
      secrets: { bptfAccessToken: TOKEN },
      extra: snapshotRoute(() => {
        const nowSec = Math.floor(Date.now() / 1000);
        return { appid: 440, sku: ITEM_NAME, createdAt: nowSec, listings: [buyOrder('76561198000000077', 40, nowSec)] };
      }, names),
    });
    await feedReady(h);
    await h.call('item.refresh', { sku: ITEM });
    const fresh = await waitFor('the snapshot', async () => {
      const d = await detail(h);
      return d.snapshot.lastAt !== null && d.buyOrders.some((o) => o.keys === 40) ? d : null;
    });
    const order = fresh.buyOrders.find((o) => o.keys === 40)!;

    // The buyer cancels: the feed deletes the order.
    h.ws.sockets[0]!.send([{ id: 'del-1', event: 'listing-delete', payload: { id: order.listingId, appid: 440 } }]);
    await waitFor('the feed delete', async () => !(await detail(h)).buyOrders.some((o) => o.listingId === order.listingId));

    // A second refresh inside the 10 min cache window is answered from the cache.
    await h.call('item.refresh', { sku: ITEM });
    await waitFor('the cached refresh', () => h.serviceLog().includes('served from cache'));
    expect(names).toHaveLength(1);
    expect((await detail(h)).buyOrders.some((o) => o.listingId === order.listingId)).toBe(false);
  }, 60_000);

  it('a fresh snapshot taken before a feed update or delete keeps the feed version', async () => {
    const names: string[] = [];
    const createdSec = Math.floor(Date.now() / 1000) - 300; // bp.tf built the snapshot 5 min before we fetch it
    const h = setup({
      secrets: { bptfAccessToken: TOKEN },
      extra: snapshotRoute(
        () => ({
          appid: 440,
          sku: ITEM_NAME,
          createdAt: createdSec,
          listings: [
            buyOrder('76561199384017633', 39, createdSec), // the captured buyer, at the old price
            buyOrder('76561198000000077', 40, createdSec),
            buyOrder('76561198000000088', 38, createdSec), // deleted by the feed after createdAt
          ],
        }),
        names,
      ),
    });
    await feedReady(h);
    // After createdAt: the captured buyer raises to 45 keys, and buyer 88's order is deleted.
    const captured = wsSample.events.find((e) => e.event === 'listing-update' && e.payload.item.name === ITEM_NAME)!;
    const raised: WsEvent = {
      ...captured,
      id: 'raise-1',
      payload: { ...captured.payload, currencies: { metal: 0, keys: 45 } } as WsEvent['payload'],
    };
    const before = await detail(h);
    const listing88 = before.buyOrders[0]!.listingId.replace(/^440_\d+_/, '440_76561198000000088_');
    h.ws.sockets[0]!.send([raised, { id: 'del-88', event: 'listing-delete', payload: { id: listing88, appid: 440 } }]);
    await waitFor('the feed update', async () => (await detail(h)).buyOrders.some((o) => o.keys === 45));

    await h.call('item.refresh', { sku: ITEM });
    const after = await waitFor('the snapshot', async () => {
      const d = await detail(h);
      return d.snapshot.lastAt !== null && d.buyOrders.some((o) => o.keys === 40) ? d : null;
    });
    expect(names).toEqual([ITEM_NAME]);
    const keys = after.buyOrders.map((o) => o.keys).sort((a, b) => b - a);
    expect(keys).toEqual([45, 40]); // not reverted to 39, and the deleted 38 is not re-created
    // Rows from the snapshot are as old as the snapshot, not as the fetch.
    expect(after.buyOrders.find((o) => o.keys === 40)!.lastEventAt).toBeLessThanOrEqual(createdSec * 1000);
  }, 60_000);
});

describe('opportunity JSONL log', () => {
  const event = (i: number, ts: number): Omit<OpportunityEvent, 'id'> => ({
    key: `${ITEM}|price:${i}`,
    sku: ITEM,
    name: ITEM_NAME,
    category: 'weapon' as OpportunityEvent['category'],
    kind: 'notified',
    profitScrap: 10,
    costScrap: 100,
    revenueScrap: 110,
    confidence: 60,
    summary: `event ${i}`,
    ts,
  });

  it('writes every event of a backlog larger than 20,000 (nothing is skipped)', async () => {
    const root = newRoot();
    const dataDir = path.join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const repo = openRepo(path.join(dataDir, 'flipdesk.sqlite'));
    repo.appendEvents([event(0, Date.now())]);
    const logged = repo.listEvents({ limit: 1 })[0]!.id;
    repo.setMeta(META_OPP_LOG_LAST_ID, String(logged));
    const now = Date.now();
    repo.appendEvents(Array.from({ length: 25_000 }, (_, i) => event(i + 1, now)));
    const all = repo.listEvents({ afterId: logged, limit: 5000 });
    expect(all[0]!.id).toBe(logged + 1); // afterId pages forward, oldest first
    repo.close();

    const h = setup({ root, patch: { networkPaused: true }, fastStatus: true });
    await h.core.start();
    const file = path.join(root, 'logs', `opportunities-${localDate(now)}.jsonl`);
    const lines = await waitFor('the JSONL backlog', () => {
      if (!existsSync(file)) return null;
      const l = readFileSync(file, 'utf8').trim().split('\n');
      return l.length >= 25_000 ? l : null;
    });
    const ids = lines.map((l) => (JSON.parse(l) as OpportunityEvent).id);
    expect(ids).toHaveLength(25_000);
    expect(ids[0]).toBe(logged + 1);
    expect(ids.at(-1)).toBe(logged + 25_000);
    expect(new Set(ids).size).toBe(25_000);
  }, 60_000);

  it('removes opportunity log files older than the 90-day event retention, and nothing else', async () => {
    const root = newRoot();
    const logs = path.join(root, 'logs');
    mkdirSync(logs, { recursive: true });
    const old = `opportunities-${localDate(Date.now() - 91 * DAY)}.jsonl`;
    const recent = `opportunities-${localDate(Date.now() - 2 * DAY)}.jsonl`;
    for (const f of [old, recent, 'service.log', 'opportunities-notes.txt']) writeFileSync(path.join(logs, f), '{}\n');
    const h = setup({ root, patch: { networkPaused: true }, fastStatus: true });
    await h.core.start();
    await waitFor('the old log to be removed', () => !existsSync(path.join(logs, old)));
    expect(readdirSync(logs)).toEqual(expect.arrayContaining([recent, 'service.log', 'opportunities-notes.txt']));
  }, 30_000);
});

describe('saved-page folder watch', () => {
  it('reports a watch that failed as an error and restarts it once the folder is back', async () => {
    const clock = offsetClock();
    const fw = fakeWatch();
    const h = setup({ patch: { networkPaused: true }, clock, fastStatus: true, watchFactory: fw.factory, cachedSchema: true });
    const folder = path.join(h.root, 'saved');
    mkdirSync(folder);
    await h.core.start();
    h.update({ import: { enabled: true, acknowledgedAt: Date.now() - 1_000, watchFolder: folder } });
    const watchHealth = async () => (await h.call<HealthReport>('health.get')).connectors.find((c) => c.id === 'import-watch')!;
    expect((await watchHealth()).state).toBe('live');
    expect(fw.created()).toBe(1);

    // The folder is removed: fs.watch reports EPERM and closes.
    rmSync(folder, { recursive: true, force: true });
    fw.fail(new Error('EPERM: operation not permitted, watch'));
    const dead = await watchHealth();
    expect(dead.state).toBe('error');
    expect(dead.lastError).toMatch(/EPERM/);

    // The retry (about once a minute) finds no folder.
    clock.offset += 61_000;
    await waitFor('folder not found', async () => (await watchHealth()).detail === 'Folder not found');

    // The folder comes back: the next retry watches it again.
    mkdirSync(folder);
    clock.offset += 61_000;
    await waitFor('the watch to restart', async () => (await watchHealth()).state === 'live');
    expect(fw.created()).toBe(2);
  }, 30_000);

  it('tells the Live market the folder watch is on only while it really runs', async () => {
    const clock = offsetClock();
    const fw = fakeWatch();
    const h = setup({ patch: { networkPaused: true }, clock, fastStatus: true, watchFactory: fw.factory, cachedSchema: true });
    const folder = path.join(h.root, 'saved');
    await h.core.start();
    const side = async () => (await h.call<MarketListResult>('market.list', {})).scraptf;

    // Chosen but missing: core logs that the watch is off, and the header must say so too.
    h.update({ import: { enabled: true, acknowledgedAt: Date.now() - 1_000, watchFolder: folder } });
    expect(await side()).toMatchObject({ importEnabled: true, watchFolder: false });
    expect(fw.created()).toBe(0);

    // The folder appears: the next retry watches it.
    mkdirSync(folder);
    clock.offset += 61_000;
    await waitFor('the watch to start', async () => (await side()).watchFolder);
    expect(fw.created()).toBe(1);

    // The OS watch fails: off again until the retry restarts it.
    fw.fail(new Error('EPERM: operation not permitted, watch'));
    expect(await side()).toMatchObject({ importEnabled: true, watchFolder: false });
  }, 30_000);

  it('skips the one file a previous run died importing, instead of failing on it at every start', async () => {
    const root = newRoot();
    const folder = path.join(root, 'saved');
    mkdirSync(folder);
    const html = readFileSync(path.join(FIX, 'import', 'buy_hats.html'), 'utf8');
    const bad = path.join(folder, 'crashed.html');
    const good = path.join(folder, 'Buy Hats - Scrap.TF.html');
    writeFileSync(bad, html);
    writeFileSync(good, html);
    const dataDir = path.join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const repo = openRepo(path.join(dataDir, 'flipdesk.sqlite'));
    repo.setMeta(META_WATCH_IMPORTING, JSON.stringify({ file: path.resolve(bad), mtimeMs: statSync(bad).mtimeMs }));
    repo.close();

    const h = setup({
      root,
      patch: { networkPaused: true, import: { enabled: true, acknowledgedAt: Date.now() - 60_000, watchFolder: folder } },
      cachedSchema: true,
    });
    await h.core.start();
    const done = await waitFor('the good file', () => h.pushes.find((p) => p.event === 'import.done')?.payload as ImportResult | undefined);
    expect(done.fileName).toBe('Buy Hats - Scrap.TF.html');
    await waitFor('the skip warning', () => /folder watch skipped crashed\.html/.test(h.serviceLog()));
    await sleep(300);
    expect(h.pushes.filter((p) => p.event === 'import.done')).toHaveLength(1);
    await h.stop();
    const after = openRepo(path.join(dataDir, 'flipdesk.sqlite'));
    expect(after.getMeta(META_WATCH_IMPORTING) ?? '').toBe('');
    after.close();
  }, 30_000);
});
