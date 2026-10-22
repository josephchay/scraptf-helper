// 0.7.4 (F09 step 4): PriceDB and backpack.tf price an item under its name, which the app keys by the book's
// canonical base (SchemaService.bookBase). A card or price filed under a non-canonical twin defindex
// (18;11;australium beside 205;11;australium, 811;1 beside the Genuine-only 832;1) found no reference before,
// so its confidence and cost checks ran without one. lookupReferences now takes a missing source's row from
// the canonical base. Local reads only. The schema is TF2's own item data (test/fixtures/pricedb/schema-subset.json).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { lookupReferences } from '../../src/service/domain/pricing';
import { buildItemDetail } from '../../src/service/domain/views';
import type { CommunityRow, PricedbRow } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { T0, testSettings } from './helpers';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});
function repo(): Repo {
  const r = openRepo(':memory:');
  repos.push(r);
  return r;
}

const pdb = (sku: string, buyScrap: number, sellScrap: number): PricedbRow => ({
  sku,
  name: sku,
  buyKeys: 0,
  buyScrap,
  sellKeys: 0,
  sellScrap,
  time: Math.floor(T0 / 1000) - 3600,
  fetchedAt: T0 - 60_000,
});
const community = (sku: string, value: number): CommunityRow => ({ sku, currency: 'metal', value, valueHigh: null, lastUpdate: Math.floor(T0 / 1000) - 3600 });

describe('lookupReferences reads the canonical twin of the book (F09)', () => {
  it('takes the canonical base row for a twin base that has none of its own', () => {
    expect(schema.bookBase!('18;11;australium')).toBe('205;11;australium');
    const r = repo();
    r.upsertPricedb([pdb('205;11;australium', 900, 950)]);
    r.upsertCommunity([community('205;11;australium', 100)]);
    const refs = lookupReferences(r, '18;11;australium', schema);
    expect(refs.pricedb?.sku).toBe('205;11;australium');
    expect(refs.community?.sku).toBe('205;11;australium');
    // Without a schema (or for the canonical base itself) the lookup is the base's own, as before.
    expect(lookupReferences(r, '18;11;australium')).toEqual({ pricedb: null, community: null });
    expect(lookupReferences(r, '205;11;australium', schema).pricedb?.sku).toBe('205;11;australium');
  });

  it("keeps the base's own row, and fills only the source it lacks", () => {
    const r = repo();
    r.upsertPricedb([pdb('205;11;australium', 900, 950), pdb('18;11;australium', 880, 940)]);
    r.upsertCommunity([community('205;11;australium', 100)]);
    const refs = lookupReferences(r, '18;11;australium', schema);
    expect(refs.pricedb?.sku).toBe('18;11;australium');
    expect(refs.community?.sku).toBe('205;11;australium');
  });

  it('reads the Genuine-only copy for a Genuine card filed under the plain defindex', () => {
    expect(schema.bookBase!('811;1')).toBe('832;1');
    const r = repo();
    r.upsertPricedb([pdb('832;1', 300, 330)]);
    expect(lookupReferences(r, '811;1', schema).pricedb?.sku).toBe('832;1');
    // An item with no twin finds nothing new.
    expect(lookupReferences(r, '378;6', schema)).toEqual({ pricedb: null, community: null });
  });

  it("gives the drawer of a twin-filed item the canonical item's PriceDB price", () => {
    const r = repo();
    r.upsertPricedb([pdb('205;11;australium', 900, 950)]);
    const d = buildItemDetail({ repo: r, schema, sku: '18;11;australium', keyPrice: null, settings: testSettings(), now: T0, snapshot: null as never });
    expect(d?.references.pricedb).toMatchObject({ buyScrap: 900, sellScrap: 950 });
  });
});
