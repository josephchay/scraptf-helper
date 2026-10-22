// Every SERVICE_METHODS entry from src/shared/rpc.ts, with zod-validated
// params. Errors are plain messages: no stacks and no file paths reach the
// dashboard (entry.ts scrubs them once more).

import { z } from 'zod';
import {
  BANK_STOCK_MAX_LIMIT,
  BANK_STOCK_MAX_SEARCH_CHARS,
  bankStockKey,
  bankStockOnSale,
  bankStockSpecialKey,
  bankStockTargetOf,
} from '../shared/bankStock';
import { CHECK_MAX_CHARS } from '../shared/check';
import { holdingsValuationOf, journalValuerOf } from '../shared/holdings';
import type { JournalLotValuer } from '../shared/journal';
import {
  JOURNAL_ENTRY_GONE,
  JOURNAL_MAX_FEE_KEYS,
  JOURNAL_MAX_FEE_SCRAP,
  JOURNAL_WRITE_OFF_NOTHING,
  feeOf,
  feePatchOf,
  typicalHoldOf,
} from '../shared/journal';
import {
  WATCHES_FULL,
  WATCHES_MAX,
  WATCH_ANY_COPY_SENTINEL,
  WATCH_COPY_TAKEN,
  WATCH_GONE,
  WATCH_MAX_KEYS,
  WATCH_MAX_SCRAP,
  WATCH_NAME_MAX,
  WATCH_NOT_A_COPY,
  WATCH_SPECIAL_MAX,
  watchRestoreOf,
  watchViewsOf,
  watchWriteOf,
} from '../shared/watches';
import {
  BENIGN_SKIP_REASONS,
  CRAFT_UNVERIFIED,
  DUPLICATE_ROW,
  FUTURE_MTIME,
  FUTURE_MTIME_SLACK_MS,
  IMPORT_REFUSAL_CODES,
  IMPORT_REPORT_RING,
  IMPORT_SCHEMA_LOADING_CODE,
  IMPORT_SCHEMA_LOADING_MESSAGE,
  LAYOUT_CHANGED,
  NO_STOCK_LIMIT,
  PARTIAL_READ,
  PARTIAL_READ_MAX_AGE_MS,
  PARTIAL_READ_MIN_KEYS,
  PARTIAL_READ_RATIO,
  SKIP_BANK_CARD_PRICE,
  SKIP_CRAFT_UNPROVEN,
  SKIP_NEWER_SAVE,
  SKIP_NOT_ON_SALE_NEWER,
  SKIP_OUT_OF_STOCK,
  SKIP_SAME_OR_CHEAPER,
  UNUSUALS_INDEX,
  importWarningCode,
} from '../shared/importCodes';
import { SCRAPTF_CHANGES_MAX_LIMIT, SCRAPTF_EVENTS_MAX_AGE_MS } from '../shared/scraptfHistory';
import { isScraptfPageUrl, SCRAPTF_WINDOW_OFF } from '../shared/scraptfWindowPolicy';
import { buildLinks } from '../shared/links';
import type { PushContract, PushEvent } from '../shared/rpc';
import { SERVICE_METHODS } from '../shared/rpc';
import { MARKET_MAX_LIMIT, MARKET_MAX_SEARCH_CHARS, MARKET_SORTS, countCategories, marketSearchTokens } from '../shared/market';
import { EVENTS_EXPORT_MAX, eventMatches } from '../shared/opportunityEvents';
import { newestTypedPriceFor } from '../shared/priceCopy';
import { baseSku as toBaseSku, canonical, fromObject, fromString, isValidSku, looksLikeSku } from '../shared/sku';
import {
  BANK_STOCK_FILTERS,
  BANK_STOCK_SORTS,
  CHECK_SOURCES,
  EMPTY_SPECIAL,
  IMPORT_ORIGINS,
  JOURNAL_SIDES,
  MARKET_SOURCES,
  MARKET_VERDICTS,
  OPP_SORTS,
  SCRAPTF_BANK_IDS,
  SCRAPTF_CHANGE_KINDS,
  SECRET_NAMES,
  type AppStatus,
  type BankStockFilter,
  type BankStockQuery,
  type BankStockResult,
  type BankStockRow,
  type BankStockSort,
  type BankStockStored,
  type Category,
  type CategoryCounts,
  type CheckResult,
  type CheckSource,
  type HealthReport,
  type HistoryPoint,
  type HoldingDetail,
  type LoadedKeyHistory,
  type ImportOrigin,
  type ImportReport,
  type ImportResult,
  type ImportTopFlip,
  type ItemBookHistory,
  type JournalSide,
  type MarketSort,
  type MarketSource,
  type MarketVerdict,
  type OppSort,
  type ParsedScrapItem,
  type ReserveSuggestion,
  type ScrapPrice,
  type ScrapPriceInput,
  type ScraptfBank,
  type ScraptfBanksResult,
  type ScraptfChangeEvent,
  type ScraptfChangeKind,
  type ScraptfChangesQuery,
  type ScraptfItemHistory,
  type ScraptfListCraft,
  type ScraptfListStatus,
  type ScraptfListStored,
  type ScraptfWatch,
  type ScraptfWatchView,
  type SecretName,
  type Settings,
  type SpecialAttrs,
  type UnixMs,
} from '../shared/types';
import { RESERVE_LOOKBACK_MS, RESERVE_MAX_MARKS, reserveSuggestionOf } from '../shared/reserveSuggest';
import { BOOK_HISTORY_ORDERS_MAX } from '../shared/orderPersistence';
import type { BptfApi, Clock, Engine, HttpClient, Logger, PriceDb, Repo, SchemaService, SteamMarket } from './contracts';
import {
  buildItemDetail,
  eventsCsv,
  journalCsv,
  journalSummary,
  listOpportunities,
  opportunitiesCsv,
  previewRule,
} from './domain';
import type { BanksSummary } from './domain/banks';
import { bankStockCsv, type BankStock } from './domain/bankStock';
import type { ScraptfHistory } from './domain/scraptfHistory';
import { readItemBookHistory } from './domain/bookHistory';
import type { WatchCache } from './domain/watches';
import { holdingsCsv, type Holdings } from './domain/holdings';
import type { LiveCheck } from './domain/liveCheck';
import { marketBankOfSku, marketCategoryOf, marketCsv, type MarketIndex } from './domain/market';
import type { ScraptfListCache } from './domain/scraptfList';
import { buildShoppingList, shoppingCsv } from './domain/shopping';
import { createBuyerChecker } from './buyerCheck';
import { ImportTooLargeError, isImportableItem, isMhtmlFileName, MAX_IMPORT_BYTES, parseSavedPage, sellsPriceOf, type SavedPageParse } from './import';
import { importReports, recordImportReport, type ImportReportInput } from './import/reports';
import { allowedHosts, normalizeHost } from './net';
import { MAX_BULK_LINES, parseBulkPrices, pricesCsv, rulesFromJson, rulesToJson } from './priceSheetIo';
import { categoryEnum, finite, id, nonNeg, ruleInputSchema } from './rpcSchemas';

export interface HandlerContext {
  clock: Clock;
  log: Logger;
  repo: Repo;
  http: HttpClient;
  schema: SchemaService;
  pricedb: PriceDb;
  bptfApi: BptfApi;
  scm: SteamMarket;
  engine: Engine;
  /** Live market index (F10): in memory, fed by the same local book as the engine; no network. */
  market: MarketIndex;
  /** Holdings (F11): open journal lots priced from the same local book; no network. */
  holdings: Holdings;
  /** F14: the user's saved scrap.tf/items price list, in memory; filled only by saved pages (R10), no network. */
  scraptfList: ScraptfListCache;
  /**
   * F14: rows were written to (or purged from) scraptf_list. Core refreshes the list cache, re-reads the
   * key price (the list's key row), re-checks holdings and pushes 'scraptf.listChanged'.
   */
  scraptfListChanged(): void;
  /** F15: the per-bank summary ('scraptf.banks'), in memory; core invalidates it and pushes 'scraptf.banksChanged'. */
  banks: Pick<BanksSummary, 'summary'>;
  /**
   * F17: each bank's newest pair of saves, diffed and joined to the Live market per read ('scraptf.bankStock'); no network.
   * F21: importSavedPage counts a window read's new flips with newFlips (ImportResult.newFlips); 0.7.1: and
   * the flips on its page with pageFlips (ImportResult.pageFlips, topFlips). 0.8: droppedFlips
   * (ImportResult.droppedFlips) and watchRows ('watches.list').
   */
  bankStock: Pick<BankStock, 'list' | 'all' | 'detailFor' | 'newFlips' | 'pageFlips' | 'droppedFlips' | 'watchRows'>;
  /** 0.8 (G1): the user's scrap.tf watches in memory (domain/watches.ts); 'watches.list' reads them, writes go through repo. */
  watches: Pick<WatchCache, 'all'>;
  /** 0.8: a watch was added, changed or removed: core re-reads the cache, drops the watch list (watchedSet), tells holdings (H1) and pushes 'watches.changed'. */
  watchesChanged(): void;
  /**
   * F17: bank_stock rows were written (an import of a recognised page: `imported` names its bank and batch)
   * or pruned (no argument). Called before pricesChanged, so pages refetching on its pushes read the new
   * stock. Core refreshes the bank stock cache, notifies the new flips of the imported bank
   * (notifyNewBankFlips) and invalidates the banks summary.
   */
  bankStockChanged(imported?: { bank: ScraptfBank; batchId: number }): void;
  /**
   * F20: the history of the user's saves (runs index, change feed); in memory plus scraptf_events; no
   * network. importSavedPage calls onImport(batchId) inside its transaction after insertBankStock and
   * pushes 'scraptf.changed' after the commit when it wrote events. 0.8 (T4/T7): timingForCopy (optional, so test
   * stubs compile) joins 'opps.list' rows' timing from the cached saves. 0.9 (history): recordLows (optional, D29) keeps
   * the save's lowest prices per copy in the same transaction, right after onImport.
   */
  scraptfHistory: Pick<ScraptfHistory, 'onImport' | 'itemHistory' | 'changes' | 'csv'> & Partial<Pick<ScraptfHistory, 'timingForCopy' | 'recordLows'>>;
  /** F16 live check: copied or typed text against the local book and the saved list, plus the recent ring; no network. */
  liveCheck: Pick<LiveCheck, 'check' | 'recent'>;
  /** The saved-page folder watch as it runs (a missing folder or a failed OS watch is not active) and its last error. */
  folderWatch(): { active: boolean; error: string | null };
  settings(): Settings;
  secret(name: SecretName): string | null;
  push<E extends PushEvent>(event: E, payload: PushContract[E]): void;
  status(): AppStatus;
  health(): HealthReport;
  /** The scrap.tf price list changed (watchlist cache, setup checklist). */
  pricesChanged(): void;
  /** A journal row was added, edited or deleted: held SKUs (watch list), holdings, and the 'journal.changed' push. */
  journalChanged(): void;
  /** Queue a background snapshot for a base SKU (served by the scheduler within the budget). */
  queueSnapshot(baseSku: string): void;
  snapshot(baseSku: string, priority: 'user' | 'background'): Promise<void>;
  snapshotStale(baseSku: string): boolean;
  /** The user re-enabled a host disabled after a challenge page (re-run its jobs, refresh the status). */
  hostUnblocked(host: string): void;
}

export const HISTORY_CACHE_MS = 10 * 60_000;
/** item.detail waits at most this long for PriceDB history; a slower answer fills the cache for next time. */
export const HISTORY_WAIT_MS = 4_000;
const PRICEDB_FRESH_MS = 30 * 60_000;
const USER_SNAPSHOT_MAX_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const skuText = z
  .string()
  .trim()
  .min(1, 'an item is required')
  .max(300)
  // SKUs are lower case; isValidSku rejects tokens fromString would silently drop
  // ("uncratable"), which would otherwise save the price under another item.
  .toLowerCase()
  .refine(isValidSku, 'not a SKU (pick an item first)');
const limit = (max: number) => z.number().int().min(1).max(max).optional();

const statusEnum = z.enum(['profitable', 'below-threshold', 'unprofitable', 'no-buyers']);
const tierEnum = z.enum(['key', 'ref10', 'ref2', 'small', 'loss', 'none']);
const inputKindEnum = z.enum(['user', 'import', 'rule']);

const oppQuery = z
  .object({
    status: z.array(statusEnum).max(10).optional(),
    categories: z.array(categoryEnum).max(20).optional(),
    tiers: z.array(tierEnum).max(10).optional(),
    minConfidence: finite.optional(),
    inputKinds: z.array(inputKindEnum).max(5).optional(),
    search: z.string().max(200).optional(),
    // 0.9 (#3): 'backup' and 'depth' join the sorts (OPP_SORTS; the repo's OPP_SORT orders them, missing last).
    sort: z.enum(OPP_SORTS as unknown as [OppSort, ...OppSort[]]).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    offset: z.number().int().min(0).optional(),
    groupBy: z.enum(['category', 'tier', 'confidence', 'input']).optional(),
  })
  .optional();

const eventQuery = z
  .object({
    limit: limit(5000),
    beforeId: z.number().int().optional(),
    sku: z.string().max(300).optional(),
    kinds: z.array(z.enum(['appeared', 'changed', 'gone', 'notified'])).max(4).optional(),
    sinceTs: finite.optional(),
  })
  .optional();

// 0.7.3: the Live log's filters for its events export (EventsExportQuery).
const eventsExportQuery = z
  .object({
    kinds: z.array(z.enum(['appeared', 'changed', 'gone', 'notified'])).max(4).optional(),
    category: categoryEnum.optional(),
    search: z.string().max(MARKET_MAX_SEARCH_CHARS).optional(),
  })
  .optional();

const specialSchema = z.object({
  paint: z.number().int().nullable(),
  spells: z.array(z.string().max(100)).max(20),
  parts: z.array(z.string().max(100)).max(20),
  sheen: z.number().int().nullable(),
  killstreaker: z.number().int().nullable(),
  customName: z.boolean(),
  customDesc: z.boolean(),
});

const priceInput = z.object({
  id: id.optional(),
  sku: skuText,
  name: z.string().max(300).optional(),
  costKeys: nonNeg.optional(),
  costScrap: nonNeg,
  source: z.enum(['user', 'import']).optional(),
  observedAt: finite.optional(),
  note: z.string().max(500).nullable().optional(),
  importBatch: id.nullable().optional(),
  special: specialSchema.nullable().optional(),
  assetId: z.string().max(40).nullable().optional(),
  stock: z.number().int().min(0).nullable().optional(),
  // 0.7.4 (F80): 'prices.upsert' with no id updates the newest typed price of the copy (ScrapPriceInput).
  replaceTyped: z.boolean().optional(),
});

const ruleInput = ruleInputSchema;

