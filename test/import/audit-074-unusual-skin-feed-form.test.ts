// 0.7.4 (F08/F43/F69): unusual skins are keyed the way backpack.tf's buy orders key them. In the live feed 1469
// of the 1477 unusual-skin orders were Unusual (5) plus the effect, 8 were "...;5;u...;strange" and 8 more a
// Strange (11) primary with the effect (market_name "Strange X"), and none the Decorated (15) plus effect form
// 0.7.3 keyed the import, typed names and stats links by: every unusual skin met an empty book. The canonical
// form is Unusual plus the effect, strange as quality2; both feed forms are mapped to it at ingest
// (canonicalUnusualSkin), and books are read across every form (SchemaService.bookBases) so rows stored before
// are still reached. Plain skins stay Decorated (15) and strange skins without an effect Strange (11). Real
// schema (test/fixtures/pricedb/schema-subset.json); synthetic cards, rows and feed documents; nothing is fetched.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listingFromSnapshot, mapWsPayload } from '../../src/service/connectors/bptfItem';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine } from '../../src/service/domain/engine';
import { parseScrapTfHtml } from '../../src/service/import/scraptfHtml';
import { canonicalUnusualSkin, fromObject, fromString } from '../../src/shared/sku';
import type { Listing } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, makeListing, recordingEvents, testSettings } from '../domain/helpers';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';

const NOW = T0;
let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** A buy order as the feed sends it for a Night Owl Sniper Rifle (FN) with the Hot effect. */
function feed(item: Record<string, unknown>): Listing {
  const r = mapWsPayload(
    {
      id: `440_76561198000000001_${Object.values(item).length}`,
      steamid: '76561198000000001',
      appid: 440,
      intent: 'buy',
      currencies: { keys: 30 },
      item: {
        appid: 440,
        defindex: 15000,
        baseName: 'Sniper Rifle',
        name: 'Hot Night Owl Sniper Rifle (Factory New)',
        marketName: 'Unusual Night Owl Sniper Rifle (Factory New)',
        quality: { id: 5, name: 'Unusual' },
        particle: { id: 701, name: 'Hot' },
        texture: { id: 14, name: 'Night Owl' },
        wearTier: { id: 1, name: 'Factory New' },
        priceindex: '701',
        ...item,
      },
    },
    schema,
    NOW,
  );
  if (!r.ok) throw new Error(`not mapped: ${r.detail}`);
  return r.listing;
}

const HOT = "opacity:1;background-image:url('/img/particles_440/701_380x380.png');";

function card(cls: string, title: string, style: string): string {
  return `<div data-appid="440" data-defindex="15000" data-item-value="900" class="item hoverable ${cls} app440" style="${style}" data-title="${title}"><div class="item-value-indicator">100 ref</div></div>`;
}

function parseCard(cls: string, title: string, style = HOT): string | null {
  const html = `<!DOCTYPE html>\n<!-- saved from url=(0026)https://scrap.tf/buy/skins -->\n<html><head><title>Skins</title></head><body>${card(cls, title, style)}</body></html>`;
  const items = parseScrapTfHtml(html, schema).items;
  expect(items).toHaveLength(1);
  return items[0]!.sku;
}

