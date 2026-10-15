import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { CATEGORY_LABELS, PROFIT_TIER_LABELS } from '../../src/shared/types';
import type { KeyPriceState, Opportunity } from '../../src/shared/types';
import { buildItemDetail, groupLabel, listOpportunities, previewRule, summarizeGroups } from '../../src/service/domain/views';
import { HOUR, MIN, T0, createStubSchema, makeListing, special, testSettings } from './helpers';

const K = 567;
const KP: KeyPriceState = { valueScrap: K, source: 'pricedb', observedAt: T0, stale: false, quotes: [] };
const repos: Repo[] = [];

afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function newRepo(): Repo {
  const r = openRepo(':memory:');
  repos.push(r);
  return r;
}

function opp(over: Partial<Opportunity> & { sku: string }): Opportunity {
  const inputRef = over.inputRef ?? 'price:1';
  return {
    key: `${over.sku}|${inputRef}`,
    name: over.sku,
    category: 'hats',
    inputRef,
    inputKind: 'user',
    costKeys: 0,
    costScrapRaw: 100,
    costScrap: 100,
    bestScrap: 150,
    consScrap: 150,
    instantScrap: null,
    revenueScrap: 150,
    profitScrap: 50,
    margin: 0.5,
    maxCostScrap: null,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    reasons: [],
    buyerCount: 1,
    bestOrder: null,
    consOrder: null,
    instantOrder: null,
    references: { pricedb: { buyScrap: 140, sellScrap: 160, time: Math.floor((T0 - HOUR) / 1000), ageMs: 1 }, community: null },
    profitTier: 'ref2',
    status: 'profitable',
    inputObservedAt: T0,
    firstSeenAt: T0,
    updatedAt: T0,
    ...over,
  };
}

