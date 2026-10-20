// Audit livecheck-2: a blank clipboard read is not recorded as the text the watcher saw. On Windows a
// clipboard another program holds open reads as '' (Chromium returns '' instead of throwing), so
// recording it made the unchanged text after it look like a new copy: checked, and popped up, again.

import { describe, expect, it, vi } from 'vitest';
import { clipboardTextHash, createClipboardWatch } from '../../src/main/clipboardWatch';
import { createLiveCheckMain } from '../../src/main/liveCheck';
import { blankCheckResult } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckResult, Settings } from '../../src/shared/types';

function setup(initial: string, opts: { async?: boolean } = {}) {
  let clip = initial;
  let tick: (() => void) | null = null;
  const onText = vi.fn<(t: string) => void>();
  const onPrimed = vi.fn<(h: string) => void>();
  const timers = {
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  };
  const readText = opts.async ? () => Promise.resolve(clip) : () => clip;
  const watch = createClipboardWatch({ readText, onText, onPrimed, isPaused: () => false, timers });
  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    watch,
    onText,
    onPrimed,
    flush,
    /** Copies `t` and runs one poll (letting an async read settle). */
    read: async (t: string) => {
      clip = t;
      tick?.();
      await flush();
    },
  };
}

describe('the clipboard watcher and a blank read', () => {
  it('does not check the unchanged text again after a blank read (sync reader)', async () => {
    const s = setup('old text');
    s.watch.start();
    await s.read('Earbuds');
    await s.read('Earbuds');
    await s.read('');
    await s.read('   \n');
    expect(s.watch.isLastSeen(clipboardTextHash('Earbuds'))).toBe(true);
    await s.read('Earbuds');
    expect(s.onText.mock.calls).toEqual([['Earbuds']]);
    s.watch.stop();
  });

  it('does not check the unchanged text again after a blank read (async reader)', async () => {
    const s = setup('old text', { async: true });
    s.watch.start();
    await s.flush();
    await s.read('Earbuds');
    await s.read('');
    await s.read('Earbuds');
    expect(s.onText.mock.calls).toEqual([['Earbuds']]);
    s.watch.stop();
  });

  it('still checks a different text after a blank read, and still records a refused non-blank text', async () => {
    const s = setup('old text');
    s.watch.start();
    await s.read('Earbuds');
    await s.read('');
    await s.read('Team Captain');
    await s.read('<b>x</b>');
    await s.read('Team Captain');
    expect(s.onText.mock.calls).toEqual([['Earbuds'], ['Team Captain'], ['Team Captain']]);
    s.watch.stop();
  });

  it('a blank priming read still lets the first copy through', async () => {
    const s = setup('');
    s.watch.start();
    expect(s.onPrimed).toHaveBeenCalledTimes(1);
    await s.read('Earbuds');
    expect(s.onText.mock.calls).toEqual([['Earbuds']]);
    s.watch.stop();
  });

  it('through the live check: one check and one popup for one copy, whatever blank reads come between', async () => {
    let clip = 'copied before anything started';
    let tick: (() => void) | null = null;
    const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
    settings.check.watchClipboard = true;
    settings.check.popup = true;
    const result: CheckResult = { ...blankCheckResult('not-item', 'x', 'watch', 1), status: 'item', reason: null, sku: '143;6', name: 'Earbuds', verdict: 'no-price' };
    const check = vi.fn(async () => result);
    const showPopup = vi.fn();
    let now = 1_000_000;
    const ctl = createLiveCheckMain({
      readText: async () => clip,
      check,
      serviceReady: () => true,
      showPopup,
      notify: vi.fn(),
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
    });
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const read = async (t: string) => {
      clip = t;
      now += 5_000;
      tick?.();
      await flush();
    };
    ctl.syncWatch();
    await flush();
    await read('Earbuds');
    await read('');
    await read('Earbuds');
    expect(check).toHaveBeenCalledTimes(1);
    expect(showPopup).toHaveBeenCalledTimes(1);
    ctl.stop();
  });
});
