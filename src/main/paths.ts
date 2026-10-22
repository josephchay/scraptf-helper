// Pure helpers for the main process. Nothing here imports 'electron', so all
// of it is unit-tested directly (path traversal, sender checks, launch flags).

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

export const APP_USER_MODEL_ID = 'io.github.tf2flipdesk.app';
export const APP_SCHEME = 'app';
export const APP_HOST = 'app';
export const APP_ORIGIN = 'app://app';
export const DASHBOARD_URL = 'app://app/index.html';
export const QUICK_ENTRY_URL = 'app://app/index.html#/quick';
/** The live check popup (F16): the same app:// page and preload as every other window. */
export const CHECK_URL = 'app://app/index.html#/check';
/**
 * F21: the scrap.tf window's toolbar (window kind 'scraptf'): an app:// page with the normal preload and
 * hardening, above the window's scrap.tf view (which is not an app:// page and has no preload).
 */
export const SCRAPTF_BAR_URL = 'app://app/index.html#/scraptf-bar';

/** Passed through webPreferences.additionalArguments; preload.ts keeps its own copy of this prefix. */
export const WINDOW_KIND_ARG = '--flipdesk-window=';
export type WindowKind = 'dashboard' | 'quick-entry' | 'check' | 'scraptf';
/** Every window kind; preload.ts keeps its own copy (it may import no main-process module), pinned by a test. */
export const WINDOW_KINDS: readonly WindowKind[] = ['dashboard', 'quick-entry', 'check', 'scraptf'];

/** Image hosts the dashboard may load from (CSP img-src and the session request filter). */
export const RENDERER_IMAGE_HOSTS: readonly string[] = [
  'steamcdn-a.akamaihd.net',
  'community.akamai.steamstatic.com',
  'community.cloudflare.steamstatic.com',
];

// Header and meta must agree: the browser enforces both, so the stricter one wins.
const CSP_DIRECTIVES: readonly (readonly [string, string])[] = [
  ['default-src', "'self'"],
  ['script-src', "'self'"],
  ['style-src', "'self' 'unsafe-inline'"],
  ['img-src', `'self' data: ${RENDERER_IMAGE_HOSTS.map((h) => `https://${h}`).join(' ')}`],
  ['connect-src', "'none'"],
  ['object-src', "'none'"],
  ['base-uri', "'none'"],
  ['frame-ancestors', "'none'"],
  ['form-action', "'none'"],
];

/** Sent as a response header on every app:// response; equals the meta tag in src/renderer/index.html. */
export const RENDERER_CSP = CSP_DIRECTIVES.map(([k, v]) => `${k} ${v}`).join('; ');

/**
 * The same policy without frame-ancestors, which Chromium ignores in a meta
 * tag (and logs a console error for); the header carries it instead.
 */
export const RENDERER_CSP_META = CSP_DIRECTIVES.filter(([k]) => k !== 'frame-ancestors')
  .map(([k, v]) => `${k} ${v}`)
  .join('; ');

/** Splits a CSP into directive -> sorted sources, so policies compare regardless of order. */
export function parseCsp(policy: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const name = tokens.shift()?.toLowerCase();
    if (name && !out.has(name)) out.set(name, tokens.sort().join(' '));
  }
  return out;
}

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Launch flags
// ---------------------------------------------------------------------------

export interface LaunchArgs {
  /** Started by the login item: stay in the tray. */
  hidden: boolean;
  /** Allows DevTools. */
  dev: boolean;
  /** Absolute path of the smoke-test JSON report, or null. */
  smokeTest: string | null;
  /** Absolute userData override, or null. */
  userDataDir: string | null;
  /** Smoke test only: seconds to keep running after 'ready' before recording health (0 = none, max 300). */
  smokeWaitSec: number;
  /**
   * F21 window test (`--smoke-window`): absolute path of its JSON report, or null. Like --smoke-test it is
   * read only when diagnostics are allowed; smokeWindowRefusal decides whether the run may start at all.
   */
  smokeWindow: string | null;
  /** --smoke-window was given in any form, allowed or not: a build that does not allow it refuses instead of starting. */
  smokeWindowAsked: boolean;
}

function flagValue(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a.startsWith(prefix)) {
      const v = a.slice(prefix.length).trim();
      return v === '' ? null : v;
    }
  }
  return null;
}

