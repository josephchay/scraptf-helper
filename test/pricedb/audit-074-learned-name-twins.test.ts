// 0.7.4 (F15/F42/F72): names learned from backpack.tf no longer override the schema. bp.tf files one name under
// defindex twins (18 and 205 for "Strange Australium Rocket Launcher", td-10 and td-199 for a shotgun kit), and
// the lookup took the shortest SKU, then the newest: the stock defindex, which no import, list row or PriceDB
// row uses, and an answer that moved as the feed learned names. The schema's exact reading (the rule the import
// keys cards by) comes first; a learned name only for text the schema cannot read, several of them picked by
// the schema's own rule, with a warning, never by when they were seen.
// 0.7.4 (F46): a "#N" after an item that is no crate is a craft or medal number no order carries: read as the
// plain item (with a warning) unless something prices that numbered SKU; a crate number in no series is noted.
// Real schema fixture; offline.

import { describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { parseCheckText } from '../../src/service/domain/liveCheck';
import { T0, makeDeps, schemaRoute } from './helpers';

async function withNames(rows: [sku: string, name: string, lastSeen: number][]): Promise<SchemaService> {
  const deps = makeDeps(schemaRoute());
  deps.repo.upsertBptfNames(rows.map(([sku, name, lastSeen]) => ({ sku, name, marketName: null, lastSeen })));
  const svc = createSchemaService(deps);
  await svc.init();
  return svc;
}

describe('learned backpack.tf names never choose between defindex twins', () => {
  it.each([
    ['Strange Australium Rocket Launcher', ['18;11;australium', '205;11;australium'], '205;11;australium'],
    ['Strange Shotgun', ['9;11', '10;11', '199;11'], '199;11'],
    ['Strange Pistol', ['23;11', '209;11'], '209;11'],
    ['Strange Medi Gun', ['29;11', '211;11'], '211;11'],
    ['Non-Craftable Professional Killstreak Shotgun Kit', ['6526;6;uncraftable;kt-3;td-10', '6526;6;uncraftable;kt-3;td-199'], '6526;6;uncraftable;kt-3;td-199'],
  ])('%j resolves to %s whichever twin was seen last', async (name, skus, want) => {
    for (const order of [skus, [...skus].reverse()]) {
      const svc = await withNames(order.map((s, i): [string, string, number] => [s, name, T0 + i * 1000]));
      const r = svc.resolve(name);
      expect(r?.sku, order.join(' ')).toBe(want);
      expect(r?.match).toBe('exact');
      expect(r?.warnings).toEqual([]);
    }
  });

  it("reads scrap.tf's kit title as the import keys the card, whatever twin the feed learned", async () => {
    const svc = await withNames([['6526;6;uncraftable;kt-3;td-10', 'Non-Craftable Professional Killstreak Shotgun Kit', T0 + 9]]);
    const r = parseCheckText('Professional Shotgun Kit', (t) => svc.resolve(t));
    expect(r.ok && r.parsed.item.sku).toBe('6526;6;uncraftable;kt-3;td-199');
  });

  it('still reads a name only backpack.tf knows, one SKU as it is, several by the schema rule with a warning', async () => {
    const one = await withNames([['30177;5;u3001', 'Odd Feed Name', T0]]);
    expect(one.resolve('odd feed name')).toMatchObject({ sku: '30177;5;u3001', match: 'exact', warnings: [] });
    for (const order of [
      ['18;11;australium', '205;11;australium'],
      ['205;11;australium', '18;11;australium'],
    ]) {
      const svc = await withNames(order.map((s, i): [string, string, number] => [s, 'Odd Australium Name', T0 + i]));
      const r = svc.resolve('Odd Australium Name');
      expect(r?.sku).toBe('205;11;australium');
      expect(r?.warnings.join(' ')).toMatch(/under 2 items/);
    }
  });

  it('suggests one item for a name backpack.tf files under twins: the one resolve gives', async () => {
    const svc = await withNames([
      ['14;11;australium', 'Strange Australium Sniper Rifle', T0 + 5],
      ['201;11;australium', 'Strange Australium Sniper Rifle', T0],
    ]);
    const hits = svc.search('Strange Australium Sniper Rifle', 10).filter((h) => h.name === 'Strange Australium Sniper Rifle');
    expect(hits.map((h) => h.sku)).toEqual(['201;11;australium']);
    expect(svc.resolve('Strange Australium Sniper Rifle')?.sku).toBe('201;11;australium');
  });

  it('lists every learned SKU of a name in a fixed order (repo.findSkusByBptfName)', () => {
    const repo = openRepo(':memory:');
    repo.upsertBptfNames([
      { sku: '205;11', name: 'Strange Rocket Launcher', marketName: null, lastSeen: 1 },
      { sku: '18;11', name: 'Strange Rocket Launcher', marketName: null, lastSeen: 9 },
      { sku: '999;11', name: 'strange rocket launcher', marketName: null, lastSeen: 5 },
    ]);
    expect(repo.findSkusByBptfName('Strange Rocket Launcher')).toEqual(['18;11', '205;11', '999;11']);
    repo.upsertBptfNames([{ sku: '205;11', name: 'Strange Rocket Launcher', marketName: null, lastSeen: 99 }]);
    expect(repo.findSkusByBptfName('Strange Rocket Launcher')).toEqual(['18;11', '205;11', '999;11']);
    expect(repo.findSkusByBptfName('  ')).toEqual([]);
    repo.close();
  });
});

describe('F46: craft and medal numbers', () => {
  it('reads "#N" after an item that is no crate as the plain item backpack.tf keys it as', async () => {
    const svc = await withNames([]);
    const r = svc.resolve('Team Captain #42');
    expect(r?.sku).toBe('378;6');
    expect(r?.warnings.join(' ')).toMatch(/#42" is a craft or medal number/);
    expect(svc.search('Team Captain #42', 5)[0]?.sku).toBe('378;6');
    // A SKU typed with its craft number is the user's own choice.
    expect(svc.resolve('378;6;n42')?.sku).toBe('378;6;n42');
    // The Live check reads a copied numbered title as the plain item (noted incomplete), not "No buyers".
    const check = parseCheckText('Team Captain #42, 2 ref', (t) => svc.resolve(t));
    expect(check.ok && [check.parsed.item.sku, check.parsed.incomplete]).toEqual(['378;6', true]);
  });

  it('keeps a craft number that something prices', async () => {
    const deps = makeDeps(schemaRoute());
    deps.repo.upsertPricedb([{ sku: '160;3;n4', name: 'Vintage Lugermorph #4', buyKeys: 0, buyScrap: 900, sellKeys: 0, sellScrap: 990, time: Math.floor(T0 / 1000), fetchedAt: T0 }]);
    const svc = createSchemaService(deps);
    await svc.init();
    expect(svc.resolve('Vintage Lugermorph #4')).toMatchObject({ sku: '160;3;n4', warnings: [] });
  });

  it('notes a Mann Co. Supply Crate number in none of its series, and keeps a real series as it was', async () => {
    const svc = await withNames([]);
    expect(svc.resolve('Mann Co. Supply Crate #145')?.warnings.join(' ')).toMatch(/has no series #145/);
    expect(svc.resolve('Mann Co. Supply Crate #30')?.warnings.join(' ')).toMatch(/has no series #30/);
    expect(svc.resolve('Mann Co. Supply Crate Series #11')).toMatchObject({ sku: '5041;6;c11', warnings: [] });
  });
});
