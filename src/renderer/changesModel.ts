// Pure helpers for the scrap.tf change feed (F20 U3: the Live log's "scrap.tf changes" tab, route
// #/log/changes) and the change lines the item drawer's history block shows (U1). The events come
// from 'scraptf.changes' / ScraptfItemHistory.events: each one is a difference between two saves of a
// bank page the user made with their own browser (R10), valued at today's key price and joined to the
// live backpack.tf side by the service. Nothing here loads scrap.tf (R1) and nothing opens a URL: a
// bank is named by its SCRAPTF_BANKS label and path, never by the event's own page.
//
// All pure except createChangesFeed, whose only effect is the call it is handed. 0.7.1: the feed hides
// stock moves until the user picks them (DM-6), and a superseded flip gets a muted "was a flip" (ACT-10).

import { bankStockPagePath } from '../shared/bankStock';
import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { scraptfBankInfo, SCRAPTF_BANKS } from '../shared/links';
import { SCRAPTF_CHANGES_DEFAULT_LIMIT, SCRAPTF_CHANGES_MAX_LIMIT } from '../shared/scraptfHistory';
import { SCRAPTF_BANK_IDS, SCRAPTF_CHANGE_KINDS } from '../shared/types';
import type { Scrap, ScraptfBank, ScraptfChangeEvent, ScraptfChangeKind, ScraptfChangesQuery, UnixMs } from '../shared/types';
import { DASH, errorMessage, fmtAgo, fmtDateTime, fmtInt, fmtMoney, type Tone } from './format';

/** Events per read; "Load older" reads as many again. */
export const CHANGES_PAGE = SCRAPTF_CHANGES_DEFAULT_LIMIT;
/** Most events the tab keeps in memory; Export CSV has the rest (up to the service's export cap). */
export const CHANGES_MAX_KEPT = 2000;
/**
 * Rows the table renders before "Show more" adds as many again: the table is not virtualised, and one
 * refresh after a big save can bring up to CHANGES_MAX_KEPT changes at once.
 */
export const CHANGES_SHOWN = 300;
/** The tab re-reads at most this often on 'scraptf.changed'. */
export const CHANGES_REFRESH_MS = 2_000;
/**
 * The rows shown are valued again at most this often on 'market.changed' (Sells for, Pay up to, Flip):
 * the buy side moves every few seconds, and each pass re-reads every row shown.
 */
export const CHANGES_REVALUE_MS = 20_000;

/** The Live log's tabs: opportunity events (#/log) and scrap.tf changes (#/log/changes). */
export type LogTab = 'events' | 'changes';
export const LOG_CHANGES_ROUTE = 'log/changes';
export const LOG_TABS: readonly { value: LogTab; label: string }[] = [
  { value: 'events', label: 'Opportunity events' },
  { value: 'changes', label: 'scrap.tf changes' },
];

/** The tab a route shows: #/log/changes is the feed, anything else under #/log the events. */
export function logTabOf(segments: readonly string[]): LogTab {
  return segments[0] === 'log' && segments[1] === 'changes' ? 'changes' : 'events';
}

