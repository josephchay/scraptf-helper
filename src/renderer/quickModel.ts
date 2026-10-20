// Pure helpers for the quick-entry window's live preview (feature F2), its
// prefill (F8, with price text from the live check popup, F16) and "Bought it"
// (F12). Kept out of QuickEntry.tsx so the rules are unit-tested.

import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { frictionOf, maxCostFor, type CeilingSettings } from '../shared/ceiling';
import { CHECK_PRICE_TEXT_MAX } from '../shared/check';
import { parsePrice } from '../shared/currency';
import { SCRAPTF_LIST_PRICE_NOTE, scraptfListFresh, scraptfListUsePrice } from '../shared/scraptfList';
import { baseSku, fromObject, fromString } from '../shared/sku';
import type {
  ItemDetail,
  ItemRevenue,
  JournalEntry,
  JournalInput,
  LinkSpec,
  OpportunityStatus,
  OrderSummary,
  ProfitSettings,
  Scrap,
  ScrapPrice,
  ScraptfListRow,
  UnixMs,
} from '../shared/types';
import { fmtAgo, fmtDateTime, fmtInt, fmtKeysMetal, fmtMoney } from './format';
import { statusFor } from './oppModel';

/** Quiet time after a pick before 'item.detail' runs, so arrowing through picks does not fire a request each. */
export const PREVIEW_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Stale-response guard
// ---------------------------------------------------------------------------

export interface LatestGate {
  /** Starts a request; the returned ticket is current until the next call or cancel(). */
  next(): number;
  isCurrent(ticket: number): boolean;
  /** Makes every outstanding ticket stale (item cleared, window reset). */
  cancel(): void;
}

/** Only the newest request may land: a slow answer for an earlier pick must not overwrite a later one. */
export function createLatestGate(): LatestGate {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (ticket) => ticket === current,
    cancel: () => {
      current++;
    },
  };
}

// ---------------------------------------------------------------------------
// Revenue and profit preview
// ---------------------------------------------------------------------------

export type PreviewSettings = CeilingSettings & Pick<ProfitSettings, 'useOrder'>;

function topBy(orders: readonly OrderSummary[], keep: (o: OrderSummary) => boolean): OrderSummary | null {
  let best: OrderSummary | null = null;
  for (const o of orders) if (keep(o) && (best === null || o.valueScrap > best.valueScrap)) best = o;
  return best;
}

/**
 * The revenue the preview prices against: the service's own (detail.revenue)
 * when it sent one. Otherwise the same picks the engine makes, read from the
 * book the service already classified (eligible, outlier flag): best is the top
 * eligible order, conservative the top non-outlier, instant the top non-outlier bot.
 */
export function previewRevenue(d: Pick<ItemDetail, 'revenue' | 'buyOrders'>, p: PreviewSettings): ItemRevenue {
  if (d.revenue) return d.revenue;
  const eligible = d.buyOrders.filter((o) => o.eligible);
  const best = topBy(eligible, () => true);
  const cons = topBy(eligible, (o) => !o.flags.includes('outlier'));
  const instant = topBy(eligible, (o) => o.isBot && !o.flags.includes('outlier'));
  const order = p.useOrder === 'best' ? best : p.useOrder === 'instant' ? instant : cons;
  const revenueScrap = order?.valueScrap ?? null;
  return {
    bestScrap: best?.valueScrap ?? null,
    consScrap: cons?.valueScrap ?? null,
    instantScrap: instant?.valueScrap ?? null,
    useOrder: p.useOrder,
    revenueScrap,
    order,
    maxCostScrap: maxCostFor(revenueScrap, p),
    eligibleCount: eligible.length,
  };
}

export interface ProfitPreview {
  costScrap: Scrap;
  /** revenue − cost − friction, as the engine computes it; null without revenue. */
  profitScrap: Scrap | null;
  /** profit / cost; null without revenue or for a free item (as the engine stores it). */
  margin: number | null;
  status: OpportunityStatus;
  /** cost ≤ Pay up to. False when there is revenue but no price clears the thresholds; null without revenue. */
  underCeiling: boolean | null;
  /** Pay up to − cost (negative when over); null without a ceiling. */
  headroomScrap: Scrap | null;
}

