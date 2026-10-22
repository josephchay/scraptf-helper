// 0.9 (#10): honest uncertainty in the buy-timing texts (timingModel.ts, historyModel.ts). The odds carry their 90 %
// ranges with the items behind them; a verdict that turns with save timing says so and its tag ends in '?' (muted);
// 'unsure-gain' says waiting looked worth more but may add nothing; the drawer's money line quotes the gain's low end
// for the picked wait taken alone (and the drop size it took, T9-3b); TIMING_ESTIMATE_NOTE says what the ranges do not
// cover. Mock parity: every mock row with a horizon carries ranges around its shares, the same as its drawer's timing.
// Estimates, never forecasts. Pure (the mock is in-process); nothing here touches the network or scrap.tf.

import { afterEach, describe, expect, it } from 'vitest';
import { fmtMoney, fmtSignedMoney } from '../../src/renderer/format';
import { historyTimingView } from '../../src/renderer/historyModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import {
  TIMING_ESTIMATE_NOTE,
  timingBadge,
  timingRangeText,
  timingRangesText,
  timingSaveTimingText,
  timingVerdictTitle,
  timingWhyText,
  type TimingWhyContext,
} from '../../src/renderer/timingModel';
import { BANK_STOCK_MAX_LIMIT } from '../../src/shared/bankStock';
import { CHECKOUT_GUARD_TAG } from '../../src/shared/checkoutGuard';
import { scraptfTimingBrief } from '../../src/shared/scraptfTiming';
import type { BankStockRow, ScraptfBank, ScraptfBuyTiming, ScraptfSaveTimingAlt, ScraptfTimingUncertainty, ScraptfTimingWhy } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const K = 600;
const BANNED = /will drop|likely to drop|probab|forecast:/i;

/** As timingModel.test.ts: a whole verdict, 8 of 41 prices (6 items) at risk, 35 % dropped within 1 d. */
function timing(over: Partial<ScraptfBuyTiming> = {}): ScraptfBuyTiming {
  return {
    verdict: 'wait',
    why: 'drop-likely',
    bank: 'hats',
    key: '378;6|',
    costScrap: 100,
    revenueScrap: 120,
    maxCostScrap: 111,
    priceSince: NOW - 2 * DAY,
    pricePrevAt: NOW - 3 * DAY,
    lastSeenAt: NOW - 5 * HOUR,
    ageMs: 2 * DAY - 5 * HOUR,
    horizonMs: DAY,
    pDrop: 0.35,
    pGone: 0.25,
    pRise: 0.15,
    pNone: 0.25,
    dropPct: 0.05,
    dropPctSource: 'bank',
    expectedNextScrap: 95,
    evBuyScrap: 9,
    evWaitScrap: 13,
    dropsThisRun: 0,
    steps: [],
    cadenceMs: null,
    cadenceSource: null,
    nextDropAt: null,
    earlierRunEnds: [],
    scope: 'bank',
    lookGapMs: 6 * HOUR,
    resolutionMs: 2 * HOUR,
    n: { states: 41, copies: 6, ended: 30, drops: 12, dropCopies: 5, gone: 10, rose: 8, atRisk: 8, atRiskEnd: 3, ownDrops: 0, imprecise: 2, wideGap: 1 },
    ...over,
  };
}

const brief = (over: Partial<ScraptfBuyTiming> = {}) => scraptfTimingBrief(timing(over));

/** As historyModel.test.ts's helper: the drawer's verdict, two drops in this run, Sells for 18, Pay up to 15. */
function buyTiming(over: Partial<ScraptfBuyTiming> = {}): ScraptfBuyTiming {
  return timing({
    costScrap: 13,
    revenueScrap: 18,
    maxCostScrap: 15,
    dropPct: 0.08,
    expectedNextScrap: 12,
    evBuyScrap: 5,
    evWaitScrap: 9,
    dropsThisRun: 2,
    steps: [
      { at: NOW - 30 * HOUR, prevAt: NOW - 31 * HOUR, fromScrap: 15, toScrap: 14, pct: -1 / 15 },
      { at: NOW - 5 * HOUR, prevAt: NOW - 6 * HOUR, fromScrap: 14, toScrap: 13, pct: -1 / 14 },
    ],
    n: { states: 41, copies: 6, ended: 30, drops: 19, dropCopies: 5, gone: 10, rose: 8, atRisk: 8, atRiskEnd: 3, ownDrops: 2, imprecise: 2, wideGap: 1 },
    ...over,
  });
}

