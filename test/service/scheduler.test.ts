import { afterEach, describe, expect, it } from 'vitest';
import type { BptfApi, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { HttpStatusError, NetworkPausedError, RateLimitedError } from '../../src/service/net';
import {
  META_PRICES_CURRENT_TIME,
  META_PRICES_FETCHED_AT,
  SNAPSHOT_FAIL_BASE_MS,
  buildJobs,
  createScheduler,
  type JobContext,
  type JobSpec,
} from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { FakeTime, T0 } from '../net/helpers';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function harness(paused = { value: false }) {
  const time = new FakeTime(T0);
  const s = createScheduler({ clock: time, timers: time, log: quiet, isPaused: () => paused.value, tickMs: 1_000 });
  return { time, s, paused };
}

function counter(spec: Partial<JobSpec> & { id: string; everyMs: number }, run?: () => Promise<boolean | void>) {
  const runs: number[] = [];
  const job: JobSpec = {
    ...spec,
    run: async () => {
      runs.push(runs.length);
      return run ? run() : undefined;
    },
  };
  return { job, runs };
}

describe('scheduler', () => {
  it('runs a job at start and then on a fixed cadence', async () => {
    const { time, s } = harness();
    const a = counter({ id: 'a', everyMs: 10_000 });
    s.add(a.job);
    s.start();
    await time.advance(0);
    expect(a.runs).toHaveLength(1);
    await time.advance(9_000);
    expect(a.runs).toHaveLength(1);
    await time.advance(1_000);
    expect(a.runs).toHaveLength(2);
    await time.advance(30_000);
    expect(a.runs).toHaveLength(5);
    s.stop();
  });

  it('never overlaps a slow run with itself', async () => {
    const { time, s } = harness();
    let release: () => void = () => undefined;
    const slow = counter({ id: 'slow', everyMs: 1_000 }, () => new Promise<void>((r) => (release = r)));
    s.add(slow.job);
    s.start();
    await time.advance(5_000);
    expect(slow.runs).toHaveLength(1);
    expect(s.states()[0]!.running).toBe(true);
    release();
    await time.advance(1_000);
    expect(slow.runs).toHaveLength(2);
    s.stop();
  });

  it('skips network jobs while paused and runs them once resumed; local jobs keep running', async () => {
    const paused = { value: true };
    const { time, s } = harness(paused);
    const net = counter({ id: 'net', everyMs: 60_000 });
    const local = counter({ id: 'local', everyMs: 60_000, network: false });
    s.add(net.job);
    s.add(local.job);
    s.start();
    await time.advance(5_000);
    expect(net.runs).toHaveLength(0);
    expect(local.runs).toHaveLength(1);
    expect(s.states().find((j) => j.id === 'net')!.skipped).toBe('network paused');
    paused.value = false;
    await time.advance(1_000);
    expect(net.runs).toHaveLength(1);
    s.stop();
  });

  it('waits while blocked, retries failures sooner and can be kicked', async () => {
    const { time, s } = harness();
    let blocked: string | null = 'no API key';
    let fail = true;
    const job = counter({ id: 'key', everyMs: 3_600_000, retryMs: 60_000, blockedReason: () => blocked }, async () => !fail);
    s.add(job.job);
    s.start();
    await time.advance(10_000);
    expect(job.runs).toHaveLength(0);
    blocked = null;
    await time.advance(1_000);
    expect(job.runs).toHaveLength(1); // failed
    expect(s.states()[0]!.lastError).not.toBeNull();
    await time.advance(60_000);
    expect(job.runs).toHaveLength(2); // retried after retryMs, not an hour
    fail = false;
    await time.advance(60_000);
    expect(job.runs).toHaveLength(3);
    expect(s.states()[0]!.lastError).toBeNull();
    s.kick('key');
    await time.advance(1_000);
    expect(job.runs).toHaveLength(4);
    s.stop();
  });

  it('logs a thrown error instead of throwing, and keeps the cadence', async () => {
    const { time, s } = harness();
    const boom = counter({ id: 'boom', everyMs: 10_000 }, async () => {
      throw new Error('boom');
    });
    s.add(boom.job);
    s.start();
    await time.advance(25_000);
    expect(boom.runs).toHaveLength(3);
    expect(s.states()[0]!.lastError).toBe('boom');
    s.stop();
    await s.whenIdle();
  });

  it('evaluates a computed first delay when it starts', async () => {
    const { time, s } = harness();
    let delay = 0;
    const job = counter({ id: 'computed', everyMs: 3_600_000, firstDelayMs: () => delay });
    s.add(job.job);
    delay = 30_000; // read at start(), not when the job was added
    s.start();
    await time.advance(29_000);
    expect(job.runs).toHaveLength(0);
    await time.advance(1_000);
    expect(job.runs).toHaveLength(1);
    s.stop();
  });

  it('keeps a job that a network pause cut short due, so it runs right after resume instead of after retryMs', async () => {
    const paused = { value: false };
    const { time, s } = harness(paused);
    let release: (v: boolean | void) => void = () => undefined;
    let rejectRun: (e: unknown) => void = () => undefined;
    const thrower = counter({ id: 'thrower', everyMs: 2 * 3_600_000, retryMs: 20 * 60_000 }, () => {
      return new Promise<boolean | void>((resolve, reject) => {
        release = resolve;
        rejectRun = reject;
      });
    });
    // Like pricedb.loadAll(): swallows the pause and only reports failure.
    let swallow: (v: boolean) => void = () => undefined;
    const swallower = counter({ id: 'swallower', everyMs: 4 * 3_600_000, retryMs: 15 * 60_000 }, () => {
      return new Promise<boolean>((resolve) => {
        swallow = resolve;
      });
    });
    s.add(thrower.job);
    s.add(swallower.job);
    s.start();
    await time.advance(0);
    expect(thrower.runs).toHaveLength(1);
    expect(swallower.runs).toHaveLength(1);
    paused.value = true; // http.setPaused(true) aborts both in-flight requests
    rejectRun(new NetworkPausedError());
    swallow(false);
    await time.advance(5_000);
    expect(s.states().find((j) => j.id === 'thrower')!.skipped).toBe('network paused');
    paused.value = false;
    await time.advance(1_000);
    expect(thrower.runs).toHaveLength(2);
    expect(swallower.runs).toHaveLength(2);
    release();
    swallow(true);
    await time.advance(0);
    s.stop();
    await s.whenIdle();
  });
});

// ---------------------------------------------------------------------------
// The jobs (buildJobs) against a real in-memory repo
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function jobsHarness(opts: { snapshot?: (base: string) => Promise<void>; watched?: string[] } = {}) {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  const snapshots: string[] = [];
  const ctx: JobContext = {
    clock: time,
    log: quiet,
    repo,
    http: { nextAllowedAt: () => 0, hostBlocked: () => null } as unknown as HttpClient,
    schema: {} as SchemaService,
    pricedb: {} as PriceDb,
    bptfApi: {
      snapshotAvailable: () => true,
      currencies: async () => null,
      prices: async () => ({ rows: [], currentTime: Math.floor(time.now() / 1000) }),
    } as unknown as BptfApi,
    engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
    settings: () => DEFAULT_SETTINGS,
    secret: () => 'secret-value',
    watchedBaseSkus: () => opts.watched ?? [],
    nextQueuedSnapshot: () => null,
    snapshot: async (base) => {
      snapshots.push(base);
      if (opts.snapshot) await opts.snapshot(base);
      repo.setSnapshotAt(base, time.now());
    },
    keyQuotesChanged: () => undefined,
  };
  const jobs = buildJobs(ctx);
  const job = (id: string): JobSpec => jobs.find((j) => j.id === id)!;
  const delayOf = (id: string): number => {
    const d = job(id).firstDelayMs;
    return typeof d === 'function' ? d() : (d ?? 0);
  };
  return { time, repo, ctx, job, delayOf, snapshots };
}

describe('jobs: restart awareness', () => {
  it('key-bptf keeps the hourly cadence of the previous process instead of calling IGetCurrencies at start', () => {
    const h = jobsHarness();
    expect(h.delayOf('key-bptf')).toBe(0); // never fetched: at once
    h.repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 560, sellScrap: 570, observedAt: h.time.now() });
    expect(h.delayOf('key-bptf')).toBe(0); // other sources do not count
    h.repo.upsertKeyQuote({ source: 'bptf', buyScrap: 560, sellScrap: 570, observedAt: h.time.now() - 20 * MIN });
    expect(h.delayOf('key-bptf')).toBe(40 * MIN);
    h.repo.upsertKeyQuote({ source: 'bptf', buyScrap: 560, sellScrap: 570, observedAt: h.time.now() - 3 * HOUR });
    expect(h.delayOf('key-bptf')).toBe(0);
    // A clock that moved back never pushes the job out beyond one cadence.
    h.repo.upsertKeyQuote({ source: 'bptf', buyScrap: 560, sellScrap: 570, observedAt: h.time.now() + 5 * HOUR });
    expect(h.delayOf('key-bptf')).toBe(HOUR);
  });

  it('bptf-prices waits for the 2 h cadence of the previous process and records each successful fetch', async () => {
    const h = jobsHarness();
    expect(h.delayOf('bptf-prices')).toBe(30_000);
    await h.job('bptf-prices').run();
    expect(h.repo.getMeta(META_PRICES_FETCHED_AT)).toBe(String(h.time.now()));
    expect(h.repo.getMeta(META_PRICES_CURRENT_TIME)).not.toBeNull();
    await h.time.advance(10 * MIN); // the app is restarted 10 min later
    expect(h.delayOf('bptf-prices')).toBe(110 * MIN);
    await h.time.advance(115 * MIN);
    expect(h.delayOf('bptf-prices')).toBe(30_000);
  });
});

