// Domain types shared by the service, the Electron main process and the dashboard.
// Pure type declarations plus a few constant tables; no runtime dependencies.
//
// Money convention: every amount is stored as an integer number of scrap
// (1 refined = 9 scrap). Keys are kept separately and only converted to scrap
// at evaluation time with the current key price, because the key price moves.

/** Integer scrap. 1 ref = 9 scrap, 1 rec = 3 scrap. */
export type Scrap = number;
/** Milliseconds since the Unix epoch. */
export type UnixMs = number;
/** Seconds since the Unix epoch (backpack.tf timestamps). */
export type UnixSec = number;

// ---------------------------------------------------------------------------
// Item identity
// ---------------------------------------------------------------------------

/** Parsed form of a tf2autobot-style SKU (port of @tf2autobot/tf2-sku 3.1.0). */
export interface SkuObject {
  defindex: number;
  quality: number;
  craftable: boolean;
  tradable: boolean;
  killstreak: number;
  australium: boolean;
  effect: number | null;
  festive: boolean;
  paintkit: number | null;
  wear: number | null;
  quality2: number | null;
  craftnumber: number | null;
  crateseries: number | null;
  target: number | null;
  output: number | null;
  outputQuality: number | null;
  paint: number | null;
}

export type Category =
  | 'hats'
  | 'weapons'
  | 'stranges'
  | 'killstreaks'
  | 'skins'
  | 'unusuals'
  | 'taunts'
  | 'other';

export const CATEGORIES: readonly Category[] = [
  'hats',
  'weapons',
  'stranges',
  'killstreaks',
  'skins',
  'unusuals',
  'taunts',
  'other',
];

export const CATEGORY_LABELS: Record<Category, string> = {
  hats: 'Hats & cosmetics',
  weapons: 'Weapons & items',
  stranges: 'Stranges',
  killstreaks: 'Killstreaks',
  skins: 'Skins & war paints',
  unusuals: 'Unusuals',
  taunts: 'Taunts',
  other: 'Other',
};

export const QUALITY_NAMES: Record<number, string> = {
  0: 'Normal',
  1: 'Genuine',
  3: 'Vintage',
  5: 'Unusual',
  6: 'Unique',
  7: 'Community',
  8: 'Valve',
  9: 'Self-Made',
  10: 'Customized',
  11: 'Strange',
  12: 'Completed',
  13: 'Haunted',
  14: "Collector's",
  15: 'Decorated Weapon',
};

export const WEAR_NAMES: Record<number, string> = {
  1: 'Factory New',
  2: 'Minimal Wear',
  3: 'Field-Tested',
  4: 'Well-Worn',
  5: 'Battle Scarred',
};

export const KILLSTREAK_NAMES: Record<number, string> = {
  1: 'Killstreak',
  2: 'Specialized Killstreak',
  3: 'Professional Killstreak',
};

/** SKUs of currencies; never scanned for profit. */
export const CURRENCY_SKUS: readonly string[] = ['5000;6', '5001;6', '5002;6', '5021;6'];
export const KEY_SKU = '5021;6';

/**
 * Attributes that make a specific copy of an item different from the clean base
 * item. They are not part of the base SKU; buy orders that ask for them only
 * match items that have exactly them.
 */
export interface SpecialAttrs {
  /** Paint as the RED decimal colour used by the SKU `p` token. */
  paint: number | null;
  spells: string[];
  parts: string[];
  sheen: number | null;
  killstreaker: number | null;
  customName: boolean;
  customDesc: boolean;
}

export const EMPTY_SPECIAL: Readonly<SpecialAttrs> = Object.freeze({
  paint: null,
  spells: [],
  parts: [],
  sheen: null,
  killstreaker: null,
  customName: false,
  customDesc: false,
});

// ---------------------------------------------------------------------------
// backpack.tf order book
// ---------------------------------------------------------------------------

export type Intent = 'buy' | 'sell';

