// Internal interfaces of the background service. Each module implements one of
// these so modules can be built and tested independently and wired together in
// src/service/core.ts.

import type { BankStockThinSave } from '../shared/bankStock';
import type {
  BankNewestSave,
  BankStockSave,
  BankStockStored,
  Category,
  CommunityPoint,
  CommunityRow,
  ConnectorHealth,
  EventQuery,
  GroupBy,
  HistoryPoint,
  HoldingMark,
  HostBudget,
  ImportBatch,
  Intent,
  ItemSuggestion,
  JournalEntry,
  JournalPatch,
  KeyPriceQuote,
  KeyPriceState,
  Listing,
  LoadedKeyHistory,
  OppQuery,
  Opportunity,
  OpportunityEvent,
  OrderSpell,
  OrderSpellEnd,
  PriceRule,
  PriceRuleInput,
  PricedbRow,
  PriceSource,
  RequestLogRow,
  ResolvedItem,
  NewScraptfEvent,
  ScrapPrice,
  ScrapPriceInput,
  ScraptfBank,
  ScraptfChangeKind,
  ScraptfEventStored,
  ScraptfListStored,
  ScraptfLowStored,
  ScraptfWatch,
  ScraptfWatchWrite,
  SecretName,
  Settings,
  UnixMs,
  UnixSec,
} from '../shared/types';

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

export interface Clock {
  now(): UnixMs;
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export const systemClock: Clock = { now: () => Date.now() };

// ---------------------------------------------------------------------------
// Network (src/service/net)
// ---------------------------------------------------------------------------

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Query keys whose values are secrets: sent, but redacted in every log. */
  secretQuery?: string[];
  headers?: Record<string, string>;
  /** Header names whose values are secrets (redacted in logs). */
  secretHeaders?: string[];
  /** JSON request body (POST). */
  json?: unknown;
  ifNoneMatch?: string | null;
  timeoutMs?: number;
  /** Parse the body as JSON (default true). When false, `text` is filled. */
  expectJson?: boolean;
  /** Budget id from BUDGETS (defaults to the host's default budget). */
  budget?: string;
  /** User-initiated requests are served before background ones. */
  priority?: 'user' | 'background';
  /** Longest time to wait for a rate-limit slot before throwing RateLimitedError (default 60 s). */
  maxWaitMs?: number;
  signal?: AbortSignal;
  /**
   * 0.7.4 (F52): true for an unavailable status (500, 502-504, 52x, 530) whose parsed body is this caller's
   * answer about this one request, not an outage (Steam Market's 500 {"success":false}: no listing under that
   * name). Such an answer counts as a success for the budget instead of pausing it. Never asked about a 429 or a
   * challenge page; a body that is not JSON reaches it as null.
   */
  isAnswer?: (status: number, data: unknown) => boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T | null;
  text: string | null;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  etag: string | null;
  notModified: boolean;
  bytes: number;
  ms: number;
}

/** A rate budget. Defaults live in src/service/net/budgets.ts. */
export interface BudgetSpec {
  id: string;
  /** Hostname the budget applies to (used for host-level pauses). */
  host: string;
  minIntervalMs: number;
  maxPerMinute?: number;
  maxPerHour?: number;
  maxPerDay?: number;
  concurrency: number;
  /** Human description shown on the Data health page. */
  description: string;
}

/**
 * The only way service code may make an HTTP request. Enforces the host
 * policy (denylist first), budgets, Retry-After, challenge detection, an
 * honest User-Agent, and writes a redacted request log.
 */
export interface HttpClient {
  request<T = unknown>(url: string, opts?: HttpRequestOptions): Promise<HttpResponse<T>>;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  /** Earliest time a request on this budget would be allowed. */
  nextAllowedAt(budget: string): UnixMs;
  budgets(): HostBudget[];
  /** Reason string while a host is disabled (challenge page, revoked key), else null. */
  hostBlocked(host: string): string | null;
  /**
   * Disables a host until the user re-enables it (unblockHost via net.unblock),
   * across restarts. For connections that do not go through request(), such as
   * a websocket upgrade refused with a challenge or 401/403 (R7).
   */
  blockHost(host: string, reason: string): void;
  unblockHost(host: string): void;
  userAgent(): string;
}

export interface RequestLogSink {
  record(row: RequestLogRow): void;
}

// ---------------------------------------------------------------------------
// Storage (src/service/db)
// ---------------------------------------------------------------------------

export interface BptfNameRow {
  sku: string;
  name: string;
  marketName: string | null;
  lastSeen: UnixMs;
}

