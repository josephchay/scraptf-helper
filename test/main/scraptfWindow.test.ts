// F21: the scrap.tf window module against Electron fakes. The window loads a page only when the user asks
// (open, a toolbar control, Log out & clear), applies scraptfWindowPolicy to every navigation, frame and
// popup, reads only scrap.tf pages with the pinned READ_SCRIPT (on load, one settle read, Read page now),
// dedupes and throttles those reads, imports them as origin 'window', and never sets a user agent, reads
// a cookie or logs page content or a URL query.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCRAPTF_BAR_URL } from '../../src/main/paths';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { IMPORT_SCHEMA_LOADING_MESSAGE } from '../../src/shared/importCodes';
import { SCRAPTF_BANKS, SCRAPTF_HOME_URL, SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import {
  EXTERNAL_OPEN_MIN_GAP_MS,
  READ_AUTO_MIN_GAP_MS,
  READ_DEDUPE_MS,
  READ_MANUAL_MIN_GAP_MS,
  READ_MAX_CHARS,
  READ_SCRIPT,
  READ_SETTLE_MS,
  READ_WORLD_ID,
  SCRAPTF_NOT_READ_AGAIN,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_NOTICES,
  SCRAPTF_WINDOW_OFF,
  USER_ACTIVATION_MS,
} from '../../src/shared/scraptfWindowPolicy';
import type { ImportResult, ScraptfWindowNav, ScraptfWindowRead, Settings } from '../../src/shared/types';
import { fake, fakeScreen } from './scraptfWindowFakes';

vi.mock('electron', async () => (await import('./scraptfWindowFakes')).fakeElectron);

const {
  createScraptfWindowManager,
  SCRAPTF_MEMORY_PARTITION,
  SCRAPTF_NOTHING_TO_IMPORT,
  SCRAPTF_PERSIST_PARTITION,
  SCRAPTF_START_REFUSAL,
  SCRAPTF_TOOLBAR_HEIGHT,
  SCRAPTF_WINDOW_TITLE,
  scraptfPartition,
  scraptfViewWebPreferences,
} = await import('../../src/main/scraptfWindow');
type Deps = import('../../src/main/scraptfWindow').ScraptfWindowDeps;
type ImportParams = import('../../src/main/scraptfWindow').WindowImportParams;
const { createRpcRouter } = await import('../../src/main/ipc');
const { DARK_BACKGROUND, windowWebPreferences } = await import('../../src/main/windows');

const T = 1_791_958_000_000;
const bankUrl = (bank: string) => SCRAPTF_BANKS.find((b) => b.bank === bank)!.url;
const HATS = bankUrl('hats');
const WEAPONS = bankUrl('weapons');
const PRELOAD = 'C:/app/dist/preload.cjs';
const ICON = 'C:/app/assets/icon.png';
/** Text that must never reach a log: page content and a URL query. */
const PAGE_MARKER = 'Zq7-PAGE-MARKER';
const QUERY_MARKER = 'Zq7QUERY';
const STEAM_LOGIN = 'https://steamcommunity.com/openid/login?openid.return_to=https%3A%2F%2Fscrap.tf%2Flogin';
const BPTF = 'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable';
const BPTF_2 = 'https://backpack.tf/stats/Unique/Bill%27s%20Hat/Tradable/Craftable';

type Win = InstanceType<typeof fake.FakeWin>;
type Contents = InstanceType<typeof fake.FakeContents>;

beforeEach(() => {
  fake.FakeWin.all = [];
  fake.FakeView.all = [];
  fake.sessions.clear();
  fake.journal.length = 0;
  fake.session.fromPartition.mockClear();
});

function windowSettings(over: Partial<Settings['scraptfWindow']> = {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.import = { ...s.import, enabled: true, acknowledgedAt: T };
  s.scraptfWindow = { ...s.scraptfWindow, enabled: true, acknowledgedAt: T, ...over };
  return s;
}

function importResult(over: Partial<ImportResult> = {}): ImportResult {
  return {
    batchId: 7,
    fileName: 'scrap.tf window /buy/hats',
    pageKind: 'buy',
    parsed: 48,
    stored: 48,
    skipped: [],
    warnings: [],
    bank: 'hats',
    origin: 'window',
    newFlips: 2,
    ...over,
  };
}

interface Handle {
  fn: () => void;
  ms: number;
  cleared: boolean;
  fired: boolean;
}

function setup(over: Partial<Settings['scraptfWindow']> = {}, depsOver: Partial<Deps> = {}) {
  const ctl = { settings: windowSettings(over), t: T, quitting: false };
  const handles: Handle[] = [];
  const timers = {
    setTimeout: vi.fn((fn: () => void, ms: number) => {
      const h: Handle = { fn, ms, cleared: false, fired: false };
      handles.push(h);
      return h;
    }),
    clearTimeout: vi.fn((h: unknown) => {
      (h as Handle).cleared = true;
    }),
  };
  const importHtml = vi.fn(async (_p: ImportParams) => importResult());
  const openExternal = vi.fn(async (_url: string) => undefined);
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onStateChanged = vi.fn();
  const deps: Deps = {
    settings: () => ctl.settings,
    log,
    preloadPath: PRELOAD,
    iconPath: ICON,
    devTools: false,
    importHtml,
    openExternal,
    isQuitting: () => ctl.quitting,
    onStateChanged,
    now: () => ctl.t,
    timers,
    ...depsOver,
  };
  const m = createScraptfWindowManager(deps);
  const win = (): Win => fake.FakeWin.all.at(-1)!;
  const view = () => fake.FakeView.all.at(-1)!;
  const wc = (): Contents => view().webContents;
  const bar = (): Contents => win().webContents;
  /** The toolbar's page loaded and painted. */
  const toolbarReady = () => {
    bar().emit('did-finish-load');
    win().emit('ready-to-show');
  };
  /** A page the user's browsing loaded in the view (a new document). */
  const land = (url: string, html?: unknown) => {
    const c = wc();
    c.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    c.url = url;
    if (html !== undefined) c.html = html;
    c.emit('did-navigate', {}, url, 200, 'OK');
    c.emit('did-finish-load');
  };
  const pending = () => handles.filter((h) => !h.cleared && !h.fired);
  /** Fires every settle timer still pending (the module's only timer). */
  const fireTimers = () => {
    for (const h of pending()) {
      h.fired = true;
      h.fn();
    }
  };
  const pushes = <T = unknown>(event: string): T[] => bar().sent.filter(([ch, e]) => ch === 'push' && e === event).map(([, , p]) => p as T);
  const logged = () => JSON.stringify([log.debug.mock.calls, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
  /** The user's own input to the view (Chromium's 'input-event'): a click by default. */
  const click = (type = 'mouseDown') => wc().emit('input-event', {}, { type });
  /** The load read's awaits, then its settle read (the cycle's one import), then that read's awaits. */
  const settle = async () => {
    await flush();
    fireTimers();
    await flush();
  };
  return { m, ctl, handles, timers, importHtml, openExternal, log, onStateChanged, win, view, wc, bar, toolbarReady, land, pending, fireTimers, pushes, logged, click, settle };
}

/** Lets the read's awaits (script, import) run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function navEvent(url: string, isMainFrame = true) {
  return { url, isMainFrame, isSameDocument: false, preventDefault: vi.fn() };
}

describe('partitions', () => {
  it('keeps the session in memory unless the user asked to stay logged in', () => {
    expect(scraptfPartition(false)).toBe(SCRAPTF_MEMORY_PARTITION);
    expect(scraptfPartition(true)).toBe(SCRAPTF_PERSIST_PARTITION);
    expect(SCRAPTF_MEMORY_PARTITION).toBe('scraptf');
    expect(SCRAPTF_PERSIST_PARTITION).toBe('persist:scraptf');
  });
});

describe('scraptfViewWebPreferences', () => {
  it('has no preload, a sandbox, isolation, no Node and web security, on the given partition', () => {
    const p = scraptfViewWebPreferences('scraptf', false);
    expect(p).toEqual({
      partition: 'scraptf',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: false,
    });
    expect('preload' in p).toBe(false);
    expect('additionalArguments' in p).toBe(false);
    expect(scraptfViewWebPreferences('persist:scraptf', true)).toMatchObject({ partition: 'persist:scraptf', devTools: true });
  });
});

describe('opening the window', () => {
  it('builds nothing and loads nothing until the user opens it', () => {
    const s = setup();
    expect(fake.FakeWin.all).toHaveLength(0);
    expect(fake.FakeView.all).toHaveLength(0);
    expect(fake.session.fromPartition).not.toHaveBeenCalled();
    expect(s.m.state()).toEqual({ open: false, url: null, canGoBack: false, canGoForward: false, lastRead: null });
    expect(s.m.focus()).toBe(false);
    expect(s.m.ownsContents({})).toBe(false);
    expect(fake.journal).toEqual([]);
  });

  it('opens an app:// toolbar over a preload-free, hardened scrap.tf view and loads Home', () => {
    const s = setup();
    s.m.open();
    expect(fake.FakeWin.all).toHaveLength(1);
    expect(fake.FakeView.all).toHaveLength(1);
    const w = s.win();
    expect(w.opts).toMatchObject({ title: SCRAPTF_WINDOW_TITLE, show: false, backgroundColor: DARK_BACKGROUND, icon: ICON });
    expect(w.opts.webPreferences).toEqual(windowWebPreferences('scraptf', PRELOAD, false));
    // The view: exactly the locked-down preferences, on the in-memory partition, no preload.
    expect(s.view().opts).toEqual({ webPreferences: scraptfViewWebPreferences(SCRAPTF_MEMORY_PARTITION, false) });
    expect(JSON.stringify(s.view().opts)).not.toContain('preload');
    expect(w.children).toEqual([s.view()]);
    expect(s.view().bounds).toEqual({ x: 0, y: SCRAPTF_TOOLBAR_HEIGHT, width: 1280, height: 900 - SCRAPTF_TOOLBAR_HEIGHT });
    // The session is hardened before the first load: every permission and download refused.
    const ses = fake.sessions.get(SCRAPTF_MEMORY_PARTITION)!;
    expect(ses.requestHandler).not.toBeNull();
    let granted: boolean | null = null;
    ses.requestHandler!({}, 'notifications', (g: boolean) => (granted = g), {});
    expect(granted).toBe(false);
    expect(ses.count('will-download')).toBe(1);
    expect(fake.sessions.has(SCRAPTF_PERSIST_PARTITION)).toBe(false);
    // The toolbar is the app's own page; the view gets Home, with no load options at all.
    expect(fake.journal).toEqual([`load toolbar ${SCRAPTF_BAR_URL}`, `load view ${SCRAPTF_HOME_URL}`]);
    expect(s.wc().loads).toEqual([[SCRAPTF_HOME_URL]]);
    expect(s.wc().openHandler).not.toBeNull();
    expect(s.m.ownsContents(s.wc())).toBe(true);
    expect(s.m.ownsContents(s.bar())).toBe(false);
    expect(s.onStateChanged).toHaveBeenCalled();
  });

  it('shows the window after its first paint, and brings it back when it is minimised', () => {
    const s = setup();
    s.m.open();
    expect(s.win().visible).toBe(false);
    s.toolbarReady();
    expect(s.win().visible).toBe(true);
    s.win().minimized = true;
    s.win().visible = false;
    expect(s.m.focus()).toBe(true);
    expect(s.win().minimized).toBe(false);
    expect(s.win().visible).toBe(true);
    expect(s.win().focused).toBe(true);
  });

  it('opens on a static start page, and on an open window loads only a page the user asked for', () => {
    const s = setup();
    s.m.open(HATS);
    expect(s.wc().loads).toEqual([[HATS]]);
    s.m.open();
    expect(s.wc().loads).toEqual([[HATS]]);
    s.m.open(SCRAPTF_ITEMS_URL);
    expect(s.wc().loads).toEqual([[HATS], [SCRAPTF_ITEMS_URL]]);
    expect(fake.FakeWin.all).toHaveLength(1);
    expect(fake.FakeView.all).toHaveLength(1);
  });

  it('refuses any page but a static start page, before building anything, without quoting it', () => {
    const s = setup();
    for (const url of [`${HATS}?q=${QUERY_MARKER}`, `${HATS}/`, 'http://scrap.tf/', 'https://www.scrap.tf/', HATS.toUpperCase(), 'https://evil.example/', 'https://scrap.tf/ajax/']) {
      expect(() => s.m.open(url)).toThrow(SCRAPTF_START_REFUSAL);
      expect(() => s.m.go(url)).toThrow(SCRAPTF_START_REFUSAL);
    }
    expect(SCRAPTF_START_REFUSAL).not.toMatch(/https?:/);
    expect(fake.FakeWin.all).toHaveLength(0);
    expect(fake.journal).toEqual([]);
  });

  it('opens nothing while the window is turned off, while quitting or after dispose', () => {
    const off = setup({ enabled: false });
    expect(() => off.m.open()).toThrow(SCRAPTF_WINDOW_OFF);
    const quitting = setup();
    quitting.ctl.quitting = true;
    quitting.m.open(HATS);
    const disposed = setup();
    disposed.m.dispose();
    disposed.m.open(HATS);
    disposed.m.home();
    disposed.m.go(HATS);
    expect(fake.FakeWin.all).toHaveLength(0);
    expect(fake.journal).toEqual([]);
  });

  it('uses the on-disk partition only when the user chose to stay logged in', () => {
    const s = setup({ keepLoggedIn: true });
    s.m.open();
    expect(s.view().opts.webPreferences.partition).toBe(SCRAPTF_PERSIST_PARTITION);
    expect(fake.sessions.has(SCRAPTF_MEMORY_PARTITION)).toBe(false);
    expect(fake.sessions.get(SCRAPTF_PERSIST_PARTITION)!.requestHandler).not.toBeNull();
  });

  it('applies a keepLoggedIn change only when the window is closed and opened again (F21-6)', () => {
    const s = setup();
    s.m.open(HATS);
    const first = s.view();
    const firstWin = s.win();
    expect(s.m.state().pendingPartitionChange).toBeUndefined();
    s.ctl.settings = windowSettings({ keepLoggedIn: true });
    // An open window keeps the view the user is signed in on: no rebuild, no load, on any click.
    s.m.go(WEAPONS);
    s.m.open();
    s.m.open(SCRAPTF_ITEMS_URL);
    expect(fake.FakeWin.all).toHaveLength(1);
    expect(fake.FakeView.all).toHaveLength(1);
    expect(first.webContents.closes).toBe(0);
    expect(first.opts.webPreferences.partition).toBe(SCRAPTF_MEMORY_PARTITION);
    expect(first.webContents.loads).toEqual([[HATS], [WEAPONS], [SCRAPTF_ITEMS_URL]]);
    expect(fake.sessions.has(SCRAPTF_PERSIST_PARTITION)).toBe(false);
    // The toolbar is told the change waits for a reopen; changing it back clears that.
    expect(s.m.state().pendingPartitionChange).toBe(true);
    s.ctl.settings = windowSettings({ keepLoggedIn: false });
    expect(s.m.state().pendingPartitionChange).toBeUndefined();
    s.ctl.settings = windowSettings({ keepLoggedIn: true });
    // Closed and opened again: a new window, on the new partition, on Home.
    s.m.close();
    expect(s.m.state().pendingPartitionChange).toBeUndefined();
    s.m.open();
    expect(fake.FakeWin.all).toHaveLength(2);
    expect(fake.FakeView.all).toHaveLength(2);
    expect(firstWin.destroyed).toBe(true);
    expect(first.webContents.closes).toBe(1);
    expect(s.view().opts.webPreferences.partition).toBe(SCRAPTF_PERSIST_PARTITION);
    expect(s.wc().loads).toEqual([[SCRAPTF_HOME_URL]]);
    expect(s.m.state().pendingPartitionChange).toBeUndefined();
    expect(s.m.ownsContents(first.webContents)).toBe(false);
    expect(s.m.ownsContents(s.wc())).toBe(true);
    // Events from the old view no longer count.
    first.webContents.url = HATS;
    first.webContents.emit('did-finish-load');
    expect(first.webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it('keeps the view under the toolbar as the window is resized', () => {
    const s = setup();
    s.m.open();
    s.win().content = { x: 0, y: 0, width: 900, height: 600 };
    s.win().emit('resize');
    expect(s.view().bounds).toEqual({ x: 0, y: SCRAPTF_TOOLBAR_HEIGHT, width: 900, height: 600 - SCRAPTF_TOOLBAR_HEIGHT });
    s.win().content = { x: 0, y: 0, width: 1920, height: 1040 };
    s.win().emit('maximize');
    expect(s.view().bounds).toEqual({ x: 0, y: SCRAPTF_TOOLBAR_HEIGHT, width: 1920, height: 1040 - SCRAPTF_TOOLBAR_HEIGHT });
    for (const e of ['unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) expect(s.win().count(e)).toBe(1);
  });

  it('keeps its own title whatever the toolbar page is called', () => {
    const s = setup();
    s.m.open();
    const e = { preventDefault: vi.fn() };
    s.win().emit('page-title-updated', e, 'Other');
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe('never a user agent, a cookie or a script beyond the read', () => {
  it('sets no user agent and reads no cookie, through a whole session of use', async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS);
    await flush();
    s.fireTimers();
    await flush();
    s.wc().canBack = true;
    s.m.back();
    s.m.reload();
    await s.m.readNow();
    await s.m.clear();
    s.m.close();
    for (const c of [s.wc(), s.bar()]) {
      expect(c.setUserAgent).not.toHaveBeenCalled();
      expect(c.executeJavaScript).not.toHaveBeenCalled();
      expect(c.sendInputEvent).not.toHaveBeenCalled();
      expect(c.insertCSS).not.toHaveBeenCalled();
      expect(c.focus).not.toHaveBeenCalled();
    }
    for (const ses of fake.sessions.values()) {
      expect(ses.setUserAgent).not.toHaveBeenCalled();
      expect(ses.cookieReads).toBe(0);
      // No request filter or header rewriting on the window's session.
      expect(ses.webRequest.onBeforeRequest).not.toHaveBeenCalled();
      expect(ses.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
      expect(ses.webRequest.onHeadersReceived).not.toHaveBeenCalled();
    }
    // Every load is a bare URL: no user agent, headers, referrer or body.
    for (const load of s.wc().loads) expect(load).toHaveLength(1);
    // The only script ever run in the view is the pinned read, in its own world.
    for (const call of s.wc().executeJavaScriptInIsolatedWorld.mock.calls) expect(call).toEqual([READ_WORLD_ID, [{ code: READ_SCRIPT }]]);
    expect(s.bar().executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });
});

describe('navigation inside the window (the user clicks in the page)', () => {
  it('keeps scrap.tf and Steam sign-in in the window', () => {
    const s = setup();
    s.m.open();
    for (const url of [HATS, 'https://scrap.tf/profile/76561198000000001', STEAM_LOGIN, 'https://steamcommunity.com/login/home/']) {
      for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
        const e = navEvent(url);
        s.wc().emit(event, e);
        expect(e.preventDefault, `${event} ${url}`).not.toHaveBeenCalled();
      }
    }
    expect(s.openExternal).not.toHaveBeenCalled();
  });

  it('sends an allowlisted page to the browser after the user clicks (one tab per click) and drops everything else', () => {
    const s = setup();
    s.m.open();
    s.click();
    const e1 = navEvent(BPTF);
    s.wc().emit('will-frame-navigate', e1);
    // will-navigate fires for the same click: prevented again, opened once.
    const e2 = navEvent(BPTF);
    s.wc().emit('will-navigate', e2);
    expect(e1.preventDefault).toHaveBeenCalled();
    expect(e2.preventDefault).toHaveBeenCalled();
    expect(s.openExternal.mock.calls).toEqual([[BPTF]]);
    s.ctl.t += EXTERNAL_OPEN_MIN_GAP_MS - 1;
    s.click();
    s.wc().emit('will-navigate', navEvent(BPTF_2));
    expect(s.openExternal).toHaveBeenCalledTimes(1);
    // That click still lets one link out (a server redirect after it, say).
    s.ctl.t += 1;
    const r = navEvent(BPTF_2);
    s.wc().emit('will-redirect', r);
    expect(r.preventDefault).toHaveBeenCalled();
    expect(s.openExternal.mock.calls).toEqual([[BPTF], [BPTF_2]]);
    s.ctl.t += EXTERNAL_OPEN_MIN_GAP_MS;
    for (const url of ['https://evil.example/', 'http://scrap.tf/', 'https://www.scrap.tf/', 'javascript:alert(1)', 'file:///C:/x.html', 'https://steamcommunity.com/linkfilter/?u=https://evil.example']) {
      for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
        const e = navEvent(url);
        s.wc().emit(event, e);
        expect(e.preventDefault, `${event} ${url}`).toHaveBeenCalled();
      }
    }
    expect(s.openExternal).toHaveBeenCalledTimes(2);
    // Nothing was loaded into the view by any of it.
    expect(s.wc().loads).toEqual([[SCRAPTF_HOME_URL]]);
  });

  it('lets only scrap.tf, the Cloudflare check and Steam sign-in load in frames, and opens no frame outside', () => {
    const s = setup();
    s.m.open();
    for (const url of ['https://scrap.tf/frame', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/', STEAM_LOGIN, 'about:blank', 'about:srcdoc']) {
      for (const event of ['will-frame-navigate', 'will-redirect']) {
        const e = navEvent(url, false);
        s.wc().emit(event, e);
        expect(e.preventDefault, `${event} ${url}`).not.toHaveBeenCalled();
      }
    }
    for (const url of ['https://ads.example/frame', BPTF, 'https://www.youtube.com/embed/x', 'data:text/html,x', 'http://scrap.tf/']) {
      for (const event of ['will-frame-navigate', 'will-redirect']) {
        const e = navEvent(url, false);
        s.wc().emit(event, e);
        expect(e.preventDefault, `${event} ${url}`).toHaveBeenCalled();
      }
    }
    expect(s.openExternal).not.toHaveBeenCalled();
  });

  it('denies every popup: an allowlisted page goes to the browser, a scrap.tf popup is dropped', () => {
    const s = setup();
    s.m.open();
    const handler = s.wc().openHandler!;
    expect(handler({ url: HATS })).toEqual({ action: 'deny' });
    expect(handler({ url: 'https://evil.example/' })).toEqual({ action: 'deny' });
    expect(s.openExternal).not.toHaveBeenCalled();
    s.click();
    expect(handler({ url: BPTF })).toEqual({ action: 'deny' });
    expect(s.openExternal.mock.calls).toEqual([[BPTF]]);
    expect(s.wc().loads).toEqual([[SCRAPTF_HOME_URL]]);
  });

  it('opens nothing outside without the user\'s input: a page script cannot open a stream of browser tabs', () => {
    const s = setup();
    s.m.open();
    // A script sends the page away (or opens a popup) once a second, for a minute, while nobody touches it.
    for (let i = 0; i < 60; i++) {
      s.ctl.t += 1_000;
      s.wc().emit('will-navigate', navEvent(BPTF));
      expect(s.wc().openHandler!({ url: BPTF_2 })).toEqual({ action: 'deny' });
    }
    expect(s.openExternal).not.toHaveBeenCalled();
    // Moving the mouse or the wheel over the page is not an act of the user's.
    s.click('mouseMove');
    s.click('mouseWheel');
    s.wc().emit('will-navigate', navEvent(BPTF));
    expect(s.openExternal).not.toHaveBeenCalled();
    // One click lets exactly one page out; the script's next try finds no input left.
    s.click();
    s.wc().emit('will-navigate', navEvent(BPTF));
    s.ctl.t += EXTERNAL_OPEN_MIN_GAP_MS;
    s.wc().emit('will-navigate', navEvent(BPTF_2));
    s.wc().openHandler!({ url: BPTF_2 });
    expect(s.openExternal.mock.calls).toEqual([[BPTF]]);
    // A key press or a tap counts too, but only for USER_ACTIVATION_MS.
    for (const type of ['rawKeyDown', 'keyDown', 'gestureTap']) {
      s.ctl.t += EXTERNAL_OPEN_MIN_GAP_MS;
      s.click(type);
      s.wc().openHandler!({ url: BPTF_2 });
    }
    expect(s.openExternal).toHaveBeenCalledTimes(4);
    s.ctl.t += EXTERNAL_OPEN_MIN_GAP_MS;
    s.click();
    s.ctl.t += USER_ACTIVATION_MS + 1;
    s.wc().emit('will-navigate', navEvent(BPTF));
    expect(s.openExternal).toHaveBeenCalledTimes(4);
    // Input to the toolbar (another webContents) is no input to the page.
    s.bar().emit('input-event', {}, { type: 'mouseDown' });
    s.wc().emit('will-navigate', navEvent(BPTF));
    expect(s.openExternal).toHaveBeenCalledTimes(4);
    expect(s.wc().loads).toEqual([[SCRAPTF_HOME_URL]]);
  });

  it('logs what a page triggers at its own rate once a minute per kind, counting the rest', () => {
    const s = setup();
    s.m.open();
    for (let i = 0; i < 10_000; i++) {
      s.wc().emit('will-navigate', navEvent(`https://evil.example/${i}?${QUERY_MARKER}`));
      s.wc().openHandler!({ url: `https://evil.example/pop/${i}` });
      s.wc().emit('will-frame-navigate', navEvent(`https://ads.example/${i}`, false));
      s.wc().emit('will-navigate', navEvent(BPTF));
    }
    const info = () => s.log.info.mock.calls.map(([m]) => String(m));
    const debug = () => s.log.debug.mock.calls.map(([m]) => String(m));
    expect(info()).toEqual([
      'scrap.tf window: blocked a page outside scrap.tf and Steam sign-in',
      'scrap.tf window: dropped a popup',
      'scrap.tf window: a page tried to open a link outside without a click',
    ]);
    expect(debug()).toEqual(['scrap.tf window: blocked a frame']);
    // A new document flushes the counts, by kind, with no URL in them.
    s.wc().emit('did-navigate', {}, HATS, 200, 'OK');
    expect(info().slice(3)).toEqual([
      'scrap.tf window: blocked a page outside scrap.tf and Steam sign-in: 9999 more like it not logged',
      'scrap.tf window: dropped a popup: 9999 more like it not logged',
      'scrap.tf window: a page tried to open a link outside without a click: 9999 more like it not logged',
    ]);
    expect(debug()).toEqual(['scrap.tf window: blocked a frame', 'scrap.tf window: blocked a frame: 9999 more like it not logged']);
    // Within one document: the first line, then the count with the next line a minute on.
    s.wc().emit('will-navigate', navEvent('https://evil.example/1'));
    for (let i = 0; i < 5; i++) s.wc().emit('will-navigate', navEvent('https://evil.example/2'));
    s.ctl.t += 60_000;
    s.wc().emit('will-navigate', navEvent('https://evil.example/3'));
    expect(info().slice(6)).toEqual([
      'scrap.tf window: blocked a page outside scrap.tf and Steam sign-in',
      'scrap.tf window: blocked a page outside scrap.tf and Steam sign-in (and 5 more like it since the last such line)',
    ]);
    expect(s.logged()).not.toContain(QUERY_MARKER);
    expect(s.log.info.mock.calls.length + s.log.debug.mock.calls.length + s.log.warn.mock.calls.length).toBeLessThan(15);
  });

  it('logs a blocked page by origin and path only', () => {
    const s = setup();
    s.m.open();
    s.wc().emit('will-navigate', navEvent(`https://evil.example/x?token=${QUERY_MARKER}#${QUERY_MARKER}`));
    s.wc().openHandler!({ url: `https://evil.example/pop?${QUERY_MARKER}` });
    s.wc().emit('will-frame-navigate', navEvent(`https://ads.example/f?${QUERY_MARKER}`, false));
    expect(s.logged()).toContain('https://evil.example/x');
    expect(s.logged()).not.toContain(QUERY_MARKER);
  });
});

describe('loads come only from the user', () => {
  it('no event, timer or failure loads, reloads or steps the view', async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    const before = [...fake.journal];
    s.land(HATS);
    s.wc().emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', HATS, true);
    s.wc().emit('did-fail-load', {}, -3, 'ABORTED', HATS, true);
    s.wc().emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    s.wc().emit('did-navigate-in-page', {}, `${HATS}#top`, true);
    s.wc().emit('did-start-loading');
    s.wc().emit('did-stop-loading');
    s.wc().emit('unresponsive');
    await flush();
    s.fireTimers();
    await flush();
    expect(fake.journal).toEqual(before);
    // The module's only timer is the settle read.
    expect(s.timers.setTimeout.mock.calls.map(([, ms]) => ms)).toEqual([READ_SETTLE_MS]);
    expect(s.log.warn.mock.calls.map(([msg]) => msg)).toContain('scrap.tf window: a page did not load (-105)');
    expect(s.logged()).not.toContain('(-3)');
  });

  it('turns each toolbar control into exactly one move of the view', () => {
    const s = setup();
    s.m.open();
    fake.journal.length = 0;
    // History steps only when there is somewhere to go.
    s.m.back();
    s.m.forward();
    expect(fake.journal).toEqual([]);
    s.wc().canBack = true;
    s.wc().canForward = true;
    s.m.back();
    s.m.forward();
    s.m.reload();
    s.m.home();
    s.m.go(WEAPONS);
    s.m.go(SCRAPTF_ITEMS_URL);
    expect(fake.journal).toEqual(['back view', 'forward view', 'reload view', `load view ${SCRAPTF_HOME_URL}`, `load view ${WEAPONS}`, `load view ${SCRAPTF_ITEMS_URL}`]);
    expect(() => s.m.go(`${WEAPONS}?page=2`)).toThrow(SCRAPTF_START_REFUSAL);
    expect(fake.journal).toHaveLength(6);
  });

  it('opens the window for Home or a bank chip when it is closed, and does nothing else then', () => {
    const s = setup();
    s.m.back();
    s.m.forward();
    s.m.reload();
    expect(fake.FakeWin.all).toHaveLength(0);
    s.m.go(HATS);
    expect(fake.journal).toEqual([`load toolbar ${SCRAPTF_BAR_URL}`, `load view ${HATS}`]);
    s.m.close();
    s.m.home();
    expect(fake.FakeWin.all).toHaveLength(2);
    expect(s.wc().loads).toEqual([[SCRAPTF_HOME_URL]]);
  });

  it('moves nothing once the window is turned off, even before main closes it', () => {
    const s = setup();
    s.m.open();
    fake.journal.length = 0;
    s.ctl.settings = windowSettings({ enabled: false });
    s.wc().canBack = true;
    s.m.back();
    s.m.reload();
    s.m.home();
    s.m.go(HATS);
    expect(fake.journal).toEqual([]);
  });
});

describe('reads', () => {
  it('reads a scrap.tf page the user loaded with the pinned script and imports it as a window read', async () => {
    const s = setup();
    s.m.open(HATS);
    const html = `<html><body>${PAGE_MARKER}</body></html>`;
    s.land(`${HATS}?sort=${QUERY_MARKER}`, html);
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld.mock.calls).toEqual([[READ_WORLD_ID, [{ code: READ_SCRIPT }]]]);
    // The load snapshot waits for its settle read: one look at the page is one import.
    expect(s.importHtml).not.toHaveBeenCalled();
    s.ctl.t += READ_SETTLE_MS;
    s.fireTimers();
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld.mock.calls).toEqual([
      [READ_WORLD_ID, [{ code: READ_SCRIPT }]],
      [READ_WORLD_ID, [{ code: READ_SCRIPT }]],
    ]);
    // Imported at the load's time.
    expect(s.importHtml.mock.calls).toEqual([
      [{ html, fileName: 'scrap.tf window /buy/hats', mtimeMs: T, address: `${HATS}?sort=${QUERY_MARKER}`, origin: 'window' }],
    ]);
    const read: ScraptfWindowRead = { at: T + READ_SETTLE_MS, path: '/buy/hats', items: 48, bank: 'hats', newFlips: 2, warning: null, stored: 48 };
    expect(s.m.state().lastRead).toEqual(read);
    // Queued for the toolbar until its page has loaded, then delivered once.
    expect(s.pushes('scraptfWindow.read')).toEqual([]);
    s.toolbarReady();
    expect(s.pushes('scraptfWindow.read')).toEqual([read]);
    expect(s.logged()).not.toContain(PAGE_MARKER);
    expect(s.logged()).not.toContain(QUERY_MARKER);
  });

  it('reads once more after the settle delay and imports one look per load: the newer snapshot, at the load time', async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS, '<html>v1</html>');
    await flush();
    expect(s.pending().map((h) => h.ms)).toEqual([READ_SETTLE_MS]);
    expect(s.pushes<ScraptfWindowNav>('scraptfWindow.nav').at(-1)!.reading).toBe(true);
    s.ctl.t += READ_SETTLE_MS;
    s.fireTimers();
    await flush();
    // Same DOM: read twice, imported once.
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    expect(s.pending()).toEqual([]);
    expect(s.pushes<ScraptfWindowNav>('scraptfWindow.nav').at(-1)!.reading).toBe(false);

    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    const weaponsAt = s.ctl.t;
    s.land(WEAPONS, '<html>w1</html>');
    await flush();
    s.wc().html = '<html>w1 and the cards scrap.tf added after load</html>';
    s.ctl.t += READ_SETTLE_MS;
    s.fireTimers();
    await flush();
    // The partial load snapshot is never a save of its own: the page is not saved twice 4 s apart.
    expect(s.importHtml.mock.calls.map(([p]) => [p.html, p.mtimeMs])).toEqual([
      ['<html>v1</html>', T],
      ['<html>w1 and the cards scrap.tf added after load</html>', weaponsAt],
    ]);
    expect(s.pushes('scraptfWindow.read')).toHaveLength(2);
    // One settle read per load, never repeated.
    expect(s.timers.setTimeout).toHaveBeenCalledTimes(2);
  });

  it('imports the held load snapshot when its settle read cannot run (another page, a crash, close, a failed script), as unsettled', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS, '<html>h1</html>');
    await flush();
    // The user's click put another document on screen before the settle read: the load snapshot is the look,
    // cut before it settled (ACT-4): the service stores its prices but no bank stock save.
    s.ctl.t += 1_000;
    s.land(WEAPONS, '<html>w1</html>');
    await flush();
    expect(s.importHtml.mock.calls.map(([p]) => [p.address, p.html, p.mtimeMs, p.settled])).toEqual([[HATS, '<html>h1</html>', T, false]]);
    // The settle read's script fails: the load snapshot it held is imported instead, unsettled too.
    s.wc().executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('gone'));
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => [p.html, p.settled])).toEqual([
      ['<html>h1</html>', false],
      ['<html>w1</html>', false],
    ]);
    // The renderer dies before the settle read.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(SCRAPTF_ITEMS_URL, '<html>i1</html>');
    await flush();
    s.wc().emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await flush();
    expect(s.importHtml.mock.calls.map(([p]) => p.html)).toEqual(['<html>h1</html>', '<html>w1</html>', '<html>i1</html>']);
    // The user closes the window before it.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(HATS, '<html>h2</html>');
    await flush();
    s.m.close();
    await flush();
    expect(s.importHtml.mock.calls.map(([p]) => p.html)).toEqual(['<html>h1</html>', '<html>w1</html>', '<html>i1</html>', '<html>h2</html>']);
    // Every one of them was a look cut short.
    expect(s.importHtml.mock.calls.every(([p]) => p.settled === false)).toBe(true);
    // Each was read once: nothing was read again to import it.
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(5);
  });

  it('marks only a look cut short as unsettled: the settle read, Read page now and a fallback-free cycle are settled', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS, '<html>h1</html>');
    await s.settle();
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(WEAPONS, '<html>w1</html>');
    await flush();
    s.ctl.t += 1_000;
    s.wc().html = '<html>w1, all cards</html>';
    expect((await s.m.readNow()).reason).toBeNull();
    // A settled look has no flag at all (absent: settled), exactly as before 0.7.1.
    expect(s.importHtml.mock.calls.map(([p]) => [p.html, 'settled' in p])).toEqual([
      ['<html>h1</html>', false],
      ['<html>w1, all cards</html>', false],
    ]);
  });

  it('marks a load read as unsettled when its cycle ended while its script ran (a toolbar move, its settle read first)', async () => {
    const s = setup();
    s.m.open(HATS);
    let answer: (html: string) => void = () => undefined;
    s.wc().runScript = () => new Promise((resolve) => (answer = resolve));
    s.land(HATS);
    await flush();
    // The user reloads while the load read's script still runs: nothing was held yet, and no settle read follows.
    s.m.reload();
    answer('<html>h1, cards still coming</html>');
    await flush();
    // The page's own settle read fires while a slow load read still runs, and gives way to it.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(WEAPONS);
    await flush();
    s.fireTimers();
    await flush();
    answer('<html>w1 at load</html>');
    await flush();
    expect(s.importHtml.mock.calls.map(([p]) => [p.html, p.settled])).toEqual([
      ['<html>h1, cards still coming</html>', false],
      ['<html>w1 at load</html>', false],
    ]);
  });

  it('imports the same HTML again once settled after an unsettled import of it (that one wrote no bank stock save)', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS, '<html>h1</html>');
    await flush();
    s.ctl.t += 1_000;
    s.land(WEAPONS, '<html>w1</html>');
    await s.settle();
    // Back on hats past the gap, the page unchanged: the earlier unsettled import does not count as its read.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(HATS, '<html>h1</html>');
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => [p.address, p.html, p.settled ?? true])).toEqual([
      [HATS, '<html>h1</html>', false],
      [WEAPONS, '<html>w1</html>', true],
      [HATS, '<html>h1</html>', true],
    ]);
  });

  it('keeps automatic reads of one page 30 s apart and skips an unchanged page for 60 s', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS, '<html>v1</html>');
    await s.settle();
    const reads = () => s.wc().executeJavaScriptInIsolatedWorld.mock.calls.length;
    expect(reads()).toBe(2);
    // A reload, and coming back to the page from another one, within the gap: no read.
    s.ctl.t += READ_AUTO_MIN_GAP_MS - 1;
    s.land(HATS);
    s.land(WEAPONS, '<html>w1</html>');
    await s.settle();
    s.land(HATS, '<html>v1</html>');
    await flush();
    expect(reads()).toBe(4);
    expect(s.importHtml.mock.calls.map(([p]) => p.address)).toEqual([HATS, WEAPONS]);
    // Past the gap but within the dedupe: read, unchanged, not imported.
    s.ctl.t += 1;
    s.land(HATS);
    await s.settle();
    expect(reads()).toBe(6);
    expect(s.importHtml).toHaveBeenCalledTimes(2);
    // Past the dedupe: the same page is imported again.
    s.ctl.t += READ_DEDUPE_MS;
    s.land(HATS);
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => p.address)).toEqual([HATS, WEAPONS, HATS]);
  });

  it('reads an in-page navigation of the main frame once the page is not loading, and never a frame', async () => {
    const s = setup();
    s.m.open(HATS);
    s.wc().url = `${HATS}?page=2`;
    s.wc().loading = true;
    s.wc().emit('did-navigate-in-page', {}, s.wc().url, true);
    s.wc().loading = false;
    s.wc().emit('did-navigate-in-page', {}, s.wc().url, false);
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    s.wc().emit('did-navigate-in-page', {}, s.wc().url, true);
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => p.address)).toEqual([`${HATS}?page=2`]);
    // An anchor on the same page is the same page: no new read within the gap.
    s.wc().url = `${HATS}?page=2#item-1`;
    s.wc().emit('did-navigate-in-page', {}, s.wc().url, true);
    await s.settle();
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  });

  it('reads nothing on load when the user turned that off; Read page now still works', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.land(HATS);
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(s.timers.setTimeout).not.toHaveBeenCalled();
    const out = await s.m.readNow();
    expect(out.reason).toBeNull();
    expect(out.read).toMatchObject({ path: '/buy/hats', items: 48 });
    expect(s.importHtml).toHaveBeenCalledTimes(1);
  });

  it('never reads a page that is not scrap.tf (Steam sign-in, a challenge, a blank view)', async () => {
    const s = setup();
    s.m.open(HATS);
    for (const url of [STEAM_LOGIN, 'https://challenges.cloudflare.com/x', 'about:blank', 'http://scrap.tf/buy/hats', 'https://www.scrap.tf/buy/hats', '']) {
      s.land(url);
      s.wc().emit('did-navigate-in-page', {}, url, true);
      s.ctl.t += READ_MANUAL_MIN_GAP_MS;
      await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.notScraptf });
    }
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(s.timers.setTimeout).not.toHaveBeenCalled();
    expect(s.importHtml).not.toHaveBeenCalled();
  });

  it('takes Read page now at most every 2 s, and imports a page unchanged since its last import only after a minute', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS);
    const first = await s.m.readNow();
    expect(first.reason).toBeNull();
    s.ctl.t += READ_MANUAL_MIN_GAP_MS - 1;
    await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.tooSoon });
    // The same DOM again: read, not saved a second time (that save would diff the page against itself);
    // the toolbar shows the page's last read again.
    s.ctl.t += 1;
    await expect(s.m.readNow()).resolves.toEqual({ read: first.read, reason: SCRAPTF_READ_REASONS.unchanged });
    expect(s.pushes('scraptfWindow.read')).toEqual([first.read, first.read]);
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    // A changed page is imported at once; an unchanged one again after READ_DEDUPE_MS.
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = '<html>hats v2</html>';
    expect((await s.m.readNow()).reason).toBeNull();
    s.ctl.t += READ_DEDUPE_MS;
    expect((await s.m.readNow()).reason).toBeNull();
    expect(s.importHtml.mock.calls.map(([p]) => p.html)).toEqual([s.importHtml.mock.calls[0]![0].html, '<html>hats v2</html>', '<html>hats v2</html>']);
  });

  it('ends an automatic cycle with Read page now: one import, no settle read after it', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS, '<html>some cards</html>');
    await flush();
    s.ctl.t += 1_000;
    s.wc().html = '<html>all the cards</html>';
    expect((await s.m.readNow()).reason).toBeNull();
    expect(s.pending()).toEqual([]);
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => p.html)).toEqual(['<html>all the cards</html>']);
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  });

  it('never runs two reads at once', async () => {
    const s = setup();
    let finish: (html: unknown) => void = () => undefined;
    s.m.open(HATS);
    s.wc().executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise<unknown>((r) => (finish = r)));
    s.land(HATS);
    await flush();
    await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.busy });
    s.ctl.t += READ_SETTLE_MS;
    s.fireTimers();
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
    // The slow load read ends after its settle read was skipped: it is the cycle's look, imported now.
    finish('<html>hats, slowly</html>');
    await flush();
    expect(s.importHtml.mock.calls.map(([p]) => p.html)).toEqual(['<html>hats, slowly</html>']);
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    expect((await s.m.readNow()).reason).toBeNull();
  });

  it('holds back only the view a read hangs on, until that view is gone or its renderer is replaced', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.land(HATS);
    // The renderer never answers (the view closes mid-read, or the renderer dies after the send).
    s.wc().executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise<unknown>(() => undefined));
    void s.m.readNow();
    await flush();
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.busy });
    // The user closes the window and opens it again: the new view reads.
    s.m.close();
    s.ctl.t += 120_000;
    s.m.open(HATS);
    s.land(HATS);
    expect((await s.m.readNow()).reason).toBeNull();
    // A renderer that dies mid-read: the next document of the same view reads.
    s.wc().executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise<unknown>(() => undefined));
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    void s.m.readNow();
    await flush();
    s.wc().emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    s.wc().html = '<html>hats after the crash</html>';
    s.land(HATS);
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    expect((await s.m.readNow()).reason).toBeNull();
    expect(s.importHtml).toHaveBeenCalledTimes(2);
  });

  it("never runs the read on the next document while a main-frame navigation is pending (Steam's sign-in)", async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS);
    await flush();
    // The user clicks "Sign in through Steam": the main frame loads, the old page is still committed.
    const signIn = () => {
      s.wc().mainFrameLoading = true;
      s.wc().loading = true;
      s.wc().emit('did-start-loading');
    };
    const commitSteam = () => {
      s.wc().url = STEAM_LOGIN;
      s.wc().emit('did-navigate', {}, STEAM_LOGIN, 200, 'OK');
      s.wc().mainFrameLoading = false;
      s.wc().loading = false;
      s.wc().emit('did-finish-load');
      s.wc().emit('did-stop-loading');
    };
    signIn();
    // The settle read fires before Steam commits: it does not run (Electron would run it on Steam's page).
    s.fireTimers();
    await flush();
    commitSteam();
    await flush();
    // Read page now during the pending navigation: refused, not run later on Steam's page.
    s.wc().url = HATS;
    s.wc().emit('did-navigate', {}, HATS, 200, 'OK');
    signIn();
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.loading });
    commitSteam();
    await flush();
    expect(s.wc().ranOn).toEqual([HATS]);
    // The one load read was the look: imported, from HATS only.
    expect(s.importHtml.mock.calls.map(([p]) => p.address)).toEqual([HATS]);
    expect(s.logged()).not.toContain('openid');
  });

  it('starts the load read at did-stop-loading when the main frame is still loading at did-finish-load', async () => {
    const s = setup();
    s.m.open(HATS);
    s.wc().mainFrameLoading = true;
    s.land(HATS);
    s.wc().url = `${HATS}?page=2`;
    s.wc().emit('did-navigate-in-page', {}, s.wc().url, true);
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(s.timers.setTimeout).not.toHaveBeenCalled();
    s.wc().mainFrameLoading = false;
    s.wc().emit('did-stop-loading');
    await s.settle();
    expect(s.wc().ranOn).toEqual([`${HATS}?page=2`, `${HATS}?page=2`]);
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    // A new document that commits first drops the wait: its own did-finish-load reads it.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.wc().mainFrameLoading = true;
    s.wc().emit('did-finish-load');
    s.wc().url = STEAM_LOGIN;
    s.wc().emit('did-navigate', {}, STEAM_LOGIN, 200, 'OK');
    s.wc().mainFrameLoading = false;
    s.wc().emit('did-stop-loading');
    await s.settle();
    expect(s.wc().ranOn).toHaveLength(2);
  });

  it('leaves the page on screen with each toolbar move: no settle read follows it into the navigation', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    await flush();
    const settle = s.pending()[0]!;
    s.wc().canBack = true;
    s.m.back();
    expect(settle.cleared).toBe(true);
    await flush();
    expect(s.importHtml.mock.calls.map(([p]) => p.address)).toEqual([HATS]);
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(WEAPONS);
    await flush();
    s.m.reload();
    expect(s.pending()).toEqual([]);
  });

  it('drops the settle read when another document is on screen, not when a click went nowhere', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    await flush();
    const settle = s.pending()[0]!;
    // A click the policy blocked or sent to the browser starts a navigation that never commits: HATS stays.
    s.wc().emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: BPTF });
    s.wc().emit('did-fail-load', {}, -3, 'ABORTED', BPTF, true);
    expect(settle.cleared).toBe(false);
    // A new document committed: the old page's settle read must not read it.
    s.wc().emit('did-navigate', {}, HATS, 200, 'OK');
    expect(settle.cleared).toBe(true);
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(WEAPONS);
    await flush();
    const next = s.pending()[0]!;
    // Chromium's error page replaces the document without a did-navigate.
    s.wc().emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', WEAPONS, true);
    expect(next.cleared).toBe(true);
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(SCRAPTF_ITEMS_URL);
    await flush();
    const third = s.pending()[0]!;
    // A frame's failure keeps it.
    s.wc().emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://scrap.tf/frame', false);
    expect(third.cleared).toBe(false);
    // Fired after the view ended up on another page without a new cycle: nothing is read.
    s.wc().url = HATS;
    const before = s.wc().executeJavaScriptInIsolatedWorld.mock.calls.length;
    s.fireTimers();
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld.mock.calls.length).toBe(before);
  });

  it('files a read under the page whose DOM it read, not a toolbar load still pending', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.land(HATS, '<html>hats cards</html>');
    // The user clicked the Weapons chip: getURL() names the pending page while HATS is still on screen.
    s.m.go(WEAPONS);
    s.wc().url = WEAPONS;
    s.wc().frameUrl = HATS;
    expect((await s.m.readNow()).read).toMatchObject({ path: '/buy/hats' });
    expect(s.importHtml.mock.calls.map(([p]) => [p.address, p.fileName, p.html])).toEqual([[HATS, 'scrap.tf window /buy/hats', '<html>hats cards</html>']]);
    // The document changed while the script ran: the read is dropped, not filed under either page.
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().executeJavaScriptInIsolatedWorld.mockImplementationOnce(async () => {
      s.wc().frameUrl = null;
      return '<html>hats or weapons</html>';
    });
    await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.failed });
    expect(s.importHtml).toHaveBeenCalledTimes(1);
  });

  it('reads an in-page navigation after the load even while a frame is still loading', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    await flush();
    s.fireTimers();
    await flush();
    // A challenge or embed frame keeps isLoading() true after the page's own did-finish-load.
    s.wc().loading = true;
    s.wc().url = `${HATS}?page=2`;
    s.wc().emit('did-navigate-in-page', {}, s.wc().url, true);
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => p.address)).toEqual([HATS, `${HATS}?page=2`]);
    // A new document still coming in waits for its own did-finish-load.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.wc().url = WEAPONS;
    s.wc().emit('did-navigate', {}, WEAPONS, 200, 'OK');
    s.wc().url = `${WEAPONS}?sorted`;
    s.wc().emit('did-navigate-in-page', {}, s.wc().url, true);
    await flush();
    expect(s.importHtml).toHaveBeenCalledTimes(2);
    s.wc().loading = false;
    s.wc().emit('did-finish-load');
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => p.address)).toEqual([HATS, `${HATS}?page=2`, `${WEAPONS}?sorted`]);
  });

  it('reads the real page right after a Cloudflare check the user solved at the same address', async () => {
    const s = setup();
    // The service names the bank from the address hint even when the page shows no cards.
    const nothing = () => importResult({ batchId: 0, pageKind: 'unknown', parsed: 0, stored: 0, bank: 'hats', newFlips: undefined });
    s.importHtml.mockResolvedValueOnce(nothing());
    s.m.open(HATS);
    s.toolbarReady();
    // Cloudflare serves its check at the page's own address: read, then its settle read, imported once
    // (nothing recognised).
    s.land(HATS, '<html>Just a moment...</html>');
    await flush();
    s.ctl.t += READ_SETTLE_MS;
    s.wc().html = '<html>Just a moment... (the check is running)</html>';
    s.fireTimers();
    await flush();
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    // An in-page step within the gap still waits: only a new document of the page reads again.
    s.wc().emit('did-navigate-in-page', {}, HATS, true);
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    // The user solved it: the bank page loads at the same address, within the 30 s gap, and is read.
    s.ctl.t += 5_000;
    s.land(HATS, '<html>hats cards</html>');
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => [p.address, p.html])).toEqual([
      [HATS, '<html>Just a moment... (the check is running)</html>'],
      [HATS, '<html>hats cards</html>'],
    ]);
    expect(s.pushes<ScraptfWindowRead>('scraptfWindow.read').at(-1)).toMatchObject({ items: 48, bank: 'hats', warning: null });
    // That cycle imported items, so the gap holds again: a reload within it is not read.
    const reads = s.wc().executeJavaScriptInIsolatedWorld.mock.calls.length;
    s.ctl.t += 1_000;
    s.land(HATS, '<html>hats cards, reloaded</html>');
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(reads);
    // Every move was the user's (open, then their own clicks in the page): the reads moved nothing.
    expect(fake.journal.filter((j) => j.includes(' view'))).toEqual([`load view ${HATS}`]);
  });

  it('drops the settle read when the user turns reading on load off after the page loaded', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    await flush();
    expect(s.pending()).toHaveLength(1);
    s.ctl.settings = windowSettings({ readOnLoad: false });
    s.wc().html = '<html>hats and more cards</html>';
    s.fireTimers();
    await flush();
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
    expect(s.importHtml).toHaveBeenCalledTimes(1);
  });

  it('reports an empty or oversized page, a failed script and a failed import with fixed texts', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS, null);
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: SCRAPTF_READ_REASONS.empty, read: { items: 0, warning: SCRAPTF_READ_REASONS.empty } });
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = 'x'.repeat(READ_MAX_CHARS + 1);
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: SCRAPTF_READ_REASONS.empty });
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error(`Script failed ${PAGE_MARKER}`));
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: SCRAPTF_READ_REASONS.failed, read: { warning: SCRAPTF_READ_REASONS.failed } });
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = `<html>${PAGE_MARKER}</html>`;
    s.importHtml.mockRejectedValueOnce(new Error(`import failed near ${PAGE_MARKER}`));
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: SCRAPTF_READ_REASONS.failed, read: { path: '/buy/hats', items: 0, warning: SCRAPTF_READ_REASONS.failed } });
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    expect(s.pushes<ScraptfWindowRead>('scraptfWindow.read').map((r) => r.warning)).toEqual([
      SCRAPTF_READ_REASONS.empty,
      SCRAPTF_READ_REASONS.empty,
      SCRAPTF_READ_REASONS.failed,
      SCRAPTF_READ_REASONS.failed,
    ]);
    expect(s.logged()).not.toContain(PAGE_MARKER);
    // A failed import does not count as read: the next automatic read of the same DOM imports it.
    s.ctl.settings = windowSettings({ readOnLoad: true });
    s.importHtml.mockClear();
    s.land(HATS);
    await s.settle();
    expect(s.importHtml).toHaveBeenCalledTimes(1);
  });

  it("shows the import's first warning code (never its page text) and says when nothing was recognised", async () => {
    const s = setup({ readOnLoad: false });
    s.m.open();
    // A scrap.tf page the import reads, whose bank it did not name here.
    s.land(SCRAPTF_ITEMS_URL);
    s.importHtml.mockResolvedValueOnce(importResult({ warnings: [`unparsed-price: "${PAGE_MARKER}"`, 'other'], newFlips: undefined, bank: undefined }));
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { path: '/items', warning: 'unparsed-price', newFlips: 0, bank: null } });
    // Each read below sees a changed page (an unchanged one would not be imported again).
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = '<html>2</html>';
    s.importHtml.mockResolvedValueOnce(importResult({ batchId: 0, pageKind: 'unknown', parsed: 0, stored: 0, bank: null, newFlips: undefined }));
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { items: 0, warning: SCRAPTF_NOTHING_TO_IMPORT }, reason: null });
    // The service's own answer for a bank page read before its cards arrived (nothing recorded, batchId 0):
    // the import's no-cards code, which the toolbar words as "no items on screen yet; wait for them, then
    // Read page now", not as nothing to import on the page.
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = '<html>3</html>';
    s.importHtml.mockResolvedValueOnce(
      importResult({ batchId: 0, pageKind: 'buy', parsed: 0, stored: 0, bank: 'hats', newFlips: undefined, warnings: ['nothing-to-import: this scrap.tf page shows no items to import (yet); nothing was recorded'] }),
    );
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { items: 0, bank: 'hats', warning: 'no-cards-saved' }, reason: null });
    // A page the import names no bank for (scrap.tf's front page, a profile) keeps the plain sentence.
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = '<html>4</html>';
    s.importHtml.mockResolvedValueOnce(
      importResult({ batchId: 0, pageKind: 'unknown', parsed: 0, stored: 0, bank: null, newFlips: undefined, warnings: ['nothing-to-import: this scrap.tf page shows no items to import (yet); nothing was recorded'] }),
    );
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { items: 0, bank: null, warning: SCRAPTF_NOTHING_TO_IMPORT }, reason: null });
    // A recorded batch with no items keeps the import's own first code.
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = '<html>5</html>';
    s.importHtml.mockResolvedValueOnce(importResult({ batchId: 9, parsed: 0, stored: 0, warnings: ['no-cards-saved: x'] }));
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { items: 0, warning: 'no-cards-saved' }, reason: null });
  });

  it("0.7.4 (F53): carries the import's stock save onto the read, and only the known values", async () => {
    const s = setup({ readOnLoad: false });
    s.m.open();
    s.land(HATS);
    s.importHtml.mockResolvedValueOnce(importResult({ stockSave: 'unsettled' }));
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { path: '/buy/hats', stockSave: 'unsettled' }, reason: null });
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = '<html>2</html>';
    s.importHtml.mockResolvedValueOnce(importResult({ stockSave: 'written' }));
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { stockSave: 'written' } });
    // Anything else from the service is left out, as an older service's answer is.
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = '<html>3</html>';
    s.importHtml.mockResolvedValueOnce(importResult({ stockSave: 'nonsense' as never }));
    const out = await s.m.readNow();
    expect(out.read).not.toHaveProperty('stockSave');
  });

  it('reads nothing while the window is closed', async () => {
    const s = setup();
    await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.notOpen });
    s.m.open(HATS);
    s.land(HATS);
    await flush();
    s.m.close();
    s.fireTimers();
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.notOpen });
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
  });
});

describe('Log out & clear', () => {
  it('clears storage and cache of both partitions, then loads Home on the user\'s click', async () => {
    const s = setup();
    s.m.open(HATS);
    fake.journal.length = 0;
    await s.m.clear();
    expect(fake.journal).toEqual([
      `storage ${SCRAPTF_MEMORY_PARTITION}`,
      `cache ${SCRAPTF_MEMORY_PARTITION}`,
      `storage ${SCRAPTF_PERSIST_PARTITION}`,
      `cache ${SCRAPTF_PERSIST_PARTITION}`,
      `load view ${SCRAPTF_HOME_URL}`,
    ]);
    for (const ses of fake.sessions.values()) {
      expect(ses.cookieReads).toBe(0);
      // Hardened like the view's own, though nothing loads in it.
      expect(ses.requestHandler).not.toBeNull();
      expect(ses.count('will-download')).toBe(1);
    }
  });

  it('clears without opening anything while the window is closed', async () => {
    const s = setup({ enabled: false });
    await s.m.clear();
    expect(fake.journal).toEqual([`storage ${SCRAPTF_MEMORY_PARTITION}`, `cache ${SCRAPTF_MEMORY_PARTITION}`, `storage ${SCRAPTF_PERSIST_PARTITION}`, `cache ${SCRAPTF_PERSIST_PARTITION}`]);
    expect(fake.FakeWin.all).toHaveLength(0);
  });

  it('forgets what it read, so the same page is imported again after a clear', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    await s.settle();
    await s.m.clear();
    s.land(HATS);
    await s.settle();
    expect(s.importHtml).toHaveBeenCalledTimes(2);
  });

  it('drops a cycle of the session it clears instead of importing it afterwards', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    await flush();
    await s.m.clear();
    await s.settle();
    expect(s.importHtml).not.toHaveBeenCalled();
    expect(s.pending()).toEqual([]);
  });

  it('forgets the last read too, so a toolbar that loads again after a clear shows none', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    await s.settle();
    expect(s.m.state().lastRead).toMatchObject({ path: '/buy/hats' });
    s.onStateChanged.mockClear();
    await s.m.clear();
    expect(s.m.state().lastRead).toBeNull();
    expect(s.onStateChanged).toHaveBeenCalled();
  });

  it('tells the open toolbar, whichever page asked for the clear (Settings, not the toolbar, say)', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS);
    const { read } = await s.m.readNow();
    expect(s.pushes('scraptfWindow.read')).toEqual([read]);
    await s.m.clear();
    expect(s.pushes('scraptfWindow.read')).toEqual([read, null]);
  });
});

describe('closing and quitting', () => {
  it('closes the view with the window and forgets both when the user closes it', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    await flush();
    const settle = s.pending()[0]!;
    const view = s.wc();
    s.onStateChanged.mockClear();
    s.win().close();
    expect(view.closes).toBe(1);
    expect(settle.cleared).toBe(true);
    // The load snapshot taken before the close is the page's look: imported, not read again.
    await flush();
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    expect(s.m.ownsContents(view)).toBe(false);
    expect(s.m.focus()).toBe(false);
    expect(s.m.state()).toMatchObject({ open: false, url: null, canGoBack: false, canGoForward: false });
    expect(s.m.state().lastRead).toMatchObject({ path: '/buy/hats' });
    expect(s.onStateChanged).toHaveBeenCalled();
    // The next open is a fresh window on Home.
    s.m.open();
    expect(fake.FakeWin.all).toHaveLength(2);
    expect(s.wc().loads).toEqual([[SCRAPTF_HOME_URL]]);
  });

  it('close() (the window turned off) and dispose() (quit) close everything; nothing loads after dispose', async () => {
    const s = setup();
    s.m.open(HATS);
    const first = s.win();
    s.m.close();
    expect(first.destroyed).toBe(true);
    expect(s.wc().closes).toBe(1);
    s.m.open(HATS);
    s.land(HATS);
    await flush();
    const w = s.win();
    s.m.dispose();
    expect(w.destroyed).toBe(true);
    expect(s.wc().closes).toBe(1);
    expect(s.pending()).toEqual([]);
    expect(s.m.state()).toEqual({ open: false, url: null, canGoBack: false, canGoForward: false, lastRead: null });
    const loads = fake.journal.length;
    s.m.open(HATS);
    s.m.home();
    expect(fake.journal).toHaveLength(loads);
    expect(fake.FakeWin.all).toHaveLength(2);
  });

  it('closes a window whose toolbar died instead of reloading anything', () => {
    const s = setup();
    s.m.open(HATS);
    const before = [...fake.journal];
    s.bar().emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(s.win().destroyed).toBe(true);
    expect(fake.journal).toEqual(before);
  });
});

describe('the toolbar', () => {
  it('gets nav pushes with the address shown without its query, once its page has loaded', () => {
    const s = setup();
    s.m.open(HATS);
    s.wc().url = `${HATS}?q=${QUERY_MARKER}#${QUERY_MARKER}`;
    s.wc().canBack = true;
    s.wc().emit('did-navigate', {}, s.wc().url, 200, 'OK');
    expect(s.pushes('scraptfWindow.nav')).toEqual([]);
    s.toolbarReady();
    const expected: ScraptfWindowNav = { url: HATS, canGoBack: true, canGoForward: false, loading: false, reading: false, importable: true, notice: null };
    expect(s.pushes('scraptfWindow.nav').at(-1)).toEqual(expected);
    s.wc().loading = true;
    s.wc().emit('did-start-loading');
    expect(s.pushes<ScraptfWindowNav>('scraptfWindow.nav').at(-1)!.loading).toBe(true);
    expect(JSON.stringify(s.bar().sent)).not.toContain(QUERY_MARKER);
    expect(s.m.state()).toMatchObject({ open: true, url: HATS, canGoBack: true, canGoForward: false });
  });

  it("forwards only main's settings and service-state broadcasts, the latest of each while it loads", () => {
    const s = setup();
    s.m.send('settings.changed', DEFAULT_SETTINGS);
    s.m.open();
    const older = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, theme: 'light' as const } };
    s.m.send('settings.changed', older);
    s.m.send('settings.changed', DEFAULT_SETTINGS);
    s.m.send('status.changed', {} as never);
    s.m.send('scraptfWindow.read', { at: 1, path: '/fake', items: 999, bank: null, newFlips: 0, warning: null });
    s.m.send('scraptfWindow.nav', { url: 'https://evil.example/', canGoBack: false, canGoForward: false, loading: false });
    s.toolbarReady();
    s.m.send('service.state', { state: 'ready' } as never);
    const events = s.bar().sent.map(([, e]) => e);
    expect(events.filter((e) => e === 'settings.changed')).toHaveLength(1);
    expect(s.pushes('settings.changed')).toEqual([DEFAULT_SETTINGS]);
    expect(events).toContain('service.state');
    expect(events).not.toContain('status.changed');
    expect(s.pushes('scraptfWindow.read')).toEqual([]);
    expect(s.pushes<ScraptfWindowNav>('scraptfWindow.nav').every((n) => n.url !== 'https://evil.example/')).toBe(true);
    // Never to the view.
    expect(s.wc().sent).toEqual([]);
  });
});

describe('links.open with the real window (F21)', () => {
  function router(s: ReturnType<typeof setup>) {
    const settings = { get: () => s.ctl.settings, set: (_patch: unknown) => s.ctl.settings };
    const openExternal = vi.fn(async (_url: string) => undefined);
    const route = createRpcRouter({
      settings,
      secrets: { status: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }), set: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }) },
      service: { callRaw: vi.fn(async () => null) },
      showQuickEntry: vi.fn(),
      openItemInDashboard: vi.fn(),
      appInfo: () => ({ version: '0.7.0', appDir: 'a', dataDir: 'd', logDir: 'l', platform: 'win32', electron: '44', node: '24' }),
      serviceState: () => null,
      hotkeys: () => ({ quickEntry: { accelerator: '', registered: false, error: null }, check: { accelerator: '', registered: false, error: null } }),
      armCheck: () => ({ armedUntil: null }),
      isAllowedExternalUrl: (url: string) => url.startsWith('https://scrap.tf/') || url.startsWith('https://backpack.tf/'),
      openExternal,
      scraptfWindow: s.m,
      dialogs: { openHtmlFile: async () => null, openFolder: async () => null, saveFile: async () => null },
      files: { stat: async () => ({ size: 1, mtimeMs: 1, isFile: () => true }), readBytes: async () => new Uint8Array(), writeText: async () => undefined },
      log: s.log,
    });
    const call = (method: string, params?: unknown) => route({ window: null, hideWindow: vi.fn() }, method, params);
    return { call, openExternal };
  }

  it('opens a static scrap.tf page in the window when the user chose that and the caller says so; everything else goes to the browser', async () => {
    const s = setup({ openLinksInWindow: true });
    const r = router(s);
    // A button that promises the browser (no allowWindow) keeps its word, the choice on or not.
    await expect(r.call('links.open', { url: HATS })).resolves.toEqual({ opened: true, reason: null });
    expect(r.openExternal.mock.calls).toEqual([[HATS]]);
    expect(fake.FakeWin.all).toHaveLength(0);
    await expect(r.call('links.open', { url: HATS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    expect(fake.FakeWin.all).toHaveLength(1);
    expect(s.wc().loads).toEqual([[HATS]]);
    // A scrap.tf page that is not a static start page, and any other site, go to the browser as before.
    await expect(r.call('links.open', { url: `${HATS}?q=1`, allowWindow: true })).resolves.toEqual({ opened: true, reason: null });
    await expect(r.call('links.open', { url: BPTF, allowWindow: true })).resolves.toEqual({ opened: true, reason: null });
    expect(r.openExternal.mock.calls).toEqual([[HATS], [`${HATS}?q=1`], [BPTF]]);
    expect(s.wc().loads).toEqual([[HATS]]);
    await expect(r.call('links.open', { url: HATS, allowWindow: 'yes' })).rejects.toThrow(/Invalid parameters for links.open: allowWindow/);
  });

  it('keeps every link in the browser while the choice is off, and the window refuses to open while it is off', async () => {
    const s = setup({ openLinksInWindow: false });
    const r = router(s);
    await expect(r.call('links.open', { url: HATS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null });
    expect(r.openExternal.mock.calls).toEqual([[HATS]]);
    expect(fake.FakeWin.all).toHaveLength(0);
    s.ctl.settings = windowSettings({ enabled: false, openLinksInWindow: true });
    await expect(r.call('links.open', { url: WEAPONS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null });
    await expect(r.call('scraptfWindow.open', { start: HATS })).rejects.toThrow(SCRAPTF_WINDOW_OFF);
    expect(fake.FakeWin.all).toHaveLength(0);
  });

  it('turns toolbar calls into one move each, through the router', async () => {
    const s = setup();
    const r = router(s);
    await r.call('scraptfWindow.open', { start: HATS });
    s.wc().canBack = true;
    await r.call('scraptfWindow.back');
    await r.call('scraptfWindow.go', { url: WEAPONS });
    await expect(r.call('scraptfWindow.go', { url: 'https://evil.example/' })).rejects.toThrow();
    await r.call('scraptfWindow.home');
    expect(fake.journal.filter((j) => j.includes(' view'))).toEqual([`load view ${HATS}`, 'back view', `load view ${WEAPONS}`, `load view ${SCRAPTF_HOME_URL}`]);
    await expect(r.call('scraptfWindow.state')).resolves.toMatchObject({ open: true });
  });

  it('answers a link to the page already on screen in the window without loading it again (F21-7)', async () => {
    const s = setup({ openLinksInWindow: true });
    const r = router(s);
    await expect(r.call('links.open', { url: HATS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    s.land(HATS);
    s.toolbarReady();
    s.win().visible = false;
    await expect(r.call('links.open', { url: HATS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    await r.call('scraptfWindow.open', { start: HATS });
    // Brought to the front, not loaded again.
    expect(s.win().visible).toBe(true);
    expect(s.wc().loads).toEqual([[HATS]]);
    await r.call('links.open', { url: WEAPONS, allowWindow: true });
    expect(s.wc().loads).toEqual([[HATS], [WEAPONS]]);
  });
});

describe('0.7.1: what the window reads (F21-3, F21-4, F21-7)', () => {
  /** A document the user's browsing committed with an HTTP status, then loaded. */
  const landWith = (s: ReturnType<typeof setup>, url: string, status: number, html?: string) => {
    const c = s.wc();
    c.url = url;
    if (html !== undefined) c.html = html;
    c.emit('did-navigate', {}, url, status, '');
    c.emit('did-finish-load');
  };
  const lastNav = (s: ReturnType<typeof setup>) => s.pushes<ScraptfWindowNav>('scraptfWindow.nav').at(-1)!;

  it('reads no challenge, error or rate-limit page on its own, says so, and reads the real page that follows', async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    // Cloudflare's check (403) at the bank's own address, its in-page steps and its frames finishing.
    landWith(s, HATS, 403, '<html>Just a moment...</html>');
    s.wc().emit('did-navigate-in-page', {}, HATS, true);
    s.wc().emit('did-stop-loading');
    await s.settle();
    expect(s.wc().executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(s.timers.setTimeout).not.toHaveBeenCalled();
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.challenge);
    // The user solved it: the real page commits (200) at the same address, at once, and is read.
    s.ctl.t += 3_000;
    landWith(s, HATS, 200, '<html>hats cards</html>');
    expect(lastNav(s).notice).toBeNull();
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => p.html)).toEqual(['<html>hats cards</html>']);
    // A rate limit (429) and an error page (503) are not read either.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    landWith(s, WEAPONS, 429);
    await s.settle();
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.rateLimited);
    landWith(s, SCRAPTF_ITEMS_URL, 503);
    await s.settle();
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.challenge);
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    // Nothing of it moved the view: no retry, no reload.
    expect(fake.journal.filter((j) => j.includes(' view'))).toEqual([`load view ${HATS}`]);
  });

  it("reads nothing of Chromium's error page after a failed load on its own, and a dashboard link to it loads it again", async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS, '<html>h1</html>');
    await s.settle();
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    // The user's reload past the gap fails (no connection): Chromium's error page replaces the document at the
    // same address without a did-navigate, and has a did-finish-load of its own.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.m.reload();
    s.wc().html = '<html>ERR_INTERNET_DISCONNECTED</html>';
    s.wc().emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', HATS, true);
    s.wc().emit('did-finish-load');
    s.wc().emit('did-stop-loading');
    await s.settle();
    // Not read: no script, no settle read, and no read pushed over the notice telling the user to press Reload.
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    expect(s.timers.setTimeout).toHaveBeenCalledTimes(1);
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.offline);
    expect(s.pushes('scraptfWindow.read')).toHaveLength(1);
    // Read page now still reads it, and words what it found (nothing) by the notice.
    s.importHtml.mockResolvedValueOnce(importResult({ batchId: 0, parsed: 0, stored: 0, bank: 'hats', newFlips: undefined, warnings: ['nothing-to-import: nothing recorded'] }));
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: null, read: { items: 0, warning: SCRAPTF_WINDOW_NOTICES.offline } });
    // A dashboard link to that page is the user's ask to load it again (F21-7 spares only a page shown fine).
    s.m.open(HATS);
    expect(s.wc().loads).toEqual([[HATS], [HATS]]);
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(HATS, '<html>h1 again</html>');
    expect(lastNav(s).notice).toBeNull();
    await s.settle();
    expect(s.importHtml.mock.calls.at(-1)![0].html).toBe('<html>h1 again</html>');
    s.m.open(HATS);
    expect(s.wc().loads).toHaveLength(2);
    // So does one to a page whose renderer crashed; a rate-limited page is only brought up (the notice says wait).
    s.wc().emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    s.m.open(HATS);
    expect(s.wc().loads).toHaveLength(3);
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.wc().url = HATS;
    s.wc().emit('did-navigate', {}, HATS, 429, '');
    s.m.open(HATS);
    expect(s.wc().loads).toHaveLength(3);
    // Steam's sign-in answering 503 (its maintenance) is no Cloudflare check on scrap.tf: no notice.
    s.wc().url = STEAM_LOGIN;
    s.wc().emit('did-navigate', {}, STEAM_LOGIN, 503, '');
    expect(lastNav(s).notice).toBeNull();
    expect(fake.journal.filter((j) => j.includes(' view'))).toEqual([`load view ${HATS}`, 'reload view', `load view ${HATS}`, `load view ${HATS}`]);
  });

  it('reads a challenge page on Read page now, and words a read of it that found nothing by its notice', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    landWith(s, HATS, 403, '<html>Just a moment...</html>');
    s.importHtml.mockResolvedValueOnce(
      importResult({ batchId: 0, parsed: 0, stored: 0, bank: 'hats', newFlips: undefined, warnings: ['nothing-to-import: this scrap.tf page shows no items to import (yet); nothing was recorded'] }),
    );
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: null, read: { items: 0, bank: 'hats', warning: SCRAPTF_WINDOW_NOTICES.challenge } });
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
    // On the real page the same empty answer is the usual "no items on screen yet".
    landWith(s, HATS, 200, '<html>hats, cards still coming</html>');
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.importHtml.mockResolvedValueOnce(importResult({ batchId: 0, parsed: 0, stored: 0, bank: 'hats', newFlips: undefined, warnings: [] }));
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { warning: 'no-cards-saved' } });
  });

  it('reads only pages the import reads: never the front page, raffles or settings, on load or on Read page now (F21-4)', async () => {
    const s = setup();
    s.m.open();
    s.toolbarReady();
    for (const url of ['https://scrap.tf/raffles', 'https://scrap.tf/raffles/AB12CD', 'https://scrap.tf/raffles?page=2', 'https://scrap.tf/settings', SCRAPTF_HOME_URL]) {
      s.ctl.t += READ_AUTO_MIN_GAP_MS;
      s.land(url);
      s.wc().emit('did-navigate-in-page', {}, url, true);
      await s.settle();
      expect(lastNav(s).importable, url).toBe(false);
      s.ctl.t += READ_MANUAL_MIN_GAP_MS;
      await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.notImportable });
    }
    expect(s.wc().executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(s.timers.setTimeout).not.toHaveBeenCalled();
    expect(s.importHtml).not.toHaveBeenCalled();
    // A bank page read with its query, as before.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(`${HATS}?sort=price`);
    expect(lastNav(s).importable).toBe(true);
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => p.address)).toEqual([`${HATS}?sort=price`]);
  });

  it('only brings the window up for a dashboard link to the page already on screen (F21-7)', () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    s.toolbarReady();
    s.win().visible = false;
    s.m.open(HATS);
    expect(s.win().visible).toBe(true);
    expect(s.wc().loads).toEqual([[HATS]]);
    // The same page under an anchor is the same page.
    s.wc().url = `${HATS}#top`;
    s.m.open(HATS);
    expect(s.wc().loads).toEqual([[HATS]]);
    // Another page loads; so does the same page while another load is still under way, or under a query.
    s.m.open(WEAPONS);
    s.wc().url = HATS;
    s.wc().mainFrameLoading = true;
    s.m.open(HATS);
    s.wc().mainFrameLoading = false;
    s.wc().url = `${HATS}?sort=price`;
    s.m.open(HATS);
    expect(s.wc().loads).toEqual([[HATS], [WEAPONS], [HATS], [HATS]]);
    // A toolbar chip is the user's own load of it, as before.
    s.wc().url = HATS;
    s.m.go(HATS);
    expect(s.wc().loads).toHaveLength(5);
  });
});

