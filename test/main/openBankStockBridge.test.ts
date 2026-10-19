// 0.7.1 bridge contract for "Show flips": 'app.showBankStock' is a main method, and 'ui.openBankStock' a
// main-only push (a service sending it is dropped) that the preload holds for a dashboard still loading,
// like 'ui.openItem'. main.ts (it imports Electron, so it is read, not run) shows the dashboard and sends
// the push, the same shape as openItemInDashboard, and touches nothing in the scrap.tf window.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_KIND_ARG } from '../../src/main/paths';
import { MAIN_ONLY_PUSH_EVENTS, SERVICE_PUSH_EVENTS, createServiceHost, type ServiceProcessLike } from '../../src/main/serviceHost';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { MAIN_METHODS, PUSH_EVENTS, SERVICE_METHODS, type FlipdeskBridge, type PushContract } from '../../src/shared/rpc';

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

class FakeProc extends EventEmitter implements ServiceProcessLike {
  pid = 102;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  postMessage(): void {
    // init and RPCs are not under test here
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/** main.ts without comments, whitespace runs folded to one space. */
const MAIN = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  .replace(/\s+/g, ' ');

/** From `marker` to the brace closing the first block after it. */
function block(marker: string): string {
  const at = MAIN.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  const open = MAIN.indexOf('{', at + marker.length);
  let depth = 0;
  for (let i = open; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++;
    else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(at, i + 1);
  }
  throw new Error(`unbalanced after ${marker}`);
}

describe('method and push lists', () => {
  it("'app.showBankStock' is main's; 'ui.openBankStock' a main-only push", () => {
    expect(MAIN_METHODS).toContain('app.showBankStock');
    expect(SERVICE_METHODS).not.toContain('app.showBankStock');
    expect(PUSH_EVENTS).toContain('ui.openBankStock');
    expect(MAIN_ONLY_PUSH_EVENTS).toContain('ui.openBankStock');
    expect(SERVICE_PUSH_EVENTS).not.toContain('ui.openBankStock');
  });
});

describe('the service host', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops a 'ui.openBankStock' the service sends (only main may move the dashboard)", () => {
    const procs: FakeProc[] = [];
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const host = createServiceHost({
      fork: () => {
        const p = new FakeProc();
        procs.push(p);
        return p;
      },
      init: () => ({ dataDir: '/data', version: '0.7.1', settings: DEFAULT_SETTINGS, secrets: {} }),
      log,
      now: () => Date.now(),
    });
    host.start();
    const p = procs[0]!;
    p.emit('spawn');
    p.emit('message', { type: 'ready' });
    const seen: unknown[] = [];
    host.onPush((event, payload) => seen.push([event, payload]));
    const payload: PushContract['ui.openBankStock'] = { bank: 'hats', filter: 'flips' };
    p.emit('message', { type: 'push', event: 'ui.openBankStock', payload });
    expect(seen).toEqual([]);
    void host.shutdown(0);
  });
});

describe('preload', () => {
  it("holds 'ui.openBankStock' for a dashboard that has not subscribed yet (the latest wins, once)", async () => {
    const { mod, bridge } = await loadPreload('dashboard');
    expect(mod.HELD_EVENTS.has('ui.openBankStock')).toBe(true);
    electron.pushListener!({}, 'ui.openBankStock', { bank: 'hats', filter: 'flips' });
    electron.pushListener!({}, 'ui.openBankStock', { bank: 'weapons', filter: 'new' });
    const first = vi.fn();
    bridge.on('ui.openBankStock', first);
    await Promise.resolve();
    expect(first.mock.calls).toEqual([[{ bank: 'weapons', filter: 'new' }]]);
    const second = vi.fn();
    bridge.on('ui.openBankStock', second);
    await Promise.resolve();
    expect(second).not.toHaveBeenCalled();
  });
});

describe('main.ts wiring', () => {
  it('shows the dashboard, then sends the push, and moves nothing in the scrap.tf window', () => {
    const fn = block('function showBankStock(rt: Runtime, bank: ScraptfBank, filter: BankStockOpenFilter): void');
    expect(fn).toContain("rt.windows.showDashboard(); rt.windows.sendToDashboard('ui.openBankStock', { bank, filter });");
    expect(fn).not.toMatch(/scraptfWindow|loadURL|reload|links\.open/);
    expect(MAIN).toContain('showBankStock: (bank, filter) => showBankStock(rt, bank, filter),');
  });

  it("keeps 'ui.openBankStock' among the pushes main owns (a service copy is ignored)", () => {
    const push = block('function handlePush(');
    const owned = push.slice(push.indexOf("case 'settings.changed':"), push.indexOf('default:'));
    expect(owned).toContain("case 'ui.openBankStock':");
  });
});
