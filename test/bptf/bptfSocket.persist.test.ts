// A refused live-feed upgrade outlives the process (R7, brief §2.0): a
// challenge or 401/403 is stored as a ws.backpack.tf host block and a 429/503
// wait as repo meta, so a crash restart or relaunch does not reconnect early.
// Each "process" is a new createBptfSocket over the same stored state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BPTF_WS_HOST,
  META_FEED_RETRY,
  createBptfSocket,
  resetBptfSocketGuard,
} from '../../src/service/connectors/bptfSocket';
import type { Repo } from '../../src/service/contracts';
import type { DeepPartial, Settings } from '../../src/shared/types';
import { FakeHttp, FakeSocket, createLogger, createStubSchema, settingsWith } from './helpers';

const T0 = new Date(2026, 9, 14, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Repo meta and host blocks shared by successive "processes". */
function store() {
  const meta = new Map<string, string>();
  const repo = {
    getMeta: (k: string) => meta.get(k) ?? null,
    setMeta: (k: string, v: string) => void meta.set(k, v),
  } as unknown as Repo;
  return { meta, repo, http: new FakeHttp() };
}

function launch(s: ReturnType<typeof store>, opts: { settings?: DeepPartial<Settings> } = {}) {
  let settings = settingsWith(opts.settings);
  const sockets: FakeSocket[] = [];
  const log = createLogger();
  const feed = createBptfSocket({
    clock: { now: () => Date.now() },
    log,
    repo: s.repo,
    http: s.http,
    settings: () => settings,
    secret: () => null,
    schema: createStubSchema(),
    onBatch: () => undefined,
    wsFactory: (url, headers) => {
      const sock = new FakeSocket(url, headers);
      sockets.push(sock);
      return sock;
    },
  });
  return {
    feed,
    sockets,
    log,
    last: () => sockets[sockets.length - 1]!,
    setSettings: (patch: DeepPartial<Settings>) => {
      settings = settingsWith(patch);
    },
  };
}

/** Ends a "process" the way a crash or quit does: nothing of its memory survives. */
function exit(p: ReturnType<typeof launch>): void {
  p.feed.stop();
  resetBptfSocketGuard();
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  resetBptfSocketGuard();
});

afterEach(() => {
  vi.useRealTimers();
  resetBptfSocketGuard();
});

describe('refusal blocks across restarts', () => {
  it.each([
    ['a Cloudflare challenge', 403, { cfMitigated: 'challenge', contentType: 'text/html' }],
    ['HTTP 401', 401, {}],
    ['an HTML 503', 503, { contentType: 'text/html; charset=UTF-8' }],
  ] as const)('%s is stored and a restarted feed opens nothing', async (_label, status, headers) => {
    const s = store();
    const one = launch(s);
    one.feed.start();
    one.last().reject(status, headers);
    expect(one.feed.health().state).toBe('blocked');
    expect(s.http.hostBlocked(BPTF_WS_HOST)).toMatch(new RegExp(`HTTP ${status}`));
    exit(one);

    const two = launch(s);
    expect(two.feed.health()).toMatchObject({ state: 'blocked', disabledReason: s.http.hostBlocked(BPTF_WS_HOST) });
    two.feed.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(two.sockets).toHaveLength(0);
    expect(two.feed.health().state).toBe('blocked');
    exit(two);
  });

  it('re-enabling ws.backpack.tf (net.unblock) connects again', async () => {
    const s = store();
    const one = launch(s);
    one.feed.start();
    one.last().reject(403);
    exit(one);

    const two = launch(s);
    two.feed.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(two.sockets).toHaveLength(0);
    s.http.unblockHost(BPTF_WS_HOST); // what net.unblock does first
    two.feed.unblock();
    expect(two.sockets).toHaveLength(1);
    two.last().open();
    expect(two.feed.health().state).toBe('live');
    exit(two);
  });

  it('unblock() before start only clears the block', async () => {
    const s = store();
    s.http.blockHost(BPTF_WS_HOST, 'refused (HTTP 403)');
    const p = launch(s);
    p.feed.unblock();
    expect(s.http.hostBlocked(BPTF_WS_HOST)).toBeNull();
    expect(p.feed.health().state).toBe('off');
    p.feed.start();
    expect(p.sockets).toHaveLength(1);
    exit(p);
  });

  it('the live-feed toggle clears the stored block too', async () => {
    const s = store();
    const one = launch(s);
    one.feed.start();
    one.last().reject(403, { cfMitigated: 'challenge' });
    exit(one);

    const two = launch(s);
    two.feed.start();
    expect(two.sockets).toHaveLength(0);
    // A network pause and resume does not clear it...
    two.feed.stop();
    two.feed.start();
    expect(two.sockets).toHaveLength(0);
    // ...turning the live feed off and on in Settings does.
    two.setSettings({ liveFeed: { enabled: false } });
    two.feed.stop();
    two.setSettings({ liveFeed: { enabled: true } });
    two.feed.start();
    expect(two.sockets).toHaveLength(1);
    expect(s.http.hostBlocked(BPTF_WS_HOST)).toBeNull();
    exit(two);

    // And the next process does not bring it back.
    const three = launch(s);
    three.feed.start();
    expect(three.sockets).toHaveLength(1);
    exit(three);
  });

  it('a block stored while the feed runs is honoured on the next connection attempt', async () => {
    const s = store();
    const p = launch(s);
    p.feed.start();
    p.last().open();
    s.http.blockHost(BPTF_WS_HOST, 'refused elsewhere (HTTP 403)');
    p.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(p.sockets).toHaveLength(1);
    expect(p.feed.health()).toMatchObject({ state: 'blocked', disabledReason: 'refused elsewhere (HTTP 403)' });
    exit(p);
  });

  it('keeps the client-limit stop in memory only (restarting the app is its reset)', async () => {
    const s = store();
    const one = launch(s);
    one.feed.start();
    one.last().open();
    one.last().send({ event: 'client-limit-exceeeded' });
    expect(one.feed.health().state).toBe('blocked');
    expect(s.http.hostBlocked(BPTF_WS_HOST)).toBeNull();
    exit(one);

    const two = launch(s);
    two.feed.start();
    expect(two.sockets).toHaveLength(1);
    exit(two);
  });
});

