// Audit schema-5: a kit, fabricator, strangifier, unusualifier or chemistry set
// without its target names no real item, so search never offers one and
// resolve flags it. The schema is TF2's own item data (schema-subset.json).

import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { parseBulkPrices } from '../../src/service/priceSheetIo';
import { fromString } from '../../src/shared/sku';
import { T0, makeDeps, schemaRoute, type TestDeps } from './helpers';

const TOOLS = new Set([6522, 6523, 6526, 6527, 9258, 20000, 20002, 20003, 20005, 20006, 20007]);
const BARE = ['6523;6', '6526;6', '6527;6', '20002;6', '20003;6', '6522;6', '9258;6', '20000;6', '20006;6'];

let deps: TestDeps;
let svc: SchemaService;

beforeAll(async () => {
  deps = makeDeps(schemaRoute());
  svc = createSchemaService(deps);
  await svc.init();
});

/** Every suggested tool carries its target, or is a Collector's Chemistry Set keyed by its output. */
function targetless(skus: string[]): string[] {
  return skus.filter((s) => {
    const o = fromString(s);
    return TOOLS.has(o.defindex) && o.target === null && !(o.output !== null && o.outputQuality === 14);
  });
}

describe('search never offers a tool without its target', () => {
  it.each(['kit', 'fabricator', 'strangifier', 'unusualifier', 'chemistry set', 'chemistry'])('%s', (q) => {
    const skus = svc.search(q, 20).map((s) => s.sku);
    for (const bare of BARE) expect(skus).not.toContain(bare);
    expect(targetless(skus)).toEqual([]);
  });

  it.each([
    ['killstreak kit', '6527;6;kt-1'],
    ['professional killstreak kit', '6526;6;kt-3'],
    ['specialized killstreak kit', '6523;6;kt-2'],
    ['professional killstreak kit fabricator', '20003;6;kt-3;od-6526;oq-6'],
  ])('a tier name without a weapon (%s) is not suggested as %s', (q, sku) => {
    expect(svc.search(q, 20).map((s) => s.sku)).not.toContain(sku);
  });

  it.each([
    ['professional killstreak rocket launcher kit', '6526;6;kt-3;td-205'],
    ['professional killstreak rocket launcher kit fabricator', '20003;6;kt-3;td-205;od-6526;oq-6'],
    ['team captain strangifier', '6522;6;td-378'],
    ["collector's team captain chemistry set", '20006;6;od-378;oq-14'],
    ['team captain strangifier chemistry set', '20000;6;td-378;od-6522;oq-6'],
  ])('a full name (%s) still comes first as %s', (q, sku) => {
    expect(svc.search(q, 5)[0]?.sku).toBe(sku);
  });

  it('drops a learned bp.tf row without a target but keeps the targeted one', async () => {
    const fresh = makeDeps(schemaRoute());
    const s = createSchemaService(fresh);
    await s.init();
    fresh.repo.upsertBptfNames([
      { sku: '6526;6;kt-3;td-205', name: 'Professional Killstreak Rocket Launcher Kit', marketName: null, lastSeen: T0 },
      { sku: '6526;6;kt-3', name: 'Professional Killstreak Kit', marketName: null, lastSeen: T0 },
    ]);
    const skus = s.search('kit', 20).map((x) => x.sku);
    expect(skus).toContain('6526;6;kt-3;td-205');
    expect(skus).not.toContain('6526;6;kt-3');
    expect(skus).not.toContain('6523;6');
  });
});

describe('resolve flags a tool without its target', () => {
  it.each([
    ['Kit', '6523;6', 'exact'],
    ['6523;6', '6523;6', 'sku'],
    ['Professional Killstreak Kit', '6526;6;kt-3', 'exact'],
    ['Strangifier', '6522;6', 'exact'],
  ])('%s keeps %s (%s) with a warning', (text, sku, match) => {
    const r = svc.resolve(text);
    expect(r).toMatchObject({ sku, match });
    expect(r!.warnings.join(' ')).toMatch(/target/i);
    expect(r!.warnings.join(' ')).not.toMatch(/BLU twin|closest match/i);
  });

  it.each(['Professional Killstreak Rocket Launcher Kit', '6526;6;uncraftable;kt-3;td-205', '20006;6;od-378;oq-14', 'Team Captain Strangifier', 'Team Captain'])(
    '%s resolves without warnings',
    (text) => {
      expect(svc.resolve(text)?.warnings).toEqual([]);
    },
  );

  it('keeps a bulk-paste row for a bare kit from being saved', () => {
    const row = parseBulkPrices('Kit, 5 ref', 'ref', (t) => svc.resolve(t)).rows[0]!;
    expect(row.sku).toBeNull();
    expect(row.error).not.toBeNull();
  });
});
