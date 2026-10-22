// 0.9 (#3, #12): the dashboard's words for the risk-aware ranking keys and the suggested price-move reserve. Pure. Buyer
// counts are demand, never a chance of a sale; the suggestion is never applied for the user.

import { buyerDepthOf, exitOrdersOfSummaries, type CeilingSettings } from '../shared/ceiling';
import { EXIT_DEPTH_CAP, exitDepthOf, exitRiskAt, liquidityTagOf, opportunityRiskFields } from '../shared/exitRisk';
import { TYPICAL_HOLD_MIN_ALL } from '../shared/journal';
import { RESERVE_MIN_ITEMS, RESERVE_MIN_WINDOWS } from '../shared/reserveSuggest';
import type {
  LiquidityTag,
  MarketRow,
  Opportunity,
  OrderSummary,
  ProfitSettings,
  ReserveBand,
  ReserveBandSuggestion,
  ReserveSampleCount,
  ReserveSuggestion,
  Scrap,
  UnixMs,
} from '../shared/types';
import { fmtHold, fmtSignedMoney, ratioPctText } from './format';
import { marketSellsForTitle } from './marketModel';
import { revenueOrderOf, singleExitTitleOf } from './oppModel';

/** 0.9 (#3): the closing sentence of every risk text (E.1 rule 5). */
export const DEMAND_NOT_SALES = 'Buy orders show demand, not sales.';

/**
 * 0.9 (#3): the book-depth tag (liquidityTagOf) in words. Review: the depth counts usable buyers only (exitDepthOf: not
 * an outlier, and a bot under Instant), never every buyer the Buyers cell counts, so the words name that population.
 */
export const BOOK_DEPTH_LABELS: Record<LiquidityTag, string> = {
  none: 'no usable buyer seen in the last 24 h',
  one: 'one usable buyer',
  few: 'a few usable buyers',
  many: 'many usable buyers',
};

/** Review: the same under Instant, whose depth counts bot buyers only. */
export const BOOK_DEPTH_BOT_LABELS: Record<LiquidityTag, string> = {
  none: 'no bot buyer seen in the last 24 h',
  one: 'one bot buyer',
  few: 'a few bot buyers',
  many: 'many bot buyers',
};

/** Review: who the counts leave out (exitDepthOf), per profit.useOrder; unknown (a caller without settings): both rules. */
export function depthPopulationNote(useOrder?: ProfitSettings['useOrder'] | null): string {
  if (useOrder === 'instant') return 'Under Instant only bots count; outlier orders never do.';
  if (useOrder === 'best' || useOrder === 'conservative') return 'Outlier orders are not counted.';
  return 'Outlier orders are not counted, and under Instant only bots are.';
}

/** 0.9 (#3): "20+" at EXIT_DEPTH_CAP (profitableDepth's cap), else the number. */
export function depthCountText(n: number): string {
  return n >= EXIT_DEPTH_CAP ? `${EXIT_DEPTH_CAP}+` : String(n);
}

type RiskFields = Partial<Pick<Opportunity, 'backupProfitScrap' | 'bookDepth'>> & { profitableDepth?: number | null };

/**
 * 0.9 (#3): the risk sentences at a cost ("this cost", "your price" or "the rule estimate"): buyers at break-even as
 * "N of M seen in the last 24 h", the profit if this buyer leaves (only with a revenue), and the book-depth tag. []
 * when the row carries no risk fields (stored before V16, or no book). With no price to judge there is no "N of M", so
 * the depth sentence carries the count itself ("a few buyers (3 seen in the last 24 h)"): the count is always shown.
 * Review: the counts name their population ("usable buyers", "bot buyers" under Instant) and depthPopulationNote says
 * who is left out, so a book of humans under Instant never reads "no buyer seen" beside a Buyers cell of 5.
 */
export function riskSentences(
  r: RiskFields,
  keyScrap: Scrap | null,
  at: 'this cost' | 'your price' | 'the rule estimate',
  hasRevenue: boolean,
  useOrder?: ProfitSettings['useOrder'] | null,
): string[] {
  if (typeof r.bookDepth !== 'number' || !Number.isFinite(r.bookDepth)) return [];
  const tag = liquidityTagOf(r.bookDepth);
  if (tag === null) return [];
  const out: string[] = [];
  const judged = typeof r.profitableDepth === 'number';
  const bots = useOrder === 'instant';
  if (typeof r.profitableDepth === 'number') {
    out.push(`Buyers at break-even at ${at}: ${depthCountText(r.profitableDepth)} of ${depthCountText(r.bookDepth)} ${bots ? 'bot' : 'usable'} buyers seen in the last 24 h.`);
    if (hasRevenue) {
      out.push(
        typeof r.backupProfitScrap === 'number'
          ? `If this buyer leaves: ${fmtSignedMoney(r.backupProfitScrap, keyScrap)} at the next buyer seen in the last 24 h.`
          : 'If this buyer leaves: no other buyer seen in the last 24 h.',
      );
    }
  } else out.push('Buyers at break-even: no price of yours to judge.');
  // "none" and "one" say their number; "a few" and "many" need it when no "N of M" above gave it.
  const count = !judged && (tag === 'few' || tag === 'many') ? ` (${depthCountText(r.bookDepth)} seen in the last 24 h)` : '';
  out.push(`Book depth: ${(bots ? BOOK_DEPTH_BOT_LABELS : BOOK_DEPTH_LABELS)[tag]}${count}.`);
  out.push(depthPopulationNote(useOrder));
  return out;
}

