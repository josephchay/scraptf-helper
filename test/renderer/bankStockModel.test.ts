// F17 bank stock page model (src/renderer/bankStockModel.ts): the view remembered per bank, the
// 'scraptf.bankStock' query and its CSV twin, the filter chips with their counts, the header's saves,
// every cell's text and hover, the empty states and the loader's stale-response guard. Pure; nothing
// here touches the network or scrap.tf.

import { describe, expect, it, vi } from 'vitest';
import {
  BANK_STOCK_FILTER_LABELS,
  BANK_STOCK_PAGE,
  BANK_STOCK_PICKER_SORTS,
  BANK_STOCK_SORT_LABELS,
  DEFAULT_BANK_STOCK_VIEW,
  RETENTION_NOTE,
  bankStockListedCell,
  bankStockSinceListedCell,
  bankStockBuyer,
  bankStockChangeTag,
  BANK_STOCK_CHIP_FILTERS,
  bankStockChips,
  bankStockEmptyReason,
  bankStockExportQuery,
  bankStockExtras,
  bankStockExtrasTitle,
  BANK_STOCK_EXTRAS_TITLE,
  bankStockFilterEmpty,
  bankStockFilterUnavailable,
  bankStockHeader,
  bankStockKeyAction,
  bankStockLastSeen,
  bankStockLoadingMore,
  bankStockMore,
  bankStockPayTitle,
  bankStockPrefKey,
  bankStockPriceTitle,
  bankStockQueryKey,
  bankStockQueryOf,
  bankStockSellsTitle,
  bankStockSortChange,
  bankStockStockCell,
  bankStockVerdictPill,
  createBankStockLoader,
  isChangeFilter,
  sanitizeBankStockView,
  type BankStockView,
} from '../../src/renderer/bankStockModel';
import { fmtDateTime } from '../../src/renderer/format';
import { BANK_STOCK_MAX_LIMIT, bankStockKey, bankStockSpecialKey, emptyBankStockCounts } from '../../src/shared/bankStock';
import { SCRAPTF_BANKS, STATIC_EXTERNAL_URLS } from '../../src/shared/links';
import { BANK_STOCK_FILTERS, BANK_STOCK_SORTS } from '../../src/shared/types';
import type { BankStockCounts, BankStockQuery, BankStockResult, BankStockRow, OrderSummary } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 568;

const view = (over: Partial<BankStockView> = {}): BankStockView => ({ ...DEFAULT_BANK_STOCK_VIEW, ...over });

const ORDER: OrderSummary = {
  listingId: 'l1',
  steamid: '76561198000000001',
  userName: 'Keybot',
  keys: 0,
  metalScrap: 45,
  valueScrap: 45,
  isBot: true,
  online: true,
  lastEventAt: NOW - MIN,
  bumpedAt: null,
  details: '',
  flags: [],
  eligible: true,
};

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
    stock: 3,
    change: null,
    previousCostScrap: 27,
    previousStock: 3,
    revenueScrap: 45,
    revenueOrder: ORDER,
    buyerCount: 4,
    maxCostScrap: 36,
    profitScrap: 18,
    margin: 18 / 27,
    verdict: 'flip',
    confidence: 72,
    confidenceLevel: 'high',
    listedSince: null,
    firstSeenAt: null,
    changeSinceListed: null,
    ...over,
  };
}

function counts(over: Partial<BankStockCounts> = {}): BankStockCounts {
  return { ...emptyBankStockCounts(), ...over };
}

function result(over: Partial<BankStockResult> = {}): BankStockResult {
  return {
    bank: 'hats',
    label: 'Hats',
    url: 'https://scrap.tf/buy/hats',
    savedAt: NOW - 12 * MIN,
    previousSavedAt: NOW - 3 * HOUR,
    saves: 2,
    counts: counts({ items: 48, inStock: 31, new: 5, gone: 3, cheaper: 2, pricier: 1, flips: 7, newFlips: 2 }),
    rows: [row()],
    total: 1,
    keyPrice: null,
    generatedAt: NOW,
    ...over,
  };
}

