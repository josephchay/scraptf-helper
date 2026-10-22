// 0.9 (#17): the key's 7-day move band (keyMoveBandOf) from PriceDB key history already loaded: daily 7-day spans
// from the newest point back, each counted only when both ends have a point at most 2 days older (the first failing span
// ends the walk; a span on the same two points as the previous one counts once), the 10th and 90th percentile of the
// moves, and nothing below 28 spans (about 4 separate weeks). The plan's computed vectors
// (T = 1791969123 s), the buy-else-sell rule, and the key-exposure reason quoting the band only when it is given.
// A description of past moves, never a forecast. Pure; no network.

import { describe, expect, it } from 'vitest';
import { refToScrap } from '../../src/shared/currency';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  KEY_BAND_HIGH_Q,
  KEY_BAND_LOW_Q,
  KEY_BAND_MAX_POINT_AGE_MS,
  KEY_BAND_MAX_SPANS,
  KEY_BAND_MIN_SPANS,
  KEY_BAND_SPAN_MS,
  KEY_BAND_STEP_MS,
  holdingAdvice,
  keyMoveBandOf,
} from '../../src/shared/holdingAdvice';
import { holdingRow, type HoldingBuySide } from '../../src/shared/holdings';
import type { HistoryPoint, HoldingAdviceReason, HoldingRow, OrderSummary } from '../../src/shared/types';
import { fixture } from '../pricedb/helpers';

const T = 1791969123;
const DAY_S = 86_400;
const DAY = DAY_S * 1000;
const LOADED = T * 1000 + 60_000;

const pt = (t: number, buyScrap: number | null, sellScrap: number | null = null): HistoryPoint => ({ t, buyScrap, sellScrap });
/** `n` daily points ending at T, the d-th (oldest first) at value(d). */
const daily = (n: number, value: (d: number) => number): HistoryPoint[] => Array.from({ length: n }, (_, d) => pt(T - (n - 1 - d) * DAY_S, value(d)));
/** Four points 10 days apart (T-80 d to T-50 d), then `n` daily points ending at T. */
const sparseThenDaily = (n: number): HistoryPoint[] => [...[80, 70, 60, 50].map((ago) => pt(T - ago * DAY_S, 590)), ...daily(n, (d) => 600 + d)];

describe('keyMoveBandOf: the constants', () => {
  it('measures 7-day spans a day apart, ends at most 2 days old, 28 to 180 spans, the 10th to 90th percentile', () => {
    expect(KEY_BAND_SPAN_MS).toBe(7 * DAY);
    expect(KEY_BAND_STEP_MS).toBe(DAY);
    expect(KEY_BAND_MAX_POINT_AGE_MS).toBe(2 * DAY);
    expect(KEY_BAND_MIN_SPANS).toBe(28);
    expect(KEY_BAND_MAX_SPANS).toBe(180);
    expect([KEY_BAND_LOW_Q, KEY_BAND_HIGH_Q]).toEqual([0.1, 0.9]);
  });
});