describe('jobs: snapshot-watched', () => {
  it('backs off a SKU whose snapshot keeps failing so the other watched SKUs still get theirs', async () => {
    const BAD = '205;11;australium;kt-3';
    const h = jobsHarness({
      watched: [BAD, '200;11;australium', '211;11;australium'],
      snapshot: async (base) => {
        if (base === BAD) throw new HttpStatusError(400, 'https://api.backpack.tf/api/classifieds/listings/snapshot', null);
      },
    });
    const run = async (): Promise<void> => {
      await h.job('snapshot-watched').run().catch(() => undefined);
      await h.time.advance(MIN);
    };
    for (let i = 0; i < 10; i++) await run();
    // One try for the failing SKU, then the others; nothing is retried every minute.
    expect(h.snapshots).toEqual([BAD, '200;11;australium', '211;11;australium']);
    await h.time.advance(SNAPSHOT_FAIL_BASE_MS);
    await run();
    expect(h.snapshots.filter((s) => s === BAD)).toHaveLength(2); // retried after the cooldown
    // The next cooldown doubles: the stale good SKUs are refreshed in the meantime.
    for (let i = 0; i < 40; i++) await run();
    expect(h.snapshots.filter((s) => s === BAD)).toHaveLength(2);
    expect(h.snapshots.filter((s) => s === '200;11;australium').length).toBeGreaterThanOrEqual(2);
    await h.time.advance(2 * SNAPSHOT_FAIL_BASE_MS);
    await run();
    expect(h.snapshots.filter((s) => s === BAD)).toHaveLength(3);
  });

  it('does not back off a SKU for failures that are not its fault (rate limit, pause)', async () => {
    let fail: Error | null = new RateLimitedError('bptf-snapshot', T0 + MIN);
    const h = jobsHarness({
      watched: ['200;11;australium'],
      snapshot: async () => {
        if (fail) throw fail;
      },
    });
    await expect(h.job('snapshot-watched').run()).rejects.toBeInstanceOf(RateLimitedError);
    fail = new NetworkPausedError();
    await h.time.advance(MIN);
    await expect(h.job('snapshot-watched').run()).rejects.toBeInstanceOf(NetworkPausedError);
    fail = null;
    await h.time.advance(MIN);
    await h.job('snapshot-watched').run();
    expect(h.snapshots).toHaveLength(3);
  });
});
