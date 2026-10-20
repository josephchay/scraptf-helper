// Live-log paging helpers (pure, so they are testable without a DOM).

import { MARKET_MAX_SEARCH_CHARS } from '../shared/market';
import type { Category, EventsExportQuery, OpportunityEvent, OpportunityEventKind } from '../shared/types';

/** Most events the live log keeps in memory. */
export const MAX_KEPT_EVENTS = 5000;

/** Merges by id, newest first, keeping at most `max`. */
export function mergeEvents(a: readonly OpportunityEvent[], b: readonly OpportunityEvent[], max = MAX_KEPT_EVENTS): OpportunityEvent[] {
  const map = new Map<number, OpportunityEvent>();
  for (const e of a) map.set(e.id, e);
  for (const e of b) map.set(e.id, e);
  return [...map.values()].sort((x, y) => y.id - x.id).slice(0, max);
}

/**
 * How many older events "Load older" may request: what still fits under the
 * cap. mergeEvents keeps the newest, so a page fetched into a full list would
 * be dropped again at once. 0 means the list is full.
 */
export function olderPageLimit(kept: number, page: number, max = MAX_KEPT_EVENTS): number {
  return Math.max(0, Math.min(page, max - kept));
}

export interface NewEvents {
  /** Every event newer than the known id, newest first (at most `maxKept`). */
  fresh: OpportunityEvent[];
  /**
   * False when more than `maxKept` events arrived: `fresh` then holds only the
   * newest ones, so it must replace the list rather than be merged into it
   * (merging would leave a hole that "Load older" never fills).
   */
  complete: boolean;
}

/**
 * Fetches every event with an id above `knownId`, paging backwards by id like
 * the service's own log writer. The service answers newest first with a limit,
 * so a single "newest N" request silently skips events once more than N
 * arrive between two fetches.
 */
export async function fetchEventsAfter(
  fetchPage: (beforeId: number | undefined) => Promise<OpportunityEvent[]>,
  knownId: number,
  pageSize: number,
  maxKept = MAX_KEPT_EVENTS,
): Promise<NewEvents> {
  const fresh: OpportunityEvent[] = [];
  const maxPages = Math.max(1, Math.ceil(maxKept / pageSize));
  let beforeId: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const list = await fetchPage(beforeId);
    const newer = list.filter((e) => e.id > knownId);
    fresh.push(...newer);
    if (list.length < pageSize || newer.length < list.length) return { fresh: mergeEvents([], fresh, maxKept), complete: true };
    beforeId = list.reduce((m, e) => Math.min(m, e.id), Number.POSITIVE_INFINITY);
  }
  return { fresh: mergeEvents([], fresh, maxKept), complete: false };
}

/**
 * 0.7.3: Export CSV's filters for the Live log's events view: its kinds (none: every kind), category and
 * search, each left out when it does not filter. The search is cut at MARKET_MAX_SEARCH_CHARS (what the
 * page matches on, so a long paste is not refused) before it is trimmed.
 */
export function eventsExportQuery(kinds: readonly OpportunityEventKind[], category: Category | '', search: string): EventsExportQuery {
  const out: EventsExportQuery = {};
  if (kinds.length) out.kinds = [...new Set(kinds)];
  if (category) out.category = category;
  const s = search.slice(0, MARKET_MAX_SEARCH_CHARS).trim();
  if (s) out.search = s;
  return out;
}
