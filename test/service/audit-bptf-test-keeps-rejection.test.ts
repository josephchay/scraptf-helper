// Review rv-jobs-net-2: the jobs parked on a credential backpack.tf rejected resume when the user saves
// another value or "a Settings test of that credential passes". test() cleared the rejection before it
// did anything, so a test that sent nothing (the key-price slot was used moments ago), or ended busy or
// rate limited, unparked the jobs and they sent the rejected credential again on the next tick.
// Real createBptfApi + buildJobs + createScheduler on a fake clock; no network.

import { afterEach, describe, expect, it } from 'vitest';
import { CURRENCIES_URL, PRICES_URL, SNAPSHOT_URL, createBptfApi } from '../../src/service/connectors/bptfApi';
import type { Engine, PriceDb, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { RateLimitedError } from '../../src/service/net';
import { buildJobs, createScheduler, type JobContext } from '../../src/service/scheduler';
import type { SecretName } from '../../src/shared/types';
import { FakeHttp, createLogger, createStubSchema, jsonResponse, loadFixture, settingsWith, type HttpCall } from '../bptf/helpers';
import { FakeTime, T0 } from '../net/helpers';

const MIN = 60_000;
const BAD_TOKEN = '0123456789abcdef0123456789abcdef';
const BAD_KEY = 'key_BAD_fedcba9876543210';
const JOB_IDS = ['snapshot-watched', 'key-bptf', 'bptf-prices'];

const snapshots = loadFixture<{ responses: Record<string, unknown> }>('snapshot-responses.json').responses;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function tokenOf(c: HttpCall): string | null {
  return c.opts.headers?.['X-Auth-Token'] ?? new URL(c.fullUrl).searchParams.get('token');
}

function harness() {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  const log = createLogger();
  const secrets: Partial<Record<SecretName, string>> = { bptfAccessToken: BAD_TOKEN, bptfApiKey: BAD_KEY };
  /** When set, a user-priority snapshot request times out behind another request on the host. */
  const busy = { on: false };
  const http = new FakeHttp((c) => {
    if (c.url === SNAPSHOT_URL) {
      if (busy.on && c.opts.priority === 'user') throw new RateLimitedError('bptf-snapshot', time.now(), true);
      return tokenOf(c) === 'never' ? jsonResponse(200, snapshots['Strange Pain Train']) : jsonResponse(401, { message: 'This access token is not valid.' });
    }
    if (c.url === CURRENCIES_URL || c.url === PRICES_URL) {
      return jsonResponse(403, { response: { success: 0, message: 'This API key is not valid.' } });
    }
    return jsonResponse(404, null);
  });
  const settings = settingsWith();
  const secret = (n: SecretName): string | null => secrets[n] ?? null;
  const api = createBptfApi({ clock: time, log, repo, http, settings: () => settings, secret, schema: createStubSchema() });
  const ctx: JobContext = {
    clock: time,
    log,
    repo,
    http,
    schema: createStubSchema(),
    pricedb: {} as PriceDb,
    bptfApi: api,
    engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
    settings: () => settings,
    secret,
    watchedBaseSkus: () => ['154;11'],
    nextQueuedSnapshot: () => null,
    snapshot: async (base, priority) => {
      await api.snapshot(base, priority);
    },
    keyQuotesChanged: () => undefined,
  };
  const s = createScheduler({ clock: time, timers: time, log, isPaused: () => false, tickMs: 1_000 });
  for (const job of buildJobs(ctx)) if (JOB_IDS.includes(job.id)) s.add(job);
  const state = (id: string) => s.states().find((x) => x.id === id)!;
  return { time, http, api, s, state, busy };
}

describe('audit: a Settings test that checked nothing keeps the jobs parked on a rejected credential', () => {
  it('API key: "used recently" sends nothing and leaves bptf-prices waiting', async () => {
    const h = harness();
    h.s.start();
    await h.time.advance(40_000);
    await h.s.whenIdle();
    expect(h.api.credentialRejected('bptfApiKey')).toMatch(/rejected the API key/);
    expect(h.state('bptf-prices').skipped).toMatch(/rejected the API key/);

    // The scheduled key-price call used the IGetCurrencies slot moments ago.
    h.http.next.set('bptf-currencies', h.time.now() + 5 * MIN);
    const before = h.http.calls.length;
    const r = await h.api.test('bptfApiKey');
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/used recently/);
    expect(h.http.calls).toHaveLength(before);
    expect(h.api.credentialRejected('bptfApiKey')).toMatch(/rejected the API key/);

    await h.time.advance(2_000);
    await h.s.whenIdle();
    expect(h.http.calls.slice(before).filter((c) => c.url === PRICES_URL || c.url === CURRENCIES_URL)).toHaveLength(0);
    expect(h.state('bptf-prices').skipped).toMatch(/rejected the API key/);
  });

  it('access token: a test that times out behind another request leaves snapshot-watched waiting', async () => {
    const h = harness();
    h.s.start();
    await h.time.advance(2 * MIN);
    await h.s.whenIdle();
    expect(h.state('snapshot-watched').skipped).toMatch(/rejected the access token/);

    h.busy.on = true;
    const r = await h.api.test('bptfAccessToken');
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/busy/);
    expect(h.api.credentialRejected('bptfAccessToken')).toMatch(/rejected the access token/);
    h.busy.on = false;

    const before = h.http.calls.length;
    await h.time.advance(2 * MIN);
    await h.s.whenIdle();
    expect(h.http.calls.slice(before).filter((c) => c.url === SNAPSHOT_URL)).toHaveLength(0);
    expect(h.state('snapshot-watched').skipped).toMatch(/rejected the access token/);
  });

  it('a test that is rejected again keeps the new verdict', async () => {
    const h = harness();
    h.s.start();
    await h.time.advance(2 * MIN);
    await h.s.whenIdle();
    const r = await h.api.test('bptfAccessToken');
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/rejected the access token/);
    expect(h.api.credentialRejected('bptfAccessToken')).toMatch(/rejected the access token/);
  });
});
