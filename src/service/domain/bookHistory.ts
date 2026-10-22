// 0.9 (history): 'item.bookHistory', local reads only: order_spells and bptf_community_history of the item's book bases,
// its stored community price, and the asked orders' rows in the local book. Nothing is fetched.
//
// The asked listing ids come from the drawer's own OrderSummary objects; they are looked up locally (for their
// listedAt, H11) and never stored or logged.

import { ORDER_SPELLS_MAX_AGE_MS, BOOK_HISTORY_ORDERS_MAX, itemBookHistoryOf } from '../../shared/orderPersistence';
import type { ItemBookHistory, Listing, Scrap, UnixMs } from '../../shared/types';
import type { Repo, SchemaService } from '../contracts';
import { bookBasesOf } from './bookTwins';

/**
 * 'item.bookHistory' (H11): the spells of every base of `base`'s book (bookBasesOf) first seen within
 * ORDER_SPELLS_MAX_AGE_MS (and after the whole-table cap's entry cut, which Repo.orderSpells applies), their recorded
 * community points, the base's stored community price, and the first
 * BOOK_HISTORY_ORDERS_MAX distinct asked ids found in the local book as buy orders of one of those bases, read through
 * itemBookHistoryOf. A sell listing, a foreign base's order and an unknown id are left out.
 */
export function readItemBookHistory(a: {
  repo: Pick<Repo, 'orderSpells' | 'communityHistory' | 'getCommunity' | 'getListing'>;
  schema: Pick<SchemaService, 'bookBases' | 'bookBase'> | null;
  base: string;
  orders: readonly string[];
  keyScrap: Scrap | null;
  now: UnixMs;
}): ItemBookHistory {
  const bases = [...bookBasesOf(a.schema, a.base)];
  const ids = [...new Set(a.orders)].slice(0, BOOK_HISTORY_ORDERS_MAX);
  const spells = a.repo.orderSpells(bases, a.now - ORDER_SPELLS_MAX_AGE_MS);
  const points = a.repo.communityHistory(bases);
  const current = a.repo.getCommunity(a.base);
  const orders = ids.map((listingId) => {
    const l: Listing | null = a.repo.getListing(listingId);
    return { listingId, listing: l && l.intent === 'buy' && bases.includes(l.baseSku) ? l : null };
  });
  return itemBookHistoryOf({ sku: a.base, bases, spells, points, current, orders, keyScrap: a.keyScrap, now: a.now });
}
