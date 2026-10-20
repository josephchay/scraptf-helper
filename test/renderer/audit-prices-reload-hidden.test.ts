// 0.7.3: the Price sheet re-reads the whole price list on 'prices.changed' only while the dashboard is
// shown, as the nav count does. Closed to the tray the page stays mounted, and every scrap.tf window read
// or quick-entry save pushes 'prices.changed': it used to pull the full list each time for a sheet nobody
// could see. While hidden, pushes collapse into one reload when the window is shown again.
// The real page inside AppProvider against the browser mock in the minimal DOM of domShim.ts; the pushes
// are played by hand. Nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import type { FlipdeskBridge, PushEvent } from '../../src/shared/rpc';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let PricesPage: () => ReactNode;
let createMockBridge: typeof import('../../src/renderer/mock').createMockBridge;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;
const setVisibility = (v: 'visible' | 'hidden') => {
  (doc as unknown as Record<string, unknown>)['visibilityState'] = v;
};

beforeAll(async () => {
  doc = installDomShim();
  setVisibility('visible');
  const proto = ShimElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto['scrollTo'] !== 'function') proto['scrollTo'] = () => undefined;
  const html = doc.documentElement as unknown as Record<string, unknown>;
  if (!html['dataset']) html['dataset'] = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  win()['location'] = { hash: '#/prices' };
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ PricesPage } = await import('../../src/renderer/pages/PricesPage'));
  ({ createMockBridge } = await import('../../src/renderer/mock'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  setVisibility('visible');
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

async function mountPrices() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash: '#/prices' };
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
  const calls: string[] = [];
  // Only the test's own pushes reach the page, so nothing else can trigger a reload.
  const listeners = new Map<PushEvent, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: ((m, p) => {
      calls.push(m);
      return b.rpc(m, p);
    }) as FlipdeskBridge['rpc'],
    on: ((event: PushEvent, fn: (p: unknown) => void) => {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return () => void set.delete(fn);
    }) as FlipdeskBridge['on'],
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(PricesPage))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  let clock = NOW;
  const pricesChanged = async () => {
    // Past the 1 s throttle each time, so only the visibility gate can hold a reload back.
    clock += 5_000;
    vi.setSystemTime(clock);
    act(() => {
      for (const fn of [...(listeners.get('prices.changed') ?? [])]) fn({ at: clock });
    });
    await settle();
  };
  const show = async (v: 'visible' | 'hidden') => {
    setVisibility(v);
    act(() => {
      doc.dispatchEvent(new ShimEvent('visibilitychange'));
    });
    await settle();
  };
  const listCalls = () => calls.filter((m) => m === 'prices.list').length;
  /** The "Your prices" heading's count: the rows the sheet holds. */
  const shown = () => {
    const title = container.descendants().find((e) => e.id === 'price-list-title');
    return title?.descendants().find((e) => (e.getAttribute('class') ?? '').split(' ').includes('count-badge'))?.textContent ?? null;
  };
  return { b, pricesChanged, show, listCalls, shown };
}

describe('the Price sheet', () => {
  it('reloads on prices.changed while shown, holds it while hidden, and catches up once when shown', async () => {
    const t = await mountPrices();
    const start = (await t.b.rpc('prices.list', {})).length;
    expect(start).toBeGreaterThan(0);
    expect(t.shown()).toBe(String(start));

    // Shown: one push, one reload.
    let before = t.listCalls();
    await t.pricesChanged();
    expect(t.listCalls()).toBe(before + 1);

    // Closed to the tray: pushes read nothing, even when the sheet really changed.
    await t.show('hidden');
    before = t.listCalls();
    await t.pricesChanged();
    await t.pricesChanged();
    await t.b.rpc('prices.upsert', { sku: '5021;6', costScrap: 500, source: 'user' });
    await t.pricesChanged();
    expect(t.listCalls()).toBe(before);
    expect(t.shown()).toBe(String(start));

    // Shown again: one catch-up read, and the sheet is current.
    await t.show('visible');
    expect(t.listCalls()).toBe(before + 1);
    expect(t.shown()).toBe(String(start + 1));

    // And live again afterwards.
    await t.pricesChanged();
    expect(t.listCalls()).toBe(before + 2);
  });

  it('shown with nothing missed, it reads nothing extra', async () => {
    const t = await mountPrices();
    await t.show('hidden');
    const before = t.listCalls();
    await t.show('visible');
    expect(t.listCalls()).toBe(before);
  });

  it('is wired with useVisiblePush (static)', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/PricesPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain("useVisiblePush('prices.changed', reloadSoon)");
    expect(page).not.toMatch(/usePush\('prices\.changed'/);
  });
});
