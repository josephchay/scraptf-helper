// Pure helpers for the Holdings page (F11): status pills, the header totals,
// cell text and tooltips, the Record sale prefill, the buyer's profile link and
// the live flash; and the better exit through scrap.tf's saved price list (F14).
// The figures themselves come from the service (or the mock) through the shared
// rules in src/shared/holdings.ts; nothing is recomputed here.

import { frictionOf } from '../shared/ceiling';
import { SCRAPTF_LIST_FRESH_MS, scraptfListFresh } from '../shared/scraptfList';
import { HOLDING_EXIT_VENUES } from '../shared/types';
import type { HoldingRow, HoldingStatus, HoldingsQuery, HoldingsResult, OrderSummary, ProfitSettings, Scrap, UnixMs } from '../shared/types';
import { DASH, fmtAge, fmtAgo, fmtDateTime, fmtInt, fmtMoney, fmtPct, fmtSignedMoney, type Tone } from './format';
import { SCRAPTF_SALE_NOTE, buyerProfileUrls, scraptfSaleInit } from './itemMenuModel';
import { splitAtKey, type RecordTradeInit } from './recordTradeModel';

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

// Judged on the better exit (F14): a backpack.tf buyer, or scrap.tf when your saved price list pays more.
export const HOLDING_STATUS_HELP: Readonly<Record<HoldingStatus, string>> = {
  sell: 'Selling the oldest unit at the better exit now (this buyer, or scrap.tf when your saved price list pays more) clears your profit thresholds.',
  hold: 'A sale now makes a profit, but less than your thresholds ask for.',
  loss: 'The best exit now (a backpack.tf buyer or scrap.tf) pays no more than the oldest unit cost you.',
  'no-buyers': 'No eligible backpack.tf buy order for this item in the live book, and no usable scrap.tf price from your saved list.',
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
  r: Pick<HoldingRow, 'status' | 'profitNowScrap' | 'profitAllScrap' | 'margin' | 'qty'> & Partial<Pick<HoldingRow, 'bestExit'>>,
  keyScrap: Scrap | null,
  p: Pick<ProfitSettings, 'frictionScrap'> | null,
): string {
  const help = HOLDING_STATUS_HELP[r.status];
  if (r.profitNowScrap === null) return help;
  const friction = p ? frictionOf(p) : 0;
  const to = r.bestExit === 'scraptf' ? ' to scrap.tf' : '';
  const parts = [`Selling the oldest unit${to} now: ${fmtSignedMoney(r.profitNowScrap, keyScrap)}${r.margin !== null ? ` (${fmtPct(r.margin)} margin)` : ''}${friction ? ` after ${fmtMoney(friction, keyScrap)} friction` : ''}.`];
  if (r.qty > 1 && r.profitAllScrap !== null) parts.push(`All ${fmtInt(r.qty)} units at this price: ${fmtSignedMoney(r.profitAllScrap, keyScrap)}.`);
  parts.push(help);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// The better exit (F14): a backpack.tf buyer, or scrap.tf by the saved price list
// ---------------------------------------------------------------------------

export type HoldingExitFields = Pick<HoldingRow, 'revenueScrap' | 'bestScrap' | 'instantScrap' | 'revenueOrder' | 'buyerCount'> &
  Partial<Pick<HoldingRow, 'bestExit' | 'exitScrap' | 'scraptfPaysScrap' | 'scraptfFull' | 'scraptfListAt'>>;

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

/** The "Sells now for" cell: the better exit, its venue, and what the other venue offers. */
export function holdingExitView(r: HoldingExitFields, keyScrap: Scrap | null, now: UnixMs): HoldingExitView {
  // A lapsed scrap.tf exit reads as the day-old list it now is (below) until the refetch lands.
  const lapsed = scraptfExitLapsed(r, now);
  const scraptf = r.bestExit === 'scraptf' && !lapsed;
  const priceScrap = !lapsed && finiteScrap(r.exitScrap) ? r.exitScrap : r.revenueScrap;
  const listAt = finiteScrap(r.scraptfListAt) ? r.scraptfListAt : null;
  const saved = listAt !== null ? `price list saved ${fmtAgo(listAt, now)}` : null;
  if (scraptf) {
    const bp = r.revenueScrap !== null ? `The best backpack.tf buyer pays ${fmtMoney(r.revenueScrap, keyScrap)}.` : 'No backpack.tf buyer right now.';
    return {
      priceScrap,
      scraptf,
      sub: { text: r.revenueScrap !== null ? `backpack.tf pays ${fmtMoney(r.revenueScrap, keyScrap)}` : 'no backpack.tf buyer', tone: 'muted' },
      title: `Sells now for ${fmtMoney(priceScrap, keyScrap)} to scrap.tf's bank (your ${saved ?? 'saved price list'}). ${bp} scrap.tf pays more, so status and profit use it; its stock may have changed since the save.`,
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
export function holdingStatusTitle(r: Pick<HoldingRow, 'status'> & Partial<Pick<HoldingRow, 'bestExit'>>): string {
  return r.status === 'sell' && r.bestExit === 'scraptf' ? `Sell now (scrap.tf). ${HOLDING_STATUS_HELP.sell}` : HOLDING_STATUS_HELP[r.status];
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
