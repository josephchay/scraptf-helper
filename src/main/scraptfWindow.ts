// F21: the opt-in scrap.tf window, the only place in Flip Desk that shows scrap.tf. The user browses it
// themselves (docs/DESIGN_BRIEF.md §3.5 option D, chosen by the user on 2026-10-19 after being told the
// ToS and ban risk). One BrowserWindow: an app:// toolbar (window kind 'scraptf', SCRAPTF_BAR_URL, normal
// preload and hardening) above a WebContentsView for scrap.tf with NO preload, sandboxed, on its own
// partition.
//
// Hard limits (test/compliance/static.test.ts, the F21 block, checks this file):
// - the view loads a page only through userNavigate(), called only from the user-action functions below
//   (open, back, forward, reload, home, go, clear), never from a timer, an event handler or a promise
//   callback; the only URLs it loads are isAllowedWindowStart pages (or history steps);
// - the one timer is the single READ_SETTLE_MS settle read, `timers.setTimeout(() => void readPage('settle'), READ_SETTLE_MS)`;
// - the only code run in the view is READ_SCRIPT in isolated world READ_WORLD_ID, on scrap.tf pages only,
//   and only on a document that has stopped loading (canRunNow): Electron would otherwise hold the script
//   back and run it on whatever document comes next, such as Steam's sign-in;
// - no setUserAgent, no cookies API, no header rewriting, no input events sent, no DOM writes, no trading;
// - a page reaches the user's browser only right after the user's own input to the view (USER_ACTIVATION_MS);
// - nothing about a page is logged but its origin and path (no query, no content, no cookie), and lines a
//   page can trigger at its own rate go through a PageLog.

import { createHash } from 'node:crypto';
import { BrowserWindow, session, WebContentsView, type Session, type WebContents, type WebPreferences } from 'electron';
import type { Logger } from '../service/contracts';
import { SCRAPTF_HOME_URL } from '../shared/links';
import type { PushContract, PushEvent } from '../shared/rpc';
import {
  EXTERNAL_OPEN_MIN_GAP_MS,
  isAllowedWindowStart,
  READ_AUTO_MIN_GAP_MS,
  READ_DEDUPE_MS,
  READ_MANUAL_MIN_GAP_MS,
  READ_SCRIPT,
  READ_SETTLE_MS,
  READ_WORLD_ID,
  readResultHtml,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_OFF,
  scraptfPathOf,
  shouldReadUrl,
  subframeNavigationDecision,
  topLevelNavigationDecision,
  USER_ACTIVATION_MS,
  windowDisplayUrl,
  windowReadFileName,
} from '../shared/scraptfWindowPolicy';
import type { ImportResult, ScraptfReadOutcome, ScraptfWindowNav, ScraptfWindowRead, ScraptfWindowState, Settings, UnixMs } from '../shared/types';
import { createPageLog } from './pageLog';
import { SCRAPTF_BAR_URL } from './paths';
import { DARK_BACKGROUND, hardenScraptfSession, windowWebPreferences } from './windows';

/** keepLoggedIn false: an in-memory session, gone when the app quits. */
export const SCRAPTF_MEMORY_PARTITION = 'scraptf';
/** keepLoggedIn true: Chromium's own cookie store on disk, in the app's user data. The app never reads it. */
export const SCRAPTF_PERSIST_PARTITION = 'persist:scraptf';

export const SCRAPTF_WINDOW_TITLE = 'scrap.tf · Flip Desk';
/** The toolbar page's height; the scrap.tf view covers the window below it. */
export const SCRAPTF_TOOLBAR_HEIGHT = 48;
/** open/go refusal (fixed text: the URL is never quoted). */
export const SCRAPTF_START_REFUSAL = 'Not a scrap.tf page the window opens.';
/** A read of a page the import recognised nothing on (scrap.tf's front page, a profile). */
export const SCRAPTF_NOTHING_TO_IMPORT = 'Nothing to import on this page.';

const MAX_WARNING_CHARS = 160;
/** Pages whose read times are remembered for the gap and the dedupe (older entries go first). */
const MAX_REMEMBERED_PAGES = 64;
/** net::ERR_ABORTED: the user clicked on before the page finished, not a failure worth a warning. */
const ERR_ABORTED = -3;
/** A settle read skipped because the user turned reading on load off after the page loaded. */
const READ_ON_LOAD_OFF = 'Reading on load is off.';
/**
 * A recognised bank or list page read before its cards arrived: the import's own code for it, which the
 * toolbar words as "no items on screen yet; wait for them, then Read page now".
 */
const NO_CARDS_YET = 'no-cards-saved';
/** Input that is the user's own act in the page (not a mouse move or wheel): it lets one link open outside. */
const ACTIVATING_INPUTS: ReadonlySet<string> = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'gestureTap']);

export function scraptfPartition(keepLoggedIn: boolean): string {
  return keepLoggedIn ? SCRAPTF_PERSIST_PARTITION : SCRAPTF_MEMORY_PARTITION;
}

