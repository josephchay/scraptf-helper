// The S3 notifier's rules (0.8): one ordered list of what a told look of a bank page is worth a toast for: a watch
// hit (G1), a new flip (S3), a flip a read dropped under Pay up to (G2), a flip back on sale (LC-7) or a watched copy
// on sale again (G3), and a flip whose buy timing turned from Wait to Buy now (G4). Plus every toast and summary
// text, G4's memory of Wait, and the chip a summary opens (G5). Pure: no I/O, no network, no timer; nothing here
// forecasts scrap.tf's prices.
//
// The service's notifyNewBankFlips (domain/bankStock.ts) builds the look, applies the one dedupe and the one cap plus
// summary, and sends; this module only decides and words. A look is a page the user read or saved (R1, R10).

import {
  BANK_STOCK_MORE_BODY,
  bankStockDroppedIntoFlip,
  bankStockMoreNotice,
  bankStockNewFlipNotice,
  bankStockOldSaveNotice,
  bankStockPagePath,
  bankStockSaveAgeNote,
  bankStockSaveAgeText,
} from './bankStock';
import { formatKeysMetal, formatRef, formatScrap } from './currency';
import { BANK_STOCK_NOTIFY_KINDS } from './types';
import type { BankStockNotifyKind, BankStockOpenFilter, BankStockRow, Scrap, ScraptfBank, ScraptfWatch, ScraptfWatchMet, UnixMs } from './types';
import { watchFloorOf, watchFresh, watchHitOf, watchRowSpecialKey, watchTargetsText, watchesFor, type ScraptfWatchIndex } from './watches';
import { withCheckoutGuard } from './checkoutGuard';
import { depthGateOk, minProfitableDepthOf } from './exitRisk';

/** One on-sale row of a told look, and whether it is back on sale (scraptfIsRestock). */
export interface BankStockLookRow {
  row: BankStockRow;
  restock: boolean;
}

/** BankStock.lookOf: the told look of a page. */
export interface BankStockLook {
  bank: ScraptfBank;
  page: string;
  /** The page's newest save (the told look). */
  savedAt: UnixMs;
  /** The save its step diff compares with; null: a first save of the page. */
  previousSavedAt: UnixMs | null;
  rows: readonly BankStockLookRow[];
}

/**
 * Why a watch or G3 toast does not quote a row's sale as a profit although its buy order is known and verified (no
 * buyer and an unconfirmed order are worded by the texts themselves): 'suspect', F5's margin check (few buy orders, no
 * usable reference, a margin over profit.suspectMargin: shown but never notified as a profit); 'low-confidence', the
 * buy side under notifications.minConfidence.
 */
export type BankStockSaleDoubt = 'suspect' | 'low-confidence';

/** One toast a told look is worth (bankStockNotifyCandidates): at most one per row. */
export interface BankStockNotifyCandidate {
  kind: BankStockNotifyKind;
  row: BankStockRow;
  restock: boolean;
  /** The watch behind a 'watch' hit, or the watch that asked for a 'new'/'back' toast of a copy that is no flip; else null. */
  watch: ScraptfWatch | null;
  /** 'watch' only: which target the row met. */
  hit: ScraptfWatchMet | null;
  /** The row passes the flip gates (S3's: flips on, a flip, confidence, profit, a verified order, not suspect). */
  flip: boolean;
  /** A price hit or a G3 toast of a flip whose verified sale is not quoted as a profit (BankStockSaleDoubt); else null. */
  doubt: BankStockSaleDoubt | null;
  /**
   * The toast tells the row as a flip the engine's own "Profit:"/"Watch:" toast would tell: the flip gates passed, a
   * profit hit, or a watch or G3 toast quoting a verified flip with no doubt at the engine's bar for the copy (its
   * watches' lowest profit target, else minProfitScrap). Only such a toast goes to deps.told: a toast of an unconfirmed
   * order, no buyer, no flip, a suspect margin or low confidence leaves the engine free to tell the find with its own
   * toast once it is one (0.7.4 told only verified flips).
   */
  tellsFlip: boolean;
  /** bankStockWatchNotifyKey for a 'watch' hit, else bankStockNotifyKey. */
  dedupeKey: string;
  /** The chip a summary of it opens (G5): watch 'watched'; new and back 'new'; cheaper and timing 'flips'. */
  chip: BankStockOpenFilter;
}

