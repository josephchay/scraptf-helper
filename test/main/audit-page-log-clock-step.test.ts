import { describe, expect, it, vi } from 'vitest';
import { createPageLog, PAGE_LOG_GAP_MS } from '../../src/main/pageLog';

// Audit fu-main-3 (same root cause as window-3): the per-kind gap of the scrap.tf window's page log lines
// (a blocked navigation, a dropped popup, a denied permission or download) subtracted wall-clock times, so
// after Windows stepped a fast clock back by D the difference stayed negative for about D and every line of
// a kind already logged was only counted, for minutes, until a flush. A clock stepped back now counts as
// the gap passed, as scraptfWindow's sinceMs does.

const T = 1_791_958_000_000;
/** The clock stepped back ten minutes (Windows time sync correcting a fast clock). */
const STEP = 600_000;
const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('page log: a clock stepped back', () => {
  it('logs the next line of a kind at once instead of counting it for as long as the step', () => {
    const l = log();
    const ctl = { t: T };
    const p = createPageLog(l, () => ctl.t);
    p.line('info', 'popup', 'scrap.tf window: dropped a popup');
    p.line('info', 'popup', 'scrap.tf window: dropped a popup');
    expect(l.info).toHaveBeenCalledTimes(1);
    ctl.t = T - STEP;
    p.line('info', 'popup', 'scrap.tf window: dropped a popup');
    expect(l.info).toHaveBeenCalledTimes(2);
    expect(l.info).toHaveBeenLastCalledWith('scrap.tf window: dropped a popup (and 1 more like it since the last such line)');
  });

  it('keeps the gap from the line logged after the step', () => {
    const l = log();
    const ctl = { t: T };
    const p = createPageLog(l, () => ctl.t);
    p.line('warn', 'nav', 'scrap.tf window: blocked a navigation');
    ctl.t = T - STEP;
    p.line('warn', 'nav', 'scrap.tf window: blocked a navigation');
    ctl.t = T - STEP + 1_000;
    p.line('warn', 'nav', 'scrap.tf window: blocked a navigation');
    ctl.t = T - STEP + PAGE_LOG_GAP_MS - 1;
    p.line('warn', 'nav', 'scrap.tf window: blocked a navigation');
    expect(l.warn).toHaveBeenCalledTimes(2);
    ctl.t = T - STEP + PAGE_LOG_GAP_MS;
    p.line('warn', 'nav', 'scrap.tf window: blocked a navigation');
    expect(l.warn).toHaveBeenCalledTimes(3);
    expect(l.warn).toHaveBeenLastCalledWith('scrap.tf window: blocked a navigation (and 2 more like it since the last such line)');
  });

  it('still counts lines inside the gap when the clock runs forward', () => {
    const l = log();
    const ctl = { t: T };
    const p = createPageLog(l, () => ctl.t);
    for (let i = 0; i < 5; i++) {
      p.line('info', 'download', 'scrap.tf window: denied a download');
      ctl.t += 1_000;
    }
    expect(l.info).toHaveBeenCalledTimes(1);
    p.flush();
    expect(l.info).toHaveBeenLastCalledWith('scrap.tf window: denied a download: 4 more like it not logged');
  });
});
