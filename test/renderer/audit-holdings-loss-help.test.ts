// 0.7.3: Holdings' Loss help said the best exit "pays no more than the oldest unit cost you". Loss
// is profit after friction at or below zero, so with Friction per trade set, an exit that pays a
// little more than the cost (by less than the friction) is still Loss, and the Profit now tooltip
// contradicted its own "after … friction". The help now counts the friction. Pure; no network.

import { describe, expect, it } from 'vitest';
import { HOLDING_STATUS_HELP, holdingStatusTitle, profitNowTitle } from '../../src/renderer/holdingsModel';
import { holdingFigures } from '../../src/shared/holdings';

const KEY = 81;
const P = { minProfitScrap: 0, minProfitPctOfCost: 0, minMargin: 0, frictionScrap: 2 };

describe('Loss help with friction', () => {
  it("is Loss though the buyer pays more than the cost, and the help no longer says it doesn't", () => {
    const f = holdingFigures({ revenueScrap: 46, qty: 1, costScrap: 45, nextLotCostScrap: 45 }, P);
    expect(f).toMatchObject({ status: 'loss', profitNowScrap: -1 });
    expect(HOLDING_STATUS_HELP.loss).not.toContain('pays no more than the oldest unit cost you.');
    expect(HOLDING_STATUS_HELP.loss).toMatch(/friction/i);

    const t = profitNowTitle({ ...f, qty: 1 }, KEY, { frictionScrap: 2 });
    expect(t).toContain('after 0.22 ref friction');
    expect(t.endsWith(HOLDING_STATUS_HELP.loss)).toBe(true);
    expect(holdingStatusTitle({ status: 'loss' })).toBe(HOLDING_STATUS_HELP.loss);
  });

  it('still reads right without friction (exit equal to the cost)', () => {
    const f = holdingFigures({ revenueScrap: 45, qty: 1, costScrap: 45, nextLotCostScrap: 45 }, { ...P, frictionScrap: 0 });
    expect(f).toMatchObject({ status: 'loss', profitNowScrap: 0 });
    expect(HOLDING_STATUS_HELP.loss).toMatch(/no more than that unit cost you/);
  });
});
