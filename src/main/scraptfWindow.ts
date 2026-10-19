// F21: the opt-in scrap.tf window, the only place in Flip Desk that shows scrap.tf. The user browses it
// themselves (docs/DESIGN_BRIEF.md §3.5 option D, chosen by the user on 2026-10-19 after being told the
// ToS and ban risk). One BrowserWindow: an app:// toolbar (window kind 'scraptf', SCRAPTF_BAR_URL, normal
// preload and hardening) above a WebContentsView for scrap.tf with NO preload, sandboxed, on its own
// partition.
//
// Hard limits (test/compliance/static.test.ts, the F21 block, checks this file):
// - the view loads a page only through userNavigate(), called only from the user-action functions below
//   (open, back, forward, reload, home, go, clear, and pressKey for the user's own keys and mouse buttons),
//   never from a timer, an event handler or a promise callback; the only exceptions are the two input
//   listeners (before-input-event, app-command), which Chromium and Windows raise for the user's real
//   input only; the only URLs it loads are isAllowedWindowStart pages (or history steps);
// - the one timer is the single READ_SETTLE_MS settle read, `timers.setTimeout(() => void readPage('settle'), READ_SETTLE_MS)`;
// - the only code run in the view is READ_SCRIPT in isolated world READ_WORLD_ID, on scrap.tf pages the
//   import can read only (scraptfImportablePath), never automatically on a challenge, error or rate-limit
//   page, and only on a document that has stopped loading (canRunNow): Electron would otherwise hold the
//   script back and run it on whatever document comes next, such as Steam's sign-in;
// - no setUserAgent, no cookies API, no header rewriting, no input events sent, no DOM writes, no trading;
// - a page reaches the user's browser only right after the user's own input to the view (USER_ACTIVATION_MS);
// - nothing about a page is logged but its origin and path (no query, no content, no cookie), and lines a
//   page can trigger at its own rate go through a PageLog.

import { createHash } from 'node:crypto';
import { BrowserWindow, session, WebContentsView, type Session, type WebContents, type WebPreferences } from 'electron';
import type { Logger } from '../service/contracts';
import { IMPORT_SCHEMA_LOADING_CODE, LAYOUT_CHANGED, NO_PRICE_COLUMN, NO_STOCK_LIMIT, PARTIAL_READ } from '../shared/importCodes';
import { SCRAPTF_HOME_URL } from '../shared/links';
import type { PushContract, PushEvent } from '../shared/rpc';
import { scraptfImportablePath } from '../shared/scraptfPaths';
import {
  appCommandAction,
  EXTERNAL_OPEN_MIN_GAP_MS,
  isAllowedWindowStart,
  loadFailureNotice,
  READ_AUTO_MIN_GAP_MS,
  READ_DEDUPE_MS,
  READ_MANUAL_MIN_GAP_MS,
  READ_SCRIPT,
  READ_SETTLE_MS,
  READ_WORLD_ID,
  readResultHtml,
  responseNotice,
  SCRAPTF_FAILURE_NOTICES,
  SCRAPTF_LINK_NOTICES,
  SCRAPTF_NOT_READ_AGAIN,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_NOTICES,
  SCRAPTF_WINDOW_OFF,
  scraptfPathOf,
  shouldReadUrl,
  subframeNavigationDecision,
  topLevelNavigationDecision,
  USER_ACTIVATION_MS,
  windowDisplayUrl,
  windowKeyAction,
  windowReadFileName,
  type WindowKeyAction,
} from '../shared/scraptfWindowPolicy';
import type { ImportResult, ScraptfReadOutcome, ScraptfWindowNav, ScraptfWindowRead, ScraptfWindowState, Settings, UnixMs } from '../shared/types';
import { createPageLog } from './pageLog';
import { SCRAPTF_BAR_URL } from './paths';
import { createWindowBounds, type BoundsScreen } from './windowBounds';
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
export const SCRAPTF_NOTHING_TO_IMPORT = SCRAPTF_READ_REASONS.notImportable;
/** The file in userData that remembers the window's size and place (F21-12). */
export const SCRAPTF_WINDOW_BOUNDS_FILE = 'scraptf-window-bounds.json';
/** The window's default size and its minimum (the remembered size is restored over it, F21-12). */
export const SCRAPTF_WINDOW_SIZE = Object.freeze({ width: 1280, height: 900, minWidth: 640, minHeight: 480 });

