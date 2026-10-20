// Audit livecheck-4: an 'import' price is any scrap.tf page the import read, a saved file or (F21, 0.7)
// a read in the opt-in scrap.tf window; the check cannot tell which. The price-line tooltip, the disabled
// Save price and main's "Flip:" notification must not say the user saved a page they may never have saved.

import { describe, expect, it } from 'vitest';
import { flipNotification } from '../../src/main/liveCheck';
import { CHECK_PRICE_SOURCE_LABELS, checkActions, checkPriceLine } from '../../src/renderer/checkModel';
import { mockCheckDemo } from '../../src/renderer/mockCheck';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckPriceSource, CheckResult } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const K = 540;

function withPrice(source: CheckPriceSource): CheckResult {
  const flip = mockCheckDemo('flip', NOW, K, DEFAULT_SETTINGS);
  return { ...flip, reason: null, checkedAt: NOW, price: { ...flip.price!, source, observedAt: NOW - 60_000 } };
}

describe('an imported price is worded as imported, not as a page the user saved', () => {
  it('price-line tooltip', () => {
    const line = checkPriceLine(withPrice('import'), NOW);
    expect(line.title).not.toContain('a page you saved');
    expect(line.title).toContain('Flip Desk window');
    expect(line.source).toMatch(/^imported page/);
  });

  it('disabled Save price', () => {
    const save = checkActions(withPrice('import')).save;
    expect(save).toEqual({ enabled: false, title: 'This price is already in your price sheet, from a scrap.tf page you imported.' });
    expect(save.title).not.toContain('you saved');
  });

  it('the "Flip:" notification, with the popup\'s own label', () => {
    const body = flipNotification(withPrice('import'))!.body;
    expect(body).toContain('(imported page)');
    expect(body).not.toContain('saved page');
    expect(body).toContain(`(${CHECK_PRICE_SOURCE_LABELS.import})`);
  });

  it('leaves the other sources as they were', () => {
    expect(flipNotification(withPrice('list'))!.body).toContain('(saved list)');
    expect(flipNotification(withPrice('typed'))!.body).toContain('(your price)');
    expect(flipNotification(withPrice('clipboard'))!.body).toContain('(copied)');
    expect(checkActions(withPrice('typed')).save.title).toBe('This is already your saved price.');
  });
});
