import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsStore, type HotkeyResult, type SettingsEffects } from '../../src/main/settingsStore';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SettingsValidationError } from '../../src/shared/settingsSchema';

const quietLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function fakeEffects(taken: string[] = []) {
  const registered = new Set<string>();
  const login: boolean[] = [];
  const effects: SettingsEffects = {
    applyHotkey: vi.fn((next: string, prev: string | null): HotkeyResult => {
      if (next !== '' && taken.includes(next)) return { ok: false, error: `${next} is taken` };
      if (next !== '') registered.add(next);
      if (prev && prev !== next) registered.delete(prev);
      return { ok: true };
    }),
    applyLoginItem: vi.fn((v: boolean) => {
      login.push(v);
    }),
  };
  return { effects, registered, login };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-settings-'));
  file = path.join(dir, 'settings.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('settings store: loading', () => {
  it('uses defaults when the file is missing, without writing it', () => {
    const s = createSettingsStore({ file, log: quietLog() });
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(file)).toBe(false);
  });

  it('moves a corrupt file aside and starts from defaults', () => {
    writeFileSync(file, '{ not json');
    const log = quietLog();
    const s = createSettingsStore({ file, log, now: () => 123 });
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(`${file}.corrupt-123`)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });

  it('keeps valid fields and logs the invalid ones', () => {
    writeFileSync(
      file,
      JSON.stringify({ ...DEFAULT_SETTINGS, networkPaused: true, profit: { ...DEFAULT_SETTINGS.profit, minMargin: 9 } }),
    );
    const log = quietLog();
    const s = createSettingsStore({ file, log });
    expect(s.get().networkPaused).toBe(true);
    expect(s.get().profit.minMargin).toBe(DEFAULT_SETTINGS.profit.minMargin);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { fields: ['profit.minMargin'] });
  });

  it('never overwrites a settings.json it could not read, and starts with the network paused', () => {
    const real = { ...DEFAULT_SETTINGS, networkPaused: true, blocklist: ['5021;6'] };
    writeFileSync(file, JSON.stringify(real));
    const before = readFileSync(file, 'utf8');
    const writeFile = vi.fn();
    const log = quietLog();
    const readFile = vi.fn((): string => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    const s = createSettingsStore({ file, log, readFile, writeFile });
    expect(s.get().networkPaused).toBe(true);
    const listener = vi.fn();
    s.onChange(listener);

    // The tray's pause toggles still work for this session...
    expect(s.set({ liveFeed: { enabled: false } }).liveFeed.enabled).toBe(false);
    expect(s.get().liveFeed.enabled).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    // ...but defaults never replace the user's file.
    expect(writeFile).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/not saved/));
  });

  it('applies a change on top of the real file once it can be read again', () => {
    const real = { ...DEFAULT_SETTINGS, networkPaused: false, profit: { ...DEFAULT_SETTINGS.profit, minProfitScrap: 27 } };
    writeFileSync(file, JSON.stringify(real));
    let locked = true;
    const readFile = vi.fn((f: string): string => {
      if (locked) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return readFileSync(f, 'utf8');
    });
    const s = createSettingsStore({ file, log: quietLog(), readFile });
    expect(s.get().profit.minProfitScrap).toBe(DEFAULT_SETTINGS.profit.minProfitScrap);
    locked = false;
    const next = s.set({ liveFeed: { enabled: false } });
    expect(next.profit.minProfitScrap).toBe(27);
    expect(next.networkPaused).toBe(false);
    expect(next.liveFeed.enabled).toBe(false);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.profit.minProfitScrap).toBe(27);
    expect(onDisk.liveFeed.enabled).toBe(false);
  });

  it('keeps refusing to write after an invalid patch while the file is still unreadable', () => {
    writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS));
    const writeFile = vi.fn();
    const readFile = vi.fn((): string => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    const s = createSettingsStore({ file, log: quietLog(), readFile, writeFile });
    expect(() => s.set({ notifications: { minConfidence: 500 } })).toThrow(SettingsValidationError);
    s.set({ networkPaused: false });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('returns a deeply frozen object', () => {
    const s = createSettingsStore({ file, log: quietLog() });
    const cur = s.get();
    expect(Object.isFrozen(cur)).toBe(true);
    expect(Object.isFrozen(cur.profit.notesKeywords)).toBe(true);
    expect(() => {
      (cur as { networkPaused: boolean }).networkPaused = true;
    }).toThrow();
  });
});

