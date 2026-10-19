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
} from '../shared/bankStock';
import { CHECK_MAX_CHARS } from '../shared/check';
import {
  BENIGN_SKIP_REASONS,
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
  SKIP_NEWER_SAVE,
  SKIP_OUT_OF_STOCK,
  SKIP_SAME_OR_CHEAPER,
  importWarningCode,
} from '../shared/importCodes';
import { SCRAPTF_CHANGES_MAX_LIMIT, SCRAPTF_EVENTS_MAX_AGE_MS } from '../shared/scraptfHistory';
import { isScraptfPageUrl, SCRAPTF_WINDOW_OFF } from '../shared/scraptfWindowPolicy';
import { buildLinks } from '../shared/links';
import type { PushContract, PushEvent } from '../shared/rpc';
import { SERVICE_METHODS } from '../shared/rpc';
import { MARKET_MAX_LIMIT, MARKET_MAX_SEARCH_CHARS, MARKET_SORTS, countCategories } from '../shared/market';
import { baseSku as toBaseSku, canonical, fromObject, fromString, isValidSku, looksLikeSku } from '../shared/sku';
import {
  BANK_STOCK_FILTERS,
  BANK_STOCK_SORTS,
  CHECK_SOURCES,
  EMPTY_SPECIAL,
  IMPORT_ORIGINS,
  MARKET_SOURCES,
  MARKET_VERDICTS,
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
  type ImportOrigin,
  type ImportReport,
  type ImportResult,
  type ImportTopFlip,
  type MarketSort,
  type MarketSource,
  type MarketVerdict,
  type ParsedScrapItem,
  type ScrapPrice,
  type ScrapPriceInput,
  type ScraptfBank,
  type ScraptfBanksResult,
  type ScraptfChangeEvent,
  type ScraptfChangeKind,
  type ScraptfChangesQuery,
  type ScraptfItemHistory,
  type ScraptfListStatus,
  type ScraptfListStored,
  type SecretName,
  type Settings,
  type SpecialAttrs,
  type UnixMs,
} from '../shared/types';
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
import { holdingsCsv, type Holdings } from './domain/holdings';
import type { LiveCheck } from './domain/liveCheck';
import { marketCategoryOf, marketCsv, type MarketIndex } from './domain/market';
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
   * the flips on its page with pageFlips (ImportResult.pageFlips, topFlips).
   */
  bankStock: Pick<BankStock, 'list' | 'all' | 'detailFor' | 'newFlips' | 'pageFlips'>;
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
   * pushes 'scraptf.changed' after the commit when it wrote events.
   */
  scraptfHistory: Pick<ScraptfHistory, 'onImport' | 'itemHistory' | 'changes' | 'csv'>;
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
  /** A journal row was added or deleted: held SKUs (watch list), holdings, and the 'journal.changed' push. */
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
    sort: z.enum(['profit', 'margin', 'confidence', 'updated', 'name']).optional(),
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

const steamId64 = z.string().trim().regex(/^\d{17}$/, 'expected a 17-digit SteamID64');

/** Bulk paste preview: the helper enforces the 100 KB / 500-line limits with a friendly refusal; this only bounds memory. */
const MAX_BULK_TEXT_CHARS = 1_000_000;
/** Same size cap as a rules backup the dashboard would reasonably hold. */
const MAX_RULES_JSON_CHARS = 5_000_000;
/** Skip reasons returned by 'rules.importJson' (rulesFromJson already caps its own). */
const MAX_RULE_SKIP_LINES = 400;
export const SCHEMA_LOADING_MESSAGE = 'The item list is still loading, so names cannot be matched yet. Preview again in a moment.';

const journalInput = z.object({
  ts: finite.optional(),
  side: z.enum(['buy', 'sell']),
  venue: z.string().trim().min(1, 'venue is required').max(100),
  sku: skuText,
  name: z.string().max(300).optional(),
  keys: nonNeg.optional(),
  scrap: nonNeg,
  note: z.string().max(500).nullable().optional(),
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
 * keep the last one, since the whole page shares one time).
 */
function listRowsOf(
  schema: SchemaService,
  items: readonly ParsedScrapItem[],
  observedAt: UnixMs,
): Omit<ScraptfListStored, 'batchId'>[] {
  const bySku = new Map<string, Omit<ScraptfListStored, 'batchId'>>();
  for (const item of items) {
    if (item.sku === null || !looksLikeSku(item.sku)) continue;
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
    });
  }
  return [...bySku.values()];
}

