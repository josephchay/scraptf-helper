// 0.8 Holdings advice (H1, H6, H7): valuing recorded exit runs, the history behind a holding, and Sell now / List and
// wait / Hold / No clear signal with dated reasons. Pure, shared by the holdings service, the dashboard and the
// browser mock. It states only what was recorded or is in the book now; it never predicts a price or a time to sell.
// 0.9 (#1, #17): the trade lock the user set (Locked advice while the next unit is inside it; prices and profits
// unchanged), the size of a recorded trend (a Theil-Sen line with its spread, context only) and the key's 7-day move
// band from PriceDB history already loaded (context only). Each is measured from what was recorded, never a forecast.

import { ORDER_UNVERIFIED_AFTER_MS, unverifiedRevenue } from './buyerSeen';
import { flipProfit, minProfitFor, profitStatus, type CeilingSettings } from './ceiling';
import { valueScrap } from './currency';
import { holdingFigures, scraptfAlternative, type HoldingBuySide } from './holdings';
import { median, quantile, theilSen } from './robustStats';
import { scraptfListFresh } from './scraptfList';
import type {
  HistoryPoint,
  HoldingAdvice,
  HoldingAdviceKind,
  HoldingAdviceReason,
  HoldingAskSide,
  HoldingExitHistory,
  HoldingMark,
  HoldingMarkValues,
  HoldingRow,
  HoldingTradeLock,
  HoldingTrend,
  HoldingTrendSize,
  JournalLot,
  KeyMoveBand,
  ProfitSettings,
  Scrap,
  ScraptfListRow,
  TradeLockMode,
  UnixMs,
} from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * 60 * 60_000;
/** Retention (maintenance): runs older than this, and each base's oldest beyond HOLDING_MARKS_PER_BASE_MAX. */
export const HOLDING_MARKS_MAX_AGE_MS = 180 * DAY;
/** Retention: at most this many recorded runs per base SKU (Repo.pruneHoldingMarks keeps the newest). */
export const HOLDING_MARKS_PER_BASE_MAX = 2000;
/** 'holdings.detail' reads at most this many runs (the newest). */
export const HOLDING_DETAIL_MAX_MARKS = 500;

/** A run is extended only when seen again within this; a longer silence (app closed, feed off) starts a new run. */
export const HOLDING_MARK_GAP_MS = 60 * MIN;
/** Runs shorter than this (a snapshot replay, a feed flicker) are left out of the history; the newest always counts. */
export const HOLDING_MARK_MIN_RUN_MS = 5 * MIN;
/** A trend needs at least this many counted runs with an exit (with two different exits and HOLDING_TREND_MIN_OBSERVED_MS). */
export const HOLDING_TREND_MIN_RUNS = 3;
/** A trend needs at least this much observed time since the holding began (gaps not counted). */
export const HOLDING_TREND_MIN_OBSERVED_MS = 48 * HOUR;
/** The recorded high the advice may hold for is the highest exit within this of now. */
export const HOLDING_RECENT_HIGH_MS = 7 * DAY;
/** A recorded high counts only from a run that lasted this long: a buy order that stood for 6 minutes decides nothing. */
export const HOLDING_RECENT_HIGH_MIN_RUN_MS = 60 * MIN;
/** A book with no change and no snapshot for this long, or an order unseen for it, is refreshed first. */
export const HOLDING_REFRESH_AFTER_MS = ORDER_UNVERIFIED_AFTER_MS;
/** "List and wait" prices 1 scrap under the lowest matching ask. */
export const HOLDING_LIST_UNDERCUT_SCRAP = 1;
/** A sellable row switches to "List and wait" only for at least max(this, its minimum profit) more (the engine's CHANGE_PROFIT_DELTA). */
export const HOLDING_LIST_MIN_GAIN_SCRAP = 9;
/** The key-exposure reason shows from this many net keys. */
export const HOLDING_KEY_EXPOSURE_MIN_KEYS = 0.5;
/** 'holdings.detail' windows and caps (HOLDING_DETAIL_MAX_MARKS above): runs from this long before the oldest lot's buy. */
export const HOLDING_DETAIL_LEAD_MS = 7 * DAY;
/** 'holdings.detail' for a SKU not held: the runs of the last this long. */
export const HOLDING_DETAIL_UNHELD_MS = 30 * DAY;
/** 'holdings.detail' returns at most this many closed trades (the newest). */
export const HOLDING_DETAIL_MAX_CLOSED = 50;
/**
 * Runs read per held base for the rows' advice: every run retention keeps (HOLDING_MARKS_PER_BASE_MAX), from the
 * holding's start, so the advice's window is bounded by time and never cut by the read. At 500 a busy book (a value
 * change every 5-10 min) lost its trend and its 7-day recorded high to the newest 2-3 days, unsaid.
 */
export const HOLDING_HISTORY_MAX_RUNS = HOLDING_MARKS_PER_BASE_MAX;
/**
 * The value fields two runs are compared on (HoldingMarkValues), in column order: the prices and flags, never the
 * counts. buyerCount, verifiedBuyerCount and askCount move with every order placed or withdrawn on an active book; a
 * new run for each would let the 2,000-run cap, not the 180 days, bound what is kept.
 */
