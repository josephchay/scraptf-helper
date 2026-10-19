// 0.7.1 (P4) 'import.report': a service method with validated params ({ limit? } or nothing) that answers
// the newest parser reports, in memory only. With no import yet there are none. A real service core on a
// temp folder; only the schema host answers, and nothing contacts scrap.tf.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { IMPORT_REPORT_RING } from '../../src/shared/importCodes';
import { MAIN_METHODS, SERVICE_METHODS } from '../../src/shared/rpc';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(u.hostname);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
  if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-importreport-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
  });
  const core = createServiceCore({ dataDir, version: '0.7.1', settings, secrets: {}, log: createLogger({ dataDir }), fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  await core.start();
  return (method: string, params?: unknown) => core.handle(method, params);
}

describe("'import.report'", () => {
  it('is a service method, and answers no report before any import', async () => {
    expect(SERVICE_METHODS).toContain('import.report');
    expect(MAIN_METHODS).not.toContain('import.report');
    const call = await setup();
    await expect(call('import.report')).resolves.toEqual([]);
    await expect(call('import.report', null)).resolves.toEqual([]);
    await expect(call('import.report', {})).resolves.toEqual([]);
    await expect(call('import.report', { limit: IMPORT_REPORT_RING })).resolves.toEqual([]);
    expect(requested.every((h) => h === 'sku.pricedb.io')).toBe(true);
  });

  it('validates the limit', async () => {
    const call = await setup();
    for (const limit of [0, -1, 1.5, IMPORT_REPORT_RING + 1, '5']) {
      await expect(call('import.report', { limit }), String(limit)).rejects.toThrow(/Invalid parameters for import\.report/);
    }
  });
});
