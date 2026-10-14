import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../../src/service/contracts';
import { BUDGETS } from '../../src/service/net/budgets';
import {
  ForbiddenHostError,
  HostBlockedError,
  HttpStatusError,
  HttpTimeoutError,
  NetworkPausedError,
  RateLimitedError,
} from '../../src/service/net/errors';
import {
  ERROR_TEXT_LIMIT,
  NetworkRequestError,
  assertHonestUserAgent,
  buildUserAgent,
  createHttpClient,
  isBrowserLikeUserAgent,
  parseHostBlocks,
  parseRateLimit,
  parseRetryAfter,
  retryDelayFromResponse,
  type CreateHttpClientOptions,
} from '../../src/service/net/http';
import { SecretRegistry } from '../../src/service/net/redact';
import {
  FakeTime,
  MemorySink,
  RecordingLogger,
  T0,
  createFakeFetch,
  flush,
  hang,
  jsonResponse,
  redirectResponse,
  textResponse,
  type FetchHandler,
} from './helpers';

const UA = buildUserAgent('0.1.0', 'https://example.invalid/contact');
const HOUR = 3_600_000;

const PRICEDB = 'https://pricedb.io/api/item/5021;6';
const SNAPSHOT = 'https://api.backpack.tf/api/classifieds/listings/snapshot';
const CURRENCIES = 'https://api.backpack.tf/api/IGetCurrencies/v1';
const BPTF_MISC = 'https://api.backpack.tf/api/notifications';

