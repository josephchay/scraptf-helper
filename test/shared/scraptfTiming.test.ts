// 0.8 (T2-T4): the buy-timing estimators and verdict (src/shared/scraptfTiming.ts). The pooled Aalen-Johansen table
// with three competing outcomes (dropped, gone, rose; only open states censored; exclusion on the start side only;
// a gap over 24 h censors at cutAt), the look gap, the band, the EV of waiting through flipProfit, every verdict and
// every 'not enough data' reason, the cadence that refuses the user's own save rhythm, the row brief and the
// Opportunities join. Estimates from the user's saves, never forecasts. Pure; no network, no scrap.tf.

import { describe, expect, it } from 'vitest';
import { bankStockKey } from '../../src/shared/bankStock';
import { flipProfit, maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  scraptfLifecycleOf,
  type ScraptfCopyLifecycle,
  type ScraptfPriceState,
  type ScraptfSaveRows,
  type ScraptfStateOutcome,
} from '../../src/shared/scraptfHistory';
import {
  SCRAPTF_TIMING_BRIEF_STEPS,
  SCRAPTF_TIMING_MAX_BRACKET_MS,
  SCRAPTF_TIMING_STEPS_MAX,
  SCRAPTF_TIMING_TABLES_MAX,
  scraptfAtRiskAt,
  scraptfBankCyclesOf,
  scraptfBankTurnover,
  scraptfBuyTimingOf,
  scraptfItemCyclesOf,
  scraptfItemTimingOf,
  scraptfLookGapMs,
  scraptfOpportunityTiming,
  scraptfTimingAt,
  scraptfTimingBrief,
  scraptfTimingEv,
  scraptfTimingForKey,
  scraptfTimingTableFor,
  scraptfTimingTableOf,
  type ScraptfBankCycles,
  type ScraptfTimingTable,
} from '../../src/shared/scraptfTiming';
import type { BankStockStored, ScraptfBuyTiming, ScraptfListingRun, UnixMs } from '../../src/shared/types';

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

/** A pooled state of `key` at 100 scrap, started at T0 one hour after its copy's look before; `durH` to its end (or its newest save while open). */
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

const sum = (t: ScraptfTimingTable, i: number): number => t.S[i]! + t.F_drop[i]! + t.F_gone[i]! + t.F_rise[i]!;

/** The copy being judged: its states end with the open one (at 100 by default, its newest save an hour after its start). */
function copyWith(states: ScraptfPriceState[] = [], runs?: ScraptfListingRun[], openOver: Partial<ScraptfPriceState> = {}): ScraptfCopyLifecycle {
  const open = st('me', 1, 'open', { run: runs ? runs.length - 1 : 0, ...openOver });
  const all = [...states, open];
  return {
    key: 'me',
    sku: '1;6',
    specialKey: '',
    home: PAGE,
    runs: runs ?? [{ firstOnSaleAt: T0, startAfter: T0 - HOUR, lastOnSaleAt: open.lastAt, endedAt: null, endedAs: null, startRaw: open.raw, endRaw: open.raw, drops: 0, saves: 2, sameAssetAsBefore: null }],
    states: all,
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

function judge(a: { states: ScraptfPriceState[]; copy?: ScraptfCopyLifecycle; buy?: typeof BUY | null; lookGapMs?: number | null; now?: UnixMs }): ScraptfBuyTiming {
  const copy = a.copy ?? copyWith();
  return scraptfBuyTimingOf({
    bank: 'hats',
    copy,
    table: scraptfTimingTableOf(a.states, K, 'bank'),
    buy: a.buy === undefined ? BUY : a.buy,
    profit: PROFIT,
    keyScrap: K,
    lookGapMs: a.lookGapMs === undefined ? HOUR : a.lookGapMs,
    now: a.now ?? copy.states[copy.states.length - 1]!.lastAt + HOUR,
  });
}

let batch = 1;
function row(sku: string, price: number, stock: number | null = 1): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap: price, stock, assetId: null };
}
function save(at: number, rows: BankStockStored[], page = PAGE): ScraptfSaveRows {
  return { batchId: batch++, savedAt: at, page, rows };
}

/** Hand-built cycles over pooled states (each key one copy), for the band and the cache. */
function cyclesOf(states: readonly ScraptfPriceState[]): ScraptfBankCycles {
  const copies = new Map<string, ScraptfCopyLifecycle>();
  for (const s of states) {
    let c = copies.get(s.key);
    if (!c) copies.set(s.key, (c = { key: s.key, sku: '1;6', specialKey: '', home: PAGE, runs: [], states: [], returns: 0, lastObsAt: s.lastAt, lastListedAt: s.lastAt, onSale: false }));
    c.states.push(s);
  }
  return { bank: 'hats', life: { keyStates: new Map(), copies, pageSaves: new Map(), assetStability: { pairs: 0, same: 0, share: null, stable: false }, newestSaveAt: null }, tables: new Map(), turnover: null };
}

