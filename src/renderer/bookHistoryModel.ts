// Pure helpers for the item drawer's "Order book history" section (0.9, RESEARCH #6/#7,
// components/BookHistorySection.tsx), and the scrap.tf low line of the drawer's scrap.tf history block and the bank
// stock price hover. Everything comes from one local 'item.bookHistory' read or from the user's saves.
//
// - How long buy orders stay: Kaplan-Meier with delayed entry over the order-price spells Flip Desk followed on the
//   live feed (shared/orderPersistence.ts). It is order persistence, never a fill rate: an order ends for reasons
//   nobody can see. n is always shown, the age is "listed N ago" (backpack.tf's listing time, which a price edit need
//   not reset), never "at this price", and "not enough data" says why.
// - The recorded community price: backpack.tf's accepted price suggestions, not sales, as a step chart.
// - The scrap.tf low: the lowest price the copy showed on sale in the user's saves, with when and since when; what
//   happened between two saves is unknown.
// Nothing here loads, opens or writes anything (R1, R4).

import { communityValueScrap } from '../shared/communityHistory';
import { ORDER_PERSISTENCE_HORIZONS_MS, ORDER_PERSISTENCE_NOTE, ORDER_SPELLS_MAX_AGE_MS, ORDER_SPELLS_MAX_ROWS, ORDER_SPELLS_PER_BASE_MAX } from '../shared/orderPersistence';
import type {
  BookOrderPersistence,
  CommunityHistory,
  CommunityHistoryStep,
  OrderSpellSummary,
  OrderSummary,
  PersistenceScope,
  PersistenceShort,
  Scrap,
  ScraptfCopyLow,
  ScraptfItemHistory,
  UnixMs,
} from '../shared/types';
import { DASH, fmtAge, fmtDate, fmtInt, fmtKeysMetal, fmtMoney, fmtSignedMoney } from './format';
import { historyBankPath, type HistoryLine, type StepPoint } from './historyModel';

const DAY_MS = 86_400_000;

/** The section re-reads on 'market.changed' at most this often, and only while the window is shown. */
export const BOOK_HISTORY_REFRESH_MS = 30_000;
/** The drawer asks for at most this many of its buy orders. */
export const BOOK_HISTORY_ORDERS_SHOWN = 3;
/** A persistence line's scope, short ("est. 82 % of orders like it still up 1 d later"). */
export const PERSISTENCE_SCOPE_SHORT: Record<PersistenceScope, string> = { like: 'orders like it', band: 'orders near its price', all: "this item's orders" };
/** A persistence line's scope in its hover: which followed spells the estimate pools. */
export const PERSISTENCE_SCOPE_WORDS: Record<PersistenceScope, string> = {
  like: 'Orders like it (the same kind, bot or human, within 15 % of its price)',
  band: 'Orders within 15 % of its price',
  all: 'Every order-price spell Flip Desk followed for this item',
};
/** Why an order has no estimate (OrderPersistence.short): "not enough data" is an answer with its reason. */
export const PERSISTENCE_SHORT_WORDS: Record<PersistenceShort, string> = {
  'no-listed-time': 'backpack.tf gave no listing time for it',
  'few-at-risk': 'too few order-price spells followed at its age',
  'past-the-data': 'too few order-price spells followed that long',
};
/** The scrap.tf low's caveat: where it comes from, and that the saves are snapshots. */
export const SCRAPTF_LOW_NOTE = 'From every save Flip Desk kept and, from 0.9, the lowest of every save; what happened between two saves is unknown.';
/** The section's text before anything was followed: what is recorded, and when. */
export const BOOK_HISTORY_NOTHING_FOLLOWED =
  'Nothing followed yet: Flip Desk records how long the top buy orders of items you price, hold or watch stay at their price while the live feed runs.';

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The drawer's buy orders to ask about: eligible, not 'outlier', one per steamid, in the drawer's order, at most BOOK_HISTORY_ORDERS_SHOWN. */
export function bookHistoryOrderIds(orders: readonly OrderSummary[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of Array.isArray(orders) ? orders : []) {
    if (out.length >= BOOK_HISTORY_ORDERS_SHOWN) break;
    if (!o || !o.eligible || (Array.isArray(o.flags) && o.flags.includes('outlier'))) continue;
    if (typeof o.listingId !== 'string' || o.listingId === '' || seen.has(o.steamid)) continue;
    seen.add(o.steamid);
    out.push(o.listingId);
  }
  return out;
}

