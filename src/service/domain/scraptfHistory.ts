// scrap.tf history (F20): the sequence of the user's saves of each bank page read as price history,
// time listed and a change feed. Built in memory from local data only: the bank_stock snapshots and
// the scraptf_events rows importSavedPage writes (pages the user saved with their own browser, R10),
// and the Live market index's entries for the live buy side. It adds no network traffic and never
// contacts scrap.tf (R1).
//
// The rules (event derivation, runs, item history, valuing, CSV cells) live in
// src/shared/scraptfHistory.ts, shared with the mock and the dashboard; this module keeps their inputs
// in memory (a per-page index of runs, rebuilt after an import and after thinning) and joins the live
// book per read. Never a database query per row.
//
// Shape: every retained save's rows are cached by batch id (rows never change once written, so a save
// is read once; ids the save index no longer lists are dropped), sorted by copy, with a row unchanged
// since the page's previous save sharing that save's object. Per bank, scraptfRunsOf over its saves
// (its pages read together) is the runs index, rebuilt only for a bank whose saves changed, plus a
// per-base "listed since" map so the Live market joins scraptfListedSince with one Map lookup per row.
// An item read bisects each cached save for the one copy it asks about.

import { BANK_STOCK_PLAIN_KEY, bankStockKey, bankStockTargetOf, type BankStockThinSave } from '../../shared/bankStock';
import { SCRAPTF_BANKS, scraptfBankInfo } from '../../shared/links';
import type { PushContract } from '../../shared/rpc';
import {
  SCRAPTF_CHANGES_CSV_COLUMNS,
  SCRAPTF_CHANGES_EXPORT_MAX,
  SCRAPTF_ITEM_EVENTS,
  SCRAPTF_ITEM_STOCK_EVENTS,
  SCRAPTF_PRICE_KINDS,
  scraptfChangeCsvCells,
  scraptfChangeEvent,
  scraptfChangesLimit,
  scraptfEventsOf,
  scraptfItemHistoryOf,
  scraptfKeyStatesOf,
  scraptfListedPick,
  scraptfMarkSuperseded,
  scraptfRunsOf,
  type ScraptfEventBuySide,
  type ScraptfKeyState,
  type ScraptfListed,
  type ScraptfSaveRows,
} from '../../shared/scraptfHistory';
import type {
  BankStockStored,
  KeyPriceState,
  NewScraptfEvent,
  Scrap,
  ScraptfBank,
  ScraptfChangeEvent,
  ScraptfChangesQuery,
  ScraptfEventStored,
  ScraptfItemHistory,
  ScraptfKeyRun,
  UnixMs,
} from '../../shared/types';
import type { Clock, Logger, Repo, ScraptfEventQuery } from '../contracts';
import { toCsv } from './csv';
import { defaultKeyPrice } from './keyprice';
import type { MarketIndex } from './market';

export interface ScraptfHistoryDeps {
  clock: Clock;
  log: Logger;
  /**
   * Saves and rows for the runs index (bankStockSaveIndex once per refresh, bankStockRowsOf for saves not
   * read yet: rows never change once written), and the change feed.
   */
  repo: Pick<Repo, 'bankStockSaveIndex' | 'bankStockRowsOf' | 'insertScraptfEvents' | 'scraptfEvents'>;
  /** Live revenue and Pay up to per base SKU (MarketEval.revenueScrap / maxCostScrap), in memory. */
  market: Pick<MarketIndex, 'entryFor'>;
  /** The engine's key price: values every price per read; decides cheaper / pricier at import. */
  keyPrice(): KeyPriceState;
  /** The schema's name of a SKU (core: schema.nameForSku): an item history's name when no save names it. Optional. */
  nameOf?(sku: string): string | null | undefined;
}

