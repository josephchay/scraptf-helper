// 0.7.4 trading accuracy audit, package G2, through a real createServiceCore (the scheduler module is wrapped
// only to capture the JobContext core hands buildJobs):
// - R09 (F16/F24/F30): a row the verified-order preference prices at a loss or below the thresholds, whose
//   unverified best order would be a flip against its cost (unverifiedUpside), is ranked for a background
//   snapshot after the unconfirmed profitable and below-threshold rows (Strange Archer's Sterling: a verified
//   100 scrap order, a 115 scrap bot not seen for days, cost 103). Not when that order is an outlier or would
//   not clear the thresholds.
// - R10: an order a name snapshot of the item cannot return (a generic any-effect order filed under 378;5 for
//   a 378;5;u13 row) gives no pick, so it cannot take the slot every 30 min; an effect-specific order still does.
// - R13: no FIFO confirm queue runs ahead of the profit-ranked list (and none drops its most profitable entries):
//   ctx.nextQueuedSnapshot serves the typed prices only, and snapshotPriority ranks every unconfirmed row.
// - R15: a rule candidate's base is never watched, so it is never ranked (README: the live feed or Refresh from
//   backpack.tf confirms those).
// - R36 (F23): a snapshot carries the buyer's online flag only from a recent feed row; the next snapshot, 61 min
//   later, finds the row it stamped itself and drops the flag (no "+5 Buyer is online").
// Temp dirs only. The fetch refuses every host but the faked api.backpack.tf snapshot (R36 case) and the socket
// is a fake, so the fake token never leaves the process. Snapshot rows are mapped with the real schema fixture
// (cached in the database as a previous run would have).

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
import { unverifiedUpside } from '../../src/service/domain/engine';
import type { JobContext } from '../../src/service/scheduler';
import { scrapToRef } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, ItemDetail, Listing, OppListResult, OrderSummary, Settings } from '../../src/shared/types';
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

interface MakeOpts {
  fetchImpl?: typeof fetch;
  settings?: DeepPartial<Settings>;
  clock?: { now(): number };
}

function make(seed: (repo: Repo) => void, opts: MakeOpts = {}): { core: ServiceCore; ctx: JobContext } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit074-upside-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  const now = opts.clock?.now() ?? Date.now();
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
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  cores.push(core);
  expect(core.failure).toBeUndefined();
  const ctx = held.ctx;
  if (ctx === null) throw new Error('buildJobs was not called');
  while (ctx.nextQueuedSnapshot() !== null) {
    /* drain the start-up queue */
  }
  return { core, ctx };
}

const buy = (sku: string, steamid: string, metalScrap: number, ageMs: number, over: Partial<Listing> = {}): Listing =>
  makeListing({ id: `${sku}-${steamid}`, sku, baseSku: sku, steamid, metalScrap, isBot: true, lastEventAt: Date.now() - ageMs, ...over });

const price = (repo: Repo, sku: string, name: string, costScrap: number, costKeys = 0): void => {
  repo.upsertScrapPrice({ sku, name, costKeys, costScrap, source: 'import', observedAt: Date.now() - MIN });
};

/** Strange Archer's Sterling in the user's data, on Team Captain: a verified 100 scrap order 21 h old, a 115 scrap bot not seen for 3 days. */
function archersBook(repo: Repo, sku = '378;6', cost = 103, over: Partial<Listing> = {}): void {
  repo.upsertListings([buy(sku, 'PAYAH', 115, 72 * HOUR, over), buy(sku, 'SpaceBot', 100, 21 * HOUR, { isBot: false })]);
  price(repo, sku, 'Team Captain', cost);
}

describe('unverifiedUpside (R09)', () => {
  const order = (over: Partial<OrderSummary>): OrderSummary => ({
    listingId: 'l',
    steamid: 'S',
    userName: null,
    keys: 0,
    metalScrap: 115,
    valueScrap: 115,
    isBot: true,
    online: null,
    lastEventAt: 0,
    bumpedAt: null,
    details: '',
    flags: ['unverified'],
    eligible: true,
    ...over,
  });
  const P = DEFAULT_SETTINGS.profit;

  it('is the profit on the unverified best order when it clears the thresholds', () => {
    expect(unverifiedUpside({ bestOrder: order({}), costScrap: 103, flags: [] }, P)).toBe(12);
    // 115 - 108 = 7 is under the 9 scrap floor; a verified, outlier or any-effect order is no upside.
    expect(unverifiedUpside({ bestOrder: order({}), costScrap: 108, flags: [] }, P)).toBeNull();
    expect(unverifiedUpside({ bestOrder: order({ flags: [] }), costScrap: 103, flags: [] }, P)).toBeNull();
    expect(unverifiedUpside({ bestOrder: order({ flags: ['unverified', 'outlier'] }), costScrap: 103, flags: [] }, P)).toBeNull();
    expect(unverifiedUpside({ bestOrder: order({ flags: ['any-effect', 'unverified'] }), costScrap: 103, flags: [] }, P)).toBeNull();
    expect(unverifiedUpside({ bestOrder: null, costScrap: 103, flags: [] }, P)).toBeNull();
    // A row the notification gates mute anyway gets no snapshot for its upside.
    for (const f of ['stale-input', 'variant-suspect', 'cost-below-market', 'suspect-margin']) {
      expect(unverifiedUpside({ bestOrder: order({}), costScrap: 103, flags: [f] }, P)).toBeNull();
    }
    // Friction counts as it does for the row's own profit.
    expect(unverifiedUpside({ bestOrder: order({}), costScrap: 103, flags: [] }, { ...P, frictionScrap: 4 })).toBeNull();
  });
});

