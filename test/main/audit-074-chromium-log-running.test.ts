import * as real from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CHROMIUM_LOG_CHECK_MS, CHROMIUM_LOG_MAX_BYTES, CHROMIUM_LOG_NAME, boundChromiumLogWhileRunning } from '../../src/main/paths';

// 0.7.4 trading accuracy audit, package G2 (review R37): chromium.log was bounded only at start (F54), while the
// app runs in the tray for days. main now also checks its size while running, at most every
// CHROMIUM_LOG_CHECK_MS, on the status pushes it already handles (no timer of its own, nothing of the scrap.tf
// window): over 1 MB it is emptied in place (Chromium holds it open, so it is not moved).

const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit-chromium-running-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function logFile(bytes: number): string {
  const dir = mkdtempSync(path.join(root, 'case-'));
  const file = path.join(dir, CHROMIUM_LOG_NAME);
  writeFileSync(file, 'x'.repeat(bytes));
  return file;
}

describe('boundChromiumLogWhileRunning', () => {
  it('empties a file over the limit in place; the path stays', () => {
    const file = logFile(101);
    expect(boundChromiumLogWhileRunning(file, undefined, 100)).toBe('emptied');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBe(0);
    expect(existsSync(`${file}.old`)).toBe(false);
  });

  it('leaves a file up to the limit alone (1 MB by default)', () => {
    expect(CHROMIUM_LOG_MAX_BYTES).toBe(1024 * 1024);
    const file = logFile(100);
    expect(boundChromiumLogWhileRunning(file, undefined, 100)).toBeNull();
    expect(readFileSync(file, 'utf8')).toHaveLength(100);
    expect(boundChromiumLogWhileRunning(logFile(5_000))).toBeNull();
  });

  it('swallows a missing file, a folder, and stat or truncate errors', () => {
    expect(boundChromiumLogWhileRunning(path.join(root, 'nope', CHROMIUM_LOG_NAME))).toBeNull();
    expect(boundChromiumLogWhileRunning(root, undefined, 0)).toBeNull();
    const file = logFile(500);
    const truncateSync = vi.fn(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });
    expect(boundChromiumLogWhileRunning(file, { statSync: real.statSync, truncateSync }, 100)).toBeNull();
    expect(truncateSync).toHaveBeenCalledWith(file, 0);
    const statSyncFail = vi.fn(() => {
      throw new Error('EPERM');
    });
    expect(boundChromiumLogWhileRunning(file, { statSync: statSyncFail, truncateSync: real.truncateSync }, 100)).toBeNull();
    expect(statSync(file).size).toBe(500);
  });
});

describe('main.ts wiring', () => {
  const main = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8');

  it('checks at most every 10 min, only for the file bootstrap handed Chromium', () => {
    expect(CHROMIUM_LOG_CHECK_MS).toBe(10 * 60_000);
    const okBranch = main.indexOf('if (chromiumLog.ok) {');
    const handed = main.indexOf('chromiumLogFile = chromiumLog.file;');
    expect(handed).toBeGreaterThan(okBranch);
    expect(handed).toBeLessThan(main.indexOf('} else {', okBranch));
    const fn = main.slice(main.indexOf('function boundChromiumLog('), main.indexOf('function writeReport('));
    expect(fn).toContain('if (chromiumLogFile === null) return;');
    expect(fn).toContain('now - chromiumLogCheckedAt < CHROMIUM_LOG_CHECK_MS');
    expect(fn).toContain('boundChromiumLogWhileRunning(chromiumLogFile)');
    // Logging only: no timer, nothing of the scrap.tf window.
    expect(fn).not.toMatch(/setTimeout|setInterval|scraptf/i);
  });

  it("runs on the status pushes main already handles, not from a timer of its own", () => {
    const status = main.slice(main.indexOf("case 'status.changed':"), main.indexOf("case 'notify':"));
    expect(status).toContain('boundChromiumLog();');
    expect([...main.matchAll(/\bboundChromiumLog\(\)/g)]).toHaveLength(1);
    expect(main).not.toMatch(/set(?:Interval|Timeout)\([^)]*boundChromiumLog/);
  });
});
