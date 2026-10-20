// 0.7.3 (audit rpagesA-1): an imported price corrected on the Prices page is a typed price from then on
// (as the drawer's form saves it), so the next save of its scrap.tf page never rewrites or deletes the hand
// edit and its note. It keeps its batch id and reads no bank. "Mark as seen now" changes no price and keeps
// the row's source. Rendered with react-dom/client into domShim.ts with the browser mock; nothing leaves
// the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { ScrapPrice } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let PricesPage: typeof import('../../src/renderer/pages/PricesPage');

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/prices' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  PricesPage = await import('../../src/renderer/pages/PricesPage');
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(node: (b: MockBridge) => ReactNode) {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, node(b))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const upserts = () => rpc.mock.calls.filter((c) => c[0] === 'prices.upsert').map((c) => c[1] as Record<string, unknown>);
  return { b, container, upserts };
}

async function importedRow(): Promise<ScrapPrice> {
  const probe = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  try {
    const p = (await probe.rpc('prices.list', {})).find((x) => x.source === 'import' && x.bank && x.importBatch !== null);
    expect(p).toBeDefined();
    return p!;
  } finally {
    probe.dispose();
  }
}

describe("the Prices page's form on an imported price (rpagesA-1)", () => {
  it('saves the hand edit as a typed price that keeps its batch id and reads no bank', async () => {
    const editing = await importedRow();
    const saved: ScrapPrice[] = [];
    const t = await mount(() => createElement(PricesPage.PriceForm, { editing, onSaved: (p: ScrapPrice) => saved.push(p) }));
    const form = t.container.descendants().find((e) => e.tagName === 'FORM')!;
    act(() => {
      form.dispatchEvent(new ShimEvent('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(t.upserts()).toHaveLength(1);
    expect(t.upserts()[0]).toMatchObject({ id: editing.id, sku: editing.sku, source: 'user' });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: editing.id, source: 'user', importBatch: editing.importBatch, bank: null });
  });

  it('"Mark as seen now" keeps the imported source', async () => {
    const editing = await importedRow();
    const t = await mount(() => createElement(PricesPage.PricesPage));
    const seen = t.container
      .descendants()
      .find((e: ShimElement) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === `Mark ${editing.name} as seen now`);
    expect(seen).toBeDefined();
    act(() => {
      seen!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(t.upserts().find((u) => u['id'] === editing.id)).toMatchObject({ source: 'import' });
  });
});
