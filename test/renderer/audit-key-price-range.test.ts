// Settings → Key price: the service ignores any key price outside 2..2000 ref (keyprice.ts sane()), so
// the three key fields refuse such text with a message instead of saving a value that is then silently
// dropped (Manual mode falling back to backpack.tf or PriceDB). A value saved out of range before this
// check is named on its field.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KEY_PRICE_RANGE_ERROR, KEY_SANE_SCRAP, keyPriceHint, REF_TEXT_ERROR, validateKeyPriceRef } from '../../src/renderer/settingsFields';
import { effectiveScraptfKey, selectKeyPrice } from '../../src/service/domain/keyprice';
import { parsePrice } from '../../src/shared/currency';
import type { KeyPriceQuote } from '../../src/shared/types';
import { T0, testSettings } from '../domain/helpers';

const OUT_OF_RANGE = ['6533', '1.5', '0', '1.88', '2000.11', '2,001'];
const ACCEPTED = ['2', '2000', '65.33', '60 ref', '540 scrap'];
const BPTF: KeyPriceQuote[] = [{ source: 'bptf', buyScrap: 568, sellScrap: null, observedAt: T0 }];

describe('validateKeyPriceRef', () => {
  it('refuses a key price outside 2..2000 ref with the range message', () => {
    for (const v of OUT_OF_RANGE) expect(validateKeyPriceRef(v), v).toBe(KEY_PRICE_RANGE_ERROR);
  });

  it('accepts the bounds, ordinary prices and an empty field (clearing)', () => {
    for (const v of [...ACCEPTED, '', '  ']) expect(validateKeyPriceRef(v), v).toBeNull();
    expect(KEY_SANE_SCRAP).toEqual({ min: 18, max: 18_000 });
  });

  it('asks for refined when the text is unreadable or in keys', () => {
    for (const v of ['abc', '1 key']) expect(validateKeyPriceRef(v), v).toBe(REF_TEXT_ERROR);
  });

  it('agrees with the service: what it accepts is used in Manual mode, what it refuses would be ignored', () => {
    for (const v of ACCEPTED) {
      const scrap = parsePrice(v, 'ref')!.scrap;
      expect(selectKeyPrice(BPTF, testSettings({ keyPrice: { mode: 'manual', manualScrap: scrap } }), T0), v).toMatchObject({ source: 'manual', valueScrap: scrap });
      expect(effectiveScraptfKey(testSettings({ keyPrice: { scraptfSellScrap: scrap, scraptfObservedAt: T0 } })).paysScrap, v).toBe(scrap);
    }
    for (const v of OUT_OF_RANGE) {
      const scrap = parsePrice(v, 'ref')!.scrap;
      expect(selectKeyPrice(BPTF, testSettings({ keyPrice: { mode: 'manual', manualScrap: scrap } }), T0).source, v).toBe('bptf');
      expect(effectiveScraptfKey(testSettings({ keyPrice: { scraptfSellScrap: scrap, scraptfObservedAt: T0 } })).paysScrap, v).toBeNull();
    }
  });
});

describe('keyPriceHint: a value saved out of range is named', () => {
  it('adds the note only for a saved value the service ignores', () => {
    expect(keyPriceHint(null)).toBeUndefined();
    expect(keyPriceHint(585)).toBeUndefined();
    expect(keyPriceHint(585, 'Display only.')).toBe('Display only.');
    expect(keyPriceHint(58_797)).toMatch(/is ignored/);
    expect(keyPriceHint(14, 'Display only.')).toMatch(/^Display only\. A key price is between 2 and 2000 ref/);
    expect(keyPriceHint(0)).toMatch(/is ignored/);
  });
});

describe('Settings → Key price wiring', () => {
  const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
  const section = page.slice(page.indexOf('function KeyPriceSection'), page.indexOf('function ProfitSection'));

  it('validates all three key fields with the range check', () => {
    expect(section.split('validate={validateKeyPriceRef}').length - 1).toBe(3);
    expect(section).not.toContain('refValidator(true)');
  });

  it('names a saved out-of-range value on each field', () => {
    expect(section).toContain('keyPriceHint(s.keyPrice.manualScrap)');
    expect(section).toContain('keyPriceHint(s.keyPrice.scraptfBuyScrap,');
    expect(section).toContain('keyPriceHint(s.keyPrice.scraptfSellScrap,');
  });
});