/** One backpack.tf classified listing, normalised. */
export interface Listing {
  /** backpack.tf listing id (opaque string). */
  id: string;
  /** Canonical v3 SKU including the paint token when the listing names a paint. */
  sku: string;
  /** Canonical v3 SKU with paint removed; the matching key. */
  baseSku: string;
  intent: Intent;
  steamid: string;
  userName: string | null;
  /** Key component of the price (backpack.tf allows fractional keys). */
  keys: number;
  /** Metal component of the price, in scrap. */
  metalScrap: Scrap;
  /** True when the listing was made through a bot user agent (heuristic only). */
  isBot: boolean;
  uaClient: string | null;
  uaLastPulse: UnixSec | null;
  userOnline: boolean | null;
  userBanned: boolean;
  /** Listing mirrored from marketplace.tf (USD priced); never used as an exit. */
  isMarketplace: boolean;
  special: SpecialAttrs;
  details: string;
  listedAt: UnixSec | null;
  bumpedAt: UnixSec | null;
  /** When this app last saw the listing (websocket event or snapshot). */
  lastEventAt: UnixMs;
  origin: 'ws' | 'snapshot';
  itemName: string | null;
  marketName: string | null;
}

// ---------------------------------------------------------------------------
// Inputs that the user supplies (scrap.tf side)
// ---------------------------------------------------------------------------

export type PriceSource = 'user' | 'import';

/** A scrap.tf price the user typed in or imported from a page they saved. */
export interface ScrapPrice {
  id: number;
  sku: string;
  name: string;
  costKeys: number;
  costScrap: Scrap;
  source: PriceSource;
  observedAt: UnixMs;
  note: string | null;
  importBatch: number | null;
  /** null means unknown (manual entry): extras such as paint were not recorded. */
  special: SpecialAttrs | null;
  assetId: string | null;
  stock: number | null;
}

export interface ScrapPriceInput {
  id?: number;
  sku: string;
  name?: string;
  costKeys?: number;
  costScrap: Scrap;
  source?: PriceSource;
  observedAt?: UnixMs;
  note?: string | null;
  importBatch?: number | null;
  special?: SpecialAttrs | null;
  assetId?: string | null;
  stock?: number | null;
}

/** Category-level estimate such as "unique craftable hats cost 1.33 ref on scrap.tf". */
export interface RuleFilter {
  categories?: Category[];
  qualities?: number[];
  craftable?: boolean | null;
  australium?: boolean | null;
  killstreak?: number[];
  /** true = only items with an unusual effect, false = only items without. */
  hasEffect?: boolean | null;
  defindexes?: number[];
  nameContains?: string | null;
}

export interface PriceRule {
  id: number;
  name: string;
  filter: RuleFilter;
  costKeys: number;
  costScrap: Scrap;
  observedAt: UnixMs;
  enabled: boolean;
}

