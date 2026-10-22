// One journal venue list and the rules that read it (0.8: J2, J4), shared by the Record trade dialog, the Journal
// page and its reports, core's ACT-3 newest scrap.tf buy and the mock. Stored venues are free text and are never
// rewritten; aliases are folded when read. Fee hints are static text from DESIGN_BRIEF §5.4, shown next to the Fees
// field and never filled in. The file contains no URL and no scrap.tf address (the static.test.ts R1 scan). And (0.9,
// #2) the documented fee rules in integer cents (Steam Market, mannco.store) and the marketplace.tf fee setting's rule,
// shared by ceiling.ts (break-even), the journal's hints and the drawer's Steam Market check. No URL, no request.

import { HOLDING_EXIT_VENUES, type JournalSide } from './types';

const SCRAPTF = HOLDING_EXIT_VENUES.scraptf;
const BACKPACK = HOLDING_EXIT_VENUES.backpack;
const MARKETPLACE = 'marketplace.tf';
const MANNCO = 'mannco.store';
const STEAM_MARKET = 'Steam Community Market';
const DIRECT = 'Direct trade';
const OTHER = 'other';

/** The venue datalist everywhere (anything else can be typed); 0.9 (#2) adds mannco.store. */
export const JOURNAL_VENUES: readonly string[] = [SCRAPTF, BACKPACK, MARKETPLACE, MANNCO, STEAM_MARKET, DIRECT, OTHER];
/** A write-off's venue (it has no counterparty). */
export const WRITE_OFF_VENUE = 'Written off';
/** venueLabel of an empty or unreadable venue. */
export const UNKNOWN_VENUE_LABEL = 'Unknown';

/** Each canonical venue and the spellings folded into it, keyed by venueKey (so lower case, single spaces). */
const ALIASES: readonly (readonly [string, readonly string[]])[] = [
  [SCRAPTF, ['scrap.tf', 'scraptf', 'scrap tf', 'scrap']],
  [BACKPACK, ['backpack.tf', 'backpacktf', 'backpack tf', 'backpack', 'bp.tf', 'bptf', 'bp', 'next.backpack.tf']],
  [MARKETPLACE, ['marketplace.tf', 'marketplacetf', 'marketplace tf', 'marketplace', 'mp.tf', 'mptf']],
  [MANNCO, ['mannco.store', 'manncostore', 'mannco store', 'mannco']],
  [STEAM_MARKET, ['steam community market', 'steam market', 'community market', 'scm', 'steam', 'steamcommunity.com']],
  [DIRECT, ['direct trade', 'direct', 'steam trade', 'trade offer', 'private trade']],
  [OTHER, ['other']],
  [WRITE_OFF_VENUE, ['written off', 'written-off', 'write off', 'write-off', 'writeoff']],
];
const CANONICAL: ReadonlyMap<string, string> = new Map(ALIASES.flatMap(([name, keys]) => keys.map((k) => [k, name] as const)));

/** Trimmed, lower-case, inner whitespace collapsed, a trailing '.' or '/' dropped; '' for a non-string. */
export function venueKey(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[./]+$/, '').trim();
}

/** The canonical name of a known alias; other text trimmed with its spaces collapsed (case kept); '' → 'Unknown'. */
export function venueLabel(v: unknown): string {
  if (typeof v !== 'string') return UNKNOWN_VENUE_LABEL;
  const known = CANONICAL.get(venueKey(v));
  if (known !== undefined) return known;
  const text = v.trim().replace(/\s+/g, ' ');
  return text === '' ? UNKNOWN_VENUE_LABEL : text;
}

/** ACT-3 and the reports: the venue is scrap.tf in any case or alias (venueLabel). */
export function isScraptfVenue(v: unknown): boolean {
  return venueLabel(v) === SCRAPTF;
}

// ---------------------------------------------------------------------------
// 0.9 (#2): documented fee rules in integer cents (RESEARCH §4.4, §4.6) and the marketplace.tf setting's rule
// ---------------------------------------------------------------------------

