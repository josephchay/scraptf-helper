// Audit window-1 / importflow-3: the toolbar's Unusuals chip lands on scrap.tf's bare /unusuals index, which
// lists the unusual pages and never shows item cards. A read of it that found nothing said "no items on screen
// yet; wait for them, then Read page now" (or "scrap.tf changed this page's layout"), neither of which can
// ever come true. The service now keeps the import's 'unusuals-index' warning on such a read, main sends that
// code, and the toolbar says to open one of the index's pages, as guidance rather than a warning. Sub-pages
// keep 'no-cards-saved' (F18 decision 6), a challenge notice still wins, and an index that does show cards
// reads as before. Electron fakes; the import is a stub giving the service's own answer.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UNUSUALS_INDEX_WARNING } from '../../src/service/import/scraptfHtml';
import { WINDOW_NOTHING_TO_IMPORT } from '../../src/service/rpcHandlers';
import { readStatusView, readWarningText } from '../../src/renderer/scraptfWindowModel';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { UNUSUALS_INDEX } from '../../src/shared/importCodes';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { READ_MANUAL_MIN_GAP_MS, SCRAPTF_WINDOW_NOTICES } from '../../src/shared/scraptfWindowPolicy';
import type { ImportResult, ScraptfWindowRead, Settings } from '../../src/shared/types';
import { fake } from './scraptfWindowFakes';

vi.mock('electron', async () => (await import('./scraptfWindowFakes')).fakeElectron);

const { createScraptfWindowManager } = await import('../../src/main/scraptfWindow');
type Deps = import('../../src/main/scraptfWindow').ScraptfWindowDeps;

const T = 1_791_958_000_000;
const INDEX = SCRAPTF_BANKS.find((b) => b.bank === 'unusuals')!.url;
const INDEX_TEXT = 'this is the Unusuals index, which lists no items: open one of its pages to read it';

beforeEach(() => {
  fake.FakeWin.all = [];
  fake.FakeView.all = [];
  fake.sessions.clear();
  fake.journal.length = 0;
});

function windowSettings(over: Partial<Settings['scraptfWindow']> = {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.import = { ...s.import, enabled: true, acknowledgedAt: T };
  s.scraptfWindow = { ...s.scraptfWindow, enabled: true, acknowledgedAt: T, ...over };
  return s;
}

/** The service's answer to a window read of the index: nothing recorded, the index warning kept. */
function indexResult(over: Partial<ImportResult> = {}): ImportResult {
  return {
    batchId: 0,
    fileName: 'scrap.tf window /unusuals',
    pageKind: 'unusuals',
    bank: 'unusuals',
    parsed: 0,
    stored: 0,
    skipped: [],
    warnings: [WINDOW_NOTHING_TO_IMPORT, UNUSUALS_INDEX_WARNING],
    origin: 'window',
    ...over,
  };
}

function setup(over: Partial<Settings['scraptfWindow']> = {}) {
  const ctl = { settings: windowSettings(over), t: T };
  const handles: { fn: () => void; cleared: boolean; fired: boolean }[] = [];
  const timers = {
    setTimeout: vi.fn((fn: () => void, _ms: number) => {
      const h = { fn, cleared: false, fired: false };
      handles.push(h);
      return h;
    }),
    clearTimeout: vi.fn((h: unknown) => void ((h as { cleared: boolean }).cleared = true)),
  };
  const importHtml = vi.fn(async (_p: unknown) => indexResult());
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: Deps = {
    settings: () => ctl.settings,
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
  /** A document the user's browsing committed with an HTTP status, then loaded. */
  const land = (url: string, html: string, status = 200) => {
    const c = wc();
    c.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    c.url = url;
    c.html = html;
    c.emit('did-navigate', {}, url, status, '');
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
  const reads = () => bar().sent.filter(([ch, e]) => ch === 'push' && e === 'scraptfWindow.read').map(([, , p]) => p as ScraptfWindowRead);
  return { m, ctl, importHtml, wc, toolbarReady, land, settle, reads };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('a read of the bare /unusuals index (the Unusuals chip)', () => {
  it("says it is the index on the automatic read, not 'wait for them'", async () => {
    const s = setup();
    s.m.open(INDEX);
    s.toolbarReady();
    s.land(INDEX, '<html>the index</html>');
    await s.settle();
    expect(s.importHtml).toHaveBeenCalledTimes(1);
    expect(s.reads().at(-1)).toMatchObject({ path: '/unusuals', items: 0, bank: 'unusuals', warning: UNUSUALS_INDEX });
  });

  it('says so on Read page now, at /unusuals and at /buy/unusuals', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(INDEX);
    s.land(INDEX, '<html>the index</html>');
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: null, read: { items: 0, warning: UNUSUALS_INDEX } });
    s.land('https://scrap.tf/buy/unusuals', '<html>the index again</html>');
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: null, read: { path: '/buy/unusuals', warning: UNUSUALS_INDEX } });
  });

  it("keeps 'no-cards-saved' for a sub-page read before its cards, and reads an index that shows cards as before", async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(INDEX);
    s.land('https://scrap.tf/unusuals/378', '<html>effect page, cards still coming</html>');
    s.importHtml.mockResolvedValueOnce(indexResult({ fileName: 'scrap.tf window /unusuals/378', warnings: [WINDOW_NOTHING_TO_IMPORT] }));
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { path: '/unusuals/378', warning: 'no-cards-saved' } });
    s.land(INDEX, '<html>an index with cards</html>');
    s.ctl.t += READ_MANUAL_MIN_GAP_MS;
    s.importHtml.mockResolvedValueOnce(indexResult({ batchId: 7, parsed: 24, stored: 24, warnings: [] }));
    await expect(s.m.readNow()).resolves.toMatchObject({ read: { path: '/unusuals', items: 24, warning: null } });
  });

  it('words a Cloudflare check served at /unusuals by its notice, not as the index', async () => {
    const s = setup({ readOnLoad: false });
    s.m.open(INDEX);
    s.land(INDEX, '<html>Just a moment...</html>', 403);
    await expect(s.m.readNow()).resolves.toMatchObject({ reason: null, read: { warning: SCRAPTF_WINDOW_NOTICES.challenge } });
  });

  it('the toolbar words the code as guidance, not as a warning to wait or a changed layout', () => {
    expect(readWarningText(UNUSUALS_INDEX)).toBe(INDEX_TEXT);
    const v = readStatusView({ at: T, path: '/unusuals', items: 0, bank: 'unusuals', newFlips: 0, warning: UNUSUALS_INDEX }, T);
    expect(v.main).toBe(`Read 0 items from /unusuals · ${INDEX_TEXT}`);
    expect(v.tone).not.toBe('warn');
    expect(v.main).not.toMatch(/wait for them|layout/);
  });
});
