import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService, searchRank } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { T0, makeDeps, schemaRoute, type TestDeps } from './helpers';

let deps: TestDeps;
let svc: SchemaService;

beforeAll(async () => {
  deps = makeDeps(schemaRoute());
  svc = createSchemaService(deps);
  await svc.init();
});

describe('searchRank', () => {
  it('ranks prefix > word prefix > substring', () => {
    expect(searchRank('Team Captain', 'team')).toBe(0);
    expect(searchRank('The Team Captain', 'team')).toBe(0);
    expect(searchRank('Team Captain', 'capt')).toBe(1);
    expect(searchRank('Taunt: The Bunnyhopper', 'bunny')).toBe(1);
    expect(searchRank('Strange Part: Heavies Killed', 'heav')).toBe(1);
    expect(searchRank('Team Captain', 'aptain')).toBe(2);
    expect(searchRank('Team Captain', 'hat')).toBeNull();
    expect(searchRank('Team Captain', '')).toBeNull();
    expect(searchRank('Übersaw', 'uber')).toBe(0);
  });
});

describe('SchemaService.search', () => {
  it('orders prefix matches before word-prefix and substring matches', () => {
    const names = svc.search('team', 10).map((s) => s.name);
    expect(names.slice(0, 2)).toEqual(['Team Spirit', 'The Team Captain']);
    expect(names).toContain('The Value of Teamwork');
    expect(names.indexOf('The Team Captain')).toBeLessThan(names.indexOf('The Value of Teamwork'));
  });

  it('returns base SKUs with their category and source', () => {
    expect(svc.search('team captain', 3)[0]).toEqual({ sku: '378;6', name: 'The Team Captain', category: 'hats', source: 'schema' });
    expect(svc.search('rocket launcher', 5)[0]).toMatchObject({ sku: '205;6', category: 'weapons' });
    expect(svc.search('bunnyhopper', 5)[0]).toMatchObject({ sku: '30920;6', category: 'taunts' });
  });

  it("uses the item's natural quality for unusual-only and strange-only items", () => {
    expect(svc.search('horseless', 3)[0]).toMatchObject({ sku: '266;5', name: "Unusual Horseless Headless Horsemann's Headtaker" });
    expect(svc.search('haunted metal', 3)[0]).toMatchObject({ sku: '267;5' });
    expect(svc.search('spirit of giving', 3)[0]).toMatchObject({ sku: '655;11', category: 'stranges' });
  });

  it('skips duplicates, stock copies, skin-specific weapons and war paints without a paintkit', () => {
    const skus = svc.search('sniper rifle', 20).map((s) => s.sku);
    expect(skus).toContain('201;6');
    expect(skus).not.toContain('14;0');
    expect(skus).not.toContain('14;6');
    expect(skus.some((s) => s.startsWith('15000;'))).toBe(false);
    expect(svc.search('war paint', 20).some((s) => s.sku.startsWith('9536;') || s.sku.startsWith('16105;'))).toBe(false);
  });

  it('lists crates with their series when it is unambiguous', () => {
    expect(svc.search('scorched', 5)[0]).toMatchObject({ sku: '5078;6;c46' });
    expect(svc.search('mann co. supply crate', 10).map((s) => s.sku)).not.toContain('5022;6');
  });

  it('puts a full name with prefixes first', () => {
    const r = svc.search('burning flames team captain', 5);
    expect(r[0]).toEqual({ sku: '378;5;u13', name: 'Burning Flames Team Captain', category: 'unusuals', source: 'schema' });
    expect(svc.search('mann co. supply crate #11', 3)[0]?.sku).toBe('5041;6;c11');
  });

  it('merges names learned from backpack.tf and prefers them for the same SKU', () => {
    deps.repo.upsertBptfNames([
      { sku: '30177;5;u13', name: 'Burning Flames Hong Kong Cone', marketName: 'Unusual Hong Kong Cone', lastSeen: T0 },
      { sku: '30177;6', name: 'Hong Kong Cone', marketName: 'Hong Kong Cone', lastSeen: T0 },
    ]);
    const r = svc.search('hong kong', 10);
    expect(r[0]).toEqual({ sku: '30177;6', name: 'Hong Kong Cone', category: 'hats', source: 'bptf' });
    expect(r.filter((s) => s.sku === '30177;6')).toHaveLength(1);
    expect(r.find((s) => s.sku === '30177;5;u13')).toMatchObject({ source: 'bptf', category: 'unusuals' });
  });

  it('suggests the base SKU once when painted copies share a learned name', () => {
    deps.repo.upsertBptfNames([
      { sku: '126;6', name: "Bill's Hat", marketName: null, lastSeen: T0 },
      { sku: '126;6;p16738740', name: "Bill's Hat", marketName: null, lastSeen: T0 },
    ]);
    const r = svc.search("bill's", 10).filter((s) => s.sku.startsWith('126;'));
    expect(r).toEqual([{ sku: '126;6', name: "Bill's Hat", category: 'hats', source: 'bptf' }]);
  });

  it('honours the limit and ignores empty queries', () => {
    expect(svc.search('a', 3)).toHaveLength(3);
    expect(svc.search('a', 0).length).toBeGreaterThan(0);
    expect(svc.search('a', 1000).length).toBeLessThanOrEqual(100);
    expect(svc.search('   ', 10)).toEqual([]);
    expect(svc.search('zzzzqqq', 10)).toEqual([]);
  });
});
