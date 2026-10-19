// Holdings (F11) rules shared by the service's holdings module, the browser mock
// and the dashboard, so all three give a held item the same figures, status,
// order, totals and CSV cells (as market.ts does for the Live market). Pure: no
// I/O, no network. The buy side comes from the local backpack.tf book only.

import { formatScrap, valueScrap } from './currency';
import { frictionOf, profitStatus, type CeilingSettings } from './ceiling';
import { marketSearchTokens } from './market';
import { bestExitOf, holdingListFields } from './scraptfList';
import { HOLDING_STATUSES } from './types';
import type {
  Category,
  ConfidenceLevel,
  HoldingRow,
  HoldingStatus,
  HoldingsQuery,
  HoldingsResult,
  JournalLot,
  JournalPosition,
  KeyPriceState,
  OpportunityStatus,
  OrderSummary,
  Scrap,
  ScraptfListRow,
  UnixMs,
} from './types';

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
}

/**
 * Profit if the next lot (FIFO) sold now, profit if every unit did, and the status, judged on the
 * next lot exactly as an opportunity is judged on its cost (profitStatus with settings.profit).
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
 * One row from an open journal position (journalSummary().open) and its buy side; `buy` null means
 * no eligible buy order. Lots are valued at `keyScrap`, today's key price (lotCostAt). A painted copy
 * is priced against its clean base, so it is flagged has-extras like a painted price on the Live market.
 * `scraptf` (F14) is the base SKU's saved scrap.tf/items row (valued at `keyScrap`) and the time it is
 * judged at: the better exit (bestExitOf) sets exitScrap, and status and profit are judged on it.
 * Omitted, backpack.tf is the only exit and the row is exactly as before F14.
 */
export function holdingRow(
  pos: JournalPosition,
  category: Category,
  buy: HoldingBuySide | null,
  p: CeilingSettings,
  keyScrap: Scrap | null = null,
  scraptf: { list: ScraptfListRow | null; now: UnixMs } | null = null,
): HoldingRow {
  const lots = Array.isArray(pos.lots) ? pos.lots : [];
  const qty = pos.qty;
  const next = lots[0];
  const costs = lots.map((l) => lotCostAt(l, keyScrap));
  // qty === lots.length for every position journalSummary builds; anything else keeps the stored total.
  const costScrap = lots.length > 0 && lots.length === qty ? costs.reduce((t, c) => t + c, 0) : pos.costScrap;
  const nextLotCostScrap = next ? costs[0]! : qty > 0 ? Math.round(pos.costScrap / qty) : pos.costScrap;
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
    heldSince: next?.ts ?? 0,
    revenueScrap,
    bestScrap: buy?.bestScrap ?? null,
    instantScrap: buy?.instantScrap ?? null,
    revenueOrder: buy?.revenueOrder ?? null,
    bestOrder: buy?.bestOrder ?? null,
    buyerCount: buy?.buyerCount ?? 0,
    ...holdingListFields(list),
    ...exit,
    // Judged on the better exit, so a holding can be 'sell' through scrap.tf (F14).
    ...holdingFigures({ revenueScrap: exit.exitScrap, qty, costScrap, nextLotCostScrap }, p),
    confidence: buy?.confidence ?? 0,
    confidenceLevel: buy?.confidenceLevel ?? 'low',
    flags,
    lastOrderChangeAt: buy?.lastOrderChangeAt ?? null,
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

/** See HoldingsResult.totals: rows without an exit add to items, units and cost only. */
export function holdingsTotals(rows: readonly HoldingRow[]): HoldingsResult['totals'] {
  const t = { items: 0, units: 0, costScrap: 0, worthNowScrap: 0, profitNowScrap: 0, sellable: 0 };
  for (const r of rows) {
    t.items++;
    t.units += r.qty;
    t.costScrap += r.costScrap;
    // Worth at the better exit (F14); exitScrap is the revenue when backpack.tf is the only one.
    const exit = finite(r.exitScrap) ? r.exitScrap : r.revenueScrap;
    if (finite(exit)) t.worthNowScrap += exit * r.qty;
    if (finite(r.profitAllScrap)) t.profitNowScrap += r.profitAllScrap;
    if (r.status === 'sell') t.sellable++;
  }
  return t;
}

/** 'holdings.list': the matching rows in order, totals over every row. */
export function holdingsResult(rows: readonly HoldingRow[], q: HoldingsQuery, keyPrice: KeyPriceState | null, now: UnixMs): HoldingsResult {
  return { rows: holdingsMatching(rows, q), totals: holdingsTotals(rows), keyPrice, generatedAt: now };
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
  ];
}
