// Pure rules for the Record trade dialog (F12): its prefill, its checks, the
// journal row it writes, and the live comparison (a buy against the item's Pay
// up to, a sale against the next FIFO lot). Kept out of RecordTradeDialog.tsx so
// they are unit-tested. Nothing here writes or fetches; the dialog only ever
// writes the user's own journal (R4).

import { frictionOf, profitStatus, type CeilingSettings } from '../shared/ceiling';
import { formatKeysMetal, parsePrice } from '../shared/currency';
import { holdingStatusOf } from '../shared/holdings';
import type { HoldingRow, HoldingStatus, ItemDetail, JournalEntry, JournalInput, JournalSide, OrderSummary, Scrap, UnixMs } from '../shared/types';
import type { BareUnit } from './components/PriceInput';
import { fmtAge, fmtMoney, fmtSignedMoney, fromDateTimeLocal, toDateTimeLocal } from './format';
import { ceilingVerdict, previewRevenue, profitPreview, type PreviewSettings, type ProfitPreview } from './quickModel';

/** What the dialog opens with; every field but side, sku and name is a prefill the user can change. */
export interface RecordTradeInit {
  side: JournalSide;
  sku: string;
  name: string;
  /** e.g. 'scrap.tf' for a buy, 'backpack.tf' for a sale. */
  venue?: string;
  keys?: number;
  /** Metal part of the price, in scrap (keys are separate, as in PriceInput). */
  scrap?: Scrap;
  note?: string;
}

/** The venue field's suggestions (a datalist: anything else can be typed). */
export const VENUE_SUGGESTIONS: readonly string[] = ['scrap.tf', 'backpack.tf', 'marketplace.tf', 'Steam', 'other'];
/** journal.add's own caps (rpcHandlers.ts journalInput). */
export const MAX_VENUE_CHARS = 100;
export const MAX_NOTE_CHARS = 500;
/** A trade dated further ahead than this is a typo (wrong day or AM/PM), not a clock skew. */
export const FUTURE_SLACK_MS = 5 * 60_000;

export interface TradeForm {
  side: JournalSide;
  venue: string;
  /** Price text as typed (PriceInput grammar), read with `unit` for bare numbers. */
  text: string;
  unit: BareUnit;
  /** <input type="datetime-local"> value, local time. */
  when: string;
  note: string;
}

export function defaultVenue(side: JournalSide): string {
  return side === 'buy' ? 'scrap.tf' : 'backpack.tf';
}

function amount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** The prefilled price as the user would type it ("1 key 5.11 ref"), or '' without one. */
export function initialPriceText(init: Pick<RecordTradeInit, 'keys' | 'scrap'>): string {
  const keys = amount(init.keys);
  const scrap = Math.round(amount(init.scrap));
  if (keys === 0 && scrap === 0) return '';
  return formatKeysMetal(keys, scrap);
}

export function initialTradeForm(init: RecordTradeInit, now: UnixMs): TradeForm {
  return {
    side: init.side === 'sell' ? 'sell' : 'buy',
    venue: (init.venue ?? '').trim().slice(0, MAX_VENUE_CHARS) || defaultVenue(init.side),
    text: initialPriceText(init),
    // The prefill is written with units, so the toggle only matters for what the user types.
    unit: 'ref',
    when: toDateTimeLocal(now),
    note: (init.note ?? '').trim().slice(0, MAX_NOTE_CHARS),
  };
}

/** The Journal form's rule: switching side moves the default venue along, never one the user typed. */
export function venueForSide(venue: string, side: JournalSide): string {
  if (side === 'sell' && venue.trim() === 'scrap.tf') return 'backpack.tf';
  if (side === 'buy' && venue.trim() === 'backpack.tf') return 'scrap.tf';
  return venue;
}

export type TradeField = 'price' | 'venue' | 'when';
export type TradeCheck = { ok: true; input: JournalInput } | { ok: false; field: TradeField; error: string };

