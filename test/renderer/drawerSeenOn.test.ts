// F15 in the item drawer, rendered with react-dom/client into the minimal DOM in domShim.ts with the
// browser mock as the app bridge: "Seen on scrap.tf/buy/stranges · 1 h ago" from ItemDetail.seenOn,
// and "Open on scrap.tf (copies name)" in the header going to the bank page the item was last seen on,
// else its category's (0.7.1, UX-11: the price list block has no second "Open bank page"). Only
// links.open with static pages; nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { STATIC_EXTERNAL_URLS, scraptfPageFor } from '../../src/shared/links';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ItemDrawer: () => ReactNode;

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
  win()['location'] = { hash: '' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ ItemDrawer } = await import('../../src/renderer/pages/ItemDrawer'));
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

async function mount(sku: string) {
  // The drawer's ages read Date.now(): the mock's clock.
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
  act(() => root.render(createElement(AppProvider, null, createElement(ItemDrawer))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const emit = <E extends PushEvent>(e: E, p: PushContract[E]) =>
    act(() => {
      for (const fn of local.get(e) ?? []) fn(p);
    });
  emit('ui.openItem', { sku });
  await settle();
  const all = () => container.descendants();
  const fire = (target: ShimElement) =>
    act(() => {
      target.dispatchEvent(new ShimEvent('click', { bubbles: true }));
    });
  const sub = () => all().find((e) => e.getAttribute('class') === 'drawer-sub')!;
  const button = (root: ShimElement, label: string) => root.descendants().find((e) => e.tagName === 'BUTTON' && (e.textContent ?? '').includes(label)) ?? null;
  const section = () => all().find((e) => e.tagName === 'SECTION' && e.getAttribute('aria-labelledby') === 'sec-stf-list')!;
  const header = () => all().find((e) => e.getAttribute('class') === 'drawer-copy')!;
  const opened = () => calls.filter((c) => c.method === 'links.open').map((c) => (c.params as { url: string }).url);
  return { b, all, fire, sub, button, section, header, opened };
}

describe('"Seen on" and the bank page opener in the drawer (F15)', () => {
  it('names the bank page the newest imported price came from, and opens it', async () => {
    const t = await mount('194;11');
    const d = (await t.b.rpc('item.detail', { sku: '194;11', history: false }))!;
    expect(d.seenOn).toMatchObject({ bank: 'stranges' });
    const seen = t.sub().descendants().find((e) => e.getAttribute('class') === 'drawer-seen muted')!;
    expect(seen.textContent).toBe('· Seen on scrap.tf/buy/stranges · 1 h ago');
    expect(seen.getAttribute('title')).toContain('your saved copy of scrap.tf/buy/stranges');
    // UX-11: one opener of the bank page, the header's.
    expect(t.button(t.section(), 'Open bank page')).toBeNull();
    t.fire(t.button(t.header(), 'Open on scrap.tf (copies name)')!);
    await settle();
    expect(t.opened()).toEqual([scraptfPageFor('stranges')]);
  });

  it('an item last seen on the /items list says so, and its bank page is its category\'s', async () => {
    const t = await mount('725;6');
    const d = (await t.b.rpc('item.detail', { sku: '725;6', history: false }))!;
    expect(d.seenOn).toMatchObject({ bank: 'list' });
    // The mock dates a seeded imported price at its page's save, as the import does: the list, 2 h ago.
    expect(t.sub().textContent).toContain('Seen on scrap.tf/items · 2 h ago');
    t.fire(t.button(t.header(), 'Open on scrap.tf (copies name)')!);
    await settle();
    expect(t.opened()).toEqual([scraptfPageFor(d.category)]);
    expect(t.opened()[0]).toBe('https://scrap.tf/buy/items');
    for (const u of t.opened()) expect(STATIC_EXTERNAL_URLS).toContain(u);
  });

  it('says nothing for an item never seen on a saved page', async () => {
    const t = await mount('378;6');
    expect((await t.b.rpc('item.detail', { sku: '378;6', history: false }))!.seenOn).toBeNull();
    expect(t.sub().textContent).not.toContain('Seen on');
    t.fire(t.button(t.header(), 'Open on scrap.tf (copies name)')!);
    await settle();
    expect(t.opened()).toEqual([scraptfPageFor('hats')]);
  });
});

describe('drawer wiring (F15)', () => {
  const drawer = readFileSync(new URL('../../src/renderer/pages/ItemDrawer.tsx', import.meta.url), 'utf8');

  it('reads "Seen on" from ItemDetail.seenOn through the banks model, as text only', () => {
    expect(drawer).toContain('const seen = seenOnText(d.seenOn, now);');
    expect(drawer).toMatch(/<span className="drawer-seen muted" title=\{seen\.title\}>\s*· \{seen\.text\}\s*<\/span>/);
    // Nothing loads the address: no src, href or window built from it.
    expect(drawer).not.toMatch(/(src|href)=\{[^}]*seenOn/);
  });
});