describe('scraptfTimingTableOf (T2: Aalen-Johansen, dropped / gone / rose)', () => {
  const hand = (): ScraptfPriceState[] => [
    st('a', 2, 'reprice-down'),
    st('b', 2, 'sold-cheapest'),
    st('c', 3, 'reprice-up'),
    st('d', 4, 'reprice-down'),
    st('e', 4, 'arrival'),
    st('f', 6, 'open'),
  ];

  it('gives the hand example exactly, the four curves adding up to 1 at every t', () => {
    const t = scraptfTimingTableOf(hand(), K, 'bank');
    expect(t.t).toEqual([0, 2 * HOUR, 3 * HOUR, 4 * HOUR]);
    const close = (got: number[], want: number[]) => {
      expect(got).toHaveLength(want.length);
      got.forEach((g, i) => expect(g).toBeCloseTo(want[i]!, 12));
    };
    close(t.S, [1, 2 / 3, 1 / 2, 1 / 6]);
    close(t.F_drop, [0, 1 / 6, 1 / 6, 1 / 2]);
    close(t.F_gone, [0, 1 / 6, 1 / 6, 1 / 6]);
    close(t.F_rise, [0, 0, 1 / 6, 1 / 6]);
    expect(t.atRisk).toEqual([6, 6, 4, 3]);
    for (let i = 0; i < t.t.length; i++) expect(sum(t, i)).toBeCloseTo(1, 12);
    expect(t).toMatchObject({ states: 6, copies: 6, drops: 3, dropCopies: 3, gone: 1, rose: 1, ended: 5, imprecise: 0, wideGap: 0, maxMs: 6 * HOUR, scope: 'bank' });
    expect(t.durations).toEqual([2, 2, 3, 4, 4, 6].map((h) => h * HOUR));
    expect(t.medianDropPct).toBeCloseTo(0.1, 12);
    expect(t.medianToDropMs).toBe(4 * HOUR);
    expect(t.medianToGoneMs).toBe(2 * HOUR);
    // The resolution: per state the wider of its start bracket (1 h) and an event's end bracket (30 min).
    expect(t.resolutionMs).toBe(HOUR);
    // The step function and the at-risk count.
    expect(scraptfTimingAt(t, 2.5 * HOUR).S).toBeCloseTo(2 / 3, 12);
    expect(scraptfTimingAt(t, HOUR)).toEqual({ S: 1, F_drop: 0, F_gone: 0, F_rise: 0 });
    expect(scraptfTimingAt(t, 100 * HOUR).S).toBeCloseTo(1 / 6, 12);
    expect(scraptfAtRiskAt(t, 0)).toBe(6);
    expect(scraptfAtRiskAt(t, 3 * HOUR)).toBe(4);
    expect(scraptfAtRiskAt(t, 4.5 * HOUR)).toBe(1);
    expect(scraptfAtRiskAt(t, 7 * HOUR)).toBe(0);
  });

  it('a 30 h gap before the ending save censors the state at its last sighting (wideGap), never a drop or a left-out state', () => {
    // Through the walk: the copy last seen at its price at 3 h, the lower price shown 30 h later.
    const life = scraptfLifecycleOf([save(T0 - HOUR, [row('9;6', 5)]), save(T0, [row('1;6', 100)]), save(T0 + 3 * HOUR, [row('1;6', 100)]), save(T0 + 33 * HOUR, [row('1;6', 90)])], { keyScrap: K });
    const cut = life.copies.get(bankStockKey('1;6', ''))!.states[0]!;
    expect(cut).toMatchObject({ startAt: T0, startPrevAt: T0 - HOUR, outcome: 'reprice-down', cutAt: T0 + 3 * HOUR, endAt: T0 + 33 * HOUR });
    const states = hand().map((s) => (s.key === 'd' ? { ...cut, key: 'd' } : s));
    const t = scraptfTimingTableOf(states, K, 'bank');
    expect(t).toMatchObject({ states: 6, drops: 2, wideGap: 1, imprecise: 0, ended: 4 });
    expect(t.durations).toEqual([2, 2, 3, 3, 4, 6].map((h) => h * HOUR));
    expect(t.t).toEqual([0, 2 * HOUR, 3 * HOUR, 4 * HOUR]);
    expect(t.S[3]).toBeCloseTo(1 / 4, 12);
    expect(t.F_drop[3]).toBeCloseTo(5 / 12, 12);
    expect(t.atRisk).toEqual([6, 6, 4, 2]);
    for (let i = 0; i < t.t.length; i++) expect(sum(t, i)).toBeCloseTo(1, 12);
  });

  it("'arrival' is a drop (and its size counts), 'sold-cheapest' and 'untradable' are gone, 'reprice-up' rose; only 'open' is censored", () => {
    const t = scraptfTimingTableOf(
      [
        st('a', 2, 'arrival', { nextRaw: { keys: 0, scrap: 80 } }),
        st('b', 2, 'reprice-down', { nextRaw: { keys: 0, scrap: 90 } }),
        st('c', 2, 'reprice-down', { nextRaw: { keys: 0, scrap: 70 } }),
        st('d', 3, 'sold-cheapest'),
        st('e', 3, 'untradable'),
        st('f', 3, 'gone'),
        st('g', 4, 'reprice-up'),
        st('h', 5, 'open'),
      ],
      K,
      'bank',
    );
    expect(t).toMatchObject({ drops: 3, dropCopies: 3, gone: 3, rose: 1, ended: 7, states: 8 });
    expect(t.medianDropPct).toBeCloseTo(0.2, 12);
    expect(t.F_drop[t.F_drop.length - 1]).toBeCloseTo(3 / 8, 12);
    expect(t.F_gone[t.F_gone.length - 1]).toBeCloseTo(3 / 8, 12);
    expect(t.F_rise[t.F_rise.length - 1]).toBeCloseTo(1 / 8, 12);
    expect(t.S[t.S.length - 1]).toBeCloseTo(1 / 8, 12);
  });

  it('leaves states out on the start side only (left-censored, a start bracket over 24 h); family states are skipped', () => {
    const t = scraptfTimingTableOf(
      [
        st('a', 2, 'reprice-down', { startPrevAt: null }),
        st('b', 2, 'gone', { startPrevAt: T0 - SCRAPTF_TIMING_MAX_BRACKET_MS - MIN }),
        st('c', 2, 'gone', { startPrevAt: T0 - SCRAPTF_TIMING_MAX_BRACKET_MS }),
        st('d', 2, 'reprice-down', { family: true }),
        // An end bracket over 24 h: censored at its last sighting before the gap, never left out.
        st('e', 40, 'reprice-down', { lastAt: T0 + 5 * HOUR, cutAt: T0 + 5 * HOUR }),
      ],
      K,
      'bank',
    );
    expect(t).toMatchObject({ imprecise: 2, states: 2, wideGap: 1, drops: 0, gone: 1, copies: 2 });
    expect(t.durations).toEqual([2 * HOUR, 5 * HOUR]);
  });

  it('never throws on an empty input', () => {
    const t = scraptfTimingTableOf([], K, 'band');
    expect(t).toMatchObject({ t: [0], S: [1], F_drop: [0], F_gone: [0], F_rise: [0], atRisk: [0], durations: [], states: 0, ended: 0, maxMs: 0, resolutionMs: null, medianDropPct: null, scope: 'band' });
    expect(scraptfTimingAt(t, 5 * HOUR)).toEqual({ S: 1, F_drop: 0, F_gone: 0, F_rise: 0 });
    expect(scraptfAtRiskAt(t, 0)).toBe(0);
  });
});

