import { describe, expect, it } from 'vitest';
import type { GroupSummary, Opportunity } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  compareOpps,
  defaultDir,
  filterOpportunities,
  filtersToQuery,
  flattenGroups,
  groupKeyOf,
  groupLabel,
  groupOpportunities,
  indexOfRow,
  matchesSearch,
  minProfitFor,
  moveCursor,
  sanitizeFilters,
  sortOpportunities,
  statusFor,
  summarizeGroups,
  tierForProfit,
} from '../../src/renderer/oppModel';

const KEY = 568;

function opp(over: Partial<Opportunity> & { key: string }): Opportunity {
  return {
    sku: '378;6',
    name: 'Team Captain',
    category: 'hats',
    inputRef: 'price:1',
    inputKind: 'user',
    costKeys: 0,
    costScrapRaw: 100,
    costScrap: 100,
    bestScrap: 130,
    consScrap: 120,
    instantScrap: 110,
    revenueScrap: 120,
    profitScrap: 20,
    margin: 0.2,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    reasons: [],
    buyerCount: 3,
    bestOrder: null,
    consOrder: null,
    instantOrder: null,
    references: { pricedb: null, community: null },
    profitTier: 'ref2',
    status: 'profitable',
    inputObservedAt: 0,
    firstSeenAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const rows: Opportunity[] = [
  opp({ key: 'a', name: 'Team Captain', category: 'hats', profitScrap: 20, margin: 0.2, confidence: 60, confidenceLevel: 'medium', profitTier: 'ref2', updatedAt: 5 }),
  opp({ key: 'b', sku: '378;5;u13', name: 'Burning Flames Team Captain', category: 'unusuals', profitScrap: 3 * KEY, margin: 0.05, confidence: 30, confidenceLevel: 'low', profitTier: 'key', inputKind: 'import', updatedAt: 9 }),
  opp({ key: 'c', sku: '200;11', name: 'Strange Scattergun', category: 'stranges', profitScrap: 5, margin: 0.18, confidence: 80, confidenceLevel: 'high', profitTier: 'small', inputKind: 'rule', status: 'below-threshold', updatedAt: 1 }),
  opp({ key: 'd', sku: '35;6', name: 'Kritzkrieg', category: 'weapons', profitScrap: null, margin: null, revenueScrap: null, confidence: 40, confidenceLevel: 'low', profitTier: 'none', status: 'no-buyers', updatedAt: 3 }),
  opp({ key: 'e', sku: '1118;6', name: 'Taunt: Conga', category: 'taunts', profitScrap: -9, margin: -0.08, confidence: 50, confidenceLevel: 'medium', profitTier: 'loss', status: 'unprofitable', updatedAt: 7 }),
];

describe('filtering', () => {
  it('matches every search token against name and SKU', () => {
    expect(matchesSearch(rows[1]!, 'flames captain')).toBe(true);
    expect(matchesSearch(rows[1]!, 'u13')).toBe(true);
    expect(matchesSearch(rows[1]!, 'flames scattergun')).toBe(false);
    expect(matchesSearch(rows[1]!, '   ')).toBe(true);
  });

  it('applies every OppQuery filter', () => {
    const keys = (q: Parameters<typeof filterOpportunities>[1]) => filterOpportunities(rows, q).map((o) => o.key);
    expect(keys({})).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(keys({ status: ['profitable'] })).toEqual(['a', 'b']);
    expect(keys({ categories: ['stranges', 'taunts'] })).toEqual(['c', 'e']);
    expect(keys({ tiers: ['key', 'none'] })).toEqual(['b', 'd']);
    expect(keys({ inputKinds: ['rule', 'import'] })).toEqual(['b', 'c']);
    expect(keys({ minConfidence: 50 })).toEqual(['a', 'c', 'e']);
    expect(keys({ search: 'captain', status: ['profitable'], minConfidence: 50 })).toEqual(['a']);
  });

  it('converts filter state to a query without empty fields', () => {
    const q = filtersToQuery({ ...DEFAULT_FILTERS, status: [], search: '  cap ' }, { sort: 'profit', dir: 'desc', groupBy: 'tier', limit: 100 });
    expect(q).toEqual({ sort: 'profit', dir: 'desc', groupBy: 'tier', limit: 100, offset: 0, search: 'cap' });
    const q2 = filtersToQuery({ ...DEFAULT_FILTERS, categories: ['hats'], minConfidence: 45 }, { sort: 'name', dir: 'asc', groupBy: 'category', limit: 10, offset: 20 });
    expect(q2).toMatchObject({ categories: ['hats'], minConfidence: 45, status: ['profitable'], offset: 20 });
  });

  it('counts active filters relative to the defaults', () => {
    expect(activeFilterCount({ ...DEFAULT_FILTERS })).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, search: 'x', tiers: ['key'], status: [] })).toBe(3);
  });

  it('sanitises persisted filters', () => {
    expect(sanitizeFilters(null)).toEqual({ ...DEFAULT_FILTERS });
    expect(
      sanitizeFilters({ search: 5, categories: ['hats', 'nope'], tiers: ['key', 1], minConfidence: 250, inputKinds: 'user', status: ['gone', 'no-buyers'] }),
    ).toEqual({ search: '', categories: ['hats'], tiers: ['key'], minConfidence: 100, inputKinds: [], status: ['no-buyers'] });
  });
});

