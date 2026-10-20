// Audit 0.7.3: a wall clock stepped back while the service runs must not hold a
// request budget for the size of the step. Grant times and pauses recorded on
// the old clock count as now (the seed()/restore() rule, applied at run time),
// so spacing, windows and pauses still hold in elapsed time (R7).

import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/service/contracts';
import { BUDGETS, type NetBudgetSpec } from '../../src/service/net/budgets';
import { RateLimitedError } from '../../src/service/net/errors';
import { BudgetScheduler } from '../../src/service/net/ratelimit';
import { FakeTime, T0 } from './helpers';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

function stepped(spec: NetBudgetSpec) {
  const time = new FakeTime(T0);
  let offset = 0;
  const wall: Clock = { now: () => time.now() + offset };
  const s = new BudgetScheduler(spec, { clock: wall, timers: time });
  return {
    time,
    wall,
    s,
    step: (ms: number) => {
      offset += ms;
    },
  };
}

const spec = (id: string): NetBudgetSpec => BUDGETS.find((b) => b.id === id)!;

describe('BudgetScheduler: wall clock stepped back while running', () => {
  it('a user refresh on bptf-snapshot gets the next slot within one spacing, not hours later', async () => {
    const h = stepped(spec('bptf-snapshot'));
    (await h.s.acquire()).release();
    await h.time.advance(HOUR);
    h.step(-8 * HOUR);
    expect(h.s.nextAllowedAt() - h.wall.now()).toBeLessThanOrEqual(10 * SEC);
    const p = h.s.acquire({ priority: 'user', maxWaitMs: 60_000 });
    await h.time.advance(11 * SEC);
    (await p).release();
  });

  it('keeps the spacing and counts the grants from before the step (bptf-currencies)', async () => {
    const h = stepped(spec('bptf-currencies'));
    (await h.s.acquire()).release();
    await h.time.advance(10 * MIN);
    (await h.s.acquire()).release();
    h.step(-8 * HOUR);
    expect(h.s.nextAllowedAt() - h.wall.now()).toBeLessThanOrEqual(5 * MIN);
    await expect(h.s.acquire({ maxWaitMs: 0 })).rejects.toBeInstanceOf(RateLimitedError);
    expect(h.s.state().usedLastHour).toBe(2);
    await h.time.advance(5 * MIN);
    const p = h.s.acquire({ maxWaitMs: 60_000 });
    await h.time.advance(0);
    (await p).release();
    // 3 per hour: the pre-step grants still fill the window.
    expect(h.s.state().usedLastHour).toBe(3);
    await expect(h.s.acquire({ maxWaitMs: 30 * MIN })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('a full hour window stays full (R7)', async () => {
    const h = stepped({ id: 'w', host: 'example.test', minIntervalMs: 0, maxPerHour: 3, concurrency: 1, description: 'w' });
    for (let i = 0; i < 3; i++) (await h.s.acquire()).release();
    h.step(-8 * HOUR);
    const now = h.wall.now();
    const next = h.s.nextAllowedAt();
    expect(next).toBeGreaterThan(now);
    expect(next).toBeLessThanOrEqual(now + HOUR);
    await expect(h.s.acquire({ maxWaitMs: 1_000 })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('a pause keeps at most its own length from the step', async () => {
    const h = stepped(spec('bptf-snapshot'));
    h.s.pause(h.wall.now() + 2 * MIN, 'Retry-After');
    await h.time.advance(MIN);
    h.step(-8 * HOUR);
    const left = h.s.pausedUntil()! - h.wall.now();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(2 * MIN);
    expect(h.s.persistedState().until - h.wall.now()).toBeLessThanOrEqual(2 * MIN);
    expect(h.s.pauseReason()).toBe('Retry-After');
  });

  it('a longer pause that arrives after the step is not lost', async () => {
    const h = stepped(spec('bptf-snapshot'));
    h.s.pause(h.wall.now() + 2 * MIN, 'Retry-After');
    h.step(-8 * HOUR);
    h.s.pause(h.wall.now() + HOUR, '3 consecutive 429 responses');
    expect(h.s.pausedUntil()! - h.wall.now()).toBe(HOUR);
    expect(h.s.pauseReason()).toBe('3 consecutive 429 responses');
  });

  it('a redirect hop counted after the step keeps the grant history in order', async () => {
    const h = stepped(spec('bptf-snapshot'));
    (await h.s.acquire()).release();
    await h.time.advance(MIN);
    const permit = await h.s.acquire();
    h.step(-8 * HOUR);
    permit.countExtra();
    permit.release();
    const history = (h.s as unknown as { history: number[] }).history;
    expect(history).toHaveLength(3);
    expect([...history].sort((a, b) => a - b)).toEqual(history);
    expect(h.s.usedLast(MIN)).toBe(3); // the grants from before the step count as now
  });
});