export interface ScraptfHistory {
  /**
   * S2. importSavedPage calls it inside its transaction, right after insertBankStock wrote the rows of
   * batch `batchId` (a recognised bank page with at least one row). It compares that save with the
   * previous save of the same page (scraptfEventsOf, F17's diff rules plus restocked / stock; `seenBefore`
   * from the runs before this save) and writes the events (repo.insertScraptfEvents) in that transaction.
   * Writes none for a first save of a page, a save not newer than the page's newest stored save (out of
   * order, or the same file again), or a 0-row save. Returns the events written; the caller pushes
   * 'scraptf.changed' { at, count } after the commit when count > 0. Throws only what the repo throws
   * (rolling the import back), never for a missing previous save.
   */
  onImport(batchId: number): number;
  /**
   * S3 'scraptf.itemHistory': one copy's history (scraptfItemHistoryOf over the runs index's saves), events
   * valued now. 0.7.1 (DM-6): its newest SCRAPTF_ITEM_EVENTS price events and, apart from them, its newest
   * SCRAPTF_ITEM_STOCK_EVENTS stock moves, newest first in `events`. Never throws.
   */
  itemHistory(sku: string, special: string | null | undefined, now: UnixMs): ScraptfItemHistory;
  /**
   * S4 'scraptf.changes': the feed newest first, valued at the key price now and joined to market.entryFor
   * of each base SKU. 0.7.1 (ACT-10): `flip` only on a copy's newest event while it is on sale; a
   * superseded one has wasFlip. Never throws.
   */
  changes(q: ScraptfChangesQuery, now: UnixMs): ScraptfChangeEvent[];
  /**
   * S3 runs index of one bank (scraptfRunsOf over its retained saves, its pages read together), keyed by
   * bankStockKey: BankStock joins BankStockRow.listedSince / firstSeenAt / changeSinceListed from it (pass
   * `run` to bankStockRow). Memoised per refresh; an empty map for a bank never saved.
   */
  runsFor(bank: ScraptfBank): ReadonlyMap<string, ScraptfKeyRun>;
  /**
   * MarketRow.scraptfListedSince: scraptfListedSinceOf(runsFor(bank), baseSku), `bank` being the row's
   * scraptfLink bank when its source is 'seen'; without a bank, the bank a saved page lists it on now (a
   * bank page before the list, then the newer sighting). Null when not listed now. In memory only.
   */
  listedSinceFor(baseSku: string, bank?: ScraptfBank | null): UnixMs | null;
  /**
   * 0.7.1 (DM-5): listedSinceFor with its newest sighting on sale (MarketRow.scraptfLastSeenAt), so the
   * "Listed > 24 h" filter measures lastSeenAt - since. The same bank rule; null when not listed now.
   */
  listedFor(baseSku: string, bank?: ScraptfBank | null): ScraptfListed | null;
  /**
   * Brings the runs index up to the retained saves (core: after an import that wrote bank stock, after
   * maintenance thinned or pruned). A key price move needs none: runs hold raw keys + metal, valued per
   * read. Never throws.
   */
  refresh(): void;
  /** opps.exportCsv kind 'scraptfChanges': SCRAPTF_CHANGES_CSV_COLUMNS over changes(q without beforeId/limit, at most SCRAPTF_CHANGES_EXPORT_MAX). */
  csv(q: ScraptfChangesQuery, now: UnixMs): string;
  /** Grows whenever a refresh changed the runs: the market and the bank stock key their cached passes on it. */
  version(): number;
}

/** After a failed read, reads retry at most this often (refresh() retries at once), as BANK_STOCK_RETRY_MS. */
export const SCRAPTF_HISTORY_RETRY_MS = 10_000;
/** The string pool is dropped past this many distinct strings (SKUs, names and copy keys of every kept save). */
const INTERN_MAX = 200_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** opps.exportCsv {kind:'scraptfChanges'}: SCRAPTF_CHANGES_CSV_COLUMNS, money as keys + ref, missing values blank. */
export function scraptfChangesCsv(events: readonly ScraptfChangeEvent[], keyScrap: Scrap | null): string {
  return toCsv([SCRAPTF_CHANGES_CSV_COLUMNS, ...events.map((e) => scraptfChangeCsvCells(e, keyScrap))]);
}

/** The 'scraptf.changed' payload after an import that wrote `count` events of a save at `at`. */
export function scraptfChangedPush(at: UnixMs, count: number): PushContract['scraptf.changed'] {
  return { at, count };
}

/** One retained save in memory: its rows, compacted and sorted by SKU then copy (rowIn's binary search). */
interface CachedSave extends ScraptfSaveRows {
  bank: ScraptfBank;
  rows: BankStockStored[];
}

