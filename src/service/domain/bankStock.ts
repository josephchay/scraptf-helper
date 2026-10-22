// scrap.tf bank stock (F17): every item on each scrap.tf bank page the user saved,
// what changed between their two newest saves of it, and each item joined to live
// backpack.tf data from the Live market index. Built in memory from local data:
// the bank_stock snapshots importSavedPage writes (pages the user saved with their
// own browser, R10) and the market index's entries. It adds no network traffic and
// never contacts scrap.tf (R1).
//
// The rules (diff, rows, filters, counts, order, CSV cells, market and drawer joins,
// notification texts) live in src/shared/bankStock.ts, shared with the mock and the
// dashboard; this module only keeps their inputs in memory and joins the live book.
//
// Shape: refresh() reads, per SCRAPTF_BANKS bank, its kept saves (newest first) and
// pairs them by page (bankStockPagePairs: /items/2 is only compared with an earlier
// /items/2, never with /items), reading the rows of each page's newest save, its session
// baseline (0.7.1, CQ-2: the newest save from before the session of window reads the
// newest belongs to) and the save just before it (the newest from an earlier time, so a
// page imported twice does not diff against itself). Each page keeps two diffs at the
// engine's key price: `diff` (newest vs baseline: the stock page, "What's new", New
// badges, the drawer) and `stepDiff` (newest vs previous: S3's notifications, one read
// at a time), merged over the bank's pages (bankStockMergePages). Pages far older than
// the bank's newest (DM-5) are left out of the stock page and "What's new". A save's rows
// never change once written, so they are cached by batch id and only a new save is read.
// list()/all()/whatsNew() join each kept diff row to market.entryFor(base) per call, so
// verdicts follow the live book with no query at all; newAtFor, detailFor and seenFor
// (F19) read the kept diffs only. F20: the rows' time listed comes from the scrap.tf
// history's runs index (deps.history.runsFor, one in-memory map per read).

import {
  BANK_STOCK_CSV_COLUMNS,
  BANK_STOCK_MAX_NOTIFICATIONS,
  BANK_STOCK_MAX_PAGES,
  BANK_STOCK_NEW_MAX_AGE_MS,
  BANK_STOCK_NOTIFY_DEDUP_MS,
  BANK_STOCK_SESSION_READ,
  bankStockCounts,
  bankStockCsvCells,
  bankStockCurrentPages,
  bankStockDroppedIntoFlip,
  bankStockItemOf,
  bankStockPricesOf,
  bankStockMatching,
  bankStockMergePages,
  bankStockNewAt,
  bankStockPagePairs,
  bankStockResult,
  bankStockRow,
  bankStockWhatsNew,
  diffBankStock,
  emptyBankStockResult,
  type BankStockBankDiff,
  type BankStockBuySide,
  type BankStockDiffRow,
  type BankStockPagePair,
  type BankStockPageSave,
} from '../../shared/bankStock';
import { costSanity, type CeilingSettings } from '../../shared/ceiling';
import { SCRAPTF_BANKS, preferScraptfSeen, scraptfBankInfo, type ScraptfSeen } from '../../shared/links';
import type { PushContract } from '../../shared/rpc';
import type {
  BankStockQuery,
  BankStockResult,
  BankStockRow,
  BankStockSave,
  BankStockStored,
  Category,
  ItemDetail,
  KeyPriceState,
  Scrap,
  ScraptfBank,
  ScraptfBankSummary,
  ScraptfKeyRun,
  ScraptfTimingBrief,
  ScraptfTurnover,
  Settings,
  UnixMs,
} from '../../shared/types';
import type { Clock, Logger, Repo, SchemaService } from '../contracts';
import { isSuspectMargin } from './confidence';
import { toCsv } from './csv';
import { notifyKinds } from './engine';
import { defaultKeyPrice } from './keyprice';
import type { MarketEval, MarketIndex } from './market';
import { lookupReferences, lookupTwinReferences, referencePrices, usableReferences, type RawReferences } from './pricing';
import type { ScraptfHistory, ScraptfTimingInputs } from './scraptfHistory';
import { scraptfTimingBrief } from '../../shared/scraptfTiming';
import {
  bankStockNoticeOf,
  bankStockNotifyCandidates,
  bankStockNotifyKey,
  bankStockOldSaveSummary,
  bankStockSummaryChip,
  bankStockSummaryNotice,
  bankStockTimingNext,
  bankStockTimingParse,
  bankStockWaitKey,
  type BankStockLook,
  type BankStockNotifyCandidate,
  type BankStockWaitMemo,
} from '../../shared/bankStockNotify';
import { scraptfIsRestock, scraptfSeenBefore } from '../../shared/scraptfHistory';
import { EMPTY_WATCH_INDEX, watchJoinOf, type ScraptfWatchIndex, type WatchPageRows } from '../../shared/watches';

/**
 * Repo meta key of the S3 notification dedupe: JSON { "<bank>|<sku>": notifiedAt }, entries older than
 * BANK_STOCK_NOTIFY_DEDUP_MS dropped on write (as holdings.lastNotified), so a restart notifies nothing twice.
 */
export const BANK_STOCK_NOTIFY_META_KEY = 'bankStock.lastNotified';

export interface BankStockDeps {
  clock: Clock;
  log: Logger;
  /** Read by refresh() only (each bank's saves and the rows of a save not read yet), never per list() row. */
  repo: Pick<Repo, 'bankStockSaves' | 'bankStockRows' | 'bankStockLatestPair'>;
  /** The Live market index: revenue, buyers, Pay up to and confidence per base SKU, in memory. */
  market: Pick<MarketIndex, 'entryFor'>;
  /** The engine's key price: values keys, and decides cheaper/pricier when the keys differ. */
  keyPrice(): KeyPriceState;
  /** settings.profit for friction, profitStatus and the verdict. */
  settings(): Settings;
  /** A base SKU's category as the Live market files it (core: marketCategoryOf(schema, sku)). */
  categoryOf(sku: string): Category;
  /**
   * Whether the item schema has loaded (core: schema.isLoaded). Categories read before it are a guess
   * from the SKU alone, so the memo is dropped when it flips (as the market's checkSchema). Optional.
   */
  schemaLoaded?(): boolean;
  /**
   * F20: the runs index of the user's saves (core's ScraptfHistory, late-bound): BankStockRow.listedSince,
   * firstSeenAt and changeSinceListed come from runsFor(bank), one Map per read, never a query per row.
   * Omitted (tests, 0.6): those fields are null. 0.8 (T4, LC-4): timingFor, when given, joins each on-sale row's
   * buy-timing brief (BankStockRow.timing) in list() and all(), and turnoverFor the result's turnover in list().
   */
  history?: Pick<ScraptfHistory, 'runsFor'> & Partial<Pick<ScraptfHistory, 'timingFor' | 'turnoverFor'>>;
  /**
   * 0.7.4 (F22, F70): whether a row's scrap.tf price is probably another copy's (costSanity's
   * 'variant-suspect' or 'cost-below-market' against the item's age-gated PriceDB price and its craftability
   * twin's; core: bankStockCostCheck). Such a row is left out of newFlips and pageFlips, as the engine never
   * toasts one. Asked only for flip rows; a failing check counts as not suspect. Optional.
   */
  costSuspect?(baseSku: string, costScrap: Scrap, now: UnixMs): boolean;
  /** 0.8 (G1): the enabled watches by base (core: the watch cache's index()): BankStockRow.watch on every row read. Omitted or failing: none. */
  watches?(): ScraptfWatchIndex;
}

/** What bankStockCostCheck reads: PriceDB and community rows (local), the key price and the reference age gate. */
export interface BankStockCostCheckDeps {
  repo: Pick<Repo, 'getPricedb' | 'getSkuAlias' | 'getCommunity'>;
  schema?: Pick<SchemaService, 'bookBase'> | null;
  keyPrice(): KeyPriceState;
  settings(): Settings;
}

/**
 * 0.7.4 (F22, F70): BankStockDeps.costSuspect as the engine checks an opportunity's cost (scoreConfidence):
 * the item's PriceDB row (lookupReferences: its own, else its book's canonical base's) and, read only when the
 * cost is far under that band, its craftability twin's, both through the reference age gate
 * (profit.referenceMaxAgeMs). Local reads only, no request; a few per flip row, never per stock row.
 */