describe('scraptfLookGapMs: saves within 30 min are one look', () => {
  it('a 30 s window session once a day for a week reads about 1 d, not 30 s', () => {
    const times: number[] = [];
    for (let d = 0; d < 7; d++) for (let r = 0; r < 20; r++) times.push(T0 + d * DAY + r * 30 * SEC);
    const gap = scraptfLookGapMs(times)!;
    expect(gap).toBe(DAY - 19 * 30 * SEC);
  });

  it('saves 12 h apart read 12 h; only the looks of the last 7 d count; fewer than two looks give null', () => {
    expect(scraptfLookGapMs(Array.from({ length: 10 }, (_, i) => T0 + i * 12 * HOUR))).toBe(12 * HOUR);
    expect(scraptfLookGapMs([T0, T0 + 20 * DAY, T0 + 20 * DAY + HOUR, T0 + 20 * DAY + 2 * HOUR])).toBe(HOUR);
    expect(scraptfLookGapMs([T0, T0 + 10 * MIN, T0 + 20 * MIN])).toBeNull();
    expect(scraptfLookGapMs([])).toBeNull();
  });

  it('per page, from the lifecycle', () => {
    const saves: ScraptfSaveRows[] = [];
    for (let h = 0; h <= 48; h++) {
      saves.push(save(T0 + h * HOUR, [row('1;6', 5)], '/buy/hats'));
      if (h % 12 === 0) saves.push(save(T0 + h * HOUR + MIN, [row('2;6', 5)], '/buy/hats/2'));
    }
    const life = scraptfLifecycleOf(saves);
    expect(scraptfLookGapMs(life.pageSaves.get('/buy/hats')!)).toBe(HOUR);
    expect(scraptfLookGapMs(life.pageSaves.get('/buy/hats/2')!)).toBe(12 * HOUR);
  });
});

describe('the band and the cache', () => {
  it('uses the neighbouring power-of-two buckets when they hold 15 ended states, else the whole bank', () => {
    const at = (key: string, scrap: number, outcome: ScraptfStateOutcome) => st(key, 10, outcome, { raw: { keys: 0, scrap } });
    // 100 is bucket 6; 50 (bucket 5) is a neighbour, 30 (bucket 4) is not.
    const near = [...Array.from({ length: 6 }, (_, i) => at(`n${i}`, 100, 'gone')), ...Array.from({ length: 4 }, (_, i) => at(`m${i}`, 50, 'gone')), ...Array.from({ length: 9 }, (_, i) => at(`f${i}`, 30, 'gone'))];
    const far = Array.from({ length: 20 }, (_, i) => at(`x${i}`, 10_000, 'gone'));
    const c = cyclesOf([...near, ...far]);
    const t = scraptfTimingTableFor(c, 100, K);
    expect(t).toMatchObject({ scope: 'bank', ended: 39 });
    expect([...c.tables.keys()].sort()).toEqual([`${K}|*`, `${K}|6`]);
    expect(c.tables.get(`${K}|6`)!.ended).toBe(10);
    // Five more near it: the band (15 ended) is used.
    const c2 = cyclesOf([...near, ...Array.from({ length: 5 }, (_, i) => at(`p${i}`, 120, 'gone')), ...far]);
    expect(scraptfTimingTableFor(c2, 100, K)).toMatchObject({ scope: 'band', ended: 15 });
    // Cached: the same object again.
    expect(scraptfTimingTableFor(c2, 100, K)).toBe(scraptfTimingTableFor(c2, 110, K));
  });

  it('clears the tables past SCRAPTF_TIMING_TABLES_MAX', () => {
    const c = cyclesOf(rich());
    for (let i = 0; i < SCRAPTF_TIMING_TABLES_MAX; i++) c.tables.set(`dummy|${i}`, scraptfTimingTableOf([], K, 'band'));
    scraptfTimingTableFor(c, 100, K);
    expect(c.tables.size).toBe(1);
  });

  it('an empty bank never throws', () => {
    const c = scraptfBankCyclesOf('hats', [], K);
    expect(scraptfTimingForKey({ cycles: c, key: 'x|', buy: BUY, profit: PROFIT, keyScrap: K, now: T0 })).toBeNull();
    expect(scraptfTimingTableFor(c, 100, K)).toMatchObject({ scope: 'bank', states: 0 });
    expect(scraptfBankTurnover(c)).toMatchObject({ ended: 0, reason: 'not-enough-data' });
    expect(scraptfItemCyclesOf(c, 'x|')).toBeNull();
    expect(scraptfItemTimingOf({ sku: '1;6', specialKey: '', bank: 'hats' }, { cyclesOf: () => c, buy: BUY, profit: PROFIT, keyScrap: K, now: T0 })).toEqual({ timing: null });
    expect(scraptfItemTimingOf({ sku: '1;6', specialKey: '', bank: null }, { cyclesOf: () => c, buy: BUY, profit: PROFIT, keyScrap: K, now: T0 })).toEqual({});
    expect(scraptfItemTimingOf({ sku: '1;6', specialKey: '', bank: 'hats' }, { cyclesOf: () => null, buy: BUY, profit: PROFIT, keyScrap: K, now: T0 })).toEqual({});
  });
});

