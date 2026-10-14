import { describe, expect, it } from 'vitest';
import type { Listing, ReferencePrices } from '../../src/shared/types';
import { scoreConfidence } from '../../src/service/domain/confidence';
import type { ConfidenceInput } from '../../src/service/domain/confidence';
import type { ValuedOrderLike } from '../../src/service/domain/pricing';
import { HOUR, MIN, T0, makeListing, testSettings } from './helpers';

const K = 567;
const P = testSettings().profit;

function order(value: number, over: Partial<Listing> = {}, flags: string[] = []): ValuedOrderLike & { flags: string[] } {
  // 3 h old: neither "confirmed in 2 h" (+10) nor "unverified" (-15).
  return { listing: makeListing({ metalScrap: value, lastEventAt: T0 - 3 * HOUR, ...over }), valueScrap: value, flags };
}

/** 1.3x the PriceDB buy price: a reference exists but neither agrees (+10) nor is far off (-20). */
const NEUTRAL_REFS: ReferencePrices = { pricedb: { buyScrap: 100, sellScrap: 200, time: null, ageMs: null }, community: null };

/** Every adjustment is zero, so the score is the base 50. */
function base(over: Partial<ConfidenceInput> = {}): ConfidenceInput {
  const o = order(130);
  return {
    order: o,
    eligible: [o],
    references: NEUTRAL_REFS,
    inputKind: 'user',
    inputObservedAt: T0 - MIN,
    isUnusual: false,
    revenueScrap: 130,
    keyScrap: K,
    now: T0,
    profit: P,
    ...over,
  };
}

function delta(over: Partial<ConfidenceInput>): number {
  return scoreConfidence(base(over)).score - 50;
}

