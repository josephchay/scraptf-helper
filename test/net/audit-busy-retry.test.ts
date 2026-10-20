// Audit 0.7.3: a waiter that times out behind a running request on the same
// host (the shared api.backpack.tf gate, or its own budget's concurrency) is
// marked busy. Its retryAt is only the time of the failure, so callers must not
// show it as "try again in 1 s".

import { describe, expect, it } from 'vitest';
import { BUDGETS, type NetBudgetSpec } from '../../src/service/net/budgets';
import { RateLimitedError } from '../../src/service/net/errors';
import { buildUserAgent, createHttpClient } from '../../src/service/net/http';
import { BudgetScheduler, ConcurrencyGate, type TimerApi } from '../../src/service/net/ratelimit';
import { SecretRegistry } from '../../src/service/net/redact';
import { FakeTime, MemorySink, RecordingLogger, T0, createFakeFetch, hang, jsonResponse } from './helpers';

const HOUR = 3_600_000;
const spec = (id: string): NetBudgetSpec => BUDGETS.find((b) => b.id === id)!;

/** IGetPrices holds the host gate; a user lookup on bptf-users waits behind it. */
function sharedGate(timers?: (time: FakeTime) => TimerApi) {
  const time = new FakeTime();
  const t = timers ? timers(time) : time;
  const gate = new ConcurrencyGate(1);
  const prices = new BudgetScheduler(spec('bptf-prices'), { clock: time, timers: t, gate });
  const users = new BudgetScheduler(spec('bptf-users'), { clock: time, timers: t, gate });
  return { time, prices, users };
}

describe('RateLimitedError.busy', () => {
  it('is set when the host gate stays taken for the whole wait', async () => {
    const h = sharedGate();
    const held = await h.prices.acquire();
    const p = h.users.acquire({ priority: 'user', maxWaitMs: 15_000 }).catch((e: unknown) => e);
    await h.time.advance(15_000);
    const err = (await p) as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.busy).toBe(true);
    expect(err.budget).toBe('bptf-users');
    expect(err.message).toMatch(/another request to the same host/);
    held.release();
  });

  it('is set when the wait timer fires a little late (the usual case with real timers)', async () => {
    const h = sharedGate((time) => ({ setTimeout: (fn, ms) => time.setTimeout(fn, ms + 4), clearTimeout: time.clearTimeout }));
    const held = await h.prices.acquire();
    const p = h.users.acquire({ priority: 'user', maxWaitMs: 15_000 }).catch((e: unknown) => e);
    await h.time.advance(15_004);
    const err = (await p) as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.busy).toBe(true);
    held.release();
  });

  it("is set when the budget's own concurrency stays taken", async () => {
    const time = new FakeTime();
    const s = new BudgetScheduler({ id: 'c', host: 'example.test', minIntervalMs: 0, concurrency: 1, description: 'c' }, { clock: time, timers: time });
    const held = await s.acquire();
    const p = s.acquire({ maxWaitMs: 3_000 }).catch((e: unknown) => e);
    await time.advance(3_000);
    expect(((await p) as RateLimitedError).busy).toBe(true);
    held.release();
  });

  it('stays false for limits that are about time', async () => {
    const time = new FakeTime();
    const s = new BudgetScheduler({ id: 't', host: 'example.test', minIntervalMs: 10_000, concurrency: 1, description: 't' }, { clock: time, timers: time });
    (await s.acquire()).release();
    const fast = (await s.acquire({ maxWaitMs: 5_000 }).catch((e: unknown) => e)) as RateLimitedError;
    expect(fast).toBeInstanceOf(RateLimitedError);
    expect(fast.busy).toBe(false);
    expect(fast.retryAt).toBe(T0 + 10_000);
    expect(fast.message).toMatch(/next slot at/);

    await time.advance(10_000);
    const held = await s.acquire();
    const p = s.acquire({ maxWaitMs: 30_000 }).catch((e: unknown) => e);
    s.pause(time.now() + HOUR, 'test');
    const paused = (await p) as RateLimitedError;
    expect(paused.busy).toBe(false);
    expect(paused.retryAt).toBe(time.now() + HOUR);
    held.release();
  });

  it('stays false when a late timer finds the budget free', async () => {
    const time = new FakeTime();
    const late: TimerApi = { setTimeout: (fn, ms) => time.setTimeout(fn, ms + 4), clearTimeout: time.clearTimeout };
    const s = new BudgetScheduler({ id: 'l', host: 'example.test', minIntervalMs: 10_000, concurrency: 1, description: 'l' }, { clock: time, timers: late });
    (await s.acquire()).release();
    const p = s.acquire({ maxWaitMs: 10_000 }).catch((e: unknown) => e);
    await time.advance(10_004);
    const err = await p;
    // Serving it would be fine too; a rejection must not blame a busy host.
    if (err instanceof RateLimitedError) expect(err.busy).toBe(false);
    else expect(err).toHaveProperty('grantedAt');
  });

  it('reaches the caller of http.request unchanged', async () => {
    const time = new FakeTime();
    const { fetch } = createFakeFetch((call) => (call.url.includes('IGetPrices') ? hang() : jsonResponse({ users: {} })), time);
    const client = createHttpClient({
      clock: time,
      timers: time,
      log: new RecordingLogger(),
      sink: new MemorySink(),
      userAgent: () => buildUserAgent('0.1.0', 'https://example.invalid/contact'),
      fetchImpl: fetch,
      secrets: new SecretRegistry(),
    });
    void client.request('https://api.backpack.tf/api/IGetPrices/v4', { budget: 'bptf-prices' }).catch(() => undefined);
    await time.advance(0);
    const p = client
      .request('https://api.backpack.tf/api/users/info/v1', { budget: 'bptf-users', priority: 'user', maxWaitMs: 15_000 })
      .catch((e: unknown) => e);
    await time.advance(15_000);
    const err = (await p) as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.busy).toBe(true);
  });
});
