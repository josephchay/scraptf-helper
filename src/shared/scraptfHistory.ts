// scrap.tf history (F20) rules shared by the service's history index, the browser mock and the
// dashboard, so all three derive change events, time listed and item history from the user's saves
// the same way (as bankStock.ts does for F17). Pure: no I/O, no network. Every input is a page the
// user saved from their own browser (R10); nothing here fetches or builds a scrap.tf URL (R1). The
// one URL this module hands out (a reminder's openUrl) is a SCRAPTF_BANKS entry, never item data.
//
// Matching and the new / gone / cheaper / pricier rules are F17's (diffBankStock, bankStockOnSale);
// this module only adds 'restocked' and 'stock' and reads a sequence of saves instead of a pair.
//
// 0.8 (T1, LC-3, LC-5): the per-bank lifecycle (scraptfLifecycleOf), one walk over a bank's retained saves
// giving every copy's price states, listing runs and the bank's asset-id stability, and the one restock
// rule (scraptfSeenBefore, scraptfIsRestock). scraptfTiming.ts estimates from the lifecycle.

import {
  BANK_STOCK_PLAIN_KEY,
  BANK_STOCK_SESSION_GAP_MS,
  SCRAPTF_LONG_LISTED_MS,
  bankStockIsOwnCopy,
  bankStockKey,
  bankStockListFamily,
  bankStockOnSale,
  bankStockPagePath,
  bankStockTargetOf,
  diffBankStock,
  scraptfPriceChange,
  type BankStockDiffRow,
} from './bankStock';
import { formatScrap, valueScrap } from './currency';
import { scraptfBankInfo } from './links';
import { fromObject, fromString, isValidSku } from './sku';
import type {
  BankStockStored,
  KeyPriceState,
  NewScraptfEvent,
  Scrap,
  ScraptfAssetStability,
  ScraptfBank,
  ScraptfChangeEvent,
  ScraptfChangeKind,
  ScraptfEventStored,
  ScraptfHistoryPoint,
  ScraptfItemHistory,
  ScraptfKeyRun,
  ScraptfListingRun,
  ScraptfPriceChange,
  ScraptfWindowSettings,
  UnixMs,
} from './types';

export { SCRAPTF_LONG_LISTED_MS, scraptfPriceChange };

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** S2 retention: change events older than this are pruned (Repo.pruneScraptfEvents, maintenance). */
export const SCRAPTF_EVENTS_MAX_AGE_MS = 90 * DAY_MS;
/** S4 'scraptf.changes' paging: default and largest page. */
export const SCRAPTF_CHANGES_DEFAULT_LIMIT = 100;
export const SCRAPTF_CHANGES_MAX_LIMIT = 500;
/** opps.exportCsv kind 'scraptfChanges': at most this many events, newest first. */
export const SCRAPTF_CHANGES_EXPORT_MAX = 5000;
/** S3: ScraptfItemHistory.events holds at most this many price events (every kind but 'stock'), newest first. */
export const SCRAPTF_ITEM_EVENTS = 50;
/**
 * 0.7.1 (DM-6): and, apart from those, at most this many 'stock' events, so a busy page's stock moves
 * (a 'stock' event per save) never push a price drop out of the drawer's history.
 */
export const SCRAPTF_ITEM_STOCK_EVENTS = 10;
/**
 * 0.8 (T1): a copy off sale for any number of observations and back within this long of its last on-sale sighting,
 * at the same raw price, is a flap, not a 'gone' (a partial look, a lapsed reservation). In time, not in saves, so
 * the read density never changes the answer.
 */
export const SCRAPTF_FLAP_MAX_MS = 60 * MIN_MS;
/**
 * 0.8 (T2, LC-4): the widest bracket the estimators ever accept: the ceiling of a page's gap limit
 * (scraptfGapLimitMs), and the limit of a page with fewer than two looks in its last 7 d. Here because the walk needs
 * it; scraptfTiming.ts re-exports it.
 */
export const SCRAPTF_TIMING_MAX_BRACKET_MS = 24 * HOUR_MS;
/**
 * 0.8 (T2, LC-4, review): a page's gap limit is this many times its usual longest gap in a day (scraptfGapLimitMs:
 * the median over the UTC days of its last 7 d of each day's longest gap between looks, a night say), between
 * SCRAPTF_TIMING_MIN_GAP_MS and SCRAPTF_TIMING_MAX_BRACKET_MS. A gap between two observations of a copy over its
 * page's limit censors its state and run at the last sighting before it (cutAt), and a state or run begun after one is
 * left out (wideStart). Retention keeps one save a day past 7 d (bankStockThinning): pooled with the user's own looks,
 * those day-wide brackets read a drop and then a sale as one 'gone' and merge drops, which no horizon floor corrects.
 * The save schedule decides the cut, never the outcome, so censoring there biases nothing; a page looked at once a day
 * keeps 24 h, as its own saves are no finer.
 */
export const SCRAPTF_TIMING_GAP_SLACK = 1.25;
/** The floor of a page's gap limit: retention's hourly tier (1-7 d, the newest save of each clock hour) leaves gaps under 2 h. */
export const SCRAPTF_TIMING_MIN_GAP_MS = 2 * HOUR_MS;
/** scraptfLookGapMs and scraptfGapLimitMs read the looks within this long before a page's newest save. */
export const SCRAPTF_TIMING_GAP_WINDOW_MS = 7 * DAY_MS;
/** 0.8 (LC-5): asset-id labels need this share of cross-look single-card pairs to keep their id... */
export const SCRAPTF_ASSET_STABLE_SHARE = 0.95;
/** ...over at least this many pairs (each at least BANK_STOCK_SESSION_GAP_MS apart). */
export const SCRAPTF_ASSET_STABLE_MIN_PAIRS = 50;
/** 0.8: ScraptfItemCycles.runs keeps at most this many newest runs. */
export const SCRAPTF_ITEM_RUNS_MAX = 20;
/** DM-5 (moved here from renderer/historyModel.ts in 0.8, which re-exports it): a newest sighting older than this is no current listing; T3's 'stale-save'. */
export const HISTORY_LAST_SEEN_STALE_MS = 48 * HOUR_MS;
/** 0.7.1 (DM-6): the change kinds that are a price event (an item history reads them apart from 'stock'). */
export const SCRAPTF_PRICE_KINDS: readonly ScraptfChangeKind[] = ['new', 'restocked', 'cheaper', 'pricier', 'gone'];
/** S5: settings.import.resaveReminderMin's range (0 = off). */
export const SCRAPTF_RESAVE_MAX_MIN = 1440;
/** U4's helper text, shared so Settings and the docs say it alike. */
export const SCRAPTF_RESAVE_HELP = "Flip Desk can't refresh scrap.tf for you; this reminds you to save the page again";

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function rawOf(r: BankStockStored): { keys: number; scrap: Scrap } {
  return { keys: finite(r.costKeys) ? r.costKeys : 0, scrap: finite(r.costScrap) ? r.costScrap : 0 };
}

// ---------------------------------------------------------------------------
// S2: change events of one save against the previous save of its page
// ---------------------------------------------------------------------------

/**
 * The change events of a page's new save against the previous save **of that page** (null: a first
 * save, which writes none), by diffBankStock's matching and rules, so the feed agrees with the stock
 * page. A 'new' row is 'restocked' when the previous save listed it (sold out or without a price) or
 * `seenBefore(key)` says an earlier retained save of the bank listed it (the runs index before this save:
 * runs.has(key)); a row on sale in both with its price kept and both stock counts known but different is
 * 'stock'. A 0-row save writes none. The caller skips a save that is not newer than the page's newest
 * stored save (out of time order, or the same file again), and writes the result in the import's
 * transaction (Repo.insertScraptfEvents).
 */