describe('0.7.1: what the toolbar is told (F21-1, F21-10, UX-3)', () => {
  const lastNav = (s: ReturnType<typeof setup>) => s.pushes<ScraptfWindowNav>('scraptfWindow.nav').at(-1)!;

  it('says why a page did not load, by its error group, and that the page crashed, until the next page commits', () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS);
    expect(lastNav(s).notice).toBeNull();
    const fail = (code: number, isMainFrame = true) => s.wc().emit('did-fail-load', {}, code, 'X', HATS, isMainFrame);
    fail(-3);
    expect(lastNav(s).notice).toBeNull();
    fail(-105);
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.offline);
    fail(-202);
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.insecure);
    fail(-310);
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.badResponse);
    fail(-501);
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.loadFailed);
    // A frame's failure says nothing about the page.
    fail(-105, false);
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.loadFailed);
    for (const n of Object.values(SCRAPTF_WINDOW_NOTICES)) expect(n).not.toMatch(/https?:|\?|#/);
    s.land(HATS);
    expect(lastNav(s).notice).toBeNull();
    s.wc().emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.crashed);
    expect(SCRAPTF_WINDOW_NOTICES.crashed).toMatch(/press Reload\.$/);
    s.land(HATS);
    expect(lastNav(s).notice).toBeNull();
    // Saying so moved nothing: the user presses Reload.
    expect(fake.journal.filter((j) => j.includes(' view'))).toEqual([`load view ${HATS}`]);
  });

  it('notes a link it kept, a dropped popup and a link out without a click: once, never over a page notice', () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS);
    const before = s.pushes('scraptfWindow.nav').length;
    // A page script trying again and again: one push, not one per try.
    for (let i = 0; i < 100; i++) s.wc().emit('will-navigate', navEvent(`https://evil.example/${i}`));
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.blocked);
    expect(s.pushes('scraptfWindow.nav').length - before).toBe(1);
    // Alternating kinds as fast does not flood it either: one link notice replaces another at most once a second.
    for (let i = 0; i < 100; i++) {
      s.wc().openHandler!({ url: WEAPONS });
      s.wc().emit('will-navigate', navEvent(`https://evil.example/x${i}`));
    }
    expect(s.pushes('scraptfWindow.nav').length - before).toBe(1);
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.blocked);
    s.ctl.t += 1_000;
    s.wc().openHandler!({ url: WEAPONS });
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.popup);
    s.ctl.t += 1_000;
    s.wc().emit('will-navigate', navEvent(BPTF));
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.needsClick);
    expect(s.openExternal).not.toHaveBeenCalled();
    // A link out after the user's click opens and says nothing.
    s.land(HATS);
    s.ctl.t += EXTERNAL_OPEN_MIN_GAP_MS;
    s.click();
    s.wc().emit('will-navigate', navEvent(BPTF));
    expect(s.openExternal).toHaveBeenCalledTimes(1);
    expect(lastNav(s).notice).toBeNull();
    // A page notice outranks a link's.
    s.wc().emit('did-fail-load', {}, -105, 'X', HATS, true);
    s.wc().emit('will-navigate', navEvent('https://evil.example/again'));
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.offline);
  });

  it("shows the page on screen's own last read when it is not read again within the gap", async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.importHtml.mockImplementation(async (p) => importResult({ fileName: p.fileName, bank: p.address.includes('weapons') ? 'weapons' : 'hats' }));
    s.land(HATS, '<html>h</html>');
    await s.settle();
    s.ctl.t += 5_000;
    s.land(WEAPONS, '<html>w</html>');
    await s.settle();
    // Back on hats within the gap: not read, but the toolbar shows hats' read, saying how to read it again.
    s.ctl.t += 5_000;
    s.land(HATS, '<html>h</html>');
    await flush();
    const reads = s.pushes<ScraptfWindowRead>('scraptfWindow.read');
    expect(reads.map((r) => [r.path, r.warning])).toEqual([
      ['/buy/hats', null],
      ['/buy/weapons', null],
      ['/buy/hats', SCRAPTF_NOT_READ_AGAIN],
    ]);
    expect(reads[2]!.at).toBe(reads[0]!.at);
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(4);
    expect(s.importHtml).toHaveBeenCalledTimes(2);
    expect(s.m.state().lastRead).toEqual(reads[2]);
    // In-page steps on it within the gap push nothing more.
    s.wc().emit('did-navigate-in-page', {}, HATS, true);
    await flush();
    expect(s.pushes('scraptfWindow.read')).toHaveLength(3);
    // Unchanged past the gap (the dedupe): the same, from the read that was not imported again.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(WEAPONS, '<html>w</html>');
    await s.settle();
    expect(s.pushes<ScraptfWindowRead>('scraptfWindow.read').at(-1)).toMatchObject({ path: '/buy/weapons', warning: SCRAPTF_NOT_READ_AGAIN });
    expect(s.importHtml).toHaveBeenCalledTimes(2);
  });

  it("never shows a page's last read again once the user has moved on to another page", async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.importHtml.mockImplementation(async (p) => importResult({ fileName: p.fileName, bank: p.address.includes('weapons') ? 'weapons' : 'hats' }));
    s.land(HATS, '<html>h</html>');
    await s.settle();
    s.ctl.t += 10_000;
    s.land(WEAPONS, '<html>w</html>');
    await s.settle();
    // Hats again past its gap, unchanged within the dedupe, and the user moves on before its settle read: its
    // held snapshot is not imported again, and its read is not put over weapons, which is on screen now.
    s.ctl.t += READ_AUTO_MIN_GAP_MS;
    s.land(HATS, '<html>h</html>');
    await flush();
    s.ctl.t += 1_000;
    s.land(WEAPONS, '<html>w</html>');
    await flush();
    expect(s.importHtml).toHaveBeenCalledTimes(2);
    expect(s.pushes<ScraptfWindowRead>('scraptfWindow.read').map((r) => r.path)).toEqual(['/buy/hats', '/buy/weapons']);
    expect(s.m.state().lastRead).toMatchObject({ path: '/buy/weapons' });
  });

  it('says the item data is still loading when the import refuses for that, keeps nothing, and the next read imports (F21-1)', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS, `<html>${PAGE_MARKER}</html>`);
    s.importHtml.mockRejectedValueOnce(new Error(IMPORT_SCHEMA_LOADING_MESSAGE));
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: SCRAPTF_READ_REASONS.schemaLoading, read: { path: '/buy/hats', items: 0, warning: SCRAPTF_READ_REASONS.schemaLoading } });
    expect(s.log.warn.mock.calls.map(([m]) => m)).toContain('scrap.tf window: item data is still loading, so a read was not imported');
    // The cause's own words stay out of the log.
    expect(s.logged()).not.toContain('cannot be read yet');
    expect(s.logged()).not.toContain(PAGE_MARKER);
    // Nothing was remembered: the same page imports on the next Read page now.
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: null, read: { items: 48 } });
    expect(s.importHtml).toHaveBeenCalledTimes(2);

    // Automatic reads too: the page keeps autoEmpty, so its next document reads within the gap.
    const a = setup();
    a.m.open(HATS);
    a.importHtml.mockRejectedValueOnce(new Error(IMPORT_SCHEMA_LOADING_MESSAGE));
    a.land(HATS);
    await a.settle();
    a.ctl.t += 5_000;
    a.land(HATS);
    await a.settle();
    expect(a.importHtml).toHaveBeenCalledTimes(2);
    expect(a.m.state().lastRead).toMatchObject({ items: 48, warning: null });
  });

  it('shows the warning that matters most on a page on screen, with its counts as digits only', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.land(HATS);
    const warningOf = async (over: Partial<ImportResult>) => {
      s.ctl.t += READ_MANUAL_MIN_GAP_MS;
      s.wc().html = `<html>${s.ctl.t}</html>`;
      s.importHtml.mockResolvedValueOnce(importResult(over));
      return (await s.m.readNow()).read!.warning;
    };
    // Duplicate copies and a guessed page kind are no news on screen.
    expect(await warningOf({ warnings: ['duplicate-cards: ignored 2 selected-item copies', 'page-kind-guessed: treated as buy from the page title/layout'] })).toBeNull();
    const all = [
      'duplicate-cards: ignored 2 cards',
      `unparsed-price: "${PAGE_MARKER}"`,
      'no-pays-column: no "Price we pay" column found',
      `unknown-bank: ${PAGE_MARKER} is not a scrap.tf bank page this app knows`,
      'no-price-column: no "Price to buy" column',
      'no-sku: 2 of 48 items could not be identified',
      `no-stock-limit: 5 rows ${PAGE_MARKER}`,
      'layout-changed: 12 item elements not recognised',
      'partial-read: 3 of ~48 items on screen; read the page again once every card shows',
    ];
    const expected = ['partial-read: 3 48', 'layout-changed', 'no-stock-limit: 5', 'no-sku: 2 48', 'no-price-column', 'unknown-bank', 'no-pays-column', 'unparsed-price'];
    for (let i = 0; i < expected.length; i++) expect(await warningOf({ warnings: all.slice(0, all.length - i) })).toBe(expected[i]);
    // Nothing recorded: a changed layout is said before "no items on screen yet".
    expect(await warningOf({ batchId: 0, parsed: 0, stored: 0, warnings: ['nothing-to-import: this scrap.tf page shows no items to import (yet)', 'layout-changed: 4 item elements not recognised'] })).toBe('layout-changed');
    expect(s.logged()).not.toContain(PAGE_MARKER);
    expect(JSON.stringify(s.m.state())).not.toContain(PAGE_MARKER);
  });

  it("copies the page's stored prices, flips on sale and best flip into the read, checked", async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.land(HATS);
    const readOf = async (over: Partial<ImportResult>) => {
      s.ctl.t += READ_MANUAL_MIN_GAP_MS;
      s.wc().html = `<html>${s.ctl.t}</html>`;
      s.importHtml.mockResolvedValueOnce(importResult(over));
      return (await s.m.readNow()).read!;
    };
    const top = { sku: '378;6', name: 'Team Captain', costScrap: 40, maxCostScrap: 44, profitScrap: 4 };
    expect(await readOf({ stored: 46, newFlips: 2, pageFlips: 10, topFlips: [top, { ...top, sku: '30;6', name: 'Bill', profitScrap: 2 }] })).toEqual({
      at: s.ctl.t,
      path: '/buy/hats',
      items: 48,
      bank: 'hats',
      newFlips: 2,
      warning: null,
      stored: 46,
      pageFlips: 10,
      bestFlip: { sku: '378;6', name: 'Team Captain', profitScrap: 4 },
    });
    // Only a SKU the dashboard can open, and a name, cleaned and cut.
    expect((await readOf({ pageFlips: 1, topFlips: [{ ...top, sku: 'javascript:alert(1)' }] })).bestFlip).toBeNull();
    expect((await readOf({ pageFlips: 1, topFlips: [{ ...top, name: '  ' }] })).bestFlip).toBeNull();
    expect((await readOf({ pageFlips: 1, topFlips: [{ ...top, name: `Team\u0007Captain${'x'.repeat(300)}` }] })).bestFlip!.name).toMatch(/^Team Captainx+$/);
    expect((await readOf({ pageFlips: 1, topFlips: [{ ...top, name: `Team${'x'.repeat(300)}` }] })).bestFlip!.name).toHaveLength(120);
    // No flips on the page: none, and no best.
    expect(await readOf({ pageFlips: 0, topFlips: [] })).toMatchObject({ pageFlips: 0, bestFlip: null });
    // An older service that reports no flips: left out, as before.
    const old = await readOf({});
    expect('pageFlips' in old || 'bestFlip' in old).toBe(false);
  });
});

