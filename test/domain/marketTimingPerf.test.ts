// 0.8 (T7, R-3): the Live market's page with the buy-timing join on, at the design scale of the user's saves: 8 banks x
// 250 saves of two pages x 300 rows (as scraptfLifecyclePerf.test.ts builds them) in the real scrap.tf history, and a
// market whose every row is a copy those saves list now, so each row of a page asks history.timingForBase. TIMED
// (vitest.config.ts): the bounds assume an otherwise idle CPU (the group runs one file at a time, after the rest);
// each timed figure is the best of several runs, so one busy moment on the machine does not decide it. The saves are
// served by an in-memory stand-in for the repo's two save reads (pages the user saved, R10); no network, no scrap.tf.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import type { BankStockThinSave } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { BankStockStored, Listing, ScraptfBank } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, silentLogger } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const SAVES = 250;
const ROWS = 300;

/** Best of `n` runs of `fn`, in ms. */
function bestOf(n: number, fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/**
 * One bank's SAVES hourly saves up to T0, alternating two pages of ROWS rows: items rotate in and out (6 new and 6
 * gone per save of a page), reprice down on their own period, sometimes up, and are single cards with steady ids.
 * Returns the saves and the base SKUs on sale on each page's newest save.
 */
function bankSaves(bank: ScraptfBank, b: number, firstBatch: number): { index: BankStockThinSave[]; rows: Map<number, BankStockStored[]>; onSale: Set<string> } {
  const index: BankStockThinSave[] = [];
  const rows = new Map<number, BankStockStored[]>();
  const pages = bank === 'list' ? ['/items', '/items/2'] : [`/buy/${bank}`, `/buy/${bank}/2`];
  const newest = new Map<string, string[]>();
  for (let s = 0; s < SAVES; s++) {
    const p = s % 2;
    const out: BankStockStored[] = [];
    for (let j = 0; j < ROWS; j++) {
      const id = 10_000 + b * 1_000_000 + Math.floor(s / 2) * 6 + j + p * 100_000;
      const price = 200 + (id % 50) * 7 - Math.floor(s / (5 + (id % 11))) + (s % 37 === 36 ? 3 : 0);
      out.push({ sku: `${id};6`, specialKey: '', name: `Item ${id}`, costKeys: 0, costScrap: Math.max(1, price), stock: id % 9 === 0 ? 2 : 1, assetId: `a${b}-${id}` });
    }
    const batchId = firstBatch + s;
    index.push({ batchId, savedAt: T0 - 10 * MIN - (SAVES - 1 - s) * HOUR, bank, page: pages[p]! });
    rows.set(batchId, out);
    newest.set(pages[p]!, out.map((r) => r.sku));
  }
  return { index, rows, onSale: new Set([...newest.values()].flat()) };
}

describe('Live market with the buy-timing join (TIMED)', () => {
  it("a page and the 2,000-row window refresh join every row's verdict within the bounds at 8 banks x 250 saves", () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });

    // The saves, oldest first per bank (the save index's order).
    const index: BankStockThinSave[] = [];
    const saveRows = new Map<number, BankStockStored[]>();
    const onSale = new Set<string>();
    SCRAPTF_BANKS.forEach((info, b) => {
      const one = bankSaves(info.bank, b, (b + 1) * 10_000);
      index.push(...one.index);
      for (const [id, r] of one.rows) saveRows.set(id, r);
      for (const sku of one.onSale) onSale.add(sku);
    });
    expect(index.length).toBe(SCRAPTF_BANKS.length * SAVES);

    // A buyer for every copy on sale now, so every market row is one the saves list.
    const listings: Listing[] = [];
    let i = 0;
    for (const sku of onSale) {
      const v = 250 + (i % 300);
      listings.push(
        makeListing({ id: `a${i}`, sku, baseSku: sku, steamid: `A${i % 997}`, metalScrap: v, isBot: i % 2 === 0, lastEventAt: T0 - (i % 30) * MIN }),
        makeListing({ id: `b${i}`, sku, baseSku: sku, steamid: `B${i % 991}`, metalScrap: v - 4 }),
      );
      i++;
    }
    repo.upsertListings(listings);

    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
    const schema = createStubSchema({ items: [], categoryOf: (d) => (d % 3 === 0 ? 'hats' : d % 3 === 1 ? 'weapons' : 'other'), nameOf: (s) => `Item ${s}` });
    let history!: ScraptfHistory;
    let joins = 0;
    const market = createMarketIndex({
      ...makeDeps(repo, clock, () => settings),
      schema,
      timers,
      keyPrice,
      onChanged: () => undefined,
      folderWatchActive: () => false,
      // As core wires it (the page's inputs pass through).
      history: {
        listedSinceFor: (b, bank) => history.listedSinceFor(b, bank),
        listedFor: (b, bank) => history.listedFor(b, bank),
        version: () => history.version(),
        timingForBase: (base, bank, buy, now, inputs) => {
          joins++;
          return history.timingForBase(base, bank, buy, now, inputs);
        },
      },
    });
    history = createScraptfHistory({
      clock,
      log: silentLogger,
      repo: {
        bankStockSaveIndex: () => index,
        bankStockRowsOf: (ids) => new Map(ids.map((id) => [id, saveRows.get(id) ?? []])),
        insertScraptfEvents: () => 0,
        scraptfEvents: () => [],
      },
      market,
      keyPrice,
      profit: () => settings.profit,
    });
    market.start();
    timers.advance(0);
    expect(market.stats()).toMatchObject({ entries: onSale.size, building: false });

    // Cold: the first page loads the saves and builds each bank's lifecycle on first use.
    const tc = performance.now();
    const cold = market.list({ limit: 500 }, clock.now());
    const coldMs = performance.now() - tc;
    expect(cold.rows).toHaveLength(500);
    expect(joins).toBe(500);
    // The join ran: rows of the 7 bank pages carry a verdict (the /items rows are family rows: none).
    expect(cold.rows.filter((r) => r.scraptfTiming !== undefined).length).toBeGreaterThan(250);

    // Warm: one default page (the select pass kept, so this times the join itself).
    joins = 0;
    const pageMs = bestOf(5, () => market.list({}, clock.now()));
    expect(joins).toBe(5 * 200);

    // A live refresh of a full 2,000-row window after a change: four 500-row pages, one pass, the join on each row.
    let window = 0;
    const refreshMs = bestOf(3, () => {
      const sku = [...onSale][window++ % onSale.size]!;
      repo.upsertListings([makeListing({ id: `w${window}`, sku, baseSku: sku, steamid: `W${window}`, metalScrap: 400 + window, lastEventAt: clock.now() })]);
      market.markDirty([sku]);
      timers.advance(2_000);
      joins = 0;
      let timed = 0;
      for (let offset = 0; offset < 2_000; offset += 500) timed += market.list({ limit: 500, offset }, clock.now()).rows.filter((r) => r.scraptfTiming !== undefined).length;
      expect(joins).toBe(2_000);
      expect(timed).toBeGreaterThan(1_000);
    });
    console.info(`[perf] market + timing join (8 banks x ${SAVES} saves): cold page ${coldMs.toFixed(0)} ms; page ${pageMs.toFixed(1)} ms; 2,000-row window refresh ${refreshMs.toFixed(1)} ms`);

    // The cold page builds 8 lifecycles (about 0.1-0.3 s each alone); the warm reads stay in memory.
    expect(coldMs).toBeLessThan(15_000);
    expect(pageMs).toBeLessThan(250);
    expect(refreshMs).toBeLessThan(500);
  }, 120_000);
});
