// F17 service cache (src/service/domain/bankStock.ts): each bank's two newest saves read from a real
// in-memory repo, diffed with the shared rules and joined per read to a Live market entry (a fake
// entryFor here; test/domain/bankStockMarket.test.ts runs the real index). Covers the diff table, a
// first save, copies with extras, stock 0, the counts and chips, the cache (lazy, no query per read,
// rows read once per save, refresh after an import, a prune and a key price move), and failed reads.
// Saves are pages the user saved (R10); nothing here touches scrap.tf or any network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { BANK_STOCK_RETRY_MS, bankStockCsv, createBankStock, previousOf, type BankStock } from '../../src/service/domain/bankStock';
import { CSV_BOM } from '../../src/service/domain/csv';
import type { MarketEval } from '../../src/service/domain/market';
import {
  BANK_STOCK_CSV_COLUMNS,
  BANK_STOCK_KEEP_SAVES,
  bankStockMatching,
  bankStockRows,
  bankStockSpecialKey,
  emptyBankStockResult,
} from '../../src/shared/bankStock';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { BankStockQuery, BankStockRow, BankStockStored, Category, KeyPriceState, OrderSummary, ScraptfBank, Settings, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function keyPrice(valueScrap: number): KeyPriceState {
  return { valueScrap, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
}

function s(sku: string, costScrap: number | null, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: costScrap === null ? null : 0, costScrap, stock: 1, assetId: null, ...over };
}

/** What importSavedPage writes for a recognised page: a batch with its bank, and its bank_stock rows. */
function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[], importedAt = at): number {
  const pageKind = bank === 'list' ? 'items-list' : bank === 'unusuals' ? 'unusuals' : 'buy';
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind, fileMtime: at, importedAt, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows);
  return id;
}

function order(valueScrap: number): OrderSummary {
  return {
    listingId: `l${valueScrap}`,
    steamid: '76561198000000001',
    userName: 'BuyBot',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: true,
    online: true,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
}

/** A Live market entry with a revenue (the ceiling as the index computes it). */
function entry(revenueScrap: number, settings: Settings, confidence = 70): MarketEval {
  const o = order(revenueScrap);
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
    confidence,
    confidenceLevel: confidence >= 70 ? 'high' : confidence >= 45 ? 'medium' : 'low',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
  };
}

interface Harness {
  repo: Repo;
  clock: { t: UnixMs };
  stock: BankStock;
  entries: Map<string, MarketEval>;
  key: { v: number };
  settings: { current: Settings };
  log: ReturnType<typeof recordingLogger>;
  set(base: string, revenue: number, confidence?: number): void;
  list(q: Omit<BankStockQuery, 'bank'> & { bank?: ScraptfBank }): ReturnType<BankStock['list']>;
  byKey(bank: ScraptfBank, filter?: BankStockQuery['filter']): Map<string, BankStockRow>;
}

function setup(repo: Repo = openRepo(':memory:')): Harness {
  repos.push(repo);
  const entries = new Map<string, MarketEval>();
  const key = { v: 600 };
  // Friction on, so profit = revenue - cost - friction is visible.
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, { profit: { frictionScrap: 2 } }) };
  const log = recordingLogger();
  const categoryOf = (sku: string): Category => (sku.endsWith(';11') ? 'stranges' : 'hats');
  const clock = { t: NOW };
  const stock = createBankStock({
    clock: { now: () => clock.t },
    log,
    repo,
    market: { entryFor: (base) => entries.get(base) ?? null },
    keyPrice: () => keyPrice(key.v),
    settings: () => settings.current,
    categoryOf,
  });
  const h: Harness = {
    repo,
    clock,
    stock,
    entries,
    key,
    settings,
    log,
    set: (base, revenue, confidence) => entries.set(base, entry(revenue, settings.current, confidence)),
    list: (q) => stock.list({ bank: 'hats', limit: 2000, ...q }, NOW),
    byKey: (bank, filter) => new Map(h.list({ bank, filter }).rows.map((r) => [r.key, r])),
  };
  return h;
}

/**
 * The diff table on hats: previous save 3 h ago, newest 10 min ago.
 * 378 cheaper; 126 pricier; 5 gone (absent); 6 gone (listed sold out); 7 new (sold out before);
 * 8 stock move only; 9 sold out in both (not shown); 10 cheaper (1 key -> 590 scrap at K 600);
 * 11 pricier (600 scrap -> 1 key: equal value, more keys); 12 new (absent before).
 */
