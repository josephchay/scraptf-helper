// Repo implementation on node:sqlite. JSON TEXT columns hold nested objects,
// booleans are INTEGER 0/1, and NULLs round-trip as null. JSON read back from
// the database is validated defensively so a damaged row degrades to safe
// defaults instead of crashing the service.

import { statSync } from 'node:fs';
import { z } from 'zod';
import type {
  BptfNameRow,
  EffectRow,
  PaintRow,
  PaintkitRow,
  Repo,
  SchemaItemRow,
} from '../contracts';
import { bankStockThinning, type BankStockThinSave } from '../../shared/bankStock';
import { opportunityCopyKey } from '../../shared/copyExtras';
import { cleanCategoryCounts } from '../../shared/market';
import { SCRAPTF_CHANGES_DEFAULT_LIMIT, SCRAPTF_EVENTS_MAX_AGE_MS, SCRAPTF_ITEM_EVENTS } from '../../shared/scraptfHistory';
import { HOLDING_DETAIL_MAX_MARKS, HOLDING_MARKS_MAX_AGE_MS, HOLDING_MARKS_PER_BASE_MAX } from '../../shared/holdingAdvice';
import { feePatchOf } from '../../shared/journal';
import { WATCH_ANY_COPY_SENTINEL, WATCH_COPY_TAKEN } from '../../shared/watches';
import { CATEGORIES, IMPORT_ORIGINS, JOURNAL_SIDES, SCRAPTF_BANK_IDS, SCRAPTF_CHANGE_KINDS, SCRAPTF_LIST_CRAFTS } from '../../shared/types';
import type {
  BankNewestSave,
  BankStockSave,
  BankStockStored,
  CommunityRow,
  ConfidenceLevel,
  GroupBy,
  HoldingMark,
  ImportBatch,
  ImportOrigin,
  ImportPageKind,
  InputKind,
  Intent,
  JournalEntry,
  KeyPriceQuote,
  KeyPriceSource,
  Listing,
  OppQuery,
  Opportunity,
  OpportunityEvent,
  OpportunityEventKind,
  OpportunityStatus,
  OrderSummary,
  PriceRule,
  PricedbRow,
  PriceSource,
  ProfitTier,
  ReferencePrices,
  RequestLogRow,
  RuleFilter,
  ScrapPrice,
  ScraptfBank,
  ScraptfChangeKind,
  ScraptfEventStored,
  ScraptfListStored,
  ScraptfWatch,
  SpecialAttrs,
  UnixMs,
} from '../../shared/types';
import { chunk, escapeLike, placeholders } from './db';
import type { SqlRow, SqlValue, SqliteDb } from './db';

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

type Out = SqlRow[string] | undefined;

const INTENTS: readonly Intent[] = ['buy', 'sell'];
const ORIGINS: readonly Listing['origin'][] = ['ws', 'snapshot'];
const PRICE_SOURCES: readonly PriceSource[] = ['user', 'import'];
const KEY_SOURCES: readonly KeyPriceSource[] = ['bptf', 'pricedb', 'manual'];
const INPUT_KINDS: readonly InputKind[] = ['user', 'import', 'rule'];
const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ['high', 'medium', 'low'];
const PROFIT_TIERS: readonly ProfitTier[] = ['key', 'ref10', 'ref2', 'small', 'loss', 'none'];
const STATUSES: readonly OpportunityStatus[] = ['profitable', 'below-threshold', 'unprofitable', 'no-buyers'];
const EVENT_KINDS: readonly OpportunityEventKind[] = ['appeared', 'changed', 'gone', 'notified'];
const PAGE_KINDS: readonly ImportPageKind[] = ['buy', 'unusuals', 'items-list', 'unknown'];
const EFFECT_TYPES: readonly EffectRow['type'][] = ['cosmetic', 'weapon', 'taunt', 'other'];

const META_SCHEMA_FETCHED_AT = 'schema.fetchedAt';
const META_SCHEMA_ETAG = 'schema.etag';

const EVENTS_DEFAULT_LIMIT = 200;
const EVENTS_MAX_LIMIT = 5000;
/** 0.8 (H1): Repo.holdingMarks reads at most this many runs per call. */
const HOLDING_MARKS_MAX_LIMIT = 5000;
const GENERIC_MAX_LIMIT = 100_000;

