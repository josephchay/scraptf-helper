// Deterministic fake data for running the dashboard in a plain browser.
// Development only: none of these prices, buyers or listings are real.

import { bankStockSpecialKey, marketNewSideMatches } from '../shared/bankStock';
import { frictionOf, maxCostFor } from '../shared/ceiling';
import { parsePrice, refToScrap, formatScrap, type ParsedPrice } from '../shared/currency';
import { bankForCategory, scraptfLinkFor, scraptfPageFor, type ScraptfSeen } from '../shared/links';
import {
  emptyMarketCounts,
  marketBuySideMatches,
  marketComparator,
  marketPage,
  marketProfit,
  marketSearchTokens,
  marketUserSideMatches,
  marketVerdict,
} from '../shared/market';
import type { HoldingBuySide } from '../shared/holdings';
import { communityMaxAgeMs } from '../shared/referenceAge';
import { marketListedSideMatches } from '../shared/scraptfHistory';
import { marketListFields, marketListSideMatches } from '../shared/scraptfList';
import { baseSku, fromString } from '../shared/sku';
import { CATEGORIES, CATEGORY_LABELS, CURRENCY_SKUS, KEY_SKU } from '../shared/types';
import type {
  BankStockStored,
  BulkPriceRow,
  Category,
  ConfidenceLevel,
  HistoryPoint,
  InputKind,
  ItemRevenue,
  JournalEntry,
  JournalSummary,
  KeyPriceState,
  LinkSpec,
  MarketQuery,
  MarketRow,
  MarketVerdict,
  Opportunity,
  OrderSummary,
  PriceRule,
  PriceRuleInput,
  ReferencePrices,
  ResolvedItem,
  RuleFilter,
  Scrap,
  ScrapPrice,
  ScraptfBank,
  ScraptfListRow,
  ScraptfListStored,
  Settings,
  ShoppingListResult,
  ShoppingQuery,
  ShoppingRow,
  SpecialAttrs,
  UnixMs,
} from '../shared/types';
import { confidenceLevelOf } from './format';
import { matchesSearch, revenueOrderOf, statusFor, tierForProfit } from './oppModel';

export const MOCK_KEY_SCRAP = 568; // 63.11 ref

// ---------------------------------------------------------------------------
// Seeded random numbers
// ---------------------------------------------------------------------------

export interface Rng {
  next(): number;
  int(lo: number, hi: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)]!,
    chance: (p) => next() < p,
  };
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CatalogItem {
  sku: string;
  name: string;
  category: Category;
  /** Typical backpack.tf buy-order value in scrap. */
  value: Scrap;
}

const K = MOCK_KEY_SCRAP;
const r = (ref: number) => refToScrap(ref);
const k = (keys: number, ref = 0) => Math.round(keys * K) + refToScrap(ref);

/** Items with an order book in the mock. */
export const CATALOG: readonly CatalogItem[] = [
  // hats & cosmetics
  { sku: '378;6', name: 'Team Captain', category: 'hats', value: k(1, 22) },
  { sku: '126;6', name: "Bill's Hat", category: 'hats', value: k(1, 5.33) },
  { sku: '94;6', name: 'Texas Ten Gallon', category: 'hats', value: r(1.66) },
  { sku: '105;6', name: 'Brigade Helm', category: 'hats', value: r(1.77) },
  { sku: '52;6', name: "Batter's Helmet", category: 'hats', value: r(1.55) },
  { sku: '143;6', name: 'Earbuds', category: 'hats', value: k(1, 40) },
  { sku: '162;6', name: "Max's Severed Head", category: 'hats', value: k(2, 10) },
  { sku: '30177;6', name: 'Hong Kong Cone', category: 'hats', value: k(14) },
  { sku: '30357;6', name: 'Dark Falkirk Helm', category: 'hats', value: r(1.66) },
  { sku: '316;6', name: "Pyromancer's Mask", category: 'hats', value: r(1.77) },
  { sku: '387;6', name: 'Sight for Sore Eyes', category: 'hats', value: r(1.55) },
  { sku: '30140;6', name: 'Virtual Viewfinder', category: 'hats', value: r(1.44) },
  { sku: '30473;6', name: 'MK 50', category: 'hats', value: r(1.66) },
  { sku: '378;6;p15185211', name: 'Team Captain (Paint: Australium Gold)', category: 'hats', value: k(1, 22) },
  { sku: '94;6;p16738740', name: 'Texas Ten Gallon (Paint: Pink as Hell)', category: 'hats', value: r(2.55) },
  { sku: '52;3', name: "Vintage Batter's Helmet", category: 'hats', value: r(5.33) },
  { sku: '94;3', name: 'Vintage Texas Ten Gallon', category: 'hats', value: r(4.66) },
  { sku: '666;1', name: 'Genuine Hat of Undeniable Wealth And Respect', category: 'hats', value: r(4.11) },
  { sku: '583;13', name: 'Haunted Bombinomicon', category: 'hats', value: r(3.88) },
  { sku: '30096;6;uncraftable', name: 'Non-Craftable Das Feelinbeterbager', category: 'hats', value: r(0.88) },
  // unusuals
  { sku: '378;5;u13', name: 'Burning Flames Team Captain', category: 'unusuals', value: k(310) },
  { sku: '378;5;u17', name: 'Sunbeams Team Captain', category: 'unusuals', value: k(165) },
  { sku: '52;5;u10', name: "Purple Energy Batter's Helmet", category: 'unusuals', value: k(58) },
  { sku: '30357;5;u702', name: 'Isotope Dark Falkirk Helm', category: 'unusuals', value: k(24) },
  { sku: '94;5;u12', name: 'Massed Flies Texas Ten Gallon', category: 'unusuals', value: k(17) },
  { sku: '105;5;u33', name: 'Orbiting Fire Brigade Helm', category: 'unusuals', value: k(29) },
  { sku: '30177;5;u14', name: 'Scorching Flames Hong Kong Cone', category: 'unusuals', value: k(210) },
  { sku: '30140;5;u38', name: 'Cloudy Moon Virtual Viewfinder', category: 'unusuals', value: k(21) },
  { sku: '387;5;u35', name: 'Smoking Sight for Sore Eyes', category: 'unusuals', value: k(13) },
  { sku: '30473;5;u704', name: 'Energy Orb MK 50', category: 'unusuals', value: k(34) },
  { sku: '316;5;u9', name: "Green Energy Pyromancer's Mask", category: 'unusuals', value: k(48) },
  // weapons & items
  { sku: '35;6', name: 'Kritzkrieg', category: 'weapons', value: 2 },
  { sku: '37;6', name: 'Ubersaw', category: 'weapons', value: 2 },
  { sku: '416;6', name: 'Market Gardener', category: 'weapons', value: 2 },
  { sku: '357;6', name: 'Half-Zatoichi', category: 'weapons', value: 1 },
  { sku: '225;6', name: 'Your Eternal Reward', category: 'weapons', value: 2 },
  { sku: '61;6', name: 'Ambassador', category: 'weapons', value: 2 },
  { sku: '998;6', name: 'Vaccinator', category: 'weapons', value: 1 },
  { sku: '1151;6', name: 'Iron Bomber', category: 'weapons', value: 2 },
  { sku: '357;6;uncraftable', name: 'Non-Craftable Half-Zatoichi', category: 'weapons', value: 1 },
  { sku: '349;1', name: 'Genuine Sun-on-a-Stick', category: 'weapons', value: r(1.22) },
  { sku: '37;14', name: "Collector's Ubersaw", category: 'weapons', value: k(2, 30) },
  // stranges
  { sku: '200;11', name: 'Strange Scattergun', category: 'stranges', value: r(3.11) },
  { sku: '202;11', name: 'Strange Minigun', category: 'stranges', value: r(3.66) },
  { sku: '211;11', name: 'Strange Medi Gun', category: 'stranges', value: r(3.33) },
  { sku: '194;11', name: 'Strange Knife', category: 'stranges', value: r(6.11) },
  { sku: '201;11', name: 'Strange Sniper Rifle', category: 'stranges', value: r(3.22) },
  { sku: '228;11', name: 'Strange Black Box', category: 'stranges', value: r(4.44) },
  { sku: '127;11', name: 'Strange Direct Hit', category: 'stranges', value: r(3.88) },
  { sku: '205;11;australium', name: 'Strange Australium Rocket Launcher', category: 'stranges', value: k(27, 10) },
  { sku: '202;11;australium', name: 'Strange Australium Minigun', category: 'stranges', value: k(37) },
  { sku: '200;11;australium', name: 'Strange Australium Scattergun', category: 'stranges', value: k(22, 30) },
  { sku: '205;11;festive', name: 'Strange Festivized Rocket Launcher', category: 'stranges', value: r(12.33) },
  // killstreaks
  { sku: '228;6;kt-2', name: 'Specialized Killstreak Black Box', category: 'killstreaks', value: r(8.22) },
  { sku: '37;6;kt-1', name: 'Killstreak Ubersaw', category: 'killstreaks', value: r(2.11) },
  { sku: '61;6;kt-3', name: 'Professional Killstreak Ambassador', category: 'killstreaks', value: k(1, 12) },
  { sku: '202;11;kt-3', name: 'Strange Professional Killstreak Minigun', category: 'killstreaks', value: k(2, 20) },
  { sku: '211;11;kt-2', name: 'Strange Specialized Killstreak Medi Gun', category: 'killstreaks', value: r(19.55) },
  { sku: '200;11;australium;kt-3', name: 'Strange Professional Killstreak Australium Scattergun', category: 'killstreaks', value: k(54) },
  { sku: '205;11;kt-1', name: 'Strange Killstreak Rocket Launcher', category: 'killstreaks', value: r(6.66) },
  // skins & war paints
  { sku: '15141;15;w2;pk300', name: 'Warhawk Rocket Launcher (Minimal Wear)', category: 'skins', value: r(8.44) },
  { sku: '15141;15;w1;pk300;strange', name: 'Strange Warhawk Rocket Launcher (Factory New)', category: 'skins', value: k(1, 25) },
  { sku: '15013;15;w4;pk166', name: 'Night Terror Scattergun (Well-Worn)', category: 'skins', value: r(3.22) },
  { sku: '15089;15;w3;pk214', name: 'Balloonicorn Flame Thrower (Field-Tested)', category: 'skins', value: r(5.77) },
  { sku: '15151;15;w2;pk200;kt-3', name: 'Professional Killstreak Iron Wood Minigun (Minimal Wear)', category: 'skins', value: k(1, 5) },
  { sku: '15141;15;u701;w1;pk300;strange', name: 'Strange Hot Warhawk Rocket Launcher (Factory New)', category: 'skins', value: k(41) },
  // taunts
  { sku: '1118;6', name: 'Taunt: Conga', category: 'taunts', value: r(12.11) },
  { sku: '1157;6', name: 'Taunt: Kazotsky Kick', category: 'taunts', value: r(5.44) },
  { sku: '1110;6', name: 'Taunt: Rock, Paper, Scissors', category: 'taunts', value: r(28.66) },
  { sku: '1106;6', name: 'Taunt: Square Dance', category: 'taunts', value: r(9.33) },
  { sku: '1162;6', name: 'Taunt: Mannrobics', category: 'taunts', value: r(4.22) },
  { sku: '1118;5;u3003', name: 'Holy Grail Taunt: Conga', category: 'taunts', value: k(176) },
  { sku: '1157;5;u3011', name: 'Haunted Phantasm Taunt: Kazotsky Kick', category: 'taunts', value: k(61) },
  // other
  { sku: '725;6', name: 'Tour of Duty Ticket', category: 'other', value: r(42.33) },
  { sku: '5020;6', name: 'Name Tag', category: 'other', value: r(5.22) },
  { sku: '5044;6', name: 'Description Tag', category: 'other', value: r(3.66) },
  { sku: '5050;6', name: 'Backpack Expander', category: 'other', value: r(10.44) },
  { sku: '5037;6', name: 'Paint Can: Australium Gold', category: 'other', value: r(7.88) },
];

