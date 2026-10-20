// Item names <-> SKU objects, built on in-memory indexes of the item schema.
//
// getName() is a port of Schema#getName from node-tf2-schema
// (https://github.com/TF2Autobot/node-tf2-schema/blob/master/lib/schema.js),
// MIT License, Copyright (c) 2020 IdiNium/Nicklas Marc Pedersen. The data
// tables marked "upstream" below come from the same file.
//
// parseName() is our own resolver. It follows upstream getItemObjectFromName's
// conventions, but consumes prefixes token by token (longest match first, the
// item name checked before every token) instead of substring replacement, which
// avoids upstream's long list of special cases ("Smoking Jacket", "Atomic
// Accolade", "Shot to Hell" ...).

import { normalizeSkuObject } from '../../shared/sku';
import type { SkuObject } from '../../shared/types';
import { KILLSTREAK_NAMES, QUALITY_NAMES, WEAR_NAMES } from '../../shared/types';
import type { EffectRow, PaintRow, PaintkitRow, SchemaItemRow } from '../contracts';

// ---------------------------------------------------------------------------
// Upstream tables
// ---------------------------------------------------------------------------

/** Keys whose schema item_name is "Mann Co. Supply Crate Key" but trade under their own names (upstream). */
export const RETIRED_KEYS: ReadonlyMap<number, string> = new Map([
  [5049, 'Festive Winter Crate Key'],
  [5067, 'Refreshing Summer Cooler Key'],
  [5072, 'Naughty Winter Crate Key'],
  [5073, 'Nice Winter Crate Key'],
  [5079, 'Scorched Key'],
  [5081, 'Fall Key'],
  [5628, 'Eerie Key'],
  [5631, 'Naughty Winter Crate Key 2012'],
  [5632, 'Nice Winter Crate Key 2012'],
  [5713, 'Spooky Key'],
  [5716, 'Naughty Winter Crate Key 2013'],
  [5717, 'Nice Winter Crate Key 2013'],
  [5762, 'Limited Late Summer Crate Key'],
  [5791, 'Naughty Winter Crate Key 2014'],
  [5792, 'Nice Winter Crate Key 2014'],
]);

/** Items that exist as a separate Genuine-only defindex (upstream exclusiveGenuine). */
export const EXCLUSIVE_GENUINE: ReadonlyMap<number, number> = new Map([
  [810, 831],
  [811, 832],
  [812, 833],
  [813, 834],
  [814, 835],
  [815, 836],
  [816, 837],
  [817, 838],
  [30720, 30740],
  [30721, 30741],
  [30724, 30739],
]);

/** Mann Co. Supply Crate series per defindex (upstream; the schema's own series attribute is wrong for these). */
const MANN_CO_CRATE_SERIES: ReadonlyMap<number, readonly number[]> = new Map([
  [5022, [1, 3, 7, 12, 13, 18, 19, 23, 26, 31, 34, 39, 43, 47, 54, 57, 75]],
  [5041, [2, 4, 8, 11, 14, 17, 20, 24, 27, 32, 37, 42, 44, 49, 56, 71, 76]],
  [5045, [5, 9, 10, 15, 16, 21, 25, 28, 29, 33, 38, 41, 45, 55, 59, 77]],
]);
const SALVAGED_CRATE = 5068;
const SALVAGED_SERIES: readonly number[] = [30, 40, 50];
const SELECT_RESERVE_CRATE = 5660;
/**
 * Director's Cut Reel, Audition Reel and Stockpile Crate have no series (upstream checkExistence). The
 * saved-page parser reads it too: every other crate is priced per series.
 */
export const SERIESLESS_CRATES: ReadonlySet<number> = new Set([5737, 5738, 5739, 5760]);

/** Mann Co. Supply Munition series -> defindex (upstream munitionCrate). */
const MUNITION_CRATES: ReadonlyMap<number, number> = new Map([
  [82, 5734],
  [83, 5735],
  [84, 5742],
  [85, 5752],
  [90, 5781],
  [91, 5802],
  [92, 5803],
  [103, 5859],
]);

/** Strangifier Chemistry Set series by target, for SCM names (upstream strangifierChemistrySetSeries). */
const STRANGIFIER_CHEMISTRY_SERIES: ReadonlyMap<number, number> = new Map([
  ...[647, 828, 776, 451, 103, 446, 541, 733, 387, 486, 386, 757, 393].map((d): [number, number] => [d, 1]),
  ...[30132, 707, 30073, 878, 440, 645, 343, 643, 336].map((d): [number, number] => [d, 2]),
  ...[
    30377, 30371, 30353, 30344, 30348, 30361, 30372, 30367, 30357, 30375, 30350, 30341, 30369, 30349, 30379, 30343, 30338,
    30356, 30342, 30378, 30359, 30363, 30339, 30362, 30345, 30352, 30360, 30354, 30374, 30366, 30347, 30365, 30355, 30358,
    30340, 30351, 30376, 30373, 30346, 30336, 30337, 30368, 30364,
  ].map((d): [number, number] => [d, 3]),
]);

/**
 * Paintkit -> skin defindex per weapon (upstream pistolSkins, rocketLauncherSkins ...).
 * Only a fallback: the items_game paintkit_proto_def_index attribute is used when present.
 */
