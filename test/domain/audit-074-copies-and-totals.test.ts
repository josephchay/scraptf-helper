// 0.7.4 (F66, F27, F33): copies of one item. Imports store a painted hat or a kit's sheen/killstreaker combo
// under the plain SKU with the extras in ScrapPrice.special, so the audited profile showed two identical
// "The Last Laugh" rows (Noble Hatter's Violet and After Eight) and 25 identical kit rows, and the totals added
// every copy priced against one buyer who wants one ("together +13.32 ref" for one possible sale).
// Opportunity.copyKey (derived at read time from the price row, no stored column) names the copy in the table,
// the drawer's input card and its "other copy" hover, and opens the drawer's history on that copy; a copy after
// the most profitable one on the same revenue order is flagged 'shared-buyer' and every total counts that order
// once. No parsing here: stub schema.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine, explicitInput, ruleInput } from '../../src/service/domain/engine';
import { summarizeGroups as serviceGroups } from '../../src/service/domain/views';
import {
  copyExtrasText,
  copyLabelOf,
  groupOpportunities,
  inputCardLabel,
  otherCopyName,
  profitableTotals,
  sharedBuyerNote,
  summarizeGroups,
} from '../../src/renderer/oppModel';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import { copyExtrasOf, markSharedBuyers, opportunityCopyKey } from '../../src/shared/copyExtras';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { Opportunity, OrderSummary } from '../../src/shared/types';
import { makeOpp } from '../db/helpers';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, special } from './helpers';

const K = 567;
const VIOLET = 5322826;
const AFTER_EIGHT = 2960676;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function world() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  const clock = new FakeClock();
  const events = recordingEvents();
  const engine = createEngine({ ...makeDeps(repo, clock, () => DEFAULT_SETTINGS), schema: createStubSchema(), events, timers: new FakeTimers(clock) });
  return { repo, clock, events, engine };
}

const order = (id: string, sku: string, scrap: number, steamid: string) =>
  makeListing({ id, sku, baseSku: sku, steamid, metalScrap: scrap, isBot: true, userOnline: true, lastEventAt: T0 - MIN });

describe('Opportunity.copyKey', () => {
  it('is the copy a price is for, the same in the engine and on every read; plain copies and rules carry none', async () => {
    const h = world();
    h.repo.upsertListings([order('gradle', '378;6', 1118, 'S1'), order('zebro', '378;6', 1087, 'S2')]);
    const violet = h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 1058, source: 'import', observedAt: T0 - 5 * MIN, special: special({ paint: VIOLET }) });
    const eight = h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 1058, source: 'import', observedAt: T0 - 5 * MIN, special: special({ paint: AFTER_EIGHT }) });
    const plain = h.repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 40, source: 'user', observedAt: T0 - 5 * MIN });
    await h.engine.runNow();

    const rows = h.repo.opportunitiesForSku('378;6');
    const byRef = new Map(rows.map((o) => [o.inputRef, o]));
    expect(byRef.get(`price:${violet.id}`)?.copyKey).toBe(bankStockSpecialKey({ paint: VIOLET }));
    expect(byRef.get(`price:${eight.id}`)?.copyKey).toBe(bankStockSpecialKey({ paint: AFTER_EIGHT }));
    expect(h.repo.getOpportunity(`378;6|price:${violet.id}`)?.copyKey).toBe(bankStockSpecialKey({ paint: VIOLET }));
    expect(h.repo.allOpportunities().find((o) => o.inputRef === `price:${plain.id}`)).not.toHaveProperty('copyKey');
    expect(h.repo.queryOpportunities({}).filter((o) => o.copyKey !== undefined)).toHaveLength(2);
    // The engine's own inputs agree, and a rule describes a clean copy.
    expect(explicitInput(violet)?.copyKey).toBe(bankStockSpecialKey({ paint: VIOLET }));
    expect(ruleInput({ id: 1, name: 'r', filter: {}, costKeys: 0, costScrap: 1, observedAt: T0, enabled: true }, '378;6').copyKey).toBeUndefined();

    // Derived, never stored: an unchanged run writes nothing (no churn from the copy key).
    const before = h.events.changed.length;
    await h.engine.runNow();
    expect(h.events.changed.length).toBe(before);
  });

  it('moves a SKU paint into the key, as explicitInput does, and reads kit sheens and killstreakers back', () => {
    expect(opportunityCopyKey('378;6;p5322826', null)).toBe(bankStockSpecialKey({ paint: VIOLET }));
    expect(opportunityCopyKey('378;6;p5322826', special())).toBe(bankStockSpecialKey({ paint: VIOLET }));
    expect(opportunityCopyKey('378;6', null)).toBe('');
    expect(opportunityCopyKey('378;6', special())).toBe('');
    const kit = opportunityCopyKey('6526;6;uncraftable;kt-3;td-205', special({ sheen: 1, killstreaker: 2002 }));
    expect(copyExtrasOf(kit)).toMatchObject({ sheen: 1, killstreaker: 2002, paint: null });
    expect(copyExtrasOf('')).toBeNull();
    expect(copyExtrasOf('{broken')).toBeNull();
  });
});

