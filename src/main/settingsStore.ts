// settings.json in userData: validated on load (per-field fallback), validated
// and merged on update, written atomically. A file that exists but cannot be
// read is never overwritten: the app starts with the network paused and keeps
// changes in memory until the file can be read again. Side effects that can
// fail (the global hotkeys: quick entry and, since F16, the live check) run
// before the change is committed so a refused hotkey never gets saved; the
// login item follows startAtLogin. Listeners get every committed change (main
// pushes it to the service and to renderers).

import { renameSync } from 'node:fs';
import type { Logger } from '../service/contracts';
import type { HotkeyState } from '../shared/rpc';
import { applySettingsPatch, parseSettingsWithReport, SettingsValidationError } from '../shared/settingsSchema';
import type { Settings } from '../shared/types';
import { readFileRetrySync, writeFileAtomicSync } from './paths';

export type HotkeyResult = { ok: true } | { ok: false; error: string };

export interface SettingsEffects {
  /** Registers `next` (empty = none) and releases `prev`. Must leave `prev` working when it fails. */
  applyHotkey(next: string, prev: string | null): HotkeyResult;
  /** F16: the live check hotkey (`check.hotkey`), with the same contract as applyHotkey. */
  applyCheckHotkey?(next: string, prev: string | null): HotkeyResult;
  applyLoginItem(openAtLogin: boolean): void;
}

/** The shared shape, so 'app.hotkeys' hands main's own status to Settings unchanged. */
export type HotkeyStatus = HotkeyState;

export interface SettingsStore {
  /** Deeply frozen; clone before modifying. */
  get(): Settings;
  /** Validates, merges and saves a DeepPartial<Settings>. Throws SettingsValidationError. */
  set(patch: unknown): Settings;
  onChange(listener: (next: Settings, prev: Settings) => void): () => void;
  /**
   * Registers the stored hotkeys and syncs the login item; call once after app 'ready'. Returns the
   * quick-entry hotkey's status; checkHotkeyStatus() has the live check's.
   */
  applyStartupEffects(): HotkeyStatus;
  hotkeyStatus(): HotkeyStatus;
  /** F16: the live check hotkey (`check.hotkey`). */
  checkHotkeyStatus(): HotkeyStatus;
}

export interface SettingsStoreOptions {
  file: string;
  log: Logger;
  effects?: SettingsEffects;
  readFile?: (file: string) => string;
  writeFile?: (file: string, data: string) => void;
  now?: () => number;
}

