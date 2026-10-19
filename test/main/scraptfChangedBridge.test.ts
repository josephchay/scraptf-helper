// F20 bridge contract: 'scraptf.changed' is a service push the service host forwards and the preload
// delivers to a loaded page (not held for one still loading, like 'scraptf.banksChanged'), and the
// 'notify' payload may carry openUrl. What main does with openUrl on a click (allowlist, static bank
// URLs only, checked again at click time) is the main package's; the notification payload check lives
// in src/main/notify.ts. Nothing here touches the network.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_KIND_ARG } from '../../src/main/paths';
import { MAIN_ONLY_PUSH_EVENTS, SERVICE_PUSH_EVENTS, createServiceHost, type ServiceProcessLike } from '../../src/main/serviceHost';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { PUSH_EVENTS, type FlipdeskBridge, type PushContract } from '../../src/shared/rpc';

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
  pid = 101;
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

describe("'scraptf.changed'", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is a service push, never main-only', () => {
    expect(PUSH_EVENTS).toContain('scraptf.changed');
    expect(SERVICE_PUSH_EVENTS).toContain('scraptf.changed');
    expect(MAIN_ONLY_PUSH_EVENTS).not.toContain('scraptf.changed');
  });

  it('is forwarded by the service host with its payload', () => {
    const procs: FakeProc[] = [];
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const host = createServiceHost({
      fork: () => {
        const p = new FakeProc();
        procs.push(p);
        return p;
      },
      init: () => ({ dataDir: '/data', version: '0.7.0', settings: DEFAULT_SETTINGS, secrets: {} }),
      log,
      now: () => Date.now(),
    });
    host.start();
    const p = procs[0]!;
    p.emit('spawn');
    p.emit('message', { type: 'ready' });
    const seen: unknown[] = [];
    host.onPush((event, payload) => seen.push([event, payload]));
    const payload: PushContract['scraptf.changed'] = { at: 1_792_000_000_000, count: 7 };
    p.emit('message', { type: 'push', event: 'scraptf.changed', payload });
    expect(seen).toEqual([['scraptf.changed', payload]]);
    expect(log.warn).not.toHaveBeenCalled();
    void host.shutdown(0);
  });
});

describe('preload', () => {
  it("delivers 'scraptf.changed' to a subscribed page and holds none for a page still loading", async () => {
    const { mod, bridge } = await loadPreload('dashboard');
    expect(mod.HELD_EVENTS.has('scraptf.changed')).toBe(false);
    electron.pushListener!({}, 'scraptf.changed', { at: 1, count: 1 });
    const late = vi.fn();
    bridge.on('scraptf.changed', late);
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
    electron.pushListener!({}, 'scraptf.changed', { at: 2, count: 3 });
    expect(late.mock.calls).toEqual([[{ at: 2, count: 3 }]]);
  });
});

describe("the 'notify' payload", () => {
  it('may carry openUrl (a static bank page; main checks it on a click)', () => {
    const n: PushContract['notify'] = { title: 'Re-save scrap.tf/buy/hats', body: 'Last saved 1 h 05 m ago.', sku: null, openUrl: 'https://scrap.tf/buy/hats' };
    const plain: PushContract['notify'] = { title: 't', body: 'b', sku: '378;6' };
    expect([n.openUrl, plain.openUrl]).toEqual(['https://scrap.tf/buy/hats', undefined]);
  });
});
