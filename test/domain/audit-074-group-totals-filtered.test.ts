// 0.7.4 (review R27): the Opportunities group totals count each item's buy order once among the rows the
// filters show, as the summary bar's "together" does. The stored 'shared-buyer' flag is set once over every
// copy, so with a filter that hides an item's best copy (typed prices only, a tier, a minimum confidence) the
// group total counted the shown copy as 0 while the bar counted it: "total +0" beside "1 profitable, together
// +10". The repo's SQL (opportunityGroupStats, via listOpportunities), the service's summarizeGroups and the
// renderer's (the mock's opps.list) now take the best copy per item and revenue order among the matching rows.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { markSharedCopies } from '../../src/service/domain/engine';
import { listOpportunities, summarizeGroups as serviceGroups } from '../../src/service/domain/views';
import { filterOpportunities, groupOpportunities, profitableTotals, summarizeGroups } from '../../src/renderer/oppModel';
import { onceByOrderProfit } from '../../src/shared/copyExtras';
import type { OppQuery, Opportunity } from '../../src/shared/types';
import { makeOpp, makeOrder } from '../db/helpers';
import { T0 } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const L1 = makeOrder({ listingId: 'L1', valueScrap: 120, keys: 0, metalScrap: 120, flags: [] });

/** Copy A (import, +30, tier ref2, confidence 40) and copy B (typed, +10, tier small, confidence 80) on order L1. */
function copies(): Opportunity[] {
  const a = makeOpp({ inputRef: 'price:1', inputKind: 'import', costScrap: 90, revenueScrap: 120, profitScrap: 30, profitTier: 'ref2', confidence: 40, confidenceLevel: 'low', consOrder: L1, bestOrder: L1, flags: [] });
  const b = makeOpp({ inputRef: 'price:2', inputKind: 'user', costScrap: 110, revenueScrap: 120, profitScrap: 10, profitTier: 'small', confidence: 80, confidenceLevel: 'high', consOrder: L1, bestOrder: L1, flags: [] });
  const rows = [a, b];
  markSharedCopies(rows, 'conservative');
  return rows;
}

function service(rows: Opportunity[]) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertOpportunities(rows);
  return (q: OppQuery, useOrder?: 'best' | 'conservative' | 'instant') => listOpportunities(repo, { groupBy: 'category', ...q }, null, T0, useOrder).groups;
}

const QUERIES: [string, OppQuery, number][] = [
  ['no filter', {}, 30],
  ['typed prices only', { inputKinds: ['user'] }, 10],
  ['tier small', { tiers: ['small'] }, 10],
  ['minimum confidence 60', { minConfidence: 60 }, 10],
  ['imported only', { inputKinds: ['import'] }, 30],
];

describe('group totals under filters (R27)', () => {
  it('the engine flags the second copy (the setup)', () => {
    const [a, b] = copies();
    expect(a!.flags).not.toContain('shared-buyer');
    expect(b!.flags).toContain('shared-buyer');
  });

  it.each(QUERIES)('%s: service SQL, service and renderer summaries and the bar agree', (_label, q, want) => {
    const rows = copies();
    const groups = service(rows)(q);
    expect(groups.map((g) => [g.key, g.totalProfitScrap])).toEqual([['hats', want]]);
    const shown = filterOpportunities(rows, q);
    expect(summarizeGroups(shown, 'category')[0]?.totalProfitScrap).toBe(want);
    expect(serviceGroups(shown, 'category')[0]?.totalProfitScrap).toBe(want);
    expect(groupOpportunities(shown, 'category')[0]?.totalProfitScrap).toBe(want);
    // Every shown row is profitable here, so the group total is the summary bar's "together".
    expect(profitableTotals(shown, 'conservative').profit).toBe(want);
  });

  it('three copies on one order with the best hidden count the best shown once', () => {
    const c = makeOpp({ inputRef: 'price:3', inputKind: 'user', costScrap: 115, revenueScrap: 120, profitScrap: 5, profitTier: 'small', confidence: 80, confidenceLevel: 'high', consOrder: L1, bestOrder: L1, flags: [] });
    const rows = [...copies(), c];
    markSharedCopies(rows, 'conservative');
    const q: OppQuery = { inputKinds: ['user'] };
    expect(service(rows)(q)[0]?.totalProfitScrap).toBe(10);
    expect(summarizeGroups(filterOpportunities(rows, q), 'category')[0]?.totalProfitScrap).toBe(10);
    expect(service(rows)({})[0]).toMatchObject({ count: 3, totalProfitScrap: 30 });
  });

  it("follows useOrder's revenue order", () => {
    const best = makeOrder({ listingId: 'B9', valueScrap: 200, keys: 0, metalScrap: 200, flags: [] });
    const x = makeOpp({ inputRef: 'price:1', inputKind: 'import', costScrap: 120, revenueScrap: 200, profitScrap: 80, bestOrder: best, consOrder: makeOrder({ listingId: 'C1', valueScrap: 150, flags: [] }), flags: [] });
    const y = makeOpp({ inputRef: 'price:2', inputKind: 'import', costScrap: 130, revenueScrap: 200, profitScrap: 70, bestOrder: best, consOrder: makeOrder({ listingId: 'C2', valueScrap: 150, flags: [] }), flags: [] });
    const rows = [x, y];
    markSharedCopies(rows, 'best');
    const list = service(rows);
    expect(list({}, 'best')[0]?.totalProfitScrap).toBe(80);
    expect(summarizeGroups(rows, 'category', 'best')[0]?.totalProfitScrap).toBe(80);
    expect(serviceGroups(rows, 'category', 'best')[0]?.totalProfitScrap).toBe(80);
    // Under Conservative the two copies sell to different orders.
    expect(list({}, 'conservative')[0]?.totalProfitScrap).toBe(150);
    expect(list({})[0]?.totalProfitScrap).toBe(150);
  });

  it('rule rows are no copies (the engine flags price inputs only) and count alone', () => {
    const rule1 = makeOpp({ inputRef: 'rule:1', inputKind: 'rule', profitScrap: 20, consOrder: L1, revenueScrap: 120, flags: [] });
    const rule2 = makeOpp({ inputRef: 'rule:2', inputKind: 'rule', profitScrap: 15, consOrder: L1, revenueScrap: 120, flags: [] });
    const rows = [...copies(), rule1, rule2];
    expect(service(rows)({})[0]).toMatchObject({ count: 4, totalProfitScrap: 30 + 20 + 15 });
    expect(summarizeGroups(rows, 'category')[0]?.totalProfitScrap).toBe(30 + 20 + 15);
    expect(serviceGroups(rows, 'category')[0]?.totalProfitScrap).toBe(30 + 20 + 15);
  });

  it('rows with no order or no profit count alone; separate items never merge', () => {
    const noOrder = makeOpp({ inputRef: 'price:4', profitScrap: 7, consOrder: null, bestOrder: null, revenueScrap: null });
    const noProfit = makeOpp({ inputRef: 'price:5', profitScrap: null, consOrder: L1 });
    const other = makeOpp({ sku: '126;6', inputRef: 'price:6', profitScrap: 12, consOrder: L1, revenueScrap: 120 });
    const rows = [...copies(), noOrder, noProfit, other];
    expect(onceByOrderProfit(rows, (o) => o.consOrder)).toBe(30 + 7 + 12);
    expect(service(rows)({})[0]).toMatchObject({ count: 5, totalProfitScrap: 30 + 7 + 12 });
  });
});
