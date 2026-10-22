// F17 shared rules (src/shared/bankStock.ts): the diff of two saves of a bank, a row joined to its buy
// side, the chips, counts, order, paging, the market and drawer joins, the notification texts and
// the CSV cells. Shared by the service, the mock and the dashboard, so they are pinned here once.

import { describe, expect, it } from 'vitest';
import {
  BANK_STOCK_CSV_COLUMNS,
  BANK_STOCK_DEFAULT_LIMIT,
  BANK_STOCK_KEEP_SAVES,
  BANK_STOCK_MAX_LIMIT,
  BANK_STOCK_MAX_PAGES,
  BANK_STOCK_PLAIN_KEY,
  bankStockComparator,
  bankStockCounts,
  bankStockCsvCells,
  bankStockFilterMatches,
  bankStockItemOf,
  bankStockKey,
  bankStockMatching,
  bankStockMergePages,
  bankStockMoreNotice,
  bankStockNewAt,
  bankStockNewFlipNotice,
  bankStockOnSale,
  bankStockPage,
  bankStockPagePairs,
  bankStockResult,
  bankStockRow,
  bankStockRows,
  bankStockSpecialKey,
  bankStockTargetOf,
  bankStockVerdict,
  bankStockWhatsNew,
  diffBankStock,
  emptyBankStockResult,
  marketNewSideMatches,
  type BankStockBankDiff,
  type BankStockBuySide,
} from '../../src/shared/bankStock';
import { flipProfit, maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { BankStockRow, BankStockStored, OrderSummary } from '../../src/shared/types';

const K = 600;
const T = 1_791_958_000_000;
const HOUR = 3_600_000;
const P = DEFAULT_SETTINGS.profit;

function s(sku: string, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap: 30, stock: 1, assetId: null, ...over };
}

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'BuyBot',
    keys: 0,
    metalScrap: 60,
    valueScrap: 60,
    isBot: true,
    online: true,
    lastEventAt: T,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function buy(revenueScrap: number | null, over: Partial<BankStockBuySide> = {}): BankStockBuySide {
  return {
    revenueScrap,
    revenueOrder: revenueScrap === null ? null : order({ valueScrap: revenueScrap }),
    buyerCount: revenueScrap === null ? 0 : 3,
    maxCostScrap: maxCostFor(revenueScrap, P),
    confidence: 70,
    confidenceLevel: 'high',
    ...over,
  };
}

const changes = (newest: BankStockStored[], previous: BankStockStored[] | null) =>
  Object.fromEntries(diffBankStock(newest, previous, K).map((d) => [d.key, d.change]));

describe('identity', () => {
  it("is '' for a clean copy and the import's extras JSON otherwise, spells and parts sorted", () => {
    expect(bankStockSpecialKey(null)).toBe(BANK_STOCK_PLAIN_KEY);
    expect(bankStockSpecialKey({ paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false })).toBe('');
    expect(bankStockSpecialKey({ paint: 5801378 })).toBe('[5801378,[],[],null,null,false,false]');
    expect(bankStockSpecialKey({ spells: ['b', 'a'], parts: ['z', 'y'] })).toBe('[null,["a","b"],["y","z"],null,null,false,false]');
    expect(bankStockSpecialKey({ customName: true })).toBe('[null,[],[],null,null,true,false]');
    expect(bankStockKey('378;6', '')).toBe('378;6|');
  });

  it('reads a SKU as its base and its own paint', () => {
    expect(bankStockTargetOf('378;6')).toEqual({ base: '378;6', specialKey: '' });
    expect(bankStockTargetOf('378;6;p15185211')).toEqual({ base: '378;6', specialKey: '[15185211,[],[],null,null,false,false]' });
  });

  it('is on sale with a price and stock not known to be 0', () => {
    expect(bankStockOnSale(s('a'))).toBe(true);
    expect(bankStockOnSale(s('a', { stock: null }))).toBe(true);
    expect(bankStockOnSale(s('a', { stock: 0 }))).toBe(false);
    expect(bankStockOnSale(s('a', { costKeys: null, costScrap: null }))).toBe(false);
    expect(bankStockOnSale(null)).toBe(false);
  });
});