describe('sorting', () => {
  it('sorts by profit with nulls last in both directions', () => {
    expect(sortOpportunities(rows, 'profit', 'desc').map((o) => o.key)).toEqual(['b', 'a', 'c', 'e', 'd']);
    expect(sortOpportunities(rows, 'profit', 'asc').map((o) => o.key)).toEqual(['e', 'c', 'a', 'b', 'd']);
  });

  it('sorts by name, margin, confidence and updated', () => {
    expect(sortOpportunities(rows, 'name', 'asc').map((o) => o.key)).toEqual(['b', 'd', 'c', 'e', 'a']);
    expect(sortOpportunities(rows, 'margin', 'desc').map((o) => o.key)).toEqual(['a', 'c', 'b', 'e', 'd']);
    expect(sortOpportunities(rows, 'confidence', 'desc').map((o) => o.key)).toEqual(['c', 'a', 'e', 'd', 'b']);
    expect(sortOpportunities(rows, 'updated', 'desc').map((o) => o.key)).toEqual(['b', 'e', 'a', 'd', 'c']);
  });

  it('breaks ties by name then key, and does not mutate the input', () => {
    const tied = [opp({ key: 'z', name: 'B', profitScrap: 1 }), opp({ key: 'y', name: 'A', profitScrap: 1 }), opp({ key: 'x', name: 'A', profitScrap: 1 })];
    const copy = [...tied];
    expect(sortOpportunities(tied, 'profit', 'desc').map((o) => o.key)).toEqual(['x', 'y', 'z']);
    expect(tied).toEqual(copy);
    expect(compareOpps('profit', 'desc')(tied[0]!, tied[0]!)).toBe(0);
  });

  it('defaults to descending except for names', () => {
    expect(defaultDir('name')).toBe('asc');
    expect(defaultDir('profit')).toBe('desc');
  });
});

