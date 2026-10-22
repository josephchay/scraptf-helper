// F21: the rules of the opt-in scrap.tf window, pure and zod-free so main, the settings schema, the
// browser mock and the tests share them. The window is a page the USER browses: Flip Desk never loads
// scrap.tf on its own (no HTTP client, /ajax, socket, polling or timer-driven navigation), never reads
// or reuses cookies, never sets the user agent, never solves a challenge and never clicks, types,
// scrolls or writes in the page. The one thing it does is read the DOM the user's browsing already
// loaded (READ_SCRIPT), only on scrap.tf, and hand it to the saved-page import (R10).

import { isAllowedExternalUrl, SCRAPTF_BANKS, SCRAPTF_HOME_URL, SCRAPTF_ITEMS_URL } from './links';
import type { Settings } from './types';

/** The toolbar page's route (main's SCRAPTF_BAR_URL ends with it; the mock's '#/scraptf-bar' demo). */
export const SCRAPTF_BAR_HASH = '#/scraptf-bar';

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/** The only host the window reads, and the only one its top-level navigation stays on (with Steam's login). */
const SCRAPTF_HOST = 'scrap.tf';
/** Cloudflare's challenge frame, so the user can solve a check themselves (the app never does). */
const CHALLENGE_HOST = 'challenges.cloudflare.com';
/** Steam's OpenID sign-in, which scrap.tf's "Sign in through Steam" sends the user to. */
const STEAM_HOST = 'steamcommunity.com';
const MAX_URL_LENGTH = 4096;

/**
 * `url` as an https URL with no userinfo and the default port, or null. The raw string is checked too
 * (control characters, spaces, backslashes), as isAllowedExternalUrl does, so nothing that parses one
 * way here and another way in Chromium gets through.
 */
function httpsUrl(url: unknown): URL | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return null;
  if (/[\u0000- \u007f-\u009f\\]/.test(url)) return null;
  if (!/^https:\/\//i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  return u;
}

/** True for an https page on exactly scrap.tf (no subdomain, no port, no userinfo). Also the 'import.html' address rule. */
export function isScraptfPageUrl(url: unknown): url is string {
  return httpsUrl(url)?.hostname === SCRAPTF_HOST;
}

/** Steam's sign-in pages: steamcommunity.com /openid/… and /login/…, nothing else on that host. */
function isSteamLogin(u: URL): boolean {
  if (u.hostname !== STEAM_HOST) return false;
  const p = u.pathname;
  return p === '/openid' || p.startsWith('/openid/') || p === '/login' || p.startsWith('/login/');
}

// ---------------------------------------------------------------------------
// Start pages (what the app itself may ask the window to load, on a user's click only)
// ---------------------------------------------------------------------------

/**
 * Every page the window opens on the user's request (open, Home, the bank chips, links.open with
 * openLinksInWindow): scrap.tf's front page, the SCRAPTF_BANKS pages and scrap.tf/items. Static: never
 * built from item data, a query or a page's own links.
 */
export const SCRAPTF_WINDOW_START_URLS: readonly string[] = Object.freeze([...new Set([SCRAPTF_HOME_URL, ...SCRAPTF_BANKS.map((b) => b.url), SCRAPTF_ITEMS_URL])]);

const START_SET: ReadonlySet<string> = new Set(SCRAPTF_WINDOW_START_URLS);

/** The static start pages, in toolbar order (home first). */
export function scraptfWindowStartUrls(): readonly string[] {
  return SCRAPTF_WINDOW_START_URLS;
}

/** True only for an exact SCRAPTF_WINDOW_START_URLS entry: no other path, query, hash, case or trailing slash. */
export function isAllowedWindowStart(url: unknown): url is string {
  return typeof url === 'string' && START_SET.has(url);
}

// ---------------------------------------------------------------------------
// Navigation inside the window (the user's own clicks in the page)
// ---------------------------------------------------------------------------

/** 'allow': the view goes there; 'external': prevented, opened in the default browser; 'block': prevented and dropped. */
export type TopLevelDecision = 'allow' | 'external' | 'block';
export type SubframeDecision = 'allow' | 'block';

/**
 * A main-frame navigation (will-navigate, will-redirect, will-frame-navigate with isMainFrame, a popup):
 * scrap.tf pages and Steam's sign-in stay in the window; any other page the links allowlist accepts
 * goes to the default browser; everything else is dropped (http, other hosts, file:, javascript:, data:).
 */
