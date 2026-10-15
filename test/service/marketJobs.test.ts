// F10 scheduler wiring: the periodic jobs tell the Live market about the same
// book and reference changes they tell the engine about. A fake index records
// the calls; a real in-memory repo; nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { BptfApi, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import type { MarketIndex } from '../../src/service/domain';
import { buildJobs, type JobContext, type JobSpec } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CommunityRow, PricedbRow } from '../../src/shared/types';
import { FakeTime, T0 } from '../net/helpers';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function pricedbRow(sku: string): PricedbRow {
  return { sku, name: sku, buyKeys: 0, buyScrap: 100, sellKeys: 0, sellScrap: 120, time: Math.floor(T0 / 1000), fetchedAt: T0 };
}

function harness(opts: { schemaLoaded?: boolean[]; loadAll?: number; bulk?: PricedbRow[]; community?: CommunityRow[] } = {}) {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  const calls: { engine: string[]; market: string[]; dirty: string[][] } = { engine: [], market: [], dirty: [] };
  // isLoaded() answers from this list in turn (before / after the refresh), then keeps its last value.
  const loadedSeq = [...(opts.schemaLoaded ?? [true])];
  const market: Pick<MarketIndex, 'markDirty' | 'markAllDirty'> = {
    markDirty: (b) => {
      calls.market.push('markDirty');
      calls.dirty.push([...b]);
    },
    markAllDirty: () => calls.market.push('markAllDirty'),
  };
  const ctx: JobContext = {
    clock: time,
    log: quiet,
    repo,
    http: { nextAllowedAt: () => 0, hostBlocked: () => null } as unknown as HttpClient,
    schema: {
      isLoaded: () => (loadedSeq.length > 1 ? loadedSeq.shift()! : loadedSeq[0]!),
      refresh: async () => undefined,
    } as unknown as SchemaService,
    pricedb: {
      loadAll: async () => opts.loadAll ?? 0,
      bulk: async () => opts.bulk ?? [],
    } as unknown as PriceDb,
    bptfApi: {
      snapshotAvailable: () => true,
      currencies: async () => null,
      prices: async () => ({ rows: opts.community ?? [], currentTime: Math.floor(time.now() / 1000) }),
    } as unknown as BptfApi,
    engine: {
      markAllDirty: () => calls.engine.push('markAllDirty'),
      markDirty: () => calls.engine.push('markDirty'),
    } as unknown as Engine,
    market,
    settings: () => DEFAULT_SETTINGS,
    secret: () => 'secret-value',
    watchedBaseSkus: () => ['378;6', '126;6'],
    nextQueuedSnapshot: () => null,
    snapshot: async () => undefined,
    keyQuotesChanged: () => undefined,
  };
  const jobs = buildJobs(ctx);
  const job = (id: string): JobSpec => jobs.find((j) => j.id === id)!;
  return { job, calls };
}

describe('jobs: the Live market is told what the engine is told', () => {
  it('rebuilds when a schema that failed to download at start finally loads, and only then', async () => {
    const late = harness({ schemaLoaded: [false, true] });
    expect(await late.job('schema').run()).toBe(true);
    expect(late.calls.market).toEqual(['markAllDirty']);

    const already = harness({ schemaLoaded: [true, true] });
    await already.job('schema').run();
    expect(already.calls.market).toEqual([]);

    const still = harness({ schemaLoaded: [false, false] });
    expect(await still.job('schema').run()).toBe(false);
    expect(still.calls.market).toEqual([]);
  });

  it('rebuilds after new PriceDB or backpack.tf reference lists, and not after empty ones', async () => {
    const loaded = harness({ loadAll: 120, community: [{ sku: '378;6', currency: 'metal', value: 11.55, valueHigh: null, lastUpdate: Math.floor(T0 / 1000) }] });
    await loaded.job('pricedb-all').run();
    await loaded.job('bptf-prices').run();
    expect(loaded.calls.market).toEqual(['markAllDirty', 'markAllDirty']);
    expect(loaded.calls.engine).toEqual(['markAllDirty', 'markAllDirty']);

    const empty = harness({ loadAll: 0, community: [] });
    await empty.job('pricedb-all').run();
    await empty.job('bptf-prices').run();
    expect(empty.calls.market).toEqual([]);
  });

  it('marks the watched SKUs with fresh PriceDB references dirty', async () => {
    const h = harness({ bulk: [pricedbRow('378;6'), pricedbRow('126;6')] });
    await h.job('pricedb-watched').run();
    expect(h.calls.dirty).toEqual([['378;6', '126;6']]);
    expect(h.calls.engine).toEqual(['markDirty']);

    const none = harness({ bulk: [] });
    await none.job('pricedb-watched').run();
    expect(none.calls.market).toEqual([]);
  });

  it('rebuilds after the daily purge, which deletes listings without marking them', async () => {
    const h = harness();
    await h.job('maintenance').run();
    expect(h.calls.market).toEqual(['markAllDirty']);
  });
});