describe('keyMoveBandOf: the vectors', () => {
  it('45 daily points rising 1 a day: every 7-day move is +7, over 38 spans from T-44 d to T', () => {
    expect(keyMoveBandOf(daily(45, (d) => 600 + d), LOADED)).toEqual({
      lowScrap: 7,
      highScrap: 7,
      spans: 38,
      fromAt: (T - 44 * DAY_S) * 1000,
      toAt: T * 1000,
      loadedAt: LOADED,
    });
  });

  it('45 daily points of a wobble give the 10th and 90th percentile of the moves', () => {
    expect(keyMoveBandOf(daily(45, (d) => 600 + ((d * 7) % 11) - 5), LOADED)).toMatchObject({ lowScrap: -6, highScrap: 5, spans: 38 });
  });

  it('skips spans whose ends have no point within 2 days: sparse months then 34 daily points give 27 spans, no band', () => {
    expect(keyMoveBandOf(sparseThenDaily(34), LOADED)).toBeNull();
  });

  it('35 daily points after the sparse months reach 28 spans over 34 days (4 separate weeks)', () => {
    const b = keyMoveBandOf(sparseThenDaily(35), LOADED);
    expect(b).toMatchObject({ lowScrap: 7, highScrap: 7, spans: 28 });
    expect(b!.toAt - b!.fromAt).toBe(34 * DAY);
    expect(Math.floor((b!.toAt - b!.fromAt) / KEY_BAND_SPAN_MS)).toBe(4);
  });

  it('review fix: sparse points 6-9 days apart never count, so 20 days of a 900 s tail (14 spans) give no band', () => {
    // RESEARCH §4.7's shape: a few points a month, then the dense tail. Ends a week apart pass the 2-day age test for
    // 1-3 neighbouring span ends each; counted, they gave 59 spans from T-185 d, "about 26 separate weeks".
    const sparse: HistoryPoint[] = [];
    const gaps = [6, 9, 7, 8];
    for (let ago = 200, g = 0; ago > 21; ago -= gaps[g++ % gaps.length]!) sparse.push(pt(T - ago * DAY_S, 560 + ((200 - ago) >> 2)));
    const tail: HistoryPoint[] = [];
    for (let s = 20 * DAY_S; s >= 0; s -= 900) tail.push(pt(T - s, 600 + Math.round(3 * Math.sin(s / DAY_S))));
    expect(keyMoveBandOf([...sparse, ...tail], LOADED)).toBeNull();
  });

  it('review fix: two sparse points a week apart months earlier neither add spans nor stretch the dates', () => {
    const dense = daily(35, (d) => 600 + d);
    const b = keyMoveBandOf([pt(T - 120 * DAY_S, 560), pt(T - 113 * DAY_S, 590), ...dense], LOADED);
    // Counted, they added the same pair 3 times: 31 spans from T-120 d, "about 17 separate weeks".
    expect(b).toEqual(keyMoveBandOf(dense, LOADED));
    expect(b).toMatchObject({ lowScrap: 7, highScrap: 7, spans: 28, fromAt: (T - 34 * DAY_S) * 1000, toAt: T * 1000 });
    expect(Math.floor((b!.toAt - b!.fromAt) / KEY_BAND_SPAN_MS)).toBe(4);
  });

  it('review fix: a gap past 2 days ends the walk; only the newest unbroken run counts', () => {
    // 40 daily points, a 5-day hole, then 35 more: only the newest 35 (28 spans) count.
    const old = daily(40, (d) => 500 + 3 * d).map((p) => pt(p.t - 40 * DAY_S, p.buyScrap));
    const b = keyMoveBandOf([...old, ...daily(35, (d) => 600 + d)], LOADED);
    expect(b).toMatchObject({ lowScrap: 7, highScrap: 7, spans: 28, fromAt: (T - 34 * DAY_S) * 1000 });
  });

  it('review fix: neighbouring span ends that resolve to the same two points count once', () => {
    /** Points 3 days apart (every end within 2 days of one), rising 1 a day, the newest at T. */
    const every3 = (days: number): HistoryPoint[] => Array.from({ length: days / 3 + 1 }, (_, k) => pt(T - (days - 3 * k) * DAY_S, 600 + days - 3 * (days / 3 - k)));
    // 45 days: 39 span ends, but every third repeats its neighbour's points: 26 spans, no band.
    expect(keyMoveBandOf(every3(45), LOADED)).toBeNull();
    // 60 days: 54 span ends, 36 distinct pairs (6-day and 9-day moves between the points).
    expect(keyMoveBandOf(every3(60), LOADED)).toMatchObject({ lowScrap: 6, highScrap: 9, spans: 36, fromAt: (T - 59 * DAY_S) * 1000 });
  });

  it('30 daily points (23 spans) give no band', () => {
    expect(keyMoveBandOf(daily(30, (d) => 600 + d), LOADED)).toBeNull();
  });

  it('the PriceDB key history fixture (40 points over about 10 h) gives no band', () => {
    const recs = fixture<{ time: number; buy: { keys?: number; metal?: number }; sell: { keys?: number; metal?: number } }[]>('item-history-key.json');
    const side = (s: { keys?: number; metal?: number }) => ((s.keys ?? 0) === 0 && (s.metal ?? 0) > 0 ? refToScrap(s.metal ?? 0) : null);
    const points = recs.map((r) => pt(Math.floor(r.time), side(r.buy), side(r.sell)));
    expect(points.length).toBeGreaterThan(30);
    expect(keyMoveBandOf(points, LOADED)).toBeNull();
  });

  it('uses at most the newest 180 spans', () => {
    const b = keyMoveBandOf(daily(400, (d) => 600 + (d % 3)), LOADED);
    expect(b?.spans).toBe(180);
    expect(b?.fromAt).toBe((T - 179 * DAY_S) * 1000 - 7 * DAY);
  });
});

