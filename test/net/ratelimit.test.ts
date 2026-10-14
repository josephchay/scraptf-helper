import { describe, expect, it } from 'vitest';
import type { BudgetSpec } from '../../src/service/contracts';
import type { NetBudgetSpec } from '../../src/service/net/budgets';
import { RateLimitedError } from '../../src/service/net/errors';
import {
  BACKOFF_MAX_MS,
  BudgetScheduler,
  ConcurrencyGate,
  LONG_PAUSE_MS,
  backoffMs,
  type Permit,
} from '../../src/service/net/ratelimit';
import { FakeTime, T0, flush } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;

function budget(over: Partial<NetBudgetSpec> = {}): NetBudgetSpec {
  return { id: 'test', host: 'example.test', minIntervalMs: 0, concurrency: 1, description: 'test budget', ...over };
}

function make(over: Partial<NetBudgetSpec> = {}, gate?: ConcurrencyGate) {
  const time = new FakeTime();
  const s = new BudgetScheduler(budget(over), { clock: time, timers: time, gate });
  return { time, s };
}

/** Acquires and records the grant time; releases immediately unless hold is set. */
function track(s: BudgetScheduler, time: FakeTime, log: { label: string; at: number }[], label: string, opts: Parameters<BudgetScheduler['acquire']>[0] = {}, hold = false) {
  return s.acquire(opts).then((p: Permit) => {
    log.push({ label, at: time.now() - T0 });
    if (!hold) p.release();
    return p;
  });
}

describe('min interval', () => {
  it('spaces request starts by minIntervalMs', async () => {
    const { time, s } = make({ minIntervalMs: 10_000 });
    const log: { label: string; at: number }[] = [];
    const all = Promise.all([track(s, time, log, 'a'), track(s, time, log, 'b'), track(s, time, log, 'c')]);
    await time.advance(25_000);
    await all;
    expect(log).toEqual([
      { label: 'a', at: 0 },
      { label: 'b', at: 10_000 },
      { label: 'c', at: 20_000 },
    ]);
  });

  it('nextAllowedAt reflects the spacing', async () => {
    const { time, s } = make({ minIntervalMs: 10_000 });
    expect(s.nextAllowedAt()).toBe(T0);
    (await s.acquire()).release();
    expect(s.nextAllowedAt()).toBe(T0 + 10_000);
    await time.advance(4_000);
    expect(s.nextAllowedAt()).toBe(T0 + 10_000);
    await time.advance(6_000);
    expect(s.nextAllowedAt()).toBe(T0 + 10_000);
    expect(s.nextAllowedAt()).toBe(time.now());
  });
});

describe('sliding windows', () => {
  it('per minute', async () => {
    const { time, s } = make({ maxPerMinute: 3 });
    const log: { label: string; at: number }[] = [];
    const all = Promise.all(['a', 'b', 'c', 'd', 'e'].map((l) => track(s, time, log, l)));
    await time.advance(90_000);
    await all;
    expect(log.map((x) => x.at)).toEqual([0, 0, 0, MIN, MIN]);
    expect(s.usedLast(MIN)).toBe(2);
    await time.advance(30_000);
    expect(s.usedLast(MIN)).toBe(0);
  });

  it('per hour, with grants spread out', async () => {
    const { time, s } = make({ maxPerHour: 2 });
    (await s.acquire()).release();
    await time.advance(10 * MIN);
    (await s.acquire()).release();
    expect(s.nextAllowedAt()).toBe(T0 + HOUR);
    await time.advance(50 * MIN);
    expect(s.nextAllowedAt()).toBe(T0 + HOUR);
    (await s.acquire()).release();
    expect(s.nextAllowedAt()).toBe(T0 + 10 * MIN + HOUR);
  });

  it('per day', async () => {
    const { time, s } = make({ maxPerDay: 2, minIntervalMs: 1_000 });
    (await s.acquire()).release();
    await time.advance(1_000);
    (await s.acquire()).release();
    expect(s.nextAllowedAt()).toBe(T0 + 24 * HOUR);
    await time.advance(23 * HOUR);
    expect(s.state().usedLastHour).toBe(0);
    expect(s.nextAllowedAt()).toBe(T0 + 24 * HOUR);
  });

  it('ignores non-positive window limits instead of blocking forever', async () => {
    const { s } = make({ maxPerMinute: 0, maxPerHour: -5 });
    for (let i = 0; i < 5; i++) (await s.acquire()).release();
    expect(s.usedLast(MIN)).toBe(5);
  });
});

