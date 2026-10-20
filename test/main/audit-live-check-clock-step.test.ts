import { describe, expect, it, vi } from 'vitest';
import { CHECK_HOTKEY_MIN_GAP_MS, createLiveCheckMain, type LiveCheckMainDeps } from '../../src/main/liveCheck';
import { blankCheckResult, CHECK_ARM_MS, CHECK_NOTIFY_DEDUP_MS, CHECK_POPUP_MIN_GAP_MS } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckHint, CheckResult, CheckSource, Settings } from '../../src/shared/types';

// Audit rv-main-1 (same class as window-3 and fu-main-3): the live check subtracted wall-clock times, so
// after Windows stepped a fast clock back by D, the watcher's popup gap came out at about D (one timer then
// held every watcher popup that long), a flip's per-SKU dedupe and the hotkey's repeat gap lasted about D,
// a hotkey answer was focused however late it came, and an F19 arm (its hint and its own-copy drop) was
// stretched by D. A clock stepped back now counts as the gap passed and the arm expired.

const T = 1_791_958_000_000;
/** The clock stepped back ten minutes (Windows time sync correcting a fast clock). */
const STEP = 600_000;

const SKUS: Record<string, string> = { Earbuds: '143;6', 'Ghastly Gibus': '116;6' };

function itemResult(text: string, source: CheckSource, checkedAt: number, id: number): CheckResult {
  const n = /^Item (\d+)/.exec(text);
  return {
    ...blankCheckResult('not-item', 'x', source, checkedAt, id),
    status: 'item',
    reason: null,
    sku: n ? `${n[1]};6` : (SKUS[text] ?? '378;6'),
    name: text,
    price: { keys: 0, scrapRaw: 12, valueScrap: 12, source: 'clipboard', observedAt: checkedAt },
    revenue: { bestScrap: 30, consScrap: 30, instantScrap: 28, useOrder: 'conservative', revenueScrap: 30, order: null, maxCostScrap: 25, eligibleCount: 3 },
    profitScrap: 16,
    margin: 1.33,
    verdict: 'flip',
    confidence: 80,
    confidenceLevel: 'high',
    keyScrap: 540,
  };
}

/**
 * The live check with fakes. Two clocks: `wall` is what deps.now reads (it can step back), `elapsed` is
 * real time, which the fake setTimeout runs on (as Node's does).
 */
function harness(init: { watch?: boolean; popup?: boolean } = {}) {
  const clock = { wall: T, elapsed: 0 };
  let clip = 'copied before anything started';
  let manual = false;
  let nextId = 0;
  const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  settings.check.watchClipboard = init.watch ?? false;
  settings.check.popup = init.popup ?? true;
  settings.check.notifyFlips = true;
  settings.notifications.enabled = true;
  let tick: (() => void) | null = null;
  let timeoutSeq = 0;
  const timeouts: { id: number; at: number; fn: () => void }[] = [];
  const pending: ((v: unknown) => void)[] = [];

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
      timeouts.push({ id, at: clock.elapsed + ms, fn });
      return id;
    }),
    clearTimeout: vi.fn((id: unknown) => {
      const i = timeouts.findIndex((x) => x.id === id);
      if (i >= 0) timeouts.splice(i, 1);
    }),
  };
  const check = vi.fn((text: string, source: 'hotkey' | 'watch', _hint?: CheckHint) => {
    if (manual) return new Promise<unknown>((resolve) => pending.push(resolve));
    return Promise.resolve(itemResult(text, source, clock.wall, ++nextId));
  });
  const showPopup = vi.fn<(r: CheckResult, o: { focus: boolean }) => void>();
  const notify = vi.fn();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: LiveCheckMainDeps = {
    readText: () => clip,
    check,
    serviceReady: () => true,
    showPopup,
    notify,
    settings: () => settings,
    systemPaused: () => false,
    log,
    now: () => clock.wall,
    timers,
  };
  const ctl = createLiveCheckMain(deps);
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  return {
    ctl,
    check,
    showPopup,
    notify,
    log,
    timers,
    pending,
    flush,
    copy: (t: string) => {
      clip = t;
    },
    manual: (m: boolean) => {
      manual = m;
    },
    wall: () => clock.wall,
    /** One watcher tick, then lets the check settle. */
    poll: async () => {
      tick?.();
      await flush();
    },
    /** Real time passes (the wall clock with it), running due timeouts in order. */
    advance: async (ms: number) => {
      const until = clock.elapsed + ms;
      for (;;) {
        timeouts.sort((a, b) => a.at - b.at);
        const due = timeouts[0];
        if (!due || due.at > until) break;
        timeouts.shift();
        clock.wall += due.at - clock.elapsed;
        clock.elapsed = due.at;
        due.fn();
        await flush();
      }
      clock.wall += until - clock.elapsed;
      clock.elapsed = until;
      await flush();
    },
    /** Windows time sync steps the wall clock back; no real time passes. */
    stepBack: (ms: number) => {
      clock.wall -= ms;
    },
  };
}

