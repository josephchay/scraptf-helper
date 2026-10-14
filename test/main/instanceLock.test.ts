import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { acquireMachineLock, machineLockPath } from '../../src/main/instanceLock';

/** A net.Server double whose listen() fails with `code`, or succeeds when code is null. */
function fakeServer(code: string | null) {
  const srv = new EventEmitter() as EventEmitter & { maxConnections: number; listen: unknown; unref: unknown; close: unknown };
  srv.maxConnections = 10;
  srv.listen = vi.fn((_path: string, cb: () => void) => {
    setImmediate(() => (code ? srv.emit('error', Object.assign(new Error(code), { code })) : cb()));
    return srv;
  });
  srv.unref = vi.fn(() => srv);
  srv.close = vi.fn(() => srv);
  return srv as unknown as net.Server & { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

describe('machineLockPath', () => {
  it('uses a machine-wide named pipe on Windows and an abstract socket on Linux', () => {
    expect(machineLockPath('io.github.tf2flipdesk.app.instance', 'win32')).toBe('\\\\.\\pipe\\io.github.tf2flipdesk.app.instance');
    expect(machineLockPath('io.github.tf2flipdesk.app.instance', 'linux')).toBe('\0io.github.tf2flipdesk.app.instance');
    expect(machineLockPath('a b/c', 'win32')).toBe('\\\\.\\pipe\\a_b_c');
    expect(machineLockPath('x', 'darwin')).toBeNull();
  });
});

describe('acquireMachineLock', () => {
  it('returns null when another process already holds the pipe', async () => {
    for (const code of ['EADDRINUSE', 'EACCES']) {
      const srv = fakeServer(code);
      await expect(acquireMachineLock('lock', { platform: 'win32', createServer: () => srv })).resolves.toBeNull();
      expect(srv.listen).toHaveBeenCalledWith('\\\\.\\pipe\\lock', expect.any(Function));
    }
  });

  it('holds the pipe, refuses connections and can release it', async () => {
    const srv = fakeServer(null);
    const lock = await acquireMachineLock('lock', { platform: 'win32', createServer: () => srv });
    expect(lock).not.toBeNull();
    expect(srv.maxConnections).toBe(0);
    lock!.release();
    expect(srv.close).toHaveBeenCalled();
  });

  it('starts anyway (with a warning) on an unexpected error or a platform without a lock', async () => {
    const warn = vi.fn();
    await expect(acquireMachineLock('lock', { platform: 'win32', createServer: () => fakeServer('EIO'), log: { warn } })).resolves.not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EIO'));
    const create = vi.fn();
    await expect(acquireMachineLock('lock', { platform: 'darwin', createServer: create })).resolves.not.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32' || process.platform === 'linux')(
    'lets exactly one holder take the real lock until it is released',
    async () => {
      const name = `flipdesk-test-${process.pid}-${Date.now()}`;
      const first = await acquireMachineLock(name);
      expect(first).not.toBeNull();
      await expect(acquireMachineLock(name)).resolves.toBeNull();
      first!.release();
      await new Promise((r) => setTimeout(r, 50));
      const again = await acquireMachineLock(name);
      expect(again).not.toBeNull();
      again!.release();
    },
  );
});
