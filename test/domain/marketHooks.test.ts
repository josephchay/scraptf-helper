// v0.3 additions to the Live market index: onBasesChanged (the holdings
// trigger, same change test and throttle as onChanged), entryFor and the best
// order (holdings price held items from them), H1 (a failed candidate scan is
// reported and retried with backoff instead of "Building 0 %" for 10 min) and
// the F13 saved-page coverage strip (cached, refreshed on pricesChanged).
// Real in-memory repo, fake clock and timers; nothing here touches the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import {
  MARKET_DIRTY_BATCH_MS,
  MARKET_FULL_EVERY_MS,
  MARKET_NOTIFY_MS,
  MARKET_RETRY_MAX_MS,
  MARKET_RETRY_MIN_MS,
  createMarketIndex,
  evaluateMarketBase,
  type MarketIndex,
} from '../../src/service/domain/market';
import { matchContext } from '../../src/service/domain/matcher';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANK_PAGES } from '../../src/shared/links';
import type { Category, DeepPartial, ImportBatch, Listing, Settings, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, recordingLogger } from './helpers';
import type { StubSchemaOptions } from './helpers';

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
  vi.restoreAllMocks();
});

function newRepo(): Repo {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  return repo;
}

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

function setup(opts: { repo?: Repo; settings?: DeepPartial<Settings>; schema?: StubSchemaOptions; listen?: boolean } = {}) {
  const repo = opts.repo ?? newRepo();
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, opts.settings ?? {}) };
  const log = recordingLogger();
  const changes: { changed: number; total: number; at: UnixMs }[] = [];
  const bases: string[][] = [];
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now());
  const market: MarketIndex = createMarketIndex({
    ...makeDeps(repo, clock, () => settings.current, log),
    schema: createStubSchema(opts.schema),
    timers,
    keyPrice,
    onChanged: (p) => changes.push(p),
    folderWatchActive: () => false,
    ...(opts.listen === false ? {} : { onBasesChanged: (b: ReadonlySet<string>) => bases.push([...b].sort()) }),
  });
  return { repo, clock, timers, settings, log, market, changes, bases, K: () => keyPrice().valueScrap };
}

type H = ReturnType<typeof setup>;

function build(h: H): void {
  h.market.start();
  h.timers.advance(0);
  expect(h.market.stats().building).toBe(false);
}

// ---------------------------------------------------------------------------
// onBasesChanged
// ---------------------------------------------------------------------------

describe('onBasesChanged', () => {
  it('reports the bases behind each change push, with the same change test and throttle as onChanged', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'S1' }), buy('126;6', 60, { id: 'bh', steamid: 'S2' })]);
    const h = setup({ repo });
    build(h);
    // The first build adds every entry: one push, every base.
    expect(h.changes).toHaveLength(1);
    expect(h.bases).toEqual([['126;6', '378;6']]);

    // Re-evaluated without moving (a confirmation of the same order): no push, no bases.
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'S1', lastEventAt: T0 })]);
    h.market.markDirty(['378;6']);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(h.changes).toHaveLength(1);
    expect(h.bases).toHaveLength(1);

    // A better order (revenue moved) and a new base, inside the throttle window of the first push.
    repo.upsertListings([buy('378;6', 130, { id: 'tc2', steamid: 'S3' }), buy('205;6', 40, { id: 'rl', steamid: 'S4' })]);
    h.market.markDirty(['378;6', '205;6']);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(h.changes).toHaveLength(2);
    expect(h.bases.at(-1)).toEqual(['205;6', '378;6']);

    // Removed: the last eligible order goes.
    repo.deleteListings(['bh']);
    h.market.markDirty(['126;6']);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    h.timers.advance(MARKET_NOTIFY_MS);
    expect(h.changes).toHaveLength(3);
    expect(h.bases.at(-1)).toEqual(['126;6']);
    // Every push carried exactly the bases it counted.
    expect(h.changes.map((c) => c.changed)).toEqual(h.bases.map((b) => b.length));
  });

  it('collects bases across slices until the throttled push, and a failing listener does not break onChanged', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'S1' })]);
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const log = recordingLogger();
    const changes: number[] = [];
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    const market = createMarketIndex({
      ...makeDeps(repo, clock, () => settings, log),
      schema: createStubSchema(),
      timers,
      keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings, clock.now()),
      onChanged: (p) => changes.push(p.changed),
      folderWatchActive: () => false,
      onBasesChanged: () => {
        throw new Error('listener broke');
      },
    });
    market.start();
    timers.advance(0);
    expect(changes).toEqual([1]);
    expect(log.lines.some((l) => l.level === 'warn' && /change listener failed/.test(l.msg))).toBe(true);
  });

  it('keeps no bases when nobody listens', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'S1' })]);
    const h = setup({ repo, listen: false });
    build(h);
    expect(h.changes).toHaveLength(1);
    expect(h.bases).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// entryFor and bestOrder
