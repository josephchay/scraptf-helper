// Budget pauses (429/503 Retry-After, backoff, RateLimit-Remaining) and 429
// streaks survive a restart (R7), the "3 consecutive 429s -> pause the host
// for 1 h" rule counts per host across its budgets, and blockHost() stores a
// block for connections that bypass request(). Fake fetch and time only.

import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../src/service/net/errors';
import {
  buildUserAgent,
  createHttpClient,
  parsePauseState,
  type CreateHttpClientOptions,
  type NetPauseState,
} from '../../src/service/net/http';
import { SecretRegistry } from '../../src/service/net/redact';
import { FakeTime, MemorySink, RecordingLogger, T0, createFakeFetch, jsonResponse, type FetchHandler } from './helpers';

const UA = buildUserAgent('0.1.0', 'https://example.invalid/contact');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PRICEDB = 'https://pricedb.io/api/item/5021;6';
const SNAPSHOT = 'https://api.backpack.tf/api/classifieds/listings/snapshot';
const USERS = 'https://api.backpack.tf/api/users/info/v1';
const BPTF_MISC = 'https://api.backpack.tf/api/notifications';

function setup(handler: FetchHandler, over: Partial<CreateHttpClientOptions> = {}, time = new FakeTime()) {
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
  return { time, calls, sink, log, client, saved, last: () => saved[saved.length - 1]! };
}

/** What the core stores in repo meta and reads back at the next start. */
const roundTrip = (s: NetPauseState): NetPauseState => parsePauseState(JSON.stringify(s));

const ok = () => jsonResponse({ ok: true });
const tooMany = (retryAfter = '1') => () => jsonResponse({}, { status: 429, headers: { 'retry-after': retryAfter } });

