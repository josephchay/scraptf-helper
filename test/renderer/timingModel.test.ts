// 0.8 (T3-T7, LC-5): the buy-timing texts (timingModel.ts). The Wait / Buy now tag shows for those two verdicts
// only; every title quotes each percentage over its own denominator (n.atRisk, the prices still at their price at
// the copy's age), then the prices and items behind the table (n.states, n.copies), the copy read and "from your
// save X ago"; each not-enough-data reason says what is missing; Health's asset-id lines count pairs "between your
// looks". Estimates, never forecasts. Pure; nothing here touches the network or scrap.tf.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TIMING_ESTIMATE_NOTE,
  assetIdsLines,
  timingBadge,
  timingDurText,
  timingVerdictTitle,
  timingWhyText,
  type TimingWhyContext,
} from '../../src/renderer/timingModel';
import { fmtMoney } from '../../src/renderer/format';
import { bankStockKey, bankStockSpecialKey } from '../../src/shared/bankStock';
import { scraptfTimingBrief } from '../../src/shared/scraptfTiming';
import type { ScraptfBuyTiming, ScraptfTimingWhy } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A whole verdict as scraptfBuyTimingOf returns it: 8 of 41 prices (6 items) at risk, 35 % dropped within 1 d. */
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

const ctx = (over: Partial<TimingWhyContext> = {}): TimingWhyContext => ({
  path: 'scrap.tf/buy/hats',
  n: timing().n,
  lookGapMs: 6 * HOUR,
  lastSeenAt: NOW - 5 * HOUR,
  now: NOW,
  ...over,
});

describe('the Wait / Buy now tag (T6, T7)', () => {
  it('reads Wait ~horizon (warn) and quotes n.atRisk as the denominator, then the prices and items, the copy and the save', () => {
    const b = timingBadge(brief(), NOW)!;
    expect(b).toMatchObject({ text: 'Wait ~1 d', tone: 'warn' });
    expect(b.title).toBe(
      'Your saves suggest waiting about 1 d. Of the 8 prices on scrap.tf/buy/hats still at their price at this age (from 41 prices of 6 items in your saves), ' +
        '35 % dropped within 1 d and 40 % went or rose first. Copy read: the plain copy. From your save 5 h ago; an estimate, not a forecast.',
    );
    // Never a bare n = <states> next to percentages it is not the base of, and never a forecast.
    expect(b.title).not.toMatch(/n = |will drop|likely to sell|forecast:/);
  });

  it('reads Buy now (good), with the gone-risk and flip-now reasons', () => {
    const gone = timingBadge(brief({ verdict: 'buy-now', why: 'gone-risk', horizonMs: 6 * HOUR }), NOW)!;
    expect(gone).toMatchObject({ text: 'Buy now', tone: 'good' });
    expect(gone.title).toMatch(/^Your saves suggest buying now: prices like it on scrap\.tf\/buy\/hats went or rose first at least as often as they dropped\./);
    expect(gone.title).toContain('35 % dropped within 6 h and 40 % went or rose first');
    const flip = timingBadge(brief({ verdict: 'buy-now', why: 'flip-now', horizonMs: 3 * DAY }), NOW)!;
    expect(flip.title).toMatch(/^Your saves suggest buying now: waiting 3 d is not expected to add enough to the profit\./);
  });

  it('names the copy read by its extras', () => {
    const key = bankStockKey('378;6', bankStockSpecialKey({ sheen: 1, killstreaker: 2002 }));
    expect(timingBadge(brief({ key }), NOW)!.title).toContain('Copy read: Team Shine, Fire Horns.');
  });

  it('names the scrap.tf price judged and its Pay up to only when given the key price (Live market, Opportunities)', () => {
    const t = brief({ verdict: 'buy-now', why: 'gone-risk', costScrap: 1300, maxCostScrap: 1400 });
    expect(t).toMatchObject({ costScrap: 1300, maxCostScrap: 1400 });
    const withKey = timingBadge(t, NOW, 568)!.title;
    expect(withKey).toContain(`Judged at ${fmtMoney(1300, 568)} on scrap.tf/buy/hats, against Pay up to ${fmtMoney(1400, 568)}.`);
    // The lead stays first; the judged price comes before the odds.
    expect(withKey.indexOf('Your saves suggest buying now')).toBe(0);
    expect(withKey.indexOf('Judged at')).toBeLessThan(withKey.indexOf('Of the 8 prices'));
    // Without the key price (bank stock rows show the judged price in their own cell) the title is unchanged.
    expect(timingBadge(t, NOW)!.title).not.toContain('Judged at');
    // No Pay up to: the price alone.
    expect(timingBadge(brief({ costScrap: 1300, maxCostScrap: null }), NOW, 568)!.title).toContain(`Judged at ${fmtMoney(1300, 568)} on scrap.tf/buy/hats.`);
  });

  it('gives no tag for over, no buyers, not enough data or no timing', () => {
    for (const verdict of ['over', 'no-buyers', 'not-enough-data'] as const) expect(timingBadge(brief({ verdict }), NOW), verdict).toBeNull();
    expect(timingBadge(null, NOW)).toBeNull();
    expect(timingBadge(undefined, NOW)).toBeNull();
  });

  it("Opportunities: the tag follows the copy tag in the Item cell, from the row's timing (only 'import' rows carry one)", () => {
    const table = readFileSync(new URL('../../src/renderer/components/OppTable.tsx', import.meta.url), 'utf8');
    expect(table).toContain('const badge = timingBadge(o.timing, now, keyScrap);');
    const cell = table.slice(table.indexOf('<div role="gridcell" className="c-item">'), table.indexOf('<div role="gridcell" className="c-cost'));
    expect(cell.indexOf('copy-tag')).toBeLessThan(cell.indexOf('timing-badge'));
    expect(cell).toContain('<span className={`pill tone-${badge.tone} timing-badge`} title={badge.title}>');
  });

  it('words the horizons by their leading unit', () => {
    expect([6 * HOUR, DAY, 3 * DAY, 7 * DAY].map(timingDurText)).toEqual(['6 h', '1 d', '3 d', '7 d']);
    expect(timingDurText(45 * MIN)).toBe('45 m');
    expect(timingDurText(DAY + 4 * HOUR)).toBe('1 d');
  });
});

