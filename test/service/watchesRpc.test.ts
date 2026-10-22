// 0.8 (G1): the 'watches.*' RPC bodies over the real handlers, a real repo (scraptf_watches), the real watch cache and
// the real bank stock cache (watchRows). zod refusals name the method and the field; the shared refusals (an empty
// watch, a zero price, the cap of WATCHES_MAX, an unknown id, another watch's copy) reach the caller as fixed text;
// 'watches.list' filters by the base of any SKU of the item and says where each watch stands in the user's saves
// (from memory, nothing fetched); every write calls ctx.watchesChanged. No network: the schema is a fixture route.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createWatchCache } from '../../src/service/domain/watches';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { BankStockStored, KeyPriceState, ScraptfWatch, ScraptfWatchView, UnixMs } from '../../src/shared/types';
import {
  WATCHES_FULL,
  WATCHES_MAX,
  WATCH_COPY_TAKEN,
  WATCH_EMPTY,
  WATCH_GONE,
  WATCH_NAME_MAX,
  WATCH_NOT_A_COPY,
  WATCH_SPECIAL_MAX,
  WATCH_ZERO_PRICE,
  watchIndexOf,
  watchesFor,
} from '../../src/shared/watches';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import { watchUndoInput } from '../../src/renderer/watchesModel';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
/** The item data's name of 378;6 (the schema fixture), a watch's name when the input gives none. */
const TEAM_CAPTAIN = 'The Team Captain';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false } });

function entry(revenueScrap: number): MarketEval {
  const o = { listingId: 'l', steamid: '76561198000000002', userName: 'KeyBot', keys: 0, metalScrap: revenueScrap, valueScrap: revenueScrap, isBot: true, online: true, lastEventAt: NOW - MIN, bumpedAt: null, details: '', flags: [], eligible: true };
  return {
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: revenueScrap,
    revenueScrap,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 3,
    eligibleCount: 3,
    maxCostScrap: maxCostFor(revenueScrap, settings.profit),
    confidence: 80,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
  };
}

function card(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Hat ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function service() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const watches = createWatchCache({ repo, log });
  const stock = createBankStock({
    clock: { now: () => NOW },
    log,
    repo,
    market: { entryFor: () => entry(200) },
    keyPrice: () => KEY,
    settings: () => settings,
    categoryOf: () => 'hats',
    watches: () => watches.index(),
  });
  let changed = 0;
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    http: { isPaused: () => false },
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    secret: () => null,
    push: quiet,
    pricesChanged: quiet,
    journalChanged: quiet,
    bankStock: stock,
    watches,
    watchesChanged: () => {
      changed++;
      watches.invalidate();
    },
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  const call = async <T>(method: string, params: unknown) => (await rpc(method, params)) as T;
  const refusal = (method: string, params: unknown): Promise<string> =>
    rpc(method, params).then(
      () => 'answered',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
  const save = (at: UnixMs, rows: readonly BankStockStored[]): number => {
    const id = repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank: 'hats' });
    repo.insertBankStock(id, 'hats', rows, '/buy/hats');
    stock.refresh();
    return id;
  };
  return { repo, call, refusal, save, changes: () => changed };
}