/** 0.9 (#2): the Steam Community Market's fees, charged on what the seller receives; Valve may change them (SSA §3.D). */
export interface ScmFeeRule {
  /** Steam's fee in basis points of what the seller receives (500 = 5%). */
  steamBps: number;
  /** The game's (TF2's) fee in basis points (1000 = 10%). */
  gameBps: number;
  /** Each fee's minimum, in cents. */
  minFeeCents: number;
}
/** 0.9 (#2): the SCM rule as documented: 5% Steam, 10% TF2, each at least 1 cent. */
export const SCM_FEE_RULE: Readonly<ScmFeeRule> = Object.freeze({ steamBps: 500, gameBps: 1000, minFeeCents: 1 });

/** 0.9 (#2): the largest amount the cent rules take ($10,000, far above any listing), so cents x 10,000 stays exact. */
export const FEE_MAX_CENTS = 1_000_000;

function centsIn(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= FEE_MAX_CENTS;
}

/** One SCM fee on `receivedCents`: max(minimum, floor(received x bps / 10,000)). */
function scmFee(receivedCents: number, bps: number, minCents: number): number {
  return Math.max(minCents, Math.floor((receivedCents * bps) / 10_000));
}

/**
 * 0.9 (#2): what the buyer pays for `receivedCents` to the seller: received + Steam's fee + the game's fee, each
 * floor(received x rate) and at least 1 cent. 100 -> 115, 193 -> 221, 1 -> 3. Null for a non-integer or outside
 * 1..FEE_MAX_CENTS. Strictly increasing.
 */
export function scmBuyerPaysCents(receivedCents: number, rule: ScmFeeRule = SCM_FEE_RULE): number | null {
  if (!centsIn(receivedCents)) return null;
  return receivedCents + scmFee(receivedCents, rule.steamBps, rule.minFeeCents) + scmFee(receivedCents, rule.gameBps, rule.minFeeCents);
}

/**
 * 0.9 (#2): the inverse: the most the seller receives when the buyer pays `buyerPaysCents`, the largest r with
 * scmBuyerPaysCents(r) <= it (a price between two steps leaves the extra cent to the fees, as Steam's own listing
 * calculator does). 115 -> 100, 221 -> 193, 3 -> 1, 116 -> 101, 114 -> 99. Null under scmBuyerPaysCents(1) (3 cents),
 * for a non-integer, or above FEE_MAX_CENTS. Starts from floor(p x 10,000 / 11,500) and steps at most a few cents.
 */
export function scmSellerNetCents(buyerPaysCents: number, rule: ScmFeeRule = SCM_FEE_RULE): number | null {
  if (!centsIn(buyerPaysCents)) return null;
  const least = scmBuyerPaysCents(1, rule);
  if (least === null || buyerPaysCents < least) return null;
  let r = Math.max(1, Math.min(FEE_MAX_CENTS, Math.floor((buyerPaysCents * 10_000) / (10_000 + rule.steamBps + rule.gameBps))));
  while (r > 1 && (scmBuyerPaysCents(r, rule) ?? Infinity) > buyerPaysCents) r--;
  while (r < FEE_MAX_CENTS && (scmBuyerPaysCents(r + 1, rule) ?? Infinity) <= buyerPaysCents) r++;
  return r;
}

/** 0.9 (#2): mannco.store keeps 5% of the sale price, rounded in the seller's favour, at least 1 cent except on a 1-cent sale. */
export const MANNCO_FEE_BPS = 500;
/** 0.9 (#2): mannco.store's minimum fee in cents (none on a 1-cent sale). */
export const MANNCO_MIN_FEE_CENTS = 1;

/**
 * 0.9 (#2): what a mannco.store seller gets for `priceCents`: price - max(1, floor(price x 5%)), all of a 1-cent sale.
 * 100 -> 95, 101 -> 96, 20 -> 19, 19 -> 18, 2 -> 1, 1 -> 1 (equal to ceil(0.95 x price) from 20 cents). Null for a
 * non-integer or outside 1..FEE_MAX_CENTS. Never decreases.
 */
export function manncoNetCents(priceCents: number): number | null {
  if (!centsIn(priceCents)) return null;
  if (priceCents === 1) return 1;
  return priceCents - Math.max(MANNCO_MIN_FEE_CENTS, Math.floor((priceCents * MANNCO_FEE_BPS) / 10_000));
}

