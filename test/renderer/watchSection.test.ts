// 0.8 (G1/G3) in the item drawer and the item menu, rendered with react-dom/client into the minimal DOM in domShim.ts
// with the browser mock as the app bridge: "scrap.tf watch" reads 'watches.list' for the item, adds a watch from the
// form ('watches.upsert' with the form's copy and targets), pauses it, removes it ('watches.delete') and Undo adds
// it back, the list re-read on the 'watches.changed' push; the item menu's "Watch on scrap.tf…" opens the Watch
// dialog for the row's copy, which saves and closes, and Escape closes it. Nothing is opened, linked or bought.

import { readFileSync } from 'node:fs';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ItemMenuTarget } from '../../src/renderer/components/ItemMenu';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { WATCH_BOUNDARY_NOTE, WATCH_MENU_LABEL, watchUndoInput } from '../../src/renderer/watchesModel';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import type { ScraptfWatch } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const PINK = bankStockSpecialKey({ paint: 16738740 });
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ItemDrawer: () => ReactNode;
let ToastStack: () => ReactNode;
let useItemMenu: typeof import('../../src/renderer/components/ItemMenu').useItemMenu;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  if (!Object.getOwnPropertyDescriptor(ShimElement.prototype, 'options')) {
    Object.defineProperty(ShimElement.prototype, 'options', {
      configurable: true,
      get(this: ShimElement) {
        return this.tagName === 'SELECT' ? this.descendants().filter((e) => e.tagName === 'OPTION') : undefined;
      },
    });
  }
  // The item menu and the dialogs ask for the open menu ('.item-menu') and the modal around the opener
  // ('[aria-modal="true"]'): a stand-in for Element.closest with one class or one attribute selector.
  if (!Object.getOwnPropertyDescriptor(ShimElement.prototype, 'closest')) {
    Object.defineProperty(ShimElement.prototype, 'closest', {
      configurable: true,
      value(this: ShimElement, sel: string) {
        const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        for (let n: ShimElement | null = this; n; n = n.parentElement as ShimElement | null) {
          if (cls && (n.getAttribute('class') ?? '').split(' ').includes(cls)) return n;
          if (attr && n.getAttribute(attr[1]!) === attr[2]) return n;
        }
        return null;
      },
    });
  }
  win()['location'] = { hash: '' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ ItemDrawer } = await import('../../src/renderer/pages/ItemDrawer'));
  ({ ToastStack } = await import('../../src/renderer/components/Feedback'));
  ({ useItemMenu } = await import('../../src/renderer/components/ItemMenu'));
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

/** The app with the drawer, the toasts and (optionally) a page that opens the item menu on `menuTarget`. */
async function mount(menuTarget: ItemMenuTarget | null = null) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const calls: { method: string; params: unknown }[] = [];
  const local = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: (m, p) => {
      calls.push({ method: m, params: p });
      return b.rpc(m, p);
    },
    // The mock's own pushes ('watches.changed') and the test's ('ui.openItem') both reach the app.
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
  function MenuPage({ target }: { target: ItemMenuTarget }) {
    const menu = useItemMenu();
    const open = menu.open;
    useEffect(() => {
      (win() as Record<string, unknown>)['openMenu'] = () => open(target, { x: 10, y: 10 });
    }, [open, target]);
    return createElement('div', null, menu.element);
  }
  act(() => root.render(createElement(AppProvider, null, createElement(ItemDrawer), createElement(ToastStack), menuTarget ? createElement(MenuPage, { target: menuTarget }) : null)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
    delete (win() as Record<string, unknown>)['openMenu'];
  });
  await settle();
  const emit = <E extends PushEvent>(e: E, p: PushContract[E]) =>
    act(() => {
      for (const fn of local.get(e) ?? []) fn(p);
    });
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
  const type = async (input: ShimElement, text: string) => {
    // React's change detection reads the input's type property, which the minimal DOM leaves unset.
    (input as unknown as { type: string; value: string }).type = 'text';
    (input as unknown as { value: string }).value = text;
    fire(input, 'input');
    await settle();
  };
  /** Moves the clock past the section's 1 s throttle, so the next push re-reads at once. */
  const step = () => vi.setSystemTime(Date.now() + 5_000);
  const section = () => container.descendants().find((e) => e.tagName === 'SECTION' && cls(e).includes('watch-section')) ?? null;
  const lines = () => section()?.descendants().filter((e) => e.tagName === 'LI' && cls(e).includes('watch-line')) ?? [];
  const buttonIn = (el: ShimElement, text: string) => el.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === text);
  const toasts = () => doc.body.descendants().filter((e) => cls(e).includes('toast'));
  const dialog = () => doc.body.descendants().find((e) => e.getAttribute('role') === 'dialog') ?? null;
  const callsOf = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);
  return { b, emit, fire, type, step, section, lines, buttonIn, toasts, dialog, callsOf };
}

