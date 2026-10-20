// Audit rpagesB-6: a failed first read on the Live log, the Journal and the Prices page shows the
// error, not an empty state that says there is nothing. On the Live log the error has a Retry, a
// later push that reads the events clears it, and no "Load older events" is left that does nothing.
// The real pages against the browser mock, in the minimal DOM of domShim.ts; the first read of the
// page's list is made to fail like a service restart wait. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const NOT_READY = 'The service is not ready (restarting); opps.events timed out';

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let LogPage: () => ReactNode;
let JournalPage: () => ReactNode;
let PricesPage: () => ReactNode;

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
  if (!Object.getOwnPropertyDescriptor(ShimElement.prototype, 'closest')) {
    Object.defineProperty(ShimElement.prototype, 'closest', {
      configurable: true,
      value(this: ShimElement, sel: string) {
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        for (let n: ShimElement | null = this; n; n = n.parentElement as ShimElement | null) {
          if (cls && (n.getAttribute('class') ?? '').split(' ').includes(cls)) return n;
        }
        return null;
      },
    });
  }
  win()['location'] = { hash: '#/log' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ LogPage } = await import('../../src/renderer/pages/LogPage'));
  ({ JournalPage } = await import('../../src/renderer/pages/JournalPage'));
  ({ PricesPage } = await import('../../src/renderer/pages/PricesPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  win()['location'] = { hash: '#/log' };
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

function click(target: ShimElement) {
  act(() => {
    target.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
  });
}

/**
 * Mounts `page` at `hash`; the reads of `method` numbered in `failing` (1 = the first) reject as in a
 * restart wait. 'opps.changed' listeners are kept so the test can push.
 */
async function mount(page: () => ReactNode, hash: string, method: string, failing: number[]) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash };
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const pushes: (() => void)[] = [];
  const on = b.on.bind(b);
  b.on = ((event: string, listener: (p: unknown) => void) => {
    if (event === 'opps.changed') pushes.push(() => listener({ appeared: 1, changed: 0, gone: 0, at: T0 }));
    return on(event as never, listener as never);
  }) as typeof b.on;
  const real = b.rpc.bind(b);
  let n = 0;
  b.rpc = (async (m: string, params: unknown) => {
    if (m === method && failing.includes(++n)) throw new Error(NOT_READY);
    return real(m as never, params as never);
  }) as typeof b.rpc;
  const rpc = vi.spyOn(b, 'rpc');
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
  const all = () => container.descendants();
  return {
    b,
    calls: (m: string) => rpc.mock.calls.filter((c) => c[0] === m).map((c) => c[1]),
    all,
    content: () => container.textContent,
    alert: () => all().find((e) => e.getAttribute('role') === 'alert'),
    button: (label: RegExp, within?: ShimElement) => (within ? within.descendants() : all()).find((e) => e.tagName === 'BUTTON' && label.test(e.textContent)),
    rows: () => all().filter((e) => e.tagName === 'TR' && (e.getAttribute('class') ?? '').startsWith('kind-')),
    push: () => act(() => pushes.forEach((p) => p())),
  };
}

describe('Live log: a failed first read of the events', () => {
  it('shows the error with a Retry, not "No events yet" or a "Load older events" that does nothing; Retry loads them', async () => {
    const t = await mount(LogPage, '#/log', 'opps.events', [1]);
    expect(t.content()).toContain('Could not load the log');
    expect(t.content()).not.toContain('No events yet');
    expect(t.content()).not.toContain('Load older events');
    const retry = t.button(/^Retry$/, t.alert());
    expect(retry).toBeDefined();
    const before = t.calls('opps.events').length;
    click(retry!);
    await settle();
    expect(t.calls('opps.events').slice(before)).toEqual([{ limit: 300 }]);
    expect(t.alert()).toBeUndefined();
    expect(t.rows().length).toBeGreaterThan(0);
    // The mock holds fewer events than a page: everything is loaded.
    expect(t.content()).not.toContain('Load older events');
  });

  it('a later push that reads the events clears the error and leaves no "Load older events"', async () => {
    const t = await mount(LogPage, '#/log', 'opps.events', [1]);
    expect(t.content()).toContain('Could not load the log');
    t.push();
    await settle();
    expect(t.rows().length).toBeGreaterThan(0);
    expect(t.content()).not.toContain('Could not load the log');
    expect(t.content()).not.toContain('Load older events');
  });

  it("a failed read after a kind chip leaves none of the previous filter's rows under the error", async () => {
    const t = await mount(LogPage, '#/log', 'opps.events', [2]);
    expect(t.rows().some((r) => /kind-(appeared|changed)/.test(r.getAttribute('class') ?? ''))).toBe(true);
    click(t.button(/^Gone$/)!);
    await settle();
    expect(t.content()).toContain('Could not load the log');
    expect(t.rows().map((r) => r.getAttribute('class')).filter((c) => /kind-(appeared|changed|notified)/.test(c ?? ''))).toEqual([]);
    expect(t.content()).not.toContain('No events yet');
  });
});

describe('Journal: a failed first read of the trades', () => {
  it('shows the error with a Retry, not "No trades logged"; Retry shows the trades', async () => {
    const t = await mount(JournalPage, '#/journal', 'journal.list', [1]);
    expect(t.alert()?.textContent).toContain(NOT_READY);
    expect(t.content()).not.toContain('No trades logged');
    click(t.button(/^Retry$/, t.alert())!);
    await settle();
    expect(t.alert()).toBeUndefined();
    expect(t.all().some((e) => e.tagName === 'BUTTON' && /^Delete trade \d+$/.test(e.getAttribute('aria-label') ?? ''))).toBe(true);
  });
});

describe('Prices: a failed first read of the price sheet', () => {
  it('shows the error, not "No prices yet"', async () => {
    const t = await mount(PricesPage, '#/prices', 'prices.list', [1]);
    expect(t.alert()?.textContent).toContain(NOT_READY);
    expect(t.content()).not.toContain('No prices yet');
    click(t.button(/^Retry$/, t.alert())!);
    await settle();
    expect(t.alert()).toBeUndefined();
  });
});
