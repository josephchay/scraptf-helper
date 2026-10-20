// 0.7.3: Quick entry's preview for an item whose eligible buyers are all unusable (here every order
// an outlier): "Sells for" said "no eligible buy order" beside its own "3 buyers", and the pill said
// "No buyer". Rendered with react-dom/client into domShim.ts with the browser mock as the bridge;
// only item.detail's revenue is swapped. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { noRevenueText } from '../../src/renderer/quickModel';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import type { ItemDetail, ItemRevenue } from '../../src/shared/types';
import { installDomShim, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let QuickEntry: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  win()['location'] = { hash: '' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ QuickEntry } = await import('../../src/renderer/pages/QuickEntry'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
});

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

/** Past the preview's pick debounce (PREVIEW_DEBOUNCE_MS, a real timer). */
async function afterDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 220));
  });
  await settle();
}

/** The window with item.detail's revenue replaced by `revenue` (the rest is the mock's own answer). */
async function mount(revenue: ItemRevenue) {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const local = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'quick-entry',
    rpc: (async (m: string, p: unknown) => {
      const res = await b.rpc(m as never, p as never);
      if (m !== 'item.detail' || !res) return res;
      const d = res as ItemDetail;
      return { ...d, revenue };
    }) as FlipdeskBridge['rpc'],
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
  act(() => root.render(createElement(AppProvider, null, createElement(QuickEntry))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const all = () => container.descendants();
  const emit = <E extends PushEvent>(e: E, p: PushContract[E]) =>
    act(() => {
      for (const fn of local.get(e) ?? []) fn(p);
    });
  const cls = (e: ShimElement) => e.getAttribute('class') ?? '';
  return { all, emit, preview: () => all().find((e) => e.tagName === 'SECTION' && cls(e).includes('quick-preview')) ?? null };
}

/** Three eligible orders, every one an outlier (Conservative): what item.detail sends for the finding's case. */
const UNUSABLE: ItemRevenue = {
  bestScrap: 100,
  consScrap: null,
  instantScrap: null,
  useOrder: 'conservative',
  revenueScrap: null,
  order: null,
  maxCostScrap: null,
  eligibleCount: 3,
};

describe('Quick entry with eligible buyers none of which is usable', () => {
  it('says "no usable buy order" (why on hover) and "No usable buyer", not "no eligible buy order" / "No buyer"', async () => {
    const t = await mount(UNUSABLE);
    t.emit('ui.quickPrefill', { sku: '378;6', price: '40 scrap' });
    await settle();
    await afterDebounce();
    const text = t.preview()?.textContent ?? '';
    expect(text).toContain('3 buyers');
    expect(text).toContain('no usable buy order');
    expect(text).not.toContain('no eligible buy order');
    expect(text).toContain('No usable buyer');
    const why = t.all().find((e) => e.tagName === 'SPAN' && e.textContent === 'no usable buy order');
    expect(why?.getAttribute('title')).toBe(noRevenueText({ eligibleCount: 3, useOrder: 'conservative' }));
  });

  it('still says "no eligible buy order" and "No buyer" when nothing is eligible', async () => {
    const t = await mount({ ...UNUSABLE, bestScrap: null, eligibleCount: 0 });
    t.emit('ui.quickPrefill', { sku: '378;6', price: '40 scrap' });
    await settle();
    await afterDebounce();
    const text = t.preview()?.textContent ?? '';
    expect(text).toContain('no eligible buy order');
    expect(text).toContain('0 buyers');
    expect(text).toMatch(/No buyer(?!s)/);
    expect(text).not.toContain('usable');
  });
});
