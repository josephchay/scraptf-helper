// What the network layer and the two websockets learn from a server must
// outlive a crash restart or relaunch (R7, brief §2.0): Retry-After pauses,
// refused bp.tf feed upgrades and refused PriceDB socket upgrades. Each "run"
// is a new service core on the same data dir. Also: replacing a credential
// re-runs its jobs at once. Real repo, fake fetch / websockets; no network.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { PricedbSocketLike } from '../../src/service/connectors/pricedb';
import type { Logger } from '../../src/service/contracts';
import { DB_FILE_NAME, META_NET_PAUSES, createServiceCore, type ServiceCore, type ServiceCoreOptions } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, HealthReport, SecretName, Settings } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = (rel: string): unknown => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8'));
const schemaSubset = load('pricedb/schema-subset.json');
const paintList = load('pricedb/paint-list.json');
const autob = load('pricedb/autob-items.json');
const itemKey = load('pricedb/item-key.json');

const HOUR = 3_600_000;
const KEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa00000001';
const KEY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb00000002';
const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Serves the PriceDB / schema fixtures; api.backpack.tf answers through `bptf`. */
function fakeFetch(bptf: (u: URL) => Response = () => json({ message: 'not in this test' }, 404)): { impl: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(u);
    const p = decodeURIComponent(u.pathname);
    if (u.hostname === 'api.backpack.tf') return bptf(u);
    if (u.hostname === 'sku.pricedb.io') {
      if (p === '/api/schema') return json(schemaSubset, 200, { etag: 'W/"fixture"' });
      if (p === '/api/paint/list') return json(paintList);
      return json({ success: false }, 404);
    }
    if (u.hostname === 'pricedb.io') {
      const rl = { 'ratelimit-limit': '360', 'ratelimit-remaining': '350', 'ratelimit-reset': '60' };
      if (p === '/api/autob/items') return json(autob, 200, rl);
      if (p === '/api/item/5021;6') return json(itemKey, 200, rl);
      if (p === '/api/items-bulk') return json([], 200, rl);
      return json({ error: 'Item not found' }, 404, rl);
    }
    throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
  }) as typeof fetch;
  return { impl, calls };
}

/** A bp.tf feed factory; `then` decides what the server does with each new connection. */
function feed(then: (s: FakeSocket) => void = (s) => s.open()) {
  const sockets: FakeSocket[] = [];
  const factory = (url: string, headers: Record<string, string>): FakeSocket => {
    const s = new FakeSocket(url, headers);
    sockets.push(s);
    setTimeout(() => then(s), 5);
    return s;
  };
  return { factory, sockets };
}

/** A PriceDB socket.io factory; `then` gets the socket's emit. */
function pricedbSockets(then: (emit: (event: string, ...a: unknown[]) => void) => void) {
  let created = 0;
  const factory = (): PricedbSocketLike => {
    created++;
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
    const emit = (event: string, ...a: unknown[]) => (listeners.get(event) ?? []).forEach((l) => l(...a));
    setTimeout(() => then(emit), 5);
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
  };
  return { factory, count: () => created };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
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

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function newDataDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-netpersist-'));
  temps.push(root);
  return path.join(root, 'data');
}

interface Run {
  core: ServiceCore;
  health(): Promise<HealthReport>;
  call<T>(method: string, params?: unknown): Promise<T>;
  /** Stops this run as a quit or crash would end it. */
  end(): Promise<void>;
}

function launch(
  dataDir: string,
  o: {
    fetch?: typeof fetch;
    settings?: DeepPartial<Settings>;
    secrets?: Partial<Record<SecretName, string>>;
    wsFactory?: ServiceCoreOptions['wsFactory'];
    socketFactory?: ServiceCoreOptions['socketFactory'];
  } = {},
): Run {
  const settings = mergeSettings(DEFAULT_SETTINGS, { contactUrl: 'https://github.com/flipdesk-test', ...(o.settings ?? {}) });
  const core = createServiceCore({
    dataDir,
    version: '0.1.0',
    settings,
    secrets: o.secrets ?? {},
    log: quiet,
    fetchImpl: o.fetch ?? fakeFetch().impl,
    ...(o.wsFactory ? { wsFactory: o.wsFactory } : {}),
    ...(o.socketFactory ? { socketFactory: o.socketFactory } : {}),
  });
  cores.push(core);
  return {
    core,
    health: () => core.handle('health.get', undefined) as Promise<HealthReport>,
    call: <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>,
    async end() {
      await core.stop();
      cores.splice(cores.indexOf(core), 1);
      resetBptfSocketGuard();
    },
  };
}

