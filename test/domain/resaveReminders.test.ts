// F20 S5 re-save reminders (src/service/domain/resaveReminders.ts) over a real in-memory repo and fake
// timers: the gates (minutes, import on and acknowledged, notifications on, network not paused), only
// banks saved before (the chosen ones, [] = every saved bank), once per N minutes and again after a new
// save, the notify payload (its openUrl only ever a static SCRAPTF_BANKS URL), the timer and failures.
// A reminder only asks the user to save a page; nothing here makes a request or touches scrap.tf.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { RESAVE_TICK_MS, createResaveReminders, type ResaveReminders } from '../../src/service/domain/resaveReminders';
import { SCRAPTF_BANKS, isAllowedExternalUrl, isScraptfBankUrl } from '../../src/shared/links';
import type { PushContract } from '../../src/shared/rpc';
import { scraptfResaveNotice } from '../../src/shared/scraptfHistory';
import type { DeepPartial, ScraptfBank, Settings, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, recordingLogger, testSettings } from './helpers';

const HOUR = 60 * MIN;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

/** On: 60 minutes, import enabled and acknowledged, notifications on. */
const ON: DeepPartial<Settings> = { import: { enabled: true, acknowledgedAt: T0 - 24 * HOUR, resaveReminderMin: 60 }, notifications: { enabled: true } };

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, page = `/buy/${bank}`): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: 1, bank });
  repo.insertBankStock(id, bank, [{ sku: '378;6', specialKey: '', name: 'Team Captain', costKeys: 0, costScrap: 40, stock: 1, assetId: null }], page);
  return id;
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  timers: FakeTimers;
  settings: { current: Settings };
  paused: { v: boolean };
  sent: PushContract['notify'][];
  log: ReturnType<typeof recordingLogger>;
  reminders: ResaveReminders;
  set(patch: DeepPartial<Settings>): void;
}

function setup(patch: DeepPartial<Settings> = ON): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const clock = new FakeClock(T0);
  const timers = new FakeTimers(clock);
  const settings = { current: testSettings(patch) };
  const paused = { v: false };
  const sent: PushContract['notify'][] = [];
  const log = recordingLogger();
  const reminders = createResaveReminders({
    clock,
    log,
    repo,
    timers,
    settings: () => settings.current,
    networkPaused: () => paused.v,
    notify: (n) => sent.push(n),
  });
  return { repo, clock, timers, settings, paused, sent, log, reminders, set: (p) => (settings.current = testSettings(p)) };
}

