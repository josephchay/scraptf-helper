// Audit bptfnet-4 / xlifecycle-3: a connection the app closes itself (the silence
// watchdog, a sleep/resume) must reset the reconnect backoff when it was healthy,
// like a server close does. A connection that never delivered anything keeps
// backing off.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STABLE_CONNECTION_MS, createBptfSocket, resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { Repo } from '../../src/service/contracts';
import type { DeepPartial, Settings } from '../../src/shared/types';
import { FakeHttp, FakeSocket, createLogger, createStubSchema, settingsWith } from './helpers';

const T0 = new Date(2026, 9, 14, 12, 0, 0).getTime(); // local noon
const HOUR = 3_600_000;

function harness() {
  let settings = settingsWith({});
  const sockets: FakeSocket[] = [];
  const feed = createBptfSocket({
    clock: { now: () => Date.now() },
    log: createLogger(),
    repo: {} as Repo,
    http: new FakeHttp(),
    settings: () => settings,
    secret: () => null,
    schema: createStubSchema(),
    onBatch: () => undefined,
    wsFactory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  });
  return {
    feed,
    sockets,
    last: () => sockets[sockets.length - 1]!,
    setSettings: (patch: DeepPartial<Settings>) => {
      settings = settingsWith(patch);
    },
  };
}

type H = ReturnType<typeof harness>;

/** Opens the newest socket and keeps it alive with a ping every 30 s for `ms`. */
async function healthyFor(h: H, ms: number): Promise<void> {
  const s = h.last();
  s.open();
  for (let t = 0; t < ms; t += 30_000) {
    await vi.advanceTimersByTimeAsync(30_000);
    s.emit('ping', Buffer.alloc(0));
  }
}

/** Advances 1 s at a time until the watchdog terminates the newest socket. */
async function untilTerminated(h: H): Promise<void> {
  const s = h.last();
  for (let i = 0; i < 200 && !s.terminated; i++) await vi.advanceTimersByTimeAsync(1_000);
  expect(s.terminated).toBe(true);
}

/**
 * Milliseconds until the next socket appears. Every wait here is a whole number of
 * seconds, so each second is crossed as 999 ms + 1 ms: a socket that shows up
 * early reports an odd value and fails the comparison.
 */
async function nextSocketAfter(h: H): Promise<number> {
  const before = h.sockets.length;
  let waited = 0;
  while (waited < 120_000) {
    await vi.advanceTimersByTimeAsync(999);
    if (h.sockets.length > before) return waited + 999;
    await vi.advanceTimersByTimeAsync(1);
    waited += 1_000;
    if (h.sockets.length > before) break;
  }
  expect(h.sockets.length).toBe(before + 1);
  return waited;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  resetBptfSocketGuard();
});

afterEach(() => {
  vi.useRealTimers();
  resetBptfSocketGuard();
});

describe('silence watchdog and the reconnect backoff', () => {
  it('reconnects 1 s after each silence that follows a healthy hour', async () => {
    const h = harness();
    h.feed.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      await healthyFor(h, HOUR);
      await untilTerminated(h);
      delays.push(await nextSocketAfter(h));
    }
    expect(delays).toEqual(Array(8).fill(1_000));
    h.feed.stop();
  });

  it('a stable connection also clears backoff left from earlier failures', async () => {
    const h = harness();
    h.feed.start();
    for (const wait of [1_000, 2_000, 4_000]) {
      h.last().serverClose();
      await vi.advanceTimersByTimeAsync(wait);
    }
    await healthyFor(h, STABLE_CONNECTION_MS + 10_000);
    await untilTerminated(h);
    expect(await nextSocketAfter(h)).toBe(1_000);
    h.feed.stop();
  });

  it('reconnects 1 s after each sleep/resume that follows a healthy hour', async () => {
    const h = harness();
    h.feed.start();
    for (let i = 0; i < 5; i++) {
      await healthyFor(h, HOUR);
      // The machine sleeps for 8 h: the clock jumps, then the next tick runs.
      vi.setSystemTime(Date.now() + 8 * HOUR);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.last().terminated).toBe(true);
      expect(h.feed.health().lastError).toMatch(/No frames/);
      expect(await nextSocketAfter(h)).toBe(1_000);
    }
    h.feed.stop();
  });

  it('keeps backing off for connections that open but never deliver anything', async () => {
    const h = harness();
    h.feed.start();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      h.last().open();
      await untilTerminated(h);
      delays.push(await nextSocketAfter(h));
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000]);
    h.feed.stop();
  });

  it('still backs off 1, 2, 4 s for sockets that close before opening', async () => {
    const h = harness();
    h.feed.start();
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      h.last().serverClose(1006);
      delays.push(await nextSocketAfter(h));
    }
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    h.feed.stop();
  });

  it('a healthy connection paused by the network kill switch restarts the schedule at 1 s', async () => {
    const h = harness();
    h.feed.start();
    for (const wait of [1_000, 2_000, 4_000]) {
      h.last().serverClose();
      await vi.advanceTimersByTimeAsync(wait);
    }
    await healthyFor(h, STABLE_CONNECTION_MS + 10_000);
    h.setSettings({ networkPaused: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.feed.health().state).toBe('paused');
    h.setSettings({});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.feed.health().state).toBe('connecting');
    h.last().serverClose(1006);
    expect(await nextSocketAfter(h)).toBe(1_000);
    h.feed.stop();
  });

  it('a refused 429 upgrade after a stable session still waits at least 60 s', async () => {
    const h = harness();
    h.feed.start();
    await healthyFor(h, HOUR);
    await untilTerminated(h);
    expect(await nextSocketAfter(h)).toBe(1_000);
    h.last().reject(429);
    expect(await nextSocketAfter(h)).toBe(60_000);
    h.feed.stop();
  });
});
