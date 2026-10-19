// Item schema service: sku.pricedb.io schema -> derived maps in SQLite ->
// in-memory indexes for names, SKU resolution and search (DESIGN_BRIEF §2.9, §4).
//
// The full schema (~21 MB parsed) is fetched at most once per 24 h with
// If-None-Match, reduced to SchemaSnapshot + SchemaExtras and dropped.

import { z } from 'zod';
import { categorize } from '../../shared/categories';
import { itemUrlParts } from '../../shared/itemUrl';
import { baseSku, canonical, fromObject, fromString, isValidSku, looksLikeSku } from '../../shared/sku';
import type { Category, ConnState, ConnectorHealth, ItemSuggestion, ResolvedItem, SkuObject, UnixMs } from '../../shared/types';
import { KILLSTREAK_NAMES, QUALITY_NAMES } from '../../shared/types';
import type {
  EffectRow,
  PaintRow,
  PaintkitRow,
  SchemaItemRow,
  SchemaService,
  SchemaSnapshot,
  ServiceDeps,
} from '../contracts';
import { HostBlockedError, HttpStatusError, NetworkPausedError, RateLimitedError } from '../net/errors';
import {
  RETIRED_KEYS,
  SchemaIndex,
  emptyExtras,
  hexOf,
  normKey,
  parseExtras,
  type SchemaData,
  type SchemaExtras,
} from './schemaNames';

export const SCHEMA_URL = 'https://sku.pricedb.io/api/schema';
export const PAINT_LIST_URL = 'https://sku.pricedb.io/api/paint/list';
export const SCHEMA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Repo meta keys owned by this module. */
export const META_SCHEMA_EXTRAS = 'schema.extras.v1';
export const META_SCHEMA_CHECKED_AT = 'schema.checkedAt';

const SCHEMA_TIMEOUT_MS = 180_000;
const NAME_CACHE_MAX = 20_000;
const SEARCH_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

const numberish = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);

const rawAttributeSchema = z.looseObject({
  name: z.string().catch(''),
  class: z.string().nullish().catch(null),
  value: z.unknown(),
});

const rawItemSchema = z.looseObject({
  defindex: z.number().int().nonnegative(),
  name: z.string().catch(''),
  item_name: z.string().catch(''),
  proper_name: z.boolean().catch(false),
  item_class: z.string().catch(''),
  item_slot: z.string().nullish().catch(null),
  craft_class: z.string().nullish().catch(null),
  used_by_classes: z.array(z.string()).catch([]),
  image_url: z.string().nullish().catch(null),
  item_quality: z.number().int().catch(6),
  attributes: z.array(rawAttributeSchema).nullish().catch(null),
});

const rawParticleSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string().catch(''),
});

const rawSchemaTopSchema = z.looseObject({
  raw: z.looseObject({
    schema: z.looseObject({
      items: z.array(z.unknown()),
      attribute_controlled_attached_particles: z.array(z.unknown()).catch([]),
      paintkits: z.record(z.string(), z.unknown()).catch({}),
    }),
    items_game: z
      .looseObject({ items: z.record(z.string(), z.unknown()).catch({}) })
      .nullish()
      .catch(null),
  }),
});

const itemsGameItemSchema = z.looseObject({
  static_attrs: z.record(z.string(), z.unknown()).nullish().catch(null),
});

const paintListSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.number().int().nonnegative(), name: z.string().min(1) })),
});

export class SchemaFormatError extends Error {
  override readonly name = 'SchemaFormatError';
}

// ---------------------------------------------------------------------------
// Snapshot building
// ---------------------------------------------------------------------------

/**
 * BLU tints of the team paints ("set item tint RGB 2" in items_game.txt, as
 * served by sku.pricedb.io on 2026-10-14). Used only when the schema lacks them.
 */
const STATIC_BLU_TINTS: ReadonlyMap<number, number> = new Map([
  [12073019, 5801378], // Team Spirit
  [4732984, 3686984], // Operator's Overalls
  [11049612, 8626083], // Waterlogged Lab Coat
  [3874595, 1581885], // Balaclavas Are Forever
  [6637376, 2636109], // An Air of Debonair
  [8400928, 2452877], // The Value of Teamwork
  [12807213, 12091445], // Cream Spirit
]);

