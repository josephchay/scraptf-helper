// F21 in main's router: the 'scraptfWindow.*' methods (each a user's click, refused while the window is
// off, zod-checked with fixed messages that never quote a URL), links.open's routing of static scrap.tf
// pages into the window when the user chose that, and 'import.html' refusing address/origin from a page
// (only main's own window read sets them). Plus the window kind and the main-only pushes in every allowlist.

import { describe, expect, it, vi } from 'vitest';
import { createRpcRouter, IMPORT_HTML_ORIGIN_REFUSAL, SCRAPTF_WINDOW_UNAVAILABLE, type MainRpcDeps, type ScraptfWindowRpc } from '../../src/main/ipc';
import { isAppNavigationUrl, isTrustedSenderUrl, SCRAPTF_BAR_URL, WINDOW_KIND_ARG, WINDOW_KINDS } from '../../src/main/paths';
import { MAIN_ONLY_PUSH_EVENTS, SERVICE_PUSH_EVENTS } from '../../src/main/serviceHost';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS, SCRAPTF_HOME_URL, SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import { MAIN_METHODS, PUSH_EVENTS, SERVICE_METHODS } from '../../src/shared/rpc';
import { SCRAPTF_READ_REASONS, SCRAPTF_WINDOW_OFF, SCRAPTF_WINDOW_START_URLS } from '../../src/shared/scraptfWindowPolicy';
import { applySettingsPatch } from '../../src/shared/settingsSchema';
import type { ScraptfWindowState, Settings } from '../../src/shared/types';

const T = 1_791_958_000_000;
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;
const MARKER = 'Zq7-MARKER';
const WINDOW_METHODS = [
  'scraptfWindow.open',
  'scraptfWindow.back',
  'scraptfWindow.forward',
  'scraptfWindow.reload',
  'scraptfWindow.home',
  'scraptfWindow.go',
  'scraptfWindow.read',
  'scraptfWindow.clear',
  'scraptfWindow.state',
] as const;

function fakeWindow() {
  const state: ScraptfWindowState = { open: true, url: 'https://scrap.tf/buy/hats', canGoBack: true, canGoForward: false, lastRead: null };
  return {
    open: vi.fn((_start?: string) => undefined),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    home: vi.fn(),
    go: vi.fn((_url: string) => undefined),
    readNow: vi.fn(async () => ({ read: null, reason: SCRAPTF_READ_REASONS.tooSoon })),
    clear: vi.fn(async () => undefined),
    state: vi.fn(() => state),
  } satisfies ScraptfWindowRpc;
}

function setup(opts: { window?: boolean; settings?: Partial<Pick<Settings, 'scraptfWindow'>> & { enabled?: boolean; links?: boolean } } = {}) {
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  if (opts.settings?.enabled) {
    settings = applySettingsPatch(settings, {
      import: { enabled: true, acknowledgedAt: T },
      scraptfWindow: { enabled: true, acknowledgedAt: T, openLinksInWindow: opts.settings.links ?? false },
    });
  }
  const win = fakeWindow();
  const callRaw = vi.fn(async (method: string, params: unknown) => ({ forwarded: method, params }));
  const openExternal = vi.fn(async (_url: string) => undefined);
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    settings: { get: () => settings, set: (patch: unknown) => (settings = applySettingsPatch(settings, patch)) },
    secrets: { status: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }), set: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }) },
    service: { callRaw },
    showQuickEntry: vi.fn(),
    openItemInDashboard: vi.fn(),
    appInfo: () => ({ version: '0.7.0', dataDir: 'd', logDir: 'l', platform: 'win32', electron: '44', node: '24' }),
    serviceState: () => null,
    hotkeys: () => ({ quickEntry: { accelerator: '', registered: false, error: null }, check: { accelerator: '', registered: false, error: null } }),
    armCheck: () => ({ armedUntil: null }),
    isAllowedExternalUrl: (url: string) => url.startsWith('https://scrap.tf/buy/') || url === SCRAPTF_ITEMS_URL,
    openExternal,
    ...(opts.window === false ? {} : { scraptfWindow: win }),
    dialogs: { openHtmlFile: async () => null, openFolder: async () => null, saveFile: async () => null },
    files: { stat: async () => ({ size: 1, mtimeMs: 1, isFile: () => true }), readBytes: async () => new Uint8Array(), writeText: async () => undefined },
    log,
  } satisfies MainRpcDeps;
  const route = createRpcRouter(deps);
  const ctx = { window: null, hideWindow: vi.fn() };
  const call = (method: string, params?: unknown) => route(ctx, method, params);
  const fail = (method: string, params?: unknown) =>
    call(method, params).then(
      () => null,
      (e: unknown) => (e as Error).message,
    );
  return { call, fail, win, callRaw, openExternal, log, settings: () => settings };
}

