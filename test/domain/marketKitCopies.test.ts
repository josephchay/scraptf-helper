// 0.7.2: one look of /buy/killstreaks stores a kit base once per sheen/killstreaker combo (importSavedPage
// keeps the cheapest card per base SKU and extras), every copy at the page's time. The Live market row
// showed the copy with the highest id, the one stored last, so a 20-key copy under the "Pay up to" ceiling
// could hide behind a 37-key one and the flip never showed. Of copies seen at one time the row now shows
// the cheapest at the read's key price (equal costs: the higher id); copies of different looks still follow
// newest-wins. The kit base is TF2's own (test/fixtures/pricedb/schema-subset.json), so the row's name is the
// real one and "Open on scrap.tf" copies "Rocket Launcher Kit" for it. Real in-memory repo, fake clock and
// timers; nothing here touches scrap.tf or any network (the schema comes from a fake HTTP route).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex, type MarketIndex } from '../../src/service/domain/market';
import { scraptfSearchName } from '../../src/renderer/itemMenuModel';
import { marketScraptfButton } from '../../src/renderer/marketModel';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { MarketRow, SpecialAttrs, UnixMs } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, HOUR, MIN, T0, makeDeps, makeListing, special } from './helpers';

/** A Non-Craftable Professional Killstreak Rocket Launcher Kit, as the importer keys a scrap.tf card. */
const KIT = '6526;6;uncraftable;kt-3;td-205';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
});

interface Harness {
  repo: Repo;
  clock: FakeClock;
  timers: FakeTimers;
  market: MarketIndex;
  K(): number;
  row(): MarketRow | undefined;
}

/** A buyer of the kit at 30 keys (any sheen and killstreaker), so its ceiling sits between 20 and 37 keys. */
function setup(): Harness {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  repo.upsertListings([makeListing({ id: 'kit-buyer', sku: KIT, baseSku: KIT, keys: 30, metalScrap: 0, lastEventAt: T0 - MIN, itemName: 'Kit' })]);
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
  });
  return { repo, clock, timers, market, K: () => keyPrice().valueScrap, row: () => market.all({}, clock.now()).find((r) => r.sku === KIT) };
}

function build(h: Harness): void {
  h.market.start();
  h.timers.advance(0);
  expect(h.market.stats().building).toBe(false);
}

interface Copy {
  keys: number;
  scrap: number;
  sheen: number;
  killstreaker: number;
  stock: number;
}

/** One card of a look as importSavedPage stores it: the base SKU, the card's extras, the page's time and batch. */
function store(h: Harness, at: UnixMs, copies: readonly Copy[]): void {
  const batch = h.repo.createImportBatch({ fileName: 'scrap.tf window /buy/killstreaks', pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: copies.length, bank: 'killstreaks' });
  for (const c of copies) {
    const extras: SpecialAttrs = special({ sheen: c.sheen, killstreaker: c.killstreaker });
    h.repo.upsertScrapPrice({ sku: KIT, name: 'Kit', costKeys: c.keys, costScrap: c.scrap, source: 'import', observedAt: at, importBatch: batch, special: extras, stock: c.stock });
  }
}

const CHEAP: Copy = { keys: 20, scrap: 0, sheen: 3, killstreaker: 2005, stock: 2 };
// 37 keys, 40 ref (40 ref = 360 scrap), as the real card's indicator reads.
const DEAR: Copy = { keys: 37, scrap: 360, sheen: 1, killstreaker: 2008, stock: 1 };

