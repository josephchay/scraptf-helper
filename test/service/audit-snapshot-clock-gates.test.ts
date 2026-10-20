// 0.7.3 follow-up (fu-clock-2): two more wall-clock gates around background snapshots that a clock
// stepped back while running used to stretch by the size of the step:
// - snapshot-watched's per-SKU failure cooldown, whose `until` now never lies more than its own wait
//   ahead (clamped as the scheduler clamps nextDueAt);
// - the core's snapshotStale (a price saved queues a snapshot when the book is stale), which now shares
//   the scheduler's test: a snapshot stamped in the future has no known age and counts as stale.
//   This file covers the pure snapshotIsStale; audit-core-snapshot-stale runs the core's own gate.

import { afterEach, describe, expect, it } from 'vitest';
import type { BptfApi, Clock, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import {
  SNAPSHOT_FAIL_BASE_MS,
  SNAPSHOT_FAIL_MAX_MS,
  SNAPSHOT_STALE_MS,
  buildJobs,
  snapshotFailWait,
  snapshotIsStale,
  type JobContext,
} from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { T0 } from '../net/helpers';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const MIN = 60_000;
const HOUR = 60 * MIN;
const SKU = '200;11;australium';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** The snapshot-watched job on a clock that reads elapsed time plus an offset the test steps. */
function harness() {
  let elapsed = 0;
  let offset = 0;
  const wall: Clock = { now: () => T0 + elapsed + offset };
  const repo = openRepo(':memory:');
  repos.push(repo);
  const attempts: number[] = [];
  const ctx: JobContext = {
    clock: wall,
    log: quiet,
    repo,
    http: { nextAllowedAt: () => 0, hostBlocked: () => null } as unknown as HttpClient,
    schema: {} as SchemaService,
    pricedb: {} as PriceDb,
    bptfApi: { snapshotAvailable: () => true, credentialRejected: () => null } as unknown as BptfApi,
    engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
    settings: () => DEFAULT_SETTINGS,
    secret: () => 'secret-value',
    watchedBaseSkus: () => [SKU],
    nextQueuedSnapshot: () => null,
    // Not a global failure (pause, budget, credential, host): the SKU itself cools down.
    snapshot: async () => {
      attempts.push(elapsed);
      throw new Error('unreadable snapshot');
    },
    keyQuotesChanged: () => undefined,
  };
  const job = buildJobs(ctx).find((j) => j.id === 'snapshot-watched')!;
  /** Runs the job at `ms` of elapsed time; true when it tried the SKU. */
  const runAt = async (ms: number): Promise<boolean> => {
    elapsed = ms;
    const before = attempts.length;
    await job.run().catch(() => undefined);
    return attempts.length > before;
  };
  return {
    attempts,
    runAt,
    step: (ms: number) => {
      offset += ms;
    },
  };
}

describe('snapshot-watched failure cooldown', () => {
  it('waits its 30 min after a failure', async () => {
    const h = harness();
    expect(await h.runAt(0)).toBe(true);
    expect(await h.runAt(29 * MIN)).toBe(false);
    expect(await h.runAt(31 * MIN)).toBe(true);
  });

  it('is not stretched by a clock stepped back 8 h', async () => {
    const h = harness();
    expect(await h.runAt(0)).toBe(true);
    h.step(-8 * HOUR);
    // The next run sees the step: the cooldown keeps at most its own 30 min from then.
    expect(await h.runAt(MIN)).toBe(false);
    expect(await h.runAt(30 * MIN)).toBe(false);
    expect(await h.runAt(32 * MIN)).toBe(true);
    // The second failure in a row waits 60 min, measured as before.
    expect(await h.runAt(91 * MIN)).toBe(false);
    expect(await h.runAt(93 * MIN)).toBe(true);
  });
});

describe('snapshotFailWait', () => {
  it('doubles from 30 min per failure in a row, up to a day', () => {
    expect(snapshotFailWait(1)).toBe(SNAPSHOT_FAIL_BASE_MS);
    expect(snapshotFailWait(2)).toBe(2 * SNAPSHOT_FAIL_BASE_MS);
    expect(snapshotFailWait(6)).toBe(16 * HOUR);
    expect(snapshotFailWait(7)).toBe(SNAPSHOT_FAIL_MAX_MS);
    expect(snapshotFailWait(1_000)).toBe(SNAPSHOT_FAIL_MAX_MS);
  });
});

describe('snapshotIsStale', () => {
  const now = T0;
  it('is true with no snapshot or one at least 30 min old', () => {
    expect(snapshotIsStale(null, now)).toBe(true);
    expect(snapshotIsStale(0, now)).toBe(true);
    expect(snapshotIsStale(now - SNAPSHOT_STALE_MS, now)).toBe(true);
  });

  it('is false for a snapshot under 30 min old', () => {
    expect(snapshotIsStale(now, now)).toBe(false);
    expect(snapshotIsStale(now - SNAPSHOT_STALE_MS + 1, now)).toBe(false);
  });

  it('is true for a snapshot stamped in the future (the clock moved back)', () => {
    expect(snapshotIsStale(now + 1, now)).toBe(true);
    expect(snapshotIsStale(now + 8 * HOUR, now)).toBe(true);
  });
});
