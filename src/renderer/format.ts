// Pure display helpers for the dashboard. No React, no DOM: unit tested in test/renderer.

import { isContactSafe } from '../shared/contact';
import { formatKeysMetal, formatScrap, scrapToRef } from '../shared/currency';
import { fromString } from '../shared/sku';
import type {
  Category,
  ConfidenceLevel,
  ConnState,
  HostBudget,
  InputKind,
  KeyPriceSource,
  KeyPriceState,
  OpportunityEventKind,
  OpportunityStatus,
  RuleFilter,
  Scrap,
  SkuObject,
  UnixMs,
} from '../shared/types';
import { CATEGORY_LABELS, KILLSTREAK_NAMES, QUALITY_NAMES, WEAR_NAMES } from '../shared/types';

export const DASH = '—';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Scrap shown as keys + ref when a key price is known ("2 keys 5.11 ref"). */
export function fmtMoney(scrap: Scrap | null | undefined, keyScrap: Scrap | null): string {
  return formatScrap(scrap, keyScrap && keyScrap > 0 ? keyScrap : null);
}

/** Like fmtMoney but with an explicit "+" for gains. */
export function fmtSignedMoney(scrap: Scrap | null | undefined, keyScrap: Scrap | null): string {
  if (scrap === null || scrap === undefined || !Number.isFinite(scrap)) return DASH;
  const s = fmtMoney(scrap, keyScrap);
  return scrap > 0 ? `+${s}` : s;
}

const refFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Refined only, never keys: "63.11 ref", "19,546.44 ref". */
export function fmtRefOnly(scrap: Scrap | null | undefined): string {
  if (scrap === null || scrap === undefined || !Number.isFinite(scrap)) return DASH;
  return `${refFormat.format(scrapToRef(scrap))} ref`;
}

/** Decimal key equivalent: "1.52 keys". */
export function fmtKeysDecimal(scrap: Scrap | null | undefined, keyScrap: Scrap | null): string {
  if (scrap === null || scrap === undefined || !Number.isFinite(scrap) || !keyScrap || keyScrap <= 0) return DASH;
  const k = scrap / keyScrap;
  return `${k.toFixed(2)} key${Math.abs(k - 1) < 0.005 ? '' : 's'}`;
}

/** An explicit keys + metal pair (what the user typed), not converted. */
export function fmtKeysMetal(keys: number, metalScrap: Scrap): string {
  return formatKeysMetal(keys || 0, metalScrap || 0);
}

/** Margin ratio as a percentage: 0.125 -> "12.5%". */
export function fmtPct(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return DASH;
  const pct = ratio * 100;
  // Decimals stop carrying information on very large margins.
  return `${pct.toFixed(Math.abs(pct) >= 1000 ? 0 : digits)}%`;
}

const intFormat = new Intl.NumberFormat('en-US');

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return intFormat.format(Math.round(n));
}

/** Decimal (1000-based) byte sizes, matching how the daily cap is configured. */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return DASH;
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Compact duration: "now", "42 s", "12 min", "3 h", "2 d". */
export function fmtAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  const a = Math.max(0, ms);
  if (a < 5_000) return 'now';
  if (a < 60_000) return `${Math.floor(a / 1000)} s`;
  if (a < 3_600_000) return `${Math.floor(a / 60_000)} min`;
  if (a < 86_400_000) return `${Math.floor(a / 3_600_000)} h`;
  if (a < 60 * 86_400_000) return `${Math.floor(a / 86_400_000)} d`;
  return `${Math.floor(a / (30 * 86_400_000))} mo`;
}

/** "12 min ago", "in 40 s", "just now". */
export function fmtAgo(ts: UnixMs | null | undefined, now: UnixMs): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return DASH;
  const d = now - ts;
  if (Math.abs(d) < 5_000) return 'just now';
  return d >= 0 ? `${fmtAge(d)} ago` : `in ${fmtAge(-d)}`;
}

