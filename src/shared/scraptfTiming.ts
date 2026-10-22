// Buy timing (0.8, T2-T4, LC-4): estimators over a bank's lifecycle (scraptfLifecycleOf in scraptfHistory.ts) and
// the Wait / Buy now verdict, shared by the service's history index, the browser mock and the dashboard. Pure: no
// I/O, no network, no URL. Every input is a page the user saved from their own browser or read in the opt-in
// window (R1, R10); nothing here fetches or builds a scrap.tf URL.
//
// These are estimates from the user's saves, never forecasts: a step is dated at the save that showed it,
// several drops between two saves read as one, 'gone' can be a sale, a reservation or a move, and scrap.tf's own
// repricing rule is unknown. Every figure carries its n, and 'not enough data' is an answer with a reason.
//
// The estimators never decide by the outcome what to leave out: every way a price state ends is a competing
// outcome (dropped, gone, rose), only open states are censored, exclusion is on the start side only, and a gap
// over its page's gap limit (scraptfGapLimitMs: SCRAPTF_TIMING_GAP_SLACK times its usual longest gap in a day,
// 2 h to SCRAPTF_TIMING_MAX_BRACKET_MS) censors whatever was at risk at its last sighting before it (cutAt). Within
// a bracket a drop and then a sale read as one 'gone', so brackets much wider than the user's own looks (retention's
// one save a day past 7 d) are cut, never pooled.
//
// 0.9 (#10): every figure says how sure it is. The shares carry 90 % ranges from the infinitesimal jackknife of the
// pooled table with each copy's states summed (one item repriced five times is one item), Wait needs the gain's low
// end to clear a scrap instead of a fixed drop chance, and a verdict that turns when every price change is dated at the
// left end of its bracket says it depends on save timing. The low end takes the drop size at its own low end too
// (T9-3b: a 95 % order-statistic bound of the median drop, from the short-bracket drops when there are enough), since
// a false Wait is the costlier error. Deterministic; the one state is a memo per table (scraptfTimingSpreadOf, the
// drop sizes' low end), which never changes a result.

import { bankStockKey, bankStockTargetOf } from './bankStock';
import { flipProfit, type CeilingSettings } from './ceiling';
import { valueScrap } from './currency';
import {
  HISTORY_LAST_SEEN_STALE_MS,
  SCRAPTF_ITEM_RUNS_MAX,
  SCRAPTF_TIMING_GAP_SLACK,
  SCRAPTF_TIMING_GAP_WINDOW_MS,
  SCRAPTF_TIMING_MAX_BRACKET_MS,
  SCRAPTF_TIMING_MIN_GAP_MS,
  scraptfGapLimitMs,
  scraptfLifecycleOf,
  scraptfLookGapMs,
  type ScraptfBankLifecycle,
  type ScraptfCopyLifecycle,
  type ScraptfEventBuySide,
  type ScraptfPriceState,
  type ScraptfSaveRows,
} from './scraptfHistory';
import type {
  Opportunity,
  Scrap,
  ScraptfAssetStability,
  ScraptfBank,
  ScraptfBuyTiming,
  ScraptfDropStep,
  ScraptfItemCycles,
  ScraptfItemHistory,
  ScraptfSaveTimingAlt,
  ScraptfShareRange,
  ScraptfTimingBrief,
  ScraptfTimingUncertainty,
  ScraptfTimingVerdict,
  ScraptfTimingWhy,
  ScraptfTurnover,
  UnixMs,
} from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** T3 'few-drops': pooled drops (reprice-downs and arrivals) needed... */
export const SCRAPTF_TIMING_MIN_DROPS = 5;
/** ...from at least this many distinct items (copies): one copy repriced five times is not five independent drops. */
export const SCRAPTF_TIMING_MIN_COPIES = 3;
/** T3 'few-ended': pooled drops + gones + rises needed (and LC-4's ended listings, else 'not-enough-data'). */
export const SCRAPTF_TIMING_MIN_ENDED = 15;
/** T3 'few-at-risk': states still at their price at the copy's age needed (the denominator of every percentage). */
export const SCRAPTF_TIMING_MIN_AT_RISK = 8;
/** T3: states still at their price at the end of a horizon (a + H) needed, else that horizon is past the data. */
export const SCRAPTF_TIMING_MIN_AT_RISK_END = 3;
/** 24 h; the walk's cutAt needs it, so it lives in scraptfHistory.ts. */
export { SCRAPTF_TIMING_MAX_BRACKET_MS };
/** T3: the waits compared, from the copy's last save (6 h, 1 d, 3 d, 7 d). */
export const SCRAPTF_TIMING_HORIZONS_MS: readonly number[] = [6 * HOUR_MS, DAY_MS, 3 * DAY_MS, 7 * DAY_MS];
/** The look gap (scraptfLookGapMs, its window and the gap limit it sets) lives in scraptfHistory.ts: the walk's cutAt needs it. */
export { SCRAPTF_TIMING_GAP_SLACK, SCRAPTF_TIMING_GAP_WINDOW_MS, SCRAPTF_TIMING_MIN_GAP_MS, scraptfGapLimitMs, scraptfLookGapMs };
/** The copy's own drop size (and own cadence) needs at least this many own drops. */
export const SCRAPTF_OWN_MIN_DROPS = 3;
/** An own cadence needs its reprice-down durations' coefficient of variation at most this... */
export const SCRAPTF_OWN_CADENCE_MAX_CV = 0.35;
/** ...its median at least this many times the median end bracket of its drops... */
export const SCRAPTF_OWN_CADENCE_MIN_BRACKETS = 4;
/** ...and at least this many times the look gap, so it is not the user's save rhythm. */
export const SCRAPTF_OWN_CADENCE_MIN_LOOKS = 2;
/** 'wait' needs the expected gain of waiting to be at least this many scrap... */
export const SCRAPTF_WAIT_MIN_GAIN_SCRAP = 3;
/** ...and at least this share of the profit now (both on the estimate, against the better of buying now and not buying)... */
export const SCRAPTF_WAIT_MIN_GAIN_SHARE = 0.1;
/**
 * 0.9 (#10): ...and the gain's low end (one-sided, SCRAPTF_TIMING_Z), in whole scrap rounded down, at least this. It
 * replaces 0.8's fixed pDrop >= 0.3: how sure the gain is, not how likely a drop is.
 */
export const SCRAPTF_WAIT_MIN_GAIN_LOW_SCRAP = 1;
/** 0.9 (#10): the normal quantile of every range: the shares' two-sided 90 % range and the gain's one-sided 95 % low end. */
export const SCRAPTF_TIMING_Z = 1.6448536269514722;
/** 0.9 (#10): the shares' range in percent, as the texts say it (SCRAPTF_TIMING_Z two-sided). */
export const SCRAPTF_TIMING_RANGE_PCT = 90;
/** 0.9 (#10): one table's memoised spreads (scraptfTimingSpreadOf) are cleared once they hold this many. */
export const SCRAPTF_TIMING_SPREAD_CACHE_MAX = 4096;
/**
 * 0.9 (#10, T9-3b): the Wait gate's drop size is a one-sided lower bound of the median single-step drop at this level:
 * the k-th smallest size, k the largest with P(Binomial(n, 1/2) < k) <= this (scraptfMedianLowRank).
 */
export const SCRAPTF_DROP_LOW_ALPHA = 0.05;
/**
 * 0.9 (#10, T9-3b): the sizes come from the drops whose bracket (the save before the step to the step's save) is no
 * longer than the look gap when at least this many have one, else from all of them (several drops between distant
 * saves read as one bigger step).
 */