describe('scraptfTimingEv (one step at today revenue, through flipProfit)', () => {
  it('gives the three examples', () => {
    expect(BUY.maxCostScrap).toBe(111);
    const ev = (c0: number, c1: number, pDrop: number, q: number, pNone: number) => scraptfTimingEv({ revenueScrap: 120, costScrap: c0, nextScrap: c1, pDrop, q, pNone, profit: PROFIT });
    expect(ev(100, 90, 0.7, 0.95, 0.25)).toEqual({ evBuyScrap: 20, evWaitScrap: 25 });
    expect(ev(100, 90, 0.5, 0.9, 0.3)).toEqual({ evBuyScrap: 20, evWaitScrap: 20 });
    expect(ev(118, 106, 0.6, 0.9, 0.3)).toEqual({ evBuyScrap: 2, evWaitScrap: 8 });
    // Friction and the price-move reserve come off both sides (flipProfit).
    const p = { ...PROFIT, frictionScrap: 2, exitReservePct: 0.1 };
    const withCosts = scraptfTimingEv({ revenueScrap: 120, costScrap: 100, nextScrap: 90, pDrop: 1, q: 1, pNone: 0, profit: p });
    expect(withCosts).toEqual({ evBuyScrap: flipProfit(120, 100, p), evWaitScrap: flipProfit(120, 90, p) });
    expect(withCosts.evBuyScrap).toBeLessThan(18);
  });
});

