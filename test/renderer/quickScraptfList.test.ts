// F14 in the quick-entry window: "scrap.tf list: sells X · stock n, saved 3 min ago" under the
// preview with a Use button that fills the price field, and a save of that price keeping the list's
// date and note. Pure helpers, then the window rendered with react-dom/client into the minimal DOM
// in domShim.ts against the browser mock. Local reads only; Flip Desk never loads scrap.tf on its own (R1).

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { LIST_PRICE_NOTE, LIST_PRICE_NOTE_PLAIN, listPriceStamp, listRowIsOtherCopy, listSellsText, quickListHint } from '../../src/renderer/quickModel';
import { parsePrice } from '../../src/shared/currency';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import { valueScraptfListRow } from '../../src/shared/scraptfList';
import type { ScraptfListStored } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 568;

function stored(over: Partial<ScraptfListStored> = {}): ScraptfListStored {
  return { sku: '378;6', name: 'Team Captain', sellsKeys: 0, sellsScrap: 12, paysKeys: 0, paysScrap: 11, stock: 2, stockLimit: 5, batchId: 101, observedAt: T0 - 3 * MIN, ...over };
}
const listRow = (over: Partial<ScraptfListStored> = {}) => valueScraptfListRow(stored(over), K);

describe('the list hint', () => {
  it('reads "sells X · stock n, saved 3 min ago" and offers the listed price to Use', () => {
    expect(quickListHint(listRow(), '378;6', T0)).toMatchObject({ text: 'sells 1.33 ref · stock 2, saved 3 min ago', price: '1.33 ref', tone: 'muted', observedAt: T0 - 3 * MIN });
    expect(quickListHint(listRow({ sellsKeys: 1, sellsScrap: 46 }), '378;6', T0)?.price).toBe('1 key 5.11 ref');
    expect(quickListHint(listRow({ stock: null }), '378;6', T0)?.text).toBe('sells 1.33 ref, saved 3 min ago');
    expect(quickListHint(listRow(), '378;6', T0)?.title).toContain('Flip Desk never loads scrap.tf on its own.');
  });

  it('has nothing to use for a sold-out row, and warns once the save is over a day old', () => {
    const soldOut = quickListHint(listRow({ sellsKeys: null, sellsScrap: null, stock: 0 }), '378;6', T0);
    expect(soldOut).toMatchObject({ text: 'sold out · stock 0, saved 3 min ago', price: null });
    const old = quickListHint(listRow({ observedAt: T0 - 30 * HOUR }), '378;6', T0)!;
    expect(old.tone).toBe('warn');
    expect(old.text).toBe('sells 1.33 ref · stock 2, saved 1 d ago');
    expect(old.title).toContain('Older than a day');
  });

  it('offers no Use for a priced row with stock 0, which the import refuses as a price (F14-DM-1)', () => {
    const out = quickListHint(listRow({ sellsKeys: 10, sellsScrap: 450, stock: 0 }), '378;6', T0)!;
    expect(out).toMatchObject({ text: 'sells 10 keys 50.00 ref · stock 0, saved 3 min ago', price: null });
    expect(out.title).toContain('Out of stock on scrap.tf (stock 0 when you saved the list), so there is nothing to buy at this price.');
    expect(out.title).not.toContain('Use puts');
    // Unknown stock is not out of stock.
    expect(quickListHint(listRow({ stock: null, stockLimit: null }), '378;6', T0)?.price).toBe('1.33 ref');
  });

  it('says the price is for a plain copy when a painted copy is picked', () => {
    expect(listRowIsOtherCopy(listRow(), '378;6')).toBe(false);
    expect(listRowIsOtherCopy(listRow(), '378;6;p15185211')).toBe(true);
    const painted = quickListHint(listRow(), '378;6;p15185211', T0)!;
    expect(painted.text).toBe('sells 1.33 ref (plain copy) · stock 2, saved 3 min ago');
    expect(painted.otherCopy).toBe(true);
    expect(painted.title).toContain('It prices the plain copy of this item, not this one.');
    expect(quickListHint(listRow(), '378;6', T0)?.otherCopy).toBe(false);
  });

  it('shows nothing without a list row', () => {
    expect(quickListHint(null, '378;6', T0)).toBeNull();
    expect(quickListHint(undefined, '378;6', T0)).toBeNull();
  });

  it("writes the price with units, so the field reads the same whatever its bare-number unit", () => {
    for (const r of [listRow(), listRow({ sellsKeys: 2, sellsScrap: 45 }), listRow({ sellsKeys: 1, sellsScrap: 0 })]) {
      const text = listSellsText(r)!;
      const want = { keys: r.sellsKeys ?? 0, scrap: r.sellsScrapRaw ?? 0 };
      for (const unit of ['ref', 'scrap', 'keys'] as const) expect(parsePrice(text, unit)).toMatchObject(want);
    }
    expect(listSellsText(listRow({ sellsKeys: null, sellsScrap: null }))).toBeNull();
    expect(listSellsText(listRow({ sellsKeys: 0, sellsScrap: 0 }))).toBeNull();
  });
});

