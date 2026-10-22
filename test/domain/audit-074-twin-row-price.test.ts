// 0.7.4 (review R29): a Live market row of a book filed under defindex twins shows the newest price of yours
// across every twin, not only the row base's. The row sits on the canonical base whenever that has a price
// (rowBaseOf) and the known-only pass skips a priced twin of a listed book, so a newer, cheaper price stored
// under the twin (a typed 18;11;australium;festive price beside a 205 import) showed in no row while the
// engine listed it as a flip. rowKnownAt reads knownAt over bookBasesOf. Real schema fixture; no network.

import { afterEach, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine } from '../../src/service/domain/engine';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, makeListing, noNetwork, recordingEvents, testSettings } from './helpers';

const K = 567;
const FEST = '205;11;australium;festive';
const FEST_18 = '18;11;australium;festive';
const NAME = 'Strange Festivized Australium Rocket Launcher';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

async function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = testSettings();
  const schema = createSchemaService(schemaDeps(schemaRoute(), { repo }));
  await schema.init();
  const engine = createEngine({ ...makeDeps(repo, clock, () => settings), schema, events: recordingEvents(), timers });
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    http: noNetwork,
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
  });
  const run = async () => {
    market.start();
    await timers.advance(0);
    for (let i = 0; i < 10; i++) await timers.advance(1000);
  };
  const rows = () => market.list({ search: 'Festivized Australium Rocket Launcher' }, clock.now()).rows;
  return { repo, clock, timers, engine, market, keyPrice, run, rows };
}

const order = (id: string, base: string, keys: number) =>
  makeListing({ id, steamid: `S-${id}`, sku: base, baseSku: base, keys, metalScrap: 0, itemName: NAME, lastEventAt: T0 - MIN, userOnline: true });

describe("a twin's own price on the book's one row (R29)", () => {
  it('shows a newer typed price stored under the twin, as the engine prices it', async () => {
    const h = await setup();
    h.repo.upsertListings([order('a', FEST, 47), order('b', FEST, 46), order('c', FEST_18, 48)]);
    h.repo.upsertScrapPrice({ sku: FEST, name: NAME, costKeys: 50, costScrap: 0, source: 'import', observedAt: T0 - 10 * MIN });
    const twin = h.repo.upsertScrapPrice({ sku: FEST_18, name: NAME, costKeys: 40, costScrap: 0, source: 'user', observedAt: T0 - MIN });
    await h.run();
    const kv = h.keyPrice().valueScrap;
    const rows = h.rows();
    expect(rows.map((r) => r.sku)).toEqual([FEST]);
    expect(rows[0]).toMatchObject({ knownCostScrap: 40 * kv, knownSource: 'typed', knownObservedAt: T0 - MIN });
    expect(rows[0]!.verdict).not.toBe('over');

    await h.engine.runNow();
    const opp = h.repo.getOpportunity(`${FEST_18}|price:${twin.id}`) ?? h.repo.getOpportunity(`${FEST}|price:${twin.id}`);
    expect(opp?.costScrap).toBe(rows[0]!.knownCostScrap);
    expect(opp?.status).toBe('profitable');
    expect(rows[0]!.verdict).toBe('flip');
    h.market.stop();
  });

  it("keeps the canonical base's price when it is the newer one", async () => {
    const h = await setup();
    h.repo.upsertListings([order('a', FEST, 47), order('c', FEST_18, 48)]);
    h.repo.upsertScrapPrice({ sku: FEST_18, name: NAME, costKeys: 40, costScrap: 0, source: 'user', observedAt: T0 - 10 * MIN });
    h.repo.upsertScrapPrice({ sku: FEST, name: NAME, costKeys: 50, costScrap: 0, source: 'import', observedAt: T0 - MIN });
    await h.run();
    const rows = h.rows();
    expect(rows.map((r) => r.sku)).toEqual([FEST]);
    expect(rows[0]).toMatchObject({ knownCostScrap: 50 * h.keyPrice().valueScrap, knownSource: 'page' });
    h.market.stop();
  });

  it('at one time takes the cheaper of the twins, as knownAt breaks a tie', async () => {
    const h = await setup();
    h.repo.upsertListings([order('a', FEST, 47), order('c', FEST_18, 48)]);
    h.repo.upsertScrapPrice({ sku: FEST, name: NAME, costKeys: 45, costScrap: 0, source: 'import', observedAt: T0 - MIN });
    h.repo.upsertScrapPrice({ sku: FEST_18, name: NAME, costKeys: 42, costScrap: 0, source: 'user', observedAt: T0 - MIN });
    await h.run();
    expect(h.rows()[0]).toMatchObject({ sku: FEST, knownCostScrap: 42 * h.keyPrice().valueScrap, knownSource: 'typed' });
    h.market.stop();
  });

  it('moves when only the twin price changes', async () => {
    const h = await setup();
    h.repo.upsertListings([order('a', FEST, 47), order('c', FEST_18, 48)]);
    h.repo.upsertScrapPrice({ sku: FEST, name: NAME, costKeys: 50, costScrap: 0, source: 'import', observedAt: T0 - 10 * MIN });
    await h.run();
    expect(h.rows()[0]).toMatchObject({ knownSource: 'page' });
    h.repo.upsertScrapPrice({ sku: FEST_18, name: NAME, costKeys: 40, costScrap: 0, source: 'user', observedAt: T0 - MIN });
    h.market.pricesChanged();
    for (let i = 0; i < 10; i++) await h.timers.advance(1000);
    expect(h.rows().map((r) => [r.sku, r.knownSource, r.knownCostScrap])).toEqual([[FEST, 'typed', 40 * h.keyPrice().valueScrap]]);
    h.market.stop();
  });
});