describe('scraptfBuyTimingOf: every verdict and why', () => {
  it("'wait' / drop-likely: the best horizon by evWait, a tie to the shorter", () => {
    const t = judge({ states: rich() });
    expect(t).toMatchObject({ verdict: 'wait', why: 'drop-likely', horizonMs: DAY, costScrap: 100, revenueScrap: 120, maxCostScrap: 111, evBuyScrap: 20, evWaitScrap: 25, expectedNextScrap: 90, dropPctSource: 'bank', scope: 'bank' });
    expect(t.pDrop).toBeCloseTo(0.7, 12);
    expect(t.pGone).toBeCloseTo(0.1, 12);
    expect(t.pRise).toBeCloseTo(0, 12);
    expect(t.pNone).toBeCloseTo(0.2, 12);
    expect(t.pDrop! + t.pGone! + t.pRise! + t.pNone!).toBeCloseTo(1, 12);
    expect(t.n).toEqual({ states: 20, copies: 13, ended: 16, drops: 14, dropCopies: 7, gone: 2, rose: 0, atRisk: 20, atRiskEnd: 4, ownDrops: 0, imprecise: 0, wideGap: 0 });
    expect(t).toMatchObject({ priceSince: T0, pricePrevAt: T0 - HOUR, lastSeenAt: T0 + HOUR, ageMs: HOUR, lookGapMs: HOUR, resolutionMs: HOUR });
  });

  it("'wait' / drop-makes-flip: today's price just over Pay up to, the dropped one under it", () => {
    const t = judge({ states: rich(), copy: copyWith([], undefined, { raw: { keys: 0, scrap: 118 } }) });
    expect(t).toMatchObject({ verdict: 'wait', why: 'drop-makes-flip', costScrap: 118, expectedNextScrap: 106, evBuyScrap: 2, evWaitScrap: 10 });
  });

  it("'over': over Pay up to now and after a typical drop", () => {
    expect(judge({ states: rich(), copy: copyWith([], undefined, { raw: { keys: 0, scrap: 130 } }) })).toMatchObject({ verdict: 'over', why: 'over', expectedNextScrap: 117 });
    expect(judge({ states: rich(), buy: { revenueScrap: 120, maxCostScrap: null } })).toMatchObject({ verdict: 'over', why: 'over' });
  });

  it("'buy-now': unsure-gain when waiting fails at its low end, gone-risk when going or rising first is at least as likely", () => {
    // 0.9 (#10): pDrop 0.25 was 0.8's flip-now (under 0.3); waiting clears the bar on the estimate but not at its low end.
    const flipNow = [...many(5, 'd', 10, 'reprice-down'), ...many(11, 'g', 200, 'gone'), ...many(4, 'o', 300, 'open')];
    const unsure = judge({ states: flipNow });
    expect(unsure).toMatchObject({ verdict: 'buy-now', why: 'unsure-gain' });
    // No gone or rise in its window: went-or-rose first is taken at its range's high end (review), so -1, not 0.
    expect(unsure.uncertainty?.gainLowScrap).toBe(-1);
    // The events fall inside the chosen window (6 h from an age of 1 h): gone or rose first in 11 of 20.
    const goneRisk = [...many(5, 'd', 4, 'reprice-down'), ...many(5, 'g', 4, 'gone'), ...many(6, 'r', 4, 'reprice-up'), ...many(4, 'o', 300, 'open')];
    const t = judge({ states: goneRisk });
    expect(t).toMatchObject({ verdict: 'buy-now', why: 'gone-risk', horizonMs: 6 * HOUR });
    expect(t.pGone! + t.pRise!).toBeCloseTo(11 / 20, 12);
    expect(t.pGone! + t.pRise!).toBeGreaterThanOrEqual(t.pDrop!);
  });

  it("'buy-now' with no event at all in the window is flip-now, never gone-risk on 0 >= 0 (review)", () => {
    // 10 drops and 10 gones at 2-5 h, 10 still open at 200 h; the copy is 100 h old, so the 6 h window sees nothing.
    const states = [
      ...Array.from({ length: 10 }, (_, i) => st(`d${i}`, 2 + (i % 3), 'reprice-down')),
      ...Array.from({ length: 10 }, (_, i) => st(`g${i}`, 3 + (i % 2), 'gone')),
      ...many(10, 'o', 200, 'open'),
    ];
    const copy = copyWith([], undefined, { lastAt: T0 + 100 * HOUR });
    const t = judge({ states, copy, now: T0 + 100 * HOUR + 30 * MIN });
    expect(t).toMatchObject({ verdict: 'buy-now', why: 'flip-now', horizonMs: 6 * HOUR, pDrop: 0, pGone: 0, pRise: 0, pNone: 1 });
    expect(t.n).toMatchObject({ atRisk: 10, atRiskEnd: 10 });
  });

  it("'no-buyers' without revenue, before anything else", () => {
    expect(judge({ states: rich(), buy: null })).toMatchObject({ verdict: 'no-buyers', why: 'no-buyers', revenueScrap: null, evBuyScrap: null, horizonMs: null });
    expect(judge({ states: [], buy: { revenueScrap: null, maxCostScrap: null } as unknown as typeof BUY })).toMatchObject({ verdict: 'no-buyers' });
  });

  it("'not enough data' with each of its reasons, in order", () => {
    const why = (t: ScraptfBuyTiming) => [t.verdict, t.why];
    // Its newest save over 48 h old.
    expect(why(judge({ states: rich(), now: T0 + HOUR + 49 * HOUR }))).toEqual(['not-enough-data', 'stale-save']);
    expect(why(judge({ states: rich(), copy: copyWith([], undefined, { startPrevAt: null }) }))).toEqual(['not-enough-data', 'left-censored']);
    expect(why(judge({ states: [...many(4, 'd', 10, 'reprice-down'), ...many(12, 'g', 10, 'gone'), ...many(4, 'o', 200, 'open')] }))).toEqual(['not-enough-data', 'few-drops']);
    expect(why(judge({ states: [...many(10, 'd', 10, 'reprice-down', 2), ...many(12, 'g', 10, 'gone'), ...many(4, 'o', 200, 'open')] }))).toEqual(['not-enough-data', 'few-drops']);
    expect(why(judge({ states: [...many(5, 'd', 10, 'reprice-down'), ...many(5, 'g', 10, 'gone'), ...many(10, 'o', 200, 'open')] }))).toEqual(['not-enough-data', 'few-ended']);
    // Aged 20 h: only the 4 open states were still at their price that long.
    expect(why(judge({ states: rich(), copy: copyWith([], undefined, { lastAt: T0 + 20 * HOUR }) }))).toEqual(['not-enough-data', 'few-at-risk']);
    expect(why(judge({ states: rich(), lookGapMs: 4 * DAY }))).toEqual(['not-enough-data', 'sparse-saves']);
    expect(why(judge({ states: rich(), lookGapMs: null }))).toEqual(['not-enough-data', 'sparse-saves']);
    expect(why(judge({ states: rich(4, 12), lookGapMs: 4 * HOUR }))).toEqual(['not-enough-data', 'past-data']);
    // n is filled for every verdict.
    expect(judge({ states: rich(), lookGapMs: null }).n).toMatchObject({ states: 20, atRisk: 20, atRiskEnd: null });
  });

  it('staleness against the horizon: the same copy judged 1 h and 20 h after its save gives wait, then stale-save', () => {
    // The data reach 30 h: only 6 h and 1 d are within it.
    const states = rich(4, 30);
    expect(judge({ states, now: T0 + 2 * HOUR })).toMatchObject({ verdict: 'wait', horizonMs: DAY });
    // 20 h after the save: 20 > 6/2 and 20 > 24/2.
    expect(judge({ states, now: T0 + HOUR + 20 * HOUR })).toMatchObject({ verdict: 'not-enough-data', why: 'stale-save', horizonMs: null });
  });

  it('a horizon that leaves fewer than 3 states at risk at its end is not eligible', () => {
    // 2 open states: past 10 h only 2 are left, so 1 d, 3 d and 7 d are past the data; 6 h is left.
    const t = judge({ states: rich(2, 200) });
    expect(t.horizonMs).toBe(6 * HOUR);
    expect(t.n.atRiskEnd).toBe(scraptfAtRiskAt(scraptfTimingTableOf(rich(2, 200), K, 'bank'), 7 * HOUR));
    expect(t.n.atRiskEnd).toBe(18);
    expect(t.verdict).not.toBe('wait');
    expect(judge({ states: rich(2, 200), lookGapMs: 4 * HOUR })).toMatchObject({ verdict: 'not-enough-data', why: 'past-data' });
  });

  it('q is S + F_drop at the look gap: a price that tends to go before the next look is worth less to wait for', () => {
    const states = [...rich(), ...many(4, 'q', 0.5, 'gone')];
    const table = scraptfTimingTableOf(states, K, 'bank');
    const at = scraptfTimingAt(table, HOUR);
    const q = at.S + at.F_drop;
    expect(q).toBeCloseTo(20 / 24, 12);
    const t = judge({ states });
    expect(t.evWaitScrap).toBe(Math.round(t.pDrop! * q * 30 + t.pNone! * 20));
    // The same odds with q = 1 would be a wait; with q < 1 the gain is under the bar.
    expect(t).toMatchObject({ verdict: 'buy-now', why: 'flip-now', horizonMs: DAY });
  });

  it("uses the copy's own drop size with at least 3 own drops", () => {
    const own = [st('me', 5, 'reprice-down', { nextRaw: { keys: 0, scrap: 80 } }), st('me', 5, 'arrival', { nextRaw: { keys: 0, scrap: 80 } }), st('me', 5, 'reprice-down', { nextRaw: { keys: 0, scrap: 80 } })];
    const t = judge({ states: rich(), copy: copyWith(own) });
    expect(t).toMatchObject({ dropPctSource: 'own', expectedNextScrap: 80 });
    expect(t.dropPct).toBeCloseTo(0.2, 12);
    expect(t.n.ownDrops).toBe(3);
    expect(judge({ states: rich(), copy: copyWith(own.slice(0, 2)) })).toMatchObject({ dropPctSource: 'bank', expectedNextScrap: 90 });
  });
});