describe('diffBankStock', () => {
  it('finds nothing new on a first save', () => {
    expect(changes([s('a'), s('b')], null)).toEqual({ 'a|': null, 'b|': null });
  });

  it('marks new, gone, cheaper and pricier between two saves, by raw keys and metal', () => {
    const newest = [s('new'), s('same'), s('cheap', { costScrap: 25 }), s('dear', { costKeys: 1, costScrap: 0 }), s('restocked', { stock: 2 }), s('soldout', { stock: 0 }), s('stockmove', { stock: 5 })];
    const previous = [s('same'), s('cheap'), s('dear', { costScrap: 500 }), s('restocked', { stock: 0 }), s('soldout'), s('stockmove', { stock: 2 }), s('vanished')];
    expect(changes(newest, previous)).toEqual({
      'new|': 'new',
      'same|': null,
      'cheap|': 'cheaper',
      'dear|': 'pricier',
      'restocked|': 'new',
      'soldout|': 'gone',
      // A stock move alone is no change; the row carries the old stock.
      'stockmove|': null,
      'vanished|': 'gone',
    });
  });

  it('keeps a key price move out of it, and decides keys against metal at the key price', () => {
    // Same raw price: unchanged whatever K says.
    expect(changes([s('a', { costKeys: 1, costScrap: 9 })], [s('a', { costKeys: 1, costScrap: 9 })])).toEqual({ 'a|': null });
    // 1 key vs 590 scrap at K = 600: the key is pricier.
    expect(changes([s('a', { costKeys: 1, costScrap: 0 })], [s('a', { costKeys: 0, costScrap: 590 })])).toEqual({ 'a|': 'pricier' });
    // Equal value in other currencies: by keys.
    expect(changes([s('a', { costKeys: 0, costScrap: 600 })], [s('a', { costKeys: 1, costScrap: 0 })])).toEqual({ 'a|': 'cheaper' });
  });

  it('tells copies with extras apart, and lists gone keys after the newest save\'s rows', () => {
    const painted = bankStockSpecialKey({ paint: 1 });
    const d = diffBankStock([s('a'), s('a', { specialKey: painted })], [s('a'), s('b')], K);
    expect(d.map((x) => [x.key, x.change, x.onSale])).toEqual([
      ['a|', null, true],
      [`a|${painted}`, 'new', true],
      ['b|', 'gone', false],
    ]);
    // Sold out in both: listed, not on sale, no change (the page shows it nowhere).
    expect(diffBankStock([s('c', { stock: 0 })], [s('c', { stock: 0 })], K)[0]).toMatchObject({ onSale: false, change: null });
  });
});