/** Who a persistence line names: the matching drawer order's userName, else 'Bot' / 'Human' (by the answer's own bot flag). */
export function bookOrderWho(o: Pick<BookOrderPersistence, 'listingId' | 'isBot'>, orders: readonly Pick<OrderSummary, 'listingId' | 'userName'>[]): string {
  const name = orders.find((x) => x.listingId === o.listingId)?.userName;
  return name && name.trim() !== '' ? name : o.isBot ? 'Bot' : 'Human';
}

/** "82 %" (rounded, clamped to 0..100); DASH when not a number. */
export function fmtPersistencePct(p: number): string {
  if (!finite(p)) return DASH;
  return `${Math.round(Math.min(100, Math.max(0, p * 100)))} %`;
}

/**
 * The followed spells of the item's book, counted per end, worded as order-price spells (one order counts again after
 * each price change or feed restart; D9's inactive and the review's re-posted clauses only when non-zero). null when
 * nothing was followed.
 */
export function bookHistorySummaryText(s: OrderSpellSummary): string | null {
  if (!s || !(s.followed > 0)) return null;
  const { followed, deleted, inactive, lowered, raised, relisted, open, unwatched } = s;
  return (
    `Followed ${fmtInt(followed)} order-price ${followed === 1 ? 'spell' : 'spells'} of this item's buy orders since ${fmtDate(s.since)} ` +
    `(one order counts again after each price change or feed restart): ${fmtInt(deleted)} removed, ` +
    `${inactive > 0 ? `${fmtInt(inactive)} turned inactive, ` : ''}${fmtInt(lowered)} lowered, ${fmtInt(raised)} raised, ` +
    `${relisted > 0 ? `${fmtInt(relisted)} re-posted, ` : ''}${fmtInt(open + unwatched)} still up when last seen.`
  );
}

/** Review: the summary's hover: how far back the kept spells reach (the caps usually set it); null when nothing was followed. */
export function bookHistorySummaryTitle(s: OrderSpellSummary): string | null {
  if (!s || !(s.followed > 0)) return null;
  return (
    `Kept ${fmtInt(ORDER_SPELLS_MAX_AGE_MS / DAY_MS)} days, or less where the per-item (${fmtInt(ORDER_SPELLS_PER_BASE_MAX)}) or total (${fmtInt(ORDER_SPELLS_MAX_ROWS)}) caps bind: ` +
    `${fmtDate(s.since)} is how far back it reaches. ${ORDER_PERSISTENCE_NOTE}`
  );
}

/**
 * One order's line: "<who> at <price> · listed 3 h ago · est. 82 % of orders like it still up 1 d later" (the longest
 * horizon that passed; 'warn' under 50 %), with every horizon's n (spells followed at its age, ended) in the hover;
 * "not enough data (<reason>)" or "how long it stays: unknown" otherwise. Never a fill rate, never a forecast.
 */
export function orderPersistenceLine(o: BookOrderPersistence, who: string, keyScrap: Scrap | null): HistoryLine {
  const at = `${who} at ${fmtMoney(o.valueScrap, keyScrap)}`;
  const p = o.persistence;
  if (p.ageMs === null) {
    return { text: `${at} · how long it stays: unknown (${PERSISTENCE_SHORT_WORDS['no-listed-time']})`, tone: 'muted', title: ORDER_PERSISTENCE_NOTE };
  }
  const w = p.windows.length > 0 ? p.windows.reduce((m, x) => (x.horizonMs > m.horizonMs ? x : m)) : null;
  if (p.scope === null || w === null) {
    return { text: `${at} · listed ${fmtAge(p.ageMs)} ago · not enough data (${PERSISTENCE_SHORT_WORDS[p.short ?? 'few-at-risk']})`, tone: 'muted', title: ORDER_PERSISTENCE_NOTE };
  }
  const per = ORDER_PERSISTENCE_HORIZONS_MS.map((H) => {
    const x = p.windows.find((v) => v.horizonMs === H);
    return x
      ? `${fmtAge(H)} later ${fmtPersistencePct(x.p)} still up (${fmtInt(x.atRisk)} order-price spells followed, ${fmtInt(x.ended)} ended)`
      : `${fmtAge(H)} later: not enough data`;
  }).join('; ');
  return {
    text: `${at} · listed ${fmtAge(p.ageMs)} ago · est. ${fmtPersistencePct(w.p)} of ${PERSISTENCE_SCOPE_SHORT[p.scope]} still up ${fmtAge(w.horizonMs)} later`,
    tone: w.p < 0.5 ? 'warn' : 'muted',
    title:
      `${PERSISTENCE_SCOPE_WORDS[p.scope]}, at the same listing age (listed ${fmtAge(p.ageMs)} ago by backpack.tf's listing time, which a price edit need not reset): ` +
      `${per}. Kaplan-Meier with delayed entry over the orders Flip Desk followed. ${ORDER_PERSISTENCE_NOTE}`,
  };
}

