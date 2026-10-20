// Audit r4-tests-1 (0.7.3): the Live market index ends a slice once it has used MARKET_SLICE_MS of real
// time (performance.now()), so a harness on fake timers that counts the first build's change pushes could
// see the build split into more slices, and pushes, whenever the CPU was loaded (holdings "at most 3 per
// batch", marketHooks onBasesChanged). The index now takes an optional slice clock (sliceNow); the app keeps
// performance.now(). Real in-memory repo, fake clock and timers; nothing here touches the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { MARKET_NOTIFY_MS, MARKET_SLICE_MS, createMarketIndex } from '../../src/service/domain/market';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

const BASES = ['126;6', '205;6', '378;6', '5039;6', '5040;6'];

/** A started index over one buyer per base, with its change pushes and the bases behind each. */
function world(sliceNow?: () => number) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  repo.upsertListings(BASES.map((sku, i) => makeListing({ id: `b${i}`, sku, baseSku: sku, steamid: `S${i}`, metalScrap: 30 + i, lastEventAt: T0 - MIN })));
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const changes: { changed: number; total: number }[] = [];
  const bases: number[] = [];
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    schema: createStubSchema(),
    timers,
    keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings, clock.now()),
    onChanged: (p) => changes.push({ changed: p.changed, total: p.total }),
    onBasesChanged: (b) => bases.push(b.size),
    folderWatchActive: () => false,
    ...(sliceNow ? { sliceNow } : {}),
  });
  market.start();
  timers.advance(0);
  expect(market.stats()).toMatchObject({ building: false, entries: BASES.length });
  return { timers, changes, bases };
}

/** A wall clock on a loaded CPU: every read is a slice budget and more past the last one. */
function slowWallClock(): void {
  let wall = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (wall += MARKET_SLICE_MS + 10));
}

describe('the Live market slice clock (sliceNow)', () => {
  it('keeps the first build one slice and one push under a constant slice clock, however slow the wall clock', () => {
    slowWallClock();
    const h = world(() => 0);
    expect(h.changes).toEqual([{ changed: BASES.length, total: BASES.length }]);
    expect(h.bases).toEqual([BASES.length]);
  });

  it('ends each slice by the injected clock: one base per slice when every read is past the budget', () => {
    let t = 0;
    const h = world(() => (t += MARKET_SLICE_MS + 10));
    // The first slice pushes at once; the other four wait out the 2 s throttle together.
    expect(h.changes).toEqual([{ changed: 1, total: 1 }]);
    h.timers.advance(MARKET_NOTIFY_MS);
    expect(h.changes).toEqual([
      { changed: 1, total: 1 },
      { changed: BASES.length - 1, total: BASES.length },
    ]);
    expect(h.bases).toEqual([1, BASES.length - 1]);
  });

  it('defaults to performance.now(), as the app runs it', () => {
    slowWallClock();
    const h = world();
    expect(h.changes).toEqual([{ changed: 1, total: 1 }]);
    h.timers.advance(MARKET_NOTIFY_MS);
    expect(h.changes.map((c) => c.changed)).toEqual([1, BASES.length - 1]);
  });
});