export function topLevelNavigationDecision(url: unknown): TopLevelDecision {
  const u = httpsUrl(url);
  if (u !== null && (u.hostname === SCRAPTF_HOST || isSteamLogin(u))) return 'allow';
  if (typeof url === 'string' && isAllowedExternalUrl(url)) return 'external';
  return 'block';
}

/**
 * A subframe navigation (will-frame-navigate without isMainFrame, and its redirects): scrap.tf,
 * Cloudflare's challenge frame (the user solves it) and Steam's sign-in. about:blank and about:srcdoc
 * load nothing from the network and pages build them for their own scripts, so they are allowed too.
 */
export function subframeNavigationDecision(url: unknown): SubframeDecision {
  if (url === 'about:blank' || url === 'about:srcdoc') return 'allow';
  const u = httpsUrl(url);
  if (u === null) return 'block';
  return u.hostname === SCRAPTF_HOST || u.hostname === CHALLENGE_HOST || isSteamLogin(u) ? 'allow' : 'block';
}

/** Whether a loaded page may be read: exactly scrap.tf over https (never Steam's sign-in or a challenge host). */
export function shouldReadUrl(url: unknown): url is string {
  return isScraptfPageUrl(url);
}

/**
 * The address the toolbar shows and the pushes carry: origin and path only, so a query (Steam's OpenID
 * return_to, a search) or a hash never leaves main. null for anything that is not https.
 */
export function windowDisplayUrl(url: unknown): string | null {
  const u = httpsUrl(url);
  return u === null ? null : `${u.origin}${u.pathname}`.slice(0, 500);
}