/** Rows ordered by SKU, then special key (the repo's own order for ASCII SKUs), so a copy is found by bisection. */
function byCopy(a: Pick<BankStockStored, 'sku' | 'specialKey'>, b: Pick<BankStockStored, 'sku' | 'specialKey'>): number {
  if (a.sku !== b.sku) return a.sku < b.sku ? -1 : 1;
  return a.specialKey < b.specialKey ? -1 : a.specialKey > b.specialKey ? 1 : 0;
}

/** One copy's row of a save (rows sorted byCopy), or null. O(log rows): an item read needs no key map per save. */
function rowIn(rows: readonly BankStockStored[], target: Pick<BankStockStored, 'sku' | 'specialKey'>): BankStockStored | null {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = byCopy(rows[mid]!, target);
    if (c === 0) return rows[mid]!;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function sameRow(a: BankStockStored, b: BankStockStored): boolean {
  return a.sku === b.sku && a.specialKey === b.specialKey && a.name === b.name && a.costKeys === b.costKeys && a.costScrap === b.costScrap && a.stock === b.stock;
}

/**
 * Two saves of a page mostly list the same rows: an unchanged row reuses the earlier save's object (rows
 * are never written to), so a page kept 300 times costs about one copy of its rows. Both sorted byCopy.
 */
function shareRows(rows: BankStockStored[], earlier: readonly BankStockStored[]): void {
  let j = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    while (j < earlier.length && byCopy(earlier[j]!, r) < 0) j++;
    if (j < earlier.length && sameRow(earlier[j]!, r)) rows[i] = earlier[j]!;
  }
}

/** One bank's saves (oldest first), their runs and, per base SKU, the copies listed now. */
interface BankHistory {
  saves: CachedSave[];
  runs: Map<string, ScraptfKeyRun>;
  /**
   * Per base SKU: the run it is listed by (scraptfListedOf: the copy seen on sale last, then the earliest
   * start), its start and its newest sighting.
   */
  listed: Map<string, ScraptfListed>;
  /** 0.7.1 (ACT-10): each copy's current state (scraptfKeyStatesOf), built on the first feed read. */
  states: Map<string, ScraptfKeyState> | null;
}

/**
 * scraptfListedOf for every base at once (one pass over the runs, so a market read is a Map lookup). 0.7.1
 * (DM-5): start and sighting come from one run, so a copy last seen weeks ago never lends its start to a
 * copy on today's save (the span is lastSeenAt - since).
 */
function listedOf(runs: ReadonlyMap<string, ScraptfKeyRun>): Map<string, ScraptfListed> {
  const out = new Map<string, ScraptfListed>();
  for (const r of runs.values()) {
    if (r.listedSince === null) continue;
    const next = { since: r.listedSince, lastSeenAt: r.lastSeenAt ?? r.listedSince };
    if (scraptfListedPick(out.get(r.sku), next)) out.set(r.sku, next);
  }
  return out;
}

/** The base SKU a feed filter names (paint moved out, as bank_stock stores it); the text itself when unparsable. */
function baseOf(sku: string): string {
  return bankStockTargetOf(sku)?.base ?? sku.trim();
}

