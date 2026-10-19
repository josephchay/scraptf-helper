// 0.7.1 on the bank stock page (#/banks/<bank>/stock). UX-5 / F21-9 (1): with the opt-in scrap.tf window
// on, "Open in Flip Desk window" sits by Open (which then follows openLinksInWindow, allowWindow), on the
// header and the never-saved state, and only a click calls 'scraptfWindow.open', with the bank's static
// page. DM-5: an old sighting reads "last seen N ago", and pages left out of the counts are named.
// ACT-11: Record buy books the row's exact copy at the price its save listed. The helpers are checked as
// data, the view rendered server-side, then the page mounted with react-dom/client into the minimal DOM
// in domShim.ts against the browser mock. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BANK_STOCK_LAST_SEEN_STALE_MS,
  DEFAULT_BANK_STOCK_VIEW,
  RETENTION_NOTE,
  bankStockBuyCopy,
  bankStockHeader,
  bankStockListedCell,
  bankStockOlderPages,
  bankStockPaintOf,
} from '../../src/renderer/bankStockModel';
import { recordBuyInit, recordTradeInit } from '../../src/renderer/itemMenuModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { BankStockPageViewProps } from '../../src/renderer/pages/BankStockPage';
import { emptyBankStockCounts } from '../../src/shared/bankStock';
import type { BankStockResult, BankStockRow, ScraptfListStatus } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const noop = () => undefined;
const PAINT = 15185211;

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
    previousStock: 3,
    revenueScrap: 45,
    revenueOrder: null,
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

describe('Listed, and an old sighting (DM-5)', () => {
  it('measures the run to its newest sighting, and says "last seen" once that is over 48 h old', () => {
    expect(BANK_STOCK_LAST_SEEN_STALE_MS).toBe(48 * HOUR);
    // Absent (an older service): to now, as before.
    expect(bankStockListedCell(row({ listedSince: T0 - 2 * DAY }), T0)).toMatchObject({ text: '2 d 0 h', muted: false, long: true });
    // A fresh sighting: the span the saves covered.
    const fresh = bankStockListedCell(row({ listedSince: T0 - 30 * HOUR, lastSeenAt: T0 - 5 * MIN }), T0);
    expect(fresh.muted).toBe(false);
    expect(fresh.long).toBe(true);
    // One save 4 days ago: listed for 0 there, and it reads as the old sighting it is.
    const old = bankStockListedCell(row({ listedSince: T0 - 4 * DAY, lastSeenAt: T0 - 4 * DAY }), T0);
    expect(old.text).toMatch(/^last seen \d+ d ago$/);
    expect(old.muted).toBe(true);
    expect(old.long).toBe(false);
    expect(old.title).toContain('No newer save of its page shows it');
    // One save has no span to name ("after 0 m on sale" says nothing); a longer run names it.
    expect(old.title).not.toContain('after');
    expect(bankStockListedCell(row({ listedSince: T0 - 10 * DAY, lastSeenAt: T0 - 4 * DAY }), T0).title).toContain('after 6 d 0 h on sale in your saves since');
    // A sighting a little ahead of the clock is now.
    expect(bankStockListedCell(row({ listedSince: T0 - HOUR, lastSeenAt: T0 + MIN }), T0).text).not.toMatch(/last seen/);
  });

  it('names the pages left out of the counts, or nothing', () => {
    expect(bankStockOlderPages(null, T0)).toBeNull();
    expect(bankStockOlderPages({ olderPages: null }, T0)).toBeNull();
    expect(bankStockOlderPages({}, T0)).toBeNull();
    expect(bankStockOlderPages({ olderPages: { count: 0, newestSavedAt: T0 } }, T0)).toBeNull();
    const two = bankStockOlderPages({ olderPages: { count: 2, newestSavedAt: T0 - 3 * DAY } }, T0)!;
    expect(two.text).toBe('2 older pages (last saved 3 d ago)');
    expect(two.title).toContain('left out of the counts, the chips and What\'s new');
    expect(bankStockOlderPages({ olderPages: { count: 1, newestSavedAt: T0 - 3 * DAY } }, T0)!.text).toBe('1 older page (last saved 3 d ago)');
  });

  it("keeps B's retention tiers word for word", () => {
    expect(RETENTION_NOTE).toContain('every save from the last 2 hours, then one every 10 minutes for the rest of the day, then one an hour for a week, then one a day');
  });
});

