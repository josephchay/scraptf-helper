// F21 wired end to end, with Electron fakes (scraptfWindowFakes.ts): main's real settings store and IPC
// router, the real scrap.tf window manager, and the service's real 'import.html' handler over an
// in-memory repo with the real parser, bank stock cache and scrap.tf history.
//
// - The window cannot be turned on without saved-page import and both acknowledgements, and does nothing
//   while it is off.
// - It opens only a static start page, and nothing loads, reloads or steps it but a user action.
// - A scrap.tf page the user loaded is read once by READ_SCRIPT in isolated world 1001 (run here against a
//   stand-in document holding the fixture's DOM) and imported through 'import.html' with origin 'window'
//   and the page's address, giving the same batch a file save of that page gives.
// - Steam's sign-in (or any page that is not scrap.tf) is never read.
// - A page leaves the window only for the default browser, and only when the links allowlist accepts it.
// - links.open puts a static scrap.tf page in the window only when the user chose that.
//
// Offline (R1): the page is a synthetic fixture and the "browser" is a list; nothing is requested.

import { parse, serializeOuter } from 'parse5';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCRAPTF_BAR_URL } from '../../src/main/paths';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { isAllowedExternalUrl, SCRAPTF_BANKS, SCRAPTF_HOME_URL, SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import {
  EXTERNAL_OPEN_MIN_GAP_MS,
  IMPORT_HTML_ORIGIN_REFUSAL,
  READ_MANUAL_MIN_GAP_MS,
  READ_SCRIPT,
  READ_SETTLE_MS,
  READ_WORLD_ID,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_NEEDS_ACK,
  SCRAPTF_WINDOW_NEEDS_IMPORT,
  SCRAPTF_WINDOW_OFF,
} from '../../src/shared/scraptfWindowPolicy';
import type { ImportBatch, ImportResult, KeyPriceState, ScraptfWindowRead } from '../../src/shared/types';
import { readStatusText } from '../../src/renderer/scraptfWindowModel';
import { fixture } from '../import/mhtmlFixture';
import { createStubSchema } from '../import/schemaStub';
import { fake } from './scraptfWindowFakes';

vi.mock('electron', async () => (await import('./scraptfWindowFakes')).fakeElectron);

const { createScraptfWindowManager } = await import('../../src/main/scraptfWindow');
const { createRpcRouter } = await import('../../src/main/ipc');
const { createSettingsStore } = await import('../../src/main/settingsStore');

const T = 1_800_000_000_000;
const HOUR = 3_600_000;
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;
const WEAPONS = SCRAPTF_BANKS.find((b) => b.bank === 'weapons')!.url;
/** The saved hats page (synthetic markup, made-up ids and prices). */
const HATS_FILE = fixture('buy_hats.html');
const STEAM_LOGIN = 'https://steamcommunity.com/openid/login?openid.mode=checkid_setup&openid.return_to=https%3A%2F%2Fscrap.tf%2Flogin';
const BPTF = 'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable';
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: T, stale: false, quotes: [], scraptfFromList: null };
/** Text no log may hold: a URL query of the page the user is on. */
const QUERY_MARKER = 'Zq7WIRING';

type Contents = InstanceType<typeof fake.FakeContents>;

/** What READ_SCRIPT gives for a loaded page: its document element serialised (no doctype, no comment before it). */
function outerHtmlOf(html: string): string {
  const root = parse(html).childNodes.find((n) => n.nodeName === 'html');
  expect(root).toBeDefined();
  return serializeOuter(root!);
}

/** Runs the pinned script the way Chromium would, against a stand-in document holding `dom`. */
function runReadScript(code: string, dom: string | null): unknown {
  const document = dom === null ? {} : { documentElement: { outerHTML: dom } };
  return new Function('document', `return (${code});`)(document) as unknown;
}

/** Every item has buyers far above any price on the page. */
function entry(): MarketEval {
  const o = { listingId: 'l1', steamid: '76561198000000002', userName: 'KeyBot', keys: 0, metalScrap: 1e6, valueScrap: 1e6, isBot: true, online: true, lastEventAt: T, bumpedAt: null, details: '', flags: [], eligible: true };
  return {
    bestScrap: 1e6,
    consScrap: 1e6,
    instantScrap: 1e6,
    revenueScrap: 1e6,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 3,
    eligibleCount: 3,
    maxCostScrap: 1e6 - 100,
    confidence: 80,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: T,
    referenced: true,
  };
}