// ---------------------------------------------------------------------------

describe('entryFor', () => {
  it("returns a base's entry (paint dropped), or null without one", () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'S1', userName: 'Alice' })]);
    const h = setup({ repo });
    expect(h.market.entryFor('378;6')).toBeNull(); // not built yet
    build(h);
    const e = h.market.entryFor('378;6')!;
    expect(e).toMatchObject({ revenueScrap: 120, buyerCount: 1, revenueOrder: { listingId: 'tc', userName: 'Alice' } });
    expect(h.market.entryFor('378;6;p3100495')).toBe(e);
    expect(h.market.entryFor('126;6')).toBeNull();
    expect(h.market.entryFor(42 as unknown as string)).toBeNull();
  });
});

describe('evaluateMarketBase: bestOrder', () => {
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const match = matchContext(settings, T0);
  const refs = { pricedb: null, community: null };

  it('is the top eligible order, shared with the revenue order when they are one listing', () => {
    const base = '378;6';
    const one = evaluateMarketBase({ base, listings: [buy(base, 120, { id: 'a', steamid: 'A' })], references: refs, isUnusual: false, settings, keyScrap: 567, now: T0, match })!;
    expect(one.bestOrder).toMatchObject({ listingId: 'a', valueScrap: 120 });
    expect(one.bestOrder).toBe(one.revenueOrder);

    const listings = [buy(base, 300, { id: 'spike', steamid: 'X' }), buy(base, 108, { id: 'b', steamid: 'B' }), buy(base, 105, { id: 'c', steamid: 'C' }), buy(base, 102, { id: 'd', steamid: 'D' })];
    const ev = evaluateMarketBase({ base, listings, references: refs, isUnusual: false, settings, keyScrap: 567, now: T0, match })!;
    // The conservative pick skips the outlier; the best order is still the top one, marked.
    expect(ev.revenueOrder?.listingId).toBe('b');
    expect(ev.bestOrder).toMatchObject({ listingId: 'spike', valueScrap: 300 });
    expect(ev.bestOrder?.flags).toContain('outlier');
    expect(ev.bestScrap).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// H1: a failed candidate scan
// ---------------------------------------------------------------------------

describe('H1: rebuild failure', () => {
  it('reports the error, stops "building" and retries after 30 s, doubling to 10 min, until a scan succeeds', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'S1' })]);
    const scan = vi.spyOn(repo, 'baseSkusWithBuyOrders').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const h = setup({ repo });
    h.market.start();
    h.timers.advance(0);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(h.market.stats()).toMatchObject({ building: false, entries: 0, lastFullAt: null, lastError: 'database is locked', retryAt: T0 + MARKET_RETRY_MIN_MS });
    expect(h.log.lines.some((l) => l.level === 'warn' && /could not start/.test(l.msg))).toBe(true);

    h.timers.advance(MARKET_RETRY_MIN_MS - 1);
    expect(scan).toHaveBeenCalledTimes(1);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = h.market.stats().retryAt!;
      h.timers.advance(before - h.clock.now());
      delays.push(h.market.stats().retryAt! - h.clock.now());
    }
    expect(scan).toHaveBeenCalledTimes(8);
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, MARKET_RETRY_MAX_MS, MARKET_RETRY_MAX_MS, MARKET_RETRY_MAX_MS]);
    expect(h.market.stats().building).toBe(false);

    // The database recovers: the next attempt builds and clears the error.
    scan.mockRestore();
    h.timers.advance(MARKET_RETRY_MAX_MS);
    expect(h.market.stats()).toMatchObject({ building: false, entries: 1, lastError: null, retryAt: null, lastFullAt: h.clock.now() });
    // No retry left behind: only the 10-min rebuild runs from here.
    const reads = vi.spyOn(repo, 'baseSkusWithBuyOrders');
    h.timers.advance(MARKET_FULL_EVERY_MS - 1);
    expect(reads).not.toHaveBeenCalled();
    h.timers.advance(1);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('restarts the backoff after a success, retries at once on markAllDirty, and clears its timer on stop', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'S1' })]);
    const h = setup({ repo });
    let failing = true;
    const real = repo.baseSkusWithBuyOrders.bind(repo);
    const scan = vi.spyOn(repo, 'baseSkusWithBuyOrders').mockImplementation(() => {
      if (failing) throw new Error('disk I/O error');
      return real();
    });
    h.market.start();
    h.timers.advance(0);
    h.timers.advance(MARKET_RETRY_MIN_MS); // second failure: next wait 60 s
    expect(h.market.stats().retryAt).toBe(h.clock.now() + 2 * MARKET_RETRY_MIN_MS);

    // A settings change during the wait tries at once (and fails again: the wait doubles).
    h.market.markAllDirty();
    expect(h.market.stats().building).toBe(true);
    h.timers.advance(0);
    expect(scan).toHaveBeenCalledTimes(3);
    expect(h.market.stats()).toMatchObject({ building: false, lastError: 'disk I/O error', retryAt: h.clock.now() + 4 * MARKET_RETRY_MIN_MS });

    // Stopped while waiting: no timer survives, and the next start tries at once.
    h.market.stop();
    expect(h.timers.count).toBe(0);
    expect(h.market.stats().retryAt).toBeNull();
    failing = false;
    h.market.start();
    h.timers.advance(0);
    expect(h.market.stats()).toMatchObject({ building: false, entries: 1, lastError: null, retryAt: null });

    // A later failure starts again at 30 s.
    failing = true;
    h.market.markAllDirty();
    h.timers.advance(0);
    expect(h.market.stats()).toMatchObject({ lastError: 'disk I/O error', retryAt: h.clock.now() + MARKET_RETRY_MIN_MS });
    // The entries already built stay readable meanwhile.
    expect(h.market.entryFor('378;6')?.revenueScrap).toBe(120);
    expect(h.market.list({}, h.clock.now()).stats).toMatchObject({ building: false, lastError: 'disk I/O error' });
  });
});

