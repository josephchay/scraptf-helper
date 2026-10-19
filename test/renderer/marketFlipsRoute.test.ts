// UX-1 (0.7.1): "flips on my saves, freshest first" in one click. The banks page header's "View all"
// opens #/market/flips: every Flip whose scrap.tf price came from a page the user saved (or read in the
// opt-in window), the freshest sighting first (the 'seen' sort, ties by profit), across every bank. The
// intent is checked as data, then the Live market is mounted with react-dom/client into the minimal DOM
// in domShim.ts against the browser mock: its first market.list asks for exactly that, and the route
// goes back to #/market without a history entry. No network.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MARKET_SORT,
  MARKET_FLIPS_PATH,
  MARKET_FLIPS_ROUTE,
  SORT_LABELS,
  defaultMarketFilters,
  marketQuery,
  marketRouteIntent,
  sanitizeMarketSort,
} from '../../src/renderer/marketModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { MARKET_SORTS, marketComparator } from '../../src/shared/market';
import type { MarketQuery } from '../../src/shared/types';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

describe('the #/market/flips intent', () => {
  it('asks for every Flip priced from a saved page, the freshest sighting first', () => {
    expect(MARKET_FLIPS_ROUTE).toBe('flips');
    expect(MARKET_FLIPS_PATH).toBe('market/flips');
    const i = marketRouteIntent(['market', 'flips'])!;
    expect(i.key).toBe('flips');
    expect(i.filters).toEqual({ ...defaultMarketFilters(), verdicts: ['flip'], sources: ['page'] });
    expect(i.sort).toEqual({ sort: 'seen', dir: 'desc' });
    expect(marketQuery(i.filters, null, i.sort)).toEqual({ sort: 'seen', dir: 'desc', verdicts: ['flip'], sources: ['page'] });
    // A fresh copy each time (state must not share the frozen defaults).
    expect(marketRouteIntent(['market', 'flips'])!.filters).not.toBe(i.filters);
    // The bank intent is unchanged beside it.
    expect(marketRouteIntent(['market', 'bank', 'hats'])!.sort).toEqual(DEFAULT_MARKET_SORT);
  });

  it('ignores anything else under it', () => {
    expect(marketRouteIntent(['market', 'flips', 'hats'])).toBeNull();
    expect(marketRouteIntent(['banks', 'flips'])).toBeNull();
    expect(marketRouteIntent(['market', 'Flips'])).toBeNull();
  });

  it("offers the 'seen' sort by name, remembers it, and orders freshest first, ties by profit", () => {
    expect(MARKET_SORTS).toContain('seen');
    expect(SORT_LABELS.seen).toBe('Seen on scrap.tf');
    expect(sanitizeMarketSort({ sort: 'seen' })).toEqual({ sort: 'seen', dir: 'desc' });
    const row = (sku: string, knownObservedAt: number | null, profitScrap: number | null) => ({ sku, name: sku, knownObservedAt, profitScrap }) as never;
    const rows = [row('a', T0 - 3_600_000, 50), row('b', T0, 10), row('c', null, 999), row('d', T0, 40)];
    expect([...rows].sort(marketComparator('seen', 'desc')).map((r: { sku: string }) => r.sku)).toEqual(['d', 'b', 'a', 'c']);
  });
});

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
  try {
    localStorage.clear();
  } catch {
    // no storage in this process
  }
});

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(hash: string) {
  const location = { hash };
  win()['location'] = location;
  const replaceState = vi.fn((_s: unknown, _t: string, url: string) => {
    location.hash = url;
  });
  win()['history'] = { state: null, replaceState };
  win()['dispatchEvent'] = vi.fn();
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
  return { b, lists, replaceState, location };
}

describe('#/market/flips in the Live market', () => {
  it('asks the first market.list for Flips from saved pages, freshest first, then drops the route from the history', async () => {
    const t = await mount('#/market/flips');
    const first = t.lists()[0]!;
    expect(first).toMatchObject({ verdicts: ['flip'], sources: ['page'], sort: 'seen', dir: 'desc' });
    expect(first.categories).toBeUndefined();
    for (const q of t.lists()) expect(q).toMatchObject({ verdicts: ['flip'], sources: ['page'], sort: 'seen' });
    expect(t.replaceState).toHaveBeenCalledTimes(1);
    expect(t.replaceState.mock.calls[0]![2]).toBe('#/market');
    // The mock answers it: every row is a Flip from a page, freshest sighting first.
    const r = await t.b.rpc('market.list', { verdicts: ['flip'], sources: ['page'], sort: 'seen', dir: 'desc', limit: 200 });
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row.verdict).toBe('flip');
    const seen = r.rows.map((row) => row.knownObservedAt).filter((v): v is number => typeof v === 'number');
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });
});
