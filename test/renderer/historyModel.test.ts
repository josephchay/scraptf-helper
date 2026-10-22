// F20 U1: the item drawer's "scrap.tf history" helpers (historyModel.ts): "Listed since 2 d 4 h (since
// your save on Oct 14 09:12)", stock now, the 1 h / 24 h / 7 d / since-listed chips, the step chart's
// geometry with gaps where a save did not list the item on sale, the hover readout, the change lines and
// the empty state; then the same over the browser mock's real history. Pure; nothing here touches the
// network or scrap.tf.

import { afterEach, describe, expect, it } from 'vitest';
import { fmtSaveTime } from '../../src/renderer/changesModel';
import { fmtAgo, fmtDateTime, fmtMoney, fmtSignedMoney } from '../../src/renderer/format';
import {
  HISTORY_EVENTS_SHOWN,
  HISTORY_LAST_SEEN_STALE_MS,
  STEP_BOX,
  historyBankPath,
  historyChartLabel,
  historyChips,
  historyEventGroups,
  historyEventLines,
  historyListedLine,
  historyNote,
  historyNowText,
  historyReadout,
  historyRunLines,
  historySeries,
  historyTimingView,
  nearestStep,
  priceChangeText,
  stepChartGeom,
  type StepPoint,
} from '../../src/renderer/historyModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { TIMING_ESTIMATE_NOTE } from '../../src/renderer/timingModel';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { HISTORY_LAST_SEEN_STALE_MS as SHARED_STALE_MS, scraptfAgoText } from '../../src/shared/scraptfHistory';
import type { ScraptfBuyTiming, ScraptfChangeEvent, ScraptfHistoryPoint, ScraptfItemCycles, ScraptfItemHistory, ScraptfListingRun, ScraptfPriceChange } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const K = 568;

function point(at: number, costScrap: number | null, stock: number | null = 3): ScraptfHistoryPoint {
  return { at, bank: 'hats', costKeys: 0, costScrapRaw: costScrap ?? 0, costScrap: costScrap ?? 0, stock: costScrap === null ? (stock === 3 ? null : stock) : stock, listed: costScrap !== null };
}

function change(fromScrap: number, toScrap: number, since: number): ScraptfPriceChange {
  return { fromScrap, toScrap, deltaScrap: toScrap - fromScrap, pct: fromScrap > 0 ? (toScrap - fromScrap) / fromScrap : null, since };
}

function history(over: Partial<ScraptfItemHistory> = {}): ScraptfItemHistory {
  return {
    sku: '378;6',
    specialKey: '',
    name: 'Team Captain',
    bank: 'hats',
    points: [point(NOW - 3 * DAY, 13), point(NOW - 2 * DAY, null), point(NOW - 52 * HOUR + HOUR, 12), point(NOW - 2 * HOUR, 11)],
    firstSeenAt: NOW - 3 * DAY,
    listedSince: NOW - 51 * HOUR,
    lastSeenAt: NOW - 2 * HOUR,
    current: { costScrap: 11, stock: 3, bank: 'hats' },
    change: { h1: change(11, 11, NOW - 2 * HOUR), h24: change(12, 11, NOW - 51 * HOUR), d7: null, listed: change(12, 11, NOW - 51 * HOUR) },
    events: [],
    keyPrice: null,
    generatedAt: NOW,
    ...over,
  };
}

function ev(over: Partial<ScraptfChangeEvent> = {}): ScraptfChangeEvent {
  return {
    id: 1,
    at: NOW - 2 * HOUR,
    bank: 'hats',
    page: '/buy/hats',
    sku: '378;6',
    specialKey: '',
    name: 'Team Captain',
    kind: 'cheaper',
    fromKeys: 0,
    fromScrap: 12,
    toKeys: 0,
    toScrap: 11,
    fromStock: 5,
    toStock: 3,
    batchId: 1,
    key: '378;6|',
    hasExtras: false,
    fromValueScrap: 12,
    toValueScrap: 11,
    deltaScrap: -1,
    pct: -1 / 12,
    revenueScrap: 18,
    maxCostScrap: 13,
    flip: true,
    ...over,
  };
}