export function scraptfEventsOf(a: {
  bank: ScraptfBank;
  page: string;
  /** The new save's time (batchSavedAt). */
  at: UnixMs;
  batchId: number;
  newest: readonly BankStockStored[];
  previous: readonly BankStockStored[] | null;
  /** Decides cheaper / pricier between prices in different keys, as diffBankStock. */
  keyScrap: Scrap;
  seenBefore?(key: string): boolean;
}): NewScraptfEvent[] {
  if (a.previous === null || a.newest.length === 0) return [];
  const out: NewScraptfEvent[] = [];
  for (const d of diffBankStock(a.newest, a.previous, a.keyScrap)) {
    const cur = d.current;
    const prev = d.previous;
    let kind: NewScraptfEvent['kind'] | null = null;
    if (d.change === 'new') kind = scraptfIsRestock(d, a.seenBefore?.(d.key) === true) ? 'restocked' : 'new';
    else if (d.change !== null) kind = d.change;
    else if (cur && prev && d.onSale && bankStockOnSale(prev) && finite(cur.stock) && finite(prev.stock) && cur.stock !== prev.stock) kind = 'stock';
    if (kind === null) continue;
    const priced = (r: BankStockStored | null): boolean => r !== null && finite(r.costScrap);
    out.push({
      at: a.at,
      bank: a.bank,
      page: a.page,
      sku: d.sku,
      specialKey: d.specialKey,
      name: (cur?.name || prev?.name || d.sku).trim() || d.sku,
      kind,
      fromKeys: priced(prev) ? rawOf(prev!).keys : null,
      fromScrap: priced(prev) ? prev!.costScrap : null,
      toKeys: priced(cur) ? rawOf(cur!).keys : null,
      toScrap: priced(cur) ? cur!.costScrap : null,
      fromStock: prev && finite(prev.stock) ? prev.stock : null,
      toStock: cur && finite(cur.stock) ? cur.stock : null,
      batchId: a.batchId,
    });
  }
  return out;
}

/**
 * 0.8 (G3, LC-7): an earlier retained save of the bank listed this copy at all (on sale or sold out): its run's seenAt
 * (the runs index, scraptfRunsOf) is before `savedAt`. The change feed's seenBefore and the notifier read this rule.
 */
export function scraptfSeenBefore(run: Pick<ScraptfKeyRun, 'seenAt'> | null | undefined, savedAt: UnixMs): boolean {
  return run !== null && run !== undefined && finite(run.seenAt) && finite(savedAt) && run.seenAt < savedAt;
}

/**
 * 0.8 (G3, LC-7): a copy on sale again on a save (diffBankStock 'new') is back, not new, when the previous save of its
 * page listed it (sold out or without a price) or it was seen before (scraptfSeenBefore). scraptfEventsOf's
 * 'restocked' and the notifier's "Back on scrap.tf" both read it, so the toast and the feed agree.
 */
export function scraptfIsRestock(d: Pick<BankStockDiffRow, 'change' | 'previous'>, seenBefore: boolean): boolean {
  return d.change === 'new' && (d.previous !== null || seenBefore);
}

// ---------------------------------------------------------------------------
// S4: an event valued now and joined to the live buy side
// ---------------------------------------------------------------------------

/** What an event reads from the Live market entry of its base SKU (MarketEval, MarketRow, BankStockBuySide fit). */
export interface ScraptfEventBuySide {
  revenueScrap: Scrap | null;
  maxCostScrap: Scrap | null;
  /** 0.7.3: why a null revenue with buyers is null (ScraptfChangeEvent.buyerCount, flags). Absent: not known. */
  buyerCount?: number;
  flags?: readonly string[];
}

/**
 * 0.7.4 (F01): a stored event of the /items list whose row in the event's own save (`rowOf`: null when the
 * save or the row is not known, a 'gone' row the save no longer lists included) is not proven to price one
 * copy (bankStockListFamily): a family row, every copy at its price. Its price meets no Craftable buyer, so
 * scraptfChangeEvent joins it to no buy side. Never for a bank page's event.
 */
export function scraptfEventListFamily(
  e: Pick<ScraptfEventStored, 'bank' | 'batchId' | 'sku' | 'specialKey'>,
  rowOf: (e: Pick<ScraptfEventStored, 'batchId' | 'sku' | 'specialKey'>) => BankStockStored | null | undefined,
): boolean {
  if (e.bank !== 'list') return false;
  let row: BankStockStored | null = null;
  try {
    row = rowOf(e) ?? null;
  } catch {
    row = null;
  }
  return bankStockListFamily('list', row);
}

/**
 * A stored event valued at `keyScrap` and joined to `buy` (null: no eligible buyer). flip: the new
 * price is at or under Pay up to now (a 'gone' event has no new price, so never a flip). 0.7.4: `family`
 * (scraptfEventListFamily) joins it to no buy side whatever `buy` holds, and marks it `listFamily`.
 */
export function scraptfChangeEvent(e: ScraptfEventStored, keyScrap: Scrap, buyIn: ScraptfEventBuySide | null, opts: { family?: boolean } = {}): ScraptfChangeEvent {
  const family = opts.family === true;
  const buy = family ? null : buyIn;
  const fromValueScrap = finite(e.fromScrap) ? valueScrap(finite(e.fromKeys) ? e.fromKeys : 0, e.fromScrap, keyScrap) : null;
  const toValueScrap = finite(e.toScrap) ? valueScrap(finite(e.toKeys) ? e.toKeys : 0, e.toScrap, keyScrap) : null;
  // Equal raw prices are no move, whatever the key price did since.
  const sameRaw = e.fromKeys === e.toKeys && e.fromScrap === e.toScrap;
  const deltaScrap = fromValueScrap !== null && toValueScrap !== null ? (sameRaw ? 0 : toValueScrap - fromValueScrap) : null;
  const revenueScrap = buy && finite(buy.revenueScrap) ? buy.revenueScrap : null;
  const maxCostScrap = buy && finite(buy.maxCostScrap) ? buy.maxCostScrap : null;
  // 0.7.3: who buys, so a null Sells for with buyers says why (none usable), not "no eligible buy order".
  const buyers = buy === null ? { buyerCount: 0, flags: [] } : finite(buy.buyerCount) ? { buyerCount: buy.buyerCount, flags: [...(buy.flags ?? [])] } : {};
  return {
    ...e,
    key: bankStockKey(e.sku, e.specialKey),
    hasExtras: e.specialKey !== BANK_STOCK_PLAIN_KEY,
    fromValueScrap,
    toValueScrap,
    deltaScrap,
    pct: deltaScrap !== null && fromValueScrap !== null && fromValueScrap > 0 ? deltaScrap / fromValueScrap : null,
    revenueScrap,
    maxCostScrap,
    flip: e.kind !== 'gone' && toValueScrap !== null && maxCostScrap !== null && toValueScrap <= maxCostScrap,
    ...buyers,
    ...(family ? { listFamily: true as const } : {}),
  };
}

/**
 * 0.7.1 (ACT-10): one copy's current state across a bank's retained saves (scraptfKeyStatesOf): whether it
 * is on sale on its newest observation, and since when its price and stock have been as they are now.
 */
export interface ScraptfKeyState {
  onSale: boolean;
  /** The first retained save showing the current state (on sale or not, price, stock as the events compare them). */
  since: UnixMs;
  /** The observation just before `since` (the save that showed the earlier state); null: none. */
  prevAt: UnixMs | null;
  /**
   * As `since`, but only a price or on-sale change starts a new state: a stock move at the same price (a
   * 'stock' event, hidden from the feed by default) does not supersede the price event before it.
   */
  priceSince: UnixMs;
  /** The observation just before `priceSince`; null: none. */
  pricePrevAt: UnixMs | null;
}

/** 0.8 (T1): how a price state ended. */
export type ScraptfStateOutcome = 'reprice-down' | 'arrival' | 'sold-cheapest' | 'reprice-up' | 'gone' | 'untradable' | 'open';

/** 0.8 (T1): one stretch of a copy on sale at one raw price, in one bank (flaps merged). */
export interface ScraptfPriceState {
  /** The copy (bankStockKey): the table counts distinct copies (ScraptfBuyTiming.n.copies, dropCopies). */
  key: string;
  startAt: UnixMs;
  /** The copy's observation before startAt; null: left-censored. */
  startPrevAt: UnixMs | null;
  /** The newest save on sale at this price. */
  lastAt: UnixMs;
  /** The save that showed the next state (another price, or off sale); null while open. */
  endAt: UnixMs | null;
  raw: { keys: number; scrap: Scrap };
  /** Stock on its first save. */
  stock: number | null;
  outcome: ScraptfStateOutcome;
  /** The next price (reprices, arrival, sold-cheapest); null otherwise. */
  nextRaw: { keys: number; scrap: Scrap } | null;
  /** Index into the copy's runs of the run it began in. */
  run: number;
  /** Flaps absorbed. */
  flaps: number;
  /**
   * The last sighting before the first gap over its page's gap limit (scraptfGapLimitMs, at most
   * SCRAPTF_TIMING_MAX_BRACKET_MS) between two observations of the copy while this state was open (including the gap
   * before the save that ended it); null: none. The table censors the state there, whatever its outcome.
   */
  cutAt: UnixMs | null;
  /** A reprice proven on one card (stock 1, the same asset id on both sides, the bank's ids stable): true; ids differ: false; else null. */
  sameItem: boolean | null;
  family?: true;
  /** Its start bracket (startAt - startPrevAt) is over the gap limit of the page it began on: the table leaves it out (start side). */
  wideStart?: true;
}

