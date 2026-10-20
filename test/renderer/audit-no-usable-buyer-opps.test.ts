// 0.7.3 (r4-wording-1): an opportunity with eligible buyers but no revenue (every order an outlier, or
// Revenue used for profit on Instant and no realistic bot order) had a Pay up to hover saying "No eligible
// buy orders, so there is no ceiling." and a Profit hover saying "No eligible buy orders", though the
// Buyers column next to them counts the buyers. Both now say why none is usable, from the row's
// buyerCount and flags (as the item panel's noRevenueTextOf and the Live market's Pay up to hover).
// Pure, plus the grid rendered server-side. No network.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OppTable } from '../../src/renderer/components/OppTable';
import { flattenGroups, payUpToTitle, type DisplayRow } from '../../src/renderer/oppModel';
import { noRevenueTextOf } from '../../src/renderer/quickModel';
import type { Opportunity } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const K = 568;
const noop = () => undefined;

/** Three human buyers, none usable: no revenue, profit or ceiling. */
function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    key: 'price:1',
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
    instantScrap: null,
    revenueScrap: null,
    profitScrap: null,
    margin: null,
    maxCostScrap: null,
    confidence: 30,
    confidenceLevel: 'low',
    flags: [],
    reasons: [],
    buyerCount: 3,
    bestOrder: null,
    consOrder: null,
    instantOrder: null,
    references: { pricedb: null, community: null },
    profitTier: 'none',
    status: 'no-buyers',
    inputObservedAt: T0,
    firstSeenAt: T0,
    updatedAt: T0,
    ...over,
  };
}

describe('Opportunities: Pay up to without a usable buyer', () => {
  it('names Instant when no flag says every order is an outlier', () => {
    expect(payUpToTitle(opp(), K)).toBe('No realistic bot order, and Revenue used for profit is Instant (bot orders only), so there is no ceiling.');
  });

  it("says every order looks unrealistic for 'all-outliers'", () => {
    expect(payUpToTitle(opp({ flags: ['all-outliers'], consScrap: null }), K)).toBe('Every eligible order looks unrealistic, so there is no ceiling.');
  });

  it('is unchanged without buyers, with a revenue, and for a caller that passes no buyers', () => {
    expect(payUpToTitle(opp({ buyerCount: 0 }), K)).toBe('No eligible buy orders, so there is no ceiling.');
    expect(payUpToTitle(opp({ revenueScrap: 120 }), K)).toBe('No scrap.tf price clears your thresholds against this revenue.');
    expect(payUpToTitle({ maxCostScrap: null, costScrap: 100, revenueScrap: null, inputKind: 'user' }, K)).toBe('No eligible buy orders, so there is no ceiling.');
  });
});

describe('Opportunities grid, rendered', () => {
  const html = (o: Opportunity): string => {
    const rows: DisplayRow[] = flattenGroups([{ key: 'hats', label: 'Hats', count: 1, totalProfitScrap: 0, rows: [o] }], new Set());
    return renderToString(
      createElement(OppTable, {
        rows,
        keyScrap: K,
        now: T0,
        staleMs: 3_600_000,
        density: 'comfortable',
        useOrder: 'instant',
        selectedId: null,
        onSelect: noop,
        onOpen: noop,
        onToggleGroup: noop,
        sort: 'profit',
        dir: 'desc',
        onSort: noop,
      }),
    );
  };
  const cellTitle = (h: string, cls: string): string | null => new RegExp(`role="gridcell" class="${cls} num"><span class="money[^"]*" title="([^"]*)"`).exec(h)?.[1] ?? null;

  it('the Profit and Pay up to hovers say why the buyers give no revenue', () => {
    for (const flags of [[], ['all-outliers']]) {
      const o = opp({ flags });
      const h = html(o);
      expect(cellTitle(h, 'c-profit')).toBe(noRevenueTextOf(o));
      expect(cellTitle(h, 'c-pay')).toBe(payUpToTitle(o, K));
      expect(h).not.toContain('No eligible buy orders');
    }
    expect(cellTitle(html(opp()), 'c-profit')).toBe('3 buyers, but none is a realistic bot order, and Revenue used for profit is Instant (bot orders only)');
    expect(cellTitle(html(opp({ flags: ['all-outliers'] })), 'c-profit')).toBe('3 buyers, but every eligible order looks unrealistically high');
  });

  it('keeps "No eligible buy orders" without buyers', () => {
    const h = html(opp({ buyerCount: 0 }));
    expect(cellTitle(h, 'c-profit')).toBe('No eligible buy orders');
    expect(cellTitle(h, 'c-pay')).toBe('No eligible buy orders, so there is no ceiling.');
  });
});
