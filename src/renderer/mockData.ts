// Deterministic fake data for running the dashboard in a plain browser.
// Development only: none of these prices, buyers or listings are real.

import { refToScrap, formatScrap } from '../shared/currency';
import { fromString } from '../shared/sku';
import type {
  Category,
  ConfidenceLevel,
  HistoryPoint,
  InputKind,
  JournalEntry,
  JournalSummary,
  LinkSpec,
  Opportunity,
  OrderSummary,
  PriceRule,
  ReferencePrices,
  RuleFilter,
  Scrap,
  ScrapPrice,
  Settings,
  SpecialAttrs,
  UnixMs,
} from '../shared/types';
import { confidenceLevelOf } from './format';
import { statusFor, tierForProfit } from './oppModel';

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

export function findCatalogItem(sku: string): CatalogItem | null {
  return CATALOG.find((c) => c.sku === sku) ?? EXTRA_NAMES.find((c) => c.sku === sku) ?? null;
}

export function allSearchable(): CatalogItem[] {
  return [...CATALOG, ...EXTRA_NAMES];
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

export function evaluateOpportunity(
  book: MockBook,
  input: MockInput,
  settings: Settings,
  keyScrap: Scrap,
  now: UnixMs,
  prev: Opportunity | null,
): Opportunity {
  const sku = book.item.sku;
  const blocked = new Set(settings.blocklist);
  const eligible = book.buy
    .filter((o) => o.eligible && !blocked.has(o.steamid))
    .map((o) => ({ ...o, valueScrap: Math.round(o.keys * keyScrap) + o.metalScrap }))
    .sort((a, b) => b.valueScrap - a.valueScrap);

  const flags: string[] = [];
  const reasons: string[] = [];
  let score = 50;
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`${signed(n)} ${why}`);
  };

  const costScrap = Math.round(input.costKeys * keyScrap) + input.costScrapRaw;
  const best = eligible[0] ?? null;
  const top = eligible.slice(0, 5).map((o) => o.valueScrap);
  const med = median(top);
  const pdbSell = book.references.pricedb?.sellScrap ?? null;
  const isOutlier = (o: OrderSummary) =>
    o.flags.includes('outlier') ||
    (eligible.length >= 3 && o.valueScrap > settings.profit.outlierVsMedian * med) ||
    (pdbSell !== null && o.valueScrap > settings.profit.outlierVsRef * pdbSell);
  const cons = eligible.find((o) => !isOutlier(o)) ?? null;
  const instant = eligible.find((o) => !isOutlier(o) && o.isBot) ?? null;
  if (best && cons && best.listingId !== cons.listingId) flags.push('outlier-best');

  const chosen = settings.profit.useOrder === 'best' ? best : settings.profit.useOrder === 'instant' ? instant : cons;
  const revenue = chosen ? chosen.valueScrap : null;
  const profit = revenue === null ? null : revenue - costScrap - settings.profit.frictionScrap;
  const margin = profit === null || costScrap <= 0 ? null : profit / costScrap;

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
    const refVal = book.references.pricedb?.buyScrap ?? book.references.community?.valueScrap ?? null;
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
  const lots = new Map<string, { cost: Scrap; name: string }[]>();
  const bySku = new Map<string, { sku: string; name: string; realizedProfitScrap: Scrap; trades: number }>();
  let realized = 0;
  let trades = 0;
  for (const e of sorted) {
    const value = Math.round(e.keys * e.keyPriceScrap) + e.scrap;
    const queue = lots.get(e.sku) ?? [];
    lots.set(e.sku, queue);
    if (e.side === 'buy') {
      queue.push({ cost: value, name: e.name });
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
    .map(([sku, q]) => ({ sku, name: q[0]!.name, qty: q.length, costScrap: q.reduce((t, l) => t + l.cost, 0) }));
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
  ];
  return rows.map((row, i) => ({ id: i + 1, ...row }));
}