/** 0.8: one copy's lifecycle in one bank. */
export interface ScraptfCopyLifecycle {
  key: string;
  sku: string;
  specialKey: string;
  /** Its home page now (the page of the newest save that listed it). */
  home: string;
  runs: ScraptfListingRun[];
  states: ScraptfPriceState[];
  /** As ScraptfItemCycles.returns. */
  returns: number;
  /** Its newest observation (a save that listed it, or its home page's save without it), and the newest save that listed it. */
  lastObsAt: UnixMs;
  lastListedAt: UnixMs;
  /** On sale on its newest observation. */
  onSale: boolean;
}

/** 0.8: one bank's lifecycle (scraptfLifecycleOf); the history index caches it per runs rebuild. */
export interface ScraptfBankLifecycle {
  /** Exactly what scraptfKeyStatesOf returned before 0.8 (ACT-10). */
  keyStates: Map<string, ScraptfKeyState>;
  copies: Map<string, ScraptfCopyLifecycle>;
  /** Per page (ScraptfSaveRows.page), its save times, oldest first. */
  pageSaves: Map<string, UnixMs[]>;
  /** Per page, scraptfLookGapMs of its save times, once per build (its gap limit and the timing read it); absent on a hand-built lifecycle. */
  lookGaps?: Map<string, number | null>;
  assetStability: ScraptfAssetStability;
  newestSaveAt: UnixMs | null;
}

/**
 * A change event would be written between these two rows of one copy (scraptfEventsOf's rules); without
 * `stock`, only a price or on-sale change counts (ScraptfKeyState.priceSince).
 */
function stateChanged(prev: BankStockStored | null, cur: BankStockStored | null, stock: boolean): boolean {
  const was = bankStockOnSale(prev);
  const is = bankStockOnSale(cur);
  if (was !== is) return true;
  if (!is || !prev || !cur) return false;
  const a = rawOf(prev);
  const b = rawOf(cur);
  if (a.keys !== b.keys || a.scrap !== b.scrap) return true;
  return stock && finite(prev.stock) && finite(cur.stock) && prev.stock !== cur.stock;
}

/** ACT-10's bookkeeping for one copy: its state, and its newest observation's row and time. */
interface KeyStateWalk {
  state: ScraptfKeyState;
  last: BankStockStored | null;
  lastAt: UnixMs;
}

/** ACT-10: one more observation of a copy already known (0.7.1's rule, unchanged). */
function see(st: KeyStateWalk, at: UnixMs, row: BankStockStored | null): void {
  if (stateChanged(st.last, row, true)) {
    st.state.prevAt = st.lastAt;
    st.state.since = at;
  }
  if (stateChanged(st.last, row, false)) {
    st.state.pricePrevAt = st.lastAt;
    st.state.priceSince = at;
  }
  st.state.onSale = bankStockOnSale(row);
  st.last = row;
  st.lastAt = at;
}

/**
 * 0.7.1 (ACT-10): per copy (bankStockKey), its current state across one bank's retained saves, by
 * scraptfRunsOf's home-page rule (a save of another page that does not list it says nothing). From the
 * saves in memory, never a query. O(rows + observations). 0.8: the lifecycle's keyStates, which the walk
 * builds with the same rule and the same `see`, so the two are equal by construction (the ACT-10 tests pin it).
 */
export function scraptfKeyStatesOf(saves: readonly ScraptfSaveRows[]): Map<string, ScraptfKeyState> {
  return scraptfLifecycleOf(saves).keyStates;
}

// ---------------------------------------------------------------------------
// 0.8 (T1, LC-3, LC-5): the per-bank lifecycle
// ---------------------------------------------------------------------------

/** A row's asset id when it is a single card (stock 1) with a non-empty id, else null (a stack, or no id). */
function singleCardId(r: BankStockStored | null | undefined): string | null {
  return r && r.stock === 1 && typeof r.assetId === 'string' && r.assetId !== '' ? r.assetId : null;
}

/** diffBankStock's priceChange rule: cheaper by value at `keyScrap`; equal value goes by keys. */
function cheaperRaw(cur: { keys: number; scrap: Scrap }, prev: { keys: number; scrap: Scrap }, keyScrap: Scrap): boolean {
  const d = valueScrap(cur.keys, cur.scrap, keyScrap) - valueScrap(prev.keys, prev.scrap, keyScrap);
  return d !== 0 ? d < 0 : cur.keys < prev.keys;
}

/** The SKU's not-tradable twin (its ';untradable' SKU), or null for an unparsable or already untradable SKU. */
function untradableTwinOf(sku: string): string | null {
  if (!isValidSku(sku)) return null;
  try {
    const obj = fromString(sku);
    return obj.tradable === false ? null : fromObject({ ...obj, tradable: false });
  } catch {
    return null;
  }
}

/**
 * 0.8 (LC-5): the pre-pass, one walk oldest first, O(rows): how often a single card kept its asset id between the
 * user's looks. A pair is a key on sale as one card with an id on a save of a page whose previous save also listed it
 * on sale with an id, the two at least BANK_STOCK_SESSION_GAP_MS apart (the last sighting of one look against the
 * first of the next): dense window reads of one look always show the same card and say nothing about the hours or
 * days between a reprice or a return. A page move or a save between that did not list it on sale gives no pair.
 * Stable: SCRAPTF_ASSET_STABLE_SHARE over at least SCRAPTF_ASSET_STABLE_MIN_PAIRS pairs.
 */
export function scraptfAssetStabilityOf(saves: readonly ScraptfSaveRows[]): ScraptfAssetStability {
  const pageSeq = new Map<string, number>();
  const last = new Map<string, { at: UnixMs; page: string; seq: number; assetId: string | null }>();
  let pairs = 0;
  let same = 0;
  for (const save of oldestFirst(saves)) {
    const seq = (pageSeq.get(save.page) ?? 0) + 1;
    pageSeq.set(save.page, seq);
    const seen = new Set<string>();
    for (const row of save.rows) {
      const key = bankStockKey(row.sku, row.specialKey);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!bankStockOnSale(row)) continue;
      const id = singleCardId(row);
      const prev = last.get(key);
      if (id !== null && prev && prev.assetId !== null && prev.page === save.page && prev.seq === seq - 1 && save.savedAt - prev.at >= BANK_STOCK_SESSION_GAP_MS) {
        pairs++;
        if (prev.assetId === id) same++;
      }
      if (prev) {
        prev.at = save.savedAt;
        prev.page = save.page;
        prev.seq = seq;
        prev.assetId = id;
      } else last.set(key, { at: save.savedAt, page: save.page, seq, assetId: id });
    }
  }
  const share = pairs > 0 ? same / pairs : null;
  return { pairs, same, share, stable: pairs >= SCRAPTF_ASSET_STABLE_MIN_PAIRS && share !== null && share >= SCRAPTF_ASSET_STABLE_SHARE };
}

/**
 * 0.8 (T3): how often the user looks at a page, from its save times. Saves less than BANK_STOCK_SESSION_GAP_MS
 * apart are one look (a window session of 30 s reads is one look); this is the median gap from one look's last save
 * to the next look's first, over the looks within SCRAPTF_TIMING_GAP_WINDOW_MS before the newest time; null with
 * fewer than 2 looks there. A raw median over saves would read seconds for any window user, even one who looks once
 * a day. (Here because the walk's gap limit needs it; scraptfTiming.ts re-exports it.)
 */
export function scraptfLookGapMs(times: readonly UnixMs[]): number | null {
  return lookStatsOf(times).lookGapMs;
}

/**
 * 0.8 (T2, LC-4, review): a page's gap limit from its save times: SCRAPTF_TIMING_GAP_SLACK times its usual longest
 * gap in a day (the median, over the UTC days of the looks within SCRAPTF_TIMING_GAP_WINDOW_MS before its newest save,
 * of each day's longest gap between looks, a gap counted on the day of the look that ends it), clamped to
 * [SCRAPTF_TIMING_MIN_GAP_MS, SCRAPTF_TIMING_MAX_BRACKET_MS]; the ceiling with fewer than 2 looks. An hourly looker
 * with 9 h nights gets about 11 h: the nights are kept, retention's one save a day past 7 d is cut, never pooled. A
 * median over days, so one long absence does not lift it.
 */
