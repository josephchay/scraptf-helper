// Pure helpers for the main process. Nothing here imports 'electron', so all
// of it is unit-tested directly (path traversal, sender checks, launch flags).

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

export const APP_USER_MODEL_ID = 'io.github.tf2flipdesk.app';
export const APP_SCHEME = 'app';
export const APP_HOST = 'app';
export const APP_ORIGIN = 'app://app';
export const DASHBOARD_URL = 'app://app/index.html';
export const QUICK_ENTRY_URL = 'app://app/index.html#/quick';

/** Passed through webPreferences.additionalArguments; preload.ts keeps its own copy of this prefix. */
export const WINDOW_KIND_ARG = '--flipdesk-window=';
export type WindowKind = 'dashboard' | 'quick-entry';

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
   * Honour --dev, --smoke-test and --smoke-wait. Main passes false for packaged
   * builds, so a shortcut or Run entry cannot turn DevTools on or make the app
   * overwrite a file with a report. --hidden (login item) always works, and
   * --user-data-dir is a Chromium switch Electron applies anyway.
   */
  allowDiagnostics: boolean;
}

export function parseLaunchArgs(argv: readonly string[], cwd: string, opts: LaunchArgOptions = { allowDiagnostics: true }): LaunchArgs {
  const diag = opts.allowDiagnostics;
  const smoke = diag ? flagValue(argv, 'smoke-test') : null;
  const udd = flagValue(argv, 'user-data-dir');
  const wait = diag ? Number(flagValue(argv, 'smoke-wait') ?? '0') : 0;
  return {
    hidden: argv.includes('--hidden'),
    dev: diag && argv.includes('--dev'),
    smokeTest: smoke ? path.resolve(cwd, smoke) : null,
    userDataDir: udd ? path.resolve(cwd, udd) : null,
    smokeWaitSec: Number.isFinite(wait) && wait > 0 ? Math.min(300, Math.floor(wait)) : 0,
  };
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
 * briefly because antivirus scanners on Windows hold new files open.
 */
export function writeFileAtomicSync(file: string, data: string | Uint8Array, fsImpl: AtomicWriteFs = realFs): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  const fd = fsImpl.openSync(tmp, 'w', 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += fsImpl.writeSync(fd, bytes.subarray(off));
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
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
