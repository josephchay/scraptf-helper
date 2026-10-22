// 0.9 (#10): honest uncertainty in buy timing (src/shared/scraptfTiming.ts). The copy-clustered infinitesimal
// jackknife of the Aalen-Johansen shares (checked against finite differences), the Wilson ranges at the effective
// sample size, the Wait gate on the gain's one-sided low end (which replaces 0.8's pDrop >= 0.3) taken at the drop
// size's own low end (T9-3b: the order-statistic bound, from the short-bracket drops when there are enough), the
// 'unsure-gain' why, the 'left' placement and the save-timing flag. Estimates from the user's saves, never forecasts.
// Pure; no network, no scrap.tf.

import { describe, expect, it } from 'vitest';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { ScraptfCopyLifecycle, ScraptfPriceState, ScraptfSaveRows, ScraptfStateOutcome } from '../../src/shared/scraptfHistory';
import * as timing from '../../src/shared/scraptfTiming';
import {
  SCRAPTF_DROP_LOW_ALPHA,
  SCRAPTF_DROP_SHORT_BRACKET_MIN,
  SCRAPTF_TIMING_RANGE_PCT,
  SCRAPTF_TIMING_SPREAD_CACHE_MAX,
  SCRAPTF_TIMING_Z,
  SCRAPTF_WAIT_MIN_GAIN_LOW_SCRAP,
  scraptfAtRiskAt,
  scraptfBankCyclesOf,
  scraptfBuyTimingOf,
  scraptfDropLowOf,
  scraptfMedianLowRank,
  scraptfShareRange,
  scraptfTableDropLowOf,
  scraptfTimingAt,
  scraptfTimingBrief,
  scraptfTimingForKey,
  scraptfTimingInfluenceOf,
  scraptfTimingSpreadOf,
  scraptfTimingTableFor,
  scraptfTimingTableOf,
  scraptfWilson,
  type ScraptfBankCycles,
  type ScraptfTimingTable,
} from '../../src/shared/scraptfTiming';
import type { BankStockStored, ScraptfBuyTiming } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const K = 600;
const PAGE = '/buy/hats';
const PROFIT = DEFAULT_SETTINGS.profit;
/** Sells for 120: Pay up to 111 with the default thresholds. */
const BUY = { revenueScrap: 120, maxCostScrap: maxCostFor(120, PROFIT) };

const DROPPED: ScraptfStateOutcome[] = ['reprice-down', 'arrival'];
const PRICIER: ScraptfStateOutcome[] = ['reprice-up', 'sold-cheapest'];

/** As scraptfTiming.test.ts: a pooled state of `key` at 100 scrap, started at T0 an hour after its look before. */
function st(key: string, durH: number, outcome: ScraptfStateOutcome, o: Partial<ScraptfPriceState> = {}): ScraptfPriceState {
  const end = T0 + durH * HOUR;
  const ended = outcome !== 'open';
  return {
    key,
    startAt: T0,
    startPrevAt: T0 - HOUR,
    lastAt: ended ? Math.max(T0, end - 30 * MIN) : end,
    endAt: ended ? end : null,
    raw: { keys: 0, scrap: 100 },
    stock: 1,
    outcome,
    nextRaw: DROPPED.includes(outcome) ? { keys: 0, scrap: 90 } : PRICIER.includes(outcome) ? { keys: 0, scrap: 110 } : null,
    run: 0,
    flaps: 0,
    cutAt: null,
    sameItem: null,
    ...o,
  };
}

const many = (n: number, prefix: string, durH: number, outcome: ScraptfStateOutcome, copies = n): ScraptfPriceState[] =>
  Array.from({ length: n }, (_, i) => st(`${prefix}${i % copies}`, durH, outcome));

/** The copy being judged: its states end with the open one (at 100 by default, its newest save an hour after its start). */
function copyWith(openOver: Partial<ScraptfPriceState> = {}, states: ScraptfPriceState[] = []): ScraptfCopyLifecycle {
  const open = st('me', 1, 'open', openOver);
  return {
    key: 'me',
    sku: '1;6',
    specialKey: '',
    home: PAGE,
    runs: [{ firstOnSaleAt: T0, startAfter: T0 - HOUR, lastOnSaleAt: open.lastAt, endedAt: null, endedAs: null, startRaw: open.raw, endRaw: open.raw, drops: 0, saves: 2, sameAssetAsBefore: null }],
    states: [...states, open],
    returns: 0,
    lastObsAt: open.lastAt,
    lastListedAt: open.lastAt,
    onSale: true,
  };
}

/** 14 drops at 10 h from 7 items, 2 gones at 10 h, and `open` states still at their price at `openH`. */
function rich(open = 4, openH = 200): ScraptfPriceState[] {
  return [...many(14, 'd', 10, 'reprice-down', 7), ...many(2, 'g', 10, 'gone'), ...many(open, 'o', openH, 'open')];
}