// UX-071-1: the user moves on within READ_SETTLE_MS of a load, so the commit imports the held load snapshot
// (endCycle, flushHeld) while the next document brings a page notice. That import ends later, and its read
// must not take the toolbar's line from the notice: nothing reads the notice's page on its own to replace it.
describe('0.7.1: a late read of the page before never hides the page notice (UX-071-1)', () => {
  const lastNav = (s: ReturnType<typeof setup>) => s.pushes<ScraptfWindowNav>('scraptfWindow.nav').at(-1)!;
  /** A document the user's browsing committed with an HTTP status, then loaded. */
  const landWith = (s: ReturnType<typeof setup>, url: string, status: number) => {
    s.wc().url = url;
    s.wc().emit('did-navigate', {}, url, status, '');
    s.wc().emit('did-finish-load');
    s.wc().emit('did-stop-loading');
  };
  /** HATS loaded and its load snapshot held, its settle read still pending. */
  const heldHats = async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS, '<html>hats cards</html>');
    await flush();
    expect(s.pending()).toHaveLength(1);
    expect(s.importHtml).not.toHaveBeenCalled();
    return s;
  };
  const cases: [string, (s: ReturnType<typeof setup>) => void, string][] = [
    ['another page that answers 429', (s) => landWith(s, WEAPONS, 429), SCRAPTF_WINDOW_NOTICES.rateLimited],
    ['another page that answers with a Cloudflare check', (s) => landWith(s, WEAPONS, 403), SCRAPTF_WINDOW_NOTICES.challenge],
    ['a link that fails to load', (s) => s.wc().emit('did-fail-load', {}, -106, 'X', WEAPONS, true), SCRAPTF_WINDOW_NOTICES.offline],
    ['the same address reloaded into a 429', (s) => {
      s.m.reload();
      landWith(s, HATS, 429);
    }, SCRAPTF_WINDOW_NOTICES.rateLimited],
  ];
  for (const [what, move, notice] of cases) {
    it(`keeps the notice of ${what} on the line`, async () => {
      const s = await heldHats();
      move(s);
      await flush();
      await flush();
      // The held snapshot was imported (unsettled), and remembered for its page, but not shown.
      expect(s.importHtml.mock.calls.map(([q]) => [q.address, q.settled])).toEqual([[HATS, false]]);
      expect(s.pushes('scraptfWindow.read')).toEqual([]);
      expect(s.m.state().lastRead).toBeNull();
      expect(lastNav(s).notice).toBe(notice);
      expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
    });
  }

  it('a failed import of the held snapshot does not take the line either; Read page now still does', async () => {
    const s = await heldHats();
    s.importHtml.mockRejectedValueOnce(new Error('disk full'));
    landWith(s, WEAPONS, 429);
    await flush();
    await flush();
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    expect(s.pushes('scraptfWindow.read')).toEqual([]);
    expect(lastNav(s).notice).toBe(SCRAPTF_WINDOW_NOTICES.rateLimited);
    // The user's own read of the rate-limit page is shown (worded by the notice when it found nothing).
    s.importHtml.mockResolvedValueOnce(importResult({ batchId: 0, parsed: 0, stored: 0, bank: 'weapons', newFlips: undefined, warnings: [] }));
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: null, read: { items: 0, warning: SCRAPTF_WINDOW_NOTICES.rateLimited } });
    expect(s.pushes<ScraptfWindowRead>('scraptfWindow.read').map((r) => r.path)).toEqual(['/buy/weapons']);
  });

  it("shows the remembered read once the user is back on that page, and a page with no notice as before", async () => {
    const s = await heldHats();
    landWith(s, WEAPONS, 429);
    await flush();
    await flush();
    expect(s.pushes('scraptfWindow.read')).toEqual([]);
    // Back on hats within the gap: not read again, its remembered read takes the line.
    s.ctl.t += 2_000;
    landWith(s, HATS, 200);
    expect(lastNav(s).notice).toBeNull();
    expect(s.pushes<ScraptfWindowRead>('scraptfWindow.read').map((r) => [r.path, r.warning])).toEqual([['/buy/hats', SCRAPTF_NOT_READ_AGAIN]]);
    // Without a notice the held snapshot's read is shown as before (the next page is still loading).
    const t = await heldHats();
    landWith(t, WEAPONS, 200);
    await flush();
    await flush();
    expect(t.pushes<ScraptfWindowRead>('scraptfWindow.read').map((r) => r.path)).toContain('/buy/hats');
  });
});

