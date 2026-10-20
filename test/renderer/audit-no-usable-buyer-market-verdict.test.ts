// 0.7.3 (r4-wording-4): a Live market row with eligible buyers but no revenue (every order an outlier, or
// Revenue used for profit on Instant and no realistic bot order) has no Pay up to, so marketVerdict makes it
// Over (with a price of yours) or Not checked (without one). Its verdict pill said "Buyers exist, but no
// scrap.tf price clears your thresholds against them." / "... and no price clears your thresholds against
// these buyers.", while its Sells for and Pay up to hovers already said none of the buyers is usable. The
// pill now says why too, from the row's own flags (noRevenueReason). Pure. No network.

import { describe, expect, it } from 'vitest';
import { VERDICT_HELP, marketPayTitle, verdictPill } from '../../src/renderer/marketModel';
import { marketVerdict } from '../../src/shared/market';
import type { MarketRow } from '../../src/shared/types';

const K = 568;

type PillRow = Parameters<typeof verdictPill>[0];

/** Three human buyers, none usable: no revenue and no ceiling. */
function row(flags: string[], over: Partial<MarketRow> = {}): PillRow {
  const base = { revenueScrap: null, buyerCount: 3, flags, maxCostScrap: null, knownCostScrap: null, ruleCostScrap: null, profitScrap: null, ...over };
  return { ...base, verdict: marketVerdict(base) };
}

describe('Live market verdict pill without a usable buyer', () => {
  it('is Over with a price of yours, and says why there is no Pay up to', () => {
    const instant = row([], { knownCostScrap: 100 });
    expect(instant.verdict).toBe('over');
    expect(verdictPill(instant, K)).toEqual({
      tone: 'bad',
      text: 'Over',
      title:
        'Buyers exist, but no eligible order is a realistic bot order, and Revenue used for profit is Instant (bot orders only), so no revenue is assumed and there is no Pay up to to judge your scrap.tf price against.',
    });
    expect(verdictPill(row(['all-outliers'], { knownCostScrap: 100 }), K).title).toBe(
      'Buyers exist, but every eligible order looks unrealistic, so no revenue is assumed and there is no Pay up to to judge your scrap.tf price against.',
    );
  });

  it('is Not checked without one, and says the same', () => {
    const instant = row([]);
    expect(instant.verdict).toBe('unchecked');
    expect(verdictPill(instant, K)).toMatchObject({ tone: 'muted', text: 'Not checked' });
    expect(verdictPill(instant, K).title).toBe(
      'No scrap.tf price of yours, and no eligible order is a realistic bot order, and Revenue used for profit is Instant (bot orders only), so no revenue is assumed and there is no Pay up to.',
    );
    expect(verdictPill(row(['all-outliers']), K).title).toBe('No scrap.tf price of yours, and every eligible order looks unrealistic, so no revenue is assumed and there is no Pay up to.');
  });

  it('never says no price clears your thresholds then, unlike the Pay up to hover with a revenue', () => {
    for (const flags of [[], ['all-outliers']]) {
      for (const over of [{ knownCostScrap: 100 }, {}]) {
        const t = verdictPill(row(flags, over), K).title;
        expect(t).not.toContain('clears your thresholds');
        expect(marketPayTitle(row(flags, over), K)).toContain('so there is no ceiling');
      }
    }
  });

  it('is unchanged with a revenue that no price clears', () => {
    expect(verdictPill(row([], { revenueScrap: 110, knownCostScrap: 100 }), K).title).toBe('Buyers exist, but no scrap.tf price clears your thresholds against them.');
    expect(verdictPill(row([], { revenueScrap: 110 }), K).title).toBe('No scrap.tf price of yours, and no price clears your thresholds against these buyers.');
  });

  it("the Over chip's help names that case too", () => {
    expect(VERDICT_HELP.over).toContain('none of them is usable');
  });
});