export function scraptfGapLimitMs(times: readonly UnixMs[]): number {
  return lookStatsOf(times).gapLimitMs;
}

/** One sort of a page's save times for both: its look gap (scraptfLookGapMs) and its gap limit (scraptfGapLimitMs). */
function lookStatsOf(times: readonly UnixMs[]): { lookGapMs: number | null; gapLimitMs: number } {
  const tt = times.filter(finite).sort((a, b) => a - b);
  const none = { lookGapMs: null, gapLimitMs: SCRAPTF_TIMING_MAX_BRACKET_MS };
  if (tt.length === 0) return none;
  const from = tt[tt.length - 1]! - SCRAPTF_TIMING_GAP_WINDOW_MS;
  const looks: { first: UnixMs; last: UnixMs }[] = [];
  for (const at of tt) {
    if (at < from) continue;
    const l = looks[looks.length - 1];
    if (l && at - l.last < BANK_STOCK_SESSION_GAP_MS) l.last = at;
    else looks.push({ first: at, last: at });
  }
  if (looks.length < 2) return none;
  const gaps: number[] = [];
  const dayMax = new Map<number, number>();
  for (let i = 1; i < looks.length; i++) {
    const g = looks[i]!.first - looks[i - 1]!.last;
    gaps.push(g);
    const day = Math.floor(looks[i]!.first / DAY_MS);
    dayMax.set(day, Math.max(dayMax.get(day) ?? 0, g));
  }
  const usual = medianOf([...dayMax.values()])!;
  return {
    lookGapMs: medianOf(gaps),
    gapLimitMs: Math.min(SCRAPTF_TIMING_MAX_BRACKET_MS, Math.max(SCRAPTF_TIMING_MIN_GAP_MS, SCRAPTF_TIMING_GAP_SLACK * usual)),
  };
}

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 === 1 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
}

/** One copy during the walk: ACT-10's bookkeeping, its lifecycle and what the post-pass needs. */
interface CopyWalk extends KeyStateWalk {
  life: ScraptfCopyLifecycle;
  /** Its observation before the one being read; null: none (left-censored). */
  prevObsAt: UnixMs | null;
  /** On sale on its newest observation (a run is open). */
  listed: boolean;
  /** Its newest on-sale row (the last run's last on-sale row). */
  lastOnSale: BankStockStored | null;
  /** Reprices between two single cards with ids, by the index of the state they closed: true when the ids are equal. */
  assetCmp: Map<number, boolean> | null;
  /** 'became untradable' candidates: [run index, state index]. */
  untradable: [number, number][] | null;
}

/**
 * 0.8 (T1, LC-3, LC-5): the single walk over one bank's retained saves (oldest first, O(rows + observations)), by
 * scraptfRunsOf's home-page rule (a page move is no break). It gives ACT-10's key states (scraptfKeyStatesOf), and per
 * copy (bankStockKey) its listing runs and price states:
 * - A run is an unbroken stretch of observations on sale; it ends 'absent', 'sold-out' or (with stable ids, the
 *   same asset id under the item's ';untradable' SKU in that save) 'untradable'.
 * - A flap (the run ended 'absent', back within `flapMaxMs` of its last on-sale sighting at the same raw price,
 *   stock not lower, and with stable ids the same asset id on single cards) marks the earlier run `flap` and
 *   re-opens its price state, so it is no 'gone'. In time, not in saves: read density never changes it.
 * - A price state ends 'reprice-down' / 'arrival' (cheaper; more stock) or 'reprice-up' / 'sold-cheapest' (pricier;
 *   less stock), by diffBankStock's direction rule at `keyScrap`, or 'gone'. With stable ids (the pre-pass,
 *   scraptfAssetStabilityOf), two single cards with different ids turn a reprice into an arrival or a sale.
 * - A gap over the gap limit of the page saved (`maxGapMs`) between two observations sets `cutAt` (the last sighting
 *   before it) on the open state and run, before the row after it is read, and a state or run begun after one is
 *   `wideStart`: the save schedule decides the censoring, never the outcome.
 * `flapMaxMs` defaults to SCRAPTF_FLAP_MAX_MS (0 turns flaps off); `maxGapMs` (one limit for every page) defaults to
 * each page's own scraptfGapLimitMs of its save times (its look gap is kept on the result, `lookGaps`);
 * `bank` marks the /items list's family rows (bankStockListFamily). `assetStability`, when given, is the pre-pass over
 * these same saves already done (the history keeps it for Health), so it is not walked twice. Pure; from the saves in
 * memory, never a query.
 */