describe('the view, remembered per bank', () => {
  it('reads anything from storage back as a valid view', () => {
    for (const bad of [null, undefined, 3, 'x', [], { filter: 'nope', sort: 'x', dir: 'up', search: 5 }]) {
      expect(sanitizeBankStockView(bad), JSON.stringify(bad)).toEqual(DEFAULT_BANK_STOCK_VIEW);
    }
    expect(sanitizeBankStockView({ filter: 'gone', sort: 'margin', dir: 'asc', search: 'hat' })).toEqual({ filter: 'gone', sort: 'margin', dir: 'asc', search: 'hat' });
    // A missing direction is the sort's own default.
    expect(sanitizeBankStockView({ sort: 'cost' }).dir).toBe('asc');
    expect(sanitizeBankStockView({ sort: 'payUpTo' }).dir).toBe('desc');
    expect(sanitizeBankStockView({ search: 'x'.repeat(500) }).search).toHaveLength(200);
    for (const f of BANK_STOCK_FILTERS) expect(sanitizeBankStockView({ filter: f }).filter).toBe(f);
  });

  it('keeps one key per bank', () => {
    const keys = SCRAPTF_BANKS.map((b) => bankStockPrefKey(b.bank));
    expect(new Set(keys).size).toBe(SCRAPTF_BANKS.length);
    expect(bankStockPrefKey('hats')).toBe('bankStock.view.hats');
  });
});

describe('the query', () => {
  it('asks for one page of the view, the search trimmed and left out when empty', () => {
    expect(bankStockQueryOf('hats', view())).toEqual({ bank: 'hats', filter: 'all', sort: 'profit', dir: 'desc', limit: BANK_STOCK_PAGE, offset: 0 });
    expect(bankStockQueryOf('unusuals', view({ search: '  burning  ', filter: 'new', sort: 'name', dir: 'asc' }), 400)).toEqual({
      bank: 'unusuals',
      filter: 'new',
      sort: 'name',
      dir: 'asc',
      search: 'burning',
      limit: 400,
      offset: 0,
    });
    expect(bankStockQueryOf('hats', view({ search: '   ' })).search).toBeUndefined();
    expect(bankStockQueryOf('hats', view({ search: 'x'.repeat(300) })).search).toHaveLength(200);
  });

  it('clamps the page size to what the service takes', () => {
    expect(bankStockQueryOf('hats', view(), 0).limit).toBe(1);
    expect(bankStockQueryOf('hats', view(), 99_999).limit).toBe(BANK_STOCK_MAX_LIMIT);
    expect(bankStockQueryOf('hats', view(), Number.NaN).limit).toBe(BANK_STOCK_PAGE);
    expect(bankStockQueryOf('hats', view(), 250.7).limit).toBe(250);
  });

  it('exports the same rows in the same order, without paging', () => {
    const v = view({ filter: 'flips', search: 'cap', sort: 'margin', dir: 'asc' });
    expect(bankStockExportQuery('stranges', v)).toEqual({ bank: 'stranges', filter: 'flips', search: 'cap', sort: 'margin', dir: 'asc' });
  });

  it('keys a query by what it answers, not by its page size', () => {
    const a = bankStockQueryOf('hats', view(), 200);
    expect(bankStockQueryKey(a)).toBe(bankStockQueryKey(bankStockQueryOf('hats', view(), 600)));
    expect(bankStockQueryKey(a)).not.toBe(bankStockQueryKey(bankStockQueryOf('hats', view({ filter: 'new' }))));
    expect(bankStockQueryKey(a)).not.toBe(bankStockQueryKey(bankStockQueryOf('weapons', view())));
    expect(bankStockQueryKey(a)).not.toBe(bankStockQueryKey(bankStockQueryOf('hats', view({ dir: 'asc' }))));
  });

  it('a header click flips the column it is on, or starts another at its default direction', () => {
    expect(bankStockSortChange({ sort: 'profit', dir: 'desc' }, 'profit')).toEqual({ sort: 'profit', dir: 'asc' });
    expect(bankStockSortChange({ sort: 'profit', dir: 'desc' }, 'name')).toEqual({ sort: 'name', dir: 'asc' });
    expect(bankStockSortChange({ sort: 'name', dir: 'asc' }, 'payUpTo')).toEqual({ sort: 'payUpTo', dir: 'desc' });
    for (const s of BANK_STOCK_SORTS) expect(BANK_STOCK_SORT_LABELS[s]).toBeTruthy();
  });

  it('"Load more" goes a page further, up to the whole bank page the service returns at once', () => {
    expect(bankStockMore(31, 31)).toBeNull();
    expect(bankStockMore(200, 1234)).toEqual({ text: 'Showing 200 of 1,234', next: 400, title: 'Shows the next 200 in this order.' });
    expect(bankStockMore(200, 250)!.next).toBe(250);
    expect(bankStockMore(1900, 5000)!.next).toBe(2000);
    const capped = bankStockMore(2000, 2345)!;
    expect(capped.next).toBeNull();
    expect(capped.text).toBe('Showing the first 2,000 of 2,345. Narrow the search, or Export CSV for every item.');
  });
});

