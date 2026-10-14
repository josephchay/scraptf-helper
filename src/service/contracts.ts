// Internal interfaces of the background service. Each module implements one of
// these so modules can be built and tested independently and wired together in
// src/service/core.ts.

import type {
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
  ScrapPrice,
  ScrapPriceInput,
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

  // scrap.tf prices typed or imported by the user
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
  createImportBatch(b: Omit<ImportBatch, 'id'>): number;
  listImportBatches(limit: number): ImportBatch[];

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
