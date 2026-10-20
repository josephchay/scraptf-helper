// 0.7.3: core.stop() writes the buffered service log before it returns. Before, its last line
// ('service stopped') sat in the logger's 250 ms buffer, so a caller that deleted the data folder
// right after stop() saw the late flush recreate <root>/logs/service.log (tests leaked temp
// folders). The failed core (a database from a newer app) flushes on stop too. Temp dirs only;
// the network is never reached.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { SCHEMA_VERSION } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { FakeSocket } from '../bptf/helpers';

/** More than the logger's FLUSH_DELAY_MS (250 ms). */
const PAST_FLUSH_MS = 400;

const noFetch = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const temps: string[] = [];
const cores: ServiceCore[] = [];

afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const settings = mergeSettings(DEFAULT_SETTINGS, {
  contactUrl: 'https://github.com/flipdesk-test',
  networkPaused: true,
  liveFeed: { enabled: false },
  connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
});

function tempRoot(): { root: string; dataDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit-stopflush-'));
  temps.push(root);
  return { root, dataDir: path.join(root, 'data') };
}

function makeCore(dataDir: string, log: Parameters<typeof createServiceCore>[0]['log']): ServiceCore {
  const core = createServiceCore({
    dataDir,
    version: '0.7.3',
    settings,
    secrets: {},
    log,
    fetchImpl: noFetch,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
  });
  cores.push(core);
  return core;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('core.stop() and the buffered service log', () => {
  it("writes 'service stopped' before stop() resolves, so deleting the folder after stop leaves nothing behind", async () => {
    const { root, dataDir } = tempRoot();
    const logger = createLogger({ dataDir });
    const core = makeCore(dataDir, logger);
    await core.start();
    await core.stop();
    cores.length = 0;

    // No manual logger.flush(): stop() must have written the whole session.
    expect(readFileSync(logger.file, 'utf8')).toContain('service stopped');

    resetBptfSocketGuard();
    rmSync(root, { recursive: true, force: true });
    await wait(PAST_FLUSH_MS);
    expect(existsSync(root)).toBe(false);
  });

  it('stops without throwing when the logger has no flush()', async () => {
    const { dataDir } = tempRoot();
    const lines: string[] = [];
    const log = {
      debug: () => undefined,
      info: (m: string) => void lines.push(m),
      warn: () => undefined,
      error: () => undefined,
    };
    const core = makeCore(dataDir, log);
    await core.start();
    await expect(core.stop()).resolves.toBeUndefined();
    cores.length = 0;
    expect(lines).toContain('service stopped');
  });

  it("a core that could not open its database writes 'service cannot start' on stop", async () => {
    const { root, dataDir } = tempRoot();
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'flipdesk.sqlite'));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    const logger = createLogger({ dataDir });
    const core = makeCore(dataDir, logger);
    expect(core.failure).toBeTruthy();
    await core.stop();
    cores.length = 0;

    expect(readFileSync(logger.file, 'utf8')).toContain('service cannot start');

    rmSync(root, { recursive: true, force: true });
    await wait(PAST_FLUSH_MS);
    expect(existsSync(root)).toBe(false);
  });
});
