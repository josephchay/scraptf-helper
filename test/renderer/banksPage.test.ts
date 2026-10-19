// F15 "scrap.tf banks" page: the wiring checked statically (nav entry right after Live market,
// route, title, icon; the only app methods it calls; the only addresses it opens; the throttled,
// visible-only refresh; the stylesheet's tokens), every card rendered server-side, then the page
// mounted with react-dom/client into the minimal DOM in domShim.ts with the browser mock as the app
// bridge: the cards, Open in browser, the keyboard, a row opening the drawer and its menu, "See
// all" and the banksChanged push. Nothing leaves the process, and nothing here contacts scrap.tf.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BanksViewProps } from '../../src/renderer/pages/BanksPage';
import { BANK_SAVE_TIP, LIST_SAVE_TIP } from '../../src/renderer/banksModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { LIST_BOUNDARY_NOTE } from '../../src/renderer/scraptfListModel';
import { SCRAPTF_BANKS, SCRAPTF_ITEMS_URL, STATIC_EXTERNAL_URLS } from '../../src/shared/links';
import { MAIN_METHODS, SERVICE_METHODS } from '../../src/shared/rpc';
import type { ScraptfBank, ScraptfBankSummary, ScraptfBanksResult, ScraptfListStatus } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const noop = () => undefined;

