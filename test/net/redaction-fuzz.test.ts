// Appendix B #4: a known secret must never appear in a request-log row, a
// logger call or a thrown error, however a request fails.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpRequestOptions } from '../../src/service/contracts';
import { createHttpClient } from '../../src/service/net/http';
import { buildUserAgent } from '../../src/service/net/http';
import { globalSecrets, registerSecret } from '../../src/service/net/redact';
import {
  FakeTime,
  MemorySink,
  RecordingLogger,
  createFakeFetch,
  flush,
  hang,
  jsonResponse,
  redirectResponse,
  textResponse,
  type FetchCall,
} from './helpers';

const TOKENS = [
  '0123456789abcdef0123456789abcdef', // bp.tf-style hex key
  'Zx9+/=Kq7_tok-ABCDEF0123', // base64-ish, needs encoding
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', // JWT-shaped
  'tok en & more=chars?#', // spaces and URL metacharacters
];

function forms(t: string): string[] {
  const uri = encodeURIComponent(t);
  const form = new URLSearchParams({ t }).toString().slice(2);
  const lower = (s: string) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  return [...new Set([t, uri, form, lower(uri), lower(form)])];
}

interface Placement {
  name: string;
  build(token: string): { url: string; opts: HttpRequestOptions };
}

const PLACEMENTS: Placement[] = [
  {
    name: 'declared query key',
    build: (t) => ({
      url: 'https://api.backpack.tf/api/IGetPrices/v4',
      opts: { query: { key: t, raw: 1 }, secretQuery: ['key'] },
    }),
  },
  {
    name: 'undeclared query value (registry only)',
    build: (t) => ({ url: 'https://pricedb.io/api/search', opts: { query: { q: t, limit: 5 } } }),
  },
  {
    name: 'inline token in the URL string',
    build: (t) => ({
      url: `https://api.backpack.tf/api/classifieds/listings/snapshot?sku=Team%20Captain&appid=440&token=${encodeURIComponent(t)}`,
      opts: { secretQuery: ['token'] },
    }),
  },
  {
    name: 'X-Auth-Token header',
    build: (t) => ({
      url: 'https://api.backpack.tf/api/users/info/v1',
      opts: { query: { steamids: '76561198000000000' }, headers: { 'X-Auth-Token': t }, secretHeaders: ['x-auth-token'] },
    }),
  },
  {
    name: 'Authorization bearer',
    build: (t) => ({ url: 'https://api.mannco.store/item/pricing/bulk', opts: { query: { items: '1,2' }, headers: { Authorization: `Bearer ${t}` } } }),
  },
  {
    name: 'path segment (registry only)',
    build: (t) => ({ url: `https://sku.pricedb.io/api/sku/${encodeURIComponent(t)}`, opts: {} }),
  },
  {
    name: 'Steam x-webapi-key header',
    build: (t) => ({
      url: 'https://api.steampowered.com/IEconItems_440/GetSchemaOverview/v0001/',
      opts: { headers: { 'x-webapi-key': t } },
    }),
  },
  {
    name: 'POST body to mannco login',
    build: (t) => ({ url: 'https://api.mannco.store/user/login', opts: { method: 'POST', json: { apiKey: t } } }),
  },
];

type Behavior = { name: string; handler: (call: FetchCall, token: string) => Response | Promise<Response> };

