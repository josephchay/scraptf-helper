// F19, the Live market's link to scrap.tf (renderer U1, U2). Out: each row's scrap.tf button (or o on
// the selected row) arms the Live check, copies the name and hands the item's static bank page to the
// user's browser through links.open; while the market shows one bank, a header button opens that bank
// page. Back: the price copied there comes back through the check hotkey or watcher (checkMarketLink.test.ts).
// Only SCRAPTF_BANKS pages are ever opened, never a URL from a row; Flip Desk never loads scrap.tf on its own (R1).
// The model is pure; the table and the page render with react-dom/client into domShim.ts against fakes
// and the browser mock. No network.

import { readFileSync } from 'node:fs';
import { act, createElement, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MARKET_SCRAPTF_KEY, DEFAULT_MARKET_SORT, marketBankLink, marketDisplayRows, marketRouteIntent, marketScraptfButton, marketSingleBank } from '../../src/renderer/marketModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { MarketTableProps } from '../../src/renderer/pages/MarketPage';
import { SCRAPTF_BANKS, STATIC_EXTERNAL_URLS, scraptfLinkFor } from '../../src/shared/links';
import type { Category, MarketRow } from '../../src/shared/types';
import { CATEGORIES } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const noop = () => undefined;

function row(sku: string, over: Partial<MarketRow> = {}): MarketRow {
  const category = over.category ?? 'hats';
  return {
    sku,
    name: `Item ${sku}`,
    category,
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
    lastOrderChangeAt: T0 - MIN,
    evaluatedAt: T0,
    scraptfPaysScrap: null,
    scraptfStock: null,
    scraptfStockLimit: null,
    scraptfFull: false,
    scraptfListAt: null,
    scraptfNewAt: null,
    scraptfListedSince: null,
    scraptfLink: scraptfLinkFor(category, null),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

describe("a row's scrap.tf button (U1)", () => {
  it('names the bank page a save listed it on, and how long ago', () => {
    const b = marketScraptfButton(row('378;6', { name: 'Team Captain', scraptfLink: scraptfLinkFor('hats', { bank: 'hats', at: T0 - 12 * MIN }) }), T0);
    expect(b).toMatchObject({ bank: 'hats', url: 'https://scrap.tf/buy/hats', path: 'scrap.tf/buy/hats', label: 'Hats', name: 'Team Captain', seen: true });
    expect(b.title).toBe('Seen on scrap.tf/buy/hats in your save 12 min ago. Opens it and copies the name (o). Flip Desk never loads scrap.tf on its own.');
    expect(b.ariaLabel).toBe('Hats: open scrap.tf/buy/hats in your browser and copy the name');
  });

  it("else its category's bank, which is not in the user's saves yet", () => {
    const b = marketScraptfButton(row('30001;6', { name: 'Taunt: Conga', category: 'taunts' }), T0);
    expect(b).toMatchObject({ bank: 'items', url: 'https://scrap.tf/buy/items', label: 'Items', seen: false });
    expect(b.title).toBe("scrap.tf's Items bank (not in your saves yet). Opens it and copies the name (o). Flip Desk never loads scrap.tf on its own.");
    expect(marketScraptfButton(row('1;5;u13', { category: 'unusuals' }), T0)).toMatchObject({ bank: 'unusuals', path: 'scrap.tf/unusuals', label: 'Unusuals' });
  });

  it('a bank page seen on another bank than its category wins, and only scrap.tf/items known reads as All items', () => {
    expect(marketScraptfButton(row('200;11', { category: 'stranges', scraptfLink: scraptfLinkFor('stranges', { bank: 'weapons', at: T0 - MIN }) }), T0)).toMatchObject({ bank: 'weapons', seen: true });
    const list = marketScraptfButton(row('5021;6', { category: 'other', scraptfLink: scraptfLinkFor('other', { bank: 'list', at: T0 - 3_600_000 }) }), T0);
    expect(list).toMatchObject({ bank: 'list', url: 'https://scrap.tf/items', path: 'scrap.tf/items', label: 'All items', seen: true });
    expect(list.title).toMatch(/^Seen on scrap\.tf\/items in your save 1 h ago\./);
  });

  it('F19-A11Y-LABEL-IN-NAME: the accessible name starts with the visible label for every bank, All items included', () => {
    expect(SCRAPTF_BANKS.some((b) => b.bank === 'list')).toBe(true);
    for (const bank of SCRAPTF_BANKS) {
      const b = marketScraptfButton(row('378;6', { scraptfLink: scraptfLinkFor('hats', { bank: bank.bank, at: T0 - MIN }) }), T0);
      expect(b.bank, bank.bank).toBe(bank.bank);
      expect(b.ariaLabel, bank.bank).toBe(`${b.label}: open ${b.path} in your browser and copy the name`);
      expect(b.ariaLabel.toLowerCase().startsWith(b.label.toLowerCase()), bank.bank).toBe(true);
    }
    const list = marketScraptfButton(row('5021;6', { category: 'other', scraptfLink: scraptfLinkFor('other', { bank: 'list', at: T0 - MIN }) }), T0);
    expect(list.ariaLabel).toBe('All items: open scrap.tf/items in your browser and copy the name');
  });

  it('a save dated ahead of the clock reads just now', () => {
    expect(marketScraptfButton(row('378;6', { scraptfLink: scraptfLinkFor('hats', { bank: 'hats', at: T0 + 3 * MIN }) }), T0).title).toMatch(/in your save just now\./);
  });

  it('copies the unpainted name scrap.tf searches by', () => {
    expect(marketScraptfButton(row('378;6', { name: 'Team Captain (Paint: Pink as Hell)' }), T0).name).toBe('Team Captain');
    expect(marketScraptfButton(row('378;6', { name: '  ' }), T0).name).toBe('378;6');
  });

  it("opens only SCRAPTF_BANKS pages: a row's own URL is never used, and a garbled link falls back to the category", () => {
    const evil = row('378;6', { scraptfLink: { bank: 'hats', url: 'https://evil.example/phish', seenAt: T0, source: 'seen' } });
    expect(marketScraptfButton(evil, T0).url).toBe('https://scrap.tf/buy/hats');
    const garbled = row('190;11', { category: 'weapons', scraptfLink: { bank: 'https://scrap.tf/x' as never, url: 'https://scrap.tf/x', seenAt: T0, source: 'seen' } });
    expect(marketScraptfButton(garbled, T0)).toMatchObject({ bank: 'weapons', url: 'https://scrap.tf/buy/weapons', seen: false });
    const missing = { ...row('190;11', { category: 'skins' }), scraptfLink: undefined } as unknown as MarketRow;
    expect(marketScraptfButton(missing, T0)).toMatchObject({ bank: 'skins', seen: false });
    for (const c of CATEGORIES) {
      for (const seen of [null, ...SCRAPTF_BANKS.map((b) => ({ bank: b.bank, at: T0 - MIN }))]) {
        expect(STATIC_EXTERNAL_URLS).toContain(marketScraptfButton(row('1;6', { category: c, scraptfLink: scraptfLinkFor(c, seen) }), T0).url);
      }
    }
  });
});

describe('the one-bank header button (U2)', () => {
  it('shows for a category filter that maps to exactly one bank', () => {
    expect(marketSingleBank(['hats'])?.bank).toBe('hats');
    expect(marketSingleBank(['taunts'])?.bank).toBe('items');
    expect(marketSingleBank(['taunts', 'other'])?.bank).toBe('items');
    expect(marketSingleBank(['unusuals'])?.bank).toBe('unusuals');
    expect(marketBankLink(['hats'])).toEqual({
      bank: 'hats',
      url: 'https://scrap.tf/buy/hats',
      text: 'Open scrap.tf/buy/hats',
      title: "Opens scrap.tf's Hats bank in your browser, to look for these items there. Flip Desk never loads scrap.tf on its own.",
      ariaLabel: 'Open scrap.tf/buy/hats in your browser',
    });
  });

  it("covers every bank card's See all route", () => {
    for (const b of SCRAPTF_BANKS.filter((x) => x.categories.length)) {
      const intent = marketRouteIntent(['market', 'bank', b.bank])!;
      const link = marketBankLink(intent.filters.categories)!;
      expect(link.bank).toBe(b.bank);
      expect(link.url).toBe(b.url);
      expect(STATIC_EXTERNAL_URLS).toContain(link.url);
    }
  });

  it('hides for every category, several banks, or nothing known', () => {
    expect(marketBankLink([])).toBeNull();
    expect(marketBankLink(['hats', 'weapons'])).toBeNull();
    expect(marketBankLink(['taunts', 'skins'])).toBeNull();
    expect(marketBankLink(['nonsense' as Category])).toBeNull();
    expect(marketBankLink([...CATEGORIES])).toBeNull();
  });
});

describe('wiring (static)', () => {
  const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
  const page = read('pages/MarketPage.tsx');
  const css = read('styles/market.css');

  it('names the o key in the keyboard help line', () => {
    expect(MARKET_SCRAPTF_KEY).toBe('o');
    const help = page.slice(page.indexOf('<p className="hint-line muted small">'));
    expect(help).toContain('<kbd>{MARKET_SCRAPTF_KEY}</kbd> to open it on scrap.tf (copies the name)');
  });

  it('keeps the button inline in the Item cell: never shrinking, at the right edge, an icon from the 1400px layout down', () => {
    const rule = css.slice(css.indexOf('.m-stf {'), css.indexOf('}', css.indexOf('.m-stf {')));
    expect(rule).toContain('flex-shrink: 0;');
    expect(rule).toContain('margin-left: auto;');
    const block = (px: number) => {
      const at = css.indexOf(`@container (max-width: ${px}px)`);
      return css.slice(at, css.indexOf('\n}', at));
    };
    expect(block(1400)).toMatch(/\.market-scroll \.market-row:not\(\.selected\) \.m-stf-label \{\s*display: none;/);
    expect(block(950)).toMatch(/\.market-scroll \.m-stf-label \{\s*display: none;/);
  });
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let MarketTable: typeof import('../../src/renderer/pages/MarketPage').MarketTable;
let MarketPage: () => ReactNode;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ToastStack: () => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;
const cls = (e: ShimElement) => e.getAttribute('class') ?? '';

beforeAll(async () => {
  doc = installDomShim();
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
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  win()['location'] = { hash: '' };
  ({ createRoot } = await import('react-dom/client'));
  ({ MarketTable, MarketPage } = await import('../../src/renderer/pages/MarketPage'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ ToastStack } = await import('../../src/renderer/components/Feedback'));
});

const unmounts: (() => void)[] = [];
let bridge: MockBridge | null = null;
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  delete win()['history'];
  delete win()['dispatchEvent'];
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // no storage in this process
  }
});

const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
  act(() => {
    target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true, ...init }));
  });

