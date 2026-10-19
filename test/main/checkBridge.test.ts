// F16 bridge contract: the preload knows the 'check' window kind (same list as main's paths.ts) and
// holds 'ui.checkShow' for a popup page still loading; 'ui.checkShow' is main's own push (a service
// sending it is dropped); 'check.text' and 'check.recent' go to the service; 'app.showQuickEntry'
// carries price text, validated before it reaches a window.

import { describe, expect, it, vi } from 'vitest';
import { CHECK_TEXT_SOURCE_REFUSAL, createRpcRouter, type MainRpcDeps } from '../../src/main/ipc';
import { WINDOW_KIND_ARG, WINDOW_KINDS } from '../../src/main/paths';
import { MAIN_ONLY_PUSH_EVENTS, SERVICE_PUSH_EVENTS } from '../../src/main/serviceHost';
import { CHECK_PRICE_TEXT_MAX } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { MAIN_METHODS, PUSH_EVENTS, SERVICE_METHODS, type FlipdeskBridge } from '../../src/shared/rpc';

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  pushListener: null as null | ((event: unknown, ...args: unknown[]) => void),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => electron.exposed.set(key, api) },
  ipcRenderer: {
    invoke: vi.fn(),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      if (channel === 'push') electron.pushListener = fn;
    },
  },
}));

async function loadPreload(kind: string) {
  vi.resetModules();
  electron.exposed.clear();
  const saved = process.argv;
  process.argv = ['electron', `${WINDOW_KIND_ARG}${kind}`];
  try {
    const mod = await import('../../src/main/preload');
    return { mod, bridge: electron.exposed.get('flipdesk') as FlipdeskBridge };
  } finally {
    process.argv = saved;
  }
}

describe('preload', () => {
  it("keeps the same window kinds as main's paths.ts and reads 'check'", async () => {
    const { mod, bridge } = await loadPreload('check');
    expect([...mod.PRELOAD_WINDOW_KINDS]).toEqual([...WINDOW_KINDS]);
    expect(bridge.windowKind).toBe('check');
  });

  it('holds ui.checkShow for a popup page that has not subscribed yet (the latest wins, once)', async () => {
    const { mod, bridge } = await loadPreload('check');
    expect(mod.HELD_EVENTS.has('ui.checkShow')).toBe(true);
    electron.pushListener!({}, 'ui.checkShow', { id: 1 });
    electron.pushListener!({}, 'ui.checkShow', { id: 2 });
    const first = vi.fn();
    bridge.on('ui.checkShow', first);
    await Promise.resolve();
    expect(first.mock.calls).toEqual([[{ id: 2 }]]);
    const second = vi.fn();
    bridge.on('ui.checkShow', second);
    await Promise.resolve();
    expect(second).not.toHaveBeenCalled();
  });

  it('does not hold check.done (a service push for loaded pages only)', async () => {
    const { bridge } = await loadPreload('dashboard');
    electron.pushListener!({}, 'check.done', { id: 1 });
    const l = vi.fn();
    bridge.on('check.done', l);
    await Promise.resolve();
    expect(l).not.toHaveBeenCalled();
  });
});

describe('method and push lists', () => {
  it('check.text and check.recent are service methods; check.done a service push; ui.checkShow main-owned', () => {
    expect(SERVICE_METHODS).toEqual(expect.arrayContaining(['check.text', 'check.recent']));
    expect(MAIN_METHODS).not.toContain('check.text');
    expect(PUSH_EVENTS).toEqual(expect.arrayContaining(['check.done', 'ui.checkShow']));
    expect(SERVICE_PUSH_EVENTS).toContain('check.done');
    expect(MAIN_ONLY_PUSH_EVENTS).toContain('ui.checkShow');
    expect(SERVICE_PUSH_EVENTS).not.toContain('ui.checkShow');
  });
});

describe('app.showQuickEntry with price text', () => {
  function route() {
    const showQuickEntry = vi.fn();
    const armCheck = vi.fn((arm: unknown) => ({ armedUntil: arm ? 1 : null }));
    const callRaw = vi.fn(async (method: string, params: unknown) => ({ method, params }));
    const deps = {
      settings: { get: () => DEFAULT_SETTINGS, set: vi.fn() },
      secrets: { status: vi.fn(), set: vi.fn() },
      service: { callRaw },
      showQuickEntry,
      openItemInDashboard: vi.fn(),
      appInfo: vi.fn(),
      serviceState: () => null,
      armCheck,
      isAllowedExternalUrl: () => false,
      openExternal: vi.fn(),
      dialogs: { openHtmlFile: vi.fn(), openFolder: vi.fn(), saveFile: vi.fn() },
      files: { stat: vi.fn(), readBytes: vi.fn(), writeText: vi.fn() },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as MainRpcDeps;
    const ctx = { window: null, hideWindow: vi.fn() };
    const router = createRpcRouter(deps);
    return { call: (m: string, p: unknown) => router(ctx, m, p), showQuickEntry, callRaw, armCheck };
  }

  it('passes the price on with a SKU only, trimmed', async () => {
    const r = route();
    await r.call('app.showQuickEntry', { sku: '378;6', price: ' 1 key 5.33 ref ' });
    await r.call('app.showQuickEntry', { sku: '378;6' });
    await r.call('app.showQuickEntry', { price: '5 ref' });
    expect(r.showQuickEntry.mock.calls).toEqual([['378;6', '1 key 5.33 ref'], ['378;6'], []]);
  });

  it('refuses price text that is too long, multi-line or markup', async () => {
    const r = route();
    for (const price of ['x'.repeat(CHECK_PRICE_TEXT_MAX + 1), '1 ref\n2 ref', '<b>1 ref</b>', '', 5]) {
      await expect(r.call('app.showQuickEntry', { sku: '378;6', price })).rejects.toThrow(/Invalid parameters for app\.showQuickEntry: price/);
    }
    expect(r.showQuickEntry).not.toHaveBeenCalled();
  });

  it('forwards check.text to the service untouched (the service validates it)', async () => {
    const r = route();
    await r.call('check.text', { text: 'Team Captain', source: 'manual' });
    expect(r.callRaw).toHaveBeenCalledWith('check.text', { text: 'Team Captain', source: 'manual' });
  });

  it("refuses a page's check.text that claims main's clipboard paths, without echoing the text", async () => {
    const r = route();
    for (const params of [
      { text: 'Zebulonquux', source: 'hotkey' },
      { text: 'Zebulonquux', source: 'watch' },
      { text: 'Zebulonquux' },
      'Zebulonquux',
      null,
    ]) {
      const err = await r.call('check.text', params).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toBe(CHECK_TEXT_SOURCE_REFUSAL);
      expect(err?.message).not.toContain('Zebulonquux');
    }
    expect(r.callRaw).not.toHaveBeenCalled();
  });
});
