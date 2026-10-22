// 0.7.4 trading accuracy audit (integration), through a real, started createServiceCore:
// - F09/F14/F49: one name's snapshot is the whole book of every base it is filed under (defindex twins:
//   "Strange Australium Rocket Launcher" sits under 205 and 18), so each twin is reconciled, not the base
//   alone, and a watched item's sell listing under its twin defindex is kept.
// - F18: a snapshot whose rows of one side all map to another item (mapper drift) leaves that side's stored
//   orders as they were, with a warning, instead of emptying the book.
// - F74: a kit SKU without its target is never watched, queued or refreshed (it names no listed item).
// Temp dirs only. The schema is the real fixture, cached in the database as a previous run would have, so
// start() requests nothing for it; the fetch answers only the faked api.backpack.tf snapshot and refuses
// every other host, and the socket is a fake, so the fake token never leaves the process.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bptfBuyListingId } from '../../src/service/connectors/bptfItem';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { META_SCHEMA_CHECKED_AT, META_SCHEMA_EXTRAS, buildSchemaSnapshot } from '../../src/service/connectors/schema';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import type { JobContext } from '../../src/service/scheduler';
import { scrapToRef } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ItemDetail, Listing } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

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

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = (rel: string): unknown => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8'));
const MIN = 60_000;
const TOKEN = 'bptf-access-token-0123456789abcdef';
const ITEM = '205;11;australium';
const TWIN = '18;11;australium';
const NAME = 'Strange Australium Rocket Launcher';

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  held.ctx = null;
});

const sec = (): number => Math.floor(Date.now() / 1000);
const steam = (i: number): string => `7656119800000${String(2000 + i)}`;
/** A raw snapshot row: a Strange Australium Rocket Launcher document under `defindex`. */
const raw = (steamid: string, scrap: number, defindex: number, intent: 'buy' | 'sell' = 'buy', quality = 11) => ({
  steamid,
  intent,
  timestamp: sec() - 600,
  bump: sec() - 60,
  currencies: { keys: 0, metal: scrapToRef(scrap) },
  item: {
    defindex,
    quality,
    quantity: '1',
    ...(intent === 'sell' ? { id: `9${steamid.slice(-6)}` } : {}),
    attributes: [{ defindex: 2027, value: 1, float_value: 1 }],
  },
});
/** A stored feed order for NAME, ten minutes old, filed under `base`. */
const stored = (i: number, base: string, scrap: number, over: Partial<Listing> = {}): Listing =>
  makeListing({ id: bptfBuyListingId(steam(i), NAME), sku: base, baseSku: base, steamid: steam(i), metalScrap: scrap, lastEventAt: Date.now() - 10 * MIN, itemName: NAME, ...over });

interface Made {
  core: ServiceCore;
  ctx: JobContext;
  dataDir: string;
  warns: string[];
}

