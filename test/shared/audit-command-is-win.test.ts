// Audit holdings-2: Electron reads a bare Command/Cmd as the Win key on Windows (the same as
// Super/Meta), and Settings labels it 'Win'; only CommandOrControl/CmdOrCtrl mean Ctrl.
import { describe, expect, it } from 'vitest';
import { accelLabel } from '../../src/renderer/format';
import { CHECK_HOTKEY_CONFLICT_ERROR, QUICK_HOTKEY_CONFLICT_ERROR, validateCheckHotkey, validateQuickEntryHotkey } from '../../src/renderer/settingsFields';
import { isReservedAccelerator, isValidAccelerator, sameAccelerator } from '../../src/shared/accelerator';
import { CHECK_HOTKEY_CONFLICT } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { applySettingsPatch, parseSettingsWithReport } from '../../src/shared/settingsSchema';
import type { Settings } from '../../src/shared/types';

function withQuickEntry(quickEntryHotkey: string): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.app.quickEntryHotkey = quickEntryHotkey;
  return s;
}

describe('Command/Cmd is the Win key', () => {
  it('compares chords as Electron registers them', () => {
    expect(sameAccelerator('Command+Alt+C', 'Ctrl+Alt+C')).toBe(false);
    expect(sameAccelerator('Cmd+Alt+C', 'CommandOrControl+Alt+C')).toBe(false);
    expect(sameAccelerator('Command+Alt+K', 'Super+Alt+K')).toBe(true);
    expect(sameAccelerator('Cmd+Alt+K', 'Meta+Alt+K')).toBe(true);
    expect(sameAccelerator('CmdOrCtrl+Alt+C', 'Ctrl+Alt+C')).toBe(true);
  });

  it('is not read as a Ctrl system shortcut', () => {
    expect(isReservedAccelerator('Command+S')).toBe(false);
    expect(isReservedAccelerator('Cmd+C')).toBe(false);
    expect(isValidAccelerator('Command+S')).toBe(true);
    expect(isReservedAccelerator('CmdOrCtrl+C')).toBe(true);
  });

  it('matches what the Settings page shows', () => {
    for (const [a, b] of [
      ['Command+Alt+K', 'Super+Alt+K'],
      ['Cmd+Alt+K', 'Meta+Alt+K'],
    ] as const) {
      expect(sameAccelerator(a, b)).toBe(true);
      expect(accelLabel(a)).toBe('Win+Alt+K');
      expect(accelLabel(b)).toBe('Win+Alt+K');
    }
    expect(accelLabel('Command+Alt+C')).not.toBe(accelLabel('Ctrl+Alt+C'));
  });

  it('drives the renderer hotkey checks', () => {
    expect(validateCheckHotkey('Command+Alt+C', 'Ctrl+Alt+C')).toBeNull();
    expect(validateCheckHotkey('Command+Alt+K', 'Super+Alt+K')).toBe(CHECK_HOTKEY_CONFLICT_ERROR);
    expect(validateQuickEntryHotkey('Meta+Alt+K', 'Cmd+Alt+K')).toBe(QUICK_HOTKEY_CONFLICT_ERROR);
  });

  it('drives settings.set and the settings.json load', () => {
    expect(applySettingsPatch(withQuickEntry('Ctrl+Alt+C'), { check: { hotkey: 'Command+Alt+C' } }).check.hotkey).toBe('Command+Alt+C');
    expect(() => applySettingsPatch(withQuickEntry('Super+Alt+K'), { check: { hotkey: 'Command+Alt+K' } })).toThrow(CHECK_HOTKEY_CONFLICT);

    const raw = withQuickEntry('Super+Alt+K');
    raw.check.hotkey = 'Command+Alt+K';
    const { settings, invalid } = parseSettingsWithReport(JSON.parse(JSON.stringify(raw)));
    expect(settings.check.hotkey).toBe('');
    expect(settings.app.quickEntryHotkey).toBe('Super+Alt+K');
    expect(invalid).toContain('check.hotkey');
  });
});
