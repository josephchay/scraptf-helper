// Pure rules for the Record trade dialog (F12): its prefill, its checks, the
// journal row it writes, and the live comparison (a buy against the item's Pay
// up to, a sale against the next FIFO lot). Kept out of RecordTradeDialog.tsx so
// they are unit-tested. Nothing here writes or fetches; the dialog only ever
// writes the user's own journal (R4). 0.8: fees (J2), write-offs and editing a
// row's venue, note and fee with Undo (J6); a write-off sells nothing.

import { frictionOf, profitStatus, type CeilingSettings } from '../shared/ceiling';
import { formatKeysMetal, formatRef, parsePrice, valueScrap } from '../shared/currency';
import { holdingStatusOf } from '../shared/holdings';
import { JOURNAL_MAX_FEE_KEYS, JOURNAL_MAX_FEE_SCRAP, applyJournalPatch, feeOf, journalSummary } from '../shared/journal';
import { JOURNAL_SIDES } from '../shared/types';
import type {
  HoldingRow,
  HoldingStatus,
  ItemDetail,
  JournalClosedTrade,
  JournalEntry,
  JournalFee,
  JournalInput,
  JournalPatch,
  JournalSide,
  JournalWaitingSale,
  OrderSummary,
  Scrap,
  UnixMs,
} from '../shared/types';
import { JOURNAL_VENUES, WRITE_OFF_VENUE, venueFeeHint, venueLabel } from '../shared/venues';
import type { BareUnit } from './components/PriceInput';
import { fmtAge, fmtDate, fmtDateTime, fmtMoney, fmtSignedMoney, fromDateTimeLocal, toDateTimeLocal } from './format';
import { ceilingVerdict, noRevenueText, previewRevenue, profitPreview, type PreviewSettings, type ProfitPreview } from './quickModel';

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
  /** 0.7.4 (F38): When's prefill, else now: a waiting sale's "Record its buy" dates the buy just before the sale. */
  ts?: UnixMs;
  /** 0.8 (J6): edit this row (venue, note and fee only) instead of adding one; the other fields above are ignored. */
  editOf?: JournalEntry;
  /** 0.8 (J6): the FIFO pair the edited row belongs to, for the before/after profit; null or absent when it has none. */
  editPair?: JournalEditPair | null;
  /**
   * 0.8 (J6): true when the journal's summary was not read (still loading, or failed), so whether the row closed a
   * pair is unknown: editComparison then says the profit is worked out on save, never "no recorded buy" or "Still held".
   */
  editPairUnknown?: boolean;
}

/**
 * 0.8 (J6): an edited row's booked pair (as journalSummary closed it) and the pair's other row; `other` is null when
 * that row is not among the rows the page loaded (the Journal lists its newest 2000; the summary covers every row).
 */
export interface JournalEditPair {
  closed: JournalClosedTrade;
  other: JournalEntry | null;
}

/** The venue field's suggestions (a datalist: anything else can be typed). 0.8 (J4): the one journal venue list. */
export const VENUE_SUGGESTIONS: readonly string[] = JOURNAL_VENUES;
/** journal.add's own caps (rpcHandlers.ts journalInput). */
export const MAX_VENUE_CHARS = 100;
export const MAX_NOTE_CHARS = 500;
/** A trade dated further ahead than this is a typo (wrong day or AM/PM), not a clock skew. */
export const FUTURE_SLACK_MS = 5 * 60_000;
/**
 * 0.7.4 (F39): a When further back than this is a backfill: the trade's key price then is asked for
 * (prefilled with today's), so a key move since the trade never reads as profit.
 */
export const BACKFILL_MS = 10 * 60_000;
/** journal.add's key price bounds (rpcHandlers.ts journalInput): 1 ref to 100,000 scrap. */
export const MIN_KEY_PRICE_SCRAP = 9;
export const MAX_KEY_PRICE_SCRAP = 100_000;

export interface TradeForm {
  side: JournalSide;
  venue: string;
  /** Price text as typed (PriceInput grammar), read with `unit` for bare numbers. */
  text: string;
  unit: BareUnit;
  /** <input type="datetime-local"> value, local time. */
  when: string;
  note: string;
  /** 0.7.4 (F39): the key price then, in ref as typed, for a backfill (isBackfill); '' or absent: today's. */
  keyText?: string;
  /** 0.8 (J2): the fee as typed (PriceInput grammar, read with feeUnit); '' or absent: not recorded, 0: none. */
  feeText?: string;
  /** 0.8 (J2): the fee's unit for bare numbers; absent is 'ref'. */
  feeUnit?: BareUnit;
}

/** A buy's default venue is scrap.tf, a sale's backpack.tf, and (0.8) a write-off's WRITE_OFF_VENUE. */
export function defaultVenue(side: JournalSide): string {
  return side === 'writeoff' ? WRITE_OFF_VENUE : side === 'buy' ? 'scrap.tf' : 'backpack.tf';
}

