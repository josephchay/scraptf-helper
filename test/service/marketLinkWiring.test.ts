// F19 wired end to end, across the three processes: the real service core (Live market index, saved-page
// import, live check), main's real IPC router and live check controller (check.arm, the hint, own-copy
// suppression, links.open's allowlist), and the dashboard's real Live market page and check popup, rendered
// into domShim.ts with window.flipdesk routed to that router, as the preload does.
//
// Out: a saved hats page (the bank fixture, imported as the folder watch does) links the rows it listed to
// scrap.tf/buy/hats (MarketRow.scraptfLink, 'seen' at the save time); a row no page listed links to its
// category's bank. A row's scrap.tf button arms main, copies the name and hands that static page to the
// "browser". Back: the watcher drops the app's own copy of the name once, the check hotkey checks a bare
// copied price as the armed item, and Save price in the popup disarms, so the next bare price is no item.
//
// Offline (R1, R10): the page is a fixture the "user" saved, the browser and the OS clipboard are fakes,
// and nothing is requested after start. Main's log never names the item or a copied text.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement, type ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRpcRouter, type MainRpcDeps, type RpcCallContext } from '../../src/main/ipc';
import { createLiveCheckMain, type LiveCheckMain, type LiveCheckTimers } from '../../src/main/liveCheck';
import { CHECK_MATCHED_NOTE } from '../../src/renderer/checkModel';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { CHECK_ARM_MS, CHECK_NOT_ITEM_REASON, checkHintedNote, checkMatchedByHint } from '../../src/shared/check';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { bankForCategory, isAllowedExternalUrl, SCRAPTF_BANKS, scraptfBankInfo, STATIC_EXTERNAL_URLS } from '../../src/shared/links';
import { MAIN_METHODS, type FlipdeskBridge, type PushEvent } from '../../src/shared/rpc';
import type { CheckArm, CheckHint, CheckResult, ImportResult, ItemDetail, Listing, MarketListResult, MarketRow, Settings } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';
import { installDomShim, layout, ShimElement, ShimEvent, type ShimDocument } from '../renderer/domShim';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
/** A saved scrap.tf/buy/hats page (synthetic markup, made-up ids and prices). */
const HATS = readFileSync(path.join(FIX, 'import/buy_hats.html'), 'utf8');
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(u.hostname + u.pathname);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
  if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
/** The Team Captain: on the saved hats page, with backpack.tf buyers. */
const LISTED = '378;6';
/** The Ambassador: a weapon with buyers that no saved page listed. */
const UNLISTED = '61;6';
const SAVED_AT = NOW - 30 * MIN;
/** What the user copies on scrap.tf: a bare price cell, then later another one. */
const PRICE_TEXT = '1.33 ref';
const LATER_PRICE_TEXT = '2 ref';

