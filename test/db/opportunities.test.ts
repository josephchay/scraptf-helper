import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/service/db/db';
import type { SqliteDb } from '../../src/service/db/db';
import { createRepo } from '../../src/service/db/repo';
import { migrate } from '../../src/service/db/migrations';
import type { Repo } from '../../src/service/contracts';
import type { Opportunity } from '../../src/shared/types';
import { makeEvent, makeOpp, makeOrder } from './helpers';

let db: SqliteDb;
let repo: Repo;
beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db.raw);
  repo = createRepo(db);
});
afterEach(() => repo.close());

const keys = (rows: Opportunity[]) => rows.map((o) => o.key);

describe('opportunities', () => {
  it('counts all, profitable and high-confidence profitable rows', () => {
    expect(repo.opportunityCounts()).toEqual({ opportunities: 0, profitable: 0, highConfidence: 0 });
    repo.upsertOpportunities([
      makeOpp({ sku: '1;6', status: 'profitable', confidenceLevel: 'high' }),
      makeOpp({ sku: '2;6', status: 'profitable', confidenceLevel: 'medium' }),
      makeOpp({ sku: '3;6', status: 'no-buyers', confidenceLevel: 'high' }),
    ]);
    expect(repo.opportunityCounts()).toEqual({ opportunities: 3, profitable: 2, highConfidence: 1 });
  });

  it('round-trips every field with JSON, boolean and null fidelity', () => {
    const o = makeOpp({
      sku: '30123;5;u13',
      inputRef: 'rule:7',
      inputKind: 'rule',
      category: 'unusuals',
      costKeys: 12.5,
      bestScrap: null,
      consScrap: null,
      instantScrap: null,
      revenueScrap: null,
      profitScrap: null,
      margin: null,
      confidence: 12.5,
      confidenceLevel: 'low',
      flags: ['unusual-risk', 'rule-estimate'],
      reasons: ['estimate from rule', 'no buyers'],
      buyerCount: 0,
      bestOrder: makeOrder({ online: true, bumpedAt: 1_791_958_000, flags: [], eligible: false, userName: null }),
      consOrder: makeOrder({ listingId: 'c', online: false }),
      instantOrder: null,
      references: { pricedb: null, community: { valueScrap: 900, valueHighScrap: null, lastUpdate: 1_791_000_000 } },
      profitTier: 'none',
      status: 'no-buyers',
    });
    o.key = `${o.sku}|${o.inputRef}`;
    repo.upsertOpportunities([o]);
    expect(repo.getOpportunity(o.key)).toEqual(o);
    expect(repo.getOpportunity('missing')).toBeNull();
  });

  it('upsert replaces by key and delete removes', () => {
    const a = makeOpp({ inputRef: 'price:1' });
    const b = makeOpp({ inputRef: 'price:2' });
    repo.upsertOpportunities([a, b]);
    repo.upsertOpportunities([{ ...a, profitScrap: 999, flags: ['x'] }]);
    expect(repo.getOpportunity(a.key)).toMatchObject({ profitScrap: 999, flags: ['x'] });
    expect(repo.allOpportunities()).toHaveLength(2);
    repo.deleteOpportunities([a.key, 'nope']);
    repo.deleteOpportunities([]);
    expect(keys(repo.allOpportunities())).toEqual([b.key]);
  });

  it('opportunitiesForSku returns only that SKU, best profit first', () => {
    repo.upsertOpportunities([
      makeOpp({ sku: 'A', inputRef: 'price:1', profitScrap: 5 }),
      makeOpp({ sku: 'A', inputRef: 'price:2', profitScrap: null }),
      makeOpp({ sku: 'A', inputRef: 'rule:1', profitScrap: 50 }),
      makeOpp({ sku: 'B', inputRef: 'price:3', profitScrap: 100 }),
    ]);
    expect(keys(repo.opportunitiesForSku('A'))).toEqual(['A|rule:1', 'A|price:1', 'A|price:2']);
  });

  it('degrades damaged JSON columns to safe defaults', () => {
    const o = makeOpp();
    repo.upsertOpportunities([o]);
    db.raw
      .prepare(`UPDATE opportunities SET flags = 'not json', reasons = '{"a":1}', best_order = '{"listingId":5}', refs = '[]' WHERE "key" = ?`)
      .run(o.key);
    const back = repo.getOpportunity(o.key)!;
    expect(back.flags).toEqual([]);
    expect(back.reasons).toEqual([]);
    expect(back.bestOrder).toBeNull();
    expect(back.references).toEqual({ pricedb: null, community: null });
  });

  it('fills missing order fields with defaults', () => {
    const o = makeOpp();
    repo.upsertOpportunities([o]);
    db.raw.prepare(`UPDATE opportunities SET cons_order = '{"listingId":"z","steamid":"7"}' WHERE "key" = ?`).run(o.key);
    expect(repo.getOpportunity(o.key)!.consOrder).toEqual({
      listingId: 'z',
      steamid: '7',
      userName: null,
      keys: 0,
      metalScrap: 0,
      valueScrap: 0,
      isBot: false,
      online: null,
      lastEventAt: 0,
      bumpedAt: null,
      details: '',
      flags: [],
      eligible: false,
    });
  });
});