/** G4's memory of one row's Wait streak (bankStock.timing). */
export interface BankStockWaitMemo {
  /** The newest told look that read 'wait'. */
  at: UnixMs;
  /** The first told look of this Wait streak. */
  since: UnixMs;
  /** dropsThisRun when the streak began. */
  drops: number;
  /** The horizon that first Wait named (ScraptfTimingBrief.horizonMs). */
  horizonMs: number | null;
}

/** What bankStockNotifyCandidates reads. */
export interface BankStockNotifyArgs {
  look: BankStockLook;
  /** S3 kinds on: notifications.newOnScraptf and 'import' in notifyKinds(inputKinds) (enabled is the caller's). */
  flips: boolean;
  /** Enabled watches by base; EMPTY_WATCH_INDEX when notifications.watches is off. */
  watches: ScraptfWatchIndex;
  minConfidence: number;
  minProfitScrap: Scrap;
  /** The key price the look's rows were valued at. */
  keyScrap: Scrap;
  /** BankStock.isSuspect: 'flip' = F5's margin or the cost checks; 'cost' = the cost checks only. Called last, at most once per row and kind. */
  suspect(row: BankStockRow, what: 'flip' | 'cost'): boolean;
  /** G4 on: notifications.buyTiming (off by default, D25) with `flips`. Off: no 'timing' candidate. */
  timing: boolean;
  /** G4: this row's Wait memory (bankStockWaitKey in bankStock.timing), else null. */
  waitOf(row: BankStockRow): BankStockWaitMemo | null;
  /** 0.9 (#3): notifications.minProfitableDepth (0 or absent: off). The flip kinds (S3's gates) need at least this many buyers at break-even. */
  minDepth?: number;
  /** 0.9 (#3): BankStock.depthOf: distinct buyers seen in the last 24 h at or above break-even at the row's cost; null: unknown (a set minDepth then holds the row back). */
  depthOf?(row: BankStockRow): number | null;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Keys and the candidate list
// ---------------------------------------------------------------------------

/** S3's dedupe key (unchanged from 0.7.4): one toast per base SKU and bank, whatever the copy or the kind. */
export function bankStockNotifyKey(bank: ScraptfBank, baseSku: string): string {
  return `${bank}|${baseSku}`;
}

/**
 * G1's own dedupe key per watch, in the same bankStock.lastNotified map: exempt from the S3 key; toldBefore holds a watch
 * hit back only for an engine toast at or after the look's save (notifyNewBankFlips).
 */
export function bankStockWatchNotifyKey(bank: ScraptfBank, baseSku: string, watchId: number): string {
  return `${bank}|${baseSku}|w${watchId}`;
}

/** G4's memory key of one copy in one bank (bankStock.timing): `${bank}|${row key}`. */
export function bankStockWaitKey(bank: ScraptfBank, rowKey: string): string {
  return `${bank}|${rowKey}`;
}

/**
 * The candidates' order: the kind's place in BANK_STOCK_NOTIFY_KINDS, then most profit first (null as 0), then name,
 * then key. Among new flips alone this is 0.7.4's newFlips order.
 */
export function bankStockNotifyOrder(a: Pick<BankStockNotifyCandidate, 'kind' | 'row'>, b: Pick<BankStockNotifyCandidate, 'kind' | 'row'>): number {
  return (
    BANK_STOCK_NOTIFY_KINDS.indexOf(a.kind) - BANK_STOCK_NOTIFY_KINDS.indexOf(b.kind) ||
    (b.row.profitScrap ?? 0) - (a.row.profitScrap ?? 0) ||
    a.row.name.localeCompare(b.row.name) ||
    (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0)
  );
}

/**
 * G4: a flip whose timing reads 'buy-now' on this look after 'wait' on the told look just before (its Wait memory's
 * `at` is the look's previous save), and only when the data moved: a drop showed since the streak began, or the first
 * Wait's horizon has passed. Between two reads a copy only ages, and crossing one pooled event time can move the
 * verdict back and forth with nothing new in the copy's data, so aging alone never fires. Not-enough-data, over and
 * no-buyers never fire and never count as wait. 0.9 (#10): nor does a Buy now that depends on save timing (its brief's
 * saveTiming): the user's saves cannot settle that turn.
 */
function timingTurned(a: BankStockNotifyArgs, r: BankStockRow): boolean {
  const { look } = a;
  const t = r.timing;
  if (!a.timing || look.previousSavedAt === null || t === undefined || t.verdict !== 'buy-now' || t.saveTiming !== undefined) return false;
  const w = a.waitOf(r);
  if (w === null || w.at !== look.previousSavedAt) return false;
  return (finite(t.dropsThisRun) && t.dropsThisRun > w.drops) || (w.horizonMs !== null && look.savedAt - w.since >= w.horizonMs);
}

/** The flip kind a row would be told as, in rule order (new, cheaper, back, timing), before the suspect check. */
function flipKindOf(a: BankStockNotifyArgs, r: BankStockRow, restock: boolean): BankStockNotifyKind | null {
  if (r.change === 'new') return restock ? 'back' : 'new';
  if (bankStockDroppedIntoFlip(r)) return 'cheaper';
  return timingTurned(a, r) ? 'timing' : null;
}

/** One row's only candidate: the first rule that applies (watch, then a flip kind, then a watched copy on sale). */
function candidateOf(a: BankStockNotifyArgs, r: BankStockRow, restock: boolean): BankStockNotifyCandidate | null {
  const { look } = a;
  const asked = new Map<'flip' | 'cost', boolean>();
  const suspect = (what: 'flip' | 'cost'): boolean => {
    let v = asked.get(what);
    if (v === undefined) asked.set(what, (v = a.suspect(r, what) === true));
    return v;
  };
  const unverified = r.revenueOrder?.flags.includes('unverified') === true;
  // Today's S3 gates; the suspect check (local reads) last and only when a candidate needs it. 0.9 (#3): with
  // notifications.minProfitableDepth set, also that many buyers at break-even (depthOf is read only then).
  const gates =
    a.flips &&
    r.verdict === 'flip' &&
    (r.confidence ?? 0) >= a.minConfidence &&
    finite(r.profitScrap) &&
    r.profitScrap >= a.minProfitScrap &&
    !unverified &&
    (minProfitableDepthOf(a.minDepth) === 0 || depthGateOk(a.depthOf?.(r) ?? null, a.minDepth));
  let ok: boolean | undefined;
  const flipOk = (): boolean => (ok ??= gates && !suspect('flip'));
  const s3Key = bankStockNotifyKey(look.bank, r.sku);
  const special = watchRowSpecialKey(r);
  // An /items family row prices no copy (0.7.4 F01): no watch is judged on it.
  const ws = a.watches.size > 0 && r.listFamily !== true ? watchesFor(a.watches, r.sku, special) : [];
  const verified = r.revenueScrap !== null && !unverified;
  // A known, verified sale a watch or G3 toast would still not quote as a profit (F5's margin check, minConfidence).
  const doubtOf = (): BankStockSaleDoubt | null =>
    !verified ? null : suspect('flip') ? 'suspect' : (r.confidence ?? 0) < a.minConfidence ? 'low-confidence' : null;
  // Whether a watch or G3 toast tells what the engine's own toast of this copy would (its bar: watchFloorFor, path B).
  const tellsFlipOf = (doubt: BankStockSaleDoubt | null): boolean =>
    flipOk() ||
    (verified && doubt === null && r.verdict === 'flip' && finite(r.profitScrap) && r.profitScrap >= (watchFloorOf(a.watches, r.sku, special) ?? a.minProfitScrap));

  for (const w of ws) {
    const hit = watchHitOf(w, r, { keyScrap: a.keyScrap, minConfidence: a.minConfidence, fresh: watchFresh(w, look.previousSavedAt) });
    if (hit === null) continue;
    // A price that is probably another copy's never meets a price target; a suspect margin never meets a profit one.
    if (hit === 'price' ? suspect('cost') : suspect('flip')) continue;
    // A profit hit already needs a verified order, the confidence and no suspect margin: nothing to doubt.
    const doubt = hit === 'price' ? doubtOf() : null;
    const tellsFlip = hit === 'profit' || tellsFlipOf(doubt);
    return { kind: 'watch', row: r, restock, watch: w, hit, flip: flipOk(), doubt, tellsFlip, dedupeKey: bankStockWatchNotifyKey(look.bank, r.sku, w.id), chip: 'watched' };
  }

  if (gates) {
    const kind = flipKindOf(a, r, restock);
    if (kind !== null && flipOk()) {
      return { kind, row: r, restock, watch: null, hit: null, flip: true, doubt: null, tellsFlip: true, dedupeKey: s3Key, chip: kind === 'cheaper' || kind === 'timing' ? 'flips' : 'new' };
    }
  }

  // G3: a copy the user asked about is on sale again (or for the first time), flip or not.
  if (r.change === 'new') {
    const w = ws.find((x) => x.onRestock);
    if (w !== undefined && !suspect('cost')) {
      // Only a flip's toast quotes the sale; "not a flip" quotes no profit.
      const doubt = r.verdict === 'flip' ? doubtOf() : null;
      return { kind: restock ? 'back' : 'new', row: r, restock, watch: w, hit: null, flip: false, doubt, tellsFlip: tellsFlipOf(doubt), dedupeKey: s3Key, chip: 'new' };
    }
  }
  return null;
}

/**
 * The one ordered candidate list of a told look (bankStockNotifyOrder), at most one per row, gone rows skipped. Per
 * row the first rule that applies:
 * 1. 'watch' (G1): a watch covering the copy hits (watchHitOf: met on a new or cheaper read, or the watch is fresh);
 *    a price hit needs the cost checks clear, a profit hit the flip suspect check clear.
 * 2. With the S3 gates passed (flips on, a flip, minConfidence, minProfitScrap, a verified order, not suspect): 'new'
 *    (diff 'new', never listed before), 'cheaper' (bankStockDroppedIntoFlip, G2), 'back' (diff 'new' and
 *    scraptfIsRestock, LC-7), 'timing' (Wait to Buy now with a drop or the horizon passed, G4, only with `timing`).
 * 3. A watched copy on sale (diff 'new') with "back on sale" asked and the cost checks clear: 'back' or 'new', with
 *    that watch and flip false (G3).
 * A price hit or G3 toast of a verified sale also carries its doubt (F5's margin check, then minConfidence), and every
 * candidate whether it tells a flip the engine would tell (tellsFlip: only those go to deps.told).
 * A look of new, never-seen flips alone gives 0.7.4's rows in 0.7.4's order.
 */
export function bankStockNotifyCandidates(a: BankStockNotifyArgs): BankStockNotifyCandidate[] {
  const out: BankStockNotifyCandidate[] = [];
  for (const { row, restock } of a.look.rows) {
    if (row.change === 'gone') continue;
    const c = candidateOf(a, row, restock);
    if (c !== null) out.push(c);
  }
  return out.sort(bankStockNotifyOrder);
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

/**
 * G4's note on a toast of a flip whose own timing still reads Wait (an estimate from the user's saves), for a copy that
 * already dropped in its current run. Part of the opt-in G4 (notifications.buyTiming, off by default, D25): with it
 * off, every toast's text is 0.7.4's.
 */
export const BANK_STOCK_WAIT_NOTE = '; your saves say it may drop again (Wait)';
/** The same note for a copy that has not dropped in its current run (a new or restocked listing): no "again". */
export const BANK_STOCK_WAIT_NOTE_FIRST = '; your saves say it may drop (Wait)';

function keyOf(K: Scrap | null): Scrap | null {
  return finite(K) && K > 0 ? K : null;
}

function buyerOf(r: Pick<BankStockRow, 'revenueOrder'>): string {
  const o = r.revenueOrder;
  return o ? o.userName || o.steamid : 'a buyer';
}

/**
 * The wait note, only with G4 on (`timing`): the row's timing is joined whatever the switch says. "again" only after a
 * drop in the copy's current run (dropsThisRun): a never-seen listing reads Wait on the bank's pooled saves alone.
 */
function waitNoteOf(r: Pick<BankStockRow, 'timing'>, timing: boolean): string {
  const t = r.timing;
  if (!timing || t?.verdict !== 'wait') return '';
  return finite(t.dropsThisRun) && t.dropsThisRun > 0 ? BANK_STOCK_WAIT_NOTE : BANK_STOCK_WAIT_NOTE_FIRST;
}

function unverifiedOf(r: Pick<BankStockRow, 'revenueOrder'>): boolean {
  return r.revenueOrder?.flags.includes('unverified') === true;
}

/** "sells for <revenue> to <buyer>, +<profit>" (a loss reads "-<loss>"), money at K when known. */
export function bankStockSaleText(r: Pick<BankStockRow, 'revenueScrap' | 'revenueOrder' | 'profitScrap'>, K: Scrap | null): string {
  const key = keyOf(K);
  const p = r.profitScrap;
  return `sells for ${formatScrap(r.revenueScrap, key)} to ${buyerOf(r)}, ${finite(p) && p < 0 ? '' : '+'}${formatScrap(p, key)}`;
}

/**
 * G2: "Cheaper on scrap.tf (<Bank>): <name>" / "<prev> → <cost>, now under Pay up to <max>; sells for …", plus the
 * wait note when `timing` (G4 on) and the row's timing reads Wait.
 */
export function bankStockDroppedFlipNotice(label: string, r: BankStockRow, K: Scrap | null, savedAgoMs?: number | null, timing = false): { title: string; body: string } {
  const key = keyOf(K);
  return {
    title: `Cheaper on scrap.tf (${label}): ${r.name}`,
    body: `${formatScrap(r.previousCostScrap, key)} → ${formatScrap(r.costScrap, key)}, now under Pay up to ${formatScrap(r.maxCostScrap, key)}; ${bankStockSaleText(r, K)}${waitNoteOf(r, timing)}${bankStockSaveAgeNote(savedAgoMs)}`,
  };
}

/**
 * LC-7: "Back on scrap.tf (<Bank>): <name>" / "<cost>, sells for …; on sale again in your saves". Never "just". The
 * wait note only when `timing` (G4 on).
 */
export function bankStockBackNotice(label: string, r: BankStockRow, K: Scrap | null, savedAgoMs?: number | null, timing = false): { title: string; body: string } {
  return {
    title: `Back on scrap.tf (${label}): ${r.name}`,
    body: `${formatScrap(r.costScrap, keyOf(K))}, ${bankStockSaleText(r, K)}; on sale again in your saves${waitNoteOf(r, timing)}${bankStockSaveAgeNote(savedAgoMs)}`,
  };
}

/**
 * Why a verified sale is not quoted as a profit (BankStockSaleDoubt), in place of the sale: F5's guard says such a
 * margin is shown but never notified, and a buy side under the confidence bar is no profit to act on.
 */
export function bankStockSaleDoubtText(doubt: BankStockSaleDoubt): string {
  return doubt === 'suspect'
    ? 'a suspect margin (few buy orders, no usable reference), so no profit is quoted'
    : 'its buy side is under your minimum confidence, so no profit is quoted';
}

/**
 * G3: a watched copy on sale again (restock) or for the first time, flip or not: "Back on scrap.tf (<Bank>): <name>"
 * or "New on …" / "<cost>[, on sale again in your saves]; <state>; you watch it (<targets>)". The state: no buyer yet,
 * an unconfirmed buy order, the sale for a flip (or, with a `doubt`, why its profit is not quoted), else "not a flip
 * (sells for …, Pay up to …)".
 */
export function bankStockWatchedOnSaleNotice(
  label: string,
  r: BankStockRow,
  w: Pick<ScraptfWatch, 'maxCostKeys' | 'maxCostScrap' | 'minProfitScrap' | 'onRestock'>,
  restock: boolean,
  K: Scrap | null,
  savedAgoMs?: number | null,
  doubt: BankStockSaleDoubt | null = null,
): { title: string; body: string } {
  const key = keyOf(K);
  const state =
    r.revenueScrap === null
      ? 'no backpack.tf buyer yet'
      : unverifiedOf(r)
        ? 'its buy order is unconfirmed'
        : r.verdict === 'flip'
          ? doubt !== null
            ? bankStockSaleDoubtText(doubt)
            : bankStockSaleText(r, K)
          : `not a flip (sells for ${formatScrap(r.revenueScrap, key)}${r.maxCostScrap !== null ? `, Pay up to ${formatScrap(r.maxCostScrap, key)}` : ''})`;
  return {
    title: `${restock ? 'Back' : 'New'} on scrap.tf (${label}): ${r.name}`,
    body: `${formatScrap(r.costScrap, key)}${restock ? ', on sale again in your saves' : ''}; ${state}; you watch it (${watchTargetsText(w, K)})${bankStockSaveAgeNote(savedAgoMs)}`,
  };
}

/**
 * G1: "Watch (<Bank>): <name>". A price hit: "<cost>, at or under your ≤ <target as typed>", the key price used when
 * the target and the cost differ in keys, then the sale (or why there is none, or with a `doubt` why its profit is
 * not quoted). A profit hit: "<cost>, sells for …: at or over your +<target>".
 */
export function bankStockWatchNotice(
  label: string,
  r: BankStockRow,
  w: Pick<ScraptfWatch, 'maxCostKeys' | 'maxCostScrap' | 'minProfitScrap'>,
  hit: ScraptfWatchMet,
  restock: boolean,
  K: Scrap | null,
  savedAgoMs?: number | null,
  doubt: BankStockSaleDoubt | null = null,
): { title: string; body: string } {
  const key = keyOf(K);
  const cost = formatScrap(r.costScrap, key);
  const back = restock ? ', on sale again in your saves' : '';
  const age = bankStockSaveAgeNote(savedAgoMs);
  const title = `Watch (${label}): ${r.name}`;
  if (hit === 'profit') {
    return { title, body: `${cost}, ${bankStockSaleText(r, K)}: at or over your +${formatScrap(w.minProfitScrap, key)}${back}${age}` };
  }
  // E.1-9: a keys target against a metal price (or the reverse) is compared at today's key price, and says so.
  const unit = key !== null && (w.maxCostKeys > 0) !== (r.costKeys > 0) ? `; compared at 1 key = ${formatRef(key)}` : '';
  const tail =
    r.revenueScrap === null
      ? 'no backpack.tf buyer yet'
      : unverifiedOf(r)
        ? 'its buy order is unconfirmed'
        : doubt !== null
          ? bankStockSaleDoubtText(doubt)
          : bankStockSaleText(r, K);
  return { title, body: `${cost}, at or under your ≤ ${formatKeysMetal(w.maxCostKeys, w.maxCostScrap ?? 0)}${unit}${back}; ${tail}${age}` };
}

/** G4: "Buy now (<Bank>): <name>" / "…; your saves said wait on the read before, now buy now (an estimate …)". */
export function bankStockBuyNowNotice(label: string, r: BankStockRow, K: Scrap | null, savedAgoMs?: number | null): { title: string; body: string } {
  return {
    title: `Buy now (${label}): ${r.name}`,
    body: `${formatScrap(r.costScrap, keyOf(K))}, ${bankStockSaleText(r, K)}; your saves said wait on the read before, now buy now (an estimate from your saves, not a forecast)${bankStockSaveAgeNote(savedAgoMs)}`,
  };
}

/**
 * One candidate's toast, by kind: a watch hit (bankStockWatchNotice); a new or back flip (bankStockNewFlipNotice with
 * the wait note, bankStockBackNotice) or a watched copy that is no flip (bankStockWatchedOnSaleNotice); cheaper
 * (bankStockDroppedFlipNotice); timing (bankStockBuyNowNotice). The wait note only with `timing` (G4 on: the
 * notifier's timingOn); off, the default, a new flip's toast is 0.7.4's text. A watch or watched-copy toast with a
 * doubt (c.doubt: F5's margin check, the confidence bar) words why no profit is quoted instead of the sale.
 */
export function bankStockNoticeOf(c: BankStockNotifyCandidate, label: string, K: Scrap | null, savedAgoMs: number | null, timing = false): { title: string; body: string } {
  const r = c.row;
  switch (c.kind) {
    case 'watch':
      if (c.watch !== null && c.hit !== null) return bankStockWatchNotice(label, r, c.watch, c.hit, c.restock, K, savedAgoMs, c.doubt ?? null);
      return bankStockNewFlipNotice(label, r, K, savedAgoMs, waitNoteOf(r, timing) || null);
    case 'new':
      if (!c.flip && c.watch !== null) return bankStockWatchedOnSaleNotice(label, r, c.watch, false, K, savedAgoMs, c.doubt ?? null);
      return bankStockNewFlipNotice(label, r, K, savedAgoMs, waitNoteOf(r, timing) || null);
    case 'back':
      if (!c.flip && c.watch !== null) return bankStockWatchedOnSaleNotice(label, r, c.watch, true, K, savedAgoMs, c.doubt ?? null);
      return bankStockBackNotice(label, r, K, savedAgoMs, timing);
    case 'cheaper':
      return bankStockDroppedFlipNotice(label, r, K, savedAgoMs, timing);
    case 'timing':
      return bankStockBuyNowNotice(label, r, K, savedAgoMs);
  }
}

/**
 * 0.9 (#9): bankStockNoticeOf, with the checkout guard's short sentence on the body of a toast that suggests buying (a
 * watch hit or a G4 "Buy now" that tells a flip: c.tellsFlip, with no doubt) when it still fits
 * CHECKOUT_GUARD_TOAST_BODY_MAX (withCheckoutGuard). Every other toast is bankStockNoticeOf's, word for word, and the
 * title never changes.
 */
export function bankStockNoticeWithGuard(c: BankStockNotifyCandidate, label: string, K: Scrap | null, savedAgoMs: number | null, timing = false): { title: string; body: string } {
  const n = bankStockNoticeOf(c, label, K, savedAgoMs, timing);
  const buys = c.tellsFlip && (c.doubt ?? null) === null && ((c.kind === 'watch' && c.watch !== null && c.hit !== null) || c.kind === 'timing');
  return buys ? { ...n, body: withCheckoutGuard(n.body) } : n;
}

const WORDS = ['new', 'cheaper', 'back on sale', 'buy now', 'watched'] as const;

function wordOf(c: Pick<BankStockNotifyCandidate, 'kind' | 'flip'>): (typeof WORDS)[number] {
  if (c.kind === 'watch' || ((c.kind === 'new' || c.kind === 'back') && !c.flip)) return 'watched';
  return c.kind === 'new' ? 'new' : c.kind === 'cheaper' ? 'cheaper' : c.kind === 'back' ? 'back on sale' : 'buy now';
}

/**
 * A summary's counts in a fixed order (new, cheaper, back on sale, buy now, watched): "2 new, 1 cheaper, 1 watched".
 * A watch hit and a watched copy that is no flip count as watched.
 */
export function bankStockNotifyWords(cs: readonly Pick<BankStockNotifyCandidate, 'kind' | 'flip'>[]): string {
  const counts = new Map<string, number>();
  for (const c of cs) {
    const w = wordOf(c);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return WORDS.filter((w) => (counts.get(w) ?? 0) > 0)
    .map((w) => `${counts.get(w)} ${w}`)
    .join(', ');
}

function allNewFlips(cs: readonly Pick<BankStockNotifyCandidate, 'kind' | 'flip'>[]): boolean {
  return cs.every((c) => c.kind === 'new' && c.flip);
}

/**
 * The one summary after BANK_STOCK_MAX_NOTIFICATIONS: 0.7.4's "+N more new flips on scrap.tf/buy/hats" when every one
 * left is a new flip, else "+N more on scrap.tf/buy/hats: 2 new, 1 watched"; body BANK_STOCK_MORE_BODY.
 */
export function bankStockSummaryNotice(rest: readonly Pick<BankStockNotifyCandidate, 'kind' | 'flip'>[], url: string): { title: string; body: string } {
  if (allNewFlips(rest)) return { title: bankStockMoreNotice(rest.length, url), body: BANK_STOCK_MORE_BODY };
  return { title: `+${rest.length} more on ${bankStockPagePath(url)}: ${bankStockNotifyWords(rest)}`, body: BANK_STOCK_MORE_BODY };
}

/**
 * The one dated summary of a save older than profit.inputStaleMs: 0.7.4's bankStockOldSaveNotice when every one due is
 * a new flip, else "3 items in your save of scrap.tf/buy/hats from 2 d ago: 2 new, 1 watched" with its body.
 */
export function bankStockOldSaveSummary(due: readonly Pick<BankStockNotifyCandidate, 'kind' | 'flip'>[], url: string, savedAgoMs: number): { title: string; body: string } {
  const n = due.length;
  const old = bankStockOldSaveNotice(n, url, savedAgoMs);
  if (allNewFlips(due)) return old;
  return {
    title: `${n} ${n === 1 ? 'item' : 'items'} in your save of ${bankStockPagePath(url)} from ${bankStockSaveAgeText(savedAgoMs)} ago: ${bankStockNotifyWords(due)}`,
    body: old.body,
  };
}

/**
 * G5: the bank stock chip a summary opens: the candidates' common chip, else 'flips' when every one is a flip, else
 * 'watched'. ('new' with none, as 0.7.4's summaries of new flips.)
 */
export function bankStockSummaryChip(cs: readonly Pick<BankStockNotifyCandidate, 'chip' | 'flip'>[]): BankStockOpenFilter {
  const first = cs[0];
  if (first === undefined) return 'new';
  if (cs.every((c) => c.chip === first.chip)) return first.chip;
  return cs.every((c) => c.flip) ? 'flips' : 'watched';
}

// ---------------------------------------------------------------------------
// G4's memory of Wait (repo meta bankStock.timing, written only while notifications.buyTiming is on)
// ---------------------------------------------------------------------------

/** A Wait memory older than this (by its newest told look) is dropped. */
export const BANK_STOCK_TIMING_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** At most this many Wait memories; past it the oldest go. */
export const BANK_STOCK_TIMING_MAX = 5000;

/**
 * The stored Wait memories (JSON `{ "<bank>|<row key>": { at, since, drops, horizonMs } }`), read tolerantly: an
 * entry without a finite at, since and drops is dropped (a bad horizon reads null), and anything else bad gives none.
 */
export function bankStockTimingParse(raw: string | null): Map<string, BankStockWaitMemo> {
  const out = new Map<string, BankStockWaitMemo>();
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
      const e = v as Record<string, unknown>;
      if (!finite(e.at) || !finite(e.since) || !finite(e.drops)) continue;
      out.set(k, { at: e.at, since: e.since, drops: e.drops, horizonMs: finite(e.horizonMs) ? e.horizonMs : null });
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * The Wait memories after a told look (called after its candidates were built from `prev`). A row without timing is
 * left alone. A 'wait' row goes on its streak when its memory's `at` is the look's previous save (only `at` moves),
 * else starts one at this look (since, drops and horizon from its timing); the same look told again changes nothing.
 * Any other verdict ends the streak. Memories older than BANK_STOCK_TIMING_MAX_AGE_MS or in the future are dropped,
 * then the oldest past BANK_STOCK_TIMING_MAX. Null when nothing changed (no write).
 */
export function bankStockTimingNext(
  prev: ReadonlyMap<string, BankStockWaitMemo>,
  look: Pick<BankStockLook, 'bank' | 'savedAt' | 'previousSavedAt' | 'rows'>,
  now: UnixMs,
): Map<string, BankStockWaitMemo> | null {
  const next = new Map(prev);
  let changed = false;
  for (const { row: r } of look.rows) {
    const t = r.timing;
    if (t === undefined) continue;
    const key = bankStockWaitKey(look.bank, r.key);
    const e = next.get(key);
    if (t.verdict !== 'wait') {
      if (e !== undefined) {
        next.delete(key);
        changed = true;
      }
      continue;
    }
    if (e !== undefined && e.at === look.savedAt) continue;
    const goesOn = e !== undefined && look.previousSavedAt !== null && e.at === look.previousSavedAt;
    next.set(
      key,
      goesOn
        ? { ...e, at: look.savedAt }
        : { at: look.savedAt, since: look.savedAt, drops: finite(t.dropsThisRun) ? t.dropsThisRun : 0, horizonMs: finite(t.horizonMs) ? t.horizonMs : null },
    );
    changed = true;
  }
  for (const [k, e] of next) {
    if (e.at < now - BANK_STOCK_TIMING_MAX_AGE_MS || e.at > now) {
      next.delete(k);
      changed = true;
    }
  }
  if (next.size > BANK_STOCK_TIMING_MAX) {
    const oldest = [...next].sort((x, y) => x[1].at - y[1].at || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    for (const [k] of oldest.slice(0, next.size - BANK_STOCK_TIMING_MAX)) next.delete(k);
    changed = true;
  }
  return changed ? next : null;
}
