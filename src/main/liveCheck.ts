// Live check (F16) in main: the check hotkey, and what the opt-in clipboard watcher's checks do
// (one check in flight, the popup rate limit, flip notifications). Electron (the clipboard, the
// popup window, notifications, the service host) comes in through LiveCheckMainDeps, so all of it
// is unit-tested with fakes.
//
// Privacy (spec "Privacy rules"): the clipboard is read here only, with readText (plain text), once
// per hotkey press or on the watcher's poll. Text passes shouldCheckClipboardText before anything
// leaves main, and then goes only to the local service's 'check.text'. It is never logged (log lines
// carry fixed messages and error class names), never kept past the call, and never put in a popup or
// a notification: both are built from the service's CheckResult (the resolved item), or from a fixed
// reason. Nothing here touches the network or scrap.tf.
//
// F19 'check.arm' (arm()): the item the user just opened on scrap.tf from the app. For CHECK_ARM_MS the
// hotkey's and the watcher's checks carry `hint: { sku }`, so a copied price on its own is checked as
// that item. The name the page copied for scrap.tf's search is kept as its keyed hash only (the
// watcher's), never as text and never logged: the watcher drops that copy once as the app's own, and
// only within CHECK_OWN_COPY_MS of the arm, so a copy that never came cannot swallow the user's own.

import { z } from 'zod';
import type { Logger } from '../service/contracts';
import { blankCheckResult, CHECK_ARM_MS, CHECK_NOTIFY_DEDUP_MS, CHECK_POPUP_MIN_GAP_MS, CHECK_WATCH_INTERVAL_MS, checkPriceIsOtherCopy } from '../shared/check';
import { formatKeysMetal, formatScrap } from '../shared/currency';
import type { PushContract } from '../shared/rpc';
import type { CheckArm, CheckHint, CheckPriceSource, CheckResult, Settings, UnixMs } from '../shared/types';
import { clipboardSkipMessage, clipboardTextHash, createClipboardWatch, shouldCheckClipboardText, type ClipboardWatchTimers } from './clipboardWatch';

/** A check is local and takes milliseconds; past this the popup says so instead of waiting on main's 30 s RPC timeout. */
export const CHECK_CALL_TIMEOUT_MS = 10_000;
/**
 * A held hotkey repeats (Windows sends WM_HOTKEY again while the chord is down): key events closer
 * together than this are one press. Longer than the OS key-repeat delay (up to about 1 s on Windows),
 * so the pause before the first repeat does not read as a release.
 */
export const CHECK_HOTKEY_MIN_GAP_MS = 1_100;
/**
 * A hotkey answer later than this shows without focus: by then the user is typing elsewhere again,
 * and a focused popup would take their keys (Enter saves the price, B records a buy).
 */
export const CHECK_HOTKEY_FOCUS_MS = 2_000;
/**
 * F19 M2: how long after an arm the page's copy of the name may still reach the watcher (at least three
 * polls). The page copies within milliseconds of arming and the watcher reads within a poll; past this
 * the copy is not coming (it failed), and a copy of the name is the user's own, which must be checked.
 */
export const CHECK_OWN_COPY_MS = 5_000;
/** Hotkey popup reasons main writes itself. Fixed texts: none quotes the clipboard. */
export const CHECK_NOT_READY_REASON = 'The background service is not ready yet. Try again in a moment.';
export const CHECK_FAILED_REASON = 'The check could not run. Try again in a moment.';
export const CHECK_CLIPBOARD_UNREADABLE = 'The clipboard could not be read. Try again.';
/** Flip notification dedupe entries kept (one per SKU, each for CHECK_NOTIFY_DEDUP_MS). */
const NOTIFIED_MAX = 500;

