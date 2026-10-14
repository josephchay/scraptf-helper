// Request budgets are hard ceilings across relaunches and crash restarts (R7):
// the request log of earlier processes is counted against the budgets before a
// new process sends anything. Unit level: BudgetScheduler.seed,
// HttpClient.seedHistory and repo.requestsSince.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { RateLimitedError } from '../../src/service/net';
import { BUDGETS } from '../../src/service/net/budgets';
import { buildUserAgent, createHttpClient } from '../../src/service/net/http';
import { BudgetScheduler } from '../../src/service/net/ratelimit';
import { SecretRegistry } from '../../src/service/net/redact';
import { FakeTime, MemorySink, RecordingLogger, T0, createFakeFetch, jsonResponse } from '../net/helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const CURRENCIES = 'https://api.backpack.tf/api/IGetCurrencies/v1';
const PRICES = 'https://api.backpack.tf/api/IGetPrices/v4';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function client(time: FakeTime) {
  const { fetch, calls } = createFakeFetch(() => jsonResponse({ response: { success: 1 } }), time);
  const http = createHttpClient({
    clock: time,
    timers: time,
    log: new RecordingLogger(),
    sink: new MemorySink(),
    userAgent: () => buildUserAgent('0.1.0', 'https://example.invalid/contact'),
    fetchImpl: fetch,
    secrets: new SecretRegistry(),
  });
  return { http, calls };
}

describe('BudgetScheduler.seed', () => {
  it('restores spacing and window counts from earlier grants', () => {
    const time = new FakeTime(T0);
    const spec = BUDGETS.find((b) => b.id === 'bptf-currencies')!; // 5 min apart, 3 per hour
    const s = new BudgetScheduler(spec, { clock: time, timers: time });
    s.seed([T0 - 50 * MIN, T0 - 40 * MIN, T0 - 2 * MIN, T0 - 3 * HOUR]);
    expect(s.usedLast(HOUR)).toBe(3); // the 3 h old one is outside every window
    // The hour window is full until the oldest of the three leaves it.
    expect(s.nextAllowedAt()).toBe(T0 + 10 * MIN);
  });

  it('counts a future time (clock moved back) as now instead of blocking for long', () => {
    const time = new FakeTime(T0);
    const spec = BUDGETS.find((b) => b.id === 'bptf-prices')!; // 15 min apart
    const s = new BudgetScheduler(spec, { clock: time, timers: time });
    s.seed([T0 + 5 * HOUR, Number.NaN]);
    expect(s.nextAllowedAt()).toBe(T0 + 15 * MIN);
  });
});

describe('HttpClient.seedHistory', () => {
  it('maps request-log rows to their budgets, so a restarted process cannot exceed them', async () => {
    const time = new FakeTime(T0);
    const { http, calls } = client(time);
    http.seedHistory([
      { ts: T0 - 4 * MIN, host: 'api.backpack.tf', path: '/api/IGetPrices/v4?key=REDACTED&raw=1' },
      { ts: T0 - 30 * MIN, host: 'api.backpack.tf', path: '/api/IGetCurrencies/v1?key=REDACTED&raw=1' },
      { ts: T0 - 20 * MIN, host: 'api.backpack.tf', path: '/api/IGetCurrencies/v1?key=REDACTED&raw=1' },
      { ts: T0 - 10 * MIN, host: 'api.backpack.tf', path: '/api/IGetCurrencies/v1?key=REDACTED&raw=1' },
      { ts: T0 - MIN, host: 'unknown.example', path: '/x' }, // no budget: ignored
    ]);
    expect(http.nextAllowedAt('bptf-prices')).toBe(T0 + 11 * MIN);
    expect(http.nextAllowedAt('bptf-currencies')).toBe(T0 + 30 * MIN);
    expect(http.budgets().find((b) => b.id === 'bptf-currencies')!.usedLastHour).toBe(3);
    await expect(http.request(PRICES, { budget: 'bptf-prices', maxWaitMs: 60_000 })).rejects.toBeInstanceOf(RateLimitedError);
    await expect(http.request(CURRENCIES, { budget: 'bptf-currencies', maxWaitMs: 60_000 })).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toHaveLength(0);
    // Unrelated budgets are untouched.
    expect(http.nextAllowedAt('bptf-snapshot')).toBe(T0);
  });
});

describe('repo.requestsSince', () => {
  it('returns every request-log row since a time, oldest first, beyond the UI listing cap', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    for (let i = 0; i < 600; i++) {
      repo.appendRequestLog({ ts: T0 + i, host: 'pricedb.io', path: `/api/item/${i}`, method: 'GET', status: 200, ms: 1, bytes: 1, note: null });
    }
    const rows = repo.requestsSince(T0 + 50);
    expect(rows).toHaveLength(550);
    expect(rows[0]).toEqual({ ts: T0 + 50, host: 'pricedb.io', path: '/api/item/50' });
    expect(rows.at(-1)!.ts).toBe(T0 + 599);
  });
});