describe('bankStockRow', () => {
  const row = (d: ReturnType<typeof diffBankStock>[number], b: BankStockBuySide | null = buy(100)) => bankStockRow(d, { category: 'hats', buy: b, keyScrap: K, profit: P });

  it('values the price, joins the buy side and judges it with profitStatus', () => {
    const [d] = diffBankStock([s('378;6', { costKeys: 0, costScrap: 40, stock: 3 })], [s('378;6', { costScrap: 45, stock: 2 })], K);
    const r = row(d!)!;
    expect(r).toMatchObject({
      sku: '378;6',
      key: '378;6|',
      category: 'hats',
      hasExtras: false,
      costKeys: 0,
      costScrapRaw: 40,
      costScrap: 40,
      stock: 3,
      change: 'cheaper',
      previousCostScrap: 45,
      previousStock: 2,
      revenueScrap: 100,
      buyerCount: 3,
      maxCostScrap: maxCostFor(100, P),
      profitScrap: 100 - 40 - P.frictionScrap,
      verdict: 'flip',
      confidence: 70,
      confidenceLevel: 'high',
    });
    expect(r.margin).toBeCloseTo(r.profitScrap! / 40);
  });

  it('values keys at the key price, and says over and no buyers', () => {
    const [d] = diffBankStock([s('a', { costKeys: 1, costScrap: 9 })], null, K);
    expect(row(d!, buy(500))).toMatchObject({ costScrap: 609, verdict: 'over', change: null, previousCostScrap: null, previousStock: null });
    expect(row(d!, null)).toMatchObject({ revenueScrap: null, profitScrap: null, margin: null, verdict: 'no-buyers', buyerCount: 0, confidence: null, confidenceLevel: null, maxCostScrap: null });
  });

  it('shows a gone row at its last price with the stock it still shows, and hides sold-out rows', () => {
    const d = diffBankStock([s('sold', { stock: 0, costScrap: 50 })], [s('sold', { costScrap: 44, stock: 2 }), s('away', { costScrap: 33 })], K);
    expect(row(d[0]!)).toMatchObject({ change: 'gone', costScrap: 44, stock: 0, previousStock: 2 });
    expect(row(d[1]!)).toMatchObject({ change: 'gone', costScrap: 33, stock: null });
    expect(row(diffBankStock([s('x', { stock: 0 })], [s('x', { stock: 0 })], K)[0]!)).toBeNull();
    expect(row(diffBankStock([s('y', { costKeys: null, costScrap: null })], null, K)[0]!)).toBeNull();
  });

  it('marks extras and keeps the verdict for a clean copy', () => {
    const [d] = diffBankStock([s('a', { specialKey: bankStockSpecialKey({ paint: 7 }) })], null, K);
    expect(row(d!)).toMatchObject({ hasExtras: true, verdict: 'flip' });
    expect(bankStockVerdict(null, 10, P)).toBe('no-buyers');
    expect(bankStockVerdict(-1, 10, P)).toBe('over');
  });

  it('0.8 (PC-1): takes the price-move reserve off profit, and flips exactly up to Pay up to', () => {
    const p = { ...P, exitReservePct: 0.05 };
    const at = (cost: number, revenue: number) => {
      const [d] = diffBankStock([s('378;6', { costScrap: cost })], null, K);
      return bankStockRow(d!, { category: 'hats', buy: buy(revenue, { maxCostScrap: maxCostFor(revenue, p) }), keyScrap: K, profit: p })!;
    };
    // 100 - 40 - ceil(100 x 5%) = 55.
    expect(at(40, 100).profitScrap).toBe(55);
    for (const revenue of [20, 100, 333, 1200]) {
      const ceiling = maxCostFor(revenue, p);
      for (let cost = 1; cost <= revenue + 5; cost++) {
        const r = at(cost, revenue);
        expect(r.profitScrap).toBe(flipProfit(revenue, cost, p));
        expect(r.verdict === 'flip', `revenue ${revenue} cost ${cost}`).toBe(ceiling !== null && cost <= ceiling);
      }
    }
  });
});