describe('"Load more" while a read is in flight (F17-UI-3)', () => {
  const q = (limit: number, over: Partial<BankStockQuery> = {}): BankStockQuery => bankStockQueryOf('hats', view(over), limit);
  const key = bankStockQueryKey(q(BANK_STOCK_PAGE));

  it('is pending only while a bigger page of the same query is read', () => {
    // Asked for 400 of the same filter, search and order; 200 shown, a read in flight.
    expect(bankStockLoadingMore(true, q(200), key, 400)).toBe(true);
    // A background refresh (a push) reads the 200 already shown: no "Loading…", the button stays usable.
    expect(bankStockLoadingMore(true, q(200), key, 200)).toBe(false);
    // Nothing in flight, nothing answered yet, or rows of another query (the page goes back to one page).
    expect(bankStockLoadingMore(false, q(200), key, 400)).toBe(false);
    expect(bankStockLoadingMore(true, null, key, 400)).toBe(false);
    expect(bankStockLoadingMore(true, q(200, { filter: 'new' }), key, 400)).toBe(false);
    // An answer without a page size counts as one page.
    const { limit: _limit, ...bare } = q(200);
    expect(bankStockLoadingMore(true, bare, key, 400)).toBe(true);
  });
});

describe('the filter chips', () => {
  it('All (in stock), New, Flips, Price changes, Gone, then F20 Listed > 24 h and Dropped since listed, counted over the whole bank', () => {
    const chips = bankStockChips(result({ counts: counts({ items: 48, inStock: 31, new: 5, gone: 3, cheaper: 2, pricier: 1, flips: 7, newFlips: 2, longListed: 12, dropped: 4 }) }));
    expect(chips.map((c) => [c.filter, c.label, c.count, c.disabled])).toEqual([
      ['all', 'All', '31', false],
      ['new', 'New', '5', false],
      ['flips', 'Flips', '7', false],
      ['changed', 'Price changes', '3', false],
      ['gone', 'Gone', '3', false],
      ['long-listed', 'Listed > 24 h', '12', false],
      ['dropped', 'Dropped since listed', '4', false],
    ]);
    // Every filter the service knows has a chip, F17's first.
    expect(BANK_STOCK_CHIP_FILTERS).toEqual(BANK_STOCK_FILTERS);
    expect(chips.find((c) => c.filter === 'changed')!.title).toContain('2 cheaper, 1 pricier.');
    expect(chips.find((c) => c.filter === 'new')!.title).toContain('2 of them are flips.');
  });

  it('wait for an answer, and for a second save before comparing', () => {
    expect(bankStockChips(null).map((c) => [c.count, c.disabled])).toEqual(BANK_STOCK_CHIP_FILTERS.map(() => ['…', false]));
    const first = bankStockChips(result({ previousSavedAt: null, saves: 1, counts: counts({ items: 10, inStock: 8, flips: 2 }) }));
    expect(first.filter((c) => c.disabled).map((c) => c.filter)).toEqual(['new', 'changed', 'gone']);
    expect(first.filter((c) => c.disabled).every((c) => c.count === '—' && c.title.endsWith('Save the page again later to see this.'))).toBe(true);
    expect(first.find((c) => c.filter === 'flips')!.count).toBe('2');
    expect(BANK_STOCK_FILTERS.filter(isChangeFilter)).toEqual(['new', 'changed', 'gone']);
  });

  it('a remembered change filter is given up only once an answer says there is one save', () => {
    expect(bankStockFilterUnavailable('new', null)).toBe(false);
    expect(bankStockFilterUnavailable('new', { previousSavedAt: NOW - HOUR })).toBe(false);
    expect(bankStockFilterUnavailable('gone', { previousSavedAt: null })).toBe(true);
    expect(bankStockFilterUnavailable('flips', { previousSavedAt: null })).toBe(false);
    expect(bankStockFilterUnavailable('all', { previousSavedAt: null })).toBe(false);
  });
});