describe('saving a used list price', () => {
  const use = { sku: '378;6', text: '1.33 ref', observedAt: T0 - 3 * MIN };

  it("keeps the list's date and note while the price is as Use put it", () => {
    expect(listPriceStamp(use, { sku: '378;6', text: '1.33 ref' }, '', T0)).toEqual({ observedAt: T0 - 3 * MIN, note: LIST_PRICE_NOTE });
    expect(listPriceStamp(use, { sku: '378;6', text: ' 1.33 ref ' }, ' 2 in stock ', T0)).toEqual({ observedAt: T0 - 3 * MIN, note: '2 in stock' });
    // A list dated ahead of this clock is still never in the future.
    expect(listPriceStamp({ ...use, observedAt: T0 + HOUR }, { sku: '378;6', text: '1.33 ref' }, '', T0).observedAt).toBe(T0);
  });

  it("notes a plain copy's list price put on a painted copy as such", () => {
    const painted = { sku: '378;6;p15185211', text: '1.33 ref', observedAt: T0 - 3 * MIN, otherCopy: true };
    expect(listPriceStamp(painted, { sku: '378;6;p15185211', text: '1.33 ref' }, '', T0)).toEqual({ observedAt: T0 - 3 * MIN, note: LIST_PRICE_NOTE_PLAIN });
    expect(LIST_PRICE_NOTE_PLAIN).toBe('from scrap.tf list (plain copy)');
    expect(listPriceStamp(painted, { sku: '378;6;p15185211', text: '1.33 ref' }, 'mine', T0).note).toBe('mine');
  });

  it('is a price seen now once it is typed over, or for another item', () => {
    expect(listPriceStamp(use, { sku: '378;6', text: '1.44 ref' }, '', T0)).toEqual({ observedAt: T0, note: null });
    expect(listPriceStamp(use, { sku: '5021;6', text: '1.33 ref' }, 'x', T0)).toEqual({ observedAt: T0, note: 'x' });
    expect(listPriceStamp(null, { sku: '378;6', text: '1.33 ref' }, '', T0)).toEqual({ observedAt: T0, note: null });
  });
});