describe("'watches.upsert' and 'watches.delete' (zod)", () => {
  it.each<[string, unknown, RegExp]>([
    ['no sku', { maxCostScrap: 100 }, /: sku: /],
    ['an empty sku', { sku: ' ', maxCostScrap: 100 }, /: sku: an item is required/],
    ['text that is no SKU', { sku: '378;6;uncratable', maxCostScrap: 100 }, /: sku: not a SKU/],
    ['a long special', { sku: '378;6', special: 'x'.repeat(WATCH_SPECIAL_MAX + 1), maxCostScrap: 100 }, /: special: /],
    ["the copy index's every-copy stand-in as a special", { sku: '378;6', special: '*', minProfitScrap: 9 }, /: special: Not a copy key/],
    ['a long name', { sku: '378;6', name: 'n'.repeat(WATCH_NAME_MAX + 1), maxCostScrap: 100 }, /: name: /],
    ['negative keys', { sku: '378;6', maxCostKeys: -1, maxCostScrap: 100 }, /: maxCostKeys: /],
    ['too many keys', { sku: '378;6', maxCostKeys: 10_001, maxCostScrap: 100 }, /: maxCostKeys: /],
    ['fractional scrap', { sku: '378;6', maxCostScrap: 1.5 }, /: maxCostScrap: /],
    ['a negative profit', { sku: '378;6', minProfitScrap: -1 }, /: minProfitScrap: /],
    ['an unknown copies value', { sku: '378;6', copies: 'some', maxCostScrap: 100 }, /: copies: /],
    ['a bad id', { id: 0, sku: '378;6', maxCostScrap: 100 }, /: id: /],
  ])('refuses %s, naming the field', async (_why, params, field) => {
    const s = service();
    const msg = await s.refusal('watches.upsert', params);
    expect(msg).toMatch(/^Invalid parameters for watches\.upsert: /);
    expect(msg).toMatch(field);
    expect(s.repo.countWatches()).toBe(0);
    expect(s.changes()).toBe(0);
  });

  it('accepts null targets (none) and keys with a metal part', async () => {
    const s = service();
    const w = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6', maxCostKeys: 1.5, maxCostScrap: 9, minProfitScrap: null, onRestock: false });
    expect(w).toMatchObject({ sku: '378;6', specialKey: '', name: TEAM_CAPTAIN, maxCostKeys: 1.5, maxCostScrap: 9, minProfitScrap: null, onRestock: false, enabled: true, createdAt: NOW, updatedAt: NOW });
    expect(await s.refusal('watches.delete', { id: -1 })).toMatch(/^Invalid parameters for watches\.delete: id: /);
  });
});