// ---------------------------------------------------------------------------
// F13: saved-page coverage
// ---------------------------------------------------------------------------

describe('F13: scrap.tf saved-page coverage', () => {
  // defindex -> category, so each test page's mix is explicit.
  const CATS: Record<number, Category> = { 1: 'hats', 2: 'weapons', 3: 'stranges', 4: 'unusuals', 5: 'taunts', 6: 'other' };
  const schema: StubSchemaOptions = { items: [], categoryOf: (d) => CATS[Math.floor(d / 1000)] ?? 'other', nameOf: (s) => `Item ${s}` };

  function page(repo: Repo, b: Omit<ImportBatch, 'id' | 'itemCount'>, defindexes: number[]): number {
    const id = repo.createImportBatch({ ...b, itemCount: defindexes.length });
    for (const d of defindexes) {
      repo.upsertScrapPrice({ sku: `${d};6`, name: `Item ${d}`, costScrap: 20, source: 'import', observedAt: b.fileMtime || b.importedAt, importBatch: id, stock: 1 });
    }
    return id;
  }

  const byLabel = (h: H) => Object.fromEntries(h.market.list({}, h.clock.now()).scraptf.coverage.map((c) => [c.label, [c.lastSavedAt, c.items]]));

  it('lists every bank page in strip order, each with its newest mostly-matching saved page', () => {
    const repo = newRepo();
    // Hats page (3 of 4 items are hats), saved 10 min ago.
    page(repo, { fileName: 'hats-old.html', pageKind: 'buy', fileMtime: T0 - 10 * MIN, importedAt: T0 - 9 * MIN }, [1001, 1002, 1003, 2001]);
    // A newer hats page: newest wins.
    page(repo, { fileName: 'hats.html', pageKind: 'buy', fileMtime: T0 - 4 * MIN, importedAt: T0 - 3 * MIN }, [1004, 1005]);
    // An /items list full of hats counts for no bank page.
    page(repo, { fileName: 'items.html', pageKind: 'items-list', fileMtime: T0 - MIN, importedAt: T0 - MIN }, [1006, 1007, 1008]);
    // No majority (1 hat, 1 weapon, 1 strange): no page.
    page(repo, { fileName: 'mixed.html', pageKind: 'buy', fileMtime: T0 - 2 * MIN, importedAt: T0 - 2 * MIN }, [1009, 2002, 3001]);
    // Unusuals: no file time recorded, so the import time counts.
    page(repo, { fileName: 'unusuals.html', pageKind: 'unusuals', fileMtime: 0, importedAt: T0 - 30 * MIN }, [4001, 4002]);
    // Taunts and tools are the Items bank page.
    page(repo, { fileName: 'buy-items.html', pageKind: 'buy', fileMtime: T0 - 20 * MIN, importedAt: T0 - 20 * MIN }, [5001, 6001, 2003]);
    const h = setup({ repo, schema });
    build(h);

    const cov = h.market.list({}, T0).scraptf.coverage;
    expect(cov.map((c) => [c.category, c.label, c.url])).toEqual(SCRAPTF_BANK_PAGES.map((p) => [p.category, p.label, p.url]));
    expect(byLabel(h)).toEqual({
      Hats: [T0 - 4 * MIN, 2],
      Weapons: [null, 0],
      Stranges: [null, 0],
      Killstreaks: [null, 0],
      Skins: [null, 0],
      Items: [T0 - 20 * MIN, 3],
      Unusuals: [T0 - 30 * MIN, 2],
    });
  });

  it('is cached: read once per change of the saved prices, not per list call', () => {
    const repo = newRepo();
    page(repo, { fileName: 'hats.html', pageKind: 'buy', fileMtime: T0 - 10 * MIN, importedAt: T0 - 10 * MIN }, [1001, 1002]);
    const h = setup({ repo, schema });
    build(h);
    const batches = vi.spyOn(repo, 'listImportBatches');
    expect(byLabel(h).Hats).toEqual([T0 - 10 * MIN, 2]);
    for (let i = 0; i < 5; i++) h.market.list({ offset: i * 10, limit: 10 }, T0);
    h.market.list({ search: 'item' }, T0);
    expect(batches).toHaveBeenCalledTimes(1);

    // A newly saved weapons page arrives through the import, which calls pricesChanged.
    page(repo, { fileName: 'weapons.html', pageKind: 'buy', fileMtime: T0 - MIN, importedAt: T0 }, [2001, 2002, 2003]);
    expect(byLabel(h).Weapons).toEqual([null, 0]); // not refreshed per call
    expect(batches).toHaveBeenCalledTimes(1);
    h.market.pricesChanged();
    expect(byLabel(h)).toMatchObject({ Hats: [T0 - 10 * MIN, 2], Weapons: [T0 - MIN, 3] });
    expect(batches).toHaveBeenCalledTimes(2);
    h.market.list({}, T0);
    expect(batches).toHaveBeenCalledTimes(2);

    // A list's returned coverage is a copy: changing it changes nothing inside.
    h.market.list({}, T0).scraptf.coverage[0]!.items = 999;
    expect(byLabel(h).Hats).toEqual([T0 - 10 * MIN, 2]);
  });

  it('reads no batches while no saved-page price is stored, and survives a failed read', () => {
    const repo = newRepo();
    repo.upsertScrapPrice({ sku: '1001;6', name: 'Typed', costScrap: 20, source: 'user', observedAt: T0 });
    const h = setup({ repo, schema });
    build(h);
    const batches = vi.spyOn(repo, 'listImportBatches');
    expect(Object.values(byLabel(h))).toEqual(SCRAPTF_BANK_PAGES.map(() => [null, 0]));
    expect(batches).not.toHaveBeenCalled();

    page(repo, { fileName: 'hats.html', pageKind: 'buy', fileMtime: T0 - MIN, importedAt: T0 }, [1001]);
    batches.mockImplementation(() => {
      throw new Error('database is locked');
    });
    h.market.pricesChanged();
    const r = h.market.list({}, T0);
    expect(r.scraptf.coverage).toHaveLength(SCRAPTF_BANK_PAGES.length);
    expect(r.scraptf.coverage.every((c) => c.lastSavedAt === null)).toBe(true);
    expect(h.log.lines.some((l) => l.level === 'warn' && /saved pages/.test(l.msg))).toBe(true);

    // The failure is not cached: once the database answers again, the next list shows the page,
    // without waiting for a price write.
    batches.mockRestore();
    expect(byLabel(h).Hats).toEqual([T0 - MIN, 1]);
  });

  it('keeps the last good strip while a read fails, retries on every list, and logs once per failure streak', () => {
    const repo = newRepo();
    page(repo, { fileName: 'hats.html', pageKind: 'buy', fileMtime: T0 - 10 * MIN, importedAt: T0 - 10 * MIN }, [1001, 1002]);
    const h = setup({ repo, schema });
    build(h);
    expect(byLabel(h).Hats).toEqual([T0 - 10 * MIN, 2]);

    page(repo, { fileName: 'weapons.html', pageKind: 'buy', fileMtime: T0 - MIN, importedAt: T0 }, [2001, 2002, 2003]);
    const real = repo.listImportBatches.bind(repo);
    let failing = true;
    const batches = vi.spyOn(repo, 'listImportBatches').mockImplementation((n) => {
      if (failing) throw new Error('database is locked');
      return real(n);
    });
    h.market.pricesChanged();
    h.clock.advance(60 * MIN);
    for (let i = 0; i < 5; i++) expect(byLabel(h)).toMatchObject({ Hats: [T0 - 10 * MIN, 2], Weapons: [null, 0] });
    expect(batches).toHaveBeenCalledTimes(5);
    expect(h.log.lines.filter((l) => l.level === 'warn' && /saved pages/.test(l.msg))).toHaveLength(1);

    failing = false;
    expect(byLabel(h)).toMatchObject({ Hats: [T0 - 10 * MIN, 2], Weapons: [T0 - MIN, 3] });
    // Cached again once read.
    byLabel(h);
    expect(batches).toHaveBeenCalledTimes(6);
  });
});