/** The pre-2011 BLU Team Spirit shade; sku.pricedb.io lists it as its own paint. */
const LEGACY_PAINT = { decimal: 5801378, name: 'Legacy Paint' };

const KILLSTREAK_EYE_IDS = { min: 2001, max: 2008 };

function effectType(id: number): EffectRow['type'] {
  if (id >= 1 && id <= 699) return 'cosmetic';
  if (id >= 701 && id <= 704) return 'weapon';
  if (id >= 3001 && id <= 3999) return 'taunt';
  return 'other';
}

function isHiddenEffect(id: number, name: string): boolean {
  if (!name.trim()) return true;
  if (/^attrib_particle\d*$/i.test(name.trim())) return true;
  return id >= KILLSTREAK_EYE_IDS.min && id <= KILLSTREAK_EYE_IDS.max;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'object' && v !== null && 'value' in v) return toNumber((v as { value: unknown }).value);
  const r = numberish.safeParse(v);
  return r.success && Number.isFinite(r.data) ? r.data : null;
}

function httpsImage(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  return url.replace(/^http:\/\//i, 'https://');
}

export interface SchemaBuildResult {
  snapshot: SchemaSnapshot;
  extras: SchemaExtras;
  stats: { items: number; skippedItems: number; effects: number; hiddenEffects: number; paintkits: number; paints: number };
}

/**
 * Reduces the sku.pricedb.io schema object (and optionally /api/paint/list) to
 * the rows the Repo stores plus SchemaExtras. Throws SchemaFormatError when the
 * payload is not a schema at all; individual bad entries are skipped and counted.
 */
export function buildSchemaSnapshot(raw: unknown, paintList: unknown, fetchedAt: UnixMs, etag: string | null): SchemaBuildResult {
  const top = rawSchemaTopSchema.safeParse(raw);
  if (!top.success) throw new SchemaFormatError('sku.pricedb.io schema has an unexpected shape');
  const schema = top.data.raw.schema;

  const extras = emptyExtras();
  const items: SchemaItemRow[] = [];
  const tints = new Map<number, { red: number | null; blu: number | null; name: string }>();
  const seen = new Set<number>();
  let skippedItems = 0;

  for (const entry of schema.items) {
    const r = rawItemSchema.safeParse(entry);
    if (!r.success || seen.has(r.data.defindex)) {
      skippedItems++;
      continue;
    }
    const it = r.data;
    seen.add(it.defindex);
    items.push({
      defindex: it.defindex,
      name: it.name,
      itemName: it.item_name || it.name,
      properName: it.proper_name,
      itemClass: it.item_class,
      slot: it.item_slot ? it.item_slot : null,
      craftClass: it.craft_class ? it.craft_class : null,
      usedByClasses: it.used_by_classes,
      imageUrl: httpsImage(it.image_url),
    });
    if (it.item_quality !== 6) extras.itemQuality[String(it.defindex)] = it.item_quality;

    const attrs = it.attributes ?? [];
    if (attrs[0]?.class === 'supply_crate_series') extras.crateSeriesAttr.push(it.defindex);
    for (const a of attrs) {
      if (a.name === 'set supply crate series') {
        const n = toNumber(a.value);
        if (n !== null) extras.crateSeries[String(it.defindex)] = n;
      }
    }
    if (it.name.includes('Paint Can') && it.name !== 'Paint Can') {
      const red = toNumber(attrs.find((a) => a.name === 'set item tint RGB')?.value);
      const blu = toNumber(attrs.find((a) => a.name === 'set item tint RGB 2')?.value);
      if (red !== null) tints.set(red, { red, blu, name: it.item_name });
    }
  }
  if (items.length === 0) throw new SchemaFormatError('sku.pricedb.io schema contains no items');

  for (const [key, value] of Object.entries(top.data.raw.items_game?.items ?? {})) {
    const d = Number(key);
    if (!Number.isInteger(d) || !seen.has(d)) continue;
    const ig = itemsGameItemSchema.safeParse(value);
    const attrs = ig.success ? ig.data.static_attrs : null;
    if (!attrs) continue;
    const series = toNumber(attrs['set supply crate series']);
    if (series !== null && extras.crateSeries[key] === undefined) extras.crateSeries[key] = series;
    const pk = toNumber(attrs['paintkit_proto_def_index']);
    if (pk !== null) extras.skinPaintkit[key] = pk;
  }

  // Effects: hide placeholders and killstreak eyes; RED/BLU twins share a name and map to the lower id.
  const particles: { id: number; name: string }[] = [];
  let hiddenEffects = 0;
  for (const entry of schema.attribute_controlled_attached_particles) {
    const p = rawParticleSchema.safeParse(entry);
    if (!p.success) continue;
    const name = p.data.name.trim();
    if (isHiddenEffect(p.data.id, name)) {
      hiddenEffects++;
      continue;
    }
    particles.push({ id: p.data.id, name });
  }
  const lowestByName = new Map<string, number>();
  for (const p of particles) {
    const prev = lowestByName.get(p.name);
    if (prev === undefined || p.id < prev) lowestByName.set(p.name, p.id);
  }
  const effectIds = new Set<number>();
  const effects: EffectRow[] = [];
  for (const p of particles) {
    if (effectIds.has(p.id)) continue;
    effectIds.add(p.id);
    effects.push({ id: p.id, name: p.name, canonicalId: lowestByName.get(p.name) ?? p.id, type: effectType(p.id) });
  }

  const paintkits: PaintkitRow[] = [];
  for (const [key, value] of Object.entries(schema.paintkits)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || typeof value !== 'string' || !value.trim()) continue;
    paintkits.push({ id, name: value.trim() });
  }
  paintkits.sort((a, b) => a.id - b.id);

  const paints = buildPaints(paintList, tints);

  return {
    snapshot: { items, effects, paints, paintkits, fetchedAt, etag },
    extras,
    stats: { items: items.length, skippedItems, effects: effects.length, hiddenEffects, paintkits: paintkits.length, paints: paints.length },
  };
}