/** The 'journal.add' params for this form, or the first thing to fix. */
export function checkTrade(form: TradeForm, item: { sku: string; name: string }, now: UnixMs): TradeCheck {
  const text = form.text.trim();
  const parsed = text ? parsePrice(text, form.unit) : null;
  if (!parsed) {
    return { ok: false, field: 'price', error: text ? "Can't read that price. Try 1.33, 14 scrap, 2 keys or 2k 5.11." : 'Enter the price, for example 1.33 or 2 keys 5.11.' };
  }
  const venue = form.venue.trim();
  if (!venue) return { ok: false, field: 'venue', error: 'Enter where the trade happened, for example scrap.tf.' };
  if (venue.length > MAX_VENUE_CHARS) return { ok: false, field: 'venue', error: `Keep the venue under ${MAX_VENUE_CHARS} characters.` };
  const ts = form.when.trim() ? fromDateTimeLocal(form.when) : now;
  if (ts === null) return { ok: false, field: 'when', error: 'Enter a valid date and time.' };
  if (ts > now + FUTURE_SLACK_MS) return { ok: false, field: 'when', error: 'That date is in the future.' };
  const note = form.note.trim().slice(0, MAX_NOTE_CHARS);
  return {
    ok: true,
    input: { side: form.side, venue, sku: item.sku, name: item.name, keys: parsed.keys, scrap: parsed.scrap, ts, note: note || null },
  };
}

/** Why the typed price has no value yet: nothing typed, unreadable, or keys before a key price is known. */
export type TypedPriceState = 'empty' | 'unreadable' | 'no-key-price' | 'ok';

/** The typed price's total value in scrap, and why there is none. */
export function typedPrice(form: Pick<TradeForm, 'text' | 'unit'>, keyScrap: Scrap | null): { value: Scrap | null; state: TypedPriceState } {
  const text = form.text.trim();
  if (!text) return { value: null, state: 'empty' };
  const p = parsePrice(text, form.unit);
  if (!p) return { value: null, state: 'unreadable' };
  if (p.keys && !(keyScrap && keyScrap > 0)) return { value: null, state: 'no-key-price' };
  return { value: Math.round(p.keys * (keyScrap ?? 0)) + p.scrap, state: 'ok' };
}

/** Whether the typed price parses, and its total value; null when empty, unreadable, or keys without a key price. */
export function typedValueScrap(form: Pick<TradeForm, 'text' | 'unit'>, keyScrap: Scrap | null): Scrap | null {
  return typedPrice(form, keyScrap).value;
}

/**
 * The comparison's text while the typed price has no value. "Type the price" would be wrong for a
 * price that was typed: one in keys can be saved before a key price arrives, it just can't be compared.
 */
function waitingText(state: TypedPriceState, empty: string): string {
  if (state === 'unreadable') return "Can't read that price yet, so there is nothing to compare.";
  if (state === 'no-key-price') return "No key price yet, so a price in keys can't be compared. It still saves as typed.";
  return empty;
}

/** item.detail for the buy comparison: local only (no PriceDB history), valued as a clean copy of this SKU. */
export function detailParams(sku: string): { sku: string; history: false; target: 'plain' } {
  return { sku, history: false, target: 'plain' };
}

// ---------------------------------------------------------------------------
// Live comparison
// ---------------------------------------------------------------------------

export type CompareTone = 'good' | 'warn' | 'bad' | 'muted';

export interface BuyComparison {
  /** The item's Pay up to against today's buyers; null without one. */
  payUpToScrap: Scrap | null;
  revenueScrap: Scrap | null;
  order: OrderSummary | null;
  buyerCount: number;
  /** null until a price is typed (or keys can be valued). */
  preview: ProfitPreview | null;
  tone: CompareTone;
  text: string;
}

/**
 * A buy at `costScrap` against the item's buyers now, with the engine's rules (quickModel).
 * `typed` says why costScrap is null (typedPrice), for the waiting text.
 */
