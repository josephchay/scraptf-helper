// Pure rules for the Journal page (0.8, J3 and the page's helpers): the Results report (by month, week or venue
// route), the stat cards (win rate, ROI, hold time), the losing flips, each trade's P/L cell, and the edit (J6)
// and write-off prefills for the Record trade dialog. Everything reads JournalSummary.closed, the pairs exactly as
// journalSummary (src/shared/journal.ts) booked them, so no figure is worked out a second way. Nothing here
// fetches: switching Month, Week or Venues regroups what the page already has.

import { medianOf } from '../shared/journal';
import type { HoldingsValuation, JournalClosedTrade, JournalEntry, JournalPosition, JournalSide, JournalSummary, Scrap, UnixMs } from '../shared/types';
import { WRITE_OFF_VENUE, venueKey, venueLabel } from '../shared/venues';
import { DASH, fmtDate, fmtDateTime, fmtHold, fmtMoney, fmtPct, fmtSignedMoney, type Tone } from './format';
import type { RecordTradeInit } from './recordTradeModel';

/** A hold time: DASH for none, '< 1 min' under a minute, else fmtAge (format.ts, shared with Holdings and the drawer). */
export { fmtHold };

/** Below this many closed flips a rate (win rate, ROI) is shown muted, or not at all on the stat cards. */
export const MIN_RATE_TRADES = 5;
/** The Losing flips card lists this many; the CSV has every one. */
export const LOSSES_SHOWN = 50;

/** A Results period: local calendar months, or weeks from Monday 00:00. */
export type JournalPeriod = 'week' | 'month';
/** How the Results card groups closed flips: by the sale's period, or by venue route (bought on → sold on). */
export type JournalResultsBy = JournalPeriod | 'route';
/** The Results card's grouping choices, Month first (the default). */
export const JOURNAL_RESULTS_OPTIONS: readonly { value: JournalResultsBy; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'route', label: 'Venues' },
];

/** A journal row's side pill text. */
export const JOURNAL_SIDE_LABELS: Readonly<Record<JournalSide, string>> = { buy: 'Buy', sell: 'Sell', writeoff: 'Write-off' };
/** A journal row's side pill tone. */
export const JOURNAL_SIDE_TONES: Readonly<Record<JournalSide, Tone>> = { buy: 'info', sell: 'good', writeoff: 'bad' };
/** Still holding's Write off… button: what a write-off does, and that it trades nothing (R4). */
export const WRITE_OFF_TITLE = 'Record that one unit was used, lost or will never sell: it closes the oldest open lot at a loss. Nothing is sold or traded.';

