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
  /**
   * 0.9 (#11): backpack.tf's impersonation flag on this user (user.flagImpersonated on the live feed), treated like a
   * ban (the 'impersonator' order flag excludes it). Absent: not flagged or not known (snapshot rows carry no user).
   */
  userImpersonated?: boolean;
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
  /**
   * 0.7.4 (F80), 'prices.upsert' only, with no id: update the user's newest typed price of this copy
   * (priceIsForSku), keeping its extras, asset id and stock, instead of adding a row; adds one when there is
   * none. Quick entry and the check popup's Save price send it, so a re-typed price replaces the last one.
   */
  replaceTyped?: boolean;
}

/** Category-level estimate such as "unique craftable hats cost 1.33 ref on scrap.tf". */
export interface RuleFilter {
  categories?: Category[];
  qualities?: number[];
  craftable?: boolean | null;
  australium?: boolean | null;
  /** 0.7.4 (F79): true = only Festivized copies, false = only copies that are not; unset/null = either. */
  festive?: boolean | null;
  /**
   * 0.7.4 (F79): true = only elevated-Strange copies (a "Strange" on another quality, quality2 11, e.g. a
   * Strange Unusual), false = only copies that are not; unset/null = either.
   */
  elevated?: boolean | null;
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
  /** When the quote was fetched or seen (the 6 h stale gate reads it). */
  observedAt: UnixMs;
  /**
   * 0.7.4 (F71): when the source last changed the price (backpack.tf IGetCurrencies `last_update`, PriceDB's
   * price time; key_prices.price_at). Absent or null: unknown. backpack.tf's is its community price, which can
   * stay unchanged for weeks while the quote is fetched every hour.
   */
  priceAt?: UnixMs | null;
}

