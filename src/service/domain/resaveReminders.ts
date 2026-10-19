// Re-save reminders (F20 S5, opt-in): while the app runs, a desktop notification per bank the user has
// saved before but not for settings.import.resaveReminderMin minutes, once per that many minutes. The
// app cannot refresh scrap.tf itself (R1): a reminder only asks the user to save the page again. Its
// notify payload may carry `openUrl`, the bank's static SCRAPTF_BANKS URL (scraptfResaveNotice), which
// main opens in the user's browser on a click only, after its own allowlist check (a click is a user
// action). No request of any kind is made here, and no URL is built: the rules and texts are
// scraptfResaveBanksOf, scraptfResaveDue and scraptfResaveNotice in src/shared/scraptfHistory.ts.

import type { PushContract } from '../../shared/rpc';
import { scraptfResaveBanksOf, scraptfResaveDue, scraptfResaveNotice } from '../../shared/scraptfHistory';
import type { ScraptfBank, Settings, UnixMs } from '../../shared/types';
import type { Clock, Logger, Repo } from '../contracts';
import { realTimers, type TimerApi } from '../net/ratelimit';

/** How often the reminders look (a reminder is at most this late). */
export const RESAVE_TICK_MS = 60_000;

export interface ResaveRemindersDeps {
  clock: Clock;
  log: Logger;
  /** Each bank's newest save (the newest savedAt per bank of bankStockSaveIndex): a bank never saved is never reminded of. */
  repo: Pick<Repo, 'bankStockSaveIndex'>;
  settings(): Settings;
  /** core: settings.networkPaused || http.isPaused(). No reminder while paused. */
  networkPaused(): boolean;
  /** core: push('notify', n). Respects notifications.enabled; main applies notifications.silent. */
  notify(n: PushContract['notify']): void;
  /** Injected in tests; defaults to unref'd real timers. */
  timers?: TimerApi;
}

export interface ResaveReminders {
  /** Starts the RESAVE_TICK_MS timer (core: start(), after the market index). Idempotent. */
  start(): void;
  /** Stops it (core: stop()). */
  stop(): void;
  /**
   * One look at `now`: for each bank of scraptfResaveBanksOf(settings.import.resaveBanks, saved banks)
   * that scraptfResaveDue says is due, one notify(scraptfResaveNotice(...)), gated on
   * resaveReminderMin > 0, import enabled and acknowledged, notifications.enabled and the network not
   * paused. Returns the reminders sent. Never throws.
   */
  tick(now: UnixMs): number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The reminder minutes when every gate is open, else null (nothing is read from the database then). */
function minutesOf(s: Settings | null | undefined): number | null {
  const imp = s?.import;
  const minutes = imp?.resaveReminderMin;
  if (!finite(minutes) || minutes < 1) return null;
  // Import is opt-in behind its acknowledgement (R10): with it off, saving again would import nothing.
  if (imp?.enabled !== true || imp.acknowledgedAt === null || imp.acknowledgedAt === undefined) return null;
  if (s?.notifications?.enabled !== true) return null;
  return minutes;
}

export function createResaveReminders(deps: ResaveRemindersDeps): ResaveReminders {
  const { log } = deps;
  const timers = deps.timers ?? realTimers;
  let timer: unknown = null;
  let started = false;
  /** In memory: a restart may remind once more, which only asks the user to save a page. */
  const remindedAt = new Map<ScraptfBank, UnixMs>();
  let failing = false;

  function now(): UnixMs {
    try {
      return deps.clock.now();
    } catch {
      return Date.now();
    }
  }

  function paused(): boolean {
    try {
      return deps.networkPaused() === true;
    } catch {
      // Unknown: quiet is the safer side of a reminder.
      return true;
    }
  }

  function tick(at: UnixMs): number {
    try {
      const s = deps.settings();
      const minutes = minutesOf(s);
      if (minutes === null || !finite(at) || paused()) return 0;
      const lastSaved = new Map<ScraptfBank, UnixMs>();
      for (const save of deps.repo.bankStockSaveIndex()) {
        const cur = lastSaved.get(save.bank);
        if (finite(save.savedAt) && (cur === undefined || save.savedAt > cur)) lastSaved.set(save.bank, save.savedAt);
      }
      failing = false;
      let sent = 0;
      for (const bank of scraptfResaveBanksOf(s.import.resaveBanks, lastSaved.keys())) {
        const lastSavedAt = lastSaved.get(bank) ?? null;
        if (lastSavedAt === null || !scraptfResaveDue({ minutes, lastSavedAt, lastRemindedAt: remindedAt.get(bank) ?? null, now: at })) continue;
        // F21-9: a window user is told to open the page there, not to press Ctrl+S (the click still opens the browser).
        const notice = scraptfResaveNotice(bank, lastSavedAt, at, s.scraptfWindow);
        if (!notice) continue;
        // Recorded before the push: a failing push is not retried every minute.
        remindedAt.set(bank, at);
        try {
          deps.notify(notice);
          sent++;
        } catch (err) {
          log.warn('Re-save reminder failed', { bank, error: errorText(err) });
        }
      }
      return sent;
    } catch (err) {
      // Logged once per failure streak, not once a minute.
      if (!failing) log.warn('Re-save reminders could not read the saved pages', { error: errorText(err) });
      failing = true;
      return 0;
    }
  }

  function arm(): void {
    if (!started || timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      tick(now());
      arm();
    }, RESAVE_TICK_MS);
  }

  return {
    start() {
      if (started) return;
      started = true;
      arm();
    },
    stop() {
      started = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
    tick,
  };
}
