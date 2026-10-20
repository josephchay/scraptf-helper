// 0.7.3 (follow-up to bptfnet-1): item.scm throws on every failure now (a pause, a 429 lockout, an
// HTTP error), so a null answer only means the service found the Steam Market check turned off while
// the drawer still showed it. The drawer said "Steam Market lookups are off or paused."; it now says the
// check was turned off and nothing was read. Rendered with react-dom/client into domShim.ts with the
// browser mock as the bridge, item.scm answered by the test. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const SKU = '378;6';

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ItemDrawer: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
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
  win()['location'] = { hash: '' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ ItemDrawer } = await import('../../src/renderer/pages/ItemDrawer'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.useRealTimers();
});

async function settle(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

/** The drawer of SKU with the Steam Market check on; `scm` answers item.scm. */
async function mount(scm: () => unknown) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  await b.rpc('settings.set', { connectors: { scm: true } });
  const local = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: ((m: string, p: unknown) => (m === 'item.scm' ? Promise.resolve().then(scm) : b.rpc(m as never, p as never))) as FlipdeskBridge['rpc'],
    on: (e, fn) => {
      const set = local.get(e) ?? new Set();
      local.set(e, set);
      const f = fn as (p: unknown) => void;
      set.add(f);
      const off = b.on(e, fn);
      return () => {
        set.delete(f);
        off();
      };
    },
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(ItemDrawer))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const emit = <E extends PushEvent>(e: E, p: PushContract[E]) =>
    act(() => {
      for (const fn of local.get(e) ?? []) fn(p);
    });
  emit('ui.openItem', { sku: SKU });
  await settle();
  const box = () => container.descendants().find((e) => e.getAttribute('class') === 'scm-check') ?? null;
  const check = async () => {
    const btn = box()?.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent.includes('Check Steam Market price'));
    expect(btn).toBeDefined();
    act(() => {
      btn!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  return { box, check };
}

describe("the drawer's Steam Market check", () => {
  it('a null answer says the check was turned off and nothing was read, not "off or paused"', async () => {
    const t = await mount(() => null);
    await t.check();
    const text = t.box()!.textContent;
    expect(text).toContain('Nothing was read: the Steam Community Market price check was turned off in Settings.');
    expect(text).not.toContain('paused');
  });

  it("a failure shows the service's error instead", async () => {
    const t = await mount(() => {
      throw new Error('Steam Market check failed (network paused). Nothing was read; try again later.');
    });
    await t.check();
    const text = t.box()!.textContent;
    expect(text).toContain('Steam Market check failed (network paused)');
    expect(text).not.toContain('turned off');
  });
});
