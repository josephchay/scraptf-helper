// F17 (bank stock) in the Live market and the item drawer's model (src/renderer/marketModel.ts): the
// "New on scrap.tf" source filter (persisted, counted, sent as MarketQuery.newOnScraptf and answered by
// the browser mock), the Item cell's "New" badge for MarketRow.scraptfNewAt, the empty-table advice,
// and the drawer's bank stock line for ItemDetail.bankStock. Everything here is text from pages the
// user saved; nothing loads a scrap.tf page. No network: the mock is in memory.

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { bankStockPath, bankStockRouteBank, banksPath } from '../../src/renderer/banksModel';
import { parseHash } from '../../src/renderer/hooks/useHashRoute';
import {
  DEFAULT_MARKET_FILTERS,
  DEFAULT_MARKET_SORT,
  NEW_ON_SCRAPTF_HINT,
  NEW_ON_SCRAPTF_LABEL,
  NEW_ON_SCRAPTF_TITLE,
  SCRAPTF_NEW_FRESH_MS,
  activeMarketFilterCount,
  bankStockRoute,
  defaultMarketFilters,
  drawerBankStockLine,
  emptyFiltersText,
  marketDisplayRows,
  marketExportQuery,
  marketListParams,
  marketQuery,
  marketRouteIntent,
  marketSourceCount,
  marketWindowQuery,
  sanitizeMarketFilters,
  scraptfNewBadge,
  type MarketFilters,
} from '../../src/renderer/marketModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { MarketTableProps } from '../../src/renderer/pages/MarketPage';
import { MarketTable } from '../../src/renderer/pages/MarketPage';
import { bankStockPagePath } from '../../src/shared/bankStock';
import { SCRAPTF_BANKS, SCRAPTF_ITEMS_URL, scraptfBankInfo, scraptfLinkFor } from '../../src/shared/links';
import { MARKET_MAX_LIMIT } from '../../src/shared/market';
import type { ItemBankStock, MarketRow } from '../../src/shared/types';

const KEY = 568;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');

function filters(over: Partial<MarketFilters> = {}): MarketFilters {
  return { ...defaultMarketFilters(), ...over };
}

