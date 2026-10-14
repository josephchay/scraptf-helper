import { afterEach, describe, expect, it } from 'vitest';
import {
  BptfCredentialError,
  BptfNotConfiguredError,
  BptfSnapshotUnavailableError,
  CURRENCIES_URL,
  META_SNAPSHOT_UNAVAILABLE,
  META_TOKEN_METHOD,
  PRICES_URL,
  SNAPSHOT_CACHE_MS,
  SNAPSHOT_REPROBE_MS,
  SNAPSHOT_URL,
  USERS_URL,
  USERS_USER_MAX_WAIT_MS,
  USERS_USER_TIMEOUT_MS,
  alternateTheName,
  banDetailsFromBans,
  createBptfApi,
  credentialHint,
  isBannedFromBans,
} from '../../src/service/connectors/bptfApi';
import { BPTF_API_ACCESS_URL, isAllowedExternalUrl } from '../../src/shared/links';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { RateLimitedError } from '../../src/service/net';
import type { DeepPartial, SecretName, Settings } from '../../src/shared/types';
import { FakeHttp, createLogger, createStubSchema, jsonResponse, loadFixture, settingsWith, type HttpCall, type HttpHandler } from './helpers';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const TOKEN = 'tok_SECRET_0123456789abcdef';
const KEY = 'key_SECRET_fedcba9876543210';

interface SnapshotFixture {
  responses: Record<string, unknown>;
}
const snapshots = loadFixture<SnapshotFixture>('snapshot-responses.json').responses;
const prices = loadFixture('igetprices-v4.json');
const currencies = loadFixture<{ objectForm: unknown; failure: unknown }>('igetcurrencies-v1.json');
const users = loadFixture<{ objectForm: unknown; arrayForm: unknown }>('users-info-v1.json');

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function snapshotName(call: HttpCall): string | null {
  return new URL(call.fullUrl).searchParams.get('sku');
}

function usesHeader(call: HttpCall): boolean {
  return call.opts.headers?.['X-Auth-Token'] === TOKEN;
}

function usesQuery(call: HttpCall): boolean {
  return new URL(call.fullUrl).searchParams.get('token') === TOKEN;
}

function harness(
  opts: {
    handler?: HttpHandler;
    settings?: DeepPartial<Settings>;
    secrets?: Partial<Record<SecretName, string>>;
    repo?: Repo;
  } = {},
) {
  let now = T0;
  const repo = opts.repo ?? openRepo(':memory:');
  if (!opts.repo) repos.push(repo);
  const http = new FakeHttp(opts.handler);
  const log = createLogger();
  let secrets: Partial<Record<SecretName, string>> = opts.secrets ?? { bptfAccessToken: TOKEN, bptfApiKey: KEY };
  let settings = settingsWith(opts.settings);
  const api = createBptfApi({
    clock: { now: () => now },
    log,
    repo,
    http,
    settings: () => settings,
    secret: (n) => secrets[n] ?? null,
    schema: createStubSchema(),
  });
  return {
    api,
    http,
    log,
    repo,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    setSecrets: (s: Partial<Record<SecretName, string>>) => {
      secrets = s;
    },
    setSettings: (p: DeepPartial<Settings>) => {
      settings = settingsWith(p);
    },
  };
}

/** Serves the snapshot fixture by name; only the header method is accepted unless `queryOnly`. */
function snapshotHandler(opts: { queryOnly?: boolean; empty?: string[] } = {}): HttpHandler {
  return (call) => {
    if (call.url !== SNAPSHOT_URL) return { status: 404, data: null };
    const authed = opts.queryOnly ? usesQuery(call) : usesHeader(call) || usesQuery(call);
    if (!authed) return jsonResponse(401, { message: 'This access token is not valid.' });
    const name = snapshotName(call)!;
    if (opts.empty?.includes(name)) return jsonResponse(200, { id: null, appid: 440, sku: name, createdAt: 1791958000, listings: [] });
    const body = snapshots[name] ?? { id: null, appid: 440, sku: name, createdAt: 1791958000, listings: [] };
    return jsonResponse(200, body);
  };
}

function assertNoSecrets(h: ReturnType<typeof harness>, extra: unknown[] = []): void {
  const blob = [h.log.text(), JSON.stringify(h.api.health()), ...extra.map((x) => (x instanceof Error ? x.message : JSON.stringify(x)))].join('\n');
  expect(blob).not.toContain(TOKEN);
  expect(blob).not.toContain(KEY);
}

