// 0.7.4 (F17): backpack.tf files some kit orders under the schema's legacy kits ("Sniperrifle Killstreakifier
// Basic", item_name "Kit", 5726-5801): 113 "Non-Craftable Professional Killstreak X Kit" orders sat under SKUs
// like 5728;6;uncraftable;kt-3;td-18;od-3;oq-18, the tier-target priceindex read as an output item. They are kits
// now, keyed by their tier's kit (6526 Professional), and a canonical kit's defindex wins over a killstreakTier
// that disagrees (every such order was priced as its defindex's tier).
// 0.7.4 (F18): the snapshot mapper read "Festivized" out of the taunt effect name "Festivized Formation" and keyed
// every order of such a taunt ";festive", so the reconcile emptied the real book. The effect's own name is not a
// prefix word any more, on the snapshot and the feed paths alike.
// Real schema fixture (test/fixtures/pricedb/schema-subset.json), with the legacy kit row the subset lacks; offline.

import { beforeAll, describe, expect, it } from 'vitest';
import { createMapStats, listingFromSnapshot, mapWsPayload, parseIGetPrices } from '../../src/service/connectors/bptfItem';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaItemRow, SchemaService } from '../../src/service/contracts';
import { parseScrapTfHtml } from '../../src/service/import/scraptfHtml';
import { makeDeps, schemaRoute, T0 } from '../pricedb/helpers';

/** schema_items 5728 in the user's real schema (the subset fixture has the three canonical kits only). */
const LEGACY_KIT: SchemaItemRow = {
  defindex: 5728,
  name: 'Sniperrifle Killstreakifier Basic',
  itemName: 'Kit',
  properName: false,
  itemClass: 'tool',
  slot: null,
  craftClass: null,
  usedByClasses: [],
  imageUrl: null,
};

let real: SchemaService;
let schema: SchemaService;
beforeAll(async () => {
  real = createSchemaService(makeDeps(schemaRoute()));
  await real.init();
  schema = { ...real, itemByDefindex: (d) => (d === 5728 ? LEGACY_KIT : real.itemByDefindex(d)) };
});

function kitOrder(defindex: number, item: Record<string, unknown>) {
  const stats = createMapStats();
  const r = mapWsPayload(
    {
      id: `440_76561198000000001_kit${defindex}`,
      steamid: '76561198000000001',
      appid: 440,
      intent: 'buy',
      currencies: { keys: 95 },
      item: {
        appid: 440,
        defindex,
        baseName: 'Kit',
        name: 'Non-Craftable Professional Killstreak Scattergun Kit',
        quality: { id: 6, name: 'Unique' },
        recipe: { targetItem: { itemName: 'Scattergun', _source: { defindex: 200 } } },
        sheen: { id: 1, name: 'Team Shine' },
        killstreaker: { id: 2002, name: 'Fire Horns' },
        ...item,
      },
    },
    schema,
    T0,
    stats,
  );
  if (!r.ok) throw new Error(r.detail);
  return { listing: r.listing, stats };
}