/** Live profit for a typed cost, computed locally with the engine's rules (friction, profitStatus). */
export function profitPreview(costScrap: Scrap, rev: Pick<ItemRevenue, 'revenueScrap' | 'maxCostScrap'> | null, p: CeilingSettings): ProfitPreview {
  const revenue = rev?.revenueScrap ?? null;
  const ceiling = rev?.maxCostScrap ?? null;
  const profitScrap = revenue === null ? null : revenue - costScrap - frictionOf(p);
  return {
    costScrap,
    profitScrap,
    margin: profitScrap === null || costScrap <= 0 ? null : profitScrap / costScrap,
    status: statusFor(profitScrap, costScrap, p),
    underCeiling: ceiling !== null ? costScrap <= ceiling : revenue === null ? null : false,
    headroomScrap: ceiling === null ? null : ceiling - costScrap,
  };
}

export type PreviewTone = 'good' | 'warn' | 'bad' | 'muted';

/** Green only when the price is at or under Pay up to (the spec's "mark it green"). */
export function previewTone(pv: Pick<ProfitPreview, 'status' | 'underCeiling'>): PreviewTone {
  if (pv.underCeiling === true) return 'good';
  if (pv.status === 'unprofitable') return 'bad';
  if (pv.status === 'no-buyers') return 'muted';
  return 'warn';
}

/**
 * Short comparison with the ceiling, e.g. "0.22 ref under" or "1 key over". `buyerCount` is the
 * eligible orders: without revenue but with some (0.7.3), none of them is usable, not absent.
 */
export function ceilingVerdict(pv: Pick<ProfitPreview, 'underCeiling' | 'headroomScrap'>, keyScrap: Scrap | null, buyerCount = 0): string {
  if (pv.underCeiling === null) return buyerCount > 0 ? 'No usable buyer' : 'No buyer';
  if (pv.headroomScrap === null) return 'No price clears your thresholds';
  if (pv.headroomScrap === 0) return 'At the ceiling';
  const amount = fmtMoney(Math.abs(pv.headroomScrap), keyScrap);
  return pv.underCeiling ? `${amount} under` : `${amount} over`;
}

export function buyerCountLabel(n: number): string {
  return n === 1 ? '1 buyer' : `${n} buyers`;
}

/**
 * Why a revenue is null (0.7.3): no eligible order at all, or eligible orders none of which the
 * useOrder pick can use. Conservative is null only when every one is an outlier (the engine's
 * 'all-outliers'); Instant when none is a realistic bot order; Best never is with orders.
 */
export function noRevenueText(rev: Pick<ItemRevenue, 'eligibleCount' | 'useOrder'> | null): string {
  const n = rev?.eligibleCount ?? 0;
  if (!rev || !(n > 0)) return 'No eligible backpack.tf buyer right now';
  if (rev.useOrder === 'instant') return `${buyerCountLabel(n)}, but none is a realistic bot order, and Revenue used for profit is Instant (bot orders only)`;
  return `${buyerCountLabel(n)}, but every eligible order looks unrealistically high`;
}

/**
 * 0.7.3: noRevenueText for a row that carries the engine's flags instead of useOrder (an opportunity):
 * with buyers but no revenue, 'all-outliers' is the Conservative case, and its absence is Instant
 * without a realistic bot order (as holdingsModel's noSaleReason reads a holding).
 */
export function noRevenueTextOf(r: { buyerCount: number; flags: readonly string[] }): string {
  const n = r.buyerCount;
  if (!(n > 0)) return noRevenueText(null);
  return noRevenueText({ eligibleCount: n, useOrder: r.flags.includes('all-outliers') ? 'conservative' : 'instant' });
}