export const HOLDING_MARK_VALUE_KEYS: readonly (keyof HoldingMarkValues)[] = [
  'revKeys',
  'revMetalScrap',
  'revIsBot',
  'revVerified',
  'bestKeys',
  'bestMetalScrap',
  'nextKeys',
  'nextMetalScrap',
  'askKeys',
  'askMetalScrap',
  'scraptfPaysKeys',
  'scraptfPaysScrap',
];
/** The counts a run carries as the latest seen (extendHoldingMark's `counts`). */
export const HOLDING_MARK_COUNT_KEYS = ['buyerCount', 'verifiedBuyerCount', 'askCount'] as const;
/** 0.9 (#1): Steam's Trade Protection lock as the user set it ('7d'): a unit received is not tradable for this long. */
export const TRADE_LOCK_MS = 7 * DAY;
/** 0.9 (#17): a trend's size needs at least this many points (stretches with an exit at the newest stretch's sources)… */
export const HOLDING_TREND_SIZE_MIN_POINTS = 5;
/** …spanning at least HOLDING_TREND_MIN_OBSERVED_MS, and uses at most the newest this many (1,770 pairs per row). */
export const HOLDING_TREND_SIZE_MAX_POINTS = 60;
/** 0.9 (#17): the key move band measures 7-day spans… */
export const KEY_BAND_SPAN_MS = 7 * DAY;
/** …ending this far apart, from the newest point back… */
export const KEY_BAND_STEP_MS = DAY;
/**
 * …each counted only when both ends have a PriceDB point at most this old; the first span failing that ends the walk, so
 * only the newest unbroken run counts (the sparse months are skipped, never read as a flat key)…
 */
export const KEY_BAND_MAX_POINT_AGE_MS = 2 * DAY;
/**
 * …needs at least this many spans, and uses at most the newest this many. Neighbouring spans share 6 of their 7 days, so
 * 28 daily spans cover 34 days: about 4 separate weeks (14 covered about 3, too few for a 10th-90th percentile band).
 */
export const KEY_BAND_MIN_SPANS = 28;
/** The most daily spans the band looks back over (about 6 months of span ends). */
export const KEY_BAND_MAX_SPANS = 180;
/** The band's percentiles: the middle 8 in 10 of the measured 7-day moves. */
export const KEY_BAND_LOW_Q = 0.1;
export const KEY_BAND_HIGH_Q = 0.9;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// 0.9 (#1): the trade lock the user set (Settings.tradeLock); Flip Desk cannot read the account
// ---------------------------------------------------------------------------

/** 0.9 (#1): Settings.tradeLock.mode, anything unreadable (or a settings object without the group) as 'unknown'. */
export function tradeLockModeOf(s: { tradeLock?: { mode?: unknown } | null } | null | undefined): TradeLockMode {
  const m = s?.tradeLock?.mode;
  return m === 'none' || m === '7d' ? m : 'unknown';
}

/** When a unit bought at `boughtAt` (its journal time) becomes tradable: boughtAt + TRADE_LOCK_MS with '7d'; null otherwise or for a time ≤ 0. */
export function tradableAtOf(boughtAt: UnixMs, mode: TradeLockMode): UnixMs | null {
  return mode === '7d' && finite(boughtAt) && boughtAt > 0 ? boughtAt + TRADE_LOCK_MS : null;
}

/**
 * The open lots (oldest first, lots[0] the next a sale closes) still locked at `now` (tradableAtOf > now; a unit
 * exactly TRADE_LOCK_MS old is tradable): their count, the next lot's unlock when it is one of them, and the earliest
 * unlock; null with mode other than '7d' or no locked lot.
 */
export function holdingTradeLockOf(lots: readonly Pick<JournalLot, 'ts'>[], mode: TradeLockMode, now: UnixMs): HoldingTradeLock | null {
  if (mode !== '7d' || !Array.isArray(lots) || lots.length === 0) return null;
  let lockedQty = 0;
  let first: UnixMs | null = null;
  for (const l of lots) {
    const at = l ? tradableAtOf(l.ts, mode) : null;
    if (at === null || !(at > now)) continue;
    lockedQty++;
    if (first === null || at < first) first = at;
  }
  if (lockedQty === 0 || first === null) return null;
  const next = lots[0] ? tradableAtOf(lots[0].ts, mode) : null;
  return { lockedQty, nextLotTradableAt: next !== null && next > now ? next : null, firstTradableAt: first };
}

/** The row with tradeLock set when holdingTradeLockOf gives one, else the row itself (no key added: 0.8's toEqual tests hold). */
export function withTradeLock<T extends HoldingRow>(row: T, lots: readonly Pick<JournalLot, 'ts'>[], mode: TradeLockMode, now: UnixMs): T {
  const lock = holdingTradeLockOf(lots, mode, now);
  return lock === null ? row : { ...row, tradeLock: lock };
}

// ---------------------------------------------------------------------------
// 0.9 (#17): the key's 7-day move band, from PriceDB key history already loaded (no request)
// ---------------------------------------------------------------------------

/**
 * 0.9 (#17): the 10th and 90th percentile of the key's 7-day move in history already loaded: from the newest point back in
 * KEY_BAND_STEP_MS steps (at most KEY_BAND_MAX_SPANS, stopping where a span would start before the oldest point), move =
 * value(t) - value(t - KEY_BAND_SPAN_MS), where value(x) is the last point at or before x (buyScrap, else sellScrap, > 0)
 * and only when that point is at most KEY_BAND_MAX_POINT_AGE_MS older than x. The first span with an end failing that
 * ends the walk (never read as a flat key): only the newest unbroken run counts, so the sparse months never count and
 * fromAt..toAt has no gap. A span resolving to the same two points as the previous counted one is not counted again.
 * Null below KEY_BAND_MIN_SPANS spans or 2 points. Rounded to scrap. fromAt is the earliest span start used, toAt the
 * newest point, loadedAt when the history was loaded. A description of past moves, never a forecast.
 */