describe('keyMoveBandOf: the points it reads', () => {
  const rising = daily(45, (d) => 600 + d);
  const band = keyMoveBandOf(rising, LOADED);

  it('takes the buy price, else the sell price', () => {
    const sellOnly = rising.map((p) => pt(p.t, null, p.buyScrap));
    expect(keyMoveBandOf(sellOnly, LOADED)).toEqual(band);
    const mixed = rising.map((p, i) => (i % 2 === 0 ? pt(p.t, p.buyScrap, 9999) : pt(p.t, 0, p.buyScrap)));
    expect(keyMoveBandOf(mixed, LOADED)).toEqual(band);
  });

  it('drops points with no positive price or no time, so they never end a span', () => {
    // A junk point after T would be the newest point if it were read.
    const junk = [pt(T + 3600, 0, -1), pt(T + 7200, null, null), pt(Number.NaN, 700, 700), pt(T + 10_800, Number.NaN, 0)];
    expect(keyMoveBandOf([...junk, ...rising], LOADED)).toEqual(band);
    expect(keyMoveBandOf([...rising].reverse(), LOADED)).toEqual(band);
  });

  it('is null with fewer than 2 usable points or no array', () => {
    expect(keyMoveBandOf([], LOADED)).toBeNull();
    expect(keyMoveBandOf([pt(T, 600)], LOADED)).toBeNull();
    expect(keyMoveBandOf(null as unknown as HistoryPoint[], LOADED)).toBeNull();
  });
});

describe('holdingAdvice: key-exposure quotes the band only when given (0.9, #17)', () => {
  const NOW = T * 1000 + 3_600_000;
  const KEY = 567;
  const P = DEFAULT_SETTINGS.profit;

  function order(value: number): OrderSummary {
    return { listingId: 'o', steamid: 'S', userName: 'Buyer', keys: 0, metalScrap: value, valueScrap: value, isBot: true, online: null, lastEventAt: NOW - 60_000, bumpedAt: null, details: '', flags: [], eligible: true };
  }

  /** Bought for 1 key while a key was 540; the buyer pays 600 scrap in metal: the sale nets -1 key. */
  function keyRow(): HoldingRow {
    const o = order(600);
    const buy: HoldingBuySide = {
      revenueScrap: 600,
      bestScrap: 600,
      instantScrap: 600,
      revenueOrder: o,
      bestOrder: o,
      buyerCount: 2,
      confidence: 60,
      confidenceLevel: 'medium',
      flags: [],
      lastOrderChangeAt: NOW - 60_000,
      nextBuyer: null,
      verifiedBuyerCount: 1,
    };
    const lot = { id: 1, ts: NOW - 3 * DAY, costScrap: 540, keys: 1, scrap: 0, keyPriceScrap: 540 };
    return holdingRow({ sku: '378;6', name: 'Team Captain', qty: 1, costScrap: 540, lots: [lot] }, 'hats', buy, P, KEY, null, { ask: null, refs: null, snapshotAt: NOW - 60_000 });
  }

  const exposure = (rs: readonly HoldingAdviceReason[]) => rs.find((r) => r.code === 'key-exposure');

  it('adds band to the reason with opts.keyBand, and nothing else changes', () => {
    const r = keyRow();
    const b = keyMoveBandOf(daily(45, (d) => 600 + d), LOADED)!;
    const plain = holdingAdvice(r, null, P, KEY, NOW);
    const withBand = holdingAdvice(r, null, P, KEY, NOW, { keyBand: b });
    expect(exposure(plain.reasons)).toEqual({ code: 'key-exposure', netKeys: -1, boughtKeyScrap: 540, nowKeyScrap: KEY });
    expect(exposure(withBand.reasons)).toEqual({ code: 'key-exposure', netKeys: -1, boughtKeyScrap: 540, nowKeyScrap: KEY, band: b });
    expect(withBand.kind).toBe(plain.kind);
    expect(withBand.reasons.map((x) => (x.code === 'key-exposure' ? exposure(plain.reasons) : x))).toEqual(plain.reasons);
  });

  it('adds no band key without one (absent or null)', () => {
    const r = keyRow();
    expect('band' in exposure(holdingAdvice(r, null, P, KEY, NOW, { keyBand: null }).reasons)!).toBe(false);
    expect('band' in exposure(holdingAdvice(r, null, P, KEY, NOW, {}).reasons)!).toBe(false);
  });
});
