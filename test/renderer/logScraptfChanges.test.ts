// F20 U3: the Live log's "scrap.tf changes" tab (#/log/changes), mounted with react-dom/client into the
// minimal DOM in domShim.ts against the browser mock: the tabs (the opportunity events view unchanged),
// the newest changes first with time, bank, item, "1.33 → 1.22 ref (−8 %)", the live Sells for and Pay
// up to and the Flip pill, the bank and kind filters (remembered), "Load older", the drawer on a click,
// the item menu on a right-click, Export CSV, and a throttled, visible-only re-read on 'scraptf.changed'.
// Nothing leaves the process and nothing opens a scrap.tf address; the wiring is checked statically.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHANGES_LEGACY_PREF_KEY, CHANGES_PREF_KEY, DEFAULT_CHANGE_KINDS, changeRowView } from '../../src/renderer/changesModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { MAIN_METHODS, SERVICE_METHODS } from '../../src/shared/rpc';
import type { ScraptfChangeEvent, ScraptfChangesQuery } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
/** DM-6: the tab's default kinds (every kind but stock moves), as its first read asks for them. */
const KINDS = [...DEFAULT_CHANGE_KINDS];
/** Where the tab remembers its view (usePersistentState's prefix), and where 0.7.0 did. */
const PREF = `flipdesk.ui.${CHANGES_PREF_KEY}`;
const LEGACY_PREF = `flipdesk.ui.${CHANGES_LEGACY_PREF_KEY}`;

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let LogPage: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
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
  // The item menu asks whether focus is inside an open menu: a class-only stand-in for Element.closest.
  if (!Object.getOwnPropertyDescriptor(ShimElement.prototype, 'closest')) {
    Object.defineProperty(ShimElement.prototype, 'closest', {
      configurable: true,
      value(this: ShimElement, sel: string) {
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        for (let n: ShimElement | null = this; n; n = n.parentElement as ShimElement | null) {
          if (cls && (n.getAttribute('class') ?? '').split(' ').includes(cls)) return n;
        }
        return null;
      },
    });
  }
  win()['location'] = { hash: '#/log/changes' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ LogPage } = await import('../../src/renderer/pages/LogPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  win()['location'] = { hash: '#/log/changes' };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function fire(target: ShimElement, type: string, init: Record<string, unknown> = {}) {
  act(() => {
    target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
}

/** What the app state says outside the page: the drawer's item and the toasts. */
function Probe() {
  const { itemSku, toasts } = useApp();
  return createElement('output', { 'data-item': itemSku ?? '', 'data-toasts': toasts.map((t) => t.text).join('|') });
}

async function mountLog(opts: { hash?: string; store?: Map<string, string>; before?: (b: MockBridge) => void } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const store = opts.store ?? new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash: opts.hash ?? '#/log/changes' };
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'D:\\saves' } });
  opts.before?.(b);
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(LogPage), createElement(Probe))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const calls = (method: string) => rpc.mock.calls.filter((c) => c[0] === method);
  const queries = () => calls('scraptf.changes').map((c) => c[1] as ScraptfChangesQuery);
  const all = () => container.descendants();
  const rows = () => all().filter((e) => e.tagName === 'TR' && (e.getAttribute('class') ?? '').includes('stf-feed-row'));
  const button = (label: RegExp) => all().find((e) => e.tagName === 'BUTTON' && label.test(e.textContent));
  const probe = () => all().find((e) => e.tagName === 'OUTPUT')!;
  return { b, store, calls, queries, all, rows, button, probe, content: () => container.textContent };
}

describe('the Live log tabs', () => {
  it('#/log/changes shows the scrap.tf changes tab; the other tab goes back to the opportunity events', async () => {
    const t = await mountLog();
    const tabs = t.all().filter((e) => e.getAttribute('role') === 'tab');
    expect(tabs.map((e) => [e.textContent, e.getAttribute('aria-selected')])).toEqual([
      ['Opportunity events', 'false'],
      ['scrap.tf changes', 'true'],
    ]);
    expect(t.calls('opps.events')).toEqual([]);
    fire(tabs[0]!, 'click');
    expect(win()['location']).toEqual({ hash: '#/log' });
  });

  it('#/log keeps the opportunity events view as it was, and reads no change', async () => {
    const t = await mountLog({ hash: '#/log' });
    expect(t.calls('opps.events').length).toBeGreaterThan(0);
    expect(t.queries()).toEqual([]);
    expect(t.all().some((e) => e.getAttribute('aria-label') === 'Event kinds')).toBe(true);
    const tab = t.all().find((e) => e.getAttribute('role') === 'tab' && e.textContent === 'scrap.tf changes')!;
    fire(tab, 'click');
    expect(win()['location']).toEqual({ hash: '#/log/changes' });
  });
});

