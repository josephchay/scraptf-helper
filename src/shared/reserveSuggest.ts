// 0.9 (#12, RESEARCH section 8): a suggested price-move reserve from data Flip Desk already holds. Per value band it is
// the 10th percentile of how the exit moved over the user's typical hold. Sources: the exit runs recorded while the app
// ran (holding_marks: the revenue order, as Holdings records it) and the PriceDB history the item drawer loaded this
// session. Shown beside the setting with its sample size and source; never applied, never a forecast. Pure, shared by
// the service ('profit.reserveSuggestion') and the mock.
//
// Review: a recorded run goes on through a key price move (the recorder compares raw keys and metal), so a recorded
// window end with keys is valued at the key price of that instant from the PriceDB key history already in memory
// (keyPriceAtOf), never at the run's start price: the figure no longer depends on where the app restarted. Only windows
// from the last buyer-settings change on are read (only the latest change is kept, so nothing before it is known).

import { EXIT_RESERVE_MAX_PCT } from './ceiling';
import { valueScrap } from './currency';
import type {
  HistoryPoint,
  HoldingMark,
  LoadedKeyHistory,
  ReserveBand,
  ReserveBandSuggestion,
  ReserveSampleCount,
  ReserveSuggestion,
  Scrap,
  TypicalHold,
  UnixMs,
} from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far back the suggestion looks: no window starts before now minus this, and only runs ending (to_at) since then are read. */
export const RESERVE_LOOKBACK_MS = 90 * DAY;
/** holding_marks rows read at most (Repo.holdingMarksSince's default and cap). */
export const RESERVE_MAX_MARKS = 50_000;

/** The bands, in the order ReserveSuggestion.bands lists them. */
export const RESERVE_BANDS: readonly ReserveBand[] = ['under-10-ref', 'to-1-key', 'key-plus'];
/** The lowest band's ceiling: 10 ref (PROFIT_TIER 'ref10''s floor). */
export const RESERVE_BAND_REF10_SCRAP: Scrap = 90;
/** The hold used when the journal has no typical hold over every sale. */
export const RESERVE_DEFAULT_HOLD_MS = DAY;
/** The journal's typical hold is clamped to at least this (it also keeps the window grid moving). */
export const RESERVE_MIN_HOLD_MS = HOUR;
/** ...and to at most this. */
export const RESERVE_MAX_HOLD_MS = 14 * DAY;
/** A band's source needs this many windows... */
export const RESERVE_MIN_WINDOWS = 20;
/** ...from this many items. */
export const RESERVE_MIN_ITEMS = 3;
/** Each item gives at most its newest this many windows, so one long-watched item cannot be the whole sample. */
export const RESERVE_MAX_WINDOWS_PER_ITEM = 30;
/** The quantile of the relative changes the suggestion covers (the 10th percentile). */
export const RESERVE_QUANTILE = 0.1;
/** A PriceDB point stands for a time at most max(this, hold / 4) after it; a longer gap is not filled. */
export const RESERVE_POINT_TOLERANCE_MIN_MS = HOUR;
/**
 * A key history point stands for a time at most this after it (the key move band's KEY_BAND_MAX_POINT_AGE_MS, 2 d); a
 * recorded end with keys and no such point is not observed.
 */
export const RESERVE_KEY_POINT_MAX_AGE_MS = 2 * DAY;
const FLOAT_TOLERANCE = 1e-9;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Under 10 ref; 10 ref to under 1 key (none when the key price is 90 scrap or less); 1 key and up. */
export function reserveBandOf(valueScrapIn: Scrap, keyScrap: Scrap): ReserveBand {
  if (valueScrapIn < RESERVE_BAND_REF10_SCRAP) return 'under-10-ref';
  return finite(keyScrap) && keyScrap > 0 && valueScrapIn < keyScrap ? 'to-1-key' : 'key-plus';
}

/** Hyndman-Fan type 1 (the inverse empirical CDF): sorted[ceil(q n) - 1], float noise ignored; null for an empty list. */
export function lowerQuantile(sorted: readonly number[], q: number): number | null {
  const n = sorted.length;
  if (n === 0 || !finite(q)) return null;
  const i = Math.min(n - 1, Math.max(0, Math.ceil(q * n - FLOAT_TOLERANCE) - 1));
  return sorted[i] ?? null;
}

