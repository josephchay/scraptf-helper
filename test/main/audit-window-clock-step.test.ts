// Audit window-3: every gap in the scrap.tf window (Read page now's gap, the link-out dedupe, the per-page
// automatic gap and the dedupe) subtracted wall-clock times, so after Windows stepped a fast clock back by D
// each difference was negative for about D: Read page now said "Read a moment ago" for minutes, links to the
// browser were dropped and pages were not read on load. A clock stepped back now counts as the gap passed
// (and as an expired user input), as buyerCheck's cache does. Electron fakes; nothing is fetched.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { EXTERNAL_OPEN_MIN_GAP_MS, READ_AUTO_MIN_GAP_MS, READ_MANUAL_MIN_GAP_MS, SCRAPTF_READ_REASONS, SCRAPTF_WINDOW_NOTICES } from '../../src/shared/scraptfWindowPolicy';
import type { ImportResult, ScraptfWindowNav, Settings } from '../../src/shared/types';
import { fake } from './scraptfWindowFakes';

vi.mock('electron', async () => (await import('./scraptfWindowFakes')).fakeElectron);

const { createScraptfWindowManager } = await import('../../src/main/scraptfWindow');
type Deps = import('../../src/main/scraptfWindow').ScraptfWindowDeps;

const T = 1_791_958_000_000;
/** The clock stepped back ten minutes (Windows time sync correcting a fast clock). */
const STEP = 600_000;
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;
const BPTF = 'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable';
const BPTF_2 = 'https://backpack.tf/stats/Unique/Bill%27s%20Hat/Tradable/Craftable';

beforeEach(() => {
  fake.FakeWin.all = [];
  fake.FakeView.all = [];
  fake.sessions.clear();
  fake.journal.length = 0;
});

function setup(over: Partial<Settings['scraptfWindow']> = {}) {
  const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  settings.import = { ...settings.import, enabled: true, acknowledgedAt: T };
  settings.scraptfWindow = { ...settings.scraptfWindow, enabled: true, acknowledgedAt: T, ...over };
  const ctl = { t: T };
  const handles: { fn: () => void; cleared: boolean; fired: boolean }[] = [];
  const timers = {
    setTimeout: vi.fn((fn: () => void, _ms: number) => {
      const h = { fn, cleared: false, fired: false };
      handles.push(h);
      return h;
    }),
    clearTimeout: vi.fn((h: unknown) => void ((h as { cleared: boolean }).cleared = true)),
  };
  const result: ImportResult = { batchId: 7, fileName: 'scrap.tf window /buy/hats', pageKind: 'buy', parsed: 48, stored: 48, skipped: [], warnings: [], bank: 'hats', origin: 'window', newFlips: 2 };
  const importHtml = vi.fn(async (_p: unknown) => result);
  const openExternal = vi.fn(async (_url: string) => undefined);
  const deps: Deps = {
    settings: () => settings,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    preloadPath: 'C:/app/dist/preload.cjs',
    iconPath: 'C:/app/assets/icon.png',
    devTools: false,
    importHtml,
    openExternal,
    isQuitting: () => false,
    now: () => ctl.t,
    timers,
  };
  const m = createScraptfWindowManager(deps);
  const wc = () => fake.FakeView.all.at(-1)!.webContents;
  const bar = () => fake.FakeWin.all.at(-1)!.webContents;
  const toolbarReady = () => {
    bar().emit('did-finish-load');
    fake.FakeWin.all.at(-1)!.emit('ready-to-show');
  };
  const land = (url: string) => {
    const c = wc();
    c.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    c.url = url;
    c.emit('did-navigate', {}, url, 200, 'OK');
    c.emit('did-finish-load');
  };
  const settle = async () => {
    await flush();
    for (const h of handles.filter((x) => !x.cleared && !x.fired)) {
      h.fired = true;
      h.fn();
    }
    await flush();
  };
  const click = () => wc().emit('input-event', {}, { type: 'mouseDown' });
  const navigate = (url: string) => wc().emit('will-navigate', { url, isMainFrame: true, isSameDocument: false, preventDefault: vi.fn() });
  const lastNav = () => bar().sent.filter(([ch, e]) => ch === 'push' && e === 'scraptfWindow.nav').map(([, , p]) => p as ScraptfWindowNav).at(-1);
  return { m, ctl, importHtml, openExternal, wc, toolbarReady, land, settle, click, navigate, lastNav };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('a wall clock stepped back', () => {
  it('does not hold Read page now back for the length of the step, and the gap still holds after it', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS);
    expect((await s.m.readNow()).reason).toBeNull();
    s.ctl.t += 1_000;
    s.ctl.t -= STEP;
    s.wc().html = '<html>hats v2</html>';
    expect((await s.m.readNow()).reason).toBeNull();
    expect(s.importHtml).toHaveBeenCalledTimes(2);
    s.ctl.t += READ_MANUAL_MIN_GAP_MS - 1;
    s.wc().html = '<html>hats v3</html>';
    await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.tooSoon });
  });

  it('still lets the next clicked link out, and still dedupes the twin events of one click', () => {
    const s = setup();
    s.m.open();
    s.click();
    s.navigate(BPTF);
    expect(s.openExternal.mock.calls).toEqual([[BPTF]]);
    s.ctl.t += 30_000 - STEP;
    s.click();
    s.navigate(BPTF_2);
    expect(s.openExternal.mock.calls).toEqual([[BPTF], [BPTF_2]]);
    // The twin will-frame-navigate of the same click.
    s.wc().emit('will-frame-navigate', { url: BPTF_2, isMainFrame: true, isSameDocument: false, preventDefault: vi.fn() });
    expect(s.openExternal.mock.calls).toEqual([[BPTF], [BPTF_2]]);
  });

  it('does not stretch a click from before the step into a later link out', () => {
    const s = setup();
    s.m.open();
    s.toolbarReady();
    s.click();
    s.ctl.t -= STEP;
    s.navigate(BPTF);
    expect(s.openExternal).not.toHaveBeenCalled();
    expect(s.lastNav()?.notice).toBe(SCRAPTF_WINDOW_NOTICES.needsClick);
    s.ctl.t += EXTERNAL_OPEN_MIN_GAP_MS;
    s.click();
    s.navigate(BPTF);
    expect(s.openExternal.mock.calls).toEqual([[BPTF]]);
  });

  it('reads a page on load again once its gap has really passed', async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS);
    await s.settle();
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    s.ctl.t += READ_AUTO_MIN_GAP_MS + 60_000 - STEP;
    s.wc().html = '<html>hats, later</html>';
    s.land(HATS);
    await s.settle();
    expect(s.importHtml).toHaveBeenCalledTimes(2);
  });
});