const ctx = (over: Partial<TimingWhyContext> = {}): TimingWhyContext => ({
  path: 'scrap.tf/buy/hats',
  n: timing().n,
  lookGapMs: 6 * HOUR,
  lastSeenAt: NOW - 5 * HOUR,
  now: NOW,
  ...over,
});

const U: ScraptfTimingUncertainty = { pDrop: { low: 0.2, high: 0.52 }, pGoneOrRose: { low: 0.25, high: 0.56 }, copies: 6, gainLowScrap: 2 };
const ALT: ScraptfSaveTimingAlt = { verdict: 'buy-now', why: 'flip-now', horizonMs: DAY };
const RANGES = 'Allowing for chance across the 6 items behind these (a 90 % range): 20-52 % dropped, 25-56 % went or rose first.';
const SAVE_TIMING_HEAD = 'Depends on save timing: had each price change come just after your last save before it, not just before the save that showed it, your saves would suggest';

describe('0.9 (#10): the tag and the titles', () => {
  it('a Wait with ranges: the ranges sentence after the odds, before the copy read; no guard on a Wait', () => {
    const b = timingBadge(brief({ uncertainty: U }), NOW)!;
    expect(b).toMatchObject({ text: 'Wait ~1 d', tone: 'warn' });
    expect(b.title).toBe(
      `Your saves suggest waiting about 1 d. Of the 8 prices on scrap.tf/buy/hats still at their price at this age (from 41 prices of 6 items in your saves), 35 % dropped within 1 d and 40 % went or rose first. ${RANGES} Copy read: the plain copy. From your save 5 h ago; an estimate, not a forecast.`,
    );
    expect(b.title).not.toContain(CHECKOUT_GUARD_TAG);
    // Without the optional fields every 0.8 text is unchanged.
    const plain = timingBadge(brief(), NOW)!;
    expect(plain).toMatchObject({ text: 'Wait ~1 d', tone: 'warn' });
    expect(plain.title).not.toContain('Allowing for chance');
    expect(plain.title).not.toContain('Depends on save timing');
  });

  it("a flagged verdict ends in '?' and is muted, and says what the other placement suggests", () => {
    const w = timingBadge(brief({ uncertainty: U, saveTiming: ALT }), NOW)!;
    expect(w).toMatchObject({ text: 'Wait ~1 d?', tone: 'muted' });
    const st = `${SAVE_TIMING_HEAD} buying now.`;
    expect(w.title).toContain(st);
    expect(w.title.indexOf(RANGES)).toBeLessThan(w.title.indexOf(st));
    expect(w.title.indexOf(st)).toBeLessThan(w.title.indexOf('Copy read:'));

    const bn = timingBadge(brief({ verdict: 'buy-now', why: 'flip-now', saveTiming: { verdict: 'wait', why: 'drop-likely', horizonMs: DAY } }), NOW)!;
    expect(bn).toMatchObject({ text: 'Buy now?', tone: 'muted' });
    expect(bn.title).toContain('would suggest waiting about 1 d.');
    // D5: the checkout guard stays last on a Buy now, flagged or not.
    expect(bn.title.endsWith(CHECKOUT_GUARD_TAG)).toBe(true);
    expect(timingBadge(brief({ verdict: 'buy-now', why: 'flip-now', uncertainty: U }), NOW)!.title.endsWith(CHECKOUT_GUARD_TAG)).toBe(true);
  });

  it('the Verdict title: lead, odds, ranges, save timing, then the save', () => {
    const t = timingVerdictTitle(brief({ uncertainty: U, saveTiming: ALT }), NOW);
    expect(t.startsWith('Buy timing: Your saves suggest waiting about 1 d. Of the 8 prices')).toBe(true);
    const parts = ['Buy timing:', 'Your saves suggest waiting about 1 d.', '35 % dropped within 1 d', RANGES, `${SAVE_TIMING_HEAD} buying now.`, 'From your save 5 h ago; an estimate, not a forecast.'];
    const at = parts.map((p) => t.indexOf(p));
    for (const [i, x] of at.entries()) expect(x, parts[i]).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < at.length; i++) expect(at[i], parts[i]).toBeGreaterThan(at[i - 1]!);
    expect(t.endsWith('From your save 5 h ago; an estimate, not a forecast.')).toBe(true);
  });

  it("'unsure-gain': waiting looked worth more, but allowing for chance it may add nothing", () => {
    expect(timingBadge(brief({ verdict: 'buy-now', why: 'unsure-gain' }), NOW)!.title.startsWith('Your saves suggest buying now: waiting 1 d looked worth more, but allowing for chance it may add nothing.')).toBe(true);
    expect(
      timingVerdictTitle(brief({ verdict: 'over', why: 'unsure-gain' }), NOW).startsWith(
        'Buy timing: Over Pay up to: a typical drop would bring it under, but allowing for chance waiting may add nothing.',
      ),
    ).toBe(true);
    // A plain Over keeps 0.8's words.
    expect(timingVerdictTitle(brief({ verdict: 'over', why: 'over' }), NOW).startsWith('Buy timing: Over Pay up to: your saves show no drop likely enough to bring it under.')).toBe(true);
    expect(timingWhyText('unsure-gain', ctx())).toBe(
      'Waiting looked worth more on the estimate, but allowing for chance across the items in your saves it may add nothing; keep saving the page to settle it',
    );
    const all: ScraptfTimingWhy[] = ['drop-likely', 'drop-makes-flip', 'flip-now', 'gone-risk', 'unsure-gain', 'over', 'no-buyers', 'stale-save', 'left-censored', 'few-drops', 'few-ended', 'few-at-risk', 'sparse-saves', 'past-data'];
    for (const why of all) expect(timingWhyText(why, ctx()).length, why).toBeGreaterThan(10);
  });

  it('timingRangeText rounds outward to whole percents; the sentences are null without their fields', () => {
    expect(timingRangeText({ low: 0.48190267854213237, high: 0.8540862689973678 })).toBe('48-86 %');
    expect(timingRangeText({ low: 0, high: 0.1192 })).toBe('0-12 %');
    expect(timingRangeText({ low: 0.5, high: 0.5 })).toBe('50 %');
    expect(timingRangeText({ low: 1.39e-17, high: 0.12 })).toBe('0-12 %');
    expect(timingRangeText({ low: 0.03105725921200482, high: 0.27806580301342315 })).toBe('3-28 %');
    expect(timingRangesText({ uncertainty: { ...U, copies: 1 } })).toContain('across the 1 item behind these');
    expect(timingRangesText({ uncertainty: { ...U, copies: 0 } })).toBeNull();
    expect(timingRangesText({})).toBeNull();
    expect(timingRangesText({ uncertainty: null })).toBeNull();
    expect(timingSaveTimingText({})).toBeNull();
    expect(timingSaveTimingText({ saveTiming: null })).toBeNull();
    expect(timingSaveTimingText({ saveTiming: ALT })).toBe(`${SAVE_TIMING_HEAD} buying now.`);
    expect(timingSaveTimingText({ saveTiming: { verdict: 'wait', why: 'drop-likely', horizonMs: DAY } })).toBe(`${SAVE_TIMING_HEAD} waiting about 1 d.`);
    expect(timingSaveTimingText({ saveTiming: { verdict: 'wait', why: 'drop-likely', horizonMs: null } })).toBe(`${SAVE_TIMING_HEAD} waiting.`);
    expect(timingSaveTimingText({ saveTiming: { verdict: 'over', why: 'unsure-gain', horizonMs: DAY } })).toBe(`${SAVE_TIMING_HEAD} not buying (over Pay up to).`);
    for (const s of [RANGES, timingSaveTimingText({ saveTiming: ALT })!]) expect(s).not.toMatch(BANNED);
  });
});

