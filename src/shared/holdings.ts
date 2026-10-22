// Holdings (F11) rules shared by the service's holdings module, the browser mock
// and the dashboard, so all three give a held item the same figures, status,
// order, totals and CSV cells (as market.ts does for the Live market). Pure: no
// I/O, no network. The buy side comes from the local backpack.tf book only.

import { ORDER_UNVERIFIED_AFTER_MS } from './buyerSeen';
import { formatScrap, valueScrap } from './currency';
import { frictionOf, profitStatus, type CeilingSettings } from './ceiling';
import { marketSearchTokens } from './market';
import { bestExitOf, holdingListFields, scraptfListFresh } from './scraptfList';
import { HOLDING_EXIT_VENUES, HOLDING_STATUSES } from './types';
import type {
  Category,
  ConfidenceLevel,
  HoldingAskSide,
  HoldingRefs,
  HoldingRow,
  HoldingStatus,
  HoldingsQuery,
  HoldingsResult,
  HoldingsValuation,
  JournalLot,
  JournalLotValue,
  JournalPosition,
  KeyPriceState,
  NextBuyer,
  OpportunityStatus,
  OrderSummary,
  ReferencePrices,
  Scrap,
  ScraptfListRow,
  UnixMs,
} from './types';
import type { JournalLotValuer } from './journal';

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const STATUS_OF: Readonly<Record<OpportunityStatus, HoldingStatus>> = {
  profitable: 'sell',
  'below-threshold': 'hold',
  unprofitable: 'loss',
  'no-buyers': 'no-buyers',
};

/** profitStatus in holding terms (see HoldingStatus). */
export function holdingStatusOf(s: OpportunityStatus): HoldingStatus {
  return STATUS_OF[s] ?? 'no-buyers';
}

/**
 * The backpack.tf side of one held base SKU: the Live market entry for it, or the same
 * evaluation (evaluateMarketBase) run on demand before the index has reached it.
 */
export interface HoldingBuySide {
  revenueScrap: Scrap | null;
  bestScrap: Scrap | null;
  instantScrap: Scrap | null;
  revenueOrder: OrderSummary | null;
  bestOrder: OrderSummary | null;
  buyerCount: number;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  flags: readonly string[];
  lastOrderChangeAt: UnixMs | null;
  /**
   * 0.8 (PC-2, H2): the market entry's next buyer (buyerDepthOf) and distinct buyers seen in the last 24 h.
   * Optional: absent, the row carries no depth (holdingRow copies them only when set).
   */
  nextBuyer?: NextBuyer | null;
  verifiedBuyerCount?: number;
}

/**
 * Profit if the next lot (FIFO) sold now, profit if every unit did, and the status, judged on the
 * next lot exactly as an opportunity is judged on its cost (profitStatus with settings.profit).
 * Friction only, never the price-move reserve (0.8, PC-1, R-PC1-sell): selling into a live order
 * (this buyer, or the next one) leaves no price move to cover.
 */
export function holdingFigures(
  a: { revenueScrap: Scrap | null; qty: number; costScrap: Scrap; nextLotCostScrap: Scrap },
  p: CeilingSettings,
): Pick<HoldingRow, 'profitNowScrap' | 'profitAllScrap' | 'margin' | 'status'> {
  const friction = frictionOf(p);
  if (!finite(a.revenueScrap)) return { profitNowScrap: null, profitAllScrap: null, margin: null, status: 'no-buyers' };
  const qty = finite(a.qty) && a.qty > 0 ? Math.floor(a.qty) : 0;
  const profitNowScrap = a.revenueScrap - a.nextLotCostScrap - friction;
  const profitAllScrap = a.revenueScrap * qty - a.costScrap - friction * qty;
  const margin = a.nextLotCostScrap > 0 ? profitNowScrap / a.nextLotCostScrap : null;
  return { profitNowScrap, profitAllScrap, margin, status: holdingStatusOf(profitStatus(profitNowScrap, a.nextLotCostScrap, p)) };
}