function setup(handler: FetchHandler, over: Partial<CreateHttpClientOptions> = {}) {
  const time = new FakeTime();
  const { fetch, calls } = createFakeFetch(handler, time);
  const sink = new MemorySink();
  const log = new RecordingLogger();
  const secrets = new SecretRegistry();
  const client: HttpClient = createHttpClient({
    clock: time,
    timers: time,
    log,
    sink,
    userAgent: () => UA,
    fetchImpl: fetch,
    secrets,
    ...over,
  });
  return { time, calls, sink, log, client, secrets };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ok = () => jsonResponse({ ok: true });

describe('policy is enforced first', () => {
  it.each([
    'https://scrap.tf/buy/hats',
    'https://scrap.tf/ajax/raffles/Paginate',
    'https://backpack.tf/classifieds?item=Team%20Captain',
    'https://marketplace.tf/items/tf2/5021;6',
    'https://stntrading.eu/item/tf2/x',
    'https://mannco.store/item/440-x',
    'https://api.backpack.tf/api/agent/pulse',
    'http://api.backpack.tf/api/IGetPrices/v4',
  ])('never fetches %s', async (url) => {
    const { client, calls, sink } = setup(ok);
    await expect(client.request(url)).rejects.toBeInstanceOf(ForbiddenHostError);
    expect(calls).toHaveLength(0);
    expect(sink.rows).toHaveLength(0);
  });

  it('rejects forbidden URLs even while paused and before any budget logic', async () => {
    const { client, calls } = setup(ok);
    client.setPaused(true);
    await expect(client.request('https://scrap.tf/')).rejects.toBeInstanceOf(ForbiddenHostError);
    await expect(client.request('https://scrap.tf/', { budget: 'no-such-budget' })).rejects.toBeInstanceOf(ForbiddenHostError);
    expect(calls).toHaveLength(0);
  });

  it('applies method rules', async () => {
    const { client, calls } = setup(ok);
    await expect(client.request(PRICEDB, { method: 'POST', json: { skus: [] } })).rejects.toBeInstanceOf(ForbiddenHostError);
    await expect(
      client.request('https://api.backpack.tf/api/v2/classifieds/listings', { method: 'POST', json: {} }),
    ).rejects.toBeInstanceOf(ForbiddenHostError);
    await expect(client.request(PRICEDB, { method: 'DELETE' as 'GET' })).rejects.toBeInstanceOf(ForbiddenHostError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a JSON body on GET', async () => {
    const { client, calls } = setup(ok);
    await expect(client.request(PRICEDB, { json: { a: 1 } })).rejects.toThrow(/POST/);
    expect(calls).toHaveLength(0);
  });

  it('rejects unknown explicit budgets', async () => {
    const { client, calls } = setup(ok);
    await expect(client.request(PRICEDB, { budget: 'nope' })).rejects.toThrow(/Unknown budget/);
    expect(calls).toHaveLength(0);
  });
});

describe('network pause', () => {
  it('throws NetworkPausedError without fetching, until resumed', async () => {
    const { client, calls } = setup(ok);
    client.setPaused(true);
    expect(client.isPaused()).toBe(true);
    await expect(client.request(PRICEDB)).rejects.toBeInstanceOf(NetworkPausedError);
    expect(calls).toHaveLength(0);
    client.setPaused(false);
    expect((await client.request(PRICEDB)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('aborts in-flight requests and rejects queued ones', async () => {
    const { client, sink } = setup(() => hang());
    const inFlight = client.request(SNAPSHOT).catch((e: unknown) => e);
    await flush();
    const queued = client.request(SNAPSHOT).catch((e: unknown) => e);
    await flush();
    client.setPaused(true);
    expect(await inFlight).toBeInstanceOf(NetworkPausedError);
    expect(await queued).toBeInstanceOf(NetworkPausedError);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({ status: 0, note: 'aborted: network paused' });
  });
});

describe('request headers', () => {
  it('sends the honest UA, Accept and X-App-Context for backpack.tf', async () => {
    const { client, calls } = setup(ok);
    await client.request(CURRENCIES, {
      query: { raw: 1, key: 'k', skipped: null, alsoSkipped: undefined },
      secretQuery: ['key'],
      ifNoneMatch: '"etag-1"',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
        Cookie: 'sid=1',
        Host: 'scrap.tf',
        'X-Forwarded-For': '1.2.3.4',
        'Proxy-Authorization': 'x',
        'X-App-Context': '999',
        'X-Custom': 'kept',
      },
    });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://api.backpack.tf/api/IGetCurrencies/v1?raw=1&key=k');
    expect(c.redirect).toBe('manual');
    expect(c.headers).toEqual({
      'user-agent': UA,
      accept: 'application/json',
      'x-app-context': '440',
      'if-none-match': '"etag-1"',
      'x-custom': 'kept',
    });
  });

  it('honours an If-None-Match header unless ifNoneMatch overrides it', async () => {
    const { client, calls } = setup(ok);
    await client.request(PRICEDB, { headers: { 'If-None-Match': '"h"' } });
    await client.request('https://sku.pricedb.io/api/schema', { headers: { 'If-None-Match': '"h"' }, ifNoneMatch: '"o"' });
    expect(calls[0]!.headers['if-none-match']).toBe('"h"');
    expect(calls[1]!.headers['if-none-match']).toBe('"o"');
  });

  it('does not send X-App-Context to other hosts', async () => {
    const { client, calls } = setup(ok);
    await client.request(PRICEDB);
    expect(calls[0]!.headers['x-app-context']).toBeUndefined();
    expect(calls[0]!.headers['user-agent']).toBe(UA);
  });

  it('requests the canonical host when given a trailing dot or upper case', async () => {
    const { client, calls } = setup(ok);
    await client.request('https://PRICEDB.IO./api/item/5021;6#frag');
    expect(calls[0]!.url).toBe('https://pricedb.io/api/item/5021;6');
  });

  it('POSTs JSON to items-bulk', async () => {
    const { client, calls } = setup(() => jsonResponse([]));
    await client.request('https://pricedb.io/api/items-bulk', { method: 'POST', json: { skus: ['5021;6'] } });
    expect(calls[0]).toMatchObject({ method: 'POST', body: '{"skus":["5021;6"]}' });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });
});

describe('User-Agent', () => {
  it('buildUserAgent formats and sanitises', () => {
    expect(buildUserAgent('0.1.0', 'https://example.invalid/me')).toBe('TF2FlipDesk/0.1.0 (+https://example.invalid/me)');
    expect(buildUserAgent('0.1.0', '')).toBe('TF2FlipDesk/0.1.0 (+no-contact-set)');
    expect(buildUserAgent('0.1.0', '   ')).toBe('TF2FlipDesk/0.1.0 (+no-contact-set)');
    expect(buildUserAgent('', 'x')).toBe('TF2FlipDesk/0.0.0 (+x)');
    expect(buildUserAgent('0.1.0', 'evil)\r\nX-Injected: 1 (é')).toBe('TF2FlipDesk/0.1.0 (+evilX-Injected: 1)');
    expect(isBrowserLikeUserAgent(buildUserAgent('0.1.0', 'https://mozilla.org/me'))).toBe(false);
  });

  it.each([
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36',
    'Mozilla/5.0',
    '  mozilla',
    'TF2FlipDesk/0.1.0 Chrome/120.0',
    'TF2FlipDesk/0.1.0 Electron/44.5.0',
    'Something (like Gecko)',
    'Opera/9.80',
  ])('rejects browser-like UA %j', (ua) => {
    expect(isBrowserLikeUserAgent(ua)).toBe(true);
    expect(() => assertHonestUserAgent(ua)).toThrow(/browser-like/);
  });

  it('rejects empty and non-ASCII UAs', () => {
    expect(() => assertHonestUserAgent('')).toThrow(/empty/);
    expect(() => assertHonestUserAgent(undefined)).toThrow(/empty/);
    expect(() => assertHonestUserAgent('TF2FlipDesk/0.1.0 (+é)')).toThrow(/ASCII/);
  });

  it('the client never sends a browser-like UA', async () => {
    let ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    const { client, calls } = setup(ok, { userAgent: () => ua });
    await expect(client.request(PRICEDB)).rejects.toThrow(/browser-like/);
    expect(() => client.userAgent()).toThrow(/browser-like/);
    expect(calls).toHaveLength(0);
    ua = UA;
    expect(client.userAgent()).toBe(UA);
    await client.request(PRICEDB);
    expect(calls[0]!.headers['user-agent']).toBe(UA);
  });
});

describe('timeouts and network errors', () => {
  it('times out after timeoutMs with HttpTimeoutError and a status-0 log row', async () => {
    const { client, time, sink } = setup(() => hang());
    const p = client.request(PRICEDB, { timeoutMs: 5_000 }).catch((e: unknown) => e);
    await time.advance(4_999);
    expect(sink.rows).toHaveLength(0);
    await time.advance(1);
    const err = await p;
    expect(err).toBeInstanceOf(HttpTimeoutError);
    expect((err as HttpTimeoutError).url).toBe(PRICEDB);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({ host: 'pricedb.io', status: 0, method: 'GET', note: 'timeout after 5 s' });
  });

  it('defaults to a 20 s timeout', async () => {
    const { client, time } = setup(() => hang());
    const p = client.request(PRICEDB).catch((e: unknown) => e);
    await time.advance(19_999);
    await time.advance(1);
    expect(await p).toBeInstanceOf(HttpTimeoutError);
  });

  it('maps network failures to NetworkRequestError and logs status 0', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND pricedb.io'), { code: 'ENOTFOUND' });
    const { client, sink } = setup(() => {
      throw new TypeError('fetch failed', { cause });
    });
    const err = await client.request(PRICEDB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkRequestError);
    expect((err as NetworkRequestError).code).toBe('ENOTFOUND');
    expect(sink.rows[0]).toMatchObject({ status: 0, bytes: 0 });
    expect(sink.rows[0]!.note).toMatch(/^network error: fetch failed: getaddrinfo ENOTFOUND/);
  });

  it('passes a caller abort through', async () => {
    const { client, sink } = setup(() => hang());
    const ac = new AbortController();
    const p = client.request(PRICEDB, { signal: ac.signal }).catch((e: unknown) => e);
    await flush();
    ac.abort(new Error('user closed the panel'));
    expect(((await p) as Error).message).toBe('user closed the panel');
    expect(sink.rows[0]!.note).toBe('aborted by caller');
  });

  it('refuses absurdly large declared bodies', async () => {
    const { client } = setup(() => textResponse('{}', { headers: { 'content-length': String(10 * 1024 * 1024 * 1024) } }));
    const err = await client.request(PRICEDB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkRequestError);
    expect((err as Error).message).toMatch(/too large/);
  });
});

describe('redirects', () => {
  it('blocks a redirect to scrap.tf (sku.pricedb.io images)', async () => {
    const { client, calls, sink, log } = setup(() => redirectResponse('https://scrap.tf/img/items/warpaint/x.png'));
    const err = await client.request('https://sku.pricedb.io/api/sku/5021;6/image', { expectJson: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenHostError);
    expect((err as ForbiddenHostError).reason).toMatch(/R1/);
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.url.includes('scrap.tf'))).toBe(true);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({ host: 'sku.pricedb.io', status: 302 });
    expect(sink.rows[0]!.note).toMatch(/^redirect blocked: scrap\.tf/);
    expect(log.calls.some((c) => c.level === 'warn' && /redirect/.test(c.msg))).toBe(true);
  });

  it.each([
    'https://steamcdn-a.akamaihd.net/apps/440/icons/x.png',
    'http://sku.pricedb.io/api/sku/x',
    'https://forum.scrap.tf/',
    'https://backpack.tf/classifieds',
    'https://scrap.tf.:443/',
  ])('blocks a redirect to %s', async (location) => {
    const { client, calls } = setup(() => redirectResponse(location, 301));
    await expect(client.request('https://sku.pricedb.io/api/sku/5021;6/image')).rejects.toBeInstanceOf(ForbiddenHostError);
    expect(calls).toHaveLength(1);
  });

  it('follows allowed redirects, logging each hop', async () => {
    const { client, calls, sink } = setup((c) => {
      if (c.url.endsWith('/a')) return redirectResponse('/api/b', 301);
      if (c.url.endsWith('/api/b')) return redirectResponse('https://pricedb.io/api/c', 307);
      return jsonResponse({ done: true });
    });
    const res = await client.request<{ done: boolean }>('https://pricedb.io/api/a');
    expect(res.data).toEqual({ done: true });
    expect(calls.map((c) => c.url)).toEqual(['https://pricedb.io/api/a', 'https://pricedb.io/api/b', 'https://pricedb.io/api/c']);
    expect(sink.rows.map((r) => [r.path, r.status, r.note])).toEqual([
      ['/api/a', 301, 'redirect -> pricedb.io/api/b'],
      ['/api/b', 307, 'redirect -> pricedb.io/api/c'],
      ['/api/c', 200, null],
    ]);
  });

  it('follows at most 3 redirects', async () => {
    let n = 0;
    const { client, calls } = setup(() => redirectResponse(`/api/r${++n}`));
    const err = await client.request('https://pricedb.io/api/r0').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(calls).toHaveLength(4);
  });

  it('switches POST to GET on 303 and keeps it on 307', async () => {
    const { client, calls } = setup((c) => (c.url.endsWith('items-bulk') ? redirectResponse('/api/item/5021;6', 303) : ok()));
    await client.request('https://pricedb.io/api/items-bulk', { method: 'POST', json: { skus: [] } });
    expect(calls[1]).toMatchObject({ method: 'GET', body: null });
    expect(calls[1]!.headers['content-type']).toBeUndefined();

    const second = setup((c) => (c.url.endsWith('items-bulk') ? redirectResponse('/api/item/5021;6', 307) : ok()));
    // A 307 would re-POST to a path where POST is not allowed.
    await expect(
      second.client.request('https://pricedb.io/api/items-bulk', { method: 'POST', json: { skus: [] } }),
    ).rejects.toBeInstanceOf(ForbiddenHostError);
    expect(second.calls).toHaveLength(1);
  });

  it('strips credentials when a redirect changes host', async () => {
    const { client, calls } = setup((c) =>
      c.url.startsWith('https://api.backpack.tf') ? redirectResponse('https://backpack.tf/api/notifications') : ok(),
    );
    await client.request(BPTF_MISC, {
      headers: { 'X-Auth-Token': 'tok-abcdefgh', Authorization: 'Bearer zzz', 'X-Other': '1' },
      secretHeaders: ['x-auth-token'],
      ifNoneMatch: '"v1"',
    });
    expect(calls[0]!.headers['x-auth-token']).toBe('tok-abcdefgh');
    expect(calls[1]!.headers['x-auth-token']).toBeUndefined();
    expect(calls[1]!.headers['authorization']).toBeUndefined();
    expect(calls[1]!.headers['if-none-match']).toBeUndefined();
    expect(calls[1]!.headers['x-other']).toBe('1');
    expect(calls[1]!.headers['x-app-context']).toBe('440');
  });

  it('refuses a cross-host redirect that would carry a secret', async () => {
    const token = 'secret-token-123456';
    const { client, calls } = setup(() => redirectResponse(`https://backpack.tf/api/x?token=${token}`));
    await expect(client.request(BPTF_MISC, { query: { token }, secretQuery: ['token'] })).rejects.toBeInstanceOf(
      ForbiddenHostError,
    );
    expect(calls).toHaveLength(1);
  });

  it('a 3xx without Location is returned as-is', async () => {
    const { client } = setup(() => textResponse('', { status: 300 }));
    expect((await client.request(PRICEDB)).status).toBe(300);
  });
});

describe('responses', () => {
  it('parses JSON and lower-cases headers', async () => {
    const { client, sink } = setup(() => jsonResponse({ sku: '5021;6' }, { headers: { ETag: '"abc"', 'X-Thing': 'y' } }));
    const res = await client.request<{ sku: string }>(PRICEDB);
    expect(res).toMatchObject({ status: 200, ok: true, data: { sku: '5021;6' }, text: null, etag: '"abc"', notModified: false });
    expect(res.headers['x-thing']).toBe('y');
    expect(res.bytes).toBe(16);
    expect(sink.rows[0]).toMatchObject({ host: 'pricedb.io', path: '/api/item/5021;6', method: 'GET', status: 200, bytes: 16, note: null });
  });

  it('304 means notModified', async () => {
    const { client, calls } = setup(() => new Response(null, { status: 304, headers: { etag: '"abc"' } }));
    const res = await client.request('https://sku.pricedb.io/api/schema', { ifNoneMatch: '"abc"' });
    expect(calls[0]!.headers['if-none-match']).toBe('"abc"');
    expect(res).toMatchObject({ status: 304, notModified: true, data: null, text: null, etag: '"abc"', ok: false });
  });

  it('keeps the first 2 KB of a body that is not JSON', async () => {
    const body = `<!-- not json -->${'x'.repeat(5_000)}`;
    const { client, sink } = setup(() => textResponse(body, { headers: { 'content-type': 'application/json' } }));
    const res = await client.request(PRICEDB);
    expect(res.data).toBeNull();
    expect(res.text).toHaveLength(ERROR_TEXT_LIMIT);
    expect(res.text!.startsWith('<!-- not json -->')).toBe(true);
    expect(sink.rows[0]!.note).toBe('invalid JSON');
  });

  it('returns raw text when expectJson is false', async () => {
    const big = 'y'.repeat(10_000);
    const { client } = setup(() => textResponse(big));
    const res = await client.request(PRICEDB, { expectJson: false });
    expect(res.text).toBe(big);
    expect(res.data).toBeNull();
  });

  it('an empty body is data null without a parse error', async () => {
    const { client, sink } = setup(() => textResponse(''));
    const res = await client.request(PRICEDB);
    expect(res).toMatchObject({ data: null, text: null, bytes: 0 });
    expect(sink.rows[0]!.note).toBeNull();
  });

  it('returns 401/403 JSON errors to the caller without blocking the host', async () => {
    const { client } = setup(() => jsonResponse({ message: 'This access token is not valid.' }, { status: 401 }));
    const res = await client.request(SNAPSHOT);
    expect(res).toMatchObject({ status: 401, ok: false, data: { message: 'This access token is not valid.' } });
    expect(client.hostBlocked('api.backpack.tf')).toBeNull();

    const forbidden = setup(() =>
      jsonResponse({ response: { success: 0, message: 'This API key is not valid.' } }, { status: 403 }),
    );
    expect((await forbidden.client.request(CURRENCIES)).status).toBe(403);
    expect(forbidden.client.hostBlocked('api.backpack.tf')).toBeNull();
  });
});

describe('challenge pages', () => {
  const challenge = () =>
    textResponse('<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', {
      status: 403,
      headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html; charset=UTF-8' },
    });

  it('blocks the host and never retries until unblocked', async () => {
    let challenged = true;
    const { client, calls, sink } = setup(() => (challenged ? challenge() : ok()));
    const err = await client.request(SNAPSHOT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostBlockedError);
    expect((err as HostBlockedError).host).toBe('api.backpack.tf');
    expect(client.hostBlocked('api.backpack.tf')).toMatch(/challenge/);
    expect(client.hostBlocked('API.Backpack.TF.')).toMatch(/challenge/);
    expect(sink.rows[0]).toMatchObject({ status: 403 });
    expect(sink.rows[0]!.note).toMatch(/^host disabled: challenge page/);

    challenged = false;
    await expect(client.request(CURRENCIES)).rejects.toBeInstanceOf(HostBlockedError);
    expect(calls).toHaveLength(1);

    // Other hosts are unaffected.
    expect((await client.request(PRICEDB)).status).toBe(200);

    client.unblockHost('api.backpack.tf');
    expect(client.hostBlocked('api.backpack.tf')).toBeNull();
    expect((await client.request(CURRENCIES)).status).toBe(200);
  });

  it('a challenge header blocks even on a 200', async () => {
    const { client } = setup(() => textResponse('{}', { status: 200, headers: { 'cf-mitigated': 'challenge' } }));
    await expect(client.request(PRICEDB)).rejects.toBeInstanceOf(HostBlockedError);
    expect(client.hostBlocked('pricedb.io')).not.toBeNull();
  });

  it.each([403, 503])('an HTML body on %i blocks the host', async (status) => {
    const { client } = setup(() =>
      textResponse('  <html><body>Access denied</body></html>', { status, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(client.request(PRICEDB)).rejects.toBeInstanceOf(HostBlockedError);
    expect(client.hostBlocked('pricedb.io')).toMatch(/HTML error page/);
  });

  it('blocks the host that served the challenge after a redirect', async () => {
    const { client } = setup((c) => (c.url.startsWith('https://api.backpack.tf') ? redirectResponse('https://backpack.tf/api/x') : challenge()));
    await expect(client.request(BPTF_MISC)).rejects.toBeInstanceOf(HostBlockedError);
    expect(client.hostBlocked('backpack.tf')).not.toBeNull();
    expect(client.hostBlocked('api.backpack.tf')).toBeNull();
  });

  it('reports each block and each removal so the caller can persist them', async () => {
    const saved: Record<string, string>[] = [];
    const { client } = setup(() => challenge(), { onBlocksChanged: (b) => saved.push(b) });
    await expect(client.request(SNAPSHOT)).rejects.toBeInstanceOf(HostBlockedError);
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]!)).toEqual(['api.backpack.tf']);
    expect(saved[0]!['api.backpack.tf']).toMatch(/^challenge page/);
    // Nothing changes for a host that is not blocked.
    client.unblockHost('pricedb.io');
    expect(saved).toHaveLength(1);
    client.unblockHost('API.Backpack.TF.');
    expect(saved).toHaveLength(2);
    expect(saved[1]).toEqual({});
  });

  it('starts with the blocks of an earlier run and sends nothing to those hosts until unblocked', async () => {
    const saved: Record<string, string>[] = [];
    const { client, calls, log } = setup(ok, {
      initialBlocks: {
        'API.Backpack.TF.': 'challenge page (cf-mitigated: challenge, HTTP 403); re-enable after checking in a browser',
        'not a host!': 'ignored',
        'pricedb.io': '',
      },
      onBlocksChanged: (b) => saved.push(b),
    });
    expect(client.hostBlocked('api.backpack.tf')).toMatch(/^challenge page/);
    expect(client.hostBlocked('pricedb.io')).toBeNull();
    expect(log.calls.some((c) => c.level === 'info' && /api\.backpack\.tf stays disabled/.test(c.msg))).toBe(true);
    await expect(client.request(CURRENCIES)).rejects.toBeInstanceOf(HostBlockedError);
    await expect(client.request(SNAPSHOT, { priority: 'user' })).rejects.toBeInstanceOf(HostBlockedError);
    expect(calls).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect((await client.request(PRICEDB)).status).toBe(200);

    client.unblockHost('api.backpack.tf');
    expect(saved).toEqual([{}]);
    expect((await client.request(CURRENCIES)).status).toBe(200);
  });

  it('a failing onBlocksChanged is logged and the host stays blocked', async () => {
    const { client, log } = setup(() => challenge(), {
      onBlocksChanged: () => {
        throw new Error('database is closed');
      },
    });
    await expect(client.request(PRICEDB)).rejects.toBeInstanceOf(HostBlockedError);
    expect(client.hostBlocked('pricedb.io')).not.toBeNull();
    expect(log.calls.some((c) => c.level === 'warn' && /saving the disabled hosts failed: database is closed/.test(c.msg))).toBe(true);
  });

  it('parseHostBlocks keeps only well-formed entries', () => {
    expect(parseHostBlocks(null)).toEqual({});
    expect(parseHostBlocks('')).toEqual({});
    expect(parseHostBlocks('not json')).toEqual({});
    expect(parseHostBlocks('[["api.backpack.tf","x"]]')).toEqual({});
    expect(parseHostBlocks('"api.backpack.tf"')).toEqual({});
    expect(
      parseHostBlocks(JSON.stringify({ 'API.backpack.tf.': 'challenge', 'pricedb.io': 7, 'sku.pricedb.io': ' ', 'a b': 'x', '': 'x' })),
    ).toEqual({ 'api.backpack.tf': 'challenge' });
    expect(parseHostBlocks(JSON.stringify({ 'pricedb.io': 'r'.repeat(2_000) }))['pricedb.io']).toHaveLength(500);
  });
});

describe('429 and Retry-After', () => {
  const cases: [string, () => Response, number][] = [
    ['Retry-After seconds', () => jsonResponse({}, { status: 429, headers: { 'retry-after': '120' } }), 120_000],
    [
      'Retry-After HTTP date',
      () => jsonResponse({}, { status: 429, headers: { 'retry-after': new Date(T0 + 90_000).toUTCString() } }),
      90_000,
    ],
    [
      'Retry-After unix timestamp',
      () => jsonResponse({}, { status: 429, headers: { 'retry-after': String(Math.floor(T0 / 1000) + 300) } }),
      300_000,
    ],
    ['body retry_after_ms', () => jsonResponse({ retry_after_ms: 4_500 }, { status: 429, headers: { 'retry-after': '120' } }), 4_500],
    ['body retry_after', () => jsonResponse({ retry_after: 7 }, { status: 429, headers: { 'retry-after': '120' } }), 7_000],
    ['message "in N seconds"', () => jsonResponse({ message: 'Too many requests, try again in 42 seconds.' }, { status: 429 }), 42_000],
    ['nested response.message', () => jsonResponse({ response: { success: 0, message: 'Retry in 9 seconds' } }, { status: 429 }), 9_000],
    ['no hint: 60 s backoff', () => jsonResponse({}, { status: 429 }), 60_000],
    ['garbage header: 60 s backoff', () => jsonResponse({}, { status: 429, headers: { 'retry-after': 'soon' } }), 60_000],
  ];

  it.each(cases)('%s', async (_name, make, expectedMs) => {
    const { client, sink, log } = setup(make);
    const res = await client.request(PRICEDB);
    expect(res.status).toBe(429);
    expect(res.ok).toBe(false);
    expect(client.nextAllowedAt('pricedb')).toBe(T0 + expectedMs);
    const b = client.budgets().find((x) => x.policy.startsWith('PriceDB'))!;
    expect(b.pausedUntil).toBe(T0 + expectedMs);
    expect(b.consecutive429).toBe(1);
    expect(sink.rows[0]!.note).toMatch(/^HTTP 429: pricedb paused/);
    expect(log.calls.some((c) => c.level === 'warn' && /HTTP 429/.test(c.msg))).toBe(true);
  });

  it('waits out the pause before the next request', async () => {
    let first = true;
    const { client, calls, time } = setup(() => {
      if (first) {
        first = false;
        return jsonResponse({}, { status: 429, headers: { 'retry-after': '30' } });
      }
      return ok();
    });
    await client.request(PRICEDB);
    const p = client.request(PRICEDB);
    await time.advance(29_999);
    expect(calls).toHaveLength(1);
    await time.advance(1);
    expect((await p).status).toBe(200);
    expect(calls[1]!.at).toBe(T0 + 30_000);
    expect(client.budgets().find((x) => x.policy.startsWith('PriceDB'))!.consecutive429).toBe(0);
  });

  it('fails fast with RateLimitedError when the pause exceeds maxWaitMs', async () => {
    const { client, calls } = setup(() => jsonResponse({}, { status: 429, headers: { 'retry-after': '600' } }));
    await client.request(PRICEDB);
    const err = await client.request(PRICEDB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAt).toBe(T0 + 600_000);
    expect(calls).toHaveLength(1);
  });

  it('three consecutive 429s pause the whole host for an hour', async () => {
    const { client, calls, time, sink } = setup(() => jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }));
    await client.request(BPTF_MISC);
    const second = client.request(BPTF_MISC, { maxWaitMs: HOUR });
    await time.advance(10_000);
    await second;
    const third = client.request(BPTF_MISC, { maxWaitMs: HOUR });
    await time.advance(10_000);
    await third;
    expect(calls).toHaveLength(3);
    const now = time.now();
    expect(sink.rows[2]!.note).toMatch(/HTTP 429 x3: api\.backpack\.tf paused 1 h/);

    const budgets = client.budgets();
    const bptf = budgets.filter((b) => b.host === 'api.backpack.tf');
    expect(bptf.length).toBeGreaterThanOrEqual(4);
    for (const b of bptf) expect(b.pausedUntil).toBe(now + HOUR);
    expect(bptf.find((b) => b.policy.startsWith('Other backpack.tf'))!.consecutive429).toBe(3);
    expect(budgets.find((b) => b.host === 'pricedb.io')!.pausedUntil).toBeNull();

    // A different budget on the same host is paused too.
    const err = await client.request(SNAPSHOT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).budget).toBe('bptf-snapshot');
    expect(calls).toHaveLength(3);
    expect(client.nextAllowedAt('bptf-snapshot')).toBe(now + HOUR);
  });

  it('503 with Retry-After pauses the budget and returns the response', async () => {
    const { client } = setup(() => jsonResponse({ error: 'maintenance' }, { status: 503, headers: { 'retry-after': '45' } }));
    const res = await client.request(PRICEDB);
    expect(res.status).toBe(503);
    expect(client.nextAllowedAt('pricedb')).toBe(T0 + 45_000);
    expect(client.budgets().find((b) => b.host === 'pricedb.io')!.consecutive429).toBe(0);
  });

  it('a 429 on SCM disables it for 6 hours', async () => {
    const { client } = setup(() => jsonResponse({}, { status: 429, headers: { 'retry-after': '5' } }));
    await client.request('https://steamcommunity.com/market/priceoverview/', {
      query: { appid: 440, currency: 1, market_hash_name: 'Mann Co. Supply Crate Key' },
    });
    expect(client.nextAllowedAt('scm')).toBe(T0 + 6 * HOUR);
  });
});