/** Names the item search knows about without an order book (yields "no buyers"). */
export const EXTRA_NAMES: readonly CatalogItem[] = [
  { sku: '30359;6', name: 'Juggernaut Jacket', category: 'hats', value: 0 },
  { sku: '30309;6', name: 'Dead of Night', category: 'hats', value: 0 },
  { sku: '30397;6', name: 'Bruiser\'s Bandanna', category: 'hats', value: 0 },
  { sku: '228;6', name: 'Black Box', category: 'weapons', value: 0 },
  { sku: '127;6', name: 'Direct Hit', category: 'weapons', value: 0 },
  { sku: '56;11', name: 'Strange Huntsman', category: 'stranges', value: 0 },
  { sku: '208;11', name: 'Strange Flame Thrower', category: 'stranges', value: 0 },
  { sku: '1182;6', name: 'Taunt: Yeti Punch', category: 'taunts', value: 0 },
  { sku: '5021;6', name: 'Mann Co. Supply Crate Key', category: 'other', value: 0 },
];

/** Small deterministic hash, so generated mock values do not depend on any RNG sequence. */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

const MARKET_EFFECTS: readonly [number, string, number][] = [
  // [effect id, name, price factor]
  [6, 'Green Confetti', 0.6],
  [7, 'Purple Confetti', 0.6],
  [8, 'Haunted Ghosts', 1.2],
  [9, 'Green Energy', 1],
  [10, 'Purple Energy', 1.1],
  [11, 'Circling TF Logo', 0.9],
  [12, 'Massed Flies', 0.5],
  [13, 'Burning Flames', 3.5],
  [14, 'Scorching Flames', 2.2],
  [17, 'Sunbeams', 2.4],
  [29, 'Stormy Storm', 1],
  [33, 'Orbiting Fire', 0.8],
  [34, 'Bubbling', 0.7],
  [35, 'Smoking', 0.6],
  [38, 'Cloudy Moon', 1.3],
  [702, 'Isotope', 0.8],
  [704, 'Energy Orb', 1.4],
];
const MARKET_HATS: readonly [number, string][] = [
  [378, 'Team Captain'],
  [94, 'Texas Ten Gallon'],
  [105, 'Brigade Helm'],
  [52, "Batter's Helmet"],
  [30357, 'Dark Falkirk Helm'],
  [316, "Pyromancer's Mask"],
  [387, 'Sight for Sore Eyes'],
  [30140, 'Virtual Viewfinder'],
  [30473, 'MK 50'],
  [30177, 'Hong Kong Cone'],
];
const MARKET_WEAPONS: readonly [number, string][] = [
  [35, 'Kritzkrieg'],
  [37, 'Ubersaw'],
  [416, 'Market Gardener'],
  [357, 'Half-Zatoichi'],
  [225, 'Your Eternal Reward'],
  [61, 'Ambassador'],
  [998, 'Vaccinator'],
  [1151, 'Iron Bomber'],
];

/**
 * Items only the Live market sees: buyers on backpack.tf but no price of yours, which is
 * most of the real market. Generated without an RNG so the seeded mock stays as it was.
 */
export const MARKET_ONLY: readonly CatalogItem[] = (() => {
  const taken = new Set(CATALOG.map((c) => c.sku));
  const out: CatalogItem[] = [];
  const add = (item: CatalogItem) => {
    if (taken.has(item.sku)) return;
    taken.add(item.sku);
    out.push(item);
  };
  for (const [defindex, hat] of MARKET_HATS) {
    for (const [effect, name, factor] of MARKET_EFFECTS) {
      const sku = `${defindex};5;u${effect}`;
      add({ sku, name: `${name} ${hat}`, category: 'unusuals', value: k(Math.max(6, Math.round((10 + (hashOf(sku) % 60)) * factor))) });
    }
  }
  for (const [defindex, weapon] of MARKET_WEAPONS) {
    const strange = `${defindex};11`;
    add({ sku: strange, name: `Strange ${weapon}`, category: 'stranges', value: r(2 + (hashOf(strange) % 30) / 10) });
    const tiers: [number, string, Scrap][] = [
      [1, 'Killstreak', r(1.5 + (hashOf(`${defindex}k1`) % 15) / 10)],
      [2, 'Specialized Killstreak', r(4 + (hashOf(`${defindex}k2`) % 50) / 10)],
      [3, 'Professional Killstreak', k(1 + (hashOf(`${defindex}k3`) % 3), hashOf(`${defindex}k3r`) % 40)],
    ];
    for (const [kt, prefix, value] of tiers) add({ sku: `${defindex};6;kt-${kt}`, name: `${prefix} ${weapon}`, category: 'killstreaks', value });
  }
  return out;
})();

export function findCatalogItem(sku: string): CatalogItem | null {
  return CATALOG.find((c) => c.sku === sku) ?? EXTRA_NAMES.find((c) => c.sku === sku) ?? MARKET_ONLY.find((c) => c.sku === sku) ?? null;
}