const UPSTREAM_SKINS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  pistol: [[0, 15013], [18, 15018], [35, 15035], [41, 15041], [46, 15046], [56, 15056], [61, 15061], [63, 15060], [69, 15100], [70, 15101], [74, 15102], [78, 15126], [81, 15148]],
  'rocket launcher': [[1, 15014], [6, 15006], [28, 15028], [43, 15043], [52, 15052], [57, 15057], [60, 15081], [69, 15104], [70, 15105], [76, 15129], [79, 15130], [80, 15150]],
  'medi gun': [[2, 15010], [5, 15008], [25, 15025], [39, 15039], [50, 15050], [65, 15078], [72, 15097], [76, 15120], [78, 15121], [79, 15122], [81, 15145], [83, 15146]],
  revolver: [[3, 15011], [27, 15027], [42, 15042], [51, 15051], [63, 15064], [64, 15062], [65, 15063], [72, 15103], [76, 15127], [77, 15128], [81, 15149]],
  'stickybomb launcher': [[4, 15012], [8, 15009], [24, 15024], [38, 15038], [45, 15045], [48, 15048], [60, 15082], [62, 15083], [63, 15084], [68, 15113], [76, 15137], [78, 15138], [81, 15155]],
  'sniper rifle': [[7, 15007], [14, 15000], [19, 15019], [23, 15023], [33, 15033], [59, 15059], [62, 15070], [64, 15071], [65, 15072], [76, 15135], [66, 15111], [67, 15112], [78, 15136], [82, 15154]],
  'flame thrower': [[9, 15005], [17, 15017], [30, 15030], [34, 15034], [49, 15049], [54, 15054], [60, 15066], [61, 15068], [62, 15067], [66, 15089], [67, 15090], [76, 15115], [80, 15141]],
  minigun: [[10, 15004], [20, 15020], [26, 15026], [31, 15031], [40, 15040], [55, 15055], [61, 15088], [62, 15087], [63, 15086], [70, 15098], [73, 15099], [76, 15123], [77, 15125], [78, 15124], [84, 15147]],
  scattergun: [[11, 15002], [15, 15015], [21, 15021], [29, 15029], [36, 15036], [53, 15053], [61, 15069], [63, 15065], [69, 15106], [72, 15107], [74, 15108], [76, 15131], [83, 15157], [85, 15151]],
  shotgun: [[12, 15003], [16, 15016], [44, 15044], [47, 15047], [60, 15085], [72, 15109], [76, 15132], [78, 15133], [86, 15152]],
  smg: [[13, 15001], [22, 15022], [32, 15032], [37, 15037], [58, 15058], [65, 15076], [69, 15110], [79, 15134], [81, 15153]],
  wrench: [[60, 15074], [61, 15073], [64, 15075], [75, 15114], [77, 15140], [78, 15139], [82, 15156]],
  'grenade launcher': [[60, 15077], [63, 15079], [67, 15091], [68, 15092], [76, 15116], [77, 15117], [80, 15142], [84, 15158]],
  knife: [[64, 15080], [69, 15094], [70, 15095], [71, 15096], [77, 15119], [78, 15118], [81, 15143], [82, 15144]],
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const Q_GENUINE = 1;
const Q_UNUSUAL = 5;
const Q_UNIQUE = 6;
const Q_STRANGE = 11;
const Q_COLLECTORS = 14;
const Q_DECORATED = 15;
const COMMUNITY_SPARKLE = 4;

const D_STRANGIFIER = 6522;
const D_KIT_SPECIALIZED = 6523;
const D_KIT_PROFESSIONAL = 6526;
const D_KIT_BASIC = 6527;
const D_STRANGIFIER_CHEMISTRY = 20000;
const D_FABRICATOR_SPECIALIZED = 20002;
const D_FABRICATOR_PROFESSIONAL = 20003;
const D_COLLECTOR_CHEMISTRY = 20006;
const D_COLLECTOR_CHEMISTRY_FESTIVE = 20007;
const D_UNUSUALIFIER = 9258;
const D_WAR_PAINT_GENERIC = 9536;
/** Duplicate "Name Tag" that upstream never resolves to. */
const D_NAME_TAG_DUPLICATE = 2093;

const WEAR_BY_KEY: ReadonlyMap<string, number> = new Map([
  ['factory new', 1],
  ['minimal wear', 2],
  ['field-tested', 3],
  ['field tested', 3],
  ['well-worn', 4],
  ['well worn', 4],
  ['battle scarred', 5],
  ['battle-scarred', 5],
]);

// ---------------------------------------------------------------------------
// Extras persisted next to the snapshot
// ---------------------------------------------------------------------------

/** Schema facts the Repo's SchemaItemRow cannot hold; stored as JSON in repo meta. */
export interface SchemaExtras {
  v: 1;
  /** item_quality for items whose default quality is not Unique (6). */
  itemQuality: Record<string, number>;
  /** Supply crate series by defindex (schema attribute or items_game static attribute). */
  crateSeries: Record<string, number>;
  /** Defindexes whose first schema attribute is supply_crate_series (SCM "Series #N"). */
  crateSeriesAttr: number[];
  /** items_game paintkit_proto_def_index: skin-specific weapons (15xxx) and War Paints. */
  skinPaintkit: Record<string, number>;
}

export function emptyExtras(): SchemaExtras {
  return { v: 1, itemQuality: {}, crateSeries: {}, crateSeriesAttr: [], skinPaintkit: {} };
}

