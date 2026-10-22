// The trade journal's rules (brief §5.9), shared by the service, the dashboard and the mock so all three book alike:
// FIFO (moved here from service/domain/journal.ts in 0.8), the closed ledger (J1), fees (J2), write-offs, the typical
// hold (H5) and the ledger CSV cells (J5). Pure: no I/O, no network. Imports only ./currency and ./types.
//
// Each row is one item and stores the key price that applied when it was logged. A matched buy/sell pair is netted
// in keys and metal separately and the difference is valued at the sell row's key price, so a flip bought and sold
// for the same number of keys makes 0 whatever keys did in between, and later key price moves do not rewrite past
// profit.

import { scrapToRef, valueScrap } from './currency';
import { JOURNAL_SIDES } from './types';
import type {
  JournalClosedTrade,
  JournalEntry,
  JournalFee,
  JournalPatch,
  JournalPosition,
  JournalSummary,
  JournalWaitingSale,
  Scrap,
  TypicalHold,
  UnixMs,
} from './types';

/** The service's DEFAULT_KEY_SCRAP (60 ref, service/domain/keyprice.ts) for a row with no usable key price before it; a test pins them equal. */
export const JOURNAL_FALLBACK_KEY_SCRAP: Scrap = 540;
/** journal.add / journal.update fee caps (zod), shared with the mock. */
export const JOURNAL_MAX_FEE_KEYS = 10_000;
export const JOURNAL_MAX_FEE_SCRAP = 10_000_000;
/** Fixed refusals, worded alike by the service and the mock. */
export const JOURNAL_ENTRY_GONE = 'That trade is no longer in your journal.';
export const JOURNAL_WRITE_OFF_NOTHING = 'a write-off receives nothing: no price and no fee';
/** H5: a typical hold needs this many of the item's own sales, else this many sales in all. */
export const TYPICAL_HOLD_MIN_ITEM = 3;
export const TYPICAL_HOLD_MIN_ALL = 5;

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validKeyPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 0.8 (J2): a row's recorded fee; null when none was recorded. Unreadable parts read as 0, negatives as 0. */
export function feeOf(e: Partial<Pick<JournalEntry, 'feeKeys' | 'feeScrap'>> | null | undefined): JournalFee | null {
  if (!e) return null;
  const k = finiteNum(e.feeKeys) ? e.feeKeys : null;
  const s = finiteNum(e.feeScrap) ? e.feeScrap : null;
  if (k === null && s === null) return null;
  return { keys: Math.max(0, k ?? 0), scrap: Math.max(0, Math.round(s ?? 0)) };
}

/** 0.8 (J6): what a patch does to the fee: undefined leaves it, null clears it, a fee sets both parts. */
export function feePatchOf(p: Pick<JournalPatch, 'feeKeys' | 'feeScrap'>): JournalFee | null | undefined {
  if (p.feeKeys === undefined && p.feeScrap === undefined) return undefined;
  const k = finiteNum(p.feeKeys) ? p.feeKeys : null;
  const s = finiteNum(p.feeScrap) ? p.feeScrap : null;
  if (k === null && s === null) return null;
  return { keys: k ?? 0, scrap: Math.round(s ?? 0) };
}

/** 0.8 (J6): the row after a patch (the mock's journal.update and the dialog's edit preview). */
export function applyJournalPatch(e: JournalEntry, patch: JournalPatch): JournalEntry {
  const out: JournalEntry = { ...e };
  if (patch.venue !== undefined) out.venue = patch.venue;
  if (patch.note !== undefined) out.note = patch.note;
  const fee = feePatchOf(patch);
  if (fee === null) {
    delete out.feeKeys;
    delete out.feeScrap;
  } else if (fee !== undefined) {
    out.feeKeys = fee.keys;
    out.feeScrap = fee.scrap;
  }
  return out;
}

// ---------------------------------------------------------------------------
// FIFO (J1) and the closed ledger
// ---------------------------------------------------------------------------

