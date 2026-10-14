// A host disabled after a challenge page stays disabled across service
// restarts (crash restart, relaunch at login) until the user re-enables it
// with net.unblock (R7, brief §2.0: "Never retry automatically"). Real repo in
// a temp dir, real connectors and scheduler, fake fetch; nothing touches the
// network.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { Logger } from '../../src/service/contracts';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { HealthReport } from '../../src/shared/types';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = (rel: string): unknown => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8'));

const schemaSubset = load('pricedb/schema-subset.json');
const paintList = load('pricedb/paint-list.json');
const autob = load('pricedb/autob-items.json');
const itemKey = load('pricedb/item-key.json');
const currencies = load('bptf/igetcurrencies-v1.json');

const API_KEY = 'bptf-api-key-0123456789abcdef';
const CHALLENGE_REASON = /^challenge page \(cf-mitigated: challenge, HTTP 403\)/;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Serves the PriceDB fixtures; api.backpack.tf answers with a Cloudflare challenge while `challenged()` is true. */
function fakeFetch(challenged: () => boolean): { impl: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(u);
    const p = decodeURIComponent(u.pathname);
    if (u.hostname === 'api.backpack.tf') {
      if (challenged()) {
        return new Response('<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', {
          status: 403,
          headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html; charset=UTF-8' },
        });
      }
      if (p === '/api/IGetCurrencies/v1') return json(currencies);
      return json({ message: 'not in this test' }, 404);
    }
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

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const temps: string[] = [];
const cores: ServiceCore[] = [];

afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function launch(dataDir: string, fetchImpl: typeof fetch): { core: ServiceCore; health: () => Promise<HealthReport> } {
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedbSocket: false },
  });
  const core = createServiceCore({ dataDir, version: '0.1.0', settings, secrets: { bptfApiKey: API_KEY }, log: quiet, fetchImpl });
  cores.push(core);
  return { core, health: () => core.handle('health.get', undefined) as Promise<HealthReport> };
}

const bptfCalls = (calls: URL[]) => calls.filter((u) => u.hostname === 'api.backpack.tf');

describe('challenge blocks across restarts', () => {
  it('keeps the host disabled after a restart and only net.unblock re-enables it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-blocks-'));
    temps.push(root);
    const dataDir = path.join(root, 'data');
    let challenged = true;

    // Run 1: IGetCurrencies meets a challenge page and the host is disabled.
    const run1 = fakeFetch(() => challenged);
    const one = launch(dataDir, run1.impl);
    await one.core.start();
    const h1 = await waitFor('the challenge block', async () => {
      const h = await one.health();
      return (h.blockedHosts ?? []).some((b) => b.host === 'api.backpack.tf') ? h : null;
    });
    expect(bptfCalls(run1.calls).map((u) => u.pathname)).toEqual(['/api/IGetCurrencies/v1']);
    expect(h1.blockedHosts).toEqual([{ host: 'api.backpack.tf', reason: expect.stringMatching(CHALLENGE_REASON) }]);
    expect(h1.connectors.find((c) => c.id === 'bptf-currencies')).toMatchObject({ state: 'blocked', blockedHost: 'api.backpack.tf' });
    await one.core.stop();
    cores.splice(cores.indexOf(one.core), 1);

    // Run 2 (a crash restart or a relaunch at login): nothing goes to the challenged host.
    const run2 = fakeFetch(() => challenged);
    const two = launch(dataDir, run2.impl);
    await two.core.start();
    await waitFor('the PriceDB key price', async () => (await two.health()).keyPrice?.source === 'pricedb');
    // key-bptf is due on the first tick, together with key-pricedb; give it a few more ticks.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(bptfCalls(run2.calls)).toEqual([]);
    let h2 = await two.health();
    expect(h2.blockedHosts).toEqual([{ host: 'api.backpack.tf', reason: expect.stringMatching(CHALLENGE_REASON) }]);
    const currenciesHealth = h2.connectors.find((c) => c.id === 'bptf-currencies')!;
    expect(currenciesHealth).toMatchObject({ state: 'blocked', blockedHost: 'api.backpack.tf' });
    expect(currenciesHealth.disabledReason).toMatch(CHALLENGE_REASON);
    expect(h2.connectors.find((c) => c.id === 'pricedb')!.blockedHost).toBeUndefined();

    // Only the user clears it, and only for hosts the app contacts.
    await expect(two.core.handle('net.unblock', { host: 'evil.example' })).rejects.toThrow(/not a host this app contacts/);
    await expect(two.core.handle('net.unblock', { host: '' })).rejects.toThrow(/Invalid parameters for net\.unblock/);
    await expect(two.core.handle('net.unblock', undefined)).rejects.toThrow(/Invalid parameters for net\.unblock/);
    expect((await two.health()).blockedHosts).toHaveLength(1);

    challenged = false;
    await expect(two.core.handle('net.unblock', { host: ' API.Backpack.TF. ' })).resolves.toEqual({ ok: true });
    h2 = await two.health();
    expect(h2.blockedHosts).toEqual([]);
    expect(h2.connectors.find((c) => c.id === 'bptf-currencies')!.blockedHost).toBeUndefined();
    // key-bptf runs again: it either asks for the key price or is held by the
    // IGetCurrencies budget, which still counts run 1's request.
    await waitFor('key-bptf to run after re-enabling', async () => {
      if (bptfCalls(run2.calls).some((u) => u.pathname === '/api/IGetCurrencies/v1')) return true;
      return (await two.health()).connectors.find((c) => c.id === 'bptf-currencies')!.lastErrorAt !== null;
    });
    expect((await two.health()).connectors.find((c) => c.id === 'bptf-currencies')!.state).not.toBe('blocked');
    await two.core.stop();
    cores.splice(cores.indexOf(two.core), 1);

    // Run 3: the cleared block is not restored.
    const run3 = fakeFetch(() => challenged);
    const three = launch(dataDir, run3.impl);
    await three.core.start();
    const h3 = await three.health();
    expect(h3.blockedHosts).toEqual([]);
    expect(h3.connectors.find((c) => c.id === 'bptf-currencies')!.blockedHost).toBeUndefined();
  }, 60_000);

  it('net.unblock kicks the jobs of that host instead of waiting for their retry', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-blocks-'));
    temps.push(root);
    let challenged = true;
    const run = fakeFetch(() => challenged);
    const app = launch(path.join(root, 'data'), run.impl);
    await app.core.start();
    const blockedError = await waitFor('the challenge block', async () => {
      const c = (await app.health()).connectors.find((x) => x.id === 'bptf-currencies')!;
      return c.blockedHost === 'api.backpack.tf' && c.lastError ? c.lastError : null;
    });
    // key-bptf failed on the block; its next retry is 15 minutes away.
    challenged = false;
    await app.core.handle('net.unblock', { host: 'api.backpack.tf' });
    await waitFor('key-bptf to run again', async () => {
      if (bptfCalls(run.calls).length > 1) return true;
      const c = (await app.health()).connectors.find((x) => x.id === 'bptf-currencies')!;
      return c.lastError !== null && c.lastError !== blockedError;
    });
    expect((await app.health()).blockedHosts).toEqual([]);
  }, 30_000);
});
