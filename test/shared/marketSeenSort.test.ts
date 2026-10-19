// 0.7.1 (UX-1): the Live market's 'seen' sort, "flips on my saves, freshest first": by when the user's
// own price was observed (knownObservedAt), missing last in both directions, rows of the same save by
// profit (most first, missing last), then by name. Pure; the market index pins its order to this
// comparator over every sort (test/domain/market.test.ts).

import { describe, expect, it } from 'vitest';
import { MARKET_SORTS, marketComparator, marketProfitTie } from '../../src/shared/market';
import type { MarketRow } from '../../src/shared/types';

const T0 = 1_791_958_000_000;
const MIN = 60_000;

type Side = Pick<MarketRow, 'sku' | 'name' | 'maxCostScrap' | 'revenueScrap' | 'buyerCount' | 'profitScrap' | 'lastOrderChangeAt' | 'knownObservedAt'>;

function row(sku: string, knownObservedAt: number | null, profitScrap: number | null, name = `Item ${sku}`): Side {
  // Every other sort key is the same on every row, and lastOrderChangeAt newest of all: only 'seen' can order them.
  return { sku, name, maxCostScrap: 50, revenueScrap: 60, buyerCount: 2, profitScrap, lastOrderChangeAt: T0 + 60 * MIN, knownObservedAt };
}

const skus = (rows: readonly Side[]): string[] => rows.map((r) => r.sku);

describe("marketComparator('seen')", () => {
  const fresh = row('1;6', T0, 5);
  const freshBetter = row('2;6', T0, 40);
  const freshNoProfit = row('3;6', T0, null);
  const older = row('4;6', T0 - 30 * MIN, 99);
  const oldest = row('5;6', T0 - 3 * 60 * MIN, 1);
  const unseen = row('6;6', null, 200);
  const unseenToo = row('7;6', null, null, 'A first by name');
  const all = [oldest, unseen, fresh, older, unseenToo, freshNoProfit, freshBetter];

  it('is a sort the service and the dashboard know', () => {
    expect(MARKET_SORTS).toContain('seen');
  });

  it('goes freshest first by default, ties by profit (most first, none last), unseen rows last', () => {
    expect(skus([...all].sort(marketComparator('seen', undefined)))).toEqual(['2;6', '1;6', '3;6', '4;6', '5;6', '6;6', '7;6']);
    expect(skus([...all].sort(marketComparator('seen', 'desc')))).toEqual(skus([...all].sort(marketComparator('seen', undefined))));
  });

  it('goes oldest first ascending, keeping unseen rows last and the profit tie-break most first', () => {
    expect(skus([...all].sort(marketComparator('seen', 'asc')))).toEqual(['5;6', '4;6', '2;6', '1;6', '3;6', '6;6', '7;6']);
  });

  it('breaks a full tie (same save, same profit) by name, then SKU', () => {
    const b = row('9;6', T0, 10, 'Bravo');
    const a2 = row('8;6', T0, 10, 'Alpha');
    const a1 = row('10;6', T0, 10, 'Alpha');
    expect(skus([b, a2, a1].sort(marketComparator('seen', 'desc')))).toEqual(['10;6', '8;6', '9;6']);
  });

  it('marketProfitTie: most profit first, missing last, equal is a tie', () => {
    expect(marketProfitTie(40, 5)).toBeLessThan(0);
    expect(marketProfitTie(5, 40)).toBeGreaterThan(0);
    expect(marketProfitTie(null, -3)).toBeGreaterThan(0);
    expect(marketProfitTie(-3, null)).toBeLessThan(0);
    expect(marketProfitTie(7, 7)).toBe(0);
    expect(marketProfitTie(null, null)).toBe(0);
    expect(marketProfitTie(Number.NaN, 1)).toBeGreaterThan(0);
  });

  it('leaves the other sorts unchanged: a profit tie is only for seen', () => {
    // 'updated' reads lastOrderChangeAt (the same on every row here), so it falls straight to the name.
    const named = [row('1;6', T0, 5, 'Charlie'), row('2;6', T0, 40, 'Bravo'), row('3;6', T0, 1, 'Alpha')];
    expect(skus([...named].sort(marketComparator('updated', 'desc')))).toEqual(['3;6', '2;6', '1;6']);
  });
});
