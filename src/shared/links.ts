// External link generator for the item menu, plus the allowlist that guards
// every URL the app opens in the user's browser.
//
// Rebuild of NetroScript's "scrap.tf-item-information" userscript, v0.1.13
// (https://github.com/NetroScript/scrap.tf-item-information, Apache License 2.0,
// copyright NetroScript). The original read item data from the scrap.tf DOM;
// this version is driven only by LinkContext and never contacts scrap.tf. The
// backpack.tf classifieds / premium search query templates (basic and
// "Accurate"), the Steam Community Market link and the stntrading.eu naming
// are ported from it.
//
// backpack.tf naming and priceindex conventions were checked against
// tf2-item-parser (peleicht/tf2-item-parser, toBPURL/getBPPriceIndex),
// NetroScript's backpack.tf-miscellaneous-extensions (kit and fabricator stats
// links), and indexed backpack.tf / next.backpack.tf stats URLs:
//   /stats/Strange/Current Event | Scattergun (Factory New)/Tradable/Craftable
//   /stats/Decorated Weapon/Secretly Serviced | War Paint (Factory New)/Tradable/Craftable/701
//   /stats/Unique/Killstreak Kit/Tradable/Non-Craftable/3-205
//   next.backpack.tf/stats?elevatedQuality=Strange&item=Hellmet&priceindex=102&quality=Unusual
// The PriceDB item page (/item/{encodeURIComponent(sku)}) was confirmed on
// pricedb.io's own search page script.

import { CATEGORIES, KILLSTREAK_NAMES, QUALITY_NAMES, WEAR_NAMES } from './types';
import type { Category, LinkContext, LinkGroup, LinkSpec, SkuObject } from './types';
import { fromObject, fromString, looksLikeSku, normalizeSkuObject } from './sku';

// ---------------------------------------------------------------------------
// scrap.tf pages (opened by the user in their own browser, never fetched)
// ---------------------------------------------------------------------------

const SCRAPTF_PAGES: Readonly<Record<Category, string>> = Object.freeze({
  hats: 'https://scrap.tf/buy/hats',
  weapons: 'https://scrap.tf/buy/weapons',
  stranges: 'https://scrap.tf/buy/stranges',
  killstreaks: 'https://scrap.tf/buy/killstreaks',
  skins: 'https://scrap.tf/buy/skins',
  unusuals: 'https://scrap.tf/unusuals',
  // scrap.tf's "items" bank holds tools, paints, taunts, promos and australiums.
  taunts: 'https://scrap.tf/buy/items',
  other: 'https://scrap.tf/buy/items',
});

/** Static scrap.tf bank page for a category. The app only hands it to the user's browser. */
export function scraptfPageFor(category: Category): string {
  return Object.hasOwn(SCRAPTF_PAGES, category) ? SCRAPTF_PAGES[category] : SCRAPTF_PAGES.other;
}

/** Where backpack.tf shows both the access token ("Reveal") and the API key (registered there first). */
export const BPTF_API_ACCESS_URL = 'https://next.backpack.tf/account/api-access';

// ---------------------------------------------------------------------------
// URL allowlist
// ---------------------------------------------------------------------------

/**
 * Hosts the link generator builds item links for (DESIGN_BRIEF §7.3.7). Any
 * path on them may be opened (exact host, https only), except Steam's
 * linkfilter redirector.
 */
export const ALLOWED_EXTERNAL_HOSTS: readonly string[] = Object.freeze([
  'backpack.tf',
  'next.backpack.tf',
  'marketplace.tf',
  'steamcommunity.com',
  'stntrading.eu',
  'pricedb.io',
  'mannco.store',
]);

/**
 * The only other pages the app opens, matched as exact URLs: platform terms and
 * attribution (§7.5.8) and the static scrap.tf bank pages. Nothing else on
 * these hosts (a GitHub release download, for example) can be opened.
 */
