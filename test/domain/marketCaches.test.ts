// Live market index read costs (F10): one filter-and-sort pass serves every page
// of a window refresh and is never served stale, and a rebuild that cannot change
// a rule estimate keeps the estimates. The shared verdict helper and the rule
// matcher are wrapped to count calls (their results are the real ones). Real
// in-memory repo, fake clock and timers; nothing here touches the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { MARKET_DIRTY_BATCH_MS, createMarketIndex } from '../../src/service/domain/market';
import { MARKET_WINDOW_MAX, createMarketWindow, type MarketWindowData } from '../../src/renderer/marketModel';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { Listing, MarketQuery, Settings } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing } from './helpers';

const calls = vi.hoisted(() => ({ verdict: 0, rules: 0 }));

vi.mock('../../src/shared/market', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/market')>();
  return {
    ...actual,
    marketVerdict: (...a: Parameters<typeof actual.marketVerdict>) => {
      calls.verdict++;
      return actual.marketVerdict(...a);
    },
  };
});

vi.mock('../../src/service/domain/matcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/service/domain/matcher')>();
  return {
    ...actual,
    ruleMatches: (...a: Parameters<typeof actual.ruleMatches>) => {
      calls.rules++;
      return actual.ruleMatches(...a);
    },
  };
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

/** `n` plain bases with one order each, a few typed prices, and names the test can change. */
function setup(n: number) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const bases = Array.from({ length: n }, (_, i) => `${100_000 + i};6`);
  repo.upsertListings(bases.map((sku, i) => buy(sku, 20 + (i % 40), { id: `l${i}`, steamid: `S${i}` })));
  for (let i = 0; i < n; i += 50) repo.upsertScrapPrice({ sku: bases[i]!, name: 'x', costScrap: 25, source: 'user', observedAt: T0 - i });
  const names = new Map<string, string>();
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, {}) as Settings };
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings.current),
    schema: createStubSchema({ items: [], categoryOf: () => 'hats', nameOf: (s) => names.get(s) ?? `Item ${s}` }),
    timers,
    keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now()),
    onChanged: () => undefined,
    folderWatchActive: () => false,
  });
  market.start();
  timers.advance(0);
  expect(market.stats().building).toBe(false);
  return { repo, clock, timers, settings, market, bases, names };
}