describe('F17: legacy kit defindexes are kits', () => {
  it("keys a Professional kit order on 5728 as its tier's kit, never as an output item", () => {
    const { listing, stats } = kitOrder(5728, { killstreakTier: 3, priceindex: '3-200' });
    expect(listing.baseSku).toBe('6526;6;uncraftable;kt-3;td-200');
    expect(listing.special).toMatchObject({ sheen: 1, killstreaker: 2002 });
    expect(stats.priceindexMismatches).toBe(0);
    // With no killstreakTier the priceindex gives the tier.
    expect(kitOrder(5728, { priceindex: '3-200' }).listing.baseSku).toBe('6526;6;uncraftable;kt-3;td-200');
  });

  it("lets a canonical kit's defindex win over a killstreakTier that disagrees, and counts it", () => {
    const pro = kitOrder(6526, { killstreakTier: 1, priceindex: '3-200' });
    expect(pro.listing.baseSku).toBe('6526;6;uncraftable;kt-3;td-200');
    expect(pro.stats.unknownShapes['kit-tier-conflict']).toBe(1);
    const basic = kitOrder(6527, { killstreakTier: 3, name: 'Non-Craftable Professional Killstreak Iron Bomber Kit', priceindex: '1-1151', recipe: { targetItem: { _source: { defindex: 1151 } } } });
    expect(basic.listing.baseSku).toBe('6527;6;uncraftable;kt-1;td-1151');
  });

  it('keys a legacy kit snapshot row by its tier and target attributes', () => {
    const l = listingFromSnapshot(
      {
        steamid: '76561198000000003',
        intent: 'buy',
        currencies: { keys: 80 },
        item: { defindex: 5728, quality: 6, flag_cannot_craft: true, attributes: [{ defindex: 2025, float_value: 3 }, { defindex: 2012, float_value: 205 }] },
      },
      schema,
      T0,
      'Non-Craftable Professional Killstreak Rocket Launcher Kit',
    );
    expect(l?.baseSku).toBe('6526;6;uncraftable;kt-3;td-205');
  });

  it("keys a scrap.tf card with a legacy kit defindex as the title's tier's kit", () => {
    const html =
      '<!DOCTYPE html>\n<!-- saved from url=(0032)https://scrap.tf/buy/killstreaks -->\n<html><head><title>Killstreaks</title></head><body>' +
      '<div data-appid="440" data-defindex="5728" data-item-value="900" class="item hoverable quality6 app440" data-title="Professional Rocket Launcher Kit" data-content="Level 1"><div class="item-value-indicator">35 keys</div></div>' +
      '</body></html>';
    expect(parseScrapTfHtml(html, schema).items[0]!.sku).toBe('6526;6;uncraftable;kt-3;td-205');
  });

  it("files a community kit price under its tier's kit once, not under every legacy defindex", () => {
    const out = parseIGetPrices(
      {
        response: {
          success: 1,
          items: {
            'Professional Killstreak Kit': {
              defindex: [5726, 5728, 6526],
              prices: { '6': { Tradable: { 'Non-Craftable': { '3-205': { currency: 'keys', value: 30, last_update: 1790000000 } } } } },
            },
          },
        },
      },
      schema,
    );
    expect(out.rows.map((r) => r.sku)).toEqual(['6526;6;uncraftable;kt-3;td-205']);
  });
});

describe("F46: a copy's craft number is no part of the learned name", () => {
  const order = (name: string, defindex: number, item: Record<string, unknown> = {}) =>
    mapWsPayload(
      { id: `440_76561198000000001_${name}`, steamid: '76561198000000001', appid: 440, intent: 'buy', currencies: { metal: 10 }, item: { appid: 440, defindex, name, quality: { id: 6 }, ...item } },
      real,
      T0,
    );

  it('learns "Team Captain #42" as the plain item, and keeps a crate series', () => {
    const r = order('Team Captain #42', 378);
    expect(r.ok && [r.listing.baseSku, r.name.name]).toEqual(['378;6', 'Team Captain']);
    const crate = order('Mann Co. Supply Crate #10', 5045, { crateSeries: 10 });
    expect(crate.ok && [crate.listing.baseSku, crate.name.name]).toEqual(['5045;6;c10', 'Mann Co. Supply Crate #10']);
  });
});

describe('F18: an effect name is no prefix word', () => {
  const NAME = 'Festivized Formation Taunt: Kazotsky Kick';

  it('keys a Festivized Formation taunt as the feed and the resolver do, never festive', () => {
    for (const attributes of [[{ defindex: 2041, value: 3108 }], [{ defindex: 2041, value: 3109 }], []]) {
      const l = listingFromSnapshot({ steamid: '76561198000000001', intent: 'buy', currencies: { keys: 4 }, item: { defindex: 1157, quality: 5, attributes } }, real, T0, NAME, undefined, '1157;5;u3108');
      expect(l?.baseSku, JSON.stringify(attributes)).toBe('1157;5;u3108');
    }
    const ws = mapWsPayload(
      {
        id: '440_76561198000000001_x',
        steamid: '76561198000000001',
        appid: 440,
        intent: 'buy',
        currencies: { keys: 4 },
        item: { appid: 440, defindex: 1157, baseName: 'Taunt: Kazotsky Kick', name: NAME, quality: { id: 5 }, particle: { id: 3108, name: 'Festivized Formation' } },
      },
      real,
      T0,
    );
    expect(ws.ok && ws.listing.baseSku).toBe('1157;5;u3108');
    expect(real.resolve(NAME)?.sku).toBe('1157;5;u3108');
  });

  it('still reads a real Festivized prefix', () => {
    const l = listingFromSnapshot(
      { steamid: '76561198000000002', intent: 'buy', currencies: { keys: 40 }, item: { defindex: 205, quality: 11, attributes: [{ defindex: 2053, value: 1 }] } },
      real,
      T0,
      'Strange Festivized Rocket Launcher',
    );
    expect(l?.baseSku).toBe('205;11;festive');
    // A name-only festivizer without the attribute.
    expect(listingFromSnapshot({ steamid: '76561198000000003', intent: 'buy', currencies: { keys: 40 }, item: { defindex: 205, quality: 11 } }, real, T0, 'Strange Festivized Rocket Launcher')?.baseSku).toBe('205;11;festive');
  });
});
