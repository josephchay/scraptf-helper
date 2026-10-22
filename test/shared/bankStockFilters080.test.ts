// 0.8 (T6, G1, decision D6): the bank stock page's Dropping and Watched chips, written once by Foundation from
// typed row fields only: Dropping is an on-sale row with at least BANK_STOCK_DROPPING_MIN reprice-downs in its
// current run (BankStockRow.timing, cycles), Watched an on-sale row a watch is joined to (BankStockRow.watch,
// alerts). A gone row never shows under either. Pure; nothing is fetched.

import { describe, expect, it } from 'vitest';
import { BANK_STOCK_FILTER_HELP, BANK_STOCK_FILTER_LABELS, bankStockChips, bankStockFilterEmpty } from '../../src/renderer/bankStockModel';
import { BANK_STOCK_DROPPING_MIN, bankStockCounts, bankStockFilterMatches, emptyBankStockCounts } from '../../src/shared/bankStock';
import { BANK_STOCK_FILTERS } from '../../src/shared/types';
import type { BankStockResult, BankStockRow, BankStockRowWatch, ScraptfTimingBrief } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR = 3_600_000;

function row(over: Partial<BankStockRow> = {}): BankStockRow {
  return {
    sku: '5021;6',
    key: '5021;6|',
    name: 'Team Captain',
    category: 'hats',
    hasExtras: false,
    costKeys: 0,
    costScrapRaw: 27,
    costScrap: 27,
    stock: 1,
    change: null,
    previousCostScrap: 27,
    previousStock: 1,
    revenueScrap: null,
    revenueOrder: null,
    buyerCount: 0,
    maxCostScrap: null,
    profitScrap: null,
    margin: null,
    verdict: 'no-buyers',
    confidence: 0,
    confidenceLevel: 'low',
    listedSince: null,
    firstSeenAt: null,
    changeSinceListed: null,
    ...over,
  };
}

const timing = (dropsThisRun: number): ScraptfTimingBrief => ({
  verdict: 'not-enough-data',
  why: 'few-drops',
  bank: 'hats',
  key: '5021;6|',
  dropsThisRun,
  steps: [],
  lastSeenAt: NOW - HOUR,
  horizonMs: null,
  pDrop: null,
  pGone: null,
  pRise: null,
  nextDropAt: null,
  n: { states: 0, copies: 0, atRisk: 0, dropCopies: 0 },
});

const WATCH: BankStockRowWatch = { id: 1, anyCopy: false, maxCostScrap: 30, minProfitScrap: null, onRestock: false, met: 'price', overTargetScrap: -3 };

function result(rows: BankStockRow[]): BankStockResult {
  return {
    bank: 'hats',
    label: 'Hats',
    url: 'https://scrap.tf/buy/hats',
    savedAt: NOW - HOUR,
    previousSavedAt: NOW - 3 * HOUR,
    saves: 2,
    counts: bankStockCounts(rows, rows.length, { now: NOW }),
    rows,
    total: rows.length,
    keyPrice: null,
    generatedAt: NOW,
  };
}

describe("the 'dropping' filter", () => {
  it('matches an on-sale row with at least 2 reprice-downs in its current run, never a gone one', () => {
    expect(BANK_STOCK_DROPPING_MIN).toBe(2);
    expect(bankStockFilterMatches(row({ timing: timing(2) }), 'dropping')).toBe(true);
    expect(bankStockFilterMatches(row({ timing: timing(5), change: 'cheaper' }), 'dropping')).toBe(true);
    expect(bankStockFilterMatches(row({ timing: timing(1) }), 'dropping')).toBe(false);
    expect(bankStockFilterMatches(row(), 'dropping')).toBe(false);
    expect(bankStockFilterMatches(row({ timing: timing(3), change: 'gone' }), 'dropping')).toBe(false);
  });
});

describe("the 'watched' filter", () => {
  it('matches an on-sale row with a watch, never one without, never a gone one', () => {
    expect(bankStockFilterMatches(row({ watch: WATCH }), 'watched')).toBe(true);
    expect(bankStockFilterMatches(row({ watch: { ...WATCH, met: null, overTargetScrap: 12 } }), 'watched')).toBe(true);
    expect(bankStockFilterMatches(row(), 'watched')).toBe(false);
    expect(bankStockFilterMatches(row({ watch: WATCH, change: 'gone' }), 'watched')).toBe(false);
  });
});

describe('the counts and chips', () => {
  const rows = [
    row({ key: 'a', timing: timing(2), watch: WATCH }),
    row({ key: 'b', timing: timing(4) }),
    row({ key: 'c', timing: timing(1), watch: WATCH }),
    row({ key: 'd' }),
    row({ key: 'e', change: 'gone', timing: timing(6), watch: WATCH }),
  ];

  it('bankStockCounts counts both over on-sale rows only', () => {
    const c = bankStockCounts(rows, 5, { now: NOW });
    expect(c.dropping).toBe(2);
    expect(c.watched).toBe(2);
    expect(c.gone).toBe(1);
    expect(emptyBankStockCounts()).toMatchObject({ dropping: 0, watched: 0 });
    // The counts agree with the filter.
    expect(rows.filter((r) => bankStockFilterMatches(r, 'dropping')).length).toBe(c.dropping);
    expect(rows.filter((r) => bankStockFilterMatches(r, 'watched')).length).toBe(c.watched);
  });

  it("bankStockChips shows both last, labelled 'Dropping' and 'Watched', with their help", () => {
    const chips = bankStockChips(result(rows));
    expect(chips.map((c) => c.filter)).toEqual(BANK_STOCK_FILTERS);
    expect(chips.slice(-2).map((c) => [c.filter, c.label, c.count, c.disabled, c.title])).toEqual([
      ['dropping', 'Dropping', '2', false, BANK_STOCK_FILTER_HELP.dropping],
      ['watched', 'Watched', '2', false, BANK_STOCK_FILTER_HELP.watched],
    ]);
    expect(BANK_STOCK_FILTER_LABELS.dropping).toBe('Dropping');
    expect(BANK_STOCK_FILTER_LABELS.watched).toBe('Watched');
    // A lower bound, said where it bites.
    expect(BANK_STOCK_FILTER_HELP.dropping).toContain('a lower bound: several drops between two saves read as one');
    // Neither compares two saves, so a first save does not disable them.
    const first = bankStockChips({ ...result(rows), previousSavedAt: null });
    expect(first.slice(-2).map((c) => c.disabled)).toEqual([false, false]);
  });

  it('bankStockFilterEmpty words both empty tables', () => {
    expect(bankStockFilterEmpty('dropping')).toEqual({
      title: 'Nothing dropping',
      body: 'No item on sale has been repriced down twice or more in its current run of your saves. Saving the page regularly fills in its history.',
    });
    expect(bankStockFilterEmpty('watched')).toEqual({
      title: 'Nothing you watch is on sale here',
      body: "None of your watched items is on sale in your newest save of this page. Watch one from its menu or its details panel; you'll be told when a page you read shows it at your price.",
    });
  });
});