function num(v: Out, fallback = 0): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function numOrNull(v: Out): number | null {
  if (v === null || v === undefined) return null;
  const n = num(v, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

function str(v: Out, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return fallback;
}

function strOrNull(v: Out): string | null {
  return v === null || v === undefined ? null : str(v);
}

function bool(v: Out): boolean {
  return num(v, 0) !== 0;
}

function boolOrNull(v: Out): boolean | null {
  return v === null || v === undefined ? null : bool(v);
}

function oneOf<T extends string>(v: Out, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** A stored or incoming bank id (F15); anything else (a newer build's id, damage) reads as unknown. */
function bankOrNull(v: unknown): ScraptfBank | null {
  return typeof v === 'string' && (SCRAPTF_BANK_IDS as readonly string[]).includes(v) ? (v as ScraptfBank) : null;
}

/** F21: a stored import origin, or null for anything else (batches before V9, an unknown value). */
function originOrNull(v: unknown): ImportOrigin | null {
  return typeof v === 'string' && (IMPORT_ORIGINS as readonly string[]).includes(v) ? (v as ImportOrigin) : null;
}

function bindNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bindNumOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bindStrOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function bindBool(v: unknown): number {
  return v ? 1 : 0;
}

function bindBoolOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : v ? 1 : 0;
}

function requireFinite(field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${field} must be a finite number`);
  return v;
}

function requireText(field: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return v;
}

function requireId(field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new TypeError(`${field} must be a positive integer`);
  return v;
}

/** 0.8: a finite number of 0 or more (a journal fee part, a watch target). */
function requireNonNeg(field: string, v: unknown): number {
  const n = requireFinite(field, v);
  if (n < 0) throw new TypeError(`${field} must be zero or more`);
  return n;
}

/** 0.8 (J2): one part of a recorded fee; absent reads 0 (the other part was given). */
function feeNum(field: string, v: unknown): number {
  return v === undefined ? 0 : requireNonNeg(field, v);
}

function clampLimit(v: unknown, fallback: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(v)));
}

function parseJson(text: Out): unknown {
  if (typeof text !== 'string' || text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((v): v is string => typeof v === 'string'))];
}

/** INSERT ... ON CONFLICT(key) DO UPDATE for every non-key column. */
function upsertSql(table: string, cols: readonly string[], keyCols: readonly string[]): string {
  const q = (c: string) => `"${c}"`;
  const updates = cols.filter((c) => !keyCols.includes(c)).map((c) => `${q(c)} = excluded.${q(c)}`);
  return (
    `INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES (${placeholders(cols.length)}) ` +
    `ON CONFLICT(${keyCols.map(q).join(', ')}) DO UPDATE SET ${updates.join(', ')}`
  );
}

// ---------------------------------------------------------------------------
// JSON column schemas (loose: unknown keys written by newer builds survive)
// ---------------------------------------------------------------------------

const nullableNumber = z.number().nullable().catch(null);
const stringArray = z.array(z.string()).catch(() => []);

const specialSchema = z.looseObject({
  paint: nullableNumber,
  spells: stringArray,
  parts: stringArray,
  sheen: nullableNumber,
  killstreaker: nullableNumber,
  customName: z.boolean().catch(false),
  customDesc: z.boolean().catch(false),
});

const orderSummarySchema = z.looseObject({
  listingId: z.string(),
  steamid: z.string(),
  userName: z.string().nullable().catch(null),
  keys: z.number().catch(0),
  metalScrap: z.number().catch(0),
  valueScrap: z.number().catch(0),
  isBot: z.boolean().catch(false),
  online: z.boolean().nullable().catch(null),
  lastEventAt: z.number().catch(0),
  bumpedAt: nullableNumber,
  details: z.string().catch(''),
  flags: stringArray,
  eligible: z.boolean().catch(false),
});

const referencesSchema = z.looseObject({
  pricedb: z
    .looseObject({ buyScrap: nullableNumber, sellScrap: nullableNumber, time: nullableNumber, ageMs: nullableNumber })
    .nullable()
    .catch(null),
  community: z
    .looseObject({ valueScrap: nullableNumber, valueHighScrap: nullableNumber, lastUpdate: nullableNumber })
    .nullable()
    .catch(null),
});

const ruleFilterSchema = z.looseObject({
  categories: z.array(z.string()).optional(),
  qualities: z.array(z.number()).optional(),
  craftable: z.boolean().nullable().optional(),
  australium: z.boolean().nullable().optional(),
  // 0.7.4 (F79)
  festive: z.boolean().nullable().optional(),
  elevated: z.boolean().nullable().optional(),
  killstreak: z.array(z.number()).optional(),
  hasEffect: z.boolean().nullable().optional(),
  defindexes: z.array(z.number()).optional(),
  nameContains: z.string().nullable().optional(),
});

function emptySpecial(): SpecialAttrs {
  return { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };
}

function isEmptySpecial(s: SpecialAttrs | null | undefined): boolean {
  return (
    !s ||
    (s.paint == null &&
      !(s.spells?.length > 0) &&
      !(s.parts?.length > 0) &&
      s.sheen == null &&
      s.killstreaker == null &&
      !s.customName &&
      !s.customDesc)
  );
}

function parseSpecial(text: Out): SpecialAttrs | null {
  const r = specialSchema.safeParse(parseJson(text));
  return r.success ? r.data : null;
}

function parseOrder(text: Out): OrderSummary | null {
  if (text === null || text === undefined) return null;
  const r = orderSummarySchema.safeParse(parseJson(text));
  return r.success ? r.data : null;
}

function parseReferences(text: Out): ReferencePrices {
  const r = referencesSchema.safeParse(parseJson(text));
  return r.success ? r.data : { pricedb: null, community: null };
}

function parseStringArray(text: Out): string[] {
  const r = stringArray.safeParse(parseJson(text));
  return r.success ? r.data : [];
}

function parseRuleFilter(text: Out): RuleFilter | null {
  const r = ruleFilterSchema.safeParse(parseJson(text));
  if (!r.success) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r.data)) if (v !== undefined) out[k] = v;
  return out as RuleFilter;
}

// Listing notes sometimes contain a pasted Steam trade URL; another user's trade
// token must never be persisted (design brief §7.3 #12).
const TRADE_TOKEN_RE = /\btoken=[A-Za-z0-9_-]+/gi;

export function scrubTradeTokens(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(TRADE_TOKEN_RE, 'token=[removed]');
}

function jsonOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const LISTING_COLS = [
  'id',
  'sku',
  'base_sku',
  'intent',
  'steamid',
  'user_name',
  'keys',
  'metal_scrap',
  'is_bot',
  'ua_client',
  'ua_last_pulse',
  'user_online',
  'user_banned',
  'is_marketplace',
  'special',
  'details',
  'listed_at',
  'bumped_at',
  'last_event_at',
  'origin',
  'item_name',
  'market_name',
] as const;

function listingParams(l: Listing): SqlValue[] {
  return [
    String(l.id),
    String(l.sku),
    String(l.baseSku),
    String(l.intent),
    String(l.steamid ?? ''),
    bindStrOrNull(l.userName),
    bindNum(l.keys),
    bindNum(l.metalScrap),
    bindBool(l.isBot),
    bindStrOrNull(l.uaClient),
    bindNumOrNull(l.uaLastPulse),
    bindBoolOrNull(l.userOnline),
    bindBool(l.userBanned),
    bindBool(l.isMarketplace),
    isEmptySpecial(l.special) ? null : JSON.stringify(l.special),
    scrubTradeTokens(l.details),
    bindNumOrNull(l.listedAt),
    bindNumOrNull(l.bumpedAt),
    bindNum(l.lastEventAt),
    String(l.origin),
    bindStrOrNull(l.itemName),
    bindStrOrNull(l.marketName),
  ];
}

function rowToListing(r: SqlRow): Listing {
  return {
    id: str(r['id']),
    sku: str(r['sku']),
    baseSku: str(r['base_sku']),
    intent: oneOf(r['intent'], INTENTS, 'buy'),
    steamid: str(r['steamid']),
    userName: strOrNull(r['user_name']),
    keys: num(r['keys']),
    metalScrap: num(r['metal_scrap']),
    isBot: bool(r['is_bot']),
    uaClient: strOrNull(r['ua_client']),
    uaLastPulse: numOrNull(r['ua_last_pulse']),
    userOnline: boolOrNull(r['user_online']),
    userBanned: bool(r['user_banned']),
    isMarketplace: bool(r['is_marketplace']),
    special: r['special'] === null || r['special'] === undefined ? emptySpecial() : (parseSpecial(r['special']) ?? emptySpecial()),
    details: str(r['details']),
    listedAt: numOrNull(r['listed_at']),
    bumpedAt: numOrNull(r['bumped_at']),
    lastEventAt: num(r['last_event_at']),
    origin: oneOf(r['origin'], ORIGINS, 'ws'),
    itemName: strOrNull(r['item_name']),
    marketName: strOrNull(r['market_name']),
  };
}

const OPP_COLS = [
  'key',
  'sku',
  'name',
  'category',
  'input_ref',
  'input_kind',
  'cost_keys',
  'cost_scrap_raw',
  'cost_scrap',
  'best_scrap',
  'cons_scrap',
  'instant_scrap',
  'revenue_scrap',
  'profit_scrap',
  'margin',
  'confidence',
  'confidence_level',
  'flags',
  'reasons',
  'buyer_count',
  'best_order',
  'cons_order',
  'instant_order',
  'refs',
  'profit_tier',
  'status',
  'input_observed_at',
  'first_seen_at',
  'updated_at',
  'max_cost_scrap',
] as const;

function oppParams(o: Opportunity): SqlValue[] {
  return [
    String(o.key),
    String(o.sku),
    String(o.name ?? ''),
    String(o.category),
    String(o.inputRef ?? ''),
    String(o.inputKind),
    bindNum(o.costKeys),
    bindNum(o.costScrapRaw),
    bindNum(o.costScrap),
    bindNumOrNull(o.bestScrap),
    bindNumOrNull(o.consScrap),
    bindNumOrNull(o.instantScrap),
    bindNumOrNull(o.revenueScrap),
    bindNumOrNull(o.profitScrap),
    bindNumOrNull(o.margin),
    bindNum(o.confidence),
    String(o.confidenceLevel),
    JSON.stringify(Array.isArray(o.flags) ? o.flags : []),
    JSON.stringify(Array.isArray(o.reasons) ? o.reasons : []),
    bindNum(o.buyerCount),
    jsonOrNull(o.bestOrder),
    jsonOrNull(o.consOrder),
    jsonOrNull(o.instantOrder),
    JSON.stringify(o.references ?? { pricedb: null, community: null }),
    String(o.profitTier),
    String(o.status),
    bindNum(o.inputObservedAt),
    bindNum(o.firstSeenAt),
    bindNum(o.updatedAt),
    bindNumOrNull(o.maxCostScrap),
  ];
}

/**
 * 0.7.4 (F66): every opportunity read, with its price input's SKU and extras (one rowid seek each into
 * scrap_prices; NULL for a rule or a price since deleted), so rowToOpportunity derives Opportunity.copyKey
 * without a stored column. Scalar subqueries, so oppWhere / oppOrder keep their unqualified columns.
 */
const OPP_PRICE_ID = "(CASE WHEN opportunities.input_ref LIKE 'price:%' THEN CAST(substr(opportunities.input_ref, 7) AS INTEGER) END)";
const OPP_SELECT =
  `SELECT opportunities.*, (SELECT cp.sku FROM scrap_prices cp WHERE cp.id = ${OPP_PRICE_ID}) AS copy_sku, ` +
  `(SELECT cp.special FROM scrap_prices cp WHERE cp.id = ${OPP_PRICE_ID}) AS copy_special FROM opportunities`;

/** 0.7.4 (F66): Opportunity.copyKey from OPP_SELECT's price columns; absent for a plain copy, a rule or no price row. */
function copyKeyOfRow(r: SqlRow): string {
  const sku = r['copy_sku'];
  if (typeof sku !== 'string' || str(r['input_kind']) === 'rule') return '';
  const special = r['copy_special'] === null || r['copy_special'] === undefined ? null : parseSpecial(r['copy_special']);
  return opportunityCopyKey(sku, special);
}

function rowToOpportunity(r: SqlRow): Opportunity {
  const copyKey = copyKeyOfRow(r);
  return {
    key: str(r['key']),
    sku: str(r['sku']),
    name: str(r['name']),
    category: oneOf(r['category'], CATEGORIES, 'other'),
    inputRef: str(r['input_ref']),
    inputKind: oneOf(r['input_kind'], INPUT_KINDS, 'user'),
    ...(copyKey !== '' ? { copyKey } : {}),
    costKeys: num(r['cost_keys']),
    costScrapRaw: num(r['cost_scrap_raw']),
    costScrap: num(r['cost_scrap']),
    bestScrap: numOrNull(r['best_scrap']),
    consScrap: numOrNull(r['cons_scrap']),
    instantScrap: numOrNull(r['instant_scrap']),
    revenueScrap: numOrNull(r['revenue_scrap']),
    profitScrap: numOrNull(r['profit_scrap']),
    margin: numOrNull(r['margin']),
    // Migration V2; NULL for rows written before it, until the engine re-evaluates them.
    maxCostScrap: numOrNull(r['max_cost_scrap']),
    confidence: num(r['confidence']),
    confidenceLevel: oneOf(r['confidence_level'], CONFIDENCE_LEVELS, 'low'),
    flags: parseStringArray(r['flags']),
    reasons: parseStringArray(r['reasons']),
    buyerCount: num(r['buyer_count']),
    bestOrder: parseOrder(r['best_order']),
    consOrder: parseOrder(r['cons_order']),
    instantOrder: parseOrder(r['instant_order']),
    references: parseReferences(r['refs']),
    profitTier: oneOf(r['profit_tier'], PROFIT_TIERS, 'none'),
    status: oneOf(r['status'], STATUSES, 'no-buyers'),
    inputObservedAt: num(r['input_observed_at']),
    firstSeenAt: num(r['first_seen_at']),
    updatedAt: num(r['updated_at']),
  };
}

function rowToEvent(r: SqlRow): OpportunityEvent {
  return {
    id: num(r['id']),
    key: str(r['key']),
    sku: str(r['sku']),
    name: str(r['name']),
    category: oneOf(r['category'], CATEGORIES, 'other'),
    kind: oneOf(r['kind'], EVENT_KINDS, 'changed'),
    profitScrap: numOrNull(r['profit_scrap']),
    costScrap: numOrNull(r['cost_scrap']),
    revenueScrap: numOrNull(r['revenue_scrap']),
    confidence: num(r['confidence']),
    summary: str(r['summary']),
    ts: num(r['ts']),
  };
}

function rowToScrapPrice(r: SqlRow): ScrapPrice {
  return {
    id: num(r['id']),
    sku: str(r['sku']),
    name: str(r['name']),
    costKeys: num(r['cost_keys']),
    costScrap: num(r['cost_scrap']),
    source: oneOf(r['source'], PRICE_SOURCES, 'user'),
    observedAt: num(r['observed_at']),
    note: strOrNull(r['note']),
    importBatch: numOrNull(r['import_batch']),
    special: r['special'] === null || r['special'] === undefined ? null : parseSpecial(r['special']),
    assetId: strOrNull(r['asset_id']),
    stock: numOrNull(r['stock']),
    // Joined from the row's import batch (PRICE_SELECT); typed rows read null.
    bank: bankOrNull(r['bank']),
  };
}

/**
 * Every scrap_prices read: the row plus its import batch's bank (F15). Columns must be qualified (both
 * tables have id). Imported rows only: an imported price edited by hand turns 'user' but keeps its
 * import_batch (prices.upsert keeps omitted fields), and a typed price was seen on no page.
 */
const PRICE_SELECT =
  "SELECT sp.*, ib.bank AS bank FROM scrap_prices sp LEFT JOIN import_batches ib ON ib.id = sp.import_batch AND sp.source = 'import'";
const PRICE_ORDER = 'ORDER BY sp.observed_at DESC, sp.id DESC';

function rowToRule(r: SqlRow): PriceRule {
  const filter = parseRuleFilter(r['filter_json']);
  return {
    id: num(r['id']),
    name: str(r['name']),
    filter: filter ?? {},
    costKeys: num(r['cost_keys']),
    costScrap: num(r['cost_scrap']),
    observedAt: num(r['observed_at']),
    // An unreadable filter would otherwise match every item; keep such a rule switched off.
    enabled: filter !== null && bool(r['enabled']),
  };
}

function rowToJournal(r: SqlRow): JournalEntry {
  const feeKeys = numOrNull(r['fee_keys']);
  const feeScrap = numOrNull(r['fee_scrap']);
  return {
    id: num(r['id']),
    ts: num(r['ts']),
    side: oneOf(r['side'], JOURNAL_SIDES, 'buy'),
    venue: str(r['venue']),
    sku: str(r['sku']),
    name: str(r['name']),
    keys: num(r['keys']),
    scrap: num(r['scrap']),
    keyPriceScrap: num(r['key_price_scrap']),
    note: strOrNull(r['note']),
    // 0.8 (J2): NULL in both is not recorded, and the row then has no fee fields
    ...(feeKeys !== null || feeScrap !== null ? { feeKeys: feeKeys ?? 0, feeScrap: feeScrap ?? 0 } : {}),
  };
}

/** 0.8 (G1): a stored watch; remind_at (reserved for T9) is not read. */
function rowToWatch(r: SqlRow): ScraptfWatch {
  return {
    id: num(r['id']),
    sku: str(r['sku']),
    specialKey: strOrNull(r['special_key']),
    name: str(r['name']),
    maxCostKeys: num(r['max_cost_keys']),
    maxCostScrap: numOrNull(r['max_cost_scrap']),
    minProfitScrap: numOrNull(r['min_profit_scrap']),
    onRestock: bool(r['on_restock']),
    enabled: bool(r['enabled']),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at']),
  };
}

function rowToBptfName(r: SqlRow): BptfNameRow {
  return {
    sku: str(r['sku']),
    name: str(r['name']),
    marketName: strOrNull(r['market_name']),
    lastSeen: num(r['last_seen']),
  };
}

function rowToPricedb(r: SqlRow): PricedbRow {
  return {
    sku: str(r['sku']),
    name: str(r['name']),
    buyKeys: num(r['buy_keys']),
    buyScrap: num(r['buy_scrap']),
    sellKeys: num(r['sell_keys']),
    sellScrap: num(r['sell_scrap']),
    time: num(r['time']),
    fetchedAt: num(r['fetched_at']),
  };
}

function rowToCommunity(r: SqlRow): CommunityRow {
  return {
    sku: str(r['sku']),
    currency: str(r['currency']),
    value: num(r['value']),
    valueHigh: numOrNull(r['value_high']),
    lastUpdate: numOrNull(r['last_update']),
  };
}

function rowToKeyQuote(r: SqlRow): KeyPriceQuote {
  // 0.7.4 (F71, migration V14): NULL (a quote stored before it, or a source that gave no time) reads as absent.
  const priceAt = numOrNull(r['price_at']);
  return {
    source: oneOf(r['source'], KEY_SOURCES, 'manual'),
    buyScrap: numOrNull(r['buy_scrap']),
    sellScrap: numOrNull(r['sell_scrap']),
    observedAt: num(r['observed_at']),
    ...(priceAt !== null ? { priceAt } : {}),
  };
}

function rowToSchemaItem(r: SqlRow): SchemaItemRow {
  return {
    defindex: num(r['defindex']),
    name: str(r['name']),
    itemName: str(r['item_name']),
    properName: bool(r['proper_name']),
    itemClass: str(r['item_class']),
    slot: strOrNull(r['slot']),
    craftClass: strOrNull(r['craft_class']),
    usedByClasses: parseStringArray(r['used_by_classes']),
    imageUrl: strOrNull(r['image_url']),
  };
}

function rowToEffect(r: SqlRow): EffectRow {
  return {
    id: num(r['id']),
    name: str(r['name']),
    canonicalId: num(r['canonical_id']),
    type: oneOf(r['type'], EFFECT_TYPES, 'other'),
  };
}

function rowToPaint(r: SqlRow): PaintRow {
  return { decimal: num(r['decimal']), hex: str(r['hex']), name: str(r['name']), bluHex: strOrNull(r['blu_hex']) };
}

function rowToPaintkit(r: SqlRow): PaintkitRow {
  return { id: num(r['id']), name: str(r['name']) };
}

function rowToImportBatch(r: SqlRow): ImportBatch {
  return {
    id: num(r['id']),
    fileName: str(r['file_name']),
    pageKind: oneOf(r['page_kind'], PAGE_KINDS, 'unknown'),
    fileMtime: num(r['file_mtime']),
    importedAt: num(r['imported_at']),
    itemCount: num(r['item_count']),
    categories: cleanCategoryCounts(parseJson(r['categories'])),
    bank: bankOrNull(r['bank']),
    origin: originOrNull(r['origin']),
  };
}

function rowToScraptfList(r: SqlRow): ScraptfListStored {
  return {
    sku: str(r['sku']),
    name: str(r['name']),
    sellsKeys: numOrNull(r['sells_keys']),
    sellsScrap: numOrNull(r['sells_scrap']),
    paysKeys: numOrNull(r['pays_keys']),
    paysScrap: numOrNull(r['pays_scrap']),
    stock: numOrNull(r['stock']),
    stockLimit: numOrNull(r['stock_limit']),
    batchId: num(r['batch_id']),
    observedAt: num(r['observed_at']),
    // 0.7.4 (V14): an unknown value (damage, a newer build's) reads as unproven.
    craft: oneOf(r['craft'], SCRAPTF_LIST_CRAFTS, 'any'),
    // 0.7.4 (V14, F60): the page it was read on; '' (not known) is left out.
    ...(typeof r['page'] === 'string' && r['page'] !== '' ? { page: str(r['page']) } : {}),
  };
}

/** A whole count of 0 or more, else null (stock and limit from a saved page). */
function bindCountOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function rowToBankStock(r: SqlRow): BankStockStored {
  const costScrap = numOrNull(r['cost_scrap']);
  return {
    sku: str(r['sku']),
    specialKey: str(r['special_key']),
    name: str(r['name']),
    // Both or neither: a row with no price to buy reads null for both.
    costKeys: costScrap === null ? null : num(r['cost_keys']),
    costScrap,
    stock: numOrNull(r['stock']),
    assetId: strOrNull(r['asset_id']),
    // 0.7.4 (V14): the /items list's rows only; a card's NULL is left out, an unknown value reads as unproven.
    ...(r['craft'] === null || r['craft'] === undefined ? {} : { craft: oneOf(r['craft'], SCRAPTF_LIST_CRAFTS, 'any') }),
  };
}

/** A stored change event; a row with an unknown bank or kind (a newer build's, damage) is left out. */
function rowToScraptfEvent(r: SqlRow): ScraptfEventStored[] {
  const bank = bankOrNull(r['bank']);
  const kind = r['kind'];
  if (bank === null || typeof kind !== 'string' || !(SCRAPTF_CHANGE_KINDS as readonly string[]).includes(kind)) return [];
  const fromScrap = numOrNull(r['from_scrap']);
  const toScrap = numOrNull(r['to_scrap']);
  return [
    {
      id: num(r['id']),
      at: num(r['at']),
      bank,
      page: str(r['page']),
      sku: str(r['sku']),
      specialKey: str(r['special_key']),
      name: str(r['name']),
      kind: kind as ScraptfChangeKind,
      // Both or neither, as bank_stock: a side with no price reads null for both.
      fromKeys: fromScrap === null ? null : num(r['from_keys']),
      fromScrap,
      toKeys: toScrap === null ? null : num(r['to_keys']),
      toScrap,
      fromStock: numOrNull(r['from_stock']),
      toStock: numOrNull(r['to_stock']),
      batchId: num(r['batch_id']),
    },
  ];
}

/**
 * 0.8 (H1): a stored exit run. Each price side is both or neither, as bank_stock: a side whose metal is NULL reads
 * null for its keys too. The 0/1 flags read as booleans, NULL as null.
 */
function rowToHoldingMark(r: SqlRow): HoldingMark {
  const revMetal = numOrNull(r['rev_metal_scrap']);
  const bestMetal = numOrNull(r['best_metal_scrap']);
  const nextMetal = numOrNull(r['next_metal_scrap']);
  const askMetal = numOrNull(r['ask_metal_scrap']);
  const paysScrap = numOrNull(r['scraptf_pays_scrap']);
  return {
    id: num(r['id']),
    baseSku: str(r['base_sku']),
    fromAt: num(r['from_at']),
    toAt: num(r['to_at']),
    revKeys: revMetal === null ? null : num(r['rev_keys']),
    revMetalScrap: revMetal,
    revIsBot: boolOrNull(r['rev_is_bot']),
    revVerified: boolOrNull(r['rev_verified']),
    bestKeys: bestMetal === null ? null : num(r['best_keys']),
    bestMetalScrap: bestMetal,
    nextKeys: nextMetal === null ? null : num(r['next_keys']),
    nextMetalScrap: nextMetal,
    buyerCount: num(r['buyer_count']),
    verifiedBuyerCount: numOrNull(r['verified_buyer_count']),
    askKeys: askMetal === null ? null : num(r['ask_keys']),
    askMetalScrap: askMetal,
    askCount: numOrNull(r['ask_count']),
    scraptfPaysKeys: paysScrap === null ? null : num(r['scraptf_pays_keys']),
    scraptfPaysScrap: paysScrap,
    keyScrap: numOrNull(r['key_scrap']),
  };
}

/** 0.8 (H1): a side's metal to bind, whole scrap; NULL when not finite (the side then had nothing). */
function bindMetalOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

const HOLDING_MARK_INSERT =
  'INSERT INTO holding_marks (base_sku, from_at, to_at, rev_keys, rev_metal_scrap, rev_is_bot, rev_verified, best_keys, best_metal_scrap, ' +
  'next_keys, next_metal_scrap, buyer_count, verified_buyer_count, ask_keys, ask_metal_scrap, ask_count, scraptf_pays_keys, scraptf_pays_scrap, key_scrap) ' +
  `VALUES (${placeholders(19)})`;

/** 0.8 (G1): one copy's watch; a NULL special key (every copy) compares as '*', as the unique index does. */
const WATCH_COPY = "sku = ? AND IFNULL(special_key, '*') = IFNULL(?, '*')";

function rowToRequestLog(r: SqlRow): RequestLogRow {
  return {
    ts: num(r['ts']),
    host: str(r['host']),
    path: str(r['path']),
    method: str(r['method']),
    status: num(r['status']),
    ms: num(r['ms']),
    bytes: num(r['bytes']),
    note: strOrNull(r['note']),
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const LISTING_UPSERT = upsertSql('listings', LISTING_COLS, ['id']);
const OPP_UPSERT = upsertSql('opportunities', OPP_COLS, ['key']);
// Newest saved list wins per SKU: an older file imported later (catch-up scan, a copy) never replaces a row.
const SCRAPTF_LIST_UPSERT =
  upsertSql(
    'scraptf_list',
    ['sku', 'name', 'sells_keys', 'sells_scrap', 'pays_keys', 'pays_scrap', 'stock', 'stock_limit', 'batch_id', 'observed_at', 'craft', 'page'],
    ['sku'],
  ) + ' WHERE excluded.observed_at >= scraptf_list.observed_at';
/**
 * 0.7.4 Repo.bankStockNewestBankOf: the bank of one SKU's newest bank stock row outside the list and
 * /unusuals, by save time then batch id. Walks the kept saves (bank_stock_saves, one row each) with one
 * primary-key seek (batch_id, sku) per save: bank_stock has no index on sku alone, which would slow every
 * thinning delete (measured: the 301st-save prune of test/db/bankStockThinPerf.test.ts went from under
 * 100 ms to about 190 ms), so importSavedPage asks once per SKU per import (homeBankOf's memo).
 */
const BANK_STOCK_NEWEST_BANK =
  'SELECT s.bank AS bank, (CASE WHEN ib.file_mtime > 0 THEN ib.file_mtime ELSE ib.imported_at END) AS saved_at, s.batch_id AS batch_id ' +
  "FROM bank_stock_saves s CROSS JOIN import_batches ib ON ib.id = s.batch_id WHERE s.bank NOT IN ('list', 'unusuals') " +
  'AND EXISTS (SELECT 1 FROM bank_stock b WHERE b.batch_id = s.batch_id AND b.sku = ?) ' +
  'ORDER BY saved_at DESC, s.batch_id DESC LIMIT 1';
const BANK_STOCK_INSERT =
  'INSERT INTO bank_stock (batch_id, bank, sku, special_key, name, cost_keys, cost_scrap, stock, asset_id, page, craft) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(batch_id, sku, special_key) DO NOTHING';
/** bank_stock.page longer than this is clipped (the parser clips it already: a page key is a short path). */
const BANK_STOCK_PAGE_MAX_CHARS = 200;
// The save queries below read bank_stock_saves first and seek each batch: CROSS JOIN keeps that order
// (SQLite never reorders it). The V10 index covers a batch's save time, so a plain JOIN would let the
// planner walk every batch ever written through it instead (0.7.1).
/** A save's time, as batchSavedAt (src/shared/market.ts): the file's mtime when known, else the import time. `ib` is import_batches. */
const BANK_STOCK_SAVED_AT = '(CASE WHEN ib.file_mtime > 0 THEN ib.file_mtime ELSE ib.imported_at END)';
/**
 * F20: every save with rows, oldest first, from bank_stock_saves (V8): one row per kept save and one seek
 * into import_batches for its time, so this costs per kept save, not per import batch ever written
 * (import_batches is never purged) or per stored row. A save whose batch row is gone is left out.
 */
const BANK_STOCK_SAVE_INDEX =
  `SELECT s.batch_id AS batch_id, ${BANK_STOCK_SAVED_AT} AS saved_at, s.bank AS bank, s.page AS page ` +
  'FROM bank_stock_saves s CROSS JOIN import_batches ib ON ib.id = s.batch_id ' +
  'ORDER BY saved_at ASC, s.batch_id ASC';
/** bank_stock_saves kept with bank_stock: a second write to the same batch only adds its rows (first bank and page stay). */
const BANK_STOCK_SAVE_UPSERT =
  'INSERT INTO bank_stock_saves (batch_id, bank, page, items) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT(batch_id) DO UPDATE SET items = bank_stock_saves.items + excluded.items';
/**
 * 0.7.1 Repo.bankNewestSaves: one bank's newest batch that stored items (the list counts with none, as
 * isEmptyBankSave), by save time then the higher id. A seek on the V10 index (bank, save time): the
 * expression is the index's, so no batch but the ones walked past is read. Exported for the query-plan test.
 */
export const BANK_NEWEST_SAVE =
  `SELECT ib.id AS id, ${BANK_STOCK_SAVED_AT} AS saved_at, ib.item_count AS item_count FROM import_batches ib ` +
  "WHERE ib.bank = ? AND (ib.item_count > 0 OR ib.bank = 'list') " +
  `ORDER BY ${BANK_STOCK_SAVED_AT} DESC, ib.id DESC LIMIT 1`;
/** One bank's saves with rows, newest first (Repo.bankStockSaves). */
const BANK_STOCK_SAVES =
  `SELECT s.batch_id AS batch_id, ${BANK_STOCK_SAVED_AT} AS saved_at, s.items AS items, s.page AS page ` +
  'FROM bank_stock_saves s CROSS JOIN import_batches ib ON ib.id = s.batch_id WHERE s.bank = ? ' +
  'ORDER BY saved_at DESC, s.batch_id DESC LIMIT ?';
/**
 * F20: one bank's newest `?` saves of each page, page by page (the page saved last first), each page's
 * newest first: the order bankStockPagePairs reads, so a LIMIT keeps whole pages. Retention keeps up to
 * 300 saves a page, so a cap on the bank's newest saves overall would cut a quiet page, or the save it is
 * compared with, out of the F17 diff while the history and the feed still read it.
 */
const BANK_STOCK_PAGE_HEADS =
  'SELECT batch_id, saved_at, items, page FROM (' +
  `SELECT s.batch_id AS batch_id, ${BANK_STOCK_SAVED_AT} AS saved_at, s.items AS items, s.page AS page, ` +
  'ROW_NUMBER() OVER w AS rn, FIRST_VALUE(' +
  BANK_STOCK_SAVED_AT +
  ') OVER w AS top_at, FIRST_VALUE(s.batch_id) OVER w AS top_id ' +
  'FROM bank_stock_saves s CROSS JOIN import_batches ib ON ib.id = s.batch_id WHERE s.bank = ? ' +
  `WINDOW w AS (PARTITION BY s.page ORDER BY ${BANK_STOCK_SAVED_AT} DESC, s.batch_id DESC)` +
  ') WHERE rn <= ? ORDER BY top_at DESC, top_id DESC, saved_at DESC, batch_id DESC LIMIT ?';
const SCRAPTF_EVENT_INSERT =
  'INSERT INTO scraptf_events (at, bank, page, sku, special_key, name, kind, from_keys, from_scrap, to_keys, to_scrap, from_stock, to_stock, batch_id) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

// Buy orders best first (keys, then metal), sell listings cheapest first.
const LISTING_ORDER =
  "intent ASC, CASE WHEN intent = 'buy' THEN -keys ELSE keys END ASC, " +
  "CASE WHEN intent = 'buy' THEN -metal_scrap ELSE metal_scrap END ASC, last_event_at DESC, id ASC";

const OPP_SORT: Record<NonNullable<OppQuery['sort']>, { expr: string; nullable: string | null; defaultDir: 'asc' | 'desc' }> = {
  profit: { expr: 'profit_scrap', nullable: 'profit_scrap', defaultDir: 'desc' },
  margin: { expr: 'margin', nullable: 'margin', defaultDir: 'desc' },
  confidence: { expr: 'confidence', nullable: 'confidence', defaultDir: 'desc' },
  updated: { expr: 'updated_at', nullable: 'updated_at', defaultDir: 'desc' },
  name: { expr: 'name COLLATE NOCASE', nullable: null, defaultDir: 'asc' },
};

/** Search tokens matched independently (AND), like the dashboard's own search; capped defensively. */
const MAX_SEARCH_TOKENS = 20;

interface SqlPart {
  sql: string;
  params: SqlValue[];
}

/** ' WHERE …' (or '') for an opportunity query's filters and search. */
function oppWhere(q: OppQuery): SqlPart {
  const where: string[] = [];
  const params: SqlValue[] = [];

  // An empty list means "no filter", matching how the dashboard sends unselected chips.
  const inFilter = (col: string, values: readonly unknown[] | undefined): void => {
    if (!Array.isArray(values) || values.length === 0) return;
    const vals = uniqueStrings(values).slice(0, 500);
    if (vals.length === 0) {
      where.push('0');
      return;
    }
    where.push(`${col} IN (${placeholders(vals.length)})`);
    params.push(...vals);
  };

  inFilter('status', q.status);
  inFilter('category', q.categories);
  inFilter('profit_tier', q.tiers);
  inFilter('input_kind', q.inputKinds);

  if (typeof q.minConfidence === 'number' && Number.isFinite(q.minConfidence)) {
    where.push('confidence >= ?');
    params.push(q.minConfidence);
  }

  // Every whitespace-separated token must be in the name or the SKU ("strange rocket").
  const tokens = typeof q.search === 'string' ? q.search.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS) : [];
  for (const t of tokens) {
    const pattern = `%${escapeLike(t)}%`;
    where.push("(name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }

  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

/** ORDER BY terms (no parameters) for an opportunity query's sort, ending in a unique key. */
function oppOrder(q: OppQuery): string {
  const sortKey = q.sort !== undefined && Object.hasOwn(OPP_SORT, q.sort) ? q.sort : 'profit';
  const sort = OPP_SORT[sortKey];
  const dir = q.dir === 'asc' || q.dir === 'desc' ? q.dir : sort.defaultDir;
  const order: string[] = [];
  if (sort.nullable) order.push(`(${sort.nullable} IS NULL) ASC`);
  order.push(`${sort.expr} ${dir.toUpperCase()}`);
  if (sortKey !== 'profit') order.push('(profit_scrap IS NULL) ASC', 'profit_scrap DESC');
  if (sortKey !== 'name') order.push('name COLLATE NOCASE ASC');
  order.push('"key" ASC');
  return order.join(', ');
}

/** Group-by columns, normalised like rowToOpportunity so a damaged value groups under its fallback. */
const OPP_GROUP: Record<GroupBy, { col: string; valid: readonly string[]; fallback: string }> = {
  category: { col: 'category', valid: CATEGORIES, fallback: 'other' },
  tier: { col: 'profit_tier', valid: PROFIT_TIERS, fallback: 'none' },
  confidence: { col: 'confidence_level', valid: CONFIDENCE_LEVELS, fallback: 'low' },
  input: { col: 'input_kind', valid: INPUT_KINDS, fallback: 'user' },
};

function oppGroupExpr(by: unknown): SqlPart | null {
  if (typeof by !== 'string' || !Object.hasOwn(OPP_GROUP, by)) return null;
  const g = OPP_GROUP[by as GroupBy];
  return { sql: `(CASE WHEN ${g.col} IN (${placeholders(g.valid.length)}) THEN ${g.col} ELSE ? END)`, params: [...g.valid, g.fallback] };
}

function pageInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(v))) : fallback;
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export function createRepo(db: SqliteDb): Repo {
  const run = (sql: string, ...params: SqlValue[]): number => Number(db.prepare(sql).run(...params).changes);
  const get = (sql: string, ...params: SqlValue[]): SqlRow | undefined => db.prepare(sql).get(...params);
  const all = (sql: string, ...params: SqlValue[]): SqlRow[] => db.prepare(sql).all(...params);
  const insertId = (sql: string, ...params: SqlValue[]): number => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const count = (table: string): number => num(get(`SELECT COUNT(*) AS n FROM ${table}`)?.['n']);

  const getMeta = (key: string): string | null => strOrNull(get('SELECT value FROM meta WHERE key = ?', key)?.['value']);
  const setMeta = (key: string, value: string): void => {
    run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  };

  const getScrapPrice = (id: number): ScrapPrice | null => {
    const r = get(`${PRICE_SELECT} WHERE sp.id = ?`, id);
    return r ? rowToScrapPrice(r) : null;
  };

  const getRule = (id: number): PriceRule | null => {
    const r = get('SELECT * FROM price_rules WHERE id = ?', id);
    return r ? rowToRule(r) : null;
  };

  const getJournal = (id: number): JournalEntry | null => {
    const r = get('SELECT * FROM journal WHERE id = ?', bindNum(id, -1));
    return r ? rowToJournal(r) : null;
  };

  const getWatch = (id: number): ScraptfWatch | null => {
    const r = get('SELECT * FROM scraptf_watches WHERE id = ?', bindNum(id, -1));
    return r ? rowToWatch(r) : null;
  };

  const findWatch = (sku: string, specialKey: string | null): ScraptfWatch | null => {
    const r = get(`SELECT * FROM scraptf_watches WHERE ${WATCH_COPY}`, String(sku), bindStrOrNull(specialKey));
    return r ? rowToWatch(r) : null;
  };

  const repo: Repo = {
    path: db.path,

    sizeBytes() {
      if (!db.isMemory) {
        try {
          let total = statSync(db.path).size;
          try {
            total += statSync(`${db.path}-wal`).size;
          } catch {
            // No WAL file right now.
          }
          return total;
        } catch {
          // Fall through to the page count.
        }
      }
      if (!db.isOpen()) return 0;
      return db.pragmaNumber('page_count') * db.pragmaNumber('page_size');
    },

    close() {
      db.close();
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(fn);
    },

    getMeta,
    setMeta,

    // ----- listings -----

    upsertListings(rows) {
      if (rows.length === 0) return;
      db.transaction(() => {
        const stmt = db.prepare(LISTING_UPSERT);
        for (const l of rows) stmt.run(...listingParams(l));
      });
    },

    deleteListings(ids) {
      if (ids.length === 0) return;
      db.transaction(() => {
        const stmt = db.prepare('DELETE FROM listings WHERE id = ?');
        for (const id of ids) stmt.run(String(id));
      });
    },

    getListing(id) {
      const r = get('SELECT * FROM listings WHERE id = ?', String(id));
      return r ? rowToListing(r) : null;
    },

    listingsByBaseSku(baseSku, intent) {
      const rows =
        intent === undefined
          ? all(`SELECT * FROM listings WHERE base_sku = ? ORDER BY ${LISTING_ORDER}`, baseSku)
          : all(`SELECT * FROM listings WHERE base_sku = ? AND intent = ? ORDER BY ${LISTING_ORDER}`, baseSku, intent);
      return rows.map(rowToListing);
    },

    buyListingsByBaseSkus(baseSkus) {
      const unique = uniqueStrings(baseSkus);
      const out = new Map<string, Listing[]>();
      for (const s of unique) out.set(s, []);
      for (const part of chunk(unique)) {
        const rows = all(
          `SELECT * FROM listings WHERE base_sku IN (${placeholders(part.length)}) AND intent = 'buy' ` +
            'ORDER BY keys DESC, metal_scrap DESC, last_event_at DESC, id ASC',
          ...part,
        );
        for (const r of rows) {
          const l = rowToListing(r);
          out.get(l.baseSku)?.push(l);
        }
      }
      return out;
    },

    baseSkusWithBuyOrders() {
      return all("SELECT DISTINCT base_sku FROM listings WHERE intent = 'buy' ORDER BY base_sku").map((r) => str(r['base_sku']));
    },

    deleteListingsNotIn(baseSku, intent, keepIds) {
      return db.transaction(() => {
        const keep = new Set(keepIds.map(String));
        const del = db.prepare('DELETE FROM listings WHERE id = ?');
        let deleted = 0;
        for (const r of all('SELECT id FROM listings WHERE base_sku = ? AND intent = ?', baseSku, intent)) {
          const id = str(r['id']);
          if (!keep.has(id)) deleted += Number(del.run(id).changes);
        }
        return deleted;
      });
    },

    purgeListingsOlderThan(ts) {
      return run('DELETE FROM listings WHERE last_event_at < ?', bindNum(ts));
    },

    opportunityCounts() {
      const r = get(
        "SELECT COUNT(*) AS total, COALESCE(SUM(status = 'profitable'), 0) AS profitable, " +
          "COALESCE(SUM(status = 'profitable' AND confidence_level = 'high'), 0) AS high FROM opportunities",
      );
      return { opportunities: num(r?.['total']), profitable: num(r?.['profitable']), highConfidence: num(r?.['high']) };
    },

    listingCounts() {
      const r = get(
        "SELECT COUNT(*) AS total, COALESCE(SUM(intent = 'buy'), 0) AS buy, COALESCE(SUM(intent = 'sell'), 0) AS sell FROM listings",
      );
      return { total: num(r?.['total']), buy: num(r?.['buy']), sell: num(r?.['sell']) };
    },

    // ----- backpack.tf names -----

    upsertBptfNames(rows) {
      if (rows.length === 0) return;
      db.transaction(() => {
        // Never let an older sighting overwrite a newer one; keep a known market name.
        const stmt = db.prepare(
          'INSERT INTO bptf_names (sku, name, market_name, last_seen) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(sku) DO UPDATE SET name = excluded.name, ' +
            'market_name = COALESCE(excluded.market_name, bptf_names.market_name), last_seen = excluded.last_seen ' +
            'WHERE excluded.last_seen >= bptf_names.last_seen',
        );
        for (const row of rows) {
          if (typeof row.sku !== 'string' || !row.sku || typeof row.name !== 'string' || !row.name.trim()) continue;
          stmt.run(row.sku, row.name, bindStrOrNull(row.marketName), bindNum(row.lastSeen));
        }
      });
    },

    getBptfName(sku) {
      const r = get('SELECT * FROM bptf_names WHERE sku = ?', sku);
      return r ? rowToBptfName(r) : null;
    },

    findSkuByBptfName(name) {
      const n = typeof name === 'string' ? name.trim() : '';
      if (!n) return null;
      // Exact case first; the shortest SKU is the plain item (painted variants share the name). 0.7.4 (F15):
      // never by last_seen, so the answer does not move as the feed learns names.
      const r = db
        .prepare(
          'SELECT sku FROM bptf_names WHERE name = :name COLLATE NOCASE ' +
            'ORDER BY (name = :name) DESC, length(sku) ASC, sku ASC LIMIT 1',
        )
        .get({ name: n });
      return r ? str(r['sku']) : null;
    },

    findSkusByBptfName(name, limit) {
      const n = typeof name === 'string' ? name.trim() : '';
      if (!n) return [];
      // 0.7.4 (F15/F42/F72): every candidate, exact case first, then by SKU (schema.resolve picks among them).
      const rows = db
        .prepare(
          'SELECT sku FROM bptf_names WHERE name = :name COLLATE NOCASE ' +
            'ORDER BY (name = :name) DESC, sku ASC LIMIT :lim',
        )
        .all({ name: n, lim: clampLimit(limit, 16, 64) });
      return rows.map((r) => str(r['sku'])).filter((s) => s !== '');
    },

    searchBptfNames(q, limit) {
      const text = typeof q === 'string' ? q.trim() : '';
      const lim = clampLimit(limit, 20, 1000);
      if (!text || lim === 0) return [];
      const esc = escapeLike(text);
      const rows = db
        .prepare(
          'SELECT sku, name, market_name, last_seen, ' +
            "CASE WHEN name LIKE :prefix ESCAPE '\\' THEN 0 " +
            "WHEN market_name LIKE :prefix ESCAPE '\\' THEN 1 " +
            "WHEN name LIKE :word ESCAPE '\\' THEN 2 ELSE 3 END AS rank " +
            "FROM bptf_names WHERE name LIKE :sub ESCAPE '\\' OR market_name LIKE :sub ESCAPE '\\' " +
            'ORDER BY rank ASC, length(name) ASC, name COLLATE NOCASE ASC, sku ASC LIMIT :limit',
        )
        .all({ prefix: `${esc}%`, word: `% ${esc}%`, sub: `%${esc}%`, limit: lim });
      return rows.map(rowToBptfName);
    },

    // ----- PriceDB -----

    upsertPricedb(rows) {
      if (rows.length === 0) return;
      db.transaction(() => {
        // 0.7.3: newest wins. /autob/items is CDN-cached up to 4 h, so an older record never replaces a newer
        // stored one (socket, /item, /items-bulk). An equal time rewrites; an undated record (0) writes as before.
        const stmt = db.prepare(
          upsertSql('pricedb_prices', ['sku', 'name', 'buy_keys', 'buy_scrap', 'sell_keys', 'sell_scrap', 'time', 'fetched_at'], ['sku']) +
            ' WHERE excluded."time" <= 0 OR excluded."time" >= pricedb_prices."time"',
        );
        for (const p of rows) {
          stmt.run(
            String(p.sku),
            String(p.name ?? ''),
            bindNum(p.buyKeys),
            bindNum(p.buyScrap),
            bindNum(p.sellKeys),
            bindNum(p.sellScrap),
            bindNum(p.time),
            bindNum(p.fetchedAt),
          );
        }
      });
    },

    getPricedb(sku) {
      const r = get('SELECT * FROM pricedb_prices WHERE sku = ?', sku);
      return r ? rowToPricedb(r) : null;
    },

    pricedbCount() {
      return count('pricedb_prices');
    },

    getSkuAlias(sku) {
      return strOrNull(get('SELECT pricedb_sku FROM sku_aliases WHERE sku = ?', sku)?.['pricedb_sku']);
    },

    setSkuAlias(sku, pricedbSku) {
      run(
        'INSERT INTO sku_aliases (sku, pricedb_sku) VALUES (?, ?) ON CONFLICT(sku) DO UPDATE SET pricedb_sku = excluded.pricedb_sku',
        sku,
        pricedbSku,
      );
    },

    // ----- community prices -----

    upsertCommunity(rows) {
      if (rows.length === 0) return;
      db.transaction(() => {
        const stmt = db.prepare(upsertSql('bptf_community', ['sku', 'currency', 'value', 'value_high', 'last_update'], ['sku']));
        for (const c of rows) {
          stmt.run(String(c.sku), String(c.currency ?? ''), bindNum(c.value), bindNumOrNull(c.valueHigh), bindNumOrNull(c.lastUpdate));
        }
      });
    },

    getCommunity(sku) {
      const r = get('SELECT * FROM bptf_community WHERE sku = ?', sku);
      return r ? rowToCommunity(r) : null;
    },

    // ----- key prices -----

    upsertKeyQuote(q) {
      run(
        upsertSql('key_prices', ['source', 'buy_scrap', 'sell_scrap', 'observed_at', 'price_at'], ['source']),
        String(q.source),
        bindNumOrNull(q.buyScrap),
        bindNumOrNull(q.sellScrap),
        bindNum(q.observedAt),
        // 0.7.4 (F71): unknown (absent) is stored as NULL, never as the fetch time.
        bindNumOrNull(q.priceAt ?? null),
      );
    },

    keyQuotes() {
      return all('SELECT * FROM key_prices ORDER BY observed_at DESC, source ASC').map(rowToKeyQuote);
    },

    // ----- scrap.tf prices -----

    listScrapPrices(q) {
      const text = typeof q === 'string' ? q.trim() : '';
      if (!text) return all(`${PRICE_SELECT} ${PRICE_ORDER}`).map(rowToScrapPrice);
      const pattern = `%${escapeLike(text)}%`;
      return all(`${PRICE_SELECT} WHERE sp.name LIKE ? ESCAPE '\\' OR sp.sku LIKE ? ESCAPE '\\' ${PRICE_ORDER}`, pattern, pattern).map(rowToScrapPrice);
    },

    getScrapPrice,

    scrapPricesForSku(sku) {
      return all(`${PRICE_SELECT} WHERE sp.sku = ? ${PRICE_ORDER}`, sku).map(rowToScrapPrice);
    },

    importScrapPricesOfBank(bank, beforeAt) {
      // 0.7.4: the bank's batches (V10 index on import_batches.bank), then their prices (scrap_prices_import_batch).
      const b = bankOrNull(bank);
      if (b === null) return [];
      return all(`${PRICE_SELECT} WHERE sp.source = 'import' AND ib.bank = ? AND sp.observed_at < ? ${PRICE_ORDER}`, b, bindNum(beforeAt)).map(rowToScrapPrice);
    },

    upsertScrapPrice(input) {
      const sku = requireText('sku', input.sku);
      const costScrap = requireFinite('costScrap', input.costScrap);
      const observedAt = requireFinite('observedAt', input.observedAt);
      if (!PRICE_SOURCES.includes(input.source)) throw new TypeError(`source must be one of ${PRICE_SOURCES.join(', ')}`);
      if (input.costKeys !== undefined) requireFinite('costKeys', input.costKeys);

      return db.transaction(() => {
        const existing = input.id === undefined || input.id === null ? null : getScrapPrice(requireId('id', input.id));
        if (input.id !== undefined && input.id !== null && !existing) throw new Error(`Scrap price ${input.id} not found`);

        // On update, omitted optional fields keep their stored values.
        const keep = <T,>(value: T | undefined, stored: T | undefined, fallback: T): T =>
          value !== undefined ? value : existing ? (stored as T) : fallback;

        const special = keep(input.special, existing?.special, null);
        const params: SqlValue[] = [
          sku,
          String(input.name ?? ''),
          bindNum(keep(input.costKeys, existing?.costKeys, 0)),
          costScrap,
          input.source,
          observedAt,
          bindStrOrNull(keep(input.note, existing?.note, null)),
          bindNumOrNull(keep(input.importBatch, existing?.importBatch, null)),
          special === null ? null : JSON.stringify(special),
          bindStrOrNull(keep(input.assetId, existing?.assetId, null)),
          bindNumOrNull(keep(input.stock, existing?.stock, null)),
        ];

        let id: number;
        if (existing) {
          id = existing.id;
          run(
            'UPDATE scrap_prices SET sku = ?, name = ?, cost_keys = ?, cost_scrap = ?, source = ?, observed_at = ?, note = ?, ' +
              'import_batch = ?, special = ?, asset_id = ?, stock = ? WHERE id = ?',
            ...params,
            id,
          );
        } else {
          id = insertId(
            'INSERT INTO scrap_prices (sku, name, cost_keys, cost_scrap, source, observed_at, note, import_batch, special, asset_id, stock) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ...params,
          );
        }
        const stored = getScrapPrice(id);
        if (!stored) throw new Error(`Scrap price ${id} vanished during upsert`);
        return stored;
      });
    },

    deleteScrapPrice(id) {
      run('DELETE FROM scrap_prices WHERE id = ?', bindNum(id, -1));
    },

    // ----- price-sheet rules -----

    listRules() {
      return all('SELECT * FROM price_rules ORDER BY id ASC').map(rowToRule);
    },

    getRule,

    upsertRule(input) {
      const name = requireText('name', input.name);
      const costScrap = requireFinite('costScrap', input.costScrap);
      const observedAt = requireFinite('observedAt', input.observedAt);
      if (input.costKeys !== undefined) requireFinite('costKeys', input.costKeys);
      if (input.filter === null || typeof input.filter !== 'object' || Array.isArray(input.filter)) {
        throw new TypeError('filter must be an object');
      }

      return db.transaction(() => {
        const existing = input.id === undefined || input.id === null ? null : getRule(requireId('id', input.id));
        if (input.id !== undefined && input.id !== null && !existing) throw new Error(`Price rule ${input.id} not found`);

        const costKeys = input.costKeys ?? existing?.costKeys ?? 0;
        const enabled = input.enabled ?? existing?.enabled ?? true;
        const params: SqlValue[] = [name, JSON.stringify(input.filter), costKeys, costScrap, observedAt, bindBool(enabled)];

        let id: number;
        if (existing) {
          id = existing.id;
          run(
            'UPDATE price_rules SET name = ?, filter_json = ?, cost_keys = ?, cost_scrap = ?, observed_at = ?, enabled = ? WHERE id = ?',
            ...params,
            id,
          );
        } else {
          id = insertId(
            'INSERT INTO price_rules (name, filter_json, cost_keys, cost_scrap, observed_at, enabled) VALUES (?, ?, ?, ?, ?, ?)',
            ...params,
          );
        }
        const stored = getRule(id);
        if (!stored) throw new Error(`Price rule ${id} vanished during upsert`);
        return stored;
      });
    },

    deleteRule(id) {
      run('DELETE FROM price_rules WHERE id = ?', bindNum(id, -1));
    },

    // ----- opportunities -----

    upsertOpportunities(rows) {
      if (rows.length === 0) return;
      db.transaction(() => {
        const stmt = db.prepare(OPP_UPSERT);
        for (const o of rows) stmt.run(...oppParams(o));
      });
    },

    deleteOpportunities(keys) {
      if (keys.length === 0) return;
      db.transaction(() => {
        const stmt = db.prepare('DELETE FROM opportunities WHERE "key" = ?');
        for (const k of keys) stmt.run(String(k));
      });
    },

    getOpportunity(key) {
      const r = get(`${OPP_SELECT} WHERE "key" = ?`, key);
      return r ? rowToOpportunity(r) : null;
    },

    allOpportunities() {
      return all(`${OPP_SELECT} ORDER BY "key" ASC`).map(rowToOpportunity);
    },

    opportunitiesForSku(sku) {
      return all(
        `${OPP_SELECT} WHERE sku = ? ORDER BY (profit_scrap IS NULL) ASC, profit_scrap DESC, "key" ASC`,
        sku,
      ).map(rowToOpportunity);
    },

    queryOpportunities(q, page) {
      const w = oppWhere(q);
      const params: SqlValue[] = [...w.params];
      let order = oppOrder(q);
      const g = page?.group ?? null;
      const group = g ? oppGroupExpr(g.by) : null;
      if (g && group) {
        // Rows of the first group in display order first; the requested sort applies inside each group.
        const keys = uniqueStrings(g.order).slice(0, 100);
        if (keys.length > 0) {
          order = `(CASE ${group.sql} ${keys.map((_, i) => `WHEN ? THEN ${i}`).join(' ')} ELSE ${keys.length} END) ASC, ${order}`;
          params.push(...group.params, ...keys);
        }
      }
      let sql = `${OPP_SELECT}${w.sql} ORDER BY ${order}`;
      if (page) {
        sql += ' LIMIT ? OFFSET ?';
        params.push(pageInt(page.limit, 0), pageInt(page.offset, 0));
      }
      return all(sql, ...params).map(rowToOpportunity);
    },

    countOpportunities(q) {
      const w = oppWhere(q);
      return num(get(`SELECT COUNT(*) AS n FROM opportunities${w.sql}`, ...w.params)?.['n']);
    },

    opportunityGroupStats(q, by, useOrder) {
      const group = oppGroupExpr(by);
      if (!group) return [];
      const w = oppWhere(q);
      // 0.7.4 (F27, F33; R27): copies of an item (one sku) on one revenue order (the engine's revenueOrderOf
      // for useOrder) count once per group, at the best of the rows q matches: the stored 'shared-buyer' flag is
      // set over every copy, so a filter hiding the best copy left the buyer counted zero times. The service
      // stores base SKUs (priceRow), so sku is the item, as markSharedCopies groups it; rule rows are no copies
      // (the engine flags price inputs only) and count alone.
      const order = useOrder === 'best' || useOrder === 'instant' ? useOrder : 'conservative';
      return all(
        `WITH f AS (SELECT ${group.sql} AS k, sku, input_kind AS ik, profit_scrap AS p, ` +
          `CASE ? WHEN 'best' THEN best_order WHEN 'instant' THEN instant_order ELSE cons_order END AS ord FROM opportunities${w.sql}), ` +
          `g AS (SELECT k, sku, p, CASE WHEN p IS NOT NULL AND ik <> 'rule' AND json_valid(ord) THEN json_extract(ord, '$.listingId') END AS oid FROM f) ` +
          `SELECT k, SUM(n) AS n, SUM(p) AS p FROM (` +
          `SELECT k, COUNT(*) AS n, MAX(p) AS p FROM g WHERE oid IS NOT NULL AND oid <> '' GROUP BY k, sku, oid ` +
          `UNION ALL SELECT k, COUNT(*) AS n, SUM(COALESCE(p, 0)) AS p FROM g WHERE oid IS NULL OR oid = '' GROUP BY k` +
          `) GROUP BY k`,
        ...group.params,
        order,
        ...w.params,
      ).map((r) => ({ key: str(r['k']), count: num(r['n']), profitScrap: num(r['p']) }));
    },

    appendEvents(events) {
      if (events.length === 0) return;
      db.transaction(() => {
        const stmt = db.prepare(
          'INSERT INTO opportunity_events ("key", sku, name, category, kind, profit_scrap, cost_scrap, revenue_scrap, confidence, summary, ts) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const e of events) {
          stmt.run(
            String(e.key),
            String(e.sku),
            String(e.name ?? ''),
            String(e.category),
            String(e.kind),
            bindNumOrNull(e.profitScrap),
            bindNumOrNull(e.costScrap),
            bindNumOrNull(e.revenueScrap),
            bindNum(e.confidence),
            typeof e.summary === 'string' ? e.summary : '',
            bindNum(e.ts),
          );
        }
      });
    },

    listEvents(q) {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (typeof q.beforeId === 'number' && Number.isFinite(q.beforeId)) {
        where.push('id < ?');
        params.push(q.beforeId);
      }
      // afterId pages forward (oldest first) from a cursor, e.g. the opportunity JSONL log.
      const after = typeof q.afterId === 'number' && Number.isFinite(q.afterId);
      if (after) {
        where.push('id > ?');
        params.push(q.afterId!);
      }
      if (typeof q.sku === 'string' && q.sku) {
        where.push('sku = ?');
        params.push(q.sku);
      }
      if (Array.isArray(q.kinds) && q.kinds.length > 0) {
        const kinds = uniqueStrings(q.kinds).slice(0, 50);
        if (kinds.length === 0) where.push('0');
        else {
          where.push(`kind IN (${placeholders(kinds.length)})`);
          params.push(...kinds);
        }
      }
      if (typeof q.sinceTs === 'number' && Number.isFinite(q.sinceTs)) {
        where.push('ts >= ?');
        params.push(q.sinceTs);
      }
      const limit = clampLimit(q.limit, EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT);
      const sql =
        'SELECT * FROM opportunity_events' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT ?`;
      return all(sql, ...params, limit).map(rowToEvent);
    },

    purgeEventsOlderThan(ts) {
      return run('DELETE FROM opportunity_events WHERE ts < ?', bindNum(ts));
    },

    // ----- journal -----

    listJournal(limit) {
      const lim = limit === undefined ? -1 : clampLimit(limit, -1, GENERIC_MAX_LIMIT);
      return all('SELECT * FROM journal ORDER BY ts DESC, id DESC LIMIT ?', lim).map(rowToJournal);
    },

    addJournal(entry) {
      if (!JOURNAL_SIDES.includes(entry.side)) throw new TypeError(`side must be one of ${JOURNAL_SIDES.join(', ')}`);
      const ts = requireFinite('ts', entry.ts);
      const sku = requireText('sku', entry.sku);
      const scrap = requireFinite('scrap', entry.scrap);
      const keys = entry.keys === undefined ? 0 : requireFinite('keys', entry.keys);
      // 0.8 (J2): either part given records the fee (the other 0); neither leaves both NULL (not recorded).
      const recorded = entry.feeKeys !== undefined || entry.feeScrap !== undefined;
      const id = insertId(
        'INSERT INTO journal (ts, side, venue, sku, name, keys, scrap, key_price_scrap, note, fee_keys, fee_scrap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ts,
        entry.side,
        String(entry.venue ?? ''),
        sku,
        String(entry.name ?? ''),
        keys,
        scrap,
        bindNum(entry.keyPriceScrap),
        bindStrOrNull(entry.note),
        recorded ? feeNum('feeKeys', entry.feeKeys) : null,
        recorded ? Math.round(feeNum('feeScrap', entry.feeScrap)) : null,
      );
      const r = get('SELECT * FROM journal WHERE id = ?', id);
      if (!r) throw new Error(`Journal entry ${id} vanished after insert`);
      return rowToJournal(r);
    },

    getJournal,

    updateJournal(id, patch) {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.venue !== undefined) {
        sets.push('venue = ?');
        params.push(String(patch.venue));
      }
      if (patch.note !== undefined) {
        sets.push('note = ?');
        params.push(bindStrOrNull(patch.note));
      }
      // undefined leaves the fee, null clears it (not recorded), a fee sets both parts.
      const fee = feePatchOf(patch);
      if (fee !== undefined) {
        sets.push('fee_keys = ?', 'fee_scrap = ?');
        params.push(fee === null ? null : feeNum('feeKeys', fee.keys), fee === null ? null : Math.round(feeNum('feeScrap', fee.scrap)));
      }
      if (sets.length) run(`UPDATE journal SET ${sets.join(', ')} WHERE id = ?`, ...params, bindNum(id, -1));
      return getJournal(id);
    },

    deleteJournal(id) {
      run('DELETE FROM journal WHERE id = ?', bindNum(id, -1));
    },

    // ----- scrap.tf watches -----

    listWatches() {
      return all('SELECT * FROM scraptf_watches ORDER BY id ASC').map(rowToWatch);
    },

    getWatch,
    findWatch,

    countWatches() {
      return count('scraptf_watches');
    },

    upsertWatch(w, now) {
      const sku = requireText('sku', w.sku);
      const at = requireFinite('now', now);
      if (w.specialKey !== null && typeof w.specialKey !== 'string') throw new TypeError('specialKey must be a string or null');
      // '*' is WATCH_COPY's every-copy stand-in: as a copy it would match (and overwrite) the base's any-copy watch.
      if (w.specialKey === WATCH_ANY_COPY_SENTINEL) throw new TypeError("specialKey '*' is the every-copy stand-in; use null");
      const maxCostKeys = requireNonNeg('maxCostKeys', w.maxCostKeys);
      const maxCostScrap = w.maxCostScrap === null ? null : Math.round(requireNonNeg('maxCostScrap', w.maxCostScrap));
      const minProfitScrap = w.minProfitScrap === null ? null : Math.round(requireNonNeg('minProfitScrap', w.minProfitScrap));

      return db.transaction(() => {
        const hasId = w.id !== undefined && w.id !== null;
        const byId = hasId ? getWatch(requireId('id', w.id)) : null;
        if (hasId && !byId) throw new Error(`Watch ${w.id} not found`);
        // One watch per copy: an update may not take another watch's copy; an add of a watched copy updates it.
        const same = findWatch(sku, w.specialKey);
        if (byId && same && same.id !== byId.id) throw new Error(WATCH_COPY_TAKEN);
        const target = byId ?? same;
        const params: SqlValue[] = [sku, w.specialKey, String(w.name ?? ''), maxCostKeys, maxCostScrap, minProfitScrap, bindBool(w.onRestock), bindBool(w.enabled)];

        let id: number;
        if (target) {
          id = target.id;
          run(
            'UPDATE scraptf_watches SET sku = ?, special_key = ?, name = ?, max_cost_keys = ?, max_cost_scrap = ?, min_profit_scrap = ?, on_restock = ?, enabled = ?, updated_at = ? WHERE id = ?',
            ...params,
            at,
            id,
          );
        } else {
          id = insertId(
            'INSERT INTO scraptf_watches (sku, special_key, name, max_cost_keys, max_cost_scrap, min_profit_scrap, on_restock, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ...params,
            at,
            at,
          );
        }
        const stored = getWatch(id);
        if (!stored) throw new Error(`Watch ${id} vanished during upsert`);
        return stored;
      });
    },

    deleteWatch(id) {
      run('DELETE FROM scraptf_watches WHERE id = ?', bindNum(id, -1));
    },

    restoreWatch(w, createdAt, updatedAt) {
      const watchId = requireId('id', w.id);
      const sku = requireText('sku', w.sku);
      const created = requireFinite('createdAt', createdAt);
      const updated = requireFinite('updatedAt', updatedAt);
      if (w.specialKey !== null && typeof w.specialKey !== 'string') throw new TypeError('specialKey must be a string or null');
      if (w.specialKey === WATCH_ANY_COPY_SENTINEL) throw new TypeError("specialKey '*' is the every-copy stand-in; use null");
      const maxCostKeys = requireNonNeg('maxCostKeys', w.maxCostKeys);
      const maxCostScrap = w.maxCostScrap === null ? null : Math.round(requireNonNeg('maxCostScrap', w.maxCostScrap));
      const minProfitScrap = w.minProfitScrap === null ? null : Math.round(requireNonNeg('minProfitScrap', w.minProfitScrap));

      return db.transaction(() => {
        // A second Undo: the watch is back already.
        const back = getWatch(watchId);
        if (back) return back;
        if (findWatch(sku, w.specialKey)) throw new Error(WATCH_COPY_TAKEN);
        run(
          'INSERT INTO scraptf_watches (id, sku, special_key, name, max_cost_keys, max_cost_scrap, min_profit_scrap, on_restock, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          watchId,
          sku,
          w.specialKey,
          String(w.name ?? ''),
          maxCostKeys,
          maxCostScrap,
          minProfitScrap,
          bindBool(w.onRestock),
          bindBool(w.enabled),
          created,
          updated,
        );
        const stored = getWatch(watchId);
        if (!stored) throw new Error(`Watch ${watchId} vanished during restore`);
        return stored;
      });
    },

    // ----- item schema -----

    replaceSchema(s) {
      db.transaction(() => {
        db.exec('DELETE FROM schema_items; DELETE FROM effects; DELETE FROM paints; DELETE FROM paintkits;');

        const items = db.prepare(
          'INSERT OR REPLACE INTO schema_items (defindex, name, item_name, proper_name, item_class, slot, craft_class, used_by_classes, image_url) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const it of s.items) {
          if (typeof it.defindex !== 'number' || !Number.isInteger(it.defindex)) continue;
          items.run(
            it.defindex,
            String(it.name ?? ''),
            String(it.itemName ?? ''),
            bindBool(it.properName),
            String(it.itemClass ?? ''),
            bindStrOrNull(it.slot),
            bindStrOrNull(it.craftClass),
            JSON.stringify(Array.isArray(it.usedByClasses) ? it.usedByClasses : []),
            bindStrOrNull(it.imageUrl),
          );
        }

        const effects = db.prepare('INSERT OR REPLACE INTO effects (id, name, canonical_id, type) VALUES (?, ?, ?, ?)');
        for (const e of s.effects) {
          if (typeof e.id !== 'number' || !Number.isInteger(e.id)) continue;
          effects.run(e.id, String(e.name ?? ''), bindNum(e.canonicalId, e.id), String(e.type));
        }

        const paints = db.prepare('INSERT OR REPLACE INTO paints (decimal, hex, name, blu_hex) VALUES (?, ?, ?, ?)');
        for (const p of s.paints) {
          if (typeof p.decimal !== 'number' || !Number.isInteger(p.decimal)) continue;
          paints.run(p.decimal, String(p.hex ?? ''), String(p.name ?? ''), bindStrOrNull(p.bluHex));
        }

        const kits = db.prepare('INSERT OR REPLACE INTO paintkits (id, name) VALUES (?, ?)');
        for (const k of s.paintkits) {
          if (typeof k.id !== 'number' || !Number.isInteger(k.id)) continue;
          kits.run(k.id, String(k.name ?? ''));
        }

        setMeta(META_SCHEMA_FETCHED_AT, String(bindNum(s.fetchedAt)));
        if (typeof s.etag === 'string') setMeta(META_SCHEMA_ETAG, s.etag);
        else run('DELETE FROM meta WHERE key = ?', META_SCHEMA_ETAG);
      });
    },

    schemaItem(defindex) {
      const r = get('SELECT * FROM schema_items WHERE defindex = ?', bindNum(defindex, -1));
      return r ? rowToSchemaItem(r) : null;
    },

    allSchemaItems() {
      return all('SELECT * FROM schema_items ORDER BY defindex ASC').map(rowToSchemaItem);
    },

    effects() {
      return all('SELECT * FROM effects ORDER BY id ASC').map(rowToEffect);
    },

    paints() {
      return all('SELECT * FROM paints ORDER BY name COLLATE NOCASE ASC, decimal ASC').map(rowToPaint);
    },

    paintkits() {
      return all('SELECT * FROM paintkits ORDER BY id ASC').map(rowToPaintkit);
    },

    schemaInfo() {
      const fetched = getMeta(META_SCHEMA_FETCHED_AT);
      const loadedAt = fetched === null ? null : Number(fetched);
      return {
        items: count('schema_items'),
        effects: count('effects'),
        paintkits: count('paintkits'),
        loadedAt: loadedAt !== null && Number.isFinite(loadedAt) ? loadedAt : null,
        etag: getMeta(META_SCHEMA_ETAG),
      };
    },

    // ----- saved-page imports -----

    createImportBatch(b) {
      const categories = cleanCategoryCounts(b.categories);
      return insertId(
        'INSERT INTO import_batches (file_name, page_kind, file_mtime, imported_at, item_count, categories, bank, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        String(b.fileName ?? ''),
        String(b.pageKind),
        bindNum(b.fileMtime),
        bindNum(b.importedAt),
        bindNum(b.itemCount),
        categories ? JSON.stringify(categories) : null,
        bankOrNull(b.bank),
        originOrNull(b.origin),
      );
    },

    listImportBatches(limit) {
      const lim = clampLimit(limit, 50, GENERIC_MAX_LIMIT);
      return all('SELECT * FROM import_batches ORDER BY imported_at DESC, id DESC LIMIT ?', lim).map(rowToImportBatch);
    },

    bankNewestSaves() {
      // Per bank, so each read is one index seek; a window-function pass would sort every batch ever written.
      const out: BankNewestSave[] = [];
      for (const bank of SCRAPTF_BANK_IDS) {
        const r = get(BANK_NEWEST_SAVE, bank);
        if (r) out.push({ bank, batchId: num(r['id']), savedAt: num(r['saved_at']), itemCount: num(r['item_count']) });
      }
      return out;
    },

    // ----- scrap.tf price list (F14) -----

    upsertScraptfList(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      return db.transaction(() => {
        const stmt = db.prepare(SCRAPTF_LIST_UPSERT);
        let written = 0;
        for (const r of rows) {
          if (!r || typeof r.sku !== 'string' || r.sku.trim() === '') continue;
          // A row with neither price, or no time, is a parser slip, not a reason to fail the import.
          // A "Sold out" row has no price to buy but still a price scrap.tf pays, so it is kept.
          const sellsScrap = bindNumOrNull(r.sellsScrap);
          const paysScrap = bindNumOrNull(r.paysScrap);
          if (sellsScrap === null && paysScrap === null) continue;
          if (typeof r.observedAt !== 'number' || !Number.isFinite(r.observedAt)) continue;
          written += Number(
            stmt.run(
              r.sku,
              String(r.name ?? ''),
              sellsScrap === null ? null : bindNum(r.sellsKeys),
              sellsScrap === null ? null : Math.round(sellsScrap),
              paysScrap === null ? null : bindNum(r.paysKeys),
              paysScrap === null ? null : Math.round(paysScrap),
              bindCountOrNull(r.stock),
              bindCountOrNull(r.stockLimit),
              bindNum(r.batchId),
              r.observedAt,
              // 0.7.4: anything but a known value is stored unproven.
              oneOf(r.craft, SCRAPTF_LIST_CRAFTS, 'any'),
              // 0.7.4 (F60): the page it was read on, clipped as bank_stock.page ('' when not known).
              typeof r.page === 'string' ? r.page.slice(0, BANK_STOCK_PAGE_MAX_CHARS) : '',
            ).changes,
          );
        }
        return written;
      });
    },

    scraptfList() {
      return all('SELECT * FROM scraptf_list ORDER BY sku ASC').map(rowToScraptfList);
    },

    scraptfListRow(sku) {
      if (typeof sku !== 'string' || sku === '') return null;
      const r = get('SELECT * FROM scraptf_list WHERE sku = ?', sku);
      return r ? rowToScraptfList(r) : null;
    },

    scraptfListSummary() {
      const r = get(
        'SELECT COUNT(*) AS n, MAX(observed_at) AS newest, MIN(observed_at) AS oldest, COUNT(DISTINCT batch_id) AS batches FROM scraptf_list',
      );
      return {
        items: num(r?.['n']),
        newestAt: numOrNull(r?.['newest']),
        oldestAt: numOrNull(r?.['oldest']),
        batches: num(r?.['batches']),
      };
    },

    purgeScraptfListOlderThan(ts) {
      return run('DELETE FROM scraptf_list WHERE observed_at < ?', bindNum(ts));
    },

    deleteScraptfListRows(skus, beforeTs) {
      const list = [...new Set((Array.isArray(skus) ? skus : []).filter((s): s is string => typeof s === 'string' && s !== ''))];
      if (list.length === 0 || typeof beforeTs !== 'number' || !Number.isFinite(beforeTs)) return 0;
      return db.transaction(() => {
        let n = 0;
        for (const part of chunk(list)) n += run(`DELETE FROM scraptf_list WHERE sku IN (${placeholders(part.length)}) AND observed_at < ?`, ...part, beforeTs);
        return n;
      });
    },

    // ----- scrap.tf bank stock (F17) -----

    bankStockNewestBankOf(skus) {
      let best: { bank: ScraptfBank; savedAt: number; batchId: number } | null = null;
      for (const sku of new Set(Array.isArray(skus) ? skus : [])) {
        if (typeof sku !== 'string' || sku === '') continue;
        const r = get(BANK_STOCK_NEWEST_BANK, sku);
        const bank = r ? bankOrNull(r['bank']) : null;
        if (!r || bank === null) continue;
        const savedAt = num(r['saved_at']);
        const batchId = num(r['batch_id']);
        if (!best || savedAt > best.savedAt || (savedAt === best.savedAt && batchId > best.batchId)) best = { bank, savedAt, batchId };
      }
      return best?.bank ?? null;
    },

    insertBankStock(batchId, bank, rows, page) {
      const id = requireId('batchId', batchId);
      const b = bankOrNull(bank);
      if (b === null) throw new TypeError('bank must be a scrap.tf bank id');
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      const pageKey = typeof page === 'string' ? page.slice(0, BANK_STOCK_PAGE_MAX_CHARS) : '';
      return db.transaction(() => {
        // First row wins: the import already picked one row per (SKU, extras).
        const stmt = db.prepare(BANK_STOCK_INSERT);
        let written = 0;
        for (const r of rows) {
          if (!r || typeof r.sku !== 'string' || r.sku.trim() === '') continue;
          const costScrap = bindNumOrNull(r.costScrap);
          const priced = costScrap !== null;
          written += Number(
            stmt.run(
              id,
              b,
              r.sku,
              typeof r.specialKey === 'string' ? r.specialKey : '',
              String(r.name ?? ''),
              priced ? bindNum(r.costKeys) : null,
              priced ? Math.round(costScrap) : null,
              bindCountOrNull(r.stock),
              bindStrOrNull(r.assetId),
              pageKey,
              // 0.7.4 (V14): the /items list's rows only; anything but a known value is stored unproven.
              b === 'list' && r.craft !== undefined && r.craft !== null ? oneOf(r.craft, SCRAPTF_LIST_CRAFTS, 'any') : null,
            ).changes,
          );
        }
        // F20: the save's entry, in the same transaction (a save with no row is no save).
        if (written > 0) db.prepare(BANK_STOCK_SAVE_UPSERT).run(id, b, pageKey, written);
        return written;
      });
    },

    bankStockSaves(bank, limit, opts) {
      const b = bankOrNull(bank);
      if (b === null) return [];
      const lim = clampLimit(limit, 50, GENERIC_MAX_LIMIT);
      const perPage = typeof opts?.perPage === 'number' && Number.isFinite(opts.perPage) ? Math.max(1, Math.floor(opts.perPage)) : null;
      const rows = perPage === null ? all(BANK_STOCK_SAVES, b, lim) : all(BANK_STOCK_PAGE_HEADS, b, perPage, lim);
      return rows.map((r): BankStockSave => ({ batchId: num(r['batch_id']), savedAt: num(r['saved_at']), items: num(r['items']), page: str(r['page']) }));
    },

    bankStockRows(batchId) {
      return all('SELECT * FROM bank_stock WHERE batch_id = ? ORDER BY sku ASC, special_key ASC', bindNum(batchId, -1)).map(rowToBankStock);
    },

    bankStockLatestPair(bank) {
      const [newest = null, previous = null] = repo.bankStockSaves(bank, 2);
      return { newest, previous };
    },

    bankStockSaveIndex() {
      // From bank_stock_saves (one row per kept save): never a scan of bank_stock or of every batch.
      return all(BANK_STOCK_SAVE_INDEX).flatMap((r): BankStockThinSave[] => {
        const bank = bankOrNull(r['bank']);
        return bank === null ? [] : [{ batchId: num(r['batch_id']), savedAt: num(r['saved_at']), bank, page: str(r['page']) }];
      });
    },

    bankStockRowsOf(batchIds) {
      const out = new Map<number, BankStockStored[]>();
      const ids = [...new Set((Array.isArray(batchIds) ? batchIds : []).filter((v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0))];
      for (const part of chunk(ids)) {
        for (const r of all(`SELECT * FROM bank_stock WHERE batch_id IN (${placeholders(part.length)}) ORDER BY batch_id ASC, sku ASC, special_key ASC`, ...part)) {
          const id = num(r['batch_id']);
          let rows = out.get(id);
          if (!rows) out.set(id, (rows = []));
          rows.push(rowToBankStock(r));
        }
      }
      return out;
    },

    pruneBankStock(now, opts) {
      return db.transaction(() => {
        let n = 0;
        // A batch row that is gone (a damaged database) leaves rows no save can be dated by. Scans the
        // table, so only maintenance asks (importSavedPage passes orphans: false).
        if (opts?.orphans !== false) {
          n += run('DELETE FROM bank_stock WHERE batch_id NOT IN (SELECT id FROM import_batches)');
          run('DELETE FROM bank_stock_saves WHERE batch_id NOT IN (SELECT id FROM import_batches)');
        }
        const drop = bankStockThinning(repo.bankStockSaveIndex(), bindNum(now), {
          ...(typeof opts?.maxSaves === 'number' ? { maxSaves: opts.maxSaves } : {}),
          ...(typeof opts?.maxAgeMs === 'number' ? { maxAgeMs: opts.maxAgeMs } : {}),
        });
        // The count is of bank_stock rows; the saves' entries go with them.
        for (const part of chunk([...drop])) {
          n += run(`DELETE FROM bank_stock WHERE batch_id IN (${placeholders(part.length)})`, ...part);
          run(`DELETE FROM bank_stock_saves WHERE batch_id IN (${placeholders(part.length)})`, ...part);
        }
        return n;
      });
    },

    // ----- scrap.tf change feed (F20) -----

    insertScraptfEvents(events) {
      if (!Array.isArray(events) || events.length === 0) return 0;
      return db.transaction(() => {
        const stmt = db.prepare(SCRAPTF_EVENT_INSERT);
        let written = 0;
        for (const e of events) {
          if (!e || typeof e.sku !== 'string' || e.sku.trim() === '') continue;
          const bank = bankOrNull(e.bank);
          if (bank === null || !(SCRAPTF_CHANGE_KINDS as readonly string[]).includes(e.kind)) continue;
          if (typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
          if (typeof e.batchId !== 'number' || !Number.isSafeInteger(e.batchId) || e.batchId <= 0) continue;
          const fromScrap = bindNumOrNull(e.fromScrap);
          const toScrap = bindNumOrNull(e.toScrap);
          written += Number(
            stmt.run(
              Math.round(e.at),
              bank,
              typeof e.page === 'string' ? e.page.slice(0, BANK_STOCK_PAGE_MAX_CHARS) : '',
              e.sku,
              typeof e.specialKey === 'string' ? e.specialKey : '',
              String(e.name ?? '').slice(0, 300),
              e.kind,
              fromScrap === null ? null : bindNum(e.fromKeys),
              fromScrap === null ? null : Math.round(fromScrap),
              toScrap === null ? null : bindNum(e.toKeys),
              toScrap === null ? null : Math.round(toScrap),
              bindCountOrNull(e.fromStock),
              bindCountOrNull(e.toStock),
              e.batchId,
            ).changes,
          );
        }
        return written;
      });
    },

    scraptfEvents(q) {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (q?.bank !== undefined) {
        const bank = bankOrNull(q.bank);
        if (bank === null) return [];
        where.push('bank = ?');
        params.push(bank);
      }
      // An empty list is no filter (as scraptfEventMatches); a list of only unknown kinds matches nothing.
      if (q?.kinds !== undefined && q.kinds.length > 0) {
        const kinds = uniqueStrings(q.kinds).filter((k) => (SCRAPTF_CHANGE_KINDS as readonly string[]).includes(k));
        if (kinds.length === 0) return [];
        where.push(`kind IN (${placeholders(kinds.length)})`);
        params.push(...kinds);
      }
      if (typeof q?.sku === 'string') {
        where.push('sku = ?');
        params.push(q.sku);
        if (typeof q.specialKey === 'string') {
          where.push('special_key = ?');
          params.push(q.specialKey);
        }
      }
      if (typeof q?.beforeId === 'number' && Number.isFinite(q.beforeId)) {
        where.push('id < ?');
        params.push(q.beforeId);
      }
      if (typeof q?.sinceAt === 'number' && Number.isFinite(q.sinceAt)) {
        where.push('at >= ?');
        params.push(q.sinceAt);
      }
      const lim = Math.max(1, clampLimit(q?.limit, SCRAPTF_CHANGES_DEFAULT_LIMIT, EVENTS_MAX_LIMIT));
      const sql = `SELECT * FROM scraptf_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
      return all(sql, ...params, lim).flatMap(rowToScraptfEvent);
    },

    scraptfEventsForSku(sku, limit) {
      if (typeof sku !== 'string' || sku === '') return [];
      const lim = Math.max(1, clampLimit(limit, SCRAPTF_ITEM_EVENTS, EVENTS_MAX_LIMIT));
      return all('SELECT * FROM scraptf_events WHERE sku = ? ORDER BY id DESC LIMIT ?', sku, lim).flatMap(rowToScraptfEvent);
    },

    pruneScraptfEvents(now, maxAgeMs) {
      const maxAge = typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) ? Math.max(0, maxAgeMs) : SCRAPTF_EVENTS_MAX_AGE_MS;
      return run('DELETE FROM scraptf_events WHERE at < ?', bindNum(now) - maxAge);
    },

    // ----- recorded exit runs (0.8 H1) -----

    latestHoldingMarks(bases) {
      const out = new Map<string, HoldingMark>();
      for (const base of new Set(bases)) {
        if (typeof base !== 'string' || base === '') continue;
        // One seek on holding_marks_base_from per base.
        const r = get('SELECT * FROM holding_marks WHERE base_sku = ? ORDER BY from_at DESC, id DESC LIMIT 1', base);
        if (r) out.set(base, rowToHoldingMark(r));
      }
      return out;
    },

    insertHoldingMark(m) {
      const base = requireText('baseSku', m.baseSku);
      const fromAt = requireFinite('fromAt', m.fromAt);
      const toAt = requireFinite('toAt', m.toAt);
      // Both or neither per side: keys are bound NULL when that side's metal is not finite.
      const side = (keys: unknown, metal: unknown): [number | null, number | null] => {
        const metalScrap = bindMetalOrNull(metal);
        return metalScrap === null ? [null, null] : [bindNum(keys), metalScrap];
      };
      return insertId(
        HOLDING_MARK_INSERT,
        base,
        fromAt,
        toAt,
        ...side(m.revKeys, m.revMetalScrap),
        bindBoolOrNull(m.revIsBot),
        bindBoolOrNull(m.revVerified),
        ...side(m.bestKeys, m.bestMetalScrap),
        ...side(m.nextKeys, m.nextMetalScrap),
        bindCountOrNull(m.buyerCount) ?? 0,
        bindCountOrNull(m.verifiedBuyerCount),
        ...side(m.askKeys, m.askMetalScrap),
        bindCountOrNull(m.askCount),
        ...side(m.scraptfPaysKeys, m.scraptfPaysScrap),
        bindNumOrNull(m.keyScrap),
      );
    },

    extendHoldingMark(id, toAt, counts) {
      const at = requireFinite('toAt', toAt);
      // MAX: a run's end never moves back. An existing row reports 1 change even when to_at stays.
      if (!counts) return run('UPDATE holding_marks SET to_at = MAX(to_at, ?) WHERE id = ?', at, bindNum(id, -1)) > 0;
      return (
        run(
          'UPDATE holding_marks SET to_at = MAX(to_at, ?), buyer_count = ?, verified_buyer_count = ?, ask_count = ? WHERE id = ?',
          at,
          bindCountOrNull(counts.buyerCount) ?? 0,
          bindCountOrNull(counts.verifiedBuyerCount),
          bindCountOrNull(counts.askCount),
          bindNum(id, -1),
        ) > 0
      );
    },

    holdingMarks(baseSku, sinceTs, limit) {
      if (typeof baseSku !== 'string' || baseSku === '') return [];
      const lim = Math.max(1, clampLimit(limit, HOLDING_DETAIL_MAX_MARKS, HOLDING_MARKS_MAX_LIMIT));
      return all(
        'SELECT * FROM (SELECT * FROM holding_marks WHERE base_sku = ? AND to_at >= ? ORDER BY from_at DESC, id DESC LIMIT ?) ORDER BY from_at, id',
        baseSku,
        bindNum(sinceTs),
        lim,
      ).map(rowToHoldingMark);
    },

    pruneHoldingMarks(now, opts) {
      const maxAge = typeof opts?.maxAgeMs === 'number' && Number.isFinite(opts.maxAgeMs) ? Math.max(0, opts.maxAgeMs) : HOLDING_MARKS_MAX_AGE_MS;
      const perBase = typeof opts?.perBaseMax === 'number' && Number.isFinite(opts.perBaseMax) ? Math.max(0, Math.floor(opts.perBaseMax)) : HOLDING_MARKS_PER_BASE_MAX;
      return db.transaction(() => {
        const old = run('DELETE FROM holding_marks WHERE to_at < ?', bindNum(now) - maxAge);
        // Each base's newest perBase runs are kept; the rest go, oldest first.
        const over = run(
          'DELETE FROM holding_marks WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY base_sku ORDER BY from_at DESC, id DESC) AS rn FROM holding_marks) WHERE rn > ?)',
          perBase,
        );
        return old + over;
      });
    },

    // ----- request log -----

    appendRequestLog(row) {
      run(
        'INSERT INTO request_log (ts, host, path, method, status, ms, bytes, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        bindNum(row.ts),
        String(row.host ?? ''),
        String(row.path ?? ''),
        String(row.method ?? ''),
        bindNum(row.status),
        bindNum(row.ms),
        bindNum(row.bytes),
        bindStrOrNull(row.note),
      );
    },

    recentRequests(limit) {
      const lim = clampLimit(limit, 100, GENERIC_MAX_LIMIT);
      return all('SELECT * FROM request_log ORDER BY id DESC LIMIT ?', lim).map(rowToRequestLog);
    },

    requestsSince(ts) {
      return all('SELECT ts, host, path FROM request_log WHERE ts >= ? ORDER BY ts, id', bindNum(ts)).map((r) => ({
        ts: num(r['ts']),
        host: str(r['host']),
        path: str(r['path']),
      }));
    },

    purgeRequestLogOlderThan(ts) {
      return run('DELETE FROM request_log WHERE ts < ?', bindNum(ts));
    },

    // ----- snapshot bookkeeping -----

    setSnapshotAt(sku: string, ts: UnixMs) {
      run(
        'INSERT INTO snapshot_times (sku, last_at) VALUES (?, ?) ON CONFLICT(sku) DO UPDATE SET last_at = excluded.last_at',
        sku,
        bindNum(ts),
      );
    },

    getSnapshotAt(sku) {
      return numOrNull(get('SELECT last_at FROM snapshot_times WHERE sku = ?', sku)?.['last_at']);
    },
  };

  return repo;
}

