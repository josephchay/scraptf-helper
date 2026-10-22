// 0.9 (history, RESEARCH #6/#7) in the item drawer, rendered with react-dom/client into the minimal DOM in domShim.ts
// with the browser mock as the app bridge: "Order book history" makes one 'item.bookHistory' read with the drawer's top
// buy order ids when the drawer opens, and shows the spell summary, one order persistence line per asked order (order
// persistence, never a fill rate), the note, and the recorded community price as a step chart; it reads again on
// 'market.changed' at most every 30 s. It sits between the Sell listings and "Reference prices". It opens nothing and
// nothing leaves the process; the wiring is checked statically too.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BOOK_HISTORY_NOTHING_FOLLOWED,
  BOOK_HISTORY_REFRESH_MS,
  bookHistoryOrderIds,
  bookHistorySummaryText,
  bookHistorySummaryTitle,
  bookOrderWho,
  communitySinceText,
  orderPersistenceLine,
} from '../../src/renderer/bookHistoryModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { CATALOG } from '../../src/renderer/mockData';
import { COMMUNITY_NOTE } from '../../src/shared/communityHistory';
import { ORDER_PERSISTENCE_NOTE } from '../../src/shared/orderPersistence';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import type { ItemBookHistory } from '../../src/shared/types';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');

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
  (doc as unknown as Record<string, unknown>)['visibilityState'] = 'visible';
  vi.useRealTimers();
});

/** Lets the mock answer and React render, then moves the fake clock on by `ms`. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
    if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
  });
}

/** A catalogue SKU whose mock book history matches `want` (the mock is deterministic for one seed and clock). */
async function findSku(want: (h: ItemBookHistory, ids: string[]) => boolean): Promise<string> {
  const probe = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  try {
    for (const item of CATALOG) {
      if (/;p\d/.test(item.sku)) continue;
      const d = await probe.rpc('item.detail', { sku: item.sku, history: false });
      if (!d) continue;
      const ids = bookHistoryOrderIds(d.buyOrders);
      const h = await probe.rpc('item.bookHistory', { sku: item.sku, orders: ids });
      if (want(h, ids)) return item.sku;
    }
  } finally {
    probe.dispose();
  }
  throw new Error('no catalogue item fits');
}

async function mount(sku: string) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
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
      return () => {
        set.delete(f);
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
  const historyCalls = () => calls.filter((c) => c.method === 'item.bookHistory');
  // Nothing is read before the drawer opens.
  expect(historyCalls()).toEqual([]);
  emit('ui.openItem', { sku });
  await settle();
  await settle();
  const all = () => container.descendants();
  const section = () => all().find((e) => e.tagName === 'SECTION' && e.getAttribute('aria-labelledby') === 'sec-book-history') ?? null;
  const paragraphs = () => section()!.descendants().filter((e) => e.tagName === 'P');
  return { b, all, section, paragraphs, emit, calls, historyCalls };
}

