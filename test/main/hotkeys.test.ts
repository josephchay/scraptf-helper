// Global hotkey registration (src/main/hotkeys.ts), against a fake globalShortcut that behaves like
// Electron's: one owner per chord (spellings of one chord are the same chord), taken chords refused,
// unparsable accelerators throw. Plus the start-up notice for hotkeys that could not be registered.

import { describe, expect, it, vi } from 'vitest';
import { applyGlobalHotkey, hotkeyTakenMessage, startupHotkeyNotice } from '../../src/main/hotkeys';
import { fakeShortcuts } from './fakeShortcuts';

describe('applyGlobalHotkey', () => {
  it('registers a free chord and releases the previous one', () => {
    const f = fakeShortcuts();
    const trigger = vi.fn();
    expect(applyGlobalHotkey(f.gs, 'Ctrl+Alt+F', null, trigger)).toEqual({ ok: true });
    expect(applyGlobalHotkey(f.gs, 'Ctrl+Alt+G', 'Ctrl+Alt+F', trigger)).toEqual({ ok: true });
    expect(f.held()).toEqual(['Ctrl+Alt+G']);
    f.press('Ctrl+Alt+G');
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('re-spells a chord it already holds ("Ctrl" to "CommandOrControl")', () => {
    const f = fakeShortcuts();
    const trigger = vi.fn();
    applyGlobalHotkey(f.gs, 'Ctrl+Alt+F', null, trigger);
    expect(applyGlobalHotkey(f.gs, 'CommandOrControl+Alt+F', 'Ctrl+Alt+F', trigger)).toEqual({ ok: true });
    expect(f.held()).toEqual(['CommandOrControl+Alt+F']);
  });

  it('refuses a taken chord and keeps the previous one working', () => {
    const f = fakeShortcuts(['Ctrl+Alt+T']);
    const trigger = vi.fn();
    applyGlobalHotkey(f.gs, 'Ctrl+Alt+F', null, trigger);
    expect(applyGlobalHotkey(f.gs, 'Ctrl+Alt+T', 'Ctrl+Alt+F', trigger)).toEqual({ ok: false, error: hotkeyTakenMessage('Ctrl+Alt+T') });
    expect(f.held()).toEqual(['Ctrl+Alt+F']);
    f.press('Ctrl+Alt+F');
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('turns a throwing register into a refusal, and "" into a release', () => {
    const f = fakeShortcuts();
    expect(applyGlobalHotkey(f.gs, 'Nope+', null, vi.fn())).toMatchObject({ ok: false });
    applyGlobalHotkey(f.gs, 'Ctrl+Alt+F', null, vi.fn());
    expect(applyGlobalHotkey(f.gs, '', 'Ctrl+Alt+F', vi.fn())).toEqual({ ok: true });
    expect(f.held()).toEqual([]);
    expect(applyGlobalHotkey(f.gs, '', null, vi.fn())).toEqual({ ok: true });
  });
});

describe('startupHotkeyNotice', () => {
  const ok = (accelerator: string) => ({ accelerator, registered: true, error: null });
  const bad = (accelerator: string) => ({ accelerator, registered: false, error: 'taken' });

  it('says nothing when both registered (or are off)', () => {
    expect(startupHotkeyNotice(ok('Ctrl+Alt+F'), ok('Ctrl+Alt+C'))).toBeNull();
    expect(startupHotkeyNotice({ accelerator: '', registered: false, error: null }, ok('Ctrl+Alt+C'))).toBeNull();
  });

  it('names the hotkey that failed, or both in one notice', () => {
    expect(startupHotkeyNotice(bad('Ctrl+Alt+F'), ok('Ctrl+Alt+C'))).toEqual({
      title: 'Quick-entry hotkey unavailable',
      body: 'Ctrl+Alt+F is already in use. Choose another shortcut in Settings.',
    });
    expect(startupHotkeyNotice(ok('Ctrl+Alt+F'), bad('Ctrl+Alt+C'))).toEqual({
      title: 'Live check hotkey unavailable',
      body: 'Ctrl+Alt+C is already in use. Choose another shortcut in Settings > Live check.',
    });
    expect(startupHotkeyNotice(bad('Ctrl+Alt+F'), bad('Ctrl+Alt+C'))?.title).toBe('Hotkeys unavailable');
  });
});