const MAX_WARNING_CHARS = 160;
const MAX_FLIP_NAME_CHARS = 120;
/** The SKU shape 'app.openItem' takes (ipc.ts openItemParams): a best flip's name opens its item. */
const SKU_SHAPE = /^\d+;\d+(;[a-z0-9-]+)*$/i;
/**
 * The import's warning codes the toolbar shows, most important first (F21-10): a partial look, a page whose
 * layout changed, unreadable stock, unknown items, a missing price column, an unknown bank, a missing pays
 * column. Any other code follows them, but duplicate copies and a guessed page kind are no news on screen.
 */
const WARNING_ORDER: readonly string[] = [PARTIAL_READ, LAYOUT_CHANGED, NO_STOCK_LIMIT, 'no-sku', NO_PRICE_COLUMN, 'unknown-bank', 'no-pays-column'];
const QUIET_WARNINGS: ReadonlySet<string> = new Set(['duplicate-cards', 'page-kind-guessed']);
/**
 * Codes whose counts the toolbar shows, and how many of them lead the service's own text ("3 of ~48 items",
 * "5 rows"): digits only, never the page text around them.
 */
const COUNTED_WARNINGS: ReadonlyMap<string, number> = new Map([
  [PARTIAL_READ, 2],
  ['no-sku', 2],
  [NO_STOCK_LIMIT, 1],
]);
/** The least time between two different link notices (a page alternating a blocked link and a popup). */
const LINK_NOTICE_MIN_GAP_MS = 1_000;
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
  /**
   * 0.7.1 (ACT-4): false for a load snapshot imported without its settle read (the cycle was cut short, or the
   * settle read got nothing): the service stores its prices but no bank stock save. Absent: a settled look.
   */
  settled?: false;
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
  /**
   * 0.7.1 (F21-12): where the window's size and place are remembered (a JSON file in userData) and Electron's
   * screen, to restore them only onto a display that is there. Absent (tests): the default size, centred.
   */
  bounds?: { file: string; screen: BoundsScreen; readFile?(file: string): string; writeFile?(file: string, text: string): void };
  now?: () => UnixMs;
  timers?: ScraptfWindowTimers;
}

/** A move of the view the user asked for; userNavigate() is the only code that loads or steps the view. */
export type UserNav = { kind: 'start'; url: string } | { kind: 'back' } | { kind: 'forward' } | { kind: 'reload' };