export const SCRAPTF_DROP_SHORT_BRACKET_MIN = 5;
/** ScraptfBuyTiming.steps keeps at most this many newest steps of the current run. */
export const SCRAPTF_TIMING_STEPS_MAX = 10;
/** ScraptfTimingBrief.steps (on rows) keeps at most this many. */
export const SCRAPTF_TIMING_BRIEF_STEPS = 5;
/** ScraptfBuyTiming.earlierRunEnds keeps at most this many. */
export const SCRAPTF_TIMING_RUN_ENDS_MAX = 5;
/** ScraptfBankCycles.tables is cleared once it holds this many tables. */
export const SCRAPTF_TIMING_TABLES_MAX = 64;
/** ScraptfTurnover.curve keeps at most this many points. */
export const SCRAPTF_TURNOVER_CURVE_MAX = 50;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The median of finite values; null without one. */
function median(xs: readonly number[]): number | null {
  const s = xs.filter(finite).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function keyScrapOf(keyScrap: Scrap): Scrap {
  return finite(keyScrap) && keyScrap > 0 ? keyScrap : 0;
}

function valueOf(raw: { keys: number; scrap: Scrap }, keyScrap: Scrap): Scrap {
  return valueScrap(raw.keys, raw.scrap, keyScrap);
}

/** A drop's size, 1 - value(next) / value(price) (0.05 = 5 %); null when unpriced. */
function dropPctOf(s: ScraptfPriceState, keyScrap: Scrap): number | null {
  if (s.nextRaw === null) return null;
  const from = valueOf(s.raw, keyScrap);
  return from > 0 ? 1 - valueOf(s.nextRaw, keyScrap) / from : null;
}

/** First index in ascending `xs` whose value is >= x. */
function lowerBound(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// T2: the pooled table (Aalen-Johansen, three competing outcomes)
// ---------------------------------------------------------------------------

/**
 * 0.8 (T2): how the pooled price states of a bank (or a value band of it) ended, as cumulative incidence curves of
 * three competing outcomes: dropped (a reprice-down or an arrival: the price the buyer can pay fell), gone (off
 * sale, untradable or the cheapest card sold) and rose (a reprice-up). Only open states are censored.
 */
export interface ScraptfTimingTable {
  /** 0, then each distinct event duration (ms) ascending; S/F_drop/F_gone/F_rise just after t[i] (S + F_drop + F_gone + F_rise = 1); atRisk[i] = durations >= t[i]. */
  t: number[];
  S: number[];
  F_drop: number[];
  F_gone: number[];
  F_rise: number[];
  atRisk: number[];
  /** Durations of every state used, ascending (scraptfAtRiskAt bisects it). */
  durations: number[];
  /** Counts in price states; copies / dropCopies in distinct items (state.key) among the states used / the drops. wideGap: censored at cutAt. */
  states: number;
  copies: number;
  drops: number;
  dropCopies: number;
  gone: number;
  rose: number;
  ended: number;
  imprecise: number;
  wideGap: number;
  medianDropPct: number | null;
  medianToDropMs: number | null;
  medianToGoneMs: number | null;
  /** The longest duration used: nothing is estimated past it. */
  maxMs: number;
  /**
   * Median bracket of the states that add time at risk (a duration over 0, or an event): per state its start bracket,
   * or for an event the wider of that and its end bracket. A state censored at 0 says nothing about timing.
   */
  resolutionMs: number | null;
  scope: 'band' | 'bank';
  /** 0.9 (#10): aligned with `durations`: each state's outcome (0 censored, 1 dropped, 2 gone, 3 rose)... */
  events: Uint8Array;
  /** ...and its copy as an index 0..copies-1 (in order of first use), so the jackknife can sum a copy's states. */
  copyIx: Uint32Array;
  /** 0.9 (#10): where in its bracket each price change is dated: 'right' (0.8: the save that showed it) or 'left' (the last save before it). */
  placement: ScraptfTimingPlacement;
  /**
   * 0.9 (#10, T9-3b): every priced drop's size (as medianDropPct's, 0.05 = 5 %), ascending, and aligned with it its end
   * bracket (endAt - lastAt: the save before the step to the step's save), for the Wait gate's conservative drop size.
   * Placement never changes them.
   */
  dropSizes: number[];
  dropBrackets: number[];
}

/**
 * 0.9 (#10): where a price change is dated within its bracket. 'right' (0.8, every verdict): at the save that showed it
 * (a state runs startAt to endAt). 'left' (the save-timing check only): at the user's last save before it, the left
 * end, so a state runs startPrevAt to lastAt; a censoring at a sighting (lastAt, cutAt) stays where it is.
 */
export type ScraptfTimingPlacement = 'right' | 'left';

/** The competing outcome a state's ending is: 1 dropped, 2 gone, 3 rose; 0 censored (open). */
function eventOf(outcome: ScraptfPriceState['outcome']): 0 | 1 | 2 | 3 {
  switch (outcome) {
    case 'reprice-down':
    case 'arrival':
      return 1;
    case 'gone':
    case 'untradable':
    case 'sold-cheapest':
      return 2;
    case 'reprice-up':
      return 3;
    case 'open':
      return 0;
  }
}

/**
 * 0.8 (T2): the Aalen-Johansen table over price states. Family states are skipped. A state is left out
 * ('imprecise') only on the start side: left-censored, begun after a gap over its page's gap limit (wideStart), or a
 * start bracket over SCRAPTF_TIMING_MAX_BRACKET_MS; how it ended never decides it. A state with a cutAt is censored there whatever its outcome ('wideGap'); otherwise its
 * outcome is an event at endAt - startAt (eventOf), and an open state is censored at lastAt - startAt. At each
 * distinct event time with n states at risk (a censoring at that time is still at risk):
 * S_j = S_{j-1}(1 - (d1+d2+d3)/n), F_k,j = F_k,j-1 + S_{j-1} d_k / n. An empty input gives zero counts with
 * t=[0], S=[1], F=[0]; it never throws. O(n log n).
 * 0.9: `placement` 'left' measures every state from startPrevAt and ends an event at lastAt; counts, brackets,
 * resolutionMs and the drop sizes do not depend on it.
 */
export function scraptfTimingTableOf(
  states: readonly ScraptfPriceState[],
  keyScrap: Scrap,
  scope: 'band' | 'bank',
  placement: ScraptfTimingPlacement = 'right',
): ScraptfTimingTable {
  const K = keyScrapOf(keyScrap);
  const used: { d: number; e: 0 | 1 | 2 | 3; br: number; c: number }[] = [];
  const copies = new Map<string, number>();
  const dropCopies = new Set<string>();
  const dropPcts: number[] = [];
  const dropSized: { pct: number; br: number }[] = [];
  const toDrop: number[] = [];
  const toGone: number[] = [];
  let imprecise = 0;
  let wideGap = 0;
  let drops = 0;
  let gone = 0;
  let rose = 0;
  for (const s of states) {
    if (s.family) continue;
    if (s.startPrevAt === null || !finite(s.startPrevAt) || s.wideStart || s.startAt - s.startPrevAt > SCRAPTF_TIMING_MAX_BRACKET_MS) {
      imprecise++;
      continue;
    }
    const startBracket = Math.max(0, s.startAt - s.startPrevAt);
    let c = copies.get(s.key);
    if (c === undefined) copies.set(s.key, (c = copies.size));
    // 0.9 (#10): 'left' dates the change that began the state at the save before it (startPrevAt), and the one that
    // ended it at its newest save at this price (lastAt): every change at the left end of its bracket, consistently.
    const from = placement === 'left' ? s.startPrevAt : s.startAt;
    if (s.cutAt !== null) {
      wideGap++;
      used.push({ d: Math.max(0, s.cutAt - from), e: 0, br: startBracket, c });
      continue;
    }
    const e = s.endAt === null ? 0 : eventOf(s.outcome);
    if (e === 0) {
      used.push({ d: Math.max(0, s.lastAt - from), e: 0, br: startBracket, c });
      continue;
    }
    const d = Math.max(0, (placement === 'left' ? s.lastAt : s.endAt!) - from);
    const endBracket = s.endAt! - s.lastAt;
    used.push({ d, e, br: Math.max(startBracket, endBracket), c });
    if (e === 1) {
      drops++;
      dropCopies.add(s.key);
      toDrop.push(d);
      const pct = dropPctOf(s, K);
      if (pct !== null) {
        dropPcts.push(pct);
        dropSized.push({ pct, br: endBracket });
      }
    } else if (e === 2) {
      gone++;
      toGone.push(d);
    } else rose++;
  }
  used.sort((x, y) => x.d - y.d);
  const n = used.length;
  const t = [0];
  const S = [1];
  const F_drop = [0];
  const F_gone = [0];
  const F_rise = [0];
  const atRisk = [n];
  let s = 1;
  let f1 = 0;
  let f2 = 0;
  let f3 = 0;
  for (let i = 0; i < n; ) {
    const d = used[i]!.d;
    let j = i;
    let d1 = 0;
    let d2 = 0;
    let d3 = 0;
    for (; j < n && used[j]!.d === d; j++) {
      const e = used[j]!.e;
      if (e === 1) d1++;
      else if (e === 2) d2++;
      else if (e === 3) d3++;
    }
    if (d1 + d2 + d3 > 0) {
      const atRiskNow = n - i;
      f1 += (s * d1) / atRiskNow;
      f2 += (s * d2) / atRiskNow;
      f3 += (s * d3) / atRiskNow;
      s *= 1 - (d1 + d2 + d3) / atRiskNow;
      // An event at duration 0 (two saves at one time) updates the first point rather than adding a second t = 0.
      if (t[t.length - 1] === d) {
        S[S.length - 1] = s;
        F_drop[F_drop.length - 1] = f1;
        F_gone[F_gone.length - 1] = f2;
        F_rise[F_rise.length - 1] = f3;
      } else {
        t.push(d);
        S.push(s);
        F_drop.push(f1);
        F_gone.push(f2);
        F_rise.push(f3);
        atRisk.push(atRiskNow);
      }
    }
    i = j;
  }
  return {
    t,
    S,
    F_drop,
    F_gone,
    F_rise,
    atRisk,
    durations: used.map((u) => u.d),
    states: n,
    copies: copies.size,
    drops,
    dropCopies: dropCopies.size,
    gone,
    rose,
    ended: drops + gone + rose,
    imprecise,
    wideGap,
    medianDropPct: median(dropPcts),
    medianToDropMs: median(toDrop),
    medianToGoneMs: median(toGone),
    maxMs: n > 0 ? used[n - 1]!.d : 0,
    resolutionMs: median(used.filter((u) => u.d > 0 || u.e !== 0).map((u) => u.br)),
    scope,
    events: Uint8Array.from(used, (u) => u.e),
    copyIx: Uint32Array.from(used, (u) => u.c),
    placement,
    ...dropSizesOf(dropSized),
  };
}

/** Drops sorted by size (a tie by bracket, so placement and input order never matter), as two aligned arrays. */
function dropSizesOf(sized: { pct: number; br: number }[]): { dropSizes: number[]; dropBrackets: number[] } {
  const s = sized.filter((x) => finite(x.pct)).sort((x, y) => x.pct - y.pct || x.br - y.br);
  return { dropSizes: s.map((x) => x.pct), dropBrackets: s.map((x) => x.br) };
}

/** 0.8 (T2): the curves at `ageMs`, a step function: their values just after the largest t[i] <= ageMs. */
export function scraptfTimingAt(t: ScraptfTimingTable, ageMs: number): { S: number; F_drop: number; F_gone: number; F_rise: number } {
  let i = 0;
  if (finite(ageMs) && ageMs >= 0) {
    // The largest i with t[i] <= ageMs.
    let lo = 0;
    let hi = t.t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t.t[mid]! <= ageMs) lo = mid;
      else hi = mid - 1;
    }
    i = lo;
  }
  return { S: t.S[i] ?? 1, F_drop: t.F_drop[i] ?? 0, F_gone: t.F_gone[i] ?? 0, F_rise: t.F_rise[i] ?? 0 };
}

