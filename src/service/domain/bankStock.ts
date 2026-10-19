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
// /items/2, never with /items), reading the rows of each page's newest save and the one
// before it (the newest from an earlier time, so a page imported twice does not diff
// against itself). It keeps diffBankStock of each pair at the engine's key price,
// merged over the bank's pages (bankStockMergePages), plus bankStockNewAt over all
// pages. A save's rows never change once
// written, so they are cached by batch id and only a new save is read. list()/all()/
// whatsNew() join each kept diff row to market.entryFor(base) per call, so verdicts
// follow the live book with no query at all; newAtFor, detailFor and seenFor (F19)
// read the kept diffs only. F20: the rows' time listed comes from the scrap.tf
// history's runs index (deps.history.runsFor, one in-memory map per read).

import {
  BANK_STOCK_CSV_COLUMNS,
  BANK_STOCK_KEEP_SAVES,
  BANK_STOCK_MAX_NOTIFICATIONS,
  BANK_STOCK_MAX_PAGES,
  BANK_STOCK_NOTIFY_DEDUP_MS,
  bankStockCounts,
  bankStockCsvCells,
  bankStockItemOf,
  bankStockMatching,
  bankStockMergePages,
  bankStockMoreNotice,
  bankStockNewAt,
  bankStockNewFlipNotice,
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
import type { CeilingSettings } from '../../shared/ceiling';
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
  Settings,
  UnixMs,
} from '../../shared/types';
import type { Clock, Logger, Repo } from '../contracts';
import { isSuspectMargin } from './confidence';
import { toCsv } from './csv';
import { notifyKinds } from './engine';
import { defaultKeyPrice } from './keyprice';
import type { MarketEval, MarketIndex } from './market';
import type { ScraptfHistory } from './scraptfHistory';

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
   * Omitted (tests, 0.6): those fields are null.
   */
  history?: Pick<ScraptfHistory, 'runsFor'>;
}

export interface BankStock {
  /**
   * Re-reads each bank's newest pair of saves and diffs them (core: after an import wrote bank stock,
   * after maintenance pruned some, and on a key price move of 1 scrap or more). Never throws: a failed
   * read keeps the last good diffs and is logged once per failure streak.
   */
  refresh(): void;
  /** 'scraptf.bankStock': one bank's rows (filter, search, sort, page) and counts. Never throws. */
  list(q: BankStockQuery, now: UnixMs): BankStockResult;
  /** Every row matching q's filter and search in q's order, paging ignored (opps.exportCsv 'bankStock'). */
  all(q: BankStockQuery, now: UnixMs): BankStockRow[];
  /** ScraptfBankSummary.whatsNew for the banks summary; null until a page of the bank has 2 saves. */
  whatsNew(bank: ScraptfBank): ScraptfBankSummary['whatsNew'];
  /** MarketRow.scraptfNewAt for a base SKU (bankStockNewAt), else null. */
  newAtFor(baseSku: string): UnixMs | null;
  /** ItemDetail.bankStock for a SKU (bankStockItemOf at the engine's key price), else null. */
  detailFor(sku: string): ItemDetail['bankStock'];
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
   * toasts one.
   */
  newFlips(bank: ScraptfBank, batchId: number): BankStockRow[];
}

/** One page of a bank: its kept pair, diffed (`diff`: only the rows the bank shows, bankStockMergePages). */
interface PageState extends BankStockBankDiff {
  page: string;
  newest: BankStockSave;
  /** The page's newest kept save from before its newest one's time, or null: a first save of the page. */
  previous: BankStockSave | null;
  /** The first import of the newest look (BankStockPagePair.firstBatchId): the one batch S3 tells of. */
  firstBatchId: number;
}

