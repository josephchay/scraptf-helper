// UX-4 (0.7.1): a first run is told the quickest way in first. The setup checklist's "first price" step and
// the empty Opportunities page lead with "Save scrap.tf/items once to price every item scrap.tf trades"
// (and, with the opt-in window on, "or browse it in the Flip Desk window"); its button opens the Import
// page's price-list card, and Quick entry and the price sheet stay as the other ways. The checklist is
// mounted with react-dom/client into the minimal DOM in domShim.ts against the browser mock (with no
// price of the user's yet); the empty Opportunities page is checked statically. Nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { FIRST_PRICE_LEAD, firstPriceText } from '../../src/renderer/scraptfListModel';
import { SCRAPTF_BOUNDARY_SHORT } from '../../src/shared/boundaryText';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let SetupChecklist: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ SetupChecklist } = await import('../../src/renderer/components/SetupChecklist'));
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
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountChecklist(opts: { windowOn?: boolean } = {}) {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const location = { hash: '#/opportunities' };
  win()['location'] = location;
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  if (opts.windowOn) await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 }, scraptfWindow: { enabled: true, acknowledgedAt: T0 } });
  // A first run: no price and no rule of the user's yet.
  const real = b.rpc.bind(b);
  b.rpc = (async (method: string, params: unknown) => {
    const r = await real(method as never, params as never);
    return method === 'status.get' ? { ...(r as object), setupNeeded: ['first-price'] } : r;
  }) as typeof b.rpc;
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(SetupChecklist))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const buttons = () => container.descendants().filter((e) => e.tagName === 'BUTTON');
  const fire = (target: ShimElement) =>
    act(() => {
      target.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
  return { location, content: () => container.textContent, buttons, fire };
}

describe('the setup checklist (UX-4)', () => {
  it('leads the first price with one save of scrap.tf/items, typing after it', async () => {
    const t = await mountChecklist();
    expect(t.content()).toContain('Add your first scrap.tf prices');
    expect(t.content()).toContain(`${firstPriceText(false)} Or type a price you see, or add a price-sheet rule for a whole category.`);
    expect(t.content()).not.toContain('Flip Desk window');
    expect(t.content()).toContain(SCRAPTF_BOUNDARY_SHORT);
    const labels = t.buttons().map((b) => b.textContent);
    expect(labels.slice(labels.indexOf('Save scrap.tf/items'))).toEqual(['Save scrap.tf/items', 'Quick entry', 'Price sheet']);
    // It opens the Import page, whose price-list card says how.
    t.fire(t.buttons().find((b) => b.textContent === 'Save scrap.tf/items')!);
    expect(t.location.hash).toBe('#/import');
  });

  it('names the Flip Desk window as the other way in while it is on', async () => {
    const t = await mountChecklist({ windowOn: true });
    expect(t.content()).toContain(firstPriceText(true));
    expect(firstPriceText(true)).toContain('or browse it in the Flip Desk window');
  });
});

describe('the empty Opportunities page (UX-4)', () => {
  const page = read('pages/OpportunitiesPage.tsx');

  it('leads with the same sentence and the Import page, Quick entry and the price sheet after it', () => {
    expect(page).toContain('{firstPriceText(scraptfWindowOn(settings))} Or type the prices you see (Quick entry)');
    const from = page.indexOf('if (firstPrice) {');
    const to = page.indexOf('if (paused && hiddenCount === 0) {');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const empty = page.slice(from, to);
    const order = ["navigate('import')", 'openQuick()', "navigate('prices')"].map((s) => empty.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(empty).toContain('className="btn primary" onClick={() => navigate(\'import\')}');
    expect(empty).toContain('Save scrap.tf/items');
    expect(FIRST_PRICE_LEAD).toBe('Save scrap.tf/items once to price every item scrap.tf trades');
  });
});