export const STATIC_EXTERNAL_URLS: readonly string[] = Object.freeze([
  ...new Set([
    'https://scrap.tf/terms',
    ...Object.values(SCRAPTF_PAGES),
    'https://store.steampowered.com/subscriber_agreement/english/',
    'https://github.com/NetroScript/scrap.tf-item-information',
    'https://github.com/VeBeshka/tf2-scraptf-profit-helper',
  ]),
]);

const ALLOWED_HOST_SET: ReadonlySet<string> = new Set(ALLOWED_EXTERNAL_HOSTS);
const STATIC_URL_SET: ReadonlySet<string> = new Set(STATIC_EXTERNAL_URLS);
const MAX_URL_LENGTH = 4096;
// Plain ASCII host with an optional trailing dot and an optional explicit default port.
const AUTHORITY_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?(?::443)?$/i;

/** steamcommunity.com/linkfilter/?u= forwards to any site, so it is never opened. */
function isSteamRedirector(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decoded.toLowerCase().startsWith('/linkfilter');
}

/**
 * True when `url` is an https URL on one of ALLOWED_EXTERNAL_HOSTS (or exactly
 * one of STATIC_EXTERNAL_URLS), with no userinfo and the default port. The raw
 * string is checked as well as the parsed URL, because the OS shell or browser
 * that finally opens the link may not parse it the way WHATWG URL does
 * (backslashes, control characters, percent-encoded hosts, "user@host").
 */
