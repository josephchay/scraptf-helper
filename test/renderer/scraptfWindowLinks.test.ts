// F21, the dashboard's scrap.tf opens when the user lets Flip Desk's scrap.tf links open in the opt-in
// scrap.tf window (openLinksInWindow): main routes links.open there and answers openedIn: 'window', so the
// Live market row, the one-bank header, the drawer and the row menu say "the Flip Desk window" instead of
// "your browser", and the toast says where it opened. The URLs stay the same static SCRAPTF_BANKS pages.
// Plus the Import page's "Flip Desk window" origin and its window-read wording. All in memory.

import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importNoticeToastText, importWarningsView, NO_CARDS_SAVED_REASON, NO_CARDS_WINDOW_HINT, NO_CARDS_WINDOW_REASON } from '../../src/renderer/importModel';
import { itemMenuSections, SCRAPTF_NAME_COPIED, SCRAPTF_NAME_COPIED_WINDOW, scraptfOpenedToast, scraptfOpenTitle } from '../../src/renderer/itemMenuModel';
import { marketBankLink, marketScraptfButton } from '../../src/renderer/marketModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { SCRAPTF_WINDOW_LINKS_HINT } from '../../src/renderer/scraptfWindowModel';
import { SCRAPTF_BOUNDARY_SHORT } from '../../src/shared/boundaryText';
import { SCRAPTF_BANKS, scraptfPageFor } from '../../src/shared/links';
import type { ImportResult, MarketRow } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const HATS = scraptfPageFor('hats');
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const WINDOW = { opened: true, reason: null, openedIn: 'window' as const };
const BACK = 'Copy the price there and press Ctrl+Alt+C to check it here.';

describe('the toast after "Open on scrap.tf"', () => {
  it('says the Flip Desk window when main opened it there', () => {
    expect(scraptfOpenedToast(true, WINDOW, HATS, BACK)).toEqual({
      text: `Opened scrap.tf/buy/hats in the Flip Desk window. The name is copied; paste it into scrap.tf's search. ${BACK}`,
      tone: 'good',
    });
    expect(scraptfOpenedToast(true, WINDOW, HATS)).toEqual({ text: SCRAPTF_NAME_COPIED_WINDOW, tone: 'good' });
    expect(SCRAPTF_NAME_COPIED_WINDOW).toBe("Opened in the Flip Desk window. Name copied; paste it into scrap.tf's search.");
    expect(scraptfOpenedToast(false, WINDOW, HATS, BACK)).toEqual({
      text: `scrap.tf is open in the Flip Desk window, but the name could not be copied. Type it into scrap.tf's search. ${BACK}`,
      tone: 'warn',
    });
  });

  it('is unchanged for the browser', () => {
    expect(scraptfOpenedToast(true, { opened: true, reason: null }, HATS)).toEqual({ text: SCRAPTF_NAME_COPIED, tone: 'good' });
    expect(scraptfOpenedToast(true, { opened: true, reason: null }, HATS, BACK).text).toMatch(/^Opened scrap\.tf\/buy\/hats in your browser\./);
    expect(scraptfOpenedToast(false, { opened: false, reason: 'Refused.' }, HATS).text).toBe(`Refused. ${HATS}`);
  });
});