export function keyMoveBandOf(points: readonly HistoryPoint[], loadedAt: UnixMs): KeyMoveBand | null {
  const pts: { at: UnixMs; v: Scrap }[] = [];
  for (const p of Array.isArray(points) ? points : []) {
    if (!p || !finite(p.t)) continue;
    const v = finite(p.buyScrap) && p.buyScrap > 0 ? p.buyScrap : finite(p.sellScrap) && p.sellScrap > 0 ? p.sellScrap : null;
    if (v !== null) pts.push({ at: p.t * 1000, v });
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a.at - b.at);
  /** The index of the last point at or before x when it is at most KEY_BAND_MAX_POINT_AGE_MS older than x, else -1. */
  const indexAt = (x: UnixMs): number => {
    let lo = 0;
    let hi = pts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.at <= x) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && x - pts[found]!.at <= KEY_BAND_MAX_POINT_AGE_MS ? found : -1;
  };
  const start = pts[0]!.at;
  const toAt = pts[pts.length - 1]!.at;
  const moves: number[] = [];
  let fromAt: UnixMs | null = null;
  let prev: [number, number] | null = null;
  for (let i = 0; i < KEY_BAND_MAX_SPANS; i++) {
    const t1 = toAt - i * KEY_BAND_STEP_MS;
    const t0 = t1 - KEY_BAND_SPAN_MS;
    if (t0 < start) break;
    const i1 = indexAt(t1);
    const i0 = indexAt(t0);
    // Review fix: the first span with an end failing the age test ends the walk, so only the newest unbroken run counts
    // and fromAt..toAt has no gap; sparse points a week apart further back never count (nor stretch the dates).
    if (i1 < 0 || i0 < 0) break;
    // Review fix: a span resolving to the same two points as the previous counted one measures nothing new.
    if (prev !== null && prev[0] === i0 && prev[1] === i1) continue;
    prev = [i0, i1];
    moves.push(pts[i1]!.v - pts[i0]!.v);
    fromAt = t0;
  }
  if (moves.length < KEY_BAND_MIN_SPANS || fromAt === null) return null;
  const low = quantile(moves, KEY_BAND_LOW_Q);
  const high = quantile(moves, KEY_BAND_HIGH_Q);
  if (low === null || high === null) return null;
  return { lowScrap: Math.round(low), highScrap: Math.round(high), spans: moves.length, fromAt, toAt, loadedAt };
}

/** Two runs' values are the same (=== on every HOLDING_MARK_VALUE_KEYS field; raw prices, so a key move is no change; counts ignored). */
export function sameHoldingMarkValues(a: HoldingMarkValues, b: HoldingMarkValues): boolean {
  return HOLDING_MARK_VALUE_KEYS.every((k) => a[k] === b[k]);
}

/** A side's keys and metal as recorded: both, or neither when its metal is not a number. */
function sideOf(keys: unknown, metal: unknown): [number | null, Scrap | null] {
  if (!finite(metal)) return [null, null];
  return [finite(keys) ? keys : 0, metal];
}

/**
 * What one check saw for a base, raw: the revenue and best orders and the next buyer from `side`, the clean copy's
 * ask, and scrap.tf's pays price only when `list` is fresh (scraptfListFresh at `now`), not full and pays something.
 * Both numbers of a side, or neither. revVerified = !unverifiedRevenue(revenueOrder, now).
 */
export function holdingMarkValuesOf(side: HoldingBuySide | null, ask: HoldingAskSide | null, list: ScraptfListRow | null, now: UnixMs): HoldingMarkValues {
  const rev = side?.revenueOrder ?? null;
  const best = side?.bestOrder ?? null;
  const next = side?.nextBuyer ?? null;
  const [revKeys, revMetalScrap] = rev ? sideOf(rev.keys, rev.metalScrap) : [null, null];
  const [bestKeys, bestMetalScrap] = best ? sideOf(best.keys, best.metalScrap) : [null, null];
  const [nextKeys, nextMetalScrap] = next ? sideOf(next.keys, next.metalScrap) : [null, null];
  const [askKeys, askMetalScrap] = ask ? sideOf(ask.lowestKeys, ask.lowestMetalScrap) : [null, null];
  // The pays price only from a list the row could be judged on now: a stale or full list observed nothing.
  const fresh = list !== null && scraptfListFresh(list, now) && !list.full && finite(list.paysScrap) && list.paysScrap > 0 ? list : null;
  const [scraptfPaysKeys, scraptfPaysScrap] = fresh ? sideOf(fresh.paysKeys ?? 0, fresh.paysScrapRaw) : [null, null];
  const count = (v: unknown): number | null => (finite(v) ? Math.max(0, Math.floor(v)) : null);
  return {
    revKeys,
    revMetalScrap,
    revIsBot: rev && revMetalScrap !== null ? rev.isBot === true : null,
    revVerified: rev && revMetalScrap !== null ? !unverifiedRevenue(rev, now) : null,
    bestKeys,
    bestMetalScrap,
    nextKeys,
    nextMetalScrap,
    buyerCount: count(side?.buyerCount) ?? 0,
    verifiedBuyerCount: count(side?.verifiedBuyerCount),
    askKeys,
    askMetalScrap,
    askCount: askMetalScrap === null ? null : count(ask?.count),
    scraptfPaysKeys,
    scraptfPaysScrap,
  };
}

/** The key price a run is valued at: today's, else the run's own; null when neither is known. */
function runKeyScrap(m: Pick<HoldingMark, 'keyScrap'>, keyScrap: Scrap | null): Scrap | null {
  if (finite(keyScrap) && keyScrap > 0) return keyScrap;
  return finite(m.keyScrap) && m.keyScrap > 0 ? m.keyScrap : null;
}

/** One recorded side valued at `K`; a side with keys and no key price has no value (null), never a guess. */
function sideValue(keys: number | null, metal: Scrap | null, K: Scrap | null): Scrap | null {
  if (!finite(metal)) return null;
  const k = finite(keys) ? keys : 0;
  if (k === 0) return metal;
  return K === null ? null : valueScrap(k, metal, K);
}

