// 0.7.4 (F52): 500, 502, 504 and Cloudflare's 520-527/530 wait like a 503 (Retry-After, else 60 s doubling to
// 15 min) instead of counting as a success, and neither count toward nor end a host's 429 streak. 501 and the
// 4xx still end it, and an HTML 5xx page other than a 503 is backed off, never a host block. Fake fetch and time only.

import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../src/service/net/errors';
import {
  UNAVAILABLE_STATUSES,
  buildUserAgent,
  createHttpClient,
  isUnavailableStatus,
  type CreateHttpClientOptions,
  type NetPauseState,
} from '../../src/service/net/http';
import { BudgetScheduler } from '../../src/service/net/ratelimit';
import { SecretRegistry } from '../../src/service/net/redact';
import { BUDGETS } from '../../src/service/net/budgets';
import { FakeTime, MemorySink, RecordingLogger, T0, createFakeFetch, jsonResponse, textResponse, type FetchHandler } from './helpers';

const UA = buildUserAgent('0.1.0', 'https://example.invalid/contact');
const HOUR = 3_600_000;

const PRICEDB = 'https://pricedb.io/api/item/5021;6';
const SNAPSHOT = 'https://api.backpack.tf/api/classifieds/listings/snapshot';
const USERS = 'https://api.backpack.tf/api/users/info/v1';
const BPTF_MISC = 'https://api.backpack.tf/api/notifications';
const CURRENCIES = 'https://api.backpack.tf/api/IGetCurrencies/v1';
const PRICES = 'https://api.backpack.tf/api/IGetPrices/v4';

function setup(handler: FetchHandler, over: Partial<CreateHttpClientOptions> = {}) {
  const time = new FakeTime();
  const { fetch, calls } = createFakeFetch(handler, time);
  const sink = new MemorySink();
  const log = new RecordingLogger();
  const saved: NetPauseState[] = [];
  const client = createHttpClient({
    clock: time,
    timers: time,
    log,
    sink,
    userAgent: () => UA,
    fetchImpl: fetch,
    secrets: new SecretRegistry(),
    onPausesChanged: (s) => saved.push(s),
    ...over,
  });
  return { time, calls, sink, log, client, last: () => saved[saved.length - 1]! };
}

