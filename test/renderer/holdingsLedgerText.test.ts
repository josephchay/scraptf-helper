// 0.9 (#1, #17): the Holdings texts of the trade lock, the trend size and the key move band. The new advice reasons
// (trade-locked, units-locked, trend-size, key-exposure with a band) say what was seen with their dates and n, never a
// forecast; keyBandText sorts the profit range and names the overlapping spans, both dates and the separate weeks;
// the Held for hover, the drawer's lot lines, the Trade lock answers and cautions, Sellable now's hover and the page's
// refetch time follow the user's 7-day lock. Pure; no network.

import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDateTime, fmtSignedMoney } from '../../src/renderer/format';
import { holdingLotLines } from '../../src/renderer/holdingDetailModel';
import {
  ADVICE_HELP,
  ADVICE_LABELS,
  SELLABLE_TITLE,
  TRADE_LOCK_CARD_ORDER,
  TRADE_LOCK_HELP,
  TRADE_LOCK_LABELS,
  TRADE_LOCK_TITLES,
  adviceReasonText,
  heldForTitle,
  holdingsLapseAt,
  keyBandText,
  scraptfExitLapseAt,
  sellableTitle,
  tradeLockAnsweredText,
  tradeLockCautionOn,
  tradeLockDrawerCaution,
  tradeLockLapseAt,
  tradeLockSetToast,
} from '../../src/renderer/holdingsModel';
import { TRADE_LOCK_MS, keyMoveBandOf } from '../../src/shared/holdingAdvice';
import { SCRAPTF_LIST_FRESH_MS } from '../../src/shared/scraptfList';
import { TRADE_LOCK_MODES, type HistoryPoint, type HoldingAdviceReason, type JournalLot, type KeyMoveBand } from '../../src/shared/types';

