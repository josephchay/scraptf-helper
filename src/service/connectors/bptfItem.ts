// backpack.tf item documents -> canonical SKUs and normalised Listings.
//
// Three inputs share one SKU builder:
//   - websocket v2 payloads (listingFromWsPayload), shapes in test/fixtures/bptf/FIELDS.md
//   - classifieds snapshot v1 listings (listingFromSnapshot), attribute arrays
//   - IGetPrices v4 (communityRowsFromPrices) and IGetCurrencies v1 (parseIGetCurrencies)
// Every payload is validated loosely; sub-fields with an unexpected shape are
// counted in BptfMapStats and ignored instead of failing the whole listing.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BptfNameRow, SchemaService } from '../contracts';
import type {
  CommunityRow,
  Intent,
  KeyPriceQuote,
  Listing,
  SkuObject,
  SpecialAttrs,
  UnixMs,
  UnixSec,
} from '../../shared/types';
import { KEY_SKU } from '../../shared/types';
import { baseSku, fromObject, fromString, looksLikeSku, normalizeSkuObject } from '../../shared/sku';
import { refToScrap } from '../../shared/currency';

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface BptfMapStats {
  mapped: number;
  /** Valid payloads that are not TF2 listings (other appids). */
  skipped: number;
  /** Payloads that failed validation of the required fields. */
  invalid: number;
  priceindexChecked: number;
  priceindexMismatches: number;
  /** Sub-fields whose shape was not understood, by field name. */
  unknownShapes: Record<string, number>;
}

export function createMapStats(): BptfMapStats {
  return { mapped: 0, skipped: 0, invalid: 0, priceindexChecked: 0, priceindexMismatches: 0, unknownShapes: {} };
}

function noteShape(stats: BptfMapStats | undefined, field: string): void {
  if (stats) stats.unknownShapes[field] = (stats.unknownShapes[field] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Game constants (stable game data, DESIGN_BRIEF §4.3/§4.5)
// ---------------------------------------------------------------------------

/** Killstreak kits: Killstreak, Specialized, Professional. Their priceindex is "<tier>-<target>". */
const KIT_DEFINDEXES: ReadonlySet<number> = new Set([6527, 6523, 6526]);

/** Paint can defindex -> RED decimal. Only a fallback when the payload has no usable hex. */
const PAINT_DECIMAL_BY_CAN: ReadonlyMap<number, number> = new Map([
  [5027, 7511618],
  [5028, 4345659],
  [5029, 5322826],
  [5030, 14204632],
  [5031, 8208497],
  [5032, 13595446],
  [5033, 10843461],
  [5034, 12955537],
  [5035, 6901050],
  [5036, 8154199],
  [5037, 15185211],
  [5038, 8289918],
  [5039, 15132390],
  [5040, 1315860],
  [5046, 12073019],
  [5051, 16738740],
  [5052, 3100495],
  [5053, 8421376],
  [5054, 3329330],
  [5055, 15787660],
  [5056, 15308410],
  [5060, 4732984],
  [5061, 11049612],
  [5062, 3874595],
  [5063, 6637376],
  [5064, 8400928],
  [5065, 12807213],
  [5076, 12377523],
  [5077, 2960676],
]);

const PAINT_SPELLS: Readonly<Record<number, string>> = {
  0: 'Die Job',
  1: 'Chromatic Corruption',
  2: 'Putrescent Pigmentation',
  3: 'Spectral Spectrum',
  4: 'Sinister Staining',
};

const FOOTPRINT_SPELLS: Readonly<Record<number, string>> = {
  1: 'Team Spirit Footprints',
  2: 'Headless Horseshoes',
  3100495: 'Corpse Gray Footprints',
  5322826: 'Violent Violet Footprints',
  8208497: 'Bruised Purple Footprints',
  8421376: 'Gangreen Footprints',
  13595446: 'Rotten Orange Footprints',
};

/** Spell attributes whose value does not matter (one spell each). */
const SIMPLE_SPELLS: Readonly<Record<number, string>> = {
  1006: 'Voices From Below',
  1007: 'Pumpkin Bombs',
  1008: 'Halloween Fire',
  1009: 'Exorcism',
};

/** kill_eater_score_type ids confirmed from the websocket capture (strangeParts[].killEater). */
const PART_NAMES: Readonly<Record<number, string>> = {
  13: 'Demomen Killed',
  21: 'Headshot Kills',
  30: 'Revenges',
  36: 'Sappers Removed',
  77: 'Taunt Kills',
};

const KILLSTREAK_BY_PREFIX: readonly [RegExp, number][] = [
  [/\bProfessional Killstreak\b/i, 3],
  [/\bSpecialized Killstreak\b/i, 2],
  [/\bKillstreak\b/i, 1],
];

const WEAR_BY_NAME: Readonly<Record<string, number>> = {
  'factory new': 1,
  'minimal wear': 2,
  'field-tested': 3,
  'well-worn': 4,
  'battle scarred': 5,
};
const WEAR_SUFFIX_RE = /\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle Scarred)\)\s*$/i;
const CRATE_SUFFIX_RE = /\s+#(\d+)\s*$/;

const MAX_DETAILS = 1_000;
const MAX_UA_CLIENT = 128;

// ---------------------------------------------------------------------------
// zod building blocks
// ---------------------------------------------------------------------------

const toNumber = (v: unknown): unknown => {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  }
  return v;
};

const num = z.preprocess(toNumber, z.number().finite());
const int = z.preprocess(toNumber, z.number().int());
const idString = z.union([z.string().min(1), z.number().finite().transform((n) => String(n))]);
/** A number, or an entity object `{id}` (quality, wearTier, killstreakTier...). */
const entityId = z.union([int, z.looseObject({ id: int }).transform((o) => o.id)]);

