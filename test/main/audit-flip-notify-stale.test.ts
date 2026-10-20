// Audit livecheck-1: the clipboard watcher's "Flip:" notification (popup off) is never for a scrap.tf
// price, other than a copied one, older than profit.inputStaleMs (README "Notifications", the engine's
// ACT-2 rule). The popup still shows such a price with its age; only the notification is held back, and
// a held-back one does not use up the per-SKU minute.

import { describe, expect, it, vi } from 'vitest';
import { checkPriceTooOld, createLiveCheckMain, flipNotification, type LiveCheckMainDeps } from '../../src/main/liveCheck';
import { blankCheckResult, CHECK_NOTIFY_DEDUP_MS } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckPrice, CheckPriceSource, CheckResult, CheckSource, ItemRevenue, Settings } from '../../src/shared/types';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const K = 540;

function price(source: CheckPriceSource, observedAt: number): CheckPrice {
  return { keys: 0, scrapRaw: 12, valueScrap: 12, source, observedAt };
}

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
    ...blankCheckResult('not-item', 'x', 'watch', NOW),
    id: 1,
    status: 'item',
    reason: null,
    sku: '378;6',
    name: 'Team Captain',
    price: price('clipboard', NOW),
    revenue,
    profitScrap: 16,
    margin: 1.33,
    verdict: 'flip',
    confidence: 80,
    confidenceLevel: 'high',
    keyScrap: K,
    checkedAt: NOW,
    ...over,
  };
}

describe('flipNotification: never for an old stored price', () => {
  it('drops a list, typed or imported price older than inputStaleMs', () => {
    for (const source of ['list', 'typed', 'import'] as const) {
      const r = itemResult({ price: price(source, NOW - 21 * DAY) });
      expect(checkPriceTooOld(r, 2 * HOUR)).toBe(true);
      expect(flipNotification(r, 2 * HOUR)).toBeNull();
    }
  });

  it('keeps a price within inputStaleMs, up to exactly that age, with the body unchanged', () => {
    const r = itemResult({ price: price('list', NOW - HOUR) });
    expect(checkPriceTooOld(r, 2 * HOUR)).toBe(false);
    expect(flipNotification(r, 2 * HOUR)?.body).toMatch(/^scrap\.tf 1\.33 ref \(saved list\) → sells for /);
    expect(flipNotification(itemResult({ price: price('list', NOW - 2 * HOUR) }), 2 * HOUR)).not.toBeNull();
    expect(flipNotification(itemResult({ price: price('list', NOW - 2 * HOUR - 1) }), 2 * HOUR)).toBeNull();
  });

  it('never holds back a copied price', () => {
    expect(flipNotification(itemResult({ price: price('clipboard', NOW) }), 2 * HOUR)).not.toBeNull();
    expect(checkPriceTooOld(itemResult({ price: price('clipboard', NOW - 21 * DAY) }), 2 * HOUR)).toBe(false);
  });

  it('reads 0, a missing or a broken inputStaleMs as the 2 h default', () => {
    expect(DEFAULT_SETTINGS.profit.inputStaleMs).toBe(2 * HOUR);
    for (const ms of [0, undefined, null, Number.NaN, -5]) {
      expect(flipNotification(itemResult({ price: price('list', NOW - 21 * DAY) }), ms)).toBeNull();
      expect(flipNotification(itemResult({ price: price('list', NOW - HOUR) }), ms)).not.toBeNull();
    }
    expect(flipNotification(itemResult({ price: price('list', NOW - 21 * DAY) }))).toBeNull();
  });

  it('treats a price of unknown age as too old', () => {
    for (const observedAt of [undefined, Number.NaN]) {
      const r = itemResult({ price: { ...price('list', NOW), observedAt: observedAt as unknown as number } });
      expect(checkPriceTooOld(r, 2 * HOUR)).toBe(true);
      expect(flipNotification(r, 2 * HOUR)).toBeNull();
    }
    expect(flipNotification(itemResult({ price: price('typed', NOW), checkedAt: Number.NaN }), 2 * HOUR)).toBeNull();
  });

  it('follows a longer inputStaleMs', () => {
    expect(flipNotification(itemResult({ price: price('list', NOW - 21 * DAY) }), 30 * DAY)).not.toBeNull();
  });
});

/** The watcher with its popup off and flip notifications on; the service answers per text. */
function watcher() {
  let clip = 'copied before anything started';
  let now = NOW;
  let tick: (() => void) | null = null;
  const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  settings.check.watchClipboard = true;
  settings.check.popup = false;
  settings.check.notifyFlips = true;
  settings.notifications.enabled = true;
  const answers = new Map<string, (source: CheckSource) => CheckResult>();
  const notify = vi.fn();
  const showPopup = vi.fn();
  const deps: LiveCheckMainDeps = {
    readText: async () => clip,
    check: vi.fn(async (text: string, source: 'hotkey' | 'watch') => answers.get(text)!(source)),
    serviceReady: () => true,
    showPopup,
    notify,
    settings: () => settings,
    systemPaused: () => false,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => now,
    timers: {
      setInterval: (fn) => {
        tick = fn;
        return 'interval';
      },
      clearInterval: () => {
        tick = null;
      },
      setTimeout: () => 'timeout',
      clearTimeout: () => {},
    },
  };
  const ctl = createLiveCheckMain(deps);
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    ctl,
    settings,
    answers,
    notify,
    showPopup,
    flush,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    copyAndPoll: async (t: string) => {
      clip = t;
      tick?.();
      await flush();
    },
  };
}

describe('the watcher with its popup off', () => {
  it('sends no "Flip:" for a weeks-old saved-list price, and that does not use up the per-SKU minute', async () => {
    const h = watcher();
    h.ctl.syncWatch();
    await h.flush();
    h.answers.set('Team Captain', (source) => itemResult({ source, price: price('list', h.now() - 21 * DAY), checkedAt: h.now() }));
    h.answers.set('Team Captain, 1.33 ref', (source) => itemResult({ source, price: price('clipboard', h.now()), checkedAt: h.now() }));

    await h.copyAndPoll('Team Captain');
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.showPopup).not.toHaveBeenCalled();

    // Within the minute: a fresh copied price of the same item still gets its notification.
    h.advance(1_000);
    await h.copyAndPoll('Team Captain, 1.33 ref');
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatchObject({ title: 'Flip: Team Captain', sku: '378;6' });

    // A stale time longer than the list's age lets the list price notify.
    h.settings.profit.inputStaleMs = 30 * DAY;
    h.advance(CHECK_NOTIFY_DEDUP_MS);
    await h.copyAndPoll('Team Captain');
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls[1]![0].body).toContain('(saved list)');
    h.ctl.stop();
  });
});