describe('cadence: the copy own rhythm, never the user save rhythm', () => {
  /** A reprice-down of the copy lasting `durH`, its last sighting at the old price `bracketH` before the lower one showed. */
  const down = (durH: number, bracketH: number) => st('me', durH, 'reprice-down', { lastAt: T0 + (durH - bracketH) * HOUR });

  it('an own cadence with CV <= 0.35, a median >= 4x its end bracket and >= 2x the look gap: nextDropAt by that rhythm', () => {
    const t = judge({ states: rich(), copy: copyWith([down(48, 1), down(50, 1), down(46, 1)]) });
    expect(t).toMatchObject({ cadenceSource: 'own', cadenceMs: 48 * HOUR, nextDropAt: T0 + 48 * HOUR });
  });

  it('daily-quantised durations off daily saves (1 d, 1 d, 1 d) give no own cadence, nor do irregular ones or ones near the look gap', () => {
    expect(judge({ states: rich(), copy: copyWith([down(24, 24), down(24, 24), down(24, 24)]), lookGapMs: DAY })).toMatchObject({ cadenceSource: 'bank', nextDropAt: null });
    expect(judge({ states: rich(), copy: copyWith([down(10, 1), down(48, 1), down(100, 1)]) })).toMatchObject({ cadenceSource: 'bank', nextDropAt: null });
    expect(judge({ states: rich(), copy: copyWith([down(48, 1), down(48, 1), down(48, 1)]), lookGapMs: 30 * HOUR }).cadenceSource).not.toBe('own');
  });

  it("a 'bank' cadence is the pooled median time to a drop and never sets nextDropAt; too few drops give none", () => {
    expect(judge({ states: rich() })).toMatchObject({ cadenceSource: 'bank', cadenceMs: 10 * HOUR, nextDropAt: null });
    expect(judge({ states: [...many(4, 'd', 10, 'reprice-down'), ...many(4, 'o', 200, 'open')] })).toMatchObject({ cadenceSource: null, cadenceMs: null, nextDropAt: null });
  });
});

