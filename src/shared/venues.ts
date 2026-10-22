// One journal venue list and the rules that read it (0.8: J2, J4), shared by the Record trade dialog, the Journal
// page and its reports, core's ACT-3 newest scrap.tf buy and the mock. Stored venues are free text and are never
// rewritten; aliases are folded when read. Fee hints are static text from DESIGN_BRIEF §5.4, shown next to the Fees
// field and never filled in. The file contains no URL and no scrap.tf address (the static.test.ts R1 scan).

import { HOLDING_EXIT_VENUES, type JournalSide } from './types';

const SCRAPTF = HOLDING_EXIT_VENUES.scraptf;
const BACKPACK = HOLDING_EXIT_VENUES.backpack;
const MARKETPLACE = 'marketplace.tf';
const STEAM_MARKET = 'Steam Community Market';
const DIRECT = 'Direct trade';
const OTHER = 'other';

/** The venue datalist everywhere (anything else can be typed). */
export const JOURNAL_VENUES: readonly string[] = [SCRAPTF, BACKPACK, MARKETPLACE, STEAM_MARKET, DIRECT, OTHER];
/** A write-off's venue (it has no counterparty). */
export const WRITE_OFF_VENUE = 'Written off';
/** venueLabel of an empty or unreadable venue. */
export const UNKNOWN_VENUE_LABEL = 'Unknown';

/** Each canonical venue and the spellings folded into it, keyed by venueKey (so lower case, single spaces). */
const ALIASES: readonly (readonly [string, readonly string[]])[] = [
  [SCRAPTF, ['scrap.tf', 'scraptf', 'scrap tf', 'scrap']],
  [BACKPACK, ['backpack.tf', 'backpacktf', 'backpack tf', 'backpack', 'bp.tf', 'bptf', 'bp', 'next.backpack.tf']],
  [MARKETPLACE, ['marketplace.tf', 'marketplacetf', 'marketplace tf', 'marketplace', 'mp.tf', 'mptf']],
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

/** By canonical venue: a hint for either side, or one for a sale only (a buy there gets none). */
const HINTS: ReadonlyMap<string, { any?: string; sell?: string }> = new Map([
  [SCRAPTF, { any: 'scrap.tf charges no documented fee: enter 0 to record none.' }],
  [BACKPACK, { any: 'A backpack.tf trade has no platform fee: enter 0 to record none.' }],
  [DIRECT, { any: 'A direct trade has no platform fee: enter 0 to record none.' }],
  [
    MARKETPLACE,
    { sell: 'marketplace.tf keeps about 10% of the sale price (you get about 90%). Enter that cut in keys or metal, at the value you log the sale at.' },
  ],
  [
    STEAM_MARKET,
    {
      sell: 'The Steam Market keeps about 13% (the buyer pays about 1.15× what you get: 5% Steam and 10% TF2, each at least $0.01), in Steam Wallet funds. Enter that cut in keys or metal, at the value you log the sale at.',
    },
  ],
]);

/**
 * Brief §5.4's fee hint for a venue (text shown beside the Fees field, never a filled-in value): scrap.tf,
 * backpack.tf and a direct trade on either side, marketplace.tf and the Steam Market on a sale. null for a
 * write-off and for any other venue.
 */
export function venueFeeHint(venue: unknown, side: JournalSide): string | null {
  if (side === 'writeoff') return null;
  const h = HINTS.get(venueLabel(venue));
  if (!h) return null;
  return h.any ?? (side === 'sell' ? (h.sell ?? null) : null);
}