describe('the scrap.tf changes tab against the mock', () => {
  it('lists the newest changes first, each with its time, bank, item, price change, live side and Flip pill', async () => {
    const t = await mountLog();
    expect(t.queries()).toEqual([{ kinds: KINDS, limit: 100 }]);
    const list = await t.b.rpc('scraptf.changes', { kinds: KINDS, limit: 100 });
    expect(t.rows()).toHaveLength(list.length);
    // DM-6: no stock moves until the user ticks Stock.
    expect(list.some((e) => e.kind === 'stock')).toBe(false);
    const key = (await t.b.rpc('status.get', undefined)).keyPrice?.valueScrap ?? null;
    list.forEach((e, i) => {
      const r = t.rows()[i]!;
      const v = changeRowView(e, key, T0);
      const cells = r.descendants().filter((c) => c.tagName === 'TD');
      expect(cells[0]!.textContent).toBe(v.time);
      expect(cells[1]!.textContent).toBe(v.bank.label);
      expect(cells[2]!.textContent).toBe(v.kind.label);
      expect(cells[3]!.textContent).toContain(e.name.split(' ')[0]!);
      expect(cells[4]!.textContent.startsWith(v.price.text)).toBe(true);
      expect(cells[6]!.textContent.endsWith('Flip')).toBe(e.flip && v.flip !== null);
    });
    // Every kind of change is on the first page or later; at least one is a flip now.
    expect(t.rows().some((r) => (r.getAttribute('class') ?? '').includes(' flip'))).toBe(true);
    expect(t.content()).toContain('Load older changes');
    expect(t.content()).toContain('what happened between them is unknown');
  });

  it('a kind chip filters, remembered; a remembered bank is read from the start', async () => {
    // From "every kind" (the user's Show every change), one chip is one kind.
    const store = new Map<string, string>([[PREF, JSON.stringify({ bank: '', kinds: [] })]]);
    const t = await mountLog({ store });
    expect(t.queries()).toEqual([{ limit: 100 }]);
    fire(t.button(/^Cheaper$/)!, 'click');
    await settle();
    expect(t.queries().at(-1)).toEqual({ kinds: ['cheaper'], limit: 100 });
    expect(t.rows().length).toBeGreaterThan(0);
    expect(t.rows().every((r) => r.textContent.includes('Cheaper'))).toBe(true);
    expect(JSON.parse(store.get(PREF)!)).toEqual({ bank: '', kinds: ['cheaper'] });
    unmounts.pop()!();
    const w = await mountLog({ store: new Map([[PREF, JSON.stringify({ bank: 'weapons', kinds: [] })]]) });
    expect(w.queries()).toEqual([{ bank: 'weapons', limit: 100 }]);
    expect(w.rows().length).toBeGreaterThan(0);
    expect(w.rows().every((r) => r.descendants().filter((c) => c.tagName === 'TD')[1]!.textContent === 'Weapons')).toBe(true);
  });

  it("DM-6 upgrade: 0.7.0's remembered default hides stock moves now; its bank carries over", async () => {
    // 0.7.0 wrote { kinds: [] } (its default) on the tab's first render: no choice of the user's.
    const store = new Map<string, string>([[LEGACY_PREF, JSON.stringify({ bank: 'hats', kinds: [] })]]);
    const t = await mountLog({ store });
    expect(t.queries()).toEqual([{ bank: 'hats', kinds: KINDS, limit: 100 }]);
    expect(JSON.parse(store.get(PREF)!)).toEqual({ bank: 'hats', kinds: KINDS });
    unmounts.pop()!();
    // Once the new key holds a view, the old one is not read again.
    store.set(LEGACY_PREF, JSON.stringify({ bank: 'weapons', kinds: ['stock'] }));
    const again = await mountLog({ store });
    expect(again.queries()).toEqual([{ bank: 'hats', kinds: KINDS, limit: 100 }]);
  });

  it('a filter with nothing in it says so, with the way back', async () => {
    const t = await mountLog({ store: new Map([[PREF, JSON.stringify({ bank: 'skins', kinds: [] })]]) });
    expect(t.rows()).toHaveLength(0);
    expect(t.content()).toContain('No changes match these filters');
    fire(t.button(/^Show every change$/)!, 'click');
    await settle();
    expect(t.queries().at(-1)).toEqual({ limit: 100 });
    expect(t.rows().length).toBeGreaterThan(0);
  });

  it('"Load older" reads the page before the oldest shown', async () => {
    const t = await mountLog();
    const shown = t.rows().length;
    const first = await t.b.rpc('scraptf.changes', { kinds: KINDS, limit: 100 });
    fire(t.button(/^Load older changes$/)!, 'click');
    await settle();
    expect(t.queries().at(-1)).toEqual({ kinds: KINDS, beforeId: first[first.length - 1]!.id, limit: 100 });
    expect(t.rows().length).toBeGreaterThan(shown);
  });

  it('renders at most 300 rows at once (the table is not virtualised); "Show more" before "Load older"', async () => {
    // A first answer bigger than a page stands in for a refresh after a big save.
    const t = await mountLog({
      before: (b) => {
        const real = b.rpc.bind(b);
        b.rpc = (async (method: string, params: unknown) =>
          method === 'scraptf.changes' && !(params as ScraptfChangesQuery).beforeId ? real('scraptf.changes', { limit: 450 }) : real(method as never, params as never)) as typeof b.rpc;
      },
    });
    expect(t.rows()).toHaveLength(300);
    expect(t.button(/^Load older changes$/)).toBeUndefined();
    fire(t.button(/^Show 150 more$/)!, 'click');
    expect(t.rows()).toHaveLength(450);
    // Everything loaded shows: now "Load older", and what it brings shows at once.
    fire(t.button(/^Load older changes$/)!, 'click');
    await settle();
    expect(t.rows()).toHaveLength(550);
    expect(t.button(/^Show \d+ more$/)).toBeUndefined();
  });

  it('a click opens the drawer by base SKU; a right-click the item menu', async () => {
    const t = await mountLog();
    const list = await t.b.rpc('scraptf.changes', { kinds: KINDS, limit: 100 });
    fire(t.rows()[2]!, 'click');
    expect(t.probe().getAttribute('data-item')).toBe(list[2]!.sku);
    fire(t.rows()[3]!, 'contextmenu', { clientX: 30, clientY: 40 });
    await settle();
    // The menu is portalled onto the body.
    const menu = (doc.body as unknown as ShimElement).descendants().find((e) => e.getAttribute('role') === 'menu');
    expect(menu).toBeDefined();
    expect(menu!.textContent).toContain('Open on scrap.tf');
    // Nothing was opened by either.
    expect(t.calls('links.open')).toEqual([]);
  });

  it('exports the filtered feed through opps.exportCsv and the save dialog', async () => {
    const t = await mountLog({ store: new Map([[PREF, JSON.stringify({ bank: 'hats', kinds: ['gone', 'new'] })]]) });
    fire(t.button(/Export CSV/)!, 'click');
    await settle();
    expect(t.calls('opps.exportCsv').map((c) => c[1])).toEqual([{ kind: 'scraptfChanges', scraptfChanges: { bank: 'hats', kinds: ['new', 'gone'] } }]);
    expect(t.calls('file.saveText')).toHaveLength(1);
    expect(t.probe().getAttribute('data-toasts')).toContain('Saved C:\\Users\\you\\Downloads\\');
  });

  it("re-reads on 'scraptf.changed' (a new save), at most once per 2 s, and shows the new changes on top", async () => {
    const t = await mountLog();
    // The page's own reads (this test's look-ups ask for one).
    const pageReads = () => t.queries().filter((q) => q.limit === 100);
    expect(pageReads()).toHaveLength(1);
    const top = (await t.b.rpc('scraptf.changes', { limit: 1 }))[0]!.id;
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await t.b.rpc('import.pickFile', undefined);
      });
    }
    await settle();
    // The first push reads at once; the rest wait for one trailing read 2 s later.
    expect(pageReads()).toEqual([
      { kinds: KINDS, limit: 100 },
      { kinds: KINDS, limit: 100 },
    ]);
    const newest = (await t.b.rpc('scraptf.changes', { limit: 1 }))[0]!.id;
    expect(newest).toBeGreaterThan(top);
    expect(t.rows()[0]!.getAttribute('class')).toContain('stf-feed-row');
    const firstRowTime = t.rows()[0]!.descendants().find((c) => c.tagName === 'TD')!.getAttribute('title');
    expect(firstRowTime).toContain('Your save of scrap.tf/buy/hats');
  });
});