export function buyComparison(
  costScrap: Scrap | null,
  d: Pick<ItemDetail, 'revenue' | 'buyOrders'> | null,
  p: PreviewSettings,
  keyScrap: Scrap | null,
  typed: TypedPriceState = 'empty',
): BuyComparison {
  const rev = d ? previewRevenue(d, p) : null;
  const base = {
    payUpToScrap: rev?.maxCostScrap ?? null,
    revenueScrap: rev?.revenueScrap ?? null,
    order: rev?.order ?? null,
    buyerCount: rev?.eligibleCount ?? 0,
  };
  if (!rev || rev.revenueScrap === null) {
    return { ...base, preview: null, tone: 'muted', text: 'No eligible backpack.tf buyer right now, so there is no Pay up to to compare with.' };
  }
  if (costScrap === null) return { ...base, preview: null, tone: 'muted', text: waitingText(typed, 'Type the price you paid to compare it with Pay up to.') };
  const pv = profitPreview(costScrap, rev, p);
  const profit = fmtSignedMoney(pv.profitScrap, keyScrap);
  if (pv.underCeiling === true) {
    const where = ceilingVerdict(pv, keyScrap);
    return { ...base, preview: pv, tone: 'good', text: `${where === 'At the ceiling' ? 'At Pay up to' : `${where} Pay up to`}: a flip, ${profit} if it sells now.` };
  }
  const over = base.payUpToScrap === null ? 'No price clears your thresholds against these buyers' : `${fmtMoney(costScrap - base.payUpToScrap, keyScrap)} over Pay up to`;
  if (pv.status === 'unprofitable') {
    const p = pv.profitScrap ?? 0;
    return { ...base, preview: pv, tone: 'bad', text: p === 0 ? `${over}: it only breaks even at today's buyers.` : `${over}: a loss of ${fmtMoney(-p, keyScrap)} at today's buyers.` };
  }
  return { ...base, preview: pv, tone: 'warn', text: `${over}: ${profit}, under your minimum profit.` };
}

export interface SellComparison {
  /** Units open before this sale; 0 when nothing of this SKU is held. */
  heldQty: number;
  /** The FIFO lot this sale closes (the oldest open buy). */
  lotCostScrap: Scrap | null;
  lotTs: UnixMs | null;
  /** sale - lot cost - friction, as the Holdings row counts it. */
  profitScrap: Scrap | null;
  status: HoldingStatus | null;
  /** The best buyer now, from the live book (to compare the typed price with). */
  bestNowScrap: Scrap | null;
  bestNowOrder: OrderSummary | null;
  tone: CompareTone;
  text: string;
}

/** Class for a comparison line's text: tone-text-* for good/warn/bad, plain muted otherwise. */
export function compareTextClass(tone: CompareTone): string {
  return tone === 'muted' ? 'muted' : `tone-text-${tone}`;
}

/**
 * A sale at `saleScrap` against the lot it closes, judged like the Holdings row (holdingFigures).
 * nextLotCostScrap is the lot at today's key price (lotCostAt), so the profit shown is what the
 * journal books for this sale, not a key price move since the buy.
 */
