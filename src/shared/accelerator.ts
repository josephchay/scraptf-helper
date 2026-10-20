// Electron accelerator rules for the global quick-entry hotkey. No zod, so the
// renderer can validate with exactly the rule main enforces (settingsSchema).

const ACCELERATOR_MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
]);
// Shift alone is not enough for a system-wide hotkey: it would swallow normal typing.
const STRONG_MODIFIERS = new Set([...ACCELERATOR_MODIFIERS].filter((m) => m !== 'shift'));
const NAMED_KEYS = new Set([
  'plus',
  'space',
  'tab',
  'capslock',
  'numlock',
  'scrolllock',
  'backspace',
  'delete',
  'insert',
  'return',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'escape',
  'esc',
  'volumeup',
  'volumedown',
  'volumemute',
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'mediaplaypause',
  'printscreen',
  'numdec',
  'numadd',
  'numsub',
  'nummult',
  'numdiv',
]);
const PUNCTUATION_KEYS = new Set([...')!@#$%^&*(:;=<,_->.?/~`{]}[|\\"\'']);

function isAcceleratorKey(token: string): boolean {
  const t = token.toLowerCase();
  if (/^[a-z0-9]$/.test(t)) return true;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) return true;
  if (/^num[0-9]$/.test(t)) return true;
  return NAMED_KEYS.has(t) || PUNCTUATION_KEYS.has(token);
}

/**
 * Modifier aliases folded to one canonical name; AltGr is Ctrl+Alt on Windows. 0.7.3: a bare
 * Command/Cmd is the Win key, like Super/Meta (Electron registers it so, and accelLabel shows 'Win');
 * only CommandOrControl/CmdOrCtrl mean Ctrl.
 */
const CANONICAL_MODIFIER: Record<string, readonly string[]> = {
  command: ['super'],
  cmd: ['super'],
  control: ['ctrl'],
  ctrl: ['ctrl'],
  commandorcontrol: ['ctrl'],
  cmdorctrl: ['ctrl'],
  alt: ['alt'],
  option: ['alt'],
  altgr: ['alt', 'ctrl'],
  shift: ['shift'],
  super: ['super'],
  meta: ['super'],
};
const CANONICAL_KEY: Record<string, string> = { esc: 'escape', return: 'enter' };

/**
 * System and everyday app shortcuts. A global hotkey takes its chord away from
 * every other application while registered (Windows RegisterHotKey), so
 * registering Ctrl+C would break copy everywhere. Chords the OS reserves anyway
 * (Win+L, Ctrl+Alt+Del) fail to register and need no entry.
 */
const RESERVED_ACCELERATORS: ReadonlySet<string> = new Set([
  'ctrl+a',
  'ctrl+c',
  'ctrl+v',
  'ctrl+x',
  'ctrl+z',
  'ctrl+y',
  'ctrl+shift+z',
  'ctrl+s',
  'ctrl+f',
  'ctrl+w',
  'ctrl+t',
  'ctrl+n',
  'ctrl+p',
  'ctrl+tab',
  'ctrl+shift+tab',
  'ctrl+escape',
  'ctrl+shift+escape',
  'alt+f4',
  'alt+tab',
  'alt+shift+tab',
  'alt+escape',
  'alt+space',
  'f1',
  'f5',
  'f11',
  'f12',
]);

function canonicalAccelerator(mods: readonly string[], key: string): string {
  const set = new Set(mods.flatMap((m) => CANONICAL_MODIFIER[m] ?? [m]));
  const k = key.toLowerCase();
  return [...[...set].sort(), CANONICAL_KEY[k] ?? k].join('+');
}

function canonicalOf(accel: string): string | null {
  if (typeof accel !== 'string' || accel === '') return null;
  const tokens = accel.split('+');
  if (tokens.some((t) => t === '')) return null;
  const key = tokens[tokens.length - 1]!;
  return canonicalAccelerator(
    tokens.slice(0, -1).map((m) => m.toLowerCase()),
    key,
  );
}

/**
 * True when two accelerators press the same chord ("Ctrl+Alt+C" and "CommandOrControl+Alt+C").
 * '' (off) never matches, so two switched-off hotkeys do not conflict. Used for the check hotkey,
 * which must not take the quick-entry hotkey's chord (one global registration per chord).
 */
export function sameAccelerator(a: string, b: string): boolean {
  const x = canonicalOf(a);
  return x !== null && x === canonicalOf(b);
}

/** True for a well-formed accelerator that is a system or everyday app shortcut (Ctrl+C, Alt+F4, F5…). */
export function isReservedAccelerator(accel: string): boolean {
  if (typeof accel !== 'string' || accel === '') return false;
  const tokens = accel.split('+');
  if (tokens.some((t) => t === '')) return false;
  const key = tokens[tokens.length - 1]!;
  const mods = tokens.slice(0, -1).map((m) => m.toLowerCase());
  return RESERVED_ACCELERATORS.has(canonicalAccelerator(mods, key));
}

/**
 * Electron accelerator check for the global quick-entry hotkey. Requires a
 * non-Shift modifier unless the key is F1–F24, and rejects system shortcuts
 * (isReservedAccelerator). The empty string disables it.
 */
export function isValidAccelerator(accel: string): boolean {
  if (accel === '') return true;
  if (accel.length > 64 || /\s/.test(accel)) return false;
  const tokens = accel.split('+');
  if (tokens.some((t) => t === '')) return false;
  const key = tokens[tokens.length - 1]!;
  const mods = tokens.slice(0, -1).map((m) => m.toLowerCase());
  if (!isAcceleratorKey(key)) return false;
  if (mods.some((m) => !ACCELERATOR_MODIFIERS.has(m))) return false;
  if (new Set(mods).size !== mods.length) return false;
  const isFunctionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.test(key);
  if (!isFunctionKey && !mods.some((m) => STRONG_MODIFIERS.has(m))) return false;
  return !RESERVED_ACCELERATORS.has(canonicalAccelerator(mods, key));
}