describe('queryOpportunities', () => {
  beforeEach(() => {
    repo.upsertOpportunities([
      makeOpp({
        sku: '1;6',
        name: 'alpha Hat',
        inputRef: 'price:1',
        inputKind: 'user',
        category: 'hats',
        profitTier: 'ref2',
        status: 'profitable',
        profitScrap: 30,
        margin: 0.3,
        confidence: 80,
        updatedAt: 3,
      }),
      makeOpp({
        sku: '2;11',
        name: 'Bravo Gun',
        inputRef: 'rule:1',
        inputKind: 'rule',
        category: 'stranges',
        profitTier: 'small',
        status: 'below-threshold',
        profitScrap: 5,
        margin: null,
        confidence: 40,
        updatedAt: 1,
      }),
      makeOpp({
        sku: '3;5;u13',
        name: 'charlie 100%_Unusual',
        inputRef: 'price:2',
        inputKind: 'import',
        category: 'unusuals',
        profitTier: 'none',
        status: 'no-buyers',
        profitScrap: null,
        margin: null,
        confidence: 10,
        updatedAt: 2,
      }),
      makeOpp({
        sku: '4;6',
        name: 'Delta Taunt',
        inputRef: 'price:3',
        inputKind: 'user',
        category: 'taunts',
        profitTier: 'loss',
        status: 'unprofitable',
        profitScrap: -20,
        margin: -0.1,
        confidence: 60,
        updatedAt: 4,
      }),
    ]);
  });

  it('defaults to profit descending with nulls last', () => {
    expect(keys(repo.queryOpportunities({}))).toEqual(['1;6|price:1', '2;11|rule:1', '4;6|price:3', '3;5;u13|price:2']);
  });

  it('keeps nulls last in both directions', () => {
    expect(keys(repo.queryOpportunities({ sort: 'profit', dir: 'asc' }))).toEqual([
      '4;6|price:3',
      '2;11|rule:1',
      '1;6|price:1',
      '3;5;u13|price:2',
    ]);
    const byMarginAsc = keys(repo.queryOpportunities({ sort: 'margin', dir: 'asc' }));
    expect(byMarginAsc.slice(0, 2)).toEqual(['4;6|price:3', '1;6|price:1']);
    // Both null margins come last, tie broken by profit (nulls last).
    expect(byMarginAsc.slice(2)).toEqual(['2;11|rule:1', '3;5;u13|price:2']);
    const byMarginDesc = keys(repo.queryOpportunities({ sort: 'margin', dir: 'desc' }));
    expect(byMarginDesc).toEqual(['1;6|price:1', '4;6|price:3', '2;11|rule:1', '3;5;u13|price:2']);
  });

  it('sorts by confidence, updated and name', () => {
    expect(keys(repo.queryOpportunities({ sort: 'confidence' }))).toEqual([
      '1;6|price:1',
      '4;6|price:3',
      '2;11|rule:1',
      '3;5;u13|price:2',
    ]);
    expect(keys(repo.queryOpportunities({ sort: 'updated', dir: 'asc' }))).toEqual([
      '2;11|rule:1',
      '3;5;u13|price:2',
      '1;6|price:1',
      '4;6|price:3',
    ]);
    // Case-insensitive, ascending by default.
    expect(repo.queryOpportunities({ sort: 'name' }).map((o) => o.name)).toEqual([
      'alpha Hat',
      'Bravo Gun',
      'charlie 100%_Unusual',
      'Delta Taunt',
    ]);
    expect(repo.queryOpportunities({ sort: 'name', dir: 'desc' }).map((o) => o.name)[0]).toBe('Delta Taunt');
  });

  it('falls back to the default sort for unknown sort keys', () => {
    const q = { sort: 'bogus', dir: 'sideways' } as unknown as Parameters<Repo['queryOpportunities']>[0];
    expect(keys(repo.queryOpportunities(q))).toEqual(keys(repo.queryOpportunities({})));
  });

  it('filters by status, categories, tiers and input kinds', () => {
    expect(keys(repo.queryOpportunities({ status: ['profitable', 'unprofitable'] }))).toEqual(['1;6|price:1', '4;6|price:3']);
    expect(keys(repo.queryOpportunities({ categories: ['stranges'] }))).toEqual(['2;11|rule:1']);
    expect(keys(repo.queryOpportunities({ tiers: ['none', 'loss'] }))).toEqual(['4;6|price:3', '3;5;u13|price:2']);
    expect(keys(repo.queryOpportunities({ inputKinds: ['user'] }))).toEqual(['1;6|price:1', '4;6|price:3']);
    expect(keys(repo.queryOpportunities({ inputKinds: ['user'], categories: ['taunts'] }))).toEqual(['4;6|price:3']);
  });

  it('treats empty filter lists as no filter', () => {
    expect(repo.queryOpportunities({ status: [], categories: [], tiers: [], inputKinds: [] })).toHaveLength(4);
  });

  it('applies minConfidence inclusively', () => {
    expect(keys(repo.queryOpportunities({ minConfidence: 60 }))).toEqual(['1;6|price:1', '4;6|price:3']);
    expect(repo.queryOpportunities({ minConfidence: 0 })).toHaveLength(4);
    expect(repo.queryOpportunities({ minConfidence: 101 })).toHaveLength(0);
  });

  it('searches name or SKU case-insensitively with wildcards escaped', () => {
    expect(keys(repo.queryOpportunities({ search: 'BRAVO' }))).toEqual(['2;11|rule:1']);
    expect(keys(repo.queryOpportunities({ search: ';u13' }))).toEqual(['3;5;u13|price:2']);
    expect(keys(repo.queryOpportunities({ search: '100%_' }))).toEqual(['3;5;u13|price:2']);
    expect(repo.queryOpportunities({ search: '%' })).toHaveLength(1);
    expect(repo.queryOpportunities({ search: '_' })).toHaveLength(1);
    expect(repo.queryOpportunities({ search: '   ' })).toHaveLength(4);
    expect(repo.queryOpportunities({ search: 'zzz' })).toHaveLength(0);
  });

  it('ignores limit and offset (the caller pages)', () => {
    expect(repo.queryOpportunities({ limit: 1, offset: 2 })).toHaveLength(4);
  });

  // The dashboard's search matches every whitespace-separated token in the name or SKU.
  it('matches search tokens independently, in any order, across name and SKU', () => {
    expect(keys(repo.queryOpportunities({ search: 'gun bravo' }))).toEqual(['2;11|rule:1']);
    expect(keys(repo.queryOpportunities({ search: '  Delta   taunt ' }))).toEqual(['4;6|price:3']);
    expect(keys(repo.queryOpportunities({ search: 'charlie u13' }))).toEqual(['3;5;u13|price:2']);
    expect(keys(repo.queryOpportunities({ search: 'unusual 100%' }))).toEqual(['3;5;u13|price:2']);
    expect(repo.queryOpportunities({ search: 'bravo zzz' })).toHaveLength(0);
    expect(repo.countOpportunities({ search: 'a' })).toBe(4);
  });

  it('pages in SQL when asked', () => {
    expect(keys(repo.queryOpportunities({}, { limit: 2, offset: 1 }))).toEqual(['2;11|rule:1', '4;6|price:3']);
    expect(keys(repo.queryOpportunities({ sort: 'name' }, { limit: 1, offset: 3 }))).toEqual(['4;6|price:3']);
    expect(repo.queryOpportunities({}, { limit: 10, offset: 4 })).toEqual([]);
    expect(repo.queryOpportunities({}, { limit: 0, offset: 0 })).toEqual([]);
    expect(repo.queryOpportunities({}, { limit: 10, offset: Number.MAX_SAFE_INTEGER })).toEqual([]);
    expect(repo.queryOpportunities({}, { limit: Number.NaN, offset: -3 })).toEqual([]);
  });

  it('orders a page by group first, keeping the sort inside each group and unknown groups last', () => {
    const page = (offset: number, limit: number) =>
      keys(repo.queryOpportunities({}, { limit, offset, group: { by: 'category', order: ['taunts', 'hats'] } }));
    expect(page(0, 10)).toEqual(['4;6|price:3', '1;6|price:1', '2;11|rule:1', '3;5;u13|price:2']);
    expect(page(1, 2)).toEqual(['1;6|price:1', '2;11|rule:1']);
    expect(keys(repo.queryOpportunities({}, { limit: 10, offset: 0, group: { by: 'bogus' as 'tier', order: ['x'] } }))).toEqual(
      keys(repo.queryOpportunities({})),
    );
  });

  it('counts matches and summarises groups in SQL', () => {
    expect(repo.countOpportunities({})).toBe(4);
    expect(repo.countOpportunities({ status: ['profitable', 'unprofitable'] })).toBe(2);
    expect(repo.countOpportunities({ minConfidence: 101 })).toBe(0);
    const byKey = (by: Parameters<Repo['opportunityGroupStats']>[1], q = {}) =>
      repo.opportunityGroupStats(q, by).sort((a, b) => a.key.localeCompare(b.key));
    expect(byKey('category')).toEqual([
      { key: 'hats', count: 1, profitScrap: 30 },
      { key: 'stranges', count: 1, profitScrap: 5 },
      { key: 'taunts', count: 1, profitScrap: -20 },
      { key: 'unusuals', count: 1, profitScrap: 0 },
    ]);
    expect(byKey('input', { minConfidence: 50 })).toEqual([{ key: 'user', count: 2, profitScrap: 10 }]);
    expect(byKey('confidence').map((s) => s.count).reduce((a, b) => a + b, 0)).toBe(4);
    expect(repo.opportunityGroupStats({}, 'bogus' as 'tier')).toEqual([]);
  });

  it('groups a damaged value under the same fallback the row reader uses', () => {
    db.raw.prepare(`UPDATE opportunities SET category = 'bogus' WHERE sku = '1;6'`).run();
    expect(repo.getOpportunity('1;6|price:1')!.category).toBe('other');
    expect(repo.opportunityGroupStats({}, 'category').find((s) => s.key === 'other')).toEqual({ key: 'other', count: 1, profitScrap: 30 });
    const rows = repo.queryOpportunities({}, { limit: 10, offset: 0, group: { by: 'category', order: ['other', 'hats'] } });
    expect(keys(rows)[0]).toBe('1;6|price:1');
  });
});

