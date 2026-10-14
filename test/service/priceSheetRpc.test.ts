// F7 through the service core with the real schema fixture: bulk paste is a
// preview that writes nothing and fetches nothing, its refusal reaches the UI
// as an error, the preview's rows save with one push, and the price-sheet CSV
// and rules backup round-trip (an import adds, never doubles or deletes).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { CSV_BOM } from '../../src/service/domain/csv';
import { createLogger } from '../../src/service/logger';
import { PAGE_CONTENT_REFUSAL } from '../../src/service/priceSheetIo';
import { SCHEMA_LOADING_MESSAGE } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { BulkPriceRow, PriceRule, ScrapPrice } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(u.hostname + u.pathname);
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

async function setup(fetchFn: typeof fetch = fetchImpl) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-f7-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
  });
  const core = createServiceCore({
    dataDir,
    version: '0.1.0',
    settings,
    secrets: {},
    log: createLogger({ dataDir }),
    fetchImpl: fetchFn,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
  });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const pricePushes = () => pushes.filter((p) => p.event === 'prices.changed').length;
  return { core, pushes, call, pricePushes };
}

const PASTE = [
  '# from my notes',
  'Team Captain, 1 key 5 ref',
  'Strange Rocket Launcher\t2.33',
  'https://marketplace.tf/items/tf2/5021;6 = 50',
  '200;11 @ 3 ref',
  'Not A Real Item Whatsoever, 5 ref',
].join('\n');

describe("'prices.parseBulk'", () => {
  it('resolves names, SKUs and item links, writes nothing and requests nothing', async () => {
    const h = await setup();
    const before = requested.length;
    const r = await h.call<{ rows: BulkPriceRow[]; rejected: number }>('prices.parseBulk', { text: PASTE });
    expect(Object.keys(r).sort()).toEqual(['rejected', 'rows']);
    expect(r.rows.map((x) => [x.line, x.sku, x.costKeys, x.costScrap, x.error === null])).toEqual([
      [2, '378;6', 1, 45, true],
      // The schema's pick among the Rocket Launcher defindexes for a Strange.
      [3, expect.stringMatching(/^(18|205);11$/), 0, 21, true],
      [4, '5021;6', 0, 450, true],
      [5, '200;11', 0, 27, true],
      [6, null, 0, 45, false],
    ]);
    expect(r.rows[0]!.name).toMatch(/Team Captain$/);
    expect(r.rejected).toBe(1);
    expect(requested.length).toBe(before);
    expect(await h.call<ScrapPrice[]>('prices.list', {})).toEqual([]);
    expect(h.pricePushes()).toBe(0);
  });

  it('throws the page-content refusal as the error message (R10)', async () => {
    const h = await setup();
    await expect(h.call('prices.parseBulk', { text: 'Team Captain, 1.33\n<td>Team Captain</td>' })).rejects.toThrow(PAGE_CONTENT_REFUSAL);
    await expect(h.call('prices.parseBulk', { text: 'https://scrap.tf/hats 5 ref' })).rejects.toThrow(PAGE_CONTENT_REFUSAL);
    const many = Array.from({ length: 501 }, () => 'Team Captain, 1.33').join('\n');
    await expect(h.call('prices.parseBulk', { text: many })).rejects.toThrow(/at most 500/);
    await expect(h.call('prices.parseBulk', { text: 'x'.repeat(1_000_001) })).rejects.toThrow(/Invalid parameters for prices\.parseBulk/);
  });

  it('feeds prices.bulkUpsert: the saveable rows are written as user prices with one push', async () => {
    const h = await setup();
    const { rows } = await h.call<{ rows: BulkPriceRow[] }>('prices.parseBulk', { text: PASTE, bareUnit: 'scrap' });
    const ok = rows.filter((x) => x.error === null).map((x) => ({ sku: x.sku!, name: x.name ?? undefined, costKeys: x.costKeys, costScrap: x.costScrap }));
    expect(ok).toHaveLength(4);
    // The bare unit applies to bare numbers only.
    expect(ok.find((o) => o.sku === '5021;6')?.costScrap).toBe(50);
    expect(ok.find((o) => o.sku === '200;11')?.costScrap).toBe(27);
    const r = await h.call('prices.bulkUpsert', { rows: ok });
    expect(r).toEqual({ added: 4, updated: 0 });
    expect(h.pricePushes()).toBe(1);
    const list = await h.call<ScrapPrice[]>('prices.list', {});
    expect(list.map((p) => [p.sku, p.costKeys, p.costScrap, p.source]).sort()).toEqual(ok.map((o) => [o.sku, o.costKeys, o.costScrap, 'user']).sort());
  });

  it('says the item list is still loading instead of marking every name unrecognised', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed: offline');
    }) as typeof fetch;
    const h = await setup(offline);
    await expect(h.call('prices.parseBulk', { text: 'Team Captain, 1.33' })).rejects.toThrow(SCHEMA_LOADING_MESSAGE);
    // The R10 refusal still comes first, and a paste of comments only is simply empty.
    await expect(h.call('prices.parseBulk', { text: '<div>' })).rejects.toThrow(PAGE_CONTENT_REFUSAL);
    await expect(h.call('prices.parseBulk', { text: '# nothing yet' })).resolves.toEqual({ rows: [], rejected: 0 });
  });

  it('keeps every line of a repeated item saveable, so the dashboard can use the last one', async () => {
    const h = await setup();
    const r = await h.call<{ rows: BulkPriceRow[]; rejected: number }>('prices.parseBulk', { text: 'Team Captain, 1.33\n378;6, 2 ref' });
    expect(r.rows.map((x) => [x.sku, x.costScrap, x.error])).toEqual([
      ['378;6', 12, null],
      ['378;6', 18, null],
    ]);
    expect(r.rejected).toBe(0);
  });
});