export interface LaunchArgOptions {
  /**
   * Honour --dev, --smoke-test, --smoke-wait and --smoke-window. Main passes false for packaged
   * builds, so a shortcut or Run entry cannot turn DevTools on or make the app
   * overwrite a file with a report. --hidden (login item) always works, and
   * --user-data-dir is a Chromium switch Electron applies anyway.
   */
  allowDiagnostics: boolean;
}

export function parseLaunchArgs(argv: readonly string[], cwd: string, opts: LaunchArgOptions = { allowDiagnostics: true }): LaunchArgs {
  const diag = opts.allowDiagnostics;
  const smoke = diag ? flagValue(argv, 'smoke-test') : null;
  const smokeWindow = diag ? flagValue(argv, 'smoke-window') : null;
  const udd = flagValue(argv, 'user-data-dir');
  const wait = diag ? Number(flagValue(argv, 'smoke-wait') ?? '0') : 0;
  return {
    hidden: argv.includes('--hidden'),
    dev: diag && argv.includes('--dev'),
    smokeTest: smoke ? path.resolve(cwd, smoke) : null,
    userDataDir: udd ? path.resolve(cwd, udd) : null,
    smokeWaitSec: Number.isFinite(wait) && wait > 0 ? Math.min(300, Math.floor(wait)) : 0,
    smokeWindow: smokeWindow ? path.resolve(cwd, smokeWindow) : null,
    smokeWindowAsked: argv.some((a) => a === '--smoke-window' || a.startsWith('--smoke-window=')),
  };
}

// ---------------------------------------------------------------------------
// The window test's gate (--smoke-window)
// ---------------------------------------------------------------------------

/** Why main refuses a --smoke-window run (printed, and written to the report when one was named). Fixed texts. */
export const SMOKE_WINDOW_REFUSALS = Object.freeze({
  notAllowed: '--smoke-window runs only in a development build, or in a packaged one started with FLIPDESK_DIAGNOSTICS=1.',
  noReport: '--smoke-window needs a report path: --smoke-window=<report.json>.',
  withSmokeTest: '--smoke-window cannot be combined with --smoke-test.',
  noProfile: '--smoke-window needs --user-data-dir=<a new folder>: the test writes its own settings into that profile.',
  defaultProfile: "--smoke-window refuses the app's own profile: pass --user-data-dir=<a new folder> outside it.",
} as const);

/**
 * The window test's Chromium resolves no host name: everything its pages ask for is answered by the local
 * fixture router, and this makes sure nothing that bypasses a protocol handler (a preconnect, a DNS
 * prefetch) can reach a real host either. The service's own traffic runs in Node, which this does not touch.
 */
export const SMOKE_WINDOW_HOST_RULES = 'MAP * ~NOTFOUND';
/**
 * And it uses no proxy: a system proxy (or a PAC file it fetches) resolves host names itself, so a request
 * that bypasses the protocol handlers would get past the host rules through it.
 */
export const SMOKE_WINDOW_NO_PROXY = 'no-proxy-server';

export interface SmokeWindowGate {
  /** As LaunchArgOptions.allowDiagnostics: a development build, or FLIPDESK_DIAGNOSTICS=1. */
  allowDiagnostics: boolean;
  /** The app's default userData folder(s) (appData plus the app's name): the user's real profile. */
  defaultUserData: readonly string[];
  /** The path rules to compare with (process.platform): Windows paths ignore case. */
  platform: NodeJS.Platform;
}

