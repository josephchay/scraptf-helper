// Live market index at live-book scale: about 50k base SKUs with buy orders.
// The rebuild runs in short synchronous slices and a list() over every entry
// (filter, verdict counts, sort, one page) stays fast. Bounds are generous for
// CI (like test/db/perf.test.ts); the measured times are printed. TIMED
// (vitest.config.ts): the bounds assume an otherwise idle CPU; the group runs one
// file at a time within one vitest process, but another vitest or build on the
// same machine still shares the CPU, so each list figure is a best of several.
// No history is wired here, so this file never times the 0.8 buy-timing join
// (MarketRow.scraptfTiming): marketTimingPerf.test.ts bounds that at the saves'
// design scale.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { Listing, MarketQuery } from '../../src/shared/types';
import type { TimerApi } from '../../src/service/net/ratelimit';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** FakeTimers that time each callback, i.e. each synchronous slice of the index. */
class TimedTimers implements TimerApi {
  readonly slices: number[] = [];
  private readonly inner: FakeTimers;
  constructor(clock: FakeClock) {
    this.inner = new FakeTimers(clock);
  }
  setTimeout = (fn: () => void, ms: number): unknown =>
    this.inner.setTimeout(() => {
      const t = performance.now();
      fn();
      this.slices.push(performance.now() - t);
    }, ms);
  clearTimeout = (h: unknown): void => this.inner.clearTimeout(h);
  advance(ms: number): void {
    this.inner.advance(ms);
  }
}

