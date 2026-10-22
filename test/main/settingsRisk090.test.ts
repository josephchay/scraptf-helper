// 0.9 (#3, risk control): notifications.minProfitableDepth. Whole buyers 0 to MIN_PROFITABLE_DEPTH_MAX, 0 (the
// default) off; a 0.8 settings file reads 0 unreported, junk reads 0 reported. The Settings field (NotifySection,
// after "Repeat for the same item after") commits only what main accepts, and its hint says what is held back and
// what never is. Buyer counts show demand, not sales.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { MIN_PROFITABLE_DEPTH_MAX } from '../../src/shared/exitRisk';
import { applySettingsPatch, parseSettingsWithReport } from '../../src/shared/settingsSchema';
import type { Settings } from '../../src/shared/types';
import { MIN_PROFITABLE_DEPTH, MIN_PROFITABLE_DEPTH_LABEL, minProfitableDepthHint, numberValidator } from '../../src/renderer/settingsFields';

const clone = (): Settings => structuredClone(DEFAULT_SETTINGS);

describe('notifications.minProfitableDepth (0.9, #3)', () => {
  it('defaults to 0 (off)', () => {
    expect(DEFAULT_SETTINGS.notifications.minProfitableDepth).toBe(0);
  });

  it('accepts whole buyers 0..10 and refuses 11, -1, 2.5, "2" and true', () => {
    for (let n = 0; n <= MIN_PROFITABLE_DEPTH_MAX; n++) {
      expect(applySettingsPatch(clone(), { notifications: { minProfitableDepth: n } }).notifications.minProfitableDepth).toBe(n);
    }
    for (const bad of [11, -1, 2.5, '2', true]) {
      expect(() => applySettingsPatch(clone(), { notifications: { minProfitableDepth: bad as never } }), String(bad)).toThrow(/notifications\.minProfitableDepth/);
    }
  });

  it('reads a 0.8 file without the key as 0, unreported, and junk as 0, reported', () => {
    const old = clone() as unknown as { notifications: Record<string, unknown> };
    delete old.notifications.minProfitableDepth;
    const loaded = parseSettingsWithReport(old);
    expect(loaded.settings.notifications.minProfitableDepth).toBe(0);
    expect(loaded.invalid).toEqual([]);
    const junk = clone() as unknown as { notifications: Record<string, unknown> };
    junk.notifications.minProfitableDepth = 'lots';
    const parsed = parseSettingsWithReport(junk);
    expect(parsed.settings.notifications.minProfitableDepth).toBe(0);
    expect(parsed.invalid).toEqual(['notifications.minProfitableDepth']);
  });
});

describe('the Settings field', () => {
  it("has the schema's bounds, and every value it lets through commits as one main accepts", () => {
    expect(MIN_PROFITABLE_DEPTH).toEqual({ min: 0, max: MIN_PROFITABLE_DEPTH_MAX });
    expect(MIN_PROFITABLE_DEPTH.max).toBe(MIN_PROFITABLE_DEPTH_MAX);
    const validate = numberValidator(MIN_PROFITABLE_DEPTH.min, MIN_PROFITABLE_DEPTH.max);
    for (const text of ['0', '1', '2', '2.4', '9.6', '10']) {
      expect(validate(text), text).toBeNull();
      // The field commits Math.round(Number(v)).
      const n = Math.round(Number(text));
      expect(applySettingsPatch(clone(), { notifications: { minProfitableDepth: n } }).notifications.minProfitableDepth).toBe(n);
    }
    for (const text of ['', '-1', '11', 'two']) expect(validate(text), text).not.toBeNull();
  });

  it('labels the control and says Off at 0, how to turn it off otherwise, and that counts are demand', () => {
    expect(MIN_PROFITABLE_DEPTH_LABEL).toBe('Only tell flips with at least this many buyers at break-even');
    expect(minProfitableDepthHint(0).startsWith('Off.')).toBe(true);
    expect(minProfitableDepthHint(2).startsWith('Off.')).toBe(false);
    expect(minProfitableDepthHint(2).endsWith('0 turns this off.')).toBe(true);
    for (const hint of [minProfitableDepthHint(0), minProfitableDepthHint(2)]) {
      expect(hint).toContain('seen in the last 24 h');
      expect(hint).toContain('Buyer counts show demand, not sales.');
      expect(hint).toContain("A watch's price or profit target met on a page you read or save, Sell toasts and the Live check are not held back.");
      expect(hint).not.toMatch(/\b(chance|probability|will sell)\b/i);
      expect(hint).not.toContain('seen in the last day');
    }
  });

  it("says which watch toast waits (the engine's Watch: for a typed or imported price) and which never does (a page hit)", () => {
    // engine.ts applies depthGateOk before a "Watch: <name>" toast; bankStockNotify's watch hits come before its gates.
    const engine = readFileSync(new URL('../../src/service/domain/engine.ts', import.meta.url), 'utf8');
    const gate = engine.indexOf('depthGateOk(opp.profitableDepth, minDepth)');
    const watched = engine.indexOf('watchedKeys.add(opp.key)', gate);
    expect(gate).toBeGreaterThan(0);
    expect(watched).toBeGreaterThan(gate);
    for (const hint of [minProfitableDepthHint(0), minProfitableDepthHint(2)]) {
      expect(hint).toContain('the Watch: toast for a price you type or import');
      // The hint never says, as 0.9's first wording did, that every watch profit target goes untouched.
      expect(hint).not.toContain("Your watches' own price and profit targets");
      expect(hint).not.toContain('Profit, Watch and Candidate toasts');
    }
  });

  it('sits in NotifySection right after "Repeat for the same item after"', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    const notify = page.indexOf('export function NotifySection');
    const dedup = page.indexOf('htmlFor="n-dedup"', notify);
    const depth = page.indexOf('htmlFor="n-depth"', notify);
    const kinds = page.indexOf('label="Notify for"', notify);
    expect(notify).toBeGreaterThan(0);
    expect(dedup).toBeGreaterThan(notify);
    expect(depth).toBeGreaterThan(dedup);
    expect(kinds).toBeGreaterThan(depth);
    expect(page.slice(depth, kinds)).toContain('minProfitableDepthHint(n.minProfitableDepth)');
    expect(page.slice(depth, kinds)).toContain('numberValidator(MIN_PROFITABLE_DEPTH.min, MIN_PROFITABLE_DEPTH.max)');
  });
});