function buildPaints(paintList: unknown, tints: Map<number, { red: number | null; blu: number | null; name: string }>): PaintRow[] {
  const bluFor = (decimal: number): string | null => {
    const blu = tints.get(decimal)?.blu ?? STATIC_BLU_TINTS.get(decimal) ?? null;
    return blu === null ? null : hexOf(blu);
  };
  const out = new Map<number, PaintRow>();
  const list = paintListSchema.safeParse(paintList);
  if (list.success && list.data.data.length > 0) {
    for (const p of list.data.data) {
      if (!out.has(p.id)) out.set(p.id, { decimal: p.id, hex: hexOf(p.id), name: p.name.trim(), bluHex: bluFor(p.id) });
    }
  } else {
    for (const t of tints.values()) {
      if (t.red === null || out.has(t.red)) continue;
      out.set(t.red, { decimal: t.red, hex: hexOf(t.red), name: t.name, bluHex: bluFor(t.red) });
    }
    if (out.size > 0 && !out.has(LEGACY_PAINT.decimal)) {
      out.set(LEGACY_PAINT.decimal, { decimal: LEGACY_PAINT.decimal, hex: hexOf(LEGACY_PAINT.decimal), name: LEGACY_PAINT.name, bluHex: null });
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// URL inputs
// ---------------------------------------------------------------------------

type UrlInput = { kind: 'sku'; sku: string } | { kind: 'name'; text: string; priceindex: string | null; unusual: boolean };

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function skuFromPath(segment: string | undefined): UrlInput | null {
  if (!segment) return null;
  const sku = decodeSegment(segment).trim();
  return looksLikeSku(sku) ? { kind: 'sku', sku } : null;
}

/** marketplace.tf item pages, PriceDB item/graph URLs and backpack.tf stats pages. */
export function parseItemUrl(text: string): UrlInput | null {
  if (!/^https?:\/\//i.test(text)) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  // Hosts and path shapes live in shared/itemUrl.ts: main's clipboard filter lets exactly these through.
  const parts = itemUrlParts(u);
  if (!parts) return null;
  if (parts.kind === 'sku') return skuFromPath(parts.segment);
  if (parts.kind === 'stats') return classicStats(parts.segments.map(decodeSegment));
  return nextStats(parts.params);
}

function classicStats(segs: string[]): UrlInput | null {
  const [, quality = '', item = '', tradable = 'Tradable', craftable = 'Craftable', priceindex] = segs;
  if (!item.trim()) return null;
  const q = quality.trim();
  const parts: string[] = [];
  if (/^non-?craftable$/i.test(craftable)) parts.push('Non-Craftable');
  if (/^non-?tradable$/i.test(tradable)) parts.push('Non-Tradable');
  if (q && q.toLowerCase() !== 'unique') parts.push(q);
  parts.push(item.replace(/\s*\|\s*/g, ' '));
  return { kind: 'name', text: parts.join(' '), priceindex: priceindex?.trim() || null, unusual: /unusual/i.test(q) };
}

function nextStats(p: URLSearchParams): UrlInput | null {
  const item = p.get('item')?.trim();
  if (!item) return null;
  const qRaw = (p.get('quality') ?? 'Unique').trim();
  const quality = /^\d+$/.test(qRaw) ? (QUALITY_NAMES[Number(qRaw)] ?? 'Unique') : qRaw;
  const parts: string[] = [];
  if (p.get('craftable') === '0') parts.push('Non-Craftable');
  if (p.get('tradable') === '0') parts.push('Non-Tradable');
  if (/strange/i.test(p.get('elevatedQuality') ?? '') && !/strange/i.test(quality)) parts.push('Strange');
  if (quality.toLowerCase() !== 'unique') parts.push(quality);
  if (p.get('festivized') === '1') parts.push('Festivized');
  const ks = KILLSTREAK_NAMES[Number(p.get('killstreakTier'))];
  if (ks) parts.push(ks);
  const texture = p.get('texture')?.trim();
  if (texture) parts.push(texture);
  if (p.get('australium') === '1') parts.push('Australium');
  parts.push(item);
  const wear = p.get('wearTier')?.trim();
  return {
    kind: 'name',
    text: parts.join(' ') + (wear ? ` (${wear})` : ''),
    priceindex: p.get('priceindex')?.trim() || null,
    unusual: /unusual/i.test(quality),
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface SearchEntry {
  key: string;
  sku: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True for an item without any prefix or suffix (already covered by the plain search entries). */
function isPlainItem(ix: SchemaIndex, o: SkuObject): boolean {
  if (ix.isWarPaint(o.defindex) && o.paintkit === null) return true;
  return (
    o.craftable &&
    o.tradable &&
    o.killstreak === 0 &&
    !o.australium &&
    !o.festive &&
    o.effect === null &&
    o.paintkit === null &&
    o.wear === null &&
    o.quality2 === null &&
    o.target === null &&
    o.output === null &&
    o.craftnumber === null &&
    o.crateseries === null &&
    o.paint === null &&
    (o.quality === 6 || o.quality === ix.itemQuality(o.defindex))
  );
}

/** 0 prefix, 1 word prefix, 2 substring, null no match. */
export function searchRank(name: string, query: string): number | null {
  const key = normKey(name);
  const q = normKey(query);
  if (!q || !key) return null;
  const noThe = key.startsWith('the ') ? key.slice(4) : key;
  if (key.startsWith(q) || noThe.startsWith(q)) return 0;
  if (new RegExp(`(?:^|[\\s\\-:(./'"])${escapeRegExp(q)}`).test(key)) return 1;
  if (key.includes(q)) return 2;
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSchemaService(deps: ServiceDeps): SchemaService {
  const { clock, log, repo, http } = deps;

  let index: SchemaIndex | null = null;
  let loadedAt: UnixMs | null = null;
  let extrasMissing = true;
  let inflight: Promise<void> | null = null;
  let searchEntries: SearchEntry[] | null = null;
  const nameCache = new Map<string, string>();

  let state: ConnState = 'off';
  let lastOkAt: UnixMs | null = null;
  let lastErrorAt: UnixMs | null = null;
  let lastError: string | null = null;
  let disabledReason: string | null = null;
  /** Set when sku.pricedb.io answered 401/403; no further schema requests until restart. */
  let refused: string | null = null;

  const install = (data: SchemaData, at: UnixMs | null): void => {
    index = new SchemaIndex(data);
    loadedAt = at;
    nameCache.clear();
    searchEntries = null;
  };

  const loadFromRepo = (): void => {
    const info = repo.schemaInfo();
    if (info.items === 0) return;
    const extras = parseExtras(repo.getMeta(META_SCHEMA_EXTRAS));
    extrasMissing = extras === null;
    install(
      {
        items: repo.allSchemaItems(),
        effects: repo.effects(),
        paints: repo.paints(),
        paintkits: repo.paintkits(),
        extras: extras ?? emptyExtras(),
      },
      info.loadedAt,
    );
  };

  const isStale = (): boolean => {
    if (!index || extrasMissing) return true;
    const checked = Number(repo.getMeta(META_SCHEMA_CHECKED_AT) ?? 0);
    const last = Math.max(loadedAt ?? 0, Number.isFinite(checked) ? checked : 0);
    return clock.now() - last >= SCHEMA_MAX_AGE_MS;
  };

  const markOk = (): void => {
    lastOkAt = clock.now();
    state = 'idle';
    disabledReason = null;
  };

  const markError = (err: unknown): void => {
    lastErrorAt = clock.now();
    lastError = errorMessage(err);
    if (err instanceof HostBlockedError) {
      state = 'blocked';
      disabledReason = err.reason;
    } else if (err instanceof NetworkPausedError) {
      state = 'paused';
    } else if (err instanceof RateLimitedError) {
      state = 'backoff';
    } else {
      state = index ? 'idle' : 'error';
    }
    if (err instanceof NetworkPausedError) log.info(`schema refresh skipped: ${lastError}`);
    else log.warn(`schema refresh failed: ${lastError}`);
  };

  const doRefresh = async (force: boolean): Promise<void> => {
    state = 'connecting';
    try {
      const etag = index && !extrasMissing && !force ? repo.schemaInfo().etag : null;
      let built: SchemaBuildResult;
      {
        const res = await http.request<unknown>(SCHEMA_URL, {
          budget: 'sku',
          priority: 'background',
          ifNoneMatch: etag,
          timeoutMs: SCHEMA_TIMEOUT_MS,
          maxWaitMs: 120_000,
        });
        if (res.notModified) {
          repo.setMeta(META_SCHEMA_CHECKED_AT, String(clock.now()));
          markOk();
          log.info('schema unchanged (304)');
          return;
        }
        if (res.status === 401 || res.status === 403) {
          // §2.0: the API refused us; never retried automatically (an HTML 403 is already a host block).
          refused = `sku.pricedb.io refused the schema request (HTTP ${res.status}); restart the app after checking pricedb.io`;
          throw new HostBlockedError('sku.pricedb.io', refused);
        }
        if (!res.ok) throw new HttpStatusError(res.status, SCHEMA_URL, res.text);
        if (res.data === null) throw new SchemaFormatError('sku.pricedb.io schema response was not JSON');

        let paintList: unknown = null;
        try {
          const p = await http.request<unknown>(PAINT_LIST_URL, { budget: 'sku', priority: 'background', maxWaitMs: 120_000 });
          if (p.ok) paintList = p.data;
        } catch (err) {
          log.warn(`paint list unavailable, using paint cans from the schema: ${errorMessage(err)}`);
        }
        built = buildSchemaSnapshot(res.data, paintList, clock.now(), res.etag);
      }
      // The raw schema is out of scope here and can be collected.
      const now = clock.now();
      repo.transaction(() => {
        repo.replaceSchema(built.snapshot);
        repo.setMeta(META_SCHEMA_EXTRAS, JSON.stringify(built.extras));
        repo.setMeta(META_SCHEMA_CHECKED_AT, String(now));
      });
      install({ ...built.snapshot, extras: built.extras }, built.snapshot.fetchedAt);
      extrasMissing = false;
      markOk();
      const s = built.stats;
      log.info(
        `schema loaded: ${s.items} items (${s.skippedItems} skipped), ${s.effects} effects (${s.hiddenEffects} hidden), ${s.paintkits} paintkits, ${s.paints} paints`,
      );
    } catch (err) {
      markError(err);
    }
  };

  const refresh = (force = false): Promise<void> => {
    if (refused !== null) return Promise.resolve();
    if (inflight) return inflight;
    if (!force && !isStale()) return Promise.resolve();
    inflight = doRefresh(force).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  /**
   * Resolves once the schema is usable: immediately when a cached copy exists
   * (a due refresh then continues in the background; refresh() returns it),
   * otherwise after the first download attempt. Never rejects.
   */
  const init = async (): Promise<void> => {
    try {
      loadFromRepo();
    } catch (err) {
      log.warn(`cached schema could not be loaded: ${errorMessage(err)}`);
    }
    state = index ? 'idle' : 'off';
    if (index) lastOkAt = loadedAt;
    const pending = refresh(false);
    if (!index) await pending;
  };

  // ----- names -----

  const learnedName = (sku: string): { name: string; marketName: string | null } | null => {
    try {
      const row = repo.getBptfName(sku);
      return row && row.name.trim() ? { name: row.name, marketName: row.marketName } : null;
    } catch {
      return null;
    }
  };

  const canonicalOrSelf = (sku: string): string => {
    const t = String(sku ?? '').trim();
    return looksLikeSku(t) ? canonical(t) : t;
  };

  const synthesizedName = (sku: string): string => {
    const cached = nameCache.get(sku);
    if (cached !== undefined) return cached;
    const name = index?.getName(fromString(sku), { proper: true, elevatedMarker: false }) ?? null;
    if (name === null) {
      try {
        const pdb = repo.getPricedb(sku)?.name;
        if (pdb && pdb.trim()) return pdb;
      } catch {
        // fall through to the SKU itself
      }
      return sku;
    }
    if (nameCache.size >= NAME_CACHE_MAX) nameCache.clear();
    nameCache.set(sku, name);
    return name;
  };

  const nameForSku = (sku: string): string => {
    const canon = canonicalOrSelf(sku);
    if (!canon) return '';
    const learned = learnedName(canon) ?? (canon !== sku ? learnedName(String(sku).trim()) : null);
    if (learned) return learned.name;
    if (!looksLikeSku(canon)) return canon;
    // Learned bp.tf names are keyed by the base SKU (bp.tf names never include paint).
    const base = baseSku(canon);
    if (base !== canon) {
      const learnedBase = learnedName(base);
      if (learnedBase) {
        const paint = fromString(canon).paint;
        const paintName = paint !== null ? (index?.paintByDecimal(paint)?.name ?? String(paint)) : null;
        return paintName ? `${learnedBase.name} (Paint: ${paintName})` : learnedBase.name;
      }
    }
    return synthesizedName(canon);
  };

  const baseNameForSku = (sku: string): string => {
    const canon = canonicalOrSelf(sku);
    if (!looksLikeSku(canon)) return canon;
    const d = fromString(canon).defindex;
    return RETIRED_KEYS.get(d) ?? index?.item(d)?.itemName ?? canon;
  };

  const marketHashName = (sku: string): string | null => {
    const canon = canonicalOrSelf(sku);
    if (!looksLikeSku(canon)) return null;
    const obj = fromString(canon);
    if (!obj.craftable || !obj.tradable) return null;
    const learned = learnedName(canon);
    if (learned?.marketName) return learned.marketName;
    return index?.getName(obj, { proper: true, scmFormat: true }) ?? null;
  };

  const categoryForSku = (sku: string): Category => {
    const canon = canonicalOrSelf(sku);
    if (!looksLikeSku(canon)) return 'other';
    const obj = fromString(canon);
    const it = index?.item(obj.defindex) ?? null;
    return categorize(obj, it ? { itemClass: it.itemClass, slot: it.slot, craftClass: it.craftClass, itemName: it.itemName } : null);
  };

  // ----- resolve -----

  const skuWarnings = (obj: SkuObject): string[] => {
    const w: string[] = [];
    if (!index) return w;
    const it = index.item(obj.defindex);
    if (!it) w.push(`Defindex ${obj.defindex} is not in the item schema`);
    if (obj.effect !== null && index.effectName(obj.effect) === null) w.push(`Unknown unusual effect ${obj.effect}`);
    if (obj.paintkit !== null && index.paintkitName(obj.paintkit) === null) w.push(`Unknown paintkit ${obj.paintkit}`);
    if (obj.quality === 5 && obj.effect === null && index.itemQuality(obj.defindex) !== 5 && obj.defindex !== 9258) {
      w.push('Unusual without an effect: the effect is unknown');
    }
    if (it?.itemClass === 'supply_crate' && obj.crateseries === null && ![5737, 5738, 5739, 5760].includes(obj.defindex)) {
      w.push(`${it.itemName}: series number missing`);
    }
    return w;
  };

  const resolved = (obj: SkuObject, match: ResolvedItem['match'], warnings: string[]): ResolvedItem => {
    let o = obj;
    const w = [...warnings];
    if (index && o.effect !== null) {
      const canon = index.canonicalEffectId(o.effect);
      if (canon !== o.effect) {
        w.push(`Effect ${o.effect} is the BLU twin of ${canon}; using ${canon}`);
        o = { ...o, effect: canon };
      }
    }
    const sku = fromObject(o);
    return { sku, name: nameForSku(sku), skuObject: fromString(sku), category: categoryForSku(sku), match, warnings: w };
  };

  const resolve = (text: string): ResolvedItem | null => {
    const t = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || t.length > 400) return null;

    // SKUs are lower case, and fromString ignores tokens it does not know: text with
    // one ("378;6;uncratable") is not a SKU, rather than silently another item.
    if (looksLikeSku(t)) {
      const sku = t.toLowerCase();
      if (!isValidSku(sku)) return null;
      const obj = fromString(sku);
      return resolved(obj, 'sku', skuWarnings(obj));
    }

    const url = parseItemUrl(t);
    if (url?.kind === 'sku') {
      const sku = url.sku.toLowerCase();
      if (!isValidSku(sku)) return null;
      const obj = fromString(sku);
      return resolved(obj, 'sku', skuWarnings(obj));
    }
    if (url?.kind === 'name') {
      if (!index) return null;
      const parsed = index.parseName(url.text);
      if (!parsed) return null;
      let obj = parsed.obj;
      let warnings = parsed.warnings;
      if (url.priceindex) {
        obj = index.applyPriceindex(obj, url.priceindex, url.unusual);
        if (obj.effect !== null) warnings = warnings.filter((w) => !w.startsWith('Unusual without an effect'));
        if (obj.crateseries !== null) warnings = warnings.filter((w) => !w.endsWith('series number missing'));
      }
      return resolved(obj, parsed.exact ? 'exact' : 'fuzzy', warnings);
    }

    let learnedSku: string | null = null;
    try {
      learnedSku = repo.findSkuByBptfName(t);
    } catch {
      learnedSku = null;
    }
    if (learnedSku && looksLikeSku(learnedSku)) {
      const obj = fromString(learnedSku);
      const r = resolved(obj, 'exact', []);
      return { ...r, name: nameForSku(learnedSku) };
    }

    if (!index) return null;
    const parsed = index.parseName(t);
    if (!parsed) return null;
    return resolved(parsed.obj, parsed.exact ? 'exact' : 'fuzzy', parsed.warnings);
  };

  // ----- search -----

  const buildSearchEntries = (ix: SchemaIndex): SearchEntry[] => {
    const out: SearchEntry[] = [];
    const seen = new Set<string>();
    for (const it of ix.items.values()) {
      const key = normKey(it.itemName);
      if (!key || key.startsWith('#') || seen.has(key)) continue;
      seen.add(key);
      const d = ix.pickDefindex(ix.findByName(it.itemName), null, null);
      if (d === null || ix.isSkinSpecific(d) || ix.isWarPaint(d)) continue;
      const q = ix.itemQuality(d);
      if (q === 255) continue;
      const quality = q === 0 || q === 15 ? 6 : q;
      let sku = `${d};${quality}`;
      if (ix.isCrate(d)) {
        // Crates only have prices per series; multi-series crates need "#N" typed in.
        const series = ix.crateAliases(d).length === 0 ? ix.crateSeries(d) : null;
        if (series === null && ![5737, 5738, 5739, 5760].includes(d)) continue;
        if (series !== null) sku += `;c${series}`;
      }
      out.push({ key, sku });
    }
    return out;
  };

  const search = (q: string, limit: number): ItemSuggestion[] => {
    const query = normKey(q);
    if (!query) return [];
    const lim = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20));

    interface Hit {
      sku: string;
      name: string;
      source: ItemSuggestion['source'];
      rank: number;
    }
    const hits = new Map<string, Hit>();
    const offer = (h: Hit): void => {
      const prev = hits.get(h.sku);
      if (!prev || h.rank < prev.rank || (h.rank === prev.rank && h.source === 'bptf' && prev.source !== 'bptf')) hits.set(h.sku, h);
    };

    // A complete name with prefixes ("burning flames team captain") resolves to one exact SKU.
    if (index && query.includes(' ')) {
      const parsed = index.parseName(q);
      if (parsed?.exact && !isPlainItem(index, parsed.obj)) {
        const sku = fromObject(parsed.obj);
        offer({ sku, name: nameForSku(sku), source: 'schema', rank: -1 });
      }
    }

    try {
      for (const row of repo.searchBptfNames(q, lim * 3)) {
        const rank = searchRank(row.name, query) ?? (row.marketName ? searchRank(row.marketName, query) : null);
        // Painted copies share the plain item's name; suggest the base SKU once.
        if (rank !== null && looksLikeSku(row.sku)) offer({ sku: baseSku(row.sku), name: row.name, source: 'bptf', rank });
      }
    } catch (err) {
      log.debug(`bp.tf name search failed: ${errorMessage(err)}`);
    }

    if (index) {
      searchEntries ??= buildSearchEntries(index);
      const schemaHits: { e: SearchEntry; rank: number }[] = [];
      for (const e of searchEntries) {
        const rank = searchRank(e.key, query);
        if (rank !== null) schemaHits.push({ e, rank });
      }
      schemaHits.sort((a, b) => a.rank - b.rank || a.e.key.length - b.e.key.length || a.e.key.localeCompare(b.e.key));
      for (const { e, rank } of schemaHits.slice(0, lim * 3)) {
        if (hits.has(e.sku) && (hits.get(e.sku)?.rank ?? 99) <= rank) continue;
        offer({ sku: e.sku, name: nameForSku(e.sku), source: 'schema', rank });
      }
    }

    return [...hits.values()]
      .sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, lim)
      .map((h) => ({ sku: h.sku, name: h.name, category: categoryForSku(h.sku), source: h.source }));
  };

  // ----- health -----

  const health = (): ConnectorHealth => {
    let detail: string;
    if (!index) {
      detail = state === 'connecting' ? 'Downloading the item schema' : 'Item schema not loaded';
    } else {
      const age = loadedAt ? new Date(loadedAt).toISOString() : 'unknown';
      detail = `${index.items.size} items, ${index.effects.size} effects, ${index.paintkitList.length} paintkits; downloaded ${age}`;
      if (lastErrorAt !== null && (lastOkAt === null || lastErrorAt > lastOkAt)) detail += `; last refresh failed, using the cached copy`;
    }
    return { id: 'schema', label: 'Item schema (sku.pricedb.io)', state, detail, lastOkAt, lastErrorAt, lastError, disabledReason };
  };

  return {
    init,
    refresh,
    isLoaded: () => index !== null && index.items.size > 0,
    health,
    itemByDefindex: (d) => index?.item(d) ?? null,
    itemQuality: (d) => (index?.item(d) ? index.itemQuality(d) : null),
    nameForSku,
    baseNameForSku,
    marketHashName,
    resolve,
    search,
    categoryForSku,
    effectName: (id) => index?.effectName(id) ?? null,
    effectIdByName: (name) => index?.effectIdByName(name) ?? null,
    canonicalEffectId: (id) => index?.canonicalEffectId(id) ?? id,
    paintByDecimal: (d): PaintRow | null => index?.paintByDecimal(d) ?? null,
    paintDecimalByHex: (hex) => index?.paintDecimalByHex(hex) ?? null,
    paintkitName: (id) => index?.paintkitName(id) ?? null,
    paintkitIdByName: (name) => index?.paintkitIdByName(name) ?? null,
    paintkits: () => (index ? [...index.paintkitList] : []),
  };
}
