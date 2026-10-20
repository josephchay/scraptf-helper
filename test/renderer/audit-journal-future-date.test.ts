// Audit rpagesB-3: the Journal form refuses a trade dated in the future, as the Record trade dialog
// does (recordTradeModel FUTURE_SLACK_MS). A mistyped year (2062 for 2026) on a scrap.tf buy would
// otherwise mute that item's Profit toasts until then, pin the row to the top of the journal and
// read "Held for: now". A few minutes ahead (clock skew) and any past date (a backfill) still save.
// Rendered with react-dom/client into the minimal DOM in domShim.ts, with the browser mock as the
// bridge. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { fromDateTimeLocal, toDateTimeLocal } from '../../src/renderer/format';
import type { JournalInput } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const DAY = 86_400_000;

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let JournalPage: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import. Declaring `oninput` makes it use
  // native input events for onChange, as in a browser.
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
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
  // The form reads the real clock, so the mock's journal is seeded around it too.
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0 }));
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
  const byId = (id: string) => doc.getElementById(id)!;
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, init));
    });
  const type = async (id: string, text: string) => {
    const input = byId(id) as unknown as { type: string; value: string };
    // React's change detection reads the input's type property, which the minimal DOM leaves unset.
    input.type = 'text';
    input.value = text;
    fire(byId(id), 'input', { bubbles: true });
    await settle();
  };
  const form = () => container.descendants().find((e) => e.tagName === 'FORM' && (e.getAttribute('class') ?? '').includes('journal-form'))!;
  return {
    b,
    byId,
    form,
    alert: () => form().descendants().find((e) => e.getAttribute('role') === 'alert')?.textContent ?? null,
    /** Logs a buy dated `when` (a datetime-local value). */
    logBuyAt: async (when: string) => {
      await type('jf-item', '194;11');
      await type('jf-price', '1.33');
      await type('jf-when', when);
      fire(form(), 'submit', { bubbles: true, cancelable: true });
      await settle();
    },
    adds: () => rpc.mock.calls.filter((c) => c[0] === 'journal.add').map((c) => c[1] as JournalInput),
  };
}

describe('Journal form future dates (audit rpagesB-3)', () => {
  it('caps the date picker at now and leaves the check to the page, not the browser bubble', async () => {
    const before = Date.now();
    const t = await mount();
    const max = t.byId('jf-when').getAttribute('max');
    expect(max).not.toBeNull();
    expect([toDateTimeLocal(before), toDateTimeLocal(Date.now())]).toContain(max);
    expect(t.form().getAttribute('novalidate')).not.toBeNull();
  });

  it.each([
    ['two days ahead', () => toDateTimeLocal(Date.now() + 2 * DAY)],
    ['a mistyped year', () => toDateTimeLocal(new Date(Date.now()).setFullYear(2062))],
  ])('refuses a trade dated %s and says why', async (_label, when) => {
    const t = await mount();
    await t.logBuyAt(when());
    expect(t.alert()).toBe('That date is in the future.');
    expect(t.adds()).toHaveLength(0);
    const now = Date.now();
    expect((await t.b.rpc('journal.list', { limit: 2000 })).filter((e) => e.ts > now)).toEqual([]);
  });

  it('saves a trade a minute ahead (clock skew), as typed', async () => {
    const t = await mount();
    const when = toDateTimeLocal(Date.now() + 60_000);
    await t.logBuyAt(when);
    expect(t.alert()).toBeNull();
    expect(t.adds()).toHaveLength(1);
    expect(t.adds()[0]!.ts).toBe(fromDateTimeLocal(when));
  });

  it('saves a backfilled trade from yesterday, as typed', async () => {
    const t = await mount();
    const when = toDateTimeLocal(Date.now() - DAY);
    await t.logBuyAt(when);
    expect(t.alert()).toBeNull();
    expect(t.adds()).toHaveLength(1);
    expect(t.adds()[0]!.ts).toBe(fromDateTimeLocal(when));
  });
});
