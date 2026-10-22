import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MAX_MS,
  BPTF_WS_URL,
  SILENCE_TIMEOUT_MS,
  STABLE_CONNECTION_MS,
  createBptfSocket,
  resetBptfSocketGuard,
} from '../../src/service/connectors/bptfSocket';
import type { FeedBatch, Repo } from '../../src/service/contracts';
import type { DeepPartial, Settings } from '../../src/shared/types';
import { FakeHttp, FakeSocket, createLogger, createStubSchema, loadFixture, settingsWith, type WsSample } from './helpers';

const T0 = new Date(2026, 9, 14, 12, 0, 0).getTime(); // local noon
const sample = loadFixture<WsSample>('ws-sample.json');
const updates = sample.events.filter((e) => e.event === 'listing-update');
const buyA = updates.find((e) => e.payload.intent === 'buy')!;
const sellA = updates.find((e) => e.payload.intent === 'sell')!;

function harness(opts: { settings?: DeepPartial<Settings>; http?: FakeHttp } = {}) {
  let settings = settingsWith(opts.settings);
  const sockets: FakeSocket[] = [];
  const batches: FeedBatch[] = [];
  const log = createLogger();
  const http = opts.http ?? new FakeHttp();
  const feed = createBptfSocket({
    clock: { now: () => Date.now() },
    log,
    repo: {} as Repo,
    http,
    settings: () => settings,
    secret: () => null,
    schema: createStubSchema(),
    onBatch: (b) => batches.push(b),
    wsFactory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  });
  return {
    feed,
    sockets,
    batches,
    log,
    http,
    last: () => sockets[sockets.length - 1]!,
    setSettings: (patch: DeepPartial<Settings>) => {
      settings = settingsWith(patch);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  resetBptfSocketGuard();
});

afterEach(() => {
  vi.useRealTimers();
  resetBptfSocketGuard();
});

describe('connection', () => {
  it('opens exactly one connection with the honest User-Agent', async () => {
    const h = harness();
    h.feed.start();
    h.feed.start();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().url).toBe(BPTF_WS_URL);
    expect(h.last().headers).toEqual({ 'User-Agent': 'TF2FlipDesk/0.1.0 (+https://example.test/contact)' });
    expect(h.feed.health().state).toBe('connecting');
    h.last().open();
    expect(h.feed.health().state).toBe('live');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sockets).toHaveLength(1);
    h.feed.stop();
    expect(h.last().closed).toEqual({ code: 1000, reason: 'stopped' });
    expect(h.feed.health().state).toBe('off');
  });

  it('refuses a second connection from the same process', async () => {
    const a = harness();
    const b = harness();
    a.feed.start();
    a.last().open();
    b.feed.start();
    expect(b.sockets).toHaveLength(0);
    expect(b.feed.health().state).toBe('error');
    expect(b.feed.health().lastError).toMatch(/already open/);
    a.feed.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.sockets).toHaveLength(1);
    b.feed.stop();
  });

  it('waits for a lingering close before reconnecting (no overlap)', async () => {
    const h = harness();
    h.feed.start();
    const first = h.last();
    first.open();
    first.lingerOnClose = true;
    h.feed.stop();
    expect(first.closed).toEqual({ code: 1000, reason: 'stopped' });
    h.feed.start();
    expect(h.sockets).toHaveLength(1);
    expect(h.feed.health().detail).toMatch(/previous connection/);
    const other = harness();
    other.feed.start();
    expect(other.sockets).toHaveLength(0);
    other.feed.stop();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.terminated).toBe(true);
    expect(h.sockets).toHaveLength(2);
    h.feed.stop();
  });

  it('does not connect without a valid User-Agent', async () => {
    const http = new FakeHttp();
    http.userAgent = () => {
      throw new Error('Refusing to send a browser-like User-Agent (R6)');
    };
    const h = harness({ http });
    h.feed.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.sockets).toHaveLength(0);
    expect(h.feed.health().state).toBe('error');
    h.feed.stop();
  });
});