describe('quick entry wiring', () => {
  const page = readFileSync(new URL('../../src/renderer/pages/QuickEntry.tsx', import.meta.url), 'utf8');

  it("reads the list from the preview's local item.detail, refreshes on a new list, and saves with the stamp", () => {
    expect(page).toContain('quickListHint(d.scraptfList, item.sku, now)');
    expect(page).toContain("useVisiblePush('scraptf.listChanged', refreshPreview, sku !== null);");
    expect(page).toContain('const stamp = listPriceStamp(listUse, { sku: it.sku, text }, note, Date.now());');
    expect(page).toContain('observedAt: stamp.observedAt,');
    expect(page).toContain('note: stamp.note,');
    expect(page).not.toMatch(/https?:\/\/[^'"`\s]*scrap\.tf/);
  });

  it('styles the hint from the tokens only', () => {
    const css = readFileSync(new URL('../../src/renderer/styles/quick-extra.css', import.meta.url), 'utf8');
    const block = css.slice(css.indexOf('scrap.tf price list hint (F14)'), css.indexOf('after Save: "Bought it"'));
    expect(block).toContain('.qp-list');
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

// ---------------------------------------------------------------------------
// The window, rendered against the browser mock
// ---------------------------------------------------------------------------

/** The mock's clock for the rendered window: a whole minute an hour before the real one. */
const MOCK_T0 = Math.floor((Date.now() - HOUR) / MIN) * MIN;

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let QuickEntry: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
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

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

/** Past the preview's pick debounce (PREVIEW_DEBOUNCE_MS, a real timer). */
async function afterDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 220));
  });
  await settle();
}

async function mount() {
  // Behind the real clock the window reads: the list was saved before "now", as it always is.
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => MOCK_T0 }));
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
  const cls = (e: ShimElement) => e.getAttribute('class') ?? '';
  return {
    b,
    all,
    fire,
    emit,
    listLine: () => all().find((e) => cls(e).includes('qp-list') && !cls(e).includes('qp-list-text')) ?? null,
    priceInput: () => all().find((e) => e.getAttribute('id') === 'q-price')! as ShimElement & { value: string },
  };
}

describe('Quick entry with a saved scrap.tf list', () => {
  it('shows the picked item list line; Use fills the price, and Enter saves it dated by the list', async () => {
    const t = await mount();
    const d = (await t.b.rpc('item.detail', { sku: '378;6', history: false, target: 'plain' }))!;
    const row = d.scraptfList!;
    expect(row).not.toBeNull();
    const price = listSellsText(row)!;

    t.emit('ui.quickPrefill', { sku: '378;6' });
    await settle();
    await afterDebounce();
    const line = t.listLine();
    expect(line?.textContent).toContain('scrap.tf list');
    expect(line?.textContent).toContain(`sells ${price}`);
    const useBtn = line!.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent === 'Use')!;
    t.fire(useBtn, 'click', { bubbles: true });
    await settle();
    expect(t.priceInput().value).toBe(price);

    t.fire(t.all().find((e) => e.tagName === 'FORM')!, 'submit', { bubbles: true, cancelable: true });
    await settle();
    const saved = (await t.b.rpc('prices.list', {})).filter((p) => p.sku === '378;6' && p.source === 'user' && p.note === LIST_PRICE_NOTE);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ costKeys: row.sellsKeys ?? 0, costScrap: row.sellsScrapRaw, observedAt: row.observedAt });
  });

  it('saves a price typed over the used one as seen now, without the list note', async () => {
    const t = await mount();
    t.emit('ui.quickPrefill', { sku: '378;6' });
    await settle();
    await afterDebounce();
    const useBtn = t.listLine()!.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent === 'Use')!;
    t.fire(useBtn, 'click', { bubbles: true });
    await settle();
    const input = t.priceInput();
    (input as unknown as { type: string }).type = 'text';
    input.value = '99 scrap';
    t.fire(input, 'input', { bubbles: true });
    await settle();
    t.fire(t.all().find((e) => e.tagName === 'FORM')!, 'submit', { bubbles: true, cancelable: true });
    await settle();
    const saved = (await t.b.rpc('prices.list', {})).filter((p) => p.sku === '378;6' && p.source === 'user' && p.costScrap === 99);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.note).toBeNull();
    // A price typed now (the window's clock), not when the list was saved.
    expect(saved[0]!.observedAt).toBeGreaterThan(MOCK_T0);
  });
});