/** -p10 rounded up to a whole percent, 0 when p10 >= 0 (no fall to cover), at most EXIT_RESERVE_MAX_PCT. */
export function suggestedPctOf(p10: number): number {
  if (!finite(p10) || p10 >= 0) return 0;
  return Math.min(EXIT_RESERVE_MAX_PCT, Math.ceil(-p10 * 100 - FLOAT_TOLERANCE) / 100);
}

/** The hold a suggestion measures over, where it came from, and the journal counts behind it. */
export interface ReserveHold {
  holdMs: number;
  from: 'journal' | 'default';
  sales: number;
  stillHeld: number;
  /**
   * The journal's typical hold as it is, when the clamp changed it (holdMs is then RESERVE_MIN_HOLD_MS or
   * RESERVE_MAX_HOLD_MS, not the user's hold); null when holdMs is the typical hold itself or the default (review).
   */
  clampedFromMs: number | null;
}

/** The journal's 'all' typical hold clamped to [1 h, 14 d]; anything else (none, an 'item' scope, junk): the 1-day default. */
export function reserveHoldOf(hold: TypicalHold | null | undefined): ReserveHold {
  if (hold && hold.scope === 'all' && finite(hold.medianMs) && hold.medianMs >= 0) {
    const holdMs = Math.min(RESERVE_MAX_HOLD_MS, Math.max(RESERVE_MIN_HOLD_MS, hold.medianMs));
    return {
      holdMs,
      from: 'journal',
      sales: finite(hold.count) ? hold.count : 0,
      stillHeld: finite(hold.stillHeld) ? hold.stillHeld : 0,
      clampedFromMs: holdMs === hold.medianMs ? null : hold.medianMs,
    };
  }
  return { holdMs: RESERVE_DEFAULT_HOLD_MS, from: 'default', sales: 0, stillHeld: 0, clampedFromMs: null };
}

/** One hold-long window of one item: the exit at its start (`from`) and end (`to`). */
export interface ReserveWindow {
  base: string;
  startAt: UnixMs;
  from: Scrap;
  to: Scrap;
}

/**
 * Review: a key price at an instant from the PriceDB key history already in memory (PriceDb.loadedKeyHistory, what an
 * item drawer's history load fills; reading it sends nothing): the newest point at or before t (buyScrap, else
 * sellScrap, above 0, as history() and keyMoveBandOf read it) at most RESERVE_KEY_POINT_MAX_AGE_MS older than t, and
 * only for a t no later than when the history was loaded. Else null: not known, never filled with today's price.
 */
export function keyPriceAtOf(history: LoadedKeyHistory | null | undefined): (t: UnixMs) => Scrap | null {
  const loadedAt = history && finite(history.loadedAt) ? history.loadedAt : null;
  const pts: { at: UnixMs; v: Scrap }[] = [];
  if (loadedAt !== null && Array.isArray(history!.points)) {
    for (const p of history!.points) {
      if (!p || !finite(p.t)) continue;
      const v = finite(p.buyScrap) && p.buyScrap > 0 ? p.buyScrap : finite(p.sellScrap) && p.sellScrap > 0 ? p.sellScrap : null;
      if (v !== null) pts.push({ at: p.t * 1000, v });
    }
    pts.sort((a, b) => a.at - b.at);
  }
  return (t) => (loadedAt === null || !finite(t) || t > loadedAt ? null : pointAt(pts, t, RESERVE_KEY_POINT_MAX_AGE_MS));
}

/** No key history: no key price is known at any instant. */
const NO_KEY_PRICE = (): Scrap | null => null;

/**
 * A run's revenue order in scrap with its keys at `keyScrap`, the key price at the instant a window end reads
 * (keyPriceAtOf), as PriceDB's history values each record at that day's key price: the reserve covers a fall in scrap
 * revenue, and a key move is one for a keys-priced exit, so both sources measure the same thing. Never the run's own
 * HoldingMark.keyScrap: a run goes on through a key move (review). Null when the run marked it unverified, has none, or
 * has keys and no key price is known (not observed, never filled with today's). A metal-only run needs none.
 */