function readOnly(h: ReturnType<typeof harness>): void {
  for (const c of h.http.calls) {
    expect(c.opts.method ?? 'GET').toBe('GET');
    expect(c.url).not.toMatch(/\/agent\//);
    expect(c.url.startsWith('https://api.backpack.tf/api/')).toBe(true);
  }
}

describe('snapshot', () => {
  it('fetches by bp.tf name with the X-Auth-Token header and maps listings', async () => {
    const h = harness({ handler: snapshotHandler() });
    const r = await h.api.snapshot('154;11', 'user');
    expect(r.name).toBe('Strange Pain Train');
    expect(r.createdAt).toBe(1791958000);
    expect(r.listings).toHaveLength(4);
    expect(r.listings.every((l) => l.origin === 'snapshot' && l.lastEventAt === T0)).toBe(true);
    const call = h.http.calls[0]!;
    expect(call.opts).toMatchObject({ budget: 'bptf-snapshot', priority: 'user', secretHeaders: ['X-Auth-Token'] });
    expect(new URL(call.fullUrl).searchParams.get('appid')).toBe('440');
    expect(call.fullUrl).not.toContain(TOKEN);
    expect(h.repo.getMeta(META_TOKEN_METHOD)).toBe('header');
    expect(h.repo.getSnapshotAt('154;11')).toBe(T0);
    expect(h.api.health().find((x) => x.id === 'bptf-snapshot')).toMatchObject({ state: 'idle', lastOkAt: T0 });
    readOnly(h);
    assertNoSecrets(h);
  });

  it('falls back to ?token= when the header is refused, and remembers it', async () => {
    const h = harness({ handler: snapshotHandler({ queryOnly: true }) });
    const r = await h.api.snapshot('378;5;u13');
    expect(r.listings).toHaveLength(3);
    expect(h.http.calls.map((c) => (usesHeader(c) ? 'header' : usesQuery(c) ? 'query' : '?'))).toEqual(['header', 'query']);
    expect(h.http.calls[1]!.opts.secretQuery).toEqual(['token']);
    expect(h.repo.getMeta(META_TOKEN_METHOD)).toBe('query');
    await h.api.snapshot('154;11');
    expect(h.http.calls).toHaveLength(3);
    expect(usesQuery(h.http.calls[2]!)).toBe(true);
    assertNoSecrets(h);
  });

  it('uses the remembered method on a fresh instance', async () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.setMeta(META_TOKEN_METHOD, 'query');
    const h = harness({ handler: snapshotHandler({ queryOnly: true }), repo });
    await h.api.snapshot('154;11');
    expect(h.http.calls).toHaveLength(1);
    expect(usesQuery(h.http.calls[0]!)).toBe(true);
  });

  it('reports a rejected token, stops calling, and recovers when the token changes', async () => {
    const h = harness({ handler: () => jsonResponse(401, { message: 'This access token is not valid.' }) });
    const err = await h.api.snapshot('154;11').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BptfCredentialError);
    expect((err as BptfCredentialError).status).toBe(401);
    expect(h.http.calls).toHaveLength(2);
    const health = h.api.health().find((x) => x.id === 'bptf-snapshot')!;
    expect(health.state).toBe('blocked');
    expect(health.disabledReason).toMatch(/rejected the access token \(HTTP 401: This access token is not valid\.\)/);
    expect(h.api.health().find((x) => x.id === 'bptf-users')!.state).toBe('blocked');
    await expect(h.api.snapshot('378;5;u13')).rejects.toBeInstanceOf(BptfCredentialError);
    expect(h.http.calls).toHaveLength(2);
    assertNoSecrets(h, [err]);

    h.setSecrets({ bptfAccessToken: 'tok_NEW_abcdefabcdef1234', bptfApiKey: KEY });
    h.http.handler = (c) => (c.opts.headers?.['X-Auth-Token'] === 'tok_NEW_abcdefabcdef1234' ? jsonResponse(200, snapshots['Strange Pain Train']) : jsonResponse(401, {}));
    await expect(h.api.snapshot('154;11')).resolves.toMatchObject({ name: 'Strange Pain Train' });
    expect(h.api.health().find((x) => x.id === 'bptf-snapshot')!.state).toBe('idle');
  });

  it('retries once with "The " added or removed when the first name has no listings', async () => {
    const h = harness({ handler: snapshotHandler() });
    h.repo.upsertBptfNames([{ sku: '30920;5;u3010', name: 'The Mega Strike Taunt: The Bunnyhopper', marketName: null, lastSeen: 1 }]);
    const r = await h.api.snapshot('30920;5;u3010');
    expect(h.http.calls.map(snapshotName)).toEqual(['The Mega Strike Taunt: The Bunnyhopper', 'Mega Strike Taunt: The Bunnyhopper']);
    expect(r.name).toBe('Mega Strike Taunt: The Bunnyhopper');
    expect(r.listings[0]!.sku).toBe('30920;5;u3010');
    // a learned feed name is never overwritten
    expect(h.repo.getBptfName('30920;5;u3010')!.name).toBe('The Mega Strike Taunt: The Bunnyhopper');
  });

  it('learns the working "The" variant when the name came from the schema', async () => {
    const h = harness({
      handler: (c) => {
        const name = snapshotName(c);
        if (name === 'The Team Captain') return jsonResponse(200, { sku: 'The Team Captain', createdAt: 1791958000, listings: (snapshots['Burning Flames Team Captain'] as { listings: unknown[] }).listings.slice(0, 1) });
        return jsonResponse(200, { sku: name, listings: [] });
      },
    });
    const r = await h.api.snapshot('378;6');
    expect(h.http.calls.map(snapshotName)).toEqual(['Team Captain', 'The Team Captain']);
    expect(r.name).toBe('The Team Captain');
    expect(h.repo.getBptfName('378;6')!.name).toBe('The Team Captain');
    expect(alternateTheName('The Team Captain')).toBe('Team Captain');
    expect(alternateTheName('Team Captain')).toBe('The Team Captain');
    expect(alternateTheName('  ')).toBeNull();
  });

  it('returns empty results after both name variants come back empty', async () => {
    const h = harness({ handler: snapshotHandler({ empty: ['Strange Pain Train', 'The Strange Pain Train'] }) });
    const r = await h.api.snapshot('154;11');
    expect(r.listings).toEqual([]);
    expect(h.http.calls).toHaveLength(2);
  });

  it('prefers names learned from the feed, including for painted SKUs', async () => {
    const h = harness({ handler: snapshotHandler() });
    h.repo.upsertBptfNames([{ sku: '378;5;u13', name: 'Burning Flames Team Captain', marketName: 'Unusual Team Captain', lastSeen: 1 }]);
    const r = await h.api.snapshot('378;5;u13;p12073019');
    expect(snapshotName(h.http.calls[0]!)).toBe('Burning Flames Team Captain');
    expect(r.listings.find((l) => l.special.paint === 12073019)).toBeDefined();
  });

  it('never clears what the feed learned about a buyer (snapshot rows have no user object)', async () => {
    const h = harness({ handler: snapshotHandler() });
    const first = await h.api.snapshot('154;11');
    const order = first.listings.find((l) => l.intent === 'buy' && l.steamid === '76561198000000001')!;
    expect(order).toMatchObject({ userBanned: false, userName: null, userOnline: null });
    // The feed then reports the same order (same id) with a banned, online, named user.
    h.repo.upsertListings([{ ...order, origin: 'ws', userBanned: true, userOnline: true, userName: 'Flagged', marketName: 'Strange Pain Train' }]);

    const cached = await h.api.snapshot('154;11');
    expect(h.http.calls).toHaveLength(1);
    expect(cached.listings.find((l) => l.id === order.id)).toMatchObject({
      origin: 'snapshot',
      userBanned: true,
      userOnline: true,
      userName: 'Flagged',
      marketName: 'Strange Pain Train',
    });
    h.advance(SNAPSHOT_CACHE_MS);
    const fresh = await h.api.snapshot('154;11');
    expect(h.http.calls).toHaveLength(2);
    expect(fresh.listings.find((l) => l.id === order.id)).toMatchObject({ userBanned: true, userName: 'Flagged' });
    // What core stores keeps the flag; other rows are untouched.
    h.repo.upsertListings(fresh.listings);
    expect(h.repo.getListing(order.id)).toMatchObject({ userBanned: true, origin: 'snapshot' });
    expect(fresh.listings.filter((l) => l.id !== order.id).every((l) => !l.userBanned)).toBe(true);

    // A later feed update can still clear it.
    h.repo.upsertListings([{ ...order, origin: 'ws', userBanned: false }]);
    h.advance(SNAPSHOT_CACHE_MS);
    const after = await h.api.snapshot('154;11');
    expect(after.listings.find((l) => l.id === order.id)!.userBanned).toBe(false);
  });

  it('does not borrow user data from a stored row of another steamid', async () => {
    const h = harness({ handler: snapshotHandler() });
    const first = await h.api.snapshot('154;11');
    const order = first.listings.find((l) => l.intent === 'buy')!;
    h.repo.upsertListings([{ ...order, steamid: '76561198999999999', origin: 'ws', userBanned: true }]);
    const again = await h.api.snapshot('154;11');
    expect(again.listings.find((l) => l.id === order.id)!.userBanned).toBe(false);
  });

  it('maps Kit Fabricator orders onto the requested base SKU (od/oq)', async () => {
    const fabSku = '20003;6;kt-3;td-201;od-6526;oq-6';
    const fabName = 'Professional Killstreak Sniper Rifle Kit Fabricator';
    const h = harness({
      handler: (c) =>
        snapshotName(c) === fabName
          ? jsonResponse(200, {
              sku: fabName,
              createdAt: 1791958000,
              listings: [
                { steamid: '76561198682975206', intent: 'buy', currencies: { metal: 30 }, item: { defindex: 20003, quality: 6, attributes: [{ defindex: 2025, float_value: 3 }, { defindex: 2012, float_value: 201 }] } },
                { steamid: '76561198000000002', intent: 'buy', currencies: { metal: 29 }, item: { defindex: 20003, quality: 6 } },
              ],
            })
          : jsonResponse(200, { sku: snapshotName(c), listings: [] }),
    });
    h.repo.upsertBptfNames([{ sku: fabSku, name: fabName, marketName: null, lastSeen: 1 }]);
    const r = await h.api.snapshot(fabSku);
    expect(r.listings.map((l) => l.baseSku)).toEqual([fabSku, fabSku]);
    expect(r.listings[0]!.id).toBe('440_76561198682975206_f66c5795331781ea79dedd1d49c05026');
  });

  it('caches by name for 10 minutes and shares in-flight requests', async () => {
    const h = harness({ handler: snapshotHandler() });
    const [a, b] = await Promise.all([h.api.snapshot('154;11'), h.api.snapshot('154;11')]);
    expect(a).toBe(b);
    expect(h.http.calls).toHaveLength(1);
    h.advance(SNAPSHOT_CACHE_MS - 1);
    await h.api.snapshot('154;11');
    expect(h.http.calls).toHaveLength(1);
    h.advance(1);
    await h.api.snapshot('154;11');
    expect(h.http.calls).toHaveLength(2);
  });

  it('turns snapshots off on 404/410, persists it, and probes again after a day', async () => {
    const h = harness({ handler: () => jsonResponse(404, { message: 'Not Found' }) });
    await expect(h.api.snapshot('154;11')).rejects.toBeInstanceOf(BptfSnapshotUnavailableError);
    expect(h.api.snapshotAvailable()).toBe(false);
    expect(JSON.parse(h.repo.getMeta(META_SNAPSHOT_UNAVAILABLE)!)).toEqual({ status: 404, at: T0 });
    await expect(h.api.snapshot('378;5;u13')).rejects.toBeInstanceOf(BptfSnapshotUnavailableError);
    expect(h.http.calls).toHaveLength(1);
    const health = h.api.health().find((x) => x.id === 'bptf-snapshot')!;
    expect(health.state).toBe('blocked');
    expect(health.disabledReason).toMatch(/HTTP 404/);

    const again = harness({ handler: snapshotHandler(), repo: h.repo });
    expect(again.api.snapshotAvailable()).toBe(false);
    again.advance(SNAPSHOT_REPROBE_MS);
    expect(again.api.snapshotAvailable()).toBe(true);
    await again.api.snapshot('154;11');
    expect(again.repo.getMeta(META_SNAPSHOT_UNAVAILABLE)).toBe('');
    expect(again.api.snapshotAvailable()).toBe(true);
  });

  it('treats 410 the same way', async () => {
    const h = harness({ handler: () => jsonResponse(410, null) });
    await expect(h.api.snapshot('154;11')).rejects.toBeInstanceOf(BptfSnapshotUnavailableError);
    expect(h.api.snapshotAvailable()).toBe(false);
  });

  it('surfaces 429 as a rate limit and other statuses as errors', async () => {
    const h = harness({ handler: () => jsonResponse(429, { message: 'slow down' }) });
    h.http.next.set('bptf-snapshot', T0 + 30_000);
    const err = await h.api.snapshot('154;11').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAt).toBe(T0 + 30_000);
    expect(h.api.health().find((x) => x.id === 'bptf-snapshot')!.state).toBe('backoff');
    h.http.handler = () => jsonResponse(500, { message: 'oops' });
    h.advance(60_000);
    await expect(h.api.snapshot('378;5;u13')).rejects.toThrow('HTTP 500');
    expect(h.api.health().find((x) => x.id === 'bptf-snapshot')!.state).toBe('error');
    expect(h.api.snapshotAvailable()).toBe(true);
  });

  it('refuses unknown items, a disabled connector and a missing token without any request', async () => {
    const h = harness({ handler: snapshotHandler() });
    await expect(h.api.snapshot('99999;6')).rejects.toThrow(/No backpack.tf item name/);
    h.setSettings({ connectors: { bptfApi: false } });
    await expect(h.api.snapshot('154;11')).rejects.toBeInstanceOf(BptfNotConfiguredError);
    expect(h.api.health().every((x) => x.state === 'off')).toBe(true);
    h.setSettings({});
    h.setSecrets({});
    await expect(h.api.snapshot('154;11')).rejects.toBeInstanceOf(BptfNotConfiguredError);
    expect(h.api.health().find((x) => x.id === 'bptf-snapshot')).toMatchObject({ state: 'off', detail: 'Needs your backpack.tf access token' });
    expect(h.http.calls).toHaveLength(0);
  });

  it('reflects network pause and host blocks in health', () => {
    const h = harness();
    h.http.setPaused(true);
    expect(h.api.health().every((x) => x.state === 'paused')).toBe(true);
    h.http.setPaused(false);
    h.http.blocked.set('api.backpack.tf', 'challenge page');
    expect(h.api.health().every((x) => x.state === 'blocked' && x.disabledReason === 'challenge page')).toBe(true);
    expect(h.api.health().map((x) => x.id)).toEqual(['bptf-snapshot', 'bptf-prices', 'bptf-currencies', 'bptf-users']);
  });
});

