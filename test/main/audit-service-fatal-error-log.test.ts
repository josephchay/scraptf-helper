// 0.7.3 (audit mainshell-6): Electron's UtilityProcess 'error' event passes (type, location, report). main.log
// must name the location as the location, and keep a few fields of the Node diagnostic report (the event, the
// JS stack, the heap), never the raw report: it holds the environment variables, among much else.

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createMainLog, createServiceHost, summariseFatalReport, type ServiceProcessLike } from '../../src/main/serviceHost';
import type { Logger } from '../../src/service/contracts';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

const LOCATION = 'CALL_AND_RETRY_LAST Allocation failed';
const SECRET = 'hunter2-should-not-appear';
const REPORT = JSON.stringify({
  header: { event: 'Allocation failed - JavaScript heap out of memory', trigger: 'OOMError', nodejsVersion: 'v24.1.0', cwd: '/home/someone', commandLine: ['x'] },
  javascriptStack: { message: 'boom', stack: ['at a', 'at b'] },
  javascriptHeap: { totalMemory: 1, usedMemory: 2 },
  environmentVariables: { SECRET_ENV: SECRET },
  sharedObjects: ['/usr/lib/x.so'],
});

class FakeProc extends EventEmitter implements ServiceProcessLike {
  readonly pid = 4520;
  stdout = new PassThrough();
  stderr = new PassThrough();
  postMessage(): void {}
  kill(): boolean {
    this.emit('exit', 1);
    return true;
  }
}

function setup(log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) {
  let proc: FakeProc | null = null;
  const host = createServiceHost({
    fork: () => (proc = new FakeProc()),
    init: () => ({ dataDir: '/data', version: '0.7.3', settings: DEFAULT_SETTINGS, secrets: {} }),
    log,
    minBackoffMs: 60_000,
    now: () => Date.now(),
  });
  host.start();
  proc!.emit('spawn');
  return { host, log, proc: proc! };
}

function errorMeta(log: Logger, msg: string): Record<string, unknown> {
  const call = vi.mocked(log.error).mock.calls.find(([m]) => m === msg);
  expect(call, msg).toBeDefined();
  return call![1] as Record<string, unknown>;
}

describe("the service process's fatal error", () => {
  it('logs the location as the location and a few fields of the report, never its environment', () => {
    const h = setup();
    h.proc.emit('error', 'FatalError', LOCATION, REPORT);
    const meta = errorMeta(h.log, 'service process error: FatalError');
    expect(meta).toEqual({
      location: LOCATION,
      report: {
        event: 'Allocation failed - JavaScript heap out of memory',
        trigger: 'OOMError',
        nodejsVersion: 'v24.1.0',
        message: 'boom',
        stack: ['at a', 'at b'],
        totalMemory: 1,
        usedMemory: 2,
      },
    });
    const json = JSON.stringify(meta);
    for (const absent of [SECRET, 'environmentVariables', 'someone', 'sharedObjects']) expect(json).not.toContain(absent);
    expect(h.host.status().lastError).toBe('fatal error: FatalError');
  });

  it('logs only the location when the report is not JSON, or missing', () => {
    for (const report of ['not json', undefined, '', '[]', 'null']) {
      const h = setup();
      expect(() => h.proc.emit('error', 'FatalError', LOCATION, report)).not.toThrow();
      expect(errorMeta(h.log, 'service process error: FatalError'), String(report)).toEqual({ location: LOCATION });
    }
    const h = setup();
    h.proc.emit('error', 'FatalError');
    expect(errorMeta(h.log, 'service process error: FatalError')).toEqual({ location: '' });
  });

  it('writes no environment value to main.log', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flipdesk-fatal-'));
    try {
      const file = path.join(dir, 'main.log');
      const mainLog = createMainLog({ file });
      const h = setup(mainLog);
      h.proc.emit('error', 'FatalError', LOCATION, REPORT);
      mainLog.flushSync();
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(`"location":"${LOCATION}"`);
      expect(text).toContain('"trigger":"OOMError"');
      expect(text).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('summariseFatalReport', () => {
  it('is null for anything but a JSON object with a known field', () => {
    for (const r of [undefined, null, 42, '', 'x', '{}', '[1]', '"s"', JSON.stringify({ environmentVariables: { A: 'b' } })]) {
      expect(summariseFatalReport(r), String(r)).toBeNull();
    }
  });

  it('keeps ten stack frames at most, each cut short, and drops fields of the wrong type', () => {
    const stack = Array.from({ length: 50 }, (_, i) => `at frame${i} ${'x'.repeat(300)}`);
    const s = summariseFatalReport(JSON.stringify({ header: { event: 7, trigger: 'FatalError' }, javascriptStack: { message: 'm', stack: [...stack, 9] }, javascriptHeap: { totalMemory: '1', usedMemory: 2 } }));
    expect(s).not.toBeNull();
    expect(s!['stack']).toHaveLength(10);
    for (const f of s!['stack'] as string[]) expect(f.length).toBeLessThanOrEqual(203);
    expect(s).not.toHaveProperty('event');
    expect(s).not.toHaveProperty('totalMemory');
    expect(s).toMatchObject({ trigger: 'FatalError', message: 'm', usedMemory: 2 });
  });
});