export function bankStockCostCheck(deps: BankStockCostCheckDeps): (baseSku: string, costScrap: Scrap, now: UnixMs) => boolean {
  return (baseSku, costScrap, now) => {
    const K = deps.keyPrice().valueScrap;
    const maxAge = deps.settings().profit?.referenceMaxAgeMs;
    const pricedbOf = (raw: RawReferences | null) => (raw === null ? null : usableReferences(referencePrices(raw, K, now), maxAge, now).references.pricedb);
    return costSanity(costScrap, pricedbOf(lookupReferences(deps.repo, baseSku, deps.schema ?? null)), () => pricedbOf(lookupTwinReferences(deps.repo, baseSku))) !== null;
  };
}

export interface BankStock {
  /**
   * Re-reads each bank's newest pair of saves and diffs them (core: after an import wrote bank stock,
   * after maintenance pruned some, and on a key price move of 1 scrap or more). Never throws: a failed
   * read keeps the last good diffs and is logged once per failure streak.
   */
  refresh(): void;
  /**
   * 'scraptf.bankStock': one bank's rows (filter, search, sort, page) and counts. Never throws. 0.7.1: the
   * changes are since the session baseline (previousSavedAt is its time), and pages far older than the
   * bank's newest page are left out (BankStockResult.olderPages).
   */
  list(q: BankStockQuery, now: UnixMs): BankStockResult;
  /** Every row matching q's filter and search in q's order, paging ignored (opps.exportCsv 'bankStock'). */
  all(q: BankStockQuery, now: UnixMs): BankStockRow[];
  /**
   * ScraptfBankSummary.whatsNew for the banks summary; null until a page of the bank has 2 saves. 0.7.1:
   * since the session baseline, so window reads 30 s apart do not empty it.
   */
  whatsNew(bank: ScraptfBank): ScraptfBankSummary['whatsNew'];
  /**
   * MarketRow.scraptfNewAt for a base SKU (bankStockNewAt over the shown pages), else null. 0.7.1: a bank
   * whose newest save is over BANK_STOCK_NEW_MAX_AGE_MS old marks nothing New.
   */
  newAtFor(baseSku: string): UnixMs | null;
  /** ItemDetail.bankStock for a SKU (bankStockItemOf at the engine's key price), else null. */
  detailFor(sku: string): ItemDetail['bankStock'];
  /**
   * 0.7.4 (F41): the prices the shown pages' newest saves (not a page far older than its bank's newest) have this
   * very copy on sale at, keys and metal as listed, bank pages only (bankStockPricesOf); empty when none has.
   * The Live check's craftability twin. From the kept diffs only, never a database read per call. 0.7.4: each
   * price names its bank (a page that never lists Non-Craftable copies keeps a repriced card Craftable).
   */
  pricesFor(sku: string): { keys: number; scrap: Scrap; bank: ScraptfBank }[];
  /**
   * F19, MarketRow.scraptfLink: the newest kept save that lists a base SKU (any copy still on that save),
   * over every page of every bank, folded with preferScraptfSeen (a bank page beats the /items list);
   * else null. From the kept diffs only, never a database read per call.
   */
  seenFor(baseSku: string): ScraptfSeen | null;
  /**
   * Grows whenever a refresh changed a kept diff (and so possibly newAtFor and seenFor): the Live market
   * keys its cached "New on scrap.tf" pass on it.
   */
  version(): number;
  /**
   * S3: the rows of `bank` that are new and a flip right now, most profit first, when `batchId` is the
   * first import of its page's newest look (that page's newest kept save, or the first of several imports
   * of that same file) and the page has a previous save; else none (a first save of a page, an older page
   * imported late, or the newest page imported again notifies nothing). Judged by the look, not the batch
   * id, so a held start-up import still tells after the same file was imported again. A suspect margin
   * (F5's rule over the market entry: few orders, no usable reference) is left out, as the engine never
   * toasts one. New since the save just before (0.7.1: not the session baseline), so a read 30 s after
   * another tells only what that read added. 0.7.4: nor a price the cost checks flag (deps.costSuspect), nor
   * an /items row for every copy (BankStockRow.listFamily: never a flip).
   */
  newFlips(bank: ScraptfBank, batchId: number): BankStockRow[];
  /**
   * 0.7.1 (ACT-6): the save time of `batchId` when it is the newest look of a page (its first import or
   * the newest save itself), from the kept saves in memory; else null.
   */
  savedAtOf(batchId: number): UnixMs | null;
  /**
   * 0.7.1: every row of `bank` on sale on the page's newest save that is a flip right now, most profit
   * first, when `batchId` is the first import of that page's newest look (as newFlips); else none. Unlike
   * newFlips it needs no previous save and keeps unchanged rows: the scrap.tf window toolbar's "N flips on
   * this page". Reads the newest save's own rows only, so it does not depend on the save they are compared
   * with. Suspect margins and (0.7.4) flagged costs are left out, as in newFlips.
   */
  pageFlips(bank: ScraptfBank, batchId: number): BankStockRow[];
  /**
   * 0.8 (the S3 notifier): the told look of `batchId` (newFlips' rule: the first import of a page's newest look; unlike
   * newFlips a first save counts, previousSavedAt null): every row on sale on its step diff (gone rows left out) joined
   * to the live book, the runs index, the buy timing (timingAt = now, D9) and the watches, each marked scraptfIsRestock
   * (seenBefore: scraptfSeenBefore on the bank's runs at the look's save time). Null for any other batch. Never throws.
   * `opts.timing` false leaves the rows untimed: the notifier with notifications.buyTiming off (G4, the only reader of
   * a look's verdicts), so an import builds no lifecycle and judges no verdict for toasts that never read one.
   */
  lookOf(bank: ScraptfBank, batchId: number, opts?: { timing?: boolean }): BankStockLook | null;
  /** 0.8: 'flip': F5's suspect margin or the cost checks (what newFlips leaves out); 'cost': the cost checks only. Never throws. */
  isSuspect(r: BankStockRow, what: 'flip' | 'cost'): boolean;
  /** 0.8 (G2): newFlips' look rule (a previous save needed) for rows this read dropped under Pay up to (bankStockDroppedIntoFlip), not suspect, most profit first. */
  droppedFlips(bank: ScraptfBank, batchId: number): BankStockRow[];
  /** 0.8 ('watches.list'): per shown page, its newest save's on-sale rows whose base is in `bases`, joined now. Never throws. */
  watchRows(bases: ReadonlySet<string>): WatchPageRows[];
}

/**
 * One page of a bank: its kept saves, diffed (only the rows the bank shows, bankStockMergePages). `diff`
 * is against the session baseline (`previousSavedAt` is the baseline's time); `stepDiff` against the save
 * just before (the same array when the two saves are one).
 */
interface PageState extends BankStockBankDiff {
  page: string;
  newest: BankStockSave;
  /** The page's newest kept save from before its newest one's time, or null: a first save of the page. */
  previous: BankStockSave | null;
  /** 0.7.1 (CQ-2): the newest save from before the newest one's session, else `previous`. */
  baseline: BankStockSave | null;
  /** 0.7.1: newest vs previous, for S3 (newFlips): each read tells only what it added. */
  stepDiff: readonly BankStockDiffRow[];
  /** The first import of the newest look (BankStockPagePair.firstBatchId): the one batch S3 tells of. */
  firstBatchId: number;
}

/** What joinRow adds besides the book and the runs: the buy timing at `timingAt` (null: none), and the watches. */
interface RowJoins {
  timingAt: UnixMs | null;
  watchIndex: ScraptfWatchIndex;
  /** notifications.minConfidence, for BankStockRowWatch.met's profit target. */
  minConfidence: number;
}