/**
 * A lot's cost at today's key price `keyScrap` (the one the revenue is valued at), from its own keys
 * and metal. The journal nets a sale against a buy per currency and values the difference at the
 * sale's key price, so revenue(K) - lotCost(K) is exactly what it will book; valuing the lot at its
 * buy-time key price instead would read a key price move as profit or loss. Without a key price, or
 * for a lot without its currencies, the buy-time cost.
 */
export function lotCostAt(lot: Pick<JournalLot, 'costScrap'> & Partial<Pick<JournalLot, 'keys' | 'scrap'>>, keyScrap: Scrap | null): Scrap {
  if (!(finite(keyScrap) && keyScrap > 0) || !finite(lot.keys) || !finite(lot.scrap)) return lot.costScrap;
  return valueScrap(lot.keys, lot.scrap, keyScrap);
}

/**
 * A position's total cost at today's key price `keyScrap` (lotCostAt per lot), as Holdings and the
 * Journal page show it. qty === lots.length for every position journalSummary builds; anything else
 * keeps the stored (buy-time) total.
 */
export function positionCostAt(pos: Pick<JournalPosition, 'qty' | 'costScrap' | 'lots'>, keyScrap: Scrap | null): Scrap {
  const lots = Array.isArray(pos.lots) ? pos.lots : [];
  return lots.length > 0 && lots.length === pos.qty ? lots.reduce((t, l) => t + lotCostAt(l, keyScrap), 0) : pos.costScrap;
}

/** 0.8: the row's parts read beside the book (the service and the mock fill every field); typicalHold is the journal's withTypicalHold. */
export interface HoldingRowExtras {
  ask: HoldingAskSide | null;
  refs: HoldingRefs | null;
  snapshotAt: UnixMs | null;
}

/**
 * One row from an open journal position (journalSummary().open) and its buy side; `buy` null means
 * no eligible buy order. Lots are valued at `keyScrap`, today's key price (lotCostAt). A painted copy
 * is priced against its clean base, so it is flagged has-extras like a painted price on the Live market.
 * `scraptf` (F14) is the base SKU's saved scrap.tf/items row (valued at `keyScrap`) and the time it is
 * judged at: the better exit (bestExitOf) sets exitScrap, and status and profit are judged on it.
 * Omitted, backpack.tf is the only exit and the row is exactly as before F14. 0.8: `extras` (the ask side,
 * references and last snapshot) are spread in when given; without them the row is as before plus the next
 * lot's key price (nextLotKeyPriceScrap).
 */
