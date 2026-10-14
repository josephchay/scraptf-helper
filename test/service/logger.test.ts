import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOG_MAX_FAILURES, LOG_RETRY_MS, createLogger, serviceLogPath } from '../../src/service/logger';
import { registerSecret, unregisterSecret } from '../../src/service/net';
import { cleanErrorMessage } from '../../src/service/entry';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-log-'));
  dirs.push(d);
  return path.join(d, 'data');
}

describe('service logger', () => {
  it('writes <dataDir>/../logs/service.log and forwards info and above to main', () => {
    const dataDir = tmp();
    const posted: { level: string; msg: string }[] = [];
    const log = createLogger({ dataDir, post: (m) => posted.push({ level: m.level, msg: m.msg }) });
    log.debug('detail');
    log.info('hello', { n: 1 });
    log.error('bad', new Error('broken'));
    log.flush();
    expect(log.file).toBe(path.join(path.dirname(dataDir), 'logs', 'service.log'));
    expect(serviceLogPath(dataDir)).toBe(log.file);
    const text = readFileSync(log.file, 'utf8');
    expect(text).toMatch(/DEBUG detail/);
    expect(text).toMatch(/INFO  hello \{"n":1\}/);
    expect(text).toMatch(/ERROR bad Error: broken/);
    expect(posted).toEqual([
      { level: 'info', msg: 'hello {"n":1}' },
      { level: 'error', msg: 'bad Error: broken' },
    ]);
  });

  it('redacts registered secrets and key=value secrets on every line', () => {
    const secret = 'bptf-token-abcdef0123456789';
    registerSecret(secret);
    try {
      const posted: string[] = [];
      const log = createLogger({ dataDir: tmp(), post: (m) => posted.push(m.msg) });
      log.warn(`request to https://api.backpack.tf/api/x?token=${secret} failed`, { header: secret });
      log.info('IGetPrices?key=someOtherKey123&raw=1');
      log.flush();
      const text = readFileSync(log.file, 'utf8');
      expect(text).not.toContain(secret);
      expect(posted.join('\n')).not.toContain(secret);
      expect(text).not.toContain('someOtherKey123');
      expect(text).toContain('REDACTED');
    } finally {
      unregisterSecret(secret);
    }
  });

  it('rotates at the size cap and keeps two old files', () => {
    const log = createLogger({ dataDir: tmp(), maxBytes: 2_000 });
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 20; i++) log.info(`round ${round} line ${i} ${'x'.repeat(40)}`);
      log.flush();
    }
    expect(existsSync(log.file)).toBe(true);
    expect(existsSync(`${log.file}.1`)).toBe(true);
    expect(existsSync(`${log.file}.2`)).toBe(true);
    expect(existsSync(`${log.file}.3`)).toBe(false);
    expect(readFileSync(log.file, 'utf8')).toContain('round 5');
  });

  it('keeps trying after a cooldown when the log folder was unwritable for a while', () => {
    const dataDir = tmp();
    // A regular file where the logs folder should be makes every write fail.
    const blocker = path.join(path.dirname(dataDir), 'logs');
    writeFileSync(blocker, 'not a folder');
    let t = Date.parse('2026-10-14T12:00:00.000Z');
    const log = createLogger({ dataDir, now: () => new Date(t) });
    for (let i = 0; i < LOG_MAX_FAILURES + 5; i++) {
      log.info(`lost ${i}`);
      log.flush();
    }
    rmSync(blocker, { force: true });
    log.info('too soon');
    log.flush();
    expect(existsSync(log.file)).toBe(false); // cooling down, buffer dropped (memory stays bounded)
    t += LOG_RETRY_MS + 1_000;
    log.info('back again');
    log.flush();
    const text = readFileSync(log.file, 'utf8');
    expect(text).toContain('back again');
    expect(text).toMatch(/\[\d+ log lines dropped: the log folder was not writable\]/);
    expect(text).not.toContain('lost 0');
  });
});

describe('cleanErrorMessage', () => {
  it('drops stacks, local paths and secrets from RPC errors', () => {
    const err = new Error('ENOENT: no such file, open C:\\Users\\me\\AppData\\x.sqlite');
    err.stack = `${err.message}\n    at foo (C:\\app\\dist\\service.cjs:1:2)`;
    expect(cleanErrorMessage(err)).toBe('ENOENT: no such file, open <path>');
    expect(cleanErrorMessage(new Error('bad /home/me/.config/x.json here'))).toBe('bad <path> here');
    expect(cleanErrorMessage(new Error('Invalid parameters for prices.upsert: sku: not a SKU'))).toBe(
      'Invalid parameters for prices.upsert: sku: not a SKU',
    );
    expect(cleanErrorMessage('x?key=abcdef123456')).toBe('x?key=REDACTED');
    expect(cleanErrorMessage(undefined)).toBe('Request failed');
  });
});
