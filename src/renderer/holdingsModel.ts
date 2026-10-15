// Pure helpers for the Holdings page (F11): status pills, the header totals,
// cell text and tooltips, the Record sale prefill, the buyer's profile link and
// the live flash. The figures themselves come from the service (or the mock)
// through the shared rules in src/shared/holdings.ts; nothing is recomputed here.

import { frictionOf } from '../shared/ceiling';
import type { HoldingRow, HoldingStatus, HoldingsQuery, HoldingsResult, OrderSummary, ProfitSettings, Scrap, UnixMs } from '../shared/types';
import { DASH, fmtAge, fmtDateTime, fmtInt, fmtMoney, fmtPct, fmtSignedMoney, type Tone } from './format';
import { buyerProfileUrls } from './itemMenuModel';
import type { RecordTradeInit } from './recordTradeModel';

/** Same cap as 'holdings.list' (zod: search ≤ 200). */
export const HOLDINGS_MAX_SEARCH_CHARS = 200;

export const HOLDING_STATUS_LABELS: Readonly<Record<HoldingStatus, string>> = {
  sell: 'Sell now',
  hold: 'Hold',
  loss: 'Loss',
  'no-buyers': 'No buyers',
};

export const HOLDING_STATUS_TONES: Readonly<Record<HoldingStatus, Tone>> = {
  sell: 'good',
  hold: 'warn',
  loss: 'bad',
  'no-buyers': 'muted',
};

export const HOLDING_STATUS_HELP: Readonly<Record<HoldingStatus, string>> = {
  sell: 'Selling the oldest unit to this buyer now clears your profit thresholds.',
  hold: 'A sale now makes a profit, but less than your thresholds ask for.',
  loss: 'The best buyer now pays no more than the oldest unit cost you.',
  'no-buyers': 'No eligible backpack.tf buy order for this item in the live book.',
};

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
  return `What today's buyers pay for every unit that has one: ${fmtMoney(t.worthNowScrap, keyScrap)}, against ${fmtMoney(t.costScrap, keyScrap)} you paid for everything held. Items with no buyer count at nothing.`;
}

export function plTitle(t: Pick<HoldingsResult['totals'], 'profitNowScrap'>, keyScrap: Scrap | null, p: Pick<ProfitSettings, 'frictionScrap'> | null): string {
  const friction = p ? frictionOf(p) : 0;
  return `Unrealised profit or loss if every unit with a buyer sold now: ${fmtSignedMoney(t.profitNowScrap, keyScrap)}${friction ? `, after ${fmtMoney(friction, keyScrap)} friction per unit` : ''}. Items with no buyer are left out.`;
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

export function heldForTitle(r: Pick<HoldingRow, 'heldSince'>): string | undefined {
  return r.heldSince > 0 ? `Oldest unit bought ${fmtDateTime(r.heldSince)}` : undefined;
}

export function buyerName(o: Pick<OrderSummary, 'userName' | 'steamid' | 'isBot'>): string {
  return o.userName || (o.isBot ? 'Bot' : 'Human');
}

/** Tooltip for "Sells now for": the buyer you would sell to, and the other picks. */
export function holdingSellsForTitle(r: Pick<HoldingRow, 'revenueScrap' | 'bestScrap' | 'instantScrap' | 'revenueOrder' | 'buyerCount'>, keyScrap: Scrap | null): string {
  if (r.revenueScrap === null) return r.buyerCount > 0 ? 'Every eligible order looks unrealistic, so no sale price is assumed.' : 'No eligible backpack.tf buy orders in the live book.';
  const o = r.revenueOrder;
  const online = o ? (o.online === true ? 'online' : o.online === false ? 'offline' : 'online status unknown') : null;
  const who = o ? ` to ${o.userName || o.steamid} (${o.isBot ? 'bot' : 'human'}, ${online})` : '';
  const buyers = `${fmtInt(r.buyerCount)} ${r.buyerCount === 1 ? 'buyer' : 'buyers'} with eligible orders.`;
  return `Sells now for ${fmtMoney(r.revenueScrap, keyScrap)}${who}. Best ${fmtMoney(r.bestScrap, keyScrap)}, instant ${fmtMoney(r.instantScrap, keyScrap)}. ${buyers}`;
}

/** Tooltip for "Profit now": the next unit, every unit, the margin, and what the status means. */
export function profitNowTitle(
  r: Pick<HoldingRow, 'status' | 'profitNowScrap' | 'profitAllScrap' | 'margin' | 'qty'>,
  keyScrap: Scrap | null,
  p: Pick<ProfitSettings, 'frictionScrap'> | null,
): string {
  const help = HOLDING_STATUS_HELP[r.status];
  if (r.profitNowScrap === null) return help;
  const friction = p ? frictionOf(p) : 0;
  const parts = [`Selling the oldest unit now: ${fmtSignedMoney(r.profitNowScrap, keyScrap)}${r.margin !== null ? ` (${fmtPct(r.margin)} margin)` : ''}${friction ? ` after ${fmtMoney(friction, keyScrap)} friction` : ''}.`];
  if (r.qty > 1 && r.profitAllScrap !== null) parts.push(`All ${fmtInt(r.qty)} units at this price: ${fmtSignedMoney(r.profitAllScrap, keyScrap)}.`);
  parts.push(help);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Record sale… prefilled for the buyer you would sell to: venue backpack.tf, that order's own
 * keys + metal and "Sold to <buyer>". Without a buyer only the item and venue are filled.
 */
export function recordSaleInit(r: Pick<HoldingRow, 'sku' | 'name' | 'revenueOrder'>): RecordTradeInit {
  const o = r.revenueOrder;
  const base: RecordTradeInit = { side: 'sell', sku: r.sku, name: r.name, venue: 'backpack.tf' };
  if (!o) return base;
  return { ...base, keys: o.keys, scrap: o.metalScrap, note: `Sold to ${o.userName || o.steamid}` };
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
