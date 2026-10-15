// The Journal page, rendered with react-dom/client into the minimal DOM in
// domShim.ts with the browser mock as the app bridge: a trade deleted on the
// page refreshes it once, through the 'journal.changed' push every journal
// write sends, not once more from the page itself (each refresh reads the whole
// journal and its FIFO summary). Nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let JournalPage: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  // What AppProvider reads beyond the shim: the hash route and the theme attributes on <html>.
  win()['location'] = { hash: '#/journal' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ JournalPage } = await import('../../src/renderer/pages/JournalPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
});

/** Lets the mock's zero-latency answers and pushes land and React render them. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount() {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(JournalPage))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const calls = (method: string) => rpc.mock.calls.filter((c) => c[0] === method).length;
  const click = (el: ShimElement) =>
    act(() => {
      el.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
  return { b, calls, click, container };
}

describe('JournalPage', () => {
  it('reads the journal once per trade deleted on the page: the push refreshes it, the page does not again', async () => {
    const t = await mount();
    const del = t.container.descendants().find((e) => e.tagName === 'BUTTON' && /^Delete trade \d+$/.test(e.getAttribute('aria-label') ?? ''));
    expect(del).toBeDefined();
    const id = Number(/(\d+)$/.exec(del!.getAttribute('aria-label')!)![1]);
    const lists = t.calls('journal.list');
    const sums = t.calls('journal.summary');
    expect(lists).toBeGreaterThan(0);

    // ConfirmButton: the first click arms it, the second deletes.
    t.click(del!);
    t.click(del!);
    await settle();

    expect(t.calls('journal.delete')).toBe(1);
    expect((await t.b.rpc('journal.list', { limit: 2000 })).some((e) => e.id === id)).toBe(false);
    // The extra list above is this test's own read.
    expect(t.calls('journal.list') - lists - 1).toBe(1);
    expect(t.calls('journal.summary') - sums).toBe(1);
  });

  it('leaves the refresh after Log a trade to the push too', () => {
    const src = readFileSync(new URL('../../src/renderer/pages/JournalPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain("useVisiblePush('journal.changed', reload)");
    expect(src).not.toMatch(/onSaved/);
    // No direct call besides the push's throttled one.
    expect(src).not.toMatch(/^\s*after\(\);/m);
  });
});
