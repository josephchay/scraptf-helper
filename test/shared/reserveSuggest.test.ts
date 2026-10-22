// 0.9 (#12): the suggested price-move reserve (src/shared/reserveSuggest.ts). Per value band, the 10th percentile of
// how the exit moved over the user's typical hold, from the exit runs recorded while the app ran (holding_marks) or,
// when those are not enough, the PriceDB history the drawer loaded this session. Both ends of a window must be
// observed (no gap is filled), no recorded window starts before the last buyer-settings change, and keys are valued at
// the PriceDB key price of each end's own time in both sources (a recorded run's start price never: a run goes on
// through a key move). A suggestion from past data, never applied, never a forecast.

import { describe, expect, it } from 'vitest';
import { EXIT_RESERVE_MAX_PCT } from '../../src/shared/ceiling';
import { KEY_BAND_MAX_POINT_AGE_MS } from '../../src/shared/holdingAdvice';
import {
  RESERVE_BANDS,
  RESERVE_BAND_REF10_SCRAP,
  RESERVE_DEFAULT_HOLD_MS,
  RESERVE_KEY_POINT_MAX_AGE_MS,
  RESERVE_LOOKBACK_MS,
  RESERVE_MAX_HOLD_MS,
  RESERVE_MAX_MARKS,
  RESERVE_MAX_WINDOWS_PER_ITEM,
  RESERVE_MIN_HOLD_MS,
  RESERVE_MIN_ITEMS,
  RESERVE_MIN_WINDOWS,
  RESERVE_POINT_TOLERANCE_MIN_MS,
  RESERVE_QUANTILE,
  keyPriceAtOf,
  lowerQuantile,
  markRevenueScrap,
  pricedbWindows,
  recordedWindows,
  reserveBandOf,
  reserveHoldOf,
  reserveSuggestionOf,
  suggestedPctOf,
} from '../../src/shared/reserveSuggest';
import type { HistoryPoint, HoldingMark, LoadedKeyHistory, TypicalHold } from '../../src/shared/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const K = 567;

let seq = 0;
function mark(over: Partial<HoldingMark> = {}): HoldingMark {
  seq++;
  return {
    id: seq,
    baseSku: '378;6',
    fromAt: NOW - 3 * DAY,
    toAt: NOW,
    revKeys: 0,
    revMetalScrap: 50,
    revIsBot: true,
    revVerified: true,
    bestKeys: null,
    bestMetalScrap: null,
    nextKeys: null,
    nextMetalScrap: null,
    buyerCount: 2,
    verifiedBuyerCount: 2,
    askKeys: null,
    askMetalScrap: null,
    askCount: null,
    scraptfPaysKeys: null,
    scraptfPaysScrap: null,
    keyScrap: K,
    ...over,
  };
}

/** Back-to-back day-long runs of `base` from `start`, one per value: N runs give N - 1 one-day windows. */
function dailyRuns(base: string, values: readonly number[], start: number, over: Partial<HoldingMark> = {}): HoldingMark[] {
  return values.map((v, i) => mark({ baseSku: base, fromAt: start + i * DAY, toAt: start + (i + 1) * DAY - 1, revMetalScrap: v, ...over }));
}

/** Daily PriceDB points (`t` in seconds) from `start`, one per value. */
function dailyPoints(values: readonly (number | null)[], start: number): HistoryPoint[] {
  return values.map((v, i) => ({ t: Math.floor((start + i * DAY) / 1000), buyScrap: v, sellScrap: v === null ? null : v + 5 }));
}

/** The 10th percentile as the plan defines it (Hyndman-Fan type 1), in integer arithmetic: the ceil(n / 10)-th lowest. */
function p10Of(rel: readonly number[]): number {
  const s = [...rel].sort((a, b) => a - b);
  return s[Math.ceil(s.length / 10) - 1]!;
}

/** Relative day-on-day changes of `values` (what N daily runs or points give). */
function relOf(values: readonly number[]): number[] {
  return values.slice(1).map((v, i) => (v - values[i]!) / values[i]!);
}

/** A PriceDB key history loaded at `loadedAt`: daily points from `start` (`t` in seconds), buy = sell - 10. */
function keyHistory(values: readonly number[], start: number, loadedAt = NOW): LoadedKeyHistory {
  return { loadedAt, points: values.map((v, i) => ({ t: Math.floor((start + i * DAY) / 1000), buyScrap: v, sellScrap: v + 10 })) };
}

/** keyAt for recordedWindows: one key price everywhere. */
const flatKey = (k: number) => (): number => k;

