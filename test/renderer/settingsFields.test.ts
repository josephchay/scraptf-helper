import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidContactUrl } from '../../src/renderer/format';
import {
  CONTACT_ERROR,
  daysTextToMs,
  HOLDINGS_NOTIFY_LABEL,
  holdingsNotifyHint,
  HOTKEY_HINT_ERROR,
  inputKindsHint,
  MIN_MARGIN_PCT,
  MIN_PROFIT_PCT_OF_COST,
  msToDaysText,
  NOTIFY_INPUT_KINDS,
  numberValidator,
  pctTextToRatio,
  ratioToPctText,
  REFERENCE_MAX_AGE_DAYS,
  referenceAgeHint,
  setInputKind,
  SUSPECT_MARGIN_PCT,
  suspectMarginHint,
  userAgentPreview,
  validateContactUrl,
  validateHotkey,
} from '../../src/renderer/settingsFields';
import { usableReferences } from '../../src/service/domain/pricing';
import { buildUserAgent } from '../../src/service/net/http';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { applySettingsPatch, isValidAccelerator } from '../../src/shared/settingsSchema';
import type { InputKind } from '../../src/shared/types';

/** True when main would accept the patch (the settings store applies exactly this). */
function mainAccepts(patch: Parameters<typeof applySettingsPatch>[1]): boolean {
  try {
    applySettingsPatch(DEFAULT_SETTINGS, patch);
    return true;
  } catch {
    return false;
  }
}

describe('profit percentage fields agree with the settings schema', () => {
  it('rejects a minimum margin above 100 % locally instead of letting main reject it', () => {
    const v = numberValidator(MIN_MARGIN_PCT.min, MIN_MARGIN_PCT.max);
    expect(v('150')).toBe('Between 0 and 100.');
    expect(v('1000')).not.toBeNull();
    expect(v('-1')).not.toBeNull();
    expect(v('abc')).toBe('Enter a number.');
    expect(v('8')).toBeNull();
    expect(v('100')).toBeNull();
    // Every value the field accepts is one main accepts.
    expect(mainAccepts({ profit: { minMargin: MIN_MARGIN_PCT.max / 100 } })).toBe(true);
    expect(mainAccepts({ profit: { minMargin: MIN_MARGIN_PCT.min / 100 } })).toBe(true);
    expect(mainAccepts({ profit: { minMargin: 1.5 } })).toBe(false);
  });

  it('rejects a cleared field instead of saving 0 (Number("") is 0)', () => {
    for (const v of [numberValidator(0, 100), numberValidator(MIN_MARGIN_PCT.min, MIN_MARGIN_PCT.max), numberValidator(0, 100000)]) {
      expect(v('')).toBe('Enter a number.');
      expect(v('   ')).toBe('Enter a number.');
    }
    // Same answer whatever the minimum is.
    expect(numberValidator(0.1, 100)('')).toBe('Enter a number.');
    expect(numberValidator(0, 100, true)('')).toBeNull();
    expect(numberValidator(0, 100, true)('  ')).toBeNull();
  });

  it('accepts plain decimals only, not the other forms Number() reads', () => {
    const v = numberValidator(0, 100000);
    for (const ok of ['0', '8', '8.5', '.5', '5.', ' 12 ', '+3']) expect(v(ok), ok).toBeNull();
    for (const bad of ['0x10', '1e3', 'Infinity', '1,5', '1 2', '-']) expect(v(bad), bad).toBe('Enter a number.');
  });

  it('keeps the "% of cost" field inside the schema range', () => {
    expect(mainAccepts({ profit: { minProfitPctOfCost: MIN_PROFIT_PCT_OF_COST.max / 100 } })).toBe(true);
    expect(mainAccepts({ profit: { minProfitPctOfCost: MIN_PROFIT_PCT_OF_COST.min / 100 } })).toBe(true);
  });
});

