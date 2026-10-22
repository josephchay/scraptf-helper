// 0.9 (#17): how big a recorded trend is (holdingExitHistory's trend.size): a Theil-Sen line through the newest
// stretches with an exit that observed the newest one's sources, its change over the span and the median absolute
// residual. It needs 5 points over 48 h, uses at most the newest 60, adds the trend-size context reason after falling,
// and never changes a verdict. Measured from recorded runs, never a forecast. Pure; no network.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  HOLDING_TREND_MIN_OBSERVED_MS,
  HOLDING_TREND_SIZE_MAX_POINTS,
  HOLDING_TREND_SIZE_MIN_POINTS,
  holdingAdvice,
  holdingExitHistory,
} from '../../src/shared/holdingAdvice';
import { holdingRow, type HoldingBuySide } from '../../src/shared/holdings';
import type { HoldingAdviceReason, HoldingExitHistory, HoldingMark, HoldingRow, OrderSummary, ProfitSettings } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY = 567;
const P: ProfitSettings = DEFAULT_SETTINGS.profit;

let nextId = 1;
/** A run with a verified revenue order at `rev` scrap (metal), from `fromAt` to `toAt`. */
function mark(fromAt: number, toAt: number, rev: number | null, over: Partial<HoldingMark> = {}): HoldingMark {
  return {
    id: nextId++,
    baseSku: '378;6',
    fromAt,
    toAt,
    revKeys: rev === null ? null : 0,
    revMetalScrap: rev,
    revIsBot: true,
    revVerified: rev === null ? null : true,
    bestKeys: rev === null ? null : 0,
    bestMetalScrap: rev,
    nextKeys: null,
    nextMetalScrap: null,
    buyerCount: 2,
    verifiedBuyerCount: 2,
    askKeys: null,
    askMetalScrap: null,
    askCount: null,
    scraptfPaysKeys: null,
    scraptfPaysScrap: null,
    keyScrap: KEY,
    ...over,
  };
}

/** Contiguous runs of `ms`, one per value, the first starting at `start`. */
function runs(values: readonly number[], ms: number, start: number): HoldingMark[] {
  return values.map((v, i) => mark(start + i * ms, start + (i + 1) * ms, v));
}