export interface PriceRuleInput {
  id?: number;
  name: string;
  filter: RuleFilter;
  costKeys?: number;
  costScrap: Scrap;
  observedAt?: UnixMs;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Prices and references
// ---------------------------------------------------------------------------

export type KeyPriceSource = 'bptf' | 'pricedb' | 'manual';

export interface KeyPriceQuote {
  source: KeyPriceSource;
  buyScrap: Scrap | null;
  sellScrap: Scrap | null;
  observedAt: UnixMs;
}

/** The key price currently used to value keys in scrap. */
export interface KeyPriceState {
  valueScrap: Scrap;
  source: KeyPriceSource | 'default';
  observedAt: UnixMs | null;
  stale: boolean;
  quotes: KeyPriceQuote[];
}

export interface PricedbRow {
  sku: string;
  name: string;
  buyKeys: number;
  buyScrap: Scrap;
  sellKeys: number;
  sellScrap: Scrap;
  /** PriceDB `time` (unix seconds). */
  time: UnixSec;
  fetchedAt: UnixMs;
}

export interface CommunityRow {
  sku: string;
  currency: 'metal' | 'keys' | 'usd' | string;
  value: number;
  valueHigh: number | null;
  lastUpdate: UnixSec | null;
}

/** Reference prices, already valued in scrap with the current key price. */
export interface ReferencePrices {
  pricedb: { buyScrap: Scrap | null; sellScrap: Scrap | null; time: UnixSec | null; ageMs: number | null } | null;
  community: { valueScrap: Scrap | null; valueHighScrap: Scrap | null; lastUpdate: UnixSec | null } | null;
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type ProfitTier = 'key' | 'ref10' | 'ref2' | 'small' | 'loss' | 'none';
export type OpportunityStatus = 'profitable' | 'below-threshold' | 'unprofitable' | 'no-buyers';
export type InputKind = 'user' | 'import' | 'rule';

export const PROFIT_TIER_LABELS: Record<ProfitTier, string> = {
  key: '1 key or more',
  ref10: '10 ref to 1 key',
  ref2: '2 to 10 ref',
  small: 'Under 2 ref',
  loss: 'Loss',
  none: 'No buyers',
};

export interface OrderSummary {
  listingId: string;
  steamid: string;
  userName: string | null;
  keys: number;
  metalScrap: Scrap;
  valueScrap: Scrap;
  isBot: boolean;
  online: boolean | null;
  lastEventAt: UnixMs;
  bumpedAt: UnixSec | null;
  details: string;
  /** e.g. 'outlier', 'notes-flag', 'attribute-specific', 'has-extras', 'unverified', 'banned', 'marketplace', 'blocklisted' */
  flags: string[];
  /** false when the order is shown for context but excluded from profit. */
  eligible: boolean;
}

export interface Opportunity {
  /** `${sku}|${inputRef}` */
  key: string;
  sku: string;
  name: string;
  category: Category;
  /** 'price:<id>' or 'rule:<id>' */
  inputRef: string;
  inputKind: InputKind;
  costKeys: number;
  costScrapRaw: Scrap;
  /** Total cost valued in scrap with the current key price. */
  costScrap: Scrap;
  bestScrap: Scrap | null;
  consScrap: Scrap | null;
  instantScrap: Scrap | null;
  /** Revenue actually used for profit (per Settings.profit.useOrder). */
  revenueScrap: Scrap | null;
  profitScrap: Scrap | null;
  margin: number | null;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  /** e.g. 'outlier-best', 'has-extras', 'notes-flag', 'unusual-risk', 'stale-input', 'no-reference', 'rule-estimate', 'unverified-orders' */
  flags: string[];
  /** Human-readable explanations of the confidence score. */
  reasons: string[];
  buyerCount: number;
  bestOrder: OrderSummary | null;
  consOrder: OrderSummary | null;
  instantOrder: OrderSummary | null;
  references: ReferencePrices;
  profitTier: ProfitTier;
  status: OpportunityStatus;
  inputObservedAt: UnixMs;
  firstSeenAt: UnixMs;
  updatedAt: UnixMs;
}

export type OpportunityEventKind = 'appeared' | 'changed' | 'gone' | 'notified';

export interface OpportunityEvent {
  id: number;
  key: string;
  sku: string;
  name: string;
  category: Category;
  kind: OpportunityEventKind;
  profitScrap: Scrap | null;
  costScrap: Scrap | null;
  revenueScrap: Scrap | null;
  confidence: number;
  /** Short human-readable description, e.g. "profit 4.33 ref -> 6.11 ref". */
  summary: string;
  ts: UnixMs;
}

export type GroupBy = 'category' | 'tier' | 'confidence' | 'input';

export interface GroupSummary {
  by: GroupBy;
  key: string;
  label: string;
  count: number;
  totalProfitScrap: Scrap;
}

export interface OppQuery {
  status?: OpportunityStatus[];
  categories?: Category[];
  tiers?: ProfitTier[];
  minConfidence?: number;
  inputKinds?: InputKind[];
  search?: string;
  sort?: 'profit' | 'margin' | 'confidence' | 'updated' | 'name';
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  groupBy?: GroupBy;
}

export interface OppListResult {
  rows: Opportunity[];
  total: number;
  groups: GroupSummary[];
  keyPrice: KeyPriceState | null;
  generatedAt: UnixMs;
}

export interface EventQuery {
  limit?: number;
  beforeId?: number;
  /** Rows with a larger id, oldest first (service-internal; not exposed over RPC). */
  afterId?: number;
  sku?: string;
  kinds?: OpportunityEventKind[];
  sinceTs?: UnixMs;
}

// ---------------------------------------------------------------------------
// Item lookup and links
// ---------------------------------------------------------------------------

export interface ItemSuggestion {
  sku: string;
  name: string;
  category: Category;
  source: 'schema' | 'bptf' | 'pricedb';
}

export interface ResolvedItem {
  sku: string;
  name: string;
  skuObject: SkuObject;
  category: Category;
  match: 'sku' | 'exact' | 'fuzzy';
  warnings: string[];
}

export type LinkGroup = 'backpack' | 'market' | 'tools';

export interface LinkSpec {
  id: string;
  label: string;
  url: string;
  group: LinkGroup;
}

/** Everything the link generator needs; built by the service from the schema. */
export interface LinkContext {
  sku: string;
  skuObject: SkuObject;
  /** backpack.tf full name, e.g. "Strange Professional Killstreak Rocket Launcher". */
  fullName: string;
  /** Plain item name without prefixes, e.g. "Rocket Launcher" (backpack.tf `item` parameter). */
  baseName: string;
  marketHashName: string | null;
  effectName: string | null;
  paintkitName: string | null;
  /** Asset id when known (enables the backpack.tf item history link). */
  assetId: string | null;
  /** scrap.tf bank category, when known (enables the link to that static scrap.tf page, opened in the user's browser). */
  category?: Category | null;
}

export interface HistoryPoint {
  t: UnixSec;
  buyScrap: Scrap | null;
  sellScrap: Scrap | null;
}

export interface ItemDetail {
  sku: string;
  name: string;
  category: Category;
  skuObject: SkuObject;
  /** Buy orders, best first, each marked eligible or not with reasons. */
  buyOrders: OrderSummary[];
  /** Sell listings (only stored for watched SKUs unless configured otherwise). */
  sellListings: OrderSummary[];
  references: ReferencePrices;
  scrapPrices: ScrapPrice[];
  opportunities: Opportunity[];
  history: HistoryPoint[];
  links: LinkSpec[];
  snapshot: { lastAt: UnixMs | null; available: boolean; nextAllowedAt: UnixMs | null };
  keyPrice: KeyPriceState | null;
}

// ---------------------------------------------------------------------------
// Saved-page import
// ---------------------------------------------------------------------------

export type ImportPageKind = 'buy' | 'unusuals' | 'items-list' | 'unknown';

export interface ParsedScrapItem {
  title: string;
  sku: string | null;
  skuObject: SkuObject | null;
  name: string;
  costKeys: number;
  costScrap: Scrap;
  special: SpecialAttrs;
  assetId: string | null;
  stock: number | null;
  warnings: string[];
}

export interface ImportResult {
  batchId: number;
  fileName: string;
  pageKind: ImportPageKind;
  parsed: number;
  stored: number;
  skipped: { reason: string; title: string }[];
  warnings: string[];
}

export interface ImportBatch {
  id: number;
  fileName: string;
  pageKind: ImportPageKind;
  fileMtime: UnixMs;
  importedAt: UnixMs;
  itemCount: number;
}

// ---------------------------------------------------------------------------
// Journal (manual trade log with FIFO profit)
// ---------------------------------------------------------------------------

export type JournalSide = 'buy' | 'sell';

export interface JournalEntry {
  id: number;
  ts: UnixMs;
  side: JournalSide;
  venue: string;
  sku: string;
  name: string;
  keys: number;
  scrap: Scrap;
  /** Key price (scrap) used to value this row when it was entered. */
  keyPriceScrap: Scrap;
  note: string | null;
}

export interface JournalInput {
  ts?: UnixMs;
  side: JournalSide;
  venue: string;
  sku: string;
  name?: string;
  keys?: number;
  scrap: Scrap;
  note?: string | null;
}

export interface JournalPosition {
  sku: string;
  name: string;
  qty: number;
  costScrap: Scrap;
}

export interface JournalSummary {
  realizedProfitScrap: Scrap;
  realizedTrades: number;
  open: JournalPosition[];
  bySku: { sku: string; name: string; realizedProfitScrap: Scrap; trades: number }[];
}

// ---------------------------------------------------------------------------
// Health, status, settings
// ---------------------------------------------------------------------------

export type ConnState = 'off' | 'connecting' | 'live' | 'idle' | 'backoff' | 'error' | 'paused' | 'blocked';

export interface ConnectorHealth {
  id: string;
  label: string;
  state: ConnState;
  detail: string;
  lastOkAt: UnixMs | null;
  lastErrorAt: UnixMs | null;
  lastError: string | null;
  /** Set when the connector disabled itself (bad key, challenge page, removed endpoint). */
  disabledReason: string | null;
  /** Host disabled after a challenge page that this connector needs; the user re-enables it with 'net.unblock'. */
  blockedHost?: string | null;
}

export interface HostBudget {
  /** Budget id, e.g. 'bptf-snapshot'. */
  id?: string;
  host: string;
  /** Human description such as "1 per 10 s, 300 per hour". */
  policy: string;
  usedLastHour: number;
  pausedUntil: UnixMs | null;
  consecutive429: number;
}

export interface RequestLogRow {
  ts: UnixMs;
  host: string;
  /** Path and query with secrets redacted. */
  path: string;
  method: string;
  status: number;
  ms: number;
  bytes: number;
  note: string | null;
}

export interface FeedStats {
  enabled: boolean;
  state: ConnState;
  eventsToday: number;
  bytesToday: number;
  capBytes: number;
  lastFrameAt: UnixMs | null;
  listingsTotal: number;
  buyListings: number;
  sellListings: number;
  parseFailures: number;
}

export interface HealthReport {
  connectors: ConnectorHealth[];
  /** Hosts disabled after a challenge page. They stay disabled across restarts until the user re-enables them (R7). */
  blockedHosts?: { host: string; reason: string }[];
  budgets: HostBudget[];
  feed: FeedStats;
  schema: { loadedAt: UnixMs | null; items: number; effects: number; paintkits: number };
  keyPrice: KeyPriceState | null;
  recentRequests: RequestLogRow[];
  db: { path: string; sizeBytes: number };
  engine: { lastRunAt: UnixMs | null; lastRunMs: number | null; evaluated: number };
  /** Stored PriceDB reference prices and when the full list was last loaded. */
  pricedb?: { rows: number; loadedAt: UnixMs | null };
}

/** Codes for AppStatus.setupNeeded; the dashboard shows a checklist item for each. */
export type SetupCode = 'bptf-token' | 'bptf-key' | 'contact-url' | 'first-price';
export const SETUP_CODES: readonly SetupCode[] = ['bptf-token', 'bptf-key', 'contact-url', 'first-price'];

export interface AppStatus {
  version: string;
  networkPaused: boolean;
  feed: ConnState;
  keyPrice: KeyPriceState | null;
  counts: { opportunities: number; profitable: number; highConfidence: number };
  lastEngineRunAt: UnixMs | null;
  /** Things the user still has to do. */
  setupNeeded: SetupCode[];
}

export interface ProfitSettings {
  minProfitScrap: Scrap;
  minProfitPctOfCost: number;
  minMargin: number;
  frictionScrap: Scrap;
  outlierVsMedian: number;
  outlierVsRef: number;
  unusualRiskKeys: number;
  useOrder: 'conservative' | 'best' | 'instant';
  /** Scrap.tf prices older than this are treated as stale. */
  inputStaleMs: number;
  notesKeywords: string[];
}

export interface PermissionRecord {
  grantor: string;
  contact: string;
  grantedAt: string;
  scope: string;
}

export interface Settings {
  /** Shown in the User-Agent so API operators can reach the user. */
  contactUrl: string;
  keyPrice: {
    mode: 'auto' | 'manual';
    manualScrap: Scrap | null;
    /** scrap.tf's own key prices, typed in by the user. Buy = what scrap.tf charges for a key (display only). */
    scraptfBuyScrap: Scrap | null;
    /** What scrap.tf pays for a key; caps the automatic key value (brief §5.3). */
    scraptfSellScrap: Scrap | null;
    scraptfObservedAt: UnixMs | null;
  };
  profit: ProfitSettings;
  /** dailyCapBytes counts decompressed websocket payload bytes (~13 GB/day measured; far less on the wire). */
  liveFeed: { enabled: boolean; dailyCapBytes: number; keepSellListings: 'watched' | 'all' };
  connectors: { bptfApi: boolean; pricedb: boolean; pricedbSocket: boolean; scm: boolean };
  import: {
    enabled: boolean;
    acknowledgedAt: UnixMs | null;
    watchFolder: string | null;
    permission: PermissionRecord | null;
  };
  notifications: { enabled: boolean; minConfidence: number; minProfitScrap: Scrap; dedupMs: number };
  app: { startAtLogin: boolean; startHidden: boolean; closeToTray: boolean; quickEntryHotkey: string };
  networkPaused: boolean;
  /** Steam IDs whose buy orders are never used. */
  blocklist: string[];
  ui: { theme: 'system' | 'dark' | 'light'; density: 'comfortable' | 'compact' };
}

export type SecretName = 'bptfApiKey' | 'bptfAccessToken' | 'steamApiKey';
export const SECRET_NAMES: readonly SecretName[] = ['bptfApiKey', 'bptfAccessToken', 'steamApiKey'];
export type SecretsStatus = Record<SecretName, boolean>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