describe('steps, earlier runs and the brief', () => {
  const run = (o: Partial<ScraptfListingRun>): ScraptfListingRun => ({
    firstOnSaleAt: T0,
    startAfter: T0 - HOUR,
    lastOnSaleAt: T0,
    endedAt: null,
    endedAs: null,
    startRaw: { keys: 0, scrap: 100 },
    endRaw: { keys: 0, scrap: 100 },
    drops: 0,
    saves: 1,
    sameAssetAsBefore: null,
    ...o,
  });

  it('counts the reprice-downs of the current run chain (flaps joined) and lists the earlier runs newest first', () => {
    const runs = [
      run({ endedAt: T0 + 1 * HOUR, endedAs: 'absent', endRaw: { keys: 0, scrap: 95 } }),
      run({ endedAt: T0 + 2 * HOUR, endedAs: 'sold-out', endRaw: { keys: 0, scrap: 93 } }),
      run({ endedAt: T0 + 3 * HOUR, endedAs: 'absent', flap: true }),
      run({}),
    ];
    const states = [
      st('me', 1, 'reprice-down', { run: 0 }),
      st('me', 1, 'gone', { run: 0 }),
      st('me', 1, 'gone', { run: 1 }),
      st('me', 1, 'reprice-down', { run: 2, endAt: T0 + 5 * HOUR, lastAt: T0 + 4 * HOUR }),
      st('me', 1, 'reprice-down', { run: 2, endAt: T0 + 7 * HOUR, lastAt: T0 + 6 * HOUR, raw: { keys: 0, scrap: 90 }, nextRaw: { keys: 0, scrap: 81 } }),
    ];
    const t = judge({ states: rich(), copy: copyWith(states, runs, { run: 3, raw: { keys: 0, scrap: 81 } }) });
    // The chain is runs 2-3 (run 2 ended in a flap): the drop within run 2 and the one into run 3, not run 0's.
    expect(t.dropsThisRun).toBe(2);
    expect(t.steps).toEqual([
      { at: T0 + 5 * HOUR, prevAt: T0 + 4 * HOUR, fromScrap: 100, toScrap: 90, pct: -0.1 },
      { at: T0 + 7 * HOUR, prevAt: T0 + 6 * HOUR, fromScrap: 90, toScrap: 81, pct: -0.1 },
    ]);
    expect(t.earlierRunEnds).toEqual([
      { endedAt: T0 + 2 * HOUR, endedAs: 'sold-out', lastScrap: 93 },
      { endedAt: T0 + 1 * HOUR, endedAs: 'absent', lastScrap: 95 },
    ]);
  });

  it('keeps the newest SCRAPTF_TIMING_STEPS_MAX steps; the brief the newest SCRAPTF_TIMING_BRIEF_STEPS, the save and four n fields', () => {
    const downs = Array.from({ length: 12 }, (_, i) => st('me', 1, 'reprice-down', { endAt: T0 + (i + 1) * HOUR, raw: { keys: 0, scrap: 200 - i }, nextRaw: { keys: 0, scrap: 199 - i } }));
    const t = judge({ states: rich(), copy: copyWith(downs) });
    expect(t.dropsThisRun).toBe(12);
    expect(t.steps).toHaveLength(SCRAPTF_TIMING_STEPS_MAX);
    expect(t.steps[0]!.at).toBe(T0 + 3 * HOUR);
    const b = scraptfTimingBrief(t);
    expect(b).toEqual({
      verdict: t.verdict,
      why: t.why,
      bank: 'hats',
      key: 'me',
      dropsThisRun: 12,
      dropsSinceListed: 12,
      steps: t.steps.slice(-SCRAPTF_TIMING_BRIEF_STEPS),
      lastSeenAt: t.lastSeenAt,
      horizonMs: t.horizonMs,
      pDrop: t.pDrop,
      pGone: t.pGone,
      pRise: t.pRise,
      nextDropAt: t.nextDropAt,
      scope: 'bank',
      n: { states: t.n.states, copies: t.n.copies, atRisk: t.n.atRisk, dropCopies: t.n.dropCopies },
      // The price judged and its Pay up to, for the Live market and Opportunities tag titles.
      costScrap: t.costScrap,
      maxCostScrap: t.maxCostScrap,
      // 0.9 (#10): the ranges, whenever the timing has them.
      uncertainty: t.uncertainty,
    });
    expect(b.steps).toHaveLength(5);
  });
});

describe('scraptfOpportunityTiming (T4)', () => {
  const opp = (inputKind: 'user' | 'import' | 'rule', copyKey?: string) => ({ sku: '378;6;p15185211', inputKind, revenueScrap: 120, maxCostScrap: 111, ...(copyKey !== undefined ? { copyKey } : {}) });
  it("is null for 'user' and 'rule' rows; an 'import' row asks for its copy with its own Sells for and Pay up to", () => {
    const calls: unknown[][] = [];
    const t = judge({ states: rich() });
    const timingForCopy = (...args: unknown[]) => {
      calls.push(args);
      return t;
    };
    expect(scraptfOpportunityTiming(opp('user'), timingForCopy, T0)).toBeNull();
    expect(scraptfOpportunityTiming(opp('rule'), timingForCopy, T0)).toBeNull();
    expect(calls).toEqual([]);
    expect(scraptfOpportunityTiming(opp('import', 'PAINT'), timingForCopy, T0)).toEqual(scraptfTimingBrief(t));
    expect(scraptfOpportunityTiming(opp('import'), timingForCopy, T0 + 1)).toEqual(scraptfTimingBrief(t));
    expect(calls).toEqual([
      ['378;6', 'PAINT', { revenueScrap: 120, maxCostScrap: 111 }, T0],
      ['378;6', '', { revenueScrap: 120, maxCostScrap: 111 }, T0 + 1],
    ]);
    expect(scraptfOpportunityTiming(opp('import'), () => null, T0)).toBeNull();
  });
});

