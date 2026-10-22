// 0.8 (G1, D10), through a real, started createServiceCore: a watch's base joins the snapshot job's watch list
// (JobContext.watchedBaseSkus, the same job, cadence and budget: no new request kind) after 'watches.upsert' and leaves
// it after a delete or a pause, a targetless tool never joins (0.7.4 F74), every write pushes 'watches.changed', and
// core tells holdings the watched bases changed (H1's recorder reads them through markBases). The scheduler and
// holdings modules are wrapped only to capture the job context and the holdings instance. Temp dirs only; the network
// is paused and the fetch refuses every host, so nothing leaves the process.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { META_SCHEMA_CHECKED_AT, META_SCHEMA_EXTRAS, buildSchemaSnapshot } from '../../src/service/connectors/schema';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import type { Holdings } from '../../src/service/domain/holdings';
import type { JobContext } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { ScraptfWatch, ScraptfWatchView } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const held = vi.hoisted(() => ({ ctx: null as JobContext | null, holdings: [] as { markBasesChanged: () => void; calls: number }[] }));

vi.mock('../../src/service/scheduler', async (orig) => {
  const real = await orig<typeof import('../../src/service/scheduler')>();
  return {
    ...real,
    buildJobs: (ctx: JobContext) => {
      held.ctx = ctx;
      return real.buildJobs(ctx);
    },
  };
});

vi.mock('../../src/service/domain/holdings', async (orig) => {
  const real = await orig<typeof import('../../src/service/domain/holdings')>();
  return {
    ...real,
    createHoldings: (...args: Parameters<typeof real.createHoldings>): Holdings => {
      const h = real.createHoldings(...args);
      const spy = { markBasesChanged: h.markBasesChanged, calls: 0 };
      held.holdings.push(spy);
      return {
        ...h,
        markBasesChanged() {
          spy.calls++;
          spy.markBasesChanged();
        },
      };
    },
  };
});

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = (rel: string): unknown => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8'));
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
/** A kit with no target names no item anyone lists (SchemaService.isTargetlessTool): never watched. */
const TARGETLESS_KIT = '6526;6;uncraftable;kt-3';

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  held.ctx = null;
  held.holdings.length = 0;
});

const refuse = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

async function make(seed: (repo: Repo) => void = () => undefined) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-watches-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  const now = Date.now();
  const built = buildSchemaSnapshot(load('pricedb/schema-subset.json'), load('pricedb/paint-list.json'), now, 'W/"fixture"');
  repo.replaceSchema(built.snapshot);
  repo.setMeta(META_SCHEMA_EXTRAS, JSON.stringify(built.extras));
  repo.setMeta(META_SCHEMA_CHECKED_AT, String(now));
  seed(repo);
  repo.close();
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    networkPaused: true,
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: true, scm: false },
  });
  const core = createServiceCore({ dataDir, version: '0.8.0', settings, secrets: {}, log: quiet, fetchImpl: refuse, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  expect(core.failure).toBeUndefined();
  // The schema loads from the cached copy (isTargetlessTool needs it).
  await core.start();
  const ctx = held.ctx;
  if (ctx === null) throw new Error('buildJobs was not called');
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  const holdings = held.holdings.at(-1)!;
  return { core, ctx, pushes, holdings };
}

describe('core: watches join the snapshot watch list (G1) and holdings hears of them (D10)', () => {
  it('adds an enabled watch\'s base after watches.upsert, and drops it after a pause or a delete', async () => {
    const { core, ctx, pushes, holdings } = await make();
    expect(ctx.watchedBaseSkus()).not.toContain('378;6');
    const w = (await core.handle('watches.upsert', { sku: '378;6;p15185211', maxCostScrap: 300 })) as ScraptfWatch;
    expect(ctx.watchedBaseSkus()).toContain('378;6');
    expect(pushes.filter((p) => p.event === 'watches.changed')).toEqual([{ event: 'watches.changed', payload: { at: expect.any(Number) as unknown as number } }]);
    expect(holdings.calls).toBe(1);
    // The list reads the same cache.
    expect(((await core.handle('watches.list', {})) as ScraptfWatchView[]).map((v) => v.id)).toEqual([w.id]);

    await core.handle('watches.upsert', { id: w.id, sku: '378;6', enabled: false });
    expect(ctx.watchedBaseSkus()).not.toContain('378;6');
    await core.handle('watches.upsert', { id: w.id, sku: '378;6', enabled: true });
    expect(ctx.watchedBaseSkus()).toContain('378;6');
    await core.handle('watches.delete', { id: w.id });
    expect(ctx.watchedBaseSkus()).not.toContain('378;6');
    expect(pushes.filter((p) => p.event === 'watches.changed')).toHaveLength(4);
    expect(holdings.calls).toBe(4);
    expect((await core.handle('watches.list', {})) as ScraptfWatchView[]).toEqual([]);
  });

  it('reads the watches stored before a start, and never watches a targetless tool', async () => {
    const { ctx } = await make((repo) => {
      repo.upsertWatch({ sku: '126;6', specialKey: null, name: "Bill's Hat", maxCostKeys: 0, maxCostScrap: null, minProfitScrap: 20, onRestock: false, enabled: true }, Date.now());
      repo.upsertWatch({ sku: TARGETLESS_KIT, specialKey: null, name: 'Kit', maxCostKeys: 0, maxCostScrap: 300, minProfitScrap: null, onRestock: false, enabled: true }, Date.now());
    });
    expect(ctx.watchedBaseSkus()).toContain('126;6');
    expect(ctx.watchedBaseSkus()).not.toContain(TARGETLESS_KIT);
  });

  it('a refused write changes nothing and pushes nothing', async () => {
    const { core, ctx, pushes, holdings } = await make();
    await expect(core.handle('watches.upsert', { sku: '378;6' })).rejects.toThrow(/Set a price, a profit/);
    await expect(core.handle('watches.upsert', { id: 42, sku: '378;6', maxCostScrap: 10 })).rejects.toThrow(/no longer exists/);
    expect(pushes.filter((p) => p.event === 'watches.changed')).toEqual([]);
    expect(holdings.calls).toBe(0);
    expect(ctx.watchedBaseSkus()).not.toContain('378;6');
  });
});