describe('pauses survive a restart', () => {
  it('a restarted client keeps honouring a 429 Retry-After', async () => {
    const a = setup(tooMany('3600'));
    await a.client.request(SNAPSHOT);
    expect(a.client.nextAllowedAt('bptf-snapshot')).toBe(T0 + HOUR);
    expect(a.last().budgets['bptf-snapshot']).toEqual({ until: T0 + HOUR, reason: 'HTTP 429', n429: 1, nBackoff: 1 });

    // Restart 20 s later, with the request log only knowing the request time.
    const time = new FakeTime(T0 + 20_000);
    const b = setup(ok, { initialPauses: roundTrip(a.last()) }, time);
    expect(b.client.nextAllowedAt('bptf-snapshot')).toBe(T0 + HOUR);
    const budget = b.client.budgets().find((x) => x.id === 'bptf-snapshot')!;
    expect(budget.pausedUntil).toBe(T0 + HOUR);
    expect(budget.consecutive429).toBe(1);
    const err = await b.client.request(SNAPSHOT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(b.calls).toHaveLength(0);
    // Restoring alone writes nothing.
    expect(b.saved).toEqual([]);
  });

  it('keeps a 503 pause and a RateLimit-Remaining pause', async () => {
    const a = setup(() => jsonResponse({}, { status: 503, headers: { 'retry-after': '600' } }));
    await a.client.request(PRICEDB);
    expect(a.last().budgets['pricedb']).toMatchObject({ until: T0 + 600_000, reason: 'HTTP 503' });
    const b = setup(ok, { initialPauses: roundTrip(a.last()) }, new FakeTime(T0 + 1_000));
    expect(b.client.nextAllowedAt('pricedb')).toBe(T0 + 600_000);

    const c = setup(() => jsonResponse({}, { headers: { 'ratelimit-remaining': '3', 'ratelimit-reset': '45' } }));
    await c.client.request(PRICEDB);
    expect(c.last().budgets['pricedb']).toMatchObject({ until: T0 + 45_000, reason: 'RateLimit-Remaining 3' });
    const d = setup(ok, { initialPauses: roundTrip(c.last()) }, new FakeTime(T0 + 1_000));
    expect(d.client.nextAllowedAt('pricedb')).toBe(T0 + 45_000);
  });

  it('continues the 429 streak: the third 429 after a restart pauses the host for 1 h', async () => {
    const a = setup(tooMany());
    await a.client.request(BPTF_MISC);
    await a.time.advance(60_000);
    await a.client.request(BPTF_MISC);
    expect(a.last().budgets['bptf-misc']).toMatchObject({ n429: 2 });
    expect(a.last().hosts429).toEqual({ 'api.backpack.tf': 2 });

    const time = new FakeTime(a.time.now() + 5 * 60_000);
    const b = setup(tooMany(), { initialPauses: roundTrip(a.last()) }, time);
    await b.client.request(BPTF_MISC);
    expect(b.sink.rows[0]!.note).toMatch(/^HTTP 429 x3: api\.backpack\.tf paused 1 h/);
    for (const budget of b.client.budgets().filter((x) => x.host === 'api.backpack.tf')) {
      expect(budget.pausedUntil).toBe(time.now() + HOUR);
    }
  });

  it('clamps a restored pause to 24 h and ignores malformed entries', () => {
    const time = new FakeTime(T0);
    const raw = JSON.stringify({
      budgets: {
        'bptf-snapshot': { until: T0 + 30 * DAY, reason: 'HTTP 429', n429: 1, nBackoff: 1 },
        'bptf-prices': { until: 'soon', n429: -4, nBackoff: 'x' },
        'no-such-budget': { until: T0 + HOUR, reason: 'x', n429: 1, nBackoff: 1 },
        pricedb: 'not an object',
        sku: { until: T0 - 1_000, reason: 'over', n429: 0, nBackoff: 0 },
      },
      hosts429: { 'api.backpack.tf': 2, 'bad host!': 3, 'pricedb.io': 'many', 'sku.pricedb.io': -1 },
    });
    const parsed = parsePauseState(raw);
    expect(parsed.hosts429).toEqual({ 'api.backpack.tf': 2 });
    const { client } = setup(ok, { initialPauses: parsed }, time);
    expect(client.nextAllowedAt('bptf-snapshot')).toBe(T0 + DAY);
    expect(client.nextAllowedAt('bptf-prices')).toBe(T0);
    expect(client.nextAllowedAt('pricedb')).toBe(T0);
    expect(client.nextAllowedAt('sku')).toBe(T0);
    expect(client.budgets().find((x) => x.id === 'bptf-prices')!.consecutive429).toBe(0);
  });

  it.each(['', '{not json', '[]', 'null', '42', '{"budgets":[1,2],"hosts429":"x"}'])('parses %j as no pauses', (raw) => {
    expect(parsePauseState(raw)).toEqual({ budgets: {}, hosts429: {} });
  });

  it('a clock that moved back cannot stretch a restored pause beyond 24 h', () => {
    // Saved "an hour from now" by a clock that was 3 days ahead.
    const saved: NetPauseState = { budgets: { scm: { until: T0 + 3 * DAY + HOUR, reason: 'HTTP 429', n429: 1, nBackoff: 1 } }, hosts429: {} };
    const { client } = setup(ok, { initialPauses: saved });
    expect(client.nextAllowedAt('scm')).toBe(T0 + DAY);
  });

  it('writes a clamped pause back, so restarts cannot keep re-clamping it past 24 h', () => {
    let stored: NetPauseState = {
      budgets: { 'bptf-snapshot': { until: T0 + 30 * DAY, reason: 'HTTP 429', n429: 1, nBackoff: 1 } },
      hosts429: { 'api.backpack.tf': 9 },
    };
    // A restart every 20 h, with no request in between (the budget is paused).
    for (let i = 0; i < 4; i++) {
      const time = new FakeTime(T0 + i * 20 * HOUR);
      const run = setup(ok, { initialPauses: roundTrip(stored) }, time);
      expect(run.client.nextAllowedAt('bptf-snapshot')).toBeLessThanOrEqual(Math.max(time.now(), T0 + DAY));
      if (run.saved.length > 0) stored = run.last();
    }
    // The pause is over; the streak is kept.
    expect(stored.budgets['bptf-snapshot']).toEqual({ until: 0, reason: null, n429: 1, nBackoff: 1 });
    expect(stored.hosts429).toEqual({ 'api.backpack.tf': 3 });
  });

  it('saves only on change, and clears the state after the streak ends', async () => {
    let first = true;
    const { client, time, saved, last } = setup(() => {
      if (first) {
        first = false;
        return jsonResponse({}, { status: 429, headers: { 'retry-after': '30' } });
      }
      return ok();
    });
    await client.request(PRICEDB);
    expect(saved).toHaveLength(1);
    const p = client.request(PRICEDB);
    await time.advance(30_000);
    await p;
    expect(saved).toHaveLength(2);
    expect(last()).toEqual({ budgets: {}, hosts429: {} });
    await time.advance(1_000);
    await client.request(PRICEDB);
    await time.advance(1_000);
    await client.request(PRICEDB);
    expect(saved).toHaveLength(2);
  });

  it('a failing save is logged and tried again on the next change', async () => {
    let fail = true;
    const states: NetPauseState[] = [];
    const { client, time, log } = setup(tooMany('5'), {
      onPausesChanged: (s) => {
        if (fail) throw new Error('disk full');
        states.push(s);
      },
    });
    await client.request(PRICEDB);
    expect(log.calls.some((c) => c.level === 'warn' && /saving the request pauses failed: disk full/.test(c.msg))).toBe(true);
    fail = false;
    await time.advance(5_000);
    await client.request(PRICEDB);
    expect(states).toHaveLength(1);
    expect(states[0]!.budgets['pricedb']).toMatchObject({ n429: 2 });
  });
});

describe('consecutive 429s are counted per host', () => {
  it('three 429s in a row from one host on three budgets pause the whole host for 1 h', async () => {
    const { client, calls, sink, time } = setup(tooMany());
    await client.request(SNAPSHOT);
    await client.request(USERS);
    expect(client.budgets().every((b) => b.pausedUntil === null || b.pausedUntil < T0 + HOUR)).toBe(true);
    await client.request(BPTF_MISC);
    expect(calls).toHaveLength(3);
    expect(sink.rows[2]!.note).toMatch(/^HTTP 429 x3: api\.backpack\.tf paused 1 h/);
    const bptf = client.budgets().filter((b) => b.host === 'api.backpack.tf');
    for (const b of bptf) expect(b.pausedUntil).toBe(time.now() + HOUR);
    // Each budget saw one 429; the host saw three.
    expect(bptf.find((b) => b.id === 'bptf-misc')!.consecutive429).toBe(1);
    expect(client.budgets().find((b) => b.host === 'pricedb.io')!.pausedUntil).toBeNull();
  });

  it('any other answer from the host ends the streak; other hosts do not', async () => {
    const status: Record<string, number> = {};
    const { client, sink } = setup((call) => {
      const s = status[new URL(call.url).pathname] ?? 429;
      return s === 429 ? jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }) : ok();
    });
    status['/api/item/5021;6'] = 429;
    status['/api/notifications'] = 200;
    await client.request(SNAPSHOT); // 1
    await client.request(PRICEDB); // another host: no effect on api.backpack.tf
    await client.request(USERS); // 2
    await client.request(BPTF_MISC); // 200: streak over
    await client.request('https://api.backpack.tf/api/IGetCurrencies/v1'); // 1
    expect(sink.rows.some((r) => /x3/.test(r.note ?? ''))).toBe(false);
    expect(client.budgets().find((b) => b.id === 'bptf-misc')!.pausedUntil).toBeNull();
  });

  it('a 503 neither counts nor ends the streak', async () => {
    const statuses = [429, 503, 429, 429];
    const { client, sink } = setup(() => {
      const s = statuses.shift() ?? 200;
      return jsonResponse({}, { status: s, headers: { 'retry-after': '1' } });
    });
    await client.request(SNAPSHOT);
    await client.request(USERS);
    await client.request(BPTF_MISC);
    expect(sink.rows.some((r) => /x3/.test(r.note ?? ''))).toBe(false);
    await client.request('https://api.backpack.tf/api/IGetCurrencies/v1');
    expect(sink.rows[3]!.note).toMatch(/^HTTP 429 x3: api\.backpack\.tf paused 1 h/);
  });
});

