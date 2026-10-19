import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { isAllowedExternalUrl, scraptfPageFor } from '../../src/shared/links';
import type { OrderSummary, ShoppingListResult, ShoppingRow } from '../../src/shared/types';
import { CATEGORIES, CATEGORY_LABELS } from '../../src/shared/types';
import {
  DEFAULT_SHOPPING_FILTERS,
  MAX_SEARCH_CHARS,
  MIN_CEILING_PRESETS,
  activeShoppingFilterCount,
  bankPageOf,
  bankPageText,
  buyerKindLabel,
  compareShoppingRows,
  countUnderCeiling,
  defaultShoppingFilters,
  emptyShoppingReason,
  flattenShoppingGroups,
  groupShoppingRows,
  readMinCeiling,
  sanitizeCollapsedCategories,
  sanitizeShoppingFilters,
  sellsForTitle,
  shoppingExportQuery,
  shoppingQuery,
  shoppingRowId,
  thresholdSummary,
  yourPriceAge,
  yourPriceStale,
  yourPriceTitle,
  yourPriceTone,
} from '../../src/renderer/shoppingModel';

const KEY = 568;

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'BuyBot',
    keys: 0,
    metalScrap: 120,
    valueScrap: 120,
    isBot: true,
    online: true,
    lastEventAt: 0,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function row(over: Partial<ShoppingRow> & { sku: string }): ShoppingRow {
  const category = over.category ?? 'hats';
  return {
    name: 'Team Captain',
    category,
    bankPageUrl: scraptfPageFor(category),
    maxCostScrap: 100,
    revenueScrap: 120,
    revenueOrder: order(),
    confidence: 60,
    confidenceLevel: 'medium',
    buyerCount: 3,
    knownCostScrap: null,
    knownMaxCostScrap: null,
    underCeiling: null,
    inputKinds: ['rule'],
    flags: [],
    updatedAt: 0,
    ...over,
  };
}

describe('filters', () => {
  it('starts empty and hands out fresh copies', () => {
    const a = defaultShoppingFilters();
    a.categories.push('hats');
    expect(defaultShoppingFilters().categories).toEqual([]);
    expect(DEFAULT_SHOPPING_FILTERS.categories).toEqual([]);
    expect(activeShoppingFilterCount(defaultShoppingFilters())).toBe(0);
  });

  it('sanitises persisted filters', () => {
    expect(sanitizeShoppingFilters(null)).toEqual(defaultShoppingFilters());
    expect(sanitizeShoppingFilters('junk')).toEqual(defaultShoppingFilters());
    expect(
      sanitizeShoppingFilters({ search: 'cap', categories: ['hats', 'nope', 'hats', 3], minCeiling: '2 ref', onlyBotBuyers: 'yes' }),
    ).toEqual({ search: 'cap', categories: ['hats'], minCeiling: '2 ref', onlyBotBuyers: false });
    expect(sanitizeShoppingFilters({ onlyBotBuyers: true }).onlyBotBuyers).toBe(true);
    // Over-long text from a hand-edited store is cut to what the service accepts.
    expect(sanitizeShoppingFilters({ search: 'x'.repeat(500) }).search).toHaveLength(MAX_SEARCH_CHARS);
    expect(sanitizeShoppingFilters({ minCeiling: '9'.repeat(100) }).minCeiling.length).toBeLessThanOrEqual(40);
  });

  it('counts active filters', () => {
    expect(activeShoppingFilterCount({ search: ' ', categories: [], minCeiling: '  ', onlyBotBuyers: false })).toBe(0);
    expect(activeShoppingFilterCount({ search: 'a', categories: ['hats'], minCeiling: '1 ref', onlyBotBuyers: true })).toBe(4);
    expect(emptyShoppingReason(defaultShoppingFilters())).toBe('nothing-yet');
    expect(emptyShoppingReason({ ...defaultShoppingFilters(), onlyBotBuyers: true })).toBe('filters');
  });

  it('reads the minimum ceiling as traders type it', () => {
    expect(readMinCeiling('', KEY)).toEqual({ scrap: null, error: null });
    expect(readMinCeiling('   ', null)).toEqual({ scrap: null, error: null });
    expect(readMinCeiling('2', KEY)).toEqual({ scrap: 18, error: null });
    expect(readMinCeiling('1.33 ref', KEY)).toEqual({ scrap: 12, error: null });
    expect(readMinCeiling('14 scrap', KEY)).toEqual({ scrap: 14, error: null });
    expect(readMinCeiling('1 key', KEY)).toEqual({ scrap: KEY, error: null });
    expect(readMinCeiling('1 key 2 ref', KEY)).toEqual({ scrap: KEY + 18, error: null });
    expect(readMinCeiling('1 key', null).scrap).toBeNull();
    expect(readMinCeiling('1 key', null).error).toMatch(/key price/);
    expect(readMinCeiling('lots', KEY).scrap).toBeNull();
    expect(readMinCeiling('lots', KEY).error).toMatch(/Enter a price/);
    for (const preset of MIN_CEILING_PRESETS) expect(readMinCeiling(preset, KEY).scrap).toBeGreaterThan(0);
  });

  it('builds the service query without empty fields', () => {
    expect(shoppingQuery(defaultShoppingFilters(), null)).toEqual({});
    expect(shoppingQuery({ search: '  team cap ', categories: ['hats', 'unusuals'], minCeiling: '2', onlyBotBuyers: true }, 18, { limit: 5000 })).toEqual({
      search: 'team cap',
      categories: ['hats', 'unusuals'],
      minCeilingScrap: 18,
      onlyBotBuyers: true,
      limit: 5000,
      offset: 0,
    });
    // A zero minimum is no minimum.
    expect(shoppingQuery(defaultShoppingFilters(), 0)).toEqual({});
    expect(shoppingQuery({ ...defaultShoppingFilters(), search: 'y'.repeat(300) }, null).search).toHaveLength(MAX_SEARCH_CHARS);
  });

  it('exports every match: the same filters without paging', () => {
    const q = shoppingQuery({ search: 'cap', categories: ['hats'], minCeiling: '', onlyBotBuyers: true }, null, { limit: 5000, offset: 100 });
    expect(shoppingExportQuery(q)).toEqual({ search: 'cap', categories: ['hats'], onlyBotBuyers: true });
    expect(q.limit).toBe(5000);
  });
});

