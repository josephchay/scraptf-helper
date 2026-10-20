// Audit core-1 / xlifecycle-2 / bptfnet-6: a credential backpack.tf rejected must make the
// scheduled backpack.tf jobs wait (like a missing credential), not fail and log a WARN every
// cadence. Real createBptfApi + buildJobs + createScheduler on a fake clock; no network.

import { afterEach, describe, expect, it } from 'vitest';
import { CURRENCIES_URL, PRICES_URL, SNAPSHOT_URL, createBptfApi } from '../../src/service/connectors/bptfApi';
import type { Engine, PriceDb, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { buildJobs, createScheduler, type JobContext } from '../../src/service/scheduler';
import type { SecretName } from '../../src/shared/types';
import { FakeHttp, createLogger, createStubSchema, jsonResponse, loadFixture, settingsWith, type HttpCall } from '../bptf/helpers';
import { FakeTime, T0 } from '../net/helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const BAD_TOKEN = '0123456789abcdef0123456789abcdef'; // an API key pasted into the token field
const BAD_KEY = 'key_BAD_fedcba9876543210';
const GOOD_TOKEN = 'tok_GOOD_abcdefabcdef1234';
const GOOD_KEY = 'key_GOOD_0123456789abcdef';
const JOB_IDS = ['snapshot-watched', 'key-bptf', 'bptf-prices'];

const snapshots = loadFixture<{ responses: Record<string, unknown> }>('snapshot-responses.json').responses;
const pricesBody = loadFixture('igetprices-v4.json');
const currencies = loadFixture<{ objectForm: unknown }>('igetcurrencies-v1.json');

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function tokenOf(c: HttpCall): string | null {
  return c.opts.headers?.['X-Auth-Token'] ?? new URL(c.fullUrl).searchParams.get('token');
}
function keyOf(c: HttpCall): string | null {
  return new URL(c.fullUrl).searchParams.get('key');
}

function harness() {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  const log = createLogger();
  const secrets: Partial<Record<SecretName, string>> = { bptfAccessToken: BAD_TOKEN, bptfApiKey: BAD_KEY };
  const good = { token: GOOD_TOKEN, key: GOOD_KEY };
  const http = new FakeHttp((c) => {
    if (c.url === SNAPSHOT_URL) {
      return tokenOf(c) === good.token ? jsonResponse(200, snapshots['Strange Pain Train']) : jsonResponse(401, { message: 'This access token is not valid.' });
    }
    if (c.url === CURRENCIES_URL || c.url === PRICES_URL) {
      if (keyOf(c) !== good.key) return jsonResponse(403, { response: { success: 0, message: 'This API key is not valid.' } });
      return jsonResponse(200, c.url === CURRENCIES_URL ? currencies.objectForm : pricesBody);
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
  const warns = () => log.lines.filter((l) => l.level === 'warn').map((l) => l.msg);
  return { time, repo, log, http, api, s, secrets, good, state, warns };
}

describe('audit: a rejected backpack.tf credential parks the jobs', () => {
  it('stops failing and warning every cadence; the jobs wait with the rejection as the reason', async () => {
    const h = harness();
    h.s.start();
    // key-bptf runs at start, snapshot-watched at 20 s, bptf-prices would at 30 s.
    await h.time.advance(40_000);
    await h.s.whenIdle();
    expect(h.http.calls.filter((c) => c.url === SNAPSHOT_URL)).toHaveLength(2); // header, then query
    expect(h.http.calls.filter((c) => c.url === CURRENCIES_URL)).toHaveLength(1);
    expect(h.http.calls.filter((c) => c.url === PRICES_URL)).toHaveLength(0);
    // The rejection itself and one job failure for each family; a remembered rejection adds no snapshot warning.
    const first = h.warns();
    expect(first.filter((m) => /^backpack\.tf rejected the access token/.test(m))).toHaveLength(1);
    expect(first.filter((m) => /^backpack\.tf rejected the API key/.test(m))).toHaveLength(1);
    expect(first.filter((m) => m.startsWith('job snapshot-watched failed'))).toHaveLength(1);
    expect(first.filter((m) => m.startsWith('job key-bptf failed'))).toHaveLength(1);
    expect(first.filter((m) => m.startsWith('job bptf-prices failed'))).toHaveLength(0);
    expect(first.filter((m) => m.startsWith('backpack.tf snapshot for'))).toHaveLength(0);

    await h.time.advance(2 * HOUR);
    await h.s.whenIdle();
    expect(h.http.calls).toHaveLength(3);
    expect(h.warns()).toEqual(first);
    expect(h.state('snapshot-watched').skipped).toMatch(/rejected the access token/);
    expect(h.state('key-bptf').skipped).toMatch(/rejected the API key/);
    expect(h.state('bptf-prices').skipped).toMatch(/rejected the API key/);
    for (const id of JOB_IDS) {
      expect(h.log.lines.filter((l) => l.level === 'debug' && l.msg.startsWith(`job ${id} waiting:`))).toHaveLength(1);
    }
  });

  it('runs again at once after the user saves new credentials (core kicks the jobs)', async () => {
    const h = harness();
    h.s.start();
    await h.time.advance(40_000);
    await h.s.whenIdle();
    expect(h.http.calls).toHaveLength(3);

    h.secrets.bptfAccessToken = GOOD_TOKEN;
    h.secrets.bptfApiKey = GOOD_KEY;
    for (const id of JOB_IDS) h.s.kick(id);
    await h.time.advance(5_000);
    await h.s.whenIdle();
    expect(h.http.calls.some((c) => c.url === SNAPSHOT_URL && tokenOf(c) === GOOD_TOKEN)).toBe(true);
    expect(h.http.calls.some((c) => c.url === CURRENCIES_URL && keyOf(c) === GOOD_KEY)).toBe(true);
    expect(h.http.calls.some((c) => c.url === PRICES_URL && keyOf(c) === GOOD_KEY)).toBe(true);
    for (const id of JOB_IDS) {
      expect(h.state(id).skipped).toBeNull();
      expect(h.state(id).lastOkAt).not.toBeNull();
    }
    expect(h.repo.getSnapshotAt('154;11')).not.toBeNull();
  });

  it('a successful Settings test of the same token unblocks the job on the next tick, without a kick', async () => {
    const h = harness();
    h.s.start();
    await h.time.advance(2 * MIN);
    await h.s.whenIdle();
    expect(h.state('snapshot-watched').skipped).toMatch(/rejected the access token/);
    const before = h.http.calls.length;

    // backpack.tf now accepts the same token (e.g. it was re-enabled on the site).
    h.good.token = BAD_TOKEN;
    expect(await h.api.test('bptfAccessToken')).toMatchObject({ ok: true });
    expect(h.api.credentialRejected('bptfAccessToken')).toBeNull();
    await h.time.advance(2_000);
    await h.s.whenIdle();
    const after = h.http.calls.slice(before + 1); // the Settings test's own request first
    expect(after.some((c) => c.url === SNAPSHOT_URL && new URL(c.fullUrl).searchParams.get('sku') === 'Strange Pain Train')).toBe(true);
    expect(h.state('snapshot-watched').skipped).toBeNull();
    expect(h.state('snapshot-watched').lastOkAt).not.toBeNull();
  });

  it('credentialRejected reads the remembered rejection without a request and forgets it when the secret changes', async () => {
    const h = harness();
    expect(h.api.credentialRejected('bptfAccessToken')).toBeNull();
    expect(h.api.credentialRejected('bptfApiKey')).toBeNull();
    await expect(h.api.snapshot('154;11')).rejects.toThrow(/rejected the access token/);
    const calls = h.http.calls.length;
    expect(h.api.credentialRejected('bptfAccessToken')).toMatch(/rejected the access token \(HTTP 401/);
    expect(h.api.credentialRejected('bptfApiKey')).toBeNull();
    expect(h.http.calls).toHaveLength(calls);
    h.secrets.bptfAccessToken = GOOD_TOKEN;
    expect(h.api.credentialRejected('bptfAccessToken')).toBeNull();
    // Back to the rejected value: forgotten, so it gets a fresh request rather than a stale verdict.
    h.secrets.bptfAccessToken = BAD_TOKEN;
    expect(h.api.credentialRejected('bptfAccessToken')).toBeNull();
    expect(h.http.calls).toHaveLength(calls);
  });
});
