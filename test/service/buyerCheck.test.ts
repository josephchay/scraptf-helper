// F3 'buyer.check': a click-only backpack.tf users/info lookup on the
// 'bptf-users' budget, cached for an hour, refused without the token, while the
// API is off, while the network is paused or the host is blocked, and never
// rejecting for an expected failure.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_OFF_MESSAGE,
  BUYER_CHECK_CACHE_MAX,
  BUYER_CHECK_CACHE_MS,
  NO_TOKEN_MESSAGE,
  PAUSED_MESSAGE,
  createBuyerChecker,
  type BuyerCheckDeps,
} from '../../src/service/buyerCheck';
import { BptfCredentialError, BptfNotConfiguredError } from '../../src/service/connectors/bptfApi';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { HostBlockedError, HttpStatusError, HttpTimeoutError, NetworkPausedError, RateLimitedError } from '../../src/service/net';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { BuyerCheck, DeepPartial, Settings } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const TOKEN = 'tok_SECRET_buyer_0123456789';
const ID = '76561198000000002';
const OTHER = '76561198000000003';

type UsersResult = Map<string, { banned: boolean; name: string | null; banDetails?: string[] }>;

function harness(opts: { settings?: DeepPartial<Settings>; token?: string | null; answer?: (ids: string[]) => Promise<UsersResult> | UsersResult } = {}) {
  let now = T0;
  let settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { bptfApi: true }, ...opts.settings });
  let token: string | null = opts.token === undefined ? TOKEN : opts.token;
  const calls: { ids: string[]; opts: unknown }[] = [];
  const logLines: string[] = [];
  let answer =
    opts.answer ??
    ((ids: string[]): UsersResult =>
      new Map(ids.map((id) => [id, { banned: id === ID, name: `User ${id.slice(-2)}`, banDetails: id === ID ? ['backpack.tf: banned from the site'] : [] }])));
  const http = { paused: false, blocked: null as string | null, isPaused: () => http.paused, hostBlocked: (h: string) => (h === 'api.backpack.tf' ? http.blocked : null) };
  const deps: BuyerCheckDeps = {
    bptfApi: {
      usersInfo: async (ids, o) => {
        calls.push({ ids, opts: o });
        return answer(ids);
      },
    },
    http,
    clock: { now: () => now },
    log: { debug: () => {}, info: (m) => logLines.push(m), warn: (m) => logLines.push(m), error: (m) => logLines.push(m) },
    settings: () => settings,
    secret: (n) => (n === 'bptfAccessToken' ? token : null),
  };
  return {
    checker: createBuyerChecker(deps),
    calls,
    http,
    logLines,
    advance: (ms: number) => {
      now += ms;
    },
    setSettings: (p: DeepPartial<Settings>) => {
      settings = mergeSettings(settings, p);
    },
    setToken: (t: string | null) => {
      token = t;
    },
    setAnswer: (a: typeof answer) => {
      answer = a;
    },
  };
}