describe('grouping by bank page', () => {
  const rows: ShoppingRow[] = [
    row({ sku: '5;6', name: 'B unusual', category: 'unusuals', maxCostScrap: 900 }),
    row({ sku: '1;6', name: 'Hat B', maxCostScrap: 50 }),
    row({ sku: '2;6', name: 'Hat A', maxCostScrap: 80 }),
    row({ sku: '3;6', name: 'Hat C', maxCostScrap: 50 }),
    row({ sku: '4;11', name: 'Strange thing', category: 'stranges', maxCostScrap: 30 }),
  ];

  it('orders categories as CATEGORIES and rows by ceiling, then name', () => {
    const groups = groupShoppingRows(rows);
    expect(groups.map((g) => g.category)).toEqual(['hats', 'stranges', 'unusuals']);
    expect(groups[0]!.rows.map((r) => r.sku)).toEqual(['2;6', '1;6', '3;6']);
    expect(groups[0]).toMatchObject({ label: CATEGORY_LABELS.hats, count: 3, bankPageUrl: scraptfPageFor('hats') });
    expect([...rows].sort(compareShoppingRows).map((r) => r.sku)).toEqual(['5;6', '2;6', '1;6', '3;6', '4;11']);
  });

  it('breaks ceiling ties like the service: name without case, then SKU', () => {
    const tied = [row({ sku: '9;6', name: 'b hat' }), row({ sku: '8;6', name: 'B Hat' }), row({ sku: '7;6', name: 'a hat' })];
    expect([...tied].sort(compareShoppingRows).map((r) => r.sku)).toEqual(['7;6', '8;6', '9;6']);
  });

  it('prefers server counts and keeps server-only groups', () => {
    const server: ShoppingListResult['groups'] = [
      { category: 'hats', label: 'Hats (server)', count: 40, bankPageUrl: scraptfPageFor('hats') },
      { category: 'taunts', label: 'Taunts', count: 2, bankPageUrl: scraptfPageFor('taunts') },
      { category: 'skins', label: 'Skins', count: 0, bankPageUrl: scraptfPageFor('skins') },
    ];
    const groups = groupShoppingRows(rows, server);
    expect(groups.map((g) => g.category)).toEqual(['hats', 'stranges', 'unusuals', 'taunts']);
    expect(groups[0]).toMatchObject({ label: 'Hats (server)', count: 40 });
    expect(groups[3]).toMatchObject({ count: 2, rows: [], bankPageUrl: scraptfPageFor('taunts') });
    // A server count below the loaded rows never hides rows.
    expect(groupShoppingRows(rows, [{ category: 'hats', label: 'Hats', count: 1, bankPageUrl: scraptfPageFor('hats') }])[0]!.count).toBe(3);
  });

  it('flattens groups with collapsed categories and capped groups', () => {
    const groups = groupShoppingRows(rows, [{ category: 'stranges', label: 'Stranges', count: 7, bankPageUrl: scraptfPageFor('stranges') }]);
    const all = flattenShoppingGroups(groups, new Set());
    expect(all.map((r) => r.id)).toEqual([
      'group:hats',
      shoppingRowId('2;6'),
      shoppingRowId('1;6'),
      shoppingRowId('3;6'),
      'group:stranges',
      shoppingRowId('4;11'),
      'more:stranges',
      'group:unusuals',
      shoppingRowId('5;6'),
    ]);
    const folded = flattenShoppingGroups(groups, new Set(['hats', 'stranges']));
    expect(folded.map((r) => r.id)).toEqual(['group:hats', 'group:stranges', 'group:unusuals', shoppingRowId('5;6')]);
    const head = folded[0]!;
    expect(head.type === 'group' && head.collapsed).toBe(true);
  });

  it('finds the bank page behind any row, and only static allowlisted pages', () => {
    const flat = flattenShoppingGroups(groupShoppingRows(rows), new Set());
    expect(bankPageOf(undefined)).toBeNull();
    for (const r of flat) {
      const url = bankPageOf(r)!;
      expect(isAllowedExternalUrl(url)).toBe(true);
      expect(url).toBe(scraptfPageFor(r.type === 'item' ? r.row.category : r.group.category));
    }
    for (const c of CATEGORIES) expect(bankPageText(scraptfPageFor(c))).toMatch(/^scrap\.tf\//);
  });

  it('restores collapsed categories defensively', () => {
    expect(sanitizeCollapsedCategories(['hats', 'hats', 'nope', 1])).toEqual(['hats']);
    expect(sanitizeCollapsedCategories({})).toEqual([]);
  });
});

describe('cells', () => {
  it('colours your price against the ceiling', () => {
    expect(yourPriceTone({ underCeiling: true })).toBe('good');
    expect(yourPriceTone({ underCeiling: false })).toBe('bad');
    expect(yourPriceTone({ underCeiling: null })).toBeNull();
    expect(countUnderCeiling([row({ sku: 'a', underCeiling: true }), row({ sku: 'b', underCeiling: false }), row({ sku: 'c' })])).toBe(1);
  });

  it('counts only fresh prices as at or under the ceiling, and says how old each is (ACT-9)', () => {
    const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
    const H = 3_600_000;
    const fresh = row({ sku: 'a', underCeiling: true, knownCostScrap: 91, knownObservedAt: NOW - H, knownStock: 3, knownStale: false });
    const stale = row({ sku: 'b', underCeiling: true, knownCostScrap: 91, knownObservedAt: NOW - 3 * H, knownStock: 1, knownStale: true });
    expect(countUnderCeiling([fresh, stale])).toBe(1);
    expect(yourPriceStale(stale)).toBe(true);
    expect(yourPriceStale(fresh)).toBe(false);
    // No green for a stale price at or under it; over it stays red.
    expect(yourPriceTone(stale)).toBeNull();
    expect(yourPriceTone({ underCeiling: false, knownStale: true })).toBe('bad');
    expect(yourPriceTone(fresh)).toBe('good');
    expect(yourPriceAge(fresh, NOW)).toEqual({ text: '1 h ago', stale: false });
    expect(yourPriceAge(stale, NOW)).toEqual({ text: '3 h ago', stale: true });
    // A time a little ahead of the clock is now.
    expect(yourPriceAge({ knownCostScrap: 91, knownObservedAt: NOW + 60_000 }, NOW)!.text).toBe('just now');
    // The title: when it was seen, its stock then, and why a stale one is not counted.
    const t = yourPriceTitle({ ...stale, knownMaxCostScrap: 100, maxCostScrap: 100 }, KEY);
    expect(t).toContain('1.00 ref under the ceiling');
    expect(t).toContain('1 in stock then.');
    expect(t).toContain('not counted as at or under the ceiling');
    // An older service (no fields): counted and coloured as before, no age.
    const before = row({ sku: 'c', underCeiling: true, knownCostScrap: 91 });
    expect(countUnderCeiling([before])).toBe(1);
    expect(yourPriceTone(before)).toBe('good');
    expect(yourPriceAge(before, NOW)).toBeNull();
    expect(yourPriceAge(row({ sku: 'd', knownCostScrap: null, knownObservedAt: NOW }), NOW)).toBeNull();
    expect(yourPriceTitle({ knownCostScrap: 91, knownMaxCostScrap: 100, maxCostScrap: 100 }, KEY)).toBe('Your latest scrap.tf price is 1.00 ref under the ceiling: a flip at that price.');
  });

  it('explains your price relative to the ceiling', () => {
    expect(yourPriceTitle({ knownCostScrap: null, knownMaxCostScrap: null, maxCostScrap: 100 }, KEY)).toMatch(/only a price-sheet rule/);
    expect(yourPriceTitle({ knownCostScrap: 91, knownMaxCostScrap: 100, maxCostScrap: 100 }, KEY)).toContain('1.00 ref under the ceiling');
    expect(yourPriceTitle({ knownCostScrap: 100, knownMaxCostScrap: 100, maxCostScrap: 100 }, KEY)).toMatch(/exactly the ceiling/);
    expect(yourPriceTitle({ knownCostScrap: 109, knownMaxCostScrap: 100, maxCostScrap: 100 }, KEY)).toContain('1.00 ref over the ceiling');
  });

  it("judges your price against its own copy's ceiling, never another copy's", () => {
    // A plain copy priced 150 under a painted copy's 185 ceiling, while the plain copy's own ceiling is 91.
    const t = yourPriceTitle({ knownCostScrap: 150, knownMaxCostScrap: 91, maxCostScrap: 185 }, KEY);
    expect(t).toContain('6.55 ref over');
    expect(t).toContain("that copy's own ceiling (10.11 ref)");
    expect(t).toMatch(/not a flip/);
    expect(yourPriceTitle({ knownCostScrap: 150, knownMaxCostScrap: null, maxCostScrap: 185 }, KEY)).toMatch(/not a flip/);
  });

  it('describes the buyer behind the revenue', () => {
    expect(buyerKindLabel({ isBot: true })).toBe('Bot');
    expect(buyerKindLabel({ isBot: false })).toBe('Human');
    const bot = sellsForTitle(row({ sku: 'a', revenueScrap: 18, buyerCount: 1 }), KEY);
    expect(bot).toBe('Sells for 2.00 ref to BuyBot (bot, online). 1 buyer with eligible orders.');
    const human = sellsForTitle(row({ sku: 'a', revenueOrder: order({ isBot: false, online: null, userName: null }), buyerCount: 4 }), KEY);
    expect(human).toContain('to 76561198000000001 (human, online status unknown)');
    expect(human).toContain('4 buyers');
    expect(sellsForTitle(row({ sku: 'a', revenueOrder: null }), KEY)).toMatch(/^Sells for [\d.]+ ref\. 3 buyers/);
  });

  it('summarises the thresholds behind every ceiling', () => {
    expect(thresholdSummary(DEFAULT_SETTINGS.profit, KEY)).toBe(
      'a profit of at least 1.00 ref and 5% of the cost, a margin of at least 8%, against the conservative buy order',
    );
    expect(
      thresholdSummary({ minProfitScrap: 18, minProfitPctOfCost: 0, minMargin: 0.125, frictionScrap: 2, useOrder: 'instant' }, KEY),
    ).toBe('a profit of at least 2.00 ref, a margin of at least 12.5%, after 0.22 ref friction, against the instant buy order');
    // No fixed minimum: the engine still needs a positive profit, so never "at least 0.00 ref".
    expect(thresholdSummary({ minProfitScrap: 0, minProfitPctOfCost: 0.1, minMargin: 0, frictionScrap: 0, useOrder: 'best' }, KEY)).toBe(
      'a profit of at least 10% of the cost, against the best buy order',
    );
    expect(thresholdSummary({ minProfitScrap: 0, minProfitPctOfCost: 0, minMargin: 0, frictionScrap: 0, useOrder: 'conservative' }, KEY)).toBe(
      'any profit, against the conservative buy order',
    );
  });
});
