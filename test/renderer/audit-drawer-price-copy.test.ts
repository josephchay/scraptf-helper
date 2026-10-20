// 0.7.3 (audit rmarket-1): a plain item's drawer lists every copy stored under its base SKU, but its price
// form updates only this copy's typed prices (priceIsForSku, as Record buy reads them). Updating a painted
// or spelled copy's row from it gave that copy the plain price, since the stored extras are kept. The other
// copies' lines say so. Rendered with react-dom/client into domShim.ts with the browser mock; nothing leaves
// the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fmtKeysMetal } from '../../src/renderer/format';
import { defaultPriceTarget, drawerPriceTargets } from '../../src/renderer/itemMenuModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import type { ItemDetail, ScrapPrice, SpecialAttrs } from '../../src/shared/types';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const PINK = 15185211;
const EMPTY: SpecialAttrs = { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };

function price(over: Partial<ScrapPrice>): ScrapPrice {
  return {
    id: 1,
    sku: '378;6',
    name: 'The Team Captain',
    costKeys: 0,
    costScrap: 100,
    source: 'user',
    observedAt: 1000,
    note: null,
    importBatch: null,
    special: null,
    assetId: null,
    stock: null,
    bank: null,
    ...over,
  };
}

const plain = price({ id: 1, observedAt: 1000, costScrap: 100 });
const painted = price({ id: 2, observedAt: 5000, costScrap: 300, name: 'The Team Captain (Pink as Hell)', special: { ...EMPTY, paint: PINK } });
const spelled = price({ id: 3, observedAt: 7000, costScrap: 400, special: { ...EMPTY, spells: ['Exorcism'] } });
const imported = price({ id: 4, observedAt: 9000, source: 'import' });
const PRICES = [painted, plain, spelled, imported];

describe('the drawer price form targets this copy only (model)', () => {
  it("offers and defaults to the plain copy's typed price in the plain drawer", () => {
    expect(drawerPriceTargets(PRICES, '378;6').map((p) => p.id)).toEqual([1]);
    expect(defaultPriceTarget(PRICES, '378;6')).toBe(1);
  });

  it('adds a new plain price when only another copy has a typed one', () => {
    expect(drawerPriceTargets([painted, spelled], '378;6')).toEqual([]);
    expect(defaultPriceTarget([painted], '378;6')).toBeNull();
  });

  it("offers the painted copy's price in its painted drawer, with the paint in the extras or on the SKU", () => {
    expect(drawerPriceTargets(PRICES, `378;6;p${PINK}`).map((p) => p.id)).toEqual([2]);
    expect(defaultPriceTarget(PRICES, `378;6;p${PINK}`)).toBe(2);
    const mockRow = price({ id: 5, sku: `378;6;p${PINK}`, special: null });
    expect(drawerPriceTargets([mockRow], `378;6;p${PINK}`).map((p) => p.id)).toEqual([5]);
    expect(drawerPriceTargets([mockRow], '378;6')).toEqual([]);
  });

  it("keeps a kit's sheen and killstreaker its own copy (0.7.2)", () => {
    const kitSku = '6526;6;uncraftable;kt-3;td-205';
    const kit = price({ id: 6, sku: kitSku, special: { ...EMPTY, sheen: 4, killstreaker: 2003 } });
    expect(defaultPriceTarget([kit], kitSku)).toBe(6);
  });

  it('lists the newest first, and without a SKU keeps the newest typed price of any copy', () => {
    const older = price({ id: 7, observedAt: 500 });
    expect(drawerPriceTargets([older, plain], '378;6').map((p) => p.id)).toEqual([1, 7]);
    expect(defaultPriceTarget(PRICES)).toBe(3);
  });
});

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

/** The plain Team Captain's drawer, its detail listing a newer painted typed price beside the plain one. */
async function mount() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const local = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: (async (m: string, p: unknown) => {
      const r = await b.rpc(m as 'item.detail', p as { sku: string });
      if (m !== 'item.detail' || (p as { sku: string }).sku !== '378;6' || !r) return r;
      const at = (ms: number) => T0 - ms;
      return { ...r, scrapPrices: [{ ...painted, observedAt: at(60_000) }, { ...plain, observedAt: at(3_600_000) }] } satisfies ItemDetail;
    }) as FlipdeskBridge['rpc'],
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
  emit('ui.openItem', { sku: '378;6' });
  await settle();
  return { all: () => container.descendants() };
}

describe("the plain drawer's price form (rendered)", () => {
  it("offers only the plain copy's typed price, preselected, and marks the painted copy's line", async () => {
    const t = await mount();
    const select = t.all().find((e) => e.tagName === 'SELECT' && e.getAttribute('id') === 'dp-target')!;
    expect(select).toBeDefined();
    const options = select.descendants().filter((e) => e.tagName === 'OPTION');
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['1', 'new']);
    // The preselected target's price is the price field's placeholder.
    const input = t.all().find((e) => e.tagName === 'INPUT' && e.getAttribute('id') === 'dp-price')!;
    expect(input.getAttribute('placeholder')).toBe(`now ${fmtKeysMetal(0, 100)}`);

    const lines = t.all().filter((e) => e.tagName === 'LI' && e.getAttribute('class') === 'price-line');
    expect(lines).toHaveLength(2);
    const line = (cost: number) => lines.find((l) => (l.textContent ?? '').includes(fmtKeysMetal(0, cost)))!;
    expect(line(300).textContent).toContain('other copy');
    expect(line(100).textContent).not.toContain('other copy');
  });
});
