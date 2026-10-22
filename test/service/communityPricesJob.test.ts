// 0.9 (history, H7): the 'bptf-prices' job keeps the community prices an IGetPrices answer replaces, and the rows that
// replace them, in bptf_community_history (marketJobs.test.ts's harness: a real in-memory repo, a fake bptfApi). The
// request, its cadence and budget are unchanged, bptf_community is overwritten exactly as in 0.8, and a failed
// history step costs only the history (a nested transaction rolls back alone). Nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { BptfApi, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { META_PRICES_CURRENT_TIME, META_PRICES_FETCHED_AT, buildJobs, type JobContext, type JobSpec } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CommunityRow } from '../../src/shared/types';
import { createLogger } from '../bptf/helpers';
import { FakeTime, T0 } from '../net/helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const row = (sku: string, value: number, lastUpdate = 1_791_000_000): CommunityRow => ({ sku, currency: 'metal', value, valueHigh: null, lastUpdate });

function harness(opts: { wrap?: (repo: Repo) => Repo } = {}) {
  const time = new FakeTime(T0);
  const real = openRepo(':memory:');
  repos.push(real);
  const repo = opts.wrap ? opts.wrap(real) : real;
  const log = createLogger();
  const answers: CommunityRow[][] = [];
  const sinces: (number | null)[] = [];
  const quiet = () => undefined;
  const ctx: JobContext = {
    clock: time,
    log,
    repo,
    http: { nextAllowedAt: () => 0, hostBlocked: () => null } as unknown as HttpClient,
    schema: { isLoaded: () => true, refresh: async () => undefined } as unknown as SchemaService,
    pricedb: { loadAll: async () => 0, bulk: async () => [] } as unknown as PriceDb,
    bptfApi: {
      snapshotAvailable: () => true,
      currencies: async () => null,
      prices: async (since: number | null) => {
        sinces.push(since);
        return { rows: answers.shift() ?? [], currentTime: Math.floor(time.now() / 1000) };
      },
    } as unknown as BptfApi,
    engine: { markAllDirty: quiet, markDirty: quiet } as unknown as Engine,
    settings: () => DEFAULT_SETTINGS,
    secret: () => 'secret-value',
    watchedBaseSkus: () => [],
    nextQueuedSnapshot: () => null,
    snapshot: async () => undefined,
    keyQuotesChanged: quiet,
  };
  const job: JobSpec = buildJobs(ctx).find((j) => j.id === 'bptf-prices')!;
  return {
    repo: real,
    log,
    time,
    sinces,
    /** One run answering `rows`. */
    run: async (rows: CommunityRow[]) => {
      answers.push(rows);
      await job.run();
    },
    history: () => real.communityHistory(['378;6', '126;6', '5021;6'], 5_000).map((p) => [p.sku, p.value, p.recordedAt]),
  };
}

describe("the 'bptf-prices' job keeps the prices it replaces (H7)", () => {
  it('writes no history on a full fetch into an empty table (no baseline yet)', async () => {
    const h = harness();
    await h.run([row('378;6', 11.55), row('126;6', 2)]);
    expect(h.sinces).toEqual([null]);
    expect(h.history()).toEqual([]);
    expect(h.repo.getCommunity('378;6')).toEqual(row('378;6', 11.55));
    expect(h.log.lines.filter((l) => /community prices: 2 rows \(full\), 0 kept in the price history/.test(l.msg))).toHaveLength(1);
  });

  it('writes [old, new] for a delta that changes one SKU, and a new SKU of a delta alone', async () => {
    const h = harness();
    await h.run([row('378;6', 11.55), row('126;6', 2)]);
    await h.time.advance(2 * 3_600_000);
    await h.run([row('378;6', 12, 1_791_100_000), row('126;6', 2), row('5021;6', 60)]);
    expect(h.sinces).toEqual([null, Math.floor(T0 / 1000)]);
    const at = T0 + 2 * 3_600_000;
    expect(h.history()).toEqual([
      ['378;6', 11.55, at],
      ['378;6', 12, at],
      ['5021;6', 60, at],
    ]);
    // bptf_community is overwritten exactly as before.
    expect(h.repo.getCommunity('378;6')).toEqual(row('378;6', 12, 1_791_100_000));
    expect(h.log.lines.some((l) => /3 rows \(delta\), 3 kept in the price history/.test(l.msg))).toBe(true);
  });

  it('writes nothing for a repeated identical delta', async () => {
    const h = harness();
    await h.run([row('378;6', 11.55)]);
    await h.run([row('378;6', 12, 1_791_100_000)]);
    const before = h.history();
    expect(before).toHaveLength(2);
    await h.run([row('378;6', 12, 1_791_100_000)]);
    await h.run([]);
    expect(h.history()).toEqual(before);
  });

  it('still stores the prices and the meta when keeping the history fails (the nested write rolls back alone)', async () => {
    const h = harness({
      wrap: (repo) => ({
        ...repo,
        insertCommunityHistory: (points) => {
          // Writes, then fails: the savepoint undoes this write only.
          repo.insertCommunityHistory(points);
          throw new Error('disk I/O error');
        },
      }),
    });
    await h.run([row('378;6', 11.55)]);
    await h.time.advance(60_000);
    await h.run([row('378;6', 12, 1_791_100_000)]);
    expect(h.history()).toEqual([]);
    expect(h.repo.getCommunity('378;6')).toEqual(row('378;6', 12, 1_791_100_000));
    expect(h.repo.getMeta(META_PRICES_CURRENT_TIME)).toBe(String(Math.floor((T0 + 60_000) / 1000)));
    expect(h.repo.getMeta(META_PRICES_FETCHED_AT)).toBe(String(T0 + 60_000));
    expect(h.log.lines.some((l) => l.level === 'warn' && /could not keep the price history: disk I\/O error/.test(l.msg))).toBe(true);
  });

  it('still stores the prices when the stored rows cannot be read for the history', async () => {
    const h = harness({
      wrap: (repo) => ({
        ...repo,
        communityFor: () => {
          throw new Error('no such table');
        },
      }),
    });
    await h.run([row('378;6', 11.55)]);
    await h.run([row('378;6', 12, 1_791_100_000)]);
    expect(h.history()).toEqual([]);
    expect(h.repo.getCommunity('378;6')).toEqual(row('378;6', 12, 1_791_100_000));
    expect(h.log.lines.some((l) => l.level === 'warn' && /could not read the stored prices for the history/.test(l.msg))).toBe(true);
  });
});