function seedHats(repo: Repo): { prev: number; newest: number } {
  const prev = save(repo, 'hats', NOW - 3 * HOUR, [
    s('378;6', 40, { name: 'Team Captain', stock: 2 }),
    s('126;6', 50, { name: "Bill's Hat" }),
    s('5;6', 20),
    s('6;6', 20),
    s('7;6', 10, { stock: 0 }),
    s('8;6', 10),
    s('9;6', 10, { stock: 0 }),
    s('10;6', 0, { costKeys: 1 }),
    s('11;6', 600),
  ]);
  const newest = save(repo, 'hats', NOW - 10 * MIN, [
    s('378;6', 30, { name: 'Team Captain' }),
    s('126;6', 55, { name: "Bill's Hat" }),
    s('6;6', 20, { stock: 0 }),
    s('7;6', 10, { stock: 3 }),
    s('8;6', 10, { stock: 4 }),
    s('9;6', 10, { stock: 0 }),
    s('10;6', 590),
    s('11;6', 0, { costKeys: 1 }),
    s('12;6', 25, { stock: 2 }),
  ]);
  return { prev, newest };
}

function hatsMarket(h: Harness): void {
  h.set('378;6', 120); // 120 - 30 - 2 = +88: flip
  h.set('7;6', 50); // +38: a new flip
  h.set('12;6', 26); // -1: over
  h.set('8;6', 12); // 0: over
  h.set('6;6', 100); // gone: never a flip
}

