// Per-budget request scheduler: minimum spacing, sliding windows (minute, hour,
// day), concurrency, a 'user'-before-'background' queue, pauses (Retry-After)
// and the consecutive-429 rule. Clock and timers are injected so tests can run
// on fake time.

import type { BudgetSpec, Clock } from '../contracts';
import type { UnixMs } from '../../shared/types';
import type { NetBudgetSpec } from './budgets';
import { RateLimitedError } from './errors';

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const MAX_TIMER_MS = 2_147_483_647;

export const realTimers: TimerApi = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMER_MS));
    // Pending waits must not keep the process alive on shutdown.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type Priority = 'user' | 'background';

/** Without Retry-After: 60 s, then doubling, capped at 15 min (§2.0). */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
/** After this many 429s in a row the host is paused for LONG_PAUSE_MS. */
export const CONSECUTIVE_429_LIMIT = 3;
export const LONG_PAUSE_MS = 60 * 60_000;
/** Server-requested pauses are honoured but clamped to [1 s, 24 h] against garbage values. */
export const MIN_PAUSE_MS = 1_000;
export const MAX_PAUSE_MS = 24 * 60 * 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function backoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
}

export function clampPause(ms: number): number {
  if (!Number.isFinite(ms)) return MAX_PAUSE_MS;
  return Math.min(Math.max(ms, MIN_PAUSE_MS), MAX_PAUSE_MS);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

export interface AcquireOptions {
  priority?: Priority;
  /** Longest time to wait for a slot; RateLimitedError when it cannot be met. Default: unlimited. */
  maxWaitMs?: number;
  signal?: AbortSignal;
}

export interface Permit {
  readonly budget: string;
  readonly grantedAt: UnixMs;
  /** Counts one more request (e.g. a redirect hop) against the sliding windows. */
  countExtra(): void;
  /** Idempotent. */
  release(): void;
}

interface GateListener {
  headPriority(): Priority | null;
  wake(): void;
}

/** Shared concurrency limit, used to cap requests per host across all of its budgets. */
export class ConcurrencyGate {
  private activeCount = 0;
  private readonly listeners = new Set<GateListener>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) this.limit = 1;
  }

  get active(): number {
    return this.activeCount;
  }

  canEnter(): boolean {
    return this.activeCount < this.limit;
  }

  enter(): void {
    this.activeCount++;
  }

  leave(): void {
    if (this.activeCount > 0) this.activeCount--;
    this.notify();
  }

  listen(l: GateListener): void {
    this.listeners.add(l);
  }

  unlisten(l: GateListener): void {
    this.listeners.delete(l);
  }

  private notify(): void {
    // Budgets whose next waiter is user-initiated get the free slot first.
    const rank = (l: GateListener): number => (l.headPriority() === 'user' ? 0 : 1);
    const ordered = [...this.listeners].sort((a, b) => rank(a) - rank(b));
    for (const l of ordered) {
      if (!this.canEnter()) break;
      this.listeners.delete(l);
      l.wake();
    }
  }
}

