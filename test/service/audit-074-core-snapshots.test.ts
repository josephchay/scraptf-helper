// 0.7.4 trading accuracy audit (package PB), through a real createServiceCore:
// - F16/F24/F30: the JobContext core hands buildJobs ranks unconfirmed profitable rows first
//   (ctx.snapshotPriority). Package G2 (R13) retired the FIFO confirm queue: ctx.nextQueuedSnapshot serves only
//   the typed prices' queue, and the profit-ranked priority serves the unconfirmed rows. The scheduler module
//   is wrapped only to capture that context.
// - F51: bp.tf returns at most 30 listings per side; a full page is reconciled only inside the range it
//   covered, so deeper live orders are kept (snapshotPageDeletes), while a short page stays authoritative.
// Temp dirs only. The fetch refuses every host but the faked api.backpack.tf snapshot (F51 case) and the
// socket is a fake, so the fake token never leaves the process. Snapshot rows are mapped with the real
// schema fixture (cached in the database as a previous run would have).

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bptfBuyListingId } from '../../src/service/connectors/bptfItem';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { META_SCHEMA_CHECKED_AT, META_SCHEMA_EXTRAS, buildSchemaSnapshot } from '../../src/service/connectors/schema';
import { DB_FILE_NAME, SNAPSHOT_PAGE_EDGE_BAND, createServiceCore, snapshotPageDeletes, type ServiceCore } from '../../src/service/core';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import type { JobContext } from '../../src/service/scheduler';
import { scrapToRef } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, ItemDetail, Listing, Settings } from '../../src/shared/types';
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
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const MIN = 60_000;
const HOUR = 60 * MIN;
const TOKEN = 'bptf-access-token-0123456789abcdef';
const ITEM = '200;11;australium';
const NAME = 'Strange Australium Scattergun';

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  held.ctx = null;
});

const refuse = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