/** 0.7.4 (F71): another fresh automatic key quote that differs from the one in use by about 1 ref or more. */
export interface KeyPriceDivergence {
  otherSource: KeyPriceSource;
  /** Its value (buy side first, as the one in use). */
  otherScrap: Scrap;
  /** otherScrap minus the value in use before the scrap.tf cap: positive when the other source values a key higher. */
  deltaScrap: Scrap;
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
  /** 0.7.4 (F71): when the source in use last changed this price (its quote's priceAt); absent or null: unknown. */
  priceAt?: UnixMs | null;
  /** 0.7.4 (F71): another fresh automatic quote disagreeing by about 1 ref or more (never in manual mode); absent or null: none. */
  divergence?: KeyPriceDivergence | null;
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
// 0.9 (history): buy-order persistence, recorded community prices, scrap.tf lows
// ---------------------------------------------------------------------------

/**
 * 0.9 (RESEARCH #6): how a followed buy order's spell at one price ended. 'deleted': the feed deleted the order (it
 * bought an item, or its owner removed it, or it ran out of currency: never known which); 'inactive': the feed reported
 * it not live (an inactive status or archived: FeedBatch.inactive); 'lowered' / 'raised': an update at another price;
 * 'unwatched': Flip Desk stopped seeing the feed (a break, a gap the server reported, a clock moved back, the app
 * closed) while it was still up, so it is censored there, never an end; 'relisted': the feed deleted the order (or
 * reported it inactive) and, within ORDER_SPELL_RELIST_GRACE_MS, sent it again under the same id at the same or a higher
 * price (bots relist; buy-order ids are deterministic), so it was never gone: censored at the delete, and a new spell
 * opens at the new listedAt. 'deleted', 'inactive' and 'lowered' are ends of "still up at its price or higher";
 * 'raised', 'relisted' and 'unwatched' are censored.
 */
export type OrderSpellEnd = 'deleted' | 'inactive' | 'lowered' | 'raised' | 'relisted' | 'unwatched';
/** 0.9 (RESEARCH #6): every OrderSpellEnd, in the order above (the repo reads any other stored text as null). */
export const ORDER_SPELL_ENDS: readonly OrderSpellEnd[] = ['deleted', 'inactive', 'lowered', 'raised', 'relisted', 'unwatched'];

/** 0.9 (RESEARCH #6): one buy order at one price as the live feed showed it (order_spells). No SteamID, listing id or name. */
export interface OrderSpell {
  id: number;
  baseSku: string;
  intent: Intent;
  isBot: boolean;
  /** Raw price as listed (valued per read at the key price then). */
  keys: number;
  metalScrap: Scrap;
  /**
   * backpack.tf's listedAt on the update that opened the spell (Unix s): the order's listing time. A relist (delete and
   * re-create) moves it; a price edit need not (ws-sample's two repriced listings kept theirs, review). Not the time at
   * the current price. Null when the feed gave none.
   */
  listedAt: UnixSec | null;
  /** When Flip Desk first saw the order at this price (the spell's entry). */
  firstSeenAt: UnixMs;
  /** Still up at this price at least until then; for an ended spell, when it ended (deleted / inactive / lowered / raised; relisted: the delete) or was last confirmed (unwatched). */
  lastSeenAt: UnixMs;
  /** null while followed. */
  endAt: UnixMs | null;
  /** null while followed (read as censored at lastSeenAt). */
  endKind: OrderSpellEnd | null;
}

/** 0.9: which followed orders an estimate pools: 'like' (same bot flag, value within ORDER_PERSISTENCE_VALUE_BAND), 'band' (value only), 'all'. */
export type PersistenceScope = 'like' | 'band' | 'all';
/** 0.9: why no estimate: no listedAt on the order; too few followed at its age; too few followed through the window. */
export type PersistenceShort = 'no-listed-time' | 'few-at-risk' | 'past-the-data';

/** 0.9: one horizon of an order's persistence (persistenceWindowOf). */
export interface PersistenceWindow {
  horizonMs: number;
  /** Kaplan-Meier estimate (delayed entry) of still up at its price or higher at age + horizon, given up at age; 0..1. Not a probability of a sale. */
  p: number;
  /** Spells followed just after the order's age (order-price spells: one order can count more than once). */
  atRisk: number;
  /** Fewest spells followed at any point of the window, its end included. */
  minAtRisk: number;
  /** Deleted, inactive or lowered inside the window. */
  ended: number;
}

/** 0.9: one order's persistence (orderPersistenceOf). */
export interface OrderPersistence {
  /** now - listedAt: time since backpack.tf's listing time (a price edit need not reset it), not time at the current price; null without listedAt. */
  ageMs: number | null;
  /** null when no scope passed the shortest horizon. */
  scope: PersistenceScope | null;
  /** The horizons (ORDER_PERSISTENCE_HORIZONS_MS) that passed in `scope`, ascending. */
  windows: PersistenceWindow[];
  /** Why there is no window at all; null when there is one. */
  short: PersistenceShort | null;
}

/** 0.9: the followed spells of an item's book (orderSpellSummaryOf). */
export interface OrderSpellSummary {
  followed: number;
  /** Still followed now (endKind null). */
  open: number;
  deleted: number;
  /** 0.9 (D9): reported not live by the feed (FeedBatch.inactive). */
  inactive: number;
  lowered: number;
  raised: number;
  /** 0.9 (review): deleted then sent again under the same id within the grace, at the same or a higher price (censored). */
  relisted: number;
  unwatched: number;
  /** Spells with no listedAt (counted, never estimated). */
  noListedTime: number;
  /** Oldest firstSeenAt; null with none. */
  since: UnixMs | null;
  /** Sum of lastSeenAt - firstSeenAt. */
  observedMs: number;
}

/** 0.9: one of the drawer's buy orders with its persistence ('item.bookHistory'). */
export interface BookOrderPersistence {
  listingId: string;
  isBot: boolean;
  valueScrap: Scrap;
  listedAt: UnixSec | null;
  persistence: OrderPersistence;
}

/** 0.9 (RESEARCH #7): where a recorded community price came from. */
export type CommunityPointSource = 'prices' | 'feed';

/** 0.9 (RESEARCH #7): one recorded backpack.tf community price (bptf_community_history). A price suggestion bp.tf accepted, never a sale. */
export interface CommunityPoint {
  sku: string;
  source: CommunityPointSource;
  /** Lower case: 'metal', 'keys', 'usd', 'hat'. */
  currency: string;
  value: number;
  valueHigh: number | null;
  /** bp.tf's own time of the price (IGetPrices last_update, the feed's updatedAt; Unix s); null when not given. */
  lastUpdate: UnixSec | null;
  /** When Flip Desk recorded it. */
  recordedAt: UnixMs;
}

/** 0.9: one distinct community price of an item (communityHistoryOf), the sources that reported it joined. */
export interface CommunityHistoryStep {
  /** lastUpdate * 1000, else recordedAt. */
  at: UnixMs;
  currency: string;
  value: number;
  valueHigh: number | null;
  lastUpdate: UnixSec | null;
  /** Sorted, unique. */
  sources: CommunityPointSource[];
  /** First recorded; null for the current IGetPrices row never kept in the history. */
  recordedAt: UnixMs | null;
}

/** 0.9 (RESEARCH #7): an item's recorded community prices as the drawer reads them (communityHistoryOf). Accepted price suggestions, not sales. */
export interface CommunityHistory {
  /** Oldest first, at most COMMUNITY_HISTORY_DETAIL_MAX. */
  steps: CommunityHistoryStep[];
  /** Oldest recordedAt of the stored points; null with none. */
  since: UnixMs | null;
  /** Stored points read (before joining). */
  recorded: number;
}

/** 0.9 (history): 'item.bookHistory'. */
export interface ItemBookHistory {
  /** The base SKU asked for (paint dropped). */
  sku: string;
  /** Every base of its book read (bookBasesOf: the base first). */
  bases: string[];
  summary: OrderSpellSummary;
  /** The asked orders found in the local book as buy orders of this item, in the asked order. */
  orders: BookOrderPersistence[];
  community: CommunityHistory;
  keyScrap: Scrap | null;
  generatedAt: UnixMs;
}

/** 0.9 (history): the lowest on-sale price of one copy in one bank's saves (raw as saved). */
export interface ScraptfLowCore {
  keys: number;
  scrap: Scrap;
  /** First and last save that showed it at that price. */
  firstAt: UnixMs;
  lastAt: UnixMs;
  /** The oldest on-sale sighting the low covers. */
  since: UnixMs;
  /** The newest on-sale sighting (retention). */
  seenAt: UnixMs;
}

/** 0.9 (history): a scraptf_lows row. */
export interface ScraptfLowStored extends ScraptfLowCore {
  bank: ScraptfBank;
  sku: string;
  specialKey: string;
}

/** 0.9 (history): a copy's low as a read shows it (scraptfCopyLowOf), valued at the read's key price. */
export interface ScraptfCopyLow {
  keys: number;
  scrap: Scrap;
  valueScrap: Scrap;
  firstAt: UnixMs;
  lastAt: UnixMs;
  since: UnixMs;
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
  /**
   * 0.9 (#11): the bot service its userAgent.client names (botServiceOf in src/shared/buyerSeen.ts), e.g.
   * 'TF2Autobot (PriceDB)'; absent for a human, an unknown client or the generic 'User Agent'. A label only.
   */
  botService?: string;
  lastEventAt: UnixMs;
  bumpedAt: UnixSec | null;
  details: string;
  /** e.g. 'outlier', 'notes-flag', 'attribute-specific', 'has-extras', 'unverified', 'banned', 'impersonator', 'marketplace', 'blocklisted' */
  flags: string[];
  /** false when the order is shown for context but excluded from profit. */
  eligible: boolean;
}

/** 0.8 (PC-1): what a buy decision's profit takes off the sale price (exitCostsOf in src/shared/ceiling.ts). */
export interface ExitCosts {
  /** profit.frictionScrap as applied (frictionOf: negative or non-finite is 0). */
  frictionScrap: Scrap;
  /** The price-move reserve: ceil(revenue x reservePct); 0 without a revenue or a reserve. */
  reserveScrap: Scrap;
  /** profit.exitReservePct as applied (reservePctOf). */
  reservePct: number;
  /** frictionScrap + reserveScrap. */
  totalScrap: Scrap;
}

/** 0.9 (#2): which cost a break-even price is judged for (breakEvenFor in src/shared/ceiling.ts). */
export type BreakEvenMode = 'buy' | 'sell';

/**
 * 0.9 (#2): the lowest sale prices at which a flip ('buy': the scrap.tf price, friction and the price-move reserve)
 * or the oldest held unit ('sell': its cost and friction, R-PC1-sell) loses nothing, per exit (breakEvensOf in
 * src/shared/ceiling.ts). backpack.tf is exact in whole scrap. marketplace.tf and mannco.store pay cash and the Steam
 * Market Steam Wallet funds, which Flip Desk does not convert: theirs are the value a sale must bring in before the
 * venue's fee, at the user's own key value (their 1-cent minimums aside). A price to clear, never a forecast.
 */
export interface BreakEvens {
  mode: BreakEvenMode;
  /** The cost judged: the scrap.tf price ('buy') or the oldest unit's cost at today's key price ('sell'). */
  costScrap: Scrap;
  /** frictionOf(settings.profit). Readers destructure it (profitPath rule (1), D7). */
  frictionScrap: Scrap;
  /** 'buy': reserveOf(backpackScrap) (0 without a reserve); 'sell': 0. */
  reserveScrap: Scrap;
  /** 'buy': reservePctOf(settings.profit); 'sell': 0. */
  reservePct: number;
  /** backpack.tf (no platform fee): the smallest whole-scrap sale price with profit >= 0. */
  backpackScrap: Scrap;
  /** marketplaceFeePctOf(settings.profit): the marketplace.tf fee as applied. */
  marketplaceFeePct: number;
  /** marketplace.tf: grossBeforeFee(backpackScrap, marketplaceFeePct). */
  marketplaceScrap: Scrap;
  /** mannco.store: grossBeforeFee(backpackScrap, 5%). */
  manncoScrap: Scrap;
  /** Steam Community Market, as wallet value: scmGrossValue(backpackScrap), what the buyer pays before 5% + 10%. */
  scmScrap: Scrap;
}

/**
 * 0.8 (PC-2, H2): the best other buyer if the revenue order's buyer fills or withdraws (buyerDepthOf in
 * src/shared/ceiling.ts): another SteamID, not an outlier, a verified one when there is one.
 */
export interface NextBuyer {
  valueScrap: Scrap;
  /** Their order's keys and metal as listed. */
  keys: number;
  metalScrap: Scrap;
  isBot: boolean;
  /** As OrderSummary.online / lastEventAt, for buyerPresenceText. */
  online: boolean | null;
  lastEventAt: UnixMs;
  /** No verified other buyer is left: this is the best unverified one (not seen for 24 h). */
  unverified: boolean;
}

/** 0.8 (PC-2): a flip only the revenue order's buyer makes (singleExitOf in src/shared/ceiling.ts). */
export interface SingleExit {
  /** The best other buyer; null when there is none. */
  next: NextBuyer | null;
  /** flipProfit(next.valueScrap, cost, settings.profit); null without a next buyer. */
  nextProfitScrap: Scrap | null;
}

/**
 * 0.9 (#3): the book-depth tag (liquidityTagOf in src/shared/exitRisk.ts) from the distinct buyers seen in the last
 * 24 h with a usable order at any price: 0 'none', 1 'one', 2-4 'few', 5 or more 'many'. Demand, not sales.
 */
export type LiquidityTag = 'none' | 'one' | 'few' | 'many';
/** 0.9 (#3): every LiquidityTag, fewest buyers first (the CSV's book_depth_tag values). */
export const LIQUIDITY_TAGS: readonly LiquidityTag[] = ['none', 'one', 'few', 'many'];

export interface Opportunity {
  /** `${sku}|${inputRef}` */
  key: string;
  sku: string;
  name: string;
  category: Category;
  /** 'price:<id>' or 'rule:<id>' */
  inputRef: string;
  inputKind: InputKind;
  /**
   * 0.7.4 (F66): which copy the input prices: its bank_stock special key (opportunityCopyKey in
   * src/shared/copyExtras.ts: paint, spells, parts, sheen, killstreaker, tags), '' for a plain copy and rules.
   * Derived at read time from the input's price row (no stored column); absent on older objects (plain).
   */
  copyKey?: string;
  /** 0.8 (T4/T7): for an 'import' input, the verdict of the copy it prices (copyKey) in the bank its history is read from (scraptfCopyBankOf), joined by 'opps.list' at read time, never stored; absent otherwise. */
  timing?: ScraptfTimingBrief;
  costKeys: number;
  costScrapRaw: Scrap;
  /** Total cost valued in scrap with the current key price. */
  costScrap: Scrap;
  bestScrap: Scrap | null;
  consScrap: Scrap | null;
  instantScrap: Scrap | null;
  /** Revenue actually used for profit (per Settings.profit.useOrder). */
  revenueScrap: Scrap | null;
  /** flipProfit(revenue, cost, settings.profit) (0.8: friction and the price-move reserve taken off); null without revenue. */
  profitScrap: Scrap | null;
  margin: number | null;
  /**
   * "Pay up to": the highest scrap.tf cost that would still be 'profitable' against
   * revenueScrap with the current settings.profit (maxCostFor in src/shared/ceiling.ts).
   * Null when there is no revenue or no cost qualifies.
   */
  maxCostScrap: Scrap | null;
  /**
   * 0.9 (#3): "If this buyer leaves": flipProfit at the best other buyer seen in the last 24 h (buyerDepthOf's verified
   * pick; exitRiskAt in src/shared/exitRisk.ts). Absent when there is no such buyer or no revenue order, and on a row
   * stored before V16 until the engine's next full sweep rewrites it.
   */
  backupProfitScrap?: Scrap;
  /**
   * 0.9 (#3): "Buyers at break-even": distinct buyers seen in the last 24 h whose best usable order (eligible, not an
   * outlier, worth more than 0, a bot under Instant) clears break-even at costScrap (flipProfit >= 0: friction and the
   * price-move reserve taken off), at most EXIT_DEPTH_CAP (20). Absent on a row stored before V16.
   */
  profitableDepth?: number;
  /** 0.9 (#3): distinct buyers seen in the last 24 h with a usable order at any price (the book-depth tag). Absent before V16. */
  bookDepth?: number;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  /**
   * e.g. 'outlier-best', 'all-outliers', 'has-extras', 'notes-flag', 'unusual-risk', 'stale-input',
   * 'no-reference', 'rule-estimate', 'unverified-orders', 'background-check',
   * 'stale-reference' (a PriceDB or community price older than profit.referenceMaxAgeMs was ignored),
   * 'suspect-margin' (margin over profit.suspectMargin with few buyers and no usable reference; never notified),
   * 0.7.4 (costSanity in src/shared/ceiling.ts; capped at Low, never notified): 'variant-suspect' (the cost is
   * under 0.9x the item's own PriceDB band and within 10% of its craftability twin's), 'cost-below-market'
   * (the cost is under 0.95x the item's own PriceDB buy price, by 1 ref or more),
   * 0.7.4 (F78) 'rule-under-scraptf' (a rule row priced at what scrap.tf showed, above the rule's cost),
   * 0.7.4 (F27, F33) 'shared-buyer' (another copy of the SKU sells to the same revenue order for as much or
   * more: the totals count that order once),
   * 0.8 (PC-2) 'single-exit' (only the revenue order's buyer clears the thresholds at this cost: singleExitOf; a
   * warning, never notified differently, the score unchanged)
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

/**
 * 0.9 (#3): the Opportunities sorts. 'backup' is "If this buyer leaves" (Opportunity.backupProfitScrap), 'depth' is
 * "Buyers at break-even" (Opportunity.profitableDepth). Both default to descending; missing values sort last (repo
 * OPP_SORT, oppModel compareOpps).
 */
export type OppSort = 'profit' | 'backup' | 'depth' | 'margin' | 'confidence' | 'updated' | 'name';
/** 0.9 (#3): every OppSort, in the Sort select's order (the 'opps.list' zod reads it). */
export const OPP_SORTS: readonly OppSort[] = ['profit', 'backup', 'depth', 'margin', 'confidence', 'updated', 'name'];

export interface OppQuery {
  status?: OpportunityStatus[];
  categories?: Category[];
  tiers?: ProfitTier[];
  minConfidence?: number;
  inputKinds?: InputKind[];
  search?: string;
  sort?: OppSort;
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
  /**
   * The static scrap.tf bank page, opened by the user in their browser (never fetched). 0.7.4 (F36): the bank
   * page a save last listed the item on, else the bank an item of its kind is sold on (a strange cosmetic on
   * /buy/hats), else scraptfPageFor(category).
   */
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
  /**
   * 0.7.1 (ACT-9): when the price knownCostScrap comes from was observed (the known opportunity's
   * inputObservedAt), its stock on that save, and whether it is older than profit.inputStaleMs. Absent
   * (older services, the mock until filled): shown as before, and the row counts as fresh.
   */
  knownObservedAt?: UnixMs | null;
  knownStock?: number | null;
  knownStale?: boolean;
  /**
   * 0.7.4 (F22, F70): the known price's opportunity is flagged 'variant-suspect' or 'cost-below-market' (far
   * under this item's own PriceDB price: probably another copy's price). Like a stale one, it is shown but not
   * counted as at or under the ceiling. Absent: not suspect.
   */
  knownSuspect?: boolean;
}

export interface ShoppingListResult {
  rows: ShoppingRow[];
  /** Matching rows before paging. */
  total: number;
  /** Non-empty categories in CATEGORIES order, counted over every match. */
  /**
   * 0.7.4 (F36): `mixedBanks` true when the group's rows open more than one bank page (each row then links its
   * own, and bankPageUrl is only the category's); absent when every row opens bankPageUrl.
   */
  groups: { category: Category; label: string; count: number; bankPageUrl: string; mixedBanks?: boolean }[];
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

/**
 * 'seen' (0.7.1): when the user's own price was observed (knownObservedAt), freshest first; ties by profit. 0.9 (#3):
 * 'backup' (MarketRow.backupProfitScrap) and 'depth' (MarketRow.profitableDepth), missing last.
 */
export type MarketSort = 'ceiling' | 'revenue' | 'buyers' | 'profit' | 'backup' | 'depth' | 'updated' | 'name' | 'seen';

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
  /** flipProfit(revenue, known cost, settings.profit), when both exist. */
  profitScrap: Scrap | null;
  /** 0.9 (#3): as Opportunity.backupProfitScrap at marketRiskCost (your price, else a rule flip's estimate); absent: none, no such price, or no book. */
  backupProfitScrap?: Scrap;
  /** 0.9 (#3): as Opportunity.profitableDepth at marketRiskCost; null: no price to judge (no price of yours and no rule flip); absent: no book. */
  profitableDepth?: number | null;
  /** 0.9 (#3): as Opportunity.bookDepth; absent: no book (a known-only row). */
  bookDepth?: number;
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
   * 0.7.4: that row is a family row (SCRAPTF_LIST_FAMILY_LABEL: one row for every copy at its price, or read
   * for a copy with no row of its own), so its stock counts every copy; absent otherwise (marketListFields).
   */
  scraptfListFamily?: true;
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
   * 0.7.4 (R26): with scraptfLink on the /items list only, the bank page an item of its kind is sold on
   * (scraptfBankForItem: a strange cosmetic's is 'hats'), so the banks' "What to look for" puts the row on
   * the card MarketIndex.bankFor and the Shopping list send it to. Absent for any other link.
   */
  kindBank?: Exclude<ScraptfBank, 'list'>;
  /**
   * F20: since when the user's saves of the bank it was seen on (scraptfLink's bank, when 'seen') list
   * it on sale without a break (ScraptfHistory.listedSinceFor, any copy of the base SKU); null otherwise.
   * Joined at read time like the other scraptf* fields.
   */
  scraptfListedSince: UnixMs | null;
  /**
   * 0.7.1 (DM-5): the newest save that still listed it on sale in the run scraptfListedSince starts, so a
   * run whose last sighting is old is not read as current. Absent or null: unknown (shown as before).
   */
  scraptfLastSeenAt?: UnixMs | null;
  /** 0.8 (T4/T7): the verdict of the copy scraptfListedSince reads (same bank, same run pick), joined at read time by market.list only (not the CSV, not the banks cards); absent otherwise. */
  scraptfTiming?: ScraptfTimingBrief;
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
  /**
   * 0.7.4 (R23): that lot's own keys and metal (0.8: price plus the buy's recorded fee; absent for a lot without
   * them), so Record sale can value a backfilled sale against it at the key price then, the way the journal books
   * the pair.
   */
  nextLotKeys?: number;
  nextLotScrapRaw?: Scrap;
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
   * 0.8 (PC-2, H2): the best other buyer if the revenue order's buyer fills or withdraws (the market entry's
   * nextBuyer); null with none. Absent when the buy side carries no depth (no buy side, or an older service).
   */
  nextBuyer?: NextBuyer | null;
  /** 0.8 (H2): distinct buyers with an eligible order seen in the last 24 h (not 'unverified'); absent as nextBuyer. */
  verifiedBuyerCount?: number;
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
   * 0.7.4: the list row is a family row (one row for every copy at its price, or read for a copy with no
   * row of its own): a scrap.tf exit from it is labelled so; absent otherwise (holdingListFields).
   */
  scraptfListFamily?: true;
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
  /** 0.8 (H5): the user's typical hold for this SKU (typicalHoldOf, src/shared/journal.ts); absent with too few sales. */
  typicalHold?: TypicalHold;
  /**
   * 0.8 (H6): the next lot's key price when it was bought (JournalLot.keyPriceScrap), with nextLotKeys and
   * nextLotScrapRaw; the advice's key-exposure reason reads it. Absent for a lot without its currencies.
   */
  nextLotKeyPriceScrap?: Scrap;
  /** 0.8 (H3): what other sellers ask for this copy on backpack.tf (askSideOf); null without a counted ask. */
  ask?: HoldingAskSide | null;
  /** 0.8 (H4): the base SKU's usable reference prices (holdingRefsOf); null when none is stored. Context, never a sale price. */
  refs?: HoldingRefs | null;
  /** 0.8 (H6): the base SKU's last backpack.tf snapshot (repo.getSnapshotAt; the mock's book.snapshotAt); null: never. */
  snapshotAt?: UnixMs | null;
  /** 0.8 (H6): Sell now / List and wait / Hold / No clear signal, with dated reasons (holdingAdvice). Never a forecast. */
  advice?: HoldingAdvice;
  /**
   * 0.9 (#1): with Settings.tradeLock.mode '7d', the units still inside Steam's 7-day trade lock, counted from each buy's
   * journal time (holdingTradeLockOf); absent with another mode or when no unit is locked. Never changes a price or a profit.
   */
  tradeLock?: HoldingTradeLock;
}

export interface HoldingsResult {
  /** Matching rows, by status (sell first), then profitNowScrap descending (holdingComparator). */
  rows: HoldingRow[];
  /**
   * Over everything held, whatever the search: items (SKUs), units, cost of all open lots;
   * worthNowScrap (at exitScrap, F14) and profitNowScrap (unrealised P/L, the sum of profitAllScrap)
   * count only rows with an exit; sellable counts rows in status 'sell'. 0.9 (#1): with a 7-day trade lock,
   * `sellable` leaves out and `locked` counts (absent at 0) the items whose next unit is still locked.
   */
  totals: { items: number; units: number; costScrap: Scrap; worthNowScrap: Scrap; profitNowScrap: Scrap; sellable: number; locked?: number };
  keyPrice: KeyPriceState | null;
  generatedAt: UnixMs;
}

// ---------------------------------------------------------------------------
// 0.8 Holdings: asks, references, recorded exits and advice (H1, H3, H4, H6, H7)
// ---------------------------------------------------------------------------

/**
 * 0.8 (H3, PC-7): what other sellers ask for the same copy on backpack.tf, from the sell listings kept for
 * watched items (liveFeed.keepSellListings): each seller's lowest ask, not marketplace.tf, banned or
 * blocklisted, seen within ORDER_UNVERIFIED_AFTER_MS, and not one of settings.ownSteamIds. A copy matches when
 * its paint is the held one (none for a clean copy) and it has no spells, parts, custom name or description;
 * sheen and killstreaker are free (the journal SKU does not record them). An ask is what a seller wants, never
 * a price paid; backpack.tf shows no completed sales.
 */
export interface HoldingAskSide {
  /** The lowest counted ask, valued at the key price the row is valued at, and as listed. */
  lowestScrap: Scrap;
  lowestKeys: number;
  lowestMetalScrap: Scrap;
  lowestIsBot: boolean;
  /** When that listing was last seen (feed event or snapshot). */
  lowestSeenAt: UnixMs;
  /** Distinct sellers counted, and how many of them list through a bot (usually autoprices from the same book). */
  count: number;
  botCount: number;
  /** Listings left out as the user's own (settings.ownSteamIds). */
  ownLeftOut: number;
  /** settings.ownSteamIds is empty: the lowest ask may be the user's own listing. */
  mayIncludeOwn: boolean;
}

/** 0.8 (H4): a held base SKU's usable reference prices (age-gated like the engine's, F4), valued at the current key price. */
export interface HoldingRefs {
  pricedbBuyScrap: Scrap | null;
  pricedbSellScrap: Scrap | null;
  /** PriceDB's age at read time; null when unknown or left out. */
  pricedbAgeMs: number | null;
  communityScrap: Scrap | null;
  communityHighScrap: Scrap | null;
  /** One reason per reference left out for its age ("PriceDB price is 400 days old, ignored"), usableReferences' words. */
  ignored: string[];
}

/** 0.9 (#1) HoldingRow.tradeLock: the open lots still inside the 7-day lock at the read. */
export interface HoldingTradeLock {
  /** Open units whose buy is less than TRADE_LOCK_MS old. */
  lockedQty: number;
  /** When the next lot (the one a sale closes, lots[0]) becomes tradable; null when it already is. */
  nextLotTradableAt: UnixMs | null;
  /** The earliest time a locked unit becomes tradable (equals nextLotTradableAt when that one is locked). */
  firstTradableAt: UnixMs;
}

/**
 * 0.8 (H1): one recorded run of a held or watched base SKU's exits (holding_marks, schema V15): the same values
 * seen from fromAt to toAt while the backpack.tf live feed was up. Raw keys and metal, valued per read at the
 * current key price, so a key price move alone never reads as a price move. A side with nothing reads null for
 * both of its numbers. Only data the app already had: the live book, the kept sell listings, the saved list.
 */
export interface HoldingMark {
  id: number;
  baseSku: string;
  fromAt: UnixMs;
  toAt: UnixMs;
  /** The revenue order per profit.useOrder at the time, whether it is a bot's, and whether it was seen within 24 h. */
  revKeys: number | null;
  revMetalScrap: Scrap | null;
  revIsBot: boolean | null;
  revVerified: boolean | null;
  /** The highest eligible order. */
  bestKeys: number | null;
  bestMetalScrap: Scrap | null;
  /** The next distinct buyer (PC-2/H2); null without one. */
  nextKeys: number | null;
  nextMetalScrap: Scrap | null;
  /** The latest buyer count seen in the run (updated when it is extended; a count change alone starts no run). */
  buyerCount: number;
  /** Distinct buyers seen within 24 h (PC-2/H2), the latest seen in the run; null when not known. */
  verifiedBuyerCount: number | null;
  /** The lowest matching ask of a clean copy (H3); askCount is its seller count, the latest seen in the run. */
  askKeys: number | null;
  askMetalScrap: Scrap | null;
  askCount: number | null;
  /** What scrap.tf pays per the saved list, only while that row was fresh and not full. */
  scraptfPaysKeys: number | null;
  scraptfPaysScrap: Scrap | null;
  /** The key price when the run began: context only (reads value runs at today's); null when it was not known. */
  keyScrap: Scrap | null;
}

/**
 * What one check saw for a base: every field but the id, base, times and key price. Two runs are the same when
 * their prices are (sameHoldingMarkValues over HOLDING_MARK_VALUE_KEYS, which leaves the three counts out).
 */
export type HoldingMarkValues = Omit<HoldingMark, 'id' | 'baseSku' | 'fromAt' | 'toAt' | 'keyScrap'>;

/** 0.8 (H6): the recorded exit's movement over a holding; built only from runs, never extrapolated. */
export interface HoldingTrend {
  highScrap: Scrap;
  /** The last time the exit was seen at highScrap (that run's toAt). */
  highAt: UnixMs;
  lowScrap: Scrap;
  lowAt: UnixMs;
  /** The first counted run's exit. */
  firstScrap: Scrap;
  /** The newest counted run's exit; null when it had none. */
  lastScrap: Scrap | null;
  /**
   * The highest exit seen within HOLDING_RECENT_HIGH_MS of now (and since the holding began), over runs lasting at
   * least HOLDING_RECENT_HIGH_MIN_RUN_MS; null without one.
   */
  recentHighScrap: Scrap | null;
  recentHighAt: UnixMs | null;
  /** Which source gave recentHighScrap: the revenue order ('backpack') or scrap.tf's recorded pays price ('scraptf'). */
  recentHighFrom: 'backpack' | 'scraptf' | null;
  /**
   * fromAt of the newest counted run whose exit differs from the one before it, among runs observing the same
   * sources (markExitSources); null when it never changed.
   */
  lastChangeAt: UnixMs | null;
  /** 'falling' / 'rising' only when the last 3 changes all went that way; otherwise 'mixed'. */
  direction: 'falling' | 'rising' | 'mixed';
  /** With a direction: the exit before those 3 changes, the newest, and when the first of the 3 was seen. */
  streak: { fromScrap: Scrap; toScrap: Scrap; sinceAt: UnixMs } | null;
  /** 0.9 (#17): how big the recorded move is (holdingExitHistory); absent with too few stretches. Measured, never a forecast. */
  size?: HoldingTrendSize;
}

/**
 * 0.9 (#17): a Theil-Sen line (median of pairwise slopes) through the newest HOLDING_TREND_SIZE_MAX_POINTS stretches with an
 * exit that observed the same sources as the newest one, each at its midpoint (clamped to the holding and now).
 */
export interface HoldingTrendSize {
  /** The line's slope, scrap per day (unrounded). */
  slopeScrapPerDay: number;
  /** The line's change from the first to the last point: round(slope x span). 0: level. */
  changeScrap: Scrap;
  /** Median absolute residual about the line (the MAD, as the line's intercept is the median): half the points sat within ± this. */
  spreadScrap: Scrap;
  /** Points (stretches) it rests on. */
  points: number;
  /** The first and last point's time (stretch midpoints). */
  fromAt: UnixMs;
  toAt: UnixMs;
}

/** 0.8 (H6): the recorded runs behind a holding (holdingExitHistory). */
export interface HoldingExitHistory {
  /**
   * Counted runs since the holding began: consecutive runs at one exit split only on a value the exit does not read
   * are one (holdingExitHistory); runs shorter than HOLDING_MARK_MIN_RUN_MS left out, the newest always counted.
   */
  runs: number;
  /** Their observed time since the holding began; gaps (app closed, feed off) are not counted. */
  observedMs: number;
  /** The first counted run's start, clamped to the holding's start (or settingsAt); null with none. */
  firstAt: UnixMs | null;
  /** Null unless HOLDING_TREND_MIN_RUNS runs with an exit, two different exits and HOLDING_TREND_MIN_OBSERVED_MS observed. */
  trend: HoldingTrend | null;
  /**
   * Set when the buyer settings (holdingMarkSettingsKey: blocklist, revenue order, outlier and notes rules) changed
   * after the holding began: the history starts there, as runs recorded before it priced other buyers.
   */
  settingsAt?: UnixMs;
}

/** 0.8 (H6): what a holding's advice says: Sell now, List and wait, Hold, or No clear signal. Never a forecast. */
export type HoldingAdviceKind = 'sell-now' | 'list' | 'hold' | 'unclear' | 'locked';
/** Display order of the advice kinds. 0.9 (#1): 'locked' only with a 7-day trade lock. */
export const HOLDING_ADVICE_KINDS: readonly HoldingAdviceKind[] = ['sell-now', 'list', 'hold', 'unclear', 'locked'];

/**
 * 0.8 (H6): one reason behind a piece of advice: an observed fact with its numbers and dates, worded by the
 * dashboard (holdingsModel.adviceReasonText). Deciding codes first, then supporting and context codes.
 */
export type HoldingAdviceReason =
  | { code: 'clears-target'; profitScrap: Scrap; overScrap: Scrap; exit: HoldingExit }
  | { code: 'scraptf-instead'; paysScrap: Scrap; profitScrap: Scrap; listAt: UnixMs }
  | { code: 'unverified-exit'; seenAt: UnixMs | null }
  | { code: 'list-beats-sale'; listScrap: Scrap; askScrap: Scrap; gainScrap: Scrap; sellers: number; bots: number; mayIncludeOwn: boolean }
  | { code: 'list-clears'; listScrap: Scrap; askScrap: Scrap; profitScrap: Scrap; sellers: number; bots: number; mayIncludeOwn: boolean }
  | { code: 'list-no-buyer'; listScrap: Scrap; askScrap: Scrap; profitScrap: Scrap; sellers: number; bots: number; mayIncludeOwn: boolean }
  | { code: 'asks-below-cost'; askScrap: Scrap; sellers: number }
  | { code: 'no-exit' }
  | { code: 'recorded-high'; exitScrap: Scrap; at: UnixMs; runs: number; firstAt: UnixMs }
  | { code: 'reference-above'; pricedbBuyScrap: Scrap; ageMs: number | null }
  | {
      code: 'below-target';
      profitScrap: Scrap;
      minScrap: Scrap;
      /**
       * HoldingExitHistory.settingsAt when below target decides 'sell-now' on a trend whose history starts there: the
       * exits it checked are only those recorded since the buyer settings changed (without a trend no-history says so).
       */
      settingsAt?: UnixMs;
    }
  | { code: 'loss'; profitScrap: Scrap }
  | { code: 'refresh-first'; why: 'unverified-order' | 'idle-book'; seenAt: UnixMs | null }
  | { code: 'single-exit'; nextScrap: Scrap | null; nextProfitScrap: Scrap | null; /** The next buyer was not seen for 24 h (never a backup, R-PC2). */ nextUnverified: boolean }
  | { code: 'resave-list'; highScrap: Scrap; highAt: UnixMs; listAt: UnixMs | null }
  | { code: 'falling'; fromScrap: Scrap; toScrap: Scrap; sinceAt: UnixMs }
  | { code: 'held-vs-typical'; heldMs: number; typicalMs: number; count: number; scope: TypicalHold['scope']; stillHeld: number }
  | { code: 'key-exposure'; netKeys: number; boughtKeyScrap: Scrap; nowKeyScrap: Scrap; /** 0.9 (#17): the key's 7-day move band from PriceDB history already loaded; absent without one. */ band?: KeyMoveBand }
  | { code: 'list-age'; listAt: UnixMs }
  | { code: 'has-extras' }
  | { code: 'trade-locked'; tradableAt: UnixMs; boughtAt: UnixMs; /** What the advice would be without the lock (today's book). */ todayKind: Exclude<HoldingAdviceKind, 'locked'> }
  | { code: 'units-locked'; lockedQty: number; qty: number; firstTradableAt: UnixMs }
  | { code: 'trend-size'; changeScrap: Scrap; spreadScrap: Scrap; points: number; fromAt: UnixMs; toAt: UnixMs }
  | { code: 'no-history'; runs: number; observedMs: number; firstAt: UnixMs | null; /** HoldingExitHistory.settingsAt, when the history starts there. */ settingsAt?: UnixMs };

/** 0.8 (H6) HoldingRow.advice: the advice on a holding, its reasons and the recorded history it rests on. */
export interface HoldingAdvice {
  kind: HoldingAdviceKind;
  /** The deciding reason first, then supporting and context reasons in a fixed order (holdingAdvice). */
  reasons: HoldingAdviceReason[];
  /** The recorded history behind it: counted runs and the first run's start; null when nothing is recorded. */
  basis: { runs: number; firstAt: UnixMs } | null;
  /** The book this rests on needs a snapshot first; core.snapshotPriority ranks such held rows (H8). */
  refreshFirst: boolean;
}

/** 0.8 (H7) 'holdings.detail': one SKU's holding, trades and recorded exits, for the drawer. Local reads only. */
export interface HoldingDetail {
  sku: string;
  /** The base SKU the runs are recorded under (paint removed); null for a currency or an unreadable SKU. */
  baseSku: string | null;
  /** Its Holdings row (advice included); null when nothing of this SKU is held. */
  row: HoldingRow | null;
  /** Its open lots, oldest first (the next sale closes lots[0]); [] when not held. */
  lots: JournalLot[];
  /** This SKU's closed buy/sale pairs (J1's JournalClosedTrade, write-offs included), newest sale first, at most HOLDING_DETAIL_MAX_CLOSED. */
  closed: JournalClosedTrade[];
  /** typicalHold(every closed trade, sku); null with too few. */
  typicalHold: TypicalHold | null;
  /** Recorded runs of baseSku, oldest first: since the oldest lot's buy minus HOLDING_DETAIL_LEAD_MS when held, else the last HOLDING_DETAIL_UNHELD_MS; at most HOLDING_DETAIL_MAX_MARKS (the newest). */
  marks: HoldingMark[];
  /** More runs fell in the window than HOLDING_DETAIL_MAX_MARKS: the oldest were left out. */
  truncated: boolean;
  /** holdingExitHistory(marks, row.heldSince, keyScrap, generatedAt); null when not held. */
  history: HoldingExitHistory | null;
  /** The key price the money is valued at (the engine's). */
  keyScrap: Scrap;
  generatedAt: UnixMs;
}

/**
 * 0.9 (#17): the key's PriceDB buy price (else sell) moved this much over 7-day spans ending a day apart, in the key history
 * Flip Desk already loaded (keyMoveBandOf). A description of past moves, never a forecast.
 */
export interface KeyMoveBand {
  /** 10th and 90th percentile of the 7-day change, scrap per key (negative: the key fell). */
  lowScrap: Scrap;
  highScrap: Scrap;
  /** Spans it rests on. */
  spans: number;
  /** The earliest span start and the newest point used. */
  fromAt: UnixMs;
  toAt: UnixMs;
  /** When that history was loaded (the cache time). */
  loadedAt: UnixMs;
}

/** 0.9 (#17) PriceDb.loadedKeyHistory: PriceDB 5021;6 history already in memory; reading it sends nothing. */
export interface LoadedKeyHistory {
  loadedAt: UnixMs;
  points: HistoryPoint[];
}

/** 0.9: Holdings' valuation of everything held as of one read (holdingsValuationOf), for the Journal's card and ledger CSV. */
export interface HoldingsValuation {
  /** HoldingsResult.generatedAt. */
  at: UnixMs;
  /** The key price the rows were valued at (HoldingsResult.keyPrice.valueScrap when > 0); null when unknown. */
  keyScrap: Scrap | null;
  worthNowScrap: Scrap;
  profitNowScrap: Scrap;
  costScrap: Scrap;
  items: number;
  units: number;
  /** Items (and their units) with no exit: counted at nothing in worthNowScrap and left out of profitNowScrap. */
  unpricedItems: number;
  unpricedUnits: number;
  /** HoldingsResult.totals.locked ?? 0. */
  lockedItems: number;
  /** Per held SKU (as journaled): the per-unit exit Worth now counts (exitScrap, else revenueScrap); null: none. */
  exitBySku: Readonly<Record<string, Scrap | null>>;
}

/** 0.9: one open lot valued at its SKU's exit as of a HoldingsValuation (lotValueOf). */
export interface JournalLotValue {
  worthScrap: Scrap | null;
  /** worth - the lot's cost at the valuation's key price - friction (holdingFigures); null without an exit. */
  unrealisedScrap: Scrap | null;
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

/** 0.7.3: the Live log's filters for its events export (opportunityEvents.ts); an omitted field does not filter. */
export interface EventsExportQuery {
  kinds?: OpportunityEventKind[];
  category?: Category;
  /** Every word must match the name, SKU or summary, ignoring case (marketSearchTokens). */
  search?: string;
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
   * 0.7.4 (F36): the bank page an item of this kind is sold on (scraptfBankForItem with its schema entry: a
   * strange cosmetic on /buy/hats, a killstreak or australium weapon on /buy/items), for "Open bank page"
   * when seenOn names none (0.7.4 R28: or names only the /items list). Absent (older services):
   * bankForCategory(category). The mock sends mockBankOf (scraptfBankForItem with no schema entry).
   */
  kindBank?: Exclude<ScraptfBank, 'list'>;
  /**
   * F17: the item in the newest bank-stock save that lists it (BankStock.detailFor): which bank, that
   * save's time, its change since the bank's previous save and its stock. null when no kept save lists it.
   */
  bankStock: ItemBankStock | null;
  /**
   * 0.8 (H3, PC-7): the lowest matching ask for this copy (the drawer SKU's paint, no spells, parts or custom
   * text), from `sellListings`' source rows, copy-matched in the service (asks.ts) and age-gated; null without
   * one. Absent from older services. Never used in profit, Pay up to or notifications.
   */
  ask?: HoldingAskSide | null;
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

/**
 * 0.9 (#13): scrap.tf's own price-drop wording on a bank page card: 'soon' ("This item will decrease in price
 * shortly."), 'off' ("… off original price … original price of …"). 2018 markup; no real save has confirmed either.
 */
export type ScraptfMarkdown = 'off' | 'soon';
/** 0.9 (#13): every ScraptfMarkdown, in the order stored and shown (bankStockMarkdownText, bankStockMarkdownOf). */
export const SCRAPTF_MARKDOWNS: readonly ScraptfMarkdown[] = ['off', 'soon'];
/** 0.9 (#13): what a recognised bank page's own text said about its bank ('unavailable': "Hat Banking is temporarily disabled"). */
export type ScraptfBankNotice = 'unavailable';
/** 0.9 (#13): every ScraptfBankNotice (the repo reads any other stored text as none). */
export const SCRAPTF_BANK_NOTICES: readonly ScraptfBankNotice[] = ['unavailable'];

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
  /** 0.7.4, /items list rows only: which copies the row is proven to price (ScraptfListCraft); absent on cards. */
  listCraft?: ScraptfListCraft;
  /** 0.9 (#13): bank page cards only: the price-drop wording the card showed, in SCRAPTF_MARKDOWNS order; absent when none. */
  markdown?: ScraptfMarkdown[];
}

// ---------------------------------------------------------------------------
// scrap.tf price list (F14): the user's saved copy of scrap.tf/items
// ---------------------------------------------------------------------------

/**
 * 0.7.4: what an /items row is known to price. 'uncraftable': it says so ("Non-Craftable X", or an
 * "uncraft" class on the row or its icon); 'craftable': the page also lists that item's Non-Craftable row,
 * so this one is the Craftable copy; 'any': neither, one entry for every copy scrap.tf sells at its price
 * (Craftable or not, any killstreak tier, festivized): a family row, never a cost of its own.
 */
export type ScraptfListCraft = 'craftable' | 'uncraftable' | 'any';
export const SCRAPTF_LIST_CRAFTS: readonly ScraptfListCraft[] = ['craftable', 'uncraftable', 'any'];

/**
 * One stored row of the scraptf_list table, as the repo reads it (raw keys + metal, nothing valued).
 * Keyed by the row's family SKU (paint removed; ';uncraftable' only when the row is marked so): 0.7.4, an
 * unmarked /items row stands for every copy scrap.tf sells at its price, not only the plain copy.
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
  /** 0.7.4: which copies the row is proven to price (schema V14 `craft`). Absent: 'any'. */
  craft?: ScraptfListCraft;
  /**
   * 0.7.4 (F60, schema V14 `page`): the list page the row was last read on ('/items', '/items/2'), so a
   * whole save of that page retires the rows it no longer shows. Absent or '': not known (never retired so).
   */
  page?: string;
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
  /** 0.7.4: which copies the row is proven to price (ScraptfListStored.craft). Absent: 'any'. */
  craft?: ScraptfListCraft;
  /**
   * 0.7.4 (rowFor): 'exact', the row of this very copy (paint aside); 'family', an unmarked row ('any') that
   * stands for every copy scrap.tf sells at its price, read for a Non-Craftable, killstreak or festivized copy
   * with no row of its own: its stock counts every copy. Absent: 'exact'.
   */
  match?: 'exact' | 'family';
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
   * (they are skipped as prices but kept on the list). 0 when a newer saved list already had them all,
   * or when the page gave no list rows (listRowsRead 0).
   */
  listRows?: number;
  /**
   * 0.7.3, saved scrap.tf/items pages only: the list rows this page gave (rows with a SKU and a price, one
   * per base SKU), written or not. 0 when it had none: saved before its rows loaded, a layout the parser
   * does not know, or no row identified. Absent from older results.
   */
  listRowsRead?: number;
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
  /**
   * 0.8 (G2), scrap.tf window reads that wrote a save: rows this read dropped under Pay up to (BankStock.droppedFlips:
   * cheaper than on the save before, a flip now, the previous price over today's Pay up to). Absent otherwise.
   */
  droppedFlips?: number;
  /**
   * 0.7.1 (P5): every skipped entry before `skipped` was cut, and how many per reason (the reason text,
   * a refusal code for refusals). Absent from older results: `skipped.length` is the count then.
   */
  skippedTotal?: number;
  skippedCounts?: Record<string, number>;
  /**
   * 0.7.1: what this import did with the page's bank stock. 'written': a save (rows) was stored;
   * 'partial': a look with far fewer cards than a recent save of the page (DM-2); 'unsettled': a window
   * snapshot cut before its settle read (ACT-4); 'none': nothing to store (no bank, no rows). Prices are
   * stored in every case. Absent: not reported (older services).
   */
  stockSave?: 'written' | 'partial' | 'unsettled' | 'none';
  /**
   * 0.7.1, window reads that wrote a save: the flips on sale on this save now (BankStock.pageFlips), and
   * the best few of them (at most 3, most profit first). Absent otherwise.
   */
  pageFlips?: number;
  topFlips?: ImportTopFlip[];
}

/**
 * 0.7.1 ImportResult.topFlips: one flip on the page just read. The name comes from the app's own item
 * data (the schema), never from page text.
 */
export interface ImportTopFlip {
  sku: string;
  name: string;
  costScrap: Scrap;
  maxCostScrap: Scrap;
  profitScrap: Scrap;
}

/**
 * 0.7.1 (P4) 'import.report': one parse of a saved page or window read, as a sanitized summary the user can
 * copy into a bug report. Whitelisted data only: counts, header texts, warning codes and the card fields
 * the parser read (never the nav, scripts, asset ids, avatars, Steam IDs, custom names or gift text). Kept
 * in memory only (a ring of the newest few), never stored or sent.
 */
export interface ImportReport {
  /** Grows with every report (the ring's order). */
  id: number;
  at: UnixMs;
  origin: ImportOrigin;
  /** The file name (a window read: windowReadFileName). */
  name: string;
  pageKind: ImportPageKind;
  bank: ScraptfBank | null;
  /** The page key (ScrapTfParseResult.page). */
  page: string;
  format: 'html' | 'mhtml' | 'window';
  /** The batch the import recorded; 0 when it recorded none (a refused read, a throw). */
  batchId: number;
  /**
   * 0.8 (LC-6): reserved / notTradable count parsed items carrying the 'reserved' / 'not-tradable' warning code (report only).
   * 0.9 (#13), report only: cards with 'soon' / 'off' wording, cards with a countdown-like text, "recently traded" phrases,
   * cards inside a "recent" element, bank-unavailable phrases.
   */
  counts: {
    dataDefindex: number; cards: number; rows: number; selectedSkipped: number; duplicates: number; lookalikes: number; reserved: number; notTradable: number;
    markdownSoon: number; markdownOff: number; countdownCards: number; recentlyTraded: number; recentCards: number; bankNotices: number;
  };
  /** The /items table's header cells as the parser read them. */
  headerColumns: string[];
  /** Page and item warnings by code (importWarningCode), counted. */
  warningCodes: Record<string, number>;
  /** At most IMPORT_REPORT_MAX_ITEMS: refused cards and stored cards with a guess or mismatch code. */
  items: ImportReportItem[];
  /** 0.9 (#13): at most IMPORT_REPORT_NOTICES_MAX matched page phrases ('bank notice: "…"', 'recently traded: "…"', 'countdown in a "recent" section: "…"'), scrubbed; absent when none or countsOnly. */
  notices?: string[];
}

/** 0.7.1 (P4): one card or /items row of an ImportReport, as the parser read it (whitelisted fields only). */
export interface ImportReportItem {
  defindex: number | null;
  /** Filtered to quality\d+, killstreak\d, fx\d+, uncraft* and the item/app440/hoverable flags. */
  classTokens: string[];
  /** The card's title only when the item has no custom name. */
  title: string | null;
  /** The content lines parseContent kept (gift and receipt lines already dropped). */
  contentLines: string[];
  indicator: string | null;
  itemValue: string | null;
  numAvailable: string | null;
  numSelected: string | null;
  /** 0.8 (LC-6): the card's data-bot attribute as read (DESIGN_BRIEF §3.3, display only); absent on an older report. */
  dataBot?: string | null;
  particleId: number | null;
  warpaintId: number | null;
  /** An /items row's cell texts. */
  cells?: string[];
  /** An /items row's stock-limit attributes as read. */
  limitAttrs?: { title: string | null; dataOriginalTitle: string | null; dataBsOriginalTitle: string | null; ariaLabel: string | null };
  sku: string | null;
  warnings: string[];
}

/**
 * F21: how a saved page reached the import. 'file': the file picker or the folder watch (a page the user
 * saved). 'window': a read of the opt-in scrap.tf window (the DOM the user's own browsing loaded); only
 * main sets it. Batches from before 0.7 read null.
 */
export type ImportOrigin = 'file' | 'window';
export const IMPORT_ORIGINS: readonly ImportOrigin[] = ['file', 'window'];

/**
 * 0.7.1 Repo.bankNewestSaves: one bank's newest save over every import batch that recorded its bank, as
 * scraptfBankSaves dates a bank (save time = batchSavedAt, ties to the higher id; a bank page that stored
 * nothing is no save, the list counts with none: isEmptyBankSave).
 */
export interface BankNewestSave {
  bank: ScraptfBank;
  batchId: number;
  savedAt: UnixMs;
  itemCount: number;
}

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
  /** 0.9 (#13, schema V16 bank_notice): 'unavailable' when the page said its bank was not trading; absent or null otherwise and before V16. */
  bankNotice?: ScraptfBankNotice | null;
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
  /** 0.9 (#13): the time of the bank's newest look whose page said it was not trading, when no newer save exists (bankUnavailableAt); absent otherwise. */
  unavailableAt?: UnixMs;
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
 * 0.8 (T6) 'dropping': on sale, at least BANK_STOCK_DROPPING_MIN (2) reprice-downs in its current run; 0.8 (G1)
 * 'watched': on sale and on your watch list (BankStockRow.watch).
 */
export type BankStockFilter = 'all' | 'new' | 'flips' | 'changed' | 'gone' | 'long-listed' | 'dropped' | 'dropping' | 'watched';
export const BANK_STOCK_FILTERS: readonly BankStockFilter[] = ['all', 'new', 'flips', 'changed', 'gone', 'long-listed', 'dropped', 'dropping', 'watched'];

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
  /**
   * 0.7.4, the /items list's rows only (bank_stock.craft, V14): which copies the row is proven to price
   * (ParsedScrapItem.listCraft; 'any' for a family row and for rows of one item that differ). Absent or null
   * on a bank page's card. A list row not proven 'craftable' or 'uncraftable' gets no buy side
   * (bankStockListFamily).
   */
  craft?: ScraptfListCraft | null;
  /** 0.9 (#13, bank_stock.markdown): a bank page card's price-drop wording on this save; absent or null when none (and on /items rows). */
  markdown?: ScraptfMarkdown[] | null;
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
  /**
   * The price as saved, then valued at the current key price. A gone row: its last price, from the newest
   * save that listed it on sale (0.7.3, the runs index), else from the previous save.
   */
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
  /** flipProfit(revenue, cost, settings.profit); null without revenue. */
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
  /**
   * 0.7.1 (DM-5): the newest save that listed it on sale (the end of its current run), so an old sighting is
   * not read as current. 0.7.3: a gone row's too (the Gone view's Last seen). Absent or null: unknown (shown
   * as before).
   */
  lastSeenAt?: UnixMs | null;
  /**
   * 0.7.4: an /items list row not proven to price one copy (BankStockStored.craft not 'craftable' or
   * 'uncraftable': a family row, or rows of one item that differ). It is joined to no buy side (revenue,
   * Pay up to and profit null, verdict 'no-buyers', buyerCount 0), so it is never a flip, a page flip or a
   * "New on scrap.tf" toast. Absent: a row of its own copy.
   */
  listFamily?: true;
  /** 0.8 (T4): this copy's buy-timing verdict in this bank (joined at read time); absent on a gone row, an /items family row, without history, or from an older service. */
  timing?: ScraptfTimingBrief;
  /** 0.8 (G1): the enabled watch on this copy (watchJoinOf: a copy's own watch before an any-copy one); absent when none. */
  watch?: BankStockRowWatch;
  /** 0.9 (history): the copy's lowest price on sale in this bank's saves (joined at read time); absent with none. */
  low?: ScraptfCopyLow;
  /** 0.9 (#13): the card's price-drop wording on the newest save (an on-sale row only; never gone or family rows); absent when none. */
  markdown?: ScraptfMarkdown[];
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
  /** 0.8 (T6): the 'dropping' chip. */
  dropping: number;
  /** 0.8 (G1): the 'watched' chip (on sale, BankStockRow.watch set). */
  watched: number;
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
  /**
   * 0.7.1 (DM-5): pages of the bank whose newest save is far older than the bank's newest page, left out of
   * the counts, chips and "What's new" (history and the feed keep them), and the newest of their saves.
   * Absent or null: none left out.
   */
  olderPages?: { count: number; newestSavedAt: UnixMs } | null;
  /** 0.8 (LC-4): absent without history or from an older service. */
  turnover?: ScraptfTurnover;
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
  /**
   * Live backpack.tf revenue (Sells for) and Pay up to of the base SKU now; null without an eligible buyer,
   * or (0.7.3) with eligible buyers none of which the revenue pick can use (buyerCount > 0).
   */
  revenueScrap: Scrap | null;
  maxCostScrap: Scrap | null;
  /** toValueScrap is at or under maxCostScrap now: the "Flip" pill. */
  flip: boolean;
  /**
   * 0.7.1 (ACT-10): the event would be a flip now, but a later event of the same copy superseded it (or the
   * copy is no longer on sale), so `flip` is false: the muted "was a flip" pill. Absent: false.
   */
  wasFlip?: boolean;
  /**
   * 0.7.3: the Live market entry's distinct buyers with eligible orders (0 without an entry) and its flags
   * ('all-outliers'...), so a null revenue with buyers says why. Absent: not known (an older service).
   */
  buyerCount?: number;
  flags?: string[];
  /**
   * 0.7.4: an /items list event whose row (in the event's own save) is not proven to price one copy
   * (BankStockRow.listFamily's rule): joined to no buy side, so never a flip. Absent: a row of its own copy.
   */
  listFamily?: true;
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
  /** 0.8 (LC-3/T1/LC-5): runs and drop steps in `bank`; absent when bank is null or from an older service. */
  cycles?: ScraptfItemCycles;
  /** 0.8 (T3/T4): the buy-timing verdict now; null when not on sale on its newest observation (or a family row, or no profit settings known); absent from an older service. */
  timing?: ScraptfBuyTiming | null;
  /** 0.9 (history): the copy's lowest price on sale in `bank`'s saves (ScraptfHistory.lowsFor); absent with none or from an older service. */
  low?: ScraptfCopyLow;
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
  /**
   * 0.7.3: the raw price on the save at lastSeenAt (null: never on sale). Unlike `current`, kept once it goes
   * off sale: a gone bank stock row's last price. Optional so runs built before it still read.
   */
  lastOnSale?: { keys: number; scrap: Scrap } | null;
}

/** 0.8 (LC-3): why a listing run ended. 'untradable': the same Steam asset id showed under the item's ';untradable' SKU in that save (LC-5's gate held). */
export type ScraptfRunEnd = 'absent' | 'sold-out' | 'untradable';

/** 0.8 (LC-3): one unbroken run of a copy's home-page saves listing it on sale, in one bank (scraptfLifecycleOf). */
export interface ScraptfListingRun {
  /** The first save of the run. */
  firstOnSaleAt: UnixMs;
  /** The copy's observation before it (off sale on its home page; for its first run the save of that page just before, which did not list it). Null: left-censored (on sale at the first retained save of its page). */
  startAfter: UnixMs | null;
  /** The last save of the run. */
  lastOnSaleAt: UnixMs;
  /** The first observation off sale after the run (absent, sold out); null while open. */
  endedAt: UnixMs | null;
  endedAs: ScraptfRunEnd | null;
  /** Raw price on its first and on its last save. */
  startRaw: { keys: number; scrap: Scrap };
  endRaw: { keys: number; scrap: Scrap };
  /** Reprice-down steps that showed in this run (a lower bound: several drops between two saves read as one). */
  drops: number;
  /** Saves in the run. */
  saves: number;
  /**
   * LC-5: its first on-sale row and the previous run's last one are single cards with the same Steam asset id (true: the same item came back, not traded away) or different ids (false: another card, or the same one traded back under a new id). Null: unknown, a stack, the first run, or the bank's ids not stable.
   */
  sameAssetAsBefore: boolean | null;
  /** The run ended in a flap (back within SCRAPTF_FLAP_MAX_MS of its last on-sale sighting, at the same raw price): the next run is the same listing. */
  flap?: true;
  /**
   * The last sighting before the first gap over its page's gap limit (scraptfGapLimitMs: SCRAPTF_TIMING_GAP_SLACK x its
   * usual longest gap in a day, 2 h to SCRAPTF_TIMING_MAX_BRACKET_MS) between two observations of the copy during the
   * run or at its end: the turnover estimate censors the run there, whatever came after. Absent: none.
   */
  cutAt?: UnixMs;
  /** 0.7.4 rule: an /items list row not proven to price one copy (bankStockListFamily). Never pooled. */
  family?: true;
  /** It began after a gap over its page's gap limit (firstOnSaleAt - startAfter): the turnover leaves it out (start side). */
  wideStart?: true;
}

/**
 * 0.8 (LC-5): how often a single-card copy (stock 1) kept its asset id between your looks, in one bank: pairs of
 * consecutive on-sale observations on its page at least BANK_STOCK_SESSION_GAP_MS apart (the last sighting of one
 * look against the first of the next), so dense window reads of one look never count.
 */
export interface ScraptfAssetStability {
  pairs: number;
  same: number;
  /** same / pairs; null without pairs. */
  share: number | null;
  /** share >= SCRAPTF_ASSET_STABLE_SHARE over at least SCRAPTF_ASSET_STABLE_MIN_PAIRS pairs: asset-id labels are shown. */
  stable: boolean;
}

/** 0.8 (LC-5) HealthReport.scraptfAssetIds: one saved bank's asset-id stability. */
export interface ScraptfAssetIdsHealth extends ScraptfAssetStability {
  bank: ScraptfBank;
}

/** 0.8 (LC-3/T1/LC-5) ScraptfItemHistory.cycles: the copy's runs and drop steps in the history's bank. */
export interface ScraptfItemCycles {
  /** The newest SCRAPTF_ITEM_RUNS_MAX (20) runs, oldest first. */
  runs: ScraptfListingRun[];
  /** Every run of the copy in the bank's retained saves. */
  runsTotal: number;
  /** Runs after the first whose start is known and that do not follow a flap: times it came back in your saves. */
  returns: number;
  /** Save times at which a lower price showed after a reprice-down (the chart's down markers), oldest first. */
  dropAts: UnixMs[];
  /** LC-5's gate held for the bank: sameAssetAsBefore and 'untradable' are shown. */
  assetIdsStable: boolean;
}

/** 0.8 (T3): one reprice-down of the current run, valued at the read's key price. */
export interface ScraptfDropStep {
  /** The save that showed the lower price, and the last save at the higher one: the drop happened in (prevAt, at]. */
  at: UnixMs;
  prevAt: UnixMs;
  fromScrap: Scrap;
  toScrap: Scrap;
  /** (to - from) / from; null when from is 0. */
  pct: number | null;
}

/** 0.8 (T3): a copy's buy-timing verdict: buy it now, wait for another drop, over Pay up to, no buyers, or not enough data. */
export type ScraptfTimingVerdict = 'buy-now' | 'wait' | 'over' | 'no-buyers' | 'not-enough-data';
/**
 * Why, per verdict.
 * - wait: 'drop-likely' | 'drop-makes-flip'
 * - buy-now: 'flip-now' | 'gone-risk' | 'unsure-gain'
 * - over: 'over' | 'unsure-gain'
 * - no-buyers: 'no-buyers'
 * - not-enough-data: 'stale-save' | 'left-censored' | 'few-drops' | 'few-ended' | 'few-at-risk' | 'sparse-saves' | 'past-data'
 * 0.9 (#10) 'unsure-gain': waiting looked worth it on the estimate (within Pay up to, over the gain bar) but not at the
 * gain's low end (SCRAPTF_WAIT_MIN_GAIN_LOW_SCRAP), so the verdict is not Wait.
 */
export type ScraptfTimingWhy =
  | 'drop-likely' | 'drop-makes-flip'
  | 'flip-now' | 'gone-risk' | 'unsure-gain'
  | 'over' | 'no-buyers'
  | 'stale-save' | 'left-censored' | 'few-drops' | 'few-ended' | 'few-at-risk' | 'sparse-saves' | 'past-data';

/** 0.9 (#10): a share's range allowing for chance: 0 <= low <= share <= high <= 1. */
export interface ScraptfShareRange {
  low: number;
  high: number;
}

/**
 * 0.9 (#10): how sure the picked horizon's figures are (scraptfTimingSpreadOf: the infinitesimal jackknife of the pooled
 * table, each copy's states summed, times copies / (copies - 1)). Ranges allow for chance between the items in the
 * user's saves only: not for where in a bracket a change happened (saveTiming says when that matters), not for when
 * the user chose to save, not for scrap.tf changing its prices.
 */
export interface ScraptfTimingUncertainty {
  /** 90 % ranges (Wilson at the effective sample size) of pDrop and of pGone + pRise ('went or rose first'). */
  pDrop: ScraptfShareRange;
  pGoneOrRose: ScraptfShareRange;
  /** The items (distinct copies) behind the ranges: copies with a price state still at its price past the copy's age. */
  copies: number;
  /**
   * The gain of waiting over the better of buying now and not buying, at its one-sided 95 % low end, in whole scrap
   * rounded down; null when Wait's other two conditions failed (neither today's nor the dropped price within Pay up to,
   * or the gain on the estimate under the bar), so the low end was never needed.
   */
  gainLowScrap: Scrap | null;
  /**
   * T9-3b: the drop size the low end used (a one-sided 95 % lower bound of the median single-step drop, as a
   * fraction of the price) and where the sizes came from ('short-brackets': only drops whose bracket was no longer
   * than the median look gap, at least 5; 'all' otherwise). Absent when the low end was never needed.
   */
  dropLow?: number;
  dropSizeFrom?: 'all' | 'short-brackets';
}

/** 0.9 (#10): the decision the same rules give with every price change at the left end of its bracket. */
export interface ScraptfSaveTimingAlt {
  verdict: 'wait' | 'buy-now' | 'over';
  why: ScraptfTimingWhy;
  /** The horizon that read picked (for "waiting about 1 d"). */
  horizonMs: number | null;
}

/**
 * 0.8 (T3): whether to buy a copy now or wait for another drop, an estimate from the user's own saves
 * (scraptfBuyTimingOf). Never a forecast: steps are dated at the save that showed them, several drops between
 * two saves read as one, and 'gone' can be a sale, a reservation or a move.
 */
export interface ScraptfBuyTiming {
  verdict: ScraptfTimingVerdict;
  why: ScraptfTimingWhy;
  /** The bank and copy (bankStockKey) read. */
  bank: ScraptfBank;
  key: string;
  /** Today's price (the open state's raw price at the read's key price), Sells for and Pay up to it was judged against. */
  costScrap: Scrap;
  revenueScrap: Scrap | null;
  maxCostScrap: Scrap | null;
  /** The current price state: first save at it, the save before (null: left-censored), its newest save, and lastSeenAt - priceSince. */
  priceSince: UnixMs;
  pricePrevAt: UnixMs | null;
  lastSeenAt: UnixMs;
  ageMs: number;
  /**
   * The horizon (from lastSeenAt; only horizons with now - lastSeenAt <= H / 2 are eligible) the comparison picked,
   * and within it from the pooled table at this age: dropped first / went first / rose first / none of these. The
   * four add up to 1. Null without one.
   */
  horizonMs: number | null;
  pDrop: number | null;
  pGone: number | null;
  /** Rose first: repriced up, so today's price can no longer be paid (a sale of the cheapest card that leaves a dearer one is 'gone', not this). */
  pRise: number | null;
  pNone: number | null;
  /** Typical drop (0.05 = 5 %), and whose: the copy's own median with at least SCRAPTF_OWN_MIN_DROPS own drops, else the pooled table's. */
  dropPct: number | null;
  dropPctSource: 'own' | 'bank' | null;
  /** Today's price after a typical drop (c1). */
  expectedNextScrap: Scrap | null;
  /** flipProfit now (may be negative), and the expected profit of waiting horizonMs (scraptfTimingEv); null without revenue or a horizon. */
  evBuyScrap: Scrap | null;
  evWaitScrap: Scrap | null;
  /** Reprice-downs in the current run (runs joined by a flap count as one), and its newest steps (at most SCRAPTF_TIMING_STEPS_MAX, oldest first). */
  dropsThisRun: number;
  /**
   * Those of dropsThisRun shown since the current run's first save (scraptfRunsOf's listedSince, which a flap
   * restarts): a bank stock row's Since listed cell and Dropping chip count these, so they read the same listing as
   * the row's baseline. Absent (a hand-built timing): dropsThisRun.
   */
  dropsSinceListed?: number;
  steps: ScraptfDropStep[];
  /**
   * The drop rhythm. 'own': the copy's own reprice-down durations (at least 3, coefficient of variation <= 0.35,
   * median at least 4x their median end bracket and 2x lookGapMs, so it is not the user's save rhythm);
   * nextDropAt = priceSince + cadenceMs, worded "by that rhythm the next drop would be due". 'bank': the pooled
   * table's median time to a drop among drops (biased short: censored and gone states are not in it), shown only as
   * "drops in your saves came a median X after the price was set", so nextDropAt is null.
   */
  cadenceMs: number | null;
  cadenceSource: 'own' | 'bank' | null;
  nextDropAt: UnixMs | null;
  /** Earlier completed runs (flaps aside), newest first, at most SCRAPTF_TIMING_RUN_ENDS_MAX: the last price each was on sale at. */
  earlierRunEnds: { endedAt: UnixMs; endedAs: ScraptfRunEnd; lastScrap: Scrap }[];
  /** The pool: states in the copy's neighbouring power-of-two value buckets (between about a quarter and four times its value), else the whole bank. */
  scope: 'band' | 'bank';
  /**
   * How often the user looks at the copy's home page: saves less than BANK_STOCK_SESSION_GAP_MS apart are one look,
   * and this is the median gap from one look's last save to the next look's first, over the 7 d before its newest
   * save (scraptfLookGapMs). Then the table's median bracket.
   */
  lookGapMs: number | null;
  resolutionMs: number | null;
  /**
   * The n behind every figure, in price states (one copy repriced five times is six states) and in items (copies):
   * copies / dropCopies are the distinct copies among the states used / among the drops. atRisk is the states still at
   * their price at the copy's age (the denominator of pDrop/pGone/pRise/pNone), atRiskEnd at the end of the horizon.
   * rose: reprice-ups; wideGap: states censored at the last sighting before a gap over their page's gap limit
   * (scraptfGapLimitMs, at most SCRAPTF_TIMING_MAX_BRACKET_MS); imprecise: left out on the start side.
   */
  n: { states: number; copies: number; ended: number; drops: number; dropCopies: number; gone: number; rose: number; atRisk: number; atRiskEnd: number | null; ownDrops: number; imprecise: number; wideGap: number };
  /**
   * 0.9 (#10): the ranges behind pDrop / pGone + pRise and the Wait gate's low end, for the picked horizon. Present
   * whenever horizonMs is (wait, buy-now, over); absent on not-enough-data, no-buyers and a hand-built timing.
   */
  uncertainty?: ScraptfTimingUncertainty;
  /**
   * 0.9 (#10): set only when the verdict depends on save timing: with every price change dated at the user's last save
   * before it (the left end of its bracket) instead of the save that showed it, the same rules give this other
   * decision. Never changes `verdict`.
   */
  saveTiming?: ScraptfSaveTimingAlt;
}

/** 0.8 (T4): what a row (BankStockRow, MarketRow, Opportunity) carries of a ScraptfBuyTiming (scraptfTimingBrief). */
export interface ScraptfTimingBrief {
  verdict: ScraptfTimingVerdict;
  why: ScraptfTimingWhy;
  bank: ScraptfBank;
  key: string;
  dropsThisRun: number;
  /** As ScraptfBuyTiming.dropsSinceListed (absent: dropsThisRun). */
  dropsSinceListed?: number;
  /** The run's newest steps, at most SCRAPTF_TIMING_BRIEF_STEPS (5), oldest first. */
  steps: ScraptfDropStep[];
  /** The save the estimate rests on (ScraptfBuyTiming.lastSeenAt): titles say "from your save 5 h ago". */
  lastSeenAt: UnixMs;
  horizonMs: number | null;
  pDrop: number | null;
  pGone: number | null;
  pRise: number | null;
  nextDropAt: UnixMs | null;
  /** As ScraptfBuyTiming.scope: with 'band' the n are of prices of similar value, and titles say so. Absent: 'bank'. */
  scope?: 'band' | 'bank';
  /** As ScraptfBuyTiming.n: titles quote the at-risk denominator and the states and items behind it. */
  n: { states: number; copies: number; atRisk: number; dropCopies: number };
  /**
   * As ScraptfBuyTiming.costScrap / maxCostScrap: the scrap.tf price the verdict judged and the Pay up to it was held
   * against, so a tag on a row that shows no price of the user's (a Live market row whose only scrap.tf side is the
   * saved list) says which price it means.
   */
  costScrap?: Scrap;
  maxCostScrap?: Scrap | null;
  /** 0.9 (#10): as ScraptfBuyTiming.uncertainty (the tag and Verdict titles quote the ranges and their items). */
  uncertainty?: ScraptfTimingUncertainty;
  /** 0.9 (#10): as ScraptfBuyTiming.saveTiming (the tag reads 'Wait ~1 d?' / 'Buy now?'). */
  saveTiming?: ScraptfSaveTimingAlt;
}

/** 0.8 (LC-4) BankStockResult.turnover: how long items stayed listed in a bank (Kaplan-Meier over listing runs, flap chains joined). */
export interface ScraptfTurnover {
  bank: ScraptfBank;
  /** Listings that ended (gone, sold out, untradable) with no gap over their page's gap limit (scraptfGapLimitMs) before the end was seen. */
  ended: number;
  /** Still listed at their last sighting (censored). */
  open: number;
  /** Censored at their last sighting before a gap over their page's gap limit (ScraptfListingRun.cutAt), whatever came after. */
  wideGap: number;
  /** Left out (decided on the start side only, never by how a listing ended): started before the first save of their page, or after a gap over its gap limit (wideStart). */
  imprecise: number;
  /** Time listed when 25 % / 50 % / 75 % of listings had gone (S <= 0.75 / 0.5 / 0.25); null where the curve does not reach it. */
  p25Ms: number | null;
  medianMs: number | null;
  p75Ms: number | null;
  /** Median bracket of the listings used: the ± on every figure. */
  resolutionMs: number | null;
  /** Still-listed share after atMs, non-increasing, at most SCRAPTF_TURNOVER_CURVE_MAX points (starts { atMs: 0, stillListed: 1 }). */
  curve: { atMs: number; stillListed: number }[];
  /** Ended listings that dropped at least once before they went; null without one. */
  droppedBeforeGoneShare: number | null;
  /** The oldest listing start used. */
  since: UnixMs | null;
  /** Fewer than SCRAPTF_TIMING_MIN_ENDED ended listings: no figure is shown. */
  reason?: 'not-enough-data';
}

// ---------------------------------------------------------------------------
// scrap.tf watches (0.8, G1/G3): the user's own targets for an item, judged only on the user's own reads and
// saves of scrap.tf pages (R1, R10). Nothing is fetched, and nothing is bought (R4): a hit is a notification.
// ---------------------------------------------------------------------------

/** What an on-sale row meets of a watch: its price target (cost at or under it) or its profit target. */
export type ScraptfWatchMet = 'price' | 'profit';

/** One watch (scraptf_watches, schema V15). */
export interface ScraptfWatch {
  id: number;
  /** Canonical base SKU (paint dropped), as BankStockRow.sku. */
  sku: string;
  /**
   * The copy watched: a bank_stock special key ('' a clean copy; matched as bankStockIsOwnCopy, so a sheen or a
   * killstreaker aside), or null for every copy of the base.
   */
  specialKey: string | null;
  /** The item's name from the app's item data when it was watched (never page text). */
  name: string;
  /** Price target as typed, raw keys + metal (valued at each read's key price); maxCostScrap null: no price target. */
  maxCostKeys: number;
  maxCostScrap: Scrap | null;
  /** Profit target: BankStockRow.profitScrap at or over it; also the copy's "Profit:" bar (engine). null: none. */
  minProfitScrap: Scrap | null;
  /** G3: tell me when a copy of it is on sale again on a page I read ("Back on scrap.tf"; "New on scrap.tf" at a first sighting). */
  onRestock: boolean;
  /** Off (paused): kept in the list, matched by nothing (no toast, row tag, chip or watch list entry). */
  enabled: boolean;
  createdAt: UnixMs;
  /** The last edit: a watch edited after a page's previous save is judged afresh on that page's next read (watchFresh). */
  updatedAt: UnixMs;
}

/** Repo.upsertWatch input: a watch without its times (and with its id for an update). */
export type ScraptfWatchWrite = Omit<ScraptfWatch, 'id' | 'createdAt' | 'updatedAt'> & { id?: number };

/** 'watches.upsert' params (watchWriteOf turns them into a ScraptfWatchWrite). */
export interface ScraptfWatchInput {
  /** Updates this watch (targets and switches it omits keep their values); omitted: adds one, or updates the watch of the same copy. */
  id?: number;
  /** Any SKU of the item: the service keeps its base (bankStockTargetOf). */
  sku: string;
  /** 'any': every copy of the base. 'one' (default): `special`, else the SKU's own copy (its paint, else a clean one). */
  copies?: 'one' | 'any';
  /** A bank_stock special key (a Bank stock row's copy, the drawer's copyKey); at most WATCH_SPECIAL_MAX characters; null or omitted: the SKU's own. */
  special?: string | null;
  name?: string;
  maxCostKeys?: number;
  maxCostScrap?: Scrap | null;
  minProfitScrap?: Scrap | null;
  onRestock?: boolean;
  enabled?: boolean;
}

/** ScraptfWatchView.now: the cheapest copy a watch covers on sale on the newest saves of your banks' pages, valued now. */
export interface ScraptfWatchNow {
  bank: ScraptfBank;
  /** That page's newest save. */
  savedAt: UnixMs;
  costKeys: number;
  costScrapRaw: Scrap;
  /** At the current key price. */
  costScrap: Scrap;
  revenueScrap: Scrap | null;
  profitScrap: Scrap | null;
  verdict: BankStockVerdict;
  met: ScraptfWatchMet | null;
  /** costScrap minus the price target at the current key price (above 0: that much over it); null without a price target. */
  overTargetScrap: Scrap | null;
}

/** 'watches.list': a watch and where it stands in your saves now. */
export interface ScraptfWatchView extends ScraptfWatch {
  /** null: no newest save of a page you saved lists a copy it covers on sale. */
  now: ScraptfWatchNow | null;
}

/** BankStockRow.watch. */
export interface BankStockRowWatch {
  id: number;
  /** A watch of every copy of the base. */
  anyCopy: boolean;
  /** The price target at the row's key price; null: none. */
  maxCostScrap: Scrap | null;
  minProfitScrap: Scrap | null;
  onRestock: boolean;
  /** What the row meets now (watchMetOf); null for neither, and for a gone row. */
  met: ScraptfWatchMet | null;
  /** costScrap minus the target (above 0: over it); null without a price target or for a gone row. */
  overTargetScrap: Scrap | null;
}

/**
 * 0.8: what a toast of the S3 notifier tells, in the order a read tells them (bankStockNotifyCandidates): a watch hit
 * (G1), a new flip (S3), a flip a read dropped under Pay up to (G2), a flip or watched copy back on sale (LC-7, G3),
 * a flip whose buy timing turned from Wait to Buy now (G4).
 */
export type BankStockNotifyKind = 'watch' | 'new' | 'cheaper' | 'back' | 'timing';
/** Every notifier kind, in the order a read tells them. */
export const BANK_STOCK_NOTIFY_KINDS: readonly BankStockNotifyKind[] = ['watch', 'new', 'cheaper', 'back', 'timing'];

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
  /** flipProfit(revenue, price, settings.profit); null without both. */
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
  /**
   * 0.8 (PC-1): what profitScrap took off the sale price (exitCostsOf(revenue, settings.profit)); null without a
   * revenue. Absent from an older service and on blank results.
   */
  exitCosts?: ExitCosts | null;
  /**
   * 0.9 (#2): breakEvensOf(price, settings.profit, 'buy') when the check has a scrap.tf price; absent otherwise (and from
   * an older service).
   */
  breakEven?: BreakEvens;
  /** 0.8 (PC-2): with verdict 'flip', the flip rests on the revenue order's buyer alone (singleExitOf). Absent otherwise. */
  singleExit?: SingleExit;
}