/** A started watcher whose priming read is done. */
async function watching(init: { popup?: boolean } = {}) {
  const h = harness({ watch: true, ...init });
  h.ctl.syncWatch();
  await h.flush();
  return h;
}

const timeoutsAsked = (h: ReturnType<typeof harness>) => h.timers.setTimeout.mock.calls.map(([, ms]) => ms);

describe('live check: a clock stepped back', () => {
  it('shows the next watcher popup at once instead of holding every popup for as long as the step', async () => {
    const h = await watching();
    h.copy('Team Captain');
    await h.poll();
    expect(h.showPopup).toHaveBeenCalledTimes(1);
    await h.advance(60_000);
    h.stepBack(STEP);
    h.copy('Earbuds');
    await h.poll();
    expect(h.showPopup).toHaveBeenCalledTimes(2);
    expect(h.showPopup.mock.calls[1]![0].name).toBe('Earbuds');
    expect(timeoutsAsked(h)).toEqual([]);
  });

  it('keeps the popup gap from the popup shown after the step', async () => {
    const h = await watching();
    h.copy('Team Captain');
    await h.poll();
    await h.advance(60_000);
    h.stepBack(STEP);
    h.copy('Earbuds');
    await h.poll();
    await h.advance(500);
    h.copy('Ghastly Gibus');
    await h.poll();
    expect(h.showPopup).toHaveBeenCalledTimes(2);
    expect(timeoutsAsked(h)).toEqual([CHECK_POPUP_MIN_GAP_MS - 500]);
    await h.advance(CHECK_POPUP_MIN_GAP_MS - 501);
    expect(h.showPopup).toHaveBeenCalledTimes(2);
    await h.advance(1);
    expect(h.showPopup).toHaveBeenCalledTimes(3);
    expect(h.showPopup.mock.calls[2]![0].name).toBe('Ghastly Gibus');
  });

  it('never asks for a popup timer longer than the gap, whatever the clock did', async () => {
    const h = await watching();
    for (const [i, text] of ['Team Captain', 'Earbuds', 'Ghastly Gibus', 'Item 1', 'Item 2', 'Item 3'].entries()) {
      if (i % 2 === 1) h.stepBack(STEP);
      h.copy(text);
      await h.poll();
      await h.advance(200);
    }
    expect(Math.max(0, ...timeoutsAsked(h))).toBeLessThanOrEqual(CHECK_POPUP_MIN_GAP_MS);
  });

  it("notifies a SKU's flip again after the step instead of deduping it for as long as the step", async () => {
    const h = await watching({ popup: false });
    h.copy('Team Captain');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(1);
    await h.advance(120_000);
    h.stepBack(STEP);
    h.copy('Team Captain, 1 ref');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(2);
    // With the clock running forward, the per-SKU minute still holds.
    await h.advance(10_000);
    h.copy('Team Captain, 2 ref');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(2);
    await h.advance(CHECK_NOTIFY_DEDUP_MS);
    h.copy('Team Captain, 3 ref');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(3);
  });

  it('trims dedupe entries from before the step out of a full map instead of keeping them as recent', async () => {
    const h = await watching({ popup: false });
    for (let i = 0; i < 500; i++) {
      h.copy(`Item ${i}`);
      await h.poll();
    }
    expect(h.notify).toHaveBeenCalledTimes(500);
    await h.advance(1_000);
    h.stepBack(STEP);
    h.copy('Item 500');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(501);
    // Ten minutes on, the clock is back past the times written before the step: those SKUs were trimmed.
    await h.advance(STEP);
    h.copy('Item 7');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(502);
    // An entry written after the step is still a recent one.
    await h.advance(1_000);
    h.copy('Item 7, 1 ref');
    await h.poll();
    expect(h.notify).toHaveBeenCalledTimes(502);
  });

  it('takes the first hotkey press after the step as a press, not a repeat; held-key repeats are still one press', async () => {
    const h = harness();
    h.copy('Team Captain');
    await h.ctl.hotkey();
    await h.advance(60_000);
    h.stepBack(STEP);
    h.copy('Earbuds');
    await h.ctl.hotkey();
    expect(h.check.mock.calls.map(([t, s]) => `${s}: ${t}`)).toEqual(['hotkey: Team Captain', 'hotkey: Earbuds']);
    expect(h.showPopup.mock.calls.map(([r, o]) => [r.name, o.focus])).toEqual([
      ['Team Captain', true],
      ['Earbuds', true],
    ]);
    await h.advance(200);
    await h.ctl.hotkey();
    await h.advance(CHECK_HOTKEY_MIN_GAP_MS - 1);
    await h.ctl.hotkey();
    expect(h.check).toHaveBeenCalledTimes(2);
    await h.advance(CHECK_HOTKEY_MIN_GAP_MS);
    h.copy('Ghastly Gibus');
    await h.ctl.hotkey();
    expect(h.check).toHaveBeenCalledTimes(3);
  });

  it('shows a hotkey answer unfocused when the clock stepped back while it was checked', async () => {
    const h = harness();
    h.manual(true);
    h.copy('Team Captain');
    const press = h.ctl.hotkey();
    await h.flush();
    expect(h.pending).toHaveLength(1);
    h.stepBack(STEP);
    h.pending[0]!(itemResult('Team Captain', 'hotkey', h.wall(), 1));
    await press;
    expect(h.showPopup.mock.calls.map(([, o]) => o)).toEqual([{ focus: false }]);
  });

  it('ends an arm: no hint, and the armed name is checked instead of dropped as the page copy', async () => {
    const h = await watching();
    const last = () => h.check.mock.calls.at(-1);
    h.ctl.arm({ sku: '378;6', name: 'Team Captain' });
    await h.advance(60_000);
    h.copy('1.33 ref');
    await h.poll();
    expect(last()).toEqual(['1.33 ref', 'watch', { sku: '378;6' }]);
    h.stepBack(STEP);
    h.copy('1.44 ref');
    await h.poll();
    expect(last()).toEqual(['1.44 ref', 'watch']);
    h.copy('Team Captain');
    await h.poll();
    expect(last()).toEqual(['Team Captain', 'watch']);
    h.copy('1.55 ref');
    await h.ctl.hotkey();
    expect(last()).toEqual(['1.55 ref', 'hotkey']);
  });

  it('ends the own-copy drop too when the step comes before the page copy', async () => {
    const h = await watching();
    h.ctl.arm({ sku: '378;6', name: 'Team Captain' });
    h.stepBack(STEP);
    h.copy('Team Captain');
    await h.poll();
    expect(h.check.mock.calls).toEqual([['Team Captain', 'watch']]);
  });

  it('arms as usual after the step, for CHECK_ARM_MS from the clock as it is now', async () => {
    const h = await watching();
    const last = () => h.check.mock.calls.at(-1);
    h.ctl.arm({ sku: '378;6', name: 'Team Captain' });
    h.stepBack(STEP);
    expect(h.ctl.arm({ sku: '143;6', name: 'Earbuds' })).toEqual({ armedUntil: h.wall() + CHECK_ARM_MS });
    h.copy('Earbuds');
    await h.poll();
    expect(h.check).not.toHaveBeenCalled();
    h.copy('1.66 ref');
    await h.poll();
    expect(last()).toEqual(['1.66 ref', 'watch', { sku: '143;6' }]);
    await h.advance(CHECK_ARM_MS - 1);
    h.copy('1.77 ref');
    await h.poll();
    expect(last()).toEqual(['1.77 ref', 'watch', { sku: '143;6' }]);
    await h.advance(1);
    h.copy('1.88 ref');
    await h.poll();
    expect(last()).toEqual(['1.88 ref', 'watch']);
  });
});