/** A catalog item no seeded watch covers. */
async function unwatchedSku(b: MockBridge): Promise<{ sku: string; name: string }> {
  const watched = new Set((await b.rpc('watches.list', undefined)).map((w) => w.sku));
  for (const sku of ['378;6', '143;6', '30001;6']) {
    if (watched.has(sku)) continue;
    const d = await b.rpc('item.detail', { sku, history: false });
    if (d) return { sku, name: d.name };
  }
  throw new Error('no unwatched catalog item');
}

describe('"scrap.tf watch" in the drawer', () => {
  it('adds a watch from the form, pauses it, removes it and Undo adds it back, re-reading on watches.changed', async () => {
    const t = await mount();
    const item = await unwatchedSku(t.b);
    t.emit('ui.openItem', { sku: item.sku });
    await settle();
    await settle();
    const s = t.section()!;
    expect(s).not.toBeNull();
    expect(s.descendants().find((e) => e.tagName === 'H3')!.textContent).toBe('scrap.tf watch');
    expect(t.callsOf('watches.list')).toContainEqual({ sku: item.sku });
    expect(t.lines()).toEqual([]);
    expect(s.textContent).toContain(WATCH_BOUNDARY_NOTE);
    const form = s.descendants().find((e) => e.tagName === 'FORM')!;
    const submit = () => form.descendants().find((e) => e.tagName === 'BUTTON' && e.getAttribute('type') === 'submit')!;
    expect(submit().textContent.trim()).toBe('Watch');

    // Add: a price as typed, this copy (the SKU's own).
    t.step();
    await t.type(form.descendants().find((e) => e.tagName === 'INPUT' && cls(e).includes('money-input'))!, '1.33');
    t.fire(form, 'submit');
    await settle();
    expect(t.callsOf('watches.upsert')).toEqual([
      { sku: item.sku, copies: 'one', special: null, name: item.name, maxCostKeys: 0, maxCostScrap: 12, minProfitScrap: null, onRestock: false, enabled: true },
    ]);
    expect(t.toasts().some((e) => e.textContent === `Watching ${item.name}`)).toBe(true);
    expect(t.lines()).toHaveLength(1);
    expect(t.lines()[0]!.textContent).toContain('Clean copy · ≤ 1.33 ref');
    expect(submit().textContent.trim()).toBe('Save watch');
    const saved = (await t.b.rpc('watches.list', { sku: item.sku }))[0]! as ScraptfWatch;

    // Pause.
    t.step();
    t.fire(t.buttonIn(t.lines()[0]!, 'Pause')!, 'click');
    await settle();
    expect(t.callsOf('watches.upsert').at(-1)).toEqual({ id: saved.id, sku: item.sku, enabled: false });
    expect(cls(t.lines()[0]!)).toContain('paused');
    expect(t.lines()[0]!.textContent).toContain('Paused');
    expect(t.buttonIn(t.lines()[0]!, 'Resume')).toBeDefined();

    // Remove, then Undo from the toast.
    const { now: _now, ...paused } = (await t.b.rpc('watches.list', { sku: item.sku }))[0]!;
    t.step();
    t.fire(t.buttonIn(t.lines()[0]!, 'Remove')!, 'click');
    await settle();
    expect(t.callsOf('watches.delete')).toEqual([{ id: saved.id }]);
    expect(t.lines()).toEqual([]);
    const toast = t.toasts().find((e) => e.textContent.includes(`Stopped watching ${item.name}`))!;
    expect(toast).toBeDefined();
    t.step();
    t.fire(toast.descendants().find((e) => e.tagName === 'BUTTON' && cls(e).includes('toast-action'))!, 'click');
    await settle();
    // The same watch back, its id and times included ('watches.restore'), not a new one.
    expect(t.callsOf('watches.restore')).toEqual([watchUndoInput(paused as ScraptfWatch)]);
    expect(t.callsOf('watches.restore')[0]).toMatchObject({ id: saved.id, enabled: false });
    expect(t.lines()).toHaveLength(1);
    expect(t.lines()[0]!.textContent).toContain('Paused');
    const { now: _back, ...restored } = (await t.b.rpc('watches.list', { sku: item.sku }))[0]!;
    expect(restored).toEqual(paused);
    // Text and buttons only: nothing in the section is a link or loads anything.
    expect(t.section()!.descendants().some((e) => e.tagName === 'A' || e.tagName === 'IMG' || e.tagName === 'IFRAME')).toBe(false);
    expect(t.callsOf('links.open')).toEqual([]);
  });

  it("shows a seeded watch's line with where it stands, and its form edits that watch", async () => {
    const t = await mount();
    const seeded = (await t.b.rpc('watches.list', undefined)).find((w) => w.id === 1)!;
    t.emit('ui.openItem', { sku: seeded.sku });
    await settle();
    await settle();
    expect(t.lines()).toHaveLength(1);
    expect(t.lines()[0]!.textContent).toMatch(/^Any copy · ≤ .+ · back on sale · At your target: .+ on Hats/);
    // Only an any-copy watch: the form opens on that scope, as an edit.
    const form = t.section()!.descendants().find((e) => e.tagName === 'FORM')!;
    expect(form.descendants().find((e) => e.tagName === 'BUTTON' && e.getAttribute('type') === 'submit')!.textContent.trim()).toBe('Save watch');
    t.step();
    t.fire(form, 'submit');
    await settle();
    expect(t.callsOf('watches.upsert').at(-1)).toMatchObject({ id: 1, copies: 'any', special: null, maxCostScrap: seeded.maxCostScrap, onRestock: true });
  });
});

