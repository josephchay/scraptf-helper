// Global hotkeys (quick entry, and the live check's since F16): registration through Electron's
// globalShortcut, injected so the fallback rules are unit-tested, and the start-up notice when a
// stored hotkey is taken. Which hotkey changes when is settingsStore.ts's job.

import type { HotkeyResult, HotkeyStatus } from './settingsStore';

/** The two globalShortcut calls used (Electron's module in main, a fake in tests). */
export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export function hotkeyTakenMessage(accelerator: string): string {
  return `"${accelerator}" is already used by another application or is not a valid shortcut.`;
}

function tryRegister(shortcuts: GlobalShortcutLike, accelerator: string, onTrigger: () => void): boolean {
  try {
    return shortcuts.register(accelerator, onTrigger);
  } catch {
    // An accelerator Electron cannot parse throws instead of returning false.
    return false;
  }
}

/**
 * Registers `next` ('' = none) for `onTrigger` and releases `prev`. When it fails, `prev` still
 * works: the SettingsEffects contract, so a refused change is never saved with a dead hotkey.
 */
export function applyGlobalHotkey(shortcuts: GlobalShortcutLike, next: string, prev: string | null, onTrigger: () => void): HotkeyResult {
  if (next === '') {
    if (prev) shortcuts.unregister(prev);
    return { ok: true };
  }
  let ok = tryRegister(shortcuts, next, onTrigger);
  // "Ctrl+Alt+F" -> "CommandOrControl+Alt+F" is the same key combination we already hold.
  if (!ok && prev) {
    shortcuts.unregister(prev);
    ok = tryRegister(shortcuts, next, onTrigger);
    if (!ok) tryRegister(shortcuts, prev, onTrigger);
    return ok ? { ok: true } : { ok: false, error: hotkeyTakenMessage(next) };
  }
  if (!ok) return { ok: false, error: hotkeyTakenMessage(next) };
  if (prev && prev !== next) shortcuts.unregister(prev);
  return { ok: true };
}

/** One desktop notice for the stored hotkeys that could not be registered at start-up; null when both are fine. */
export function startupHotkeyNotice(quick: HotkeyStatus, check: HotkeyStatus): { title: string; body: string } | null {
  const quickFailed = quick.error !== null && quick.accelerator !== '';
  const checkFailed = check.error !== null && check.accelerator !== '';
  if (quickFailed && checkFailed) {
    return {
      title: 'Hotkeys unavailable',
      body: `${quick.accelerator} and ${check.accelerator} are already in use. Choose other shortcuts in Settings.`,
    };
  }
  if (quickFailed) {
    return { title: 'Quick-entry hotkey unavailable', body: `${quick.accelerator} is already in use. Choose another shortcut in Settings.` };
  }
  if (checkFailed) {
    return {
      title: 'Live check hotkey unavailable',
      body: `${check.accelerator} is already in use. Choose another shortcut in Settings > Live check.`,
    };
  }
  return null;
}
