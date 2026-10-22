// 0.8 (H3, PC-7): the ask side of a held copy or the drawer's item: what other sellers ask for the same copy on
// backpack.tf. Local reads only: the sell listings stored for watched items (the live feed keeps them,
// liveFeed.keepSellListings, and snapshots refresh them); nothing is fetched here. An ask is what a seller wants,
// never a price paid, and it is never used in profit, Pay up to or a notification.

import { valueScrap } from '../../shared/currency';
import type { AskCandidate } from '../../shared/holdings';
import type { Listing, Scrap } from '../../shared/types';
import { listingSpecial, type MatchContext } from './matcher';

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * A sell listing is the same copy as the held one: its paint is `paint` (null: a clean copy; the paint is read from
 * the listing's SKU token when its attributes omit it) and it has no spells, parts, custom name or description.
 * Sheen and killstreaker are free (the journal SKU does not record them).
 */
export function askCopyMatches(l: Listing, paint: number | null): boolean {
  const s = listingSpecial(l);
  const want = finite(paint) && paint > 0 ? paint : null;
  return s.paint === want && s.spells.length === 0 && s.parts.length === 0 && !s.customName && !s.customDesc;
}

/**
 * The copy-matched sell listings of a book as ask candidates (askSideOf in src/shared/holdings.ts counts them):
 * intent 'sell' only, valued at `keyScrap` (non-finite keys or metal count as 0), excluded when marketplace.tf,
 * banned, flagged as an impersonator (0.9, #11) or blocklisted (match.blocklist).
 */
export function askCandidatesOf(sells: readonly Listing[], paint: number | null, match: MatchContext, keyScrap: Scrap): AskCandidate[] {
  const out: AskCandidate[] = [];
  for (const l of Array.isArray(sells) ? sells : []) {
    if (!l || l.intent !== 'sell' || !askCopyMatches(l, paint)) continue;
    const keys = finite(l.keys) ? l.keys : 0;
    const metalScrap = finite(l.metalScrap) ? l.metalScrap : 0;
    out.push({
      id: l.id,
      steamid: l.steamid,
      keys,
      metalScrap,
      valueScrap: valueScrap(keys, metalScrap, keyScrap),
      isBot: l.isBot === true,
      lastEventAt: l.lastEventAt,
      excluded: l.isMarketplace === true || l.userBanned === true || l.userImpersonated === true || match.blocklist.has(l.steamid),
    });
  }
  return out;
}