describe('Live market: same-look copies of one kit base (0.7.2)', () => {
  it('shows the cheapest copy of one look, whichever was stored last', () => {
    for (const order of [
      [CHEAP, DEAR],
      [DEAR, CHEAP],
    ]) {
      const h = setup();
      store(h, T0 - HOUR, order);
      build(h);
      const r = h.row()!;
      expect(r, 'the kit row').toBeDefined();
      // The ceiling separates the two copies: only the cheap one is a flip.
      expect(r.maxCostScrap).toBeGreaterThan(20 * h.K());
      expect(r.maxCostScrap).toBeLessThan(37 * h.K() + 360);
      expect(r.knownCostScrap).toBe(20 * h.K());
      expect(r.knownSource).toBe('page');
      expect(r.knownObservedAt).toBe(T0 - HOUR);
      // The stock and the profit are the shown copy's.
      expect(r.stock).toBe(2);
      expect(r.verdict).toBe('flip');
      expect(r.profitScrap).not.toBeNull();
      expect(r.flags).toContain('has-extras');
      // The flip is counted and found by the Flip filter.
      expect(h.market.list({ verdicts: ['flip'] }, h.clock.now()).rows.map((x) => x.sku)).toEqual([KIT]);
    }
  });

  it("values the copies at the read's key price: a card priced in metal alone is compared as such", () => {
    // 11 000 scrap (a card read from its data-item-value) against 20 keys: cheaper at 567 a key,
    // dearer once a key is worth 500. Keys before metal would always pick the all-metal card.
    const metal: Copy = { keys: 0, scrap: 11_000, sheen: 2, killstreaker: 2003, stock: 3 };
    const h = setup();
    store(h, T0 - HOUR, [metal, CHEAP]);
    build(h);
    expect(h.K()).toBe(567);
    expect(h.row()).toMatchObject({ knownCostScrap: 11_000, stock: 3 });
    h.repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 500, sellScrap: 503, observedAt: T0 });
    h.market.markAllDirty();
    h.timers.advance(0);
    expect(h.K()).toBe(500);
    expect(h.row()).toMatchObject({ knownCostScrap: 10_000, stock: 2 });
  });

  it('breaks a tie at equal cost by the higher id, so the pick does not depend on the read', () => {
    const twin: Copy = { ...CHEAP, sheen: 7, killstreaker: 2002, stock: 5 };
    const h = setup();
    store(h, T0 - HOUR, [CHEAP, twin]);
    build(h);
    expect(h.row()).toMatchObject({ knownCostScrap: 20 * h.K(), stock: 5 });
    expect(h.market.all({}, h.clock.now()).find((r) => r.sku === KIT)).toMatchObject({ stock: 5 });
  });

  it('still lets a newer look win over a cheaper copy of an older one', () => {
    const h = setup();
    store(h, T0 - 2 * HOUR, [{ ...CHEAP, keys: 15 }]);
    store(h, T0 - HOUR, [DEAR]);
    build(h);
    expect(h.row()).toMatchObject({ knownCostScrap: 37 * h.K() + 360, knownObservedAt: T0 - HOUR, stock: 1, verdict: 'over' });
    // A newer look with two copies: its cheapest, never the older look's 15 keys.
    store(h, T0 - 30 * MIN, [DEAR, { ...CHEAP, keys: 21 }]);
    h.market.pricesChanged();
    expect(h.row()).toMatchObject({ knownCostScrap: 21 * h.K(), knownObservedAt: T0 - 30 * MIN, verdict: 'flip' });
  });

  it('compares a typed price and a page price seen at the same time the same way', () => {
    const h = setup();
    h.repo.upsertScrapPrice({ sku: KIT, name: 'Kit', costKeys: 25, costScrap: 0, source: 'user', observedAt: T0 - HOUR });
    store(h, T0 - HOUR, [DEAR]);
    build(h);
    // The typed price is cheaper; the page's copy, stored after it (the higher id), no longer wins on its id alone.
    expect(h.row()).toMatchObject({ knownSource: 'typed', knownCostScrap: 25 * h.K(), stock: null, verdict: 'flip' });
    store(h, T0 - HOUR, [{ ...CHEAP, keys: 24 }]);
    h.market.pricesChanged();
    expect(h.row()).toMatchObject({ knownSource: 'page', knownCostScrap: 24 * h.K(), stock: 2 });
  });

  it('follows an import (pricesChanged) that adds a cheaper copy to the same look, and keeps it past a dearer one', () => {
    const h = setup();
    store(h, T0 - HOUR, [DEAR]);
    build(h);
    expect(h.row()).toMatchObject({ verdict: 'over' });
    store(h, T0 - HOUR, [CHEAP]);
    h.market.pricesChanged();
    expect(h.row()).toMatchObject({ knownCostScrap: 20 * h.K(), verdict: 'flip', stock: 2 });
    // A dearer copy stored after it (now the highest id) does not take the row back.
    store(h, T0 - HOUR, [{ ...DEAR, sheen: 5, stock: 4 }]);
    h.market.pricesChanged();
    expect(h.row()).toMatchObject({ knownCostScrap: 20 * h.K(), verdict: 'flip', stock: 2 });
  });
});

describe('"Open on scrap.tf" for a kit row (0.7.2)', () => {
  it("copies the weapon's kit name, part of scrap.tf's card title, from the row's real name", () => {
    const h = setup();
    store(h, T0 - HOUR, [CHEAP]);
    build(h);
    const r = h.row()!;
    expect(r.name).toBe('Non-Craftable Professional Killstreak Rocket Launcher Kit');
    expect(scraptfSearchName(r)).toBe('Rocket Launcher Kit');
    expect(marketScraptfButton(r, h.clock.now()).name).toBe('Rocket Launcher Kit');
    // scrap.tf's title (the real card's) and Steam's own forms all contain it; the row's name is not in the first.
    for (const title of ['Professional Rocket Launcher Kit', 'Professional Killstreak Rocket Launcher Kit', r.name]) expect(title).toContain(scraptfSearchName(r));
    expect('Professional Rocket Launcher Kit').not.toContain(r.name);
  });
});
