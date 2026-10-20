// 0.7.3 (audit rmarket-3): a refused "Refresh from backpack.tf" states its wait once, as the drawer's own live
// countdown (the service's and the mock's reasons carry no frozen number), and the message clears when the
// wait is over. A refusal without a wait stays until the next click. Rendered with react-dom/client into
// domShim.ts with the browser mock; nothing leaves the process.

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

/** Lets the mock answer and React render, then moves the fake clock on by `ms`. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
    if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
  });
}

/** The drawer of SKU; `refresh` answers 'item.refresh' in place of the mock when given. */
async function mount(refresh: (() => unknown) | null) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => Date.now() }));
  const local = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: ((m: string, p: unknown) => (m === 'item.refresh' && refresh ? Promise.resolve(refresh()) : b.rpc(m as 'item.detail', p as { sku: string }))) as FlipdeskBridge['rpc'],
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
  const row = () => container.descendants().find((e) => e.getAttribute('class') === 'refresh-row')!;
  const status = () => row().descendants().find((e) => e.getAttribute('role') === 'status')?.textContent ?? null;
  const click = async () => {
    const btn = row().descendants().find((e) => e.tagName === 'BUTTON' && (e.textContent ?? '').includes('Refresh from backpack.tf'))!;
    expect(btn.getAttribute('disabled')).toBeNull();
    act(() => {
      btn.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  return { b, status, click };
}

describe('a refused drawer refresh (rmarket-3)', () => {
  it('states the wait once, counts it down and clears when it is over', async () => {
    const t = await mount(() => ({ queued: false, reason: 'The snapshot rate limit is reached.', etaMs: 90_000 }));
    await t.click();
    expect(t.status()).toBe('The snapshot rate limit is reached. Try again in 1 min 30 s.');
    expect(t.status()!.match(/try again in/gi)).toHaveLength(1);
    await settle(30_000);
    expect(t.status()).toBe('The snapshot rate limit is reached. Try again in 1 min 00 s.');
    await settle(61_000);
    expect(t.status()).toBeNull();
  });

  it('keeps a refusal without a wait until the next click', async () => {
    const t = await mount(() => ({ queued: false, reason: 'The network is paused. Resume it from the top bar first.', etaMs: null }));
    await t.click();
    await settle(5 * 60_000);
    expect(t.status()).toBe('The network is paused. Resume it from the top bar first.');
  });

  it("the browser mock's refusal names the budget and leaves the wait to the countdown", async () => {
    const t = await mount(null);
    // The mock keeps only whether a token is set; its answer waits on the fake clock.
    const set = t.b.rpc('secrets.set', { name: 'bptfAccessToken', value: 'placeholder' });
    await settle();
    await set;
    await t.click();
    expect(t.status()).toMatch(/^Queued\./);
    await settle(3_000);
    await t.click();
    expect(t.status()).toBe('Snapshot budget is 1 request per 10 s. Try again in 7 s.');
    await settle(8_000);
    expect(t.status()).toBeNull();
  });
});
