// 0.7.2: the stub schema most import tests use must name items as TF2's own schema does wherever the
// schema subset (test/fixtures/pricedb/schema-subset.json, TF2's rows) holds them. It named the professional
// kit "Professional Killstreak Kit" where TF2 says "Kit", so stub-based tests took a code path real pages
// never take and hid that every kit was stored as its bare defindex. Left as they are, on purpose: the stub
// never writes the leading "The" of a proper name ("Team Captain", TF2 "The Team Captain"; display only),
// keeps the item's own name where TF2 has an internal one ("Upgradeable TF_WEAPON_ROCKETLAUNCHER"), its own
// paintkit ids, and has no Bread Bite (1100), for a kit whose weapon the schema does not know.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { parseScrapTfHtml } from '../../src/service/import/scraptfHtml';
import { fromString } from '../../src/shared/sku';
import { fixture, makeDeps, res, SCHEMA_URL, schemaRoute } from '../pricedb/helpers';
import { createStubSchema, STUB_ITEMS, STUB_RESOLVE } from './schemaStub';

interface SubsetItem {
  defindex: number;
  item_name: string;
  item_class: string;
}
interface Subset {
  raw: { schema: { items: SubsetItem[] } };
}

const subset = fixture<Subset>('schema-subset.json');
const real = new Map(subset.raw.schema.items.map((i) => [i.defindex, i]));
const held = STUB_ITEMS.filter((i) => real.has(i.defindex));
const stub = createStubSchema();

let schema: SchemaService;
/** The subset plus TF2's row for Taunt: Conga (1118), the target of buy_items.html's unusualifier (I24). */
let withConga: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
  const raw = structuredClone(subset);
  raw.raw.schema.items.push({ name: 'Conga Taunt', defindex: 1118, item_class: 'no_entity', item_name: 'Taunt: Conga', item_slot: 'taunt', item_quality: 6, proper_name: false } as SubsetItem);
  const route = schemaRoute();
  withConga = createSchemaService(makeDeps((url, opts) => (url === SCHEMA_URL ? res(raw, { etag: 'W/"conga"' }) : route(url, opts))));
  await withConga.init();
});

const pageFixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

describe('the stub schema against TF2 (schema subset)', () => {
  it('names every item the subset holds by its TF2 item_name ("Kit", "Fabricator", "Strangifier", "Unusualifier")', () => {
    expect(held.length).toBeGreaterThan(50);
    expect(held.filter((i) => real.get(i.defindex)!.item_name !== i.itemName).map((i) => [i.defindex, i.itemName, real.get(i.defindex)!.item_name])).toEqual([]);
    for (const d of [6522, 6523, 6526, 6527, 9258, 20002, 20003]) expect(held.map((i) => i.defindex)).toContain(d);
  });

  it('agrees on what the parser reads of an item: a tool, a supply crate, and its item_quality', () => {
    const kind = (itemClass: string): string => (itemClass === 'tool' || itemClass === 'supply_crate' ? itemClass : 'other');
    expect(held.filter((i) => kind(i.itemClass) !== kind(real.get(i.defindex)!.item_class)).map((i) => [i.defindex, i.itemClass, real.get(i.defindex)!.item_class])).toEqual([]);
    expect(held.filter((i) => stub.itemQuality(i.defindex) !== schema.itemQuality(i.defindex)).map((i) => [i.defindex, stub.itemQuality(i.defindex), schema.itemQuality(i.defindex)])).toEqual([]);
  });

  it.each([
    // Kits as the import keys them (Non-Craftable), and the Craftable form backpack.tf also lists.
    '6526;6;uncraftable;kt-3;td-205',
    '6526;6;kt-3;td-205',
    '6523;6;uncraftable;kt-2;td-200',
    '6527;6;uncraftable;kt-1;td-199',
    '6526;6',
    '6526;6;uncraftable',
    '20003;6;kt-3;td-205;od-6526;oq-6',
    '20003;6;uncraftable;kt-3;td-205;od-6526;oq-6',
    '20002;6;kt-2;td-1013;od-6523;oq-6',
    '6522;6;td-378',
    '9258;5;uncraftable;td-1157',
    '5078;6;c46',
    '5022;6',
  ])('names %s as TF2 does', (sku) => {
    expect(stub.nameForSku(sku)).toBe(schema.nameForSku(sku));
    expect(stub.baseNameForSku(sku)).toBe(schema.baseNameForSku(sku));
  });

  it('resolves each name it knows to the SKU the real resolver gives, where the subset holds its items', () => {
    const inSubset = (sku: string): boolean => {
      const o = fromString(sku);
      return [o.defindex, o.target, o.output].every((d) => d === null || real.has(d));
    };
    const names = Object.keys(STUB_RESOLVE);
    expect(names.filter((n) => !inSubset(STUB_RESOLVE[n]!))).toEqual(['unusual taunt: conga unusualifier']);
    for (const n of names) {
      const s = inSubset(STUB_RESOLVE[n]!) ? schema : withConga;
      expect([n, s.resolve(n)?.sku]).toEqual([n, STUB_RESOLVE[n]]);
    }
  });

  it.each<[string, string[]]>([
    ['buy_killstreaks.html', ['9500000011', '9500000012', '9500000013', '9500000014', '9500000015']],
    // Not I19: the stub has no Bread Bite, on purpose.
    ['buy_items.html', ['9700000017', '9700000018', '9700000023', '9700000024']],
  ])('keys and names the kit, fabricator, strangifier and unusualifier cards of %s as TF2 does', (file, ids) => {
    const html = pageFixture(file);
    const pick = (s: SchemaService) =>
      parseScrapTfHtml(html, s)
        .items.filter((i) => ids.includes(i.assetId ?? ''))
        .map((i) => [i.assetId, i.sku, i.name, i.warnings]);
    const got = pick(stub);
    expect(got.map((g) => g[0])).toEqual(ids);
    expect(got).toEqual(pick(withConga));
  });
});