describe('server-requested waits across restarts', () => {
  it('a 429 Retry-After holds in the next process', async () => {
    const s = store();
    const one = launch(s);
    one.feed.start();
    one.last().reject(429, { retryAfter: '3600' });
    expect(JSON.parse(s.meta.get(META_FEED_RETRY)!)).toMatchObject({ until: T0 + HOUR, n429: 1, rejections: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    exit(one);

    const two = launch(s);
    two.feed.start();
    expect(two.sockets).toHaveLength(0);
    expect(two.feed.health().state).toBe('backoff');
    expect(two.feed.health().detail).toMatch(/HTTP 429.*reconnecting in 60 min/);
    await vi.advanceTimersByTimeAsync(HOUR - 10_000 - 1_000);
    expect(two.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(two.sockets).toHaveLength(1);
    // A connection that opens clears the stored wait.
    two.last().open();
    expect(s.meta.get(META_FEED_RETRY)).toBe('');
    exit(two);

    const three = launch(s);
    three.feed.start();
    expect(three.sockets).toHaveLength(1);
    exit(three);
  });

  it('continues the 429 streak: the third 429 in a row waits an hour even across restarts', async () => {
    const s = store();
    const one = launch(s);
    one.feed.start();
    one.last().reject(429);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(one.sockets).toHaveLength(2);
    one.last().reject(429);
    exit(one);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const two = launch(s);
    two.feed.start();
    expect(two.sockets).toHaveLength(1);
    two.last().reject(429);
    expect(two.feed.health().detail).toMatch(/reconnecting in 60 min/);
    await vi.advanceTimersByTimeAsync(HOUR - 2_000);
    expect(two.sockets).toHaveLength(1);
    exit(two);
  });

  it('the live-feed toggle does not shorten the server-requested wait', async () => {
    const s = store();
    const one = launch(s);
    one.feed.start();
    one.last().reject(503, { retryAfter: '600' });
    exit(one);

    const two = launch(s);
    two.setSettings({ liveFeed: { enabled: false } });
    two.feed.stop();
    two.setSettings({ liveFeed: { enabled: true } });
    two.feed.start();
    await vi.advanceTimersByTimeAsync(590_000);
    expect(two.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(two.sockets).toHaveLength(1);
    exit(two);
  });

  it('clamps a stored wait to 24 h and ignores unreadable values', async () => {
    const s = store();
    s.meta.set(META_FEED_RETRY, JSON.stringify({ until: T0 + 30 * DAY, why: 'HTTP 429', n429: 1, rejections: 1 }));
    const p = launch(s);
    p.feed.start();
    await vi.advanceTimersByTimeAsync(DAY - 2_000);
    expect(p.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(p.sockets).toHaveLength(1);
    exit(p);

    for (const raw of ['{not json', '[]', '"x"', JSON.stringify({ until: 'later', n429: 'many' })]) {
      const g = store();
      g.meta.set(META_FEED_RETRY, raw);
      const q = launch(g);
      q.feed.start();
      expect(q.sockets).toHaveLength(1);
      exit(q);
    }
  });

  it('writes a clamped wait back, so restarts cannot keep re-clamping it past 24 h', async () => {
    const s = store();
    s.meta.set(META_FEED_RETRY, JSON.stringify({ until: T0 + 30 * DAY, why: 'HTTP 429', n429: 1, rejections: 1 }));
    // A relaunch every 20 h; the stored wait must end 24 h after the first run read it.
    for (let i = 0; i < 2; i++) {
      const p = launch(s);
      p.feed.start();
      expect(p.sockets).toHaveLength(0);
      exit(p);
      await vi.advanceTimersByTimeAsync(20 * HOUR);
    }
    // 40 h after the first run: the clamped wait (24 h) is over.
    const p = launch(s);
    p.feed.start();
    expect(p.sockets).toHaveLength(1);
    exit(p);
  });

  it('works without stored state (a repo that cannot store meta)', async () => {
    const http = new FakeHttp();
    const p = launch({ meta: new Map(), repo: {} as Repo, http });
    p.feed.start();
    p.last().reject(429, { retryAfter: '120' });
    expect(p.feed.health().state).toBe('backoff');
    expect(p.log.text()).toMatch(/could not save the reconnect wait/);
    exit(p);
  });
});
