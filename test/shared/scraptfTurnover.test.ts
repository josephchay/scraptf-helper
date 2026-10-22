// 0.8 (LC-4): how long items stayed listed in a bank (scraptfTurnoverOf in src/shared/scraptfTiming.ts): Kaplan-Meier
// over listings (flap chains joined), left out only on the start side, censored at the last sighting before a gap
// over 24 h whatever came after, 'not enough data' below 15 ended listings with the counts still filled, and a curve
// of at most 50 points. Pure; no network, no scrap.tf.

import { describe, expect, it } from 'vitest';
import { scraptfLifecycleOf, type ScraptfBankLifecycle, type ScraptfCopyLifecycle, type ScraptfSaveRows } from '../../src/shared/scraptfHistory';
import { SCRAPTF_TIMING_MAX_BRACKET_MS, SCRAPTF_TIMING_MIN_ENDED, SCRAPTF_TURNOVER_CURVE_MAX, scraptfBankCyclesOf, scraptfBankTurnover, scraptfTurnoverOf } from '../../src/shared/scraptfTiming';
import type { BankStockStored, ScraptfListingRun } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A listing that started at T0 (an hour after its page's look before) and ended `endH` hours later, or still listed at `openH`. */
function listing(a: { endH?: number; openH?: number }, o: Partial<ScraptfListingRun> = {}): ScraptfListingRun {
  const ended = a.endH !== undefined;
  const lastH = ended ? a.endH! - 0.5 : a.openH!;
  return {
    firstOnSaleAt: T0,
    startAfter: T0 - HOUR,
    lastOnSaleAt: T0 + lastH * HOUR,
    endedAt: ended ? T0 + a.endH! * HOUR : null,
    endedAs: ended ? 'absent' : null,
    startRaw: { keys: 0, scrap: 100 },
    endRaw: { keys: 0, scrap: 100 },
    drops: 0,
    saves: 2,
    sameAssetAsBefore: null,
    ...o,
  };
}

/** A lifecycle holding these copies' runs (one copy per entry). */
function lifeOf(copies: ScraptfListingRun[][]): ScraptfBankLifecycle {
  const map = new Map<string, ScraptfCopyLifecycle>();
  copies.forEach((runs, i) => map.set(`c${i}`, { key: `c${i}`, sku: '1;6', specialKey: '', home: '/buy/hats', runs, states: [], returns: 0, lastObsAt: T0, lastListedAt: T0, onSale: false }));
  return { keyStates: new Map(), copies: map, pageSaves: new Map(), assetStability: { pairs: 0, same: 0, share: null, stable: false }, newestSaveAt: null };
}

const times = (n: number, a: { endH?: number; openH?: number }, o: Partial<ScraptfListingRun> = {}): ScraptfListingRun[][] => Array.from({ length: n }, () => [listing(a, o)]);

describe('scraptfTurnoverOf (LC-4: Kaplan-Meier over listings)', () => {
  it('gives the hand example: ended 1, 3, 3 and censored 2, 4 (each five times), p25 = median = 3 h, p75 none', () => {
    const t = scraptfTurnoverOf(lifeOf([...times(5, { endH: 1 }, { drops: 1 }), ...times(10, { endH: 3 }), ...times(5, { openH: 2 }), ...times(5, { openH: 4 })]), 'hats');
    expect(t).toMatchObject({ bank: 'hats', ended: 15, open: 10, wideGap: 0, imprecise: 0, p25Ms: 3 * HOUR, medianMs: 3 * HOUR, p75Ms: null, resolutionMs: HOUR, since: T0 });
    expect(t.reason).toBeUndefined();
    expect(t.curve.map((p) => p.atMs)).toEqual([0, HOUR, 3 * HOUR]);
    expect(t.curve[0]!.stillListed).toBe(1);
    expect(t.curve[1]!.stillListed).toBeCloseTo(0.8, 12);
    expect(t.curve[2]!.stillListed).toBeCloseTo(0.8 / 3, 12);
    // The listings that dropped before they went: the five 1 h ones of 15 ended.
    expect(t.droppedBeforeGoneShare).toBeCloseTo(1 / 3, 12);
  });

  it('leaves listings out on the start side only: before the first save of their page, a start bracket over 24 h, a family run', () => {
    const base = [...times(15, { endH: 2 })];
    const t = scraptfTurnoverOf(
      lifeOf([
        ...base,
        [listing({ endH: 1 }, { startAfter: null })],
        [listing({ endH: 1 }, { startAfter: T0 - SCRAPTF_TIMING_MAX_BRACKET_MS - MIN })],
        [listing({ endH: 1 }, { family: true })],
        [listing({ endH: 1 }, { startAfter: T0 - SCRAPTF_TIMING_MAX_BRACKET_MS })],
      ]),
      'hats',
    );
    expect(t).toMatchObject({ imprecise: 3, ended: 16, open: 0 });
  });

  it('a listing that ended after a 30 h gap is censored at its last sighting before it (wideGap), not left out', () => {
    const row = (price: number): BankStockStored => ({ sku: '1;6', specialKey: '', name: 'Item', costKeys: 0, costScrap: price, stock: 1, assetId: null });
    const filler: BankStockStored = { ...row(5), sku: '9;6' };
    let batch = 1;
    const save = (at: number, rows: BankStockStored[]): ScraptfSaveRows => ({ batchId: batch++, savedAt: at, page: '/buy/hats', rows });
    const life = scraptfLifecycleOf([save(T0 - HOUR, [filler]), save(T0, [filler, row(100)]), save(T0 + HOUR, [filler, row(100)]), save(T0 + 31 * HOUR, [filler])]);
    const t = scraptfTurnoverOf(life, 'hats');
    expect(t).toMatchObject({ wideGap: 1, ended: 0, imprecise: 1, reason: 'not-enough-data' });
    // With enough ended listings, the cut one is at risk up to 1 h only.
    const cut = life.copies.get('1;6|')!.runs[0]!;
    expect(cut).toMatchObject({ cutAt: T0 + HOUR, endedAt: T0 + 31 * HOUR });
    const full = scraptfTurnoverOf(lifeOf([...times(15, { endH: 2 }), [cut]]), 'hats');
    expect(full).toMatchObject({ wideGap: 1, ended: 15, open: 0 });
    expect(full.curve[1]).toEqual({ atMs: 2 * HOUR, stillListed: 0 });
  });

  it("says 'not enough data' below 15 ended listings, with the figures null and the counts filled", () => {
    expect(SCRAPTF_TIMING_MIN_ENDED).toBe(15);
    const t = scraptfTurnoverOf(lifeOf([...times(14, { endH: 2 }), ...times(3, { openH: 5 })]), 'stranges');
    expect(t).toEqual({
      bank: 'stranges',
      ended: 14,
      open: 3,
      wideGap: 0,
      imprecise: 0,
      since: T0,
      p25Ms: null,
      medianMs: null,
      p75Ms: null,
      resolutionMs: null,
      curve: [{ atMs: 0, stillListed: 1 }],
      droppedBeforeGoneShare: null,
      reason: 'not-enough-data',
    });
  });

  it('keeps a curve of at most 50 non-increasing points, its first and last always', () => {
    const t = scraptfTurnoverOf(lifeOf(Array.from({ length: 200 }, (_, i) => [listing({ endH: i + 1 })])), 'hats');
    expect(t.curve.length).toBe(SCRAPTF_TURNOVER_CURVE_MAX);
    expect(t.curve[0]).toEqual({ atMs: 0, stillListed: 1 });
    expect(t.curve[t.curve.length - 1]!.atMs).toBe(200 * HOUR);
    expect(t.curve[t.curve.length - 1]!.stillListed).toBeCloseTo(0, 12);
    for (let i = 1; i < t.curve.length; i++) {
      expect(t.curve[i]!.atMs).toBeGreaterThan(t.curve[i - 1]!.atMs);
      expect(t.curve[i]!.stillListed).toBeLessThanOrEqual(t.curve[i - 1]!.stillListed);
    }
    // Half gone at 100 h (the product's float rounding may carry it one step on).
    expect(t.medianMs).toBeGreaterThanOrEqual(100 * HOUR);
    expect(t.medianMs).toBeLessThanOrEqual(101 * HOUR);
  });

  it('joins a flap chain into one listing (first start to last end, its drops counted, its first cutAt used)', () => {
    const chain: ScraptfListingRun[] = [
      listing({ endH: 1 }, { flap: true }),
      listing({ endH: 6 }, { firstOnSaleAt: T0 + 1.5 * HOUR, startAfter: T0 + HOUR, drops: 1 }),
    ];
    const t = scraptfTurnoverOf(lifeOf([...times(14, { endH: 2 }), chain]), 'hats');
    expect(t).toMatchObject({ ended: 15, imprecise: 0 });
    expect(t.curve.map((p) => p.atMs)).toEqual([0, 2 * HOUR, 6 * HOUR]);
    expect(t.droppedBeforeGoneShare).toBeCloseTo(1 / 15, 12);
    const cutChain: ScraptfListingRun[] = [chain[0]!, { ...chain[1]!, cutAt: T0 + 3 * HOUR }];
    const c = scraptfTurnoverOf(lifeOf([...times(15, { endH: 2 }), cutChain]), 'hats');
    expect(c).toMatchObject({ ended: 15, wideGap: 1 });
  });

  it('is memoised on the bank cycles', () => {
    const c = scraptfBankCyclesOf('hats', [], 600);
    const t = scraptfBankTurnover(c);
    expect(c.turnover).toBe(t);
    expect(scraptfBankTurnover(c)).toBe(t);
  });
});