/** Where a tab lives, for navigate(). */
export function logTabPath(tab: LogTab): string {
  return tab === 'changes' ? LOG_CHANGES_ROUTE : 'log';
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A save's local time as the spec words it: "Oct 14 09:12". */
export function fmtSaveTime(ts: UnixMs | null | undefined): string {
  if (!finite(ts)) return DASH;
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Kinds and banks
// ---------------------------------------------------------------------------

export const CHANGE_KIND_LABELS: Readonly<Record<ScraptfChangeKind, string>> = {
  new: 'New',
  restocked: 'Restocked',
  cheaper: 'Cheaper',
  pricier: 'Pricier',
  gone: 'Gone',
  stock: 'Stock',
};

export const CHANGE_KIND_HELP: Readonly<Record<ScraptfChangeKind, string>> = {
  new: 'On sale in this save, and in none of your earlier saves of the bank.',
  restocked: 'Back on sale: an earlier save listed it sold out, without a price, or not at all after it had been on sale.',
  cheaper: 'On sale in both saves of the page, cheaper in this one.',
  pricier: 'On sale in both saves of the page, pricier in this one.',
  gone: 'On sale in the previous save of the page, not in this one: sold, sold out or taken off.',
  stock: 'Same price in both saves, another stock count.',
};

/** Cheaper and new are good for a buyer; pricier is bad; gone and a stock count are only news. */
export const CHANGE_KIND_TONES: Readonly<Record<ScraptfChangeKind, Tone>> = {
  new: 'good',
  restocked: 'info',
  cheaper: 'good',
  pricier: 'bad',
  gone: 'muted',
  stock: 'muted',
};

/** The feed's chips, in the shared order. */
export const CHANGE_KIND_OPTIONS: readonly { value: ScraptfChangeKind; label: string; title: string }[] = SCRAPTF_CHANGE_KINDS.map((k) => ({
  value: k,
  label: CHANGE_KIND_LABELS[k],
  title: CHANGE_KIND_HELP[k],
}));

/** A bank's label and path from SCRAPTF_BANKS ("Hats", "scrap.tf/buy/hats"); the bank id for one it does not know. */
export function changeBankText(bank: ScraptfBank): { label: string; path: string } {
  const info = scraptfBankInfo(bank);
  return info ? { label: info.label, path: bankStockPagePath(info.url) } : { label: String(bank), path: String(bank) };
}

// ---------------------------------------------------------------------------
// The view the user picks: bank and kinds, remembered
// ---------------------------------------------------------------------------

export interface ChangesView {
  /** '' = every bank. */
  bank: ScraptfBank | '';
  /** [] = every kind. */
  kinds: ScraptfChangeKind[];
}

/**
 * DM-6: the kinds the tab shows until the user picks others: every kind but 'stock', so a run of stock
 * moves (same price, another count) never pushes the price changes out of view.
 */
export const DEFAULT_CHANGE_KINDS: readonly ScraptfChangeKind[] = Object.freeze(SCRAPTF_CHANGE_KINDS.filter((k) => k !== 'stock'));

export const DEFAULT_CHANGES_VIEW: Readonly<ChangesView> = Object.freeze<ChangesView>({ bank: '', kinds: [...DEFAULT_CHANGE_KINDS] });

/**
 * usePersistentState key of the tab's filters. 0.7.1 (DM-6): a new key, because 0.7.0 wrote its default
 * ({ kinds: [] }, every kind) under CHANGES_LEGACY_PREF_KEY on the tab's first render, and kept as a
 * choice it would keep stock moves on screen for everyone who ever opened the tab.
 */
export const CHANGES_PREF_KEY = 'log.scraptfChanges.v2';
/** The 0.7.0 key, read once to carry its bank and a real choice of kinds over (changesViewFromLegacy). */
export const CHANGES_LEGACY_PREF_KEY = 'log.scraptfChanges';

/**
 * DM-6: the tab's starting view while CHANGES_PREF_KEY holds nothing, from what 0.7.0 kept. Its empty
 * kinds were the default, not a choice: they get DEFAULT_CHANGE_KINDS. A bank and picked kinds stay.
 */
export function changesViewFromLegacy(v: unknown): ChangesView {
  const o = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const kinds = o['kinds'];
  return sanitizeChangesView({ bank: o['bank'], kinds: Array.isArray(kinds) && kinds.length > 0 ? kinds : undefined });
}

/**
 * The saved view, from storage that may hold anything: known values only, each once, in the shared order.
 * A saved choice of kinds is kept as it is ([] = every kind, "Show every change"); a view without one, or
 * one whose kinds are all unknown, gets DEFAULT_CHANGE_KINDS.
 */
export function sanitizeChangesView(v: unknown): ChangesView {
  const o = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const bank = SCRAPTF_BANK_IDS.find((b) => b === o['bank']) ?? '';
  const saved = o['kinds'];
  if (!Array.isArray(saved)) return { bank, kinds: [...DEFAULT_CHANGE_KINDS] };
  const raw = new Set<unknown>(saved);
  // Every kind ticked stays ticked on the chips; the query leaves such a filter out (changesQueryOf).
  const kinds = SCRAPTF_CHANGE_KINDS.filter((k) => raw.has(k));
  return { bank, kinds: saved.length > 0 && kinds.length === 0 ? [...DEFAULT_CHANGE_KINDS] : kinds };
}

/** The view's kinds are the default ones (every kind but stock moves): no filter of the user's. */
export function changesKindsAreDefault(kinds: readonly ScraptfChangeKind[]): boolean {
  return kinds.length === DEFAULT_CHANGE_KINDS.length && DEFAULT_CHANGE_KINDS.every((k) => kinds.includes(k));
}

/** 'scraptf.changes' params for the view: the newest `limit` (1..500), or those older than `beforeId`. */
export function changesQueryOf(view: ChangesView, beforeId?: number, limit: number = CHANGES_PAGE): ScraptfChangesQuery {
  const q: ScraptfChangesQuery = {};
  if (view.bank) q.bank = view.bank;
  const kinds = SCRAPTF_CHANGE_KINDS.filter((k) => view.kinds.includes(k));
  if (kinds.length > 0 && kinds.length < SCRAPTF_CHANGE_KINDS.length) q.kinds = kinds;
  if (finite(beforeId) && beforeId >= 1) q.beforeId = Math.floor(beforeId);
  q.limit = finite(limit) ? Math.min(SCRAPTF_CHANGES_MAX_LIMIT, Math.max(1, Math.floor(limit))) : CHANGES_PAGE;
  return q;
}

/** The CSV export's query: the same filters, paging dropped (the service caps the file, newest first). */
export function changesExportQuery(view: ChangesView): ScraptfChangesQuery {
  const { beforeId: _beforeId, limit: _limit, ...rest } = changesQueryOf(view);
  return rest;
}

/** Identifies what the list answers apart from paging. */
export function changesViewKey(view: ChangesView): string {
  return JSON.stringify(changesExportQuery(view));
}

export function changesFilterCount(view: ChangesView): number {
  return (view.bank ? 1 : 0) + (changesQueryOf(view).kinds ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Merging and paging (ids grow with every write, so they order the feed)
// ---------------------------------------------------------------------------

/** Merges by id, newest first, keeping at most `max`; a later copy of an id (valued again) wins. */
export function mergeChanges<T extends { id: number }>(a: readonly T[], b: readonly T[], max = CHANGES_MAX_KEPT): T[] {
  return mergeChangesTrimmed(a, b, max).list;
}

/**
 * mergeChanges, telling whether the cap cut older events off (`dropped`): they still exist in the feed,
 * so "Load older" stays possible. Counted over distinct ids, as a refresh re-reads events already shown.
 */
export function mergeChangesTrimmed<T extends { id: number }>(a: readonly T[], b: readonly T[], max = CHANGES_MAX_KEPT): { list: T[]; dropped: boolean } {
  const map = new Map<number, T>();
  for (const e of a) map.set(e.id, e);
  for (const e of b) map.set(e.id, e);
  const cap = Math.max(0, max);
  return { list: [...map.values()].sort((x, y) => y.id - x.id).slice(0, cap), dropped: map.size > cap };
}

/** How many older events "Load older" may ask for: what still fits under the cap (0: the list is full). */
export function olderChangesLimit(kept: number, page: number = CHANGES_PAGE, max: number = CHANGES_MAX_KEPT): number {
  return Math.max(0, Math.min(page, max - kept));
}

/**
 * Every event above `knownId`, newest first, paging back by id: one import can write more changes than
 * a page holds (a whole bank page re-priced). `complete` is false when more than `maxKept` arrived:
 * `fresh` is then only the newest and must replace the list (merging would leave a hole). `read` is
 * every event the pages held, the known ones of the last page included: merged, it values them again.
 */
export async function fetchChangesAfter<T extends { id: number }>(
  fetchPage: (beforeId: number | undefined) => Promise<readonly T[]>,
  knownId: number,
  pageSize: number = CHANGES_PAGE,
  maxKept: number = CHANGES_MAX_KEPT,
): Promise<{ fresh: T[]; read: T[]; complete: boolean }> {
  const fresh: T[] = [];
  const read: T[] = [];
  const maxPages = Math.max(1, Math.ceil(maxKept / Math.max(1, pageSize)));
  let beforeId: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const list = await fetchPage(beforeId);
    const newer = list.filter((e) => e.id > knownId);
    fresh.push(...newer);
    read.push(...list);
    if (list.length < pageSize || newer.length < list.length) return { fresh: mergeChanges([], fresh, maxKept), read: mergeChanges([], read, maxKept), complete: true };
    beforeId = list.reduce((m, e) => Math.min(m, e.id), Number.POSITIVE_INFINITY);
  }
  const all = mergeChanges([], fresh, maxKept);
  return { fresh: all, read: all, complete: false };
}

export interface ChangesFeedState {
  events: ScraptfChangeEvent[];
  /** The first read of this view is in flight (no events shown yet). */
  loading: boolean;
  /** "Load older" is in flight. */
  loadingOlder: boolean;
  /** An older page may exist (the last read filled its page). */
  hasMore: boolean;
  /** The first read failed (nothing to show). */
  error: string | null;
  /** The last refresh after a push failed; the events shown are kept. */
  stale: boolean;
}

export interface ChangesFeed {
  /** Reads the newest page of `view`: an answer to an earlier view is dropped. */
  load(view: ChangesView): void;
  /** Reads what arrived since the newest event shown (a push), once after a read in flight. */
  refresh(): void;
  /** "Load older": the page before the oldest event shown, up to the cap. */
  older(): void;
  /**
   * Values the newest `count` events shown again (Sells for, Pay up to, Flip) when the live buy side
   * moved ('market.changed'): reads only ids up to the newest one shown, so it adds nothing, and puts
   * each answer in place of its event. One at a time; a call while one is in flight runs once after it.
   */
  revalue(count: number): void;
  dispose(): void;
}

/** What a read values now: the same event with the same values is kept as it was (the row stays memoised). */
function sameValues(a: ScraptfChangeEvent, b: ScraptfChangeEvent): boolean {
  return (
    a.fromValueScrap === b.fromValueScrap &&
    a.toValueScrap === b.toValueScrap &&
    a.deltaScrap === b.deltaScrap &&
    a.pct === b.pct &&
    a.revenueScrap === b.revenueScrap &&
    a.maxCostScrap === b.maxCostScrap &&
    a.flip === b.flip &&
    // 0.7.3: what the hovers say of a null revenue (noRevenueWhy).
    noRevenueWhy(a) === noRevenueWhy(b) &&
    a.buyerCount === b.buyerCount
  );
}

/**
 * The feed's reads for the "scrap.tf changes" tab. A refresh never overlaps another (a burst of pushes
 * costs at most two reads) and merges what it finds over the list, so the newest page is valued again;
 * an answer to a view the user has since left is dropped. `onOlderError` reports a failed "Load older"
 * (the list stays as it was).
 */
export function createChangesFeed(
  call: (q: ScraptfChangesQuery) => Promise<ScraptfChangeEvent[]>,
  onState: (s: ChangesFeedState) => void,
  opts: { page?: number; maxKept?: number; onOlderError?(message: string): void } = {},
): ChangesFeed {
  const page = finite(opts.page) ? Math.max(1, Math.floor(opts.page)) : CHANGES_PAGE;
  const maxKept = finite(opts.maxKept) ? Math.max(page, Math.floor(opts.maxKept)) : CHANGES_MAX_KEPT;
  let view: ChangesView | null = null;
  let gen = 0;
  let disposed = false;
  let refreshing = false;
  let again = false;
  let state: ChangesFeedState = { events: [], loading: true, loadingOlder: false, hasMore: false, error: null, stale: false };
  const set = (patch: Partial<ChangesFeedState>): void => {
    state = { ...state, ...patch };
    if (!disposed) onState(state);
  };
  const safeCall = (q: ScraptfChangesQuery): Promise<ScraptfChangeEvent[]> => {
    try {
      return Promise.resolve(call(q)).then((r) => (Array.isArray(r) ? r : []));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  const runRefresh = (): void => {
    const v = view;
    if (!v || disposed) return;
    const g = gen;
    refreshing = true;
    again = false;
    const known = state.events[0]?.id ?? 0;
    fetchChangesAfter((beforeId) => safeCall(changesQueryOf(v, beforeId, page)), known, page, maxKept)
      .then(
        ({ fresh, read, complete }) => {
          if (disposed || g !== gen) return;
          if (!complete) set({ events: fresh, hasMore: true, stale: false });
          else {
            // The cap may cut the oldest off: they are still in the feed, so older ones exist again.
            const m = mergeChangesTrimmed(state.events, read, maxKept);
            set({ events: m.list, hasMore: state.hasMore || m.dropped, stale: false });
          }
        },
        () => {
          if (!disposed && g === gen) set({ stale: true });
        },
      )
      .finally(() => {
        refreshing = false;
        if (disposed) return;
        if (again) runRefresh();
      });
  };

  let revaluing = false;
  let revalueAgain: number | null = null;

  const runRevalue = (count: number): void => {
    const v = view;
    if (!v || disposed || state.loading || state.events.length === 0) return;
    const n = Math.min(state.events.length, finite(count) ? Math.max(1, Math.floor(count)) : page);
    const top = state.events[0]!.id;
    const g = gen;
    revaluing = true;
    revalueAgain = null;
    // From the newest event shown down (never above it: new events are refresh's), page by page.
    const readShown = async (): Promise<ScraptfChangeEvent[]> => {
      const out: ScraptfChangeEvent[] = [];
      let beforeId = top + 1;
      while (out.length < n) {
        const limit = Math.min(SCRAPTF_CHANGES_MAX_LIMIT, n - out.length);
        const list = await safeCall(changesQueryOf(v, beforeId, limit));
        out.push(...list);
        if (list.length < limit) break;
        beforeId = list.reduce((m, e) => Math.min(m, e.id), beforeId);
      }
      return out;
    };
    readShown()
      .then(
        (read) => {
          if (disposed || g !== gen) return;
          const byId = new Map(read.map((e) => [e.id, e]));
          let changed = false;
          const events = state.events.map((e) => {
            const next = byId.get(e.id);
            if (!next || sameValues(e, next)) return e;
            changed = true;
            return next;
          });
          if (changed) set({ events });
        },
        // A failed read keeps the values shown; the next move of the market tries again.
        () => undefined,
      )
      .finally(() => {
        revaluing = false;
        if (disposed) return;
        const again = revalueAgain;
        revalueAgain = null;
        if (again !== null) runRevalue(again);
      });
  };

  const load = (next: ChangesView): void => {
    if (disposed) return;
    view = next;
    const g = ++gen;
    again = false;
    set({ events: [], loading: true, loadingOlder: false, hasMore: false, error: null, stale: false });
    safeCall(changesQueryOf(next, undefined, page)).then(
      (list) => {
        if (disposed || g !== gen) return;
        set({ events: mergeChanges([], list, maxKept), loading: false, hasMore: list.length >= page, error: null });
      },
      (e: unknown) => {
        if (!disposed && g === gen) set({ loading: false, error: errorMessage(e) });
      },
    );
  };

  return {
    load,
    refresh() {
      if (disposed || !view) return;
      // The first read already answers with the newest; a push before it lands needs no second read.
      if (state.loading) return;
      // A failed first read left nothing to build on (paging back from id 0 would read up to the cap
      // and leave the error up): read the first page again.
      if (state.error !== null && state.events.length === 0) {
        load(view);
        return;
      }
      if (refreshing) {
        again = true;
        return;
      }
      runRefresh();
    },
    older() {
      const v = view;
      if (disposed || !v || state.loading || state.loadingOlder || !state.hasMore) return;
      const oldest = state.events[state.events.length - 1];
      const limit = olderChangesLimit(state.events.length, page, maxKept);
      if (!oldest || limit === 0) return;
      const g = gen;
      set({ loadingOlder: true });
      safeCall(changesQueryOf(v, oldest.id, limit)).then(
        (list) => {
          if (disposed || g !== gen) return;
          // A refresh that landed meanwhile can make the merge go over the cap: what it cut is older still.
          const m = mergeChangesTrimmed(state.events, list, maxKept);
          set({ events: m.list, loadingOlder: false, hasMore: list.length >= limit || m.dropped });
        },
        (e: unknown) => {
          if (disposed || g !== gen) return;
          set({ loadingOlder: false });
          opts.onOlderError?.(errorMessage(e));
        },
      );
    },
    revalue(count) {
      if (disposed || !view) return;
      if (revaluing) {
        revalueAgain = count;
        return;
      }
      runRevalue(count);
    },
    dispose() {
      disposed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Text of one change
// ---------------------------------------------------------------------------

const MINUS = '−';

/**
 * A price move as a percentage, "−8 %" / "+5 %" / "0 %": whole percents from 1 % up, one decimal
 * below (so a small move never reads "−0 %"). Null without a percentage.
 */
export function changePctText(pct: number | null | undefined): string | null {
  if (!finite(pct)) return null;
  const p = pct * 100;
  const abs = Math.abs(p);
  if (abs < 0.05) return '0 %';
  const n = abs >= 1 ? Math.round(abs).toString() : abs.toFixed(1);
  return `${p < 0 ? MINUS : '+'}${n} %`;
}

/** "1.33 → 1.22 ref": the unit once when both sides are plain refined; full prices otherwise. */
export function fromToText(fromScrap: Scrap, toScrap: Scrap, keyScrap: Scrap | null): string {
  const from = fmtMoney(fromScrap, keyScrap);
  const to = fmtMoney(toScrap, keyScrap);
  const plain = (s: string) => s.endsWith(' ref') && !s.includes('key');
  return plain(from) && plain(to) ? `${from.slice(0, -4)} → ${to}` : `${from} → ${to}`;
}

export interface ChangePriceText {
  /** "1.33 → 1.22 ref (−8 %)", "1.33 ref", "was 1.33 ref", or "—". */
  text: string;
  tone: Tone;
  title: string;
}

/** The price side of a change, valued at today's key price as the service sent it. */
export function changePriceText(e: Pick<ScraptfChangeEvent, 'kind' | 'fromValueScrap' | 'toValueScrap' | 'deltaScrap' | 'pct'>, keyScrap: Scrap | null): ChangePriceText {
  const from = finite(e.fromValueScrap) ? e.fromValueScrap : null;
  const to = finite(e.toValueScrap) ? e.toValueScrap : null;
  const atKey = ' (both at today’s key price)';
  // A gone row may still be listed sold out at a price: that price is its last one, not a current one.
  if (e.kind === 'gone') {
    const last = from ?? to;
    return last !== null
      ? { text: `was ${fmtMoney(last, keyScrap)}`, tone: 'muted', title: `Its last price on sale, in the previous save: ${fmtMoney(last, keyScrap)} at today's key price.` }
      : { text: DASH, tone: 'muted', title: 'Neither save showed a price to buy.' };
  }
  if (from !== null && to !== null && (finite(e.deltaScrap) ? e.deltaScrap !== 0 : from !== to)) {
    const delta = finite(e.deltaScrap) ? e.deltaScrap : to - from;
    const pct = changePctText(e.pct);
    return {
      text: `${fromToText(from, to, keyScrap)}${pct ? ` (${pct})` : ''}`,
      tone: delta < 0 ? 'good' : 'bad',
      title: `${fmtMoney(from, keyScrap)} in the previous save, ${fmtMoney(to, keyScrap)} in this one: ${delta < 0 ? 'cheaper' : 'pricier'} by ${fmtMoney(Math.abs(delta), keyScrap)}${atKey}.`,
    };
  }
  if (to !== null) return { text: fmtMoney(to, keyScrap), tone: 'muted', title: `scrap.tf's price in this save: ${fmtMoney(to, keyScrap)} at today's key price.` };
  if (from !== null) return { text: `was ${fmtMoney(from, keyScrap)}`, tone: 'muted', title: `Its last price, in the previous save: ${fmtMoney(from, keyScrap)} at today's key price.` };
  return { text: DASH, tone: 'muted', title: 'Neither save showed a price to buy.' };
}

/** "stock 5 → 3", "3 in stock", "sold out", or null when the saves showed no count worth saying. */
export function changeStockText(e: Pick<ScraptfChangeEvent, 'kind' | 'fromStock' | 'toStock'>): string | null {
  const from = finite(e.fromStock) ? e.fromStock : null;
  const to = finite(e.toStock) ? e.toStock : null;
  if (from !== null && to !== null && from !== to) return `stock ${fmtInt(from)} → ${fmtInt(to)}`;
  if (e.kind === 'gone') return to === 0 ? 'sold out' : null;
  return to !== null ? `${fmtInt(to)} in stock` : null;
}

/** One line of a change for the drawer: "Cheaper: 1.33 → 1.22 ref (−8 %), stock 5 → 3". */
export function changeSummary(e: ScraptfChangeEvent, keyScrap: Scrap | null): string {
  const price = changePriceText(e, keyScrap).text;
  const stock = changeStockText(e);
  if (e.kind === 'stock') return `${CHANGE_KIND_LABELS.stock}: ${stock ?? 'count changed'}${price !== DASH ? `, ${price}` : ''}`;
  return `${CHANGE_KIND_LABELS[e.kind] ?? e.kind}: ${price}${stock ? `, ${stock}` : ''}`;
}

export interface ChangeRowView {
  /** "Oct 14 09:12" (the save's time). */
  time: string;
  timeTitle: string;
  bank: { label: string; path: string };
  kind: { label: string; tone: Tone; title: string };
  price: ChangePriceText;
  stock: string | null;
  /** Live Sells for and Pay up to of the base SKU (a clean copy). */
  sellsScrap: Scrap | null;
  payScrap: Scrap | null;
  sellsTitle: string;
  payTitle: string;
  /** The Flip pill: the new price is at or under Pay up to now. */
  flip: { text: string; title: string } | null;
  /** ACT-10: the muted "was a flip" pill (ScraptfChangeEvent.wasFlip): a later save superseded it. */
  wasFlip: { text: string; title: string } | null;
  extrasTitle: string | null;
}

/** Everything one feed row shows, from the event alone (the bank's words come from SCRAPTF_BANKS). */
export function changeRowView(e: ScraptfChangeEvent, keyScrap: Scrap | null, now: UnixMs): ChangeRowView {
  const bank = changeBankText(e.bank);
  const sells = finite(e.revenueScrap) ? e.revenueScrap : null;
  const pay = finite(e.maxCostScrap) ? e.maxCostScrap : null;
  const to = finite(e.toValueScrap) ? e.toValueScrap : null;
  const extras = e.hasExtras ? 'This copy has extras (paint, spells, parts or a tag): Sells for and Pay up to are for a clean copy.' : null;
  let flip: ChangeRowView['flip'] = null;
  if (e.flip && to !== null && pay !== null) {
    const under = pay - to;
    flip = {
      text: 'Flip',
      title: `${fmtMoney(to, keyScrap)} is ${under === 0 ? 'right at' : `${fmtMoney(under, keyScrap)} under`} Pay up to (${fmtMoney(pay, keyScrap)}) against today's backpack.tf buyers.${e.hasExtras ? ' Judged as a clean copy.' : ''} Check scrap.tf still has it: this is from your save ${fmtAgo(Math.min(e.at, now), now)}.`,
    };
  }
  // A flip a later event of the same copy superseded (or the copy is no longer on sale): said, but muted.
  const wasFlip: ChangeRowView['wasFlip'] =
    flip === null && e.wasFlip === true
      ? {
          text: 'was a flip',
          title: `A flip at this price against today's buyers, but a later save of ${bank.path} changed this copy again or no longer lists it on sale. Its newest change says where it stands now.`,
        }
      : null;
  return {
    time: fmtSaveTime(e.at),
    // A sub-page (/items/2) is named as text only; a file without a scrap.tf address has no path to name.
    timeTitle: `Your save of ${bank.path}${typeof e.page === 'string' && e.page.startsWith('/') && e.page !== bankPathOnly(bank.path) ? ` (page ${e.page})` : ''}: ${fmtDateTime(e.at)} (${fmtAgo(Math.min(e.at, now), now)}), compared with your previous save of that page.`,
    bank,
    kind: { label: CHANGE_KIND_LABELS[e.kind] ?? e.kind, tone: CHANGE_KIND_TONES[e.kind] ?? 'muted', title: CHANGE_KIND_HELP[e.kind] ?? '' },
    price: changePriceText(e, keyScrap),
    stock: changeStockText(e),
    sellsScrap: sells,
    payScrap: pay,
    sellsTitle: sells !== null ? `Sells for ${fmtMoney(sells, keyScrap)} on backpack.tf now (a clean copy).` : noSellsTitle(e),
    payTitle:
      pay !== null
        ? `Pay up to ${fmtMoney(pay, keyScrap)} on scrap.tf: the most that still clears your profit thresholds against today's buyers.`
        : sells !== null
          ? 'No scrap.tf price clears your thresholds against these buyers.'
          : noPayTitle(e),
    flip,
    wasFlip,
    extrasTitle: extras,
  };
}

/**
 * 0.7.3: why an event's live revenue is null, as marketModel's noRevenueReason reads a market row: no
 * eligible buyer, or buyers none of which is usable. Conservative is null only when every eligible order is
 * an outlier, which the entry flags 'all-outliers'; Best never is with buyers, so the rest is Instant
 * without a realistic bot order. null: there is a revenue, or the buyers are not known (an older service).
 */
function noRevenueWhy(e: Pick<ScraptfChangeEvent, 'revenueScrap' | 'buyerCount' | 'flags'>): 'none' | 'all-outliers' | 'no-bot' | null {
  if (finite(e.revenueScrap) || !finite(e.buyerCount)) return null;
  if (!(e.buyerCount > 0)) return 'none';
  return e.flags?.includes('all-outliers') ? 'all-outliers' : 'no-bot';
}

/** Sells for without a revenue: no eligible buyer, or (0.7.3) why the buyers there are give none (as the bank stock page). */
function noSellsTitle(e: ScraptfChangeEvent): string {
  const why = noRevenueWhy(e);
  if (why === 'all-outliers') return 'Every eligible order looks unrealistic, so no sale price is assumed.';
  if (why === 'no-bot') {
    const n = e.buyerCount ?? 0;
    return `${fmtInt(n)} ${n === 1 ? 'buyer' : 'buyers'} with eligible orders, but no realistic bot order, and Revenue used for profit is Instant (bot orders only), so no sale price is assumed.`;
  }
  return 'No eligible backpack.tf buy order for this item right now.';
}

/** Pay up to without a revenue: no ceiling, and (0.7.3) why, as the Live market's Pay up to hover. */
function noPayTitle(e: ScraptfChangeEvent): string {
  const why = noRevenueWhy(e);
  if (why === 'all-outliers') return 'Every eligible order looks unrealistic, so there is no ceiling.';
  if (why === 'no-bot') return 'No realistic bot order, and Revenue used for profit is Instant (bot orders only), so there is no ceiling.';
  return 'No eligible buy orders, so there is no ceiling.';
}

/** "/buy/hats" out of "scrap.tf/buy/hats", to tell a sub-page (/items/2) apart from the bank's own. */
function bankPathOnly(path: string): string {
  const at = path.indexOf('/');
  return at >= 0 ? path.slice(at) : path;
}

/**
 * The empty list: nothing saved twice yet, or nothing under these filters. The default kinds (every kind
 * but stock moves) are no filter of the user's: with no bank either, the list is simply empty.
 */
export function changesEmptyText(view: ChangesView): { title: string; body: string; filtered: boolean } {
  if (view.bank !== '' || (changesFilterCount(view) > 0 && !changesKindsAreDefault(view.kinds))) {
    const bank = view.bank ? changeBankText(view.bank).path : null;
    return {
      title: 'No changes match these filters',
      body: `${bank ? `Nothing ${view.kinds.length ? 'of these kinds ' : ''}changed on ${bank} between your saves.` : 'None of your saves changed in these ways.'} Show every change to see the rest.`,
      filtered: true,
    };
  }
  return {
    title: 'No scrap.tf changes yet',
    body: `Changes appear when you save a scrap.tf bank page again: each save is compared with your previous save of that page (new, gone, cheaper, pricier, restocked; stock moves show when you tick Stock). A first save of a page has nothing to compare with. ${SCRAPTF_BOUNDARY_SHORT}`,
    filtered: false,
  };
}

/** "Every bank" and the SCRAPTF_BANKS labels, for the bank picker. */
export const CHANGE_BANK_OPTIONS: readonly { value: ScraptfBank | ''; label: string }[] = [{ value: '', label: 'Every bank' }, ...SCRAPTF_BANKS.map((b) => ({ value: b.bank, label: b.label }))];