// ---------------------------------------------------------------------------
// Journal (manual trade log with FIFO profit)
// ---------------------------------------------------------------------------

/**
 * 'buy' and 'sell' rows and, from 0.8, 'writeoff': one unit used, lost or that will never sell. It closes the
 * oldest open lot like a sale that brings in nothing, so the lot's cost is booked as a loss (journalSummary).
 * Stored as TEXT (journal.side); a 0.7.4 build cannot open a V15 database, so it never meets one.
 */
export type JournalSide = 'buy' | 'sell' | 'writeoff';
/** Every journal side, as the service and the mock accept them. */
export const JOURNAL_SIDES: readonly JournalSide[] = ['buy', 'sell', 'writeoff'];

/** 0.8 (J2): a row's fee (a marketplace cut, a trade cost), keys and metal apart like the price. */
export interface JournalFee {
  keys: number;
  scrap: Scrap;
}

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
  /**
   * 0.8 (J2): the fee recorded with the row, both or neither. Absent is "not recorded" (journal.fee_keys and
   * fee_scrap NULL: every row written before 0.8); 0 is "none". A buy's fee is part of its cost, a sale's comes
   * off its proceeds (journalSummary). A write-off never has one.
   */
  feeKeys?: number;
  feeScrap?: Scrap;
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
  /**
   * 0.7.4 (F39): the key price (scrap) when the trade happened, for a backfill (a When well in the past);
   * omitted, the row stores today's. It values the pair's net keys (journalSummary), so a key move since the
   * trade never reads as profit.
   */
  keyPriceScrap?: Scrap;
  /** 0.8 (J2): the fee (JournalEntry.feeKeys/feeScrap): either one given records it, the other then 0. Refused on a write-off. */
  feeKeys?: number;
  feeScrap?: Scrap;
}