export interface ScraptfWindowManager {
  /**
   * Creates the window or brings it to the front. `start` (isAllowedWindowStart, else it throws) is
   * loaded when given, unless it is the page already on screen (that only brings the window up); a new
   * window without one loads Home. Throws SCRAPTF_WINDOW_OFF while the window is turned off (main checks
   * too). A keepLoggedIn change applies to the next window only: an open one keeps its session.
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
  /** The document's challenge or error notice when read (Read page now on one, F21-3); null for a real page. */
  notice: string | null;
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

/** `code` with the first `n` counts its warning text names ('partial-read: 3 48'): digits only. */
function withCounts(code: string, warning: string, n: number): string {
  const at = warning.indexOf(':');
  const digits = (at < 0 ? [] : (warning.slice(at + 1).match(/\d{1,9}/g) ?? [])).slice(0, n);
  return digits.length > 0 ? `${code}: ${digits.join(' ')}` : code;
}

/**
 * 0.7.1 (UX-3, ACT-5, F21-2): what the toolbar shows of an import's prices and flips: how many prices it
 * stored, the flips on sale on the page, and the best of them (its SKU, so a click opens the item; its name
 * from the app's own item data, cleaned and cut). Absent from an older service: left out.
 */
function readFlipsOf(r: ImportResult): Pick<ScraptfWindowRead, 'stored' | 'pageFlips' | 'bestFlip'> {
  const out: Pick<ScraptfWindowRead, 'stored' | 'pageFlips' | 'bestFlip'> = { stored: count(r.stored) };
  if (typeof r.pageFlips !== 'number') return out;
  out.pageFlips = count(r.pageFlips);
  const top = Array.isArray(r.topFlips) ? r.topFlips[0] : undefined;
  const name = typeof top?.name === 'string' ? top.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_FLIP_NAME_CHARS) : '';
  const ok = top !== undefined && typeof top.sku === 'string' && top.sku.length <= 200 && SKU_SHAPE.test(top.sku) && name !== '' && Number.isFinite(top.profitScrap);
  out.bestFlip = ok ? { sku: top.sku, name, profitScrap: Math.round(top.profitScrap) } : null;
  return out;
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

/** True while the view's main frame is loading another document (a load of the page shown is still under way). */
function mainFrameLoading(wc: WebContents): boolean {
  try {
    return wc.isLoadingMainFrame();
  } catch {
    return true;
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
  // One fixed-text notice about the page on screen (nav.notice), cleared when the next document commits. A
  // page notice (a challenge, error or rate-limit status at did-navigate, a failed load, a crash) also keeps
  // that document from being read automatically (F21-3): see pageNotice().
  let notice: string | null = null;
  // When a link notice last took the line (linkNotice's throttle).
  let linkNoticeAt = Number.NEGATIVE_INFINITY;
  // The remembered window was maximised: it is maximised again when first shown (F21-12).
  let maximizeOnShow = false;
  const bounds = deps.bounds ? createWindowBounds({ ...deps.bounds, log }) : null;

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
        // The document a read would see (F21-4): Read page now is offered only where the import reads.
        importable: scraptfImportablePath(documentUrl(wc)),
        notice,
      };
    } catch {
      return CLOSED_NAV;
    }
  }

  function pushNav(): void {
    deliver('scraptfWindow.nav', navState());
  }

  /** A notice about the page on screen; pushed only when it changes, so a page cannot flood the toolbar. */
  function setNotice(next: string | null): void {
    if (notice === next) return;
    notice = next;
    pushNav();
  }

  /**
   * The notice about the document on screen, not about a link: a challenge, error or rate-limit page (its HTTP
   * status), Chromium's error page after a failed load, or a crash. Such a document is not read automatically
   * (F21-3; an error page imports nothing either), and a read the user asks for of it is worded by it.
   */
  function pageNotice(): string | null {
    return notice !== null && !SCRAPTF_LINK_NOTICES.has(notice) ? notice : null;
  }

  /**
   * A notice about one link (kept from opening, a popup, no click): never over a notice about the page. A page
   * script can raise these at its own rate, alternating kinds too, so one link notice replaces another at most
   * every LINK_NOTICE_MIN_GAP_MS: the toolbar is told at most about once a second.
   */
  function linkNotice(next: string): void {
    if (pageNotice() !== null || notice === next) return;
    const t = now();
    if (notice !== null && t - linkNoticeAt < LINK_NOTICE_MIN_GAP_MS) return;
    linkNoticeAt = t;
    setNotice(next);
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
    if (maximizeOnShow) {
      // Maximised as it was left, once its first paint is ready (maximize() shows a hidden window).
      maximizeOnShow = false;
      w.maximize();
    }
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  /** Remembers the window's size and place for the next open (F21-12); before it closes, while it still has them. */
  function rememberBounds(w: BrowserWindow): void {
    if (bounds === null || win !== w) return;
    bounds.remember(w);
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
      linkNotice(SCRAPTF_WINDOW_NOTICES.needsClick);
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
    else {
      pageLog.line('info', 'blocked page', 'scrap.tf window: blocked a page outside scrap.tf and Steam sign-in', { url: windowDisplayUrl(url) });
      linkNotice(SCRAPTF_WINDOW_NOTICES.blocked);
    }
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
      else {
        pageLog.line('info', 'dropped popup', 'scrap.tf window: dropped a popup', { url: windowDisplayUrl(url) });
        if (isCurrent(wc)) linkNotice(SCRAPTF_WINDOW_NOTICES.popup);
      }
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event) => applyTopLevel(event, event.url));
    wc.on('will-frame-navigate', (event) => (event.isMainFrame ? applyTopLevel(event, event.url) : applySubframe(event, event.url)));
    wc.on('will-redirect', (event) => (event.isMainFrame ? applyTopLevel(event, event.url) : applySubframe(event, event.url)));
    // Only noted, never sent: the user's own input is what lets a link leave for the browser (openOutside).
    wc.on('input-event', (_event, input) => {
      if (isCurrent(wc) && ACTIVATING_INPUTS.has(input.type)) activationAt = now();
    });
    // F21-11: the toolbar's keys while the page has the focus. Chromium raises this for the user's real key
    // presses only (a page's script cannot), so it is the same user action as the toolbar's key or button.
    wc.on('before-input-event', (event, input) => {
      const action = isCurrent(wc) ? windowKeyAction(input) : null;
      if (action === null) return;
      event.preventDefault();
      pressKey(action);
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
    wc.on('did-navigate', (_event, _url, httpResponseCode) => {
      if (!isCurrent(wc)) return;
      docLoaded = false;
      waitingForStop = null;
      endCycle();
      pageLog.flush();
      // A new document: the last one's notice goes; a scrap.tf challenge, error or rate-limit page brings its
      // own (Steam's sign-in is never read, and its error statuses are no Cloudflare check).
      notice = shouldReadUrl(documentUrl(wc)) ? responseNotice(httpResponseCode) : null;
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
    // No automatic retry, ever: the user clicks Reload (the notice says so).
    wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      log.warn(`scrap.tf window: a page did not load (${code})`);
      // Chromium's error page replaced the document (did-navigate does not fire for it): nothing to settle,
      // and its own did-finish-load reads nothing (the notice is a page notice until the next commit).
      if (isCurrent(wc)) {
        docLoaded = false;
        waitingForStop = null;
        endCycle();
        setNotice(loadFailureNotice(code));
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
      notice = SCRAPTF_WINDOW_NOTICES.crashed;
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
    notice = null;
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
    // Where the user left it, when a display still shows that place (F21-12); the default size otherwise.
    const place = bounds?.place(SCRAPTF_WINDOW_SIZE) ?? { bounds: { width: SCRAPTF_WINDOW_SIZE.width, height: SCRAPTF_WINDOW_SIZE.height }, maximized: false };
    const w = new BrowserWindow({
      ...place.bounds,
      minWidth: SCRAPTF_WINDOW_SIZE.minWidth,
      minHeight: SCRAPTF_WINDOW_SIZE.minHeight,
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
    maximizeOnShow = place.maximized;
    pending.clear();

    // The title stays the window's own, whatever the toolbar page calls itself.
    w.on('page-title-updated', (event) => event.preventDefault());
    w.once('ready-to-show', () => {
      if (win !== w) return;
      painted = true;
      if (wantShow) reveal();
    });
    // The user closing it (or main's close()): its size and place, while it still has them.
    w.on('close', () => rememberBounds(w));
    w.on('closed', () => teardown(w));
    // F21-11: Windows' browser keys and the mouse's back and forward buttons, the user's own input only.
    w.on('app-command', (_event, command) => {
      const action = win === w ? appCommandAction(command) : null;
      if (action !== null) pressKey(action);
    });
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

  /**
   * True when a page must be loaded: a new window. The partition is chosen here only (F21-6): a keepLoggedIn
   * change while the window is open applies when it is closed and opened again, so the view the user is
   * signed in on is never rebuilt behind their back (state().pendingPartitionChange says it is waiting).
   */
  function ensureWindow(): boolean {
    if (live(win)) return false;
    createWindow(scraptfPartition(deps.settings().scraptfWindow.keepLoggedIn));
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
    // Only a page the import can read (F21-4: not the front page, raffles or settings), and never a
    // challenge, error or rate-limit page, nor Chromium's error page after a failed load (F21-3, F21-10);
    // the page keeps its gap and autoEmpty for the real page.
    if (!shouldReadUrl(url) || !scraptfImportablePath(url) || pageNotice() !== null) return;
    if (!canRunNow(wc)) {
      waitingForStop = { newDocument: newDocument || waitingForStop?.newDocument === true };
      return;
    }
    const key = pageKey(url);
    const m = memo(key);
    const t = now();
    if (m.autoAt !== null && t - m.autoAt < READ_AUTO_MIN_GAP_MS && !(newDocument && m.autoEmpty)) {
      // Not read again so soon, but the toolbar shows this page's last read rather than another page's.
      showMemoRead(m);
      return;
    }
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

  /**
   * The one warning the toolbar shows for an import (F21-10): by priority (WARNING_ORDER), then any other code
   * but the quiet ones; only the code, plus its counts as digits for the counted codes. `pageNotice` is the
   * read document's challenge or error notice, which words a read of such a page that found nothing (F21-3).
   */
  function importWarning(r: ImportResult, pageNotice: string | null): string | null {
    const warnings = Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [];
    const find = (code: string) => warnings.find((w) => shortWarning(w) === code);
    if (r.batchId === 0 && count(r.parsed) === 0) {
      // Nothing recognised, so the service recorded nothing (batchId 0). Item-like elements in no shape the
      // parser knows: scrap.tf changed the page (not "wait for the cards"). A challenge or error page: its
      // notice. On a bank or list page otherwise its cards are not on screen yet (read again once they are);
      // elsewhere, one plain sentence.
      if (find(LAYOUT_CHANGED) !== undefined) return LAYOUT_CHANGED;
      if (pageNotice !== null) return pageNotice;
      return r.bank != null ? NO_CARDS_YET : SCRAPTF_NOTHING_TO_IMPORT;
    }
    for (const code of WARNING_ORDER) {
      const w = find(code);
      if (w !== undefined) return withCounts(code, w, COUNTED_WARNINGS.get(code) ?? 0);
    }
    for (const w of warnings) {
      const code = shortWarning(w);
      if (code !== null && !QUIET_WARNINGS.has(code)) return code;
    }
    return count(r.parsed) === 0 ? (pageNotice ?? SCRAPTF_NOTHING_TO_IMPORT) : null;
  }

  /**
   * A page shown again without a new read (within the gap, or unchanged within the dedupe): the toolbar shows
   * that page's own last read, marked SCRAPTF_NOT_READ_AGAIN unless it has a warning of its own, instead of the
   * last page's (F21-10). Nothing is pushed when it already shows it.
   */
  function showMemoRead(m: PageMemo | undefined): void {
    const read = m?.read ?? null;
    if (read === null || (lastRead !== null && lastRead.path === read.path && lastRead.at === read.at)) return;
    pushRead(read.warning === null ? { ...read, warning: SCRAPTF_NOT_READ_AGAIN } : read);
  }

  /**
   * Hands one snapshot to the saved-page import as a window read at `mtimeMs`, unless the page's last
   * imported read had the same HTML within READ_DEDUPE_MS: another save of it would only diff the page
   * against itself. `settled` false marks a load snapshot imported without its settle read (ACT-4): the
   * service stores its prices but no bank stock save. It reads, loads and moves nothing.
   */
  async function importRead(snap: Snapshot, mtimeMs: UnixMs, trigger: ReadTrigger, settled = true): Promise<ScraptfReadOutcome> {
    const prev = pages.get(snap.key);
    const t = now();
    // UX-071-1: no automatic read runs on a document with a page notice (startAutoRead), so one that ends
    // while a notice is up is an earlier document's (another page, or this address before it reloaded into a
    // 429 or a check): it is remembered, but never takes the toolbar's line from that notice. Read page now does.
    const mayShow = (): boolean => trigger === 'manual' || pageNotice() === null;
    if (prev !== undefined && prev.hash === snap.hash && prev.readAt !== null && t - prev.readAt < READ_DEDUPE_MS) {
      // Read page now on an unchanged page: the toolbar shows that page's last read again.
      if (trigger === 'manual' && prev.read !== null) {
        pushRead(prev.read);
        return { read: prev.read, reason: SCRAPTF_READ_REASONS.unchanged };
      }
      // Its last read is shown only while the page is on screen: not for a held snapshot imported after the
      // user moved on (endCycle at the next page's commit), whose read would sit over the new page's.
      const wc = viewContents();
      if (wc !== null && pageKey(documentUrl(wc)) === snap.key && mayShow()) showMemoRead(prev);
      return skipped(SCRAPTF_READ_REASONS.unchanged);
    }
    let r: ImportResult;
    try {
      r = await deps.importHtml({
        html: snap.html,
        fileName: windowReadFileName(snap.url),
        mtimeMs,
        address: snap.url,
        origin: 'window',
        ...(settled ? {} : { settled: false as const }),
      });
    } catch (err) {
      // The cause stays out of the log: it can quote the page. Only the import's fixed code is matched: the
      // item data still loading (F21-1) is said so, and nothing is remembered, so the next read imports.
      const loading = err instanceof Error && typeof err.message === 'string' && err.message.includes(IMPORT_SCHEMA_LOADING_CODE);
      log.warn(loading ? 'scrap.tf window: item data is still loading, so a read was not imported' : 'scrap.tf window: a read could not be imported');
      const reason = loading ? SCRAPTF_READ_REASONS.schemaLoading : SCRAPTF_READ_REASONS.failed;
      const read = failedRead(snap.url, reason);
      if (viewContents() !== null && mayShow()) pushRead(read);
      return { read, reason };
    }
    const m = memo(snap.key);
    // Only an imported, settled read counts for the dedupe: a failed import is tried again, and so is the same
    // HTML read settled after an unsettled import of it (which wrote no bank stock save).
    if (settled) {
      m.hash = snap.hash;
      m.readAt = t;
    }
    if (count(r.parsed) > 0) m.autoEmpty = false;
    const read: ScraptfWindowRead = {
      at: now(),
      path: scraptfPathOf(snap.url),
      items: count(r.parsed),
      bank: r.bank ?? null,
      newFlips: count(r.newFlips),
      warning: importWarning(r, snap.notice),
      ...readFlipsOf(r),
    };
    m.read = read;
    log.info(`scrap.tf window: read ${read.path} (${read.items} items, ${trigger}${settled ? '' : ', unsettled'})`);
    if (mayShow()) pushRead(read);
    return { read, reason: null };
  }

  /**
   * The held load snapshot, imported at its cycle's start (not while quitting or with the window off). Its
   * settle read never ran, so it is an unsettled look: prices, no bank stock save (ACT-4).
   */
  function flushHeld(): void {
    const h = held;
    held = null;
    if (h === null || disposed || deps.isQuitting() || !deps.settings().scraptfWindow.enabled) return;
    importRead(h, h.at, 'load', false).catch(() => log.warn('scrap.tf window: a read could not be imported'));
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
      // F21-4: a scrap.tf page the import cannot read is not read at all (fewer reads, the same imports).
      if (!scraptfImportablePath(url)) return skipped(SCRAPTF_READ_REASONS.notImportable);
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
      // Read page now on a challenge or error page reads it; what it finds is worded by the notice (F21-3).
      const noticeNow = pageNotice();
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
      const snap: Snapshot | null = html === null ? null : { key, url, html, hash: sha256(html), notice: noticeNow };
      if (trigger === 'load' && settleTimer !== null && cycleKey === key) {
        // Held for the settle read (nothing to show yet: the toolbar says Reading…).
        held = snap === null ? null : { ...snap, wc, at: cycleAt ?? now() };
        return { read: null, reason: null };
      }
      let use: Snapshot | null = snap;
      // The settle read's own snapshot, or Read page now: a settled look. A load read that gets here was not
      // held: its cycle ended (a toolbar move, a failed load) or its settle read fired while the script still
      // ran, so it is the load snapshot imported without its settle read (ACT-4), like flushHeld's.
      let settled = trigger !== 'load';
      // An automatic read is imported at its cycle's start, whichever of its two snapshots it is.
      let mtimeMs = trigger === 'manual' ? now() : (cycleAt ?? now());
      if (trigger === 'settle') {
        const h = held !== null && held.wc === wc && held.key === key ? held : null;
        if (h !== null) held = null;
        use = snap ?? h;
        // The settle read got nothing: the load snapshot is the look, cut before it settled (ACT-4).
        settled = snap !== null;
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
      return await importRead(use, mtimeMs, trigger, settled);
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

  /**
   * The view already shows `url` (the same page, its hash aside) and is not loading another one. A page that
   * did not load or crashed is not shown: the user's link to it loads it again, as before F21-7.
   */
  function showing(url: string): boolean {
    const wc = viewContents();
    return wc !== null && pageKey(documentUrl(wc)) === pageKey(url) && !mainFrameLoading(wc) && !(notice !== null && SCRAPTF_FAILURE_NOTICES.has(notice));
  }

  function open(start?: string): void {
    if (start !== undefined && !isAllowedWindowStart(start)) throw new Error(SCRAPTF_START_REFUSAL);
    if (disposed || deps.isQuitting()) return;
    if (!deps.settings().scraptfWindow.enabled) throw new Error(SCRAPTF_WINDOW_OFF);
    const fresh = ensureWindow();
    reveal();
    // A dashboard link to the page already on screen only brings the window up (F21-7): no second load.
    if (fresh || (start !== undefined && !showing(start))) userNavigate({ kind: 'start', url: start ?? SCRAPTF_HOME_URL });
  }

  function focus(): boolean {
    if (!live(win)) return false;
    reveal();
    return true;
  }

  function close(): void {
    const w = win;
    if (w === null) return;
    // destroy() skips the 'close' event, so the size and place are remembered here.
    rememberBounds(w);
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

  /**
   * F21-11: the user's key press in the page (before-input-event) or the mouse's back and forward buttons
   * (app-command): the toolbar's Back, Forward, Reload and Home, nothing else. Only those two listeners call it.
   */
  function pressKey(action: WindowKeyAction): void {
    if (action === 'back') back();
    else if (action === 'forward') forward();
    else if (action === 'reload') reload();
    else home();
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
    const isOpen = viewContents() !== null;
    // F21-6: "Stay signed in" changed since this window was made; it applies when the window is reopened.
    const pending = isOpen && viewPartition !== null && viewPartition !== scraptfPartition(deps.settings().scraptfWindow.keepLoggedIn);
    return { open: isOpen, url: nav.url, canGoBack: nav.canGoBack, canGoForward: nav.canGoForward, lastRead, ...(pending ? { pendingPartitionChange: true } : {}) };
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