export interface SchemaItemRow {
  defindex: number;
  /** Schema `name` (internal, e.g. "The Team Captain" or "TF_WEAPON_ROCKETLAUNCHER"). */
  name: string;
  /** Display name, e.g. "Team Captain". */
  itemName: string;
  properName: boolean;
  itemClass: string;
  /** item_slot: 'misc', 'head', 'primary', 'secondary', 'melee', 'pda', 'pda2', 'building', 'action', 'taunt', ... */
  slot: string | null;
  craftClass: string | null;
  usedByClasses: string[];
  imageUrl: string | null;
}

export interface EffectRow {
  id: number;
  name: string;
  /** Lower id of a RED/BLU pair that shares this name; equals id otherwise. */
  canonicalId: number;
  type: 'cosmetic' | 'weapon' | 'taunt' | 'other';
}

export interface PaintRow {
  /** RED decimal used by the SKU `p` token. */
  decimal: number;
  hex: string;
  name: string;
  bluHex: string | null;
}

export interface PaintkitRow {
  id: number;
  name: string;
}

export interface SchemaSnapshot {
  items: SchemaItemRow[];
  effects: EffectRow[];
  paints: PaintRow[];
  paintkits: PaintkitRow[];
  fetchedAt: UnixMs;
  etag: string | null;
}

/** One page of opportunities, read in SQL so only the page is parsed. */
export interface OppPage {
  limit: number;
  offset: number;
  /** Order rows by group first, groups in this key order (unknown keys last), keeping the sort inside each group. */
  group?: { by: GroupBy; order: readonly string[] } | null;
}

export interface OppGroupStat {
  key: string;
  count: number;
  profitScrap: number;
}

/**
 * Repo.createImportBatch input. `bank` (F15) is optional so callers that predate it store null;
 * importSavedPage always passes the parser's ScrapTfParseResult.bank.
 */
export type NewImportBatch = Omit<ImportBatch, 'id' | 'bank'> & { bank?: ScraptfBank | null };

/** Repo.scraptfEvents filters (F20). `sku` is a stored (base) SKU, matched exactly. */
export interface ScraptfEventQuery {
  bank?: ScraptfBank;
  kinds?: readonly ScraptfChangeKind[];
  sku?: string;
  /** Only this copy of `sku` (bank_stock.special_key); ignored without `sku`. */
  specialKey?: string;
  /** Only ids below this ("Load older"). */
  beforeId?: number;
  /** Only events at or after this time. */
  sinceAt?: UnixMs;
  limit?: number;
}

/** Repo.scraptfListSummary(): the saved scrap.tf/items list as a whole (F14). */
export interface ScraptfListSummary {
  items: number;
  newestAt: UnixMs | null;
  oldestAt: UnixMs | null;
  /** Distinct import batches (saved list pages) behind the rows. */
  batches: number;
}

export interface Repo {
  readonly path: string;
  sizeBytes(): number;
  close(): void;
  transaction<T>(fn: () => T): T;

  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // backpack.tf listings
  upsertListings(rows: Listing[]): void;
  deleteListings(ids: string[]): void;
  getListing(id: string): Listing | null;
  listingsByBaseSku(baseSku: string, intent?: Intent): Listing[];
  buyListingsByBaseSkus(baseSkus: string[]): Map<string, Listing[]>;
  /** Distinct base SKUs that currently have at least one buy listing. */
  baseSkusWithBuyOrders(): string[];
  /** Snapshot reconcile: delete listings of baseSku+intent whose ids are not in keepIds. */
  deleteListingsNotIn(baseSku: string, intent: Intent, keepIds: string[]): number;
  purgeListingsOlderThan(ts: UnixMs): number;
  listingCounts(): { total: number; buy: number; sell: number };

  // backpack.tf names learned from the feed
  upsertBptfNames(rows: BptfNameRow[]): void;
  getBptfName(sku: string): BptfNameRow | null;
  findSkuByBptfName(name: string): string | null;
  /**
   * 0.7.4 (F15/F42/F72): every SKU learned under this name (backpack.tf files one name under defindex
   * twins), exact case first, then by SKU; never by when it was seen, so the answer does not move.
   */
  findSkusByBptfName(name: string, limit?: number): string[];
  searchBptfNames(q: string, limit: number): BptfNameRow[];

  // PriceDB
  /** An older `time` never replaces a newer stored row (0.7.3); an equal or undated (0) one does. */
  upsertPricedb(rows: PricedbRow[]): void;
  getPricedb(sku: string): PricedbRow | null;
  pricedbCount(): number;
  getSkuAlias(sku: string): string | null;
  setSkuAlias(sku: string, pricedbSku: string): void;

  // backpack.tf community prices
  upsertCommunity(rows: CommunityRow[]): void;
  getCommunity(sku: string): CommunityRow | null;