describe('re-save reminders: what is reminded and when', () => {
  it('reminds of a bank not saved for N minutes, with the shared texts and its static page', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 90 * MIN);
    expect(h.reminders.tick(T0)).toBe(1);
    expect(h.sent).toEqual([scraptfResaveNotice('hats', T0 - 90 * MIN, T0)]);
    expect(h.sent[0]).toEqual({
      title: 'Re-save scrap.tf/buy/hats',
      body: "Last saved 1 h 30 m ago. Save it again (Ctrl+S, 'Webpage, Complete') to refresh prices and see what changed",
      sku: null,
      openUrl: SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url,
    });
    // The URL main may open on a click: a static bank page on the allowlist, never item data.
    expect(isScraptfBankUrl(h.sent[0]!.openUrl!) && isAllowedExternalUrl(h.sent[0]!.openUrl!)).toBe(true);
  });

  it('once per N minutes, and a new save starts the wait over', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 61 * MIN);
    expect(h.reminders.tick(T0 - 2 * MIN)).toBe(0); // 59 min since the save
    expect(h.reminders.tick(T0)).toBe(1);
    expect(h.reminders.tick(T0 + 59 * MIN)).toBe(0);
    expect(h.reminders.tick(T0 + 60 * MIN)).toBe(1);
    expect(h.sent[1]!.body).toMatch(/^Last saved 2 h 01 m ago\./);
    // The user saved again: nothing until N minutes after that save.
    save(h.repo, 'hats', T0 + 70 * MIN);
    expect(h.reminders.tick(T0 + 120 * MIN)).toBe(0);
    expect(h.reminders.tick(T0 + 130 * MIN)).toBe(1);
    expect(h.sent).toHaveLength(3);
  });

  it('only banks saved before: the chosen ones, [] meaning every saved bank; a bank’s newest page counts', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 3 * HOUR);
    save(h.repo, 'list', T0 - 5 * HOUR, '/items');
    save(h.repo, 'list', T0 - 10 * MIN, '/items/2');
    // The list's newest page was saved 10 minutes ago: only hats is due.
    expect(h.reminders.tick(T0)).toBe(1);
    expect(h.sent.map((n) => n.title)).toEqual(['Re-save scrap.tf/buy/hats']);
    const chosen = setup({ ...ON, import: { ...ON.import, resaveBanks: ['weapons', 'list'] } });
    save(chosen.repo, 'hats', T0 - 3 * HOUR);
    save(chosen.repo, 'list', T0 - 3 * HOUR, '/items');
    expect(chosen.reminders.tick(T0)).toBe(1);
    // Weapons was never saved: never reminded of.
    expect(chosen.sent.map((n) => n.title)).toEqual(['Re-save scrap.tf/items']);
    const none = setup();
    expect(none.reminders.tick(T0)).toBe(0);
  });

  it('the gates: off at 0 minutes, import off or not acknowledged, notifications off, network paused', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 3 * HOUR);
    const index = vi.spyOn(h.repo, 'bankStockSaveIndex');
    const closed: DeepPartial<Settings>[] = [
      { ...ON, import: { ...ON.import, resaveReminderMin: 0 } },
      { ...ON, import: { ...ON.import, enabled: false } },
      { ...ON, import: { ...ON.import, acknowledgedAt: null } },
      { ...ON, notifications: { enabled: false } },
    ];
    for (const p of closed) {
      h.set(p);
      expect(h.reminders.tick(T0), JSON.stringify(p)).toBe(0);
    }
    h.set(ON);
    h.paused.v = true;
    expect(h.reminders.tick(T0)).toBe(0);
    // A closed gate reads nothing from the database.
    expect(index).not.toHaveBeenCalled();
    h.paused.v = false;
    expect(h.reminders.tick(T0)).toBe(1);
    // Silent is main's: the reminder is still pushed and main mutes it like every 'notify'.
    const quiet = setup({ ...ON, notifications: { enabled: true, silent: true } });
    save(quiet.repo, 'hats', T0 - 3 * HOUR);
    expect(quiet.reminders.tick(T0)).toBe(1);
  });

  it('a network check that fails counts as paused', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 3 * HOUR);
    const r = createResaveReminders({
      clock: h.clock,
      log: h.log,
      repo: h.repo,
      timers: h.timers,
      settings: () => h.settings.current,
      networkPaused: () => {
        throw new Error('no http client');
      },
      notify: (n) => h.sent.push(n),
    });
    expect(r.tick(T0)).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it('never throws: a failed read is logged once per streak, a failed push is not retried every minute', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 3 * HOUR);
    const index = vi.spyOn(h.repo, 'bankStockSaveIndex').mockImplementation(() => {
      throw new Error('database is locked');
    });
    expect(h.reminders.tick(T0)).toBe(0);
    expect(h.reminders.tick(T0 + MIN)).toBe(0);
    expect(h.log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    index.mockRestore();
    const notify = vi.fn(() => {
      throw new Error('port closed');
    });
    const r = createResaveReminders({ clock: h.clock, log: h.log, repo: h.repo, timers: h.timers, settings: () => h.settings.current, networkPaused: () => false, notify });
    expect(r.tick(T0)).toBe(0);
    expect(r.tick(T0 + MIN)).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(h.log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });
});

describe('re-save reminders: the timer', () => {
  it('looks every RESAVE_TICK_MS once started (idempotent) and never after stop()', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 59 * MIN);
    h.reminders.start();
    h.reminders.start();
    expect(h.timers.count).toBe(1);
    expect(RESAVE_TICK_MS).toBe(60_000);
    // 60 minutes after the save: the first look after it is due.
    h.timers.advance(RESAVE_TICK_MS - 1);
    expect(h.sent).toHaveLength(0);
    h.timers.advance(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.body).toMatch(/^Last saved 1 h 00 m ago\./);
    // Then once an hour, however many looks.
    h.timers.advance(59 * MIN);
    expect(h.sent).toHaveLength(1);
    h.timers.advance(MIN);
    expect(h.sent).toHaveLength(2);
    expect(h.timers.count).toBe(1);
    h.reminders.stop();
    expect(h.timers.count).toBe(0);
    h.timers.advance(5 * HOUR);
    expect(h.sent).toHaveLength(2);
    // Turned on later from Settings: picked up by the next look, no restart needed.
    const later = setup({ ...ON, import: { ...ON.import, resaveReminderMin: 0 } });
    save(later.repo, 'hats', T0 - 3 * HOUR);
    later.reminders.start();
    later.timers.advance(10 * MIN);
    expect(later.sent).toHaveLength(0);
    later.set(ON);
    later.timers.advance(RESAVE_TICK_MS);
    expect(later.sent).toHaveLength(1);
  });
});