describe('IGetPrices and IGetCurrencies', () => {
  it('requests prices with the key as a secret query parameter', async () => {
    const h = harness({ handler: (c) => (c.url === PRICES_URL ? jsonResponse(200, prices) : jsonResponse(404, null)) });
    const r = await h.api.prices(1791000000);
    expect(r.currentTime).toBe(1791958000);
    expect(r.rows.find((x) => x.sku === '378;5;u13')?.value).toBe(60);
    const call = h.http.calls[0]!;
    const q = new URL(call.fullUrl).searchParams;
    expect(q.get('key')).toBe(KEY);
    expect(q.get('raw')).toBe('1');
    expect(q.get('since')).toBe('1791000000');
    expect(call.opts).toMatchObject({ secretQuery: ['key'], budget: 'bptf-prices' });
    await h.api.prices(null);
    expect(new URL(h.http.calls[1]!.fullUrl).searchParams.has('since')).toBe(false);
    readOnly(h);
    assertNoSecrets(h);
  });

  it('disables the key family after a 403 and after a key error message', async () => {
    const h = harness({ handler: () => jsonResponse(403, { response: { success: 0, message: 'This API key is not valid.' } }) });
    const err = await h.api.prices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BptfCredentialError);
    expect(h.api.health().find((x) => x.id === 'bptf-prices')).toMatchObject({ state: 'blocked' });
    expect(h.api.health().find((x) => x.id === 'bptf-currencies')).toMatchObject({ state: 'blocked' });
    await expect(h.api.currencies()).rejects.toBeInstanceOf(BptfCredentialError);
    expect(h.http.calls).toHaveLength(1);
    assertNoSecrets(h, [err]);

    const h2 = harness({ handler: () => jsonResponse(200, currencies.failure) });
    await expect(h2.api.currencies()).rejects.toBeInstanceOf(BptfCredentialError);
  });

  it('maps rate-limit messages in a success:0 body to RateLimitedError', async () => {
    const h = harness({ handler: () => jsonResponse(200, { response: { success: 0, message: 'You can only request this page every 900 seconds.' } }) });
    const err = await h.api.prices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAt).toBeGreaterThanOrEqual(T0 + 15 * 60_000);
  });

  it('reads the key price', async () => {
    const h = harness({ handler: (c) => (c.url === CURRENCIES_URL ? jsonResponse(200, currencies.objectForm) : jsonResponse(404, null)) });
    await expect(h.api.currencies()).resolves.toEqual({ source: 'bptf', buyScrap: 582, sellScrap: 584, observedAt: T0 });
    expect(h.http.calls[0]!.opts).toMatchObject({ budget: 'bptf-currencies', secretQuery: ['key'] });
    h.http.handler = () => jsonResponse(200, { response: { success: 1, currencies: {} } });
    await expect(h.api.currencies()).resolves.toBeNull();
  });

  it('needs an API key', async () => {
    const h = harness({ secrets: { bptfAccessToken: TOKEN } });
    await expect(h.api.prices()).rejects.toBeInstanceOf(BptfNotConfiguredError);
    await expect(h.api.currencies()).rejects.toBeInstanceOf(BptfNotConfiguredError);
    expect(h.http.calls).toHaveLength(0);
  });
});

