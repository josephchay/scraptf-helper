// F15 shared bank rules (src/shared/banks.ts), used by the service's banks summary, the dashboard and
// the mock alike: which opportunities count as a bank's flips, and what to look for on a bank page.

import { describe, expect, it } from 'vitest';
import { BANK_LOOK_FOR, BANK_TOP_FLIPS, NO_BANK_FLIPS, bankFlips, bankLookFor } from '../../src/shared/banks';
import { SCRAPTF_BANKS, scraptfLinkFor } from '../../src/shared/links';
import type { MarketRow, Opportunity, ScraptfBank } from '../../src/shared/types';
import { makeOpp } from '../db/helpers';

const T = 1_791_958_000_000;

function opp(id: number, bank: ScraptfBank | null, over: Partial<Opportunity> = {}): { o: Opportunity; bank: ScraptfBank | null } {
  return { o: makeOpp({ sku: `${id};6`, name: `Item ${id}`, inputRef: `price:${id}`, inputKind: 'import', ...over }), bank };
}

function flipsOf(list: { o: Opportunity; bank: ScraptfBank | null }[]) {
  const banks = new Map(list.map((x) => [x.o.inputRef, x.bank]));
  return bankFlips(
    list.map((x) => x.o),
    (o) => banks.get(o.inputRef) ?? null,
  );
}

function row(over: Partial<MarketRow> & { sku: string }): MarketRow {
  return {
    name: `Item ${over.sku}`,
    category: 'hats',
    revenueScrap: 30,
    bestScrap: 31,
    consScrap: 30,
    instantScrap: 30,
    revenueOrder: null,
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
    ...over,
  };
}

describe('bankFlips', () => {
  it('counts profitable opportunities whose input is an imported price from the bank', () => {
    const r = flipsOf([
      opp(1, 'hats', { profitScrap: 10 }),
      opp(2, 'hats', { profitScrap: 30 }),
      opp(3, 'stranges', { profitScrap: 5 }),
      // Not flips: below the threshold, a typed price, a rule, no bank (an unrecognised or 0.4 page).
      opp(4, 'hats', { status: 'below-threshold', profitScrap: 2 }),
      opp(5, 'hats', { inputKind: 'user', profitScrap: 99 }),
      opp(6, 'hats', { inputKind: 'rule', inputRef: 'rule:6', profitScrap: 99 }),
      opp(7, null, { profitScrap: 99 }),
    ]);
    expect([...r.keys()].sort()).toEqual(['hats', 'stranges']);
    expect(r.get('hats')).toMatchObject({ flips: 2, flipProfitScrap: 40 });
    expect(r.get('hats')!.top.map((t) => t.sku)).toEqual(['2;6', '1;6']);
    expect(r.get('stranges')).toEqual({
      flips: 1,
      flipProfitScrap: 5,
      top: [{ sku: '3;6', name: 'Item 3', profitScrap: 5, costScrap: 300, revenueScrap: 380, confidenceLevel: 'medium' }],
    });
    expect(NO_BANK_FLIPS).toEqual({ flips: 0, flipProfitScrap: 0, top: [] });
  });

  it(`keeps the ${BANK_TOP_FLIPS} most profitable, ties by name then SKU, and sums them all`, () => {
    const r = flipsOf([
      opp(1, 'list', { profitScrap: 9, name: 'B' }),
      opp(2, 'list', { profitScrap: 9, name: 'A' }),
      opp(3, 'list', { profitScrap: 50 }),
      opp(4, 'list', { profitScrap: 1 }),
      opp(5, 'list', { profitScrap: 9, name: 'A' }),
    ]).get('list')!;
    expect(r.flips).toBe(5);
    expect(r.flipProfitScrap).toBe(78);
    expect(r.top.map((t) => t.sku)).toEqual(['3;6', '2;6', '5;6']);
    expect(r.top).toHaveLength(BANK_TOP_FLIPS);
  });
});

describe('bankLookFor', () => {
  it("counts the bank's unchecked rows and lists the highest Pay up to first", () => {
    const rows = [
      row({ sku: '1;6', maxCostScrap: 10 }),
      row({ sku: '2;6', maxCostScrap: 40 }),
      row({ sku: '3;6', maxCostScrap: null }),
      row({ sku: '4;6', maxCostScrap: 0 }),
      // Other verdicts: a price of yours, a rule flip, no buyers; and another category.
      row({ sku: '5;6', maxCostScrap: 90, verdict: 'flip', knownCostScrap: 5 }),
      row({ sku: '6;6', maxCostScrap: 90, verdict: 'rule-flip', ruleCostScrap: 5 }),
      row({ sku: '7;6', maxCostScrap: 90, category: 'weapons' }),
    ];
    const r = bankLookFor(rows, ['hats']);
    expect(r.unchecked).toBe(4);
    expect(r.lookFor).toEqual([
      { sku: '2;6', name: 'Item 2;6', maxCostScrap: 40, revenueScrap: 30 },
      { sku: '1;6', name: 'Item 1;6', maxCostScrap: 10, revenueScrap: 30 },
    ]);
  });

  it(`reads every category of the bank, keeps ${BANK_LOOK_FOR}, and gives the list card nothing`, () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ sku: `${i};6`, category: i % 2 ? 'taunts' : 'other', maxCostScrap: 100 - i }));
    const items = SCRAPTF_BANKS.find((b) => b.bank === 'items')!;
    const r = bankLookFor(rows, items.categories);
    expect(r.unchecked).toBe(8);
    expect(r.lookFor.map((x) => x.sku)).toEqual(['0;6', '1;6', '2;6', '3;6', '4;6']);
    expect(bankLookFor(rows, SCRAPTF_BANKS.find((b) => b.bank === 'list')!.categories)).toEqual({ unchecked: 0, lookFor: [] });
  });
});
