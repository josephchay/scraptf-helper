// 0.7.3: the 'pricedb-all' job reloads PriceDB's full list every 4 h, not every 8 h (the last-load stamp is
// the load's start, so the next run, timed from the previous run's start, is not skipped), and a failed
// reload after an earlier one is a failed run, retried after retryMs instead of a full cadence later.

import { afterEach, describe, expect, it } from 'vitest';
import { LOAD_ALL_MIN_INTERVAL_MS, LOAD_ALL_SLACK_MS, META_LOAD_ALL_AT, createPriceDb, loadAllFresh } from '../../src/service/connectors/pricedb';
import type { BptfApi, Engine, HttpResponse, Repo, SchemaService, ServiceDeps } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { buildJobs, createScheduler, type JobContext } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { FakeTime, T0 } from '../net/helpers';
import { FakeHttp, fixture, res } from '../pricedb/helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DOWNLOAD_MS = 5_000;
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** Real PriceDB connector, 'pricedb-all' job and scheduler on fake time; /autob/items answers after 5 s. */
function harness(opts: { tickMs?: number; fail?: number[]; lastLoadAt?: number } = {}) {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  if (opts.lastLoadAt !== undefined) repo.setMeta(META_LOAD_ALL_AT, String(opts.lastLoadAt));
  const requests: number[] = [];
  const http = new FakeHttp((url) => {
    if (!url.endsWith('/autob/items')) return res(null, { status: 404 });
    const i = requests.length;
    requests.push(time.now());
    return new Promise<HttpResponse>((resolve) => {
      time.setTimeout(() => resolve(opts.fail?.includes(i) ? res(null, { status: 503 }) : res(fixture('autob-items.json'))), DOWNLOAD_MS);
    });
  });
  const deps: ServiceDeps = { clock: time, log: quiet, repo, http, settings: () => DEFAULT_SETTINGS, secret: () => null };
  const pricedb = createPriceDb(deps, { timers: time });
  const ctx: JobContext = {
    clock: time,
    log: quiet,
    repo,
    http,
    schema: {} as unknown as SchemaService,
    pricedb,
    bptfApi: {} as unknown as BptfApi,
    engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
    settings: () => DEFAULT_SETTINGS,
    secret: () => null,
    watchedBaseSkus: () => [],
    nextQueuedSnapshot: () => null,
    snapshot: async () => undefined,
    keyQuotesChanged: () => undefined,
  };
  const scheduler = createScheduler({ clock: time, timers: time, log: quiet, isPaused: () => false, tickMs: opts.tickMs ?? MIN });
  scheduler.add(buildJobs(ctx).find((j) => j.id === 'pricedb-all')!);
  scheduler.start();
  /** Request times in hours since start. */
  const hours = (): number[] => requests.map((t) => (t - T0) / HOUR);
  const state = () => scheduler.states()[0]!;
  return { time, repo, requests, hours, state, scheduler };
}

describe("'pricedb-all' cadence", () => {
  it('loads every 4 h with a 5 s download', async () => {
    const h = harness();
    await h.time.advance(21 * HOUR);
    expect(h.hours()).toEqual([0, 4, 8, 12, 16, 20]);
    expect(h.state().lastError).toBeNull();
    h.scheduler.stop();
  });

  it('stamps the load with its start time', async () => {
    const h = harness();
    await h.time.advance(MIN);
    expect(Number(h.repo.getMeta(META_LOAD_ALL_AT))).toBe(T0);
    h.scheduler.stop();
  });

  it('retries a failed reload after about 15 min and reports the failure until then', async () => {
    const h = harness({ fail: [2] });
    await h.time.advance(8 * HOUR + MIN);
    expect(h.hours()).toEqual([0, 4, 8]);
    expect(h.state().lastError).toBe('run reported a failure');
    await h.time.advance(16 * MIN);
    expect(h.requests).toHaveLength(4);
    const retryAt = h.requests[3]! - T0;
    expect(retryAt).toBeGreaterThanOrEqual(8 * HOUR + 15 * MIN);
    expect(retryAt).toBeLessThanOrEqual(8 * HOUR + 17 * MIN);
    expect(h.state().lastError).toBeNull();
    h.scheduler.stop();
  });

  it('retries a failed reload after an earlier process loaded the list', async () => {
    const h = harness({ fail: [0], lastLoadAt: T0 - 5 * HOUR });
    await h.time.advance(MIN);
    expect(h.state().lastError).toBe('run reported a failure');
    await h.time.advance(19 * MIN);
    expect(h.requests).toHaveLength(2);
    const retryAt = h.requests[1]! - T0;
    expect(retryAt).toBeGreaterThanOrEqual(15 * MIN);
    expect(retryAt).toBeLessThanOrEqual(17 * MIN);
    expect(h.state().lastError).toBeNull();
    h.scheduler.stop();
  });

  it('retries a failed first load after about 15 min', async () => {
    const h = harness({ fail: [0] });
    await h.time.advance(20 * MIN);
    expect(h.requests).toHaveLength(2);
    const retryAt = h.requests[1]! - T0;
    expect(retryAt).toBeGreaterThanOrEqual(15 * MIN);
    expect(retryAt).toBeLessThanOrEqual(17 * MIN);
    h.scheduler.stop();
  });

  it('a kick shortly after a load sends nothing and reports OK', async () => {
    const h = harness();
    await h.time.advance(10 * MIN);
    h.scheduler.kick('pricedb-all');
    await h.time.advance(2 * MIN);
    expect(h.requests).toHaveLength(1);
    // 0.7.3 (r4-clock-4): the kick keeps the job due 4 h after the load instead of running a skip.
    expect(h.state().lastRunAt).toBe(T0);
    expect(h.state().nextDueAt).toBe(T0 + 4 * HOUR);
    expect(h.state().lastError).toBeNull();
    h.scheduler.stop();
  });

  it('keeps the 4 h cadence with the default 1 s tick', async () => {
    const h = harness({ tickMs: 1_000 });
    await h.time.advance(9 * HOUR);
    expect(h.hours()).toEqual([0, 4, 8]);
    h.scheduler.stop();
  });
});

describe('loadAllFresh', () => {
  const now = T0;
  it('is false for no stamp, an unreadable one or one in the future', () => {
    expect(loadAllFresh(null, now)).toBe(false);
    expect(loadAllFresh('', now)).toBe(false);
    expect(loadAllFresh('soon', now)).toBe(false);
    expect(loadAllFresh(String(now + 1), now)).toBe(false);
  });

  it('is true until the slack before 4 h', () => {
    const edge = LOAD_ALL_MIN_INTERVAL_MS - LOAD_ALL_SLACK_MS;
    expect(loadAllFresh(String(now), now)).toBe(true);
    expect(loadAllFresh(String(now - edge + 1), now)).toBe(true);
    expect(loadAllFresh(String(now - edge), now)).toBe(false);
  });
});