describe('the header', () => {
  it('names the bank and its page from SCRAPTF_BANKS, whatever the service sent', () => {
    const h = bankStockHeader('hats', result({ label: 'Evil', url: 'https://evil.example/x' }), NOW)!;
    expect(h).toMatchObject({ bank: 'hats', label: 'Hats', title: 'Hats stock', path: 'scrap.tf/buy/hats', url: 'https://scrap.tf/buy/hats' });
    for (const b of SCRAPTF_BANKS) expect(STATIC_EXTERNAL_URLS).toContain(bankStockHeader(b.bank, null, NOW)!.url);
    expect(bankStockHeader('list', null, NOW)!.title).toBe('All items stock');
    expect(bankStockHeader('__proto__' as never, null, NOW)).toBeNull();
    expect(h.openTitle).toContain('in your own browser. Flip Desk never loads scrap.tf on its own.');
  });

  it('says when the newest and the previous save were made', () => {
    const h = bankStockHeader('hats', result(), NOW)!;
    expect(h.saved.text).toBe('saved 12 min ago · 48 items (31 in stock)');
    expect(h.previous!.text).toBe('previous save 3 h ago');
    expect(h.firstSave).toBe(false);
    expect(h.freshness).toMatchObject({ tone: 'good', label: 'Fresh' });
    // A file time a little ahead of the clock reads "just now".
    expect(bankStockHeader('hats', result({ savedAt: NOW + 2 * MIN }), NOW)!.saved.text).toMatch(/^saved just now/);
  });

  it('a first save, a page never saved, and before the answer', () => {
    const first = bankStockHeader('killstreaks', result({ bank: 'killstreaks', savedAt: NOW - 26 * HOUR, previousSavedAt: null, saves: 1 }), NOW)!;
    expect(first.firstSave).toBe(true);
    expect(first.previous!.text).toBe('first save');
    expect(first.freshness.label).toBe('Stale');
    const never = bankStockHeader('skins', result({ bank: 'skins', savedAt: null, previousSavedAt: null, saves: 0, counts: counts() }), NOW)!;
    expect(never.saved.text).toBe('Not saved yet');
    expect(never.previous).toBeNull();
    expect(never.firstSave).toBe(false);
    expect(never.freshness.label).toBe('Never saved');
    // F20-C3: a page's newest save never expires (the thinning keeps it, whatever its age), so a page
    // never saved is not one whose saves were dropped.
    expect(never.saved.title).toBe("No save of scrap.tf/buy/skins is kept: save the page as 'Webpage, Complete' into your watch folder to see its items here.");
    expect(never.saved.title).not.toMatch(/dropped|older than/);
    expect(bankStockHeader('hats', null, NOW)!.saved.text).toBe('Reading your saves…');
  });

  it('says when the rows come from several pages of the bank, and how old the oldest is (F17-C1)', () => {
    const h = bankStockHeader('list', result({ bank: 'list', savedAt: NOW - 5 * MIN, previousSavedAt: NOW - 3 * HOUR, pages: 2, oldestSavedAt: NOW - 2 * HOUR }), NOW)!;
    expect(h.saved.text).toBe('saved 5 min ago · 2 pages, oldest saved 2 h ago · 48 items (31 in stock)');
    expect(h.saved.title).toContain('The items come from 2 pages of it you saved');
    expect(h.saved.title).toContain('each page is compared only with your previous save of that same page');
    // F20: more saves are kept (thinned, up to 90 days); the count is what the change columns read.
    expect(h.saved.title).toContain('2 recent saves read for changes (the 10 newest of each page).');
    expect(h.saved.title).toContain(RETENTION_NOTE);
    // F20-C3: the note names the saves the thinning always keeps (a page's newest and its compare saves).
    // 0.7.1 (DM-3, CQ-1): B's tiers, word for word.
    expect(RETENTION_NOTE).toBe(
      "For price history your saves are kept up to 90 days: every save from the last 2 hours, then one every 10 minutes for the rest of the day, then one an hour for a week, then one a day; a page's newest save and the ones it is compared with always stay.",
    );
    expect(h.saved.title).not.toContain('30 days');
    expect(h.previous!.title).toMatch(/^Changes are counted page by page/);
    // One page: as before.
    expect(bankStockHeader('hats', result(), NOW)!.saved.title).not.toContain('pages of it');
  });
});

