// 0.7.4 review (R17, R18, R19): book twins that crossed an item's identity, or missed it.
// - R17: the Upgradeable Bat (190) twins with the stock Bat, defindex 0, and a SKU cannot hold td-0, so every Bat
//   kit, Bat kit fabricator and Bat strangifier book took in the targetless tool's book ("Non-Craftable
//   Professional Killstreak Kit" at 1 key 297 scrap above the Bat kit's own 1 key 99), and a Bat kit snapshot
//   then reconciled that other item's orders away. A target twin is now only one a SKU can hold.
// - R18: bp.tf files Collector's Chemistry Sets under 20001 as often as the parser's 20006/20007, and named
//   strangifiers under 5661 (the Pomson 6000 Strangifier) and other strangifier defindexes beside 6522: their
//   identity is in the SKU (od-X;oq-14, td-X), so every defindex of the item_name is one book, and a snapshot
//   order under the twin defindex keeps the requested output.
// - R19: a strange skin or War Paint without an effect is one bp.tf item keyed 11 and, by some buyers, 15 plus
//   strange: both forms are one book now, the 11 one canonical.
// Real schema fixture (test/fixtures/pricedb/schema-subset.json); R18 adds the four real schema rows the subset
// lacks (20001, 5661, 5754, 1085, copied from a real profile's schema_items). Offline: no request of any kind.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listingFromSnapshot } from '../../src/service/connectors/bptfItem';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { bookBasesOf, mergedBook } from '../../src/service/domain/bookTwins';
import { DEFAULT_KEY_SCRAP } from '../../src/service/domain/keyprice';
import { buildItemDetail } from '../../src/service/domain/views';
import type { Listing } from '../../src/shared/types';
import { fixture, makeDeps as schemaDeps, res, schemaRoute, SCHEMA_URL, type Route } from '../pricedb/helpers';
import { MIN, T0, makeListing, testSettings } from './helpers';

const BAT_KIT = '6526;6;uncraftable;kt-3;td-190';
const GENERIC_KIT = '6526;6;uncraftable;kt-3';

/** The real schema rows the subset fixture lacks, in the schema API's own shape. */
const EXTRA_ITEMS = [
  { name: 'Cosmetic Strangifier Recipe 1 Rare', defindex: 20001, item_class: 'tool', item_type_name: 'Recipe', item_name: 'Chemistry Set', proper_name: false, item_quality: 6, craft_class: 'tool', used_by_classes: [] },
  { name: 'Pomson 6000 Strangifier', defindex: 5661, item_class: 'tool', item_type_name: 'Strangifier', item_name: 'Strangifier', proper_name: false, item_quality: 6, used_by_classes: [] },
  { name: 'Classic Strangifier', defindex: 5754, item_class: 'tool', item_type_name: 'Strangifier', item_name: 'Strangifier', proper_name: false, item_quality: 6, used_by_classes: [] },
  { name: 'Festive Black Box', defindex: 1085, item_class: 'tf_weapon_rocketlauncher', item_type_name: 'Rocket Launcher', item_name: 'Festive Black Box', proper_name: false, item_quality: 6, used_by_classes: ['Soldier'] },
];

/** The fixture schema with EXTRA_ITEMS appended (a copy: the cached fixture is never changed). */
function routeWithExtras(): Route {
  const base = schemaRoute();
  return (url, opts) => {
    if (url !== SCHEMA_URL) return base(url, opts);
    const data = structuredClone(fixture<{ raw: { schema: { items: unknown[] } } }>('schema-subset.json'));
    data.raw.schema.items.push(...EXTRA_ITEMS);
    return res(data, { etag: 'W/"subset-plus-r18"' });
  };
}

let schema: SchemaService;
let extended: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
  extended = createSchemaService(schemaDeps(routeWithExtras()));
  await extended.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const order = (id: string, base: string, keys: number, metalScrap: number, itemName: string): Listing =>
  makeListing({ id, steamid: `S-${id}`, sku: base, baseSku: base, keys, metalScrap, itemName, lastEventAt: T0 - MIN, userOnline: true });