export function scraptfLifecycleOf(
  saves: readonly ScraptfSaveRows[],
  opts: { bank?: ScraptfBank | null; keyScrap?: Scrap; flapMaxMs?: number; maxGapMs?: number; assetStability?: ScraptfAssetStability } = {},
): ScraptfBankLifecycle {
  const bank = opts.bank ?? null;
  const keyScrap = finite(opts.keyScrap) ? opts.keyScrap : 0;
  const flapMaxMs = finite(opts.flapMaxMs) ? Math.max(0, opts.flapMaxMs) : SCRAPTF_FLAP_MAX_MS;
  const fixedGapMs = finite(opts.maxGapMs) ? opts.maxGapMs : null;
  const assetStability = opts.assetStability ?? scraptfAssetStabilityOf(saves);
  const stable = assetStability.stable;
  const walks = new Map<string, CopyWalk>();
  const homeKeys = new Map<string, Set<string>>();
  // The pages' save times first: each page's look gap sets its gap limit before the walk reads a row.
  const ordered = oldestFirst(saves);
  const pageSaves = new Map<string, UnixMs[]>();
  for (const save of ordered) {
    const times = pageSaves.get(save.page);
    if (times) times.push(save.savedAt);
    else pageSaves.set(save.page, [save.savedAt]);
  }
  const lookGaps = new Map<string, number | null>();
  const gapLimits = new Map<string, number>();
  for (const [page, times] of pageSaves) {
    const st = lookStatsOf(times);
    lookGaps.set(page, st.lookGapMs);
    gapLimits.set(page, fixedGapMs ?? st.gapLimitMs);
  }
  const pageLastAt = new Map<string, UnixMs>();
  let newestSaveAt: UnixMs | null = null;
  const homeOf = (page: string): Set<string> => {
    let s = homeKeys.get(page);
    if (!s) homeKeys.set(page, (s = new Set()));
    return s;
  };

  const step = (w: CopyWalk, at: UnixMs, row: BankStockStored | null, listedHere: ReadonlyMap<string, BankStockStored>, maxGapMs: number): void => {
    const life = w.life;
    const runs = life.runs;
    const states = life.states;
    const on = bankStockOnSale(row);
    life.lastObsAt = at;
    if (row) life.lastListedAt = at;
    const run = w.listed ? runs[runs.length - 1] : undefined;
    const open = w.listed ? states[states.length - 1] : undefined;
    // Wider than this page's saves resolve: a state or run starting here is left out on the start side.
    const wide = w.prevObsAt !== null && at - w.prevObsAt > maxGapMs;
    // A wide gap censors the open state and run at their last sighting before it, before this row is read, so an
    // ending first shown after the gap is cut exactly like a state still at its price after it.
    if (run && open && wide && w.prevObsAt !== null) {
      if (open.cutAt === null) open.cutAt = w.prevObsAt;
      if (run.cutAt === undefined) run.cutAt = w.prevObsAt;
    }
    if (on && row) {
      const raw = rawOf(row);
      const stock = finite(row.stock) ? row.stock : null;
      const family = bankStockListFamily(bank, row);
      if (!run || !open) {
        const lastRun = runs[runs.length - 1];
        const lastState = states[states.length - 1];
        const before = w.lastOnSale;
        const id = singleCardId(row);
        const beforeId = singleCardId(before);
        const flap =
          flapMaxMs > 0 &&
          lastRun !== undefined &&
          lastState !== undefined &&
          before !== null &&
          lastRun.endedAs === 'absent' &&
          lastState.outcome === 'gone' &&
          at - lastRun.lastOnSaleAt <= flapMaxMs &&
          raw.keys === lastState.raw.keys &&
          raw.scrap === lastState.raw.scrap &&
          !(stock !== null && finite(before.stock) && stock < before.stock) &&
          !(stable && id !== null && beforeId !== null && id !== beforeId);
        runs.push({
          firstOnSaleAt: at,
          startAfter: w.prevObsAt,
          lastOnSaleAt: at,
          endedAt: null,
          endedAs: null,
          startRaw: raw,
          endRaw: raw,
          drops: 0,
          saves: 1,
          sameAssetAsBefore: lastRun !== undefined && id !== null && beforeId !== null ? id === beforeId : null,
          ...(family ? { family: true as const } : {}),
          ...(wide ? { wideStart: true as const } : {}),
        });
        if (flap) {
          lastRun!.flap = true;
          lastState!.outcome = 'open';
          lastState!.endAt = null;
          lastState!.lastAt = at;
          lastState!.flaps++;
          const gone = states.length - 1;
          if (w.untradable) w.untradable = w.untradable.filter(([, s]) => s !== gone);
        } else {
          states.push({ key: life.key, startAt: at, startPrevAt: w.prevObsAt, lastAt: at, endAt: null, raw, stock, outcome: 'open', nextRaw: null, run: runs.length - 1, flaps: 0, cutAt: null, sameItem: null, ...(family ? { family: true as const } : {}), ...(wide ? { wideStart: true as const } : {}) });
        }
      } else {
        run.lastOnSaleAt = at;
        run.saves++;
        run.endRaw = raw;
        if (raw.keys !== open.raw.keys || raw.scrap !== open.raw.scrap) {
          const prev = w.lastOnSale;
          // An unknown stock counts as unchanged.
          const both = stock !== null && prev !== null && finite(prev.stock);
          if (cheaperRaw(raw, open.raw, keyScrap)) open.outcome = both && stock > prev!.stock! ? 'arrival' : 'reprice-down';
          else open.outcome = both && stock < prev!.stock! ? 'sold-cheapest' : 'reprice-up';
          open.endAt = at;
          open.nextRaw = raw;
          const a = singleCardId(prev);
          const b = singleCardId(row);
          if (a !== null && b !== null) (w.assetCmp ??= new Map()).set(states.length - 1, a === b);
          states.push({ key: life.key, startAt: at, startPrevAt: open.lastAt, lastAt: at, endAt: null, raw, stock, outcome: 'open', nextRaw: null, run: runs.length - 1, flaps: 0, cutAt: null, sameItem: null, ...(family ? { family: true as const } : {}), ...(wide ? { wideStart: true as const } : {}) });
        } else open.lastAt = at;
      }
      w.lastOnSale = row;
    } else if (run && open) {
      run.endedAt = at;
      run.endedAs = row ? 'sold-out' : 'absent';
      open.outcome = 'gone';
      open.endAt = at;
      // Became untradable: gone from the list while the same single card shows under the item's ';untradable' SKU.
      const id = singleCardId(w.lastOnSale);
      if (row === null && id !== null) {
        const twin = untradableTwinOf(life.sku);
        if (twin !== null && listedHere.get(bankStockKey(twin, life.specialKey))?.assetId === id) (w.untradable ??= []).push([runs.length - 1, states.length - 1]);
      }
    }
    w.prevObsAt = at;
    w.listed = on;
    life.onSale = on;
  };

  for (const save of ordered) {
    const at = save.savedAt;
    const prevPageAt = pageLastAt.get(save.page) ?? null;
    pageLastAt.set(save.page, at);
    const maxGapMs = gapLimits.get(save.page) ?? SCRAPTF_TIMING_MAX_BRACKET_MS;
    if (newestSaveAt === null || at > newestSaveAt) newestSaveAt = at;
    const listedHere = new Map<string, BankStockStored>();
    for (const row of save.rows) {
      const key = bankStockKey(row.sku, row.specialKey);
      if (!listedHere.has(key)) listedHere.set(key, row);
    }
    for (const [key, row] of listedHere) {
      let w = walks.get(key);
      if (!w) {
        w = {
          state: { onSale: bankStockOnSale(row), since: at, prevAt: null, priceSince: at, pricePrevAt: null },
          last: row,
          lastAt: at,
          life: { key, sku: row.sku, specialKey: row.specialKey, home: save.page, runs: [], states: [], returns: 0, lastObsAt: at, lastListedAt: at, onSale: false },
          // Its first observation follows the page's save before, which did not list it.
          prevObsAt: prevPageAt,
          listed: false,
          lastOnSale: null,
          assetCmp: null,
          untradable: null,
        };
        walks.set(key, w);
        homeOf(save.page).add(key);
      } else {
        if (w.life.home !== save.page) {
          homeKeys.get(w.life.home)?.delete(key);
          w.life.home = save.page;
          homeOf(save.page).add(key);
        }
        see(w, at, row);
      }
      step(w, at, row, listedHere, maxGapMs);
    }
    for (const key of homeKeys.get(save.page) ?? []) {
      if (listedHere.has(key)) continue;
      const w = walks.get(key)!;
      see(w, at, null);
      step(w, at, null, listedHere, maxGapMs);
    }
  }

  const keyStates = new Map<string, ScraptfKeyState>();
  const copies = new Map<string, ScraptfCopyLifecycle>();
  for (const [key, w] of walks) {
    keyStates.set(key, w.state);
    const { runs, states } = w.life;
    if (stable) {
      for (const [i, same] of w.assetCmp ?? []) {
        const s = states[i]!;
        s.sameItem = same;
        if (!same) {
          // Another card at the new price: the one at the old price was sold (or a cheaper one came in).
          if (s.outcome === 'reprice-down') s.outcome = 'arrival';
          else if (s.outcome === 'reprice-up') s.outcome = 'sold-cheapest';
        }
      }
      for (const [r, s] of w.untradable ?? []) {
        runs[r]!.endedAs = 'untradable';
        states[s]!.outcome = 'untradable';
      }
    } else for (const run of runs) run.sameAssetAsBefore = null;
    // Runs count reprice-downs only, as labelled (the estimators' drop event also takes arrivals).
    for (let i = 0; i + 1 < states.length; i++) if (states[i]!.outcome === 'reprice-down') runs[states[i + 1]!.run]!.drops++;
    for (let i = 1; i < runs.length; i++) if (runs[i]!.startAfter !== null && !runs[i - 1]!.flap) w.life.returns++;
    copies.set(key, w.life);
  }
  return { keyStates, copies, pageSaves, lookGaps, assetStability, newestSaveAt };
}

/**
 * 0.7.1 (ACT-10): whether an event is still the copy's newest change of its sort and the copy is on sale
 * now: it falls after the observation before the current state began and at or before the save that first
 * showed it (a save between the two may have been thinned away, so its event can be anywhere in that
 * span). A 'stock' event is measured against every change; a price event against price and on-sale
 * changes only, so a later stock move at the same price leaves its Flip pill (the feed hides stock moves
 * by default, and the price it reports still stands).
 */
export function scraptfEventIsCurrent(e: Pick<NewScraptfEvent, 'at'> & Partial<Pick<NewScraptfEvent, 'kind'>>, st: ScraptfKeyState | null | undefined): boolean {
  if (!st || !st.onSale || !finite(e.at)) return false;
  const stockMove = e.kind === 'stock';
  const since = stockMove ? st.since : st.priceSince;
  const prevAt = stockMove ? st.prevAt : st.pricePrevAt;
  return e.at <= since && (prevAt === null || e.at > prevAt);
}

/**
 * 0.7.1 (ACT-10): the "Flip" pill only on the copy's newest event while it is on sale (its newest price
 * event, and its newest stock move; scraptfEventIsCurrent); an earlier one (a later change superseded it,
 * or the copy is gone) keeps flip false and gets wasFlip, the muted pill.
 * `statesOf(bank)` null: that bank's saves are not known (a failed read), so its events stay as they are.
 */
export function scraptfMarkSuperseded(events: readonly ScraptfChangeEvent[], statesOf: (bank: ScraptfBank) => ReadonlyMap<string, ScraptfKeyState> | null): ScraptfChangeEvent[] {
  return events.map((e) => {
    if (!e.flip) return e;
    const states = statesOf(e.bank);
    if (states === null || scraptfEventIsCurrent(e, states.get(e.key))) return e;
    return { ...e, flip: false, wasFlip: true };
  });
}

/** The feed's filters as the service applies them after the repo read (the mock filters the same way). */
export function scraptfEventMatches(e: Pick<NewScraptfEvent, 'bank' | 'kind' | 'sku'>, q: { bank?: ScraptfBank; kinds?: readonly string[]; baseSku?: string }): boolean {
  if (q.bank !== undefined && e.bank !== q.bank) return false;
  if (q.kinds !== undefined && q.kinds.length > 0 && !q.kinds.includes(e.kind)) return false;
  if (q.baseSku !== undefined && e.sku !== q.baseSku) return false;
  return true;
}

