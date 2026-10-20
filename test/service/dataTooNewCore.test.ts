// 0.7.2: a data folder a newer copy of the app already updated (database user_version above this
// copy's SCHEMA_VERSION). The service must refuse it without touching it, answer every call with
// SchemaVersionError's exact message (the dashboard parses it: dataTooNewModel.ts), and say so in its
// 'ready' message, so main logs a warning instead of a plain "service ready". Temp dirs only; the
// network is never reached.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { SCHEMA_VERSION, SchemaVersionError } from '../../src/service/db';
import { cleanErrorMessage, readyMessage } from '../../src/service/entry';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

const temps: string[] = [];
const cores: ServiceCore[] = [];

afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const noFetch = (async () => {
  throw new Error('this test makes no requests');
}) as typeof fetch;

function tempDataDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-too-new-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function userVersion(file: string): number {
  const db = new DatabaseSync(file);
  try {
    return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
}

function makeCore(dataDir: string, errors: string[] = []): ServiceCore {
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: (m: string) => void errors.push(m) };
  const core = createServiceCore({
    dataDir,
    version: '0.7.1',
    settings: { ...DEFAULT_SETTINGS, networkPaused: true },
    secrets: {},
    log,
    fetchImpl: noFetch,
  });
  cores.push(core);
  return core;
}

describe('a data folder from a newer copy of the app', () => {
  it('refuses it with the exact SchemaVersionError message, and reports the failure when ready', async () => {
    const dataDir = tempDataDir();
    const file = path.join(dataDir, 'flipdesk.sqlite');
    const newer = SCHEMA_VERSION + 1;
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${newer}`);
    db.close();
    const expected = new SchemaVersionError(newer, SCHEMA_VERSION).message;

    const errors: string[] = [];
    const core = makeCore(dataDir, errors);
    expect(core.failure).toBe(expected);
    expect(errors).toEqual([`service cannot start: ${expected}`]);

    // What entry.ts posts once the core exists: main logs this reason as a warning.
    expect(readyMessage(core)).toEqual({ type: 'ready', failure: expected });

    await core.start();
    for (const method of ['status.get', 'opps.list', 'prices.list']) {
      const err = await core.handle(method, undefined).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(expected);
      // entry.ts cleans every rejection before it leaves the process; this one stays whole.
      expect(cleanErrorMessage(err)).toBe(expected);
    }

    // Nothing was changed: the newer copy's data is as it left it.
    expect(existsSync(file)).toBe(true);
    expect(userVersion(file)).toBe(newer);
  });

  it('a normal start sends a bare ready, as before', async () => {
    const core = makeCore(tempDataDir());
    expect(core.failure).toBeUndefined();
    expect(readyMessage(core)).toEqual({ type: 'ready' });
    expect('failure' in readyMessage(core)).toBe(false);
  });

  it('cleans a reason that names a local path before it leaves the service', () => {
    const msg = readyMessage({ failure: 'The database could not be opened: unable to open C:\\Users\\someone\\AppData\\x.sqlite' });
    expect(msg).toEqual({ type: 'ready', failure: 'The database could not be opened: unable to open <path>' });
  });
});
