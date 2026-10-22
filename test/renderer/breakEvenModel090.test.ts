// 0.9 (#2): the renderer's break-even texts and views (src/renderer/breakEvenModel.ts) and the drawer's Steam Market
// net line. Every number comes from the shared breakEvensOf / scmSellerNetCents; the texts say a break-even is a
// price to clear, never a forecast, and name no address. Pure: nothing leaves the process.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BREAK_EVEN_NOT_A_FORECAST,
  SCM_NET_TITLE,
  breakEvenText,
  breakEvenTitle,
  checkBreakEvenView,
  holdingBreakEvenTitle,
  inputBreakEvenView,
  oppCostTitle,
  quickBreakEvenView,
  scmNetView,
  venueBreakEvensText,
} from '../../src/renderer/breakEvenModel';
import { DASH } from '../../src/renderer/format';
import { breakEvensOf, type BreakEvenSettings } from '../../src/shared/ceiling';
import type { BreakEvens } from '../../src/shared/types';

const K = 567;
/** Friction 1 scrap, a 5% reserve, the default marketplace.tf fee. */
const P: BreakEvenSettings = { frictionScrap: 1, exitReservePct: 0.05, marketplaceFeePct: 0.1 };
const BARE: BreakEvenSettings = { frictionScrap: 0, exitReservePct: 0 };

const VENUES_107 =
  'Before their fees, a sale must bring in at least 13.22 ref on marketplace.tf (your 10% setting), 12.55 ref on mannco.store (5%) or 13.77 ref in Steam Wallet funds on the Steam Market (5% Steam and 10% TF2; each fee is at least $0.01, so items under about $0.20 need more).';

describe('0.9 (#2): breakEvenTitle', () => {
  it("'buy' with friction and the reserve names both, every exit and that it is no forecast", () => {
    expect(breakEvenTitle(breakEvensOf(100, P, 'buy'), K)).toBe(
      `Break-even 11.88 ref: the lowest backpack.tf sale price that loses nothing at this cost (11.11 ref plus friction 0.11 ref and the 5% price-move reserve 0.66 ref). ${VENUES_107} A price to clear, never a forecast that a buyer pays it.`,
    );
  });

  it("'buy' with neither names only the cost", () => {
    expect(breakEvenTitle(breakEvensOf(100, BARE, 'buy'), K)).toBe(
      'Break-even 11.11 ref: the lowest backpack.tf sale price that loses nothing at this cost (11.11 ref). Before their fees, a sale must bring in at least 12.44 ref on marketplace.tf (your 10% setting), 11.77 ref on mannco.store (5%) or 12.77 ref in Steam Wallet funds on the Steam Market (5% Steam and 10% TF2; each fee is at least $0.01, so items under about $0.20 need more). A price to clear, never a forecast that a buyer pays it.',
    );
  });

  it("'sell' is the oldest unit's, friction only (never the reserve)", () => {
    expect(breakEvenTitle(breakEvensOf(100, P, 'sell'), K)).toBe(
      'Break-even 11.22 ref: the lowest backpack.tf sale price that loses nothing on the oldest unit (it cost 11.11 ref plus friction 0.11 ref). Before their fees, a sale must bring in at least 12.55 ref on marketplace.tf (your 10% setting), 11.88 ref on mannco.store (5%) or 13.00 ref in Steam Wallet funds on the Steam Market (5% Steam and 10% TF2; each fee is at least $0.01, so items under about $0.20 need more). A price to clear, never a forecast that a buyer pays it.',
    );
  });

  it('`estimate` says the cost is a rule estimate, before the venues', () => {
    expect(breakEvenTitle(breakEvensOf(100, P, 'buy'), K, { estimate: true })).toBe(
      `Break-even 11.88 ref: the lowest backpack.tf sale price that loses nothing at this cost (11.11 ref plus friction 0.11 ref and the 5% price-move reserve 0.66 ref). The cost is a rule estimate: check the real price on scrap.tf. ${VENUES_107} A price to clear, never a forecast that a buyer pays it.`,
    );
  });

  it('names your marketplace.tf setting, and is undefined without a break-even', () => {
    const b = breakEvensOf(100, { ...P, marketplaceFeePct: 0.15 }, 'buy')!;
    expect(venueBreakEvensText(b, K)).toContain('on marketplace.tf (your 15% setting)');
    expect(breakEvenTitle(null, K)).toBeUndefined();
    expect(breakEvenTitle(undefined, K)).toBeUndefined();
    expect(breakEvenText(b, K)).toBe('11.88 ref');
    expect(breakEvenText(null, K)).toBe(DASH);
  });
});