describe('the diff of a bank’s two newest saves (S2)', () => {
  it('marks new, gone, cheaper, pricier and a stock move, and shows each row at the current key price', () => {
    const h = setup();
    seedHats(h.repo);
    hatsMarket(h);
    const all = h.byKey('hats');
    const gone = h.byKey('hats', 'gone');
    const change = (m: Map<string, BankStockRow>) => Object.fromEntries([...m.values()].map((r) => [r.sku, r.change]));
    expect(change(all)).toEqual({ '378;6': 'cheaper', '126;6': 'pricier', '7;6': 'new', '8;6': null, '10;6': 'cheaper', '11;6': 'pricier', '12;6': 'new' });
    expect(change(gone)).toEqual({ '6;6': 'gone', '5;6': 'gone' });

    expect(all.get('378;6|')).toMatchObject({
      name: 'Team Captain',
      category: 'hats',
      hasExtras: false,
      costKeys: 0,
      costScrapRaw: 30,
      costScrap: 30,
      stock: 1,
      previousCostScrap: 40,
      previousStock: 2,
      revenueScrap: 120,
      buyerCount: 3,
      maxCostScrap: maxCostFor(120, h.settings.current.profit),
      profitScrap: 88,
      verdict: 'flip',
      confidence: 70,
      confidenceLevel: 'high',
    });
    expect(all.get('378;6|')!.margin).toBeCloseTo(88 / 30);
    expect(all.get('378;6|')!.revenueOrder).toMatchObject({ userName: 'BuyBot', isBot: true });
    // Keys against metal: decided at the key price, shown at it.
    expect(all.get('10;6|')).toMatchObject({ costKeys: 0, costScrapRaw: 590, costScrap: 590, previousCostScrap: 600 });
    expect(all.get('11;6|')).toMatchObject({ costKeys: 1, costScrapRaw: 0, costScrap: 600, previousCostScrap: 600 });
    // Stock 0 -> 3 is new; a stock move alone (1 -> 4) is no change but carries the old stock.
    expect(all.get('7;6|')).toMatchObject({ stock: 3, previousStock: 0, previousCostScrap: 10, verdict: 'flip', profitScrap: 38 });
    expect(all.get('8;6|')).toMatchObject({ stock: 4, previousStock: 1, change: null, verdict: 'over' });
    expect(all.get('12;6|')).toMatchObject({ previousCostScrap: null, previousStock: null, verdict: 'over', profitScrap: -1 });
    expect(all.get('126;6|')).toMatchObject({ verdict: 'no-buyers', revenueScrap: null, profitScrap: null, maxCostScrap: null, confidence: null, buyerCount: 0 });
    // Gone: the last price; stock 0 while still listed sold out, null once off the page.
    expect(gone.get('6;6|')).toMatchObject({ costScrap: 20, stock: 0, previousStock: 1 });
    expect(gone.get('5;6|')).toMatchObject({ costScrap: 20, stock: null });
    // Sold out in both saves: on neither chip.
    expect(all.has('9;6|') || gone.has('9;6|')).toBe(false);
  });

  it('counts every chip over the whole bank, whatever the filter and search', () => {
    const h = setup();
    seedHats(h.repo);
    hatsMarket(h);
    const counts = { items: 9, inStock: 7, new: 2, gone: 2, cheaper: 2, pricier: 2, flips: 2, newFlips: 1, longListed: 0, dropped: 0 };
    for (const q of [{}, { filter: 'gone' as const }, { filter: 'new' as const, search: 'nothing matches this' }]) {
      const r = h.list(q);
      expect(r.counts).toEqual(counts);
      expect(r).toMatchObject({ bank: 'hats', label: 'Hats', url: 'https://scrap.tf/buy/hats', savedAt: NOW - 10 * MIN, previousSavedAt: NOW - 3 * HOUR, saves: 2, generatedAt: NOW });
      expect(r.keyPrice?.valueScrap).toBe(600);
    }
    const keys = (filter: BankStockQuery['filter']) => h.list({ filter }).rows.map((r) => r.sku);
    expect(keys('new')).toEqual(['7;6', '12;6']);
    expect(keys('flips')).toEqual(['378;6', '7;6']);
    expect(keys('changed').sort()).toEqual(['10;6', '11;6', '126;6', '378;6']);
    expect(h.list({ search: 'team cap' }).rows.map((r) => r.sku)).toEqual(['378;6']);
    expect(h.stock.whatsNew('hats')).toEqual({ new: 2, newFlips: 1, gone: 2, cheaper: 2, pricier: 2, since: NOW - 3 * HOUR });
  });

  it('orders by profit, highest first, with missing values last, and pages the result', () => {
    const h = setup();
    seedHats(h.repo);
    hatsMarket(h);
    const full = h.list({});
    expect(full.rows.slice(0, 4).map((r) => r.sku)).toEqual(['378;6', '7;6', '8;6', '12;6']);
    expect(full.total).toBe(7);
    const page = h.list({ limit: 2, offset: 1 });
    expect(page.rows.map((r) => r.sku)).toEqual(['7;6', '8;6']);
    expect(page.total).toBe(7);
    expect(h.list({ sort: 'cost' }).rows.map((r) => r.costScrap)).toEqual([10, 10, 25, 30, 55, 590, 600]);
  });

  it('is the shared rule over the stored saves and the market entries (what the mock runs)', () => {
    const h = setup();
    const { prev, newest } = seedHats(h.repo);
    hatsMarket(h);
    const rows = bankStockRows({
      newest: h.repo.bankStockRows(newest),
      previous: h.repo.bankStockRows(prev),
      keyScrap: 600,
      profit: h.settings.current.profit,
      categoryOf: () => 'hats',
      buySideOf: (sku) => h.entries.get(sku) ?? null,
    });
    for (const q of [{}, { filter: 'gone' as const }, { sort: 'name' as const, dir: 'desc' as const }, { filter: 'flips' as const, sort: 'payUpTo' as const }]) {
      expect(h.stock.all({ bank: 'hats', ...q }, NOW)).toEqual(bankStockMatching(rows, q));
    }
  });

  it('follows the live book on every read: no refresh needed for a new buyer', () => {
    const h = setup();
    seedHats(h.repo);
    expect(h.byKey('hats').get('126;6|')!.verdict).toBe('no-buyers');
    h.set('126;6', 200);
    expect(h.byKey('hats').get('126;6|')).toMatchObject({ verdict: 'flip', revenueScrap: 200, profitScrap: 200 - 55 - 2 });
    // ...and the profit settings: more friction, less profit.
    h.settings.current = mergeSettings(h.settings.current, { profit: { frictionScrap: 10 } });
    expect(h.byKey('hats').get('126;6|')!.profitScrap).toBe(200 - 55 - 10);
  });
});