const intentSchema = z.union([
  z.enum(['buy', 'sell']),
  z.literal(0).transform((): Intent => 'buy'),
  z.literal(1).transform((): Intent => 'sell'),
  z.literal('0').transform((): Intent => 'buy'),
  z.literal('1').transform((): Intent => 'sell'),
]);

const currenciesSchema = z.looseObject({
  keys: num.optional(),
  metal: num.optional(),
  usd: num.optional(),
});
const userAgentSchema = z.looseObject({ client: z.string().optional(), lastPulse: num.optional() });
const userSchema = z.looseObject({
  name: z.string().optional(),
  online: z.boolean().optional(),
  banned: z.boolean().optional(),
  bans: z.unknown().optional(),
});
const particleSchema = z.looseObject({ id: int, type: z.string().optional() });
const paintSchema = z.looseObject({ id: int.optional(), name: z.string().optional(), color: z.string().optional() });
const spellsSchema = z.array(
  z.looseObject({ name: z.string().optional(), spellId: z.string().optional(), id: z.union([z.string(), z.number()]).optional() }),
);
const partsSchema = z.array(
  z.looseObject({ killEater: z.looseObject({ id: int.optional(), name: z.string().optional() }).optional() }),
);
const recipeSchema = z.looseObject({
  outputItem: z.looseObject({ defindex: int, quality: entityId.optional() }).nullish(),
  targetItem: z
    .looseObject({
      defindex: int.optional(),
      _source: z.looseObject({ defindex: int.optional() }).optional(),
    })
    .nullish(),
});
const textureSchema = z.looseObject({ id: int });

const wsItemSchema = z.looseObject({
  defindex: int,
  quality: entityId,
  name: z.string().optional(),
  marketName: z.string().optional(),
  baseName: z.string().optional(),
  priceindex: z.union([z.string(), z.number()]).nullish(),
});

const wsPayloadSchema = z.looseObject({
  id: idString,
  steamid: idString,
  appid: int.optional(),
  intent: intentSchema,
  item: wsItemSchema,
});

/** Parses an optional sub-field; a present value with the wrong shape is counted and ignored. */
function soft<T>(schema: z.ZodType<T>, value: unknown, field: string, stats: BptfMapStats | undefined): T | null {
  if (value === undefined || value === null) return null;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  noteShape(stats, field);
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Seconds; millisecond values are converted, non-positive values dropped. */
function toUnixSec(v: unknown): UnixSec | null {
  const n = toNumber(v);
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Lower id of a RED/BLU pair; killstreaker eye glows (2001-2008) are not unusual effects. */
function canonicalEffect(schema: SchemaService, id: number | null): number | null {
  if (id === null || !Number.isInteger(id) || id <= 0) return null;
  if (id >= 2001 && id <= 2008) return null;
  const c = safeCall(() => schema.canonicalEffectId(id), id);
  return Number.isInteger(c) && c > 0 ? c : id;
}

function normalizeHex(hex: string | undefined | null): string | null {
  if (typeof hex !== 'string') return null;
  const h = hex.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(h)) return h;
  if (/^[0-9a-f]{3}$/.test(h)) return h.replace(/(.)/g, '$1$1');
  return null;
}

function isPaintCan(defindex: number): boolean {
  return PAINT_DECIMAL_BY_CAN.has(defindex);
}

/**
 * RED decimal for the `p` token. The websocket `color` is the RED hex, so its
 * value already is the decimal; the schema confirms it or maps a BLU hex.
 */
function paintDecimalFromWs(
  schema: SchemaService,
  paint: { id?: number | undefined; color?: string | undefined },
  defindex: number,
): number | null {
  if (isPaintCan(defindex) || (paint.id !== undefined && paint.id === defindex)) return null;
  const hex = normalizeHex(paint.color);
  if (hex !== null) {
    const d = parseInt(hex, 16);
    if (safeCall(() => schema.paintByDecimal(d), null)) return d;
    const viaHex = safeCall(() => schema.paintDecimalByHex(`#${hex}`), null);
    if (typeof viaHex === 'number' && viaHex > 0) return viaHex;
    if (paint.id !== undefined) {
      const byCan = PAINT_DECIMAL_BY_CAN.get(paint.id);
      if (byCan !== undefined) return byCan;
    }
    return d;
  }
  if (paint.id !== undefined) return PAINT_DECIMAL_BY_CAN.get(paint.id) ?? null;
  return null;
}

function bansNonEmpty(bans: unknown): boolean {
  if (Array.isArray(bans)) return bans.length > 0;
  if (isRecord(bans)) return Object.keys(bans).length > 0;
  return false;
}

function hasMarketplaceKey(o: unknown): boolean {
  return isRecord(o) && Object.keys(o).some((k) => /^marketplace/i.test(k));
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim() !== ''))].sort();
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/** backpack.tf buy-order id: `440_<steamid>_<md5(full item name)>` (verified on the live feed). */
export function bptfBuyListingId(steamid: string, itemName: string): string {
  return `440_${steamid}_${md5(itemName)}`;
}

