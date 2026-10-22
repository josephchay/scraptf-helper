// 0.8 (G1/G3) "Your scrap.tf watches" on the Banks page, rendered with react-dom/client into the minimal DOM in
// domShim.ts with the browser mock as the app bridge: one 'watches.list' read lists every watch (paused ones with a
// Paused tag) with its copy, targets and where it stands; the name opens the item on the watched copy; Resume and
// Pause write the watch; Remove takes it off with Undo; the list re-reads on 'watches.changed'; an empty list says
// how to add one. It is on the Banks page. Nothing is opened, linked or bought.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { WATCHES_EMPTY, watchCopyText, watchesCountText, watchNowView, watchUndoInput } from '../../src/renderer/watchesModel';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import type { ScraptfWatch } from '../../src/shared/types';
import { watchTargetsText } from '../../src/shared/watches';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ToastStack: () => ReactNode;
let WatchesCard: typeof import('../../src/renderer/components/WatchesCard').WatchesCard;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  win()['location'] = { hash: '#/banks' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ ToastStack } = await import('../../src/renderer/components/Feedback'));
  ({ WatchesCard } = await import('../../src/renderer/components/WatchesCard'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.useRealTimers();
});

async function settle(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const cls = (e: ShimElement) => (e.getAttribute('class') ?? '').split(' ');

async function mount() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const calls: { method: string; params: unknown }[] = [];
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: (m, p) => {
      calls.push({ method: m, params: p });
      return b.rpc(m, p);
    },
    on: (e, fn) => b.on(e, fn),
  };
  win()['flipdesk'] = w;
  const onItem = vi.fn();
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(WatchesCard, { keyScrap: 600, now: T0, onItem }), createElement(ToastStack))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const fire = (target: ShimElement, type: string) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true }));
    });
  const card = () => container.descendants().find((e) => e.tagName === 'SECTION' && cls(e).includes('watches-card'))!;
  const rows = () => card().descendants().filter((e) => e.tagName === 'LI' && cls(e).includes('watch-row'));
  const button = (el: ShimElement, text: string) => el.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === text);
  const toasts = () => doc.body.descendants().filter((e) => cls(e).includes('toast'));
  const step = () => vi.setSystemTime(Date.now() + 5_000);
  const callsOf = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);
  return { b, onItem, fire, card, rows, button, toasts, step, callsOf };
}

describe('"Your scrap.tf watches" (WatchesCard)', () => {
  it('lists every watch with its copy, targets and where it stands, and a Paused tag', async () => {
    const t = await mount();
    const list = await t.b.rpc('watches.list', undefined);
    // One read of every watch (no SKU).
    expect(t.callsOf('watches.list')).toEqual([undefined]);
    const card = t.card();
    expect(card.getAttribute('aria-labelledby')).toBe('watches-head');
    expect(doc.getElementById('watches-head')!.textContent).toBe('Your scrap.tf watches');
    expect(card.textContent).toContain(watchesCountText(list.length));
    expect(t.rows()).toHaveLength(list.length);
    t.rows().forEach((r, i) => {
      const w = list[i]!;
      const targets = watchTargetsText(w, 600);
      expect(r.textContent).toContain(`${w.name}${watchCopyText(w)}${targets ? ` · ${targets}` : ''} · ${watchNowView(w, 600, T0).text}`);
      expect(cls(r).includes('paused')).toBe(!w.enabled);
      expect(r.textContent.includes('Paused')).toBe(!w.enabled);
      expect(t.button(r, w.enabled ? 'Pause' : 'Resume')).toBeDefined();
    });
    expect(card.descendants().some((e) => e.tagName === 'A' || e.tagName === 'IMG' || e.tagName === 'IFRAME')).toBe(false);
  });

  it('opens the item on the watched copy; Resume writes the watch; Remove takes it off and Undo adds it back', async () => {
    const t = await mount();
    const list = await t.b.rpc('watches.list', undefined);
    const any = list.find((w) => w.specialKey === null)!;
    const anyRow = () => t.rows().find((r) => r.textContent.startsWith(any.name))!;
    t.fire(anyRow().descendants().find((e) => e.tagName === 'BUTTON' && cls(e).includes('watch-name'))!, 'click');
    expect(t.onItem).toHaveBeenCalledWith(any.sku, null);

    const paused = list.find((w) => !w.enabled)!;
    const pausedRow = () => t.rows().find((r) => r.textContent.startsWith(paused.name))!;
    t.fire(pausedRow().descendants().find((e) => e.tagName === 'BUTTON' && cls(e).includes('watch-name'))!, 'click');
    expect(t.onItem).toHaveBeenLastCalledWith(paused.sku, paused.specialKey === '' ? null : paused.specialKey);
    t.step();
    t.fire(t.button(pausedRow(), 'Resume')!, 'click');
    await settle();
    expect(t.callsOf('watches.upsert').at(-1)).toEqual({ id: paused.id, sku: paused.sku, enabled: true });
    expect(t.toasts().some((e) => e.textContent === `Watching ${paused.name} again`)).toBe(true);
    expect(t.button(pausedRow(), 'Pause')).toBeDefined();

    t.step();
    t.fire(t.button(anyRow(), 'Remove')!, 'click');
    await settle();
    expect(t.callsOf('watches.delete')).toEqual([{ id: any.id }]);
    expect(t.rows()).toHaveLength(list.length - 1);
    const toast = t.toasts().find((e) => e.textContent.includes(`Stopped watching ${any.name}`))!;
    t.step();
    t.fire(toast.descendants().find((e) => e.tagName === 'BUTTON' && cls(e).includes('toast-action'))!, 'click');
    await settle();
    const { now: _now, ...stored } = any;
    // The same watch back, its id and times included ('watches.restore').
    expect(t.callsOf('watches.restore').at(-1)).toEqual(watchUndoInput(stored as ScraptfWatch));
    expect(t.rows()).toHaveLength(list.length);
    expect((await t.b.rpc('watches.list', undefined)).find((w) => w.id === any.id)).toEqual(any);
  });

  it('says how to add a watch when there is none', async () => {
    const t = await mount();
    for (const w of await t.b.rpc('watches.list', undefined)) {
      t.step();
      await t.b.rpc('watches.delete', { id: w.id });
      await settle();
    }
    expect(t.rows()).toEqual([]);
    expect(t.card().textContent).toContain(WATCHES_EMPTY.title);
    expect(t.card().textContent).toContain(WATCHES_EMPTY.body);
    expect(t.card().textContent).toContain(watchesCountText(0));
  });

  it('sits on the Banks page below the bank cards, opening the item through the app', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/BanksPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('<WatchesCard keyScrap={keyScrap} now={now} onItem={(sku, copy) => openItem(sku, copy)} />');
    expect(page.indexOf('<BanksView')).toBeLessThan(page.indexOf('<WatchesCard'));
  });
});
