// 0.7.4 (F09/F14/F49/F73): backpack.tf files one item's buy orders under defindex twins. A buy order is one per
// buyer and full name (its id is md5 of the name), but it keeps the defindex of the item document its maker sent:
// "Strange Festivized Australium Rocket Launcher" sat under 205 (1 order, 39 keys 45 scrap, the one the app
// read) and 18 (4 more, up to 43 keys). Every book read now takes the item's twins too (domain/bookTwins.ts,
// SchemaService.bookBases), and the Live market lists the item once. Stored SKUs are not rewritten. The schema
// is TF2's own item data (test/fixtures/pricedb/schema-subset.json); nothing here touches the network.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { bookBasesOf, canonicalBookBase, mergedBook } from '../../src/service/domain/bookTwins';
import { createEngine } from '../../src/service/domain/engine';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { buildItemDetail } from '../../src/service/domain/views';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, makeListing, noNetwork, recordingEvents, silentLogger, testSettings } from './helpers';

const K = 567;
const FEST = '205;11;australium;festive';
const FEST_18 = '18;11;australium;festive';
const NAME = 'Strange Festivized Australium Rocket Launcher';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

describe('book twins (SchemaService.bookBases, real schema)', () => {
  it.each([
    // stock and Upgradeable weapons, the class shotguns and pistols
    [FEST, FEST_18, FEST],
    ['211;11', '29;11', '211;11'],
    ['199;11', '9;11', '199;11'],
    ['10;11', '199;11', '199;11'],
    ['209;11', '23;11', '209;11'],
    // the duplicate Name Tag, promo and Genuine-only copies
    ['5020;6', '2093;6', '5020;6'],
    ['160;3', '294;3', '160;3'],
    ['811;1', '832;1', '832;1'],
    ['810;14', '831;14', '810;14'],
    // a skin-specific weapon with its own paintkit, a War Paint and its paintkit's own War Paint
    ['201;11;w1;pk14', '15000;11;w1;pk14', '15000;11;w1;pk14'],
    ['9536;15;w5;pk104', '16104;15;w5;pk104', '16104;15;w5;pk104'],
    // Mann Co. crates of one series, and a kit's target (the kit tier stays)
    ['5022;6;c10', '5045;6;c10', '5045;6;c10'],
    ['6526;6;uncraftable;kt-3;td-18', '6526;6;uncraftable;kt-3;td-205', '6526;6;uncraftable;kt-3;td-205'],
  ])('%s and %s are one book, keyed %s', (a, b, canonical) => {
    expect(schema.bookBases!(a)).toContain(b);
    expect(schema.bookBases!(b)).toContain(a);
    expect(schema.bookBase!(a)).toBe(canonical);
    expect(schema.bookBase!(b)).toBe(canonical);
  });

  it('never twins kit tiers, targeted tools, retired keys, a skin of another paintkit or another item', () => {
    for (const base of ['6526;6;kt-3;td-205', '6522;6;td-378', '5021;6', '20003;6;kt-3;td-205;od-6526;oq-6']) {
      const twins = schema.bookBases!(base).filter((b) => b !== base);
      expect(twins.some((b) => /^(6523|6527|5049|5067|20002);/.test(b)), base).toBe(false);
    }
    expect(schema.bookBases!('6526;6;kt-3;td-205')).not.toContain('6523;6;kt-3;td-205');
    expect(schema.bookBases!('201;11')).not.toContain('15000;11');
    expect(schema.bookBases!('378;6')).toEqual(['378;6']);
    expect(schema.bookBases!('205;11')).not.toContain('208;11');
  });

  it('keeps everything but the defindex: quality, australium, festive, killstreak, series', () => {
    for (const b of schema.bookBases!('205;11;australium;kt-3;festive')) expect(b).toMatch(/^(18|205);11;australium;kt-3;festive$/);
  });

  it('files twin rows under the book they are read for, so one buyer counts once', () => {
    const own = makeListing({ id: 'own', steamid: 'S1', sku: FEST, baseSku: FEST });
    const twin = makeListing({ id: 'twin', steamid: 'S2', sku: FEST_18, baseSku: FEST_18 });
    const merged = mergedBook(FEST, bookBasesOf(schema, FEST), (b) => (b === FEST ? [own] : b === FEST_18 ? [twin] : []));
    expect(merged.map((l) => [l.id, l.baseSku, l.sku])).toEqual([
      ['own', FEST, FEST],
      ['twin', FEST, FEST_18],
    ]);
    // Without a schema (or a test double without bookBases) a book is its own rows.
    expect(bookBasesOf(null, FEST)).toEqual([FEST]);
    expect(canonicalBookBase(undefined, FEST_18)).toBe(FEST_18);
  });
});

