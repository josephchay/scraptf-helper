// 0.9 (history, RESEARCH #6): how long backpack.tf buy orders stayed at their price while Flip Desk watched the live
// feed: spells of watched, held and scrap.tf-priced items' top orders, Kaplan-Meier with delayed entry. Order
// persistence, never a fill rate (Lo, MacKinlay and Zhang 2002): an order ends for reasons nobody can see.
//
// A spell is one order at one price. Its age origin is backpack.tf's listedAt on the update that opened it (a price
// edit need not reset it, so every text says "listed N ago", never "at this price"); it enters the estimate at its
// first sighting (delayed entry, left truncation) and leaves at its end or where it was last confirmed. 'deleted',
// 'inactive' and 'lowered' are the events; 'raised', 'relisted' and 'unwatched' are censored. Every cut that chose the
// spells (retention, caps, the read's limit) selects on first_seen_at, the entry, never on the end, and the read
// (Repo.orderSpells: the whole-table cap) and spellsEntryCutOf (a capped base) drop the open survivors those prunes of
// ended spells leave, so the estimate stays unbiased. The gates mirror timing's.

import { communityHistoryOf } from './communityHistory';
import { valueScrap } from './currency';
import { rawPriceCompare } from './scraptfLows';
import type {
  BookOrderPersistence,
  CommunityPoint,
  CommunityRow,
  ItemBookHistory,
  Listing,
  OrderPersistence,
  OrderSpell,
  OrderSpellSummary,
  PersistenceScope,
  PersistenceShort,
  PersistenceWindow,
  Scrap,
  UnixMs,
  UnixSec,
} from './types';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * 60 * 60_000;
/**
 * Retention (ended spells only; a followed one is never pruned): age by first_seen_at, per base, whole table, each keeping
 * the newest by first_seen_at. Selecting on entry, never on the end, keeps delayed-entry Kaplan-Meier unbiased (a cut on
 * the end keeps long spells and drops their short siblings).
 */
export const ORDER_SPELLS_MAX_AGE_MS = 60 * DAY_MS;
/** Retention: at most this many ended spells per base SKU (the newest by first_seen_at kept; Repo.pruneOrderSpells). */
export const ORDER_SPELLS_PER_BASE_MAX = 300;
/** Retention: at most this many ended spells in all (the newest by first_seen_at kept; Repo.pruneOrderSpells). */
export const ORDER_SPELLS_MAX_ROWS = 400_000;
/** 'item.bookHistory' reads at most this many spells of an item's book (newest by first_seen_at, for the same reason). */
export const ORDER_SPELLS_DETAIL_MAX = 2_000;
/** 'item.bookHistory' takes at most this many order ids. */
export const BOOK_HISTORY_ORDERS_MAX = 5;

/** H1: an order is followed when worth at least this share of its base's top non-outlier order (consScrap ?? bestScrap). */
export const ORDER_SPELL_FOLLOW_SHARE = 0.7;
/** The tracker writes followed spells' last_seen_at at most this often. */
export const ORDER_SPELL_TOUCH_MS = 10 * MIN_MS;
/** The tracker follows at most this many orders at once (more are not followed; logged once). */
export const ORDER_SPELL_OPEN_MAX = 20_000;
/**
 * H2 (review): a delete or inactive report of a followed order is held this long (and at least to the next status
 * tick): an update of the same id at the same or a higher price in that time is a relist ('relisted', censored).
 */
export const ORDER_SPELL_RELIST_GRACE_MS = 60_000;
/** The waits estimated: 1 h, 1 d, 7 d. */
export const ORDER_PERSISTENCE_HORIZONS_MS: readonly number[] = [HOUR_MS, DAY_MS, 7 * DAY_MS];
/** Followed just after the order's age needed (as SCRAPTF_TIMING_MIN_AT_RISK's role). */
export const ORDER_PERSISTENCE_MIN_AT_RISK = 8;
/** Followed at every point of the window, its end included, needed (as SCRAPTF_TIMING_MIN_AT_RISK_END). */
export const ORDER_PERSISTENCE_MIN_AT_RISK_END = 3;
/** 'like' and 'band': within this share of the order's value. */
export const ORDER_PERSISTENCE_VALUE_BAND = 0.15;
/** Every persistence text's caveat: order persistence, not sales; relists are not ends; the age is bp.tf's listing time. */
export const ORDER_PERSISTENCE_NOTE =
  "Order persistence, not sales: an order can end because it bought an item, or because its owner removed or repriced it or ran out of currency. A bot that deletes and re-posts the same order within a minute is not counted as an end. The age is the time since backpack.tf's listing time, which a price edit need not reset. From what Flip Desk saw while the live feed ran; never a forecast.";

