// scrap.tf history (F20) rules shared by the service's history index, the browser mock and the
// dashboard, so all three derive change events, time listed and item history from the user's saves
// the same way (as bankStock.ts does for F17). Pure: no I/O, no network. Every input is a page the
// user saved from their own browser (R10); nothing here fetches or builds a scrap.tf URL (R1). The
// one URL this module hands out (a reminder's openUrl) is a SCRAPTF_BANKS entry, never item data.
//
// Matching and the new / gone / cheaper / pricier rules are F17's (diffBankStock, bankStockOnSale);
// this module only adds 'restocked' and 'stock' and reads a sequence of saves instead of a pair.

import {
  BANK_STOCK_PLAIN_KEY,
  SCRAPTF_LONG_LISTED_MS,
  bankStockIsOwnCopy,
  bankStockKey,
  bankStockOnSale,
  bankStockPagePath,
  bankStockTargetOf,
  diffBankStock,
  scraptfPriceChange,
} from './bankStock';
import { formatScrap, valueScrap } from './currency';
import { scraptfBankInfo } from './links';
import type {
  BankStockStored,
  KeyPriceState,
  NewScraptfEvent,
  Scrap,
  ScraptfBank,
  ScraptfChangeEvent,
  ScraptfChangeKind,
  ScraptfEventStored,
  ScraptfHistoryPoint,
  ScraptfItemHistory,
  ScraptfKeyRun,
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
    if (d.change === 'new') kind = prev !== null || a.seenBefore?.(d.key) === true ? 'restocked' : 'new';
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
 * A stored event valued at `keyScrap` and joined to `buy` (null: no eligible buyer). flip: the new
 * price is at or under Pay up to now (a 'gone' event has no new price, so never a flip).
 */
export function scraptfChangeEvent(e: ScraptfEventStored, keyScrap: Scrap, buy: ScraptfEventBuySide | null): ScraptfChangeEvent {
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

/**
 * 0.7.1 (ACT-10): per copy (bankStockKey), its current state across one bank's retained saves, by
 * scraptfRunsOf's home-page rule (a save of another page that does not list it says nothing). From the
 * saves in memory, never a query. O(rows + observations).
 */
export function scraptfKeyStatesOf(saves: readonly ScraptfSaveRows[]): Map<string, ScraptfKeyState> {
  interface St {
    state: ScraptfKeyState;
    home: string;
    last: BankStockStored | null;
    lastAt: UnixMs;
  }
  const states = new Map<string, St>();
  const homeKeys = new Map<string, Set<string>>();
  const homeOf = (page: string): Set<string> => {
    let s = homeKeys.get(page);
    if (!s) homeKeys.set(page, (s = new Set()));
    return s;
  };
  const see = (st: St, at: UnixMs, row: BankStockStored | null): void => {
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
  };
  for (const save of oldestFirst(saves)) {
    const listedHere = new Set<string>();
    for (const row of save.rows) {
      const key = bankStockKey(row.sku, row.specialKey);
      if (listedHere.has(key)) continue;
      listedHere.add(key);
      const st = states.get(key);
      if (!st) {
        states.set(key, { state: { onSale: bankStockOnSale(row), since: save.savedAt, prevAt: null, priceSince: save.savedAt, pricePrevAt: null }, home: save.page, last: row, lastAt: save.savedAt });
        homeOf(save.page).add(key);
        continue;
      }
      if (st.home !== save.page) {
        homeKeys.get(st.home)?.delete(key);
        st.home = save.page;
        homeOf(save.page).add(key);
      }
      see(st, save.savedAt, row);
    }
    for (const key of homeKeys.get(save.page) ?? []) {
      if (!listedHere.has(key)) see(states.get(key)!, save.savedAt, null);
    }
  }
  const out = new Map<string, ScraptfKeyState>();
  for (const [key, st] of states) out.set(key, st.state);
  return out;
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
 * run's start and newest sighting; null when none is listed.
 */
export function scraptfListedOf(runs: ReadonlyMap<string, ScraptfKeyRun> | null | undefined, baseSku: string): ScraptfListed | null {
  if (!runs) return null;
  let best: ScraptfListed | null = null;
  for (const r of runs.values()) {
    if (r.sku !== baseSku || r.listedSince === null) continue;
    const next = { since: r.listedSince, lastSeenAt: r.lastSeenAt ?? r.listedSince };
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