describe('frames and batching', () => {
  it('batches upserts, deletes and names and flushes once per second', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    s.send([buyA, sellA]);
    s.send({ id: 'x', event: 'listing-delete', payload: { id: 'gone-1', appid: 440 } });
    expect(h.batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches).toHaveLength(1);
    const b = h.batches[0]!;
    expect(b.upserts.map((l) => l.id).sort()).toEqual([buyA.payload.id, sellA.payload.id].sort());
    expect(b.upserts.find((l) => l.intent === 'sell')).toBeDefined();
    expect(b.deletes).toEqual(['gone-1']);
    expect(b.names.map((n) => n.name).sort()).toEqual([buyA.payload.item.name, sellA.payload.item.name].sort());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.batches).toHaveLength(1);
    h.feed.stop();
  });

  it('keeps the last event per listing id within a batch', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    s.send([buyA, { id: 'd', event: 'listing-delete', payload: { id: buyA.payload.id } }]);
    s.send([{ id: 'd2', event: 'listing-delete', payload: { id: sellA.payload.id } }, sellA]);
    await vi.advanceTimersByTimeAsync(1_000);
    const b = h.batches[0]!;
    expect(b.deletes).toEqual([buyA.payload.id]);
    expect(b.upserts.map((l) => l.id)).toEqual([sellA.payload.id]);
    h.feed.stop();
  });

  it('0.9 (#11): drops an inactive listing-update like a delete and says so in inactive', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    const inactiveA = { ...buyA, payload: { ...buyA.payload, status: 'notEnoughCurrency' } };
    // An inactive update: a delete, reported as inactivity.
    s.send(inactiveA);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toMatchObject({ upserts: [], deletes: [buyA.payload.id], inactive: [buyA.payload.id] });
    // A plain delete: deletes only.
    s.send({ id: 'd', event: 'listing-delete', payload: { id: buyA.payload.id } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches).toHaveLength(2);
    expect(h.batches[1]).toMatchObject({ upserts: [], deletes: [buyA.payload.id], inactive: [] });
    // Inactive, then a delete of the same id in one window: a delete, no longer inactivity.
    s.send([inactiveA, { id: 'd2', event: 'listing-delete', payload: { id: buyA.payload.id } }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches[2]).toMatchObject({ deletes: [buyA.payload.id], inactive: [] });
    // Inactive, then active again in one window: the last event wins, an upsert with inactive empty.
    s.send([inactiveA, buyA]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches).toHaveLength(4);
    const back = h.batches[3]!;
    expect(back.upserts.map((l) => l.id)).toEqual([buyA.payload.id]);
    expect(back.deletes).toEqual([]);
    expect(back.inactive).toEqual([]);
    // The next window starts clean.
    s.send(buyA);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches[4]!.inactive).toEqual([]);
    h.feed.stop();
  });

  it('maps a whole captured stream, counting events and bytes', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    const frame = JSON.stringify(sample.events);
    s.send(frame);
    await vi.advanceTimersByTimeAsync(1_000);
    const st = h.feed.stats();
    expect(st.eventsToday).toBe(sample.events.length);
    expect(st.bytesToday).toBe(Buffer.byteLength(frame));
    expect(st.lastFrameAt).toBe(T0);
    expect(st.parseFailures).toBe(0);
    const b = h.batches[0]!;
    expect(b.upserts.length + b.deletes.length).toBe(new Set(sample.events.map((e) => e.payload.id)).size);
    h.feed.stop();
  });

  it('accepts a single-object frame and counts junk', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    s.send(buyA);
    s.send('not json');
    s.send([{ nope: true }, { event: 'listing-update', payload: { broken: true } }, { event: 'listing-delete', payload: {} }]);
    s.send({ event: 'something-new', payload: {} });
    s.emit('message', 12345, false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches[0]!.upserts).toHaveLength(1);
    expect(h.feed.stats().parseFailures).toBe(5);
    expect(h.feed.detail().unknownEvents).toBe(1);
    h.feed.stop();
  });

  it('drops other games and ignores the deal/user extras on deletes', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    const other = sample.synthetic.find((e) => e.payload.id.startsWith('730_'))!;
    s.send([other, { event: 'listing-delete', payload: { id: '730_1', appid: 730 } }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches).toHaveLength(0);
    expect(h.feed.stats().parseFailures).toBe(0);
    h.feed.stop();
  });

  it('accepts ArrayBuffer and fragmented Buffer[] frames', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    const text = JSON.stringify([buyA]);
    const ab = new TextEncoder().encode(text).buffer;
    s.emit('message', ab, false);
    const buf = Buffer.from(JSON.stringify([sellA]));
    s.emit('message', [buf.subarray(0, 10), buf.subarray(10)], false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches[0]!.upserts).toHaveLength(2);
    h.feed.stop();
  });

  it('survives an onBatch handler that throws', async () => {
    const h = harness();
    let calls = 0;
    const feed = createBptfSocket({
      clock: { now: () => Date.now() },
      log: h.log,
      repo: {} as Repo,
      http: new FakeHttp(),
      settings: () => settingsWith(),
      secret: () => null,
      schema: createStubSchema(),
      onBatch: () => {
        calls++;
        throw new Error('db locked');
      },
      wsFactory: (url, headers) => {
        const s = new FakeSocket(url, headers);
        h.sockets.push(s);
        return s;
      },
    });
    feed.start();
    h.last().open();
    h.last().send([buyA]);
    await vi.advanceTimersByTimeAsync(1_000);
    h.last().send([sellA]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(h.log.text()).toMatch(/onBatch failed: db locked/);
    expect(feed.health().state).toBe('live');
    feed.stop();
  });

  it('flushes pending events on stop', () => {
    const h = harness();
    h.feed.start();
    h.last().open();
    h.last().send([buyA]);
    h.feed.stop();
    expect(h.batches).toHaveLength(1);
  });
});