function deepFreeze<T>(obj: T): T {
  if (typeof obj === 'object' && obj !== null && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

type HotkeyId = 'quick' | 'check';

interface HotkeySlot {
  id: HotkeyId;
  /** For log lines. */
  label: string;
  of(s: Settings): string;
  status: HotkeyStatus;
}

type LoadResult =
  | { state: 'ok'; settings: Settings }
  /** No file, or a corrupt one that was moved aside: nothing on disk to protect. */
  | { state: 'fresh'; settings: Settings }
  /** The file exists but could not be read (locked, permissions): never overwrite it blindly. */
  | { state: 'unreadable' };

export function createSettingsStore(opts: SettingsStoreOptions): SettingsStore {
  const { log } = opts;
  const readFile = opts.readFile ?? ((f: string) => readFileRetrySync(f));
  const writeFile = opts.writeFile ?? ((f: string, d: string) => writeFileAtomicSync(f, d));
  const now = opts.now ?? Date.now;
  const listeners = new Set<(next: Settings, prev: Settings) => void>();
  const defaults = (): Settings => parseSettingsWithReport(undefined).settings;

  function load(): LoadResult {
    let text: string;
    try {
      text = readFile(opts.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'fresh', settings: defaults() };
      log.warn('could not read settings.json', err);
      return { state: 'unreadable' };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      const backup = `${opts.file}.corrupt-${now()}`;
      try {
        renameSync(opts.file, backup);
        log.warn(`settings.json was not valid JSON; moved it to ${backup} and started from defaults`);
      } catch {
        log.warn('settings.json was not valid JSON; using defaults');
      }
      return { state: 'fresh', settings: defaults() };
    }
    const { settings, invalid } = parseSettingsWithReport(raw);
    if (invalid.length > 0) log.warn('settings.json had invalid values; defaults used for them', { fields: invalid.slice(0, 50) });
    return { state: 'ok', settings };
  }

  const initial = load();
  /** True while settings.json exists but could not be read: changes then stay in memory. */
  let unreadable = initial.state === 'unreadable';
  if (unreadable) log.warn('settings.json is kept untouched; starting from defaults with the network paused until it can be read');
  // Fail closed: the stored "Pause all network" switch may have been on.
  let current: Settings = deepFreeze(initial.state === 'unreadable' ? { ...defaults(), networkPaused: true } : initial.settings);
  const quick: HotkeySlot = {
    id: 'quick',
    label: 'quick-entry',
    of: (s) => s.app.quickEntryHotkey,
    status: { accelerator: current.app.quickEntryHotkey, registered: false, error: null },
  };
  const check: HotkeySlot = {
    id: 'check',
    label: 'live check',
    of: (s) => s.check.hotkey,
    status: { accelerator: current.check.hotkey, registered: false, error: null },
  };
  const slots: readonly HotkeySlot[] = [quick, check];

  /** What a change applies to (the file's own settings once it can be read again) and whether it may be saved. */
  function baseForChange(): { base: Settings; canWrite: boolean } {
    if (!unreadable) return { base: current, canWrite: true };
    const again = load();
    if (again.state === 'unreadable') return { base: current, canWrite: false };
    if (again.state === 'ok') {
      log.info('settings.json can be read again; applying the change on top of it');
      return { base: again.settings, canWrite: true };
    }
    // Gone, or corrupt and moved aside: nothing left to protect.
    return { base: current, canWrite: true };
  }

  function persist(s: Settings): void {
    writeFile(opts.file, `${JSON.stringify(s, null, 2)}\n`);
  }

  function applyLogin(openAtLogin: boolean): void {
    try {
      opts.effects?.applyLoginItem(openAtLogin);
    } catch (err) {
      log.warn('could not update the login item', err);
    }
  }

  function tryHotkey(slot: HotkeySlot, next: string, prev: string | null): HotkeyResult {
    const effects = opts.effects;
    if (!effects) return { ok: true };
    try {
      if (slot.id === 'quick') return effects.applyHotkey(next, prev);
      return effects.applyCheckHotkey ? effects.applyCheckHotkey(next, prev) : { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Registers the hotkeys `next` changes before anything is saved. Throws SettingsValidationError
   * (Settings shows it) when one is refused, with the old ones working again. Returns the changed
   * slots and how to undo their registration when the save fails.
   */
  function applyHotkeyChanges(prev: Settings, next: Settings): { changed: HotkeySlot[]; undo(): void } {
    const changed = slots.filter((s) => s.of(next) !== s.of(prev));
    if (changed.length === 0) return { changed, undo: () => undefined };
    if (changed.length === 1) {
      const slot = changed[0]!;
      const r = tryHotkey(slot, slot.of(next), slot.status.registered ? slot.of(prev) : null);
      if (!r.ok) throw new SettingsValidationError(r.error);
      return { changed, undo: () => void tryHotkey(slot, slot.of(prev), slot.of(next)) };
    }
    // Both in one patch (a swap, or one taking the chord the other gives up): registering either
    // first would find its chord still held by the other, so both are released, then both registered.
    const held = changed.filter((s) => s.status.registered);
    for (const s of held) tryHotkey(s, '', s.of(prev));
    const done: HotkeySlot[] = [];
    const undo = () => {
      for (const s of done) tryHotkey(s, '', s.of(next));
      for (const s of held) tryHotkey(s, s.of(prev), null);
    };
    for (const s of changed) {
      const r = tryHotkey(s, s.of(next), null);
      if (!r.ok) {
        undo();
        throw new SettingsValidationError(r.error);
      }
      done.push(s);
    }
    return { changed, undo };
  }

  function registerAtStartup(slot: HotkeySlot): HotkeyStatus {
    const accel = slot.of(current);
    if (accel === '') {
      slot.status = { accelerator: '', registered: false, error: null };
      return slot.status;
    }
    const r = tryHotkey(slot, accel, null);
    slot.status = r.ok ? { accelerator: accel, registered: true, error: null } : { accelerator: accel, registered: false, error: r.error };
    if (!r.ok) log.warn(`${slot.label} hotkey ${accel} could not be registered: ${r.error}`);
    return slot.status;
  }

  return {
    get: () => current,

    set(patch) {
      const prev = current;
      const { base, canWrite } = baseForChange();
      const next = applySettingsPatch(base, patch);
      if (JSON.stringify(next) === JSON.stringify(prev)) return prev;

      const hotkeys = applyHotkeyChanges(prev, next);

      try {
        // Writing now would replace the user's real file with defaults plus this change.
        if (!canWrite) log.warn('settings.json still cannot be read; this change applies until the app quits but is not saved');
        else persist(next);
      } catch (err) {
        hotkeys.undo();
        log.error('could not save settings.json', err);
        throw new Error('Could not save settings to disk.');
      }

      for (const slot of hotkeys.changed) {
        const accel = slot.of(next);
        slot.status = { accelerator: accel, registered: accel !== '', error: null };
      }
      if (canWrite) unreadable = false;
      current = deepFreeze(next);
      if (next.app.startAtLogin !== prev.app.startAtLogin) applyLogin(next.app.startAtLogin);

      for (const fn of listeners) {
        try {
          fn(current, prev);
        } catch (err) {
          log.error('settings listener failed', err);
        }
      }
      return current;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    applyStartupEffects() {
      applyLogin(current.app.startAtLogin);
      // The settings schema keeps the two chords apart, so neither can take the other's.
      const status = registerAtStartup(quick);
      registerAtStartup(check);
      return status;
    },

    hotkeyStatus: () => quick.status,
    checkHotkeyStatus: () => check.status,
  };
}