describe('users/info', () => {
  it('batches steamids, filters junk and reads both response forms', async () => {
    const h = harness({
      handler: (c) => {
        if (c.url !== USERS_URL) return jsonResponse(404, null);
        const ids = new URL(c.fullUrl).searchParams.get('steamids')!.split(',');
        return jsonResponse(200, ids.includes('76561198000000007') ? users.arrayForm : users.objectForm);
      },
    });
    const ids = Array.from({ length: 230 }, (_, i) => String(76561198000001000n + BigInt(i)));
    const r = await h.api.usersInfo(['76561198000000001', '76561198000000001', 'not-an-id', '123', ...ids, '76561198000000007']);
    expect(h.http.calls).toHaveLength(3);
    const sizes = h.http.calls.map((c) => new URL(c.fullUrl).searchParams.get('steamids')!.split(',').length);
    expect(sizes).toEqual([100, 100, 32]);
    expect(h.http.calls.every((c) => c.opts.budget === 'bptf-users')).toBe(true);
    // Background by default; only the drawer's click asks for priority 'user'.
    expect(h.http.calls.every((c) => c.opts.priority === 'background' && c.opts.maxWaitMs === undefined && c.opts.timeoutMs === undefined)).toBe(true);
    expect(r.get('76561198000000001')).toEqual({ banned: false, name: 'Clean Buyer', banDetails: [] });
    expect(r.get('76561198000000002')?.banned).toBe(true);
    expect(r.get('76561198000000003')?.banned).toBe(true);
    expect(r.get('76561198000000004')?.banned).toBe(true);
    expect(r.get('76561198000000005')?.banned).toBe(false);
    expect(r.get('76561198000000006')?.banned).toBe(false);
    expect(r.get('76561198000000007')).toEqual({ banned: false, name: 'Array User', banDetails: [] });
    expect(r.get('76561198000000002')?.banDetails).toEqual(['backpack.tf: banned from the site (permanent, Scamming)']);
    expect(r.get('76561198000000003')?.banDetails).toEqual(['SteamRep: marked as a scammer']);
    expect(r.get('76561198000000004')?.banDetails).toEqual(['Steam: trade banned']);
    // Shown for context, not counted as a ban.
    expect(r.get('76561198000000005')?.banDetails).toEqual(['Steam: VAC ban (does not block trading)']);
    expect(r.get('76561198000000006')?.banDetails).toEqual(['SteamRep: caution (not a ban)']);
    expect(r.get('76561198000000008')?.banDetails).toEqual(['backpack.tf: banned from the site (until 2027-01-15)']);
    expect(r.get('76561198000000008')?.banned).toBe(true);
    readOnly(h);
    assertNoSecrets(h);
  });

  it('returns an empty map without calling for no valid ids', async () => {
    const h = harness();
    expect((await h.api.usersInfo(['x', ''])).size).toBe(0);
    expect(h.http.calls).toHaveLength(0);
  });

  it('isBannedFromBans covers the documented flags', () => {
    expect(isBannedFromBans(undefined)).toBe(false);
    expect(isBannedFromBans([])).toBe(false);
    expect(isBannedFromBans([{ x: 1 }])).toBe(true);
    expect(isBannedFromBans({ all: { end: -1 } })).toBe(true);
    expect(isBannedFromBans({ steamrep_scammer: 1 })).toBe(true);
    expect(isBannedFromBans({ steamrep_scammer: 0, valve: { vac: 1 } })).toBe(false);
    expect(isBannedFromBans({ valve: { economy: 1 } })).toBe(true);
  });

  it('sends a user click ahead of background work and waits at most 15 s for the slot', async () => {
    const h = harness({ handler: (c) => (c.url === USERS_URL ? jsonResponse(200, users.objectForm) : jsonResponse(404, null)) });
    const r = await h.api.usersInfo(['76561198000000002'], { priority: 'user' });
    expect(h.http.calls).toHaveLength(1);
    expect(h.http.calls[0]!.opts).toMatchObject({ budget: 'bptf-users', priority: 'user', maxWaitMs: USERS_USER_MAX_WAIT_MS, timeoutMs: USERS_USER_TIMEOUT_MS });
    // Slot wait plus answer fits inside main's 30 s RPC timeout.
    expect(USERS_USER_MAX_WAIT_MS + USERS_USER_TIMEOUT_MS).toBeLessThan(30_000);
    expect(r.get('76561198000000002')).toMatchObject({ banned: true, name: 'Site Banned' });
    readOnly(h);
    assertNoSecrets(h);
  });

  it('turns a 429 into RateLimitedError and still needs the token and the API switch', async () => {
    const h = harness({ handler: () => jsonResponse(429, { message: 'slow down' }) });
    h.http.next.set('bptf-users', T0 + 30_000);
    await expect(h.api.usersInfo(['76561198000000002'], { priority: 'user' })).rejects.toBeInstanceOf(RateLimitedError);
    const noToken = harness({ secrets: { bptfApiKey: KEY } });
    await expect(noToken.api.usersInfo(['76561198000000002'], { priority: 'user' })).rejects.toBeInstanceOf(BptfNotConfiguredError);
    const off = harness({ settings: { connectors: { bptfApi: false } } });
    await expect(off.api.usersInfo(['76561198000000002'], { priority: 'user' })).rejects.toBeInstanceOf(BptfNotConfiguredError);
    expect(noToken.http.calls).toHaveLength(0);
    expect(off.http.calls).toHaveLength(0);
  });

  it('banDetailsFromBans lists counted bans first, then context, as plain short lines', () => {
    expect(banDetailsFromBans(undefined)).toEqual([]);
    expect(banDetailsFromBans({})).toEqual([]);
    expect(banDetailsFromBans([])).toEqual([]);
    expect(banDetailsFromBans({ steamrep_scammer: 0, valve: { vac: 0, economy: 0 } })).toEqual([]);
    expect(
      banDetailsFromBans({
        suggestions: { end: -1 },
        steamrep_caution: 1,
        valve: { economy: 1, community: 1, vac: 1 },
        marketplace: true,
        all: { end: 1800000000, reason: 'Scam\n\u0007attempt   reported' },
        steamrep_scammer: '1',
      }),
    ).toEqual([
      'backpack.tf: banned from the site (until 2027-01-15, Scam attempt reported)',
      'SteamRep: marked as a scammer',
      'marketplace.tf: banned',
      'Steam: trade banned',
      'SteamRep: caution (not a ban)',
      'Steam: community ban',
      'Steam: VAC ban (does not block trading)',
      'backpack.tf: suggestions ban (permanent)',
    ]);
    expect(banDetailsFromBans([{ type: 'classifieds', reason: 'x'.repeat(500) }, 'junk'])).toEqual([
      `backpack.tf: classifieds ban (${'x'.repeat(120)})`,
      'backpack.tf: banned',
    ]);
    // Keys that are not plain words are not echoed back.
    expect(banDetailsFromBans({ '<b>evil</b>': 1 })).toEqual([]);
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`ban_${String.fromCharCode(97 + (i % 26))}${'z'.repeat(1 + Math.floor(i / 26))}`, 1]));
    expect(banDetailsFromBans(many)).toHaveLength(12);
  });
});