describe('scoreConfidence (brief §5.7 table)', () => {
  it('starts at 50 with nothing to adjust', () => {
    const r = scoreConfidence(base());
    expect(r.score).toBe(50);
    expect(r.level).toBe('medium');
    expect(r.reasons).toEqual(['0 scrap.tf price is fresh (under 15 min)']);
    expect(r.flags).toEqual([]);
  });

  it('+20 for a bot whose userAgent pulsed within 30 min', () => {
    const pulse = (ms: number) => Math.floor((T0 - ms) / 1000);
    expect(delta({ order: order(130, { isBot: true, uaLastPulse: pulse(10 * MIN) }) })).toBe(20);
    expect(delta({ order: order(130, { isBot: true, uaLastPulse: pulse(30 * MIN) }) })).toBe(20);
    expect(delta({ order: order(130, { isBot: true, uaLastPulse: pulse(31 * MIN) }) })).toBe(0);
    expect(delta({ order: order(130, { isBot: true, uaLastPulse: null }) })).toBe(0);
    expect(delta({ order: order(130, { isBot: false, uaLastPulse: pulse(MIN) }) })).toBe(0);
  });

  it('+5 when the buyer is online', () => {
    expect(delta({ order: order(130, { userOnline: true }) })).toBe(5);
    expect(delta({ order: order(130, { userOnline: false }) })).toBe(0);
    expect(delta({ order: order(130, { userOnline: null }) })).toBe(0);
  });

  it('+10 when the order was confirmed within 2 h', () => {
    expect(delta({ order: order(130, { lastEventAt: T0 - 2 * HOUR }) })).toBe(10);
    expect(delta({ order: order(130, { lastEventAt: T0 - 2 * HOUR - 1 }) })).toBe(0);
  });

  it('-15 when the order is unverified for over 24 h, and never High', () => {
    const r = scoreConfidence(base({ order: order(130, { lastEventAt: T0 - 25 * HOUR }) }));
    expect(r.score).toBe(35);
    expect(r.flags).toContain('unverified-orders');
    expect(r.reasons).toContain('-15 Order not confirmed for over 24 h');

    const strong = order(100, { lastEventAt: T0 - 25 * HOUR, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true });
    const other = order(100, { steamid: 'other' });
    // 50 + 20 + 5 - 15 + 10 (2 buyers) + 10 (agrees) = 80 -> capped at 69
    const capped = scoreConfidence(base({ order: strong, eligible: [strong, other], revenueScrap: 100 }));
    expect(capped.score).toBe(69);
    expect(capped.level).toBe('medium');
    expect(capped.reasons.at(-1)).toBe('Capped at Medium: the order is unverified');
  });

  it('+10 for at least 2 distinct buyers within 10%', () => {
    const o = order(130);
    const near = order(119, { steamid: 'B' });
    const far = order(116, { steamid: 'C' });
    const sameBuyer = order(125, { steamid: o.listing.steamid });
    expect(delta({ order: o, eligible: [o, near] })).toBe(10);
    expect(delta({ order: o, eligible: [o, far] })).toBe(0);
    expect(delta({ order: o, eligible: [o, sameBuyer] })).toBe(0);
    const r = scoreConfidence(base({ order: o, eligible: [o, near, order(140, { steamid: 'D' })] }));
    expect(r.reasons).toContain('+10 3 buyers within 10% of this price');
  });

  it('+10 when within 0.8-1.2x of PriceDB buy or the community price', () => {
    const pdb = (buyScrap: number): ReferencePrices => ({ pricedb: { buyScrap, sellScrap: null, time: null, ageMs: null }, community: null });
    const comm = (valueScrap: number): ReferencePrices => ({ pricedb: null, community: { valueScrap, valueHighScrap: null, lastUpdate: null } });
    expect(delta({ references: pdb(130) })).toBe(10);
    expect(delta({ references: pdb(162.5) })).toBe(10); // 130 = 0.8 x 162.5
    expect(delta({ references: pdb(108.4) })).toBe(10); // 1.199x
    expect(delta({ references: pdb(108) })).toBe(0); // 1.204x
    expect(delta({ references: comm(120) })).toBe(10);
    // PriceDB disagrees but the community price agrees.
    expect(delta({ references: { ...pdb(100), community: { valueScrap: 125, valueHighScrap: null, lastUpdate: null } } })).toBe(10);
  });

  it('-20 when more than 1.5x either reference (agreeing with the other does not help)', () => {
    expect(delta({ references: { pricedb: { buyScrap: 80, sellScrap: null, time: null, ageMs: null }, community: null } })).toBe(-20);
    const mixed: ReferencePrices = {
      pricedb: { buyScrap: 130, sellScrap: null, time: null, ageMs: null },
      community: { valueScrap: 50, valueHighScrap: null, lastUpdate: null },
    };
    const r = scoreConfidence(base({ references: mixed }));
    expect(r.score).toBe(30);
    expect(r.reasons).toContain('-20 Price is over 1.5x the backpack.tf community price');
  });

  it('-10 and a flag without any reference price', () => {
    const r = scoreConfidence(base({ references: { pricedb: null, community: null } }));
    expect(r.score).toBe(40);
    expect(r.flags).toEqual(['no-reference']);
    // Zero or missing values are not references.
    expect(delta({ references: { pricedb: { buyScrap: null, sellScrap: 500, time: null, ageMs: null }, community: { valueScrap: 0, valueHighScrap: null, lastUpdate: null } } })).toBe(-10);
  });

  it('scrap.tf price age: 0 / -10 / -25', () => {
    expect(delta({ inputObservedAt: T0 - 15 * MIN })).toBe(0);
    expect(delta({ inputObservedAt: T0 - 15 * MIN - 1 })).toBe(-10);
    expect(delta({ inputObservedAt: T0 - 2 * HOUR })).toBe(-10);
    const stale = scoreConfidence(base({ inputObservedAt: T0 - 2 * HOUR - 1 }));
    expect(stale.score).toBe(25);
    expect(stale.flags).toEqual(['stale-input']);
    expect(stale.reasons).toContain('-25 scrap.tf price is over 2 h old');
    // The stale boundary follows settings.
    expect(delta({ inputObservedAt: T0 - 3 * HOUR, profit: { ...P, inputStaleMs: 4 * HOUR } })).toBe(-10);
  });

  it('-25 for a rule-based estimate (age does not matter) and capped at Medium', () => {
    const r = scoreConfidence(base({ inputKind: 'rule', inputObservedAt: T0 - 100 * HOUR }));
    expect(r.score).toBe(25);
    expect(r.flags).toEqual(['rule-estimate']);

    const bot = order(130, { isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 });
    const peer = order(128, { steamid: 'peer' });
    // 50 + 20 + 5 + 10 + 10 + 10 (agrees) - 25 = 80 -> 69
    const capped = scoreConfidence(
      base({ inputKind: 'rule', order: bot, eligible: [bot, peer], references: { pricedb: { buyScrap: 130, sellScrap: null, time: null, ageMs: null }, community: null } }),
    );
    expect(capped.score).toBe(69);
    expect(capped.reasons.at(-1)).toBe('Capped at Medium: rule estimates are never High');
  });

  it('-10 once for a notes keyword or "has extras"', () => {
    expect(delta({ order: order(130, {}, ['notes-flag']) })).toBe(-10);
    expect(delta({ order: order(130, {}, ['has-extras']) })).toBe(-10);
    const both = scoreConfidence(base({ order: order(130, {}, ['notes-flag', 'has-extras']) }));
    expect(both.score).toBe(40);
    expect(both.flags).toEqual(['notes-flag', 'has-extras']);
  });

  it('-15 for an unusual worth over 10 keys', () => {
    const big = 10 * K + 1;
    const o = order(big);
    const refs: ReferencePrices = { pricedb: { buyScrap: Math.round(big / 1.3), sellScrap: null, time: null, ageMs: null }, community: null };
    const r = scoreConfidence(base({ order: o, eligible: [o], revenueScrap: big, isUnusual: true, references: refs }));
    expect(r.score).toBe(35);
    expect(r.flags).toEqual(['unusual-risk']);
    expect(delta({ order: o, eligible: [o], revenueScrap: 10 * K, isUnusual: true, references: refs })).toBe(0);
    expect(delta({ order: o, eligible: [o], revenueScrap: big, isUnusual: false, references: refs })).toBe(0);
    expect(delta({ order: o, eligible: [o], revenueScrap: big, isUnusual: true, references: refs, profit: { ...P, unusualRiskKeys: 20 } })).toBe(0);
  });

  it('clamps to 0..100', () => {
    const best = order(130, { isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 });
    const peer = order(130, { steamid: 'peer' });
    const top = scoreConfidence(
      base({ order: best, eligible: [best, peer], references: { pricedb: { buyScrap: 130, sellScrap: null, time: null, ageMs: null }, community: null } }),
    );
    expect(top.score).toBe(100); // 105 before clamping

    const worst = order(10 * K + 100, { lastEventAt: T0 - 48 * HOUR }, ['notes-flag']);
    const bottom = scoreConfidence(
      base({
        order: worst,
        eligible: [worst],
        revenueScrap: worst.valueScrap,
        isUnusual: true,
        inputObservedAt: T0 - 10 * HOUR,
        references: { pricedb: { buyScrap: 100, sellScrap: null, time: null, ageMs: null }, community: null },
      }),
    );
    expect(bottom.score).toBe(0); // 50 - 15 - 20 - 10 - 25 - 15 = -35
    expect(bottom.level).toBe('low');
  });

  it('explains every adjustment as "<signed delta> <text>"', () => {
    const o = order(130, { isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 }, ['notes-flag']);
    const r = scoreConfidence(base({ order: o, eligible: [o], references: { pricedb: null, community: null }, inputObservedAt: T0 - HOUR }));
    expect(r.reasons).toEqual([
      '+20 Buyer is a bot that was active in the last 30 min',
      '+5 Buyer is online',
      '+10 Order confirmed by the live feed or a snapshot in the last 2 h',
      '-10 No PriceDB or community price to compare with',
      "-10 Buyer's note mentions paint, spells, parts, dupes or 'only'",
      '-10 scrap.tf price is between 15 min and 2 h old',
    ]);
    for (const reason of r.reasons) expect(reason).toMatch(/^[+-]?\d+ \S/);
    expect(r.score).toBe(55);
  });

  it('still scores the input when there is no order', () => {
    const r = scoreConfidence(base({ order: null, eligible: [], revenueScrap: null, inputObservedAt: T0 - 5 * HOUR }));
    expect(r.score).toBe(25);
    expect(r.reasons[0]).toBe('No usable buy order');
  });
});

