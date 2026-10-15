// The quick-entry window, rendered with react-dom/client into the minimal DOM in
// domShim.ts with the browser mock as the app bridge: after a Save, the saved
// price edited elsewhere in place (the drawer's "Add / update scrap.tf price"
// or the Prices page keep the row id) must be what the card shows and what
// "Bought it" records, not the copy prices.upsert returned. Nothing leaves the
// process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { freshSavedPrice } from '../../src/renderer/quickModel';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import type { ItemDetail, ScrapPrice } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let QuickEntry: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import. `oninput` makes onChange use
  // native input events, as in a browser.
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  // What AppProvider reads beyond the shim: the hash route and the theme attributes on <html>.
  win()['location'] = { hash: '' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ QuickEntry } = await import('../../src/renderer/pages/QuickEntry'));
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
async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const cls = (e: ShimElement) => e.getAttribute('class') ?? '';

async function mount() {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  // Main's pushes (here 'ui.quickPrefill') come from the test; the service's from the mock.
  const local = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'quick-entry',
    rpc: (m, p) => b.rpc(m, p),
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
  act(() => root.render(createElement(AppProvider, null, createElement(QuickEntry))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const all = () => container.descendants();
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, init));
    });
  const emit = <E extends PushEvent>(e: E, p: PushContract[E]) =>
    act(() => {
      for (const fn of local.get(e) ?? []) fn(p);
    });
  return {
    b,
    all,
    fire,
    emit,
    card: () => all().find((e) => e.getAttribute('aria-label') === 'Saved price') ?? null,
    boughtButton: () => all().find((e) => e.tagName === 'BUTTON' && cls(e).includes('quick-bought')) ?? null,
    /** Picks the item the way the dashboard's "Quick entry" button does, types the price and saves. */
    save: async (sku: string, price: string) => {
      emit('ui.quickPrefill', { sku });
      await settle();
      const input = all().find((e) => e.getAttribute('id') === 'q-price')!;
      (input as unknown as { type: string; value: string }).type = 'text';
      (input as unknown as { value: string }).value = price;
      fire(input, 'input', { bubbles: true });
      await settle();
      fire(all().find((e) => e.tagName === 'FORM')!, 'submit', { bubbles: true, cancelable: true });
      await settle();
    },
  };
}

describe('Quick entry after Save', () => {
  const setVisible = (on: boolean) =>
    act(() => {
      (doc as unknown as { visibilityState: string }).visibilityState = on ? 'visible' : 'hidden';
      doc.dispatchEvent(new ShimEvent('visibilitychange'));
    });
  afterEach(() => {
    (doc as unknown as { visibilityState: string }).visibilityState = 'visible';
  });

  it('"Bought it" records the saved price as edited since (same row id), and the card follows the edit', async () => {
    const t = await mount();
    await t.save('378;6', '12 scrap');
    expect(t.card()?.textContent).toContain('Saved');
    expect(t.card()?.textContent).toContain('1.33 ref');
    const saved = (await t.b.rpc('prices.list', {})).filter((p) => p.sku === '378;6' && p.costScrap === 12 && p.source === 'user');
    expect(saved).toHaveLength(1);
    const row = saved[0]!;

    // The user opened the dashboard (the quick-entry window hides) and fixed the price in the drawer:
    // the same row, a new cost (drawerPriceInput passes `id: target.id`). Pushes wait for the window.
    setVisible(false);
    await act(async () => {
      await t.b.rpc('prices.upsert', { id: row.id, sku: row.sku, name: row.name, costKeys: 0, costScrap: 13, source: 'user', observedAt: T0, note: null });
    });
    await settle();
    expect(t.card()?.textContent).toContain('1.33 ref');

    // Clicked before the card caught up: Bought it reads the row again and records the edited cost.
    t.fire(t.boughtButton()!, 'click', { bubbles: true });
    await settle();
    const bought = (await t.b.rpc('journal.list', { limit: 2000 })).filter((e) => e.sku === '378;6' && e.side === 'buy' && e.venue === 'scrap.tf' && e.ts >= T0);
    expect(bought.map((e) => [e.keys, e.scrap])).toEqual([[0, 13]]);
    expect(t.boughtButton()?.textContent).toContain('Recorded');

    // Shown again: the held pushes re-read the card, which now says what was recorded.
    setVisible(true);
    await settle();
    expect(t.card()?.textContent).toContain('1.44 ref');
    // Recorded once: an edit does not re-arm the button (a second click would add a second unit).
    expect(t.boughtButton()?.textContent).toContain('Recorded');
  });

  it('re-reads the saved price on every price write, not only on opportunity changes', () => {
    const src = readFileSync(new URL('../../src/renderer/pages/QuickEntry.tsx', import.meta.url), 'utf8');
    expect(src).toContain("useVisiblePush('prices.changed', refresh, result !== null)");
  });
});

describe('freshSavedPrice', () => {
  const saved = { id: 7, sku: '378;6', name: 'Team Captain', costKeys: 0, costScrap: 12, source: 'user', observedAt: T0, note: null, importBatch: null, special: null, assetId: null, stock: null } satisfies ScrapPrice;

  it('takes the stored row with the same id, else keeps the last known copy', () => {
    const edited = { ...saved, costScrap: 13 };
    const other = { ...saved, id: 8, costScrap: 99 };
    expect(freshSavedPrice(saved, { scrapPrices: [other, edited] } as Pick<ItemDetail, 'scrapPrices'>)).toBe(edited);
    // Deleted since (often right after buying): the buy can still be recorded at the last known price.
    expect(freshSavedPrice(saved, { scrapPrices: [other] } as Pick<ItemDetail, 'scrapPrices'>)).toBe(saved);
    expect(freshSavedPrice(saved, null)).toBe(saved);
  });
});