describe('the constants', () => {
  it('are the decided thresholds (exported, never tuned per item)', () => {
    expect(RESERVE_BANDS).toEqual(['under-10-ref', 'to-1-key', 'key-plus']);
    expect(RESERVE_BAND_REF10_SCRAP).toBe(90);
    expect(RESERVE_DEFAULT_HOLD_MS).toBe(DAY);
    expect(RESERVE_MIN_HOLD_MS).toBe(HOUR);
    expect(RESERVE_MAX_HOLD_MS).toBe(14 * DAY);
    expect(RESERVE_MIN_WINDOWS).toBe(20);
    expect(RESERVE_MIN_ITEMS).toBe(3);
    expect(RESERVE_MAX_WINDOWS_PER_ITEM).toBe(30);
    expect(RESERVE_QUANTILE).toBe(0.1);
    expect(RESERVE_POINT_TOLERANCE_MIN_MS).toBe(HOUR);
    expect(RESERVE_LOOKBACK_MS).toBe(90 * DAY);
    expect(RESERVE_MAX_MARKS).toBe(50_000);
    // A key point stands for as long as it does in the key move band (#17).
    expect(RESERVE_KEY_POINT_MAX_AGE_MS).toBe(2 * DAY);
    expect(RESERVE_KEY_POINT_MAX_AGE_MS).toBe(KEY_BAND_MAX_POINT_AGE_MS);
  });
});

describe('reserveBandOf', () => {
  it('splits at 10 ref and at the key price', () => {
    expect(reserveBandOf(89, K)).toBe('under-10-ref');
    expect(reserveBandOf(90, K)).toBe('to-1-key');
    expect(reserveBandOf(K - 1, K)).toBe('to-1-key');
    expect(reserveBandOf(K, K)).toBe('key-plus');
    expect(reserveBandOf(5 * K, K)).toBe('key-plus');
  });

  it('has no middle band when the key price is 90 scrap or less (or unknown)', () => {
    expect(reserveBandOf(89, 90)).toBe('under-10-ref');
    expect(reserveBandOf(90, 90)).toBe('key-plus');
    expect(reserveBandOf(95, 80)).toBe('key-plus');
    expect(reserveBandOf(100, 0)).toBe('key-plus');
    expect(reserveBandOf(100, Number.NaN)).toBe('key-plus');
  });
});

describe('lowerQuantile (Hyndman-Fan type 1)', () => {
  it('is null for an empty list and the only value for one', () => {
    expect(lowerQuantile([], 0.1)).toBeNull();
    expect(lowerQuantile([-0.2], 0.1)).toBe(-0.2);
    expect(lowerQuantile([1, 2], Number.NaN)).toBeNull();
  });

  it('takes index ceil(q n) - 1: index 1 of 20, index 2 of 30, and float noise in q n ignored', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i);
    expect(lowerQuantile(twenty, 0.1)).toBe(1);
    const thirty = Array.from({ length: 30 }, (_, i) => i);
    expect(lowerQuantile(thirty, 0.1)).toBe(2);
    expect(lowerQuantile(thirty, 0)).toBe(0);
    expect(lowerQuantile(thirty, 1)).toBe(29);
    // 0.07 x 100 is 7.000000000000001, whose ceiling would be 8: the 7th value (index 6), not the 8th.
    const hundred = Array.from({ length: 100 }, (_, i) => i);
    expect(0.07 * 100).toBeGreaterThan(7);
    expect(lowerQuantile(hundred, 0.07)).toBe(6);
    // 0.1 x 3 is 0.30000000000000004: still the first value.
    expect(lowerQuantile([5, 6, 7], 0.1)).toBe(5);
  });
});

describe('suggestedPctOf', () => {
  it('rounds the fall up to a whole percent, 0 for no fall, at most EXIT_RESERVE_MAX_PCT', () => {
    expect(suggestedPctOf(0.01)).toBe(0);
    expect(suggestedPctOf(0)).toBe(0);
    expect(suggestedPctOf(-0.0612)).toBe(0.07);
    // -0.07 x 100 is 7.000000000000001: the float noise is ignored.
    expect(suggestedPctOf(-0.07)).toBe(0.07);
    expect(suggestedPctOf(-0.8)).toBe(EXIT_RESERVE_MAX_PCT);
    expect(suggestedPctOf(-0.8)).toBe(0.5);
    expect(suggestedPctOf(Number.NaN)).toBe(0);
  });
});