describe('naming the copy', () => {
  const kitKey = bankStockSpecialKey({ sheen: 1, killstreaker: 2002 });
  it('in the table, the input card and the other-copy hover', () => {
    expect(copyExtrasText(bankStockSpecialKey({ paint: VIOLET }))).toEqual(["Noble Hatter's Violet"]);
    expect(copyLabelOf({ copyKey: kitKey, inputKind: 'import' })).toEqual({
      text: 'Team Shine, Fire Horns',
      // 0.7.4 (R30): each copy is priced against its own buyers, not a clean copy's.
      title: 'This copy: Team Shine, Fire Horns. Each copy of an item is its own row, priced against the buyers who take this copy (generic orders and any that ask for its extras).',
    });
    const busy = bankStockSpecialKey({ paint: AFTER_EIGHT, spells: ['Exorcism'], parts: ['Kills'] });
    expect(copyLabelOf({ copyKey: busy, inputKind: 'user' })?.text).toBe('After Eight, Spell: Exorcism +1');
    expect(copyLabelOf({ inputKind: 'import' })).toBeNull();
    expect(copyLabelOf({ copyKey: kitKey, inputKind: 'rule' })).toBeNull();

    expect(inputCardLabel({ inputKind: 'import', inputRef: 'price:1960', copyKey: bankStockSpecialKey({ paint: VIOLET }) }, { importBatch: 35 })).toBe(
      "Imported price #1960 · import #35 · Noble Hatter's Violet",
    );
    expect(inputCardLabel({ inputKind: 'import', inputRef: 'price:1554' }, { importBatch: 33 })).toBe('Imported price #1554 · import #33');
    expect(otherCopyName({ sku: '31406;6', name: 'The Last Laugh', special: special({ paint: AFTER_EIGHT }) })).toBe('The Last Laugh (After Eight)');
    expect(otherCopyName({ sku: '31406;6', name: 'The Last Laugh', special: null })).toBe('The Last Laugh');
  });
});