describe('filters, counts, order and paging', () => {
  const rows = bankStockRows({
    newest: [s('n1', { costScrap: 10 }), s('n2', { costScrap: 95 }), s('c', { costScrap: 20 }), s('p', { costScrap: 60 }), s('k', { costScrap: 30 }), s('z', { costScrap: 40, stock: 0 })],
    previous: [s('c', { costScrap: 30 }), s('p', { costScrap: 50 }), s('k', { costScrap: 30 }), s('g', { costScrap: 15 }), s('z', { costScrap: 40, stock: 0 })],
    keyScrap: K,
    profit: P,
    categoryOf: () => 'hats',
    buySideOf: (sku) => (sku === 'n2' ? null : buy(100)),
  });

  it('builds one row per shown key', () => {
    expect(rows.map((r) => [r.sku, r.change, r.verdict])).toEqual([
      ['n1', 'new', 'flip'],
      ['n2', 'new', 'no-buyers'],
      ['c', 'cheaper', 'flip'],
      ['p', 'pricier', expect.any(String)],
      ['k', null, 'flip'],
      ['g', 'gone', 'flip'],
    ]);
  });

  it('counts each chip over the whole bank', () => {
    const c = bankStockCounts(rows, 6);
    expect(c).toEqual({ items: 6, inStock: 5, new: 2, gone: 1, cheaper: 1, pricier: 1, flips: rows.filter((r) => r.change !== 'gone' && r.verdict === 'flip').length, newFlips: 1, longListed: 0, dropped: 0, dropping: 0, watched: 0 });
    expect(bankStockWhatsNew(c, T - HOUR)).toEqual({ new: 2, newFlips: 1, gone: 1, cheaper: 1, pricier: 1, since: T - HOUR });
    expect(bankStockWhatsNew(c, null)).toBeNull();
  });

  it('shows gone rows only under Gone', () => {
    const keys = (f: Parameters<typeof bankStockFilterMatches>[1]) => rows.filter((r) => bankStockFilterMatches(r, f)).map((r) => r.sku);
    expect(keys('all')).toEqual(['n1', 'n2', 'c', 'p', 'k']);
    expect(keys('new')).toEqual(['n1', 'n2']);
    expect(keys('changed')).toEqual(['c', 'p']);
    expect(keys('gone')).toEqual(['g']);
    expect(keys('flips')).not.toContain('g');
  });

  it('sorts by profit (default, highest first), name, cost (cheapest first) and Pay up to, missing values last', () => {
    expect(bankStockMatching(rows, {}).map((r) => r.sku)).toEqual(['n1', 'c', 'k', 'p', 'n2']);
    expect(bankStockMatching(rows, { sort: 'name' }).map((r) => r.name)).toEqual(['Item c', 'Item k', 'Item n1', 'Item n2', 'Item p']);
    expect(bankStockMatching(rows, { sort: 'cost' }).map((r) => r.costScrap)).toEqual([10, 20, 30, 60, 95]);
    expect(bankStockMatching(rows, { sort: 'cost', dir: 'desc' }).map((r) => r.costScrap)).toEqual([95, 60, 30, 20, 10]);
    expect(bankStockMatching(rows, { sort: 'payUpTo', dir: 'asc' }).at(-1)!.sku).toBe('n2');
    expect(bankStockMatching(rows, { sort: 'margin' })[0]!.sku).toBe('n1');
    const cmp = bankStockComparator('bogus' as never, undefined);
    expect([...rows].sort(cmp)[0]!.sku).toBe('n1');
  });

  it('searches name and SKU word by word', () => {
    expect(bankStockMatching(rows, { search: 'item N' }).map((r) => r.sku)).toEqual(['n1', 'n2']);
    expect(bankStockMatching(rows, { filter: 'gone', search: 'g' }).map((r) => r.sku)).toEqual(['g']);
  });

  it('pages as the service clamps it', () => {
    expect(bankStockPage({})).toEqual({ limit: BANK_STOCK_DEFAULT_LIMIT, offset: 0 });
    expect(bankStockPage({ limit: 99_999, offset: -3 })).toEqual({ limit: BANK_STOCK_MAX_LIMIT, offset: 0 });
    const r = bankStockResult({ q: { bank: 'hats', limit: 2, offset: 1 }, rows, items: 6, savedAt: T, previousSavedAt: T - HOUR, saves: 2, keyPrice: null, now: T });
    expect(r).toMatchObject({ bank: 'hats', label: 'Hats', url: 'https://scrap.tf/buy/hats', total: 5, saves: 2, savedAt: T, previousSavedAt: T - HOUR, generatedAt: T });
    expect(r.rows.map((x) => x.sku)).toEqual(['c', 'k']);
    expect(r.counts.gone).toBe(1);
    expect(emptyBankStockResult('skins', null, T)).toMatchObject({ bank: 'skins', label: 'Skins', savedAt: null, previousSavedAt: null, saves: 0, rows: [], total: 0, counts: { items: 0, inStock: 0 } });
  });
});

describe('market and drawer joins', () => {
  const painted = bankStockSpecialKey({ paint: 15185211 });
  const banks: BankStockBankDiff[] = [
    { bank: 'hats', savedAt: T - HOUR, previousSavedAt: T - 5 * HOUR, diff: diffBankStock([s('378;6'), s('126;6', { stock: 0 }), s('378;6', { specialKey: painted })], [s('126;6'), s('94;6')], K) },
    { bank: 'list', savedAt: T, previousSavedAt: T - 2 * HOUR, diff: diffBankStock([s('378;6', { costScrap: 28 })], [s('378;6', { costScrap: 31 })], K) },
    { bank: 'stranges', savedAt: T - 3 * HOUR, previousSavedAt: null, diff: diffBankStock([s('200;11')], null, K) },
  ];

  it('dates "New on scrap.tf" by the newest save it is new in', () => {
    const at = bankStockNewAt(banks);
    expect([...at]).toEqual([['378;6', T - HOUR]]);
    expect(marketNewSideMatches({ scraptfNewAt: null }, {})).toBe(true);
    expect(marketNewSideMatches({ scraptfNewAt: null }, { newOnScraptf: true })).toBe(false);
    expect(marketNewSideMatches({ scraptfNewAt: T }, { newOnScraptf: true })).toBe(true);
  });

  it('takes the drawer line from the newest save listing that copy', () => {
    expect(bankStockItemOf(banks, '378;6', K)).toEqual({ bank: 'list', savedAt: T, change: 'cheaper', previousCostScrap: 31, stock: 1 });
    expect(bankStockItemOf(banks, '378;6;p15185211', K)).toEqual({ bank: 'hats', savedAt: T - HOUR, change: 'new', previousCostScrap: null, stock: 1 });
    // Listed sold out now, so gone; dated by the save that shows it so.
    expect(bankStockItemOf(banks, '126;6', K)).toEqual({ bank: 'hats', savedAt: T - HOUR, change: 'gone', previousCostScrap: 30, stock: 0 });
    // Gone from the newest save altogether.
    expect(bankStockItemOf(banks, '94;6', K)).toEqual({ bank: 'hats', savedAt: T - HOUR, change: 'gone', previousCostScrap: 30, stock: null });
    expect(bankStockItemOf(banks, '200;11', K)).toEqual({ bank: 'stranges', savedAt: T - 3 * HOUR, change: null, previousCostScrap: null, stock: 1 });
    expect(bankStockItemOf(banks, '5021;6', K)).toBeNull();
  });
});