/** Defensive parse of the stored extras JSON; null when absent or not ours. */
export function parseExtras(json: string | null): SchemaExtras | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1) return null;
  const r = raw as Record<string, unknown>;
  const numRecord = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
    for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n) && /^\d+$/.test(k)) out[k] = n;
    return out;
  };
  return {
    v: 1,
    itemQuality: numRecord(r['itemQuality']),
    crateSeries: numRecord(r['crateSeries']),
    crateSeriesAttr: Array.isArray(r['crateSeriesAttr'])
      ? (r['crateSeriesAttr'] as unknown[]).filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
      : [],
    skinPaintkit: numRecord(r['skinPaintkit']),
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Case-, accent- and whitespace-insensitive key ("Übersaw" -> "ubersaw"). */
export function normKey(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function stripThe(key: string): string {
  return key.startsWith('the ') ? key.slice(4) : key;
}

export function hexOf(decimal: number): string {
  return `#${Math.max(0, Math.trunc(decimal)).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** "#B8383B", "b8383b", "#abc" -> "b8383b"; null when not a hex colour. */
export function normHex(hex: string): string | null {
  const h = String(hex ?? '')
    .trim()
    .replace(/^#/, '')
    .toLowerCase();
  if (/^[0-9a-f]{6}$/.test(h)) return h;
  if (/^[0-9a-f]{3}$/.test(h)) return h.replace(/(.)/g, '$1$1');
  return null;
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface SchemaData {
  items: readonly SchemaItemRow[];
  effects: readonly EffectRow[];
  paints: readonly PaintRow[];
  paintkits: readonly PaintkitRow[];
  extras: SchemaExtras;
}

export interface NameOptions {
  /** Prefix "The " for proper_name items without any other prefix (upstream default true). */
  proper?: boolean;
  /** "Night Owl | Sniper Rifle" instead of "Night Owl Sniper Rifle". */
  usePipeForSkin?: boolean;
  /** Steam Community Market conventions (no effect, no craftability, "Series #N"). */
  scmFormat?: boolean;
  /**
   * Upstream marks an elevated Strange on skins as "Strange(e)". sku.pricedb.io
   * and backpack.tf do not, so this defaults to false here.
   */
  elevatedMarker?: boolean;
}

export interface ParsedName {
  obj: SkuObject;
  /** False when the item name only matched approximately. */
  exact: boolean;
  warnings: string[];
}

interface Token {
  key: string;
  apply: (st: ParseState) => void;
  kind: 'fixed' | 'quality' | 'effect' | 'paintkit';
  /** For effects: weapon effects (Hot, Cool ...) only exist on skins. */
  needsWear?: boolean;
}

interface ParseState {
  craftable: boolean;
  tradable: boolean;
  explicitElevated: boolean;
  strange: boolean;
  unusual: boolean;
  quality: number | null;
  extraQualities: number[];
  effect: number | null;
  festive: boolean;
  killstreak: number;
  australium: boolean;
  paintkit: number | null;
  wear: number | null;
  paint: number | null;
  number: number | null;
  warnings: string[];
}

export class SchemaIndex {
  readonly items: ReadonlyMap<number, SchemaItemRow>;
  readonly effects: ReadonlyMap<number, EffectRow>;
  readonly paints: ReadonlyMap<number, PaintRow>;
  readonly paintkitList: readonly PaintkitRow[];
  readonly extras: SchemaExtras;

  private readonly paintkitById = new Map<number, string>();
  private readonly paintkitByKey = new Map<string, number>();
  private readonly effectByKey = new Map<string, number>();
  private readonly paintByKey = new Map<string, number>();
  private readonly redHex = new Map<string, number>();
  private readonly bluHex = new Map<string, number>();
  private readonly byName = new Map<string, number[]>();
  private readonly byNameNoThe = new Map<string, number[]>();
  private readonly skinByWeaponAndKit = new Map<string, number>();
  private readonly warPaintByKit = new Map<number, number>();
  private readonly skinSpecific = new Set<number>();
  private readonly crateSeriesAttr: ReadonlySet<number>;
  private readonly retiredKeyByKey = new Map<string, number>();
  private readonly tokens: Token[];
  private fuzzyKeys: string[] | null = null;

  constructor(data: SchemaData) {
    this.extras = data.extras;
    this.items = new Map(data.items.map((i) => [i.defindex, i]));
    this.effects = new Map(data.effects.map((e) => [e.id, e]));
    this.paints = new Map(data.paints.map((p) => [p.decimal, p]));
    this.paintkitList = [...data.paintkits].sort((a, b) => a.id - b.id);
    this.crateSeriesAttr = new Set(data.extras.crateSeriesAttr);

    for (const k of this.paintkitList) {
      this.paintkitById.set(k.id, k.name);
      const key = normKey(k.name);
      if (key && !this.paintkitByKey.has(key)) this.paintkitByKey.set(key, k.id);
    }
    for (const e of [...data.effects].sort((a, b) => a.id - b.id)) {
      const key = normKey(e.name);
      if (key && !this.effectByKey.has(key)) this.effectByKey.set(key, e.canonicalId);
    }
    for (const p of data.paints) {
      this.paintByKey.set(normKey(p.name), p.decimal);
      const red = normHex(p.hex);
      if (red && !this.redHex.has(red)) this.redHex.set(red, p.decimal);
      const blu = p.bluHex ? normHex(p.bluHex) : null;
      if (blu && !this.bluHex.has(blu)) this.bluHex.set(blu, p.decimal);
    }
    for (const [d, name] of RETIRED_KEYS) this.retiredKeyByKey.set(normKey(name), d);

    const sorted = [...data.items].sort((a, b) => a.defindex - b.defindex);
    for (const it of sorted) {
      const key = normKey(it.itemName);
      if (!key) continue;
      push(this.byName, key, it.defindex);
      const noThe = stripThe(key);
      if (noThe !== key) push(this.byNameNoThe, noThe, it.defindex);
    }

    for (const [dStr, pk] of Object.entries(data.extras.skinPaintkit)) {
      const d = Number(dStr);
      const it = this.items.get(d);
      if (!it) continue;
      if (this.isWarPaintRow(it)) {
        if (d !== D_WAR_PAINT_GENERIC && !this.warPaintByKit.has(pk)) this.warPaintByKit.set(pk, d);
      } else {
        this.skinSpecific.add(d);
        this.skinByWeaponAndKit.set(`${normKey(it.itemName)}|${pk}`, d);
      }
    }
    // War Paints are also recognisable by their internal name "Paintkit <id>".
    for (const it of sorted) {
      const m = /^Paintkit (\d+)$/.exec(it.name);
      if (m && !this.warPaintByKit.has(Number(m[1]))) this.warPaintByKit.set(Number(m[1]), it.defindex);
    }
    for (const [weapon, pairs] of Object.entries(UPSTREAM_SKINS)) {
      for (const [pk, d] of pairs) {
        if (!this.items.has(d)) continue;
        this.skinSpecific.add(d);
        const key = `${weapon}|${pk}`;
        if (!this.skinByWeaponAndKit.has(key)) this.skinByWeaponAndKit.set(key, d);
      }
    }

    this.tokens = this.buildTokens();
  }

  // ----- lookups -----

  item(defindex: number): SchemaItemRow | null {
    return this.items.get(defindex) ?? null;
  }

  /** Default quality of an item (item_quality), 6 when unknown. */
  itemQuality(defindex: number): number {
    return this.extras.itemQuality[String(defindex)] ?? Q_UNIQUE;
  }

  crateSeries(defindex: number): number | null {
    return this.extras.crateSeries[String(defindex)] ?? null;
  }

  isCrate(defindex: number): boolean {
    return this.items.get(defindex)?.itemClass === 'supply_crate';
  }

  /** Other defindexes of the same crate (e.g. the three "Mann Co. Supply Crate" items). */
  crateAliases(defindex: number): number[] {
    const it = this.items.get(defindex);
    if (!it || it.itemClass !== 'supply_crate') return [];
    return (this.byName.get(normKey(it.itemName)) ?? []).filter((d) => d !== defindex && this.isCrate(d));
  }

  effectName(id: number): string | null {
    return this.effects.get(id)?.name ?? null;
  }

  effectIdByName(name: string): number | null {
    return this.effectByKey.get(normKey(name)) ?? null;
  }

  canonicalEffectId(id: number): number {
    return this.effects.get(id)?.canonicalId ?? id;
  }

  paintkitName(id: number): string | null {
    return this.paintkitById.get(id) ?? null;
  }

  paintkitIdByName(name: string): number | null {
    return this.paintkitByKey.get(normKey(name)) ?? null;
  }

  paintByDecimal(decimal: number): PaintRow | null {
    return this.paints.get(decimal) ?? null;
  }

  paintDecimalByName(name: string): number | null {
    return this.paintByKey.get(normKey(name)) ?? null;
  }

  /** RED hex first (an exact paint), then BLU hex of a team paint. */
  paintDecimalByHex(hex: string): number | null {
    const h = normHex(hex);
    if (!h) return null;
    return this.redHex.get(h) ?? this.bluHex.get(h) ?? null;
  }

  isWarPaint(defindex: number): boolean {
    const it = this.items.get(defindex);
    return it ? this.isWarPaintRow(it) : false;
  }

  /** Skin-specific weapon defindex (15xxx), i.e. a duplicate of the plain weapon. */
  isSkinSpecific(defindex: number): boolean {
    return this.skinSpecific.has(defindex);
  }

  /** Defindexes whose display name matches `name` (with or without "The"). */
  findByName(name: string): number[] {
    const key = normKey(name);
    if (!key) return [];
    return this.byName.get(key) ?? this.byName.get(stripThe(key)) ?? this.byNameNoThe.get(key) ?? [];
  }

  /**
   * Picks one defindex for a display name, IGetPrices-style:
   * 1. with a paintkit, the skin-specific weapon for that paintkit (15xxx) if one exists;
   * 2. otherwise skin-specific weapons and the duplicate Name Tag are skipped;
   * 3. stock items (item_quality 0) and quality-255 items are skipped when another candidate remains;
   * 4. items whose internal name starts with "Upgradeable " win ("Rocket Launcher" -> 205, not 18);
   * 5. then the lowest defindex; Genuine maps to the Genuine-only defindex (Huo-Long Heater 811 -> 832).
   */
  pickDefindex(candidates: readonly number[], paintkit: number | null, quality: number | null): number | null {
    if (candidates.length === 0) return null;
    if (paintkit !== null) {
      const first = this.items.get(candidates[0]!);
      const hit = first ? this.skinByWeaponAndKit.get(`${normKey(first.itemName)}|${paintkit}`) : undefined;
      if (hit !== undefined) return hit;
    }
    let pool = candidates.filter((d) => !this.skinSpecific.has(d) && d !== D_NAME_TAG_DUPLICATE);
    if (pool.length === 0) pool = [...candidates];
    const regular = pool.filter((d) => {
      const q = this.itemQuality(d);
      return q !== 0 && q !== 255;
    });
    if (regular.length > 0) pool = regular;
    const upgradeable = pool.filter((d) => this.items.get(d)?.name.startsWith('Upgradeable ') ?? false);
    if (upgradeable.length > 0) pool = upgradeable;
    let d = Math.min(...pool);
    if (quality === Q_GENUINE) d = EXCLUSIVE_GENUINE.get(d) ?? d;
    return d;
  }

  // ----- names -----

  /** Port of node-tf2-schema getName. Returns null for unknown defindexes. */
  getName(item: SkuObject, opts: NameOptions = {}): string | null {
    const schemaItem = this.items.get(item.defindex);
    if (!schemaItem) return null;
    const proper = opts.proper ?? true;
    const usePipe = opts.usePipeForSkin ?? false;
    const scm = opts.scmFormat ?? false;
    const marker = opts.elevatedMarker ?? false;

    let name = '';
    if (!scm && item.tradable === false) name = 'Non-Tradable ';
    if (!scm && item.craftable === false) name += 'Non-Craftable ';

    if (item.quality2) {
      name += qualityName(item.quality2) + (marker && !scm && (item.wear !== null || item.paintkit !== null) ? '(e)' : '') + ' ';
    }

    if (
      (item.quality === Q_UNIQUE && item.quality2) ||
      (item.quality !== Q_UNIQUE && item.quality !== Q_DECORATED && item.quality !== Q_UNUSUAL) ||
      (item.quality === Q_UNUSUAL && !item.effect) ||
      (item.quality === Q_UNUSUAL && scm) ||
      this.itemQuality(item.defindex) === Q_UNUSUAL
    ) {
      name += qualityName(item.quality) + ' ';
    }

    if (!scm && item.effect) name += (this.effectName(item.effect) ?? `Effect ${item.effect}`) + ' ';
    if (item.festive === true) name += 'Festivized ';
    if (item.killstreak && item.killstreak > 0) name += (KILLSTREAK_NAMES[item.killstreak] ?? `Killstreak ${item.killstreak}`) + ' ';
    if (item.target) name += this.itemNameOf(item.target) + ' ';
    if (item.outputQuality && item.outputQuality !== Q_UNIQUE) name = qualityName(item.outputQuality) + ' ' + name;
    if (item.output) name += this.itemNameOf(item.output) + ' ';
    if (item.australium === true) name += 'Australium ';
    if (typeof item.paintkit === 'number') {
      name += (this.paintkitName(item.paintkit) ?? `Paintkit ${item.paintkit}`) + (usePipe ? ' | ' : ' ');
    }

    if (proper && name === '' && schemaItem.properName) name = 'The ';
    name += RETIRED_KEYS.get(item.defindex) ?? schemaItem.itemName;

    if (item.wear) name += ` (${WEAR_NAMES[item.wear] ?? `Wear ${item.wear}`})`;

    if (item.crateseries) {
      if (scm) {
        // Upstream writes "%23" (pre-encoded); callers here encode the whole name.
        if (this.crateSeriesAttr.has(item.defindex)) name += ` Series #${item.crateseries}`;
      } else {
        name += ` #${item.crateseries}`;
      }
    } else if (item.craftnumber) {
      name += ` #${item.craftnumber}`;
    }

    if (!scm && item.paint) name += ` (Paint: ${this.paintByDecimal(item.paint)?.name ?? item.paint})`;

    if (scm && schemaItem.itemName === 'Chemistry Set' && item.output === D_STRANGIFIER) {
      const series = item.target ? STRANGIFIER_CHEMISTRY_SERIES.get(item.target) : undefined;
      if (series !== undefined) name += ` Series #${series}`;
    }

    if (scm && item.wear !== null && item.effect !== null && item.quality === Q_DECORATED) name = 'Unusual ' + name;

    return name;
  }

  // ----- name parsing -----

  /** Full item name (backpack.tf, sku.pricedb.io, SCM or upstream style) to a SKU object; null when no item matches. */
  parseName(input: string): ParsedName | null {
    const original = String(input ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    let rest = normKey(original);
    if (!rest) return null;

    const st: ParseState = {
      craftable: true,
      tradable: true,
      explicitElevated: false,
      strange: false,
      unusual: false,
      quality: null,
      extraQualities: [],
      effect: null,
      festive: false,
      killstreak: 0,
      australium: false,
      paintkit: null,
      wear: null,
      paint: null,
      number: null,
      warnings: [],
    };

    rest = this.takeSuffixes(rest, st);
    if (!rest) return null;

    for (let guard = 0; guard < 16; guard++) {
      if (this.isTerminal(rest, st)) break;
      const tok = this.matchToken(rest, st);
      if (!tok) break;
      tok.apply(st);
      rest = rest.slice(tok.key.length).trim();
    }

    const resolved = this.resolveRemainder(rest, st);
    if (!resolved) return null;
    return this.finish(resolved.defindex, resolved, st);
  }

  /** Applies a backpack.tf priceindex ("13", "3-205", "6526-6-205") to a parsed object. */
  applyPriceindex(obj: SkuObject, priceindex: string, unusualHint: boolean): SkuObject {
    const pi = priceindex.trim();
    const out = { ...obj };
    const parts = pi.split('-').map((p) => Number(p));
    if (parts.some((n) => !Number.isInteger(n) || n < 0)) return out;
    const it = this.items.get(out.defindex);
    if (parts.length === 3) {
      out.output = parts[0]!;
      out.outputQuality = parts[1]!;
      out.target = parts[2]!;
    } else if (parts.length === 2) {
      if (out.defindex >= 20000 && out.defindex <= 20009) {
        out.output = parts[0]!;
        out.outputQuality = parts[1]!;
      } else {
        out.killstreak = parts[0]!;
        out.target = parts[1]!;
        if (out.defindex === D_KIT_BASIC || out.defindex === D_KIT_SPECIALIZED || out.defindex === D_KIT_PROFESSIONAL) {
          out.defindex = kitDefindex(out.killstreak);
        }
      }
    } else if (parts.length === 1) {
      const n = parts[0]!;
      if (it?.itemClass === 'supply_crate') {
        out.crateseries = n;
        out.defindex = this.crateForSeries(out.defindex, n);
      }
      else if (out.defindex === D_STRANGIFIER || out.defindex === D_UNUSUALIFIER || (out.target === null && isKitDefindex(out.defindex))) {
        out.target = n;
      }
      else if (out.paintkit !== null && n > 0) {
        // 0.7.3: a skin's priceindex is its effect, keyed as Decorated plus the effect, strange as quality2 (P2).
        const strange = out.quality === Q_STRANGE || out.quality2 === Q_STRANGE;
        out.effect = this.canonicalEffectId(n);
        out.quality = Q_DECORATED;
        out.quality2 = strange ? Q_STRANGE : null;
      }
      else if (unusualHint || out.quality === Q_UNUSUAL || out.quality === Q_DECORATED) {
        out.effect = this.canonicalEffectId(n);
        if (out.quality !== Q_DECORATED && out.paintkit === null) out.quality = Q_UNUSUAL;
      }
    }
    return normalizeSkuObject(out);
  }

  // ----- internals -----

  private isWarPaintRow(it: SchemaItemRow): boolean {
    return normKey(it.itemName) === 'war paint';
  }

  private itemNameOf(defindex: number): string {
    return this.items.get(defindex)?.itemName ?? `Item #${defindex}`;
  }

  private buildTokens(): Token[] {
    const set =
      (patch: Partial<ParseState>) =>
      (s: ParseState): void => {
        Object.assign(s, patch);
      };
    const fixed: [string, (st: ParseState) => void][] = [
      ['non-craftable', set({ craftable: false })],
      ['non craftable', set({ craftable: false })],
      ['noncraftable', set({ craftable: false })],
      ['uncraftable', set({ craftable: false })],
      ['non-tradable', set({ tradable: false })],
      ['non-tradeable', set({ tradable: false })],
      ['non tradable', set({ tradable: false })],
      ['untradable', set({ tradable: false })],
      ['untradeable', set({ tradable: false })],
      ['strange(e)', set({ explicitElevated: true, strange: true })],
      ['festivized', set({ festive: true })],
      ['professional killstreak', set({ killstreak: 3 })],
      ['specialized killstreak', set({ killstreak: 2 })],
      ['killstreak', set({ killstreak: 1 })],
      ['australium', set({ australium: true })],
      ['the', () => undefined],
    ];
    const tokens: Token[] = fixed.map(([key, apply]) => ({ key, apply, kind: 'fixed' }));

    for (const [idStr, qname] of Object.entries(QUALITY_NAMES)) {
      const id = Number(idStr);
      const key = normKey(qname);
      tokens.push({
        key,
        kind: 'quality',
        apply: (s) => {
          if (id === Q_STRANGE) s.strange = true;
          else if (id === Q_UNUSUAL) s.unusual = true;
          else if (s.quality === null) s.quality = id;
          else s.extraQualities.push(id);
        },
      });
    }
    tokens.push({
      key: 'decorated',
      kind: 'quality',
      apply: (s) => {
        s.quality ??= Q_DECORATED;
      },
    });

    for (const [key, id] of this.effectByKey) {
      const type = this.effects.get(id)?.type;
      tokens.push({ key, kind: 'effect', needsWear: type === 'weapon', apply: set({ effect: id }) });
    }
    for (const [key, id] of this.paintkitByKey) {
      tokens.push({ key, kind: 'paintkit', apply: set({ paintkit: id }) });
    }
    return tokens.sort((a, b) => b.key.length - a.key.length);
  }

  /** Consumes "(Paint: X)", "(Wear)" and "#N" / "Series #N" from the end. */
  private takeSuffixes(text: string, st: ParseState): string {
    let rest = text;
    for (let guard = 0; guard < 4; guard++) {
      const paint = /\s*\(paint:\s*([^)]*)\)\s*$/.exec(rest);
      if (paint) {
        const d = this.paintDecimalByName(paint[1] ?? '');
        if (d === null) st.warnings.push(`Unknown paint "${(paint[1] ?? '').trim()}"`);
        else st.paint = d;
        rest = rest.slice(0, paint.index).trim();
        continue;
      }
      const wear = /\s*\(([a-z -]+)\)\s*$/.exec(rest);
      if (wear && WEAR_BY_KEY.has((wear[1] ?? '').trim())) {
        st.wear = WEAR_BY_KEY.get((wear[1] ?? '').trim()) ?? null;
        rest = rest.slice(0, wear.index).trim();
        continue;
      }
      const num = /\s+(?:series\s*)?#\s*(\d{1,9})$/.exec(rest);
      if (num && st.number === null) {
        st.number = Number(num[1]);
        rest = rest.slice(0, num.index).trim();
        continue;
      }
      break;
    }
    return rest;
  }

  /** True when `rest` already names something that must not be split further. */
  private isTerminal(rest: string, st: ParseState): boolean {
    if (this.retiredKeyByKey.has(rest)) return true;
    if (this.findByName(rest).length > 0) return true;
    return this.specialForm(rest, st, true) !== null;
  }

  private matchToken(rest: string, st: ParseState): Token | null {
    let best: Token | null = null;
    for (const tok of this.tokens) {
      if (best && tok.key.length < best.key.length) break;
      if (!rest.startsWith(tok.key + ' ')) continue;
      if (!this.tokenAllowed(tok, rest, st)) continue;
      if (!best) {
        best = tok;
        continue;
      }
      // Same length: a paintkit beats an effect of the same name on a skin (e.g. "Haunted Ghosts").
      if (best.kind === 'effect' && tok.kind === 'paintkit' && st.wear !== null) best = tok;
    }
    return best;
  }

  private tokenAllowed(tok: Token, rest: string, st: ParseState): boolean {
    if (tok.kind === 'effect') {
      if (st.effect !== null) return false;
      if (tok.needsWear && st.wear === null) return false;
      return true;
    }
    if (tok.kind === 'paintkit') {
      if (st.paintkit !== null) return false;
      if (st.wear !== null) return true;
      // Without a wear, only when the rest is then an item and no effect fits here.
      const after = rest.slice(tok.key.length).trim();
      if (this.findByName(after).length === 0 && after !== 'war paint') return false;
      return !this.tokens.some((t) => t.kind === 'effect' && st.effect === null && rest.startsWith(t.key + ' '));
    }
    if (tok.key === 'australium') return !rest.startsWith('australium gold');
    return true;
  }

  /** Kits, fabricators, chemistry sets, strangifiers, unusualifiers, war paints. */
  private specialForm(
    rest: string,
    st: ParseState,
    probe: boolean,
  ): { defindex: number; target?: number | null; output?: number | null; outputQuality?: number | null; quality?: number } | null {
    const targetOf = (name: string): number | null | undefined => {
      if (name === '') return null;
      const cands = this.findByName(name);
      if (cands.length === 0) return undefined;
      return this.pickDefindex(cands, null, null);
    };

    if (st.killstreak > 1 && (rest === 'kit fabricator' || rest.endsWith(' kit fabricator') || rest === 'fabricator')) {
      const name = rest === 'fabricator' ? '' : rest.slice(0, -'kit fabricator'.length).trim();
      const target = targetOf(name);
      if (target === undefined) return null;
      if (probe) return { defindex: 0 };
      const pro = st.killstreak > 2;
      return {
        defindex: pro ? D_FABRICATOR_PROFESSIONAL : D_FABRICATOR_SPECIALIZED,
        target,
        output: pro ? D_KIT_PROFESSIONAL : D_KIT_SPECIALIZED,
        outputQuality: Q_UNIQUE,
      };
    }
    if (rest.endsWith(' strangifier chemistry set')) {
      const target = targetOf(rest.slice(0, -' strangifier chemistry set'.length).trim());
      if (target === undefined || target === null) return null;
      return { defindex: D_STRANGIFIER_CHEMISTRY, target, output: D_STRANGIFIER, outputQuality: Q_UNIQUE, quality: Q_UNIQUE };
    }
    if (rest.endsWith(' chemistry set') && (st.quality === Q_COLLECTORS || rest.startsWith("collector's "))) {
      const name = rest.slice(0, -' chemistry set'.length).replace(/^collector's /, '').trim();
      const output = targetOf(name);
      if (output === undefined || output === null) return null;
      if (probe) return { defindex: 0 };
      const festive = name.includes('festive') && !name.includes('a rather festive tree');
      if (st.quality === Q_COLLECTORS) st.quality = null;
      return {
        defindex: festive ? D_COLLECTOR_CHEMISTRY_FESTIVE : D_COLLECTOR_CHEMISTRY,
        output,
        outputQuality: Q_COLLECTORS,
        quality: Q_UNIQUE,
      };
    }
    if (rest.endsWith(' strangifier')) {
      const target = targetOf(rest.slice(0, -' strangifier'.length).trim());
      if (target === undefined || target === null) return null;
      return { defindex: D_STRANGIFIER, target };
    }
    if (rest.endsWith(' unusualifier')) {
      const target = targetOf(rest.slice(0, -' unusualifier'.length).replace(/^unusual /, '').trim());
      if (target === undefined || target === null) return null;
      return { defindex: D_UNUSUALIFIER, target, quality: Q_UNUSUAL };
    }
    if (st.killstreak > 0 && (rest === 'kit' || rest.endsWith(' kit'))) {
      const target = targetOf(rest === 'kit' ? '' : rest.slice(0, -' kit'.length).trim());
      if (target === undefined) return null;
      return { defindex: kitDefindex(st.killstreak), target };
    }
    if (rest === 'war paint' && st.paintkit !== null) {
      const d = this.warPaintByKit.get(st.paintkit);
      if (d === undefined) return null;
      return { defindex: d };
    }
    return null;
  }

  private resolveRemainder(
    rest: string,
    st: ParseState,
  ): { defindex: number; exact: boolean; target?: number | null; output?: number | null; outputQuality?: number | null; quality?: number } | null {
    if (!rest) return null;
    const special = this.specialForm(rest, st, false);
    if (special) return { ...special, exact: true };

    const retired = this.retiredKeyByKey.get(rest);
    if (retired !== undefined) return { defindex: retired, exact: true };

    const crate = this.crateByName(rest, st);
    if (crate !== null) return { defindex: crate, exact: true };

    const cands = this.findByName(rest);
    if (cands.length > 0) {
      const d = this.pickDefindex(cands, st.paintkit, st.quality);
      if (d !== null) return { defindex: d, exact: true };
    }

    const fuzzy = this.fuzzyItem(rest);
    if (fuzzy === null) return null;
    const it = this.items.get(fuzzy);
    st.warnings.push(`No exact item named "${rest}"; using the closest match "${it?.itemName ?? fuzzy}"`);
    return { defindex: this.pickDefindex(this.findByName(it?.itemName ?? ''), st.paintkit, st.quality) ?? fuzzy, exact: false };
  }

  /** The defindex that carries `series` for multi-series crates (Mann Co. Supply Crate / Munition). */
  private crateForSeries(defindex: number, series: number): number {
    const it = this.items.get(defindex);
    if (!it) return defindex;
    const key = normKey(it.itemName);
    if (key === 'mann co. supply crate') {
      for (const [d, list] of MANN_CO_CRATE_SERIES) if (list.includes(series)) return d;
    }
    if (key === 'mann co. supply munition') return MUNITION_CRATES.get(series) ?? defindex;
    return defindex;
  }

  private crateByName(rest: string, st: ParseState): number | null {
    const n = st.number;
    if (rest === 'mann co. supply crate' && n !== null) {
      for (const [d, series] of MANN_CO_CRATE_SERIES) if (series.includes(n)) return d;
      return null;
    }
    if (rest === 'salvaged mann co. supply crate') {
      if (n !== null && !SALVAGED_SERIES.includes(n)) st.warnings.push(`Salvaged Mann Co. Supply Crate #${n} is not a known series`);
      return SALVAGED_CRATE;
    }
    if (rest === 'select reserve mann co. supply crate') {
      st.number = 60;
      return SELECT_RESERVE_CRATE;
    }
    if (rest === 'mann co. supply munition' && n !== null) return MUNITION_CRATES.get(n) ?? null;
    return null;
  }

  private fuzzyItem(rest: string): number | null {
    if (rest.length < 4) return null;
    if (!this.fuzzyKeys) this.fuzzyKeys = [...this.byName.keys()];
    const max = Math.max(1, Math.floor(rest.length * 0.2));
    let bestKey: string | null = null;
    let bestDist = max + 1;
    for (const key of this.fuzzyKeys) {
      const dist = levenshtein(rest, key, Math.min(max, bestDist - 1));
      if (dist < bestDist) {
        bestDist = dist;
        bestKey = key;
        if (dist === 1) break;
      }
    }
    if (bestKey === null) return null;
    return this.byName.get(bestKey)?.[0] ?? null;
  }

  private finish(
    defindex: number,
    r: { exact: boolean; target?: number | null; output?: number | null; outputQuality?: number | null; quality?: number },
    st: ParseState,
  ): ParsedName {
    const warnings = st.warnings;
    const it = this.items.get(defindex);
    const isSkin = st.paintkit !== null || this.isWarPaint(defindex) || this.skinSpecific.has(defindex);
    let quality: number | null = r.quality ?? null;
    let quality2: number | null = null;

    for (const q of st.extraQualities) warnings.push(`Ignored extra quality "${qualityName(q)}"`);

    if (quality === null) {
      if (st.effect !== null) {
        if (isSkin) {
          // 0.7.3: an unusual skin is Decorated plus its effect, strange as quality2, as bp.tf and the import key it (P2).
          quality = Q_DECORATED;
          if (st.strange) quality2 = Q_STRANGE;
        } else if (st.effect === COMMUNITY_SPARKLE && st.quality !== null) {
          quality = st.quality;
          if (st.strange) quality2 = Q_STRANGE;
        } else {
          quality = Q_UNUSUAL;
          if (st.strange) quality2 = Q_STRANGE;
          if (st.quality !== null && st.quality !== Q_UNUSUAL) warnings.push(`Ignored quality "${qualityName(st.quality)}" on an unusual`);
        }
      } else if (st.unusual) {
        quality = Q_UNUSUAL;
        if (st.strange) quality2 = Q_STRANGE;
        if (this.itemQuality(defindex) !== Q_UNUSUAL) warnings.push('Unusual without an effect: the effect is unknown');
      } else if (st.quality !== null) {
        quality = st.quality;
        if (st.strange) quality2 = Q_STRANGE;
      } else if (st.strange) {
        if (st.explicitElevated) {
          quality = isSkin ? Q_DECORATED : this.itemQuality(defindex);
          quality2 = Q_STRANGE;
        } else quality = Q_STRANGE;
      } else {
        quality = isSkin ? Q_DECORATED : this.defaultQuality(defindex);
      }
    } else if (st.strange && quality !== Q_STRANGE) {
      quality2 = Q_STRANGE;
    }

    if (quality2 === Q_STRANGE && quality === Q_STRANGE) quality2 = null;

    const obj: Partial<SkuObject> = {
      defindex,
      quality,
      craftable: st.craftable,
      tradable: st.tradable,
      killstreak: st.killstreak,
      australium: st.australium,
      effect: st.effect,
      festive: st.festive,
      paintkit: st.paintkit,
      wear: st.wear,
      quality2,
      paint: st.paint,
      target: r.target ?? null,
      output: r.output ?? null,
      outputQuality: r.outputQuality ?? null,
    };

    if (it?.itemClass === 'supply_crate') {
      // The schema's series attribute is wrong for the multi-series Mann Co. crates; never use it for them.
      const known = this.hasStaticCrateSeries(defindex) ? null : this.crateSeries(defindex);
      obj.crateseries = st.number ?? known;
      if (obj.crateseries === null && !SERIESLESS_CRATES.has(defindex)) warnings.push(`${it.itemName}: series number missing`);
      if (st.number !== null && known !== null && known !== st.number) {
        warnings.push(`${it.itemName} is series #${known}, not #${st.number}`);
      }
    } else if (st.number !== null) {
      obj.craftnumber = st.number;
    }

    return { obj: normalizeSkuObject(obj), exact: r.exact, warnings };
  }

  private defaultQuality(defindex: number): number {
    const q = this.itemQuality(defindex);
    // Stock items (0) trade as Unique when no upgradeable twin exists; 255 is not a real quality.
    return q === 0 || q === 255 ? Q_UNIQUE : q;
  }

  private hasStaticCrateSeries(defindex: number): boolean {
    return MANN_CO_CRATE_SERIES.has(defindex) || defindex === SALVAGED_CRATE || [...MUNITION_CRATES.values()].includes(defindex);
  }
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function qualityName(id: number): string {
  return QUALITY_NAMES[id] ?? `Quality ${id}`;
}

function kitDefindex(killstreak: number): number {
  if (killstreak >= 3) return D_KIT_PROFESSIONAL;
  if (killstreak === 2) return D_KIT_SPECIALIZED;
  return D_KIT_BASIC;
}

function isKitDefindex(defindex: number): boolean {
  return defindex === D_KIT_BASIC || defindex === D_KIT_SPECIALIZED || defindex === D_KIT_PROFESSIONAL;
}
