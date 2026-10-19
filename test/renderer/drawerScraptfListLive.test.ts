// F14 in the item drawer, rendered with react-dom/client into the minimal DOM in domShim.ts with the
// browser mock as the app bridge: the "scrap.tf price list" block shows the item's row of the saved
// list, "Use as my price" writes one typed price (prices.upsert) dated by the list, and the scrap.tf
// buttons only ever call links.open with static pages. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { CATALOG } from '../../src/renderer/mockData';
import { LIST_PRICE_NOTE } from '../../src/renderer/quickModel';
import { SCRAPTF_ITEMS_URL, STATIC_EXTERNAL_URLS, scraptfPageFor } from '../../src/shared/links';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const HOUR = 3_600_000;
/** The mock clock an hour behind the real one, so the saved list is never "in the future". */
const T0 = Math.floor((Date.now() - HOUR) / 60_000) * 60_000;

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ItemDrawer: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  // What the drawer reads beyond the shim (this file runs in its own process): the element class for
  // its focus checks, and a <select>'s options, which React marks when the price form shows one.
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
});

async function settle(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(sku: string) {
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
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, init));
    });
  const section = () => all().find((e) => e.tagName === 'SECTION' && e.getAttribute('aria-labelledby') === 'sec-stf-list') ?? null;
  const button = (root: ShimElement, label: string) => root.descendants().find((e) => e.tagName === 'BUTTON' && (e.textContent ?? '').includes(label)) ?? null;
  return { b, calls, all, fire, section, button };
}