describe('a first save, a never-saved bank, extras and the list', () => {
  it('a first save lists everything on sale with no change, says nothing is new and notifies nothing', () => {
    const h = setup();
    const id = save(h.repo, 'stranges', NOW - HOUR, [s('200;11', 50), s('201;11', 60, { stock: 0 }), s('202;11', null, { costKeys: null })]);
    h.set('200;11', 300);
    const r = h.list({ bank: 'stranges' });
    expect(r).toMatchObject({ savedAt: NOW - HOUR, previousSavedAt: null, saves: 1, total: 1 });
    expect(r.counts).toEqual({ items: 3, inStock: 1, new: 0, gone: 0, cheaper: 0, pricier: 0, flips: 1, newFlips: 0, longListed: 0, dropped: 0 });
    expect(r.rows[0]).toMatchObject({ sku: '200;11', change: null, category: 'stranges', previousCostScrap: null, verdict: 'flip' });
    expect(h.stock.whatsNew('stranges')).toBeNull();
    expect(h.stock.newFlips('stranges', id)).toEqual([]);
    expect(h.stock.newAtFor('200;11')).toBeNull();
    expect(h.stock.detailFor('200;11')).toEqual({ bank: 'stranges', savedAt: NOW - HOUR, change: null, previousCostScrap: null, stock: 1 });
  });

  it('answers "no save" for a bank never saved', () => {
    const h = setup();
    seedHats(h.repo);
    expect(h.list({ bank: 'skins' })).toEqual(emptyBankStockResult('skins', keyPrice(600), NOW));
    expect(h.stock.all({ bank: 'skins' }, NOW)).toEqual([]);
    expect(h.stock.whatsNew('skins')).toBeNull();
  });

  it('keeps painted and spelled copies apart from the clean one, each with its own change', () => {
    const h = setup();
    const red = bankStockSpecialKey({ paint: 12073019 });
    const blue = bankStockSpecialKey({ paint: 5801378 });
    const spelled = bankStockSpecialKey({ spells: ['Exorcism'] });
    save(h.repo, 'hats', NOW - 2 * HOUR, [s('378;6', 40), s('378;6', 70, { specialKey: red })]);
    save(h.repo, 'hats', NOW - 5 * MIN, [s('378;6', 40), s('378;6', 90, { specialKey: blue }), s('378;6', 80, { specialKey: spelled })]);
    h.set('378;6', 150);
    const all = h.byKey('hats');
    expect([...all.keys()].sort()).toEqual([`378;6|`, `378;6|${blue}`, `378;6|${spelled}`].sort());
    expect(all.get('378;6|')).toMatchObject({ change: null, hasExtras: false });
    expect(all.get(`378;6|${blue}`)).toMatchObject({ sku: '378;6', change: 'new', hasExtras: true, costScrap: 90, revenueScrap: 150 });
    expect(all.get(`378;6|${spelled}`)).toMatchObject({ change: 'new', hasExtras: true });
    expect(h.byKey('hats', 'gone').get(`378;6|${red}`)).toMatchObject({ change: 'gone', hasExtras: true, costScrap: 70, stock: null });
    // The base is new on the market when any copy is; the drawer reads the exact copy.
    expect(h.stock.newAtFor('378;6')).toBe(NOW - 5 * MIN);
    expect(h.stock.detailFor('378;6')).toEqual({ bank: 'hats', savedAt: NOW - 5 * MIN, change: null, previousCostScrap: 40, stock: 1 });
    expect(h.stock.detailFor('378;6;p5801378')).toEqual({ bank: 'hats', savedAt: NOW - 5 * MIN, change: 'new', previousCostScrap: null, stock: 1 });
    expect(h.stock.detailFor('378;6;p12073019')).toEqual({ bank: 'hats', savedAt: NOW - 5 * MIN, change: 'gone', previousCostScrap: 70, stock: null });
  });

  it('reads the /items list as a bank: a "Sold out" row with no price restocking is new', () => {
    const h = setup();
    save(h.repo, 'list', NOW - 24 * HOUR, [s('378;6', null, { costKeys: null, stock: 0 }), s('126;6', 30, { stock: 2 })]);
    save(h.repo, 'list', NOW - 3 * MIN, [s('378;6', 33, { stock: 1 }), s('126;6', null, { costKeys: null, stock: 0 })]);
    const r = h.list({ bank: 'list' });
    expect(r).toMatchObject({ label: 'All items', url: 'https://scrap.tf/items' });
    expect(r.rows.map((x) => [x.sku, x.change])).toEqual([['378;6', 'new']]);
    expect(h.list({ bank: 'list', filter: 'gone' }).rows.map((x) => [x.sku, x.costScrap, x.stock])).toEqual([['126;6', 30, 0]]);
  });

  it('takes the market and drawer dates from the newest save, across banks', () => {
    const h = setup();
    seedHats(h.repo);
    save(h.repo, 'list', NOW - 30 * HOUR, [s('12;6', 30)]);
    save(h.repo, 'list', NOW - 2 * MIN, [s('12;6', 30), s('7;6', 9)]);
    // 7 is new on hats (10 min ago) and on the list (2 min ago): the newest wins.
    expect(h.stock.newAtFor('7;6')).toBe(NOW - 2 * MIN);
    expect(h.stock.newAtFor('12;6')).toBe(NOW - 10 * MIN);
    expect(h.stock.newAtFor('378;6')).toBeNull();
    expect(h.stock.detailFor('12;6')).toMatchObject({ bank: 'list', change: null });
    expect(h.stock.detailFor('not a sku')).toBeNull();
  });
});