/** ScraptfChangesQuery.limit as the service clamps it: 1..SCRAPTF_CHANGES_MAX_LIMIT, default SCRAPTF_CHANGES_DEFAULT_LIMIT. */
export function scraptfChangesLimit(limit: unknown): number {
  return finite(limit) ? Math.min(SCRAPTF_CHANGES_MAX_LIMIT, Math.max(1, Math.floor(limit))) : SCRAPTF_CHANGES_DEFAULT_LIMIT;
}

export const SCRAPTF_CHANGES_CSV_COLUMNS: readonly string[] = [
  'time',
  'bank',
  'page',
  'sku',
  'name',
  'extras',
  'kind',
  'from',
  'to',
  'change',
  'change_pct',
  'from_stock',
  'to_stock',
  'sells_for',
  'pay_up_to',
  'flip',
];

/** One CSV line of the feed (opps.exportCsv kind 'scraptfChanges'), in SCRAPTF_CHANGES_CSV_COLUMNS order. */
export function scraptfChangeCsvCells(e: ScraptfChangeEvent, keyScrap: Scrap | null): (string | number | null)[] {
  const key = finite(keyScrap) && keyScrap > 0 ? keyScrap : null;
  const money = (v: Scrap | null): string => (finite(v) ? formatScrap(v, key) : '');
  return [
    finite(e.at) ? new Date(e.at).toISOString() : '',
    e.bank,
    e.page,
    e.sku,
    e.name,
    e.hasExtras ? 'yes' : '',
    e.kind,
    money(e.fromValueScrap),
    money(e.toValueScrap),
    money(e.deltaScrap),
    finite(e.pct) ? Number(e.pct.toFixed(4)) : null,
    finite(e.fromStock) ? e.fromStock : null,
    finite(e.toStock) ? e.toStock : null,
    money(e.revenueScrap),
    money(e.maxCostScrap),
    e.flip ? 'yes' : '',
  ];
}

// ---------------------------------------------------------------------------
// S3: observations, runs and item history
// ---------------------------------------------------------------------------

/** One retained save of a bank with its rows (the history index's input; `byKey` speeds up one item's read). */
export interface ScraptfSaveRows {
  batchId: number;
  savedAt: UnixMs;
  /** bank_stock.page ('' when unknown). */
  page: string;
  rows: readonly BankStockStored[];
  /** bankStockKey -> row of `rows`, when the caller keeps one (scraptfItemHistoryOf scans `rows` otherwise). */
  byKey?: ReadonlyMap<string, BankStockStored>;
}

/** One save that covered a key: it listed it (row, on sale or not) or it was the key's home page and did not. */
export interface ScraptfObservation {
  at: UnixMs;
  page: string;
  batchId: number;
  row: BankStockStored | null;
  onSale: boolean;
}

function oldestFirst<S extends { savedAt: UnixMs; batchId: number }>(saves: readonly S[]): S[] {
  return [...saves].sort((a, b) => a.savedAt - b.savedAt || a.batchId - b.batchId);
}

function rowOf(save: ScraptfSaveRows, key: string): BankStockStored | undefined {
  if (save.byKey) return save.byKey.get(key);
  return save.rows.find((r) => bankStockKey(r.sku, r.specialKey) === key);
}

interface RunState {
  run: ScraptfKeyRun;
  home: string;
  listed: boolean;
}

function observe(st: RunState, at: UnixMs, row: BankStockStored | null): void {
  const r = st.run;
  if (row !== null && bankStockOnSale(row)) {
    const raw = rawOf(row);
    if (r.firstSeenAt === null) r.firstSeenAt = at;
    r.lastSeenAt = at;
    // 0.7.3: never cleared off sale, so a gone row shows the price it was last on sale at.
    r.lastOnSale = { keys: raw.keys, scrap: raw.scrap };
    if (!st.listed) {
      r.listedSince = at;
      r.runStart = raw;
    }
    r.current = { keys: raw.keys, scrap: raw.scrap, stock: finite(row.stock) ? row.stock : null };
    st.listed = true;
  } else {
    r.listedSince = null;
    r.runStart = null;
    r.current = null;
    st.listed = false;
  }
}

/**
 * The runs index of one bank: per key (bankStockKey), across the bank's retained saves read together.
 * A save covers a key when it lists it, or when its page is the key's home page (the page of the newest
 * save that listed it) and it does not: then the key is off sale there and its run breaks. A save of
 * another page that does not list it says nothing (an item that moved from /items/2 to /items/3 is not
 * gone from the list). "Listed" is on sale (bankStockOnSale), as F17's new and gone. Saves are read
 * oldest first (savedAt, then batch id), whatever order they come in. O(rows + observations).
 */
export function scraptfRunsOf(saves: readonly ScraptfSaveRows[]): Map<string, ScraptfKeyRun> {
  const state = new Map<string, RunState>();
  const homeKeys = new Map<string, Set<string>>();
  const homeOf = (page: string): Set<string> => {
    let s = homeKeys.get(page);
    if (!s) homeKeys.set(page, (s = new Set()));
    return s;
  };
  for (const save of oldestFirst(saves)) {
    const listedHere = new Set<string>();
    for (const row of save.rows) {
      const key = bankStockKey(row.sku, row.specialKey);
      if (listedHere.has(key)) continue;
      listedHere.add(key);
      let st = state.get(key);
      if (!st) {
        st = {
          run: { key, sku: row.sku, specialKey: row.specialKey, seenAt: save.savedAt, firstSeenAt: null, lastSeenAt: null, listedSince: null, runStart: null, current: null, lastOnSale: null },
          home: save.page,
          listed: false,
        };
        state.set(key, st);
        homeOf(save.page).add(key);
      } else if (st.home !== save.page) {
        homeKeys.get(st.home)?.delete(key);
        st.home = save.page;
        homeOf(save.page).add(key);
      }
      observe(st, save.savedAt, row);
    }
    for (const key of homeKeys.get(save.page) ?? []) {
      if (!listedHere.has(key)) observe(state.get(key)!, save.savedAt, null);
    }
  }
  const out = new Map<string, ScraptfKeyRun>();
  for (const [key, st] of state) out.set(key, st.run);
  return out;
}

/** One key's observations in one bank's saves (oldest first), by scraptfRunsOf's home-page rule. */
export function scraptfObservationsOf(saves: readonly ScraptfSaveRows[], key: string): ScraptfObservation[] {
  const out: ScraptfObservation[] = [];
  let home: string | null = null;
  for (const save of oldestFirst(saves)) {
    const row = rowOf(save, key) ?? null;
    if (row !== null) home = save.page;
    else if (home === null || save.page !== home) continue;
    out.push({ at: save.savedAt, page: save.page, batchId: save.batchId, row, onSale: bankStockOnSale(row) });
  }
  return out;
}

/** The run fields of one key's observations (as scraptfRunsOf builds them; a test keeps the two equal). */
function runOfObservations(key: string, sku: string, specialKey: string, obs: readonly ScraptfObservation[]): ScraptfKeyRun | null {
  const first = obs.find((o) => o.row !== null);
  if (!first) return null;
  const st: RunState = {
    run: { key, sku, specialKey, seenAt: first.at, firstSeenAt: null, lastSeenAt: null, listedSince: null, runStart: null, current: null, lastOnSale: null },
    home: first.page,
    listed: false,
  };
  for (const o of obs) observe(st, o.at, o.row);
  return st.run;
}

/** Prefer a bank page over the /items list, then the newer time (preferScraptfSeen's order). */
function better(a: { bank: ScraptfBank; at: UnixMs }, b: { bank: ScraptfBank; at: UnixMs } | null): boolean {
  if (b === null) return true;
  const listA = a.bank === 'list';
  if (listA !== (b.bank === 'list')) return !listA;
  return a.at > b.at;
}

type ItemBanks = readonly { bank: ScraptfBank; saves: readonly ScraptfSaveRows[] }[];
type CopyPick = { bank: ScraptfBank; obs: ScraptfObservation[]; run: ScraptfKeyRun; at: UnixMs };

/**
 * The bank one copy's history is read from (scraptfItemHistoryOf): the one whose newest observation lists it
 * on sale (tier 0), else the one that last listed it on sale (1), else the one that last listed it (2); null
 * when no save lists it. `name`: the newest name a save gives it.
 */
