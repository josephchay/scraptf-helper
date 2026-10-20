// 0.7.3 (audit mainshell-2): a service that sent 'ready' without its database (a newer copy's data, or a
// file it cannot open) answers every call with the reason, so main never gets a status. The tray must say
// that this copy cannot open its data, not "Waiting for data..." forever, and never show the raw reason
// (it can be long or name a path). The host keeps the reason in its own field: lastError is the restart
// banner's detail and must stay clear.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServiceHost, serviceStatePush, type ServiceProcessLike } from '../../src/main/serviceHost';
import type { TrayState } from '../../src/main/tray';
import { readyMessage } from '../../src/service/entry';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { FromService, ToService } from '../../src/shared/rpc';
import type { AppStatus } from '../../src/shared/types';

vi.mock('electron', () => ({
  Tray: class {},
  Menu: { buildFromTemplate: (t: unknown) => ({ template: t }) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
}));

const { trayTooltip } = await import('../../src/main/tray');

const REASON = 'Database schema version 11 is newer than this app supports (10). Update the app or use a different data folder.';
const FAILURE_LINE = 'Cannot open its data: open the dashboard';

class FakeProc extends EventEmitter implements ServiceProcessLike {
  sent: ToService[] = [];
  readonly pid = 4520;
  stdout = new PassThrough();
  stderr = new PassThrough();
  postMessage(message: unknown): void {
    this.sent.push(structuredClone(message) as ToService);
  }
  kill(): boolean {
    this.emit('exit', 1);
    return true;
  }
}

function setup() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const procs: FakeProc[] = [];
  const host = createServiceHost({
    fork: () => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    },
    init: () => ({ dataDir: '/data', version: '0.7.3', settings: DEFAULT_SETTINGS, secrets: {} }),
    log,
    minBackoffMs: 10,
    maxBackoffMs: 10,
    now: () => Date.now(),
  });
  host.start();
  procs[0]!.emit('spawn');
  return { host, procs };
}

const status = (): AppStatus => ({
  version: '0.7.3',
  networkPaused: false,
  feed: 'live',
  keyPrice: null,
  counts: { opportunities: 12, profitable: 5, highConfidence: 2 },
  lastEngineRunAt: null,
  setupNeeded: ['bptf-token'],
});

const state = (over: Partial<TrayState> = {}): TrayState => ({
  liveFeedEnabled: true,
  networkPaused: false,
  status: null,
  service: { state: 'ready', nextRestartAt: null, failure: REASON },
  hotkey: { accelerator: '', registered: false, error: null },
  checkWatch: false,
  checkHotkey: { accelerator: '', registered: false, error: null },
  scraptfWindow: false,
  now: 0,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('service host: why a ready service runs without its database', () => {
  it("keeps the ready message's failure in its own field, not in lastError", () => {
    const h = setup();
    h.procs[0]!.emit('message', { type: 'ready', failure: REASON } satisfies FromService);
    expect(h.host.status()).toMatchObject({ state: 'ready', failure: REASON, lastError: null });
    // The banner's detail is lastError's: unchanged.
    expect(serviceStatePush(h.host.status(), Date.now())).toEqual({ state: 'ready', detail: null, nextAttemptAt: null });
  });

  it('is null for a bare ready, and for an empty or malformed failure', () => {
    for (const msg of [{ type: 'ready' }, { type: 'ready', failure: '' }, { type: 'ready', failure: 42 }, { type: 'ready', failure: null }]) {
      const h = setup();
      h.procs[0]!.emit('message', msg);
      expect(h.host.status().state, JSON.stringify(msg)).toBe('ready');
      expect(h.host.status().failure, JSON.stringify(msg)).toBeNull();
    }
  });

  it('is cleared when a new process starts', async () => {
    const h = setup();
    h.procs[0]!.emit('message', { type: 'ready', failure: REASON } satisfies FromService);
    h.procs[0]!.emit('exit', 1);
    expect(h.host.status().state).toBe('restarting');
    await vi.advanceTimersByTimeAsync(20);
    expect(h.procs).toHaveLength(2);
    expect(h.host.status().failure).toBeNull();
    h.procs[1]!.emit('spawn');
    h.procs[1]!.emit('message', { type: 'ready' } satisfies FromService);
    expect(h.host.status()).toMatchObject({ state: 'ready', failure: null });
    expect(serviceStatePush(h.host.status(), Date.now())?.detail).toBeNull();
  });
});

describe('tray tooltip for a service without its database', () => {
  it('says this copy cannot open its data, never the reason, never "Waiting for data..."', () => {
    const tip = trayTooltip(state());
    expect(tip).toBe(`TF2 Flip Desk\n${FAILURE_LINE}`);
    expect(tip).not.toContain('Waiting for data');
    expect(tip).not.toContain('schema');
  });

  it('shows it over a network pause, a paused feed and a stale status', () => {
    expect(trayTooltip(state({ networkPaused: true }))).toBe(`TF2 Flip Desk\n${FAILURE_LINE}`);
    expect(trayTooltip(state({ liveFeedEnabled: false }))).toBe(`TF2 Flip Desk\n${FAILURE_LINE}`);
    const stale = trayTooltip(state({ status: status() }));
    expect(stale).toBe(`TF2 Flip Desk\n${FAILURE_LINE}`);
    // The clipboard watcher's line is about the watcher, not the data: still shown.
    expect(trayTooltip(state({ checkWatch: true }))).toBe(`TF2 Flip Desk\n${FAILURE_LINE}\nClipboard check on`);
  });

  it('leaves every other state as it was', () => {
    expect(trayTooltip(state({ service: { state: 'ready', nextRestartAt: null, failure: null } }))).toBe('TF2 Flip Desk\nWaiting for data...');
    expect(trayTooltip(state({ service: { state: 'ready', nextRestartAt: null } }))).toBe('TF2 Flip Desk\nWaiting for data...');
    expect(trayTooltip(state({ service: { state: 'restarting', nextRestartAt: null, failure: REASON } }))).toBe('TF2 Flip Desk\nService restarting');
    expect(trayTooltip(state({ service: { state: 'starting', nextRestartAt: null, failure: REASON } }))).toBe('TF2 Flip Desk\nStarting...');
  });

  it('end to end: the service\'s ready message through the host to the tooltip', () => {
    const h = setup();
    h.procs[0]!.emit('message', readyMessage({ failure: REASON }));
    expect(trayTooltip(state({ service: h.host.status() }))).toBe(`TF2 Flip Desk\n${FAILURE_LINE}`);
  });
});