describe('navigation', () => {
  const app = read('App.tsx');

  it('lists "scrap.tf banks" right after Live market, once', () => {
    const ids = [...app.matchAll(/\{ id: '([a-z]+)', label: '([^']+)', icon: '([A-Za-z]+)' \}/g)].map((m) => [m[1], m[2], m[3]]);
    const at = ids.findIndex(([id]) => id === 'market');
    expect(ids[at + 1]).toEqual(['banks', 'scrap.tf banks', 'banks']);
    expect(ids.filter(([id]) => id === 'banks')).toHaveLength(1);
  });

  it('routes and titles the page, with its own icon', () => {
    expect(app).toMatch(/type RouteId = [^;]*'banks'/);
    expect(app).toMatch(/banks: 'scrap\.tf banks',/);
    expect(app).toMatch(/case 'banks':\s*return <BanksPage \/>;/);
    expect(read('components/Icon.tsx')).toMatch(/\n {2}banks: \(/);
  });
});

describe('the page', () => {
  const page = read('pages/BanksPage.tsx');

  it('reads scraptf.banks (and the list card\'s status), nothing else: no new traffic', () => {
    const methods = new Set([...page.matchAll(/(?:rpc|useRpcQuery)\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
    // F21: 'scraptfWindow.open' is a click's window action (main's), not a read: still no new traffic.
    expect([...methods]).toEqual(['scraptf.banks', 'scraptfWindow.open']);
    expect(page).toContain("rpc('scraptfWindow.open', { start: info.url })");
    expect(page).toContain('const info = scraptfBankInfo(c.bank);');
    for (const m of methods) expect([...SERVICE_METHODS, ...MAIN_METHODS]).toContain(m);
    // The Import and folder hints are the price list card's own state (F14).
    expect(page).toContain('useScraptfListStatus()');
    expect(page).toContain('useWatchFolderPicker()');
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|<webview|<iframe|window\.open|location\.href/);
  });

  it("hands only the card's static page to the user's browser, through links.open (openOrCopy)", () => {
    expect([...page.matchAll(/openOrCopy\(([^,]+),/g)].map((m) => m[1])).toEqual(['c.url']);
    expect(page).not.toMatch(/rpc\('links\.open'|openLink\(/);
  });

  it('refreshes on scraptf.banksChanged, throttled and only while shown, and never shows an older answer', () => {
    expect(page).toContain("useVisiblePush('scraptf.banksChanged', refreshSoon);");
    expect(page).toContain('const refreshSoon = useThrottled(refresh, BANKS_REFRESH_MS);');
    expect(page).toContain("createBanksLoader(() => rpc('scraptf.banks'),");
    expect(page).toMatch(/return \(\) => \{\s*l\.dispose\(\);/);
  });

  it('opens the drawer from a row, the item menu (with its bank) on right-click, and the Live market from "See all"', () => {
    expect(page).toContain('onItem={openItem}');
    expect(page.match(/onContextMenu=\{\(e\) => menuAt\(e, \{ sku: r\.sku, name: r\.name, bank: c\.bank \}\)\}/g)).toHaveLength(2);
    expect(page).toContain('const path = marketBankPath(bank);');
  });
});

describe('banks.css', () => {
  const css = readFileSync(new URL('../../src/renderer/styles/banks.css', import.meta.url), 'utf8');

  it('takes every colour from the tokens, animates nothing and loads nothing', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/animation|transition/);
    expect(css).not.toMatch(/url\(|@import/);
  });

  it('wraps the cards from one column up, so a narrow window has no sideways scroll', () => {
    expect(css).toMatch(/\.banks-grid \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 300px\), 1fr\)\);/);
  });

  it('is imported after every earlier sheet (only the F16 live check, F17 bank stock, F20 history and F21 window sheets follow it)', () => {
    const index = read('styles/index.css').trim().split('\n');
    expect(index[index.length - 1]).toBe("@import './scraptf-window.css';");
    expect(index[index.length - 2]).toBe("@import './scraptf-history.css';");
    expect(index[index.length - 3]).toBe("@import './bank-stock.css';");
    expect(index[index.length - 4]).toBe("@import './check.css';");
    expect(index[index.length - 5]).toBe("@import './banks.css';");
  });
});

// ---------------------------------------------------------------------------
// Rendered server-side
// ---------------------------------------------------------------------------

const info = (bank: ScraptfBank) => SCRAPTF_BANKS.find((b) => b.bank === bank)!;
const summary = (bank: ScraptfBank, over: Partial<ScraptfBankSummary> = {}): ScraptfBankSummary => ({
  bank,
  label: info(bank).label,
  url: info(bank).url,
  lastSavedAt: null,
  pages: 0,
  items: 0,
  inStock: 0,
  flips: 0,
  flipProfitScrap: 0,
  top: [],
  unchecked: 0,
  lookFor: [],
  whatsNew: null,
  ...over,
});
const RESULT: ScraptfBanksResult = {
  banks: SCRAPTF_BANKS.map((b) =>
    b.bank === 'stranges'
      ? summary('stranges', {
          lastSavedAt: T0 - 12 * MIN,
          pages: 1,
          items: 48,
          inStock: 31,
          flips: 3,
          flipProfitScrap: 19,
          top: [{ sku: '200;11', name: 'Strange Scattergun', profitScrap: 9, costScrap: 30, revenueScrap: 45, confidenceLevel: 'high' }],
          unchecked: 12,
          lookFor: [{ sku: '35;11', name: 'Strange Kritzkrieg', maxCostScrap: 19, revenueScrap: 30 }],
        })
      : b.bank === 'list'
        ? summary('list', { lastSavedAt: T0 - 3 * MIN, pages: 3, items: 2341, inStock: 1800 })
        : summary(b.bank),
  ),
  importEnabled: true,
  watchActive: true,
  generatedAt: T0,
};
const STATUS: ScraptfListStatus = { items: 2341, newestAt: T0 - 3 * MIN, oldestAt: T0 - 26 * 60 * MIN, pages: 3, importEnabled: true, watchFolder: 'D:\\saves', watchActive: true, watchError: null };

function props(over: Partial<BanksViewProps> = {}): BanksViewProps {
  return {
    result: RESULT,
    error: null,
    status: STATUS,
    now: T0,
    keyScrap: 568,
    picking: false,
    focusBank: null,
    onRetry: noop,
    onPickFolder: noop,
    onGoImport: noop,
    onCopyPath: noop,
    onOpenBank: noop,
    onImportOff: noop,
    onItem: noop,
    onItemMenu: noop,
    onSeeAll: noop,
    onViewStock: noop,
    ...over,
  };
}

let BanksView: typeof import('../../src/renderer/pages/BanksPage').BanksView;
let BanksPage: typeof import('../../src/renderer/pages/BanksPage').BanksPage;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom/client loads: it checks for a DOM once, at import.
  doc = installDomShim();
  win()['location'] = { hash: '#/banks' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= (await import('./domShim')).ShimElement;
  g['Element'] ??= (await import('./domShim')).ShimElement;
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ BanksView, BanksPage } = await import('../../src/renderer/pages/BanksPage'));
});

const html = (over: Partial<BanksViewProps> = {}) => renderToString(createElement(AppProvider, null, createElement(BanksView, props(over)))).replace(/<!-- -->/g, '');

describe('BanksView, rendered', () => {
  it('heads the page with "N of 8 saved in the last hour", the folder and the boundary', () => {
    const h = html();
    expect(h).toMatch(/<h2 id="banks-headline"[^>]*>.*2 of 8 scrap\.tf pages saved in the last hour<\/h2>/);
    expect(h).toContain('Save into');
    expect(h).toContain('D:\\saves');
    expect(h).toContain('Copy path');
    expect(h).toContain(LIST_BOUNDARY_NOTE);
    // Nothing to fix: no setup note.
    expect(h).not.toContain('sl-note');
  });

  it('one card per page, labelled by its heading, with the freshness, the saved line and the save tip', () => {
    const h = html();
    expect(h.match(/<section class="card bank-card /g)).toHaveLength(8);
    for (const b of SCRAPTF_BANKS) expect(h).toContain(`>${b.label}</h3>`);
    expect(h).toMatch(/<section class="card bank-card tone-good" data-bank="stranges" tabindex="-1" aria-labelledby="[^"]+" aria-describedby="[^"]+">/);
    expect(h).toContain('saved 12 min ago · 48 items (31 in stock)');
    expect(h).toMatch(/class="pill bank-fresh tone-good"[^>]*><span class="status-dot" aria-hidden="true"><\/span>Fresh</);
    expect(h.match(/>Never saved</g)).toHaveLength(6);
    expect(h.match(/<\/svg> Open in browser<\/button>/g)).toHaveLength(8);
    // Eight alike buttons: each name starts with the visible text and says which page.
    for (const b of SCRAPTF_BANKS) expect(h).toContain(`aria-label="Open in browser: ${b.url.replace('https://', '')}"`);
    expect(h).toContain('aria-label="See all 12 not checked: Stranges"');
    // F18: each card names the save type; the header says the alternative and why, once.
    expect(h.match(/Save it with <kbd>Ctrl<\/kbd>\+<kbd>S<\/kbd> as <strong>Webpage, Complete<\/strong> into your watch folder; it updates here within seconds\./g)).toHaveLength(8);
    expect(h.match(/after the page loaded are included<\/span>/g)).toHaveLength(1);
    expect(h).toContain(`<span class="bank-tip muted small" title="${BANK_SAVE_TIP.replace(/'/g, '&#x27;')}">`);
    // The All items card (scrap.tf/items) names no Single File alternative: one .mhtml of the list is too big.
    expect(h.match(/<span class="bank-tip muted small" title="[^"]*Single File \(\.mhtml\)/g)).toHaveLength(7);
    const listCard = h.slice(h.indexOf('data-bank="list"'));
    expect(listCard).toContain(`<span class="bank-tip muted small" title="${LIST_SAVE_TIP.replace(/'/g, '&#x27;')}">`);
    expect(LIST_SAVE_TIP).not.toContain('(.mhtml)');
    expect(h).toContain(
      'In the save dialog, <span class="save-mode" title="&#x27;Webpage, HTML only&#x27; still imports, but it keeps the page as it first loaded and can miss those cards.">choose <strong>Webpage, Complete</strong> (or <strong>Webpage, Single File (.mhtml)</strong>) so cards scrap.tf added after the page loaded are included</span>. ' +
        'For scrap.tf/items, choose &#x27;Webpage, Complete&#x27; only: with an image per item, a Single File save of it is too large to import.</span>',
    );
    // The first card is the grid's one tab stop.
    expect(h).toMatch(/data-bank="hats" tabindex="0"/);
    expect(h).toContain('role="group" aria-label="Your scrap.tf pages. Arrow keys move between them, Enter opens one in your browser."');
  });

  it('shows flips with their profit and top rows, and what to look for with "See all"', () => {
    const h = html();
    expect(h).toMatch(/<h4 id="[^"]+" class="bank-block-title"[^>]*>Flips from this page: 3<span class="money pos"> \(\+2\.11 ref\)<\/span><\/h4>/);
    expect(h).toContain('Strange Scattergun');
    expect(h).toContain('+1.00 ref');
    expect(h).toContain('What to look for');
    expect(h).toContain('Strange Kritzkrieg');
    expect(h).toContain('up to 2.11 ref');
    expect(h).toContain('See all 12 not checked');
    // The list card: the F14 status, its flips, and nothing to look for.
    const list = h.slice(h.indexOf('data-bank="list"'));
    expect(list).toContain('saved 3 min ago · 2,341 items (1,800 in stock)');
    expect(list).toContain('From 3 saved pages, the oldest 1 d ago.');
    expect(list).toContain('Flips from your price list: 0');
    expect(list).not.toContain('What to look for');
  });

  it('import off: says so with the way to turn it on, and the Open buttons wait for it', () => {
    const h = html({ status: { ...STATUS, importEnabled: false } });
    expect(h).toContain('Saved-page import is off, so the scrap.tf pages you save are not read.');
    expect(h).toContain('Turn on Import first');
    expect(h.match(/<button type="button" class="btn small[^"]*" disabled=""[^>]*>.*?Open in browser/g)).toHaveLength(8);
    expect(h).not.toContain('Save into');
    // Before the list status is read, the banks answer decides, and the header says why.
    const early = html({ status: null, result: { ...RESULT, importEnabled: false } });
    expect(early.match(/disabled=""/g)!.length).toBeGreaterThanOrEqual(8);
    expect(early).toContain('Saved-page import is off, so the scrap.tf pages you save are not read.');
    expect(html({ status: null })).not.toContain('sl-note');
  });

  it('no folder or a watch error: offers the folder dialog', () => {
    expect(html({ status: { ...STATUS, watchFolder: null, watchActive: false } })).toContain('No watch folder yet. Choose one, then save the scrap.tf pages into it.');
    expect(html({ status: { ...STATUS, watchActive: false, watchError: 'Folder not found' } })).toContain('Watch error: Folder not found.');
  });

  it('loading, then a failed read with Retry that keeps the last cards', () => {
    expect(html({ result: null })).toContain('Reading your saved scrap.tf pages…');
    expect(html({ result: null })).toContain('… of 8 scrap.tf pages saved in the last hour');
    const failed = html({ error: 'The background service is restarting.' });
    expect(failed).toContain('Could not read your scrap.tf pages: The background service is restarting.');
    expect(failed.match(/<section class="card bank-card /g)).toHaveLength(8);
    expect(html({ result: null, error: 'x' })).not.toContain('Reading your saved');
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
  win()['location'] = { hash: '#/banks' };
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

async function mountPage(opts: { importOn?: boolean; hash?: string } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  win()['location'] = { hash: opts.hash ?? '#/banks' };
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  if (opts.importOn !== false) await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'D:\\saves' } });
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(BanksPage), createElement(Probe))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const calls = (method: string) => rpc.mock.calls.filter((c) => c[0] === method);
  const all = () => container.descendants();
  const cards = () => all().filter((e) => e.tagName === 'SECTION' && (e.getAttribute('class') ?? '').includes('bank-card'));
  const card = (bank: ScraptfBank) => cards().find((e) => e.getAttribute('data-bank') === bank)!;
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
  const button = (within: ShimElement, label: RegExp) => within.descendants().find((e) => e.tagName === 'BUTTON' && label.test(e.textContent));
  const probe = () => all().find((e) => e.tagName === 'OUTPUT')!;
  const opened = () => calls('links.open').map((c) => (c[1] as { url: string }).url);
  return { b, calls, cards, card, fire, button, probe, opened, content: () => container.textContent };
}

describe('BanksView, mounted', () => {
  function mountView(over: Partial<BanksViewProps> = {}) {
    const spies = { onItem: vi.fn(), onItemMenu: vi.fn(), onSeeAll: vi.fn(), onOpenBank: vi.fn(), onImportOff: vi.fn() };
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    act(() => root.render(createElement(AppProvider, null, createElement(BanksView, props({ ...spies, ...over })))));
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    const card = (bank: ScraptfBank) => container.descendants().find((e) => e.tagName === 'SECTION' && e.getAttribute('data-bank') === bank)!;
    const rows = (bank: ScraptfBank) => card(bank).descendants().filter((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'bank-row');
    const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
      act(() => {
        target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true, ...init }));
      });
    return { spies, card, rows, fire };
  }

  it("right-click on a flip or a look-for row opens the item menu for it, naming the card's bank", () => {
    const t = mountView();
    const [flip, look] = t.rows('stranges');
    t.fire(flip!, 'contextmenu', { clientX: 40, clientY: 60 });
    expect(t.spies.onItemMenu).toHaveBeenCalledWith({ sku: '200;11', name: 'Strange Scattergun', bank: 'stranges' }, { x: 40, y: 60 });
    // Shift+F10 reports 0,0: the menu itself places that next to the focused row.
    t.fire(look!, 'contextmenu', { clientX: 0, clientY: 0 });
    expect(t.spies.onItemMenu).toHaveBeenLastCalledWith({ sku: '35;11', name: 'Strange Kritzkrieg', bank: 'stranges' }, { x: 0, y: 0 });
    t.fire(look!, 'click');
    expect(t.spies.onItem).toHaveBeenCalledWith('35;11');
  });

  it('"See all" asks for the Live market of that bank; Enter on a card opens it, or explains while import is off', () => {
    const t = mountView();
    const seeAll = t.card('stranges').descendants().find((e) => e.tagName === 'BUTTON' && /^See all 12 not checked/.test(e.textContent))!;
    t.fire(seeAll, 'click');
    expect(t.spies.onSeeAll).toHaveBeenCalledWith('stranges');
    t.fire(t.card('stranges'), 'keydown', { key: 'Enter' });
    expect(t.spies.onOpenBank).toHaveBeenCalledTimes(1);
    expect(t.spies.onOpenBank.mock.calls[0]![0]).toMatchObject({ bank: 'stranges', url: 'https://scrap.tf/buy/stranges' });
    const off = mountView({ status: { ...STATUS, importEnabled: false } });
    off.fire(off.card('hats'), 'keydown', { key: 'Enter' });
    expect(off.spies.onOpenBank).not.toHaveBeenCalled();
    expect(off.spies.onImportOff).toHaveBeenCalledTimes(1);
  });

  it('a held Enter opens the page once, not a browser tab per key repeat', () => {
    const t = mountView();
    t.fire(t.card('hats'), 'keydown', { key: 'Enter' });
    for (let i = 0; i < 5; i++) t.fire(t.card('hats'), 'keydown', { key: 'Enter', repeat: true });
    expect(t.spies.onOpenBank).toHaveBeenCalledTimes(1);
  });

  it('lists two flips of one SKU (a plain and a spelled copy are two opportunities) as two rows', () => {
    const flip = { sku: '200;11', name: 'Strange Scattergun', costScrap: 30, revenueScrap: 45, confidenceLevel: 'high' as const };
    const twice: ScraptfBanksResult = {
      ...RESULT,
      banks: RESULT.banks.map((s) => (s.bank === 'stranges' ? { ...s, top: [{ ...flip, profitScrap: 9 }, { ...flip, profitScrap: 6 }] } : s)),
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const t = mountView({ result: twice });
      const flips = t.rows('stranges').filter((r) => r.textContent.includes('Strange Scattergun'));
      expect(flips).toHaveLength(2);
      t.fire(flips[1]!, 'click');
      expect(t.spies.onItem).toHaveBeenCalledWith('200;11');
      // React reports duplicate keys through console.error.
      expect(errors.mock.calls.filter((c) => String(c[0]).includes('same key'))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('moves up and down by a row of the wrapped grid', () => {
    const t = mountView();
    // Three columns: each card reports its row's top edge.
    SCRAPTF_BANKS.forEach((b, i) => {
      const el = t.card(b.bank) as unknown as { getBoundingClientRect(): { top: number } };
      el.getBoundingClientRect = () => ({ top: Math.floor(i / 3) * 200 });
    });
    t.fire(t.card('weapons'), 'keydown', { key: 'ArrowDown' });
    expect(doc.activeElement).toBe(t.card('skins'));
    t.fire(t.card('skins'), 'keydown', { key: 'ArrowDown' });
    expect(doc.activeElement).toBe(t.card('list'));
    t.fire(t.card('list'), 'keydown', { key: 'ArrowUp' });
    expect(doc.activeElement).toBe(t.card('skins'));
    // Nowhere to go: focus stays where it was.
    t.fire(t.card('hats'), 'keydown', { key: 'ArrowUp' });
    expect(doc.activeElement).toBe(t.card('skins'));
  });
});

describe('BanksPage against the mock', () => {
  it('shows every bank from scraptf.banks and the folder from the list status', async () => {
    const t = await mountPage();
    expect(t.calls('scraptf.banks').length).toBe(1);
    expect(t.calls('scraptf.listStatus').length).toBeGreaterThan(0);
    expect(t.cards().map((c) => c.getAttribute('data-bank'))).toEqual(SCRAPTF_BANKS.map((b) => b.bank));
    expect(t.content()).toMatch(/\d of 8 scrap\.tf pages saved in the last hour/);
    expect(t.content()).toContain('D:\\saves');
    expect(t.card('hats').textContent).toContain('saved 4 min ago · 48 items (31 in stock)');
    expect(t.card('skins').textContent).toContain('Not saved yet');
    // UX-2(b): a card's flips are its stock page's Flips chip (the mock follows the service).
    const ks = await t.b.rpc('scraptf.bankStock', { bank: 'killstreaks' });
    expect(ks.counts.flips).toBeGreaterThan(0);
    expect(t.card('killstreaks').textContent).toContain(`Flips from this page: ${ks.counts.flips} (+`);
  });

  it("opens a card's page only through links.open, by button or Enter, and only static pages", async () => {
    const t = await mountPage();
    t.fire(t.button(t.card('hats'), /Open in browser/)!, 'click');
    await settle();
    expect(t.opened()).toEqual(['https://scrap.tf/buy/hats']);
    // Keyboard: the card itself takes Enter; its buttons keep theirs.
    t.fire(t.card('unusuals'), 'focusin');
    t.fire(t.card('unusuals'), 'keydown', { key: 'Enter' });
    t.fire(t.card('list'), 'keydown', { key: 'Enter' });
    await settle();
    expect(t.opened()).toEqual(['https://scrap.tf/buy/hats', 'https://scrap.tf/unusuals', SCRAPTF_ITEMS_URL]);
    for (const u of t.opened()) expect(STATIC_EXTERNAL_URLS).toContain(u);
  });

  it('moves between cards with the arrow keys, one tab stop at a time', async () => {
    const t = await mountPage();
    const tabStops = () => t.cards().filter((c) => c.getAttribute('tabindex') === '0').map((c) => c.getAttribute('data-bank'));
    expect(tabStops()).toEqual(['hats']);
    t.fire(t.card('hats'), 'focusin');
    t.fire(t.card('hats'), 'keydown', { key: 'ArrowRight' });
    expect(doc.activeElement).toBe(t.card('weapons'));
    expect(tabStops()).toEqual(['weapons']);
    t.fire(t.card('weapons'), 'keydown', { key: 'End' });
    expect(doc.activeElement).toBe(t.card('list'));
    t.fire(t.card('list'), 'keydown', { key: 'Home' });
    expect(doc.activeElement).toBe(t.card('hats'));
    // A key aimed at a button inside the card is the button's.
    const open = t.button(t.card('hats'), /Open in browser/)!;
    t.fire(open, 'keydown', { key: 'ArrowRight' });
    expect(doc.activeElement).toBe(t.card('hats'));
    expect(tabStops()).toEqual(['hats']);
  });

  it('import off: Enter tells how to turn it on instead of opening the page', async () => {
    const t = await mountPage({ importOn: false });
    expect(t.content()).toContain('Saved-page import is off');
    expect(t.button(t.card('hats'), /Open in browser/)!.hasAttribute('disabled')).toBe(true);
    t.fire(t.card('hats'), 'keydown', { key: 'Enter' });
    await settle();
    expect(t.opened()).toEqual([]);
    expect(t.probe().getAttribute('data-toasts')).toContain('Turn on saved-page import first');
  });

  it('lands on the card a Live market chip named (#/banks/<bank>)', async () => {
    const t = await mountPage({ hash: '#/banks/unusuals' });
    expect(doc.activeElement).toBe(t.card('unusuals'));
    expect(t.card('unusuals').getAttribute('tabindex')).toBe('0');
  });

  it('opens the drawer from a flip row, and "See all" opens the Live market filtered to the bank', async () => {
    const t = await mountPage();
    const ks = await t.b.rpc('scraptf.banks', undefined);
    const top = ks.banks.find((x) => x.bank === 'killstreaks')!.top[0]!;
    const row = t.card('killstreaks').descendants().find((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '') === 'bank-row')!;
    t.fire(row, 'click');
    expect(t.probe().getAttribute('data-item')).toBe(top.sku);
    t.fire(t.button(t.card('killstreaks'), /^See all [\d,]+ not checked/)!, 'click');
    expect(win()['location']).toEqual({ hash: '#/market/bank/killstreaks' });
  });

  it('refetches on scraptf.banksChanged, at most one read per 2 s however many pushes arrive', async () => {
    const t = await mountPage();
    expect(t.calls('scraptf.banks')).toHaveLength(1);
    // The mock pushes once per change, unthrottled: a burst of imports.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await t.b.rpc('import.html', { html: '<html></html>', fileName: 'Items.html', mtimeMs: T0 - 1000 });
      });
    }
    await settle();
    // The first push reads at once; the rest wait for one trailing read 2 s later.
    expect(t.calls('scraptf.banks')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F21: the opt-in scrap.tf window on the cards
// ---------------------------------------------------------------------------

describe('F21: "Open in Flip Desk window" on the cards', () => {
  const WINDOW = { linksHere: false, readOnLoad: true };

  it('is not there while the window is off', () => {
    expect(html()).not.toContain('Flip Desk window');
    expect(html({ scraptfWindow: null })).not.toContain('Flip Desk window');
  });

  it('adds a button per card beside Open in browser, named by its page, and says the window reads it', () => {
    const h = html({ scraptfWindow: WINDOW });
    expect(h.match(/<\/svg> Open in browser<\/button>/g)).toHaveLength(8);
    expect(h.match(/<\/svg> Open in Flip Desk window<\/button>/g)).toHaveLength(8);
    for (const b of SCRAPTF_BANKS) expect(h).toContain(`aria-label="Open in Flip Desk window: ${b.url.replace('https://', '')}"`);
    expect(h.match(/In the Flip Desk window it is read as it loads; or save it with <kbd>Ctrl<\/kbd>\+<kbd>S<\/kbd> as <strong>Webpage, Complete<\/strong> into your watch folder\./g)).toHaveLength(8);
    expect(h).toContain('Enter opens one in your browser.');
    expect(html({ scraptfWindow: { ...WINDOW, readOnLoad: false } })).toContain('In the Flip Desk window it is read when you press Read page now');
  });

  it("drops Open in browser when Flip Desk's scrap.tf links open in the window (it would land there too)", () => {
    const h = html({ scraptfWindow: { ...WINDOW, linksHere: true } });
    expect(h).not.toContain('Open in browser');
    expect(h.match(/<\/svg> Open in Flip Desk window<\/button>/g)).toHaveLength(8);
    expect(h).toContain('Enter opens one in the Flip Desk window.');
  });

  it('waits for import like Open in browser', () => {
    const h = html({ scraptfWindow: WINDOW, status: { ...STATUS, importEnabled: false } });
    expect(h.match(/<button type="button" class="btn small bank-open-window[^"]*" disabled=""/g)).toHaveLength(8);
  });

  it('a click asks for that card (mounted view)', () => {
    const onOpenInWindow = vi.fn();
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    act(() => root.render(createElement(AppProvider, null, createElement(BanksView, props({ scraptfWindow: WINDOW, onOpenInWindow })))));
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    const btn = container.descendants().find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Open in Flip Desk window: scrap.tf/buy/weapons')!;
    act(() => {
      btn.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onOpenInWindow).toHaveBeenCalledTimes(1);
    expect(onOpenInWindow.mock.calls[0]![0]).toMatchObject({ bank: 'weapons', url: 'https://scrap.tf/buy/weapons' });
  });

  it("against the mock: opens the card's static page in the window on a click, nothing in the browser", async () => {
    const t = await mountPage();
    expect(t.content()).not.toContain('Open in Flip Desk window');
    await t.b.rpc('settings.set', { scraptfWindow: { enabled: true, acknowledgedAt: T0 } });
    await settle();
    // Nothing moved the window yet: the button appears, that is all.
    expect(t.calls('scraptfWindow.open')).toEqual([]);
    const btn = t.button(t.card('stranges'), /Open in Flip Desk window/)!;
    t.fire(btn, 'click');
    await settle();
    expect(t.calls('scraptfWindow.open').map((c) => c[1])).toEqual([{ start: 'https://scrap.tf/buy/stranges' }]);
    expect(t.opened()).toEqual([]);
    expect((await t.b.rpc('scraptfWindow.state', undefined)).url).toBe('https://scrap.tf/buy/stranges');
  });
});