describe('scoreConfidence: stale references (F4) and suspect margins (F5)', () => {
  const DAY = 24 * HOUR;
  const pdb = (buyScrap: number, ageMs: number | null): ReferencePrices => ({ pricedb: { buyScrap, sellScrap: null, time: null, ageMs }, community: null });

  it('ignores a PriceDB price older than referenceMaxAgeMs, with the flag and the reason', () => {
    // 130 vs 110 would agree (+10); 400 days old it is ignored instead.
    expect(delta({ references: pdb(110, 29 * DAY) })).toBe(10);
    const r = scoreConfidence(base({ references: pdb(110, 400 * DAY) }));
    expect(r.score).toBe(40);
    expect(r.flags).toEqual(['stale-reference', 'no-reference']);
    expect(r.reasons).toContain('PriceDB price is 400 days old, ignored');
    expect(r.reasons).toContain('-10 No recent PriceDB or community price to compare with');
    // A far-off old price no longer costs 20 either.
    expect(delta({ references: pdb(50, 400 * DAY) })).toBe(-10);
    expect(delta({ references: pdb(50, 400 * DAY), profit: { ...P, referenceMaxAgeMs: 500 * DAY } })).toBe(-20);
  });

  it('gates the community price on lastUpdate and keeps a fresh one', () => {
    const comm = (ageDays: number): ReferencePrices => ({
      pricedb: null,
      community: { valueScrap: 125, valueHighScrap: null, lastUpdate: Math.floor((T0 - ageDays * DAY) / 1000) },
    });
    expect(delta({ references: comm(2) })).toBe(10);
    // Community prices get at least a year (COMMUNITY_MIN_MAX_AGE_MS), not the 30-day PriceDB limit.
    expect(delta({ references: comm(200) })).toBe(10);
    const r = scoreConfidence(base({ references: comm(400) }));
    expect(r.score).toBe(40);
    expect(r.reasons).toContain('Community price is 400 days old, ignored');
    expect(r.flags).toContain('stale-reference');
  });

  it('keeps one usable reference when the other is stale', () => {
    const refs: ReferencePrices = {
      pricedb: { buyScrap: 50, sellScrap: null, time: null, ageMs: 90 * DAY },
      community: { valueScrap: 125, valueHighScrap: null, lastUpdate: Math.floor(T0 / 1000) },
    };
    const r = scoreConfidence(base({ references: refs }));
    expect(r.score).toBe(60);
    expect(r.flags).toEqual(['stale-reference']);
  });

  it('reports a stale reference even without an order', () => {
    const r = scoreConfidence(base({ order: null, eligible: [], revenueScrap: null, references: pdb(100, 400 * DAY) }));
    expect(r.flags).toContain('stale-reference');
    expect(r.reasons.slice(0, 2)).toEqual(['No usable buy order', 'PriceDB price is 400 days old, ignored']);
  });

  it('caps a suspect margin at Low (44) and explains it last', () => {
    const o = order(450, { isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 });
    const input = base({ order: o, eligible: [o], references: { pricedb: null, community: null }, revenueScrap: 450, margin: 29 });
    const r = scoreConfidence(input);
    expect(r.score).toBe(44);
    expect(r.level).toBe('low');
    expect(r.flags).toContain('suspect-margin');
    expect(r.reasons.at(-1)).toBe('Margin over 200% with no reference and few buyers. Check the variant and units');
    // An already low score stays where it is, still flagged.
    const low = scoreConfidence({ ...input, inputObservedAt: T0 - 10 * HOUR, isUnusual: true, revenueScrap: 20 * K });
    expect(low.flags).toContain('suspect-margin');
    expect(low.score).toBeLessThan(44);
    // The setting names the threshold in the reason.
    expect(scoreConfidence({ ...input, profit: { ...P, suspectMargin: 5.5 } }).reasons.at(-1)).toMatch(/^Margin over 550% /);
  });

  it('skips the guard when the margin is omitted, at or under the setting, or the guard is off', () => {
    const noRefs = { references: { pricedb: null, community: null } };
    const flagged = (over: Partial<ConfidenceInput>) => scoreConfidence(base({ ...noRefs, ...over })).flags.includes('suspect-margin');
    expect(flagged({})).toBe(false);
    expect(flagged({ margin: null })).toBe(false);
    expect(flagged({ margin: 2 })).toBe(false);
    expect(flagged({ margin: 2.01 })).toBe(true);
    expect(flagged({ margin: Number.POSITIVE_INFINITY })).toBe(true);
    expect(flagged({ margin: 30, profit: { ...P, suspectMargin: 0 } })).toBe(false);
    // A broken setting falls back to 200%.
    expect(flagged({ margin: 3, profit: { ...P, suspectMargin: Number.NaN } })).toBe(true);
    expect(flagged({ margin: 3, eligible: [order(130), order(129), order(128)] })).toBe(false);
    expect(flagged({ margin: 3, references: { pricedb: { buyScrap: null, sellScrap: 200, time: null, ageMs: null }, community: null } })).toBe(false);
    expect(flagged({ margin: 3, references: pdb(100, 400 * DAY) })).toBe(true);
  });
});
