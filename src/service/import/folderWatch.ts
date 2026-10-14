// Watches one folder for scrap.tf pages the user saves and hands each new or
// changed .html/.htm file to `onFile`. Only reads local files; never throws after
// creation (errors are logged).

import { watch as fsWatch, promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeHtmlBuffer } from '../../shared/htmlDecode';
import type { UnixMs } from '../../shared/types';
import type { Logger } from '../contracts';
import { MAX_IMPORT_BYTES } from './scraptfHtml';

export const WATCH_DEBOUNCE_MS = 1500;
/** Retries for files Windows still holds locked (EBUSY/EPERM) right after a save. */
const MAX_LOCK_RETRIES = 3;

/** The part of an fs.FSWatcher the watcher uses (lets tests inject fake events). */
export interface WatchHandle {
  close(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type WatchFactory = (folder: string, listener: (event: string, fileName: string | null) => void) => WatchHandle;

export interface FolderWatcherOptions {
  folder: string;
  log: Logger;
  onFile(path: string, html: string, mtimeMs: number): void;
  now?: () => UnixMs;
  /** The initial scan picks up files modified at or after this time (default: start time). */
  since?: UnixMs | null;
  debounceMs?: number;
  maxBytes?: number;
  watchFactory?: WatchFactory;
}

export interface FolderWatcher {
  stop(): void;
  /** False once the OS watch failed (folder removed, drive gone) or could not be set up. */
  alive(): boolean;
  /** Why the watch stopped or could not start, or null. */
  lastError(): string | null;
}

const defaultWatchFactory: WatchFactory = (folder, listener) =>
  fsWatch(folder, { persistent: false, recursive: false, encoding: 'utf8' }, (event, fileName) =>
    listener(event, fileName === null || fileName === undefined ? null : String(fileName)),
  );

const TEMP_SUFFIXES = ['.crdownload', '.tmp', '.temp', '.part', '.partial', '.download', '.opdownload', '~'];

/** True for a saved page we should import: *.html / *.htm, not a temp file, not inside a "*_files" folder. */
export function isImportCandidate(fileName: string): boolean {
  const segments = fileName.split(/[\\/]+/).filter(Boolean);
  const base = segments.pop();
  if (!base) return false;
  if (segments.some((s) => /_files$/i.test(s) || /-Dateien$/i.test(s))) return false;
  const lower = base.toLowerCase();
  if (lower.startsWith('.') || lower.startsWith('~')) return false;
  if (TEMP_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

// Shared with main's "Import file" so both paths decode a page the same way.
export { decodeHtmlBuffer };

function errCode(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createFolderWatcher(opts: FolderWatcherOptions): FolderWatcher {
  const { log, onFile } = opts;
  const folder = resolve(opts.folder);
  const now = opts.now ?? (() => Date.now());
  const debounceMs = Math.max(0, opts.debounceMs ?? WATCH_DEBOUNCE_MS);
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;
  const since = opts.since ?? now();
  const factory = opts.watchFactory ?? defaultWatchFactory;

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** path -> mtime of the last version delivered (or rejected), for path+mtime dedupe. */
  const handled = new Map<string, number>();
  const lockRetries = new Map<string, number>();
  /**
   * Files are read and delivered one at a time, in the order their debounce timers fire, so a
   * page saved later is also imported later (parallel reads finish in any order).
   */
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  let watcher: WatchHandle | null = null;
  let lastErr: string | null = null;

  const schedule = (fileName: string): void => {
    if (stopped || !isImportCandidate(fileName)) return;
    const full = join(folder, fileName);
    const prev = timers.get(full);
    if (prev !== undefined) clearTimeout(prev);
    const t = setTimeout(() => {
      timers.delete(full);
      queue = queue
        .then(() => processFile(full, fileName))
        .catch((err: unknown) => log.error(`Could not read ${full}: ${errText(err)}`));
    }, debounceMs);
    // Never keep the process alive just for a pending import.
    (t as { unref?: () => void }).unref?.();
    timers.set(full, t);
  };

  const deliver = (full: string, html: string, mtimeMs: number): void => {
    try {
      const r: unknown = onFile(full, html, mtimeMs);
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        (r as Promise<unknown>).then(undefined, (err: unknown) => log.error(`Import of ${full} failed: ${errText(err)}`));
      }
    } catch (err) {
      log.error(`Import of ${full} failed: ${errText(err)}`);
    }
  };

  /** Runs only through `queue`, so never twice at once. */
  const processFile = async (full: string, fileName: string): Promise<void> => {
    if (stopped) return;
    try {
      const st = await fsp.stat(full);
      if (stopped || !st.isFile()) return;
      if (handled.get(full) === st.mtimeMs) return;
      if (st.size === 0) return; // still being written; the write raises another event
      if (st.size > maxBytes) {
        handled.set(full, st.mtimeMs);
        log.warn(`Skipped ${full}: ${Math.ceil(st.size / 1024 / 1024)} MB is over the ${Math.round(maxBytes / 1024 / 1024)} MB import limit`);
        return;
      }
      const buf = await fsp.readFile(full);
      const after = await fsp.stat(full);
      if (stopped) return;
      if (after.mtimeMs !== st.mtimeMs || after.size !== st.size || buf.length !== st.size) {
        schedule(fileName);
        return;
      }
      handled.set(full, st.mtimeMs);
      lockRetries.delete(full);
      log.info(`Importing saved page ${full}`);
      deliver(full, decodeHtmlBuffer(buf), st.mtimeMs);
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') {
        log.debug(`Saved page ${full} disappeared before it could be read`);
      } else if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        const n = (lockRetries.get(full) ?? 0) + 1;
        lockRetries.set(full, n);
        if (n <= MAX_LOCK_RETRIES) schedule(fileName);
        else {
          lockRetries.delete(full);
          log.warn(`Could not read ${full}: ${errText(err)}`);
        }
      } else {
        log.error(`Could not read ${full}: ${errText(err)}`);
      }
    }
  };

  const scan = async (threshold: UnixMs): Promise<void> => {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    const due: { name: string; mtimeMs: number }[] = [];
    for (const e of entries) {
      if (stopped) return;
      if (!e.isFile() || !isImportCandidate(e.name)) continue;
      try {
        const st = await fsp.stat(join(folder, e.name));
        if (st.mtimeMs >= threshold) due.push({ name: e.name, mtimeMs: st.mtimeMs });
      } catch (err) {
        if (errCode(err) !== 'ENOENT') log.warn(`Could not inspect ${join(folder, e.name)}: ${errText(err)}`);
      }
    }
    // Oldest first, so a page saved later is also imported later (readdir lists by name). Timers
    // with the same delay fire in the order they were set, and the queue keeps that order.
    due.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const f of due) schedule(f.name);
  };

  const runScan = (): void => {
    scan(since).catch((err: unknown) => {
      if (!stopped) log.warn(`Could not scan import folder ${folder}: ${errText(err)}`);
    });
  };

  const closeWatcher = (): void => {
    const w = watcher;
    watcher = null;
    if (!w) return;
    try {
      w.close();
    } catch (err) {
      log.debug(`Closing folder watcher failed: ${errText(err)}`);
    }
  };

  try {
    watcher = factory(folder, (_event, fileName) => {
      if (stopped) return;
      // Some platforms omit the name; fall back to a scan.
      if (fileName === null || fileName === '') runScan();
      else schedule(fileName);
    });
    watcher.on('error', (err) => {
      if (stopped) return;
      lastErr = errText(err);
      log.error(`Watching import folder ${folder} stopped: ${lastErr}`);
      closeWatcher();
    });
  } catch (err) {
    lastErr = errText(err);
    log.error(`Cannot watch import folder ${folder}: ${lastErr}`);
    watcher = null;
  }
  if (watcher) runScan();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      closeWatcher();
    },
    alive: () => !stopped && watcher !== null,
    lastError: () => lastErr,
  };
}
