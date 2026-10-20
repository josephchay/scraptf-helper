// Audit window-2: a Read page now whose page renderer dies (or whose window closes) while READ_SCRIPT runs
// never answered: the script's promise never settles on a dead renderer, so the toolbar's 'scraptfWindow.read'
// call stayed pending and its button stayed "Reading…" until the window was reopened. The read now ends when
// its view's renderer goes or the view is dropped: it answers with the page's notice (or "not open"), pushes
// no read and keeps the last one, and the page reads again after Reload. No timer is involved.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { READ_MANUAL_MIN_GAP_MS, SCRAPTF_READ_REASONS, SCRAPTF_WINDOW_NOTICES } from '../../src/shared/scraptfWindowPolicy';
import type { ImportResult, ScraptfWindowNav, Settings } from '../../src/shared/types';
import { fake } from './scraptfWindowFakes';

vi.mock('electron', async () => (await import('./scraptfWindowFakes')).fakeElectron);

const { createScraptfWindowManager } = await import('../../src/main/scraptfWindow');
type Deps = import('../../src/main/scraptfWindow').ScraptfWindowDeps;

const T = 1_791_958_000_000;
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;

beforeEach(() => {
  fake.FakeWin.all = [];
  fake.FakeView.all = [];
  fake.sessions.clear();
  fake.journal.length = 0;
});

function setup() {
  const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  settings.import = { ...settings.import, enabled: true, acknowledgedAt: T };
  settings.scraptfWindow = { ...settings.scraptfWindow, enabled: true, acknowledgedAt: T, readOnLoad: false };
  const ctl = { t: T };
  const timers = { setTimeout: vi.fn((_fn: () => void, _ms: number) => ({})), clearTimeout: vi.fn() };
  const result: ImportResult = { batchId: 7, fileName: 'scrap.tf window /buy/hats', pageKind: 'buy', parsed: 48, stored: 48, skipped: [], warnings: [], bank: 'hats', origin: 'window', newFlips: 2 };
  const importHtml = vi.fn(async (_p: unknown) => result);
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: Deps = {
    settings: () => settings,
    log,
    preloadPath: 'C:/app/dist/preload.cjs',
    iconPath: 'C:/app/assets/icon.png',
    devTools: false,
    importHtml,
    openExternal: vi.fn(async () => undefined),
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
  const land = (url: string, html: string) => {
    const c = wc();
    c.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    c.url = url;
    c.html = html;
    c.emit('did-navigate', {}, url, 200, 'OK');
    c.emit('did-finish-load');
  };
  const pushes = <P>(event: string): P[] => bar().sent.filter(([ch, e]) => ch === 'push' && e === event).map(([, , p]) => p as P);
  return { m, ctl, timers, importHtml, log, wc, toolbarReady, land, pushes };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('a Read page now whose renderer can no longer answer', () => {
  it('ends when the renderer dies mid-read, with the crash notice, and the page reads again after Reload', async () => {
    const s = setup();
    s.m.open(HATS);
    s.toolbarReady();
    s.land(HATS, '<html>hats v1</html>');
    expect((await s.m.readNow()).reason).toBeNull();
    const lastRead = s.m.state().lastRead;
    const readsBefore = s.pushes('scraptfWindow.read').length;
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.wc().html = '<html>hats v2</html>';
    s.wc().executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise<unknown>(() => undefined));
    const first = s.m.readNow();
    await flush();
    s.wc().emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await expect(first).resolves.toEqual({ read: null, reason: SCRAPTF_WINDOW_NOTICES.crashed });
    // Nothing imported or pushed for it, and the last read stays.
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    expect(s.pushes('scraptfWindow.read')).toHaveLength(readsBefore);
    expect(s.m.state().lastRead).toEqual(lastRead);
    expect(s.pushes<ScraptfWindowNav>('scraptfWindow.nav').at(-1)).toMatchObject({ notice: SCRAPTF_WINDOW_NOTICES.crashed, reading: false });
    // Reload brings the page back: Read page now reads it.
    s.m.reload();
    s.land(HATS, '<html>hats after the crash</html>');
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    expect((await s.m.readNow()).reason).toBeNull();
    expect(s.importHtml).toHaveBeenCalledTimes(2);
  });

  it('ends when the window closes mid-read, as "not open"', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS, '<html>hats</html>');
    s.wc().executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise<unknown>(() => undefined));
    const first = s.m.readNow();
    await flush();
    s.m.close();
    await expect(first).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.notOpen });
    expect(s.importHtml).not.toHaveBeenCalled();
  });

  it('a script that rejects after its read ended is handled, with no timer started', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS, '<html>hats</html>');
    let reject: (e: unknown) => void = () => undefined;
    s.wc().executeJavaScriptInIsolatedWorld.mockImplementationOnce(
      () =>
        new Promise<unknown>((_resolve, rej) => {
          reject = rej;
        }),
    );
    const first = s.m.readNow();
    await flush();
    s.wc().emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
    await expect(first).resolves.toEqual({ read: null, reason: SCRAPTF_WINDOW_NOTICES.crashed });
    // vitest fails the run on an unhandled rejection.
    reject(new Error('late'));
    await flush();
    expect(s.log.warn).not.toHaveBeenCalled();
    expect(s.timers.setTimeout).not.toHaveBeenCalled();
  });

  it('a second read on the same view after the abandoned one keeps its own lock', async () => {
    const s = setup();
    s.m.open(HATS);
    s.land(HATS, '<html>hats</html>');
    s.wc().executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise<unknown>(() => undefined));
    const first = s.m.readNow();
    await flush();
    s.wc().emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    // The page comes back and the next read starts before the first one has answered.
    s.land(HATS, '<html>hats again</html>');
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    let finish: (v: unknown) => void = () => undefined;
    s.wc().executeJavaScriptInIsolatedWorld.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
    const second = s.m.readNow();
    await expect(first).resolves.toMatchObject({ read: null });
    // The second read still holds its view: another one now is "busy".
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    await expect(s.m.readNow()).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.busy });
    finish('<html>hats again</html>');
    expect((await second).reason).toBeNull();
    expect(s.importHtml).toHaveBeenCalledTimes(1);
  });
});