describe("0.9 (#10): the drawer's buy-timing block", () => {
  it('the ranges in the odds line, the low end in the money line, the save-timing line under it, a muted ? pill', () => {
    const v = historyTimingView(buyTiming({ uncertainty: U, saveTiming: ALT }), { bank: 'hats' }, K, NOW)!;
    expect(v.pill).toMatchObject({ text: 'Wait ~1 d?', tone: 'muted' });
    expect(v.lines).toEqual([
      '2 drops in this run (−7 %, −7 %)',
      `On scrap.tf/buy/hats in your saves, of the 8 prices still at their price at this age (41 prices of 6 items): within 1 d 35 % dropped, 40 % went or rose first; 3 were still at their price at the end of that time. ${RANGES} From your save 5 h ago.`,
      `Wait 1 d: expected ${fmtSignedMoney(9, K)} vs ${fmtSignedMoney(5, K)} now (Sells for ${fmtMoney(18, K)}, Pay up to ${fmtMoney(15, K)}); allowing for chance in the odds, waiting adds at least ${fmtSignedMoney(2, K)} (the low end for the wait your saves picked, taken alone)`,
      `${SAVE_TIMING_HEAD} buying now.`,
    ]);
    expect(v.note).toBe(TIMING_ESTIMATE_NOTE);
    for (const l of v.lines) expect(l).not.toMatch(BANNED);
  });

  it('a low end under a scrap says waiting may add nothing; none without the gate; the drop size when it took one (T9-3b)', () => {
    const money = (u: ScraptfTimingUncertainty | undefined) => historyTimingView(buyTiming(u ? { uncertainty: u } : {}), { bank: 'hats' }, K, NOW)!.lines[2]!;
    const base = `Wait 1 d: expected ${fmtSignedMoney(9, K)} vs ${fmtSignedMoney(5, K)} now (Sells for ${fmtMoney(18, K)}, Pay up to ${fmtMoney(15, K)})`;
    expect(money({ ...U, gainLowScrap: 0 })).toBe(`${base}; allowing for chance in the odds, waiting may add nothing (low end ${fmtSignedMoney(0, K)} for the wait your saves picked)`);
    expect(money({ ...U, gainLowScrap: -4 })).toBe(`${base}; allowing for chance in the odds, waiting may add nothing (low end ${fmtSignedMoney(-4, K)} for the wait your saves picked)`);
    expect(money({ ...U, gainLowScrap: null })).toBe(base);
    expect(money(undefined)).toBe(base);
    expect(money({ ...U, gainLowScrap: 3, dropLow: 0.0612, dropSizeFrom: 'short-brackets' })).toBe(
      `${base}; allowing for chance in the odds, waiting adds at least ${fmtSignedMoney(3, K)} (the low end for the wait your saves picked, taken alone, at a drop of 6 %)`,
    );
    expect(money({ ...U, gainLowScrap: 0, dropLow: 0.003, dropSizeFrom: 'all' })).toBe(
      `${base}; allowing for chance in the odds, waiting may add nothing (low end ${fmtSignedMoney(0, K)} for the wait your saves picked, at a drop of under 1 %)`,
    );
    // An unflagged verdict has no save-timing line, and the pill keeps 0.8's tone.
    const plain = historyTimingView(buyTiming({ uncertainty: U }), { bank: 'hats' }, K, NOW)!;
    expect(plain.pill).toMatchObject({ text: 'Wait ~1 d', tone: 'warn' });
    expect(plain.lines.some((l) => l.startsWith('Depends on save timing'))).toBe(false);
    // An Over with 'unsure-gain' keeps its fixed pill and says why.
    const over = historyTimingView(buyTiming({ verdict: 'over', why: 'unsure-gain', uncertainty: { ...U, gainLowScrap: -2 } }), { bank: 'hats' }, K, NOW)!;
    expect(over.pill).toMatchObject({ text: 'Over Pay up to', tone: 'bad' });
    expect(over.pill.title.startsWith('Waiting looked worth more on the estimate')).toBe(true);
    expect(over.lines.some((l) => l.endsWith(`waiting may add nothing (low end ${fmtSignedMoney(-2, K)} for the wait your saves picked)`))).toBe(true);
  });

  it('TIMING_ESTIMATE_NOTE says what the ranges do not cover, names the pick and the drop size at its low end', () => {
    expect(TIMING_ESTIMATE_NOTE).toMatch(/^An estimate from your saves, not a forecast/);
    expect(TIMING_ESTIMATE_NOTE).toContain('Ranges allow for chance between the items in your saves, not for when you happened to save');
    expect(TIMING_ESTIMATE_NOTE).toContain('for the wait your saves picked, taken alone');
    expect(TIMING_ESTIMATE_NOTE).toContain('the best of up to four');
    expect(TIMING_ESTIMATE_NOTE).toContain('takes the size of a drop at its low end');
    // T9-3b: the drop size is no longer taken as known, and nothing claims a 95 % level.
    expect(TIMING_ESTIMATE_NOTE).not.toContain('as known');
    expect(TIMING_ESTIMATE_NOTE).not.toMatch(/95/);
    // ("not a forecast:" is 0.8's own opening, so only the other banned words are checked here.)
    expect(TIMING_ESTIMATE_NOTE).not.toMatch(/will drop|likely to drop|probab/i);
  });
});