function mountTable(rows: MarketRow[], withLink = true) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const calls = { open: [] as string[], scraptf: [] as string[], select: [] as (string | null)[] };
  function Harness(): ReactElement {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const display = useMemo(() => marketDisplayRows(rows, rows.length), []);
    const props: MarketTableProps = {
      rows: display,
      dataKey: 'q',
      keyScrap: 568,
      now: T0,
      density: 'comfortable',
      selectedId,
      flash: { seq: 0, dirs: new Map() },
      sort: { ...DEFAULT_MARKET_SORT },
      loadingMore: false,
      frozen: false,
      onSelect: (id) => {
        calls.select.push(id);
        setSelectedId(id);
      },
      onOpen: (r) => calls.open.push(r.sku),
      onMenu: noop,
      onLoadMore: noop,
      onSort: noop,
      ...(withLink ? { onScraptf: (r: MarketRow) => calls.scraptf.push(r.sku) } : {}),
    };
    return createElement(MarketTable, props);
  }
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(Harness)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const grid = container.descendants().find((e) => e.getAttribute('role') === 'grid')!;
  const buttons = () => container.descendants().filter((e) => e.tagName === 'BUTTON' && cls(e).split(' ').includes('m-stf'));
  return { container, grid, calls, buttons, key: (key: string, init: Record<string, unknown> = {}) => fire(grid, 'keydown', { key, ...init }) };
}

