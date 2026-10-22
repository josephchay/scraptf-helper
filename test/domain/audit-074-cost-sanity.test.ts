// 0.7.4 trading accuracy audit (package PB), F22 + F70: nothing compared the scrap.tf cost with the
// market, so a wrong-variant price (the /items craftability slip) read as Medium or High. costSanity
// (src/shared/ceiling.ts) checks the cost against the item's own usable PriceDB price and its
// craftability twin's: 'variant-suspect' or 'cost-below-market', capped at Low, never notified.
// Also the confidence parts of F23/F29/F19: online and near buyers need recent, verified orders.
// The engine case names its items through the real schema fixture (test/pricedb/helpers).

import { afterEach, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { scoreConfidence, type ConfidenceInput } from '../../src/service/domain/confidence';
import { createEngine } from '../../src/service/domain/engine';
import type { ValuedOrderLike } from '../../src/service/domain/pricing';
import { lookupTwinReferences } from '../../src/service/domain/pricing';
import {
  COST_BELOW_MARKET_MIN_GAP,
  costSanity,
  costSanityReason,
  craftabilityTwin,
  pricedbBand,
  type PricedbSides,
} from '../../src/shared/ceiling';
import { formatScrap } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { Listing, ReferencePrices } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, HOUR, MIN, T0, makeDeps, makeListing, recordingEvents } from './helpers';