/** Value of one row in scrap. A row without a usable key price borrows the nearest earlier one. */
export function journalValue(e: Pick<JournalEntry, 'keys' | 'scrap' | 'keyPriceScrap'>, fallbackKeyScrap: Scrap = JOURNAL_FALLBACK_KEY_SCRAP): Scrap {
  return valueScrap(finite(e.keys), finite(e.scrap), validKeyPrice(e.keyPriceScrap) ? e.keyPriceScrap : fallbackKeyScrap);
}

/**
 * One row as FIFO books it: its price in its own currencies with (0.8, J2) its fee added for a buy (the cost basis)
 * or taken off for a sale (the proceeds), plus the key price that applied to it.
 */
interface Lot {
  keys: number;
  scrap: Scrap;
  k: Scrap;
  /** The row's id and time (an open buy becomes a JournalLot). */
  id: number;
  ts: UnixMs;
  /** As typed, or '' (JournalClosedTrade keeps both rows' venues). */
  venue: string;
  /** The recorded fee; null when none was (a write-off never has one). */
  fee: JournalFee | null;
  /** The row itself, for journalLedger's FIFO states. */
  entry: JournalEntry;
}

/** Sell minus buy, netted per currency and valued at the sell row's key price. */
function pairProfit(sell: Lot, buy: Lot): Scrap {
  return valueScrap(sell.keys - buy.keys, sell.scrap - buy.scrap, sell.k);
}

/**
 * 0.7.4 (R25): the journal's processing order. Rows go by time; at the same time a buy
 * goes before a sale, so a buy dated exactly at a sale is "at or before" it even when it
 * was recorded second (the Record trade dialog keeps minutes only, so a sale and its buy
 * logged within one minute share a ts). Then by id, so FIFO among buys is unchanged.
 * 0.8: a write-off ranks with the sale, so a write-off dated exactly at its buy closes it.
 */
export function journalOrder(a: Pick<JournalEntry, 'ts' | 'id' | 'side'>, b: Pick<JournalEntry, 'ts' | 'id' | 'side'>): number {
  const sideRank = (e: Pick<JournalEntry, 'side'>): number => (e.side === 'buy' ? 0 : 1);
  return finite(a.ts) - finite(b.ts) || sideRank(a) - sideRank(b) || finite(a.id) - finite(b.id);
}

/** What journalLedger is told about each row FIFO books (a skipped row is never named). */
type FifoMark = (e: JournalEntry, fifo: 'open' | 'closed' | 'waiting', closed: JournalClosedTrade | null) => void;

/**
 * FIFO per SKU in time order: a sell closes the oldest open buy dated at or before it
 * (0.7.4 R25: a buy at the sale's own time counts, see journalOrder).
 * 0.7.4 (F38): a sell with no such buy (an item owned before the app, or a buy never
 * logged) is a waiting sale (JournalSummary.waitingSales), never matched against a
 * later buy: in TF2 a copy is bought before it is sold, so a buy after the sale is
 * another copy, and pairing them hid a real holding (and its Sell: alerts) and booked
 * two unrelated trades as a flip. A buy logged late is matched by dating it before the
 * sale. Waiting sales count as neither profit nor holdings. Open positions are valued
 * at their buy rows' own key prices; each lot also keeps its keys and metal apart.
 * 0.8 (J2): a buy's recorded fee joins its lot's cost basis and a sale's comes off its
 * proceeds, per currency; pairProfit is unchanged. 0.8: a write-off closes the oldest lot
 * like a sale that receives nothing and books exactly that lot's cost (at the write-off's
 * key price) as a loss; with no lot it waits like a sale. 0.8 (J1): every pair is kept in
 * `closed`, so sum(closed.profitScrap) === realizedProfitScrap.
 */