describe('reconnects', () => {
  it('backs off 1 s, 2 s, 4 s ... capped at 60 s', async () => {
    const h = harness();
    h.feed.start();
    const opened: number[] = [];
    const waits = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (const wait of waits) {
      h.last().serverClose(1006);
      expect(h.feed.health().state).toBe('backoff');
      const before = h.sockets.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(h.sockets.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets.length).toBe(before + 1);
      opened.push(Date.now());
    }
    expect(BACKOFF_MAX_MS).toBe(60_000);
    expect(h.feed.detail().reconnects).toBe(waits.length);
    h.feed.stop();
  });

  it('resets the backoff after a connection stayed up for a while', async () => {
    const h = harness();
    h.feed.start();
    for (const wait of [1_000, 2_000, 4_000]) {
      h.last().serverClose();
      await vi.advanceTimersByTimeAsync(wait);
    }
    h.last().open();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      h.last().send([buyA]);
    }
    const before = h.sockets.length;
    h.last().serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets.length).toBe(before + 1);
    h.feed.stop();
  });

  it('forces a reconnect after 120 s without frames', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    s.send([buyA]);
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 2_000);
    expect(s.terminated).toBe(false);
    s.emit('ping', Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 2_000);
    expect(s.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.terminated).toBe(true);
    expect(h.feed.health().lastError).toMatch(/No frames/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    h.feed.stop();
  });

  it('records socket errors and reconnects after the close', async () => {
    const h = harness();
    h.feed.start();
    h.last().emit('error', new Error('read ECONNRESET'));
    h.last().serverClose(1006);
    expect(h.feed.health()).toMatchObject({ state: 'backoff', lastError: 'read ECONNRESET' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    h.feed.stop();
  });
});