describe("'prices.bulkUpsert' rows are whole typed prices", () => {
  it('an update without keys clears the old keys and the import batch', async () => {
    const h = await setup();
    const old = await h.call<ScrapPrice>('prices.upsert', { sku: '378;6', costKeys: 2, costScrap: 9 });
    expect(await h.call('prices.bulkUpsert', { rows: [{ id: old.id, sku: '378;6', costScrap: 12 }] })).toEqual({ added: 0, updated: 1 });
    const [p] = await h.call<ScrapPrice[]>('prices.list', {});
    expect(p).toMatchObject({ id: old.id, costKeys: 0, costScrap: 12, source: 'user', importBatch: null });
  });
});

describe("'prices.exportCsv' round trip", () => {
  it('the exported sku and cost columns paste back into the same prices, paint included', async () => {
    const h = await setup();
    await h.call('prices.upsert', { sku: '378;6', costKeys: 1, costScrap: 45 });
    await h.call('prices.upsert', { sku: '378;6;p15185211', costScrap: 30 });
    const { csv } = await h.call<{ csv: string }>('prices.exportCsv');
    const cells = csv
      .slice(CSV_BOM.length)
      .split('\r\n')
      .slice(1, -1)
      .map((l) => l.split(','));
    expect(cells.map((c) => c[1]).sort()).toEqual(['378;6', '378;6;p15185211']);
    const { rows } = await h.call<{ rows: BulkPriceRow[] }>('prices.parseBulk', { text: cells.map((c) => `${c[1]}\t${c[3]}`).join('\n') });
    expect(rows.map((x) => [x.sku, x.costKeys, x.costScrap, x.error]).sort()).toEqual([
      ['378;6', 1, 45, null],
      ['378;6;p15185211', 0, 30, null],
    ]);
  });
});

describe("'prices.exportCsv'", () => {
  it('returns the sheet as CSV with a dated name', async () => {
    const h = await setup();
    await h.call('prices.upsert', { sku: '378;6', costKeys: 1, costScrap: 45, note: '=1+1' });
    await h.call('prices.upsert', { sku: '5021;6', costScrap: 450 });
    const r = await h.call<{ csv: string; suggestedName: string }>('prices.exportCsv');
    expect(r.suggestedName).toMatch(/^flipdesk-prices-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(r.csv.startsWith(CSV_BOM)).toBe(true);
    const lines = r.csv.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]!.startsWith('id,sku,name,cost,')).toBe(true);
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.includes(',378;6,'))).toMatch(/,1 key 5\.00 ref,1,5,/);
    expect(lines.find((l) => l.includes(',378;6,'))).toContain(",'=1+1,");
  });
});