describe('R17: a tool target twins only with targets a SKU can hold', () => {
  it.each([
    [BAT_KIT, GENERIC_KIT],
    ['6523;6;uncraftable;kt-2;td-190', '6523;6;uncraftable;kt-2'],
    ['6527;6;uncraftable;kt-1;td-190', '6527;6;uncraftable;kt-1'],
    ['20003;6;kt-3;td-190;od-6526;oq-6', '20003;6;kt-3;od-6526;oq-6'],
    ['20002;6;kt-2;td-190;od-6523;oq-6', '20002;6;kt-2;od-6523;oq-6'],
    ['6522;6;td-190', '6522;6'],
  ])('%s keeps its own book, never the targetless %s', (bat, targetless) => {
    expect(schema.bookBases!(bat)).toEqual([bat]);
    expect(schema.bookBase!(bat)).toBe(bat);
    expect(schema.bookBases!(targetless)).not.toContain(bat);
    // Every base keeps its target.
    for (const b of schema.bookBases!(bat)) expect(b).toContain(';td-');
  });

  it('still twins the Bat itself with the stock Bat (a defindex, not a target), and other kit targets as before', () => {
    expect(schema.bookBases!('190;6')).toContain('0;6');
    expect(schema.bookBases!('6526;6;uncraftable;kt-3;td-205')).toContain('6526;6;uncraftable;kt-3;td-18');
  });

  it("the Bat kit's drawer lists its own buy orders only, not the generic kit's", () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertListings([
      order('bat', BAT_KIT, 1, 99, 'Non-Craftable Professional Killstreak Bat Kit'),
      order('generic', GENERIC_KIT, 1, 297, 'Non-Craftable Professional Killstreak Kit'),
    ]);
    const detail = buildItemDetail({ repo, schema, sku: BAT_KIT, keyPrice: null, settings: testSettings(), now: T0, snapshot: null as never });
    expect(detail!.buyOrders.map((o) => o.listingId)).toEqual(['bat']);
    expect(detail!.revenue?.bestScrap).toBe(DEFAULT_KEY_SCRAP + 99);
  });
});

