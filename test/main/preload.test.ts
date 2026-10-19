import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { WINDOW_KIND_ARG } from '../../src/main/paths';
import type { FlipdeskBridge } from '../../src/shared/rpc';

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  pushListener: null as null | ((event: unknown, ...args: unknown[]) => void),
  invoke: null as unknown as Mock<(...args: unknown[]) => Promise<unknown>>,
}));

vi.mock('electron', () => {
  electron.invoke = vi.fn();
  return {
    contextBridge: {
      exposeInMainWorld: (key: string, api: unknown) => electron.exposed.set(key, api),
    },
    ipcRenderer: {
      invoke: (...args: unknown[]) => electron.invoke(...args),
      on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
        if (channel === 'push') electron.pushListener = fn;
      },
    },
  };
});

async function load(argv: string[] = ['electron', `${WINDOW_KIND_ARG}dashboard`]) {
  vi.resetModules();
  electron.exposed.clear();
  electron.pushListener = null;
  const saved = process.argv;
  process.argv = argv;
  try {
    const mod = await import('../../src/main/preload');
    return { mod, bridge: electron.exposed.get('flipdesk') as FlipdeskBridge };
  } finally {
    process.argv = saved;
  }
}

beforeEach(() => {
  electron.invoke?.mockReset?.();
});

