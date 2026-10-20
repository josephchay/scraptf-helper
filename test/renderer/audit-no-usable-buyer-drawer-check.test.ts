// 0.7.3 (follow-up to rmodelsB-1/rmodelsB-2): the item drawer's "Profit by input" card and the live
// check popup read a null revenue as "no eligible buy order" even with eligible buyers none of which is
// usable (every order an outlier, or no bot order with Revenue used for profit set to Instant). They now
// say "no usable buy order" and why (quickModel's noRevenueText). The popup's model is checked pure; both
// windows are also rendered with react-dom/client into domShim.ts with the browser mock as the bridge,
// only item.detail's opportunities swapped. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkPayUpTo, checkSellsLine, checkVerdictView } from '../../src/renderer/checkModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockCheckDemo } from '../../src/renderer/mockCheck';
import { noRevenueText, noRevenueTextOf } from '../../src/renderer/quickModel';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import type { CheckResult, ItemDetail, ItemRevenue, Opportunity } from '../../src/shared/types';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const K = 540;
const SKU = '378;6';

/** A flip demo turned into a check whose eligible buyers are all unusable under `useOrder`. */
function unusable(useOrder: ItemRevenue['useOrder'], eligibleCount = 3): CheckResult {
  const d = mockCheckDemo('flip', T0, K, DEFAULT_SETTINGS);
  return {
    ...d,
    revenue: { ...d.revenue!, useOrder, revenueScrap: null, consScrap: useOrder === 'conservative' ? null : d.revenue!.consScrap, instantScrap: null, order: null, maxCostScrap: null, eligibleCount },
    profitScrap: null,
    margin: null,
    verdict: 'no-buyers',
  };
}

describe('the check popup model with buyers none of which is usable', () => {
  it('says "no usable buy order" and why, for every-order-an-outlier', () => {
    const r = unusable('conservative');
    const s = checkSellsLine(r);
    expect(s).toMatchObject({ revenue: null, count: '3 buyers', none: 'no usable buy order' });
    expect(s.title).toBe(`${noRevenueText(r.revenue)}.`);
    expect(s.title).toContain('every eligible order looks unrealistically high');
    expect(checkVerdictView(r)).toMatchObject({ tone: 'muted', text: 'No usable buyer' });
    expect(checkVerdictView(r)!.title).toContain('every eligible order looks unrealistically high');
    expect(checkPayUpTo(r)).toMatchObject({ text: '—' });
    expect(checkPayUpTo(r).title).not.toContain('No eligible buyer');
  });

  it('names Instant when no eligible order is a realistic bot order', () => {
    const r = unusable('instant');
    expect(checkSellsLine(r).title).toContain('none is a realistic bot order');
    expect(checkVerdictView(r)!.title).toContain('Instant (bot orders only)');
    expect(checkPayUpTo(r).title).toContain('Instant (bot orders only)');
  });

  it('still says "no eligible buy order" and "No buyers" when nothing is eligible', () => {
    const r = unusable('conservative', 0);
    expect(checkSellsLine(r)).toMatchObject({ none: 'no eligible buy order', title: 'No eligible backpack.tf buy order in the live book right now.' });
    expect(checkVerdictView(r)).toMatchObject({ text: 'No buyers', title: 'No eligible backpack.tf buy order right now, so nothing to sell it to.' });
    expect(checkPayUpTo(r).title).toBe('No eligible buyer, so no price to pay.');
    expect(checkSellsLine(unusable('conservative')).none).toBe('no usable buy order');
    expect(checkSellsLine(mockCheckDemo('flip', T0, K, DEFAULT_SETTINGS)).none).toBeNull();
  });
});

describe('noRevenueTextOf (an opportunity: flags, not useOrder)', () => {
  it("reads 'all-outliers' as every order an outlier, and its absence as Instant without a bot", () => {
    expect(noRevenueTextOf({ buyerCount: 2, flags: ['all-outliers'] })).toBe('2 buyers, but every eligible order looks unrealistically high');
    expect(noRevenueTextOf({ buyerCount: 1, flags: [] })).toBe('1 buyer, but none is a realistic bot order, and Revenue used for profit is Instant (bot orders only)');
    expect(noRevenueTextOf({ buyerCount: 0, flags: ['all-outliers'] })).toBe('No eligible backpack.tf buyer right now');
  });
});