export function holdingRow(
  pos: JournalPosition,
  category: Category,
  buy: HoldingBuySide | null,
  p: CeilingSettings,
  keyScrap: Scrap | null = null,
  scraptf: { list: ScraptfListRow | null; now: UnixMs } | null = null,
  extras: HoldingRowExtras | null = null,
): HoldingRow {
  const lots = Array.isArray(pos.lots) ? pos.lots : [];
  const qty = pos.qty;
  const next = lots[0];
  const costScrap = positionCostAt(pos, keyScrap);
  const nextLotCostScrap = next ? lotCostAt(next, keyScrap) : qty > 0 ? Math.round(pos.costScrap / qty) : pos.costScrap;
  const revenueScrap = buy?.revenueScrap ?? null;
  const flags = buy ? [...buy.flags] : [];
  if (/;p\d/.test(pos.sku) && !flags.includes('has-extras')) flags.push('has-extras');
  const list = scraptf?.list ?? null;
  const exit = bestExitOf(revenueScrap, list, scraptf?.now ?? 0);
  return {
    sku: pos.sku,
    name: pos.name,
    category,
    qty,
    costScrap,
    nextLotCostScrap,
    // 0.7.4 (R23): the lot's own currencies, for Record sale's backfill preview; 0.8 (H6): and its key price
    // then, for the advice's key-exposure reason.
    ...(next && finite(next.keys) && finite(next.scrap) ? { nextLotKeys: next.keys, nextLotScrapRaw: next.scrap } : {}),
    ...(next && finite(next.keys) && finite(next.scrap) && finite(next.keyPriceScrap) && next.keyPriceScrap > 0 ? { nextLotKeyPriceScrap: next.keyPriceScrap } : {}),
    heldSince: next?.ts ?? 0,
    revenueScrap,
    bestScrap: buy?.bestScrap ?? null,
    instantScrap: buy?.instantScrap ?? null,
    revenueOrder: buy?.revenueOrder ?? null,
    bestOrder: buy?.bestOrder ?? null,
    buyerCount: buy?.buyerCount ?? 0,
    // 0.8 (PC-2, H2): the buy side's depth when it carries one (evaluateMarketBase and the mock always do).
    ...(buy && buy.nextBuyer !== undefined ? { nextBuyer: buy.nextBuyer } : {}),
    ...(buy && typeof buy.verifiedBuyerCount === 'number' ? { verifiedBuyerCount: buy.verifiedBuyerCount } : {}),
    ...holdingListFields(list),
    ...exit,
    // Judged on the better exit, so a holding can be 'sell' through scrap.tf (F14).
    ...holdingFigures({ revenueScrap: exit.exitScrap, qty, costScrap, nextLotCostScrap }, p),
    confidence: buy?.confidence ?? 0,
    confidenceLevel: buy?.confidenceLevel ?? 'low',
    flags,
    lastOrderChangeAt: buy?.lastOrderChangeAt ?? null,
    ...(extras ? { ask: extras.ask, refs: extras.refs, snapshotAt: extras.snapshotAt } : {}),
  };
}

/**
 * 0.7.4: a held row's scrap.tf exit as the row to tell, when its backpack.tf exit is held back (an unverified buyer,
 * or one below notifications.minConfidence): the row judged on what scrap.tf's bank pays (bestExit 'scraptf') when
 * its saved list row pays something, is not full, is fresh (scraptfListFresh) and clears the profit thresholds on
 * its own (holdingFigures 'sell'); else null, and the backpack.tf exit waits as before. bestExitOf picks the exit
 * by value only, so a higher order nobody has confirmed must not hide a lower, fresh and profitable bank price.
 * Friction only, never the price-move reserve (0.8, PC-1): a sale into a live order. Moved here from the
 * service in 0.8 so the shared advice (holdingAdvice) uses it.
 */
export function scraptfAlternative(r: HoldingRow, p: CeilingSettings, now: UnixMs): HoldingRow | null {
  if (r.bestExit !== 'backpack' || !finite(r.scraptfPaysScrap) || r.scraptfFull || !finite(r.scraptfListAt)) return null;
  if (!scraptfListFresh({ observedAt: r.scraptfListAt }, now)) return null;
  const fig = holdingFigures({ revenueScrap: r.scraptfPaysScrap, qty: r.qty, costScrap: r.costScrap, nextLotCostScrap: r.nextLotCostScrap }, p);
  if (fig.status !== 'sell' || !finite(fig.profitNowScrap)) return null;
  return { ...r, bestExit: 'scraptf', exitScrap: r.scraptfPaysScrap, exitVenue: HOLDING_EXIT_VENUES.scraptf, ...fig };
}

// ---------------------------------------------------------------------------
// 0.8 (H3, H4): the ask side and the references beside a held row
// ---------------------------------------------------------------------------

/** 0.8 (H3): one sell listing as the ask side reads it (service: a copy-matched Listing, asks.ts; mock: a book sell order). */
export interface AskCandidate {
  id: string;
  steamid: string;
  keys: number;
  metalScrap: Scrap;
  /** Valued at the key price the row is valued at. */
  valueScrap: Scrap;
  isBot: boolean;
  lastEventAt: UnixMs;
  /** marketplace.tf, banned, flagged as an impersonator or blocklisted: never counted. */
  excluded: boolean;
}

