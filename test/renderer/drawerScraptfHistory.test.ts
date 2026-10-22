// F20 U1 in the item drawer, rendered with react-dom/client into the minimal DOM in domShim.ts with the
// browser mock as the app bridge: the "scrap.tf history" block reads 'scraptf.itemHistory' once when the
// drawer opens, shows "Listed since …", stock now, the four change chips, the step chart and the change
// lines (or the empty state for an item no save lists), and reads again on 'scraptf.changed' and
// 'prices.changed', throttled and only while the window is shown. It opens nothing and nothing leaves
// the process; the wiring is checked statically too. 0.8 (T5, LC-3): the Cycles block (the buy timing, the
// listing runs, a tick under each drop), absent for a history from an older service.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  STEP_BOX,
  historyChips,
  historyEventGroups,
  historyListedLine,
  historyNowText,
  historyRunLines,
  historySeries,
  historyTimingView,
  stepChartGeom,
} from '../../src/renderer/historyModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { TIMING_ESTIMATE_NOTE } from '../../src/renderer/timingModel';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
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

async function settle(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

/** A plain hats item the mock's saves list on sale now, with change events. */
async function listedSku(): Promise<string> {
  const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  try {
    const r = await b.rpc('scraptf.bankStock', { bank: 'hats', limit: 60 });
    for (const row of r.rows) {
      if (row.hasExtras) continue;
      const h = await b.rpc('scraptf.itemHistory', { sku: row.sku });
      if (h.bank !== null && h.current && h.events.length > 0 && h.points.length > 2) return row.sku;
    }
    throw new Error('no listed item in the mock');
  } finally {
    b.dispose();
  }
}

/** 0.8: a plain hats item whose history has its listing runs and a buy-timing verdict (the Cycles block). */
async function cyclesSku(): Promise<string> {
  const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  try {
    const r = await b.rpc('scraptf.bankStock', { bank: 'hats', limit: 60 });
    for (const row of r.rows) {
      if (row.hasExtras || row.change === 'gone') continue;
      const h = await b.rpc('scraptf.itemHistory', { sku: row.sku });
      if (h.bank !== null && h.timing && h.cycles && h.cycles.runs.length > 0 && h.points.length > 2) return row.sku;
    }
    throw new Error('no item with cycles in the mock');
  } finally {
    b.dispose();
  }
}

/** `older`: answer 'scraptf.itemHistory' as a service from before 0.8 would, without `timing` and `cycles`. */
async function mount(sku: string, opts: { older?: boolean } = {}) {
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
      if (opts.older && m === 'scraptf.itemHistory') {
        return b.rpc(m, p).then((h) => {
          const { timing: _timing, cycles: _cycles, ...rest } = h as Record<string, unknown>;
          return rest as never;
        });
      }
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
  // Nothing is read before the drawer opens.
  expect(calls.filter((c) => c.method === 'scraptf.itemHistory')).toEqual([]);
  emit('ui.openItem', { sku });
  // item.detail first; the block mounts with it and then reads its history.
  await settle();
  await settle();
  const all = () => container.descendants();
  const block = () => all().find((e) => e.tagName === 'SECTION' && (e.getAttribute('class') ?? '').includes('stf-hist')) ?? null;
  const within = (cls: string) => block()!.descendants().filter((e) => (e.getAttribute('class') ?? '').split(' ').includes(cls));
  // DM-6: the price changes' list and the stock moves' list (class stf-hist-stock), each of its own lines.
  const lists = () => within('stf-hist-events');
  const priceLines = () => (lists().find((l) => !(l.getAttribute('class') ?? '').split(' ').includes('stf-hist-stock'))?.descendants() ?? []).filter((e) => e.tagName === 'LI');
  const stockLines = () => (lists().find((l) => (l.getAttribute('class') ?? '').split(' ').includes('stf-hist-stock'))?.descendants() ?? []).filter((e) => e.tagName === 'LI');
  const historyCalls = () => calls.filter((c) => c.method === 'scraptf.itemHistory');
  return { b, all, block, within, priceLines, stockLines, emit, calls, historyCalls };
}

describe('the scrap.tf history block in the drawer (F20 U1)', () => {
  it('reads the history once when the drawer opens and shows listed since, stock now, the chips, the chart and the changes', async () => {
    const sku = await listedSku();
    const t = await mount(sku);
    expect(t.historyCalls().map((c) => c.params)).toEqual([{ sku }]);
    const h = await t.b.rpc('scraptf.itemHistory', { sku });
    const key = h.keyPrice?.valueScrap ?? null;
    const block = t.block()!;
    expect(block).not.toBeNull();
    expect(block.textContent).toContain('scrap.tf history');
    expect(t.within('stf-hist-listed')[0]!.textContent).toBe(historyListedLine(h, T0)!.text);
    expect(t.within('stf-hist-listed')[0]!.textContent).toMatch(/^Listed since .+ \(since your save on [A-Z][a-z]{2} \d{1,2} \d\d:\d\d\)$/);
    expect(t.within('stf-hist-now')[0]!.textContent).toBe(historyNowText(h, key)!.text);
    const chips = t.within('stf-hist-chip');
    expect(chips.map((c) => c.textContent)).toEqual(historyChips(h, key).map((c) => `${c.label}${c.text}`));
    expect(chips.map((c) => c.descendants()[0]!.textContent)).toEqual(['1 h', '24 h', '7 d', 'Since listed']);
    const svg = block.descendants().find((e) => e.tagName === 'svg' && (e.getAttribute('class') ?? '').includes('stf-hist-svg'))!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toMatch(/^scrap\.tf price in \d+ saves from /);
    expect(block.descendants().some((e) => (e.getAttribute('class') ?? '') === 'stf-hist-step')).toBe(true);
    // DM-6: price changes and stock moves are listed apart, five of each until "Show all".
    const groups = historyEventGroups(h.events);
    expect(t.priceLines().length).toBe(Math.min(5, groups.price.length));
    expect(t.stockLines().length).toBe(Math.min(5, groups.stock.length));
    expect(t.within('stf-hist-event')).toHaveLength(Math.min(5, groups.price.length) + Math.min(5, groups.stock.length));
    if (groups.stock.length) expect(block.textContent).toContain('Stock moves');
    expect(block.textContent).toContain('Flip Desk never loads scrap.tf on its own.');
    // Text only: nothing in the block is a link or loads anything.
    expect(block.descendants().some((e) => e.tagName === 'A' || e.tagName === 'IMG' || e.tagName === 'IFRAME')).toBe(false);
    expect(t.calls.filter((c) => c.method === 'links.open')).toEqual([]);
  });

  it('"Show all" lists every change of the copy, up to the 50 the service sends', async () => {
    const sku = await listedSku();
    const t = await mount(sku);
    const h = await t.b.rpc('scraptf.itemHistory', { sku });
    const groups = historyEventGroups(h.events);
    const more = t.block()!.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent === `Show all ${groups.price.length}`);
    if (groups.price.length <= 5) {
      expect(more).toBeUndefined();
      return;
    }
    act(() => {
      more!.dispatchEvent(new ShimEvent('click', { bubbles: true }));
    });
    expect(t.priceLines()).toHaveLength(groups.price.length);
    // The stock moves keep their own "Show all".
    expect(t.stockLines().length).toBe(Math.min(5, groups.stock.length));
  });

  it('an item no kept save lists: the empty state, no chart', async () => {
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    let sku: string | null = null;
    try {
      for (const cand of ['160;3', '1071;11', '200;6', '30000;6', '725;6', '5021;6']) {
        const d = await b.rpc('item.detail', { sku: cand, history: false });
        const h = d ? await b.rpc('scraptf.itemHistory', { sku: cand }) : null;
        if (h && h.bank === null) {
          sku = cand;
          break;
        }
      }
    } finally {
      b.dispose();
    }
    expect(sku).not.toBeNull();
    const t = await mount(sku!);
    const block = t.block()!;
    expect(block.textContent).toContain('Not in your saved scrap.tf pages yet');
    expect(block.textContent).toContain('every later save adds a point');
    expect(block.descendants().some((e) => e.tagName === 'svg' && (e.getAttribute('class') ?? '').includes('stf-hist-svg'))).toBe(false);
  });

  it("reads again on 'scraptf.changed' and 'prices.changed', at most once per 2 s, and not while hidden", async () => {
    const sku = await listedSku();
    const t = await mount(sku);
    expect(t.historyCalls()).toHaveLength(1);
    t.emit('scraptf.changed', { at: T0, count: 3 });
    t.emit('scraptf.changed', { at: T0, count: 1 });
    t.emit('prices.changed', { at: T0 });
    await settle();
    // The first push reads at once; the rest wait for one trailing read 2 s later.
    expect(t.historyCalls()).toHaveLength(2);
    // Hidden in the tray: a push does nothing until the window is shown.
    (doc as unknown as Record<string, unknown>)['visibilityState'] = 'hidden';
    act(() => {
      doc.dispatchEvent(new ShimEvent('visibilitychange'));
    });
    const before = t.historyCalls().length;
    t.emit('scraptf.changed', { at: T0, count: 2 });
    await settle();
    expect(t.historyCalls()).toHaveLength(before);
  });
});

