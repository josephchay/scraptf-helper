// 0.7.4 trading accuracy audit, package G2 (review R16, R35): F52 counts a 500, 502-504 or Cloudflare 52x on a
// background snapshot as the host's failure (the budget is paused; no 30-min cooldown for the SKU), but one name
// that keeps failing must not take every slot. snapshot-watched now rotates: a base whose last answer was
// unavailable goes behind every other stale candidate for SNAPSHOT_STALE_MS (taken only when none is left), and
// a second unavailable answer for it after another base's book was fetched cools it down like a 4xx (the name
// fails, not the host). Still at most one request a run, none while the budget is paused, watched bases only.
// The fake budget pauses like the real one (backoffMs after each unavailable answer, reset on a success).

import { afterEach, describe, expect, it } from 'vitest';
import type { BptfApi, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { HttpStatusError } from '../../src/service/net';
import { backoffMs } from '../../src/service/net/ratelimit';
import { SNAPSHOT_FAIL_BASE_MS, SNAPSHOT_STALE_MS, buildJobs, type JobContext, type JobSpec } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { FakeTime, T0 } from '../net/helpers';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const MIN = 60_000;
const HOUR = 60 * MIN;
const SNAPSHOT_URL = 'https://api.backpack.tf/api/classifieds/listings/snapshot';
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function harness(opts: { watched: string[]; priority?: () => string[]; status: (base: string) => number | null }) {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  const snapshots: string[] = [];
  let pausedUntil = 0;
  let nBackoff = 0;
  /** Requests sent while the budget was paused (must stay 0). */
  let sentWhilePaused = 0;
  const ctx: JobContext = {
    clock: time,
    log: quiet,
    repo,
    http: { nextAllowedAt: () => pausedUntil, hostBlocked: () => null } as unknown as HttpClient,
    schema: {} as SchemaService,
    pricedb: {} as PriceDb,
    bptfApi: { snapshotAvailable: () => true } as unknown as BptfApi,
    engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
    settings: () => DEFAULT_SETTINGS,
    secret: () => 'secret-value',
    watchedBaseSkus: () => opts.watched,
    nextQueuedSnapshot: () => null,
    ...(opts.priority ? { snapshotPriority: opts.priority } : {}),
    snapshot: async (base) => {
      if (pausedUntil > time.now()) sentWhilePaused++;
      snapshots.push(base);
      const status = opts.status(base);
      if (status !== null) {
        nBackoff++;
        pausedUntil = time.now() + backoffMs(nBackoff);
        throw new HttpStatusError(status, SNAPSHOT_URL, null);
      }
      nBackoff = 0;
      repo.setSnapshotAt(base, time.now());
    },
    keyQuotesChanged: () => undefined,
  };
  const job: JobSpec = buildJobs(ctx).find((j) => j.id === 'snapshot-watched')!;
  /** One run of the job, then a minute passes (the job's cadence). */
  const run = async (): Promise<void> => {
    await job.run().catch(() => undefined);
    await time.advance(MIN);
  };
  return { time, repo, snapshots, run, sentWhilePaused: () => sentWhilePaused };
}

describe('snapshot-watched after an unavailable answer (R16, R35)', () => {
  it('rotates past a name that always answers 500, then cools it down; the others are snapshotted', async () => {
    const h = harness({ watched: ['378;6', '126;6', '205;6'], status: (b) => (b === '378;6' ? 500 : null) });
    for (let i = 0; i < 6; i++) await h.run();
    // 378;6 (oldest, never snapshotted) first; the budget pause, then the two others; then 378;6 once more as
    // the last stale candidate: a 500 again after another book was fetched, so it cools down.
    expect(h.snapshots).toEqual(['378;6', '126;6', '205;6', '378;6']);
    expect(h.sentWhilePaused()).toBe(0);
    // While cooling down (30 min), nothing more goes to it.
    for (let i = 0; i < 20; i++) await h.run();
    expect(h.snapshots.filter((b) => b === '378;6')).toHaveLength(2);
    // The others stay fresh: each is snapshotted again once stale.
    await h.time.advance(SNAPSHOT_STALE_MS);
    for (let i = 0; i < 5; i++) await h.run();
    expect(h.snapshots.filter((b) => b === '126;6').length).toBeGreaterThanOrEqual(2);
    expect(h.snapshots.filter((b) => b === '205;6').length).toBeGreaterThanOrEqual(2);
  });

  it('does not let the top priority base answering 502 starve the oldest-first scan', async () => {
    const h = harness({ watched: ['378;6', '126;6', '205;6'], priority: () => ['205;6'], status: (b) => (b === '205;6' ? 502 : null) });
    for (let i = 0; i < 6; i++) await h.run();
    expect(h.snapshots.slice(0, 3)).toEqual(['205;6', '378;6', '126;6']);
    expect(h.snapshots.filter((b) => b === '205;6')).toHaveLength(2);
  });

  it('in a real outage (every base 5xx) sends at most one request per pause and cools no base down', async () => {
    let down = true;
    const h = harness({ watched: ['378;6', '126;6', '205;6'], status: () => (down ? 503 : null) });
    for (let i = 0; i < 60; i++) await h.run();
    expect(h.sentWhilePaused()).toBe(0);
    // 60 min of outage: pauses of 1, 2, 4, 8, 15, 15 ... min, so a handful of tries, spread over the bases.
    expect(h.snapshots.length).toBeLessThanOrEqual(8);
    expect(new Set(h.snapshots).size).toBe(3);
    // Back up: every base is snapshotted within the next runs (no SKU was cooled down for 30 min).
    down = false;
    await h.time.advance(15 * MIN);
    const before = h.snapshots.length;
    for (let i = 0; i < 3; i++) await h.run();
    expect(new Set(h.snapshots.slice(before))).toEqual(new Set(['378;6', '126;6', '205;6']));
  });

  it('keeps F52 for a single watched base: retried as soon as the pause ends, never cooled down', async () => {
    let fail = true;
    const h = harness({ watched: ['378;6'], status: () => (fail ? 500 : null) });
    await h.run(); // 500, paused 1 min
    await h.run(); // 500 again (nothing else to take), paused 2 min
    await h.time.advance(2 * MIN);
    fail = false;
    await h.run();
    expect(h.snapshots).toEqual(['378;6', '378;6', '378;6']);
    expect(h.repo.getSnapshotAt('378;6')).not.toBeNull();
  });

  it('a single 5xx followed by a success on the same base never cools it down', async () => {
    let fail = true;
    const h = harness({ watched: ['378;6', '126;6'], status: (b) => (b === '378;6' && fail ? 500 : null) });
    await h.run(); // 378;6: 500
    fail = false;
    await h.run(); // 126;6 (378;6 waits behind the other stale base)
    await h.run(); // 378;6 again: succeeds
    expect(h.snapshots).toEqual(['378;6', '126;6', '378;6']);
    // Stale again in 30 min: taken at once, no cooldown in the way.
    await h.time.advance(SNAPSHOT_STALE_MS);
    await h.run();
    await h.run();
    expect(h.snapshots.slice(3).sort()).toEqual(['126;6', '378;6']);
    expect(SNAPSHOT_FAIL_BASE_MS).toBe(30 * MIN);
    expect(HOUR).toBe(60 * MIN);
  });
});