describe('the cells', () => {
  it('marks a new row, telling a new item from one back in stock', () => {
    const fresh = bankStockChangeTag(row({ change: 'new', previousCostScrap: null, previousStock: null }), K, NOW - 3 * HOUR, NOW)!;
    expect(fresh).toMatchObject({ kind: 'new', text: 'New', tone: 'good' });
    // An absent row and a list row with neither price nor stock look alike here: the title claims neither.
    expect(fresh.title).toBe('New since your previous save (3 h ago): not on sale then, on sale in your newest save.');
    const back = bankStockChangeTag(row({ change: 'new', previousCostScrap: 27, previousStock: 0 }), K, NOW - 3 * HOUR, NOW)!;
    expect(back.title).toMatch(/^Back on sale/);
  });

  it('shows "↓ was X" and "↑ was X" for a price change, and Gone with why', () => {
    expect(bankStockChangeTag(row({ change: 'cheaper', costScrap: 18, previousCostScrap: 27 }), K, null, NOW)).toMatchObject({ kind: 'cheaper', text: '↓ was 3.00 ref', tone: 'good' });
    const up = bankStockChangeTag(row({ change: 'pricier', costScrap: 36, previousCostScrap: 27 }), K, NOW - HOUR, NOW)!;
    expect(up).toMatchObject({ kind: 'pricier', text: '↑ was 3.00 ref', tone: 'bad' });
    expect(up.title).toBe("Pricier than in your previous save (1 h ago): 4.00 ref now, 3.00 ref then (both at today's key price).");
    expect(bankStockChangeTag(row({ change: 'cheaper', previousCostScrap: null }), K, null, NOW)!.text).toBe('↓ cheaper');
    expect(bankStockChangeTag(row({ change: 'gone', stock: 0 }), K, NOW - HOUR, NOW)!.title).toContain('your newest save lists it sold out');
    expect(bankStockChangeTag(row({ change: 'gone', stock: null }), K, NOW - HOUR, NOW)!.title).toContain('your newest save no longer lists it');
    expect(bankStockChangeTag(row(), K, NOW - HOUR, NOW)).toBeNull();
  });

  it('stock, with "5 → 3" when the previous save showed another count', () => {
    expect(bankStockStockCell(row({ stock: 3, previousStock: 5 }), true)).toEqual({ text: '5 → 3', title: '5 in stock in your previous save, 3 in your newest.', muted: false });
    expect(bankStockStockCell(row({ stock: 3, previousStock: 3 }), true).text).toBe('3');
    // One save: no previous count to show.
    expect(bankStockStockCell(row({ stock: 3, previousStock: 5 }), false).text).toBe('3');
    expect(bankStockStockCell(row({ stock: null }), true)).toMatchObject({ text: '—', muted: true });
    expect(bankStockStockCell(row({ stock: 1200, previousStock: null }), true).text).toBe('1,200');
  });

  it('the Gone view: when it was last seen on sale', () => {
    expect(bankStockLastSeen(row({ stock: 0 }), NOW - 3 * HOUR, NOW).text).toBe('3 h ago');
    expect(bankStockLastSeen(row({ stock: 0 }), NOW - 3 * HOUR, NOW).title).toContain('still lists it, sold out');
    expect(bankStockLastSeen(row({ stock: null }), NOW - 3 * HOUR, NOW).title).toContain('does not list it');
    expect(bankStockLastSeen(row(), null, NOW).text).toBe('—');
  });

  it('the price as listed, in keys and metal, and valued at the key price', () => {
    // Valued, it reads the same as listed: said once.
    expect(bankStockPriceTitle(row({ costKeys: 1, costScrapRaw: 27, costScrap: K + 27 }), K)).toBe('scrap.tf sells it for this, as of your newest save. Listed as 1 key 3.00 ref.');
    // More metal than a key: the value at today's key price differs from the listing.
    expect(bankStockPriceTitle(row({ costKeys: 1, costScrapRaw: K + 9, costScrap: 2 * K + 9 }), K)).toBe(
      "scrap.tf sells it for this, as of your newest save. Listed as 1 key 64.11 ref: 2 keys 1.00 ref at today's key price.",
    );
    // 0.7.3: without a last sighting, the price of the save it is compared with (CQ-2's baseline).
    expect(bankStockPriceTitle(row({ change: 'gone', hasExtras: true }), K)).toBe('Price on scrap.tf in your save from before your latest run of saves. This copy has extras.');
  });

  it("names a copy's extras from its key, so a plain and a painted copy can be told apart", () => {
    const key = bankStockKey('5021;6', bankStockSpecialKey({ paint: 12073019, spells: ['Exorcism'], parts: ['Kills While Explosive-Jumping'], sheen: 3, killstreaker: null, customName: true, customDesc: false }));
    expect(bankStockExtras(key)).toEqual(['Paint: Team Spirit', 'Spell: Exorcism', 'Strange part: Kills While Explosive-Jumping', 'A sheen', 'A name tag']);
    expect(bankStockExtrasTitle(key)).toBe(
      'This copy has extras: Paint: Team Spirit, Spell: Exorcism, Strange part: Kills While Explosive-Jumping, A sheen, A name tag. Pay up to and the verdict are for a clean copy: buyers rarely pay for extras.',
    );
    // A paint without a name reads as its colour.
    expect(bankStockExtras(bankStockKey('5021;6', bankStockSpecialKey({ paint: 1 })))).toEqual(['Paint: #000001']);
    // A clean copy, or a key it cannot read: nothing named, the general caveat.
    expect(bankStockExtras('5021;6|')).toEqual([]);
    for (const bad of ['5021;6', '5021;6|{', '5021;6|{"a":1}', '5021;6|[null,"x",5,null,null,"yes",1]']) expect(bankStockExtras(bad)).toEqual([]);
    expect(bankStockExtrasTitle('5021;6|nope')).toBe(BANK_STOCK_EXTRAS_TITLE);
  });

  it('who buys it, and how many buyers there are', () => {
    expect(bankStockSellsTitle(row(), K)).toBe('Sells for 5.00 ref to Keybot (bot, online) on backpack.tf. 4 buyers with eligible orders.');
    expect(bankStockSellsTitle(row({ revenueScrap: null, revenueOrder: null, buyerCount: 0 }), K)).toBe('No eligible backpack.tf buy orders for this item in the live book.');
    expect(bankStockSellsTitle(row({ revenueScrap: null, revenueOrder: null, buyerCount: 2 }), K, 'conservative')).toMatch(/^Every eligible order looks unrealistic/);
    expect(bankStockBuyer(row())).toBe('Keybot');
    expect(bankStockBuyer(row({ revenueOrder: { ...ORDER, userName: '', isBot: false } }))).toBe('Human');
    expect(bankStockBuyer(row({ revenueOrder: null }))).toBeNull();
  });

  it('Pay up to against scrap.tf\'s price, and the clean-copy caveat for extras', () => {
    expect(bankStockPayTitle(row({ maxCostScrap: 36, costScrap: 27 }), K)).toBe("Pay up to 4.00 ref on scrap.tf: the highest price that still clears your thresholds. scrap.tf's price is 1.00 ref under it.");
    expect(bankStockPayTitle(row({ maxCostScrap: 18, costScrap: 27 }), K)).toContain('1.00 ref over it.');
    expect(bankStockPayTitle(row({ maxCostScrap: 27, costScrap: 27 }), K)).toContain('exactly at it.');
    expect(bankStockPayTitle(row({ maxCostScrap: null, revenueScrap: null, buyerCount: 0 }), K)).toBe('No eligible buy orders, so there is no ceiling.');
    expect(bankStockPayTitle(row({ maxCostScrap: null, hasExtras: true }), K)).toBe('No scrap.tf price clears your thresholds against these buyers. The ceiling is for a clean copy; this one has extras.');
  });

  it('the verdict pill: Flip +X (m%), Over by Y, or No buyers', () => {
    expect(bankStockVerdictPill(row({ profitScrap: 9, margin: 0.25 }), K)).toMatchObject({ tone: 'good', text: 'Flip +1.00 ref (25%)' });
    expect(bankStockVerdictPill(row({ profitScrap: 9, margin: null }), K).text).toBe('Flip +1.00 ref');
    const over = bankStockVerdictPill(row({ verdict: 'over', costScrap: 45, maxCostScrap: 27, profitScrap: -2 }), K);
    expect(over).toMatchObject({ tone: 'bad', text: 'Over by 2.00 ref' });
    expect(over.title).toContain('not a flip at that price');
    expect(bankStockVerdictPill(row({ verdict: 'over', maxCostScrap: null }), K).text).toBe('Over');
    expect(bankStockVerdictPill(row({ verdict: 'no-buyers', revenueScrap: null, maxCostScrap: null, profitScrap: null, buyerCount: 0 }), K)).toMatchObject({ tone: 'muted', text: 'No buyers' });
    // A gone row is judged at its last price; extras are judged as a clean copy.
    expect(bankStockVerdictPill(row({ change: 'gone' }), K).title).toMatch(/^At its last price: /);
    expect(bankStockVerdictPill(row({ hasExtras: true }), K).title).toContain('Judged as a clean copy');
  });
});

