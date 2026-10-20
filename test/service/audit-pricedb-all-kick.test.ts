// 0.7.3 follow-up (r4-clock-4): core kicks 'pricedb-all' when the user toggles the PriceDB or backpack.tf API
// connector, or re-enables pricedb.io. Within 4 h of a load that run only skipped (the list is still fresh) and
// pushed the next load to kick time + 4 h, up to about 8 h after the previous one. A kick now keeps the job's
// due time while the list is fresh (the job's kickDelayMs), and still runs it at once when a load is due. Other
// jobs' kicks are unchanged.

import { afterEach, describe, expect, it } from 'vitest';
import { META_LOAD_ALL_AT, createPriceDb } from '../../src/service/connectors/pricedb';
import type { BptfApi, Engine, HttpResponse, Repo, SchemaService, ServiceDeps } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { buildJobs, createScheduler, type JobContext } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { FakeTime, T0 } from '../net/helpers';
import { FakeHttp, fixture, res } from '../pricedb/helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** Real PriceDB connector and 'pricedb-all' job on fake time; /autob/items answers after 5 s (`fail`: 503). */
function harness(opts: { fail?: number[] } = {}) {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  const requests: number[] = [];
  const http = new FakeHttp((url) => {
    if (!url.endsWith('/autob/items')) return res(null, { status: 404 });
    const i = requests.length;
    requests.push(time.now());
    return new Promise<HttpResponse>((resolve) => {
      time.setTimeout(() => resolve(opts.fail?.includes(i) ? res(null, { status: 503 }) : res(fixture('autob-items.json'))), 5_000);
    });
  });
  const deps: ServiceDeps = { clock: time, log: quiet, repo, http, settings: () => DEFAULT_SETTINGS, secret: () => null };
  const ctx: JobContext = {
    clock: time,
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
  const scheduler = createScheduler({ clock: time, timers: time, log: quiet, isPaused: () => false, tickMs: MIN });
  scheduler.add(buildJobs(ctx).find((j) => j.id === 'pricedb-all')!);
  let otherRuns = 0;
  scheduler.add({ id: 'other', everyMs: 4 * HOUR, run: async () => void otherRuns++ });
  scheduler.start();
  /** Request times in hours since start. */
  const hours = (): number[] => requests.map((t) => (t - T0) / HOUR);
  const state = (id = 'pricedb-all') => scheduler.states().find((s) => s.id === id)!;
  return { time, repo, hours, state, scheduler, otherRuns: () => otherRuns };
}

describe("kicking 'pricedb-all'", () => {
  it('within 4 h of a load keeps the next load 4 h after it', async () => {
    const h = harness();
    await h.time.advance(MIN);
    expect(h.hours()).toEqual([0]);
    await h.time.advance(1.5 * HOUR);
    h.scheduler.kick('pricedb-all');
    expect(h.state().nextDueAt).toBe(T0 + 4 * HOUR);
    await h.time.advance(MIN);
    expect(h.state().lastRunAt).toBe(T0);
    await h.time.advance(9 * HOUR);
    expect(h.hours()).toEqual([0, 4, 8]);
    expect(h.state().lastError).toBeNull();
    h.scheduler.stop();
  });

  it('runs at once when a load is due (a failed load waiting for its retry)', async () => {
    const h = harness({ fail: [0] });
    await h.time.advance(MIN);
    expect(h.state().lastError).toBe('run reported a failure');
    h.scheduler.kick('pricedb-all');
    await h.time.advance(2 * MIN);
    expect(h.hours()).toHaveLength(2);
    expect(h.state().lastError).toBeNull();
    h.scheduler.stop();
  });

  it('runs at once when the last load is over 4 h old', async () => {
    const h = harness();
    h.repo.setMeta(META_LOAD_ALL_AT, String(T0 - 5 * HOUR));
    await h.time.advance(MIN);
    expect(h.hours()).toEqual([0]);
    // The job ran at start; the stamp is rewritten to an old one (another process, a restored backup).
    h.repo.setMeta(META_LOAD_ALL_AT, String(T0 - 5 * HOUR));
    h.scheduler.kick('pricedb-all');
    await h.time.advance(2 * MIN);
    expect(h.hours()).toHaveLength(2);
    expect(h.hours()[1]).toBeLessThan(0.1);
    h.scheduler.stop();
  });

  it('still makes any other job due at once', async () => {
    const h = harness();
    await h.time.advance(MIN);
    expect(h.otherRuns()).toBe(1);
    h.scheduler.kick('other');
    expect(h.state('other').nextDueAt).toBe(h.time.now());
    await h.time.advance(MIN);
    expect(h.otherRuns()).toBe(2);
    h.scheduler.stop();
  });
});