/** "1 min 05 s", "42 s", "2 h 10 min". */
export function fmtCountdown(untilTs: UnixMs | null | undefined, now: UnixMs): string {
  if (untilTs === null || untilTs === undefined || !Number.isFinite(untilTs)) return DASH;
  const s = Math.max(0, Math.ceil((untilTs - now) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

/** Elapsed processing time: "140 ms", "1.4 s". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time "14:03:22". */
export function fmtTime(ts: UnixMs | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return DASH;
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local "2026-10-14 14:03". */
export function fmtDateTime(ts: UnixMs | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return DASH;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local "2026-10-14". */
export function fmtDate(ts: UnixMs | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return DASH;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Value for <input type="datetime-local"> in local time. */
export function toDateTimeLocal(ts: UnixMs): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Parses a datetime-local value; null when empty or invalid. */
export function fromDateTimeLocal(v: string): UnixMs | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function safeSku(sku: string): SkuObject | null {
  try {
    const o = fromString(sku);
    return Number.isFinite(o.defindex) && Number.isFinite(o.quality) ? o : null;
  } catch {
    return null;
  }
}

export function qualityOf(sku: string): number {
  return safeSku(sku)?.quality ?? 6;
}

export function qualityName(q: number): string {
  return QUALITY_NAMES[q] ?? `Quality ${q}`;
}

/** CSS class that colours an item name by quality (see styles/tokens.css). */
export function qualityClass(q: number): string {
  return QUALITY_NAMES[q] !== undefined ? `q-${q}` : 'q-6';
}

export function categoryLabel(c: Category | string): string {
  return (CATEGORY_LABELS as Record<string, string>)[c] ?? c;
}

/** Well-known unusual effects, for compact tags only; the item name stays authoritative. */
export const EFFECT_NAMES: Readonly<Record<number, string>> = {
  6: 'Green Confetti',
  7: 'Purple Confetti',
  8: 'Haunted Ghosts',
  9: 'Green Energy',
  10: 'Purple Energy',
  11: 'Circling TF Logo',
  12: 'Massed Flies',
  13: 'Burning Flames',
  14: 'Scorching Flames',
  15: 'Searing Plasma',
  16: 'Vivid Plasma',
  17: 'Sunbeams',
  18: 'Circling Peace Sign',
  19: 'Circling Heart',
  29: 'Stormy Storm',
  30: 'Blizzardy Storm',
  31: "Nuts n' Bolts",
  32: 'Orbiting Planets',
  33: 'Orbiting Fire',
  34: 'Bubbling',
  35: 'Smoking',
  36: 'Steaming',
  37: 'Flaming Lantern',
  38: 'Cloudy Moon',
  39: 'Cauldron Bubbles',
  40: 'Eerie Orbiting Fire',
  43: 'Knifestorm',
  44: 'Misty Skull',
  45: 'Harvest Moon',
  46: "It's A Secret To Everybody",
  47: 'Stormy 13th Hour',
  56: 'Kill-a-Watt',
  57: 'Terror-Watt',
  58: 'Cloud 9',
  701: 'Hot',
  702: 'Isotope',
  703: 'Cool',
  704: 'Energy Orb',
  3001: 'Showstopper',
  3003: 'Holy Grail',
  3004: "'72",
  3005: 'Fountain of Delight',
  3006: 'Screaming Tiger',
  3007: 'Skill Gotten Gains',
  3008: 'Midnight Whirlwind',
  3009: 'Silver Cyclone',
  3010: 'Mega Strike',
  3011: 'Haunted Phantasm',
  3012: 'Ghastly Ghosts',
};

/** Common paints by the RED decimal used in the SKU `p` token. */
export const PAINT_NAMES: Readonly<Record<number, string>> = {
  15185211: 'Australium Gold',
  16738740: 'Pink as Hell',
  15132390: 'An Extraordinary Abundance of Tinge',
  1315860: 'A Distinctive Lack of Hue',
  12073019: 'Team Spirit',
  3329330: 'The Bitter Taste of Defeat and Lime',
  8208497: 'A Deep Commitment to Purple',
  7511618: 'Indubitably Green',
  4345659: "Zepheniah's Greed",
  5322826: "Noble Hatter's Violet",
  14204632: 'Color No. 216-190-216',
  8289918: 'Aged Moustache Grey',
  15308410: 'Dark Salmon Injustice',
  13595446: 'Mann Co. Orange',
  12955537: 'Peculiarly Drab Tincture',
  6901050: 'Radigan Conagher Brown',
  8154199: 'Ye Olde Rustic Colour',
  2960676: 'After Eight',
  12377523: "A Mann's Mint",
  8421376: 'Drably Olive',
  4732984: "Operator's Overalls",
  11049612: 'Waterlogged Lab Coat',
  12807213: 'Cream Spirit',
  6637376: 'An Air of Debonair',
  3874595: 'Balaclavas Are Forever',
  8400928: 'The Value of Teamwork',
  10843461: 'Muskelmannbraun',
  3100495: 'A Color Similar to Slate',
  15787660: "The Color of a Gentlemann's Business Pants",
};

/** "#E7B53B" from the RED decimal. */
export function paintHex(decimal: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.round(decimal))).toString(16).padStart(6, '0').toUpperCase()}`;
}

export type ItemTagKind =
  | 'killstreak'
  | 'australium'
  | 'festive'
  | 'effect'
  | 'paint'
  | 'wear'
  | 'strange'
  | 'uncraftable'
  | 'untradable';

export interface ItemTag {
  kind: ItemTagKind;
  label: string;
  title: string;
  /** Swatch colour for paint tags. */
  color?: string;
}

const KS_SHORT: Record<number, string> = { 1: 'KS', 2: 'Spec KS', 3: 'Pro KS' };

/**
 * Small tags shown next to an item name, derived from its SKU. When the name
 * already spells out the effect, the effect tag shrinks to a star.
 */
export function itemTags(sku: string, name?: string): ItemTag[] {
  const o = safeSku(sku);
  if (!o) return [];
  const tags: ItemTag[] = [];
  if (o.effect) {
    const effect = EFFECT_NAMES[o.effect];
    const inName = !!effect && !!name && name.toLowerCase().includes(effect.toLowerCase());
    tags.push({ kind: 'effect', label: inName ? '★' : `★ ${effect ?? `#${o.effect}`}`, title: `Unusual effect ${effect ? `${effect} ` : ''}(#${o.effect})` });
  }
  if (o.quality2 === 11 && o.quality !== 11) tags.push({ kind: 'strange', label: 'Strange', title: 'Strange (elevated quality)' });
  if (o.killstreak > 0) {
    tags.push({
      kind: 'killstreak',
      label: KS_SHORT[o.killstreak] ?? `KS ${o.killstreak}`,
      title: KILLSTREAK_NAMES[o.killstreak] ?? `Killstreak tier ${o.killstreak}`,
    });
  }
  if (o.australium) tags.push({ kind: 'australium', label: 'Australium', title: 'Australium' });
  if (o.festive) tags.push({ kind: 'festive', label: 'Festive', title: 'Festivized' });
  if (o.paint) {
    const paint = PAINT_NAMES[o.paint];
    const inName = !!paint && !!name && name.toLowerCase().includes(paint.toLowerCase());
    tags.push({ kind: 'paint', label: inName ? '' : (paint ?? 'Painted'), title: `Paint: ${paint ?? paintHex(o.paint)}`, color: paintHex(o.paint) });
  }
  if (o.wear) tags.push({ kind: 'wear', label: shortWear(o.wear), title: WEAR_NAMES[o.wear] ?? `Wear ${o.wear}` });
  if (!o.craftable) tags.push({ kind: 'uncraftable', label: 'Uncraft', title: 'Non-Craftable' });
  if (!o.tradable) tags.push({ kind: 'untradable', label: 'Untradable', title: 'Not tradable' });
  return tags;
}

function shortWear(w: number): string {
  return ({ 1: 'FN', 2: 'MW', 3: 'FT', 4: 'WW', 5: 'BS' } as Record<number, string>)[w] ?? `W${w}`;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** Same thresholds as the engine (brief §5.7): High >= 70, Medium 45-69, Low < 45. */
export function confidenceLevelOf(score: number): ConfidenceLevel {
  if (score >= 70) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

export const STATUS_LABELS: Record<OpportunityStatus, string> = {
  profitable: 'Profitable',
  'below-threshold': 'Below threshold',
  unprofitable: 'Unprofitable',
  'no-buyers': 'No buyers',
};

export const INPUT_KIND_LABELS: Record<InputKind, string> = {
  user: 'Typed price',
  import: 'Imported page',
  rule: 'Rule estimate',
};

export const EVENT_KIND_LABELS: Record<OpportunityEventKind, string> = {
  appeared: 'Appeared',
  changed: 'Changed',
  gone: 'Gone',
  notified: 'Notified',
};

export const KEY_SOURCE_LABELS: Record<KeyPriceSource | 'default', string> = {
  bptf: 'backpack.tf',
  pricedb: 'PriceDB',
  manual: 'Manual',
  default: 'Default',
};

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'muted';

export const CONN_STATE_LABELS: Record<ConnState, string> = {
  off: 'Off',
  connecting: 'Connecting',
  live: 'Live',
  idle: 'Idle',
  backoff: 'Backing off',
  error: 'Error',
  paused: 'Paused',
  blocked: 'Blocked',
};

export function connTone(state: ConnState): Tone {
  switch (state) {
    case 'live':
      return 'good';
    case 'idle':
      return 'info';
    case 'connecting':
    case 'backoff':
    case 'paused':
      return 'warn';
    case 'error':
    case 'blocked':
      return 'bad';
    default:
      return 'muted';
  }
}

export interface FlagInfo {
  label: string;
  help: string;
  tone: Tone;
}

const FLAGS: Record<string, FlagInfo> = {
  // order flags
  outlier: { label: 'Outlier', help: 'Much higher than the other orders or the reference price, so it is not used as the conservative price.', tone: 'warn' },
  'notes-flag': { label: 'Note flag', help: "The buyer's note mentions paint, spells, parts, dupes or 'only'. They may reject your copy.", tone: 'warn' },
  'attribute-specific': { label: 'Specific', help: 'Asks for a specific paint, spell, part, sheen or name. Your copy does not have it (or its extras are unknown), so it is excluded.', tone: 'bad' },
  'has-extras': { label: 'Has extras', help: 'Your copy has extras (paint, spells) but this order is generic. It still matches, but you may be underselling.', tone: 'warn' },
  unverified: { label: 'Unverified', help: 'Not confirmed by the live feed or a snapshot for over 24 hours.', tone: 'warn' },
  banned: { label: 'Banned', help: 'The buyer is banned on backpack.tf. Excluded.', tone: 'bad' },
  marketplace: { label: 'Marketplace', help: 'Mirrored from marketplace.tf and priced in USD. Never used as an exit.', tone: 'bad' },
  blocklisted: { label: 'Blocklisted', help: 'The buyer is on your blocklist (Settings). Excluded.', tone: 'bad' },
  duplicate: { label: 'Duplicate', help: 'An older order from the same buyer for the same item. Only their newest order counts.', tone: 'muted' },
  'not-buy-order': { label: 'Not a buy order', help: 'A sell listing, shown for context. Never used as an exit.', tone: 'muted' },
  'any-effect': {
    label: 'Any effect',
    help: 'A generic "Unusual <item>" buy order with no effect named: it accepts any effect, including yours. Your effect may be worth more.',
    tone: 'info',
  },
  // opportunity flags
  'all-outliers': { label: 'All outliers', help: 'Every eligible order looks unrealistically high, so no revenue is assumed. Check the orders by hand.', tone: 'warn' },
  'background-check': {
    label: 'Background check',
    help: 'Worth over 15 keys. Check the buyer on backpack.tf and marketplace.tf for bans before trading.',
    tone: 'warn',
  },
  'outlier-best': { label: 'Outlier best', help: 'The best order is an outlier; profit uses the next realistic order.', tone: 'warn' },
  'unusual-risk': { label: 'Unusual risk', help: 'Unusual worth over the risk threshold. Steam warns about price-manipulated unusuals and reversed trades: get a background check.', tone: 'bad' },
  'stale-input': { label: 'Stale price', help: 'Your scrap.tf price is old. Check the current price on scrap.tf before acting.', tone: 'warn' },
  'no-reference': { label: 'No reference', help: 'No PriceDB or backpack.tf community price to sanity-check the orders.', tone: 'warn' },
  'rule-estimate': { label: 'Rule estimate', help: 'Cost comes from a price-sheet rule, not a price you saw for this item. Check scrap.tf stock and price by hand.', tone: 'info' },
  'unverified-orders': { label: 'Unverified orders', help: 'The orders used have not been confirmed recently.', tone: 'warn' },
};

export function flagInfo(flag: string): FlagInfo {
  const known = FLAGS[flag];
  if (known) return known;
  const label = flag.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return { label, help: label, tone: 'muted' };
}

/** Key price for the top bar: "63.11 ref", source and age. */
export function keyPriceSummary(kp: KeyPriceState | null | undefined, now: UnixMs): {
  value: string;
  source: string;
  age: string;
  stale: boolean;
} {
  if (!kp) return { value: DASH, source: 'unknown', age: DASH, stale: true };
  return {
    value: fmtRefOnly(kp.valueScrap),
    source: KEY_SOURCE_LABELS[kp.source] ?? kp.source,
    age: kp.observedAt ? fmtAge(now - kp.observedAt) : DASH,
    stale: kp.stale,
  };
}

/** Plain-language summary of a price-sheet rule filter. */
export function describeRuleFilter(f: RuleFilter): string {
  const parts: string[] = [];
  if (f.categories?.length) parts.push(f.categories.map((c) => categoryLabel(c)).join(' or '));
  if (f.qualities?.length) parts.push(f.qualities.map((q) => qualityName(q)).join(' or '));
  if (f.craftable === true) parts.push('craftable');
  if (f.craftable === false) parts.push('non-craftable');
  if (f.australium === true) parts.push('australium');
  if (f.australium === false) parts.push('not australium');
  if (f.killstreak?.length) parts.push(f.killstreak.map((k) => (k === 0 ? 'no killstreak' : (KILLSTREAK_NAMES[k] ?? `killstreak ${k}`).toLowerCase())).join(' or '));
  if (f.hasEffect === true) parts.push('with an unusual effect');
  if (f.hasEffect === false) parts.push('no unusual effect');
  if (f.defindexes?.length) parts.push(`defindex ${f.defindexes.join(', ')}`);
  if (f.nameContains?.trim()) parts.push(`name contains "${f.nameContains.trim()}"`);
  return parts.length ? parts.join(' · ') : 'Every item';
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Strips Electron's "Error invoking remote method 'rpc': Error: " wrapper. */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : (() => {
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  })();
  return raw.replace(/^Error invoking remote method '[^']*':\s*/i, '').replace(/^(?:[A-Za-z]*Error:\s*)+/, '').trim() || 'Unknown error';
}

/** Splits a blocklist textarea into 17-digit SteamID64s and rejects the rest. */
export function parseSteamIdList(text: string): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s,;]+/)) {
    const t = token.trim();
    if (!t) continue;
    if (/^7656\d{13}$/.test(t)) {
      if (!seen.has(t)) {
        seen.add(t);
        ids.push(t);
      }
    } else {
      invalid.push(t);
    }
  }
  return { ids, invalid };
}