describe('core.snapshotPriority: rows the verified-order preference hides (R09)', () => {
  it("ranks Strange Archer's Sterling after the profitable rows, though its row is a loss", async () => {
    const { core, ctx } = make((repo) => {
      archersBook(repo);
      // Bill's Hat: profitable on a 30 h old order, ranked first.
      repo.upsertListings([buy('126;6', 'S2', 108, 30 * HOUR)]);
      price(repo, '126;6', "Bill's Hat", 60);
      // A watched item with nothing to confirm (fresh order).
      repo.upsertListings([buy('205;11', 'S3', 140, MIN)]);
      price(repo, '205;11', 'Strange Rocket Launcher', 60);
    });
    await core.handle('engine.runNow', {});
    const r = (await core.handle('opps.list', {})) as OppListResult;
    const tc = r.rows.find((o) => o.sku === '378;6')!;
    expect(tc).toMatchObject({ status: 'unprofitable', consScrap: 100, bestScrap: 115 });
    expect(tc.bestOrder?.flags).toContain('unverified');
    expect(ctx.snapshotPriority?.()).toEqual(['126;6', '378;6']);
    expect(ctx.nextQueuedSnapshot()).toBeNull();
  });

  it('ranks the upside rows by their potential profit', async () => {
    const { core, ctx } = make((repo) => {
      archersBook(repo, '378;6', 103); // +12
      archersBook(repo, '126;6', 90); // +25
    });
    await core.handle('engine.runNow', {});
    expect(ctx.snapshotPriority?.()).toEqual(['126;6', '378;6']);
  });

  it('skips the row when its unverified best order is an outlier or would not clear the thresholds', async () => {
    const outlier = make((repo) => {
      archersBook(repo);
      // PriceDB sells Team Captain for 70: 115 is over 1.5x of it, 100 is not.
      repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 60, sellKeys: 0, sellScrap: 70, time: Math.floor(Date.now() / 1000) - 3600, fetchedAt: Date.now() }]);
    });
    await outlier.core.handle('engine.runNow', {});
    const row = ((await outlier.core.handle('opps.list', {})) as OppListResult).rows[0]!;
    expect(row.bestOrder?.flags).toContain('outlier');
    expect(outlier.ctx.snapshotPriority?.()).toEqual([]);
    await outlier.core.stop();
    cores.splice(cores.indexOf(outlier.core), 1);
    resetBptfSocketGuard();

    const thin = make((repo) => archersBook(repo, '378;6', 108));
    await thin.core.handle('engine.runNow', {});
    expect(thin.ctx.snapshotPriority?.()).toEqual([]);
  });
});

describe('core.snapshotPriority: orders a name snapshot cannot confirm (R10)', () => {
  it('gives no pick for an effect row whose revenue rests on a generic any-effect order', async () => {
    const { core, ctx } = make((repo) => {
      repo.upsertListings([buy('378;5', 'GEN', 0, 30 * HOUR, { keys: 60, itemName: 'Unusual Team Captain' })]);
      price(repo, '378;5;u13', 'Burning Flames Team Captain', 0, 40);
    });
    await core.handle('engine.runNow', {});
    const row = ((await core.handle('opps.list', {})) as OppListResult).rows.find((o) => o.sku === '378;5;u13')!;
    expect(row.status).toBe('profitable');
    expect(row.consOrder?.flags).toEqual(expect.arrayContaining(['any-effect', 'unverified']));
    expect(ctx.watchedBaseSkus()).toContain('378;5;u13');
    expect(ctx.snapshotPriority?.()).toEqual([]);
    expect(ctx.nextQueuedSnapshot()).toBeNull();
  });

  it('still ranks the effect row when an effect-specific order out-prices the generic one', async () => {
    const { core, ctx } = make((repo) => {
      repo.upsertListings([
        buy('378;5', 'GEN', 0, 30 * HOUR, { keys: 60, itemName: 'Unusual Team Captain' }),
        buy('378;5;u13', 'EFX', 0, 30 * HOUR, { keys: 62, itemName: 'Burning Flames Team Captain' }),
      ]);
      price(repo, '378;5;u13', 'Burning Flames Team Captain', 0, 40);
    });
    await core.handle('engine.runNow', {});
    expect(ctx.snapshotPriority?.()).toEqual(['378;5;u13']);
  });
});