describe('Record buy books the exact copy (ACT-11)', () => {
  it('a painted row: the painted SKU, the price as listed, and where it came from', () => {
    const painted = row({ sku: '378;6', key: `378;6|${JSON.stringify([PAINT, [], [], null, null, false, false])}`, hasExtras: true, costKeys: 1, costScrapRaw: 48, costScrap: 616 });
    expect(bankStockPaintOf(painted.key)).toBe(PAINT);
    const copy = bankStockBuyCopy(painted, 'hats');
    expect(copy).toEqual({ sku: `378;6;p${PAINT}`, keys: 1, scrap: 48, note: 'from your save of scrap.tf/buy/hats (Paint: Australium Gold)' });
    // The menu's prefill books it so, whatever the price sheet says about the plain copy.
    const init = recordTradeInit('buy', { sku: '378;6', name: 'Team Captain', copy }, { name: 'Team Captain', scrapPrices: [], revenue: null, buyOrders: [] }, { useOrder: 'conservative' } as never, T0);
    expect(init).toEqual({ side: 'buy', sku: `378;6;p${PAINT}`, name: 'Team Captain', venue: 'scrap.tf', keys: 1, scrap: 48, note: 'from your save of scrap.tf/buy/hats (Paint: Australium Gold)' });
  });

  it('a clean row: its own SKU and price; spells and parts are named in the note', () => {
    expect(bankStockBuyCopy(row(), 'hats')).toEqual({ sku: '378;6', keys: 0, scrap: 27, note: 'from your save of scrap.tf/buy/hats' });
    const spelled = row({ key: `378;6|${JSON.stringify([null, ['Exorcism'], [], null, null, false, false])}`, hasExtras: true });
    expect(bankStockBuyCopy(spelled, 'stranges')).toMatchObject({ sku: '378;6', note: 'from your save of scrap.tf/buy/stranges (Spell: Exorcism)' });
  });

  it('a gone row prefills no price and names its last one', () => {
    const gone = bankStockBuyCopy(row({ change: 'gone', stock: null, costScrapRaw: 12 }), 'hats');
    expect(gone).toEqual({ sku: '378;6', note: 'last price 1.33 ref in your save of scrap.tf/buy/hats, gone from your newest save' });
    expect(recordBuyInit({ sku: '378;6', name: 'Team Captain' }, [], gone)).toEqual({ side: 'buy', sku: '378;6', name: 'Team Captain', venue: 'scrap.tf', note: gone.note });
  });

  it('without a copy, Record buy reads the price sheet as before', () => {
    expect(recordBuyInit({ sku: '378;6', name: 'Team Captain' }, [])).toEqual({ side: 'buy', sku: '378;6', name: 'Team Captain', venue: 'scrap.tf' });
  });
});

describe('the header follows openLinksInWindow (F21-9)', () => {
  it('words Open for the window when main sends the links there', () => {
    expect(bankStockHeader('hats', null, T0)!.openTitle).toMatch(/^Opens scrap\.tf\/buy\/hats in your own browser\. Flip Desk never loads scrap\.tf on its own\. /);
    expect(bankStockHeader('hats', null, T0, true)!.openTitle).toBe('Opens scrap.tf/buy/hats in the Flip Desk window, where you browse it yourself.');
  });
});

// ---------------------------------------------------------------------------
// Rendered
// ---------------------------------------------------------------------------

const RESULT: BankStockResult = {
  bank: 'hats',
  label: 'Hats',
  url: 'https://scrap.tf/buy/hats',
  savedAt: T0 - 12 * MIN,
  previousSavedAt: T0 - 3 * HOUR,
  saves: 2,
  counts: { ...emptyBankStockCounts(), items: 2, inStock: 2, flips: 1 },
  rows: [row({ listedSince: T0 - 4 * DAY, lastSeenAt: T0 - 4 * DAY })],
  total: 1,
  keyPrice: null,
  generatedAt: T0,
  olderPages: { count: 2, newestSavedAt: T0 - 3 * DAY },
};
const NEVER: BankStockResult = { ...RESULT, savedAt: null, previousSavedAt: null, saves: 0, counts: emptyBankStockCounts(), rows: [], total: 0, olderPages: null };
const STATUS: ScraptfListStatus = { items: 2341, newestAt: T0 - 3 * MIN, oldestAt: T0 - 3 * MIN, pages: 1, importEnabled: true, watchFolder: null, watchActive: false, watchError: null };

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
let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/banks/hats/stock' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  if (!Object.getOwnPropertyDescriptor(ShimElement.prototype, 'options')) {
    Object.defineProperty(ShimElement.prototype, 'options', {
      configurable: true,
      get(this: ShimElement) {
        return this.tagName === 'SELECT' ? this.descendants().filter((e) => e.tagName === 'OPTION') : undefined;
      },
    });
  }
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ BankStockPageView, BankStockPage } = await import('../../src/renderer/pages/BankStockPage'));
});

const html = (over: Partial<BankStockPageViewProps> = {}) => renderToString(createElement(AppProvider, null, createElement(BankStockPageView, props(over)))).replace(/<!-- -->/g, '');
const WINDOW = { linksHere: false, readOnLoad: true };