const repos: Repo[] = [];

beforeEach(() => {
  fake.FakeWin.all = [];
  fake.FakeView.all = [];
  fake.sessions.clear();
  fake.journal.length = 0;
  fake.session.fromPartition.mockClear();
});

afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function recordingLog(lines: string[], who: string): Logger {
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push(`${who} ${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  return { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

/** Main, the scrap.tf window and the service, as main.ts wires them. */
function world() {
  const clock = { t: T };
  const logs: string[] = [];
  const mainLog = recordingLog(logs, 'main');
  // settings.json: a first run (no file), written nowhere.
  const store = createSettingsStore({
    file: 'settings.json',
    log: mainLog,
    readFile: () => {
      throw Object.assign(new Error('no settings yet'), { code: 'ENOENT' });
    },
    writeFile: () => undefined,
    now: () => clock.t,
  });

  // The service: main sends it every settings change, so it reads main's current settings.
  const repo = openRepo(':memory:');
  repos.push(repo);
  const serviceLog = recordingLog(logs, 'service');
  const serviceClock = { now: () => clock.t };
  const e = entry();
  const stock = createBankStock({ clock: serviceClock, log: serviceLog, repo, market: { entryFor: () => e }, keyPrice: () => KEY, settings: () => store.get(), categoryOf: () => 'hats' });
  const history = createScraptfHistory({ clock: serviceClock, log: serviceLog, repo, market: { entryFor: () => e }, keyPrice: () => KEY });
  const pushes: { event: string; payload: unknown }[] = [];
  const quiet = () => undefined;
  const ctx = {
    clock: serviceClock,
    log: serviceLog,
    repo,
    http: {},
    schema: createStubSchema(),
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => store.get(),
    push: (event: string, payload: unknown) => void pushes.push({ event, payload }),
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    bankStock: stock,
    scraptfHistory: history,
    bankStockChanged: () => {
      stock.refresh();
      history.refresh();
    },
  } as unknown as HandlerContext;
  const service = createRpcHandlers(ctx);
  /** Every 'import.html' the service received, as it received it. */
  const imports: Record<string, unknown>[] = [];
  const serviceCall = (method: string, params: unknown) => {
    if (method === 'import.html') imports.push(structuredClone(params) as Record<string, unknown>);
    return service(method as never, params);
  };

  // The scrap.tf window: its only timer is the settle read, held here and fired by the test.
  const handles: { fn: () => void; cleared: boolean; fired: boolean; ms: number }[] = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const h = { fn, ms, cleared: false, fired: false };
      handles.push(h);
      return h;
    },
    clearTimeout: (h: unknown) => void ((h as { cleared: boolean }).cleared = true),
  };
  /** What reached the user's default browser (shell.openExternal), from the window or links.open. */
  const browser: string[] = [];
  const openExternal = async (url: string) => void browser.push(url);
  const m = createScraptfWindowManager({
    settings: () => store.get(),
    log: mainLog,
    preloadPath: 'C:/app/dist/preload.cjs',
    iconPath: 'C:/app/assets/icon.png',
    devTools: false,
    // main.ts: host.call('import.html', p), straight to the service.
    importHtml: (p) => serviceCall('import.html', p) as Promise<ImportResult>,
    openExternal,
    isQuitting: () => false,
    now: () => clock.t,
    timers,
  });
  // main.ts: turning the window off (or import, which turns it off) closes it.
  store.onChange((next, prev) => {
    if (prev.scraptfWindow.enabled && !next.scraptfWindow.enabled) m.close();
  });
  const route = createRpcRouter({
    settings: { get: () => store.get(), set: (patch: unknown) => store.set(patch) },
    secrets: { status: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }), set: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }) },
    service: { callRaw: (method: string, params: unknown) => serviceCall(method, params) },
    showQuickEntry: () => undefined,
    openItemInDashboard: () => undefined,
    appInfo: () => ({ version: '0.7.0', dataDir: 'd', logDir: 'l', platform: 'win32', electron: '44', node: '24' }),
    serviceState: () => null,
    hotkeys: () => ({ quickEntry: { accelerator: '', registered: false, error: null }, check: { accelerator: '', registered: false, error: null } }),
    armCheck: () => ({ armedUntil: null }),
    isAllowedExternalUrl,
    openExternal,
    scraptfWindow: m,
    dialogs: { openHtmlFile: async () => null, openFolder: async () => null, saveFile: async () => null },
    files: { stat: async () => ({ size: 1, mtimeMs: 1, isFile: () => true }), readBytes: async () => new Uint8Array(), writeText: async () => undefined },
    log: mainLog,
  });
  /** A call from a page (the dashboard or the window's toolbar), through the preload's one channel. */
  const call = (method: string, params?: unknown) => route({ window: null, hideWindow: () => undefined }, method, params);
  const refusal = (method: string, params?: unknown) =>
    call(method, params).then(
      () => null,
      (err: unknown) => (err as Error).message,
    );

  /** Turns the window on the way Settings does: import and its acknowledgement, then the window's. */
  const turnOn = async (window: Record<string, unknown> = {}) => {
    await call('settings.set', { import: { enabled: true, acknowledgedAt: clock.t - HOUR } });
    await call('settings.set', { scraptfWindow: { acknowledgedAt: clock.t - HOUR, enabled: true, ...window } });
  };
  const view = (): Contents => fake.FakeView.all.at(-1)!.webContents;
  const bar = (): Contents => fake.FakeWin.all.at(-1)!.webContents;
  const toolbarReady = () => {
    bar().emit('did-finish-load');
    fake.FakeWin.all.at(-1)!.emit('ready-to-show');
  };
  /** The user's browsing put `url` on screen with `dom` loaded (a new document, committed and loaded). */
  const land = (url: string, dom: string | null) => {
    const c = view();
    // Chromium runs the code given in the world given; this one holds the page's DOM. (The fake keeps
    // Electron's own wait for a main frame that is still loading.)
    c.runScript = (world: number, scripts: unknown[]) => {
      const [first] = scripts as { code: string }[];
      if (world !== READ_WORLD_ID || first === undefined) throw new Error('not the read world');
      return runReadScript(first.code, dom);
    };
    c.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    c.url = url;
    c.emit('did-navigate', {}, url, 200, 'OK');
    c.emit('did-finish-load');
  };
  const fireSettle = () => {
    for (const h of handles.filter((x) => !x.cleared && !x.fired)) {
      h.fired = true;
      h.fn();
    }
  };
  const reads = () => bar().sent.filter(([ch, ev]) => ch === 'push' && ev === 'scraptfWindow.read').map(([, , p]) => p as ScraptfWindowRead | null);
  /** The user's own click in the page (Chromium's 'input-event'). */
  const click = () => view().emit('input-event', {}, { type: 'mouseDown' });
  return { clock, store, repo, stock, history, pushes, imports, handles, browser, m, call, refusal, turnOn, view, bar, toolbarReady, land, fireSettle, reads, logs, click };
}

/** Lets the read's awaits (the script, the import) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

/** A batch without what names it or tells the two apart: id, file name and origin. */
function sansBatch(b: ImportBatch) {
  const { id: _id, fileName: _name, origin: _origin, ...rest } = b;
  return rest;
}

/** What a batch stored, without ids: its prices, bank stock rows and the bank's saves. */
function storedOf(repo: Repo, batchId: number) {
  const prices = repo
    .listScrapPrices()
    .filter((p) => p.importBatch === batchId)
    .map((p) => [p.sku, p.name, p.costKeys, p.costScrap, p.stock, p.assetId, p.observedAt, JSON.stringify(p.special)])
    .sort();
  const stock = repo.bankStockRows(batchId).map((r) => ({ ...r }));
  const saves = repo.bankStockSaves('hats').map(({ batchId: _id, ...s }) => s);
  return { prices, stock, saves };
}

describe('turning the scrap.tf window on (F21)', () => {
  it('is refused without saved-page import and both acknowledgements, and the window opens nothing while off', async () => {
    const w = world();
    expect(w.store.get().scraptfWindow).toMatchObject({ enabled: false, acknowledgedAt: null });
    expect(await w.refusal('settings.set', { scraptfWindow: { enabled: true } })).toContain(SCRAPTF_WINDOW_NEEDS_IMPORT);
    // The window's own acknowledgement does not stand in for import's.
    expect(await w.refusal('settings.set', { scraptfWindow: { enabled: true, acknowledgedAt: T } })).toContain(SCRAPTF_WINDOW_NEEDS_IMPORT);
    await w.call('settings.set', { import: { enabled: true, acknowledgedAt: T } });
    expect(await w.refusal('settings.set', { scraptfWindow: { enabled: true } })).toContain(SCRAPTF_WINDOW_NEEDS_ACK);
    expect(w.store.get().scraptfWindow.enabled).toBe(false);

    // Off: every action is refused and nothing is built, loaded or read.
    for (const [method, params] of [
      ['scraptfWindow.open', { start: HATS }],
      ['scraptfWindow.open', undefined],
      ['scraptfWindow.home', undefined],
      ['scraptfWindow.go', { url: WEAPONS }],
      ['scraptfWindow.reload', undefined],
      ['scraptfWindow.read', undefined],
    ] as const) {
      expect(await w.refusal(method, params)).toBe(SCRAPTF_WINDOW_OFF);
    }
    expect(fake.FakeWin.all).toHaveLength(0);
    expect(fake.FakeView.all).toHaveLength(0);
    expect(fake.journal).toEqual([]);

    // With the acknowledgement ticked, it turns on; it still builds nothing until the user opens it.
    await w.call('settings.set', { scraptfWindow: { acknowledgedAt: T, enabled: true } });
    expect(w.store.get().scraptfWindow).toMatchObject({ enabled: true, acknowledgedAt: T });
    expect(fake.FakeWin.all).toHaveLength(0);
    expect(fake.journal).toEqual([]);

    // Turning import off turns the window off with it, and closes an open window.
    await w.call('scraptfWindow.open', { start: HATS });
    const view = w.view();
    await w.call('settings.set', { import: { enabled: false } });
    expect(w.store.get().scraptfWindow.enabled).toBe(false);
    expect(view.closes).toBe(1);
    expect(fake.FakeWin.all.at(-1)!.destroyed).toBe(true);
    expect(await w.refusal('scraptfWindow.reload')).toBe(SCRAPTF_WINDOW_OFF);
    expect(fake.journal).toEqual([`load toolbar ${SCRAPTF_BAR_URL}`, `load view ${HATS}`]);
  });
});

describe('loads (F21)', () => {
  it('opens only a static start page, and nothing but a user action loads, reloads or steps the view', async () => {
    const w = world();
    await w.turnOn();
    // Not a static start page: refused before anything is built, and never quoted.
    for (const start of [`${HATS}?sort=new`, 'https://scrap.tf/trades', 'https://scrap.tf/ajax/', 'https://www.scrap.tf/buy/hats', 'http://scrap.tf/buy/hats', BPTF]) {
      const message = await w.refusal('scraptfWindow.open', { start });
      expect(message).not.toBeNull();
      expect(message).not.toContain(start);
    }
    expect(fake.FakeWin.all).toHaveLength(0);

    await w.call('scraptfWindow.open', { start: HATS });
    expect(w.view().loads).toEqual([[HATS]]);
    // Opening it again only brings it to the front.
    await w.call('scraptfWindow.open');
    expect(w.view().loads).toEqual([[HATS]]);
    w.toolbarReady();

    // Nothing the page or the app does on its own moves the view: events, failures, crashes, the settle timer.
    w.land(HATS, outerHtmlOf(HATS_FILE));
    await settle();
    const c = w.view();
    c.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', HATS, true);
    c.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    c.emit('did-navigate-in-page', {}, `${HATS}#top`, true);
    c.emit('did-start-loading');
    c.emit('did-stop-loading');
    w.fireSettle();
    await settle();
    w.clock.t += 10 * HOUR;
    w.fireSettle();
    await settle();
    expect(fake.journal).toEqual([`load toolbar ${SCRAPTF_BAR_URL}`, `load view ${HATS}`]);
    // The only timer was the one settle read.
    expect(w.handles.map((h) => h.ms)).toEqual([READ_SETTLE_MS]);

    // Each toolbar click is one move.
    c.canBack = true;
    await w.call('scraptfWindow.back');
    await w.call('scraptfWindow.go', { url: SCRAPTF_ITEMS_URL });
    await w.call('scraptfWindow.reload');
    await w.call('scraptfWindow.home');
    expect(fake.journal).toEqual([`load toolbar ${SCRAPTF_BAR_URL}`, `load view ${HATS}`, 'back view', `load view ${SCRAPTF_ITEMS_URL}`, 'reload view', `load view ${SCRAPTF_HOME_URL}`]);
    // Every load is the URL alone: no user agent, headers, referrer or body.
    expect(c.loads.every((args) => args.length === 1)).toBe(true);
    expect(c.setUserAgent).not.toHaveBeenCalled();
    for (const ses of fake.sessions.values()) expect(ses.cookieReads).toBe(0);
  });
});

