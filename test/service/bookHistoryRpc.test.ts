// 0.9 (history, H11): the service's 'item.bookHistory' (contracts090's harness: the real handlers over a real repo).
// It answers from local data only (order_spells, bptf_community_history, bptf_community and the local book), for the
// item's base (paint dropped), at the engine's key price; nothing is fetched: ctx.http throws on any use.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, HttpClient, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ItemBookHistory, Listing } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR = 3_600_000;

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** Any use of the HTTP client fails the test (H11: local reads only). */
const noHttp = new Proxy({} as HttpClient, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    return () => {
      throw new Error(`item.bookHistory used http.${String(prop)}`);
    };
  },
});

function service() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    http: noHttp,
    engine: { keyPrice: () => ({ valueScrap: 577 }), markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    secret: () => null,
    push: quiet,
    pricesChanged: quiet,
    journalChanged: quiet,
    scraptfHistory: {},
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  return { repo, call: async <T>(method: string, params: unknown) => (await rpc(method, params)) as T };
}

const buyOrder = (id: string, over: Partial<Listing> = {}): Listing => ({
  id,
  sku: '378;6',
  baseSku: '378;6',
  intent: 'buy',
  steamid: '76561198000000001',
  userName: 'A buyer',
  keys: 1,
  metalScrap: 9,
  isBot: true,
  uaClient: null,
  uaLastPulse: null,
  userOnline: null,
  userBanned: false,
  isMarketplace: false,
  special: { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false },
  details: '',
  listedAt: Math.floor((NOW - 2 * HOUR) / 1000),
  bumpedAt: null,
  lastEventAt: NOW - 60_000,
  origin: 'ws',
  itemName: 'Team Captain',
  marketName: null,
  ...over,
});

describe("'item.bookHistory' (H11)", () => {
  it('answers with the repo’s spells, community points and the asked orders, for the base of a painted SKU', async () => {
    const s = service();
    for (let i = 0; i < 10; i++) {
      s.repo.insertOrderSpell({
        baseSku: '378;6',
        intent: 'buy',
        isBot: true,
        keys: 1,
        metalScrap: 9,
        listedAt: Math.floor((NOW - 30 * HOUR) / 1000),
        firstSeenAt: NOW - 30 * HOUR,
        lastSeenAt: NOW - 3 * HOUR,
        endAt: i < 2 ? NOW - 20 * HOUR : NOW - 3 * HOUR,
        endKind: i < 2 ? 'deleted' : 'unwatched',
      });
    }
    s.repo.insertCommunityHistory([{ sku: '378;6', source: 'feed', currency: 'keys', value: 1.2, valueHigh: null, lastUpdate: 1_791_000_000, recordedAt: NOW - HOUR }]);
    s.repo.upsertListings([buyOrder('o1'), buyOrder('o2', { intent: 'sell' })]);
    const h = await s.call<ItemBookHistory>('item.bookHistory', { sku: '378;6;p15185211', orders: ['o1', 'o2', 'o1'] });
    expect(h.sku).toBe('378;6');
    expect(h.bases[0]).toBe('378;6');
    expect(h.summary).toMatchObject({ followed: 10, deleted: 2, unwatched: 8 });
    expect(h.keyScrap).toBe(577);
    expect(h.generatedAt).toBe(NOW);
    expect(h.orders.map((o) => [o.listingId, o.valueScrap])).toEqual([['o1', 586]]);
    // Ten followed at its 2 h age, eight still up 1 h later.
    expect(h.orders[0]!.persistence).toMatchObject({ ageMs: 2 * HOUR, scope: 'like', short: null });
    expect(h.orders[0]!.persistence.windows[0]).toMatchObject({ horizonMs: HOUR, atRisk: 10, ended: 0, p: 1 });
    expect(h.community.steps).toEqual([{ at: 1_791_000_000_000, currency: 'keys', value: 1.2, valueHigh: null, lastUpdate: 1_791_000_000, sources: ['feed'], recordedAt: NOW - HOUR }]);
  });

  it('answers an item with nothing recorded, with no orders asked, and never uses the network', async () => {
    const s = service();
    const h = await s.call<ItemBookHistory>('item.bookHistory', { sku: '126;6' });
    expect(h).toEqual({
      sku: '126;6',
      bases: ['126;6'],
      summary: { followed: 0, open: 0, deleted: 0, inactive: 0, lowered: 0, raised: 0, relisted: 0, unwatched: 0, noListedTime: 0, since: null, observedMs: 0 },
      orders: [],
      community: { steps: [], since: null, recorded: 0 },
      keyScrap: 577,
      generatedAt: NOW,
    });
  });
});
