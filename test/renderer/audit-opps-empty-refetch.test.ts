// 0.7.3 audit (rmarket-7): the empty Opportunities list used to re-read the whole price sheet
// ('prices.list') and every rule on each 'opps.changed' push (every 3 s with the live feed on) only to
// test for "no price and no enabled rule". It now reads the service's own flag for that,
// status.setupNeeded 'first-price', which 'status.changed' re-pushes after any price or rule write.
// OpportunitiesPage inside AppProvider, mounted into the minimal DOM of domShim.ts against the browser
// mock; 'opps.list' answers an empty page so the empty state shows. Nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import type { PushEvent } from '../../src/shared/rpc';
import type { AppStatus, OppListResult } from '../../src/shared/types';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let OpportunitiesPage: () => ReactNode;
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
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountPage(opts: { firstPrice?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash: '#/opportunities' };
  // No simulated feed ticks: the only pushes are the test's own.
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => Date.now() }));
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
  const calls = new Map<string, number>();
  let lastStatus: AppStatus | null = null;
  const real = b.rpc.bind(b);
  b.rpc = (async (method: string, params: unknown) => {
    calls.set(method, (calls.get(method) ?? 0) + 1);
    const r = await real(method as never, params as never);
    if (method === 'opps.list') return { ...(r as OppListResult), rows: [], total: 0, groups: [] };
    if (method === 'status.get') {
      lastStatus = r as AppStatus;
      if (opts.firstPrice) return { ...lastStatus, setupNeeded: [...lastStatus.setupNeeded.filter((c) => c !== 'first-price'), 'first-price'] };
    }
    return r;
  }) as typeof b.rpc;
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(OpportunitiesPage))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const emit = (event: PushEvent, payload: unknown) =>
    act(() => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
    });
  const count = (method: string) => calls.get(method) ?? 0;
  return { b, emit, count, status: () => lastStatus!, content: () => container.textContent };
}

describe('the empty Opportunities list (rmarket-7)', () => {
  it('does not re-read the price sheet or the rules on opps.changed', async () => {
    const t = await mountPage();
    expect(t.content()).toContain('Nothing is profitable right now');
    const prices = t.count('prices.list');
    const rules = t.count('rules.list');
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(Date.now() + 3001);
      t.emit('opps.changed', { appeared: 0, changed: 1, gone: 0, at: Date.now() });
      await settle();
    }
    expect(t.count('prices.list')).toBe(prices);
    expect(t.count('rules.list')).toBe(rules);
    expect(t.content()).toContain('Nothing is profitable right now');
  });

  it("follows the service's first-price flag, with no read of its own", async () => {
    const t = await mountPage({ firstPrice: true });
    expect(t.content()).toContain('Add the scrap.tf prices you want to check');
    expect(t.count('prices.list')).toBe(0);
    expect(t.count('rules.list')).toBe(0);
    // A price saved anywhere: the service re-pushes its status without the flag.
    t.emit('status.changed', { ...t.status(), setupNeeded: [] });
    await settle();
    expect(t.content()).not.toContain('Add the scrap.tf prices you want to check');
    expect(t.content()).toContain('Nothing is profitable right now');
    expect(t.count('prices.list')).toBe(0);
  });

  it('the browser mock flags first-price like the service: no price and no enabled rule', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
    for (const p of await b.rpc('prices.list', {})) await b.rpc('prices.delete', { id: p.id });
    for (const r of await b.rpc('rules.list', undefined)) await b.rpc('rules.delete', { id: r.id });
    await b.rpc('rules.upsert', { name: 'hats', filter: {}, costScrap: 16, enabled: false });
    expect((await b.rpc('status.get', undefined)).setupNeeded).toContain('first-price');
    const rule = await b.rpc('rules.upsert', { name: 'caps', filter: {}, costScrap: 16 });
    expect(rule.enabled).toBe(true);
    expect((await b.rpc('status.get', undefined)).setupNeeded).not.toContain('first-price');
  });

  it('reads nothing for the first-price test in its source', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/OpportunitiesPage.tsx', import.meta.url), 'utf8');
    const noResults = page.slice(page.indexOf('export function NoResults('));
    expect(noResults.length).toBeGreaterThan(0);
    expect(noResults).not.toContain("rpc('prices.list'");
    expect(noResults).not.toContain("rpc('rules.list'");
    expect(noResults).not.toContain("useVisiblePush('opps.changed'");
  });
});