describe('BankStockPageView with the window', () => {
  it('without the window: Open in browser only, the save steps, and a folder still to choose', () => {
    const h = html();
    expect(h).toContain('aria-label="Open in browser: scrap.tf/buy/hats"');
    expect(h).not.toContain('Open in Flip Desk window');
    expect(h).toContain('No watch folder yet.');
  });

  it('with it: the window button by Open, its tip, the window-true boundary and an optional folder', () => {
    const h = html({ scraptfWindow: WINDOW });
    expect(h).toContain('aria-label="Open in Flip Desk window: scrap.tf/buy/hats"');
    expect(h).toContain('aria-label="Open in browser: scrap.tf/buy/hats"');
    expect(h).toContain('In the Flip Desk window it is read as it loads; or save it with');
    expect(h).toContain('You open it, in your browser or the Flip Desk window, and you choose when.');
    expect(h).toContain('No watch folder: optional while you read pages in the Flip Desk window.');
    expect(h).not.toContain('No watch folder yet.');
    expect(html({ scraptfWindow: { ...WINDOW, readOnLoad: false } })).toContain('In the Flip Desk window it is read when you press Read page now');
  });

  it("drops Open in browser when Flip Desk's links open in the window anyway", () => {
    const h = html({ scraptfWindow: { ...WINDOW, linksHere: true } });
    expect(h).toContain('aria-label="Open in Flip Desk window: scrap.tf/buy/hats"');
    expect(h).not.toContain('aria-label="Open in browser');
  });

  it('never saved: the window first, the browser and Ctrl+S after', () => {
    const h = html({ result: NEVER, scraptfWindow: WINDOW });
    expect(h).toContain('No save of scrap.tf/buy/hats yet');
    expect(h).toContain('Open scrap.tf/buy/hats in the Flip Desk window and browse it yourself. It is read as it loads, and every item on it shows up here.');
    expect(h).toContain('Or open it in your own browser, press <kbd>Ctrl</kbd>+<kbd>S</kbd>');
    expect(h.match(/aria-label="Open in Flip Desk window: scrap\.tf\/buy\/hats"/g)).toHaveLength(2);
  });

  it('names pages left out, and an old sighting as one', () => {
    const h = html();
    expect(h).toContain('2 older pages (last saved 3 d ago)');
    expect(h).toMatch(/class="bs-listed num muted"[^>]*>last seen \d+ d ago</);
    // An answer without the fields reads as before.
    const before = html({ result: { ...RESULT, olderPages: undefined, rows: [row({ listedSince: T0 - 2 * DAY })] } });
    expect(before).not.toContain('older page');
    expect(before).not.toContain('last seen');
  });
});

// ---------------------------------------------------------------------------
// Mounted against the mock
// ---------------------------------------------------------------------------

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountPage(opts: { linksHere?: boolean } = {}) {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash: '#/banks/hats/stock' };
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  await b.rpc('settings.set', {
    import: { enabled: true, acknowledgedAt: T0, watchFolder: 'D:\\saves' },
    scraptfWindow: { enabled: true, acknowledgedAt: T0, openLinksInWindow: opts.linksHere === true },
  });
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(BankStockPage, { bank: 'hats' }))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const calls = (method: string) => rpc.mock.calls.filter((c) => c[0] === method);
  const button = (label: RegExp) => container.descendants().find((e) => e.tagName === 'BUTTON' && label.test(e.getAttribute('aria-label') ?? e.textContent));
  const fire = (target: ShimElement) =>
    act(() => {
      target.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
  return { b, calls, button, fire };
}

describe('the page with the window on, against the mock', () => {
  it("opens the window on the bank's static page from a click only", async () => {
    const t = await mountPage();
    // Mounting, reading and refreshing call nothing of the window.
    expect(t.calls('scraptfWindow.open')).toEqual([]);
    t.fire(t.button(/^Open in Flip Desk window: scrap\.tf\/buy\/hats$/)!);
    await settle();
    expect(t.calls('scraptfWindow.open').map((c) => c[1])).toEqual([{ start: 'https://scrap.tf/buy/hats' }]);
    expect(t.calls('links.open')).toEqual([]);
  });

  it('Open asks links.open with allowWindow, so main follows openLinksInWindow', async () => {
    const t = await mountPage();
    t.fire(t.button(/^Open in browser: scrap\.tf\/buy\/hats$/)!);
    await settle();
    expect(t.calls('links.open').map((c) => c[1])).toEqual([{ url: 'https://scrap.tf/buy/hats', allowWindow: true }]);
    expect(t.calls('scraptfWindow.open')).toEqual([]);
  });

  it('with the links in the window, only the window button is there', async () => {
    const t = await mountPage({ linksHere: true });
    expect(t.button(/^Open in browser/)).toBeUndefined();
    expect(t.button(/^Open in Flip Desk window/)).toBeDefined();
  });
});