/** Lowest value first; ties go to the most recently seen, then the id. */
function askOrder(a: AskCandidate, b: AskCandidate): number {
  return a.valueScrap - b.valueScrap || b.lastEventAt - a.lastEventAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 0.8 (H3): HoldingAskSide over `asks`, or null when none counts. Counted: not excluded, valueScrap > 0, seen
 * within ORDER_UNVERIFIED_AFTER_MS (a stamp ahead of `now` counts as recent; NaN never), and not one of
 * `ownSteamIds` (counted in ownLeftOut instead). One per seller (steamid, else `id:<id>`, as buyerCountOf): their
 * lowest. Lowest first; ties go to the most recently seen, then the id.
 */
export function askSideOf(asks: readonly AskCandidate[], now: UnixMs, ownSteamIds: ReadonlySet<string>): HoldingAskSide | null {
  const bySeller = new Map<string, AskCandidate>();
  let ownLeftOut = 0;
  for (const a of Array.isArray(asks) ? asks : []) {
    if (!a || a.excluded || !finite(a.valueScrap) || a.valueScrap <= 0) continue;
    // An ask nobody has seen for a day may be gone, as an unverified buy order.
    if (!finite(a.lastEventAt) || !(now - a.lastEventAt <= ORDER_UNVERIFIED_AFTER_MS)) continue;
    if (a.steamid && ownSteamIds.has(a.steamid)) {
      ownLeftOut++;
      continue;
    }
    const seller = a.steamid || `id:${a.id}`;
    const cur = bySeller.get(seller);
    if (!cur || askOrder(a, cur) < 0) bySeller.set(seller, a);
  }
  const counted = [...bySeller.values()].sort(askOrder);
  const lowest = counted[0];
  if (!lowest) return null;
  return {
    lowestScrap: lowest.valueScrap,
    lowestKeys: finite(lowest.keys) ? lowest.keys : 0,
    lowestMetalScrap: finite(lowest.metalScrap) ? lowest.metalScrap : 0,
    lowestIsBot: lowest.isBot === true,
    lowestSeenAt: lowest.lastEventAt,
    count: counted.length,
    botCount: counted.filter((a) => a.isBot === true).length,
    ownLeftOut,
    mayIncludeOwn: ownSteamIds.size === 0,
  };
}

/**
 * 0.8 (H4): a held row's references from the age-gated ones (`usable`: stale ones already null, as the service's
 * usableReferences returns them) and the reasons they were left out. Null when nothing is stored and nothing left out.
 */
export function holdingRefsOf(usable: ReferencePrices, ignored: readonly string[]): HoldingRefs | null {
  const p = usable?.pricedb ?? null;
  const c = usable?.community ?? null;
  const left = Array.isArray(ignored) ? ignored : [];
  if (p === null && c === null && left.length === 0) return null;
  return {
    pricedbBuyScrap: p?.buyScrap ?? null,
    pricedbSellScrap: p?.sellScrap ?? null,
    pricedbAgeMs: p?.ageMs ?? null,
    communityScrap: c?.valueScrap ?? null,
    communityHighScrap: c?.valueHighScrap ?? null,
    ignored: [...left],
  };
}

const STATUS_RANK: ReadonlyMap<HoldingStatus, number> = new Map(HOLDING_STATUSES.map((s, i) => [s, i]));

/** Status (sell first), then profitNowScrap descending (missing last), then name and SKU. */
export function holdingComparator(a: HoldingRow, b: HoldingRow): number {
  const rank = (s: HoldingStatus) => STATUS_RANK.get(s) ?? HOLDING_STATUSES.length;
  const byStatus = rank(a.status) - rank(b.status);
  if (byStatus !== 0) return byStatus;
  const pa = finite(a.profitNowScrap) ? a.profitNowScrap : null;
  const pb = finite(b.profitNowScrap) ? b.profitNowScrap : null;
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pb - pa;
  }
  return a.name.localeCompare(b.name) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
}