/** The path a read reports ('/buy/hats'); '/' when the URL is not a scrap.tf page. */
export function scraptfPathOf(url: unknown): string {
  const u = httpsUrl(url);
  return u !== null && u.hostname === SCRAPTF_HOST ? u.pathname.slice(0, 300) : '/';
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/** The isolated world the read runs in: not the page's world (0) and not Electron's preload world (999). */
export const READ_WORLD_ID = 1001;
/** The one settle read after a load, because scrap.tf adds bank cards after the page has loaded. */
export const READ_SETTLE_MS = 4_000;
/** "Read page now" at most this often. */
export const READ_MANUAL_MIN_GAP_MS = 2_000;
/** Automatic reads of the same page at least this far apart. */
export const READ_AUTO_MIN_GAP_MS = 30_000;
/** A read whose HTML hash equals the previous read of the same URL within this is skipped. */
export const READ_DEDUPE_MS = 60_000;
/** The import's 20 MB cap (MAX_IMPORT_BYTES in main/paths.ts, pinned equal by a test), in characters as zod counts. */
export const READ_MAX_CHARS = 20 * 1024 * 1024;
/**
 * Two opens of the user's browser at least this far apart: the dedupe for the twin will-frame-navigate and
 * will-navigate events of one click. It is no limit on its own; USER_ACTIVATION_MS is.
 */
export const EXTERNAL_OPEN_MIN_GAP_MS = 1_000;
/**
 * A page may send the user to their browser ('external') only this soon after a real click, key press or tap
 * in the view, and each such input opens at most one tab: a page's script cannot open a stream of tabs on its
 * own. Chromium's own transient-activation lifetime, so a server redirect after a click still opens.
 */
export const USER_ACTIVATION_MS = 5_000;

/** Why a read was not taken (ScraptfReadOutcome.reason, ScraptfWindowRead.warning). Fixed text: never a URL or page content. */
export const SCRAPTF_READ_REASONS = Object.freeze({
  notOpen: 'The scrap.tf window is not open.',
  notScraptf: 'Only scrap.tf pages are read (not Steam sign-in or a challenge page).',
  tooSoon: 'Read a moment ago. Try again in a second or two.',
  unchanged: 'The page has not changed since the last read.',
  empty: 'The page gave nothing to read (still loading, or over the 20 MB import limit).',
  busy: 'A read of this page is still running.',
  loading: 'The page is still loading. Read it once it has loaded.',
  failed: 'The page could not be read. Try Read page now again.',
  /** 0.7.1 (F21-4): a scrap.tf page the import cannot read (the front page, raffles, settings, a profile). */
  notImportable: 'Nothing to import on this page.',
  /** 0.7.1 (F21-1): the import refused the read while the item data loads; nothing was stored. */
  schemaLoading: 'Item data is still loading; press Read page now in a moment.',
  /**
   * 0.9 (#14): a read whose page carries a check page's own words (scraptfChallengeIn): nothing is imported. Only
   * ScraptfReadOutcome.reason: the pushed read's warning is SCRAPTF_WINDOW_NOTICES.challenge, which the toolbar words.
   */
  challenge: 'A Cloudflare or scrap.tf check is on screen: solve it in the page; nothing was imported.',
} as const);

/**
 * 0.7.1 (F21-10): the read warning code of a page shown again within READ_AUTO_MIN_GAP_MS. Nothing was read:
 * the toolbar shows that page's last read (not another page's) and says how to read it again.
 */
export const SCRAPTF_NOT_READ_AGAIN = 'not-read-again';

/**
 * 0.7.1 (F21-3, F21-10): the fixed notices about the page on screen (ScraptfWindowNav.notice), set by main
 * from the main frame's HTTP status, a failed load, a crash or a link it kept from opening; cleared at the
 * next commit. Never page content or an address.
 */
export const SCRAPTF_WINDOW_NOTICES = Object.freeze({
  challenge: 'Cloudflare check or error page on screen: solve it in the page; it is read once the real page loads.',
  rateLimited: 'scrap.tf is rate-limiting this window: wait a minute before reloading.',
  offline: 'scrap.tf could not be reached (no connection, or the site is down): press Reload.',
  insecure: "The connection to scrap.tf could not be secured (check this computer's date and time): press Reload.",
  badResponse: 'scrap.tf sent a page that could not be shown: press Reload.',
  loadFailed: 'The page did not load: press Reload.',
  crashed: 'The page stopped working: press Reload.',
  blocked: 'Flip Desk kept a link from opening: only scrap.tf pages and Steam sign-in open in this window.',
  popup: 'Flip Desk opens no new windows from a page: that link was not opened.',
  needsClick: 'A page tried to open a link in your browser without your click: nothing was opened.',
} as const);

/** The link notices: about one link, not the page, so a page notice (a challenge, a failed load) outranks them. */
export const SCRAPTF_LINK_NOTICES: ReadonlySet<string> = new Set([SCRAPTF_WINDOW_NOTICES.blocked, SCRAPTF_WINDOW_NOTICES.popup, SCRAPTF_WINDOW_NOTICES.needsClick]);

/**
 * The notices of a page that did not load or crashed: Chromium's error page, or nothing, is on screen, so a
 * dashboard link to that page loads it again (the user's click) rather than only bringing the window up.
 */
export const SCRAPTF_FAILURE_NOTICES: ReadonlySet<string> = new Set([
  SCRAPTF_WINDOW_NOTICES.offline,
  SCRAPTF_WINDOW_NOTICES.insecure,
  SCRAPTF_WINDOW_NOTICES.badResponse,
  SCRAPTF_WINDOW_NOTICES.loadFailed,
  SCRAPTF_WINDOW_NOTICES.crashed,
]);

/**
 * The notice for a main-frame document's HTTP status: 403 and 503 are what Cloudflare's check and scrap.tf's
 * error pages answer with, 429 its rate limit. Such a page is not read automatically (F21-3); null otherwise.
 */
export function responseNotice(httpStatus: unknown): string | null {
  if (httpStatus === 429) return SCRAPTF_WINDOW_NOTICES.rateLimited;
  if (httpStatus === 403 || httpStatus === 503) return SCRAPTF_WINDOW_NOTICES.challenge;
  return null;
}

/**
 * 0.9 (#14): words only a check page carries: the sentences of scrap.tf's Cloudflare templates (RESEARCH §4.1), the
 * interstitial's title as a <title> and its challenge options object. A page served with an unexpected status (a 200)
 * that carries one is a check, not a scrap.tf page: never imported. Cloudflare's bot-detection script path is left out
 * on purpose (it may sit on ordinary pages); so is a bare "Just a moment..." outside a <title>.
 */
export const SCRAPTF_CHALLENGE_PHRASES: readonly RegExp[] = Object.freeze([
  /Please complete the following captcha to enter Scrap\.TF/i,
  /checking your browser before continuing to Scrap\.TF/i,
  /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
  /\b_cf_chl_opt\b/,
]);
/** 0.9 (#14): only the start of a read is searched: a check page is small, a bank page that large is no check. */
export const SCRAPTF_CHALLENGE_SCAN_CHARS = 262_144;

/** 0.9 (#14): `html` (a READ_SCRIPT result) is a check page by SCRAPTF_CHALLENGE_PHRASES. */
export function scraptfChallengeIn(html: unknown): boolean {
  if (typeof html !== 'string' || html.length === 0) return false;
  const head = html.slice(0, SCRAPTF_CHALLENGE_SCAN_CHARS);
  return SCRAPTF_CHALLENGE_PHRASES.some((re) => re.test(head));
}

/**
 * The notice for a main-frame load that failed (did-fail-load, never ERR_ABORTED), by Chromium's net error
 * group (net_error_list.h): -100s connection, -200s certificate, -300s HTTP, -800s name resolution.
 */
export function loadFailureNotice(netError: unknown): string {
  if (typeof netError !== 'number' || !Number.isFinite(netError)) return SCRAPTF_WINDOW_NOTICES.loadFailed;
  // TIMED_OUT and NETWORK_CHANGED sit in the system group but are the connection's.
  if ((netError <= -100 && netError > -200) || (netError <= -800 && netError > -900) || netError === -7 || netError === -21) return SCRAPTF_WINDOW_NOTICES.offline;
  if (netError <= -200 && netError > -300) return SCRAPTF_WINDOW_NOTICES.insecure;
  if (netError <= -300 && netError > -400) return SCRAPTF_WINDOW_NOTICES.badResponse;
  return SCRAPTF_WINDOW_NOTICES.loadFailed;
}

/** A move of the view the user's own key press or mouse button asks for (F21-11): the toolbar's keys. */
export type WindowKeyAction = 'back' | 'forward' | 'reload' | 'home';

/** The parts of Electron's before-input-event `Input` the window reads. */
export interface WindowKeyInput {
  type?: unknown;
  key?: unknown;
  alt?: unknown;
  control?: unknown;
  meta?: unknown;
  shift?: unknown;
  isAutoRepeat?: unknown;
}

/**
 * The toolbar's keys while the scrap.tf page has the focus (F21-11): F5 or Ctrl+R reload, Alt+Left back,
 * Alt+Right forward, Alt+Home home. Only a key going down, never its repeats, so a held key is one move.
 * Chromium raises before-input-event for the user's real input only; a page's script cannot.
 */
export function windowKeyAction(input: WindowKeyInput | null | undefined): WindowKeyAction | null {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat === true) return null;
  if (input.meta === true || input.shift === true || typeof input.key !== 'string') return null;
  const alt = input.alt === true;
  const ctrl = input.control === true;
  if (alt && !ctrl) {
    if (input.key === 'ArrowLeft') return 'back';
    if (input.key === 'ArrowRight') return 'forward';
    if (input.key === 'Home') return 'home';
    return null;
  }
  if (!alt && !ctrl && input.key === 'F5') return 'reload';
  if (ctrl && !alt && (input.key === 'r' || input.key === 'R')) return 'reload';
  return null;
}

