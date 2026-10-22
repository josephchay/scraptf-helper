// 0.8 (H7): the drawer's "Your holding & trades" helpers. The exit chart's series (a step per run, 'no-exit' nulls,
// 'unwatched' gaps, nothing interpolated), its geometry (asserted only on the fields this package computes: cycles
// changes StepGeom in the same wave), the readouts and labels, the lot, trade and typical-hold lines and the
// section titles. Pure; no network.

import { describe, expect, it } from 'vitest';
import { HOLDING_MARK_GAP_MS, markExitScrap } from '../../src/shared/holdingAdvice';
import type { HoldingDetail, HoldingMark, JournalClosedTrade, JournalLot, TypicalHold } from '../../src/shared/types';
import { fmtSaveTime } from '../../src/renderer/changesModel';
import { fmtDateTime, fmtMoney, fmtSignedMoney } from '../../src/renderer/format';
import {
  closedTradeLines,
  holdingChartGeom,
  holdingChartLabel,
  holdingChartReadout,
  holdingChartSeries,
  holdingLotLines,
  holdingSectionTitle,
  recordedSinceText,
  typicalHoldLine,
} from '../../src/renderer/holdingDetailModel';
import { typicalHoldText } from '../../src/renderer/holdingsModel';

// Local noon, so day names do not depend on the machine's time zone.
const T0 = new Date(2026, 9, 22, 12, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY = 568;

let nextId = 1;
function mark(fromAt: number, toAt: number, revMetalScrap: number | null, over: Partial<HoldingMark> = {}): HoldingMark {
  return {
    id: nextId++,
    baseSku: '378;6',
    fromAt,
    toAt,
    revKeys: revMetalScrap === null ? null : 0,
    revMetalScrap,
    revIsBot: revMetalScrap === null ? null : true,
    revVerified: revMetalScrap === null ? null : true,
    bestKeys: null,
    bestMetalScrap: null,
    nextKeys: null,
    nextMetalScrap: null,
    buyerCount: 3,
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

function detail(over: Partial<HoldingDetail> = {}): HoldingDetail {
  return { sku: '378;6', baseSku: '378;6', row: null, lots: [], closed: [], typicalHold: null, marks: [], truncated: false, history: null, keyScrap: KEY, generatedAt: T0, ...over };
}

describe('holdingChartSeries', () => {
  it('gives each run a step at its start and end, oldest first', () => {
    const a = mark(T0 - 5 * HOUR, T0 - 4 * HOUR, 100);
    const b = mark(T0 - 4 * HOUR + 30 * MIN, T0 - 2 * HOUR, 110);
    const s = holdingChartSeries([b, a], KEY);
    expect(s.map((p) => [p.at, p.value, p.kind])).toEqual([
      [a.fromAt, 100, 'run'],
      [a.toAt, 100, 'run'],
      [b.fromAt, 110, 'run'],
      [b.toAt, 110, 'run'],
    ]);
    expect(s[0]!.mark).toBe(a);
    expect(s[3]!.mark).toBe(b);
  });

  it('a run seen once gives one point; a run with no exit gives nulls (no-exit)', () => {
    const once = mark(T0 - HOUR, T0 - HOUR, 100);
    const none = mark(T0 - 50 * MIN, T0 - 20 * MIN, null);
    const s = holdingChartSeries([once, none], KEY);
    expect(s.map((p) => [p.value, p.kind])).toEqual([
      [100, 'run'],
      [null, 'no-exit'],
      [null, 'no-exit'],
    ]);
  });

  it('a silence longer than HOLDING_MARK_GAP_MS adds an unwatched null right after the run; a shorter one does not', () => {
    const a = mark(T0 - 20 * HOUR, T0 - 18 * HOUR, 100);
    const b = mark(T0 - 18 * HOUR + HOLDING_MARK_GAP_MS, T0 - 16 * HOUR, 100);
    const c = mark(T0 - 6 * HOUR, T0 - 5 * HOUR, 90);
    const s = holdingChartSeries([a, b, c], KEY);
    const gaps = s.filter((p) => p.kind === 'unwatched');
    expect(gaps).toEqual([{ at: b.toAt + 1, value: null, kind: 'unwatched', mark: null }]);
    // Never interpolated: every valued point is one of a run's own exits.
    for (const p of s) if (p.value !== null) expect(p.value).toBe(markExitScrap(p.mark!, KEY));
  });

  it('values raw keys and metal at the key price given, never filling a key price it does not have', () => {
    const keyed = mark(T0 - 2 * HOUR, T0 - HOUR, 10, { revKeys: 1, keyScrap: null });
    expect(holdingChartSeries([keyed], KEY)[0]!.value).toBe(KEY + 10);
    expect(holdingChartSeries([keyed], null)[0]!.value).toBeNull();
  });

  it('is empty for no runs', () => {
    expect(holdingChartSeries([], KEY)).toEqual([]);
  });
});

describe('holdingChartGeom', () => {
  it('steps through the runs, breaks at a gap, and ticks the gaps on the baseline', () => {
    const a = mark(T0 - 30 * HOUR, T0 - 28 * HOUR, 100);
    const b = mark(T0 - 10 * HOUR, T0 - 8 * HOUR, 120);
    const series = holdingChartSeries([a, b], KEY);
    const g = holdingChartGeom(series)!;
    expect(g).toMatchObject({ lo: 100, hi: 120, t0: a.fromAt, t1: b.toAt });
    expect(g.xs).toHaveLength(series.length);
    expect(g.dots.map((d) => d.i)).toEqual([0, 1, 3, 4]);
    expect(g.gaps.map((x) => x.i)).toEqual([2]);
    // Two pen-downs: the line is broken across the unwatched stretch, not drawn through it.
    expect(g.path.match(/M/g)).toHaveLength(2);
    expect(Object.keys(g)).not.toContain('downs');
  });

  it('is null when no run had an exit', () => {
    expect(holdingChartGeom(holdingChartSeries([mark(T0 - HOUR, T0, null)], KEY))).toBeNull();
    expect(holdingChartGeom([])).toBeNull();
  });
});

describe('readouts and labels', () => {
  it('reads a run, a run with no exit and an unwatched stretch', () => {
    const a = mark(T0 - 4 * HOUR, T0 - 3 * HOUR, 100, { buyerCount: 3 });
    const one = mark(T0 - 2 * HOUR, T0 - HOUR, 100, { buyerCount: 1 });
    expect(holdingChartReadout({ at: a.fromAt, value: 100, kind: 'run', mark: a }, KEY)).toBe(`${fmtSaveTime(a.fromAt)} · ${fmtMoney(100, KEY)} · 3 buyers`);
    expect(holdingChartReadout({ at: one.fromAt, value: 100, kind: 'run', mark: one }, KEY)).toBe(`${fmtSaveTime(one.fromAt)} · ${fmtMoney(100, KEY)} · 1 buyer`);
    expect(holdingChartReadout({ at: a.fromAt, value: null, kind: 'no-exit', mark: a }, KEY)).toBe(`${fmtSaveTime(a.fromAt)} · no buyer or scrap.tf price`);
    expect(holdingChartReadout({ at: a.toAt + 1, value: null, kind: 'unwatched', mark: null }, KEY)).toBe(
      `${fmtSaveTime(a.toAt + 1)} · not recorded (Flip Desk was closed or the live feed was off)`,
    );
    expect(holdingChartReadout(undefined, KEY)).toBe('');
  });

  it('labels the chart with its runs, span and range', () => {
    const a = mark(T0 - 30 * HOUR, T0 - 28 * HOUR, 100);
    const b = mark(T0 - 10 * HOUR, T0 - 8 * HOUR, 120);
    const g = holdingChartGeom(holdingChartSeries([a, b], KEY))!;
    expect(holdingChartLabel(g, 2, KEY)).toBe(
      `Best exit in 2 recorded runs from ${fmtDateTime(a.fromAt)} to ${fmtDateTime(b.toAt)}, between ${fmtMoney(100, KEY)} and ${fmtMoney(120, KEY)}; gaps where nothing was recorded`,
    );
    const flat = holdingChartGeom(holdingChartSeries([a], KEY))!;
    expect(holdingChartLabel(flat, 1, KEY)).toMatch(/^Best exit in 1 recorded run from .+, at /);
  });

  it('says since when exits were recorded, and that gaps are never filled', () => {
    const marks = [mark(new Date(2026, 9, 20, 9, 0).getTime(), new Date(2026, 9, 20, 11, 0).getTime(), 100), mark(T0 - 2 * HOUR, T0, 100)];
    expect(recordedSinceText({ marks, truncated: false })).toBe('Exit prices recorded since Oct 20 (2 runs). Gaps: Flip Desk was closed or the live feed was off; nothing is filled in.');
    expect(recordedSinceText({ marks, truncated: true })).toContain('(the newest 2 runs)');
    expect(recordedSinceText({ marks: [marks[0]!], truncated: false })).toContain('(1 run)');
    expect(recordedSinceText({ marks: [], truncated: false })).toBeNull();
  });
});

describe('lots, trades and the typical hold', () => {
  it('words each open lot with its date, price, key price then and hold', () => {
    const lots: JournalLot[] = [
      { id: 1, ts: new Date(2026, 9, 18, 12, 0).getTime(), costScrap: KEY + 18, keys: 1, scrap: 18, keyPriceScrap: KEY },
      { id: 2, ts: T0 - 2 * HOUR, costScrap: 40, keys: 0, scrap: 40, keyPriceScrap: KEY },
    ];
    expect(holdingLotLines(lots, KEY, T0)).toEqual(['Bought Oct 18 · 1 key 2.00 ref · key 63.11 ref then · held 4 d', 'Bought Oct 22 · 4.44 ref · held 2 h']);
    expect(holdingLotLines([], KEY, T0)).toEqual([]);
  });

  it('words each closed trade, a write-off too, toned by its sign', () => {
    const base: JournalClosedTrade = {
      sellId: 2,
      buyId: 1,
      kind: 'sell',
      sku: '378;6',
      name: 'Team Captain',
      boughtAt: new Date(2026, 9, 13, 12, 0).getTime(),
      soldAt: new Date(2026, 9, 15, 12, 0).getTime(),
      heldMs: 2 * DAY,
      buyVenue: 'scrap.tf',
      sellVenue: 'bp.tf',
      costScrap: 100,
      proceedsScrap: 104,
      feesScrap: null,
      feesKnown: false,
      profitScrap: 4,
      keyPriceScrap: KEY,
    };
    const off: JournalClosedTrade = { ...base, sellId: 3, kind: 'writeoff', sellVenue: 'Written off', heldMs: 9 * DAY, proceedsScrap: 0, profitScrap: -12 };
    const even: JournalClosedTrade = { ...base, sellId: 4, profitScrap: 0, sellVenue: 'scrap.tf' };
    expect(closedTradeLines([base, off, even], KEY)).toEqual([
      // The venue as reports group it (venueLabel: 'bp.tf' is backpack.tf); stored text is never rewritten.
      { text: `Sold Oct 15 on backpack.tf after 2 d · ${fmtSignedMoney(4, KEY)}`, tone: 'good' },
      { text: `Written off Oct 15 after 9 d · ${fmtSignedMoney(-12, KEY)}`, tone: 'bad' },
      { text: `Sold Oct 15 on scrap.tf after 2 d · ${fmtSignedMoney(0, KEY)}`, tone: null },
    ]);
    // Review fix: a sale logged in its buy's own minute holds 0, which fmtAge worded as "after now".
    expect(closedTradeLines([{ ...base, heldMs: 0 }], KEY)[0]!.text).toBe(`Sold Oct 15 on backpack.tf after < 1 min · ${fmtSignedMoney(4, KEY)}`);
    expect(closedTradeLines([{ ...off, heldMs: 30_000 }], KEY)[0]!.text).toBe(`Written off Oct 15 after < 1 min · ${fmtSignedMoney(-12, KEY)}`);
  });

  it('words a same-minute typical hold as under a minute in the drawer line too', () => {
    expect(typicalHoldLine({ medianMs: 0, count: 3, scope: 'item', stillHeld: 0 })).toBe('Your sales of this item came a median < 1 min after the buy (3 sales).');
  });

  it("is journal's typicalHoldText (D3), or null", () => {
    const t: TypicalHold = { medianMs: 3 * DAY, count: 4, scope: 'item', stillHeld: 1 };
    expect(typicalHoldLine(t)).toBe(typicalHoldText(t));
    expect(typicalHoldLine(null)).toBeNull();
  });
});

describe('holdingSectionTitle', () => {
  it('names what the drawer shows, or nothing', () => {
    const lot: JournalLot = { id: 1, ts: T0 - DAY, costScrap: 100, keys: 0, scrap: 100, keyPriceScrap: KEY };
    const closed = { sellId: 2 } as JournalClosedTrade;
    const run = mark(T0 - HOUR, T0, 100);
    expect(holdingSectionTitle(detail({ lots: [lot] }))).toBe('Your holding & trades');
    expect(holdingSectionTitle(detail({ lots: [lot], closed: [closed] }))).toBe('Your holding & trades');
    expect(holdingSectionTitle(detail({ closed: [closed], marks: [run] }))).toBe('Your trades');
    expect(holdingSectionTitle(detail({ marks: [run] }))).toBe('Recorded exit prices');
    expect(holdingSectionTitle(detail())).toBeNull();
    expect(holdingSectionTitle(null)).toBeNull();
    expect(holdingSectionTitle(undefined)).toBeNull();
  });
});
