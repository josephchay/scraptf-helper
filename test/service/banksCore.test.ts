// F15 service wiring: 'scraptf.banks' is a registered method answering one summary per scrap.tf
// page in SCRAPTF_BANKS order plus the import switches, built from the saved pages, the engine's
// opportunities and the Live market as core's hooks invalidate it; writes reach the throttled
// 'scraptf.banksChanged' push, and the item drawer reads ItemDetail.seenOn from the batch bank joined
// into its prices. Runs the real core against a temp repo; only the schema host answers at start, and
// nothing here makes a request (scrap.tf never, R1).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { Repo } from '../../src/service/contracts';
import { DB_FILE_NAME, createServiceCore, serviceTimers, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import type { WatchFactory } from '../../src/service/import';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { PUSH_EVENTS, SERVICE_METHODS, type PushEvent } from '../../src/shared/rpc';
import type { DeepPartial, ItemDetail, Listing, MarketListResult, ScraptfBankSummary, ScraptfBanksResult, Settings } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

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

/** Real timers, but the 10 s status tick (which notices the folder watch dying) runs every 100 ms. */
const fastStatusTimers = { ...serviceTimers, setInterval: (fn: () => void, ms: number) => serviceTimers.setInterval(fn, Math.min(ms, 100)) };

/** An OS folder watch the test can fail. */
function fakeWatch(): { factory: WatchFactory; fail(err: Error): void } {
  let onError: ((err: Error) => void) | null = null;
  return {
    factory: () => ({
      close: () => undefined,
      on: (_event: 'error', fn: (err: Error) => void) => {
        onError = fn;
      },
    }),
    fail: (err) => onError?.(err),
  };
}

async function setup(seed: (repo: Repo) => void = () => undefined, patch: DeepPartial<Settings> = {}, o: { fastStatus?: boolean; watchFactory?: WatchFactory } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-banks-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  seed(repo);
  repo.close();
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    ...patch,
  });
  const core = createServiceCore({
    dataDir,
    version: '0.5.0',
    settings,
    secrets: {},
    log: createLogger({ dataDir }),
    fetchImpl,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
    ...(o.fastStatus ? { timers: fastStatusTimers } : {}),
    ...(o.watchFactory ? { watchFactory: o.watchFactory } : {}),
  });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  return { core, call, pushes, root };
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("'scraptf.banks'", () => {
  it('is a registered service method answering every bank in SCRAPTF_BANKS order', async () => {
    expect(SERVICE_METHODS).toContain('scraptf.banks');
    const h = await setup();
    for (const params of [undefined, null, {}]) {
      const r = await h.call<ScraptfBanksResult>('scraptf.banks', params);
      expect(r.banks.map((b) => [b.bank, b.label, b.url])).toEqual(SCRAPTF_BANKS.map((b) => [b.bank, b.label, b.url]));
      expect(r).toMatchObject({ importEnabled: false, watchActive: false });
      expect(Math.abs(r.generatedAt - Date.now())).toBeLessThan(60_000);
    }
    await expect(h.call('scraptf.banks', { force: true })).rejects.toThrow(/Invalid parameters for scraptf\.banks/);
    expect(requested).toEqual([]);
  });

  it('reports the import switches and a running folder watch', async () => {
    const watch = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-banks-watch-'));
    temps.push(watch);
    const h = await setup(undefined, { import: { enabled: true, acknowledgedAt: NOW - MIN, watchFolder: watch } });
    expect(await h.call<ScraptfBanksResult>('scraptf.banks')).toMatchObject({ importEnabled: true, watchActive: true });
  });
});

describe("'scraptf.banksChanged'", () => {
  it('is a push event, sent after a price write (throttled, not per call)', async () => {
    expect(PUSH_EVENTS).toContain('scraptf.banksChanged');
    const h = await setup();
    h.pushes.length = 0;
    await h.call('prices.upsert', { sku: '378;6', costScrap: 30 });
    await h.call('prices.upsert', { sku: '126;6', costScrap: 40 });
    await settle();
    const banks = h.pushes.filter((p) => p.event === 'scraptf.banksChanged');
    // Both writes fall in one 2 s window: one push.
    expect(banks).toHaveLength(1);
    expect(banks[0]!.payload).toEqual({ at: expect.any(Number) });
    expect(requested).toEqual([]);
  });
});

describe('ItemDetail.seenOn', () => {
  it('is the bank of the newest imported price, joined from its batch', async () => {
    const h = await setup((repo) => {
      const stranges = repo.createImportBatch({ fileName: 'Stranges.html', pageKind: 'buy', fileMtime: NOW - 20 * MIN, importedAt: NOW - 20 * MIN, itemCount: 1, bank: 'stranges' });
      const old = repo.createImportBatch({ fileName: 'old.html', pageKind: 'buy', fileMtime: NOW - 90 * MIN, importedAt: NOW - 90 * MIN, itemCount: 1 });
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 30, source: 'import', observedAt: NOW - 20 * MIN, importBatch: stranges, stock: 1 });
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 31, source: 'import', observedAt: NOW - 90 * MIN, importBatch: old, stock: 1 });
      // A newer typed price never counts as seen on scrap.tf.
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 29, source: 'user', observedAt: NOW - MIN });
      repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 40, source: 'user', observedAt: NOW - MIN });
    });
    const d = (await h.call<ItemDetail | null>('item.detail', { sku: '378;6', history: false }))!;
    expect(d.seenOn).toEqual({ bank: 'stranges', url: 'https://scrap.tf/buy/stranges', at: NOW - 20 * MIN });
    expect(d.scrapPrices.map((p) => p.bank)).toEqual([null, 'stranges', null]);
    expect((await h.call<ItemDetail | null>('item.detail', { sku: '126;6', history: false }))!.seenOn).toBeNull();
    expect(requested).toEqual([]);
  });
});

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(100);
  }
}