interface Waiter {
  priority: Priority;
  deadline: number;
  resolve(p: Permit): void;
  reject(e: unknown): void;
  timer: unknown;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

export interface PauseResult {
  pauseMs: number;
  until: UnixMs;
  consecutive429: number;
  /** True when the consecutive-429 rule applied (pause the whole host). */
  longPause: boolean;
}

export interface BudgetState {
  id: string;
  host: string;
  description: string;
  usedLastHour: number;
  pausedUntil: UnixMs | null;
  pauseReason: string | null;
  consecutive429: number;
  queued: number;
  active: number;
  nextAllowedAt: UnixMs;
}

/** The part of a budget's state that must survive a restart (R7): the pause and the 429/backoff streaks. */
export interface PersistedBudgetState {
  /** 0 when not paused. */
  until: UnixMs;
  reason: string | null;
  n429: number;
  nBackoff: number;
}

/** Restored streak counters are capped: past this the backoff is at its maximum anyway. */
const MAX_RESTORED_STREAK = 100;

export interface SchedulerDeps {
  clock: Clock;
  timers?: TimerApi;
  /** Host-wide concurrency gate shared with other budgets on the same host. */
  gate?: ConcurrencyGate;
}

function positiveOrUndefined(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export class BudgetScheduler {
  readonly spec: NetBudgetSpec;
  private readonly clock: Clock;
  private readonly timers: TimerApi;
  private readonly gate: ConcurrencyGate | undefined;
  private readonly concurrency: number;
  private readonly minIntervalMs: number;
  private readonly windows: readonly { ms: number; max: number }[];
  private readonly keepMs: number;

  /** Grant timestamps, ascending. */
  private readonly history: number[] = [];
  private lastStart: number | null = null;
  private activeCount = 0;
  private queue: Waiter[] = [];
  private pausedUntilTs = 0;
  /** Length of the current pause when it was set: a wall clock stepped back cannot stretch it. */
  private pauseLenMs = 0;
  private pauseWhy: string | null = null;
  private n429 = 0;
  private nBackoff = 0;
  private wakeTimer: unknown = null;
  private readonly gateListener: GateListener;
  private listeningOnGate = false;

  constructor(spec: BudgetSpec, deps: SchedulerDeps) {
    this.spec = spec;
    this.clock = deps.clock;
    this.timers = deps.timers ?? realTimers;
    this.gate = deps.gate;
    this.concurrency = Number.isInteger(spec.concurrency) && spec.concurrency >= 1 ? spec.concurrency : 1;
    this.minIntervalMs = Number.isFinite(spec.minIntervalMs) && spec.minIntervalMs > 0 ? spec.minIntervalMs : 0;
    const windows: { ms: number; max: number }[] = [];
    const perMinute = positiveOrUndefined(spec.maxPerMinute);
    const perHour = positiveOrUndefined(spec.maxPerHour);
    const perDay = positiveOrUndefined(spec.maxPerDay);
    if (perMinute) windows.push({ ms: MINUTE, max: perMinute });
    if (perHour) windows.push({ ms: HOUR, max: perHour });
    if (perDay) windows.push({ ms: DAY, max: perDay });
    this.windows = windows;
    this.keepMs = perDay ? DAY : HOUR;
    this.gateListener = {
      headPriority: () => this.queue[0]?.priority ?? null,
      wake: () => {
        this.listeningOnGate = false;
        this.pump();
      },
    };
  }

  get id(): string {
    return this.spec.id;
  }

  get consecutive429(): number {
    return this.n429;
  }

  queueLength(): number {
    return this.queue.length;
  }

  activeRequests(): number {
    return this.activeCount;
  }

  /** Earliest time a new request could start, ignoring concurrency. */
  nextAllowedAt(now: UnixMs = this.clock.now()): UnixMs {
    this.clampFuture();
    this.prune(now);
    let at = now;
    if (this.pausedUntilTs > at) at = this.pausedUntilTs;
    if (this.lastStart !== null && this.minIntervalMs > 0) at = Math.max(at, this.lastStart + this.minIntervalMs);
    for (const w of this.windows) at = Math.max(at, this.windowFreeAt(w.ms, w.max, now));
    return at;
  }

  usedLast(windowMs: number, now: UnixMs = this.clock.now()): number {
    return this.history.length - this.firstIndexAfter(now - windowMs);
  }

  pausedUntil(now: UnixMs = this.clock.now()): UnixMs | null {
    this.clampFuture();
    return this.pausedUntilTs > now ? this.pausedUntilTs : null;
  }

  pauseReason(now: UnixMs = this.clock.now()): string | null {
    return this.pausedUntil(now) !== null ? this.pauseWhy : null;
  }

  /** Pauses until `until`. A shorter pause never shortens an existing one. */
  pause(until: UnixMs, reason: string): void {
    if (!Number.isFinite(until)) return;
    // 0.7.3: compared with the clamped pause, so one stretched by a clock step cannot hide a longer new one.
    this.clampFuture();
    if (until > this.pausedUntilTs) {
      this.pausedUntilTs = until;
      this.pauseLenMs = Math.max(0, until - this.clock.now());
      this.pauseWhy = reason;
    }
    this.pump();
  }

  resume(): void {
    this.pausedUntilTs = 0;
    this.pauseWhy = null;
    this.pump();
  }

  /**
   * A 429 arrived. Uses the server's delay when given, else the backoff
   * schedule; three in a row pause for at least an hour.
   */
  record429(retryAfterMs: number | null, now: UnixMs = this.clock.now()): PauseResult {
    this.n429++;
    this.nBackoff++;
    let pauseMs = retryAfterMs !== null && Number.isFinite(retryAfterMs) ? retryAfterMs : backoffMs(this.nBackoff);
    const longPause = this.n429 >= CONSECUTIVE_429_LIMIT;
    if (longPause) pauseMs = Math.max(pauseMs, LONG_PAUSE_MS);
    if (this.spec.on429PauseMs) pauseMs = Math.max(pauseMs, this.spec.on429PauseMs);
    pauseMs = clampPause(pauseMs);
    const until = now + pauseMs;
    this.pause(until, longPause ? `${this.n429} consecutive 429 responses` : 'HTTP 429');
    return { pauseMs, until, consecutive429: this.n429, longPause };
  }

  /**
   * A 503 (or similar) arrived: same delay rules as 429 but no consecutive-429 escalation. 0.7.4 (F52): `status`
   * names the answer (502, 504...) in the pause reason; 503 by default, the reason saved pauses already carry.
   */
  recordUnavailable(retryAfterMs: number | null, now: UnixMs = this.clock.now(), status = 503): PauseResult {
    this.nBackoff++;
    const raw = retryAfterMs !== null && Number.isFinite(retryAfterMs) ? retryAfterMs : backoffMs(this.nBackoff);
    const pauseMs = clampPause(raw);
    const until = now + pauseMs;
    this.pause(until, `HTTP ${Number.isInteger(status) ? status : 503}`);
    return { pauseMs, until, consecutive429: this.n429, longPause: false };
  }

  /**
   * Restores request times from before a restart (the persisted request log),
   * so spacing and window limits hold across relaunches and crash restarts.
   * Times in the future (clock moved back) count as now.
   */
  seed(timestamps: readonly number[], now: UnixMs = this.clock.now()): void {
    const horizon = now - Math.max(this.keepMs, this.minIntervalMs);
    let added = false;
    for (const raw of timestamps) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const ts = Math.min(raw, now);
      if (ts <= horizon) continue;
      this.history.splice(this.firstIndexAfter(ts), 0, ts);
      this.lastStart = this.lastStart === null ? ts : Math.max(this.lastStart, ts);
      added = true;
    }
    if (added) this.pump();
  }

  /** Any other response ends a 429/backoff streak. */
  recordSuccess(): void {
    this.n429 = 0;
    this.nBackoff = 0;
  }

  /** Pause and streaks to save, so a restart does not forget a server-requested wait. */
  persistedState(now: UnixMs = this.clock.now()): PersistedBudgetState {
    this.clampFuture();
    const paused = this.pausedUntilTs > now;
    return {
      until: paused ? this.pausedUntilTs : 0,
      reason: paused ? this.pauseWhy : null,
      n429: this.n429,
      nBackoff: this.nBackoff,
    };
  }

  /**
   * Restores state saved by an earlier process. A pause is clamped to
   * MAX_PAUSE_MS from now, so a corrupt value or a clock that moved back
   * cannot stop the budget for longer than any server could ask for.
   */
  restore(saved: PersistedBudgetState, now: UnixMs = this.clock.now()): void {
    const streak = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_RESTORED_STREAK) : 0);
    this.n429 = Math.max(this.n429, streak(saved.n429));
    this.nBackoff = Math.max(this.nBackoff, streak(saved.nBackoff));
    if (Number.isFinite(saved.until) && saved.until > now) {
      this.pause(Math.min(saved.until, now + MAX_PAUSE_MS), saved.reason ?? 'paused before the last restart');
    }
  }

  acquire(opts: AcquireOptions = {}): Promise<Permit> {
    const priority: Priority = opts.priority === 'user' ? 'user' : 'background';
    const maxWait =
      typeof opts.maxWaitMs === 'number' && !Number.isNaN(opts.maxWaitMs) ? Math.max(0, opts.maxWaitMs) : Infinity;
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    const now = this.clock.now();
    const estimate = this.estimateStart(priority, now);
    if (estimate - now > maxWait) return Promise.reject(new RateLimitedError(this.spec.id, estimate));

    return new Promise<Permit>((resolve, reject) => {
      const w: Waiter = {
        priority,
        deadline: now + maxWait,
        resolve,
        reject,
        timer: null,
        signal,
        onAbort: undefined,
      };
      if (Number.isFinite(maxWait)) w.timer = this.timers.setTimeout(() => this.expire(w), maxWait);
      if (signal) {
        w.onAbort = () => this.drop(w, abortReason(signal));
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.insert(w);
      this.pump();
    });
  }

  /** Rejects every queued waiter (network paused, shutdown). Running requests are unaffected. */
  cancelAll(err: unknown): void {
    const waiting = this.queue;
    this.queue = [];
    for (const w of waiting) {
      this.cleanup(w);
      w.reject(err);
    }
    this.clearWake();
    this.stopListening();
  }

  state(now: UnixMs = this.clock.now()): BudgetState {
    return {
      id: this.spec.id,
      host: this.spec.host,
      description: this.spec.description,
      usedLastHour: this.usedLast(HOUR, now),
      pausedUntil: this.pausedUntil(now),
      pauseReason: this.pauseReason(now),
      consecutive429: this.n429,
      queued: this.queue.length,
      active: this.activeCount,
      nextAllowedAt: this.nextAllowedAt(now),
    };
  }

  // -------------------------------------------------------------------------

  private estimateStart(priority: Priority, now: UnixMs): UnixMs {
    const ahead = priority === 'user' ? this.queue.filter((w) => w.priority === 'user').length : this.queue.length;
    return this.nextAllowedAt(now) + ahead * this.minIntervalMs;
  }

  private insert(w: Waiter): void {
    if (w.priority === 'background') {
      this.queue.push(w);
      return;
    }
    const firstBackground = this.queue.findIndex((x) => x.priority === 'background');
    if (firstBackground < 0) this.queue.push(w);
    else this.queue.splice(firstBackground, 0, w);
  }

  private pump(): void {
    this.clearWake();
    this.stopListening();
    while (this.queue.length > 0) {
      const now = this.clock.now();
      const at = this.nextAllowedAt(now);
      this.failUnreachable(at, now);
      if (this.queue.length === 0) return;
      if (at > now) {
        this.wakeTimer = this.timers.setTimeout(() => {
          this.wakeTimer = null;
          this.pump();
        }, at - now);
        return;
      }
      if (this.activeCount >= this.concurrency) return; // release() pumps again
      if (this.gate && !this.gate.canEnter()) {
        this.listeningOnGate = true;
        this.gate.listen(this.gateListener);
        return;
      }
      const w = this.queue.shift()!;
      this.grant(w, now);
    }
  }

  private grant(w: Waiter, now: UnixMs): void {
    this.cleanup(w);
    this.activeCount++;
    this.gate?.enter();
    this.history.push(now);
    this.lastStart = now;
    let released = false;
    const permit: Permit = {
      budget: this.spec.id,
      grantedAt: now,
      countExtra: () => {
        if (released) return;
        this.clampFuture(); // keeps history ascending after a clock step
        this.history.push(this.clock.now());
      },
      release: () => {
        if (released) return;
        released = true;
        this.activeCount--;
        this.gate?.leave();
        this.pump();
      },
    };
    w.resolve(permit);
  }

  /** Waiters whose deadline passes before `at` can never be served in time. */
  private failUnreachable(at: UnixMs, now: UnixMs): void {
    if (!this.queue.some((w) => w.deadline < at)) return;
    // 0.7.3: at <= now means the deadline already passed (a timer fired late) while the
    // budget itself was free: when the slots are taken, it was waiting behind a running request.
    const busy = at <= now && this.slotsTaken();
    const keep: Waiter[] = [];
    for (const w of this.queue) {
      if (w.deadline < at) {
        this.cleanup(w);
        w.reject(new RateLimitedError(this.spec.id, at, busy));
      } else {
        keep.push(w);
      }
    }
    this.queue = keep;
  }

  private expire(w: Waiter): void {
    w.timer = null;
    if (!this.queue.includes(w)) return;
    // A slot may open at exactly the deadline; serve it rather than fail.
    this.pump();
    const i = this.queue.indexOf(w);
    if (i < 0) return;
    this.queue.splice(i, 1);
    this.cleanup(w);
    // 0.7.3: a slot that is free by time but still not granted is taken by a running request.
    const now = this.clock.now();
    const at = this.nextAllowedAt(now);
    w.reject(new RateLimitedError(this.spec.id, at, at <= now && this.slotsTaken()));
    this.pump();
  }

  /** Every concurrency slot is taken: the budget's own, or the host's shared gate. */
  private slotsTaken(): boolean {
    return this.activeCount >= this.concurrency || (this.gate !== undefined && !this.gate.canEnter());
  }

  private drop(w: Waiter, err: unknown): void {
    const i = this.queue.indexOf(w);
    if (i < 0) return;
    this.queue.splice(i, 1);
    this.cleanup(w);
    w.reject(err);
    this.pump();
  }

  private cleanup(w: Waiter): void {
    if (w.timer !== null) {
      this.timers.clearTimeout(w.timer);
      w.timer = null;
    }
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
    w.onAbort = undefined;
  }

  private clearWake(): void {
    if (this.wakeTimer !== null) {
      this.timers.clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  private stopListening(): void {
    if (this.listeningOnGate && this.gate) this.gate.unlisten(this.gateListener);
    this.listeningOnGate = false;
  }

  private firstIndexAfter(t: number): number {
    let lo = 0;
    let hi = this.history.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.history[mid]! > t) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  private windowFreeAt(windowMs: number, max: number, now: UnixMs): UnixMs {
    const n = this.history.length;
    const inWindow = n - this.firstIndexAfter(now - windowMs);
    if (inWindow < max) return now;
    // The (inWindow - max + 1) oldest entries must leave the window.
    return this.history[n - max]! + windowMs;
  }

  /**
   * 0.7.3: the seed()/restore() rule at run time. After the wall clock steps back
   * while running, grant times in the future count as now and a pause keeps at
   * most its own length from now, so nothing waits for the size of the step but
   * spacing, windows and pauses still hold in elapsed time (R7). Reads the clock
   * itself, so a caller's stale `now` cannot pull values back.
   */
  private clampFuture(): void {
    const now = this.clock.now();
    if (this.lastStart !== null && this.lastStart > now) this.lastStart = now;
    // Future entries are a suffix of the ascending history, so it stays ascending.
    for (let i = this.history.length - 1; i >= 0 && this.history[i]! > now; i--) this.history[i] = now;
    if (this.pausedUntilTs > now + this.pauseLenMs) this.pausedUntilTs = now + this.pauseLenMs;
  }

  private prune(now: UnixMs): void {
    const cut = this.firstIndexAfter(now - this.keepMs);
    if (cut > 0) this.history.splice(0, cut);
  }
}