function order(value: number): OrderSummary {
  return {
    listingId: `o${value}`,
    steamid: `S${value}`,
    userName: 'Buyer',
    keys: 0,
    metalScrap: value,
    valueScrap: value,
    isBot: true,
    online: null,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
}

function row(revenue: number, over: Partial<HoldingRow> = {}): HoldingRow {
  const o = order(revenue);
  const buy: HoldingBuySide = {
    revenueScrap: revenue,
    bestScrap: revenue,
    instantScrap: revenue,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 2,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    nextBuyer: null,
    verifiedBuyerCount: 1,
  };
  const lot = { id: 1, ts: NOW - 4 * DAY, costScrap: 100, keys: 0, scrap: 100, keyPriceScrap: KEY };
  const pos = { sku: '378;6', name: 'Team Captain', qty: 1, costScrap: 100, lots: [lot] };
  return { ...holdingRow(pos, 'hats', buy, P, KEY, null, { ask: null, refs: null, snapshotAt: NOW - HOUR }), ...over };
}

const codes = (rs: readonly HoldingAdviceReason[]) => rs.map((r) => r.code);
const SIX = [160, 150, 140, 130, 120, 110];

describe('holdingExitHistory: trend.size (0.9, #17)', () => {
  it('fits six falling 10 h runs: -24 scrap a day, -50 over the span, no spread', () => {
    expect(HOLDING_TREND_SIZE_MIN_POINTS).toBe(5);
    expect(HOLDING_TREND_SIZE_MAX_POINTS).toBe(60);
    const h = holdingExitHistory(runs(SIX, 10 * HOUR, NOW - 60 * HOUR), NOW - 60 * HOUR, KEY, NOW);
    expect(h.trend?.direction).toBe('falling');
    expect(h.trend?.size).toEqual({ slopeScrapPerDay: -24, changeScrap: -50, spreadScrap: 0, points: 6, fromAt: NOW - 55 * HOUR, toAt: NOW - 5 * HOUR });
    // A holding that began earlier reads the same.
    expect(holdingExitHistory(runs(SIX, 10 * HOUR, NOW - 60 * HOUR), NOW - 9 * DAY, KEY, NOW).trend?.size).toEqual(h.trend?.size);
  });

  it('is robust to one outlier: the 4th run at 200 gives the same slope, change and spread', () => {
    const h = holdingExitHistory(runs([160, 150, 140, 200, 120, 110], 10 * HOUR, NOW - 60 * HOUR), NOW - 60 * HOUR, KEY, NOW);
    expect(h.trend?.size?.slopeScrapPerDay).toBeCloseTo(-24, 9);
    expect(h.trend?.size).toMatchObject({ changeScrap: -50, spreadScrap: 0, points: 6 });
  });

  it('reads a level line as 0, with the spread about it', () => {
    // Two values alternate, so the trend exists; the median pairwise slope is 0, the line sits at 125 and every point
    // is 5 off it.
    const h = holdingExitHistory(runs([120, 130, 120, 130, 120, 130], 10 * HOUR, NOW - 60 * HOUR), NOW - 60 * HOUR, KEY, NOW);
    expect(h.trend?.direction).toBe('mixed');
    expect(Object.is(h.trend?.size?.changeScrap, 0)).toBe(true);
    expect(Object.is(h.trend?.size?.slopeScrapPerDay, 0)).toBe(true);
    expect(h.trend?.size).toMatchObject({ spreadScrap: 5, points: 6 });
  });

  it('needs 5 points: four 16 h runs have a trend and no size key', () => {
    const h = holdingExitHistory(runs([150, 140, 130, 120], 16 * HOUR, NOW - 64 * HOUR), NOW - 64 * HOUR, KEY, NOW);
    expect(h.trend).not.toBeNull();
    expect(h.trend && 'size' in h.trend).toBe(false);
  });

  it('needs the points to span 48 h: a long first run then four short ones give no size', () => {
    // Observed 52 h (a trend), but the midpoints span 30.5 h.
    const start = NOW - 52 * HOUR;
    const marks = [mark(start, start + 40 * HOUR, 160), ...runs([150, 140, 130, 120], 3 * HOUR, start + 40 * HOUR)];
    const h = holdingExitHistory(marks, start, KEY, NOW);
    expect(h.observedMs).toBeGreaterThanOrEqual(HOLDING_TREND_MIN_OBSERVED_MS);
    expect(h.trend).not.toBeNull();
    expect(h.trend && 'size' in h.trend).toBe(false);
  });

  it("uses only the stretches that observed the newest one's sources", () => {
    // Ten 10 h slots: backpack.tf-only runs in slots 0, 2, 4, 6, 8, 9; scrap.tf-only runs (no order, a pays price) between.
    const start = NOW - 100 * HOUR;
    const slot = (i: number) => [start + i * 10 * HOUR, start + (i + 1) * 10 * HOUR] as const;
    const bp = [0, 2, 4, 6, 8, 9].map((s, i) => mark(...slot(s), 160 - 10 * i));
    const stf = [1, 3, 5, 7].map((s) => mark(...slot(s), null, { scraptfPaysKeys: 0, scraptfPaysScrap: 300 }));
    const mixed = holdingExitHistory([...bp, ...stf], start, KEY, NOW);
    const alone = holdingExitHistory(bp, start, KEY, NOW);
    expect(mixed.trend?.size?.points).toBe(6);
    expect(mixed.trend?.size).toEqual(alone.trend?.size);
    // Newest scrap.tf-only: its 4 stretches (slots 3, 5, 7, 9) are too few, whatever the 5 backpack.tf ones say.
    const stfNewest = holdingExitHistory([...bp.slice(0, 5), ...stf.slice(1), mark(...slot(9), null, { scraptfPaysKeys: 0, scraptfPaysScrap: 290 })], start, KEY, NOW);
    expect(stfNewest.trend).not.toBeNull();
    expect(stfNewest.trend && 'size' in stfNewest.trend).toBe(false);
    // With the fifth (slot 1) it has its own size, over the scrap.tf-only stretches alone.
    const stfFive = holdingExitHistory([...bp.slice(0, 5), ...stf, mark(...slot(9), null, { scraptfPaysKeys: 0, scraptfPaysScrap: 290 })], start, KEY, NOW);
    expect(stfFive.trend?.size).toMatchObject({ points: 5, fromAt: slot(1)[0] + 5 * HOUR, toAt: slot(9)[0] + 5 * HOUR });
  });

  it('uses at most the newest 60 stretches', () => {
    // 80 contiguous 1 h runs, each 1 scrap lower: the newest 60 start at the 21st.
    const start = NOW - 80 * HOUR;
    const values = Array.from({ length: 80 }, (_, i) => 300 - i);
    const h = holdingExitHistory(runs(values, HOUR, start), start, KEY, NOW);
    const mid = (i: number) => start + i * HOUR + HOUR / 2;
    expect(h.trend?.size).toMatchObject({ points: 60, fromAt: mid(20), toAt: mid(79), changeScrap: -59, spreadScrap: 0 });
    expect(h.trend?.size?.slopeScrapPerDay).toBeCloseTo(-24, 9);
  });
});

describe('holdingAdvice: the trend-size reason (0.9, #17)', () => {
  const history = (): HoldingExitHistory => holdingExitHistory(runs(SIX, 10 * HOUR, NOW - 60 * HOUR), NOW - 60 * HOUR, KEY, NOW);

  it('says the size after falling and before held-vs-typical', () => {
    const r = row(105, { typicalHold: { medianMs: 2 * DAY, count: 6, scope: 'all', stillHeld: 3 } });
    const a = holdingAdvice(r, history(), P, KEY, NOW);
    const c = codes(a.reasons);
    expect(c).toContain('falling');
    expect(c.indexOf('trend-size')).toBe(c.indexOf('falling') + 1);
    expect(c.indexOf('held-vs-typical')).toBe(c.indexOf('trend-size') + 1);
    expect(a.reasons.find((x) => x.code === 'trend-size')).toEqual({
      code: 'trend-size',
      changeScrap: -50,
      spreadScrap: 0,
      points: 6,
      fromAt: NOW - 55 * HOUR,
      toAt: NOW - 5 * HOUR,
    });
  });

  it('never changes the verdict: the same history without its size gives the same kind and the other reasons', () => {
    const h = history();
    expect(h.trend?.size).toBeDefined();
    const { size: _size, ...trendWithout } = h.trend!;
    const without: HoldingExitHistory = { ...h, trend: trendWithout };
    for (const revenue of [160, 130, 112, 105, 90]) {
      const r = row(revenue);
      const a = holdingAdvice(r, h, P, KEY, NOW);
      const b = holdingAdvice(r, without, P, KEY, NOW);
      expect(a.kind).toBe(b.kind);
      expect(a.refreshFirst).toBe(b.refreshFirst);
      expect(a.reasons.filter((x) => x.code !== 'trend-size')).toEqual(b.reasons);
      expect(codes(b.reasons)).not.toContain('trend-size');
    }
  });
});
