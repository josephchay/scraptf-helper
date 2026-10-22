// 0.7.4: how recent a buy order's buyer data is. backpack.tf reports a buyer's online flag with an
// order's feed event or snapshot, and nothing refreshes it later, so past ORDER_CONFIRMED_MS it says
// nothing about now. Shared so the service (confidence, the Live log's buyer tag) and every renderer
// line (Opportunities, drawer, Live market, Holdings, Shopping, Bank stock, Live check) agree, and (0.9, #11) the
// bot service a listing's client names.

import type { OrderSummary, UnixMs } from './types';

/** An order counts as recently confirmed (feed event or snapshot) within this window (CONFIRMED_MS in confidence.ts). */
export const ORDER_CONFIRMED_MS = 2 * 60 * 60 * 1000;

/** 0.8: an order unseen (no feed event or snapshot) for longer is unverified (the service's UNVERIFIED_AFTER_MS, the mock's flags). */
export const ORDER_UNVERIFIED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * 0.7.4 (F13, F21, F47), moved here in 0.8 so the shared advice and the mock use it: the order a held item's sale
 * rests on has had no feed event or snapshot for 24 h: flagged 'unverified' when the row was built, or aged past
 * ORDER_UNVERIFIED_AFTER_MS since. A stamp ahead of `now` counts as recent.
 */
export function unverifiedRevenue(o: Pick<OrderSummary, 'flags' | 'lastEventAt'> | null | undefined, now: UnixMs): boolean {
  if (!o) return false;
  return o.flags.includes('unverified') || !(now - o.lastEventAt <= ORDER_UNVERIFIED_AFTER_MS);
}

/** The order had a feed event or a snapshot within ORDER_CONFIRMED_MS (a stamp ahead of `now` counts, as for the +10). */
export function orderSeenRecently(lastEventAt: number | null | undefined, now: UnixMs): boolean {
  return typeof lastEventAt === 'number' && Number.isFinite(lastEventAt) && now - lastEventAt <= ORDER_CONFIRMED_MS;
}

/** The buyer's online flag while the order is recent, else null (unknown): an old flag is not presence. */
export function buyerOnlineNow(o: Pick<OrderSummary, 'online' | 'lastEventAt'>, now: UnixMs): boolean | null {
  return orderSeenRecently(o.lastEventAt, now) ? (o.online ?? null) : null;
}

/** "42 s", "12 min", "3 h", "4 d" (floored), as the renderer's fmtAge. */
export function seenAgeText(ms: number): string {
  const a = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (a < 60_000) return `${Math.floor(a / 1000)} s`;
  if (a < 3_600_000) return `${Math.floor(a / 60_000)} min`;
  if (a < 86_400_000) return `${Math.floor(a / 3_600_000)} h`;
  return `${Math.floor(a / 86_400_000)} d`;
}

/**
 * The buyer's presence in words: 'online', 'offline' or 'online status unknown' while the order is
 * recent; past ORDER_CONFIRMED_MS 'last seen 4 d ago' (the age of the order's last event).
 */
export function buyerPresenceText(o: Pick<OrderSummary, 'online' | 'lastEventAt'>, now: UnixMs): string {
  if (!Number.isFinite(o.lastEventAt)) return 'online status unknown';
  if (!orderSeenRecently(o.lastEventAt, now)) return `last seen ${seenAgeText(now - o.lastEventAt)} ago`;
  return o.online === true ? 'online' : o.online === false ? 'offline' : 'online status unknown';
}

/**
 * 0.9 (#11): bot services by the first part (before " - ") of a listing's userAgent.client. The 2026-10-14 capture's 253
 * bot events: TF2AutobotPriceDB 94, TF2Autobot 61, Gladiator.tf 21, cobra.tf 16, Dolphin 6, Merchant.TF 6,
 * Quicksell.store 2, and the literal "User Agent" 47, which names none. A label only: no score, flag or exit rule reads it.
 */
export const BOT_SERVICES: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/^TF2AutobotPriceDB$/i, 'TF2Autobot (PriceDB)'],
  [/^TF2Autobot$/i, 'TF2Autobot'],
  [/^Gladiator\.tf$/i, 'Gladiator.tf'],
  [/^cobra\.tf$/i, 'cobra.tf'],
  [/^Dolphin$/i, 'Dolphin'],
  [/^Merchant\.TF$/i, 'Merchant.TF'],
  [/^Quicksell\.store$/i, 'Quicksell.store'],
] as const);

/** 0.9 (#11): the BOT_SERVICES label of a userAgent.client text; null for anything else. */
export function botServiceOf(uaClient: unknown): string | null {
  if (typeof uaClient !== 'string') return null;
  const head = (uaClient.split(' - ')[0] ?? '').trim();
  for (const [re, label] of BOT_SERVICES) if (re.test(head)) return label;
  return null;
}

/** 0.9 (#11): the drawer's buyer icon hover: "Bot (user agent: TF2Autobot)", "Bot (user agent)" or "Human". */
export function botServiceTitle(o: Pick<OrderSummary, 'isBot'> & Partial<Pick<OrderSummary, 'botService'>>): string {
  if (!o.isBot) return 'Human';
  return o.botService ? `Bot (user agent: ${o.botService})` : 'Bot (user agent)';
}