export function markRevenueScrap(m: HoldingMark, keyScrap: Scrap | null): Scrap | null {
  if (m.revVerified === false || !finite(m.revMetalScrap)) return null;
  const keys = finite(m.revKeys) ? m.revKeys : 0;
  const k = finite(keyScrap) && keyScrap > 0 ? keyScrap : null;
  if (keys > 0 && k === null) return null;
  const v = valueScrap(keys, m.revMetalScrap, k ?? 0);
  return v > 0 ? v : null;
}

/** The newest run (by fromAt) starting at or before t that has not ended before t; null in a gap (never filled). */
function runAt(runs: readonly HoldingMark[], t: UnixMs): HoldingMark | null {
  let lo = 0;
  let hi = runs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid]!.fromAt <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const r = found >= 0 ? runs[found]! : null;
  return r !== null && r.toAt >= t ? r : null;
}

/**
 * Per base (sorted by name), the windows [t, t + hold] for t = max(first fromAt, now - LOOKBACK, settingsAt) + k * hold
 * while t + hold <= now. Both ends must fall in a run (runAt) with a revenue (markRevenueScrap), keys valued at
 * keyAt(that end) (keyPriceAtOf; none known by default). Nothing before settingsAt is read (review): only the latest
 * buyer-settings change is kept, so an earlier one inside the lookback is invisible and a window before the stamp may
 * span it, as holdingExitHistory cuts at the same stamp. Each base keeps its newest RESERVE_MAX_WINDOWS_PER_ITEM windows.
 */
export function recordedWindows(
  marks: readonly HoldingMark[],
  holdMs: number,
  settingsAt: UnixMs | null,
  now: UnixMs,
  keyAt: (t: UnixMs) => Scrap | null = NO_KEY_PRICE,
): ReserveWindow[] {
  const out: ReserveWindow[] = [];
  if (!(finite(holdMs) && holdMs > 0) || !finite(now)) return out;
  const byBase = new Map<string, HoldingMark[]>();
  for (const m of Array.isArray(marks) ? marks : []) {
    if (!m || typeof m.baseSku !== 'string' || !finite(m.fromAt) || !finite(m.toAt) || m.toAt < m.fromAt) continue;
    let list = byBase.get(m.baseSku);
    if (!list) byBase.set(m.baseSku, (list = []));
    list.push(m);
  }
  // The key price is looked up only for a run with keys (a metal-only end needs none).
  const revenueAt = (r: HoldingMark | null, x: UnixMs): Scrap | null =>
    r === null ? null : markRevenueScrap(r, finite(r.revKeys) && r.revKeys > 0 ? keyAt(x) : null);
  const cut = finite(settingsAt) ? settingsAt : Number.NEGATIVE_INFINITY;
  for (const base of [...byBase.keys()].sort()) {
    const runs = byBase.get(base)!.sort((a, b) => a.fromAt - b.fromAt || a.id - b.id);
    const ws: ReserveWindow[] = [];
    for (let t = Math.max(runs[0]!.fromAt, now - RESERVE_LOOKBACK_MS, cut); t + holdMs <= now; t += holdMs) {
      const from = revenueAt(runAt(runs, t), t);
      const to = from === null ? null : revenueAt(runAt(runs, t + holdMs), t + holdMs);
      if (from !== null && to !== null) ws.push({ base, startAt: t, from, to });
    }
    out.push(...ws.slice(-RESERVE_MAX_WINDOWS_PER_ITEM));
  }
  return out;
}

/** The newest point at or before t, when it is at most `tol` older than t; else null. */
function pointAt(pts: readonly { at: UnixMs; v: Scrap }[], t: UnixMs, tol: number): Scrap | null {
  let lo = 0;
  let hi = pts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.at <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const p = found >= 0 ? pts[found]! : null;
  return p !== null && t - p.at <= tol ? p.v : null;
}

/**
 * The same grid over PriceDB history (buyScrap, history() values keys at that day's key price), per base sorted by
 * name. Points with a finite buyScrap above 0 only, `t` in seconds. Tolerance max(RESERVE_POINT_TOLERANCE_MIN_MS, hold / 4).
 */
