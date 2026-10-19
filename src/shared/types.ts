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

/**
 * F15: a scrap.tf page the user saves into the watch folder: the seven bank pages (/buy/<slug> and
 * /unusuals) plus 'list', the scrap.tf/items price list. Labels and URLs: SCRAPTF_BANKS in
 * src/shared/links.ts. Not a Category: 'items' sells taunts and 'other', and 'list' sells everything.
 */
export type ScraptfBank = 'hats' | 'weapons' | 'stranges' | 'killstreaks' | 'skins' | 'items' | 'unusuals' | 'list';

/** Every ScraptfBank in SCRAPTF_BANKS order (the banks page's card order); the repo validates stored values against it. */
export const SCRAPTF_BANK_IDS: readonly ScraptfBank[] = ['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'items', 'unusuals', 'list'];

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
  /**
   * F15: the scrap.tf page this price was imported from (its import batch's ImportBatch.bank), joined
   * in by the repo on every read. null for typed prices and for batches whose page was not recognised
   * (or saved before 0.5); absent on objects not read from the repo. Never written: it follows the batch.
   */
  bank?: ScraptfBank | null;
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

/**
 * scrap.tf's own key prices read from the Mann Co. Supply Crate Key row (5021;6) of the user's
 * saved scrap.tf/items list (F14). Raw scrap: scrap.tf prices a key in metal, so no key price
 * is needed to read it (selectKeyPrice reads it without a cycle).
 */
export interface ScraptfListKey {
  /** What scrap.tf charges for a key ("Price to buy"); settings.keyPrice.scraptfBuyScrap's role. null when sold out. */
  sellsScrap: Scrap | null;
  /** What scrap.tf pays for a key ("Price we pay"); settings.keyPrice.scraptfSellScrap's role (caps the key value). */
  paysScrap: Scrap | null;
  /** The list row's observedAt (the saved file's mtime, else its import time). */
  observedAt: UnixMs;
}

/** The key price currently used to value keys in scrap. */
export interface KeyPriceState {
  valueScrap: Scrap;
  source: KeyPriceSource | 'default';
  observedAt: UnixMs | null;
  stale: boolean;
  quotes: KeyPriceQuote[];
  /**
   * scrap.tf's key prices from the saved /items list (F14), for display ("From your saved scrap.tf
   * list"); null when the list has no key row. Whether they are in use: compare `observedAt` with
   * settings.keyPrice.scraptfObservedAt (the newer of the two supplies the scrap.tf key prices).
   */
  scraptfFromList: ScraptfListKey | null;
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
  /**
   * "Pay up to": the highest scrap.tf cost that would still be 'profitable' against
   * revenueScrap with the current settings.profit (maxCostFor in src/shared/ceiling.ts).
   * Null when there is no revenue or no cost qualifies.
   */
  maxCostScrap: Scrap | null;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  /**
   * e.g. 'outlier-best', 'all-outliers', 'has-extras', 'notes-flag', 'unusual-risk', 'stale-input',
   * 'no-reference', 'rule-estimate', 'unverified-orders', 'background-check',
   * 'stale-reference' (a PriceDB or community price older than profit.referenceMaxAgeMs was ignored),
   * 'suspect-margin' (margin over profit.suspectMargin with few buyers and no usable reference; never notified)
   */
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

// ---------------------------------------------------------------------------
// Shopping list ("pay up to" ceilings to browse scrap.tf against by hand)
// ---------------------------------------------------------------------------

export interface ShoppingQuery {
  categories?: Category[];
  search?: string;
  /** Only rows whose ceiling is at least this much. */
  minCeilingScrap?: Scrap;
  /** Only rows whose revenue order is a bot's. */
  onlyBotBuyers?: boolean;
  /** Omitted: every row (the CSV export relies on this). */
  limit?: number;
  offset?: number;
}

export interface ShoppingRow {
  sku: string;
  name: string;
  category: Category;
  /** scraptfPageFor(category): the static scrap.tf bank page, opened by the user in their browser (never fetched). */
  bankPageUrl: string;
  /** > 0 only. */
  maxCostScrap: Scrap;
  revenueScrap: Scrap;
  revenueOrder: OrderSummary | null;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  buyerCount: number;
  /**
   * A typed/imported scrap.tf cost for this SKU: the chosen row's own when it is typed or imported,
   * otherwise the newest one. Null if only rules match. Painted, spelled and plain copies share a
   * SKU, so this cost is only ever compared with its own row's ceiling (knownMaxCostScrap).
   */
  knownCostScrap: Scrap | null;
  /** The ceiling of the row knownCostScrap comes from; equals maxCostScrap when that row is the chosen one. */
  knownMaxCostScrap: Scrap | null;
  /** knownCostScrap <= knownMaxCostScrap (false when that row has no ceiling); null when knownCostScrap is null. */
  underCeiling: boolean | null;
  inputKinds: InputKind[];
  flags: string[];
  updatedAt: UnixMs;
}

export interface ShoppingListResult {
  rows: ShoppingRow[];
  /** Matching rows before paging. */
  total: number;
  /** Non-empty categories in CATEGORIES order, counted over every match. */
  groups: { category: Category; label: string; count: number; bankPageUrl: string }[];
  keyPrice: KeyPriceState | null;
  generatedAt: UnixMs;
}

// ---------------------------------------------------------------------------
// Live market (F10): every item with backpack.tf buyers or a scrap.tf price of yours
// ---------------------------------------------------------------------------

/**
 * flip: known scrap.tf cost <= maxCostScrap.
 * over: known cost > maxCostScrap (or maxCostScrap null while buyers exist).
 * rule-flip: no known cost, but a matching rule's price <= maxCostScrap.
 * unchecked: no known cost, no rule flip.
 * no-buyers: known cost, but no eligible buy orders.
 */
export type MarketVerdict = 'flip' | 'over' | 'rule-flip' | 'unchecked' | 'no-buyers';
export const MARKET_VERDICTS: readonly MarketVerdict[] = ['flip', 'rule-flip', 'unchecked', 'over', 'no-buyers'];

/** Where the user's scrap.tf side of a row comes from: typed, a saved page (import), or nothing. */
export type MarketSource = 'typed' | 'page' | 'none';
export const MARKET_SOURCES: readonly MarketSource[] = ['page', 'typed', 'none'];

export type MarketSort = 'ceiling' | 'revenue' | 'buyers' | 'profit' | 'updated' | 'name';

export interface MarketQuery {
  search?: string;
  categories?: Category[];
  verdicts?: MarketVerdict[];
  sources?: MarketSource[];
  minCeilingScrap?: Scrap;
  /** Only rows whose revenue order is a bot's. */
  onlyBotBuyers?: boolean;
  minBuyers?: number;
  /** F14: only rows on the user's saved scrap.tf/items list (scraptfListAt not null); marketListSideMatches. */
  onScraptfList?: boolean;
  /**
   * F17: only rows "New on scrap.tf" (scraptfNewAt not null: new in the newest save of a bank);
   * marketNewSideMatches. The Source popover's "New on scrap.tf" (spec S4's source filter 'new').
   */
  newOnScraptf?: boolean;
  /**
   * F20 (optional U5): only rows listed on scrap.tf for at least SCRAPTF_LONG_LISTED_MS (24 h):
   * scraptfListedSince at or before now - 24 h (marketListedSideMatches in src/shared/scraptfHistory.ts).
   */
  listedOnScraptf?: boolean;
  sort?: MarketSort;
  dir?: 'asc' | 'desc';
  /** 1..2000, default 200. The dashboard reads its whole loaded window (≤ 2000 rows) in one call (H2). */
  limit?: number;
  offset?: number;
}

/**
 * F19, MarketRow.scraptfLink: where to look for this item on scrap.tf. That is the bank page the user
 * last saw it on, else its category's bank. The URL is a static allowlisted page, handed to the user's
 * browser through links.open on a click or key press only. It is never fetched (R1) and never built
 * from item data.
 */
export interface MarketScraptfLink {
  /** Never 'list' unless the item is only known from scrap.tf/items. */
  bank: ScraptfBank;
  /** SCRAPTF_BANKS[bank].url (STATIC_EXTERNAL_URLS). */
  url: string;
  /** The newest saved page (bank stock / imported price) that listed this item, else null (category fallback). */
  seenAt: UnixMs | null;
  source: 'seen' | 'category';
}

export interface MarketRow {
  /** Base SKU (no paint). */
  sku: string;
  name: string;
  category: Category;
  revenueScrap: Scrap | null;
  bestScrap: Scrap | null;
  consScrap: Scrap | null;
  instantScrap: Scrap | null;
  revenueOrder: OrderSummary | null;
  buyerCount: number;
  maxCostScrap: Scrap | null;
  /** Buy-side only: buyers and references (a fresh neutral input, no margin guard). */
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  flags: string[];
  /** The user's side. Newest of typed/imported wins; source says which. */
  knownCostScrap: Scrap | null;
  knownSource: MarketSource;
  knownObservedAt: UnixMs | null;
  /** From the saved page when knownSource is 'page'. */
  stock: number | null;
  /** Lowest enabled matching rule price, valued with the current key price. */
  ruleCostScrap: Scrap | null;
  /** revenue - known cost - friction, when both exist. */
  profitScrap: Scrap | null;
  verdict: MarketVerdict;
  /** Newest lastEventAt among the eligible orders. */
  lastOrderChangeAt: UnixMs | null;
  evaluatedAt: UnixMs;
  /**
   * F14, from the user's saved scrap.tf/items list (ScraptfListRow of this base SKU), all null/false
   * when the list has no row: what scrap.tf pays (valued at the current key price), its stock and
   * limit, whether it is full (stock >= limit), and when that list row was saved.
   */
  scraptfPaysScrap: Scrap | null;
  scraptfStock: number | null;
  scraptfStockLimit: number | null;
  scraptfFull: boolean;
  scraptfListAt: UnixMs | null;
  /**
   * F17: the save time (BankStockResult.savedAt) of the newest save of a bank in which this base SKU is
   * 'new' (BankStock.newAtFor; the newest such save when several banks list it), else null. Joined at read
   * time from the bank stock cache, like the list fields; never stored in the index's entries.
   */
  scraptfNewAt: UnixMs | null;
  /**
   * F19: the scrap.tf page the row's "scrap.tf" button opens (scraptfLinkFor in src/shared/links.ts).
   * Joined at read time like the other scraptf* fields; never stored in the index's entries.
   */
  scraptfLink: MarketScraptfLink;
  /**
   * F20: since when the user's saves of the bank it was seen on (scraptfLink's bank, when 'seen') list
   * it on sale without a break (ScraptfHistory.listedSinceFor, any copy of the base SKU); null otherwise.
   * Joined at read time like the other scraptf* fields.
   */
  scraptfListedSince: UnixMs | null;
}

export interface MarketStats {
  entries: number;
  building: boolean;
  /** 0..1 */
  progress: number;
  lastFullAt: UnixMs | null;
  lastChangeAt: UnixMs | null;
  pendingDirty: number;
  /** The last rebuild failed (a local read error); it is retried with backoff. */
  lastError: string | null;
  /** When the next rebuild attempt runs after a failure, else null. */
  retryAt: UnixMs | null;
}

/**
 * One scrap.tf bank page and how recently the user saved it (saved-page import, F13).
 * One entry per SCRAPTF_BANK_PAGES row (src/shared/links.ts), in that order.
 */
export interface ScraptfCoverage {
  /** The page's own category; the items page (taunts, tools, paints) uses 'other'. */
  category: Category;
  label: string;
  /** The static bank page; the user opens it in their own browser, the app never fetches it. */
  url: string;
  /** Newest import of a saved page for this category, or null when never saved. */
  lastSavedAt: UnixMs | null;
  /** Items on that newest saved page. */
  items: number;
}

/**
 * The coverage strip's "All items (scrap.tf/items)" chip (F14). Kept apart from the per-bank-page
 * `coverage` entries (it is not a Category and counts for no bank page; ScraptfCoverage is unchanged).
 */
export interface ScraptfListCoverage {
  /** 'All items' */
  label: string;
  /** SCRAPTF_ITEMS_URL; opened in the user's own browser through links.open, never fetched. */
  url: string;
  /** Newest list row's observedAt (ScraptfListStatus.newestAt), or null when no list was saved. */
  lastSavedAt: UnixMs | null;
  /** List rows stored (ScraptfListStatus.items). */
  items: number;
}

export interface MarketListResult {
  rows: MarketRow[];
  total: number;
  /** Over the query ignoring its own verdicts filter, so the chips show what each would add. */
  counts: Record<MarketVerdict, number>;
  scraptf: {
    typed: number;
    pages: number;
    newestPageAt: UnixMs | null;
    importEnabled: boolean;
    watchFolder: boolean;
    coverage: ScraptfCoverage[];
    /** F14: the saved scrap.tf/items list, shown as the strip's "All items" chip. */
    allItems: ScraptfListCoverage;
  };
  stats: MarketStats;
  keyPrice: KeyPriceState | null;
  generatedAt: UnixMs;
}

// ---------------------------------------------------------------------------
// Holdings (F11): the journal's open lots, priced live against backpack.tf buyers
// ---------------------------------------------------------------------------

/**
 * profitStatus (src/shared/ceiling.ts) of the next lot's profit:
 * sell = 'profitable' (clears the profit thresholds), hold = 'below-threshold' (positive, under them),
 * loss = 'unprofitable' (profit ≤ 0), no-buyers = no exit (no eligible buy order, and no usable scrap.tf
 * list price, F14). Judged on HoldingRow.exitScrap, so a holding can be 'sell' through scrap.tf.
 */
export type HoldingStatus = 'sell' | 'hold' | 'loss' | 'no-buyers';
/** Display and sort order: sellable first. */
export const HOLDING_STATUSES: readonly HoldingStatus[] = ['sell', 'hold', 'loss', 'no-buyers'];

/** Where a held item sells best right now (F14): a backpack.tf buy order, or scrap.tf's bank per the saved /items list. */
export type HoldingExit = 'backpack' | 'scraptf';
/** The journal venue a sale at that exit is recorded under (Record sale prefill). */
export const HOLDING_EXIT_VENUES: Readonly<Record<HoldingExit, string>> = { backpack: 'backpack.tf', scraptf: 'scrap.tf' };

export interface HoldingsQuery {
  /** Words matched against name and SKU, like the Live market search. */
  search?: string;
}

/** One SKU with open journal lots. Money is per unit unless the name says otherwise. */
export interface HoldingRow {
  /** The journal's SKU (may carry paint); the buy side is read for its base SKU. */
  sku: string;
  name: string;
  category: Category;
  qty: number;
  /**
   * All open lots, total. Each lot's keys are valued at today's key price, as the journal will
   * book a sale (keys and metal netted apart), so a key price move alone never reads as profit.
   */
  costScrap: Scrap;
  /** The lot a sale would close (FIFO, oldest), valued like costScrap. */
  nextLotCostScrap: Scrap;
  /** When the oldest open lot was bought. */
  heldSince: UnixMs;
  /** Per-unit revenue from the live book, same math as the market index (useOrder, eligibility, outliers). */
  revenueScrap: Scrap | null;
  bestScrap: Scrap | null;
  instantScrap: Scrap | null;
  revenueOrder: OrderSummary | null;
  bestOrder: OrderSummary | null;
  buyerCount: number;
  /**
   * F14, from the saved scrap.tf/items list row of the base SKU (null/false without one): what
   * scrap.tf pays per unit (valued at the current key price), whether it is full, when the row was saved.
   */
  scraptfPaysScrap: Scrap | null;
  /**
   * The same pays price as the list shows it, keys and metal apart (null without one), so Record sale
   * books what scrap.tf hands over, as the drawer does, instead of re-splitting the value at the key price.
   */
  scraptfPaysKeys: number | null;
  scraptfPaysScrapRaw: Scrap | null;
  scraptfFull: boolean;
  scraptfListAt: UnixMs | null;
  /**
   * The better exit: 'scraptf' when scrap.tf pays more than revenueScrap (or there are no backpack.tf
   * buyers), it is not full and the list row is at most SCRAPTF_LIST_FRESH_MS (24 h) old; else
   * 'backpack' when revenueScrap exists; null when neither. backpack.tf wins a tie.
   */
  bestExit: HoldingExit | null;
  /** Per-unit price at bestExit (revenueScrap or scraptfPaysScrap); what status and profit are judged on. */
  exitScrap: Scrap | null;
  /** HOLDING_EXIT_VENUES[bestExit] ('backpack.tf' / 'scrap.tf'), for the Record sale prefill; null without an exit. */
  exitVenue: string | null;
  /** exitScrap - nextLotCostScrap - friction */
  profitNowScrap: Scrap | null;
  /** exitScrap * qty - costScrap - friction * qty */
  profitAllScrap: Scrap | null;
  /** profitNowScrap / nextLotCostScrap; null without an exit or for a free lot. */
  margin: number | null;
  status: HoldingStatus;
  /** Buy-side confidence, as on the Live market row. */
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  flags: string[];
  /** Newest lastEventAt among the eligible orders. */
  lastOrderChangeAt: UnixMs | null;
}

export interface HoldingsResult {
  /** Matching rows, by status (sell first), then profitNowScrap descending (holdingComparator). */
  rows: HoldingRow[];
  /**
   * Over everything held, whatever the search: items (SKUs), units, cost of all open lots;
   * worthNowScrap (at exitScrap, F14) and profitNowScrap (unrealised P/L, the sum of profitAllScrap)
   * count only rows with an exit; sellable counts rows in status 'sell'.
   */
  totals: { items: number; units: number; costScrap: Scrap; worthNowScrap: Scrap; profitNowScrap: Scrap; sellable: number };
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

/** Revenue for one item from its eligible buy book, priced like the engine does (item.detail). */
export interface ItemRevenue {
  bestScrap: Scrap | null;
  consScrap: Scrap | null;
  instantScrap: Scrap | null;
  useOrder: ProfitSettings['useOrder'];
  /** The one used for profit, per useOrder. */
  revenueScrap: Scrap | null;
  order: OrderSummary | null;
  /** maxCostFor(revenueScrap, settings.profit) */
  maxCostScrap: Scrap | null;
  eligibleCount: number;
}

export interface ItemDetail {
  sku: string;
  name: string;
  /** backpack.tf full name (LinkContext.fullName), for "Copy backpack.tf name". */
  bptfName: string;
  category: Category;
  skuObject: SkuObject;
  /** No eligible orders gives null prices and eligibleCount 0; null only when it could not be computed. */
  revenue: ItemRevenue | null;
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
  /** F14: the base SKU's row of the user's saved scrap.tf/items list (valued at the current key price), or null. */
  scraptfList: ScraptfListRow | null;
  /**
   * F14: "Use as my price" already saved this list row's price (scraptfListPriceSaved over the base SKU's
   * plain rows). A painted SKU's scrapPrices leave that plain copy out, so its drawer reads this instead.
   */
  scraptfListSaved: boolean;
  /**
   * F15: the scrap.tf page the newest imported price of this item came from (ScrapPrice.bank of the
   * newest import-source row of scrapPrices that names a bank; scraptfSeenOn in src/shared/links.ts),
   * its static URL and that price's observedAt. A painted SKU none of whose own prices was imported
   * (scrapPrices holds no imported row) falls back to the base SKU's other copies from bank pages, never
   * the list (itemSeenOn): then it names where another copy was seen, not a price of this item. null when
   * neither names a page. Every "Open bank page" uses it, else bankForCategory(category).
   */
  seenOn: ScraptfSeenOn | null;
  /**
   * F17: the item in the newest bank-stock save that lists it (BankStock.detailFor): which bank, that
   * save's time, its change since the bank's previous save and its stock. null when no kept save lists it.
   */
  bankStock: ItemBankStock | null;
}

/**
 * ItemDetail.bankStock (F17): "On scrap.tf/buy/hats in your save 12 min ago: 3 in stock, new since your
 * previous save", or "↓ cheaper than before (was X)". From pages the user saved; nothing is fetched.
 */
export interface ItemBankStock {
  bank: ScraptfBank;
  /** That save's time (fileMtime, else importedAt). */
  savedAt: UnixMs;
  /** As BankStockRow.change: null when unchanged or when the bank has only one save. */
  change: BankStockChange;
  /** The previous save's price at the current key price, for "was X"; null when it had none. */
  previousCostScrap: Scrap | null;
  /** Stock on that save (null: the page showed none; 0: listed but sold out, e.g. a 'gone' row). */
  stock: number | null;
}

/** ItemDetail.seenOn: where the user last saw an item on scrap.tf (from a page they saved; never fetched). */
export interface ScraptfSeenOn {
  bank: ScraptfBank;
  /** SCRAPTF_BANKS[bank].url: opened in the user's browser through links.open only. */
  url: string;
  /** The price's observedAt (the saved file's time). */
  at: UnixMs;
}

/** backpack.tf ban lookup for one buyer ('buyer.check'; on click only, cached 1 h). */
export interface BuyerCheck {
  steamid: string;
  name: string | null;
  /** null when unknown (error, or no lookup made). */
  bptfBanned: boolean | null;
  /** Human-readable ban lines, e.g. "backpack.tf: all", "SteamRep: scammer". */
  banDetails: string[];
  checkedAt: UnixMs;
  /** True when served from the in-memory cache. */
  cached: boolean;
  /** Why the lookup failed (e.g. 'Add a backpack.tf access token in Settings'); null on success. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Price sheet bulk paste
// ---------------------------------------------------------------------------

/** One parsed line of a bulk paste ('prices.parseBulk'); a preview, nothing is written. */
export interface BulkPriceRow {
  /** 1-based line number in the pasted text. */
  line: number;
  raw: string;
  sku: string | null;
  name: string | null;
  costKeys: number;
  costScrap: Scrap;
  /** Why the line cannot be saved; null when it can. */
  error: string | null;
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
  /**
   * /items list rows only (F14): the "Price we pay" column, what scrap.tf pays the user. null when the
   * cell is empty, "—" or unparsed (with a warning); absent on bank-page cards, which have no such column.
   */
  pays?: { keys: number; scrap: Scrap } | null;
  /** /items list rows only (F14): the limit from the "Item Limits" cell's `title="n/limit"`; absent on cards. */
  stockLimit?: number | null;
}

// ---------------------------------------------------------------------------
// scrap.tf price list (F14): the user's saved copy of scrap.tf/items
// ---------------------------------------------------------------------------

/**
 * One stored row of the scraptf_list table, as the repo reads it (raw keys + metal, nothing valued).
 * Keyed by the canonical base SKU (paint removed): the /items list shows plain copies only.
 */
export interface ScraptfListStored {
  sku: string;
  name: string;
  /** null for a "Sold out" row that shows no price to buy (it still counts: scrap.tf buys it). */
  sellsKeys: number | null;
  sellsScrap: Scrap | null;
  paysKeys: number | null;
  paysScrap: Scrap | null;
  stock: number | null;
  stockLimit: number | null;
  batchId: number;
  /** The saved file's mtime, else its import time. */
  observedAt: UnixMs;
}

/** scrap.tf's price list row for one base SKU, valued with the current key price (spec S3). */
export interface ScraptfListRow {
  sku: string;
  name: string;
  /**
   * What scrap.tf charges ("Price to buy"): keys and metal as listed, then valued. null for a "Sold out"
   * row that shows no price (spec S3 has these non-null; the saved list really omits them, so they may be null).
   */
  sellsKeys: number | null;
  sellsScrapRaw: Scrap | null;
  sellsScrap: Scrap | null;
  /** What scrap.tf pays ("Price we pay"); null when the list showed none. */
  paysKeys: number | null;
  paysScrapRaw: Scrap | null;
  paysScrap: Scrap | null;
  stock: number | null;
  stockLimit: number | null;
  /** scrap.tf is at its limit, so it will not buy more right now (as of the saved list). */
  full: boolean;
  observedAt: UnixMs;
}

/** 'scraptf.listStatus': the saved list as a whole plus the import switches the card needs (U1). */
export interface ScraptfListStatus {
  /** List rows stored. */
  items: number;
  /** Newest / oldest row observedAt; null when empty. */
  newestAt: UnixMs | null;
  oldestAt: UnixMs | null;
  /** Saved list pages behind the rows (distinct import batches; /items may be split into /items/<n>). */
  pages: number;
  /** settings.import.enabled and acknowledged (R10). */
  importEnabled: boolean;
  /** settings.import.watchFolder as configured (the path the card shows and copies). */
  watchFolder: string | null;
  /** The folder watch as it runs: a missing folder or a failed OS watch reads false. */
  watchActive: boolean;
  /** The watcher's last error (shown by the card's "Watch error" state); null when fine or not watching. */
  watchError: string | null;
}

export interface ImportResult {
  batchId: number;
  fileName: string;
  pageKind: ImportPageKind;
  parsed: number;
  stored: number;
  skipped: { reason: string; title: string }[];
  warnings: string[];
  /**
   * F14, saved scrap.tf/items pages only: price list rows this page wrote, out-of-stock rows included
   * (they are skipped as prices but kept on the list). 0 when a newer saved list already had them all.
   */
  listRows?: number;
  /** F15: the scrap.tf page recognised (ImportBatch.bank of `batchId`); null when not recognised. Absent from 0.4 results. */
  bank?: ScraptfBank | null;
  /** F21: how the page reached the import (ImportBatch.origin of `batchId`). Absent: a file. */
  origin?: ImportOrigin;
  /**
   * F21, scrap.tf window reads only: items new on this save that are flips now (BankStock.newFlips of the
   * batch), for the window's status line; 0 on a page's first save (nothing to compare with). Absent for
   * file imports and for window reads that wrote no bank stock (main shows 0 then).
   */
  newFlips?: number;
}

/**
 * F21: how a saved page reached the import. 'file': the file picker or the folder watch (a page the user
 * saved). 'window': a read of the opt-in scrap.tf window (the DOM the user's own browsing loaded); only
 * main sets it. Batches from before 0.7 read null.
 */
export type ImportOrigin = 'file' | 'window';
export const IMPORT_ORIGINS: readonly ImportOrigin[] = ['file', 'window'];

/** Items per category (absent = none). */
export type CategoryCounts = Partial<Record<Category, number>>;

export interface ImportBatch {
  id: number;
  fileName: string;
  pageKind: ImportPageKind;
  fileMtime: UnixMs;
  importedAt: UnixMs;
  itemCount: number;
  /**
   * The items this batch stored, per category, counted when it was imported (the F13 coverage strip
   * classifies the page from it). A later import rewrites matching rows in place under its own batch
   * id, so the price rows cannot say this afterwards. null for batches imported before 0.3.
   */
  categories?: CategoryCounts | null;
  /**
   * F15: the scrap.tf page this batch was saved from, as the parser recognised it (ScrapTfParseResult.bank),
   * fixed at import time (schema V5). null when the page was not recognised and for batches imported
   * before 0.5: coverage then falls back to the majority-category rule (bankPageIndexOf).
   */
  bank: ScraptfBank | null;
  /**
   * F21 (schema V9): 'window' for a read of the scrap.tf window (the Import page labels it "Flip Desk
   * window"), 'file' for a saved file; null for batches imported before 0.7. Optional so callers that
   * predate it store null.
   */
  origin?: ImportOrigin | null;
}

// ---------------------------------------------------------------------------
// scrap.tf banks (F15): one summary per saved scrap.tf page, built from local data only
// ---------------------------------------------------------------------------

/** One of a bank's best flips: an opportunity whose input is an imported price from that bank. */
export interface ScraptfBankFlip {
  sku: string;
  name: string;
  profitScrap: Scrap;
  costScrap: Scrap;
  revenueScrap: Scrap;
  confidenceLevel: ConfidenceLevel;
}

/** An item worth looking for on a bank page: buyers pay well and the user has no scrap.tf price for it yet. */
export interface ScraptfBankLookFor {
  sku: string;
  name: string;
  /** The Live market row's "Pay up to" (> 0). */
  maxCostScrap: Scrap;
  revenueScrap: Scrap;
}

/** 'scraptf.banks': one bank page (or the /items list) and what the user's saved copies of it hold. */
export interface ScraptfBankSummary {
  bank: ScraptfBank;
  /** SCRAPTF_BANKS label and static URL (the user's browser opens it through links.open; never fetched). */
  label: string;
  url: string;
  /** Newest saved page of this bank (fileMtime, else importedAt), null when never saved. */
  lastSavedAt: UnixMs | null;
  /** Saved pages (import batches) of this bank behind its current data. */
  pages: number;
  /** Items on the newest save(s) of this bank, and how many were in stock. */
  items: number;
  inStock: number;
  /** Profitable opportunities whose input is an imported price from this bank, and their summed profit. */
  flips: number;
  flipProfitScrap: Scrap;
  /** Up to 3 of those, most profit first. */
  top: ScraptfBankFlip[];
  /** Live market rows of the categories this bank sells that you have no scrap.tf price for yet: what to look for there. */
  unchecked: number;
  /** Up to 5 of those, highest Pay up to first. */
  lookFor: ScraptfBankLookFor[];
  /**
   * F17: what changed between this bank's two newest kept bank-stock saves (BankStock.whatsNew), for the
   * card's "Since your save 3 h ago: 5 new (2 flips) · 3 gone · 2 cheaper · 1 pricier". null when the bank
   * has fewer than 2 saves (one save: "First save…"; never saved: lastSavedAt is null too).
   */
  whatsNew: ScraptfBankWhatsNew | null;
}

/** ScraptfBankSummary.whatsNew (F17): BankStockResult.counts' change counts, and the previous save's time. */
export interface ScraptfBankWhatsNew {
  new: number;
  /** 'new' rows whose verdict is 'flip' (BankStockResult.counts.newFlips). */
  newFlips: number;
  gone: number;
  cheaper: number;
  pricier: number;
  /** The previous save's time (BankStockResult.previousSavedAt): "Since your save 3 h ago". */
  since: UnixMs | null;
}

// ---------------------------------------------------------------------------
// scrap.tf bank stock (F17): every item on each saved bank page, and what changed between the
// user's two newest saves of it. Snapshots of pages the user saved (R10); nothing is fetched (R1).
// ---------------------------------------------------------------------------

/**
 * A row's change between a bank's newest save and its previous save (matched by SKU + extras key):
 * new: on sale now, absent or not on sale before; gone: on sale before, absent or not on sale now;
 * cheaper / pricier: on sale in both, raw keys + metal differ (direction at the current key price);
 * null: unchanged, or the bank has only one save ("first save": nothing is new).
 * "On sale" = a price to buy and stock null or above 0 (bankStockOnSale in src/shared/bankStock.ts).
 */
export type BankStockChange = 'new' | 'cheaper' | 'pricier' | 'gone' | null;
export const BANK_STOCK_CHANGES: readonly Exclude<BankStockChange, null>[] = ['new', 'cheaper', 'pricier', 'gone'];

/** profitStatus of the row's profit: profitable is 'flip', no revenue 'no-buyers', anything else 'over'. */
export type BankStockVerdict = 'flip' | 'over' | 'no-buyers';

/**
 * F20 adds 'long-listed' (on sale, listed for at least BankStockQuery.minListedMs, default 24 h) and
 * 'dropped' (on sale and cheaper than when its current run of saves began: changeSinceListed below 0).
 */
export type BankStockFilter = 'all' | 'new' | 'flips' | 'changed' | 'gone' | 'long-listed' | 'dropped';
export const BANK_STOCK_FILTERS: readonly BankStockFilter[] = ['all', 'new', 'flips', 'changed', 'gone', 'long-listed', 'dropped'];

/**
 * F20 adds 'listed' (how long it has been listed: listedSince, longest first by default) and 'sinceListed'
 * (changeSinceListed.pct, the biggest drop first by default).
 */
export type BankStockSort = 'profit' | 'margin' | 'cost' | 'name' | 'payUpTo' | 'listed' | 'sinceListed';
export const BANK_STOCK_SORTS: readonly BankStockSort[] = ['profit', 'margin', 'cost', 'name', 'payUpTo', 'listed', 'sinceListed'];

/**
 * One stored bank_stock row (schema V6) as the repo reads it: raw keys + metal, nothing valued.
 * `sku` is the canonical base SKU (paint moved into the extras); `specialKey` is the import's extras
 * key ('' for a clean copy), so painted and spelled copies stay separate rows. A row with no price to
 * buy (a "Sold out" /items row) has costKeys and costScrap null.
 */
export interface BankStockStored {
  sku: string;
  specialKey: string;
  name: string;
  costKeys: number | null;
  costScrap: Scrap | null;
  stock: number | null;
  assetId: string | null;
}

/** One save (import batch) of a bank in bank_stock (Repo.bankStockSaves), newest first. */
export interface BankStockSave {
  batchId: number;
  /** The batch's fileMtime when known, else its importedAt (batchSavedAt). */
  savedAt: UnixMs;
  /** bank_stock rows of this save (every card or row with a SKU, sold out included). */
  items: number;
  /**
   * Which page of the bank it is (bank_stock.page: '/items/2', '/unusuals/378'; '' when not known): a
   * save is only ever compared with an earlier save of the same page.
   */
  page: string;
}

/** One item of a bank's newest save (or, for 'gone', of its previous save), joined to live backpack.tf data. */
export interface BankStockRow {
  /** Canonical base SKU (paint dropped; it is in the extras). The buy side is read for it. */
  sku: string;
  /** `${sku}|${specialKey}` (bankStockKey): unique within a result; React keys, selection. */
  key: string;
  name: string;
  category: Category;
  /** Paint, spells, parts, sheen, killstreaker or a name/description tag: the ceiling is for a clean copy. */
  hasExtras: boolean;
  /** The price as saved (a gone row: its last price, from the previous save), then valued at the current key price. */
  costKeys: number;
  costScrapRaw: Scrap;
  costScrap: Scrap;
  /** Stock on the newest save (null: not shown; a gone row: 0 when still listed sold out, else null). */
  stock: number | null;
  change: BankStockChange;
  /** The previous save's price at the current key price; null without a previous save or price. */
  previousCostScrap: Scrap | null;
  /** The previous save's stock; null without a previous save, or when it showed none. Stock n to m. */
  previousStock: number | null;
  /** From the Live market entry of the base SKU (MarketIndex.entryFor); null / 0 without buyers. */
  revenueScrap: Scrap | null;
  revenueOrder: OrderSummary | null;
  buyerCount: number;
  /** Pay up to (maxCostFor of the revenue). */
  maxCostScrap: Scrap | null;
  /** revenue - cost - friction; null without revenue. */
  profitScrap: Scrap | null;
  /** profit / cost; null without profit or for a free item. */
  margin: number | null;
  verdict: BankStockVerdict;
  /** The market entry's buy-side confidence; null without an entry. */
  confidence: number | null;
  confidenceLevel: ConfidenceLevel | null;
  /**
   * F20: the start of the current unbroken run of this bank's saves that list it on sale (ScraptfKeyRun,
   * from the history of the user's saves); null when the newest save does not list it on sale (a gone row)
   * or no history is known. "Listed 2 d 4 h".
   */
  listedSince: UnixMs | null;
  /** F20: the oldest retained save of this bank listing it on sale; null when unknown. */
  firstSeenAt: UnixMs | null;
  /** F20: the price now against the price when the current run began (raw keys + metal, valued at the current key price); null without a run. */
  changeSinceListed: ScraptfPriceChange | null;
}

/** 'scraptf.bankStock' (and opps.exportCsv kind 'bankStock'). */
export interface BankStockQuery {
  bank: ScraptfBank;
  /** Default 'all': in stock on the newest save. Gone rows come back only with 'gone'. */
  filter?: BankStockFilter;
  /** F20, filter 'long-listed' (and counts.longListed): listed at least this long; default SCRAPTF_LONG_LISTED_MS (24 h). */
  minListedMs?: number;
  /** Words matched against name and SKU, like the Live market search. */
  search?: string;
  /** Default 'profit'. */
  sort?: BankStockSort;
  /** Default desc ('name': asc). Missing values sort last either way. */
  dir?: 'asc' | 'desc';
  /** 1..BANK_STOCK_MAX_LIMIT, default BANK_STOCK_DEFAULT_LIMIT. */
  limit?: number;
  offset?: number;
}

export interface BankStockCounts {
  /** Rows on the newest save (sold out included). */
  items: number;
  /** Of those, on sale (bankStockOnSale): the 'all' chip. */
  inStock: number;
  new: number;
  gone: number;
  cheaper: number;
  pricier: number;
  /** On sale with verdict 'flip'. */
  flips: number;
  /** 'new' with verdict 'flip'. */
  newFlips: number;
  /** F20: the 'long-listed' chip (on sale, listed at least the query's minListedMs). */
  longListed: number;
  /** F20: the 'dropped' chip (on sale, cheaper than when its current run began). */
  dropped: number;
}

export interface BankStockResult {
  bank: ScraptfBank;
  /** SCRAPTF_BANKS label and static URL (opened only through links.open; never fetched). */
  label: string;
  url: string;
  /** The newest save's time; null when the bank has no kept save. */
  savedAt: UnixMs | null;
  /**
   * The previous save's time; null with fewer than 2 saves of a page (no change columns, "first save").
   * With several pages of the bank saved, the earliest such save among them: every change shown is since then.
   */
  previousSavedAt: UnixMs | null;
  /** Kept saves of this bank (at most BANK_STOCK_KEEP_SAVES per page). */
  saves: number;
  /**
   * Pages of the bank the rows come from (/items and /items/2, say: each page's newest save, each compared
   * with its own previous save), and the oldest of those newest saves. Absent with one page.
   */
  pages?: number;
  oldestSavedAt?: UnixMs | null;
  /** Over the whole bank, whatever the filter and search: each chip's count. */
  counts: BankStockCounts;
  /** The page of matching rows, in the query's order. */
  rows: BankStockRow[];
  /** Matching rows before paging. */
  total: number;
  keyPrice: KeyPriceState | null;
  generatedAt: UnixMs;
}

export interface ScraptfBanksResult {
  /** One per SCRAPTF_BANKS entry, in that order (never-saved banks included, with empty data). */
  banks: ScraptfBankSummary[];
  /** settings.import.enabled and acknowledged (R10). */
  importEnabled: boolean;
  /** The folder watch as it runs (ScraptfListStatus.watchActive). */
  watchActive: boolean;
  generatedAt: UnixMs;
}

// ---------------------------------------------------------------------------
// scrap.tf history (F20): the sequence of the user's saves of each bank page, read as price history,
// time listed and a change feed. Only pages the user saved (R10); nothing is fetched (R1). History has
// gaps between saves and only covers pages the user saved.
// ---------------------------------------------------------------------------

/**
 * One change between a page's save and the previous save of that page (scraptfEventsOf, F17's matching
 * and rules): new / gone / cheaper / pricier as diffBankStock decides them, except that a 'new' row the
 * bank listed in an earlier save (sold out, or gone and back) is 'restocked'; 'stock' is a stock count
 * change alone (both counts known, price unchanged).
 */
export type ScraptfChangeKind = 'new' | 'gone' | 'cheaper' | 'pricier' | 'restocked' | 'stock';
export const SCRAPTF_CHANGE_KINDS: readonly ScraptfChangeKind[] = ['new', 'gone', 'cheaper', 'pricier', 'restocked', 'stock'];

/** One scraptf_events row (schema V7) as written at import: raw keys + metal, nothing valued. */
export interface NewScraptfEvent {
  /** The save time of the save that showed the change (its batch's fileMtime, else importedAt). */
  at: UnixMs;
  bank: ScraptfBank;
  /** bank_stock.page of that save ('/buy/hats', '/items/2'; '' when unknown). */
  page: string;
  /** The base SKU (paint in specialKey), as bank_stock.sku. */
  sku: string;
  /** bank_stock.special_key ('' = a clean copy). */
  specialKey: string;
  name: string;
  kind: ScraptfChangeKind;
  /** The previous save's price (null: absent or no price, e.g. 'new'). */
  fromKeys: number | null;
  fromScrap: Scrap | null;
  /** The new save's price (null: absent or no price, e.g. 'gone'). */
  toKeys: number | null;
  toScrap: Scrap | null;
  fromStock: number | null;
  toStock: number | null;
  /** The import batch of the new save. */
  batchId: number;
}

export interface ScraptfEventStored extends NewScraptfEvent {
  /** scraptf_events.id: grows with every write, so 'beforeId' pages the feed. */
  id: number;
}

/**
 * 'scraptf.changes' / ScraptfItemHistory.events: a stored event valued at the current key price and
 * joined to the live backpack.tf side of its base SKU (MarketIndex.entryFor), so a 'cheaper' event that
 * makes a flip shows as one.
 */
export interface ScraptfChangeEvent extends ScraptfEventStored {
  /** bankStockKey(sku, specialKey). */
  key: string;
  /** specialKey is not '' (paint, spells...): Sells for and Pay up to are for a clean copy. */
  hasExtras: boolean;
  /** from/to valued at the current key price; null when that side had no price. */
  fromValueScrap: Scrap | null;
  toValueScrap: Scrap | null;
  /** to - from (both valued now); null unless both sides have a price. */
  deltaScrap: Scrap | null;
  /** delta / from; null unless both sides have a price and from > 0. */
  pct: number | null;
  /** Live backpack.tf revenue (Sells for) and Pay up to of the base SKU now; null without an eligible buyer. */
  revenueScrap: Scrap | null;
  maxCostScrap: Scrap | null;
  /** toValueScrap is at or under maxCostScrap now: the "Flip" pill. */
  flip: boolean;
}

/** 'scraptf.changes' params (zod in rpcHandlers): newest first, paged by id. */
export interface ScraptfChangesQuery {
  bank?: ScraptfBank;
  kinds?: ScraptfChangeKind[];
  /** A SKU; its base SKU's events (every copy) are returned. */
  sku?: string;
  /** Only events with a smaller id ("Load older"). */
  beforeId?: number;
  /** 1..SCRAPTF_CHANGES_MAX_LIMIT (500), default SCRAPTF_CHANGES_DEFAULT_LIMIT (100). */
  limit?: number;
}

/** One retained save of the item's bank that covered it (ScraptfItemHistory.points). */
export interface ScraptfHistoryPoint {
  at: UnixMs;
  bank: ScraptfBank;
  /** The price as saved; 0 when `listed` is false (the chart draws a gap there). */
  costKeys: number;
  costScrapRaw: Scrap;
  /** Valued at the current key price; 0 when `listed` is false. */
  costScrap: Scrap;
  stock: number | null;
  /** On sale on that save (bankStockOnSale). False: absent, sold out or no price. */
  listed: boolean;
}

/** A price then against the price now, both from raw keys + metal valued at the current key price. */
export interface ScraptfPriceChange {
  fromScrap: Scrap;
  toScrap: Scrap;
  /** to - from: below 0 is cheaper now. */
  deltaScrap: Scrap;
  /** delta / from; null when from is 0. */
  pct: number | null;
  /** When the earlier price was saved. */
  since: UnixMs;
}

/** 'scraptf.itemHistory': one copy of an item across the user's retained saves of its bank. */
export interface ScraptfItemHistory {
  /** The base SKU asked for (paint moved into the special key). */
  sku: string;
  /** The special key read ('' = a clean copy). */
  specialKey: string;
  name: string;
  /**
   * The bank the history is read from: the bank whose newest observation lists it (a bank page before the
   * /items list, then the newest), else the one that listed it last; null when no retained save lists it.
   */
  bank: ScraptfBank | null;
  /** Oldest first: one per retained save of that bank that covered the item (listed=false when it did not list it). */
  points: ScraptfHistoryPoint[];
  /** Oldest retained save listing it on sale. */
  firstSeenAt: UnixMs | null;
  /** Start of the current unbroken run of saves listing it (null when the newest save does not list it). */
  listedSince: UnixMs | null;
  lastSeenAt: UnixMs | null;
  /** The newest save, when it lists it on sale. */
  current: { costScrap: Scrap; stock: number | null; bank: ScraptfBank } | null;
  /** Now against the newest save at or before now - 1 h / 24 h / 7 d (null when that save did not list it), and against the run's start. */
  change: { h1: ScraptfPriceChange | null; h24: ScraptfPriceChange | null; d7: ScraptfPriceChange | null; listed: ScraptfPriceChange | null };
  /** This copy's change feed, newest first, at most SCRAPTF_ITEM_EVENTS (50). */
  events: ScraptfChangeEvent[];
  keyPrice: KeyPriceState | null;
  generatedAt: UnixMs;
}

/**
 * The runs index (BankStockRow's listedSince fields, MarketRow.scraptfListedSince): one copy (bankStockKey)
 * of one bank across its retained saves, the bank's pages read together (scraptfRunsOf).
 */
export interface ScraptfKeyRun {
  key: string;
  sku: string;
  specialKey: string;
  /** The first retained save listing it at all (on sale or sold out): S2's "seen before". */
  seenAt: UnixMs;
  /** Oldest / newest retained save listing it on sale; null when never on sale. */
  firstSeenAt: UnixMs | null;
  lastSeenAt: UnixMs | null;
  /** Start of the current run; null when its newest observation is not on sale. */
  listedSince: UnixMs | null;
  /** The raw price on the save that started the current run (changeSinceListed's "from"). */
  runStart: { keys: number; scrap: Scrap } | null;
  /** The raw price on its newest observation, when on sale. */
  current: { keys: number; scrap: Scrap; stock: number | null } | null;
}

// ---------------------------------------------------------------------------
// Live check (F16): copy an item while browsing scrap.tf, see its flip at once.
// The only input is text the user copied (read locally by main) or typed; the
// app never contacts scrap.tf or reads the browser (R1, R3).
// ---------------------------------------------------------------------------

/** item: one TF2 item was resolved; not-item: nothing matched confidently; refused: never parsed (markup, a list, a secret, too long). */
export type CheckStatus = 'item' | 'not-item' | 'refused';
export const CHECK_STATUSES: readonly CheckStatus[] = ['item', 'not-item', 'refused'];

/** Who asked: the check hotkey (clipboard read once), the opt-in clipboard watcher, or text typed or pasted in the dashboard. */
export type CheckSource = 'hotkey' | 'watch' | 'manual';
export const CHECK_SOURCES: readonly CheckSource[] = ['hotkey', 'watch', 'manual'];

/**
 * F19 'check.arm': the item the user opened on scrap.tf from the Live market (or the drawer, or the item
 * menu). Main keeps it in memory for CHECK_ARM_MS, and the hotkey and the watcher then pass `hint` with
 * 'check.text', so a copied price on its own is checked as this item. The name is never logged or stored.
 */
export interface CheckArm {
  /** A SKU (the service's SKU rule; lower-cased). */
  sku: string;
  /** The item name the page copied for scrap.tf's search, at most CHECK_ARM_NAME_MAX characters. */
  name: string;
}

/** F19 'check.text' hint, passed by main only while an arm is unexpired: price-only text is checked as this SKU. */
export interface CheckHint {
  sku: string;
}

/**
 * flip: profitable per profitStatus against the checked price; over: a price and buyers, not profitable;
 * no-buyers: a price but no eligible buy order; no-price: the item is known but has no scrap.tf price
 * (the popup then leads with Pay up to).
 */
export type CheckVerdict = 'flip' | 'over' | 'no-buyers' | 'no-price';

/** Where the compared scrap.tf price came from: the copied text, the saved scrap.tf list, a typed price, an imported page. */
export type CheckPriceSource = 'clipboard' | 'list' | 'typed' | 'import';

export interface CheckPrice {
  keys: number;
  /** The metal part in scrap, as copied or listed (keys not included). */
  scrapRaw: Scrap;
  /** keys valued at CheckResult.keyScrap, plus scrapRaw. */
  valueScrap: Scrap;
  source: CheckPriceSource;
  /** checkedAt for 'clipboard', else the list row's or the stored price's observedAt. */
  observedAt: UnixMs;
}

/** One live check ('check.text'). Holds the resolved item only: the checked text itself is never kept. */
export interface CheckResult {
  /** Increasing per service process: a React key, and how a 'check.done' push matches a 'check.recent' row. */
  id: number;
  status: CheckStatus;
  source: CheckSource;
  /** User-facing, for not-item and refused (and an item note such as "Closest match only"); null otherwise. */
  reason: string | null;
  sku: string | null;
  name: string | null;
  category: Category | null;
  /** The scrap.tf price compared: the copied text first, else the saved scrap.tf list, else the user's newest typed/imported price. */
  price: CheckPrice | null;
  /** From a copied /items row's "we pay" column, else the saved list row (valued at keyScrap). */
  scraptfPaysScrap: Scrap | null;
  stock: number | null;
  stockLimit: number | null;
  /** The saved list row's observedAt when the list supplied price, pays or stock; null otherwise. */
  listAt: UnixMs | null;
  /** As ItemDetail.revenue (best/cons/instant, order, maxCostScrap = Pay up to, eligibleCount); null for non-items. */
  revenue: ItemRevenue | null;
  /** revenue - price - friction; null without both. */
  profitScrap: Scrap | null;
  margin: number | null;
  /** null unless status is 'item'. */
  verdict: CheckVerdict | null;
  /** The Live market entry's buy-side confidence when it has one, else from the revenue order; null for non-items. */
  confidence: number | null;
  confidenceLevel: ConfidenceLevel | null;
  links: LinkSpec[];
  /** The key value the money above was valued at (the engine's), so a popup formats without another call. */
  keyScrap: Scrap | null;
  checkedAt: UnixMs;
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

/** One open buy, not yet matched by a sell. */
export interface JournalLot {
  /** The buy row's id. */
  id: number;
  ts: UnixMs;
  /** Valued at the buy row's own key price. */
  costScrap: Scrap;
  /**
   * The price as paid, keys and metal apart, and the key price that applied. A sale is netted
   * against these per currency (journalSummary), so Holdings values them at today's key price.
   */
  keys: number;
  scrap: Scrap;
  keyPriceScrap: Scrap;
}

export interface JournalPosition {
  sku: string;
  name: string;
  qty: number;
  costScrap: Scrap;
  /** The open lots, oldest first (the next sale closes lots[0]); qty === lots.length. */
  lots: JournalLot[];
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
  /** PriceDB (ageMs) and community (lastUpdate) references older than this are ignored ('stale-reference'). */
  referenceMaxAgeMs: number;
  /** Margin (2 = 200%) above which a row with few buyers and no usable reference is 'suspect-margin'; 0 turns the guard off. */
  suspectMargin: number;
}

/** Settings.check (F16 Live check). */
export interface CheckSettings {
  /** Global accelerator that checks the clipboard once; '' turns it off. Never the quick-entry hotkey. */
  hotkey: string;
  /** Opt-in clipboard watcher (off by default): main polls readText() locally about every 700 ms. */
  watchClipboard: boolean;
  /** The watcher shows a desktop notification for flips (notifications.enabled and silent still apply). */
  notifyFlips: boolean;
  /** Show the check popup window. */
  popup: boolean;
}

/**
 * F21: the opt-in scrap.tf window (settings.scraptfWindow): a window the user browses scrap.tf in
 * themselves, whose loaded page Flip Desk reads (never fetches). Enabling needs import.enabled, the
 * import acknowledgement and `acknowledgedAt` (the settings setter refuses otherwise).
 */
export interface ScraptfWindowSettings {
  /** Default false. */
  enabled: boolean;
  /** When the user ticked the window's risk acknowledgement (scrap.tf's ToS, a possible ban); null = not yet. */
  acknowledgedAt: UnixMs | null;
  /**
   * Default false: an in-memory session, gone when the app quits. True: Chromium's own cookie store on
   * disk (partition 'persist:scraptf', in the app's user data) until "Log out & clear". The app never
   * reads either.
   */
  keepLoggedIn: boolean;
  /**
   * Default true: read after each scrap.tf page load or in-page navigation in the window (the user's browsing,
   * and what the page's own scripts do), with the per-page gap and dedupe; false: only on "Read page now".
   */
  readOnLoad: boolean;
  /** Default false. True: the app's static scrap.tf links (links.open) open in this window, not the browser. */
  openLinksInWindow: boolean;
}

/**
 * F21 push 'scraptfWindow.read' (main only, to the window's toolbar): one read of the page on screen, as
 * the status line shows it ("Read 48 items from /buy/hats · 2 new flips · 3 s ago"). Never page content.
 */
export interface ScraptfWindowRead {
  at: UnixMs;
  /** The page's path, without query or hash ('/buy/hats'). */
  path: string;
  /** Items on the page (ImportResult.parsed). */
  items: number;
  /** The bank the import recognised (ImportResult.bank); null when none. */
  bank: ScraptfBank | null;
  /** ImportResult.newFlips, 0 when absent. */
  newFlips: number;
  /** One short, fixed-text warning (the import's first, or why it imported nothing); null when none. */
  warning: string | null;
}

/** F21 push 'scraptfWindow.nav' (main only, to the toolbar): where the scrap.tf view is. */
export interface ScraptfWindowNav {
  /** The view's URL without query, hash or userinfo (windowDisplayUrl); null when there is none. */
  url: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /**
   * An automatic read of the page on screen is under way: its load snapshot waits for the settle read, so
   * the page is imported once, as its newer snapshot. Absent (the mock, a closed window): false.
   */
  reading?: boolean;
}

/** F21 'scraptfWindow.state': the window as main holds it (a toolbar that loads late asks for it). */
export interface ScraptfWindowState {
  open: boolean;
  /** As ScraptfWindowNav.url. */
  url: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  lastRead: ScraptfWindowRead | null;
}

/** F21 'scraptfWindow.read' (the toolbar's Read page now): the read taken, or why none was (fixed text). */
export interface ScraptfReadOutcome {
  read: ScraptfWindowRead | null;
  reason: string | null;
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
    /**
     * F20 re-save reminders: a desktop notification per bank not saved for this many minutes (0-1440;
     * 0 = off, the default). Only while import is enabled and the network is not paused; never for a
     * bank never saved. The app cannot refresh scrap.tf itself; this only reminds the user to save it.
     */
    resaveReminderMin: number;
    /** F20: the banks reminded of; [] (the default) = every bank saved at least once. */
    resaveBanks: ScraptfBank[];
  };
  notifications: {
    enabled: boolean;
    minConfidence: number;
    minProfitScrap: Scrap;
    dedupMs: number;
    /** Input kinds that may notify; rows of other kinds are never toasted. */
    inputKinds: InputKind[];
    /** Passed to Electron's Notification({ silent }) by main. */
    silent: boolean;
    /** "Sell: <name>" when a held item becomes sellable at a profit (F11). */
    holdings: boolean;
    /** F17: "New on scrap.tf (<Bank>): <name>" when a page the user saved shows new items that are flips. */
    newOnScraptf: boolean;
  };
  app: { startAtLogin: boolean; startHidden: boolean; closeToTray: boolean; quickEntryHotkey: string };
  /** Live check (F16): the check hotkey, the opt-in clipboard watcher and the popup. */
  check: CheckSettings;
  /** F21: the opt-in scrap.tf window. */
  scraptfWindow: ScraptfWindowSettings;
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