describe('the words of each scrap.tf open', () => {
  const row = { sku: '378;6', name: 'Team Captain', category: 'hats', scraptfLink: { bank: 'hats', url: HATS, seenAt: null, source: 'category' } } as Pick<MarketRow, 'sku' | 'name' | 'category' | 'scraptfLink'>;

  it('the Live market row button: same static page, worded for the window', () => {
    const browser = marketScraptfButton(row, T0);
    const inWindow = marketScraptfButton(row, T0, true);
    expect(inWindow.url).toBe(browser.url);
    expect(inWindow.url).toBe(HATS);
    expect(inWindow.ariaLabel).toBe('Hats: open scrap.tf/buy/hats in the Flip Desk window and copy the name');
    expect(inWindow.title).toBe("scrap.tf's Hats bank (not in your saves yet). Opens it in the Flip Desk window and copies the name (o).");
    expect(browser.ariaLabel).toBe('Hats: open scrap.tf/buy/hats in your browser and copy the name');
  });

  it('the one-bank header, the drawer and the row menu', () => {
    const link = marketBankLink(['hats'], true)!;
    expect(link.url).toBe(HATS);
    expect(link.ariaLabel).toBe('Open scrap.tf/buy/hats in the Flip Desk window');
    expect(link.title).toBe("Opens scrap.tf's Hats bank in the Flip Desk window, to look for these items there.");
    expect(marketBankLink(['hats'])!.ariaLabel).toBe('Open scrap.tf/buy/hats in your browser');
    expect(scraptfOpenTitle(HATS, 'Team Captain', true)).toBe(`Copies "Team Captain" for scrap.tf's search and opens ${HATS} in the Flip Desk window, where you browse it yourself.`);
    // 0.7.1 (UX-7): the boundary sentence that stays true with the window on.
    expect(scraptfOpenTitle(HATS, 'Team Captain')).toContain(`in your browser. ${SCRAPTF_BOUNDARY_SHORT}`);
    const item = (inWindow: boolean) =>
      itemMenuSections({ sku: '378;6', name: 'Team Captain', category: 'hats' }, { status: 'ready', links: [] }, null, inWindow)
        .flatMap((s) => s.items)
        .find((i) => i.id === 'scraptf-open')!;
    expect(item(true).title).toContain('in the Flip Desk window');
    expect(item(false).title).toContain('in your browser');
    // The action is the same static page either way.
    expect(item(true).action).toEqual(item(false).action);
  });

  it('lets only the opens worded for the window ask for it (allowWindow); every open that promises the browser keeps to it', () => {
    const asks = (rel: string) => read(rel).includes('allowWindow: true');
    // Worded through scraptfLinksInWindow (the market, drawer, menu and, from 0.7.1 (F21-9), the Bank stock
    // page's Open) or the banks card's openTarget.
    expect(read('components/ItemMenu.tsx')).toContain('const opened = await openLink(url, { allowWindow: true });');
    expect(read('pages/MarketPage.tsx')).toContain('openOrCopy(bankLink.url, toast, { allowWindow: true })');
    expect(read('pages/BanksPage.tsx')).toContain('onOpenBank={(c) => void openOrCopy(c.url, toast, { allowWindow: true })}');
    expect(read('pages/BankStockPage.tsx')).toContain('openOrCopy(info.url, toast, { allowWindow: true })');
    // Their words say "your browser": main sends their links to the browser.
    for (const rel of ['pages/ShoppingPage.tsx', 'components/ScraptfListCard.tsx', 'pages/ItemDrawer.tsx', 'pages/HoldingsPage.tsx', 'pages/QuickEntry.tsx', 'components/ExternalLink.tsx']) {
      expect(asks(rel), rel).toBe(false);
    }
    const askers = readdirSync(new URL('../../src/renderer/', import.meta.url), { recursive: true, encoding: 'utf8' })
      .map((f) => f.split(sep).join('/'))
      .filter((f) => /\.tsx?$/.test(f) && f !== 'api.ts' && asks(f))
      .sort();
    expect(askers).toEqual(['components/ItemMenu.tsx', 'pages/BankStockPage.tsx', 'pages/BanksPage.tsx', 'pages/MarketPage.tsx']);
    // The hint in Settings names the same opens.
    expect(SCRAPTF_WINDOW_LINKS_HINT).toContain("the Bank stock page's Open");
  });

  it('wires the setting into the market, drawer and menu (scraptfLinksInWindow of the settings)', () => {
    const market = read('pages/MarketPage.tsx');
    expect(market).toContain('const scraptfInWindow = scraptfLinksInWindow(settings);');
    expect(market).toContain('scraptfInWindow={scraptfInWindow}');
    expect(market).toContain('marketScraptfButton(r, now, scraptfInWindow)');
    expect(read('pages/ItemDrawer.tsx')).toContain('title={scraptfOpenTitle(stfUrl, scraptfSearchName(d), scraptfLinksInWindow(settings))}');
    expect(read('components/ItemMenu.tsx')).toContain('const inWindow = scraptfLinksInWindow(settings);');
  });
});