/** 0.8 (T2): how many states of the table were still at their price at `ageMs` (durations >= ageMs). */
export function scraptfAtRiskAt(t: ScraptfTimingTable, ageMs: number): number {
  if (!finite(ageMs)) return 0;
  return t.durations.length - lowerBound(t.durations, ageMs);
}

// ---------------------------------------------------------------------------
// 0.9 (#10): how sure the shares are (the infinitesimal jackknife, clustered by copy)
// ---------------------------------------------------------------------------

/** First index in ascending `xs` whose value is > x. */
function upperBound(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 0.9 (#10): scraptfTimingInfluenceOf's result: the window's shares and each copy's influence on two of them. */
export interface ScraptfTimingInfluence {
  /** Dropped first, gone or rose first, none of these over (fromMs, toMs], given still at the price at fromMs (they add up to 1). */
  pDrop: number;
  pOut: number;
  pNone: number;
  /** Per copy (index table.copyIx): the sum over its states of d share / d weight at weight 1. pNone's is -(drop + out). */
  drop: Float64Array;
  out: Float64Array;
  /** The states and copies the shares rest on: durations over fromMs. */
  states: number;
  copies: number;
}

/**
 * 0.9 (#10): the infinitesimal jackknife of the Aalen-Johansen shares over the window (fromMs, toMs], conditioned on
 * being still at the price at fromMs (fromMs < 0: from the start, events at 0 included), with each copy's states
 * summed (clustered by copy: one copy repriced five times is one item). With the event times t_j in the window,
 * n_j = states with duration >= t_j, p_kj = d_kj / n_j (k: dropped, out = gone or rose), l_j = d_j / n_j,
 * G_j = prod_{m<j} (1 - l_m) and A_kj = sum_{m>j} G_m p_km, a state i with duration D_i > fromMs adds
 *   [ends in k at t_j] G_j / n_j - [ends at t_j] A_kj / (n_j (1 - l_j))
 *   - sum_{t_j <= D_i} G_j p_kj / n_j + sum_{t_j <= D_i} l_j A_kj / (n_j (1 - l_j))
 * (a term with l_j = 1, the last event time, is 0: nothing is left after it). States with D_i <= fromMs add 0.
 * Equal to the derivative of the weighted estimator (test: finite differences). O(states + event times).
 */
export function scraptfTimingInfluenceOf(t: ScraptfTimingTable, fromMs: number, toMs: number): ScraptfTimingInfluence {
  const D = t.durations;
  const E = t.events;
  const C = t.copyIx;
  const n = D.length;
  const drop = new Float64Array(t.copies);
  const out = new Float64Array(t.copies);
  const i0 = upperBound(D, fromMs);
  // The window's event times: at risk, per-outcome hazards, and G (the survival just before, from fromMs).
  const tj: number[] = [];
  const nj: number[] = [];
  const p1: number[] = [];
  const pO: number[] = [];
  const lam: number[] = [];
  const G: number[] = [];
  let g = 1;
  for (let i = i0; i < n && D[i]! <= toMs; ) {
    const d = D[i]!;
    let j = i;
    let d1 = 0;
    let dO = 0;
    for (; j < n && D[j] === d; j++) {
      const e = E[j]!;
      if (e === 1) d1++;
      else if (e !== 0) dO++;
    }
    if (d1 + dO > 0) {
      const atRisk = n - i;
      tj.push(d);
      nj.push(atRisk);
      p1.push(d1 / atRisk);
      pO.push(dO / atRisk);
      lam.push((d1 + dO) / atRisk);
      G.push(g);
      g *= 1 - (d1 + dO) / atRisk;
    }
    i = j;
  }
  const J = tj.length;
  // A_j: what the window adds after t_j; P1 / P2: the two running sums every state at risk at t_j takes.
  const A1 = new Float64Array(J);
  const AO = new Float64Array(J);
  let pDrop = 0;
  let pOut = 0;
  for (let j = J - 1; j >= 0; j--) {
    A1[j] = pDrop;
    AO[j] = pOut;
    pDrop += G[j]! * p1[j]!;
    pOut += G[j]! * pO[j]!;
  }
  const P1d = new Float64Array(J + 1);
  const P1o = new Float64Array(J + 1);
  const P2d = new Float64Array(J + 1);
  const P2o = new Float64Array(J + 1);
  for (let j = 0; j < J; j++) {
    const den = nj[j]! * (1 - lam[j]!);
    P1d[j + 1] = P1d[j]! + (G[j]! * p1[j]!) / nj[j]!;
    P1o[j + 1] = P1o[j]! + (G[j]! * pO[j]!) / nj[j]!;
    P2d[j + 1] = P2d[j]! + (den > 0 ? (lam[j]! * A1[j]!) / den : 0);
    P2o[j + 1] = P2o[j]! + (den > 0 ? (lam[j]! * AO[j]!) / den : 0);
  }
  const seen = new Uint8Array(t.copies);
  let copies = 0;
  let jp = 0; // event times <= D[i]
  for (let i = i0; i < n; i++) {
    const d = D[i]!;
    while (jp < J && tj[jp]! <= d) jp++;
    let vd = P2d[jp]! - P1d[jp]!;
    let vo = P2o[jp]! - P1o[jp]!;
    const e = E[i]!;
    if (e !== 0 && jp > 0 && tj[jp - 1] === d) {
      // This state's own ending, at an event time of the window.
      const j = jp - 1;
      const den = nj[j]! * (1 - lam[j]!);
      if (e === 1) vd += G[j]! / nj[j]!;
      else vo += G[j]! / nj[j]!;
      if (den > 0) {
        vd -= A1[j]! / den;
        vo -= AO[j]! / den;
      }
    }
    const c = C[i]!;
    drop[c] += vd;
    out[c] += vo;
    if (seen[c] === 0) {
      seen[c] = 1;
      copies++;
    }
  }
  return { pDrop, pOut, pNone: g, drop, out, states: n - i0, copies };
}

/**
 * 0.9 (#10): what the ranges need of a window, memoised per table: the shares, the states and copies behind them, and
 * the copy-clustered (co)variances of pDrop, pOut and q's 'out' part at the look gap (q = S + F_drop = 1 - F_out over
 * [0, lookGapMs]), each times the small-sample factor copies / (copies - 1) (none below 2 copies). q's are 0 without a
 * look gap. Rows of one page share their ages (lastAt - startAt over the page's save times), so most reads are hits.
 */
export interface ScraptfTimingSpread {
  pDrop: number;
  pOut: number;
  pNone: number;
  states: number;
  copies: number;
  dropVar: number;
  outVar: number;
  dropOutCov: number;
  qOutVar: number;
  dropQOutCov: number;
  outQOutCov: number;
}

const spreadMemo = new WeakMap<ScraptfTimingTable, Map<string, ScraptfTimingSpread>>();
const qOutMemo = new WeakMap<ScraptfTimingTable, Map<number, Float64Array>>();

function memoOf<K, V>(memo: WeakMap<ScraptfTimingTable, Map<K, V>>, t: ScraptfTimingTable): Map<K, V> {
  let m = memo.get(t);
  if (!m) memo.set(t, (m = new Map()));
  return m;
}

/** 0.9 (#10): scraptfTimingInfluenceOf summed into a ScraptfTimingSpread, memoised per (table, fromMs, toMs, lookGapMs). */
export function scraptfTimingSpreadOf(t: ScraptfTimingTable, fromMs: number, toMs: number, lookGapMs: number | null): ScraptfTimingSpread {
  const memo = memoOf(spreadMemo, t);
  const key = `${fromMs}|${toMs}|${lookGapMs ?? ''}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const inf = scraptfTimingInfluenceOf(t, fromMs, toMs);
  let qOut: Float64Array | null = null;
  if (lookGapMs !== null && finite(lookGapMs)) {
    const qm = memoOf(qOutMemo, t);
    qOut = qm.get(lookGapMs) ?? null;
    if (qOut === null) {
      if (qm.size >= SCRAPTF_TIMING_SPREAD_CACHE_MAX) qm.clear();
      qm.set(lookGapMs, (qOut = scraptfTimingInfluenceOf(t, -1, lookGapMs).out));
    }
  }
  let dd = 0;
  let oo = 0;
  let dO = 0;
  let qq = 0;
  let dq = 0;
  let oq = 0;
  for (let c = 0; c < inf.drop.length; c++) {
    const d = inf.drop[c]!;
    const o = inf.out[c]!;
    const q = qOut ? qOut[c]! : 0;
    dd += d * d;
    oo += o * o;
    dO += d * o;
    qq += q * q;
    dq += d * q;
    oq += o * q;
  }
  const f = inf.copies >= 2 ? inf.copies / (inf.copies - 1) : 1;
  const spread: ScraptfTimingSpread = {
    pDrop: inf.pDrop,
    pOut: inf.pOut,
    pNone: inf.pNone,
    states: inf.states,
    copies: inf.copies,
    dropVar: f * dd,
    outVar: f * oo,
    dropOutCov: f * dO,
    qOutVar: f * qq,
    dropQOutCov: f * dq,
    outQOutCov: f * oq,
  };
  if (memo.size >= SCRAPTF_TIMING_SPREAD_CACHE_MAX) memo.clear();
  memo.set(key, spread);
  return spread;
}

/** 0.9 (#10): the Wilson score range of a share p over n (n >= 1), clamped to [0, 1]; exactly 0 / 1 at p = 0 / 1. */
export function scraptfWilson(p: number, n: number, z: number = SCRAPTF_TIMING_Z): ScraptfShareRange {
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { low: p <= 0 ? 0 : Math.max(0, center - half), high: p >= 1 ? 1 : Math.min(1, center + half) };
}

/**
 * 0.9 (#10, review): whether a share's jackknife variance says nothing of its spread: p at 0 or 1, a variance of 0
 * (every copy says the same), or under two copies behind it (one copy's influence sums to 0, since the shares do not
 * change when every weight is scaled alike). Such a share's range is taken at the copies, and the Wait gate takes it
 * at that range's far end.
 */
function shareSpreadless(p: number, variance: number, copies: number): boolean {
  return !(p > 0 && p < 1 && finite(variance) && variance > 1e-24 && copies >= 2);
}

/**
 * 0.9 (#10): a share's range: Wilson at the effective sample size p(1 - p) / variance, capped at the states behind it;
 * with p at 0 or 1, a variance of 0 (every copy says the same) or one copy behind it, at the copies behind it instead;
 * never under 1.
 */
export function scraptfShareRange(p: number, variance: number, states: number, copies: number): ScraptfShareRange {
  const q = Math.min(1, Math.max(0, finite(p) ? p : 0));
  const v = finite(variance) && variance > 0 ? variance : 0;
  const nEff = shareSpreadless(q, v, copies) ? copies : Math.min(states, (q * (1 - q)) / v);
  return scraptfWilson(q, Math.max(1, nEff));
}

/**
 * 0.9 (#10, review): the variance the Wait gate gives a spreadless share (shareSpreadless): the distance from p to its
 * range's end on the side that lowers the gain (`coef`, the share's weight in the gain: the low end when it is >= 0),
 * over SCRAPTF_TIMING_Z, squared. Taken alone, the gate's low end is then the gain with that share at its range's end.
 */
function spreadlessVar(p: number, range: ScraptfShareRange, coef: number): number {
  const d = coef >= 0 ? p - range.low : range.high - p;
  return (Math.max(0, d) / SCRAPTF_TIMING_Z) ** 2;
}

// ---------------------------------------------------------------------------
// 0.9 (#10, T9-3b): the drop size at its low end, for the Wait gate
// ---------------------------------------------------------------------------

/**
 * 0.9 (#10, T9-3b): the rank k (1-based) of the order statistic that bounds a median from below over n sizes at level
 * `alpha`: the largest k with P(Binomial(n, 1/2) < k) <= alpha, and at least 1 (so at 5 % any n under 5 gives the
 * smallest). The k-th smallest is over the median only when fewer than k sizes are at or under it, so it is a lower
 * bound with confidence at least 1 - alpha whatever the sizes' distribution. Exact: the binomial terms are summed in
 * log space (no 2^-n underflow), with no dependency. O(k).
 */
export function scraptfMedianLowRank(n: number, alpha: number = SCRAPTF_DROP_LOW_ALPHA): number {
  if (!finite(n) || n < 1 || !finite(alpha) || alpha <= 0) return 1;
  const N = Math.floor(n);
  let lp = -N * Math.LN2; // log P(Binomial(N, 1/2) = 0)
  let cdf = 0;
  let k = 1;
  for (let i = 0; i < N; i++) {
    cdf += Math.exp(lp); // P(Binomial(N, 1/2) <= i) = P(... < i + 1)
    if (cdf > alpha) break;
    k = i + 1;
    lp += Math.log(N - i) - Math.log(i + 1);
  }
  return Math.max(1, k);
}

/** 0.9 (#10, T9-3b): the Wait gate's drop size and what it rests on (scraptfDropLowOf). */
export interface ScraptfDropLow {
  /** The scraptfMedianLowRank-th smallest size (0.05 = 5 %): a one-sided 95 % lower bound of the median single-step drop. */
  dropLow: number;
  /** 'short-brackets': only the drops whose bracket was no longer than the look gap; 'all': every drop the estimate uses. */
  from: 'all' | 'short-brackets';
  /** The sizes it rests on. */
  n: number;
}

/**
 * 0.9 (#10, T9-3b): a one-sided 95 % lower bound of the median single-step drop over `sizes` (ascending), each with its
 * bracket (`brackets`, aligned: the save before the step to the step's save). When at least
 * SCRAPTF_DROP_SHORT_BRACKET_MIN brackets are no longer than `lookGapMs`, only those drops count (several drops between
 * distant saves read as one bigger step); else all of them ('all'). The bound is the scraptfMedianLowRank-th smallest of
 * the sizes counted. Null without a size.
 */
export function scraptfDropLowOf(sizes: readonly number[], brackets: readonly number[], lookGapMs: number | null): ScraptfDropLow | null {
  if (sizes.length === 0) return null;
  let from: ScraptfDropLow['from'] = 'all';
  let use: readonly number[] = sizes;
  if (lookGapMs !== null && finite(lookGapMs)) {
    const short = sizes.filter((_, i) => finite(brackets[i]) && brackets[i]! <= lookGapMs);
    if (short.length >= SCRAPTF_DROP_SHORT_BRACKET_MIN) {
      from = 'short-brackets';
      use = short;
    }
  }
  return { dropLow: use[scraptfMedianLowRank(use.length) - 1]!, from, n: use.length };
}

const dropLowMemo = new WeakMap<ScraptfTimingTable, Map<number | null, ScraptfDropLow | null>>();

/** 0.9 (#10, T9-3b): scraptfDropLowOf over a table's drops (dropSizes, dropBrackets), memoised per (table, look gap). */
export function scraptfTableDropLowOf(t: ScraptfTimingTable, lookGapMs: number | null): ScraptfDropLow | null {
  const memo = memoOf(dropLowMemo, t);
  const hit = memo.get(lookGapMs);
  if (hit !== undefined) return hit;
  const low = scraptfDropLowOf(t.dropSizes, t.dropBrackets, lookGapMs);
  if (memo.size >= SCRAPTF_TIMING_SPREAD_CACHE_MAX) memo.clear();
  memo.set(lookGapMs, low);
  return low;
}

// ---------------------------------------------------------------------------
// The per-bank cache (service and mock)
// ---------------------------------------------------------------------------

/** 0.8: one bank's lifecycle and the estimators built over it on first use (the history index and the mock cache one per bank). */
export interface ScraptfBankCycles {
  bank: ScraptfBank;
  life: ScraptfBankLifecycle;
  /** Pooled tables, keyed `${keyScrap}|${bucket}` ('*' for the whole bank; 0.9: `|left` appended for 'left' placement); cleared past SCRAPTF_TIMING_TABLES_MAX. */
  tables: Map<string, ScraptfTimingTable>;
  /** LC-4, built on first use. */
  turnover: ScraptfTurnover | null;
}

/**
 * 0.8: a bank's cycles: scraptfLifecycleOf(saves, { bank, keyScrap }) with empty caches. `assetStability`: the
 * pre-pass over the same saves when already done (scraptfLifecycleOf's opts), so it is not walked twice.
 */
export function scraptfBankCyclesOf(
  bank: ScraptfBank,
  saves: readonly ScraptfSaveRows[],
  keyScrap: Scrap,
  opts: { assetStability?: ScraptfAssetStability } = {},
): ScraptfBankCycles {
  const life = scraptfLifecycleOf(saves, opts.assetStability ? { bank, keyScrap, assetStability: opts.assetStability } : { bank, keyScrap });
  return { bank, life, tables: new Map(), turnover: null };
}

/**
 * 0.8 (T3): a home page's look gap, the lifecycle's own (the walk reads every page's look gap once per build: its gap
 * limit needs it), so a verdict per row never filters and sorts the page's save times again. A lifecycle built by
 * hand without it is read from pageSaves.
 */
export function scraptfCyclesLookGapMs(c: Pick<ScraptfBankCycles, 'life'>, page: string): number | null {
  const gaps: ReadonlyMap<string, number | null> | undefined = c.life.lookGaps;
  const walked = gaps?.get(page);
  return walked !== undefined ? walked : scraptfLookGapMs(c.life.pageSaves.get(page) ?? []);
}

/** The power-of-two value bucket a band is built around. */
function bucketOf(v: Scrap): number {
  return Math.floor(Math.log2(Math.max(1, finite(v) ? v : 1)));
}

function cachedTable(c: ScraptfBankCycles, key: string, build: () => ScraptfTimingTable): ScraptfTimingTable {
  const hit = c.tables.get(key);
  if (hit) return hit;
  if (c.tables.size >= SCRAPTF_TIMING_TABLES_MAX) c.tables.clear();
  const t = build();
  c.tables.set(key, t);
  return t;
}

/**
 * 0.8 (T2): the pooled table a copy worth `valueScrap` is judged with: the band (the states whose value at `keyScrap`
 * sits in the copy's power-of-two bucket or a neighbouring one, between about a quarter and four times its value)
 * when it has at least SCRAPTF_TIMING_MIN_ENDED ended states, else the whole bank (scope 'bank'). Cached per bucket.
 * 0.9: `placement` 'left' (the save-timing check) is cached beside, keyed `…|left`.
 */
export function scraptfTimingTableFor(c: ScraptfBankCycles, valueScrapIn: Scrap, keyScrap: Scrap, placement: ScraptfTimingPlacement = 'right'): ScraptfTimingTable {
  const K = keyScrapOf(keyScrap);
  const b = bucketOf(valueScrapIn);
  const all = (): ScraptfPriceState[] => {
    const out: ScraptfPriceState[] = [];
    for (const copy of c.life.copies.values()) for (const s of copy.states) out.push(s);
    return out;
  };
  // 'left' tables sit beside the 'right' ones; the band-or-bank choice is the same (placement never changes `ended`).
  const tag = placement === 'left' ? '|left' : '';
  const band = cachedTable(c, `${K}|${b}${tag}`, () =>
    scraptfTimingTableOf(
      all().filter((s) => Math.abs(bucketOf(valueOf(s.raw, K)) - b) <= 1),
      K,
      'band',
      placement,
    ),
  );
  if (band.ended >= SCRAPTF_TIMING_MIN_ENDED) return band;
  return cachedTable(c, `${K}|*${tag}`, () => scraptfTimingTableOf(all(), K, 'bank', placement));
}

// ---------------------------------------------------------------------------
// T3: the expected value of waiting, and the verdict
// ---------------------------------------------------------------------------

/**
 * 0.8 (T3): buying now against waiting one horizon, one step at today's revenue. evBuy = flipProfit(R, c0);
 * evWait = round(pDrop x q x max(0, flipProfit(R, c1)) + pNone x max(0, evBuy)). Gone first and rose first are worth
 * 0 to waiting (the card at c0 is no longer there to buy); q is the chance the dropped price is still there at the
 * user's next look. Profit goes through flipProfit only (friction and the price-move reserve).
 */
export function scraptfTimingEv(a: {
  revenueScrap: Scrap;
  costScrap: Scrap;
  nextScrap: Scrap;
  pDrop: number;
  pNone: number;
  q: number;
  profit: CeilingSettings;
}): { evBuyScrap: Scrap; evWaitScrap: Scrap } {
  const p = (v: number): number => (finite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const evBuy = flipProfit(a.revenueScrap, a.costScrap, a.profit) ?? 0;
  const next = flipProfit(a.revenueScrap, a.nextScrap, a.profit) ?? 0;
  return { evBuyScrap: evBuy, evWaitScrap: Math.round(p(a.pDrop) * p(a.q) * Math.max(0, next) + p(a.pNone) * Math.max(0, evBuy)) };
}

/** 'wait''s gain bar: max(SCRAPTF_WAIT_MIN_GAIN_SCRAP, ceil(share x max(evBuy, 0))), the share's float noise aside. */
function waitGainBar(evBuy: Scrap): number {
  return Math.max(SCRAPTF_WAIT_MIN_GAIN_SCRAP, Math.ceil(SCRAPTF_WAIT_MIN_GAIN_SHARE * Math.max(evBuy, 0) - 1e-9));
}

type TimingPick = { H: number; pDrop: number; pGone: number; pRise: number; pNone: number; evWait: Scrap };

/** T9-3b: the Wait gate's conservative drop: today's price after it (c1 at the low end), the size and its sizes' source. */
type GateDrop = { c1: Scrap; dropLow: number; from: ScraptfDropLow['from'] };

/**
 * 0.9 (#10): steps 1-6 of scraptfBuyTimingOf on one table at one age (0.8's body, moved; the save-timing check runs it
 * again on the 'left' table). `ranges`: fill `uncertainty` for the picked horizon (the main read); the gain's low end is
 * computed whenever Wait's other conditions hold, so the gate never depends on `ranges`. `gateDrop` (T9-3b, called
 * only then): the drop size the low end is taken at; null keeps c1.
 */
function timingVerdictOf(a: {
  table: ScraptfTimingTable;
  ageMs: number;
  open: ScraptfPriceState;
  R: Scrap | null;
  M: Scrap | null;
  c0: Scrap;
  c1: Scrap | null;
  evBuy: Scrap | null;
  lookGap: number | null;
  now: UnixMs;
  profit: CeilingSettings;
  ranges: boolean;
  gateDrop: () => GateDrop | null;
}): { verdict: ScraptfTimingVerdict; why: ScraptfTimingWhy; pick: TimingPick | null; uncertainty: ScraptfTimingUncertainty | null } {
  const { table, ageMs: age, open, R, M, c0, c1, evBuy, lookGap } = a;
  if (R === null) return { verdict: 'no-buyers', why: 'no-buyers', pick: null, uncertainty: null };
  const atRisk = scraptfAtRiskAt(table, age);
  let notEnough: ScraptfTimingWhy | null = null;
  let eligible: number[] = [];
  if (a.now - open.lastAt > HISTORY_LAST_SEEN_STALE_MS) notEnough = 'stale-save';
  else if (open.startPrevAt === null) notEnough = 'left-censored';
  else if (table.drops < SCRAPTF_TIMING_MIN_DROPS || table.dropCopies < SCRAPTF_TIMING_MIN_COPIES) notEnough = 'few-drops';
  else if (table.ended < SCRAPTF_TIMING_MIN_ENDED) notEnough = 'few-ended';
  else if (atRisk < SCRAPTF_TIMING_MIN_AT_RISK) notEnough = 'few-at-risk';
  else {
    const floor = lookGap === null ? null : 2 * Math.max(lookGap, table.resolutionMs ?? 0);
    const A = floor === null ? [] : SCRAPTF_TIMING_HORIZONS_MS.filter((H) => H >= floor);
    const S0 = scraptfTimingAt(table, age).S;
    // Past the last events the curve is flat and rests on one or two states.
    const B = A.filter((H) => S0 > 0 && age + H <= table.maxMs && scraptfAtRiskAt(table, age + H) >= SCRAPTF_TIMING_MIN_AT_RISK_END);
    // At least half of the window (from the copy's last save) must still be ahead of the user.
    const C = B.filter((H) => a.now - open.lastAt <= H / 2);
    if (A.length === 0) notEnough = 'sparse-saves';
    else if (B.length === 0) notEnough = 'past-data';
    else if (C.length === 0) notEnough = 'stale-save';
    eligible = C;
  }
  if (notEnough !== null) return { verdict: 'not-enough-data', why: notEnough, pick: null, uncertainty: null };
  const at0 = scraptfTimingAt(table, age);
  const g = scraptfTimingAt(table, lookGap!);
  // The dropped price is neither gone nor risen again by the user's next look.
  const q = g.S + g.F_drop;
  let pick: TimingPick | null = null;
  for (const H of eligible) {
    const e = scraptfTimingAt(table, age + H);
    const pDrop = (e.F_drop - at0.F_drop) / at0.S;
    const pGone = (e.F_gone - at0.F_gone) / at0.S;
    const pRise = (e.F_rise - at0.F_rise) / at0.S;
    const pNone = e.S / at0.S;
    const ev = scraptfTimingEv({ revenueScrap: R, costScrap: c0, nextScrap: c1 ?? c0, pDrop, pNone, q, profit: a.profit });
    if (pick === null || ev.evWaitScrap > pick.evWait) pick = { H, pDrop, pGone, pRise, pNone, evWait: ev.evWaitScrap };
  }
  const best = pick!;
  // Against the better of buying now and not buying: buying at a loss is never the alternative to waiting.
  const base = Math.max(0, evBuy ?? 0);
  const within = M !== null && (c0 <= M || (c1 !== null && c1 <= M));
  const onEstimate = within && best.evWait - base >= waitGainBar(base);
  let uncertainty: ScraptfTimingUncertainty | null = null;
  let gainLowScrap: Scrap | null = null;
  let gate: GateDrop | null = null;
  if (a.ranges || onEstimate) {
    const sp = scraptfTimingSpreadOf(table, age, age + best.H, lookGap);
    const pDropRange = scraptfShareRange(sp.pDrop, sp.dropVar, sp.states, sp.copies);
    const pOutRange = scraptfShareRange(sp.pOut, sp.outVar, sp.states, sp.copies);
    if (onEstimate) {
      // T9-3b: at the drop size's own low end (a false Wait is the costlier error); the pick and the bar keep c1.
      gate = a.gateDrop();
      // gain = pDrop q N + pNone B - B = pDrop (qN - B) - pOut B, N the profit after a drop; q's own spread included.
      const N = Math.max(0, flipProfit(R, gate ? gate.c1 : (c1 ?? c0), a.profit) ?? 0);
      const x = q * N - base;
      const y = -base;
      const w = -N * best.pDrop;
      // Review: a share whose jackknife says nothing (one item behind the window, every copy the same, p at 0 or 1) is
      // never exact: it is taken at its shown range's far end, as a spread of its own beside the others' (no covariance).
      // Taken alone that is the zero-variance fallback it replaces (pDrop at its low end); beside q's spread it stays.
      const dropFlat = shareSpreadless(sp.pDrop, sp.dropVar, sp.copies);
      const outFlat = shareSpreadless(sp.pOut, sp.outVar, sp.copies);
      const dropVar = dropFlat ? spreadlessVar(sp.pDrop, pDropRange, x) : sp.dropVar;
      const outVar = outFlat ? spreadlessVar(sp.pOut, pOutRange, y) : sp.outVar;
      const variance =
        x * x * dropVar +
        y * y * outVar +
        w * w * sp.qOutVar +
        (dropFlat || outFlat ? 0 : 2 * x * y * sp.dropOutCov) +
        (dropFlat ? 0 : 2 * x * w * sp.dropQOutCov) +
        (outFlat ? 0 : 2 * y * w * sp.outQOutCov);
      const gain = best.pDrop * q * N + best.pNone * base - base;
      gainLowScrap = Math.floor(gain - SCRAPTF_TIMING_Z * Math.sqrt(Math.max(0, variance)) + 1e-9);
    }
    if (sp.copies > 0) {
      uncertainty = {
        pDrop: pDropRange,
        pGoneOrRose: pOutRange,
        copies: sp.copies,
        gainLowScrap,
        ...(gate ? { dropLow: gate.dropLow, dropSizeFrom: gate.from } : {}),
      };
    }
  }
  if (onEstimate && gainLowScrap !== null && gainLowScrap >= SCRAPTF_WAIT_MIN_GAIN_LOW_SCRAP) {
    return { verdict: 'wait', why: c0 > M! ? 'drop-makes-flip' : 'drop-likely', pick, uncertainty };
  }
  if (M === null || c0 > M) return { verdict: 'over', why: onEstimate ? 'unsure-gain' : 'over', pick, uncertainty };
  // 'gone-risk' only when the window saw a gone or a rise: with no event at all, 0 >= 0 is no evidence.
  const goneOrRose = best.pGone + best.pRise;
  return { verdict: 'buy-now', why: onEstimate ? 'unsure-gain' : goneOrRose > 0 && goneOrRose >= best.pDrop ? 'gone-risk' : 'flip-now', pick, uncertainty };
}

/**
 * 0.8 (T3): one copy's verdict from its lifecycle and the pooled table, judged at `now` against `buy` (Sells for R,
 * Pay up to M). The copy's last state must be its open one (scraptfTimingForKey checks). In order:
 * 1. no revenue: 'no-buyers';
 * 2. 'not-enough-data': 'stale-save' (its newest save over HISTORY_LAST_SEEN_STALE_MS old), 'left-censored',
 *    'few-drops' (under SCRAPTF_TIMING_MIN_DROPS drops or SCRAPTF_TIMING_MIN_COPIES items), 'few-ended',
 *    'few-at-risk' (at its age a), then the horizons: A, H >= 2 max(look gap, resolution) ('sparse-saves');
 *    B, S(a) > 0, a + H within the data and SCRAPTF_TIMING_MIN_AT_RISK_END still at risk there ('past-data');
 *    C, now - its newest save <= H / 2 ('stale-save');
 * 3. per eligible H, pDrop / pGone / pRise / pNone from the table conditioned on a; c1 after the copy's own median drop
 *    (with SCRAPTF_OWN_MIN_DROPS own drops) or the table's; q = S + F_drop at the look gap; the best H by evWait
 *    (scraptfTimingEv), a tie to the shorter;
 * 4. 'wait' when c0 or c1 is within M, the gain on the estimate (evWait - max(evBuy, 0): buying at a loss is never the
 *    alternative) is at least waitGainBar, and (0.9, #10) the gain's low end (scraptfTimingSpreadOf: the copy-clustered
 *    infinitesimal jackknife, q's spread included, a share it says nothing of (one copy, p at 0 or 1, no variance) at
 *    its range's far end, SCRAPTF_TIMING_Z one-sided) is at least SCRAPTF_WAIT_MIN_GAIN_LOW_SCRAP
 *    whole scrap ('drop-makes-flip' when only c1 is within M); 0.8's fixed pDrop >= 0.3 is gone. T9-3b: that low end
 *    takes c1 after the drop size's own low end (scraptfDropLowOf over the same drops as the point size, at most it),
 *    while the pick and the bar keep the point size;
 * 5. 'over' above M (or without M): 'unsure-gain' when only the low end failed, else 'over';
 * 6. else 'buy-now': 'unsure-gain' when only the low end failed, 'gone-risk' when pGone + pRise > 0 and >= pDrop,
 *    else 'flip-now'.
 * `uncertainty` (the 90 % ranges and the low end) is filled whenever a horizon was picked. With `tableLeft`,
 * `saveTiming` names the other decision the same steps give on the 'left' table at the copy's left age
 * (lastAt - startPrevAt); a not-enough-data result there is no flag, and the flag never changes the verdict.
 * The other fields (steps, cadence, earlier runs, n) are filled for every verdict wherever they can be computed.
 */
export function scraptfBuyTimingOf(a: {
  bank: ScraptfBank;
  copy: ScraptfCopyLifecycle;
  table: ScraptfTimingTable;
  buy: ScraptfEventBuySide | null;
  profit: CeilingSettings;
  keyScrap: Scrap;
  lookGapMs: number | null;
  now: UnixMs;
  /** 0.9 (#10): the same pool with 'left' placement (scraptfTimingTableFor(..., 'left')), built on first need; absent or null: no saveTiming. */
  tableLeft?: (() => ScraptfTimingTable) | null;
}): ScraptfBuyTiming {
  const { copy, table } = a;
  const open = copy.states[copy.states.length - 1];
  if (!open) throw new RangeError('scraptfBuyTimingOf needs a copy with a price state');
  const K = keyScrapOf(a.keyScrap);
  const c0 = valueOf(open.raw, K);
  const age = Math.max(0, open.lastAt - open.startAt);
  const R = a.buy && finite(a.buy.revenueScrap) ? a.buy.revenueScrap : null;
  const M = a.buy && finite(a.buy.maxCostScrap) ? a.buy.maxCostScrap : null;
  const lookGap = finite(a.lookGapMs) && a.lookGapMs >= 0 ? a.lookGapMs : null;
  const atRisk = scraptfAtRiskAt(table, age);

  // The drop size: the copy's own median over its reprice-downs and arrivals, else the pooled one.
  const ownDropStates = copy.states.filter((s) => s.outcome === 'reprice-down' || s.outcome === 'arrival');
  const ownPcts = ownDropStates.map((s) => dropPctOf(s, K)).filter(finite);
  const ownMedian = ownPcts.length >= SCRAPTF_OWN_MIN_DROPS ? median(ownPcts) : null;
  const dropPct = ownMedian ?? table.medianDropPct;
  const dropPctSource: 'own' | 'bank' | null = ownMedian !== null ? 'own' : dropPct !== null ? 'bank' : null;
  const c1 = dropPct !== null ? Math.round(c0 * (1 - dropPct)) : null;
  const evBuy = R !== null ? flipProfit(R, c0, a.profit) : null;
  // T9-3b: the Wait gate's drop size, at its low end over the same drops (the copy's own, else the pool's), worked out
  // only when the gate runs. Never over the point size: the short-bracket drops' bound may sit above the median of all.
  let gate: GateDrop | null | undefined;
  const gateDrop = (): GateDrop | null => {
    if (gate !== undefined) return gate;
    let low: ScraptfDropLow | null = null;
    if (ownMedian !== null) {
      const sized = ownDropStates
        .map((s) => ({ pct: dropPctOf(s, K), br: s.endAt === null ? Number.POSITIVE_INFINITY : s.endAt - s.lastAt }))
        .filter((x): x is { pct: number; br: number } => finite(x.pct))
        .sort((x, y) => x.pct - y.pct || x.br - y.br);
      low = scraptfDropLowOf(sized.map((x) => x.pct), sized.map((x) => x.br), lookGap);
    } else if (dropPct !== null) low = scraptfTableDropLowOf(table, lookGap);
    if (low === null || dropPct === null) return (gate = null);
    const d = Math.min(low.dropLow, dropPct);
    return (gate = { c1: Math.round(c0 * (1 - d)), dropLow: d, from: low.from });
  };

  // The current run chain (runs joined by a flap are one listing) and its reprice-downs.
  const runs = copy.runs;
  let chainStart = runs.length - 1;
  while (chainStart > 0 && runs[chainStart - 1]!.flap) chainStart--;
  const allSteps: ScraptfDropStep[] = [];
  for (let i = 0; i + 1 < copy.states.length; i++) {
    const s = copy.states[i]!;
    if (s.outcome !== 'reprice-down' || s.nextRaw === null || s.endAt === null || copy.states[i + 1]!.run < chainStart) continue;
    const from = valueOf(s.raw, K);
    const to = valueOf(s.nextRaw, K);
    allSteps.push({ at: s.endAt, prevAt: s.lastAt, fromScrap: from, toScrap: to, pct: from > 0 ? (to - from) / from : null });
  }
  // The steps since the last run's first save (scraptfRunsOf's listedSince, which a flap restarts): a row's baseline.
  const listedAt = runs.length > 0 ? runs[runs.length - 1]!.firstOnSaleAt : null;
  const dropsSinceListed = listedAt === null ? allSteps.length : allSteps.filter((st) => st.at > listedAt).length;

  // Cadence: the copy's own rhythm only when it is regular and not the user's save rhythm.
  let cadenceMs: number | null = null;
  let cadenceSource: 'own' | 'bank' | null = null;
  let nextDropAt: UnixMs | null = null;
  const own = copy.states.filter(
    (s) => s.outcome === 'reprice-down' && s.endAt !== null && s.cutAt === null && s.startPrevAt !== null && !s.wideStart && s.startAt - s.startPrevAt <= SCRAPTF_TIMING_MAX_BRACKET_MS,
  );
  if (own.length >= SCRAPTF_OWN_MIN_DROPS && lookGap !== null) {
    const ds = own.map((s) => s.endAt! - s.startAt);
    const mean = ds.reduce((x, y) => x + y, 0) / ds.length;
    const sd = Math.sqrt(ds.reduce((x, y) => x + (y - mean) ** 2, 0) / ds.length);
    const med = median(ds)!;
    const bracket = median(own.map((s) => s.endAt! - s.lastAt)) ?? 0;
    if (mean > 0 && sd / mean <= SCRAPTF_OWN_CADENCE_MAX_CV && med >= SCRAPTF_OWN_CADENCE_MIN_BRACKETS * bracket && med >= SCRAPTF_OWN_CADENCE_MIN_LOOKS * lookGap) {
      cadenceMs = med;
      cadenceSource = 'own';
      nextDropAt = open.startAt + med;
    }
  }
  if (cadenceSource === null && table.drops >= SCRAPTF_TIMING_MIN_DROPS && table.medianToDropMs !== null) {
    // Biased short (only the states that did drop), so it gets no date.
    cadenceMs = table.medianToDropMs;
    cadenceSource = 'bank';
  }

  const earlierRunEnds: ScraptfBuyTiming['earlierRunEnds'] = [];
  for (let i = runs.length - 1; i >= 0 && earlierRunEnds.length < SCRAPTF_TIMING_RUN_ENDS_MAX; i--) {
    const r = runs[i]!;
    if (r.flap || r.endedAt === null || r.endedAs === null) continue;
    earlierRunEnds.push({ endedAt: r.endedAt, endedAs: r.endedAs, lastScrap: valueOf(r.endRaw, K) });
  }

  // The verdict (steps 1-6), then (0.9, #10) the same rules with every price change at the left end of its bracket.
  const main = timingVerdictOf({ table, ageMs: age, open, R, M, c0, c1, evBuy, lookGap, now: a.now, profit: a.profit, ranges: true, gateDrop });
  const { verdict, why } = main;
  const chosen = main.pick;
  let saveTiming: ScraptfSaveTimingAlt | null = null;
  // Only a decision can depend on save timing, and 'over' only when the dropped price is within Pay up to (c0 and c1 do
  // not depend on timing, so no placement can make a plain 'over' a 'wait').
  const canTurn = verdict === 'wait' || verdict === 'buy-now' || (verdict === 'over' && M !== null && c1 !== null && c1 <= M);
  if (a.tableLeft && canTurn && open.startPrevAt !== null) {
    const alt = timingVerdictOf({
      table: a.tableLeft(),
      ageMs: Math.max(0, open.lastAt - open.startPrevAt),
      open,
      R,
      M,
      c0,
      c1,
      evBuy,
      lookGap,
      now: a.now,
      profit: a.profit,
      ranges: false,
      gateDrop,
    });
    if (alt.verdict !== verdict && (alt.verdict === 'wait' || alt.verdict === 'buy-now' || alt.verdict === 'over')) {
      saveTiming = { verdict: alt.verdict, why: alt.why, horizonMs: alt.pick?.H ?? null };
    }
  }
  return {
    verdict,
    why,
    bank: a.bank,
    key: copy.key,
    costScrap: c0,
    revenueScrap: R,
    maxCostScrap: M,
    priceSince: open.startAt,
    pricePrevAt: open.startPrevAt,
    lastSeenAt: open.lastAt,
    ageMs: age,
    horizonMs: chosen?.H ?? null,
    pDrop: chosen?.pDrop ?? null,
    pGone: chosen?.pGone ?? null,
    pRise: chosen?.pRise ?? null,
    pNone: chosen?.pNone ?? null,
    dropPct,
    dropPctSource,
    expectedNextScrap: c1,
    evBuyScrap: evBuy,
    evWaitScrap: chosen?.evWait ?? null,
    dropsThisRun: allSteps.length,
    dropsSinceListed,
    steps: allSteps.slice(-SCRAPTF_TIMING_STEPS_MAX),
    cadenceMs,
    cadenceSource,
    nextDropAt,
    earlierRunEnds,
    scope: table.scope,
    lookGapMs: lookGap,
    resolutionMs: table.resolutionMs,
    n: {
      states: table.states,
      copies: table.copies,
      ended: table.ended,
      drops: table.drops,
      dropCopies: table.dropCopies,
      gone: table.gone,
      rose: table.rose,
      atRisk,
      atRiskEnd: chosen ? scraptfAtRiskAt(table, age + chosen.H) : null,
      ownDrops: ownDropStates.length,
      imprecise: table.imprecise,
      wideGap: table.wideGap,
    },
    ...(main.uncertainty ? { uncertainty: main.uncertainty } : {}),
    ...(saveTiming ? { saveTiming } : {}),
  };
}

// ---------------------------------------------------------------------------
// T4: entry points shared by the service and the mock
// ---------------------------------------------------------------------------

/**
 * 0.8 (T4): one copy's verdict, or null (no such copy, not on sale on its newest observation, the open state is a
 * family row). The table is the copy's band or the bank (scraptfTimingTableFor) and the look gap its home page's.
 * 0.9: the 'left' table for the save-timing check is passed lazily.
 */
export function scraptfTimingForKey(a: {
  cycles: ScraptfBankCycles;
  key: string;
  buy: ScraptfEventBuySide | null;
  profit: CeilingSettings;
  keyScrap: Scrap;
  now: UnixMs;
}): ScraptfBuyTiming | null {
  const life = a.cycles.life;
  const copy = life.copies.get(a.key);
  if (!copy || !copy.onSale) return null;
  const open = copy.states[copy.states.length - 1];
  if (!open || open.outcome !== 'open' || open.family) return null;
  const K = keyScrapOf(a.keyScrap);
  return scraptfBuyTimingOf({
    bank: a.cycles.bank,
    copy,
    table: scraptfTimingTableFor(a.cycles, valueOf(open.raw, K), K),
    tableLeft: () => scraptfTimingTableFor(a.cycles, valueOf(open.raw, K), K, 'left'),
    buy: a.buy,
    profit: a.profit,
    keyScrap: K,
    lookGapMs: scraptfCyclesLookGapMs(a.cycles, copy.home),
    now: a.now,
  });
}

/**
 * 0.8 (T4): what a row carries of a verdict: its newest SCRAPTF_TIMING_BRIEF_STEPS steps, the drops since the row's
 * listing began, the save it rests on, the pool's scope (titles say "of similar value" for a band) and four n fields.
 * 0.9 (#10): and the ranges and the save-timing flag when the timing has them.
 */
export function scraptfTimingBrief(t: ScraptfBuyTiming): ScraptfTimingBrief {
  return {
    verdict: t.verdict,
    why: t.why,
    bank: t.bank,
    key: t.key,
    dropsThisRun: t.dropsThisRun,
    dropsSinceListed: t.dropsSinceListed ?? t.dropsThisRun,
    steps: t.steps.slice(-SCRAPTF_TIMING_BRIEF_STEPS),
    lastSeenAt: t.lastSeenAt,
    horizonMs: t.horizonMs,
    pDrop: t.pDrop,
    pGone: t.pGone,
    pRise: t.pRise,
    nextDropAt: t.nextDropAt,
    scope: t.scope,
    n: { states: t.n.states, copies: t.n.copies, atRisk: t.n.atRisk, dropCopies: t.n.dropCopies },
    costScrap: t.costScrap,
    maxCostScrap: t.maxCostScrap,
    ...(t.uncertainty ? { uncertainty: t.uncertainty } : {}),
    ...(t.saveTiming ? { saveTiming: t.saveTiming } : {}),
  };
}

/**
 * 0.8 (LC-4): how long items stayed listed in a bank, Kaplan-Meier over its listings: listing runs with flap chains
 * joined (first.firstOnSaleAt to last.endedAt). A listing is left out ('imprecise') only on the start side: started at
 * the first save of its page, begun after a gap over its page's gap limit (wideStart), a start bracket over
 * SCRAPTF_TIMING_MAX_BRACKET_MS, or a family run. One with a cutAt
 * (the first among its runs) is censored there ('wideGap') whatever came after; one still listed is censored at its
 * last on-sale save. With fewer than SCRAPTF_TIMING_MIN_ENDED ended listings: reason 'not-enough-data', the figures
 * null and the counts still filled. The curve keeps at most SCRAPTF_TURNOVER_CURVE_MAX points (the last always).
 */
export function scraptfTurnoverOf(life: ScraptfBankLifecycle, bank: ScraptfBank): ScraptfTurnover {
  const used: { d: number; ended: boolean; br: number }[] = [];
  let imprecise = 0;
  let wideGap = 0;
  let ended = 0;
  let open = 0;
  let droppedEnded = 0;
  let since: UnixMs | null = null;
  for (const copy of life.copies.values()) {
    const runs = copy.runs;
    for (let i = 0; i < runs.length; ) {
      let j = i;
      while (j < runs.length - 1 && runs[j]!.flap) j++;
      const first = runs[i]!;
      const last = runs[j]!;
      let cutAt: UnixMs | null = null;
      let drops = 0;
      for (let k = i; k <= j; k++) {
        const r = runs[k]!;
        if (cutAt === null && r.cutAt !== undefined) cutAt = r.cutAt;
        drops += r.drops;
      }
      i = j + 1;
      if (first.family || first.startAfter === null || first.wideStart || first.firstOnSaleAt - first.startAfter > SCRAPTF_TIMING_MAX_BRACKET_MS) {
        imprecise++;
        continue;
      }
      const startBracket = Math.max(0, first.firstOnSaleAt - first.startAfter);
      if (since === null || first.firstOnSaleAt < since) since = first.firstOnSaleAt;
      if (cutAt !== null) {
        wideGap++;
        used.push({ d: Math.max(0, cutAt - first.firstOnSaleAt), ended: false, br: startBracket });
      } else if (last.endedAt !== null) {
        ended++;
        if (drops > 0) droppedEnded++;
        used.push({ d: Math.max(0, last.endedAt - first.firstOnSaleAt), ended: true, br: Math.max(startBracket, last.endedAt - last.lastOnSaleAt) });
      } else {
        open++;
        used.push({ d: Math.max(0, last.lastOnSaleAt - first.firstOnSaleAt), ended: false, br: startBracket });
      }
    }
  }
  const counts = { bank, ended, open, wideGap, imprecise, since };
  if (ended < SCRAPTF_TIMING_MIN_ENDED) {
    return { ...counts, p25Ms: null, medianMs: null, p75Ms: null, resolutionMs: null, curve: [{ atMs: 0, stillListed: 1 }], droppedBeforeGoneShare: null, reason: 'not-enough-data' };
  }
  used.sort((x, y) => x.d - y.d);
  const n = used.length;
  const points: { atMs: number; stillListed: number }[] = [{ atMs: 0, stillListed: 1 }];
  let s = 1;
  for (let i = 0; i < n; ) {
    const d = used[i]!.d;
    let j = i;
    let events = 0;
    for (; j < n && used[j]!.d === d; j++) if (used[j]!.ended) events++;
    if (events > 0) {
      s *= 1 - events / (n - i);
      if (points[points.length - 1]!.atMs === d) points[points.length - 1]!.stillListed = s;
      else points.push({ atMs: d, stillListed: s });
    }
    i = j;
  }
  const firstAtOrBelow = (level: number): number | null => points.find((p) => p.stillListed <= level)?.atMs ?? null;
  let curve = points;
  if (points.length > SCRAPTF_TURNOVER_CURVE_MAX) {
    // Evenly subsampled; the first and the last point always kept.
    curve = [];
    for (let k = 0; k < SCRAPTF_TURNOVER_CURVE_MAX; k++) curve.push(points[Math.round((k * (points.length - 1)) / (SCRAPTF_TURNOVER_CURVE_MAX - 1))]!);
  }
  return {
    ...counts,
    p25Ms: firstAtOrBelow(0.75),
    medianMs: firstAtOrBelow(0.5),
    p75Ms: firstAtOrBelow(0.25),
    // Over the listings that add time at risk (a censoring at 0 says nothing about timing).
    resolutionMs: median(used.filter((u) => u.d > 0 || u.ended).map((u) => u.br)),
    curve,
    droppedBeforeGoneShare: ended > 0 ? droppedEnded / ended : null,
  };
}

/** 0.8 (LC-4): the bank's turnover, built on first use and kept on `c.turnover`. */
export function scraptfBankTurnover(c: ScraptfBankCycles): ScraptfTurnover {
  if (c.turnover === null) c.turnover = scraptfTurnoverOf(c.life, c.bank);
  return c.turnover;
}

/**
 * 0.8 (LC-3/T1/LC-5): ScraptfItemHistory.cycles for one copy of the bank, or null when the bank's saves never listed
 * it: its newest SCRAPTF_ITEM_RUNS_MAX runs (oldest first), the times it came back, the saves that showed a
 * reprice-down (the chart's down markers) and whether the bank's asset ids are stable.
 */
export function scraptfItemCyclesOf(c: ScraptfBankCycles, key: string): ScraptfItemCycles | null {
  const copy = c.life.copies.get(key);
  if (!copy) return null;
  const dropAts: UnixMs[] = [];
  for (const s of copy.states) if (s.outcome === 'reprice-down' && s.endAt !== null) dropAts.push(s.endAt);
  return {
    runs: copy.runs.slice(-SCRAPTF_ITEM_RUNS_MAX).map((r) => ({ ...r })),
    runsTotal: copy.runs.length,
    returns: copy.returns,
    dropAts,
    assetIdsStable: c.life.assetStability.stable,
  };
}

/**
 * 0.8 (T3/T4): the drawer's two fields for an item history, identically in the service and the mock: {} when h.bank
 * is null or cyclesOf(bank) is null; else its cycles (absent when the bank never listed the copy) and its timing (null
 * without profit settings, or when scraptfTimingForKey gives none).
 */
export function scraptfItemTimingOf(
  h: Pick<ScraptfItemHistory, 'sku' | 'specialKey' | 'bank'>,
  a: { cyclesOf(bank: ScraptfBank): ScraptfBankCycles | null; buy: ScraptfEventBuySide | null; profit: CeilingSettings | null; keyScrap: Scrap; now: UnixMs },
): Pick<ScraptfItemHistory, 'cycles' | 'timing'> {
  if (h.bank === null) return {};
  const c = a.cyclesOf(h.bank);
  if (!c) return {};
  const key = bankStockKey(h.sku, h.specialKey);
  const cycles = scraptfItemCyclesOf(c, key);
  const timing = a.profit ? scraptfTimingForKey({ cycles: c, key, buy: a.buy, profit: a.profit, keyScrap: a.keyScrap, now: a.now }) : null;
  return { ...(cycles ? { cycles } : {}), timing };
}

/**
 * 0.8 (T4): Opportunity.timing for an 'import' row (null for 'user'/'rule'): the copy it prices (base =
 * bankStockTargetOf(o.sku)?.base ?? o.sku, special = o.copyKey ?? '') judged against its own Sells for and Pay up to.
 */
export function scraptfOpportunityTiming(
  o: Pick<Opportunity, 'sku' | 'copyKey' | 'inputKind' | 'revenueScrap' | 'maxCostScrap'>,
  timingForCopy: (base: string, special: string, buy: ScraptfEventBuySide, now: UnixMs) => ScraptfBuyTiming | null,
  now: UnixMs,
): ScraptfTimingBrief | null {
  if (o.inputKind !== 'import') return null;
  const base = bankStockTargetOf(o.sku)?.base ?? o.sku;
  const t = timingForCopy(base, o.copyKey ?? '', { revenueScrap: o.revenueScrap, maxCostScrap: o.maxCostScrap }, now);
  return t ? scraptfTimingBrief(t) : null;
}
