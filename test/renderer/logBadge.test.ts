// The Live log's nav badge (App.tsx) counts opportunity events the user has not seen. From F20 the Live
// log has two tabs, and only the opportunity events tab (#/log) shows those events, so only it clears
// the badge: the "scrap.tf changes" tab (#/log/changes) leaves the count alone and keeps counting.
// The real App root against the browser mock, in the minimal DOM of domShim.ts; the 'opps.changed'
// pushes are played by hand. Nothing leaves the process.

import { act, createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import type { PushContract, PushEvent } from '../../src/shared/rpc';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let Root: typeof import('../../src/renderer/App').Root;
let createMockBridge: typeof import('../../src/renderer/mock').createMockBridge;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;
const hashListeners = new Set<() => void>();

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/log' };
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
  win()['addEventListener'] = (type: string, fn: () => void) => {
    if (type === 'hashchange') hashListeners.add(fn);
  };
  win()['removeEventListener'] = (type: string, fn: () => void) => {
    if (type === 'hashchange') hashListeners.delete(fn);
  };
  ({ createRoot } = await import('react-dom/client'));
  ({ Root } = await import('../../src/renderer/App'));
  ({ createMockBridge } = await import('../../src/renderer/mock'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  win()['location'] = { hash: '#/log' };
  hashListeners.clear();
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

async function mountApp(hash: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash };
  // No simulated feed ticks: the only 'opps.changed' pushes are the test's own.
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
  const listeners = new Map<PushEvent, Set<(p: unknown) => void>>();
  const on = b.on.bind(b);
  b.on = ((event: PushEvent, fn: (p: unknown) => void) => {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(fn);
    const off = on(event, fn as never);
    return () => {
      set.delete(fn);
      off();
    };
  }) as MockBridge['on'];
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(Root)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const oppsChanged = (p: Omit<PushContract['opps.changed'], 'at'>) =>
    act(() => {
      for (const fn of [...(listeners.get('opps.changed') ?? [])]) fn({ ...p, at: NOW });
    });
  const go = async (next: string) => {
    win()['location'] = { hash: next };
    act(() => {
      for (const fn of [...hashListeners]) fn();
    });
    await settle();
  };
  /** The Live log nav entry's count, or null without one. */
  const badge = () => {
    const link = container.descendants().find((e) => e.tagName === 'A' && e.getAttribute('href') === '#/log');
    const count = link?.descendants().find((e) => (e.getAttribute('class') ?? '').split(' ').includes('nav-count'));
    return count ? count.textContent : null;
  };
  return { oppsChanged, go, badge };
}

describe('the Live log badge and its two tabs (F20)', () => {
  it('keeps counting on the scrap.tf changes tab and clears only on the opportunity events tab', async () => {
    const t = await mountApp('#/log/changes');
    expect(t.badge()).toBeNull();
    // The changes tab does not show opportunity events: they count as unseen.
    t.oppsChanged({ appeared: 2, changed: 1, gone: 0 });
    expect(t.badge()).toBe('3');
    // Elsewhere they count too, and coming back to the changes tab clears nothing.
    await t.go('#/market');
    t.oppsChanged({ appeared: 0, changed: 0, gone: 1 });
    expect(t.badge()).toBe('4');
    await t.go('#/log/changes');
    expect(t.badge()).toBe('4');
    // The opportunity events tab shows them: the badge clears, and stays clear while it is open.
    await t.go('#/log');
    expect(t.badge()).toBeNull();
    t.oppsChanged({ appeared: 1, changed: 0, gone: 0 });
    expect(t.badge()).toBeNull();
    // Switching to the changes tab starts a new count.
    await t.go('#/log/changes');
    t.oppsChanged({ appeared: 1, changed: 0, gone: 0 });
    expect(t.badge()).toBe('1');
  });
});