describe('reference age and suspect margin fields (F4, F5)', () => {
  const DAY = 86_400_000;

  it('shows referenceMaxAgeMs in days and saves integer milliseconds main accepts', () => {
    const v = numberValidator(REFERENCE_MAX_AGE_DAYS.min, REFERENCE_MAX_AGE_DAYS.max);
    expect(msToDaysText(DEFAULT_SETTINGS.profit.referenceMaxAgeMs)).toBe('30');
    expect(msToDaysText(36 * 3_600_000)).toBe('1.5');
    for (const ok of ['0', '1', '30', '0.5', '365']) {
      expect(v(ok), ok).toBeNull();
      const ms = daysTextToMs(ok);
      expect(Number.isInteger(ms), ok).toBe(true);
      expect(mainAccepts({ profit: { referenceMaxAgeMs: ms } }), ok).toBe(true);
    }
    expect(daysTextToMs('30')).toBe(30 * DAY);
    expect(daysTextToMs('1.333333')).toBe(Math.round(1.333333 * DAY));
    for (const bad of ['366', '-1', '1e2', 'abc']) expect(v(bad), bad).not.toBeNull();
    expect(mainAccepts({ profit: { referenceMaxAgeMs: daysTextToMs('366') } })).toBe(false);
  });

  it('shows suspectMargin as a percentage, with 0 turning the guard off', () => {
    const v = numberValidator(SUSPECT_MARGIN_PCT.min, SUSPECT_MARGIN_PCT.max);
    expect(ratioToPctText(DEFAULT_SETTINGS.profit.suspectMargin)).toBe('200');
    expect(pctTextToRatio('200')).toBe(2);
    expect(pctTextToRatio('0')).toBe(0);
    for (const ok of ['0', '150', '200', '33.33', '100000']) {
      expect(v(ok), ok).toBeNull();
      expect(mainAccepts({ profit: { suspectMargin: pctTextToRatio(ok) } }), ok).toBe(true);
    }
    expect(v('100001')).toBe('Between 0 and 100000.');
    expect(mainAccepts({ profit: { suspectMargin: pctTextToRatio('100001') } })).toBe(false);
    expect(ratioToPctText(pctTextToRatio('33.33'))).toBe('33.33');
    expect(suspectMarginHint(0)).toMatch(/^Off\./);
    expect(suspectMarginHint(2)).toMatch(/0 turns the check off/);
  });

  it('never commits 0 from a cleared field (0 would ignore every reference or turn the guard off)', () => {
    for (const v of [numberValidator(REFERENCE_MAX_AGE_DAYS.min, REFERENCE_MAX_AGE_DAYS.max), numberValidator(SUSPECT_MARGIN_PCT.min, SUSPECT_MARGIN_PCT.max)]) {
      expect(v('')).toBe('Enter a number.');
      expect(v('  ')).toBe('Enter a number.');
    }
    expect(referenceAgeHint(0)).toMatch(/every PriceDB price with a known age is ignored/);
    expect(referenceAgeHint(30 * DAY)).toMatch(/at least a year/);
    expect(referenceAgeHint(30 * DAY)).not.toMatch(/ignored\.$/);
  });

  it('the 0-days hint matches what the engine does with references', () => {
    const now = Date.UTC(2026, 9, 15);
    const dated = { pricedb: { buyScrap: 100, sellScrap: 120, time: null, ageMs: 60_000 }, community: { valueScrap: 110, valueHighScrap: null, lastUpdate: now / 1000 - 60 } };
    // At 0 PriceDB is dropped; a minute-old community price keeps its one-year floor.
    expect(usableReferences(dated, daysTextToMs('0'), now).references).toEqual({ pricedb: null, community: dated.community });
    // A price of unknown age is kept, hence "with a known age".
    const undated = { pricedb: { buyScrap: 100, sellScrap: 120, time: null, ageMs: null }, community: null };
    expect(usableReferences(undated, daysTextToMs('0'), now).references.pricedb).not.toBeNull();
    expect(usableReferences(dated, daysTextToMs('30'), now).stale).toEqual([]);
  });
});

describe('notification controls (F6)', () => {
  it('ticks and unticks input kinds in a stable order without duplicates', () => {
    expect(NOTIFY_INPUT_KINDS.map((o) => o.value)).toEqual(DEFAULT_SETTINGS.notifications.inputKinds);
    expect(setInputKind(['user', 'import', 'rule'], 'rule', false)).toEqual(['user', 'import']);
    expect(setInputKind(['import'], 'user', true)).toEqual(['user', 'import']);
    expect(setInputKind(['rule', 'user'], 'import', true)).toEqual(['user', 'import', 'rule']);
    expect(setInputKind(['user', 'user'] as InputKind[], 'user', true)).toEqual(['user']);
    expect(setInputKind(['user'], 'user', false)).toEqual([]);
  });

  it('every combination is one main accepts, including none', () => {
    const kinds: InputKind[] = ['user', 'import', 'rule'];
    for (let mask = 0; mask < 8; mask++) {
      let cur: InputKind[] = [];
      kinds.forEach((k, i) => {
        cur = setInputKind(cur, k, (mask & (1 << i)) !== 0);
      });
      expect(mainAccepts({ notifications: { inputKinds: cur } }), cur.join(',')).toBe(true);
    }
    expect(inputKindsHint([])).toMatch(/no desktop notifications/);
    expect(inputKindsHint(['user'])).not.toMatch(/no desktop notifications/);
  });

  it('saves the silent switch', () => {
    expect(mainAccepts({ notifications: { silent: true } })).toBe(true);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { notifications: { silent: true } }).notifications.silent).toBe(true);
  });

  it('saves the holdings sell alert switch (F11), on by default', () => {
    expect(DEFAULT_SETTINGS.notifications.holdings).toBe(true);
    expect(HOLDINGS_NOTIFY_LABEL).toBe('Notify when something you hold can be sold at a profit');
    for (const holdings of [false, true]) {
      expect(mainAccepts({ notifications: { holdings } })).toBe(true);
      expect(applySettingsPatch(DEFAULT_SETTINGS, { notifications: { holdings } }).notifications.holdings).toBe(holdings);
    }
    // Only that switch changes; the rest of the section stays.
    const off = applySettingsPatch(DEFAULT_SETTINGS, { notifications: { holdings: false } }).notifications;
    expect({ ...off, holdings: true }).toEqual(DEFAULT_SETTINGS.notifications);
  });

  it('explains the holdings alert, and that it needs desktop notifications on', () => {
    expect(holdingsNotifyHint(true)).toMatch(/clear your profit thresholds/);
    expect(holdingsNotifyHint(true)).not.toMatch(/off/);
    expect(holdingsNotifyHint(false)).toMatch(/^Desktop notifications are off/);
  });

  it('puts the switch in the Notifications section', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    const section = page.slice(page.indexOf('function NotifySection'), page.indexOf('function FeedSection'));
    expect(section).toContain('<Toggle checked={n.holdings} onChange={(holdings) => void set({ holdings })} label={HOLDINGS_NOTIFY_LABEL} description={holdingsNotifyHint(n.enabled)} />');
  });
});

