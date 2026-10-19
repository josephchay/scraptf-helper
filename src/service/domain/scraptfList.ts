// scrap.tf price list (F14): the user's saved copy of scrap.tf/items, held in
// memory so the Live market, Holdings, the item drawer and the key price read it
// without a database query per row. Filled only by pages the user saved with their
// own browser (importSavedPage, R10); nothing here contacts scrap.tf (R1) or adds
// any other network traffic.
//
// Reads: the table is loaded once on first use and again on refresh() (an import
// wrote rows, maintenance purged some). Rows are valued at the key price given by
// the caller, else at the engine's, read once and kept until keyPriceChanged().

import { scraptfListKeyOf, valueScraptfListRow } from '../../shared/scraptfList';
import { baseSku as toBaseSku } from '../../shared/sku';
import { KEY_SKU } from '../../shared/types';
import type { KeyPriceState, Scrap, ScraptfListKey, ScraptfListRow, ScraptfListStored } from '../../shared/types';
import type { Logger, Repo, ScraptfListSummary } from '../contracts';
import { DEFAULT_KEY_SCRAP } from './keyprice';

export interface ScraptfListCacheDeps {
  repo: Pick<Repo, 'scraptfList'>;
  log: Logger;
  /**
   * The engine's key price (engine.keyPrice). Read lazily, only to value rows for a caller that did
   * not pass its own key price, and kept until keyPriceChanged(). Never read by keyRow(), so the key
   * price may itself read keyRow() (selectKeyPrice's list key) without a cycle.
   */
  keyPrice(): KeyPriceState;
}

export interface ScraptfListCache {
  /**
   * Re-reads the table (after an import wrote list rows, or maintenance purged some), then tells the
   * onChanged listeners. Never throws: a failed read keeps the last good rows and is logged.
   */
  refresh(): void;
  /** The key price moved: rows are valued again on their next read (core's keyQuotesChanged). */
  keyPriceChanged(): void;
  /**
   * The list row for any SKU (paint dropped: the list shows plain copies), valued at `keyScrap` when
   * given (the caller's own key price, e.g. a market read), else at the engine's. Null when the list
   * has no row for it. A fresh copy each call.
   */
  rowFor(sku: string, keyScrap?: Scrap): ScraptfListRow | null;
  /** Whether the list has a row for the SKU's base, without valuing it (the market's list filter). */
  has(sku: string): boolean;
  /** Every row by SKU, valued like rowFor. */
  all(keyScrap?: Scrap): ScraptfListRow[];
  summary(): ScraptfListSummary;
  /** The key row (5021;6) raw, for selectKeyPrice; null without one (scraptfListKeyOf). */
  keyRow(): ScraptfListKey | null;
  /** Grows on every data change and key price change: read caches (the market's last pass) key on it. */
  version(): number;
  /** Called after each refresh() that read the table; returns an unsubscribe function. */
  onChanged(cb: (summary: ScraptfListSummary) => void): () => void;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function summaryOf(rows: ReadonlyMap<string, ScraptfListStored>): ScraptfListSummary {
  let newestAt: number | null = null;
  let oldestAt: number | null = null;
  const batches = new Set<number>();
  for (const r of rows.values()) {
    if (newestAt === null || r.observedAt > newestAt) newestAt = r.observedAt;
    if (oldestAt === null || r.observedAt < oldestAt) oldestAt = r.observedAt;
    batches.add(r.batchId);
  }
  return { items: rows.size, newestAt, oldestAt, batches: batches.size };
}

export function createScraptfListCache(deps: ScraptfListCacheDeps): ScraptfListCache {
  const { repo, log } = deps;
  let rows: Map<string, ScraptfListStored> | null = null;
  let stats: ScraptfListSummary = { items: 0, newestAt: null, oldestAt: null, batches: 0 };
  let failing = false;
  let ver = 0;
  /** The engine's key price as last read (null: read on next need). */
  let engineK: Scrap | null = null;
  /** Valued rows at `valuedK`; dropped when another key price is asked for. */
  let valuedK: Scrap | null = null;
  const valued = new Map<string, ScraptfListRow>();
  const listeners = new Set<(s: ScraptfListSummary) => void>();

  /** True when the read worked. A failed first read leaves an empty list (not re-read per row). */
  function load(): boolean {
    try {
      const next = new Map<string, ScraptfListStored>();
      for (const r of repo.scraptfList()) next.set(r.sku, r);
      rows = next;
      stats = summaryOf(next);
      failing = false;
      valued.clear();
      ver++;
      return true;
    } catch (err) {
      // Once per failure streak; the next refresh() tries again.
      if (!failing) log.warn('Could not read the saved scrap.tf price list', { error: String(err) });
      failing = true;
      if (rows === null) rows = new Map();
      return false;
    }
  }

  function loaded(): Map<string, ScraptfListStored> {
    if (rows === null) load();
    return rows!;
  }

  function keyFor(keyScrap: Scrap | undefined): Scrap {
    if (finite(keyScrap) && keyScrap > 0) return keyScrap;
    if (engineK === null) {
      try {
        const v = deps.keyPrice().valueScrap;
        engineK = finite(v) && v > 0 ? v : DEFAULT_KEY_SCRAP;
      } catch (err) {
        log.warn('scrap.tf price list could not read the key price', { error: String(err) });
        return DEFAULT_KEY_SCRAP;
      }
    }
    return engineK;
  }

  function valuedRow(stored: ScraptfListStored, K: Scrap): ScraptfListRow {
    if (valuedK !== K) {
      valued.clear();
      valuedK = K;
    }
    let v = valued.get(stored.sku);
    if (!v) {
      v = valueScraptfListRow(stored, K);
      valued.set(stored.sku, v);
    }
    return { ...v };
  }

  function storedFor(sku: string): ScraptfListStored | null {
    if (typeof sku !== 'string') return null;
    const map = loaded();
    if (map.size === 0) return null;
    const direct = map.get(sku);
    if (direct) return direct;
    let base: string;
    try {
      base = toBaseSku(sku.trim());
    } catch {
      return null;
    }
    return map.get(base) ?? null;
  }

  return {
    refresh() {
      if (!load()) return;
      const s = { ...stats };
      for (const cb of listeners) {
        try {
          cb(s);
        } catch (err) {
          log.warn('scrap.tf price list listener failed', { error: String(err) });
        }
      }
    },

    keyPriceChanged() {
      engineK = null;
      valued.clear();
      valuedK = null;
      ver++;
    },

    rowFor(sku, keyScrap) {
      const stored = storedFor(sku);
      return stored ? valuedRow(stored, keyFor(keyScrap)) : null;
    },

    has(sku) {
      return storedFor(sku) !== null;
    },

    all(keyScrap) {
      const map = loaded();
      if (map.size === 0) return [];
      const K = keyFor(keyScrap);
      return [...map.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)).map((r) => valuedRow(r, K));
    },

    summary() {
      loaded();
      return { ...stats };
    },

    keyRow() {
      return scraptfListKeyOf(loaded().get(KEY_SKU));
    },

    version() {
      loaded();
      return ver;
    },

    onChanged(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