async function make(seed: (repo: Repo) => void, rows: unknown[] = []): Promise<Made> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit074-twins-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  const now = Date.now();
  const built = buildSchemaSnapshot(load('pricedb/schema-subset.json'), load('pricedb/paint-list.json'), now, 'W/"fixture"');
  repo.replaceSchema(built.snapshot);
  repo.setMeta(META_SCHEMA_EXTRAS, JSON.stringify(built.extras));
  repo.setMeta(META_SCHEMA_CHECKED_AT, String(now));
  repo.upsertBptfNames([{ sku: ITEM, name: NAME, marketName: null, lastSeen: now }]);
  seed(repo);
  repo.close();
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === 'api.backpack.tf' && u.pathname === '/api/classifieds/listings/snapshot') {
      return new Response(JSON.stringify({ appid: 440, sku: NAME, createdAt: sec(), listings: rows }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
  }) as typeof fetch;
  const warns: string[] = [];
  const log = { debug: () => undefined, info: () => undefined, warn: (m: string) => void warns.push(m), error: () => undefined };
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: true, scm: false },
  });
  const core = createServiceCore({ dataDir, version: '0.7.4', settings, secrets: { bptfAccessToken: TOKEN }, log, fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  expect(core.failure).toBeUndefined();
  await core.start();
  const ctx = held.ctx;
  if (ctx === null) throw new Error('buildJobs was not called');
  return { core, ctx, dataDir, warns };
}

async function refresh(m: Made, sku = ITEM): Promise<void> {
  const r = (await m.core.handle('item.refresh', { sku })) as { queued: boolean; reason: string | null };
  expect(r).toMatchObject({ queued: true });
  const end = Date.now() + 15_000;
  for (;;) {
    const d = (await m.core.handle('item.detail', { sku, history: false })) as ItemDetail;
    if (d.snapshot.lastAt !== null) return;
    if (Date.now() > end) throw new Error('timed out waiting for the snapshot');
    await new Promise((res) => setTimeout(res, 50));
  }
}

/** The stored listings of one base and side, read from the database file (the core holds it open in WAL). */
function storedIds(m: Made, base: string, intent: 'buy' | 'sell' = 'buy'): string[] {
  const repo = openRepo(path.join(m.dataDir, DB_FILE_NAME));
  try {
    return repo
      .listingsByBaseSku(base, intent)
      .map((l) => l.steamid)
      .sort();
  } finally {
    repo.close();
  }
}

describe('a name snapshot reconciles every twin of the book (F09/F14/F49)', () => {
  it("deletes a stale order filed under the twin defindex, keeps the twin's live ones", async () => {
    const m = await make(
      (repo) =>
        repo.upsertListings([
          stored(1, ITEM, 150),
          stored(2, ITEM, 140), // gone: not in the snapshot
          stored(3, TWIN, 130), // gone: not in the snapshot (0.7.3 kept it forever)
          stored(4, TWIN, 120),
        ]),
      [raw(steam(1), 150, 205), raw(steam(4), 120, 18), raw(steam(5), 110, 18)],
    );
    await refresh(m);
    expect(storedIds(m, ITEM)).toEqual([steam(1)]);
    expect(storedIds(m, TWIN)).toEqual([steam(4), steam(5)].sort());
    const d = (await m.core.handle('item.detail', { sku: ITEM, history: false })) as ItemDetail;
    expect(d.buyOrders.map((o) => o.valueScrap).sort((a, b) => b - a)).toEqual([150, 120, 110]);
    // The twin's book was reconciled too, so it is as fresh as the item's: no second call for the same name.
    const twin = (await m.core.handle('item.detail', { sku: TWIN, history: false })) as ItemDetail;
    expect(twin.snapshot.lastAt).toBe(d.snapshot.lastAt);
  }, 30_000);

  it("keeps a sell listing filed under the twin defindex of the item it snapshots", async () => {
    const m = await make(() => undefined, [raw(steam(1), 150, 205), raw(steam(6), 300, 18, 'sell')]);
    await refresh(m);
    expect(storedIds(m, TWIN, 'sell')).toEqual([steam(6)]);
  }, 30_000);
});

describe('a snapshot whose rows all map to another item leaves the book (F18)', () => {
  it('warns and keeps the stored buy orders when no buy row maps to the item or a twin', async () => {
    // Mapper drift, simulated: every row of the name comes back as a Unique copy (205;6;australium).
    const m = await make(
      (repo) => repo.upsertListings([stored(1, ITEM, 150), stored(2, TWIN, 140)]),
      [raw(steam(7), 160, 205, 'buy', 6), raw(steam(8), 155, 205, 'buy', 6)],
    );
    await refresh(m);
    expect(storedIds(m, ITEM)).toEqual([steam(1)]);
    expect(storedIds(m, TWIN)).toEqual([steam(2)]);
    expect(m.warns.some((w) => w.includes(`snapshot ${ITEM}`) && w.includes('205;6;australium') && w.includes('left as they were'))).toBe(true);
  }, 30_000);

  it('still reconciles normally when some buy row maps to the item', async () => {
    const m = await make((repo) => repo.upsertListings([stored(1, ITEM, 150), stored(2, ITEM, 140)]), [raw(steam(1), 150, 205), raw(steam(7), 160, 205, 'buy', 6)]);
    await refresh(m);
    expect(storedIds(m, ITEM)).toEqual([steam(1)]);
    expect(m.warns.some((w) => w.includes('left as they were'))).toBe(false);
  }, 30_000);
});

describe('a kit without its target is never watched or snapshotted (F74)', () => {
  const BARE_KIT = '6527;6';

  it('leaves it out of the watch list, refuses item.refresh and queues nothing on prices.upsert', async () => {
    const m = await make((repo) => {
      repo.upsertScrapPrice({ sku: BARE_KIT, name: 'Kit', costScrap: 30, source: 'user', observedAt: Date.now() - MIN });
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'user', observedAt: Date.now() - MIN });
    });
    expect(m.ctx.watchedBaseSkus()).toEqual(['378;6']);
    const r = (await m.core.handle('item.refresh', { sku: BARE_KIT })) as { queued: boolean; reason: string | null };
    expect(r).toMatchObject({ queued: false, reason: 'This tool names no target item; backpack.tf has no listings for it.' });
    while (m.ctx.nextQueuedSnapshot() !== null) {
      /* drain the start-up queue */
    }
    await m.core.handle('prices.upsert', { sku: BARE_KIT, costScrap: 31 });
    expect(m.ctx.nextQueuedSnapshot()).toBeNull();
    // A kit with its target is an item like any other.
    await m.core.handle('prices.upsert', { sku: '6527;6;kt-1;td-205', costScrap: 40 });
    expect(m.ctx.nextQueuedSnapshot()).toBe('6527;6;kt-1;td-205');
  }, 30_000);
});