describe('the item menu\'s "Watch on scrap.tf…"', () => {
  it("opens the Watch dialog for the row's copy, which saves and closes; Escape closes it", async () => {
    const t = await mount({ sku: '378;6', name: 'Team Captain', special: PINK });
    act(() => (win()['openMenu'] as () => void)());
    await settle();
    const item = doc.body.descendants().find((e) => e.getAttribute('role') === 'menuitem' && e.textContent.includes(WATCH_MENU_LABEL))!;
    expect(item).toBeDefined();
    t.fire(item, 'click');
    await settle();
    const dlg = t.dialog()!;
    expect(dlg).not.toBeNull();
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(doc.getElementById(dlg.getAttribute('aria-labelledby')!)!.textContent).toBe('Watch Team Captain on scrap.tf');
    expect(t.callsOf('watches.list')).toContainEqual({ sku: '378;6' });
    const form = dlg.descendants().find((e) => e.tagName === 'FORM')!;
    await t.type(dlg.descendants().find((e) => e.tagName === 'INPUT' && cls(e).includes('money-input'))!, '2 keys');
    t.fire(form, 'submit');
    await settle();
    expect(t.callsOf('watches.upsert').at(-1)).toMatchObject({ sku: '378;6', copies: 'one', special: PINK, maxCostKeys: 2, maxCostScrap: 0 });
    expect(t.dialog()).toBeNull();
    expect((await t.b.rpc('watches.list', { sku: '378;6' })).some((w) => w.specialKey === PINK && w.maxCostKeys === 2)).toBe(true);

    // Opened again, Escape closes it without a write.
    const writes = t.callsOf('watches.upsert').length;
    // A browser moves focus to the body when the focused dialog is removed; the minimal DOM keeps the detached field.
    doc.activeElement = doc.body;
    act(() => (win()['openMenu'] as () => void)());
    await settle();
    t.fire(doc.body.descendants().find((e) => e.getAttribute('role') === 'menuitem' && e.textContent.includes(WATCH_MENU_LABEL))!, 'click');
    await settle();
    expect(t.dialog()).not.toBeNull();
    t.fire(t.dialog()!, 'keydown', { key: 'Escape' });
    await settle();
    expect(t.dialog()).toBeNull();
    expect(t.callsOf('watches.upsert')).toHaveLength(writes);
  });

  it('is wired statically: the menu entry, the dialog and the drawer section open nothing', () => {
    const menu = read('components/ItemMenu.tsx');
    expect(menu).toContain("case 'watch':\n        onWatch(target);");
    expect(menu).toContain('{watch.element}');
    expect(read('pages/ItemDrawer.tsx')).toContain('<WatchSection d={d} copyKey={copyKey} keyScrap={keyScrap} now={now} ceiling={ceiling} />');
    const drawer = read('pages/ItemDrawer.tsx');
    expect(drawer.indexOf('<ScraptfHistory')).toBeLessThan(drawer.indexOf('<WatchSection'));
    expect(drawer.indexOf('<WatchSection')).toBeLessThan(drawer.indexOf('<PriceSection'));
    for (const f of ['components/WatchForm.tsx', 'components/WatchSection.tsx', 'components/WatchDialog.tsx', 'components/WatchesCard.tsx']) {
      expect(read(f)).not.toMatch(/\b(?:href|src)\s*=|openLink|openOrCopy|links\.open/);
    }
  });
});