describe("copies sharing one buyer ('shared-buyer') and the totals", () => {
  it('flags every copy after the most profitable on one order; the totals count that order once', async () => {
    const h = world();
    h.repo.upsertListings([order('gradle', '378;6', 1118, 'S1')]);
    const a = h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 900, source: 'import', observedAt: T0 - 5 * MIN, special: special({ paint: VIOLET }) });
    const b = h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 890, source: 'import', observedAt: T0 - 5 * MIN, special: special({ paint: AFTER_EIGHT }) });
    await h.engine.runNow();
    const rows = h.repo.opportunitiesForSku('378;6');
    expect(rows.map((o) => [o.inputRef, o.profitScrap, o.flags.includes('shared-buyer')])).toEqual([
      [`price:${b.id}`, 228, false],
      [`price:${a.id}`, 218, true],
    ]);
    expect(rows.every((o) => o.status === 'profitable')).toBe(true);
    // Every total counts the order once: the service's SQL and in-memory sums, the renderer's.
    expect(h.repo.opportunityGroupStats({}, 'category')).toEqual([{ key: 'hats', count: 2, profitScrap: 228 }]);
    expect(serviceGroups(rows, 'category')[0]).toMatchObject({ count: 2, totalProfitScrap: 228 });
    expect(summarizeGroups(rows, 'category')[0]).toMatchObject({ count: 2, totalProfitScrap: 228 });
    expect(groupOpportunities(rows, 'category')[0]).toMatchObject({ count: 2, totalProfitScrap: 228 });
    expect(profitableTotals(rows, 'conservative')).toEqual({ profit: 228, profitable: 2, sharedCopies: 1 });
    expect(sharedBuyerNote(1)).toBe('1 copy shares a buyer, counted once');
  });

  it('copies on different orders are not flagged', async () => {
    const h = world();
    // A paint-specific order buys only the violet copy; the generic one buys the other.
    h.repo.upsertListings([order('generic', '378;6', 1118, 'S1'), { ...order('violet', '378;6', 1300, 'S2'), special: special({ paint: VIOLET }) }]);
    h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 1058, source: 'import', observedAt: T0 - 5 * MIN, special: special({ paint: VIOLET }) });
    h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 1058, source: 'import', observedAt: T0 - 5 * MIN, special: special({ paint: AFTER_EIGHT }) });
    await h.engine.runNow();
    const rows = h.repo.opportunitiesForSku('378;6');
    expect(rows).toHaveLength(2);
    expect(rows.some((o) => o.flags.includes('shared-buyer'))).toBe(false);
  });
});

describe('profitableTotals', () => {
  const ord = (listingId: string, valueScrap: number): OrderSummary =>
    ({ listingId, steamid: listingId, userName: null, isBot: true, keys: 0, metalScrap: valueScrap, valueScrap, online: true, lastEventAt: T0, flags: [], eligible: true } as unknown as OrderSummary);
  const opp = (key: string, profit: number | null, cons: OrderSummary | null, over: Partial<Opportunity> = {}): Opportunity =>
    makeOpp({ key, status: 'profitable', profitScrap: profit, revenueScrap: cons?.valueScrap ?? null, consOrder: cons, bestOrder: cons, instantOrder: cons, ...over });

  it('one profit per revenue order, the most profitable row; rows without an order count alone', () => {
    const shared = ord('L1', 200);
    const other = ord('L2', 100);
    const rows = [opp('a', 60, shared), opp('b', 50, shared), opp('c', 30, other), opp('d', 20, null), opp('e', 25, null), opp('f', 90, shared, { status: 'below-threshold' })];
    expect(profitableTotals(rows, 'conservative')).toEqual({ profit: 60 + 30 + 20 + 25, profitable: 5, sharedCopies: 1 });
  });

  it("follows the stored revenue's order under the useOrder in force", () => {
    const best = ord('B', 300);
    const cons1 = ord('C1', 200);
    const cons2 = ord('C2', 190);
    const rows = [
      opp('x', 80, cons1, { bestOrder: best, revenueScrap: 300 }),
      opp('y', 70, cons2, { bestOrder: best, revenueScrap: 300 }),
    ];
    expect(profitableTotals(rows, 'best')).toMatchObject({ profit: 80, sharedCopies: 1 });
  });

  it('markSharedBuyers ignores rows with no profit and keeps the flag once', () => {
    const o1 = opp('1', 10, ord('L', 50));
    const o2 = opp('2', null, ord('L', 50));
    const o3 = opp('3', 10, ord('L', 50), { flags: ['shared-buyer'] });
    markSharedBuyers([o1, o2, o3], (o) => o.consOrder);
    expect([o1.flags, o2.flags, o3.flags]).toEqual([[], [], ['shared-buyer']]);
  });
});