/** The window's app-command (Windows: the mouse's back and forward buttons, a keyboard's browser keys). */
export function appCommandAction(command: unknown): WindowKeyAction | null {
  if (command === 'browser-backward') return 'back';
  if (command === 'browser-forward') return 'forward';
  return null;
}

/**
 * The only code Flip Desk ever runs in the scrap.tf view, in isolated world READ_WORLD_ID: the DOM the
 * user's browsing already loaded, serialised, or null over the import cap. No assignment, no event, no
 * request, no click, focus or scroll: it reads one property. Pinned by test/shared/scraptfWindowPolicy.test.ts
 * and checked against READ_SCRIPT_FORBIDDEN by the compliance scan.
 */
export const READ_SCRIPT =
  "((h) => (typeof h === 'string' && h.length <= 20971520 ? h : null))(document.documentElement ? document.documentElement.outerHTML : null)";

/** What READ_SCRIPT (or any code meant for the view) must never contain. */
export const READ_SCRIPT_FORBIDDEN: readonly RegExp[] = Object.freeze([
  // An assignment of any kind (=, +=, ??=), but not ==, ===, !=, !==, <=, >= or =>.
  /(?<![=!<>])=(?![=>])/,
  /\+\+|--/,
  /\b(?:fetch|XMLHttp\w*|WebSocket|EventSource|sendBeacon|postMessage|BroadcastChannel|Worker|import|require|eval|Function)\b/,
  /\b(?:click|submit|requestSubmit|focus|blur|select|scroll\w*|dispatchEvent|Event|CustomEvent|addEventListener|setTimeout|setInterval|requestAnimationFrame)\b/,
  /\b(?:write|writeln|innerHTML|innerText|textContent|insertAdjacent\w*|append\w*|prepend|remove\w*|replace\w*|setAttribute|cloneNode|open|close|execCommand)\b/,
  /\b(?:location|history|cookie|cookieStore|localStorage|sessionStorage|indexedDB|caches|navigator|opener|parent|top|frames|window|globalThis|self)\b/,
  /\bnew\b|\bdelete\b|\bawait\b|\byield\b|\basync\b/,
]);

