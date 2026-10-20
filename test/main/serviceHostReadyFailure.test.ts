// 0.7.2: a service that could not open its database (a newer copy's data) still answers, so the host
// treats it as ready, but main.log must not say a bare "service ready" after "service cannot start".
// The 'ready' message carries the reason in an optional `failure`; an older service's bare ready, and
// a malformed `failure`, still read as a normal start.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServiceHost, type ServiceProcessLike } from '../../src/main/serviceHost';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { FromService, ToService } from '../../src/shared/rpc';

const REASON = 'Database schema version 11 is newer than this app supports (10). Update the app or use a different data folder.';

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
  let proc: FakeProc | null = null;
  const host = createServiceHost({
    fork: () => (proc = new FakeProc()),
    init: () => ({ dataDir: '/data', version: '0.7.1', settings: DEFAULT_SETTINGS, secrets: {} }),
    log,
    now: () => Date.now(),
  });
  host.start();
  proc!.emit('spawn');
  const lines = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => String(c[0]));
  return { host, log, proc: proc!, info: () => lines(log.info), warn: () => lines(log.warn) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("service host: the 'ready' message", () => {
  it('logs one warning with the reason, not "service ready", when the service runs without its database', async () => {
    const h = setup();
    h.proc.emit('message', { type: 'ready', failure: REASON } satisfies FromService);
    expect(h.warn()).toEqual([`service started without its database: ${REASON}`]);
    expect(h.info()).not.toContain('service ready');
    // Still ready: the calls go through and come back with the reason (the dashboard shows it).
    expect(h.host.status().state).toBe('ready');
    await expect(h.host.whenReady(10)).resolves.toBe(true);
    const call = h.host.call('status.get', undefined);
    const rpc = h.proc.sent.find((m): m is Extract<ToService, { type: 'rpc' }> => m.type === 'rpc')!;
    h.proc.emit('message', { type: 'rpc-result', id: rpc.id, ok: false, error: REASON } satisfies FromService);
    await expect(call).rejects.toThrow(REASON);
  });

  it('logs "service ready" for a bare ready (a normal start, or an older service)', () => {
    const h = setup();
    h.proc.emit('message', { type: 'ready' } satisfies FromService);
    expect(h.info()).toContain('service ready');
    expect(h.warn()).toEqual([]);
    expect(h.host.status().state).toBe('ready');
  });

  it('keeps the ready when `failure` is malformed or empty, and logs a normal start', () => {
    for (const failure of [42, null, { why: 'x' }, '']) {
      const h = setup();
      h.proc.emit('message', { type: 'ready', failure });
      expect(h.host.status().state).toBe('ready');
      expect(h.info()).toContain('service ready');
      expect(h.warn()).toEqual([]);
    }
  });

  it('clips a very long reason', () => {
    const h = setup();
    h.proc.emit('message', { type: 'ready', failure: 'x'.repeat(5_000) });
    const [line] = h.warn();
    expect(line!.length).toBeLessThan(600);
    expect(line!.startsWith('service started without its database: xxx')).toBe(true);
  });
});