export function isAllowedExternalUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  if (/[\u0000- \u007f-\u009f\\]/.test(url)) return false;
  if (!/^https:\/\//i.test(url)) return false;

  const authority = url.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (!AUTHORITY_RE.test(authority)) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.port !== '') return false;

  if (STATIC_URL_SET.has(parsed.href)) return true;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!ALLOWED_HOST_SET.has(host)) return false;
  if (host === 'steamcommunity.com' && isSteamRedirector(parsed.pathname)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Link generation
// ---------------------------------------------------------------------------

const QUALITY_UNIQUE = 6;
const QUALITY_UNUSUAL = 5;
const QUALITY_STRANGE = 11;
const QUALITY_DECORATED = 15;

/** Sanitised item facts the link builders work from. */
interface ItemView {
  o: SkuObject;
  baseName: string | null;
  effectName: string | null;
  paintkitName: string | null;
  marketHashName: string | null;
  assetId: string | null;
  /** Strange as a second quality (Strange Unusual, Strange Genuine, ...). */
  elevatedStrange: boolean;
  isSkin: boolean;
  /** Killstreak kit: killstreak tier plus a target weapon, no output item. */
  isKit: boolean;
  /** Fabricators and chemistry sets name their output instead of carrying the killstreak themselves. */
  hasOutput: boolean;
}

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

function readSkuObject(ctx: LinkContext): SkuObject | null {
  let raw: SkuObject | null = null;
  if (ctx.skuObject && typeof ctx.skuObject === 'object') raw = normalizeSkuObject(ctx.skuObject);
  else if (typeof ctx.sku === 'string' && looksLikeSku(ctx.sku)) raw = fromString(ctx.sku.trim());
  if (!raw) return null;

  const defindex = intOrNull(raw.defindex);
  const quality = intOrNull(raw.quality);
  if (defindex === null || defindex < 0 || quality === null || quality < 0) return null;

  const positive = (v: unknown): number | null => {
    const n = intOrNull(v);
    return n !== null && n > 0 ? n : null;
  };
  return {
    defindex,
    quality,
    craftable: raw.craftable !== false,
    tradable: raw.tradable !== false,
    killstreak: positive(raw.killstreak) ?? 0,
    australium: raw.australium === true,
    effect: positive(raw.effect),
    festive: raw.festive === true,
    // pk0 is a real paintkit id, so only negatives are dropped.
    paintkit: (() => {
      const n = intOrNull(raw.paintkit);
      return n !== null && n >= 0 ? n : null;
    })(),
    wear: positive(raw.wear),
    quality2: intOrNull(raw.quality2),
    craftnumber: positive(raw.craftnumber),
    crateseries: positive(raw.crateseries),
    target: positive(raw.target),
    output: positive(raw.output),
    outputQuality: positive(raw.outputQuality),
    paint: positive(raw.paint),
  };
}

function makeView(ctx: LinkContext, o: SkuObject): ItemView {
  const baseName = cleanText(ctx.baseName);
  const assetId = cleanText(ctx.assetId);
  return {
    o,
    // A schema fallback such as "5021;6" is not a usable item name.
    baseName: baseName !== null && !looksLikeSku(baseName) ? baseName : null,
    effectName: cleanText(ctx.effectName),
    paintkitName: cleanText(ctx.paintkitName),
    marketHashName: cleanText(ctx.marketHashName),
    assetId: assetId !== null && /^\d{1,20}$/.test(assetId) ? assetId : null,
    elevatedStrange: o.quality2 === QUALITY_STRANGE && o.quality !== QUALITY_STRANGE,
    isSkin: o.paintkit !== null,
    isKit: o.killstreak > 0 && o.target !== null && o.output === null,
    hasOutput: o.output !== null,
  };
}

/**
 * backpack.tf priceindex: effect for unusuals, "output-quality[-target]" for
 * fabricators and chemistry sets, "tier-target" for killstreak kits, the
 * target for strangifiers and unusualifiers, and the series for crates.
 */
export function bptfPriceindex(o: SkuObject): string | null {
  const pos = (n: number | null): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  if (pos(o.effect)) return String(o.effect);
  if (pos(o.output)) {
    const parts = [o.output, pos(o.outputQuality) ? o.outputQuality : QUALITY_UNIQUE];
    if (pos(o.target)) parts.push(o.target);
    return parts.join('-');
  }
  if (pos(o.target) && pos(o.killstreak)) return `${o.killstreak}-${o.target}`;
  if (pos(o.target)) return String(o.target);
  if (pos(o.crateseries)) return String(o.crateseries);
  return null;
}

/** Quality as backpack.tf names it on stats pages (skins are filed under Strange or Decorated Weapon). */
function bptfQualityName(v: ItemView, withElevated: boolean): string | null {
  const { o } = v;
  if (v.isSkin) {
    if (o.quality === QUALITY_STRANGE || o.quality2 === QUALITY_STRANGE) return 'Strange';
    if (o.quality === QUALITY_UNUSUAL || o.quality === QUALITY_DECORATED) return 'Decorated Weapon';
  }
  const name = QUALITY_NAMES[o.quality];
  if (!name) return null;
  return withElevated && v.elevatedStrange ? `Strange ${name}` : name;
}

function wearName(o: SkuObject): string | null | undefined {
  if (o.wear === null) return undefined;
  return WEAR_NAMES[o.wear] ?? null;
}

/** Item part of a classic stats URL: [Festivized ][Killstreak ][Skin | ][Australium ]Name[ (Wear)]. */
function bptfStatsName(v: ItemView): string | null {
  const { o } = v;
  if (!v.baseName) return null;
  // backpack.tf keeps one "Killstreak Kit" item and puts the tier in the priceindex.
  if (v.isKit) return 'Killstreak Kit';

  let name = v.baseName;
  if (o.australium) name = `Australium ${name}`;
  if (v.isSkin) {
    if (!v.paintkitName) return null;
    name = `${v.paintkitName} | ${name}`;
  }
  if (o.killstreak > 0 && !v.hasOutput) {
    const ks = KILLSTREAK_NAMES[o.killstreak];
    if (!ks) return null;
    name = `${ks} ${name}`;
  }
  if (o.festive) name = `Festivized ${name}`;
  const wear = wearName(o);
  if (wear === null) return null;
  if (wear !== undefined) name += ` (${wear})`;
  return name;
}

function bptfStatsUrl(v: ItemView): string | null {
  const quality = bptfQualityName(v, true);
  const name = bptfStatsName(v);
  if (!quality || !name) return null;
  const pi = bptfPriceindex(v.o);
  const segments = [
    'stats',
    quality,
    name,
    v.o.tradable ? 'Tradable' : 'Non-Tradable',
    v.o.craftable ? 'Craftable' : 'Non-Craftable',
  ];
  if (pi) segments.push(pi);
  return `https://backpack.tf/${segments.map(encodeURIComponent).join('/')}`;
}

/** next.backpack.tf stats, the query form marketplace.tf's own backpack.tf button uses. */
function bptfNextStatsUrl(v: ItemView): string | null {
  const { o } = v;
  if (!v.baseName) return null;
  if (v.isSkin && !v.paintkitName) return null;
  const quality = bptfQualityName(v, false);
  if (!quality) return null;

  const p = new URLSearchParams();
  p.set('item', v.baseName);
  p.set('quality', quality);
  if (v.elevatedStrange && !v.isSkin) p.set('elevatedQuality', 'Strange');
  const pi = bptfPriceindex(o);
  if (pi) p.set('priceindex', pi);
  if (o.australium) p.set('australium', '1');
  if (o.festive) p.set('festivized', '1');
  if (!o.craftable) p.set('craftable', '0');
  if (o.killstreak > 0 && !v.hasOutput) {
    if (!KILLSTREAK_NAMES[o.killstreak]) return null;
    p.set('killstreakTier', String(o.killstreak));
    p.set('sheen', '-1');
    p.set('killstreaker', '-1');
  }
  const wear = wearName(o);
  if (wear === null) return null;
  if (wear !== undefined) p.set('wearTier', wear);
  if (v.isSkin && v.paintkitName) p.set('texture', v.paintkitName);
  return `https://next.backpack.tf/stats?${p.toString()}`;
}

/**
 * NetroScript's backpackSearchQuery, fed from the SKU. Basic: item, quality,
 * australium, killstreak tier, particle and skin. Accurate adds paint, wear,
 * craftability and festivized. (Class, sheen, killstreaker and level are not
 * part of a SKU, so they are not available here.)
 */
function bptfSearchQuery(v: ItemView, accurate: boolean): string | null {
  const { o } = v;
  if (!v.baseName) return null;
  if (v.isSkin && !v.paintkitName) return null;

  const qualities = [o.quality];
  if (v.elevatedStrange) qualities.push(QUALITY_STRANGE);
  // As in the original: backpack.tf files unusual skins as Decorated Weapon, so an Unusual quality filter hides them.
  const searchQualities = v.isSkin ? qualities.filter((q) => q !== QUALITY_UNUSUAL) : qualities;

  const p = new URLSearchParams();
  p.set('item', v.baseName);
  if (searchQualities.length > 0) p.set('quality', searchQualities.join(','));
  p.set('australium', o.australium ? '1' : '-1');
  p.set('killstreak_tier', String(o.killstreak));
  if (accurate && o.paint !== null) p.set('paint', String(o.paint));
  if (o.effect !== null) p.set('particle', String(o.effect));
  if (v.isSkin && v.paintkitName) p.set('texture_name', v.paintkitName);
  if (accurate && o.wear !== null) p.set('wear_tier', String(o.wear));
  if (accurate) {
    p.set('craftable', o.craftable ? '1' : '-1');
    p.set('festivized', o.festive ? '1' : '-1');
  }
  return p.toString();
}

/** stntrading.eu name: [Non-Craftable ][Strange ][Quality ][Effect ][Festivized ][Killstreak ][Australium ][Skin ]Name[ (Wear)]. */
function stnName(v: ItemView): string | null {
  const { o } = v;
  if (!v.baseName || !o.tradable) return null;
  // Kits, fabricators, strangifiers and crate series have names STN builds differently; better no link than a wrong one.
  if (o.target !== null || o.output !== null || o.crateseries !== null) return null;

  const parts: string[] = [];
  if (!o.craftable) parts.push('Non-Craftable');
  if (v.elevatedStrange) parts.push('Strange');
  if (o.quality !== QUALITY_UNIQUE && o.quality !== QUALITY_DECORATED) {
    const q = QUALITY_NAMES[o.quality];
    if (!q) return null;
    parts.push(q);
  }
  if (o.effect !== null) {
    if (!v.effectName) return null;
    parts.push(v.effectName);
  }
  if (o.festive) parts.push('Festivized');
  if (o.killstreak > 0) {
    const ks = KILLSTREAK_NAMES[o.killstreak];
    if (!ks) return null;
    parts.push(ks);
  }
  if (o.australium) parts.push('Australium');
  if (v.isSkin) {
    if (!v.paintkitName) return null;
    parts.push(v.paintkitName);
  }
  parts.push(v.baseName);
  const wear = wearName(o);
  if (wear === null) return null;
  if (wear !== undefined) parts.push(`(${wear})`);
  return parts.join(' ');
}

/**
 * All links for one item. A link is only included when everything it needs is
 * known (for example no stats link for a skin whose paintkit name is unknown),
 * and every URL is re-checked against the allowlist.
 */
export function buildLinks(ctx: LinkContext): LinkSpec[] {
  if (!ctx || typeof ctx !== 'object') return [];
  const o = readSkuObject(ctx);
  if (!o) return [];
  const v = makeView(ctx, o);

  const links: LinkSpec[] = [];
  const add = (id: string, label: string, group: LinkGroup, url: string | null): void => {
    if (url !== null && isAllowedExternalUrl(url)) links.push({ id, label, url, group });
  };

  // backpack.tf
  add('bptf-stats', 'backpack.tf stats', 'backpack', bptfStatsUrl(v));
  add('bptf-next-stats', 'backpack.tf stats (next)', 'backpack', bptfNextStatsUrl(v));
  if (v.assetId) add('bptf-history', 'Item history', 'backpack', `https://backpack.tf/item/${v.assetId}`);
  const basic = bptfSearchQuery(v, false);
  const accurate = bptfSearchQuery(v, true);
  if (basic) add('bptf-classifieds', 'Classifieds', 'backpack', `https://backpack.tf/classifieds?${basic}`);
  if (accurate) add('bptf-classifieds-accurate', 'Classifieds (accurate)', 'backpack', `https://backpack.tf/classifieds?${accurate}`);
  if (basic) add('bptf-premium', 'Premium search', 'backpack', `https://backpack.tf/premium/search?${basic}`);
  if (accurate) add('bptf-premium-accurate', 'Premium search (accurate)', 'backpack', `https://backpack.tf/premium/search?${accurate}`);

  // Markets. marketplace.tf item pages use the v3 SKU; paint is not part of its item identity.
  const mptfSku = fromObject({ ...o, paint: null });
  if (looksLikeSku(mptfSku)) add('mptf', 'marketplace.tf', 'market', `https://marketplace.tf/items/tf2/${mptfSku}`);
  if (v.marketHashName) {
    add('scm', 'Steam Community Market', 'market', `https://steamcommunity.com/market/listings/440/${encodeURIComponent(v.marketHashName)}`);
  }
  const stn = stnName(v);
  if (stn) add('stn', 'STN Trading', 'market', `https://stntrading.eu/item/tf2/${encodeURIComponent(stn).replace(/%20/g, '+')}`);
  // scrap.tf: only the static bank page for the category, to check stock and price in the
  // user's own browser. The app itself never contacts scrap.tf (R1).
  const category = ctx.category;
  if (typeof category === 'string' && (CATEGORIES as readonly string[]).includes(category)) {
    add('scraptf-page', 'scrap.tf (category page)', 'market', scraptfPageFor(category));
  }

  // Tools. PriceDB keys its pages by the legacy-order SKU.
  const legacy = fromObject(o, true);
  if (looksLikeSku(legacy)) add('pricedb', 'PriceDB', 'tools', `https://pricedb.io/item/${encodeURIComponent(legacy)}`);

  return links;
}