export interface LiveCheckTimers extends ClipboardWatchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: LiveCheckTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface LiveCheckMainDeps {
  /** clipboard.readText() (async in Electron 44): plain text only. Never a reader of HTML, RTF or any other format. */
  readText(): string | Promise<string>;
  /**
   * The local service's 'check.text' (with CHECK_CALL_TIMEOUT_MS). The only place the text goes.
   * `hint` only while an arm is unexpired (F19); otherwise the call has two arguments.
   */
  check(text: string, source: 'hotkey' | 'watch', hint?: CheckHint): Promise<unknown>;
  /** The service is up: a watcher text is dropped otherwise, and the hotkey says so at once. */
  serviceReady(): boolean;
  /** windows.showCheck: focus for a prompt hotkey answer (the user asked), never for the watcher. */
  showPopup(result: CheckResult, opts: { focus: boolean }): void;
  /** main's showNotification: notifications.enabled and silent apply there too; a click opens the drawer. */
  notify(payload: PushContract['notify']): void;
  settings(): Pick<Settings, 'check' | 'notifications' | 'networkPaused'>;
  /** Session locked or machine suspended (createSystemPause). */
  systemPaused(): boolean;
  log: Logger;
  now?: () => number;
  timers?: LiveCheckTimers;
  /** The watcher's poll interval; default CHECK_WATCH_INTERVAL_MS (700). */
  watchIntervalMs?: number;
}

export interface LiveCheckMain {
  /** The check hotkey: reads the clipboard once, checks it and shows the popup focused (unfocused past CHECK_HOTKEY_FOCUS_MS). */
  hotkey(): Promise<void>;
  /** Starts or stops the clipboard watcher to match settings.check.watchClipboard. */
  syncWatch(): void;
  watching(): boolean;
  /**
   * F19 'check.arm' (ipc.ts validated it): arms for CHECK_ARM_MS from now, replacing any earlier arm;
   * null disarms. Memory only: the SKU, the name's keyed hash and the expiry. Disarmed after stop().
   */
  arm(a: CheckArm | null): { armedUntil: UnixMs | null };
  /** Shutdown: stops the watcher, disarms and drops anything still pending. */
  stop(): void;
}

/** An arm as kept: never the name itself, only the watcher's keyed hash of it (useless outside this process). */
interface ArmState {
  sku: string;
  nameHash: string;
  until: UnixMs;
  /** The page's copy of the name already came through (dropped by the watcher, or checked by the hotkey), or never can: once per arm. */
  ownCopyDropped: boolean;
  /** Past this the page's copy is not coming, so nothing is dropped (CHECK_OWN_COPY_MS after the arm). */
  ownCopyUntil: UnixMs;
}

// The popup renders these fields; a malformed answer gets a fixed reason instead of a broken page.
const checkResultShape = z.looseObject({
  id: z.number(),
  status: z.enum(['item', 'not-item', 'refused']),
  source: z.enum(['hotkey', 'watch', 'manual']),
  reason: z.string().nullable(),
  sku: z.string().nullable(),
  name: z.string().nullable(),
  price: z.looseObject({ keys: z.number(), scrapRaw: z.number(), valueScrap: z.number(), source: z.string() }).nullable(),
  revenue: z.looseObject({}).nullable(),
  profitScrap: z.number().nullable(),
  margin: z.number().nullable(),
  verdict: z.enum(['flip', 'over', 'no-buyers', 'no-price']).nullable(),
  links: z.array(z.unknown()),
  keyScrap: z.number().nullable(),
  checkedAt: z.number(),
});

/** Shape check for a 'check.text' answer before it reaches the popup. */
export function isCheckResult(value: unknown): value is CheckResult {
  return checkResultShape.safeParse(value).success;
}

const PRICE_SOURCE_WORDS: Record<CheckPriceSource, string> = {
  clipboard: 'copied',
  list: 'saved list',
  typed: 'your price',
  import: 'saved page',
};

/**
 * The desktop notification for a watcher flip while the watcher's popup is off (ACT-7), from the result
 * only (the schema's item name and the service's money), e.g. "Flip: Team Captain" / "scrap.tf 1 key
 * 5.33 ref (copied) → sells for 1 key 9.11 ref, +3.77 ref (6%)". null unless the result is an item with a
 * flip verdict and a price, and null when that price is a painted or spelled copy's (CHECK_EXTRAS_NOTE):
 * no flip for a plain one.
 */