describe('notification texts and CSV', () => {
  const [d] = diffBankStock([s('378;6', { name: 'Team Captain', costScrap: 40 })], [], K);
  const r = bankStockRow(d!, { category: 'hats', buy: buy(100), keyScrap: K, profit: P }) as BankStockRow;

  it('words a new flip and the summary as the spec does', () => {
    expect(bankStockNewFlipNotice('Hats', r, K)).toEqual({ title: 'New on scrap.tf (Hats): Team Captain', body: `4.44 ref, sells for 11.11 ref to BuyBot, +${'6.66 ref'}` });
    expect(bankStockMoreNotice(4, 'https://scrap.tf/buy/hats')).toBe('+4 more new flips on scrap.tf/buy/hats');
    expect(bankStockMoreNotice(1, 'https://scrap.tf/items')).toBe('+1 more new flip on scrap.tf/items');
  });

  it('writes one cell per column, money as keys and ref', () => {
    const cells = bankStockCsvCells(r, K);
    expect(cells).toHaveLength(BANK_STOCK_CSV_COLUMNS.length);
    expect(Object.fromEntries(BANK_STOCK_CSV_COLUMNS.map((c, i) => [c, cells[i]]))).toMatchObject({
      sku: '378;6',
      name: 'Team Captain',
      change: 'new',
      scraptf_price: '4.44 ref',
      previous_price: '',
      stock: 1,
      sells_for: '11.11 ref',
      buyer: 'BuyBot (bot)',
      verdict: 'flip',
    });
  });
});