describe("the rows' live side (F20-UIPERF-4)", () => {
  it("values the rows shown again on 'market.changed', at most once per 20 s, adding none", async () => {
    const market: (() => void)[] = [];
    let bump = 0;
    const t = await mountLog({
      before: (b) => {
        const on = b.on.bind(b);
        b.on = ((event: string, listener: (p: unknown) => void) => {
          if (event === 'market.changed') market.push(() => listener({ changed: 1, total: 1, at: T0 }));
          return on(event as never, listener as never);
        }) as typeof b.on;
        // The buyers move: every later read values the events 100 scrap higher.
        const real = b.rpc.bind(b);
        b.rpc = (async (method: string, params: unknown) => {
          const r = await real(method as never, params as never);
          if (method !== 'scraptf.changes' || bump === 0) return r;
          return (r as ScraptfChangeEvent[]).map((e) => ({ ...e, revenueScrap: (e.revenueScrap ?? 0) + bump, maxCostScrap: (e.maxCostScrap ?? 0) + bump }));
        }) as typeof b.rpc;
      },
    });
    expect(market.length).toBeGreaterThan(0);
    const shown = t.rows().length;
    expect(shown).toBe(100);
    const first = await t.b.rpc('scraptf.changes', { kinds: KINDS, limit: 1 });
    const sells = () => t.rows()[0]!.descendants().filter((c) => c.tagName === 'TD')[5]!.textContent;
    const pay = () => t.rows()[0]!.descendants().filter((c) => c.tagName === 'TD')[6]!.textContent;
    const was = [sells(), pay()];
    const reads = t.queries().length;
    bump = 100;
    act(() => market.forEach((fire) => fire()));
    await settle();
    // One read of the rows shown, from the newest shown down: nothing above it, nothing added.
    expect(t.queries().slice(reads)).toEqual([{ kinds: KINDS, beforeId: first[0]!.id + 1, limit: shown }]);
    expect(t.rows()).toHaveLength(shown);
    expect(sells()).not.toBe(was[0]);
    expect(pay()).not.toBe(was[1]);
    // A second move within 20 s reads nothing yet.
    act(() => market.forEach((fire) => fire()));
    await settle();
    expect(t.queries()).toHaveLength(reads + 1);
  });
});