export function pricedbWindows(histories: ReadonlyMap<string, readonly HistoryPoint[]>, holdMs: number, now: UnixMs): ReserveWindow[] {
  const out: ReserveWindow[] = [];
  if (!(finite(holdMs) && holdMs > 0) || !finite(now)) return out;
  const tol = Math.max(RESERVE_POINT_TOLERANCE_MIN_MS, holdMs / 4);
  for (const base of [...histories.keys()].sort()) {
    const pts = (histories.get(base) ?? [])
      .filter((p) => p && finite(p.t) && finite(p.buyScrap) && p.buyScrap > 0)
      .map((p) => ({ at: p.t * 1000, v: p.buyScrap as Scrap }))
      .sort((a, b) => a.at - b.at);
    if (pts.length === 0) continue;
    const ws: ReserveWindow[] = [];
    for (let t = Math.max(pts[0]!.at, now - RESERVE_LOOKBACK_MS); t + holdMs <= now; t += holdMs) {
      const from = pointAt(pts, t, tol);
      const to = pointAt(pts, t + holdMs, tol);
      if (from !== null && to !== null) ws.push({ base, startAt: t, from, to });
    }
    out.push(...ws.slice(-RESERVE_MAX_WINDOWS_PER_ITEM));
  }
  return out;
}

interface BandSample {
  rel: number[];
  items: Set<string>;
}

function bandSamples(ws: readonly ReserveWindow[], keyScrap: Scrap): Map<ReserveBand, BandSample> {
  const out = new Map<ReserveBand, BandSample>();
  for (const w of ws) {
    const band = reserveBandOf(w.from, keyScrap);
    let s = out.get(band);
    if (!s) out.set(band, (s = { rel: [], items: new Set() }));
    s.rel.push((w.to - w.from) / w.from);
    s.items.add(w.base);
  }
  return out;
}

function countOf(s: BandSample | undefined): ReserveSampleCount {
  return { windows: s?.rel.length ?? 0, items: s?.items.size ?? 0 };
}

function enough(s: BandSample | undefined): s is BandSample {
  return s !== undefined && s.rel.length >= RESERVE_MIN_WINDOWS && s.items.size >= RESERVE_MIN_ITEMS;
}

/**
 * Per band, the recorded exits when they are enough, else PriceDB history when it is, else not enough data. The two
 * sources are never pooled (they measure different prices: the revenue order against PriceDB's buy price), but both
 * value keys at the PriceDB key price of each end's own time (recorded ends through keyPriceAtOf(keyHistory), PriceDB
 * points as history() valued them), so a band's % keeps one meaning whichever source it comes from (review). Without
 * keyHistory a recorded end with keys is not observed. settingsAt is clamped to now; keyScrap (today's) only picks each
 * window's band.
 */
export function reserveSuggestionOf(a: {
  marks: readonly HoldingMark[];
  histories: ReadonlyMap<string, readonly HistoryPoint[]>;
  hold: TypicalHold | null;
  keyScrap: Scrap;
  settingsAt: UnixMs | null;
  now: UnixMs;
  /** PriceDb.loadedKeyHistory(): the key history already in memory; absent or null: no key price is known. */
  keyHistory?: LoadedKeyHistory | null;
}): ReserveSuggestion {
  const hold = reserveHoldOf(a.hold);
  const settingsAt = finite(a.settingsAt) ? Math.min(a.settingsAt, a.now) : null;
  const rec = bandSamples(recordedWindows(a.marks, hold.holdMs, settingsAt, a.now, keyPriceAtOf(a.keyHistory)), a.keyScrap);
  const pdb = bandSamples(pricedbWindows(a.histories, hold.holdMs, a.now), a.keyScrap);
  const bands = RESERVE_BANDS.map((band): ReserveBandSuggestion => {
    const r = rec.get(band);
    const p = pdb.get(band);
    const source = enough(r) ? 'recorded' : enough(p) ? 'pricedb' : null;
    const pick = source === 'recorded' ? r : source === 'pricedb' ? p : undefined;
    const p10 = pick ? lowerQuantile([...pick.rel].sort((x, y) => x - y), RESERVE_QUANTILE) : null;
    return { band, source, p10, suggestedPct: p10 === null ? null : suggestedPctOf(p10), recorded: countOf(r), pricedb: countOf(p) };
  });
  return {
    holdMs: hold.holdMs,
    holdFrom: hold.from,
    holdSales: hold.sales,
    holdStillHeld: hold.stillHeld,
    holdClampedFromMs: hold.clampedFromMs,
    lookbackMs: RESERVE_LOOKBACK_MS,
    settingsAt,
    bands,
    keyScrap: a.keyScrap,
    generatedAt: a.now,
  };
}