/** One bank: each page saved, and the rows they show together. */
interface BankState {
  /** Newest page first. */
  pages: PageState[];
  /** Every page's shown rows: the stock page, its counts and "What's new". */
  diff: BankStockDiffRow[];
  /** Rows listed on the pages' newest saves (each item once). */
  items: number;
  /** The newest page's newest save. */
  savedAt: UnixMs;
  /** The earliest previous save among the pages that have one (every change shown is since then), else null. */
  previousSavedAt: UnixMs | null;
  /** The oldest of the pages' newest saves. */
  oldestSavedAt: UnixMs;
  /** Kept saves read (<= BANK_STOCK_KEEP_SAVES per page). */
  saves: number;
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

/** The same pages with the same pair each: the kept diffs still stand (only firstBatchId may move). */
function samePairs(old: readonly PageState[], pairs: readonly BankStockPagePair<BankStockSave>[]): boolean {
  return old.length === pairs.length && pairs.every((p, i) => old[i]!.page === p.page && sameSave(old[i]!.newest, p.newest) && sameSave(old[i]!.previous, p.previous));
}

/**
 * Saves read per bank: each page's newest BANK_STOCK_KEEP_SAVES, for BANK_STOCK_MAX_PAGES pages. Read per
 * page (`perPage`): F20 keeps up to 300 saves a page, so the bank's newest saves overall could leave out a
 * quiet page, or the save it is compared with, that the history and the feed still read.
 */
const SAVES_READ = BANK_STOCK_KEEP_SAVES * BANK_STOCK_MAX_PAGES;
const SAVES_PER_PAGE = { perPage: BANK_STOCK_KEEP_SAVES } as const;

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

