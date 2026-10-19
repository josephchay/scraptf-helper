// F20 U1: the item drawer's "scrap.tf history" helpers (historyModel.ts): "Listed since 2 d 4 h (since
// your save on Oct 14 09:12)", stock now, the 1 h / 24 h / 7 d / since-listed chips, the step chart's
// geometry with gaps where a save did not list the item on sale, the hover readout, the change lines and
// the empty state; then the same over the browser mock's real history. Pure; nothing here touches the
// network or scrap.tf.

import { afterEach, describe, expect, it } from 'vitest';
import { fmtSaveTime } from '../../src/renderer/changesModel';
import { fmtDateTime } from '../../src/renderer/format';
import {
  HISTORY_EVENTS_SHOWN,
  STEP_BOX,
  historyBankPath,
  historyChartLabel,
  historyChips,
  historyEventLines,
  historyListedLine,
  historyNote,
  historyNowText,
  historyReadout,
  historySeries,
  nearestStep,
  priceChangeText,
  stepChartGeom,
  type StepPoint,
} from '../../src/renderer/historyModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { ScraptfChangeEvent, ScraptfHistoryPoint, ScraptfItemHistory, ScraptfPriceChange } from '../../src/shared/types';

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
    expect(historyNote(history({ bank: null, points: [] }))!.body).toContain('The app never visits scrap.tf.');
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
