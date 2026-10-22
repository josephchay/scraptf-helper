// F20 in the Live market index: MarketRow.scraptfListedSince is joined per read from the scrap.tf
// history's runs of the bank the row links to (its 'seen' bank, F19), MarketQuery.listedOnScraptf
// ("Listed on scrap.tf > 24 h") narrows rows and verdict counts by the shared rule, and its cached pass
// follows the history's version and the clock. Real in-memory repo, real index, bank stock cache and
// history, fake clock and timers. Saves are pages the user saved (R10); no network, nothing to scrap.tf.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex, marketCategoryOf, type MarketIndex, type MarketIndexDeps } from '../../src/service/domain/market';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { emptyMarketCounts } from '../../src/shared/market';
import { SCRAPTF_LONG_LISTED_MS, marketListedSideMatches, scraptfListedSinceOf } from '../../src/shared/scraptfHistory';
import { scraptfTimingBrief } from '../../src/shared/scraptfTiming';
import type { BankStockStored, Listing, MarketQuery, MarketRow, ScraptfBank, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, silentLogger } from './helpers';

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
  vi.restoreAllMocks();
});

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[], page = bank === 'list' ? '/items' : `/buy/${bank}`): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows, page);
  return id;
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  market: MarketIndex;
  stock: BankStock;
  history: ScraptfHistory;
  build(): void;
  rows(q?: MarketQuery, now?: UnixMs): MarketRow[];
  row(sku: string): MarketRow | undefined;
  /** bankStockChanged as core runs it: both caches re-read the saves. */
  changed(): void;
}

/** `dep`: undefined wires the real history as core does; null wires none (0.6). */
function setup(dep?: MarketIndexDeps['history'] | null): Harness {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const schema = createStubSchema();
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
  let stock!: BankStock;
  let history!: ScraptfHistory;
  const wired: MarketIndexDeps['history'] =
    dep === undefined ? { listedSinceFor: (b, bank) => history.listedSinceFor(b, bank), version: () => history.version() } : (dep ?? undefined);
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    bankStock: { newAtFor: (b) => stock.newAtFor(b), version: () => stock.version(), seenFor: (b) => stock.seenFor(b) },
    ...(wired ? { history: wired } : {}),
  });
  stock = createBankStock({ clock, log: silentLogger, repo, market, keyPrice, settings: () => settings, categoryOf: (sku) => marketCategoryOf(schema, sku) });
  history = createScraptfHistory({ clock, log: silentLogger, repo, market, keyPrice });
  return {
    repo,
    clock,
    market,
    stock,
    history,
    build() {
      market.start();
      timers.advance(0);
      expect(market.stats().building).toBe(false);
    },
    rows: (q = {}, now = clock.now()) => market.all(q, now),
    row: (sku) => market.all({}, clock.now()).find((r) => r.sku === sku),
    changed() {
      stock.refresh();
      history.refresh();
    },
  };
}

/** Buyers for two hats and a rocket launcher; hats listed for 3 days, the launcher on the /items list for an hour. */
function seed(repo: Repo): void {
  repo.upsertListings([
    ...['a', 'b', 'c'].map((x, i) => buy('378;6', 120 - i, { id: `tc-${x}`, steamid: `TC${x}` })),
    buy('126;6', 60, { id: 'bh', steamid: 'BH' }),
    buy('205;6', 45, { id: 'rl', steamid: 'RL' }),
    buy('5021;6', 600, { id: 'key', steamid: 'KEY' }),
  ]);
  save(repo, 'hats', T0 - 3 * DAY, [s('378;6', 40), s('126;6', 30)]);
  save(repo, 'hats', T0 - 10 * MIN, [s('378;6', 40), s('126;6', 30)]);
  save(repo, 'list', T0 - HOUR, [s('205;6', 20)]);
}

