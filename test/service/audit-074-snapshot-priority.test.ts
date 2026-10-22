// 0.7.4 trading accuracy audit (package PB), F16/F24/F30: the background snapshot job never reached the
// books that matter (none of the 7 profitable rows was ever snapshotted). snapshot-watched now takes, after
// its queue, ctx.snapshotPriority's first stale watched base (unconfirmed profitable rows first), then the
// oldest snapshot as before. Same job, same cadence and budget: at most one snapshot a run, none while the
// 'bptf-snapshot' budget has no free slot, watched bases only. A per-process lastTried map keeps a base
// whose snapshot came from the 10-min cache (no stamp) from taking the slot every minute.

import { afterEach, describe, expect, it } from 'vitest';
import type { BptfApi, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { NetworkPausedError } from '../../src/service/net';
import { SNAPSHOT_STALE_MS, buildJobs, type JobContext, type JobSpec } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { FakeTime, T0 } from '../net/helpers';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const MIN = 60_000;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

interface Opts {
  watched: string[];
  priority?: () => string[];
  queue?: string[];
  /** Bases whose snapshot is "served from cache": returns without stamping snapshot_times. */
  cached?: Set<string>;
  fail?: (base: string) => Error | null;
  nextAllowedAt?: () => number;
}

function harness(opts: Opts) {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  const snapshots: string[] = [];
  const queue = [...(opts.queue ?? [])];
  const ctx: JobContext = {
    clock: time,
    log: quiet,
    repo,
    http: { nextAllowedAt: opts.nextAllowedAt ?? (() => 0), hostBlocked: () => null } as unknown as HttpClient,
    schema: {} as SchemaService,
    pricedb: {} as PriceDb,
    bptfApi: { snapshotAvailable: () => true } as unknown as BptfApi,
    engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
    settings: () => DEFAULT_SETTINGS,
    secret: () => 'secret-value',
    watchedBaseSkus: () => opts.watched,
    nextQueuedSnapshot: () => queue.shift() ?? null,
    ...(opts.priority ? { snapshotPriority: opts.priority } : {}),
    snapshot: async (base) => {
      snapshots.push(base);
      const err = opts.fail?.(base) ?? null;
      if (err) throw err;
      if (!opts.cached?.has(base)) repo.setSnapshotAt(base, time.now());
    },
    keyQuotesChanged: () => undefined,
  };
  const job: JobSpec = buildJobs(ctx).find((j) => j.id === 'snapshot-watched')!;
  const run = async (): Promise<void> => {
    await job.run().catch(() => undefined);
    await time.advance(MIN);
  };
  return { time, repo, snapshots, queue, run };
}

describe('snapshot-watched: priority within the same budget (F16, F24, F30)', () => {
  it('takes the queue, then the priority bases in order, then the oldest snapshot; one per run', async () => {
    const h = harness({ watched: ['378;6', '126;6', '205;6', '15000;6'], priority: () => ['205;6', '126;6'], queue: ['15000;6'] });
    for (let i = 0; i < 4; i++) await h.run();
    expect(h.snapshots).toEqual(['15000;6', '205;6', '126;6', '378;6']);
    // Nothing is stale any more: no fifth request.
    await h.run();
    expect(h.snapshots).toHaveLength(4);
  });

  it('skips a priority base snapshotted within 30 min, and takes it again once stale', async () => {
    const h = harness({ watched: ['378;6', '205;6'], priority: () => ['205;6'] });
    h.repo.setSnapshotAt('378;6', T0 - 10 * 60 * MIN);
    await h.run();
    await h.run();
    expect(h.snapshots).toEqual(['205;6', '378;6']);
    await h.time.advance(SNAPSHOT_STALE_MS);
    await h.run();
    expect(h.snapshots).toEqual(['205;6', '378;6', '205;6']);
  });

  it('never snapshots a priority base that is not watched', async () => {
    const h = harness({ watched: ['378;6'], priority: () => ['30920;6'] });
    await h.run();
    expect(h.snapshots).toEqual(['378;6']);
  });

  it('does not let a base served from the snapshot cache take the slot every minute', async () => {
    const h = harness({ watched: ['378;6', '126;6', '205;6'], priority: () => ['205;6'], cached: new Set(['205;6']) });
    for (let i = 0; i < 3; i++) await h.run();
    // c was tried once (no stamp: a cached answer), then the others got their turn.
    expect(h.snapshots).toEqual(['205;6', '378;6', '126;6']);
    await h.time.advance(SNAPSHOT_STALE_MS);
    await h.run();
    expect(h.snapshots.at(-1)).toBe('205;6');
  });

  it('retries a priority base the next minute after a failure that is not its fault (no lastTried stamp)', async () => {
    let paused = true;
    const h = harness({ watched: ['378;6', '205;6'], priority: () => ['205;6'], fail: (b) => (b === '205;6' && paused ? new NetworkPausedError() : null) });
    await h.run();
    paused = false;
    await h.run();
    expect(h.snapshots).toEqual(['205;6', '205;6']);
  });

  it('sends nothing while the snapshot budget has no free slot', async () => {
    const h = harness({ watched: ['378;6'], priority: () => ['378;6'], nextAllowedAt: () => Number.MAX_SAFE_INTEGER });
    for (let i = 0; i < 3; i++) await h.run();
    expect(h.snapshots).toEqual([]);
  });

  it('falls back to the oldest-first scan when the ranking throws', async () => {
    const h = harness({
      watched: ['378;6'],
      priority: () => {
        throw new Error('no rows');
      },
    });
    await h.run();
    expect(h.snapshots).toEqual(['378;6']);
  });
});