describe('the Verdict title sentence (T6, D23)', () => {
  it('is empty without a timing, and says every verdict with the same denominators and the save', () => {
    expect(timingVerdictTitle(null, NOW)).toBe('');
    expect(timingVerdictTitle(undefined, NOW)).toBe('');
    const wait = timingVerdictTitle(brief(), NOW);
    expect(wait).toMatch(/^Buy timing: Your saves suggest waiting about 1 d\. Of the 8 prices on scrap\.tf\/buy\/hats still at their price at this age \(from 41 prices of 6 items in your saves\)/);
    expect(wait).toMatch(/From your save 5 h ago; an estimate, not a forecast\.$/);
    expect(timingVerdictTitle(brief({ verdict: 'over', why: 'over' }), NOW)).toMatch(/^Buy timing: Over Pay up to: your saves show no drop likely enough to bring it under\. Of the 8 prices/);
    expect(timingVerdictTitle(brief({ verdict: 'no-buyers', why: 'no-buyers', horizonMs: null, pDrop: null }), NOW)).toBe('Buy timing: No backpack.tf buyer to judge the timing against.');
  });

  it('says why there is not enough data, from what a row carries (its brief has four n fields)', () => {
    const stale = timingVerdictTitle(brief({ verdict: 'not-enough-data', why: 'stale-save', lastSeenAt: NOW - 3 * DAY, horizonMs: null, pDrop: null }), NOW);
    expect(stale).toBe('Buy timing: not enough data. Your newest save of it is 3 d old; save the page again.');
    // The brief has no n.drops: the reason is worded without a number, with its items.
    const few = timingVerdictTitle(brief({ verdict: 'not-enough-data', why: 'few-drops', horizonMs: null, pDrop: null }), NOW);
    expect(few).toBe('Buy timing: not enough data. Too few price drops in your saves of scrap.tf/buy/hats so far, from 5 items (5 drops from 3 items needed); keep saving it.');
    const risk = timingVerdictTitle(brief({ verdict: 'not-enough-data', why: 'few-at-risk', horizonMs: null, pDrop: null }), NOW);
    expect(risk).toContain('(8 of 8)');
  });
});

