// F16 live check in main (src/main/liveCheck.ts): the check hotkey (clipboard read once, filtered in
// main, focused popup) and the opt-in watcher's checks (start/stop with the setting, paused while
// locked/suspended/network paused, one check in flight, items only, a popup at most every 1.5 s with
// the newest replacing, flip notifications deduped per SKU). Fakes stand in for the clipboard, the
// service, the popup, notifications and timers. The privacy block proves the main logger never
// receives clipboard text, whatever fails on the way.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboardSkipMessage } from '../../src/main/clipboardWatch';
import {
  CHECK_CLIPBOARD_UNREADABLE,
  CHECK_FAILED_REASON,
  CHECK_HOTKEY_FOCUS_MS,
  CHECK_HOTKEY_MIN_GAP_MS,
  CHECK_NOT_READY_REASON,
  CHECK_OWN_COPY_MS,
  createLiveCheckMain,
  flipNotification,
  isCheckResult,
  type LiveCheckMainDeps,
} from '../../src/main/liveCheck';
import { createMainLog } from '../../src/main/serviceHost';
import type { Logger } from '../../src/service/contracts';
import {
  blankCheckResult,
  CHECK_ARM_MS,
  CHECK_EXTRAS_NOTE,
  CHECK_INCOMPLETE_NOTE,
  CHECK_NOTIFY_DEDUP_MS,
  CHECK_POPUP_MIN_GAP_MS,
  CHECK_REFUSALS,
  CHECK_WATCH_INTERVAL_MS,
} from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckHint, CheckResult, CheckSource, ItemRevenue, Settings } from '../../src/shared/types';

const STEAM_KEY = '0123456789ABCDEF0123456789ABCDEF';
const K = 540; // 60 ref

function itemResult(over: Partial<CheckResult> = {}): CheckResult {
  const revenue: ItemRevenue = {
    bestScrap: 30,
    consScrap: 30,
    instantScrap: 28,
    useOrder: 'conservative',
    revenueScrap: 30,
    order: null,
    maxCostScrap: 25,
    eligibleCount: 3,
  };
  return {
    ...blankCheckResult('not-item', 'x', 'watch', 1),
    id: 1,
    status: 'item',
    reason: null,
    sku: '378;6',
    name: 'Team Captain',
    price: { keys: 0, scrapRaw: 12, valueScrap: 12, source: 'clipboard', observedAt: 1 },
    revenue,
    profitScrap: 16,
    margin: 1.33,
    verdict: 'flip',
    confidence: 80,
    confidenceLevel: 'high',
    keyScrap: K,
    ...over,
  };
}

type Answer = CheckResult | Error | unknown;