function make(seed: (repo: Repo) => void, opts: { fetchImpl?: typeof fetch; settings?: DeepPartial<Settings> } = {}): { core: ServiceCore; ctx: JobContext } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit074-'));
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
    notifications: { minConfidence: 0 },
    ...opts.settings,
  });
  const core = createServiceCore({
    dataDir,
    version: '0.7.4',
    settings,
    secrets: { bptfAccessToken: TOKEN },
    log: quiet,
    fetchImpl: opts.fetchImpl ?? refuse,
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

const buy = (sku: string, steamid: string, metalScrap: number, ageMs: number, over: Partial<Listing> = {}): Listing =>
  makeListing({ id: `${sku}-${steamid}`, sku, baseSku: sku, steamid, metalScrap, isBot: true, lastEventAt: Date.now() - ageMs, ...over });

describe('core: snapshot priority and confirm snapshots (F16, F24, F30)', () => {
  it('ranks the unconfirmed profitable row first, with no separate confirm queue ahead of the ranking', async () => {
    const { core, ctx } = make((repo) => {
      // Team Captain: profitable on a 30 h old order. Bill's Hat: profitable on a fresh one. Both priced.
      repo.upsertListings([buy('378;6', 'S1', 108, 30 * HOUR), buy('126;6', 'S2', 108, MIN)]);
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: Date.now() - MIN });
      repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 60, source: 'import', observedAt: Date.now() });
    });
    await core.handle('engine.runNow', {});
    // Only the unconfirmed row: the fresh Bill's Hat order was seen a minute ago.
    expect(ctx.snapshotPriority?.()).toEqual(['378;6']);
    expect(ctx.nextQueuedSnapshot()).toBeNull();
  });

  it('serves a price the user just typed before the unconfirmed rows', async () => {
    const { core, ctx } = make((repo) => {
      repo.upsertListings([buy('378;6', 'S1', 108, 30 * HOUR)]);
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: Date.now() - MIN });
    });
    await core.handle('engine.runNow', {});
    await core.handle('prices.upsert', { sku: '126;6', costScrap: 40 });
    expect(ctx.nextQueuedSnapshot()).toBe('126;6');
    expect(ctx.nextQueuedSnapshot()).toBeNull();
    // The job consults the ranking only once the queue is empty.
    expect(ctx.snapshotPriority?.()).toEqual(['378;6']);
  });

  it("queues nothing while the backpack.tf API is turned off ('item.refresh''s guard)", async () => {
    const { core, ctx } = make(
      (repo) => {
        repo.upsertListings([buy('378;6', 'S1', 108, 30 * HOUR)]);
        repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: Date.now() - MIN });
      },
      { settings: { connectors: { bptfApi: false } } },
    );
    await core.handle('engine.runNow', {});
    expect(ctx.nextQueuedSnapshot()).toBeNull();
  });

  it('ranks profitable before below-threshold rows, most profit first, including orders seen 2 to 24 h ago', async () => {
    const { core, ctx } = make((repo) => {
      repo.upsertListings([
        buy('378;6', 'S1', 108, 30 * HOUR),
        // 3 h old: verified, but not confirmed within 2 h, so still worth a snapshot.
        buy('126;6', 'S2', 140, 3 * HOUR),
        // Below threshold (profit under 9 scrap) on a 26 h old order.
        buy('205;11', 'S3', 66, 26 * HOUR),
      ]);
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: Date.now() - MIN });
      repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 60, source: 'import', observedAt: Date.now() - MIN });
      repo.upsertScrapPrice({ sku: '205;11', name: 'Strange Rocket Launcher', costScrap: 60, source: 'import', observedAt: Date.now() - MIN });
    });
    await core.handle('engine.runNow', {});
    expect(ctx.snapshotPriority?.()).toEqual(['126;6', '378;6', '205;11']);
  });

  it('ranks a held item to sell on an unconfirmed backpack.tf order after the opportunity rows', async () => {
    const { core, ctx } = make((repo) => {
      repo.upsertListings([buy('378;6', 'S1', 108, 30 * HOUR), buy('126;6', 'S2', 108, 5 * HOUR)]);
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: Date.now() - MIN });
      // Bill's Hat is held (bought for 6.66 ref), not priced: the journal puts it on the watch list.
      repo.addJournal({ ts: Date.now() - HOUR, side: 'buy', venue: 'scrap.tf', sku: '126;6', name: "Bill's Hat", keys: 0, scrap: 60, keyPriceScrap: 567, note: null });
    });
    await core.handle('engine.runNow', {});
    expect(ctx.watchedBaseSkus()).toEqual(expect.arrayContaining(['378;6', '126;6']));
    expect(ctx.snapshotPriority?.()).toEqual(['378;6', '126;6']);
  });

  it('ranks held items whose advice says refresh first after the held items to sell, by base, most cost first (0.8, H8)', async () => {
    const held = (sku: string, name: string, scrap: number) => ({ ts: Date.now() - HOUR, side: 'buy' as const, venue: 'scrap.tf', sku, name, keys: 0, scrap, keyPriceScrap: 567, note: null });
    const { core, ctx } = make((repo) => {
      repo.upsertListings([buy('378;6', 'S1', 108, 30 * HOUR), buy('126;6', 'S2', 108, 5 * HOUR)]);
      repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: Date.now() - MIN });
      repo.addJournal(held('126;6', "Bill's Hat", 60));
      // No buy order and no snapshot for a day: the advice asks for a refresh first, most cost first.
      repo.addJournal(held('205;6', 'Rocket Launcher', 50));
      repo.addJournal(held('205;11', 'Strange Rocket Launcher', 200));
      // No buy order either, but snapshotted 2 h ago: the empty book is confirmed.
      repo.addJournal(held('378;11', 'Strange Team Captain', 300));
      repo.setSnapshotAt('378;11', Date.now() - 2 * HOUR);
    });
    await core.handle('engine.runNow', {});
    expect(ctx.watchedBaseSkus()).toEqual(expect.arrayContaining(['205;6', '205;11', '378;11']));
    expect(ctx.snapshotPriority?.()).toEqual(['378;6', '126;6', '205;11', '205;6']);
  });
});

