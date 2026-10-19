// P3 (0.7.1): the saved-page folder watch never imports with half-loaded item data. While the item
// schema has not loaded, the watch does not start and says "Waiting for item data to load" (the list
// card, the banks page and Data health); on the first status tick after it has loaded the watch starts,
// and its catch-up scan imports the pages saved meanwhile, even when an import landed between the schema
// loading and that tick (DC-4: the catch-up start is fixed when the watch begins waiting). Real core, repo and folder watcher in a temp
// folder; the fake fetch serves only sku.pricedb.io, and nothing here touches the network (scrap.tf never).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { STATUS_INTERVAL_MS, WATCH_WAITING_FOR_SCHEMA, createServiceCore, serviceTimers, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { DeepPartial, HealthReport, ImportResult, ScrapPrice, ScraptfListStatus, Settings } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const HATS_HTML = readFileSync(path.join(FIX, 'import', 'buy_hats.html'), 'utf8');
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

/** Real timers, but the 10 s status tick (which starts a waiting watch) runs every 100 ms. */
const fastStatusTimers = { ...serviceTimers, setInterval: (fn: () => void, ms: number) => serviceTimers.setInterval(fn, Math.min(ms, 100)) };

/** As fastStatusTimers, but the status tick runs only when the test calls tick(): nothing races it. */
function manualStatusTimers() {
  const ticks: (() => void)[] = [];
  const timers = {
    ...serviceTimers,
    setInterval: (fn: () => void, ms: number) => {
      if (ms !== STATUS_INTERVAL_MS) return serviceTimers.setInterval(fn, Math.min(ms, 100));
      ticks.push(fn);
      return serviceTimers.setInterval(() => undefined, ms);
    },
  };
  return { timers, tick: () => ticks.forEach((fn) => fn()) };
}

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * A core whose item schema cannot load yet: a first run (nothing cached) with the network paused. The
 * feed and every connector but the schema are off, so unpausing fetches only the schema.
 */
async function setup(o: { folder: boolean; timers?: typeof serviceTimers }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-watch-gate-'));
  temps.push(root);
  const folder = path.join(root, 'saved');
  if (o.folder) mkdirSync(folder);
  const dataDir = path.join(root, 'data');
  let settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    networkPaused: true,
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    import: { enabled: true, acknowledgedAt: Date.now() - 60_000, watchFolder: folder },
  });
  const core = createServiceCore({
    dataDir,
    version: '0.7.1',
    settings,
    secrets: {},
    log: createLogger({ dataDir }),
    fetchImpl,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
    timers: o.timers ?? fastStatusTimers,
  });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const update = (p: DeepPartial<Settings>) => {
    settings = mergeSettings(settings, p);
    core.updateSettings(settings);
  };
  const watchRow = async () => (await call<HealthReport>('health.get')).connectors.find((c) => c.id === 'import-watch')!;
  const imports = () => pushes.filter((p) => p.event === 'import.done').map((p) => p.payload as ImportResult);
  return { root, folder, core, call, update, pushes, watchRow, imports };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the folder watch waits for the item schema (P3)', () => {
  it('starts no watcher while item data is loading, then starts on the next tick and imports the page saved meanwhile', async () => {
    const h = await setup({ folder: true });
    // Nothing loaded: no watcher, and every surface says why.
    expect(await h.call<ScraptfListStatus>('scraptf.listStatus')).toMatchObject({ importEnabled: true, watchFolder: h.folder, watchActive: false, watchError: WATCH_WAITING_FOR_SCHEMA });
    expect(await h.watchRow()).toMatchObject({ state: 'off', detail: WATCH_WAITING_FOR_SCHEMA });
    // A page saved now is not read: there is no watcher yet.
    writeFileSync(path.join(h.folder, 'Buy Hats - Scrap.TF.html'), HATS_HTML);
    await settle(1_500);
    expect(h.imports()).toEqual([]);
    expect(requested).toEqual([]);

    // The network comes back: the schema job loads the item data, and the status tick starts the watch.
    h.update({ networkPaused: false });
    const done = await waitFor('the catch-up import', () => h.imports()[0]);
    expect(done).toMatchObject({ fileName: 'Buy Hats - Scrap.TF.html', bank: 'hats' });
    expect(done.stored).toBeGreaterThan(0);
    expect(await h.call<ScraptfListStatus>('scraptf.listStatus')).toMatchObject({ watchActive: true, watchError: null });
    expect(await h.watchRow()).toMatchObject({ state: 'live' });
    // Imported with the item data: the stored prices carry names from it, not raw SKUs.
    const prices = await h.call<ScrapPrice[]>('prices.list');
    expect(prices.length).toBe(done.stored);
    expect(prices.every((p) => p.name !== p.sku)).toBe(true);
    // Only the item data was fetched, and only after the pause.
    expect(new Set(requested)).toEqual(new Set(['sku.pricedb.io/api/schema', 'sku.pricedb.io/api/paint/list']));
    expect(h.imports()).toHaveLength(1);
  }, 30_000);

  it('imports the pages saved meanwhile even when another import lands before the tick that starts it (DC-4)', async () => {
    const t = manualStatusTimers();
    const h = await setup({ folder: true, timers: t.timers });
    // Saved while the app could not read it (the item data is not loaded).
    writeFileSync(path.join(h.folder, 'Buy Hats - Scrap.TF.html'), HATS_HTML);
    h.update({ networkPaused: false });
    // The item data loads; before the next status tick the user picks a page by hand (or the window reads one).
    const picked = await waitFor('the item data', async () => {
      try {
        return await h.call<ImportResult>('import.html', { html: HATS_HTML, fileName: 'picked.html', mtimeMs: Date.now() });
      } catch (err) {
        if (String(err).includes('schema-loading')) return null;
        throw err;
      }
    });
    expect(picked.batchId).toBeGreaterThan(0);
    expect((await h.call<ScraptfListStatus>('scraptf.listStatus')).watchActive).toBe(false);
    // The tick starts the watch; its catch-up still reaches back to before that import.
    t.tick();
    await waitFor('the watch', async () => (await h.call<ScraptfListStatus>('scraptf.listStatus')).watchActive);
    await waitFor('the catch-up import', () => h.imports().some((r) => r.fileName === 'Buy Hats - Scrap.TF.html'), 8_000);
    expect(h.imports().map((r) => r.fileName).sort()).toEqual(['Buy Hats - Scrap.TF.html', 'picked.html']);
    expect(new Set(requested)).toEqual(new Set(['sku.pricedb.io/api/schema', 'sku.pricedb.io/api/paint/list']));
  }, 30_000);

  it('still says a missing folder is missing, whatever the item data', async () => {
    const h = await setup({ folder: false });
    expect(await h.call<ScraptfListStatus>('scraptf.listStatus')).toMatchObject({ watchActive: false, watchError: 'Folder not found' });
    expect(await h.watchRow()).toMatchObject({ state: 'off', detail: 'Folder not found' });
  });
});