interface Pending {
  text: string;
  source: CheckSource;
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

/** Everything the controller touches, faked; `answers` decides what the service says per text. */
function harness(init: { watch?: boolean; popup?: boolean; notifyFlips?: boolean; notificationsEnabled?: boolean } = {}) {
  let clip: string | Error = 'copied before anything started';
  let now = 1_000_000;
  let systemPaused = false;
  let ready = true;
  let manual = false;
  let nextId = 1;
  const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  settings.check.watchClipboard = init.watch ?? false;
  settings.check.popup = init.popup ?? true;
  settings.check.notifyFlips = init.notifyFlips ?? true;
  settings.notifications.enabled = init.notificationsEnabled ?? true;
  const answers = new Map<string, (source: CheckSource) => Answer>();
  const pending: Pending[] = [];
  let tick: (() => void) | null = null;
  let timeoutSeq = 0;
  const timeouts: { id: number; at: number; fn: () => void }[] = [];

  const timers = {
    setInterval: vi.fn((fn: () => void, _ms: number) => {
      tick = fn;
      return 'interval';
    }),
    clearInterval: vi.fn(() => {
      tick = null;
    }),
    setTimeout: vi.fn((fn: () => void, ms: number) => {
      const id = ++timeoutSeq;
      timeouts.push({ id, at: now + ms, fn });
      return id;
    }),
    clearTimeout: vi.fn((id: unknown) => {
      const i = timeouts.findIndex((t) => t.id === id);
      if (i >= 0) timeouts.splice(i, 1);
    }),
  };

  const answerFor = (text: string, source: CheckSource): unknown => {
    const custom = answers.get(text);
    if (custom) return custom(source);
    if (/unknown/i.test(text)) return blankCheckResult('not-item', 'No TF2 item recognised in that text.', source, now, nextId++);
    return itemResult({ id: nextId++, source, checkedAt: now });
  };

  const readText = vi.fn(async () => {
    if (clip instanceof Error) throw clip;
    return clip;
  });
  const check = vi.fn((text: string, source: 'hotkey' | 'watch', _hint?: CheckHint) => {
    if (manual) return new Promise<unknown>((resolve, reject) => pending.push({ text, source, resolve, reject }));
    const a = answerFor(text, source);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  });
  const showPopup = vi.fn<(r: CheckResult, o: { focus: boolean }) => void>();
  const notify = vi.fn();
  const log: Logger & Record<string, ReturnType<typeof vi.fn>> = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const deps: LiveCheckMainDeps = {
    readText,
    check,
    serviceReady: () => ready,
    showPopup,
    notify,
    settings: () => settings,
    systemPaused: () => systemPaused,
    log,
    now: () => now,
    timers,
  };
  const ctl = createLiveCheckMain(deps);

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  return {
    ctl,
    deps,
    settings,
    readText,
    check,
    showPopup,
    notify,
    log,
    timers,
    answers,
    pending,
    flush,
    copy: (t: string | Error) => {
      clip = t;
    },
    setReady: (r: boolean) => {
      ready = r;
    },
    setSystemPaused: (p: boolean) => {
      systemPaused = p;
    },
    manual: (m: boolean) => {
      manual = m;
    },
    /** One watcher tick, then lets the async read and check settle. */
    poll: async () => {
      tick?.();
      await flush();
    },
    ticking: () => tick !== null,
    /** Moves the clock, running due timeouts in order. */
    advance: async (ms: number) => {
      const until = now + ms;
      for (;;) {
        timeouts.sort((a, b) => a.at - b.at);
        const due = timeouts[0];
        if (!due || due.at > until) break;
        timeouts.shift();
        now = due.at;
        due.fn();
        await flush();
      }
      now = until;
      await flush();
    },
    shown: () => showPopup.mock.calls.map(([r, o]) => ({ id: r.id, status: r.status, source: r.source, focus: o.focus, reason: r.reason })),
  };
}

/** A started watcher whose priming read is done. */
async function watching(init: Parameters<typeof harness>[0] = {}) {
  const h = harness({ watch: true, ...init });
  h.ctl.syncWatch();
  await h.flush();
  return h;
}

describe('live check hotkey', () => {
  it('reads the clipboard once, checks it as the hotkey and shows the popup focused', async () => {
    const h = harness();
    h.copy('Team Captain, 1.33 ref');
    await h.ctl.hotkey();
    expect(h.readText).toHaveBeenCalledTimes(1);
    expect(h.check.mock.calls).toEqual([['Team Captain, 1.33 ref', 'hotkey']]);
    expect(h.shown()).toEqual([{ id: 1, status: 'item', source: 'hotkey', focus: true, reason: null }]);
    expect(h.showPopup.mock.calls[0]![0]).toMatchObject({ sku: '378;6', verdict: 'flip' });
  });

  it('refuses filtered text in main: the service never sees it, the popup shows a fixed reason', async () => {
    const cases: [string, string][] = [
      [STEAM_KEY, CHECK_REFUSALS.secret],
      // Wrapped in a link: still never sent on.
      [`https://discord.com/api/webhooks/1100000000000000000/${'Ab3dEfGhIjKl0123'.repeat(4)}`, CHECK_REFUSALS.link],
      ['https://example.com/oauth/callback?client_secret=Zx9Yw8Vu7Ts6Rq5Po4Nm3', CHECK_REFUSALS.secret],
      ['<b>Team Captain</b>', CHECK_REFUSALS.markup],
      ['a\nb\nc\nd', CHECK_REFUSALS.list],
      ['x'.repeat(401), CHECK_REFUSALS.tooLong],
      ['   ', CHECK_REFUSALS.empty],
      ['!!!', clipboardSkipMessage('no-text')],
    ];
    for (const [text, reason] of cases) {
      const h = harness();
      h.copy(text);
      await h.ctl.hotkey();
      expect(h.check).not.toHaveBeenCalled();
      expect(h.shown()).toEqual([{ id: 0, status: 'refused', source: 'hotkey', focus: true, reason }]);
    }
  });

  it('says so when the service is not ready, fails, answers oddly, or the clipboard cannot be read', async () => {
    const notReady = harness();
    notReady.setReady(false);
    notReady.copy('Team Captain');
    await notReady.ctl.hotkey();
    expect(notReady.check).not.toHaveBeenCalled();
    expect(notReady.shown()[0]).toMatchObject({ status: 'refused', reason: CHECK_NOT_READY_REASON, focus: true });

    const failing = harness();
    failing.answers.set('Team Captain', () => new Error('The service did not answer check.text within 10 s'));
    failing.copy('Team Captain');
    await failing.ctl.hotkey();
    expect(failing.shown()[0]).toMatchObject({ status: 'refused', reason: CHECK_FAILED_REASON });

    const odd = harness();
    odd.answers.set('Team Captain', () => ({ status: 'item' }));
    odd.copy('Team Captain');
    await odd.ctl.hotkey();
    expect(odd.shown()[0]).toMatchObject({ status: 'refused', reason: CHECK_FAILED_REASON });

    const unreadable = harness();
    unreadable.copy(new Error('clipboard busy'));
    await unreadable.ctl.hotkey();
    expect(unreadable.check).not.toHaveBeenCalled();
    expect(unreadable.shown()[0]).toMatchObject({ status: 'refused', reason: CHECK_CLIPBOARD_UNREADABLE });
  });

  it('shows not-item results with their reason, focused', async () => {
    const h = harness();
    h.copy('Unknown words');
    await h.ctl.hotkey();
    expect(h.shown()).toEqual([{ id: 1, status: 'not-item', source: 'hotkey', focus: true, reason: 'No TF2 item recognised in that text.' }]);
  });

  it('treats a held key (repeats closer than the gap) as one press', async () => {
    const h = harness();
    h.copy('Team Captain');
    await h.ctl.hotkey();
    await h.advance(CHECK_HOTKEY_MIN_GAP_MS - 1);
    await h.ctl.hotkey();
    expect(h.readText).toHaveBeenCalledTimes(1);
    // The repeat counted: the gap runs from the last key event, not from the accepted press.
    await h.advance(1);
    await h.ctl.hotkey();
    expect(h.readText).toHaveBeenCalledTimes(1);
    await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
    await h.ctl.hotkey();
    expect(h.readText).toHaveBeenCalledTimes(2);
  });

  it.each([250, 500, 750, 1000])('a key held for 2 s with a %i ms OS repeat delay is one check and one popup', async (delay) => {
    const h = harness();
    h.copy('Team Captain');
    // The press, the OS repeat delay, then a repeat every 33 ms until the key comes up at 2 s.
    await h.ctl.hotkey();
    await h.advance(delay);
    for (let held = delay; held < 2_000; held += 33) {
      await h.ctl.hotkey();
      await h.advance(33);
    }
    expect(h.readText).toHaveBeenCalledTimes(1);
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.showPopup).toHaveBeenCalledTimes(1);
    // Released: the next press after a quiet gap is a new check.
    await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
    await h.ctl.hotkey();
    expect(h.readText).toHaveBeenCalledTimes(2);
    expect(h.showPopup).toHaveBeenCalledTimes(2);
  });

  it("waits out the longest OS key-repeat delay (about 1 s on Windows) before counting a new press", () => {
    expect(CHECK_HOTKEY_MIN_GAP_MS).toBeGreaterThan(1_000);
  });

  it('shows a late answer without focus, so it cannot take keys the user is typing elsewhere', async () => {
    const h = harness();
    h.manual(true);
    h.copy('Team Captain');
    const prompt = h.ctl.hotkey();
    await h.flush();
    await h.advance(CHECK_HOTKEY_FOCUS_MS);
    h.pending[0]!.resolve(itemResult({ id: 1, source: 'hotkey' }));
    await prompt;
    h.copy("Bill's Hat");
    const late = h.ctl.hotkey();
    await h.flush();
    await h.advance(CHECK_HOTKEY_FOCUS_MS + 1);
    h.pending[1]!.resolve(itemResult({ id: 2, source: 'hotkey' }));
    await late;
    expect(h.shown().map((s) => ({ id: s.id, focus: s.focus }))).toEqual([
      { id: 1, focus: true },
      { id: 2, focus: false },
    ]);
  });

  it('always shows its popup, even with the watcher popup setting off', async () => {
    const h = harness({ popup: false });
    h.copy('Team Captain');
    await h.ctl.hotkey();
    expect(h.showPopup).toHaveBeenCalledTimes(1);
  });

  it('never shows an older result over a newer one', async () => {
    const h = harness();
    h.manual(true);
    h.copy('Team Captain');
    const first = h.ctl.hotkey();
    await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
    h.copy("Bill's Hat");
    const second = h.ctl.hotkey();
    await h.flush();
    expect(h.pending.map((p) => p.text)).toEqual(['Team Captain', "Bill's Hat"]);
    h.pending[1]!.resolve(itemResult({ id: 2, source: 'hotkey', name: "Bill's Hat" }));
    await second;
    h.pending[0]!.resolve(itemResult({ id: 1, source: 'hotkey' }));
    await first;
    expect(h.shown().map((s) => s.id)).toEqual([2]);
  });

  it('does nothing after stop()', async () => {
    const h = harness();
    h.ctl.stop();
    await h.ctl.hotkey();
    expect(h.readText).not.toHaveBeenCalled();
  });
});

