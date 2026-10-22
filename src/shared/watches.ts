// scrap.tf watches (0.8, G1/G3): the user's own targets for an item, judged on the user's own reads and saves of
// scrap.tf pages only (R1, R10). Shared by the service (the S3 notifier, the bank stock rows, the engine's profit bar,
// 'watches.*'), the dashboard and the browser mock, so all three match a copy, value a target and word a watch alike.
// Pure: no I/O, no network, no timer.

import { bankStockIsOwnCopy, bankStockTargetOf } from './bankStock';
import { formatKeysMetal, formatScrap, valueScrap } from './currency';
import { isValidSku } from './sku';
import type {
  BankStockRow,
  BankStockRowWatch,
  Scrap,
  ScraptfBank,
  ScraptfWatch,
  ScraptfWatchInput,
  ScraptfWatchMet,
  ScraptfWatchNow,
  ScraptfWatchView,
  ScraptfWatchWrite,
  UnixMs,
} from './types';

/**
 * At most this many watches: watched bases join core's watched list (the snapshot job, the feed's kept sell listings and
 * the 30-min PriceDB bulk refresh, 100 bases per request), whose cadences and budgets are fixed.
 */
export const WATCHES_MAX = 200;
/** A watch's stored item name: at most this many characters. */
export const WATCH_NAME_MAX = 300;
/** As 'scraptf.itemHistory''s special: a lookup key only. */
export const WATCH_SPECIAL_MAX = 2000;
/**
 * The copy index's "every copy" stand-in (V15 scraptf_watches_copy and Repo's findWatch: IFNULL(special_key, '*')).
 * A special key is '' or JSON (bankStockSpecialKey), never this; as a copy it would find the any-copy watch as "the
 * same copy" and turn it into a watch that covers nothing, so the zod, the mock, watchWriteOf and the repo refuse it.
 */
export const WATCH_ANY_COPY_SENTINEL = '*';
/** Price and profit target caps (zod, shared with the mock): keys as typed, metal and profit whole scrap. */
export const WATCH_MAX_KEYS = 10_000;
export const WATCH_MAX_SCRAP = 1_000_000_000;
/** Fixed refusals, worded alike by the service and the mock. */
export const WATCHES_FULL = `You can keep at most ${WATCHES_MAX} watches. Remove one first.`;
export const WATCH_EMPTY = 'Set a price, a profit or "Tell me when it is back" first.';
export const WATCH_ZERO_PRICE = 'A price target must be more than 0.';
export const WATCH_NOT_AN_ITEM = 'Not an item SKU.';
/** 'watches.upsert''s special of WATCH_ANY_COPY_SENTINEL (every copy is copies 'any'). */
export const WATCH_NOT_A_COPY = "Not a copy key (for every copy, send copies 'any').";
export const WATCH_GONE = 'That watch no longer exists.';
export const WATCH_COPY_TAKEN = 'You already watch that copy; edit that watch instead.';