describe('preload bridge', () => {
  it('exposes only window.flipdesk with rpc, on and windowKind', async () => {
    const { bridge } = await load();
    expect([...electron.exposed.keys()]).toEqual(['flipdesk']);
    expect(Object.keys(bridge).sort()).toEqual(['on', 'rpc', 'windowKind']);
    expect(bridge.windowKind).toBe('dashboard');
    expect(JSON.stringify(Object.keys(bridge))).not.toContain('ipcRenderer');
  });

  it('reads the window kind from additionalArguments', async () => {
    expect((await load(['x', `${WINDOW_KIND_ARG}quick-entry`])).bridge.windowKind).toBe('quick-entry');
    expect((await load(['x', `${WINDOW_KIND_ARG}evil`])).bridge.windowKind).toBe('dashboard');
    expect((await load(['x'])).bridge.windowKind).toBe('dashboard');
  });

  it('rejects unknown methods without touching IPC', async () => {
    const { bridge } = await load();
    const rpc = bridge.rpc as (m: unknown, p?: unknown) => Promise<unknown>;
    await expect(rpc('shell.openExternal', { url: 'x' })).rejects.toThrow('Unknown method: shell.openExternal');
    await expect(rpc(42)).rejects.toThrow('Unknown method');
    await expect(rpc('__proto__')).rejects.toThrow('Unknown method');
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('invokes the rpc channel and unwraps the envelope', async () => {
    const { bridge } = await load();
    electron.invoke.mockResolvedValueOnce({ ok: true, result: { counts: 1 } });
    await expect(bridge.rpc('status.get', undefined)).resolves.toEqual({ counts: 1 });
    expect(electron.invoke).toHaveBeenCalledWith('rpc', 'status.get', undefined);

    electron.invoke.mockResolvedValueOnce({ ok: false, error: 'No such price' });
    await expect(bridge.rpc('prices.delete', { id: 3 })).rejects.toThrow(/^No such price$/);

    electron.invoke.mockResolvedValueOnce('garbage');
    await expect(bridge.rpc('status.get', undefined)).rejects.toThrow('Malformed response');
  });

  it("cleans Electron's prefix from thrown IPC errors", async () => {
    const { bridge } = await load();
    electron.invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'rpc': Error: Untrusted sender"));
    await expect(bridge.rpc('settings.get', undefined)).rejects.toThrow(/^Untrusted sender$/);
  });

  it('dispatches push events to subscribers and unsubscribes', async () => {
    const { bridge } = await load();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bridge.on('opps.changed', a);
    bridge.on('status.changed', b);
    electron.pushListener!({ sender: 'ipc-event' }, 'opps.changed', { appeared: 1 });
    electron.pushListener!({}, 'status.changed', { version: 'x' });
    electron.pushListener!({}, 'unknown', {});
    electron.pushListener!({}, 42, {});
    offA();
    electron.pushListener!({}, 'opps.changed', { appeared: 2 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith({ appeared: 1 });
    expect(b).toHaveBeenCalledWith({ version: 'x' });
  });

  it('accepts the Live market push (market.changed) and allows market.list', async () => {
    const { bridge } = await load();
    const l = vi.fn();
    bridge.on('market.changed', l);
    electron.pushListener!({}, 'market.changed', { changed: 3, total: 120, at: 1 });
    expect(l).toHaveBeenCalledWith({ changed: 3, total: 120, at: 1 });
    electron.invoke.mockResolvedValueOnce({ ok: true, result: { rows: [] } });
    await expect(bridge.rpc('market.list', {})).resolves.toEqual({ rows: [] });
  });

  it('accepts the journal push (journal.changed) and allows holdings.list', async () => {
    const { bridge } = await load();
    const l = vi.fn();
    bridge.on('journal.changed', l);
    electron.pushListener!({}, 'journal.changed', { at: 5 });
    expect(l).toHaveBeenCalledWith({ at: 5 });
    electron.invoke.mockResolvedValueOnce({ ok: true, result: { rows: [] } });
    await expect(bridge.rpc('holdings.list', {})).resolves.toEqual({ rows: [] });
  });

  it('accepts the scrap.tf price list push (scraptf.listChanged) and allows scraptf.listStatus (F14)', async () => {
    const { bridge } = await load();
    const l = vi.fn();
    bridge.on('scraptf.listChanged', l);
    electron.pushListener!({}, 'scraptf.listChanged', { at: 7, items: 2341 });
    expect(l).toHaveBeenCalledWith({ at: 7, items: 2341 });
    electron.invoke.mockResolvedValueOnce({ ok: true, result: { items: 2341 } });
    await expect(bridge.rpc('scraptf.listStatus', undefined)).resolves.toEqual({ items: 2341 });
  });

  it('accepts the banks push (scraptf.banksChanged) and allows scraptf.banks (F15)', async () => {
    const { bridge } = await load();
    const l = vi.fn();
    bridge.on('scraptf.banksChanged', l);
    electron.pushListener!({}, 'scraptf.banksChanged', { at: 9 });
    expect(l).toHaveBeenCalledWith({ at: 9 });
    electron.invoke.mockResolvedValueOnce({ ok: true, result: { banks: [] } });
    await expect(bridge.rpc('scraptf.banks', undefined)).resolves.toEqual({ banks: [] });
  });

  it('never hands the IPC event object to listeners', async () => {
    const { bridge } = await load();
    const l = vi.fn();
    bridge.on('notify', l);
    electron.pushListener!({ sender: { secret: true } }, 'notify', { title: 't', body: 'b', sku: null });
    expect(l.mock.calls[0]).toEqual([{ title: 't', body: 'b', sku: null }]);
  });

  it('isolates listener errors', async () => {
    const { bridge } = await load();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = vi.fn();
    bridge.on('import.done', () => {
      throw new Error('ui bug');
    });
    bridge.on('import.done', good);
    electron.pushListener!({}, 'import.done', {});
    expect(good).toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses unknown events and non-function listeners', async () => {
    const { bridge } = await load();
    const on = bridge.on as (e: unknown, l: unknown) => () => void;
    expect(() => on('evil', () => undefined)).toThrow('Unknown event');
    expect(() => on('notify', 'not a function')).toThrow('listener must be a function');
  });
});

describe('preload helpers', () => {
  it('windowKindFromArgv and cleanIpcError', async () => {
    const { mod } = await load();
    expect(mod.windowKindFromArgv([`${WINDOW_KIND_ARG}quick-entry`])).toBe('quick-entry');
    expect(mod.cleanIpcError(new Error("Error invoking remote method 'rpc': TypeError: x")).message).toBe('x');
    expect(mod.cleanIpcError('plain').message).toBe('plain');
    expect(() => mod.unwrapEnvelope({ ok: false })).toThrow('Request failed');
    expect(mod.unwrapEnvelope({ ok: true, result: null })).toBeNull();
  });
});

describe('held one-shot pushes', () => {
  it('delivers a ui.quickPrefill that arrived before the quick-entry page subscribed, once', async () => {
    const { bridge } = await load(['x', `${WINDOW_KIND_ARG}quick-entry`]);
    electron.pushListener!({}, 'ui.quickPrefill', { sku: '378;6' });
    electron.pushListener!({}, 'ui.quickPrefill', { sku: '5021;6' });
    const first = vi.fn();
    bridge.on('ui.quickPrefill', first);
    await Promise.resolve();
    expect(first.mock.calls).toEqual([[{ sku: '5021;6' }]]);
    const second = vi.fn();
    bridge.on('ui.quickPrefill', second);
    await Promise.resolve();
    expect(second).not.toHaveBeenCalled();
  });

  it('does not hold ordinary pushes for late subscribers', async () => {
    const { bridge } = await load();
    electron.pushListener!({}, 'opps.changed', { appeared: 1 });
    const l = vi.fn();
    bridge.on('opps.changed', l);
    await Promise.resolve();
    expect(l).not.toHaveBeenCalled();
  });
});