describe('why there is not enough data (E.1-2)', () => {
  it('words every not-enough-data reason, each saying what is missing', () => {
    const want: Record<string, RegExp> = {
      'few-drops': /^Only 3 price drops in your saves of scrap\.tf\/buy\/hats so far, from 2 items \(5 drops from 3 items needed\); keep saving it$/,
      'few-ended': /^Only 9 prices in your saves of scrap\.tf\/buy\/hats ended in a drop, going off sale or a rise so far \(15 needed\)$/,
      // n.atRisk counts prices (states), never items: one copy repriced three times is three (review fix).
      'few-at-risk': /^Too few prices on scrap\.tf\/buy\/hats stayed at their price this long in your saves \(4 of 8\)$/,
      'left-censored': /^It was already at this price in your first save of its page: how long it has been listed is unknown$/,
      'sparse-saves': /^You look at its page about every 1 d \(saves within 30 min count as one look\): too far apart to tell in time whether it dropped or went; look more often$/,
      'past-data': /^Listed at this price longer than your saves of scrap\.tf\/buy\/hats can follow \(fewer than 3 prices stayed listed that long\)$/,
      'stale-save': /^Your newest save of it is 20 h old; save the page again$/,
    };
    const n = { ...timing().n, drops: 3, dropCopies: 2, ended: 9, atRisk: 4 };
    for (const [why, re] of Object.entries(want)) {
      expect(timingWhyText(why as ScraptfTimingWhy, ctx({ n, lookGapMs: DAY + 3 * HOUR, lastSeenAt: NOW - 20 * HOUR })), why).toMatch(re);
    }
  });

  it("one copy repriced five times is five drops of one item: 'from only 1 item'", () => {
    const text = timingWhyText('few-drops', ctx({ n: { ...timing().n, drops: 5, dropCopies: 1 } }));
    expect(text).toBe('5 price drops in your saves of scrap.tf/buy/hats so far, but from only 1 item (5 drops from 3 items needed); keep saving it');
  });

  it('without a look gap, the sparse-saves reason still says what to do', () => {
    expect(timingWhyText('sparse-saves', ctx({ lookGapMs: null }))).toMatch(/too few or too far apart \(saves within 30 min count as one look\).*look more often$/);
  });

  it('every verdict reason has a phrase, and the estimate note says what the saves cannot see', () => {
    const all: ScraptfTimingWhy[] = ['drop-likely', 'drop-makes-flip', 'flip-now', 'gone-risk', 'over', 'no-buyers', 'stale-save', 'left-censored', 'few-drops', 'few-ended', 'few-at-risk', 'sparse-saves', 'past-data'];
    for (const why of all) expect(timingWhyText(why, ctx()).length, why).toBeGreaterThan(10);
    expect(TIMING_ESTIMATE_NOTE).toMatch(/^An estimate from your saves, not a forecast/);
    expect(TIMING_ESTIMATE_NOTE).toContain("'gone' can be a sale, a reservation or a move");
  });
});

describe("Health's asset-id lines (LC-5)", () => {
  it('stable, unstable and too few pairs, each counted between your looks', () => {
    const lines = assetIdsLines([
      { bank: 'hats', pairs: 418, same: 412, share: 412 / 418, stable: true },
      { bank: 'weapons', pairs: 400, same: 365, share: 365 / 400, stable: false },
      { bank: 'stranges', pairs: 12, same: 12, share: 1, stable: false },
    ]);
    expect(lines.map((l) => [l.text, l.tone])).toEqual([
      // Pairs, never items: one card seen on five looks in a row is four pairs (review fix).
      ['Hats: 412 of 418 pairs kept their item id between your looks (98.6 %): used to tell when the same item comes back', 'good'],
      ["Weapons: 365 of 400 pairs kept their item id between your looks (91.3 %): too unstable, so 'same item came back' is not shown", 'warn'],
      ['Stranges: 12 pairs so far (a single card on two looks in a row; 50 needed)', 'muted'],
    ]);
    for (const l of lines) expect(l.text).not.toMatch(/\bitems\b/);
    expect(assetIdsLines([{ bank: 'hats', pairs: 1, same: 1, share: 1, stable: false }])[0]!.text).toBe('Hats: 1 pair so far (a single card on two looks in a row; 50 needed)');
    expect(lines[0]!.title).toContain('two looks of its page at least 30 min apart; window reads within one look do not count');
  });

  it('nothing for an absent or empty list', () => {
    expect(assetIdsLines(undefined)).toEqual([]);
    expect(assetIdsLines([])).toEqual([]);
  });

  it("Health shows them in a 'scrap.tf saves' card after the key price, hidden without lines", () => {
    const page = readFileSync(new URL('../../src/renderer/pages/HealthPage.tsx', import.meta.url), 'utf8');
    expect(page.indexOf('<KeyPriceCard kp={h.keyPrice} now={now} />')).toBeLessThan(page.indexOf('<ScraptfSavesCard list={h.scraptfAssetIds} />'));
    expect(page.indexOf('<ScraptfSavesCard list={h.scraptfAssetIds} />')).toBeLessThan(page.indexOf('<RequestLog '));
    expect(page).toContain('<section className="card" aria-labelledby="h-stf">');
    expect(page).toContain('<h2 id="h-stf">scrap.tf saves</h2>');
    expect(page).toMatch(/const lines = assetIdsLines\(list\);\s*if \(lines\.length === 0\) return null;/);
  });
});
