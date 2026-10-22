// 0.7.4 trading accuracy audit, package G2 (review R34): F52 made every 500 pause its budget, but Steam's
// priceoverview answers a name with no market listing with HTTP 500 and {"success":false}, an answer about that
// one item (steamMarket caches it as "no listing"). Through the real http client and SteamMarket, such an answer
// no longer pauses the 'scm' budget for every other item (HttpRequestOptions.isAnswer); any other 5xx body still
// does, and a 429 is never exempt. Fake fetch and time only.

import { afterEach, describe, expect, it } from 'vitest';
import { createSteamMarket, unknownItemAnswer } from '../../src/service/connectors/steamMarket';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { buildUserAgent, createHttpClient, type NetPauseState } from '../../src/service/net/http';
import { SecretRegistry } from '../../src/service/net/redact';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { FakeTime, MemorySink, RecordingLogger, T0, createFakeFetch, jsonResponse, textResponse, type FetchHandler } from './helpers';

const UA = buildUserAgent('0.7.4', 'https://example.invalid/contact');
const PRICEDB = 'https://pricedb.io/api/item/5021;6';
const OK = { success: true, lowest_price: '$2.14', median_price: '$2.16', volume: '54,396' };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup(handler: FetchHandler) {
  const time = new FakeTime();
  const { fetch, calls } = createFakeFetch(handler, time);
  const saved: NetPauseState[] = [];
  const log = new RecordingLogger();
  const client = createHttpClient({
    clock: time,
    timers: time,
    log,
    sink: new MemorySink(),
    userAgent: () => UA,
    fetchImpl: fetch,
    secrets: new SecretRegistry(),
    onPausesChanged: (s) => saved.push(s),
  });
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { scm: true } });
  const scm = createSteamMarket({ clock: time, log, repo, http: client, settings: () => settings, secret: () => null });
  const scmPause = (): NetPauseState['budgets'][string] | undefined => saved.at(-1)?.budgets['scm'];
  return { time, calls, client, scm, scmPause, log };
}

const nameOf = (url: string): string => new URL(url).searchParams.get('market_hash_name') ?? '';

describe("Steam Market's unknown-item 500 (R34)", () => {
  it('caches the "no listing" answer without pausing scm, so the next item 6 s later gets its price', async () => {
    const h = setup((c) => (nameOf(c.url) === 'Not An Item' ? jsonResponse({ success: false }, { status: 500 }) : jsonResponse(OK)));
    expect(await h.scm.priceOverview('Not An Item')).toEqual({ lowest: null, median: null, volume: null });
    // Only the budget's own 5 s spacing, no backoff.
    expect(h.client.nextAllowedAt('scm')).toBe(T0 + 5_000);
    expect(h.scmPause()?.nBackoff ?? 0).toBe(0);
    expect(h.log.calls.some((c) => c.level === 'warn' && c.msg.includes('scm paused'))).toBe(false);
    await h.time.advance(6_000);
    expect(await h.scm.priceOverview('Team Captain')).toEqual({ lowest: '$2.14', median: '$2.16', volume: '54,396' });
    expect(h.calls).toHaveLength(2);
    expect(h.scm.health().lastError).toBeNull();
  });

  it.each([
    ['a JSON body that is no priceoverview answer', () => jsonResponse({ error: 'x' }, { status: 500 })],
    ['an HTML error page', () => textResponse('<html><body>Error</body></html>', { status: 500, headers: { 'content-type': 'text/html' } })],
    ['a 502 with {"success":false}', () => jsonResponse({ success: false }, { status: 502 })],
  ])('still pauses scm 60 s for %s', async (_what, reply) => {
    const h = setup(reply);
    expect(await h.scm.priceOverview('Team Captain')).toBeNull();
    expect(h.client.nextAllowedAt('scm')).toBe(T0 + 60_000);
    expect(h.scmPause()).toMatchObject({ nBackoff: 1 });
  });

  it('reads the answer rule as the connector caches it', () => {
    expect(unknownItemAnswer(500, { success: false })).toBe(true);
    expect(unknownItemAnswer(500, { success: true })).toBe(false);
    expect(unknownItemAnswer(500, null)).toBe(false);
    expect(unknownItemAnswer(500, { error: 'x' })).toBe(false);
    expect(unknownItemAnswer(503, { success: false })).toBe(false);
  });
});

describe('HttpRequestOptions.isAnswer (R34)', () => {
  it('lets a caller take a 5xx as its answer; a throwing callback, or none, keeps the F52 pause', async () => {
    const h = setup(() => jsonResponse({ ok: false }, { status: 502 }));
    const res = await h.client.request(PRICEDB, { isAnswer: (s, d) => s === 502 && (d as { ok?: unknown }).ok === false });
    expect(res.status).toBe(502);
    expect(h.client.nextAllowedAt('pricedb')).toBeLessThan(T0 + 60_000);

    const thrower = setup(() => jsonResponse({}, { status: 500 }));
    await thrower.client.request(PRICEDB, {
      isAnswer: () => {
        throw new Error('broken');
      },
    });
    expect(thrower.client.nextAllowedAt('pricedb')).toBe(T0 + 60_000);
  });

  it('never exempts a 429', async () => {
    const h = setup(() => jsonResponse({ success: false }, { status: 429 }));
    await h.client.request(PRICEDB, { isAnswer: () => true });
    expect(h.client.budgets().find((b) => b.id === 'pricedb')!.consecutive429).toBe(1);
  });
});
