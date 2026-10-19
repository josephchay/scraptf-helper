// 0.7.1 on the scrap.tf banks page. UX-1: the header says "N flips on your saves, newest 3 min ago · View
// all", the sum of the cards' flip counts (each its stock page's Flips chip), and View all opens the Live
// market's #/market/flips. ACT-8: a page saved within profit.inputStaleMs titles "What to look for" as
// restocks to watch ("Not in your save 12 min ago: watch for restocks"), since that save showed none on
// sale. UX-5: with the window on, a missing folder is the optional note. Helpers checked as data, the page
// rendered server-side, then mounted with react-dom/client into the minimal DOM in domShim.ts against the
// browser mock. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bankCards, bankLookForTitle, banksFlipsLine } from '../../src/renderer/banksModel';
import { MARKET_FLIPS_PATH } from '../../src/renderer/marketModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { BanksViewProps } from '../../src/renderer/pages/BanksPage';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { ScraptfBank, ScraptfBankSummary, ScraptfBanksResult, ScraptfListStatus } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const STALE = 2 * HOUR;
const noop = () => undefined;

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
const result = (over: Partial<Record<ScraptfBank, Partial<ScraptfBankSummary>>>): ScraptfBanksResult => ({
  banks: SCRAPTF_BANKS.map((b) => summary(b.bank, over[b.bank] ?? {})),
  importEnabled: true,
  watchActive: true,
  generatedAt: T0,
});

const RESULT = result({
  hats: { lastSavedAt: T0 - 3 * MIN, pages: 1, items: 48, inStock: 31, flips: 4, flipProfitScrap: 30, unchecked: 2, lookFor: [{ sku: '35;6', name: 'Kritzkrieg', maxCostScrap: 19, revenueScrap: 30 }] },
  stranges: { lastSavedAt: T0 - 5 * HOUR, pages: 1, items: 10, inStock: 9, flips: 2, flipProfitScrap: 11, unchecked: 1, lookFor: [{ sku: '35;11', name: 'Strange Kritzkrieg', maxCostScrap: 19, revenueScrap: 30 }] },
  list: { lastSavedAt: T0 - 10 * MIN, pages: 1, items: 2341, inStock: 1800, flips: 1, flipProfitScrap: 4 },
});

describe('the flips line (UX-1)', () => {
  it('adds up the cards, dated by the newest save of a page with flips', () => {
    const l = banksFlipsLine(RESULT, T0)!;
    expect(l.count).toBe(7);
    expect(l.text).toBe('7 flips on your saves, newest 3 min ago');
    expect(l.title).toContain('View all lists them in the Live market, freshest price first.');
    expect(banksFlipsLine(result({ hats: { lastSavedAt: T0 - 3 * MIN, flips: 1 } }), T0)!.text).toBe('1 flip on your saves, newest 3 min ago');
    // A page saved with no flips does not date the line.
    expect(banksFlipsLine(result({ hats: { lastSavedAt: T0 - MIN, flips: 0 }, weapons: { lastSavedAt: T0 - HOUR, flips: 2 } }), T0)!.text).toBe('2 flips on your saves, newest 1 h ago');
  });

  it('says nothing before an answer or without flips; broken counts count as none', () => {
    expect(banksFlipsLine(null, T0)).toBeNull();
    expect(banksFlipsLine(result({}), T0)).toBeNull();
    expect(banksFlipsLine(result({ hats: { flips: Number.NaN }, weapons: { flips: -3 } }), T0)).toBeNull();
    // A file time a little ahead of the clock reads just now.
    expect(banksFlipsLine(result({ hats: { lastSavedAt: T0 + MIN, flips: 1 } }), T0)!.text).toBe('1 flip on your saves, newest just now');
  });
});

