// 0.7.3 follow-up (fu-clock-1): a restart within 4 h of PriceDB's last full load used to run 'pricedb-all'
// at start, where loadAll() only skipped (still fresh), so the next load came a full cadence later: up to
// about 8 h after the previous one. The job now waits out the rest of those 4 h before its first run; with
// no load yet, an old one, or one stamped in the future (the clock moved back) it still runs at start.

import { afterEach, describe, expect, it } from 'vitest';
import { LOAD_ALL_MIN_INTERVAL_MS, META_LOAD_ALL_AT, createPriceDb } from '../../src/service/connectors/pricedb';
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

/** Real PriceDB connector and 'pricedb-all' job on fake time, started with the given last-load stamp. */
function harness(lastLoadAt?: number) {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  if (lastLoadAt !== undefined) repo.setMeta(META_LOAD_ALL_AT, String(lastLoadAt));
  const requests: number[] = [];
  const http = new FakeHttp((url) => {
    if (!url.endsWith('/autob/items')) return res(null, { status: 404 });
    requests.push(time.now());
    return new Promise<HttpResponse>((resolve) => {
      time.setTimeout(() => resolve(res(fixture('autob-items.json'))), 5_000);
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
  scheduler.start();
  /** Request times in hours since start. */
  const hours = (): number[] => requests.map((t) => (t - T0) / HOUR);
  return { time, hours, state: () => scheduler.states()[0]!, scheduler };
}

describe("'pricedb-all' after a restart", () => {
  it('waits out the rest of the 4 h after a load 3.5 h ago instead of loading 7.5 h after it', async () => {
    const h = harness(T0 - 3.5 * HOUR);
    expect(h.state().nextDueAt).toBe(T0 + 0.5 * HOUR);
    await h.time.advance(29 * MIN);
    expect(h.hours()).toEqual([]);
    expect(h.state().lastRunAt).toBeNull();
    await h.time.advance(8.5 * HOUR);
    expect(h.hours()).toEqual([0.5, 4.5, 8.5]);
    expect(h.state().lastError).toBeNull();
    h.scheduler.stop();
  });

  it('keeps the 4 h cadence after a load an hour ago', async () => {
    const h = harness(T0 - HOUR);
    await h.time.advance(12 * HOUR);
    expect(h.hours()).toEqual([3, 7, 11]);
    h.scheduler.stop();
  });

  it('never waits more than 4 h, even right after a load', async () => {
    const h = harness(T0);
    expect(h.state().nextDueAt - T0).toBe(LOAD_ALL_MIN_INTERVAL_MS);
    await h.time.advance(4 * HOUR + MIN);
    expect(h.hours()).toEqual([4]);
    h.scheduler.stop();
  });

  it('loads at start with no load yet, an old one, or one stamped in the future', async () => {
    for (const stamp of [undefined, T0 - 5 * HOUR, T0 - 4 * HOUR + 30_000, T0 + 8 * HOUR]) {
      const h = harness(stamp);
      await h.time.advance(MIN);
      expect(h.hours()).toEqual([0]);
      h.scheduler.stop();
    }
  });
});