describe('0.9 (#2): the surfaces', () => {
  it("oppCostTitle: the keyed entry first, then the 'buy' break-even; the entry alone without settings", () => {
    const keyed = { costScrap: 600, costKeys: 1, costScrapRaw: 33, inputKind: 'user' as const };
    const both = oppCostTitle(keyed, K, P)!;
    expect(both.startsWith('Entered as 1 key 3.66 ref (66.66 ref at the current key price). Break-even 1 key 7.33 ref: ')).toBe(true);
    expect(both).toBe(`Entered as 1 key 3.66 ref (66.66 ref at the current key price). ${breakEvenTitle(breakEvensOf(600, P, 'buy'), K)}`);
    expect(oppCostTitle(keyed, K, null)).toBe('Entered as 1 key 3.66 ref (66.66 ref at the current key price).');
    const plain = { costScrap: 100, costKeys: 0, costScrapRaw: 100, inputKind: 'user' as const };
    expect(oppCostTitle(plain, K, P)).toBe(breakEvenTitle(breakEvensOf(100, P, 'buy'), K));
    expect(oppCostTitle(plain, K, null)).toBeUndefined();
    // A rule row says its cost is an estimate.
    expect(oppCostTitle({ ...plain, inputKind: 'rule' }, K, P)).toContain('The cost is a rule estimate');
  });

  it("holdingBreakEvenTitle uses 'sell' on the oldest unit; nothing without settings", () => {
    expect(holdingBreakEvenTitle({ nextLotCostScrap: 100 }, K, P)).toBe(breakEvenTitle(breakEvensOf(100, P, 'sell'), K));
    expect(holdingBreakEvenTitle({ nextLotCostScrap: 100 }, K, P)).toContain('on the oldest unit');
    expect(holdingBreakEvenTitle({ nextLotCostScrap: 100 }, K, P)).not.toContain('price-move reserve');
    expect(holdingBreakEvenTitle({ nextLotCostScrap: 100 }, K, null)).toBeUndefined();
  });

  it("quickBreakEvenView and inputBreakEvenView give the 'buy' break-even and its hover", () => {
    expect(quickBreakEvenView(null, P, K)).toBeNull();
    expect(quickBreakEvenView(100, P, K)).toEqual({ scrap: 107, title: breakEvenTitle(breakEvensOf(100, P, 'buy'), K) });
    expect(inputBreakEvenView({ costScrap: 100, inputKind: 'user' }, P, K)).toEqual({ scrap: 107, title: breakEvenTitle(breakEvensOf(100, P, 'buy'), K) });
    expect(inputBreakEvenView({ costScrap: 100, inputKind: 'rule' }, P, K)!.title).toContain('The cost is a rule estimate');
  });

  it("checkBreakEvenView reads CheckResult.breakEven at the result's key price; null without one", () => {
    const b: BreakEvens = breakEvensOf(15, { frictionScrap: 1, exitReservePct: 0.05 }, 'buy')!;
    expect(b.backpackScrap).toBe(17);
    const v = checkBreakEvenView({ keyScrap: K, breakEven: b })!;
    expect(v.text).toBe('break-even 1.88 ref');
    expect(v.title).toBe(breakEvenTitle(b, K));
    expect(checkBreakEvenView({ keyScrap: K })).toBeNull();
    // No key price: the money is shown in ref only.
    expect(checkBreakEvenView({ keyScrap: null, breakEven: breakEvensOf(600, P, 'buy')! })!.text).toMatch(/^break-even [\d.,]+ ref$/);
  });
});

describe("0.9 (#2): the drawer's Steam Market net line (scmNetView)", () => {
  it('says what the seller receives at the lowest and the median, exact to the cent', () => {
    expect(scmNetView({ lowest: '$2.21', median: '$2.26' })).toEqual({
      text: 'You get $1.93 of the $2.21 lowest (Steam and TF2 keep $0.28, 12.7%) and $1.98 of the $2.26 median, in Steam Wallet funds, not cash.',
      title: SCM_NET_TITLE,
    });
    expect(scmNetView({ lowest: '$0.07', median: null })!.text).toBe('You get $0.05 of the $0.07 lowest (Steam and TF2 keep $0.02, 28.6%), in Steam Wallet funds, not cash.');
  });

  it('only readable prices of 3 cents or more; the median alone; the mock-style text without "$"', () => {
    expect(scmNetView({ lowest: '$0.02', median: null })).toBeNull();
    expect(scmNetView({ lowest: null, median: null })).toBeNull();
    expect(scmNetView(null)).toBeNull();
    expect(scmNetView(undefined)).toBeNull();
    expect(scmNetView({ lowest: '€2,21', median: null })).toBeNull();
    expect(scmNetView({ lowest: null, median: '$1.15' })!.text).toBe('You get $1.00 of the $1.15 median (Steam and TF2 keep $0.15, 13.0%), in Steam Wallet funds, not cash.');
    expect(scmNetView({ lowest: '2.21', median: null })!.text).toBe('You get $1.93 of the $2.21 lowest (Steam and TF2 keep $0.28, 12.7%), in Steam Wallet funds, not cash.');
  });

  it('its hover says it is from the prices Steam showed, not a sale', () => {
    expect(SCM_NET_TITLE).toContain('From the prices Steam showed, not a sale.');
  });
});

describe('0.9 (#2): honest and local', () => {
  it('no text names an address; each break-even hover ends with the not-a-forecast sentence', () => {
    const texts = [
      breakEvenTitle(breakEvensOf(100, P, 'buy'), K)!,
      breakEvenTitle(breakEvensOf(100, P, 'sell'), K)!,
      breakEvenTitle(breakEvensOf(100, P, 'buy'), K, { estimate: true })!,
      oppCostTitle({ costScrap: 600, costKeys: 1, costScrapRaw: 33, inputKind: 'rule' }, K, P)!,
      scmNetView({ lowest: '$2.21', median: '$2.26' })!.text,
      SCM_NET_TITLE,
      BREAK_EVEN_NOT_A_FORECAST,
    ];
    for (const t of texts) expect(t).not.toContain('://');
    for (const t of texts.slice(0, 4)) expect(t.endsWith(BREAK_EVEN_NOT_A_FORECAST)).toBe(true);
  });

  it('the model never reads `.frictionScrap` (D7: profitPath rule (1))', () => {
    // Comments stripped, as profitPath.test.ts reads src/ (the model's D7 comment names the rule).
    const src = readFileSync(new URL('../../src/renderer/breakEvenModel.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/\.frictionScrap\b/);
    expect(src).toContain('frictionScrap: friction');
  });
});