let hop = 0;
const BEHAVIORS: Behavior[] = [
  { name: '200 echoing the token', handler: (c, t) => jsonResponse({ echo: t, url: c.url }) },
  { name: 'invalid JSON echoing the token', handler: (c, t) => textResponse(`oops ${t} ${c.url} ${encodeURIComponent(t)}`) },
  {
    name: '429 with the token in the message',
    handler: (c, t) => jsonResponse({ message: `rate limited ${t} at ${c.url}; retry in 5 seconds` }, { status: 429 }),
  },
  { name: '429 with a bogus Retry-After containing the token', handler: (_c, t) => jsonResponse({}, { status: 429, headers: { 'retry-after': t.replace(/[^\x20-\x7e]/g, '') } }) },
  {
    name: '503 HTML page echoing the token',
    handler: (c, t) => textResponse(`<html><body>${t} ${c.url}</body></html>`, { status: 503, headers: { 'content-type': 'text/html' } }),
  },
  {
    name: 'cf challenge',
    handler: (_c, t) => textResponse(`<!DOCTYPE html>${t}`, { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
  },
  {
    name: 'same-host redirect carrying the token',
    handler: (c, t) => {
      const u = new URL(c.url);
      if (u.searchParams.has('hop')) return jsonResponse({ ok: true });
      return redirectResponse(`${u.pathname}?hop=1&token=${encodeURIComponent(t)}&v=${encodeURIComponent(t)}`);
    },
  },
  {
    name: 'cross-host redirect carrying the token',
    handler: (_c, t) => redirectResponse(`https://backpack.tf/api/elsewhere?v=${encodeURIComponent(t)}`),
  },
  { name: 'redirect to scrap.tf carrying the token', handler: (_c, t) => redirectResponse(`https://scrap.tf/steal?t=${encodeURIComponent(t)}`) },
  {
    name: 'redirect loop carrying the token',
    handler: (c, t) => redirectResponse(`${new URL(c.url).pathname}?n=${++hop}&x=${encodeURIComponent(t)}`),
  },
  {
    name: 'network error quoting the URL and the token',
    handler: (c, t) => {
      throw new TypeError(`fetch failed for ${c.url}`, { cause: Object.assign(new Error(`connect ECONNREFUSED ${t}`), { code: 'ECONNREFUSED' }) });
    },
  },
  { name: 'timeout', handler: () => hang() },
  { name: '401 echoing the token', handler: (_c, t) => jsonResponse({ message: `token ${t} is not valid` }, { status: 401 }) },
  { name: '404 plain text', handler: (_c, t) => textResponse(`not found: ${t}`, { status: 404 }) },
];

interface Collected {
  rows: string[];
  logs: string[];
  errors: string[];
}

async function runScenario(token: string, placement: Placement, behavior: Behavior, out: Collected): Promise<void> {
  const time = new FakeTime();
  const sink = new MemorySink();
  const log = new RecordingLogger();
  const { fetch } = createFakeFetch((call) => behavior.handler(call, token), time);
  // No `secrets` override: production uses the global registry.
  const client = createHttpClient({
    clock: time,
    timers: time,
    log,
    sink,
    fetchImpl: fetch,
    userAgent: () => buildUserAgent('0.1.0', 'https://example.invalid/contact'),
  });
  const { url, opts } = placement.build(token);
  const p = client.request(url, { ...opts, maxWaitMs: 3_600_000 }).then(
    () => null,
    (e: unknown) => e,
  );
  await flush();
  await time.advance(25_000);
  const err = await p;
  if (err) {
    const e = err as Error & { url?: string; reason?: string; body?: string };
    out.errors.push(JSON.stringify({ name: e.name, message: e.message, url: e.url, reason: e.reason, body: e.body, stack: e.stack }));
  }
  // Follow-up requests exercise the blocked/rate-limited paths, then pausing
  // aborts anything still in flight.
  const followP = client.request(url, { ...opts, maxWaitMs: 0 }).then(
    () => null,
    (e: unknown) => e,
  );
  await flush();
  client.setPaused(true);
  const follow = await followP;
  if (follow) out.errors.push(JSON.stringify({ message: (follow as Error).message, url: (follow as { url?: string }).url }));
  const paused = await client.request(url, opts).then(
    () => null,
    (e: unknown) => e,
  );
  if (paused) out.errors.push(String((paused as Error).message));

  out.rows.push(...sink.rows.map((r) => JSON.stringify(r)));
  out.logs.push(...log.calls.map((c) => JSON.stringify({ msg: c.msg, meta: c.meta ?? null })));
}

describe('redaction fuzz (Appendix B #4)', () => {
  beforeAll(() => {
    for (const t of TOKENS) registerSecret(t);
  });
  afterAll(() => {
    globalSecrets.clear();
  });

  for (const token of TOKENS) {
    it(`never leaks ${JSON.stringify(token.slice(0, 6))}...`, async () => {
      const out: Collected = { rows: [], logs: [], errors: [] };
      for (const placement of PLACEMENTS) {
        for (const behavior of BEHAVIORS) {
          await runScenario(token, placement, behavior, out);
        }
      }
      expect(out.rows.length).toBeGreaterThan(PLACEMENTS.length * 5);
      expect(out.logs.length).toBeGreaterThan(0);
      for (const f of forms(token)) {
        for (const r of out.rows) expect(r.includes(f), `request log leaked ${f}: ${r}`).toBe(false);
        for (const l of out.logs) expect(l.includes(f), `logger leaked ${f}: ${l}`).toBe(false);
        for (const e of out.errors) expect(e.includes(f), `error leaked ${f}: ${e}`).toBe(false);
      }
      expect(out.rows.some((r) => r.includes('REDACTED'))).toBe(true);
    });
  }

  it('policy rejections never echo the token', async () => {
    const token = TOKENS[0]!;
    const sink = new MemorySink();
    const log = new RecordingLogger();
    const client = createHttpClient({
      clock: new FakeTime(),
      log,
      sink,
      userAgent: () => buildUserAgent('0.1.0', ''),
      fetchImpl: createFakeFetch(() => jsonResponse({})).fetch,
    });
    const urls = [
      `https://scrap.tf/ajax/x?token=${token}`,
      `https://scrap.tf/${token}`,
      `https://user:${token}@pricedb.io/api/item/x`,
      `http://api.backpack.tf/api/IGetPrices/v4?key=${token}`,
      `https://api.backpack.tf/api/agent/pulse?token=${token}`,
    ];
    for (const url of urls) {
      const err = (await client.request(url).catch((e: unknown) => e)) as Error & { url: string };
      expect(err.name).toBe('ForbiddenHostError');
      expect(err.url.includes(token)).toBe(false);
      expect(err.message.includes(token)).toBe(false);
    }
    for (const c of log.calls) expect(JSON.stringify(c).includes(token)).toBe(false);
    expect(sink.rows).toHaveLength(0);
  });

  it('a short declared secret is still redacted by key and by value', async () => {
    const short = 'abc123'; // below the registry minimum, protected by declaration
    const time = new FakeTime();
    const sink = new MemorySink();
    const log = new RecordingLogger();
    const client = createHttpClient({
      clock: time,
      timers: time,
      log,
      sink,
      userAgent: () => buildUserAgent('0.1.0', ''),
      fetchImpl: createFakeFetch((c) => {
        throw new TypeError(`fetch failed: ${c.url} (${short})`);
      }).fetch,
    });
    await client
      .request('https://api.backpack.tf/api/IGetCurrencies/v1', { query: { key: short }, secretQuery: ['key'] })
      .catch(() => undefined);
    expect(JSON.stringify(sink.rows).includes(short)).toBe(false);
    expect(JSON.stringify(log.calls).includes(short)).toBe(false);
  });
});