/** priceindex "6526-6-466" -> [6526, 6, 466]; null for "", "0" or non-numeric parts. */
function parsePriceindex(pi: unknown): number[] | null {
  if (pi === null || pi === undefined) return null;
  const s = String(pi).trim();
  if (s === '' || s === '0') return null;
  const parts = s.split('-');
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

function isTargetTool(name: string | undefined): boolean {
  return typeof name === 'string' && /\b(Strangifier|Unusualifier)\b/i.test(name) && !/Chemistry Set/i.test(name);
}

function isCrateItem(schema: SchemaService, defindexes: readonly number[], name: string | undefined): boolean {
  for (const d of defindexes) {
    const row = safeCall(() => schema.itemByDefindex(d), null);
    if (row && row.itemClass === 'supply_crate') return true;
  }
  return typeof name === 'string' && /\b(Crate|Case|Cooler|Munition)\b/i.test(name);
}

/** Name tokens that precede the base item name, e.g. "Strange Festivized Professional Killstreak". */
interface NameHints {
  nonCraftable: boolean;
  nonTradable: boolean;
  strange: boolean;
  festivized: boolean;
  australium: boolean;
  killstreak: number;
  wear: number | null;
  crateSeries: number | null;
}

function baseNameFor(schema: SchemaService, defindex: number, given: string | undefined): string | null {
  if (typeof given === 'string' && given.trim() !== '') return given.trim();
  const row = safeCall(() => schema.itemByDefindex(defindex), null);
  return row ? row.itemName : null;
}

function nameHints(fullName: string | undefined, baseName: string | null): NameHints {
  const out: NameHints = {
    nonCraftable: false,
    nonTradable: false,
    strange: false,
    festivized: false,
    australium: false,
    killstreak: 0,
    wear: null,
    crateSeries: null,
  };
  if (typeof fullName !== 'string' || fullName.trim() === '') return out;
  let name = fullName.trim();
  const w = WEAR_SUFFIX_RE.exec(name);
  if (w) {
    out.wear = WEAR_BY_NAME[w[1]!.toLowerCase()] ?? null;
    name = name.slice(0, w.index).trim();
  }
  const c = CRATE_SUFFIX_RE.exec(name);
  if (c) {
    out.crateSeries = Number(c[1]);
    name = name.slice(0, c.index).trim();
  }
  out.nonCraftable = /^Non-Craftable\b/i.test(name);
  out.nonTradable = /^(Non-Tradable|Untradable)\b/i.test(name);

  // Without the base name only unambiguous prefixes are trusted ("Strange Bacon Grease" is a hat).
  let prefix: string | null = null;
  if (baseName) {
    const idx = name.toLowerCase().lastIndexOf(baseName.toLowerCase());
    if (idx >= 0) prefix = name.slice(0, idx);
    else {
      const bare = baseName.replace(/^The\s+/i, '');
      const j = name.toLowerCase().lastIndexOf(bare.toLowerCase());
      if (j >= 0) prefix = name.slice(0, j);
    }
  }
  const scope = prefix ?? '';
  out.festivized = /\bFestivized\b/i.test(scope);
  out.australium = /\bAustralium\b/i.test(scope);
  // bp.tf always puts the elevated "Strange" first ("Strange Collector's ...", "Strange Burning Flames ...").
  out.strange = /^Strange\s/i.test(scope.replace(/^Non-Craftable\s+/i, '')) && !/^Strange\b/i.test(baseName ?? '');
  const ksScope = prefix ?? name;
  for (const [re, tier] of KILLSTREAK_BY_PREFIX) {
    if (re.test(ksScope)) {
      out.killstreak = tier;
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Websocket (v2 item document)
// ---------------------------------------------------------------------------

export type WsMapResult =
  | { ok: true; listing: Listing; name: BptfNameRow; priceindexMismatch: boolean }
  | { ok: false; reason: 'invalid' | 'not-tf2'; detail: string };

interface ParsedWsItem {
  obj: SkuObject;
  special: SpecialAttrs;
  priceindexMismatch: boolean;
}

function wsSkuParts(item: Record<string, unknown>, schema: SchemaService, stats: BptfMapStats | undefined): ParsedWsItem | null {
  const base = wsItemSchema.safeParse(item);
  if (!base.success) return null;
  const it = base.data;
  const defindex = it.defindex;
  const quality = it.quality;
  const name = it.name;
  const baseName = baseNameFor(schema, defindex, it.baseName);
  const hints = nameHints(name, baseName);

  const particle = soft(particleSchema, item['particle'], 'particle', stats);
  const rawEffect = particle ? particle.id : null;
  let effect = canonicalEffect(schema, rawEffect);

  const elevated = soft(entityId, item['elevatedQuality'], 'elevatedQuality', stats);
  let quality2: number | null = null;
  if (elevated !== null) quality2 = elevated === 11 && quality !== 11 ? 11 : null;
  else if (hints.strange && quality !== 11) quality2 = 11;

  let killstreak = soft(entityId, item['killstreakTier'], 'killstreakTier', stats) ?? 0;
  if (killstreak < 0 || killstreak > 3) {
    noteShape(stats, 'killstreakTier');
    killstreak = 0;
  }
  if (killstreak === 0 && item['killstreakTier'] === undefined) killstreak = hints.killstreak;

  let wear = soft(entityId, item['wearTier'], 'wearTier', stats);
  if (wear !== null && (wear < 1 || wear > 5)) {
    noteShape(stats, 'wearTier');
    wear = null;
  }
  const texture = soft(textureSchema, item['texture'], 'texture', stats);
  // 0.7.3: pk0 (Red Rock Roscoe) is a real paintkit id, so only negatives are dropped.
  const paintkit = texture && texture.id >= 0 ? texture.id : null;
  const crate = soft(int, item['crateSeries'], 'crateSeries', stats);
  let crateseries = crate !== null && crate > 0 ? crate : null;

  let output: number | null = null;
  let outputQuality: number | null = null;
  let target: number | null = null;
  const recipe = soft(recipeSchema, item['recipe'], 'recipe', stats);
  if (recipe) {
    if (recipe.outputItem) {
      output = recipe.outputItem.defindex;
      outputQuality = recipe.outputItem.quality ?? null;
    }
    target = recipe.targetItem?.defindex ?? recipe.targetItem?._source?.defindex ?? null;
  }

  const isKit = KIT_DEFINDEXES.has(defindex);
  const pi = parsePriceindex(it.priceindex);
  if (pi) {
    if (pi.length === 3) {
      output ??= pi[0]!;
      outputQuality ??= pi[1]!;
      target ??= pi[2]!;
    } else if (pi.length === 2) {
      if (isKit) {
        if (killstreak === 0) killstreak = pi[0]! <= 3 ? pi[0]! : 0;
        target ??= pi[1]!;
      } else {
        output ??= pi[0]!;
        outputQuality ??= pi[1]!;
      }
    } else if (pi.length === 1 && rawEffect === null && crateseries === null) {
      const v = pi[0]!;
      if (isTargetTool(name) || (recipe && target === null)) target = v;
      else if (quality === 5) effect = canonicalEffect(schema, v);
      else if (isCrateItem(schema, [defindex], baseName ?? name)) crateseries = v;
      else noteShape(stats, 'priceindex');
    }
  }

  const craftableField = item['craftable'];
  const tradableField = item['tradable'];
  // Non-craftable items omit `craftable` entirely (FIELDS.md), so the name decides.
  const craftable = typeof craftableField === 'boolean' ? craftableField : !hints.nonCraftable;
  const tradable = typeof tradableField === 'boolean' ? tradableField : !hints.nonTradable;

  const obj = normalizeSkuObject({
    defindex,
    quality,
    craftable,
    tradable,
    killstreak,
    australium: item['australium'] === true,
    effect,
    festive: item['festivized'] === true,
    paintkit,
    wear,
    quality2,
    crateseries,
    target,
    output,
    outputQuality,
  });

  // Cross-check the computed object against bp.tf's own priceindex.
  let priceindexMismatch = false;
  const given = pi ? pi.join('-') : '';
  let expected = '';
  if (obj.output) expected = [obj.output, obj.outputQuality ?? 6, ...(obj.target ? [obj.target] : [])].join('-');
  else if (isKit && obj.target) expected = `${obj.killstreak}-${obj.target}`;
  else if (rawEffect !== null) expected = String(rawEffect);
  else if (obj.effect) expected = String(obj.effect);
  else if (obj.crateseries) expected = String(obj.crateseries);
  else if (obj.target) expected = String(obj.target);
  if (given !== '' || expected !== '') {
    if (stats) stats.priceindexChecked++;
    if (given !== expected) {
      priceindexMismatch = true;
      if (stats) stats.priceindexMismatches++;
    }
  }

  const paintRaw = soft(paintSchema, item['paint'], 'paint', stats);
  const paint = paintRaw ? paintDecimalFromWs(schema, paintRaw, defindex) : null;
  const spells = soft(spellsSchema, item['spells'], 'spells', stats) ?? [];
  const parts = soft(partsSchema, item['strangeParts'], 'strangeParts', stats) ?? [];
  const sheen = soft(entityId, item['sheen'], 'sheen', stats);
  const killstreaker = soft(entityId, item['killstreaker'], 'killstreaker', stats);
  const special: SpecialAttrs = {
    paint,
    spells: uniqSorted(spells.map((s) => s.name ?? s.spellId ?? (s.id !== undefined ? String(s.id) : ''))),
    parts: uniqSorted(
      parts.map((p) => p.killEater?.name ?? (p.killEater?.id !== undefined ? `part:${p.killEater.id}` : 'part:unknown')),
    ),
    sheen: sheen !== null && sheen > 0 ? sheen : null,
    killstreaker: killstreaker !== null && killstreaker > 0 ? killstreaker : null,
    customName: typeof item['customName'] === 'string' && item['customName'].trim() !== '',
    customDesc: typeof item['customDesc'] === 'string' && item['customDesc'].trim() !== '',
  };

  return { obj, special, priceindexMismatch };
}

/**
 * Maps one websocket `listing-update` payload. Never reads `user.tradeOfferUrl`
 * (it carries a trade token).
 */
export function mapWsPayload(payload: unknown, schema: SchemaService, nowMs: UnixMs, stats?: BptfMapStats): WsMapResult {
  const parsed = wsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    if (stats) stats.invalid++;
    return { ok: false, reason: 'invalid', detail: parsed.error.issues[0]?.path.join('.') ?? 'payload' };
  }
  const p = parsed.data;
  const raw = payload as Record<string, unknown>;
  if (p.appid !== undefined && p.appid !== 440) {
    if (stats) stats.skipped++;
    return { ok: false, reason: 'not-tf2', detail: `appid ${p.appid}` };
  }
  const item = raw['item'] as Record<string, unknown>;
  if (item['appid'] !== undefined && toNumber(item['appid']) !== 440) {
    if (stats) stats.skipped++;
    return { ok: false, reason: 'not-tf2', detail: `item appid ${String(item['appid'])}` };
  }

  const parts = wsSkuParts(item, schema, stats);
  if (!parts) {
    if (stats) stats.invalid++;
    return { ok: false, reason: 'invalid', detail: 'item' };
  }

  const currencies = soft(currenciesSchema, raw['currencies'], 'currencies', stats);
  const userAgent = soft(userAgentSchema, raw['userAgent'], 'userAgent', stats);
  const user = soft(userSchema, raw['user'], 'user', stats);
  const keys = currencies?.keys !== undefined && currencies.keys > 0 ? currencies.keys : 0;
  const metal = currencies?.metal !== undefined && currencies.metal > 0 ? currencies.metal : 0;

  const sku = fromObject({ ...parts.obj, paint: parts.special.paint });
  const base = baseSku(parts.obj);
  const itemName = typeof item['name'] === 'string' && item['name'].trim() !== '' ? item['name'] : null;
  const marketName = typeof item['marketName'] === 'string' && item['marketName'].trim() !== '' ? item['marketName'] : null;

  const listing: Listing = {
    id: p.id,
    sku,
    baseSku: base,
    intent: p.intent,
    steamid: p.steamid,
    userName: user?.name ?? null,
    keys,
    metalScrap: refToScrap(metal),
    isBot: userAgent !== null,
    uaClient: userAgent?.client !== undefined ? userAgent.client.slice(0, MAX_UA_CLIENT) : null,
    uaLastPulse: toUnixSec(userAgent?.lastPulse),
    userOnline: typeof user?.online === 'boolean' ? user.online : null,
    userBanned: user?.banned === true || bansNonEmpty(user?.bans),
    isMarketplace:
      currencies?.usd !== undefined || hasMarketplaceKey(item) || hasMarketplaceKey(raw) || /marketplace/i.test(String(raw['source'] ?? '')),
    special: parts.special,
    details: cleanText(raw['details'], MAX_DETAILS),
    listedAt: toUnixSec(raw['listedAt']),
    bumpedAt: toUnixSec(raw['bumpedAt']),
    lastEventAt: nowMs,
    origin: 'ws',
    itemName,
    marketName,
  };
  if (stats) stats.mapped++;
  return {
    ok: true,
    listing,
    name: { sku: base, name: itemName ?? '', marketName, lastSeen: nowMs },
    priceindexMismatch: parts.priceindexMismatch,
  };
}

/**
 * Websocket `listing-update` payload -> Listing plus the learned bp.tf name
 * (keyed by base SKU). Null for invalid payloads and other games. The name
 * row has an empty `name` when bp.tf sent none; Repo.upsertBptfNames skips those.
 */
export function listingFromWsPayload(
  payload: unknown,
  schema: SchemaService,
  nowMs: UnixMs,
  stats?: BptfMapStats,
): { listing: Listing; name: BptfNameRow } | null {
  const r = mapWsPayload(payload, schema, nowMs, stats);
  return r.ok ? { listing: r.listing, name: r.name } : null;
}

// ---------------------------------------------------------------------------
// Classifieds snapshot (v1 attribute arrays)
// ---------------------------------------------------------------------------

const attributeSchema = z.looseObject({
  defindex: int,
  value: z.unknown().optional(),
  float_value: z.unknown().optional(),
});

interface Attr {
  value: number | null;
  float: number | null;
  text: string | null;
}

const f32 = new DataView(new ArrayBuffer(4));

/** Float-stored attribute: float_value, else `value` (decoding raw float bits when that is what it is). */
function attrFloat(a: Attr | undefined): number | null {
  if (!a) return null;
  if (a.float !== null) return a.float;
  if (a.value === null) return null;
  if (Number.isInteger(a.value) && a.value >= 0x00800000 && a.value <= 0xffffffff) {
    f32.setUint32(0, a.value);
    const decoded = f32.getFloat32(0);
    if (Number.isFinite(decoded) && Math.abs(decoded) >= 1e-6) return decoded;
  }
  return a.value;
}

/** Integer-stored attribute: `value`, else an integral float_value. */
function attrInt(a: Attr | undefined): number | null {
  if (!a) return null;
  if (a.value !== null && Number.isInteger(a.value)) return a.value;
  if (a.float !== null && Number.isInteger(a.float)) return a.float;
  return null;
}

function attrPresentNonZero(a: Attr | undefined): boolean {
  if (!a) return false;
  const v = attrFloat(a);
  return v !== null && v !== 0;
}

function readAttributes(raw: unknown, stats: BptfMapStats | undefined): Map<number, Attr> {
  const out = new Map<number, Attr>();
  if (raw === undefined || raw === null) return out;
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : null;
  if (!list) {
    noteShape(stats, 'attributes');
    return out;
  }
  for (const entry of list) {
    const r = attributeSchema.safeParse(entry);
    if (!r.success) {
      noteShape(stats, 'attribute');
      continue;
    }
    const v = toNumber(r.data.value);
    const f = toNumber(r.data.float_value);
    out.set(r.data.defindex, {
      value: typeof v === 'number' && Number.isFinite(v) ? v : null,
      float: typeof f === 'number' && Number.isFinite(f) ? f : null,
      text: typeof r.data.value === 'string' && !Number.isFinite(Number(r.data.value)) ? r.data.value : null,
    });
  }
  return out;
}

const snapshotItemSchema = z.looseObject({
  defindex: int,
  quality: entityId,
  id: idString.optional(),
});

const snapshotListingSchema = z.looseObject({
  steamid: idString,
  intent: intentSchema,
  item: snapshotItemSchema,
});

function wearFromFloat(f: number | null): number | null {
  if (f === null || !(f > 0) || f > 1.0001) return null;
  return Math.min(5, Math.max(1, Math.round(f * 5)));
}

function spellsFromAttrs(attrs: Map<number, Attr>): string[] {
  const out: string[] = [];
  const paintSpell = attrs.get(1004);
  if (paintSpell) {
    const v = attrFloat(paintSpell);
    out.push(v !== null && PAINT_SPELLS[v] ? PAINT_SPELLS[v]! : `spell:1004:${v ?? '?'}`);
  }
  const foot = attrs.get(1005);
  if (foot) {
    const v = attrFloat(foot);
    out.push(v !== null && FOOTPRINT_SPELLS[v] ? FOOTPRINT_SPELLS[v]! : `spell:1005:${v ?? '?'}`);
  }
  for (const [def, label] of Object.entries(SIMPLE_SPELLS)) {
    if (attrs.has(Number(def))) out.push(label);
  }
  return out;
}

/** Strange parts: score-type attributes 380/382/384/386/388 (count attributes are the odd ids). */
function partsFromAttrs(attrs: Map<number, Attr>): string[] {
  const out: string[] = [];
  let anyPartAttr = false;
  for (let def = 379; def <= 388; def++) {
    const a = attrs.get(def);
    if (!a) continue;
    anyPartAttr = true;
    if (def % 2 === 0) {
      const t = attrFloat(a);
      if (t !== null && Number.isInteger(t) && t >= 0) out.push(PART_NAMES[t] ?? `part:${t}`);
    }
  }
  if (anyPartAttr && out.length === 0) out.push('part:unknown');
  return out;
}

/**
 * One listing from `GET /classifieds/listings/snapshot` (v1). `itemName` is the
 * bp.tf full name the snapshot was requested for: it supplies the buy-order id
 * and fills SKU fields the attribute array leaves out. `requestedSku` is the SKU
 * that name was resolved from: v1 attributes never carry a recipe's output item
 * (Kit Fabricators, Chemistry Sets), so `od`/`oq` (and a missing `td`) come from
 * it, keeping snapshot rows on the same base SKU as the feed's rows.
 */
export function listingFromSnapshot(
  raw: unknown,
  schema: SchemaService,
  nowMs: UnixMs,
  itemName: string,
  stats?: BptfMapStats,
  requestedSku?: string | null,
): Listing | null {
  const parsed = snapshotListingSchema.safeParse(raw);
  if (!parsed.success) {
    if (stats) stats.invalid++;
    return null;
  }
  const r = raw as Record<string, unknown>;
  const appid = toNumber(r['appid']);
  if (appid !== undefined && appid !== null && appid !== 440) {
    if (stats) stats.skipped++;
    return null;
  }
  const item = r['item'] as Record<string, unknown>;
  const { defindex, quality } = parsed.data.item;
  const attrs = readAttributes(item['attributes'], stats);
  const baseName = baseNameFor(schema, defindex, undefined);
  const hints = nameHints(itemName, baseName);

  const effectRaw = attrs.has(134) ? attrFloat(attrs.get(134)) : attrs.has(2041) ? attrInt(attrs.get(2041)) : null;
  let effect = canonicalEffect(schema, effectRaw !== null && Number.isInteger(effectRaw) ? effectRaw : null);
  if (effect === null && quality === 5 && !attrs.has(134) && !attrs.has(2041)) {
    let cleaned = baseName ? itemName.replace(new RegExp(`${escapeRegExp(baseName)}\\s*$`, 'i'), '').trim() : '';
    for (let prev = ''; prev !== cleaned; ) {
      prev = cleaned;
      cleaned = cleaned.replace(/^(Non-Craftable|Strange|Unusual)\s+/i, '').trim();
    }
    if (cleaned) effect = canonicalEffect(schema, safeCall(() => schema.effectIdByName(cleaned), null));
  }

  const killstreakAttr = attrFloat(attrs.get(2025));
  const killstreak = killstreakAttr !== null && killstreakAttr >= 1 && killstreakAttr <= 3 ? Math.round(killstreakAttr) : hints.killstreak;
  const wear = wearFromFloat(attrFloat(attrs.get(725))) ?? hints.wear;
  const paintkitAttr = attrInt(attrs.get(834));
  const crateAttr = attrFloat(attrs.get(187));
  const targetAttr = attrFloat(attrs.get(2012));

  const craftable = item['flag_cannot_craft'] === true || item['craftable'] === false ? false : !hints.nonCraftable;
  const tradable = item['flag_cannot_trade'] === true || item['tradable'] === false ? false : !hints.nonTradable;
  const strange = attrs.has(214) || hints.strange;

  const obj = normalizeSkuObject({
    defindex,
    quality,
    craftable,
    tradable,
    killstreak,
    australium: attrPresentNonZero(attrs.get(2027)) || (hints.australium && quality === 11),
    effect,
    festive: attrPresentNonZero(attrs.get(2053)) || hints.festivized,
    paintkit: paintkitAttr !== null && paintkitAttr >= 0 ? paintkitAttr : null, // 0.7.3: pk0 is Red Rock Roscoe
    wear,
    quality2: strange && quality !== 11 ? 11 : null,
    crateseries: crateAttr !== null && crateAttr > 0 ? Math.round(crateAttr) : hints.crateSeries,
    target: targetAttr !== null && targetAttr > 0 ? Math.round(targetAttr) : null,
  });
  const wanted = requestedSku && looksLikeSku(requestedSku) ? fromString(requestedSku) : null;
  if (wanted && wanted.defindex === defindex && wanted.output !== null && obj.output === null) {
    obj.output = wanted.output;
    obj.outputQuality = wanted.outputQuality;
    if (obj.target === null) obj.target = wanted.target;
  }

  const paintAttr = attrFloat(attrs.get(142));
  const paint = paintAttr !== null && paintAttr > 0 && !isPaintCan(defindex) ? Math.round(paintAttr) : null;
  const sheen = attrFloat(attrs.get(2014));
  const killstreaker = attrFloat(attrs.get(2013));
  const special: SpecialAttrs = {
    paint,
    spells: uniqSorted(spellsFromAttrs(attrs)),
    parts: uniqSorted(partsFromAttrs(attrs)),
    sheen: sheen !== null && sheen > 0 ? Math.round(sheen) : null,
    killstreaker: killstreaker !== null && killstreaker > 0 ? Math.round(killstreaker) : null,
    customName: attrs.has(500) || (typeof item['custom_name'] === 'string' && item['custom_name'].trim() !== ''),
    customDesc: attrs.has(501) || (typeof item['custom_desc'] === 'string' && item['custom_desc'].trim() !== ''),
  };

  const currencies = soft(currenciesSchema, r['currencies'], 'currencies', stats);
  const userAgent = soft(userAgentSchema, r['userAgent'], 'userAgent', stats);
  const user = soft(userSchema, r['user'], 'user', stats);
  const intent = parsed.data.intent;
  const steamid = parsed.data.steamid;
  const assetId = parsed.data.item.id;
  const id =
    intent === 'sell' && assetId !== undefined ? `440_${assetId}` : intent === 'buy' ? bptfBuyListingId(steamid, itemName) : `${bptfBuyListingId(steamid, itemName)}_sell`;

  if (stats) stats.mapped++;
  return {
    id,
    sku: fromObject({ ...obj, paint }),
    baseSku: baseSku(obj),
    intent,
    steamid,
    userName: user?.name ?? null,
    keys: currencies?.keys !== undefined && currencies.keys > 0 ? currencies.keys : 0,
    metalScrap: refToScrap(currencies?.metal !== undefined && currencies.metal > 0 ? currencies.metal : 0),
    isBot: userAgent !== null,
    uaClient: userAgent?.client !== undefined ? userAgent.client.slice(0, MAX_UA_CLIENT) : null,
    uaLastPulse: toUnixSec(userAgent?.lastPulse),
    userOnline: typeof user?.online === 'boolean' ? user.online : null,
    userBanned: user?.banned === true || bansNonEmpty(user?.bans),
    isMarketplace: currencies?.usd !== undefined || hasMarketplaceKey(item) || hasMarketplaceKey(r),
    special,
    details: cleanText(r['details'], MAX_DETAILS),
    listedAt: toUnixSec(r['timestamp'] ?? r['listedAt']),
    bumpedAt: toUnixSec(r['bump'] ?? r['bumpedAt']),
    lastEventAt: nowMs,
    origin: 'snapshot',
    itemName,
    marketName: null,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// IGetPrices v4
// ---------------------------------------------------------------------------

const priceEntrySchema = z.looseObject({
  currency: z.string().optional(),
  value: num,
  value_high: num.optional(),
  last_update: num.optional(),
  australium: z.union([z.boolean(), z.number(), z.string()]).optional(),
});

const pricesDocSchema = z.looseObject({
  defindex: z.array(int).min(1),
  prices: z.record(z.string(), z.unknown()),
});

export interface ParsedPrices {
  success: boolean;
  message: string | null;
  currentTime: UnixSec | null;
  rows: CommunityRow[];
  /** Price entries that could not be mapped to a SKU. */
  skipped: number;
}

function unwrapResponse(json: unknown): Record<string, unknown> | null {
  if (!isRecord(json)) return null;
  const inner = json['response'];
  return isRecord(inner) ? inner : json;
}

function successFlag(v: unknown): boolean {
  return v === undefined || v === 1 || v === true || v === '1';
}

/** Entries of a priceindex dict: object form, or the PHP list form where the index is the priceindex. */
function priceindexEntries(v: unknown): [string, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x]);
  if (isRecord(v)) return Object.entries(v);
  return [];
}

function truthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function paintkitFromName(schema: SchemaService, name: string): { paintkit: number; rest: string } | null {
  const kits = safeCall(() => schema.paintkits(), []);
  let best: { paintkit: number; rest: string; len: number } | null = null;
  const lower = name.toLowerCase();
  for (const k of kits) {
    const kn = k.name.toLowerCase();
    if (lower.startsWith(`${kn} `) && (!best || kn.length > best.len)) {
      best = { paintkit: k.id, rest: name.slice(kn.length + 1), len: kn.length };
    }
  }
  return best ? { paintkit: best.paintkit, rest: best.rest } : null;
}

/** Full IGetPrices v4 parse: rows keyed by SKU (one per known defindex of each item). */
export function parseIGetPrices(json: unknown, schema: SchemaService): ParsedPrices {
  const resp = unwrapResponse(json);
  const out: ParsedPrices = { success: false, message: null, currentTime: null, rows: [], skipped: 0 };
  if (!resp) return out;
  out.success = successFlag(resp['success']);
  out.message = typeof resp['message'] === 'string' ? resp['message'] : null;
  out.currentTime = toUnixSec(resp['current_time']);
  const items = resp['items'];
  if (!out.success || !isRecord(items)) return out;

  const bySku = new Map<string, CommunityRow>();
  for (const [itemName, docRaw] of Object.entries(items)) {
    const doc = pricesDocSchema.safeParse(docRaw);
    if (!doc.success) {
      out.skipped++;
      continue;
    }
    const defindexes = [...new Set(doc.data.defindex)].filter((d) => d >= 0);

    // Prefix tokens in IGetPrices names: [Festivized] [Killstreak tier] [Australium] base [(wear)].
    let rest = itemName.trim();
    let festive = false;
    let killstreak = 0;
    let australiumByName = false;
    let wear: number | null = null;
    const w = WEAR_SUFFIX_RE.exec(rest);
    if (w) {
      wear = WEAR_BY_NAME[w[1]!.toLowerCase()] ?? null;
      rest = rest.slice(0, w.index).trim();
    }
    for (;;) {
      let m: RegExpExecArray | null;
      if ((m = /^Festivized\s+(.+)$/i.exec(rest))) {
        festive = true;
        rest = m[1]!;
      } else if ((m = /^(Professional |Specialized )?Killstreak\s+(.+)$/i.exec(rest))) {
        killstreak = m[1] ? (/^Professional/i.test(m[1]) ? 3 : 2) : 1;
        rest = m[2]!;
      } else if ((m = /^Australium\s+(.+)$/i.exec(rest)) && !/^Gold$/i.test(m[1]!)) {
        australiumByName = true;
        rest = m[1]!;
      } else break;
    }
    let paintkit: number | null = null;
    if (wear !== null) {
      const pk = paintkitFromName(schema, rest);
      if (!pk) {
        out.skipped++;
        continue;
      }
      paintkit = pk.paintkit;
    }
    const isKit = defindexes.some((d) => KIT_DEFINDEXES.has(d));
    const crateItem = isCrateItem(schema, defindexes, itemName);
    const targetTool = isTargetTool(itemName);

    for (const [qualityKey, tradRaw] of Object.entries(doc.data.prices)) {
      const quality = Number(qualityKey);
      if (!Number.isInteger(quality) || quality < 0 || quality === 255 || !isRecord(tradRaw)) {
        out.skipped++;
        continue;
      }
      for (const [tradKey, craftRaw] of Object.entries(tradRaw)) {
        if (!isRecord(craftRaw) || (tradKey !== 'Tradable' && tradKey !== 'Non-Tradable')) {
          out.skipped++;
          continue;
        }
        for (const [craftKey, piRaw] of Object.entries(craftRaw)) {
          if (craftKey !== 'Craftable' && craftKey !== 'Non-Craftable') {
            out.skipped++;
            continue;
          }
          for (const [piKey, entryRaw] of priceindexEntries(piRaw)) {
            const entry = priceEntrySchema.safeParse(entryRaw);
            if (!entry.success) {
              out.skipped++;
              continue;
            }
            const pi = parsePriceindex(piKey);
            if (pi === null && piKey.trim() !== '0' && piKey.trim() !== '') {
              out.skipped++;
              continue;
            }
            const obj: Partial<SkuObject> = {
              quality,
              tradable: tradKey === 'Tradable',
              craftable: craftKey === 'Craftable',
              killstreak,
              festive,
              australium: truthyFlag(entry.data.australium) || (australiumByName && quality === 11),
              wear,
              paintkit,
            };
            if (pi) {
              if (pi.length === 3) {
                obj.output = pi[0]!;
                obj.outputQuality = pi[1]!;
                obj.target = pi[2]!;
              } else if (pi.length === 2) {
                if (isKit) {
                  obj.killstreak = pi[0]! <= 3 ? pi[0]! : killstreak;
                  obj.target = pi[1]!;
                } else {
                  obj.output = pi[0]!;
                  obj.outputQuality = pi[1]!;
                }
              } else if (targetTool) obj.target = pi[0]!;
              else if (quality !== 5 && crateItem) obj.crateseries = pi[0]!;
              else obj.effect = canonicalEffect(schema, pi[0]!);
            }
            const row: Omit<CommunityRow, 'sku'> = {
              currency: entry.data.currency ?? 'metal',
              value: entry.data.value,
              valueHigh: entry.data.value_high ?? null,
              lastUpdate: toUnixSec(entry.data.last_update),
            };
            for (const defindex of defindexes) {
              const sku = fromObject({ ...obj, defindex });
              const prev = bySku.get(sku);
              if (!prev || (row.lastUpdate ?? 0) >= (prev.lastUpdate ?? 0)) bySku.set(sku, { sku, ...row });
            }
          }
        }
      }
    }
  }
  out.rows = [...bySku.values()];
  return out;
}

/** IGetPrices v4 -> community price rows (§2.3). */
export function communityRowsFromPrices(response: unknown, schema: SchemaService): CommunityRow[] {
  return parseIGetPrices(response, schema).rows;
}

// ---------------------------------------------------------------------------
// IGetCurrencies v1
// ---------------------------------------------------------------------------

const currencyEntrySchema = z.looseObject({
  defindex: int.optional(),
  name: z.string().optional(),
  price: z.looseObject({ value: num, value_high: num.optional(), currency: z.string().optional() }),
});

/**
 * Key price from IGetCurrencies v1. `currencies` may be an array (swagger) or
 * an object keyed metal/keys/hat (classic docs); the key entry is defindex 5021
 * or the `keys` key. Only metal-denominated prices are used.
 */
export function parseIGetCurrencies(json: unknown, nowMs: UnixMs): KeyPriceQuote | null {
  const resp = unwrapResponse(json);
  if (!resp || !successFlag(resp['success'])) return null;
  const cur = resp['currencies'];
  const entries: [string, unknown][] = Array.isArray(cur)
    ? cur.map((v, i) => [String(i), v])
    : isRecord(cur)
      ? Object.entries(cur)
      : [];
  const keyDefindex = Number(KEY_SKU.split(';')[0]);
  let best: z.infer<typeof currencyEntrySchema> | null = null;
  for (const [k, v] of entries) {
    const r = currencyEntrySchema.safeParse(v);
    if (!r.success) continue;
    const isKey = r.data.defindex === keyDefindex || k === 'keys' || r.data.name === 'Mann Co. Supply Crate Key';
    if (isKey) {
      best = r.data;
      if (r.data.defindex === keyDefindex) break;
    }
  }
  if (!best) return null;
  const currency = best.price.currency ?? 'metal';
  if (currency !== 'metal' || !(best.price.value > 0)) return null;
  const high = best.price.value_high !== undefined && best.price.value_high >= best.price.value ? best.price.value_high : best.price.value;
  return { source: 'bptf', buyScrap: refToScrap(best.price.value), sellScrap: refToScrap(high), observedAt: nowMs };
}