/**
 * F17: a recognised saved page as bank_stock rows: every card or /items row with a SKU, sold out
 * included (what the bank had at that moment), keyed as the import keys prices (base SKU, paint moved
 * into the extras; bankStockSpecialKey). The price is the price to buy (sellsPriceOf), null when the
 * page shows none. A key on several cards keeps its cheapest card on sale (else its first) for the
 * price, and the copies on sale of all those cards for the stock: scrap.tf stacks identical copies as
 * one "3x" card but shows a reserved or differently made copy on a card of its own (the parser already
 * dropped the selected-item duplicates), so one card's count would undersell the bank, by card order.
 */
function bankStockRowsOf(schema: SchemaService, items: readonly ParsedScrapItem[], keyScrap: number): BankStockStored[] {
  /** `onSaleStock`: the summed counts of the key's cards on sale (null: none yet); `unknown`: one of them showed no count. */
  const byKey = new Map<string, { row: BankStockStored; onSale: boolean; total: number; onSaleStock: number | null; unknown: boolean }>();
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
    };
    const onSale = bankStockOnSale(row);
    const total = sells ? Math.round(sells.keys * keyScrap) + sells.scrap : Number.POSITIVE_INFINITY;
    const key = bankStockKey(base, specialKey);
    // A card on sale with no count (no asset id, no stack size) leaves the key's stock unknown.
    const counted = typeof item.stock === 'number' && Number.isFinite(item.stock) ? item.stock : null;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { row, onSale, total, onSaleStock: onSale ? counted : null, unknown: onSale && counted === null });
      continue;
    }
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
  return [...byKey.values()].map((v) => (v.onSale ? { ...v.row, stock: v.unknown ? null : v.onSaleStock } : v.row));
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