describe('rules backup RPCs', () => {
  const RULES = [
    { name: 'Craft hats', filter: { categories: ['hats'], craftable: true }, costScrap: 12 },
    { name: 'Strange weapons', filter: { qualities: [11] }, costKeys: 1, costScrap: 0, enabled: false },
  ];

  it('exports and imports into another machine; a second import adds nothing', async () => {
    const a = await setup();
    for (const r of RULES) await a.call('rules.upsert', r);
    const exp = await a.call<{ json: string; suggestedName: string }>('rules.exportJson');
    expect(exp.suggestedName).toMatch(/^flipdesk-rules-\d{4}-\d{2}-\d{2}\.json$/);

    const b = await setup();
    await b.call('rules.upsert', { name: 'Mine', filter: {}, costScrap: 3 });
    const pushesBefore = b.pricePushes();
    const first = await b.call<{ added: number; skipped: string[] }>('rules.importJson', { json: exp.json });
    expect(first).toEqual({ added: 2, skipped: [] });
    expect(b.pricePushes()).toBe(pushesBefore + 1);
    const rules = await b.call<PriceRule[]>('rules.list');
    expect(rules.map((r) => r.name)).toEqual(['Mine', 'Craft hats', 'Strange weapons']);
    expect(rules.find((r) => r.name === 'Strange weapons')).toMatchObject({ costKeys: 1, enabled: false, filter: { qualities: [11] } });

    const again = await b.call<{ added: number; skipped: string[] }>('rules.importJson', { json: exp.json });
    expect(again).toEqual({ added: 0, skipped: ['"Craft hats": already in your rules', '"Strange weapons": already in your rules'] });
    expect(b.pricePushes()).toBe(pushesBefore + 1);
    expect(await b.call<PriceRule[]>('rules.list')).toHaveLength(3);
  });

  it('skips invalid rules with reasons, clamps future dates and rounds scrap', async () => {
    const h = await setup();
    const future = Date.now() + 365 * 86_400_000;
    const backup = JSON.stringify([
      { name: 'Future', filter: {}, costScrap: 10.6, observedAt: future },
      { name: 'Broken', filter: { categories: ['boats'] }, costScrap: 1 },
      // Same name, filter and price as the first once rounded: a duplicate within the file.
      { name: 'Future', filter: {}, costScrap: 11, observedAt: future },
      { name: 'Future', filter: {}, costScrap: 12 },
    ]);
    const r = await h.call<{ added: number; skipped: string[] }>('rules.importJson', { json: backup });
    expect(r.added).toBe(2);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0]).toMatch(/^"Broken": filter\.categories/);
    expect(r.skipped[1]).toBe('"Future": repeated in this backup');
    const rules = await h.call<PriceRule[]>('rules.list');
    expect(rules.map((x) => x.costScrap)).toEqual([11, 12]);
    expect(rules.every((x) => x.observedAt <= Date.now())).toBe(true);
  });

  it('reports a file that is not a backup, and writes nothing', async () => {
    const h = await setup();
    await expect(h.call('rules.importJson', { json: '<html>' })).rejects.toThrow('Not a rules backup: the file is not valid JSON.');
    await expect(h.call('rules.importJson', { json: '{"format":"other","rules":[]}' })).rejects.toThrow('Not a TF2 Flip Desk rules backup.');
    expect(await h.call<PriceRule[]>('rules.list')).toEqual([]);
    expect(h.pricePushes()).toBe(0);
  });

  it('stores rule prices as whole scrap', async () => {
    const h = await setup();
    const rule = await h.call<PriceRule>('rules.upsert', { name: 'Hats', filter: {}, costScrap: 12.5 });
    expect(rule.costScrap).toBe(13);
  });
});