const NO_SOCKETS: DeepPartial<Settings> = { liveFeed: { enabled: false }, connectors: { pricedbSocket: false } };

describe('HTTP pauses across restarts', () => {
  it('a 429 Retry-After from the previous run still holds', async () => {
    const dataDir = newDataDir();
    const fetchA = fakeFetch((u) =>
      u.pathname.includes('IGetCurrencies') ? json({ message: 'slow down' }, 429, { 'retry-after': '3600' }) : json({}, 404),
    );
    const one = launch(dataDir, { fetch: fetchA.impl, settings: NO_SOCKETS, secrets: { bptfApiKey: KEY_A } });
    await one.call('secrets.test', { name: 'bptfApiKey' });
    const t0 = Date.now();
    const pausedA = (await one.health()).budgets.find((b) => b.id === 'bptf-currencies')!.pausedUntil!;
    expect(pausedA).toBeGreaterThan(t0 + HOUR - 10_000);
    await one.end();

    const fetchB = fakeFetch(() => json({}, 200));
    const two = launch(dataDir, { fetch: fetchB.impl, settings: NO_SOCKETS, secrets: { bptfApiKey: KEY_A } });
    const budget = (await two.health()).budgets.find((b) => b.id === 'bptf-currencies')!;
    expect(budget.pausedUntil).toBe(pausedA);
    expect(budget.consecutive429).toBe(1);
    // The key test cannot reach IGetCurrencies while the server's wait runs.
    const r = await two.call<{ ok: boolean; message: string }>('secrets.test', { name: 'bptfApiKey' });
    expect(r.ok).toBe(false);
    expect(fetchB.calls.filter((u) => u.hostname === 'api.backpack.tf')).toEqual([]);
  });

  it('clamps a stored pause to 24 h', async () => {
    const dataDir = newDataDir();
    const one = launch(dataDir, { settings: NO_SOCKETS });
    await one.end();
    const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
    const far = Date.now() + 30 * 24 * HOUR;
    repo.setMeta(META_NET_PAUSES, JSON.stringify({ budgets: { 'bptf-snapshot': { until: far, reason: 'HTTP 429', n429: 1, nBackoff: 1 } }, hosts429: {} }));
    repo.close();

    const before = Date.now();
    const two = launch(dataDir, { settings: NO_SOCKETS });
    const until = (await two.health()).budgets.find((b) => b.id === 'bptf-snapshot')!.pausedUntil!;
    expect(until).toBeGreaterThanOrEqual(before + 24 * HOUR);
    expect(until).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
  });
});

describe('the bp.tf live feed across restarts', () => {
  it('a refused upgrade stays refused after a restart until the user re-enables ws.backpack.tf', async () => {
    const dataDir = newDataDir();
    const wsA = feed((s) => s.reject(403, { cfMitigated: 'challenge', contentType: 'text/html' }));
    const one = launch(dataDir, { settings: { connectors: { pricedbSocket: false } }, wsFactory: wsA.factory });
    await one.core.start();
    const h1 = await waitFor('the feed block', async () => {
      const h = await one.health();
      return h.connectors.find((c) => c.id === 'bptf-ws')?.state === 'blocked' ? h : null;
    });
    expect(h1.blockedHosts).toEqual([{ host: 'ws.backpack.tf', reason: expect.stringMatching(/HTTP 403, Cloudflare challenge/) }]);
    expect(wsA.sockets).toHaveLength(1);
    await one.end();

    const wsB = feed();
    const two = launch(dataDir, { settings: { connectors: { pricedbSocket: false } }, wsFactory: wsB.factory });
    await two.core.start();
    await sleep(1_500);
    expect(wsB.sockets).toHaveLength(0);
    const h2 = await two.health();
    expect(h2.connectors.find((c) => c.id === 'bptf-ws')).toMatchObject({ state: 'blocked', blockedHost: 'ws.backpack.tf' });
    expect(h2.feed.state).toBe('blocked');

    await expect(two.call('net.unblock', { host: 'ws.backpack.tf' })).resolves.toEqual({ ok: true });
    expect(wsB.sockets).toHaveLength(1);
    await waitFor('the feed to go live', async () => (await two.health()).feed.state === 'live');
    expect((await two.health()).blockedHosts).toEqual([]);
  });

  it('a 429 Retry-After on the upgrade holds in the next run', async () => {
    const dataDir = newDataDir();
    const wsA = feed((s) => s.reject(429, { retryAfter: '3600' }));
    const one = launch(dataDir, { settings: { connectors: { pricedbSocket: false } }, wsFactory: wsA.factory });
    await one.core.start();
    await waitFor('the feed backoff', async () => (await one.health()).feed.state === 'backoff');
    await one.end();

    const wsB = feed();
    const two = launch(dataDir, { settings: { connectors: { pricedbSocket: false } }, wsFactory: wsB.factory });
    await two.core.start();
    await sleep(1_500);
    expect(wsB.sockets).toHaveLength(0);
    const ws = (await two.health()).connectors.find((c) => c.id === 'bptf-ws')!;
    expect(ws.state).toBe('backoff');
    expect(ws.detail).toMatch(/HTTP 429.*reconnecting in (59|60) min/);
  });
});