describe('priority', () => {
  it("serves 'user' before 'background', FIFO within a priority", async () => {
    const { time, s } = make({ minIntervalMs: 1_000 });
    const log: { label: string; at: number }[] = [];
    const first = track(s, time, log, 'first');
    const queued = [
      track(s, time, log, 'bg1', { priority: 'background' }),
      track(s, time, log, 'bg2', { priority: 'background' }),
      track(s, time, log, 'user1', { priority: 'user' }),
      track(s, time, log, 'bg3'),
      track(s, time, log, 'user2', { priority: 'user' }),
    ];
    await time.advance(10_000);
    await Promise.all([first, ...queued]);
    expect(log.map((x) => x.label)).toEqual(['first', 'user1', 'user2', 'bg1', 'bg2', 'bg3']);
    expect(log.map((x) => x.at)).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000]);
  });
});

describe('concurrency', () => {
  it('waits for a release when the budget is busy', async () => {
    const { time, s } = make({ concurrency: 1 });
    const log: { label: string; at: number }[] = [];
    const p1 = await track(s, time, log, 'a', {}, true);
    const second = track(s, time, log, 'b');
    await time.advance(5_000);
    expect(log.map((x) => x.label)).toEqual(['a']);
    expect(s.activeRequests()).toBe(1);
    p1.release();
    p1.release(); // idempotent
    await flush();
    await second;
    expect(log).toEqual([
      { label: 'a', at: 0 },
      { label: 'b', at: 5_000 },
    ]);
    expect(s.activeRequests()).toBe(0);
  });

  it('a shared host gate serialises budgets and wakes user-priority budgets first', async () => {
    const time = new FakeTime();
    const gate = new ConcurrencyGate(1);
    const a = new BudgetScheduler(budget({ id: 'a' }), { clock: time, timers: time, gate });
    const b = new BudgetScheduler(budget({ id: 'b' }), { clock: time, timers: time, gate });
    const c = new BudgetScheduler(budget({ id: 'c' }), { clock: time, timers: time, gate });
    const log: { label: string; at: number }[] = [];
    const held = await track(a, time, log, 'a', {}, true);
    const pb = track(b, time, log, 'b-background', { priority: 'background' });
    const pc = track(c, time, log, 'c-user', { priority: 'user' });
    await flush();
    expect(gate.active).toBe(1);
    held.release();
    await flush();
    await Promise.all([pb, pc]);
    expect(log.map((x) => x.label)).toEqual(['a', 'c-user', 'b-background']);
    expect(gate.active).toBe(0);
  });

  it('ConcurrencyGate coerces invalid limits to 1', () => {
    expect(new ConcurrencyGate(0).limit).toBe(1);
    expect(new ConcurrencyGate(2.5).limit).toBe(1);
    expect(new ConcurrencyGate(2).limit).toBe(2);
  });
});

