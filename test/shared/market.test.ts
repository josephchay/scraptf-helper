// F10 shared rules: the verdict, filters, order, paging and CSV cells that the
// service's market index, the browser mock and the dashboard all use.

import { describe, expect, it } from 'vitest';
import {
  MARKET_CSV_COLUMNS,
  MARKET_DEFAULT_LIMIT,
  MARKET_MAX_LIMIT,
  emptyMarketCounts,
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
} from '../../src/shared/market';
import { MARKET_VERDICTS, type MarketRow, type OrderSummary } from '../../src/shared/types';

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
    });
    const empty = Object.fromEntries(
      MARKET_CSV_COLUMNS.map((c, i) => [c, marketCsvCells(row({ revenueOrder: null, revenueScrap: null, maxCostScrap: null, lastOrderChangeAt: null }), null)[i]]),
    );
    expect(empty).toMatchObject({ sells_for: '', buyer: '', pay_up_to: '', your_price: '', source: '', stock: null, rule_price: '', profit: '', updated: '' });
  });
});
