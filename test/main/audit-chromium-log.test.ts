import * as real from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  CHROMIUM_LOG_MAX_BYTES,
  CHROMIUM_LOG_NAME,
  parseLaunchArgs,
  prepareChromiumLog,
  resolveAppPaths,
  type ChromiumLogFs,
} from '../../src/main/paths';

// 0.7.4 (F54): Chromium's own log lines go to logs/chromium.log, which Chromium only appends to; main bounds it at
// each start (over 1 MB: moved to chromium.log.old, or emptied) before it hands Chromium the path.

const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit-chromium-log-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const errno = (message: string, code: string) => Object.assign(new Error(message), { code });

function caseDir(): string {
  return path.join(mkdtempSync(path.join(root, 'case-')), 'logs');
}

function realFs(over: Partial<ChromiumLogFs> = {}): ChromiumLogFs {
  return {
    mkdirSync: over.mkdirSync ?? real.mkdirSync,
    statSync: over.statSync ?? real.statSync,
    renameSync: over.renameSync ?? real.renameSync,
    truncateSync: over.truncateSync ?? real.truncateSync,
  };
}

describe('prepareChromiumLog', () => {
  it('creates the logs folder and leaves a missing file to Chromium', () => {
    const dir = caseDir();
    expect(prepareChromiumLog(dir)).toEqual({ ok: true, file: path.join(dir, 'chromium.log'), rotated: null });
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(existsSync(path.join(dir, CHROMIUM_LOG_NAME))).toBe(false);
  });

  it('keeps a file up to the limit as it is (1 MB by default)', () => {
    expect(CHROMIUM_LOG_MAX_BYTES).toBe(1024 * 1024);
    const dir = caseDir();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, CHROMIUM_LOG_NAME);
    writeFileSync(file, 'x'.repeat(100));
    expect(prepareChromiumLog(dir, undefined, 100)).toEqual({ ok: true, file, rotated: null });
    expect(readFileSync(file, 'utf8')).toHaveLength(100);
    expect(existsSync(`${file}.old`)).toBe(false);
  });

  it('moves a file over the limit to chromium.log.old, replacing the one before', () => {
    const dir = caseDir();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, CHROMIUM_LOG_NAME);
    writeFileSync(`${file}.old`, 'older run');
    writeFileSync(file, 'y'.repeat(101));
    expect(prepareChromiumLog(dir, undefined, 100)).toEqual({ ok: true, file, rotated: 'moved' });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.old`, 'utf8')).toBe('y'.repeat(101));
  });

  it('empties the file when it cannot be moved (held open, or the .old is)', () => {
    const dir = caseDir();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, CHROMIUM_LOG_NAME);
    writeFileSync(file, 'z'.repeat(500));
    const renameSync = vi.fn(() => {
      throw errno('EBUSY: resource busy or locked', 'EBUSY');
    });
    expect(prepareChromiumLog(dir, realFs({ renameSync }), 100)).toEqual({ ok: true, file, rotated: 'emptied' });
    expect(renameSync).toHaveBeenCalledWith(file, `${file}.old`);
    expect(statSync(file).size).toBe(0);
  });

  it('is not ok when the file can be neither moved nor emptied, so main leaves the log off', () => {
    const dir = caseDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, CHROMIUM_LOG_NAME), 'z'.repeat(500));
    const fsImpl = realFs({
      renameSync: () => {
        throw errno('EPERM', 'EPERM');
      },
      truncateSync: () => {
        throw errno('EACCES', 'EACCES');
      },
    });
    const r = prepareChromiumLog(dir, fsImpl, 100);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toBe('chromium.log is over its size limit and could be neither moved nor emptied (EACCES)');
  });

  it('is not ok when the folder cannot be made or the file cannot be checked', () => {
    const noDir = realFs({
      mkdirSync: () => {
        throw errno('EACCES', 'EACCES');
      },
    });
    expect(prepareChromiumLog(caseDir(), noDir)).toEqual({ ok: false, reason: 'the logs folder could not be created (EACCES)' });

    const noStat = realFs({
      statSync: () => {
        throw errno('EPERM', 'EPERM');
      },
    });
    expect(prepareChromiumLog(caseDir(), noStat)).toEqual({ ok: false, reason: 'chromium.log could not be checked (EPERM)' });

    const odd = realFs({
      statSync: () => {
        throw new Error('no code');
      },
    });
    expect(prepareChromiumLog(caseDir(), odd)).toEqual({ ok: false, reason: 'chromium.log could not be checked (unknown error)' });

    const dir = caseDir();
    mkdirSync(path.join(dir, CHROMIUM_LOG_NAME), { recursive: true });
    expect(prepareChromiumLog(dir)).toEqual({ ok: false, reason: 'chromium.log is not a file' });
  });

  it("uses the same logs folder as main.log, the --user-data-dir profile's when one is given", () => {
    const app = path.resolve(os.tmpdir(), 'resources', 'app.asar');
    const args = parseLaunchArgs(['electron', '.', '--user-data-dir=profile-x'], path.join(root, 'cwd'));
    const p = resolveAppPaths(app, args.userDataDir!);
    const r = prepareChromiumLog(p.logDir);
    expect(r).toEqual({ ok: true, file: path.join(path.dirname(p.mainLog), 'chromium.log'), rotated: null });
    expect(path.dirname(p.mainLog)).toBe(path.join(root, 'cwd', 'profile-x', 'logs'));
  });
});

describe('main.ts wiring', () => {
  const main = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8');

  it('hands Chromium the bounded file before ready, in bootstrap (instance lock held), only when it is ok', () => {
    const boot = main.indexOf('function bootstrap(): void {');
    const ready = main.indexOf('.whenReady()', boot);
    const setup = main.indexOf('const chromiumLog = prepareChromiumLog(resolveAppPaths(app.getAppPath(), app.getPath(\'userData\')).logDir);');
    expect(boot).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(boot);
    expect(setup).toBeLessThan(ready);
    // After the profile switch to --user-data-dir, so it is that profile's logs folder.
    expect(setup).toBeGreaterThan(main.indexOf("app.setPath('userData', args.userDataDir);"));
    const okBranch = main.indexOf('if (chromiumLog.ok) {', setup);
    expect(okBranch).toBeGreaterThan(setup);
    for (const sw of ["appendSwitch('enable-logging', 'file');", "appendSwitch('log-file', chromiumLog.file);", "appendSwitch('log-level', '2');"]) {
      expect(main.indexOf(sw)).toBeGreaterThan(okBranch);
      expect(main.indexOf(sw)).toBeLessThan(main.indexOf('} else {', okBranch));
    }
    // A developer's own logging choice wins.
    expect(main).toContain("if (!app.commandLine.hasSwitch('enable-logging') && process.env['ELECTRON_ENABLE_LOGGING'] === undefined) {");
  });
});