/** One spell on the age scale (ms since listedAt). */
export interface SpellObservation {
  entry: number;
  exit: number;
  event: boolean;
  isBot: boolean;
  valueScrap: Scrap;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * H1 (D9): a buy order the tracker follows: a buy order, not marketplace, not banned, not flagged as an impersonator,
 * with a price (a keyed one needs a key price), worth at least ceil(ORDER_SPELL_FOLLOW_SHARE * topScrap); false without
 * a top. Lowball orders persist for months and never matter for an exit.
 */
export function orderSpellFollows(
  l: Pick<Listing, 'intent' | 'isMarketplace' | 'userBanned' | 'keys' | 'metalScrap'> & Partial<Pick<Listing, 'userImpersonated'>>,
  topScrap: Scrap | null,
  keyScrap: Scrap,
): boolean {
  if (l.intent !== 'buy' || l.isMarketplace || l.userBanned || l.userImpersonated === true) return false;
  const keys = finite(l.keys) && l.keys > 0 ? l.keys : 0;
  const metal = finite(l.metalScrap) && l.metalScrap > 0 ? l.metalScrap : 0;
  if (keys === 0 && metal === 0) return false;
  if (keys > 0 && !(finite(keyScrap) && keyScrap > 0)) return false;
  if (topScrap === null || !finite(topScrap) || topScrap <= 0) return false;
  return valueScrap(keys, metal, keys > 0 ? keyScrap : 0) >= Math.ceil(ORDER_SPELL_FOLLOW_SHARE * topScrap);
}

/** H2: an update of a followed order against its spell's price: the same raw price is 'same', else lowered / raised by rawPriceCompare. */
export function orderSpellEndOf(prev: { keys: number; metalScrap: Scrap }, next: { keys: number; metalScrap: Scrap }, keyScrap: Scrap): 'same' | 'lowered' | 'raised' {
  if (prev.keys === next.keys && prev.metalScrap === next.metalScrap) return 'same';
  return rawPriceCompare({ keys: next.keys, scrap: next.metalScrap }, { keys: prev.keys, scrap: prev.metalScrap }, keyScrap) < 0 ? 'lowered' : 'raised';
}

/**
 * H5: a spell on the age scale (ms since its listedAt): entry at its first sighting (0 when bp.tf's clock is ahead of
 * ours), exit at its end (an ended spell's endAt) or where it was last confirmed; 'deleted', 'inactive' and 'lowered'
 * are events. Null without a listedAt or for a zero-length observation (it carries nothing). Valued at keyScrap (0 or
 * less: keys count 0).
 */
export function spellObservationOf(s: OrderSpell, keyScrap: Scrap): SpellObservation | null {
  if (!finite(s.listedAt)) return null;
  const origin = s.listedAt * 1000;
  const entry = Math.max(0, s.firstSeenAt - origin);
  const exitAt = s.endKind !== null && finite(s.endAt) ? s.endAt : s.lastSeenAt;
  const exit = exitAt - origin;
  if (!finite(entry) || !finite(exit) || !(exit > entry)) return null;
  return {
    entry,
    exit,
    event: s.endKind === 'deleted' || s.endKind === 'inactive' || s.endKind === 'lowered',
    isBot: s.isBot,
    valueScrap: valueScrap(s.keys, s.metalScrap, finite(keyScrap) && keyScrap > 0 ? keyScrap : 0),
  };
}

/** Sorted entries, exits and event exits of one pool of observations: each risk count is then a binary search. */
interface ObsIndex {
  entries: number[];
  exits: number[];
  eventExits: number[];
}

function indexOf(obs: readonly SpellObservation[]): ObsIndex {
  const asc = (x: number, y: number): number => x - y;
  return {
    entries: obs.map((o) => o.entry).sort(asc),
    exits: obs.map((o) => o.exit).sort(asc),
    eventExits: obs.filter((o) => o.event).map((o) => o.exit).sort(asc),
  };
}

/** How many of `sorted` are below `t` (strict) or at most `t`. */
function countBelow(sorted: readonly number[], t: number, orEqual: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < t || (orEqual && sorted[mid] === t)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function windowOn(ix: ObsIndex, a: number, H: number): PersistenceWindow | Exclude<PersistenceShort, 'no-listed-time'> {
  // Followed just after x (entered by x, not left by x); followed at t (entered before t, not left before t). Both are
  // differences of counts because every observation has entry < exit.
  const riskAfter = (x: number): number => countBelow(ix.entries, x, true) - countBelow(ix.exits, x, true);
  const riskAt = (t: number): number => countBelow(ix.entries, t, false) - countBelow(ix.exits, t, false);
  const atRisk = riskAfter(a);
  if (atRisk < ORDER_PERSISTENCE_MIN_AT_RISK) return 'few-at-risk';
  const end = a + H;
  let minAtRisk = Math.min(atRisk, riskAt(end));
  // Every exit strictly inside the window: the pool just after it.
  for (let i = countBelow(ix.exits, a, true); i < ix.exits.length && ix.exits[i]! < end; i++) {
    const x = ix.exits[i]!;
    if (i > 0 && ix.exits[i - 1] === x) continue;
    minAtRisk = Math.min(minAtRisk, riskAfter(x));
  }
  if (minAtRisk < ORDER_PERSISTENCE_MIN_AT_RISK_END) return 'past-the-data';
  let p = 1;
  let ended = 0;
  let i = countBelow(ix.eventExits, a, true);
  while (i < ix.eventExits.length && ix.eventExits[i]! <= end) {
    const tau = ix.eventExits[i]!;
    let d = 0;
    while (i < ix.eventExits.length && ix.eventExits[i] === tau) {
      d++;
      i++;
    }
    p *= 1 - d / riskAt(tau);
    ended += d;
  }
  return { horizonMs: H, p, atRisk, minAtRisk, ended };
}

/**
 * H6: Kaplan-Meier with delayed entry over `obs`: of the spells followed just after age `ageMs`, the share still up at
 * their price (or higher) `horizonMs` later, the product of (1 - d / at risk) over the event exits in (age, age + H].
 * 'few-at-risk' below ORDER_PERSISTENCE_MIN_AT_RISK followed at the age; 'past-the-data' when fewer than
 * ORDER_PERSISTENCE_MIN_AT_RISK_END are followed at some point of the window, its end included. O((n + k) log n).
 */
export function persistenceWindowOf(obs: readonly SpellObservation[], ageMs: number, horizonMs: number): PersistenceWindow | Exclude<PersistenceShort, 'no-listed-time'> {
  return windowOn(indexOf(obs), ageMs, horizonMs);
}

const SCOPES: readonly PersistenceScope[] = ['like', 'band', 'all'];

/**
 * H6: one order's persistence at its age (now - listedAt). The scope ladder like (same bot flag, value within
 * ORDER_PERSISTENCE_VALUE_BAND) -> band (value only) -> all: the first scope whose 1 h window passes, then every horizon
 * in that scope that passes. Without a listedAt: 'no-listed-time'; when no scope passes: the 'all' scope's 1 h reason.
 */
export function orderPersistenceOf(
  spells: readonly OrderSpell[],
  order: { valueScrap: Scrap; isBot: boolean; listedAt: UnixSec | null },
  keyScrap: Scrap,
  now: UnixMs,
): OrderPersistence {
  if (!finite(order.listedAt)) return { ageMs: null, scope: null, windows: [], short: 'no-listed-time' };
  const age = Math.max(0, now - order.listedAt * 1000);
  const obs: SpellObservation[] = [];
  for (const s of spells) {
    const o = spellObservationOf(s, keyScrap);
    if (o) obs.push(o);
  }
  const v = order.valueScrap;
  const inBand = (x: number): boolean => v > 0 && Math.abs(x - v) <= ORDER_PERSISTENCE_VALUE_BAND * v;
  let short: Exclude<PersistenceShort, 'no-listed-time'> = 'few-at-risk';
  for (const scope of SCOPES) {
    const list = scope === 'like' ? obs.filter((o) => o.isBot === order.isBot && inBand(o.valueScrap)) : scope === 'band' ? obs.filter((o) => inBand(o.valueScrap)) : obs;
    const ix = indexOf(list);
    const first = windowOn(ix, age, ORDER_PERSISTENCE_HORIZONS_MS[0]!);
    if (typeof first === 'string') {
      short = first;
      continue;
    }
    const windows: PersistenceWindow[] = [first];
    for (const H of ORDER_PERSISTENCE_HORIZONS_MS.slice(1)) {
      const w = windowOn(ix, age, H);
      if (typeof w !== 'string') windows.push(w);
    }
    return { ageMs: age, scope, windows, short: null };
  }
  // `short` is the last scope's: 'all'.
  return { ageMs: age, scope: null, windows: [], short };
}

/** The followed spells of an item's book, per end kind (null: open), with the spells without a listedAt, the oldest entry and the time observed. */
export function orderSpellSummaryOf(spells: readonly OrderSpell[]): OrderSpellSummary {
  const out: OrderSpellSummary = {
    followed: spells.length,
    open: 0,
    deleted: 0,
    inactive: 0,
    lowered: 0,
    raised: 0,
    relisted: 0,
    unwatched: 0,
    noListedTime: 0,
    since: null,
    observedMs: 0,
  };
  for (const s of spells) {
    if (s.endKind === null) out.open++;
    else out[s.endKind]++;
    if (!finite(s.listedAt)) out.noListedTime++;
    if (finite(s.firstSeenAt) && (out.since === null || s.firstSeenAt < out.since)) out.since = s.firstSeenAt;
    const span = s.lastSeenAt - s.firstSeenAt;
    if (finite(span)) out.observedMs += Math.max(0, span);
  }
  return out;
}

/**
 * Review: per base, when the input holds at least ORDER_SPELLS_PER_BASE_MAX ended spells of it (its cap may have pruned
 * older ones), that base's spells (open or ended) first seen at or before the entry of its ORDER_SPELLS_PER_BASE_MAX-th
 * newest ended spell are left out: an open spell whose ended siblings were pruned is a survivor. The cap keeps the
 * newest ORDER_SPELLS_PER_BASE_MAX ended spells by entry, so this cut is at or after every boundary it drew, also once a
 * followed spell it left behind has ended (it is then the oldest ended spell, so the oldest is no cut); a batch opened
 * at the boundary instant goes whole (the cap split it by id and kept all its open spells). A cut on entry time only,
 * so the estimate stays unbiased. (The whole-table cap's cut is Repo.orderSpells'.)
 */
export function spellsEntryCutOf(spells: readonly OrderSpell[]): OrderSpell[] {
  const ended = new Map<string, number[]>();
  for (const s of spells) {
    if (s.endKind === null) continue;
    const e = ended.get(s.baseSku);
    if (e) e.push(s.firstSeenAt);
    else ended.set(s.baseSku, [s.firstSeenAt]);
  }
  const cut = new Map<string, number>();
  for (const [base, entries] of ended) {
    if (entries.length < ORDER_SPELLS_PER_BASE_MAX) continue;
    entries.sort((x, y) => y - x);
    cut.set(base, entries[ORDER_SPELLS_PER_BASE_MAX - 1]!);
  }
  if (cut.size === 0) return [...spells];
  return spells.filter((s) => {
    const c = cut.get(s.baseSku);
    return c === undefined || s.firstSeenAt > c;
  });
}

/**
 * 'item.bookHistory' (H11): the book's spell summary (every spell), the persistence of each of the first
 * BOOK_HISTORY_ORDERS_MAX asked orders found as buy orders (valued at the key price, over the spells left after
 * spellsEntryCutOf) and the recorded community prices (communityHistoryOf).
 */
export function itemBookHistoryOf(a: {
  sku: string;
  bases: readonly string[];
  spells: readonly OrderSpell[];
  points: readonly CommunityPoint[];
  current: CommunityRow | null;
  orders: readonly { listingId: string; listing: Pick<Listing, 'intent' | 'keys' | 'metalScrap' | 'isBot' | 'listedAt'> | null }[];
  keyScrap: Scrap | null;
  now: UnixMs;
}): ItemBookHistory {
  const K = a.keyScrap !== null && finite(a.keyScrap) && a.keyScrap > 0 ? a.keyScrap : 0;
  const kept = spellsEntryCutOf(a.spells);
  const orders: BookOrderPersistence[] = [];
  for (const o of a.orders) {
    if (orders.length >= BOOK_HISTORY_ORDERS_MAX) break;
    const l = o.listing;
    if (!l || l.intent !== 'buy') continue;
    const v = valueScrap(l.keys, l.metalScrap, K);
    const listedAt = l.listedAt ?? null;
    orders.push({ listingId: o.listingId, isBot: l.isBot, valueScrap: v, listedAt, persistence: orderPersistenceOf(kept, { valueScrap: v, isBot: l.isBot, listedAt }, K, a.now) });
  }
  return {
    sku: a.sku,
    bases: [...a.bases],
    summary: orderSpellSummaryOf(a.spells),
    orders,
    community: communityHistoryOf(a.points, a.current),
    keyScrap: K > 0 ? K : null,
    generatedAt: a.now,
  };
}
