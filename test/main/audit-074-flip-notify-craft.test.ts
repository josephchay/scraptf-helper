// 0.7.4 (audit F41, F44): the clipboard watcher's "Flip:" notification (popup off) is never sent for a check
// whose craftability is undecided (the copied text did not say and the saved scrap.tf pages have both copies:
// CHECK_CRAFT_UNSURE_NOTE), nor for a number read as ref without a unit (CHECK_BARE_REF_NOTE; the service never
// gives the watcher one, so this backs it up). A held-back result does not use up the per-SKU minute. Fakes
// only: no clipboard, no network.

import { describe, expect, it, vi } from 'vitest';
import { createLiveCheckMain, flipNotification, type LiveCheckMainDeps } from '../../src/main/liveCheck';
import { blankCheckResult, CHECK_BARE_REF_NOTE, CHECK_CRAFT_TWIN_NOTE, CHECK_CRAFT_UNSURE_NOTE, checkHintedNote } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckResult, CheckSource, ItemRevenue, Settings } from '../../src/shared/types';

const NOW = 1_800_000_000_000;

function flip(over: Partial<CheckResult> = {}): CheckResult {
  const revenue: ItemRevenue = { bestScrap: 1332, consScrap: 1332, instantScrap: 1330, useOrder: 'conservative', revenueScrap: 1332, order: null, maxCostScrap: 1100, eligibleCount: 3 };
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
    confidence: 80,
    confidenceLevel: 'high',
    keyScrap: 567,
    checkedAt: NOW,
    ...over,
  };
}

describe('flipNotification (0.7.4)', () => {
  it('is null for an undecided craftability and for a bare number read as ref, alone or among other notes', () => {
    expect(flipNotification(flip())).not.toBeNull();
    for (const reason of [CHECK_CRAFT_UNSURE_NOTE, CHECK_BARE_REF_NOTE, `${checkHintedNote('A Distinctive Lack of Hue')} ${CHECK_CRAFT_UNSURE_NOTE}`]) {
      expect(flipNotification(flip({ reason })), reason).toBeNull();
    }
  });

  it('still tells of a flip checked as the decided copy (the twin note), named as that copy', () => {
    const r = flip({ sku: '5040;6;uncraftable', name: 'Non-Craftable A Distinctive Lack of Hue', reason: CHECK_CRAFT_TWIN_NOTE });
    expect(flipNotification(r)).toMatchObject({ title: 'Flip: Non-Craftable A Distinctive Lack of Hue', sku: '5040;6;uncraftable' });
  });
});

describe('the watcher with its popup off', () => {
  it('sends nothing for an undecided flip, and that does not use up the per-SKU minute', async () => {
    let clip = 'copied before anything started';
    let tick: (() => void) | null = null;
    const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
    settings.check.watchClipboard = true;
    settings.check.popup = false;
    settings.check.notifyFlips = true;
    settings.notifications.enabled = true;
    const answers = new Map<string, (source: CheckSource) => CheckResult>([
      ['undecided', (source) => flip({ source, reason: CHECK_CRAFT_UNSURE_NOTE })],
      ['decided', (source) => flip({ source })],
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
    await copy('undecided');
    expect(notify).not.toHaveBeenCalled();
    await copy('decided');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ title: 'Flip: A Distinctive Lack of Hue', sku: '5040;6' });
    ctl.stop();
  });
});
