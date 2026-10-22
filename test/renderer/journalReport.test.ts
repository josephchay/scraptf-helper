// 0.8 (J3, J6, write-offs) the Journal page, rendered with react-dom/client into the minimal DOM in domShim.ts with
// the browser mock as the app bridge (journalPage.test.ts's mount pattern): the Results report and the stat cards
// from the seeded ledger, regrouping by Week or Venues with no RPC, each row's P/L and side pill, editing a row's
// fee with Undo (one journal.update each, the page refreshed once through the push), and Still holding's
// Write off…, which writes a row that receives nothing. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { JournalInput } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let JournalPage: () => ReactNode;
let ToastStack: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  // What AppProvider reads beyond the shim: the hash route and the theme attributes on <html>.
  win()['location'] = { hash: '#/journal' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ JournalPage } = await import('../../src/renderer/pages/JournalPage'));
  ({ ToastStack } = await import('../../src/renderer/components/Feedback'));
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

const cls = (e: ShimElement) => e.getAttribute('class') ?? '';

async function mount() {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(JournalPage), createElement(ToastStack))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const calls = (method: string) => rpc.mock.calls.filter((c) => c[0] === method);
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
  const section = (labelledBy: string) => container.descendants().find((e) => e.tagName === 'SECTION' && e.getAttribute('aria-labelledby') === labelledBy);
  const dialog = () => doc.body.descendants().find((e) => e.getAttribute('role') === 'dialog');
  const dialogTitle = () => doc.getElementById(dialog()!.getAttribute('aria-labelledby')!)!.textContent;
  const type = async (input: ShimElement, text: string) => {
    // React's change detection reads the input's type property, which the minimal DOM leaves unset.
    (input as unknown as { type: string; value: string }).type = 'text';
    (input as unknown as { value: string }).value = text;
    fire(input, 'input');
    await settle();
  };
  const submitDialog = async () => {
    fire(dialog()!.descendants().find((e) => e.tagName === 'FORM')!, 'submit');
    await settle();
  };
  const tradeRow = (pred: (tr: ShimElement) => boolean) =>
    section('journal-list-title')!
      .descendants()
      .filter((e) => e.tagName === 'TR' && (e.parentNode as ShimElement | null)?.tagName === 'TBODY')
      .find(pred);
  return { b, rpc, calls, fire, section, dialog, dialogTitle, type, submitDialog, tradeRow, container };
}

describe('Journal page Results (J3)', () => {
  it('renders the report from the seeded ledger, and Week and Venues regroup it with no RPC', async () => {
    const t = await mount();
    const results = t.section('results-title')!;
    expect(results).toBeDefined();
    const head = () => results.descendants().find((e) => e.tagName === 'TH')!.textContent;
    const bodyRows = () => results.descendants().filter((e) => e.tagName === 'TR' && (e.parentNode as ShimElement | null)?.tagName === 'TBODY');
    expect(head()).toBe('Month');
    expect(bodyRows().length).toBeGreaterThan(0);
    expect(results.textContent).toContain("Profit is booked at each sale's key price.");

    const before = t.rpc.mock.calls.length;
    const option = (label: string) => results.descendants().find((e) => e.getAttribute('role') === 'radio' && e.textContent === label)!;
    t.fire(option('Week'), 'click');
    await settle();
    expect(head()).toBe('Week');
    expect(bodyRows()[0]!.textContent).toMatch(/^Week of \d{4}-\d{2}-\d{2}/);
    t.fire(option('Venues'), 'click');
    await settle();
    expect(head()).toBe('Bought on → sold on');
    expect(bodyRows().map((r) => r.descendants().find((e) => e.tagName === 'TD')!.textContent)).toContain('scrap.tf → Written off');
    expect(t.rpc.mock.calls.length).toBe(before);
  });

  it('shows the rates from five closed flips, the write-off counted, and the losing flips', async () => {
    const t = await mount();
    const stat = (label: string) => t.container.descendants().find((e) => cls(e).split(' ').includes('stat') && e.descendants().some((c) => cls(c) === 'stat-label' && c.textContent === label))!;
    // Four flips made money and one (the write-off) lost: 80%, no longer muted.
    expect(stat('Win rate').descendants().find((e) => cls(e) === 'stat-value')!.textContent).toBe('80%');
    expect(cls(stat('Win rate'))).not.toContain('stat-few');
    expect(stat('Completed flips').textContent).toContain('incl. 1 written off');
    expect(stat('ROI')).toBeDefined();
    expect(stat('Hold time')).toBeDefined();
    const losses = t.section('losses-title')!;
    expect(losses.textContent).toContain('Losing flips');
    expect(losses.descendants().find((e) => cls(e) === 'count-badge')!.textContent).toBe('1');
    expect(losses.textContent).toContain('Ghastly Gibus');
    expect(losses.textContent).toContain('written off');
  });
});

