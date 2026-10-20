import * as real from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { writeFileAtomicSync, type AtomicWriteFs } from '../../src/main/paths';

// Audit mainshell-4: a failed write, fsync or close must not leave its temp file behind.

const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit-atomic-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const errno = (message: string, code: string) => Object.assign(new Error(message), { code });

/** A fresh dir with `settings.json` = 'old', and a real-fs AtomicWriteFs with spies on close and unlink. */
function setup(overrides: Partial<AtomicWriteFs> = {}) {
  const dir = mkdtempSync(path.join(root, 'case-'));
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, 'old');
  const closeSync = vi.fn(overrides.closeSync ?? real.closeSync);
  const unlinkSync = vi.fn(overrides.unlinkSync ?? real.unlinkSync);
  const fsImpl: AtomicWriteFs = {
    mkdirSync: real.mkdirSync,
    openSync: real.openSync,
    writeSync: overrides.writeSync ?? ((fd, data) => real.writeSync(fd, data)),
    fsyncSync: overrides.fsyncSync ?? real.fsyncSync,
    closeSync,
    renameSync: real.renameSync,
    unlinkSync,
  };
  const temps = () => readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  return { dir, file, fsImpl, closeSync, unlinkSync, temps };
}

function thrown(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe('writeFileAtomicSync: cleanup when the temp file cannot be written', () => {
  it('removes the temp file when the write fails (disk full), closing it first', () => {
    const t = setup({
      writeSync: () => {
        throw errno('full', 'ENOSPC');
      },
    });
    const err = thrown(() => writeFileAtomicSync(t.file, 'new', t.fsImpl));
    expect((err as Error).message).toBe('full');
    expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(t.closeSync).toHaveBeenCalledTimes(1);
    expect(t.unlinkSync).toHaveBeenCalledTimes(1);
    expect(t.closeSync.mock.invocationCallOrder[0]!).toBeLessThan(t.unlinkSync.mock.invocationCallOrder[0]!);
    expect(t.temps()).toEqual([]);
    expect(readFileSync(t.file, 'utf8')).toBe('old');
  });

  it('removes the temp file when the fsync fails', () => {
    const t = setup({
      fsyncSync: () => {
        throw errno('io', 'EIO');
      },
    });
    expect(() => writeFileAtomicSync(t.file, 'new', t.fsImpl)).toThrow('io');
    expect(t.closeSync).toHaveBeenCalledTimes(1);
    expect(t.unlinkSync).toHaveBeenCalledTimes(1);
    expect(t.closeSync.mock.invocationCallOrder[0]!).toBeLessThan(t.unlinkSync.mock.invocationCallOrder[0]!);
    expect(t.temps()).toEqual([]);
    expect(readFileSync(t.file, 'utf8')).toBe('old');
  });

  it('removes the temp file when the close fails, without closing twice', () => {
    const t = setup({
      closeSync: (fd: number) => {
        real.closeSync(fd);
        throw errno('close', 'EIO');
      },
    });
    expect(() => writeFileAtomicSync(t.file, 'new', t.fsImpl)).toThrow('close');
    expect(t.closeSync).toHaveBeenCalledTimes(1);
    expect(t.unlinkSync).toHaveBeenCalledTimes(1);
    expect(t.temps()).toEqual([]);
    expect(readFileSync(t.file, 'utf8')).toBe('old');
  });

  it('rethrows the original error when the cleanup fails too', () => {
    const t = setup({
      writeSync: () => {
        throw errno('full', 'ENOSPC');
      },
      unlinkSync: () => {
        throw errno('denied', 'EPERM');
      },
    });
    const err = thrown(() => writeFileAtomicSync(t.file, 'new', t.fsImpl));
    expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(t.unlinkSync).toHaveBeenCalledTimes(1);
    // The unlink stub deleted nothing; clean up for the dir sweep.
    for (const f of t.temps()) real.unlinkSync(path.join(t.dir, f));
  });

  it('leaves no temp files after repeated failures', () => {
    const t = setup({
      writeSync: () => {
        throw errno('full', 'ENOSPC');
      },
    });
    for (let i = 0; i < 3; i++) expect(() => writeFileAtomicSync(t.file, `new ${i}`, t.fsImpl)).toThrow('full');
    expect(t.temps()).toEqual([]);
    expect(readFileSync(t.file, 'utf8')).toBe('old');
  });

  it('still writes the whole file through short writes', () => {
    const t = setup({ writeSync: (fd, data) => real.writeSync(fd, data.subarray(0, 2)) });
    writeFileAtomicSync(t.file, 'hello, world', t.fsImpl);
    expect(readFileSync(t.file, 'utf8')).toBe('hello, world');
    expect(t.closeSync).toHaveBeenCalledTimes(1);
    expect(t.unlinkSync).not.toHaveBeenCalled();
    expect(t.temps()).toEqual([]);
  });
});