describe("'watches.upsert' rules", () => {
  it('refuses an empty watch and a zero price with the shared texts', async () => {
    const s = service();
    expect(await s.refusal('watches.upsert', { sku: '378;6' })).toBe(WATCH_EMPTY);
    expect(await s.refusal('watches.upsert', { sku: '378;6', maxCostScrap: null, minProfitScrap: null, onRestock: false })).toBe(WATCH_EMPTY);
    expect(await s.refusal('watches.upsert', { sku: '378;6', maxCostScrap: 0 })).toBe(WATCH_ZERO_PRICE);
    expect(s.repo.countWatches()).toBe(0);
    expect(s.changes()).toBe(0);
  });

  it('keeps the base of a painted SKU and its paint as the copy, or every copy; the name from the item data', async () => {
    const s = service();
    const painted = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6;p15185211', maxCostScrap: 300 });
    expect(painted).toMatchObject({ sku: '378;6', specialKey: bankStockSpecialKey({ paint: 15185211 }), name: TEAM_CAPTAIN });
    const any = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6;p15185211', copies: 'any', onRestock: true, name: '  My hat  ' });
    expect(any).toMatchObject({ sku: '378;6', specialKey: null, name: 'My hat', onRestock: true, maxCostScrap: null });
    const special = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6', special: '', minProfitScrap: 20 });
    expect(special).toMatchObject({ specialKey: '', minProfitScrap: 20 });
    expect(s.repo.countWatches()).toBe(3);
  });

  it('an update keeps what it leaves out; an unknown id is WATCH_GONE; another watch\'s copy is refused', async () => {
    const s = service();
    const w = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6', maxCostKeys: 1, maxCostScrap: 9, onRestock: true });
    const edited = await s.call<ScraptfWatch>('watches.upsert', { id: w.id, sku: '378;6', minProfitScrap: 30 });
    expect(edited).toMatchObject({ id: w.id, maxCostKeys: 1, maxCostScrap: 9, minProfitScrap: 30, onRestock: true, enabled: true, specialKey: '' });
    const paused = await s.call<ScraptfWatch>('watches.upsert', { id: w.id, sku: '378;6', enabled: false });
    expect(paused).toMatchObject({ enabled: false, minProfitScrap: 30 });
    expect(await s.refusal('watches.upsert', { id: 9999, sku: '378;6', maxCostScrap: 10 })).toBe(WATCH_GONE);
    const all = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6', copies: 'any', maxCostScrap: 20 });
    expect(await s.refusal('watches.upsert', { id: all.id, sku: '378;6', copies: 'one', special: '' })).toBe(WATCH_COPY_TAKEN);
  });

  it("refuses a special of '*' (the copy index's every-copy stand-in) and leaves the any-copy watch covering every copy", async () => {
    const s = service();
    const any = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6', copies: 'any', maxCostScrap: 90, onRestock: true });
    const want = `Invalid parameters for watches.upsert: special: ${WATCH_NOT_A_COPY}`;
    expect(await s.refusal('watches.upsert', { sku: '378;6', special: '*', minProfitScrap: 9 })).toBe(want);
    expect(await s.refusal('watches.upsert', { id: any.id, sku: '378;6', copies: 'one', special: '*' })).toBe(want);
    expect(s.repo.listWatches()).toEqual([any]);
    expect(watchesFor(watchIndexOf(s.repo.listWatches()), '378;6', '')).toEqual([any]);
    expect(s.changes()).toBe(1);
  });

  it(`stops at ${WATCHES_MAX} watches; an update, or the same copy again, still goes through`, async () => {
    const s = service();
    for (let i = 0; i < WATCHES_MAX; i++) s.repo.upsertWatch({ sku: `${1000 + i};6`, specialKey: '', name: `x${i}`, maxCostKeys: 0, maxCostScrap: 10, minProfitScrap: null, onRestock: false, enabled: true }, NOW);
    expect(await s.refusal('watches.upsert', { sku: '378;6', maxCostScrap: 10 })).toBe(WATCHES_FULL);
    // The same copy as a watch that exists is that watch, updated in place.
    expect(await s.call<ScraptfWatch>('watches.upsert', { sku: '1000;6', maxCostScrap: 12 })).toMatchObject({ sku: '1000;6', maxCostScrap: 12 });
    const first = s.repo.listWatches()[0]!;
    expect(await s.call<ScraptfWatch>('watches.upsert', { id: first.id, sku: first.sku, minProfitScrap: 5 })).toMatchObject({ id: first.id, minProfitScrap: 5 });
    expect(s.repo.countWatches()).toBe(WATCHES_MAX);
  });

  it('every write calls watchesChanged (core re-reads the cache and pushes watches.changed)', async () => {
    const s = service();
    const w = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6', maxCostScrap: 300 });
    expect(s.changes()).toBe(1);
    await s.call('watches.upsert', { id: w.id, sku: '378;6', enabled: false });
    expect(s.changes()).toBe(2);
    expect(await s.call('watches.delete', { id: w.id })).toEqual({ ok: true });
    expect(s.changes()).toBe(3);
    expect(s.repo.countWatches()).toBe(0);
  });
});