  /** Every page of every bank, each with its own save time (the market's New badge and the drawer). */
  function allPages(): PageState[] {
    return [...banks.values()].flatMap((st) => st.pages);
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
        const saves = pairs.reduce((n, p) => n + p.saves, 0);
        if (old && samePairs(old.pages, pairs) && old.diffKey === K) {
          old.saves = saves;
          pairs.forEach((p, i) => (old.pages[i]!.firstBatchId = p.firstBatchId));
          keep(old);
          continue;
        }
        // Each page against its own previous save only, then shown together (an item once).
        const pages = bankStockMergePages(
          pairs.map(
            (p): PageState => ({
              bank: info.bank,
              page: p.page,
              savedAt: p.newest.savedAt,
              previousSavedAt: p.previous?.savedAt ?? null,
              diff: diffBankStock(rowsOf(p.newest.batchId), p.previous ? rowsOf(p.previous.batchId) : null, K),
              newest: p.newest,
              previous: p.previous,
              firstBatchId: p.firstBatchId,
            }),
          ),
        );
        const diff = pages.flatMap((p) => p.diff);
        const previousTimes = pages.flatMap((p) => (p.previous ? [p.previous.savedAt] : []));
        const st: BankState = {
          pages,
          diff,
          items: diff.reduce((n, d) => n + (d.current !== null ? 1 : 0), 0),
          savedAt: pages[0]!.savedAt,
          previousSavedAt: previousTimes.length > 0 ? Math.min(...previousTimes) : null,
          oldestSavedAt: Math.min(...pages.map((p) => p.savedAt)),
          saves,
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
      newAt = bankStockNewAt(allPages());
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

  /**
   * F5: a suspect margin is shown but never notified, as the engine's toasts: few buy orders, no usable
   * reference and a margin above profit.suspectMargin (a free item with a profit counts as unbounded).
   */
  function suspect(r: BankStockRow): boolean {
    const e = entryOf(r.sku);
    if (!e) return false;
    const margin = r.margin ?? (r.costScrap <= 0 && (r.profitScrap ?? 0) > 0 ? Number.POSITIVE_INFINITY : null);
    return isSuspectMargin(margin, e.eligibleCount, e.referenced !== false, deps.settings().profit.suspectMargin);
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

  /**
   * Shown diff rows (a bank's, or one page's), joined to the live book now and (F20) to the bank's runs
   * index; `changedOnly` skips unchanged rows (whatsNew, S3).
   */
  function rowsFor(bank: ScraptfBank, diff: readonly BankStockDiffRow[], K: Scrap, profit: CeilingSettings, changedOnly = false): BankStockRow[] {
    checkSchema();
    const runs = runsOf(bank);
    const out: BankStockRow[] = [];
    for (const d of diff) {
      if (changedOnly && d.change === null) continue;
      const row = bankStockRow(d, { category: categoryOf(d.sku), buy: buySideOf(d.sku), keyScrap: K, profit, run: runs?.get(d.key) ?? null });
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
      rows: rowsFor(q.bank, st.diff, kp.valueScrap, profitSettings()),
      items: st.items,
      savedAt: st.savedAt,
      previousSavedAt: st.previousSavedAt,
      saves: st.saves,
      pages: { count: st.pages.length, oldestSavedAt: st.oldestSavedAt },
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
        // F20: `now` decides the 'long-listed' filter, as list() does through bankStockResult.
        return bankStockMatching(rowsFor(q.bank, st.diff, readKeyPrice().valueScrap, profitSettings()), filters, now);
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

    version() {
      ensure();
      return ver;
    },

    newFlips(bank, batchId) {
      try {
        ensure();
        // Only the first import of a page's newest look tells: a page imported again (same time, a
        // higher batch id) is no new look, and an older page imported late is not the newest. Judged by
        // the look, so a held import still tells after the same file came in again. Only that page's
        // own diff counts: another page of the bank is never what it is compared with.
        const pg = typeof batchId === 'number' ? banks.get(bank)?.pages.find((p) => p.firstBatchId === batchId) : undefined;
        if (!pg || pg.previous === null) return [];
        const rows = rowsFor(bank, pg.diff, readKeyPrice().valueScrap, profitSettings(), true).filter((r) => r.change === 'new' && r.verdict === 'flip' && !suspect(r));
        return rows.sort((a, b) => (b.profitScrap ?? 0) - (a.profitScrap ?? 0) || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      } catch (err) {
        log.warn('Bank stock could not read the new flips', { bank, error: errorText(err) });
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// S3: "New on scrap.tf" notifications
// ---------------------------------------------------------------------------

export interface BankStockNotifyDeps {
  log: Logger;
  /** The dedupe map lives in repo meta (BANK_STOCK_NOTIFY_META_KEY), so a restart notifies nothing twice. */
  repo: Pick<Repo, 'getMeta' | 'setMeta'>;
  stock: Pick<BankStock, 'newFlips'>;
  settings(): Settings;
  keyPrice(): KeyPriceState;
  /** core: push('notify', n); main applies notifications.silent. */
  notify(n: PushContract['notify']): void;
  /** Each base SKU a notification (or the summary) told of, with the time: the engine skips its own toast for it. Optional. */
  told?(baseSku: string, at: UnixMs): void;
  /**
   * Whether another notification already told of this base SKU within BANK_STOCK_NOTIFY_DEDUP_MS (core:
   * the engine's "Profit:" toast of an imported price, which comes first when an import is held for the
   * market's first build). Such a row is recorded in the dedupe but not toasted: one toast per find.
   * Optional; a failing check toasts as before.
   */
  toldBefore?(baseSku: string, now: UnixMs): boolean;
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
function toldBefore(deps: BankStockNotifyDeps, baseSku: string, now: UnixMs): boolean {
  if (!deps.toldBefore) return false;
  try {
    return deps.toldBefore(baseSku, now) === true;
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

/**
 * S3, after an import wrote a save of `imported.bank` (and the stock was refreshed): notifies the rows
 * that save made new and that are flips. Gates: notifications.enabled, .newOnScraptf, 'import' in
 * .inputKinds, .minConfidence (the buy side's) and .minProfitScrap; dedupe per bank and SKU for
 * BANK_STOCK_NOTIFY_DEDUP_MS across restarts; at most BANK_STOCK_MAX_NOTIFICATIONS, most profit first,
 * then one summary ("+N more new flips on scrap.tf/buy/hats", no SKU). A first save of a page, or an
 * older page imported late, notifies nothing (BankStock.newFlips), and an item another notification
 * already told of (deps.toldBefore) is only recorded. Returns the notifications sent; never throws.
 */
export function notifyNewBankFlips(deps: BankStockNotifyDeps, imported: { bank: ScraptfBank; batchId: number }, now: UnixMs): number {
  try {
    const n = deps.settings().notifications;
    // inputKinds as the engine reads it (notifyKinds: a missing or broken value is every kind, the default).
    if (n?.enabled !== true || n.newOnScraptf === false || !notifyKinds(n.inputKinds).has('import')) return 0;
    const info = scraptfBankInfo(imported.bank);
    if (!info) return 0;
    const rows = deps.stock.newFlips(imported.bank, imported.batchId);
    if (rows.length === 0) return 0;
    const minConfidence = finite(n.minConfidence) ? n.minConfidence : 0;
    const minProfit = finite(n.minProfitScrap) ? n.minProfitScrap : 0;
    const last = loadNotified(deps);
    const due: BankStockRow[] = [];
    const taken = new Set<string>();
    for (const r of rows) {
      if ((r.confidence ?? 0) < minConfidence) continue;
      if (!finite(r.profitScrap) || r.profitScrap < minProfit) continue;
      // Per item and bank: a painted and a clean copy new on the same save are one notification.
      const key = `${imported.bank}|${r.sku}`;
      if (taken.has(key)) continue;
      const ts = last.get(key);
      if (ts !== undefined && now - ts < BANK_STOCK_NOTIFY_DEDUP_MS && now >= ts) continue;
      taken.add(key);
      // Already told by another toast (the engine's "Profit:" one at start-up): recorded, not sent again.
      if (toldBefore(deps, r.sku, now)) continue;
      due.push(r);
    }
    if (taken.size === 0) return 0;
    for (const key of taken) last.set(key, now);
    saveNotified(deps, last, now);
    if (due.length === 0) return 0;
    if (deps.told) {
      for (const r of due) {
        try {
          deps.told(r.sku, now);
        } catch {
          // Only costs a second toast from the engine.
        }
      }
    }
    let K: Scrap | null = null;
    try {
      K = deps.keyPrice().valueScrap;
    } catch {
      K = null;
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
    const individual = due.slice(0, BANK_STOCK_MAX_NOTIFICATIONS);
    for (const r of individual) send({ ...bankStockNewFlipNotice(info.label, r, K), sku: r.sku });
    const rest = due.length - individual.length;
    if (rest > 0) send({ title: bankStockMoreNotice(rest, info.url), body: 'From the page you saved. Open TF2 Flip Desk to see them.', sku: null });
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

/** S3 as core runs it: notifyNewBankFlips now, or once the Live market has built. */
export interface NewFlipNotifier {
  /** A bank page import wrote a save (after BankStock.refresh). */
  imported(x: { bank: ScraptfBank; batchId: number }): void;
  /** Core: on the market's change push and the status tick. Notifies the held imports once the market has built. */
  flush(): void;
  /** Imports held for the market's first build (tests). */
  held(): number;
  /**
   * Whether a "New on scrap.tf" notification told of this base SKU within BANK_STOCK_NOTIFY_DEDUP_MS
   * (in memory: this process's notifications). Core's engine skips its own "Profit:" toast for an
   * imported item it names, so one find makes one toast.
   */
  toldRecently(baseSku: string, now: UnixMs): boolean;
  /**
   * Another notification told of this base SKU (core: the engine toasted an imported price of it, in a
   * toast or its summary). For BANK_STOCK_NOTIFY_DEDUP_MS a "New on scrap.tf" row of it is recorded but
   * not toasted: at start-up the engine judges a held import first, and one find makes one toast.
   */
  toastedElsewhere(baseSku: string, at: UnixMs): void;
}

/**
 * The verdicts read the Live market's entries, and before its first build there are none: the folder
 * watch's catch-up of pages saved while the app was closed runs right at start, so every row would read
 * "no buyers" and nothing would ever be told. Such an import is held (every one: per bank, each batch)
 * and notified by the first flush() after the build. newFlips tells only the first import of each page's
 * newest look, so of a page imported twice, or an older page imported after the newest, exactly the
 * newest look is told once. Never throws.
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
    toldBefore(base, at) {
      const ts = elsewhereAt.get(base);
      if (ts !== undefined && fresh(ts, at)) return true;
      return deps.toldBefore?.(base, at) === true;
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
