// One running copy per machine, whatever its user data directory.
// app.requestSingleInstanceLock() is keyed by userData, so `--user-data-dir`
// (ours or Chromium's own switch) or a second Windows account would start a
// second service with its own backpack.tf websocket and its own in-memory
// budgets, while §2.0 allows exactly one feed connection per IP. This lock is a
// named pipe: the namespace is machine-wide and Windows frees the pipe when
// the process dies, so a crash never leaves a stale lock.

import net from 'node:net';
import type { Logger } from '../service/contracts';

export interface MachineLock {
  /** Frees the lock (only needed in tests; the OS frees it on exit). */
  release(): void;
}

export interface MachineLockOptions {
  platform?: NodeJS.Platform;
  /** Injected for tests. */
  createServer?: () => net.Server;
  log?: Pick<Logger, 'warn'>;
}

/** Where the lock lives: a named pipe on Windows, an abstract socket on Linux, nothing elsewhere. */
export function machineLockPath(name: string, platform: NodeJS.Platform = process.platform): string | null {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  if (platform === 'win32') return `\\\\.\\pipe\\${safe}`;
  if (platform === 'linux') return `\0${safe}`;
  return null;
}

/**
 * Resolves with the lock, or null when another process on this machine holds
 * it. An unexpected error (or a platform without a lock path) is logged and
 * yields a no-op lock: the per-userData lock still applies, and refusing to
 * start over a pipe error would leave the app unusable.
 */
export function acquireMachineLock(name: string, opts: MachineLockOptions = {}): Promise<MachineLock | null> {
  const where = machineLockPath(name, opts.platform);
  const noop: MachineLock = { release: () => undefined };
  if (where === null) return Promise.resolve(noop);
  return new Promise((resolve) => {
    const srv = opts.createServer ? opts.createServer() : net.createServer((c) => c.destroy());
    srv.maxConnections = 0;
    srv.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        resolve(null);
        return;
      }
      opts.log?.warn(`could not take the machine-wide instance lock (${err.code ?? err.message}); continuing without it`);
      resolve(noop);
    });
    srv.listen(where, () => {
      // Holding the pipe must not keep a test process (or a quitting app) alive.
      srv.unref();
      resolve({ release: () => srv.close() });
    });
  });
}