describe('MarketTable with the scrap.tf button', () => {
  const rows = [
    row('378;6', { name: 'Team Captain', scraptfLink: scraptfLinkFor('hats', { bank: 'hats', at: T0 - 12 * MIN }) }),
    row('30001;6', { name: 'Taunt: Conga', category: 'taunts' }),
  ];

  it('puts a real, labelled button with the bank label in the Item cell, out of the Tab order', () => {
    const t = mountTable(rows);
    const [first, second] = t.buttons();
    expect(t.buttons()).toHaveLength(2);
    expect(first!.getAttribute('type')).toBe('button');
    expect(first!.getAttribute('aria-label')).toBe('Hats: open scrap.tf/buy/hats in your browser and copy the name');
    expect(first!.getAttribute('title')).toMatch(/^Seen on scrap\.tf\/buy\/hats in your save 12 min ago\./);
    expect(first!.getAttribute('tabindex')).toBe('-1');
    expect(first!.textContent).toBe('Hats');
    expect(cls(first!)).toContain('seen');
    expect(second!.textContent).toBe('Items');
    expect(cls(second!)).not.toContain('seen');
    // In the Item cell, not a cell of its own.
    const cell = first!.parentNode as ShimElement;
    expect(cell.getAttribute('role')).toBe('gridcell');
    expect(cls(cell)).toBe('m-item');
    expect(t.grid.getAttribute('aria-label')).toContain('o to open the item on scrap.tf and copy its name');
  });

  it('a click runs the link for that row and selects it, without the row click that opens the drawer', () => {
    const t = mountTable(rows);
    fire(t.buttons()[1]!, 'click');
    expect(t.calls.scraptf).toEqual(['30001;6']);
    expect(t.calls.select).toEqual(['30001;6']);
    expect(t.calls.open).toEqual([]);
    // The rest of the row still opens the drawer.
    fire(t.buttons()[1]!.parentNode as ShimElement, 'click');
    expect(t.calls.open).toEqual(['30001;6']);
    expect(t.calls.scraptf).toEqual(['30001;6']);
  });

  it('o on the selected row runs it once per press: no repeat, no modifier, nothing without a row', () => {
    const t = mountTable(rows);
    t.key(MARKET_SCRAPTF_KEY);
    expect(t.calls.scraptf).toEqual([]);
    fire(t.grid, 'focusin');
    t.key('j');
    t.key('o');
    expect(t.calls.scraptf).toEqual(['30001;6']);
    t.key('o', { repeat: true });
    t.key('o', { ctrlKey: true });
    t.key('o', { altKey: true });
    expect(t.calls.scraptf).toEqual(['30001;6']);
    t.key('k');
    t.key('o');
    expect(t.calls.scraptf).toEqual(['30001;6', '378;6']);
    expect(t.calls.open).toEqual([]);
  });

  it('without a handler there is no button and o does nothing (the props stay optional)', () => {
    const t = mountTable(rows, false);
    expect(t.buttons()).toHaveLength(0);
    fire(t.grid, 'focusin');
    t.key('o');
    expect(t.calls.scraptf).toEqual([]);
    expect(t.grid.getAttribute('aria-label')).toBe('Live market. Use j and k or the arrow keys to move, Enter to open, Shift+F10 for item actions.');
  });
});