/** The chart's points: each step at its low value (communityValueScrap), held to `now` (null value: a gap). */
export function communityChartPoints(h: CommunityHistory, keyScrap: Scrap | null, now: UnixMs): StepPoint[] {
  const pts: StepPoint[] = (h?.steps ?? []).filter((s) => s && finite(s.at)).map((s) => ({ at: s.at, value: communityValueScrap(s.currency, s.value, keyScrap) }));
  const last = pts[pts.length - 1];
  if (last && finite(now) && now > last.at) pts.push({ at: now, value: last.value });
  return pts;
}

/** The chart's readout for one step: "2026-10-14 · 23.22–29.33 ref · the live feed" ('' without a step). */
export function communityReadout(s: CommunityHistoryStep | undefined, keyScrap: Scrap | null): string {
  if (!s) return '';
  const high = finite(s.valueHigh) && s.valueHigh !== s.value ? s.valueHigh : null;
  let range: string;
  if (s.currency === 'metal') {
    range = high === null ? `${s.value.toFixed(2)} ref` : `${s.value.toFixed(2)}–${high.toFixed(2)} ref`;
  } else if (s.currency === 'keys') {
    range = high === null ? `${s.value} keys` : `${s.value}–${high} keys`;
    if (finite(keyScrap) && keyScrap > 0) range += ` (≈ ${fmtMoney(communityValueScrap('keys', s.value, keyScrap), keyScrap)} at today's key price)`;
  } else {
    range = `${s.value} ${s.currency}`;
  }
  const feed = s.sources.includes('feed');
  const prices = s.sources.includes('prices');
  const src = s.recordedAt === null ? 'backpack.tf now' : feed && prices ? 'IGetPrices and the live feed' : feed ? 'the live feed' : 'IGetPrices';
  return `${fmtDate(s.at)} · ${range} · ${src}`;
}

/** "backpack.tf community price: 4 prices recorded since 2026-06-24."; null without steps. */
export function communitySinceText(h: CommunityHistory): string | null {
  const steps = h?.steps ?? [];
  if (steps.length === 0) return null;
  const n = steps.length;
  return `backpack.tf community price: ${fmtInt(n)} ${n === 1 ? 'price' : 'prices'} recorded since ${fmtDate(h.since ?? steps[0]!.at)}.`;
}

/**
 * The drawer's scrap.tf history line for the copy's low (null without a bank or a low): 'good' when the price now is
 * the lowest the saves have shown since the low's `since`, else the low with when and how far now is above it.
 */
export function scraptfLowLine(h: Pick<ScraptfItemHistory, 'bank' | 'current' | 'low'>, keyScrap: Scrap | null): HistoryLine | null {
  const low = h?.low;
  const path = historyBankPath(h);
  if (!low || !path) return null;
  const when = low.firstAt === low.lastAt ? fmtDate(low.firstAt) : `${fmtDate(low.firstAt)} to ${fmtDate(low.lastAt)}`;
  const current = h.current;
  if (current && current.costScrap <= low.valueScrap) {
    return {
      text: `Lowest in your saves since ${fmtDate(low.since)}`,
      tone: 'good',
      title: `scrap.tf's price now (${fmtMoney(current.costScrap, keyScrap)}) is the lowest your saves of ${path} have shown for this copy since ${fmtDate(low.since)}, at today's key price. ${SCRAPTF_LOW_NOTE}`,
    };
  }
  const title = `The lowest price your saves of ${path} showed for this copy since ${fmtDate(low.since)}: ${fmtKeysMetal(low.keys, low.scrap)}, ${when}, ${fmtMoney(low.valueScrap, keyScrap)} at today's key price. ${SCRAPTF_LOW_NOTE}`;
  if (current) {
    return {
      text: `Lowest in your saves: ${fmtMoney(low.valueScrap, keyScrap)} (${when}) · now ${fmtSignedMoney(current.costScrap - low.valueScrap, keyScrap)}`,
      tone: 'muted',
      title,
    };
  }
  return { text: `Lowest in your saves: ${fmtMoney(low.valueScrap, keyScrap)} (${when})`, tone: 'muted', title };
}

/** The bank stock price hover's sentence (leading space), '' without a low. */
export function scraptfLowSentence(low: ScraptfCopyLow | null | undefined, costScrap: Scrap, keyScrap: Scrap | null): string {
  if (!low) return '';
  if (costScrap <= low.valueScrap) return ` The lowest price in your saves of this bank since ${fmtDate(low.since)}.`;
  return ` Lowest in your saves of this bank: ${fmtMoney(low.valueScrap, keyScrap)} on ${fmtDate(low.firstAt)} (since ${fmtDate(low.since)}).`;
}