describe('0.7.1: the keys with the page focused (F21-11)', () => {
  const press = (s: ReturnType<typeof setup>, input: Record<string, unknown>, c = s.wc()) => {
    const e = { preventDefault: vi.fn() };
    c.emit('before-input-event', e, { type: 'keyDown', key: '', code: '', alt: false, control: false, meta: false, shift: false, isAutoRepeat: false, ...input });
    return e;
  };

  it('turns F5, Ctrl+R, Alt+Left, Alt+Right and Alt+Home in the page into one move each, never a held key', () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS);
    fake.journal.length = 0;
    s.wc().canBack = true;
    s.wc().canForward = true;
    const f5 = press(s, { key: 'F5' });
    expect(f5.preventDefault).toHaveBeenCalled();
    for (let i = 0; i < 5; i++) press(s, { key: 'F5', isAutoRepeat: true });
    expect(press(s, { key: 'F5', type: 'keyUp' }).preventDefault).not.toHaveBeenCalled();
    press(s, { key: 'r', control: true });
    press(s, { key: 'ArrowLeft', alt: true });
    press(s, { key: 'ArrowRight', alt: true });
    press(s, { key: 'Home', alt: true });
    // Every other key is the page's own.
    for (const input of [{ key: 'a' }, { key: 'ArrowLeft' }, { key: 'r' }, { key: 'F5', shift: true }, { key: 'r', control: true, alt: true }, { key: 'Home', meta: true }]) {
      expect(press(s, input).preventDefault, JSON.stringify(input)).not.toHaveBeenCalled();
    }
    expect(fake.journal).toEqual(['reload view', 'reload view', 'back view', 'forward view', `load view ${SCRAPTF_HOME_URL}`]);
    // The mouse's back and forward buttons (Windows' app-command); nothing else it sends.
    s.win().emit('app-command', {}, 'browser-backward');
    s.win().emit('app-command', {}, 'browser-forward');
    s.win().emit('app-command', {}, 'browser-refresh');
    s.win().emit('app-command', {}, 'media-play-pause');
    expect(fake.journal.slice(5)).toEqual(['back view', 'forward view']);
    // Nothing is sent to the page or run in it, and the focus stays where the user put it.
    expect(s.wc().sendInputEvent).not.toHaveBeenCalled();
    expect(s.wc().executeJavaScript).not.toHaveBeenCalled();
    expect(s.wc().focus).not.toHaveBeenCalled();
  });

  it("moves nothing for a closed window's view, or while the window is off", () => {
    const s = setup();
    s.m.open(HATS);
    const old = s.wc();
    const oldWin = s.win();
    s.m.close();
    s.m.open();
    fake.journal.length = 0;
    press(s, { key: 'F5' }, old);
    oldWin.emit('app-command', {}, 'browser-backward');
    expect(fake.journal).toEqual([]);
    s.ctl.settings = windowSettings({ enabled: false });
    press(s, { key: 'F5' });
    s.win().emit('app-command', {}, 'browser-forward');
    expect(fake.journal).toEqual([]);
  });
});

