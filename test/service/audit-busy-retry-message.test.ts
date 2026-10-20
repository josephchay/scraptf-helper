// Audit 0.7.3: a ban check or a Settings key/token test that timed out behind
// another backpack.tf request (RateLimitedError.busy) says the host is busy,
// instead of "try again in 1 s" or "try again after <the current time>".

import { afterEach, describe, expect, it } from 'vitest';
import { BUSY_MESSAGE, createBuyerChecker } from '../../src/service/buyerCheck';
import { createBptfApi } from '../../src/service/connectors/bptfApi';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { RateLimitedError } from '../../src/service/net';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { FakeHttp, createLogger, createStubSchema, settingsWith } from '../bptf/helpers';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const ID = '76561198000000002';

function checker(err: unknown) {
  return createBuyerChecker({
    bptfApi: { usersInfo: () => Promise.reject(err) },
    http: { isPaused: () => false, hostBlocked: () => null },
    clock: { now: () => T0 },
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => mergeSettings(DEFAULT_SETTINGS, { connectors: { bptfApi: true } }),
    secret: (n) => (n === 'bptfAccessToken' ? 'tok_test_0123456789' : null),
  });
}

describe('buyer.check: timed out behind another backpack.tf request', () => {
  it('says the host is busy instead of giving a retry time', async () => {
    const r = await checker(new RateLimitedError('bptf-users', T0, true)).check(ID);
    expect(r.error).toBe(BUSY_MESSAGE);
    expect(r.error).not.toMatch(/try again in 1 s/);
  });

  it('keeps the retry time for a real rate limit', async () => {
    const r = await checker(new RateLimitedError('bptf-users', T0 + 12_400)).check(ID);
    expect(r.error).toBe('backpack.tf user lookups are rate limited; try again in 13 s.');
  });
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function bptf(err: unknown) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const http = new FakeHttp(() => {
    throw err;
  });
  return createBptfApi({
    clock: { now: () => T0 },
    log: createLogger(),
    repo,
    http,
    settings: () => settingsWith({}),
    secret: (n) => (n === 'bptfAccessToken' ? 'tok_test_0123456789' : 'key_test_0123456789'),
    schema: createStubSchema(),
  });
}

describe('Settings key/token test: timed out behind another backpack.tf request', () => {
  it.each(['bptfAccessToken', 'bptfApiKey'] as const)('%s: says the host is busy', async (name) => {
    const r = await bptf(new RateLimitedError(name === 'bptfApiKey' ? 'bptf-currencies' : 'bptf-snapshot', T0, true)).test(name);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/busy with another Flip Desk request/);
    expect(r.message).not.toMatch(/try again after/);
  });

  it('keeps the retry time for a real rate limit', async () => {
    const r = await bptf(new RateLimitedError('bptf-snapshot', T0 + 60_000)).test('bptfAccessToken');
    expect(r).toEqual({ ok: false, message: `Rate limited; try again after ${new Date(T0 + 60_000).toLocaleTimeString()}.` });
  });
});
