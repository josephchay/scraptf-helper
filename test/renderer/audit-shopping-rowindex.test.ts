// 0.7.3: the Shopping list grid renders only a window of its rows, so every row it does render says
// where it sits in the whole list (aria-rowindex), as the Live market and Opportunities grids do;
// otherwise a screen reader numbers rows by their place in the DOM ("row 3 of 1001" for item 400).
// The real page inside AppProvider against the browser mock, in the minimal DOM of domShim.ts, with
// 'shopping.list' answered by the test so the list can be long. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import { scraptfPageFor } from '../../src/shared/links';
import type { Category, ShoppingListResult, ShoppingRow } from '../../src/shared/types';
import { CATEGORY_LABELS } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const ROW_H = 38; // comfortable density, the default
const hasClass = (e: ShimElement, cls: string) => (e.getAttribute('class') ?? '').split(' ').includes(cls);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ShoppingPage: () => ReactNode;
let createMockBridge: typeof import('../../src/renderer/mock').createMockBridge;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
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

function row(category: Category, i: number): ShoppingRow {
  return {
    sku: `${1000 + i};6;${category}`,
    name: `${CATEGORY_LABELS[category]} item ${String(i).padStart(4, '0')}`,
    category,
    bankPageUrl: scraptfPageFor(category),
    maxCostScrap: 100 + i,
    revenueScrap: 150 + i,
    revenueOrder: null,
    confidence: 60,
    confidenceLevel: 'medium',
    buyerCount: 2,
    knownCostScrap: null,
    knownMaxCostScrap: null,
    underCeiling: null,
    inputKinds: ['rule'],
    flags: [],
    updatedAt: NOW - 60_000,
  };
}

/** A list answer: per category, the rows loaded and how many match in all. */
function answer(spec: { category: Category; loaded: number; count: number }[]): ShoppingListResult {
  const rows = spec.flatMap((s) => Array.from({ length: s.loaded }, (_, i) => row(s.category, i)));
  return {
    rows,
    total: spec.reduce((n, s) => n + s.count, 0),
    groups: spec.map((s) => ({ category: s.category, label: CATEGORY_LABELS[s.category], count: s.count, bankPageUrl: scraptfPageFor(s.category) })),
    keyPrice: null,
    generatedAt: NOW,
  };
}

async function mount(list: ShoppingListResult) {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash: '#/shopping' };
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
  const real = b.rpc.bind(b);
  b.rpc = (async (method: string, params: unknown) => {
    if (method === 'shopping.list') return list;
    return real(method as never, params as never);
  }) as typeof b.rpc;
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(ShoppingPage))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const grid = () => container.descendants().find((e) => e.getAttribute('role') === 'grid') as ShimElement;
  const rowEls = () => grid().descendants().filter((e) => e.getAttribute('role') === 'row');
  return { container, grid, rowEls };
}

describe('Shopping list grid row positions (aria-rowindex)', () => {
  it('numbers the header 1 and each row by its place in the whole list, for group, item and More rows', async () => {
    // Hats: two of five loaded (a More row follows); weapons: one of one.
    const t = await mount(
      answer([
        { category: 'hats', loaded: 2, count: 5 },
        { category: 'weapons', loaded: 1, count: 1 },
      ]),
    );
    const display = 1 + 2 + 1 + 1 + 1; // group, 2 items, More, group, item
    expect(t.grid().getAttribute('aria-rowcount')).toBe(String(display + 1));
    const all = t.rowEls();
    const head = all.find((e) => hasClass(e, 'opp-head'));
    expect(head?.getAttribute('aria-rowindex')).toBe('1');
    const body = all.filter((e) => e.id.startsWith('shoprow-'));
    expect(body).toHaveLength(display);
    for (const el of body) expect(el.getAttribute('aria-rowindex')).toBe(String(Number(el.id.slice('shoprow-'.length)) + 2));
    for (const kind of ['opp-group', 'opp-item', 'opp-more']) expect(body.some((el) => hasClass(el, kind))).toBe(true);
    expect(all.every((e) => e.getAttribute('aria-rowindex') !== null)).toBe(true);
  });

  it('scrolled deep into a long list, item 400 still says where it sits (the header is 1)', async () => {
    const t = await mount(answer([{ category: 'hats', loaded: 1000, count: 1000 }]));
    expect(t.grid().getAttribute('aria-rowcount')).toBe('1002');
    // Only a window of the 1001 rows is in the DOM, each with its position.
    expect(t.rowEls().length).toBeLessThan(1002);
    expect(t.rowEls().every((e) => e.getAttribute('aria-rowindex') !== null)).toBe(true);

    const grid = t.grid();
    grid.scrollTop = 400 * ROW_H;
    act(() => {
      grid.dispatchEvent(new ShimEvent('scroll'));
    });
    // The scroll handler reads the position on the next animation frame.
    await settle();
    expect(t.container.descendants().some((e) => e.id === 'shoprow-0')).toBe(false);
    const deep = t.container.descendants().find((e) => e.id === 'shoprow-400');
    expect(deep?.getAttribute('aria-rowindex')).toBe('402');
    expect(t.rowEls().every((e) => e.getAttribute('aria-rowindex') !== null)).toBe(true);
  });
});