  // key prices
  upsertKeyQuote(q: KeyPriceQuote): void;
  keyQuotes(): KeyPriceQuote[];

  // scrap.tf prices typed or imported by the user. Every read joins ScrapPrice.bank from the row's
  // import batch (null for typed rows and unrecognised pages); writes ignore `bank`.
  listScrapPrices(q?: string): ScrapPrice[];
  getScrapPrice(id: number): ScrapPrice | null;
  scrapPricesForSku(sku: string): ScrapPrice[];
  /**
   * 0.7.4 (F31, F37, F56, F62): the 'import' prices whose import batch is of `bank`, observed before
   * `beforeAt`, newest first: a bank's own prices, read per bank (import_batches.bank), never a table scan.
   */
  importScrapPricesOfBank(bank: ScraptfBank, beforeAt: UnixMs): ScrapPrice[];
  upsertScrapPrice(input: ScrapPriceInput & { name: string; observedAt: UnixMs; source: PriceSource }): ScrapPrice;
  deleteScrapPrice(id: number): void;

  // price-sheet rules
  listRules(): PriceRule[];
  getRule(id: number): PriceRule | null;
  upsertRule(input: PriceRuleInput & { observedAt: UnixMs }): PriceRule;
  deleteRule(id: number): void;

  // opportunities and their event log
  upsertOpportunities(rows: Opportunity[]): void;
  deleteOpportunities(keys: string[]): void;
  getOpportunity(key: string): Opportunity | null;
  allOpportunities(): Opportunity[];
  opportunitiesForSku(sku: string): Opportunity[];
  /**
   * Filtered (q's filters and search) and sorted (q.sort/q.dir). Without `page`
   * every match is returned and q.limit/q.offset/q.groupBy are ignored; with it,
   * only that page is read (and parsed), ordered by group first when asked.
   */
  queryOpportunities(q: OppQuery, page?: OppPage): Opportunity[];
  /** Number of rows matching q's filters and search. */
  countOpportunities(q: OppQuery): number;
  /**
   * Per-group count and summed profit (null profit counts as 0) over every row matching q; unordered.
   * 0.7.4 (R27): copies of an item on the same revenue order (`useOrder`'s, default conservative) count once
   * per group, at the best of the matching rows (onceByOrderProfit in src/shared/copyExtras.ts).
   */
  opportunityGroupStats(q: OppQuery, by: GroupBy, useOrder?: Settings['profit']['useOrder']): OppGroupStat[];
  /** Cheap counts for AppStatus: all rows, profitable rows, profitable rows at high confidence. */
  opportunityCounts(): { opportunities: number; profitable: number; highConfidence: number };
  appendEvents(events: Omit<OpportunityEvent, 'id'>[]): void;
  listEvents(q: EventQuery): OpportunityEvent[];
  purgeEventsOlderThan(ts: UnixMs): number;

  // journal
  listJournal(limit?: number): JournalEntry[];
  /** 0.8 (J6): one row by id; null when there is none. */
  getJournal(id: number): JournalEntry | null;
  addJournal(entry: Omit<JournalEntry, 'id'>): JournalEntry;
  /** 0.8 (J6): sets the given venue, note and fee (JournalPatch); side, item, price and time stay. null for an unknown id. */
  updateJournal(id: number, patch: JournalPatch): JournalEntry | null;
  deleteJournal(id: number): void;

  // scrap.tf watches (0.8 G1, schema V15)
  /** Every watch, by id. */
  listWatches(): ScraptfWatch[];
  getWatch(id: number): ScraptfWatch | null;
  /** The watch of one copy (specialKey null: the any-copy watch of the base), or null. */
  findWatch(sku: string, specialKey: string | null): ScraptfWatch | null;
  countWatches(): number;
  /**
   * Adds a watch, or with `id` updates that one (throws when missing); without `id`, the watch of the same copy is
   * updated in place. One transaction. Stamps updated_at = `now` (and created_at on an insert). Throws Error
   * WATCH_COPY_TAKEN when an update would give a watch another watch's copy, TypeError on a bad sku or number or a
   * specialKey of '*' (WATCH_ANY_COPY_SENTINEL: the copy index's every-copy stand-in; every copy is null).
   */
  upsertWatch(w: ScraptfWatchWrite, now: UnixMs): ScraptfWatch;
  deleteWatch(id: number): void;
  /**
   * 0.8 ('watches.restore', Undo of a removal): inserts the removed watch again with its own id and times (ids are
   * AUTOINCREMENT, never handed out twice). One transaction. A watch that still has the id is returned as it is.
   * Throws Error WATCH_COPY_TAKEN when another watch has that copy now, TypeError as upsertWatch.
   */
  restoreWatch(w: ScraptfWatchWrite & { id: number }, createdAt: UnixMs, updatedAt: UnixMs): ScraptfWatch;