describe('grouping', () => {
  it('keys and labels groups', () => {
    expect(groupKeyOf(rows[1]!, 'tier')).toBe('key');
    expect(groupKeyOf(rows[2]!, 'input')).toBe('rule');
    expect(groupLabel('tier', 'ref10')).toBe('10 ref to 1 key');
    expect(groupLabel('input', 'rule')).toMatch(/Candidates/);
    expect(groupLabel('category', 'unusuals')).toBe('Unusuals');
    expect(groupLabel('confidence', 'high')).toBe('High');
  });

  it('summarises groups in display order with summed profit', () => {
    const g = summarizeGroups(rows, 'confidence');
    expect(g.map((x) => [x.key, x.count, x.totalProfitScrap])).toEqual([
      ['high', 1, 5],
      ['medium', 2, 11],
      ['low', 2, 3 * KEY],
    ]);
    expect(summarizeGroups(rows, 'tier').map((x) => x.key)).toEqual(['key', 'ref2', 'small', 'loss', 'none']);
  });

  it('keeps row order inside groups and prefers server counts', () => {
    const sorted = sortOpportunities(rows, 'profit', 'desc');
    const server: GroupSummary[] = [
      { by: 'category', key: 'hats', label: 'Hats & cosmetics', count: 40, totalProfitScrap: 999 },
      { by: 'category', key: 'skins', label: 'Skins & war paints', count: 3, totalProfitScrap: 50 },
      { by: 'tier', key: 'key', label: 'ignored', count: 1, totalProfitScrap: 1 },
    ];
    const groups = groupOpportunities(sorted, 'category', server);
    expect(groups.map((g) => g.key)).toEqual(['hats', 'weapons', 'stranges', 'skins', 'unusuals', 'taunts']);
    const hats = groups.find((g) => g.key === 'hats')!;
    expect(hats).toMatchObject({ count: 40, totalProfitScrap: 999 });
    expect(hats.rows.map((o) => o.key)).toEqual(['a']);
    expect(groups.find((g) => g.key === 'skins')).toMatchObject({ count: 3, rows: [] });
    expect(groups.find((g) => g.key === 'taunts')).toMatchObject({ count: 1, totalProfitScrap: -9 });
  });

  it('flattens groups and honours collapsed keys', () => {
    const groups = groupOpportunities(rows, 'confidence');
    const all = flattenGroups(groups, new Set());
    expect(all.map((r) => r.id)).toEqual(['group:high', 'c', 'group:medium', 'a', 'e', 'group:low', 'b', 'd']);
    const folded = flattenGroups(groups, new Set(['medium']));
    expect(folded.map((r) => r.id)).toEqual(['group:high', 'c', 'group:medium', 'group:low', 'b', 'd']);
    const header = folded[2]!;
    expect(header.type === 'group' && header.collapsed).toBe(true);
  });

  it('moves a keyboard cursor within bounds', () => {
    const list = flattenGroups(groupOpportunities(rows, 'confidence'), new Set());
    expect(indexOfRow(list, 'a')).toBe(3);
    expect(indexOfRow(list, null)).toBe(-1);
    expect(moveCursor(list, -1, 1)).toBe(0);
    expect(moveCursor(list, -1, -1)).toBe(list.length - 1);
    expect(moveCursor(list, 2, 100)).toBe(list.length - 1);
    expect(moveCursor(list, 2, -100)).toBe(0);
    expect(moveCursor([], 0, 1)).toBe(-1);
  });
});

describe('tiers and status', () => {
  it('uses the brief tier boundaries', () => {
    expect(tierForProfit(null, KEY)).toBe('none');
    expect(tierForProfit(0, KEY)).toBe('loss');
    expect(tierForProfit(-5, KEY)).toBe('loss');
    expect(tierForProfit(17, KEY)).toBe('small');
    expect(tierForProfit(18, KEY)).toBe('ref2');
    expect(tierForProfit(89, KEY)).toBe('ref2');
    expect(tierForProfit(90, KEY)).toBe('ref10');
    expect(tierForProfit(KEY - 1, KEY)).toBe('ref10');
    expect(tierForProfit(KEY, KEY)).toBe('key');
  });

  it('applies min profit, percent of cost and margin thresholds', () => {
    const p = DEFAULT_SETTINGS.profit;
    expect(minProfitFor(100, p)).toBe(9);
    expect(minProfitFor(1000, p)).toBe(50);
    expect(statusFor(null, 100, p)).toBe('no-buyers');
    expect(statusFor(0, 100, p)).toBe('unprofitable');
    expect(statusFor(8, 100, p)).toBe('below-threshold');
    expect(statusFor(9, 100, p)).toBe('profitable');
    expect(statusFor(49, 1000, p)).toBe('below-threshold');
    expect(statusFor(80, 1000, p)).toBe('profitable');
    expect(statusFor(60, 1000, { ...p, minMargin: 0.1 })).toBe('below-threshold');
    expect(statusFor(10, 0, p)).toBe('profitable');
  });
});
