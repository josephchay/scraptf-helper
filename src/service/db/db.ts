// Thin wrapper around node:sqlite's DatabaseSync: connection PRAGMAs, a bounded
// prepared-statement cache and nestable transactions (SAVEPOINT inside BEGIN).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

export type SqlValue = SQLInputValue;
export type SqlRow = Record<string, SQLOutputValue>;

/** SQLite's default SQLITE_MAX_VARIABLE_NUMBER is far higher; 500 keeps statements small and cacheable. */
export const MAX_IN_PARAMS = 500;

const DEFAULT_STATEMENT_CACHE = 256;

export interface SqliteDb {
  readonly path: string;
  readonly isMemory: boolean;
  readonly raw: DatabaseSync;
  /** Prepared statement from the LRU cache (prepared on first use). */
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
  /** Runs fn atomically. Nested calls use SAVEPOINTs, so an inner failure only undoes the inner work. */
  transaction<T>(fn: () => T): T;
  inTransaction(): boolean;
  isOpen(): boolean;
  /** Integer PRAGMA value (page_count, user_version, ...). */
  pragmaNumber(name: string): number;
  pragmaText(name: string): string | null;
  close(): void;
}

export interface OpenDatabaseOptions {
  statementCacheSize?: number;
  busyTimeoutMs?: number;
}

export function isMemoryPath(path: string): boolean {
  return path === ':memory:' || path === '' || path.startsWith('file::memory:') || /[?&]mode=memory(?:&|$)/.test(path);
}

export function openDatabase(path: string, opts: OpenDatabaseOptions = {}): SqliteDb {
  const memory = isMemoryPath(path);
  const busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000));
  const cacheSize = Math.max(16, Math.floor(opts.statementCacheSize ?? DEFAULT_STATEMENT_CACHE));

  if (!memory && !path.startsWith('file:')) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const raw = new DatabaseSync(path, { timeout: busyTimeoutMs, enableForeignKeyConstraints: true });
  try {
    if (!memory) {
      raw.exec('PRAGMA journal_mode = WAL');
      // The feed writes every second; keep the WAL file from staying huge after a checkpoint.
      raw.exec('PRAGMA journal_size_limit = 67108864');
    }
    raw.exec(
      [
        'PRAGMA synchronous = NORMAL',
        'PRAGMA foreign_keys = ON',
        `PRAGMA busy_timeout = ${busyTimeoutMs}`,
        'PRAGMA temp_store = MEMORY',
        // Negative = KiB; the listing book benefits from a larger page cache than the 2 MiB default.
        'PRAGMA cache_size = -16384',
      ].join(';\n'),
    );
  } catch (err) {
    raw.close();
    throw err;
  }

  const cache = new Map<string, StatementSync>();
  let depth = 0;
  let closed = false;

  const prepare = (sql: string): StatementSync => {
    const hit = cache.get(sql);
    if (hit) {
      // Re-insert to mark as most recently used.
      cache.delete(sql);
      cache.set(sql, hit);
      return hit;
    }
    const stmt = raw.prepare(sql);
    cache.set(sql, stmt);
    if (cache.size > cacheSize) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return stmt;
  };

  const rejectAsync = (out: unknown): void => {
    if (out !== null && typeof out === 'object' && typeof (out as { then?: unknown }).then === 'function') {
      // Swallow the eventual rejection; the caller gets the TypeError below instead.
      (out as Promise<unknown>).then(undefined, () => undefined);
      throw new TypeError('transaction() callback must be synchronous; it returned a Promise');
    }
  };

  const transaction = <T>(fn: () => T): T => {
    if (depth === 0 && !raw.isTransaction) {
      raw.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const out = fn();
        rejectAsync(out);
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        // SQLite may already have rolled back on its own (e.g. SQLITE_FULL).
        if (raw.isTransaction) raw.exec('ROLLBACK');
        throw err;
      } finally {
        depth = 0;
      }
    }

    const name = `sp_${depth}`;
    raw.exec(`SAVEPOINT ${name}`);
    depth += 1;
    try {
      const out = fn();
      rejectAsync(out);
      raw.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      if (raw.isTransaction) {
        raw.exec(`ROLLBACK TO ${name}`);
        raw.exec(`RELEASE ${name}`);
      }
      throw err;
    } finally {
      depth -= 1;
    }
  };

  const pragmaRow = (name: string): SqlRow | undefined => {
    if (!/^[a-z_]+$/i.test(name)) throw new Error(`Invalid PRAGMA name: ${name}`);
    return raw.prepare(`PRAGMA ${name}`).get();
  };

  return {
    path,
    isMemory: memory,
    raw,
    prepare,
    exec: (sql) => raw.exec(sql),
    transaction,
    inTransaction: () => raw.isTransaction,
    isOpen: () => !closed && raw.isOpen,
    pragmaNumber(name) {
      const row = pragmaRow(name);
      if (!row) return 0;
      const v = Object.values(row)[0];
      return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0) || 0;
    },
    pragmaText(name) {
      const row = pragmaRow(name);
      if (!row) return null;
      const v = Object.values(row)[0];
      return v === null || v === undefined ? null : String(v);
    },
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      if (!raw.isOpen) return;
      try {
        raw.exec('PRAGMA optimize');
      } catch {
        // Best effort only.
      }
      raw.close();
    },
  };
}

/** Splits a list into slices of at most `size` elements. */
export function chunk<T>(items: readonly T[], size: number = MAX_IN_PARAMS): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

const placeholderCache = new Map<number, string>();

/** "?, ?, ?" for an IN list of n values. */
export function placeholders(n: number): string {
  let s = placeholderCache.get(n);
  if (s === undefined) {
    s = new Array<string>(Math.max(0, n)).fill('?').join(', ');
    if (n <= MAX_IN_PARAMS) placeholderCache.set(n, s);
  }
  return s;
}

/** Escapes LIKE wildcards for use with `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