  // item schema
  replaceSchema(s: SchemaSnapshot): void;
  schemaItem(defindex: number): SchemaItemRow | null;
  allSchemaItems(): SchemaItemRow[];
  effects(): EffectRow[];
  paints(): PaintRow[];
  paintkits(): PaintkitRow[];
  schemaInfo(): { items: number; effects: number; paintkits: number; loadedAt: UnixMs | null; etag: string | null };

  // saved-page imports
  /** An unknown `bank` value is stored as NULL (F15). */
  createImportBatch(b: NewImportBatch): number;
  /** Newest first (importedAt, then id); `bank` is null for batches from before 0.5. */
  listImportBatches(limit: number): ImportBatch[];
  /**
   * 0.7.1: each bank's newest save over every import batch with a recorded bank (not only the newest 500):
   * save time as batchSavedAt (file mtime, else import time), ties to the higher id; a bank page that stored
   * nothing is skipped, the list counts with none (isEmptyBankSave). One row per bank saved, in
   * SCRAPTF_BANK_IDS order. One index seek per bank (schema V10), so it does not grow with the batches.
   */
  bankNewestSaves(): BankNewestSave[];

  // scrap.tf price list (F14): the user's saved scrap.tf/items, one row per canonical base SKU
  /**
   * One transaction. A row replaces the stored one for its SKU only when its observedAt is at least
   * the stored row's (a re-save replaces; an older file copied into the watch folder later never does).
   * A missing or non-finite price is stored as NULL (a "Sold out" row has no sells price); rows without a
   * SKU, a finite time, or any price at all are skipped. Prices are rounded to whole scrap, stock and
   * limit to whole counts (negative: NULL). Returns the rows written.
   */
  upsertScraptfList(rows: readonly ScraptfListStored[]): number;
  /** Every row, by SKU. */
  scraptfList(): ScraptfListStored[];
  scraptfListRow(sku: string): ScraptfListStored | null;
  /** Row count, newest and oldest observedAt (null when empty) and distinct import batches behind the rows. */
  scraptfListSummary(): ScraptfListSummary;
  /** Retention (maintenance, RETENTION.scraptfListMs): deletes rows observed before `ts`; returns how many. */
  purgeScraptfListOlderThan(ts: UnixMs): number;
  /**
   * 0.7.4: deletes the rows of these SKUs observed before `beforeTs` (importSavedPage: a whole /items save
   * that no longer shows them, in its own transaction); returns how many.
   */
  deleteScraptfListRows(skus: readonly string[], beforeTs: UnixMs): number;

  // scrap.tf bank stock (F17, schema V6): what each saved bank page had in stock at that moment
  /**
   * 0.7.4: the bank of the newest bank stock row (by save time, then batch id) of any of these SKUs, any
   * extras, outside the /items list and /unusuals; null when no such save lists one. One primary-key seek
   * per kept save and SKU.
   */
  bankStockNewestBankOf(skus: readonly string[]): ScraptfBank | null;
  /**
   * Writes one save's rows (importSavedPage, inside its own transaction, after createImportBatch). A row
   * without a SKU is skipped; a repeated (sku, specialKey) keeps its first row. Costs with no finite
   * value are stored NULL (no price to buy), metal rounded to whole scrap, stock to a whole count
   * (negative: NULL). `page` is which page of the bank the save is (ScrapTfParseResult.page; '' when
   * omitted), stored on every row. Throws TypeError for a batch id that is not a positive integer or an
   * unknown bank. Returns the rows written.
   */
  insertBankStock(batchId: number, bank: ScraptfBank, rows: readonly BankStockStored[], page?: string): number;
  /**
   * A bank's saves that have rows, newest first by save time (the batch's fileMtime, else importedAt;
   * ties to the higher batch id), with their row counts and page. Batches no longer in import_batches
   * are left out. F20: `perPage` keeps only each page's newest `perPage` saves, listed page by page
   * (the page saved last first, each newest first), so `limit` never cuts a page short: the F17 cache
   * reads every page's pair this way, whatever the other pages of the bank keep.
   */
  bankStockSaves(bank: ScraptfBank, limit?: number, opts?: { perPage?: number }): BankStockSave[];
  /** One save's rows, by SKU then special key. */
  bankStockRows(batchId: number): BankStockStored[];
  /** bankStockSaves(bank)[0] and [1]: the newest save and the one before it (null when missing). */
  bankStockLatestPair(bank: ScraptfBank): { newest: BankStockSave | null; previous: BankStockSave | null };
  /**
   * F20: every save that has rows (every bank and page): batch id, save time (batchSavedAt), bank and page,
   * oldest first (save time, then batch id). Read from bank_stock_saves (V8, one row per kept save), so
   * it costs per kept save, not per stored row or per import batch ever written (the thinning, the
   * history index and the re-save reminders read it after every import and every minute).
   */
  bankStockSaveIndex(): BankStockThinSave[];
  /** F20: the rows of several saves in one read (chunked), by batch id; a batch with no rows is absent. */
  bankStockRowsOf(batchIds: readonly number[]): Map<number, BankStockStored[]>;
  /**
   * Retention (F20 S1, bankStockThinning; tiers from 0.7.1): per bank page, every save of the last 2 h (at
   * most `maxSaves`, 300, in that tier only), the newest per 10 minutes to 24 h, per UTC hour to 7 d, per
   * UTC day to 90 d, nothing older; a page's newest save, the save it is compared with and its session
   * baseline are never deleted. `orphans` (default true; importSavedPage
   * passes false, maintenance true) also deletes rows whose batch is gone, which scans the table. Returns
   * the rows deleted. Maintenance and importSavedPage call it.
   */
  pruneBankStock(now: UnixMs, opts?: { maxSaves?: number; maxAgeMs?: number; orphans?: boolean }): number;