describe('blockHost', () => {
  it('stores a block for a host that request() never reaches, until unblockHost', () => {
    const blocks: Record<string, string>[] = [];
    const { client, log } = setup(ok, { onBlocksChanged: (b) => blocks.push(b) });
    client.blockHost('WS.Backpack.TF.', 'refused the upgrade (HTTP 403)');
    expect(client.hostBlocked('ws.backpack.tf')).toBe('refused the upgrade (HTTP 403)');
    expect(blocks).toEqual([{ 'ws.backpack.tf': 'refused the upgrade (HTTP 403)' }]);
    expect(log.calls.some((c) => c.level === 'warn' && /ws\.backpack\.tf disabled/.test(c.msg))).toBe(true);
    // Same reason again: nothing to save.
    client.blockHost('ws.backpack.tf', 'refused the upgrade (HTTP 403)');
    expect(blocks).toHaveLength(1);
    client.unblockHost('ws.backpack.tf');
    expect(client.hostBlocked('ws.backpack.tf')).toBeNull();
    expect(blocks[1]).toEqual({});
  });

  it('blocks requests to an HTTP host and ignores invalid host names', async () => {
    const { client, calls } = setup(ok);
    client.blockHost('pricedb.io', '');
    expect(client.hostBlocked('pricedb.io')).toMatch(/disabled/);
    await expect(client.request(PRICEDB)).rejects.toThrow(/pricedb\.io/);
    expect(calls).toHaveLength(0);
    client.blockHost('not a host', 'x');
    expect(client.hostBlocked('not a host')).toBeNull();
  });
});