/** One bank: each page saved, and the rows they show together. */
interface BankState {
  /** Newest page first, merged over every page (newFlips, pageFlips, detailFor, seenFor). */
  pages: PageState[];
  /**
   * 0.7.1 (DM-5): the pages the stock page shows (bankStockCurrentPages: not far older than the newest),
   * merged over themselves only. `pages` when none is left out.
   */
  shown: PageState[];
  /** The shown pages' rows: the stock page, its counts and "What's new". */
  diff: BankStockDiffRow[];
  /** Rows listed on the shown pages' newest saves (each item once). */
  items: number;
  /** The newest page's newest save. */
  savedAt: UnixMs;
  /** The earliest baseline among the shown pages that have one (every change shown is since then), else null. */
  previousSavedAt: UnixMs | null;
  /** The oldest of the shown pages' newest saves. */
  oldestSavedAt: UnixMs;
  /** Kept saves counted over the shown pages (<= BANK_STOCK_KEEP_SAVES per page). */
  saves: number;
  /** Pages left out of the stock page (BankStockResult.olderPages), or null. */
  olderPages: { count: number; newestSavedAt: UnixMs } | null;
  /** The key value the diffs decided cheaper/pricier at. */
  diffKey: Scrap;
}

/**
 * The save to diff the newest against: the newest kept save of the newest one's page from strictly
 * before it (bankStockPagePairs). A save at the newest one's own time is the same file imported again
 * (the Import page's file picker on a page the folder watch already took: a save's time is its file's
 * mtime), not a later look at the bank, so it is skipped; diffing a page against itself would wipe
 * every change, "What's new" and New badge. Another page of the bank is never the previous save.
 */
export function previousOf<S extends BankStockPageSave>(saves: readonly S[]): S | null {
  return bankStockPagePairs(saves)[0]?.previous ?? null;
}

/**
 * F19 (BankStock.seenFor): per base SKU, the newest page save that lists any copy of it (a diff row with
 * a `current` row; a gone one was not on that save), bank pages before the /items list (preferScraptfSeen).
 */
function seenByBase(pages: readonly BankStockBankDiff[]): Map<string, ScraptfSeen> {
  const out = new Map<string, ScraptfSeen>();
  for (const p of pages) {
    const at: ScraptfSeen = { bank: p.bank, at: p.savedAt };
    for (const d of p.diff) {
      if (d.current === null) continue;
      const pick = preferScraptfSeen(out.get(d.sku), at);
      if (pick) out.set(d.sku, pick);
    }
  }
  return out;
}

/** The categories memo is dropped past this many SKUs (every kept row is far fewer). */
const CATEGORY_MEMO_MAX = 50_000;
/**
 * After a failed read, reads retry at most this often (refresh() retries at once): the market asks
 * newAtFor per returned row, which must not become a burst of queries against a broken database.
 */
export const BANK_STOCK_RETRY_MS = 10_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function sameSave(a: BankStockSave | null, b: BankStockSave | null): boolean {
  if (a === null || b === null) return a === b;
  return a.batchId === b.batchId && a.savedAt === b.savedAt && a.items === b.items && a.page === b.page;
}

/** The same pages with the same saves each: the kept diffs still stand (only firstBatchId may move). */
function samePairs(old: readonly PageState[], pairs: readonly BankStockPagePair<BankStockSave>[]): boolean {
  return (
    old.length === pairs.length &&
    pairs.every((p, i) => old[i]!.page === p.page && sameSave(old[i]!.newest, p.newest) && sameSave(old[i]!.previous, p.previous) && sameSave(old[i]!.baseline, p.baseline))
  );
}

/**
 * Pages merged over each other (bankStockMergePages), both diffs: an item on several pages shows once, from
 * the newest page that lists it. The step diffs merge the same way, so S3 reads what the page shows.
 */
function mergeBoth(pages: readonly PageState[]): PageState[] {
  const merged = bankStockMergePages(pages);
  if (pages.length <= 1) return merged;
  const steps = bankStockMergePages(pages.map((p) => ({ diff: p.stepDiff })));
  return merged.map((p, i) => ({ ...p, stepDiff: pages[i]!.stepDiff === pages[i]!.diff ? p.diff : steps[i]!.diff }));
}

/**
 * Saves read per bank: each page's newest BANK_STOCK_SESSION_READ (0.7.1: the whole page as the thinning
 * keeps it, so the session baseline is found behind any number of window reads), for BANK_STOCK_MAX_PAGES
 * pages. Read per page (`perPage`): the bank's newest saves overall could leave out a quiet page, or the
 * save it is compared with, that the history and the feed still read. Save rows are only read for the
 * newest, previous and baseline save of each page.
 */
const SAVES_READ = BANK_STOCK_SESSION_READ * BANK_STOCK_MAX_PAGES;
const SAVES_PER_PAGE = { perPage: BANK_STOCK_SESSION_READ } as const;