  // scrap.tf change feed (F20, schema V7)
  /**
   * Writes change events (importSavedPage, inside its transaction, after insertBankStock). An event with
   * an unknown bank or kind, no SKU, a non-finite time or a batch id that is not a positive integer is
   * skipped. Prices: keys as given, metal rounded to whole scrap (non-finite: NULL); stock to a whole
   * count (negative: NULL). Returns the rows written.
   */
  insertScraptfEvents(events: readonly NewScraptfEvent[]): number;
  /** The feed, newest first (id descending), filtered by q (all optional); limit 1..5000, default 100. */
  scraptfEvents(q?: ScraptfEventQuery): ScraptfEventStored[];
  /** One base SKU's events (every copy and bank), newest first; limit 1..5000, default SCRAPTF_ITEM_EVENTS (50). */
  scraptfEventsForSku(sku: string, limit?: number): ScraptfEventStored[];
  /** Retention: deletes events older than `now - maxAgeMs` (default SCRAPTF_EVENTS_MAX_AGE_MS, 90 d); returns how many. */
  pruneScraptfEvents(now: UnixMs, maxAgeMs?: number): number;

  // recorded exit runs of held and watched items (0.8 H1, schema V15)
  /** Each base's newest run (by from_at, then id), one index seek per base; bases with none are absent. */
  latestHoldingMarks(bases: readonly string[]): Map<string, HoldingMark>;
  /** Appends a run (keys and metal of a side both or neither: NULL when its metal is not finite; counts whole; keyScrap NULL when null); returns its id. */
  insertHoldingMark(m: Omit<HoldingMark, 'id'>): number;
  /**
   * Moves a run's to_at forward (never back: MAX) and, when given, sets its latest counts (buyer_count,
   * verified_buyer_count, ask_count); false when the run no longer exists (pruned).
   */
  extendHoldingMark(id: number, toAt: UnixMs, counts?: Pick<HoldingMark, 'buyerCount' | 'verifiedBuyerCount' | 'askCount'>): boolean;
  /** One base's runs with to_at >= sinceTs, oldest first, the newest `limit` of them (default HOLDING_DETAIL_MAX_MARKS, at most 5000). */
  holdingMarks(baseSku: string, sinceTs: UnixMs, limit?: number): HoldingMark[];
  /** 0.9 (#12): every base's runs with to_at >= sinceTs (the newest `limit` by to_at; default and cap RESERVE_MAX_MARKS), ordered by base_sku, from_at, id. */
  holdingMarksSince(sinceTs: UnixMs, limit?: number): HoldingMark[];
  /**
   * Retention: deletes runs whose to_at is older than now - maxAgeMs (default HOLDING_MARKS_MAX_AGE_MS), then each
   * base's oldest runs beyond perBaseMax (default HOLDING_MARKS_PER_BASE_MAX); one transaction; returns rows deleted.
   */
  pruneHoldingMarks(now: UnixMs, opts?: { maxAgeMs?: number; perBaseMax?: number }): number;