describe('opportunity events', () => {
  function seed() {
    repo.appendEvents([
      makeEvent({ sku: 'A', kind: 'appeared', ts: 100 }),
      makeEvent({ sku: 'B', kind: 'changed', ts: 200, profitScrap: null, costScrap: null, revenueScrap: null }),
      makeEvent({ sku: 'A', kind: 'gone', ts: 300 }),
      makeEvent({ sku: 'A', kind: 'notified', ts: 400, summary: 'profit 4.33 ref -> 6.11 ref' }),
      makeEvent({ sku: 'C', kind: 'appeared', ts: 500 }),
    ]);
  }

  it('round-trips events and assigns increasing ids', () => {
    const e = makeEvent({ profitScrap: null, confidence: 33.3, summary: 'x' });
    repo.appendEvents([e]);
    const [back] = repo.listEvents({});
    expect(back).toEqual({ ...e, id: back!.id });
    expect(back!.id).toBeGreaterThan(0);
  });

  it('lists newest first with the default limit', () => {
    seed();
    const rows = repo.listEvents({});
    expect(rows.map((e) => e.ts)).toEqual([500, 400, 300, 200, 100]);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.id).toBeLessThan(rows[i - 1]!.id);
  });

  it('filters by sku, kinds, sinceTs and pages with beforeId', () => {
    seed();
    expect(repo.listEvents({ sku: 'A' }).map((e) => e.ts)).toEqual([400, 300, 100]);
    expect(repo.listEvents({ kinds: ['appeared'] }).map((e) => e.sku)).toEqual(['C', 'A']);
    expect(repo.listEvents({ kinds: [] })).toHaveLength(5);
    expect(repo.listEvents({ sinceTs: 300 }).map((e) => e.ts)).toEqual([500, 400, 300]);
    const page1 = repo.listEvents({ limit: 2 });
    expect(page1.map((e) => e.ts)).toEqual([500, 400]);
    const page2 = repo.listEvents({ limit: 2, beforeId: page1[1]!.id });
    expect(page2.map((e) => e.ts)).toEqual([300, 200]);
    expect(repo.listEvents({ sku: 'A', kinds: ['gone', 'notified'], sinceTs: 350 }).map((e) => e.kind)).toEqual(['notified']);
  });

  it('clamps the limit to 5000 and defaults to 200', () => {
    repo.appendEvents(Array.from({ length: 5100 }, (_, i) => makeEvent({ ts: i })));
    expect(repo.listEvents({})).toHaveLength(200);
    expect(repo.listEvents({ limit: 10_000 })).toHaveLength(5000);
    expect(repo.listEvents({ limit: 0 })).toHaveLength(0);
    expect(repo.listEvents({ limit: Number.NaN })).toHaveLength(200);
  });

  it('purges events older than a timestamp', () => {
    seed();
    expect(repo.purgeEventsOlderThan(300)).toBe(2);
    expect(repo.listEvents({}).map((e) => e.ts)).toEqual([500, 400, 300]);
  });

  it('never reuses ids after a purge', () => {
    seed();
    const maxBefore = repo.listEvents({ limit: 1 })[0]!.id;
    repo.purgeEventsOlderThan(Number.MAX_SAFE_INTEGER);
    repo.appendEvents([makeEvent({ ts: 1 })]);
    expect(repo.listEvents({})[0]!.id).toBeGreaterThan(maxBefore);
  });
});