describe('settings store: updates', () => {
  it('merges, persists atomically and notifies listeners with next and prev', () => {
    const s = createSettingsStore({ file, log: quietLog() });
    const seen: [boolean, boolean][] = [];
    s.onChange((next, prev) => seen.push([next.networkPaused, prev.networkPaused]));
    const next = s.set({ networkPaused: true, profit: { minProfitScrap: 27 } });
    expect(next.networkPaused).toBe(true);
    expect(next.profit.minProfitScrap).toBe(27);
    expect(seen).toEqual([[true, false]]);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.networkPaused).toBe(true);
    expect(onDisk.profit.minProfitScrap).toBe(27);
    expect(readdirSync(dir)).toEqual(['settings.json']);
    expect(createSettingsStore({ file, log: quietLog() }).get()).toEqual(next);
  });

  it('does not write or notify for a no-op patch', () => {
    const writeFile = vi.fn();
    const s = createSettingsStore({ file, log: quietLog(), writeFile });
    const listener = vi.fn();
    s.onChange(listener);
    s.set({ networkPaused: false });
    s.set({});
    s.set(undefined);
    expect(writeFile).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects invalid patches without writing', () => {
    const writeFile = vi.fn();
    const s = createSettingsStore({ file, log: quietLog(), writeFile });
    expect(() => s.set({ notifications: { minConfidence: 500 } })).toThrow(SettingsValidationError);
    expect(() => s.set({ import: { enabled: true } })).toThrow(/acknowledgement/);
    expect(() => s.set('x')).toThrow(SettingsValidationError);
    expect(writeFile).not.toHaveBeenCalled();
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the old settings and throws a plain error when the disk write fails', () => {
    const log = quietLog();
    const s = createSettingsStore({
      file,
      log,
      writeFile: () => {
        throw new Error('EACCES: C:\\Users\\me\\AppData\\settings.json');
      },
    });
    expect(() => s.set({ networkPaused: true })).toThrow('Could not save settings to disk.');
    expect(s.get().networkPaused).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });

  it('isolates a failing listener', () => {
    const log = quietLog();
    const s = createSettingsStore({ file, log });
    const good = vi.fn();
    s.onChange(() => {
      throw new Error('listener bug');
    });
    s.onChange(good);
    s.set({ networkPaused: true });
    expect(good).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const s = createSettingsStore({ file, log: quietLog() });
    const l = vi.fn();
    const off = s.onChange(l);
    off();
    s.set({ networkPaused: true });
    expect(l).not.toHaveBeenCalled();
  });
});