export function allSearchable(): CatalogItem[] {
  return [...CATALOG, ...EXTRA_NAMES, ...MARKET_ONLY];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export function ruleMatches(filter: RuleFilter, item: Pick<CatalogItem, 'sku' | 'name' | 'category'>): boolean {
  const o = fromString(item.sku);
  if (filter.categories?.length && !filter.categories.includes(item.category)) return false;
  if (filter.qualities?.length && !filter.qualities.includes(o.quality)) return false;
  if (filter.craftable !== undefined && filter.craftable !== null && o.craftable !== filter.craftable) return false;
  if (filter.australium !== undefined && filter.australium !== null && o.australium !== filter.australium) return false;
  if (filter.killstreak?.length && !filter.killstreak.includes(o.killstreak)) return false;
  if (filter.hasEffect !== undefined && filter.hasEffect !== null && (o.effect !== null) !== filter.hasEffect) return false;
  if (filter.defindexes?.length && !filter.defindexes.includes(o.defindex)) return false;
  if (filter.nameContains && !item.name.toLowerCase().includes(filter.nameContains.toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Order books
// ---------------------------------------------------------------------------

export interface MockBook {
  item: CatalogItem;
  buy: OrderSummary[];
  sell: OrderSummary[];
  references: ReferencePrices;
  history: HistoryPoint[];
  /** Bot pulse ages and confirmations used by the confidence model. */
  meta: Map<string, { pulseAgeMs: number | null }>;
  snapshotAt: UnixMs | null;
}

const BOT_NAMES = ['Metal Bank Bot', 'Hat Hoarder Bot', 'Quickbuy 24/7', 'Pure Buyer Bot', 'Crafty Bot', 'Steady Trades Bot'];
const HUMAN_NAMES = ['Alex', 'mossy', 'Dr. Pyrite', 'kettle', 'Sunday Medic', 'quietcollector', 'Ren', 'Hoovy main', 'lilac', 'Fenwick'];
const BOT_NOTES = [
  'Buying for {p}! Send me a trade offer, I accept instantly 24/7.',
  'Automated buyer. Offers only. Paying {p}.',
  'Buying at {p}. Bot accepts offers instantly.',
];
const HUMAN_NOTES = [
  'Paying {p}, add me or send an offer.',
  'Buying clean only, no painted or spelled copies.',
  'Offers welcome. Pure on hand.',
  'Only buying with spells. Paying {p}.',
  'Want this for my loadout, {p}.',
  '',
];

function splitValue(v: Scrap): { keys: number; metalScrap: Scrap } {
  if (v < K) return { keys: 0, metalScrap: v };
  const keys = Math.floor(v / K);
  return { keys, metalScrap: v - keys * K };
}

/** Fake 17-digit ids in the mock range; never shown as profile links. */
function mockSteamId(n: number): string {
  return `7656119800${String(1000000 + n).slice(-7)}`;
}

function makeOrder(rng: Rng, idx: number, value: Scrap, now: UnixMs, opts: { isBot: boolean; flags: string[]; eligible: boolean }): OrderSummary {
  const { keys, metalScrap } = splitValue(value);
  const notes = opts.isBot ? BOT_NOTES : HUMAN_NOTES;
  let details = rng.pick(notes).replace('{p}', formatScrap(value, K));
  if (opts.flags.includes('attribute-specific')) details = 'Buying ONLY painted Team Spirit copies.';
  if (opts.flags.includes('notes-flag') && !/only|paint|spell/i.test(details)) details = 'Clean only, no dupes. Paying ' + formatScrap(value, K);
  return {
    listingId: `mock-${idx}`,
    steamid: mockSteamId(idx),
    userName: opts.isBot ? rng.pick(BOT_NAMES) : rng.pick(HUMAN_NAMES),
    keys,
    metalScrap,
    valueScrap: value,
    isBot: opts.isBot,
    online: opts.isBot ? true : rng.chance(0.15) ? null : rng.chance(0.55),
    lastEventAt: now - rng.int(30_000, opts.flags.includes('unverified') ? 40 * 3_600_000 : 5 * 3_600_000),
    bumpedAt: Math.floor((now - rng.int(60_000, 6 * 3_600_000)) / 1000),
    details,
    flags: opts.flags,
    eligible: opts.eligible,
  };
}

let orderSeq = 1;

export function makeBook(rng: Rng, item: CatalogItem, now: UnixMs, noBuyers = false): MockBook {
  const buy: OrderSummary[] = [];
  const meta = new Map<string, { pulseAgeMs: number | null }>();
  const v = Math.max(1, item.value);
  if (!noBuyers && item.value > 0) {
    const n = rng.int(1, 8);
    let cur = Math.round(v * (1 + rng.next() * 0.06));
    for (let i = 0; i < n; i++) {
      const isBot = rng.chance(0.45);
      const flags: string[] = [];
      if (rng.chance(0.12)) flags.push('notes-flag');
      if (rng.chance(0.08)) flags.push('unverified');
      const o = makeOrder(rng, orderSeq++, Math.max(1, cur), now, { isBot, flags, eligible: true });
      buy.push(o);
      meta.set(o.listingId, { pulseAgeMs: isBot ? rng.int(60_000, rng.chance(0.8) ? 25 * 60_000 : 4 * 3_600_000) : null });
      cur = Math.round(cur * (1 - rng.next() * 0.05)) - (v < 40 ? rng.int(0, 1) : 0);
    }
    // Occasional outlier on top of the book.
    if (n >= 3 && rng.chance(0.18)) {
      const top = buy[0]!;
      const out = makeOrder(rng, orderSeq++, Math.round(top.valueScrap * (1.45 + rng.next() * 0.4)), now, { isBot: false, flags: ['outlier'], eligible: true });
      buy.unshift(out);
      meta.set(out.listingId, { pulseAgeMs: null });
    }
    // Orders shown for context but excluded from profit.
    const excludedKinds = ['attribute-specific', 'marketplace', 'banned', 'blocklisted'];
    const excluded = rng.chance(0.35) ? rng.int(1, 2) : 0;
    for (let i = 0; i < excluded; i++) {
      const flag = rng.pick(excludedKinds);
      const o = makeOrder(rng, orderSeq++, Math.round(v * (1.02 + rng.next() * 0.25)), now, { isBot: flag === 'marketplace', flags: [flag], eligible: false });
      buy.push(o);
      meta.set(o.listingId, { pulseAgeMs: null });
    }
    buy.sort((a, b) => b.valueScrap - a.valueScrap);
  }

  const sell: OrderSummary[] = [];
  const sellCount = item.value > 0 ? rng.int(0, 4) : 0;
  for (let i = 0; i < sellCount; i++) {
    const o = makeOrder(rng, orderSeq++, Math.round(v * (1.08 + rng.next() * 0.3)), now, { isBot: rng.chance(0.6), flags: [], eligible: true });
    o.details = o.isBot ? 'Selling, instant accept. Send an offer.' : 'Selling, add me.';
    sell.push(o);
  }
  sell.sort((a, b) => a.valueScrap - b.valueScrap);

  const hasRef = item.value > 0 && rng.chance(0.85);
  const references: ReferencePrices = {
    pricedb: hasRef
      ? (() => {
          const ageMs = rng.chance(0.2) ? rng.int(31, 120) * 86_400_000 : rng.int(10, 600) * 60_000;
          return {
            buyScrap: Math.round(v * (0.92 + rng.next() * 0.12)),
            sellScrap: Math.round(v * (1.04 + rng.next() * 0.12)),
            time: Math.floor((now - ageMs) / 1000),
            ageMs,
          };
        })()
      : null,
    community: item.value > 0 && rng.chance(0.6)
      ? {
          valueScrap: Math.round(v * (0.95 + rng.next() * 0.15)),
          valueHighScrap: rng.chance(0.5) ? Math.round(v * (1.1 + rng.next() * 0.15)) : null,
          lastUpdate: Math.floor((now - rng.int(1, 60) * 86_400_000) / 1000),
        }
      : null,
  };

  const history: HistoryPoint[] = [];
  if (item.value > 0) {
    let buyV = v * (0.85 + rng.next() * 0.2);
    const days = 90;
    for (let d = days; d >= 0; d -= rng.int(1, 3)) {
      buyV = Math.max(1, buyV * (1 + (rng.next() - 0.48) * 0.05));
      history.push({
        t: Math.floor((now - d * 86_400_000) / 1000),
        buyScrap: Math.round(buyV),
        sellScrap: Math.round(buyV * (1.06 + rng.next() * 0.05)),
      });
    }
  }

  return { item, buy, sell, references, history, meta, snapshotAt: rng.chance(0.5) ? now - rng.int(5, 600) * 60_000 : null };
}

// ---------------------------------------------------------------------------
// Opportunity evaluation (a small stand-in for the service engine)
// ---------------------------------------------------------------------------

export interface MockInput {
  kind: InputKind;
  ref: string;
  costKeys: number;
  costScrapRaw: Scrap;
  observedAt: UnixMs;
  special: SpecialAttrs | null;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

const DAY_MS = 86_400_000;
/** Highest Low score (MEDIUM_CONFIDENCE - 1 in the service's tiers.ts). */
const LOW_CAP = 44;

/** References older than profit.referenceMaxAgeMs count as absent (F4), with the reason shown to the user. */
export function usableReferences(
  refs: ReferencePrices,
  settings: Settings,
  now: UnixMs,
): { pdbBuy: Scrap | null; pdbSell: Scrap | null; community: Scrap | null; communityHigh: Scrap | null; stale: string[] } {
  const maxAge = settings.profit.referenceMaxAgeMs;
  const stale: string[] = [];
  const p = refs.pricedb;
  const pdbOk = p !== null && !(p.ageMs !== null && p.ageMs > maxAge);
  if (p && !pdbOk) stale.push(`PriceDB price is ${Math.floor((p.ageMs ?? 0) / DAY_MS)} days old, ignored`);
  const c = refs.community;
  const cAge = c?.lastUpdate != null ? now - c.lastUpdate * 1000 : null;
  // Like the service: community prices are hand-set, so they get at least a year.
  const commOk = c !== null && !(cAge !== null && cAge > communityMaxAgeMs(maxAge));
  if (c && !commOk) stale.push(`Community price is ${Math.floor((cAge ?? 0) / DAY_MS)} days old, ignored`);
  return {
    pdbBuy: pdbOk ? (p?.buyScrap ?? null) : null,
    pdbSell: pdbOk ? (p?.sellScrap ?? null) : null,
    community: commOk ? (c?.valueScrap ?? null) : null,
    communityHigh: commOk ? (c?.valueHighScrap ?? null) : null,
    stale,
  };
}

/** Any positive usable reference, as the service's hasReferenceValue: a PriceDB sell price alone still checks the price (F5). */
function hasUsableReference(refs: ReturnType<typeof usableReferences>): boolean {
  return [refs.pdbBuy, refs.pdbSell, refs.community, refs.communityHigh].some((v) => v !== null && v > 0);
}

/** The mock's pricing of one book: eligible orders valued with the key price, then best, conservative and instant. */
export function mockPrices(
  book: MockBook,
  settings: Settings,
  keyScrap: Scrap,
  now: UnixMs,
): { eligible: OrderSummary[]; best: OrderSummary | null; cons: OrderSummary | null; instant: OrderSummary | null; refs: ReturnType<typeof usableReferences> } {
  const blocked = new Set(settings.blocklist);
  const eligible = book.buy
    .filter((o) => o.eligible && !blocked.has(o.steamid))
    .map((o) => ({ ...o, valueScrap: Math.round(o.keys * keyScrap) + o.metalScrap }))
    .sort((a, b) => b.valueScrap - a.valueScrap);
  const refs = usableReferences(book.references, settings, now);
  const med = median(eligible.slice(0, 5).map((o) => o.valueScrap));
  const isOutlier = (o: OrderSummary) =>
    o.flags.includes('outlier') ||
    (eligible.length >= 3 && o.valueScrap > settings.profit.outlierVsMedian * med) ||
    (refs.pdbSell !== null && o.valueScrap > settings.profit.outlierVsRef * refs.pdbSell);
  return {
    eligible,
    best: eligible[0] ?? null,
    cons: eligible.find((o) => !isOutlier(o)) ?? null,
    instant: eligible.find((o) => !isOutlier(o) && o.isBot) ?? null,
    refs,
  };
}

/** ItemDetail.revenue for the mock drawer and quick entry. */
export function mockRevenue(book: MockBook, settings: Settings, keyScrap: Scrap, now: UnixMs): ItemRevenue {
  const { eligible, best, cons, instant } = mockPrices(book, settings, keyScrap, now);
  const useOrder = settings.profit.useOrder;
  const order = useOrder === 'best' ? best : useOrder === 'instant' ? instant : cons;
  const revenueScrap = order?.valueScrap ?? null;
  return {
    bestScrap: best?.valueScrap ?? null,
    consScrap: cons?.valueScrap ?? null,
    instantScrap: instant?.valueScrap ?? null,
    useOrder,
    revenueScrap,
    order,
    maxCostScrap: maxCostFor(revenueScrap, settings.profit),
    eligibleCount: eligible.length,
  };
}

export function evaluateOpportunity(
  book: MockBook,
  input: MockInput,
  settings: Settings,
  keyScrap: Scrap,
  now: UnixMs,
  prev: Opportunity | null,
): Opportunity {
  const sku = book.item.sku;
  const { eligible, best, cons, instant, refs } = mockPrices(book, settings, keyScrap, now);

  const flags: string[] = [];
  const reasons: string[] = [];
  let score = 50;
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`${signed(n)} ${why}`);
  };

  const costScrap = Math.round(input.costKeys * keyScrap) + input.costScrapRaw;
  if (best && cons && best.listingId !== cons.listingId) flags.push('outlier-best');
  if (refs.stale.length > 0) {
    flags.push('stale-reference');
    reasons.push(...refs.stale);
  }

  const chosen = settings.profit.useOrder === 'best' ? best : settings.profit.useOrder === 'instant' ? instant : cons;
  const revenue = chosen ? chosen.valueScrap : null;
  const profit = revenue === null ? null : revenue - costScrap - frictionOf(settings.profit);
  const margin = profit === null || costScrap <= 0 ? null : profit / costScrap;
  const refVal = refs.pdbBuy ?? refs.community;

  if (cons) {
    const pulse = book.meta.get(cons.listingId)?.pulseAgeMs ?? null;
    if (cons.isBot && pulse !== null && pulse <= 30 * 60_000) add(20, `Buyer is a bot that pulsed ${Math.round(pulse / 60_000)} min ago`);
    if (cons.online === true) add(5, 'Buyer is online');
    const confirmedAge = now - cons.lastEventAt;
    if (confirmedAge <= 2 * 3_600_000) add(10, 'Order confirmed by the live feed in the last 2 h');
    else if (confirmedAge > 24 * 3_600_000) {
      add(-15, 'Order not confirmed for over 24 h');
      flags.push('unverified-orders');
    }
    const near = eligible.filter((o) => o.valueScrap >= cons.valueScrap * 0.9 && o.valueScrap <= cons.valueScrap * 1.1);
    if (new Set(near.map((o) => o.steamid)).size >= 2) add(10, `${near.length} buyers within 10% of the conservative price`);
    if (refVal === null) {
      add(-10, 'No reference price to compare with');
      flags.push('no-reference');
    } else if (cons.valueScrap > refVal * 1.5) add(-20, 'Conservative order is over 1.5x the reference price');
    else if (cons.valueScrap >= refVal * 0.8 && cons.valueScrap <= refVal * 1.2) add(10, 'Conservative order agrees with the reference price');
    if (cons.flags.includes('notes-flag')) {
      add(-10, "Buyer's note mentions paint, spells or 'only'");
      flags.push('notes-flag');
    }
  }

  if (input.special?.paint && eligible.some((o) => !o.flags.includes('attribute-specific'))) {
    add(-10, 'Your copy has extras but the orders are generic');
    flags.push('has-extras');
  }

  const inputAge = now - input.observedAt;
  if (input.kind === 'rule') {
    add(-25, 'Cost comes from a price-sheet rule (estimate)');
    flags.push('rule-estimate');
  } else if (inputAge > settings.profit.inputStaleMs) {
    add(-25, `scrap.tf price is ${Math.round(inputAge / 3_600_000)} h old`);
    flags.push('stale-input');
  } else if (inputAge > 15 * 60_000) add(-10, `scrap.tf price is ${Math.round(inputAge / 60_000)} min old`);
  else reasons.push('0 scrap.tf price is fresh (under 15 min)');

  const fromSku = fromString(sku);
  if (fromSku.quality === 5 && revenue !== null && revenue > settings.profit.unusualRiskKeys * keyScrap) {
    add(-15, `Unusual worth over ${settings.profit.unusualRiskKeys} keys: check for price manipulation`);
    flags.push('unusual-risk');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  // Rule estimates are capped at Medium (brief §8).
  if (input.kind === 'rule' && score > 69) score = 69;
  // F5: a huge margin with few buyers and nothing to compare with is usually the wrong variant or unit.
  const suspect = settings.profit.suspectMargin;
  if (suspect > 0 && margin !== null && margin > suspect && eligible.length < 3 && !hasUsableReference(refs)) {
    flags.push('suspect-margin');
    reasons.push(`Margin over ${Math.round(suspect * 100)}% with no reference and few buyers. Check the variant and units`);
    score = Math.min(score, LOW_CAP);
  }
  const level: ConfidenceLevel = confidenceLevelOf(score);

  const key = `${sku}|${input.ref}`;
  return {
    key,
    sku,
    name: book.item.name,
    category: book.item.category,
    inputRef: input.ref,
    inputKind: input.kind,
    costKeys: input.costKeys,
    costScrapRaw: input.costScrapRaw,
    costScrap,
    bestScrap: best?.valueScrap ?? null,
    consScrap: cons?.valueScrap ?? null,
    instantScrap: instant?.valueScrap ?? null,
    revenueScrap: revenue,
    profitScrap: profit,
    margin,
    maxCostScrap: maxCostFor(revenue, settings.profit),
    confidence: score,
    confidenceLevel: level,
    flags,
    reasons,
    buyerCount: new Set(eligible.map((o) => o.steamid)).size,
    bestOrder: best,
    consOrder: cons,
    instantOrder: instant,
    references: book.references,
    profitTier: tierForProfit(profit, keyScrap),
    status: statusFor(profit, costScrap, settings.profit),
    inputObservedAt: input.observedAt,
    firstSeenAt: prev?.firstSeenAt ?? now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Shopping list (mock stand-in for src/service/domain/shopping.ts)
// ---------------------------------------------------------------------------

const INPUT_KINDS: readonly InputKind[] = ['user', 'import', 'rule'];

/** One row per SKU with a ceiling, highest-confidence input first; filtered, sorted by category then ceiling, paged. */
export function mockShoppingList(
  opps: readonly Opportunity[],
  q: ShoppingQuery,
  useOrder: Settings['profit']['useOrder'],
  keyPrice: KeyPriceState | null,
  now: UnixMs,
): ShoppingListResult {
  const bySku = new Map<string, Opportunity[]>();
  for (const o of opps) {
    const list = bySku.get(o.sku);
    if (list) list.push(o);
    else bySku.set(o.sku, [o]);
  }
  const all: ShoppingRow[] = [];
  for (const list of bySku.values()) {
    const top = list
      .filter((o) => o.maxCostScrap !== null && o.maxCostScrap > 0 && o.status !== 'no-buyers' && o.revenueScrap !== null)
      .sort((a, b) => b.confidence - a.confidence || (b.maxCostScrap ?? 0) - (a.maxCostScrap ?? 0) || a.key.localeCompare(b.key))[0];
    if (!top) continue;
    // Same pick as the service: a cost is only judged against its own row's ceiling.
    const known = top.inputKind !== 'rule' ? top : (list.filter((o) => o.inputKind !== 'rule').sort((a, b) => b.inputObservedAt - a.inputObservedAt)[0] ?? null);
    const maxCostScrap = top.maxCostScrap!;
    const knownCostScrap = known ? known.costScrap : null;
    const knownMaxCostScrap = known?.maxCostScrap ?? null;
    all.push({
      sku: top.sku,
      name: top.name,
      category: top.category,
      bankPageUrl: scraptfPageFor(top.category),
      maxCostScrap,
      revenueScrap: top.revenueScrap!,
      revenueOrder: revenueOrderOf(top, useOrder),
      confidence: top.confidence,
      confidenceLevel: top.confidenceLevel,
      buyerCount: top.buyerCount,
      knownCostScrap,
      knownMaxCostScrap,
      underCeiling: knownCostScrap === null ? null : knownMaxCostScrap !== null && knownCostScrap <= knownMaxCostScrap,
      inputKinds: INPUT_KINDS.filter((k) => list.some((o) => o.inputKind === k)),
      flags: top.flags,
      updatedAt: top.updatedAt,
    });
  }
  const rows = all
    .filter((r) => !q.categories?.length || q.categories.includes(r.category))
    .filter((r) => matchesSearch(r, q.search))
    .filter((r) => q.minCeilingScrap === undefined || r.maxCostScrap >= q.minCeilingScrap)
    .filter((r) => !q.onlyBotBuyers || r.revenueOrder?.isBot === true)
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || b.maxCostScrap - a.maxCostScrap || a.name.localeCompare(b.name));
  const groups = CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    count: rows.filter((r) => r.category === category).length,
    bankPageUrl: scraptfPageFor(category),
  })).filter((g) => g.count > 0);
  const offset = Math.max(0, q.offset ?? 0);
  const page = q.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + Math.max(1, q.limit));
  return { rows: page, total: rows.length, groups, keyPrice, generatedAt: now };
}

// ---------------------------------------------------------------------------
// Live market (mock stand-in for src/service/domain/market.ts)
// ---------------------------------------------------------------------------

const MARKET_CURRENCY: ReadonlySet<string> = new Set(CURRENCY_SKUS);

/** The newest typed and the newest imported price per base SKU (the service's known-price map). */
export interface MockKnown {
  typed: ScrapPrice | null;
  page: ScrapPrice | null;
}

export function mockKnownPrices(prices: readonly ScrapPrice[]): Map<string, MockKnown> {
  const out = new Map<string, MockKnown>();
  for (const p of prices) {
    let base: string;
    try {
      base = baseSku(p.sku);
    } catch {
      continue;
    }
    if (MARKET_CURRENCY.has(base)) continue;
    const slot = out.get(base) ?? { typed: null, page: null };
    const side = p.source === 'import' ? 'page' : 'typed';
    const cur = slot[side];
    if (!cur || p.observedAt > cur.observedAt || (p.observedAt === cur.observedAt && p.id > cur.id)) slot[side] = p;
    out.set(base, slot);
  }
  return out;
}

function hasExtras(p: ScrapPrice): boolean {
  if (fromString(p.sku).paint) return true;
  const s = p.special;
  return s !== null && (s.paint !== null || s.spells.length > 0 || s.parts.length > 0 || s.sheen !== null || s.killstreaker !== null || s.customName || s.customDesc);
}

/** Keys valued with the current key price, metal as is (valueScrap in src/shared/currency.ts). */
function costOf(p: { costKeys: number; costScrap: Scrap }, keyScrap: Scrap): Scrap {
  return Math.round(p.costKeys * keyScrap) + p.costScrap;
}

/**
 * One Live market row: the book priced like mockRevenue, buy-side confidence from a neutral input
 * (fresh, free, so only buyers and references count), and the user's side joined in, with the saved
 * scrap.tf/items list row (F14) when given. Null when the item has no eligible buyers and no price of
 * the user's (it is not in the market).
 */
export function mockMarketRow(args: {
  item: Pick<CatalogItem, 'sku' | 'name' | 'category'>;
  book: MockBook | null;
  known: MockKnown | undefined;
  rules: readonly PriceRule[];
  settings: Settings;
  keyScrap: Scrap;
  now: UnixMs;
  list?: ScraptfListRow | null;
  /** F17: MarketRow.scraptfNewAt (bankStockNewAt over the mock's bank-stock saves). */
  newAt?: UnixMs | null;
  /** F19: the saved page that last listed the item (preferScraptfSeen), else the category's bank. */
  seen?: ScraptfSeen | null;
  /** F20: MarketRow.scraptfListedSince (scraptfListedSinceOf over the seen bank's runs). */
  listedSince?: UnixMs | null;
}): MarketRow | null {
  const { item, book, known, settings, keyScrap, now } = args;
  if (MARKET_CURRENCY.has(item.sku)) return null;
  const priced = book ? mockPrices(book, settings, keyScrap, now) : null;
  const eligible = priced?.eligible ?? [];
  const buyerCount = new Set(eligible.map((o) => o.steamid)).size;
  const knownPrice = [known?.typed ?? null, known?.page ?? null]
    .filter((p): p is ScrapPrice => p !== null)
    .sort((a, b) => b.observedAt - a.observedAt || b.id - a.id)[0] ?? null;
  if (buyerCount === 0 && knownPrice === null) return null;

  const useOrder = settings.profit.useOrder;
  const order = priced ? (useOrder === 'best' ? priced.best : useOrder === 'instant' ? priced.instant : priced.cons) : null;
  const revenueScrap = order?.valueScrap ?? null;
  const maxCostScrap = maxCostFor(revenueScrap, settings.profit);

  let confidence = 0;
  let flags: string[] = [];
  if (book && buyerCount > 0) {
    const neutral: MockInput = { kind: 'user', ref: 'market', costKeys: 0, costScrapRaw: 0, observedAt: now, special: null };
    const o = evaluateOpportunity(book, neutral, settings, keyScrap, now, null);
    confidence = o.confidence;
    flags = o.flags.filter((f) => f !== 'stale-input' && f !== 'rule-estimate' && f !== 'suspect-margin');
  }
  // The ceiling is for a clean copy; a price for a painted or spelled copy is still shown, but marked.
  if (knownPrice && hasExtras(knownPrice) && !flags.includes('has-extras')) flags.push('has-extras');

  let ruleCostScrap: Scrap | null = null;
  for (const rule of args.rules) {
    if (!rule.enabled || !ruleMatches(rule.filter, item)) continue;
    const c = costOf(rule, keyScrap);
    if (ruleCostScrap === null || c < ruleCostScrap) ruleCostScrap = c;
  }

  const knownCostScrap = knownPrice ? costOf(knownPrice, keyScrap) : null;
  let lastOrderChangeAt: UnixMs | null = null;
  for (const o of eligible) if (lastOrderChangeAt === null || o.lastEventAt > lastOrderChangeAt) lastOrderChangeAt = o.lastEventAt;
  const verdict: MarketVerdict = marketVerdict({ buyerCount, maxCostScrap, knownCostScrap, ruleCostScrap });
  return {
    sku: item.sku,
    name: item.name,
    category: item.category,
    revenueScrap,
    bestScrap: priced?.best?.valueScrap ?? null,
    consScrap: priced?.cons?.valueScrap ?? null,
    instantScrap: priced?.instant?.valueScrap ?? null,
    revenueOrder: order,
    buyerCount,
    maxCostScrap,
    confidence,
    confidenceLevel: confidenceLevelOf(confidence),
    flags,
    knownCostScrap,
    knownSource: knownPrice === null ? 'none' : knownPrice.source === 'import' ? 'page' : 'typed',
    knownObservedAt: knownPrice?.observedAt ?? null,
    stock: knownPrice?.source === 'import' ? knownPrice.stock : null,
    ruleCostScrap,
    profitScrap: marketProfit(revenueScrap, knownCostScrap, settings.profit),
    verdict,
    lastOrderChangeAt,
    evaluatedAt: now,
    ...marketListFields(args.list ?? null),
    scraptfNewAt: args.newAt ?? null,
    scraptfLink: scraptfLinkFor(item.category, args.seen ?? null),
    scraptfListedSince: args.listedSince ?? null,
  };
}

/**
 * Filters, counts, sorts and pages like the service's market.list. `counts` are taken over the
 * query without its own verdicts filter; `matched` is every match in order (the CSV export).
 */
export function mockMarketQuery(
  all: readonly MarketRow[],
  q: MarketQuery,
  now: UnixMs = Date.now(),
): { rows: MarketRow[]; matched: MarketRow[]; total: number; counts: Record<MarketVerdict, number> } {
  const tokens = marketSearchTokens(q.search);
  const counts = emptyMarketCounts();
  const matched: MarketRow[] = [];
  for (const r of all) {
    if (!marketBuySideMatches(r, q, tokens) || !marketListSideMatches(r, q) || !marketNewSideMatches(r, q) || !marketUserSideMatches(r, q, true)) continue;
    // F20 (U5): "Listed on scrap.tf > 24 h", with the other source filters and before the verdict counts.
    if (!marketListedSideMatches(r, q, now)) continue;
    counts[r.verdict]++;
    if (!q.verdicts?.length || q.verdicts.includes(r.verdict)) matched.push(r);
  }
  matched.sort(marketComparator(q.sort, q.dir));
  const { limit, offset } = marketPage(q);
  return { rows: matched.slice(offset, offset + limit), matched, total: matched.length, counts };
}

/** What the service's onChanged compares: an entry is new, gone, or moved in revenue, ceiling, buyers or revenue order. */
export function marketSignature(r: MarketRow): string {
  return `${r.revenueScrap}|${r.maxCostScrap}|${r.buyerCount}|${r.revenueOrder?.listingId ?? ''}`;
}

/**
 * Holdings (F11): a held base SKU's buy side, read from the same book and math as its Live market
 * row (as the service reads the market entry). Null when no eligible buyer is left.
 */
export function mockHoldingBuySide(book: MockBook, settings: Settings, keyScrap: Scrap, now: UnixMs): HoldingBuySide | null {
  const row = mockMarketRow({ item: book.item, book, known: undefined, rules: [], settings, keyScrap, now });
  if (!row || row.buyerCount === 0) return null;
  return {
    revenueScrap: row.revenueScrap,
    bestScrap: row.bestScrap,
    instantScrap: row.instantScrap,
    revenueOrder: row.revenueOrder,
    bestOrder: mockPrices(book, settings, keyScrap, now).best,
    buyerCount: row.buyerCount,
    confidence: row.confidence,
    confidenceLevel: row.confidenceLevel,
    flags: row.flags,
    lastOrderChangeAt: row.lastOrderChangeAt,
  };
}

// ---------------------------------------------------------------------------
// scrap.tf price list (F14): the user's saved copy of scrap.tf/items
// ---------------------------------------------------------------------------

/**
 * The saved list's pages: /items split into three pages the user saved at different times, so the
 * card and the rows show fresh, hour-old and day-old data (the last is shown, never a held item's exit).
 */
export const MOCK_LIST_PAGES: readonly { batchId: number; ageMs: number }[] = [
  { batchId: 101, ageMs: 3 * 60_000 },
  { batchId: 102, ageMs: 50 * 60_000 },
  { batchId: 103, ageMs: 26 * 3_600_000 },
];
const LIST_LIMITS: readonly number[] = [1, 3, 5, 6, 10, 20];

/** Hand-set rows that show a case on purpose (the rest are generated from the catalogue). */
const LIST_OVERRIDES: Readonly<Record<string, { sells: Scrap; pays: Scrap | null; stock: number; limit: number; page: number }>> = {
  // A held item scrap.tf will not buy right now: Holdings shows "scrap.tf full", the status stays no-buyers.
  '30359;6': { sells: r(1.55), pays: r(1.33), stock: 6, limit: 6, page: 0 },
  // A held item scrap.tf pays more for than the backpack.tf buyers: its better exit (still a loss).
  '143;6': { sells: k(1, 55), pays: k(1, 48), stock: 1, limit: 3, page: 0 },
  // In stock, cheaper than the buyers pay: a Live market flip the list shows.
  '378;6': { sells: k(1, 12), pays: k(1, 2), stock: 2, limit: 5, page: 0 },
  // Out of stock: scrap.tf still buys it, but nothing can be bought there now.
  '126;6': { sells: k(1, 1), pays: r(55), stock: 0, limit: 4, page: 1 },
};

function splitPrice(v: Scrap): { keys: number; scrap: Scrap } {
  const keys = v >= K ? Math.floor(v / K) : 0;
  return { keys, scrap: v - keys * K };
}

/**
 * Deterministic list rows for most catalogue items (painted copies never: the list shows plain ones),
 * some out of stock, some full, on pages of mixed ages, plus the key row (KEY_SKU). The key row pays
 * above the mock's backpack.tf key quotes, so it never caps the mock key value (568) unless the user
 * types a scrap.tf key price later in Settings.
 */
export function seedScraptfList(now: UnixMs): ScraptfListStored[] {
  const out: ScraptfListStored[] = [];
  const at = (page: number) => now - MOCK_LIST_PAGES[page]!.ageMs;
  const batch = (page: number) => MOCK_LIST_PAGES[page]!.batchId;
  for (const item of [...CATALOG, ...EXTRA_NAMES, ...MARKET_ONLY]) {
    if (/;p\d/.test(item.sku) || MARKET_CURRENCY.has(item.sku)) continue;
    const h = hashOf(`list:${item.sku}`);
    const o = LIST_OVERRIDES[item.sku];
    if (o) {
      const s = splitPrice(o.sells);
      const p = o.pays === null ? null : splitPrice(o.pays);
      out.push({ sku: item.sku, name: item.name, sellsKeys: s.keys, sellsScrap: s.scrap, paysKeys: p?.keys ?? null, paysScrap: p?.scrap ?? null, stock: o.stock, stockLimit: o.limit, batchId: batch(o.page), observedAt: at(o.page) });
      continue;
    }
    // Not every item is on scrap.tf's list.
    if (h % 9 === 0) continue;
    const value = item.value > 0 ? item.value : r(1.33);
    // scrap.tf sells near the buyers' price and pays well under it.
    const sells = Math.max(1, Math.round(value * (0.82 + ((h >>> 3) % 24) / 100)));
    const paysRaw = Math.round(sells * (0.7 + ((h >>> 8) % 18) / 100));
    const pays = paysRaw >= 1 ? Math.min(paysRaw, Math.max(1, sells - 1)) : null;
    const limit = LIST_LIMITS[(h >>> 12) % LIST_LIMITS.length]!;
    const roll = (h >>> 16) % 10;
    const stock = roll === 0 ? 0 : roll === 1 ? limit : (h >>> 20) % (limit + 1);
    const page = (h >>> 24) % MOCK_LIST_PAGES.length;
    const s = splitPrice(sells);
    const p = pays === null ? null : splitPrice(pays);
    out.push({ sku: item.sku, name: item.name, sellsKeys: s.keys, sellsScrap: s.scrap, paysKeys: p?.keys ?? null, paysScrap: p?.scrap ?? null, stock, stockLimit: limit, batchId: batch(page), observedAt: at(page) });
  }
  out.push({ sku: KEY_SKU, name: 'Mann Co. Supply Crate Key', sellsKeys: 0, sellsScrap: K + 15, paysKeys: 0, paysScrap: K + 6, stock: 140, stockLimit: 400, batchId: batch(0), observedAt: at(0) });
  return out.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

// ---------------------------------------------------------------------------
// scrap.tf bank stock (F17): two saves of most banks, so every change shows
// ---------------------------------------------------------------------------

/** One saved bank page as the service keeps it in bank_stock (its rows raw, its batch's save time). */
export interface MockStockSave {
  bank: ScraptfBank;
  batchId: number;
  savedAt: UnixMs;
  rows: BankStockStored[];
}

/** Items a bank page shows, at most this many (the generated unusuals and killstreaks run into hundreds). */
const MOCK_STOCK_POOL = 40;

function stockRowOf(item: Pick<CatalogItem, 'sku' | 'name'>, price: Scrap | null, stock: number | null): BankStockStored {
  const obj = fromString(item.sku);
  const paint = obj.paint && obj.paint > 0 ? obj.paint : null;
  const split = price === null ? null : splitPrice(price);
  return {
    sku: baseSku(item.sku),
    specialKey: bankStockSpecialKey(paint === null ? null : { paint }),
    name: item.name,
    costKeys: split?.keys ?? null,
    costScrap: split?.scrap ?? null,
    stock,
    assetId: null,
  };
}

/**
 * Deterministic bank-stock saves (no RNG, so the seeded mock is unchanged): for each `newest` save, its
 * rows, and an older save `previousAt` (null: the bank's first save) differing from it on purpose. The
 * first six items of every pool are, in order: new, gone, cheaper, pricier, new again (sold out before)
 * and gone (sold out now); the rest change by hash. A bank page's rows carry the imported price of the
 * same batch when there is one (the Live market shows the same cost); the 'list' save is the saved
 * scrap.tf/items list's rows (`listRows`, sold out included).
 */
export function seedBankStock(args: {
  saves: readonly { bank: ScraptfBank; batchId: number; savedAt: UnixMs; previous: { batchId: number; savedAt: UnixMs } | null }[];
  prices: readonly ScrapPrice[];
  listRows: readonly ScraptfListStored[];
}): MockStockSave[] {
  const out: MockStockSave[] = [];
  const all = [...CATALOG, ...EXTRA_NAMES, ...MARKET_ONLY].filter((i) => !MARKET_CURRENCY.has(baseSku(i.sku)));
  for (const s of args.saves) {
    const pool: { item: Pick<CatalogItem, 'sku' | 'name'>; price: Scrap | null; stock: number | null }[] = [];
    if (s.bank === 'list') {
      for (const r of args.listRows) {
        if (r.sku === KEY_SKU) continue;
        const price = r.sellsScrap === null ? null : Math.round((r.sellsKeys ?? 0) * K) + r.sellsScrap;
        pool.push({ item: { sku: r.sku, name: r.name }, price, stock: r.stock });
      }
      // Rows on sale first, so the six forced cases below land on rows that can change.
      const onSale = (x: (typeof pool)[number]) => x.price !== null && x.stock !== 0;
      pool.sort((a, b) => Number(onSale(b)) - Number(onSale(a)) || hashOf(`stock:${a.item.sku}`) - hashOf(`stock:${b.item.sku}`));
    } else {
      const own = new Map(args.prices.filter((p) => p.source === 'import' && p.importBatch === s.batchId).map((p) => [p.sku, p]));
      const items = all
        .filter((i) => bankForCategory(i.category) === s.bank)
        .sort((a, b) => Number(own.has(b.sku)) - Number(own.has(a.sku)) || hashOf(`stock:${a.sku}`) - hashOf(`stock:${b.sku}`))
        .slice(0, MOCK_STOCK_POOL);
      for (const item of items) {
        const p = own.get(item.sku);
        const h = hashOf(`stock:${s.bank}:${item.sku}`);
        const value = item.value > 0 ? item.value : r(1.33);
        const price = p ? Math.round(p.costKeys * K) + p.costScrap : Math.max(1, Math.round(value * (0.82 + ((h >>> 3) % 24) / 100)));
        pool.push({ item, price, stock: p?.stock ?? 1 + ((h >>> 8) % 4) });
      }
    }
    const newest: BankStockStored[] = [];
    const previous: BankStockStored[] = [];
    pool.forEach(({ item, price, stock }, i) => {
      const h = hashOf(`stock-case:${s.bank}:${item.sku}`);
      const kase = i < 6 ? i : 6 + ((h >>> 5) % 6);
      const now = stockRowOf(item, price, stock);
      const before = (p: Scrap | null, st: number | null) => stockRowOf(item, p, st);
      const scaled = (f: number) => (price === null ? null : Math.max(1, Math.round(price * f)));
      switch (kase) {
        case 0: // new: not on the previous page (cheap on purpose, so a new flip shows)
          newest.push(stockRowOf(item, scaled(0.7), stock));
          break;
        case 1: // gone: only on the previous page
          previous.push(now);
          break;
        case 2: // cheaper than before
          newest.push(now);
          previous.push(before(scaled(1.12), stock));
          break;
        case 3: // pricier than before
          newest.push(now);
          previous.push(before(scaled(0.9), stock));
          break;
        case 4: // new again: sold out on the previous page
          newest.push(now);
          previous.push(before(price, 0));
          break;
        case 5: // gone: listed sold out now
          newest.push(before(price, 0));
          previous.push(now);
          break;
        case 6: // stock moved, price kept
          newest.push(now);
          previous.push(before(price, (stock ?? 1) + 1));
          break;
        default:
          newest.push(now);
          previous.push(now);
      }
    });
    out.push({ bank: s.bank, batchId: s.batchId, savedAt: s.savedAt, rows: newest });
    if (s.previous) out.push({ bank: s.bank, batchId: s.previous.batchId, savedAt: s.previous.savedAt, rows: previous });
  }
  return out;
}

// ---------------------------------------------------------------------------
// scrap.tf history (F20): older saves of each bank with two saves, so the history, the time listed and
// the change feed have something to show
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
/** Older saves added before a bank's previous save: twelve 12 h apart, then four a day apart. */
const HISTORY_STEPS: readonly number[] = [...Array.from({ length: 12 }, (_, i) => (i + 1) * 12 * HOUR), ...Array.from({ length: 4 }, (_, i) => (6 + i + 1) * 24 * HOUR)];

/**
 * F20: about 20 saves per bank over 10 days for every bank the seed saved twice (killstreaks keeps its
 * single first save, skins and items stay never saved). Built backwards from each bank's previous save,
 * deterministically (hashOf): prices drift, some items appear late (new) or leave for a while and come
 * back (gone, then restocked), a few others come and go, stock counts move. Batch ids from 1000 up; the
 * two seeded saves are unchanged, so F17's diff (newest against previous) is too.
 */
export function seedBankStockHistory(saves: readonly MockStockSave[]): MockStockSave[] {
  const out: MockStockSave[] = [];
  const all = [...CATALOG, ...EXTRA_NAMES, ...MARKET_ONLY].filter((i) => !MARKET_CURRENCY.has(baseSku(i.sku)));
  const banks = [...new Set(saves.map((s) => s.bank))];
  banks.forEach((bank, bankIdx) => {
    const mine = saves.filter((s) => s.bank === bank).sort((a, b) => b.savedAt - a.savedAt || b.batchId - a.batchId);
    const previous = mine[1];
    if (!previous) return;
    // A few items the bank had for a while in the past only (they came and went).
    const listed = new Set([...mine[0]!.rows, ...previous.rows].map((r) => r.sku));
    const ghosts = all
      .filter((i) => !listed.has(baseSku(i.sku)) && (bank === 'list' || bankForCategory(i.category) === bank))
      .sort((a, b) => hashOf(`ghost:${bank}:${a.sku}`) - hashOf(`ghost:${bank}:${b.sku}`))
      .slice(0, 3);
    let newer: BankStockStored[] = previous.rows;
    HISTORY_STEPS.forEach((ago, i) => {
      const step = i + 1;
      const rows: BankStockStored[] = [];
      for (const row of previous.rows) {
        const h = hashOf(`hist:${bank}:${row.sku}|${row.specialKey}`);
        // Born late: absent from every save older than its birth step (new when it first shows).
        if (h % 5 === 0 && step >= 2 + ((h >>> 4) % 12)) continue;
        // Away for a while: gone from step a to b (going forward: gone, then restocked).
        const away = (h >>> 8) % 7 === 0 ? 3 + ((h >>> 12) % 6) : null;
        if (away !== null && step >= away && step < away + 2) continue;
        const later = newer.find((r) => r.sku === row.sku && r.specialKey === row.specialKey) ?? row;
        // Drift: some saves had another price (the newer save's, nudged).
        const dh = hashOf(`drift:${bank}:${row.sku}:${step}`);
        let price: Scrap | null = later.costScrap === null ? null : Math.round((later.costKeys ?? 0) * K) + later.costScrap;
        if (price !== null && dh % 4 === 0) price = Math.max(1, Math.round(price * (1 + (((dh >>> 4) % 17) - 8) / 100)));
        // Sold out on some saves (restocked after); stock moves on others.
        const soldOut = (dh >>> 9) % 11 === 0;
        const stock = soldOut ? 0 : row.stock === null ? null : Math.max(1, row.stock + (((dh >>> 13) % 3) - 1));
        // The copy's own special key (a painted copy stays one).
        const split = price === null ? null : splitPrice(price);
        rows.push({ ...row, costKeys: split?.keys ?? null, costScrap: split?.scrap ?? null, stock });
      }
      ghosts.forEach((g, gi) => {
        // Listed from step 4 + gi to 9 + gi: new at the older end, gone at the newer one.
        if (step >= 4 + gi && step <= 9 + gi) {
          const value = g.value > 0 ? g.value : r(1.33);
          rows.push(stockRowOf(g, Math.max(1, Math.round(value * 0.9)), 1 + (hashOf(`ghost-stock:${g.sku}`) % 3)));
        }
      });
      out.push({ bank, batchId: 1000 + bankIdx * 50 + step, savedAt: previous.savedAt - ago, rows });
      newer = rows;
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Bulk paste and rules backup (mock stand-ins for src/service/priceSheetIo.ts)
// ---------------------------------------------------------------------------

export const PAGE_CONTENT_REFUSAL = 'This looks like page content. Use Import for saved pages.';
const MAX_BULK_LINES = 500;
const MAX_BULK_BYTES = 100 * 1024;
const SEPARATOR_CHARS = '\t,;=@';

/** `<item> <sep> <price>`, else the last price-looking words. Null when no split gives a price. */
function splitLine(line: string, bareUnit: 'ref' | 'scrap' | 'keys'): { item: string; price: ParsedPrice } | null {
  // The leftmost separator whose right side is a price: names may hold commas ("Rock, Paper, Scissors").
  for (let i = 0; i < line.length; i++) {
    const width = SEPARATOR_CHARS.includes(line[i]!) ? 1 : line.startsWith(' - ', i) ? 3 : 0;
    if (width === 0) continue;
    const item = line.slice(0, i).trim();
    const price = parsePrice(line.slice(i + width), bareUnit);
    if (item && price) return { item, price };
  }
  const words = line.split(/\s+/);
  for (let k = Math.min(4, words.length - 1); k >= 1; k--) {
    const price = parsePrice(words.slice(words.length - k).join(' '), bareUnit);
    if (price) return { item: words.slice(0, words.length - k).join(' '), price };
  }
  return null;
}

/** Preview of a bulk paste. Throws the refusal for page content or a paste over the limits (R10). */
export function mockParseBulk(
  text: string,
  bareUnit: 'ref' | 'scrap' | 'keys',
  resolve: (text: string) => ResolvedItem | null,
): { rows: BulkPriceRow[]; rejected: number } {
  if (text.includes('<') || /scrap\.tf\//i.test(text)) throw new Error(PAGE_CONTENT_REFUSAL);
  if (new TextEncoder().encode(text).length > MAX_BULK_BYTES) throw new Error('That paste is larger than 100 KB. Split it into smaller pastes.');
  // Same line breaks as the service parser (bare CR too).
  const lines = text.split(/\r\n|\n|\r/);
  const items = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (items.length > MAX_BULK_LINES) throw new Error(`At most ${MAX_BULK_LINES} lines per paste.`);
  const rows: BulkPriceRow[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const row: BulkPriceRow = { line: i + 1, raw, sku: null, name: null, costKeys: 0, costScrap: 0, error: null };
    const split = splitLine(line, bareUnit);
    if (!split) {
      rows.push({ ...row, error: 'No price found (e.g. "Team Captain, 1 key 5 ref")' });
      return;
    }
    const item = resolve(split.item);
    const priced: BulkPriceRow = { ...row, name: item?.name ?? null, costKeys: split.price.keys, costScrap: split.price.scrap };
    // As the service: only a clean match with a non-zero price is saveable, and only a saveable row carries a sku.
    const problem = item === null ? `Item not recognised: ${split.item.slice(0, 80)}` : bulkItemProblem(item);
    if (problem !== null || item === null) rows.push({ ...priced, error: problem ?? 'Item not recognised' });
    else if (split.price.keys === 0 && split.price.scrap === 0) rows.push({ ...priced, error: 'The price is 0' });
    else rows.push({ ...priced, sku: item.sku });
  });
  return { rows, rejected: rows.filter((r) => r.error !== null).length };
}

/** The service's priceSheetIo itemProblem: a guess or an incomplete SKU would price the wrong item. */
function bulkItemProblem(r: ResolvedItem): string | null {
  if (r.match === 'fuzzy') return `Closest match only ("${r.name}"). Use the exact name, a SKU or an item link`;
  return r.warnings.find((w) => !/BLU twin/i.test(w)) ?? null;
}

export const RULES_BACKUP_FORMAT = 'tf2-flip-desk-rules';

export function mockRulesToJson(rules: readonly PriceRule[], now: UnixMs): string {
  const out = rules.map(({ name, filter, costKeys, costScrap, observedAt, enabled }) => ({ name, filter, costKeys, costScrap, observedAt, enabled }));
  return JSON.stringify({ format: RULES_BACKUP_FORMAT, version: 1, exportedAt: now, rules: out }, null, 2);
}

/** Lenient: a bare array of rules is accepted too. Each invalid rule is skipped with a reason. */
export function mockRulesFromJson(json: string): { rules: PriceRuleInput[]; skipped: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Not a rules backup: the file is not valid JSON.');
  }
  const list = Array.isArray(data) ? data : typeof data === 'object' && data !== null ? (data as { rules?: unknown }).rules : undefined;
  if (!Array.isArray(list)) throw new Error('Not a rules backup: no "rules" list found.');
  const rules: PriceRuleInput[] = [];
  const skipped: string[] = [];
  list.forEach((raw, i) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const label = typeof r['name'] === 'string' && r['name'].trim() ? `"${r['name'].trim().slice(0, 60)}"` : `Rule ${i + 1}`;
    if (typeof r['name'] !== 'string' || !r['name'].trim()) skipped.push(`${label}: a rule needs a name`);
    else if (typeof r['filter'] !== 'object' || r['filter'] === null || Array.isArray(r['filter'])) skipped.push(`${label}: filter is missing`);
    else if (typeof r['costScrap'] !== 'number' || !Number.isFinite(r['costScrap']) || r['costScrap'] < 0) skipped.push(`${label}: costScrap must be zero or more`);
    else {
      rules.push({
        name: r['name'].trim().slice(0, 120),
        filter: structuredClone(r['filter']) as RuleFilter,
        costKeys: typeof r['costKeys'] === 'number' && r['costKeys'] >= 0 ? r['costKeys'] : 0,
        costScrap: Math.round(r['costScrap']),
        ...(typeof r['observedAt'] === 'number' ? { observedAt: r['observedAt'] } : {}),
        enabled: r['enabled'] !== false,
      });
    }
  });
  return { rules, skipped };
}

// ---------------------------------------------------------------------------
// Links (mock stand-in for src/shared/links.ts)
// ---------------------------------------------------------------------------

export function mockLinks(sku: string, name: string, assetId: string | null): LinkSpec[] {
  const o = fromString(sku);
  const enc = encodeURIComponent;
  const links: LinkSpec[] = [
    { id: 'bptf-stats', label: 'backpack.tf stats', url: `https://backpack.tf/stats/${o.quality}/${enc(name)}/Tradable/${o.craftable ? 'Craftable' : 'Non-Craftable'}`, group: 'backpack' },
    { id: 'bptf-classifieds', label: 'backpack.tf classifieds', url: `https://backpack.tf/classifieds?item=${enc(name)}&quality=${o.quality}&tradable=1&craftable=${o.craftable ? 1 : -1}`, group: 'backpack' },
    { id: 'mptf', label: 'marketplace.tf', url: `https://marketplace.tf/items/tf2/${enc(sku)}`, group: 'market' },
    { id: 'scm', label: 'Steam Community Market', url: `https://steamcommunity.com/market/listings/440/${enc(name)}`, group: 'market' },
    { id: 'pricedb', label: 'PriceDB graph', url: `https://pricedb.io/api/graph/${enc(sku)}`, group: 'tools' },
  ];
  if (assetId) links.unshift({ id: 'bptf-history', label: 'Item history', url: `https://backpack.tf/item/${enc(assetId)}`, group: 'backpack' });
  return links;
}

// ---------------------------------------------------------------------------
// Journal FIFO (mock only; the service has its own implementation)
// ---------------------------------------------------------------------------

export function mockJournalSummary(entries: readonly JournalEntry[]): JournalSummary {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const lots = new Map<string, { cost: Scrap; name: string; id: number; ts: UnixMs; keys: number; scrap: Scrap; k: Scrap }[]>();
  const bySku = new Map<string, { sku: string; name: string; realizedProfitScrap: Scrap; trades: number }>();
  let realized = 0;
  let trades = 0;
  for (const e of sorted) {
    const value = Math.round(e.keys * e.keyPriceScrap) + e.scrap;
    const queue = lots.get(e.sku) ?? [];
    lots.set(e.sku, queue);
    if (e.side === 'buy') {
      queue.push({ cost: value, name: e.name, id: e.id, ts: e.ts, keys: e.keys, scrap: e.scrap, k: e.keyPriceScrap });
    } else {
      const lot = queue.shift();
      if (!lot) continue;
      const p = value - lot.cost;
      realized += p;
      trades++;
      const s = bySku.get(e.sku) ?? { sku: e.sku, name: e.name, realizedProfitScrap: 0, trades: 0 };
      s.realizedProfitScrap += p;
      s.trades++;
      bySku.set(e.sku, s);
    }
  }
  const open = [...lots.entries()]
    .filter(([, q]) => q.length > 0)
    .map(([sku, q]) => ({
      sku,
      name: q[0]!.name,
      qty: q.length,
      costScrap: q.reduce((t, l) => t + l.cost, 0),
      lots: q.map((l) => ({ id: l.id, ts: l.ts, costScrap: l.cost, keys: l.keys, scrap: l.scrap, keyPriceScrap: l.k })),
    }));
  return { realizedProfitScrap: realized, realizedTrades: trades, open, bySku: [...bySku.values()] };
}

// ---------------------------------------------------------------------------
// Seed state
// ---------------------------------------------------------------------------

export const SEED_RULES: readonly Omit<PriceRule, 'observedAt'>[] = [
  { id: 1, name: 'Unique craftable hats', filter: { categories: ['hats'], qualities: [6], craftable: true, hasEffect: false }, costKeys: 0, costScrap: 16, enabled: true },
  { id: 2, name: 'Plain strange weapons', filter: { categories: ['stranges'], qualities: [11], killstreak: [0], australium: false }, costKeys: 0, costScrap: r(2.88), enabled: true },
  { id: 3, name: 'Specialized killstreaks', filter: { killstreak: [2] }, costKeys: 0, costScrap: r(6.33), enabled: false },
];

export function seedPrices(rng: Rng, now: UnixMs): ScrapPrice[] {
  const out: ScrapPrice[] = [];
  let id = 1;
  let batch = 0;
  for (const item of CATALOG) {
    if (rng.chance(0.12)) continue; // some items are only covered by rules
    const fromImport = rng.chance(0.25);
    if (fromImport && batch === 0) batch = 1;
    // Cost is set relative to the item's value so the mock spreads across tiers.
    const f = rng.pick([0.42, 0.3, 0.22, 0.16, 0.12, 0.08, 0.05, 0.03, 0.01, -0.04, -0.1]);
    const v = Math.max(1, item.value);
    const cost = Math.max(1, v <= 18 ? v - rng.int(-2, 4) : Math.round(v / (1 + f)));
    const split = splitValue(cost);
    const painted = fromString(item.sku).paint;
    out.push({
      id: id++,
      sku: item.sku,
      name: item.name,
      costKeys: split.keys,
      costScrap: split.metalScrap,
      source: fromImport ? 'import' : 'user',
      observedAt: now - (fromImport ? rng.int(20, 300) : rng.int(1, 400)) * 60_000,
      note: rng.chance(0.15) ? rng.pick(['2 in stock', 'seen twice today', 'check paint', 'from the unusual page']) : null,
      importBatch: fromImport ? rng.int(1, 3) : null,
      special: painted ? { paint: painted, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false } : fromImport ? { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false } : null,
      assetId: fromImport ? String(15_000_000_000 + rng.int(0, 999_999_999)) : null,
      stock: fromImport ? rng.int(1, 4) : null,
    });
  }
  return out;
}

export function seedJournal(now: UnixMs): JournalEntry[] {
  const day = 86_400_000;
  const rows: Omit<JournalEntry, 'id'>[] = [
    { ts: now - 9 * day, side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 1, scrap: r(14), keyPriceScrap: 565, note: null },
    { ts: now - 8 * day, side: 'sell', venue: 'backpack.tf', sku: '378;6', name: 'Team Captain', keys: 1, scrap: r(22), keyPriceScrap: 566, note: 'bot buyer' },
    { ts: now - 6 * day, side: 'buy', venue: 'scrap.tf', sku: '200;11', name: 'Strange Scattergun', keys: 0, scrap: r(2.66), keyPriceScrap: 566, note: null },
    { ts: now - 6 * day + 3_600_000, side: 'buy', venue: 'scrap.tf', sku: '200;11', name: 'Strange Scattergun', keys: 0, scrap: r(2.77), keyPriceScrap: 566, note: null },
    { ts: now - 5 * day, side: 'sell', venue: 'backpack.tf', sku: '200;11', name: 'Strange Scattergun', keys: 0, scrap: r(3.11), keyPriceScrap: 567, note: null },
    { ts: now - 3 * day, side: 'buy', venue: 'scrap.tf', sku: '30357;5;u702', name: 'Isotope Dark Falkirk Helm', keys: 21, scrap: 0, keyPriceScrap: 568, note: 'background check done' },
    { ts: now - 2 * day, side: 'buy', venue: 'scrap.tf', sku: '1118;6', name: 'Taunt: Conga', keys: 0, scrap: r(10.66), keyPriceScrap: 568, note: null },
    { ts: now - 1 * day, side: 'sell', venue: 'backpack.tf', sku: '1118;6', name: 'Taunt: Conga', keys: 0, scrap: r(12.11), keyPriceScrap: 568, note: null },
    // Still held (Holdings, F11): a loss, an item nobody buys, and two lots of one SKU.
    { ts: now - 4 * day, side: 'buy', venue: 'scrap.tf', sku: '143;6', name: 'Earbuds', keys: 2, scrap: 0, keyPriceScrap: 568, note: 'overpaid' },
    { ts: now - 36 * 3_600_000, side: 'buy', venue: 'scrap.tf', sku: '30359;6', name: 'Juggernaut Jacket', keys: 0, scrap: r(1.33), keyPriceScrap: 568, note: null },
    { ts: now - 20 * 3_600_000, side: 'buy', venue: 'scrap.tf', sku: '194;11', name: 'Strange Knife', keys: 0, scrap: r(4.88), keyPriceScrap: 568, note: null },
    { ts: now - 19 * 3_600_000, side: 'buy', venue: 'scrap.tf', sku: '194;11', name: 'Strange Knife', keys: 0, scrap: r(5.11), keyPriceScrap: 568, note: null },
  ];
  return rows.map((row, i) => ({ id: i + 1, ...row }));
}
