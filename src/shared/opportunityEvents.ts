// 0.7.3: the Live log's opportunity-event filters, shared by the page, the service's events export and
// the browser mock, so Export CSV writes what the page shows (as market.ts and holdings.ts do for
// theirs). Pure: no I/O.

import type { Category, OpportunityEvent, OpportunityEventKind } from './types';

export const OPPORTUNITY_EVENT_KINDS: readonly OpportunityEventKind[] = ['appeared', 'changed', 'gone', 'notified'];

/** Most events the events export writes, newest first: as many as the Live log keeps (MAX_KEPT_EVENTS). */
export const EVENTS_EXPORT_MAX = 5000;

/**
 * True when `e` is in `category` (none: every category) and its name, SKU or summary holds every one
 * of `tokens` (from marketSearchTokens). The kinds are filtered by the query itself.
 */
export function eventMatches(e: Pick<OpportunityEvent, 'category' | 'name' | 'sku' | 'summary'>, category: Category | '' | undefined, tokens: readonly string[]): boolean {
  if (category && e.category !== category) return false;
  if (tokens.length === 0) return true;
  const text = `${e.name} ${e.sku} ${e.summary}`.toLowerCase();
  return tokens.every((t) => text.includes(t));
}