describe('pages of a bank (F17-C1: /items/2 is only compared with an earlier /items/2)', () => {
  const at = (batchId: number, savedAt: number, page?: string) => ({ batchId, savedAt, ...(page === undefined ? {} : { page }) });

  it('pairs each page’s newest save with that page’s save before it, newest page first', () => {
    // Newest first, as the repo reads them: /items/2 twice, /items once, and a save with no page.
    const pairs = bankStockPagePairs([at(9, 50, '/items/2'), at(8, 40, '/items'), at(7, 30, '/items/2'), at(6, 20), at(5, 10, '/items')]);
    expect(pairs.map((p) => [p.page, p.newest.batchId, p.previous?.batchId ?? null, p.saves])).toEqual([
      ['/items/2', 9, 7, 2],
      ['/items', 8, 5, 2],
      ['', 6, null, 1],
    ]);
    expect(bankStockPagePairs([])).toEqual([]);
  });

  it('names the first import of a page’s newest look, and skips a save at its own time as the previous one', () => {
    // The same file imported three times (ids 4, 6, 7 at time 30), then an older page imported late (8).
    const [p] = bankStockPagePairs([at(7, 30, '/buy/hats'), at(6, 30, '/buy/hats'), at(4, 30, '/buy/hats'), at(8, 20, '/buy/hats'), at(3, 10, '/buy/hats')]);
    expect(p).toMatchObject({ newest: { batchId: 7 }, previous: { batchId: 8 }, firstBatchId: 4 });
  });

  it('passes over a save known to hold no row, so a page saved without its cards never reads as everything gone (F18 S3)', () => {
    const save = (batchId: number, savedAt: number, items: number) => ({ batchId, savedAt, page: '/buy/hats', items });
    // Newest first: an empty save (no cards), then two real ones.
    const [p] = bankStockPagePairs([save(9, 50, 0), save(8, 40, 12), save(7, 30, 10)]);
    expect(p).toMatchObject({ newest: { batchId: 8 }, previous: { batchId: 7 }, firstBatchId: 8, saves: 2 });
    // Nor is it the previous save, which would read everything on the newest as new.
    const [q] = bankStockPagePairs([save(9, 50, 12), save(8, 40, 0), save(7, 30, 10)]);
    expect(q).toMatchObject({ newest: { batchId: 9 }, previous: { batchId: 7 } });
    // A page only ever saved empty has no pair; an unknown count is kept.
    expect(bankStockPagePairs([save(9, 50, 0)])).toEqual([]);
    expect(bankStockPagePairs([{ batchId: 9, savedAt: 50, page: '/buy/hats', items: Number.NaN }])).toHaveLength(1);
    // What the diff would have said of the empty save, had it been paired: every row gone.
    const row = { sku: '378;6', specialKey: '', name: 'Team Captain', costKeys: 0, costScrap: 12, stock: 1, assetId: null };
    expect(diffBankStock([], [row], 600).map((d) => d.change)).toEqual(['gone']);
  });

  it('reads at most the kept saves of a page and the most pages', () => {
    const many = Array.from({ length: BANK_STOCK_KEEP_SAVES + 3 }, (_, i) => at(100 - i, 1000 - i, '/items'));
    expect(bankStockPagePairs(many)[0]!.saves).toBe(BANK_STOCK_KEEP_SAVES);
    const pages = Array.from({ length: BANK_STOCK_MAX_PAGES + 5 }, (_, i) => at(500 - i, 5000 - i, `/items/${i + 1}`));
    expect(bankStockPagePairs(pages)).toHaveLength(BANK_STOCK_MAX_PAGES);
  });

  it('shows an item on several pages once: from the newest page that lists it, else gone from the newest that lost it', () => {
    // /items/2 (newest): A moved here from /items (new on this page), C gone from it. /items: B kept, A gone, C gone.
    const page2 = { savedAt: 50, diff: diffBankStock([s('1;6'), s('3;6')], [s('3;6'), s('9;6')], K) };
    const page1 = { savedAt: 40, diff: diffBankStock([s('2;6')], [s('1;6'), s('2;6'), s('9;6')], K) };
    const [m2, m1] = bankStockMergePages([page2, page1]);
    const keyed = (d: readonly { sku: string; change: string | null }[]) => d.map((x) => [x.sku, x.change]);
    expect(keyed(m2!.diff)).toEqual([
      ['1;6', 'new'],
      ['3;6', null],
      ['9;6', 'gone'],
    ]);
    // 1;6 is listed on /items/2, so it is not gone from the bank; 9;6 shows once, from the newest page.
    expect(keyed(m1!.diff)).toEqual([['2;6', null]]);
    expect(m2!.savedAt).toBe(50);
    // One page is returned as it is.
    expect(bankStockMergePages([page1])[0]).toBe(page1);
  });

  it('dates the market badge and the drawer by each page’s own save', () => {
    const banks: BankStockBankDiff[] = [
      { bank: 'list', savedAt: 50, previousSavedAt: 30, diff: diffBankStock([s('1;6')], [], K) },
      { bank: 'list', savedAt: 40, previousSavedAt: 10, diff: diffBankStock([s('2;6')], [s('2;6')], K) },
    ];
    expect(bankStockNewAt(banks).get('1;6')).toBe(50);
    expect(bankStockItemOf(banks, '2;6', K)).toMatchObject({ bank: 'list', savedAt: 40, change: null });
  });

  it('adds the pages to an answer only when there are several', () => {
    const q = { bank: 'list' as const };
    const base = { q, rows: [], items: 0, savedAt: 50, previousSavedAt: null, saves: 2, keyPrice: null, now: 60 };
    expect(bankStockResult({ ...base, pages: { count: 2, oldestSavedAt: 40 } })).toMatchObject({ pages: 2, oldestSavedAt: 40 });
    const one = bankStockResult({ ...base, pages: { count: 1, oldestSavedAt: 50 } });
    expect('pages' in one || 'oldestSavedAt' in one).toBe(false);
  });
});