describe('reserveHoldOf', () => {
  const all = (medianMs: number, count = 6, stillHeld = 2): TypicalHold => ({ medianMs, count, scope: 'all', stillHeld });

  it('falls back to the 1-day default without a typical hold over every sale', () => {
    const def = { holdMs: DAY, from: 'default', sales: 0, stillHeld: 0, clampedFromMs: null };
    expect(reserveHoldOf(null)).toEqual(def);
    expect(reserveHoldOf(undefined)).toEqual(def);
    expect(reserveHoldOf({ medianMs: 3 * DAY, count: 4, scope: 'item', stillHeld: 1 })).toEqual(def);
    expect(reserveHoldOf(all(Number.NaN))).toEqual(def);
    expect(reserveHoldOf(all(-5))).toEqual(def);
  });

  it("clamps the journal's hold to [1 h, 14 d] and carries its counts", () => {
    expect(reserveHoldOf(all(0))).toEqual({ holdMs: HOUR, from: 'journal', sales: 6, stillHeld: 2, clampedFromMs: 0 });
    expect(reserveHoldOf(all(30 * DAY, 9, 0))).toEqual({ holdMs: 14 * DAY, from: 'journal', sales: 9, stillHeld: 0, clampedFromMs: 30 * DAY });
    expect(reserveHoldOf(all(3 * DAY, 12, 5))).toEqual({ holdMs: 3 * DAY, from: 'journal', sales: 12, stillHeld: 5, clampedFromMs: null });
  });

  it('says when the clamp changed the hold, with the typical hold as it is (review)', () => {
    expect(reserveHoldOf(all(20 * 60_000, 12)).clampedFromMs).toBe(20 * 60_000);
    expect(reserveHoldOf(all(20 * 60_000, 12)).holdMs).toBe(HOUR);
    // At a bound exactly, the hold is the user's own: nothing was clamped.
    expect(reserveHoldOf(all(HOUR)).clampedFromMs).toBeNull();
    expect(reserveHoldOf(all(14 * DAY)).clampedFromMs).toBeNull();
    expect(reserveHoldOf(all(14 * DAY + 1)).clampedFromMs).toBe(14 * DAY + 1);
  });
});

describe('markRevenueScrap', () => {
  it("values a run's revenue order at the key price it is given, never the run's own start price (review)", () => {
    expect(markRevenueScrap(mark({ revKeys: 0, revMetalScrap: 50 }), null)).toBe(50);
    expect(markRevenueScrap(mark({ revKeys: 2, revMetalScrap: 9, keyScrap: 999 }), 560)).toBe(1129);
    expect(markRevenueScrap(mark({ revKeys: 2, revMetalScrap: 9, keyScrap: 560 }), 532)).toBe(1073);
  });

  it('is null when not observed: unverified, no revenue, keys with no key price known, or nothing above 0', () => {
    expect(markRevenueScrap(mark({ revVerified: false }), K)).toBeNull();
    expect(markRevenueScrap(mark({ revMetalScrap: null }), K)).toBeNull();
    // The run's own key price is never a fallback.
    expect(markRevenueScrap(mark({ revKeys: 2, revMetalScrap: 0, keyScrap: 560 }), null)).toBeNull();
    expect(markRevenueScrap(mark({ revKeys: 2, revMetalScrap: 0 }), 0)).toBeNull();
    expect(markRevenueScrap(mark({ revKeys: 2, revMetalScrap: 0 }), Number.NaN)).toBeNull();
    expect(markRevenueScrap(mark({ revKeys: 0, revMetalScrap: 0 }), K)).toBeNull();
    // A metal-only run needs no key price.
    expect(markRevenueScrap(mark({ revKeys: 0, revMetalScrap: 40, keyScrap: null }), null)).toBe(40);
    // revVerified null (an older run) is not "unverified".
    expect(markRevenueScrap(mark({ revVerified: null, revMetalScrap: 40 }), null)).toBe(40);
  });
});

describe('keyPriceAtOf (review): the key price at an instant from the key history already in memory', () => {
  it('is the newest point at or before t (buy, else sell), at most 2 d old, never after the history was loaded', () => {
    const start = NOW - 10 * DAY;
    const at = keyPriceAtOf(keyHistory([560, 561, 562], start, start + 3 * DAY));
    expect(at(start)).toBe(560);
    expect(at(start + DAY - 1)).toBe(560);
    expect(at(start + 2 * DAY + 5 * HOUR)).toBe(562);
    // Before the first point, or after the history was loaded: unknown.
    expect(at(start - 1)).toBeNull();
    expect(at(start + 3 * DAY + 1)).toBeNull();
    // Over 2 d after the newest point: unknown (sparse months never read as a flat key).
    const sparse = keyPriceAtOf({ loadedAt: NOW, points: [{ t: Math.floor((NOW - 3 * DAY) / 1000), buyScrap: 550, sellScrap: 560 }] });
    expect(sparse(NOW - DAY - 1)).toBe(550);
    expect(sparse(NOW - DAY + 1000)).toBeNull();
    // Sell when there is no buy; junk points are skipped.
    const sellOnly = keyPriceAtOf({ loadedAt: NOW, points: [{ t: Math.floor((NOW - HOUR) / 1000), buyScrap: null, sellScrap: 570 }, { t: Number.NaN, buyScrap: 1, sellScrap: 1 }] });
    expect(sellOnly(NOW)).toBe(570);
  });

  it('knows no key price without a history', () => {
    expect(keyPriceAtOf(null)(NOW)).toBeNull();
    expect(keyPriceAtOf(undefined)(NOW)).toBeNull();
    expect(keyPriceAtOf({ loadedAt: Number.NaN, points: keyHistory([560], NOW - HOUR).points })(NOW - HOUR)).toBeNull();
    expect(keyPriceAtOf({ loadedAt: NOW, points: null as unknown as HistoryPoint[] })(NOW)).toBeNull();
  });
});