let seq = 0;
/** Fresh buy orders from distinct buyers, stored before the core starts (the feed is off). */
function buyers(sku: string, scrap: number, n = 3): Listing[] {
  return Array.from({ length: n }, () => {
    seq++;
    return makeListing({ id: `core${seq}`, sku, baseSku: sku, steamid: `7656119800099${String(seq).padStart(4, '0')}`, metalScrap: scrap, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - 60 * MIN) / 1000) });
  });
}

describe('per-bank summary in the core', () => {
  it("shows a saved hats page, its flip from the engine and what else to look for there from the market", async () => {
    const h = await setup((repo) => {
      repo.upsertListings([...buyers('378;6', 300), ...buyers('126;6', 250)]);
      const hats = repo.createImportBatch({ fileName: 'Buy Hats.html', pageKind: 'buy', fileMtime: NOW - 4 * MIN, importedAt: NOW - 4 * MIN, itemCount: 1, categories: { hats: 1 }, bank: 'hats' });
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 30, source: 'import', observedAt: NOW - 4 * MIN, importBatch: hats, stock: 2 });
      // A 0.4 page (no bank): filed by what it stored, as the coverage strip does.
      const old = repo.createImportBatch({ fileName: 'old.html', pageKind: 'buy', fileMtime: NOW - 90 * MIN, importedAt: NOW - 90 * MIN, itemCount: 1, categories: { weapons: 1 } });
      repo.upsertScrapPrice({ sku: '45;6', name: 'Force-A-Nature', costScrap: 3, source: 'import', observedAt: NOW - 90 * MIN, importBatch: old, stock: 1 });
    });
    const card = (r: ScraptfBanksResult, bank: string): ScraptfBankSummary => r.banks.find((b) => b.bank === bank)!;
    const r = await waitFor('the flip and the market rows', async () => {
      const s = await h.call<ScraptfBanksResult>('scraptf.banks');
      const hats = card(s, 'hats');
      return hats.flips > 0 && hats.lookFor.length > 0 ? s : null;
    });
    expect(card(r, 'hats')).toMatchObject({
      label: 'Hats',
      url: 'https://scrap.tf/buy/hats',
      lastSavedAt: NOW - 4 * MIN,
      pages: 1,
      items: 1,
      inStock: 1,
      flips: 1,
      top: [{ sku: '378;6', name: 'Team Captain', costScrap: 30 }],
      unchecked: 1,
      lookFor: [{ sku: '126;6' }],
    });
    expect(card(r, 'hats').flipProfitScrap).toBeGreaterThan(0);
    expect(card(r, 'weapons')).toMatchObject({ lastSavedAt: NOW - 90 * MIN, pages: 1, items: 1 });
    for (const bank of ['stranges', 'killstreaks', 'skins', 'items', 'unusuals', 'list']) expect(card(r, bank)).toMatchObject({ lastSavedAt: null, flips: 0 });
    // The Live market's strip dates the bank pages alike.
    const m = await h.call<MarketListResult>('market.list', { limit: 1 });
    expect(m.scraptf.coverage.find((c) => c.label === 'Hats')!.lastSavedAt).toBe(NOW - 4 * MIN);
    expect(m.scraptf.coverage.find((c) => c.label === 'Weapons')!.lastSavedAt).toBe(NOW - 90 * MIN);
    // The engine's and the market's changes were told.
    expect(h.pushes.some((p) => p.event === 'scraptf.banksChanged')).toBe(true);
    expect(requested).toEqual([]);

    // A typed price checks the 126 hat: gone from what to look for at once (prices.changed hook).
    await h.call('prices.upsert', { sku: '126;6', costScrap: 40 });
    expect(card(await h.call<ScraptfBanksResult>('scraptf.banks'), 'hats')).toMatchObject({ unchecked: 0, lookFor: [] });
  });

  it('pushes when the import switches change', async () => {
    const h = await setup();
    h.pushes.length = 0;
    h.core.updateSettings(mergeSettings(DEFAULT_SETTINGS, { contactUrl: 'https://github.com/flipdesk-test', liveFeed: { enabled: false }, connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false }, import: { enabled: true, acknowledgedAt: NOW - MIN } }));
    // Within one push window (2 s), whatever start-up pushed before.
    await waitFor('the push', async () => h.pushes.some((p) => p.event === 'scraptf.banksChanged'), 3_000);
    expect(await h.call<ScraptfBanksResult>('scraptf.banks')).toMatchObject({ importEnabled: true, watchActive: false });
    expect(requested).toEqual([]);
  });

  it('pushes when the folder watch dies between settings changes (the status tick notices)', async () => {
    const fw = fakeWatch();
    const folder = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-banks-watch-'));
    temps.push(folder);
    const h = await setup(undefined, { import: { enabled: true, acknowledgedAt: NOW - MIN, watchFolder: folder } }, { fastStatus: true, watchFactory: fw.factory });
    expect(await h.call<ScraptfBanksResult>('scraptf.banks')).toMatchObject({ importEnabled: true, watchActive: true });
    // Past any start-up push window, then quiet.
    await settle(2_200);
    h.pushes.length = 0;
    await settle(300);
    expect(h.pushes.filter((p) => p.event === 'scraptf.banksChanged')).toEqual([]);

    fw.fail(new Error('EPERM: operation not permitted, watch'));
    await waitFor('the push', async () => h.pushes.some((p) => p.event === 'scraptf.banksChanged'), 3_000);
    expect(await h.call<ScraptfBanksResult>('scraptf.banks')).toMatchObject({ importEnabled: true, watchActive: false });
  }, 20_000);
});
