// F16 live check, shared contract: the refusals every path applies, the blank result, the
// 'check' settings group (defaults, lenient load, strict update, the hotkey conflict rule) and
// the accelerator comparison behind it.

import { describe, expect, it } from 'vitest';
import { sameAccelerator } from '../../src/shared/accelerator';
import {
  blankCheckResult,
  CHECK_MAX_CHARS,
  CHECK_MAX_LINES,
  CHECK_NOT_ITEM_REASON,
  CHECK_RECENT_MAX,
  CHECK_REFUSALS,
  CHECK_WATCH_INTERVAL_MS,
  checkLineCount,
  checkTextRefusal,
} from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { applySettingsPatch, CHECK_HOTKEY_CONFLICT, parseSettingsWithReport, SettingsValidationError } from '../../src/shared/settingsSchema';
import { CHECK_SOURCES, CHECK_STATUSES } from '../../src/shared/types';

describe('spec limits', () => {
  it('match the spec', () => {
    expect(CHECK_MAX_CHARS).toBe(400);
    expect(CHECK_MAX_LINES).toBe(3);
    expect(CHECK_RECENT_MAX).toBe(30);
    expect(CHECK_WATCH_INTERVAL_MS).toBe(700);
    expect(CHECK_SOURCES).toEqual(['hotkey', 'watch', 'manual']);
    expect(CHECK_STATUSES).toEqual(['item', 'not-item', 'refused']);
    expect(CHECK_REFUSALS.list).toBe('Looks like a list. Use Price sheet → Paste a list');
  });
});

describe('checkTextRefusal', () => {
  it('refuses markup, lists, over-long and empty text with fixed reasons', () => {
    expect(checkTextRefusal('')).toBe(CHECK_REFUSALS.empty);
    expect(checkTextRefusal('  \n ')).toBe(CHECK_REFUSALS.empty);
    expect(checkTextRefusal('<div class="item">Team Captain</div>')).toBe(CHECK_REFUSALS.markup);
    expect(checkTextRefusal('a\nb\nc\nd')).toBe(CHECK_REFUSALS.list);
    expect(checkTextRefusal('x'.repeat(CHECK_MAX_CHARS + 1))).toBe(CHECK_REFUSALS.tooLong);
  });

  it('lets single items, priced lines, /items rows and two-line copies through', () => {
    for (const t of ['Team Captain', '378;6', 'Team Captain, 1.33 ref', 'Team Captain\t1 key 5 ref\t1 key\t3/12', 'Team Captain\n1 key 5.33 ref', 'a\n\nb\n\nc']) {
      expect(checkTextRefusal(t)).toBeNull();
    }
    expect(checkTextRefusal('x'.repeat(CHECK_MAX_CHARS))).toBeNull();
  });

  it('counts non-blank lines across every line break', () => {
    expect(checkLineCount('a\r\nb\rc\n\n  \nd')).toBe(4);
    expect(checkLineCount('')).toBe(0);
  });

  it('never quotes the text in any reason', () => {
    const secret = 'Team Captain hunter2-SECRET';
    for (const t of [`<b>${secret}</b>`, `${secret}\n${secret}\n${secret}\n${secret}`, secret.repeat(40)]) {
      expect(checkTextRefusal(t)).not.toContain('SECRET');
    }
  });
});

describe('blankCheckResult', () => {
  it('is a result with no item, verdict or money', () => {
    const r = blankCheckResult('not-item', CHECK_NOT_ITEM_REASON, 'watch', 1_000, 7, 568);
    expect(r).toMatchObject({ id: 7, status: 'not-item', source: 'watch', reason: CHECK_NOT_ITEM_REASON, sku: null, verdict: null, price: null, revenue: null, links: [], keyScrap: 568, checkedAt: 1_000 });
    expect(blankCheckResult('refused', 'x', 'hotkey', 1).id).toBe(0);
  });
});

describe('sameAccelerator', () => {
  it('compares chords, not spellings', () => {
    expect(sameAccelerator('Ctrl+Alt+C', 'CommandOrControl+Alt+C')).toBe(true);
    expect(sameAccelerator('Alt+CmdOrCtrl+c', 'Control+Option+C')).toBe(true);
    expect(sameAccelerator('Ctrl+Alt+C', 'Ctrl+Alt+F')).toBe(false);
    expect(sameAccelerator('Ctrl+Shift+C', 'Ctrl+Alt+C')).toBe(false);
  });

  it('never matches an empty (off) hotkey', () => {
    expect(sameAccelerator('', '')).toBe(false);
    expect(sameAccelerator('', 'Ctrl+Alt+C')).toBe(false);
    expect(sameAccelerator('Ctrl++', 'Ctrl++')).toBe(false);
  });
});

