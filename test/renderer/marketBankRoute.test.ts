// F15: a scrap.tf bank card's "See all" opens #/market/bank/<bank>. The Live market, mounted with
// react-dom/client into the minimal DOM in domShim.ts against the browser mock, asks its very first
// market.list for that bank's categories and Not checked (highest Pay up to first), then swaps the
// route back to #/market without a history entry. No network.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { MarketQuery } from '../../src/shared/types';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

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
  const dispatchEvent = vi.fn();
  win()['history'] = { state: null, replaceState };
  win()['dispatchEvent'] = dispatchEvent;
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
  return { lists, replaceState, dispatchEvent, location, container };
}

describe('"See all" from a scrap.tf bank card', () => {
  it("asks the first market.list for the bank's categories and Not checked, then drops the route from the history", async () => {
    const t = await mount('#/market/bank/killstreaks');
    const first = t.lists()[0]!;
    expect(first).toMatchObject({ categories: ['killstreaks'], verdicts: ['unchecked'], sort: 'ceiling', dir: 'desc' });
    expect(first.search).toBeUndefined();
    expect(first.sources).toBeUndefined();
    // Every read since asks the same.
    for (const q of t.lists()) expect(q).toMatchObject({ categories: ['killstreaks'], verdicts: ['unchecked'] });
    expect(t.replaceState).toHaveBeenCalledTimes(1);
    expect(t.replaceState.mock.calls[0]![2]).toBe('#/market');
    expect(t.location.hash).toBe('#/market');
    expect(t.dispatchEvent).toHaveBeenCalledTimes(1);
    // The filter bar shows it: one category, Not checked on.
    const chip = t.container.descendants().find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-pressed') === 'true' && /Not checked/.test(e.textContent));
    expect(chip).toBeDefined();
  });

  it('the items bank asks for taunts and everything else', async () => {
    const t = await mount('#/market/bank/items');
    expect(t.lists()[0]).toMatchObject({ categories: ['taunts', 'other'], verdicts: ['unchecked'] });
  });

  it('a plain #/market keeps the saved filters and touches no history', async () => {
    const t = await mount('#/market');
    expect(t.lists()[0]!.categories).toBeUndefined();
    expect(t.lists()[0]!.verdicts).toBeUndefined();
    expect(t.replaceState).not.toHaveBeenCalled();
    // The /items list has no "See all".
    const list = await mount('#/market/bank/list');
    expect(list.replaceState).not.toHaveBeenCalled();
  });
});