describe('performance', () => {
  it('builds 50k base SKUs in short slices and lists them in well under the bound', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
    const N = 50_000;
    const listings: Listing[] = [];
    for (let i = 0; i < N; i++) {
      const sku = `${100_000 + i};6`;
      const v = 5 + (i % 60);
      listings.push(
        makeListing({ id: `a${i}`, sku, baseSku: sku, steamid: `A${i % 997}`, metalScrap: v, isBot: i % 2 === 0, lastEventAt: T0 - (i % 30) * HOUR }),
        makeListing({ id: `b${i}`, sku, baseSku: sku, steamid: `B${i % 991}`, metalScrap: v - 2, details: i % 7 === 0 ? 'clean only' : '' }),
      );
    }
    repo.upsertListings(listings);
    for (let i = 0; i < 1000; i++) {
      repo.upsertScrapPrice({ sku: `${100_000 + i * 50};6`, name: `Item ${i}`, costScrap: 20, source: i % 2 ? 'user' : 'import', observedAt: T0 - i * MIN, stock: 3 });
    }
    repo.upsertRule({ name: 'Hats', filter: { categories: ['hats'], qualities: [6], craftable: true }, costScrap: 45, observedAt: T0 });
    repo.upsertRule({ name: 'Weapons', filter: { categories: ['weapons'] }, costScrap: 40, observedAt: T0 });

    const clock = new FakeClock();
    const timers = new TimedTimers(clock);
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    const schema = createStubSchema({ items: [], categoryOf: (d) => (d % 3 === 0 ? 'hats' : d % 3 === 1 ? 'weapons' : 'other'), nameOf: (s) => `Item ${s}` });
    let pushes = 0;
    const market = createMarketIndex({
      ...makeDeps(repo, clock, () => settings),
      schema,
      timers,
      keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings, clock.now()),
      onChanged: () => {
        pushes++;
      },
      folderWatchActive: () => false,
    });

    const t0 = performance.now();
    market.start();
    timers.advance(0);
    const buildMs = performance.now() - t0;
    expect(market.stats()).toMatchObject({ entries: N, building: false });
    expect(pushes).toBe(1);
    const sorted = [...timers.slices].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const max = sorted.at(-1)!;
    console.info(`[perf] market build of ${N}: ${buildMs.toFixed(0)} ms in ${timers.slices.length} slices (median ${median.toFixed(1)} ms, max ${max.toFixed(1)} ms)`);

    // Best of 5, with the queries interleaved: list() keeps its last pass for the next page of the
    // same query, so repeating one query back to back would time that cache, not the pass.
    const timeLists = (qs: [string, MarketQuery][]): { label: string; ms: number; total: number }[] => {
      const out = qs.map(([label]) => ({ label, ms: Number.POSITIVE_INFINITY, total: 0 }));
      for (let rep = 0; rep < 5; rep++) {
        qs.forEach(([, q], i) => {
          const t = performance.now();
          const r = market.list(q, clock.now());
          out[i]!.ms = Math.min(out[i]!.ms, performance.now() - t);
          out[i]!.total = r.total;
        });
      }
      return out;
    };

    // The first read merges every name into the cached order and fills the rule cache.
    const tc = performance.now();
    const first = market.list({}, clock.now());
    const coldMs = performance.now() - tc;
    expect(first.total).toBe(N);
    expect(first.rows).toHaveLength(200);
    expect(first.counts['rule-flip']).toBeGreaterThan(1000);
    expect(first.counts.flip + first.counts.over + first.counts['no-buyers']).toBe(1000);

    // Not starting with the cold read's query, so the first timed call is a fresh pass too.
    const queries: [string, MarketQuery][] = [
      ['name', { sort: 'name' }],
      ['default (ceiling)', {}],
      ['updated asc, offset 10k', { sort: 'updated', dir: 'asc', offset: 10_000, limit: 500 }],
      ['search', { search: 'item 1001' }],
      ['verdicts + category', { verdicts: ['rule-flip', 'flip'], categories: ['hats', 'weapons'] }],
    ];
    const times = timeLists(queries);
    console.info(`[perf] market list: cold ${coldMs.toFixed(0)} ms; ${times.map((t) => `${t.label} ${t.ms.toFixed(1)} ms (${t.total})`).join('; ')}`);

    // A typed price (the common write) re-reads the user's side but keeps the rule estimates warm. Best of 3 writes
    // (each a new price, so each list is a fresh pass), like the queries above: one run on a busy machine decides
    // nothing (a single run read 47-120 ms here with the CPU shared, 306 ms with other vitest runs beside it).
    let writeMs = Number.POSITIVE_INFINITY;
    let afterWrite = first;
    for (let rep = 0; rep < 3; rep++) {
      repo.upsertScrapPrice({ sku: '100001;6', name: 'Item', costScrap: 20 + rep, source: 'user', observedAt: T0 + rep });
      const tw = performance.now();
      market.pricesChanged();
      afterWrite = market.list({}, clock.now());
      writeMs = Math.min(writeMs, performance.now() - tw);
      expect(afterWrite.counts.flip + afterWrite.counts.over + afterWrite.counts['no-buyers']).toBe(1001);
    }
    times.push({ label: 'price write + list', ms: writeMs, total: afterWrite.total });

    // A live refresh of a full 2,000-row window after a change: four 500-row pages, one pass.
    repo.upsertListings([makeListing({ id: 'a7', sku: '100007;6', baseSku: '100007;6', steamid: 'A7', metalScrap: 70, lastEventAt: T0 })]);
    market.markDirty(['100007;6']);
    timers.advance(2_000);
    const tr = performance.now();
    for (let offset = 0; offset < 2_000; offset += 500) market.list({ limit: 500, offset }, clock.now());
    const refreshMs = performance.now() - tr;
    times.push({ label: '2,000-row window refresh', ms: refreshMs, total: N });

    // A rebuild trigger (prices jobs, maintenance, settings) keeps the rule estimates: no refill.
    market.markAllDirty();
    timers.advance(0);
    const ta = performance.now();
    market.list({}, clock.now());
    const afterRebuildMs = performance.now() - ta;
    times.push({ label: 'list after a rebuild', ms: afterRebuildMs, total: N });
    console.info(
      `[perf] market price write + list: ${writeMs.toFixed(1)} ms; 2,000-row window refresh (4 pages): ${refreshMs.toFixed(1)} ms; list after a rebuild: ${afterRebuildMs.toFixed(1)} ms`,
    );

    // Spec target: <= 50 ms for 50k entries; bounds leave room for a loaded CI machine.
    for (const t of times) expect(t.ms, t.label).toBeLessThan(250);
    expect(coldMs).toBeLessThan(2000);
    // Each slice is aimed at ~40 ms; one slow outlier on a busy machine is tolerated.
    expect(median).toBeLessThan(100);
    expect(max).toBeLessThan(500);
    expect(buildMs).toBeLessThan(30_000);
  }, 120_000);
});