describe("R18: targeted strangifiers and Collector's Chemistry Sets are one book across their defindexes", () => {
  it.each([
    // the resolver's Collector's set (20006) and the 20001 bp.tf files most of its orders under
    ['20006;6;od-228;oq-14', '20001;6;od-228;oq-14', '20006;6;od-228;oq-14'],
    // a festive output's set is keyed 20007, as the parser keys it
    ['20007;6;od-1085;oq-14', '20001;6;od-1085;oq-14', '20007;6;od-1085;oq-14'],
    // a named strangifier filed under the Pomson 6000's 5661 and its own 5754
    ['6522;6;td-1098', '5661;6;td-1098', '6522;6;td-1098'],
    ['6522;6;td-1098', '5754;6;td-1098', '6522;6;td-1098'],
    ['6522;6;td-378', '5661;6;td-378', '6522;6;td-378'],
  ])('%s and %s are one book, keyed %s', (a, b, canonical) => {
    expect(extended.bookBases!(a)).toContain(b);
    expect(extended.bookBases!(b)).toContain(a);
    expect(extended.bookBase!(a)).toBe(canonical);
    expect(extended.bookBase!(b)).toBe(canonical);
  });

  it("resolves a Collector's set name to the book that holds bp.tf's orders for it", () => {
    const r = extended.resolve("Collector's Black Box Chemistry Set");
    expect(r?.sku).toBe('20006;6;od-228;oq-14');
    expect(extended.bookBases!(r!.sku)).toContain('20001;6;od-228;oq-14');
    const own = order('c20006', '20006;6;od-228;oq-14', 0, 300, "Collector's Black Box Chemistry Set");
    const filed = order('c20001', '20001;6;od-228;oq-14', 0, 410, "Collector's Black Box Chemistry Set");
    const merged = mergedBook(r!.sku, bookBasesOf(extended, r!.sku), (b) => [own, filed].filter((l) => l.baseSku === b));
    expect(merged.map((l) => [l.id, l.baseSku])).toEqual([
      ['c20006', '20006;6;od-228;oq-14'],
      ['c20001', '20006;6;od-228;oq-14'],
    ]);
  });

  it('never twins kit tiers, a strangifier chemistry set, another output or a bare tool', () => {
    expect(extended.bookBases!('6526;6;kt-3;td-205')).not.toContain('6523;6;kt-3;td-205');
    expect(extended.bookBases!('20003;6;kt-3;td-205;od-6526;oq-6').some((b) => b.startsWith('20002;'))).toBe(false);
    expect(extended.bookBases!('20000;6;td-378;od-6522;oq-6')).toEqual(['20000;6;td-378;od-6522;oq-6']);
    expect(extended.bookBases!('20006;6;od-228;oq-14')).not.toContain('20001;6;od-1085;oq-14');
    for (const b of extended.bookBases!('6522;6;td-1098')) expect(b).toMatch(/;td-1098$/);
    expect(extended.bookBases!('6522;6')).toEqual(['6522;6']);
  });

  it("files a snapshot order under the twin defindex with the requested output, not as a bare 20001;6", () => {
    const raw = (defindex: number) => ({ steamid: '76561198000000009', intent: 'buy', currencies: { metal: 45.55 }, item: { defindex, quality: 6 } });
    const name = "Collector's Black Box Chemistry Set";
    expect(listingFromSnapshot(raw(20001), extended, T0, name, undefined, '20006;6;od-228;oq-14')?.baseSku).toBe('20001;6;od-228;oq-14');
    expect(listingFromSnapshot(raw(20006), extended, T0, name, undefined, '20006;6;od-228;oq-14')?.baseSku).toBe('20006;6;od-228;oq-14');
    // A defindex outside the requested book gets nothing from it.
    expect(listingFromSnapshot(raw(20002), extended, T0, name, undefined, '20006;6;od-228;oq-14')?.baseSku).not.toContain('od-228');
  });
});

describe('R19: a strange skin is one book in its 11 and Decorated-plus-strange forms', () => {
  it.each([
    ['9536;11;w5;pk104', '16104;15;w5;pk104;strange', '16104;11;w5;pk104'],
    ['16104;11;w5;pk104', '9536;15;w5;pk104;strange', '16104;11;w5;pk104'],
    ['15000;11;w1;pk14', '15000;15;w1;pk14;strange', '15000;11;w1;pk14'],
    ['201;11;w1;pk14', '15000;15;w1;pk14;strange', '15000;11;w1;pk14'],
  ])('%s and %s are one book, keyed %s', (a, b, canonical) => {
    expect(schema.bookBases!(a)).toContain(b);
    expect(schema.bookBases!(b)).toContain(a);
    expect(schema.bookBase!(a)).toBe(canonical);
    expect(schema.bookBase!(b)).toBe(canonical);
  });

  it('leaves a Decorated skin that is not strange, and anything without a paintkit, as it was', () => {
    for (const b of schema.bookBases!('16104;15;w5;pk104')) expect(b).toMatch(/;15;w5;pk104$/);
    for (const b of schema.bookBases!('201;11')) expect(b).not.toContain(';15');
  });

  it('reads the 15-plus-strange buyer as an exit of the 11-form item', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertListings([
      order('s11', '16104;11;w5;pk104', 2, 32, 'Strange Pumpkin Pied War Paint (Field-Tested)'),
      order('s15', '16104;15;w5;pk104;strange', 2, 295, 'Strange Pumpkin Pied War Paint (Field-Tested)'),
    ]);
    const detail = buildItemDetail({ repo, schema, sku: '16104;11;w5;pk104', keyPrice: null, settings: testSettings(), now: T0, snapshot: null as never });
    expect(detail!.buyOrders.map((o) => o.listingId).sort()).toEqual(['s11', 's15']);
    expect(detail!.revenue?.bestScrap).toBe(2 * DEFAULT_KEY_SCRAP + 295);
  });
});