describe('RateLimit-Remaining (PriceDB)', () => {
  it('pauses until reset while remaining is below 36', async () => {
    const { client, sink } = setup(() => jsonResponse({}, { headers: { 'ratelimit-remaining': '20', 'ratelimit-reset': '30' } }));
    await client.request(PRICEDB);
    expect(client.nextAllowedAt('pricedb')).toBe(T0 + 30_000);
    expect(sink.rows[0]!.note).toBe('RateLimit-Remaining 20: paused 30 s');
  });

  it('does nothing while plenty remain, or for budgets without a threshold', async () => {
    const { client } = setup(() => jsonResponse({}, { headers: { 'ratelimit-remaining': '300', 'ratelimit-reset': '30' } }));
    await client.request(PRICEDB);
    expect(client.nextAllowedAt('pricedb')).toBe(T0 + 500);
    const other = setup(() => jsonResponse({}, { headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': '30' } }));
    await other.client.request('https://sku.pricedb.io/api/effect/list');
    expect(other.client.nextAllowedAt('sku')).toBe(T0 + 500);
  });

  it('parseRateLimit reads separate and combined headers', () => {
    expect(parseRateLimit({ 'ratelimit-remaining': '5', 'ratelimit-reset': '12' }, T0)).toEqual({ remaining: 5, resetMs: 12_000 });
    expect(parseRateLimit({ ratelimit: 'limit=360, remaining=10, reset=40' }, T0)).toEqual({ remaining: 10, resetMs: 40_000 });
    expect(parseRateLimit({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(T0 / 1000 + 20) }, T0)).toEqual({
      remaining: 1,
      resetMs: 20_000,
    });
    expect(parseRateLimit({}, T0)).toEqual({ remaining: null, resetMs: null });
    expect(parseRateLimit({ 'ratelimit-remaining': 'lots' }, T0)).toEqual({ remaining: null, resetMs: null });
  });
});

describe('Retry-After parsing', () => {
  it('parseRetryAfter handles every form', () => {
    expect(parseRetryAfter('10', T0)).toBe(10_000);
    expect(parseRetryAfter(' 2.5 ', T0)).toBe(2_500);
    expect(parseRetryAfter('0', T0)).toBe(1_000);
    expect(parseRetryAfter(String(T0 / 1000 + 60), T0)).toBe(60_000);
    expect(parseRetryAfter(String(T0 + 15_000), T0)).toBe(15_000);
    expect(parseRetryAfter(new Date(T0 + 120_000).toUTCString(), T0)).toBe(120_000);
    expect(parseRetryAfter(new Date(T0 - 120_000).toUTCString(), T0)).toBe(1_000);
    expect(parseRetryAfter('999999999', T0)).toBe(24 * HOUR);
    expect(parseRetryAfter('', T0)).toBeNull();
    expect(parseRetryAfter('later', T0)).toBeNull();
    expect(parseRetryAfter(undefined, T0)).toBeNull();
  });

  it('retryDelayFromResponse follows the node-bptf-listings order', () => {
    const h = { 'retry-after': '100' };
    expect(retryDelayFromResponse(h, { retry_after_ms: '2500', retry_after: 9 }, null, T0)).toBe(2_500);
    expect(retryDelayFromResponse(h, { retry_after: '9' }, null, T0)).toBe(9_000);
    expect(retryDelayFromResponse(h, { message: 'in 5 seconds' }, null, T0)).toBe(100_000);
    expect(retryDelayFromResponse({}, { message: 'please retry in 5 seconds' }, null, T0)).toBe(5_000);
    expect(retryDelayFromResponse({}, null, 'Slow down! Try again in 3s', T0)).toBe(3_000);
    expect(retryDelayFromResponse({}, { retry_after_ms: 'abc', retry_after: -1 }, null, T0)).toBeNull();
    expect(retryDelayFromResponse({}, 'not an object', null, T0)).toBeNull();
    expect(retryDelayFromResponse({}, { retry_after: { nested: 1 } }, null, T0)).toBeNull();
  });
});

describe('scheduling through the client', () => {
  it('spaces snapshot requests 10 s apart', async () => {
    const { client, calls, time } = setup(ok);
    const all = Promise.all([0, 1, 2].map(() => client.request(SNAPSHOT, { maxWaitMs: HOUR })));
    await time.advance(25_000);
    await all;
    expect(calls.map((c) => c.at - T0)).toEqual([0, 10_000, 20_000]);
  });

  it("serves 'user' requests before queued 'background' ones", async () => {
    const { client, calls, time } = setup(ok);
    const reqs = [
      client.request(`${SNAPSHOT}?sku=first`),
      client.request(`${SNAPSHOT}?sku=bg1`, { priority: 'background', maxWaitMs: HOUR }),
      client.request(`${SNAPSHOT}?sku=bg2`, { maxWaitMs: HOUR }),
      client.request(`${SNAPSHOT}?sku=user`, { priority: 'user', maxWaitMs: HOUR }),
    ];
    await time.advance(40_000);
    await Promise.all(reqs);
    expect(calls.map((c) => new URL(c.url).searchParams.get('sku'))).toEqual(['first', 'user', 'bg1', 'bg2']);
  });

  it('allows one request at a time per host across budgets, two for pricedb.io', async () => {
    const gates: { resolve: (r: Response) => void }[] = [];
    const { client, calls, time } = setup(() => {
      const d = deferred<Response>();
      gates.push(d);
      return d.promise;
    });
    const a = client.request(SNAPSHOT);
    const b = client.request(CURRENCIES);
    await flush();
    expect(calls).toHaveLength(1);
    gates[0]!.resolve(ok());
    await a;
    await flush();
    expect(calls).toHaveLength(2);
    gates[1]!.resolve(ok());
    await b;

    const pricedb = [
      client.request(PRICEDB, { maxWaitMs: HOUR }),
      client.request(PRICEDB, { maxWaitMs: HOUR }),
      client.request(PRICEDB, { maxWaitMs: HOUR }),
    ];
    await flush();
    expect(calls).toHaveLength(3); // pricedb's 500 ms spacing still applies
    await time.advance(500);
    expect(calls).toHaveLength(4); // two in flight on pricedb.io
    await time.advance(500);
    expect(calls).toHaveLength(4); // the third waits for a free host slot
    gates[2]!.resolve(ok());
    await flush();
    expect(calls).toHaveLength(5);
    gates[3]!.resolve(ok());
    gates[4]!.resolve(ok());
    await Promise.all(pricedb);
  });

  it('a cross-host redirect carrying a registered secret is refused', async () => {
    const { client, calls, secrets } = setup(() => redirectResponse('https://backpack.tf/api/x?q=registered-secret-99'));
    secrets.register('registered-secret-99');
    await expect(client.request(BPTF_MISC)).rejects.toThrow(/secret to another host/);
    expect(calls).toHaveLength(1);
  });

  it('explicit budget ids are used instead of the default', async () => {
    const { client } = setup(ok);
    await client.request(BPTF_MISC, { budget: 'bptf-users' });
    expect(client.nextAllowedAt('bptf-users')).toBe(T0 + 10_000);
    expect(client.nextAllowedAt('bptf-misc')).toBe(T0);
    expect(client.nextAllowedAt('unknown-budget')).toBe(T0);
  });

  it('budgets() lists every budget with usage', async () => {
    const { client } = setup(ok);
    await client.request(PRICEDB);
    const list = client.budgets();
    expect(list).toHaveLength(BUDGETS.length);
    expect(list.map((b) => b.id)).toEqual(BUDGETS.map((b) => b.id));
    const pricedb = list.find((b) => b.host === 'pricedb.io')!;
    expect(pricedb).toEqual({
      id: 'pricedb',
      host: 'pricedb.io',
      policy: BUDGETS.find((b) => b.id === 'pricedb')!.description,
      usedLastHour: 1,
      pausedUntil: null,
      consecutive429: 0,
    });
  });

  it('creates a conservative fallback budget when custom budgets omit a host', async () => {
    const { client, time, calls } = setup(ok, { budgets: [] });
    await client.request(PRICEDB);
    const p = client.request(PRICEDB);
    await time.advance(5_000);
    await p;
    expect(calls.map((c) => c.at - T0)).toEqual([0, 5_000]);
    expect(client.budgets()[0]).toMatchObject({ host: 'pricedb.io', usedLastHour: 2 });
  });

  it('rejects duplicate budget ids', () => {
    expect(() =>
      setup(ok, {
        budgets: [
          { id: 'x', host: 'pricedb.io', minIntervalMs: 0, concurrency: 1, description: 'x' },
          { id: 'x', host: 'pricedb.io', minIntervalMs: 0, concurrency: 1, description: 'x' },
        ],
      }),
    ).toThrow(/Duplicate/);
  });

  it('a request log write failure does not fail the request', async () => {
    const { client, log } = setup(ok, {
      sink: {
        record() {
          throw new Error('disk full');
        },
      },
    });
    expect((await client.request(PRICEDB)).status).toBe(200);
    expect(log.calls.some((c) => /request log write failed/.test(c.msg))).toBe(true);
  });
});