export function createBankStock(deps: BankStockDeps): BankStock {
  const { log, repo } = deps;
  const banks = new Map<ScraptfBank, BankState>();
  /** A save's rows by batch id: written once by the import, so read once (only the kept pairs stay). */
  const rowsByBatch = new Map<number, readonly BankStockStored[]>();
  let newAt = new Map<string, UnixMs>();
  // F19: seenFor's map, rebuilt lazily from the kept diffs when `ver` moved (a refresh changed them).
  let seen: { ver: number; byBase: Map<string, ScraptfSeen> } | null = null;
  const categories = new Map<string, Category>();
  let ver = 0;
  // Nothing is read until first use (no start call); a failed read stays stale so a later use retries.
  let stale = true;
  let failing = false;
  /** While failing: no read retries before this (refresh() does). */
  let retryAt: UnixMs | null = null;
  let lastKeyPrice: KeyPriceState | null = null;

  function now(): UnixMs {
    try {
      return deps.clock.now();
    } catch {
      return Date.now();
    }
  }

  let keyFailing = false;
  /** The last good key price stands in for a failed read (logged once per failure streak). */
  function readKeyPrice(): KeyPriceState {
    try {
      const kp = deps.keyPrice();
      if (kp && finite(kp.valueScrap) && kp.valueScrap > 0) {
        lastKeyPrice = kp;
        keyFailing = false;
        return kp;
      }
    } catch (err) {
      if (!keyFailing) log.warn('Bank stock could not read the key price', { error: errorText(err) });
      keyFailing = true;
    }
    return lastKeyPrice ?? defaultKeyPrice();
  }

  function profitSettings(): CeilingSettings {
    return deps.settings().profit;
  }

  function rowsOf(batchId: number): readonly BankStockStored[] {
    const hit = rowsByBatch.get(batchId);
    if (hit) return hit;
    const rows = repo.bankStockRows(batchId);
    rowsByBatch.set(batchId, rows);
    return rows;
  }

  /** Every page of every bank, each with its own save time (the drawer and the market's link). */
  function allPages(): PageState[] {
    return [...banks.values()].flatMap((st) => st.pages);
  }

  /** The pages each bank's stock page shows (the market's New badge reads only these). */
  function shownPages(): PageState[] {
    return [...banks.values()].flatMap((st) => st.shown);
  }

  // 0.7.1 (DM-5): which banks are fresh enough to mark anything New moves with the clock, not only with a
  // refresh; newAt is rebuilt (and `ver` moved, so the market's cached New pass re-filters) when it does.
  let newAtFresh = '';
  /** When the fresh set was last worked out, and until when it cannot change (a fresh bank's 24 h runs out). */
  let freshCheck: { at: UnixMs; until: UnixMs } | null = null;
  function syncNewAt(force: boolean): void {
    const at = now();
    // newAtFor runs per market row: a clock check only, until the next bank can go stale.
    if (!force && freshCheck !== null && at >= freshCheck.at && at < freshCheck.until) return;
    const fresh: string[] = [];
    let until = Number.POSITIVE_INFINITY;
    for (const [bank, st] of banks) {
      if (at - st.savedAt > BANK_STOCK_NEW_MAX_AGE_MS) continue;
      fresh.push(bank);
      until = Math.min(until, st.savedAt + BANK_STOCK_NEW_MAX_AGE_MS + 1);
    }
    freshCheck = { at, until };
    const sig = fresh.join(',');
    if (!force && sig === newAtFresh) return;
    newAtFresh = sig;
    newAt = bankStockNewAt(shownPages(), at);
    if (!force) ver++;
  }

  function load(): void {
    const K = readKeyPrice().valueScrap;
    let changed = false;
    let failed = false;
    const inUse = new Set<number>();
    const keep = (st: BankState): void => {
      for (const p of st.pages) {
        inUse.add(p.newest.batchId);
        if (p.previous) inUse.add(p.previous.batchId);
        if (p.baseline) inUse.add(p.baseline.batchId);
      }
    };
    for (const info of SCRAPTF_BANKS) {
      const old = banks.get(info.bank) ?? null;
      try {
        const pairs = bankStockPagePairs(repo.bankStockSaves(info.bank, SAVES_READ, SAVES_PER_PAGE));
        if (pairs.length === 0) {
          // Never saved, or every save pruned (older than 30 days): "no save".
          if (old) {
            banks.delete(info.bank);
            changed = true;
          }
          continue;
        }
        if (old && samePairs(old.pages, pairs) && old.diffKey === K) {
          const shownKeys = new Set(old.shown.map((p) => p.page));
          old.saves = pairs.reduce((n, p) => n + (shownKeys.has(p.page) ? p.saves : 0), 0);
          pairs.forEach((p, i) => (old.pages[i]!.firstBatchId = p.firstBatchId));
          // `shown` holds its own merged copies when pages were left out; they carry the same look.
          for (const s of old.shown) s.firstBatchId = pairs.find((p) => p.page === s.page)?.firstBatchId ?? s.firstBatchId;
          keep(old);
          continue;
        }
        // Each page against its own baseline (and previous save) only, then shown together (an item once).
        const raw = pairs.map((p): PageState => {
          const newestRows = rowsOf(p.newest.batchId);
          const diff = diffBankStock(newestRows, p.baseline ? rowsOf(p.baseline.batchId) : null, K);
          const same = (p.baseline?.batchId ?? null) === (p.previous?.batchId ?? null);
          return {
            bank: info.bank,
            page: p.page,
            savedAt: p.newest.savedAt,
            previousSavedAt: p.baseline?.savedAt ?? null,
            diff,
            stepDiff: same ? diff : diffBankStock(newestRows, p.previous ? rowsOf(p.previous.batchId) : null, K),
            newest: p.newest,
            previous: p.previous,
            baseline: p.baseline,
            firstBatchId: p.firstBatchId,
          };
        });
        const pages = mergeBoth(raw);
        // DM-5: pages far older than the newest are not "the bank now"; merged among the rest only.
        const current = bankStockCurrentPages(raw);
        const shown = current.olderPages === null ? pages : mergeBoth(current.shown);
        const diff = shown.flatMap((p) => p.diff);
        const baselineTimes = shown.flatMap((p) => (p.baseline ? [p.baseline.savedAt] : []));
        const shownPageKeys = new Set(shown.map((p) => p.page));
        const st: BankState = {
          pages,
          shown,
          diff,
          items: diff.reduce((n, d) => n + (d.current !== null ? 1 : 0), 0),
          savedAt: pages[0]!.savedAt,
          previousSavedAt: baselineTimes.length > 0 ? Math.min(...baselineTimes) : null,
          oldestSavedAt: Math.min(...shown.map((p) => p.savedAt)),
          saves: pairs.reduce((n, p) => n + (shownPageKeys.has(p.page) ? p.saves : 0), 0),
          olderPages: current.olderPages,
          diffKey: K,
        };
        banks.set(info.bank, st);
        keep(st);
        changed = true;
      } catch (err) {
        // This bank keeps its last good diff (and the rows behind it); the others still refresh.
        // Logged once per failure streak, not once per bank or per read.
        if (!failing && !failed) log.warn('Bank stock could not read the saved pages', { bank: info.bank, error: errorText(err) });
        failed = true;
        if (old) keep(old);
      }
    }
    for (const id of [...rowsByBatch.keys()]) if (!inUse.has(id)) rowsByBatch.delete(id);
    if (changed) {
      syncNewAt(true);
      ver++;
    }
    // A schema loaded since the last refresh may file a SKU elsewhere (as the market re-reads on markAllDirty).
    categories.clear();
    failing = failed;
    stale = failed;
    retryAt = failed ? now() + BANK_STOCK_RETRY_MS : null;
  }

  function ensure(force = false): void {
    if (!stale) return;
    if (!force && retryAt !== null && now() < retryAt) return;
    try {
      load();
    } catch (err) {
      // load() catches per bank; this is only the key price or the SCRAPTF_BANKS walk itself.
      if (!failing) log.warn('Bank stock could not refresh', { error: errorText(err) });
      failing = true;
      stale = true;
      retryAt = now() + BANK_STOCK_RETRY_MS;
    }
  }

  let lastSchemaLoaded: boolean | null = null;
  /** Once per read, not per row: a schema that loaded since files SKUs the guess put under 'other'. */
  function checkSchema(): void {
    if (!deps.schemaLoaded) return;
    let loaded: boolean;
    try {
      loaded = deps.schemaLoaded() === true;
    } catch {
      return;
    }
    if (lastSchemaLoaded !== null && loaded !== lastSchemaLoaded) categories.clear();
    lastSchemaLoaded = loaded;
  }

  function categoryOf(sku: string): Category {
    const hit = categories.get(sku);
    if (hit) return hit;
    let c: Category;
    try {
      c = deps.categoryOf(sku);
    } catch {
      c = 'other';
    }
    if (categories.size >= CATEGORY_MEMO_MAX) categories.clear();
    categories.set(sku, c);
    return c;
  }

  function entryOf(sku: string): Readonly<MarketEval> | null {
    try {
      return deps.market.entryFor(sku);
    } catch {
      return null;
    }
  }

  function buySideOf(sku: string): BankStockBuySide | null {
    return entryOf(sku);
  }

  let costFailing = false;
  /** 0.7.4 (F22, F70): deps.costSuspect, never throwing (a failed check counts as not suspect; logged once per streak). */
  function costSuspect(r: BankStockRow): boolean {
    if (!deps.costSuspect || !(r.costScrap > 0)) return false;
    try {
      const out = deps.costSuspect(r.sku, r.costScrap, now()) === true;
      costFailing = false;
      return out;
    } catch (err) {
      if (!costFailing) log.warn('Bank stock could not check a price against PriceDB', { error: errorText(err) });
      costFailing = true;
      return false;
    }
  }

  /** F5's margin check: few buy orders, no usable reference and a margin above profit.suspectMargin (a free item with a profit counts as unbounded). */
  function marginSuspect(r: BankStockRow): boolean {
    const e = entryOf(r.sku);
    if (!e) return false;
    const margin = r.margin ?? (r.costScrap <= 0 && (r.profitScrap ?? 0) > 0 ? Number.POSITIVE_INFINITY : null);
    return isSuspectMargin(margin, e.eligibleCount, e.referenced !== false, deps.settings().profit.suspectMargin);
  }

  /**
   * F5: a suspect margin is shown but never notified, as the engine's toasts (marginSuspect).
   * 0.7.4 (F22, F70): nor is a price the cost checks flag (costSuspect: probably another copy's price),
   * which the engine caps at Low and never toasts either.
   */
  function suspect(r: BankStockRow): boolean {
    return marginSuspect(r) || costSuspect(r);
  }

  let runsFailing = false;
  /** F20: the bank's runs index, read once per call; a failed read shows no listed fields (never fails the rows). */
  function runsOf(bank: ScraptfBank): ReadonlyMap<string, ScraptfKeyRun> | null {
    if (!deps.history) return null;
    try {
      const runs = deps.history.runsFor(bank) ?? null;
      runsFailing = false;
      return runs;
    } catch (err) {
      // Logged once per failure streak: the stock page reads every few seconds while visible.
      if (!runsFailing) log.warn('Bank stock could not read the time listed', { bank, error: errorText(err) });
      runsFailing = true;
      return null;
    }
  }

  let timingFailing = false;
  /** 0.8 (T4): an on-sale row's buy-timing brief from the history; a failed read shows none (logged once per streak). */
  function timingOf(bank: ScraptfBank, key: string, buy: BankStockBuySide | null, at: UnixMs, inputs?: ScraptfTimingInputs): ScraptfTimingBrief | null {
    if (!deps.history?.timingFor) return null;
    try {
      const t = deps.history.timingFor(bank, key, buy, at, inputs);
      timingFailing = false;
      return t ? scraptfTimingBrief(t) : null;
    } catch (err) {
      if (!timingFailing) log.warn('Bank stock could not read the buy timing', { bank, error: errorText(err) });
      timingFailing = true;
      return null;
    }
  }

  /** 0.8 (LC-4): the bank's turnover from the history; a failed read leaves it out. */
  function turnoverOf(bank: ScraptfBank): ScraptfTurnover | null {
    try {
      return deps.history?.turnoverFor?.(bank) ?? null;
    } catch {
      return null;
    }
  }

  let watchesFailing = false;
  /** 0.8 (G1): the enabled watches by base, read once per call of rowsFor/lookOf; a failed read joins none (logged once per streak). */
  function safeWatches(): ScraptfWatchIndex {
    if (!deps.watches) return EMPTY_WATCH_INDEX;
    try {
      const index = deps.watches() ?? EMPTY_WATCH_INDEX;
      watchesFailing = false;
      return index;
    } catch (err) {
      if (!watchesFailing) log.warn('Bank stock could not read your scrap.tf watches', { error: errorText(err) });
      watchesFailing = true;
      return EMPTY_WATCH_INDEX;
    }
  }

  /** The joins of one read: the watches and the notification confidence read once, never per row. */
  function joinsAt(timingAt: UnixMs | null): RowJoins {
    let minConfidence = 0;
    try {
      const c = deps.settings().notifications?.minConfidence;
      minConfidence = finite(c) ? c : 0;
    } catch {
      minConfidence = 0;
    }
    return { timingAt, watchIndex: safeWatches(), minConfidence };
  }

  /**
   * One diff row joined to the live book now, (F20) the bank's runs index, (0.8, T4) its buy-timing brief judged at
   * `joins.timingAt` when on sale (bankStockRow keeps it off gone and family rows), and (0.8, G1) the watch covering its
   * copy (watchJoinOf: BankStockRow.watch, absent when none). Null when bankStockRow shows no row for it.
   */
  function joinRow(bank: ScraptfBank, d: BankStockDiffRow, K: Scrap, profit: CeilingSettings, runs: ReadonlyMap<string, ScraptfKeyRun> | null, joins: RowJoins): BankStockRow | null {
    const buy = buySideOf(d.sku);
    // The read's own key price and settings (no key-price query per row).
    const timing = joins.timingAt !== null && d.onSale ? timingOf(bank, d.key, buy, joins.timingAt, { keyScrap: K, profit }) : null;
    const row = bankStockRow(d, { category: categoryOf(d.sku), buy, keyScrap: K, profit, run: runs?.get(d.key) ?? null, bank, timing });
    if (!row) return null;
    const watch = watchJoinOf(joins.watchIndex, row, K, joins.minConfidence);
    return watch ? { ...row, watch } : row;
  }

  /**
   * Shown diff rows (a bank's, or one page's), joined to the live book now and (F20) to the bank's runs
   * index; `changedOnly` skips unchanged rows (whatsNew, S3). 0.7.4: an /items list row not proven to price
   * one copy (bankStockListFamily: a family row, or rows of one item that differ) is joined to no buy side,
   * so it is never a flip on the stock page, in "What's new", a page flip or a "New on scrap.tf" toast.
   * 0.8 (T4): with `timingAt` (list() and all() pass their `now`), each row on sale gets its buy-timing brief
   * judged at that time (bankStockRow keeps it off gone and family rows); null joins none. 0.8 (G1): and each
   * row its watch (joinRow).
   */
  function rowsFor(bank: ScraptfBank, diff: readonly BankStockDiffRow[], K: Scrap, profit: CeilingSettings, changedOnly = false, timingAt: UnixMs | null = null): BankStockRow[] {
    checkSchema();
    const runs = runsOf(bank);
    const joins = joinsAt(timingAt);
    const out: BankStockRow[] = [];
    for (const d of diff) {
      if (changedOnly && d.change === null) continue;
      const row = joinRow(bank, d, K, profit, runs, joins);
      if (row) out.push(row);
    }
    return out;
  }

  function listOf(q: BankStockQuery, now: UnixMs): BankStockResult {
    ensure();
    const kp = readKeyPrice();
    const st = banks.get(q.bank);
    if (!st) return emptyBankStockResult(q.bank, kp, now);
    return bankStockResult({
      q,
      rows: rowsFor(q.bank, st.diff, kp.valueScrap, profitSettings(), false, now),
      items: st.items,
      savedAt: st.savedAt,
      previousSavedAt: st.previousSavedAt,
      saves: st.saves,
      pages: { count: st.shown.length, oldestSavedAt: st.oldestSavedAt },
      olderPages: st.olderPages,
      turnover: turnoverOf(q.bank),
      keyPrice: kp,
      now,
    });
  }

  return {
    refresh() {
      stale = true;
      ensure(true);
    },

    list(q, now) {
      try {
        return listOf(q, now);
      } catch (err) {
        log.warn('Bank stock could not list a bank', { bank: q.bank, error: errorText(err) });
        return emptyBankStockResult(q.bank, lastKeyPrice, now);
      }
    },

    all(q, now) {
      try {
        ensure();
        const st = banks.get(q.bank);
        if (!st) return [];
        const { limit: _limit, offset: _offset, ...filters } = q;
        // F20: `now` decides the 'long-listed' filter, as list() does through bankStockResult (0.8: and the 'dropping' rows' timing).
        return bankStockMatching(rowsFor(q.bank, st.diff, readKeyPrice().valueScrap, profitSettings(), false, now), filters, now);
      } catch (err) {
        log.warn('Bank stock could not list a bank', { bank: q.bank, error: errorText(err) });
        return [];
      }
    },

    whatsNew(bank) {
      try {
        ensure();
        const st = banks.get(bank);
        // No page of the bank saved twice: nothing to compare yet ("First save").
        if (!st || st.previousSavedAt === null) return null;
        // Unchanged rows add to none of these counts, so only changed rows are joined.
        const rows = rowsFor(bank, st.diff, readKeyPrice().valueScrap, profitSettings(), true);
        return bankStockWhatsNew(bankStockCounts(rows, st.items), st.previousSavedAt);
      } catch (err) {
        log.warn('Bank stock could not count what is new', { bank, error: errorText(err) });
        return null;
      }
    },

    newAtFor(baseSku) {
      if (typeof baseSku !== 'string') return null;
      ensure();
      syncNewAt(false);
      return newAt.get(baseSku) ?? null;
    },

    seenFor(baseSku) {
      if (typeof baseSku !== 'string') return null;
      ensure();
      // Rebuilt once per changed refresh, not per call: the market asks for every returned row.
      if (seen === null || seen.ver !== ver) seen = { ver, byBase: seenByBase(allPages()) };
      const s = seen.byBase.get(baseSku);
      return s ? { bank: s.bank, at: s.at } : null;
    },

    detailFor(sku) {
      if (typeof sku !== 'string') return null;
      try {
        ensure();
        // Per page: the drawer names the save that lists the copy, dated by that page's save.
        return bankStockItemOf(allPages(), sku, readKeyPrice().valueScrap);
      } catch (err) {
        log.warn('Bank stock could not read an item', { error: errorText(err) });
        return null;
      }
    },

    pricesFor(sku) {
      if (typeof sku !== 'string') return [];
      try {
        ensure();
        return bankStockPricesOf(shownPages(), sku);
      } catch (err) {
        log.warn('Bank stock could not read an item', { error: errorText(err) });
        return [];
      }
    },

    version() {
      ensure();
      // A bank going stale for the New badge (DM-5) moves the version, so a cached "New" pass re-filters.
      syncNewAt(false);
      return ver;
    },

    newFlips(bank, batchId) {
      try {
        ensure();
        // Only the first import of a page's newest look tells: a page imported again (same time, a
        // higher batch id) is no new look, and an older page imported late is not the newest. Judged by
        // the look, so a held import still tells after the same file came in again. Only that page's
        // own diff counts: another page of the bank is never what it is compared with. Against the save
        // just before (stepDiff), not the session baseline: each read tells only what it added (S3).
        const pg = newestLookOf(bank, batchId);
        if (!pg || pg.previous === null) return [];
        const rows = rowsFor(bank, pg.stepDiff, readKeyPrice().valueScrap, profitSettings(), true).filter((r) => r.change === 'new' && r.verdict === 'flip' && !suspect(r));
        return rows.sort(byProfitDesc);
      } catch (err) {
        log.warn('Bank stock could not read the new flips', { bank, error: errorText(err) });
        return [];
      }
    },

    savedAtOf(batchId) {
      if (typeof batchId !== 'number') return null;
      try {
        ensure();
        const pg = allPages().find((p) => p.firstBatchId === batchId || p.newest.batchId === batchId);
        return pg ? pg.newest.savedAt : null;
      } catch {
        return null;
      }
    },

    pageFlips(bank, batchId) {
      try {
        ensure();
        // The same look rule as newFlips, but a first save counts too, and every row on sale on the newest
        // save (unchanged ones included; gone rows and stock 0 never) is a candidate.
        const pg = newestLookOf(bank, batchId);
        if (!pg) return [];
        const onSale = pg.diff.filter((d) => d.onSale);
        const rows = rowsFor(bank, onSale, readKeyPrice().valueScrap, profitSettings()).filter((r) => r.verdict === 'flip' && !suspect(r));
        return rows.sort(byProfitDesc);
      } catch (err) {
        log.warn('Bank stock could not read the page flips', { bank, error: errorText(err) });
        return [];
      }
    },

    lookOf(bank, batchId, opts) {
      try {
        ensure();
        // newFlips' look rule, but a first save counts too (a fresh watch is judged on it; its diff has no change).
        const pg = newestLookOf(bank, batchId);
        if (!pg) return null;
        checkSchema();
        const runs = runsOf(bank);
        // D9: the timing is judged now, so G4 compares this read's verdict with the read before. Untimed on request
        // (G4 off): a verdict per on-sale row (and the bank's lifecycle behind it) is work no toast reads.
        const joins = joinsAt(opts?.timing === false ? null : now());
        const K = readKeyPrice().valueScrap;
        const profit = profitSettings();
        const savedAt = pg.newest.savedAt;
        const rows = pg.stepDiff
          .filter((d) => d.onSale)
          .flatMap((d) => {
            const row = joinRow(bank, d, K, profit, runs, joins);
            // G3, LC-7: the one restock rule the change feed's 'restocked' reads too.
            return row ? [{ row, restock: scraptfIsRestock(d, scraptfSeenBefore(runs?.get(d.key), savedAt)) }] : [];
          });
        return { bank, page: pg.page, savedAt, previousSavedAt: pg.previous?.savedAt ?? null, rows };
      } catch (err) {
        log.warn('Bank stock could not read the told look', { bank, error: errorText(err) });
        return null;
      }
    },

    isSuspect(r, what) {
      try {
        return what === 'cost' ? costSuspect(r) : suspect(r);
      } catch (err) {
        log.warn('Bank stock could not check a flip', { error: errorText(err) });
        return false;
      }
    },

    droppedFlips(bank, batchId) {
      try {
        ensure();
        // newFlips' look rule: a first save, an older page imported late or the newest imported again has none.
        const pg = newestLookOf(bank, batchId);
        if (!pg || pg.previous === null) return [];
        const rows = rowsFor(bank, pg.stepDiff, readKeyPrice().valueScrap, profitSettings(), true).filter((r) => bankStockDroppedIntoFlip(r) && !suspect(r));
        return rows.sort(byProfitDesc);
      } catch (err) {
        log.warn('Bank stock could not read the dropped flips', { bank, error: errorText(err) });
        return [];
      }
    },

    watchRows(bases) {
      try {
        ensure();
        if (!(bases instanceof Set) || bases.size === 0) return [];
        const K = readKeyPrice().valueScrap;
        const profit = profitSettings();
        const out: WatchPageRows[] = [];
        // Per shown page (its newest save, dated by it), as the stock page shows them: never a page far older.
        for (const [bank, st] of banks) {
          for (const p of st.shown) {
            const diff = p.diff.filter((d) => d.onSale && bases.has(d.sku));
            if (diff.length > 0) out.push({ bank, savedAt: p.savedAt, rows: rowsFor(bank, diff, K, profit) });
          }
        }
        return out;
      } catch (err) {
        log.warn('Bank stock could not read the watched items', { error: errorText(err) });
        return [];
      }
    },
  };

  /** The page whose newest look `batchId` first imported (S3's rule), else undefined. */
  function newestLookOf(bank: ScraptfBank, batchId: number): PageState | undefined {
    return typeof batchId === 'number' ? banks.get(bank)?.pages.find((p) => p.firstBatchId === batchId) : undefined;
  }
}

