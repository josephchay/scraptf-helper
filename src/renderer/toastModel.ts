// Toasts (H3): how long one stays, which one makes room when the stack is full,
// and countdowns that pause while the pointer or focus is on a toast with an
// action (an Undo must not vanish while the user is reaching for it). Pure, so
// it is unit-tested without a DOM; AppProvider and ToastStack use it.

export type ToastTone = 'info' | 'good' | 'warn' | 'bad';

/** A button on the toast (e.g. Undo). Clicking it runs onClick and dismisses the toast. */
export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Overrides the default stay (TOAST_MS, TOAST_BAD_MS, or TOAST_ACTION_MS with an action). */
  timeoutMs?: number;
}

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  action?: ToastAction;
  /** How long it stays, not counting the time it is held by hover or focus. */
  timeoutMs: number;
}

export const TOAST_MS = 4_500;
export const TOAST_BAD_MS = 8_000;
export const TOAST_ACTION_MS = 12_000;
/** Toasts shown at once. */
export const TOAST_MAX = 4;
/** A caller's timeoutMs is capped here: a toast is not a banner. */
export const TOAST_MAX_MS = 120_000;
/** After a hold ends, a toast stays at least this long, so it does not vanish as the pointer leaves. */
export const TOAST_RESUME_MIN_MS = 1_500;

export function toastTimeoutMs(tone: ToastTone, opts?: ToastOptions): number {
  const t = opts?.timeoutMs;
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) return Math.min(Math.round(t), TOAST_MAX_MS);
  if (opts?.action) return TOAST_ACTION_MS;
  return tone === 'bad' ? TOAST_BAD_MS : TOAST_MS;
}

/**
 * The stack after adding `item`, at most `max` long. The oldest toast without an action makes room
 * first, so a burst of status messages cannot push an Undo off the screen.
 */
export function pushToast(list: readonly ToastItem[], item: ToastItem, max = TOAST_MAX): ToastItem[] {
  const out = [...list, item];
  while (out.length > Math.max(1, max)) {
    const plain = out.findIndex((t) => !t.action && t !== item);
    out.splice(plain >= 0 ? plain : 0, 1);
  }
  return out;
}

export type ToastHold = 'hover' | 'focus';

export interface ToastTimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface ToastTimers {
  /** Starts the countdown; only a pausable toast (one with an action) is held by hover or focus. */
  start(id: number, ms: number, opts?: { pausable?: boolean }): void;
  /** Hover or focus holds the countdown; once neither does, it resumes with the time that was left. */
  hold(id: number, why: ToastHold, on: boolean): void;
  /** Whether the toast's countdown is held right now (tests, and nothing else). */
  held(id: number): boolean;
  clear(id: number): void;
  clearAll(): void;
}

const browserTimers: ToastTimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export function createToastTimers(onExpire: (id: number) => void, api: ToastTimerApi = browserTimers): ToastTimers {
  interface Countdown {
    left: number;
    since: number;
    handle: unknown;
    holds: Set<ToastHold>;
    pausable: boolean;
  }
  const all = new Map<number, Countdown>();

  const run = (id: number, c: Countdown): void => {
    c.since = api.now();
    c.handle = api.setTimeout(() => {
      all.delete(id);
      onExpire(id);
    }, c.left);
  };

  return {
    start(id, ms, opts) {
      const prev = all.get(id);
      if (prev?.handle != null) api.clearTimeout(prev.handle);
      const c: Countdown = { left: Math.max(0, ms), since: 0, handle: null, holds: new Set(), pausable: opts?.pausable === true };
      all.set(id, c);
      run(id, c);
    },
    hold(id, why, on) {
      const c = all.get(id);
      if (!c || !c.pausable) return;
      if (on) {
        if (c.holds.size === 0 && c.handle != null) {
          api.clearTimeout(c.handle);
          c.handle = null;
          c.left = Math.max(0, c.left - (api.now() - c.since));
        }
        c.holds.add(why);
        return;
      }
      if (!c.holds.delete(why) || c.holds.size > 0 || c.handle != null) return;
      c.left = Math.max(c.left, TOAST_RESUME_MIN_MS);
      run(id, c);
    },
    held(id) {
      const c = all.get(id);
      return !!c && c.holds.size > 0;
    },
    clear(id) {
      const c = all.get(id);
      if (c?.handle != null) api.clearTimeout(c.handle);
      all.delete(id);
    },
    clearAll() {
      for (const c of all.values()) if (c.handle != null) api.clearTimeout(c.handle);
      all.clear();
    },
  };
}