/** True when `a` and `b` are the same folder, or one holds the other. */
function overlaps(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (x: string) => {
    const r = p.resolve(x);
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  const inside = (child: string, parent: string) => {
    const rel = p.relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
  };
  const na = norm(a);
  const nb = norm(b);
  return inside(na, nb) || inside(nb, na);
}

/**
 * Null when a --smoke-window run may start, else the refusal main prints before it starts anything (no
 * profile, lock or window) and exits 1. The run writes settings into its profile and turns the scrap.tf
 * window on there, so it needs diagnostics, a report path, a profile of its own (never the app's default
 * folder, one inside it or one holding it) and no --smoke-test beside it. Null without the flag.
 */
export function smokeWindowRefusal(args: Pick<LaunchArgs, 'smokeWindow' | 'smokeWindowAsked' | 'smokeTest' | 'userDataDir'>, gate: SmokeWindowGate): string | null {
  if (!args.smokeWindowAsked) return null;
  if (!gate.allowDiagnostics) return SMOKE_WINDOW_REFUSALS.notAllowed;
  if (args.smokeWindow === null) return SMOKE_WINDOW_REFUSALS.noReport;
  if (args.smokeTest !== null) return SMOKE_WINDOW_REFUSALS.withSmokeTest;
  const profile = args.userDataDir;
  if (profile === null) return SMOKE_WINDOW_REFUSALS.noProfile;
  if (gate.defaultUserData.length === 0 || gate.defaultUserData.some((d) => overlaps(profile, d, gate.platform))) return SMOKE_WINDOW_REFUSALS.defaultProfile;
  return null;
}

// ---------------------------------------------------------------------------
// File locations
// ---------------------------------------------------------------------------

export interface AppPaths {
  appPath: string;
  rendererRoot: string;
  preload: string;
  serviceEntry: string;
  iconPng: string;
  trayPng: string;
  userData: string;
  settingsFile: string;
  secretsFile: string;
  /** Passed to the service as its data directory (SQLite lives here). */
  dataDir: string;
  logDir: string;
  mainLog: string;
}

/** `appPath` is app.getAppPath() (the project root in dev, app.asar when packaged). */
export function resolveAppPaths(appPath: string, userData: string): AppPaths {
  const logDir = path.join(userData, 'logs');
  return {
    appPath,
    rendererRoot: path.join(appPath, 'dist', 'renderer'),
    preload: path.join(appPath, 'dist', 'preload.cjs'),
    serviceEntry: path.join(appPath, 'dist', 'service.cjs'),
    iconPng: path.join(appPath, 'assets', 'icon.png'),
    trayPng: path.join(appPath, 'assets', 'tray.png'),
    userData,
    settingsFile: path.join(userData, 'settings.json'),
    secretsFile: path.join(userData, 'secrets.json'),
    dataDir: path.join(userData, 'data'),
    logDir,
    mainLog: path.join(logDir, 'main.log'),
  };
}

// ---------------------------------------------------------------------------
// Chromium's own log (0.7.4, F54)
// ---------------------------------------------------------------------------

/** Chromium's log file, beside main.log in the logs folder. */
export const CHROMIUM_LOG_NAME = 'chromium.log';
/** At start, a chromium.log over this size becomes chromium.log.old (the one copy kept); while running it is emptied. */
export const CHROMIUM_LOG_MAX_BYTES = 1024 * 1024;

/** The part of node:fs that prepareChromiumLog uses. */
export interface ChromiumLogFs {
  mkdirSync(dir: string, opts: { recursive: true }): unknown;
  statSync(file: string): { size: number; isFile(): boolean };
  renameSync(from: string, to: string): void;
  truncateSync(file: string, len: number): void;
}

const realChromiumLogFs: ChromiumLogFs = { mkdirSync, statSync, renameSync, truncateSync };

export type ChromiumLogSetup =
  /** `rotated`: what was done to a file over the limit ('moved' to chromium.log.old, or 'emptied'), else null. */
  | { ok: true; file: string; rotated: 'moved' | 'emptied' | null }
  | { ok: false; reason: string };

function fsCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'unknown error';
}

/**
 * Readies <logDir>/chromium.log for Chromium's file logging (main's --enable-logging=file and --log-file): makes the
 * folder and, when the file is over `maxBytes`, moves it to chromium.log.old (replacing the one before) or, if it
 * cannot be moved, empties it. Chromium only appends to an explicit log file, so this keeps it bounded across runs.
 * Not ok when the folder cannot be made or the file can be neither checked nor bounded: main then leaves Chromium's
 * logging off for this run rather than let the file grow. Main calls it before 'ready' with the instance lock held,
 * so neither this process's Chromium nor another copy has the file open yet.
 */
