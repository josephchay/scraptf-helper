// 0.9 (RESEARCH #9): where the dashboard shows the checkout guard (checkoutGuardModel.ts and timingBadge): the Live
// check popup's line only on a flip, the drawer's list only under a Buy now verdict, the Shopping list's line, and the
// Buy now tag's title ending with CHECKOUT_GUARD_TAG (a Wait tag never carries it). Pure; nothing here opens anything.

import { describe, expect, it } from 'vitest';
import { checkGuardLine, shoppingGuardLine, timingGuardShown } from '../../src/renderer/checkoutGuardModel';
import { timingBadge } from '../../src/renderer/timingModel';
import { CHECKOUT_GUARD_POPUP, CHECKOUT_GUARD_SHORT, CHECKOUT_GUARD_TAG, checkoutGuardTitle } from '../../src/shared/checkoutGuard';
import { scraptfTimingBrief } from '../../src/shared/scraptfTiming';
import type { CheckStatus, CheckVerdict, ScraptfBuyTiming, ScraptfTimingVerdict } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A whole verdict as scraptfBuyTimingOf returns it (timingModel.test.ts's shape). */
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

describe('0.9 (#9): checkGuardLine (the Live check popup)', () => {
  it('returns the guard line only for an item whose verdict is a flip', () => {
    expect(checkGuardLine({ status: 'item', verdict: 'flip' })).toEqual({ text: CHECKOUT_GUARD_POPUP, title: checkoutGuardTitle() });
    const others: { status: CheckStatus; verdict: CheckVerdict | null }[] = [
      { status: 'item', verdict: 'over' },
      { status: 'item', verdict: 'no-buyers' },
      { status: 'item', verdict: 'no-price' },
      { status: 'item', verdict: null },
      { status: 'not-item', verdict: null },
      { status: 'not-item', verdict: 'flip' },
      { status: 'refused', verdict: null },
    ];
    for (const r of others) expect(checkGuardLine(r), JSON.stringify(r)).toBeNull();
    expect(checkGuardLine(null)).toBeNull();
    expect(checkGuardLine(undefined)).toBeNull();
  });
});

describe('0.9 (#9): timingGuardShown (the drawer)', () => {
  it('is true only under a Buy now verdict', () => {
    const verdicts: ScraptfTimingVerdict[] = ['wait', 'buy-now', 'over', 'no-buyers', 'not-enough-data'];
    expect(verdicts.filter((v) => timingGuardShown({ verdict: v }))).toEqual(['buy-now']);
    expect(timingGuardShown(null)).toBe(false);
    expect(timingGuardShown(undefined)).toBe(false);
  });
});

describe('0.9 (#9): shoppingGuardLine (the Shopping list)', () => {
  it('is the one-line guard with the full guard in its title', () => {
    expect(shoppingGuardLine()).toEqual({ text: CHECKOUT_GUARD_SHORT, title: checkoutGuardTitle() });
  });
});

describe('0.9 (#9): the Buy now tag carries the guard; a Wait tag does not', () => {
  it('ends a Buy now title with CHECKOUT_GUARD_TAG, for both Buy now reasons', () => {
    for (const why of ['gone-risk', 'flip-now'] as const) {
      const b = timingBadge(brief({ verdict: 'buy-now', why, horizonMs: 6 * HOUR }), NOW)!;
      expect(b.text).toBe('Buy now');
      expect(b.title.endsWith(CHECKOUT_GUARD_TAG)).toBe(true);
      // The lead still comes first.
      expect(b.title.indexOf('Your saves suggest buying now')).toBe(0);
    }
    // With the key price too (Live market, Opportunities).
    expect(timingBadge(brief({ verdict: 'buy-now', why: 'gone-risk' }), NOW, 568)!.title.endsWith(CHECKOUT_GUARD_TAG)).toBe(true);
  });

  it('never adds it to a Wait tag', () => {
    const w = timingBadge(brief(), NOW)!;
    expect(w.text).toBe('Wait ~1 d');
    expect(w.title).not.toContain(CHECKOUT_GUARD_TAG);
    expect(w.title).not.toContain('Before you buy');
  });
});