describe('listOpportunities', () => {
  function seed(repo: Repo): void {
    repo.upsertOpportunities([
      opp({ sku: '1;6', name: 'A', category: 'weapons', profitScrap: 30, profitTier: 'ref2', confidence: 80, confidenceLevel: 'high' }),
      opp({ sku: '2;6', name: 'B', category: 'hats', profitScrap: 600, profitTier: 'key', confidence: 50, confidenceLevel: 'medium', inputKind: 'rule', inputRef: 'rule:1' }),
      opp({ sku: '3;6', name: 'C', category: 'hats', profitScrap: 100, profitTier: 'ref10', confidence: 30, confidenceLevel: 'low', inputKind: 'import' }),
      opp({ sku: '4;6', name: 'D', category: 'unusuals', profitScrap: null, profitTier: 'none', status: 'no-buyers', confidence: 20, confidenceLevel: 'low' }),
      opp({ sku: '5;6', name: 'E', category: 'weapons', profitScrap: -9, profitTier: 'loss', status: 'unprofitable', confidence: 40, confidenceLevel: 'low' }),
    ]);
  }

  it('groups by category in display order, keeping the sort inside groups', () => {
    const repo = newRepo();
    seed(repo);
    const r = listOpportunities(repo, { groupBy: 'category', sort: 'profit', dir: 'desc' }, KP, T0);
    expect(r.rows.map((o) => o.name)).toEqual(['B', 'C', 'A', 'E', 'D']);
    expect(r.groups).toEqual([
      { by: 'category', key: 'hats', label: CATEGORY_LABELS.hats, count: 2, totalProfitScrap: 700 },
      { by: 'category', key: 'weapons', label: CATEGORY_LABELS.weapons, count: 2, totalProfitScrap: 21 },
      { by: 'category', key: 'unusuals', label: CATEGORY_LABELS.unusuals, count: 1, totalProfitScrap: 0 },
    ]);
    expect(r.total).toBe(5);
    expect(r.keyPrice).toBe(KP);
    expect(r.generatedAt).toBe(T0);
  });

  it('groups by tier, confidence and input with readable labels', () => {
    const repo = newRepo();
    seed(repo);
    const tiers = listOpportunities(repo, { groupBy: 'tier' }, KP, T0);
    expect(tiers.groups.map((g) => g.key)).toEqual(['key', 'ref10', 'ref2', 'loss', 'none']);
    expect(tiers.groups[0]!.label).toBe(PROFIT_TIER_LABELS.key);
    expect(listOpportunities(repo, { groupBy: 'confidence' }, KP, T0).groups.map((g) => [g.key, g.label, g.count])).toEqual([
      ['high', 'High', 1],
      ['medium', 'Medium', 1],
      ['low', 'Low', 3],
    ]);
    const input = listOpportunities(repo, { groupBy: 'input' }, KP, T0);
    expect(input.groups.map((g) => g.key)).toEqual(['user', 'import', 'rule']);
    expect(input.groups.find((g) => g.key === 'rule')!.label).toBe('Candidates to check on scrap.tf (rule estimates)');
    expect(input.rows.at(-1)!.name).toBe('B');
  });

  it('applies the repo filters before grouping', () => {
    const repo = newRepo();
    seed(repo);
    const r = listOpportunities(repo, { status: ['profitable'], groupBy: 'category', categories: ['hats'] }, KP, T0);
    expect(r.total).toBe(2);
    expect(r.groups).toHaveLength(1);
  });

  it('returns no groups without groupBy and ignores an unknown groupBy', () => {
    const repo = newRepo();
    seed(repo);
    expect(listOpportunities(repo, {}, KP, T0).groups).toEqual([]);
    expect(listOpportunities(repo, { groupBy: 'bogus' as 'tier' }, KP, T0).groups).toEqual([]);
  });

  it('pages with offset and limit (default 500, max 5000)', () => {
    const repo = newRepo();
    const rows: Opportunity[] = [];
    for (let i = 0; i < 520; i++) rows.push(opp({ sku: `${1000 + i};6`, name: `Item ${String(i).padStart(3, '0')}`, profitScrap: 1000 - i }));
    repo.upsertOpportunities(rows);
    const first = listOpportunities(repo, {}, KP, T0);
    expect(first.rows).toHaveLength(500);
    expect(first.total).toBe(520);
    expect(first.rows[0]!.profitScrap).toBe(1000);
    const page = listOpportunities(repo, { offset: 510, limit: 50 }, KP, T0);
    expect(page.rows.map((o) => o.profitScrap)).toEqual([490, 489, 488, 487, 486, 485, 484, 483, 482, 481]);
    expect(listOpportunities(repo, { limit: 0 }, KP, T0).rows).toHaveLength(1);
    expect(listOpportunities(repo, { limit: 1e9 }, KP, T0).rows).toHaveLength(520);
    expect(listOpportunities(repo, { offset: -5, limit: Number.NaN }, KP, T0).rows).toHaveLength(500);
  });

  it('pages grouped rows across group boundaries and reads only the page', () => {
    const repo = newRepo();
    seed(repo);
    let parsedRows = 0;
    const counting = new Proxy(repo, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === 'queryOpportunities') {
          return (...args: Parameters<Repo['queryOpportunities']>) => {
            const out = target.queryOpportunities(...args);
            parsedRows += out.length;
            return out;
          };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const r = listOpportunities(counting, { groupBy: 'category', sort: 'profit', dir: 'desc', offset: 1, limit: 2 }, KP, T0);
    expect(r.rows.map((o) => o.name)).toEqual(['C', 'A']);
    expect(r.total).toBe(5);
    expect(r.groups.map((g) => [g.key, g.count])).toEqual([
      ['hats', 2],
      ['weapons', 2],
      ['unusuals', 1],
    ]);
    expect(parsedRows).toBe(2);
    const past = listOpportunities(counting, { offset: 5 }, KP, T0);
    expect(past).toMatchObject({ rows: [], total: 5 });
    expect(parsedRows).toBe(2);
  });

  it('matches search tokens in any order', () => {
    const repo = newRepo();
    repo.upsertOpportunities([
      opp({ sku: '18;11;kt-3', name: 'Strange Professional Killstreak Rocket Launcher' }),
      opp({ sku: '378;6', name: 'Sunbeams Team Captain' }),
    ]);
    expect(listOpportunities(repo, { search: 'strange rocket' }, KP, T0).rows.map((o) => o.sku)).toEqual(['18;11;kt-3']);
    expect(listOpportunities(repo, { search: 'captain sunbeams', groupBy: 'category' }, KP, T0)).toMatchObject({ total: 1, rows: [{ sku: '378;6' }] });
  });

  it('refreshes the PriceDB age at read time', () => {
    const repo = newRepo();
    repo.upsertOpportunities([opp({ sku: '1;6' })]);
    const r = listOpportunities(repo, {}, KP, T0 + HOUR);
    expect(r.rows[0]!.references.pricedb?.ageMs).toBe(2 * HOUR);
  });

  it('summarises groups with labels for unknown keys', () => {
    expect(groupLabel('category', 'mystery')).toBe('mystery');
    expect(summarizeGroups([], 'tier')).toEqual([]);
  });
});

describe('buildItemDetail', () => {
  const PINK = 16738740;
  const snapshot = { lastAt: T0 - HOUR, available: true, nextAllowedAt: null };

  function args(repo: Repo, sku: string) {
    return { repo, schema: createStubSchema(), sku, keyPrice: KP, settings: testSettings({ blocklist: ['BLOCKED'] }), now: T0, snapshot };
  }

  it('lists generic any-effect unusual buy orders for an unusual, flagged any-effect', () => {
    const repo = newRepo();
    repo.upsertListings([
      makeListing({ id: 'u13', steamid: 'A', sku: '378;5;u13', baseSku: '378;5;u13', keys: 30, metalScrap: 0 }),
      makeListing({ id: 'any', steamid: 'B', sku: '378;5', baseSku: '378;5', keys: 20, metalScrap: 0 }),
      makeListing({ id: 'any-sell', intent: 'sell', steamid: 'C', sku: '378;5', baseSku: '378;5', keys: 25, metalScrap: 0 }),
    ]);
    const d = buildItemDetail(args(repo, '378;5;u13'))!;
    expect(d.buyOrders.map((o) => o.listingId).sort()).toEqual(['any', 'u13']);
    expect(d.buyOrders.find((o) => o.listingId === 'any')).toMatchObject({ eligible: true, flags: expect.arrayContaining(['any-effect']) });
    expect(d.buyOrders.find((o) => o.listingId === 'u13')!.flags).not.toContain('any-effect');
    expect(d.sellListings).toHaveLength(0);
    // The generic item itself is not an "any effect" target.
    expect(buildItemDetail(args(repo, '378;5'))!.buyOrders.every((o) => !o.flags.includes('any-effect'))).toBe(true);
  });

  it('returns null for text that is not a SKU or an unknown item', () => {
    const repo = newRepo();
    expect(buildItemDetail(args(repo, 'Team Captain'))).toBeNull();
    expect(buildItemDetail(args(repo, '99999;6'))).toBeNull();
  });

  it('returns null for a SKU with tokens fromString would drop, instead of showing another item', () => {
    const repo = newRepo();
    repo.upsertListings([makeListing({ id: 'tc', steamid: 'A', metalScrap: 100 })]);
    expect(buildItemDetail(args(repo, '378;6'))).not.toBeNull();
    expect(buildItemDetail(args(repo, '378;6;UNCRAFTABLE'))).toBeNull();
    expect(buildItemDetail(args(repo, '378;6;uncratable'))).toBeNull();
    expect(buildItemDetail(args(repo, '378;6;uncraftable'))).not.toBeNull(); // a known item, no orders yet
  });

  it('classifies every buy order against the latest price and lists sells cheapest first', () => {
    const repo = newRepo();
    repo.upsertListings([
      makeListing({ id: 'generic', steamid: 'G', metalScrap: 100 }),
      makeListing({ id: 'pink', steamid: 'P', metalScrap: 120, sku: `378;6;p${PINK}`, special: special({ paint: PINK }) }),
      makeListing({ id: 'spelled', steamid: 'X', metalScrap: 130, special: special({ spells: ['Exorcism'] }) }),
      makeListing({ id: 'blocked', steamid: 'BLOCKED', metalScrap: 140 }),
      makeListing({ id: 'dupe-old', steamid: 'G2', metalScrap: 99, lastEventAt: T0 - 2 * HOUR }),
      makeListing({ id: 'dupe-new', steamid: 'G2', metalScrap: 98, lastEventAt: T0 - MIN }),
      makeListing({ id: 'whale', steamid: 'W', metalScrap: 900, keys: 0 }),
      makeListing({ id: 'sell-1', intent: 'sell', steamid: 'S1', keys: 1, metalScrap: 0 }),
      makeListing({ id: 'sell-2', intent: 'sell', steamid: 'S2', metalScrap: 200 }),
      makeListing({ id: 'sell-mp', intent: 'sell', steamid: 'S3', metalScrap: 100, isMarketplace: true }),
    ]);
    repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 100, sellKeys: 0, sellScrap: 120, time: Math.floor(T0 / 1000), fetchedAt: T0 }]);
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 80, source: 'import', observedAt: T0 - 2 * HOUR, special: special(), assetId: '111' });
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 85, source: 'import', observedAt: T0 - HOUR, special: special({ paint: PINK }), assetId: '222' });

    const d = buildItemDetail({ ...args(repo, '378;6'), history: [{ t: 1, buyScrap: 1, sellScrap: 2 }] })!;
    expect(d.sku).toBe('378;6');
    expect(d.name).toBe('Team Captain');
    expect(d.category).toBe('hats');

    const byId = new Map(d.buyOrders.map((o) => [o.listingId, o]));
    // Classified against the newest price: a pink copy.
    expect(byId.get('pink')).toMatchObject({ eligible: true, flags: [] });
    expect(byId.get('generic')).toMatchObject({ eligible: true, flags: ['has-extras'] });
    expect(byId.get('spelled')).toMatchObject({ eligible: false, flags: ['attribute-specific'] });
    expect(byId.get('blocked')).toMatchObject({ eligible: false, flags: ['blocklisted', 'has-extras'] });
    expect(byId.get('dupe-old')).toMatchObject({ eligible: false });
    expect(byId.get('dupe-old')!.flags).toContain('duplicate');
    expect(byId.get('dupe-new')!.eligible).toBe(true);
    expect(byId.get('whale')!.flags).toContain('outlier');
    // Eligible first, best first within each part.
    expect(d.buyOrders.map((o) => o.listingId)).toEqual(['whale', 'pink', 'generic', 'dupe-new', 'blocked', 'spelled', 'dupe-old']);

    expect(d.sellListings.map((o) => o.listingId)).toEqual(['sell-2', 'sell-1', 'sell-mp']);
    expect(d.sellListings.find((o) => o.listingId === 'sell-mp')).toMatchObject({ eligible: false, flags: ['marketplace'] });

    expect(d.references.pricedb).toMatchObject({ buyScrap: 100, sellScrap: 120, ageMs: 0 });
    expect(d.scrapPrices.map((p) => p.assetId)).toEqual(['222', '111']);
    expect(d.history).toEqual([{ t: 1, buyScrap: 1, sellScrap: 2 }]);
    expect(d.snapshot).toBe(snapshot);
    expect(d.keyPrice).toBe(KP);

    const ids = d.links.map((l) => l.id);
    expect(ids).toContain('bptf-stats');
    expect(ids).toContain('mptf');
    expect(ids).toContain('pricedb');
    expect(d.links.find((l) => l.id === 'bptf-history')?.url).toBe('https://backpack.tf/item/222');
    expect(d.links.find((l) => l.id === 'scm')?.url).toBe('https://steamcommunity.com/market/listings/440/Team%20Captain');
  });

  it('uses a clean target without prices and a painted target for a painted SKU', () => {
    const repo = newRepo();
    repo.upsertListings([
      makeListing({ id: 'generic', steamid: 'G', metalScrap: 100 }),
      makeListing({ id: 'pink', steamid: 'P', metalScrap: 120, sku: `378;6;p${PINK}`, special: special({ paint: PINK }) }),
    ]);
    const clean = buildItemDetail(args(repo, '378;6'))!;
    expect(clean.buyOrders.find((o) => o.listingId === 'pink')!.eligible).toBe(false);
    expect(clean.buyOrders.find((o) => o.listingId === 'generic')).toMatchObject({ eligible: true, flags: [] });

    const painted = buildItemDetail(args(repo, `378;6;p${PINK}`))!;
    expect(painted.sku).toBe(`378;6;p${PINK}`);
    expect(painted.buyOrders.find((o) => o.listingId === 'pink')!.eligible).toBe(true);
    expect(painted.buyOrders.find((o) => o.listingId === 'generic')!.flags).toEqual(['has-extras']);
  });

  it("gives a painted SKU the prices of its paint, which are stored under the base SKU (Record buy's prefill)", () => {
    const repo = newRepo();
    const GREEN = 3100495;
    repo.upsertListings([makeListing({ id: 'generic', steamid: 'G', metalScrap: 100 })]);
    const plain = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 18, source: 'import', observedAt: T0 - HOUR, special: special() });
    const pinkOld = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 95, source: 'user', observedAt: T0 - 2 * HOUR, special: special({ paint: PINK }) });
    const pink = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 90, source: 'import', observedAt: T0 - HOUR, special: special({ paint: PINK }) });
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 70, source: 'import', observedAt: T0 - HOUR, special: special({ paint: GREEN }) });

    expect(buildItemDetail(args(repo, `378;6;p${PINK}`))!.scrapPrices.map((p) => p.id)).toEqual([pink.id, pinkOld.id]);
    expect(buildItemDetail(args(repo, '378;6;p15185211'))!.scrapPrices).toEqual([]);
    // The plain SKU still lists every copy stored under it, as before.
    expect(buildItemDetail(args(repo, '378;6'))!.scrapPrices.map((p) => p.id)).toContain(plain.id);
    expect(buildItemDetail(args(repo, '378;6'))!.scrapPrices).toHaveLength(4);
  });

  it('prices the eligible book like the engine, with the pay-up-to ceiling (F2)', () => {
    const repo = newRepo();
    repo.upsertListings([
      makeListing({ id: 'whale', steamid: 'W', metalScrap: 400 }),
      makeListing({ id: 'human', steamid: 'H', metalScrap: 150 }),
      makeListing({ id: 'bot', steamid: 'B', metalScrap: 140, isBot: true }),
      makeListing({ id: 'low', steamid: 'L', metalScrap: 130 }),
      makeListing({ id: 'blocked', steamid: 'BLOCKED', metalScrap: 160 }),
    ]);
    const d = buildItemDetail(args(repo, '378;6'))!;
    expect(d.revenue).toEqual({
      bestScrap: 400,
      consScrap: 150,
      instantScrap: 140,
      useOrder: 'conservative',
      revenueScrap: 150,
      order: expect.objectContaining({ listingId: 'human', isBot: false, eligible: true }),
      maxCostScrap: 138,
      eligibleCount: 4,
    });

    const best = buildItemDetail({ ...args(repo, '378;6'), settings: testSettings({ profit: { useOrder: 'best' } }) })!;
    expect(best.revenue).toMatchObject({ useOrder: 'best', revenueScrap: 400, order: { listingId: 'whale', flags: ['outlier'] } });
    const instant = buildItemDetail({ ...args(repo, '378;6'), settings: testSettings({ profit: { useOrder: 'instant', frictionScrap: 10 } }) })!;
    // 140 - 10 friction - 120 = 10 scrap, an 8.3% margin; 121 would fall under 8%.
    expect(instant.revenue).toMatchObject({ revenueScrap: 140, maxCostScrap: 120 });
  });

  it('reports an empty revenue when nothing is eligible', () => {
    const repo = newRepo();
    repo.upsertListings([makeListing({ id: 'banned', steamid: 'X', metalScrap: 100, userBanned: true })]);
    expect(buildItemDetail(args(repo, '378;6'))!.revenue).toEqual({
      bestScrap: null,
      consScrap: null,
      instantScrap: null,
      useOrder: 'conservative',
      revenueScrap: null,
      order: null,
      maxCostScrap: null,
      eligibleCount: 0,
    });
  });

  it('counts generic any-effect orders in the revenue of an effect unusual', () => {
    const repo = newRepo();
    repo.upsertListings([
      makeListing({ id: 'u13', steamid: 'A', sku: '378;5;u13', baseSku: '378;5;u13', keys: 30, metalScrap: 0 }),
      makeListing({ id: 'any', steamid: 'B', sku: '378;5', baseSku: '378;5', keys: 32, metalScrap: 0, isBot: true }),
    ]);
    const d = buildItemDetail(args(repo, '378;5;u13'))!;
    expect(d.revenue).toMatchObject({ eligibleCount: 2, consScrap: 32 * K, instantScrap: 32 * K, order: { listingId: 'any' } });
  });

  it('ignores a stale PriceDB price for outliers, like the engine (F4)', () => {
    const repo = newRepo();
    repo.upsertListings([
      makeListing({ id: 'a', steamid: 'A', metalScrap: 40 }),
      makeListing({ id: 'b', steamid: 'B', metalScrap: 38 }),
      makeListing({ id: 'c', steamid: 'C', metalScrap: 36 }),
    ]);
    const old = Math.floor((T0 - 400 * 24 * HOUR) / 1000);
    repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 15, sellKeys: 0, sellScrap: 18, time: old, fetchedAt: T0 }]);
    const d = buildItemDetail(args(repo, '378;6'))!;
    expect(d.buyOrders.every((o) => !o.flags.includes('outlier'))).toBe(true);
    expect(d.revenue).toMatchObject({ consScrap: 40, revenueScrap: 40 });
    // The drawer still shows the old price (faded by the UI).
    expect(d.references.pricedb).toMatchObject({ sellScrap: 18 });

    const strict = buildItemDetail({ ...args(repo, '378;6'), settings: testSettings({ profit: { referenceMaxAgeMs: 500 * 24 * HOUR } }) })!;
    expect(strict.buyOrders.every((o) => o.flags.includes('outlier'))).toBe(true);
    expect(strict.revenue).toMatchObject({ consScrap: null, bestScrap: 40, revenueScrap: null, maxCostScrap: null, eligibleCount: 3 });
  });

  it('gives the backpack.tf name without the paint suffix for a painted SKU', () => {
    const repo = newRepo();
    repo.upsertListings([makeListing({ id: 'generic', steamid: 'G', metalScrap: 100 })]);
    const schema = createStubSchema({ nameOf: (sku) => (sku.includes(';p') ? 'Team Captain (Paint: Pink as Hell)' : 'Team Captain') });
    const painted = buildItemDetail({ ...args(repo, `378;6;p${PINK}`), schema })!;
    expect(painted.name).toBe('Team Captain (Paint: Pink as Hell)');
    expect(painted.bptfName).toBe('Team Captain');
    const plain = buildItemDetail({ ...args(repo, '378;6'), schema })!;
    expect(plain.bptfName).toBe('Team Captain');

    // Without a schema name the painted name is the best there is.
    const blind = createStubSchema({ nameOf: (sku) => sku });
    repo.upsertScrapPrice({ sku: `378;6;p${PINK}`, name: 'Pink Captain', costScrap: 80, source: 'user', observedAt: T0 });
    expect(buildItemDetail({ ...args(repo, `378;6;p${PINK}`), schema: blind })!.bptfName).toBe('Pink Captain');
  });

  it('includes opportunities for the SKU and survives a throwing schema', () => {
    const repo = newRepo();
    repo.upsertOpportunities([opp({ sku: '205;11;kt-3', name: 'Strange Rocket Launcher' })]);
    const schema = createStubSchema();
    schema.nameForSku = () => {
      throw new Error('boom');
    };
    schema.categoryForSku = () => {
      throw new Error('boom');
    };
    const d = buildItemDetail({ ...args(repo, '205;11;kt-3'), schema, keyPrice: null })!;
    expect(d.opportunities).toHaveLength(1);
    expect(d.name).toBe('205;11;kt-3');
    expect(d.bptfName).toBe('205;11;kt-3');
    expect(d.category).toBe('killstreaks');
    expect(d.keyPrice).toBeNull();
  });
});

describe('previewRule', () => {
  it('counts matching SKUs with buy orders, skipping currencies, explicit prices and untradables', () => {
    const repo = newRepo();
    repo.upsertListings([
      makeListing({ sku: '378;6', baseSku: '378;6' }),
      makeListing({ sku: '126;6', baseSku: '126;6' }),
      makeListing({ sku: '126;6;untradable', baseSku: '126;6;untradable' }),
      makeListing({ sku: '205;6', baseSku: '205;6' }),
      makeListing({ sku: '5021;6', baseSku: '5021;6' }),
    ]);
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 10, source: 'user', observedAt: T0 });
    const r = previewRule(repo, createStubSchema(), { categories: ['hats'] });
    expect(r).toEqual({ matchingSkus: 1, sample: [{ sku: '126;6', name: "Bill's Hat" }] });
    expect(previewRule(repo, createStubSchema(), {}, 1).matchingSkus).toBe(2);
    expect(previewRule(repo, createStubSchema(), {}, 1).sample).toHaveLength(1);
  });
});
