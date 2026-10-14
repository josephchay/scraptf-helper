// Clean buy-order matching (design brief §5.2) and price-sheet rule filters.

import { fromObject, fromString, looksLikeSku } from '../../shared/sku';
import type { Category, Listing, RuleFilter, Settings, SkuObject, SpecialAttrs, UnixMs } from '../../shared/types';

/** Listings not seen (event or snapshot) for this long are "unverified" (brief §2.1). */
export const UNVERIFIED_AFTER_MS = 24 * 60 * 60 * 1000;

/** Flags that exclude an order from profit. Other flags only lower confidence. */
export const EXCLUDING_FLAGS: ReadonlySet<string> = new Set([
  'not-buy-order',
  'marketplace',
  'banned',
  'blocklisted',
  'attribute-specific',
  'duplicate',
]);

export interface MatchTarget {
  baseSku: string;
  /** null = unknown extras (manual entry). */
  special: SpecialAttrs | null;
  /** The item is known to carry extras even when `special` is unknown (e.g. a paint token in its SKU). */
  hasExtras?: boolean;
  /**
   * For an unusual with a specific effect: the effect-less base SKU that generic
   * "Unusual <item>" buy orders map to. Those orders legally buy any effect, so they
   * are eligible exits, flagged 'any-effect'.
   */
  anyEffectBase?: string | null;
}

const anyEffectCache = new Map<string, string | null>();

/**
 * The effect-less base SKU whose buy orders ("Unusual Taunt: Conga", quality 5,
 * no particle) accept this unusual whatever its effect; null for anything else.
 */
export function anyEffectBaseOf(base: string): string | null {
  if (typeof base !== 'string' || !/;5(;|$)/.test(base) || !/;u\d/.test(base)) return null;
  const hit = anyEffectCache.get(base);
  if (hit !== undefined) return hit;
  let out: string | null = null;
  if (looksLikeSku(base)) {
    const obj = fromString(base);
    if (obj.quality === 5 && obj.effect !== null) out = fromObject({ ...obj, effect: null, paint: null });
  }
  if (anyEffectCache.size > 50_000) anyEffectCache.clear();
  anyEffectCache.set(base, out);
  return out;
}

export interface MatchContext {
  blocklist: ReadonlySet<string>;
  notesKeywords: readonly string[];
  now: UnixMs;
  unverifiedAfterMs?: number;
}

export interface OrderClass {
  eligible: boolean;
  flags: string[];
}

export function matchContext(settings: Settings, now: UnixMs): MatchContext {
  return {
    blocklist: new Set((settings.blocklist ?? []).filter((s): s is string => typeof s === 'string')),
    notesKeywords: settings.profit?.notesKeywords ?? [],
    now,
  };
}

// ---------------------------------------------------------------------------
// Special attributes
// ---------------------------------------------------------------------------

function cleanNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    if (typeof x === 'string' || typeof x === 'number') {
      const t = String(x).trim().toLowerCase();
      if (t) out.add(t);
    }
  }
  return [...out].sort();
}

/** Normalised copy: positive numbers or null, lower-cased sorted unique lists, strict booleans. */
export function normalizeSpecial(s: Partial<SpecialAttrs> | null | undefined): SpecialAttrs {
  return {
    paint: cleanNum(s?.paint),
    spells: cleanList(s?.spells),
    parts: cleanList(s?.parts),
    sheen: cleanNum(s?.sheen),
    killstreaker: cleanNum(s?.killstreaker),
    customName: s?.customName === true,
    customDesc: s?.customDesc === true,
  };
}

function hasItems(v: unknown): boolean {
  return Array.isArray(v) && v.some((x) => (typeof x === 'string' || typeof x === 'number') && String(x).trim() !== '');
}

export function isSpecialEmpty(s: Partial<SpecialAttrs> | null | undefined): boolean {
  if (!s) return true;
  return (
    cleanNum(s.paint) === null &&
    !hasItems(s.spells) &&
    !hasItems(s.parts) &&
    cleanNum(s.sheen) === null &&
    cleanNum(s.killstreaker) === null &&
    s.customName !== true &&
    s.customDesc !== true
  );
}

export function specialEquals(a: SpecialAttrs, b: SpecialAttrs): boolean {
  const x = normalizeSpecial(a);
  const y = normalizeSpecial(b);
  return (
    x.paint === y.paint &&
    x.sheen === y.sheen &&
    x.killstreaker === y.killstreaker &&
    x.customName === y.customName &&
    x.customDesc === y.customDesc &&
    x.spells.join('\u0000') === y.spells.join('\u0000') &&
    x.parts.join('\u0000') === y.parts.join('\u0000')
  );
}

