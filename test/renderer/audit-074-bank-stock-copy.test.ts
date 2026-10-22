// 0.7.4 (F66): a Bank stock row opens the item panel on its own copy. Its key is `${sku}|${specialKey}`
// (bankStockKey), and the special key is the form Opportunity.copyKey has (opportunityCopyKey), so a painted or
// kit-sheen copy's panel shows that copy's scrap.tf history, as a click on its Opportunities row does.

import { describe, expect, it } from 'vitest';
import { bankStockRowCopyKey } from '../../src/renderer/bankStockModel';
import { bankStockKey, bankStockSpecialKey } from '../../src/shared/bankStock';
import { opportunityCopyKey } from '../../src/shared/copyExtras';

describe('bankStockRowCopyKey (F66)', () => {
  it("gives a copy with extras its special key, the one its opportunity's copyKey has", () => {
    const painted = bankStockSpecialKey({ paint: 3100495 });
    expect(bankStockRowCopyKey({ key: bankStockKey('378;6', painted) })).toBe(painted);
    expect(bankStockRowCopyKey({ key: bankStockKey('378;6', painted) })).toBe(opportunityCopyKey('378;6;p3100495', null));
    const kit = bankStockSpecialKey({ sheen: 1, killstreaker: 2002 });
    expect(bankStockRowCopyKey({ key: bankStockKey('6526;6;uncraftable;kt-3;td-205', kit) })).toBe(kit);
  });

  it('opens a plain copy, or a key it cannot read, on the item itself', () => {
    expect(bankStockRowCopyKey({ key: bankStockKey('378;6', bankStockSpecialKey(null)) })).toBeNull();
    expect(bankStockRowCopyKey({ key: '378;6|' })).toBeNull();
    expect(bankStockRowCopyKey({ key: '378;6|not json' })).toBeNull();
    expect(bankStockRowCopyKey({ key: '378;6' })).toBeNull();
  });
});
