// 0.7.3 audit (rmodelsA-1): an overlong Opportunities search (a pasted note) used to reach the
// service as is, and 'opps.list' and 'opps.exportCsv' refused it ("Invalid parameters"), so the page
// kept stale rows and Export CSV failed. The page's own query, saved search and export query go
// through the real core here and are accepted. Temp data dir, network paused, no requests.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { OppListResult } from '../../src/shared/types';
import { DEFAULT_FILTERS, exportQuery, filtersToQuery, sanitizeFilters } from '../../src/renderer/oppModel';

const temps: string[] = [];
const cores: ServiceCore[] = [];

afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const noFetch = (async () => {
  throw new Error('this test makes no requests');
}) as typeof fetch;

async function makeCore(): Promise<ServiceCore> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-opps-search-'));
  temps.push(root);
  const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const core = createServiceCore({
    dataDir: path.join(root, 'data'),
    version: '0.7.3',
    settings: { ...DEFAULT_SETTINGS, networkPaused: true },
    secrets: {},
    log: quiet,
    fetchImpl: noFetch,
  });
  cores.push(core);
  await core.start();
  return core;
}

describe('an overlong Opportunities search against the real core', () => {
  it('is accepted by opps.list and opps.exportCsv', async () => {
    const core = await makeCore();
    const filters = sanitizeFilters({ ...DEFAULT_FILTERS, search: 'team captain '.repeat(20) });
    const q = filtersToQuery(filters, { sort: 'profit', dir: 'desc', groupBy: 'tier', limit: 100 });
    const list = (await core.handle('opps.list', q)) as OppListResult;
    expect(list.total).toBe(0);
    // The box itself can hold 200 characters at most; the query from it is accepted too.
    const typed = filtersToQuery({ ...DEFAULT_FILTERS, search: 'x'.repeat(500) }, { sort: 'name', dir: 'asc', groupBy: 'category', limit: 100 });
    await expect(core.handle('opps.list', typed)).resolves.toBeTruthy();
    await expect(core.handle('opps.exportCsv', { kind: 'opportunities', query: exportQuery(q) })).resolves.toBeDefined();
  });
});
