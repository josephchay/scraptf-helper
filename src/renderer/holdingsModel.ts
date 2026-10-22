// Pure helpers for the Holdings page (F11): status pills, the header totals,
// cell text and tooltips, the Record sale prefill, the buyer's profile link and
// the live flash; and the better exit through scrap.tf's saved price list (F14).
// The figures themselves come from the service (or the mock) through the shared
// rules in src/shared/holdings.ts; nothing is recomputed here. 0.8 (H3, H4, H6): the
// advice's words (the advice itself is src/shared/holdingAdvice.ts), the ask side and the references.

import { buyerPresenceText } from '../shared/buyerSeen';
import { frictionOf } from '../shared/ceiling';
import { HOLDING_LIST_UNDERCUT_SCRAP } from '../shared/holdingAdvice';
import { TYPICAL_HOLD_MIN_ITEM } from '../shared/journal';
import { SCRAPTF_LIST_FAMILY_LABEL, SCRAPTF_LIST_FRESH_MS, scraptfListFresh } from '../shared/scraptfList';
import { HOLDING_EXIT_VENUES } from '../shared/types';
import type { HoldingAdvice, HoldingAdviceKind, HoldingAdviceReason, HoldingAskSide, HoldingRefs, HoldingRow, HoldingStatus, HoldingsQuery, HoldingsResult, OrderSummary, ProfitSettings, Scrap, TypicalHold, UnixMs } from '../shared/types';
import { DASH, fmtAge, fmtAgo, fmtDate, fmtDateTime, fmtHold, fmtInt, fmtMoney, fmtPct, fmtRefOnly, fmtSignedMoney, type Tone } from './format';
import { SCRAPTF_SALE_NOTE, buyerProfileUrls, scraptfSaleInit } from './itemMenuModel';
import { splitAtKey, type RecordTradeInit } from './recordTradeModel';

/** Same cap as 'holdings.list' (zod: search ≤ 200). */
export const HOLDINGS_MAX_SEARCH_CHARS = 200;

/**
 * 0.8 (H6, D11): the status pills describe thresholds only ('Clears target', 'Below target'); whether to sell, list
 * or hold is the Advice column's (ADVICE_LABELS), so a row never shows two answers that contradict each other.
 */
export const HOLDING_STATUS_LABELS: Readonly<Record<HoldingStatus, string>> = {
  sell: 'Clears target',
  hold: 'Below target',
  loss: 'Loss',
  'no-buyers': 'No buyers',
};

export const HOLDING_STATUS_TONES: Readonly<Record<HoldingStatus, Tone>> = {
  sell: 'good',
  hold: 'warn',
  loss: 'bad',
  'no-buyers': 'muted',
};

// Judged on the better exit (F14): a backpack.tf buyer, or scrap.tf when your saved price list pays more.
export const HOLDING_STATUS_HELP: Readonly<Record<HoldingStatus, string>> = {
  sell: 'Selling the oldest unit at the better exit now (this buyer, or scrap.tf when your saved price list pays more) clears your profit thresholds. The Advice column weighs it against asks and what was recorded.',
  hold: 'A sale now makes a profit, but less than your thresholds ask for. This is not advice to hold: the Advice column says whether anything recorded points higher.',
  // 0.7.3: Loss is profit after friction ≤ 0, so an exit a little over the cost can still be one.
  loss: 'Selling the oldest unit at the best exit now (a backpack.tf buyer or scrap.tf) makes no profit: it pays no more than that unit cost you, plus your friction per trade if you set one.',
  'no-buyers': 'No eligible backpack.tf buy order for this item in the live book, and no usable scrap.tf price from your saved list.',
};

type NoSaleFields = Partial<Pick<HoldingRow, 'buyerCount' | 'flags'>>;

/**
 * Why a row has buyers but no revenue (0.7.3), from its own fields. Conservative is null only when
 * every eligible order is an outlier, and the service then flags 'all-outliers'; Best is never null
 * with buyers. So buyers, no revenue and no such flag is Instant without a realistic bot order.
 */
function noSaleReason(r: NoSaleFields): 'none' | 'all-outliers' | 'no-bot' {
  if (!((r.buyerCount ?? 0) > 0)) return 'none';
  return r.flags?.includes('all-outliers') ? 'all-outliers' : 'no-bot';
}

/** HOLDING_STATUS_HELP, except No buyers with eligible buyers none of which is usable says why. */
export function holdingStatusHelp(r: Pick<HoldingRow, 'status'> & NoSaleFields): string {
  if (r.status === 'no-buyers') {
    const why = noSaleReason(r);
    if (why === 'all-outliers') return 'Every eligible backpack.tf buy order looks unrealistic, and there is no usable scrap.tf price from your saved list.';
    if (why === 'no-bot') {
      return 'The eligible backpack.tf buyers include no realistic bot order, and Revenue used for profit is Instant (bot orders only). There is no usable scrap.tf price from your saved list either.';
    }
  }
  return HOLDING_STATUS_HELP[r.status];
}

export function holdingsQuery(search: string): HoldingsQuery {
  const s = search.trim().slice(0, HOLDINGS_MAX_SEARCH_CHARS);
  return s ? { search: s } : {};
}

/** The saved search box text, from storage that may hold anything. */
export function sanitizeHoldingsSearch(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, HOLDINGS_MAX_SEARCH_CHARS) : '';
}

// ---------------------------------------------------------------------------
// Header totals
// ---------------------------------------------------------------------------