// Local noon, so dates do not depend on the machine's time zone.
const T0 = new Date(2026, 9, 22, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEY = 568;

const T = 1791969123;
const DAY_S = 86_400;
/** `n` daily points ending at T, the d-th (oldest first) at value(d) (the plan's key band vectors). */
const daily = (n: number, value: (d: number) => number): HistoryPoint[] => Array.from({ length: n }, (_, d) => ({ t: T - (n - 1 - d) * DAY_S, buyScrap: value(d), sellScrap: null }));

describe('the new advice reasons in words', () => {
  it('trade-locked: the tradable date, how long until then, the logged buy and what today alone would say', () => {
    const r: HoldingAdviceReason = { code: 'trade-locked', tradableAt: T0 + 3 * DAY, boughtAt: T0 - 4 * DAY, todayKind: 'sell-now' };
    expect(adviceReasonText(r, KEY, T0)).toBe(
      `Tradable from ${fmtDateTime(T0 + 3 * DAY)} (in 3 d): 7 days after the buy you logged on ${fmtDateTime(T0 - 4 * DAY)}, by your Trade lock setting. Today's book alone would say: Sell now.`,
    );
    expect(adviceReasonText({ ...r, todayKind: 'hold' }, KEY, T0)).toContain(`Today's book alone would say: ${ADVICE_LABELS.hold}.`);
  });

  it('units-locked: how many of the units, and when the first becomes tradable', () => {
    expect(adviceReasonText({ code: 'units-locked', lockedQty: 2, qty: 3, firstTradableAt: T0 + DAY }, KEY, T0)).toBe(
      `2 of your 3 units are still inside your 7-day Trade lock; the first becomes tradable ${fmtDateTime(T0 + DAY)}.`,
    );
    expect(adviceReasonText({ code: 'units-locked', lockedQty: 1, qty: 2, firstTradableAt: T0 + DAY }, KEY, T0)).toContain('1 of your 2 units is still inside');
  });

  it('trend-size: a level line, and a moved one with its spread, points and dates (measured, not a forecast)', () => {
    const level: HoldingAdviceReason = { code: 'trend-size', changeScrap: 0, spreadScrap: 2, points: 6, fromAt: T0 - 3 * DAY, toAt: T0 };
    expect(adviceReasonText(level, KEY, T0)).toBe(
      `Between ${fmtDate(T0 - 3 * DAY)} and ${fmtDate(T0)} a line through 6 recorded exit stretches (Theil-Sen) stayed level; half of them sat within 0.22 ref of it.`,
    );
    const moved = adviceReasonText({ ...level, changeScrap: -50, spreadScrap: 0 }, KEY, T0);
    expect(moved).toBe(
      `Between ${fmtDate(T0 - 3 * DAY)} and ${fmtDate(T0)} a line through 6 recorded exit stretches (Theil-Sen) moved -5.55 ref; half of them sat within 0.00 ref of it. Measured, not a forecast.`,
    );
    expect(adviceReasonText({ ...level, changeScrap: 18 }, KEY, T0)).toContain('moved +2.00 ref');
  });

  it('key-exposure: the band sentence follows the key line only when the reason carries one', () => {
    const band: KeyMoveBand = { lowScrap: -9, highScrap: 18, spans: 30, fromAt: T0 - 36 * DAY, toAt: T0, loadedAt: T0 };
    const bare: HoldingAdviceReason = { code: 'key-exposure', netKeys: 2, boughtKeyScrap: KEY - 9, nowKeyScrap: KEY };
    const without = adviceReasonText(bare, KEY, T0);
    expect(without).not.toContain('PriceDB key history');
    expect(adviceReasonText({ ...bare, band }, KEY, T0)).toBe(`${without} ${keyBandText(band, 2)}`);
  });
});

describe('keyBandText', () => {
  const band: KeyMoveBand = { lowScrap: -9, highScrap: 18, spans: 30, fromAt: T0 - 36 * DAY, toAt: T0, loadedAt: T0 };

  it('gives the profit range netKeys x low to netKeys x high, sorted (a negative netKeys swaps them)', () => {
    expect(keyBandText(band, 2)).toContain(`would change this profit by ${fmtSignedMoney(-18, null)} to ${fmtSignedMoney(36, null)}.`);
    expect(keyBandText(band, -2)).toContain(`would change this profit by ${fmtSignedMoney(-36, null)} to ${fmtSignedMoney(18, null)}.`);
    // Half keys round to whole scrap, and never read as -0.
    expect(keyBandText({ ...band, lowScrap: 0, highScrap: 1 }, -0.4)).toContain(`by ${fmtSignedMoney(0, null)} to ${fmtSignedMoney(0, null)}.`);
    expect(keyBandText(band, 2)).toContain(`were between ${fmtSignedMoney(-9, null)} and ${fmtSignedMoney(18, null)};`);
  });

  it('for the 45-daily-point vector: 38 overlapping 7-day spans, both dates and about 6 separate weeks', () => {
    const b = keyMoveBandOf(daily(45, (d) => 600 + d), T * 1000)!;
    expect(b).toMatchObject({ lowScrap: 7, highScrap: 7, spans: 38 });
    const text = keyBandText(b, 1);
    expect(text).toContain('38 overlapping 7-day spans from');
    expect(text).toContain(`from ${fmtDate((T - 44 * DAY_S) * 1000)} to ${fmtDate(T * 1000)}`);
    expect(text).toContain('about 6 separate weeks');
    expect(text).toContain('the middle 8 in 10 of those 7-day key moves');
    expect(text).not.toMatch(/will|forecast that/i);
  });

  it('review fix: sparse points a week apart months earlier never stretch the dates or the separate weeks', () => {
    const pts = [{ t: T - 120 * DAY_S, buyScrap: 560, sellScrap: null }, { t: T - 113 * DAY_S, buyScrap: 590, sellScrap: null }, ...daily(35, (d) => 600 + d)];
    const text = keyBandText(keyMoveBandOf(pts, T * 1000)!, 1);
    expect(text).toContain(`28 overlapping 7-day spans from ${fmtDate((T - 34 * DAY_S) * 1000)} to ${fmtDate(T * 1000)}`);
    expect(text).toContain('about 4 separate weeks');
  });

  it('says "week" for a single week', () => {
    expect(keyBandText({ ...band, fromAt: T0 - 8 * DAY }, 1)).toContain('about 1 separate week)');
  });
});

describe('Locked advice and the Held for hover', () => {
  it("ADVICE_HELP.locked names the user's setting and says nothing about the unlock day", () => {
    expect(ADVICE_LABELS.locked).toBe('Locked');
    expect(ADVICE_HELP.locked).toContain('Your Trade lock setting says');
    expect(ADVICE_HELP.locked).toContain('they say nothing about the day it unlocks');
  });

  it('adds when the next unit becomes tradable, and how many units are locked when more than one', () => {
    const r = { heldSince: T0 - 2 * DAY, qty: 3 };
    expect(heldForTitle(r)).toBe(`Oldest unit bought ${fmtDateTime(T0 - 2 * DAY)}`);
    const one = heldForTitle({ ...r, tradeLock: { lockedQty: 1, nextLotTradableAt: T0 + 5 * DAY, firstTradableAt: T0 + 5 * DAY } });
    expect(one).toBe(`Oldest unit bought ${fmtDateTime(T0 - 2 * DAY)}. Tradable from ${fmtDateTime(T0 + 5 * DAY)} (your 7-day Trade lock, from the buy you logged).`);
    const three = heldForTitle({ ...r, tradeLock: { lockedQty: 3, nextLotTradableAt: T0 + 5 * DAY, firstTradableAt: T0 + 5 * DAY } });
    expect(three).toContain('(your 7-day Trade lock, from the buy you logged). 3 of 3 units are locked.');
  });

  it('with only later units locked, says how many and when the first is tradable', () => {
    const later = heldForTitle({ heldSince: T0 - 9 * DAY, qty: 3, tradeLock: { lockedQty: 1, nextLotTradableAt: null, firstTradableAt: T0 + DAY } });
    expect(later).toBe(`Oldest unit bought ${fmtDateTime(T0 - 9 * DAY)}. 1 of 3 units is still locked; the first is tradable from ${fmtDateTime(T0 + DAY)}.`);
    const two = heldForTitle({ heldSince: T0 - 9 * DAY, qty: 3, tradeLock: { lockedQty: 2, nextLotTradableAt: null, firstTradableAt: T0 + DAY } });
    expect(two).toContain('2 of 3 units are still locked;');
  });

  it('keeps the typical hold sentence before the lock', () => {
    const typical = { scope: 'item' as const, medianMs: 2 * DAY, count: 3, stillHeld: 0 };
    const t = heldForTitle({ heldSince: T0 - DAY, qty: 1, typicalHold: typical, tradeLock: { lockedQty: 1, nextLotTradableAt: T0 + 6 * DAY, firstTradableAt: T0 + 6 * DAY } })!;
    expect(t.indexOf('Your sales of this item')).toBeLessThan(t.indexOf('Tradable from'));
    expect(t).not.toContain('..');
  });
});

describe("the drawer's lot lines", () => {
  const lots: JournalLot[] = [
    { id: 1, ts: T0 - 9 * DAY, costScrap: 40, keys: 0, scrap: 40, keyPriceScrap: KEY },
    { id: 2, ts: T0 - 2 * DAY, costScrap: 40, keys: 0, scrap: 40, keyPriceScrap: KEY },
  ];

  it("with '7d', a lot still inside the lock says when it becomes tradable; an older one does not", () => {
    const lines = holdingLotLines(lots, KEY, T0, '7d');
    expect(lines[0]).not.toContain('tradable');
    expect(lines[1]).toMatch(new RegExp(` · tradable ${fmtDateTime(T0 + 5 * DAY).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });

  it('with any other mode (and by default) the lines are as in 0.8', () => {
    const plain = holdingLotLines(lots, KEY, T0);
    expect(holdingLotLines(lots, KEY, T0, 'none')).toEqual(plain);
    expect(holdingLotLines(lots, KEY, T0, 'unknown')).toEqual(plain);
    expect(plain.some((l) => l.includes('tradable'))).toBe(false);
  });

  it('a lot exactly 7 days old is tradable (no date)', () => {
    expect(holdingLotLines([{ ...lots[0]!, ts: T0 - TRADE_LOCK_MS }], KEY, T0, '7d')[0]).not.toContain('tradable');
  });
});

describe('the Trade lock answers and cautions', () => {
  it('has a label, a hover and a Settings hint per mode; the card asks 7-day first', () => {
    for (const m of TRADE_LOCK_MODES) {
      expect(TRADE_LOCK_LABELS[m].length).toBeGreaterThan(0);
      expect(TRADE_LOCK_TITLES[m].length).toBeGreaterThan(0);
    }
    expect(TRADE_LOCK_LABELS).toEqual({ unknown: 'Not sure', none: 'No lock', '7d': '7-day lock' });
    expect(TRADE_LOCK_CARD_ORDER).toEqual(['7d', 'none', 'unknown']);
    expect(TRADE_LOCK_HELP.unknown).toBe('Not sure: Holdings shows a one-line caution and changes nothing else.');
    expect(TRADE_LOCK_HELP.none).toBe('No lock: every unit you hold counts as tradable now, as before.');
    expect(TRADE_LOCK_HELP['7d']).toContain('7 days after its buy time in your journal');
    expect(TRADE_LOCK_HELP['7d']).toContain('Prices and profits are unchanged.');
  });

  it('says when it was answered, or that Holdings asks until then; the toast names the answer', () => {
    expect(tradeLockAnsweredText(null)).toBe('Not answered yet: Holdings asks until you choose.');
    expect(tradeLockAnsweredText(T0)).toBe(`Answered ${fmtDateTime(T0)}.`);
    expect(tradeLockSetToast('7d')).toBe('Trade lock set to 7-day lock. Change it in Settings → Trade lock.');
  });

  it("the drawer's caution: a unit bought 6 days ago gets a dated line, 8 days ago none", () => {
    expect(tradeLockDrawerCaution(T0 - 6 * DAY, T0)).toBe(
      `Bought ${fmtDateTime(T0 - 6 * DAY)}: if Steam's 7-day Trade Protection covers TF2 for you, it is tradable from ${fmtDateTime(T0 + DAY)}. Set Trade lock in Settings.`,
    );
    expect(tradeLockDrawerCaution(T0 - 8 * DAY, T0)).toBeNull();
    expect(tradeLockDrawerCaution(T0 - TRADE_LOCK_MS, T0)).toBeNull();
    expect(tradeLockDrawerCaution(0, T0)).toBeNull();
  });

  it('the Not sure caution shows only once the user answered Not sure', () => {
    expect(tradeLockCautionOn({ tradeLock: { mode: 'unknown', answeredAt: null } })).toBe(false);
    expect(tradeLockCautionOn({ tradeLock: { mode: 'unknown', answeredAt: T0 } })).toBe(true);
    expect(tradeLockCautionOn({ tradeLock: { mode: '7d', answeredAt: T0 } })).toBe(false);
    expect(tradeLockCautionOn({ tradeLock: { mode: 'none', answeredAt: T0 } })).toBe(false);
    expect(tradeLockCautionOn(null)).toBe(false);
  });
});

describe("Sellable now's hover and the page's refetch time", () => {
  it('sellableTitle is the 0.8 hover without locked items, and names the locked ones', () => {
    expect(SELLABLE_TITLE).toBe("Items whose oldest unit clears your profit thresholds at its better exit: today's best buyer, or scrap.tf by your saved price list");
    expect(sellableTitle({})).toBe(SELLABLE_TITLE);
    expect(sellableTitle({ locked: 0 })).toBe(SELLABLE_TITLE);
    expect(sellableTitle({ locked: 1 })).toBe(`${SELLABLE_TITLE}. 1 item whose oldest unit is still inside your 7-day Trade lock is not counted.`);
    expect(sellableTitle({ locked: 3 })).toBe(`${SELLABLE_TITLE}. 3 items whose oldest unit is still inside your 7-day Trade lock are not counted.`);
  });

  it('tradeLockLapseAt: 1 ms after the earliest unlock; null without a lock', () => {
    const a = { tradeLock: { lockedQty: 1, nextLotTradableAt: T0 + 2 * DAY, firstTradableAt: T0 + 2 * DAY } };
    const b = { tradeLock: { lockedQty: 2, nextLotTradableAt: null, firstTradableAt: T0 + DAY } };
    expect(tradeLockLapseAt([a, b, {}])).toBe(T0 + DAY + 1);
    expect(tradeLockLapseAt([{}])).toBeNull();
    expect(tradeLockLapseAt([])).toBeNull();
  });

  it('holdingsLapseAt: the earlier of the scrap.tf lapse and the lock lapse', () => {
    const listAt = T0 - 23 * HOUR;
    const scraptf = { bestExit: 'scraptf' as const, scraptfListAt: listAt };
    const lapse = scraptfExitLapseAt([scraptf])!;
    expect(lapse).toBe(listAt + SCRAPTF_LIST_FRESH_MS + 1);
    const soon = { tradeLock: { lockedQty: 1, nextLotTradableAt: T0 + HOUR / 2, firstTradableAt: T0 + HOUR / 2 } };
    const late = { tradeLock: { lockedQty: 1, nextLotTradableAt: T0 + 3 * DAY, firstTradableAt: T0 + 3 * DAY } };
    expect(holdingsLapseAt([scraptf, late])).toBe(lapse);
    expect(holdingsLapseAt([scraptf, soon])).toBe(T0 + HOUR / 2 + 1);
    expect(holdingsLapseAt([late])).toBe(T0 + 3 * DAY + 1);
    expect(holdingsLapseAt([scraptf])).toBe(lapse);
    expect(holdingsLapseAt([{}])).toBeNull();
  });
});