/**
 * True when `have` has every attribute `want` names: paint, sheen and
 * killstreaker equal when set, spells and parts as subsets, custom name and
 * description required when set. Attributes the order leaves open are free.
 */
export function specialCovers(want: SpecialAttrs, have: SpecialAttrs): boolean {
  const w = normalizeSpecial(want);
  const h = normalizeSpecial(have);
  return (
    (w.paint === null || w.paint === h.paint) &&
    (w.sheen === null || w.sheen === h.sheen) &&
    (w.killstreaker === null || w.killstreaker === h.killstreaker) &&
    (!w.customName || h.customName) &&
    (!w.customDesc || h.customDesc) &&
    w.spells.every((s) => h.spells.includes(s)) &&
    w.parts.every((p) => h.parts.includes(p))
  );
}

function hasPaintToken(listing: Listing): boolean {
  return typeof listing.sku === 'string' && listing.sku !== listing.baseSku && /;p\d/.test(listing.sku);
}

/** The listing's special attributes, taking the paint from its SKU when the attrs omit it. */
export function listingSpecial(listing: Listing): SpecialAttrs {
  const s = normalizeSpecial(listing.special);
  if (s.paint === null && hasPaintToken(listing)) s.paint = cleanNum(fromString(listing.sku).paint);
  return s;
}

// ---------------------------------------------------------------------------
// Notes keywords
// ---------------------------------------------------------------------------

/** NFKD, combining marks removed, lower case. ASCII text skips the (slow) normalisation. */
export function foldText(text: string): string {
  if (!/[^\u0000-\u007f]/.test(text)) return text.toLowerCase();
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

// No '-' in the class: it is literal outside a character class, and under the 'u'
// flag "\-" is an invalid escape, so "pre-fest" would throw on every engine run.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function keywordRegExp(parts: readonly string[]): RegExp | null {
  return parts.length === 0 ? null : new RegExp(`(?<![\\p{L}\\p{N}_])(?:${parts.join('|')})(?![\\p{L}\\p{N}_])`, 'u');
}

/** One bad keyword must not break every match: it is skipped, the rest still compile. */
function safeKeywordRegExp(parts: readonly string[]): RegExp | null {
  try {
    return keywordRegExp(parts);
  } catch {
    const ok = parts.filter((p) => {
      try {
        keywordRegExp([p]);
        return true;
      } catch {
        return false;
      }
    });
    return keywordRegExp(ok);
  }
}

const keywordCache = new Map<string, RegExp | null>();
const KEYWORD_CACHE_MAX = 32;
// The same settings array is passed for every order in a run; skip re-joining it.
const keywordsByArray = new WeakMap<readonly string[], RegExp | null>();

/** Whole-word, case-insensitive matcher for the keywords; multi-word keywords allow any whitespace. */
export function compileKeywords(keywords: readonly string[]): RegExp | null {
  const byArray = keywordsByArray.get(keywords);
  if (byArray !== undefined) return byArray;
  const cacheKey = keywords.join('\u0000');
  const hit = keywordCache.get(cacheKey);
  if (hit !== undefined) {
    keywordsByArray.set(keywords, hit);
    return hit;
  }

  const parts = [
    ...new Set(
      keywords
        .filter((k): k is string => typeof k === 'string')
        .map((k) => foldText(k).trim())
        .filter((k) => k.length > 0)
        .map((k) => k.split(/\s+/).map(escapeRegExp).join('\\s+')),
    ),
  ].sort((a, b) => b.length - a.length);

  const re = safeKeywordRegExp(parts);
  if (keywordCache.size >= KEYWORD_CACHE_MAX) keywordCache.clear();
  keywordCache.set(cacheKey, re);
  keywordsByArray.set(keywords, re);
  return re;
}