describe('MarketRow.scraptfListedSince (F20)', () => {
  it('is the runs of the bank the row links to, joined per read; null when no save lists it', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    const tc = h.row('378;6')!;
    expect(tc.scraptfLink).toMatchObject({ bank: 'hats', source: 'seen' });
    expect(tc.scraptfListedSince).toBe(T0 - 3 * DAY);
    expect(h.row('205;6')).toMatchObject({ scraptfLink: { bank: 'list', source: 'seen' }, scraptfListedSince: T0 - HOUR });
    for (const r of h.rows()) {
      const want = r.scraptfLink.source === 'seen' ? scraptfListedSinceOf(h.history.runsFor(r.scraptfLink.bank), r.sku) : null;
      expect(r.scraptfListedSince, r.sku).toBe(want);
    }
    // list() pages carry it as all() does.
    expect(h.market.list({ limit: 50 }, T0).rows.find((r) => r.sku === '378;6')!.scraptfListedSince).toBe(T0 - 3 * DAY);
  });

  it('reads no repo per row once the history is loaded', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    h.rows();
    const index = vi.spyOn(h.repo, 'bankStockSaveIndex');
    const rows = vi.spyOn(h.repo, 'bankStockRowsOf');
    for (let i = 0; i < 5; i++) {
      h.rows();
      h.rows({ listedOnScraptf: true }, T0 + i * MIN);
    }
    expect(index).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
  });

  it('follows a new save once the history refreshed, without a market rebuild', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    const fullAt = h.market.stats().lastFullAt;
    // The hats bank sold out of Bill's Hat: no longer listed there.
    save(h.repo, 'hats', T0 - 5 * MIN, [s('378;6', 40)]);
    h.changed();
    expect(h.row('126;6')!.scraptfListedSince).toBeNull();
    expect(h.row('378;6')!.scraptfListedSince).toBe(T0 - 3 * DAY);
    expect(h.market.stats().lastFullAt).toBe(fullAt);
  });

  it('is null without a history (0.6 wiring) or when it fails, and never throws', () => {
    const none = setup(null);
    seed(none.repo);
    none.build();
    expect(none.rows().every((r) => r.scraptfListedSince === null)).toBe(true);
    expect(none.rows({ listedOnScraptf: true })).toEqual([]);
    const broken = setup({
      listedSinceFor: () => {
        throw new Error('boom');
      },
      version: () => {
        throw new Error('boom');
      },
    });
    seed(broken.repo);
    broken.build();
    expect(broken.rows().every((r) => r.scraptfListedSince === null)).toBe(true);
    expect(broken.market.list({ listedOnScraptf: true }, T0).total).toBe(0);
  });
});

describe('MarketQuery.listedOnScraptf ("Listed on scrap.tf > 24 h")', () => {
  it('keeps only rows listed for 24 h or more, and counts verdicts over them, as the shared rule says', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    const all = h.rows();
    const only = h.market.list({ listedOnScraptf: true }, T0);
    expect(only.rows.map((r) => r.sku).sort()).toEqual(['126;6', '378;6']);
    expect(only.rows.map((r) => r.sku)).toEqual(all.filter((r) => marketListedSideMatches(r, { listedOnScraptf: true }, T0)).map((r) => r.sku));
    const counts = emptyMarketCounts();
    for (const r of only.rows) counts[r.verdict]++;
    expect(only.counts).toEqual(counts);
    expect(h.market.list({ listedOnScraptf: false }, T0).total).toBe(all.length);
    // It combines with the other source filters.
    expect(h.rows({ listedOnScraptf: true, newOnScraptf: true })).toEqual([]);
  });

  it('measures to the newest sighting, not the clock (0.7.1, DM-5): a save a day on joins a row, time alone never does', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    // The list was saved once, an hour ago: listed for 0 however long ago that save is.
    const before = T0 - HOUR + SCRAPTF_LONG_LISTED_MS - MIN;
    expect(h.rows({ listedOnScraptf: true }, before).map((r) => r.sku).sort()).toEqual(['126;6', '378;6']);
    expect(h.rows({ listedOnScraptf: true }, T0 + 30 * DAY).map((r) => r.sku).sort()).toEqual(['126;6', '378;6']);
    expect(h.row('205;6')).toMatchObject({ scraptfListedSince: T0 - HOUR, scraptfLastSeenAt: T0 - HOUR });
    // Saved again a minute short of a day later: still short. A minute on, listed for a day.
    h.clock.advance(SCRAPTF_LONG_LISTED_MS);
    save(h.repo, 'list', T0 - HOUR + SCRAPTF_LONG_LISTED_MS - MIN, [s('205;6', 20)]);
    h.changed();
    expect(h.rows({ listedOnScraptf: true }).map((r) => r.sku).sort()).toEqual(['126;6', '378;6']);
    save(h.repo, 'list', T0 - HOUR + SCRAPTF_LONG_LISTED_MS, [s('205;6', 20)]);
    h.changed();
    expect(h.rows({ listedOnScraptf: true }).map((r) => r.sku).sort()).toEqual(['126;6', '205;6', '378;6']);
  });

  it('reads the run and its sighting from history.listedFor when wired (0.7.1)', () => {
    let history!: ScraptfHistory;
    const h = setup({
      listedSinceFor: (b, bank) => history.listedSinceFor(b, bank),
      listedFor: (b, bank) => history.listedFor(b, bank),
      version: () => history.version(),
    });
    history = h.history;
    seed(h.repo);
    h.build();
    expect(h.row('378;6')).toMatchObject({ scraptfListedSince: T0 - 3 * DAY, scraptfLastSeenAt: T0 - 10 * MIN });
    expect(h.row('205;6')).toMatchObject({ scraptfListedSince: T0 - HOUR, scraptfLastSeenAt: T0 - HOUR });
    expect(h.rows({ listedOnScraptf: true }, T0 + 30 * DAY).map((r) => r.sku).sort()).toEqual(['126;6', '378;6']);
  });

  it('re-filters its cached pass after a history refresh, and only then', () => {
    const h = setup();
    seed(h.repo);
    h.build();
    expect(h.rows({ listedOnScraptf: true }).map((r) => r.sku).sort()).toEqual(['126;6', '378;6']);
    save(h.repo, 'hats', T0 - 5 * MIN, [s('378;6', 40)]);
    // Not refreshed: the history (and so the pass keyed on its version) still says the old.
    expect(h.rows({ listedOnScraptf: true }).map((r) => r.sku).sort()).toEqual(['126;6', '378;6']);
    h.history.refresh();
    expect(h.rows({ listedOnScraptf: true }).map((r) => r.sku)).toEqual(['378;6']);
  });
});