export function prepareChromiumLog(logDir: string, fsImpl: ChromiumLogFs = realChromiumLogFs, maxBytes = CHROMIUM_LOG_MAX_BYTES): ChromiumLogSetup {
  const file = path.join(logDir, CHROMIUM_LOG_NAME);
  try {
    fsImpl.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `the logs folder could not be created (${fsCode(err)})` };
  }
  let size: number;
  try {
    const st = fsImpl.statSync(file);
    if (!st.isFile()) return { ok: false, reason: `${CHROMIUM_LOG_NAME} is not a file` };
    size = st.size;
  } catch (err) {
    if (fsCode(err) === 'ENOENT') return { ok: true, file, rotated: null };
    return { ok: false, reason: `${CHROMIUM_LOG_NAME} could not be checked (${fsCode(err)})` };
  }
  if (size <= maxBytes) return { ok: true, file, rotated: null };
  try {
    fsImpl.renameSync(file, `${file}.old`);
    return { ok: true, file, rotated: 'moved' };
  } catch {
    // Held open (a child process of an earlier run still exiting, a scanner) or the .old is: empty it instead.
  }
  try {
    fsImpl.truncateSync(file, 0);
    return { ok: true, file, rotated: 'emptied' };
  } catch (err) {
    return { ok: false, reason: `${CHROMIUM_LOG_NAME} is over its size limit and could be neither moved nor emptied (${fsCode(err)})` };
  }
}

/**
 * 0.7.4 (F54): the least time between two size checks of chromium.log while the app runs. main checks on the
 * status pushes it already handles (no timer of its own), at most this often.
 */
export const CHROMIUM_LOG_CHECK_MS = 10 * 60_000;

/**
 * 0.7.4 (F54): bounds chromium.log during a long tray session, which prepareChromiumLog's check at start does not
 * cover: over `maxBytes` the file is emptied in place. It is not moved: this process's Chromium holds it open (an
 * open file cannot be renamed on Windows without FILE_SHARE_DELETE), and Chromium appends, so it carries on from
 * the start. 'emptied', or null when under the limit, missing, not a file, or on any error (a local file check
 * only: no network, nothing of Chromium's session).
 */
export function boundChromiumLogWhileRunning(
  file: string,
  fsImpl: Pick<ChromiumLogFs, 'statSync' | 'truncateSync'> = realChromiumLogFs,
  maxBytes = CHROMIUM_LOG_MAX_BYTES,
): 'emptied' | null {
  try {
    const st = fsImpl.statSync(file);
    if (!st.isFile() || st.size <= maxBytes) return null;
    fsImpl.truncateSync(file, 0);
    return 'emptied';
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// app:// protocol
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export type AppRequestResolution =
  | { ok: true; filePath: string; mimeType: string }
  | { ok: false; status: 400 | 403 | 404 | 405; reason: string };

/**
 * Maps an app:// request to a file under `rootDir`. Rejects anything that is
 * not a GET for app://app/, and any path that after percent-decoding contains
 * dot segments, backslashes, colons, control characters or would resolve
 * outside the root. Chromium already collapses plain `..` before the handler
 * runs; encoded forms such as `%2e%2e%2f` only show up after decoding.
 */
export function resolveAppRequest(rootDir: string, rawUrl: string, method = 'GET'): AppRequestResolution {
  if (method.toUpperCase() !== 'GET') return { ok: false, status: 405, reason: 'method not allowed' };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, reason: 'bad url' };
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST || url.username !== '' || url.password !== '') {
    return { ok: false, status: 403, reason: 'wrong origin' };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400, reason: 'bad encoding' };
  }
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(decoded)) return { ok: false, status: 403, reason: 'forbidden character' };

  const segments = decoded.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '.' || s === '..')) return { ok: false, status: 403, reason: 'dot segment' };
  // Windows silently strips trailing dots and spaces ("index.html." opens index.html).
  if (segments.some((s) => /[. ]$/.test(s))) return { ok: false, status: 404, reason: 'not found' };

  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, segments.length === 0 ? 'index.html' : segments.join(path.sep));
  const rel = path.relative(root, filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, status: 403, reason: 'outside root' };

  return { ok: true, filePath, mimeType: mimeTypeFor(filePath) };
}

// ---------------------------------------------------------------------------
// Sender, navigation and request checks
// ---------------------------------------------------------------------------

function isAppUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith(`${APP_ORIGIN}/`)) return false;
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/** True only for frames showing our own app://app/ pages. */
export function isTrustedSenderUrl(url: unknown): boolean {
  return isAppUrl(url);
}

/** Renderer navigation is allowed only within app://app/. */
export function isAppNavigationUrl(url: unknown): boolean {
  return isAppUrl(url);
}