let seq = 0;
function buyers(sku: string, scrap: number, n = 2): Listing[] {
  return Array.from({ length: n }, () => {
    seq++;
    return makeListing({ id: `wl${seq}`, sku, baseSku: sku, steamid: `7656119800088${String(seq).padStart(4, '0')}`, metalScrap: scrap, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
}

// ---------------------------------------------------------------------------
// The three processes
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let MarketPage: () => ReactNode;
let ToastStack: () => ReactNode;
let CheckPopup: () => ReactNode;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;
const cls = (e: ShimElement) => e.getAttribute('class') ?? '';
const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-marketlink-wiring-'));
const dataDir = path.join(root, 'data');

let core: ServiceCore;
let ctl: LiveCheckMain;
/** The OS clipboard: the page writes it (navigator.clipboard), main reads it (clipboard.readText). */
let clipboard = 'something copied before the app started';
/** Main's clock, for the arm's expiry and the hotkey's debounce. */
let mainNow = NOW;
/** The clipboard watcher's poll; the test runs it instead of a 700 ms interval. */
let watchTick: (() => void) | null = null;
/** Watcher popups waiting out CHECK_POPUP_MIN_GAP_MS; this test never lets them through. */
const heldPopups: unknown[] = [];
/** What main handed to the user's browser (shell.openExternal). */
const opened: string[] = [];
const armCalls: (CheckArm | null)[] = [];
/** main.ts's check dep: every 'check.text' main sent the service, with the answer. */
const checks: { text: string; source: string; hint: CheckHint | undefined; args: number; result: CheckResult }[] = [];
const popups: { result: CheckResult; focus: boolean }[] = [];
const notified: unknown[] = [];
/** Every RPC a page made through window.flipdesk. */
const pageCalls: { method: string; params: unknown }[] = [];
const listeners = new Map<string, Set<(p: unknown) => void>>();
const mainLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
// Main's own settings (settings.json): the opt-in clipboard watcher is on.
const mainSettings: Settings = mergeSettings(DEFAULT_SETTINGS, { check: { watchClipboard: true }, import: { enabled: true, acknowledgedAt: NOW - HOUR } });

function emit(event: string, payload: unknown): void {
  act(() => {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  });
}

/** Main's own pushes; main never forwards these from the service. */
const MAIN_PUSHES: ReadonlySet<string> = new Set(['settings.changed', 'ui.openItem', 'ui.quickPrefill', 'ui.checkShow', 'service.state']);

beforeAll(async () => {
  // Service: the hats page's Team Captain and a weapon have buyers in the stored book.
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  repo.upsertListings([...buyers(LISTED, 300), ...buyers(UNLISTED, 200)]);
  repo.close();
  core = createServiceCore({
    dataDir,
    version: '0.6.0',
    settings: mergeSettings(DEFAULT_SETTINGS, {
      contactUrl: 'https://github.com/flipdesk-test',
      liveFeed: { enabled: false },
      connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
      import: { enabled: true, acknowledgedAt: NOW - HOUR },
    }),
    secrets: {},
    log: createLogger({ dataDir }),
    fetchImpl,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
  });
  core.onPush((event, payload) => {
    if (!MAIN_PUSHES.has(event)) emit(event, payload);
  });
  await core.start();
  requested.length = 0;

  // Main: the live check controller as main.ts builds it, with fakes for Electron.
  const timers: LiveCheckTimers = {
    setInterval: (fn) => {
      watchTick = fn;
      return 'watch';
    },
    clearInterval: () => {
      watchTick = null;
    },
    setTimeout: (fn) => {
      heldPopups.push(fn);
      return heldPopups.length;
    },
    clearTimeout: () => undefined,
  };
  ctl = createLiveCheckMain({
    readText: () => clipboard,
    // As main.ts: the hint only while an arm lasts, straight to the service (never through the page router).
    check: async (text, source, hint) => {
      const result = (await core.handle('check.text', hint ? { text, source, hint } : { text, source })) as CheckResult;
      checks.push({ text, source, hint, args: hint === undefined ? 2 : 3, result });
      return result;
    },
    serviceReady: () => true,
    // windows.showCheck: the popup page gets 'ui.checkShow'.
    showPopup: (result, opts) => {
      popups.push({ result, focus: opts.focus });
      emit('ui.checkShow', result);
    },
    notify: (payload) => notified.push(payload),
    settings: () => mainSettings,
    systemPaused: () => false,
    log: mainLog,
    now: () => mainNow,
    timers,
  });
  const deps: MainRpcDeps = {
    settings: {
      get: () => mainSettings,
      set: () => {
        throw new Error('not in this test');
      },
    },
    secrets: {
      status: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }),
      set: () => {
        throw new Error('not in this test');
      },
    },
    service: { callRaw: (method, params) => core.handle(method, params) },
    showQuickEntry: () => undefined,
    openItemInDashboard: () => undefined,
    appInfo: () => ({ version: '0.6.0', dataDir, logDir: path.join(root, 'logs'), platform: process.platform, electron: '', node: process.versions.node }),
    serviceState: () => ({ state: 'ready', detail: null, nextAttemptAt: null }),
    hotkeys: () => ({
      quickEntry: { accelerator: mainSettings.app.quickEntryHotkey, registered: true, error: null },
      check: { accelerator: mainSettings.check.hotkey, registered: true, error: null },
    }),
    // As main.ts: validated by the router, kept by the controller.
    armCheck: (arm) => {
      armCalls.push(arm);
      return ctl.arm(arm);
    },
    isAllowedExternalUrl,
    openExternal: async (url) => void opened.push(url),
    dialogs: {
      openHtmlFile: async () => null,
      openFolder: async () => null,
      saveFile: async () => null,
    },
    files: {
      stat: () => Promise.reject(new Error('not in this test')),
      readBytes: () => Promise.reject(new Error('not in this test')),
      writeText: () => Promise.reject(new Error('not in this test')),
    },
    log: mainLog,
  };
  const router = createRpcRouter(deps);
  const callCtx: RpcCallContext = { window: null, hideWindow: () => undefined };

  // Renderer: window.flipdesk as the preload exposes it, over main's router.
  doc = installDomShim();
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  // The sort picker is a <select>: React marks its options.
  if (!Object.getOwnPropertyDescriptor(ShimElement.prototype, 'options')) {
    Object.defineProperty(ShimElement.prototype, 'options', {
      configurable: true,
      get(this: ShimElement) {
        return this.tagName === 'SELECT' ? this.descendants().filter((e) => e.tagName === 'OPTION') : undefined;
      },
    });
  }
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  const location = { hash: '#/market' };
  win()['location'] = location;
  win()['history'] = { state: null, replaceState: (_s: unknown, _t: string, url: string) => (location.hash = url) };
  win()['dispatchEvent'] = () => undefined;
  const bridge: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: (method, params) => {
      pageCalls.push({ method, params });
      return router(callCtx, method, params) as never;
    },
    on: (event: PushEvent, fn) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      const f = fn as (p: unknown) => void;
      set.add(f);
      return () => set.delete(f);
    },
  };
  win()['flipdesk'] = bridge;
  ({ createRoot } = await import('react-dom/client'));
  ({ MarketPage } = await import('../../src/renderer/pages/MarketPage'));
  ({ CheckPopup } = await import('../../src/renderer/pages/CheckPopup'));
  ({ ToastStack } = await import('../../src/renderer/components/Feedback'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  // After react-dom has loaded: it reads navigator.userAgent as it loads.
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: async (text: string) => {
        clipboard = text;
      },
    },
  });
  // Tall enough that the virtual table renders every row.
  layout.clientHeight = 4_000;
});