describe('0.8 the Cycles block (T5, LC-3)', () => {
  it('shows the buy timing between the chips and the chart, the runs after the chart, and a tick under each drop', async () => {
    const sku = await cyclesSku();
    const t = await mount(sku);
    const h = await t.b.rpc('scraptf.itemHistory', { sku });
    const key = h.keyPrice?.valueScrap ?? null;
    const view = historyTimingView(h.timing, h, key, T0)!;
    const box = t.within('stf-hist-timing')[0]!;
    expect(box.getAttribute('role')).toBe('group');
    expect(box.getAttribute('aria-label')).toBe('Buy timing');
    const pill = box.descendants().find((e) => (e.getAttribute('class') ?? '').includes('stf-hist-timing-pill'))!;
    expect(pill.textContent).toBe(view.pill.text);
    expect(pill.getAttribute('title')).toBe(view.pill.title);
    const paras = box.descendants().filter((e) => e.tagName === 'P').map((e) => e.textContent);
    expect(paras).toEqual([...view.lines, TIMING_ESTIMATE_NOTE]);
    // Order: chips, the timing, the chart, the runs.
    const block = t.block()!;
    const order = block.descendants().map((e) => e.getAttribute('class') ?? '');
    const at = (cls: string) => order.findIndex((c) => c.split(' ').includes(cls));
    expect(at('stf-hist-chips')).toBeLessThan(at('stf-hist-timing'));
    expect(at('stf-hist-timing')).toBeLessThan(at('stf-hist-chart'));
    expect(at('stf-hist-chart')).toBeLessThan(at('stf-hist-runs'));
    const runs = historyRunLines(h.cycles, h, key, T0)!;
    const head = block.descendants().find((e) => e.tagName === 'H4' && e.textContent === runs.head)!;
    expect(head.getAttribute('title')).toBe(runs.title);
    const items = t.within('stf-hist-runs')[0]!.descendants().filter((e) => e.tagName === 'LI');
    expect(items.map((e) => e.textContent)).toEqual(runs.lines.slice(0, 5).map((l) => l.text));
    const downs = stepChartGeom(historySeries(h.points), STEP_BOX, { downAts: h.cycles!.dropAts })!.downs!;
    expect(block.descendants().some((e) => e.getAttribute('class') === 'stf-hist-down')).toBe(downs.length > 0);
    // Still text only: no link, nothing loaded.
    expect(block.descendants().some((e) => e.tagName === 'A' || e.tagName === 'IMG' || e.tagName === 'IFRAME')).toBe(false);
  });

  it('a history without timing or cycles (an older service) renders as before', async () => {
    const sku = await cyclesSku();
    const t = await mount(sku, { older: true });
    const block = t.block()!;
    expect(block.textContent).toContain('scrap.tf history');
    expect(t.within('stf-hist-timing')).toEqual([]);
    expect(t.within('stf-hist-runs')).toEqual([]);
    expect(block.descendants().some((e) => e.getAttribute('class') === 'stf-hist-down')).toBe(false);
    expect(block.descendants().some((e) => e.tagName === 'svg' && (e.getAttribute('class') ?? '').includes('stf-hist-svg'))).toBe(true);
    expect(t.within('stf-hist-chip')).toHaveLength(4);
  });
});