describe("'watches.restore' (Undo of a removal)", () => {
  const HOUR = 60 * MIN;
  const removed = (s: ReturnType<typeof service>, over: Partial<ScraptfWatch> = {}): ScraptfWatch => {
    const w = s.repo.upsertWatch({ sku: '378;6', specialKey: '', name: 'Team Captain', maxCostKeys: 1, maxCostScrap: 9, minProfitScrap: 20, onRestock: true, enabled: false, ...over }, NOW - 2 * HOUR);
    s.repo.deleteWatch(w.id);
    return w;
  };
  const params = (w: ScraptfWatch) => watchUndoInput(w);

  it('puts the same watch back: its id, copy, targets, switches and times (not a new watch judged afresh)', async () => {
    const s = service();
    const w = removed(s);
    // A newer watch takes the next id meanwhile; the removed one's id is never handed out again.
    const other = await s.call<ScraptfWatch>('watches.upsert', { sku: '143;6', maxCostScrap: 50 });
    expect(other.id).toBeGreaterThan(w.id);
    const back = await s.call<ScraptfWatch>('watches.restore', params(w));
    expect(back).toEqual(w);
    expect(s.repo.getWatch(w.id)).toEqual(w);
    expect(s.changes()).toBe(2);
    // A second Undo returns it as it is.
    expect(await s.call<ScraptfWatch>('watches.restore', params(w))).toEqual(w);
    expect(s.repo.countWatches()).toBe(2);
  });

  it('refuses a copy watched again since, at the cap, and keeps the times at or before now', async () => {
    const s = service();
    const w = removed(s);
    const again = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6', maxCostScrap: 10 });
    expect(await s.refusal('watches.restore', params(w))).toBe(WATCH_COPY_TAKEN);
    await s.call('watches.delete', { id: again.id });
    const future = await s.call<ScraptfWatch>('watches.restore', { ...params(w), createdAt: NOW + HOUR, updatedAt: NOW + HOUR });
    expect(future).toMatchObject({ id: w.id, createdAt: NOW, updatedAt: NOW });
    const full = service();
    const gone = removed(full);
    for (let i = 0; i < WATCHES_MAX; i++) full.repo.upsertWatch({ sku: `${1000 + i};6`, specialKey: '', name: `x${i}`, maxCostKeys: 0, maxCostScrap: 10, minProfitScrap: null, onRestock: false, enabled: true }, NOW);
    expect(await full.refusal('watches.restore', params(gone))).toBe(WATCHES_FULL);
    expect(await full.refusal('watches.restore', { ...params(gone), id: 0 })).toMatch(/^Invalid parameters for watches\.restore: id: /);
    expect(await full.refusal('watches.restore', { ...params(gone), updatedAt: 1.5 })).toMatch(/^Invalid parameters for watches\.restore: updatedAt: /);
  });
});

describe("'watches.list'", () => {
  it('lists every watch (paused ones too) by name, and by the base of any SKU of the item', async () => {
    const s = service();
    expect(await s.call<ScraptfWatchView[]>('watches.list', {})).toEqual([]);
    expect(await s.call<ScraptfWatchView[]>('watches.list', null)).toEqual([]);
    await s.call('watches.upsert', { sku: '378;6', maxCostScrap: 300 });
    const bills = await s.call<ScraptfWatch>('watches.upsert', { sku: '126;6', copies: 'any', onRestock: true });
    await s.call('watches.upsert', { id: bills.id, sku: '126;6', enabled: false });
    const all = await s.call<ScraptfWatchView[]>('watches.list', {});
    expect(all.map((w) => [w.name, w.enabled])).toEqual([
      ["Bill's Hat", false],
      [TEAM_CAPTAIN, true],
    ]);
    const painted = await s.call<ScraptfWatchView[]>('watches.list', { sku: '378;6;p15185211' });
    expect(painted.map((w) => w.sku)).toEqual(['378;6']);
    expect(await s.call<ScraptfWatchView[]>('watches.list', { sku: '205;6' })).toEqual([]);
    expect(await s.refusal('watches.list', { sku: 'nope' })).toMatch(/^Invalid parameters for watches\.list: sku: /);
  });

  it("says where each watch stands on the newest saves of the user's pages (the cheapest copy it covers)", async () => {
    const s = service();
    s.save(NOW - 2 * 60 * MIN, [card('378;6', 140)]);
    s.save(NOW - 10 * MIN, [card('378;6', 100), card('378;6', 90, { specialKey: bankStockSpecialKey({ paint: 15185211 }) }), card('126;6', 300)]);
    const tc = await s.call<ScraptfWatch>('watches.upsert', { sku: '378;6', copies: 'any', maxCostScrap: 95 });
    await s.call('watches.upsert', { sku: '126;6', maxCostScrap: 250 });
    await s.call('watches.upsert', { sku: '205;6', onRestock: true });
    const views = await s.call<ScraptfWatchView[]>('watches.list', {});
    const bySku = new Map(views.map((v) => [v.sku, v]));
    expect(bySku.get('378;6')).toMatchObject({ id: tc.id, now: { bank: 'hats', savedAt: NOW - 10 * MIN, costScrap: 90, revenueScrap: 200, profitScrap: 110, verdict: 'flip', met: 'price', overTargetScrap: -5 } });
    expect(bySku.get('126;6')!.now).toMatchObject({ costScrap: 300, verdict: 'over', met: null, overTargetScrap: 50 });
    expect(bySku.get('205;6')!.now).toBeNull();
  });
});