/** Every search word (marketSearchTokens) in the name or the SKU. */
export function holdingMatches(r: Pick<HoldingRow, 'name' | 'sku'>, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = `${r.name} ${r.sku}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/** Rows matching q in holdingComparator order (the page and the CSV). */
export function holdingsMatching(rows: readonly HoldingRow[], q: HoldingsQuery): HoldingRow[] {
  const tokens = marketSearchTokens(q.search);
  return rows.filter((r) => holdingMatches(r, tokens)).sort(holdingComparator);
}

/** 0.9 (#1): the row's next unit was inside the trade lock at the read (tradeLock.nextLotTradableAt set). */
export function holdingLockedNow(r: Partial<Pick<HoldingRow, 'tradeLock'>>): boolean {
  return typeof r.tradeLock?.nextLotTradableAt === 'number' && Number.isFinite(r.tradeLock.nextLotTradableAt);
}

/**
 * See HoldingsResult.totals: rows without an exit add to items, units and cost only. 0.9 (#1): a row whose next unit is
 * still inside the 7-day trade lock (holdingLockedNow) is not sellable now and counts in `locked` (absent at 0).
 */
export function holdingsTotals(rows: readonly HoldingRow[]): HoldingsResult['totals'] {
  const t: HoldingsResult['totals'] = { items: 0, units: 0, costScrap: 0, worthNowScrap: 0, profitNowScrap: 0, sellable: 0 };
  for (const r of rows) {
    t.items++;
    t.units += r.qty;
    t.costScrap += r.costScrap;
    // Worth at the better exit (F14); exitScrap is the revenue when backpack.tf is the only one.
    const exit = finite(r.exitScrap) ? r.exitScrap : r.revenueScrap;
    if (finite(exit)) t.worthNowScrap += exit * r.qty;
    if (finite(r.profitAllScrap)) t.profitNowScrap += r.profitAllScrap;
    // 0.9 (#1): with a 7-day trade lock, an item whose next unit is still locked cannot be sold now.
    const locked = holdingLockedNow(r);
    if (locked) t.locked = (t.locked ?? 0) + 1;
    if (r.status === 'sell' && !locked) t.sellable++;
  }
  return t;
}

/** 'holdings.list': the matching rows in order, totals over every row. */
export function holdingsResult(rows: readonly HoldingRow[], q: HoldingsQuery, keyPrice: KeyPriceState | null, now: UnixMs): HoldingsResult {
  return { rows: holdingsMatching(rows, q), totals: holdingsTotals(rows), keyPrice, generatedAt: now };
}

// ---------------------------------------------------------------------------
// 0.9: the valuation of everything held, for the Journal's card and the ledger CSV
// ---------------------------------------------------------------------------

/** A row's per-unit exit as Worth now counts it (holdingsTotals' rule): exitScrap, else revenueScrap; null without either. */
function rowExitOf(r: Pick<HoldingRow, 'exitScrap' | 'revenueScrap'>): Scrap | null {
  return finite(r.exitScrap) ? r.exitScrap : finite(r.revenueScrap) ? r.revenueScrap : null;
}

/**
 * 0.9: Holdings' valuation of everything held as of one read, for the Journal's card and the ledger CSV. `res` must be an
 * unfiltered read (holdings.list {}), so every held SKU has its exit; the totals are over everything either way. Per
 * row, the exit is holdingsTotals' (exitScrap, else revenueScrap); a row with neither is unpriced. keyScrap is
 * keyPrice.valueScrap when finite and > 0, else null; lockedItems is totals.locked ?? 0. Unrealised: nothing is booked.
 */
export function holdingsValuationOf(res: Pick<HoldingsResult, 'rows' | 'totals' | 'keyPrice' | 'generatedAt'>): HoldingsValuation {
  const rows = Array.isArray(res?.rows) ? res.rows : [];
  const exits: [string, Scrap | null][] = [];
  let unpricedItems = 0;
  let unpricedUnits = 0;
  for (const r of rows) {
    if (!r || typeof r.sku !== 'string') continue;
    const exit = rowExitOf(r);
    exits.push([r.sku, exit]);
    if (exit === null) {
      unpricedItems++;
      unpricedUnits += finite(r.qty) ? r.qty : 0;
    }
  }
  const kv = res?.keyPrice?.valueScrap;
  const t = res.totals;
  return {
    at: res.generatedAt,
    keyScrap: finite(kv) && kv > 0 ? kv : null,
    worthNowScrap: t.worthNowScrap,
    profitNowScrap: t.profitNowScrap,
    costScrap: t.costScrap,
    items: t.items,
    units: t.units,
    unpricedItems,
    unpricedUnits,
    lockedItems: finite(t.locked) ? t.locked : 0,
    exitBySku: Object.fromEntries(exits),
  };
}

/**
 * 0.9: one open lot at its SKU's exit as of `v`: worth = that exit; unrealised = holdingFigures(exit, qty 1, the lot's cost
 * at v.keyScrap (lotCostAt), p).profitNowScrap (friction only, as a sale into a live order, exactly as the row's
 * profitAllScrap: over a SKU's lots the unrealised sum to it). Both null without an exit or for a SKU not in `v`.
 */
export function lotValueOf(lot: Pick<JournalLot, 'costScrap' | 'keys' | 'scrap'>, sku: string, v: HoldingsValuation, p: CeilingSettings): JournalLotValue {
  const exit = v && v.exitBySku && Object.prototype.hasOwnProperty.call(v.exitBySku, sku) ? v.exitBySku[sku] : null;
  if (!finite(exit) || !lot) return { worthScrap: null, unrealisedScrap: null };
  const cost = lotCostAt(lot, v.keyScrap);
  const fig = holdingFigures({ revenueScrap: exit, qty: 1, costScrap: cost, nextLotCostScrap: cost }, p);
  return { worthScrap: exit, unrealisedScrap: fig.profitNowScrap };
}

/** 0.9: the ledger's valuer over `v` (journalLedger's second argument): each open lot valued by lotValueOf, dated v.at. */
export function journalValuerOf(v: HoldingsValuation, p: CeilingSettings): JournalLotValuer {
  return { at: v.at, valueOf: (lot, sku) => lotValueOf(lot, sku, v, p) };
}

export const HOLDINGS_CSV_COLUMNS: readonly string[] = [
  'sku',
  'name',
  'qty',
  'cost',
  'next_lot_cost',
  'held_since',
  'sells_for',
  'buyer',
  'profit_now',
  'profit_all',
  'status',
  'confidence',
  // F14: the better exit the profit and status are judged on, and the saved scrap.tf/items price.
  // Appended so earlier columns keep their place; sells_for stays the backpack.tf revenue.
  'exit',
  'exit_venue',
  'scraptf_pays',
  // 0.8 (H6, H2, H3): the advice kind, the next buyer's price and the lowest matching ask, appended as F14's were.
  'advice',
  'next_buyer',
  'lowest_ask',
];

/** One CSV line's cells, in HOLDINGS_CSV_COLUMNS order; money as keys + ref, missing values blank. */
export function holdingsCsvCells(r: HoldingRow, keyScrap: Scrap | null): (string | number | null)[] {
  const key = finite(keyScrap) && keyScrap > 0 ? keyScrap : null;
  const money = (v: Scrap | null): string => (finite(v) ? formatScrap(v, key) : '');
  const o = r.revenueOrder;
  return [
    r.sku,
    r.name,
    r.qty,
    money(r.costScrap),
    money(r.nextLotCostScrap),
    finite(r.heldSince) && r.heldSince > 0 ? new Date(r.heldSince).toISOString() : '',
    money(r.revenueScrap),
    o ? `${o.userName || o.steamid} (${o.isBot ? 'bot' : 'human'})` : '',
    money(r.profitNowScrap),
    money(r.profitAllScrap),
    r.status,
    r.confidence,
    money(r.exitScrap),
    r.exitVenue ?? '',
    money(r.scraptfPaysScrap),
    r.advice?.kind ?? '',
    money(r.nextBuyer?.valueScrap ?? null),
    money(r.ask?.lowestScrap ?? null),
  ];
}