export function unitsText(t: Pick<HoldingsResult['totals'], 'items' | 'units'>): string {
  const items = `${fmtInt(t.items)} ${t.items === 1 ? 'item' : 'items'}`;
  return t.units === t.items ? items : `${items} (${fmtInt(t.units)} units)`;
}

/** Green for a gain, red for a loss, nothing at zero. */
export function plTone(scrap: Scrap | null): 'good' | 'bad' | null {
  if (scrap === null || !Number.isFinite(scrap) || scrap === 0) return null;
  return scrap > 0 ? 'good' : 'bad';
}

export function worthTitle(t: Pick<HoldingsResult['totals'], 'worthNowScrap' | 'costScrap'>, keyScrap: Scrap | null): string {
  return `What every unit sells for now at its better exit (a backpack.tf buyer, or scrap.tf by your saved price list): ${fmtMoney(t.worthNowScrap, keyScrap)}, against ${fmtMoney(t.costScrap, keyScrap)} you paid for everything held. Items with neither count at nothing.`;
}

export function plTitle(t: Pick<HoldingsResult['totals'], 'profitNowScrap'>, keyScrap: Scrap | null, p: Pick<ProfitSettings, 'frictionScrap'> | null): string {
  const friction = p ? frictionOf(p) : 0;
  return `Unrealised profit or loss if every unit with a buyer (or a fresh scrap.tf price) sold now: ${fmtSignedMoney(t.profitNowScrap, keyScrap)}${friction ? `, after ${fmtMoney(friction, keyScrap)} friction per unit` : ''}. Items with no buyer are left out.`;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** Next lot's cost; the hover adds the lot's date and every open unit's total. */
export function costTitle(r: Pick<HoldingRow, 'qty' | 'costScrap' | 'nextLotCostScrap' | 'heldSince'>, keyScrap: Scrap | null): string {
  const when = r.heldSince > 0 ? ` bought ${fmtDateTime(r.heldSince)}` : '';
  const next = `The next sale closes the oldest unit${when}, which cost ${fmtMoney(r.nextLotCostScrap, keyScrap)}.`;
  return r.qty > 1 ? `${next} All ${fmtInt(r.qty)} units cost ${fmtMoney(r.costScrap, keyScrap)}.` : next;
}

export function heldForText(r: Pick<HoldingRow, 'heldSince'>, now: UnixMs): string {
  return r.heldSince > 0 ? fmtAge(now - r.heldSince) : DASH;
}

/**
 * 0.8 (H5): the user's own habit, never a forecast: the median time between a logged buy and its logged sale,
 * over this item's sales ('item') or every sale ('all'), and how many units still held the median leaves out.
 */
export function typicalHoldText(t: TypicalHold): string {
  const held = t.stillHeld > 0 ? `; ${t.stillHeld} still held ${t.stillHeld === 1 ? 'is' : 'are'} not counted` : '';
  // fmtHold: a sale logged in its buy's own minute holds 0, which fmtAge words as "now".
  return t.scope === 'item'
    ? `Your sales of this item came a median ${fmtHold(t.medianMs)} after the buy (${t.count} sales${held}).`
    : `Your sales came a median ${fmtHold(t.medianMs)} after the buy (${t.count} sales; fewer than ${TYPICAL_HOLD_MIN_ITEM} of this item${held}).`;
}

/** The Held for cell's tooltip: the oldest unit's buy and (0.8, H5) the user's typical hold when there is one. */
export function heldForTitle(r: Pick<HoldingRow, 'heldSince'> & Partial<Pick<HoldingRow, 'typicalHold'>>): string | undefined {
  if (!(r.heldSince > 0)) return undefined;
  const oldest = `Oldest unit bought ${fmtDateTime(r.heldSince)}`;
  return r.typicalHold ? `${oldest}. ${typicalHoldText(r.typicalHold)}` : oldest;
}

export function buyerName(o: Pick<OrderSummary, 'userName' | 'steamid' | 'isBot'>): string {
  return o.userName || (o.isBot ? 'Bot' : 'Human');
}

/**
 * Tooltip for "Sells now for": the buyer you would sell to, and the other picks. 0.7.4 (F23): the buyer's
 * online flag only while the order was seen in the last 2 h, else "last seen 4 d ago". 0.7.4 (F13): a buyer
 * whose order nobody has confirmed for 24 h ('unverified') may be gone, and the service sends no "Sell:"
 * notification on it until a snapshot or the live feed confirms it (holdings.ts check), which the tip says.
 */
export function holdingSellsForTitle(
  r: Pick<HoldingRow, 'revenueScrap' | 'bestScrap' | 'instantScrap' | 'revenueOrder' | 'buyerCount'> & Partial<Pick<HoldingRow, 'flags'>>,
  keyScrap: Scrap | null,
  now: UnixMs = Date.now(),
): string {
  const buyers = `${fmtInt(r.buyerCount)} ${r.buyerCount === 1 ? 'buyer' : 'buyers'} with eligible orders`;
  if (r.revenueScrap === null) {
    const why = noSaleReason(r);
    if (why === 'none') return 'No eligible backpack.tf buy orders in the live book.';
    if (why === 'all-outliers') return 'Every eligible order looks unrealistic, so no sale price is assumed.';
    return `${buyers}, but no realistic bot order, and Revenue used for profit is Instant (bot orders only), so no sale price is assumed.`;
  }
  const o = r.revenueOrder;
  const who = o ? ` to ${o.userName || o.steamid} (${o.isBot ? 'bot' : 'human'}, ${buyerPresenceText(o, now)})` : '';
  const held = o?.flags.includes('unverified') ? ` ${HOLDING_UNVERIFIED_NOTE}` : '';
  return `Sells now for ${fmtMoney(r.revenueScrap, keyScrap)}${who}. Best ${fmtMoney(r.bestScrap, keyScrap)}, instant ${fmtMoney(r.instantScrap, keyScrap)}. ${buyers}.${held}`;
}

/**
 * 0.8 (H2, PC-2): the Buyers cell's hover: distinct buyers, how many were seen in the last 24 h, and what the next buyer
 * pays if the one this row sells to fills or withdraws (HoldingRow.nextBuyer). Presence, never a fill chance.
 */
export function holdingBuyersTitle(
  r: Pick<HoldingRow, 'buyerCount' | 'revenueScrap' | 'revenueOrder'> & Partial<Pick<HoldingRow, 'nextBuyer' | 'verifiedBuyerCount'>>,
  keyScrap: Scrap | null,
  now: UnixMs = Date.now(),
): string {
  const n = r.buyerCount;
  if (!(n > 0)) return 'No eligible backpack.tf buy orders in the live book.';
  const verified = r.verifiedBuyerCount;
  const head = `${fmtInt(n)} distinct ${n === 1 ? 'buyer' : 'buyers'} with eligible orders${verified !== undefined ? `, ${fmtInt(verified)} of them seen in the last 24 h` : ''}.`;
  const o = r.revenueOrder;
  const next = r.nextBuyer;
  if (!o || r.revenueScrap === null || next === undefined) return head;
  if (next === null) return `${head} If ${buyerName(o)} fills or withdraws, no other usable buyer is left.`;
  const d = next.valueScrap - r.revenueScrap;
  const diff = d < 0 ? `${fmtMoney(-d, keyScrap)} less` : d > 0 ? `${fmtMoney(d, keyScrap)} more` : 'the same';
  return `${head} If ${buyerName(o)} fills or withdraws, the next buyer (${next.isBot ? 'bot' : 'human'}, ${buyerPresenceText(next, now)}) pays ${fmtMoney(next.valueScrap, keyScrap)} (${diff}). Buy orders show demand, not sales.`;
}

/** 0.7.4 (F13): what "Sells now for" adds for a buyer nobody has confirmed for 24 h (the service holds its "Sell:" toast). */
export const HOLDING_UNVERIFIED_NOTE =
  'This order was not seen for over a day and may be gone: no "Sell:" notification for this buyer until a snapshot or the live feed confirms it (Refresh from backpack.tf in the item panel). A fresh scrap.tf/items price that clears your thresholds is still notified.';

/**
 * Tooltip for "Profit now": the next unit, every unit, the margin, and what the status means. 0.8 (H4): the stored
 * references (refsText) come before the status help when the row has any, as context, never a sale price.
 */
export function profitNowTitle(
  r: Pick<HoldingRow, 'status' | 'profitNowScrap' | 'profitAllScrap' | 'margin' | 'qty'> & Partial<Pick<HoldingRow, 'bestExit' | 'buyerCount' | 'flags' | 'refs'>>,
  keyScrap: Scrap | null,
  p: Pick<ProfitSettings, 'frictionScrap'> | null,
): string {
  const help = holdingStatusHelp(r);
  const refs = refsText(r.refs, keyScrap);
  if (r.profitNowScrap === null) return refs ? `${refs} ${help}` : help;
  const friction = p ? frictionOf(p) : 0;
  const to = r.bestExit === 'scraptf' ? ' to scrap.tf' : '';
  const parts = [`Selling the oldest unit${to} now: ${fmtSignedMoney(r.profitNowScrap, keyScrap)}${r.margin !== null ? ` (${fmtPct(r.margin)} margin)` : ''}${friction ? ` after ${fmtMoney(friction, keyScrap)} friction` : ''}.`];
  if (r.qty > 1 && r.profitAllScrap !== null) parts.push(`All ${fmtInt(r.qty)} units at this price: ${fmtSignedMoney(r.profitAllScrap, keyScrap)}.`);
  // Before the help, so the title still ends with what the status means.
  if (refs) parts.push(refs);
  parts.push(help);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// The better exit (F14): a backpack.tf buyer, or scrap.tf by the saved price list
// ---------------------------------------------------------------------------

export type HoldingExitFields = Pick<HoldingRow, 'revenueScrap' | 'bestScrap' | 'instantScrap' | 'revenueOrder' | 'buyerCount'> &
  Partial<Pick<HoldingRow, 'bestExit' | 'exitScrap' | 'scraptfPaysScrap' | 'scraptfFull' | 'scraptfListAt' | 'flags' | 'scraptfListFamily' | 'ask'>>;

/**
 * The service judges a scrap.tf exit fresh when it builds the rows, and no push follows when the list
 * turns a day old. A row still saying 'scraptf' after that, at the page's own `now`, has lapsed: the
 * cell and Record sale stop offering scrap.tf until the refetch (scraptfExitLapseAt) arrives.
 */
export function scraptfExitLapsed(r: Partial<Pick<HoldingRow, 'bestExit' | 'scraptfListAt'>>, now: UnixMs | null): boolean {
  return r.bestExit === 'scraptf' && now !== null && finiteScrap(r.scraptfListAt) && !scraptfListFresh({ observedAt: r.scraptfListAt }, now);
}

/** When the first scrap.tf exit among `rows` lapses (its list row turns SCRAPTF_LIST_FRESH_MS old); null without one. */
export function scraptfExitLapseAt(rows: readonly Partial<Pick<HoldingRow, 'bestExit' | 'scraptfListAt'>>[]): UnixMs | null {
  let first: UnixMs | null = null;
  for (const r of rows) {
    if (r.bestExit !== 'scraptf' || !finiteScrap(r.scraptfListAt)) continue;
    const at = r.scraptfListAt + SCRAPTF_LIST_FRESH_MS + 1;
    if (first === null || at < first) first = at;
  }
  return first;
}

/** At most a day ahead: a list dated in the future (a clock moved back) is re-checked daily, not never. */
export const HOLDINGS_LAPSE_MAX_DELAY_MS = 24 * 60 * 60_000;

/** How long until the page refetches for a lapse at `at` (0 once it has passed). */
export function scraptfLapseDelay(at: UnixMs, now: UnixMs): number {
  return Math.min(Math.max(0, at - now), HOLDINGS_LAPSE_MAX_DELAY_MS);
}

export interface HoldingExitView {
  /** The per-unit price "Sells now for" shows: the better exit (exitScrap), else the backpack.tf revenue. */
  priceScrap: Scrap | null;
  /** scrap.tf's bank is the better exit: the cell shows the scrap.tf pill instead of the buyer. */
  scraptf: boolean;
  /** The other venue on a second line: "scrap.tf pays Y" / "scrap.tf full" beside a buyer, "backpack.tf pays X" beside scrap.tf. */
  sub: { text: string; tone: 'muted' | 'warn' } | null;
  /** Hover for the whole cell. */
  title: string;
}

function finiteScrap(v: unknown): v is Scrap {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The "Sells now for" cell: the better exit, its venue, and what the other venue offers. 0.8 (H3): the hover ends
 * with what other sellers ask (askSideText) when the row has a counted ask; without one it is exactly as before.
 */
export function holdingExitView(r: HoldingExitFields, keyScrap: Scrap | null, now: UnixMs): HoldingExitView {
  const v = exitViewOf(r, keyScrap, now);
  const ask = askSideText(r.ask, keyScrap, now);
  return ask ? { ...v, title: `${v.title} ${ask}` } : v;
}

function exitViewOf(r: HoldingExitFields, keyScrap: Scrap | null, now: UnixMs): HoldingExitView {
  // A lapsed scrap.tf exit reads as the day-old list it now is (below) until the refetch lands.
  const lapsed = scraptfExitLapsed(r, now);
  const scraptf = r.bestExit === 'scraptf' && !lapsed;
  const priceScrap = !lapsed && finiteScrap(r.exitScrap) ? r.exitScrap : r.revenueScrap;
  const listAt = finiteScrap(r.scraptfListAt) ? r.scraptfListAt : null;
  const saved = listAt !== null ? `price list saved ${fmtAgo(listAt, now)}` : null;
  if (scraptf) {
    // 0.7.3: buyers without a revenue are there but unusable (noSaleReason), not absent.
    const why = noSaleReason(r);
    const bp =
      r.revenueScrap !== null
        ? `The best backpack.tf buyer pays ${fmtMoney(r.revenueScrap, keyScrap)}.`
        : why === 'all-outliers'
          ? 'Every eligible backpack.tf order looks unrealistic.'
          : why === 'no-bot'
            ? 'No realistic backpack.tf bot order, and Revenue used for profit is Instant (bot orders only).'
            : 'No backpack.tf buyer right now.';
    const noBuyer = why === 'none' ? 'no backpack.tf buyer' : 'no usable backpack.tf buyer';
    return {
      priceScrap,
      scraptf,
      sub: { text: r.revenueScrap !== null ? `backpack.tf pays ${fmtMoney(r.revenueScrap, keyScrap)}` : noBuyer, tone: 'muted' },
      // 0.7.4: a family row's pays price is scrap.tf's for every copy that row stands for, and says so.
      title: `Sells now for ${fmtMoney(priceScrap, keyScrap)} to scrap.tf's bank (your ${saved ?? 'saved price list'}). ${bp} scrap.tf pays more, so status and profit use it; its stock may have changed since the save.${r.scraptfListFamily ? ` ${SCRAPTF_LIST_FAMILY_LABEL}: scrap.tf pays this for any copy that row stands for.` : ''}`,
    };
  }
  const base = holdingSellsForTitle(r, keyScrap);
  if (listAt === null) return { priceScrap, scraptf, sub: null, title: base };
  const fresh = scraptfListFresh({ observedAt: listAt }, now);
  if (r.scraptfFull) {
    return { priceScrap, scraptf, sub: { text: 'scrap.tf full', tone: 'muted' }, title: `${base} scrap.tf is full for this item, so it buys no more (${saved}).` };
  }
  if (!finiteScrap(r.scraptfPaysScrap)) return { priceScrap, scraptf, sub: null, title: base };
  const pays = fmtMoney(r.scraptfPaysScrap, keyScrap);
  if (!fresh) {
    return {
      priceScrap,
      scraptf,
      sub: { text: `scrap.tf paid ${pays}, ${fmtAge(now - listAt)} ago`, tone: 'warn' },
      title: `${base} scrap.tf paid ${pays} (${saved}): older than a day, so it is not counted as an exit. Save scrap.tf/items again.`,
    };
  }
  return { priceScrap, scraptf, sub: { text: `scrap.tf pays ${pays}`, tone: 'muted' }, title: `${base} scrap.tf pays ${pays} (${saved}).` };
}

/** The status pill's hover: what the status means, naming scrap.tf when it is the exit. */
export function holdingStatusTitle(r: Pick<HoldingRow, 'status'> & Partial<Pick<HoldingRow, 'bestExit' | 'buyerCount' | 'flags'>>): string {
  return r.status === 'sell' && r.bestExit === 'scraptf' ? `${HOLDING_STATUS_LABELS.sell} (scrap.tf). ${HOLDING_STATUS_HELP.sell}` : holdingStatusHelp(r);
}

// ---------------------------------------------------------------------------
// 0.8 (H6): advice, the ask side (H3) and the references (H4)
// ---------------------------------------------------------------------------

/** 0.8 (H6): the Advice column's words for each kind (the status pills say only where the thresholds stand). */
export const ADVICE_LABELS: Readonly<Record<HoldingAdviceKind, string>> = { 'sell-now': 'Sell now', list: 'List and wait', hold: 'Hold', unclear: 'No clear signal' };
/** 0.8 (H6): each kind's pill tone. */
export const ADVICE_TONES: Readonly<Record<HoldingAdviceKind, Tone>> = { 'sell-now': 'good', list: 'info', hold: 'warn', unclear: 'muted' };
/** 0.8 (H6): what each kind means, first in the advice hover. "List and wait" says a listing's time is unknown and Flip Desk never lists. */
export const ADVICE_HELP: Readonly<Record<HoldingAdviceKind, string>> = {
  'sell-now': 'Selling now is what the book and your thresholds support.',
  list: "Listing it yourself on backpack.tf at about the lowest matching ask could beat today's buyers. Flip Desk sees no completed sales, so it cannot say how long that takes, and it never lists, bumps or trades for you.",
  hold: "An exit Flip Desk recorded while it ran (a buy order that stood for an hour or more, or scrap.tf's price from a fresh list) paid more than you would get now. Nothing says it will again.",
  unclear: 'What Flip Desk has seen does not point either way, or it has not recorded enough yet.',
};
/**
 * 0.8 (H6): adviceTitle's help when below-target decides 'sell-now' (ADVICE_HELP['sell-now'] would contradict "under
 * your minimum"), and what holdingAdvice checked when neither a falling streak nor a stale list set a high aside: no
 * recent high (HOLDING_RECENT_HIGH_MS, from a run of HOLDING_RECENT_HIGH_MIN_RUN_MS or more) clears the minimum.
 */
export const ADVICE_BELOW_TARGET_HELP =
  'A sale now is under your minimum, and no exit Flip Desk recorded while you held it (in the last 7 days, from a run of an hour or more) would clear it.';
/**
 * 0.8 (H6, review): ADVICE_BELOW_TARGET_HELP when the history it checked starts where the buyer settings last changed
 * (the below-target reason's settingsAt, which its line dates): exits recorded before then were not checked.
 */
export const ADVICE_BELOW_TARGET_SINCE_SETTINGS_HELP =
  'A sale now is under your minimum, and no exit Flip Desk recorded since your buyer settings last changed (in the last 7 days, from a run of an hour or more) would clear it. Exits recorded before the change priced other buyers and were not checked.';
/** 0.8 (H6): the below-target help beside a 'falling' reason: a higher exit may have been recorded, and the exits fell since. */
export const ADVICE_BELOW_TARGET_FALLING_HELP =
  'A sale now is under your minimum, and the recorded exits fell in each of the last 3 changes, so an earlier, higher one is no reason to wait.';
/** 0.8 (H6): the below-target help beside a 'resave-list' reason: the higher exit recorded was scrap.tf's price from a list no longer fresh. */
export const ADVICE_BELOW_TARGET_RESAVE_HELP =
  "A sale now is under your minimum. The higher exit recorded was scrap.tf's price from your saved list, which is no longer fresh, so it is no reason to wait until you save the list again.";
/** 0.8 (H6): the last line of every advice hover and the drawer's advice. */
export const ADVICE_FOOTER = 'From what Flip Desk saw while it ran; never a forecast.';
/** 0.8 (H8): the refresh mark beside the advice when the book it rests on was not confirmed for a day. */
export const ADVICE_REFRESH_TITLE = 'Refresh from backpack.tf in the item panel first: the book this rests on was not confirmed for a day.';
/** 0.8 (H6): the Advice column header's hover. */
export const ADVICE_COLUMN_TITLE = 'Sell now, list and wait, or hold, from the book now and the exits Flip Desk recorded while it ran. Hover for the reasons and their dates; never a forecast.';

/** "3 matching asks" (the singular for one). */
function asksText(n: number): string {
  return `${fmtInt(n)} matching ${n === 1 ? 'ask' : 'asks'}`;
}

/**
 * " Your blocklist, … changed on <date>, so runs recorded before then are not compared." for a reason whose history
 * starts where the buyer settings last changed; '' without a date.
 */
function settingsCutText(at: UnixMs | undefined): string {
  return typeof at === 'number' && Number.isFinite(at)
    ? ` Your blocklist, Revenue used for profit, outlier or notes settings changed on ${fmtDateTime(at)}, so runs recorded before then are not compared.`
    : '';
}

/** "+1", "-0.5": a key count with its sign. */
function signedKeys(n: number): string {
  const v = Math.round(n * 100) / 100;
  return v > 0 ? `+${v}` : `${v}`;
}

/**
 * 0.8 (H6): one advice reason in words, with the date or age it rests on (dates with fmtDateTime/fmtDate, ages with
 * fmtAge, money with fmtMoney/fmtSignedMoney at keyScrap, key prices in ref). States what was seen, never a forecast.
 */
export function adviceReasonText(r: HoldingAdviceReason, keyScrap: Scrap | null, now: UnixMs): string {
  const $m = (v: Scrap | null) => fmtMoney(v, keyScrap);
  const $s = (v: Scrap | null) => fmtSignedMoney(v, keyScrap);
  const ownOf = (mayIncludeOwn: boolean) => (mayIncludeOwn ? ', may include yours' : '');
  const under = `${HOLDING_LIST_UNDERCUT_SCRAP} scrap under`;
  switch (r.code) {
    case 'clears-target':
      return `Selling now makes ${$s(r.profitScrap)}, ${$m(r.overScrap)} over your minimum profit${r.exit === 'scraptf' ? ' (to scrap.tf)' : ''}.`;
    case 'scraptf-instead':
      return `The backpack.tf buyer was not seen for a day, but scrap.tf's bank pays ${$m(r.paysScrap)} (your list saved ${fmtAgo(r.listAt, now)}): ${$s(r.profitScrap)}.`;
    case 'unverified-exit':
      return `The order this rests on was last seen ${r.seenAt !== null ? `${fmtAge(now - r.seenAt)} ago` : 'over a day ago'} and may be gone.`;
    case 'list-beats-sale':
      return `Listing at ${$m(r.listScrap)} (${under} the lowest of ${asksText(r.sellers)}${ownOf(r.mayIncludeOwn)}) would make ${$m(r.gainScrap)} more than selling now. Flip Desk sees no completed sales, so how long it takes is unknown; today's buyer stays the fallback while their order lasts.`;
    case 'list-clears':
      return `Listing at ${$m(r.listScrap)}, ${under} the lowest of ${asksText(r.sellers)}${ownOf(r.mayIncludeOwn)}, would clear your thresholds (${$s(r.profitScrap)}). No buyer pays that now, and how long a listing takes is unknown.`;
    case 'list-no-buyer':
      return `No buyer now. The lowest of ${asksText(r.sellers)} is ${$m(r.askScrap)}${ownOf(r.mayIncludeOwn)}; listing at ${$m(r.listScrap)} would make ${$s(r.profitScrap)}. How long it takes is unknown.`;
    case 'asks-below-cost':
      return `No buyer now, and the lowest of ${asksText(r.sellers)} (${$m(r.askScrap)}) is under what this unit cost you.`;
    case 'no-exit':
      return 'No buyer, no usable scrap.tf price and no matching ask to compare with.';
    case 'recorded-high':
      return `The best exit paid ${$m(r.exitScrap)} on ${fmtDateTime(r.at)} (${fmtInt(r.runs)} recorded runs since ${fmtDate(r.firstAt)}); nothing says it will again.`;
    case 'reference-above':
      return `PriceDB's bot buy price is ${$m(r.pricedbBuyScrap)}${r.ageMs !== null ? ` (${fmtAge(r.ageMs)} old)` : ''}. It is derived from backpack.tf and is no sale: no buyer pays it now.`;
    case 'resave-list':
      return `Save your scrap.tf price list again: the best exit recorded, ${$m(r.highScrap)} on ${fmtDateTime(r.highAt)}, was scrap.tf's price from it, and that list is ${r.listAt !== null ? `${fmtAge(now - r.listAt)} old` : 'no longer saved'} now.`;
    case 'below-target':
      // With settingsAt the exits it was checked against start at that change, and the line says so.
      return `A sale now makes ${$s(r.profitScrap)}, under your minimum of ${$m(r.minScrap)}.${settingsCutText(r.settingsAt)}`;
    case 'loss':
      return `A sale now makes ${$s(r.profitScrap)}, a loss.`;
    case 'refresh-first':
      return r.why === 'unverified-order'
        ? `Refresh from backpack.tf in the item panel first: the order was last seen ${r.seenAt !== null ? fmtAge(now - r.seenAt) : 'over a day'} ago.`
        : `Refresh from backpack.tf in the item panel first: no order changed and no snapshot came in for ${r.seenAt !== null ? fmtAge(now - r.seenAt) : 'over a day'}.`;
    case 'single-exit':
      return r.nextScrap !== null
        ? `Only this buyer clears your thresholds: the next buyer pays ${$m(r.nextScrap)} (${$s(r.nextProfitScrap)})${r.nextUnverified ? ' but was not seen in the last 24 h' : ''}.`
        : 'Only this buyer clears your thresholds; no other buyer is in the book.';
    case 'falling':
      return `The best exit fell in each of the last 3 recorded changes, from ${$m(r.fromScrap)} to ${$m(r.toScrap)} since ${fmtDateTime(r.sinceAt)}.`;
    case 'held-vs-typical': {
      const held = r.stillHeld > 0 ? `; ${fmtInt(r.stillHeld)} still held ${r.stillHeld === 1 ? 'is' : 'are'} not counted` : '';
      return `Held ${fmtHold(r.heldMs)}; your closed flips of ${r.scope === 'item' ? 'this item' : 'any item'} took ${fmtHold(r.typicalMs)} (median of ${fmtInt(r.count)}, between the logged buy and sale${held}).`;
    }
    case 'key-exposure': {
      const n = Math.abs(Math.round(r.netKeys * 100) / 100);
      return `This sale nets ${signedKeys(r.netKeys)} ${n === 1 ? 'key' : 'keys'} against what you paid, so each 1 ref the key moves changes this profit by about ${n} ref. A key was ${fmtRefOnly(r.boughtKeyScrap)} when you bought, ${fmtRefOnly(r.nowKeyScrap)} now.`;
    }
    case 'list-age':
      return `scrap.tf's price is from your list saved ${fmtAgo(r.listAt, now)}.`;
    case 'has-extras':
      return 'Priced against buyers of a clean copy; the paint or extras are not valued here.';
    case 'no-history': {
      // The history starts at a change of the buyer settings: runs before it priced other buyers.
      const settings = settingsCutText(r.settingsAt);
      return r.runs === 0
        ? `No exit history recorded for this item yet (Flip Desk records it while the live feed is on).${settings}`
        : `Not enough recorded history yet: ${fmtInt(r.runs)} ${r.runs === 1 ? 'run' : 'runs'} over ${fmtAge(r.observedMs)} since ${fmtDate(r.firstAt)}.${settings}`;
    }
  }
}

/**
 * 0.8 (H6): the advice cell's hover: "<label>: <help>", one "• reason" line each (adviceReasonText), then
 * ADVICE_FOOTER. When below-target decides 'sell-now' the help says what set a higher recorded exit aside: a falling
 * streak (ADVICE_BELOW_TARGET_FALLING_HELP), a stale scrap.tf list (ADVICE_BELOW_TARGET_RESAVE_HELP), else that none
 * clears the minimum (ADVICE_BELOW_TARGET_HELP; ADVICE_BELOW_TARGET_SINCE_SETTINGS_HELP when the history checked
 * starts where the buyer settings last changed, the reason's settingsAt), so the help never contradicts a reason below
 * it nor claims more was checked than was.
 */
export function adviceTitle(a: HoldingAdvice, keyScrap: Scrap | null, now: UnixMs): string {
  const has = (code: HoldingAdviceReason['code']): boolean => a.reasons.some((r) => r.code === code);
  const first = a.reasons[0];
  const help =
    a.kind === 'sell-now' && first?.code === 'below-target'
      ? has('falling')
        ? ADVICE_BELOW_TARGET_FALLING_HELP
        : has('resave-list')
          ? ADVICE_BELOW_TARGET_RESAVE_HELP
          : typeof first.settingsAt === 'number' && Number.isFinite(first.settingsAt)
            ? ADVICE_BELOW_TARGET_SINCE_SETTINGS_HELP
            : ADVICE_BELOW_TARGET_HELP
      : ADVICE_HELP[a.kind];
  return [`${ADVICE_LABELS[a.kind]}: ${help}`, ...a.reasons.map((r) => `• ${adviceReasonText(r, keyScrap, now)}`), ADVICE_FOOTER].join('\n');
}

/**
 * 0.8 (H3): "Others ask from X (N sellers, M bots; may include yours), the lowest seen … ago." and that an ask is
 * not a price paid; null without an ask. Shared by the Sells now for hover and the drawer's Sell listings.
 */
export function askSideText(ask: HoldingAskSide | null | undefined, keyScrap: Scrap | null, now: UnixMs): string | null {
  if (!ask) return null;
  const sellers = `${fmtInt(ask.count)} ${ask.count === 1 ? 'seller' : 'sellers'}`;
  const bots = `${fmtInt(ask.botCount)} ${ask.botCount === 1 ? 'bot' : 'bots'}`;
  const own = ask.mayIncludeOwn ? '; may include yours' : ask.ownLeftOut > 0 ? `; ${fmtInt(ask.ownLeftOut)} of yours left out` : '';
  return `Others ask from ${fmtMoney(ask.lowestScrap, keyScrap)} (${sellers}, ${bots}${own}), the lowest seen ${fmtAgo(ask.lowestSeenAt, now)}. An ask is what a seller wants, not a price paid.`;
}

/**
 * 0.8 (H4): "PriceDB buys at X (3 d old), sells at Y; community Z. References only, never a sale price." then each
 * reason a reference was left out for its age; null without refs (or with nothing to say).
 */
export function refsText(refs: HoldingRefs | null | undefined, keyScrap: Scrap | null): string | null {
  if (!refs) return null;
  const $m = (v: Scrap | null) => fmtMoney(v, keyScrap);
  const shown: string[] = [];
  const age = refs.pricedbAgeMs !== null ? ` (${fmtAge(refs.pricedbAgeMs)} old)` : '';
  if (finiteScrap(refs.pricedbBuyScrap) && finiteScrap(refs.pricedbSellScrap)) shown.push(`PriceDB buys at ${$m(refs.pricedbBuyScrap)}${age}, sells at ${$m(refs.pricedbSellScrap)}`);
  else if (finiteScrap(refs.pricedbBuyScrap)) shown.push(`PriceDB buys at ${$m(refs.pricedbBuyScrap)}${age}`);
  else if (finiteScrap(refs.pricedbSellScrap)) shown.push(`PriceDB sells at ${$m(refs.pricedbSellScrap)}${age}`);
  if (finiteScrap(refs.communityScrap)) {
    const high = finiteScrap(refs.communityHighScrap) && refs.communityHighScrap !== refs.communityScrap ? ` to ${$m(refs.communityHighScrap)}` : '';
    shown.push(`community ${$m(refs.communityScrap)}${high}`);
  }
  const parts: string[] = [];
  const text = shown.join('; ');
  if (text) parts.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}. References only, never a sale price.`);
  for (const why of refs.ignored ?? []) parts.push(`${why}.`);
  return parts.length ? parts.join(' ') : null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Record sale… prefilled for the better exit (F14). For a backpack.tf buyer: venue backpack.tf,
 * that order's own keys + metal and "Sold to <buyer>". When scrap.tf's saved list is the better exit:
 * venue scrap.tf at what it pays, keys and metal as the list shows them (scraptfSaleInit, the drawer's
 * and item menu's prefill), so the journal books what scrap.tf hands over. A row without the listed
 * split falls back to the value split into whole keys and metal at `keyScrap` (the key price the row
 * is valued at, so the dialog values it back to the same amount). A scrap.tf exit that has lapsed at
 * `now` (scraptfExitLapsed) prefills the buyer instead. Without either only the item and venue are filled.
 */
export function recordSaleInit(
  r: Pick<HoldingRow, 'sku' | 'name' | 'revenueOrder'> &
    Partial<Pick<HoldingRow, 'bestExit' | 'exitScrap' | 'exitVenue' | 'scraptfPaysScrap' | 'scraptfPaysKeys' | 'scraptfPaysScrapRaw' | 'scraptfListAt'>>,
  keyScrap: Scrap | null = null,
  now: UnixMs | null = null,
): RecordTradeInit {
  if (r.bestExit === 'scraptf' && !scraptfExitLapsed(r, now)) {
    if (finiteScrap(r.scraptfPaysScrapRaw)) return scraptfSaleInit(r, { paysKeys: r.scraptfPaysKeys ?? null, paysScrapRaw: r.scraptfPaysScrapRaw });
    const pays = finiteScrap(r.scraptfPaysScrap) ? r.scraptfPaysScrap : r.exitScrap;
    const base: RecordTradeInit = { side: 'sell', sku: r.sku, name: r.name, venue: r.exitVenue || HOLDING_EXIT_VENUES.scraptf };
    if (!finiteScrap(pays) || pays <= 0) return base;
    return { ...base, ...splitAtKey(pays, keyScrap), note: SCRAPTF_SALE_NOTE };
  }
  const o = r.revenueOrder;
  const base: RecordTradeInit = { side: 'sell', sku: r.sku, name: r.name, venue: HOLDING_EXIT_VENUES.backpack };
  if (!o) return base;
  return { ...base, keys: o.keys, scrap: o.metalScrap, note: `Sold to ${o.userName || o.steamid}` };
}

/** The row's Record sale… button tooltip: who the prefill sells to. */
export function recordSaleTitle(r: Pick<HoldingRow, 'revenueOrder'> & Partial<Pick<HoldingRow, 'bestExit'>>): string {
  if (r.bestExit === 'scraptf') return "Record a sale in your journal, prefilled for scrap.tf's bank at its saved list price (s)";
  return r.revenueOrder ? `Record a sale in your journal, prefilled for ${buyerName(r.revenueOrder)} (s)` : 'Record a sale in your journal (s)';
}

/** The buyer's backpack.tf profile, opened only through 'links.open'; null without a SteamID64. */
export function buyerProfileUrl(r: Pick<HoldingRow, 'revenueOrder'>): string | null {
  const o = r.revenueOrder;
  return o ? (buyerProfileUrls(o.steamid)?.backpack ?? null) : null;
}

/** Why the buyer key (b) opened nothing: no buyer at all, or one without a SteamID64 to link. */
export function noBuyerProfileText(r: Pick<HoldingRow, 'name' | 'revenueOrder'>): string {
  return r.revenueOrder ? `${r.name}: this buyer has no backpack.tf profile link.` : `${r.name} has no buyer to open right now.`;
}

export type EmptyHoldingsReason = 'nothing-held' | 'search';

/** Why the table is empty: nothing held at all, or the search hides everything. */
export function emptyHoldingsReason(res: Pick<HoldingsResult, 'rows' | 'totals'>): EmptyHoldingsReason | null {
  if (res.rows.length > 0) return null;
  return res.totals.items > 0 ? 'search' : 'nothing-held';
}

// ---------------------------------------------------------------------------
// Live flash
// ---------------------------------------------------------------------------

export type HoldingFlash = 'up' | 'down';
export type HoldingsSnapshot = ReadonlyMap<string, Scrap | null>;

/** How long a changed row stays marked; the CSS animation runs for the same time. */
export const HOLDING_FLASH_MS = 1600;

export function holdingsSnapshot(rows: readonly Pick<HoldingRow, 'sku' | 'profitNowScrap'>[]): Map<string, Scrap | null> {
  return new Map(rows.map((r) => [r.sku, r.profitNowScrap]));
}

/** Rows whose profit now moved since the last answer, and which way. Rows new to the list never flash. */
export function diffHoldingsFlash(prev: HoldingsSnapshot | null, rows: readonly Pick<HoldingRow, 'sku' | 'profitNowScrap'>[]): Map<string, HoldingFlash> {
  const out = new Map<string, HoldingFlash>();
  if (!prev) return out;
  for (const r of rows) {
    if (!prev.has(r.sku)) continue;
    const a = prev.get(r.sku) ?? null;
    const b = r.profitNowScrap;
    if (a === b) continue;
    out.set(r.sku, a === null ? 'up' : b === null ? 'down' : b > a ? 'up' : 'down');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export type HoldingKeyAction = 'open' | 'record-sale' | 'buyer';

/** Row keys besides moving: Enter opens the item, s records a sale, b opens the buyer's profile. */
export function holdingKeyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): HoldingKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Enter' || e.key === ' ') return 'open';
  if (e.key === 's' || e.key === 'S') return 'record-sale';
  if (e.key === 'b' || e.key === 'B') return 'buyer';
  return null;
}