function row(over: Partial<MarketRow> & { sku: string }): MarketRow {
  return {
    name: `Item ${over.sku}`,
    category: 'hats',
    revenueScrap: 120,
    bestScrap: 130,
    consScrap: 120,
    instantScrap: 110,
    revenueOrder: null,
    buyerCount: 3,
    maxCostScrap: 100,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    knownCostScrap: null,
    knownSource: 'none',
    knownObservedAt: null,
    stock: null,
    ruleCostScrap: null,
    profitScrap: null,
    verdict: 'unchecked',
    lastOrderChangeAt: NOW - MIN,
    evaluatedAt: NOW,
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

function stock(over: Partial<ItemBankStock> = {}): ItemBankStock {
  return { bank: 'hats', savedAt: NOW - 12 * MIN, change: null, previousCostScrap: null, stock: 3, ...over };
}

describe('"New on scrap.tf" source filter (F17)', () => {
  it('starts off, restores only a real true, and is off for filters saved before 0.6', () => {
    expect(DEFAULT_MARKET_FILTERS.newOnScraptf).toBe(false);
    expect(defaultMarketFilters().newOnScraptf).toBe(false);
    expect(sanitizeMarketFilters({ newOnScraptf: true }).newOnScraptf).toBe(true);
    for (const v of [1, 'true', 'yes', null, {}, undefined]) expect(sanitizeMarketFilters({ newOnScraptf: v }).newOnScraptf).toBe(false);
    // A 0.5 file: every other filter kept, the new one off.
    const old = { search: 'hat', categories: ['hats'], verdicts: ['flip'], sources: ['page'], minCeiling: '2 ref', onlyBotBuyers: true, minBuyers: 3, onScraptfList: true };
    expect(sanitizeMarketFilters(old)).toEqual({ ...old, newOnScraptf: false, listedOnScraptf: false });
  });

  it('counts once among the active filters and on the Source button', () => {
    expect(activeMarketFilterCount(filters({ newOnScraptf: true }))).toBe(1);
    expect(activeMarketFilterCount(filters({ newOnScraptf: true, onScraptfList: true, sources: ['page'] }))).toBe(3);
    expect(marketSourceCount(filters())).toBe(0);
    expect(marketSourceCount(filters({ newOnScraptf: true }))).toBe(1);
    expect(marketSourceCount(filters({ newOnScraptf: true, onScraptfList: true, sources: ['page', 'typed'] }))).toBe(4);
  });

  it('is sent as MarketQuery.newOnScraptf only when on, through the window, the request and the export', () => {
    expect(marketQuery(filters(), null, DEFAULT_MARKET_SORT)).not.toHaveProperty('newOnScraptf');
    expect(marketQuery(filters({ newOnScraptf: false }), null, DEFAULT_MARKET_SORT)).toEqual({ sort: 'ceiling', dir: 'desc' });
    expect(marketQuery(filters({ newOnScraptf: true }), null, DEFAULT_MARKET_SORT)).toEqual({ sort: 'ceiling', dir: 'desc', newOnScraptf: true });
    const win = marketWindowQuery(filters({ newOnScraptf: true, onScraptfList: true }), { keys: 1, scrap: 0 }, DEFAULT_MARKET_SORT);
    const params = marketListParams({ ...win, limit: 200, offset: 0 }, KEY);
    expect(params).toMatchObject({ newOnScraptf: true, onScraptfList: true, minCeilingScrap: KEY, limit: 200 });
    expect(marketExportQuery(params)).toEqual({ sort: 'ceiling', dir: 'desc', newOnScraptf: true, onScraptfList: true, minCeilingScrap: KEY });
  });

  it('a bank card\'s "See all" starts without it', () => {
    expect(marketRouteIntent(['market', 'bank', 'hats'])!.filters.newOnScraptf).toBe(false);
  });

  it('says what the switch keeps, from saved pages only', () => {
    expect(NEW_ON_SCRAPTF_LABEL).toBe('New on scrap.tf');
    expect(NEW_ON_SCRAPTF_HINT).toBe('since your previous save');
    expect(NEW_ON_SCRAPTF_TITLE).toMatch(/newest save of a scrap\.tf bank page/);
    expect(NEW_ON_SCRAPTF_TITLE).toMatch(/the app never visits scrap\.tf\.$/);
  });

  it('the empty table tells the user to save the page again or untick it', () => {
    expect(emptyFiltersText(filters())).toBe(
      'Clear the search or the verdict chips, or lower the minimums. Items without buyers show only when you have a scrap.tf price for them.',
    );
    const t = emptyFiltersText(filters({ newOnScraptf: true }));
    expect(t).toMatch(/^New on scrap\.tf \(under Source\) keeps only items new in your newest save of a scrap\.tf page\./);
    expect(t).toContain('Ctrl+S into your watch folder');
    expect(t).toContain('or untick it.');
    expect(t.endsWith(emptyFiltersText(filters()))).toBe(true);
  });
});

describe('the mock answers the filter like the service (marketNewSideMatches)', () => {
  let b: MockBridge | null = null;
  afterEach(() => {
    b?.dispose();
    b = null;
  });

  it('only rows new on scrap.tf, each dated by a save; fewer than without it', async () => {
    b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW });
    const all = await b.rpc('market.list', marketListParams({ ...marketWindowQuery(filters(), null, DEFAULT_MARKET_SORT), limit: MARKET_MAX_LIMIT, offset: 0 }, KEY));
    const only = await b.rpc('market.list', marketListParams({ ...marketWindowQuery(filters({ newOnScraptf: true }), null, DEFAULT_MARKET_SORT), limit: MARKET_MAX_LIMIT, offset: 0 }, KEY));
    const dated = all.rows.filter((r) => r.scraptfNewAt !== null);
    expect(dated.length).toBeGreaterThan(0);
    expect(dated.length).toBeLessThan(all.rows.length);
    expect(only.total).toBe(dated.length);
    expect(only.rows.length).toBeGreaterThan(0);
    for (const r of only.rows) {
      expect(r.scraptfNewAt).not.toBeNull();
      expect(r.scraptfNewAt!).toBeLessThanOrEqual(NOW);
      expect(scraptfNewBadge(r, NOW)?.text).toBe('New');
    }
    expect(new Set(only.rows.map((r) => r.sku))).toEqual(new Set(dated.map((r) => r.sku)));
  });
});