describe('unavailable answers (F52)', () => {
  it('names exactly the server-side outage statuses', () => {
    expect([...UNAVAILABLE_STATUSES].sort((a, b) => a - b)).toEqual([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
    for (const s of [200, 304, 400, 401, 403, 404, 410, 429, 501, 505, 519, 528, 529, 531]) expect(isUnavailableStatus(s)).toBe(false);
  });

  it.each([500, 502, 504, 520, 522, 524, 530])('%i without a hint pauses the budget 60 s, then 120 s', async (status) => {
    const { client, calls, time, sink, log, last } = setup(() => jsonResponse({ error: 'bad gateway' }, { status }));
    const res = await client.request(PRICEDB);
    expect(res.status).toBe(status);
    expect(res.ok).toBe(false);
    expect(client.nextAllowedAt('pricedb')).toBe(T0 + 60_000);
    expect(last().budgets['pricedb']).toMatchObject({ until: T0 + 60_000, reason: `HTTP ${status}`, n429: 0, nBackoff: 1 });
    expect(sink.rows[0]!.note).toBe(`HTTP ${status}: pricedb paused 1 min (backoff)`);
    expect(log.calls.some((c) => c.level === 'warn' && c.msg.startsWith(`HTTP ${status} from pricedb.io`))).toBe(true);

    // The next request waits the pause out; a second failure doubles it.
    const next = client.request(PRICEDB, { maxWaitMs: HOUR });
    await time.advance(59_999);
    expect(calls).toHaveLength(1);
    await time.advance(1);
    await next;
    expect(calls[1]!.at).toBe(T0 + 60_000);
    expect(client.nextAllowedAt('pricedb')).toBe(T0 + 60_000 + 120_000);
    expect(client.budgets().find((b) => b.id === 'pricedb')!.consecutive429).toBe(0);
  });

  it('honours Retry-After on a 502', async () => {
    const { client, last } = setup(() => jsonResponse({}, { status: 502, headers: { 'retry-after': '45' } }));
    await client.request(PRICEDB);
    expect(client.nextAllowedAt('pricedb')).toBe(T0 + 45_000);
    expect(last().budgets['pricedb']).toMatchObject({ until: T0 + 45_000, reason: 'HTTP 502' });
  });

  it('a request inside the pause fails fast instead of reaching the failing host', async () => {
    const { client, calls } = setup(() => jsonResponse({}, { status: 504, headers: { 'retry-after': '600' } }));
    await client.request(PRICEDB);
    const err = await client.request(PRICEDB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAt).toBe(T0 + 600_000);
    expect(calls).toHaveLength(1);
  });

  it('a 502 between 429s neither counts nor ends the host streak: 429, 502, 429, 502, 429 pauses the host 1 h', async () => {
    const statuses = [429, 502, 429, 502, 429];
    const { client, sink, time } = setup(() => jsonResponse({}, { status: statuses.shift() ?? 200, headers: { 'retry-after': '1' } }));
    await client.request(SNAPSHOT);
    await client.request(USERS);
    await client.request(BPTF_MISC);
    await client.request(CURRENCIES);
    expect(sink.rows.some((r) => /x3/.test(r.note ?? ''))).toBe(false);
    await client.request(PRICES);
    expect(sink.rows[4]!.note).toMatch(/^HTTP 429 x3: api\.backpack\.tf paused 1 h/);
    for (const b of client.budgets().filter((x) => x.host === 'api.backpack.tf')) expect(b.pausedUntil).toBe(time.now() + HOUR);
  });

  it('on one budget, a 502 keeps its 429 count (the per-budget streak)', async () => {
    const statuses = [429, 502];
    const { client, time } = setup(() => jsonResponse({}, { status: statuses.shift() ?? 200, headers: { 'retry-after': '1' } }));
    await client.request(BPTF_MISC);
    const second = client.request(BPTF_MISC, { maxWaitMs: HOUR });
    await time.advance(10_000);
    await second;
    expect(client.budgets().find((b) => b.id === 'bptf-misc')!.consecutive429).toBe(1);
  });

  it.each([501, 404, 400])('%i still ends the streak and pauses nothing', async (status) => {
    const statuses = [429, 429, status, 429];
    const { client, sink } = setup(() => jsonResponse({}, { status: statuses.shift() ?? 200, headers: { 'retry-after': '1' } }));
    await client.request(SNAPSHOT);
    await client.request(USERS);
    await client.request(BPTF_MISC);
    expect(client.budgets().find((b) => b.id === 'bptf-misc')!.pausedUntil).toBeNull();
    expect(sink.rows[2]!.note).toBeNull();
    await client.request(CURRENCIES);
    expect(sink.rows.some((r) => /x3/.test(r.note ?? ''))).toBe(false);
  });

  it.each([502, 520, 522])('an HTML %i page backs off and never disables the host', async (status) => {
    const { client, sink } = setup(() =>
      textResponse('<!DOCTYPE html><html><body>Bad gateway (Cloudflare)</body></html>', { status, headers: { 'content-type': 'text/html; charset=UTF-8' } }),
    );
    const res = await client.request(PRICEDB, { expectJson: true });
    expect(res.status).toBe(status);
    expect(client.hostBlocked('pricedb.io')).toBeNull();
    expect(client.nextAllowedAt('pricedb')).toBe(T0 + 60_000);
    expect(sink.rows[0]!.note).toMatch(new RegExp(`HTTP ${status}: pricedb paused 1 min \\(backoff\\)`));
  });
});

describe('recordUnavailable reason (F52)', () => {
  const spec = BUDGETS.find((b) => b.id === 'pricedb')!;

  it('names the status, and stays HTTP 503 by default', () => {
    const time = new FakeTime();
    const s = new BudgetScheduler(spec, { clock: time, timers: time });
    s.recordUnavailable(null, T0, 502);
    expect(s.persistedState(T0)).toMatchObject({ until: T0 + 60_000, reason: 'HTTP 502', n429: 0, nBackoff: 1 });
    const t = new BudgetScheduler(spec, { clock: time, timers: time });
    t.recordUnavailable(5_000);
    expect(t.persistedState(T0)).toMatchObject({ until: T0 + 5_000, reason: 'HTTP 503' });
  });
});
