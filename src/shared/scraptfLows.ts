// 0.9 (history): the lowest price on sale each scrap.tf copy showed in the user's saves (R10), with when and since
// when. Retained saves (in memory) merged with scraptf_lows (written at import from 0.9). Nothing is fetched (R1).
//
// Raw keys + metal are kept and valued at a read's key price, so a key move alone never reads as a new low. The fold
// is a total order (rawPriceCompare) plus min/max of times, so any order of the same sightings gives one result.

import { bankStockKey, bankStockListFamily, bankStockOnSale } from './bankStock';
import { valueScrap } from './currency';
import type { ScraptfSaveRows } from './scraptfHistory';
import type { BankStockStored, Scrap, ScraptfBank, ScraptfCopyLow, ScraptfLowCore, UnixMs } from './types';

const DAY_MS = 86_400_000;
/** Retention: a stored low whose copy has not been on sale in a save for this long goes (Repo.pruneScraptfLows). */
export const SCRAPTF_LOWS_MAX_AGE_MS = 365 * DAY_MS;

/** One copy on sale in one save. */
export interface ScraptfLowSighting {
  key: string;
  sku: string;
  specialKey: string;
  keys: number;
  scrap: Scrap;
  at: UnixMs;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * -1 / 0 / 1: raw price a against b. Equal keys: metal. Else, with a key price (> 0): valued, then fewer keys first on a
 * tie; without one: fewer keys first. 0 only for the same raw price. A total order, so folds are order-independent.
 * Also orderPersistence's lowered / raised (with metalScrap as `scrap`).
 */
export function rawPriceCompare(a: { keys: number; scrap: Scrap }, b: { keys: number; scrap: Scrap }, keyScrap: Scrap): number {
  const ak = finite(a.keys) && a.keys > 0 ? a.keys : 0;
  const bk = finite(b.keys) && b.keys > 0 ? b.keys : 0;
  const as = finite(a.scrap) ? a.scrap : 0;
  const bs = finite(b.scrap) ? b.scrap : 0;
  if (ak === bk) return Math.sign(as - bs);
  if (finite(keyScrap) && keyScrap > 0) {
    const d = valueScrap(ak, as, keyScrap) - valueScrap(bk, bs, keyScrap);
    if (d !== 0) return Math.sign(d);
  }
  return Math.sign(ak - bk);
}

/** A low with one more sighting: lower replaces it (first = last = at); the same raw price widens first/last; since min, seenAt max. */
export function scraptfLowFold(low: ScraptfLowCore | null | undefined, s: Pick<ScraptfLowSighting, 'keys' | 'scrap' | 'at'>, keyScrap: Scrap): ScraptfLowCore {
  if (!low) return { keys: s.keys, scrap: s.scrap, firstAt: s.at, lastAt: s.at, since: s.at, seenAt: s.at };
  const since = Math.min(low.since, s.at);
  const seenAt = Math.max(low.seenAt, s.at);
  const c = rawPriceCompare(s, low, keyScrap);
  if (c < 0) return { keys: s.keys, scrap: s.scrap, firstAt: s.at, lastAt: s.at, since, seenAt };
  if (c === 0) return { ...low, firstAt: Math.min(low.firstAt, s.at), lastAt: Math.max(low.lastAt, s.at), since, seenAt };
  return { ...low, since, seenAt };
}

/** Two lows of one copy (retained and stored): the lower one; the same raw price joins first/last; since min, seenAt max. */
export function scraptfLowMerge(a: ScraptfLowCore | null | undefined, b: ScraptfLowCore | null | undefined, keyScrap: Scrap): ScraptfLowCore | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const since = Math.min(a.since, b.since);
  const seenAt = Math.max(a.seenAt, b.seenAt);
  const c = rawPriceCompare(a, b, keyScrap);
  if (c < 0) return { ...a, since, seenAt };
  if (c > 0) return { ...b, since, seenAt };
  return { ...a, firstAt: Math.min(a.firstAt, b.firstAt), lastAt: Math.max(a.lastAt, b.lastAt), since, seenAt };
}

/** All six fields equal. */
export function sameScraptfLow(a: ScraptfLowCore, b: ScraptfLowCore): boolean {
  return a.keys === b.keys && a.scrap === b.scrap && a.firstAt === b.firstAt && a.lastAt === b.lastAt && a.since === b.since && a.seenAt === b.seenAt;
}

/**
 * A save's copies on sale (bankStockOnSale), first row per bankStockKey (as scraptfRunsOf reads a save), /items family
 * rows (bankStockListFamily) left out: they price no one copy.
 */
export function scraptfLowSightingsOf(rows: readonly BankStockStored[], bank: ScraptfBank, at: UnixMs): ScraptfLowSighting[] {
  const out: ScraptfLowSighting[] = [];
  if (!finite(at)) return out;
  const seen = new Set<string>();
  for (const r of rows) {
    const key = bankStockKey(r.sku, r.specialKey);
    // The save's word on a copy is its first row, on sale or not (a second row of a key never adds a sighting).
    if (seen.has(key)) continue;
    seen.add(key);
    if (!bankStockOnSale(r) || bankStockListFamily(bank, r)) continue;
    out.push({ key, sku: r.sku, specialKey: r.specialKey, keys: r.costKeys ?? 0, scrap: r.costScrap ?? 0, at });
  }
  return out;
}

/** Per key, the fold of every sighting in `saves` (any order). O(rows). */
export function scraptfLowsOf(saves: readonly ScraptfSaveRows[], bank: ScraptfBank, keyScrap: Scrap): Map<string, ScraptfLowCore> {
  const out = new Map<string, ScraptfLowCore>();
  for (const save of saves) {
    for (const s of scraptfLowSightingsOf(save.rows, bank, save.savedAt)) out.set(s.key, scraptfLowFold(out.get(s.key), s, keyScrap));
  }
  return out;
}

/** For a read: valued at keyScrap (0 or less: keys count 0); null without a core. */
export function scraptfCopyLowOf(core: ScraptfLowCore | null | undefined, keyScrap: Scrap): ScraptfCopyLow | null {
  if (!core) return null;
  const K = finite(keyScrap) && keyScrap > 0 ? keyScrap : 0;
  return { keys: core.keys, scrap: core.scrap, valueScrap: valueScrap(core.keys, core.scrap, K), firstAt: core.firstAt, lastAt: core.lastAt, since: core.since };
}