/** The run's revenue order (unless unverified) and pays price valued at `keyScrap`, for markExitScrap and the recent high's source. */
function exitParts(m: HoldingMark, keyScrap: Scrap | null): { rev: Scrap | null; pays: Scrap | null } {
  const K = runKeyScrap(m, keyScrap);
  return {
    rev: m.revVerified === false ? null : sideValue(m.revKeys, m.revMetalScrap, K),
    pays: sideValue(m.scraptfPaysKeys, m.scraptfPaysScrap, K),
  };
}

/**
 * A run's best exit at `keyScrap` (else the run's own key price; when neither is known and the run has keys, null:
 * no exit): the higher of its revenue order (left out when revVerified === false: an order unseen for a day may have
 * been gone) and scrap.tf's recorded pays price; null when neither.
 */
export function markExitScrap(m: HoldingMark, keyScrap: Scrap | null): Scrap | null {
  const { rev, pays } = exitParts(m, keyScrap);
  if (rev === null) return pays;
  if (pays === null) return rev;
  return Math.max(rev, pays);
}

/**
 * Which exit sources a run observed: 'backpack' when it has a revenue order not flagged unverified (revVerified !==
 * false), 'scraptf' when it recorded a pays price (the list was fresh and not full). A source missing from a run
 * because the list aged past SCRAPTF_LIST_FRESH_MS or the order went unconfirmed is "not observed", never a lower
 * exit, so holdingExitHistory compares exits only between runs observing the same sources.
 */
export function markExitSources(m: HoldingMark): { backpack: boolean; scraptf: boolean } {
  return { backpack: finite(m.revMetalScrap) && m.revVerified !== false, scraptf: finite(m.scraptfPaysScrap) };
}

function byRunOrder(a: HoldingMark, b: HoldingMark): number {
  return a.fromAt - b.fromAt || a.id - b.id;
}

/**
 * The buyer settings a recorded run's revenue order was picked under: the blocklist, profit.useOrder, the outlier
 * multiples and the notes keywords (sorted, de-duplicated). A run stores the price, never the buyer or the settings,
 * so runs recorded under other buyer settings are not compared with today's (Holdings keeps when this key last
 * changed, holdingExitHistory's `settingsAt`). The thresholds, the reserve and the notifications are not in it.
 */
export function holdingMarkSettingsKey(s: { blocklist?: readonly unknown[] | null; profit?: Partial<ProfitSettings> | null } | null | undefined): string {
  const p = s?.profit ?? null;
  const set = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== ''))].sort() : [];
  const num = (v: unknown): number | null => (finite(v) ? v : null);
  return JSON.stringify([p?.useOrder ?? null, num(p?.outlierVsMedian), num(p?.outlierVsRef), set(p?.notesKeywords), set(s?.blocklist)]);
}

/** Consecutive runs at one exit (holdingExitHistory): what the duration rules and the comparisons are applied to. */
interface ExitStretch {
  fromAt: UnixMs;
  toAt: UnixMs;
  /** The newest run in it. */
  last: HoldingMark;
  exit: Scrap | null;
  src: { backpack: boolean; scraptf: boolean };
  /** Some run in it had the revenue order at the exit (backpack.tf wins a tie, as bestExitOf). */
  fromBackpack: boolean;
}

/**
 * Joins consecutive runs (oldest first) the recorder split only on a value the exit does not read (the best order,
 * the next buyer, the lowest ask, the bot flag, the lower of the two sources): the same markExitScrap and the same
 * markExitSources, the next starting 0 to HOLDING_MARK_GAP_MS after the last sighting of the one before, and their
 * values not all the same (sameHoldingMarkValues: identical values were split by a break in watching, a feed or app
 * restart or a clock step back, and stay apart). A joined stretch runs from its first fromAt to its last toAt, as the
 * recorder would have written it had it compared the exit alone.
 */
function exitStretchesOf(runs: readonly HoldingMark[], keyScrap: Scrap | null): ExitStretch[] {
  const out: ExitStretch[] = [];
  for (const m of runs) {
    const exit = markExitScrap(m, keyScrap);
    const src = markExitSources(m);
    const { rev, pays } = exitParts(m, keyScrap);
    const fromBackpack = rev !== null && (pays === null || rev >= pays);
    const prev = out[out.length - 1];
    const gap = prev ? m.fromAt - prev.toAt : NaN;
    if (
      prev &&
      prev.exit === exit &&
      prev.src.backpack === src.backpack &&
      prev.src.scraptf === src.scraptf &&
      gap >= 0 &&
      gap <= HOLDING_MARK_GAP_MS &&
      !sameHoldingMarkValues(prev.last, m)
    ) {
      prev.toAt = Math.max(prev.toAt, m.toAt);
      prev.last = m;
      prev.fromBackpack = prev.fromBackpack || fromBackpack;
      continue;
    }
    out.push({ fromAt: m.fromAt, toAt: m.toAt, last: m, exit, src, fromBackpack });
  }
  return out;
}

