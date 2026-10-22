// 0.8 (H3, H7) in the item drawer, rendered with react-dom/client into the minimal DOM in domShim.ts with the
// browser mock as the app bridge: "Your holding & trades" reads 'holdings.detail' once when the drawer opens and
// shows the advice, its reasons, the lots, the recorded exits as a step chart with gap ticks and "recorded since";
// it is absent for an item with nothing held, traded or recorded; it reads again on 'journal.changed'. The Sell
// listings section says what others ask. It opens nothing and nothing leaves the process; the wiring is checked
// statically too.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { holdingLotLines, recordedSinceText } from '../../src/renderer/holdingDetailModel';
import { ADVICE_FOOTER, ADVICE_LABELS, adviceReasonText, askSideText } from '../../src/renderer/holdingsModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

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
  expect(calls.filter((c) => c.method === 'holdings.detail')).toEqual([]);
  emit('ui.openItem', { sku });
  await settle();
  await settle();
  const all = () => container.descendants();
  const section = () => all().find((e) => e.tagName === 'SECTION' && (e.getAttribute('class') ?? '').split(' ').includes('holding-section')) ?? null;
  const within = (cls: string) => section()!.descendants().filter((e) => (e.getAttribute('class') ?? '').split(' ').includes(cls));
  const detailCalls = () => calls.filter((c) => c.method === 'holdings.detail');
  return { b, all, section, within, emit, calls, detailCalls };
}

describe('"Your holding & trades" in the drawer (H7)', () => {
  it('reads holdings.detail once and shows the advice, its reasons, the lots, the chart with its gap and "recorded since"', async () => {
    const t = await mount('143;6');
    expect(t.detailCalls().map((c) => c.params)).toEqual([{ sku: '143;6' }]);
    const d = await t.b.rpc('holdings.detail', { sku: '143;6' });
    const advice = d.row!.advice!;
    const s = t.section()!;
    expect(s).not.toBeNull();
    expect(s.descendants().find((e) => e.tagName === 'H3')!.textContent).toBe('Your holding & trades');
    expect(s.textContent).toContain('You hold 1 · held 4 d');
    expect(t.within('advice-pill')[0]!.textContent).toBe(ADVICE_LABELS[advice.kind]);
    const reasons = t.within('holding-reasons')[0]!.descendants().filter((e) => e.tagName === 'LI');
    expect(reasons.map((r) => r.textContent)).toEqual(advice.reasons.map((r) => adviceReasonText(r, d.keyScrap, T0)));
    expect(s.textContent).toContain(ADVICE_FOOTER);
    const lots = t.within('holding-lots')[0]!.descendants().filter((e) => e.tagName === 'LI');
    expect(lots.map((l) => l.textContent)).toEqual(holdingLotLines(d.lots, d.keyScrap, T0));
    // The step chart with a tick where nothing was recorded (the seeded 10 h silence).
    const svg = s.descendants().find((e) => e.tagName === 'svg' && (e.getAttribute('class') ?? '').includes('stf-hist-svg'))!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toMatch(/^Best exit in 12 recorded runs from .+; gaps where nothing was recorded$/);
    expect(s.descendants().some((e) => e.getAttribute('class') === 'stf-hist-step')).toBe(true);
    expect(s.descendants().some((e) => e.getAttribute('class') === 'stf-hist-gap')).toBe(true);
    expect(t.within('holding-since')[0]!.textContent).toBe(recordedSinceText(d));
    // Text only: nothing in the section is a link or loads anything.
    expect(s.descendants().some((e) => e.tagName === 'A' || e.tagName === 'IMG' || e.tagName === 'IFRAME')).toBe(false);
    expect(t.calls.filter((c) => c.method === 'links.open')).toEqual([]);
  });

  it('lists your trades for an item you no longer hold', async () => {
    const t = await mount('378;6');
    const s = t.section()!;
    expect(s.descendants().find((e) => e.tagName === 'H3')!.textContent).toBe('Your trades');
    expect(t.within('holding-trades')[0]!.textContent).toMatch(/^Sold .+ on backpack\.tf after 1 d · /);
    expect(t.within('advice-pill')).toEqual([]);
  });

  it('is absent for an item with nothing held, traded or recorded', async () => {
    // A Live market item the journal never names (so no lot, trade or recorded run).
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    let sku: string | null = null;
    try {
      const traded = new Set((await b.rpc('journal.list', { limit: 500 })).map((e) => e.sku));
      for (const row of (await b.rpc('market.list', { limit: 50 })).rows) {
        if (traded.has(row.sku)) continue;
        const detail = await b.rpc('holdings.detail', { sku: row.sku });
        if (detail.row === null && detail.closed.length === 0 && detail.marks.length === 0) {
          sku = row.sku;
          break;
        }
      }
    } finally {
      b.dispose();
    }
    expect(sku).not.toBeNull();
    const t = await mount(sku!);
    expect(t.detailCalls()).toHaveLength(1);
    expect(t.all().some((e) => e.tagName === 'SECTION')).toBe(true);
    expect(t.section()).toBeNull();
  });

  it("reads again on 'journal.changed', and the section follows a sale", async () => {
    const t = await mount('143;6');
    expect(t.detailCalls()).toHaveLength(1);
    await t.b.rpc('journal.add', { side: 'sell', venue: 'backpack.tf', sku: '143;6', keys: 1, scrap: 500 });
    t.emit('journal.changed', { at: T0 });
    await settle();
    expect(t.detailCalls()).toHaveLength(2);
    expect(t.section()!.descendants().find((e) => e.tagName === 'H3')!.textContent).toBe('Your trades');
  });
});