describe('listed since and stock now', () => {
  it('"Listed since 2 d 3 h (since your save on …)" while on sale, from SCRAPTF_BANKS', () => {
    const l = historyListedLine(history(), NOW)!;
    expect(l.text).toBe(`Listed since 2 d 3 h (since your save on ${fmtSaveTime(NOW - 51 * HOUR)})`);
    expect(l.tone).toBe('info');
    expect(l.title).toContain(`On sale on scrap.tf/buy/hats in every one of your saves of its page since ${fmtDateTime(NOW - 51 * HOUR)}.`);
    expect(l.title).toContain(`Your saves kept first listed it on sale ${fmtDateTime(NOW - 3 * DAY)}.`);
    expect(l.title).toContain('What happened between two saves is unknown.');
    expect(historyBankPath(history({ bank: 'list' }))).toBe('scrap.tf/items');
    expect(historyBankPath(history({ bank: null }))).toBeNull();
  });

  it('a run whose newest sighting is over 48 h old reads as an old sighting, its span ending there (DM-5)', () => {
    const old = historyListedLine(history({ listedSince: NOW - 10 * DAY, lastSeenAt: NOW - 4 * DAY }), NOW)!;
    expect(old.text).toBe(`Last on sale 4 d ago (your save on ${fmtSaveTime(NOW - 4 * DAY)}), after 6 d 0 h listed`);
    expect(old.tone).toBe('muted');
    expect(old.title).toContain('no newer save of it shows it, so it may be gone.');
    // A page saved once, 60 days ago: one save, so no "after 0 m listed".
    const once = historyListedLine(history({ listedSince: NOW - 60 * DAY, lastSeenAt: NOW - 60 * DAY }), NOW)!;
    expect(once.text).toBe(`Last on sale ${fmtAgo(NOW - 60 * DAY, NOW)} (your save on ${fmtSaveTime(NOW - 60 * DAY)})`);
    expect(once.title).toContain(`On sale on scrap.tf/buy/hats in your save of ${fmtDateTime(NOW - 60 * DAY)}; no newer save of it shows it`);
    // A fresh sighting reads as before.
    expect(historyListedLine(history({ listedSince: NOW - 51 * HOUR, lastSeenAt: NOW - HOUR }), NOW)!.text).toMatch(/^Listed since 2 d 3 h/);
  });

  it('when it is not on sale now: when it last was; nothing without a bank', () => {
    const off = historyListedLine(history({ listedSince: null, current: null }), NOW)!;
    expect(off.text).toBe(`Not on sale in your newest save (last on sale in your save on ${fmtSaveTime(NOW - 2 * HOUR)})`);
    expect(off.tone).toBe('muted');
    expect(historyListedLine(history({ listedSince: null, lastSeenAt: null, firstSeenAt: null, current: null }), NOW)!.text).toBe('Listed in your saves, but never on sale');
    expect(historyListedLine(history({ bank: null }), NOW)).toBeNull();
  });

  it('stock now, or what the newest save said', () => {
    expect(historyNowText(history(), K)!.text).toBe('Now 1.22 ref · 3 in stock');
    expect(historyNowText(history({ current: { costScrap: 11, stock: null, bank: 'hats' } }), K)!.text).toBe('Now 1.22 ref · stock not shown');
    expect(historyNowText(history({ current: null, points: [point(NOW - DAY, 12), point(NOW - HOUR, null, 0)] }), K)!.text).toBe('Sold out in your newest save');
    expect(historyNowText(history({ current: null, points: [point(NOW - DAY, 12), point(NOW - HOUR, null)] }), K)!.text).toBe('Not in your newest save');
    expect(historyNowText(history({ bank: null }), K)).toBeNull();
  });
});

describe('price changes and stock moves apart (DM-6)', () => {
  it('splits the events by kind, each newest first as sent', () => {
    const e = (id: number, kind: ScraptfChangeEvent['kind']) => ({ id, kind }) as ScraptfChangeEvent;
    const g = historyEventGroups([e(9, 'stock'), e(8, 'cheaper'), e(7, 'stock'), e(6, 'gone'), e(5, 'new'), e(4, 'restocked'), e(3, 'pricier')]);
    expect(g.price.map((x) => x.id)).toEqual([8, 6, 5, 4, 3]);
    expect(g.stock.map((x) => x.id)).toEqual([9, 7]);
    expect(historyEventGroups([])).toEqual({ price: [], stock: [] });
    expect(historyEventGroups(null as never)).toEqual({ price: [], stock: [] });
  });
});