/**
 * The scrap.tf view's webPreferences: no preload (nothing of ours runs in scrap.tf's world), sandboxed,
 * isolated, no Node, web security on, its own partition. The compliance scan reads this function and
 * requires `new WebContentsView({ webPreferences: scraptfViewWebPreferences(…) })` to be the only view.
 */
export function scraptfViewWebPreferences(partition: string, devTools: boolean): WebPreferences {
  return {
    partition,
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
    devTools,
  };
}

/** What main's 'import.html' call carries for a window read; only main sets address and origin. */
export interface WindowImportParams {
  html: string;
  /** windowReadFileName(url): 'scrap.tf window /buy/hats'. */
  fileName: string;
  mtimeMs: UnixMs;
  /** The page's URL (isScraptfPageUrl), a page-address hint for the parser; never logged. */
  address: string;
  origin: 'window';
}

export interface ScraptfWindowTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// A pass-through only; the compliance scan allows exactly this shape besides the settle read.
const REAL_TIMERS: ScraptfWindowTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ScraptfWindowDeps {
  settings(): Settings;
  log: Logger;
  preloadPath: string;
  iconPath: string;
  devTools: boolean;
  /** 'import.html' straight to the service (host.call): the only caller that may set address and origin. */
  importHtml(p: WindowImportParams): Promise<ImportResult>;
  /** The user's browser (shell.openExternal), for a page topLevelNavigationDecision calls 'external'. */
  openExternal(url: string): Promise<void>;
  isQuitting(): boolean;
  /** After any change state() would show (the tray item, a dashboard that asks). */
  onStateChanged?(): void;
  now?: () => UnixMs;
  timers?: ScraptfWindowTimers;
}

/** A move of the view the user asked for; userNavigate() is the only code that loads or steps the view. */
export type UserNav = { kind: 'start'; url: string } | { kind: 'back' } | { kind: 'forward' } | { kind: 'reload' };

export interface ScraptfWindowManager {
  /**
   * Creates the window or brings it to the front. `start` (isAllowedWindowStart, else it throws) is
   * loaded when given; a new window without one loads Home. Throws SCRAPTF_WINDOW_OFF while the window
   * is turned off (main checks too). A keepLoggedIn change since the view was made applies here: the
   * view is rebuilt on the new partition and loads `start` or Home.
   */
  open(start?: string): void;
  /** Brings an open window to the front; false when there is none. */
  focus(): boolean;
  /** Closes the window (the session stays as keepLoggedIn says). */
  close(): void;
  back(): void;
  forward(): void;
  reload(): void;
  /** Loads scrap.tf's front page (SCRAPTF_HOME_URL); opens the window when it is closed. */
  home(): void;
  /** Loads one static start page; throws for anything isAllowedWindowStart refuses. */
  go(url: string): void;
  /**
   * "Read page now": one read now (READ_MANUAL_MIN_GAP_MS apart). It ends an automatic cycle of the page; a
   * page unchanged since its last import (READ_DEDUPE_MS) is not imported again, and that read is shown.
   */
  readNow(): Promise<ScraptfReadOutcome>;
  /**
   * "Log out & clear": clearStorageData() and clearCache() of both window partitions (the one in use and
   * a login kept from before a keepLoggedIn change), a null read to the toolbar, then Home if the window is open.
   */
  clear(): Promise<void>;
  state(): ScraptfWindowState;
  /** Delivers a push to the toolbar page; only settings.changed (theme) and service.state get through. */
  send<E extends PushEvent>(event: E, payload: PushContract[E]): void;
  /** True for the scrap.tf view's WebContents (hardenWebContents' ownNavigation). */
  ownsContents(contents: unknown): boolean;
  /** Quit: closes everything; nothing loads afterwards. */
  dispose(): void;
}

/** What the module remembers per page (URL without the hash): the automatic-read gap and the dedupe. */
interface PageMemo {
  autoAt: UnixMs | null;
  /**
   * No read of the page has recognised an item since its last automatic cycle began (a Cloudflare check
   * served at the page's own address, a read that failed). The next document load of the page then reads
   * within the gap: nothing was imported, so there is nothing for the gap to hold back.
   */
  autoEmpty: boolean;
  /** The last imported read of the page: its HTML's hash, when, and what the toolbar was told. */
  hash: string | null;
  readAt: UnixMs | null;
  read: ScraptfWindowRead | null;
}

type ReadTrigger = 'load' | 'settle' | 'manual';

/** One snapshot of a page's DOM, as READ_SCRIPT returned it. */
interface Snapshot {
  key: string;
  url: string;
  html: string;
  hash: string;
}

/** A cycle's load snapshot, held for its settle read (one look at a page is one save of it). */
interface HeldSnapshot extends Snapshot {
  wc: WebContents;
  /** The cycle's start: the time the look is imported at. */
  at: UnixMs;
}