export function notesMatch(details: unknown, keywords: readonly string[]): boolean {
  if (typeof details !== 'string' || details.length === 0) return false;
  const re = compileKeywords(keywords);
  return re !== null && re.test(foldText(details));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Brief §5.2. Base SKU equality (including aliases) is guaranteed by the
 * listing query, so it is not re-checked here.
 */
export function classifyOrder(listing: Listing, target: MatchTarget, ctx: MatchContext): OrderClass {
  const flags: string[] = [];

  if (listing.intent !== 'buy') flags.push('not-buy-order');
  if (listing.isMarketplace) flags.push('marketplace');
  if (listing.userBanned) flags.push('banned');
  if (ctx.blocklist.has(listing.steamid)) flags.push('blocklisted');

  // Most orders are generic; only normalise the attributes when there is something to compare.
  const wanted = !isSpecialEmpty(listing.special) || hasPaintToken(listing) ? listingSpecial(listing) : null;
  if (wanted !== null && !isSpecialEmpty(wanted)) {
    // Brief §5.2.5: an attribute-specific order matches only an item that has
    // each attribute it names. Unknown extras never match. Attributes the order
    // leaves open (e.g. the sheen and killstreaker of every Professional
    // Killstreak copy) are extras, as with a generic order.
    if (target.special === null || !specialCovers(wanted, target.special)) flags.push('attribute-specific');
    else if (!specialEquals(wanted, target.special)) flags.push('has-extras');
  } else if (target.hasExtras === true || (target.special !== null && !isSpecialEmpty(target.special))) {
    // A generic order covers any clean copy; selling a painted or spelled copy into it may undersell.
    flags.push('has-extras');
  }

  if (target.anyEffectBase && listing.baseSku === target.anyEffectBase && listing.baseSku !== target.baseSku) flags.push('any-effect');
  if (notesMatch(listing.details, ctx.notesKeywords)) flags.push('notes-flag');

  const unverifiedMs = ctx.unverifiedAfterMs ?? UNVERIFIED_AFTER_MS;
  if (!Number.isFinite(listing.lastEventAt) || ctx.now - listing.lastEventAt > unverifiedMs) flags.push('unverified');

  return { eligible: !flags.some((f) => EXCLUDING_FLAGS.has(f)), flags };
}

function newer(a: Listing, b: Listing): boolean {
  if (a.lastEventAt !== b.lastEventAt) return a.lastEventAt > b.lastEventAt;
  const ab = a.bumpedAt ?? a.listedAt ?? 0;
  const bb = b.bumpedAt ?? b.listedAt ?? 0;
  if (ab !== bb) return ab > bb;
  return a.id > b.id;
}

/** Keeps the newest listing per (steamid, base SKU, intent); input order is preserved for the kept ones. */
export function dedupeOrders(listings: readonly Listing[]): { kept: Listing[]; duplicates: Listing[] } {
  if (listings.length < 2) return { kept: [...listings], duplicates: [] };
  const winner = new Map<string, Listing>();
  for (const l of listings) {
    // Without a steamid there is nothing to deduplicate on.
    const key = l.steamid ? `${l.steamid}|${l.baseSku}|${l.intent}` : `id:${l.id}`;
    const cur = winner.get(key);
    if (!cur || newer(l, cur)) winner.set(key, l);
  }
  const keep = new Set(winner.values());
  const kept: Listing[] = [];
  const duplicates: Listing[] = [];
  for (const l of listings) (keep.has(l) ? kept : duplicates).push(l);
  return { kept, duplicates };
}

// ---------------------------------------------------------------------------
// Price-sheet rules
// ---------------------------------------------------------------------------

export interface RuleSubject {
  obj: SkuObject;
  category: Category;
  /** Full item name, computed lazily because only nameContains needs it. */
  name: string | (() => string);
}

function nonEmpty<T>(v: readonly T[] | undefined | null): v is readonly T[] {
  return Array.isArray(v) && v.length > 0;
}

/** True when every set criterion of the filter holds. An empty filter matches everything. */
export function ruleMatches(filter: RuleFilter, item: RuleSubject): boolean {
  const { obj } = item;
  if (nonEmpty(filter.categories) && !filter.categories.includes(item.category)) return false;
  if (nonEmpty(filter.qualities) && !filter.qualities.includes(obj.quality)) return false;
  if (typeof filter.craftable === 'boolean' && obj.craftable !== filter.craftable) return false;
  if (typeof filter.australium === 'boolean' && obj.australium !== filter.australium) return false;
  if (nonEmpty(filter.killstreak) && !filter.killstreak.includes(obj.killstreak)) return false;
  if (typeof filter.hasEffect === 'boolean') {
    // A generic any-effect Unusual base (378;5) is categorised 'unusuals': it is not an effect-less item.
    const has = item.category === 'unusuals' || (typeof obj.effect === 'number' && obj.effect > 0);
    if (has !== filter.hasEffect) return false;
  }
  if (nonEmpty(filter.defindexes) && !filter.defindexes.includes(obj.defindex)) return false;
  if (typeof filter.nameContains === 'string') {
    const needle = foldText(filter.nameContains).trim();
    if (needle) {
      const name = typeof item.name === 'function' ? item.name() : item.name;
      if (!foldText(name).includes(needle)) return false;
    }
  }
  return true;
}