describe('"What to look for" after a fresh save (ACT-8)', () => {
  it('a page saved within inputStaleMs: restocks to watch; older, or without the setting: as before', () => {
    expect(bankLookForTitle(T0 - 12 * MIN, T0, STALE, 'scrap.tf/buy/hats')).toEqual({
      text: 'Not in your save 12 min ago: watch for restocks',
      title: "Items with backpack.tf buyers in this page's categories that your save of scrap.tf/buy/hats 12 min ago did not list on sale, highest Pay up to first. Save it again later to see whether one came back.",
    });
    expect(bankLookForTitle(T0 - 3 * HOUR, T0, STALE).text).toBe('What to look for');
    expect(bankLookForTitle(T0 - 12 * MIN, T0, null).text).toBe('What to look for');
    expect(bankLookForTitle(null, T0, STALE).text).toBe('What to look for');
    const cards = bankCards(RESULT, 568, T0, STALE);
    expect(cards.find((c) => c.bank === 'hats')!.lookFor!.title.text).toBe('Not in your save 3 min ago: watch for restocks');
    expect(cards.find((c) => c.bank === 'stranges')!.lookFor!.title.text).toBe('What to look for');
    // The list has nothing to look for at all; without the setting every card reads as before.
    expect(cards.find((c) => c.bank === 'list')!.lookFor).toBeNull();
    // /unusuals spans many pages: a fresh save of one of them does not show an item is off sale there.
    const unusuals = bankCards(result({ unusuals: { lastSavedAt: T0 - 3 * MIN, pages: 1, items: 20, lookFor: [{ sku: '30743;5;u13', name: 'Burning Flames Hat', maxCostScrap: 900, revenueScrap: 1100 }] } }), 568, T0, STALE);
    expect(unusuals.find((c) => c.bank === 'unusuals')!.lookFor!.title.text).toBe('What to look for');
    for (const c of bankCards(RESULT, 568, T0)) if (c.lookFor) expect(c.lookFor.title.text).toBe('What to look for');
  });
});

let BanksView: typeof import('../../src/renderer/pages/BanksPage').BanksView;
let BanksPage: typeof import('../../src/renderer/pages/BanksPage').BanksPage;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/banks' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ BanksView, BanksPage } = await import('../../src/renderer/pages/BanksPage'));
});

const STATUS: ScraptfListStatus = { items: 2341, newestAt: T0 - 3 * MIN, oldestAt: T0 - 3 * MIN, pages: 1, importEnabled: true, watchFolder: null, watchActive: false, watchError: null };

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

const html = (over: Partial<BanksViewProps> = {}) =>
  renderToString(createElement(AppProvider, null, createElement(BanksView, props(over))))
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'");

describe('BanksView, rendered', () => {
  it('heads the page with the flips line and View all', () => {
    const h = html({ onViewFlips: noop });
    expect(h).toContain('<p class="banks-flips"');
    expect(h).toContain('7 flips on your saves, newest 3 min ago');
    expect(h).toMatch(/class="link-btn small banks-view-flips"[^>]*>View all/);
    // Without a handler (an embedding that cannot navigate): the line, no button.
    expect(html()).not.toContain('banks-view-flips');
    expect(html({ result: result({}) })).not.toContain('banks-flips');
  });

  it("words a fresh page's look-for block as restocks, from settings.profit.inputStaleMs", () => {
    expect(html({ inputStaleMs: STALE })).toContain('Not in your save 3 min ago: watch for restocks');
    expect(html()).not.toContain('watch for restocks');
  });

  it('with the window on, a missing folder is the optional note and the boundary is window-true', () => {
    const on = html({ scraptfWindow: { linksHere: false, readOnLoad: true } });
    expect(on).toContain('No watch folder: optional while you read pages in the Flip Desk window.');
    expect(on).toContain('You open it, in your browser or the Flip Desk window, and you choose when.');
    const off = html();
    expect(off).toContain('No watch folder yet. Choose one, then save the scrap.tf pages into it.');
    expect(off).toContain('Flip Desk never loads scrap.tf on its own. Your browser does, and you choose when.');
  });
});

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

describe('BanksPage against the mock', () => {
  it('View all opens #/market/flips, and the count is the cards added up', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    const location = { hash: '#/banks' };
    win()['location'] = location;
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'D:\\saves' } });
    win()['flipdesk'] = b;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    act(() => root.render(createElement(AppProvider, null, createElement(BanksPage))));
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    await settle();
    const banks = await b.rpc('scraptf.banks', undefined);
    const total = banks.banks.reduce((n, s) => n + s.flips, 0);
    expect(total).toBeGreaterThan(0);
    const line = container.descendants().find((e) => (e.getAttribute('class') ?? '') === 'banks-flips')!;
    expect(line.textContent).toMatch(new RegExp(`^${total} flips? on your saves`));
    const viewAll = line.descendants().find((e) => e.tagName === 'BUTTON')!;
    act(() => {
      viewAll.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(location.hash).toBe(`#/${MARKET_FLIPS_PATH}`);
  });
});
