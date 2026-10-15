// H3 toast actions: how long a toast stays, which one makes room in a full
// stack, and countdowns that hover or focus hold on a toast with an action.

import { describe, expect, it } from 'vitest';
import {
  TOAST_ACTION_MS,
  TOAST_BAD_MS,
  TOAST_MAX,
  TOAST_MAX_MS,
  TOAST_MS,
  TOAST_RESUME_MIN_MS,
  createToastTimers,
  pushToast,
  toastTimeoutMs,
  type ToastItem,
  type ToastTimerApi,
} from '../../src/renderer/toastModel';

/** Timers driven by hand. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const api: ToastTimerApi = {
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(h) {
      pending.delete(h as number);
    },
    now: () => now,
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > now) continue;
      pending.delete(id);
      t.fn();
    }
  };
  return { api, advance, pending: () => pending.size };
}

const item = (id: number, action = false): ToastItem => ({ id, text: `t${id}`, tone: 'info', timeoutMs: TOAST_MS, ...(action ? { action: { label: 'Undo', onClick: () => undefined } } : {}) });

describe('toastTimeoutMs', () => {
  it('keeps the old defaults and gives action toasts 12 s', () => {
    expect(toastTimeoutMs('info')).toBe(TOAST_MS);
    expect(toastTimeoutMs('good')).toBe(4_500);
    expect(toastTimeoutMs('bad')).toBe(TOAST_BAD_MS);
    expect(TOAST_BAD_MS).toBe(8_000);
    expect(toastTimeoutMs('good', { action: { label: 'Undo', onClick: () => undefined } })).toBe(TOAST_ACTION_MS);
    expect(TOAST_ACTION_MS).toBe(12_000);
  });

  it('takes a caller timeout, capped, and ignores junk', () => {
    expect(toastTimeoutMs('info', { timeoutMs: 2_000 })).toBe(2_000);
    expect(toastTimeoutMs('info', { timeoutMs: 10 * TOAST_MAX_MS })).toBe(TOAST_MAX_MS);
    expect(toastTimeoutMs('bad', { timeoutMs: -1 })).toBe(TOAST_BAD_MS);
    expect(toastTimeoutMs('info', { timeoutMs: Number.NaN, action: { label: 'x', onClick: () => undefined } })).toBe(TOAST_ACTION_MS);
  });
});

describe('pushToast', () => {
  it('keeps at most four, dropping the oldest plain toast before an action toast', () => {
    expect(TOAST_MAX).toBe(4);
    let list: ToastItem[] = [];
    list = pushToast(list, item(1, true));
    for (let i = 2; i <= 5; i++) list = pushToast(list, item(i));
    expect(list.map((t) => t.id)).toEqual([1, 3, 4, 5]);
    list = pushToast(list, item(6));
    expect(list.map((t) => t.id)).toEqual([1, 4, 5, 6]);
  });

  it('drops the oldest when every other toast has an action, and never the new one', () => {
    let list: ToastItem[] = [1, 2, 3, 4].map((i) => item(i, true));
    list = pushToast(list, item(5));
    expect(list.map((t) => t.id)).toEqual([2, 3, 4, 5]);
  });
});

describe('createToastTimers', () => {
  it('expires a toast after its time', () => {
    const t = fakeTimers();
    const gone: number[] = [];
    const timers = createToastTimers((id) => gone.push(id), t.api);
    timers.start(1, 4_500);
    t.advance(4_499);
    expect(gone).toEqual([]);
    t.advance(1);
    expect(gone).toEqual([1]);
  });

  it('holds an action toast while hovered or focused and resumes with the time left', () => {
    const t = fakeTimers();
    const gone: number[] = [];
    const timers = createToastTimers((id) => gone.push(id), t.api);
    timers.start(1, 12_000, { pausable: true });
    t.advance(5_000);
    timers.hold(1, 'hover', true);
    timers.hold(1, 'focus', true);
    t.advance(60_000);
    expect(gone).toEqual([]);
    expect(timers.held(1)).toBe(true);
    timers.hold(1, 'hover', false);
    // Still focused.
    t.advance(60_000);
    expect(gone).toEqual([]);
    timers.hold(1, 'focus', false);
    expect(timers.held(1)).toBe(false);
    t.advance(6_999);
    expect(gone).toEqual([]);
    t.advance(1);
    expect(gone).toEqual([1]);
  });

  it('gives a short grace after a hold that outlasted the time left', () => {
    const t = fakeTimers();
    const gone: number[] = [];
    const timers = createToastTimers((id) => gone.push(id), t.api);
    timers.start(1, 1_000, { pausable: true });
    t.advance(999);
    timers.hold(1, 'hover', true);
    t.advance(10_000);
    timers.hold(1, 'hover', false);
    t.advance(TOAST_RESUME_MIN_MS - 1);
    expect(gone).toEqual([]);
    t.advance(1);
    expect(gone).toEqual([1]);
  });

  it('ignores holds on a plain toast, and clear stops a countdown', () => {
    const t = fakeTimers();
    const gone: number[] = [];
    const timers = createToastTimers((id) => gone.push(id), t.api);
    timers.start(1, 4_500);
    timers.hold(1, 'hover', true);
    expect(timers.held(1)).toBe(false);
    timers.start(2, 4_500);
    timers.clear(2);
    timers.hold(2, 'hover', false);
    t.advance(5_000);
    expect(gone).toEqual([1]);
    timers.start(3, 100);
    timers.clearAll();
    expect(t.pending()).toBe(0);
  });
});