describe('settings store: hotkey and login item', () => {
  it('registers the stored hotkey and syncs the login item at startup', () => {
    const { effects, registered, login } = fakeEffects();
    const s = createSettingsStore({ file, log: quietLog(), effects });
    expect(s.applyStartupEffects()).toEqual({ accelerator: 'CommandOrControl+Alt+F', registered: true, error: null });
    expect(registered.has('CommandOrControl+Alt+F')).toBe(true);
    expect(login).toEqual([false]);
    expect(s.hotkeyStatus().registered).toBe(true);
  });

  it('surfaces a startup hotkey that is taken without throwing', () => {
    const { effects } = fakeEffects(['CommandOrControl+Alt+F']);
    const log = quietLog();
    const s = createSettingsStore({ file, log, effects });
    const st = s.applyStartupEffects();
    expect(st.registered).toBe(false);
    expect(st.error).toContain('taken');
    expect(log.warn).toHaveBeenCalled();
  });

  it('switches the hotkey: registers the new one before releasing the old one', () => {
    const { effects, registered } = fakeEffects();
    const s = createSettingsStore({ file, log: quietLog(), effects });
    s.applyStartupEffects();
    s.set({ app: { quickEntryHotkey: 'Ctrl+Shift+Q' } });
    expect(effects.applyHotkey).toHaveBeenLastCalledWith('Ctrl+Shift+Q', 'CommandOrControl+Alt+F');
    expect([...registered]).toEqual(['Ctrl+Shift+Q']);
    expect(s.hotkeyStatus()).toEqual({ accelerator: 'Ctrl+Shift+Q', registered: true, error: null });
    expect(JSON.parse(readFileSync(file, 'utf8')).app.quickEntryHotkey).toBe('Ctrl+Shift+Q');
  });

  it('refuses a taken hotkey: nothing saved, old hotkey kept, other fields in the patch not applied', () => {
    const { effects, registered } = fakeEffects(['Ctrl+Alt+T']);
    const writeFile = vi.fn();
    const s = createSettingsStore({ file, log: quietLog(), effects, writeFile });
    s.applyStartupEffects();
    expect(() => s.set({ app: { quickEntryHotkey: 'Ctrl+Alt+T' }, networkPaused: true })).toThrow(/taken/);
    expect(writeFile).not.toHaveBeenCalled();
    expect(s.get().app.quickEntryHotkey).toBe('CommandOrControl+Alt+F');
    expect(s.get().networkPaused).toBe(false);
    expect(registered.has('CommandOrControl+Alt+F')).toBe(true);
  });

  it('passes no previous hotkey when the old one never registered', () => {
    const { effects } = fakeEffects(['CommandOrControl+Alt+F']);
    const s = createSettingsStore({ file, log: quietLog(), effects });
    s.applyStartupEffects();
    s.set({ app: { quickEntryHotkey: 'Ctrl+Alt+G' } });
    expect(effects.applyHotkey).toHaveBeenLastCalledWith('Ctrl+Alt+G', null);
    expect(s.hotkeyStatus().registered).toBe(true);
  });

  it('can disable the hotkey with an empty string', () => {
    const { effects, registered } = fakeEffects();
    const s = createSettingsStore({ file, log: quietLog(), effects });
    s.applyStartupEffects();
    s.set({ app: { quickEntryHotkey: '' } });
    expect(registered.size).toBe(0);
    expect(s.hotkeyStatus()).toEqual({ accelerator: '', registered: false, error: null });
  });

  it('restores the previous hotkey when saving fails', () => {
    const { effects, registered } = fakeEffects();
    const s = createSettingsStore({
      file,
      log: quietLog(),
      effects,
      writeFile: () => {
        throw new Error('disk');
      },
    });
    s.applyStartupEffects();
    expect(() => s.set({ app: { quickEntryHotkey: 'Ctrl+Alt+H' } })).toThrow('Could not save');
    expect(effects.applyHotkey).toHaveBeenLastCalledWith('CommandOrControl+Alt+F', 'Ctrl+Alt+H');
    expect([...registered]).toEqual(['CommandOrControl+Alt+F']);
  });

  it('turns an effect exception into a refusal', () => {
    const effects: SettingsEffects = {
      applyHotkey: () => {
        throw new Error('native failure');
      },
      applyLoginItem: vi.fn(),
    };
    const s = createSettingsStore({ file, log: quietLog(), effects });
    expect(() => s.set({ app: { quickEntryHotkey: 'Ctrl+Alt+J' } })).toThrow('native failure');
  });

  it('applies the login item only when startAtLogin changes, and tolerates its failure', () => {
    const log = quietLog();
    const effects: SettingsEffects = {
      applyHotkey: () => ({ ok: true }),
      applyLoginItem: vi.fn(() => {
        throw new Error('registry');
      }),
    };
    const s = createSettingsStore({ file, log, effects });
    s.set({ networkPaused: true });
    expect(effects.applyLoginItem).not.toHaveBeenCalled();
    s.set({ app: { startAtLogin: true } });
    expect(effects.applyLoginItem).toHaveBeenCalledWith(true);
    expect(s.get().app.startAtLogin).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });
});
