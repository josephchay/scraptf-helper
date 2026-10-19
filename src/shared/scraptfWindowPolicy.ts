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
} as const);

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