describe('refused upgrades (R7)', () => {
  /** Advances until just before `ms`, checks nothing new opened, then crosses it. */
  async function expectNextAttemptAfter(h: ReturnType<typeof harness>, ms: number): Promise<void> {
    const before = h.sockets.length;
    await vi.advanceTimersByTimeAsync(ms - 1_000);
    expect(h.sockets).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(before + 1);
  }

  it('honours Retry-After on a 429 upgrade', async () => {
    const h = harness();
    h.feed.start();
    h.last().reject(429, { retryAfter: '3600' });
    expect(h.last().terminated).toBe(true);
    const health = h.feed.health();
    expect(health.state).toBe('backoff');
    expect(health.lastError).toBe('backpack.tf refused the live feed connection (HTTP 429)');
    expect(health.detail).toMatch(/reconnecting in 60 min/);
    await expectNextAttemptAfter(h, 3_600_000);
    h.feed.stop();
  });

  it('waits at least 60 s, doubles, and pauses 1 h after three 429s in a row', async () => {
    const h = harness();
    h.feed.start();
    h.last().reject(429, { retryAfter: '2' });
    await expectNextAttemptAfter(h, 60_000);
    h.last().reject(429);
    await expectNextAttemptAfter(h, 120_000);
    h.last().reject(429);
    await expectNextAttemptAfter(h, 3_600_000);
    // A connection that opens (and stays up) ends the streak.
    h.last().open();
    await vi.advanceTimersByTimeAsync(STABLE_CONNECTION_MS);
    h.last().send([buyA]);
    h.last().serverClose(1006);
    await expectNextAttemptAfter(h, 1_000);
    h.last().reject(429);
    await expectNextAttemptAfter(h, 60_000);
    h.feed.stop();
  });

  it('backs off at least 60 s on other non-101 answers (redirects, 404, 502)', async () => {
    const h = harness();
    h.feed.start();
    h.last().reject(302);
    await expectNextAttemptAfter(h, 60_000);
    h.last().reject(404, { contentType: 'text/html' });
    await expectNextAttemptAfter(h, 120_000);
    h.last().reject(502);
    expect(h.feed.health()).toMatchObject({ state: 'backoff', lastError: 'backpack.tf refused the live feed connection (HTTP 502)' });
    await expectNextAttemptAfter(h, 240_000);
    h.feed.stop();
  });

  it('keeps the server-requested wait across a network pause and resume', async () => {
    const h = harness();
    h.feed.start();
    h.last().reject(503, { retryAfter: '600' });
    h.setSettings({ networkPaused: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.feed.health().state).toBe('paused');
    h.setSettings({});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.feed.health()).toMatchObject({ state: 'backoff' });
    expect(h.feed.health().detail).toMatch(/HTTP 503.*reconnecting in 10 min/);
    h.feed.stop();
    h.feed.start();
    expect(h.sockets).toHaveLength(1);
    // 4 s have passed; the server asked for 600 s.
    await vi.advanceTimersByTimeAsync(600_000 - 4_000 - 1_000);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    h.feed.stop();
  });

  const refusals: [string, number, { cfMitigated?: string; contentType?: string }, RegExp][] = [
    ['a Cloudflare challenge', 403, { cfMitigated: 'challenge', contentType: 'text/html; charset=UTF-8' }, /HTTP 403, Cloudflare challenge/],
    ['a challenge on any status', 429, { cfMitigated: 'challenge' }, /HTTP 429, Cloudflare challenge/],
    ['an HTML 403', 403, { contentType: 'text/html' }, /HTTP 403, HTML page/],
    ['an HTML 503', 503, { contentType: 'text/html' }, /HTTP 503, HTML page/],
    ['a JSON 403', 403, { contentType: 'application/json' }, /HTTP 403\)/],
    ['a 401', 401, {}, /HTTP 401\)/],
  ];
  for (const [label, status, headers, reason] of refusals) {
    it(`stops on ${label} and never retries automatically`, async () => {
      const h = harness();
      h.feed.start();
      h.last().reject(status, headers);
      const health = h.feed.health();
      expect(health.state).toBe('blocked');
      expect(health.disabledReason).toMatch(reason);
      expect(health.disabledReason).toMatch(/turn the live feed off and on again/);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.sockets).toHaveLength(1);
      expect(h.feed.health().state).toBe('blocked');
      h.feed.stop();
    });
  }

  it('a network pause and resume does not clear a challenge block; the live-feed toggle does', async () => {
    const h = harness();
    h.feed.start();
    h.last().reject(403, { cfMitigated: 'challenge' });
    // core.syncFeed: networkPaused on -> stop(), off -> start()
    h.setSettings({ networkPaused: true });
    h.feed.stop();
    h.setSettings({});
    h.feed.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.feed.health().state).toBe('blocked');
    // core.syncFeed: liveFeed.enabled off -> stop(), on -> start()
    h.setSettings({ liveFeed: { enabled: false } });
    h.feed.stop();
    h.setSettings({ liveFeed: { enabled: true } });
    h.feed.start();
    expect(h.sockets).toHaveLength(2);
    expect(h.feed.health()).toMatchObject({ state: 'connecting', disabledReason: null });
    h.feed.stop();
  });

  it('ignores a rejection reported by a socket it already replaced', async () => {
    const h = harness();
    h.feed.start();
    const first = h.last();
    first.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    first.reject(403, { cfMitigated: 'challenge' });
    expect(h.feed.health().state).toBe('connecting');
    h.feed.stop();
  });
});