describe('newFlips (S3 candidates)', () => {
  it('lists the new flips of the newest save only, most profit first', () => {
    const h = setup();
    const { prev, newest } = seedHats(h.repo);
    hatsMarket(h);
    h.set('12;6', 200); // now a flip too: +173
    expect(h.stock.newFlips('hats', newest).map((r) => [r.sku, r.profitScrap])).toEqual([
      ['12;6', 173],
      ['7;6', 38],
    ]);
    // An older save of the bank (imported late) is not the newest: nothing.
    expect(h.stock.newFlips('hats', prev)).toEqual([]);
    expect(h.stock.newFlips('weapons', newest)).toEqual([]);
  });
});

describe('the cache', () => {
  it('reads nothing until first used, then serves reads from memory with no query per row', () => {
    const repo = openRepo(':memory:');
    seedHats(repo);
    const spies = (['bankStockSaves', 'bankStockRows', 'bankStockLatestPair'] as const).map((m) => vi.spyOn(repo, m));
    const h = setup(repo);
    hatsMarket(h);
    expect(spies.every((sp) => sp.mock.calls.length === 0)).toBe(true);
    h.list({});
    const first = spies.map((sp) => sp.mock.calls.length);
    expect(first[1]).toBe(2); // the two hats saves, once each
    for (let i = 0; i < 5; i++) {
      h.list({ filter: 'new' });
      h.stock.all({ bank: 'hats' }, NOW);
      h.stock.whatsNew('hats');
      h.stock.newAtFor('7;6');
      h.stock.detailFor('378;6');
      h.stock.version();
    }
    expect(spies.map((sp) => sp.mock.calls.length)).toEqual(first);
  });

  it('after an import re-reads the saves but only the new save’s rows, and moves the pair along', () => {
    const repo = openRepo(':memory:');
    const { newest } = seedHats(repo);
    const h = setup(repo);
    hatsMarket(h);
    expect(h.list({}).previousSavedAt).toBe(NOW - 3 * HOUR);
    const v0 = h.stock.version();
    const rows = vi.spyOn(repo, 'bankStockRows');
    const third = save(repo, 'hats', NOW - MIN, [s('378;6', 30, { name: 'Team Captain' }), s('7;6', 10, { stock: 1 }), s('13;6', 5)]);
    // Not refreshed yet: the cache still serves the old pair.
    expect(h.list({}).savedAt).toBe(NOW - 10 * MIN);
    h.stock.refresh();
    expect(rows.mock.calls.map((c) => c[0])).toEqual([third]);
    expect(h.stock.version()).toBeGreaterThan(v0);
    const r = h.list({ filter: 'new' });
    expect(r).toMatchObject({ savedAt: NOW - MIN, previousSavedAt: NOW - 10 * MIN, saves: 3 });
    expect(r.rows.map((x) => x.sku)).toEqual(['13;6']);
    expect(h.stock.newFlips('hats', newest)).toEqual([]);
    expect(h.stock.newAtFor('7;6')).toBeNull();
    expect(h.stock.newAtFor('13;6')).toBe(NOW - MIN);
  });

  it('a refresh that changed nothing keeps the version (the market keeps its filtered pass)', () => {
    const h = setup();
    seedHats(h.repo);
    const v = h.stock.version();
    h.stock.refresh();
    h.stock.refresh();
    expect(h.stock.version()).toBe(v);
  });

  it('reads at most the kept saves, and past 90 days keeps only the newest save and the one it is compared with (F20)', () => {
    const h = setup();
    for (let i = 0; i < BANK_STOCK_KEEP_SAVES + 2; i++) save(h.repo, 'weapons', NOW - (101 - i) * 24 * HOUR, [s('45;6', 3)]);
    expect(h.list({ bank: 'weapons' }).saves).toBe(BANK_STOCK_KEEP_SAVES);
    // Every save is past 90 days: maintenance thins all but the two the page shows, core refreshes.
    h.repo.pruneBankStock(NOW);
    h.stock.refresh();
    expect(h.list({ bank: 'weapons' })).toMatchObject({ savedAt: NOW - 90 * 24 * HOUR, previousSavedAt: NOW - 91 * 24 * HOUR, saves: 2 });
  });
  it('decides keys against metal at the key price of the last refresh (core refreshes on a key move)', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - HOUR, [s('20;6', 590)]);
    save(h.repo, 'hats', NOW - MIN, [s('20;6', 0, { costKeys: 1 })]);
    expect(h.list({}).rows[0]).toMatchObject({ change: 'pricier', costScrap: 600, previousCostScrap: 590 });
    h.key.v = 580;
    // Values follow the key price on every read; the direction once refreshed.
    expect(h.list({}).rows[0]).toMatchObject({ change: 'pricier', costScrap: 580 });
    h.stock.refresh();
    expect(h.list({}).rows[0]).toMatchObject({ change: 'cheaper', costScrap: 580, previousCostScrap: 590 });
  });

  it('keeps the last good diffs when a read fails, logs once per failure streak, and retries later', () => {
    const repo = openRepo(':memory:');
    seedHats(repo);
    const h = setup(repo);
    hatsMarket(h);
    expect(h.list({}).total).toBe(7);
    const saves = vi.spyOn(repo, 'bankStockSaves').mockImplementation(() => {
      throw new Error('database is locked');
    });
    save(repo, 'stranges', NOW - MIN, [s('200;11', 5)]);
    h.stock.refresh();
    h.stock.refresh();
    const tries = saves.mock.calls.length;
    expect(h.list({}).total).toBe(7);
    expect(h.stock.whatsNew('hats')).toMatchObject({ new: 2 });
    expect(h.log.lines.filter((l) => l.level === 'warn' && /could not read the saved pages/.test(l.msg))).toHaveLength(1);
    // Reads inside the retry window do not hammer a failing database (the market asks per row).
    for (let i = 0; i < 50; i++) h.stock.newAtFor('7;6');
    expect(saves.mock.calls.length).toBe(tries);
    saves.mockRestore();
    expect(h.list({ bank: 'stranges' }).saves).toBe(0);
    // Stale since the failure: a read past the window tries again and sees the new bank.
    h.clock.t += BANK_STOCK_RETRY_MS;
    expect(h.list({ bank: 'stranges' }).saves).toBe(1);
    expect(h.list({}).total).toBe(7);
  });

  it('never throws from a read: a failing market entry reads as no buyers, a failing first load as no save', () => {
    const repo = openRepo(':memory:');
    seedHats(repo);
    const h = setup(repo);
    h.entries.get = () => {
      throw new Error('boom');
    };
    expect(h.list({}).rows.every((r) => r.verdict === 'no-buyers')).toBe(true);
    const broken = openRepo(':memory:');
    vi.spyOn(broken, 'bankStockSaves').mockImplementation(() => {
      throw new Error('no such table');
    });
    const b = setup(broken);
    expect(b.list({})).toMatchObject({ savedAt: null, total: 0 });
    expect([b.stock.whatsNew('hats'), b.stock.newAtFor('7;6'), b.stock.detailFor('7;6')]).toEqual([null, null, null]);
    expect(b.stock.newFlips('hats', 1)).toEqual([]);
  });
});

