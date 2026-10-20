// 0.7.3 follow-up (fu-clock-2): a wall clock stepped back by more than the time since PriceDB's last full
// load left that load's stamp in the future. The scheduler moved 'pricedb-all' to 4 h after the step, but by
// then the clock had passed the stamp, so loadAll() skipped the list as fresh and the next load came a
// whole cadence later (up to about 12 h after the previous one). The job now clamps the stamp to now when the
// scheduler clamps the job, and a load the clock moved back past mid-download is stamped with its end.
// Timers fire on elapsed time (FakeTime); the clock the code reads is that time plus an offset the test steps.

import { afterEach, describe, expect, it } from 'vitest';
import { META_LOAD_ALL_AT, createPriceDb } from '../../src/service/connectors/pricedb';
import type { BptfApi, Clock, Engine, HttpResponse, Repo, SchemaService, ServiceDeps } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { buildJobs, createScheduler, type JobContext, type JobSpec } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { FakeTime, T0 } from '../net/helpers';
import { FakeHttp, fixture, res } from '../pricedb/helpers';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** Real PriceDB connector and 'pricedb-all' job; /autob/items answers after `downloadMs`. */
function harness(opts: { tickMs: number; downloadMs?: number; duringDownload?: () => void }) {
  const time = new FakeTime(T0);
  let offset = 0;
  const wall: Clock = { now: () => time.now() + offset };
  const repo = openRepo(':memory:');
  repos.push(repo);
  const requests: number[] = [];
  const http = new FakeHttp((url) => {
    if (!url.endsWith('/autob/items')) return res(null, { status: 404 });
    requests.push(time.now());
    if (requests.length === 1 && opts.duringDownload) time.setTimeout(opts.duringDownload, SEC);
    return new Promise<HttpResponse>((resolve) => {
      time.setTimeout(() => resolve(res(fixture('autob-items.json'))), opts.downloadMs ?? 5 * SEC);
    });
  });
  const deps: ServiceDeps = { clock: wall, log: quiet, repo, http, settings: () => DEFAULT_SETTINGS, secret: () => null };
  const ctx: JobContext = {
    clock: wall,
    log: quiet,
    repo,
    http,
    schema: {} as unknown as SchemaService,
    pricedb: createPriceDb(deps, { timers: time }),
    bptfApi: {} as unknown as BptfApi,
    engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
    settings: () => DEFAULT_SETTINGS,
    secret: () => null,
    watchedBaseSkus: () => [],
    nextQueuedSnapshot: () => null,
    snapshot: async () => undefined,
    keyQuotesChanged: () => undefined,
  };
  const job = buildJobs(ctx).find((j) => j.id === 'pricedb-all')!;
  const scheduler = createScheduler({ clock: wall, timers: time, log: quiet, isPaused: () => false, tickMs: opts.tickMs });
  scheduler.add(job);
  scheduler.start();
  return {
    time,
    wall,
    repo,
    job,
    scheduler,
    step: (ms: number) => {
      offset += ms;
    },
    /** Request times in elapsed ms since start. */
    elapsed: () => requests.map((t) => t - T0),
    stamp: () => Number(repo.getMeta(META_LOAD_ALL_AT)),
  };
}

describe("'pricedb-all': wall clock stepped back past the last load", () => {
  it('loads 4 h after the step instead of skipping the list as fresh', async () => {
    const h = harness({ tickMs: MIN });
    await h.time.advance(HOUR);
    expect(h.elapsed()).toEqual([0]);
    h.step(-2 * HOUR); // the stamp (T0) is now an hour in the future
    await h.time.advance(MIN);
    expect(h.stamp()).toBe(h.wall.now());
    await h.time.advance(4 * HOUR + MIN);
    expect(h.elapsed()).toEqual([0, 5 * HOUR + MIN]);
    await h.time.advance(4 * HOUR);
    expect(h.elapsed()).toEqual([0, 5 * HOUR + MIN, 9 * HOUR + MIN]);
    expect(h.scheduler.states()[0]!.lastError).toBeNull();
    h.scheduler.stop();
  });

  it('stamps a load the clock moved back past mid-download with its end, so the next one is not skipped', async () => {
    const h = harness({ tickMs: SEC, downloadMs: 5 * SEC, duringDownload: () => h.step(-2 * HOUR) });
    await h.time.advance(10 * SEC);
    expect(h.stamp()).toBe(T0 + 5 * SEC - 2 * HOUR);
    await h.time.advance(4 * HOUR);
    expect(h.elapsed()).toHaveLength(2);
    expect(h.elapsed()[1]!).toBeLessThanOrEqual(4 * HOUR + 5 * SEC);
    h.scheduler.stop();
  });

  it('leaves a stamp that is not in the future alone', () => {
    const h = harness({ tickMs: MIN });
    h.scheduler.stop();
    const now = h.wall.now();
    h.repo.setMeta(META_LOAD_ALL_AT, String(now - HOUR));
    h.job.clockMovedBack!(now);
    expect(h.stamp()).toBe(now - HOUR);
    h.repo.setMeta(META_LOAD_ALL_AT, String(now + HOUR));
    h.job.clockMovedBack!(now);
    expect(h.stamp()).toBe(now);
  });
});

describe('scheduler: clockMovedBack', () => {
  it('is called once per clamp, and a throwing hook neither stops the tick nor the job', async () => {
    const time = new FakeTime(T0);
    let offset = 0;
    const wall: Clock = { now: () => time.now() + offset };
    const calls: number[] = [];
    const runs: number[] = [];
    const warnings: string[] = [];
    const job: JobSpec = {
      id: 'hourly',
      everyMs: HOUR,
      clockMovedBack: (now) => {
        calls.push(now);
        throw new Error('disk full');
      },
      run: async () => {
        runs.push(time.now() - T0);
      },
    };
    const s = createScheduler({ clock: wall, timers: time, log: { ...quiet, warn: (m: string) => warnings.push(m) }, isPaused: () => false, tickMs: SEC });
    s.add(job);
    s.start();
    await time.advance(10 * MIN);
    expect(calls).toEqual([]);
    offset -= 8 * HOUR;
    await time.advance(10 * MIN);
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual(['job hourly: clamping its stamps failed: disk full']);
    await time.advance(51 * MIN); // an hour after the step
    expect(runs).toHaveLength(2);
    expect(calls).toHaveLength(1);
    s.stop();
  });
});
