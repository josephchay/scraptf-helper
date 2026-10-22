// F21-2 (0.7.1): the scrap.tf window toolbar's "Show flips" lands on a bank's stock page on one chip. Main
// shows the dashboard and pushes 'ui.openBankStock' (the mock's 'app.showBankStock' does the same); the
// dashboard sets #/banks/<bank>/stock/<flips|new>, and the stock page applies that chip once per
// navigation, with no search hiding its rows, then drops it from the address so the next Show flips
// applies again. The route helpers are checked as data, then the dashboard's route and the page are
// mounted with react-dom/client into the minimal DOM in domShim.ts against the browser mock. No network.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bankStockOpenPath, bankStockPath, bankStockRouteBank, bankStockRouteFilter } from '../../src/renderer/banksModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { BANK_STOCK_OPEN_FILTERS } from '../../src/shared/types';
import type { BankStockQuery, ScraptfBank } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

describe('the chip routes', () => {
  it('reads #/banks/<bank>/stock/<flips|new>, and nothing else', () => {
    expect(BANK_STOCK_OPEN_FILTERS).toEqual(['flips', 'new', 'watched']);
    expect(bankStockRouteFilter(['banks', 'hats', 'stock', 'flips'])).toBe('flips');
    expect(bankStockRouteFilter(['banks', 'unusuals', 'stock', 'new'])).toBe('new');
    // The stock page is still the bank's.
    expect(bankStockRouteBank(['banks', 'hats', 'stock', 'flips'])).toBe('hats');
    for (const s of [
      ['banks', 'hats', 'stock'],
      ['banks', 'hats', 'stock', 'gone'],
      ['banks', 'hats', 'stock', '__proto__'],
      ['banks', 'nope', 'stock', 'flips'],
      ['banks', 'hats', 'flips'],
      ['market', 'hats', 'stock', 'flips'],
      [],
    ]) {
      expect(bankStockRouteFilter(s), s.join('/')).toBeNull();
    }
  });

  it("builds the route of a 'ui.openBankStock' push from a known bank and chip only", () => {
    expect(bankStockOpenPath({ bank: 'hats', filter: 'flips' })).toBe('banks/hats/stock/flips');
    expect(bankStockOpenPath({ bank: 'list', filter: 'new' })).toBe('banks/list/stock/new');
    for (const bad of [null, undefined, 'hats', {}, { bank: 'hats' }, { bank: 'hats', filter: 'gone' }, { bank: 'https://scrap.tf/buy/hats', filter: 'flips' }, { bank: '__proto__', filter: 'new' }]) {
      expect(bankStockOpenPath(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(bankStockPath('hats')).toBe('banks/hats/stock');
  });
});

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let BankStockPage: (p: { bank: ScraptfBank }) => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
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
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ BankStockPage } = await import('../../src/renderer/pages/BankStockPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
const saved: Record<string, unknown> = {};
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  for (const k of ['flipdesk', 'history', 'location']) delete win()[k];
  for (const [k, v] of Object.entries(saved)) win()[k] = v;
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

/** The dashboard's stock route (App's RouteView), keyed per bank as there. */
function Route() {
  const { segments } = useApp();
  const bank = bankStockRouteBank(segments);
  return bank ? createElement(BankStockPage, { key: bank, bank }) : createElement('output', { 'data-route': segments.join('/') });
}

/** A window whose hash setter fires 'hashchange' (as a browser's does), and replaceState, which fires none. */
function installRouting(hash: string) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent']) saved[k] ??= win()[k];
  win()['addEventListener'] = (type: string, fn: (e: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  };
  win()['removeEventListener'] = (type: string, fn: (e: unknown) => void) => void listeners.get(type)?.delete(fn);
  const dispatch = (e: { type: string }) => {
    for (const fn of [...(listeners.get(e.type) ?? [])]) fn(e);
    return true;
  };
  win()['dispatchEvent'] = dispatch;
  let current = hash;
  const sets: string[] = [];
  win()['location'] = {
    get hash() {
      return current;
    },
    set hash(v: string) {
      current = v.startsWith('#') ? v : `#${v}`;
      sets.push(current);
      dispatch({ type: 'hashchange' });
    },
  };
  const replaceState = vi.fn((_s: unknown, _t: string, url: string) => {
    current = url;
  });
  win()['history'] = { state: null, replaceState };
  return { replaceState, sets, hash: () => current };
}

async function mount(hash: string) {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  // A search remembered from an earlier visit: the chip's landing must not be hidden by it.
  store.set('flipdesk.ui.bankStock.view.hats', JSON.stringify({ filter: 'all', search: 'zzzz', sort: 'profit', dir: 'desc' }));
  const routing = installRouting(hash);
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'D:\\saves' } });
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(Route))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const queries = () => rpc.mock.calls.filter((c) => c[0] === 'scraptf.bankStock').map((c) => c[1] as BankStockQuery);
  const chip = (label: string) =>
    container.descendants().find((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '').includes('bs-chip') && e.textContent.startsWith(label))!;
  const fire = (target: ShimElement) =>
    act(() => {
      target.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
  return { b, store, routing, queries, chip, fire };
}

describe('Show flips lands on the chip', () => {
  it('#/banks/hats/stock/flips asks the first read for the Flips chip, search cleared, then drops the chip from the address', async () => {
    const t = await mount('#/banks/hats/stock/flips');
    const first = t.queries()[0]!;
    expect(first).toMatchObject({ bank: 'hats', filter: 'flips' });
    expect(first.search).toBeUndefined();
    for (const q of t.queries()) expect(q.filter).toBe('flips');
    expect(t.chip('Flips').getAttribute('aria-pressed')).toBe('true');
    expect(t.routing.replaceState).toHaveBeenCalledTimes(1);
    expect(t.routing.replaceState.mock.calls[0]![2]).toBe('#/banks/hats/stock');
    expect(t.routing.hash()).toBe('#/banks/hats/stock');
    // Remembered like any choice of the user's.
    expect(JSON.parse(t.store.get('flipdesk.ui.bankStock.view.hats')!)).toMatchObject({ filter: 'flips', search: '' });
  });

  it('a plain stock route keeps the remembered view and touches no history', async () => {
    const t = await mount('#/banks/hats/stock');
    expect(t.queries()[0]).toMatchObject({ bank: 'hats', filter: 'all', search: 'zzzz' });
    expect(t.routing.replaceState).not.toHaveBeenCalled();
  });

  it("the push 'ui.openBankStock' routes there, again after the user moved on, and for another bank", async () => {
    const t = await mount('#/banks/hats/stock');
    t.fire(t.chip('All'));
    await settle();
    expect(t.queries().at(-1)!.filter).toBe('all');
    // The toolbar's Show flips (main pushes after showing the dashboard; the mock's handler does the same).
    await act(async () => {
      await t.b.rpc('app.showBankStock', { bank: 'hats', filter: 'flips' });
    });
    await settle();
    expect(t.routing.sets).toContain('#/banks/hats/stock/flips');
    expect(t.queries().at(-1)).toMatchObject({ bank: 'hats', filter: 'flips' });
    expect(t.routing.hash()).toBe('#/banks/hats/stock');
    // The same push once more, after the user picked another chip: it applies again.
    t.fire(t.chip('All'));
    await settle();
    await act(async () => {
      await t.b.rpc('app.showBankStock', { bank: 'hats', filter: 'flips' });
    });
    await settle();
    expect(t.queries().at(-1)!.filter).toBe('flips');
    // Another bank's New chip: that bank's page, asked for New first (a bank with one save falls back to All).
    const before = t.queries().length;
    await act(async () => {
      await t.b.rpc('app.showBankStock', { bank: 'stranges', filter: 'new' });
    });
    await settle();
    const stranges = t.queries().slice(before);
    expect(stranges[0]).toMatchObject({ bank: 'stranges', filter: 'new' });
    expect(t.routing.hash()).toBe('#/banks/stranges/stock');
  });

  it('a push the dashboard cannot read changes nothing', async () => {
    const t = await mount('#/banks/hats/stock');
    await expect(t.b.rpc('app.showBankStock', { bank: 'moon', filter: 'flips' } as never)).rejects.toThrow(/bank/);
    await settle();
    expect(t.routing.sets).toEqual([]);
  });
});