describe('core: no FIFO confirm queue ahead of the ranking (R13)', () => {
  it('ranks 60 unconfirmed rows most profit first and queues none of them', async () => {
    const skus = Array.from({ length: 60 }, (_, i) => `${3000 + i};6`);
    const { core, ctx } = make((repo) => {
      // Profit 12 + i scrap on cost 100: the margins stay under the suspect-margin cut.
      repo.upsertListings(skus.map((sku, i) => buy(sku, `S${i}`, 112 + i, 30 * HOUR)));
      skus.forEach((sku) => price(repo, sku, sku, 100));
    });
    await core.handle('engine.runNow', {});
    expect(ctx.nextQueuedSnapshot()).toBeNull();
    const ranked = ctx.snapshotPriority?.() ?? [];
    expect(ranked).toHaveLength(60);
    expect(ranked.slice(0, 10)).toEqual([...skus].reverse().slice(0, 10));
  });
});

describe('core: rule candidates are never ranked (R15)', () => {
  it('leaves a profitable rule row on an unverified order to the feed and Refresh from backpack.tf', async () => {
    const { core, ctx } = make((repo) => {
      repo.upsertListings([buy('378;6', 'S1', 108, 30 * HOUR)]);
    });
    await core.handle('rules.upsert', { name: 'Hats', filter: { defindexes: [378], hasEffect: false }, costScrap: 60 });
    await core.handle('engine.runNow', {});
    const r = (await core.handle('opps.list', { inputKinds: ['rule'] })) as OppListResult;
    expect(r.rows.map((o) => [o.sku, o.status])).toEqual([['378;6', 'profitable']]);
    expect(ctx.watchedBaseSkus()).not.toContain('378;6');
    expect(ctx.snapshotPriority?.()).toEqual([]);
    expect(ctx.nextQueuedSnapshot()).toBeNull();
  });
});

describe('core: a snapshot never keeps a stale online flag going (R36, F23)', () => {
  const ITEM = '200;11;australium';
  const NAME = 'Strange Australium Scattergun';
  const BUYER = '76561198000001234';

  it('carries a recent feed flag once, and drops it at the next snapshot 61 min later', async () => {
    const clock = { t: Date.now(), now(): number {
      return this.t;
    } };
    const sec = (): number => Math.floor(clock.t / 1000);
    let fetches = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.hostname === 'api.backpack.tf' && u.pathname === '/api/classifieds/listings/snapshot') {
        fetches++;
        const row = {
          steamid: BUYER,
          intent: 'buy',
          timestamp: sec() - 600,
          bump: sec() - 60,
          currencies: { keys: 0, metal: scrapToRef(120) },
          item: { defindex: 200, quality: 11, quantity: '1', attributes: [{ defindex: 2027, value: 1, float_value: 1 }] },
        };
        return new Response(JSON.stringify({ appid: 440, sku: NAME, createdAt: sec(), listings: [row] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
    }) as typeof fetch;
    const { core, ctx } = make(
      (repo) => {
        repo.upsertBptfNames([{ sku: ITEM, name: NAME, marketName: null, lastSeen: clock.t }]);
        // The feed saw this buyer online a minute ago.
        repo.upsertListings([
          makeListing({ id: bptfBuyListingId(BUYER, NAME), sku: ITEM, baseSku: ITEM, steamid: BUYER, metalScrap: 120, userOnline: true, origin: 'ws', lastEventAt: clock.t - MIN, itemName: NAME }),
        ]);
        repo.upsertScrapPrice({ sku: ITEM, name: NAME, costScrap: 60, source: 'import', observedAt: clock.t - MIN });
      },
      { fetchImpl, clock, settings: { networkPaused: false } },
    );
    const detail = async (): Promise<ItemDetail> => (await core.handle('item.detail', { sku: ITEM, history: false })) as ItemDetail;

    await ctx.snapshot(ITEM, 'background');
    expect(fetches).toBe(1);
    expect((await detail()).buyOrders[0]).toMatchObject({ steamid: BUYER, online: true });

    clock.t += 61 * MIN;
    await ctx.snapshot(ITEM, 'background');
    expect(fetches).toBe(2);
    const d = await detail();
    expect(d.buyOrders[0]).toMatchObject({ steamid: BUYER, online: null });
    await core.handle('engine.runNow', {});
    const opp = ((await core.handle('opps.list', {})) as OppListResult).rows.find((o) => o.sku === ITEM)!;
    expect(opp.reasons.join('\n')).not.toMatch(/Buyer is online/);
  });
});