describe('reading a page the user loaded (F21)', () => {
  it('runs READ_SCRIPT in world 1001 and imports the page as origin window: the same batch a file save of it makes', async () => {
    const w = world();
    await w.turnOn();
    await w.call('scraptfWindow.open', { start: HATS });
    w.toolbarReady();
    const address = `${HATS}?sort=${QUERY_MARKER}`;
    const dom = outerHtmlOf(HATS_FILE);
    expect(dom.startsWith('<html')).toBe(true);
    w.land(address, dom);
    await settle();
    // The load read, the pinned script in the isolated world; its snapshot waits for the settle read.
    expect(w.view().executeJavaScriptInIsolatedWorld.mock.calls).toEqual([[READ_WORLD_ID, [{ code: READ_SCRIPT }]]]);
    expect(w.imports).toEqual([]);
    w.fireSettle();
    await settle();

    // The settle read sees the same DOM: two reads, one look, one import.
    expect(w.view().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    // The service got the DOM with the page's address and origin 'window', from main alone.
    expect(w.imports).toEqual([{ html: dom, fileName: 'scrap.tf window /buy/hats', mtimeMs: T, address, origin: 'window' }]);
    const [batch] = w.repo.listImportBatches(5);
    expect(batch).toMatchObject({ origin: 'window', bank: 'hats', fileName: 'scrap.tf window /buy/hats', fileMtime: T });
    expect(batch!.itemCount).toBeGreaterThan(20);
    expect(w.pushes.map((p) => p.event)).toContain('import.done');
    const done = w.pushes.find((p) => p.event === 'import.done')!.payload as ImportResult;
    expect(done).toMatchObject({ origin: 'window', bank: 'hats', batchId: batch!.id });

    // The toolbar's status line: what was read, from where, never the query; of the warnings, the one that
    // matters most on screen, as its code and its counts in digits (0.7.1, F21-10: the fixture's unknown items
    // come before its card shown twice, which the import counts once and is no news). The prices stored and
    // the page's flips as the service reported them (UX-3).
    expect(done.warnings[0]).toMatch(/^duplicate-cards: /);
    expect(done.warnings.find((x) => x.startsWith('no-sku:'))).toMatch(/^no-sku: 3 of 38 items/);
    const best = done.topFlips?.[0];
    const flips = done.pageFlips === undefined ? {} : { pageFlips: done.pageFlips, bestFlip: best ? { sku: best.sku, name: best.name, profitScrap: best.profitScrap } : null };
    expect(w.reads()).toEqual([{ at: T, path: '/buy/hats', items: done.parsed, bank: 'hats', newFlips: 0, warning: 'no-sku: 3 38', stored: done.stored, ...flips }]);

    // The same page saved by the user as a file, imported through the router as the Import page does.
    const f = world();
    await f.turnOn();
    const file = (await f.call('import.html', { html: HATS_FILE, fileName: 'Hat Trading - TF2 - Scrap.TF.html', mtimeMs: T })) as ImportResult;
    expect(file.origin).toBe('file');
    const [fileBatch] = f.repo.listImportBatches(5);
    expect(fileBatch!.origin).toBe('file');
    expect(sansBatch(batch!)).toEqual(sansBatch(fileBatch!));
    expect(storedOf(w.repo, batch!.id)).toEqual(storedOf(f.repo, fileBatch!.id));
    // Window reads alone carry the flips for the toolbar (newFlips, 0.7.1 pageFlips and topFlips).
    const { batchId: _a, fileName: _b, origin: _c, newFlips: _d, pageFlips: _h, topFlips: _i, ...windowResult } = done;
    const { batchId: _e, fileName: _f, origin: _g, ...fileResult } = file;
    expect(windowResult).toEqual(fileResult);

    expect(w.repo.listImportBatches(5)).toHaveLength(1);

    // A page may not pass itself off as a window read.
    expect(await w.refusal('import.html', { html: dom, fileName: 'x.html', mtimeMs: T, address: HATS, origin: 'window' })).toBe(IMPORT_HTML_ORIGIN_REFUSAL);
    expect(await w.refusal('import.html', { html: dom, fileName: 'x.html', mtimeMs: T, origin: 'file' })).toBe(IMPORT_HTML_ORIGIN_REFUSAL);
    expect(w.repo.listImportBatches(5)).toHaveLength(1);

    // Nothing moved the view but the user's open, and no log holds the query.
    expect(fake.journal).toEqual([`load toolbar ${SCRAPTF_BAR_URL}`, `load view ${HATS}`]);
    expect(w.logs.join('\n')).not.toContain(QUERY_MARKER);
    expect(JSON.stringify(w.bar().sent)).not.toContain(QUERY_MARKER);
  });

  it("never reads Steam's sign-in, a challenge host or any page that is not scrap.tf", async () => {
    const w = world();
    await w.turnOn();
    await w.call('scraptfWindow.open', { start: HATS });
    w.toolbarReady();
    const c = w.view();
    // The user clicked "Sign in through Steam": the window keeps Steam's sign-in, and does not read it.
    const signIn = { url: STEAM_LOGIN, isMainFrame: true, isSameDocument: false, preventDefault: vi.fn() };
    c.emit('will-navigate', signIn);
    expect(signIn.preventDefault).not.toHaveBeenCalled();
    for (const url of [STEAM_LOGIN, 'https://steamcommunity.com/login/home/', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b', 'https://www.scrap.tf/buy/hats', 'http://scrap.tf/buy/hats']) {
      w.land(url, '<html><body><form><input name="password"></form></body></html>');
      c.emit('did-navigate-in-page', {}, url, true);
      await settle();
      w.clock.t += READ_MANUAL_MIN_GAP_MS;
      await expect(w.call('scraptfWindow.read')).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.notScraptf });
    }
    w.fireSettle();
    await settle();
    expect(c.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(w.handles).toEqual([]);
    expect(w.imports).toEqual([]);
    expect(w.repo.listImportBatches(5)).toEqual([]);
    expect(w.logs.join('\n')).not.toContain('openid.return_to');
  });
});

describe('leaving the window (F21)', () => {
  it('hands a page only to the default browser, and only when the links allowlist accepts it', async () => {
    const w = world();
    await w.turnOn();
    await w.call('scraptfWindow.open', { start: HATS });
    const c = w.view();
    const tried = [
      BPTF,
      'https://marketplace.tf/items/tf2/378;6',
      'https://evil.example/phish',
      'http://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable',
      'javascript:alert(1)',
      'file:///C:/Windows/win.ini',
      'https://user:pass@backpack.tf/',
      'https://steamcommunity.com/linkfilter/?url=https://evil.example/',
    ];
    for (const url of tried) {
      w.clock.t += EXTERNAL_OPEN_MIN_GAP_MS;
      w.click();
      const event = { url, isMainFrame: true, isSameDocument: false, preventDefault: vi.fn() };
      c.emit('will-navigate', event);
      // Nothing outside scrap.tf and Steam's sign-in loads in the window.
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      w.clock.t += EXTERNAL_OPEN_MIN_GAP_MS;
      w.click();
      expect(c.openHandler!({ url })).toEqual({ action: 'deny' });
    }
    await settle();
    const allowed = tried.filter((u) => isAllowedExternalUrl(u));
    expect(allowed).toEqual([BPTF, 'https://marketplace.tf/items/tf2/378;6']);
    // Each allowlisted page reached the browser once from the click and once from the popup; nothing else did.
    expect(w.browser).toEqual(allowed.flatMap((u) => [u, u]));
    expect(w.browser.every((u) => isAllowedExternalUrl(u))).toBe(true);
    // A page that sends the user away in a burst gets one browser tab per click, not a stream of them.
    const before = w.browser.length;
    w.clock.t += EXTERNAL_OPEN_MIN_GAP_MS;
    w.click();
    for (let i = 0; i < 5; i++) c.emit('will-navigate', { url: BPTF, isMainFrame: true, isSameDocument: false, preventDefault: vi.fn() });
    await settle();
    expect(w.browser.length - before).toBe(1);
    // And none at all without one, however long it keeps trying.
    for (let i = 0; i < 30; i++) {
      w.clock.t += EXTERNAL_OPEN_MIN_GAP_MS;
      c.emit('will-navigate', { url: BPTF, isMainFrame: true, isSameDocument: false, preventDefault: vi.fn() });
      c.openHandler!({ url: BPTF });
    }
    await settle();
    expect(w.browser.length - before).toBe(1);
    expect(fake.journal).toEqual([`load toolbar ${SCRAPTF_BAR_URL}`, `load view ${HATS}`]);
  });
});

describe('links.open and the window (F21)', () => {
  it('opens a static scrap.tf page in the window only when the user chose that; everything else stays in the browser', async () => {
    const w = world();
    await w.turnOn();
    // The choice is off: the app's scrap.tf links go to the browser, as before 0.7.
    await expect(w.call('links.open', { url: HATS })).resolves.toEqual({ opened: true, reason: null });
    expect(w.browser).toEqual([HATS]);
    expect(fake.FakeWin.all).toHaveLength(0);

    await w.call('settings.set', { scraptfWindow: { openLinksInWindow: true } });
    // Only an open worded for the window says allowWindow (the market, drawer, menu and banks opens).
    await expect(w.call('links.open', { url: WEAPONS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    expect(w.view().loads).toEqual([[WEAPONS]]);
    await expect(w.call('links.open', { url: SCRAPTF_ITEMS_URL, allowWindow: true })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    expect(w.view().loads).toEqual([[WEAPONS], [SCRAPTF_ITEMS_URL]]);
    // "Open in browser" on the Bank stock page, say: the browser, as its words promise.
    await expect(w.call('links.open', { url: HATS })).resolves.toEqual({ opened: true, reason: null });
    // Any other page goes to the browser exactly as before; a scrap.tf page that is not static goes nowhere.
    await expect(w.call('links.open', { url: BPTF, allowWindow: true })).resolves.toEqual({ opened: true, reason: null });
    const other = (await w.call('links.open', { url: `${HATS}?sort=new`, allowWindow: true })) as { opened: boolean; openedIn?: string };
    expect(other.opened).toBe(false);
    expect(other.openedIn).toBeUndefined();
    expect(w.browser).toEqual([HATS, HATS, BPTF]);
    expect(w.view().loads).toEqual([[WEAPONS], [SCRAPTF_ITEMS_URL]]);

    // With the window turned off again, links go back to the browser and the window is closed.
    await w.call('settings.set', { scraptfWindow: { enabled: false } });
    expect(w.view().closes).toBe(1);
    await expect(w.call('links.open', { url: HATS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null });
    expect(w.browser).toEqual([HATS, HATS, BPTF, HATS]);
    expect(fake.journal.filter((j) => j.startsWith('load view'))).toEqual([`load view ${WEAPONS}`, `load view ${SCRAPTF_ITEMS_URL}`]);
  });
});

/** The hats fixture without its card C03 (a painted Wise Whiskers): a page before scrap.tf added that card. */
function withoutCardC03(html: string): string {
  const from = html.indexOf('<!-- C03');
  const to = html.indexOf('<!-- C04');
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return html.slice(0, from) + html.slice(to);
}

describe('one look at a page is one save (F21)', () => {
  it('imports a load and its settle read once, compared with the previous save: a late card is neither gone nor new', async () => {
    const w = world();
    await w.turnOn();
    // Yesterday the user saved the whole hats page as a file.
    const DAY = 24 * HOUR;
    await w.call('import.html', { html: HATS_FILE, fileName: 'Hat Trading - TF2 - Scrap.TF.html', mtimeMs: T - DAY });
    await w.call('scraptfWindow.open', { start: HATS });
    w.toolbarReady();
    // Today the window's load read sees the page before scrap.tf added card C03; the settle read sees it all.
    w.land(HATS, outerHtmlOf(withoutCardC03(HATS_FILE)));
    await settle();
    const full = outerHtmlOf(HATS_FILE);
    w.view().runScript = (_world, scripts) => runReadScript((scripts as { code: string }[])[0]!.code, full);
    w.clock.t += READ_SETTLE_MS;
    w.fireSettle();
    await settle();

    // One window batch, of the full page, at the load's time.
    const batches = w.repo.listImportBatches(5);
    expect(batches.map((b) => [b.origin, b.fileMtime])).toEqual([
      ['window', T],
      ['file', T - DAY],
    ]);
    expect(w.imports.filter((p) => p.origin === 'window').map((p) => p.html)).toEqual([full]);
    // Nothing went and came back: no history event for the card that was late on screen.
    expect(w.repo.scraptfEvents({ bank: 'hats' }).filter((e) => e.name === 'Wise Whiskers')).toEqual([]);
    // The bank stock compares today's look with yesterday's save: nothing is new, so no new flip either.
    const stock = w.stock.list({ bank: 'hats', filter: 'new' }, w.clock.t);
    expect(stock.previousSavedAt).toBe(T - DAY);
    expect(stock.rows.map((r) => r.name)).toEqual([]);
    expect(stock.counts.newFlips).toBe(0);
    expect(w.reads()).toHaveLength(1);
    expect(w.reads()[0]).toMatchObject({ path: '/buy/hats', bank: 'hats', newFlips: 0 });
  });

  it('says a bank page read before its cards arrived has no items on screen yet, not nothing to import', async () => {
    const w = world();
    await w.turnOn();
    await w.call('scraptfWindow.open', { start: HATS });
    w.toolbarReady();
    const empty =
      '<html><head><meta property="og:url" content="https://scrap.tf/buy/hats"></head><body id="pid-buy-hats"><div id="buy-container" class="items-container rev-items-container"></div></body></html>';
    w.land(HATS, empty);
    await settle();
    w.fireSettle();
    await settle();
    expect(w.repo.listImportBatches(5)).toEqual([]);
    const read = w.reads().at(-1)!;
    expect(read).toMatchObject({ path: '/buy/hats', items: 0, bank: 'hats', warning: 'no-cards-saved' });
    expect(readStatusText(read, read.at)).toBe('Read 0 items from /buy/hats · no items on screen yet; wait for them, then Read page now · just now');
  });

  it('imports a scrap.tf page whose path is longer than an import file name may be', async () => {
    const w = world();
    await w.turnOn();
    await w.call('scraptfWindow.open', { start: HATS });
    w.toolbarReady();
    w.land(`${HATS}/${'x'.repeat(240)}`, outerHtmlOf(HATS_FILE));
    await settle();
    w.fireSettle();
    await settle();
    expect(w.reads().at(-1)!.warning).not.toBe(SCRAPTF_READ_REASONS.failed);
    const [batch] = w.repo.listImportBatches(5);
    expect(batch).toMatchObject({ origin: 'window', bank: 'hats' });
    expect((w.imports[0]!.fileName as string).length).toBeLessThanOrEqual(260);
    expect(w.logs.join('\n')).not.toContain('could not be imported');
  });

  it("clears the toolbar's last read when Settings logs out, not only its own button", async () => {
    const w = world();
    await w.turnOn({ readOnLoad: false });
    await w.call('scraptfWindow.open', { start: HATS });
    w.toolbarReady();
    w.land(HATS, outerHtmlOf(HATS_FILE));
    await w.call('scraptfWindow.read');
    expect(w.reads().at(-1)).toMatchObject({ path: '/buy/hats' });
    // Settings > scrap.tf window > Log out & clear (the router call SettingsPage makes).
    await w.call('scraptfWindow.clear');
    expect(w.reads().at(-1)).toBeNull();
    expect((await w.call('scraptfWindow.state')) as { lastRead: unknown }).toMatchObject({ lastRead: null });
  });
});