/** The enabled watches by base SKU (watchIndexOf): a copy's own watches first, then any-copy ones, each by id. */
export type ScraptfWatchIndex = ReadonlyMap<string, readonly ScraptfWatch[]>;
/** No watch at all (notifications.watches off, a failed read, no watch yet). */
export const EMPTY_WATCH_INDEX: ScraptfWatchIndex = new Map();
/** One page's newest-save rows of watched bases (BankStock.watchRows; the mock builds the same). */
export interface WatchPageRows {
  bank: ScraptfBank;
  savedAt: UnixMs;
  rows: readonly BankStockRow[];
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A row's copy: its bank_stock special key, the part of `key` (bankStockKey, `${sku}|${specialKey}`) after the SKU. */
export function watchRowSpecialKey(r: Pick<BankStockRow, 'sku' | 'key'>): string {
  return r.key.slice(r.sku.length + 1);
}

/**
 * Whether a watch covers a copy: never when paused or of another base; an any-copy watch (specialKey null) covers
 * every copy of its base; a copy watch covers its copy as bankStockIsOwnCopy reads it (a sheen or killstreaker aside).
 */
export function watchCovers(w: Pick<ScraptfWatch, 'enabled' | 'sku' | 'specialKey'>, copy: { sku: string; specialKey: string }): boolean {
  if (!w.enabled || copy.sku !== w.sku) return false;
  if (w.specialKey === null) return true;
  return bankStockIsOwnCopy(copy, { base: w.sku, specialKey: w.specialKey });
}

/**
 * The enabled watches by base SKU. Within a base, copy watches (specialKey set) come before any-copy ones, then by
 * ascending id, so a copy's own watch is the one joined to its row and told first.
 */
export function watchIndexOf(watches: readonly ScraptfWatch[]): ScraptfWatchIndex {
  const out = new Map<string, ScraptfWatch[]>();
  for (const w of watches) {
    if (!w.enabled) continue;
    let g = out.get(w.sku);
    if (!g) out.set(w.sku, (g = []));
    g.push(w);
  }
  for (const g of out.values()) g.sort((a, b) => Number(a.specialKey === null) - Number(b.specialKey === null) || a.id - b.id);
  return out;
}

/** The enabled watches covering one copy (watchCovers), in the index's order. */
export function watchesFor(index: ScraptfWatchIndex, sku: string, specialKey: string): ScraptfWatch[] {
  return (index.get(sku) ?? []).filter((w) => watchCovers(w, { sku, specialKey }));
}

/** A watch's price target at `keyScrap` (raw keys + metal valued as a row's cost is); null without a price target. */
export function watchTargetScrap(w: Pick<ScraptfWatch, 'maxCostKeys' | 'maxCostScrap'>, keyScrap: Scrap): Scrap | null {
  if (w.maxCostScrap === null) return null;
  return valueScrap(finite(w.maxCostKeys) ? w.maxCostKeys : 0, w.maxCostScrap, keyScrap);
}

/** What watchMetOf reads of a row. */
export type WatchMetRow = Pick<BankStockRow, 'change' | 'listFamily' | 'costScrap' | 'profitScrap' | 'confidence' | 'revenueOrder'>;

/**
 * What a row meets of a watch now: 'price' when its cost is at or under the price target (both at `keyScrap`), else
 * 'profit' when its own flipProfit figure (BankStockRow.profitScrap) is at or over the profit target with the buy side's
 * confidence at least `minConfidence` and its buy order not flagged 'unverified'; else null. Null too for a paused watch,
 * a gone row and an /items family row (0.7.4 F01: its price is no copy's cost). Never computes a profit of its own.
 */
export function watchMetOf(w: ScraptfWatch, r: WatchMetRow, keyScrap: Scrap, minConfidence: number): ScraptfWatchMet | null {
  if (!w.enabled || r.change === 'gone' || r.listFamily === true) return null;
  const target = watchTargetScrap(w, keyScrap);
  if (target !== null && finite(r.costScrap) && r.costScrap <= target) return 'price';
  if (
    w.minProfitScrap !== null &&
    finite(r.profitScrap) &&
    r.profitScrap >= w.minProfitScrap &&
    (r.confidence ?? 0) >= minConfidence &&
    r.revenueOrder?.flags.includes('unverified') !== true
  ) {
    return 'profit';
  }
  return null;
}

/**
 * G1's stateless edge: a watch is fresh for a page when the page has no previous save (a first save) or the watch was
 * created or edited after it, so its next read judges it afresh.
 */
export function watchFresh(w: Pick<ScraptfWatch, 'updatedAt'>, previousSavedAt: UnixMs | null): boolean {
  return previousSavedAt === null || w.updatedAt > previousSavedAt;
}

/**
 * A watch hit on a read (G1): what the row meets (watchMetOf), but only when the read's step diff made it 'new' or
 * 'cheaper' or the watch is fresh (watchFresh). A same-price re-read, a pricier price and key-price drift alone never
 * hit (diffBankStock reads equal raw prices as unchanged).
 */
export function watchHitOf(w: ScraptfWatch, r: WatchMetRow, a: { keyScrap: Scrap; minConfidence: number; fresh: boolean }): ScraptfWatchMet | null {
  if (r.change !== 'new' && r.change !== 'cheaper' && !a.fresh) return null;
  return watchMetOf(w, r, a.keyScrap, a.minConfidence);
}

/**
 * BankStockRow.watch: the first enabled watch covering the row's copy (a copy's own watch before an any-copy one),
 * with its price target at `keyScrap`, what the row meets now (null for a gone row) and how far over the price
 * target its cost is (null without a price target or for a gone row). Undefined when no watch covers it.
 */
export function watchJoinOf(index: ScraptfWatchIndex, r: BankStockRow, keyScrap: Scrap, minConfidence: number): BankStockRowWatch | undefined {
  const w = watchesFor(index, r.sku, watchRowSpecialKey(r))[0];
  if (!w) return undefined;
  const target = watchTargetScrap(w, keyScrap);
  const gone = r.change === 'gone';
  return {
    id: w.id,
    anyCopy: w.specialKey === null,
    maxCostScrap: target,
    minProfitScrap: w.minProfitScrap,
    onRestock: w.onRestock,
    met: gone ? null : watchMetOf(w, r, keyScrap, minConfidence),
    overTargetScrap: target === null || gone ? null : r.costScrap - target,
  };
}

/**
 * ScraptfWatchView.now: the cheapest copy the watch covers on sale on the given newest saves (gone and /items family
 * rows left out); a tie goes to the newer save, then the lower row key. A paused watch is judged as if it were on, so
 * the list still shows where it stands (it notifies nothing: watchIndexOf leaves it out). Null when none is on sale.
 */
export function watchNowOf(w: ScraptfWatch, pages: readonly WatchPageRows[], keyScrap: Scrap, minConfidence: number): ScraptfWatchNow | null {
  const on = w.enabled ? w : { ...w, enabled: true };
  let best: { p: WatchPageRows; r: BankStockRow } | null = null;
  for (const p of pages) {
    for (const r of p.rows) {
      if (r.change === 'gone' || r.listFamily === true || !finite(r.costScrap)) continue;
      if (!watchCovers(on, { sku: r.sku, specialKey: watchRowSpecialKey(r) })) continue;
      if (
        best === null ||
        r.costScrap < best.r.costScrap ||
        (r.costScrap === best.r.costScrap && (p.savedAt > best.p.savedAt || (p.savedAt === best.p.savedAt && r.key < best.r.key)))
      ) {
        best = { p, r };
      }
    }
  }
  if (best === null) return null;
  const { p, r } = best;
  const target = watchTargetScrap(on, keyScrap);
  return {
    bank: p.bank,
    savedAt: p.savedAt,
    costKeys: r.costKeys,
    costScrapRaw: r.costScrapRaw,
    costScrap: r.costScrap,
    revenueScrap: r.revenueScrap,
    profitScrap: r.profitScrap,
    verdict: r.verdict,
    met: watchMetOf(on, r, keyScrap, minConfidence),
    overTargetScrap: target === null ? null : r.costScrap - target,
  };
}

/** 'watches.list': every watch (paused ones too, their `now` still computed: watchNowOf), by name, then id. */
export function watchViewsOf(watches: readonly ScraptfWatch[], pages: readonly WatchPageRows[], keyScrap: Scrap, minConfidence: number): ScraptfWatchView[] {
  return watches
    .map((w) => ({ ...w, now: watchNowOf(w, pages, keyScrap, minConfidence) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/**
 * G1 path B (engine): the profit bar the user's watches set for one copy of a base, the lowest profit target among
 * the enabled watches covering it (watchesFor); null when none of them has a profit target.
 */
export function watchFloorOf(index: ScraptfWatchIndex, baseSku: string, copyKey: string): Scrap | null {
  let floor: Scrap | null = null;
  for (const w of watchesFor(index, baseSku, copyKey)) {
    if (w.minProfitScrap !== null && finite(w.minProfitScrap) && (floor === null || w.minProfitScrap < floor)) floor = w.minProfitScrap;
  }
  return floor;
}

/**
 * Why a watch cannot be saved, checked in order: WATCH_EMPTY with no price target, no profit target and no "back on
 * sale"; WATCH_ZERO_PRICE for a price target of 0 metal and no keys. Null: it can be saved.
 */
export function watchInputProblem(w: Pick<ScraptfWatchWrite, 'maxCostKeys' | 'maxCostScrap' | 'minProfitScrap' | 'onRestock'>): string | null {
  if (w.maxCostScrap === null && w.minProfitScrap === null && !w.onRestock) return WATCH_EMPTY;
  if (w.maxCostScrap === 0 && !(w.maxCostKeys > 0)) return WATCH_ZERO_PRICE;
  return null;
}

/**
 * 'watches.upsert' params as the repo's write: the SKU's base (bankStockTargetOf; WATCH_NOT_AN_ITEM for text that is
 * no SKU, as the service's zod reads it: trimmed, lower case, isValidSku) and copy ('any': every copy; else `special`,
 * else the existing watch's copy on an update that leaves the copies out, else the SKU's own). Targets and switches
 * the input leaves out keep the existing watch's values (defaults: no targets, back on sale off, on); keys count only
 * with a price target. The name: the input's, else the existing one, else the app's item name for the base, else the
 * base SKU, cut to WATCH_NAME_MAX. Throws WATCH_NOT_A_COPY for a copy of WATCH_ANY_COPY_SENTINEL, then
 * watchInputProblem's text.
 */
export function watchWriteOf(input: ScraptfWatchInput, existing: ScraptfWatch | null, nameOf: (baseSku: string) => string | null | undefined): ScraptfWatchWrite {
  const text = typeof input.sku === 'string' ? input.sku.trim().toLowerCase() : '';
  const target = isValidSku(text) ? bankStockTargetOf(text) : null;
  if (target === null) throw new Error(WATCH_NOT_AN_ITEM);
  const sku = target.base;
  const keepCopy = input.copies === undefined && existing !== null && existing.sku === sku;
  const specialKey =
    input.copies === 'any' ? null : typeof input.special === 'string' ? input.special : keepCopy ? existing.specialKey : target.specialKey;
  if (specialKey === WATCH_ANY_COPY_SENTINEL) throw new Error(WATCH_NOT_A_COPY);
  const name = (input.name?.trim() || existing?.name || nameOf(sku)?.trim() || sku).slice(0, WATCH_NAME_MAX);
  const maxCostScrap = input.maxCostScrap !== undefined ? input.maxCostScrap : (existing?.maxCostScrap ?? null);
  const maxCostKeys = maxCostScrap === null ? 0 : (input.maxCostKeys ?? existing?.maxCostKeys ?? 0);
  const write: ScraptfWatchWrite = {
    ...(existing !== null ? { id: existing.id } : {}),
    sku,
    specialKey,
    name,
    maxCostKeys,
    maxCostScrap,
    minProfitScrap: input.minProfitScrap !== undefined ? input.minProfitScrap : (existing?.minProfitScrap ?? null),
    onRestock: input.onRestock ?? existing?.onRestock ?? false,
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
  const problem = watchInputProblem(write);
  if (problem !== null) throw new Error(problem);
  return write;
}

/** 'watches.restore' params (Undo of a removal): the removed watch as 'watches.upsert' params, with the id and times it had. */
export interface ScraptfWatchRestore extends ScraptfWatchInput {
  id: number;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

/**
 * Undo of a removal ('watches.restore', the service and the mock alike): the removed watch back as it was, with its id
 * and its created and updated times, so it is that same watch again, not a new one. Its notification dedupe is kept per
 * watch id (bankStockWatchNotifyKey) and still holds, and it is not judged afresh on the next read (watchFresh reads
 * updatedAt), so a same-price read tells nothing, as before the removal. The write is watchWriteOf's with no existing
 * watch (its refusals included); times are whole, at least 0 and never after `now`, and created never after updated.
 * The caller returns a watch that still has the id (a second Undo), refuses WATCH_COPY_TAKEN when the copy has been
 * watched again since, and WATCHES_FULL at the cap.
 */
export function watchRestoreOf(
  input: ScraptfWatchRestore,
  nameOf: (baseSku: string) => string | null | undefined,
  now: UnixMs,
): { write: ScraptfWatchWrite & { id: number }; createdAt: UnixMs; updatedAt: UnixMs } {
  const at = (v: unknown): UnixMs => (finite(v) && v >= 0 ? Math.min(Math.floor(v), now) : now);
  const updatedAt = at(input.updatedAt);
  const { createdAt: _c, updatedAt: _u, id, ...rest } = input;
  return { write: { ...watchWriteOf(rest, null, nameOf), id }, createdAt: Math.min(at(input.createdAt), updatedAt), updatedAt };
}

/**
 * A watch's targets in words, the set ones joined with ' · ': "≤ 2 keys 5.11 ref" (as typed), "profit ≥ 1.33 ref" (at
 * `keyScrap` when known) and "back on sale". '' when none is set.
 */
export function watchTargetsText(w: Pick<ScraptfWatch, 'maxCostKeys' | 'maxCostScrap' | 'minProfitScrap' | 'onRestock'>, keyScrap: Scrap | null): string {
  const key = finite(keyScrap) && keyScrap > 0 ? keyScrap : null;
  const parts: string[] = [];
  if (w.maxCostScrap !== null) parts.push(`≤ ${formatKeysMetal(finite(w.maxCostKeys) ? w.maxCostKeys : 0, w.maxCostScrap)}`);
  if (w.minProfitScrap !== null) parts.push(`profit ≥ ${formatScrap(w.minProfitScrap, key)}`);
  if (w.onRestock) parts.push('back on sale');
  return parts.join(' · ');
}
