// 0.7.4 review (R22, R14): the clipboard watcher's "Flip:" notification (popup off) waited for nothing the engine
// waits for: it was sent on a revenue order not seen for 24 h ('unverified', the feed has no catch-up after the app
// or the feed was off) and on a price the cost check flags as another copy's. The engine and the bank stock's
// "New on scrap.tf" toast hold both back. Now flipNotification does too, and a held-back result does not use up
// the per-SKU minute. Fakes only: no clipboard, no network.

import { describe, expect, it, vi } from 'vitest';
import { createLiveCheckMain, flipNotification, type LiveCheckMainDeps } from '../../src/main/liveCheck';
import { blankCheckResult, CHECK_COST_BELOW_MARKET_NOTE, CHECK_COST_VARIANT_NOTE } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckResult, CheckSource, ItemRevenue, OrderSummary, Settings } from '../../src/shared/types';

const NOW = 1_800_000_000_000;

function order(flags: string[]): OrderSummary {
  return { listingId: 'o1', steamid: '76561198000000001', userName: 'bot', keys: 2, metalScrap: 198, valueScrap: 1332, isBot: true, online: false, lastEventAt: NOW - 30 * 3_600_000, bumpedAt: null, details: '', flags, eligible: true };
}

function flip(over: Partial<CheckResult> = {}, flags: string[] = []): CheckResult {
  const revenue: ItemRevenue = { bestScrap: 1332, consScrap: 1332, instantScrap: 1330, useOrder: 'conservative', revenueScrap: 1332, order: order(flags), maxCostScrap: 1100, eligibleCount: 3 };
  return {
    ...blankCheckResult('not-item', 'x', 'watch', NOW),
    id: 1,
    status: 'item',
    reason: null,
    sku: '5040;6',
    name: 'A Distinctive Lack of Hue',
    price: { keys: 1, scrapRaw: 389, valueScrap: 956, source: 'clipboard', observedAt: NOW },
    revenue,
    profitScrap: 376,
    margin: 0.39,
    verdict: 'flip',
    confidence: 65,
    confidenceLevel: 'medium',
    keyScrap: 567,
    checkedAt: NOW,
    ...over,
  };
}

describe('flipNotification (0.7.4 review)', () => {
  it('R22: is null on an unverified revenue order, and sent for a verified or merely outlying one', () => {
    expect(flipNotification(flip({}, ['unverified']))).toBeNull();
    expect(flipNotification(flip({}, ['outlier', 'unverified']))).toBeNull();
    expect(flipNotification(flip({}, []))).not.toBeNull();
    expect(flipNotification(flip({}, ['outlier']))).not.toBeNull();
    // A result without an order summary (an older service) is not held back for it.
    expect(flipNotification(flip({ revenue: { ...flip().revenue!, order: null } }))).not.toBeNull();
  });

  it('R14: is null for a price the cost check flagged, alone or among other notes', () => {
    for (const reason of [CHECK_COST_VARIANT_NOTE, CHECK_COST_BELOW_MARKET_NOTE, `Closest match only. ${CHECK_COST_VARIANT_NOTE}`]) {
      expect(flipNotification(flip({ reason })), reason).toBeNull();
    }
  });
});

describe('the watcher with its popup off (R22)', () => {
  it('sends nothing for an unverified flip, and the confirmed result right after still notifies', async () => {
    let clip = 'copied before anything started';
    let tick: (() => void) | null = null;
    const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
    settings.check.watchClipboard = true;
    settings.check.popup = false;
    settings.check.notifyFlips = true;
    settings.notifications.enabled = true;
    const answers = new Map<string, (source: CheckSource) => CheckResult>([
      ['stale', (source) => flip({ source }, ['unverified'])],
      ['suspect', (source) => flip({ source, reason: CHECK_COST_VARIANT_NOTE })],
      ['confirmed', (source) => flip({ source })],
    ]);
    const notify = vi.fn();
    const deps: LiveCheckMainDeps = {
      readText: async () => clip,
      check: vi.fn(async (text: string, source: 'hotkey' | 'watch') => answers.get(text)!(source)),
      serviceReady: () => true,
      showPopup: vi.fn(),
      notify,
      settings: () => settings,
      systemPaused: () => false,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => NOW,
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
    const copy = async (t: string) => {
      clip = t;
      tick?.();
      await flush();
    };
    ctl.syncWatch();
    await flush();
    await copy('stale');
    await copy('suspect');
    expect(notify).not.toHaveBeenCalled();
    await copy('confirmed');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ title: 'Flip: A Distinctive Lack of Hue', sku: '5040;6' });
    ctl.stop();
  });
});