describe('the PriceDB socket across restarts', () => {
  it('a 403 on the upgrade is stored; the next run opens nothing until net.unblock', async () => {
    const dataDir = newDataDir();
    const refused = Object.assign(new Error('websocket error'), {
      type: 'TransportError',
      description: { message: 'Unexpected server response: 403' },
    });
    const sockA = pricedbSockets((emit) => emit('connect_error', refused));
    const one = launch(dataDir, { settings: { liveFeed: { enabled: false } }, socketFactory: sockA.factory });
    await one.core.start();
    const h1 = await waitFor('the PriceDB socket block', async () => {
      const h = await one.health();
      return h.connectors.find((c) => c.id === 'pricedb-socket')?.state === 'blocked' ? h : null;
    });
    expect(h1.blockedHosts).toEqual([{ host: 'ws.pricedb.io', reason: expect.stringMatching(/HTTP 403/) }]);
    expect(h1.connectors.find((c) => c.id === 'pricedb-socket')!.blockedHost).toBe('ws.pricedb.io');
    await sleep(1_200);
    expect(sockA.count()).toBe(1);
    await one.end();

    const sockB = pricedbSockets((emit) => emit('connect'));
    const two = launch(dataDir, { settings: { liveFeed: { enabled: false } }, socketFactory: sockB.factory });
    await two.core.start();
    await sleep(1_200);
    expect(sockB.count()).toBe(0);
    expect((await two.health()).connectors.find((c) => c.id === 'pricedb-socket')).toMatchObject({ state: 'blocked' });

    await two.call('net.unblock', { host: 'ws.pricedb.io' });
    expect(sockB.count()).toBe(1);
    await waitFor('the PriceDB socket to go live', async () => {
      return (await two.health()).connectors.find((c) => c.id === 'pricedb-socket')?.state === 'live';
    });
  });
});

describe('credentials', () => {
  it('replacing a rejected API key re-runs the backpack.tf price jobs at once', async () => {
    const dataDir = newDataDir();
    const f = fakeFetch((u) => {
      const key = u.searchParams.get('key');
      if (key === KEY_A) return json({ response: { success: 0, message: 'API key does not exist.' } }, 403);
      if (u.pathname.includes('IGetPrices')) return json({ response: { success: 1, current_time: 1, items: {} } });
      return json({ response: { success: 0, message: 'not in this test' } }, 404);
    });
    const run = launch(dataDir, { fetch: f.impl, settings: NO_SOCKETS, secrets: { bptfApiKey: KEY_A } });
    await run.core.start();
    // key-bptf runs at start and gets the key rejected.
    await waitFor('the rejected key', async () => {
      const c = (await run.health()).connectors.find((x) => x.id === 'bptf-currencies');
      return c?.lastError ? true : null;
    });
    expect(f.calls.some((u) => u.pathname.includes('IGetPrices'))).toBe(false);

    // IGetPrices would wait for its 30 s start delay (and a failed run for 20 min) without the kick.
    run.core.updateSecrets({ bptfApiKey: KEY_B });
    await waitFor(
      'IGetPrices with the new key',
      async () => f.calls.some((u) => u.pathname.includes('IGetPrices') && u.searchParams.get('key') === KEY_B),
      8_000,
    );
    expect(f.calls.some((u) => u.searchParams.get('key') === KEY_A && u.pathname.includes('IGetPrices'))).toBe(false);
  }, 30_000);
});
