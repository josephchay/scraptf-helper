// F15: a scrap.tf bank card's "See all" (#/market/bank/<bank>) over a Live market whose saved
// filters had a search and a minimum Pay up to. The route's filters reset both, and the search box
// and the minimum are debounced: the first market.list must not carry the old ones while those
// timers run, or the table opens on the wrong rows and jumps 200-300 ms later. Mounted with
// react-dom/client into the minimal DOM in domShim.ts against the browser mock. No network.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { MarketQuery } from '../../src/shared/types';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const FILTERS_KEY = 'flipdesk.ui.market.filters';

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let MarketPage: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

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
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ MarketPage } = await import('../../src/renderer/pages/MarketPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  delete win()['history'];
  delete win()['dispatchEvent'];
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** The Live market at `hash`, over saved filters with a search and a minimum Pay up to. */
async function mount(hash: string, saved: Record<string, unknown>) {
  const store = new Map<string, string>([[FILTERS_KEY, JSON.stringify(saved)]]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const location = { hash };
  win()['location'] = location;
  win()['history'] = { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (location.hash = url) };
  win()['dispatchEvent'] = () => true;
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(MarketPage))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const lists = () => rpc.mock.calls.filter((c) => c[0] === 'market.list').map((c) => c[1] as MarketQuery);
  return { lists, store };
}

describe('"See all" over saved Live market filters', () => {
  const SAVED = { search: 'scattergun', minCeiling: '5 ref', categories: ['hats'], verdicts: ['flip'] };

  it('never asks with the old search or minimum, not even before their debounce settles', async () => {
    const t = await mount('#/market/bank/killstreaks', SAVED);
    expect(t.lists().length).toBeGreaterThan(0);
    for (const q of t.lists()) {
      expect(q).toMatchObject({ categories: ['killstreaks'], verdicts: ['unchecked'] });
      expect(q.search).toBeUndefined();
      expect(q.minCeilingScrap).toBeUndefined();
    }
    // Once the debounce timers have run, still the same query: no second, different read.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await settle();
    for (const q of t.lists()) {
      expect(q.search).toBeUndefined();
      expect(q.minCeilingScrap).toBeUndefined();
    }
    // The route's filters are the saved ones now.
    expect(JSON.parse(t.store.get(FILTERS_KEY)!)).toMatchObject({ search: '', minCeiling: '', categories: ['killstreaks'], verdicts: ['unchecked'] });
  });

  it('a plain #/market keeps the saved search and minimum', async () => {
    const t = await mount('#/market', SAVED);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await settle();
    const last = t.lists().at(-1)!;
    expect(last.search).toBe('scattergun');
    expect(last.categories).toEqual(['hats']);
    // 5 ref.
    expect(last.minCeilingScrap).toBe(45);
  });
});