/** DC-1: the banks scrap.tf shows on one page (/unusuals has a page per effect; 'list' is the price list). */
const SINGLE_PAGE_BANKS: ReadonlySet<ScraptfBank> = new Set<ScraptfBank>(['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'items']);

/** DC-1: the bank's newest look that stored prices, whole or not (Repo.bankNewestSaves), or null. */
function newestLookOf(ctx: HandlerContext, bank: ScraptfBank): { batchId: number; savedAt: UnixMs } | null {
  return ctx.repo.bankNewestSaves().find((s) => s.bank === bank) ?? null;
}

/**
 * DC-1: imported prices of `bank` set after the page's previous stored save by a look that stored none
 * (only such a look can have set one then), of cards whole save `batchId` does not show on sale. [] unless
 * `batchId` is the page's newest save, it has a previous one (a first save removes nothing) and a look
 * with prices came after that one (`lookBefore`, read before this batch: else the table is not scanned).
 */
function noSaveLookPricesGone(
  ctx: HandlerContext,
  bank: ScraptfBank,
  page: string,
  batchId: number,
  mtime: UnixMs,
  lookBefore: { batchId: number; savedAt: UnixMs } | null,
  rows: readonly BankStockStored[],
): ScrapPrice[] {
  if (lookBefore === null) return [];
  const [newest, prev] = ctx.repo.bankStockSaves(bank, 1000, { perPage: 2 }).filter((sv) => sv.page === page);
  if (newest?.batchId !== batchId || prev === undefined) return [];
  if (lookBefore.batchId === prev.batchId || !(lookBefore.savedAt > prev.savedAt)) return [];
  const onSale = new Set(rows.filter(bankStockOnSale).map((r) => `${r.sku}|${r.specialKey}`));
  return ctx.repo
    .listScrapPrices()
    .filter((sp) => sp.source === 'import' && sp.bank === bank && sp.observedAt > prev.savedAt && sp.observedAt < mtime && !onSale.has(`${sp.sku}|${bankStockSpecialKey(sp.special)}`));
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
    itemWarnings: parsed.items.map((i) => i.warnings),
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
 * this one are never replaced or removed.
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
 * save (DM-2) and an /items list whose stock cannot be read (P1) store their prices but no save. A save
 * that was stored removes the imported price of every card it shows gone from the bank (DM-1), so a
 * card scrap.tf sold stops reading as a flip everywhere. Each parse leaves a sanitized parser report (P4).
 * Refused unless the user enabled import and acknowledged the ToS note (R10); a window read also needs
 * the window itself on (settings.scraptfWindow.enabled, behind its own risk acknowledgement).
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
  const mtime = Number.isFinite(p.mtimeMs) && p.mtimeMs > 0 ? Math.min(Math.round(p.mtimeMs), now) : now;
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
  if (origin === 'window' && parsed.items.length === 0) {
    // F21: the user browses scrap.tf's front page, a profile or a bank whose cards have not arrived yet
    // (the settle read gets them). Such a read stores nothing either way, so it records no batch and
    // pushes nothing: the Import page lists no row per page browsed, and no "saved without its cards"
    // notice tells the user to save a page they never saved. Nothing of the page is logged.
    // P7: a page whose items are in a shape the parser does not know says so too (digits only).
    const layout = parsed.warnings.find((w) => importWarningCode(w) === LAYOUT_CHANGED);
    const warnings = layout !== undefined ? [WINDOW_NOTHING_TO_IMPORT, layout] : [WINDOW_NOTHING_TO_IMPORT];
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
  const keyScrap = ctx.engine.keyPrice().valueScrap;
  for (const item of parsed.items) {
    const title = item.title || item.name;
    const sku = item.sku !== null && looksLikeSku(item.sku) ? item.sku : null;
    // "0/5" on the /items list (priced or "Sold out"): the price to buy cannot be paid right now.
    if (sku !== null && item.stock === 0) {
      skipped.push({ reason: SKIP_OUT_OF_STOCK, title });
      soldOut.add(splitSku(sku).base);
      continue;
    }
    if (sku === null || !isImportableItem(item)) {
      skipped.push({ reason: skipReasonOf(item), title });
      continue;
    }
    const { base, paint } = splitSku(sku);
    const special: SpecialAttrs = { ...item.special, paint: item.special.paint ?? paint };
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

  // The /items list shows plain copies only, so it cannot speak for painted, spelled or named
  // copies imported from bank pages. Rows whose extras were never recorded (null) count as plain.
  const plainKey = specialKey(emptySpecial());
  const extrasKey = (sp: ScrapPrice): string => (sp.special === null ? plainKey : specialKey(sp.special));
  const replaceable = (sp: ScrapPrice): boolean => sp.source === 'import' && (parsed.pageKind !== 'items-list' || extrasKey(sp) === plainKey);
  // Catch-up scans and old pages copied into the watch folder can arrive after a newer page.
  const newerThanPage = (sp: ScrapPrice): boolean => sp.observedAt > mtime;
  // F14: bank pages have no "Price we pay" column, so only an /items list feeds the stored list.
  const listRows = parsed.pageKind === 'items-list' ? listRowsOf(ctx.schema, parsed.items, mtime) : [];
  // F17: what a recognised page (a /buy bank, /unusuals or the /items list) had in stock at that moment.
  const stockRows = parsed.bank !== null ? bankStockRowsOf(ctx.schema, parsed.items, keyScrap) : [];

  // 0.7.1: whether this look is stored as a bank stock save. Only a whole look is: anything else would
  // read as items gone (then restocked and new) on the next one. Its prices are stored either way.
  const pageWarnings: string[] = [];
  let stockSave: NonNullable<ImportResult['stockSave']> = parsed.bank !== null && stockRows.length > 0 ? 'written' : 'none';
  if (stockSave === 'written' && parsed.bank !== null) {
    // P1: an /items row whose stock cannot be read would read as on sale whatever it shows.
    const noStock = parsed.items.filter((i) => i.sku !== null && sellsPriceOf(i) !== null && i.warnings.some((w) => importWarningCode(w) === NO_STOCK_LIMIT)).length;
    if (unsettled) stockSave = 'unsettled';
    else if (noStock > 0) {
      stockSave = 'partial';
      pageWarnings.push(`${NO_STOCK_LIMIT}: ${noStock} rows with no readable stock, so this look stores no bank stock save`);
    } else {
      const partial = partialLookWarning(ctx, parsed.bank, parsed.page, stockRows, mtime);
      if (partial !== null) {
        stockSave = 'partial';
        pageWarnings.push(partial);
      }
    }
  }

  const affected = new Set<string>();
  let batchId = 0;
  let stored = 0;
  let listWritten = 0;
  let stockWritten = 0;
  let eventsWritten = 0;
  try {
    ctx.repo.transaction(() => {
      const previous = new Map<string, ScrapPrice[]>();
      for (const sku of [...[...best.values()].map((b) => b.sku), ...soldOut]) {
        if (!previous.has(sku)) previous.set(sku, ctx.repo.scrapPricesForSku(sku).filter(replaceable));
      }
      const kept = new Set<number>();
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
        const target = same[0] ?? null;
        if (target) kept.add(target.id);
        writes.push({ id: target?.id ?? null, sku, item });
      }

      // Classified now, from what this page stores: a later import (an /items list) re-tags the rows it
      // shares with this one, and the coverage strip must still know which bank page this was (F13).
      const categories = storedCategories(ctx.schema, writes.map((w) => w.sku));
      // DC-1: the bank's newest look with prices before this one, whole or not (read before this batch exists).
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
      for (const [sku, olds] of previous) {
        for (const o of olds) {
          if (kept.has(o.id) || newerThanPage(o)) continue;
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
        // DC-1: a card only a look that stored no save caught (partial or unsettled) has no gone event,
        // since no stored save ever listed it. scrap.tf shows these banks on one page, so a whole look
        // without it means it sold. Never /unusuals: such a look's page is not recorded.
        for (const sp of noSaveLookPricesGone(ctx, bank, parsed.page, batchId, mtime, lookBefore, stockRows)) {
          if (!replaceable(sp) || kept.has(sp.id)) continue;
          ctx.repo.deleteScrapPrice(sp.id);
          affected.add(sp.sku);
        }
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
  // 0.7.1 (UX-3): and every flip on the page now, with the best three, for "10 flips on this page".
  let flips: { pageFlips: number; topFlips: ImportTopFlip[] } | undefined;
  if (origin === 'window' && stockWritten > 0 && parsed.bank !== null) {
    try {
      newFlips = ctx.bankStock.newFlips(parsed.bank, batchId).length;
    } catch (err) {
      ctx.log.warn(`bank stock new flips failed: ${err instanceof Error ? err.message : String(err)}`);
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
    ...(parsed.pageKind === 'items-list' ? { listRows: listWritten } : {}),
    origin,
    ...(newFlips !== undefined ? { newFlips } : {}),
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
  // changed no row (a newer one is stored) pushes nothing.
  if (listWritten > 0) ctx.scraptfListChanged();
  if (affected.size > 0) ctx.engine.markDirty(affected);
  ctx.push('import.done', result);
  const listNote = parsed.pageKind === 'items-list' ? `, ${listWritten} of ${listRows.length} scrap.tf list rows` : '';
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

  /** The repo write for a validated price ('prices.upsert', 'prices.bulkUpsert'): base SKU, paint moved into the extras. */
  const priceRow = (p: z.infer<typeof priceInput>, now: UnixMs) => {
    const { full, base, paint } = splitSku(p.sku);
    let special: SpecialAttrs | null | undefined = p.special;
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
      importBatch: p.importBatch,
      special,
      assetId: p.assetId,
      stock: p.stock,
    });
    return { input, base };
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

    'opps.list': (params, m) => listOpportunities(repo, parse(oppQuery, params, m) ?? {}, engine.keyPrice(), clock.now()),

    'opps.events': (params, m) => repo.listEvents(withoutUndefined(parse(eventQuery, params, m) ?? {})),

    'opps.exportCsv': (params, m) => {
      const { kind, query, shopping, market, holdings, bankStock, scraptfChanges } = parse(
        z.object({
          kind: z.enum(['opportunities', 'events', 'shopping', 'market', 'holdings', 'bankStock', 'scraptfChanges']),
          query: oppQuery,
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
        return { csv: eventsCsv(repo.listEvents({ limit: 5000 })), suggestedName: `flipdesk-events-${stamp}.csv` };
      }
      if (kind === 'shopping') {
        // Every matching row: paging does not apply to the file.
        const kp = engine.keyPrice();
        const { limit: _limit, offset: _offset, ...filters } = shopping ?? {};
        const list = buildShoppingList(repo.allOpportunities(), withoutUndefined(filters), kp, clock.now());
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
      return { csv: opportunitiesCsv(rows, engine.keyPrice().valueScrap), suggestedName: `flipdesk-opportunities-${stamp}.csv` };
    },

    // 0.7.1 (ACT-9): knownStock is the stock scrap.tf showed with the price behind the known row (one read per
    // returned row; a typed price has none). The CSV has no stock column, so it does not ask.
    'shopping.list': (params, m) =>
      buildShoppingList(repo.allOpportunities(), withoutUndefined(parse(shoppingQuery, params, m) ?? {}), engine.keyPrice(), clock.now(), {
        stockOf: (ref) => {
          const id = /^price:(\d+)$/.exec(ref);
          return id ? (repo.getScrapPrice(Number(id[1]))?.stock ?? null) : null;
        },
      }),

    // In memory only: the index reads the local book the live feed fills, with no request of its own.
    'market.list': (params, m) => ctx.market.list(withoutUndefined(parse(marketQuery, params, m) ?? {}), clock.now()),

    // Also local only: the journal's open lots against the same book the market index reads.
    'holdings.list': (params, m) => ctx.holdings.list(withoutUndefined(parse(holdingsQuery, params, m) ?? {}), clock.now()),

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
      if (!ctx.secret('bptfAccessToken')) return no('Refreshing needs your backpack.tf access token (Settings).');
      if (!s.connectors.bptfApi) return no('The backpack.tf API is turned off in Settings.');
      if (s.networkPaused || http.isPaused()) return no('The network is paused. Resume it from the top bar first.');
      const blocked = http.hostBlocked('api.backpack.tf');
      if (blocked) return no(`backpack.tf requests are disabled: ${blocked}`);
      if (!ctx.bptfApi.snapshotAvailable()) return no('The backpack.tf snapshot endpoint is unavailable right now; the live feed still updates this item.');
      const wait = Math.max(0, http.nextAllowedAt('bptf-snapshot') - clock.now());
      if (refreshing.has(base)) return { queued: true, reason: null, etaMs: wait + 2_500 };
      if (wait > USER_SNAPSHOT_MAX_WAIT_MS) {
        return no(`The snapshot rate limit is reached; try again in ${Math.ceil(wait / 1000)} s.`, wait);
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
      return { lowest: r?.lowest ?? null, median: r?.median ?? null, volume: r?.volume ?? null, marketHashName };
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
      const { input, base } = priceRow(parse(priceInput, params, m), clock.now());
      const saved = repo.upsertScrapPrice(input);
      ctx.pricesChanged();
      engine.markDirty([base]);
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
        engine.markDirty(new Set(writes.map((w) => w.base)));
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
      const row = repo.addJournal({
        ts: p.ts ?? clock.now(),
        side: p.side,
        venue: p.venue,
        sku: full,
        name: p.name?.trim() || schema.nameForSku(full),
        keys: p.keys ?? 0,
        scrap: Math.round(p.scrap),
        keyPriceScrap: engine.keyPrice().valueScrap,
        note: p.note?.trim() || null,
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

    'journal.summary': () => journalSummary(repo.listJournal()),

    'journal.exportCsv': () => ({ csv: journalCsv(repo.listJournal()), suggestedName: `flipdesk-journal-${dateStamp(clock.now())}.csv` }),

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
