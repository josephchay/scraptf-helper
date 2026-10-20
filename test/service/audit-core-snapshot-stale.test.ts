// 0.7.3 follow-up (rv-tests-4): the core's own snapshotStale, the gate 'prices.upsert' passes before
// it queues a snapshot, runs through a real createServiceCore here. audit-snapshot-clock-gates covers
// the pure snapshotIsStale; this file proves core.ts wires it in, so a price saved after the clock
// stepped back still queues a snapshot for a book stamped in the future (before, now - at was
// negative and read as fresh). The scheduler module is wrapped only to capture the JobContext the
// core hands buildJobs, which reads the same queue. Temp dirs only; the network is paused, the fetch
// refuses every host and the socket is a fake, so the fake token never leaves the process.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import type { JobContext } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { FakeSocket } from '../bptf/helpers';

const held = vi.hoisted(() => ({ ctx: null as JobContext | null }));

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

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const MIN = 60_000;
const HOUR = 60 * MIN;
const SKU = '200;11;australium';

const noFetch = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const settings = mergeSettings(DEFAULT_SETTINGS, {
  contactUrl: 'https://github.com/flipdesk-test',
  networkPaused: true,
  liveFeed: { enabled: false },
  connectors: { pricedb: false, pricedbSocket: false, bptfApi: true, scm: false },
});

const temps: string[] = [];
const cores: ServiceCore[] = [];

afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  held.ctx = null;
});

/** A core over a database whose snapshot of SKU is stamped at `stampAt`, with an empty snapshot queue. */
function make(stampAt: number): { core: ServiceCore; ctx: JobContext } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit-corestale-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  repo.setSnapshotAt(SKU, stampAt);
  repo.close();

  const core = createServiceCore({
    dataDir,
    version: '0.7.3',
    settings,
    secrets: { bptfAccessToken: 'bptf-access-token-0123456789abcdef' },
    log: quiet,
    fetchImpl: noFetch,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
  });
  cores.push(core);
  expect(core.failure).toBeUndefined();
  const ctx = held.ctx;
  if (ctx === null) throw new Error('buildJobs was not called');
  while (ctx.nextQueuedSnapshot() !== null) {
    /* drain */
  }
  return { core, ctx };
}

describe("core.snapshotStale (the gate behind 'prices.upsert' queueing a snapshot)", () => {
  it('a price saved for a book stamped in the future (clock moved back) queues a snapshot', async () => {
    const { core, ctx } = make(Date.now() + 8 * HOUR);
    await core.handle('prices.upsert', { sku: SKU, costKeys: 35, costScrap: 0 });
    expect(ctx.nextQueuedSnapshot()).toBe(SKU);
  });

  it('a price saved for a fresh book queues none', async () => {
    const { core, ctx } = make(Date.now() - MIN);
    await core.handle('prices.upsert', { sku: SKU, costKeys: 35, costScrap: 0 });
    expect(ctx.nextQueuedSnapshot()).toBeNull();
  });

  it('a price saved for a book 30 min old or more queues one', async () => {
    const { core, ctx } = make(Date.now() - 31 * MIN);
    await core.handle('prices.upsert', { sku: SKU, costKeys: 35, costScrap: 0 });
    expect(ctx.nextQueuedSnapshot()).toBe(SKU);
  });
});