function copyPickOf(banks: ItemBanks, key: string, base: string, specialKey: string): { pick: CopyPick | null; tier: number; name: string | null } {
  let onSaleNow: CopyPick | null = null;
  let lastOnSale: CopyPick | null = null;
  let lastListed: CopyPick | null = null;
  let name: string | null = null;
  for (const b of banks) {
    const obs = scraptfObservationsOf(b.saves, key);
    const run = runOfObservations(key, base, specialKey, obs);
    if (!run) continue;
    for (let i = obs.length - 1; i >= 0 && name === null; i--) if (obs[i]!.row?.name) name = obs[i]!.row!.name.trim() || null;
    const newest = obs[obs.length - 1]!;
    if (newest.onSale && better({ bank: b.bank, at: newest.at }, onSaleNow)) onSaleNow = { bank: b.bank, obs, run, at: newest.at };
    if (run.lastSeenAt !== null && better({ bank: b.bank, at: run.lastSeenAt }, lastOnSale)) lastOnSale = { bank: b.bank, obs, run, at: run.lastSeenAt };
    const listedAt = [...obs].reverse().find((o) => o.row !== null)!.at;
    if (better({ bank: b.bank, at: listedAt }, lastListed)) lastListed = { bank: b.bank, obs, run, at: listedAt };
  }
  return { pick: onSaleNow ?? lastOnSale ?? lastListed, tier: onSaleNow ? 0 : lastOnSale ? 1 : 2, name };
}

/**
 * 0.8: the bank one copy's history is read from (copyPickOf's rule, which scraptfItemHistoryOf applies), over the
 * banks' lifecycles instead of their saves: on sale on its newest observation (at lastObsAt), else the one that last
 * had it on sale (its last run's lastOnSaleAt), else the one that last listed it (lastListedAt); a bank page before
 * the /items list, then the newer. Null when no bank has the copy. A test keeps it equal to scraptfItemHistoryOf's bank.
 */
export function scraptfCopyBankOf(banks: readonly { bank: ScraptfBank; life: Pick<ScraptfBankLifecycle, 'copies'> }[], key: string): ScraptfBank | null {
  let onSaleNow: { bank: ScraptfBank; at: UnixMs } | null = null;
  let lastOnSale: { bank: ScraptfBank; at: UnixMs } | null = null;
  let lastListed: { bank: ScraptfBank; at: UnixMs } | null = null;
  for (const b of banks) {
    const c = b.life.copies.get(key);
    if (!c) continue;
    if (c.onSale && better({ bank: b.bank, at: c.lastObsAt }, onSaleNow)) onSaleNow = { bank: b.bank, at: c.lastObsAt };
    const run = c.runs[c.runs.length - 1];
    if (run && better({ bank: b.bank, at: run.lastOnSaleAt }, lastOnSale)) lastOnSale = { bank: b.bank, at: run.lastOnSaleAt };
    if (better({ bank: b.bank, at: c.lastListedAt }, lastListed)) lastListed = { bank: b.bank, at: c.lastListedAt };
  }
  return (onSaleNow ?? lastOnSale ?? lastListed)?.bank ?? null;
}

function keyScrapOf(kp: KeyPriceState | null): Scrap {
  return kp && finite(kp.valueScrap) && kp.valueScrap > 0 ? kp.valueScrap : 0;
}

/**
 * 0.7.3: the special key of the copy 'scraptf.itemHistory' reads. `specialKey` when given (that copy
 * exactly); else the SKU's own copy (its paint, else clean) or a saved copy that differs from it only by
 * a sheen or killstreaker (bankStockIsOwnCopy, the 0.7.2 rule: a specialized or professional item has no
 * copy without one). Of several, the first by scraptfItemHistoryOf's bank rule (on sale on its newest
 * observation, then last on sale, then last listed; a bank page before the list, then the newer), then the
 * cheapest on sale at the key price, then the SKU's exact copy, then the lower key. The own key when no
 * save lists any.
 */
export function scraptfItemCopyOf(a: { sku: string; specialKey?: string | null; banks: ItemBanks; keyPrice: KeyPriceState | null }): string {
  if (typeof a.specialKey === 'string') return a.specialKey;
  const target = bankStockTargetOf(a.sku);
  const own = target?.specialKey ?? BANK_STOCK_PLAIN_KEY;
  if (!target) return own;
  const keys = new Set<string>();
  for (const b of a.banks) for (const s of b.saves) for (const r of s.rows) if (r.specialKey !== own && bankStockIsOwnCopy(r, target)) keys.add(r.specialKey);
  if (keys.size === 0) return own;
  keys.add(own);
  const K = keyScrapOf(a.keyPrice);
  type Candidate = { key: string; tier: number; pick: CopyPick; cost: number };
  const ahead = (x: Candidate, y: Candidate): boolean => {
    if (x.tier !== y.tier) return x.tier < y.tier;
    // `better` is strict: at most one of the two holds.
    if (better(x.pick, y.pick)) return true;
    if (better(y.pick, x.pick)) return false;
    if (x.cost !== y.cost) return x.cost < y.cost;
    if ((x.key === own) !== (y.key === own)) return x.key === own;
    return x.key < y.key;
  };
  let best: Candidate | null = null;
  for (const key of keys) {
    const { pick, tier } = copyPickOf(a.banks, bankStockKey(target.base, key), target.base, key);
    if (!pick) continue;
    const cur = pick.run.current;
    const next: Candidate = { key, tier, pick, cost: cur ? valueScrap(cur.keys, cur.scrap, K) : Infinity };
    if (best === null || ahead(next, best)) best = next;
  }
  return best?.key ?? own;
}

/**
 * 'scraptf.itemHistory' for one copy (`sku`'s base and its paint, or `specialKey` when given; 0.7.3: else
 * scraptfItemCopyOf, a sheen or killstreaker aside) from each bank's retained saves. The history is read
 * from one bank (copyPickOf): the one whose newest observation lists it on
 * sale (a bank page before the /items list, then the newest), else the one that last listed it on sale,
 * else the one that last listed it at all. `events` are this base SKU's stored events valued now (the
 * caller reads them; this keeps the copy's own, newest first, at most SCRAPTF_ITEM_EVENTS price events
 * and, 0.7.1, at most SCRAPTF_ITEM_STOCK_EVENTS 'stock' ones besides). change.hN
 * compares the current price with the newest observation at or before now - N (null when it was not on
 * sale then, or nothing is on sale now); change.listed with the run's first save. All prices are raw keys
 * + metal valued at the key price now.
 */
export function scraptfItemHistoryOf(a: {
  sku: string;
  /**
   * bank_stock.special_key of the copy; null or omitted: the SKU's own (its paint, else a clean copy), 0.7.3:
   * or its copy with a sheen or killstreaker (scraptfItemCopyOf).
   */
  specialKey?: string | null;
  /** Fallback when no retained save names it (the schema's name). */
  name?: string;
  banks: ItemBanks;
  events: readonly ScraptfChangeEvent[];
  keyPrice: KeyPriceState | null;
  now: UnixMs;
}): ScraptfItemHistory {
  const target = bankStockTargetOf(a.sku);
  const base = target?.base ?? a.sku.trim();
  const specialKey = scraptfItemCopyOf(a);
  const key = bankStockKey(base, specialKey);
  const K = keyScrapOf(a.keyPrice);

  const { pick, name } = copyPickOf(a.banks, key, base, specialKey);
  // DM-6: price events and stock moves are capped apart, so 60 stock moves cannot push out a price drop.
  let prices = 0;
  let stocks = 0;
  const events = a.events
    .filter((e) => e.key === key)
    .sort((x, y) => y.id - x.id)
    .filter((e) => (e.kind === 'stock' ? ++stocks <= SCRAPTF_ITEM_STOCK_EVENTS : ++prices <= SCRAPTF_ITEM_EVENTS));
  const empty: ScraptfItemHistory = {
    sku: base,
    specialKey,
    name: name ?? (a.name?.trim() || base),
    bank: null,
    points: [],
    firstSeenAt: null,
    listedSince: null,
    lastSeenAt: null,
    current: null,
    change: { h1: null, h24: null, d7: null, listed: null },
    events,
    keyPrice: a.keyPrice,
    generatedAt: a.now,
  };
  if (!pick) return empty;

  const points: ScraptfHistoryPoint[] = pick.obs.map((o) => {
    const raw = o.onSale && o.row ? rawOf(o.row) : { keys: 0, scrap: 0 };
    return {
      at: o.at,
      bank: pick.bank,
      costKeys: raw.keys,
      costScrapRaw: raw.scrap,
      costScrap: o.onSale ? valueScrap(raw.keys, raw.scrap, K) : 0,
      stock: o.row && finite(o.row.stock) ? o.row.stock : null,
      listed: o.onSale,
    };
  });
  const run = pick.run;
  const cur = run.current;
  const change = (agoMs: number): ScraptfPriceChange | null => {
    if (!cur) return null;
    const cutoff = a.now - agoMs;
    let then: ScraptfObservation | null = null;
    for (const o of pick.obs) if (o.at <= cutoff) then = o;
    if (!then || !then.onSale || !then.row) return null;
    return scraptfPriceChange(rawOf(then.row), cur, then.at, K);
  };
  return {
    ...empty,
    bank: pick.bank,
    points,
    firstSeenAt: run.firstSeenAt,
    listedSince: run.listedSince,
    lastSeenAt: run.lastSeenAt,
    current: cur ? { costScrap: valueScrap(cur.keys, cur.scrap, K), stock: cur.stock, bank: pick.bank } : null,
    change: {
      h1: change(HOUR_MS),
      h24: change(DAY_MS),
      d7: change(7 * DAY_MS),
      listed: cur && run.listedSince !== null && run.runStart ? scraptfPriceChange(run.runStart, cur, run.listedSince, K) : null,
    },
  };
}

