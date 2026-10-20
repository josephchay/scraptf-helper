// Settings → Notifications, "Notify when something you hold can be sold at a profit": since F14 a held
// item whose better exit is scrap.tf's bank (a fresh, not-full row of the saved price list) notifies
// too, and notifications.minConfidence gates only backpack.tf buyers (holdings.ts; pinned by
// test/domain/holdingsScraptfList.test.ts "tells it whatever minConfidence says"). The hint says so.

import { describe, expect, it } from 'vitest';
import { holdingsNotifyHint } from '../../src/renderer/settingsFields';

describe('the holdings sell alert hint names both exits and scopes the confidence gate', () => {
  const on = holdingsNotifyHint(true);

  it("names scrap.tf's bank as an exit next to backpack.tf buyers", () => {
    expect(on).toMatch(/backpack\.tf buyer/);
    expect(on).toMatch(/scrap\.tf's bank/);
    // bestExitOf takes the list only when it was saved in the last 24 h and the bank is not full.
    expect(on).toMatch(/in the last day/);
    expect(on).toMatch(/not full/);
  });

  it('says the minimum confidence applies to backpack.tf buyers only', () => {
    expect(on).toMatch(/minimum confidence for backpack\.tf buyers only/);
    expect(on).toMatch(/does not hold back a scrap\.tf sale/);
    expect(on).not.toMatch(/Uses the minimum confidence and repeat time above/);
  });

  it('keeps the thresholds and repeat time, and says nothing about being off while notifications are on', () => {
    expect(on).toMatch(/clear your profit thresholds/);
    expect(on).toMatch(/repeat time/);
    expect(on).not.toMatch(/off/);
  });

  it('with notifications off, says so first and then the same text', () => {
    const off = holdingsNotifyHint(false);
    expect(off).toMatch(/^Desktop notifications are off/);
    expect(off.endsWith(on)).toBe(true);
  });
});
