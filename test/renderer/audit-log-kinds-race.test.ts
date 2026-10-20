// Audit rpagesB-7: on the Live log, a read started under the previous event-kind chips (a multi-page
// catch-up after 'opps.changed', or "Load older events") and answered after the user changed the chips
// must not add events of the kinds just filtered out. The real LogPage against the browser mock, with
// 'opps.events' answered from a test-owned list and held until the test releases each answer.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { EventQuery, OpportunityEvent, OpportunityEventKind } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const CYCLE: readonly OpportunityEventKind[] = ['appeared', 'changed', 'gone'];

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let LogPage: () => ReactNode;

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

function event(id: number, kind: OpportunityEventKind): OpportunityEvent {
  return {
    id,
    key: `378;6|price:${id}`,
    sku: '378;6',
    name: 'Team Captain',
    category: 'hats',
    kind,
    profitScrap: 10,
    costScrap: 100,
    revenueScrap: 110,
    confidence: 70,
    summary: `event ${id}`,
    ts: T0 - (10_000 - id) * 1000,
  };
}

interface Held {
  q: EventQuery;
  answer: OpportunityEvent[];
  resolve(v: OpportunityEvent[]): void;
}

/** Mounts the Live log with `initial` events; every 'opps.events' read waits for release(). */
async function mountLog(initial: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const source: OpportunityEvent[] = [];
  const add = (n: number) => {
    const from = source.length + 1;
    for (let id = from; id < from + n; id++) source.push(event(id, CYCLE[id % CYCLE.length]!));
  };
  add(initial);
  const held: Held[] = [];
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const pushes: (() => void)[] = [];
  const on = b.on.bind(b);
  b.on = ((name: string, listener: (p: unknown) => void) => {
    if (name === 'opps.changed') pushes.push(() => listener({ appeared: 1, changed: 0, gone: 0, at: Date.now() }));
    return on(name as never, listener as never);
  }) as typeof b.on;
  const real = b.rpc.bind(b);
  b.rpc = ((method: string, params: unknown) => {
    if (method !== 'opps.events') return real(method as never, params as never);
    const q = (params ?? {}) as EventQuery;
    // Answered from the list as it is when asked, newest first, like the service.
    const answer = source
      .filter((e) => (!q.kinds?.length || q.kinds.includes(e.kind)) && (q.beforeId === undefined || e.id < q.beforeId))
      .sort((x, y) => y.id - x.id)
      .slice(0, q.limit ?? 200);
    return new Promise<OpportunityEvent[]>((resolve) => held.push({ q, answer, resolve }));
  }) as typeof b.rpc;
  win()['location'] = { hash: '#/log' };
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(LogPage))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const all = () => container.descendants();
  const t = {
    held,
    add,
    content: () => container.textContent,
    button: (label: RegExp) => all().find((e) => e.tagName === 'BUTTON' && label.test(e.textContent)),
    rows: () => all().filter((e) => e.tagName === 'TR' && (e.getAttribute('class') ?? '').startsWith('kind-')),
    kinds: () => t.rows().map((r) => r.getAttribute('class')),
    firstSummary: () => t.rows()[0]?.descendants().find((c) => (c.getAttribute('class') ?? '') === 'summary-cell')?.textContent,
    pressed: () => all().filter((e) => e.getAttribute('aria-pressed') === 'true' && (e.parentElement as ShimElement | null)?.getAttribute('aria-label') === 'Event kinds').map((e) => e.textContent),
    newEvents: () => all().find((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '') === 'new-events'),
    push: async () => {
      act(() => pushes.forEach((p) => p()));
      await settle();
    },
    /** Answers the i-th read still held (0 = the oldest). */
    release: async (i = 0) => {
      const [h] = held.splice(i, 1);
      if (!h) throw new Error(`no held read at ${i}`);
      h.resolve(h.answer);
      await settle();
    },
  };
  // The first read of the page.
  expect(held.map((h) => h.q)).toEqual([{ limit: 300 }]);
  await t.release();
  return t;
}

const onlyAppeared = (kinds: (string | null)[]) => kinds.filter((k) => k !== 'kind-appeared');

describe('a kind chip clicked during a multi-page catch-up', () => {
  it('drops what the catch-up read under the previous kinds', async () => {
    const t = await mountLog(10);
    expect(t.rows()).toHaveLength(10);
    t.add(400);
    await t.push();
    expect(t.held.map((h) => h.q)).toEqual([{ limit: 300 }]);
    click(t.button(/^Appeared$/)!);
    await settle();
    expect(t.held.map((h) => h.q)).toEqual([{ limit: 300 }, { limit: 300, kinds: ['appeared'] }]);
    // Page 1 of the catch-up answers; it asks for page 2 under the previous (no) kinds.
    await t.release();
    expect(t.held.map((h) => h.q)).toEqual([{ limit: 300, kinds: ['appeared'] }, { limit: 300, beforeId: 111 }]);
    await t.release();
    await t.release();
    expect(t.held).toEqual([]);
    expect(t.rows().length).toBeGreaterThan(0);
    expect(onlyAppeared(t.kinds())).toEqual([]);
    expect(t.pressed()).toEqual(['Appeared']);
    expect(t.newEvents()).toBeUndefined();
  });

  it('paused: holds no event of the kinds filtered out as "new events"', async () => {
    const t = await mountLog(10);
    click(t.button(/Pause/)!);
    t.add(400);
    await t.push();
    click(t.button(/^Appeared$/)!);
    await settle();
    await t.release();
    await t.release();
    await t.release();
    expect(t.held).toEqual([]);
    const banner = t.newEvents();
    if (banner) {
      click(banner);
      await settle();
    }
    expect(t.rows().length).toBeGreaterThan(0);
    expect(onlyAppeared(t.kinds())).toEqual([]);
  });

  it('without a chip change, a multi-page catch-up still merges every new event and the next push continues from the newest', async () => {
    const t = await mountLog(10);
    t.add(400);
    await t.push();
    await t.release();
    expect(t.held.map((h) => h.q)).toEqual([{ limit: 300, beforeId: 111 }]);
    await t.release();
    expect(t.firstSummary()).toBe('event 410');
    // Past the 1 s throttle: the next push reads at once, one page (it knows event 410).
    vi.setSystemTime(T0 + 5000);
    t.add(5);
    await t.push();
    expect(t.held.map((h) => h.q)).toEqual([{ limit: 300 }]);
    await t.release();
    expect(t.held).toEqual([]);
    expect(t.firstSummary()).toBe('event 415');
    click(t.button(/^Show more$/)!);
    click(t.button(/^Show more$/)!);
    expect(t.rows()).toHaveLength(415);
  });
});

describe('a kind chip clicked while "Load older events" is loading', () => {
  it('drops the older page read under the previous kinds, and the button is not left loading', async () => {
    const t = await mountLog(400);
    expect(t.rows()).toHaveLength(200);
    click(t.button(/^Show more$/)!);
    click(t.button(/^Load older events$/)!);
    await settle();
    expect(t.held.map((h) => h.q)).toEqual([{ limit: 300, beforeId: 101 }]);
    click(t.button(/^Appeared$/)!);
    await settle();
    expect(t.held.map((h) => h.q)).toEqual([{ limit: 300, beforeId: 101 }, { limit: 300, kinds: ['appeared'] }]);
    // The new view's read answers first, then the older page.
    await t.release(1);
    await t.release(0);
    expect(t.rows().length).toBeGreaterThan(0);
    expect(onlyAppeared(t.kinds())).toEqual([]);
    expect(t.button(/Loading…/)).toBeUndefined();
  });
});