/**
 * 0.9 (#3): the Opportunities Buyers cell hover: the single-exit text (singleExitTitleOf) or the buyer count, then the
 * risk sentences at this cost and DEMAND_NOT_SALES. A row stored before V16 keeps the count alone. useOrder (the table's
 * Settings.profit.useOrder) names who the depth counts.
 */
export function oppBuyersTitle(
  o: Pick<Opportunity, 'flags' | 'reasons' | 'buyerCount' | 'revenueScrap'> & RiskFields,
  keyScrap: Scrap | null,
  useOrder?: ProfitSettings['useOrder'] | null,
): string {
  const head = singleExitTitleOf(o) ?? `${o.buyerCount} ${o.buyerCount === 1 ? 'buyer' : 'buyers'} with eligible orders.`;
  const risk = riskSentences(o, keyScrap, 'this cost', o.revenueScrap !== null, useOrder);
  return risk.length > 0 ? `${head} ${risk.join(' ')} ${DEMAND_NOT_SALES}` : head;
}

/**
 * 0.9 (#3): the Live market's risk sentences (Buyers hover), at your price else the rule estimate; null without a book.
 * Recheck: useOrder (the page's Settings.profit.useOrder, which the service's exitDepthOf counted with) names who the
 * depth counts, as the Opportunities hover; without one (a caller without settings) the note gives both rules.
 */
export function marketRiskTitle(
  r: Pick<MarketRow, 'revenueScrap' | 'knownCostScrap'> & RiskFields,
  keyScrap: Scrap | null,
  useOrder?: ProfitSettings['useOrder'] | null,
): string | null {
  const at = typeof r.knownCostScrap === 'number' && Number.isFinite(r.knownCostScrap) ? 'your price' : 'the rule estimate';
  const risk = riskSentences(r, keyScrap, at, r.revenueScrap !== null, useOrder);
  return risk.length > 0 ? `${risk.join(' ')} ${DEMAND_NOT_SALES}` : null;
}

/** 0.9 (#3): the Live market's Sells for hover: marketSellsForTitle (unchanged, first) followed by marketRiskTitle. */
export function marketSellsTitle(r: MarketRow, keyScrap: Scrap | null, now?: UnixMs, useOrder?: ProfitSettings['useOrder'] | null): string {
  return [marketSellsForTitle(r, keyScrap, now), marketRiskTitle(r, keyScrap, useOrder)].filter((s): s is string => !!s).join(' ');
}

/** 0.9 (#3): the drawer's "Buyers at break-even" label hover. */
export const DRAWER_RISK_HELP =
  'Different buyers seen in the last 24 h whose order pays at least break-even at this cost (profit 0 or more after friction and the price-move reserve), out of every usable buyer seen in the last 24 h (outlier orders are not counted, and under Instant only bots are), and the profit at the next one if the buyer your profit uses fills or withdraws. A count of buyers is demand, never a chance of a sale.';

/** 0.9 (#3): the drawer input card's "Buyers at break-even" line; tone 'warn' on a profitable row with at most one such buyer. */
export interface DrawerRiskLine {
  text: string;
  title: string;
  tone: 'warn' | null;
}

/**
 * 0.9 (#3): the drawer input card's "Buyers at break-even" line over the drawer's own book (ItemDetail.buyOrders): the
 * same book and the same buyerDepthOf result as the Next buyer line above it (nextBuyerLine, oppModel.ts), so the two
 * lines never disagree (a stored row against a refreshed book). Null without a finite cost, or when the row's revenue
 * order is not among the book's eligible orders (another copy's classification), as nextBuyerLine. An unverified next
 * buyer is no backup here ("none seen in 24 h"); the Next buyer line marks that same order "not seen in 24 h".
 */
export function drawerRiskLine(
  o: Pick<Opportunity, 'status' | 'revenueScrap' | 'costScrap' | 'bestOrder' | 'consOrder' | 'instantOrder'>,
  buyOrders: readonly OrderSummary[],
  p: CeilingSettings & Pick<ProfitSettings, 'useOrder'>,
  keyScrap: Scrap | null,
): DrawerRiskLine | null {
  const orders = exitOrdersOfSummaries(buyOrders);
  const order = revenueOrderOf(o, p.useOrder);
  const depth = order ? buyerDepthOf(orders, order.listingId, p.useOrder) : null;
  if (depth !== null && depth.revenueBuyer === null) return null;
  const risk = exitRiskAt({ exitDepth: exitDepthOf(orders, p.useOrder), nextBuyer: depth?.nextBuyer ?? null }, o.costScrap, p);
  if (!risk || risk.profitableDepth === null) return null;
  const f = opportunityRiskFields(risk);
  const hasRevenue = order !== null;
  const leaves = hasRevenue
    ? ` · if this buyer leaves ${typeof f.backupProfitScrap === 'number' ? fmtSignedMoney(f.backupProfitScrap, keyScrap) : 'none seen in 24 h'}`
    : '';
  return {
    text: `${depthCountText(risk.profitableDepth)} of ${depthCountText(risk.bookDepth)} ${p.useOrder === 'instant' ? 'bot' : 'usable'} buyers seen in 24 h${leaves}`,
    title: `${riskSentences(f, keyScrap, 'this cost', hasRevenue, p.useOrder).join(' ')} From the buy orders in this panel, as the Next buyer line. ${DEMAND_NOT_SALES}`,
    tone: o.status === 'profitable' && risk.profitableDepth <= 1 ? 'warn' : null,
  };
}

