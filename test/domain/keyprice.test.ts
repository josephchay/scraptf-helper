import { describe, expect, it } from 'vitest';
import type { KeyPriceQuote } from '../../src/shared/types';
import { DEFAULT_KEY_SCRAP, KEY_PRICE_STALE_MS, isQuoteStale, selectKeyPrice } from '../../src/service/domain/keyprice';
import { HOUR, T0, testSettings } from './helpers';

const auto = testSettings();
const q = (source: KeyPriceQuote['source'], buyScrap: number | null, sellScrap: number | null, ageMs = 0): KeyPriceQuote => ({
  source,
  buyScrap,
  sellScrap,
  observedAt: T0 - ageMs,
});

describe('selectKeyPrice (brief §5.3)', () => {
  it('uses the manual value in manual mode', () => {
    const s = testSettings({ keyPrice: { mode: 'manual', manualScrap: 560 } });
    const r = selectKeyPrice([q('bptf', 568, 570)], s, T0);
    expect(r).toMatchObject({ valueScrap: 560, source: 'manual', stale: false });
  });

  it('falls back to automatic sources in manual mode without a value', () => {
    const s = testSettings({ keyPrice: { mode: 'manual', manualScrap: null } });
    expect(selectKeyPrice([q('pricedb', 568, 570)], s, T0)).toMatchObject({ valueScrap: 568, source: 'pricedb' });
  });

  it('uses a stored manual quote in manual mode', () => {
    const s = testSettings({ keyPrice: { mode: 'manual', manualScrap: null } });
    const r = selectKeyPrice([q('manual', 555, null, 5 * HOUR), q('bptf', 568, null)], s, T0);
    expect(r).toMatchObject({ valueScrap: 555, source: 'manual', observedAt: T0 - 5 * HOUR, stale: false });
  });

  it('prefers backpack.tf over PriceDB when both are fresh', () => {
    const r = selectKeyPrice([q('pricedb', 568, 570), q('bptf', 572, 575)], auto, T0);
    expect(r).toMatchObject({ valueScrap: 572, source: 'bptf', stale: false, observedAt: T0 });
  });

  it('skips a stale backpack.tf value for a fresh PriceDB one', () => {
    const r = selectKeyPrice([q('bptf', 572, null, 7 * HOUR), q('pricedb', 568, null, HOUR)], auto, T0);
    expect(r).toMatchObject({ valueScrap: 568, source: 'pricedb', stale: false });
  });

  it('uses the most recent value, marked stale, when every source is stale', () => {
    const r = selectKeyPrice([q('bptf', 572, null, 30 * HOUR), q('pricedb', 568, null, 8 * HOUR)], auto, T0);
    expect(r).toMatchObject({ valueScrap: 568, source: 'pricedb', stale: true, observedAt: T0 - 8 * HOUR });
  });

  it('marks a source stale after 6 h exactly', () => {
    expect(selectKeyPrice([q('bptf', 572, null, KEY_PRICE_STALE_MS)], auto, T0).stale).toBe(false);
    expect(selectKeyPrice([q('bptf', 572, null, KEY_PRICE_STALE_MS + 1)], auto, T0).stale).toBe(true);
    expect(isQuoteStale({ observedAt: Number.NaN }, T0)).toBe(true);
  });

  it('uses the buy side, or the sell side when buy is missing', () => {
    expect(selectKeyPrice([q('bptf', 560, 580)], auto, T0).valueScrap).toBe(560);
    expect(selectKeyPrice([q('bptf', null, 580)], auto, T0).valueScrap).toBe(580);
  });

  it('ignores broken quotes', () => {
    const r = selectKeyPrice([q('bptf', 5, null), q('pricedb', 1e9, Number.NaN), { source: 'bogus' as 'bptf', buyScrap: 570, sellScrap: null, observedAt: T0 }], auto, T0);
    expect(r.source).toBe('default');
  });

  it('falls back to a clearly marked 60 ref default', () => {
    const r = selectKeyPrice([], auto, T0);
    expect(r).toEqual({ valueScrap: DEFAULT_KEY_SCRAP, source: 'default', observedAt: null, stale: true, quotes: [] });
    expect(DEFAULT_KEY_SCRAP).toBe(540);
  });

  it('uses a remembered manual value before the default in auto mode, marked stale', () => {
    const s = testSettings({ keyPrice: { mode: 'auto', manualScrap: 565 } });
    expect(selectKeyPrice([], s, T0)).toMatchObject({ valueScrap: 565, source: 'manual', stale: true });
  });

  it('caps the automatic value by the scrap.tf key sell price (conservative min)', () => {
    const s = testSettings({ keyPrice: { mode: 'auto', scraptfSellScrap: 580 } });
    expect(selectKeyPrice([q('pricedb', 600, 612)], s, T0)).toMatchObject({ valueScrap: 580, source: 'pricedb', stale: false });
    // A stale automatic value is capped too.
    expect(selectKeyPrice([q('bptf', 600, null, 8 * HOUR)], s, T0)).toMatchObject({ valueScrap: 580, source: 'bptf', stale: true });
  });

  it('keeps an automatic value already below the scrap.tf sell price', () => {
    const s = testSettings({ keyPrice: { mode: 'auto', scraptfSellScrap: 580 } });
    expect(selectKeyPrice([q('pricedb', 568, 570)], s, T0).valueScrap).toBe(568);
  });

  it('does not cap a manual value', () => {
    const s = testSettings({ keyPrice: { mode: 'manual', manualScrap: 600, scraptfSellScrap: 580 } });
    expect(selectKeyPrice([q('bptf', 610, null)], s, T0)).toMatchObject({ valueScrap: 600, source: 'manual' });
    // Nor a remembered manual value used as the auto-mode fallback.
    const a = testSettings({ keyPrice: { mode: 'auto', manualScrap: 600, scraptfSellScrap: 580 } });
    expect(selectKeyPrice([], a, T0)).toMatchObject({ valueScrap: 600, source: 'manual' });
  });

  it('ignores a scrap.tf sell price outside the sane range', () => {
    for (const cap of [17, 0, 18_001, Number.NaN]) {
      const s = testSettings({ keyPrice: { mode: 'auto', scraptfSellScrap: cap } });
      expect(selectKeyPrice([q('pricedb', 600, null)], s, T0).valueScrap).toBe(600);
    }
  });

  it('returns every valid quote in display order', () => {
    const quotes = [q('manual', 500, null), q('pricedb', 568, null), q('bptf', 570, null)];
    expect(selectKeyPrice(quotes, auto, T0).quotes.map((x) => x.source)).toEqual(['bptf', 'pricedb', 'manual']);
  });
});