/**
 * 0.8 (J6): what 'journal.update' may change on a row: venue, note and fee. Side, item, price, time and key price
 * stay (delete the row and log it again). Fee (feePatchOf): both absent leaves it; null in one with the other null or
 * absent clears it (not recorded); a number in either sets both, the other 0.
 */
export interface JournalPatch {
  venue?: string;
  note?: string | null;
  feeKeys?: number | null;
  feeScrap?: Scrap | null;
}

/** One open buy, not yet matched by a sell. */
export interface JournalLot {
  /** The buy row's id. */
  id: number;
  ts: UnixMs;
  /** Valued at the buy row's own key price; 0.8: its recorded fee included. */
  costScrap: Scrap;
  /**
   * The cost basis, keys and metal apart: the price paid plus (0.8, J2) the buy's recorded fee, and the key price
   * that applied. A sale is netted against these per currency (journalSummary), so Holdings values them at today's
   * key price.
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

/**
 * 0.7.4 (F38): a sale with no buy of its item dated at or before it (an item owned before the app, or a buy
 * not recorded yet). Counted as neither profit nor a holding, and never matched against a later buy (another
 * copy): recording its buy dated before the sale matches it.
 */
export interface JournalWaitingSale {
  /** The sale row's id. */
  id: number;
  ts: UnixMs;
  sku: string;
  name: string;
  keys: number;
  scrap: Scrap;
  /** 0.8: a write-off with no open lot dated at or before it (keys and scrap 0); absent for a sale. */
  writeoff?: true;
}

/** 0.8 (J1): one sale or write-off and the FIFO buy it closed, as journalSummary booked it. Money at the sale's key price. */
export interface JournalClosedTrade {
  /** The sale's (or write-off's) row id. */
  sellId: number;
  /** The buy row it closed. */
  buyId: number;
  kind: 'sell' | 'writeoff';
  sku: string;
  name: string;
  boughtAt: UnixMs;
  soldAt: UnixMs;
  /** soldAt - boughtAt, never below 0 (a buy logged in the sale's own minute is 0). Between the logged rows. */
  heldMs: number;
  /** Both rows' venues as typed (venueLabel groups them for reports; stored text is never rewritten). */
  buyVenue: string;
  sellVenue: string;
  /** The buy's cost basis (price plus its recorded fee). */
  costScrap: Scrap;
  /** profitScrap + costScrap, so the three always add up; 0 for a write-off. */
  proceedsScrap: Scrap;
  /** Both rows' recorded fees; null when neither row recorded one. */
  feesScrap: Scrap | null;
  /** True when every row of the pair recorded its fee (a write-off has none to record). */
  feesKnown: boolean;
  /** Exactly what was booked: sum(closed.profitScrap) === realizedProfitScrap. */
  profitScrap: Scrap;
  /** The sale's key price, which every figure above is valued at. */
  keyPriceScrap: Scrap;
}

/** 0.8 (H5): how long the user's own sales took after the buy, from closed pairs; the user's habit, never a forecast. */
export interface TypicalHold {
  /** Median heldMs over `count` sales. */
  medianMs: number;
  count: number;
  /** 'item': this SKU's own sales (TYPICAL_HOLD_MIN_ITEM or more); 'all': every sale (TYPICAL_HOLD_MIN_ALL or more). */
  scope: 'item' | 'all';
  /**
   * Units still open in the journal at the read (of this SKU for 'item', of every item for 'all'). They are not in
   * the median, and the longest holds are often among them, so the texts say how many were left out.
   */
  stillHeld: number;
}

/** 0.9 (#12): the value bands a reserve is suggested for (reserveBandOf): under 10 ref, 10 ref to 1 key, 1 key and up. */
export type ReserveBand = 'under-10-ref' | 'to-1-key' | 'key-plus';

/** 0.9 (#12): how many hold-long windows of one source fell in a band, and from how many items. */
export interface ReserveSampleCount {
  windows: number;
  items: number;
}

/** 0.9 (#12): one band's suggestion. */
export interface ReserveBandSuggestion {
  band: ReserveBand;
  /**
   * The source the figure rests on: 'recorded' (holding_marks: the revenue order Flip Desk saw while it ran), else
   * 'pricedb' (PriceDB history 'item.detail' loaded this session); null: neither has RESERVE_MIN_WINDOWS windows from
   * RESERVE_MIN_ITEMS items.
   */
  source: 'recorded' | 'pricedb' | null;
  /** The 10th percentile (lowerQuantile) of that source's relative changes (-0.06 = a 6% fall); null with source null. */
  p10: number | null;
  /** suggestedPctOf(p10): a whole percent, 0 when p10 >= 0, at most EXIT_RESERVE_MAX_PCT; null with source null. */
  suggestedPct: number | null;
  recorded: ReserveSampleCount;
  pricedb: ReserveSampleCount;
}

/** 0.9 (#12): 'profit.reserveSuggestion' (reserveSuggestionOf in src/shared/reserveSuggest.ts). Never applied. */
export interface ReserveSuggestion {
  /** The horizon: the journal's typical hold over every sale, clamped to [1 h, 14 d], else RESERVE_DEFAULT_HOLD_MS (1 d). */
  holdMs: number;
  holdFrom: 'journal' | 'default';
  /** Sales behind the typical hold (0 with the default). */
  holdSales: number;
  /** Units still open that the typical hold leaves out (TypicalHold.stillHeld). */
  holdStillHeld: number;
  /**
   * The journal's typical hold when the [1 h, 14 d] clamp changed it (holdMs is then the bound, not the user's hold);
   * null when holdMs is the typical hold itself or the default. Optional: absent reads as null.
   */
  holdClampedFromMs?: number | null;
  lookbackMs: number;
  /**
   * When the buyer settings last changed: recorded windows start at it, none from before it (only the latest change is
   * kept, so an earlier one is unknown); null when no change is known.
   */
  settingsAt: UnixMs | null;
  /** RESERVE_BANDS order. */
  bands: ReserveBandSuggestion[];
  keyScrap: Scrap;
  generatedAt: UnixMs;
}

export interface JournalSummary {
  /** Sum of closed[].profitScrap. */
  realizedProfitScrap: Scrap;
  /** closed.length: sales and (0.8) write-offs that closed a buy. */
  realizedTrades: number;
  open: JournalPosition[];
  bySku: { sku: string; name: string; realizedProfitScrap: Scrap; trades: number }[];
  /** 0.7.4 (F38): sales with no earlier buy, oldest first. */
  waitingSales: JournalWaitingSale[];
  /** 0.8 (J1): every sale or write-off that closed a buy, oldest sale first. */
  closed: JournalClosedTrade[];
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
  /** 0.8 (LC-5): per saved bank, how stable scrap.tf's item ids are across your saves. */
  scraptfAssetIds?: ScraptfAssetIdsHealth[];
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
  /**
   * 0.8 (PC-1): the price-move reserve, a share of the sale price (0 to 0.5) taken off every buy decision's profit
   * (flipProfit in src/shared/ceiling.ts: ceil(revenue x pct)) for a drop between buying on scrap.tf and the buyer
   * accepting. The user's own allowance, never measured. 0 (the default) changes nothing. Never applied to a sale into
   * a live order (Holdings' sale now and its next buyer, Record sale); Holdings' advice includes it for exits nobody
   * pays today (a listing, a recorded high, a reference).
   */
  exitReservePct: number;
  /**
   * 0.9 (#2): what marketplace.tf keeps of a sale (0 to 0.5), the user's own figure: about 10% rests on one 2019 forum
   * comment. Used for marketplace.tf's break-even price and the journal's fee hint only, never for profit.
   */
  marketplaceFeePct: number;
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
  /** 0.7.1: ImportResult.stored (prices written). Absent: not reported. */
  stored?: number;
  /** 0.7.1: ImportResult.pageFlips (flips on sale on this save). Absent: not reported. */
  pageFlips?: number;
  /** 0.7.1: the first of ImportResult.topFlips; null or absent when none. */
  bestFlip?: { sku: string; name: string; profitScrap: Scrap } | null;
  /** 0.8 (G2): ImportResult.droppedFlips. Absent: not reported. */
  droppedFlips?: number;
  /**
   * 0.7.4 (F53): ImportResult.stockSave. 'unsettled': the page was left before its settle read, so the read
   * stored prices but no bank stock save (ACT-4). Absent: not reported (an older service, a failed read).
   */
  stockSave?: 'written' | 'partial' | 'unsettled' | 'none';
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
  /** 0.7.1 (F21-4): the page on screen is one the import reads (scraptfImportablePath). Absent: as before. */
  importable?: boolean;
  /**
   * 0.7.1 (F21-3, F21-10): one fixed-text notice about the page on screen (a challenge, a 429, a load error,
   * a crash, a blocked link); never page content. Absent or null: none.
   */
  notice?: string | null;
}

/** F21 'scraptfWindow.state': the window as main holds it (a toolbar that loads late asks for it). */
export interface ScraptfWindowState {
  open: boolean;
  /** As ScraptfWindowNav.url. */
  url: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  lastRead: ScraptfWindowRead | null;
  /**
   * 0.7.1 (F21-6): "Stay signed in" changed while the window is open; it applies when the window is closed
   * and opened again. Absent: false.
   */
  pendingPartitionChange?: boolean;
}

/** 0.7.1 'app.showBankStock' / push 'ui.openBankStock': which chip a bank's stock page opens on. 0.8 (G5): 'watched' (a summary of watch toasts). */
export type BankStockOpenFilter = 'flips' | 'new' | 'watched';
export const BANK_STOCK_OPEN_FILTERS: readonly BankStockOpenFilter[] = ['flips', 'new', 'watched'];

/** 0.7.1 'app.showBankStock' params and the 'ui.openBankStock' push: a bank's stock page on one chip. */
export interface BankStockOpen {
  bank: ScraptfBank;
  filter: BankStockOpenFilter;
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

/** 0.7.3: each field's longest value, shared by the settings schema (main) and the Import page's inputs, so the page never accepts a value main refuses. */
export const PERMISSION_FIELD_MAX: Readonly<Record<keyof PermissionRecord, number>> = { grantor: 200, contact: 200, grantedAt: 100, scope: 1000 };

/** 0.9 (#1): what Steam does to a TF2 item the user receives, as the user says: not sure, no lock, or Trade Protection's 7 days. */
export type TradeLockMode = 'unknown' | 'none' | '7d';
/** 0.9 (#1): every TradeLockMode, in Settings' order (settingsSchema's enum reads it). */
export const TRADE_LOCK_MODES: readonly TradeLockMode[] = ['unknown', 'none', '7d'];

/** 0.9 (#1) Settings.tradeLock. Flip Desk cannot read the user's account; this is the user's answer. */
export interface TradeLockSettings {
  /** Default 'unknown': only a caution. '7d': Holdings counts the lock (advice, Sellable now, "Sell:" timing); prices unchanged. */
  mode: TradeLockMode;
  /** When the user last answered (Holdings' card or Settings); null: never, so Holdings asks. */
  answeredAt: UnixMs | null;
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
    /** 0.8 (G1, G3): "Watch (<Bank>): <name>" and "Back on scrap.tf" toasts for the items you watch, and a watch's profit target as that copy's "Profit:" bar. */
    watches: boolean;
    /**
     * 0.8 (G4): "Buy now (<Bank>): <name>" when a read turns a flip's buy timing from Wait to Buy now. Off by default:
     * 0.7.4 sent no such toast (D25). Needs newOnScraptf too.
     */
    buyTiming: boolean;
    /**
     * 0.9 (#3, risk control): 0 (the default) is off. 1-10: the toasts that tell a flip (the engine's Profit, Watch and
     * Candidate; the scrap.tf notifier's New, Cheaper and Back flips and Buy now) wait until at least this many
     * distinct buyers seen in the last 24 h clear break-even at the flip's cost (Opportunity.profitableDepth). 2 asks for
     * a backup buyer. Rows and verdicts are unchanged; a held-back flip is not recorded as told. The scrap.tf notifier's
     * watch price/profit hits, Sell toasts and the Live check are not held back; the engine's Watch toast (a typed or
     * imported price at a watch's profit target) is.
     */
    minProfitableDepth: number;
  };
  app: { startAtLogin: boolean; startHidden: boolean; closeToTray: boolean; quickEntryHotkey: string };
  /** Live check (F16): the check hotkey, the opt-in clipboard watcher and the popup. */
  check: CheckSettings;
  /** F21: the opt-in scrap.tf window. */
  scraptfWindow: ScraptfWindowSettings;
  networkPaused: boolean;
  /** Steam IDs whose buy orders are never used. */
  blocklist: string[];
  /**
   * 0.8 (H3): the user's own SteamID64s. Their backpack.tf sell listings are left out of "Others ask"
   * (HoldingRow.ask, ItemDetail.ask). [] (the default): none known, so the lowest ask may be the user's own.
   * A filter only: the app signs in to nothing and acts for no account (R4, R5). Stored in settings.json, never sent.
   */
  ownSteamIds: string[];
  /** 0.9 (#1): Steam's Trade Protection as the user knows it (Holdings only). */
  tradeLock: TradeLockSettings;
  ui: { theme: 'system' | 'dark' | 'light'; density: 'comfortable' | 'compact' };
}

export type SecretName = 'bptfApiKey' | 'bptfAccessToken' | 'steamApiKey';
export const SECRET_NAMES: readonly SecretName[] = ['bptfApiKey', 'bptfAccessToken', 'steamApiKey'];
export type SecretsStatus = Record<SecretName, boolean>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