describe('"New" badge (MarketRow.scraptfNewAt)', () => {
  it('shows nothing without a save in which the item is new', () => {
    expect(scraptfNewBadge({ scraptfNewAt: null }, NOW)).toBeNull();
    expect(scraptfNewBadge({ scraptfNewAt: Number.NaN }, NOW)).toBeNull();
    expect(scraptfNewBadge({} as Pick<MarketRow, 'scraptfNewAt'>, NOW)).toBeNull();
  });

  it('is info for a save up to a day old, muted after, and says when and what it compares', () => {
    const fresh = scraptfNewBadge({ scraptfNewAt: NOW - 12 * MIN }, NOW)!;
    expect(fresh.text).toBe('New');
    expect(fresh.tone).toBe('info');
    expect(fresh.title).toMatch(/^New on scrap\.tf: on sale in a scrap\.tf page you saved 12 min ago \(/);
    expect(fresh.title).toContain('your previous save of the same page did not have, or had sold out');
    // Per base SKU (bankStockNewAt): a painted copy marks the plain row, so the tooltip says so.
    expect(fresh.title).toContain('(this item or a copy of it with paint or other extras)');
    // The drawer's line (bankStockItemOf) can name a later save of another page: the tooltip warns.
    expect(fresh.title).toContain('newest save that lists this exact item, which can be another page');
    expect(fresh.title).toMatch(/the app never visits scrap\.tf\.$/);
    expect(scraptfNewBadge({ scraptfNewAt: NOW - SCRAPTF_NEW_FRESH_MS }, NOW)!.tone).toBe('info');
    const old = scraptfNewBadge({ scraptfNewAt: NOW - SCRAPTF_NEW_FRESH_MS - 1 }, NOW)!;
    expect(old.tone).toBe('muted');
    expect(old.title).toContain('you saved 1 d ago');
  });

  it('a file time ahead of the clock reads as just now, not "in 2 min"', () => {
    const ahead = scraptfNewBadge({ scraptfNewAt: NOW + 2 * MIN }, NOW)!;
    expect(ahead.tone).toBe('info');
    expect(ahead.title).toContain('you saved just now');
  });

  it('renders in the Item cell, after the name, with no column of its own', () => {
    const rows = [row({ sku: '5021;6', scraptfNewAt: NOW - 4 * MIN }), row({ sku: '30000;6' }), row({ sku: '378;6', scraptfNewAt: NOW - 2 * 24 * HOUR })];
    const noop = () => undefined;
    const props: MarketTableProps = {
      rows: marketDisplayRows(rows, rows.length),
      dataKey: 'q',
      keyScrap: KEY,
      now: NOW,
      density: 'comfortable',
      selectedId: null,
      flash: { seq: 0, dirs: new Map() },
      sort: { ...DEFAULT_MARKET_SORT },
      loadingMore: false,
      frozen: false,
      onSelect: noop,
      onOpen: noop,
      onMenu: noop,
      onLoadMore: noop,
      onSort: noop,
    };
    const html = renderToString(createElement(MarketTable, props));
    const badges = [...html.matchAll(/<span class="pill market-new tone-([a-z]+)" title="([^"]*)">New<span class="sr-only"> on scrap\.tf<\/span><\/span>/g)];
    expect(badges.map((m) => m[1])).toEqual(['info', 'muted']);
    // Inside each new row's Item cell, after the name.
    const cells = [...html.matchAll(/<div role="gridcell" class="m-item">([\s\S]*?)<\/div><div role="gridcell" class="m-cat/g)].map((m) => m[1]!);
    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c.includes('market-new'))).toEqual([true, false, true]);
    expect(cells[0]!.indexOf('SKU 5021;6')).toBeLessThan(cells[0]!.indexOf('market-new'));
    // Eleven cells a row, as the header and the pinned grid budget (marketPage.test.ts) expect.
    expect(html.match(/role="gridcell"/g)).toHaveLength(3 * 11);
  });
});

describe('the drawer\'s bank stock line (ItemDetail.bankStock)', () => {
  const path = bankStockPagePath(scraptfBankInfo('hats')!.url);

  it('names the static page path and the stock page route of every bank', () => {
    expect(path).toBe('scrap.tf/buy/hats');
    for (const info of SCRAPTF_BANKS) {
      expect(bankStockRoute(info.bank)).toBe(`${banksPath(info.bank)}/stock`);
      // The same route the banks page builds and App parses (package B's banksModel), not a copy that can drift.
      expect(bankStockRoute(info.bank)).toBe(bankStockPath(info.bank));
      expect(bankStockRouteBank(parseHash(`#/${bankStockRoute(info.bank)!}`))).toBe(info.bank);
      const line = drawerBankStockLine(stock({ bank: info.bank }), KEY, NOW)!;
      expect(line.bank).toBe(info.bank);
      expect(line.route).toBe(`banks/${info.bank}/stock`);
      expect(line.text).toBe(`On ${bankStockPagePath(info.url)} in your save 12 min ago: 3 in stock`);
    }
    expect(drawerBankStockLine(stock({ bank: 'list' }), KEY, NOW)!.text).toBe('On scrap.tf/items in your save 12 min ago: 3 in stock');
    expect(bankStockPagePath(SCRAPTF_ITEMS_URL)).toBe('scrap.tf/items');
    expect(bankStockRoute('nope' as never)).toBeNull();
    expect(bankStockRoute(null)).toBeNull();
  });

  it('new: "3 in stock, new since your previous save"', () => {
    const line = drawerBankStockLine(stock({ change: 'new' }), KEY, NOW)!;
    expect(line.text).toBe('On scrap.tf/buy/hats in your save 12 min ago: 3 in stock, new since your previous save');
    expect(line.prefix).toBe('On scrap.tf/buy/hats in your save 12 min ago: 3 in stock, ');
    expect(line.change).toBe('new since your previous save');
    expect(line.tone).toBe('info');
    // New after being listed sold out: still just "new" (no "was").
    expect(drawerBankStockLine(stock({ change: 'new', previousCostScrap: 40 }), KEY, NOW)!.change).toBe('new since your previous save');
  });

  it('cheaper and pricier say the previous price at the key price', () => {
    const down = drawerBankStockLine(stock({ change: 'cheaper', previousCostScrap: 12 }), KEY, NOW)!;
    expect(down.text).toBe('On scrap.tf/buy/hats in your save 12 min ago: 3 in stock, ↓ cheaper than before (was 1.33 ref)');
    expect(down.tone).toBe('good');
    const up = drawerBankStockLine(stock({ change: 'pricier', previousCostScrap: KEY + 9, stock: 1 }), KEY, NOW)!;
    expect(up.text).toBe('On scrap.tf/buy/hats in your save 12 min ago: 1 in stock, ↑ pricier than before (was 1 key 1.00 ref)');
    expect(up.tone).toBe('warn');
    // Without a key price, keys read as refined.
    expect(drawerBankStockLine(stock({ change: 'cheaper', previousCostScrap: KEY + 9 }), null, NOW)!.change).toBe('↓ cheaper than before (was 64.11 ref)');
  });

  it('gone: sold out on the newest save, or no longer on the page at all', () => {
    const soldOut = drawerBankStockLine(stock({ change: 'gone', previousCostScrap: 12, stock: 0 }), KEY, NOW)!;
    expect(soldOut.text).toBe('On scrap.tf/buy/hats in your save 12 min ago: sold out, gone since your previous save (was 1.33 ref)');
    expect(soldOut.tone).toBe('muted');
    const absent = drawerBankStockLine(stock({ change: 'gone', previousCostScrap: 12, stock: null }), KEY, NOW)!;
    expect(absent.text).toBe('Not on scrap.tf/buy/hats in your save 12 min ago: gone since your previous save (was 1.33 ref)');
    expect(absent.prefix).toBe('Not on scrap.tf/buy/hats in your save 12 min ago: ');
  });

  it('unchanged or a first save: where and how many, and the tooltip says which', () => {
    const same = drawerBankStockLine(stock({ previousCostScrap: 12 }), KEY, NOW)!;
    expect(same.change).toBeNull();
    expect(same.tone).toBeNull();
    expect(same.text).toBe(same.prefix);
    // Same price, not "unchanged": a stock move alone is no change, and the line has no previous stock.
    expect(same.title).toContain('Same price as in your previous save of it.');
    expect(same.title).not.toMatch(/unchanged/i);
    const first = drawerBankStockLine(stock({ stock: null }), KEY, NOW)!;
    expect(first.text).toBe('On scrap.tf/buy/hats in your save 12 min ago');
    expect(first.title).toContain('Nothing to compare: your first save of it');
    expect(drawerBankStockLine(stock({ stock: 0 }), KEY, NOW)!.text).toBe('On scrap.tf/buy/hats in your save 12 min ago: sold out');
    expect(drawerBankStockLine(stock({ stock: 1234 }), KEY, NOW)!.text).toBe('On scrap.tf/buy/hats in your save 12 min ago: 1,234 in stock');
  });

  it('dates the save (a file time ahead of the clock reads just now), and never claims to fetch', () => {
    expect(drawerBankStockLine(stock({ savedAt: NOW + 3 * MIN }), KEY, NOW)!.text).toBe('On scrap.tf/buy/hats in your save just now: 3 in stock');
    expect(drawerBankStockLine(stock({ savedAt: NOW - 5 * HOUR }), KEY, NOW)!.text).toBe('On scrap.tf/buy/hats in your save 5 h ago: 3 in stock');
    expect(drawerBankStockLine(stock({ savedAt: Number.NaN }), KEY, NOW)!.text).toBe('On scrap.tf/buy/hats in your newest save: 3 in stock');
    const t = drawerBankStockLine(stock({ change: 'new' }), KEY, NOW)!.title;
    expect(t).toMatch(/^From your saved copy of scrap\.tf\/buy\/hats \(/);
    expect(t).toContain('Stock between your saves is unknown.');
    expect(t).toContain('The app never visits scrap.tf');
  });

  it('shows nothing without a save that lists the item, or for a bank it does not know', () => {
    expect(drawerBankStockLine(null, KEY, NOW)).toBeNull();
    expect(drawerBankStockLine(undefined, KEY, NOW)).toBeNull();
    expect(drawerBankStockLine(stock({ bank: 'https://evil.example/' as never }), KEY, NOW)).toBeNull();
  });
});

describe('wiring (static)', () => {
  const page = read('pages/MarketPage.tsx');
  const css = read('styles/market.css');

  it('offers "New on scrap.tf" under the Source choices, next to the list switch, persisted with the other filters', () => {
    const source = page.slice(page.indexOf('<Popover label={<>Source'), page.indexOf('<Popover label={<>Pay up to'));
    expect(source).toContain("<input type=\"checkbox\" checked={filters.newOnScraptf} onChange={() => set('newOnScraptf', !filters.newOnScraptf)} />");
    expect(source).toContain('<span>{NEW_ON_SCRAPTF_LABEL}</span>');
    expect(source).toContain('title={NEW_ON_SCRAPTF_TITLE}');
    expect(source.indexOf('filters.onScraptfList')).toBeLessThan(source.indexOf('filters.newOnScraptf'));
    expect(page.match(/set\('newOnScraptf'/g)).toHaveLength(1);
    expect(page).toContain("usePersistentState<MarketFilters>('market.filters', defaultMarketFilters(), sanitizeMarketFilters)");
    expect(page).toContain('filtersText={emptyFiltersText(filters)}');
  });

  it('puts the badge in the Item cell from the model, and keeps the Recent checks panel and coverage chips', () => {
    const item = page.slice(page.indexOf('const ItemRow = memo'));
    expect(item).toContain('const fresh = scraptfNewBadge(r, now);');
    expect(item).toMatch(/<MarketItemName sku=\{r\.sku\} name=\{r\.name\} \/>\s*\{fresh \? \(\s*<span className=\{`pill market-new tone-\$\{fresh\.tone\}`\} title=\{fresh\.title\}>/);
    expect(page).toContain('<RecentChecks />');
    expect(page).toContain('<CoverageStrip scraptf={scraptf} now={now} />');
  });

  it('styles the badge so it never shrinks, with tokens only', () => {
    expect(css).toMatch(/\.market-new \{\s*flex-shrink: 0;/);
    const rule = css.slice(css.indexOf('.market-new {'), css.indexOf('}', css.indexOf('.market-new {')));
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