describe('the method lists', () => {
  it('has every window method in main, none in the service, and both pushes main-only', () => {
    for (const m of WINDOW_METHODS) {
      expect(MAIN_METHODS).toContain(m);
      expect(SERVICE_METHODS).not.toContain(m);
    }
    for (const e of ['scraptfWindow.read', 'scraptfWindow.nav'] as const) {
      expect(PUSH_EVENTS).toContain(e);
      expect(MAIN_ONLY_PUSH_EVENTS).toContain(e);
      expect(SERVICE_PUSH_EVENTS).not.toContain(e);
    }
  });

  it("knows the 'scraptf' window kind, whose toolbar is a trusted app:// page; the scrap.tf view never is", () => {
    expect(WINDOW_KINDS).toContain('scraptf');
    expect(isTrustedSenderUrl(SCRAPTF_BAR_URL)).toBe(true);
    expect(isAppNavigationUrl(SCRAPTF_BAR_URL)).toBe(true);
    for (const url of ['https://scrap.tf/', HATS, 'https://scrap.tf/#/scraptf-bar', 'https://steamcommunity.com/openid/login', 'https://challenges.cloudflare.com/x', 'about:blank']) {
      expect(isTrustedSenderUrl(url), url).toBe(false);
    }
    expect(WINDOW_KIND_ARG).toBe('--flipdesk-window=');
  });
});

describe('scraptfWindow.* while the window is off or missing', () => {
  it('refuses every action while off, with a fixed message, and touches nothing', async () => {
    const h = setup();
    for (const m of ['scraptfWindow.open', 'scraptfWindow.back', 'scraptfWindow.forward', 'scraptfWindow.reload', 'scraptfWindow.home', 'scraptfWindow.read']) {
      expect(await h.fail(m), m).toBe(SCRAPTF_WINDOW_OFF);
    }
    expect(await h.fail('scraptfWindow.go', { url: HATS })).toBe(SCRAPTF_WINDOW_OFF);
    for (const fn of [h.win.open, h.win.back, h.win.forward, h.win.reload, h.win.home, h.win.go, h.win.readNow]) expect(fn).not.toHaveBeenCalled();
    // Log out & clear and the state still answer: the user may clear the session after turning the window off.
    await expect(h.call('scraptfWindow.clear')).resolves.toEqual({ ok: true });
    expect(h.win.clear).toHaveBeenCalledTimes(1);
    await expect(h.call('scraptfWindow.state')).resolves.toMatchObject({ open: true });
    expect(h.callRaw).not.toHaveBeenCalled();
  });

  it('refuses every action without a window, and reports it closed', async () => {
    const h = setup({ window: false, settings: { enabled: true } });
    for (const m of WINDOW_METHODS.filter((m) => m !== 'scraptfWindow.state')) {
      expect(await h.fail(m, m === 'scraptfWindow.go' ? { url: HATS } : undefined), m).toBe(SCRAPTF_WINDOW_UNAVAILABLE);
    }
    await expect(h.call('scraptfWindow.state')).resolves.toEqual({ open: false, url: null, canGoBack: false, canGoForward: false, lastRead: null });
  });
});

describe('scraptfWindow.* while on', () => {
  it('passes each click to the window', async () => {
    const h = setup({ settings: { enabled: true } });
    await expect(h.call('scraptfWindow.open')).resolves.toEqual({ ok: true });
    await expect(h.call('scraptfWindow.open', {})).resolves.toEqual({ ok: true });
    await expect(h.call('scraptfWindow.open', null)).resolves.toEqual({ ok: true });
    await expect(h.call('scraptfWindow.open', { start: HATS })).resolves.toEqual({ ok: true });
    expect(h.win.open.mock.calls).toEqual([[], [], [], [HATS]]);
    for (const [m, fn] of [
      ['scraptfWindow.back', h.win.back],
      ['scraptfWindow.forward', h.win.forward],
      ['scraptfWindow.reload', h.win.reload],
      ['scraptfWindow.home', h.win.home],
    ] as const) {
      await expect(h.call(m)).resolves.toEqual({ ok: true });
      expect(fn).toHaveBeenCalledTimes(1);
    }
    for (const url of SCRAPTF_WINDOW_START_URLS) await h.call('scraptfWindow.go', { url });
    expect(h.win.go.mock.calls.map((c) => c[0])).toEqual([...SCRAPTF_WINDOW_START_URLS]);
    await expect(h.call('scraptfWindow.read')).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.tooSoon });
    expect(h.callRaw).not.toHaveBeenCalled();
  });

  it('refuses any page but a static start page, never quoting it', async () => {
    const h = setup({ settings: { enabled: true } });
    const bad: unknown[] = [`${HATS}?q=${MARKER}`, `https://scrap.tf/${MARKER}`, `https://evil.example/${MARKER}`, `javascript:${MARKER}`, `${HATS}/`, 42, null, { url: HATS }, 'x'.repeat(5000)];
    for (const start of bad) {
      const msg = await h.fail('scraptfWindow.open', { start });
      expect(msg, String(start)).toBe('Invalid parameters for scraptfWindow.open: start: not a scrap.tf page the window opens');
    }
    for (const url of bad) {
      const msg = await h.fail('scraptfWindow.go', { url });
      expect(msg, String(url)).toBe('Invalid parameters for scraptfWindow.go: url: not a scrap.tf page the window opens');
    }
    expect(await h.fail('scraptfWindow.go', {})).toMatch(/^Invalid parameters for scraptfWindow\.go: url/);
    expect(await h.fail('scraptfWindow.go', HATS)).toMatch(/^Invalid parameters for scraptfWindow\.go/);
    expect(h.win.open).not.toHaveBeenCalled();
    expect(h.win.go).not.toHaveBeenCalled();
  });

  it('hands out a copy of the state', async () => {
    const h = setup({ settings: { enabled: true } });
    const s = (await h.call('scraptfWindow.state')) as ScraptfWindowState;
    s.url = 'changed';
    expect(h.win.state().url).toBe('https://scrap.tf/buy/hats');
  });
});