/** Pushes the toolbar may receive from outside the module (main's broadcasts). */
const FORWARDED_PUSHES: ReadonlySet<PushEvent> = new Set<PushEvent>(['settings.changed', 'service.state']);

const CLOSED_NAV: ScraptfWindowNav = Object.freeze({ url: null, canGoBack: false, canGoForward: false, loading: false });

/** The page a read belongs to: the URL without its hash, so an anchor click is the same page. Memory only. */
function pageKey(url: string): string {
  const at = url.indexOf('#');
  return at < 0 ? url : url.slice(0, at);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The part of an import warning before its first ':' (the code, never the clipped page text after it). */
function shortWarning(w: unknown): string | null {
  if (typeof w !== 'string') return null;
  const head = (w.split(':')[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return head === '' ? null : head.slice(0, MAX_WARNING_CHARS);
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * The URL of the document the view's main frame shows (its last committed URL), which is what a read
 * sees. getURL() already names the next page while a toolbar load (back, a bank chip) is pending, so
 * reading by it would file the old page's DOM under the new page's address and bank. '' when the frame
 * is gone, which no rule reads.
 */
function documentUrl(wc: WebContents): string {
  try {
    const url = wc.mainFrame.url;
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

/**
 * Electron's own test for running a script now (waitTillCanExecuteJavaScript): a URL and a main frame
 * that is not loading. Otherwise executeJavaScriptInIsolatedWorld waits for did-stop-loading and then
 * runs on whatever document is there, which a main-frame navigation still pending (the user's click on
 * "Sign in through Steam", a history step) makes another page than the one just checked.
 */
function canRunNow(wc: WebContents): boolean {
  try {
    return wc.getURL() !== '' && !wc.isLoadingMainFrame();
  } catch {
    return false;
  }
}

export function createScraptfWindowManager(deps: ScraptfWindowDeps): ScraptfWindowManager {
  const { log } = deps;
  // The settle read's timer (the module's only one) and the dedupe clock.
  const timers = deps.timers ?? REAL_TIMERS;
  const now = deps.now ?? Date.now;

  let win: BrowserWindow | null = null;
  let view: WebContentsView | null = null;
  let viewPartition: string | null = null;
  // The toolbar: pushes wait for its page (latest per event); a show waits for its first paint.
  let barLoaded = false;
  let painted = false;
  let wantShow = false;
  const pending = new Map<PushEvent, unknown>();
  const hardened = new Set<string>();

  let settleTimer: unknown = null;
  // The page the current automatic read cycle (load read + settle read) belongs to, and when it began.
  let cycleKey: string | null = null;
  let cycleAt: UnixMs | null = null;
  // The cycle's load snapshot, imported by its settle read (or by endCycle when that cannot run).
  let held: HeldSnapshot | null = null;
  // The view's current document has had its did-finish-load (an in-page navigation after it reads).
  let docLoaded = false;
  // An automatic read that came while the main frame was still loading starts at did-stop-loading.
  let waitingForStop: { newDocument: boolean } | null = null;
  const pages = new Map<string, PageMemo>();
  // The view a read is running in. Per view, so a read whose renderer never answers (the view closed
  // or its renderer died mid-read) holds back only that view's reads, until it is dropped.
  let readingIn: WebContents | null = null;
  let lastManualAt = Number.NEGATIVE_INFINITY;
  let lastExternalAt = Number.NEGATIVE_INFINITY;
  // The user's last click, key press or tap in the view: a page may open one link outside right after it.
  let activationAt = Number.NEGATIVE_INFINITY;
  let lastRead: ScraptfWindowRead | null = null;
  let disposed = false;
  const pageLog = createPageLog(log, now);

  function live(w: BrowserWindow | null): w is BrowserWindow {
    return w !== null && !w.isDestroyed();
  }

  /** The scrap.tf view's WebContents while the window is up, else null. */
  function viewContents(): WebContents | null {
    if (!live(win) || view === null) return null;
    const wc = view.webContents;
    return wc.isDestroyed() ? null : wc;
  }

  function changed(): void {
    try {
      deps.onStateChanged?.();
    } catch (err) {
      log.warn('scrap.tf window: state listener failed', err);
    }
  }

  // ----- the toolbar -----

  function deliver(event: PushEvent, payload: unknown): void {
    const w = win;
    if (!live(w) || w.webContents.isDestroyed()) return;
    if (!barLoaded) {
      pending.delete(event);
      pending.set(event, payload);
      return;
    }
    try {
      w.webContents.send('push', event, payload);
    } catch (err) {
      log.warn(`scrap.tf window: could not deliver ${event} to the toolbar`, err);
    }
  }

  function flushToolbar(): void {
    const queued = [...pending];
    pending.clear();
    for (const [event, payload] of queued) deliver(event, payload);
  }

  function navState(): ScraptfWindowNav {
    const wc = viewContents();
    if (wc === null) return CLOSED_NAV;
    try {
      return {
        url: windowDisplayUrl(wc.getURL()),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        loading: wc.isLoading(),
        reading: settleTimer !== null || held !== null || readingIn === wc,
      };
    } catch {
      return CLOSED_NAV;
    }
  }

  function pushNav(): void {
    deliver('scraptfWindow.nav', navState());
  }

  function pushRead(read: ScraptfWindowRead): void {
    lastRead = read;
    deliver('scraptfWindow.read', read);
    changed();
  }

  // ----- layout and showing -----

  function layout(): void {
    const w = win;
    if (!live(w) || view === null) return;
    const { width, height } = w.getContentBounds();
    view.setBounds({ x: 0, y: SCRAPTF_TOOLBAR_HEIGHT, width: Math.max(0, width), height: Math.max(0, height - SCRAPTF_TOOLBAR_HEIGHT) });
  }

  function reveal(): void {
    const w = win;
    if (!live(w)) return;
    if (!painted) {
      wantShow = true;
      return;
    }
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  // ----- the session, the view and its policy -----

  /** The partition's session, hardened (permissions and downloads refused) before anything loads in it. */
  function scraptfSession(partition: string): Session {
    const ses = session.fromPartition(partition);
    if (!hardened.has(partition)) {
      hardenScraptfSession(ses, log);
      hardened.add(partition);
    }
    return ses;
  }

  /**
   * The only way a page reaches the user's browser: the policy must call it 'external' (checked again here),
   * and the user must have clicked, pressed a key or tapped in the view within USER_ACTIVATION_MS. Each such
   * input opens one tab at most, so a page's script (scrap.tf's, one it includes, Steam's) cannot open a
   * stream of tabs in the user's signed-in browser.
   */
  function openOutside(url: string): void {
    if (topLevelNavigationDecision(url) !== 'external') return;
    const t = now();
    // The twin will-frame-navigate and will-navigate of one click.
    if (t - lastExternalAt < EXTERNAL_OPEN_MIN_GAP_MS) return;
    if (t - activationAt > USER_ACTIVATION_MS) {
      pageLog.line('info', 'external without input', 'scrap.tf window: a page tried to open a link outside without a click', { url: windowDisplayUrl(url) });
      return;
    }
    activationAt = Number.NEGATIVE_INFINITY;
    lastExternalAt = t;
    deps.openExternal(url).catch(() => log.warn('scrap.tf window: the browser did not open a link'));
  }

  function applyTopLevel(event: { preventDefault(): void }, url: string): void {
    const decision = topLevelNavigationDecision(url);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') openOutside(url);
    else pageLog.line('info', 'blocked page', 'scrap.tf window: blocked a page outside scrap.tf and Steam sign-in', { url: windowDisplayUrl(url) });
  }

  function applySubframe(event: { preventDefault(): void }, url: string): void {
    if (subframeNavigationDecision(url) === 'allow') return;
    event.preventDefault();
    pageLog.line('debug', 'blocked frame', 'scrap.tf window: blocked a frame', { url: windowDisplayUrl(url) });
  }

  function isCurrent(wc: WebContents): boolean {
    return view !== null && view.webContents === wc;
  }

  function wireView(wc: WebContents): void {
    // Replaces hardenWebContents' handler (installed inside the constructor). Nothing opens in the app.
    wc.setWindowOpenHandler(({ url }) => {
      if (topLevelNavigationDecision(url) === 'external') openOutside(url);
      else pageLog.line('info', 'dropped popup', 'scrap.tf window: dropped a popup', { url: windowDisplayUrl(url) });
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event) => applyTopLevel(event, event.url));
    wc.on('will-frame-navigate', (event) => (event.isMainFrame ? applyTopLevel(event, event.url) : applySubframe(event, event.url)));
    wc.on('will-redirect', (event) => (event.isMainFrame ? applyTopLevel(event, event.url) : applySubframe(event, event.url)));
    // Only noted, never sent: the user's own input is what lets a link leave for the browser (openOutside).
    wc.on('input-event', (_event, input) => {
      if (isCurrent(wc) && ACTIVATING_INPUTS.has(input.type)) activationAt = now();
    });

    wc.on('did-start-loading', () => {
      if (isCurrent(wc)) pushNav();
    });
    wc.on('did-stop-loading', () => {
      if (!isCurrent(wc)) return;
      pushNav();
      // The automatic read that came while the main frame was loading (see startAutoRead).
      const waiting = waitingForStop;
      waitingForStop = null;
      if (waiting !== null) startAutoRead(waiting.newDocument);
    });
    // A new document is on screen (main frame, committed): the last page's settle read must not read it,
    // and its load snapshot is imported now. Ended at commit rather than at start, so a click the policy
    // blocks or sends to the browser (the page stays) keeps its page's cycle; until then reads see the old
    // page by documentUrl(), and none runs while the main frame loads (canRunNow).
    wc.on('did-navigate', () => {
      if (!isCurrent(wc)) return;
      docLoaded = false;
      waitingForStop = null;
      endCycle();
      pageLog.flush();
      pushNav();
      changed();
    });
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (!isCurrent(wc) || !isMainFrame) return;
      pushNav();
      changed();
      // Before the document's own did-finish-load (a replaceState while it is still coming in), that load
      // reads instead. After it, a frame still loading (a challenge, an embed) does not hold the read back.
      if (docLoaded || !wc.isLoading()) startAutoRead(false);
    });
    wc.on('did-finish-load', () => {
      if (!isCurrent(wc)) return;
      docLoaded = true;
      pushNav();
      startAutoRead(true);
    });
    // No automatic retry, ever: the user clicks Reload.
    wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      log.warn(`scrap.tf window: a page did not load (${code})`);
      // Chromium's error page replaced the document (did-navigate does not fire for it): nothing to settle.
      if (isCurrent(wc)) {
        docLoaded = false;
        waitingForStop = null;
        endCycle();
      }
    });
    wc.on('render-process-gone', (_event, details) => {
      log.error(`scrap.tf window: the page's renderer is gone: ${details.reason}`);
      if (!isCurrent(wc)) return;
      docLoaded = false;
      waitingForStop = null;
      // A read waiting on the dead renderer never answers; the next document may be read.
      if (readingIn === wc) readingIn = null;
      endCycle();
      pushNav();
    });
  }

  function createView(w: BrowserWindow, partition: string): void {
    scraptfSession(partition);
    const v = new WebContentsView({ webPreferences: scraptfViewWebPreferences(partition, deps.devTools) });
    view = v;
    viewPartition = partition;
    docLoaded = false;
    waitingForStop = null;
    activationAt = Number.NEGATIVE_INFINITY;
    v.setBackgroundColor(DARK_BACKGROUND);
    wireView(v.webContents);
    w.contentView.addChildView(v);
    layout();
  }

  /** Closes the view's WebContents (a WebContentsView's is not destroyed with its window). */
  function dropView(): void {
    const v = view;
    // The cycle's load snapshot was read before the view went: it is imported, nothing is read again.
    endCycle();
    view = null;
    viewPartition = null;
    cycleKey = null;
    cycleAt = null;
    waitingForStop = null;
    // A read hung on this view (its renderer never answered) must not hold back the next view's reads.
    if (v !== null && readingIn === v.webContents) readingIn = null;
    pageLog.flush();
    if (v === null) return;
    try {
      if (live(win)) win.contentView.removeChildView(v);
    } catch {
      // The window is going anyway.
    }
    if (!v.webContents.isDestroyed()) v.webContents.close();
  }

  function createWindow(partition: string): void {
    const w = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      show: false,
      title: SCRAPTF_WINDOW_TITLE,
      backgroundColor: DARK_BACKGROUND,
      icon: deps.iconPath,
      autoHideMenuBar: true,
      webPreferences: windowWebPreferences('scraptf', deps.preloadPath, deps.devTools),
    });
    win = w;
    barLoaded = false;
    painted = false;
    wantShow = false;
    pending.clear();

    // The title stays the window's own, whatever the toolbar page calls itself.
    w.on('page-title-updated', (event) => event.preventDefault());
    w.once('ready-to-show', () => {
      if (win !== w) return;
      painted = true;
      if (wantShow) reveal();
    });
    w.on('closed', () => teardown(w));
    w.on('resize', () => layout());
    w.on('maximize', () => layout());
    w.on('unmaximize', () => layout());
    w.on('restore', () => layout());
    w.on('enter-full-screen', () => layout());
    w.on('leave-full-screen', () => layout());

    const bar = w.webContents;
    bar.on('did-start-navigation', (event) => {
      if (win === w && event.isMainFrame && !event.isSameDocument) barLoaded = false;
    });
    bar.on('did-finish-load', () => {
      if (win !== w) return;
      barLoaded = true;
      // Queued pushes first, so the address the toolbar ends on is the current one.
      flushToolbar();
      pushNav();
    });
    bar.on('render-process-gone', (_event, details) => {
      log.error(`scrap.tf window: the toolbar's renderer is gone: ${details.reason}`);
      // A window without its controls is closed rather than reloaded; the user opens it again.
      if (win === w && details.reason !== 'clean-exit' && !deps.isQuitting()) w.close();
    });
    w.loadURL(SCRAPTF_BAR_URL).catch((err: unknown) => log.error('scrap.tf window: the toolbar failed to load', err));

    createView(w, partition);
    changed();
  }

  /** Forgets the window `w` (closed, turned off or quitting). Idempotent. */
  function teardown(w: BrowserWindow): void {
    if (win !== w) return;
    dropView();
    win = null;
    barLoaded = false;
    painted = false;
    wantShow = false;
    pending.clear();
    changed();
  }

  /** True when a page must be loaded: a new window, or a view rebuilt for a keepLoggedIn change. */
  function ensureWindow(): boolean {
    const partition = scraptfPartition(deps.settings().scraptfWindow.keepLoggedIn);
    if (live(win)) {
      if (view !== null && viewPartition === partition) return false;
      // A partition is fixed per view, so the next open after a keepLoggedIn change gets a new one.
      dropView();
      createView(win, partition);
      return true;
    }
    createWindow(partition);
    return true;
  }

  // ----- reads -----

  function memo(key: string): PageMemo {
    const t = now();
    for (const [k, m] of pages) {
      const newest = Math.max(m.autoAt ?? Number.NEGATIVE_INFINITY, m.readAt ?? Number.NEGATIVE_INFINITY);
      if (t - newest >= Math.max(READ_DEDUPE_MS, READ_AUTO_MIN_GAP_MS)) pages.delete(k);
    }
    const m = pages.get(key) ?? { autoAt: null, autoEmpty: false, hash: null, readAt: null, read: null };
    // Most recent last, so the oldest page goes first when the map is full.
    pages.delete(key);
    pages.set(key, m);
    while (pages.size > MAX_REMEMBERED_PAGES) {
      const oldest = pages.keys().next().value;
      if (oldest === undefined) break;
      pages.delete(oldest);
    }
    return m;
  }

  function clearSettle(): void {
    if (settleTimer !== null) timers.clearTimeout(settleTimer);
    settleTimer = null;
  }

  /**
   * Ends the automatic read cycle: no settle read follows, and the load snapshot it held is imported now.
   * That sends only HTML already read; it reads, loads and moves nothing.
   */
  function endCycle(): void {
    clearSettle();
    flushHeld();
  }

  /**
   * After each scrap.tf page load or in-page navigation in the view (did-finish-load, did-navigate-in-page):
   * the user's browsing, and also what the page's own scripts do (a reload, a replaceState), which the app
   * cannot tell apart. One read now and one settle read READ_SETTLE_MS later, because scrap.tf adds cards
   * after load; the two are one look at the page, imported once (readPage). Automatic reads of one page stay
   * READ_AUTO_MIN_GAP_MS apart (a reload, coming back to it); "Read page now" is how to force one. A new
   * document of a page whose last cycle imported nothing (the real page after a Cloudflare check the user
   * solved) is read within the gap. While the main frame is still loading the cycle starts at did-stop-loading.
   */
  function startAutoRead(newDocument: boolean): void {
    const wc = viewContents();
    if (wc === null || !deps.settings().scraptfWindow.readOnLoad) return;
    const url = documentUrl(wc);
    if (!shouldReadUrl(url)) return;
    if (!canRunNow(wc)) {
      waitingForStop = { newDocument: newDocument || waitingForStop?.newDocument === true };
      return;
    }
    const key = pageKey(url);
    const m = memo(key);
    const t = now();
    if (m.autoAt !== null && t - m.autoAt < READ_AUTO_MIN_GAP_MS && !(newDocument && m.autoEmpty)) return;
    // A cycle still open (an in-page step to another page) ends here: what its load read took is imported.
    endCycle();
    m.autoAt = t;
    m.autoEmpty = true;
    cycleKey = key;
    cycleAt = t;
    void readPage('load');
    settleTimer = timers.setTimeout(() => void readPage('settle'), READ_SETTLE_MS);
    pushNav();
  }

  function skipped(reason: string): ScraptfReadOutcome {
    return { read: null, reason };
  }

  function failedRead(url: string, warning: string): ScraptfWindowRead {
    return { at: now(), path: scraptfPathOf(url), items: 0, bank: null, newFlips: 0, warning };
  }

  function importWarning(r: ImportResult): string | null {
    if (r.batchId === 0 && count(r.parsed) === 0) {
      // Nothing recognised, so the service recorded nothing (batchId 0). On a bank or list page that means its
      // cards are not on screen yet (read again once they are); elsewhere, one plain sentence.
      return r.bank != null ? NO_CARDS_YET : SCRAPTF_NOTHING_TO_IMPORT;
    }
    const first = Array.isArray(r.warnings) ? shortWarning(r.warnings[0]) : null;
    if (first !== null) return first;
    return count(r.parsed) === 0 ? SCRAPTF_NOTHING_TO_IMPORT : null;
  }

  /**
   * Hands one snapshot to the saved-page import as a window read at `mtimeMs`, unless the page's last
   * imported read had the same HTML within READ_DEDUPE_MS: another save of it would only diff the page
   * against itself. It reads, loads and moves nothing.
   */
  async function importRead(snap: Snapshot, mtimeMs: UnixMs, trigger: ReadTrigger): Promise<ScraptfReadOutcome> {
    const prev = pages.get(snap.key);
    const t = now();
    if (prev !== undefined && prev.hash === snap.hash && prev.readAt !== null && t - prev.readAt < READ_DEDUPE_MS) {
      // Read page now on an unchanged page: the toolbar shows that page's last read again.
      if (trigger === 'manual' && prev.read !== null) {
        pushRead(prev.read);
        return { read: prev.read, reason: SCRAPTF_READ_REASONS.unchanged };
      }
      return skipped(SCRAPTF_READ_REASONS.unchanged);
    }
    let r: ImportResult;
    try {
      r = await deps.importHtml({ html: snap.html, fileName: windowReadFileName(snap.url), mtimeMs, address: snap.url, origin: 'window' });
    } catch {
      // The cause stays out of the log: it can quote the page.
      log.warn('scrap.tf window: a read could not be imported');
      const read = failedRead(snap.url, SCRAPTF_READ_REASONS.failed);
      if (viewContents() !== null) pushRead(read);
      return { read, reason: SCRAPTF_READ_REASONS.failed };
    }
    // Only an imported read counts for the dedupe, so a failed import is tried again.
    const m = memo(snap.key);
    m.hash = snap.hash;
    m.readAt = t;
    if (count(r.parsed) > 0) m.autoEmpty = false;
    const read: ScraptfWindowRead = {
      at: now(),
      path: scraptfPathOf(snap.url),
      items: count(r.parsed),
      bank: r.bank ?? null,
      newFlips: count(r.newFlips),
      warning: importWarning(r),
    };
    m.read = read;
    log.info(`scrap.tf window: read ${read.path} (${read.items} items, ${trigger})`);
    pushRead(read);
    return { read, reason: null };
  }

  /** The held load snapshot, imported at its cycle's start (not while quitting or with the window off). */
  function flushHeld(): void {
    const h = held;
    held = null;
    if (h === null || disposed || deps.isQuitting() || !deps.settings().scraptfWindow.enabled) return;
    importRead(h, h.at, 'load').catch(() => log.warn('scrap.tf window: a read could not be imported'));
  }

  /**
   * One read-only snapshot of the DOM the user's browsing loaded, handed to the saved-page import. It
   * starts no timer and moves nothing: the settle timer is set by startAutoRead. One look is one save: the
   * load read only holds its snapshot, and the settle read imports the newer of the two (the load one when
   * the settle read gets nothing) at the cycle's start, so a page whose cards arrived late is never saved
   * twice 4 s apart (the second save would diff against the first, not against the user's previous save).
   */
  async function readPage(trigger: ReadTrigger): Promise<ScraptfReadOutcome> {
    if (trigger === 'settle') settleTimer = null;
    const wc = viewContents();
    let locked = false;
    try {
      if (wc === null) return skipped(SCRAPTF_READ_REASONS.notOpen);
      // The page whose DOM the script will see (not a toolbar load still pending).
      const url = documentUrl(wc);
      if (!shouldReadUrl(url)) return skipped(SCRAPTF_READ_REASONS.notScraptf);
      const key = pageKey(url);
      if (trigger === 'manual') {
        if (now() - lastManualAt < READ_MANUAL_MIN_GAP_MS) return skipped(SCRAPTF_READ_REASONS.tooSoon);
      } else if (!deps.settings().scraptfWindow.readOnLoad) {
        // Turned off after the load: its settle read is dropped too.
        return skipped(READ_ON_LOAD_OFF);
      } else if (cycleKey !== key) {
        // The user moved on before this cycle's read; that page's own load starts its own.
        return skipped(SCRAPTF_READ_REASONS.tooSoon);
      }
      if (readingIn === wc) return skipped(SCRAPTF_READ_REASONS.busy);
      // A navigation of the main frame is pending: Electron would run the script on the next document
      // (Steam's sign-in, say) once it stops loading. Nothing may await between this check and the call.
      if (!canRunNow(wc)) return skipped(SCRAPTF_READ_REASONS.loading);
      if (trigger === 'manual') lastManualAt = now();
      readingIn = wc;
      locked = true;
      let value: unknown = null;
      let failed = false;
      try {
        value = await wc.executeJavaScriptInIsolatedWorld(READ_WORLD_ID, [{ code: READ_SCRIPT }]);
      } catch {
        log.warn('scrap.tf window: the page could not be read');
        failed = true;
      }
      // The window went, or the page changed under the read: the HTML may not be this URL's.
      if (viewContents() !== wc) return skipped(failed ? SCRAPTF_READ_REASONS.notOpen : SCRAPTF_READ_REASONS.failed);
      if (!failed && documentUrl(wc) !== url) return skipped(SCRAPTF_READ_REASONS.failed);
      const html = failed ? null : readResultHtml(value);
      const snap: Snapshot | null = html === null ? null : { key, url, html, hash: sha256(html) };
      if (trigger === 'load' && settleTimer !== null && cycleKey === key) {
        // Held for the settle read (nothing to show yet: the toolbar says Reading…).
        held = snap === null ? null : { ...snap, wc, at: cycleAt ?? now() };
        return { read: null, reason: null };
      }
      let use: Snapshot | null = snap;
      // An automatic read is imported at its cycle's start, whichever of its two snapshots it is.
      let mtimeMs = trigger === 'manual' ? now() : (cycleAt ?? now());
      if (trigger === 'settle') {
        const h = held !== null && held.wc === wc && held.key === key ? held : null;
        if (h !== null) held = null;
        use = snap ?? h;
        mtimeMs = h?.at ?? cycleAt ?? mtimeMs;
      } else if (trigger === 'manual' && snap !== null && cycleKey === key) {
        // Read page now during a cycle is the newest look at the page: the cycle ends with it.
        clearSettle();
        held = null;
      }
      if (use === null) {
        const reason = failed ? SCRAPTF_READ_REASONS.failed : SCRAPTF_READ_REASONS.empty;
        const read = failedRead(url, reason);
        pushRead(read);
        return { read, reason };
      }
      return await importRead(use, mtimeMs, trigger);
    } finally {
      if (locked && readingIn === wc) readingIn = null;
      // The cycle is over: a load snapshot its settle read did not import (skipped, or another page) goes now.
      if (trigger === 'settle') flushHeld();
      if (wc !== null && viewContents() === wc) pushNav();
    }
  }

  // ----- user actions (each one a click: dashboard, tray, toolbar) -----

  function userNavigate(nav: UserNav): void {
    if (disposed || deps.isQuitting() || !deps.settings().scraptfWindow.enabled) return;
    const wc = viewContents();
    if (wc === null) return;
    // Each move leaves the page on screen first (endCycle): no settle read may fire into the navigation, and
    // the cycle's load snapshot is imported.
    switch (nav.kind) {
      case 'start':
        if (!isAllowedWindowStart(nav.url)) throw new Error(SCRAPTF_START_REFUSAL);
        endCycle();
        // No options: no user agent, headers, referrer or body; Chromium sends its own defaults.
        wc.loadURL(nav.url).catch(() => log.debug('scrap.tf window: a load was cut short'));
        return;
      case 'back':
        if (!wc.navigationHistory.canGoBack()) return;
        endCycle();
        wc.navigationHistory.goBack();
        return;
      case 'forward':
        if (!wc.navigationHistory.canGoForward()) return;
        endCycle();
        wc.navigationHistory.goForward();
        return;
      case 'reload':
        endCycle();
        wc.reload();
        return;
    }
  }

  function open(start?: string): void {
    if (start !== undefined && !isAllowedWindowStart(start)) throw new Error(SCRAPTF_START_REFUSAL);
    if (disposed || deps.isQuitting()) return;
    if (!deps.settings().scraptfWindow.enabled) throw new Error(SCRAPTF_WINDOW_OFF);
    const fresh = ensureWindow();
    reveal();
    if (start !== undefined || fresh) userNavigate({ kind: 'start', url: start ?? SCRAPTF_HOME_URL });
  }

  function focus(): boolean {
    if (!live(win)) return false;
    reveal();
    return true;
  }

  function close(): void {
    const w = win;
    if (w === null) return;
    teardown(w);
    if (!w.isDestroyed()) w.destroy();
  }

  function back(): void {
    userNavigate({ kind: 'back' });
  }

  function forward(): void {
    userNavigate({ kind: 'forward' });
  }

  function reload(): void {
    userNavigate({ kind: 'reload' });
  }

  function home(): void {
    if (viewContents() === null) open();
    else userNavigate({ kind: 'start', url: SCRAPTF_HOME_URL });
  }

  function go(url: string): void {
    if (!isAllowedWindowStart(url)) throw new Error(SCRAPTF_START_REFUSAL);
    if (viewContents() === null) open(url);
    else userNavigate({ kind: 'start', url });
  }

  async function clear(): Promise<void> {
    // Both partitions: logging out must also drop a login kept on disk before keepLoggedIn was turned off.
    for (const partition of [SCRAPTF_MEMORY_PARTITION, SCRAPTF_PERSIST_PARTITION]) {
      const ses = scraptfSession(partition);
      await ses.clearStorageData();
      await ses.clearCache();
    }
    pages.clear();
    // A cycle of the session just cleared is dropped, not imported after the clear.
    clearSettle();
    held = null;
    // The last read belonged to that session too. The toolbar is told (Settings may have asked, not it), and a
    // toolbar that loads again starts blank.
    lastRead = null;
    deliver('scraptfWindow.read', null);
    changed();
    log.info('scrap.tf window: logged out and cleared');
    if (viewContents() !== null) userNavigate({ kind: 'start', url: SCRAPTF_HOME_URL });
  }

  function state(): ScraptfWindowState {
    const nav = navState();
    return { open: viewContents() !== null, url: nav.url, canGoBack: nav.canGoBack, canGoForward: nav.canGoForward, lastRead };
  }

  return {
    open,
    focus,
    close,
    back,
    forward,
    reload,
    home,
    go,
    readNow: () => readPage('manual'),
    clear,
    state,
    send(event, payload) {
      if (FORWARDED_PUSHES.has(event)) deliver(event, payload);
    },
    ownsContents(contents) {
      return view !== null && contents === view.webContents;
    },
    dispose() {
      // First, so closing imports no held snapshot while the service shuts down.
      disposed = true;
      close();
      clearSettle();
      held = null;
      lastRead = null;
      pages.clear();
      changed();
    },
  };
}
