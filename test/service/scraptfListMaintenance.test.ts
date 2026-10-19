// F14 retention: the daily maintenance job purges saved scrap.tf/items list rows older than 30 days
// and, only when it removed some, tells core (which refreshes the list cache and pushes). A real
// in-memory repo and list cache; fakes for everything else; no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { BptfApi, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { RETENTION } from '../../src/service/domain/engine';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { buildJobs, type JobContext } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { KeyPriceState, ScraptfListStored } from '../../src/shared/types';
import { FakeTime, T0 } from '../net/helpers';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const DAY = 24 * 60 * 60_000;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function row(sku: string, observedAt: number): ScraptfListStored {
  return { sku, name: sku, sellsKeys: 0, sellsScrap: 30, paysKeys: 0, paysScrap: 24, stock: 1, stockLimit: 5, batchId: 1, observedAt };
}

function harness(rows: ScraptfListStored[]) {
  const time = new FakeTime(T0);
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertScraptfList(rows);
  const list = createScraptfListCache({ repo, log: quiet, keyPrice: () => ({ valueScrap: 540 }) as KeyPriceState });
  const told: number[] = [];
  list.onChanged((s) => told.push(s.items));
  let changed = 0;
  const ctx: JobContext = {
    clock: time,
    log: quiet,
    repo,
    http: { nextAllowedAt: () => 0, hostBlocked: () => null } as unknown as HttpClient,
    schema: { isLoaded: () => true } as unknown as SchemaService,
    pricedb: {} as unknown as PriceDb,
    bptfApi: {} as unknown as BptfApi,
    engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
    market: { markDirty: () => undefined, markAllDirty: () => undefined },
    settings: () => DEFAULT_SETTINGS,
    secret: () => null,
    watchedBaseSkus: () => [],
    nextQueuedSnapshot: () => null,
    snapshot: async () => undefined,
    keyQuotesChanged: () => undefined,
    // As core wires it: re-read the table, which tells the listeners (core pushes from there).
    scraptfListChanged: () => {
      changed++;
      list.refresh();
    },
  };
  const maintenance = buildJobs(ctx).find((j) => j.id === 'maintenance')!;
  return { repo, list, told, maintenance, changed: () => changed };
}

describe('maintenance: saved scrap.tf list retention', () => {
  it('purges rows older than 30 days, keeps the rest, and refreshes the list once', async () => {
    expect(RETENTION.scraptfListMs).toBe(30 * DAY);
    const h = harness([row('378;6', T0 - 30 * DAY - 1), row('126;6', T0 - 30 * DAY), row('143;6', T0 - DAY)]);
    expect(h.list.summary().items).toBe(3);

    expect(h.maintenance.network).toBe(false);
    await h.maintenance.run();
    expect(h.repo.scraptfList().map((r) => r.sku)).toEqual(['126;6', '143;6']);
    expect(h.changed()).toBe(1);
    expect(h.told).toEqual([2]);
    expect(h.list.has('378;6')).toBe(false);
    expect(h.list.summary()).toMatchObject({ items: 2, oldestAt: T0 - 30 * DAY, newestAt: T0 - DAY });
  });

  it('announces nothing when no row was old enough', async () => {
    const h = harness([row('143;6', T0 - DAY)]);
    await h.maintenance.run();
    expect(h.repo.scraptfList()).toHaveLength(1);
    expect(h.changed()).toBe(0);
    expect(h.told).toEqual([]);
  });

  it('still purges without a list hook (the hook is optional in JobContext)', async () => {
    const h = harness([row('378;6', T0 - 40 * DAY)]);
    const bare: JobContext = {
      clock: new FakeTime(T0),
      log: quiet,
      repo: h.repo,
      http: { nextAllowedAt: () => 0, hostBlocked: () => null } as unknown as HttpClient,
      schema: { isLoaded: () => true } as unknown as SchemaService,
      pricedb: {} as unknown as PriceDb,
      bptfApi: {} as unknown as BptfApi,
      engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
      settings: () => DEFAULT_SETTINGS,
      secret: () => null,
      watchedBaseSkus: () => [],
      nextQueuedSnapshot: () => null,
      snapshot: async () => undefined,
      keyQuotesChanged: () => undefined,
    };
    await buildJobs(bare).find((j) => j.id === 'maintenance')!.run();
    expect(h.repo.scraptfList()).toEqual([]);
  });
});
