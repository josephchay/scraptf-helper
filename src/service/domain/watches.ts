// 0.8 (G1): the user's scrap.tf watches in memory, for the bank stock rows' join, the S3 notifier, the engine's profit
// bar, core's watch list and (H1) holding_marks. At most WATCHES_MAX rows, read once and again after a write
// ('watches.upsert', 'watches.delete': core's watchesChanged). Local only; nothing is fetched (R1).

import type { ScraptfWatch, UnixMs } from '../../shared/types';
import { EMPTY_WATCH_INDEX, watchIndexOf, type ScraptfWatchIndex } from '../../shared/watches';
import type { Clock, Logger, Repo } from '../contracts';
import { BANK_STOCK_RETRY_MS } from './bankStock';

export interface WatchCacheDeps {
  repo: Pick<Repo, 'listWatches'>;
  log: Logger;
  /** Times the retry after a failed read; omitted: Date.now. */
  clock?: Clock;
}

export interface WatchCache {
  /** Every watch (paused ones too), by id. Never throws: a failed read keeps the last good list (empty at first), retried at most every BANK_STOCK_RETRY_MS. */
  all(): readonly ScraptfWatch[];
  /** The enabled watches by base (watchIndexOf), rebuilt with all(). */
  index(): ScraptfWatchIndex;
  /** Bases with an enabled watch: core.watchedSet and H1's recorder. */
  bases(): ReadonlySet<string>;
  /** The next read goes to the repo again. */
  invalidate(): void;
}

const NO_BASES: ReadonlySet<string> = new Set();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The watch cache: the repo is read on first use and again after invalidate(), never per row or per call. A failed
 * read keeps the last good watches (none at first), is logged once per failure streak and retried at most every
 * BANK_STOCK_RETRY_MS, so a broken database never turns the per-row joins into a burst of queries.
 */
export function createWatchCache(deps: WatchCacheDeps): WatchCache {
  let list: readonly ScraptfWatch[] = [];
  let index: ScraptfWatchIndex = EMPTY_WATCH_INDEX;
  let bases: ReadonlySet<string> = NO_BASES;
  let stale = true;
  let failing = false;
  /** While failing: no read retries before this (invalidate() does). */
  let retryAt: UnixMs | null = null;

  function now(): UnixMs {
    try {
      return deps.clock ? deps.clock.now() : Date.now();
    } catch {
      return Date.now();
    }
  }

  function ensure(): void {
    if (!stale) return;
    if (retryAt !== null && now() < retryAt) return;
    try {
      const rows = deps.repo.listWatches();
      list = Array.isArray(rows) ? rows : [];
      index = watchIndexOf(list);
      bases = new Set(index.keys());
      stale = false;
      failing = false;
      retryAt = null;
    } catch (err) {
      if (!failing) deps.log.warn('Could not read your scrap.tf watches', { error: errorText(err) });
      failing = true;
      retryAt = now() + BANK_STOCK_RETRY_MS;
    }
  }

  return {
    all() {
      ensure();
      return list;
    },
    index() {
      ensure();
      return index;
    },
    bases() {
      ensure();
      return bases;
    },
    invalidate() {
      stale = true;
      retryAt = null;
    },
  };
}
