// F20 S3 on the bank stock page (src/service/domain/bankStock.ts with the real scrap.tf history): each
// BankStockRow's listedSince / firstSeenAt / changeSinceListed from the history's runs index (one read
// per list, never a query per row), the 'long-listed' and 'dropped' filters and counts, the 'listed' and
// 'sinceListed' sorts, a multi-page bank, a history that fails, and none at all. Real in-memory repo.
// 0.8: the rows' buy timing and the result's turnover from the same history. Saves are pages the user saved
// (R10); nothing here touches scrap.tf or the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock, type BankStockDeps } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { BANK_STOCK_DROPPING_MIN, bankStockKey } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { scraptfTimingBrief } from '../../src/shared/scraptfTiming';
import type { BankStockQuery, BankStockRow, BankStockStored, KeyPriceState, ScraptfBank, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

function r(sku: string, costScrap: number, stock: number | null = 1): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock, assetId: null };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[], page = `/buy/${bank}`): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows, page);
  return id;
}

interface Harness {
  repo: Repo;
  history: ScraptfHistory;
  stock: BankStock;
  log: ReturnType<typeof recordingLogger>;
  list(q?: Omit<BankStockQuery, 'bank'> & { bank?: ScraptfBank }): ReturnType<BankStock['list']>;
  byKey(q?: Omit<BankStockQuery, 'bank'>): Map<string, BankStockRow>;
}

/** `history`: undefined wires the real one as core does; null wires none (0.6). */
function setup(history?: Pick<ScraptfHistory, 'runsFor'> | null): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const log = recordingLogger();
  const real = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY });
  const stock = createBankStock({
    clock: { now: () => NOW },
    log,
    repo,
    market: { entryFor: () => null },
    keyPrice: () => KEY,
    settings: () => DEFAULT_SETTINGS,
    categoryOf: () => 'hats',
    ...(history === null ? {} : { history: history ?? { runsFor: (bank) => real.runsFor(bank) } }),
  });
  const h: Harness = {
    repo,
    history: real,
    stock,
    log,
    list: (q = {}) => stock.list({ bank: 'hats', limit: 2000, ...q }, NOW),
    byKey: (q = {}) => new Map(h.list(q).rows.map((x) => [x.key, x])),
  };
  return h;
}

/**
 * hats: A listed for 3 days and cheaper since (50 -> 44), B for 3 days and pricier (30 -> 32), C since
 * 2 h at one price, D new 10 min ago, E gone (on sale 2 h ago, absent now).
 */
function seed(repo: Repo): void {
  save(repo, 'hats', NOW - 3 * DAY, [r('1;6', 50), r('2;6', 30)]);
  save(repo, 'hats', NOW - 30 * HOUR, [r('1;6', 48), r('2;6', 30)]);
  save(repo, 'hats', NOW - 2 * HOUR, [r('1;6', 45), r('2;6', 30), r('3;6', 20), r('5;6', 7)]);
  save(repo, 'hats', NOW - 10 * MIN, [r('1;6', 44), r('2;6', 32), r('3;6', 20), r('4;6', 10)]);
}

const key = (sku: string) => bankStockKey(sku, '');

