// 0.9 (#14): an HTML answer that carries Cloudflare's challenge script is a challenge whatever its status: the host is
// disabled until the user re-enables it (R7), never retried as a 429. A plain HTML 429 stays a 429. Fixtures:
// test/fixtures/net/bptf-429-challenge.html and bptf-429-plain.html (synthetic). Fake fetch: nothing reaches the network.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../../src/service/contracts';
import { HostBlockedError } from '../../src/service/net/errors';
import { CHALLENGE_BODY_MARKERS, buildUserAgent, createHttpClient, hasChallengeMarkers } from '../../src/service/net/http';
import { SecretRegistry } from '../../src/service/net/redact';
import { FakeTime, MemorySink, RecordingLogger, T0, createFakeFetch, jsonResponse, textResponse, type FetchHandler } from './helpers';

const UA = buildUserAgent('0.1.0', 'https://example.invalid/contact');
const SNAPSHOT = 'https://api.backpack.tf/api/classifieds/listings/snapshot';
const CURRENCIES = 'https://api.backpack.tf/api/IGetCurrencies/v1';
const PRICEDB = 'https://pricedb.io/api/item/5021;6';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/net/${name}`, import.meta.url), 'utf8');
const CHALLENGE_429 = fixture('bptf-429-challenge.html');
const PLAIN_429 = fixture('bptf-429-plain.html');
// The plain 429 with Cloudflare's JavaScript-detections snippet (__CF$cv$params, /cdn-cgi/challenge-platform/scripts/
// jsd/main.js), which Cloudflare injects into ordinary pages: no challenge.
const JSD_429 = fixture('bptf-429-jsd.html');
const HTML = { 'content-type': 'text/html' };

function setup(handler: FetchHandler) {
  const time = new FakeTime();
  const { fetch, calls } = createFakeFetch(handler, time);
  const sink = new MemorySink();
  const client: HttpClient = createHttpClient({
    clock: time,
    timers: time,
    log: new RecordingLogger(),
    sink,
    userAgent: () => UA,
    fetchImpl: fetch,
    secrets: new SecretRegistry(),
  });
  return { time, calls, sink, client };
}

const budget = (client: HttpClient, id: string) => client.budgets().find((b) => b.id === id)!;

describe('the fixtures', () => {
  it('are synthetic, relative-only and name no scrap.tf address', () => {
    for (const html of [CHALLENGE_429, PLAIN_429, JSD_429]) {
      expect(html.startsWith('<!-- Synthetic')).toBe(true);
      expect(html).not.toMatch(/:\/\//);
      expect(html).not.toMatch(/scrap\.tf/i);
    }
    expect(hasChallengeMarkers(CHALLENGE_429)).toBe(true);
    expect(hasChallengeMarkers(PLAIN_429)).toBe(false);
    expect(JSD_429).toContain('/cdn-cgi/challenge-platform/scripts/jsd/main.js');
    expect(JSD_429).toContain('__CF$cv$params');
    expect(hasChallengeMarkers(JSD_429)).toBe(false);
  });
});

describe('hasChallengeMarkers', () => {
  it('finds each marker, in the scanned start only', () => {
    for (const marker of [
      '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>',
      '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/managed/v1?ray=0"></script>',
      '<script src="/cdn-cgi/challenge-platform/orchestrate/jsch/v1"></script>',
      'window._cf_chl_opt={}',
      '<form id="cf-chl-widget">',
      '<iframe src="//challenges.cloudflare.com/turnstile"></iframe>',
      '<title>Just a moment...</title>',
    ]) {
      expect(hasChallengeMarkers(`<html>${marker}</html>`), marker).toBe(true);
      expect(CHALLENGE_BODY_MARKERS.test(marker), marker).toBe(true);
    }
    expect(hasChallengeMarkers('<html><body>Access denied</body></html>')).toBe(false);
    expect(hasChallengeMarkers(`${' '.repeat(262_144)}_cf_chl_opt`)).toBe(false);
  });

  it("does not take Cloudflare's JavaScript-detections snippet, which sits on ordinary pages, for a challenge", () => {
    for (const ordinary of [
      '<html><head><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body>ok</body></html>',
      "<html><script>window.__CF$cv$params={r:'0',t:'0'};</script></html>",
      '<html><script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/abc/main.js"></script></html>',
    ]) {
      expect(hasChallengeMarkers(ordinary), ordinary).toBe(false);
      expect(CHALLENGE_BODY_MARKERS.test(ordinary), ordinary).toBe(false);
    }
  });
});

describe('an HTML 429 with a challenge script', () => {
  it('disables the host instead of the 429 path, and nothing reaches it until it is re-enabled', async () => {
    let answer: 'challenge' | 'ok' = 'challenge';
    const { client, calls, sink } = setup(() => (answer === 'challenge' ? textResponse(CHALLENGE_429, { status: 429, headers: HTML }) : jsonResponse({ ok: true })));
    const err = await client.request(SNAPSHOT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostBlockedError);
    expect(client.hostBlocked('api.backpack.tf')).toMatch(/challenge page \(Cloudflare challenge script, HTTP 429\)/);
    expect(sink.rows[0]).toMatchObject({ status: 429 });
    expect(sink.rows[0]!.note).toMatch(/^host disabled: challenge page/);
    // Not counted as a 429, and no backoff was set.
    expect(budget(client, 'bptf-snapshot').consecutive429).toBe(0);
    expect(budget(client, 'bptf-snapshot').pausedUntil).toBeNull();
    // Another budget on the host is refused without a request; other hosts are unaffected.
    answer = 'ok';
    await expect(client.request(CURRENCIES)).rejects.toBeInstanceOf(HostBlockedError);
    expect(calls).toHaveLength(1);
    expect((await client.request(PRICEDB)).status).toBe(200);
    client.unblockHost('api.backpack.tf');
    expect((await client.request(CURRENCIES)).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('a 200 HTML answer carrying _cf_chl_opt also disables the host', async () => {
    const { client } = setup(() => textResponse('<html><script>window._cf_chl_opt={cvId:"3"};</script></html>', { status: 200, headers: HTML }));
    await expect(client.request(PRICEDB)).rejects.toBeInstanceOf(HostBlockedError);
    expect(client.hostBlocked('pricedb.io')).toMatch(/Cloudflare challenge script, HTTP 200/);
  });
});

describe('an HTML 429 without one', () => {
  it('stays a 429: paused by the backoff, returned not ok, the host enabled', async () => {
    const { client, sink } = setup(() => textResponse(PLAIN_429, { status: 429, headers: HTML }));
    const res = await client.request(SNAPSHOT);
    expect(res.status).toBe(429);
    expect(res.ok).toBe(false);
    expect(client.nextAllowedAt('bptf-snapshot')).toBe(T0 + 60_000);
    expect(budget(client, 'bptf-snapshot').consecutive429).toBe(1);
    expect(client.hostBlocked('api.backpack.tf')).toBeNull();
    expect(sink.rows[0]!.note).toMatch(/HTTP 429: bptf-snapshot paused/);
  });

  it("an nginx 429 carrying Cloudflare's JavaScript-detections snippet stays a 429 and recovers on its own", async () => {
    let answer: 'limited' | 'ok' = 'limited';
    const { client, calls, sink, time } = setup(() => (answer === 'limited' ? textResponse(JSD_429, { status: 429, headers: HTML }) : jsonResponse({ ok: true })));
    const res = await client.request(SNAPSHOT);
    expect(res.status).toBe(429);
    expect(res.ok).toBe(false);
    expect(client.nextAllowedAt('bptf-snapshot')).toBe(T0 + 60_000);
    expect(budget(client, 'bptf-snapshot').consecutive429).toBe(1);
    expect(client.hostBlocked('api.backpack.tf')).toBeNull();
    expect(sink.rows[0]!.note).toMatch(/HTTP 429: bptf-snapshot paused/);
    // Nothing is disabled: once the backoff has passed, the host's other budget and the paused one are both sent.
    answer = 'ok';
    await time.advance(60_000);
    expect((await client.request(CURRENCIES)).status).toBe(200);
    expect((await client.request(SNAPSHOT)).status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(client.hostBlocked('api.backpack.tf')).toBeNull();
  });

  it("a 5xx outage page carrying the snippet waits like any outage instead of disabling the host", async () => {
    const outage = PLAIN_429.replace(/429 Too Many Requests/g, '502 Bad Gateway').replace('</center></body>', `</center>${JSD_429.slice(JSD_429.indexOf('<script>'))}`);
    expect(outage).toContain('/cdn-cgi/challenge-platform/scripts/jsd/main.js');
    const { client } = setup(() => textResponse(outage, { status: 502, headers: HTML }));
    const res = await client.request(PRICEDB);
    expect(res.status).toBe(502);
    expect(res.ok).toBe(false);
    expect(client.hostBlocked('pricedb.io')).toBeNull();
  });

  it('a JSON 429 is unchanged', async () => {
    const { client } = setup(() => jsonResponse({ message: 'slow down' }, { status: 429 }));
    const res = await client.request(SNAPSHOT);
    expect(res).toMatchObject({ status: 429, ok: false, data: { message: 'slow down' } });
    expect(client.nextAllowedAt('bptf-snapshot')).toBe(T0 + 60_000);
    expect(budget(client, 'bptf-snapshot').consecutive429).toBe(1);
    expect(client.hostBlocked('api.backpack.tf')).toBeNull();
  });
});