const K = 577;
const DAY = 24 * HOUR;
const P = DEFAULT_SETTINGS.profit;
const sides = (buyScrap: number | null, sellScrap: number | null): PricedbSides => ({ buyScrap, sellScrap });
const refs = (buyScrap: number | null, sellScrap: number | null, ageMs: number | null = 0): ReferencePrices => ({
  pricedb: { buyScrap, sellScrap, time: null, ageMs },
  community: null,
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

describe('costSanity (shared rule)', () => {
  it("flags A Distinctive Lack of Hue's Non-Craftable price under the craftable SKU as variant-suspect", () => {
    // User data, K = 577: cost 966, own PriceDB 1230-1367, the uncraftable twin 910-969.
    const s = costSanity(966, sides(1230, 1367), () => sides(910, 969));
    expect(s).toEqual({ flag: 'variant-suspect', own: { low: 1230, high: 1367 }, twin: { low: 910, high: 969 } });
    expect(costSanityReason(s!, false, (v) => formatScrap(v, K))).toMatch(
      /^scrap\.tf price matches the Non-Craftable copy on PriceDB \(1 key .* to 1 key .*\), not this item \(2 keys .* to 2 keys .*\)\. Check craftability before buying$/,
    );
    // The twin of a Non-Craftable item is the craftable copy.
    expect(costSanityReason(s!, true, String)).toMatch(/matches the Craftable copy/);
  });

  it('falls back to cost-below-market without a twin, and when the cost is not near the twin', () => {
    expect(costSanity(966, sides(1230, 1367), () => null)).toEqual({ flag: 'cost-below-market', ownBuy: 1230 });
    // The Bitter Taste of Defeat and Lime: 874 against 931 is not under 0.9x, but under 0.95x by 57 scrap.
    expect(costSanity(874, sides(931, 1000), () => sides(780, 818))).toEqual({ flag: 'cost-below-market', ownBuy: 931 });
    expect(costSanityReason({ flag: 'cost-below-market', ownBuy: 931 }, false, (v) => formatScrap(v, K))).toBe(
      'scrap.tf price is under 95% of the PriceDB buy price (1 key 39.33 ref): bots pay more than scrap.tf charges. Check craftability, quality and kit tier',
    );
  });

  it('reads the twin only when the cost is far under the item\'s own band', () => {
    let reads = 0;
    const twin = () => {
      reads++;
      return sides(910, 969);
    };
    expect(costSanity(1200, sides(1230, 1367), twin)).toBeNull();
    expect(costSanity(1110, sides(1230, 1367), twin)?.flag).toBe('cost-below-market');
    expect(reads).toBe(0);
    costSanity(1100, sides(1230, 1367), twin);
    expect(reads).toBe(1);
  });

  it('leaves genuine prices alone', () => {
    // Strange Archer's Sterling 103 against 102, Blue Summer 2013 Cooler Key 700 against 703.
    expect(costSanity(103, sides(102, 110), () => null)).toBeNull();
    expect(costSanity(700, sides(703, 720), () => null)).toBeNull();
    // The Sammy Cap 16 against 18: under 0.95x but less than 1 ref apart.
    expect(costSanity(16, sides(18, 20), () => null)).toBeNull();
    expect(costSanity(18 - COST_BELOW_MARKET_MIN_GAP, sides(18, 20), () => null)?.flag).toBe('cost-below-market');
    // Above the item's own band is normal markup, even right at a pricier twin.
    expect(costSanity(1500, sides(1230, 1367), () => sides(1450, 1550))).toBeNull();
    // A free item, no PriceDB price, or a broken cost is never checked.
    expect(costSanity(0, sides(100, 120), () => null)).toBeNull();
    expect(costSanity(50, null, () => sides(50, 55))).toBeNull();
    expect(costSanity(Number.NaN, sides(100, 120), () => null)).toBeNull();
  });

  it('builds bands from the positive sides only', () => {
    expect(pricedbBand(sides(1230, 1367))).toEqual({ low: 1230, high: 1367 });
    expect(pricedbBand(sides(null, 969))).toEqual({ low: 969, high: 969 });
    expect(pricedbBand(sides(0, null))).toBeNull();
    expect(pricedbBand(null)).toBeNull();
  });

  it('finds the craftability twin through the SKU object, never for currencies or bad SKUs', () => {
    expect(craftabilityTwin('5040;6')).toBe('5040;6;uncraftable');
    expect(craftabilityTwin('5040;6;uncraftable')).toBe('5040;6');
    expect(craftabilityTwin('378;5;u13')).toBe('378;5;u13;uncraftable');
    expect(craftabilityTwin('5021;6')).toBeNull();
    expect(craftabilityTwin('not a sku')).toBeNull();
  });
});

function order(value: number, over: Partial<Listing> = {}, flags: string[] = []): ValuedOrderLike & { flags: string[] } {
  return { listing: makeListing({ metalScrap: value, lastEventAt: T0 - 3 * HOUR, ...over }), valueScrap: value, flags };
}

function input(over: Partial<ConfidenceInput> = {}): ConfidenceInput {
  const o = order(1436, { isBot: true, uaLastPulse: Math.floor(T0 / 1000), lastEventAt: T0 - MIN, steamid: 'bot' });
  return {
    order: o,
    eligible: [o, order(1400, { steamid: 'b2', lastEventAt: T0 - MIN })],
    references: refs(1230, 1367),
    inputKind: 'import',
    inputObservedAt: T0 - MIN,
    isUnusual: false,
    revenueScrap: 1436,
    costScrap: 966,
    twin: { craftable: false, references: () => refs(910, 969) },
    keyScrap: K,
    now: T0,
    profit: P,
    ...over,
  };
}

describe('scoreConfidence: the cost checks (F22, F70)', () => {
  it('caps a variant-suspect row at Low with the reason last', () => {
    const r = scoreConfidence(input());
    expect(r.flags).toContain('variant-suspect');
    expect(r.flags).not.toContain('cost-below-market');
    expect(r.score).toBe(44);
    expect(r.level).toBe('low');
    expect(r.reasons.at(-1)).toMatch(/^scrap\.tf price matches the Non-Craftable copy on PriceDB/);
  });

  it('flags cost-below-market without a usable twin, and ignores a stale twin', () => {
    expect(scoreConfidence(input({ twin: null })).flags).toContain('cost-below-market');
    const staleTwin = scoreConfidence(input({ twin: { craftable: false, references: () => refs(910, 969, 400 * DAY) } }));
    expect(staleTwin.flags).toContain('cost-below-market');
    expect(staleTwin.flags).not.toContain('variant-suspect');
    expect(staleTwin.score).toBeLessThanOrEqual(44);
  });

  it('never checks against a stale PriceDB price, a community price, a rule estimate or a missing cost', () => {
    const flagged = (over: Partial<ConfidenceInput>) => {
      const f = scoreConfidence(input(over)).flags;
      return f.includes('variant-suspect') || f.includes('cost-below-market');
    };
    expect(flagged({ references: refs(1230, 1367, 400 * DAY) })).toBe(false);
    expect(flagged({ references: { pricedb: null, community: { valueScrap: 1500, valueHighScrap: null, lastUpdate: null } } })).toBe(false);
    expect(flagged({ inputKind: 'rule' })).toBe(false);
    expect(flagged({ costScrap: null })).toBe(false);
    const { costScrap: _omit, ...noCost } = input();
    expect(scoreConfidence(noCost).flags).not.toContain('cost-below-market');
    // A genuine cost keeps its score.
    expect(scoreConfidence(input({ costScrap: 1300 })).score).toBeGreaterThan(44);
  });
});

describe('scoreConfidence: buyer liveness and near buyers (F23, F29, F19)', () => {
  const plain = (over: Partial<ConfidenceInput>) => scoreConfidence(input({ costScrap: null, twin: null, references: refs(null, null), ...over }));

  it("gives no '+5 Buyer is online' from an event days old", () => {
    const stale = order(115, { userOnline: true, lastEventAt: T0 - 136 * HOUR, steamid: 'PAYAH' });
    const r = plain({ order: stale, eligible: [stale], revenueScrap: 115 });
    expect(r.reasons).not.toContain('+5 Buyer is online');
    const fresh = order(115, { userOnline: true, lastEventAt: T0 - 10 * MIN });
    expect(plain({ order: fresh, eligible: [fresh], revenueScrap: 115 }).reasons).toContain('+5 Buyer is online');
  });

  it('counts only verified neighbours as buyers within 10%', () => {
    const o = order(130, { steamid: 'A' });
    const staleNear = order(119, { steamid: 'B', lastEventAt: T0 - 25 * HOUR });
    const flaggedNear = order(125, { steamid: 'C' }, ['unverified']);
    const freshNear = order(125, { steamid: 'D' });
    expect(plain({ order: o, eligible: [o, staleNear, flaggedNear], revenueScrap: 130 }).reasons.some((r) => r.includes('within 10%'))).toBe(false);
    expect(plain({ order: o, eligible: [o, staleNear, freshNear], revenueScrap: 130 }).reasons).toContain('+10 2 buyers within 10% of this price');
    // An unverified revenue order still counts itself (its own buyer).
    const lone = order(130, { steamid: 'E', lastEventAt: T0 - 30 * HOUR });
    expect(plain({ order: lone, eligible: [lone, freshNear], revenueScrap: 130 }).reasons).toContain('+10 2 buyers within 10% of this price');
  });

  it('reproduces Strange Archer\'s Sterling: 45, without the stale online and near-buyer bonuses', () => {
    const payah = order(115, { steamid: 'PAYAH', isBot: true, userOnline: true, lastEventAt: T0 - 136 * HOUR }, ['unverified']);
    const eligible = [
      payah,
      order(114, { steamid: 'ZeBro', isBot: true, lastEventAt: T0 - 140 * HOUR }, ['unverified']),
      order(106, { steamid: 'Dispenser', isBot: true, lastEventAt: T0 - 92 * HOUR }, ['unverified']),
      order(100, { steamid: 'SpaceBot', lastEventAt: T0 - 21 * HOUR }),
      order(80, { steamid: 'BB-8', isBot: true, lastEventAt: T0 - 12 * MIN }),
    ];
    // 50 - 15 (unverified) + 10 (agrees with PriceDB buy 102); before 0.7.4 also +5 online and +10 near buyers.
    const r = scoreConfidence(input({ order: payah, eligible, revenueScrap: 115, references: refs(102, 120), costScrap: 103, twin: null }));
    expect(r.score).toBe(45);
    expect(r.flags).toContain('unverified-orders');
  });

  it('gives no near-buyer bonus around a zero price ("0.05 ref" orders)', () => {
    const zero = order(0, { steamid: 'Z1' });
    const r = plain({ order: zero, eligible: [zero, order(0, { steamid: 'Z2' }), order(0, { steamid: 'Z3' })], revenueScrap: 0 });
    expect(r.reasons.some((x) => x.includes('within 10%'))).toBe(false);
  });
});

describe('the engine: a wrong-variant cost is shown at Low and never toasted (F70)', () => {
  it('flags 5040;6 priced like its Non-Craftable twin, names the twin, and sends no toast', async () => {
    // Item names come from the real schema fixture: 5040 is A Distinctive Lack of Hue.
    const schema = createSchemaService(schemaDeps(schemaRoute()));
    await schema.init();
    expect(schema.nameForSku('5040;6')).toBe('A Distinctive Lack of Hue');
    expect(schema.nameForSku(craftabilityTwin('5040;6')!)).toBe('Non-Craftable A Distinctive Lack of Hue');

    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
    const sec = Math.floor(T0 / 1000);
    repo.upsertPricedb([
      { sku: '5040;6', name: 'A Distinctive Lack of Hue', buyKeys: 2, buyScrap: 76, sellKeys: 2, sellScrap: 213, time: sec, fetchedAt: T0 },
      { sku: '5040;6;uncraftable', name: 'Non-Craftable A Distinctive Lack of Hue', buyKeys: 1, buyScrap: 333, sellKeys: 1, sellScrap: 392, time: sec, fetchedAt: T0 },
    ]);
    expect(lookupTwinReferences(repo, '5040;6')?.pricedb?.sku).toBe('5040;6;uncraftable');
    // A fresh bot order at 2 keys 22 ref and two more buyers, and the mis-keyed list price of 1 key 389 scrap.
    repo.upsertListings(
      [2 * K + 198, 2 * K + 190, 2 * K + 180].map((v, i) =>
        makeListing({ id: `hue-${i}`, sku: '5040;6', baseSku: '5040;6', steamid: `H${i}`, metalScrap: v, isBot: i === 0, uaLastPulse: sec, lastEventAt: T0 - MIN }),
      ),
    );
    repo.upsertScrapPrice({ sku: '5040;6', name: 'A Distinctive Lack of Hue', costKeys: 1, costScrap: 389, source: 'import', observedAt: T0 - MIN });

    const clock = new FakeClock();
    const events = recordingEvents();
    const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } });
    const engine = createEngine({ ...makeDeps(repo, clock, () => settings), schema, events, timers: new FakeTimers(clock) });
    await engine.runNow();
    const [opp] = repo.allOpportunities();
    expect(opp).toMatchObject({ status: 'profitable', confidenceLevel: 'low' });
    expect(opp!.flags).toContain('variant-suspect');
    expect(opp!.reasons.at(-1)).toMatch(/matches the Non-Craftable copy on PriceDB/);
    expect(events.notified).toEqual([]);
    expect(repo.listEvents({ kinds: ['notified'] })).toEqual([]);
  });
});