/** Hover text for "Sells for": all three revenue picks, so the one Settings uses can be compared. */
export function revenueBreakdown(rev: Pick<ItemRevenue, 'bestScrap' | 'consScrap' | 'instantScrap'>, keyScrap: Scrap | null): string {
  return `Best ${fmtMoney(rev.bestScrap, keyScrap)} · conservative ${fmtMoney(rev.consScrap, keyScrap)} · instant ${fmtMoney(rev.instantScrap, keyScrap)}`;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface CompactLink {
  link: LinkSpec;
  /** Short label for the one-line row; the full label goes in the tooltip. */
  short: string;
}

/** The links the user reaches for while checking a price, in row order. Alternatives share a slot. */
const COMPACT_LINK_SLOTS: readonly { ids: readonly string[]; short: string }[] = [
  { ids: ['bptf-stats'], short: 'Stats' },
  { ids: ['bptf-classifieds-accurate', 'bptf-classifieds'], short: 'Classifieds' },
  { ids: ['scraptf-page'], short: 'scrap.tf page' },
  { ids: ['mptf'], short: 'mp.tf' },
  { ids: ['stn'], short: 'STN' },
  { ids: ['scm'], short: 'SCM' },
  { ids: ['pricedb'], short: 'PriceDB' },
];

/** At most `max` links from detail.links for the quick window's link row; the drawer has the full menu. */
export function compactLinks(links: readonly LinkSpec[], max = 6): CompactLink[] {
  const byId = new Map(links.map((l) => [l.id, l] as const));
  const out: CompactLink[] = [];
  for (const slot of COMPACT_LINK_SLOTS) {
    if (out.length >= max) break;
    const link = slot.ids.map((id) => byId.get(id)).find((l) => l !== undefined);
    if (link) out.push({ link, short: slot.short });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keys and the "checked" marker
// ---------------------------------------------------------------------------

/** Shift+Enter is "Check only" anywhere in the form; plain Enter keeps saving. */
export function isCheckKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.isComposing !== true;
}

export interface CheckedEntry {
  sku: string;
  text: string;
  unit: string;
}

/** A "Check only" result stays shown only while the item and the price text are unchanged. */
export function isChecked(checked: CheckedEntry | null, now: { sku: string | null; text: string; unit: string }): boolean {
  return checked !== null && checked.sku === now.sku && checked.text === now.text && checked.unit === now.unit;
}

// ---------------------------------------------------------------------------
// "Bought it" (F12): one click after Save records the buy in the journal
// ---------------------------------------------------------------------------

/** Where the flip loop buys: a quick-entry price is a scrap.tf price. */
export const BUY_VENUE = 'scrap.tf';

/**
 * The SKU of the item the user saved. prices.upsert stores the base SKU and moves paint into the
 * extras, so the paint goes back on: Holdings then flags the painted copy ('has-extras').
 */
export function savedItemSku(price: Pick<ScrapPrice, 'sku'> & { special?: ScrapPrice['special'] }): string {
  const paint = price.special?.paint;
  return typeof paint === 'number' && Number.isInteger(paint) && paint > 0 ? fromObject({ ...fromString(price.sku), paint }) : price.sku;
}

/** The journal row "Bought it" writes: a buy on scrap.tf at the price just saved, keys and metal as typed. */
export function boughtItInput(price: Pick<ScrapPrice, 'sku' | 'name' | 'costKeys' | 'costScrap'> & { special?: ScrapPrice['special'] }): JournalInput {
  return { side: 'buy', venue: BUY_VENUE, sku: savedItemSku(price), name: price.name, keys: price.costKeys, scrap: price.costScrap };
}

/**
 * The saved price as it is stored now. An edit in the drawer or on the Prices page updates the row
 * in place (same id), so the card and "Bought it" must take its current cost from a fresh read, not
 * the copy prices.upsert returned. A row deleted since (often right after buying) keeps the last
 * known copy, so the buy can still be recorded.
 */
export function freshSavedPrice(price: ScrapPrice, detail: Pick<ItemDetail, 'scrapPrices'> | null | undefined): ScrapPrice {
  const rows = detail && Array.isArray(detail.scrapPrices) ? detail.scrapPrices : [];
  return rows.find((p) => p.id === price.id) ?? price;
}

/** The confirmation toast (it carries Undo). */
export function boughtItText(entry: Pick<JournalEntry, 'name' | 'sku' | 'keys' | 'scrap'>): string {
  return `Recorded a buy of ${entry.name.trim() || entry.sku} at ${fmtKeysMetal(entry.keys, entry.scrap)} in your journal.`;
}

/** The button for one saved price: idle, recording, or recorded (entryId is the journal row, for Undo). */
export type BoughtState = { priceId: number; status: 'saving' } | { priceId: number; status: 'done'; entryId: number };

export function boughtButton(state: BoughtState | null, priceId: number): { label: string; disabled: boolean; done: boolean } {
  const s = state && state.priceId === priceId ? state : null;
  if (s?.status === 'saving') return { label: 'Recording…', disabled: true, done: false };
  // Recorded once per save: a second click would add a second unit to Holdings.
  if (s?.status === 'done') return { label: 'Recorded', disabled: true, done: true };
  return { label: 'Bought it', disabled: false, done: false };
}

/** After Undo removed the row: back to idle, unless the button has moved on (another save, another record). */
export function afterBoughtUndo(state: BoughtState | null, entryId: number): BoughtState | null {
  return state?.status === 'done' && state.entryId === entryId ? null : state;
}

// ---------------------------------------------------------------------------
// scrap.tf price list (F14): the hint under the preview and its Use button
// ---------------------------------------------------------------------------

/** The note on a price taken from the saved list (quick entry's Use, the drawer's "Use as my price"). */
export const LIST_PRICE_NOTE = SCRAPTF_LIST_PRICE_NOTE;
/** The note when Use put the list's (unpainted) price on another copy, such as a painted one. */
export const LIST_PRICE_NOTE_PLAIN = 'from scrap.tf list (plain copy)';

function finiteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * scrap.tf's "Price to buy" as the list shows it ("1 key 5.11 ref"), written with units so the price
 * field reads it whatever its bare-number unit is. null for a sold-out row (no price shown) or a zero price.
 */
export function listSellsText(row: Pick<ScraptfListRow, 'sellsKeys' | 'sellsScrapRaw'> | null | undefined): string | null {
  if (!row || !finiteNum(row.sellsScrapRaw)) return null;
  const keys = finiteNum(row.sellsKeys) && row.sellsKeys > 0 ? row.sellsKeys : 0;
  const scrap = Math.max(0, Math.round(row.sellsScrapRaw));
  if (keys === 0 && scrap === 0) return null;
  return fmtKeysMetal(keys, scrap);
}

/**
 * The list prices a plain copy (rows are keyed by the base SKU, paint dropped): true when `sku` names
 * another copy of that item (a painted one), so its price is not the list's.
 */
export function listRowIsOtherCopy(row: Pick<ScraptfListRow, 'sku'>, sku: string): boolean {
  const s = sku.trim().toLowerCase();
  try {
    return baseSku(s) !== fromObject(fromString(s)) || baseSku(s) !== row.sku.trim().toLowerCase();
  } catch {
    return s !== row.sku.trim().toLowerCase();
  }
}

export interface QuickListHint {
  /** "sells 1.33 ref · stock 2, saved 3 min ago" (the "scrap.tf list" label is the line's own). */
  text: string;
  title: string;
  /** What Use writes into the price field; null when there is nothing to buy (sold out, or stock 0). */
  price: string | null;
  /** 'warn' once the saved row is older than a day: check scrap.tf before trusting it. */
  tone: 'muted' | 'warn';
  observedAt: UnixMs;
  /** The picked SKU is another copy (painted) than the plain one the list prices. */
  otherCopy: boolean;
}

/** Quick entry's line for the picked item's row of the saved scrap.tf/items list; null without one. */
export function quickListHint(row: ScraptfListRow | null | undefined, pickedSku: string, now: UnixMs): QuickListHint | null {
  if (!row || !finiteNum(row.observedAt)) return null;
  const sells = listSellsText(row);
  // A priced row with stock 0 cannot be bought either; the import refuses it as a price (scraptfListUsePrice).
  const outOfStock = sells !== null && scraptfListUsePrice(row) === null;
  const price = outOfStock ? null : sells;
  const stock = finiteNum(row.stock) ? ` · stock ${fmtInt(row.stock)}` : '';
  const otherCopy = listRowIsOtherCopy(row, pickedSku);
  const copy = otherCopy ? ' (plain copy)' : '';
  const fresh = scraptfListFresh(row, now);
  const saved = `saved ${fmtAgo(row.observedAt, now)}`;
  const text = `${sells ? `sells ${sells}` : 'sold out'}${copy}${stock}, ${saved}`;
  const title = [
    `scrap.tf's price list as you saved it ${fmtDateTime(row.observedAt)}.`,
    otherCopy ? 'It prices the plain copy of this item, not this one.' : '',
    price
      ? `Use puts ${price} in the price field; Enter saves it with the list's date.`
      : outOfStock
        ? 'Out of stock on scrap.tf (stock 0 when you saved the list), so there is nothing to buy at this price.'
        : 'It shows no price to buy (sold out), so there is nothing to use.',
    fresh ? 'Stock may have changed since.' : 'Older than a day: check scrap.tf, or save scrap.tf/items again.',
    SCRAPTF_BOUNDARY_SHORT,
  ]
    .filter(Boolean)
    .join(' ');
  return { text, title, price, tone: fresh ? 'muted' : 'warn', observedAt: row.observedAt, otherCopy };
}

// ---------------------------------------------------------------------------
// Live check (F16): 'ui.quickPrefill' may carry price text (the check popup's Quick entry…)
// ---------------------------------------------------------------------------

/**
 * The price text a prefill puts in the price field, or '' to leave it empty. Main already checks it
 * (ipc.ts: at most CHECK_PRICE_TEXT_MAX characters, no control characters, no markup); checked again
 * here, and only a price the field can read is used, so nothing odd ever lands in it.
 */
export function prefillPriceText(price: unknown): string {
  if (typeof price !== 'string') return '';
  const t = price.trim();
  if (!t || t.length > CHECK_PRICE_TEXT_MAX || /[\u0000-\u001f\u007f<>]/.test(t)) return '';
  return parsePrice(t, 'ref') ? t : '';
}

/** A list price put into the price field by Use: for this item, this exact text, seen when the list was saved. */
export interface ListPriceUse {
  sku: string;
  text: string;
  observedAt: UnixMs;
  /** Put on another copy than the plain one the list prices (QuickListHint.otherCopy). */
  otherCopy?: boolean;
}

/**
 * The date and note a quick-entry save carries. A price still exactly as Use put it keeps the list's
 * date (it was seen then, not now; an old list then reads stale, as it should) and, without a note of
 * the user's own, LIST_PRICE_NOTE (LIST_PRICE_NOTE_PLAIN when it was the plain copy's price put on a
 * painted one, so the sheet does not pass it off as that copy's own). Anything typed over it is a price seen now.
 */
export function listPriceStamp(use: ListPriceUse | null, entry: { sku: string; text: string }, note: string, now: UnixMs): { observedAt: UnixMs; note: string | null } {
  const typed = note.trim();
  if (use && use.sku === entry.sku && use.text.trim() === entry.text.trim() && finiteNum(use.observedAt)) {
    return { observedAt: Math.min(use.observedAt, now), note: typed || (use.otherCopy ? LIST_PRICE_NOTE_PLAIN : LIST_PRICE_NOTE) };
  }
  return { observedAt: now, note: typed || null };
}