const unmounts: (() => void)[] = [];
afterAll(async () => {
  while (unmounts.length) unmounts.pop()!();
  ctl?.stop();
  await core?.stop();
  resetBptfSocketGuard();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function mount(node: ReactNode): () => ShimElement[] {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const r = createRoot(container as unknown as Element);
  act(() => r.render(createElement(AppProvider, null, node)));
  unmounts.push(() => {
    act(() => r.unmount());
    doc.body.removeChild(container);
  });
  return () => container.descendants();
}

const click = async (target: ShimElement | undefined) => {
  expect(target).toBeDefined();
  act(() => {
    target!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
  await settle();
};

const list = async (): Promise<Map<string, MarketRow>> => new Map(((await core.handle('market.list', { limit: 2000 })) as MarketListResult).rows.map((r) => [r.sku, r]));

describe('F19 end to end: Live market -> scrap.tf in the browser -> Live check -> Save price', () => {
  it('links rows to the saved bank page or their category, opens it statically, checks the copied price as the item, then disarms', async () => {
    // ----- Service: a saved bank page gives its rows a 'seen' link (S1) -----
    await waitFor('the Live market build', async () => {
      const m = (await core.handle('market.list', {})) as MarketListResult;
      return !m.stats.building && [LISTED, UNLISTED].every((sku) => m.rows.some((r) => r.sku === sku && r.buyerCount > 0));
    });
    const before = await list();
    expect(before.get(LISTED)!.scraptfLink).toEqual({ bank: 'hats', url: 'https://scrap.tf/buy/hats', seenAt: null, source: 'category' });

    const imported = (await core.handle('import.html', { html: HATS, fileName: 'Hat Trading - TF2 - Scrap.TF.html', mtimeMs: SAVED_AT })) as ImportResult;
    expect(imported.bank).toBe('hats');
    const rows = await list();
    const listed = rows.get(LISTED)!;
    expect(listed.scraptfLink).toEqual({ bank: 'hats', url: 'https://scrap.tf/buy/hats', seenAt: SAVED_AT, source: 'seen' });
    // The drawer's "Seen on" agrees.
    const detail = (await core.handle('item.detail', { sku: LISTED, history: false })) as ItemDetail;
    expect(detail.seenOn).toEqual({ bank: 'hats', url: listed.scraptfLink.url, at: SAVED_AT });
    const unlisted = rows.get(UNLISTED)!;
    const bank = bankForCategory(unlisted.category);
    expect(bank).toBe('weapons');
    expect(unlisted.scraptfLink).toEqual({ bank, url: scraptfBankInfo(bank)!.url, seenAt: null, source: 'category' });
    for (const r of rows.values()) {
      expect(STATIC_EXTERNAL_URLS, r.sku).toContain(r.scraptfLink.url);
      if (r.scraptfLink.source === 'seen') expect(r.scraptfLink, r.sku).toMatchObject({ bank: 'hats', seenAt: SAVED_AT });
    }

    // ----- Main: the clipboard watcher is on and primed -----
    ctl.syncWatch();
    expect(ctl.watching()).toBe(true);

    // ----- Renderer: the Live market page, and the check popup window -----
    const probe = { itemSku: null as string | null };
    function Probe() {
      probe.itemSku = useApp().itemSku;
      return null;
    }
    const market = mount([createElement(MarketPage, { key: 'm' }), createElement(ToastStack, { key: 't' }), createElement(Probe, { key: 'p' })]);
    const popup = mount(createElement(CheckPopup));
    const rowOf = (sku: string): ShimElement | undefined =>
      market()
        .filter((e) => e.getAttribute('role') === 'row')
        .find((r) => r.descendants().some((e) => cls(e).split(' ').includes('item-name') && (e.getAttribute('title') ?? '').endsWith(`SKU ${sku}`)));
    const stfButton = (sku: string) => rowOf(sku)?.descendants().find((e) => e.tagName === 'BUTTON' && cls(e).split(' ').includes('m-stf'));
    await waitFor('both rows on the page', () => stfButton(LISTED) && stfButton(UNLISTED));

    // U1: the button names the page it opens: the saved one, or the category's bank.
    const seenBtn = stfButton(LISTED)!;
    expect(seenBtn.textContent).toBe('Hats');
    expect(cls(seenBtn)).toContain('seen');
    expect(seenBtn.getAttribute('title')).toMatch(/^Seen on scrap\.tf\/buy\/hats in your save 30 min ago\. Opens it and copies the name/);
    const catBtn = stfButton(UNLISTED)!;
    expect(catBtn.textContent).toBe('Weapons');
    expect(cls(catBtn)).not.toContain('seen');
    expect(catBtn.getAttribute('title')).toMatch(/^scrap\.tf's Weapons bank \(not in your saves yet\)\./);

    // ----- Out: click -> check.arm, copy, links.open with the static page -----
    pageCalls.length = 0;
    await click(seenBtn);
    await waitFor('the toast', () => market().find((e) => cls(e).includes('toast') && e.textContent.includes('Opened scrap.tf/buy/hats')));
    const name = listed.name;
    expect(armCalls).toEqual([{ sku: LISTED, name }]);
    // Armed before the copy (the watcher must already know the name), then the page opened.
    const order = pageCalls.map((c) => c.method).filter((m) => m === 'check.arm' || m === 'links.open');
    expect(order).toEqual(['check.arm', 'links.open']);
    expect(pageCalls.find((c) => c.method === 'check.arm')!.params).toEqual({ sku: LISTED, name });
    expect(clipboard).toBe(name);
    expect(opened).toEqual([SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url]);
    expect(opened[0]).toBe(listed.scraptfLink.url);
    expect(STATIC_EXTERNAL_URLS).toContain(opened[0]);
    // The button is not the row: no drawer. Main heard only these, and the name went to check.arm alone.
    expect(probe.itemSku).toBeNull();
    expect(pageCalls.some((c) => c.method === 'item.detail')).toBe(false);
    expect([...new Set(pageCalls.map((c) => c.method).filter((m) => (MAIN_METHODS as readonly string[]).includes(m)))].sort()).toEqual(['app.hotkeys', 'check.arm', 'links.open']);
    expect(pageCalls.filter((c) => c.method !== 'check.arm' && JSON.stringify(c.params ?? null).includes(name))).toEqual([]);
    const toast = market().find((e) => cls(e).includes('toast') && e.textContent.includes('Opened scrap.tf/buy/hats'))!;
    expect(toast.textContent).toContain('Copy the price there: the clipboard check picks it up, or press Ctrl+Alt+C.');

    // ----- M2: the watcher drops the app's own copy of the name, once -----
    watchTick!();
    await settle();
    expect(checks).toEqual([]);
    expect(popups).toEqual([]);
    expect(notified).toEqual([]);

    // ----- Back: the user copies the price on scrap.tf and presses the check hotkey -----
    clipboard = PRICE_TEXT;
    await act(() => ctl.hotkey());
    await settle();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ text: PRICE_TEXT, source: 'hotkey', hint: { sku: LISTED }, args: 3 });
    const hinted = checks[0]!.result;
    expect(hinted).toMatchObject({ status: 'item', sku: LISTED, name, price: { keys: 0, scrapRaw: 12, source: 'clipboard' } });
    expect(hinted.reason).toBe(checkHintedNote(name));
    expect(checkMatchedByHint(hinted)).toBe(true);
    expect(popups).toEqual([{ result: hinted, focus: true }]);
    const note = await waitFor('the popup', () => popup().find((e) => cls(e).includes('cp-note')));
    expect(note.textContent).toBe(CHECK_MATCHED_NOTE);

    // The hotkey's copy is not checked again by the watcher.
    watchTick!();
    await settle();
    expect(checks).toHaveLength(1);

    // The drop was once: the user copying the name later gets it checked (by name: text wins over the hint).
    clipboard = name;
    watchTick!();
    await waitFor('the watcher check', () => checks.length === 2);
    expect(checks[1]).toMatchObject({ text: name, source: 'watch', hint: { sku: LISTED } });
    expect(checks[1]!.result).toMatchObject({ status: 'item', sku: LISTED });
    expect(checkMatchedByHint(checks[1]!.result)).toBe(false);
    // Its popup waits out the 1.5 s gap (held by this test), so the popup still shows the hinted price.
    expect(heldPopups).toHaveLength(1);
    expect(popups).toHaveLength(1);

    // ----- M3: Save price writes the checked price, then disarms -----
    const save = popup().find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save price');
    await click(save);
    await waitFor('the disarm', () => armCalls.length === 2);
    expect(armCalls[1]).toBeNull();
    const writes = pageCalls.map((c) => c.method).filter((m) => m === 'prices.upsert' || m === 'check.arm');
    expect(writes.slice(-2)).toEqual(['prices.upsert', 'check.arm']);
    const saved = (await core.handle('item.detail', { sku: LISTED, history: false })) as ItemDetail;
    expect(saved.scrapPrices.some((p) => p.source === 'user' && p.costScrap === 12 && p.costKeys === 0)).toBe(true);

    // Disarmed: a bare price copied later is no item, and main sends it without a hint.
    mainNow += 2_000;
    clipboard = LATER_PRICE_TEXT;
    await act(() => ctl.hotkey());
    await settle();
    expect(checks).toHaveLength(3);
    expect(checks[2]).toMatchObject({ text: LATER_PRICE_TEXT, source: 'hotkey', hint: undefined, args: 2 });
    expect(checks[2]!.result).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON });

    // An arm also lapses by itself after CHECK_ARM_MS.
    expect(ctl.arm({ sku: LISTED, name }).armedUntil).toBe(mainNow + CHECK_ARM_MS);
    mainNow += CHECK_ARM_MS;
    clipboard = PRICE_TEXT;
    await act(() => ctl.hotkey());
    expect(checks.at(-1)).toMatchObject({ text: PRICE_TEXT, hint: undefined, args: 2 });
    expect(checks.at(-1)!.result.status).toBe('not-item');

    // ----- Boundary -----
    // Only the static bank page ever reached the browser, nothing was requested, and main logged no text.
    expect(opened).toEqual(['https://scrap.tf/buy/hats']);
    expect(requested).toEqual([]);
    const logged = JSON.stringify([mainLog.debug.mock.calls, mainLog.info.mock.calls, mainLog.warn.mock.calls, mainLog.error.mock.calls]);
    for (const text of [name, PRICE_TEXT, LATER_PRICE_TEXT]) expect(logged).not.toContain(text);
  });
});