  // buy-order persistence (0.9 history, RESEARCH #6, schema V16)
  /** Appends a spell; returns its id. A TypeError for an empty baseSku, a non-finite time or an endKind outside OrderSpellEnd (null: followed); keys/metal bound finite or 0. */
  insertOrderSpell(s: Omit<OrderSpell, 'id'>): number;
  /** Ends a followed spell: end_at, end_kind and last_seen_at = endAt (an ended spell's last_seen_at is its end); false when the row is gone or already ended (a TypeError for a non-finite endAt or an unknown kind). */
  endOrderSpell(id: number, endAt: UnixMs, kind: OrderSpellEnd): boolean;
  /** last_seen_at = MAX(last_seen_at, at) on every followed spell (end_kind NULL) but `exceptIds` (the tracker's held rows); returns rows touched. */
  touchOpenOrderSpells(at: UnixMs, exceptIds?: readonly number[]): number;
  /** Every followed spell ends 'unwatched' at its last_seen_at; returns how many. */
  endOpenOrderSpells(): number;
  /**
   * Spells of these bases (at most MAX_IN_PARAMS) with first_seen_at >= sinceAt and after the whole-table cap's entry
   * cut (pruneOrderSpells), the newest `limit` by first_seen_at (default ORDER_SPELLS_DETAIL_MAX, at most 5000), oldest
   * first by first_seen_at, id. Selected on entry only (KM stays unbiased).
   */
  orderSpells(bases: readonly string[], sinceAt: UnixMs, limit?: number): OrderSpell[];
  /**
   * Retention, ended spells only: first_seen_at older than maxAgeMs, then each base's beyond perBaseMax, then the table's
   * beyond maxRows (newest by first_seen_at kept; the newest first_seen_at it deleted becomes orderSpells' entry cut,
   * never moved back); one transaction; rows deleted.
   */
  pruneOrderSpells(now: UnixMs, opts?: { maxAgeMs?: number; perBaseMax?: number; maxRows?: number }): number;

  // recorded community prices (0.9 history, RESEARCH #7, schema V16)
  /** The stored bptf_community rows of these SKUs (chunked by MAX_IN_PARAMS); absent SKUs have none. */
  communityFor(skus: readonly string[]): Map<string, CommunityRow>;
  /** INSERT OR IGNORE each point (one transaction); skips a point without a SKU, a finite value or a finite recordedAt; returns rows written. */
  insertCommunityHistory(points: readonly CommunityPoint[]): number;
  /** Points of these SKUs (at most MAX_IN_PARAMS), the newest `limit` (default COMMUNITY_HISTORY_DETAIL_MAX, at most 5000) by recorded_at then id, oldest first. */
  communityHistory(skus: readonly string[], limit?: number): CommunityPoint[];
  /** Retention: older than maxAgeMs by recorded_at, each SKU's beyond perSkuMax, the table's beyond maxRows; one transaction; rows deleted. */
  pruneCommunityHistory(now: UnixMs, opts?: { maxAgeMs?: number; perSkuMax?: number; maxRows?: number }): number;

  // scrap.tf lows (0.9 history, schema V16)
  /** One bank's stored lows ([] for an unknown bank). */
  scraptfLows(bank: ScraptfBank): ScraptfLowStored[];
  /** Upserts by (bank, sku, special_key) in one transaction; skips rows with a bad bank or a non-finite price or time; returns rows written. */
  upsertScraptfLows(rows: readonly ScraptfLowStored[]): number;
  /** Retention: deletes lows whose seen_at is older than now - maxAgeMs (default SCRAPTF_LOWS_MAX_AGE_MS); returns how many. */
  pruneScraptfLows(now: UnixMs, maxAgeMs?: number): number;

  // request log
  appendRequestLog(row: RequestLogRow): void;
  recentRequests(limit: number): RequestLogRow[];
  /** Every request-log row at or after `ts`, oldest first (restores budgets after a restart). */
  requestsSince(ts: UnixMs): Pick<RequestLogRow, 'ts' | 'host' | 'path'>[];
  purgeRequestLogOlderThan(ts: UnixMs): number;

  // snapshot bookkeeping (per SKU)
  setSnapshotAt(sku: string, ts: UnixMs): void;
  getSnapshotAt(sku: string): UnixMs | null;
}

// ---------------------------------------------------------------------------
// Item schema (src/service/connectors/schema.ts)
// ---------------------------------------------------------------------------

