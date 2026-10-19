// F5's suspect-margin rule, shared since 0.6: the engine flags an opportunity with scoreConfidence, and the
// "New on scrap.tf" notifications (F17) apply isSuspectMargin to the Live market entry of the same book
// (MarketEval.eligibleCount and .referenced). Both must call the same cost suspect, or a toast the engine
// would hold back goes out from the other path. Pure evaluation; no repo, no network.

import { describe, expect, it } from 'vitest';
import { isSuspectMargin } from '../../src/service/domain/confidence';
import { evaluateOpportunity, explicitInput } from '../../src/service/domain/engine';
import { evaluateMarketBase } from '../../src/service/domain/market';
import { matchContext } from '../../src/service/domain/matcher';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, Listing, ReferencePrices, Settings } from '../../src/shared/types';
import { HOUR, MIN, T0, makeListing } from './helpers';

const K = 567;
const DAY = 24 * HOUR;
const base = '126;6';

function buyers(n: number): Listing[] {
  return Array.from({ length: n }, (_, i) => makeListing({ id: `sm${n}-${i}`, sku: base, baseSku: base, steamid: `SM${i}`, metalScrap: 200 - i, lastEventAt: T0 - MIN }));
}

const NO_REFS: ReferencePrices = { pricedb: null, community: null };
const PDB: ReferencePrices = { pricedb: { buyScrap: 190, sellScrap: 210, time: Math.floor(T0 / 1000), ageMs: 0 }, community: null };
const SELL_ONLY: ReferencePrices = { pricedb: { buyScrap: 0, sellScrap: 210, time: Math.floor(T0 / 1000), ageMs: 0 }, community: null };
const STALE: ReferencePrices = { pricedb: { buyScrap: 190, sellScrap: 210, time: Math.floor((T0 - 60 * DAY) / 1000), ageMs: 60 * DAY }, community: null };

function both(costScrap: number, orders: number, references: ReferencePrices, patch: DeepPartial<Settings> = {}) {
  const settings = mergeSettings(DEFAULT_SETTINGS, patch);
  const listings = buyers(orders);
  const match = matchContext(settings, T0);
  const input = explicitInput({ id: 1, sku: base, name: "Bill's Hat", costKeys: 0, costScrap, source: 'import', observedAt: T0, note: null, importBatch: 1, special: null, assetId: null, stock: 1 })!;
  const opp = evaluateOpportunity({ input, listings, references, category: 'hats', isUnusual: false, settings, keyScrap: K, now: T0, match, prev: null });
  const ev = evaluateMarketBase({ base, listings, references, isUnusual: false, settings, keyScrap: K, now: T0, match })!;
  // What the bank stock row computes from the same cost: profit / cost, unbounded for a free item.
  const margin = opp.margin ?? (costScrap <= 0 && (opp.profitScrap ?? 0) > 0 ? Number.POSITIVE_INFINITY : null);
  return { engine: opp.flags.includes('suspect-margin'), shared: isSuspectMargin(margin, ev.eligibleCount, ev.referenced, settings.profit.suspectMargin), ev };
}

describe('isSuspectMargin and the engine agree', () => {
  it.each<[string, number, number, ReferencePrices, DeepPartial<Settings>, boolean]>([
    ['a huge margin, 2 orders, no reference', 10, 2, NO_REFS, {}, true],
    ['a free item, 1 order, no reference', 0, 1, NO_REFS, {}, true],
    ['three orders check each other', 10, 3, NO_REFS, {}, false],
    ['a PriceDB price checks it', 10, 2, PDB, {}, false],
    ['a PriceDB sell price alone checks it too', 10, 2, SELL_ONLY, {}, false],
    ['a stale reference counts as none', 10, 2, STALE, {}, true],
    ['a margin under the limit', 100, 2, NO_REFS, {}, false],
    ['the guard turned off', 10, 2, NO_REFS, { profit: { suspectMargin: 0 } }, false],
  ])('%s', (_why, cost, orders, refs, patch, suspect) => {
    const r = both(cost, orders, refs, patch);
    expect(r.engine).toBe(suspect);
    expect(r.shared).toBe(suspect);
  });

  it('MarketEval.referenced is a usable reference after the age gate', () => {
    expect(both(10, 2, PDB).ev.referenced).toBe(true);
    expect(both(10, 2, SELL_ONLY).ev.referenced).toBe(true);
    expect(both(10, 2, NO_REFS).ev.referenced).toBe(false);
    expect(both(10, 2, STALE).ev.referenced).toBe(false);
  });
});