// ---------------------------------------------------------------------------
// Rendered
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ItemDrawer: () => ReactNode;
let CheckPopup: () => ReactNode;

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
  ({ CheckPopup } = await import('../../src/renderer/pages/CheckPopup'));
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

/** Renders `node` with the mock as the bridge; `detail` rewrites item.detail's answer when given. */
async function mount(windowKind: FlipdeskBridge['windowKind'], node: () => ReactNode, detail?: (d: ItemDetail) => ItemDetail) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const local = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind,
    rpc: (async (m: string, p: unknown) => {
      const res = await b.rpc(m as never, p as never);
      return m === 'item.detail' && res && detail ? detail(res as ItemDetail) : res;
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
  act(() => root.render(createElement(AppProvider, null, createElement(node))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const emit = <E extends PushEvent>(e: E, p: PushContract[E]) =>
    act(() => {
      for (const fn of local.get(e) ?? []) fn(p);
    });
  return { all: () => container.descendants(), emit };
}

function opp(over: Partial<Opportunity>): Opportunity {
  return {
    key: `${SKU}|price:1`,
    sku: SKU,
    name: 'The Team Captain',
    category: 'hats',
    inputRef: 'price:1',
    inputKind: 'user',
    costKeys: 0,
    costScrap: 90,
    costScrapRaw: 90,
    bestScrap: 400,
    consScrap: null,
    instantScrap: null,
    revenueScrap: null,
    profitScrap: null,
    margin: null,
    maxCostScrap: null,
    confidence: 20,
    confidenceLevel: 'low',
    flags: [],
    reasons: [],
    buyerCount: 3,
    bestOrder: null,
    consOrder: null,
    instantOrder: null,
    references: { pricedb: null, community: null },
    profitTier: 'none',
    status: 'no-buyers',
    inputObservedAt: T0 - 60_000,
    firstSeenAt: T0 - 60_000,
    updatedAt: T0 - 60_000,
    ...over,
  };
}

async function drawerCard(o: Opportunity) {
  const t = await mount('dashboard', ItemDrawer, (d) => ({ ...d, opportunities: [o] }));
  t.emit('ui.openItem', { sku: SKU });
  await settle();
  const card = t.all().find((e) => (e.getAttribute('class') ?? '').startsWith('input-card '));
  expect(card).toBeDefined();
  return card!;
}

describe("the drawer's Profit by input card", () => {
  it('says "no usable buy order" (why on hover) for eligible buyers that are all outliers', async () => {
    const card = await drawerCard(opp({ flags: ['all-outliers'] }));
    expect(card.textContent).toContain('— (no usable buy order)');
    expect(card.textContent).not.toContain('no eligible buy order');
    const why = card.descendants().find((e) => e.tagName === 'SPAN' && e.textContent === '— (no usable buy order)');
    expect(why?.getAttribute('title')).toBe('3 buyers, but every eligible order looks unrealistically high');
  });

  it('names Instant on hover when no eligible order is a realistic bot order', async () => {
    const card = await drawerCard(opp({ flags: [] }));
    const why = card.descendants().find((e) => e.tagName === 'SPAN' && e.textContent === '— (no usable buy order)');
    expect(why?.getAttribute('title')).toContain('Instant (bot orders only)');
  });

  it('still says "no eligible buy order" without eligible buyers', async () => {
    const card = await drawerCard(opp({ buyerCount: 0, bestScrap: null }));
    expect(card.textContent).toContain('— (no eligible buy order)');
    expect(card.textContent).not.toContain('usable');
  });
});

describe('the check popup', () => {
  it('says "no usable buy order" beside its buyer count, with why on the line', async () => {
    win()['location'] = { hash: '#/check' };
    try {
      const t = await mount('check', CheckPopup);
      const r = unusable('instant');
      t.emit('ui.checkShow', r);
      await settle();
      const line = t.all().find((e) => e.getAttribute('class') === 'cp-line' && e.textContent.includes('Sells for'));
      expect(line).toBeDefined();
      expect(line!.textContent).toContain('no usable buy order');
      expect(line!.textContent).toContain('3 buyers');
      expect(line!.textContent).not.toContain('no eligible buy order');
      expect(line!.getAttribute('title')).toBe(`${noRevenueText(r.revenue)}.`);
      const dialog = t.all().find((e) => e.getAttribute('role') === 'dialog')!;
      expect(dialog.textContent).toContain('No usable buyer');
    } finally {
      win()['location'] = { hash: '' };
    }
  });
});