describe('createBuyerChecker', () => {
  it('looks the buyer up once, with user priority, and returns the ban lines', async () => {
    const h = harness();
    const r = await h.checker.check(ID);
    expect(r).toEqual<BuyerCheck>({
      steamid: ID,
      name: 'User 02',
      bptfBanned: true,
      banDetails: ['backpack.tf: banned from the site'],
      checkedAt: T0,
      cached: false,
      error: null,
    });
    expect(h.calls).toEqual([{ ids: [ID], opts: { priority: 'user' } }]);
    const clean = await h.checker.check(OTHER);
    expect(clean).toMatchObject({ bptfBanned: false, banDetails: [], error: null });
  });

  it('serves repeat clicks from memory for an hour, then asks again', async () => {
    const h = harness();
    await h.checker.check(ID);
    h.advance(BUYER_CHECK_CACHE_MS - 1);
    const again = await h.checker.check(ID);
    expect(again).toMatchObject({ cached: true, checkedAt: T0, bptfBanned: true });
    expect(h.calls).toHaveLength(1);
    // A caller mutating the answer does not change the cache.
    again.banDetails.push('tampered');
    expect((await h.checker.check(ID)).banDetails).toEqual(['backpack.tf: banned from the site']);
    h.advance(1);
    expect(await h.checker.check(ID)).toMatchObject({ cached: false, checkedAt: T0 + BUYER_CHECK_CACHE_MS });
    expect(h.calls).toHaveLength(2);
  });

  it('serves a cached answer while paused (no request), but makes no new lookup', async () => {
    const h = harness();
    await h.checker.check(ID);
    h.setSettings({ networkPaused: true });
    expect(await h.checker.check(ID)).toMatchObject({ cached: true, error: null });
    expect(await h.checker.check(OTHER)).toMatchObject({ steamid: OTHER, bptfBanned: null, error: PAUSED_MESSAGE, cached: false });
    h.setSettings({ networkPaused: false });
    h.http.paused = true;
    expect(await h.checker.check(OTHER)).toMatchObject({ error: PAUSED_MESSAGE });
    expect(h.calls).toHaveLength(1);
  });

  it('needs the token, the API switch and an unblocked host before any request', async () => {
    const h = harness({ token: null });
    expect(await h.checker.check(ID)).toEqual<BuyerCheck>({
      steamid: ID,
      name: null,
      bptfBanned: null,
      banDetails: [],
      checkedAt: T0,
      cached: false,
      error: NO_TOKEN_MESSAGE,
    });
    expect(NO_TOKEN_MESSAGE).toBe('Add a backpack.tf access token in Settings');
    h.setToken(TOKEN);
    h.setSettings({ connectors: { bptfApi: false } });
    expect((await h.checker.check(ID)).error).toBe(API_OFF_MESSAGE);
    h.setSettings({ connectors: { bptfApi: true } });
    h.http.blocked = 'challenge page';
    expect((await h.checker.check(ID)).error).toBe('backpack.tf requests are disabled: challenge page');
    expect(h.calls).toHaveLength(0);
  });

  it('never rejects: each failure becomes a plain message, and failures are not cached', async () => {
    const h = harness();
    const cases: [unknown, string | RegExp][] = [
      [new RateLimitedError('bptf-users', T0 + 12_400), 'backpack.tf user lookups are rate limited; try again in 13 s.'],
      [new NetworkPausedError(), PAUSED_MESSAGE],
      [new HostBlockedError('api.backpack.tf', 'challenge page'), 'backpack.tf requests are disabled: challenge page'],
      [new HttpStatusError(503, 'https://api.backpack.tf/api/users/info/v1', null), 'backpack.tf answered HTTP 503.'],
      [new HttpTimeoutError('https://api.backpack.tf/api/users/info/v1'), /did not answer in time/],
      [new BptfNotConfiguredError('Add your backpack.tf access token in Settings'), 'Add your backpack.tf access token in Settings'],
      [new BptfCredentialError('bptfAccessToken', 401, 'backpack.tf rejected the access token (HTTP 401). Check it in Settings.'), /rejected the access token/],
      [new Error(`socket hang up near token=${TOKEN}`), /^The ban check failed: socket hang up/],
      ['a string', 'The ban check failed: a string'],
    ];
    for (const [err, expected] of cases) {
      h.setAnswer(() => Promise.reject(err));
      const r = await h.checker.check(ID);
      expect(r).toMatchObject({ steamid: ID, bptfBanned: null, name: null, banDetails: [], cached: false });
      if (typeof expected === 'string') expect(r.error).toBe(expected);
      else expect(r.error).toMatch(expected);
      expect(r.error).not.toContain(TOKEN);
    }
    expect(h.calls).toHaveLength(cases.length);
    expect(h.logLines.join('\n')).not.toContain(TOKEN);
  });

  it('reports a buyer backpack.tf returned nothing for, without caching it', async () => {
    const h = harness({ answer: () => new Map() });
    expect((await h.checker.check(ID)).error).toBe('backpack.tf has no user data for this SteamID64.');
    expect((await h.checker.check(ID)).cached).toBe(false);
    expect(h.calls).toHaveLength(2);
  });

  it('shares one request between double clicks', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      answer: async (ids) => {
        await gate;
        return new Map(ids.map((id) => [id, { banned: false, name: 'x' }]));
      },
    });
    const a = h.checker.check(ID);
    const b = h.checker.check(ID);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.calls).toHaveLength(1);
    expect(ra).toEqual(rb);
    // banDetails absent from the connector reads as no bans.
    expect(ra.banDetails).toEqual([]);
  });

  it('refuses a malformed id without a request and bounds the cache', async () => {
    const h = harness();
    expect((await h.checker.check('123')).error).toMatch(/SteamID64/);
    expect(h.calls).toHaveLength(0);
    const ids = Array.from({ length: BUYER_CHECK_CACHE_MAX + 1 }, (_, i) => String(76561198000100000n + BigInt(i)));
    for (const id of ids) await h.checker.check(id);
    expect(h.calls).toHaveLength(ids.length);
    // The oldest answer was dropped; the newest is still served from memory.
    expect((await h.checker.check(ids[0]!)).cached).toBe(false);
    expect((await h.checker.check(ids.at(-1)!)).cached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End to end through the service core (real HttpClient, budgets and request log)
// ---------------------------------------------------------------------------

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const usersFixture = JSON.parse(readFileSync(path.join(FIX, 'bptf/users-info-v1.json'), 'utf8')) as { objectForm: unknown };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("'buyer.check' RPC", () => {
  it('sends one users/info request with the token in the header, then answers from memory', async () => {
    const usersCalls: { url: URL; headers: Headers }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
      if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
      if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
      if (u.hostname === 'api.backpack.tf' && u.pathname === '/api/users/info/v1') {
        usersCalls.push({ url: u, headers: new Headers(init?.headers) });
        return json(usersFixture.objectForm);
      }
      throw new TypeError(`fetch failed: the test refuses ${u.hostname}${u.pathname}`);
    }) as typeof fetch;
    const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-buyer-'));
    temps.push(root);
    const dataDir = path.join(root, 'data');
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      contactUrl: 'https://github.com/flipdesk-test',
      liveFeed: { enabled: false },
      connectors: { pricedb: false, pricedbSocket: false, bptfApi: true, scm: false },
    });
    const core = createServiceCore({
      dataDir,
      version: '0.1.0',
      settings,
      secrets: { bptfAccessToken: TOKEN },
      log: createLogger({ dataDir }),
      fetchImpl,
      wsFactory: (url, headers) => new FakeSocket(url, headers),
    });
    cores.push(core);
    await core.start();
    const call = (steamid: string) => core.handle('buyer.check', { steamid }) as Promise<BuyerCheck>;

    const first = await call(` ${ID} `);
    expect(first).toMatchObject({ steamid: ID, name: 'Site Banned', bptfBanned: true, cached: false, error: null });
    expect(first.banDetails).toEqual(['backpack.tf: banned from the site (permanent, Scamming)']);
    expect(usersCalls).toHaveLength(1);
    expect(usersCalls[0]!.url.searchParams.get('steamids')).toBe(ID);
    expect(usersCalls[0]!.url.searchParams.has('token')).toBe(false);
    expect(usersCalls[0]!.headers.get('x-auth-token')).toBe(TOKEN);

    expect(await call(ID)).toMatchObject({ cached: true, bptfBanned: true });
    expect(usersCalls).toHaveLength(1);

    core.updateSettings(mergeSettings(settings, { networkPaused: true }));
    expect(await call(OTHER)).toMatchObject({ error: PAUSED_MESSAGE, bptfBanned: null });
    expect(usersCalls).toHaveLength(1);

    const health = (await core.handle('health.get', undefined)) as { recentRequests: { host: string; path: string }[] };
    expect(JSON.stringify(health)).not.toContain(TOKEN);
    expect(health.recentRequests.some((r) => r.host === 'api.backpack.tf' && r.path.includes('/users/info/v1'))).toBe(true);
    await core.stop();
    cores.length = 0;
    expect(readFileSync(path.join(root, 'logs', 'service.log'), 'utf8')).not.toContain(TOKEN);
  });
});