/** The verdict on a bank-scope table of `states`, with the 'left' table for the save-timing check unless `left` is false. */
function judge(states: ScraptfPriceState[], copy: ScraptfCopyLifecycle = copyWith(), left = true): ScraptfBuyTiming {
  return scraptfBuyTimingOf({
    bank: 'hats',
    copy,
    table: scraptfTimingTableOf(states, K, 'bank'),
    tableLeft: left ? () => scraptfTimingTableOf(states, K, 'bank', 'left') : null,
    buy: BUY,
    profit: PROFIT,
    keyScrap: K,
    lookGapMs: HOUR,
    now: copy.states[copy.states.length - 1]!.lastAt + HOUR,
  });
}

/** Hand-built cycles over pooled states (each key one copy), as scraptfTiming.test.ts. */
function cyclesOf(states: readonly ScraptfPriceState[]): ScraptfBankCycles {
  const copies = new Map<string, ScraptfCopyLifecycle>();
  for (const s of states) {
    let c = copies.get(s.key);
    if (!c) copies.set(s.key, (c = { key: s.key, sku: '1;6', specialKey: '', home: PAGE, runs: [], states: [], returns: 0, lastObsAt: s.lastAt, lastListedAt: s.lastAt, onSale: false }));
    c.states.push(s);
  }
  return { bank: 'hats', life: { keyStates: new Map(), copies, pageSaves: new Map(), assetStability: { pairs: 0, same: 0, share: null, stable: false }, newestSaveAt: null }, tables: new Map(), turnover: null };
}

/** A test-local weighted Aalen-Johansen over (a, b]: the base the influence must be the derivative of. */
function weighted(t: ScraptfTimingTable, w: number[], a: number, b: number): { drop: number; out: number } {
  const n = t.durations.length;
  const times = [...new Set(t.durations.filter((d, i) => d > a && d <= b && t.events[i] !== 0))].sort((x, y) => x - y);
  let s = 1;
  let f1 = 0;
  let fo = 0;
  for (const tt of times) {
    let r = 0;
    let d1 = 0;
    let dO = 0;
    for (let i = 0; i < n; i++) {
      if (t.durations[i]! >= tt) r += w[i]!;
      if (t.durations[i] === tt) {
        if (t.events[i] === 1) d1 += w[i]!;
        else if (t.events[i] !== 0) dO += w[i]!;
      }
    }
    f1 += (s * d1) / r;
    fo += (s * dO) / r;
    s *= 1 - (d1 + dO) / r;
  }
  return { drop: f1, out: fo };
}