/** Session-level filter for http(s)/ws(s) requests made by renderers: only the CSP image hosts. */
export function isAllowedRendererRequest(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.port === '' && u.username === '' && RENDERER_IMAGE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * True when `url` parses as https. Checked before the links allowlist by everything that hands a URL to
 * the user's browser (links.open, F20's notification click), so a scheme the OS shell would run never gets there.
 */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Restart delay after `failures` consecutive crashes: 1 s, 2 s, 4 s … capped at 60 s. */
export function restartDelayMs(failures: number, minMs = 1000, maxMs = 60_000): number {
  const n = Math.max(0, Math.floor(failures) - 1);
  return Math.min(maxMs, minMs * 2 ** Math.min(n, 30));
}

/** Error text safe to hand to a renderer: message only, no stack, bounded length. */
export function safeErrorMessage(err: unknown): string {
  let msg: string;
  if (err instanceof Error) msg = err.message;
  else if (typeof err === 'string') msg = err;
  else msg = 'Unknown error';
  msg = msg.replace(/\r?\n\s+at\s[\s\S]*$/, '').trim();
  if (msg === '') msg = 'Unknown error';
  return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
}

const RESERVED_WIN_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A file name safe to offer in a save dialog (no directories, no characters Windows rejects). */
export function sanitizeFileName(name: string, fallback: string): string {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120);
  if (base === '' || /^\.+$/.test(base)) return fallback;
  return RESERVED_WIN_NAMES.test(base) ? `_${base}` : base;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientLock(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/**
 * readFileSync(file, 'utf8') that retries briefly while an antivirus or backup
 * tool holds the file (EBUSY/EPERM/EACCES), like writeFileAtomicSync's rename.
 * Other errors (ENOENT) are thrown at once.
 */
export function readFileRetrySync(file: string, readImpl: (f: string) => string = (f) => readFileSync(f, 'utf8')): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return readImpl(file);
    } catch (err) {
      if (attempt < 5 && isTransientLock(err)) {
        sleepSync(25 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/** The part of fs/promises.open that readFileBounded uses. */
export type OpenForRead = (file: string, flags: 'r') => Promise<{
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}>;

/**
 * Reads at most `maxBytes` bytes of `file`. A file that grew past a size check
 * (still downloading or syncing) is cut off instead of being read whole; the
 * caller compares the result's length with its limit.
 */
export async function readFileBounded(file: string, maxBytes: number, openImpl: OpenForRead = open): Promise<Uint8Array> {
  const cap = Math.max(0, Math.floor(maxBytes));
  const fh = await openImpl(file, 'r');
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < cap) {
      const buf = new Uint8Array(Math.min(cap - total, 1024 * 1024));
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  } finally {
    await fh.close();
  }
}

export interface AtomicWriteFs {
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  writeSync: (fd: number, data: Uint8Array) => number;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}

const realFs: AtomicWriteFs = {
  mkdirSync,
  openSync,
  writeSync: (fd, data) => writeSync(fd, data),
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
};

let tmpCounter = 0;

/**
 * Writes `data` to a temp file in the same directory, fsyncs it and renames it
 * over `file`, so a crash never leaves a half-written file. Retries the rename
 * briefly because antivirus scanners on Windows hold new files open. On any
 * failure the temp file is removed and the error rethrown.
 */
export function writeFileAtomicSync(file: string, data: string | Uint8Array, fsImpl: AtomicWriteFs = realFs): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  const fd = fsImpl.openSync(tmp, 'w', 0o600);
  // 0.7.3: a failed write, fsync or close (disk full, I/O error) no longer leaves the temp file behind.
  let closed = false;
  try {
    let off = 0;
    while (off < bytes.length) off += fsImpl.writeSync(fd, bytes.subarray(off));
    fsImpl.fsyncSync(fd);
    // Marked first: a failed close is never retried (the fd number may already be reused).
    closed = true;
    fsImpl.closeSync(fd);
  } catch (err) {
    if (!closed) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        // the write's error is the one to report
      }
    }
    // Closed first so Windows can delete it.
    try {
      fsImpl.unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fsImpl.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        sleepSync(25 * (attempt + 1));
        continue;
      }
      try {
        fsImpl.unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw err;
    }
  }
}
