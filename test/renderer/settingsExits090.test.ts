// 0.9 (#2): the marketplace.tf fee setting (profit.marketplaceFeePct). The key, its default and its zod are
// Foundation's; this pins the Settings field: its bounds match what main accepts, a 0.8 file reads the default
// unreported, and the field sits in the Profit thresholds grid with its hint. Nothing leaves the process.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_FEE_HINT, MARKETPLACE_FEE_PCT, numberValidator, pctTextToRatio, ratioToPctText } from '../../src/renderer/settingsFields';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { applySettingsPatch, parseSettingsWithReport } from '../../src/shared/settingsSchema';
import type { Settings } from '../../src/shared/types';
import { MARKETPLACE_FEE_DEFAULT, MARKETPLACE_FEE_MAX } from '../../src/shared/venues';

const clone = (): Settings => structuredClone(DEFAULT_SETTINGS);

function mainAccepts(patch: Parameters<typeof applySettingsPatch>[1]): boolean {
  try {
    applySettingsPatch(clone(), patch);
    return true;
  } catch {
    return false;
  }
}

describe('0.9 (#2): profit.marketplaceFeePct in the main schema', () => {
  it('accepts 0, 0.25 and 0.5, refuses 0.6 and -0.1 by its path', () => {
    for (const pct of [0, 0.25, 0.5]) expect(applySettingsPatch(clone(), { profit: { marketplaceFeePct: pct } }).profit.marketplaceFeePct).toBe(pct);
    expect(() => applySettingsPatch(clone(), { profit: { marketplaceFeePct: 0.6 } })).toThrow(/profit\.marketplaceFeePct/);
    expect(() => applySettingsPatch(clone(), { profit: { marketplaceFeePct: -0.1 } })).toThrow(/profit\.marketplaceFeePct/);
  });

  it('a 0.8 file without the key loads 0.1 and is not reported invalid', () => {
    const old = clone() as unknown as { profit: Record<string, unknown> };
    delete old.profit['marketplaceFeePct'];
    const loaded = parseSettingsWithReport(old);
    expect(loaded.settings.profit.marketplaceFeePct).toBe(0.1);
    expect(loaded.invalid).toEqual([]);
  });

  it('defaults to 10% (the shared rule says the same)', () => {
    expect(DEFAULT_SETTINGS.profit.marketplaceFeePct).toBe(0.1);
    expect(MARKETPLACE_FEE_DEFAULT).toBe(DEFAULT_SETTINGS.profit.marketplaceFeePct);
  });
});

describe('0.9 (#2): the marketplace.tf fee field', () => {
  it('accepts 0 to 50 % locally, as the schema accepts 0 to 0.5, and reads the stored ratio back', () => {
    expect(MARKETPLACE_FEE_PCT).toEqual({ min: 0, max: 50 });
    expect(pctTextToRatio(String(MARKETPLACE_FEE_PCT.max))).toBe(MARKETPLACE_FEE_MAX);
    const v = numberValidator(MARKETPLACE_FEE_PCT.min, MARKETPLACE_FEE_PCT.max);
    for (const ok of ['0', '10', '12.5', '50']) expect(v(ok), ok).toBeNull();
    expect(v('50.1')).toBe('Between 0 and 50.');
    expect(v('-1')).not.toBeNull();
    expect(v('')).toBe('Enter a number.');
    // Every bound the field accepts round-trips through the field's conversion and main's schema.
    for (const pct of [MARKETPLACE_FEE_PCT.min, MARKETPLACE_FEE_PCT.max, 12.5]) {
      const ratio = pctTextToRatio(String(pct));
      expect(mainAccepts({ profit: { marketplaceFeePct: ratio } }), String(pct)).toBe(true);
      expect(ratioToPctText(ratio)).toBe(String(pct));
    }
    expect(mainAccepts({ profit: { marketplaceFeePct: pctTextToRatio('50.1') } })).toBe(false);
    expect(ratioToPctText(DEFAULT_SETTINGS.profit.marketplaceFeePct)).toBe('10');
  });

  it("its hint says what it is used for, that 10% is a 2019 report, and that it is the user's own", () => {
    expect(MARKETPLACE_FEE_HINT).toContain('never for profit');
    expect(MARKETPLACE_FEE_HINT).toContain('2019 forum report');
    expect(MARKETPLACE_FEE_HINT).toContain('check your seller page');
    expect(MARKETPLACE_FEE_HINT).toContain('Flip Desk reads nothing from marketplace.tf.');
    expect(MARKETPLACE_FEE_HINT).not.toMatch(/:\/\//);
  });

  it('sits in the Profit thresholds grid after the Price-move reserve, with its hint', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('hint={MARKETPLACE_FEE_HINT}');
    expect(page).toContain('id="p-mptf-fee"');
    const reserve = page.indexOf('htmlFor="p-reserve"');
    const fee = page.indexOf('htmlFor="p-mptf-fee"');
    expect(reserve).toBeGreaterThan(0);
    expect(fee).toBeGreaterThan(reserve);
    expect(fee).toBeLessThan(page.indexOf('htmlFor="p-om"'));
    expect(page).toContain('set({ marketplaceFeePct: pctTextToRatio(v) })');
  });
});