/**
 * The runs behind a holding that began at `sinceAt`: runs overlapping [since, now] (toAt >= since, fromAt <= now),
 * oldest first (fromAt, then id), where `since` is the later of `sinceAt` and `settingsAt` (when the buyer settings,
 * holdingMarkSettingsKey, last changed: runs recorded only before it priced other buyers and are left out; null: no
 * change known). Consecutive runs the recorder split only on a value the exit does not read are one stretch
 * (exitStretchesOf), and every rule below applies to stretches. Counted: every stretch lasting at least
 * HOLDING_MARK_MIN_RUN_MS, plus the newest. observedMs sums min(toAt, now) - max(fromAt, since) over counted
 * stretches. trend (HoldingTrend) is computed over the counted stretches with an exit (markExitScrap) and is null
 * unless there are at least HOLDING_TREND_MIN_RUNS of them, at least two different exits, and observedMs >=
 * HOLDING_TREND_MIN_OBSERVED_MS. Changes are the deltas between consecutive stretches-with-exit whose exits differ
 * **and whose markExitSources are equal** (a stretch whose sources differ from the one before starts a new
 * comparison: list staleness or an unconfirmed order alone is no change, no fall and no rise); direction is 'falling'
 * when the last 3 are all < 0, 'rising' when all > 0, else 'mixed' (fewer than 3: 'mixed'); streak is the exit before
 * those 3, the newest, and the fromAt of the stretch where the first of the 3 was seen. highAt/lowAt are the toAt of
 * the newest stretch at that value; recentHigh is over stretches-with-exit lasting at least
 * HOLDING_RECENT_HIGH_MIN_RUN_MS (toAt - fromAt) whose toAt >= now - HOLDING_RECENT_HIGH_MS, and recentHighFrom names
 * the source that gave it (the revenue order when it paid that exit in any run of the stretch, else the pays price).
 * 0.9 (#17): trend.size (trendSizeOf) is set when the newest stretch's sources give a Theil-Sen line (at least
 * HOLDING_TREND_SIZE_MIN_POINTS points over HOLDING_TREND_MIN_OBSERVED_MS); absent otherwise.
 */
export function holdingExitHistory(
  marks: readonly HoldingMark[],
  sinceAt: UnixMs,
  keyScrap: Scrap | null,
  now: UnixMs,
  settingsAt: UnixMs | null = null,
): HoldingExitHistory {
  // A change stamped ahead of the clock (a clock step back) cuts at now, never in the future.
  const cut = finite(settingsAt) ? Math.min(settingsAt, now) : null;
  const since = cut !== null && cut > sinceAt ? cut : sinceAt;
  const inWindow = (Array.isArray(marks) ? marks : [])
    .filter((m) => m && finite(m.fromAt) && finite(m.toAt) && m.toAt >= since && m.fromAt <= now)
    .sort(byRunOrder);
  const stretches = exitStretchesOf(inWindow, keyScrap);
  const newest = stretches[stretches.length - 1];
  const counted = stretches.filter((s) => s === newest || s.toAt - s.fromAt >= HOLDING_MARK_MIN_RUN_MS);
  let observedMs = 0;
  for (const s of counted) observedMs += Math.max(0, Math.min(s.toAt, now) - Math.max(s.fromAt, since));
  const first = counted[0];
  const firstAt = first ? Math.max(first.fromAt, since) : null;
  const base = { runs: counted.length, observedMs, firstAt, ...(since !== sinceAt ? { settingsAt: since } : {}) };

  const withExit: { m: ExitStretch; exit: Scrap; src: { backpack: boolean; scraptf: boolean } }[] = [];
  for (const s of counted) if (s.exit !== null) withExit.push({ m: s, exit: s.exit, src: s.src });
  if (withExit.length < HOLDING_TREND_MIN_RUNS || new Set(withExit.map((w) => w.exit)).size < 2 || observedMs < HOLDING_TREND_MIN_OBSERVED_MS) {
    return { ...base, trend: null };
  }

  // Changes only between stretches that observed the same sources: a list aging out or an order going unconfirmed is
  // "not observed", never a fall or a rise.
  const changes: { from: Scrap; to: Scrap; at: UnixMs }[] = [];
  for (let i = 1; i < withExit.length; i++) {
    const prev = withExit[i - 1]!;
    const cur = withExit[i]!;
    if (cur.exit === prev.exit || cur.src.backpack !== prev.src.backpack || cur.src.scraptf !== prev.src.scraptf) continue;
    changes.push({ from: prev.exit, to: cur.exit, at: cur.m.fromAt });
  }
  const last3 = changes.length >= 3 ? changes.slice(-3) : [];
  const direction: HoldingTrend['direction'] =
    last3.length === 3 && last3.every((c) => c.to < c.from) ? 'falling' : last3.length === 3 && last3.every((c) => c.to > c.from) ? 'rising' : 'mixed';
  const streak = direction === 'mixed' ? null : { fromScrap: last3[0]!.from, toScrap: last3[2]!.to, sinceAt: last3[0]!.at };

  // High and low: the toAt of the newest stretch at that value (withExit is oldest first, so >= keeps the newest).
  let high = withExit[0]!;
  let low = withExit[0]!;
  for (const w of withExit) {
    if (w.exit >= high.exit) high = w;
    if (w.exit <= low.exit) low = w;
  }
  let recent: (typeof withExit)[number] | null = null;
  for (const w of withExit) {
    if (w.m.toAt - w.m.fromAt < HOLDING_RECENT_HIGH_MIN_RUN_MS || w.m.toAt < now - HOLDING_RECENT_HIGH_MS) continue;
    if (recent === null || w.exit >= recent.exit) recent = w;
  }
  // backpack.tf wins a tie, as bestExitOf.
  const recentHighFrom: HoldingTrend['recentHighFrom'] = recent === null ? null : recent.m.fromBackpack ? 'backpack' : 'scraptf';
  // 0.9 (#17): how big the move is, context only (never read by a verdict).
  const size = trendSizeOf(withExit, since, now);
  return {
    ...base,
    trend: {
      highScrap: high.exit,
      highAt: high.m.toAt,
      lowScrap: low.exit,
      lowAt: low.m.toAt,
      firstScrap: withExit[0]!.exit,
      lastScrap: newest ? newest.exit : null,
      recentHighScrap: recent?.exit ?? null,
      recentHighAt: recent?.m.toAt ?? null,
      recentHighFrom,
      lastChangeAt: changes.length > 0 ? changes[changes.length - 1]!.at : null,
      direction,
      streak,
      ...(size ? { size } : {}),
    },
  };
}