describe('recordedWindows', () => {
  it('anchors the grid at the first run and steps by the hold', () => {
    const start = NOW - 5 * DAY;
    const ws = recordedWindows([mark({ fromAt: start, toAt: NOW })], DAY, null, NOW);
    expect(ws.map((w) => w.startAt)).toEqual([0, 1, 2, 3, 4].map((i) => start + i * DAY));
    expect(ws.every((w) => w.base === '378;6' && w.from === 50 && w.to === 50)).toBe(true);
    // Anchored at the first run, not at now: a run from 5 d 3 h ago starts its grid there.
    const off = recordedWindows([mark({ fromAt: start - 3 * HOUR, toAt: NOW })], DAY, null, NOW);
    expect(off[0]!.startAt).toBe(start - 3 * HOUR);
    expect(off).toHaveLength(5);
  });

  it('drops a window with a gap at either end (never filled)', () => {
    const start = NOW - 5 * DAY;
    const runs = [mark({ fromAt: start, toAt: start + 1.5 * DAY }), mark({ fromAt: start + 2.5 * DAY, toAt: NOW })];
    expect(recordedWindows(runs, DAY, null, NOW).map((w) => (w.startAt - start) / DAY)).toEqual([0, 3, 4]);
  });

  it('gives no window from a run whose revenue order was unverified', () => {
    expect(recordedWindows([mark({ fromAt: NOW - 5 * DAY, toAt: NOW, revVerified: false })], DAY, null, NOW)).toEqual([]);
  });

  it("values a 2-key end at the key price of that instant: a key move inside one run counts, the run's start price never (review)", () => {
    const start = NOW - 2 * DAY;
    const keyAt = keyPriceAtOf(keyHistory([560, 532, 532], start));
    // One uninterrupted run, started at 560: the key moved to 532 a day later without a new run.
    const one = recordedWindows([mark({ fromAt: start, toAt: NOW, revKeys: 2, revMetalScrap: 0, keyScrap: 560 })], DAY, null, NOW, keyAt);
    expect(one).toHaveLength(2);
    expect(one[0]).toMatchObject({ from: 1120, to: 1064 });
    expect((one[0]!.to - one[0]!.from) / one[0]!.from).toBeCloseTo(-0.05, 12);
    expect(one[1]).toMatchObject({ from: 1064, to: 1064 });
    // The same market with the run split where the app restarted: the same windows (uptime no longer moves the figure).
    const split = [mark({ fromAt: start, toAt: start + DAY - 1, revKeys: 2, revMetalScrap: 0, keyScrap: 560 }), mark({ fromAt: start + DAY, toAt: NOW, revKeys: 2, revMetalScrap: 0, keyScrap: 532 })];
    expect(recordedWindows(split, DAY, null, NOW, keyAt)).toEqual(one);
    // No key history: a keyed end is not observed (never valued at the run's own or today's key price).
    expect(recordedWindows(split, DAY, null, NOW)).toEqual([]);
    // A metal-only run needs none.
    expect(recordedWindows([mark({ fromAt: start, toAt: NOW, revKeys: 0, revMetalScrap: 40, keyScrap: null })], DAY, null, NOW)).toHaveLength(2);
  });

  it('reads nothing before the buyer-settings change: the grid starts at it (review: an earlier change is not kept)', () => {
    const start = NOW - 3 * DAY;
    const runs = [mark({ fromAt: start, toAt: NOW })];
    const at = (s: number | null) => recordedWindows(runs, DAY, s, NOW).map((w) => (w.startAt - start) / DAY);
    expect(at(null)).toEqual([0, 1, 2]);
    expect(at(start)).toEqual([0, 1, 2]);
    expect(at(start - 5 * DAY)).toEqual([0, 1, 2]);
    expect(at(start + DAY)).toEqual([1, 2]);
    expect(at(start + 1.5 * DAY)).toEqual([1.5]);
    // A change less than one hold ago leaves no recorded window.
    expect(at(NOW - HOUR)).toEqual([]);
  });

  it('a window before the last stamp could span an earlier change no stamp remembers: none is read (review)', () => {
    // Four bases paid 400 until day -40, when the user blocklisted that buyer (change 1, its stamp since overwritten);
    // the next buyer pays 300. At day -5 another buyer setting changed (change 2, the only stamp kept). 14-day hold.
    const runs = ['a', 'b', 'c', 'd'].flatMap((base) => [
      mark({ baseSku: base, fromAt: NOW - 90 * DAY, toAt: NOW - 40 * DAY - 1, revMetalScrap: 400 }),
      mark({ baseSku: base, fromAt: NOW - 40 * DAY, toAt: NOW, revMetalScrap: 300 }),
    ]);
    expect(recordedWindows(runs, 14 * DAY, NOW - 5 * DAY, NOW)).toEqual([]);
    const s = reserveSuggestionOf({ marks: runs, histories: new Map(), hold: { medianMs: 14 * DAY, count: 6, scope: 'all', stillHeld: 0 }, keyScrap: K, settingsAt: NOW - 5 * DAY, now: NOW });
    expect(s.bands.every((b) => b.recorded.windows === 0 && b.source === null && b.suggestedPct === null)).toBe(true);
    // Without the stamp the windows across day -40 are read (a real market move, as far as the data can tell).
    expect(recordedWindows(runs, 14 * DAY, null, NOW).some((w) => w.from === 400 && w.to === 300)).toBe(true);
  });

  it('keeps each base\'s newest RESERVE_MAX_WINDOWS_PER_ITEM windows, bases by name', () => {
    const start = NOW - 3 * DAY;
    const ws = recordedWindows([mark({ baseSku: 'b', fromAt: start, toAt: NOW }), mark({ baseSku: 'a', fromAt: start, toAt: NOW })], HOUR, null, NOW);
    expect(ws).toHaveLength(2 * RESERVE_MAX_WINDOWS_PER_ITEM);
    expect(ws.slice(0, 30).every((w) => w.base === 'a')).toBe(true);
    const a = ws.slice(0, 30);
    expect(a.at(-1)!.startAt).toBe(NOW - HOUR);
    expect(a[0]!.startAt).toBe(NOW - 30 * HOUR);
  });

  it('ignores what lies before the lookback, and a run that starts in the future', () => {
    expect(recordedWindows([mark({ fromAt: NOW - 200 * DAY, toAt: NOW - 100 * DAY })], DAY, null, NOW)).toEqual([]);
    const long = recordedWindows([mark({ fromAt: NOW - 100 * DAY, toAt: NOW })], 7 * DAY, null, NOW);
    expect(long[0]!.startAt).toBe(NOW - RESERVE_LOOKBACK_MS);
    expect(recordedWindows([mark({ fromAt: NOW + DAY, toAt: NOW + 2 * DAY })], DAY, null, NOW)).toEqual([]);
  });

  it('skips junk runs and a bad hold or clock', () => {
    const start = NOW - 3 * DAY;
    expect(recordedWindows([mark({ fromAt: start, toAt: start - 1 }), mark({ fromAt: Number.NaN })], DAY, null, NOW)).toEqual([]);
    expect(recordedWindows([mark({ fromAt: start, toAt: NOW })], 0, null, NOW)).toEqual([]);
    expect(recordedWindows([mark({ fromAt: start, toAt: NOW })], DAY, null, Number.NaN)).toEqual([]);
    expect(recordedWindows(null as unknown as HoldingMark[], DAY, null, NOW)).toEqual([]);
  });
});

