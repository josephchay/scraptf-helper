// 0.7.3: every window call in main's router is one move for one click (F21, R1). The compliance scan now flags a
// manager call after an await; this checks the router at run time too, aliased calls included: each method
// settles, calls exactly one manager method once, and nothing more happens however long the clock runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRpcRouter, type MainRpcDeps, type ScraptfWindowRpc } from '../../src/main/ipc';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { SCRAPTF_READ_REASONS } from '../../src/shared/scraptfWindowPolicy';
import { applySettingsPatch } from '../../src/shared/settingsSchema';
import type { ScraptfWindowState } from '../../src/shared/types';

const T = 1_791_958_000_000;
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;
const TEN_MINUTES = 10 * 60_000;

function setup() {
  const state: ScraptfWindowState = { open: true, url: HATS, canGoBack: true, canGoForward: false, lastRead: null };
  const win = {
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
  const settings = applySettingsPatch(structuredClone(DEFAULT_SETTINGS), {
    import: { enabled: true, acknowledgedAt: T },
    scraptfWindow: { enabled: true, acknowledgedAt: T, openLinksInWindow: true },
  });
  const deps = {
    settings: { get: () => settings, set: () => settings },
    secrets: { status: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }), set: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }) },
    service: { callRaw: vi.fn(async () => null) },
    showQuickEntry: vi.fn(),
    openItemInDashboard: vi.fn(),
    appInfo: () => ({ version: '0.7.3', appDir: 'a', dataDir: 'd', logDir: 'l', platform: 'win32', electron: '44', node: '24' }),
    serviceState: () => null,
    hotkeys: () => ({ quickEntry: { accelerator: '', registered: false, error: null }, check: { accelerator: '', registered: false, error: null } }),
    armCheck: () => ({ armedUntil: null }),
    isAllowedExternalUrl: () => true,
    openExternal: vi.fn(async () => undefined),
    scraptfWindow: win,
    dialogs: { openHtmlFile: async () => null, openFolder: async () => null, saveFile: async () => null },
    files: { stat: async () => ({ size: 1, mtimeMs: 1, isFile: () => true }), readBytes: async () => new Uint8Array(), writeText: async () => undefined },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies MainRpcDeps;
  const route = createRpcRouter(deps);
  const counts = () => Object.fromEntries(Object.entries(win).map(([k, fn]) => [k, fn.mock.calls.length]));
  return { call: (method: string, params?: unknown) => route({ window: null, hideWindow: vi.fn() }, method, params), counts, openExternal: deps.openExternal };
}

const CASES: readonly [method: string, params: unknown, manager: keyof ScraptfWindowRpc][] = [
  ['scraptfWindow.open', undefined, 'open'],
  ['scraptfWindow.open', { start: HATS }, 'open'],
  ['scraptfWindow.back', undefined, 'back'],
  ['scraptfWindow.forward', undefined, 'forward'],
  ['scraptfWindow.reload', undefined, 'reload'],
  ['scraptfWindow.home', undefined, 'home'],
  ['scraptfWindow.go', { url: HATS }, 'go'],
  ['scraptfWindow.read', undefined, 'readNow'],
  ['scraptfWindow.clear', undefined, 'clear'],
  ['links.open', { url: HATS, allowWindow: true }, 'open'],
];

describe("the router's window calls: one move per click, nothing later (F21, R1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [method, params, manager] of CASES) {
    it(`${method}${params === undefined ? '' : ` ${JSON.stringify(params)}`} calls ${manager} once and settles`, async () => {
      const h = setup();
      let settled = false;
      void h.call(method, params).then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(TEN_MINUTES);
      expect(settled).toBe(true);
      const once = { ...Object.fromEntries(Object.keys(h.counts()).map((k) => [k, 0])), [manager]: 1 };
      expect(h.counts()).toEqual(once);
      await vi.advanceTimersByTimeAsync(TEN_MINUTES);
      expect(h.counts()).toEqual(once);
      expect(h.openExternal).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});