describe("settings group 'check'", () => {
  it('defaults: hotkey Ctrl+Alt+C, watcher off, flips notified, popup on', () => {
    expect(DEFAULT_SETTINGS.check).toEqual({ hotkey: 'CommandOrControl+Alt+C', watchClipboard: false, notifyFlips: true, popup: true });
    expect(sameAccelerator(DEFAULT_SETTINGS.check.hotkey, DEFAULT_SETTINGS.app.quickEntryHotkey)).toBe(false);
  });

  it('a settings file from before 0.5 (no group) loads the defaults without reporting anything', () => {
    const { check: _check, ...old } = structuredClone(DEFAULT_SETTINGS);
    const { settings, invalid } = parseSettingsWithReport(old);
    expect(settings.check).toEqual(DEFAULT_SETTINGS.check);
    expect(invalid).toEqual([]);
  });

  it('lenient load: each bad field falls back alone', () => {
    const { settings, invalid } = parseSettingsWithReport({
      ...DEFAULT_SETTINGS,
      check: { hotkey: 'Ctrl+C', watchClipboard: 'yes', notifyFlips: false, popup: false },
    });
    expect(settings.check).toEqual({ hotkey: 'CommandOrControl+Alt+C', watchClipboard: false, notifyFlips: false, popup: false });
    expect(invalid.sort()).toEqual(['check.hotkey', 'check.watchClipboard']);
    const { settings: s2, invalid: i2 } = parseSettingsWithReport({ ...DEFAULT_SETTINGS, check: 'on' });
    expect(s2.check).toEqual(DEFAULT_SETTINGS.check);
    expect(i2).toEqual(['check']);
  });

  it('lenient load: a check hotkey equal to the quick-entry one is turned off, never the quick-entry one', () => {
    const { settings, invalid } = parseSettingsWithReport({
      ...DEFAULT_SETTINGS,
      app: { ...DEFAULT_SETTINGS.app, quickEntryHotkey: 'Ctrl+Alt+C' },
      check: { ...DEFAULT_SETTINGS.check },
    });
    expect(settings.app.quickEntryHotkey).toBe('Ctrl+Alt+C');
    expect(settings.check.hotkey).toBe('');
    expect(invalid).toEqual(['check.hotkey']);
  });

  it('strict update: validates like the quick-entry hotkey, allows off, refuses the same chord either way round', () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    expect(applySettingsPatch(base, { check: { hotkey: 'Ctrl+Shift+F9' } }).check.hotkey).toBe('Ctrl+Shift+F9');
    expect(applySettingsPatch(base, { check: { hotkey: '' } }).check.hotkey).toBe('');
    expect(applySettingsPatch(base, { check: { watchClipboard: true } }).check).toEqual({ ...DEFAULT_SETTINGS.check, watchClipboard: true });
    expect(() => applySettingsPatch(base, { check: { hotkey: 'Ctrl+C' } })).toThrow(SettingsValidationError);
    expect(() => applySettingsPatch(base, { check: { hotkey: 'Ctrl+Alt+F' } })).toThrow(CHECK_HOTKEY_CONFLICT);
    expect(() => applySettingsPatch(base, { app: { quickEntryHotkey: 'Ctrl+Alt+C' } })).toThrow(CHECK_HOTKEY_CONFLICT);
    expect(() => applySettingsPatch(base, { check: { watchClipboard: 'yes' } })).toThrow(SettingsValidationError);
    // Both off is no conflict.
    const off = applySettingsPatch(applySettingsPatch(base, { check: { hotkey: '' } }), { app: { quickEntryHotkey: '' } });
    expect([off.app.quickEntryHotkey, off.check.hotkey]).toEqual(['', '']);
  });

  it('ignores unknown keys in the group', () => {
    const next = applySettingsPatch(structuredClone(DEFAULT_SETTINGS), { check: { popup: false, readHtml: true } });
    expect(next.check).toEqual({ ...DEFAULT_SETTINGS.check, popup: false });
  });
});