describe('the Sell listings ask line (H3)', () => {
  it('says what others ask for this copy, and that a listing is slower with no buyer guaranteed', async () => {
    const t = await mount('143;6');
    const d = (await t.b.rpc('item.detail', { sku: '143;6', history: false }))!;
    expect(d.ask).not.toBeNull();
    const line = t.all().find((e) => (e.getAttribute('class') ?? '').split(' ').includes('ask-side-line'))!;
    expect(line.textContent).toBe(`${askSideText(d.ask, d.keyPrice?.valueScrap ?? null, T0)} A listing might sell for up to about this; slower, and no buyer is guaranteed.`);
  });
});

describe('wiring (static)', () => {
  const comp = read('components/HoldingSection.tsx');
  const drawer = read('pages/ItemDrawer.tsx');

  it('reads only holdings.detail, refreshed visible-only and throttled, and opens nothing', () => {
    expect(comp).toContain("useRpcQuery('holdings.detail', { sku })");
    expect(comp).toContain("useVisiblePush('journal.changed', reloadSoon);");
    expect(comp).toContain("useVisiblePush('market.changed', reload);");
    expect(comp).toContain("useVisiblePush('scraptf.listChanged', reload);");
    expect(comp).toContain("useVisiblePush('prices.changed', reload);");
    expect(comp).toContain('const reloadSoon = useThrottled(() => void q.reload(), 300);');
    expect(comp).toContain('const reload = useThrottled(() => void q.reload(), 2000);');
    expect(comp).not.toMatch(/\brpc\(|\bcall\(|openOrCopy|openLink|links\.open|openOnScraptf/);
    expect(comp).not.toMatch(/https?:\/\//);
    expect(comp).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|<webview|<iframe|window\.open|location\.href|\bsrc=|\bhref=/);
  });

  it('is mounted once in the drawer, between the trade row and "Profit by input"; the sell book gets the ask', () => {
    expect(drawer.match(/<HoldingSection /g)).toHaveLength(1);
    expect(drawer).toContain('<HoldingSection sku={d.sku} keyScrap={keyScrap} now={now} />');
    expect(drawer.indexOf('drawer-trade-row')).toBeLessThan(drawer.indexOf('<HoldingSection'));
    expect(drawer.indexOf('<HoldingSection')).toBeLessThan(drawer.indexOf('<h3 id="sec-profit">Profit by input</h3>'));
    expect(drawer).toContain('<OrderBook title="Sell listings" orders={d.sellListings} keyScrap={keyScrap} now={now} kind="sell" ask={d.ask ?? null} />');
  });

  it('styles the section from tokens only', () => {
    const css = read('styles/holdings.css').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const cls of ['holding-section', 'holding-lots', 'holding-trades', 'h-advice', 'advice-pill', 'advice-inline']) expect(css).toContain(`.${cls}`);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/url\(/);
  });
});
