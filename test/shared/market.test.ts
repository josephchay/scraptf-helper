// F10 shared rules: the verdict, filters, order, paging and CSV cells that the
// service's market index, the browser mock and the dashboard all use; and F15's
// page-to-bank rule behind the coverage strip and the banks summary.

import { describe, expect, it } from 'vitest';
import { SCRAPTF_BANK_PAGES, scraptfLinkFor } from '../../src/shared/links';
import {
  MARKET_CSV_COLUMNS,
  MARKET_DEFAULT_LIMIT,
  MARKET_MAX_LIMIT,
  batchBankOf,
  emptyMarketCounts,
  isEmptyBankSave,
  marketBuySideMatches,
  marketComparator,
  marketCsvCells,
  marketPage,
  marketProfit,
  marketRowMatches,
  marketSearchTokens,
  marketUpdatedAt,
  marketUserSideMatches,
  marketVerdict,
  scraptfBankSaves,
  scraptfCoverage,
} from '../../src/shared/market';
import { MARKET_VERDICTS, type Category, type ImportBatch, type MarketRow, type OrderSummary } from '../../src/shared/types';

const T = Date.UTC(2026, 9, 15, 12, 0, 0);

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'Pure Buyer Bot',
    keys: 0,
    metalScrap: 30,
    valueScrap: 30,
    isBot: true,
    online: true,
    lastEventAt: T - 60_000,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function row(over: Partial<MarketRow> = {}): MarketRow {
  const base: MarketRow = {
    sku: '378;6',
    name: 'Team Captain',
    category: 'hats',
    revenueScrap: 30,
    bestScrap: 31,
    consScrap: 30,
    instantScrap: 30,
    revenueOrder: order(),
    buyerCount: 3,
    maxCostScrap: 20,
    confidence: 70,
    confidenceLevel: 'high',
    flags: [],
    knownCostScrap: null,
    knownSource: 'none',
    knownObservedAt: null,
    stock: null,
    ruleCostScrap: null,
    profitScrap: null,
    verdict: 'unchecked',
    lastOrderChangeAt: T - 60_000,
    evaluatedAt: T,
    scraptfPaysScrap: null,
    scraptfStock: null,
    scraptfStockLimit: null,
    scraptfFull: false,
    scraptfListAt: null,
    scraptfNewAt: null,
    scraptfListedSince: null,
    scraptfLink: scraptfLinkFor(over.category ?? 'hats', null),
  };
  return { ...base, ...over };
}

describe('marketVerdict', () => {
  const v = (buyerCount: number, maxCostScrap: number | null, knownCostScrap: number | null, ruleCostScrap: number | null = null) =>
    marketVerdict({ buyerCount, maxCostScrap, knownCostScrap, ruleCostScrap });

  it('compares a known cost with the ceiling (equal is still a flip)', () => {
    expect(v(2, 20, 20)).toBe('flip');
    expect(v(2, 20, 0)).toBe('flip');
    expect(v(2, 20, 21)).toBe('over');
  });

  it('calls a known cost over when buyers exist but no cost qualifies', () => {
    expect(v(2, null, 5)).toBe('over');
  });

  it('says no-buyers only for a known cost without eligible buyers', () => {
    expect(v(0, null, 5)).toBe('no-buyers');
    expect(v(0, null, null)).toBe('unchecked');
  });

  it('uses a rule only when there is no known cost, and the known cost wins', () => {
    expect(v(2, 20, null, 20)).toBe('rule-flip');
    expect(v(2, 20, null, 21)).toBe('unchecked');
    expect(v(2, null, null, 1)).toBe('unchecked');
    expect(v(0, 20, null, 1)).toBe('unchecked');
    expect(v(2, 20, 25, 1)).toBe('over');
  });
});

