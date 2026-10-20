// Audit rpagesB-1: the Journal form's When follows the clock until the user edits it. The page
// stays mounted for hours (left open, or the window closed to the tray), and a trade logged with
// When untouched must be dated when it is logged, not when the page mounted: the trade time drives
// FIFO order, "Held for" and the Profit toast's bought-since check. An edited When is a backfill
// and is sent as typed; a save puts the field back on the clock. Rendered with react-dom/client
// into the minimal DOM in domShim.ts, with the browser mock as the bridge. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { fromDateTimeLocal, toDateTimeLocal } from '../../src/renderer/format';
import type { JournalInput } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

/** A local 09:00, so the minute-truncated field value parses back to exactly T0. */
const T0 = new Date(2026, 9, 20, 9, 0, 0).getTime();
const HOUR = 3_600_000;

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

let clock = T0;
beforeEach(() => {
  clock = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    byId,
    fire,
    type,
    when: () => (byId('jf-when') as unknown as { value: string }).value,
    /** Picks the item and price, then submits; the When field is left as it is. */
    logBuy: async () => {
      await type('jf-item', '194;11');
      await type('jf-price', '1.33');
      fire(form(), 'submit', { bubbles: true, cancelable: true });
      await settle();
    },
    adds: () => rpc.mock.calls.filter((c) => c[0] === 'journal.add').map((c) => c[1] as JournalInput),
  };
}

describe('Journal form When (audit rpagesB-1)', () => {
  it('dates a trade logged with When untouched at the moment it is logged, to the millisecond', async () => {
    const t = await mount();
    expect(t.when()).toBe(toDateTimeLocal(T0));
    // Hours later, the form still mounted (page left open or window closed to the tray).
    clock = T0 + 6 * HOUR + 17_000;
    await t.logBuy();
    expect(t.adds()).toHaveLength(1);
    expect(t.adds()[0]!.ts).toBe(T0 + 6 * HOUR + 17_000);
  });

  it('shows the current time while untouched, and holds still while the field has focus', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = await mount();
    expect(t.when()).toBe(toDateTimeLocal(T0));
    clock = T0 + 2 * HOUR + 5 * 60_000;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(t.when()).toBe(toDateTimeLocal(clock));

    // While the user edits a segment the value must not change under them.
    t.fire(t.byId('jf-when'), 'focusin', { bubbles: true });
    const shown = t.when();
    clock += HOUR;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(t.when()).toBe(shown);
    t.fire(t.byId('jf-when'), 'focusout', { bubbles: true });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(t.when()).toBe(toDateTimeLocal(clock));
  });

  it('sends an edited When as typed (a backfill), then follows the clock again after the save', async () => {
    const t = await mount();
    clock = T0 + HOUR;
    await t.type('jf-when', '2026-10-19T08:30');
    expect(t.when()).toBe('2026-10-19T08:30');
    clock = T0 + 2 * HOUR;
    await t.logBuy();
    expect(t.adds()).toHaveLength(1);
    expect(t.adds()[0]!.ts).toBe(fromDateTimeLocal('2026-10-19T08:30'));

    // The save resets When: the next trade, field untouched, is dated when it is logged.
    clock = T0 + 3 * HOUR + 42_000;
    await t.logBuy();
    expect(t.adds()).toHaveLength(2);
    expect(t.adds()[1]!.ts).toBe(T0 + 3 * HOUR + 42_000);
  });
});