const shoppingQuery = z
  .object({
    categories: z.array(categoryEnum).max(20).optional(),
    search: z.string().max(200).optional(),
    minCeilingScrap: nonNeg.optional(),
    onlyBotBuyers: z.boolean().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .optional();

const marketQuery = z
  .object({
    search: z.string().max(MARKET_MAX_SEARCH_CHARS).optional(),
    categories: z.array(categoryEnum).max(20).optional(),
    verdicts: z.array(z.enum(MARKET_VERDICTS as unknown as [MarketVerdict, ...MarketVerdict[]])).max(10).optional(),
    sources: z.array(z.enum(MARKET_SOURCES as unknown as [MarketSource, ...MarketSource[]])).max(5).optional(),
    minCeilingScrap: nonNeg.optional(),
    onlyBotBuyers: z.boolean().optional(),
    minBuyers: z.number().int().min(0).max(100_000).optional(),
    onScraptfList: z.boolean().optional(),
    newOnScraptf: z.boolean().optional(),
    listedOnScraptf: z.boolean().optional(),
    sort: z.enum(MARKET_SORTS as unknown as [MarketSort, ...MarketSort[]]).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(MARKET_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .optional();

const holdingsQuery = z
  .object({
    search: z.string().max(MARKET_MAX_SEARCH_CHARS).optional(),
  })
  .optional();

const bankEnum = z.enum(SCRAPTF_BANK_IDS as unknown as [ScraptfBank, ...ScraptfBank[]]);

// F17. The bank is required: one bank page per call ('__proto__' and unknown ids are refused here).
const bankStockQuery = z.object({
  bank: bankEnum,
  filter: z.enum(BANK_STOCK_FILTERS as unknown as [BankStockFilter, ...BankStockFilter[]]).optional(),
  // F20: 'long-listed' threshold; up to 90 days (history is not kept longer).
  minListedMs: z.number().int().min(0).max(SCRAPTF_EVENTS_MAX_AGE_MS).optional(),
  search: z.string().max(BANK_STOCK_MAX_SEARCH_CHARS).optional(),
  sort: z.enum(BANK_STOCK_SORTS as unknown as [BankStockSort, ...BankStockSort[]]).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(BANK_STOCK_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

// F20. Every key optional (an empty or missing object is the whole feed); unknown keys are dropped.
const scraptfChangesQuery = z
  .object({
    bank: bankEnum.optional(),
    kinds: z.array(z.enum(SCRAPTF_CHANGE_KINDS as unknown as [ScraptfChangeKind, ...ScraptfChangeKind[]])).max(SCRAPTF_CHANGE_KINDS.length).optional(),
    sku: skuText.optional(),
    beforeId: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(SCRAPTF_CHANGES_MAX_LIMIT).optional(),
  })
  .nullish();

// F20. `special` is a bank_stock special key ('' or the import's JSON extras key): a lookup key only, bounded.
const scraptfItemHistoryParams = z.object({
  sku: skuText,
  special: z.string().max(2000).nullable().optional(),
});

// 0.8 (G1). `special` is a bank_stock special key: a lookup key only, bounded, and never the copy index's every-copy
// stand-in '*' (WATCH_ANY_COPY_SENTINEL; every copy is copies 'any'). Targets: keys as typed, metal and profit whole
// scrap. watchWriteOf (shared with the mock) applies the rest.
const watchInput = z.object({
  id: id.optional(),
  sku: skuText,
  copies: z.enum(['one', 'any']).optional(),
  special: z
    .string()
    .max(WATCH_SPECIAL_MAX)
    .refine((s) => s !== WATCH_ANY_COPY_SENTINEL, WATCH_NOT_A_COPY)
    .nullable()
    .optional(),
  name: z.string().max(WATCH_NAME_MAX).optional(),
  maxCostKeys: z.number().min(0).max(WATCH_MAX_KEYS).optional(),
  maxCostScrap: z.number().int().min(0).max(WATCH_MAX_SCRAP).nullable().optional(),
  minProfitScrap: z.number().int().min(0).max(WATCH_MAX_SCRAP).nullable().optional(),
  onRestock: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
// 0.8 (G1): Undo of a removal: the removed watch's params, id and times (watchRestoreOf clamps the times to now).
const watchRestore = watchInput.extend({ id, createdAt: z.number().int().min(0), updatedAt: z.number().int().min(0) });
const watchesListParams = z.object({ sku: skuText.optional() }).nullish();

const steamId64 = z.string().trim().regex(/^\d{17}$/, 'expected a 17-digit SteamID64');

/** Bulk paste preview: the helper enforces the 100 KB / 500-line limits with a friendly refusal; this only bounds memory. */
const MAX_BULK_TEXT_CHARS = 1_000_000;
/** Same size cap as a rules backup the dashboard would reasonably hold. */
const MAX_RULES_JSON_CHARS = 5_000_000;
/** Skip reasons returned by 'rules.importJson' (rulesFromJson already caps its own). */
const MAX_RULE_SKIP_LINES = 400;
export const SCHEMA_LOADING_MESSAGE = 'The item list is still loading, so names cannot be matched yet. Preview again in a moment.';

// 0.8 (J2): a fee per row, keys and metal apart; absent (both) is "not recorded", 0 is "none".
const journalFeeKeys = nonNeg.refine((n) => n <= JOURNAL_MAX_FEE_KEYS, 'fee is too high');
const journalFeeScrap = nonNeg.refine((n) => n <= JOURNAL_MAX_FEE_SCRAP, 'fee is too high');
const journalVenue = z.string().trim().min(1, 'venue is required').max(100);
const journalNote = z.string().max(500).nullable();
// 0.7.4 (F39): a backfill's key price then (JournalInput.keyPriceScrap): at least 1 ref, at most 100,000 scrap.
const journalKeyPrice = z.number().int('key price must be whole scrap').min(9, 'key price must be at least 1 ref').max(100_000, 'key price is too high');

const journalInput = z
  .object({
    ts: finite.optional(),
    side: z.enum(JOURNAL_SIDES as unknown as [JournalSide, ...JournalSide[]]),
    venue: journalVenue,
    sku: skuText,
    name: z.string().max(300).optional(),
    keys: nonNeg.optional(),
    scrap: nonNeg,
    note: journalNote.optional(),
    keyPriceScrap: journalKeyPrice.optional(),
    feeKeys: journalFeeKeys.optional(),
    feeScrap: journalFeeScrap.optional(),
  })
  // 0.8: a write-off receives nothing, so it has no price and no fee.
  .refine((p) => p.side !== 'writeoff' || ((p.keys ?? 0) === 0 && p.scrap === 0 && p.feeKeys === undefined && p.feeScrap === undefined), { error: JOURNAL_WRITE_OFF_NOTHING, path: ['scrap'] });

// 0.8 (J6): one row's venue, note and fee; side, item, price and time stay (delete and log again to change them).
const journalPatchParams = z.object({
  id,
  venue: journalVenue.optional(),
  note: journalNote.optional(),
  feeKeys: journalFeeKeys.nullable().optional(),
  feeScrap: journalFeeScrap.nullable().optional(),
});

const importParams = z.object({
  // The saved file as text: an .html page, or an .mhtml file the import unpacks (F18, parseSavedPage).
  // The cap is the file's, before unpacking; the page inside is checked again.
  html: z.string().max(MAX_IMPORT_BYTES, 'the page is larger than 20 MB'),
  fileName: z.string().max(260),
  mtimeMs: finite,
  // F21, set by main only (its router refuses both from a page): a read of the scrap.tf window. The address
  // is a page-address hint for bank and page detection, like an MHTML Content-Location; never fetched.
  address: z
    .string()
    .max(4096, 'not a scrap.tf page address')
    .refine((u) => isScraptfPageUrl(u), 'not a scrap.tf page address')
    .optional(),
  origin: z.enum(IMPORT_ORIGINS as unknown as [ImportOrigin, ...ImportOrigin[]]).optional(),
  // 0.7.1 (ACT-4), main only like `origin`: false marks a window snapshot cut before its settle read.
  settled: z.boolean().optional(),
});

/** F21: 'import.html' and the folder watch's input. `address`, `origin` and `settled` come from main's window read only. */
export type ImportSavedPageParams = z.output<typeof importParams>;

const skuOnly = z.object({ sku: skuText });
/** 0.9 (history): 'item.bookHistory' params: the drawer's top buy order ids (at most BOOK_HISTORY_ORDERS_MAX). */
const itemBookHistoryParams = z.object({ sku: skuText, orders: z.array(z.string().min(1).max(200)).max(BOOK_HISTORY_ORDERS_MAX).optional() });
const idOnly = z.object({ id });

// F16. Every message is fixed text: a zod default may quote the input one day, and this input is the
// user's clipboard, so no issue message here can ever contain it.
const checkTextParams = z.object(
  {
    text: z.string({ error: 'must be a string' }).max(CHECK_MAX_CHARS, { error: `at most ${CHECK_MAX_CHARS} characters` }),
    source: z.enum(CHECK_SOURCES as unknown as [CheckSource, ...CheckSource[]], { error: 'must be hotkey, watch or manual' }),
    // F19: main's hint while a 'check.arm' is unexpired (the item opened on scrap.tf); the SKU rule as everywhere.
    hint: z.object({ sku: skuText }, { error: 'expected { sku }' }).optional(),
  },
  { error: 'expected { text, source }' },
);
/** The only error 'check.text' throws past validation: the cause may hold the text, so it is never passed on. */
export const CHECK_FAILED_MESSAGE = 'The check failed. Try again.';

function parse<T>(schema: z.ZodType<T>, params: unknown, method: string): T {
  const r = schema.safeParse(params);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
  throw new Error(`Invalid parameters for ${method}: ${where}${issue?.message ?? 'invalid'}`);
}

function withoutUndefined<T extends object>(o: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Sorted-key JSON: the same filter written in another key order compares equal. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** What makes two rules the same for an import: name, filter and price (not the date or the on/off switch). */
function ruleKey(r: { name: string; filter: object; costKeys?: number; costScrap: number }): string {
  return stableJson([r.name.trim(), r.filter, r.costKeys ?? 0, Math.round(r.costScrap)]);
}

function dateStamp(ms: UnixMs): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Canonical SKU and its base SKU (paint removed); paint goes into the special attributes. */
function splitSku(sku: string): { full: string; base: string; paint: number | null } {
  const obj = fromString(canonical(sku.trim()));
  const paint = typeof obj.paint === 'number' && obj.paint > 0 ? obj.paint : null;
  return { full: fromObject(obj), base: fromObject({ ...obj, paint: null }), paint };
}

function emptySpecial(): SpecialAttrs {
  return { ...EMPTY_SPECIAL, spells: [], parts: [] };
}

// ---------------------------------------------------------------------------
// Saved-page import (also used by the folder watcher)
// ---------------------------------------------------------------------------

/** The stored base SKUs per category, as the Live market files them (an unreadable SKU counts for none). */
function storedCategories(schema: SchemaService, skus: readonly string[]): CategoryCounts {
  const list: Category[] = [];
  for (const sku of skus) {
    try {
      list.push(marketCategoryOf(schema, sku));
    } catch {
      // counts for no page, as in the index
    }
  }
  return countCategories(list);
}

function specialKey(s: SpecialAttrs): string {
  return JSON.stringify([s.paint, [...s.spells].sort(), [...s.parts].sort(), s.sheen, s.killstreaker, s.customName, s.customDesc]);
}

/**
 * F14: a saved /items list as scraptf_list rows (batch id filled in by the caller), one per base SKU.
 * Every row with a SKU counts, in stock or not: scrap.tf still buys an item it has none of, and a
 * "Sold out" row keeps what scrap.tf pays with no price to buy. A row with neither price says nothing.
 * A SKU listed twice keeps its first row with a price to buy, else its first row (the repo alone would
 * keep the last one, since the whole page shares one time). 0.7.4: each row keeps what it is proven to
 * price (ParsedScrapItem.listCraft; an unmarked row is a family row, 'any'), and rows of one item that
 * differ (DUPLICATE_ROW) write none: which is which copy is unknown, so the stored row stays as it was.
 * 0.7.4 (F60): and the list page it was read on (`page`), so a whole save of that page retires it once the
 * page no longer shows it.
 */
function listRowsOf(
  schema: SchemaService,
  items: readonly ParsedScrapItem[],
  observedAt: UnixMs,
  page: string,
): Omit<ScraptfListStored, 'batchId'>[] {
  const bySku = new Map<string, Omit<ScraptfListStored, 'batchId'>>();
  for (const item of items) {
    if (item.sku === null || !looksLikeSku(item.sku)) continue;
    if (hasWarningCode(item, DUPLICATE_ROW)) continue;
    const sells = sellsPriceOf(item);
    const pays = item.pays ?? null;
    if (sells === null && pays === null) continue;
    let base: string;
    try {
      base = splitSku(item.sku).base;
    } catch {
      continue;
    }
    const prev = bySku.get(base);
    if (prev && (prev.sellsScrap !== null || sells === null)) continue;
    let name = item.name;
    if (!name) {
      try {
        name = schema.nameForSku(base);
      } catch {
        name = base;
      }
    }
    bySku.set(base, {
      sku: base,
      name,
      sellsKeys: sells?.keys ?? null,
      sellsScrap: sells?.scrap ?? null,
      paysKeys: pays?.keys ?? null,
      paysScrap: pays?.scrap ?? null,
      stock: item.stock,
      stockLimit: item.stockLimit ?? null,
      observedAt,
      craft: item.listCraft ?? 'any',
      ...(page !== '' ? { page } : {}),
    });
  }
  return [...bySku.values()];
}

/** 0.7.4: the item carries a warning of this code. */
function hasWarningCode(item: ParsedScrapItem, code: string): boolean {
  return item.warnings.some((w) => importWarningCode(w) === code);
}

/**
 * F17: a recognised saved page as bank_stock rows: every card or /items row with a SKU, sold out
 * included (what the bank had at that moment), keyed as the import keys prices (base SKU, paint moved
 * into the extras; bankStockSpecialKey). The price is the price to buy (sellsPriceOf), null when the
 * page shows none. A key on several cards keeps its cheapest card on sale (else its first) for the
 * price, and the copies on sale of all those cards for the stock: scrap.tf stacks identical copies as
 * one "3x" card but shows a reserved or differently made copy on a card of its own (the parser already
 * dropped the selected-item duplicates), so one card's count would undersell the bank, by card order.
 * 0.7.4: an /items list row (`list`) carries its craftability (BankStockStored.craft: listCraft, 'any' for
 * rows of one item that differ, DUPLICATE_ROW, and for a key whose rows disagree), so the stock page, page
 * flips, "New on scrap.tf" and the change feed join a family row to no Craftable buyer (bankStockListFamily).
 */
function bankStockRowsOf(schema: SchemaService, items: readonly ParsedScrapItem[], keyScrap: number, list = false): BankStockStored[] {
  /** `onSaleStock`: the summed counts of the key's cards on sale (null: none yet); `unknown`: one of them showed no count. */
  const byKey = new Map<string, { row: BankStockStored; onSale: boolean; total: number; onSaleStock: number | null; unknown: boolean; craft: ScraptfListCraft }>();
  for (const item of items) {
    if (item.sku === null || !looksLikeSku(item.sku)) continue;
    let base: string;
    let paint: number | null;
    try {
      ({ base, paint } = splitSku(item.sku));
    } catch {
      continue;
    }
    const specialKey = bankStockSpecialKey({ ...item.special, paint: item.special?.paint ?? paint });
    const sells = sellsPriceOf(item);
    let name = item.name;
    if (!name) {
      try {
        name = schema.nameForSku(base);
      } catch {
        name = base;
      }
    }
    const row: BankStockStored = {
      sku: base,
      specialKey,
      name,
      costKeys: sells?.keys ?? null,
      costScrap: sells?.scrap ?? null,
      stock: item.stock,
      assetId: item.assetId,
      // 0.9 (#13): the card's own price-drop wording (evidence only; the cheapest on-sale card of a key carries its
      // own). An /items row never does.
      ...(!list && Array.isArray(item.markdown) && item.markdown.length > 0 ? { markdown: [...item.markdown] } : {}),
    };
    const onSale = bankStockOnSale(row);
    const total = sells ? Math.round(sells.keys * keyScrap) + sells.scrap : Number.POSITIVE_INFINITY;
    const key = bankStockKey(base, specialKey);
    // A card on sale with no count (no asset id, no stack size) leaves the key's stock unknown.
    const counted = typeof item.stock === 'number' && Number.isFinite(item.stock) ? item.stock : null;
    const craft: ScraptfListCraft = hasWarningCode(item, DUPLICATE_ROW) ? 'any' : (item.listCraft ?? 'any');
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { row, onSale, total, onSaleStock: onSale ? counted : null, unknown: onSale && counted === null, craft });
      continue;
    }
    // Rows of one key that disagree on their copy prove none of them.
    if (prev.craft !== craft) prev.craft = 'any';
    if (onSale) {
      if (counted === null) prev.unknown = true;
      else prev.onSaleStock = (prev.onSaleStock ?? 0) + counted;
    }
    if (onSale && (!prev.onSale || total < prev.total)) {
      prev.row = row;
      prev.onSale = true;
      prev.total = total;
    }
  }
  return [...byKey.values()].map((v) => {
    const row = v.onSale ? { ...v.row, stock: v.unknown ? null : v.onSaleStock } : v.row;
    return list ? { ...row, craft: v.craft } : row;
  });
}

/**
 * F21: the one warning of a window read that recorded nothing (ImportResult.batchId 0): a scrap.tf page
 * that shows no items to import. Fixed text, so no path or page content travels with it.
 */
export const WINDOW_NOTHING_TO_IMPORT = 'nothing-to-import: this scrap.tf page shows no items to import (yet); nothing was recorded';

/**
 * F21: a window read's name as main built it, whole: no control characters, trimmed, at most 200 characters.
 * Cut at a '?' or '#': main names a read by its path alone, and the name is stored and logged, so a URL
 * query or hash that ever reached it would leave the service (a path never holds either unescaped).
 */
function windowReadName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[?#][\s\S]*$/, '')
    .trim()
    .slice(0, 200)
    .trimEnd();
}

const REFUSAL_CODES: ReadonlySet<string> = new Set(IMPORT_REFUSAL_CODES);
const BENIGN_SKIPS: ReadonlySet<string> = new Set(BENIGN_SKIP_REASONS);
/** ImportResult.skipped keeps at most this many entries (refusals first); skippedTotal counts them all. */
const MAX_SKIPPED = 500;

/** A warning that says why an item was refused (P5); 'no-defindex' only when it left the item without a SKU. */
function refusalOf(item: ParsedScrapItem): string | undefined {
  return item.warnings.find((w) => {
    const c = importWarningCode(w);
    return REFUSAL_CODES.has(c) && !(c === 'no-defindex' && item.sku !== null);
  });
}

/** P5: why a card was not stored as a price: its refusal, else its first warning, else a plain reason. */
function skipReasonOf(item: ParsedScrapItem): string {
  return refusalOf(item) ?? item.warnings[0] ?? (item.sku ? 'no price' : 'item not recognised');
}

/**
 * P5 ImportResult.skippedCounts' key: a benign reason's own (fixed) text, else the reason's code (a refusal
 * code for refusals). Never a warning's detail, which quotes the card: one group per kind, not per card.
 */
function skipKeyOf(reason: string): string {
  return BENIGN_SKIPS.has(reason) ? reason : importWarningCode(reason) || reason;
}

/**
 * DM-2: a look at a bank page (not the /items list) that caught far fewer cards than the newest stored save
 * of the same page, taken a little before it: cards still arriving in the window, or a save made too early.
 * Stored as a full save it would read as items gone, then restocked and new on the next look, and would
 * break their "listed since". The page warning (digits only), or null for a full look. The floor of
 * PARTIAL_READ_MIN_KEYS keeps a small page from ever reading as partial; past PARTIAL_READ_MAX_AGE_MS a
 * drop is taken as a real sell-off.
 */
function partialLookWarning(ctx: HandlerContext, bank: ScraptfBank, page: string, rows: readonly BankStockStored[], mtime: UnixMs): string | null {
  if (bank === 'list') return null;
  const onSale = rows.filter(bankStockOnSale).length;
  const before = ctx.repo.bankStockSaves(bank, 1000, { perPage: 1 }).find((sv) => sv.page === page);
  if (!before || before.savedAt > mtime || mtime - before.savedAt >= PARTIAL_READ_MAX_AGE_MS) return null;
  const was = ctx.repo.bankStockRows(before.batchId).filter(bankStockOnSale).length;
  if (was < PARTIAL_READ_MIN_KEYS || onSale >= was * PARTIAL_READ_RATIO) return null;
  return `${PARTIAL_READ}: ${onSale} of ~${was} items on screen; read the page again once every card shows`;
}

/** 0.7.4: an /items look is whole when it shows at least this share of the rows of the page's previous save. */
const LIST_WHOLE_RATIO = 0.9;

/**
 * 0.7.4 (F82): an .mhtml file's own save time (its Date header) dates the page instead of the file's modified
 * time only when it is this much older: a normal save writes its Date seconds before the file's mtime.
 */
export const PAGE_DATE_SLACK_MS = 5 * 60_000;

/**
 * 0.7.4 (F06, F60): an /items look short of rows, as {was} (the previous save's rows; 0: none), or null when
 * whole. The list is one server-rendered table, so its row count (sold out included: a row that sells out
 * stays listed) is steady: a look with fewer than LIST_WHOLE_RATIO of the rows of the newest stored save of
 * the same page caught only part of it. A settled look is only compared with a save at most
 * PARTIAL_READ_MAX_AGE_MS older (past that a drop is taken as scrap.tf's own) of at least PARTIAL_READ_MIN_KEYS
 * rows; an unsettled window snapshot (ACT-4) always, and with no save to compare it is whole only from
 * PARTIAL_READ_MIN_KEYS rows.
 */
function listLookShort(ctx: HandlerContext, page: string, rows: number, mtime: UnixMs, unsettled: boolean): { was: number } | null {
  const before = ctx.repo.bankStockSaves('list', 1000, { perPage: 1 }).find((sv) => sv.page === page);
  if (!before || before.savedAt > mtime) return unsettled && rows < PARTIAL_READ_MIN_KEYS ? { was: 0 } : null;
  if (!unsettled && (mtime - before.savedAt >= PARTIAL_READ_MAX_AGE_MS || before.items < PARTIAL_READ_MIN_KEYS)) return null;
  return rows >= Math.ceil(before.items * LIST_WHOLE_RATIO) ? null : { was: before.items };
}

/** DC-1: the banks scrap.tf shows on one page (/unusuals has a page per effect; 'list' is the price list). */
const SINGLE_PAGE_BANKS: ReadonlySet<ScraptfBank> = new Set<ScraptfBank>(['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'items']);

/**
 * 0.7.4 (DM-3): the one-page bank whose saves decide an /items price of `sku`: the bank of the newest bank
 * stock row of the SKU, else of its craftability twin (the list's Non-Craftable row is often a bank's card
 * of the other craftability, and the reverse), outside the list and /unusuals; else the bank scrap.tf sells
 * that kind of item on (F36 `marketBankOfSku`: a strange cosmetic on /buy/hats, a killstreak or australium
 * weapon on /buy/items) when that is one page. null: none, so no bank save removes the price. Never the
 * category first: real saves show stranges, weapons and hats on /buy/items. 0.7.4 (R04): `memo` keeps each
 * SKU's newest bank for one import (Repo.bankStockNewestBankOf walks every kept save), so DM-3 and the list's
 * homeSaveLacks ask once per SKU or twin.
 */
function homeBankOf(ctx: HandlerContext, sku: string, memo: Map<string, ScraptfBank | null> = new Map()): ScraptfBank | null {
  let twin: string;
  try {
    const obj = fromString(sku);
    twin = fromObject({ ...obj, craftable: !obj.craftable });
  } catch {
    return null;
  }
  const newestBankOf = (s: string): ScraptfBank | null => {
    let bank = memo.get(s);
    if (bank === undefined) memo.set(s, (bank = ctx.repo.bankStockNewestBankOf([s])));
    return bank;
  };
  const seen = newestBankOf(sku) ?? newestBankOf(twin);
  if (seen !== null) return SINGLE_PAGE_BANKS.has(seen) ? seen : null;
  try {
    const bank = marketBankOfSku(ctx.schema, marketCategoryOf(ctx.schema, sku), sku);
    return SINGLE_PAGE_BANKS.has(bank) ? bank : null;
  } catch {
    return null;
  }
}

/** DC-1: the bank's newest look that stored prices, whole or not (Repo.bankNewestSaves), or null. */
function newestLookOf(ctx: HandlerContext, bank: ScraptfBank): { batchId: number; savedAt: UnixMs; itemCount: number } | null {
  return ctx.repo.bankNewestSaves().find((s) => s.bank === bank) ?? null;
}

/** 0.7.4 (F31): the copies a bank stock save shows on sale, as `${sku}|${specialKey}` (an import price's key by bankStockSpecialKey). */
function onSaleKeys(rows: readonly BankStockStored[]): Set<string> {
  return new Set(rows.filter(bankStockOnSale).map((r) => `${r.sku}|${r.specialKey}`));
}

/** 0.7.4 (F31): an imported price's copy, in onSaleKeys' form. */
function priceCopyKey(sp: Pick<ScrapPrice, 'sku' | 'special'>): string {
  return `${sp.sku}|${bankStockSpecialKey(sp.special)}`;
}

/**
 * 0.7.4 (F37): whether a page's first stored save is whole enough to retire prices by. DM-2 compares a save
 * with the page's previous one, which a first save lacks, so it is compared with the bank's newest look before
 * it that stored prices (`lookBefore`, often an unsettled first window read) by DM-2's thresholds: a save with
 * fewer than PARTIAL_READ_RATIO of that look's copies is taken as cut short and retires nothing. A look of
 * fewer than PARTIAL_READ_MIN_KEYS copies, or none, says nothing either way.
 */
function firstSaveWhole(onSale: number, lookBefore: { itemCount: number } | null): boolean {
  if (lookBefore === null || lookBefore.itemCount < PARTIAL_READ_MIN_KEYS) return true;
  return onSale >= lookBefore.itemCount * PARTIAL_READ_RATIO;
}

/**
 * 0.7.4 (F31, F37, F56, F62; DC-1 widened): the imported prices of one-page bank `bank` that whole save
 * `batchId`, the newest of its page, shows are gone: tagged to that bank, observed before the save (`mtime`),
 * of a copy (SKU and bankStockSpecialKey) it does not show on sale. scrap.tf shows these banks on one page,
 * so a whole look without a card means it sold, however its price got there: a look that stored no save
 * (DC-1), a 'gone' event no build acted on (pre-0.7.1, DM-1), an older page arriving late. [] for any other
 * bank (/unusuals: a page per effect; the list) or save, and for a first save of its page that looks cut short
 * (firstSaveWhole against `lookBefore`, read before this batch existed). One read per bank, never a scan.
 */
function pricesGoneFromSave(
  ctx: HandlerContext,
  bank: ScraptfBank,
  page: string,
  batchId: number,
  mtime: UnixMs,
  lookBefore: { itemCount: number } | null,
  rows: readonly BankStockStored[],
): ScrapPrice[] {
  if (!SINGLE_PAGE_BANKS.has(bank)) return [];
  const [newest, prev] = ctx.repo.bankStockSaves(bank, 1000, { perPage: 2 }).filter((sv) => sv.page === page);
  if (newest?.batchId !== batchId) return [];
  const onSale = onSaleKeys(rows);
  if (prev === undefined && !firstSaveWhole(onSale.size, lookBefore)) return [];
  return ctx.repo.importScrapPricesOfBank(bank, mtime).filter((sp) => !onSale.has(priceCopyKey(sp)));
}

/** 0.7.4 (F31): meta key set once reconcileBankPrices has run (core start). */
export const META_BANK_PRICES_RECONCILED = 'import.bankPricesReconciled.v1';

/**
 * 0.7.4 (F31, F62): a one-time pass over the prices older builds left (The Classified Coif: a 'gone' event a
 * 0.7.0 build recorded and never acted on). Per one-page bank whose newest stored save has a previous save of
 * its page (a whole save the import's own rule could have retired by), the bank's imported prices observed
 * before that save of a copy it does not show on sale are deleted, as pricesGoneFromSave does at import. In JS,
 * not SQL: bankStockSpecialKey normalises the stored extras. Idempotent; typed prices, list-tagged prices and
 * /unusuals are never touched. Returns the base SKUs whose prices went (for the engine).
 */
export function reconcileBankPrices(repo: Repo): string[] {
  const affected = new Set<string>();
  repo.transaction(() => {
    for (const bank of SINGLE_PAGE_BANKS) {
      const newest = repo.bankStockSaves(bank, 1)[0];
      if (!newest) continue;
      const [head, prev] = repo.bankStockSaves(bank, 1000, { perPage: 2 }).filter((sv) => sv.page === newest.page);
      if (head?.batchId !== newest.batchId || prev === undefined) continue;
      const onSale = onSaleKeys(repo.bankStockRows(newest.batchId));
      for (const sp of repo.importScrapPricesOfBank(bank, newest.savedAt)) {
        if (onSale.has(priceCopyKey(sp))) continue;
        repo.deleteScrapPrice(sp.id);
        affected.add(sp.sku);
      }
    }
  });
  return [...affected];
}

/** UX-3 ImportResult.topFlips: a page flip with its name from the app's item data (never the page's text). */
function topFlipOf(schema: SchemaService, row: BankStockRow): ImportTopFlip | null {
  const { maxCostScrap, profitScrap } = row;
  if (!Number.isFinite(row.costScrap) || maxCostScrap === null || profitScrap === null || !Number.isFinite(maxCostScrap) || !Number.isFinite(profitScrap)) return null;
  let name = row.sku;
  try {
    const n = schema.nameForSku(row.sku);
    if (typeof n === 'string' && n.trim()) name = n.trim();
  } catch {
    // the SKU names it
  }
  return { sku: row.sku, name, costScrap: row.costScrap, maxCostScrap, profitScrap };
}

/** The P4 report's input for a parse (diagnostics, page, warnings counted with every item's). */
function reportOf(base: Pick<ImportReportInput, 'at' | 'origin' | 'name' | 'format'>, parsed: SavedPageParse, warnings: readonly string[], batchId: number, countsOnly = false): ImportReportInput {
  return {
    ...base,
    pageKind: parsed.pageKind,
    bank: parsed.bank,
    page: parsed.page,
    batchId,
    diagnostics: parsed.diagnostics ?? null,
    warnings,
    // 0.7.4: an /items family row counts as CRAFT_UNVERIFIED there, as the parser report notes it.
    itemWarnings: parsed.items.map((i) => (i.sku !== null && i.listCraft === 'any' ? [...i.warnings, CRAFT_UNVERIFIED] : i.warnings)),
    countsOnly,
  };
}

/** P4: a report must never cost the user an import. */
function tryReport(ctx: HandlerContext, input: ImportReportInput): void {
  try {
    recordImportReport(input);
  } catch (err) {
    ctx.log.warn(`parser report failed (${err instanceof Error ? err.name : typeof err})`);
  }
}

/**
 * Parses a page the user saved from scrap.tf and stores its prices as source
 * 'import'. Per SKU and set of extras the cheapest card wins, and it replaces
 * the earlier imported price for that SKU instead of adding duplicates.
 * Items with none in stock are not stored. Prices from a page saved later than
 * this one are never replaced or removed, and a card a later save of its bank
 * showed gone is not brought back by an older page arriving late (0.7.3).
 * A saved /items list also refreshes the stored scrap.tf price list (F14), out-of-stock rows
 * included, at the file's time; rows from a list saved later are kept (repo guard).
 * `html` is the saved file as text: an .html page, or an .mhtml file whose web page parseSavedPage
 * unpacks here, in the service (F18), so the file picker and the folder watch read it alike.
 * F21: a read of the opt-in scrap.tf window (`origin: 'window'`, set by main only) is the DOM the user's
 * own browsing loaded, imported exactly like a saved file of that page; `address`, the page it was read
 * at, is only a page-address hint (as an .mhtml part's Content-Location), never stored, logged or
 * fetched. The batch records its origin ('file' by default). A window read of a page that shows no items
 * records nothing (WINDOW_NOTHING_TO_IMPORT).
 * 0.7.1: refused while the item schema loads (P3: cards keyed by guesses would change SKU once it loads).
 * A bank page's look is stored as a bank stock save only when it is a whole look (`stockSave`): a window
 * snapshot cut before its settle read (`settled: false`, ACT-4), a look with far fewer cards than a recent
 * save (DM-2) and an /items list whose stock cannot be read (P1) store their prices but no save, and
 * read no copy as gone: they replace only the copies they show (0.7.3). A save
 * that was stored removes the imported price of every card it shows gone from the bank (DM-1), so a
 * card scrap.tf sold stops reading as a flip everywhere. 0.7.4 (F31): a whole save of a one-page bank, the
 * newest of its page, removes every older imported price of that bank it does not show on sale, however it
 * got there (pricesGoneFromSave; a first save only when not cut short), and an older page arriving late
 * writes no copy the bank's newer whole save lacks. 0.7.4 (F82): a file dated ahead of the clock stores no
 * bank stock save (FUTURE_MTIME), and an .mhtml file is dated by its own Date header when that is clearly
 * older than its modified time. Each parse leaves a sanitized parser report (P4).
 * 0.7.4: an /items row is a cost only when it is proven to price the copy (Non-Craftable by name or class,
 * Craftable beside the item's Non-Craftable row; never a family row, ParsedScrapItem.listCraft 'any'), its
 * stock was read, no bank page's own price of the copy is stored (the list never re-tags one) and no
 * newer whole save of its home bank lacks it; a whole save of that bank later removes it (DM-3), and a
 * whole /items save retires the list prices and rows it shows gone. An /items window snapshot is a whole
 * save when it read every row's stock and about every row of the page's last save (F06).
 * Refused unless the user enabled import and acknowledged the ToS note (R10); a window read also needs
 * the window itself on (settings.scraptfWindow.enabled, behind its own risk acknowledgement).
 * 0.9 (#13): a page whose own text says its bank is not trading (`bankNotice`) stores its prices but no bank
 * stock save, and a window read of such a page records its batch even with no items, so the Banks card can say so.
 */
export function importSavedPage(ctx: HandlerContext, p: ImportSavedPageParams): ImportResult {
  const s = ctx.settings();
  if (!s.import.enabled || s.import.acknowledgedAt === null) {
    throw new Error('Saved-page import is turned off. Enable it (and accept the note) in Settings first.');
  }
  // F21: zod checked both on 'import.html'; checked again for direct callers. Anything but a window read
  // is a file, and an address that is not a scrap.tf page is no hint at all.
  const origin: ImportOrigin = p.origin === 'window' ? 'window' : 'file';
  // F21: main reads only while the window is on; checked here too, so no window read is ever recorded
  // without the user's opt-in to the window's ban risk (a read in flight when they turn it off included).
  if (origin === 'window' && s.scraptfWindow?.enabled !== true) throw new Error(SCRAPTF_WINDOW_OFF);
  const now = ctx.clock.now();
  const address = isScraptfPageUrl(p.address) ? p.address : null;
  const baseName = p.fileName.replace(/^.*[\\/]/, '');
  // A window read is named after its page ('scrap.tf window /buy/hats'), which the basename would cut to 'hats'.
  const fileName = origin === 'window' ? windowReadName(p.fileName) || 'scrap.tf window' : baseName.slice(0, 200) || 'saved page';
  const fileTime = Number.isFinite(p.mtimeMs) && p.mtimeMs > 0 ? Math.min(Math.round(p.mtimeMs), now) : now;
  // 0.7.4 (F82): a file dated ahead of this computer's clock (clamped to now above) stores no bank stock save.
  const futureFile = origin === 'file' && Number.isFinite(p.mtimeMs) && p.mtimeMs > now + FUTURE_MTIME_SLACK_MS;
  // ACT-4: only a window read can be unsettled, and only an explicit false says so.
  const unsettled = origin === 'window' && p.settled === false;
  const reportBase = { at: now, origin, name: fileName, format: origin === 'window' ? 'window' : isMhtmlFileName(baseName) ? 'mhtml' : 'html' } as const;

  // P3: without the item schema a card is keyed by guesses (names, skins, effects) that change once it
  // loads, leaving prices behind and reading as gone and new. Refused, files and window reads alike, with
  // fixed text (main matches its code); nothing is parsed or recorded, and the next read retries.
  let schemaLoaded = false;
  try {
    schemaLoaded = ctx.schema.isLoaded();
  } catch {
    schemaLoaded = false;
  }
  if (!schemaLoaded) {
    tryReport(ctx, { ...reportBase, pageKind: 'unknown', bank: null, page: '', batchId: 0, diagnostics: null, warnings: [IMPORT_SCHEMA_LOADING_CODE], countsOnly: true });
    throw new Error(IMPORT_SCHEMA_LOADING_MESSAGE);
  }

  // F18 S3: a bank page saved without its cards stores nothing and warns 'no-cards-saved'; its batch
  // still records the bank and time, and coverage, the banks cards and bank stock pass over it.
  // A window read is the page's DOM, not a file, so its name never makes it an .mhtml.
  let parsed: SavedPageParse;
  try {
    parsed = parseSavedPage(p.html, origin === 'window' ? '' : baseName, ctx.schema, { address, diagnostics: true });
  } catch (err) {
    // Counts only: the code, never the message.
    const code = err instanceof ImportTooLargeError ? 'too-large' : 'parse-error';
    tryReport(ctx, { ...reportBase, pageKind: 'unknown', bank: null, page: '', batchId: 0, diagnostics: null, warnings: [code], countsOnly: true });
    throw err;
  }
  const format = origin === 'window' ? 'window' : parsed.format;
  // 0.7.4 (F82): the page's time. A copy, sync or editor resets a file's modified time: an .mhtml file's own
  // save time (its Date header) wins when it is clearly older (PAGE_DATE_SLACK_MS: a normal save writes its
  // Date seconds before the file's mtime). A window read is dated by its read.
  const savedAt = origin === 'file' && typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : null;
  const mtime = savedAt !== null && savedAt > 0 && savedAt < fileTime - PAGE_DATE_SLACK_MS ? savedAt : fileTime;
  // 0.9 (#13): a read of a page saying its bank is not trading records its batch (S5), so the Banks card can date it.
  if (origin === 'window' && parsed.items.length === 0 && parsed.bankNotice !== 'unavailable') {
    // F21: the user browses scrap.tf's front page, a profile or a bank whose cards have not arrived yet
    // (the settle read gets them). Such a read stores nothing either way, so it records no batch and
    // pushes nothing: the Import page lists no row per page browsed, and no "saved without its cards"
    // notice tells the user to save a page they never saved. Nothing of the page is logged.
    // P7: a page whose items are in a shape the parser does not know says so too (digits only), and 0.7.3:
    // so does scrap.tf's bare /unusuals index, which never shows items (fixed text).
    const pageWarning = parsed.warnings.find((w) => {
      const code = importWarningCode(w);
      return code === LAYOUT_CHANGED || code === UNUSUALS_INDEX;
    });
    const warnings = pageWarning !== undefined ? [WINDOW_NOTHING_TO_IMPORT, pageWarning] : [WINDOW_NOTHING_TO_IMPORT];
    ctx.log.debug('scrap.tf window read: nothing to import on this page, nothing recorded');
    tryReport(ctx, reportOf({ ...reportBase, format }, parsed, warnings, 0, true));
    return {
      batchId: 0,
      fileName,
      pageKind: parsed.pageKind,
      bank: parsed.bank,
      parsed: 0,
      stored: 0,
      skipped: [],
      warnings,
      origin,
      skippedTotal: 0,
      skippedCounts: {},
      stockSave: 'none',
    };
  }
  const skipped: ImportResult['skipped'] = [];
  type Item = (typeof parsed.items)[number];

  // Cheapest card per (base SKU, extras).
  const best = new Map<string, { sku: string; item: Item; costScrap: number }>();
  /** Base SKUs the page shows with none in stock: earlier imported copies of them are gone. */
  const soldOut = new Set<string>();
  /** 0.7.3: per base SKU, the extras (specialKey) of every copy the page shows, on sale or sold out. */
  const shownExtras = new Map<string, Set<string>>();
  const show = (base: string, special: SpecialAttrs): void => {
    let set = shownExtras.get(base);
    if (!set) shownExtras.set(base, (set = new Set()));
    set.add(specialKey(special));
  };
  const keyScrap = ctx.engine.keyPrice().valueScrap;
  const isList = parsed.pageKind === 'items-list';
  /** 0.7.4 (R04): homeBankOf's newest bank per SKU, for this import (its saves change only at the end of it). */
  const homeMemo = new Map<string, ScraptfBank | null>();
  /** 0.7.4: base SKUs of /items family rows ('any'): shown, but never a cost, so a list price stored for them goes. */
  const listUnproven = new Set<string>();
  for (const item of parsed.items) {
    const title = item.title || item.name;
    const sku = item.sku !== null && looksLikeSku(item.sku) ? item.sku : null;
    // 0.7.4: /items rows of one item that differ change nothing (no price, nothing sold out): the next save
    // of its bank page decides.
    if (isList && sku !== null && hasWarningCode(item, DUPLICATE_ROW)) {
      skipped.push({ reason: item.warnings.find((w) => importWarningCode(w) === DUPLICATE_ROW) ?? DUPLICATE_ROW, title });
      continue;
    }
    // "0/5" on the /items list (priced or "Sold out"): the price to buy cannot be paid right now.
    if (sku !== null && item.stock === 0) {
      skipped.push({ reason: SKIP_OUT_OF_STOCK, title });
      const so = splitSku(sku);
      soldOut.add(so.base);
      show(so.base, { ...item.special, paint: item.special.paint ?? so.paint });
      continue;
    }
    if (sku === null || !isImportableItem(item)) {
      skipped.push({ reason: skipReasonOf(item), title });
      continue;
    }
    if (isList) {
      // 0.7.4: an /items row is a cost only when its stock was read (P1, header or not: a sold-out row
      // would read as buyable) and it is proven to price this copy. A family row ('any': every copy at its
      // price, Craftable or not) is kept on the price list only; a price an older read stored for it goes.
      if (item.stock === null) {
        skipped.push({ reason: `${NO_STOCK_LIMIT}: the list shows no stock for this row`, title });
        continue;
      }
      if (item.listCraft !== 'craftable' && item.listCraft !== 'uncraftable') {
        skipped.push({ reason: SKIP_CRAFT_UNPROVEN, title });
        const fam = splitSku(sku);
        listUnproven.add(fam.base);
        show(fam.base, { ...item.special, paint: item.special.paint ?? fam.paint });
        continue;
      }
    }
    const { base, paint } = splitSku(sku);
    const special: SpecialAttrs = { ...item.special, paint: item.special.paint ?? paint };
    // Before cheapest-wins: a dearer card of the same copy is shown too.
    show(base, special);
    const key = `${base}|${specialKey(special)}`;
    const total = Math.round(item.costKeys * keyScrap) + item.costScrap;
    const prev = best.get(key);
    if (!prev || total < prev.costScrap) {
      if (prev) skipped.push({ reason: SKIP_SAME_OR_CHEAPER, title: prev.item.title || prev.item.name });
      best.set(key, { sku: base, item: { ...item, special }, costScrap: total });
    } else {
      skipped.push({ reason: SKIP_SAME_OR_CHEAPER, title: item.title || item.name });
    }
  }

  // The /items list writes plain copies only, so it cannot speak for painted, spelled or named copies
  // imported from bank pages. Rows whose extras were never recorded (null) count as plain. 0.7.4: nor for a
  // bank page's own price of a copy (bankCard), which keeps its bank, asset id and stock: that bank's saves
  // decide it (DM-1, DC-1). The list replaces only what a list read wrote (or an untagged pre-0.5 row).
  const plainKey = specialKey(emptySpecial());
  const extrasKey = (sp: ScrapPrice): string => (sp.special === null ? plainKey : specialKey(sp.special));
  const bankCard = (sp: ScrapPrice): boolean => sp.source === 'import' && sp.bank !== null && sp.bank !== 'list';
  const replaceable = (sp: ScrapPrice): boolean => sp.source === 'import' && (!isList || (extrasKey(sp) === plainKey && !bankCard(sp)));
  // Catch-up scans and old pages copied into the watch folder can arrive after a newer page.
  const newerThanPage = (sp: ScrapPrice): boolean => sp.observedAt > mtime;
  // F14: bank pages have no "Price we pay" column, so only an /items list feeds the stored list.
  const listRows = parsed.pageKind === 'items-list' ? listRowsOf(ctx.schema, parsed.items, mtime, typeof parsed.page === 'string' ? parsed.page : '') : [];
  // F17: what a recognised page (a /buy bank, /unusuals or the /items list) had in stock at that moment.
  const stockRows = parsed.bank !== null ? bankStockRowsOf(ctx.schema, parsed.items, keyScrap, isList) : [];

  // 0.7.1: whether this look is stored as a bank stock save. Only a whole look is: anything else would
  // read as items gone (then restocked and new) on the next one. Its prices are stored either way.
  const pageWarnings: string[] = [];
  let stockSave: NonNullable<ImportResult['stockSave']> = parsed.bank !== null && stockRows.length > 0 ? 'written' : 'none';
  if (stockSave === 'written' && parsed.bank !== null) {
    const listBank = parsed.bank === 'list';
    // P1: an /items row whose stock cannot be read would read as on sale whatever it shows. 0.7.4: header or
    // not (a list without an "Item Limits" column reads no stock either; the list always shows one).
    const noStock = parsed.items.filter((i) => i.sku !== null && sellsPriceOf(i) !== null && (hasWarningCode(i, NO_STOCK_LIMIT) || (listBank && i.stock === null))).length;
    // 0.7.4 (F06): the /items list is one server-rendered table, so a window snapshot cut before its settle
    // read is whole when every row's stock was read and it shows (about) every row of the page's last save:
    // stored as a save, not left unsettled (ACT-4 stands for the bank pages, whose cards arrive late).
    const short = listBank ? listLookShort(ctx, parsed.page, stockRows.length, mtime, unsettled) : null;
    // 0.9 (#13): the page says its bank is not trading: its prices are stored, but no save (nothing reads as sold).
    // The parser's bank-unavailable warning already says so.
    if (parsed.bankNotice === 'unavailable') stockSave = 'partial';
    else if (unsettled && !(listBank && noStock === 0 && short === null)) stockSave = 'unsettled';
    else if (futureFile) {
      // 0.7.4 (F82): an old page whose time was reset ahead of the clock would become the newest whole save,
      // read cards on sale as gone and sold ones as restocked, and (dated now) do so again at every start.
      stockSave = 'partial';
      pageWarnings.push(`${FUTURE_MTIME}: the file's modified time is ahead of this computer's clock, so this look stores no bank stock save`);
    } else if (noStock > 0) {
      stockSave = 'partial';
      pageWarnings.push(`${NO_STOCK_LIMIT}: ${noStock} rows with no readable stock, so this look stores no bank stock save`);
    } else if (listBank) {
      if (short !== null) {
        stockSave = 'partial';
        pageWarnings.push(`${PARTIAL_READ}: ${stockRows.length} of ~${short.was} rows on screen; read the page again once every row shows`);
      }
    } else {
      const partial = partialLookWarning(ctx, parsed.bank, parsed.page, stockRows, mtime);
      if (partial !== null) {
        stockSave = 'partial';
        pageWarnings.push(partial);
      }
    }
  }
  // 0.7.3: a look known to be missing cards (ACT-4 unsettled, DM-2 or P1 partial) reads no copy as gone
  // (F18 deviation 11): it replaces only the copies it shows, never another copy of the same item. 0.7.4: an
  // unsettled /items snapshot stored as a whole save (above) is a whole look.
  const noSaveLook = (unsettled && stockSave !== 'written') || stockSave === 'partial';

  const affected = new Set<string>();
  let batchId = 0;
  let stored = 0;
  let listWritten = 0;
  let listRemoved = 0;
  let stockWritten = 0;
  let eventsWritten = 0;
  try {
    ctx.repo.transaction(() => {
      const previous = new Map<string, ScrapPrice[]>();
      for (const sku of [...[...best.values()].map((b) => b.sku), ...soldOut, ...listUnproven]) {
        if (!previous.has(sku)) previous.set(sku, ctx.repo.scrapPricesForSku(sku).filter(replaceable));
      }
      const kept = new Set<number>();
      // 0.7.3: a later save of this bank showed a copy gone (DM-1 removed its price): an older page arriving
      // late must not bring it back, as no later save would remove it again. Never the /items list: 0.7.4, its
      // rows answer to their home bank's newer save instead (homeSaveLacks below).
      const goneBank = parsed.bank !== null && parsed.bank !== 'list' ? parsed.bank : null;
      const anyGoneAfter = goneBank !== null && ctx.repo.scraptfEvents({ bank: goneBank, kinds: ['gone'], sinceAt: mtime + 1, limit: 1 }).length > 0;
      const goneAfterPage = (sku: string, special: SpecialAttrs): boolean =>
        anyGoneAfter &&
        goneBank !== null &&
        ctx.repo.scraptfEvents({ bank: goneBank, kinds: ['gone'], sku, specialKey: bankStockSpecialKey(special), sinceAt: mtime + 1, limit: 1 }).length > 0;
      // 0.7.4 (F31, F56): for a one-page bank, the copies on sale in its newest whole save when that save is
      // newer than this page (a save of any of its pages is a look at the whole bank), else null.
      const lateBank = parsed.bank !== null && SINGLE_PAGE_BANKS.has(parsed.bank) ? parsed.bank : null;
      const newestOfBank = lateBank !== null ? ctx.repo.bankStockSaves(lateBank, 1)[0] : undefined;
      const newerOnSale = newestOfBank !== undefined && newestOfBank.savedAt > mtime ? onSaleKeys(ctx.repo.bankStockRows(newestOfBank.batchId)) : null;
      const newerSaveLacks = (sku: string, special: SpecialAttrs): boolean => newerOnSale !== null && !newerOnSale.has(priceCopyKey({ sku, special }));
      // 0.7.4: per home bank, the SKUs on sale (any extras) in its newest whole save when that save is newer
      // than this list, else null (nothing newer says otherwise).
      const homeOnSale = new Map<ScraptfBank, Set<string> | null>();
      const homeSaveLacks = (sku: string): boolean => {
        const bank = homeBankOf(ctx, sku, homeMemo);
        if (bank === null) return false;
        let onSale = homeOnSale.get(bank);
        if (onSale === undefined) {
          const newest = ctx.repo.bankStockSaves(bank, 1)[0];
          onSale = newest && newest.savedAt > mtime ? new Set(ctx.repo.bankStockRows(newest.batchId).filter(bankStockOnSale).map((r) => r.sku)) : null;
          homeOnSale.set(bank, onSale);
        }
        return onSale !== null && !onSale.has(sku);
      };
      const writes: { id: number | null; sku: string; item: Item }[] = [];
      for (const { sku, item } of best.values()) {
        const key = specialKey(item.special);
        // A newer row with unrecorded extras must block this write too, or the plain copy is doubled.
        const same = (previous.get(sku) ?? []).filter((o) => !kept.has(o.id) && extrasKey(o) === key);
        const newer = same.find(newerThanPage);
        if (newer) {
          kept.add(newer.id);
          skipped.push({ reason: SKIP_NEWER_SAVE, title: item.title || item.name });
          continue;
        }
        // After `newer`: a copy restocked since has a newer price. Its other rows (another bank's, or a
        // list-tagged one DM-1 kept) stay as they are: this page changes nothing for the copy.
        if (goneAfterPage(sku, item.special)) {
          for (const o of same) kept.add(o.id);
          skipped.push({ reason: SKIP_NEWER_SAVE, title: item.title || item.name });
          continue;
        }
        // 0.7.4 (F31, F56): the bank's newer whole save does not show the copy on sale, so it sold after this
        // page (with no 'gone' event when no stored save had listed it): an older page arriving late does not
        // write it, as goneAfterPage above. Its other rows stay as they are. No newer page priced it (R05).
        if (newerSaveLacks(sku, item.special)) {
          for (const o of same) kept.add(o.id);
          skipped.push({ reason: SKIP_NOT_ON_SALE_NEWER, title: item.title || item.name });
          continue;
        }
        if (isList) {
          // 0.7.4: a bank page's own price of the copy stays as it is (its bank, asset id and card stock):
          // the list's stock counts copies that bank may not offer. An older list price beside it goes.
          if (ctx.repo.scrapPricesForSku(sku).some((o) => bankCard(o) && extrasKey(o) === key)) {
            skipped.push({ reason: SKIP_BANK_CARD_PRICE, title: item.title || item.name });
            continue;
          }
          // The copy's home bank was saved whole after this list and does not show it on sale: scrap.tf's
          // list counted a copy its bank does not offer (or sold since), so it sets no cost (DM-3 likewise).
          if (homeSaveLacks(sku)) {
            skipped.push({ reason: SKIP_NOT_ON_SALE_NEWER, title: item.title || item.name });
            continue;
          }
        }
        const target = same[0] ?? null;
        if (target) kept.add(target.id);
        writes.push({ id: target?.id ?? null, sku, item });
      }

      // Classified now, from what this page stores: a later look of the bank re-tags the rows it shares with
      // this one, and the coverage strip must still know which bank page this was (F13).
      const categories = storedCategories(ctx.schema, writes.map((w) => w.sku));
      // DC-1: the bank's newest look with prices before this one, whole or not (read before this batch exists);
      // 0.7.4 (F37): what a page's first save is checked against before it retires prices (firstSaveWhole).
      const lookBefore = stockSave === 'written' && parsed.bank !== null && SINGLE_PAGE_BANKS.has(parsed.bank) ? newestLookOf(ctx, parsed.bank) : null;
      // F15: the page as the parser recognised it, fixed now for the same reason as the categories.
      // F21: and how it came in, so the Import page can label a window read.
      batchId = ctx.repo.createImportBatch({
        fileName,
        pageKind: parsed.pageKind,
        fileMtime: mtime,
        importedAt: now,
        itemCount: writes.length,
        categories,
        bank: parsed.bank,
        origin,
        // 0.9 (#13): the Banks card dates the bank's newest "not trading" look from this.
        bankNotice: parsed.bankNotice ?? null,
      });
      for (const { id: priceId, sku, item } of writes) {
        ctx.repo.upsertScrapPrice({
          ...(priceId !== null ? { id: priceId } : {}),
          sku,
          name: item.name || ctx.schema.nameForSku(sku),
          costKeys: item.costKeys,
          costScrap: item.costScrap,
          source: 'import',
          observedAt: mtime,
          note: null,
          importBatch: batchId,
          special: item.special,
          assetId: item.assetId,
          stock: item.stock,
        });
        affected.add(sku);
      }
      stored = writes.length;
      // Earlier imported prices for these SKUs that this page no longer lists, or shows sold out, are removed.
      // 0.7.3: a partial or unsettled look removes only those of copies it shows (an older duplicate, or
      // sold out): a copy it did not catch may still be on sale, and the next whole look decides.
      for (const [sku, olds] of previous) {
        for (const o of olds) {
          if (kept.has(o.id) || newerThanPage(o)) continue;
          if (noSaveLook && !shownExtras.get(sku)?.has(extrasKey(o))) continue;
          ctx.repo.deleteScrapPrice(o.id);
          affected.add(sku);
        }
      }
      // Same transaction as the prices: a failed import leaves neither half behind.
      if (listRows.length > 0) listWritten = ctx.repo.upsertScraptfList(listRows.map((r) => ({ ...r, batchId })));
      // F17: the snapshot too, under this batch (its save time is the batch's) and its page, so /items/2
      // is only ever compared with an earlier save of /items/2. 0.7.1: a whole look only (stockSave).
      if (stockSave === 'written' && parsed.bank !== null) stockWritten = ctx.repo.insertBankStock(batchId, parsed.bank, stockRows, parsed.page);
      // F20 S2: this save's changes against the previous save of its page, in the same transaction.
      if (stockWritten > 0) eventsWritten = ctx.scraptfHistory.onImport(batchId);
      // 0.9 (history): this save's lowest prices per copy, in the same transaction (never throws).
      if (stockWritten > 0) ctx.scraptfHistory.recordLows?.(batchId);
      // DM-1: a card this save shows gone from the bank (its own 'gone' events: never on a first save, an
      // out-of-order save, the same file again, or a card another page's newest save still lists) was
      // sold, so its imported price goes too; else it stays a flip in every view but Bank stock. Only
      // imported prices of this bank, of that copy, from before this save; never a typed price, never one
      // the /items list re-tagged ('list'), and never one this import kept.
      if (stockWritten > 0 && parsed.bank !== null && parsed.bank !== 'list') {
        const bank = parsed.bank;
        const gone = ctx.repo.scraptfEvents({ bank, kinds: ['gone'], sinceAt: mtime, limit: 5000 }).filter((e) => e.batchId === batchId);
        for (const e of gone) {
          for (const sp of ctx.repo.scrapPricesForSku(e.sku)) {
            if (!replaceable(sp) || sp.bank !== bank || !(sp.observedAt < mtime) || kept.has(sp.id)) continue;
            if (bankStockSpecialKey(sp.special) !== e.specialKey) continue;
            ctx.repo.deleteScrapPrice(sp.id);
            affected.add(sp.sku);
          }
        }
        // DC-1, widened in 0.7.4 (F31, F37, F56, F62): a card with no gone event of this save (only a look
        // that stored no save caught it, its event was recorded by a build that never acted on it, or an
        // older page arriving late wrote it) still sold when a whole look of a one-page bank lacks it: this
        // save, the page's newest, retires every imported price of its bank from before it of a copy it does
        // not show on sale (a page's first save only when it is not cut short, firstSaveWhole). Never
        // /unusuals: a page per effect, and such a look's page is not recorded.
        for (const sp of pricesGoneFromSave(ctx, bank, parsed.page, batchId, mtime, lookBefore, stockRows)) {
          if (!replaceable(sp) || kept.has(sp.id)) continue;
          ctx.repo.deleteScrapPrice(sp.id);
          affected.add(sp.sku);
        }
        // DM-3 (0.7.4): an /items price (list-tagged) of a copy whose home bank is this one (homeBankOf), and
        // that this whole save, the page's newest, shows nowhere on sale: scrap.tf's list counts copies its
        // bank does not offer, and sold ones until its next read, so the price goes, as DM-1 removes a card
        // shown gone. Only prices from before this save; never a typed price, never one this import kept.
        const newestOfPage = ctx.repo.bankStockSaves(bank, 1000, { perPage: 1 }).find((sv) => sv.page === parsed.page);
        if (SINGLE_PAGE_BANKS.has(bank) && newestOfPage?.batchId === batchId) {
          const onSale = new Set(stockRows.filter(bankStockOnSale).map((r) => r.sku));
          // 0.7.4 (R04): the list's imported prices from before this save only (indexed by batch bank), never
          // a read of every price; homeBankOf asks once per SKU or twin for the whole import (homeMemo).
          for (const sp of ctx.repo.importScrapPricesOfBank('list', mtime)) {
            if (extrasKey(sp) !== plainKey || kept.has(sp.id)) continue;
            if (onSale.has(sp.sku) || homeBankOf(ctx, sp.sku, homeMemo) !== bank) continue;
            ctx.repo.deleteScrapPrice(sp.id);
            affected.add(sp.sku);
          }
        }
      }
      // 0.7.4 (F60): a whole /items save retires what its own 'gone' events show gone (per page, so /items/2
      // never retires an /items row): the list price of that copy, and the list row of a copy the page no
      // longer lists at all (a row listed sold out stays: scrap.tf still buys it). And, when it is the newest
      // save of its page, by set difference: every list row read on this page (scraptf_list.page) before it
      // that it does not list in any state, so a row last listed sold out, or written by a look that stored no
      // save (partial, unsettled, a future-dated file), goes too, with its list prices; never a row another
      // list page's newest save lists (one row per SKU), and never a row whose page is not known.
      if (stockWritten > 0 && parsed.bank === 'list') {
        const gone = ctx.repo.scraptfEvents({ bank: 'list', kinds: ['gone'], sinceAt: mtime, limit: 5000 }).filter((e) => e.batchId === batchId);
        const absent = new Set<string>();
        const retireListPrices = (sku: string, specialKeyOf: string | null): void => {
          for (const sp of ctx.repo.scrapPricesForSku(sku)) {
            if (!replaceable(sp) || sp.bank !== 'list' || !(sp.observedAt < mtime) || kept.has(sp.id)) continue;
            if (specialKeyOf !== null && bankStockSpecialKey(sp.special) !== specialKeyOf) continue;
            ctx.repo.deleteScrapPrice(sp.id);
            affected.add(sp.sku);
          }
        };
        for (const e of gone) {
          retireListPrices(e.sku, e.specialKey);
          if (e.toStock === null) absent.add(e.sku);
        }
        const listSaves = parsed.page !== '' ? ctx.repo.bankStockSaves('list', 1000, { perPage: 1 }) : [];
        if (listSaves.find((sv) => sv.page === parsed.page)?.batchId === batchId) {
          const shown = new Set(stockRows.map((r) => r.sku));
          const elsewhere = new Set<string>();
          for (const sv of listSaves) if (sv.page !== parsed.page) for (const r of ctx.repo.bankStockRows(sv.batchId)) elsewhere.add(r.sku);
          for (const row of ctx.repo.scraptfList()) {
            if (row.page !== parsed.page || !(row.observedAt < mtime) || shown.has(row.sku) || elsewhere.has(row.sku) || absent.has(row.sku)) continue;
            absent.add(row.sku);
            retireListPrices(row.sku, null);
          }
        }
        if (absent.size > 0) listRemoved = ctx.repo.deleteScraptfListRows([...absent], mtime);
      }
    });
  } catch (err) {
    tryReport(ctx, reportOf({ ...reportBase, format }, parsed, [...pageWarnings, ...parsed.warnings, 'import-failed'], 0, true));
    throw err;
  }
  if (stockSave === 'written' && stockWritten === 0) stockSave = 'none';
  // F17 retention after every import (F20: the thinning); a failed prune only keeps old saves a little
  // longer. Orphans are maintenance's: that sweep scans the table.
  let stockPruned = 0;
  try {
    stockPruned = ctx.repo.pruneBankStock(now, { orphans: false });
  } catch (err) {
    ctx.log.warn(`bank stock prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // F17: before pricesChanged and 'import.done', so a page refetching on their pushes reads the new stock.
  // The import is committed by now: a failure here must not keep the engine from the new prices.
  try {
    if (stockWritten > 0 && parsed.bank !== null) ctx.bankStockChanged({ bank: parsed.bank, batchId });
    else if (stockPruned > 0) ctx.bankStockChanged();
  } catch (err) {
    ctx.log.warn(`bank stock refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // F21: the window's status line ("2 new flips"), read after the refresh above. Window reads only, so
  // a file's result is unchanged; absent when this read wrote no bank stock.
  let newFlips: number | undefined;
  // 0.8 (G2): and the flips this read dropped under Pay up to, for "(1 cheaper)".
  let droppedFlips: number | undefined;
  // 0.7.1 (UX-3): and every flip on the page now, with the best three, for "10 flips on this page".
  let flips: { pageFlips: number; topFlips: ImportTopFlip[] } | undefined;
  if (origin === 'window' && stockWritten > 0 && parsed.bank !== null) {
    try {
      newFlips = ctx.bankStock.newFlips(parsed.bank, batchId).length;
    } catch (err) {
      ctx.log.warn(`bank stock new flips failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      droppedFlips = ctx.bankStock.droppedFlips(parsed.bank, batchId).length;
    } catch (err) {
      ctx.log.warn(`bank stock dropped flips failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const rows = ctx.bankStock.pageFlips(parsed.bank, batchId);
      flips = { pageFlips: rows.length, topFlips: rows.slice(0, 3).flatMap((r) => topFlipOf(ctx.schema, r) ?? []) };
    } catch (err) {
      ctx.log.warn(`bank stock page flips failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // P5: refusals before the benign skips, so the cut at MAX_SKIPPED keeps what needs fixing; every
  // entry is still counted, by refusal code or by the benign reason's text.
  const skippedCounts: Record<string, number> = {};
  for (const sk of skipped) {
    const k = skipKeyOf(sk.reason);
    skippedCounts[k] = (skippedCounts[k] ?? 0) + 1;
  }
  const ordered = [...skipped.filter((sk) => !BENIGN_SKIPS.has(sk.reason)), ...skipped.filter((sk) => BENIGN_SKIPS.has(sk.reason))];

  const result: ImportResult = {
    batchId,
    fileName,
    pageKind: parsed.pageKind,
    bank: parsed.bank,
    parsed: parsed.items.length,
    stored,
    skipped: ordered.slice(0, MAX_SKIPPED),
    // The import's own page warnings first, so the cut at 100 never drops them.
    warnings: [...pageWarnings, ...parsed.warnings].slice(0, 100),
    // Out-of-stock rows are skipped as prices but kept on the list, so `stored` alone undersells the save.
    // 0.7.3: and how many the page gave, so 0 written can tell a newer save from a page with none.
    ...(parsed.pageKind === 'items-list' ? { listRows: listWritten, listRowsRead: listRows.length } : {}),
    origin,
    ...(newFlips !== undefined ? { newFlips } : {}),
    ...(droppedFlips !== undefined ? { droppedFlips } : {}),
    skippedTotal: skipped.length,
    skippedCounts,
    stockSave,
    ...(flips ?? {}),
  };
  tryReport(ctx, reportOf({ ...reportBase, format }, parsed, result.warnings, batchId));
  // F20: after bankStockChanged (core rebuilt the history index there), so the feed reads the new events.
  if (eventsWritten > 0) ctx.push('scraptf.changed', { at: mtime, count: eventsWritten });
  ctx.pricesChanged();
  // Before 'import.done', so a page refetching on it already reads the new list. Core refreshes the
  // cache, re-checks the key price and holdings and pushes 'scraptf.listChanged'. An older list that
  // changed no row (a newer one is stored) pushes nothing. 0.7.4: rows a whole save retired (F60) are a change too.
  if (listWritten > 0 || listRemoved > 0) ctx.scraptfListChanged();
  if (affected.size > 0) ctx.engine.markDirty(affected);
  ctx.push('import.done', result);
  const listNote = parsed.pageKind === 'items-list' ? `, ${listWritten} of ${listRows.length} scrap.tf list rows${listRemoved > 0 ? `, ${listRemoved} no longer listed` : ''}` : '';
  const stockNote = stockSave === 'partial' || stockSave === 'unsettled' ? `, no bank stock save (${stockSave} look)` : '';
  ctx.log.info(`imported ${fileName}: ${result.stored} prices from ${result.parsed} items (${parsed.pageKind})${listNote}${stockNote}`);
  return result;
}

/**
 * A page the folder watch would not read (over the size limit, F18): recorded like a page that imports
 * nothing (pageKind 'unknown', no bank, 0 items, one warning) and pushed as 'import.done', so the
 * Import page and the dashboard say why the save did nothing. No content of the file is read or kept.
 */
export function recordSkippedImport(ctx: HandlerContext, p: { fileName: string; mtimeMs: number; warning: string }): ImportResult {
  const s = ctx.settings();
  if (!s.import.enabled || s.import.acknowledgedAt === null) {
    throw new Error('Saved-page import is turned off. Enable it (and accept the note) in Settings first.');
  }
  const now = ctx.clock.now();
  const fileName = p.fileName.replace(/^.*[\\/]/, '').slice(0, 200) || 'saved page';
  const mtime = Number.isFinite(p.mtimeMs) && p.mtimeMs > 0 ? Math.min(Math.round(p.mtimeMs), now) : now;
  // A folder-watch file, so always a 'file' (F21).
  const batchId = ctx.repo.createImportBatch({ fileName, pageKind: 'unknown', fileMtime: mtime, importedAt: now, itemCount: 0, categories: {}, bank: null, origin: 'file' });
  const result: ImportResult = { batchId, fileName, pageKind: 'unknown', bank: null, parsed: 0, stored: 0, skipped: [], warnings: [p.warning.slice(0, 500)], origin: 'file' };
  // P4: counts only (nothing was parsed): the report says the file was passed over, and why by its code.
  tryReport(ctx, { at: now, origin: 'file', name: fileName, pageKind: 'unknown', bank: null, page: '', format: isMhtmlFileName(fileName) ? 'mhtml' : 'html', batchId, diagnostics: null, warnings: result.warnings, countsOnly: true });
  ctx.push('import.done', result);
  ctx.log.info(`recorded ${fileName} as not imported: ${result.warnings[0]}`);
  return result;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

export function createRpcHandlers(ctx: HandlerContext): RpcHandler {
  const { repo, schema, engine, http, log, clock } = ctx;
  const historyCache = new Map<string, { at: UnixMs; points: HistoryPoint[] }>();
  const historyInflight = new Map<string, Promise<HistoryPoint[]>>();
  const refreshing = new Set<string>();

  const historyFor = async (base: string): Promise<HistoryPoint[]> => {
    const now = clock.now();
    const hit = historyCache.get(base);
    if (hit && now - hit.at < HISTORY_CACHE_MS) return hit.points;
    const s = ctx.settings();
    if (!s.connectors.pricedb || s.networkPaused || http.isPaused()) return hit?.points ?? [];
    let p = historyInflight.get(base);
    if (!p) {
      p = ctx.pricedb
        .history(base)
        .catch(() => [] as HistoryPoint[])
        .then((points) => {
          if (historyCache.size > 200) historyCache.clear();
          historyCache.set(base, { at: clock.now(), points });
          return points;
        })
        .finally(() => historyInflight.delete(base));
      historyInflight.set(base, p);
    }
    let timer: unknown = null;
    const timeout = new Promise<HistoryPoint[]>((resolve) => {
      timer = setTimeout(() => resolve(hit?.points ?? []), HISTORY_WAIT_MS);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
  };

  const snapshotInfo = (base: string) => {
    const now = clock.now();
    const next = http.nextAllowedAt('bptf-snapshot');
    return {
      lastAt: repo.getSnapshotAt(base),
      available: !!ctx.secret('bptfAccessToken') && ctx.settings().connectors.bptfApi && ctx.bptfApi.snapshotAvailable(),
      nextAllowedAt: next > now ? next : null,
    };
  };

  const refreshPricedb = (base: string): void => {
    const s = ctx.settings();
    if (!s.connectors.pricedb || s.networkPaused || http.isPaused()) return;
    const row = repo.getPricedb(base);
    if (row && clock.now() - row.fetchedAt < PRICEDB_FRESH_MS) return;
    ctx.pricedb
      .item(base)
      .then((r) => {
        if (!r) return;
        engine.markDirty([base]);
        // The new reference moves the Live market row's confidence and outlier test too.
        ctx.market.markDirty([base]);
      })
      .catch(() => undefined);
  };

  /**
   * The repo write for a validated price ('prices.upsert', 'prices.bulkUpsert'): base SKU, paint moved into the extras.
   * 0.7.3: a row moved to another item (the Prices page's form) keeps its id, but the old copy's extras, asset id,
   * stock and page described the old item: omitted, they read null as on a new price (the repo keeps omitted fields).
   * `previousBase` is the old item's base SKU then, for its opportunity.
   */
  const priceRow = (p: z.infer<typeof priceInput>, now: UnixMs) => {
    const { full, base, paint } = splitSku(p.sku);
    const stored = p.id !== undefined ? repo.getScrapPrice(p.id) : null;
    const previousBase = stored && looksLikeSku(stored.sku) && toBaseSku(stored.sku) !== base ? toBaseSku(stored.sku) : null;
    const moved = <T,>(value: T | null | undefined): T | null | undefined => (value === undefined && previousBase !== null ? null : value);
    let special: SpecialAttrs | null | undefined = moved(p.special);
    if (paint !== null) special = { ...(special ?? emptySpecial()), paint };
    const name = p.name?.trim() || schema.nameForSku(full);
    const observedAt = p.observedAt !== undefined ? Math.min(p.observedAt, now + 60_000) : now;
    const input: ScrapPriceInput & { name: string; observedAt: UnixMs; source: 'user' | 'import' } = withoutUndefined({
      id: p.id,
      sku: base,
      name,
      costKeys: p.costKeys,
      costScrap: Math.round(p.costScrap),
      source: p.source ?? 'user',
      observedAt,
      note: p.note === undefined ? undefined : p.note?.trim() || null,
      importBatch: moved(p.importBatch),
      special,
      assetId: moved(p.assetId),
      stock: moved(p.stock),
    });
    return { input, base, previousBase };
  };

  // In-memory 1 h cache lives inside the checker, one per service process.
  const buyers = createBuyerChecker({
    bptfApi: ctx.bptfApi,
    http,
    clock,
    log,
    settings: () => ctx.settings(),
    secret: (name) => ctx.secret(name),
  });

  const handlers: Record<string, (params: unknown, method: string) => unknown> = {
    'status.get': () => ctx.status(),

    'opps.list': (params, m) => {
      const now = clock.now();
      const h = ctx.scraptfHistory;
      // 0.8 (T4/T7): each 'import' row's buy timing, from the history's cached saves (no query, no request), at the
      // page's key price and profit settings: read once here, not once per row.
      const kp = engine.keyPrice();
      const profit = ctx.settings().profit;
      const inputs = { keyScrap: kp.valueScrap, profit };
      return listOpportunities(repo, parse(oppQuery, params, m) ?? {}, kp, now, profit.useOrder, h.timingForCopy ? { timingForCopy: (b, s, buy, at) => h.timingForCopy!(b, s, buy, at, inputs) } : undefined);
    },

    'opps.events': (params, m) => repo.listEvents(withoutUndefined(parse(eventQuery, params, m) ?? {})),

    'opps.exportCsv': (params, m) => {
      const { kind, query, events, shopping, market, holdings, bankStock, scraptfChanges } = parse(
        z.object({
          kind: z.enum(['opportunities', 'events', 'shopping', 'market', 'holdings', 'bankStock', 'scraptfChanges']),
          query: oppQuery,
          events: eventsExportQuery,
          shopping: shoppingQuery,
          market: marketQuery,
          holdings: holdingsQuery,
          bankStock: bankStockQuery.optional(),
          scraptfChanges: scraptfChangesQuery,
        }),
        params,
        m,
      );
      const stamp = dateStamp(clock.now());
      if (kind === 'scraptfChanges') {
        // F20: the feed's filters; paging does not apply to the file (newest SCRAPTF_CHANGES_EXPORT_MAX).
        const { beforeId: _beforeId, limit: _limit, ...filters } = scraptfChanges ?? {};
        return { csv: ctx.scraptfHistory.csv(withoutUndefined(filters) as ScraptfChangesQuery, clock.now()), suggestedName: `flipdesk-scraptf-changes-${stamp}.csv` };
      }
      if (kind === 'bankStock') {
        // One bank's rows with the page's filter, search and sort; paging does not apply to the file.
        if (!bankStock) throw new Error(`Invalid parameters for ${m}: bankStock: required for kind bankStock`);
        const { limit: _limit, offset: _offset, ...filters } = bankStock;
        const rows = ctx.bankStock.all(withoutUndefined(filters) as BankStockQuery, clock.now());
        return { csv: bankStockCsv(rows, engine.keyPrice().valueScrap), suggestedName: `flipdesk-bank-stock-${bankStock.bank}-${stamp}.csv` };
      }
      if (kind === 'events') {
        // 0.7.3: the Live log's filters: the newest EVENTS_EXPORT_MAX of its kinds (as the page reads them),
        // then its category and search, so the file holds every row the page could show.
        const { kinds, category, search } = events ?? {};
        const tokens = marketSearchTokens(search);
        const list = repo.listEvents(withoutUndefined({ limit: EVENTS_EXPORT_MAX, kinds })).filter((e) => eventMatches(e, category, tokens));
        return { csv: eventsCsv(list), suggestedName: `flipdesk-events-${stamp}.csv` };
      }
      if (kind === 'shopping') {
        // Every matching row: paging does not apply to the file.
        const kp = engine.keyPrice();
        const { limit: _limit, offset: _offset, ...filters } = shopping ?? {};
        // 0.7.4 (F36): the same bank pages as the list (in memory, MarketIndex.bankFor).
        const list = buildShoppingList(repo.allOpportunities(), withoutUndefined(filters), kp, clock.now(), { bankOf: (sku) => ctx.market.bankFor(sku) });
        return { csv: shoppingCsv(list.rows, kp.valueScrap), suggestedName: `flipdesk-shopping-${stamp}.csv` };
      }
      if (kind === 'market') {
        // The page's filters and sort; paging does not apply to the file.
        const { limit: _limit, offset: _offset, ...filters } = market ?? {};
        const rows = ctx.market.all(withoutUndefined(filters), clock.now());
        return { csv: marketCsv(rows, engine.keyPrice().valueScrap), suggestedName: `flipdesk-market-${stamp}.csv` };
      }
      if (kind === 'holdings') {
        const rows = ctx.holdings.all(withoutUndefined(holdings ?? {}), clock.now());
        return { csv: holdingsCsv(rows, engine.keyPrice().valueScrap), suggestedName: `flipdesk-holdings-${stamp}.csv` };
      }
      // The dashboard's filters and sort, so the file matches the list; paging and grouping do not apply.
      const rows = repo.queryOpportunities(withoutUndefined(query ?? {}));
      // 0.9 (#2): the settings give the break_even_ref column.
      return { csv: opportunitiesCsv(rows, engine.keyPrice().valueScrap, ctx.settings().profit), suggestedName: `flipdesk-opportunities-${stamp}.csv` };
    },

    // 0.7.1 (ACT-9): knownStock is the stock scrap.tf showed with the price behind the known row (one read per
    // returned row; a typed price has none). The CSV has no stock column, so it does not ask.
    'shopping.list': (params, m) =>
      buildShoppingList(repo.allOpportunities(), withoutUndefined(parse(shoppingQuery, params, m) ?? {}), engine.keyPrice(), clock.now(), {
        stockOf: (ref) => {
          const id = /^price:(\d+)$/.exec(ref);
          return id ? (repo.getScrapPrice(Number(id[1]))?.stock ?? null) : null;
        },
        // 0.7.4 (F36): where a save last listed the item, else its kind's bank (in memory, no read per row).
        bankOf: (sku) => ctx.market.bankFor(sku),
      }),

    // In memory only: the index reads the local book the live feed fills, with no request of its own.
    'market.list': (params, m) => ctx.market.list(withoutUndefined(parse(marketQuery, params, m) ?? {}), clock.now()),

    // Also local only: the journal's open lots against the same book the market index reads.
    'holdings.list': (params, m) => ctx.holdings.list(withoutUndefined(parse(holdingsQuery, params, m) ?? {}), clock.now()),

    // 0.8 (H7): local only: the journal, the stored exit runs and the same book (H7).
    'holdings.detail': (params, m): HoldingDetail => {
      const { sku } = parse(skuOnly, params, m);
      return ctx.holdings.detail(splitSku(sku).full, clock.now());
    },

    // 0.9 (#12): local reads only: the recorded exit runs, the journal and the PriceDB history 'item.detail' already cached
    // this session (historyCache). It never calls historyFor or the PriceDB connector, so it sends no request.
    'profit.reserveSuggestion': (): ReserveSuggestion => {
      const now = clock.now();
      const histories = new Map<string, readonly HistoryPoint[]>();
      for (const [base, hit] of historyCache) if (hit.points.length > 0) histories.set(base, hit.points);
      const summary = journalSummary(repo.listJournal());
      let settingsAt: UnixMs | null = null;
      try {
        settingsAt = ctx.holdings?.buyerSettingsAt?.(now) ?? null;
      } catch {
        settingsAt = null;
      }
      // Review: the PriceDB key history already in memory (the key curve cache; reading it sends nothing) values each
      // recorded end with keys at that instant's key price. None loaded: those ends are not observed.
      let keyHistory: LoadedKeyHistory | null = null;
      try {
        keyHistory = ctx.pricedb?.loadedKeyHistory?.() ?? null;
      } catch {
        keyHistory = null;
      }
      return reserveSuggestionOf({
        marks: repo.holdingMarksSince(now - RESERVE_LOOKBACK_MS, RESERVE_MAX_MARKS),
        histories,
        // typicalHoldOf's lookup for a SKU with no own sales is the median over every sale; no SKU is ''.
        hold: typicalHoldOf(summary.closed, summary.open)(''),
        keyScrap: engine.keyPrice().valueScrap,
        settingsAt,
        now,
        keyHistory,
      });
    },

    'item.detail': async (params, m) => {
      const { sku, history: withHistory, target } = parse(
        z.object({ sku: skuText, history: z.boolean().optional(), target: z.enum(['newest', 'plain']).optional() }),
        params,
        m,
      );
      const { full, base } = splitSku(sku);
      // Quick entry's live preview asks without history: local only, no PriceDB request.
      const history = withHistory === false ? [] : await historyFor(base);
      const keyPrice = engine.keyPrice();
      return buildItemDetail({
        repo,
        schema,
        sku: full,
        keyPrice,
        settings: ctx.settings(),
        now: clock.now(),
        snapshot: snapshotInfo(base),
        history,
        ...(target ? { target } : {}),
        // In memory (F14): the saved scrap.tf/items row of the base SKU, at the drawer's key price.
        scraptfList: ctx.scraptfList.rowFor(base, keyPrice.valueScrap),
        // In memory (F17): this copy in the newest bank-stock save that lists it.
        bankStock: ctx.bankStock.detailFor(full),
      });
    },

    'item.refresh': (params, m) => {
      const { sku } = parse(skuOnly, params, m);
      const { base } = splitSku(sku);
      const s = ctx.settings();
      const no = (reason: string, etaMs: number | null = null) => ({ queued: false, reason, etaMs });
      // 0.7.4 (F74): a kit or tool without its target names no listed item, so there is nothing to snapshot.
      let targetless = false;
      try {
        targetless = schema.isTargetlessTool?.(base) === true;
      } catch {
        // An unreadable SKU is refused by the snapshot itself.
      }
      if (targetless) return no('This tool names no target item; backpack.tf has no listings for it.');
      if (!ctx.secret('bptfAccessToken')) return no('Refreshing needs your backpack.tf access token (Settings).');
      if (!s.connectors.bptfApi) return no('The backpack.tf API is turned off in Settings.');
      if (s.networkPaused || http.isPaused()) return no('The network is paused. Resume it from the top bar first.');
      const blocked = http.hostBlocked('api.backpack.tf');
      if (blocked) return no(`backpack.tf requests are disabled: ${blocked}`);
      if (!ctx.bptfApi.snapshotAvailable()) return no('The backpack.tf snapshot endpoint is unavailable right now; the live feed still updates this item.');
      const wait = Math.max(0, http.nextAllowedAt('bptf-snapshot') - clock.now());
      if (refreshing.has(base)) return { queued: true, reason: null, etaMs: wait + 2_500 };
      if (wait > USER_SNAPSHOT_MAX_WAIT_MS) {
        // 0.7.3: the wait goes back as etaMs only, which the drawer counts down live.
        return no('The snapshot rate limit is reached.', wait);
      }
      refreshing.add(base);
      void ctx
        .snapshot(base, 'user')
        .then(() => ctx.push('opps.changed', { appeared: 0, changed: 0, gone: 0, at: clock.now() }))
        .catch((err: unknown) => log.info(`refresh of ${base} failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => refreshing.delete(base));
      return { queued: true, reason: null, etaMs: wait + 2_500 };
    },

    'item.search': (params, m) => {
      const { q, limit: n } = parse(z.object({ q: z.string().max(300), limit: limit(50) }), params, m);
      return q.trim() ? schema.search(q, n ?? 10) : [];
    },

    'item.resolve': (params, m) => {
      const { text } = parse(z.object({ text: z.string().max(2000) }), params, m);
      return text.trim() ? schema.resolve(text) : null;
    },

    'item.scm': async (params, m) => {
      const { sku } = parse(skuOnly, params, m);
      if (!ctx.settings().connectors.scm) return null;
      const { full } = splitSku(sku);
      const marketHashName = schema.marketHashName(full);
      if (!marketHashName) return { lowest: null, median: null, volume: null, marketHashName: null };
      const r = await ctx.scm.priceOverview(marketHashName);
      // 0.7.3: the connector answers null for every failure (a 429 and its lockout, an HTTP error, a pause, a
      // blocked host); shown as a reading it read "0 sold in 24 h". Steam's "no listing" is a reading.
      if (r === null) {
        const h = ctx.scm.health();
        if (h.state === 'off') return null; // turned off while the request was in flight
        throw new Error(`Steam Market check failed (${h.disabledReason ?? h.lastError ?? 'no answer'}). Nothing was read; try again later.`);
      }
      return { lowest: r.lowest, median: r.median, volume: r.volume, marketHashName };
    },

    // 0.9 (history): local only: the stored spells and community points of the item's book, the asked orders' listing
    // times from the local book; nothing is fetched.
    'item.bookHistory': (params, m): ItemBookHistory => {
      const { sku, orders } = parse(itemBookHistoryParams, params, m);
      return readItemBookHistory({ repo, schema, base: splitSku(sku).base, orders: orders ?? [], keyScrap: engine.keyPrice().valueScrap, now: clock.now() });
    },

    'links.forSku': (params, m) => {
      const { sku, assetId } = parse(z.object({ sku: skuText, assetId: z.string().max(40).nullable().optional() }), params, m);
      const { full } = splitSku(sku);
      const obj = fromString(full);
      return buildLinks({
        sku: full,
        skuObject: obj,
        fullName: schema.nameForSku(full),
        baseName: schema.baseNameForSku(full),
        marketHashName: schema.marketHashName(full),
        effectName: obj.effect !== null ? schema.effectName(obj.effect) : null,
        paintkitName: obj.paintkit !== null ? schema.paintkitName(obj.paintkit) : null,
        assetId: assetId ?? null,
        category: (() => {
          try {
            return schema.categoryForSku(full);
          } catch {
            return null;
          }
        })(),
      });
    },

    'prices.list': (params, m) => {
      const p = parse(z.object({ q: z.string().max(200).optional() }).optional(), params, m);
      return repo.listScrapPrices(p?.q);
    },

    'prices.upsert': (params, m) => {
      const p = parse(priceInput, params, m);
      const now = clock.now();
      // 0.7.4 (F80): Quick entry and the check popup re-type a price the user may have typed before. With
      // replaceTyped (and no id) the newest typed price of the same copy (priceIsForSku) is updated, keeping
      // its stored extras, asset id and stock as the drawer's form does, so an older typed price never stays
      // a second input of its own (a stale false flip). Its price, time and note become this one's: the time
      // is the price's own (a list price keeps its list date), even when older. Found and written in one
      // transaction, so two quick saves cannot both add a row; no typed price of the copy adds one.
      const { saved, base, previousBase } = repo.transaction(() => {
        const replaces = p.replaceTyped === true && p.id === undefined && (p.source ?? 'user') === 'user';
        const { full, base: target } = splitSku(p.sku);
        const typed = replaces ? newestTypedPriceFor(repo.scrapPricesForSku(target), full) : null;
        // The stored base SKU and no extras: the row's own paint and extras stay (Repo.upsertScrapPrice keeps
        // omitted fields). A whole price: no keys means 0 keys, never the old row's.
        const row = priceRow(
          typed
            ? { ...p, id: typed.id, sku: typed.sku, name: p.name ?? typed.name, costKeys: p.costKeys ?? 0, special: undefined, assetId: undefined, stock: undefined, importBatch: undefined }
            : p,
          now,
        );
        return { saved: repo.upsertScrapPrice(row.input), base: row.base, previousBase: row.previousBase };
      });
      ctx.pricesChanged();
      // 0.7.3: a row moved to another item leaves its old item's opportunity, as 'prices.delete' does.
      engine.markDirty(previousBase !== null ? [base, previousBase] : [base]);
      if (ctx.secret('bptfAccessToken') && ctx.settings().connectors.bptfApi && ctx.snapshotStale(base)) ctx.queueSnapshot(base);
      refreshPricedb(base);
      return saved;
    },

    // No per-row snapshot or PriceDB request: the scheduler's watched-SKU jobs pick new SKUs up within their budgets.
    'prices.bulkUpsert': (params, m) => {
      const { rows } = parse(z.object({ rows: z.array(priceInput).max(MAX_BULK_LINES, `at most ${MAX_BULK_LINES} rows`) }), params, m);
      const now = clock.now();
      // Each row is a whole typed price: no keys means 0 keys (an update must not keep the old keys),
      // and a typed price belongs to no import batch.
      const writes = rows.map((r) => priceRow({ ...r, costKeys: r.costKeys ?? 0, source: 'user', importBatch: null }, now));
      let added = 0;
      let updated = 0;
      repo.transaction(() => {
        for (const w of writes) {
          repo.upsertScrapPrice(w.input);
          if (w.input.id !== undefined) updated++;
          else added++;
        }
      });
      if (writes.length > 0) {
        ctx.pricesChanged();
        engine.markDirty(new Set(writes.flatMap((w) => (w.previousBase !== null ? [w.base, w.previousBase] : [w.base]))));
      }
      return { added, updated };
    },

    'prices.parseBulk': (params, m) => {
      const { text, bareUnit } = parse(
        z.object({ text: z.string().max(MAX_BULK_TEXT_CHARS, 'the paste is too large'), bareUnit: z.enum(['ref', 'scrap', 'keys']).optional() }),
        params,
        m,
      );
      const resolve = (t: string) => {
        try {
          return t.trim() ? schema.resolve(t) : null;
        } catch {
          return null;
        }
      };
      const r = parseBulkPrices(text, bareUnit ?? 'ref', resolve);
      if (r.refusal !== null) throw new Error(r.refusal);
      // Without the item list every name would read "Item not recognised"; say what is really wrong.
      if (!schema.isLoaded() && r.rows.length > 0) throw new Error(SCHEMA_LOADING_MESSAGE);
      return { rows: r.rows, rejected: r.rejected };
    },

    'prices.exportCsv': () => ({
      csv: pricesCsv(repo.listScrapPrices(), engine.keyPrice().valueScrap),
      suggestedName: `flipdesk-prices-${dateStamp(clock.now())}.csv`,
    }),

    'prices.delete': (params, m) => {
      const { id: priceId } = parse(idOnly, params, m);
      const sp = repo.getScrapPrice(priceId);
      if (sp) {
        repo.deleteScrapPrice(priceId);
        ctx.pricesChanged();
        if (looksLikeSku(sp.sku)) engine.markDirty([toBaseSku(sp.sku)]);
      }
      return { ok: true };
    },

    'rules.list': () => repo.listRules(),

    'rules.upsert': (params, m) => {
      const p = parse(ruleInput, params, m);
      const rule = repo.upsertRule(
        withoutUndefined({ ...p, costScrap: Math.round(p.costScrap), filter: withoutUndefined(p.filter), observedAt: p.observedAt ?? clock.now() }),
      );
      ctx.pricesChanged();
      engine.markAllDirty();
      return rule;
    },

    'rules.delete': (params, m) => {
      const { id: ruleId } = parse(idOnly, params, m);
      repo.deleteRule(ruleId);
      ctx.pricesChanged();
      engine.markAllDirty();
      return { ok: true };
    },

    'rules.preview': (params, m) => {
      const p = parse(ruleInput.extend({ name: z.string().max(120) }), params, m);
      return previewRule(repo, schema, withoutUndefined(p.filter), 20);
    },

    'rules.exportJson': () => {
      const now = clock.now();
      return { json: rulesToJson(repo.listRules(), now), suggestedName: `flipdesk-rules-${dateStamp(now)}.json` };
    },

    // Adds only; existing rules are never deleted or overwritten (rulesFromJson drops ids).
    'rules.importJson': (params, m) => {
      const { json } = parse(z.object({ json: z.string().max(MAX_RULES_JSON_CHARS, 'the backup is too large') }), params, m);
      const { rules, skipped } = rulesFromJson(json);
      const now = clock.now();
      let added = 0;
      repo.transaction(() => {
        // Restoring the same backup twice must not double every rule (and every rule candidate).
        const existing = new Set(repo.listRules().map(ruleKey));
        const seen = new Set<string>();
        for (const r of rules) {
          const { id: _id, ...rest } = r;
          const input = withoutUndefined({
            ...rest,
            filter: withoutUndefined(rest.filter),
            // A date in the future would keep the rule looking freshly observed forever.
            observedAt: Math.min(rest.observedAt ?? now, now),
          });
          const key = ruleKey(input);
          if (existing.has(key) || seen.has(key)) {
            const why = existing.has(key) ? 'already in your rules' : 'repeated in this backup';
            if (skipped.length < MAX_RULE_SKIP_LINES) skipped.push(`"${input.name.slice(0, 60)}": ${why}`);
            continue;
          }
          seen.add(key);
          repo.upsertRule(input);
          added++;
        }
      });
      if (added > 0) {
        ctx.pricesChanged();
        engine.markAllDirty();
      }
      return { added, skipped };
    },

    'buyer.check': (params, m) => buyers.check(parse(z.object({ steamid: steamId64 }), params, m).steamid),

    'journal.list': (params, m) => {
      const p = parse(z.object({ limit: limit(10_000) }).optional(), params, m);
      return repo.listJournal(p?.limit ?? 500);
    },

    'journal.add': (params, m) => {
      const p = parse(journalInput, params, m);
      const { full } = splitSku(p.sku);
      // 0.8 (J2): either part given records the fee (the other then 0); neither leaves it not recorded.
      const fee = feeOf(p);
      const row = repo.addJournal({
        ts: p.ts ?? clock.now(),
        side: p.side,
        venue: p.venue,
        sku: full,
        name: p.name?.trim() || schema.nameForSku(full),
        keys: p.keys ?? 0,
        scrap: Math.round(p.scrap),
        // 0.7.4 (F39): a backfilled trade's key price then, as the user gave it; else today's.
        keyPriceScrap: p.keyPriceScrap ?? engine.keyPrice().valueScrap,
        note: p.note?.trim() || null,
        ...(fee ? { feeKeys: fee.keys, feeScrap: Math.round(fee.scrap) } : {}),
      });
      ctx.journalChanged();
      return row;
    },

    // Also the toast's Undo after a recorded trade (F12), so holdings and the journal page follow.
    'journal.delete': (params, m) => {
      const { id: entryId } = parse(idOnly, params, m);
      repo.deleteJournal(entryId);
      ctx.journalChanged();
      return { ok: true };
    },

    // 0.8 (J6): venue, note and fee only; a write-off never takes a fee. Also the edit's Undo (the row's old values).
    'journal.update': (params, m) => {
      const p = parse(journalPatchParams, params, m);
      const before = repo.getJournal(p.id);
      if (!before) throw new Error(JOURNAL_ENTRY_GONE);
      const fee = feePatchOf(p);
      if (before.side === 'writeoff' && fee) throw new Error(`Invalid parameters for ${m}: feeKeys: ${JOURNAL_WRITE_OFF_NOTHING}`);
      const row = repo.updateJournal(
        p.id,
        withoutUndefined({
          venue: p.venue,
          note: p.note === undefined ? undefined : p.note?.trim() || null,
          ...(fee === undefined ? {} : fee === null ? { feeKeys: null, feeScrap: null } : { feeKeys: fee.keys, feeScrap: Math.round(fee.scrap) }),
        }),
      );
      if (!row) throw new Error(JOURNAL_ENTRY_GONE);
      ctx.journalChanged();
      return row;
    },

    'journal.summary': () => journalSummary(repo.listJournal()),

    'journal.exportCsv': () => {
      const now = clock.now();
      // 0.9: the open lots valued as Holdings values them now (local reads only); blank when Holdings cannot answer.
      let valuer: JournalLotValuer | null = null;
      try {
        valuer = journalValuerOf(holdingsValuationOf(ctx.holdings.list({}, now)), ctx.settings().profit);
      } catch (err) {
        log.warn('Journal export could not value the open lots', { error: String(err) });
      }
      return { csv: journalCsv(repo.listJournal(), valuer), suggestedName: `flipdesk-journal-${dateStamp(now)}.csv` };
    },

    'import.html': (params, m) => importSavedPage(ctx, parse(importParams, params, m)),

    'import.batches': (params, m) => {
      const p = parse(z.object({ limit: limit(500) }).optional(), params, m);
      return repo.listImportBatches(p?.limit ?? 20);
    },

    // 0.7.1 (P4): the newest sanitized parser reports, from memory only; nothing is stored or sent.
    'import.report': (params, m): ImportReport[] => {
      const p = parse(z.object({ limit: limit(IMPORT_REPORT_RING) }).nullish(), params, m);
      return importReports(p?.limit ?? IMPORT_REPORT_RING);
    },

    // F14: the saved list from memory plus the import switches; nothing is fetched (R1).
    'scraptf.listStatus': (params, m): ScraptfListStatus => {
      parse(z.object({}).strict().nullish(), params, m);
      const s = ctx.settings();
      const importEnabled = s.import.enabled && s.import.acknowledgedAt !== null;
      const sum = ctx.scraptfList.summary();
      const watch = importEnabled ? ctx.folderWatch() : { active: false, error: null };
      return {
        items: sum.items,
        newestAt: sum.newestAt,
        oldestAt: sum.oldestAt,
        pages: sum.batches,
        importEnabled,
        watchFolder: s.import.watchFolder,
        watchActive: watch.active,
        watchError: watch.error,
      };
    },

    // F15: from memory (batches, opportunities, the market index); nothing is fetched (R1).
    'scraptf.banks': (params, m): ScraptfBanksResult => {
      parse(z.object({}).strict().nullish(), params, m);
      return ctx.banks.summary(clock.now());
    },

    // F17: from memory (each page's two newest saves, the market index); nothing is fetched (R1).
    'scraptf.bankStock': (params, m): BankStockResult =>
      ctx.bankStock.list(withoutUndefined(parse(bankStockQuery, params, m)) as BankStockQuery, clock.now()),

    // F20: from memory (the runs index of the user's saves) and scraptf_events; nothing is fetched (R1).
    'scraptf.itemHistory': (params, m): ScraptfItemHistory => {
      const { sku, special } = parse(scraptfItemHistoryParams, params, m);
      return ctx.scraptfHistory.itemHistory(sku, special ?? null, clock.now());
    },

    // F20: the change feed, valued now and joined to the Live market; nothing is fetched (R1).
    'scraptf.changes': (params, m): ScraptfChangeEvent[] =>
      ctx.scraptfHistory.changes(withoutUndefined(parse(scraptfChangesQuery, params, m) ?? {}) as ScraptfChangesQuery, clock.now()),

    // 0.8 (G1): from memory (the watch cache, the kept saves, the market index); nothing is fetched (R1).
    'watches.list': (params, m): ScraptfWatchView[] => {
      const p = parse(watchesListParams, params, m);
      // Any SKU of the item lists its base's watches (a painted SKU's paint is a copy, not another item).
      const base = p?.sku !== undefined ? (bankStockTargetOf(p.sku)?.base ?? p.sku) : null;
      const list = ctx.watches.all().filter((w) => base === null || w.sku === base);
      const pages = list.length > 0 ? ctx.bankStock.watchRows(new Set(list.map((w) => w.sku))) : [];
      return watchViewsOf(list, pages, engine.keyPrice().valueScrap, ctx.settings().notifications.minConfidence);
    },
    'watches.upsert': (params, m): ScraptfWatch => {
      const p = parse(watchInput, params, m);
      const existing = p.id !== undefined ? repo.getWatch(p.id) : null;
      if (p.id !== undefined && existing === null) throw new Error(WATCH_GONE);
      const write = watchWriteOf(withoutUndefined(p), existing, (b) => schema.nameForSku(b));
      // A new copy past the cap; an update, or the same copy again, never counts.
      if (existing === null && repo.findWatch(write.sku, write.specialKey) === null && repo.countWatches() >= WATCHES_MAX) throw new Error(WATCHES_FULL);
      const saved = repo.upsertWatch(write, clock.now());
      ctx.watchesChanged();
      return saved;
    },
    'watches.delete': (params, m) => {
      const { id: watchId } = parse(idOnly, params, m);
      repo.deleteWatch(watchId);
      ctx.watchesChanged();
      return { ok: true };
    },
    // Undo of a removal: the same watch back (its id and times), so its notification dedupe still holds.
    'watches.restore': (params, m): ScraptfWatch => {
      const p = parse(watchRestore, params, m);
      const back = repo.getWatch(p.id);
      if (back !== null) return back;
      const r = watchRestoreOf(withoutUndefined(p), (b) => schema.nameForSku(b), clock.now());
      if (repo.findWatch(r.write.sku, r.write.specialKey) !== null) throw new Error(WATCH_COPY_TAKEN);
      if (repo.countWatches() >= WATCHES_MAX) throw new Error(WATCHES_FULL);
      const saved = repo.restoreWatch(r.write, r.createdAt, r.updatedAt);
      ctx.watchesChanged();
      return saved;
    },

    // F16 live check: local only (no request), and the text is never logged, stored or put in an error.
    'check.text': (params, m): CheckResult => {
      const { text, source, hint } = parse(checkTextParams, params, m);
      let result: CheckResult;
      try {
        // F19: main's hint (zod-checked SKU) is passed on only when sent; a price-only text then takes it.
        result = hint ? ctx.liveCheck.check(text, source, clock.now(), { sku: hint.sku }) : ctx.liveCheck.check(text, source, clock.now());
      } catch (err) {
        // The error's message could quote the text (a resolver error, say): log its class only.
        log.warn(`live check failed (${err instanceof Error ? err.name : typeof err})`);
        throw new Error(CHECK_FAILED_MESSAGE);
      }
      if (result.status === 'item') ctx.push('check.done', result);
      return result;
    },

    'check.recent': (params, m): CheckResult[] => {
      parse(z.object({}).strict().nullish(), params, m);
      return ctx.liveCheck.recent();
    },

    'health.get': () => ctx.health(),

    // Only the user clears a challenge block (R7); the service never retries a blocked host on its own.
    'net.unblock': (params, m) => {
      const { host: raw } = parse(z.object({ host: z.string().trim().min(1, 'a host is required').max(253) }), params, m);
      const host = normalizeHost(raw);
      if (!allowedHosts().includes(host) && http.hostBlocked(host) === null) {
        throw new Error(`${host.slice(0, 64)} is not a host this app contacts.`);
      }
      http.unblockHost(host);
      ctx.hostUnblocked(host);
      return { ok: true };
    },

    'secrets.test': async (params, m) => {
      const { name } = parse(z.object({ name: z.enum(SECRET_NAMES as unknown as [SecretName, ...SecretName[]]) }), params, m);
      if (name === 'steamApiKey') {
        return ctx.secret('steamApiKey')
          ? { ok: true, message: 'Saved. The Steam Web API key is not used yet, so it was not sent anywhere.' }
          : { ok: false, message: 'No Steam Web API key is set. It is optional and not used yet.' };
      }
      return ctx.bptfApi.test(name);
    },

    'engine.runNow': () => engine.runNow(),
  };

  const known = new Set<string>(SERVICE_METHODS);
  return async (method, params) => {
    if (typeof method !== 'string' || !known.has(method) || !Object.hasOwn(handlers, method)) {
      throw new Error(`Unknown method: ${String(method).slice(0, 64)}`);
    }
    return handlers[method]!(params, method);
  };
}