function amount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * A price known only by its value (a HoldingRow's scraptfPaysScrap, F14) as whole keys plus metal at
 * key price `keyScrap`, the way scrap.tf lists one, for a prefill: valued back at the same key price
 * it is exactly `valueScrap`. Without a key price it is all metal.
 */
export function splitAtKey(valueScrap: Scrap, keyScrap: Scrap | null): { keys: number; scrap: Scrap } {
  const v = Math.max(0, Math.round(amount(valueScrap)));
  const k = typeof keyScrap === 'number' && Number.isFinite(keyScrap) ? Math.round(keyScrap) : 0;
  if (k <= 0) return { keys: 0, scrap: v };
  const keys = Math.floor(v / k);
  return { keys, scrap: v - keys * k };
}

/** The prefilled price as the user would type it ("1 key 5.11 ref"), or '' without one. */
export function initialPriceText(init: Pick<RecordTradeInit, 'keys' | 'scrap'>): string {
  const keys = amount(init.keys);
  const scrap = Math.round(amount(init.scrap));
  if (keys === 0 && scrap === 0) return '';
  return formatKeysMetal(keys, scrap);
}

/**
 * 0.8 (J6): a recorded fee as the Edit dialog prefills it ('' when none was recorded). Keys are written as stored:
 * formatKeysMetal rounds them to 2 decimals, so a fee of 0.125 keys read back as 0.13 and a save that touched
 * nothing rewrote it. A key count that String() writes in exponent form keeps formatKeysMetal's text; checkEdit and
 * editComparison treat the untouched prefill as the recorded fee (typedEditFee), so that one cannot change it either.
 */
export function feePrefillText(fee: JournalFee | null): string {
  if (!fee) return '';
  const keys = String(fee.keys);
  if (!fee.keys || !/^\d*\.?\d+$/.test(keys)) return formatKeysMetal(fee.keys, fee.scrap);
  const k = `${keys} key${fee.keys === 1 ? '' : 's'}`;
  return fee.scrap ? `${k} ${formatRef(fee.scrap)}` : k;
}

/**
 * The form the dialog opens with. 0.8 (J6): editing a row starts from the row itself, its fee written as typed
 * ('' when none was recorded, feePrefillText); adding one keeps the prefill rules and adds no fee keys.
 */
export function initialTradeForm(init: RecordTradeInit, now: UnixMs): TradeForm {
  const e = init.editOf;
  if (e) {
    return {
      side: e.side,
      venue: e.venue,
      text: initialPriceText(e),
      unit: 'ref',
      when: toDateTimeLocal(e.ts),
      note: e.note ?? '',
      feeText: feePrefillText(feeOf(e)),
      feeUnit: 'ref',
    };
  }
  const side: JournalSide = JOURNAL_SIDES.includes(init.side) ? init.side : 'buy';
  return {
    side,
    venue: (init.venue ?? '').trim().slice(0, MAX_VENUE_CHARS) || defaultVenue(side),
    text: initialPriceText(init),
    // The prefill is written with units, so the toggle only matters for what the user types.
    unit: 'ref',
    when: toDateTimeLocal(typeof init.ts === 'number' && Number.isFinite(init.ts) && init.ts > 0 && init.ts <= now ? init.ts : now),
    note: (init.note ?? '').trim().slice(0, MAX_NOTE_CHARS),
  };
}

/** 0.7.4 (F39): whether the form's When is a backfill (more than BACKFILL_MS before now); an empty or unreadable one is not. */
export function isBackfill(when: string, now: UnixMs): boolean {
  if (!when.trim()) return false;
  const ts = fromDateTimeLocal(when);
  return ts !== null && ts < now - BACKFILL_MS;
}

/**
 * 0.7.4 (F39): a backfill's key price, from the typed text (in ref, or "N scrap"), else today's `keyScrap`.
 * `{ value: null }` with no error: nothing typed and no key price known (the service stamps its own).
 */
export function backfillKeyPrice(keyText: string | undefined, keyScrap: Scrap | null): { value: Scrap | null; error: string | null } {
  const text = (keyText ?? '').trim();
  if (!text) return { value: typeof keyScrap === 'number' && Number.isFinite(keyScrap) && keyScrap > 0 ? Math.round(keyScrap) : null, error: null };
  const p = parsePrice(text, 'ref');
  if (!p || p.keys !== 0 || p.scrap < MIN_KEY_PRICE_SCRAP || p.scrap > MAX_KEY_PRICE_SCRAP) {
    return { value: null, error: 'Enter what a key cost then, in ref, for example 60.33.' };
  }
  return { value: p.scrap, error: null };
}

/**
 * The Journal form's rule: switching side moves the default venue along, never one the user typed. 0.8: a
 * write-off takes WRITE_OFF_VENUE, and leaving one for a buy or sale takes that side's default back.
 */
export function venueForSide(venue: string, side: JournalSide): string {
  if (side === 'writeoff') return WRITE_OFF_VENUE;
  if (venue.trim() === WRITE_OFF_VENUE) return defaultVenue(side);
  if (side === 'sell' && venue.trim() === 'scrap.tf') return 'backpack.tf';
  if (side === 'buy' && venue.trim() === 'backpack.tf') return 'scrap.tf';
  return venue;
}

export type TradeField = 'price' | 'venue' | 'when' | 'key' | 'fee';
export type TradeCheck = { ok: true; input: JournalInput } | { ok: false; field: TradeField; error: string };

const VENUE_MISSING = 'Enter where the trade happened, for example scrap.tf.';
const VENUE_TOO_LONG = `Keep the venue under ${MAX_VENUE_CHARS} characters.`;

// ---------------------------------------------------------------------------
// Fees (0.8, J2)
// ---------------------------------------------------------------------------

/** 0.8 (J2): the Fees field's hint where brief §5.4 names none for the venue. */
export const FEE_FIELD_HINT = 'Marketplace cut or trade cost, keys or metal. Empty: not recorded. 0: none.';
/** 0.8 (J2): readFee's refusal of text it can't read. */
export const FEE_UNREADABLE = "Can't read that fee. Try 0.22, 2 scrap or 0 for none.";
/** 0.8 (J2): readFee's refusal of a fee over journal.add's caps (JOURNAL_MAX_FEE_KEYS / _SCRAP). */
export const FEE_TOO_HIGH = 'That fee is higher than any trade could cost. Check the amount and its unit.';

/** 0.8 (J2): the hint under the Fees field: the venue's own (venueFeeHint, text only), else FEE_FIELD_HINT. */
export function feeHint(venue: string, side: JournalSide): string {
  return venueFeeHint(venue, side) ?? FEE_FIELD_HINT;
}

/** 0.8 (J2): the typed fee: null when empty (not recorded); an error when it can't be read. */
export function readFee(text: string | undefined, unit: BareUnit = 'ref'): { fee: JournalFee | null; error: string | null } {
  const t = (text ?? '').trim();
  if (!t) return { fee: null, error: null };
  const p = parsePrice(t, unit);
  if (!p) return { fee: null, error: FEE_UNREADABLE };
  // The service's zod caps, said before saving rather than after.
  if (p.keys > JOURNAL_MAX_FEE_KEYS || p.scrap > JOURNAL_MAX_FEE_SCRAP) return { fee: null, error: FEE_TOO_HIGH };
  return { fee: { keys: p.keys, scrap: p.scrap }, error: null };
}

/**
 * 0.8 (J2): a typed value as the journal books it: a buy's cost is price + fee, a sale's proceeds price - fee.
 * null when the fee has keys and there is no key price.
 */
export function bookedValue(side: JournalSide, value: Scrap | null, fee: JournalFee | null, keyScrap: Scrap | null): Scrap | null {
  if (value === null) return null;
  if (!fee || side === 'writeoff') return value;
  if (fee.keys && !validKeyScrap(keyScrap)) return null;
  const f = valueScrap(fee.keys, fee.scrap, keyScrap ?? 0);
  return side === 'buy' ? value + f : value - f;
}

/** 0.8 (J2): a backfilled sale's currencies less its fee (sellComparison's saleAt), as journalSummary nets them. */
export function saleAtLessFee(saleAt: SaleAtKeyPrice | null, fee: JournalFee | null): SaleAtKeyPrice | null {
  if (saleAt === null || !fee) return saleAt;
  return { keys: saleAt.keys - fee.keys, scrap: saleAt.scrap - fee.scrap, keyScrap: saleAt.keyScrap };
}

/**
 * The 'journal.add' params for this form, or the first thing to fix. 0.7.4 (F39): a backfill (isBackfill)
 * carries the key price then (`form.keyText`, else today's `keyScrap`), so its keys are valued as they were.
 * 0.8 (J2): a buy or sale's fee (readFee) after the price and venue; empty adds no fee keys (not recorded).
 * 0.8: a write-off has no price and no fee (keys and scrap 0) and its venue defaults to WRITE_OFF_VENUE.
 */
export function checkTrade(form: TradeForm, item: { sku: string; name: string }, now: UnixMs, keyScrap: Scrap | null = null): TradeCheck {
  const writeoff = form.side === 'writeoff';
  let price: { keys: number; scrap: Scrap } = { keys: 0, scrap: 0 };
  if (!writeoff) {
    const text = form.text.trim();
    const parsed = text ? parsePrice(text, form.unit) : null;
    if (!parsed) {
      return { ok: false, field: 'price', error: text ? "Can't read that price. Try 1.33, 14 scrap, 2 keys or 2k 5.11." : 'Enter the price, for example 1.33 or 2 keys 5.11.' };
    }
    price = parsed;
  }
  // A write-off has no counterparty, so an empty venue is simply "Written off".
  const venue = form.venue.trim() || (writeoff ? WRITE_OFF_VENUE : '');
  if (!venue) return { ok: false, field: 'venue', error: VENUE_MISSING };
  if (venue.length > MAX_VENUE_CHARS) return { ok: false, field: 'venue', error: VENUE_TOO_LONG };
  let fee: JournalFee | null = null;
  if (!writeoff) {
    const f = readFee(form.feeText, form.feeUnit);
    if (f.error !== null) return { ok: false, field: 'fee', error: f.error };
    fee = f.fee;
  }
  const ts = form.when.trim() ? fromDateTimeLocal(form.when) : now;
  if (ts === null) return { ok: false, field: 'when', error: 'Enter a valid date and time.' };
  if (ts > now + FUTURE_SLACK_MS) return { ok: false, field: 'when', error: 'That date is in the future.' };
  let keyPriceScrap: Scrap | null = null;
  if (ts < now - BACKFILL_MS) {
    const k = backfillKeyPrice(form.keyText, keyScrap);
    if (k.error !== null) return { ok: false, field: 'key', error: k.error };
    keyPriceScrap = k.value;
  }
  const note = form.note.trim().slice(0, MAX_NOTE_CHARS);
  return {
    ok: true,
    input: {
      side: form.side,
      venue,
      sku: item.sku,
      name: item.name,
      keys: price.keys,
      scrap: price.scrap,
      ts,
      note: note || null,
      ...(keyPriceScrap !== null ? { keyPriceScrap } : {}),
      ...(fee ? { feeKeys: fee.keys, feeScrap: fee.scrap } : {}),
    },
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
    // 0.7.3: eligible orders none of which is usable (all outliers, or no bot for Instant) say so, with the count.
    return { ...base, preview: null, tone: 'muted', text: `${noRevenueText(rev)}, so there is no Pay up to to compare with.` };
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
  /** 0.8 (J2): what the journal books (no friction); profitScrap is this less friction, as Holdings judges. */
  bookedScrap: Scrap | null;
  status: HoldingStatus | null;
  /** The best buyer now, from the live book (to compare the typed price with). */
  bestNowScrap: Scrap | null;
  bestNowOrder: OrderSummary | null;
  /**
   * 0.7.4 (R23): the key price lotCostScrap and profitScrap are valued at: a backfill's key price then
   * (`saleAt`), else null (today's, the dialog's keyScrap). Format them with it.
   */
  atKeyScrap: Scrap | null;
  tone: CompareTone;
  text: string;
}

/** 0.7.4 (R23): a backfilled sale as typed, keys and metal apart, and its key price then (backfillKeyPrice). */
export interface SaleAtKeyPrice {
  keys: number;
  scrap: Scrap;
  keyScrap: Scrap;
}

/** Class for a comparison line's text: tone-text-* for good/warn/bad, plain muted otherwise. */
export function compareTextClass(tone: CompareTone): string {
  return tone === 'muted' ? 'muted' : `tone-text-${tone}`;
}

/**
 * 0.7.4 (F38): a sale with no buy before it waits (JournalSummary.waitingSales): a later buy is another copy.
 * The comparison's text for it, and the Journal page's help for its waiting sales.
 */
export const NO_LOT_SALE_TEXT = 'No open buy of this item in your journal. The sale is kept apart, not matched to a later buy: record its buy dated before the sale to match it.';
export const LOT_AFTER_SALE_TEXT =
  'This sale is dated before your open buy of this item, so it is not matched to that buy: it closes an earlier buy, or is kept apart when there is none. Date it after the buy to sell that copy.';

/** 0.8: "the lot you bought 3 d ago for 4.44 ref", the lot a sale or write-off closes, in the comparison texts. */
export function lotPhrase(lotTs: UnixMs | null, lotCostScrap: Scrap, k: Scrap | null, now: UnixMs, todayNote: string): string {
  return `the lot you bought${lotTs !== null ? ` ${fmtAge(now - lotTs)} ago` : ''} for ${fmtMoney(lotCostScrap, k)}${todayNote}`;
}

/**
 * A sale at `saleScrap` against the lot it closes, judged like the Holdings row (holdingFigures).
 * nextLotCostScrap is the lot at today's key price (lotCostAt), so the profit shown is what the
 * journal books for a sale logged now, not a key price move since the buy. 0.7.4 (F38): `saleTs`, the
 * sale's When: a sale dated before the oldest open lot closes none (it waits), so it is compared with none.
 * 0.7.4 (R23): `saleAt`, a backfill's own currencies and key price then: the journal books that pair at
 * the key price then (pairProfit), so the lot's own keys and metal (nextLotKeys, nextLotScrapRaw) are
 * netted against the sale's and valued at it. A lot without its currencies keeps today's math, said so.
 * Friction only, never the price-move reserve (0.8, PC-1): a sale into a live order leaves no price move to cover.
 * 0.8 (J2): the text states what the journal books (bookedScrap, no friction); status and tone are judged with
 * friction, as Holdings judges them, and a set friction adds the friction-judged figure to the text.
 */
export function sellComparison(
  saleScrap: Scrap | null,
  held: Pick<HoldingRow, 'qty' | 'nextLotCostScrap' | 'heldSince' | 'revenueScrap' | 'revenueOrder' | 'nextLotKeys' | 'nextLotScrapRaw'> | null,
  p: CeilingSettings,
  keyScrap: Scrap | null,
  now: UnixMs,
  typed: TypedPriceState = 'empty',
  saleTs: UnixMs | null = null,
  saleAt: SaleAtKeyPrice | null = null,
): SellComparison {
  const lotAfterSale = !!held && held.qty > 0 && saleTs !== null && held.heldSince > 0 && saleTs < held.heldSince;
  if (!held || held.qty <= 0 || lotAfterSale) {
    return {
      // None open before this sale: a lot bought after it is not one.
      heldQty: 0,
      lotCostScrap: null,
      lotTs: null,
      profitScrap: null,
      bookedScrap: null,
      status: null,
      bestNowScrap: null,
      bestNowOrder: null,
      atKeyScrap: null,
      tone: 'muted',
      text: lotAfterSale ? LOT_AFTER_SALE_TEXT : NO_LOT_SALE_TEXT,
    };
  }
  const then = saleAt !== null && validKeyScrap(saleAt.keyScrap) ? saleAt : null;
  const lotKeys = held.nextLotKeys;
  const lotScrap = held.nextLotScrapRaw;
  const lotRaw = typeof lotKeys === 'number' && Number.isFinite(lotKeys) && typeof lotScrap === 'number' && Number.isFinite(lotScrap) ? { keys: lotKeys, scrap: lotScrap } : null;
  // At the key price then only with the lot's own currencies; else today's, and the text says so.
  const atThen = then !== null && lotRaw !== null ? then : null;
  const k = atThen ? atThen.keyScrap : keyScrap;
  const lotCostScrap = atThen && lotRaw ? valueScrap(lotRaw.keys, lotRaw.scrap, atThen.keyScrap) : held.nextLotCostScrap;
  const todayNote = then !== null && atThen === null && then.keyScrap !== keyScrap ? " (at today's key price)" : '';
  const base = {
    heldQty: held.qty,
    lotCostScrap,
    lotTs: held.heldSince > 0 ? held.heldSince : null,
    bestNowScrap: held.revenueScrap,
    bestNowOrder: held.revenueOrder,
    atKeyScrap: atThen ? atThen.keyScrap : null,
  };
  const lot = lotPhrase(base.lotTs, lotCostScrap, k, now, todayNote);
  if (saleScrap === null) return { ...base, profitScrap: null, bookedScrap: null, status: null, tone: 'muted', text: waitingText(typed, `Type the price you sold for to see the profit on ${lot}.`) };
  // pairProfit's own math for a backfill (keys and metal netted apart), plus the friction Holdings subtracts.
  const profitScrap =
    atThen && lotRaw ? valueScrap(atThen.keys - lotRaw.keys, atThen.scrap - lotRaw.scrap, atThen.keyScrap) - frictionOf(p) : saleScrap - held.nextLotCostScrap - frictionOf(p);
  const friction = frictionOf(p);
  const bookedScrap = profitScrap + friction;
  const status = holdingStatusOf(profitStatus(profitScrap, lotCostScrap, p));
  const booked = fmtSignedMoney(bookedScrap, k);
  // At the default friction of 0 every text reads exactly as before 0.8.
  const fr = friction === 0 ? '' : ` That is ${fmtSignedMoney(profitScrap, k)} after your ${fmtMoney(friction, k)} per-trade friction.`;
  const out = { ...base, profitScrap, bookedScrap, status };
  if (status === 'sell') return { ...out, tone: 'good', text: `Profit ${booked} on ${lot}.${fr}` };
  if (status === 'hold') return { ...out, tone: 'warn', text: `Profit ${booked} on ${lot}, under your minimum.${fr}` };
  if (bookedScrap === 0) return { ...out, tone: 'bad', text: `Breaks even on ${lot}.` };
  if (bookedScrap > 0) return { ...out, tone: 'bad', text: `Profit ${booked} on ${lot}, a loss after your ${fmtMoney(friction, k)} per-trade friction.` };
  return { ...out, tone: 'bad', text: `A loss of ${fmtMoney(-bookedScrap, k)} on ${lot}.${fr}` };
}

/** 0.8: a write-off with no open buy of the item dated at or before it (it waits, as a sale would). */
export const NO_LOT_WRITE_OFF_TEXT = 'No open buy of this item dated at or before this write-off: it is kept apart until its buy is recorded dated before it.';
/** 0.8: LOT_AFTER_SALE_TEXT for a write-off dated before the open lot. */
export const LOT_AFTER_WRITE_OFF_TEXT =
  'This write-off is dated before your open buy of this item, so it is not matched to that buy: it closes an earlier buy, or is kept apart when there is none. Date it after the buy to write off that copy.';

/**
 * 0.8: a write-off against the lot it closes: the loss is that lot's cost (at the key price then for a backfill),
 * exactly as booked (journalSummary books -cost, no friction and no pairProfit). bestNowScrap/bestNowOrder are
 * kept, so the dialog still shows "Sells now" before the user writes off something sellable.
 */
export function writeoffComparison(
  held: Pick<HoldingRow, 'qty' | 'nextLotCostScrap' | 'heldSince' | 'revenueScrap' | 'revenueOrder' | 'nextLotKeys' | 'nextLotScrapRaw'> | null,
  p: CeilingSettings,
  keyScrap: Scrap | null,
  now: UnixMs,
  ts: UnixMs | null,
  keyThen: Scrap | null,
): SellComparison {
  const c = sellComparison(0, held, p, keyScrap, now, 'ok', ts, keyThen !== null ? { keys: 0, scrap: 0, keyScrap: keyThen } : null);
  if (c.heldQty === 0 || c.lotCostScrap === null) {
    return { ...c, profitScrap: null, bookedScrap: null, status: null, tone: 'muted', text: c.text === LOT_AFTER_SALE_TEXT ? LOT_AFTER_WRITE_OFF_TEXT : NO_LOT_WRITE_OFF_TEXT };
  }
  const k = c.atKeyScrap ?? keyScrap;
  // As sellComparison: a key price then that the lot's own currencies cannot use is said to be today's.
  const todayNote = keyThen !== null && validKeyScrap(keyThen) && c.atKeyScrap === null && keyThen !== keyScrap ? " (at today's key price)" : '';
  const loss = c.lotCostScrap;
  return {
    ...c,
    profitScrap: -loss,
    bookedScrap: -loss,
    status: loss > 0 ? 'loss' : null,
    tone: loss > 0 ? 'bad' : 'muted',
    text: `Writes off ${lotPhrase(c.lotTs, loss, k, now, todayNote)}: a loss of ${fmtMoney(loss, k)}. Nothing is sold.`,
  };
}

function validKeyScrap(v: unknown): v is Scrap {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * 0.7.4 (R23): the sale as Record sale previews it. A backfill (isBackfill) with a usable key price then
 * (backfillKeyPrice) is valued at it, keys and metal kept apart for sellComparison's `saleAt`; anything else
 * at today's `keyScrap` with no `saleAt`. An unusable key price then keeps today's (the save refuses it).
 */
export function saleAtKeyPrice(
  form: Pick<TradeForm, 'text' | 'unit' | 'when' | 'keyText'>,
  keyScrap: Scrap | null,
  now: UnixMs,
): { value: Scrap | null; typed: TypedPriceState; saleAt: SaleAtKeyPrice | null } {
  const today = typedPrice(form, keyScrap);
  if (!isBackfill(form.when, now)) return { value: today.value, typed: today.state, saleAt: null };
  const k = backfillKeyPrice(form.keyText, keyScrap);
  if (k.error !== null || k.value === null) return { value: today.value, typed: today.state, saleAt: null };
  const at = typedPrice(form, k.value);
  const parsed = at.state === 'ok' ? parsePrice(form.text.trim(), form.unit) : null;
  if (!parsed) return { value: at.value, typed: at.state, saleAt: null };
  return { value: at.value, typed: at.state, saleAt: { keys: parsed.keys, scrap: parsed.scrap, keyScrap: k.value } };
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

/** The dialog's title and save button when adding a row: 'Record buy', 'Record sale' or (0.8) 'Write off'. */
export function dialogTitle(side: JournalSide): string {
  return side === 'writeoff' ? 'Write off' : side === 'buy' ? 'Record buy' : 'Record sale';
}

/** 0.8 (J6): the dialog's title when editing a row. */
export function editTitle(side: JournalSide): string {
  return side === 'writeoff' ? 'Edit write-off' : side === 'buy' ? 'Edit buy' : 'Edit sale';
}

/** 0.8: a row's side as a noun in running text: 'buy', 'sale' or 'write-off'. */
export function sideWord(side: JournalSide): string {
  return side === 'writeoff' ? 'write-off' : side === 'buy' ? 'buy' : 'sale';
}

/** The confirmation toast; it carries the Undo. 0.8: a write-off has no price to name. */
export function recordedText(e: Pick<JournalEntry, 'side' | 'name' | 'keys' | 'scrap'>): string {
  if (e.side === 'writeoff') return `Recorded a write-off of ${e.name}.`;
  return `Recorded ${e.side === 'buy' ? 'buy' : 'sale'} of ${e.name} at ${formatKeysMetal(e.keys || 0, e.scrap || 0)}.`;
}

/** The Undo's toast after a recorded row was deleted again. */
export function undoneText(e: Pick<JournalEntry, 'side' | 'name'>): string {
  return `Removed the ${sideWord(e.side)} of ${e.name} from your journal.`;
}

// ---------------------------------------------------------------------------
// Edit (0.8, J6): venue, note and fee only
// ---------------------------------------------------------------------------

function sameFee(a: JournalFee | null, b: JournalFee | null): boolean {
  return a === null || b === null ? a === b : a.keys === b.keys && a.scrap === b.scrap;
}

/**
 * 0.8 (J6): the fee an edit's Fees field stands for. The prefill as opened (feePrefillText of the row's own fee,
 * trimmed) is the recorded fee itself, so opening Edit and saving never rewrites it; anything else is readFee's.
 */
export function typedEditFee(form: Pick<TradeForm, 'feeText' | 'feeUnit'>, before: JournalEntry): { fee: JournalFee | null; error: string | null } {
  const recorded = feeOf(before);
  if ((form.feeText ?? '').trim() === feePrefillText(recorded)) return { fee: recorded, error: null };
  return readFee(form.feeText, form.feeUnit);
}

/**
 * 0.8 (J6): the 'journal.update' patch for the changed venue, note and fee only ({} when nothing changed), or the
 * first thing to fix. A write-off checks only its note; a buy or sale its venue (checkTrade's texts), its note
 * (trimmed, capped, empty is null) and its fee (typedEditFee: the untouched prefill is no change; else readFee,
 * where empty clears it to not recorded).
 */
export function checkEdit(
  form: Pick<TradeForm, 'venue' | 'note' | 'feeText' | 'feeUnit'>,
  before: JournalEntry,
): { ok: true; patch: JournalPatch } | { ok: false; field: TradeField; error: string } {
  const patch: JournalPatch = {};
  if (before.side !== 'writeoff') {
    const venue = form.venue.trim();
    if (!venue) return { ok: false, field: 'venue', error: VENUE_MISSING };
    if (venue.length > MAX_VENUE_CHARS) return { ok: false, field: 'venue', error: VENUE_TOO_LONG };
    const f = typedEditFee(form, before);
    if (f.error !== null) return { ok: false, field: 'fee', error: f.error };
    if (venue !== before.venue) patch.venue = venue;
    if (!sameFee(feeOf(before), f.fee)) {
      patch.feeKeys = f.fee?.keys ?? null;
      patch.feeScrap = f.fee?.scrap ?? null;
    }
  }
  const note = form.note.trim().slice(0, MAX_NOTE_CHARS) || null;
  if (note !== (before.note ?? null)) patch.note = note;
  return { ok: true, patch };
}

/** 0.8 (J6): the edit's Undo: the row's old venue, note and fee (null clears a fee that was not recorded). */
export function journalUndoPatch(before: JournalEntry): JournalPatch {
  const fee = feeOf(before);
  return { venue: before.venue, note: before.note, feeKeys: fee?.keys ?? null, feeScrap: fee?.scrap ?? null };
}

/** 0.8 (J6): the saved edit's toast (it carries the Undo). */
export function editedText(after: Pick<JournalEntry, 'side' | 'name'>): string {
  return `Updated the ${sideWord(after.side)} of ${after.name}.`;
}

/** 0.8 (J6): the edit's Undo toast. */
export function editUndoneText(before: Pick<JournalEntry, 'side' | 'name'>): string {
  return `Restored the ${sideWord(before.side)} of ${before.name}.`;
}

/** 0.8 (J6): what an edit cannot change and how to change it (delete the row and log it again). */
export function editLockedText(e: JournalEntry): string {
  if (e.side === 'writeoff') return `Written off on ${fmtDateTime(e.ts)}. To change the time, delete it and log it again.`;
  const key = e.keys ? ` (key at ${fmtMoney(e.keyPriceScrap, null)})` : '';
  return `${e.side === 'buy' ? 'Bought' : 'Sold'} for ${formatKeysMetal(e.keys, e.scrap)} on ${fmtDateTime(e.ts)}${key}. To change the price or time, delete this trade and log it again.`;
}

/** 0.8 (J6): the pair's booked profit as editComparison words it, with `was` (or '') appended. */
function bookedPairText(before: JournalEntry, c: JournalClosedTrade, was: string): { tone: CompareTone; text: string } {
  const signed = fmtSignedMoney(c.profitScrap, c.keyPriceScrap);
  const tone: CompareTone = c.profitScrap > 0 ? 'good' : c.profitScrap < 0 ? 'bad' : 'muted';
  if (before.side === 'buy') return { tone, text: `Its ${c.kind === 'writeoff' ? 'write-off' : 'sale'} of ${fmtDate(c.soldAt)} books ${signed}${was}.` };
  return { tone, text: `This ${sideWord(before.side)} books ${signed} on the buy of ${fmtDate(c.boughtAt)} (${venueLabel(c.buyVenue)})${was}.` };
}

/**
 * 0.8 (J6): the edit's before/after: the pair booked again with the typed fee (journalSummary over the two rows),
 * at the sale's key price. An edit never changes which buy a sale closes, so only the profit moves. The untouched
 * prefill is the recorded fee (typedEditFee). A pair whose other row the page has not loaded (`other` null: the
 * Journal lists its newest 2000 rows, the summary covers them all) keeps its booked profit and, with a new fee, says
 * the profit is worked out when it is saved: it is never called a sale with no buy. Without the journal's summary
 * (`pairUnknown`: RecordTradeInit.editPairUnknown) nothing is known of the pair, and the text says only that.
 */
export function editComparison(
  before: JournalEntry,
  form: Pick<TradeForm, 'feeText' | 'feeUnit'>,
  pair: JournalEditPair | null,
  pairUnknown = false,
): { tone: CompareTone; text: string } {
  const f = typedEditFee(form, before);
  if (f.error !== null) return { tone: 'muted', text: "Can't read that fee yet, so there is nothing to compare." };
  if (!pair && pairUnknown) return { tone: 'muted', text: "Your journal's totals have not loaded, so this trade's profit is worked out when you save." };
  if (!pair) {
    if (before.side === 'buy') return { tone: 'muted', text: "Still held: its fee is part of the lot's cost, so Holdings and its sale's profit include it." };
    return { tone: 'muted', text: `This ${sideWord(before.side)} has no recorded buy before it, so it books no profit yet.` };
  }
  // A write-off takes no fee, so it is booked as it is.
  const unchanged = before.side === 'writeoff' || sameFee(feeOf(before), f.fee);
  if (!pair.other) {
    if (unchanged) return bookedPairText(before, pair.closed, '');
    const now = bookedPairText(before, pair.closed, ' with the fee as recorded');
    const which = before.side === 'buy' ? (pair.closed.kind === 'writeoff' ? 'That write-off' : 'That sale') : 'That buy';
    return { tone: 'muted', text: `${now.text} ${which} is not among the trades loaded here, so the profit with this fee is worked out when you save.` };
  }
  const after = unchanged ? before : applyJournalPatch(before, { feeKeys: f.fee?.keys ?? null, feeScrap: f.fee?.scrap ?? null });
  const c = journalSummary(before.side === 'buy' ? [after, pair.other] : [pair.other, after]).closed[0];
  if (!c) return { tone: 'muted', text: 'The profit is worked out again when you save.' };
  const was = c.profitScrap !== pair.closed.profitScrap ? ` (was ${fmtSignedMoney(pair.closed.profitScrap, c.keyPriceScrap)})` : '';
  return bookedPairText(before, c, was);
}

/** 0.7.4 (F38): how far before a waiting sale its "Record its buy" dates the buy (When has minute steps). */
export const WAITING_SALE_BUY_LEAD_MS = 60_000;

/**
 * 0.7.4 (F38): the Record buy dialog for a waiting sale's "Record its buy": a scrap.tf buy of the item dated
 * just before the sale, price empty, so FIFO matches the two.
 */
export function waitingSaleBuyInit(w: Pick<JournalWaitingSale, 'sku' | 'name' | 'ts'>): RecordTradeInit {
  return { side: 'buy', sku: w.sku, name: w.name, venue: defaultVenue('buy'), ts: Math.max(1, w.ts - WAITING_SALE_BUY_LEAD_MS) };
}

/**
 * 0.8: JournalSummary.waitingSales counted apart: sales, and write-offs with no lot (`writeoff: true`), so no text
 * calls a write-off a sale.
 */
export function waitingCounts(waiting: readonly Pick<JournalWaitingSale, 'writeoff'>[] | null | undefined): { sales: number; writeoffs: number } {
  const list = Array.isArray(waiting) ? waiting : [];
  const writeoffs = list.filter((w) => w?.writeoff === true).length;
  return { sales: list.length - writeoffs, writeoffs };
}

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * 0.7.4 (F38): the Journal and Holdings help for sales with no buy before them, or null with none. 0.8: `writeoffs`,
 * the write-offs waiting the same way (waitingCounts), are named as write-offs; with none the text is as in 0.7.4.
 */
export function waitingSalesText(count: number, writeoffs = 0): string | null {
  const s = count > 0 ? count : 0;
  const w = writeoffs > 0 ? writeoffs : 0;
  if (s === 0 && w === 0) return null;
  const one = s + w === 1;
  const it = one ? 'it' : 'them';
  if (w === 0) {
    const which = one ? 'A sale in your journal has' : `${s} sales in your journal have`;
    return `${which} no buy of the item dated before ${it}, so ${one ? 'it counts' : 'they count'} as neither profit nor a holding, and a later buy is never matched to ${it} (that is another copy). To match one, record its buy dated before the sale.`;
  }
  if (s === 0) {
    const which = one ? 'A write-off in your journal has' : `${w} write-offs in your journal have`;
    return `${which} no buy of the item dated before ${it}, so ${one ? 'it counts' : 'they count'} as neither a loss nor a holding, and a later buy is never matched to ${it} (that is another copy). To match one, record its buy dated before the write-off.`;
  }
  return `${counted(s, 'sale', 'sales')} and ${counted(w, 'write-off', 'write-offs')} in your journal have no buy of the item dated before them, so none of them counts as profit, loss or a holding, and a later buy is never matched to them (that is another copy). To match one, record its buy dated before the sale or write-off.`;
}

/** 0.8: the Journal's heading over the waiting rows: sales, write-offs or both (waitingCounts). */
export function waitingTitle(sales: number, writeoffs: number): string {
  if (!(writeoffs > 0)) return 'Sales without a recorded buy';
  return sales > 0 ? 'Sales and write-offs without a recorded buy' : 'Write-offs without a recorded buy';
}

/**
 * 0.8 (review): the waiting table's amount column header: "Sold for" over sales only (as in 0.7.4), "Sold for / written
 * off" over both, "Recorded as" over write-offs only (each cell reads "Written off"), so no header calls a write-off a sale.
 */
export function waitingAmountHeader(sales: number, writeoffs: number): string {
  if (!(writeoffs > 0)) return 'Sold for';
  return sales > 0 ? 'Sold for / written off' : 'Recorded as';
}

/** 0.8: a waiting row's "Record its buy" tooltip, for a sale or a write-off. */
export function waitingBuyTitle(w: Pick<JournalWaitingSale, 'writeoff'>): string {
  return w.writeoff
    ? 'Record the buy of the copy you wrote off, dated just before the write-off, so the two are matched'
    : 'Record the buy of the copy you sold, dated just before the sale, so the two are matched';
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