describe('0.7.1: the window remembers where it was (F21-12)', () => {
  const FILE = 'C:/data/scraptf-window-bounds.json';
  const LEFT = { x: 0, y: 0, width: 1920, height: 1040 };
  const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };

  function bounded(areas: { x: number; y: number; width: number; height: number }[], text: string | null, cursor?: { x: number; y: number }) {
    const file = { text };
    const screen = fakeScreen(areas, cursor);
    const s = setup(
      {},
      {
        bounds: {
          file: FILE,
          screen,
          readFile: (f) => {
            expect(f).toBe(FILE);
            if (file.text === null) throw Object.assign(new Error('no file'), { code: 'ENOENT' });
            return file.text;
          },
          writeFile: (f, t) => {
            expect(f).toBe(FILE);
            file.text = t;
          },
        },
      },
    );
    return { ...s, file };
  }

  it('opens at the default size on the display under the cursor the first time, and comes back where the user left it', () => {
    const s = bounded([LEFT, RIGHT], null, { x: 2000, y: 100 });
    s.m.open();
    expect(s.win().opts).toMatchObject({ x: 1920 + (2560 - 1280) / 2, y: (1400 - 900) / 2, width: 1280, height: 900, minWidth: 640, minHeight: 480 });
    // The user moves and resizes it, then closes it.
    s.win().normal = { x: 2000, y: 50, width: 1500, height: 1000 };
    s.win().emit('close', {});
    s.win().destroy();
    expect(JSON.parse(s.file.text!)).toEqual({ version: 1, x: 2000, y: 50, width: 1500, height: 1000, maximized: false });
    s.m.open();
    expect(fake.FakeWin.all).toHaveLength(2);
    expect(s.win().opts).toMatchObject({ x: 2000, y: 50, width: 1500, height: 1000 });
    expect(s.logged()).not.toContain('could not');
  });

  it('comes back maximised once it has painted, and the window turned off remembers it too', () => {
    const s = bounded([LEFT], JSON.stringify({ version: 1, x: 100, y: 100, width: 1300, height: 900, maximized: true }));
    s.m.open();
    expect(s.win().opts).toMatchObject({ x: 100, y: 100, width: 1300, height: 900 });
    expect(s.win().maximizeCalls).toBe(0);
    s.toolbarReady();
    expect(s.win().maximizeCalls).toBe(1);
    expect(s.win().visible).toBe(true);
    s.m.focus();
    expect(s.win().maximizeCalls).toBe(1);
    // main's close() (the window turned off) destroys it without a 'close' event: remembered all the same.
    s.win().normal = { x: 120, y: 90, width: 1310, height: 880 };
    s.m.close();
    expect(JSON.parse(s.file.text!)).toEqual({ version: 1, x: 120, y: 90, width: 1310, height: 880, maximized: true });
  });

  it('opens on the cursor display at the default size when no display shows the remembered place (a monitor gone, a bad file)', () => {
    for (const text of [JSON.stringify({ version: 1, x: 3000, y: 200, width: 1280, height: 900, maximized: true }), '{not json', JSON.stringify({ version: 2, x: 1, y: 1, width: 900, height: 700, maximized: false }), JSON.stringify({ version: 1, x: 'a' })]) {
      fake.FakeWin.all = [];
      const s = bounded([LEFT], text);
      s.m.open();
      expect(s.win().opts, text).toMatchObject({ x: 320, y: 70, width: 1280, height: 900 });
      s.toolbarReady();
      expect(s.win().maximizeCalls).toBe(0);
    }
  });
});