describe('test()', () => {
  it('tests the access token with the header first and reports the method', async () => {
    const h = harness({ handler: snapshotHandler({ queryOnly: true }) });
    h.repo.setMeta(META_TOKEN_METHOD, 'query');
    const r = await h.api.test('bptfAccessToken');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/token query parameter/);
    expect(h.http.calls.map((c) => (usesHeader(c) ? 'header' : 'query'))).toEqual(['header', 'query']);
    expect(snapshotName(h.http.calls[0]!)).toBe('Mann Co. Supply Crate Key');
    expect(h.http.calls[0]!.opts).toMatchObject({ priority: 'user', maxWaitMs: 15_000 });
    expect(r.message).not.toContain(TOKEN);
  });

  it('reports a rejected token without leaking it, and a later good test clears the block', async () => {
    const h = harness({ handler: () => jsonResponse(401, { message: `This access token is not valid: ${TOKEN}` }) });
    const r = await h.api.test('bptfAccessToken');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected the access token/);
    expect(r.message).not.toContain(TOKEN);
    assertNoSecrets(h, [r]);
    h.http.handler = snapshotHandler();
    const r2 = await h.api.test('bptfAccessToken');
    expect(r2).toMatchObject({ ok: true });
    expect(r2.message).toMatch(/X-Auth-Token header/);
    expect(h.repo.getMeta(META_TOKEN_METHOD)).toBe('header');
  });

  it('tests the API key with IGetCurrencies', async () => {
    const h = harness({ handler: () => jsonResponse(200, currencies.objectForm) });
    const r = await h.api.test('bptfApiKey');
    expect(r).toEqual({ ok: true, message: 'API key works. Key price 64.66-64.88 ref.' });
    expect(h.http.calls[0]!.url).toBe(CURRENCIES_URL);
    expect(h.http.calls[0]!.opts).toMatchObject({ priority: 'user', maxWaitMs: 15_000 });
    h.http.handler = () => jsonResponse(403, { response: { success: 0, message: 'This API key is not valid.' } });
    const bad = await h.api.test('bptfApiKey');
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/rejected the API key \(HTTP 403/);
    // Says where the real key is, and that the token is a different value.
    expect(bad.message).toMatch(/next\.backpack\.tf\/account\/api-access.*not the access token/);
    assertNoSecrets(h, [bad]);
  });

  it('recognises a Steam Web API key pasted as the backpack.tf key, by shape only', () => {
    const steamLike = 'ABCDEF0123456789ABCDEF0123456789';
    expect(credentialHint('bptfApiKey', steamLike)).toMatch(/looks like a Steam Web API key/);
    expect(credentialHint('bptfApiKey', steamLike)).not.toContain(steamLike);
    expect(credentialHint('bptfAccessToken', steamLike)).toMatch(/access token is on https:\/\/next\.backpack\.tf\/account\/api-access/);
    expect(credentialHint('bptfApiKey', '5f0123456789abcdef012345')).toMatch(/register a key under "API Key"/);
    expect(credentialHint('bptfAccessToken', '5f0123456789abcdef012345')).toMatch(/"Reveal" under "Access Token"/);
    expect(isAllowedExternalUrl(BPTF_API_ACCESS_URL)).toBe(true);
  });

  it('does not queue behind the scheduled key-price call: answers from the last accepted call or gives the retry time', async () => {
    const h = harness({ handler: () => jsonResponse(200, currencies.objectForm) });
    h.http.next.set('bptf-currencies', h.now() + 4 * 60_000);
    const early = await h.api.test('bptfApiKey');
    expect(early.ok).toBe(false);
    expect(early.message).toMatch(/used recently .* Test again after/);
    expect(h.http.calls).toHaveLength(0);

    // The scheduled job's call succeeds with this key; a test right after it needs no request.
    h.http.next.delete('bptf-currencies');
    await h.api.currencies();
    h.http.next.set('bptf-currencies', h.now() + 5 * 60_000);
    h.advance(30_000);
    const r = await h.api.test('bptfApiKey');
    expect(r).toEqual({ ok: true, message: 'API key works: backpack.tf accepted it just now.' });
    expect(h.http.calls).toHaveLength(1);

    // A different key is not vouched for by the earlier call.
    h.setSecrets({ bptfAccessToken: TOKEN, bptfApiKey: 'another-api-key-0123456789' });
    expect((await h.api.test('bptfApiKey')).ok).toBe(false);
    expect(h.http.calls).toHaveLength(1);
  });

  it('works even when the connector is off, but not without a secret', async () => {
    const h = harness({ handler: () => jsonResponse(200, currencies.objectForm), settings: { connectors: { bptfApi: false } } });
    expect((await h.api.test('bptfApiKey')).ok).toBe(true);
    h.setSecrets({});
    expect(await h.api.test('bptfApiKey')).toEqual({ ok: false, message: 'No backpack.tf API key is set.' });
    expect(await h.api.test('bptfAccessToken')).toEqual({ ok: false, message: 'No backpack.tf access token is set.' });
  });

  it('explains a removed snapshot endpoint and network errors', async () => {
    const h = harness({ handler: () => jsonResponse(404, null) });
    const r = await h.api.test('bptfAccessToken');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/HTTP 404/);
    h.http.handler = () => {
      throw new Error(`socket hang up for https://api.backpack.tf/api/x?token=${TOKEN}`);
    };
    const r2 = await h.api.test('bptfApiKey');
    expect(r2.ok).toBe(false);
    expect(r2.message).not.toContain(TOKEN);
  });
});