describe('"Order book history" in the drawer (#6, #7)', () => {
  it("reads item.bookHistory once with the drawer's top order ids, and shows the summary, each order's line and the chart", async () => {
    const sku = await findSku((h, ids) => ids.length > 0 && h.summary.followed > 0 && h.orders.length > 0 && h.community.steps.length > 1);
    const t = await mount(sku);
    // The mock answers on the fake clock: let it run before awaiting.
    const detail = t.b.rpc('item.detail', { sku, history: false });
    await settle();
    const d = (await detail)!;
    const ids = bookHistoryOrderIds(d.buyOrders);
    expect(t.historyCalls().map((c) => c.params)).toEqual([{ sku, orders: ids }]);
    const read = t.b.rpc('item.bookHistory', { sku, orders: ids });
    await settle();
    const h = await read;
    const s = t.section()!;
    expect(s).not.toBeNull();
    expect(s.descendants().find((e) => e.tagName === 'H3')!.textContent).toBe('Order book history');
    expect(s.descendants().filter((e) => e.tagName === 'H4').map((e) => e.textContent)).toEqual(['How long buy orders stay', 'backpack.tf community price']);
    const texts = t.paragraphs().map((p) => p.textContent);
    const summary = t.paragraphs().find((p) => p.textContent === bookHistorySummaryText(h.summary))!;
    expect(summary).toBeDefined();
    expect(summary.getAttribute('title')).toBe(bookHistorySummaryTitle(h.summary));
    for (const o of h.orders) {
      const line = orderPersistenceLine(o, bookOrderWho(o, d.buyOrders), h.keyScrap);
      const p = t.paragraphs().find((e) => e.textContent === line.text)!;
      expect(p, line.text).toBeDefined();
      expect(p.getAttribute('title')).toBe(line.title);
      expect(line.text).toMatch(/ · listed .+ ago · |how long it stays: unknown/);
    }
    expect(texts).toContain(ORDER_PERSISTENCE_NOTE);
    // The chart: a step line named by the since text, and the text with the community note under it.
    const svg = s.descendants().find((e) => e.tagName === 'SVG' || e.tagName === 'svg');
    expect(svg).toBeDefined();
    expect(svg!.getAttribute('aria-label')).toBe(communitySinceText(h.community));
    expect(texts).toContain(`${communitySinceText(h.community)} ${COMMUNITY_NOTE}`);
    // Never a fill rate.
    expect(s.textContent).not.toMatch(/fill rate|filled|will sell/i);
  });

  it('sits between the Sell listings and "Reference prices"', async () => {
    const sku = await findSku((h) => h.summary.followed > 0);
    const t = await mount(sku);
    const heads = t.all().filter((e) => e.tagName === 'H3').map((e) => e.textContent ?? '');
    const at = (text: string) => heads.findIndex((x) => x.startsWith(text));
    expect(at('Sell listings')).toBeGreaterThanOrEqual(0);
    expect(at('Sell listings')).toBeLessThan(at('Order book history'));
    expect(at('Order book history')).toBeLessThan(at('Reference prices'));
  });

  it('says nothing was followed yet for a book with no spells', async () => {
    const sku = await findSku((h) => h.summary.followed === 0);
    const t = await mount(sku);
    const texts = t.paragraphs().map((p) => p.textContent);
    expect(texts).toContain(BOOK_HISTORY_NOTHING_FOLLOWED);
    expect(texts).not.toContain(ORDER_PERSISTENCE_NOTE);
  });

  it("reads again on 'market.changed', at most every 30 s", async () => {
    const sku = await findSku((h) => h.summary.followed > 0);
    const t = await mount(sku);
    expect(t.historyCalls()).toHaveLength(1);
    const changed: PushContract['market.changed'] = { changed: 1, total: 10, at: T0 };
    t.emit('market.changed', changed);
    await settle();
    expect(t.historyCalls()).toHaveLength(2);
    // A second push inside the period waits for its end; a third collapses into the same trailing read.
    t.emit('market.changed', changed);
    t.emit('market.changed', changed);
    await settle(BOOK_HISTORY_REFRESH_MS - 1_000);
    expect(t.historyCalls()).toHaveLength(2);
    await settle(1_000);
    expect(t.historyCalls()).toHaveLength(3);
    // Every read asks for the same orders.
    expect(new Set(t.historyCalls().map((c) => JSON.stringify(c.params))).size).toBe(1);
  });
});

describe('wiring (static)', () => {
  const comp = read('components/BookHistorySection.tsx');
  const drawer = read('pages/ItemDrawer.tsx');

  it('calls only item.bookHistory, refreshed visible-only and throttled, and opens nothing', () => {
    expect(comp).toContain("useRpcQuery('item.bookHistory', { sku, orders: ids })");
    expect(comp.match(/useRpcQuery\(/g)).toHaveLength(1);
    expect(comp).toContain("useVisiblePush('market.changed', reload);");
    expect(comp).toContain('const reload = useThrottled(() => void q.reload(), BOOK_HISTORY_REFRESH_MS);');
    expect(comp).not.toMatch(/\brpc\(|\bcall\(|openOrCopy|openLink|links\.open|openOnScraptf|ExternalLink/);
    expect(comp).not.toMatch(/https?:\/\//);
    expect(comp).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|<webview|<iframe|window\.open|location\.href|\bsrc=|\bhref=/);
  });

  it('is mounted once in the drawer, after the Sell listings and before "Reference prices"', () => {
    expect(drawer.match(/<BookHistorySection /g)).toHaveLength(1);
    expect(drawer).toContain('<BookHistorySection sku={d.sku} orders={d.buyOrders} keyScrap={keyScrap} now={now} />');
    const sell = drawer.indexOf('<OrderBook title="Sell listings"');
    expect(sell).toBeGreaterThan(0);
    expect(sell).toBeLessThan(drawer.indexOf('<BookHistorySection'));
    expect(drawer.indexOf('<BookHistorySection')).toBeLessThan(drawer.indexOf('<h3 id="sec-refs">Reference prices</h3>'));
  });
});