export function createScraptfHistory(deps: ScraptfHistoryDeps): ScraptfHistory {
  const { log, repo } = deps;
  const empty: ReadonlyMap<string, ScraptfKeyRun> = new Map();
  const noStates: ReadonlyMap<string, ScraptfKeyState> = new Map();
  /** Every retained save's rows by batch id (only saves of SCRAPTF_BANKS banks). */
  const saves = new Map<number, CachedSave>();
  const banks = new Map<ScraptfBank, BankHistory>();
  /** listedSinceFor without a bank: per base, the bank listing it now (a bank page before the list, then newer). Rebuilt lazily. */
  let anyBank: Map<string, ScraptfListed & { bank: ScraptfBank }> | null = null;
  // The same SKUs and names repeat on every save of a page: one string each keeps the cache small.
  const pool = new Map<string, string>();
  let ver = 0;
  // Nothing is read until first use; a failed read stays stale so a later use retries.
  let stale = true;
  let failing = false;
  let retryAt: UnixMs | null = null;
  let lastKeyPrice: KeyPriceState | null = null;
  let keyFailing = false;

  function now(): UnixMs {
    try {
      return deps.clock.now();
    } catch {
      return Date.now();
    }
  }

  /** The last good key price stands in for a failed or empty read, then the default (logged once per failure streak). */
  function readKeyPrice(): KeyPriceState {
    try {
      const kp = deps.keyPrice();
      if (kp && finite(kp.valueScrap) && kp.valueScrap > 0) {
        lastKeyPrice = kp;
        keyFailing = false;
        return kp;
      }
    } catch (err) {
      if (!keyFailing) log.warn('scrap.tf history could not read the key price', { error: errorText(err) });
      keyFailing = true;
    }
    return lastKeyPrice ?? defaultKeyPrice();
  }

  function intern(s: string): string {
    const hit = pool.get(s);
    if (hit !== undefined) return hit;
    if (pool.size >= INTERN_MAX) pool.clear();
    pool.set(s, s);
    return s;
  }

  /** What the history reads of a row; the asset id is never read, so it is not kept. */
  function compact(r: BankStockStored): BankStockStored {
    return {
      sku: intern(r.sku),
      specialKey: intern(r.specialKey),
      name: intern(r.name),
      costKeys: r.costKeys,
      costScrap: r.costScrap,
      stock: r.stock,
      assetId: null,
    };
  }

  /**
   * Brings the cache to `index` (Repo.bankStockSaveIndex), leaving `exclude` out (onImport: the save its
   * own transaction is writing, which may still roll back). Reads only the rows of saves not cached yet,
   * all before changing anything, so a failed read leaves the last good index. Rebuilds the runs of each
   * bank whose saves changed. Returns whether anything changed.
   */
  function sync(index: readonly BankStockThinSave[], exclude: number | null): boolean {
    const listed = new Map<number, BankStockThinSave>();
    for (const s of index) if (s.batchId !== exclude && scraptfBankInfo(s.bank)) listed.set(s.batchId, s);
    const drop = new Set<number>();
    for (const [id, c] of saves) {
      const s = listed.get(id);
      if (!s || s.savedAt !== c.savedAt || s.bank !== c.bank || s.page !== c.page) drop.add(id);
    }
    const missing: number[] = [];
    for (const id of listed.keys()) if (!saves.has(id) || drop.has(id)) missing.push(id);
    const rows = missing.length > 0 ? repo.bankStockRowsOf(missing) : new Map<number, BankStockStored[]>();
    const changed = new Set<ScraptfBank>();
    for (const id of drop) {
      changed.add(saves.get(id)!.bank);
      saves.delete(id);
    }
    // Oldest first (the index's order), so each new save shares rows with the save of its page before it.
    const lastOfPage = new Map<string, CachedSave>();
    for (const [id, s] of listed) {
      const pageKey = `${s.bank}\u0000${s.page}`;
      const cached = saves.get(id);
      if (cached) {
        lastOfPage.set(pageKey, cached);
        continue;
      }
      const r = rows.get(id);
      // Gone between the two reads (a prune): the next refresh sees the index without it.
      if (!r || r.length === 0) continue;
      const own = r.map(compact).sort(byCopy);
      const earlier = lastOfPage.get(pageKey);
      if (earlier) shareRows(own, earlier.rows);
      const save: CachedSave = { batchId: id, savedAt: s.savedAt, bank: s.bank, page: s.page, rows: own };
      saves.set(id, save);
      lastOfPage.set(pageKey, save);
      changed.add(s.bank);
    }
    if (changed.size === 0) return false;
    // Grouped once, so a refresh stays linear in the saves however many banks changed.
    const byBank = new Map<ScraptfBank, CachedSave[]>();
    for (const s of saves.values()) {
      if (!changed.has(s.bank)) continue;
      let g = byBank.get(s.bank);
      if (!g) byBank.set(s.bank, (g = []));
      g.push(s);
    }
    for (const bank of changed) {
      const mine = (byBank.get(bank) ?? []).sort((a, b) => a.savedAt - b.savedAt || a.batchId - b.batchId);
      if (mine.length === 0) {
        banks.delete(bank);
        continue;
      }
      // Only this bank's runs move: the others keep theirs.
      const runs = scraptfRunsOf(mine);
      banks.set(bank, { saves: mine, runs, listed: listedOf(runs), states: null });
    }
    anyBank = null;
    ver++;
    return true;
  }

  function load(): void {
    sync(repo.bankStockSaveIndex(), null);
  }

  function ensure(force = false): void {
    if (!stale) return;
    if (!force && retryAt !== null && now() < retryAt) return;
    try {
      load();
      stale = false;
      failing = false;
      retryAt = null;
    } catch (err) {
      // The last good index stays; logged once per failure streak, not once per read.
      if (!failing) log.warn('scrap.tf history could not read the saved pages', { error: errorText(err) });
      failing = true;
      retryAt = now() + SCRAPTF_HISTORY_RETRY_MS;
    }
  }

  function anyBankMap(): Map<string, ScraptfListed & { bank: ScraptfBank }> {
    if (anyBank !== null) return anyBank;
    const out = new Map<string, ScraptfListed & { bank: ScraptfBank }>();
    for (const info of SCRAPTF_BANKS) {
      const b = banks.get(info.bank);
      if (!b) continue;
      for (const [base, l] of b.listed) {
        const cur = out.get(base);
        // preferScraptfSeen's order: a bank page beats the /items list, then the newer sighting.
        const better =
          !cur ||
          (cur.bank === 'list' && info.bank !== 'list') ||
          ((cur.bank === 'list') === (info.bank === 'list') && l.lastSeenAt > cur.lastSeenAt);
        if (better) out.set(base, { bank: info.bank, since: l.since, lastSeenAt: l.lastSeenAt });
      }
    }
    anyBank = out;
    return out;
  }

  function entryOf(sku: string): ScraptfEventBuySide | null {
    try {
      return deps.market.entryFor(sku) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * ACT-10: a bank's copy states (scraptfKeyStatesOf over its cached saves), built once per runs rebuild;
   * an empty map for a bank with no retained save (none of its events is current), null while the saves
   * could not be read (events then stay as they are).
   */
  function statesOf(bank: ScraptfBank): ReadonlyMap<string, ScraptfKeyState> | null {
    if (failing) return null;
    const b = banks.get(bank);
    if (!b) return noStates;
    if (b.states === null) b.states = scraptfKeyStatesOf(b.saves);
    return b.states;
  }

  /**
   * Stored events valued at `K` and joined to the live buy side of their base SKU (one entryFor per base);
   * 0.7.1 (ACT-10) a superseded flip keeps flip false and gets wasFlip (scraptfMarkSuperseded), from the
   * saves in memory.
   */
  function valued(list: readonly ScraptfEventStored[], K: Scrap): ScraptfChangeEvent[] {
    const buy = new Map<string, ScraptfEventBuySide | null>();
    const out = list.map((e) => {
      let b = buy.get(e.sku);
      if (b === undefined) buy.set(e.sku, (b = entryOf(e.sku)));
      return scraptfChangeEvent(e, K, b);
    });
    if (!out.some((e) => e.flip)) return out;
    try {
      ensure();
      return scraptfMarkSuperseded(out, statesOf);
    } catch (err) {
      log.warn('scrap.tf history could not tell superseded flips', { error: errorText(err) });
      return out;
    }
  }

  function feedQuery(q: ScraptfChangesQuery | null | undefined): ScraptfEventQuery {
    const out: ScraptfEventQuery = {};
    if (!q) return out;
    if (q.bank !== undefined) out.bank = q.bank;
    if (Array.isArray(q.kinds) && q.kinds.length > 0) out.kinds = q.kinds;
    if (typeof q.sku === 'string' && q.sku.trim() !== '') out.sku = baseOf(q.sku);
    if (finite(q.beforeId)) out.beforeId = q.beforeId;
    return out;
  }

  function newestOf<S extends { savedAt: UnixMs; batchId: number }>(a: S | null, b: S): S {
    return a === null || b.savedAt > a.savedAt || (b.savedAt === a.savedAt && b.batchId > a.batchId) ? b : a;
  }

  /**
   * Rows of saves the cache holds, else read in one go (onImport: the previous save and other pages'
   * newest saves when the cache could not be brought up to date).
   */
  function rowsOfSaves(ids: readonly number[]): Map<number, readonly BankStockStored[]> {
    const out = new Map<number, readonly BankStockStored[]>();
    const missing: number[] = [];
    for (const id of ids) {
      const c = saves.get(id);
      if (c) out.set(id, c.rows);
      else missing.push(id);
    }
    // Sorted like the cache's (rowIn bisects them); the repo already returns them nearly so.
    if (missing.length > 0) for (const [id, rows] of repo.bankStockRowsOf(missing)) out.set(id, rows.sort(byCopy));
    return out;
  }

  function onImport(batchId: number): number {
    if (!Number.isSafeInteger(batchId) || batchId <= 0) return 0;
    const index = repo.bankStockSaveIndex();
    // A 0-row save is not in the index: nothing to compare (F18 S3).
    const self = index.find((s) => s.batchId === batchId);
    if (!self || !scraptfBankInfo(self.bank)) return 0;
    // A new save the cache does not hold: the next read takes it once committed, even before core's refresh.
    stale = true;
    let previous: BankStockThinSave | null = null;
    /** The newest save of each other page of the bank. */
    const otherPages = new Map<string, BankStockThinSave>();
    for (const s of index) {
      if (s.batchId === batchId || s.bank !== self.bank) continue;
      if (s.page !== self.page) {
        otherPages.set(s.page, newestOf(otherPages.get(s.page) ?? null, s));
        continue;
      }
      // Out of time order, or the same file again (a save's time is its file's mtime): no events.
      if (s.savedAt >= self.savedAt) return 0;
      previous = newestOf(previous, s);
    }
    // A first save of the page compares with nothing.
    if (previous === null) return 0;

    // The runs before this save (seenBefore): the cache brought up to the committed saves, this one
    // left out, so a rollback leaves nothing of it behind. A failed sync only loses 'restocked'.
    try {
      sync(index, batchId);
      failing = false;
      retryAt = null;
    } catch (err) {
      if (!failing) log.warn('scrap.tf history could not read the saved pages', { error: errorText(err) });
      failing = true;
      retryAt = now() + SCRAPTF_HISTORY_RETRY_MS;
    }
    const newest = repo.bankStockRowsOf([batchId]).get(batchId) ?? [];
    if (newest.length === 0) return 0;
    const rows = rowsOfSaves([previous.batchId]);
    const runs = banks.get(self.bank)?.runs ?? empty;
    let events: NewScraptfEvent[];
    try {
      events = scraptfEventsOf({
        bank: self.bank,
        page: self.page,
        at: self.savedAt,
        batchId,
        newest,
        previous: rows.get(previous.batchId) ?? [],
        keyScrap: readKeyPrice().valueScrap,
        // Listed by a retained save of the bank (any page) from before this one.
        seenBefore: (key) => {
          const run = runs.get(key);
          return run !== undefined && run.seenAt < self.savedAt;
        },
      });
    } catch (err) {
      // The rules are pure; a bug there must not cost the user the import.
      log.warn('scrap.tf history could not derive the changes of a save', { error: errorText(err) });
      return 0;
    }
    if (events.length === 0) return 0;
    if (otherPages.size > 0 && events.some((e) => e.kind === 'gone')) {
      // A bank shows its pages together (bankStockMergePages): an item another page's newest save lists
      // moved there (scrap.tf/items/2 -> /items/3) and is not gone from the bank, as the stock page shows it.
      const onSelf = new Set(newest.map((r) => bankStockKey(r.sku, r.specialKey)));
      const otherRows = rowsOfSaves([...otherPages.values()].map((s) => s.batchId));
      const others = [...otherRows.values()];
      events = events.filter((e) => e.kind !== 'gone' || onSelf.has(bankStockKey(e.sku, e.specialKey)) || !others.some((o) => rowIn(o, e) !== null));
      if (events.length === 0) return 0;
    }
    return repo.insertScraptfEvents(events);
  }

  return {
    onImport,

    itemHistory(sku, special, at) {
      const kp = readKeyPrice();
      const text = typeof sku === 'string' ? sku : '';
      let name: string | undefined;
      try {
        const n = deps.nameOf?.(baseOf(text));
        if (typeof n === 'string' && n.trim()) name = n;
      } catch {
        name = undefined;
      }
      const specialKey = typeof special === 'string' ? special : null;
      try {
        ensure();
        const base = baseOf(text);
        // The copy as scraptfItemHistoryOf reads it: the SKU's base, and `special` or else the SKU's paint.
        const copy = { sku: base, specialKey: specialKey ?? bankStockTargetOf(text)?.specialKey ?? BANK_STOCK_PLAIN_KEY };
        // Each save narrowed to that copy's row (a bisection per save), so the shared rule reads no other row.
        const list: { bank: ScraptfBank; saves: ScraptfSaveRows[] }[] = [];
        for (const info of SCRAPTF_BANKS) {
          const b = banks.get(info.bank);
          if (!b) continue;
          list.push({
            bank: info.bank,
            saves: b.saves.map((s) => {
              const row = rowIn(s.rows, copy);
              return { batchId: s.batchId, savedAt: s.savedAt, page: s.page, rows: row ? [row] : [] };
            }),
          });
        }
        // Only this copy's newest events: a busy clean copy (a 'stock' event per save) must not push a
        // painted copy's few events out of a per-base read. DM-6: price events and stock moves are read
        // apart, so a page saved every few minutes cannot push its price drops out with stock moves.
        const own = { sku: base, specialKey: copy.specialKey };
        const stored = base
          ? [...repo.scraptfEvents({ ...own, kinds: SCRAPTF_PRICE_KINDS, limit: SCRAPTF_ITEM_EVENTS }), ...repo.scraptfEvents({ ...own, kinds: ['stock'], limit: SCRAPTF_ITEM_STOCK_EVENTS })].sort((x, y) => y.id - x.id)
          : [];
        const events = valued(stored, kp.valueScrap);
        return scraptfItemHistoryOf({ sku: text, specialKey, ...(name ? { name } : {}), banks: list, events, keyPrice: kp, now: at });
      } catch (err) {
        log.warn('scrap.tf history could not read an item', { error: errorText(err) });
        return scraptfItemHistoryOf({ sku: text, specialKey, ...(name ? { name } : {}), banks: [], events: [], keyPrice: kp, now: at });
      }
    },

    changes(q) {
      try {
        const events = repo.scraptfEvents({ ...feedQuery(q), limit: scraptfChangesLimit(q?.limit) });
        return valued(events, readKeyPrice().valueScrap);
      } catch (err) {
        log.warn('scrap.tf history could not read the change feed', { error: errorText(err) });
        return [];
      }
    },

    runsFor(bank) {
      ensure();
      return banks.get(bank)?.runs ?? empty;
    },

    listedSinceFor(baseSku, bank) {
      if (typeof baseSku !== 'string') return null;
      ensure();
      if (bank !== undefined && bank !== null) return banks.get(bank)?.listed.get(baseSku)?.since ?? null;
      return anyBankMap().get(baseSku)?.since ?? null;
    },

    listedFor(baseSku, bank) {
      if (typeof baseSku !== 'string') return null;
      ensure();
      const l = bank !== undefined && bank !== null ? banks.get(bank)?.listed.get(baseSku) : anyBankMap().get(baseSku);
      return l ? { since: l.since, lastSeenAt: l.lastSeenAt } : null;
    },

    refresh() {
      stale = true;
      ensure(true);
    },

    csv(q) {
      const K = readKeyPrice().valueScrap;
      try {
        // The file is the feed's filters only (the handler drops paging): its newest events.
        const { beforeId: _beforeId, ...filters } = feedQuery(q);
        return scraptfChangesCsv(valued(repo.scraptfEvents({ ...filters, limit: SCRAPTF_CHANGES_EXPORT_MAX }), K), K);
      } catch (err) {
        log.warn('scrap.tf history could not export the change feed', { error: errorText(err) });
        return scraptfChangesCsv([], K);
      }
    },

    version() {
      ensure();
      return ver;
    },
  };
}