describe('wiring (static)', () => {
  const comp = read('components/ScraptfHistory.tsx');
  const drawer = read('pages/ItemDrawer.tsx');

  it('0.8: marks the drops only from the history\'s cycles, and styles the Cycles block from tokens', () => {
    expect(comp).toContain('stepChartGeom(series, STEP_BOX, dropAts ? { downAts: dropAts } : {})');
    const rules = read('styles/scraptf-history.css').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const cls of ['stf-hist-timing', 'stf-hist-runs', 'stf-hist-down']) expect(rules).toContain(`.${cls}`);
  });

  it('reads only scraptf.itemHistory, lazily, refreshed visible-only and throttled', () => {
    expect(comp).toContain("useRpcQuery('scraptf.itemHistory', special !== undefined && special !== null ? { sku, special } : { sku })");
    expect(comp).toContain('const reload = useThrottled(() => void q.reload(), HISTORY_REFRESH_MS);');
    expect(comp).toContain("useVisiblePush('scraptf.changed', reload);");
    expect(comp).toContain("useVisiblePush('prices.changed', reload);");
    expect(comp).not.toMatch(/\brpc\(|\bcall\(|openOrCopy|openLink|links\.open|openOnScraptf/);
    expect(comp).not.toMatch(/https?:\/\//);
    expect(comp).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|<webview|<iframe|window\.open|location\.href|\bsrc=|\bhref=/);
  });

  it('is mounted once in the drawer, after the scrap.tf price list', () => {
    expect(drawer.match(/<ScraptfHistory /g)).toHaveLength(1);
    // 0.7.4 (F65): with the newer look that stored no save (unsavedLookOf), so an older save is never "Now".
    // 0.7.4 (F66): and the copy the drawer was opened on (a painted or kit copy's row), when there is one.
    expect(drawer).toContain('<ScraptfHistory sku={d.sku} {...(copyKey !== null ? { special: copyKey } : {})} keyScrap={keyScrap} now={now} unsaved={unsaved} />');
    expect(drawer.indexOf('<ScraptfListSection')).toBeLessThan(drawer.indexOf('<ScraptfHistory'));
    expect(drawer.indexOf('<ScraptfHistory')).toBeLessThan(drawer.indexOf('<PriceSection'));
  });

  it('styles from tokens only, nothing animated or loaded', () => {
    const css = read('styles/scraptf-history.css');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\brgba?\(/);
    expect(rules).not.toMatch(/animation|transition/);
    expect(rules).not.toMatch(/url\(|@import/);
    for (const cls of ['stf-hist-listed', 'stf-hist-chip', 'stf-hist-step', 'stf-hist-dot', 'stf-hist-gap', 'stf-hist-event', 'stf-feed-flip', 'stf-resave-banks']) expect(rules).toContain(`.${cls}`);
  });
});