export function sellComparison(
  saleScrap: Scrap | null,
  held: Pick<HoldingRow, 'qty' | 'nextLotCostScrap' | 'heldSince' | 'revenueScrap' | 'revenueOrder'> | null,
  p: CeilingSettings,
  keyScrap: Scrap | null,
  now: UnixMs,
  typed: TypedPriceState = 'empty',
): SellComparison {
  if (!held || held.qty <= 0) {
    return {
      heldQty: 0,
      lotCostScrap: null,
      lotTs: null,
      profitScrap: null,
      status: null,
      bestNowScrap: null,
      bestNowOrder: null,
      tone: 'muted',
      text: 'No open buy of this item in your journal. The sale is kept and matched once you record the buy.',
    };
  }
  const base = {
    heldQty: held.qty,
    lotCostScrap: held.nextLotCostScrap,
    lotTs: held.heldSince > 0 ? held.heldSince : null,
    bestNowScrap: held.revenueScrap,
    bestNowOrder: held.revenueOrder,
  };
  const lot = `the lot you bought${base.lotTs !== null ? ` ${fmtAge(now - base.lotTs)} ago` : ''} for ${fmtMoney(held.nextLotCostScrap, keyScrap)}`;
  if (saleScrap === null) return { ...base, profitScrap: null, status: null, tone: 'muted', text: waitingText(typed, `Type the price you sold for to see the profit on ${lot}.`) };
  const profitScrap = saleScrap - held.nextLotCostScrap - frictionOf(p);
  const status = holdingStatusOf(profitStatus(profitScrap, held.nextLotCostScrap, p));
  const money = fmtSignedMoney(profitScrap, keyScrap);
  if (status === 'sell') return { ...base, profitScrap, status, tone: 'good', text: `Profit ${money} on ${lot}.` };
  if (status === 'hold') return { ...base, profitScrap, status, tone: 'warn', text: `Profit ${money} on ${lot}, under your minimum.` };
  if (profitScrap === 0) return { ...base, profitScrap, status, tone: 'bad', text: `Breaks even on ${lot}.` };
  return { ...base, profitScrap, status, tone: 'bad', text: `A loss of ${fmtMoney(-profitScrap, keyScrap)} on ${lot}.` };
}

/** The open position for this SKU in a 'holdings.list' answer: the journal's own SKU, else a case-insensitive match. */
export function holdingFor<T extends Pick<HoldingRow, 'sku'>>(rows: readonly T[], sku: string): T | null {
  const want = sku.trim();
  return rows.find((r) => r.sku === want) ?? rows.find((r) => r.sku.toLowerCase() === want.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * The open dialog after dialog `which` asks to close. A save that lands after its dialog was
 * dismissed (Esc while saving) and another one opened must leave the newer dialog open.
 */
export function afterDialogClose<S extends { seq: number }>(open: S | null, which: number): S | null {
  return open && open.seq === which ? null : open;
}

export function dialogTitle(side: JournalSide): string {
  return side === 'buy' ? 'Record buy' : 'Record sale';
}

/** The confirmation toast; it carries the Undo. */
export function recordedText(e: Pick<JournalEntry, 'side' | 'name' | 'keys' | 'scrap'>): string {
  return `Recorded ${e.side === 'buy' ? 'buy' : 'sale'} of ${e.name} at ${formatKeysMetal(e.keys || 0, e.scrap || 0)}.`;
}

export function undoneText(e: Pick<JournalEntry, 'side' | 'name'>): string {
  return `Removed the ${e.side === 'buy' ? 'buy' : 'sale'} of ${e.name} from your journal.`;
}

// ---------------------------------------------------------------------------
// Focus trap
// ---------------------------------------------------------------------------

/** Structural, so the walk runs on the DOM and on the tests' minimal DOM alike. */
export interface FocusNode {
  nodeType?: number;
  tagName?: string;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
  childNodes?: ArrayLike<FocusNode>;
}

const NATIVE_FOCUSABLE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

/** Reachable with Tab: enabled form controls, links and tabindex ≥ 0, minus tabindex -1 (roving groups) and hidden inputs. */
export function isTabbable(n: FocusNode): boolean {
  if (n.nodeType !== 1 || typeof n.tagName !== 'string' || typeof n.getAttribute !== 'function') return false;
  const tag = n.tagName.toUpperCase();
  const tabindex = n.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) < 0) return false;
  if (NATIVE_FOCUSABLE.has(tag)) {
    if (n.hasAttribute?.('disabled')) return false;
    return !(tag === 'INPUT' && (n.getAttribute('type') ?? '').toLowerCase() === 'hidden');
  }
  if (tag === 'A' && n.getAttribute('href') !== null) return true;
  return tabindex !== null && Number.isFinite(Number(tabindex));
}

/** The Tab order inside `root` (document order). */
export function tabbablesWithin<T extends FocusNode>(root: T): T[] {
  const out: T[] = [];
  const walk = (n: FocusNode): void => {
    const kids = n.childNodes;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]!;
      if (isTabbable(c)) out.push(c as T);
      walk(c);
    }
  };
  walk(root);
  return out;
}
