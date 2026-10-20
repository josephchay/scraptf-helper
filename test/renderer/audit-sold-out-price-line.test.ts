// Audit livecheck-5: a copied scrap.tf/items row that said "Sold out" (or stock 0) has no price on
// purpose (CHECK_SOLD_OUT_NOTE: it is newer than anything stored). The price line's tooltip must say so,
// not that nothing was copied and nothing is stored. The branch follows the note, never outOfStock: a
// list-only stock 0 with nothing copied keeps the generic sentence.

import { describe, expect, it } from 'vitest';
import { checkPriceLine } from '../../src/renderer/checkModel';
import { mockCheckDemo } from '../../src/renderer/mockCheck';
import { CHECK_FUZZY_NOTE, CHECK_SOLD_OUT_NOTE } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckResult } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const GENERIC = 'none was copied, and neither your saved list nor your price sheet has one to buy';

const noPrice = (over: Partial<CheckResult>): CheckResult => ({ ...mockCheckDemo('no-price', NOW, 540, DEFAULT_SETTINGS), ...over });

function expectSoldOut(title: string): void {
  expect(title).toMatch(/^No scrap\.tf price/);
  expect(title).toMatch(/sold out/i);
  expect(title).not.toContain('none was copied');
  expect(title).not.toContain('neither your saved list nor your price sheet');
}

describe('the price line after a copied sold-out row', () => {
  it('a copied "Sold out" row', () => {
    expectSoldOut(checkPriceLine(noPrice({ price: null, reason: CHECK_SOLD_OUT_NOTE, stock: 5, stockLimit: 5 }), NOW).title);
  });

  it('a copied stock-0 row', () => {
    const line = checkPriceLine(noPrice({ price: null, reason: CHECK_SOLD_OUT_NOTE, stock: 0, stockLimit: 5 }), NOW);
    expect(line.outOfStock).toBe(true);
    expectSoldOut(line.title);
  });

  it('the sold-out note among other notes', () => {
    expectSoldOut(checkPriceLine(noPrice({ price: null, reason: `${CHECK_FUZZY_NOTE} ${CHECK_SOLD_OUT_NOTE}` }), NOW).title);
  });

  it('nothing copied and nothing stored keeps the generic sentence', () => {
    const r = noPrice({});
    expect(r.reason).toBeNull();
    expect(checkPriceLine(r, NOW).title).toContain(GENERIC);
  });

  it('a list-only stock 0 with nothing copied keeps the generic sentence', () => {
    const line = checkPriceLine(noPrice({ price: null, reason: null, stock: 0, stockLimit: 12 }), NOW);
    expect(line.outOfStock).toBe(true);
    expect(line.title).toContain(GENERIC);
  });
});