describe('small helpers', () => {
  it('marketProfit subtracts the friction as the engine does', () => {
    expect(marketProfit(30, 20, { frictionScrap: 2 })).toBe(8);
    expect(marketProfit(30, 20, { frictionScrap: -5 })).toBe(10);
    expect(marketProfit(null, 20, { frictionScrap: 0 })).toBeNull();
    expect(marketProfit(30, null, { frictionScrap: 0 })).toBeNull();
  });

  it('0.8 (PC-1): marketProfit is flipProfit, the price-move reserve included', () => {
    // 100 - 50 - 2 - ceil(100 x 5%) = 43.
    expect(marketProfit(100, 50, { frictionScrap: 2, exitReservePct: 0.05 })).toBe(43);
    expect(marketProfit(100, 50, { frictionScrap: 2, exitReservePct: 0 })).toBe(48);
  });

  it('emptyMarketCounts has every verdict at zero', () => {
    expect(emptyMarketCounts()).toEqual(Object.fromEntries(MARKET_VERDICTS.map((x) => [x, 0])));
  });

  it('marketUpdatedAt is the newer of the order change and the price', () => {
    expect(marketUpdatedAt({ lastOrderChangeAt: 5, knownObservedAt: 9 })).toBe(9);
    expect(marketUpdatedAt({ lastOrderChangeAt: 9, knownObservedAt: null })).toBe(9);
    expect(marketUpdatedAt({ lastOrderChangeAt: null, knownObservedAt: null })).toBeNull();
  });

  it('marketPage clamps like the service (1..500, default 200)', () => {
    expect(marketPage({})).toEqual({ limit: MARKET_DEFAULT_LIMIT, offset: 0 });
    expect(marketPage({ limit: 9999, offset: -4 })).toEqual({ limit: MARKET_MAX_LIMIT, offset: 0 });
    expect(marketPage({ limit: 0.5, offset: 7.9 })).toEqual({ limit: 1, offset: 7 });
  });

  it('marketSearchTokens lower-cases, splits and caps', () => {
    expect(marketSearchTokens('  Team   CAPTAIN ')).toEqual(['team', 'captain']);
    expect(marketSearchTokens(undefined)).toEqual([]);
    expect(marketSearchTokens(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '))).toHaveLength(20);
  });
});

describe('filters', () => {
  it('match the backpack.tf side', () => {
    const r = row();
    const t = (q: Parameters<typeof marketBuySideMatches>[1]) => marketBuySideMatches(r, q, marketSearchTokens(q.search));
    expect(t({})).toBe(true);
    expect(t({ search: 'captain 378' })).toBe(true);
    expect(t({ search: 'helm' })).toBe(false);
    expect(t({ categories: ['hats'] })).toBe(true);
    expect(t({ categories: ['weapons'] })).toBe(false);
    expect(t({ minCeilingScrap: 20 })).toBe(true);
    expect(t({ minCeilingScrap: 21 })).toBe(false);
    expect(t({ onlyBotBuyers: true })).toBe(true);
    expect(marketBuySideMatches(row({ revenueOrder: order({ isBot: false }) }), { onlyBotBuyers: true }, [])).toBe(false);
    expect(t({ minBuyers: 3 })).toBe(true);
    expect(t({ minBuyers: 4 })).toBe(false);
    expect(marketBuySideMatches(row({ maxCostScrap: null }), { minCeilingScrap: 1 }, [])).toBe(false);
  });

  it('match the user side, and the counts can ignore the verdict filter', () => {
    const r = row({ knownSource: 'page', verdict: 'flip' });
    expect(marketUserSideMatches(r, { sources: ['page'] })).toBe(true);
    expect(marketUserSideMatches(r, { sources: ['typed', 'none'] })).toBe(false);
    expect(marketUserSideMatches(r, { verdicts: ['over'] })).toBe(false);
    expect(marketUserSideMatches(r, { verdicts: ['over'] }, true)).toBe(true);
    expect(marketRowMatches(r, { verdicts: ['flip'], search: 'team' })).toBe(true);
  });
});

describe('marketComparator', () => {
  const a = row({ sku: 'a', name: 'Alpha', maxCostScrap: 10, revenueScrap: 50, buyerCount: 1, profitScrap: null });
  const b = row({ sku: 'b', name: 'Bravo', maxCostScrap: 30, revenueScrap: 40, buyerCount: 5, profitScrap: 4 });
  const c = row({ sku: 'c', name: 'Charlie', maxCostScrap: null, revenueScrap: null, buyerCount: 0, profitScrap: -2 });
  const d = row({ sku: 'd', name: 'Alpha', maxCostScrap: 10, revenueScrap: 50, buyerCount: 1, profitScrap: null });
  const names = (rows: MarketRow[]) => rows.map((r) => r.sku).join('');

  it('defaults to the ceiling, highest first, missing values last, ties by name then SKU', () => {
    expect(names([c, d, a, b].sort(marketComparator(undefined, undefined)))).toBe('badc');
    expect(names([c, d, a, b].sort(marketComparator('ceiling', 'asc')))).toBe('adbc');
  });

  it('sorts the other keys', () => {
    expect(names([a, b, c].sort(marketComparator('revenue', 'desc')))).toBe('abc');
    expect(names([a, b, c].sort(marketComparator('buyers', 'desc')))).toBe('bac');
    expect(names([a, b, c].sort(marketComparator('profit', 'desc')))).toBe('bca');
    expect(names([c, b, a].sort(marketComparator('name', undefined)))).toBe('abc');
    expect(names([a, b, c].sort(marketComparator('name', 'desc')))).toBe('cba');
  });

  it('sorts by the newer of order change and price for updated', () => {
    const old = row({ sku: 'o', lastOrderChangeAt: 1, knownObservedAt: 2 });
    const fresh = row({ sku: 'f', lastOrderChangeAt: 1, knownObservedAt: 50 });
    const none = row({ sku: 'n', lastOrderChangeAt: null, knownObservedAt: null });
    expect(names([old, none, fresh].sort(marketComparator('updated', 'desc')))).toBe('fon');
  });
});

describe('marketCsvCells', () => {
  it('writes one cell per column, money as keys and ref, blanks for missing values', () => {
    const r = row({
      knownCostScrap: 18,
      knownSource: 'page',
      knownObservedAt: T,
      stock: 2,
      ruleCostScrap: 16,
      profitScrap: 12,
      verdict: 'flip',
      revenueScrap: 600,
      maxCostScrap: 580,
    });
    const cells = marketCsvCells(r, 568);
    expect(cells).toHaveLength(MARKET_CSV_COLUMNS.length);
    const byCol = Object.fromEntries(MARKET_CSV_COLUMNS.map((c, i) => [c, cells[i]]));
    expect(byCol).toMatchObject({
      sku: '378;6',
      verdict: 'flip',
      sells_for: '1 key 3.55 ref',
      buyer: 'Pure Buyer Bot (bot)',
      buyers: 3,
      your_price: '2.00 ref',
      source: 'page',
      stock: 2,
      rule_price: '1.77 ref',
      profit: '1.33 ref',
      confidence: 70,
      updated: new Date(T).toISOString(),
      // Off the saved scrap.tf list: blank.
      scraptf_pays: '',
      scraptf_stock: null,
      scraptf_limit: null,
      scraptf_list_saved: '',
    });
    const listed = marketCsvCells(row({ scraptfPaysScrap: 600, scraptfStock: 5, scraptfStockLimit: 5, scraptfFull: true, scraptfListAt: T - 60_000 }), 568);
    expect(Object.fromEntries(MARKET_CSV_COLUMNS.map((c, i) => [c, listed[i]]))).toMatchObject({
      scraptf_pays: '1 key 3.55 ref',
      scraptf_stock: 5,
      scraptf_limit: 5,
      scraptf_list_saved: new Date(T - 60_000).toISOString(),
    });
    const empty = Object.fromEntries(
      MARKET_CSV_COLUMNS.map((c, i) => [c, marketCsvCells(row({ revenueOrder: null, revenueScrap: null, maxCostScrap: null, lastOrderChangeAt: null }), null)[i]]),
    );
    expect(empty).toMatchObject({ sells_for: '', buyer: '', pay_up_to: '', your_price: '', source: '', stock: null, rule_price: '', profit: '', updated: '' });
  });
});

// ---------------------------------------------------------------------------
// F15: which scrap.tf page a saved page counts for (coverage strip, banks summary, mock)
// ---------------------------------------------------------------------------

describe('batchBankOf and scraptfBankSaves (F15)', () => {
  const MIN = 60_000;
  function batch(id: number, over: Partial<ImportBatch> = {}): ImportBatch {
    return { id, fileName: `page ${id}.html`, pageKind: 'buy', fileMtime: T - id * MIN, importedAt: T - id * MIN + 1_000, itemCount: id, categories: null, bank: null, ...over };
  }
  const never = (): Category[] => {
    throw new Error('the rows are read only for a page without a bank or categories');
  };

  it('takes the recorded bank whatever the page held or its kind', () => {
    expect(batchBankOf(batch(1, { bank: 'stranges', categories: { hats: 9 } }), never)).toBe('stranges');
    expect(batchBankOf(batch(1, { bank: 'items', categories: { hats: 1, weapons: 1, stranges: 1 } }), never)).toBe('items');
    expect(batchBankOf(batch(1, { bank: 'list', pageKind: 'buy', categories: { hats: 2 } }), never)).toBe('list');
    expect(batchBankOf(batch(1, { bank: 'unusuals', pageKind: 'items-list' }), never)).toBe('unusuals');
    // Even with nothing stored (all sold out).
    expect(batchBankOf(batch(1, { bank: 'skins', itemCount: 0 }), never)).toBe('skins');
  });

  it('falls back only without one: the list for an /items page, else the majority of what it stored', () => {
    expect(batchBankOf(batch(1, { pageKind: 'items-list', categories: { hats: 4 } }), never)).toBe('list');
    expect(batchBankOf(batch(1, { categories: { weapons: 2, hats: 1 } }), never)).toBe('weapons');
    expect(batchBankOf(batch(1, { pageKind: 'unusuals', categories: { taunts: 1, other: 1, hats: 1 } }), never)).toBe('items');
    expect(batchBankOf(batch(1, { categories: { hats: 1, weapons: 1, stranges: 1 } }), never)).toBeNull();
    // A 0.4 shape without the field, and garbage in it, read as "no bank".
    const { bank: _drop, ...pre05 } = batch(1, { categories: { killstreaks: 1 } });
    expect(batchBankOf(pre05, never)).toBe('killstreaks');
    expect(batchBankOf(batch(1, { bank: 'shop' as never, categories: { skins: 1 } }), never)).toBe('skins');
    expect(batchBankOf(batch(1, { bank: '__proto__' as never, categories: { skins: 1 } }), never)).toBe('skins');
    // A batch from before 0.3: the rows carrying its id today.
    expect(batchBankOf(batch(7), (id) => (id === 7 ? ['unusuals', 'unusuals', 'hats'] : []))).toBe('unusuals');
    expect(batchBankOf(batch(7), () => [])).toBeNull();
  });

  it('dates each bank by its newest page (file time, ties to the higher id), with that page\'s item count', () => {
    const { bankOf, newest } = scraptfBankSaves(
      [
        batch(1, { bank: 'hats', itemCount: 48 }),
        batch(2, { bank: 'hats', itemCount: 50 }),
        batch(3, { categories: { weapons: 3 }, itemCount: 3 }),
        batch(4, { pageKind: 'items-list', itemCount: 900 }),
        batch(5, { categories: { hats: 1, weapons: 1, stranges: 1 } }),
        batch(6, { bank: 'skins', fileMtime: T, itemCount: 1 }),
        batch(7, { bank: 'skins', fileMtime: T, itemCount: 2 }),
        batch(8, { bank: 'unusuals', fileMtime: 0, importedAt: T - 30 * MIN, itemCount: Number.NaN }),
      ],
      never,
    );
    expect([...bankOf]).toEqual([
      [1, 'hats'],
      [2, 'hats'],
      [3, 'weapons'],
      [4, 'list'],
      [6, 'skins'],
      [7, 'skins'],
      [8, 'unusuals'],
    ]);
    expect(Object.fromEntries(newest)).toEqual({
      hats: { at: T - MIN, id: 1, items: 48 },
      weapons: { at: T - 3 * MIN, id: 3, items: 3 },
      list: { at: T - 4 * MIN, id: 4, items: 900 },
      skins: { at: T, id: 7, items: 2 },
      unusuals: { at: T - 30 * MIN, id: 8, items: 0 },
    });
  });

  it('feeds the coverage strip: the recorded bank, the list counting for no bank page', () => {
    const cov = scraptfCoverage(
      [batch(1, { bank: 'list', pageKind: 'items-list', categories: { hats: 5 } }), batch(2, { bank: 'stranges', categories: { hats: 2 } }), batch(3, { categories: { hats: 1 } })],
      never,
    );
    expect(cov.map((c) => [c.label, c.lastSavedAt, c.items])).toEqual(
      SCRAPTF_BANK_PAGES.map((p) => [p.label, p.bank === 'stranges' ? T - 2 * MIN : p.bank === 'hats' ? T - 3 * MIN : null, p.bank === 'stranges' ? 2 : p.bank === 'hats' ? 3 : 0]),
    );
  });

  it('passes over a bank page that stored nothing (saved without its cards, F18 S3), never over the list', () => {
    expect(isEmptyBankSave({ itemCount: 0 }, 'hats')).toBe(true);
    expect(isEmptyBankSave({ itemCount: 0 }, 'unusuals')).toBe(true);
    expect(isEmptyBankSave({ itemCount: 0 }, 'list')).toBe(false);
    expect(isEmptyBankSave({ itemCount: 3 }, 'hats')).toBe(false);
    // An unreadable count is not a known 0.
    expect(isEmptyBankSave({ itemCount: Number.NaN }, 'hats')).toBe(false);

    const { bankOf, newest } = scraptfBankSaves(
      [
        // Hats: saved with cards 3 minutes ago, then without them a minute ago (newer, ignored).
        batch(1, { bank: 'hats', itemCount: 0 }),
        batch(3, { bank: 'hats', itemCount: 40 }),
        // Skins: only ever saved without cards.
        batch(2, { bank: 'skins', itemCount: 0 }),
        // The list with every row sold out still dates the list.
        batch(4, { bank: 'list', pageKind: 'items-list', itemCount: 0 }),
      ],
      never,
    );
    // The batch keeps its bank (the Import page names it), but no bank is dated by it.
    expect([...bankOf]).toEqual([
      [1, 'hats'],
      [3, 'hats'],
      [2, 'skins'],
      [4, 'list'],
    ]);
    expect(Object.fromEntries(newest)).toEqual({
      hats: { at: T - 3 * MIN, id: 3, items: 40 },
      list: { at: T - 4 * MIN, id: 4, items: 0 },
    });
    const cov = scraptfCoverage([batch(1, { bank: 'hats', itemCount: 0 }), batch(3, { bank: 'hats', itemCount: 40 }), batch(2, { bank: 'skins', itemCount: 0 })], never);
    expect(cov.find((c) => c.label === 'Hats')).toMatchObject({ lastSavedAt: T - 3 * MIN, items: 40 });
    expect(cov.find((c) => c.label === 'Skins')).toMatchObject({ lastSavedAt: null, items: 0 });
  });
});