describe('0.9 (#10): mock parity', () => {
  let bridge: MockBridge | null = null;
  const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
  const SAVED: ScraptfBank[] = ['hats', 'unusuals', 'stranges', 'weapons', 'killstreaks', 'list'];
  afterEach(() => {
    bridge?.dispose();
    bridge = null;
  });
  const specialOf = (r: Pick<BankStockRow, 'sku' | 'key'>) => r.key.slice(r.sku.length + 1);

  it("every row with a horizon has ranges around its shares, the same as its drawer's timing; no other row has any", async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    let ranged = 0;
    let compared = 0;
    const unsure: string[] = [];
    for (const bank of SAVED) {
      const page = await b.rpc('scraptf.bankStock', { bank, limit: BANK_STOCK_MAX_LIMIT });
      for (const r of page.rows) {
        const t = r.timing;
        if (!t) continue;
        // Measured on the mock (C.6 §4): no row's verdict depends on save timing.
        expect(t.saveTiming, r.key).toBeUndefined();
        if (t.why === 'unsure-gain') unsure.push(`${bank}:${t.verdict}`);
        if (typeof t.horizonMs !== 'number' || !Number.isFinite(t.horizonMs)) {
          expect(t.uncertainty, r.key).toBeUndefined();
          continue;
        }
        ranged++;
        const u = t.uncertainty!;
        expect(u, r.key).toBeDefined();
        expect(u.copies).toBeGreaterThan(0);
        expect(u.pDrop.low).toBeLessThanOrEqual(t.pDrop! + 1e-12);
        expect(u.pDrop.high).toBeGreaterThanOrEqual(t.pDrop! - 1e-12);
        const out = (t.pGone ?? 0) + (t.pRise ?? 0);
        expect(u.pGoneOrRose.low).toBeLessThanOrEqual(out + 1e-12);
        expect(u.pGoneOrRose.high).toBeGreaterThanOrEqual(out - 1e-12);
        const h = await b.rpc('scraptf.itemHistory', { sku: r.sku, special: specialOf(r) });
        if (h.bank !== bank || !h.timing) continue;
        compared++;
        expect(h.timing.uncertainty, r.key).toEqual(u);
        // The drawer's tag and lines say the same.
        const v = historyTimingView(h.timing, h, K, T0)!;
        for (const l of v.lines) expect(l).not.toMatch(BANNED);
        expect(v.lines.some((l) => l.includes(timingRangesText({ uncertainty: u })!)), r.key).toBe(true);
      }
    }
    expect(ranged).toBeGreaterThan(20);
    expect(compared).toBeGreaterThan(20);
    // The two 0.8 mock Waits (stranges and list, both drop-makes-flip) now read Over / unsure-gain (A.2, T9-8).
    expect(unsure.sort()).toEqual(['list:over', 'stranges:over']);
  });
});