describe('the engine, the Live market and the drawer read one book from every twin', () => {
  async function setup() {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const settings = testSettings();
    const real = createSchemaService(schemaDeps(schemaRoute(), { repo }));
    await real.init();
    const engine = createEngine({ ...makeDeps(repo, clock, () => settings), schema: real, events: recordingEvents(), timers });
    let list!: ReturnType<typeof createScraptfListCache>;
    const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow());
    list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
    const market = createMarketIndex({
      ...makeDeps(repo, clock, () => settings),
      http: noNetwork,
      schema: real,
      timers,
      keyPrice,
      onChanged: () => undefined,
      folderWatchActive: () => false,
      scraptfList: list,
    });
    return { repo, clock, timers, settings, real, engine, market };
  }

  const order = (id: string, base: string, keys: number, scrap = 0) =>
    makeListing({ id, steamid: `S-${id}`, sku: base, baseSku: base, keys, metalScrap: scrap, itemName: NAME, lastEventAt: T0 - MIN, userOnline: true });

  it('prices a scrap.tf 205 copy against the orders filed under 18 too (best order, buyer count)', async () => {
    const h = await setup();
    const price = h.repo.upsertScrapPrice({ sku: FEST, name: NAME, costKeys: 44, costScrap: 0, source: 'import', observedAt: T0 - MIN });
    h.repo.upsertListings([order('a205', FEST, 39, 45), order('b18', FEST_18, 43), order('c18', FEST_18, 42, 154)]);
    await h.engine.runNow();
    const opp = h.repo.getOpportunity(`${FEST}|price:${price.id}`)!;
    expect(opp.buyerCount).toBe(3);
    expect(opp.bestOrder?.listingId).toBe('b18');
    expect(opp.bestScrap).toBe(43 * K);
    // No second row for the twin base: rule or price.
    expect(h.repo.opportunitiesForSku(FEST_18)).toEqual([]);
  });

  it('makes one rule row per item, on its canonical base, even when every order sits under the stock twin', async () => {
    const h = await setup();
    const rule = h.repo.upsertRule({ name: 'Rocket launchers', filter: { defindexes: [18, 205] }, costKeys: 30, costScrap: 0, observedAt: T0 });
    h.repo.upsertListings([order('b18', FEST_18, 43), order('c18', FEST_18, 42, 154)]);
    await h.engine.runNow();
    expect(h.repo.opportunitiesForSku(FEST_18)).toEqual([]);
    expect(h.repo.getOpportunity(`${FEST}|rule:${rule.id}`)).toMatchObject({ buyerCount: 2, bestOrder: { listingId: 'b18' } });
  });

  it('re-evaluates the 205 copy when an order under 18 changes (markDirty of a twin)', async () => {
    const h = await setup();
    const price = h.repo.upsertScrapPrice({ sku: FEST, name: NAME, costKeys: 44, costScrap: 0, source: 'import', observedAt: T0 - MIN });
    h.repo.upsertListings([order('a205', FEST, 39, 45), order('b18', FEST_18, 43)]);
    h.engine.start();
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(`${FEST}|price:${price.id}`)?.bestOrder?.listingId).toBe('b18');
    h.repo.upsertListings([order('d18', FEST_18, 47)]);
    h.engine.markDirty([FEST_18]);
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(`${FEST}|price:${price.id}`)).toMatchObject({ buyerCount: 3, bestOrder: { listingId: 'd18' }, bestScrap: 47 * K });
    h.engine.stop();
  });

  it('counts a buyer with orders under two twins once', async () => {
    const h = await setup();
    const price = h.repo.upsertScrapPrice({ sku: FEST, name: NAME, costKeys: 44, costScrap: 0, source: 'import', observedAt: T0 - MIN });
    const same = makeListing({ id: 'x18', steamid: 'SAME', sku: FEST_18, baseSku: FEST_18, keys: 43, metalScrap: 0, itemName: `The ${NAME}`, lastEventAt: T0 - MIN });
    const older = makeListing({ id: 'x205', steamid: 'SAME', sku: FEST, baseSku: FEST, keys: 40, metalScrap: 0, itemName: NAME, lastEventAt: T0 - 2 * MIN });
    h.repo.upsertListings([same, older]);
    await h.engine.runNow();
    expect(h.repo.getOpportunity(`${FEST}|price:${price.id}`)).toMatchObject({ buyerCount: 1, bestOrder: { listingId: 'x18' } });
    const detail = buildItemDetail({ repo: h.repo, schema: h.real, sku: FEST, keyPrice: null, settings: h.settings, now: h.clock.now(), snapshot: null as never });
    expect(detail!.buyOrders.find((o) => o.listingId === 'x205')?.flags).toContain('duplicate');
  });

  it('lists the item once in the Live market, under the twin your price is on, and finds it from either base', async () => {
    const h = await setup();
    h.repo.upsertListings([order('a205', FEST, 39, 45), order('b18', FEST_18, 43)]);
    h.market.start();
    await h.timers.advance(0);
    for (let i = 0; i < 5; i++) await h.timers.advance(100);
    const rows = h.market.list({ search: 'Festivized Australium Rocket Launcher' }, h.clock.now()).rows;
    expect(rows.map((r) => [r.sku, r.buyerCount])).toEqual([[FEST, 2]]);
    expect(h.market.entryFor(FEST_18)?.buyerCount).toBe(2);
    // A price of yours on the stock twin moves the one row there.
    h.repo.upsertScrapPrice({ sku: FEST_18, name: NAME, costKeys: 44, costScrap: 0, source: 'user', observedAt: T0 - MIN });
    h.market.pricesChanged();
    for (let i = 0; i < 10; i++) await h.timers.advance(1000);
    expect(h.market.list({ search: 'Festivized Australium Rocket Launcher' }, h.clock.now()).rows.map((r) => r.sku)).toEqual([FEST_18]);
    h.market.stop();
  });

  it("shows the drawer the twins' orders too", async () => {
    const h = await setup();
    h.repo.upsertListings([order('a205', FEST, 39, 45), order('b18', FEST_18, 43)]);
    const detail = buildItemDetail({ repo: h.repo, schema: h.real, sku: FEST, keyPrice: null, settings: h.settings, now: h.clock.now(), snapshot: null as never });
    expect(detail!.buyOrders.map((o) => o.listingId).sort()).toEqual(['a205', 'b18']);
    expect(detail!.revenue?.eligibleCount).toBe(2);
  });
});