/**
 * 0.9 (#17): the Theil-Sen line through the stretches with an exit that observed the newest one's sources (markExitSources),
 * the newest HOLDING_TREND_SIZE_MAX_POINTS of them, each at its midpoint clamped to [since, now]; null below
 * HOLDING_TREND_SIZE_MIN_POINTS points, a span under HOLDING_TREND_MIN_OBSERVED_MS or no pair at distinct times. The
 * spread is the median absolute residual about the line. Measured, never a forecast.
 */
function trendSizeOf(
  withExit: readonly { m: ExitStretch; exit: Scrap; src: { backpack: boolean; scraptf: boolean } }[],
  since: UnixMs,
  now: UnixMs,
): HoldingTrendSize | null {
  const last = withExit[withExit.length - 1];
  if (!last) return null;
  const same = withExit.filter((w) => w.src.backpack === last.src.backpack && w.src.scraptf === last.src.scraptf).slice(-HOLDING_TREND_SIZE_MAX_POINTS);
  if (same.length < HOLDING_TREND_SIZE_MIN_POINTS) return null;
  const xs = same.map((w) => (Math.max(w.m.fromAt, since) + Math.min(w.m.toAt, now)) / 2);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  if (!(x1 - x0 >= HOLDING_TREND_MIN_OBSERVED_MS)) return null;
  // Centred on the first point, so the intercept stays in scrap and keeps its precision.
  const pts = same.map((w, i) => ({ x: xs[i]! - x0, y: w.exit }));
  const fit = theilSen(pts);
  if (fit === null) return null;
  const spread = median(pts.map((p) => Math.abs(p.y - (fit.intercept + fit.slope * p.x)))) ?? 0;
  // `|| 0`: a level line reads 0, never -0.
  return {
    slopeScrapPerDay: fit.slope * DAY || 0,
    changeScrap: Math.round(fit.slope * (x1 - x0)) || 0,
    spreadScrap: Math.round(spread),
    points: pts.length,
    fromAt: Math.round(x0),
    toAt: Math.round(x1),
  };
}

/**
 * Sell now / List and wait / Hold / No clear signal for one row. `p` is settings.profit (CeilingSettings).
 * Deciding, the first that applies: (0) a backpack.tf exit on a buyer unseen for a day: scrap.tf's fresh price
 * when it clears on its own (scraptfAlternative), else no clear signal; (1) no buyers: list when a listing under
 * the lowest matching ask would profit; (2) clears target: sell now, or list and wait when a listing beats the sale
 * by max(minimum, HOLDING_LIST_MIN_GAIN_SCRAP) with two verified buyers, no falling trend and nothing to refresh;
 * (3) below target or a loss: list when a listing clears, hold for a recorded high from a run of an hour or more
 * that clears (no falling streak, not a merely stale scrap.tf list), no clear signal without a trend, else sell now
 * (below target, with the history's settingsAt when it starts there) or no clear signal (a loss). Context reasons
 * follow in a fixed order. A live order (the revenue
 * order, the next buyer) is judged with friction only (holdingFigures); every hypothetical sale (a listing, a
 * recorded high, a reference) with flipProfit, the price-move reserve included. Never a probability, a predicted
 * price, or a hold resting on time alone, a reference, a short run or a falling streak.
 * `opts.book` false: the row has no backpack.tf book Flip Desk prices or records (a currency, a SKU it cannot read),
 * so there is nothing to refresh first and no exit history to wait for: no refreshFirst, no refresh-first and no
 * no-history reason.
 * 0.9 (#17): a trend with a size (HoldingTrend.size) adds the trend-size reason after falling; it never changes the kind.
 * 0.9 (#1): a row whose later units are still inside the trade lock (r.tradeLock, next unit tradable) adds units-locked
 * after held-vs-typical; a row whose next unit is still locked at `now` reads 'locked', with a first trade-locked reason
 * naming the tradable date and the kind today's book would give (todayKind), the other reasons unchanged after it.
 * 0.9 (#17): `opts.keyBand` (keyMoveBandOf) is quoted on the key-exposure reason as its `band` when given.
 * The context order: reference-above, resave-list, refresh-first, falling, trend-size, held-vs-typical, units-locked,
 * key-exposure, list-age, has-extras, no-history.
 */