describe('openOnScraptf against the mock with links in the window', () => {
  let bridge: MockBridge | null = null;
  afterEach(() => {
    bridge?.dispose();
    bridge = null;
    vi.unstubAllGlobals();
  });

  it('arms, copies, hands links.open the static page, and the toast says the Flip Desk window', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    const settings = await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 }, scraptfWindow: { enabled: true, acknowledgedAt: T0, openLinksInWindow: true } });
    const rpc = vi.spyOn(b, 'rpc');
    const copies: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => void copies.push(text) } });
    vi.stubGlobal('window', { flipdesk: b });
    const { openOnScraptf } = await import('../../src/renderer/components/ItemMenu');
    const toast = vi.fn();
    await openOnScraptf(HATS, 'Team Captain', toast, { sku: '378;6', settings });
    expect(copies).toEqual(['Team Captain']);
    expect(rpc.mock.calls.filter((c) => c[0] === 'links.open').map((c) => c[1])).toEqual([{ url: HATS, allowWindow: true }]);
    // The renderer never asks for the window itself here: main (the mock) routed the link.
    expect(rpc.mock.calls.filter((c) => String(c[0]).startsWith('scraptfWindow.'))).toEqual([]);
    expect((await b.rpc('scraptfWindow.state', undefined)).url).toBe(HATS);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(String(toast.mock.calls[0]![0])).toMatch(/^Opened scrap\.tf\/buy\/hats in the Flip Desk window\. The name is copied; paste it into scrap\.tf's search\./);
    expect(toast.mock.calls[0]![1]).toBe('good');
  });
});

describe('the Import page', () => {
  const result = (over: Partial<ImportResult> = {}): ImportResult => ({
    batchId: 7,
    fileName: 'scrap.tf window /buy/hats',
    pageKind: 'buy',
    parsed: 0,
    stored: 0,
    skipped: [],
    warnings: ['no-cards-saved: This page was saved without its items.'],
    bank: 'hats',
    origin: 'window',
    ...over,
  });

  // A guard, not a path the app takes today: the service records no batch for a window read with no items
  // (batchId 0, no import.done push), and the toolbar says "no items on screen yet" for it instead
  // (main's 'no-cards-saved', scraptfWindowWiring.test.ts). This wording is kept for a recorded one.
  it("says a window read found no items yet, with no save to blame, and the dashboard does not toast it", () => {
    expect(importWarningsView(result()).noCards).toEqual({ text: NO_CARDS_WINDOW_REASON, hint: NO_CARDS_WINDOW_HINT });
    expect(importNoticeToastText(result())).toBeNull();
    // A saved file is told as before.
    const file = result({ origin: 'file', fileName: 'Hats.html' });
    expect(importWarningsView(file).noCards!.text).toBe(NO_CARDS_SAVED_REASON);
    expect(importNoticeToastText(file)).toMatch(/^Hats\.html: /);
    expect(importNoticeToastText(result({ origin: undefined, fileName: 'Hats.html' }))).toMatch(/^Hats\.html: /);
  });

  it('shows a window read as "Read from: Flip Desk window · scrap.tf/buy/hats"', async () => {
    const { ImportResultView } = await import('../../src/renderer/pages/ImportPage');
    const h = renderToString(createElement(ImportResultView, { r: result({ parsed: 48, stored: 48, warnings: [] }) })).replace(/<!-- -->/g, '');
    expect(h).toContain('<dt>Read from</dt>');
    expect(h).toMatch(/Flip Desk window · <span class="mono small">scrap\.tf\/buy\/hats<\/span>/);
    expect(h).not.toContain('<dt>File</dt>');
    const file = renderToString(createElement(ImportResultView, { r: result({ origin: undefined, fileName: 'Hats.html', warnings: [] }) }));
    expect(file).toContain('<dt>File</dt>');
    expect(file).not.toContain('Flip Desk window');
  });

  it('labels batches from the window in the Recent batches table', () => {
    const page = read('pages/ImportPage.tsx');
    expect(page).toContain('const from = importOriginView(b);');
    expect(page).toContain('<span className="pill tone-info import-origin">{from.origin}</span>');
    expect(SCRAPTF_BANKS.length).toBe(8);
  });
});