function walkJournal(entries: readonly JournalEntry[], mark?: FifoMark): JournalSummary {
  const rows = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.sku === 'string' && e.sku !== '' && JOURNAL_SIDES.includes(e.side))
    .sort(journalOrder);

  const lots = new Map<string, Lot[]>();
  const waitingSales: JournalWaitingSale[] = [];
  const closed: JournalClosedTrade[] = [];
  const names = new Map<string, string>();
  const bySku = new Map<string, { sku: string; name: string; realizedProfitScrap: Scrap; trades: number }>();
  let realized = 0;
  let trades = 0;
  let lastKeyPrice: Scrap = JOURNAL_FALLBACK_KEY_SCRAP;

  const realize = (sku: string, profit: Scrap): void => {
    realized += profit;
    trades++;
    let s = bySku.get(sku);
    if (!s) bySku.set(sku, (s = { sku, name: '', realizedProfitScrap: 0, trades: 0 }));
    s.realizedProfitScrap += profit;
    s.trades++;
  };

  for (const e of rows) {
    if (validKeyPrice(e.keyPriceScrap)) lastKeyPrice = e.keyPriceScrap;
    const writeoff = e.side === 'writeoff';
    // A write-off receives nothing, whatever a junk row says (zod and the mock refuse a price or fee on one).
    const fee = writeoff ? null : feeOf(e);
    const keys = writeoff ? 0 : finite(e.keys);
    const scrap = writeoff ? 0 : finite(e.scrap);
    const sign = e.side === 'buy' ? 1 : -1;
    const lot: Lot = {
      keys: keys + sign * (fee?.keys ?? 0),
      scrap: scrap + sign * (fee?.scrap ?? 0),
      k: lastKeyPrice,
      id: finite(e.id),
      ts: finite(e.ts),
      venue: typeof e.venue === 'string' ? e.venue : '',
      fee,
      entry: e,
    };
    const name = typeof e.name === 'string' && e.name.trim() ? e.name : names.get(e.sku) ?? e.sku;
    names.set(e.sku, name);

    if (e.side === 'buy') {
      // 0.7.4 (F38): every buy is a lot, whatever sale came before it (that sale waits, below).
      let queue = lots.get(e.sku);
      if (!queue) lots.set(e.sku, (queue = []));
      queue.push(lot);
      continue;
    }
    const buy = lots.get(e.sku)?.shift();
    if (buy !== undefined) {
      // Everything at the sale's key price, so cost + profit = proceeds and a key move never reads as profit.
      const costScrap = valueScrap(buy.keys, buy.scrap, lot.k);
      const profit = writeoff ? -costScrap : pairProfit(lot, buy);
      realize(e.sku, profit);
      const pair: JournalClosedTrade = {
        sellId: lot.id,
        buyId: buy.id,
        kind: writeoff ? 'writeoff' : 'sell',
        sku: e.sku,
        name,
        boughtAt: buy.ts,
        soldAt: lot.ts,
        heldMs: Math.max(0, lot.ts - buy.ts),
        buyVenue: buy.venue,
        sellVenue: lot.venue,
        costScrap,
        proceedsScrap: writeoff ? 0 : profit + costScrap,
        feesScrap:
          buy.fee === null && lot.fee === null
            ? null
            : valueScrap((buy.fee?.keys ?? 0) + (lot.fee?.keys ?? 0), (buy.fee?.scrap ?? 0) + (lot.fee?.scrap ?? 0), lot.k),
        feesKnown: buy.fee !== null && (writeoff || lot.fee !== null),
        profitScrap: profit,
        keyPriceScrap: lot.k,
      };
      closed.push(pair);
      mark?.(buy.entry, 'closed', null);
      mark?.(e, 'closed', pair);
      continue;
    }
    // Oldest first: the rows are in time order. The price as typed (a write-off's is 0).
    const wait: JournalWaitingSale = { id: lot.id, ts: lot.ts, sku: e.sku, name, keys, scrap };
    if (writeoff) wait.writeoff = true;
    waitingSales.push(wait);
    mark?.(e, 'waiting', null);
  }

  const open: JournalPosition[] = [];
  for (const [sku, queue] of lots) {
    if (queue.length === 0) continue;
    // Oldest first: the queue is in time order, so lots[0] is the one the next sale closes.
    // keys/scrap (the cost basis, fee included) ride along so Holdings can judge a sale the way pairProfit will book it.
    const lotsOpen = queue.map((l) => ({ id: l.id, ts: l.ts, costScrap: valueScrap(l.keys, l.scrap, l.k), keys: l.keys, scrap: l.scrap, keyPriceScrap: l.k }));
    open.push({ sku, name: names.get(sku) ?? sku, qty: queue.length, costScrap: lotsOpen.reduce((t, l) => t + l.costScrap, 0), lots: lotsOpen });
    if (mark) for (const l of queue) mark(l.entry, 'open', null);
  }
  open.sort((a, b) => b.costScrap - a.costScrap || a.sku.localeCompare(b.sku));

  const breakdown = [...bySku.values()]
    .map((s) => ({ ...s, name: names.get(s.sku) ?? s.sku }))
    .sort((a, b) => b.realizedProfitScrap - a.realizedProfitScrap || a.sku.localeCompare(b.sku));

  return { realizedProfitScrap: realized, realizedTrades: trades, open, bySku: breakdown, waitingSales, closed };
}