describe('links.open with openLinksInWindow (F21)', () => {
  it('opens a static start page in the window when the user chose that and the caller words it so (allowWindow)', async () => {
    const h = setup({ settings: { enabled: true, links: true } });
    const w = { allowWindow: true };
    await expect(h.call('links.open', { url: HATS, ...w })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    await expect(h.call('links.open', { url: SCRAPTF_ITEMS_URL, ...w })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    await expect(h.call('links.open', { url: SCRAPTF_HOME_URL, ...w })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    expect(h.win.open.mock.calls).toEqual([[HATS], [SCRAPTF_ITEMS_URL], [SCRAPTF_HOME_URL]]);
    expect(h.openExternal).not.toHaveBeenCalled();
    // Anything else goes the old way: the browser when allowlisted, else refused.
    await expect(h.call('links.open', { url: 'https://scrap.tf/buy/hats?x=1', ...w })).resolves.toEqual({ opened: true, reason: null });
    expect(h.openExternal).toHaveBeenCalledWith('https://scrap.tf/buy/hats?x=1');
    await expect(h.call('links.open', { url: 'https://scrap.tf/terms', ...w })).resolves.toMatchObject({ opened: false });
    expect(h.win.open).toHaveBeenCalledTimes(3);
  });

  it("keeps a link whose words promise the browser in the browser, the user's choice on or not", async () => {
    const h = setup({ settings: { enabled: true, links: true } });
    // The Bank stock page, Shopping, the scrap.tf/items card and the drawer's list buttons send no allowWindow.
    for (const params of [{ url: HATS }, { url: SCRAPTF_ITEMS_URL }, { url: HATS, allowWindow: false }]) {
      await expect(h.call('links.open', params)).resolves.toEqual({ opened: true, reason: null });
    }
    expect(h.openExternal.mock.calls).toEqual([[HATS], [SCRAPTF_ITEMS_URL], [HATS]]);
    expect(h.win.open).not.toHaveBeenCalled();
    expect(await h.fail('links.open', { url: HATS, allowWindow: 1 })).toMatch(/^Invalid parameters for links.open: allowWindow/);
  });

  it('keeps every link in the browser when the window is off, the choice is off, or there is no window', async () => {
    for (const h of [setup({ settings: { enabled: true, links: false } }), setup(), setup({ window: false, settings: { enabled: true, links: true } })]) {
      await expect(h.call('links.open', { url: HATS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null });
      expect(h.openExternal).toHaveBeenCalledWith(HATS);
      expect(h.win.open).not.toHaveBeenCalled();
      // Home is not on the browser allowlist, so it stays refused there.
      await expect(h.call('links.open', { url: SCRAPTF_HOME_URL })).resolves.toMatchObject({ opened: false });
    }
  });
});

describe("'import.html' from a page (F21)", () => {
  it('refuses address and origin, which only main sets, with a fixed message', async () => {
    const h = setup({ settings: { enabled: true } });
    const page = { html: '<html></html>', fileName: 'a.html', mtimeMs: 1 };
    for (const extra of [{ address: HATS }, { origin: 'window' }, { origin: 'file' }, { address: MARKER, origin: MARKER }, { address: null }]) {
      expect(await h.fail('import.html', { ...page, ...extra })).toBe(IMPORT_HTML_ORIGIN_REFUSAL);
    }
    expect(IMPORT_HTML_ORIGIN_REFUSAL).not.toContain('Zq7');
    expect(h.callRaw).not.toHaveBeenCalled();
    // Without them (or left undefined) the page's import is forwarded as before.
    await expect(h.call('import.html', page)).resolves.toMatchObject({ forwarded: 'import.html' });
    await expect(h.call('import.html', { ...page, address: undefined, origin: undefined })).resolves.toMatchObject({ forwarded: 'import.html' });
  });
});