describe('CSV (opps.exportCsv kind bankStock)', () => {
  it('writes the matching rows, gone rows only under Gone', () => {
    const h = setup();
    seedHats(h.repo);
    hatsMarket(h);
    const csv = bankStockCsv(h.stock.all({ bank: 'hats', filter: 'gone' }, NOW), 600);
    const lines = csv.slice(CSV_BOM.length).trim().split('\r\n');
    expect(lines[0]).toBe(BANK_STOCK_CSV_COLUMNS.join(','));
    // Profit order: 6 still has a buyer (+78), 5 has none (last).
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['6;6', '5;6']);
    expect(lines[1]).toContain(',gone,');
  });
});

describe('a page imported twice (reviewer fixes)', () => {
  it('previousOf skips saves at the newest one’s own time', () => {
    const at = (batchId: number, savedAt: UnixMs) => ({ batchId, savedAt, items: 1 });
    expect(previousOf([])).toBeNull();
    expect(previousOf([at(3, 30)])).toBeNull();
    expect(previousOf([at(3, 30), at(2, 20), at(1, 10)])).toEqual(at(2, 20));
    // The newest file imported again (higher batch id, same mtime): the save before it is still 20.
    expect(previousOf([at(4, 30), at(3, 30), at(2, 20)])).toEqual(at(2, 20));
    expect(previousOf([at(4, 30), at(3, 30)])).toBeNull();
  });

  it('keeps what changed since the save before, instead of diffing the page against itself, and tells nothing again', () => {
    const h = setup();
    const { newest } = seedHats(h.repo);
    hatsMarket(h);
    const before = h.list({});
    expect(h.stock.newFlips('hats', newest).map((r) => r.sku)).toEqual(['7;6']);
    // The Import page's file picker on the page the folder watch already took: same mtime, new batch.
    const again = save(h.repo, 'hats', NOW - 10 * MIN, h.repo.bankStockRows(newest), NOW);
    h.stock.refresh();
    const after = h.list({});
    expect(after).toMatchObject({ savedAt: NOW - 10 * MIN, previousSavedAt: NOW - 3 * HOUR, saves: 3 });
    expect(after.counts).toEqual(before.counts);
    expect(after.rows).toEqual(before.rows);
    expect(h.stock.whatsNew('hats')).toEqual({ new: 2, newFlips: 1, gone: 2, cheaper: 2, pricier: 2, since: NOW - 3 * HOUR });
    expect(h.stock.newAtFor('7;6')).toBe(NOW - 10 * MIN);
    // Its first import told of these already: the second import of the same look tells nothing...
    expect(h.stock.newFlips('hats', again)).toEqual([]);
    // ...while the first import is still that look (F17-C2: judged by the look, not the newest batch id),
    // so one held at start-up still tells once; the persisted dedupe guards a repeat of it.
    expect(h.stock.newFlips('hats', newest).map((r) => r.sku)).toEqual(['7;6']);
  });

  it('reads a bank whose only saves are one page imported twice as a first save', () => {
    const h = setup();
    const first = save(h.repo, 'weapons', NOW - HOUR, [s('45;6', 3)]);
    save(h.repo, 'weapons', NOW - HOUR, h.repo.bankStockRows(first), NOW);
    expect(h.list({ bank: 'weapons' })).toMatchObject({ savedAt: NOW - HOUR, previousSavedAt: null, saves: 2 });
    expect(h.stock.whatsNew('weapons')).toBeNull();
  });
});

describe('categories and the schema (reviewer fixes)', () => {
  it('reads the categories again once the schema has loaded, not per row', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    seedHats(repo);
    const loaded = { v: false };
    const categoryOf = vi.fn((sku: string): Category => (loaded.v ? 'hats' : sku === '378;6' ? 'other' : 'hats'));
    const stock = createBankStock({
      clock: { now: () => NOW },
      log: recordingLogger(),
      repo,
      market: { entryFor: () => null },
      keyPrice: () => keyPrice(600),
      settings: () => DEFAULT_SETTINGS,
      categoryOf,
      schemaLoaded: () => loaded.v,
    });
    const cat = () => stock.list({ bank: 'hats' }, NOW).rows.find((r) => r.sku === '378;6')!.category;
    expect(cat()).toBe('other');
    const calls = categoryOf.mock.calls.length;
    expect(cat()).toBe('other');
    expect(categoryOf.mock.calls.length).toBe(calls);
    loaded.v = true;
    expect(cat()).toBe('hats');
  });
});