export function flipNotification(r: CheckResult): PushContract['notify'] | null {
  if (r.status !== 'item' || r.verdict !== 'flip' || !r.sku || !r.price || checkPriceIsOtherCopy(r)) return null;
  const k = r.keyScrap;
  let body = `scrap.tf ${formatKeysMetal(r.price.keys, r.price.scrapRaw)} (${PRICE_SOURCE_WORDS[r.price.source] ?? 'price'})`;
  const revenue = r.revenue?.revenueScrap;
  if (typeof revenue === 'number') body += ` → sells for ${formatScrap(revenue, k)}`;
  if (r.profitScrap !== null) body += `, +${formatScrap(r.profitScrap, k)}`;
  if (r.margin !== null && Number.isFinite(r.margin)) body += ` (${Math.round(r.margin * 100)}%)`;
  return { title: `Flip: ${r.name || r.sku}`, body, sku: r.sku };
}

/** The error's class only: messages on this path are never logged, in case one ever quoted the text. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function createLiveCheckMain(deps: LiveCheckMainDeps): LiveCheckMain {
  const { log } = deps;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? realTimers;

  /** Every check, hotkey or watcher, numbered as it starts: an older result never replaces a newer one. */
  let seq = 0;
  let shownSeq = 0;
  let lastShowAt = Number.NEGATIVE_INFINITY;
  let lastHotkeyAt = Number.NEGATIVE_INFINITY;
  /** A watcher result waiting out CHECK_POPUP_MIN_GAP_MS; a newer one replaces it. */
  let pending: { result: CheckResult; seq: number } | null = null;
  let pendingTimer: unknown = null;
  let watchBusy = false;
  /** The newest text copied while a watcher check was in flight: memory only, replaced by newer copies. */
  let watchNext: string | null = null;
  /** Bumped when the watcher stops, so a reply to the earlier run does nothing. */
  let watchRun = 0;
  const notified = new Map<string, number>();
  let stopped = false;
  /** F19: the current arm, or null. Expiry is checked on every read (armNow), so no timer is needed. */
  let armed: ArmState | null = null;

  function armNow(): ArmState | null {
    if (armed !== null && now() >= armed.until) armed = null;
    return armed;
  }

  /** The 'check.text' hint while armed, for the hotkey and the watcher alike. A fresh object: never the arm itself. */
  function armHint(): CheckHint | undefined {
    const a = armNow();
    return a ? { sku: a.sku } : undefined;
  }

  /**
   * M2: the page arms, then copies the name for scrap.tf's search; with the watcher on, that copy would
   * pop up a check of the item the user is about to look up. True once per arm for the armed name,
   * matched by keyed hash of the trimmed text (ipc trims the name): a later copy of it is checked as usual.
   */
  function takeOwnCopy(copied: string): boolean {
    const a = armNow();
    if (a === null || a.ownCopyDropped) return false;
    // Bounded: a page copy that failed must not leave the drop waiting to swallow the user's own copy.
    if (now() >= a.ownCopyUntil) {
      a.ownCopyDropped = true;
      return false;
    }
    if (clipboardTextHash(copied.trim()) !== a.nameHash) return false;
    a.ownCopyDropped = true;
    return true;
  }

  /**
   * M2: a priming read (the watcher just started or resumed) that found the armed name took the page's
   * copy as already there, so it never comes as new. A priming read of anything else leaves the drop
   * waiting: it may have run before the page copied.
   */
  function primedWith(hash: string): void {
    const a = armNow();
    if (a !== null && !a.ownCopyDropped && hash === a.nameHash) a.ownCopyDropped = true;
  }

  const watchPaused = (): boolean => deps.systemPaused() || deps.settings().networkPaused;
  const pollMs = Number.isFinite(deps.watchIntervalMs) ? Math.max(100, Math.floor(deps.watchIntervalMs!)) : CHECK_WATCH_INTERVAL_MS;
  const ownCopyMs = Math.max(CHECK_OWN_COPY_MS, 3 * pollMs);

  const watch = createClipboardWatch({
    readText: () => deps.readText(),
    onText: (copied) => watched(copied),
    onPrimed: (hash) => primedWith(hash),
    isPaused: watchPaused,
    intervalMs: deps.watchIntervalMs,
    timers,
    onError: (what, err) => log.warn(`clipboard watch: ${what} failed`, { error: errorName(err) }),
  });

  function show(result: CheckResult, s: number, focus: boolean): void {
    shownSeq = s;
    lastShowAt = now();
    try {
      deps.showPopup(result, { focus });
    } catch (err) {
      log.warn('live check popup could not be shown', { error: errorName(err) });
    }
  }

  function cancelPending(): void {
    if (pendingTimer !== null) timers.clearTimeout(pendingTimer);
    pendingTimer = null;
    pending = null;
  }

  function flushPending(): void {
    pendingTimer = null;
    const p = pending;
    pending = null;
    // The user may have turned the popup or the watcher off while it waited.
    if (!p || p.seq < shownSeq || !watch.running() || !deps.settings().check.popup) return;
    show(p.result, p.seq, false);
  }

  /** At most one watcher popup per CHECK_POPUP_MIN_GAP_MS; the newest waiting result is the one shown. */
  function queuePopup(result: CheckResult, s: number): void {
    if (s < shownSeq) return;
    const wait = lastShowAt + CHECK_POPUP_MIN_GAP_MS - now();
    if (wait <= 0 && pendingTimer === null) {
      show(result, s, false);
      return;
    }
    pending = { result, seq: s };
    if (pendingTimer === null) pendingTimer = timers.setTimeout(flushPending, Math.max(0, wait));
  }

  function maybeNotify(result: CheckResult, settings: Pick<Settings, 'notifications'>): void {
    if (!settings.notifications.enabled || !result.sku) return;
    const t = now();
    const last = notified.get(result.sku);
    if (last !== undefined && t - last < CHECK_NOTIFY_DEDUP_MS) return;
    const payload = flipNotification(result);
    if (!payload) return;
    // Re-inserted so insertion order stays oldest-first for the trim below.
    notified.delete(result.sku);
    notified.set(result.sku, t);
    if (notified.size > NOTIFIED_MAX) {
      for (const [sku, at] of notified) if (t - at >= CHECK_NOTIFY_DEDUP_MS) notified.delete(sku);
      // Still full of recent ones: drop the oldest (insertion order).
      while (notified.size > NOTIFIED_MAX) {
        const oldest = notified.keys().next().value;
        if (oldest === undefined) break;
        notified.delete(oldest);
      }
    }
    try {
      deps.notify(payload);
    } catch (err) {
      log.warn('live check notification failed', { error: errorName(err) });
    }
  }

  /**
   * Watcher results: items only. Nothing at all happens for a non-item. ACT-7: one alert per check, so the
   * "Flip:" notification is for a watcher whose popup is off; the popup already shows the flip.
   */
  function onWatchResult(result: CheckResult, s: number): void {
    if (result.status !== 'item') return;
    const settings = deps.settings();
    if (settings.check.popup) queuePopup(result, s);
    else if (settings.check.notifyFlips && result.verdict === 'flip') maybeNotify(result, settings);
  }

  async function runWatch(copied: string, run: number): Promise<void> {
    watchBusy = true;
    const s = ++seq;
    let result: CheckResult | null = null;
    try {
      // Read when the check is sent: a copy that waited behind another gets the arm as it is now.
      const hint = armHint();
      const answer = await (hint ? deps.check(copied, 'watch', hint) : deps.check(copied, 'watch'));
      if (isCheckResult(answer)) result = answer;
      else log.warn('live check: the service answered in an unexpected shape');
    } catch (err) {
      log.warn('live check (watch) failed', { error: errorName(err) });
    }
    watchBusy = false;
    const next = watchNext;
    watchNext = null;
    try {
      if (result && run === watchRun) onWatchResult(result, s);
    } catch (err) {
      // Not left to main's unhandled-rejection handler, and the waiting copy still gets its check.
      log.warn('live check (watch) result could not be used', { error: errorName(err) });
    }
    if (next !== null) watched(next);
  }

  /** The watcher's onText (already filtered): one check in flight, the newest copy waits. */
  function watched(copied: string): void {
    if (stopped || !watch.running()) return;
    // Before the queue: the app's own copy never takes the waiting slot from a copy the user made.
    if (takeOwnCopy(copied)) return;
    // A service that is down gets nothing queued: the copy is simply not checked.
    if (!deps.serviceReady()) return;
    if (watchBusy) {
      watchNext = copied;
      return;
    }
    void runWatch(copied, watchRun);
  }

  async function checkForHotkey(): Promise<CheckResult> {
    let copied: string;
    try {
      const v: unknown = await deps.readText();
      copied = typeof v === 'string' ? v : '';
    } catch (err) {
      log.warn('live check: the clipboard could not be read', { error: errorName(err) });
      return blankCheckResult('refused', CHECK_CLIPBOARD_UNREADABLE, 'hotkey', now());
    }
    // The filter runs before anything leaves main; a refused text never reaches the service.
    const f = shouldCheckClipboardText(copied, null);
    if (!f.ok) return blankCheckResult('refused', clipboardSkipMessage(f.reason ?? 'empty'), 'hotkey', now());
    if (!deps.serviceReady()) return blankCheckResult('refused', CHECK_NOT_READY_REASON, 'hotkey', now());
    // The watcher would otherwise check the same copy again and pop it up a second time.
    watch.markChecked(copied);
    // The user asked, so the armed name is checked here too; it still uses up the once, since after
    // markChecked the watcher never sees this copy, and a later copy of the name is the user's own.
    takeOwnCopy(copied);
    try {
      const hint = armHint();
      const answer = await (hint ? deps.check(copied, 'hotkey', hint) : deps.check(copied, 'hotkey'));
      if (isCheckResult(answer)) return answer;
      log.warn('live check: the service answered in an unexpected shape');
    } catch (err) {
      log.warn('live check (hotkey) failed', { error: errorName(err) });
    }
    return blankCheckResult('refused', CHECK_FAILED_REASON, 'hotkey', now());
  }

  function stopWatch(): void {
    if (watch.running()) watch.stop();
    watchRun++;
    watchNext = null;
    cancelPending();
  }

  return {
    async hotkey() {
      if (stopped) return;
      const t = now();
      // Debounced on every event, not only accepted ones: a held key's repeats keep extending one press,
      // and the next press counts only after a quiet gap (the key was released).
      const repeat = t - lastHotkeyAt < CHECK_HOTKEY_MIN_GAP_MS;
      lastHotkeyAt = t;
      if (repeat) return;
      const s = ++seq;
      try {
        const result = await checkForHotkey();
        if (stopped || s < shownSeq) return;
        // A watcher result still waiting for its slot is older than this one.
        if (pending && pending.seq < s) cancelPending();
        show(result, s, now() - t <= CHECK_HOTKEY_FOCUS_MS);
      } catch (err) {
        // Never rejects: main's unhandled-rejection handler would log the whole error.
        log.warn('live check hotkey failed', { error: errorName(err) });
      }
    },

    syncWatch() {
      const on = !stopped && deps.settings().check.watchClipboard;
      if (on && !watch.running()) watch.start();
      else if (!on && watch.running()) stopWatch();
    },

    watching: () => watch.running(),

    arm(a) {
      // A new arm replaces the old one whole, own-copy drop included: the page copies the name again.
      if (stopped || a === null) {
        armed = null;
        return { armedUntil: null };
      }
      const t = now();
      const next: ArmState = { sku: a.sku, nameHash: clipboardTextHash(a.name.trim()), until: t + CHECK_ARM_MS, ownCopyDropped: false, ownCopyUntil: t + ownCopyMs };
      // Nothing to drop when the page's copy can never reach the watcher as new: it is off or paused
      // (it reads afresh when it resumes), or it saw the name last (the copy changes nothing, e.g. the
      // same row opened twice). Otherwise a later copy of the name, the user's own, would be dropped.
      // A running watcher not yet primed is settled by its priming read (primedWith) or the time bound.
      next.ownCopyDropped = !watch.running() || watchPaused() || watch.isLastSeen(next.nameHash);
      armed = next;
      return { armedUntil: next.until };
    },

    stop() {
      stopped = true;
      armed = null;
      stopWatch();
    },
  };
}