/**
 * The journal's books (J1): FIFO per SKU in journalOrder (a sale or write-off closes the oldest buy dated at or
 * before it, else it waits), open lots at their cost basis (buy fee included), and every closed pair as booked,
 * oldest sale first. One function for the service, the dashboard and the mock.
 */
export function journalSummary(entries: readonly JournalEntry[]): JournalSummary {
  return walkJournal(entries);
}

// ---------------------------------------------------------------------------
// Typical hold (H5): the user's own habit, never a forecast
// ---------------------------------------------------------------------------

/** Median of the finite values; an even count averages the middle two, rounded. null when empty. */
export function medianOf(values: readonly number[]): number | null {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

/**
 * H5: a lookup built once over `closed`. Write-offs are not sales and never count. A SKU with at least
 * TYPICAL_HOLD_MIN_ITEM (3) own sales gets their median (scope 'item'); otherwise the median over every sale when
 * there are at least TYPICAL_HOLD_MIN_ALL (5) (scope 'all'); otherwise null. SKU match is exact (paint kept, as FIFO).
 * stillHeld counts the units of `open` the median leaves out (this SKU's for 'item', every position's for 'all'):
 * open lots are the longer holds by construction, so the texts say how many were not counted.
 */
export function typicalHoldOf(
  closed: readonly JournalClosedTrade[],
  open: readonly Pick<JournalPosition, 'sku' | 'qty'>[],
): (sku: string) => TypicalHold | null {
  const heldBySku = new Map<string, number[]>();
  const all: number[] = [];
  for (const c of Array.isArray(closed) ? closed : []) {
    if (!c || c.kind !== 'sell' || !Number.isFinite(c.heldMs)) continue;
    all.push(c.heldMs);
    let list = heldBySku.get(c.sku);
    if (!list) heldBySku.set(c.sku, (list = []));
    list.push(c.heldMs);
  }
  const openBySku = new Map<string, number>();
  let openAll = 0;
  for (const p of Array.isArray(open) ? open : []) {
    const qty = p && Number.isFinite(p.qty) && p.qty > 0 ? p.qty : 0;
    if (qty === 0) continue;
    openAll += qty;
    openBySku.set(p.sku, (openBySku.get(p.sku) ?? 0) + qty);
  }
  const allMedian = all.length >= TYPICAL_HOLD_MIN_ALL ? medianOf(all) : null;
  const allHold: TypicalHold | null = allMedian === null ? null : { medianMs: allMedian, count: all.length, scope: 'all', stillHeld: openAll };
  const items = new Map<string, TypicalHold>();
  for (const [sku, list] of heldBySku) {
    if (list.length < TYPICAL_HOLD_MIN_ITEM) continue;
    const m = medianOf(list);
    if (m !== null) items.set(sku, { medianMs: m, count: list.length, scope: 'item', stillHeld: openBySku.get(sku) ?? 0 });
  }
  return (sku) => items.get(sku) ?? allHold;
}

/** H5: one SKU's typical hold (typicalHoldOf(closed, open)(sku)); build the lookup once for many SKUs. */
export function typicalHold(
  closed: readonly JournalClosedTrade[],
  open: readonly Pick<JournalPosition, 'sku' | 'qty'>[],
  sku: string,
): TypicalHold | null {
  return typicalHoldOf(closed, open)(sku);
}

/** The row with typicalHold set, or the row itself when the lookup gives null (no key added, so toEqual tests hold). */
export function withTypicalHold<T extends { sku: string }>(row: T, hold: (sku: string) => TypicalHold | null): T & { typicalHold?: TypicalHold } {
  const t = hold(row.sku);
  return t === null ? row : { ...row, typicalHold: t };
}

/** One SKU's closed pairs (exact SKU), newest sale first, for H7's drawer section. */
export function closedTradesOf(closed: readonly JournalClosedTrade[], sku: string): JournalClosedTrade[] {
  return (Array.isArray(closed) ? closed : []).filter((c) => c && c.sku === sku).sort((a, b) => b.soldAt - a.soldAt || b.sellId - a.sellId);
}

// ---------------------------------------------------------------------------
// Ledger CSV (J5)
// ---------------------------------------------------------------------------

/** The journal CSV's header: 0.7.4's 11 columns, then (0.8) each row's fee and FIFO state and a sale's booked pair. */
export const JOURNAL_CSV_COLUMNS: readonly string[] = [
  'id',
  'time',
  'side',
  'venue',
  'sku',
  'name',
  'keys',
  'metal_ref',
  'key_price_ref',
  'value_ref',
  'note',
  // 0.8 (J2, J5): appended so the earlier columns keep their place.
  'fee_keys',
  'fee_metal_ref',
  'fifo',
  'matched_buy_id',
  'cost_ref',
  'proceeds_ref',
  'fees_ref',
  'profit_ref',
  'held_days',
];

/** 0.8 (J5): one journal row with the FIFO state journalSummary gave it. */
export interface JournalLedgerRow {
  entry: JournalEntry;
  /** A buy: 'open' or 'closed'; a sale or write-off: 'closed' or 'waiting'; null for a row FIFO skips. */
  fifo: 'open' | 'closed' | 'waiting' | null;
  /** On a sale or write-off that closed a buy: the pair as booked. */
  closed: JournalClosedTrade | null;
}

/** Every row in journalOrder (FIFO order: at one time a buy before its sale), with its FIFO state. */
export function journalLedger(entries: readonly JournalEntry[]): JournalLedgerRow[] {
  const list = (Array.isArray(entries) ? entries : []).filter((e): e is JournalEntry => e !== null && typeof e === 'object');
  const state = new Map<JournalEntry, { fifo: 'open' | 'closed' | 'waiting'; closed: JournalClosedTrade | null }>();
  walkJournal(list, (e, fifo, closed) => state.set(e, { fifo, closed }));
  return [...list].sort(journalOrder).map((entry) => {
    const s = state.get(entry);
    return { entry, fifo: s?.fifo ?? null, closed: s?.closed ?? null };
  });
}

/** Refined metal when finite, else null (a blank cell). */
function ref(scrap: Scrap | null | undefined): number | null {
  return typeof scrap === 'number' && Number.isFinite(scrap) ? scrapToRef(scrap) : null;
}

function iso(ts: UnixMs | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** One CSV line in JOURNAL_CSV_COLUMNS order; missing values null (blank). */
export function journalCsvCells(r: JournalLedgerRow): (string | number | null)[] {
  const e = r.entry;
  const fee = feeOf(e);
  const c = r.closed;
  return [
    e.id,
    iso(e.ts),
    e.side,
    e.venue,
    e.sku,
    e.name,
    e.keys,
    ref(e.scrap),
    ref(e.keyPriceScrap),
    ref(journalValue(e)),
    e.note ?? null,
    fee ? fee.keys : null,
    fee ? ref(fee.scrap) : null,
    r.fifo ?? '',
    c ? c.buyId : null,
    c ? ref(c.costScrap) : null,
    c ? ref(c.proceedsScrap) : null,
    c ? ref(c.feesScrap) : null,
    c ? ref(c.profitScrap) : null,
    c ? Number((c.heldMs / 86_400_000).toFixed(2)) : null,
  ];
}