describe('live check clipboard watcher', () => {
  it('starts and stops with settings.check.watchClipboard (off by default)', async () => {
    const h = harness();
    expect(DEFAULT_SETTINGS.check.watchClipboard).toBe(false);
    h.ctl.syncWatch();
    expect(h.ctl.watching()).toBe(false);
    expect(h.readText).not.toHaveBeenCalled();
    h.settings.check.watchClipboard = true;
    h.ctl.syncWatch();
    h.ctl.syncWatch();
    expect(h.ctl.watching()).toBe(true);
    expect(h.timers.setInterval).toHaveBeenCalledTimes(1);
    expect(h.timers.setInterval).toHaveBeenCalledWith(expect.any(Function), CHECK_WATCH_INTERVAL_MS);
    h.settings.check.watchClipboard = false;
    h.ctl.syncWatch();
    expect(h.ctl.watching()).toBe(false);
    expect(h.ticking()).toBe(false);
  });

  it('checks only copies made while it watches, as source watch, and pops items up without focus', async () => {
    const h = await watching();
    await h.poll();
    expect(h.check).not.toHaveBeenCalled();
    h.copy('Team Captain');
    await h.poll();
    await h.poll();
    expect(h.check.mock.calls).toEqual([['Team Captain', 'watch']]);
    expect(h.shown()).toEqual([{ id: 1, status: 'item', source: 'watch', focus: false, reason: null }]);
  });

  it('does nothing at all for non-items', async () => {
    const h = await watching();
    h.copy('Unknown words here');
    await h.poll();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.showPopup).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('never sends text the privacy filter refuses', async () => {
    const h = await watching();
    for (const t of [STEAM_KEY, '<b>x</b>', 'a\nb\nc\nd', 'x'.repeat(500), '!!!', 'https://user:pw@example.com/']) {
      h.copy(t);
      await h.poll();
    }
    expect(h.check).not.toHaveBeenCalled();
  });

  it('reads nothing while the network is paused or the system is locked or suspended', async () => {
    const h = await watching();
    const reads = h.readText.mock.calls.length;
    h.settings.networkPaused = true;
    h.copy('Team Captain');
    await h.poll();
    h.settings.networkPaused = false;
    h.setSystemPaused(true);
    await h.poll();
    expect(h.readText.mock.calls.length).toBe(reads);
    h.setSystemPaused(false);
    // The first read after a pause primes: the copy made during it is not new.
    await h.poll();
    await h.poll();
    expect(h.check).not.toHaveBeenCalled();
  });

  it('keeps one check in flight: the newest copy waits, older waiting copies are dropped', async () => {
    const h = await watching();
    h.manual(true);
    h.copy('Team Captain');
    await h.poll();
    h.copy("Bill's Hat");
    await h.poll();
    h.copy('Earbuds');
    await h.poll();
    expect(h.pending.map((p) => p.text)).toEqual(['Team Captain']);
    h.pending[0]!.resolve(itemResult({ id: 1 }));
    await h.flush();
    expect(h.pending.map((p) => p.text)).toEqual(['Team Captain', 'Earbuds']);
  });

  it('shows at most one popup per 1.5 s, and the newest waiting result is the one shown', async () => {
    const h = await watching();
    h.copy('Team Captain');
    await h.poll();
    expect(h.shown().map((s) => s.id)).toEqual([1]);
    await h.advance(100);
    h.copy("Bill's Hat");
    await h.poll();
    await h.advance(100);
    h.copy('Earbuds');
    await h.poll();
    expect(h.shown().map((s) => s.id)).toEqual([1]);
    await h.advance(CHECK_POPUP_MIN_GAP_MS - 300);
    expect(h.shown().map((s) => s.id)).toEqual([1]);
    await h.advance(100);
    expect(h.shown().map((s) => ({ id: s.id, focus: s.focus }))).toEqual([
      { id: 1, focus: false },
      { id: 3, focus: false },
    ]);
    // After the gap the next one shows at once.
    await h.advance(CHECK_POPUP_MIN_GAP_MS);
    h.copy('Conga');
    await h.poll();
    expect(h.shown().map((s) => s.id)).toEqual([1, 3, 4]);
  });

  it('shows no popup with check.popup off, and drops a waiting one when it is turned off', async () => {
    const off = await watching({ popup: false });
    off.copy('Team Captain');
    await off.poll();
    expect(off.showPopup).not.toHaveBeenCalled();
    expect(off.notify).toHaveBeenCalledTimes(1);

    const h = await watching();
    h.copy('Team Captain');
    await h.poll();
    h.copy('Earbuds');
    await h.poll();
    h.settings.check.popup = false;
    await h.advance(CHECK_POPUP_MIN_GAP_MS);
    expect(h.showPopup).toHaveBeenCalledTimes(1);
  });

  it('notifies flips once per SKU per minute, only with notifyFlips and notifications on', async () => {
    const h = await watching();
    h.copy('Team Captain');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toEqual({
      title: 'Flip: Team Captain',
      body: 'scrap.tf 1.33 ref (copied) → sells for 3.33 ref, +1.77 ref (133%)',
      sku: '378;6',
    });
    await h.advance(1000);
    h.copy('Team Captain, 1 ref');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(1);
    await h.advance(CHECK_NOTIFY_DEDUP_MS);
    h.copy('Team Captain');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(2);
    // Another SKU is not held back by the first.
    h.answers.set('Earbuds', (source) => itemResult({ id: 99, source, sku: '143;6', name: 'Earbuds' }));
    h.copy('Earbuds');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(3);

    for (const init of [{ notifyFlips: false }, { notificationsEnabled: false }]) {
      const q = await watching(init);
      q.copy('Team Captain');
      await q.poll();
      expect(q.notify).not.toHaveBeenCalled();
      expect(q.showPopup).toHaveBeenCalledTimes(1);
    }

    const over = await watching();
    over.answers.set('Team Captain', (source) => itemResult({ source, verdict: 'over', profitScrap: -3 }));
    over.copy('Team Captain');
    await over.poll();
    expect(over.notify).not.toHaveBeenCalled();
  });

  it('never notifies or pops up from the hotkey path', async () => {
    const h = harness();
    h.copy('Team Captain');
    await h.ctl.hotkey();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('drops a copy while the service is down, and a reply that arrives after the watcher stopped', async () => {
    const down = await watching();
    down.setReady(false);
    down.copy('Team Captain');
    await down.poll();
    expect(down.check).not.toHaveBeenCalled();

    const h = await watching();
    h.manual(true);
    h.copy('Team Captain');
    await h.poll();
    h.settings.check.watchClipboard = false;
    h.ctl.syncWatch();
    h.pending[0]!.resolve(itemResult());
    await h.flush();
    expect(h.showPopup).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('logs a failed or malformed watcher check without acting on it', async () => {
    const h = await watching();
    h.answers.set('Team Captain', () => new Error('boom'));
    h.answers.set('Earbuds', () => 'nonsense');
    h.copy('Team Captain');
    await h.poll();
    h.copy('Earbuds');
    await h.poll();
    expect(h.showPopup).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledTimes(2);
  });

  it('a result that cannot be used is logged by class, and the copy waiting behind it is still checked', async () => {
    const h = harness({ watch: true });
    let boom = false;
    const ctl = createLiveCheckMain({
      ...h.deps,
      settings: () => {
        if (boom) throw new Error('settings unavailable');
        return h.settings;
      },
    });
    ctl.syncWatch();
    await h.flush();
    h.manual(true);
    h.copy('Team Captain');
    await h.poll();
    h.copy('Earbuds');
    await h.poll();
    boom = true;
    h.pending[0]!.resolve(itemResult({ id: 1 }));
    await h.flush();
    expect(h.pending.map((p) => p.text)).toEqual(['Team Captain', 'Earbuds']);
    expect(h.log.warn).toHaveBeenCalledWith('live check (watch) result could not be used', { error: 'Error' });
    ctl.stop();
  });

  it('a hotkey check marks the copy seen, so the watcher does not pop it up again', async () => {
    const h = await watching();
    h.copy('Team Captain');
    await h.ctl.hotkey();
    await h.poll();
    expect(h.check.mock.calls).toEqual([['Team Captain', 'hotkey']]);
    expect(h.shown().map((s) => s.source)).toEqual(['hotkey']);
  });

  it('a hotkey result cancels an older watcher popup still waiting for its slot', async () => {
    const h = await watching();
    h.copy('Team Captain');
    await h.poll();
    await h.advance(100);
    h.copy('Earbuds');
    await h.poll();
    await h.advance(100);
    h.copy('Conga');
    await h.ctl.hotkey();
    await h.advance(5000);
    expect(h.shown().map((s) => ({ source: s.source, focus: s.focus }))).toEqual([
      { source: 'watch', focus: false },
      { source: 'hotkey', focus: true },
    ]);
  });

  it('stop() ends the watcher and drops a waiting popup', async () => {
    const h = await watching();
    h.copy('Team Captain');
    await h.poll();
    h.copy('Earbuds');
    await h.poll();
    h.ctl.stop();
    expect(h.ctl.watching()).toBe(false);
    await h.advance(5000);
    expect(h.showPopup).toHaveBeenCalledTimes(1);
    h.ctl.syncWatch();
    expect(h.ctl.watching()).toBe(false);
  });
});

describe("F19 'check.arm' in main: the hint, the own-copy drop and expiry", () => {
  const ARM = { sku: '378;6', name: 'Team Captain' };
  const HINT: CheckHint = { sku: '378;6' };
  const last = (h: ReturnType<typeof harness>) => h.check.mock.calls.at(-1);

  it('arms for CHECK_ARM_MS (10 min) from now and answers with the expiry; null disarms', () => {
    const h = harness();
    const t = h.deps.now!();
    expect(CHECK_ARM_MS).toBe(10 * 60_000);
    expect(h.ctl.arm(ARM)).toEqual({ armedUntil: t + CHECK_ARM_MS });
    expect(h.ctl.arm(null)).toEqual({ armedUntil: null });
    // Disarming again is harmless.
    expect(h.ctl.arm(null)).toEqual({ armedUntil: null });
  });

  it('adds hint { sku } to the hotkey and watcher checks only while armed', async () => {
    const h = await watching();
    h.copy('1.33 ref');
    await h.poll();
    h.ctl.arm(ARM);
    h.copy('2 keys 5.11');
    await h.poll();
    h.copy('1.55 ref');
    await h.ctl.hotkey();
    h.ctl.arm(null);
    h.copy('1.66 ref');
    await h.poll();
    await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
    h.copy('1.77 ref');
    await h.ctl.hotkey();
    // Unarmed calls keep their two arguments: no hint key at all reaches 'check.text'.
    expect(h.check.mock.calls).toEqual([
      ['1.33 ref', 'watch'],
      ['2 keys 5.11', 'watch', HINT],
      ['1.55 ref', 'hotkey', HINT],
      ['1.66 ref', 'watch'],
      ['1.77 ref', 'hotkey'],
    ]);
  });

  it('hints the hotkey with the watcher off too', async () => {
    const h = harness();
    h.ctl.arm(ARM);
    h.copy('1.33 ref');
    await h.ctl.hotkey();
    expect(h.check.mock.calls).toEqual([['1.33 ref', 'hotkey', HINT]]);
  });

  it('hands each check its own hint object: changing one never reaches the arm', async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    h.copy('1.33 ref');
    await h.poll();
    h.check.mock.calls[0]![2]!.sku = '5021;6';
    h.copy('1.44 ref');
    await h.poll();
    expect(last(h)).toEqual(['1.44 ref', 'watch', HINT]);
  });

  it('lapses on its own after CHECK_ARM_MS, with no timer of its own', async () => {
    const h = await watching();
    const timeouts = h.timers.setTimeout.mock.calls.length;
    const intervals = h.timers.setInterval.mock.calls.length;
    h.ctl.arm(ARM);
    expect(h.timers.setTimeout.mock.calls.length).toBe(timeouts);
    expect(h.timers.setInterval.mock.calls.length).toBe(intervals);
    await h.advance(CHECK_ARM_MS - 1);
    h.copy('1.33 ref');
    await h.poll();
    expect(last(h)).toEqual(['1.33 ref', 'watch', HINT]);
    await h.advance(1);
    h.copy('1.44 ref');
    await h.poll();
    expect(last(h)).toEqual(['1.44 ref', 'watch']);
    // Lapsed: the name is an ordinary copy again, and the hotkey carries no hint either.
    h.copy('Team Captain');
    await h.poll();
    expect(last(h)).toEqual(['Team Captain', 'watch']);
    h.copy('1.55 ref');
    await h.ctl.hotkey();
    expect(last(h)).toEqual(['1.55 ref', 'hotkey']);
  });

  it('reads the arm when a waiting copy is sent: one that waited past the lapse gets no hint', async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    h.manual(true);
    h.copy('1.33 ref');
    await h.poll();
    h.copy('1.44 ref');
    await h.poll();
    await h.advance(CHECK_ARM_MS);
    h.pending[0]!.resolve(itemResult({ id: 1 }));
    await h.flush();
    expect(h.check.mock.calls).toEqual([
      ['1.33 ref', 'watch', HINT],
      ['1.44 ref', 'watch'],
    ]);
  });

  it('a new arm replaces the old one whole: its SKU, a fresh CHECK_ARM_MS and its own name', async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    await h.advance(5 * 60_000);
    const t = h.deps.now!();
    expect(h.ctl.arm({ sku: '143;6', name: 'Earbuds' })).toEqual({ armedUntil: t + CHECK_ARM_MS });
    // The first name is an ordinary copy now; the second is the app's own.
    h.copy('Team Captain');
    await h.poll();
    h.copy('Earbuds');
    await h.poll();
    expect(h.check.mock.calls).toEqual([['Team Captain', 'watch', { sku: '143;6' }]]);
    // Past the first arm's ten minutes, still within the second's.
    await h.advance(CHECK_ARM_MS - 1);
    h.copy('1.33 ref');
    await h.poll();
    expect(last(h)).toEqual(['1.33 ref', 'watch', { sku: '143;6' }]);
    await h.advance(1);
    h.copy('1.44 ref');
    await h.poll();
    expect(last(h)).toEqual(['1.44 ref', 'watch']);
  });

  it('re-arming the same item drops its name once more (the page copies it again)', async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    h.copy('Team Captain');
    await h.poll();
    h.copy('1.33 ref');
    await h.poll();
    h.ctl.arm(ARM);
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls).toEqual([['1.33 ref', 'watch', HINT]]);
  });

  it('null disarms: no hint, and the name is checked like any copy', async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    h.ctl.arm(null);
    h.copy('Team Captain');
    await h.poll();
    h.copy('1.33 ref');
    await h.poll();
    expect(h.check.mock.calls).toEqual([
      ['Team Captain', 'watch'],
      ['1.33 ref', 'watch'],
    ]);
  });

  it("drops the armed name once as the app's own copy (no check, popup or notification), then checks copies as usual", async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    h.copy('Team Captain');
    await h.poll();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.showPopup).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    h.copy('1.33 ref');
    await h.poll();
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls).toEqual([
      ['1.33 ref', 'watch', HINT],
      ['Team Captain', 'watch', HINT],
    ]);
    expect(h.showPopup).toHaveBeenCalledTimes(1);
  });

  it('matches the trimmed text exactly (keyed hash); other copies do not use up the once', async () => {
    const h = await watching();
    h.ctl.arm({ sku: '378;6', name: ' Team Captain ' });
    h.copy('team captain');
    await h.poll();
    h.copy('Team Captain, 1.33 ref');
    await h.poll();
    h.copy('\tTeam Captain \r\n');
    await h.poll();
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls.map(([t]) => t)).toEqual(['team captain', 'Team Captain, 1.33 ref', 'Team Captain']);
  });

  it("never lets the own copy take the waiting slot from the user's copy while a check is in flight", async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    h.manual(true);
    h.copy('1.33 ref');
    await h.poll();
    h.copy('Earbuds');
    await h.poll();
    h.copy('Team Captain');
    await h.poll();
    expect(h.pending.map((p) => p.text)).toEqual(['1.33 ref']);
    h.pending[0]!.resolve(itemResult({ id: 1 }));
    await h.flush();
    expect(h.pending.map((p) => p.text)).toEqual(['1.33 ref', 'Earbuds']);
  });

  it('the hotkey checks the armed name (the user asked), and that uses up the once', async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    h.copy('Team Captain');
    await h.ctl.hotkey();
    expect(h.check.mock.calls).toEqual([['Team Captain', 'hotkey', HINT]]);
    expect(h.shown().map((s) => s.source)).toEqual(['hotkey']);
    // The watcher sees that copy as already checked; a later copy of the name is the user's own.
    await h.poll();
    h.copy('1.33 ref');
    await h.poll();
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls.map(([t, s]) => `${s}: ${t}`)).toEqual(['hotkey: Team Captain', 'watch: 1.33 ref', 'watch: Team Captain']);
  });

  it('drops nothing when the clipboard already holds the name (the same row opened twice): a later copy of it is checked', async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    h.copy('Team Captain');
    await h.poll();
    // Opened again: the page's copy writes the same text, which the watcher cannot see as new.
    h.ctl.arm(ARM);
    await h.poll();
    h.copy('1.33 ref');
    await h.poll();
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls).toEqual([
      ['1.33 ref', 'watch', HINT],
      ['Team Captain', 'watch', HINT],
    ]);
  });

  it('drops nothing when the watcher saw the name before the arm came (it was checked then)', async () => {
    const h = await watching();
    h.copy('Team Captain');
    await h.poll();
    h.ctl.arm(ARM);
    h.copy('1.33 ref');
    await h.poll();
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls).toEqual([
      ['Team Captain', 'watch'],
      ['1.33 ref', 'watch', HINT],
      ['Team Captain', 'watch', HINT],
    ]);
  });

  it('drops nothing when armed with the watcher off or paused: it reads afresh, so the page copy is never new', async () => {
    // Off at the arm, turned on later: the first read only records the clipboard.
    const h = harness();
    h.ctl.arm(ARM);
    h.copy('Team Captain');
    h.settings.check.watchClipboard = true;
    h.ctl.syncWatch();
    await h.flush();
    h.copy('1.33 ref');
    await h.poll();
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls).toEqual([
      ['1.33 ref', 'watch', HINT],
      ['Team Captain', 'watch', HINT],
    ]);

    // Paused at the arm (network, or a locked session): the page's copy lands while nothing is read.
    for (const pause of ['network', 'system'] as const) {
      const p = await watching();
      const set = (on: boolean) => (pause === 'network' ? (p.settings.networkPaused = on) : p.setSystemPaused(on));
      set(true);
      p.ctl.arm(ARM);
      p.copy('Team Captain');
      await p.poll();
      set(false);
      await p.poll();
      p.copy('1.33 ref');
      await p.poll();
      p.copy('Team Captain');
      await p.poll();
      expect(p.check.mock.calls, pause).toEqual([
        ['1.33 ref', 'watch', HINT],
        ['Team Captain', 'watch', HINT],
      ]);
    }
  });

  it('stop() disarms, and nothing arms after it', async () => {
    const h = await watching();
    h.ctl.arm(ARM);
    h.ctl.stop();
    expect(h.ctl.arm(ARM)).toEqual({ armedUntil: null });
  });

  it("still drops the page's copy when it lands a few polls after the arm, within CHECK_OWN_COPY_MS", async () => {
    expect(CHECK_OWN_COPY_MS).toBeGreaterThanOrEqual(3 * CHECK_WATCH_INTERVAL_MS);
    const h = await watching();
    h.ctl.arm(ARM);
    await h.advance(3 * CHECK_WATCH_INTERVAL_MS);
    h.copy('Team Captain');
    await h.poll();
    expect(h.check).not.toHaveBeenCalled();
  });

  it("F19-OWN-COPY-UNBOUNDED (B): a page copy that never came drops nothing later: the user's own copy of the name is checked", async () => {
    const h = await watching();
    h.copy('something');
    await h.poll();
    h.ctl.arm(ARM);
    // The page's copy failed: the clipboard keeps what it had, so the watcher sees nothing new.
    await h.advance(CHECK_WATCH_INTERVAL_MS);
    await h.poll();
    // Seconds later the user has found the item on scrap.tf, and copies its price, then its name.
    await h.advance(CHECK_OWN_COPY_MS);
    h.copy('1.33 ref');
    await h.poll();
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls).toEqual([
      ['something', 'watch'],
      ['1.33 ref', 'watch', HINT],
      ['Team Captain', 'watch', HINT],
    ]);
  });

  it('F19-OWN-COPY-UNBOUNDED (A2): armed just as a pause ends, the priming read takes the page copy, so nothing is dropped later', async () => {
    for (const pause of ['network', 'system'] as const) {
      const h = await watching();
      const set = (on: boolean) => (pause === 'network' ? (h.settings.networkPaused = on) : h.setSystemPaused(on));
      set(true);
      await h.poll();
      set(false);
      h.ctl.arm(ARM);
      // The page's copy, recorded by the priming read without a check.
      h.copy('Team Captain');
      await h.poll();
      h.copy('1.33 ref');
      await h.poll();
      // The user's own copy of the name.
      h.copy('Team Captain');
      await h.poll();
      expect(h.check.mock.calls, pause).toEqual([
        ['1.33 ref', 'watch', HINT],
        ['Team Captain', 'watch', HINT],
      ]);
    }
  });

  it('F19-OWN-COPY-UNBOUNDED (A3): armed while the starting priming read is in flight, its answer decides', async () => {
    // It returns the page's copy: that copy is absorbed, so the user's later copy is checked.
    const h = harness({ watch: true });
    let release: (t: string) => void = () => undefined;
    h.readText.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    h.ctl.syncWatch();
    h.ctl.arm(ARM);
    h.copy('Team Captain');
    release('Team Captain');
    await h.flush();
    h.copy('1.33 ref');
    await h.poll();
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls).toEqual([
      ['1.33 ref', 'watch', HINT],
      ['Team Captain', 'watch', HINT],
    ]);

    // It returns what was there before the page copied: the page's copy then comes as new and is dropped.
    const g = harness({ watch: true });
    let releaseOld: (t: string) => void = () => undefined;
    g.readText.mockImplementationOnce(() => new Promise<string>((r) => (releaseOld = r)));
    g.ctl.syncWatch();
    g.ctl.arm(ARM);
    releaseOld('copied before anything started');
    await g.flush();
    g.copy('Team Captain');
    await g.poll();
    expect(g.check).not.toHaveBeenCalled();
    g.copy('1.33 ref');
    await g.poll();
    g.copy('Team Captain');
    await g.poll();
    expect(g.check.mock.calls).toEqual([
      ['1.33 ref', 'watch', HINT],
      ['Team Captain', 'watch', HINT],
    ]);
  });
});

