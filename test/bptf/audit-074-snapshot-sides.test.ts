// 0.7.4 trading accuracy audit (package PB), in bptfApi.snapshot:
// - F51: the result counts the raw rows bp.tf returned per side (mapped or not, an unreadable intent on
//   both), so core can tell a full 30-row page from a whole book.
// - F23: a snapshot never carries a stale online flag from the stored feed row onto the row it stamps as
//   seen now; a flag the feed reported within ORDER_CONFIRMED_MS still carries, as the ban and names do.
// Rows are mapped with the real schema fixture (createSchemaService over test/pricedb/helpers' route).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SNAPSHOT_SIDE_PAGE, SNAPSHOT_URL, createBptfApi } from '../../src/service/connectors/bptfApi';
import { bptfBuyListingId } from '../../src/service/connectors/bptfItem';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { ORDER_CONFIRMED_MS } from '../../src/shared/buyerSeen';
import { makeDeps, schemaRoute } from '../pricedb/helpers';
import { FakeHttp, createLogger, jsonResponse, settingsWith } from './helpers';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const TOKEN = 'tok_SECRET_0123456789abcdef';
const NAME = 'Strange Australium Scattergun';
const SKU = '200;11;australium';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const item = { defindex: 200, quality: 11, quantity: '1', attributes: [{ defindex: 2027, value: 1, float_value: 1 }] };
const row = (steamid: string, intent: unknown, metal: number) => ({ steamid, intent, currencies: { keys: 0, metal }, item, timestamp: T0 / 1000 - 600 });

function harness(listings: unknown[]) {
  let now = T0;
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertBptfNames([{ sku: SKU, name: NAME, marketName: null, lastSeen: 1 }]);
  const http = new FakeHttp((call) => (call.url === SNAPSHOT_URL ? jsonResponse(200, { appid: 440, sku: NAME, createdAt: T0 / 1000, listings }) : { status: 404, data: null }));
  const api = createBptfApi({
    clock: { now: () => now },
    log: createLogger(),
    repo,
    http,
    settings: () => settingsWith({}),
    secret: (n) => (n === 'bptfAccessToken' ? TOKEN : null),
    schema,
  });
  return { api, repo, advance: (ms: number) => (now += ms) };
}

describe('snapshot sides (F51)', () => {
  it('counts every raw row per side, mapped or not, and an unreadable intent on both', async () => {
    const buys = Array.from({ length: 29 }, (_, i) => row(`7656119800000${1000 + i}`, 'buy', 10 + i));
    const h = harness([
      ...buys,
      // Unmappable (no item), still one of the page's rows.
      { steamid: '76561198000009999', intent: 0 },
      row('76561198000008888', 1, 50),
      row('76561198000007777', 'sell', 55),
      row('76561198000006666', 'nope', 60),
    ]);
    const r = await h.api.snapshot(SKU, 'user');
    expect(r.sides).toEqual({ buy: 31, sell: 3 });
    expect(r.sides!.buy).toBeGreaterThanOrEqual(SNAPSHOT_SIDE_PAGE);
    // The mapped rows are the real schema's SKU.
    expect(r.listings.filter((l) => l.intent === 'buy').every((l) => l.baseSku === SKU)).toBe(true);
  });
});

describe('snapshot user data (F23)', () => {
  it('drops a stale online flag but keeps a recent one, the ban and the name', async () => {
    const h = harness([row('76561198000000001', 'buy', 30), row('76561198000000002', 'buy', 29)]);
    const first = await h.api.snapshot(SKU, 'user');
    const [a, b] = first.listings;
    expect(a!.id).toBe(bptfBuyListingId('76561198000000001', NAME));
    // The feed saw buyer 1 online 5 days ago and buyer 2 online a minute ago; both are named, 1 is banned.
    h.repo.upsertListings([
      { ...a!, origin: 'ws', userOnline: true, userBanned: true, userName: 'Old', lastEventAt: T0 - 5 * 24 * 3_600_000 },
      { ...b!, origin: 'ws', userOnline: true, userName: 'Fresh', lastEventAt: T0 - 60_000 },
    ]);
    h.advance(11 * 60_000); // past the 10-min cache
    const again = await h.api.snapshot(SKU, 'user');
    const byId = new Map(again.listings.map((l) => [l.id, l]));
    expect(byId.get(a!.id)).toMatchObject({ userOnline: null, userBanned: true, userName: 'Old' });
    expect(byId.get(b!.id)).toMatchObject({ userOnline: true, userName: 'Fresh' });
    expect(ORDER_CONFIRMED_MS).toBe(2 * 3_600_000);
  });
});