// ---------------------------------------------------------------------------
// The page, against the browser mock
// ---------------------------------------------------------------------------

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountPage(hash: string) {
  const location = { hash };
  win()['location'] = location;
  win()['history'] = { state: null, replaceState: (_s: unknown, _t: string, url: string) => (location.hash = url) };
  win()['dispatchEvent'] = noop;
  const copies: string[] = [];
  vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => void copies.push(text) } });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const probe = { itemSku: null as string | null };
  function Probe() {
    probe.itemSku = useApp().itemSku;
    return null;
  }
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(MarketPage), createElement(ToastStack), createElement(Probe))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const all = () => container.descendants();
  const callsOf = (m: string) => rpc.mock.calls.filter((c) => c[0] === m).map((c) => c[1]);
  return { all, rpc, callsOf, copies, probe, container };
}

describe('the Live market page (mock)', () => {
  it("a row's button arms main with the row's SKU and the copied name, copies it, then opens the static bank page", async () => {
    const t = await mountPage('#/market');
    const btn = t.all().find((e) => e.tagName === 'BUTTON' && cls(e).split(' ').includes('m-stf'))!;
    expect(btn).toBeDefined();
    let r: ShimElement = btn;
    while (r.getAttribute('role') !== 'row') r = r.parentNode as ShimElement;
    const nameEl = r.descendants().find((e) => cls(e).split(' ').includes('item-name'))!;
    const sku = /SKU (\S+)$/.exec(nameEl.getAttribute('title') ?? '')![1]!;
    const label = btn.textContent;
    const bank = SCRAPTF_BANKS.find((x) => x.label === label)!;
    expect(bank).toBeDefined();

    t.rpc.mockClear();
    fire(btn, 'click');
    await settle();
    const order = t.rpc.mock.calls.map((c) => c[0]).filter((m) => m === 'check.arm' || m === 'links.open');
    expect(order).toEqual(['check.arm', 'links.open']);
    const arm = t.callsOf('check.arm')[0] as { sku: string; name: string };
    expect(arm.sku).toBe(sku);
    expect(t.copies).toEqual([arm.name]);
    expect(nameEl.textContent.startsWith(arm.name)).toBe(true);
    expect(t.callsOf('links.open')).toEqual([{ url: bank.url, allowWindow: true }]);
    expect(STATIC_EXTERNAL_URLS).toContain(bank.url);
    // Not the row's click: no drawer.
    expect(t.probe.itemSku).toBeNull();
    // The mock refuses links (browser preview); the toast still says how the price comes back.
    const toast = t.all().find((e) => cls(e).includes('toast') && e.textContent.includes('Copy the price there'));
    expect(toast?.textContent).toContain('Copy the price there and press Ctrl+Alt+C to check it here.');
    // Nothing else left the page: no request but these, and no service call with the name.
    expect([...new Set(t.rpc.mock.calls.map((c) => c[0]))].sort()).toEqual(['app.hotkeys', 'check.arm', 'links.open']);
  });

  it('a bank route shows "Open scrap.tf/buy/<bank> ↗", which opens that static page', async () => {
    const t = await mountPage('#/market/bank/items');
    const head = t.all().find((e) => e.tagName === 'BUTTON' && cls(e).includes('market-bank-link'))!;
    expect(head.textContent).toBe('Open scrap.tf/buy/items ↗');
    expect(head.getAttribute('aria-label')).toBe('Open scrap.tf/buy/items in your browser');
    t.rpc.mockClear();
    fire(head, 'click');
    await settle();
    expect(t.callsOf('links.open')).toEqual([{ url: 'https://scrap.tf/buy/items', allowWindow: true }]);
    // Nothing armed or copied but the address the preview could not open (openOrCopy).
    expect(t.callsOf('check.arm')).toEqual([]);
    expect(t.copies).toEqual(['https://scrap.tf/buy/items']);
  });

  it('the whole market (no category filter) has no header button', async () => {
    const t = await mountPage('#/market');
    expect(t.all().some((e) => e.tagName === 'BUTTON' && cls(e).includes('market-bank-link'))).toBe(false);
    expect(t.all().some((e) => cls(e).split(' ').includes('m-stf'))).toBe(true);
  });
});