describe('flipNotification and isCheckResult', () => {
  it('builds the toast from the result only', () => {
    expect(
      flipNotification(itemResult({ price: { keys: 1, scrapRaw: 48, valueScrap: K + 48, source: 'list', observedAt: 1 }, revenue: null, profitScrap: 20, margin: null })),
    ).toEqual({ title: 'Flip: Team Captain', body: 'scrap.tf 1 key 5.33 ref (saved list), +2.22 ref', sku: '378;6' });
    expect(flipNotification(itemResult({ name: null }))?.title).toBe('Flip: 378;6');
    expect(flipNotification(itemResult({ verdict: 'over' }))).toBeNull();
    expect(flipNotification(itemResult({ price: null, verdict: 'flip' }))).toBeNull();
    expect(flipNotification(blankCheckResult('refused', 'x', 'watch', 1))).toBeNull();
  });

  it("never announces a flip priced from a painted or spelled copy (CHECK_EXTRAS_NOTE), whatever notes come with it", () => {
    const typedPrice = { keys: 0, scrapRaw: 12, valueScrap: 12, source: 'typed' as const, observedAt: 1 };
    expect(flipNotification(itemResult({ price: typedPrice }))).not.toBeNull();
    expect(flipNotification(itemResult({ price: typedPrice, reason: CHECK_EXTRAS_NOTE }))).toBeNull();
    expect(flipNotification(itemResult({ price: typedPrice, reason: `${CHECK_INCOMPLETE_NOTE} ${CHECK_EXTRAS_NOTE}` }))).toBeNull();
  });

  it('the watcher shows such a result without a notification', async () => {
    const h = await watching();
    h.answers.set('Team Captain', (source) => itemResult({ source, reason: CHECK_EXTRAS_NOTE }));
    h.copy('Team Captain');
    await h.poll();
    expect(h.showPopup).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('accepts real results and rejects malformed answers', () => {
    expect(isCheckResult(itemResult())).toBe(true);
    expect(isCheckResult(blankCheckResult('not-item', 'x', 'watch', 1))).toBe(true);
    for (const bad of [null, 'x', { status: 'item' }, { ...itemResult(), status: 'maybe' }, { ...itemResult(), links: null }]) {
      expect(isCheckResult(bad)).toBe(false);
    }
  });
});

describe('privacy: the main logger never receives clipboard text', () => {
  const MARKER = 'Zebulonquux';
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-livecheck-log-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('logs nothing that contains the copied text, whatever fails on the way', async () => {
    const file = path.join(dir, 'main.log');
    const real = createMainLog({ file, minLevel: 'debug', echo: false, flushDelayMs: 1_000_000 });
    const seen: unknown[] = [];
    const log: Logger = {
      debug: (m, meta) => (seen.push([m, meta]), real.debug(m, meta)),
      info: (m, meta) => (seen.push([m, meta]), real.info(m, meta)),
      warn: (m, meta) => (seen.push([m, meta]), real.warn(m, meta)),
      error: (m, meta) => (seen.push([m, meta]), real.error(m, meta)),
    };
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    try {
      const h = harness({ watch: true });
      const ctl = createLiveCheckMain({ ...h.deps, log });
      ctl.syncWatch();
      await h.flush();
      const text = `${MARKER} Team Captain, 1.33 ref`;
      const leak = (where: string) => new Error(`${where} failed on "${text}"`);

      // Every failure carries the text in its message: none of it may reach a log line.
      h.answers.set(text, () => leak('service'));
      h.copy(text);
      await ctl.hotkey();
      await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
      await h.poll();
      h.answers.set(`${text}!`, () => ({ status: 'item', echo: text }));
      h.copy(`${text}!`);
      await ctl.hotkey();
      await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
      await h.poll();
      h.answers.delete(text);
      h.copy(`${text}?`);
      h.showPopup.mockImplementation(() => {
        throw leak('popup');
      });
      h.notify.mockImplementation(() => {
        throw leak('notify');
      });
      await h.advance(5000);
      await h.poll();
      await ctl.hotkey();
      h.copy(leak('read'));
      await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
      await ctl.hotkey();
      await h.poll();
      // A secret in the copy (refused in main) and the watcher's onError path.
      h.copy(`${MARKER} ${STEAM_KEY}`);
      await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
      await ctl.hotkey();
      await h.poll();

      expect(h.check.mock.calls.some(([t]) => t.includes(MARKER))).toBe(true);
      expect(seen.length).toBeGreaterThan(3);
      real.flushSync();
      const written = readFileSync(file, 'utf8');
      expect(written.length).toBeGreaterThan(0);
      expect(written).not.toContain(MARKER);
      expect(JSON.stringify(seen)).not.toContain(MARKER);
      for (const spy of consoleSpies) {
        expect(JSON.stringify(spy.mock.calls.map((c) => c.map((x) => (x instanceof Error ? x.message : x))))).not.toContain(MARKER);
      }
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("F19: never logs the armed name or the copies around it, whatever fails, and the hint carries the SKU only", async () => {
    const file = path.join(dir, 'main-arm.log');
    const real = createMainLog({ file, minLevel: 'debug', echo: false, flushDelayMs: 1_000_000 });
    const seen: unknown[] = [];
    const log: Logger = {
      debug: (m, meta) => (seen.push([m, meta]), real.debug(m, meta)),
      info: (m, meta) => (seen.push([m, meta]), real.info(m, meta)),
      warn: (m, meta) => (seen.push([m, meta]), real.warn(m, meta)),
      error: (m, meta) => (seen.push([m, meta]), real.error(m, meta)),
    };
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    try {
      const h = harness({ watch: true });
      const ctl = createLiveCheckMain({ ...h.deps, log });
      ctl.syncWatch();
      await h.flush();
      const name = `${MARKER} Team Captain`;
      const leak = () => new Error(`failed on "${name}"`);

      ctl.arm({ sku: '378;6', name });
      // The page's own copy (dropped), then a copied price the service fails on, naming the item.
      h.copy(name);
      await h.poll();
      h.answers.set('1.33 ref', () => leak());
      h.copy('1.33 ref');
      await h.poll();
      // The user copies the name: checked, and the popup and the notification both throw with it.
      h.showPopup.mockImplementation(() => {
        throw leak();
      });
      h.notify.mockImplementation(() => {
        throw leak();
      });
      h.copy(name);
      await h.poll();
      // The hotkey (hinted), then a clipboard that cannot be read, its error naming the item.
      h.copy(`${name}, 1.33 ref`);
      await ctl.hotkey();
      await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
      h.copy(leak());
      await ctl.hotkey();
      await h.poll();
      // Re-armed with another marked name, then disarmed and stopped.
      ctl.arm({ sku: '143;6', name: `${MARKER} Earbuds` });
      ctl.arm(null);
      ctl.stop();

      const hints = h.check.mock.calls.map((c) => c[2]);
      expect(hints.filter((x) => x !== undefined).length).toBeGreaterThan(1);
      for (const x of hints) if (x !== undefined) expect(x).toStrictEqual({ sku: '378;6' });
      expect(h.check.mock.calls.some(([t]) => t.includes(MARKER))).toBe(true);
      expect(seen.length).toBeGreaterThan(3);
      real.flushSync();
      const written = readFileSync(file, 'utf8');
      expect(written.length).toBeGreaterThan(0);
      expect(written).not.toContain(MARKER);
      expect(JSON.stringify(seen)).not.toContain(MARKER);
      for (const spy of consoleSpies) {
        expect(JSON.stringify(spy.mock.calls.map((c) => c.map((x) => (x instanceof Error ? x.message : x))))).not.toContain(MARKER);
      }
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it('F19: the arm keeps the name as its keyed hash only, and no log call names the arm', () => {
    const code = readFileSync(fileURLToPath(new URL('../../src/main/liveCheck.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    const state = code.slice(code.indexOf('interface ArmState {'));
    const fields = state.slice(state.indexOf('{') + 1, state.indexOf('}'));
    expect([...fields.matchAll(/(\w+)\s*:/g)].map((m) => m[1])).toEqual(['sku', 'nameHash', 'until', 'ownCopyDropped', 'ownCopyUntil']);
    // The name is read once, straight into the keyed hash, and nowhere else.
    expect([...code.matchAll(/\ba\.name\b/g)]).toHaveLength(1);
    expect(code).toContain('nameHash: clipboardTextHash(a.name.trim())');
    expect(code).not.toMatch(/\b(?:log|logger|console)\s*\.\s*(?:debug|info|warn|error|log)\s*\([^)]*\b(?:arm|armed|nameHash|hint|ArmState)\b/);
  });

  it('main-side live check code has no log or console call that names the text', () => {
    const SRC = fileURLToPath(new URL('../../src/main/', import.meta.url));
    const TEXT_LOGGED = /\b(?:log|logger|console)\s*\.\s*(?:debug|info|warn|error|log)\s*\([^)]*\b(?:text|clip|clipboardText|copied)\b/g;
    for (const f of ['liveCheck.ts', 'hotkeys.ts', 'main.ts']) {
      const code = readFileSync(path.join(SRC, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
      expect([...code.matchAll(TEXT_LOGGED)].map((m) => `${f}: ${m[0]}`)).toEqual([]);
    }
    const controller = readFileSync(path.join(SRC, 'liveCheck.ts'), 'utf8');
    expect(controller).not.toMatch(/\bconsole\s*\./);
  });
});
