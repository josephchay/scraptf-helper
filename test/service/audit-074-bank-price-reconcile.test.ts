// 0.7.4 (audit F31, F62): the service's one-time pass at start over imported prices older builds left. The
// user's profile held one: The Classified Coif, imported by a /buy/hats read on Oct 19, shown gone by the next
// save under a 0.7.0 build that never acted on 'gone' events, and missing from every whole save since. The real
// core starts on a profile seeded that way: the price is gone before the engine's first run (so no opportunity
// is built from it), typed and other banks' prices stay, and the pass runs once (meta flag). Offline: only the
// schema host answers (the real schema-subset.json), and nothing is requested after start.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { Repo } from '../../src/service/contracts';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { META_BANK_PRICES_RECONCILED } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { BankStockStored, OppListResult, ScrapPrice, ScraptfBank } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

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

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const COIF = '30388;6';
const CAPTAIN = '378;6';

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

const row = (sku: string, costScrap: number): BankStockStored => ({ sku, specialKey: '', name: sku, costKeys: 0, costScrap, stock: 1, assetId: null });

function batch(repo: Repo, bank: ScraptfBank, at: number, items: number): number {
  return repo.createImportBatch({ fileName: `scrap.tf window /buy/${bank}`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: items, bank, origin: 'window' });
}

function price(repo: Repo, sku: string, importBatch: number | null, at: number, source: 'import' | 'user' = 'import'): ScrapPrice {
  return repo.upsertScrapPrice({ sku, name: sku, costKeys: 0, costScrap: 47, source, observedAt: at, note: null, importBatch, special: null, assetId: null, stock: 1 });
}

/** A profile as 0.7.0 left the user's: the Coif's price under an old hats read, two whole saves without it since. */
function seedProfile(dataDir: string) {
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  const old = batch(repo, 'hats', NOW - 30 * HOUR, 2);
  const coif = price(repo, COIF, old, NOW - 30 * HOUR);
  for (const at of [NOW - 3 * HOUR, NOW - HOUR]) {
    const b = batch(repo, 'hats', at, 1);
    repo.insertBankStock(b, 'hats', [row(CAPTAIN, 14)], '/buy/hats');
    price(repo, CAPTAIN, b, at);
  }
  const typed = price(repo, COIF, null, NOW - 30 * HOUR, 'user');
  // Buyers for the Coif, so an opportunity would be built from any price of it left.
  repo.upsertListings(
    Array.from({ length: 3 }, (_, i) =>
      makeListing({ id: `coif${i}`, sku: COIF, baseSku: COIF, steamid: `7656119800099${String(i).padStart(4, '0')}`, metalScrap: 60 - i, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) }),
    ),
  );
  repo.close();
  return { coif, typed };
}

async function start(dataDir: string) {
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    import: { enabled: true, acknowledgedAt: NOW - 48 * HOUR },
  });
  const core = createServiceCore({ dataDir, version: '0.7.4', settings, secrets: {}, log: createLogger({ dataDir }), fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  await core.start();
  requested.length = 0;
  return { core, call: <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T> };
}

describe('the start pass over prices older builds left (F31, F62)', () => {
  it('removes the sold card before the engine runs, keeps the typed price, and runs once', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-reconcile-'));
    temps.push(root);
    const dataDir = path.join(root, 'data');
    const seeded = seedProfile(dataDir);

    const h = await start(dataDir);
    const prices = await h.call<ScrapPrice[]>('prices.list', {});
    expect(prices.some((p) => p.id === seeded.coif.id)).toBe(false);
    expect(prices.filter((p) => p.sku === COIF).map((p) => [p.id, p.source])).toEqual([[seeded.typed.id, 'user']]);
    expect(prices.filter((p) => p.sku === CAPTAIN)).toHaveLength(2);
    await h.call('engine.runNow');
    const opps = await h.call<OppListResult>('opps.list', { limit: 500 });
    expect(opps.rows.filter((o) => o.sku === COIF).map((o) => o.inputKind)).toEqual(['user']);
    await cores.pop()!.stop();

    // Once: a leftover written after the pass (as no 0.7.4 import would) is not swept at the next start.
    const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
    expect(repo.getMeta(META_BANK_PRICES_RECONCILED)).toBe('1');
    const again = price(repo, COIF, batch(repo, 'hats', NOW - 20 * HOUR, 1), NOW - 20 * HOUR);
    repo.close();
    const h2 = await start(dataDir);
    expect((await h2.call<ScrapPrice[]>('prices.list', {})).some((p) => p.id === again.id)).toBe(true);
    expect(requested).toEqual([]);
  }, 60_000);
});
