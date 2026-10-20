// 0.7.3 audit (rmarket-6): the Opportunities and Shopping summaries are polite live regions, and
// with the live feed on they reload on 'opps.changed' every 1.5 s. The transient " · updating" marker
// inside them is visual only (aria-hidden), so a screen reader is not interrupted on every reload;
// real changes to the counts are still announced. The page source, then each page mounted inside
// AppProvider into the minimal DOM of domShim.ts against the browser mock, with one reload held open.
// Nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import type { PushEvent } from '../../src/shared/rpc';
import { installDomShim, ShimElement, ShimNode, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/pages/${rel}`, import.meta.url), 'utf8');

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let OpportunitiesPage: () => ReactNode;
let ShoppingPage: () => ReactNode;
let createMockBridge: typeof import('../../src/renderer/mock').createMockBridge;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  const proto = ShimElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto['scrollTo'] !== 'function') proto['scrollTo'] = () => undefined;
  const html = doc.documentElement as unknown as Record<string, unknown>;
  if (!html['dataset']) html['dataset'] = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ OpportunitiesPage } = await import('../../src/renderer/pages/OpportunitiesPage'));
  ({ ShoppingPage } = await import('../../src/renderer/pages/ShoppingPage'));
  ({ createMockBridge } = await import('../../src/renderer/mock'));
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
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Text a screen reader takes from the region: everything not under aria-hidden="true". */
function spokenText(n: ShimNode): string {
  if (n instanceof ShimElement && n.getAttribute('aria-hidden') === 'true') return '';
  if (!(n instanceof ShimElement)) return n.textContent;
  return n.childNodes.map(spokenText).join('');
}

async function mount(page: () => ReactNode, hash: string, listMethod: 'opps.list' | 'shopping.list') {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash };
  // No simulated feed ticks: the only pushes are the test's own.
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
  let hold = false;
  let release: (() => void) | null = null;
  const real = b.rpc.bind(b);
  b.rpc = (async (method: string, params: unknown) => {
    if (method === listMethod && hold) {
      hold = false;
      await new Promise<void>((r) => (release = r));
    }
    return real(method as never, params as never);
  }) as typeof b.rpc;
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(page))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const region = () => container.descendants().find((e) => e.className.split(' ').includes('summary-stats'))!;
  const reloadHeld = async () => {
    hold = true;
    act(() => {
      for (const fn of [...(listeners.get('opps.changed') ?? [])]) fn({ appeared: 0, changed: 1, gone: 0, at: NOW });
    });
    await settle();
    expect(release).not.toBeNull();
  };
  const finish = async () => {
    release?.();
    await settle();
  };
  return { region, reloadHeld, finish };
}

describe('the summary live regions (rmarket-6)', () => {
  it('mark " · updating" visual only in the source, and stay polite live regions', () => {
    for (const rel of ['OpportunitiesPage.tsx', 'ShoppingPage.tsx']) {
      const src = read(rel);
      expect(src).toContain('<div className="summary-stats" aria-live="polite">');
      expect(src).toMatch(/<span className="muted small" aria-hidden="true"> · updating<\/span>/);
      expect(src).not.toMatch(/<span className="muted small"> · updating<\/span>/);
    }
  });

  for (const [name, page, hash, method] of [
    ['Opportunities', () => OpportunitiesPage, '#/opportunities', 'opps.list'],
    ['Shopping', () => ShoppingPage, '#/shopping', 'shopping.list'],
  ] as const) {
    it(`${name}: a live reload shows the marker but does not change what the region says`, async () => {
      const t = await mount(page(), hash, method);
      const r0 = t.region();
      expect(r0.getAttribute('aria-live')).toBe('polite');
      const idle = spokenText(r0);
      expect(idle).not.toContain('Loading');
      expect(idle).not.toContain('updating');

      await t.reloadHeld();
      const r = t.region();
      expect(r.textContent).toContain('updating');
      const marker = r.descendants().find((e) => e.textContent.includes('updating') && e.tagName === 'SPAN' && e.childNodes.every((c) => !(c instanceof ShimElement)))!;
      expect(marker.getAttribute('aria-hidden')).toBe('true');
      expect(spokenText(r)).toBe(idle);

      await t.finish();
      expect(t.region().textContent).not.toContain('updating');
      expect(spokenText(t.region())).toBe(idle);
    });
  }
});