/** 0.9 (#2): profit.marketplaceFeePct's default: about 10% (one 2019 forum comment, RESEARCH §4.3). */
export const MARKETPLACE_FEE_DEFAULT = 0.1;
/** 0.9 (#2): profit.marketplaceFeePct's upper bound (the settings schema's max). */
export const MARKETPLACE_FEE_MAX = 0.5;

/** 0.9 (#2): a marketplace.tf fee setting as applied: a finite number in [0, 0.5], else MARKETPLACE_FEE_DEFAULT. */
export function marketplaceFeeOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MARKETPLACE_FEE_MAX ? v : MARKETPLACE_FEE_DEFAULT;
}

const USD_RE = /^\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:USD)?\s*$/i;

/**
 * 0.9 (#2): priceoverview's dollar text ("$2.21", "$1,234.56"; the mock's "2.21") in cents; null for anything else (another
 * currency, empty, a negative, more than 2 decimals, over FEE_MAX_CENTS).
 */
export function parseUsdCents(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = USD_RE.exec(text);
  if (!m) return null;
  const cents = Number(m[1]!.replace(/,/g, '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= FEE_MAX_CENTS ? cents : null;
}

/** 0.9 (#2): cents as dollar text, "$1.15". */
export function usdText(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "10%", "12.5%". */
function pctText(ratio: number): string {
  return `${+(ratio * 100).toFixed(2)}%`;
}

// The sale hints are built from the rules above, so their examples can never drift.
const usd = (cents: number | null): string => (cents === null ? '?' : usdText(cents));
const SCM_SELL_HINT =
  `The Steam Market keeps 5% (Steam) and 10% (TF2) of what you get, each rounded down to the cent and at least $0.01, in Steam Wallet funds, not cash: ` +
  `the buyer pays ${usd(scmBuyerPaysCents(100))} for ${usdText(100)} to you, ${usd(scmBuyerPaysCents(193))} for ${usdText(193)} and ${usd(scmBuyerPaysCents(1))} for ${usdText(1)}. ` +
  'Enter that cut in keys or metal, at the value you log the sale at.';
const MANNCO_SELL_HINT =
  `mannco.store keeps 5% of the sale price, rounded in your favour and at least $0.01 (none on a $0.01 sale): a ${usdText(100)} sale pays you ${usd(manncoNetCents(100))}, a ${usdText(10)} sale ${usd(manncoNetCents(10))}. ` +
  'Enter that cut in keys or metal, at the value you log the sale at.';
function marketplaceSellHint(pct: number): string {
  return `marketplace.tf keeps about ${pctText(pct)} of the sale price (your setting under Settings > Profit thresholds; about 10% rests on a 2019 forum report). Enter that cut in keys or metal, at the value you log the sale at.`;
}

/** By canonical venue: a hint for either side, or one for a sale only (a buy there gets none). marketplace.tf: venueFeeHint. */
const HINTS: ReadonlyMap<string, { any?: string; sell?: string }> = new Map([
  [SCRAPTF, { any: 'scrap.tf charges no documented fee: enter 0 to record none.' }],
  [BACKPACK, { any: 'A backpack.tf trade has no platform fee: enter 0 to record none.' }],
  [DIRECT, { any: 'A direct trade has no platform fee: enter 0 to record none.' }],
  [MANNCO, { sell: MANNCO_SELL_HINT }],
  [STEAM_MARKET, { sell: SCM_SELL_HINT }],
]);

/**
 * Brief §5.4's fee hint for a venue (text shown beside the Fees field, never a filled-in value): scrap.tf,
 * backpack.tf and a direct trade on either side, marketplace.tf, mannco.store and the Steam Market on a sale,
 * marketplace.tf by the user's fee setting (marketplaceFeeOf). null for a write-off and for any other venue.
 */
export function venueFeeHint(venue: unknown, side: JournalSide, marketplaceFeePct?: number): string | null {
  if (side === 'writeoff') return null;
  const label = venueLabel(venue);
  if (label === MARKETPLACE) return side === 'sell' ? marketplaceSellHint(marketplaceFeeOf(marketplaceFeePct)) : null;
  const h = HINTS.get(label);
  if (!h) return null;
  return h.any ?? (side === 'sell' ? (h.sell ?? null) : null);
}
