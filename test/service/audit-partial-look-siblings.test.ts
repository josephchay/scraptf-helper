// Audit rpc-1 / importflow-1, end to end in the real core over buy_hats.html: a look known to be missing
// cards (unsettled, ACT-4; partial, DM-2) that shows one copy of Wise Whiskers (C03, painted) leaves the
// other copy's imported price (C38, plain) as it was, so the next whole look updates both in place: the
// engine's opportunity keys (`${sku}|price:${id}`) stay, and no gone, new or restocked event follows.
// Offline (R1, R10): only the schema host answers at start, and nothing is requested after it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ImportResult, ScrapPrice, ScraptfChangeEvent } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const HATS = readFileSync(path.join(FIX, 'import/buy_hats.html'), 'utf8');
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

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const HATS_URL = 'https://scrap.tf/buy/hats';
const WISE_WHISKERS = '31031;6';
const PAINT = 6901050;

/** One card of the fixture, from its `<!-- Cnn` comment up to the next card's comment. */
function card(html: string, id: string): string {
  const start = html.indexOf(`<!-- ${id}`);
  const next = html.slice(start + 4).search(/<!-- [CU]\d/);
  if (start < 0 || next < 0) throw new Error(`no card ${id} in the fixture`);
  return html.slice(start, start + 4 + next);
}
function without(html: string, id: string): string {
  const c = card(html, id);
  expect(html.includes(c)).toBe(true);
  return html.replace(c, '');
}
function only(html: string, ...ids: string[]): string {
  const open = /<div id="buy-container"[^>]*>/.exec(html)!;
  return `${html.slice(0, open.index + open[0].length)}\n${ids.map((id) => card(html, id)).join('\n')}\n</div></div></body></html>`;
}

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit-siblings-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  openRepo(path.join(dataDir, DB_FILE_NAME)).close();
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    import: { enabled: true, acknowledgedAt: NOW - HOUR },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - HOUR },
  });
  const core = createServiceCore({ dataDir, version: '0.7.3', settings, secrets: {}, log: createLogger({ dataDir }), fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const file = (html: string, mtimeMs: number, fileName = 'Hat Trading - TF2 - Scrap.TF.html') => call<ImportResult>('import.html', { html, fileName, mtimeMs });
  const window = (html: string, mtimeMs: number, extra: { settled?: boolean } = {}) =>
    call<ImportResult>('import.html', { html, fileName: 'scrap.tf window /buy/hats', mtimeMs, address: HATS_URL, origin: 'window', ...extra });
  const copies = async () => {
    const rows = (await call<ScrapPrice[]>('prices.list', {})).filter((p) => p.sku === WISE_WHISKERS && p.source === 'import');
    const painted = rows.find((p) => p.special?.paint === PAINT);
    const plain = rows.find((p) => (p.special?.paint ?? null) === null);
    return { rows, painted, plain };
  };
  return { call, file, window, copies };
}

describe('a partial or unsettled look leaves the other copies of an item it shows (audit rpc-1)', () => {
  for (const kind of ['unsettled', 'partial'] as const) {
    it(`keeps the plain copy's price and id through a ${kind} look of the painted one, and the next whole look`, async () => {
      const h = await setup();
      expect((await h.file(HATS, NOW - 3 * HOUR)).stockSave).toBe('written');
      const before = await h.copies();
      expect(before.rows).toHaveLength(2);
      const plain = before.plain!;
      const painted = before.painted!;
      expect([plain.costScrap, painted.costScrap]).toEqual([12, 16]);

      const look = await h.window(only(HATS, 'C03'), NOW - HOUR, kind === 'unsettled' ? { settled: false } : {});
      expect(look.stockSave).toBe(kind);
      const mid = await h.copies();
      expect(mid.plain).toEqual(plain);
      expect(mid.painted).toMatchObject({ id: painted.id, observedAt: NOW - HOUR });

      expect((await h.file(HATS, NOW - 30 * MIN)).stockSave).toBe('written');
      const after = await h.copies();
      expect(after.rows).toHaveLength(2);
      expect([after.plain?.id, after.painted?.id]).toEqual([plain.id, painted.id]);
      const events = await h.call<ScraptfChangeEvent[]>('scraptf.changes', {});
      expect(events.filter((e) => e.kind === 'gone' || e.kind === 'new' || e.kind === 'restocked')).toEqual([]);
      expect(requested).toEqual([]);
    }, 45_000);
  }

  it('a whole look without the painted copy still removes its price', async () => {
    const h = await setup();
    await h.file(HATS, NOW - 3 * HOUR);
    expect((await h.window(only(HATS, 'C03'), NOW - HOUR, { settled: false })).stockSave).toBe('unsettled');
    expect((await h.file(without(HATS, 'C03'), NOW - 30 * MIN)).stockSave).toBe('written');
    const after = await h.copies();
    expect(after.painted).toBeUndefined();
    expect(after.plain?.costScrap).toBe(12);
    expect(requested).toEqual([]);
  }, 45_000);
});