describe('BankStockRow listed fields (F20 S3)', () => {
  it('come from the runs index: listed since, first seen and the change since the run began', () => {
    const h = setup();
    seed(h.repo);
    const rows = h.byKey({ filter: 'all' });
    expect(rows.get(key('1;6'))).toMatchObject({
      change: 'cheaper',
      listedSince: NOW - 3 * DAY,
      firstSeenAt: NOW - 3 * DAY,
      changeSinceListed: { fromScrap: 50, toScrap: 44, deltaScrap: -6, pct: -6 / 50, since: NOW - 3 * DAY },
    });
    expect(rows.get(key('2;6'))!.changeSinceListed).toMatchObject({ fromScrap: 30, toScrap: 32, deltaScrap: 2 });
    expect(rows.get(key('3;6'))).toMatchObject({ listedSince: NOW - 2 * HOUR, changeSinceListed: { deltaScrap: 0, pct: 0 } });
    expect(rows.get(key('4;6'))).toMatchObject({ change: 'new', listedSince: NOW - 10 * MIN, firstSeenAt: NOW - 10 * MIN });
    // A gone row has no current run; it keeps when it was first seen.
    const gone = h.byKey({ filter: 'gone' }).get(key('5;6'))!;
    expect(gone).toMatchObject({ change: 'gone', listedSince: null, changeSinceListed: null, firstSeenAt: NOW - 2 * HOUR });
  });

  it("filters 'long-listed' (24 h, or minListedMs) and 'dropped', counted over the whole bank", () => {
    const h = setup();
    seed(h.repo);
    const res = h.list();
    expect(res.counts).toMatchObject({ longListed: 2, dropped: 1 });
    expect(h.list({ filter: 'long-listed' }).rows.map((x) => x.sku).sort()).toEqual(['1;6', '2;6']);
    expect(h.list({ filter: 'long-listed', minListedMs: HOUR }).rows.map((x) => x.sku).sort()).toEqual(['1;6', '2;6', '3;6']);
    expect(h.list({ filter: 'long-listed', minListedMs: HOUR }).counts.longListed).toBe(3);
    expect(h.list({ filter: 'dropped' }).rows.map((x) => x.sku)).toEqual(['1;6']);
    // The CSV path filters the same way (all() passes the time).
    expect(h.stock.all({ bank: 'hats', filter: 'long-listed' }, NOW).map((x) => x.sku).sort()).toEqual(['1;6', '2;6']);
  });

  it("sorts 'listed' (longest first by default) and 'sinceListed' (biggest drop first)", () => {
    const h = setup();
    seed(h.repo);
    expect(h.list({ sort: 'listed' }).rows.map((x) => x.sku)).toEqual(['1;6', '2;6', '3;6', '4;6']);
    expect(h.list({ sort: 'listed', dir: 'asc' }).rows.map((x) => x.sku)).toEqual(['4;6', '3;6', '1;6', '2;6']);
    expect(h.list({ sort: 'sinceListed' }).rows.map((x) => x.sku)).toEqual(['1;6', '3;6', '4;6', '2;6']);
  });

  it('reads the runs once per list, never per row, and follows a new save once the history refreshed', () => {
    const h = setup();
    seed(h.repo);
    h.list();
    const runs = vi.spyOn(h.history, 'runsFor');
    const index = vi.spyOn(h.repo, 'bankStockSaveIndex');
    const rows = vi.spyOn(h.repo, 'bankStockRowsOf');
    h.list();
    h.list({ filter: 'dropped' });
    expect(runs).toHaveBeenCalledTimes(2);
    expect(index).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
    // 1;6 sells out, then comes back: a new run.
    save(h.repo, 'hats', NOW - 5 * MIN, [r('1;6', 44, 0), r('2;6', 32), r('3;6', 20), r('4;6', 10)]);
    save(h.repo, 'hats', NOW - MIN, [r('1;6', 46), r('2;6', 32), r('3;6', 20), r('4;6', 10)]);
    h.stock.refresh();
    h.history.refresh();
    expect(h.byKey().get(key('1;6'))).toMatchObject({ listedSince: NOW - MIN, firstSeenAt: NOW - 3 * DAY, changeSinceListed: { deltaScrap: 0 } });
  });

  it('a multi-page bank reads its pages together: an item that moved pages keeps its time listed', () => {
    const h = setup();
    save(h.repo, 'list', NOW - 2 * DAY, [r('1;6', 10), r('2;6', 20)], '/items');
    save(h.repo, 'list', NOW - 2 * DAY + MIN, [r('3;6', 30)], '/items/2');
    // Seen on /items/2 before /items was saved again without it: a move, no break.
    save(h.repo, 'list', NOW - HOUR, [r('2;6', 18), r('3;6', 30)], '/items/2');
    save(h.repo, 'list', NOW - HOUR + MIN, [r('1;6', 10)], '/items');
    const rows = new Map(h.list({ bank: 'list' }).rows.map((x) => [x.sku, x]));
    expect(rows.get('2;6')).toMatchObject({ listedSince: NOW - 2 * DAY, changeSinceListed: { fromScrap: 20, toScrap: 18, deltaScrap: -2 } });
    expect(h.list({ bank: 'list', filter: 'dropped' }).rows.map((x) => x.sku)).toEqual(['2;6']);
    // Gone from its home page before it showed elsewhere: that is a break, and a new run.
    save(h.repo, 'list', NOW - 30 * MIN, [r('3;6', 30)], '/items/2');
    save(h.repo, 'list', NOW - 20 * MIN, [r('1;6', 10), r('2;6', 17)], '/items');
    h.stock.refresh();
    h.history.refresh();
    expect(h.list({ bank: 'list' }).rows.find((x) => x.sku === '2;6')).toMatchObject({ listedSince: NOW - 20 * MIN, firstSeenAt: NOW - 2 * DAY });
  });

  it('without a history (0.6) or with one that fails, the fields are null and the rows still read', () => {
    const none = setup(null);
    seed(none.repo);
    expect(none.list().rows.every((x) => x.listedSince === null && x.firstSeenAt === null && x.changeSinceListed === null)).toBe(true);
    expect(none.list().counts).toMatchObject({ longListed: 0, dropped: 0 });
    const broken = setup({
      runsFor: () => {
        throw new Error('history down');
      },
    });
    seed(broken.repo);
    expect(broken.list().rows).toHaveLength(4);
    expect(broken.list().rows.every((x) => x.listedSince === null)).toBe(true);
    expect(broken.log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
  });
});

// F20-DC-1: the F17 cache read each bank's 500 newest saves overall. Thinning keeps up to 300 a page, so
// two busy pages of the list pushed a quiet page (or the save it is compared with) out of that window
// while the history and the feed, which read every kept save, still had it.
describe('a quiet page of a bank whose other pages are saved often', () => {
  /**
   * /items and /items/2 read every 20 s for 100 minutes (the scrap.tf window at its busiest): 300 saves a
   * page, all kept (0.7.1: the last 2 h keeps every save, up to 300 a page).
   */
  function busy(repo: Repo): void {
    for (let i = 0; i < 300; i++) {
      save(repo, 'list', NOW - 10 * MIN - i * 20_000, [r('1;6', 10)], '/items');
      save(repo, 'list', NOW - 10 * MIN - i * 20_000 + 1_000, [r('2;6', 12)], '/items/2');
    }
  }

  it('keeps its items, its pair and its change on the stock page, as the history and the feed read them', () => {
    const h = setup();
    save(h.repo, 'list', NOW - 2 * DAY, [r('900;6', 30)], '/items/3');
    save(h.repo, 'list', NOW - 30 * HOUR, [r('900;6', 30)], '/items/3');
    busy(h.repo);
    expect(h.repo.pruneBankStock(NOW, { orphans: false })).toBe(0);
    expect(h.repo.bankStockSaveIndex().length).toBeGreaterThan(500);

    // Before the next save of /items/3: it is still listed, by the history and by the stock page alike.
    expect(h.history.listedSinceFor('900;6', 'list')).toBe(NOW - 2 * DAY);
    const quiet = h.list({ bank: 'list', filter: 'all' }).rows.find((x) => x.sku === '900;6');
    expect(quiet).toMatchObject({ listedSince: NOW - 2 * DAY, change: null });
    expect(h.stock.detailFor('900;6')).toMatchObject({ bank: 'list', savedAt: NOW - 30 * HOUR });
    expect(h.stock.seenFor('900;6')).toEqual({ bank: 'list', at: NOW - 30 * HOUR });

    // A new save of /items/3, cheaper: the feed's event and the stock page's chip agree.
    let events = 0;
    h.repo.transaction(() => {
      const id = save(h.repo, 'list', NOW, [r('900;6', 25)], '/items/3');
      events = h.history.onImport(id);
    });
    h.stock.refresh();
    h.history.refresh();
    expect(events).toBe(1);
    expect(h.repo.scraptfEvents({ bank: 'list' })).toEqual([expect.objectContaining({ kind: 'cheaper', page: '/items/3', fromScrap: 30, toScrap: 25 })]);
    const row = h.list({ bank: 'list', filter: 'all' }).rows.find((x) => x.sku === '900;6');
    expect(row).toMatchObject({ change: 'cheaper', previousCostScrap: 30, costScrap: 25, listedSince: NOW - 2 * DAY });
    expect(h.stock.detailFor('900;6')).toMatchObject({ bank: 'list', savedAt: NOW, change: 'cheaper', previousCostScrap: 30 });
    // The busy pages read as before: each page its own newest pair.
    expect(h.list({ bank: 'list', filter: 'all' }).rows.map((x) => x.sku).sort()).toEqual(['1;6', '2;6', '900;6']);
  });

  it("reads each page's newest saves from the repo, page by page, whatever the other pages keep", () => {
    const h = setup();
    save(h.repo, 'list', NOW - 2 * DAY, [r('900;6', 30)], '/items/3');
    const prev = save(h.repo, 'list', NOW - 30 * HOUR, [r('900;6', 30)], '/items/3');
    busy(h.repo);
    const heads = h.repo.bankStockSaves('list', 500, { perPage: 10 });
    expect(heads).toHaveLength(22);
    // The page saved last first, each page newest first, and the quiet page's pair is there.
    expect([...new Set(heads.map((s) => s.page))]).toEqual(['/items/2', '/items', '/items/3']);
    expect(heads.filter((s) => s.page === '/items/3').map((s) => s.savedAt)).toEqual([NOW - 30 * HOUR, NOW - 2 * DAY]);
    expect(heads.find((s) => s.batchId === prev)).toEqual({ batchId: prev, savedAt: NOW - 30 * HOUR, items: 1, page: '/items/3' });
    for (const page of ['/items', '/items/2']) {
      const times = heads.filter((s) => s.page === page).map((s) => s.savedAt);
      expect(times).toHaveLength(10);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    }
    // The bank's newest saves overall (no perPage) still read as before.
    expect(h.repo.bankStockSaves('list', 500).some((s) => s.page === '/items/3')).toBe(false);
  });
});

// 0.8 (T4, LC-4): each on-sale row's buy-timing brief from history.timingFor (judged at list()'s and all()'s
// `now`), never on a gone or an /items family row, and the bank's turnover on the result.
describe('BankStockRow.timing and BankStockResult.turnover (0.8)', () => {
  /** Sells for 60, Pay up to 55, for every base. */
  const BUY = { revenueScrap: 60, maxCostScrap: 55 } as const;

  function timed(history?: BankStockDeps['history']) {
    const repo = openRepo(':memory:');
    repos.push(repo);
    const log = recordingLogger();
    const entryFor = () => BUY as unknown as MarketEval;
    const real = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor }, keyPrice: () => KEY, profit: () => DEFAULT_SETTINGS.profit });
    const stock = createBankStock({
      clock: { now: () => NOW },
      log,
      repo,
      market: { entryFor },
      keyPrice: () => KEY,
      settings: () => DEFAULT_SETTINGS,
      categoryOf: () => 'hats',
      history: history ?? { runsFor: (bank) => real.runsFor(bank), timingFor: (bank, key, buy, now) => real.timingFor(bank, key, buy, now), turnoverFor: (bank) => real.turnoverFor(bank) },
    });
    return { repo, log, history: real, stock };
  }

  /** Hats saved every 2 h for 2 days: 1;6 drops 4 % every 3 saves, 2;6 every 4, 3;6 steady, 5;6 gone 2 h ago. */
  function seedTimed(repo: Repo): void {
    for (let i = 0; i < 24; i++) {
      const rows = [r('1;6', Math.round(50 * 0.96 ** Math.floor(i / 3))), r('2;6', Math.round(40 * 0.96 ** Math.floor(i / 4))), r('3;6', 20)];
      if (i < 23) rows.push(r('5;6', 7));
      save(repo, 'hats', NOW - 30 * MIN - (23 - i) * 2 * HOUR, rows);
    }
  }

  it("on-sale rows carry history.timingFor's brief for the same copy; gone rows none; the result its turnover", () => {
    const h = timed();
    seedTimed(h.repo);
    const res = h.stock.list({ bank: 'hats', filter: 'all', limit: 2000 }, NOW);
    const rows = new Map(res.rows.map((x) => [x.key, x]));
    for (const sku of ['1;6', '2;6', '3;6']) {
      const t = h.history.timingFor('hats', key(sku), BUY, NOW);
      expect(t, sku).not.toBeNull();
      expect(rows.get(key(sku))!.timing, sku).toEqual(scraptfTimingBrief(t!));
    }
    const gone = h.stock.list({ bank: 'hats', filter: 'gone', limit: 2000 }, NOW).rows;
    expect(gone.map((x) => x.key)).toEqual([key('5;6')]);
    expect(gone[0]).not.toHaveProperty('timing');
    expect(res.turnover).toEqual(h.history.turnoverFor('hats'));
    // 1;6 dropped in its current run, so the 'dropping' count reads the row's timing.
    expect(rows.get(key('1;6'))!.timing!.dropsThisRun).toBeGreaterThan(0);
    expect(res.counts.dropping).toBe(res.rows.filter((x) => x.change !== 'gone' && (x.timing?.dropsThisRun ?? 0) >= BANK_STOCK_DROPPING_MIN).length);
    // The CSV path (all()) joins the same briefs.
    const csvRows = new Map(h.stock.all({ bank: 'hats', filter: 'all' }, NOW).map((x) => [x.key, x]));
    for (const [k, row] of rows) expect(csvRows.get(k)!.timing, k).toEqual(row.timing);
  });

  it('an /items family row gets no timing; a Craftable list row does', () => {
    const h = timed();
    for (let i = 0; i < 4; i++) {
      save(h.repo, 'list', NOW - (4 - i) * HOUR, [{ ...r('1;6', 30), craft: 'craftable' }, r('2;6', 20)], '/items');
    }
    const rows = new Map(h.stock.list({ bank: 'list', limit: 2000 }, NOW).rows.map((x) => [x.key, x]));
    expect(rows.get(key('1;6'))!.timing).toEqual(scraptfTimingBrief(h.history.timingFor('list', key('1;6'), BUY, NOW)!));
    expect(rows.get(key('2;6'))).toMatchObject({ listFamily: true });
    expect(rows.get(key('2;6'))).not.toHaveProperty('timing');
  });

  it('without timingFor (0.7 wiring) or when it fails, the rows read without timing; a failure is logged once', () => {
    const h = timed();
    seedTimed(h.repo);
    const none = timed({ runsFor: (bank) => h.history.runsFor(bank) });
    seedTimed(none.repo);
    const plain = none.stock.list({ bank: 'hats', limit: 2000 }, NOW);
    expect(plain.rows.every((x) => x.timing === undefined)).toBe(true);
    expect(plain).not.toHaveProperty('turnover');
    const broken = timed({
      runsFor: (bank) => h.history.runsFor(bank),
      timingFor: () => {
        throw new Error('history down');
      },
      turnoverFor: () => {
        throw new Error('history down');
      },
    });
    seedTimed(broken.repo);
    const res = broken.stock.list({ bank: 'hats', limit: 2000 }, NOW);
    expect(res.rows).toHaveLength(3);
    expect(res.rows.every((x) => x.timing === undefined)).toBe(true);
    expect(res).not.toHaveProperty('turnover');
    broken.stock.list({ bank: 'hats', limit: 2000 }, NOW);
    expect(broken.log.lines.filter((l) => l.msg === 'Bank stock could not read the buy timing')).toHaveLength(1);
  });

  it("whatsNew asks for no timing (alerts' look passes its own time, D9)", () => {
    const real = timed();
    seedTimed(real.repo);
    const timingFor = vi.fn((_bank: ScraptfBank, _key: string, _buy: unknown, _now: UnixMs) => null);
    const h = timed({ runsFor: (bank) => real.history.runsFor(bank), timingFor });
    seedTimed(h.repo);
    h.stock.whatsNew('hats');
    expect(timingFor).not.toHaveBeenCalled();
    h.stock.list({ bank: 'hats', limit: 2000 }, NOW);
    // Asked once per row on sale now (gone rows are not asked), at list()'s time.
    expect(timingFor.mock.calls.map((c) => [c[1], c[3]]).sort()).toEqual([[key('1;6'), NOW], [key('2;6'), NOW], [key('3;6'), NOW]]);
  });
});