describe('wiring (static)', () => {
  const page = read('pages/LogPage.tsx');

  it('reads opps.events, scraptf.changes and the CSV only: no new traffic, nothing opened', () => {
    const methods = new Set([...page.matchAll(/rpc\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
    expect([...methods].sort()).toEqual(['opps.events', 'opps.exportCsv', 'scraptf.changes']);
    for (const m of methods) expect([...SERVICE_METHODS, ...MAIN_METHODS]).toContain(m);
    expect(page).toContain("kind: 'scraptfChanges', scraptfChanges: changesExportQuery(view)");
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/openOrCopy|openLink|links\.open|openOnScraptf|\.page\b/);
    expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|<webview|<iframe|window\.open|location\.href|\bsrc=|\bhref=/);
  });

  it('lays the table out in fixed columns that fit the 960px minimum window (about 860px of table)', () => {
    const css = read('styles/scraptf-history.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.stf-feed-table \{\s*width: 100%;\s*table-layout: fixed;/);
    const width = (cls: string) => Number(new RegExp(`\\.stf-feed-table \\.${cls} \\{\\s*width: (\\d+)px;`).exec(css)![1]);
    const fixed = ['stf-feed-time', 'stf-feed-bank', 'stf-feed-kind', 'stf-feed-price', 'stf-feed-sells', 'stf-feed-pay'].map(width);
    // The item column keeps at least 160px.
    expect(860 - fixed.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(160);
    for (const cls of ['stf-feed-time', 'stf-feed-bank', 'stf-feed-kind', 'stf-feed-price', 'stf-feed-sells', 'stf-feed-pay']) expect(page).toContain(cls);
  });

  it('refreshes on scraptf.changed, throttled and only while shown; the opportunity events keep their own push', () => {
    expect(page).toContain("useVisiblePush('scraptf.changed', refreshSoon);");
    expect(page).toContain('const refreshSoon = useThrottled(() => feed.current?.refresh(), CHANGES_REFRESH_MS);');
    // The live side of the rows shown follows the market, throttled harder (each pass re-reads them all).
    expect(page).toContain("useVisiblePush('market.changed', revalueSoon);");
    expect(page).toContain('const revalueSoon = useThrottled(() => feed.current?.revalue(shownRef.current), CHANGES_REVALUE_MS);');
    expect(page).toContain("useVisiblePush('opps.changed', throttledFetch);");
    expect(page).toContain("createChangesFeed((q) => rpc('scraptf.changes', q), setState,");
    // The menu gets the bank the change was on; the drawer the base SKU.
    expect(page).toContain('menuRef.current({ sku: e.sku, name: e.name, bank: e.bank }, at)');
    expect(page).toContain('onClick={() => onOpen(e.sku)}');
  });
});