describe('pricedbWindows', () => {
  it('pairs daily points on the same grid, bases by name, `t` in seconds', () => {
    const start = NOW - 4 * DAY;
    const ws = pricedbWindows(new Map([['b', dailyPoints([100, 90, 99, 99, 120], start)], ['a', dailyPoints([200, 210], start + 3 * DAY)]]), DAY, NOW);
    expect(ws.map((w) => [w.base, (w.startAt - start) / DAY, w.from, w.to])).toEqual([
      ['a', 3, 200, 210],
      ['b', 0, 100, 90],
      ['b', 1, 90, 99],
      ['b', 2, 99, 99],
      ['b', 3, 99, 120],
    ]);
  });

  it('lets a point stand for at most max(1 h, hold / 4) after it', () => {
    const start = NOW - DAY;
    const pt = (at: number, v: number): HistoryPoint => ({ t: Math.floor(at / 1000), buyScrap: v, sellScrap: null });
    // A 1-day hold: 6 h. The end point 4 h before the end still counts; 7 h before does not.
    expect(pricedbWindows(new Map([['a', [pt(start, 100), pt(start + 20 * HOUR, 90)]]]), DAY, NOW)).toEqual([{ base: 'a', startAt: start, from: 100, to: 90 }]);
    expect(pricedbWindows(new Map([['a', [pt(start, 100), pt(start + 17 * HOUR, 90)]]]), DAY, NOW)).toEqual([]);
    // A 2-hour hold: hold / 4 is 30 min, so the 1 h floor applies.
    const s2 = NOW - 2 * HOUR;
    expect(pricedbWindows(new Map([['a', [pt(s2, 100), pt(s2 + HOUR, 95)]]]), 2 * HOUR, NOW)).toEqual([{ base: 'a', startAt: s2, from: 100, to: 95 }]);
    expect(pricedbWindows(new Map([['a', [pt(s2, 100), pt(s2 + 59 * MIN, 95)]]]), 2 * HOUR, NOW)).toEqual([]);
  });

  it('loses the windows a weekly tail cannot bridge', () => {
    const weekly = Array.from({ length: 8 }, (_, i) => NOW - 70 * DAY + i * 7 * DAY);
    const daily = Array.from({ length: 6 }, (_, i) => NOW - 5 * DAY + i * DAY);
    const pts: HistoryPoint[] = [...weekly, ...daily].map((at) => ({ t: Math.floor(at / 1000), buyScrap: 100, sellScrap: 110 }));
    const ws = pricedbWindows(new Map([['a', pts]]), DAY, NOW);
    // Only the daily tail's five day pairs: no weekly day is bridged.
    expect(ws.map((w) => w.startAt)).toEqual(daily.slice(0, 5));
  });

  it('skips a null, zero or non-finite buyScrap (the window then has a missing end)', () => {
    const start = NOW - 3 * DAY;
    const ws = pricedbWindows(new Map([['a', [...dailyPoints([100, null, 0, 110], start), { t: Number.NaN, buyScrap: 1, sellScrap: 1 }]]]), DAY, NOW);
    expect(ws).toEqual([]);
    expect(pricedbWindows(new Map([['a', []]]), DAY, NOW)).toEqual([]);
  });
});

