// profit.inputStaleMs is Settings → Profit thresholds → "Price is stale after". Since 0.7.1 it also
// decides that a price is never notified, is not counted as at or under Pay up to, holds back Candidate
// toasts after a fresh bank save and turns an old save's toasts into one summary (ARCHITECTURE.md
// ACT-2/3/6/8/9). The field's hint says so, and the app names the field by its label everywhere.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INPUT_STALE_HINT } from '../../src/renderer/settingsFields';
import { yourPriceTitle } from '../../src/renderer/shoppingModel';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the "Price is stale after" field says everything it controls', () => {
  it('names confidence, notifications, Pay up to and the bank-save toasts', () => {
    expect(INPUT_STALE_HINT).toMatch(/lose confidence/);
    expect(INPUT_STALE_HINT).toMatch(/never notified/);
    expect(INPUT_STALE_HINT).toMatch(/not counted as at or under Pay up to/);
    expect(INPUT_STALE_HINT).toMatch(/Candidate toasts/);
    expect(INPUT_STALE_HINT).toMatch(/one summary/);
    // confidence.ts: a price under 15 min old is always fresh, and a rule estimate is scored apart.
    expect(INPUT_STALE_HINT).toMatch(/15 min/);
    expect(INPUT_STALE_HINT).toMatch(/^Typed and imported scrap\.tf prices/);
  });

  it('is the hint on the field, which keeps its label', () => {
    const page = read('../../src/renderer/pages/SettingsPage.tsx');
    expect(page).toContain('<Field label="Price is stale after" htmlFor="p-stale" hint={INPUT_STALE_HINT}>');
    expect(page).not.toContain('Older scrap.tf prices lose confidence.');
  });
});

describe('the app names the field by its label', () => {
  it('in the Shopping list summary and the price cell title', () => {
    for (const path of ['../../src/renderer/pages/ShoppingPage.tsx', '../../src/renderer/shoppingModel.ts']) {
      const src = read(path);
      expect(src, path).not.toContain('stale-input limit');
      expect(src, path).toContain('Price is stale after');
    }
    expect(read('../../src/renderer/pages/ShoppingPage.tsx')).toContain('Settings → Profit thresholds → Price is stale after');
  });

  it("a stale price's title points at the field and still says why it is not counted", () => {
    const t = yourPriceTitle({ knownCostScrap: 91, knownMaxCostScrap: 100, maxCostScrap: 100, knownObservedAt: Date.UTC(2026, 9, 15), knownStale: true }, 568);
    expect(t).toContain('"Price is stale after" time (Settings → Profit thresholds)');
    expect(t).toContain('not counted as at or under the ceiling');
  });
});