export interface SchemaService {
  /** Loads cached maps from the DB, then refreshes from sku.pricedb.io when older than 24 h (ETag). */
  init(): Promise<void>;
  refresh(force?: boolean): Promise<void>;
  isLoaded(): boolean;
  health(): ConnectorHealth;
  itemByDefindex(defindex: number): SchemaItemRow | null;
  /**
   * The schema's item_quality for a known defindex (6 when it gives none), else null. 5 marks an item that
   * exists only as an Unusual without an effect (Horseless Headless Horsemann's Headtaker, Haunted Metal Scrap).
   */
  itemQuality(defindex: number): number | null;
  /** backpack.tf-style full name for a SKU, e.g. "Burning Flames Team Captain". Uses names learned from the feed first. */
  nameForSku(sku: string): string;
  /** Plain item name without prefixes, e.g. "Team Captain". */
  baseNameForSku(sku: string): string;
  /** Steam Community Market hash name, or null when not marketable/derivable. */
  marketHashName(sku: string): string | null;
  /** Free text (SKU, full name, bp.tf name, marketplace.tf URL) to an item. */
  resolve(text: string): ResolvedItem | null;
  search(q: string, limit: number): ItemSuggestion[];
  categoryForSku(sku: string): Category;
  effectName(id: number): string | null;
  /**
   * The effect id a name (any case) stands for, else null. 0.9 (#22): `type`, the kind of item the effect is on, picks
   * the effect of that kind when a name is used by several (a renamed effect's old name).
   */
  effectIdByName(name: string, type?: EffectRow['type'] | null): number | null;
  canonicalEffectId(id: number): number;
  paintByDecimal(decimal: number): PaintRow | null;
  /** Accepts RED or BLU hex ("#B8383B" or "b8383b"); returns the RED decimal. */
  paintDecimalByHex(hex: string): number | null;
  paintkitName(id: number): string | null;
  paintkitIdByName(name: string): number | null;
  paintkits(): PaintkitRow[];
  /**
   * 0.7.4 (F09/F14/F49/F73, F08/F43/F69): every base SKU whose buy orders are this base's book, the
   * canonical one (bookBase) first and `base` itself included: backpack.tf files one item's orders under
   * defindex twins (18/205, 9536/17208, 15000/201 ...) and an unusual skin under 5+effect, 11+effect or the
   * 0.7.3 15+effect form. [base] without a schema. Optional: test doubles leave it out (domain/bookTwins.ts).
   */
  bookBases?(base: string): readonly string[];
  /** 0.7.4: the one base of bookBases that keys a merged book (a Live market row, an engine rule row). */
  bookBase?(base: string): string;
  /** 0.7.4 (F74): a kit, fabricator, strangifier, unusualifier or chemistry set SKU without its target: no listing has it. */
  isTargetlessTool?(sku: string): boolean;
}

// ---------------------------------------------------------------------------
// backpack.tf (src/service/connectors/bptf*.ts)
// ---------------------------------------------------------------------------

/**
 * A websocket upgrade the server answered with something other than 101
 * (429, a Cloudflare challenge, an HTML error page, a redirect...). Header
 * values are raw; absent headers are null / ''.
 */
export interface HandshakeRejection {
  status: number;
  retryAfter: string | null;
  cfMitigated: string;
  contentType: string;
}

/** The subset of the `ws` package's WebSocket that connectors use (lets tests inject fakes). */
export interface WebSocketLike {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'ping' | 'pong', listener: (data: unknown) => void): unknown;
  /** Emitted by the socket factory before the 'error' and 'close' of a refused upgrade. */
  on(event: 'handshake-rejected', listener: (r: HandshakeRejection) => void): unknown;
  close(code?: number, reason?: string): void;
  terminate(): void;
  readonly readyState: number;
}

/** 0.9 (history): the newest item.price.community of one base SKU in a batch's updates (wsCommunityPriceOf). */
export interface FeedCommunityPrice {
  sku: string;
  currency: string;
  value: number;
  valueHigh: number | null;
  lastUpdate: UnixSec | null;
  seenAt: UnixMs;
}

export interface FeedBatch {
  upserts: Listing[];
  deletes: string[];
  names: BptfNameRow[];
  /**
   * 0.9 (#11): ids among `deletes` that came from a listing-update reporting the listing not live (an inactive
   * status or archived), not from a listing-delete. Their order is not demand any more; the history package records
   * the end kind from it.
   */
  inactive: string[];
  /** 0.9 (history): the batch's community prices, one per base (the newest); absent from hand-built batches. */
  community?: FeedCommunityPrice[];
  /**
   * 0.9 (history): the stream the batch came from. The socket adds one on every new connection and on every
   * buffer-limit-exceeded (the server dropped events), flushing first, so batches of one epoch form one unbroken
   * stream. Absent (hand-built batches): the same stream as the batch before.
   */
  epoch?: number;
}

export interface BptfSocket {
  /**
   * Starts (or resumes) the feed. A block (client limit, refused upgrade) survives
   * stop() + start() unless the live feed was turned off in Settings in between.
   * A refused upgrade is also stored as a ws.backpack.tf host block, so it
   * survives restarts until the user re-enables the feed.
   */
  start(): void;
  stop(): void;
  /** The user re-enabled ws.backpack.tf (net.unblock): clears the block and connects again if started. */
  unblock(): void;
  health(): ConnectorHealth;
  stats(): { eventsToday: number; bytesToday: number; lastFrameAt: UnixMs | null; parseFailures: number };
}