describe('empty states and keys', () => {
  it('says why the table is empty', () => {
    const none = result({ rows: [], total: 0 });
    expect(bankStockEmptyReason(result(), view(), false)).toBeNull();
    expect(bankStockEmptyReason({ ...none, savedAt: null }, view(), false)).toBe('never-saved');
    expect(bankStockEmptyReason({ ...none, savedAt: null }, view(), true)).toBe('import-off');
    expect(bankStockEmptyReason(none, view({ search: 'zzz', filter: 'new' }), false)).toBe('search');
    expect(bankStockEmptyReason(none, view({ filter: 'gone' }), false)).toBe('filter');
    expect(bankStockEmptyReason(none, view(), false)).toBe('nothing-on-sale');
    for (const f of BANK_STOCK_FILTERS) expect(bankStockFilterEmpty(f).title.length).toBeGreaterThan(5);
    expect(bankStockFilterEmpty('gone').title).toBe('Nothing gone');
  });

  it('Enter or Space opens a row; modified keys do nothing', () => {
    const k = (key: string, mod: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => bankStockKeyAction({ key, ctrlKey: false, metaKey: false, altKey: false, ...mod });
    expect(k('Enter')).toBe('open');
    expect(k(' ')).toBe('open');
    expect(k('Enter', { ctrlKey: true })).toBeNull();
    expect(k('j')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('createBankStockLoader', () => {
  const q = (over: Partial<BankStockQuery> = {}): BankStockQuery => ({ bank: 'hats', filter: 'all', limit: 200, offset: 0, ...over });

  function harness() {
    const calls: { q: BankStockQuery; d: ReturnType<typeof deferred<BankStockResult>> }[] = [];
    const data = vi.fn();
    const error = vi.fn();
    const busy = vi.fn();
    const loader = createBankStockLoader(
      (query) => {
        const d = deferred<BankStockResult>();
        calls.push({ q: query, d });
        return d.promise;
      },
      { data, error, busy },
    );
    return { calls, data, error, busy, loader };
  }

  it('reads once at a time: a burst of refreshes during a read costs one more read', async () => {
    const t = harness();
    t.loader.refresh();
    expect(t.calls).toHaveLength(0);
    t.loader.load(q());
    for (let i = 0; i < 5; i++) t.loader.refresh();
    expect(t.calls).toHaveLength(1);
    t.calls[0]!.d.resolve(result({ generatedAt: 1 }));
    await flush();
    expect(t.data).toHaveBeenCalledTimes(1);
    expect(t.calls).toHaveLength(2);
    t.calls[1]!.d.resolve(result({ generatedAt: 2 }));
    await flush();
    expect(t.data.mock.calls.map((c) => (c[0] as BankStockResult).generatedAt)).toEqual([1, 2]);
    expect(t.data.mock.calls[1]![1]).toEqual(q());
    expect(t.busy.mock.calls.map((c) => c[0])).toEqual([true, true, false]);
  });

  it('drops the answer to a query the user has since changed, and reads the new one', async () => {
    const t = harness();
    t.loader.load(q());
    t.loader.load(q({ filter: 'new' }));
    expect(t.calls).toHaveLength(1);
    t.calls[0]!.d.resolve(result({ generatedAt: 1 }));
    await flush();
    expect(t.data).not.toHaveBeenCalled();
    expect(t.calls[1]!.q.filter).toBe('new');
    t.calls[1]!.d.resolve(result({ generatedAt: 2 }));
    await flush();
    expect(t.data).toHaveBeenCalledTimes(1);
    expect(t.data.mock.calls[0]![1]).toMatchObject({ filter: 'new' });
    // A stale failure is dropped too.
    t.loader.load(q({ filter: 'gone' }));
    t.loader.load(q({ filter: 'flips' }));
    t.calls[2]!.d.reject(new Error('old'));
    await flush();
    expect(t.error).not.toHaveBeenCalled();
    t.calls[3]!.d.reject(new Error('The background service is restarting.'));
    await flush();
    expect(t.error).toHaveBeenCalledWith('The background service is restarting.');
  });

  it('never shows another bank\'s answer, nor anything after dispose', async () => {
    const t = harness();
    t.loader.load(q());
    t.calls[0]!.d.resolve(result({ bank: 'weapons' }));
    await flush();
    expect(t.data).not.toHaveBeenCalled();
    t.loader.refresh();
    t.loader.dispose();
    t.calls[1]!.d.resolve(result());
    await flush();
    expect(t.data).not.toHaveBeenCalled();
    t.loader.load(q());
    t.loader.refresh();
    expect(t.calls).toHaveLength(2);
  });

  it('reports a call that throws at once', async () => {
    const error = vi.fn();
    const loader = createBankStockLoader(
      () => {
        throw new Error('bridge missing');
      },
      { data: vi.fn(), error },
    );
    loader.load(q());
    await flush();
    expect(error).toHaveBeenCalledWith('bridge missing');
  });
});

describe('F20: Listed and Since listed', () => {
  const D = 24 * HOUR;
  const change = (fromScrap: number, toScrap: number, since = NOW - 2 * D) => ({ fromScrap, toScrap, deltaScrap: toScrap - fromScrap, pct: fromScrap > 0 ? (toScrap - fromScrap) / fromScrap : null, since });

  it('Listed: how long the run of saves has listed it on sale, long from a day', () => {
    const c = bankStockListedCell(row({ listedSince: NOW - (2 * D + 4 * HOUR), firstSeenAt: NOW - 2 * D - 4 * HOUR }), NOW);
    expect(c).toMatchObject({ text: '2 d 4 h', muted: false, long: true });
    expect(c.title).toContain(`since ${fmtDateTime(NOW - (2 * D + 4 * HOUR))} (2 d 4 h)`);
    expect(c.title).toContain('What happened between two saves is unknown.');
    expect(c.title).not.toContain('off sale');
    const short = bankStockListedCell(row({ listedSince: NOW - (65 * MIN), firstSeenAt: NOW - 5 * D }), NOW);
    expect(short).toMatchObject({ text: '1 h 05 m', long: false });
    // An earlier run: it was off sale in between.
    expect(short.title).toContain(`Your saves first listed it on sale ${fmtDateTime(NOW - 5 * D)}; it was off sale for a while since.`);
    expect(bankStockListedCell(row({ listedSince: NOW - D }), NOW).long).toBe(true);
    expect(bankStockListedCell(row({ listedSince: NOW - D + 1 }), NOW).long).toBe(false);
    // A file time a little ahead of the clock reads 0, never negative.
    expect(bankStockListedCell(row({ listedSince: NOW + MIN }), NOW).text).toBe('0 m');
  });

  it('Listed: a dash for a gone row or one without a run', () => {
    expect(bankStockListedCell(row({ listedSince: null }), NOW)).toMatchObject({ text: '—', muted: true, long: false });
    expect(bankStockListedCell(row({ listedSince: null, change: 'gone' }), NOW).title).toBe('Not on sale in your newest save.');
  });

  it('Since listed: the arrow and the percentage, cheaper good and pricier bad, valued now', () => {
    const down = bankStockSinceListedCell(row({ changeSinceListed: change(12, 11) }), K);
    expect(down).toMatchObject({ text: '↓ 8 %', tone: 'good' });
    expect(down.title).toBe(`1.33 ref when your saves began listing it (${fmtDateTime(NOW - 2 * D)}), 1.22 ref now: cheaper by 0.11 ref (\u22128 %), both at today's key price.`);
    expect(bankStockSinceListedCell(row({ changeSinceListed: change(20, 21) }), K)).toMatchObject({ text: '↑ 5 %', tone: 'bad' });
    expect(bankStockSinceListedCell(row({ changeSinceListed: change(1000, 999) }), K).text).toBe('↓ 0.1 %');
    expect(bankStockSinceListedCell(row({ changeSinceListed: change(27, 27) }), K)).toMatchObject({ text: '0 %', tone: 'muted' });
    // From a free price there is no percentage: the amount instead.
    expect(bankStockSinceListedCell(row({ changeSinceListed: change(0, 9) }), K).text).toBe('↑ 1.00 ref');
    expect(bankStockSinceListedCell(row({ changeSinceListed: null }), K)).toMatchObject({ text: '—', tone: 'muted' });
  });

  it('both sort from the picker and the headers, at their own default direction', () => {
    expect(BANK_STOCK_PICKER_SORTS).toEqual(['profit', 'margin', 'cost', 'name', 'payUpTo', 'listed', 'sinceListed']);
    expect(BANK_STOCK_PICKER_SORTS).toEqual(BANK_STOCK_SORTS);
    expect(BANK_STOCK_SORT_LABELS.listed).toBe('Listed');
    expect(BANK_STOCK_SORT_LABELS.sinceListed).toBe('Since listed');
    // Longest listed first; the biggest drop first.
    expect(bankStockSortChange({ sort: 'profit', dir: 'desc' }, 'listed')).toEqual({ sort: 'listed', dir: 'desc' });
    expect(bankStockSortChange({ sort: 'profit', dir: 'desc' }, 'sinceListed')).toEqual({ sort: 'sinceListed', dir: 'asc' });
    expect(bankStockSortChange({ sort: 'listed', dir: 'desc' }, 'listed')).toEqual({ sort: 'listed', dir: 'asc' });
    expect(sanitizeBankStockView({ sort: 'sinceListed', filter: 'dropped' })).toMatchObject({ sort: 'sinceListed', dir: 'asc', filter: 'dropped' });
  });

  it('the chips say what they keep, and an empty one says why', () => {
    expect(BANK_STOCK_FILTER_LABELS['long-listed']).toBe('Listed > 24 h');
    expect(BANK_STOCK_FILTER_LABELS.dropped).toBe('Dropped since listed');
    // Neither compares two saves: a first save does not disable them.
    expect(isChangeFilter('long-listed')).toBe(false);
    expect(isChangeFilter('dropped')).toBe(false);
    const first = bankStockChips(result({ previousSavedAt: null, saves: 1, counts: counts({ items: 10, inStock: 8, longListed: 3 }) }));
    expect(first.find((c) => c.filter === 'long-listed')).toMatchObject({ count: '3', disabled: false });
    expect(bankStockFilterEmpty('long-listed').title).toBe('Nothing listed for over a day');
    expect(bankStockFilterEmpty('dropped').title).toBe('Nothing dropped since listed');
  });
});
