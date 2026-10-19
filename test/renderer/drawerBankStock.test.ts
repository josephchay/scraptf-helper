// F17 in the item drawer, rendered with react-dom/client into the minimal DOM in domShim.ts with the
// browser mock as the app bridge: the bank stock line under the item's name, from ItemDetail.bankStock
// ("On scrap.tf/buy/hats in your save 12 min ago: 3 in stock, new since your previous save", "↓ cheaper
// than before (was X)", gone), and View stock opening the bank stock page inside the app. Text from
// pages the user saved only: the line opens nothing outside the app and nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { drawerBankStockLine } from '../../src/renderer/marketModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import type { BankStockChange, ItemBankStock } from '../../src/shared/types';
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

type Case = 'new' | 'cheaper' | 'pricier' | 'gone-sold-out' | 'gone-absent' | 'unchanged';

function caseOf(b: ItemBankStock | null | undefined): Case | null {
  if (!b) return null;
  if (b.change === 'gone') return b.stock === null ? 'gone-absent' : 'gone-sold-out';
  if (b.change === null) return b.previousCostScrap !== null && b.stock !== null && b.stock > 0 ? 'unchanged' : null;
  return b.change;
}

/** One plain SKU per case from the mock's saves (the mock is deterministic at T0; found, not hard-coded). */
let found: Promise<Map<Case, { sku: string; stock: ItemBankStock }>> | null = null;
function examples(): Promise<Map<Case, { sku: string; stock: ItemBankStock }>> {
  found ??= (async () => {
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    const out = new Map<Case, { sku: string; stock: ItemBankStock }>();
    try {
      const want: Record<'new' | 'changed' | 'gone' | 'all', BankStockChange[]> = { new: ['new'], changed: ['cheaper', 'pricier'], gone: ['gone'], all: [null] };
      for (const filter of ['new', 'changed', 'gone', 'all'] as const) {
        for (const info of SCRAPTF_BANKS) {
          const r = await b.rpc('scraptf.bankStock', { bank: info.bank, filter, limit: 60 });
          for (const row of r.rows) {
            if (row.hasExtras || !want[filter].includes(row.change)) continue;
            const d = await b.rpc('item.detail', { sku: row.sku, history: false });
            const c = caseOf(d?.bankStock);
            if (c && d?.bankStock && !out.has(c)) out.set(c, { sku: row.sku, stock: d.bankStock });
          }
          if (out.size === 6) return out;
        }
      }
      return out;
    } finally {
      b.dispose();
    }
  })();
  return found;
}

async function mount(sku: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  win()['location'] = { hash: '' };
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
  const line = () => all().find((e) => e.tagName === 'P' && e.getAttribute('class') === 'drawer-bank-stock small') ?? null;
  const fire = (target: ShimElement) =>
    act(() => {
      target.dispatchEvent(new ShimEvent('click', { bubbles: true }));
    });
  const opened = () => calls.filter((c) => c.method === 'links.open');
  return { b, all, line, fire, opened, calls };
}

describe('the bank stock line in the drawer (F17)', () => {
  it('the mock has an example of every case', async () => {
    const ex = await examples();
    expect([...ex.keys()].sort()).toEqual(['cheaper', 'gone-absent', 'gone-sold-out', 'new', 'pricier', 'unchanged']);
  });

  for (const c of ['new', 'cheaper', 'pricier', 'gone-sold-out', 'gone-absent', 'unchanged'] as const) {
    it(`renders the ${c} line from ItemDetail.bankStock, with the change in its tone`, async () => {
      const ex = (await examples()).get(c)!;
      const t = await mount(ex.sku);
      const d = (await t.b.rpc('item.detail', { sku: ex.sku, history: false }))!;
      expect(d.bankStock).toEqual(ex.stock);
      const expected = drawerBankStockLine(d.bankStock, d.keyPrice?.valueScrap ?? null, T0)!;
      const p = t.line()!;
      expect(p).not.toBeNull();
      expect(p.getAttribute('title')).toBe(expected.title);
      const text = p.descendants().find((e) => e.getAttribute('class') === 'drawer-bank-stock-text')!;
      expect(text.textContent).toBe(expected.text);
      const change = text.descendants().find((e) => (e.getAttribute('class') ?? '').startsWith('drawer-bank-stock-change'));
      if (c === 'unchanged') {
        expect(change).toBeUndefined();
        expect(expected.text).toMatch(/^On scrap\.tf\/(buy\/[a-z]+|items) in your save .+: \d+ in stock$/);
      } else {
        expect(change!.getAttribute('class')).toBe(`drawer-bank-stock-change tone-${expected.tone}`);
        expect(change!.textContent).toBe(expected.change);
      }
      if (c === 'new') expect(expected.text).toMatch(/: \d+ in stock, new since your previous save$/);
      if (c === 'cheaper') expect(expected.text).toMatch(/, ↓ cheaper than before \(was .+\)$/);
      if (c === 'pricier') expect(expected.text).toMatch(/, ↑ pricier than before \(was .+\)$/);
      if (c === 'gone-sold-out') expect(expected.text).toMatch(/: sold out, gone since your previous save/);
      if (c === 'gone-absent') expect(expected.text).toMatch(/^Not on scrap\.tf\//);
    });
  }

  it('View stock opens the bank stock page in the app and closes the drawer; nothing is opened outside', async () => {
    const ex = (await examples()).get('new')!;
    const t = await mount(ex.sku);
    const btn = t.line()!.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent === 'View stock')!;
    t.fire(btn);
    await settle();
    expect((win()['location'] as { hash: string }).hash).toBe(`#/banks/${ex.stock.bank}/stock`);
    expect(t.line()).toBeNull();
    expect(t.opened()).toEqual([]);
  });

  it('says nothing for an item no kept save lists', async () => {
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    let sku: string | null = null;
    try {
      for (const cand of ['5021;6', '160;3', '1071;11', '200;6', '30000;6', '725;6']) {
        const d = await b.rpc('item.detail', { sku: cand, history: false });
        if (d && d.bankStock === null) {
          sku = cand;
          break;
        }
      }
    } finally {
      b.dispose();
    }
    expect(sku).not.toBeNull();
    const t = await mount(sku!);
    expect(t.all().some((e) => e.getAttribute('class') === 'drawer-sub')).toBe(true);
    expect(t.line()).toBeNull();
  });
});

describe('drawer wiring (F17)', () => {
  const drawer = readFileSync(new URL('../../src/renderer/pages/ItemDrawer.tsx', import.meta.url), 'utf8');

  it('reads the line from ItemDetail.bankStock through the model, as text plus an in-app route', () => {
    expect(drawer).toContain('const stockLine = drawerBankStockLine(d.bankStock, keyScrap, now);');
    expect(drawer).toContain('onClick={() => openStock(stockLine.route)}');
    expect(drawer).toMatch(/const openStock = \(route: string\) => \{\s*closeItem\(\);\s*navigate\(route\);\s*\};/);
    // Nothing loads a bank address from it: no src, href, links.open or window.
    expect(drawer).not.toMatch(/(src|href)=\{[^}]*(stockLine|bankStock)/);
    expect(drawer).not.toMatch(/openOrCopy\([^)]*(stockLine|bankStock)/);
  });

  it('keeps the bank stock line out of the order book and price list blocks (header only)', () => {
    const head = drawer.slice(drawer.indexOf('<header className="drawer-head">'), drawer.indexOf('</header>'));
    expect(head).toContain('<p className="drawer-bank-stock small" title={stockLine.title}>');
    expect(drawer.match(/drawer-bank-stock small/g)).toHaveLength(1);
  });
});
