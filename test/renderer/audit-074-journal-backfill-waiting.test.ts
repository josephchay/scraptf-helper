// 0.7.4 (audit F39, F38) on the Journal page, rendered with react-dom/client into the minimal DOM in
// domShim.ts with the browser mock as the bridge (its journal FIFO mirrors the service's):
//  - F39: a When well in the past (a backfill) asks for the key price then, prefilled with today's, and the
//    trade is sent with it; an untouched When sends none (the service stamps today's).
//  - F38: a sale with no buy before it is listed under "Sales without a recorded buy" with the help text, and
//    a later buy of the item stays held instead of settling it.
// Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { fromDateTimeLocal, toDateTimeLocal } from '../../src/renderer/format';
import { waitingSalesText } from '../../src/renderer/recordTradeModel';
import type { JournalInput, JournalSummary } from '../../src/shared/types';
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
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  win()['location'] = { hash: '#/journal' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ JournalPage } = await import('../../src/renderer/pages/JournalPage'));
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => T0);
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(seed?: (b: MockBridge) => Promise<void>) {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  if (seed) await seed(b);
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
  const byId = (id: string) => doc.getElementById(id);
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, init));
    });
  const type = async (id: string, text: string) => {
    const input = byId(id)! as unknown as { type: string; value: string };
    input.type = 'text';
    input.value = text;
    fire(byId(id)!, 'input', { bubbles: true });
    await settle();
  };
  const form = () => container.descendants().find((e) => e.tagName === 'FORM' && (e.getAttribute('class') ?? '').includes('journal-form'))!;
  return {
    b,
    byId,
    type,
    text: () => container.textContent,
    button: (label: string) => container.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === label) ?? null,
    /** The waiting table's column headers ([] without the card). */
    waitingHeaders: () => {
      const card = container.descendants().find((e) => e.tagName === 'SECTION' && e.getAttribute('aria-labelledby') === 'waiting-sales-title');
      return card ? card.descendants().filter((e) => e.tagName === 'TH').map((e) => e.textContent.trim()) : [];
    },
    click: async (el: ShimElement) => {
      fire(el, 'click', { bubbles: true });
      await settle();
    },
    logBuy: async () => {
      await type('jf-item', '194;11');
      await type('jf-price', '1.33');
      fire(form(), 'submit', { bubbles: true, cancelable: true });
      await settle();
    },
    adds: () => rpc.mock.calls.filter((c) => c[0] === 'journal.add').map((c) => c[1] as JournalInput),
  };
}

describe('the Journal form and a backfilled trade (F39)', () => {
  it('asks for the key price then, and sends it with the trade', async () => {
    const t = await mount();
    expect(t.byId('jf-key')).toBeNull();
    await t.type('jf-when', toDateTimeLocal(T0 - 14 * 24 * HOUR));
    expect(t.byId('jf-key')).not.toBeNull();
    await t.type('jf-key', '60');
    await t.logBuy();
    expect(t.adds()).toHaveLength(1);
    expect(t.adds()[0]).toMatchObject({ ts: fromDateTimeLocal(toDateTimeLocal(T0 - 14 * 24 * HOUR)), keyPriceScrap: 540 });
    // The mock's journal.add stores it, as the service's does.
    const entry = (await t.b.rpc('journal.list', {})).find((e) => e.sku === '194;11' && e.ts === t.adds()[0]!.ts)!;
    expect(entry.keyPriceScrap).toBe(540);
  });

  it("sends today's key price for a backfill left empty, and none for a trade logged now", async () => {
    const t = await mount();
    await t.logBuy();
    expect(t.adds()[0]!).not.toHaveProperty('keyPriceScrap');
    await t.type('jf-when', toDateTimeLocal(T0 - 2 * HOUR));
    await t.logBuy();
    const today = (await t.b.rpc('status.get', undefined)).keyPrice?.valueScrap;
    expect(today).toBeGreaterThan(0);
    expect(t.adds()[1]).toMatchObject({ keyPriceScrap: today });
  });
});

describe('sales with no buy before them (F38)', () => {
  it('are listed with the help text, and a later buy of the item stays held', async () => {
    const t = await mount(async (b) => {
      await b.rpc('journal.add', { side: 'sell', venue: 'backpack.tf', sku: '5040;6', name: 'A Distinctive Lack of Hue', keys: 2, scrap: 198, ts: T0 - 7 * 24 * HOUR });
      await b.rpc('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '5040;6', name: 'A Distinctive Lack of Hue', keys: 1, scrap: 389, ts: T0 - HOUR });
    });
    const summary = (await t.b.rpc('journal.summary', undefined)) as JournalSummary;
    expect(summary.waitingSales.map((w) => w.sku)).toEqual(['5040;6']);
    expect(summary.open.map((p) => p.sku)).toContain('5040;6');
    expect(summary.bySku.map((r) => r.sku)).not.toContain('5040;6');
    expect(t.text()).toContain('Sales without a recorded buy');
    expect(t.text()).toContain(waitingSalesText(1));
    expect(t.button('Record its buy')).not.toBeNull();
    // Sales only: the amount column reads "Sold for", as in 0.7.4.
    expect(t.waitingHeaders()).toEqual(['When', 'Item', 'Sold for', 'Actions']);
  });

  it('0.8 review fix: a write-off with no buy before it is named as a write-off, never as a sale', async () => {
    const t = await mount(async (b) => {
      await b.rpc('journal.add', { side: 'writeoff', venue: 'Written off', sku: '5040;6', name: 'A Distinctive Lack of Hue', keys: 0, scrap: 0, ts: T0 - 7 * 24 * HOUR });
    });
    const summary = (await t.b.rpc('journal.summary', undefined)) as JournalSummary;
    expect(summary.waitingSales).toMatchObject([{ sku: '5040;6', writeoff: true }]);
    expect(summary.closed.length).toBeGreaterThan(0);
    const text = t.text();
    expect(text).toContain('Write-offs without a recorded buy');
    expect(text).toContain(waitingSalesText(0, 1)!);
    expect(text).toContain('1 write-off without a recorded buy is not counted.');
    expect(text).not.toContain('Sales without a recorded buy');
    expect(text).not.toContain('A sale in your journal');
    expect(text).not.toContain('sale without a recorded buy');
    expect(t.button('Record its buy')?.getAttribute('title')).toBe('Record the buy of the copy you wrote off, dated just before the write-off, so the two are matched');
    // Review fix: no "Sold for" column over a write-off.
    expect(t.waitingHeaders()).toEqual(['When', 'Item', 'Recorded as', 'Actions']);
  });

  it('0.8 review fix: a sale and a write-off waiting together head the amount column with both', async () => {
    const t = await mount(async (b) => {
      await b.rpc('journal.add', { side: 'sell', venue: 'backpack.tf', sku: '5040;6', name: 'A Distinctive Lack of Hue', keys: 2, scrap: 198, ts: T0 - 7 * 24 * HOUR });
      await b.rpc('journal.add', { side: 'writeoff', venue: 'Written off', sku: '5039;6', name: 'An Extraordinary Abundance of Tinge', keys: 0, scrap: 0, ts: T0 - 6 * 24 * HOUR });
    });
    expect(t.text()).toContain('Sales and write-offs without a recorded buy');
    expect(t.waitingHeaders()).toEqual(['When', 'Item', 'Sold for / written off', 'Actions']);
  });
});