describe('one meaning per band (review): both sources value keys at their own time', () => {
  it('a key price 5% down over the hold reads the same from one uninterrupted recorded run and from PriceDB', () => {
    const start = NOW - 2 * DAY;
    const keys = keyHistory([560, 532, 532], start);
    // One run (the order never changed, so the recorder never split it), begun at 560.
    const rec = recordedWindows([mark({ fromAt: start, toAt: NOW, revKeys: 3, revMetalScrap: 18, keyScrap: 560 })], DAY, null, NOW, keyPriceAtOf(keys));
    // PriceDB's history() values each record at that day's key price from the same key history: 3 keys + 18 scrap at 560, then at 532.
    const pdb = pricedbWindows(new Map([['378;6', dailyPoints([3 * 560 + 18, 3 * 532 + 18, 3 * 532 + 18], start)]]), DAY, NOW);
    const relRec = rec.map((w) => (w.to - w.from) / w.from);
    const relPdb = pdb.map((w) => (w.to - w.from) / w.from);
    expect(relRec).toHaveLength(2);
    expect(relRec).toEqual(relPdb);
    expect(relRec[0]).toBeCloseTo(-84 / 1698, 12);
    expect(reserveBandOf(rec[0]!.from, K)).toBe('key-plus');
  });

  it("the finding's case: a 5% key fall inside one 30-day run suggests what PriceDB does, restart or not", () => {
    // Six bases, each a 2-key order unchanged for 30 days; the key steps from 560 to 532 at day -10; a 7-day hold.
    const hold: TypicalHold = { medianMs: 7 * DAY, count: 6, scope: 'all', stillHeld: 0 };
    const start = NOW - 30 * DAY;
    const keyValues = Array.from({ length: 31 }, (_, i) => (i < 20 ? 560 : 532));
    const keys = keyHistory(keyValues, start);
    const bases = ['a', 'b', 'c', 'd', 'e', 'f'];
    const oneRun = bases.map((base) => mark({ baseSku: base, fromAt: start, toAt: NOW, revKeys: 2, revMetalScrap: 0, keyScrap: 560 }));
    const restarted = bases.flatMap((base) => [
      mark({ baseSku: base, fromAt: start, toAt: NOW - 10 * DAY - 1, revKeys: 2, revMetalScrap: 0, keyScrap: 560 }),
      mark({ baseSku: base, fromAt: NOW - 10 * DAY, toAt: NOW, revKeys: 2, revMetalScrap: 0, keyScrap: 532 }),
    ]);
    const histories = new Map(bases.map((base) => [base, dailyPoints(keyValues.map((k) => 2 * k), start)] as const));
    const args = { histories: new Map<string, HistoryPoint[]>(), hold, keyScrap: 532, settingsAt: null, now: NOW, keyHistory: keys };
    const a = reserveSuggestionOf({ ...args, marks: oneRun });
    const b = reserveSuggestionOf({ ...args, marks: restarted });
    const p = reserveSuggestionOf({ ...args, marks: [], histories });
    const keyPlus = (s: typeof a) => s.bands.find((x) => x.band === 'key-plus')!;
    expect(keyPlus(a)).toMatchObject({ source: 'recorded', suggestedPct: 0.05 });
    expect(keyPlus(a).p10).toBeCloseTo(-0.05, 12);
    expect(keyPlus(b)).toEqual(keyPlus(a));
    expect(keyPlus(p)).toMatchObject({ source: 'pricedb', suggestedPct: 0.05 });
  });
});