/** Most profit first, then name, then key: newFlips' and pageFlips' order. */
function byProfitDesc(a: BankStockRow, b: BankStockRow): number {
  return (b.profitScrap ?? 0) - (a.profitScrap ?? 0) || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// ---------------------------------------------------------------------------
// S3: "New on scrap.tf" notifications
// ---------------------------------------------------------------------------

/**
 * 0.8 (G4): repo meta key of the Wait memories, JSON `{ "<bank>|<row key>": { at, since, drops, horizonMs } }`
 * (BankStockWaitMemo: the Wait streak's newest and first told look, its drop count and horizon), written only while
 * notifications.buyTiming is on; entries older than BANK_STOCK_TIMING_MAX_AGE_MS dropped, at most BANK_STOCK_TIMING_MAX.
 */
export const BANK_STOCK_TIMING_META_KEY = 'bankStock.timing';

export interface BankStockNotifyDeps {
  log: Logger;
  /** The dedupe map lives in repo meta (BANK_STOCK_NOTIFY_META_KEY), so a restart notifies nothing twice; 0.8 (G4): and the Wait memories (BANK_STOCK_TIMING_META_KEY). */
  repo: Pick<Repo, 'getMeta' | 'setMeta'>;
  /**
   * The rows to tell (newFlips) and, 0.7.1 (ACT-6), the told save's time (savedAtOf), so an old save is
   * told as one dated summary. Without savedAtOf (older fakes) every save counts as just made. 0.8: lookOf (the told
   * look, every kind's rows) and isSuspect; without lookOf (older fakes) the newFlips rows are told as new flips only.
   * The look is read untimed ({ timing: false }) while notifications.buyTiming is off: nothing else reads a verdict.
   */
  stock: Pick<BankStock, 'newFlips'> & Partial<Pick<BankStock, 'savedAtOf' | 'lookOf' | 'isSuspect'>>;
  /** 0.8 (G1): the enabled watches by base (core: the watch cache's index()). Omitted or failing: no watch hit. */
  watches?(): ScraptfWatchIndex;
  settings(): Settings;
  keyPrice(): KeyPriceState;
  /** core: push('notify', n); main applies notifications.silent. */
  notify(n: PushContract['notify']): void;
  /**
   * Each base SKU a notification (or the summary) told as a flip the engine would tell (the candidate's tellsFlip),
   * with the time: the engine skips its own toast for it. Optional.
   */
  told?(baseSku: string, at: UnixMs): void;
  /**
   * Whether another notification already told of this base SKU within BANK_STOCK_NOTIFY_DEDUP_MS (core:
   * the engine's "Profit:" toast of an imported price, which comes first when an import is held for the
   * market's first build). Such a row is recorded in the dedupe but not toasted: one toast per find.
   * With `since` (a watch hit: the told look's save time) only a toast at or after it counts, one about this read.
   * Optional; a failing check toasts as before.
   */
  toldBefore?(baseSku: string, now: UnixMs, since?: UnixMs): boolean;
}

function loadNotified(deps: BankStockNotifyDeps): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const raw = deps.repo.getMeta(BANK_STOCK_NOTIFY_META_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (finite(v)) out.set(k, v);
  } catch (err) {
    deps.log.warn('Could not read the bank stock notification history; starting fresh', { error: errorText(err) });
  }
  return out;
}

