// 0.7.3 (audit): scrap.tf titles a Taunt Unusualifier card with Steam's own Craftable name ("Unusual Taunt:
// Kazotsky Kick Unusualifier"), and the saved-page import keys the card Non-Craftable, as backpack.tf keys
// almost every one (9258;5;uncraftable;td-1157). A copied title resolved to the Craftable 9258;5;td-1157,
// which no import stores and nobody buys, so the check said no price or no buyers instead of the flip. A
// plain name now reads as the SKU the import stores; a SKU, an item link or "Non-Craftable" is kept as
// written. The schema is TF2's own item data (test/fixtures/pricedb/schema-subset.json). Nothing here
// touches scrap.tf or any network.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createLiveCheck, parseCheckText, type ParseCheckResult, type ParsedCheck } from '../../src/service/domain/liveCheck';
import { createMarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import { parseScrapTfHtml } from '../../src/service/import/scraptfHtml';
import { fromString } from '../../src/shared/sku';
import type { Listing, ResolvedItem } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, makeListing, noNetwork, silentLogger, testSettings } from './helpers';

const KAZOTSKY = 'Unusual Taunt: Kazotsky Kick Unusualifier';
const STORED = '9258;5;uncraftable;td-1157';
const CRAFTABLE = '9258;5;td-1157';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function ok(r: ParseCheckResult): ParsedCheck {
  if (!r.ok) throw new Error(`expected an item, got ${r.status}: ${r.reason}`);
  return r.parsed;
}
const parse = (text: string, resolve: (t: string) => ResolvedItem | null = (t) => schema.resolve(t)) => parseCheckText(text, resolve);

/** A saved /buy/items page with one unusualifier card, as scrap.tf titles it. */
const itemsPage = (title: string) =>
  '<!DOCTYPE html>\n<!-- saved from url=(0026)https://scrap.tf/buy/items -->\n<html><head><title>Buy Items</title></head><body>' +
  `<div class="item hoverable quality5 rarity app440" data-id="1" data-defindex="9258" data-title="<span class='quality5'>${title}</span>" data-content="Level 5" data-item-value="3384"><div class="item-value-indicator">6 keys</div></div>` +
  '</body></html>';

describe('the Live check reads a copied unusualifier title as the import keys the card (real schema)', () => {
  it.each([
    [KAZOTSKY, STORED],
    ['Unusual Taunt: The Schadenfreude Unusualifier', '9258;5;uncraftable;td-463'],
  ])('%j: the SKU the import stores, in every copied form', (title, sku) => {
    expect(parseScrapTfHtml(itemsPage(title), schema).items[0]!.sku).toBe(sku);
    expect(ok(parse(title))).toMatchObject({ form: 'name', item: { sku, match: 'exact' }, fuzzy: false });
    expect(ok(parse(title.toLowerCase())).item.sku).toBe(sku);
    expect(ok(parse(`${title} 6 keys`))).toMatchObject({ form: 'priced', item: { sku }, price: { keys: 6, scrap: 0 } });
    expect(ok(parse(`${title}\t6 keys\t5 keys\t1/3`))).toMatchObject({ form: 'items-row', item: { sku }, stock: 1, stockLimit: 3 });
  });

  it('keeps a SKU, an item link and an explicit Non-Craftable name as written, and a Strangifier Craftable', () => {
    expect(ok(parse(CRAFTABLE)).item.sku).toBe(CRAFTABLE);
    expect(ok(parse('https://backpack.tf/stats/Unusual/Unusualifier/Tradable/Craftable/1157')).item.sku).toBe(CRAFTABLE);
    expect(ok(parse(`Non-Craftable ${KAZOTSKY}`)).item.sku).toBe(STORED);
    expect(ok(parse('Strangifier')).item.sku).toBe('6522;6');
  });

  it('asks the resolver a second time only for an unusualifier name, and keeps the first reading unless the retry is that exact SKU', () => {
    const spy = vi.fn((t: string) => schema.resolve(t));
    ok(parse('Team Captain', spy));
    ok(parse('Strangifier', spy));
    expect(spy.mock.calls.filter(([t]) => /^Non-Craftable/i.test(t))).toEqual([]);
    spy.mockClear();
    ok(parse(KAZOTSKY, spy));
    expect(spy.mock.calls.map((c) => c[0])).toEqual([KAZOTSKY, `Non-Craftable ${KAZOTSKY}`]);

    const reading = (sku: string, match: ResolvedItem['match']): ResolvedItem => ({ sku, name: KAZOTSKY, skuObject: fromString(sku), category: 'other', match, warnings: [] });
    for (const retry of [reading('9258;5;uncraftable;td-463', 'exact'), reading(STORED, 'fuzzy')]) {
      const resolve = (t: string) => (t === KAZOTSKY ? reading(CRAFTABLE, 'exact') : retry);
      expect(ok(parse(KAZOTSKY, resolve)).item.sku, `${retry.sku} ${retry.match}`).toBe(CRAFTABLE);
    }
  });
});

describe('the Live check on a copied unusualifier title (real schema, repo, list cache and market index)', () => {
  async function setup() {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const settings = testSettings();
    let list!: ScraptfListCache;
    const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow());
    list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
    const real = createSchemaService(schemaDeps(schemaRoute(), { repo }));
    await real.init();
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
    market.start();
    await timers.advance(0);
    const lc = createLiveCheck({ repo, schema: real, log: silentLogger, settings: () => settings, keyPrice, market, scraptfList: list });
    return { repo, market, check: (text: string) => lc.check(text, 'manual', clock.now()) };
  }

  const buyer = (keys: number, i: number): Listing =>
    makeListing({ id: `unusualifier-${i}`, steamid: `UQ${i}`, sku: STORED, baseSku: STORED, keys, metalScrap: 0, itemName: `Non-Craftable ${KAZOTSKY}`, lastEventAt: T0 - MIN, userOnline: true });

  it("meets the import's stored price and the Non-Craftable buy orders: a flip, not no price or no buyers", async () => {
    const h = await setup();
    h.repo.upsertScrapPrice({ sku: STORED, name: `Non-Craftable ${KAZOTSKY}`, costKeys: 6, costScrap: 0, source: 'import', observedAt: T0 - 5 * MIN });
    h.repo.upsertListings([12, 11, 10].map((keys, i) => buyer(keys, i)));
    h.market.pricesChanged();
    const r = h.check(KAZOTSKY);
    expect(r).toMatchObject({ status: 'item', sku: STORED, price: { keys: 6, source: 'import' }, verdict: 'flip' });
    expect(r.revenue!.eligibleCount).toBe(3);
    const priced = h.check(`${KAZOTSKY} 6 keys`);
    expect(priced).toMatchObject({ status: 'item', sku: STORED, price: { keys: 6, source: 'clipboard' }, verdict: 'flip' });
    expect(priced.revenue!.eligibleCount).toBe(3);
  });
});