/** The Log a trade form's toast: `Logged buy of …`, `Logged sell of …` (as before 0.8) or `Logged write-off of …`. */
export function loggedText(e: Pick<JournalEntry, 'side' | 'name'>): string {
  return `Logged ${e.side === 'writeoff' ? 'write-off' : e.side} of ${e.name}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The start of `ts`'s period on the local calendar: a month starts on its 1st (new Date(y, m, 1)), a week on its
 * Monday 00:00 (new Date(y, m, d - (getDay() + 6) % 7)). Date does the daylight-saving shifts.
 */
export function periodStart(ts: UnixMs, period: JournalPeriod): UnixMs {
  const d = new Date(ts);
  if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
}

/** A period's row label: 'Oct 2026' (fixed English month names) or 'Week of 2026-10-19'. */
export function periodLabel(start: UnixMs, period: JournalPeriod): string {
  const d = new Date(start);
  return period === 'month' ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : `Week of ${fmtDate(start)}`;
}

/** The sold-on side of a route: a write-off always goes to WRITE_OFF_VENUE, whatever its venue says. */
function soldOn(c: Pick<JournalClosedTrade, 'sellVenue'> & Partial<Pick<JournalClosedTrade, 'kind'>>): string {
  return c.kind === 'writeoff' ? WRITE_OFF_VENUE : venueLabel(c.sellVenue);
}

/** A flip's venue route key: both venues folded (venueLabel, then venueKey), so 'Steam' and 'scm' are one route. */
export function routeKey(c: Pick<JournalClosedTrade, 'buyVenue' | 'sellVenue'> & Partial<Pick<JournalClosedTrade, 'kind'>>): string {
  return `${venueKey(venueLabel(c.buyVenue))}→${venueKey(soldOn(c))}`;
}

/** A flip's venue route as shown: 'scrap.tf → backpack.tf'. */
export function routeLabel(c: Pick<JournalClosedTrade, 'buyVenue' | 'sellVenue'> & Partial<Pick<JournalClosedTrade, 'kind'>>): string {
  return `${venueLabel(c.buyVenue)} → ${soldOn(c)}`;
}

/** Closed flips counted and summed. Every figure is as booked (JournalClosedTrade, at each sale's key price). */
export interface JournalStats {
  /** Closed flips: sales and write-offs that closed a buy. */
  trades: number;
  sales: number;
  writeoffs: number;
  /** profit > 0, < 0 and === 0. */
  wins: number;
  losses: number;
  breakEven: number;
  profitScrap: Scrap;
  costScrap: Scrap;
  /** Sum of the recorded fees (non-null feesScrap), how many flips recorded any, and how many lack one side's. */
  feesScrap: Scrap;
  feesRecorded: number;
  feesMissing: number;
  /** wins / trades; null at 0 trades. Break-even is neither a win nor a loss but counts in the denominator. */
  winRate: number | null;
  /** profit / cost; null when cost <= 0. Not annualised. */
  roi: number | null;
  /** Over sales only: a write-off is not a sale and has no hold time. */
  avgHeldMs: number | null;
  medianHeldMs: number | null;
}

/** The stats of a set of closed flips (journalStats rules above; win rate, ROI and holds may be null). */
export function journalStats(closed: readonly JournalClosedTrade[]): JournalStats {
  let trades = 0;
  let sales = 0;
  let writeoffs = 0;
  let wins = 0;
  let losses = 0;
  let breakEven = 0;
  let profitScrap = 0;
  let costScrap = 0;
  let feesScrap = 0;
  let feesRecorded = 0;
  let feesMissing = 0;
  const holds: number[] = [];
  for (const c of closed) {
    trades++;
    if (c.kind === 'writeoff') writeoffs++;
    else {
      sales++;
      holds.push(c.heldMs);
    }
    if (c.profitScrap > 0) wins++;
    else if (c.profitScrap < 0) losses++;
    else breakEven++;
    profitScrap += c.profitScrap;
    costScrap += c.costScrap;
    if (c.feesScrap !== null) {
      feesScrap += c.feesScrap;
      feesRecorded++;
    }
    if (!c.feesKnown) feesMissing++;
  }
  return {
    trades,
    sales,
    writeoffs,
    wins,
    losses,
    breakEven,
    profitScrap,
    costScrap,
    feesScrap,
    feesRecorded,
    feesMissing,
    winRate: trades > 0 ? wins / trades : null,
    roi: costScrap > 0 ? profitScrap / costScrap : null,
    avgHeldMs: holds.length ? Math.round(holds.reduce((t, h) => t + h, 0) / holds.length) : null,
    medianHeldMs: medianOf(holds),
  };
}

/** One Results line: a period (start set) or a venue route (start null). */
export interface JournalReportRow extends JournalStats {
  key: string;
  label: string;
  start: UnixMs | null;
}

/** A flip counts in its sale's period; newest period first. */
export function journalByPeriod(closed: readonly JournalClosedTrade[], period: JournalPeriod): JournalReportRow[] {
  const groups = new Map<UnixMs, JournalClosedTrade[]>();
  for (const c of closed) {
    const start = periodStart(c.soldAt, period);
    const list = groups.get(start);
    if (list) list.push(c);
    else groups.set(start, [c]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([start, list]) => ({ key: String(start), label: periodLabel(start, period), start, ...journalStats(list) }));
}

/** By routeKey (label: the first spelling seen); most flips first, then profit desc, then label. */
export function journalByRoute(closed: readonly JournalClosedTrade[]): JournalReportRow[] {
  const groups = new Map<string, { label: string; list: JournalClosedTrade[] }>();
  for (const c of closed) {
    const key = routeKey(c);
    const g = groups.get(key);
    if (g) g.list.push(c);
    else groups.set(key, { label: routeLabel(c), list: [c] });
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, start: null, ...journalStats(g.list) }))
    .sort((a, b) => b.trades - a.trades || b.profitScrap - a.profitScrap || a.label.localeCompare(b.label));
}

/** The Results card's lines for the chosen grouping. */
export function journalResults(closed: readonly JournalClosedTrade[], by: JournalResultsBy): JournalReportRow[] {
  return by === 'route' ? journalByRoute(closed) : journalByPeriod(closed, by);
}

/** Every closed flip's stats, and whether there are enough (MIN_RATE_TRADES) for the rates to be shown. */
export interface JournalTotals extends JournalStats {
  enough: boolean;
}

/** The stat cards' totals over every closed flip. */
export function journalTotals(closed: readonly JournalClosedTrade[]): JournalTotals {
  const s = journalStats(closed);
  return { ...s, enough: s.trades >= MIN_RATE_TRADES };
}

/** profit < 0 (write-offs of a paid lot included), worst first, then newest sale. */
export function journalLosses(closed: readonly JournalClosedTrade[]): JournalClosedTrade[] {
  return closed.filter((c) => c.profitScrap < 0).sort((a, b) => a.profitScrap - b.profitScrap || b.soldAt - a.soldAt || b.sellId - a.sellId);
}

/** Each row's FIFO state by id, built once per summary for the trades table's P/L cells. */
export interface JournalIndex {
  closedBySell: ReadonlyMap<number, JournalClosedTrade>;
  closedByBuy: ReadonlyMap<number, JournalClosedTrade>;
  openBuys: ReadonlySet<number>;
  waiting: ReadonlySet<number>;
}

/** The ids of the summary's closed pairs (both rows), open lots and waiting sales. */
export function journalIndex(s: Pick<JournalSummary, 'closed' | 'open' | 'waitingSales'>): JournalIndex {
  const closedBySell = new Map<number, JournalClosedTrade>();
  const closedByBuy = new Map<number, JournalClosedTrade>();
  for (const c of s.closed) {
    closedBySell.set(c.sellId, c);
    closedByBuy.set(c.buyId, c);
  }
  const openBuys = new Set<number>();
  for (const p of s.open) for (const l of p.lots) openBuys.add(l.id);
  return { closedBySell, closedByBuy, openBuys, waiting: new Set(s.waitingSales.map((w) => w.id)) };
}

/** One trades-table P/L cell: a sale's or write-off's booked profit, or what a buy or a waiting sale is now. */
export interface TradePnlView {
  kind: 'profit' | 'open' | 'sold' | 'written-off' | 'waiting' | 'none';
  profitScrap: Scrap | null;
  text: string;
  title: string | undefined;
}

function feesSentence(c: JournalClosedTrade, keyScrap: Scrap | null): string {
  if (c.feesScrap === null) return 'No fees recorded.';
  return c.feesKnown ? `Fees ${fmtMoney(c.feesScrap, keyScrap)}.` : `Fees ${fmtMoney(c.feesScrap, keyScrap)} (one side not recorded).`;
}

/**
 * A row's P/L cell. A sale or write-off that closed a buy shows its booked profit, the buy it closed and the hold
 * between the two logged rows; a buy says whether it was sold, written off or is still open; a sale with no buy
 * before it books nothing yet. DASH for anything else (before the summary loads, or a row FIFO skips).
 */
export function tradePnl(e: JournalEntry, idx: JournalIndex | null, keyScrap: Scrap | null): TradePnlView {
  const none: TradePnlView = { kind: 'none', profitScrap: null, text: DASH, title: undefined };
  if (!idx) return none;
  if (e.side !== 'buy') {
    const c = idx.closedBySell.get(e.id);
    if (c) {
      const what = c.kind === 'writeoff' ? 'write-off' : 'sale';
      return {
        kind: 'profit',
        profitScrap: c.profitScrap,
        text: fmtSignedMoney(c.profitScrap, keyScrap),
        title: `Closed the buy of ${fmtDateTime(c.boughtAt)} on ${venueLabel(c.buyVenue)} (cost ${fmtMoney(c.costScrap, keyScrap)}); held ${fmtHold(c.heldMs)} between the logged buy and ${what}. ${feesSentence(c, keyScrap)}`,
      };
    }
    if (idx.waiting.has(e.id)) return { kind: 'waiting', profitScrap: null, text: 'no buy', title: 'No buy of this item dated before it, so it books nothing yet.' };
    return none;
  }
  const c = idx.closedByBuy.get(e.id);
  if (c) {
    const signed = fmtSignedMoney(c.profitScrap, keyScrap);
    return c.kind === 'writeoff'
      ? { kind: 'written-off', profitScrap: c.profitScrap, text: 'written off', title: `Written off ${fmtDate(c.soldAt)}: ${signed}` }
      : { kind: 'sold', profitScrap: c.profitScrap, text: 'sold', title: `Sold ${fmtDate(c.soldAt)} on ${venueLabel(c.sellVenue)}: ${signed}` };
  }
  if (idx.openBuys.has(e.id)) return { kind: 'open', profitScrap: null, text: 'open', title: "Still held: Holdings prices it against today's buyers." };
  return none;
}

/** One stat card: its value, the line under it, whether it is muted (too few flips) and its tooltip. */
export interface StatView {
  value: string;
  sub: string;
  muted: boolean;
  title: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Win rate: shown from MIN_RATE_TRADES closed flips, with every count it rests on (E.1-1). */
export function winRateStat(t: JournalTotals): StatView {
  const counts = `${t.wins} won · ${t.losses} lost${t.breakEven ? ` · ${t.breakEven} even` : ''}`;
  return {
    value: t.enough ? fmtPct(t.winRate, 0) : DASH,
    sub: t.trades === 0 ? 'no closed flips yet' : `${counts}${t.enough ? '' : ` · needs ${MIN_RATE_TRADES} flips`}`,
    muted: !t.enough,
    title: 'Flips that made money, of every closed flip (write-offs included).',
  };
}

/** ROI: realised profit over cost, shown from MIN_RATE_TRADES closed flips; says how many lack a fee. */
export function roiStat(t: JournalTotals, keyScrap: Scrap | null): StatView {
  return {
    value: t.enough && t.roi !== null ? fmtPct(t.roi) : DASH,
    sub: `on ${fmtMoney(t.costScrap, keyScrap)} cost${t.feesMissing ? ` · ${t.feesMissing} without fees` : ''}`,
    muted: !t.enough || t.roi === null,
    title: 'Realised profit over what the sold items cost, fees included where recorded. Not annualised.',
  };
}

/** Hold time: the median between the logged buy and the logged sale (write-offs not counted), muted below MIN_RATE_TRADES sales. */
export function holdStat(t: JournalTotals): StatView {
  return {
    value: fmtHold(t.medianHeldMs),
    sub: t.sales > 0 ? `avg ${fmtHold(t.avgHeldMs)} · ${plural(t.sales, 'sale', 'sales')}` : 'no sales yet',
    muted: t.sales < MIN_RATE_TRADES,
    title: 'Median time between the logged buy and the logged sale; write-offs are not counted.',
  };
}

/** 0.9: the Journal's "Unrealised P/L" card's hover: what Holdings values the open lots at, and that nothing is booked. */
export const INVENTORY_TITLE =
  "What Holdings values your open lots at: every unit at its item's better exit now (a backpack.tf buyer, or scrap.tf by your saved price list), less what it cost at today's key price and your friction. Items with neither count at nothing and are left out of the P/L. Unrealised: nothing is booked until you record a sale. The ledger CSV carries the same per open lot (worth_now_ref, unrealised_ref, valued_at).";

/**
 * 0.9: the Journal's "Unrealised P/L" card from one holdings read (holdingsValuationOf), with its as-of time; never a
 * sale. An error reads "Holdings could not be read", no read yet "reading Holdings…", nothing held "nothing held";
 * otherwise the signed P/L, the worth now, the read's time and the items with no exit (left out of the P/L).
 */
export function inventoryStat(v: HoldingsValuation | null, keyScrap: Scrap | null, error: string | null = null): StatView {
  if (error) return { value: DASH, sub: 'Holdings could not be read', muted: true, title: INVENTORY_TITLE };
  if (v === null) return { value: DASH, sub: 'reading Holdings…', muted: true, title: INVENTORY_TITLE };
  if (v.items === 0) return { value: DASH, sub: 'nothing held', muted: true, title: INVENTORY_TITLE };
  const k = v.keyScrap ?? keyScrap;
  const unpriced = v.unpricedItems ? ` · ${plural(v.unpricedItems, 'item', 'items')} with no exit` : '';
  return {
    value: fmtSignedMoney(v.profitNowScrap, k),
    sub: `worth ${fmtMoney(v.worthNowScrap, k)} · as of ${fmtDateTime(v.at)}${unpriced}`,
    muted: false,
    title: `${INVENTORY_TITLE} Read ${fmtDateTime(v.at)}.`,
  };
}

/** Completed flips' sub-line: how many of them were write-offs; null with none. */
export function writtenOffText(n: number): string | null {
  return n > 0 ? `incl. ${n} written off` : null;
}

/** A Results rate cell: muted, with a tooltip saying so, below MIN_RATE_TRADES flips. */
export function rateCell(ratio: number | null, trades: number, digits = 0): { text: string; muted: boolean; title: string | undefined } {
  const few = trades < MIN_RATE_TRADES;
  return { text: fmtPct(ratio, digits), muted: few, title: few ? `Only ${plural(trades, 'flip', 'flips')}: too few to read much into.` : undefined };
}

/** A Results fees cell: DASH when no flip recorded a fee, and a tooltip counting the flips that lack one. */
export function feesCell(r: Pick<JournalStats, 'feesScrap' | 'feesRecorded' | 'feesMissing' | 'trades'>, keyScrap: Scrap | null): { text: string; title: string | undefined } {
  return {
    text: r.feesRecorded === 0 ? DASH : fmtMoney(r.feesScrap, keyScrap),
    title: r.feesMissing > 0 ? `${r.feesMissing} of ${r.trades} flips lack a fee on one side or both` : undefined,
  };
}

/**
 * The notes under the Results table: missing fees, sales and (0.8) write-offs left out (waiting, counted apart by
 * waitingCounts so a write-off is never called a sale) and how the figures are booked.
 */
export function resultsNotes(t: JournalTotals, waitingSales: number, waitingWriteoffs = 0): string[] {
  const out: string[] = [];
  if (t.feesMissing > 0 && t.feesMissing === t.trades) out.push('No flip has its fees recorded on both sides yet: profit and ROI are before fees.');
  else if (t.feesMissing > 0) out.push(`${t.feesMissing} of ${t.trades} flips lack a recorded fee on one side or both: their profit may be before fees.`);
  const sales = waitingSales > 0 ? waitingSales : 0;
  const writeoffs = waitingWriteoffs > 0 ? waitingWriteoffs : 0;
  if (sales + writeoffs > 0) {
    const what = [sales > 0 ? plural(sales, 'sale', 'sales') : null, writeoffs > 0 ? plural(writeoffs, 'write-off', 'write-offs') : null].filter((x) => x !== null).join(' and ');
    out.push(`${what} without a recorded buy ${sales + writeoffs === 1 ? 'is' : 'are'} not counted.`);
  }
  out.push("Profit is booked at each sale's key price. ROI is profit over cost, not annualised. Hold time runs from the logged buy to the logged sale.");
  return out;
}

/** One Losing flips line. */
export interface LossRowView {
  sku: string;
  name: string;
  bought: string;
  sold: string;
  costScrap: Scrap;
  fees: string;
  profitScrap: Scrap;
  sellId: number;
}

/** A losing flip as the Losing flips card shows it: both dates and venues (or "written off"), cost, fees, loss. */
export function lossRowView(c: JournalClosedTrade, keyScrap: Scrap | null): LossRowView {
  return {
    sku: c.sku,
    name: c.name,
    bought: `${fmtDate(c.boughtAt)} · ${venueLabel(c.buyVenue)}`,
    sold: c.kind === 'writeoff' ? `${fmtDate(c.soldAt)} · written off` : `${fmtDate(c.soldAt)} · ${venueLabel(c.sellVenue)}`,
    costScrap: c.costScrap,
    fees: c.feesScrap === null ? 'not recorded' : fmtMoney(c.feesScrap, keyScrap),
    profitScrap: c.profitScrap,
    sellId: c.sellId,
  };
}

/**
 * 0.8 (J6): the Record trade dialog in edit mode for `e`: its booked pair (from `idx`, over the whole journal) and
 * the pair's other row (from `rows`, the page's list) for the before/after profit; editPair null when `e` closed no
 * pair. The list holds the newest 2000 rows only, so a sale whose buy is older keeps its pair with `other` null
 * (editComparison then shows the booked profit), never reading as a sale with no buy. Without `idx` (the summary is
 * loading or failed) editPairUnknown is set, so the dialog never says "no recorded buy" or "Still held" on a guess.
 */
export function journalEditInit(e: JournalEntry, idx: JournalIndex | null, rows: readonly JournalEntry[] | null | undefined): RecordTradeInit {
  // No summary yet (loading, or it failed): whether `e` closed a pair is unknown, not "none" (editPairUnknown).
  if (!idx) return { side: e.side, sku: e.sku, name: e.name, editOf: e, editPair: null, editPairUnknown: true };
  const closed = e.side === 'buy' ? idx.closedByBuy.get(e.id) : idx.closedBySell.get(e.id);
  if (!closed) return { side: e.side, sku: e.sku, name: e.name, editOf: e, editPair: null };
  const otherId = e.side === 'buy' ? closed.sellId : closed.buyId;
  const other = (rows ?? []).find((r) => r.id === otherId) ?? null;
  return { side: e.side, sku: e.sku, name: e.name, editOf: e, editPair: { closed, other } };
}

/** Still holding's Write off…: the dialog for one unit of the position, venue WRITE_OFF_VENUE. */
export function writeOffInit(p: Pick<JournalPosition, 'sku' | 'name'>): RecordTradeInit {
  return { side: 'writeoff', sku: p.sku, name: p.name, venue: WRITE_OFF_VENUE };
}