describe('the drawer with a saved scrap.tf list', () => {
  it("shows the item's list row and saves it as a typed price on \"Use as my price\"", async () => {
    const t = await mount('378;6');
    const row = (await t.b.rpc('item.detail', { sku: '378;6', history: false }))!.scraptfList!;
    const s = t.section();
    expect(s).not.toBeNull();
    const text = s!.textContent ?? '';
    expect(text).toContain('scrap.tf price list');
    expect(text).toMatch(/sells .+·pays .+·stock 2\/5·saved /);
    expect(text).toContain('Flip Desk never loads scrap.tf on its own. Your browser does, and you choose when.');

    t.fire(t.button(s!, 'Use as my price')!, 'click', { bubbles: true });
    await settle();
    const upserts = t.calls.filter((c) => c.method === 'prices.upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.params).toMatchObject({ sku: '378;6', source: 'user', note: LIST_PRICE_NOTE, observedAt: row.observedAt, costScrap: row.sellsScrapRaw });
    const saved = (await t.b.rpc('prices.list', {})).filter((p) => p.note === LIST_PRICE_NOTE);
    expect(saved).toHaveLength(1);
    // The price sheet in the drawer shows it after the reload.
    expect(t.all().some((e) => (e.getAttribute('class') ?? '').includes('price-line') && (e.textContent ?? '').includes(LIST_PRICE_NOTE))).toBe(true);
    // Once on the sheet the button says so and adds nothing more.
    const done = t.button(t.section()!, 'Saved as my price');
    expect(done).not.toBeNull();
    expect(done!.getAttribute('disabled')).not.toBeNull();
    t.fire(done!, 'click', { bubbles: true });
    await settle();
    expect(t.calls.filter((c) => c.method === 'prices.upsert')).toHaveLength(1);
  });

  it("shows a painted copy the plain copy's row, saves it under the plain name, and copies the unpainted name", async () => {
    const t = await mount('378;6;p15185211');
    const s = t.section()!;
    expect(s.textContent).toContain('(plain copy)');
    t.fire(t.button(s, 'Use as my price')!, 'click', { bubbles: true });
    await settle();
    const upserts = t.calls.filter((c) => c.method === 'prices.upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.params).toMatchObject({ sku: '378;6', name: 'Team Captain', note: LIST_PRICE_NOTE });
    const header = t.all().find((e) => e.getAttribute('class') === 'drawer-copy')!;
    expect(t.button(header, 'Open on scrap.tf (copies name)')!.getAttribute('title')).toContain('Copies "Team Captain" for');
  });

  it('says "Saved as my price" on a painted copy once saved, so a second click adds nothing (UI-1)', async () => {
    const t = await mount('378;6;p15185211');
    t.fire(t.button(t.section()!, 'Use as my price')!, 'click', { bubbles: true });
    await settle();
    // The saved row is the plain copy's, which this drawer's own prices never list; the drawer still knows.
    const done = t.button(t.section()!, 'Saved as my price');
    expect(done).not.toBeNull();
    expect(done!.getAttribute('disabled')).not.toBeNull();
    expect(done!.getAttribute('title')).toContain('already one of your prices, for a plain copy');
    expect(t.button(t.section()!, 'Use as my price')).toBeNull();
    t.fire(done!, 'click', { bubbles: true });
    await settle();
    expect(t.calls.filter((c) => c.method === 'prices.upsert')).toHaveLength(1);
    const fromList = (await t.b.rpc('prices.list', {})).filter((p) => p.note === LIST_PRICE_NOTE && p.sku === '378;6');
    expect(fromList).toHaveLength(1);
  });

  it('keeps "Use as my price" off for a priced row with stock 0, saying why (F14-DM-1)', async () => {
    // A catalogue item the seeded list prices but shows out of stock.
    const probe = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    let sku: string | null = null;
    try {
      for (const c of CATALOG) {
        if (/;p\d/.test(c.sku)) continue;
        const d = await probe.rpc('item.detail', { sku: c.sku, history: false });
        if (d?.scraptfList && d.scraptfList.stock === 0 && d.scraptfList.sellsScrapRaw !== null && (d.scraptfList.sellsScrapRaw > 0 || (d.scraptfList.sellsKeys ?? 0) > 0)) {
          sku = c.sku;
          break;
        }
      }
    } finally {
      probe.dispose();
    }
    expect(sku).not.toBeNull();
    const t = await mount(sku!);
    const s = t.section()!;
    expect(s.textContent).toMatch(/sells .+·pays .+·stock 0\/\d+·saved /);
    const use = t.button(s, 'Use as my price')!;
    expect(use.getAttribute('disabled')).not.toBeNull();
    expect(use.getAttribute('title')).toBe('Out of stock on scrap.tf (stock 0 in your saved list), so there is nothing to buy at this price.');
    t.fire(use, 'click', { bubbles: true });
    await settle();
    expect(t.calls.filter((c) => c.method === 'prices.upsert')).toHaveLength(0);
  });

  it('opens scrap.tf only through links.open, with static pages', async () => {
    const t = await mount('378;6');
    const s = t.section()!;
    t.fire(t.button(s, 'Open scrap.tf/items')!, 'click', { bubbles: true });
    // UX-11: no second opener of the bank page here; the header's Open on scrap.tf is it.
    expect(t.button(s, 'Open bank page')).toBeNull();
    const header = t.all().find((e) => e.getAttribute('class') === 'drawer-copy')!;
    t.fire(t.button(header, 'Open on scrap.tf (copies name)')!, 'click', { bubbles: true });
    await settle();
    const opened = t.calls.filter((c) => c.method === 'links.open').map((c) => (c.params as { url: string }).url);
    expect(opened).toEqual([SCRAPTF_ITEMS_URL, scraptfPageFor('hats')]);
    for (const u of opened) expect(STATIC_EXTERNAL_URLS).toContain(u);
  });

  it('says so when the item is not on the saved list', async () => {
    // A catalogue item the seeded list leaves out (not every item is on scrap.tf's list).
    const probe = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    let missing: string | null = null;
    try {
      for (const c of CATALOG) {
        const d = await probe.rpc('item.detail', { sku: c.sku, history: false });
        if (d && d.scraptfList === null) {
          missing = c.sku;
          break;
        }
      }
    } finally {
      probe.dispose();
    }
    expect(missing).not.toBeNull();
    const t = await mount(missing!);
    const s = t.section();
    expect(s?.textContent).toContain('Not on your saved scrap.tf price list.');
    expect(t.button(s!, 'Use as my price')).toBeNull();
  });
});