describe('quick-entry hotkey field', () => {
  it('allows clearing the field to turn the global shortcut off', () => {
    expect(validateHotkey('')).toBeNull();
    expect(validateHotkey('   ')).toBeNull();
    expect(mainAccepts({ app: { quickEntryHotkey: '' } })).toBe(true);
  });

  it.each(['CommandOrControl+Alt+F', 'Ctrl+Alt+/', 'F9', 'Alt+Shift+Space', 'Ctrl+Alt+Up'])('accepts %s like main does', (a) => {
    expect(validateHotkey(a)).toBeNull();
    expect(mainAccepts({ app: { quickEntryHotkey: a } })).toBe(true);
  });

  it.each(['Shift+A', 'Foo+Bar', 'Ctrl+Alt', 'Ctrl++', 'A'])('rejects %s like main does', (a) => {
    expect(validateHotkey(a)).toBe(HOTKEY_HINT_ERROR);
    expect(mainAccepts({ app: { quickEntryHotkey: a } })).toBe(false);
  });

  it('explains a reserved system shortcut', () => {
    expect(isValidAccelerator('Ctrl+C')).toBe(false);
    expect(validateHotkey('Ctrl+C')).toMatch(/system or everyday shortcut/);
  });

  it('never disagrees with the schema', () => {
    const samples = ['', 'Ctrl+Alt+F', 'CmdOrCtrl+Shift+K', 'Super+F', 'Shift+F5', 'Shift+1', 'Alt+Shift', 'ctrl+alt+f', 'Ctrl+Alt+F25', 'Ctrl+Alt+Num5', 'Ctrl+Ctrl+F', 'Ctrl+C', 'Alt+F4'];
    for (const a of samples) expect(validateHotkey(a) === null, a).toBe(mainAccepts({ app: { quickEntryHotkey: a } }));
  });
});

describe('contact URL field', () => {
  const long = `https://example.com/${'a'.repeat(190)}`;

  it.each([
    'https://steamcommunity.com/id/jöe',
    'https://en.wikipedia.org/wiki/User:Me_(x)',
    'mailto:a(b)@x.com',
    long,
  ])('rejects %s, which main would reject', (u) => {
    expect(isValidContactUrl(u)).toBe(false);
    expect(validateContactUrl(u)).toBe(CONTACT_ERROR);
    expect(mainAccepts({ contactUrl: u })).toBe(false);
  });

  it.each(['https://steamcommunity.com/id/you', 'mailto:you@example.com', 'https://steamcommunity.com/id/j%C3%B6e', ''])('accepts %s, which main accepts', (u) => {
    expect(validateContactUrl(u)).toBeNull();
    expect(mainAccepts({ contactUrl: u })).toBe(true);
  });

  it('previews the User-Agent the service really sends, including the placeholder', () => {
    expect(userAgentPreview('0.1.0', '')).toBe(buildUserAgent('0.1.0', ''));
    expect(userAgentPreview('0.1.0', '')).toBe('TF2FlipDesk/0.1.0 (+no-contact-set)');
    expect(userAgentPreview('0.1.0', 'https://steamcommunity.com/id/you')).toBe(buildUserAgent('0.1.0', 'https://steamcommunity.com/id/you'));
  });
});