export function holdingAdvice(
  r: HoldingRow,
  history: HoldingExitHistory | null,
  p: CeilingSettings,
  keyScrap: Scrap | null,
  now: UnixMs,
  opts: HoldingAdviceOptions = {},
): HoldingAdvice {
  const book = opts.book !== false;
  const cost = r.nextLotCostScrap;
  const min = minProfitFor(cost, p);
  // Exits nobody pays today: the price-move reserve applies.
  const clears = (x: Scrap | null | undefined): boolean => finite(x) && profitStatus(flipProfit(x, cost, p), cost, p) === 'profitable';
  // A live order (the next buyer), judged exactly like the revenue order: friction only (R-PC1-sell).
  const liveFig = (x: Scrap) => holdingFigures({ revenueScrap: x, qty: 1, costScrap: cost, nextLotCostScrap: cost }, p);
  const trend = history?.trend ?? null;
  const ask = r.ask ?? null;
  const listScrap = ask ? Math.max(0, ask.lowestScrap - HOLDING_LIST_UNDERCUT_SCRAP) : null;
  const listProfit = flipProfit(listScrap, cost, p);
  const next = r.nextBuyer ?? null;
  const listStale = !(finite(r.scraptfListAt) && scraptfListFresh({ observedAt: r.scraptfListAt }, now));
  const idle = (t: UnixMs | null | undefined): boolean => t === null || t === undefined || !(now - t <= HOLDING_REFRESH_AFTER_MS);
  const refreshFirst =
    book &&
    ((r.revenueOrder !== null && unverifiedRevenue(r.revenueOrder, now)) || (r.revenueOrder === null && idle(r.lastOrderChangeAt) && idle(r.snapshotAt ?? null)));
  const profitNow = finite(r.profitNowScrap) ? r.profitNowScrap : 0;
  const sellers = ask ? { sellers: ask.count, bots: ask.botCount, mayIncludeOwn: ask.mayIncludeOwn } : null;

  // 0.9 (#1): 'locked' is only ever the final wrap below; the book's own verdict is one of the four 0.8 kinds.
  let kind: Exclude<HoldingAdviceKind, 'locked'>;
  const reasons: HoldingAdviceReason[] = [];
  if (r.bestExit === 'backpack' && unverifiedRevenue(r.revenueOrder, now)) {
    // (0) The backpack.tf buyer is stale.
    const alt = scraptfAlternative(r, p, now);
    if (alt && finite(alt.exitScrap) && finite(alt.profitNowScrap) && finite(r.scraptfListAt)) {
      kind = 'sell-now';
      reasons.push({ code: 'scraptf-instead', paysScrap: alt.exitScrap, profitScrap: alt.profitNowScrap, listAt: r.scraptfListAt });
    } else {
      kind = 'unclear';
      const seen = r.revenueOrder?.lastEventAt;
      reasons.push({ code: 'unverified-exit', seenAt: finite(seen) ? seen : null });
    }
  } else if (r.status === 'no-buyers') {
    // (1) No buyer and no usable scrap.tf price.
    if (ask && sellers && listScrap !== null && listProfit !== null && listProfit > 0) {
      kind = 'list';
      reasons.push({ code: 'list-no-buyer', listScrap, askScrap: ask.lowestScrap, profitScrap: listProfit, ...sellers });
    } else if (ask) {
      kind = 'unclear';
      reasons.push({ code: 'asks-below-cost', askScrap: ask.lowestScrap, sellers: ask.count });
    } else {
      kind = 'unclear';
      reasons.push({ code: 'no-exit' });
    }
  } else if (r.status === 'sell') {
    // (2) Selling now clears the thresholds.
    const clearsTarget: HoldingAdviceReason = { code: 'clears-target', profitScrap: profitNow, overScrap: profitNow - min, exit: r.bestExit ?? 'backpack' };
    const gain = listProfit !== null ? listProfit - profitNow : null;
    if (
      ask &&
      sellers &&
      listScrap !== null &&
      gain !== null &&
      gain >= Math.max(min, HOLDING_LIST_MIN_GAIN_SCRAP) &&
      (r.verifiedBuyerCount ?? 0) >= 2 &&
      trend?.direction !== 'falling' &&
      !refreshFirst
    ) {
      kind = 'list';
      reasons.push({ code: 'list-beats-sale', listScrap, askScrap: ask.lowestScrap, gainScrap: gain, ...sellers }, clearsTarget);
    } else {
      kind = 'sell-now';
      reasons.push(clearsTarget);
    }
    // Only when the book's depth is known (absent: an older buy side), so "no other buyer" is never a guess. An
    // unverified next buyer (unseen for a day) is never a backup, as singleExitOf (R-PC2).
    if (r.bestExit === 'backpack' && r.nextBuyer !== undefined) {
      const nextFig = next ? liveFig(next.valueScrap) : null;
      const nextUnverified = next?.unverified === true;
      if (nextFig === null || nextUnverified || nextFig.status !== 'sell') {
        reasons.push({ code: 'single-exit', nextScrap: next?.valueScrap ?? null, nextProfitScrap: nextFig?.profitNowScrap ?? null, nextUnverified });
      }
    }
  } else {
    // (3) Below target, or a loss.
    const high = trend?.recentHighScrap ?? null;
    if (ask && sellers && listScrap !== null && listProfit !== null && clears(listScrap)) {
      kind = 'list';
      reasons.push({ code: 'list-clears', listScrap, askScrap: ask.lowestScrap, profitScrap: listProfit, ...sellers });
    } else if (
      trend !== null &&
      history !== null &&
      high !== null &&
      clears(high) &&
      finite(trend.recentHighAt) &&
      history.firstAt !== null &&
      trend.direction !== 'falling' &&
      !(trend.recentHighFrom === 'scraptf' && listStale)
    ) {
      kind = 'hold';
      reasons.push({ code: 'recorded-high', exitScrap: high, at: trend.recentHighAt, runs: history.runs, firstAt: history.firstAt });
    } else if (trend === null) {
      // Advice never rests on the absence of data: a first install reads "No clear signal", not "Sell now".
      kind = 'unclear';
      if (book) reasons.push(noHistory(history));
      reasons.push(r.status === 'hold' ? { code: 'below-target', profitScrap: profitNow, minScrap: min } : { code: 'loss', profitScrap: profitNow });
    } else if (r.status === 'hold') {
      kind = 'sell-now';
      // The exits checked start where the buyer settings last changed, when they do: the reason says so.
      const settingsAt = history?.settingsAt;
      reasons.push({ code: 'below-target', profitScrap: profitNow, minScrap: min, ...(finite(settingsAt) ? { settingsAt } : {}) });
    } else {
      kind = 'unclear';
      reasons.push({ code: 'loss', profitScrap: profitNow });
    }
  }

  // Context, in a fixed order, each at most once.
  const has = (code: HoldingAdviceReason['code']): boolean => reasons.some((x) => x.code === code);
  const add = (x: HoldingAdviceReason): void => {
    if (!has(x.code)) reasons.push(x);
  };
  const pdb = r.refs?.pricedbBuyScrap;
  // A reference no buyer pays is context only, never a reason to hold.
  if (finite(pdb) && clears(pdb) && pdb > (r.exitScrap ?? 0)) add({ code: 'reference-above', pricedbBuyScrap: pdb, ageMs: r.refs?.pricedbAgeMs ?? null });
  if (trend?.recentHighFrom === 'scraptf' && finite(trend.recentHighScrap) && finite(trend.recentHighAt) && clears(trend.recentHighScrap) && listStale) {
    add({ code: 'resave-list', highScrap: trend.recentHighScrap, highAt: trend.recentHighAt, listAt: r.scraptfListAt });
  }
  if (refreshFirst && !has('unverified-exit')) {
    const o = r.revenueOrder;
    // An idle book: the newer of its last order change and its last snapshot.
    const idleAt = [r.snapshotAt, r.lastOrderChangeAt].filter(finite);
    add({ code: 'refresh-first', why: o ? 'unverified-order' : 'idle-book', seenAt: o ? (finite(o.lastEventAt) ? o.lastEventAt : null) : idleAt.length > 0 ? Math.max(...idleAt) : null });
  }
  if (trend?.direction === 'falling' && trend.streak) add({ code: 'falling', fromScrap: trend.streak.fromScrap, toScrap: trend.streak.toScrap, sinceAt: trend.streak.sinceAt });
  // 0.9 (#17): how big the recorded move was; context only, never a decision input.
  const size = trend?.size;
  if (size) add({ code: 'trend-size', changeScrap: size.changeScrap, spreadScrap: size.spreadScrap, points: size.points, fromAt: size.fromAt, toAt: size.toAt });
  const t = r.typicalHold;
  if (t && finite(r.heldSince) && r.heldSince > 0) {
    add({ code: 'held-vs-typical', heldMs: Math.max(0, now - r.heldSince), typicalMs: t.medianMs, count: t.count, scope: t.scope, stillHeld: t.stillHeld });
  }
  const lock = r.tradeLock ?? null;
  const lockedNow = lock !== null && finite(lock.nextLotTradableAt) && lock.nextLotTradableAt > now;
  // 0.9 (#1): the next unit is tradable, later ones are not yet.
  if (lock && !lockedNow && lock.lockedQty > 0 && lock.firstTradableAt > now) {
    add({ code: 'units-locked', lockedQty: lock.lockedQty, qty: r.qty, firstTradableAt: lock.firstTradableAt });
  }
  if (r.exitScrap !== null && finite(r.nextLotKeys) && finite(r.nextLotKeyPriceScrap) && finite(keyScrap) && keyScrap > 0) {
    const exitKeys = r.bestExit === 'scraptf' ? (r.scraptfPaysKeys ?? 0) : (r.revenueOrder?.keys ?? 0);
    const netKeys = (finite(exitKeys) ? exitKeys : 0) - r.nextLotKeys;
    if (Math.abs(netKeys) >= HOLDING_KEY_EXPOSURE_MIN_KEYS) {
      add({ code: 'key-exposure', netKeys, boughtKeyScrap: r.nextLotKeyPriceScrap, nowKeyScrap: keyScrap, ...(opts.keyBand ? { band: opts.keyBand } : {}) });
    }
  }
  if (r.bestExit === 'scraptf' && finite(r.scraptfListAt)) add({ code: 'list-age', listAt: r.scraptfListAt });
  if (r.flags.includes('has-extras')) add({ code: 'has-extras' });
  if (trend === null && book) add(noHistory(history));

  const basis = history && history.firstAt !== null ? { runs: history.runs, firstAt: history.firstAt } : null;
  // 0.9 (#1): the 7-day lock the user set keeps the next unit: what the book says now becomes a reason, never a forecast for the unlock day.
  if (lockedNow) {
    return { kind: 'locked', reasons: [{ code: 'trade-locked', tradableAt: lock!.nextLotTradableAt!, boughtAt: r.heldSince, todayKind: kind }, ...reasons], basis, refreshFirst };
  }
  return { kind, reasons, basis, refreshFirst };
}