describe('maxWaitMs', () => {
  it('fails fast when the slot is further away than maxWaitMs', async () => {
    const { s } = make({ minIntervalMs: 10_000 });
    (await s.acquire()).release();
    const err = await s.acquire({ maxWaitMs: 5_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).budget).toBe('test');
    expect((err as RateLimitedError).retryAt).toBe(T0 + 10_000);
  });

  it('accounts for waiters already queued ahead', async () => {
    const { time, s } = make({ minIntervalMs: 10_000 });
    (await s.acquire()).release();
    const queued = s.acquire({ maxWaitMs: 60_000 }); // starts at 10 s
    const err = await s.acquire({ maxWaitMs: 15_000 }).catch((e: unknown) => e); // would start at 20 s
    expect(err).toBeInstanceOf(RateLimitedError);
    await time.advance(10_000);
    (await queued).release();
  });

  it('serves a waiter whose slot opens exactly at its deadline', async () => {
    const { time, s } = make({ minIntervalMs: 10_000 });
    (await s.acquire()).release();
    const p = s.acquire({ maxWaitMs: 10_000 });
    await time.advance(10_000);
    const permit = await p;
    expect(permit.grantedAt).toBe(T0 + 10_000);
  });

  it('times out while blocked on concurrency', async () => {
    const { time, s } = make();
    const held = await s.acquire();
    const p = s.acquire({ maxWaitMs: 3_000 }).catch((e: unknown) => e);
    await time.advance(3_000);
    expect(await p).toBeInstanceOf(RateLimitedError);
    expect(s.queueLength()).toBe(0);
    held.release();
  });

  it('maxWaitMs 0 grants only an immediately free slot', async () => {
    const { s } = make({ minIntervalMs: 1_000 });
    (await s.acquire({ maxWaitMs: 0 })).release();
    await expect(s.acquire({ maxWaitMs: 0 })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('rejects queued waiters as soon as a pause makes their deadline unreachable', async () => {
    const { time, s } = make();
    const held = await s.acquire();
    const p = s.acquire({ maxWaitMs: 30_000 }).catch((e: unknown) => e);
    s.pause(time.now() + HOUR, 'test');
    const err = await p;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAt).toBe(T0 + HOUR);
    held.release();
  });
});

describe('pauses', () => {
  it('pauseUntil delays waiters and only ever extends', async () => {
    const { time, s } = make();
    s.pause(T0 + 30_000, 'Retry-After');
    s.pause(T0 + 10_000, 'shorter');
    expect(s.pausedUntil()).toBe(T0 + 30_000);
    expect(s.pauseReason()).toBe('Retry-After');
    expect(s.nextAllowedAt()).toBe(T0 + 30_000);
    const log: { label: string; at: number }[] = [];
    const p = track(s, time, log, 'x');
    await time.advance(29_999);
    expect(log).toEqual([]);
    await time.advance(1);
    await p;
    expect(log).toEqual([{ label: 'x', at: 30_000 }]);
    expect(s.pausedUntil()).toBeNull();
  });

  it('resume clears the pause', async () => {
    const { s } = make();
    s.pause(T0 + HOUR, 'x');
    s.resume();
    expect(s.pausedUntil()).toBeNull();
    (await s.acquire({ maxWaitMs: 0 })).release();
  });

  it('ignores non-finite pause times', () => {
    const { s } = make();
    s.pause(Number.NaN, 'bad');
    s.pause(Number.POSITIVE_INFINITY, 'bad');
    expect(s.pausedUntil()).toBeNull();
  });
});

describe('429 handling', () => {
  it('backoff schedule: 60 s, doubling, capped at 15 min', () => {
    expect([1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    expect(backoffMs(0)).toBe(60_000);
    expect(BACKOFF_MAX_MS).toBe(15 * MIN);
  });

  it('three consecutive 429s pause for an hour', () => {
    const { s } = make();
    const r1 = s.record429(null);
    expect(r1).toMatchObject({ pauseMs: 60_000, consecutive429: 1, longPause: false });
    const r2 = s.record429(null);
    expect(r2).toMatchObject({ pauseMs: 120_000, consecutive429: 2, longPause: false });
    const r3 = s.record429(null);
    expect(r3).toMatchObject({ pauseMs: LONG_PAUSE_MS, consecutive429: 3, longPause: true });
    expect(s.pausedUntil()).toBe(T0 + HOUR);
    expect(s.consecutive429).toBe(3);
    // A fourth keeps the long pause.
    expect(s.record429(5_000).pauseMs).toBe(LONG_PAUSE_MS);
  });

  it('uses the server delay when given and resets the streak on success', () => {
    const { s } = make();
    expect(s.record429(7_000).pauseMs).toBe(7_000);
    expect(s.record429(2_000).pauseMs).toBe(2_000);
    s.recordSuccess();
    expect(s.consecutive429).toBe(0);
    expect(s.record429(null)).toMatchObject({ pauseMs: 60_000, consecutive429: 1 });
  });

  it('clamps garbage delays to [1 s, 24 h]', () => {
    const { s } = make();
    expect(s.record429(5).pauseMs).toBe(1_000);
    s.recordSuccess();
    expect(s.record429(10 * 24 * HOUR).pauseMs).toBe(24 * HOUR);
  });

  it('honours a budget-specific minimum 429 pause (SCM lockouts)', () => {
    const { s } = make({ on429PauseMs: 6 * HOUR });
    expect(s.record429(1_000).pauseMs).toBe(6 * HOUR);
  });

  it('503 backs off without counting towards the 429 streak', () => {
    const { s } = make();
    expect(s.recordUnavailable(null)).toMatchObject({ pauseMs: 60_000, longPause: false });
    expect(s.recordUnavailable(null).pauseMs).toBe(120_000);
    expect(s.recordUnavailable(null).pauseMs).toBe(240_000);
    expect(s.consecutive429).toBe(0);
    expect(s.recordUnavailable(3_000).pauseMs).toBe(3_000);
  });
});

describe('cancellation', () => {
  it('an aborted signal removes the waiter', async () => {
    const { time, s } = make({ minIntervalMs: 10_000 });
    (await s.acquire()).release();
    const ac = new AbortController();
    const p = s.acquire({ signal: ac.signal }).catch((e: unknown) => e);
    expect(s.queueLength()).toBe(1);
    ac.abort(new Error('caller gave up'));
    expect(((await p) as Error).message).toBe('caller gave up');
    expect(s.queueLength()).toBe(0);
    await time.advance(20_000);
    expect(s.usedLast(HOUR)).toBe(1);
  });

  it('an already-aborted signal rejects immediately', async () => {
    const { s } = make();
    const ac = new AbortController();
    ac.abort();
    await expect(s.acquire({ signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancelAll rejects every waiter and clears timers', async () => {
    const { time, s } = make({ minIntervalMs: 10_000 });
    (await s.acquire()).release();
    const ps = [s.acquire(), s.acquire({ priority: 'user', maxWaitMs: 50_000 })].map((p) => p.catch((e: unknown) => e));
    const boom = new Error('paused');
    s.cancelAll(boom);
    expect(await Promise.all(ps)).toEqual([boom, boom]);
    expect(time.timerCount).toBe(0);
  });
});

describe('state', () => {
  it('reports usage for the UI', async () => {
    const spec: BudgetSpec = { id: 'x', host: 'h.test', minIntervalMs: 0, concurrency: 1, description: 'd' };
    const time = new FakeTime();
    const s = new BudgetScheduler(spec, { clock: time, timers: time });
    (await s.acquire()).release();
    (await s.acquire()).release();
    s.record429(null);
    expect(s.state()).toMatchObject({
      id: 'x',
      host: 'h.test',
      description: 'd',
      usedLastHour: 2,
      pausedUntil: T0 + 60_000,
      pauseReason: 'HTTP 429',
      consecutive429: 1,
      queued: 0,
      active: 0,
      nextAllowedAt: T0 + 60_000,
    });
    await time.advance(HOUR + 1);
    expect(s.state().usedLastHour).toBe(0);
  });

  it('countExtra adds a window entry for redirect hops', async () => {
    const { s } = make({ maxPerMinute: 2 });
    const p = await s.acquire();
    p.countExtra();
    p.release();
    p.countExtra(); // ignored after release
    expect(s.usedLast(MIN)).toBe(2);
    await expect(s.acquire({ maxWaitMs: 0 })).rejects.toBeInstanceOf(RateLimitedError);
  });
});