describe('snapshotPageDeletes (F51)', () => {
  const l = (id: string, metalScrap: number, intent: 'buy' | 'sell' = 'buy', keys = 0): Listing => makeListing({ id, metalScrap, keys, intent });

  it('deletes only stored orders the page lacks inside the range it covered', () => {
    const page = [l('p1', 140), l('p2', 110), l('p3', 105)];
    const stored = [l('p1', 140), l('gone', 120), l('edge', 106), l('deep', 100)];
    const keep = new Set(['p1']);
    // 106 is within 1% of the 105 edge (106.05): it may only not have fit.
    expect(snapshotPageDeletes(stored, keep, page, 'buy', 567)).toEqual(['gone']);
    expect(SNAPSHOT_PAGE_EDGE_BAND).toBe(0.01);
  });

  it('mirrors the rule for sell listings and values keys at the key price', () => {
    const page = [l('s1', 36, 'sell'), l('s2', 50, 'sell'), l('s3', 0, 'sell', 1)];
    const stored = [l('cheap', 40, 'sell'), l('dear', 600, 'sell'), l('s3', 0, 'sell', 1)];
    // The page reaches up to 1 key (567): a missing 40 scrap listing is gone, a 600 one is past the page.
    expect(snapshotPageDeletes(stored, new Set(['s3']), page, 'sell', 567)).toEqual(['cheap']);
  });

  it('deletes nothing when the page has no readable row of that side', () => {
    expect(snapshotPageDeletes([l('a', 50)], new Set(), [l('s', 40, 'sell')], 'buy', 567)).toEqual([]);
  });
});

describe('core: a full snapshot page is not the whole book (F51)', () => {
  const sec = (): number => Math.floor(Date.now() / 1000);
  const raw = (steamid: string, scrap: number) => ({
    steamid,
    intent: 'buy',
    timestamp: sec() - 600,
    bump: sec() - 60,
    currencies: { keys: 0, metal: scrapToRef(scrap) },
    item: { defindex: 200, quality: 11, quantity: '1', attributes: [{ defindex: 2027, value: 1, float_value: 1 }] },
  });
  const steam = (i: number): string => `7656119800000${String(1000 + i)}`;

  async function refreshWith(rows: unknown[]): Promise<ItemDetail> {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.hostname === 'api.backpack.tf' && u.pathname === '/api/classifieds/listings/snapshot') {
        return new Response(JSON.stringify({ appid: 440, sku: NAME, createdAt: sec(), listings: rows }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
    }) as typeof fetch;
    const { core } = make(
      (repo) => {
        repo.upsertBptfNames([{ sku: ITEM, name: NAME, marketName: null, lastSeen: Date.now() }]);
        // 35 live feed orders at 100..134 scrap, ten minutes old.
        repo.upsertListings(
          Array.from({ length: 35 }, (_, i) =>
            makeListing({ id: bptfBuyListingId(steam(i), NAME), sku: ITEM, baseSku: ITEM, steamid: steam(i), metalScrap: 100 + i, lastEventAt: Date.now() - 10 * MIN, itemName: NAME }),
          ),
        );
      },
      { fetchImpl, settings: { networkPaused: false } },
    );
    const r = (await core.handle('item.refresh', { sku: ITEM })) as { queued: boolean };
    expect(r.queued).toBe(true);
    const end = Date.now() + 15_000;
    for (;;) {
      const d = (await core.handle('item.detail', { sku: ITEM, history: false })) as ItemDetail;
      if (d.snapshot.lastAt !== null) return d;
      if (Date.now() > end) throw new Error('timed out waiting for the snapshot');
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  it('reconciles a 30-row page only from its lowest price up, keeping the deeper live orders', async () => {
    // The page: the best 30 the feed knew (105..134) except 120, plus a new order at 140.
    const rows = [...Array.from({ length: 30 }, (_, k) => 34 - k).filter((i) => 100 + i !== 120).map((i) => raw(steam(i), 100 + i)), raw(steam(99), 140)];
    expect(rows).toHaveLength(30);
    const d = await refreshWith(rows);
    const values = d.buyOrders.filter((o) => o.eligible).map((o) => o.valueScrap);
    expect(values).toContain(140);
    expect(values).not.toContain(120);
    for (const deep of [100, 101, 102, 103, 104]) expect(values).toContain(deep);
    expect(values).toHaveLength(35);
  }, 30_000);

  it('still treats a short page as the whole book', async () => {
    const rows = Array.from({ length: 12 }, (_, k) => 34 - k).map((i) => raw(steam(i), 100 + i));
    const d = await refreshWith(rows);
    const values = d.buyOrders.filter((o) => o.eligible).map((o) => o.valueScrap);
    expect(values.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, k) => 123 + k));
  }, 30_000);
});
