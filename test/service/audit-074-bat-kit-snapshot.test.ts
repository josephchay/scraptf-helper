// 0.7.4 review (R17), through a real, started createServiceCore: the Upgradeable Bat (190) twins with the stock
// Bat (defindex 0), and td-0 is no SKU, so the Bat kit's book took in the targetless kit's ("Non-Craftable
// Professional Killstreak Kit", another item): the drawer listed that order above the Bat kit's own, and a Bat
// kit snapshot deleted every stored order of the targetless kit and stamped its snapshot time. Now the Bat kit's
// book is its own. Temp dirs only; the schema is the real fixture, cached in the database as a previous run would
// have, the fetch answers only the faked api.backpack.tf snapshot and refuses every other host, and the socket is
// a fake, so the fake token never leaves the process.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bptfBuyListingId } from '../../src/service/connectors/bptfItem';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { META_SCHEMA_CHECKED_AT, META_SCHEMA_EXTRAS, buildSchemaSnapshot } from '../../src/service/connectors/schema';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ItemDetail, Listing } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = (rel: string): unknown => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8'));
const MIN = 60_000;
const TOKEN = 'bptf-access-token-0123456789abcdef';
const BAT_KIT = '6526;6;uncraftable;kt-3;td-190';
const BAT_NAME = 'Non-Craftable Professional Killstreak Bat Kit';
const GENERIC_KIT = '6526;6;uncraftable;kt-3';
const GENERIC_NAME = 'Non-Craftable Professional Killstreak Kit';

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const sec = (): number => Math.floor(Date.now() / 1000);
const steam = (i: number): string => `7656119800000${String(3000 + i)}`;
/** A raw snapshot row: a Non-Craftable Professional Killstreak Bat Kit buy order. */
const rawBatKit = (steamid: string, metal: number) => ({
  steamid,
  intent: 'buy',
  timestamp: sec() - 600,
  bump: sec() - 60,
  currencies: { keys: 1, metal },
  item: { defindex: 6526, quality: 6, quantity: '1', flag_cannot_craft: true, attributes: [{ defindex: 2025, float_value: 3 }, { defindex: 2012, float_value: 190 }] },
});
/** A stored feed order, ten minutes old. */
const stored = (i: number, base: string, name: string, metalScrap: number): Listing =>
  makeListing({ id: bptfBuyListingId(steam(i), name), sku: base, baseSku: base, steamid: steam(i), keys: 1, metalScrap, lastEventAt: Date.now() - 10 * MIN, itemName: name });

async function make(seed: (repo: Repo) => void, rows: unknown[]): Promise<{ core: ServiceCore; dataDir: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit074-batkit-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  const now = Date.now();
  const built = buildSchemaSnapshot(load('pricedb/schema-subset.json'), load('pricedb/paint-list.json'), now, 'W/"fixture"');
  repo.replaceSchema(built.snapshot);
  repo.setMeta(META_SCHEMA_EXTRAS, JSON.stringify(built.extras));
  repo.setMeta(META_SCHEMA_CHECKED_AT, String(now));
  repo.upsertBptfNames([
    { sku: BAT_KIT, name: BAT_NAME, marketName: null, lastSeen: now },
    { sku: GENERIC_KIT, name: GENERIC_NAME, marketName: null, lastSeen: now },
  ]);
  seed(repo);
  repo.close();
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === 'api.backpack.tf' && u.pathname === '/api/classifieds/listings/snapshot') {
      asked.push(u.searchParams.get('sku') ?? '');
      return new Response(JSON.stringify({ appid: 440, sku: BAT_NAME, createdAt: sec(), listings: rows }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
  }) as typeof fetch;
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: true, scm: false },
  });
  const core = createServiceCore({ dataDir, version: '0.7.4', settings, secrets: { bptfAccessToken: TOKEN }, log, fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  expect(core.failure).toBeUndefined();
  await core.start();
  return { core, dataDir };
}

function storedIds(dataDir: string, base: string): string[] {
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  try {
    return repo
      .listingsByBaseSku(base, 'buy')
      .map((l) => l.steamid)
      .sort();
  } finally {
    repo.close();
  }
}

describe("a Bat kit's book is its own (R17)", () => {
  it("lists only the Bat kit's orders, and its snapshot leaves the targetless kit's orders and snapshot time alone", async () => {
    const m = await make(
      (repo) =>
        repo.upsertListings([
          stored(1, BAT_KIT, BAT_NAME, 99), // in the snapshot
          stored(2, BAT_KIT, BAT_NAME, 90), // gone: not in the snapshot
          stored(3, GENERIC_KIT, GENERIC_NAME, 297), // another item's order
        ]),
      [rawBatKit(steam(1), 11), rawBatKit(steam(4), 10)],
    );
    const before = (await m.core.handle('item.detail', { sku: BAT_KIT, history: false })) as ItemDetail;
    expect(before.buyOrders.map((o) => o.steamid).sort()).toEqual([steam(1), steam(2)].sort());

    const r = (await m.core.handle('item.refresh', { sku: BAT_KIT })) as { queued: boolean };
    expect(r).toMatchObject({ queued: true });
    const end = Date.now() + 15_000;
    for (;;) {
      const d = (await m.core.handle('item.detail', { sku: BAT_KIT, history: false })) as ItemDetail;
      if (d.snapshot.lastAt !== null) break;
      if (Date.now() > end) throw new Error('timed out waiting for the snapshot');
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(storedIds(m.dataDir, BAT_KIT)).toEqual([steam(1), steam(4)].sort());
    expect(storedIds(m.dataDir, GENERIC_KIT)).toEqual([steam(3)]);
    const generic = (await m.core.handle('item.detail', { sku: GENERIC_KIT, history: false })) as ItemDetail;
    expect(generic.snapshot.lastAt).toBeNull();
    expect(generic.buyOrders.map((o) => o.steamid)).toEqual([steam(3)]);
  }, 30_000);
});