describe('one pass per window refresh', () => {
  it('serves a 2,000-row window refresh from one request and one filter-and-sort pass', async () => {
    const h = setup(3_000);
    const list = vi.fn((q: MarketQuery) => Promise.resolve(h.market.list(q, h.clock.now())));
    const data: MarketWindowData[] = [];
    const w = createMarketWindow(list, { data: (d) => data.push(d), error: () => undefined, moreError: () => undefined, busy: () => undefined });
    w.setQuery({ sort: 'ceiling', dir: 'desc' });
    await flush();
    while (data.at(-1)!.result.rows.length < MARKET_WINDOW_MAX) {
      w.loadMore();
      await flush();
    }
    const total = data.at(-1)!.result.total;
    expect(total).toBe(3_000);

    // A live change: one order moves, the index re-evaluates its base.
    h.repo.upsertListings([buy(h.bases[7]!, 90, { id: 'l7', steamid: 'S7' })]);
    h.market.markDirty([h.bases[7]!]);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);

    list.mockClear();
    calls.verdict = 0;
    w.refresh();
    await flush();
    // The whole 2,000-row window is one market.list call (H2).
    expect(list).toHaveBeenCalledTimes(1);
    // Every row's verdict once: one pass, not one per page.
    expect(calls.verdict).toBe(total);
    // ...and the change is in it (the pass after a change is a fresh one).
    const refreshed = data.at(-1)!.result.rows;
    expect(refreshed.map((r) => r.sku)).toEqual(h.market.all({ sort: 'ceiling', dir: 'desc' }, h.clock.now()).slice(0, MARKET_WINDOW_MAX).map((r) => r.sku));
    expect(refreshed.find((r) => r.sku === h.bases[7])!.revenueScrap).toBe(90);
  });

  it('never serves a stale pass: every change the rows read starts a new one', () => {
    const h = setup(300);
    const sku = h.bases[3]!;
    const rowOf = () => h.market.list({ limit: 500 }, h.clock.now()).rows.find((r) => r.sku === sku)!;
    const first = rowOf();
    calls.verdict = 0;
    expect(rowOf()).toEqual(first);
    expect(calls.verdict).toBe(0); // nothing changed: the same pass

    // A book change (re-evaluated entry).
    h.repo.upsertListings([buy(sku, 70, { id: 'l3', steamid: 'S3' })]);
    h.market.markDirty([sku]);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(rowOf().revenueScrap).toBe(70);

    // A typed price (the user's side).
    h.repo.upsertScrapPrice({ sku, name: 'x', costScrap: 30, source: 'user', observedAt: T0 });
    h.market.pricesChanged();
    expect(rowOf()).toMatchObject({ knownCostScrap: 30, knownSource: 'typed' });

    // A rule (read on the next pass after pricesChanged).
    h.repo.upsertRule({ name: 'All', filter: {}, costScrap: 7, observedAt: T0 });
    h.market.pricesChanged();
    expect(h.market.list({ limit: 500 }, h.clock.now()).rows.find((r) => r.sku === h.bases[4])!.ruleCostScrap).toBe(7);

    // Friction changes every profit at once, without a rebuild.
    const before = rowOf().profitScrap!;
    h.settings.current = mergeSettings(h.settings.current, { profit: { frictionScrap: h.settings.current.profit.frictionScrap + 3 } });
    expect(rowOf().profitScrap).toBe(before - 3);

    // The key price is part of a key-priced row's value.
    h.repo.upsertScrapPrice({ sku, name: 'x', costKeys: 1, costScrap: 0, source: 'user', observedAt: T0 + 1 });
    h.market.pricesChanged();
    const k1 = rowOf().knownCostScrap!;
    h.repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 600, sellScrap: 603, observedAt: T0 + 1 });
    expect(rowOf().knownCostScrap).not.toBe(k1);
  });
});

describe('rule estimates across rebuilds', () => {
  it('keeps every estimate through a rebuild that cannot change one, and re-matches only renamed items', () => {
    const h = setup(2_000);
    for (let i = 0; i < 6; i++) h.repo.upsertRule({ name: `Nothing ${i}`, filter: { nameContains: `zzz${i}` }, costScrap: 10 + i, observedAt: T0 });
    h.repo.upsertRule({ name: 'Golden', filter: { nameContains: 'golden' }, costScrap: 5, observedAt: T0 });
    // A known-only row: a typed price for an item nobody buys.
    h.repo.upsertScrapPrice({ sku: '300000;6', name: 'x', costScrap: 25, source: 'user', observedAt: T0 });
    h.market.pricesChanged();
    // Fills every estimate (each row scans the rules once; rows with a price of their own on output).
    h.market.all({}, h.clock.now());
    calls.rules = 0;

    // The prices jobs, maintenance, a settings commit or a key move: a full rebuild.
    h.market.markAllDirty();
    h.timers.advance(0);
    expect(h.market.stats().building).toBe(false);
    const after = h.market.list({}, h.clock.now());
    expect(after.total).toBe(2_001);
    expect(calls.rules).toBe(0);

    // A schema update renames one item with orders and the known-only one: only those are matched again.
    h.names.set(h.bases[5]!, 'Golden Item');
    h.names.set('300000;6', 'Golden Hat');
    h.market.markAllDirty();
    h.timers.advance(0);
    calls.rules = 0;
    const all = h.market.all({}, h.clock.now());
    expect(all.find((r) => r.sku === h.bases[5])).toMatchObject({ name: 'Golden Item', ruleCostScrap: 5, verdict: 'rule-flip' });
    expect(all.find((r) => r.sku === '300000;6')).toMatchObject({ name: 'Golden Hat', ruleCostScrap: 5 });
    expect(all.find((r) => r.sku === h.bases[6])!.ruleCostScrap).toBeNull();
    expect(calls.rules).toBeLessThanOrEqual(2 * 7);
  });
});