describe('the import, the feed and the resolver key an unusual skin alike (real schema)', () => {
  it('keys the plain unusual skin Unusual plus the effect on every side', () => {
    const want = '15000;5;u701;w1;pk14';
    expect(feed({}).baseSku).toBe(want);
    expect(parseCard('quality5', 'Unusual Night Owl Sniper Rifle (Factory New)')).toBe(want);
    expect(parseCard('quality15', 'Hot Night Owl Sniper Rifle (Factory New)')).toBe(want);
    expect(schema.resolve('Hot Night Owl Sniper Rifle (Factory New)')?.sku).toBe(want);
    expect(schema.resolve('Unusual Hot Night Owl Sniper Rifle (Factory New)')?.sku).toBe(want);
    expect(schema.resolve(schema.nameForSku(want))?.sku).toBe(want);
  });

  it('keys a strange unusual skin Unusual plus the effect plus strange, from either feed form', () => {
    const want = '15000;5;u701;w1;pk14;strange';
    expect(feed({ elevatedQuality: { id: 11, name: 'Strange' }, name: 'Strange Hot Night Owl Sniper Rifle (Factory New)' }).baseSku).toBe(want);
    // backpack.tf's other form: Strange primary with the effect (market_name "Strange Night Owl ...").
    expect(feed({ quality: { id: 11, name: 'Strange' }, name: 'Strange Hot Night Owl Sniper Rifle (Factory New)', marketName: 'Strange Night Owl Sniper Rifle (Factory New)' }).baseSku).toBe(want);
    // A Decorated document with the effect (the 0.7.3 synthetic shape) lands on it too.
    expect(feed({ quality: { id: 15, name: 'Decorated Weapon' }, elevatedQuality: { id: 11, name: 'Strange' } }).baseSku).toBe(want);
    expect(parseCard('quality5 quality11', 'Strange Unusual Night Owl Sniper Rifle (Factory New)')).toBe(want);
    expect(parseCard('quality11', 'Strange Hot Night Owl Sniper Rifle (Factory New)')).toBe(want);
    expect(schema.resolve('Strange Hot Night Owl Sniper Rifle (Factory New)')?.sku).toBe(want);
  });

  it('maps a snapshot row of the Strange-primary form to the same key', () => {
    const l = listingFromSnapshot(
      {
        steamid: '76561198000000002',
        intent: 'buy',
        currencies: { keys: 25 },
        item: {
          defindex: 15000,
          quality: 11,
          attributes: [
            { defindex: 2041, value: 701 },
            { defindex: 834, value: 14 },
            { defindex: 725, float_value: 0.04 },
          ],
        },
      },
      schema,
      NOW,
      'Strange Hot Night Owl Sniper Rifle (Factory New)',
    );
    expect(l?.baseSku).toBe('15000;5;u701;w1;pk14;strange');
  });

  it('keeps plain and strange skins without an effect as before', () => {
    expect(parseCard('quality15', 'Night Owl Sniper Rifle (Factory New)', 'opacity:1;')).toBe('15000;15;w1;pk14');
    expect(parseCard('quality11', 'Strange Night Owl Sniper Rifle (Factory New)', 'opacity:1;')).toBe('15000;11;w1;pk14');
    expect(schema.resolve('Night Owl Sniper Rifle (Factory New)')?.sku).toBe('15000;15;w1;pk14');
    expect(schema.resolve('Strange Night Owl Sniper Rifle (Factory New)')?.sku).toBe('15000;11;w1;pk14');
    expect(fromObject(canonicalUnusualSkin(fromString('15000;15;w1;pk14')))).toBe('15000;15;w1;pk14');
    expect(fromObject(canonicalUnusualSkin(fromString('15000;11;w1;pk14')))).toBe('15000;11;w1;pk14');
    expect(fromObject(canonicalUnusualSkin(fromString('378;5;u13;strange')))).toBe('378;5;u13;strange');
  });

  it('keys an /items row of an unusual skin as its card is keyed', () => {
    const html =
      '<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head><body id="pid-items"><table>' +
      '<thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead><tbody>' +
      '<tr data-quality="5" data-defindex="15000"><td></td><td>Hot Night Owl Sniper Rifle (Factory New)</td><td>30 keys</td><td>28 keys</td><td><div title="1/2"></div></td></tr>' +
      '</tbody></table></body></html>';
    expect(parseScrapTfHtml(html, schema).items.map((i) => i.sku)).toEqual(['15000;5;u701;w1;pk14']);
  });
});

describe('books are read across every form an unusual skin was keyed by', () => {
  it('names the feed and 0.7.3 forms (and the defindex twins) as one book', () => {
    const strange = schema.bookBases!('15000;5;u701;w1;pk14;strange');
    expect(strange).toEqual(expect.arrayContaining(['15000;11;u701;w1;pk14', '15000;15;u701;w1;pk14;strange', '201;5;u701;w1;pk14;strange', '201;11;u701;w1;pk14']));
    expect(schema.bookBase!('201;15;u701;w1;pk14;strange')).toBe('15000;5;u701;w1;pk14;strange');
    expect(schema.bookBases!('15000;15;u701;w1;pk14')).toEqual(expect.arrayContaining(['15000;5;u701;w1;pk14', '201;5;u701;w1;pk14']));
    // A plain skin's book never takes the unusual forms.
    expect(schema.bookBases!('15000;15;w1;pk14').some((b) => /;u\d/.test(b))).toBe(false);
  });

  it('prices a price stored in the 0.7.3 form against the buyers of the feed form', async () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
    const real = createSchemaService(schemaDeps(schemaRoute(), { repo }));
    await real.init();
    const clock = new FakeClock();
    const settings = testSettings();
    const engine = createEngine({ ...makeDeps(repo, clock, () => settings), schema: real, events: recordingEvents(), timers: new FakeTimers(clock) });
    const old = '15000;15;u701;w1;pk14';
    const price = repo.upsertScrapPrice({ sku: old, name: 'Hot Night Owl Sniper Rifle (Factory New)', costKeys: 20, costScrap: 0, source: 'import', observedAt: T0 - MIN });
    repo.upsertListings([
      makeListing({ id: 'feed', steamid: 'B1', sku: '201;5;u701;w1;pk14', baseSku: '201;5;u701;w1;pk14', keys: 28, metalScrap: 0, itemName: 'Hot Night Owl Sniper Rifle (Factory New)', lastEventAt: T0 - MIN }),
    ]);
    await engine.runNow();
    expect(repo.getOpportunity(`${old}|price:${price.id}`)).toMatchObject({ buyerCount: 1, bestOrder: { listingId: 'feed' } });
  });
});
