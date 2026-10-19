// Test helper (not a test file): a globalShortcut that behaves like Electron's. One owner per chord
// (spellings of one chord, "Ctrl" and "CommandOrControl", are the same chord), chords in `taken`
// belong to other applications, and an accelerator Electron cannot parse throws.

import { vi } from 'vitest';
import type { GlobalShortcutLike } from '../../src/main/hotkeys';
import { isValidAccelerator, sameAccelerator } from '../../src/shared/accelerator';

export function fakeShortcuts(taken: string[] = []) {
  const held = new Map<string, () => void>();
  const find = (a: string) => [...held.keys()].find((k) => sameAccelerator(k, a));
  const register = vi.fn((a: string, cb: () => void): boolean => {
    if (!isValidAccelerator(a)) throw new TypeError(`Error processing argument: ${a}`);
    if (taken.some((t) => sameAccelerator(t, a)) || find(a) !== undefined) return false;
    held.set(a, cb);
    return true;
  });
  const unregister = vi.fn((a: string): void => {
    const k = find(a);
    if (k !== undefined) held.delete(k);
  });
  const gs: GlobalShortcutLike = { register, unregister };
  return {
    gs,
    register,
    unregister,
    /** Chords held now, as registered. */
    held: () => [...held.keys()],
    /** Presses `a`: runs its callback when held. */
    press: (a: string) => {
      const k = find(a);
      if (k !== undefined) held.get(k)!();
    },
  };
}
