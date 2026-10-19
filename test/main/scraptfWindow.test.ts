// F21: the scrap.tf window module against Electron fakes. The window loads a page only when the user asks
// (open, a toolbar control, Log out & clear), applies scraptfWindowPolicy to every navigation, frame and
// popup, reads only scrap.tf pages with the pinned READ_SCRIPT (on load, one settle read, Read page now),
// dedupes and throttles those reads, imports them as origin 'window', and never sets a user agent, reads
// a cookie or logs page content or a URL query.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCRAPTF_BAR_URL } from '../../src/main/paths';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
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
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_OFF,
  USER_ACTIVATION_MS,
} from '../../src/shared/scraptfWindowPolicy';
import type { ImportResult, ScraptfWindowNav, ScraptfWindowRead, Settings } from '../../src/shared/types';
import { fake } from './scraptfWindowFakes';

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

  it('applies a keepLoggedIn change on the next open: a new view on the new partition', () => {
    const s = setup();
    s.m.open(HATS);
    const first = s.view();
    s.ctl.settings = windowSettings({ keepLoggedIn: true });
    // A toolbar click keeps the live view as it is.
    s.m.go(WEAPONS);
    expect(fake.FakeView.all).toHaveLength(1);
    s.m.open();
    expect(fake.FakeWin.all).toHaveLength(1);
    expect(fake.FakeView.all).toHaveLength(2);
    expect(first.webContents.closes).toBe(1);
    expect(s.win().children).toEqual([s.view()]);
    expect(s.view().opts.webPreferences.partition).toBe(SCRAPTF_PERSIST_PARTITION);
    expect(s.wc().loads).toEqual([[SCRAPTF_HOME_URL]]);
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
    const read: ScraptfWindowRead = { at: T + READ_SETTLE_MS, path: '/buy/hats', items: 48, bank: 'hats', newFlips: 2, warning: null };
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

  it('imports the held load snapshot when its settle read cannot run (another page, a crash, close, a failed script)', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS, '<html>h1</html>');
    await flush();
    // The user's click put another document on screen before the settle read: the load snapshot is the look.
    s.ctl.t += 1_000;
    s.land(WEAPONS, '<html>w1</html>');
    await flush();
    expect(s.importHtml.mock.calls.map(([p]) => [p.address, p.html, p.mtimeMs])).toEqual([[HATS, '<html>h1</html>', T]]);
    // The settle read's script fails: the load snapshot it held is imported instead.
    s.wc().executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('gone'));
    await s.settle();
    expect(s.importHtml.mock.calls.map(([p]) => p.html)).toEqual(['<html>h1</html>', '<html>w1</html>']);
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
    // Each was read once: nothing was read again to import it.
    expect(s.wc().executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(5);
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
    const nothing = () => importResult({ batchId: 0, pageKind: 'unknown', parsed: 0, stored: 0, bank: null, newFlips: undefined });
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
    s.land(SCRAPTF_HOME_URL);
    s.importHtml.mockResolvedValueOnce(importResult({ warnings: [`unparsed-price: "${PAGE_MARKER}"`, 'other'], newFlips: undefined, bank: undefined }));
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { path: '/', warning: 'unparsed-price', newFlips: 0, bank: null } });
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
    const expected: ScraptfWindowNav = { url: HATS, canGoBack: true, canGoForward: false, loading: false, reading: false };
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
      appInfo: () => ({ version: '0.7.0', dataDir: 'd', logDir: 'l', platform: 'win32', electron: '44', node: '24' }),
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
});