describe('MarketRow.scraptfTiming (0.8, T7)', () => {
  /** The history core wires (with deps.profit), behind the market's history dep with timingForBase. */
  function timed(timingForBase?: (...a: Parameters<ScraptfHistory['timingForBase']>) => ReturnType<ScraptfHistory['timingForBase']>) {
    let real!: ScraptfHistory;
    const calls: Parameters<ScraptfHistory['timingForBase']>[] = [];
    const h = setup({
      listedSinceFor: (b, bank) => real.listedSinceFor(b, bank),
      listedFor: (b, bank) => real.listedFor(b, bank),
      version: () => real.version(),
      timingForBase: (...a) => {
        calls.push(a);
        return (timingForBase ?? real.timingForBase)(...a);
      },
    });
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    real = createScraptfHistory({ clock: h.clock, log: silentLogger, repo: h.repo, market: h.market, keyPrice: () => selectKeyPrice(h.repo.keyQuotes(), settings, h.clock.now()), profit: () => settings.profit });
    return { ...h, real, calls };
  }

  it("list() joins the listed copy's verdict from timingForBase (the row's 'seen' bank and own entry); all() never does", () => {
    const h = timed();
    seed(h.repo);
    h.build();
    const now = h.clock.now();
    const page = h.market.list({ limit: 50 }, now).rows;
    const tc = page.find((r) => r.sku === '378;6')!;
    const t = h.real.timingForBase('378;6', 'hats', h.market.entryFor('378;6'), now);
    expect(t).not.toBeNull();
    expect(tc.scraptfTiming).toEqual(scraptfTimingBrief(t!));
    expect(tc.scraptfTiming).toMatchObject({ bank: 'hats', key: '378;6|', verdict: expect.any(String) as unknown as string });
    // Every row: the bank its listed time reads ('seen'), judged against its own entry at list()'s time.
    for (const r of page) {
      const want = h.real.timingForBase(r.sku, r.scraptfLink.source === 'seen' ? r.scraptfLink.bank : null, h.market.entryFor(r.sku), now);
      expect(r.scraptfTiming, r.sku).toEqual(want ? scraptfTimingBrief(want) : undefined);
    }
    // The /items list's row for every copy (no Craftable proof) is a family row: no verdict.
    expect(page.find((r) => r.sku === '205;6')).not.toHaveProperty('scraptfTiming');
    // The CSV path and the banks cards ask nothing.
    h.calls.length = 0;
    expect(h.rows().every((r) => r.scraptfTiming === undefined)).toBe(true);
    h.market.uncheckedBy(() => 'all', 5, now);
    expect(h.calls).toEqual([]);
  });

  it("list() hands every row's verdict the page's own key price and profit settings (no key-price query per row)", () => {
    const h = timed();
    seed(h.repo);
    h.build();
    const now = h.clock.now();
    const res = h.market.list({ limit: 50 }, now);
    expect(h.calls.length).toBe(res.rows.length);
    for (const c of h.calls) expect(c[4]).toEqual({ keyScrap: res.keyPrice!.valueScrap, profit: DEFAULT_SETTINGS.profit });
    // The same verdicts the history gives when it reads both itself.
    for (const r of res.rows) {
      const want = h.real.timingForBase(r.sku, r.scraptfLink.source === 'seen' ? r.scraptfLink.bank : null, h.market.entryFor(r.sku), now);
      expect(r.scraptfTiming, r.sku).toEqual(want ? scraptfTimingBrief(want) : undefined);
    }
  });

  it('a failing timingForBase leaves the field out and the page reads', () => {
    const h = timed(() => {
      throw new Error('history down');
    });
    seed(h.repo);
    h.build();
    const page = h.market.list({ limit: 50 }, h.clock.now());
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.scraptfTiming === undefined)).toBe(true);
    expect(h.calls.length).toBeGreaterThan(0);
  });
});