export interface SnapshotResult {
  name: string;
  createdAt: UnixSec | null;
  listings: Listing[];
  /**
   * 0.7.4 (F51): raw rows bp.tf returned per side, mapped or not (a row whose intent cannot be read counts
   * on both). A side at SNAPSHOT_SIDE_PAGE (30) is a full page, not the whole book. Omitted: unknown.
   */
  sides?: { buy: number; sell: number };
}

export interface BptfApi {
  /** Classifieds snapshot by backpack.tf full item name. Throws on error. */
  snapshot(sku: string, priority?: 'user' | 'background'): Promise<SnapshotResult>;
  /** IGetPrices v4 (needs API key). since = previous current_time for deltas. */
  prices(since?: UnixSec | null): Promise<{ rows: CommunityRow[]; currentTime: UnixSec }>;
  /** IGetCurrencies v1 key price (needs API key). */
  currencies(): Promise<KeyPriceQuote | null>;
  /**
   * users/info v1 on the 'bptf-users' budget (needs the access token). `priority: 'user'`
   * for the drawer's on-click ban check ('buyer.check'): served before background work,
   * waiting at most 15 s for the budget slot and 12 s for the answer. `banDetails` lists the bans found as plain
   * lines (banDetailsFromBans), counted ones first, e.g. "backpack.tf: banned from the
   * site (permanent, Scamming)"; empty for a clean user. Optional only for test fakes.
   */
  usersInfo(
    steamids: string[],
    opts?: { priority?: 'user' | 'background' },
  ): Promise<Map<string, { banned: boolean; name: string | null; banDetails?: string[] }>>;
  test(name: Extract<SecretName, 'bptfApiKey' | 'bptfAccessToken'>): Promise<{ ok: boolean; message: string }>;
  snapshotAvailable(): boolean;
  /**
   * 0.7.3: why backpack.tf rejected this credential, or null when it was not rejected or the user
   * changed it since (a Settings test also clears it). Sends nothing; the scheduler parks the jobs on it.
   */
  credentialRejected(name: Extract<SecretName, 'bptfApiKey' | 'bptfAccessToken'>): string | null;
  health(): ConnectorHealth[];
}

// ---------------------------------------------------------------------------
// PriceDB (src/service/connectors/pricedb.ts)
// ---------------------------------------------------------------------------

export interface PriceDb {
  /** Single price with the SKU variant chain and alias cache. */
  item(sku: string): Promise<PricedbRow | null>;
  /** POST /items-bulk in chunks of 100. */
  bulk(skus: string[]): Promise<PricedbRow[]>;
  /** Cold-start full list (/autob/items). Returns rows stored. */
  loadAll(): Promise<number>;
  history(sku: string, startSec?: UnixSec, endSec?: UnixSec): Promise<HistoryPoint[]>;
  keyQuote(): Promise<KeyPriceQuote | null>;
  startSocket(onPrice: (row: PricedbRow) => void): void;
  stopSocket(): void;
  /** The user re-enabled a PriceDB host (net.unblock): a started socket that is blocked tries again now. */
  resumeSocket(): void;
  health(): ConnectorHealth[];
  /** 0.9 (#17): the newest PriceDB key (5021;6) history already in memory (the key curve cache); null when none. Sends nothing. */
  loadedKeyHistory(): LoadedKeyHistory | null;
}

/** Optional Steam Community Market lookup, on click only. */
export interface SteamMarket {
  priceOverview(marketHashName: string): Promise<{ lowest: string | null; median: string | null; volume: string | null } | null>;
  health(): ConnectorHealth;
}

// ---------------------------------------------------------------------------
// Opportunity engine (src/service/domain)
// ---------------------------------------------------------------------------

export interface EngineEvents {
  onChanged(summary: { appeared: number; changed: number; gone: number; at: UnixMs }): void;
  onNotify(n: { title: string; body: string; sku: string | null }): void;
}

export interface Engine {
  start(): void;
  stop(): void;
  /** Base SKUs whose order book changed; evaluated on the next debounced tick (~1 s). */
  markDirty(baseSkus: Iterable<string>): void;
  /** Re-evaluate everything (settings, key price or rules changed). */
  markAllDirty(): void;
  /** A full run now, re-reading every order book (the periodic sweep reuses books not marked dirty). */
  runNow(): Promise<{ evaluated: number; ms: number }>;
  keyPrice(): KeyPriceState;
  stats(): { lastRunAt: UnixMs | null; lastRunMs: number | null; evaluated: number };
}

export interface ServiceDeps {
  clock: Clock;
  log: Logger;
  repo: Repo;
  http: HttpClient;
  settings(): Settings;
  secret(name: SecretName): string | null;
}
