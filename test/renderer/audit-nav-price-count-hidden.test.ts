// 0.7.3: the Price sheet nav count re-reads the whole price list on 'prices.changed' only while the
// dashboard is shown. Closed to the tray it stays mounted, and every scrap.tf window read pushes
// 'prices.changed': it used to pull the full list each time for a badge nobody could see. While hidden,
// pushes collapse into one recount when the window is shown again.
// The real App root against the browser mock in the minimal DOM of domShim.ts; the pushes are played
// by hand. Nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import type { FlipdeskBridge, PushEvent } from '../../src/shared/rpc';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let Root: typeof import('../../src/renderer/App').Root;
let createMockBridge: typeof import('../../src/renderer/mock').createMockBridge;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;
const setVisibility = (v: 'visible' | 'hidden') => {
  (doc as unknown as Record<string, unknown>)['visibilityState'] = v;
};

beforeAll(async () => {
  doc = installDomShim();
  setVisibility('visible');
  win()['location'] = { hash: '#/journal' };
  const proto = ShimElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto['scrollTo'] !== 'function') proto['scrollTo'] = () => undefined;
  const html = doc.documentElement as unknown as Record<string, unknown>;
  if (!html['dataset']) html['dataset'] = {};
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
  win()['addEventListener'] = () => undefined;
  win()['removeEventListener'] = () => undefined;
  ({ createRoot } = await import('react-dom/client'));
  ({ Root } = await import('../../src/renderer/App'));
  ({ createMockBridge } = await import('../../src/renderer/mock'));
  // Importing the whole dashboard takes about 3 s alone and can pass the default 10 s while the suite is busy.
}, 60_000);

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

async function mountApp() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash: '#/journal' };
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
  const calls: string[] = [];
  // Only the test's own pushes reach the page, so nothing else can trigger a recount.
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
  act(() => root.render(createElement(Root)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  let clock = NOW;
  const pricesChanged = async () => {
    // Past the 1 s throttle each time, so only the visibility gate can hold a recount back.
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
  /** The Price sheet nav entry's count. */
  const badge = () => {
    const link = container.descendants().find((e) => e.tagName === 'A' && e.getAttribute('href') === '#/prices');
    return link?.descendants().find((e) => (e.getAttribute('class') ?? '').split(' ').includes('nav-count'))?.textContent ?? null;
  };
  return { b, pricesChanged, show, listCalls, badge };
}

describe('the Price sheet nav count', () => {
  it('recounts on prices.changed while shown, holds it while hidden, and catches up once when shown', async () => {
    const t = await mountApp();
    const start = (await t.b.rpc('prices.list', {})).length;
    expect(start).toBeGreaterThan(0);
    expect(t.badge()).toBe(String(start));

    // Shown: one push, one recount.
    let before = t.listCalls();
    await t.pricesChanged();
    expect(t.listCalls()).toBe(before + 1);

    // Closed to the tray: pushes read nothing, even when the count really changed.
    await t.show('hidden');
    before = t.listCalls();
    await t.pricesChanged();
    await t.pricesChanged();
    await t.b.rpc('prices.upsert', { sku: '5021;6', costScrap: 500, source: 'user' });
    await t.pricesChanged();
    expect(t.listCalls()).toBe(before);

    // Shown again: one catch-up read, and the badge is current.
    await t.show('visible');
    expect(t.listCalls()).toBe(before + 1);
    expect(t.badge()).toBe(String(start + 1));
  });

  it('is wired with useVisiblePush (static)', () => {
    const app = readFileSync(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain("useVisiblePush('prices.changed', recountPrices)");
    expect(app).not.toMatch(/usePush\('prices\.changed'/);
  });
});
