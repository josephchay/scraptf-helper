// F17 bank stock page (#/banks/<bank>/stock): the wiring checked statically (the route next to the
// banks page, the only app methods it calls, the only address it opens, the throttled, visible-only
// refresh, the view remembered per bank, the stylesheet's tokens and width budget), the view rendered
// server-side in every state, then the page mounted with react-dom/client into the minimal DOM in
// domShim.ts against the browser mock: chips, search, Gone, the drawer, the item menu, the keyboard,
// Export CSV, Open in browser and the banksChanged push. Nothing leaves the process, and nothing here
// contacts scrap.tf.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BANK_STOCK_VIEW, type BankStockView } from '../../src/renderer/bankStockModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { BankStockPageViewProps } from '../../src/renderer/pages/BankStockPage';
import { LIST_BOUNDARY_NOTE } from '../../src/renderer/scraptfListModel';
import { emptyBankStockCounts } from '../../src/shared/bankStock';
import { STATIC_EXTERNAL_URLS } from '../../src/shared/links';
import { MAIN_METHODS, SERVICE_METHODS } from '../../src/shared/rpc';
import type { BankStockCounts, BankStockQuery, BankStockResult, BankStockRow, ScraptfBank, ScraptfListStatus } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const noop = () => undefined;

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

describe('the route', () => {
  const app = read('App.tsx');

  it('#/banks/<bank>/stock opens the stock page, keyed by bank; #/banks stays the banks page', () => {
    expect(app).toContain("const stockBank = route === 'banks' ? bankStockRouteBank(segments) : null;");
    expect(app).toContain('if (stockBank) return <BankStockPage key={stockBank} bank={stockBank} />;');
    expect(app).toMatch(/case 'banks':\s*return <BanksPage \/>;/);
    // No nav entry of its own: it lives under scrap.tf banks.
    expect(app).not.toMatch(/\{ id: 'stock'/);
    // The live check and quick entry windows are untouched.
    expect(app).toMatch(/kind === 'quick-entry' \? <QuickEntry \/> : kind === 'check' \? <CheckPopup \/> : kind === 'scraptf' \? <ScraptfWindowBar \/> : <Dashboard \/>/);
  });
});

describe('the page', () => {
  const page = read('pages/BankStockPage.tsx');

  it('reads scraptf.bankStock and exports through opps.exportCsv, nothing else: no new traffic', () => {
    const methods = new Set([...page.matchAll(/rpc\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
    expect([...methods].sort()).toEqual(['opps.exportCsv', 'scraptf.bankStock']);
    for (const m of methods) expect([...SERVICE_METHODS, ...MAIN_METHODS]).toContain(m);
    expect(page).toContain("kind: 'bankStock', bankStock: bankStockExportQuery(bank, view)");
    expect(page).toContain('saveCsv(');
    // The Import and folder hints are the price list card's own state (F14), as on the banks page.
    expect(page).toContain('useScraptfListStatus()');
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|<webview|<iframe|window\.open|location\.href|\bsrc=|\bhref=/);
  });

  it("hands only the bank's static page to the user's browser, through links.open (openOrCopy)", () => {
    expect([...page.matchAll(/openOrCopy\(([^,]+),/g)].map((m) => m[1])).toEqual(['info.url']);
    expect(page).toContain('const info = scraptfBankInfo(bank);');
    // Never the address the service sent: label and URL come from SCRAPTF_BANKS.
    expect(page).not.toMatch(/rpc\('links\.open'|openLink\(|result\.url|\.url\b(?!, toast)/);
  });

  it('refreshes on scraptf.banksChanged and market.changed, throttled and only while shown, never showing an older answer', () => {
    expect(page).toContain("useVisiblePush('scraptf.banksChanged', refreshSoon);");
    expect(page).toContain("useVisiblePush('market.changed', refreshSoon);");
    expect(page).toContain('const refreshSoon = useThrottled(refresh, BANK_STOCK_REFRESH_MS);');
    expect(page).toContain("createBankStockLoader((q) => rpc('scraptf.bankStock', q),");
    expect(page).toMatch(/return \(\) => \{\s*l\.dispose\(\);/);
  });

  it('remembers the filter, search and order per bank; opens the drawer by base SKU and the menu with the bank', () => {
    expect(page).toContain('usePersistentState<BankStockView>(bankStockPrefKey(bank), DEFAULT_BANK_STOCK_VIEW, sanitizeBankStockView)');
    expect(page).toContain('(r: BankStockRow) => openItem(r.sku)');
    expect(page).toContain('menuRef.current({ sku: r.sku, name: r.name, category: r.category, bank }, at)');
  });
});

describe('bank-stock.css', () => {
  const css = read('styles/bank-stock.css');

  it('takes every colour from the tokens, animates nothing and loads nothing', () => {
    // The rules only: the header comment names what the sheet must not do.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\brgba?\(/);
    expect(rules).not.toMatch(/animation|transition/);
    expect(rules).not.toMatch(/url\(|@import/);
  });

  it('is imported after every earlier sheet (only the F20 history and F21 window sheets follow it)', () => {
    const index = read('styles/index.css').trim().split('\n');
    expect(index[index.length - 1]).toBe("@import './scraptf-window.css';");
    expect(index[index.length - 2]).toBe("@import './scraptf-history.css';");
    expect(index[index.length - 3]).toBe("@import './bank-stock.css';");
  });

  it('fits every grid layout in the width its query covers, with no sideways scroll', () => {
    // Each layout: the tracks (a minmax's minimum), 10px gaps and 24px padding fit its lower bound.
    const tracks = (cols: string) => cols.trim().split(/\s+(?![^(]*\))/).map((t) => Number((/(\d+)px/.exec(t) ?? ['', '0'])[1]));
    const width = (cols: string) => {
      const t = tracks(cols);
      return t.reduce((a, b) => a + b, 0) + (t.length - 1) * 10 + 24;
    };
    const block = (max: number) => new RegExp(`@container \\(max-width: ${max}px\\) \\{([\\s\\S]*?)\\n\\}`).exec(css)![1]!;
    const cols = (src: string, sel: RegExp) => new RegExp(`${sel.source} \\{\\s*--bs-cols: ([^;]+);`).exec(src)![1]!;
    const outside = css.replace(/@container[\s\S]*?\n\}/g, '');
    const full = cols(outside, /\.bs-scroll/);
    const fullGone = cols(outside, /\.bs-scroll\.bs-gone/);
    const q1060 = cols(block(1060), /\.bs-scroll \.opp-row/);
    const q1060Gone = cols(block(1060), /\.bs-scroll\.bs-gone \.opp-row/);
    const q960 = cols(block(960), /\.bs-scroll \.opp-row/);
    const q960Gone = cols(block(960), /\.bs-scroll\.bs-gone \.opp-row/);
    // Wide (a 1360px window, ~1087px grid): all nine F17 and F20 columns.
    expect(tracks(full)).toHaveLength(9);
    expect(width(full)).toBeLessThanOrEqual(1060);
    // The Gone view never shows Listed or Since listed (a gone row has no run): F17's seven.
    expect(tracks(fullGone)).toHaveLength(7);
    expect(width(fullGone)).toBeLessThanOrEqual(1060);
    expect(outside).toMatch(/\.bs-scroll\.bs-gone \.opp-row > \.bs-listed,\s*\.bs-scroll\.bs-gone \.opp-row > \.bs-since \{\s*display: none;/);
    // A 1280px window (a ~1019px grid): Confidence goes, in both views.
    expect(tracks(q1060)).toHaveLength(8);
    expect(width(q1060)).toBeLessThanOrEqual(960);
    expect(tracks(q1060Gone)).toHaveLength(6);
    expect(width(q1060Gone)).toBeLessThanOrEqual(960);
    expect(block(1060)).toMatch(/\.bs-scroll \.opp-row > \.bs-conf \{\s*display: none;/);
    // The narrowest grid is about 840px (a 1101px window, wide nav): Stock goes too, but the Gone view
    // keeps it (Last seen) and has no F20 columns to lose.
    expect(tracks(q960)).toHaveLength(7);
    expect(width(q960)).toBeLessThanOrEqual(840);
    expect(tracks(q960Gone)).toHaveLength(6);
    expect(width(q960Gone)).toBeLessThanOrEqual(840);
    expect(block(960)).toMatch(/\.bs-scroll:not\(\.bs-gone\) \.opp-row > \.bs-stock \{\s*display: none;/);
    // Tracks match the cells shown: the page's nine head cells less the hidden ones.
    const heads = [...read('pages/BankStockPage.tsx').matchAll(/cls: '(bs-[a-z]+)/g)].map((m) => m[1]);
    expect(heads).toEqual(['bs-item', 'bs-price', 'bs-stock', 'bs-listed', 'bs-since', 'bs-sells', 'bs-pay', 'bs-verdict', 'bs-conf']);
    // The item name keeps at least 160px in the normal view, 150px in the Gone view.
    expect(tracks(q960)[0]).toBeGreaterThanOrEqual(160);
    expect(tracks(q960Gone)[0]).toBeGreaterThanOrEqual(150);
  });
});

// ---------------------------------------------------------------------------
// Rendered server-side
// ---------------------------------------------------------------------------

const counts = (over: Partial<BankStockCounts> = {}): BankStockCounts => ({ ...emptyBankStockCounts(), ...over });

function row(over: Partial<BankStockRow> = {}): BankStockRow {
  return {
    sku: '378;6',
    key: '378;6|',
    name: 'Team Captain',
    category: 'hats',
    hasExtras: false,
    costKeys: 0,
    costScrapRaw: 27,
    costScrap: 27,
    stock: 3,
    change: null,
    previousCostScrap: 27,
    previousStock: 5,
    revenueScrap: 45,
    revenueOrder: { listingId: 'l', steamid: '76561198000000001', userName: 'Keybot', keys: 0, metalScrap: 45, valueScrap: 45, isBot: true, online: true, lastEventAt: T0, bumpedAt: null, details: '', flags: [], eligible: true },
    buyerCount: 4,
    maxCostScrap: 36,
    profitScrap: 9,
    margin: 1 / 3,
    verdict: 'flip',
    confidence: 72,
    confidenceLevel: 'high',
    listedSince: null,
    firstSeenAt: null,
    changeSinceListed: null,
    ...over,
  };
}

const ROWS: BankStockRow[] = [
  row({ change: 'new', previousCostScrap: null, previousStock: null }),
  row({ sku: '30;6', key: '30;6|', name: 'Hat of Undeniable Wealth', change: 'cheaper', costScrap: 18, costScrapRaw: 18, previousCostScrap: 27, stock: 1, previousStock: 1 }),
  row({ sku: '31;6', key: '31;6|[14,[],[],null,null,false,false]', name: 'Painted Hat', hasExtras: true, verdict: 'over', costScrap: 45, costScrapRaw: 45, profitScrap: -9, margin: -0.2 }),
  row({ sku: '32;6', key: '32;6|', name: 'Lonely Hat', verdict: 'no-buyers', revenueScrap: null, revenueOrder: null, buyerCount: 0, maxCostScrap: null, profitScrap: null, margin: null, confidence: null, confidenceLevel: null }),
];

const RESULT: BankStockResult = {
  bank: 'hats',
  label: 'Hats',
  url: 'https://scrap.tf/buy/hats',
  savedAt: T0 - 12 * MIN,
  previousSavedAt: T0 - 3 * HOUR,
  saves: 2,
  counts: counts({ items: 48, inStock: 31, new: 5, gone: 3, cheaper: 2, pricier: 1, flips: 7, newFlips: 2, longListed: 6, dropped: 2 }),
  rows: ROWS,
  total: ROWS.length,
  keyPrice: null,
  generatedAt: T0,
};
const STATUS: ScraptfListStatus = { items: 2341, newestAt: T0 - 3 * MIN, oldestAt: T0 - 26 * HOUR, pages: 3, importEnabled: true, watchFolder: 'D:\\saves', watchActive: true, watchError: null };

function props(over: Partial<BankStockPageViewProps> = {}): BankStockPageViewProps {
  return {
    bank: 'hats',
    result: RESULT,
    answered: { filter: 'all', sort: 'profit', dir: 'desc' },
    error: null,
    busy: false,
    status: STATUS,
    view: { ...DEFAULT_BANK_STOCK_VIEW },
    now: T0,
    keyScrap: 568,
    density: 'comfortable',
    selectedKey: null,
    picking: false,
    onView: noop,
    onRetry: noop,
    onOpenPage: noop,
    onBack: noop,
    onGoImport: noop,
    onPickFolder: noop,
    onCopyPath: noop,
    onExport: noop,
    onLoadMore: noop,
    onSelect: noop,
    onOpen: noop,
    onMenu: noop,
    ...over,
  };
}

let BankStockPageView: typeof import('../../src/renderer/pages/BankStockPage').BankStockPageView;
let BankStockPage: typeof import('../../src/renderer/pages/BankStockPage').BankStockPage;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom/client loads: it checks for a DOM once, at import.
  doc = installDomShim();
  win()['location'] = { hash: '#/banks/hats/stock' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  // The sort picker is a <select>: React marks its options.
  if (!Object.getOwnPropertyDescriptor(ShimElement.prototype, 'options')) {
    Object.defineProperty(ShimElement.prototype, 'options', {
      configurable: true,
      get(this: ShimElement) {
        return this.tagName === 'SELECT' ? this.descendants().filter((e) => e.tagName === 'OPTION') : undefined;
      },
    });
  }
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ BankStockPageView, BankStockPage } = await import('../../src/renderer/pages/BankStockPage'));
});

const html = (over: Partial<BankStockPageViewProps> = {}) => renderToString(createElement(AppProvider, null, createElement(BankStockPageView, props(over)))).replace(/<!-- -->/g, '');

describe('BankStockPageView, rendered', () => {
  it('heads the page with the bank, both saves, Open in browser, the Ctrl+S tip and the boundary', () => {
    const h = html();
    expect(h).toMatch(/<h2 id="bs-title" class="bs-title">Hats stock<\/h2>/);
    expect(h).toContain('scrap.tf/buy/hats');
    expect(h).toContain('saved 12 min ago · 48 items (31 in stock)');
    expect(h).toContain('previous save 3 h ago');
    expect(h).toContain('aria-label="Open in browser: scrap.tf/buy/hats"');
    // F18: the save type, the alternative and why.
    expect(h).toMatch(
      /Save it with <kbd>Ctrl<\/kbd>\+<kbd>S<\/kbd> into your watch folder and <span class="save-mode"[^>]*>choose <strong>Webpage, Complete<\/strong> \(or <strong>Webpage, Single File \(\.mhtml\)<\/strong>\) so cards scrap\.tf added after the page loaded are included<\/span>; it updates here within seconds\./,
    );
    expect(h).toContain(LIST_BOUNDARY_NOTE);
    expect(h).toContain('Each save is a snapshot of the page at that moment');
    expect(h).toContain('All scrap.tf banks');
    expect(h).toContain('D:\\saves');
    expect(h).not.toContain('First save of this page');
  });

  it('shows the filter chips with their counts, the current one pressed', () => {
    const h = html({ view: { ...DEFAULT_BANK_STOCK_VIEW, filter: 'new' } });
    const chips = [...h.matchAll(/<button type="button" class="chip bs-chip tone-\w+( on)?" aria-pressed="(true|false)"[^>]*>.*?<\/span>([^<]+)<span class="chip-count">([^<]+)<\/span><\/button>/g)].map((m) => [m[3], m[4], m[2]]);
    expect(chips).toEqual([
      ['All', '31', 'false'],
      ['New', '5', 'true'],
      ['Flips', '7', 'false'],
      ['Price changes', '3', 'false'],
      ['Gone', '3', 'false'],
      ['Listed &gt; 24 h', '6', 'false'],
      ['Dropped since listed', '2', 'false'],
    ]);
  });

  it('lists each row: New, "↓ was X", extras, stock moves, the buyer, Pay up to, the verdict pill and confidence', () => {
    const h = html();
    expect(h).toMatch(/class="pill tone-good bs-new"[^>]*>New<\/span>/);
    expect(h).toContain('↓ was 3.00 ref');
    expect(h).toMatch(/class="bs-extras"[^>]*>extras<\/span>/);
    // Its hover names the copy's extras, read from the row key.
    expect(h).toContain('title="This copy has extras: Paint: #00000E. Pay up to and the verdict are for a clean copy');
    expect(h).toContain('5 → 3');
    expect(h).toContain('Keybot');
    expect(h).toContain('Flip +1.00 ref (33%)');
    expect(h).toContain('Over by 1.00 ref');
    expect(h).toContain('No buyers');
    expect(h).toMatch(/role="columnheader" class="bs-price num"[^>]*><button[^>]*>scrap\.tf price/);
    expect(h).toMatch(/role="columnheader" class="bs-stock num"[^>]*>Stock</);
    expect(h).toContain('role="grid" aria-label="Bank stock. Use j and k or the arrow keys to move, Enter to open, Shift+F10 for item actions."');
    expect(h.match(/class="opp-row opp-item bs-row /g)).toHaveLength(4);
  });

  it('the Gone view shows the last price and when it was last seen', () => {
    const gone = ROWS.slice(0, 2).map((r) => ({ ...r, change: 'gone' as const, stock: null }));
    const h = html({ result: { ...RESULT, rows: gone, total: 2 }, answered: { filter: 'gone' }, view: { ...DEFAULT_BANK_STOCK_VIEW, filter: 'gone' } });
    expect(h).toMatch(/role="columnheader" class="bs-price num"[^>]*><button[^>]*>Last price/);
    expect(h).toMatch(/role="columnheader" class="bs-stock num"[^>]*>Last seen</);
    expect(h).toContain('class="opp-scroll bs-scroll density-comfortable bs-gone"');
    expect(h.match(/class="bs-stock num muted"[^>]*>3 h ago</g)).toHaveLength(2);
  });

  it('F20: Listed and Since listed on each row (sortable headers); the Gone view leaves them to the stylesheet to hide', () => {
    const rows = [
      row({ listedSince: T0 - 52 * HOUR, firstSeenAt: T0 - 52 * HOUR, changeSinceListed: { fromScrap: 12, toScrap: 11, deltaScrap: -1, pct: -1 / 12, since: T0 - 52 * HOUR } }),
      row({ sku: '30;6', key: '30;6|', name: 'Hat B', listedSince: T0 - 65 * MIN, firstSeenAt: T0 - 9 * HOUR, changeSinceListed: { fromScrap: 20, toScrap: 21, deltaScrap: 1, pct: 0.05, since: T0 - 65 * MIN } }),
      row({ sku: '31;6', key: '31;6|', name: 'Hat C' }),
    ];
    const h = html({ result: { ...RESULT, rows, total: 3 } });
    expect(h).toMatch(/role="columnheader" class="bs-listed num"[^>]*><button[^>]*>Listed</);
    expect(h).toMatch(/role="columnheader" class="bs-since num"[^>]*><button[^>]*>Since listed</);
    expect(h).toMatch(/class="bs-listed num long"[^>]*>2 d 4 h</);
    expect(h).toMatch(/class="bs-since num tone-text-good"[^>]*>↓ 8 %</);
    expect(h).toMatch(/class="bs-listed num"[^>]*>1 h 05 m</);
    expect(h).toMatch(/class="bs-since num tone-text-bad"[^>]*>↑ 5 %</);
    expect(h).toMatch(/class="bs-listed num muted"[^>]*>—</);
    expect(h).toMatch(/class="bs-since num muted"[^>]*>—</);
    // The second row was off sale for a while before this run.
    expect(h).toContain('it was off sale for a while since.');
    // Nine cells per row, in the head's order.
    const first = /<div id="bsrow-0"[\s\S]*?<\/div><\/div>(?=<div id="bsrow-1")/.exec(h)![0];
    expect([...first.matchAll(/role="gridcell" class="(bs-[a-z]+)/g)].map((m) => m[1])).toEqual(['bs-item', 'bs-price', 'bs-stock', 'bs-listed', 'bs-since', 'bs-sells', 'bs-pay', 'bs-verdict', 'bs-conf']);
  });

  it('a first save: says so, and the change chips wait for the next save', () => {
    const h = html({ result: { ...RESULT, previousSavedAt: null, saves: 1, counts: counts({ items: 10, inStock: 8, flips: 2 }) } });
    expect(h).toContain('First save of this page: save it again later to see what changed.');
    expect(h).toContain('first save');
    expect(h.match(/class="chip bs-chip[^"]*" aria-pressed="false" disabled=""/g)).toHaveLength(3);
  });

  it('a change filter remembered from an earlier visit, answered on a first save, waits for All instead of saying nothing is new', () => {
    const first = { ...RESULT, previousSavedAt: null, saves: 1, rows: [], total: 0 };
    const h = html({ result: first, answered: { filter: 'new' }, view: { ...DEFAULT_BANK_STOCK_VIEW, filter: 'new' } });
    expect(h).toContain('Reading your saves of scrap.tf/buy/hats…');
    expect(h).not.toContain('Nothing new since your previous save');
    expect(h).not.toContain('Show all');
  });

  it('the list (scrap.tf/items) offers Webpage, Complete only: a Single File save of it is too big to import', () => {
    const never: BankStockResult = { ...RESULT, bank: 'list', savedAt: null, previousSavedAt: null, saves: 0, counts: counts(), rows: [], total: 0 };
    const steps = html({ bank: 'list', result: never });
    expect(steps).toContain('No save of scrap.tf/items yet');
    expect(steps).toMatch(
      /Press <kbd>Ctrl<\/kbd>\+<kbd>S<\/kbd>, <span class="save-mode"[^>]*>choose <strong>Webpage, Complete<\/strong> so cards scrap\.tf added after the page loaded are included<\/span>, and save it into your watch folder/,
    );
    expect(steps).toMatch(
      /Save it with <kbd>Ctrl<\/kbd>\+<kbd>S<\/kbd> into your watch folder and <span class="save-mode"[^>]*>choose <strong>Webpage, Complete<\/strong> so cards scrap\.tf added after the page loaded are included<\/span>; it updates here within seconds\./,
    );
    expect(steps).not.toContain('Single File (.mhtml)</strong>');
    expect(html({ bank: 'list', result: { ...RESULT, bank: 'list' } })).not.toContain('Single File (.mhtml)</strong>');
  });

  it('never saved: the save steps with Open in browser; import off: the way to turn it on', () => {
    const never: BankStockResult = { ...RESULT, bank: 'skins', savedAt: null, previousSavedAt: null, saves: 0, counts: counts(), rows: [], total: 0 };
    const h = html({ bank: 'skins', result: never });
    expect(h).toContain('No save of scrap.tf/buy/skins yet');
    expect(h).toContain('Open scrap.tf/buy/skins in your own browser; Flip Desk never visits it.');
    expect(h).toMatch(
      /Press <kbd>Ctrl<\/kbd>\+<kbd>S<\/kbd>, <span class="save-mode"[^>]*>choose <strong>Webpage, Complete<\/strong> \(or <strong>Webpage, Single File \(\.mhtml\)<\/strong>\) so cards scrap\.tf added after the page loaded are included<\/span>, and save it into your watch folder<span class="mono"> \(D:\\saves\)<\/span>\./,
    );
    expect(h.match(/aria-label="Open in browser: scrap\.tf\/buy\/skins"/g)).toHaveLength(2);
    expect(h).toContain('Not saved yet');
    // Nothing to export.
    expect(h).toMatch(/<button type="button" class="btn small" disabled=""[^>]*><svg[^>]*>.*?<\/svg> Export CSV<\/button>/);
    const off = html({ bank: 'skins', result: never, status: { ...STATUS, importEnabled: false } });
    expect(off).toContain('Saved-page import is off');
    expect(off).toContain('Open Import');
    expect(off).toContain('Turn on Import first');
    expect(off.match(/disabled=""[^>]*aria-label="Open in browser/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('an empty chip or search says why, with the way back', () => {
    const empty = { ...RESULT, rows: [], total: 0 };
    expect(html({ result: empty, answered: { filter: 'gone' } })).toContain('Nothing gone');
    expect(html({ result: empty, answered: { filter: 'gone' } })).toContain('Show all');
    expect(html({ result: empty, answered: { filter: 'all', search: 'zzz' } })).toContain('Nothing here matches the search');
    expect(html({ result: empty, answered: { filter: 'all' } })).toContain('Nothing on sale in your newest save');
  });

  it('loading, a failed first read with Retry, and a failed refresh that keeps the rows', () => {
    const loading = html({ result: null, answered: null });
    expect(loading).toContain('Reading your saves of scrap.tf/buy/hats…');
    // Nothing is known yet: no "Never saved" pill before the answer.
    expect(loading).not.toContain('Never saved');
    const failed = html({ result: null, answered: null, error: 'The background service is restarting.' });
    expect(failed).toContain('Could not read your saves of scrap.tf/buy/hats: The background service is restarting.');
    expect(failed).not.toContain('Reading your saves');
    expect(failed).not.toContain('Never saved');
    const later = html({ error: 'x' });
    expect(later).toContain('refresh failed');
    expect(later.match(/class="opp-row opp-item bs-row /g)).toHaveLength(4);
  });

  it('"Load more" under the table when more rows match than show', () => {
    const h = html({ result: { ...RESULT, total: 300 } });
    expect(h).toContain('Showing 4 of 300');
    expect(h).toContain('Load 200 more');
    expect(html()).not.toContain('Showing 4 of');
  });

  // F17-UI-3: a background refresh (a push, every ~2 s on a busy feed) is not the user's "Load more".
  it('keeps "Load more" usable during a background refresh, and says "Loading…" only for its own read', () => {
    const loadMore = (h: string) => /<button[^>]*>(Load \d+ more|Loading…)<\/button>/.exec(h)?.[0] ?? '';
    const refreshing = html({ result: { ...RESULT, total: 300 }, busy: true, loadingMore: false });
    expect(refreshing).toContain('updating…');
    expect(loadMore(refreshing)).toContain('Load 200 more');
    expect(loadMore(refreshing)).not.toContain('disabled');
    const paging = html({ result: { ...RESULT, total: 300 }, busy: true, loadingMore: true });
    expect(loadMore(paging)).toContain('Loading…');
    expect(loadMore(paging)).toContain('disabled');
    // The page tells the two apart from the page size it asked for (bankStockLoadingMore, pinned in its model test).
    expect(read('pages/BankStockPage.tsx')).toContain('loadingMore={bankStockLoadingMore(stock.busy, stock.answer?.query ?? null, queryKey, limit)}');
  });
});

// ---------------------------------------------------------------------------
// Mounted
// ---------------------------------------------------------------------------

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  win()['location'] = { hash: '#/banks/hats/stock' };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** What the app state says outside the page: the drawer's item and the toasts. */
function Probe() {
  const { itemSku, toasts } = useApp();
  return createElement('output', { 'data-item': itemSku ?? '', 'data-toasts': toasts.map((t) => t.text).join('|') });
}

function fire(target: ShimElement, type: string, init: Record<string, unknown> = {}) {
  act(() => {
    target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
}

async function mountPage(bank: ScraptfBank, opts: { importOn?: boolean; store?: Map<string, string> } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const store = opts.store ?? new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash: `#/banks/${bank}/stock` };
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  if (opts.importOn !== false) await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'D:\\saves' } });
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(BankStockPage, { bank }), createElement(Probe))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const calls = (method: string) => rpc.mock.calls.filter((c) => c[0] === method);
  const queries = () => calls('scraptf.bankStock').map((c) => c[1] as BankStockQuery);
  const all = () => container.descendants();
  const rows = () => all().filter((e) => (e.getAttribute('class') ?? '').includes(' bs-row '));
  const grid = () => all().find((e) => e.getAttribute('role') === 'grid')!;
  const chip = (label: string) => all().find((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '').includes('bs-chip') && e.textContent.startsWith(label))!;
  const button = (label: RegExp) => all().find((e) => e.tagName === 'BUTTON' && label.test(e.textContent));
  const probe = () => all().find((e) => e.tagName === 'OUTPUT')!;
  return { b, store, calls, queries, rows, grid, chip, button, probe, content: () => container.textContent };
}

describe('BankStockPageView, mounted', () => {
  function mountView(over: Partial<BankStockPageViewProps> = {}) {
    const spies = { onView: vi.fn(), onMenu: vi.fn(), onOpen: vi.fn(), onSelect: vi.fn(), onLoadMore: vi.fn(), onOpenPage: vi.fn(), onExport: vi.fn() };
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const render = (p: Partial<BankStockPageViewProps>) => act(() => root.render(createElement(AppProvider, null, createElement(BankStockPageView, props({ ...spies, ...over, ...p })))));
    render({});
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    const all = () => container.descendants();
    const rows = () => all().filter((e) => (e.getAttribute('class') ?? '').includes(' bs-row '));
    const grid = () => all().find((e) => e.getAttribute('role') === 'grid')!;
    const button = (label: RegExp) => all().find((e) => e.tagName === 'BUTTON' && label.test(e.textContent));
    return { spies, render, all, rows, grid, button };
  }

  it('right-click on a row opens the item menu for it; Shift+F10 on the grid for the selected row', () => {
    const t = mountView();
    fire(t.rows()[2]!, 'contextmenu', { clientX: 40, clientY: 60 });
    expect(t.spies.onSelect).toHaveBeenCalledWith(ROWS[2]!.key);
    expect(t.spies.onMenu).toHaveBeenCalledWith(ROWS[2], { x: 40, y: 60 });
    t.render({ selectedKey: ROWS[1]!.key });
    fire(t.grid(), 'keydown', { key: 'F10', shiftKey: true });
    expect(t.spies.onMenu).toHaveBeenCalledTimes(2);
    expect(t.spies.onMenu.mock.calls[1]![0]).toBe(ROWS[1]);
    // Its own contextmenu echo on the grid is the same request.
    fire(t.grid(), 'contextmenu', { clientX: 0, clientY: 0 });
    expect(t.spies.onMenu).toHaveBeenCalledTimes(2);
    fire(t.rows()[0]!, 'click');
    expect(t.spies.onOpen).toHaveBeenCalledWith(ROWS[0]);
  });

  it('chips, the sort picker, the column headers and the search change the view', () => {
    const t = mountView();
    fire(t.button(/^Gone/)!, 'click');
    expect(t.spies.onView).toHaveBeenLastCalledWith({ filter: 'gone' });
    fire(t.button(/^scrap\.tf price/)!, 'click');
    expect(t.spies.onView).toHaveBeenLastCalledWith({ sort: 'cost', dir: 'asc' });
    fire(t.button(/^Verdict/)!, 'click');
    // Already sorted by profit: the direction flips.
    expect(t.spies.onView).toHaveBeenLastCalledWith({ sort: 'profit', dir: 'asc' });
    // The sort picker lists every order (the shim cannot drive a <select>'s change).
    const options = t.all().filter((e) => e.tagName === 'OPTION').map((e) => e.getAttribute('value'));
    expect(options).toEqual(['profit', 'margin', 'cost', 'name', 'payUpTo', 'listed', 'sinceListed']);
    // F20's columns sort at their own default direction: longest listed, then the biggest drop, first.
    fire(t.button(/^Listed$/)!, 'click');
    expect(t.spies.onView).toHaveBeenLastCalledWith({ sort: 'listed', dir: 'desc' });
    fire(t.button(/^Since listed$/)!, 'click');
    expect(t.spies.onView).toHaveBeenLastCalledWith({ sort: 'sinceListed', dir: 'asc' });
    fire(t.button(/^Listed > 24 h/)!, 'click');
    expect(t.spies.onView).toHaveBeenLastCalledWith({ filter: 'long-listed' });
    fire(t.button(/^Dropped since listed/)!, 'click');
    expect(t.spies.onView).toHaveBeenLastCalledWith({ filter: 'dropped' });
    const flip = t.all().find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Descending; switch to ascending')!;
    fire(flip, 'click');
    expect(t.spies.onView).toHaveBeenLastCalledWith({ dir: 'asc' });
    const search = t.all().find((e) => e.tagName === 'INPUT')!;
    expect(search.getAttribute('aria-label')).toBe('Search scrap.tf/buy/hats');
    expect(search.getAttribute('maxlength')).toBe('200');
  });

  it('a change chip on a first save cannot be picked', () => {
    const t = mountView({ result: { ...RESULT, previousSavedAt: null, saves: 1 } });
    const gone = t.button(/^Gone/)!;
    expect(gone.hasAttribute('disabled')).toBe(true);
    expect(t.button(/^Flips/)!.hasAttribute('disabled')).toBe(false);
  });

  it('"Load more" asks for the next page size; Open in browser and Export CSV call up', () => {
    const t = mountView({ result: { ...RESULT, total: 300 } });
    fire(t.button(/^Load 200 more$/)!, 'click');
    expect(t.spies.onLoadMore).toHaveBeenCalledWith(204);
    fire(t.button(/Open in browser/)!, 'click');
    expect(t.spies.onOpenPage).toHaveBeenCalledTimes(1);
    fire(t.button(/Export CSV/)!, 'click');
    expect(t.spies.onExport).toHaveBeenCalledTimes(1);
  });
});

describe('BankStockPage against the mock', () => {
  it('reads the bank once, shows its rows and chips, and nothing gone under All', async () => {
    const t = await mountPage('hats');
    expect(t.queries()).toEqual([{ bank: 'hats', filter: 'all', sort: 'profit', dir: 'desc', limit: 200, offset: 0 }]);
    const r = await t.b.rpc('scraptf.bankStock', { bank: 'hats', limit: 2000 });
    expect(t.rows()).toHaveLength(Math.min(r.rows.length, 26));
    expect(t.content()).toContain('Hats stock');
    expect(t.chip('All').textContent).toBe(`All${r.counts.inStock}`);
    expect(t.chip('New').textContent).toBe(`New${r.counts.new}`);
    expect(t.chip('Gone').textContent).toBe(`Gone${r.counts.gone}`);
    expect(t.content()).toContain('previous save 3 h ago');
    expect(t.content()).not.toContain('First save of this page');
  });

  it('a chip asks for its rows and is remembered for that bank only', async () => {
    const store = new Map<string, string>();
    const t = await mountPage('hats', { store });
    fire(t.chip('New'), 'click');
    await settle();
    expect(t.queries().at(-1)).toMatchObject({ bank: 'hats', filter: 'new' });
    expect(t.rows().length).toBeGreaterThan(0);
    expect(t.rows().every((e) => e.textContent.includes('New'))).toBe(true);
    expect(JSON.parse(store.get('flipdesk.ui.bankStock.view.hats')!)).toMatchObject({ filter: 'new' });
    fire(t.chip('Gone'), 'click');
    await settle();
    expect(t.queries().at(-1)).toMatchObject({ filter: 'gone' });
    expect(t.content()).toContain('Last seen');
    expect(t.content()).toContain('Last price');
    // Another bank keeps its own view.
    unmounts.pop()!();
    const w = await mountPage('weapons', { store });
    expect(w.queries()[0]).toMatchObject({ bank: 'weapons', filter: 'all' });
    expect(JSON.parse(store.get('flipdesk.ui.bankStock.view.hats')!)).toMatchObject({ filter: 'gone' });
  });

  it('F20: Listed > 24 h asks for its rows, each listed a day or more across the saves', async () => {
    const t = await mountPage('hats');
    fire(t.chip('Listed > 24 h'), 'click');
    await settle();
    expect(t.queries().at(-1)).toMatchObject({ bank: 'hats', filter: 'long-listed' });
    const r = await t.b.rpc('scraptf.bankStock', { bank: 'hats', filter: 'long-listed', limit: 2000 });
    expect(r.counts.longListed).toBe(r.total);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(t.rows()).toHaveLength(Math.min(r.rows.length, 26));
    const listed = t.rows().map((e) => e.descendants().find((d) => (d.getAttribute('class') ?? '').startsWith('bs-listed'))!.textContent);
    for (const s of listed) expect(s).toMatch(/^\d+ d \d+ h$/);
    // Sorted by Listed from the header: the longest first.
    fire(t.button(/^Listed$/)!, 'click');
    await settle();
    expect(t.queries().at(-1)).toMatchObject({ filter: 'long-listed', sort: 'listed', dir: 'desc' });
  });

  it('a row opens the drawer by its base SKU', async () => {
    const t = await mountPage('hats');
    const r = await t.b.rpc('scraptf.bankStock', { bank: 'hats' });
    fire(t.rows()[1]!, 'click');
    expect(t.probe().getAttribute('data-item')).toBe(r.rows[1]!.sku);
    expect(t.rows()[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('j, k and Enter move and open from the keyboard', async () => {
    const t = await mountPage('hats');
    const r = await t.b.rpc('scraptf.bankStock', { bank: 'hats' });
    fire(t.grid(), 'focusin');
    expect(t.rows()[0]!.getAttribute('aria-selected')).toBe('true');
    fire(t.grid(), 'keydown', { key: 'j' });
    fire(t.grid(), 'keydown', { key: 'j' });
    fire(t.grid(), 'keydown', { key: 'k' });
    expect(t.rows()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(t.grid().getAttribute('aria-activedescendant')).toBe('bsrow-1');
    fire(t.grid(), 'keydown', { key: 'Enter' });
    expect(t.probe().getAttribute('data-item')).toBe(r.rows[1]!.sku);
  });

  it('exports what the table shows through opps.exportCsv and the save dialog', async () => {
    const t = await mountPage('stranges');
    fire(t.chip('Flips'), 'click');
    await settle();
    fire(t.button(/Export CSV/)!, 'click');
    await settle();
    expect(t.calls('opps.exportCsv').map((c) => c[1])).toEqual([{ kind: 'bankStock', bankStock: { bank: 'stranges', filter: 'flips', sort: 'profit', dir: 'desc' } }]);
    expect(t.calls('file.saveText')).toHaveLength(1);
    expect((t.calls('file.saveText')[0]![1] as { suggestedName: string }).suggestedName).toMatch(/^flipdesk-bank-stock-stranges-[\d-]+\.csv$/);
    expect(t.probe().getAttribute('data-toasts')).toContain('Saved C:\\Users\\you\\Downloads\\flipdesk-bank-stock-stranges-');
  });

  it('opens only the static bank page, through links.open', async () => {
    const t = await mountPage('unusuals');
    fire(t.button(/Open in browser/)!, 'click');
    await settle();
    const opened = t.calls('links.open').map((c) => (c[1] as { url: string }).url);
    expect(opened).toEqual(['https://scrap.tf/unusuals']);
    for (const u of opened) expect(STATIC_EXTERNAL_URLS).toContain(u);
  });

  it('re-reads on scraptf.banksChanged, at most once per 2 s however many pushes arrive', async () => {
    const t = await mountPage('hats');
    expect(t.queries()).toHaveLength(1);
    // Each picked file is a new hats save; the mock pushes banksChanged once per import, unthrottled.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await t.b.rpc('import.pickFile', undefined);
      });
    }
    await settle();
    // The first push reads at once; the rest wait for one trailing read 2 s later.
    expect(t.queries()).toHaveLength(2);
    expect(t.queries()[1]).toEqual(t.queries()[0]);
  });

  it('a first save: the note, and a remembered change filter goes back to All', async () => {
    const store = new Map<string, string>([['flipdesk.ui.bankStock.view.killstreaks', JSON.stringify({ ...DEFAULT_BANK_STOCK_VIEW, filter: 'new' } satisfies BankStockView)]]);
    const t = await mountPage('killstreaks', { store });
    expect(t.queries().map((q) => q.filter)).toEqual(['new', 'all']);
    expect(t.content()).toContain('First save of this page');
    expect(t.chip('New').hasAttribute('disabled')).toBe(true);
    expect(t.chip('Flips').hasAttribute('disabled')).toBe(false);
    expect(t.rows().length).toBeGreaterThan(0);
  });

  it('never saved: the save steps; import off: the way to turn it on', async () => {
    const t = await mountPage('skins');
    expect(t.content()).toContain('No save of scrap.tf/buy/skins yet');
    expect(t.rows()).toHaveLength(0);
    unmounts.pop()!();
    const off = await mountPage('items', { importOn: false });
    expect(off.content()).toContain('Saved-page import is off');
    fire(off.button(/^Open Import$/)!, 'click');
    expect(win()['location']).toEqual({ hash: '#/import' });
  });

  it('"All scrap.tf banks" goes back to the bank\'s card', async () => {
    const t = await mountPage('stranges');
    fire(t.button(/All scrap\.tf banks/)!, 'click');
    expect(win()['location']).toEqual({ hash: '#/banks/stranges' });
  });
});
