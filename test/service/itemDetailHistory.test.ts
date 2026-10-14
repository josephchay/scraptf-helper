// F2 'item.detail' {history:false}: quick entry's live preview stays local.
// With PriceDB enabled, the default call fetches the price history once, and
// the local-only call never does.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ItemDetail } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const historyRequests: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
  if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
  if (u.hostname === 'pricedb.io' && u.pathname.includes('/item-history/')) {
    historyRequests.push(u.pathname);
    return json([]);
  }
  if (u.hostname === 'pricedb.io') return json({ success: false }, 404);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  historyRequests.length = 0;
});

describe("'item.detail' history flag", () => {
  it('history:false makes no PriceDB request; the default fetches the history', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-detail-'));
    temps.push(root);
    const dataDir = path.join(root, 'data');
    const core = createServiceCore({
      dataDir,
      version: '0.1.0',
      settings: mergeSettings(DEFAULT_SETTINGS, {
        contactUrl: 'https://github.com/flipdesk-test',
        liveFeed: { enabled: false },
        connectors: { pricedb: true, pricedbSocket: false, bptfApi: false, scm: false },
      }),
      secrets: {},
      log: createLogger({ dataDir }),
      fetchImpl,
      wsFactory: (url, headers) => new FakeSocket(url, headers),
    });
    cores.push(core);
    await core.start();

    const local = (await core.handle('item.detail', { sku: '378;6', history: false })) as ItemDetail;
    expect(local.sku).toBe('378;6');
    expect(local.history).toEqual([]);
    expect(historyRequests).toEqual([]);

    await core.handle('item.detail', { sku: '378;6' });
    expect(historyRequests).toHaveLength(1);
    expect(historyRequests[0]).toContain('378');
  });
});