describe('Journal page trades (J3, J6, write-offs)', () => {
  it("shows a sale's signed P/L, and a write-off's pill with no price", async () => {
    const t = await mount();
    const sale = t.tradeRow((tr) => tr.textContent.includes('Team Captain') && tr.textContent.includes('Sell'))!;
    const pnl = sale.descendants().find((e) => e.tagName === 'TD' && cls(e).includes('journal-pnl'))!;
    // Bought for 1 key 14 ref, sold for 1 key 22 ref: +8 ref, booked at the sale's key price.
    expect(pnl.textContent).toBe('+8.00 ref');
    expect(pnl.descendants().find((e) => cls(e).includes('money'))!.getAttribute('title')).toMatch(/^Closed the buy of .* on scrap\.tf/);
    const writeoff = t.tradeRow((tr) => tr.textContent.includes('Ghastly Gibus') && tr.textContent.includes('Write-off'))!;
    expect(writeoff.descendants().find((e) => cls(e).includes('pill'))!.textContent).toBe('Write-off');
    expect(writeoff.descendants().filter((e) => e.tagName === 'TD')[4]!.textContent).toBe('—');
    // The Mann Co. Cap sale recorded its fee.
    const cap = t.tradeRow((tr) => tr.textContent.includes('Mann Co. Cap') && tr.textContent.includes('Sell'))!;
    expect(cap.textContent).toContain('fee 0.22 ref');
  });

  it('Edit opens "Edit sale"; saving a fee calls journal.update once and the push refreshes the page once; Undo writes the old values', async () => {
    const t = await mount();
    const sale = t.tradeRow((tr) => tr.textContent.includes('Team Captain') && tr.textContent.includes('Sell'))!;
    const edit = sale.descendants().find((e) => e.tagName === 'BUTTON' && /^Edit trade \d+$/.test(e.getAttribute('aria-label') ?? ''))!;
    const id = Number(/(\d+)$/.exec(edit.getAttribute('aria-label')!)![1]);
    const original = (await t.b.rpc('journal.list', { limit: 2000 })).find((e) => e.id === id)!;
    t.fire(edit, 'click');
    await settle();
    expect(t.dialogTitle()).toBe('Edit sale');

    const lists = t.calls('journal.list').length;
    const sums = t.calls('journal.summary').length;
    const fee = t.dialog()!.descendants().find((e) => e.tagName === 'INPUT' && (e.getAttribute('id') ?? '').endsWith('-fee'))!;
    await t.type(fee, '0.22');
    await t.submitDialog();

    expect(t.calls('journal.update').map((c) => c[1])).toEqual([{ id, feeKeys: 0, feeScrap: 2 }]);
    expect(t.dialog()).toBeUndefined();
    expect(t.calls('journal.list').length - lists).toBe(1);
    expect(t.calls('journal.summary').length - sums).toBe(1);
    const pnl = t.tradeRow((tr) => tr.textContent.includes('Team Captain') && tr.textContent.includes('Sell'))!.descendants().find((e) => cls(e).includes('journal-pnl'))!;
    expect(pnl.textContent).toBe('+7.77 ref');

    const toast = doc.body.descendants().find((e) => cls(e).includes('toast ') && e.textContent.includes('Updated the sale of Team Captain.'))!;
    const undo = toast.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent === 'Undo')!;
    t.fire(undo, 'click');
    await settle();
    expect(t.calls('journal.update').map((c) => c[1])).toEqual([
      { id, feeKeys: 0, feeScrap: 2 },
      { id, venue: original.venue, note: original.note, feeKeys: null, feeScrap: null },
    ]);
    expect((await t.b.rpc('journal.list', { limit: 2000 })).find((e) => e.id === id)).toEqual(original);
  });

  it("Still holding's Write off… opens \"Write off\" and saves a row with keys 0 and scrap 0", async () => {
    const t = await mount();
    const holding = t.section('open-title')!;
    const button = holding.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent === 'Write off…')!;
    expect(button.getAttribute('title')).toMatch(/Nothing is sold or traded\.$/);
    t.fire(button, 'click');
    await settle();
    expect(t.dialogTitle()).toBe('Write off');
    await t.submitDialog();
    const adds = t.calls('journal.add').map((c) => c[1] as JournalInput);
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ side: 'writeoff', venue: 'Written off', keys: 0, scrap: 0 });
    expect(adds[0]).not.toHaveProperty('feeKeys');
    expect(adds[0]).not.toHaveProperty('feeScrap');
    const s = await t.b.rpc('journal.summary', undefined);
    expect(s.closed.filter((c) => c.kind === 'writeoff')).toHaveLength(2);
  });
});
