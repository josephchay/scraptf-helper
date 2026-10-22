// 0.7.4 trading accuracy audit, package G2 (review R36, F23): bptfApi.snapshot carries the buyer's online flag
// only from a feed row ('ws') whose last event is within ORDER_CONFIRMED_MS. A row a snapshot stored (origin
// 'snapshot', stamped at that snapshot) never passes it on, so a flag carried once cannot outlive the next
// snapshot, which before re-read its own fresh stamp as the feed's. The ban and the name still carry.
// Rows are mapped with the real schema fixture (createSchemaService over test/pricedb/helpers' route).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SNAPSHOT_URL, createBptfApi } from '../../src/service/connectors/bptfApi';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { makeDeps, schemaRoute } from '../pricedb/helpers';
import { FakeHttp, createLogger, jsonResponse, settingsWith } from './helpers';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const TOKEN = 'tok_SECRET_0123456789abcdef';
const NAME = 'Strange Australium Scattergun';
const SKU = '200;11;australium';
const MIN = 60_000;

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

function harness() {
  let now = T0;
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertBptfNames([{ sku: SKU, name: NAME, marketName: null, lastSeen: 1 }]);
  const rows = () => [{ steamid: '76561198000000001', intent: 'buy', currencies: { keys: 0, metal: 30 }, item, timestamp: now / 1000 - 600 }];
  const http = new FakeHttp((call) => (call.url === SNAPSHOT_URL ? jsonResponse(200, { appid: 440, sku: NAME, createdAt: now / 1000, listings: rows() }) : { status: 404, data: null }));
  const api = createBptfApi({
    clock: { now: () => now },
    log: createLogger(),
    repo,
    http,
    settings: () => settingsWith({}),
    secret: (n) => (n === 'bptfAccessToken' ? TOKEN : null),
    schema,
  });
  return { api, repo, now: () => now, advance: (ms: number) => (now += ms) };
}

describe('snapshot presence carry (R36, F23)', () => {
  it('carries a recent feed flag once; the next snapshot finds the row it stamped and drops it, keeping ban and name', async () => {
    const h = harness();
    const [first] = (await h.api.snapshot(SKU, 'user')).listings;
    // The feed saw the buyer online a minute ago (banned, named).
    h.repo.upsertListings([{ ...first!, origin: 'ws', userOnline: true, userBanned: true, userName: 'Fresh', lastEventAt: h.now() - MIN }]);
    h.advance(11 * MIN); // past the 10-min cache
    const [carried] = (await h.api.snapshot(SKU, 'user')).listings;
    expect(carried).toMatchObject({ userOnline: true, userBanned: true, userName: 'Fresh' });
    // Stored the way core stores a snapshot row: origin 'snapshot', seen as of the snapshot.
    h.repo.upsertListings([{ ...carried!, origin: 'snapshot', lastEventAt: h.now() }]);

    h.advance(61 * MIN); // within 2 h of the snapshot's own stamp, but no feed event since
    const [again] = (await h.api.snapshot(SKU, 'user')).listings;
    expect(again).toMatchObject({ userOnline: null, userBanned: true, userName: 'Fresh' });
  });

  it("never carries the flag from a snapshot row, however recent its stamp", async () => {
    const h = harness();
    const [first] = (await h.api.snapshot(SKU, 'user')).listings;
    h.repo.upsertListings([{ ...first!, origin: 'snapshot', userOnline: true, lastEventAt: h.now() - MIN }]);
    h.advance(11 * MIN);
    const [next] = (await h.api.snapshot(SKU, 'user')).listings;
    expect(next!.userOnline).toBeNull();
  });
});
