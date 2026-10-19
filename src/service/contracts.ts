// Internal interfaces of the background service. Each module implements one of
// these so modules can be built and tested independently and wired together in
// src/service/core.ts.

import type { BankStockThinSave } from '../shared/bankStock';
import type {
  BankStockSave,
  BankStockStored,
  Category,
  CommunityRow,
  ConnectorHealth,
  EventQuery,
  GroupBy,
  HistoryPoint,
  HostBudget,
  ImportBatch,
  Intent,
  ItemSuggestion,
  JournalEntry,
  KeyPriceQuote,
  KeyPriceState,
  Listing,
  OppQuery,
  Opportunity,
  OpportunityEvent,
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
  searchBptfNames(q: string, limit: number): BptfNameRow[];

  // PriceDB
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
  /** Per-group count and summed profit (null profit counts as 0) over every row matching q; unordered. */
  opportunityGroupStats(q: OppQuery, by: GroupBy): OppGroupStat[];
  /** Cheap counts for AppStatus: all rows, profitable rows, profitable rows at high confidence. */
  opportunityCounts(): { opportunities: number; profitable: number; highConfidence: number };
  appendEvents(events: Omit<OpportunityEvent, 'id'>[]): void;
  listEvents(q: EventQuery): OpportunityEvent[];
  purgeEventsOlderThan(ts: UnixMs): number;

  // journal
  listJournal(limit?: number): JournalEntry[];
  addJournal(entry: Omit<JournalEntry, 'id'>): JournalEntry;
  deleteJournal(id: number): void;

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

  // scrap.tf bank stock (F17, schema V6): what each saved bank page had in stock at that moment
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
   * Retention (F20 S1, bankStockThinning): per bank page, every save of the last 24 h, the newest per UTC
   * hour to 7 d, the newest per UTC day to 90 d, nothing older, at most `maxSaves` (300); a page's newest
   * save and the save it is compared with are never deleted. `orphans` (default true; importSavedPage
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
  effectIdByName(name: string): number | null;
  canonicalEffectId(id: number): number;
  paintByDecimal(decimal: number): PaintRow | null;
  /** Accepts RED or BLU hex ("#B8383B" or "b8383b"); returns the RED decimal. */
  paintDecimalByHex(hex: string): number | null;
  paintkitName(id: number): string | null;
  paintkitIdByName(name: string): number | null;
  paintkits(): PaintkitRow[];
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

export interface FeedBatch {
  upserts: Listing[];
  deletes: string[];
  names: BptfNameRow[];
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
