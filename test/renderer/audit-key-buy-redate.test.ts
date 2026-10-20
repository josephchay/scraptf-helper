// Settings → Key price: the scrap.tf key buy price is display only. The typed pair shares one date
// (scraptfObservedAt), so saving the buy price must not re-date an older typed sell price: that would
// make it beat a newer saved scrap.tf/items list and cap the automatic key value (keyprice.ts).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scraptfKeyBuyPatch, scraptfListKeyView } from '../../src/renderer/settingsFields';
import { effectiveScraptfKey, selectKeyPrice } from '../../src/service/domain/keyprice';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { applySettingsPatch } from '../../src/shared/settingsSchema';
import type { KeyPriceQuote, ScraptfListKey, Settings } from '../../src/shared/types';

const OCT1 = Date.UTC(2026, 9, 1, 12, 0, 0);
const OCT19 = Date.UTC(2026, 9, 19, 12, 0, 0);
const OCT20 = Date.UTC(2026, 9, 20, 12, 0, 0);

function withTyped(typed: Partial<Settings['keyPrice']>): Settings {
  return applySettingsPatch(DEFAULT_SETTINGS, { keyPrice: typed });
}

const LIST: ScraptfListKey = { paysScrap: 559, sellsScrap: 570, observedAt: OCT19 };
const BPTF: KeyPriceQuote[] = [{ source: 'bptf', buyScrap: 585, sellScrap: 600, observedAt: OCT20 }];

describe('saving the scrap.tf key buy price never changes the key cap', () => {
  it("keeps a newer saved list's cap over an older typed sell price (the finding's scenario)", () => {
    const base = withTyped({ mode: 'auto', scraptfSellScrap: 495, scraptfObservedAt: OCT1 });
    expect(selectKeyPrice(BPTF, base, OCT20, LIST).valueScrap).toBe(559);

    // The old commit stamped the shared date, so the 55 ref typed on Oct 1 became the cap.
    const old = applySettingsPatch(base, { keyPrice: { scraptfBuyScrap: 570, scraptfObservedAt: OCT20 } });
    expect(selectKeyPrice(BPTF, old, OCT20, LIST).valueScrap).toBe(495);

    const next = applySettingsPatch(base, scraptfKeyBuyPatch(570, base.keyPrice, OCT20));
    expect(next.keyPrice.scraptfBuyScrap).toBe(570);
    expect(next.keyPrice.scraptfObservedAt).toBe(OCT1);
    expect(selectKeyPrice(BPTF, next, OCT20, LIST).valueScrap).toBe(559);
    expect(effectiveScraptfKey(next, LIST).source).toBe('list');
    expect(scraptfListKeyView(LIST, next.keyPrice, OCT20)?.pill).not.toBe('Not in use');
  });

  it('leaves what scrap.tf pays unchanged for every mix of list, typed values and buy price', () => {
    const lists: (ScraptfListKey | null)[] = [
      null,
      LIST,
      { paysScrap: 559, sellsScrap: null, observedAt: OCT19 },
      { paysScrap: null, sellsScrap: 570, observedAt: OCT19 },
    ];
    const typed: Partial<Settings['keyPrice']>[] = [
      {},
      { scraptfSellScrap: 495, scraptfObservedAt: OCT1 },
      { scraptfSellScrap: 495, scraptfObservedAt: null },
      { scraptfSellScrap: 495, scraptfObservedAt: OCT19 + 3_600_000 },
      { scraptfBuyScrap: 600, scraptfObservedAt: OCT1 },
      { scraptfSellScrap: 3, scraptfObservedAt: OCT1 },
      { scraptfSellScrap: 495, scraptfBuyScrap: 600, scraptfObservedAt: OCT1 },
    ];
    for (const t of typed) {
      const base = withTyped(t);
      for (const buy of [null, 570]) {
        const next = applySettingsPatch(base, scraptfKeyBuyPatch(buy, base.keyPrice, OCT20));
        expect(next.keyPrice.scraptfBuyScrap).toBe(buy);
        for (const l of lists) {
          expect(effectiveScraptfKey(next, l).paysScrap, JSON.stringify({ t, buy, l })).toBe(effectiveScraptfKey(base, l).paysScrap);
        }
      }
    }
  });

  it('dates the typed values when no usable sell price is typed, so a newer buy price still shows', () => {
    const empty = withTyped({});
    expect(scraptfKeyBuyPatch(570, empty.keyPrice, OCT20)).toEqual({ keyPrice: { scraptfBuyScrap: 570, scraptfObservedAt: OCT20 } });
    const next = applySettingsPatch(empty, scraptfKeyBuyPatch(600, empty.keyPrice, OCT20));
    expect(effectiveScraptfKey(next, LIST)).toEqual({ paysScrap: 559, sellsScrap: 600, source: 'settings' });
    // A typed sell price keeps its own date.
    const sold = withTyped({ scraptfSellScrap: 495, scraptfObservedAt: OCT1 });
    expect(scraptfKeyBuyPatch(570, sold.keyPrice, OCT20)).toEqual({ keyPrice: { scraptfBuyScrap: 570 } });
  });

  it('is what the buy field commits; the sell field still dates both', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('scraptfKeyBuyPatch(');
    expect(page).not.toContain('scraptfBuyScrap: v.trim() ? parseRef(v) : null, scraptfObservedAt: Date.now()');
    expect(page).toContain('scraptfSellScrap: v.trim() ? parseRef(v) : null, scraptfObservedAt: Date.now()');
  });
});
