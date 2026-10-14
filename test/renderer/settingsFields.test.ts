import { describe, expect, it } from 'vitest';
import { isValidContactUrl } from '../../src/renderer/format';
import {
  CONTACT_ERROR,
  HOTKEY_HINT_ERROR,
  MIN_MARGIN_PCT,
  MIN_PROFIT_PCT_OF_COST,
  numberValidator,
  userAgentPreview,
  validateContactUrl,
  validateHotkey,
} from '../../src/renderer/settingsFields';
import { buildUserAgent } from '../../src/service/net/http';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { applySettingsPatch, isValidAccelerator } from '../../src/shared/settingsSchema';

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

  it('keeps the "% of cost" field inside the schema range', () => {
    expect(mainAccepts({ profit: { minProfitPctOfCost: MIN_PROFIT_PCT_OF_COST.max / 100 } })).toBe(true);
    expect(mainAccepts({ profit: { minProfitPctOfCost: MIN_PROFIT_PCT_OF_COST.min / 100 } })).toBe(true);
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