describe('server limits', () => {
  for (const event of ['client-limit-exceeeded', 'client-limit-exceeded']) {
    it(`stops on ${event} and does not reconnect until restarted`, async () => {
      const h = harness();
      h.feed.start();
      const s = h.last();
      s.open();
      s.send([buyA, { id: 'z', event, payload: null }, sellA]);
      expect(s.terminated).toBe(true);
      const health = h.feed.health();
      expect(health.state).toBe('blocked');
      expect(health.disabledReason).toMatch(/too many connections/);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.sockets).toHaveLength(1);
      // events before the limit message are still delivered
      expect(h.batches.flatMap((b) => b.upserts.map((l) => l.id))).toEqual([buyA.payload.id]);
      h.feed.stop();
      expect(h.feed.health().state).toBe('blocked');
      // Turning the live feed off and on in Settings (core: stop() then start()) clears it.
      h.setSettings({ liveFeed: { enabled: false } });
      h.feed.stop();
      h.setSettings({});
      h.feed.start();
      expect(h.sockets).toHaveLength(2);
      expect(h.feed.health().disabledReason).toBeNull();
      h.feed.stop();
    });
  }

  it('keeps the client-limit stop across a network pause and resume', async () => {
    const h = harness();
    h.feed.start();
    h.last().open();
    h.last().send({ event: 'client-limit-exceeeded', payload: null });
    expect(h.feed.health().state).toBe('blocked');
    // core.syncFeed on "Pause all network" and on resume
    h.setSettings({ networkPaused: true });
    h.feed.stop();
    h.setSettings({});
    h.feed.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.feed.health()).toMatchObject({ state: 'blocked' });
    expect(h.feed.health().disabledReason).toMatch(/too many connections/);
    // A live-feed toggle while the network is paused still counts once it resumes.
    h.setSettings({ networkPaused: true });
    h.feed.stop();
    h.setSettings({ networkPaused: true, liveFeed: { enabled: false } });
    h.feed.stop();
    h.setSettings({ networkPaused: true });
    h.feed.stop();
    h.setSettings({});
    h.feed.start();
    expect(h.sockets).toHaveLength(2);
    h.feed.stop();
  });

  it('logs buffer-limit-exceeded and keeps going', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    s.send([{ event: 'buffer-limit-exceeded', payload: null }, buyA]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.feed.detail().bufferLimitEvents).toBe(1);
    expect(h.log.text()).toMatch(/buffer-limit-exceeded/);
    expect(s.terminated).toBe(false);
    expect(h.batches[0]!.upserts).toHaveLength(1);
    h.feed.stop();
  });
});