describe('the change chips', () => {
  it('1 h / 24 h / 7 d / Since listed: arrow, amount and percentage, toned; a dash says why', () => {
    const chips = historyChips(history(), K);
    expect(chips.map((c) => [c.id, c.label, c.text, c.tone])).toEqual([
      // The newest save is 2 h old: "1 h" would compare it with itself.
      ['h1', '1 h', '—', 'muted'],
      ['h24', '24 h', '↓ 0.11 ref (−8 %)', 'good'],
      ['d7', '7 d', '—', 'muted'],
      ['listed', 'Since listed', '↓ 0.11 ref (−8 %)', 'good'],
    ]);
    expect(chips[0]!.title).toBe(`Your newest save of it (${fmtDateTime(NOW - 2 * HOUR)}) is already at least an hour old: save the page again to compare.`);
    // A save an hour or more before a newer one: the same price reads "no change".
    const same = historyChips(history({ lastSeenAt: NOW - 10 * MIN, change: { h1: change(11, 11, NOW - 2 * HOUR), h24: null, d7: null, listed: null } }), K);
    expect(same[0]).toMatchObject({ text: 'no change', tone: 'muted' });
    expect(chips[1]!.title).toBe(`In your save of ${fmtDateTime(NOW - 51 * HOUR)}, at least a day ago: 1.33 ref. Now: 1.22 ref (1.33 → 1.22 ref, both at today's key price).`);
    expect(chips[2]!.title).toBe('None of your saves from at least a week ago listed it on sale (or none is that old).');
    expect(chips[3]!.title).toMatch(/^When your saves began listing it in this run \(/);
    // A run that began in the newest save: Since listed would compare that save with itself.
    const fresh = historyChips(history({ listedSince: NOW - 2 * HOUR, change: { h1: null, h24: null, d7: null, listed: change(11, 11, NOW - 2 * HOUR) } }), K);
    expect(fresh[3]).toMatchObject({ text: '—', tone: 'muted', title: `On sale only since your newest save (${fmtDateTime(NOW - 2 * HOUR)}): save the page again later to compare.` });
    const off = historyChips(history({ current: null, change: { h1: null, h24: null, d7: null, listed: null } }), K);
    expect(off.every((c) => c.text === '—' && c.title === 'It is not on sale in your newest save, so there is nothing to compare.')).toBe(true);
    expect(priceChangeText(change(20, 21, NOW), K)).toEqual({ text: '↑ 0.11 ref (+5 %)', tone: 'bad' });
    expect(priceChangeText(change(0, 9, NOW), K)).toEqual({ text: '↑ 1.00 ref', tone: 'bad' });
  });
});

describe('the step chart', () => {
  const { w, h, padX, padY } = STEP_BOX;

  it('reads only listed saves as prices, oldest first (a cost of 0 where it was not listed is no price)', () => {
    const s = historySeries([point(NOW - HOUR, 11), point(NOW - DAY, null), point(NOW - 2 * DAY, 13)]);
    expect(s).toEqual([
      { at: NOW - 2 * DAY, value: 13 },
      { at: NOW - DAY, value: null },
      { at: NOW - HOUR, value: 11 },
    ]);
  });

  it('steps from save to save, holds each price until the next save, and breaks at a gap', () => {
    const pts: StepPoint[] = [
      { at: 0, value: 20 },
      { at: 100, value: 10 },
      { at: 200, value: null },
      { at: 300, value: 10 },
      { at: 400, value: 15 },
    ];
    const g = stepChartGeom(pts)!;
    expect(g.lo).toBe(10);
    expect(g.hi).toBe(20);
    expect(g.t0).toBe(0);
    expect(g.t1).toBe(400);
    const x = (t: number) => padX + (t / 400) * (w - 2 * padX);
    const y = (v: number) => padY + (1 - (v - 10) / 10) * (h - 2 * padY);
    expect(g.xs).toEqual([0, 100, 200, 300, 400].map(x));
    const r = (v: number) => (Math.round(v * 10) / 10).toString();
    expect(g.path).toBe(`M${r(x(0))},${r(y(20))}H${r(x(100))}V${r(y(10))}M${r(x(300))},${r(y(10))}H${r(x(400))}V${r(y(15))}`);
    expect(g.dots.map((d) => d.i)).toEqual([0, 1, 3, 4]);
    expect(g.gaps).toEqual([{ x: x(200), i: 2 }]);
    // Highest price at the top, lowest at the bottom of the padded box.
    expect(g.dots[0]!.y).toBeCloseTo(padY);
    expect(g.dots[1]!.y).toBeCloseTo(h - padY);
  });

  it('a flat price sits mid-chart; one save is one dot in the middle; nothing listed draws nothing', () => {
    const flat = stepChartGeom([
      { at: 0, value: 12 },
      { at: 10, value: 12 },
    ])!;
    expect(flat.dots[0]!.y).toBeCloseTo(h / 2);
    expect(flat.lo).toBe(12);
    expect(flat.hi).toBe(12);
    const one = stepChartGeom([{ at: 5, value: 12 }])!;
    expect(one.dots).toEqual([{ x: w / 2, y: h / 2, i: 0 }]);
    expect(one.path).toBe(`M${w / 2},${h / 2}`);
    expect(stepChartGeom([{ at: 5, value: null }])).toBeNull();
    expect(stepChartGeom([])).toBeNull();
    // Unsorted input and a bad time are handled.
    const messy = stepChartGeom([
      { at: 20, value: 1 },
      { at: Number.NaN, value: 5 },
      { at: 10, value: 2 },
    ])!;
    expect(messy.t0).toBe(10);
    expect(messy.dots.map((d) => d.i)).toEqual([0, 1]);
  });

  it('hovers the nearest save and reads it out', () => {
    expect(nearestStep([10, 50, 90], 60)).toBe(1);
    expect(nearestStep([10, 50, 90], 1000)).toBe(2);
    expect(nearestStep([], 5)).toBeNull();
    expect(historyReadout(point(NOW - HOUR, 11), K)).toBe(`${fmtSaveTime(NOW - HOUR)} · 1.22 ref · 3 in stock`);
    expect(historyReadout(point(NOW - HOUR, 11, null), K)).toBe(`${fmtSaveTime(NOW - HOUR)} · 1.22 ref`);
    expect(historyReadout(point(NOW - HOUR, null, 0), K)).toBe(`${fmtSaveTime(NOW - HOUR)} · sold out`);
    expect(historyReadout(point(NOW - HOUR, null), K)).toBe(`${fmtSaveTime(NOW - HOUR)} · not on sale`);
    expect(historyReadout(undefined, K)).toBe('');
    const g = stepChartGeom(historySeries(history().points))!;
    expect(historyChartLabel(g, 4, K)).toBe(
      `scrap.tf price in 4 saves from ${fmtDateTime(NOW - 3 * DAY)} to ${fmtDateTime(NOW - 2 * HOUR)}, between 1.22 ref and 1.44 ref; gaps where a save did not list it on sale`,
    );
  });
});

describe('change lines and the empty state', () => {
  it('the copy\'s change events, newest first, at most five unless asked', () => {
    const events = Array.from({ length: 8 }, (_, i) => ev({ id: i + 1, at: NOW - (8 - i) * HOUR }));
    const lines = historyEventLines(events, K, NOW);
    expect(lines).toHaveLength(HISTORY_EVENTS_SHOWN);
    expect(lines.map((l) => l.id)).toEqual([8, 7, 6, 5, 4]);
    expect(lines[0]).toMatchObject({ when: fmtSaveTime(NOW - HOUR), kind: 'Cheaper', tone: 'good', text: '1.33 → 1.22 ref (−8 %), stock 5 → 3', priceTone: 'good' });
    expect(lines[0]!.whenTitle).toContain('Your save of scrap.tf/buy/hats');
    expect(historyEventLines(events, K, NOW, events.length)).toHaveLength(8);
    expect(historyEventLines([ev({ kind: 'gone', toValueScrap: null, deltaScrap: null, pct: null, toStock: 0, fromStock: null })], K, NOW)[0]!.text).toBe('was 1.33 ref, sold out');
    expect(historyEventLines([ev({ kind: 'new', fromValueScrap: null, deltaScrap: null, pct: null, fromStock: null })], K, NOW)[0]).toMatchObject({ kind: 'New', text: '1.22 ref, 3 in stock' });
  });

  it('a change on another bank than the chart\'s (the /items list, say) names that bank', () => {
    const lines = historyEventLines([ev({ id: 2, bank: 'list' }), ev({ id: 1 })], K, NOW, 5, 'hats');
    expect(lines.map((l) => l.bank)).toEqual(['All items', null]);
    expect(lines[0]!.whenTitle).toContain('Your save of scrap.tf/items');
    // Without a chart bank nothing is labelled.
    expect(historyEventLines([ev({ bank: 'list' })], K, NOW).map((l) => l.bank)).toEqual([null]);
  });

  it('never seen in a save: what to do; one save: save again later', () => {
    expect(historyNote(history({ bank: null, points: [] }))!.title).toBe('Not in your saved scrap.tf pages yet');
    expect(historyNote(history({ bank: null, points: [] }))!.body).toContain('Flip Desk never loads scrap.tf on its own.');
    expect(historyNote(undefined)!.title).toBe('Not in your saved scrap.tf pages yet');
    expect(historyNote(history({ points: [point(NOW, 12)] }))!.title).toBe('One save so far');
    expect(historyNote(history())).toBeNull();
  });
});

describe('over the browser mock', () => {
  let bridge: MockBridge | null = null;
  afterEach(() => {
    bridge?.dispose();
    bridge = null;
  });

  it('every listed item of a saved bank has a chart, a listed line and chips; a never-saved one the empty state', async () => {
    const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    const stock = await b.rpc('scraptf.bankStock', { bank: 'hats', limit: 40 });
    expect(stock.rows.length).toBeGreaterThan(0);
    let withChanges = 0;
    for (const r of stock.rows.filter((x) => !x.hasExtras).slice(0, 15)) {
      const h = await b.rpc('scraptf.itemHistory', { sku: r.sku });
      expect(h.bank).not.toBeNull();
      const path = historyBankPath(h)!;
      expect(SCRAPTF_BANKS.map((x) => x.url.replace(/^https:\/\//, ''))).toContain(path);
      const g = stepChartGeom(historySeries(h.points));
      expect(g).not.toBeNull();
      expect(g!.dots.length + g!.gaps.length).toBe(h.points.length);
      expect(g!.path.startsWith('M')).toBe(true);
      expect(historyListedLine(h, T0)).not.toBeNull();
      expect(historyChips(h, K)).toHaveLength(4);
      if (h.events.length) withChanges++;
      for (const l of historyEventLines(h.events, K, T0, h.events.length)) expect(l.text).not.toMatch(/https?:/);
    }
    expect(withChanges).toBeGreaterThan(0);
    const never = await b.rpc('scraptf.itemHistory', { sku: '5021;6' });
    if (never.bank === null) expect(historyNote(never)!.title).toBe('Not in your saved scrap.tf pages yet');
  });
});

// ---------------------------------------------------------------------------
// 0.8 (T5, LC-3): the Cycles block: buy timing, listing runs and the chart's down markers
// ---------------------------------------------------------------------------

/** A whole verdict (scraptfBuyTimingOf's shape): 8 of 41 prices (6 items) at risk; within 1 d 35 % dropped. */
function buyTiming(over: Partial<ScraptfBuyTiming> = {}): ScraptfBuyTiming {
  return {
    verdict: 'wait',
    why: 'drop-likely',
    bank: 'hats',
    key: '378;6|',
    costScrap: 13,
    revenueScrap: 18,
    maxCostScrap: 15,
    priceSince: NOW - 2 * DAY,
    pricePrevAt: NOW - 3 * DAY,
    lastSeenAt: NOW - 5 * HOUR,
    ageMs: 2 * DAY - 5 * HOUR,
    horizonMs: DAY,
    pDrop: 0.35,
    pGone: 0.25,
    pRise: 0.15,
    pNone: 0.25,
    dropPct: 0.08,
    dropPctSource: 'bank',
    expectedNextScrap: 12,
    evBuyScrap: 5,
    evWaitScrap: 9,
    dropsThisRun: 2,
    steps: [
      { at: NOW - 30 * HOUR, prevAt: NOW - 31 * HOUR, fromScrap: 15, toScrap: 14, pct: -1 / 15 },
      { at: NOW - 5 * HOUR, prevAt: NOW - 6 * HOUR, fromScrap: 14, toScrap: 13, pct: -1 / 14 },
    ],
    cadenceMs: null,
    cadenceSource: null,
    nextDropAt: null,
    earlierRunEnds: [],
    scope: 'bank',
    lookGapMs: 6 * HOUR,
    resolutionMs: 2 * HOUR,
    n: { states: 41, copies: 6, ended: 30, drops: 19, dropCopies: 5, gone: 10, rose: 8, atRisk: 8, atRiskEnd: 3, ownDrops: 2, imprecise: 2, wideGap: 1 },
    ...over,
  };
}

const day = (ts: number) => fmtSaveTime(ts).split(' ').slice(0, 2).join(' ');

describe('0.8 the buy-timing block (T5)', () => {
  it('re-exports the shared DM-5 staleness (T3 reads it too)', () => {
    expect(HISTORY_LAST_SEEN_STALE_MS).toBe(SHARED_STALE_MS);
    expect(HISTORY_LAST_SEEN_STALE_MS).toBe(48 * HOUR);
  });

  it('a wait: the pill, the drops, the odds over their own denominator with the prices and items behind them, the money', () => {
    const v = historyTimingView(buyTiming(), { bank: 'hats' }, K, NOW)!;
    expect(v.pill).toMatchObject({ text: 'Wait ~1 d', tone: 'warn' });
    expect(v.pill.title).toContain('Of the 8 prices on scrap.tf/buy/hats still at their price at this age (from 41 prices of 6 items in your saves)');
    expect(v.lines).toEqual([
      '2 drops in this run (−7 %, −7 %)',
      'On scrap.tf/buy/hats in your saves, of the 8 prices still at their price at this age (41 prices of 6 items): within 1 d 35 % dropped, 40 % went or rose first; 3 were still at their price at the end of that time. From your save 5 h ago.',
      `Wait 1 d: expected ${fmtSignedMoney(9, K)} vs ${fmtSignedMoney(5, K)} now (Sells for ${fmtMoney(18, K)}, Pay up to ${fmtMoney(15, K)})`,
    ]);
    expect(v.note).toBe(TIMING_ESTIMATE_NOTE);
    // A pooled band says so.
    expect(historyTimingView(buyTiming({ scope: 'band' }), { bank: 'hats' }, K, NOW)!.lines[1]).toContain('of the 8 prices of similar value still at their price');
  });

  it("an own rhythm: 'would be due' ahead, 'was due' once past; a bank rhythm never gets a date", () => {
    const ahead = historyTimingView(buyTiming({ cadenceSource: 'own', cadenceMs: 2 * DAY, nextDropAt: NOW + 2 * DAY }), { bank: 'hats' }, K, NOW)!;
    expect(ahead.lines[0]).toBe(`2 drops in this run (−7 %, −7 %), about every 2 d in your saves; by that rhythm the next drop would be due around ${day(NOW + 2 * DAY)}`);
    const past = historyTimingView(buyTiming({ cadenceSource: 'own', cadenceMs: 2 * DAY, nextDropAt: NOW - DAY }), { bank: 'hats' }, K, NOW)!;
    expect(past.lines[0]).toBe(`2 drops in this run (−7 %, −7 %), about every 2 d in your saves; by that rhythm a drop was due ${day(NOW - DAY)}: save the page again to see`);
    const bank = historyTimingView(buyTiming({ cadenceSource: 'bank', cadenceMs: 2 * DAY, nextDropAt: null }), { bank: 'hats' }, K, NOW)!;
    expect(bank.lines[0]).toBe('2 drops in this run (−7 %, −7 %); drops on scrap.tf/buy/hats in your saves came a median 2 d after the price was set (19 drops)');
    for (const l of [...ahead.lines, ...past.lines, ...bank.lines]) expect(l).not.toMatch(/will drop|likely to drop|probab/i);
    // No drop in this run and no rhythm: no drops line.
    expect(historyTimingView(buyTiming({ dropsThisRun: 0, steps: [] }), { bank: 'hats' }, K, NOW)!.lines[0]).toMatch(/^On scrap\.tf\/buy\/hats/);
  });

  it('every other verdict: its pill, its reason, and the earlier runs\' last prices (never a floor)', () => {
    const over = historyTimingView(buyTiming({ verdict: 'over', why: 'over', earlierRunEnds: [{ endedAt: NOW - 3 * DAY, endedAs: 'absent', lastScrap: 11 }, { endedAt: NOW - 9 * DAY, endedAs: 'sold-out', lastScrap: 10 }] }), { bank: 'hats' }, K, NOW)!;
    expect(over.pill.text).toBe('Over Pay up to');
    expect(over.pill.tone).toBe('bad');
    expect(over.pill.title).toBe('Over Pay up to, and no drop likely enough to bring it under. From your save 5 h ago; an estimate, not a forecast.');
    expect(over.lines.at(-1)).toBe(`Earlier runs ended at ${fmtMoney(11, K)} and ${fmtMoney(10, K)} (the lowest seen so far is not a floor)`);
    const none = historyTimingView(buyTiming({ verdict: 'no-buyers', why: 'no-buyers', revenueScrap: null, maxCostScrap: null, horizonMs: null, pDrop: null, pGone: null, pRise: null, pNone: null, evBuyScrap: null, evWaitScrap: null }), { bank: 'hats' }, K, NOW)!;
    expect(none.pill).toMatchObject({ text: 'No buyers', tone: 'muted' });
    expect(none.lines).toContain('No backpack.tf buyer to judge it against');
    const nothing = { horizonMs: null, pDrop: null, pGone: null, pRise: null, pNone: null, evWaitScrap: null } as const;
    const few = historyTimingView(buyTiming({ verdict: 'not-enough-data', why: 'few-drops', ...nothing, n: { ...buyTiming().n, drops: 3, dropCopies: 2 } }), { bank: 'hats' }, K, NOW)!;
    expect(few.pill).toMatchObject({ text: 'Not enough data', tone: 'muted' });
    // The reason first, then what the run shows.
    expect(few.lines[0]).toBe('Only 3 price drops in your saves of scrap.tf/buy/hats so far, from 2 items (5 drops from 3 items needed); keep saving it');
    expect(few.lines[1]).toBe('2 drops in this run (−7 %, −7 %)');
    const sparse = historyTimingView(buyTiming({ verdict: 'not-enough-data', why: 'sparse-saves', ...nothing, lookGapMs: 3 * DAY }), { bank: 'hats' }, K, NOW)!;
    expect(sparse.lines.join('\n')).toContain('You look at its page about every 3 d (saves within 30 min count as one look)');
    expect(historyTimingView(null, { bank: 'hats' }, K, NOW)).toBeNull();
    expect(historyTimingView(undefined, { bank: 'hats' }, K, NOW)).toBeNull();
  });
});

function run(over: Partial<ScraptfListingRun> = {}): ScraptfListingRun {
  return {
    firstOnSaleAt: NOW - 5 * DAY,
    startAfter: NOW - 5 * DAY - 12 * HOUR,
    lastOnSaleAt: NOW - 2 * HOUR,
    endedAt: null,
    endedAs: null,
    startRaw: { keys: 0, scrap: 13 },
    endRaw: { keys: 0, scrap: 11 },
    drops: 1,
    saves: 10,
    sameAssetAsBefore: null,
    ...over,
  };
}

/** Three runs, oldest first: one already listed at the first save (ended gone), a flap, and the open one after it. */
function cycles(over: Partial<ScraptfItemCycles> = {}): ScraptfItemCycles {
  return {
    runs: [
      run({ firstOnSaleAt: NOW - 10 * DAY, startAfter: null, lastOnSaleAt: NOW - 8 * DAY, endedAt: NOW - 8 * DAY + 12 * HOUR, endedAs: 'absent', startRaw: { keys: 0, scrap: 15 }, endRaw: { keys: 0, scrap: 13 }, drops: 2, saves: 5 }),
      run({ firstOnSaleAt: NOW - 6 * DAY, startAfter: NOW - 6 * DAY - 12 * HOUR, lastOnSaleAt: NOW - 5 * DAY, endedAt: NOW - 5 * DAY + 30 * MIN, endedAs: 'absent', flap: true, startRaw: { keys: 0, scrap: 13 }, endRaw: { keys: 0, scrap: 13 }, drops: 0, saves: 3, sameAssetAsBefore: false }),
      run({ firstOnSaleAt: NOW - 5 * DAY + 50 * MIN, startAfter: NOW - 5 * DAY + 30 * MIN, sameAssetAsBefore: true }),
    ],
    runsTotal: 3,
    returns: 1,
    dropAts: [NOW - 2 * HOUR],
    assetIdsStable: true,
    ...over,
  };
}

describe('0.8 the listing runs (LC-3)', () => {
  it('heads with the runs and returns, and lists each run newest first, bracketed by the saves', () => {
    const v = historyRunLines(cycles(), { bank: 'hats', keyPrice: null }, K, NOW)!;
    expect(v.head).toBe('Listed 3 times in your saves (back once)');
    expect(v.title).toContain("'gone from the page' can be a sale, a reservation or a move");
    expect(v.lines.map((l) => l.text)).toEqual([
      `${day(NOW - 5 * DAY + 50 * MIN)} → now (${scraptfAgoText(5 * DAY - 2 * HOUR - 50 * MIN)} so far), ${fmtMoney(13, K)} → ${fmtMoney(11, K)}, 1 drop · listed now · the same item came back`,
      `${day(NOW - 6 * DAY)} → ${day(NOW - 5 * DAY)} (${scraptfAgoText(DAY)}–${scraptfAgoText(DAY + 12 * HOUR + 30 * MIN)}), at ${fmtMoney(13, K)}, no drop, then back at the same price within the hour (a partial look, not counted as gone) · another copy (or the same one traded back)`,
      `${day(NOW - 10 * DAY)} → ${day(NOW - 8 * DAY)} (at least ${scraptfAgoText(2 * DAY)}), ${fmtMoney(15, K)} → ${fmtMoney(13, K)}, 2 drops, then gone from the page · already listed at your first save of its page`,
    ]);
    expect(v.lines.map((l) => l.tone)).toEqual(['info', 'muted', 'muted']);
    expect(v.lines[2]!.title).toContain(`The first save without it on sale: ${fmtDateTime(NOW - 8 * DAY + 12 * HOUR)}.`);
  });

  it("shows 'the same item came back' only while the bank's ids are stable", () => {
    const v = historyRunLines(cycles({ assetIdsStable: false }), { bank: 'hats', keyPrice: null }, K, NOW)!;
    for (const l of v.lines) expect(l.text).not.toMatch(/same item came back|another copy/);
  });

  it('words a sold-out end, an untradable end and a run whose newest save is long past', () => {
    const v = historyRunLines(
      cycles({
        runs: [
          run({ firstOnSaleAt: NOW - 9 * DAY, lastOnSaleAt: NOW - 8 * DAY, endedAt: NOW - 7 * DAY, endedAs: 'sold-out', startAfter: NOW - 9 * DAY - HOUR }),
          run({ firstOnSaleAt: NOW - 6 * DAY, lastOnSaleAt: NOW - 5 * DAY, endedAt: NOW - 4 * DAY, endedAs: 'untradable', startAfter: NOW - 6 * DAY - HOUR }),
          run({ firstOnSaleAt: NOW - 3 * DAY, startAfter: NOW - 3 * DAY - HOUR, lastOnSaleAt: NOW - 3 * DAY + HOUR }),
        ],
        runsTotal: 25,
        returns: 2,
      }),
      { bank: 'hats', keyPrice: null },
      K,
      NOW,
    )!;
    expect(v.head).toBe('Listed 25 times in your saves (back 2 times)');
    expect(v.title).toContain('The newest 3 of 25 runs are listed.');
    expect(v.lines[0]!.text).toContain(`→ ${day(NOW - 3 * DAY + HOUR)} (`);
    expect(v.lines[0]!.text).toContain('· listed in your newest save of its page');
    expect(v.lines[1]!.text).toContain('then turned untradable (the same item showed as not tradable)');
    expect(v.lines[1]!.tone).toBe('warn');
    expect(v.lines[2]!.text).toContain('then sold out');
  });

  it('values prices at the history\'s key price, and is null without runs', () => {
    const keys = cycles({ runs: [run({ startRaw: { keys: 1, scrap: 0 }, endRaw: { keys: 1, scrap: 0 } })], runsTotal: 1, returns: 0 });
    const v = historyRunLines(keys, { bank: 'hats', keyPrice: { valueScrap: 600 } as ScraptfItemHistory['keyPrice'] }, K, NOW)!;
    expect(v.head).toBe('Listed once in your saves');
    expect(v.lines[0]!.text).toContain(`at ${fmtMoney(600, 600)}`);
    expect(historyRunLines(null, { bank: 'hats', keyPrice: null }, K, NOW)).toBeNull();
    expect(historyRunLines(undefined, { bank: 'hats', keyPrice: null }, K, NOW)).toBeNull();
    expect(historyRunLines(cycles({ runs: [] }), { bank: 'hats', keyPrice: null }, K, NOW)).toBeNull();
  });
});

describe("0.8 the chart's down markers (T5)", () => {
  const pts: StepPoint[] = [
    { at: 0, value: 20 },
    { at: 100, value: 10 },
    { at: 200, value: null },
    { at: 300, value: 10 },
    { at: 400, value: 8 },
  ];

  it('marks the dots of the saves that showed a drop, only when asked', () => {
    const plain = stepChartGeom(pts)!;
    // Without marks: exactly 0.7.4's geometry, no `downs` key (holdings' chart and every older caller).
    expect(plain).not.toHaveProperty('downs');
    expect(stepChartGeom(pts, STEP_BOX, {})).toEqual(plain);
    const marked = stepChartGeom(pts, STEP_BOX, { downAts: [100, 400, 200, 999] })!;
    expect(marked.downs).toEqual([plain.dots[1], plain.dots[3]]);
    expect(marked.downs!.map((d) => d.i)).toEqual([1, 4]);
    const { downs, ...rest } = marked;
    expect(rest).toEqual(plain);
    expect(downs).toBeDefined();
    expect(stepChartGeom(pts, STEP_BOX, { downAts: [] })!.downs).toEqual([]);
  });

  it("over the browser mock: a saved copy's runs and drops line up with its chart", async () => {
    const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    try {
      const stock = await b.rpc('scraptf.bankStock', { bank: 'hats', limit: 60 });
      let checked = 0;
      for (const r of stock.rows.filter((x) => x.change !== 'gone').slice(0, 20)) {
        const special = r.key.slice(r.sku.length + 1);
        const h = await b.rpc('scraptf.itemHistory', { sku: r.sku, special });
        if (!h.cycles) continue;
        checked++;
        const g = stepChartGeom(historySeries(h.points), STEP_BOX, { downAts: h.cycles.dropAts })!;
        expect(g.downs!.length).toBe(h.cycles.dropAts.filter((at) => h.points.some((p) => p.at === at && p.listed)).length);
        const runs = historyRunLines(h.cycles, h, K, T0)!;
        expect(runs.lines).toHaveLength(h.cycles.runs.length);
        if (h.timing) expect(historyTimingView(h.timing, h, K, T0)!.note).toBe(TIMING_ESTIMATE_NOTE);
      }
      expect(checked).toBeGreaterThan(5);
    } finally {
      b.dispose();
    }
  });
});
