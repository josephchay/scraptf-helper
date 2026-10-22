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
  ScraptfTimingBrief,
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
/** ...and at least this share of the profit now... */
export const SCRAPTF_WAIT_MIN_GAIN_SHARE = 0.1;
/** ...and a drop first within the horizon at least this likely. */
export const SCRAPTF_WAIT_MIN_P_DROP = 0.3;
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
}

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
 */
export function scraptfTimingTableOf(states: readonly ScraptfPriceState[], keyScrap: Scrap, scope: 'band' | 'bank'): ScraptfTimingTable {
  const K = keyScrapOf(keyScrap);
  const used: { d: number; e: 0 | 1 | 2 | 3; br: number }[] = [];
  const copies = new Set<string>();
  const dropCopies = new Set<string>();
  const dropPcts: number[] = [];
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
    copies.add(s.key);
    if (s.cutAt !== null) {
      wideGap++;
      used.push({ d: Math.max(0, s.cutAt - s.startAt), e: 0, br: startBracket });
      continue;
    }
    const e = s.endAt === null ? 0 : eventOf(s.outcome);
    if (e === 0) {
      used.push({ d: Math.max(0, s.lastAt - s.startAt), e: 0, br: startBracket });
      continue;
    }
    const d = Math.max(0, s.endAt! - s.startAt);
    used.push({ d, e, br: Math.max(startBracket, s.endAt! - s.lastAt) });
    if (e === 1) {
      drops++;
      dropCopies.add(s.key);
      toDrop.push(d);
      const pct = dropPctOf(s, K);
      if (pct !== null) dropPcts.push(pct);
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
  };
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
// The per-bank cache (service and mock)
// ---------------------------------------------------------------------------

/** 0.8: one bank's lifecycle and the estimators built over it on first use (the history index and the mock cache one per bank). */
export interface ScraptfBankCycles {
  bank: ScraptfBank;
  life: ScraptfBankLifecycle;
  /** Pooled tables, keyed `${keyScrap}|${bucket}` ('*' for the whole bank); cleared past SCRAPTF_TIMING_TABLES_MAX. */
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
 */
export function scraptfTimingTableFor(c: ScraptfBankCycles, valueScrapIn: Scrap, keyScrap: Scrap): ScraptfTimingTable {
  const K = keyScrapOf(keyScrap);
  const b = bucketOf(valueScrapIn);
  const all = (): ScraptfPriceState[] => {
    const out: ScraptfPriceState[] = [];
    for (const copy of c.life.copies.values()) for (const s of copy.states) out.push(s);
    return out;
  };
  const band = cachedTable(c, `${K}|${b}`, () =>
    scraptfTimingTableOf(
      all().filter((s) => Math.abs(bucketOf(valueOf(s.raw, K)) - b) <= 1),
      K,
      'band',
    ),
  );
  if (band.ended >= SCRAPTF_TIMING_MIN_ENDED) return band;
  return cachedTable(c, `${K}|*`, () => scraptfTimingTableOf(all(), K, 'bank'));
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
 * 4. 'wait' with a gain over waitGainBar, pDrop >= SCRAPTF_WAIT_MIN_P_DROP and c0 or c1 within M ('drop-makes-flip'
 *    when only c1 is);
 * 5. 'over' above M (or without M);
 * 6. else 'buy-now' ('gone-risk' when pGone + pRise > 0 and >= pDrop, else 'flip-now').
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

  let verdict: ScraptfTimingVerdict;
  let why: ScraptfTimingWhy;
  let pick: { H: number; pDrop: number; pGone: number; pRise: number; pNone: number; evWait: Scrap } | null = null;
  if (R === null) {
    verdict = 'no-buyers';
    why = 'no-buyers';
  } else {
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
    if (notEnough !== null) {
      verdict = 'not-enough-data';
      why = notEnough;
    } else {
      const at0 = scraptfTimingAt(table, age);
      const g = scraptfTimingAt(table, lookGap!);
      // The dropped price is neither gone nor risen again by the user's next look.
      const q = g.S + g.F_drop;
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
      const buyNow = evBuy ?? 0;
      if (best.evWait - buyNow >= waitGainBar(buyNow) && best.pDrop >= SCRAPTF_WAIT_MIN_P_DROP && M !== null && (c0 <= M || (c1 !== null && c1 <= M))) {
        verdict = 'wait';
        why = c0 > M ? 'drop-makes-flip' : 'drop-likely';
      } else if (M === null || c0 > M) {
        verdict = 'over';
        why = 'over';
      } else {
        verdict = 'buy-now';
        // 'gone-risk' only when the window saw a gone or a rise: with no event at all, 0 >= 0 is no evidence.
        const goneOrRose = best.pGone + best.pRise;
        why = goneOrRose > 0 && goneOrRose >= best.pDrop ? 'gone-risk' : 'flip-now';
      }
    }
  }
  const chosen = pick as { H: number; pDrop: number; pGone: number; pRise: number; pNone: number; evWait: Scrap } | null;
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
  };
}

// ---------------------------------------------------------------------------
// T4: entry points shared by the service and the mock
// ---------------------------------------------------------------------------

/**
 * 0.8 (T4): one copy's verdict, or null (no such copy, not on sale on its newest observation, the open state is a
 * family row). The table is the copy's band or the bank (scraptfTimingTableFor) and the look gap its home page's.
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