describe('end to end over saves: scraptfTimingForKey, scraptfItemTimingOf', () => {
  /**
   * A synthetic bank page saved hourly for 10 days: 60 copies listed at staggered hours, each dropping 5 % on its own
   * period and gone after its own life. `dense` adds a 10-minute window session of 30 s reads after every 6th save,
   * showing exactly that save's rows: more reads, no new information.
   */
  function bank(dense: boolean): ScraptfSaveRows[] {
    const rowsAt = (h: number): BankStockStored[] => {
      const rows: BankStockStored[] = [];
      for (let i = 0; i < 60; i++) {
        const start = (i * 7) % 200;
        const life = 20 + ((i * 13) % 80) + (i >= 40 ? 200 : 0);
        if (h < start || h >= start + life) continue;
        const period = 6 + (i % 5) * 3;
        const base = 100 + (i % 4) * 15;
        rows.push(row(`${1000 + i};6`, Math.round(base * 0.95 ** Math.floor((h - start) / period))));
      }
      return rows;
    };
    const out: ScraptfSaveRows[] = [];
    for (let h = 0; h <= 240; h++) {
      const rows = rowsAt(h);
      out.push(save(T0 + h * HOUR, rows));
      if (dense && h % 6 === 0) for (let r = 1; r <= 20; r++) out.push(save(T0 + h * HOUR + r * 30 * SEC, rows));
    }
    return out;
  }
  const now = T0 + 240 * HOUR + 30 * MIN;
  const verdicts = (saves: ScraptfSaveRows[]) => {
    const c = scraptfBankCyclesOf('hats', saves, K);
    const out = new Map<string, ScraptfBuyTiming>();
    for (const [key, copy] of c.life.copies) {
      if (!copy.onSale) continue;
      const base = copy.states[copy.states.length - 1]!.raw.scrap;
      const R = Math.round(base * 1.12);
      const t = scraptfTimingForKey({ cycles: c, key, buy: { revenueScrap: R, maxCostScrap: maxCostFor(R, PROFIT) }, profit: PROFIT, keyScrap: K, now });
      if (t) out.set(key, t);
    }
    return out;
  };

  it('thinning invariance: the same verdict or not-enough-data, never wait against buy-now', () => {
    const hourly = verdicts(bank(false));
    const dense = verdicts(bank(true));
    expect([...dense.keys()].sort()).toEqual([...hourly.keys()].sort());
    let judged = 0;
    for (const [key, h] of hourly) {
      const d = dense.get(key)!;
      if (h.verdict !== 'not-enough-data' && d.verdict !== 'not-enough-data') {
        judged++;
        expect(d.verdict, key).toBe(h.verdict);
      }
    }
    // Not vacuous: the synthetic bank gives real verdicts.
    expect(judged).toBeGreaterThan(5);
  });

  it("scraptfItemTimingOf: the copy's cycles and timing, null timing without profit settings", () => {
    const saves = bank(false);
    const c = scraptfBankCyclesOf('hats', saves, K);
    const key = [...c.life.copies.values()].find((x) => x.onSale && x.runs.length > 0)!;
    const h = { sku: key.sku, specialKey: key.specialKey, bank: 'hats' as const };
    const buy = { revenueScrap: 150, maxCostScrap: maxCostFor(150, PROFIT) };
    const got = scraptfItemTimingOf(h, { cyclesOf: () => c, buy, profit: PROFIT, keyScrap: K, now });
    expect(got.cycles).toEqual(scraptfItemCyclesOf(c, key.key));
    expect(got.timing).toEqual(scraptfTimingForKey({ cycles: c, key: key.key, buy, profit: PROFIT, keyScrap: K, now }));
    expect(got.timing).not.toBeNull();
    expect(scraptfItemTimingOf(h, { cyclesOf: () => c, buy, profit: null, keyScrap: K, now })).toEqual({ cycles: got.cycles, timing: null });
    // Not on sale on its newest observation: no timing.
    const gone = [...c.life.copies.values()].find((x) => !x.onSale && x.runs.length > 0)!;
    expect(scraptfTimingForKey({ cycles: c, key: gone.key, buy, profit: PROFIT, keyScrap: K, now })).toBeNull();
  });

  it('scraptfItemCyclesOf: the newest 20 runs, every run counted, the down markers and the gate', () => {
    const saves: ScraptfSaveRows[] = [];
    // 25 listings an hour apart with a gap between: back 24 times; each drops once.
    for (let i = 0; i < 25; i++) {
      saves.push(save(T0 + i * 4 * HOUR, [row('9;6', 5), row('1;6', 100)]));
      saves.push(save(T0 + i * 4 * HOUR + HOUR, [row('9;6', 5), row('1;6', 90)]));
      saves.push(save(T0 + i * 4 * HOUR + 2 * HOUR, [row('9;6', 5)]));
    }
    const c = scraptfBankCyclesOf('hats', [save(T0 - HOUR, [row('9;6', 5)]), ...saves], K);
    const cy = scraptfItemCyclesOf(c, bankStockKey('1;6', ''))!;
    expect(cy.runsTotal).toBe(25);
    expect(cy.runs).toHaveLength(20);
    expect(cy.runs[0]!.firstOnSaleAt).toBe(T0 + 5 * 4 * HOUR);
    expect(cy.returns).toBe(24);
    expect(cy.dropAts).toHaveLength(25);
    expect(cy.dropAts[0]).toBe(T0 + HOUR);
    expect(cy.assetIdsStable).toBe(false);
  });
});
