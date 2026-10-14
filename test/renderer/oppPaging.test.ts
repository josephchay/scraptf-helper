import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import {
  DEFAULT_FILTERS,
  GROUP_PAGE,
  MAX_GROUP_ROWS,
  emptyListReason,
  filtersToQuery,
  flattenGroups,
  groupKeyOf,
  groupOpportunities,
  groupPageQuery,
  mergeLoadedRows,
  nextGroupPageSize,
  orderByGroup,
  sortOpportunities,
  type OppGroup,
} from '../../src/renderer/oppModel';
import type { GroupBy, GroupSummary, OppQuery, Opportunity } from '../../src/shared/types';

function opp(key: string, over: Partial<Opportunity> = {}): Opportunity {
  return {
    key,
    sku: '378;6',
    name: key,
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
    maxCostScrap: null,
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

/**
 * The service's paging of a grouped list (repo.queryOpportunities + views.listOpportunities):
 * filters, then group display order first and the sort inside each group, then offset/limit.
 */
function service(all: Opportunity[]) {
  const calls: OppQuery[] = [];
  const list = (q: OppQuery) => {
    calls.push(q);
    const matching = all.filter(
      (o) =>
        (!q.categories?.length || q.categories.includes(o.category)) &&
        (!q.tiers?.length || q.tiers.includes(o.profitTier)) &&
        (!q.inputKinds?.length || q.inputKinds.includes(o.inputKind)) &&
        (q.minConfidence === undefined || o.confidence >= q.minConfidence),
    );
    const by = q.groupBy as GroupBy;
    const rows = orderByGroup(sortOpportunities(matching, q.sort, q.dir), by);
    const groups: GroupSummary[] = groupOpportunities(rows, by).map((g) => ({ by, key: g.key, label: g.label, count: g.count, totalProfitScrap: g.totalProfitScrap }));
    const offset = q.offset ?? 0;
    return { rows: rows.slice(offset, offset + (q.limit ?? 500)), total: rows.length, groups };
  };
  return { calls, list };
}

const query = (groupBy: GroupBy, limit: number): OppQuery => filtersToQuery({ ...DEFAULT_FILTERS, status: [] }, { sort: 'profit', dir: 'desc', groupBy, limit });

describe('grouped list past one page ("Load more" per group)', () => {
  // 30 hats with low profit, then 5 weapons that are the most profitable of all.
  const hats = Array.from({ length: 30 }, (_, i) => opp(`hat${i}`, { category: 'hats', profitScrap: 10 + i, confidence: 80, confidenceLevel: 'high' }));
  const weapons = Array.from({ length: 5 }, (_, i) => opp(`wpn${i}`, { category: 'weapons', profitScrap: 500 + i, inputKind: 'import', confidence: 50, confidenceLevel: 'medium' }));
  const all = [...hats, ...weapons];

  it('reproduces the problem: the first group uses the whole page and a later group shows a count but no rows', () => {
    const s = service(all);
    const first = s.list(query('category', 20));
    const groups = groupOpportunities(first.rows, 'category', first.groups);
    expect(groups.find((g) => g.key === 'weapons')).toMatchObject({ count: 5, rows: [] });
    // Before: the group header was the only row; now a "Load more" row follows it.
    const display = flattenGroups(groups, new Set());
    expect(display.filter((r) => r.type === 'more').map((r) => r.id)).toEqual(['more:hats', 'more:weapons']);
  });

  it.each<[GroupBy, keyof OppQuery | null]>([
    ['category', 'categories'],
    ['input', 'inputKinds'],
    ['confidence', null],
  ])('loads the rows of a later group when grouped by %s', (by, filterKey) => {
    const s = service(all);
    const first = s.list(query(by, 20));
    const firstPage = groupOpportunities(first.rows, by, first.groups);
    const key = groupKeyOf(weapons[0]!, by);
    expect(firstPage.find((g) => g.key === key)?.rows).toEqual([]);

    const q = groupPageQuery(query(by, 20), by, key, firstPage, GROUP_PAGE)!;
    if (filterKey) expect(q[filterKey]).toEqual([key]);
    const page = s.list(q).rows.filter((o) => groupKeyOf(o, by) === key);
    expect(page.map((o) => o.key)).toEqual(['wpn4', 'wpn3', 'wpn2', 'wpn1', 'wpn0']);

    const merged = groupOpportunities(sortOpportunities(mergeLoadedRows(first.rows, { [key]: page }), 'profit', 'desc'), by, first.groups);
    const g = merged.find((x) => x.key === key)!;
    expect(g.rows).toHaveLength(g.count);
    expect(flattenGroups(merged, new Set()).some((r) => r.id === `more:${key}`)).toBe(false);
  });

  it('continues a group the first page cut off, without repeating its rows', () => {
    const s = service(all);
    const first = s.list(query('category', 20));
    const firstPage = groupOpportunities(first.rows, 'category', first.groups);
    const q = groupPageQuery(query('category', 20), 'category', 'hats', firstPage, GROUP_PAGE)!;
    expect(q).toMatchObject({ offset: 20, limit: 10, categories: ['hats'] });
    const rest = s.list(q).rows;
    const merged = mergeLoadedRows(first.rows, { hats: rest });
    expect(new Set(merged.map((o) => o.key)).size).toBe(30);
  });

  it('asks for nothing when a group is complete, unknown or at the per-group maximum', () => {
    const g = (key: string, loaded: number, count: number): OppGroup => ({
      key,
      label: key,
      count,
      totalProfitScrap: 0,
      rows: Array.from({ length: loaded }, (_, i) => opp(`${key}${i}`)),
    });
    const base = query('category', 20);
    expect(groupPageQuery(base, 'category', 'hats', [g('hats', 3, 3)], GROUP_PAGE)).toBeNull();
    expect(groupPageQuery(base, 'category', 'nope', [g('nope', 0, 3)], GROUP_PAGE)).toBeNull();
    expect(groupPageQuery(base, 'category', 'hats', [g('hats', 0, 3)], 0)).toBeNull();
    expect(groupPageQuery(base, 'category', 'hats', [g('hats', MAX_GROUP_ROWS - 2, MAX_GROUP_ROWS + 100)], GROUP_PAGE)?.limit).toBe(2);
    const capped = flattenGroups([g('hats', MAX_GROUP_ROWS, MAX_GROUP_ROWS + 1)], new Set()).at(-1)!;
    expect(capped.type === 'more' && capped.capped).toBe(true);
  });

  it('labels "Load N more" with what the next click really adds, also near the per-group maximum', () => {
    const g = (loaded: number, count: number) => ({ count, rows: Array.from({ length: loaded }, (_, i) => opp(`h${i}`)) });
    expect(nextGroupPageSize(g(0, 10_000))).toBe(GROUP_PAGE);
    expect(nextGroupPageSize(g(20, 30))).toBe(10);
    // 200 rows short of the maximum in a group of 10,000: a click adds 200, not 500.
    const near = g(MAX_GROUP_ROWS - 200, 10_000);
    expect(nextGroupPageSize(near)).toBe(200);
    const group: OppGroup = { key: 'hats', label: 'Hats', totalProfitScrap: 0, ...near };
    expect(groupPageQuery(query('category', 20), 'category', 'hats', [group], GROUP_PAGE)?.limit).toBe(200);
    expect(nextGroupPageSize(g(MAX_GROUP_ROWS, 10_000))).toBe(0);
  });

  it('the mock bridge pages a grouped list in group order, like the service', async () => {
    bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => Date.UTC(2026, 9, 14, 12) });
    const full = await bridge.rpc('opps.list', { groupBy: 'category', sort: 'profit', dir: 'desc', limit: 5000 });
    const keys = full.rows.map((o) => o.category);
    const order = full.groups.map((x) => x.key);
    expect(keys).toEqual([...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    const firstPage = groupOpportunities([], 'category', full.groups);
    const last = full.groups.at(-1)!;
    const q = groupPageQuery({ groupBy: 'category', sort: 'profit', dir: 'desc', limit: 5 }, 'category', last.key, firstPage, GROUP_PAGE)!;
    const page = await bridge.rpc('opps.list', q);
    expect(page.rows.length).toBe(Math.min(last.count, GROUP_PAGE));
    expect(page.rows.every((o) => o.category === last.key)).toBe(true);
  });
});

let bridge: MockBridge | null = null;
afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('empty Opportunities list', () => {
  it('explains the default "profitable only" filter when opportunities exist, instead of "Nothing to show yet"', () => {
    const defaults = { ...DEFAULT_FILTERS, status: [...DEFAULT_FILTERS.status] };
    expect(emptyListReason(defaults, 42)).toBe('status-hidden');
    expect(emptyListReason(defaults, 0)).toBe('nothing-yet');
    expect(emptyListReason(defaults, null)).toBe('nothing-yet');
    expect(emptyListReason({ ...defaults, search: 'rocket' }, 42)).toBe('filters');
    expect(emptyListReason({ ...defaults, status: [] }, 42)).toBe('filters');
  });
});
