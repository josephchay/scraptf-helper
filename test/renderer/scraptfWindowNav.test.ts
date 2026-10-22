// F21, the dashboard's nav item "scrap.tf window": shown right under "scrap.tf banks" only while the user
// has the opt-in window on; not a route but a button that asks main to open or focus the window, on a
// click only. The real App root against the browser mock, in the minimal DOM of domShim.ts.

import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import { SCRAPTF_WINDOW_OFF } from '../../src/shared/scraptfWindowPolicy';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const app = readFileSync(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');

describe('wiring (static)', () => {
  it('is no route: NAV keeps its entries, and the item is a button after the banks', () => {
    expect(app).not.toMatch(/\{ id: '[a-z]*window[a-z]*'/i);
    expect(app).toContain("{n.id === 'banks' && scraptfWindowOn(settings) ? <ScraptfWindowNavItem /> : null}");
    expect(app).toContain("rpc('scraptfWindow.open').catch(");
    expect(app).toContain('<button type="button" className="nav-link nav-window"');
    // Named in the icon-only nav too, where the label is hidden and the title is a sentence.
    expect(app).toContain('className="nav-link nav-window" aria-label={SCRAPTF_WINDOW_NAV_LABEL}');
  });
});

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let Root: typeof import('../../src/renderer/App').Root;
let createMockBridge: typeof import('../../src/renderer/mock').createMockBridge;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/banks' };
  const proto = ShimElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto['scrollTo'] !== 'function') proto['scrollTo'] = () => undefined;
  const html = doc.documentElement as unknown as Record<string, unknown>;
  if (!html['dataset']) html['dataset'] = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
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

async function mountApp(opts: { refuseOpen?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
  const calls: { method: string; params: unknown }[] = [];
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: (m, p) => {
      calls.push({ method: m, params: p });
      if (opts.refuseOpen && m === 'scraptfWindow.open') return Promise.reject(new Error(SCRAPTF_WINDOW_OFF));
      return b.rpc(m, p);
    },
    on: (e, fn) => b.on(e, fn),
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
  const all = () => container.descendants();
  const navItems = () => {
    const nav = all().find((e) => e.tagName === 'NAV' && e.getAttribute('aria-label') === 'Main')!;
    return nav.descendants().filter((e) => e.tagName === 'LI').map((li) => li.descendants().find((e) => e.tagName === 'A' || e.tagName === 'BUTTON')!);
  };
  const windowItem = () => navItems().find((e) => e.tagName === 'BUTTON');
  const turnOn = async () => {
    await act(async () => {
      await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: NOW }, scraptfWindow: { enabled: true, acknowledgedAt: NOW } });
    });
    await settle();
  };
  return { b, calls, all, navItems, windowItem, turnOn, text: () => container.textContent };
}

describe('the nav item', () => {
  it('is absent while the window is off, then sits right under scrap.tf banks', async () => {
    const t = await mountApp();
    expect(t.windowItem()).toBeUndefined();
    expect(t.text()).not.toContain('scrap.tf window');
    await t.turnOn();
    const items = t.navItems();
    const at = items.findIndex((e) => e.getAttribute('href') === '#/banks');
    expect(items[at + 1]!.tagName).toBe('BUTTON');
    expect(items[at + 1]!.textContent).toBe('scrap.tf window');
    expect(items[at + 2]!.getAttribute('href')).toBe('#/shopping');
    // Showing it moved nothing.
    expect(t.calls.filter((c) => c.method.startsWith('scraptfWindow.'))).toEqual([]);
  });

  it('opens (or focuses) the window on a click, with no page of its own', async () => {
    const t = await mountApp();
    await t.turnOn();
    act(() => {
      t.windowItem()!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(t.calls.filter((c) => c.method === 'scraptfWindow.open')).toEqual([{ method: 'scraptfWindow.open', params: undefined }]);
    expect((await t.b.rpc('scraptfWindow.state', undefined)).open).toBe(true);
    // Still on the banks page: a window, not a route.
    expect(win()['location']).toEqual({ hash: '#/banks' });
  });

  it("says so when main refuses", async () => {
    const t = await mountApp({ refuseOpen: true });
    await t.turnOn();
    act(() => {
      t.windowItem()!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(t.text()).toContain(`Could not open the scrap.tf window: ${SCRAPTF_WINDOW_OFF}`);
  });

  it('goes away when the window is turned off (import off turns it off too)', async () => {
    const t = await mountApp();
    await t.turnOn();
    expect(t.windowItem()).toBeDefined();
    await act(async () => {
      await t.b.rpc('settings.set', { import: { enabled: false } });
    });
    await settle();
    expect(t.windowItem()).toBeUndefined();
  });
});