describe('0.9 (#10): honest uncertainty in buy timing', () => {
  it('the constants, and 0.8 fixed drop chance is gone', () => {
    expect(SCRAPTF_WAIT_MIN_GAIN_LOW_SCRAP).toBe(1);
    expect(SCRAPTF_TIMING_Z).toBe(1.6448536269514722);
    expect(SCRAPTF_TIMING_RANGE_PCT).toBe(90);
    expect(SCRAPTF_TIMING_SPREAD_CACHE_MAX).toBe(4096);
    expect(SCRAPTF_DROP_LOW_ALPHA).toBe(0.05);
    expect(SCRAPTF_DROP_SHORT_BRACKET_MIN).toBe(5);
    expect('SCRAPTF_WAIT_MIN_P_DROP' in timing).toBe(false);
  });

  it('the influence is the derivative (finite differences), sums to 0 and keeps the shares', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    const outs: ScraptfStateOutcome[] = ['reprice-down', 'gone', 'reprice-up', 'open', 'arrival', 'sold-cheapest'];
    for (let trial = 0; trial < 20; trial++) {
      const states = Array.from({ length: 40 }, () => st(`c${Math.floor(rnd() * 12)}`, 1 + Math.floor(rnd() * 30), outs[Math.floor(rnd() * outs.length)]!));
      const t = scraptfTimingTableOf(states, K, 'bank');
      for (const [a, b] of [[3 * HOUR, 15 * HOUR], [-1, 20 * HOUR], [10 * HOUR, 40 * HOUR]] as const) {
        const inf = scraptfTimingInfluenceOf(t, a, b);
        const base = weighted(t, t.durations.map(() => 1), a, b);
        expect(inf.pDrop).toBeCloseTo(base.drop, 10);
        expect(inf.pOut).toBeCloseTo(base.out, 10);
        expect(inf.pDrop + inf.pOut + inf.pNone).toBeCloseTo(1, 12);
        if (a >= 0) {
          const at0 = scraptfTimingAt(t, a);
          const e = scraptfTimingAt(t, b);
          if (at0.S > 0) {
            expect(inf.pDrop).toBeCloseTo((e.F_drop - at0.F_drop) / at0.S, 10);
            expect(inf.pOut).toBeCloseTo((e.F_gone + e.F_rise - at0.F_gone - at0.F_rise) / at0.S, 10);
          }
        }
        expect(inf.drop.reduce((x, y) => x + y, 0)).toBeCloseTo(0, 12);
        expect(inf.out.reduce((x, y) => x + y, 0)).toBeCloseTo(0, 12);
        const eps = 1e-6;
        for (let c = 0; c < t.copies; c++) {
          const p = weighted(t, t.durations.map((_, i) => (t.copyIx[i] === c ? 1 + eps : 1)), a, b);
          expect(inf.drop[c]!).toBeCloseTo((p.drop - base.drop) / eps, 4);
          expect(inf.out[c]!).toBeCloseTo((p.out - base.out) / eps, 4);
        }
      }
    }
  });

  it('rich(): the spread by hand, memoised per table', () => {
    const t = scraptfTimingTableOf(rich(), K, 'bank');
    const sp = scraptfTimingSpreadOf(t, HOUR, 25 * HOUR, HOUR);
    expect(sp).toMatchObject({ states: 20, copies: 13, qOutVar: 0, dropQOutCov: 0, outQOutCov: 0 });
    expect(sp.pDrop).toBeCloseTo(0.7, 12);
    expect(sp.dropVar).toBeCloseTo((0.01365 * 13) / 12, 15);
    expect(sp.outVar).toBeCloseTo((0.00485 * 13) / 12, 15);
    expect(sp.dropOutCov).toBeCloseTo((-0.00455 * 13) / 12, 15);
    expect(scraptfTimingSpreadOf(t, HOUR, 25 * HOUR, HOUR)).toBe(sp);
  });

  it('the memo is cleared once it holds SCRAPTF_TIMING_SPREAD_CACHE_MAX windows, never changing a result', () => {
    const t = scraptfTimingTableOf(rich(), K, 'bank');
    const first = scraptfTimingSpreadOf(t, HOUR, 25 * HOUR, HOUR);
    for (let i = 1; i < SCRAPTF_TIMING_SPREAD_CACHE_MAX; i++) scraptfTimingSpreadOf(t, HOUR, 25 * HOUR + i, HOUR);
    expect(scraptfTimingSpreadOf(t, HOUR, 25 * HOUR, HOUR)).toBe(first);
    scraptfTimingSpreadOf(t, HOUR, 26 * HOUR + SCRAPTF_TIMING_SPREAD_CACHE_MAX, HOUR);
    const again = scraptfTimingSpreadOf(t, HOUR, 25 * HOUR, HOUR);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });

  it('Wilson and the share ranges', () => {
    const sp = scraptfTimingSpreadOf(scraptfTimingTableOf(rich(), K, 'bank'), HOUR, 25 * HOUR, HOUR);
    const w = scraptfWilson(0.7, 0.21 / sp.dropVar);
    expect(w.low).toBeCloseTo(0.48190267854213237, 12);
    expect(w.high).toBeCloseTo(0.8540862689973678, 12);
    expect(scraptfWilson(0, 20)).toEqual({ low: 0, high: expect.closeTo(0.11915783736096448, 12) });
    expect(scraptfWilson(1, 3)).toEqual({ low: expect.closeTo(0.5258044258424872, 12), high: 1 });
    expect(scraptfShareRange(0.1, sp.outVar, 20, 13).low).toBeCloseTo(0.03105725921200482, 12);
    // n_eff is capped at the states behind it, at the copies with p at 0 / 1 or no variance, and never under 1.
    expect(scraptfShareRange(0.5, 1e-9, 20, 13)).toEqual(scraptfWilson(0.5, 20));
    expect(scraptfShareRange(0.5, 0, 20, 13)).toEqual(scraptfWilson(0.5, 13));
    expect(scraptfShareRange(0, 0.01, 20, 13)).toEqual(scraptfWilson(0, 13));
    expect(scraptfShareRange(0.5, 0, 20, 0)).toEqual(scraptfWilson(0.5, 1));
    expect(scraptfShareRange(Number.NaN, Number.NaN, 20, 4)).toEqual({ low: 0, high: expect.any(Number) });
  });

  describe('the Wait gate: the low end replaces pDrop >= 0.3', () => {
    it('rich(): wait / drop-likely with its ranges and a low end of 1 scrap', () => {
      const r = judge(rich());
      expect(r).toMatchObject({ verdict: 'wait', why: 'drop-likely', horizonMs: DAY, evWaitScrap: 25, evBuyScrap: 20 });
      // Every drop is 10 %: the drop size's low end is the point size.
      expect(r.uncertainty).toMatchObject({ copies: 13, gainLowScrap: 1, dropLow: expect.closeTo(0.1, 12), dropSizeFrom: 'short-brackets' });
      expect(r.uncertainty!.pDrop.low).toBeCloseTo(0.48190267854213237, 12);
      expect(r.uncertainty!.pDrop.high).toBeCloseTo(0.8540862689973678, 12);
      expect(r.uncertainty!.pGoneOrRose.high).toBeCloseTo(0.27806580301342315, 12);
      expect(r.saveTiming).toBeUndefined();
    });

    it("today's price just over Pay up to: wait / drop-makes-flip", () => {
      expect(judge(rich(), copyWith({ raw: { keys: 0, scrap: 118 } }))).toMatchObject({ verdict: 'wait', why: 'drop-makes-flip', uncertainty: { gainLowScrap: 5 } });
    });

    it("pDrop 0.25 (0.8's flip-now): buy-now / unsure-gain; over Pay up to with a loss now: the baseline is max(evBuy, 0) (T9-4)", () => {
      const flipNow = [...many(5, 'd', 10, 'reprice-down'), ...many(11, 'g', 200, 'gone'), ...many(4, 'o', 300, 'open')];
      // pOut is 0 over (1 h, 25 h] (the gones are at 200 h): taken at its range's high end, not as exact (review).
      expect(judge(flipNow)).toMatchObject({ verdict: 'buy-now', why: 'unsure-gain', horizonMs: DAY, evWaitScrap: 23, uncertainty: { gainLowScrap: -1, copies: 20 } });
      expect(judge(flipNow, copyWith({ raw: { keys: 0, scrap: 123 } }))).toMatchObject({ verdict: 'over', why: 'over', evBuyScrap: -3, evWaitScrap: 2, uncertainty: { gainLowScrap: null } });
    });

    it('the gate never runs when the gain on the estimate is under the bar (gainLowScrap null, no drop size)', () => {
      const t = judge([...rich(), ...many(4, 'q', 0.5, 'gone')]);
      expect(t).toMatchObject({ verdict: 'buy-now', why: 'flip-now', uncertainty: { gainLowScrap: null } });
      expect(t.uncertainty!.dropLow).toBeUndefined();
      expect(t.uncertainty!.dropSizeFrom).toBeUndefined();
    });

    it('gone-risk keeps its ranges', () => {
      const goneRisk = [...many(5, 'd', 4, 'reprice-down'), ...many(5, 'g', 4, 'gone'), ...many(6, 'r', 4, 'reprice-up'), ...many(4, 'o', 300, 'open')];
      const gr = judge(goneRisk);
      expect(gr).toMatchObject({ verdict: 'buy-now', why: 'gone-risk', horizonMs: 6 * HOUR });
      expect(gr.uncertainty!.pGoneOrRose.low).toBeCloseTo(0.3680146168291754, 12);
      expect(gr.uncertainty!.pGoneOrRose.high).toBeCloseTo(0.7195206252170914, 12);
    });

    it('every copy says the same (no variance): each share is taken at the far end of its range at the copies', () => {
      const balanced = Array.from({ length: 16 }, (_, i) => [st(`b${i}`, 10, 'reprice-down'), st(`b${i}`, 200, 'open')]).flat();
      const bt = judge(balanced);
      expect(bt).toMatchObject({ verdict: 'wait', why: 'drop-likely', horizonMs: DAY, evWaitScrap: 25, evBuyScrap: 20 });
      expect(bt.uncertainty!.pDrop.low).toBeCloseTo(0.3098430968465716, 12);
      expect(bt.uncertainty!.pDrop.high).toBeCloseTo(0.6901569031534285, 12);
      expect(bt.uncertainty!.pGoneOrRose).toEqual(scraptfWilson(0, 16));
      const sp = scraptfTimingSpreadOf(scraptfTimingTableOf(balanced, K, 'bank'), HOUR, 25 * HOUR, HOUR);
      expect(sp).toMatchObject({ copies: 16, pOut: 0, dropVar: 0, outVar: 0, qOutVar: 0 });
      // gain = 0.5 x 10 - 0 x 20 = 5. Before review: pDrop at its low end alone (0.31 x 10 = 3.1, so 3), with pOut's
      // 0 taken as exact although its shown range reaches 14 %. Now both far ends, combined as independent spreads.
      const lowByHand = 5 - Math.hypot(10 * (0.5 - bt.uncertainty!.pDrop.low), 20 * bt.uncertainty!.pGoneOrRose.high);
      expect(lowByHand).toBeCloseTo(1.54, 2);
      expect(bt.uncertainty!.gainLowScrap).toBe(1);
    });

    it('one item behind the window (its jackknife sums to 0): the shares take their range at that item, beside q\'s spread (review)', () => {
      // Copy x0's own states are the only ones still at their price at 51 h: 6 drops at 60 h, 4 still open at 300 h.
      // The other copies end before that age; one gone inside the 1 h look gap gives q a spread of its own.
      const states = [
        ...many(6, 'x', 60, 'reprice-down', 1),
        ...many(4, 'x', 300, 'open', 1),
        ...many(5, 'd', 10, 'reprice-down'),
        st('g0', 0.5, 'gone'),
        ...many(3, 'h', 2, 'gone'),
        ...many(20, 'z', 30, 'gone'),
      ];
      const r = judge(states, copyWith({ lastAt: T0 + 51 * HOUR }));
      expect(r).toMatchObject({ horizonMs: DAY, pDrop: expect.closeTo(0.6, 12), pGone: 0, pRise: 0, evWaitScrap: 26, evBuyScrap: 20 });
      const sp = scraptfTimingSpreadOf(scraptfTimingTableOf(states, K, 'bank'), r.ageMs, r.ageMs + DAY, HOUR);
      expect(sp.copies).toBe(1);
      expect(sp.dropVar).toBeLessThan(1e-24);
      expect(sp.qOutVar).toBeGreaterThan(1e-4);
      expect(r.uncertainty).toMatchObject({ copies: 1, pDrop: scraptfWilson(0.6, 1), pGoneOrRose: scraptfWilson(0, 1) });
      // Before review: wait / drop-likely with a low end of 4 scrap, from q's spread alone (pDrop and pOut taken as exact
      // while the drawer showed 10-96 % dropped and 0-74 % went or rose first).
      expect(r).toMatchObject({ verdict: 'buy-now', why: 'unsure-gain' });
      expect(r.uncertainty!.gainLowScrap).toBe(-10);
    });

    it('no gone or rise in the window beside a spread drop share: went-or-rose takes its range at the copies (review)', () => {
      // 14 drops at 10 h from 7 items, 6 still open at 200 h, 3 gones inside the look gap: pOut = 0 over (1 h, 25 h].
      const states = [...many(14, 'd', 10, 'reprice-down', 7), ...many(6, 'o', 200, 'open'), ...many(3, 'g', 0.25, 'gone')];
      const r = judge(states);
      const sp = scraptfTimingSpreadOf(scraptfTimingTableOf(states, K, 'bank'), HOUR, 25 * HOUR, HOUR);
      expect(sp).toMatchObject({ copies: 13, pOut: 0, outVar: 0 });
      expect(sp.dropVar).toBeGreaterThan(1e-3);
      expect(r).toMatchObject({ horizonMs: DAY, pDrop: expect.closeTo(0.7, 12), evWaitScrap: 24, evBuyScrap: 20 });
      expect(r.uncertainty!.pGoneOrRose).toEqual(scraptfWilson(0, 13));
      // Went-or-rose at its shown high (17 %), all else at the estimate, already leaves under 1 scrap: 4 - 0.17 x 20.
      expect(4 - r.uncertainty!.pGoneOrRose.high * 20).toBeLessThan(1);
      // Before review: wait / drop-likely with a low end of 1 scrap (pOut's 0 taken as exact).
      expect(r).toMatchObject({ verdict: 'buy-now', why: 'unsure-gain' });
      expect(r.uncertainty!.gainLowScrap).toBe(-1);
    });
  });

  describe('T9-3b: the gate takes the drop size at its low end', () => {
    it('scraptfMedianLowRank is the exact binomial rule: the largest k with P(Binomial(n, 1/2) < k) <= 5 %, at least 1', () => {
      // Exact in BigInt: P(B < k) <= alpha  <=>  20 * sum_{i<k} C(n, i) <= 2^n.
      const exact = (n: number): number => {
        let c = 1n;
        let cum = 0n;
        let k = 1;
        const total = 2n ** BigInt(n);
        for (let i = 0; i < n; i++) {
          cum += c;
          if (20n * cum > total) break;
          k = i + 1;
          c = (c * BigInt(n - i)) / BigInt(i + 1);
        }
        return k;
      };
      for (let n = 1; n <= 300; n++) expect(scraptfMedianLowRank(n), `n ${n}`).toBe(exact(n));
      expect([1, 2, 3, 4, 5, 8, 10, 11, 14, 20].map((n) => scraptfMedianLowRank(n))).toEqual([1, 1, 1, 1, 1, 2, 2, 3, 4, 6]);
      // Large n stays finite (log space) and near the normal approximation n/2 - 0.8224 sqrt(n).
      const big = scraptfMedianLowRank(20_000);
      expect(Math.abs(big - (10_000 - 0.8224 * Math.sqrt(20_000)))).toBeLessThan(3);
      expect(scraptfMedianLowRank(0)).toBe(1);
      expect(scraptfMedianLowRank(Number.NaN)).toBe(1);
      // A stricter level only lowers the rank.
      expect(scraptfMedianLowRank(100, 0.01)).toBeLessThan(scraptfMedianLowRank(100));
    });

    it('scraptfDropLowOf: the short-bracket drops when at least 5, else all; null without a size', () => {
      const sizes = [0.03, 0.05, 0.07, 0.07, 0.07, 0.07, 0.14, 0.14];
      const short = [HOUR, HOUR, HOUR, HOUR, HOUR, HOUR, 6 * HOUR, 6 * HOUR];
      // 6 short brackets: those six only (n 6, rank 1).
      expect(scraptfDropLowOf(sizes, short, HOUR)).toEqual({ dropLow: 0.03, from: 'short-brackets', n: 6 });
      // Four short ones are too few: all eight (rank 2).
      expect(scraptfDropLowOf(sizes, [HOUR, HOUR, HOUR, HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR], HOUR)).toEqual({ dropLow: 0.05, from: 'all', n: 8 });
      // A bracket is short when no longer than the look gap; without a look gap every drop counts.
      expect(scraptfDropLowOf(sizes, short, 6 * HOUR)).toMatchObject({ from: 'short-brackets', n: 8 });
      expect(scraptfDropLowOf(sizes, short, null)).toMatchObject({ from: 'all', n: 8 });
      expect(scraptfDropLowOf([], [], HOUR)).toBeNull();
      // The merged-step correction: the long-bracket steps are the merged (bigger) ones.
      const merged = [0.07, 0.07, 0.07, 0.07, 0.07, 0.07, 0.14, 0.14, 0.14, 0.14, 0.14];
      const br = [HOUR, HOUR, HOUR, HOUR, HOUR, HOUR, 9 * HOUR, 9 * HOUR, 9 * HOUR, 9 * HOUR, 9 * HOUR];
      expect(scraptfDropLowOf(merged, br, HOUR)).toEqual({ dropLow: 0.07, from: 'short-brackets', n: 6 });
    });

    it("the table keeps its drops' sizes ascending with their end brackets, whatever the placement; memoised per (table, look gap)", () => {
      const states = [
        st('a', 4, 'reprice-down', { nextRaw: { keys: 0, scrap: 80 }, lastAt: T0 + HOUR }),
        st('b', 4, 'arrival', { nextRaw: { keys: 0, scrap: 95 } }),
        st('c', 4, 'reprice-down'),
        st('d', 4, 'gone'),
        st('e', 4, 'reprice-down', { family: true }),
      ];
      const right = scraptfTimingTableOf(states, K, 'bank');
      const left = scraptfTimingTableOf(states, K, 'bank', 'left');
      expect(right.dropSizes.map((x) => +x.toFixed(12))).toEqual([0.05, 0.1, 0.2]);
      expect(right.dropBrackets).toEqual([30 * MIN, 30 * MIN, 3 * HOUR]);
      expect(left.dropSizes).toEqual(right.dropSizes);
      expect(left.dropBrackets).toEqual(right.dropBrackets);
      const low = scraptfTableDropLowOf(right, HOUR);
      expect(low).toEqual({ dropLow: right.dropSizes[0], from: 'all', n: 3 });
      expect(scraptfTableDropLowOf(right, HOUR)).toBe(low);
      expect(scraptfTableDropLowOf(scraptfTimingTableOf([], K, 'bank'), HOUR)).toBeNull();
    });

    it("varied pooled drops: a Wait at the point size is unsure-gain at the drop size's low end", () => {
      // rich()'s timing, but 4 of its 14 drops are small: the median stays 10 %, the low end (rank 4 of 14) is 5 %.
      const pcts = [3, 3, 4, 5, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
      const varied = [...pcts.map((p, i) => st(`d${i % 7}`, 10, 'reprice-down', { nextRaw: { keys: 0, scrap: 100 - p } })), ...many(2, 'g', 10, 'gone'), ...many(4, 'o', 200, 'open')];
      const t = judge(varied, copyWith(), false);
      expect(t).toMatchObject({ verdict: 'buy-now', why: 'unsure-gain', horizonMs: DAY, evWaitScrap: 25, expectedNextScrap: 90, dropPctSource: 'bank' });
      expect(t.dropPct).toBeCloseTo(0.1, 12);
      expect(t.uncertainty!.dropLow).toBeCloseTo(0.05, 12);
      expect(t.uncertainty).toMatchObject({ dropSizeFrom: 'short-brackets', gainLowScrap: -2 });
      // The shares and their ranges do not depend on the sizes: the same as rich().
      expect(t.uncertainty!.pDrop).toEqual(judge(rich()).uncertainty!.pDrop);
    });

    it('never laxer than the point size: a short-bracket bound over the median of all is capped at it', () => {
      // 9 drops of 10 % seen across a 2 h bracket (over the 1 h look gap), 5 of 20 % across 30 min: the median of all
      // 14 is 10 %; the 5 short-bracket drops alone would bound it at 20 %.
      const drops = [
        ...Array.from({ length: 9 }, (_, i) => st(`d${i % 7}`, 10, 'reprice-down', { lastAt: T0 + 8 * HOUR })),
        ...Array.from({ length: 5 }, (_, i) => st(`d${(i + 2) % 7}`, 10, 'reprice-down', { nextRaw: { keys: 0, scrap: 80 } })),
      ];
      const t = judge([...drops, ...many(2, 'g', 10, 'gone'), ...many(4, 'o', 200, 'open')], copyWith(), false);
      expect(t).toMatchObject({ verdict: 'wait', why: 'drop-likely', expectedNextScrap: 90, uncertainty: { gainLowScrap: 1, dropSizeFrom: 'short-brackets' } });
      expect(t.uncertainty!.dropLow).toBe(t.dropPct);
      expect(t.dropPct).toBeCloseTo(0.1, 12);
    });

    it("the copy's own drops (at least 3) give the size and its low end: with 3, the smallest", () => {
      const own = [20, 20, 5].map((p) => st('me', 5, 'reprice-down', { nextRaw: { keys: 0, scrap: 100 - p } }));
      const t = judge(rich(), copyWith({}, own), false);
      expect(t).toMatchObject({ dropPctSource: 'own', expectedNextScrap: 80, verdict: 'buy-now', why: 'unsure-gain' });
      expect(t.uncertainty!.dropLow).toBeCloseTo(0.05, 12);
      expect(t.uncertainty!.dropSizeFrom).toBe('all');
      // The same own drops all at 20 %: their low end is the point size and the Wait stands.
      const even = [20, 20, 20].map((p) => st('me', 5, 'reprice-down', { nextRaw: { keys: 0, scrap: 100 - p } }));
      expect(judge(rich(), copyWith({}, even), false)).toMatchObject({ verdict: 'wait', why: 'drop-likely', uncertainty: { dropSizeFrom: 'all' } });
    });
  });

  describe("'left' placement: every price change at the left end of its bracket", () => {
    it('gives the hand example with every state measured from startPrevAt and every event at lastAt', () => {
      const L = scraptfTimingTableOf(
        [st('a', 2, 'reprice-down'), st('b', 2, 'sold-cheapest'), st('c', 3, 'reprice-up'), st('d', 4, 'reprice-down'), st('e', 4, 'arrival'), st('f', 6, 'open')],
        K,
        'bank',
        'left',
      );
      const R = scraptfTimingTableOf(
        [st('a', 2, 'reprice-down'), st('b', 2, 'sold-cheapest'), st('c', 3, 'reprice-up'), st('d', 4, 'reprice-down'), st('e', 4, 'arrival'), st('f', 6, 'open')],
        K,
        'bank',
      );
      expect(L.t).toEqual([0, 2.5 * HOUR, 3.5 * HOUR, 4.5 * HOUR]);
      expect(L.S).toEqual(R.S);
      expect(L.F_drop).toEqual(R.F_drop);
      expect(L.F_gone).toEqual(R.F_gone);
      expect(L.F_rise).toEqual(R.F_rise);
      expect(L.durations).toEqual([2.5, 2.5, 3.5, 4.5, 4.5, 7].map((h) => h * HOUR));
      expect(L).toMatchObject({ placement: 'left', states: 6, copies: 6, ended: 5, maxMs: 7 * HOUR, resolutionMs: HOUR });
      expect(R.placement).toBe('right');
      expect([...L.events]).toEqual([1, 2, 3, 1, 1, 0]);
      expect([...L.copyIx]).toEqual([0, 1, 2, 3, 4, 5]);
      const empty = scraptfTimingTableOf([], K, 'band', 'left');
      expect(empty).toMatchObject({ placement: 'left', states: 0, dropSizes: [], dropBrackets: [] });
      expect(empty.events).toHaveLength(0);
      expect(empty.copyIx).toHaveLength(0);
    });

    it("through scraptfTimingTableFor: the same scope and counts, cached beside as '…|left'", () => {
      const at = (key: string, scrap: number, outcome: ScraptfStateOutcome) => st(key, 10, outcome, { raw: { keys: 0, scrap } });
      const near = [...Array.from({ length: 6 }, (_, i) => at(`n${i}`, 100, 'gone')), ...Array.from({ length: 4 }, (_, i) => at(`m${i}`, 50, 'gone')), ...Array.from({ length: 9 }, (_, i) => at(`f${i}`, 30, 'gone'))];
      const c = cyclesOf([...near, ...Array.from({ length: 20 }, (_, i) => at(`x${i}`, 10_000, 'gone'))]);
      const right = scraptfTimingTableFor(c, 100, K);
      const left = scraptfTimingTableFor(c, 100, K, 'left');
      expect(left).toMatchObject({ scope: right.scope, ended: right.ended, states: right.states, placement: 'left' });
      expect([...c.tables.keys()].sort()).toEqual([`${K}|*`, `${K}|*|left`, `${K}|6`, `${K}|6|left`]);
      expect(scraptfTimingTableFor(c, 100, K, 'left')).toBe(left);
      const c2 = cyclesOf([...near, ...Array.from({ length: 5 }, (_, i) => at(`p${i}`, 120, 'gone'))]);
      expect(scraptfTimingTableFor(c2, 100, K, 'left')).toMatchObject({ scope: 'band', ended: 15 });
      expect(c2.tables.has(`${K}|6|left`)).toBe(true);
    });
  });

  describe('saveTiming: the decision the same rules give on the left table', () => {
    const flagStates = (): ScraptfPriceState[] => [
      ...Array.from({ length: 12 }, (_, i) => st(`d${i % 6}`, 6.5, 'reprice-down', { lastAt: T0 + 0.5 * HOUR })),
      ...many(4, 'g', 30, 'gone'),
      ...many(8, 'o', 200, 'open'),
    ];

    it('names the other decision; never changes the verdict', () => {
      const f = judge(flagStates());
      expect(f).toMatchObject({ verdict: 'wait', why: 'drop-likely', horizonMs: DAY, saveTiming: { verdict: 'buy-now', why: 'flip-now', horizonMs: DAY } });
      expect(judge(flagStates(), copyWith(), false)).toMatchObject({ verdict: 'wait', why: 'drop-likely' });
      expect(judge(flagStates(), copyWith(), false).saveTiming).toBeUndefined();
    });

    it('a not-enough-data read on the left table is no flag', () => {
      const ned = [...many(12, 'x', 1.2, 'reprice-down'), ...many(4, 'g', 10, 'gone'), ...many(3, 'o', 200, 'open')];
      const nd = judge(ned);
      expect(nd).toMatchObject({ verdict: 'wait', horizonMs: 6 * HOUR });
      expect(nd.saveTiming).toBeUndefined();
      expect(scraptfAtRiskAt(scraptfTimingTableOf(ned, K, 'bank', 'left'), 2 * HOUR)).toBe(7);
    });

    it('the left table is never built for a verdict that cannot turn (no-buyers, not-enough-data, a plain over)', () => {
      let built = 0;
      const lazy = (states: ScraptfPriceState[]) => () => {
        built++;
        return scraptfTimingTableOf(states, K, 'bank', 'left');
      };
      const run = (states: ScraptfPriceState[], copy: ScraptfCopyLifecycle, buy: typeof BUY | null) =>
        scraptfBuyTimingOf({ bank: 'hats', copy, table: scraptfTimingTableOf(states, K, 'bank'), tableLeft: lazy(states), buy, profit: PROFIT, keyScrap: K, lookGapMs: HOUR, now: copy.states[copy.states.length - 1]!.lastAt + HOUR });
      expect(run(rich(), copyWith(), null)).toMatchObject({ verdict: 'no-buyers' });
      expect(run(rich(), copyWith({ startPrevAt: null }), BUY)).toMatchObject({ verdict: 'not-enough-data', why: 'left-censored' });
      expect(run(rich(), copyWith({ raw: { keys: 0, scrap: 130 } }), BUY)).toMatchObject({ verdict: 'over', why: 'over' });
      expect(built).toBe(0);
      run(rich(), copyWith(), BUY);
      expect(built).toBe(1);
    });
  });

  describe('end to end and the brief', () => {
    let batch = 1;
    const row = (sku: string, price: number): BankStockStored => ({ sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap: price, stock: 1, assetId: null });
    /** scraptfTiming.test.ts's bank(false): 60 copies saved hourly for 10 days, each dropping 5 % on its own period. */
    function bank(): ScraptfSaveRows[] {
      const out: ScraptfSaveRows[] = [];
      for (let h = 0; h <= 240; h++) {
        const rows: BankStockStored[] = [];
        for (let i = 0; i < 60; i++) {
          const start = (i * 7) % 200;
          const life = 20 + ((i * 13) % 80) + (i >= 40 ? 200 : 0);
          if (h < start || h >= start + life) continue;
          const period = 6 + (i % 5) * 3;
          const base = 100 + (i % 4) * 15;
          rows.push(row(`${1000 + i};6`, Math.round(base * 0.95 ** Math.floor((h - start) / period))));
        }
        out.push({ batchId: batch++, savedAt: T0 + h * HOUR, page: PAGE, rows });
      }
      return out;
    }

    it('every result with a horizon has ranges around its shares; no other result has any; the left tables are cached', () => {
      const c = scraptfBankCyclesOf('hats', bank(), K);
      const now = T0 + 240 * HOUR + 30 * MIN;
      let withH = 0;
      let flagged = 0;
      for (const [key, copy] of c.life.copies) {
        if (!copy.onSale) continue;
        const R = Math.round(copy.states[copy.states.length - 1]!.raw.scrap * 1.12);
        const t = scraptfTimingForKey({ cycles: c, key, buy: { revenueScrap: R, maxCostScrap: maxCostFor(R, PROFIT) }, profit: PROFIT, keyScrap: K, now });
        if (!t) continue;
        if (t.saveTiming) flagged++;
        if (t.horizonMs === null) {
          expect(t.uncertainty, key).toBeUndefined();
          continue;
        }
        withH++;
        const u = t.uncertainty!;
        const go = t.pGone! + t.pRise!;
        expect(u.pDrop.low, key).toBeLessThanOrEqual(t.pDrop! + 1e-12);
        expect(u.pDrop.high, key).toBeGreaterThanOrEqual(t.pDrop! - 1e-12);
        expect(u.pGoneOrRose.low, key).toBeLessThanOrEqual(go + 1e-12);
        expect(u.pGoneOrRose.high, key).toBeGreaterThanOrEqual(go - 1e-12);
        // The drop size the gate used is never over the point size.
        if (u.dropLow !== undefined) expect(u.dropLow).toBeLessThanOrEqual(t.dropPct! + 1e-12);
      }
      expect(withH).toBeGreaterThan(5);
      expect(flagged).toBeGreaterThanOrEqual(1);
      expect([...c.tables.keys()].some((k) => k.endsWith('|left'))).toBe(true);
      const empty = scraptfBankCyclesOf('hats', [], K);
      expect(scraptfTimingForKey({ cycles: empty, key: 'x|', buy: BUY, profit: PROFIT, keyScrap: K, now: T0 })).toBeNull();
      expect(empty.tables.size).toBe(0);
    });

    it('scraptfTimingBrief carries uncertainty and saveTiming exactly when the timing does', () => {
      const f = judge(flagStates());
      const b = scraptfTimingBrief(f);
      expect(b.uncertainty).toEqual(f.uncertainty);
      expect(b.saveTiming).toEqual(f.saveTiming);
      const none = judge(rich(), copyWith(), true);
      expect(none.saveTiming).toBeUndefined();
      expect('saveTiming' in scraptfTimingBrief(none)).toBe(false);
      const ned = judge(rich(), copyWith({ startPrevAt: null }));
      expect(ned.uncertainty).toBeUndefined();
      const nb = scraptfTimingBrief(ned);
      expect('uncertainty' in nb).toBe(false);
      expect('saveTiming' in nb).toBe(false);
    });

    function flagStates(): ScraptfPriceState[] {
      return [
        ...Array.from({ length: 12 }, (_, i) => st(`d${i % 6}`, 6.5, 'reprice-down', { lastAt: T0 + 0.5 * HOUR })),
        ...many(4, 'g', 30, 'gone'),
        ...many(8, 'o', 200, 'open'),
      ];
    }
  });
});