/** The forbidden pieces `code` contains (empty for READ_SCRIPT). */
export function readScriptProblems(code: string): string[] {
  const out: string[] = [];
  for (const re of READ_SCRIPT_FORBIDDEN) {
    for (const m of code.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) out.push(m[0]);
  }
  return out;
}

/** Shape check for what READ_SCRIPT resolved with: a string within the cap, else null. */
export function readResultHtml(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= READ_MAX_CHARS ? value : null;
}

/** The service's cap on an 'import.html' fileName (rpcHandlers' importParams); a window read's name keeps to it. */
export const WINDOW_READ_NAME_MAX = 260;

/** The file name a window read is imported under ('scrap.tf window /buy/hats'), cut to WINDOW_READ_NAME_MAX. */
export function windowReadFileName(url: unknown): string {
  // A longer name fails the service's zod check on every read of the page, Read page now included.
  return `scrap.tf window ${scraptfPathOf(url)}`.slice(0, WINDOW_READ_NAME_MAX);
}

// ---------------------------------------------------------------------------
// Settings rule (settings.scraptfWindow.enabled)
// ---------------------------------------------------------------------------

export const SCRAPTF_WINDOW_NEEDS_IMPORT = 'scraptfWindow.enabled: the scrap.tf window needs saved-page import turned on, with its acknowledgement, first';
export const SCRAPTF_WINDOW_NEEDS_ACK = 'scraptfWindow.enabled: tick the scrap.tf window risk acknowledgement first';
/** Main's refusal of a window action while the window is off (fixed text). */
export const SCRAPTF_WINDOW_OFF = 'The scrap.tf window is turned off. Turn it on in Settings > scrap.tf window first.';
/**
 * 'import.html' `address` and `origin` mark a read of the scrap.tf window, which only main makes (it calls
 * the service directly). Main's router (and the mock) refuse either from a page with this fixed text.
 */
export const IMPORT_HTML_ORIGIN_REFUSAL = 'Invalid parameters for import.html: address and origin are set only by the app';

type WindowGateSettings = Pick<Settings, 'import' | 'scraptfWindow'>;

/** Why `s` may not have the window on, or null when it may. */
export function scraptfWindowEnableProblem(s: WindowGateSettings): string | null {
  if (!s.import.enabled || s.import.acknowledgedAt === null) return SCRAPTF_WINDOW_NEEDS_IMPORT;
  if (s.scraptfWindow.acknowledgedAt === null) return SCRAPTF_WINDOW_NEEDS_ACK;
  return null;
}

/**
 * The rule for a settings change, shared by the schema's strict setter and the mock. Turning the window on
 * (`turnsOn`: the patch sets scraptfWindow.enabled true) without its three gates is refused. A change that
 * removes a gate while the window is on (import off, an acknowledgement withdrawn) turns the window off
 * with it, so the user is never stuck unable to turn import off.
 */
export function gateScraptfWindow<T extends WindowGateSettings>(next: T, turnsOn: boolean): { ok: true; settings: T } | { ok: false; message: string } {
  if (!next.scraptfWindow.enabled) return { ok: true, settings: next };
  const problem = scraptfWindowEnableProblem(next);
  if (problem === null) return { ok: true, settings: next };
  if (turnsOn) return { ok: false, message: problem };
  return { ok: true, settings: { ...next, scraptfWindow: { ...next.scraptfWindow, enabled: false } } };
}
