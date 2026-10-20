// Audit 0.7.3: a wall clock stepped back while the service runs (time sync, a
// manual fix, a dual-boot RTC offset) must not stall the background jobs for
// the size of the step. Timers fire on elapsed time like Node's setTimeout
// (FakeTime); the clock the scheduler reads is that time plus an offset the
// test steps.

import { afterEach, describe, expect, it } from 'vitest';
import type { BptfApi, Clock, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { buildJobs, createScheduler, type JobContext, type JobSpec } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { FakeTime, T0 } from '../net/helpers';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

function harness() {
  const time = new FakeTime(T0);
  let offset = 0;
  const wall: Clock = { now: () => time.now() + offset };
  const s = createScheduler({ clock: wall, timers: time, log: quiet, isPaused: () => false, tickMs: SEC });
  return {
    time,
    wall,
    s,
    step: (ms: number) => {
      offset += ms;
    },
  };
}

/** A job that records the elapsed (timer) time of each run. */
function counted(time: FakeTime, spec: Partial<JobSpec> & { id: string; everyMs: number }) {
  const runs: number[] = [];
  const job: JobSpec = {
    ...spec,
    run: async () => {
      runs.push(time.now() - T0);
    },
  };
  return { job, runs };
}

describe('scheduler: wall clock stepped back while running', () => {
  it('keeps every job on its cadence instead of waiting out the step', async () => {
    const h = harness();
    const minute = counted(h.time, { id: 'minute', everyMs: MIN });
    const hourly = counted(h.time, { id: 'hourly', everyMs: HOUR });
    const daily = counted(h.time, { id: 'daily', everyMs: 24 * HOUR, firstDelayMs: 5 * MIN });
    for (const j of [minute, hourly, daily]) h.s.add(j.job);
    h.s.start();
    await h.time.advance(10 * MIN);
    expect(minute.runs).toHaveLength(11);
    expect(daily.runs).toEqual([5 * MIN]);
    h.step(-8 * HOUR);
    await h.time.advance(30 * MIN);
    expect(minute.runs.filter((t) => t > 10 * MIN).length).toBeGreaterThanOrEqual(29);
    for (const st of h.s.states()) {
      const every = st.id === 'minute' ? MIN : st.id === 'hourly' ? HOUR : 24 * HOUR;
      expect(st.nextDueAt - h.wall.now()).toBeLessThanOrEqual(every);
    }
    h.s.stop();
  });

  it('never runs a job earlier than its cadence in elapsed time', async () => {
    const h = harness();
    const hourly = counted(h.time, { id: 'hourly', everyMs: HOUR });
    h.s.add(hourly.job);
    h.s.start();
    await h.time.advance(10 * MIN);
    expect(hourly.runs).toEqual([0]);
    h.step(-8 * HOUR);
    await h.time.advance(49 * MIN); // 59 min after the run
    expect(hourly.runs).toEqual([0]);
    await h.time.advance(12 * MIN); // 71 min after the run
    expect(hourly.runs).toHaveLength(2);
    expect(hourly.runs[1]!).toBeGreaterThanOrEqual(HOUR);
    expect(hourly.runs[1]!).toBeLessThanOrEqual(71 * MIN);
    h.s.stop();
  });

  it('keeps a start delay that is longer than the cadence', async () => {
    const h = harness();
    const late = counted(h.time, { id: 'late', everyMs: 10 * SEC, firstDelayMs: 60 * SEC });
    h.s.add(late.job);
    h.s.start();
    await h.time.advance(59 * SEC);
    expect(late.runs).toHaveLength(0);
    await h.time.advance(SEC);
    expect(late.runs).toEqual([60 * SEC]);
    h.s.stop();
  });

  it('a clock that jumps forward causes no burst of catch-up runs', async () => {
    const h = harness();
    const minute = counted(h.time, { id: 'minute', everyMs: MIN });
    h.s.add(minute.job);
    h.s.start();
    await h.time.advance(5 * MIN);
    const before = minute.runs.length;
    h.step(8 * HOUR);
    await h.time.advance(2 * MIN);
    expect(minute.runs.length - before).toBeLessThanOrEqual(3);
    h.s.stop();
  });
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

describe('snapshot-watched: wall clock stepped back while running', () => {
  it('treats a snapshot stamped in the future as stale instead of fresh', async () => {
    const time = new FakeTime(T0);
    const repo = openRepo(':memory:');
    repos.push(repo);
    const FUTURE = '200;11;australium';
    const FRESH = '211;11;australium';
    repo.setSnapshotAt(FUTURE, time.now() + 5 * HOUR); // stamped before an 8 h step back
    repo.setSnapshotAt(FRESH, time.now() - 5 * MIN);
    const snapshots: string[] = [];
    const ctx: JobContext = {
      clock: time,
      log: quiet,
      repo,
      http: { nextAllowedAt: () => 0, hostBlocked: () => null } as unknown as HttpClient,
      schema: {} as SchemaService,
      pricedb: {} as PriceDb,
      bptfApi: { snapshotAvailable: () => true, credentialRejected: () => null } as unknown as BptfApi,
      engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
      settings: () => DEFAULT_SETTINGS,
      secret: () => 'secret-value',
      watchedBaseSkus: () => [FRESH, FUTURE],
      nextQueuedSnapshot: () => null,
      snapshot: async (base) => {
        snapshots.push(base);
        repo.setSnapshotAt(base, time.now());
      },
      keyQuotesChanged: () => undefined,
    };
    const job = buildJobs(ctx).find((j) => j.id === 'snapshot-watched')!;
    await job.run();
    expect(snapshots).toEqual([FUTURE]);
    // Refreshed with a current time, it is fresh again: nothing is picked a second time.
    await time.advance(MIN);
    await job.run();
    expect(snapshots).toEqual([FUTURE]);
  });
});
