// Audit bptfnet-5: while the feed waits to reconnect, Data health counts the wait
// down instead of repeating the full delay until the reconnect happens.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBptfSocket, resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { Repo } from '../../src/service/contracts';
import type { DeepPartial, Settings } from '../../src/shared/types';
import { FakeHttp, FakeSocket, createLogger, createStubSchema, settingsWith } from './helpers';

const T0 = new Date(2026, 9, 14, 12, 0, 0).getTime(); // local noon

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

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  resetBptfSocketGuard();
});

afterEach(() => {
  vi.useRealTimers();
  resetBptfSocketGuard();
});

describe('backoff countdown on Data health', () => {
  it('counts down the 1 h pause after three refused 429 upgrades', async () => {
    const h = harness();
    h.feed.start();
    h.last().reject(429, { retryAfter: '2' });
    await vi.advanceTimersByTimeAsync(60_000);
    h.last().reject(429);
    await vi.advanceTimersByTimeAsync(120_000);
    h.last().reject(429);
    expect(h.feed.health().detail).toMatch(/HTTP 429\); reconnecting in 60 min$/);
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(h.sockets).toHaveLength(3);
    expect(h.feed.health().state).toBe('backoff');
    expect(h.feed.health().detail).toMatch(/HTTP 429\); reconnecting in 10 min$/);
    await vi.advanceTimersByTimeAsync(9.5 * 60_000);
    expect(h.feed.health().detail).toMatch(/reconnecting in 30 s$/);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sockets).toHaveLength(4);
    expect(h.feed.health().state).toBe('connecting');
    h.feed.stop();
  });

  it('counts down a short wait after a refused upgrade', async () => {
    const h = harness();
    h.feed.start();
    h.last().reject(302);
    expect(h.feed.health().detail).toMatch(/HTTP 302\); reconnecting in 60 s$/);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(h.feed.health().detail).toMatch(/HTTP 302\); reconnecting in 15 s$/);
    h.feed.stop();
  });

  it('counts down the 1 -> 60 s schedule after a dropped connection', async () => {
    const h = harness();
    h.feed.start();
    for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
      h.last().serverClose(1006);
      await vi.advanceTimersByTimeAsync(wait);
    }
    h.last().serverClose(1006);
    expect(h.feed.health().detail).toBe('Connection closed (code 1006); reconnecting in 60 s');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(h.feed.health().detail).toBe('Connection closed (code 1006); reconnecting in 15 s');
    h.feed.stop();
  });

  it('keeps counting down after a network pause and resume', async () => {
    const h = harness();
    h.feed.start();
    h.last().reject(503, { retryAfter: '600' });
    h.setSettings({ networkPaused: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.feed.health().state).toBe('paused');
    h.setSettings({});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.feed.health().detail).toMatch(/HTTP 503\); reconnecting in 10 min$/);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.feed.health()).toMatchObject({ state: 'backoff' });
    expect(h.feed.health().detail).toMatch(/HTTP 503\); reconnecting in 5 min$/);
    expect(h.sockets).toHaveLength(1);
    h.feed.stop();
  });

  it('a stopped feed reports Stopped, not a countdown', async () => {
    const h = harness();
    h.feed.start();
    h.last().reject(429, { retryAfter: '600' });
    h.feed.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.feed.health()).toMatchObject({ state: 'off', detail: 'Stopped' });
  });
});