/** 0.9 (#12): the reserve suggestion's value bands in words. */
export const RESERVE_BAND_LABELS: Record<ReserveBand, string> = {
  'under-10-ref': 'Under 10 ref',
  'to-1-key': '10 ref to 1 key',
  'key-plus': '1 key and up',
};

/** 0.9 (#12): the suggestion's hover: what the figure is, its two sources, and that it is never a forecast nor applied. */
export const RESERVE_SUGGEST_HELP =
  'The 10th percentile of how much the exit moved in scrap over that hold, so 9 in 10 of those changes fell less or rose. Your recorded exits are the buy order your profit used, seen while Flip Desk ran (items you held or watched) since your buyer settings last changed; PriceDB is its buy price in the history of items you opened this session. ' +
  "Both value keys at PriceDB's key price of their own time, so a key price move counts as a move; a recorded exit priced in keys counts only while that key history is loaded (opening the history of an item priced in keys loads it). " +
  'A suggestion from past data, never a forecast. Flip Desk never sets the reserve for you.';

function countText(n: ReserveSampleCount): string {
  return `${n.windows} ${n.windows === 1 ? 'change' : 'changes'} from ${n.items} ${n.items === 1 ? 'item' : 'items'}`;
}

/**
 * 0.9 (#12): one band's line: "Under 10 ref: 7% (24 changes from 4 items, your recorded exits)", or "not enough data"
 * with the larger source's counts and what is needed (RESERVE_MIN_WINDOWS from RESERVE_MIN_ITEMS items).
 */
export function reserveBandText(b: ReserveBandSuggestion): string {
  const label = RESERVE_BAND_LABELS[b.band];
  if (b.source === null || b.suggestedPct === null) {
    const most = b.recorded.windows >= b.pricedb.windows ? b.recorded : b.pricedb;
    return `${label}: not enough data (${countText(most)}; needs ${RESERVE_MIN_WINDOWS} from ${RESERVE_MIN_ITEMS} items)`;
  }
  const n = b.source === 'recorded' ? b.recorded : b.pricedb;
  return `${label}: ${ratioPctText(b.suggestedPct)} (${countText(n)}, ${b.source === 'recorded' ? 'your recorded exits' : 'PriceDB history of items you opened'})`;
}

/** 0.9 (#12): the Settings note under the price-move reserve field. */
export interface ReserveSuggestionView {
  head: string;
  lines: { band: ReserveBand; text: string }[];
  title: string;
}

/**
 * 0.9 (#12): the note's words: the hold it used (the journal's typical hold with its sales, or the default and why),
 * one line per band, and the hover (RESERVE_SUGGEST_HELP, plus the units still held the typical hold leaves out).
 * A typical hold outside [1 h, 14 d] is measured at the bound, and the head says so and gives the user's own hold
 * (holdClampedFromMs), never calling the bound "your typical hold".
 * Null without an answer (loading, an error, a bridge that does not answer the method).
 */
export function reserveSuggestionView(s: ReserveSuggestion | null | undefined): ReserveSuggestionView | null {
  if (!s || !Array.isArray(s.bands)) return null;
  const hold = fmtHold(s.holdMs);
  const sales = `${s.holdSales} ${s.holdSales === 1 ? 'sale' : 'sales'}`;
  const typical = typeof s.holdClampedFromMs === 'number' && Number.isFinite(s.holdClampedFromMs) ? s.holdClampedFromMs : null;
  const head =
    s.holdFrom !== 'journal'
      ? `What your data suggests over a ${hold} hold (no typical hold yet: fewer than ${TYPICAL_HOLD_MIN_ALL} recorded sales):`
      : typical !== null
        ? `What your data suggests over a ${hold} hold (the ${typical < s.holdMs ? 'shortest' : 'longest'} it measures; your typical hold is ${fmtHold(typical)}, from ${sales}):`
        : `What your data suggests over a ${hold} hold (your typical hold, from ${sales}):`;
  const left =
    s.holdStillHeld > 0 ? ` Your typical hold leaves out the ${s.holdStillHeld} ${s.holdStillHeld === 1 ? 'unit' : 'units'} you still hold, often the longer holds.` : '';
  return { head, lines: s.bands.map((b) => ({ band: b.band, text: reserveBandText(b) })), title: `${RESERVE_SUGGEST_HELP}${left}` };
}