/** holdingAdvice's options. */
export interface HoldingAdviceOptions {
  /** False: the row has no book Flip Desk prices or records (a currency, an unreadable SKU). Default true. */
  book?: boolean;
  /** 0.9 (#17): the key move band (keyMoveBandOf) the key-exposure reason quotes; absent or null: none. */
  keyBand?: KeyMoveBand | null;
}

/**
 * The no-history reason from what was recorded (zeros and null without a history), with when the buyer settings
 * changed when that is where the history starts (HoldingExitHistory.settingsAt).
 */
function noHistory(history: HoldingExitHistory | null): HoldingAdviceReason {
  const settingsAt = history?.settingsAt;
  return {
    code: 'no-history',
    runs: history?.runs ?? 0,
    observedMs: history?.observedMs ?? 0,
    firstAt: history?.firstAt ?? null,
    ...(finite(settingsAt) ? { settingsAt } : {}),
  };
}

/** The row with its advice: { ...r, advice: holdingAdvice(r, history, p, keyScrap, now, opts) }. */
export function attachHoldingAdvice(
  r: HoldingRow,
  history: HoldingExitHistory | null,
  p: CeilingSettings,
  keyScrap: Scrap | null,
  now: UnixMs,
  opts: HoldingAdviceOptions = {},
): HoldingRow {
  return { ...r, advice: holdingAdvice(r, history, p, keyScrap, now, opts) };
}