/** 0.7.1 (DM-5): a base SKU's listed run as the Live market joins it: when it began and its newest sighting on sale. */
export interface ScraptfListed {
  since: UnixMs;
  lastSeenAt: UnixMs;
  /** 0.8: the copy (bankStockKey) whose run was picked. */
  key?: string;
}

/**
 * Picks the run a base SKU is "listed" by among its copies' runs: the newest sighting first (0.7.1, DM-5:
 * a copy last seen on a page saved weeks ago does not stand for one on the save of an hour ago), then the
 * earliest start (the copies listed on that save, as before). Shared by the history index and the mock.
 */
export function scraptfListedPick(cur: ScraptfListed | null | undefined, next: ScraptfListed): boolean {
  if (!cur) return true;
  if (next.lastSeenAt !== cur.lastSeenAt) return next.lastSeenAt > cur.lastSeenAt;
  return next.since < cur.since;
}

/**
 * 0.7.1 (DM-5): MarketRow.scraptfListedSince and scraptfLastSeenAt for a base SKU from one bank's runs:
 * among the copies of it listed now (any special key), the one seen on sale last (scraptfListedPick), its
 * run's start and newest sighting; null when none is listed. 0.8: and that copy's key (T7's timing reads it).
 */
export function scraptfListedOf(runs: ReadonlyMap<string, ScraptfKeyRun> | null | undefined, baseSku: string): ScraptfListed | null {
  if (!runs) return null;
  let best: ScraptfListed | null = null;
  for (const r of runs.values()) {
    if (r.sku !== baseSku || r.listedSince === null) continue;
    const next = { since: r.listedSince, lastSeenAt: r.lastSeenAt ?? r.listedSince, key: r.key };
    if (scraptfListedPick(best, next)) best = next;
  }
  return best;
}

/**
 * MarketRow.scraptfListedSince for a base SKU from one bank's runs (scraptfListedOf's since), else null.
 * The bank is the row's scraptfLink bank when its source is 'seen'.
 */
export function scraptfListedSinceOf(runs: ReadonlyMap<string, ScraptfKeyRun> | null | undefined, baseSku: string): UnixMs | null {
  return scraptfListedOf(runs, baseSku)?.since ?? null;
}

/**
 * MarketQuery.listedOnScraptf (U5): listed on scrap.tf for at least SCRAPTF_LONG_LISTED_MS, measured to
 * its newest sighting on sale (0.7.1, DM-5: scraptfLastSeenAt - scraptfListedSince), or to `now` when that
 * is not known. A page saved once 60 days ago has listed it for 0, not 60 days.
 */
export function marketListedSideMatches(r: { scraptfListedSince: UnixMs | null; scraptfLastSeenAt?: UnixMs | null }, q: { listedOnScraptf?: boolean }, now: UnixMs): boolean {
  if (q.listedOnScraptf !== true) return true;
  if (!finite(r.scraptfListedSince)) return false;
  const end = finite(r.scraptfLastSeenAt) ? r.scraptfLastSeenAt : now;
  return end - r.scraptfListedSince >= SCRAPTF_LONG_LISTED_MS;
}

// ---------------------------------------------------------------------------
// S5: re-save reminders
// ---------------------------------------------------------------------------

/** "1 h 05 m", "45 m", "2 d 3 h": how long ago a bank was saved, in the reminder's words. */
export function scraptfAgoText(ms: number): string {
  const m = Math.max(0, Math.floor((finite(ms) ? ms : 0) / MIN_MS));
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/**
 * The banks reminded of: settings.import.resaveBanks, where [] means every bank saved at least once,
 * always cut to the banks saved at least once (there is no reminder for a never-saved bank).
 */
export function scraptfResaveBanksOf(chosen: readonly ScraptfBank[] | null | undefined, saved: Iterable<ScraptfBank>): ScraptfBank[] {
  const savedSet = new Set(saved);
  const pickAll = !chosen || chosen.length === 0;
  const wanted = new Set(chosen ?? []);
  const out: ScraptfBank[] = [];
  for (const bank of savedSet) if (scraptfBankInfo(bank) && (pickAll || wanted.has(bank))) out.push(bank);
  return out;
}

/**
 * Whether a bank is due a reminder: saved before, not saved for `minutes` (>= 1), and not reminded in the
 * last `minutes` since that save (one reminder per N minutes; a new save starts over).
 */
export function scraptfResaveDue(a: { minutes: number; lastSavedAt: UnixMs | null; lastRemindedAt: UnixMs | null; now: UnixMs }): boolean {
  if (!finite(a.minutes) || a.minutes < 1 || a.lastSavedAt === null || !finite(a.lastSavedAt)) return false;
  const every = Math.min(SCRAPTF_RESAVE_MAX_MIN, Math.floor(a.minutes)) * MIN_MS;
  if (a.now - a.lastSavedAt < every) return false;
  if (a.lastRemindedAt === null || !finite(a.lastRemindedAt) || a.lastRemindedAt < a.lastSavedAt) return true;
  return a.now - a.lastRemindedAt >= every;
}

/** 0.7.1 (F21-9): the reminder's way to refresh a page, as the user gets their pages in. */
export const SCRAPTF_RESAVE_HOW_FILE = "Save it again (Ctrl+S, 'Webpage, Complete') to refresh prices and see what changed";
export const SCRAPTF_RESAVE_HOW_WINDOW = 'Open it in the Flip Desk window to refresh prices and see what changed';

/** 0.7.1: the user opens scrap.tf links in the Flip Desk window (on, acknowledged, links sent there). */
function linksInWindow(w: Pick<ScraptfWindowSettings, 'enabled' | 'acknowledgedAt' | 'openLinksInWindow'> | null | undefined): boolean {
  return !!w && w.enabled === true && w.acknowledgedAt !== null && w.acknowledgedAt !== undefined && w.openLinksInWindow === true;
}

/**
 * The reminder's notify payload: "Re-save scrap.tf/buy/hats" / "Last saved 1 h 05 m ago. Save it again
 * (Ctrl+S, 'Webpage, Complete') to refresh prices and see what changed", with the bank's static
 * SCRAPTF_BANKS URL as openUrl (main opens it on a click only, after its own allowlist check). Null for
 * an unknown bank. 0.7.1 (F21-9): with the scrap.tf window on and links opening there (`window`, the
 * settings.scraptfWindow), the body says to open it in the Flip Desk window instead; the click still
 * opens the user's browser.
 */
export function scraptfResaveNotice(
  bank: ScraptfBank,
  lastSavedAt: UnixMs,
  now: UnixMs,
  window?: Pick<ScraptfWindowSettings, 'enabled' | 'acknowledgedAt' | 'openLinksInWindow'> | null,
): { title: string; body: string; sku: null; openUrl: string } | null {
  const info = scraptfBankInfo(bank);
  if (!info) return null;
  return {
    title: `Re-save ${bankStockPagePath(info.url)}`,
    body: `Last saved ${scraptfAgoText(now - lastSavedAt)} ago. ${linksInWindow(window) ? SCRAPTF_RESAVE_HOW_WINDOW : SCRAPTF_RESAVE_HOW_FILE}`,
    sku: null,
    openUrl: info.url,
  };
}