/** A failing check counts as not told: a second toast beats a lost one (as the engine's toldElsewhere). */
function toldBefore(deps: BankStockNotifyDeps, baseSku: string, now: UnixMs, since?: UnixMs): boolean {
  if (!deps.toldBefore) return false;
  try {
    return (since === undefined ? deps.toldBefore(baseSku, now) : deps.toldBefore(baseSku, now, since)) === true;
  } catch (err) {
    deps.log.warn('Bank stock notification check failed', { error: errorText(err) });
    return false;
  }
}

/** Expired by age only, like holdings.lastNotified: a count cap would re-notify items still inside the window. */
function saveNotified(deps: BankStockNotifyDeps, map: Map<string, number>, now: UnixMs): void {
  for (const [k, ts] of map) if (!(now - ts < BANK_STOCK_NOTIFY_DEDUP_MS) || ts > now) map.delete(k);
  try {
    deps.repo.setMeta(BANK_STOCK_NOTIFY_META_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch (err) {
    deps.log.warn('Could not save the bank stock notification history', { error: errorText(err) });
  }
}

/** 0.7.1: the told save's time (null when unknown: told as a fresh save, as before). */
function savedAtOf(deps: BankStockNotifyDeps, batchId: number): UnixMs | null {
  try {
    const at = deps.stock.savedAtOf?.(batchId) ?? null;
    return finite(at) ? at : null;
  } catch {
    return null;
  }
}

/** The key price the toasts word money at; null when it cannot be read (the texts then say ref only). */
function keyScrapOf(deps: BankStockNotifyDeps): Scrap | null {
  try {
    const K = deps.keyPrice().valueScrap;
    return finite(K) && K > 0 ? K : null;
  } catch {
    return null;
  }
}

/** 0.8 (G1): deps.watches, never throwing (a failed read is no watch, logged). */
function notifyWatchesOf(deps: BankStockNotifyDeps): ScraptfWatchIndex {
  if (!deps.watches) return EMPTY_WATCH_INDEX;
  try {
    return deps.watches() ?? EMPTY_WATCH_INDEX;
  } catch (err) {
    deps.log.warn('Could not read your scrap.tf watches for the notifications', { error: errorText(err) });
    return EMPTY_WATCH_INDEX;
  }
}

/** 0.8: BankStock.isSuspect, never throwing (a failed check counts as not suspect, as costSuspect). Absent (older fakes): newFlips already left them out. */
function isSuspect(deps: BankStockNotifyDeps, r: BankStockRow, what: 'flip' | 'cost'): boolean {
  if (!deps.stock.isSuspect) return false;
  try {
    return deps.stock.isSuspect(r, what) === true;
  } catch (err) {
    deps.log.warn('Bank stock notification check failed', { error: errorText(err) });
    return false;
  }
}

/**
 * A stock without lookOf (an older stand-in): its newFlips rows as a look of new, never-seen flips, told as before.
 * previousSavedAt 0: a look after a save (newFlips needs one); savedAt from savedAtOf, else now.
 */
function legacyLook(deps: BankStockNotifyDeps, imported: { bank: ScraptfBank; batchId: number }, flips: boolean, now: UnixMs): BankStockLook | null {
  if (!flips) return null;
  const rows = deps.stock.newFlips(imported.bank, imported.batchId);
  if (rows.length === 0) return null;
  return { bank: imported.bank, page: '', savedAt: savedAtOf(deps, imported.batchId) ?? now, previousSavedAt: 0, rows: rows.map((row) => ({ row, restock: false })) };
}

/** 0.8 (G4): the Wait memories (bankStockTimingParse); an unreadable meta is none, logged. */
function loadTiming(deps: BankStockNotifyDeps): Map<string, BankStockWaitMemo> {
  try {
    return bankStockTimingParse(deps.repo.getMeta(BANK_STOCK_TIMING_META_KEY));
  } catch (err) {
    deps.log.warn('Could not read the buy timing notification history; starting fresh', { error: errorText(err) });
    return new Map();
  }
}

/** 0.8 (G4): writes the Wait memories bankStockTimingNext gave; null (nothing changed) writes nothing. */
function saveTiming(deps: BankStockNotifyDeps, next: Map<string, BankStockWaitMemo> | null): void {
  if (next === null) return;
  try {
    deps.repo.setMeta(BANK_STOCK_TIMING_META_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch (err) {
    deps.log.warn('Could not save the buy timing notification history', { error: errorText(err) });
  }
}

/**
 * The S3 notifier, after an import wrote a save of `imported.bank` (and the stock was refreshed): one ordered list of
 * what the told look (BankStock.lookOf: the first import of a page's newest look) is worth a toast for
 * (bankStockNotifyCandidates, at most one per row), in this order:
 * - 'watch' (G1, notifications.watches): "Watch (<Bank>): <name>", a watched copy at or under its price or at or over its
 *   profit on a read that made it new or cheaper, or for a watch made or edited after the page's previous save;
 * - 'new' (S3): "New on scrap.tf (<Bank>): <name>", a flip new since the save before and never listed before;
 * - 'cheaper' (G2): "Cheaper on scrap.tf (<Bank>): <name>", a flip this read dropped under Pay up to;
 * - 'back' (LC-7, G3): "Back on scrap.tf (<Bank>): <name>", a flip, or a watched copy asked about, on sale again
 *   (scraptfIsRestock); a watched copy's first sighting reads "New on scrap.tf";
 * - 'timing' (G4, opt-in: notifications.buyTiming, off by default): "Buy now (<Bank>): <name>", Wait on the read before
 *   and Buy now on this one, with a drop or the Wait's horizon passing in between.
 * Gates: notifications.enabled; the S3 kinds need .newOnScraptf and 'import' in .inputKinds, the buy side's
 * .minConfidence, .minProfitScrap, a verified buy order and no suspect margin or cost. One dedupe in repo meta
 * (BANK_STOCK_NOTIFY_META_KEY) for BANK_STOCK_NOTIFY_DEDUP_MS across restarts: per bank and base SKU, a watch hit per
 * watch (exempt from that key, and recording the S3 key, so the S3 kinds stay quiet after it). An item another
 * notification already told of (deps.toldBefore; for a watch hit only a toast at or after the look's save) is only
 * recorded. At most BANK_STOCK_MAX_NOTIFICATIONS, then one summary that opens the bank's stock on its chip (G5); a save
 * older than profit.inputStaleMs is told as one dated summary instead (ACT-6). The base SKU of every toast that tells a
 * flip the engine would tell (tellsFlip) goes to deps.told. A look of new, never-seen flips alone is told exactly as
 * 0.7.4 told it. Returns the notifications sent; never throws.
 */
export function notifyNewBankFlips(deps: BankStockNotifyDeps, imported: { bank: ScraptfBank; batchId: number }, now: UnixMs): number {
  try {
    const n = deps.settings().notifications;
    if (n?.enabled !== true) return 0;
    const info = scraptfBankInfo(imported.bank);
    if (!info) return 0;
    // inputKinds as the engine reads it (notifyKinds: a missing or broken value is every kind, the default).
    const flips = n.newOnScraptf !== false && notifyKinds(n.inputKinds).has('import');
    const watches = n.watches === false ? EMPTY_WATCH_INDEX : notifyWatchesOf(deps);
    if (!flips && watches.size === 0) return 0;
    const minConfidence = finite(n.minConfidence) ? n.minConfidence : 0;
    const minProfit = finite(n.minProfitScrap) ? n.minProfitScrap : 0;
    const K = keyScrapOf(deps);
    // G4 is opt-in (notifications.buyTiming, off by default, D25): no memory is read or written while it is off.
    const timingOn = flips && n.buyTiming === true && deps.stock.lookOf !== undefined;
    // Only G4 reads a row's verdict (its turn to Buy now, its memory, the Wait note): while it is off the look is read
    // untimed, so an import builds no lifecycle and judges no verdict on its path for toasts that never read one.
    const look = deps.stock.lookOf
      ? deps.stock.lookOf(imported.bank, imported.batchId, timingOn ? undefined : { timing: false })
      : legacyLook(deps, imported, flips, now);
    if (look === null) return 0;
    const timing = timingOn ? loadTiming(deps) : new Map<string, BankStockWaitMemo>();
    const cands = bankStockNotifyCandidates({
      look,
      flips,
      watches,
      minConfidence,
      minProfitScrap: minProfit,
      keyScrap: K ?? defaultKeyPrice().valueScrap,
      suspect: (r, what) => isSuspect(deps, r, what),
      timing: timingOn,
      waitOf: (r) => timing.get(bankStockWaitKey(look.bank, r.key)) ?? null,
    });
    // After the candidates were built from the memories before this look.
    if (timingOn) saveTiming(deps, bankStockTimingNext(timing, look, now));
    if (cands.length === 0) return 0;
    const last = loadNotified(deps);
    const due: BankStockNotifyCandidate[] = [];
    const taken = new Set<string>();
    for (const c of cands) {
      // Per item and bank (a painted and a clean copy new on the same save are one notification), a watch per watch.
      if (taken.has(c.dedupeKey)) continue;
      const ts = last.get(c.dedupeKey);
      if (ts !== undefined && now - ts < BANK_STOCK_NOTIFY_DEDUP_MS && now >= ts) continue;
      taken.add(c.dedupeKey);
      if (c.kind === 'watch') {
        // A watch hit also records the S3 key, so the S3 kinds stay quiet after it. It is exempt from that key, not
        // from the engine: a toast the engine sent at or after this look's save (an import held for the market's first
        // build, judged by the engine first) told this read's find, so it is recorded, not sent again. An engine toast
        // from before the save was about an earlier read and does not hold this one back.
        taken.add(bankStockNotifyKey(imported.bank, c.row.sku));
        if (toldBefore(deps, c.row.sku, now, look.savedAt)) continue;
      }
      // Already told by another toast (the engine's "Profit:" one at start-up): recorded, not sent again.
      else if (toldBefore(deps, c.row.sku, now)) continue;
      due.push(c);
    }
    if (taken.size === 0) return 0;
    for (const key of taken) last.set(key, now);
    saveNotified(deps, last, now);
    if (due.length === 0) return 0;
    if (deps.told) {
      // Only a toast that tells a flip the engine would tell (tellsFlip): one of an unconfirmed order, no buyer, no flip,
      // a suspect margin or low confidence leaves the engine's own toast free once the find is a flip (0.7.4).
      for (const c of due) {
        if (c.tellsFlip !== true) continue;
        try {
          deps.told(c.row.sku, now);
        } catch {
          // Only costs a second toast from the engine.
        }
      }
    }
    let sent = 0;
    const send = (p: PushContract['notify']): void => {
      try {
        deps.notify(p);
        sent++;
      } catch (err) {
        deps.log.warn('Bank stock notification failed', { error: errorText(err) });
      }
    };
    const ago = Math.max(0, now - look.savedAt);
    const staleMs = deps.settings().profit?.inputStaleMs;
    if (finite(staleMs) && staleMs > 0 && ago > staleMs) {
      // An old save: its prices may have moved since, so one dated line beats a toast per item.
      send({ ...bankStockOldSaveSummary(due, info.url, ago), sku: null, openBankStock: { bank: imported.bank, filter: bankStockSummaryChip(due) } });
      return sent;
    }
    const individual = due.slice(0, BANK_STOCK_MAX_NOTIFICATIONS);
    for (const c of individual) {
      // The Wait note is part of the opt-in G4 (timingOn): off, the default, a toast's text is 0.7.4's.
      send({ ...bankStockNoticeOf(c, info.label, K, ago, timingOn), sku: c.row.sku });
    }
    const rest = due.slice(individual.length);
    // G5: the summary opens the bank's stock page on the chip its items show under (an in-app route, never a URL).
    if (rest.length > 0) send({ ...bankStockSummaryNotice(rest, info.url), sku: null, openBankStock: { bank: imported.bank, filter: bankStockSummaryChip(rest) } });
    return sent;
  } catch (err) {
    deps.log.warn('Bank stock notifications failed', { error: errorText(err) });
    return 0;
  }
}

export interface NewFlipNotifierDeps extends BankStockNotifyDeps {
  clock: Clock;
  /** Whether the Live market has finished its first build (core: market.stats().lastFullAt !== null). */
  marketBuilt(): boolean;
}

/** S3 (0.8: and G1-G4) as core runs it: notifyNewBankFlips now, or once the Live market has built. */
export interface NewFlipNotifier {
  /** A bank page import wrote a save (after BankStock.refresh). */
  imported(x: { bank: ScraptfBank; batchId: number }): void;
  /** Core: on the market's change push and the status tick. Notifies the held imports once the market has built. */
  flush(): void;
  /** Imports held for the market's first build (tests). */
  held(): number;
  /**
   * Whether a "New on scrap.tf" notification told of this base SKU as a flip within BANK_STOCK_NOTIFY_DEDUP_MS
   * (in memory: this process's notifications; only toasts whose tellsFlip holds). Core's engine skips its own
   * "Profit:" toast for an imported item it names, so one find makes one toast.
   */
  toldRecently(baseSku: string, now: UnixMs): boolean;
  /**
   * Another notification told of this base SKU (core: the engine toasted an imported price of it, in a
   * toast or its summary). For BANK_STOCK_NOTIFY_DEDUP_MS a "New on scrap.tf" row of it is recorded but
   * not toasted: at start-up the engine judges a held import first, and one find makes one toast. A watch
   * hit is held back only when the engine's toast came at or after the told look's save (this read's find).
   */
  toastedElsewhere(baseSku: string, at: UnixMs): void;
}

/**
 * The verdicts read the Live market's entries, and before its first build there are none: the folder
 * watch's catch-up of pages saved while the app was closed runs right at start, so every row would read
 * "no buyers" and nothing would ever be told. Such an import is held (every one: per bank, each batch)
 * and notified by the first flush() after the build. newFlips tells only the first import of each page's
 * newest look, so of a page imported twice, or an older page imported after the newest, exactly the
 * newest look is told once. 0.8: the deps (the stock's lookOf and isSuspect, the watches) pass through to
 * notifyNewBankFlips, the one pipeline every kind (watch, new, cheaper, back, timing) goes through. Never throws.
 */
export function createNewFlipNotifier(deps: NewFlipNotifierDeps): NewFlipNotifier {
  const held = new Map<ScraptfBank, Set<number>>();
  const toldAt = new Map<string, UnixMs>();
  /** Base SKUs another toast told of (the engine's), with the time. */
  const elsewhereAt = new Map<string, UnixMs>();
  const fresh = (ts: UnixMs, at: UnixMs): boolean => at >= ts && at - ts < BANK_STOCK_NOTIFY_DEDUP_MS;
  /** Bounded by the window: only items told in the last 30 minutes stay. */
  const remember = (map: Map<string, UnixMs>, base: string, at: UnixMs): void => {
    for (const [k, ts] of map) if (!fresh(ts, at)) map.delete(k);
    map.set(base, at);
  };
  const notifyDeps: BankStockNotifyDeps = {
    ...deps,
    told(base, at) {
      remember(toldAt, base, at);
      try {
        deps.told?.(base, at);
      } catch {
        // A caller's own hook never stops the notifications.
      }
    },
    toldBefore(base, at, since) {
      const ts = elsewhereAt.get(base);
      // `since` (a watch hit): only the engine's toast of this read (at or after its save) holds it back.
      if (ts !== undefined && fresh(ts, at) && (since === undefined || ts >= since)) return true;
      return (since === undefined ? deps.toldBefore?.(base, at) : deps.toldBefore?.(base, at, since)) === true;
    },
  };
  const built = (): boolean => {
    try {
      return deps.marketBuilt() === true;
    } catch {
      // Unknown: better told against the entries there are than held for ever.
      return true;
    }
  };
  const now = (): UnixMs => {
    try {
      return deps.clock.now();
    } catch {
      return Date.now();
    }
  };
  return {
    imported(x) {
      if (built()) {
        notifyNewBankFlips(notifyDeps, x, now());
        return;
      }
      // Every import, not the last one per bank: the newest look may have come first (an older page,
      // or the same file again, imported after it), and newFlips picks it out at flush.
      let batches = held.get(x.bank);
      if (!batches) held.set(x.bank, (batches = new Set()));
      batches.add(x.batchId);
    },
    flush() {
      if (held.size === 0 || !built()) return;
      const due = [...held];
      held.clear();
      for (const [bank, batches] of due) for (const batchId of batches) notifyNewBankFlips(notifyDeps, { bank, batchId }, now());
    },
    held: () => [...held.values()].reduce((n, b) => n + b.size, 0),
    toldRecently(baseSku, at) {
      const ts = typeof baseSku === 'string' ? toldAt.get(baseSku) : undefined;
      return ts !== undefined && fresh(ts, at);
    },
    toastedElsewhere(baseSku, at) {
      if (typeof baseSku === 'string' && Number.isFinite(at)) remember(elsewhereAt, baseSku, at);
    },
  };
}

/** opps.exportCsv {kind:'bankStock'}: BANK_STOCK_CSV_COLUMNS, money as keys + ref, missing values blank. */
export function bankStockCsv(rows: readonly BankStockRow[], keyScrap: Scrap | null): string {
  return toCsv([BANK_STOCK_CSV_COLUMNS, ...rows.map((r) => bankStockCsvCells(r, keyScrap))]);
}