describe('reserveSuggestionOf', () => {
  const start = NOW - 11 * DAY;
  // Three items under 10 ref, 10 daily runs each: 9 windows each, 27 in all.
  const smallValues = [
    [50, 48, 49, 47, 50, 46, 48, 49, 45, 47],
    [60, 61, 58, 60, 59, 55, 57, 60, 61, 58],
    [40, 40, 39, 41, 38, 40, 36, 39, 40, 41],
  ];
  const smallRuns = smallValues.flatMap((vs, i) => dailyRuns(`s${i}`, vs, start));
  // Three PriceDB items between 10 ref and 1 key, 8 daily points each: 7 windows each, 21 in all.
  const midValues = [
    [200, 190, 195, 180, 200, 210, 190, 185],
    [300, 310, 305, 290, 280, 300, 295, 310],
    [150, 140, 150, 152, 149, 151, 150, 147],
  ];
  const midHistories = new Map(midValues.map((vs, i) => [`m${i}`, dailyPoints(vs, NOW - 8 * DAY)] as const));

  it('takes recorded exits when they are enough, PriceDB when they are not, else not enough data, in band order', () => {
    const s = reserveSuggestionOf({ marks: smallRuns, histories: midHistories, hold: null, keyScrap: K, settingsAt: null, now: NOW });
    expect(s.bands.map((b) => b.band)).toEqual(RESERVE_BANDS);
    const [small, mid, keyPlus] = s.bands;
    const recRel = smallValues.flatMap(relOf);
    expect(small).toMatchObject({ source: 'recorded', recorded: { windows: 27, items: 3 }, pricedb: { windows: 0, items: 0 } });
    expect(small!.p10).toBe(p10Of(recRel));
    expect(small!.suggestedPct).toBe(suggestedPctOf(p10Of(recRel)));
    const pdbRel = midValues.flatMap(relOf);
    expect(mid).toMatchObject({ source: 'pricedb', recorded: { windows: 0, items: 0 }, pricedb: { windows: 21, items: 3 } });
    expect(mid!.p10).toBe(p10Of(pdbRel));
    expect(mid!.suggestedPct).toBe(suggestedPctOf(p10Of(pdbRel)));
    expect(mid!.suggestedPct!).toBeGreaterThan(0);
    expect(keyPlus).toEqual({ band: 'key-plus', source: null, p10: null, suggestedPct: null, recorded: { windows: 0, items: 0 }, pricedb: { windows: 0, items: 0 } });
  });

  it('prefers recorded exits over PriceDB in the same band, never pooling them', () => {
    const histories = new Map(smallValues.map((vs, i) => [`p${i}`, dailyPoints(vs.map((v) => v + 1), NOW - 10 * DAY)] as const));
    const s = reserveSuggestionOf({ marks: smallRuns, histories, hold: null, keyScrap: K, settingsAt: null, now: NOW });
    expect(s.bands[0]).toMatchObject({ source: 'recorded', recorded: { windows: 27, items: 3 }, pricedb: { windows: 27, items: 3 } });
    expect(s.bands[0]!.p10).toBe(p10Of(smallValues.flatMap(relOf)));
    // Without the recorded runs, the same band falls back to PriceDB.
    const fallback = reserveSuggestionOf({ marks: [], histories, hold: null, keyScrap: K, settingsAt: null, now: NOW });
    expect(fallback.bands[0]).toMatchObject({ source: 'pricedb', recorded: { windows: 0, items: 0 }, pricedb: { windows: 27, items: 3 } });
  });

  it('says not enough data below 20 windows or below 3 items, with both counts reported', () => {
    // Two items, plenty of windows.
    const twoItems = smallValues.slice(0, 2).flatMap((vs, i) => dailyRuns(`s${i}`, [...vs, ...vs, ...vs], NOW - 31 * DAY));
    const a = reserveSuggestionOf({ marks: twoItems, histories: new Map(), hold: null, keyScrap: K, settingsAt: null, now: NOW });
    expect(a.bands[0]).toMatchObject({ source: null, p10: null, suggestedPct: null, recorded: { windows: 58, items: 2 } });
    // Three items, 18 windows.
    const fewWindows = smallValues.flatMap((vs, i) => dailyRuns(`s${i}`, vs.slice(0, 7), NOW - 8 * DAY));
    const b = reserveSuggestionOf({ marks: fewWindows, histories: midHistories, hold: null, keyScrap: K, settingsAt: null, now: NOW });
    expect(b.bands[0]).toMatchObject({ source: null, recorded: { windows: 18, items: 3 }, pricedb: { windows: 0, items: 0 } });
    expect(b.bands[1]).toMatchObject({ source: 'pricedb' });
  });

  it("uses the journal's hold, clamps settingsAt to now, and carries the hold, key price and time", () => {
    const hold: TypicalHold = { medianMs: 2 * DAY, count: 7, scope: 'all', stillHeld: 3 };
    const s = reserveSuggestionOf({ marks: smallRuns, histories: midHistories, hold, keyScrap: 600, settingsAt: NOW + 5 * DAY, now: NOW });
    expect(s).toMatchObject({ holdMs: 2 * DAY, holdFrom: 'journal', holdSales: 7, holdStillHeld: 3, lookbackMs: RESERVE_LOOKBACK_MS, settingsAt: NOW, keyScrap: 600, generatedAt: NOW });
    // A settings change clamped to now leaves nothing recorded since it (review: nothing before the stamp is read).
    expect(s.bands[0]!.recorded.windows).toBe(0);
    expect(reserveSuggestionOf({ marks: smallRuns, histories: midHistories, hold, keyScrap: 600, settingsAt: null, now: NOW }).bands[0]!.recorded.windows).toBeGreaterThan(0);
    const def = reserveSuggestionOf({ marks: [], histories: new Map(), hold: null, keyScrap: K, settingsAt: Number.NaN, now: NOW });
    expect(def).toMatchObject({ holdMs: DAY, holdFrom: 'default', holdSales: 0, holdStillHeld: 0, holdClampedFromMs: null, settingsAt: null });
    expect(s.holdClampedFromMs).toBeNull();
    // A typical hold under 1 h is measured over 1 h, and the suggestion keeps the user's own hold.
    const quick = reserveSuggestionOf({ marks: [], histories: new Map(), hold: { medianMs: 20 * 60_000, count: 12, scope: 'all', stillHeld: 0 }, keyScrap: K, settingsAt: null, now: NOW });
    expect(quick).toMatchObject({ holdMs: 3_600_000, holdFrom: 'journal', holdSales: 12, holdClampedFromMs: 20 * 60_000 });
  });

  it('reads only the recorded windows from the buyer-settings change on (review)', () => {
    const s = reserveSuggestionOf({ marks: smallRuns, histories: new Map(), hold: null, keyScrap: K, settingsAt: start + 4.5 * DAY, now: NOW });
    // The grid starts at the change: day 4.5 to 8.5 per item (the runs end at day 10), 5 each, not the 24 a straddle-only
    // skip kept (the windows before the change could span an earlier change no stamp remembers).
    expect(s.bands[0]!.recorded).toEqual({ windows: 15, items: 3 });
    expect(s.bands[0]!.source).toBeNull();
  });

  it('values recorded exits in keys at the key history it is given; without one they are not observed', () => {
    const keyed = ['k0', 'k1', 'k2'].flatMap((base) => dailyRuns(base, [0, 0, 0, 0, 0, 0, 0, 0], NOW - 8 * DAY, { revKeys: 2 }));
    const keys = keyHistory([560, 556, 552, 548, 544, 540, 536, 532, 528], NOW - 8 * DAY);
    const s = reserveSuggestionOf({ marks: keyed, histories: new Map(), hold: null, keyScrap: K, settingsAt: null, now: NOW, keyHistory: keys });
    // 7 windows per item (8 day-long runs), each a 4-scrap key fall on 2 keys; the 3rd lowest of 21 is a fall from 536.
    expect(s.bands[2]).toMatchObject({ band: 'key-plus', source: 'recorded', recorded: { windows: 21, items: 3 } });
    expect(s.bands[2]!.p10).toBeCloseTo(-4 / 536, 12);
    const none = reserveSuggestionOf({ marks: keyed, histories: new Map(), hold: null, keyScrap: K, settingsAt: null, now: NOW });
    expect(none.bands[2]).toMatchObject({ source: null, recorded: { windows: 0, items: 0 } });
  });
});
