import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsStore, type HotkeyResult, type SettingsEffects } from '../../src/main/settingsStore';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

// Audit mainshell-1: a settings.json that exists but cannot be read must not have its login item
// replaced by the in-memory default (false) at startup.

const quietLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function fakeEffects() {
  const ok = (): HotkeyResult => ({ ok: true });
  const effects = {
    applyHotkey: vi.fn((_next: string, _prev: string | null) => ok()),
    applyCheckHotkey: vi.fn((_next: string, _prev: string | null) => ok()),
    applyLoginItem: vi.fn((_v: boolean) => undefined),
  } satisfies SettingsEffects;
  return effects;
}

const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit-login-'));
  file = path.join(dir, 'settings.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The user's file: starts at login, both hotkeys off. */
function writeUserFile(): string {
  const real = {
    ...DEFAULT_SETTINGS,
    app: { ...DEFAULT_SETTINGS.app, startAtLogin: true, quickEntryHotkey: '' },
    check: { ...DEFAULT_SETTINGS.check, hotkey: '' },
  };
  writeFileSync(file, JSON.stringify(real));
  return readFileSync(file, 'utf8');
}

describe('settings store: startup effects while settings.json cannot be read', () => {
  it('leaves the login item alone and never writes the file', () => {
    const before = writeUserFile();
    const effects = fakeEffects();
    const writeFile = vi.fn();
    const log = quietLog();
    const readFile = vi.fn((): string => {
      throw busy();
    });
    const s = createSettingsStore({ file, log, effects, readFile, writeFile });
    s.applyStartupEffects();
    expect(effects.applyLoginItem).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/login item/));
    // The session-only hotkeys still get the default chords (set() reconciles them with the file later).
    expect(effects.applyHotkey).toHaveBeenCalledWith(DEFAULT_SETTINGS.app.quickEntryHotkey, null);
    expect(effects.applyCheckHotkey).toHaveBeenCalledWith(DEFAULT_SETTINGS.check.hotkey, null);
  });

  it('syncs the login item and the hotkeys with the file once it can be read and is saved again', () => {
    writeUserFile();
    const effects = fakeEffects();
    let locked = true;
    const readFile = vi.fn((f: string): string => {
      if (locked) throw busy();
      return readFileSync(f, 'utf8');
    });
    const s = createSettingsStore({ file, log: quietLog(), effects, readFile });
    s.applyStartupEffects();
    locked = false;
    s.set({ liveFeed: { enabled: false } });
    expect(effects.applyLoginItem).toHaveBeenCalledTimes(1);
    expect(effects.applyLoginItem).toHaveBeenCalledWith(true);
    expect(s.hotkeyStatus()).toEqual({ accelerator: '', registered: false, error: null });
    expect(s.checkHotkeyStatus()).toEqual({ accelerator: '', registered: false, error: null });
    expect(JSON.parse(readFileSync(file, 'utf8')).app.startAtLogin).toBe(true);
  });

  it('syncs the login item to the defaults when the file turns out to be gone', () => {
    writeUserFile();
    const effects = fakeEffects();
    let locked = true;
    const readFile = vi.fn((f: string): string => {
      if (locked) throw busy();
      return readFileSync(f, 'utf8');
    });
    const s = createSettingsStore({ file, log: quietLog(), effects, readFile });
    s.applyStartupEffects();
    unlinkSync(file);
    locked = false;
    s.set({ liveFeed: { enabled: false } });
    expect(effects.applyLoginItem).toHaveBeenCalledTimes(1);
    expect(effects.applyLoginItem).toHaveBeenCalledWith(false);
  });

  it("still applies the user's own startAtLogin change for the session, without saving it", () => {
    writeUserFile();
    const effects = fakeEffects();
    const writeFile = vi.fn();
    const readFile = vi.fn((): string => {
      throw busy();
    });
    const s = createSettingsStore({ file, log: quietLog(), effects, readFile, writeFile });
    s.applyStartupEffects();
    s.set({ app: { startAtLogin: true } });
    expect(effects.applyLoginItem).toHaveBeenCalledTimes(1);
    expect(effects.applyLoginItem).toHaveBeenCalledWith(true);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('a readable file still syncs its own login item at startup, and a missing one the default', () => {
    writeUserFile();
    const readable = fakeEffects();
    createSettingsStore({ file, log: quietLog(), effects: readable }).applyStartupEffects();
    expect(readable.applyLoginItem.mock.calls).toEqual([[true]]);

    rmSync(file);
    const missing = fakeEffects();
    createSettingsStore({ file, log: quietLog(), effects: missing }).applyStartupEffects();
    expect(missing.applyLoginItem.mock.calls).toEqual([[false]]);
  });
});