describe('settings, pause and the daily byte cap', () => {
  it('stays off while the live feed is disabled and connects when enabled', async () => {
    const h = harness({ settings: { liveFeed: { enabled: false } } });
    h.feed.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.feed.health()).toMatchObject({ state: 'off', detail: 'Live feed is turned off in Settings' });
    h.setSettings({ liveFeed: { enabled: true } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(1);
    h.last().open();
    h.setSettings({ liveFeed: { enabled: false } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.last().closed?.reason).toBe('paused');
    expect(h.feed.health().state).toBe('off');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    h.feed.stop();
  });

  it('pauses with the network kill switch (settings or HTTP client)', async () => {
    const h = harness({ settings: { networkPaused: true } });
    h.feed.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.feed.health().state).toBe('paused');
    h.setSettings({});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(1);
    h.last().open();
    h.http.setPaused(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.last().closed).not.toBeNull();
    expect(h.feed.health().state).toBe('paused');
    h.http.setPaused(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    h.feed.stop();
  });

  it('stops at the daily byte cap and resumes after local midnight', async () => {
    const frame = JSON.stringify([buyA]);
    const cap = Buffer.byteLength(frame) * 3;
    const h = harness({ settings: { liveFeed: { dailyCapBytes: cap } } });
    h.feed.start();
    const s = h.last();
    s.open();
    s.send(frame);
    s.send(frame);
    expect(s.terminated).toBe(false);
    s.send(frame);
    expect(s.terminated).toBe(true);
    expect(h.feed.health().state).toBe('paused');
    expect(h.feed.health().detail).toMatch(/Daily data cap reached/);
    expect(h.feed.stats().bytesToday).toBe(cap);
    expect(h.batches.length).toBe(1);

    const midnight = new Date(2026, 9, 15, 0, 0, 0).getTime();
    await vi.advanceTimersByTimeAsync(midnight - Date.now() - 2_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.feed.health().state).toBe('paused');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.feed.stats()).toMatchObject({ eventsToday: 0, bytesToday: 0 });
    h.feed.stop();
  });

  for (const [label, raised] of [
    ['raising', 'double'],
    ['removing (0)', 'zero'],
  ] as const) {
    it(`resumes within a second after ${label} the daily cap`, async () => {
      const frame = JSON.stringify([buyA]);
      const cap = Buffer.byteLength(frame) * 2;
      const h = harness({ settings: { liveFeed: { dailyCapBytes: cap } } });
      h.feed.start();
      h.last().open();
      h.last().send(frame);
      h.last().send(frame);
      expect(h.last().terminated).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.sockets).toHaveLength(1);
      expect(h.feed.health().state).toBe('paused');
      h.setSettings({ liveFeed: { dailyCapBytes: raised === 'double' ? cap * 2 : 0 } });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(2);
      expect(h.feed.health().state).toBe('connecting');
      expect(h.log.text()).toMatch(/data cap raised or removed; resuming/);
      expect(h.feed.stats().bytesToday).toBe(cap);
      h.feed.stop();
    });
  }

  it('pauses on the next tick when the cap is lowered below today’s usage', async () => {
    const frame = JSON.stringify([buyA]);
    const h = harness();
    h.feed.start();
    h.last().open();
    h.last().send(frame);
    h.setSettings({ liveFeed: { dailyCapBytes: 1 } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.last().closed?.reason).toBe('paused');
    expect(h.feed.health()).toMatchObject({ state: 'paused' });
    expect(h.feed.health().detail).toMatch(/Daily data cap reached/);
    h.feed.stop();
  });

  it('resets daily counters at midnight while connected', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    const tick = setInterval(() => s.send([buyA]), 60_000);
    s.send([buyA]);
    expect(h.feed.stats().eventsToday).toBe(1);
    const midnight = new Date(2026, 9, 15, 0, 0, 30).getTime();
    await vi.advanceTimersByTimeAsync(midnight - Date.now());
    clearInterval(tick);
    expect(h.feed.stats().eventsToday).toBeLessThanOrEqual(1);
    h.feed.stop();
  });
});

describe('health', () => {
  it('reports the feed connector', async () => {
    const h = harness();
    expect(h.feed.health()).toMatchObject({ id: 'bptf-ws', state: 'off', detail: 'Not started' });
    h.feed.start();
    h.last().open();
    h.last().send([buyA, sellA]);
    const health = h.feed.health();
    expect(health).toMatchObject({ id: 'bptf-ws', label: 'backpack.tf live feed', state: 'live', lastOkAt: T0, disabledReason: null });
    expect(health.detail).toMatch(/^2 events today/);
    h.feed.stop();
  });
});