/**
 * Budget ids for hosts no connector in this version contacts. The net layer
 * keeps their limits (and the policy their allowlist entries) for future
 * connectors; listing them on Data health would suggest the app talks to them.
 */
export const UNUSED_BUDGET_IDS: ReadonlySet<string> = new Set(['steam-webapi', 'mannco', 'mannco-prices', 'mannco-login', 'mptf', 'stn']);

/** Budgets worth showing: every one in use, plus any unused one that somehow saw traffic or a pause. */
export function visibleBudgets<T extends HostBudget>(budgets: readonly T[]): T[] {
  return budgets.filter((b) => !UNUSED_BUDGET_IDS.has(b.id ?? '') || b.usedLastHour > 0 || b.pausedUntil !== null || b.consecutive429 > 0);
}

/**
 * Why an item cannot be refreshed from a backpack.tf snapshot, checked in the
 * order the service's 'item.refresh' checks. `settings` is true when the user
 * can fix it in Settings.
 */
export function snapshotUnavailableReason(
  secrets: { bptfAccessToken: boolean } | null,
  settings: { connectors: { bptfApi: boolean } } | null,
): { text: string; settings: boolean } {
  if (secrets && !secrets.bptfAccessToken) return { text: 'Refreshing needs your backpack.tf access token; until then buy orders come from the live feed only.', settings: true };
  if (settings && !settings.connectors.bptfApi) return { text: 'The backpack.tf API is turned off in Settings; buy orders come from the live feed only.', settings: true };
  return { text: 'Snapshots are unavailable right now; buy orders come from the live feed only.', settings: false };
}

/**
 * Contact for the User-Agent: an https URL or a mailto: address that also
 * passes main's User-Agent rule (printable ASCII, no spaces or parentheses,
 * at most 200 characters), so the page never accepts what main rejects.
 */
export function isValidContactUrl(s: string): boolean {
  const t = s.trim();
  if (!t || !isContactSafe(t)) return false;
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(t)) return true;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' && !!u.hostname && u.hostname.includes('.') && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Electron accelerator to the label Windows users expect: "Ctrl+Alt+F". */
export function accelLabel(accel: string): string {
  return accel
    .split('+')
    .map((p) => (/^(CommandOrControl|CmdOrCtrl|Control|Ctrl)$/i.test(p) ? 'Ctrl' : /^(Command|Cmd|Super|Meta)$/i.test(p) ? 'Win' : p))
    .join('+');
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Truncates long buyer notes for table cells. */
export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}
