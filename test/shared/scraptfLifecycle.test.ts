// 0.8 (T1, LC-3, LC-5): the per-bank lifecycle (scraptfLifecycleOf in src/shared/scraptfHistory.ts), one walk over
// a bank's retained saves giving each copy's price states and listing runs and the bank's asset-id stability. Every
// state ending is an outcome; flaps are decided in time, never in saves, so the read density changes nothing; a gap
// over its page's gap limit (at most 24 h) censors at the last sighting before it (cutAt), and what begins after one
// is left out (wideStart); ACT-10's key states come out exactly as in 0.7.4. Pure;
// nothing here touches the network or scrap.tf.

import { describe, expect, it } from 'vitest';
import { bankStockKey, bankStockOnSale, bankStockThinning } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  SCRAPTF_ASSET_STABLE_MIN_PAIRS,
  SCRAPTF_FLAP_MAX_MS,
  SCRAPTF_TIMING_GAP_SLACK,
  SCRAPTF_TIMING_MAX_BRACKET_MS,
  SCRAPTF_TIMING_MIN_GAP_MS,
  scraptfAssetStabilityOf,
  scraptfGapLimitMs,
  scraptfCopyBankOf,
  scraptfItemHistoryOf,
  scraptfKeyStatesOf,
  scraptfLifecycleOf,
  scraptfRunsOf,
  type ScraptfKeyState,
  type ScraptfPriceState,
  type ScraptfSaveRows,
} from '../../src/shared/scraptfHistory';
import { scraptfBankCyclesOf, scraptfTimingForKey } from '../../src/shared/scraptfTiming';
import type { BankStockStored, KeyPriceState, ScraptfBank, UnixMs } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const K = 600;
const PAGE = '/buy/hats';
const KEY = bankStockKey('1;6', '');

function row(sku: string, price: number | null, stock: number | null = 1, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: price === null ? null : 0, costScrap: price, stock, assetId: null, ...over };
}

/** A single card with an asset id. */
function card(sku: string, price: number, assetId: string, over: Partial<BankStockStored> = {}): BankStockStored {
  return row(sku, price, 1, { assetId, ...over });
}

let batch = 1;
function save(at: number, rows: BankStockStored[], page = PAGE): ScraptfSaveRows {
  return { batchId: batch++, savedAt: at, page, rows };
}

/** 60 single cards that keep their ids: each later look on the page adds 60 cross-look pairs, all the same. */
const STEADY = Array.from({ length: 60 }, (_, i) => card(`${100 + i};6`, 50, `steady-${i}`));
/** The same 60 cards with new ids on every save: pairs that never keep their id. */
const shuffled = (n: number): BankStockStored[] => Array.from({ length: 60 }, (_, i) => card(`${100 + i};6`, 50, `shuffle-${n}-${i}`));

/** Hourly saves of PAGE from T0 + h hours, each listing `other` plus the copy's row of that hour (null: absent). */
function hourly(copy: (BankStockStored | null)[], other: (i: number) => BankStockStored[] = () => []): ScraptfSaveRows[] {
  return copy.map((r, h) => save(T0 + h * HOUR, [...other(h), ...(r ? [r] : [])]));
}

const lifeOf = (saves: readonly ScraptfSaveRows[], opts: Parameters<typeof scraptfLifecycleOf>[1] = {}) => scraptfLifecycleOf(saves, { keyScrap: K, ...opts });
const copyOf = (saves: readonly ScraptfSaveRows[], key = KEY, opts: Parameters<typeof scraptfLifecycleOf>[1] = {}) => lifeOf(saves, opts).copies.get(key)!;

describe('price states: every ending is an outcome', () => {
  it('reads reprice-down, arrival, sold-cheapest, reprice-up and gone by price direction and stock', () => {
    const saves = hourly([null, row('1;6', 100, 1), row('1;6', 90, 1), row('1;6', 80, 2), row('1;6', 85, 1), row('1;6', 95, 1), null], () => [row('9;6', 5)]);
    const c = copyOf(saves);
    expect(c.states.map((s) => s.outcome)).toEqual(['reprice-down', 'arrival', 'sold-cheapest', 'reprice-up', 'gone']);
    expect(c.states.map((s) => [s.startAt, s.startPrevAt, s.lastAt, s.endAt])).toEqual([
      [T0 + HOUR, T0, T0 + HOUR, T0 + 2 * HOUR],
      [T0 + 2 * HOUR, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR],
      [T0 + 3 * HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR, T0 + 4 * HOUR],
      [T0 + 4 * HOUR, T0 + 3 * HOUR, T0 + 4 * HOUR, T0 + 5 * HOUR],
      [T0 + 5 * HOUR, T0 + 4 * HOUR, T0 + 5 * HOUR, T0 + 6 * HOUR],
    ]);
    expect(c.states.map((s) => s.nextRaw?.scrap ?? null)).toEqual([90, 80, 85, 95, null]);
    expect(c.states.map((s) => s.run)).toEqual([0, 0, 0, 0, 0]);
    expect(c.states.every((s) => s.sameItem === null && s.cutAt === null && s.flaps === 0)).toBe(true);
    // One run; it counts reprice-downs only (the estimators' drop event also takes the arrival).
    expect(c.runs).toEqual([
      {
        firstOnSaleAt: T0 + HOUR,
        startAfter: T0,
        lastOnSaleAt: T0 + 5 * HOUR,
        endedAt: T0 + 6 * HOUR,
        endedAs: 'absent',
        startRaw: { keys: 0, scrap: 100 },
        endRaw: { keys: 0, scrap: 95 },
        drops: 1,
        saves: 5,
        sameAssetAsBefore: null,
      },
    ]);
    expect(c).toMatchObject({ home: PAGE, returns: 0, lastObsAt: T0 + 6 * HOUR, lastListedAt: T0 + 5 * HOUR, onSale: false });
  });

  it('an unknown stock counts as unchanged, and the direction is by value at the key price', () => {
    const saves = hourly([null, row('1;6', 90, null), row('1;6', 80, 2), row('1;6', 0, 2, { costKeys: 1 }), row('1;6', 590, 2)]);
    // 90 (unknown stock) -> 80 with 2: a reprice-down, not an arrival; 80 -> 1 key (600): up; 1 key -> 590: down.
    expect(copyOf(saves).states.map((s) => s.outcome)).toEqual(['reprice-down', 'reprice-up', 'reprice-down', 'open']);
  });

  it('a sold-out row ends the run as sold out; a stock move at the same price keeps the state', () => {
    const saves = hourly([null, row('1;6', 100, 2), row('1;6', 100, 3), row('1;6', 100, 0)]);
    const c = copyOf(saves);
    expect(c.states).toHaveLength(1);
    expect(c.states[0]).toMatchObject({ outcome: 'gone', stock: 2, lastAt: T0 + 2 * HOUR, endAt: T0 + 3 * HOUR });
    expect(c.runs[0]).toMatchObject({ endedAs: 'sold-out', saves: 2 });
    expect(c).toMatchObject({ onSale: false, lastListedAt: T0 + 3 * HOUR });
  });

  it('with stable ids, two single cards with other ids make a reprice an arrival or a sale; the same id proves the reprice', () => {
    const copy = [null, card('1;6', 100, 'a'), card('1;6', 90, 'a'), card('1;6', 80, 'b'), card('1;6', 85, 'c'), card('1;6', 95, 'c')];
    const stable = copyOf(hourly(copy, () => STEADY));
    expect(stable.states.map((s) => [s.outcome, s.sameItem])).toEqual([
      ['reprice-down', true],
      ['arrival', false],
      ['sold-cheapest', false],
      ['reprice-up', true],
      ['open', null],
    ]);
    // Unstable ids: nothing read from them.
    const unstable = copyOf(hourly(copy, (h) => shuffled(h)));
    expect(unstable.states.map((s) => [s.outcome, s.sameItem])).toEqual([
      ['reprice-down', null],
      ['reprice-down', null],
      ['reprice-up', null],
      ['reprice-up', null],
      ['open', null],
    ]);
  });

  it('a left-censored state and run: on sale at the first retained save of its page', () => {
    const c = copyOf([save(T0, [row('1;6', 100)]), save(T0 + HOUR, [row('1;6', 90)])]);
    expect(c.runs[0]).toMatchObject({ startAfter: null, firstOnSaleAt: T0 });
    expect(c.states.map((s) => [s.startPrevAt, s.outcome])).toEqual([
      [null, 'reprice-down'],
      [T0, 'open'],
    ]);
    // Listed first on the page's second save: its start follows that page's first save.
    const late = copyOf([save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('9;6', 5), row('1;6', 100)])]);
    expect(late.runs[0]!.startAfter).toBe(T0);
    expect(late.states[0]!.startPrevAt).toBe(T0);
  });

  it('marks /items list family states and runs (bankStockListFamily), not a proven copy', () => {
    const saves = [save(T0, [row('9;6', 5)], '/items'), save(T0 + HOUR, [row('1;6', 100), row('2;6', 100, 1, { craft: 'craftable' })], '/items')];
    const life = lifeOf(saves, { bank: 'list' });
    expect(life.copies.get(KEY)!.states[0]!.family).toBe(true);
    expect(life.copies.get(KEY)!.runs[0]!.family).toBe(true);
    expect(life.copies.get(bankStockKey('2;6', ''))!.states[0]!.family).toBeUndefined();
    expect(life.copies.get(bankStockKey('2;6', ''))!.runs[0]!.family).toBeUndefined();
    // A bank page's card never is.
    expect(lifeOf(saves, { bank: 'hats' }).copies.get(KEY)!.states[0]!.family).toBeUndefined();
  });
});

describe('flaps (in time, not in saves)', () => {
  const flapped = (c: ReturnType<typeof copyOf>, back: UnixMs): void => {
    expect(c.runs).toHaveLength(2);
    expect(c.runs[0]!.flap).toBe(true);
    expect(c.runs[1]).toMatchObject({ firstOnSaleAt: back, endedAt: null });
    expect(c.states).toHaveLength(1);
    expect(c.states[0]).toMatchObject({ outcome: 'open', endAt: null, flaps: 1, run: 0, lastAt: back });
    // A flap is not a return.
    expect(c.returns).toBe(0);
  };

  it('merges one off save within the hour', () => {
    const c = copyOf([save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('1;6', 100)]), save(T0 + HOUR + 20 * MIN, []), save(T0 + HOUR + 40 * MIN, [row('1;6', 100)])]);
    flapped(c, T0 + HOUR + 40 * MIN);
  });

  it('merges ten 30 s off reads within 5 minutes', () => {
    const saves = [save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('1;6', 100)])];
    for (let i = 1; i <= 10; i++) saves.push(save(T0 + HOUR + i * 30 * SEC, [row('9;6', 5)]));
    saves.push(save(T0 + HOUR + 5.5 * MIN, [row('1;6', 100)]));
    flapped(copyOf(saves), T0 + HOUR + 5.5 * MIN);
  });

  it('keeps a real gone: back after more than 60 min, at another price, with less stock, after a sold-out end, or another card (ids stable)', () => {
    const start = (first: BankStockStored): ScraptfSaveRows[] => [save(T0, [...STEADY]), save(T0 + HOUR, [...STEADY, first])];
    const cases: [string, ScraptfSaveRows[]][] = [
      ['late', [...start(row('1;6', 100)), save(T0 + 2 * HOUR, [...STEADY]), save(T0 + HOUR + SCRAPTF_FLAP_MAX_MS + MIN, [...STEADY, row('1;6', 100)])]],
      ['price', [...start(row('1;6', 100)), save(T0 + HOUR + 20 * MIN, [...STEADY]), save(T0 + HOUR + 40 * MIN, [...STEADY, row('1;6', 99)])]],
      ['stock', [...start(row('1;6', 100, 2)), save(T0 + HOUR + 20 * MIN, [...STEADY]), save(T0 + HOUR + 40 * MIN, [...STEADY, row('1;6', 100, 1)])]],
      ['sold out', [...start(row('1;6', 100)), save(T0 + HOUR + 20 * MIN, [...STEADY, row('1;6', 100, 0)]), save(T0 + HOUR + 40 * MIN, [...STEADY, row('1;6', 100)])]],
      ['asset', [...start(card('1;6', 100, 'a')), save(T0 + HOUR + 20 * MIN, [...STEADY]), save(T0 + HOUR + 40 * MIN, [...STEADY, card('1;6', 100, 'b')])]],
    ];
    for (const [name, saves] of cases) {
      const life = lifeOf(saves);
      expect(life.assetStability.stable, name).toBe(true);
      const c = life.copies.get(KEY)!;
      expect(c.runs.map((r) => r.flap === true), name).toEqual([false, false]);
      expect(c.states.map((s) => s.outcome), name).toEqual(['gone', 'open']);
      expect(c.returns, name).toBe(1);
    }
    // More stock, or an unknown stock, is not lower: still a flap; so are equal ids.
    const more = lifeOf([...start(row('1;6', 100, 1)), save(T0 + HOUR + 20 * MIN, [...STEADY]), save(T0 + HOUR + 40 * MIN, [...STEADY, row('1;6', 100, null)])]);
    expect(more.copies.get(KEY)!.runs[0]!.flap).toBe(true);
    const sameCard = lifeOf([...start(card('1;6', 100, 'a')), save(T0 + HOUR + 20 * MIN, [...STEADY]), save(T0 + HOUR + 40 * MIN, [...STEADY, card('1;6', 100, 'a')])]);
    expect(sameCard.copies.get(KEY)!.runs[0]!.flap).toBe(true);
    // With unstable ids another id says nothing: a flap.
    const unstable = lifeOf([save(T0, shuffled(0)), save(T0 + HOUR, [...shuffled(1), card('1;6', 100, 'a')]), save(T0 + HOUR + 20 * MIN, shuffled(2)), save(T0 + HOUR + 40 * MIN, [...shuffled(3), card('1;6', 100, 'b')])]);
    expect(unstable.assetStability.stable).toBe(false);
    expect(unstable.copies.get(KEY)!.runs[0]!.flap).toBe(true);
  });

  it('flapMaxMs 0 turns flaps off', () => {
    const saves = [save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('1;6', 100)]), save(T0 + HOUR + 20 * MIN, []), save(T0 + HOUR + 40 * MIN, [row('1;6', 100)])];
    const c = copyOf(saves, KEY, { flapMaxMs: 0 });
    expect(c.runs.map((r) => r.flap === true)).toEqual([false, false]);
    expect(c.states.map((s) => s.outcome)).toEqual(['gone', 'open']);
  });
});

describe('density invariance', () => {
  // Hourly saves, the copy at 100 from 1 h, at 90 from 8 h, on sale at 10 h. The dense history adds a window session
  // at 5 h: 30 s reads for 10 minutes, the copy missing for 5 of them.
  const hourlyRows = (h: number): BankStockStored[] => [row('9;6', 5), ...(h >= 1 ? [row('1;6', h >= 8 ? 90 : 100)] : [])];
  const thin = (): ScraptfSaveRows[] => Array.from({ length: 11 }, (_, h) => save(T0 + h * HOUR, hourlyRows(h)));
  const dense = (): ScraptfSaveRows[] => {
    const out = thin();
    for (let i = 1; i <= 20; i++) out.push(save(T0 + 5 * HOUR + i * 30 * SEC, i <= 10 ? [row('9;6', 5)] : hourlyRows(5)));
    return out;
  };
  const chains = (c: ReturnType<typeof copyOf>) => {
    const out: [UnixMs, UnixMs | null, UnixMs, UnixMs | null][] = [];
    for (let i = 0; i < c.runs.length; ) {
      let j = i;
      while (j < c.runs.length - 1 && c.runs[j]!.flap) j++;
      out.push([c.runs[i]!.firstOnSaleAt, c.runs[i]!.startAfter, c.runs[j]!.lastOnSaleAt, c.runs[j]!.endedAt]);
      i = j + 1;
    }
    return out;
  };
  const noFlaps = (states: readonly ScraptfPriceState[]) => states.map(({ flaps: _flaps, run: _run, ...s }) => s);

  it('a 5-minute absence seen by ten 30 s reads reads as the same history thinned to hourly', () => {
    const d = copyOf(dense());
    const t = copyOf(thin());
    expect(d.runs).toHaveLength(2);
    expect(t.runs).toHaveLength(1);
    expect(noFlaps(d.states)).toEqual(noFlaps(t.states));
    expect(d.states[0]!.flaps).toBe(1);
    expect(chains(d)).toEqual(chains(t));
    expect(d.returns).toBe(t.returns);
    const timing = (saves: ScraptfSaveRows[]) =>
      scraptfTimingForKey({ cycles: scraptfBankCyclesOf('hats', saves, K), key: KEY, buy: { revenueScrap: 120, maxCostScrap: 111 }, profit: DEFAULT_SETTINGS.profit, keyScrap: K, now: T0 + 10 * HOUR + MIN });
    const td = timing(dense())!;
    const tt = timing(thin())!;
    expect([td.verdict, td.why]).toEqual([tt.verdict, tt.why]);
  });

  it('bankStockThinning on a dense series gives down-steps that merge the dense ones, never new ones', () => {
    // Every 5 minutes for 3 days; the copy drops by 1 scrap every 7 h 5 min.
    const now = T0 + 3 * DAY;
    const series: ScraptfSaveRows[] = [];
    for (let at = T0; at <= now; at += 5 * MIN) series.push(save(at, [row('9;6', 5), row('1;6', 500 - Math.floor((at - T0) / (7 * HOUR + 5 * MIN)))]));
    const drop = bankStockThinning(series.map((s) => ({ batchId: s.batchId, savedAt: s.savedAt, bank: 'hats' as const, page: s.page })), now);
    const kept = series.filter((s) => !drop.has(s.batchId));
    expect(kept.length).toBeLessThan(series.length);
    const downs = (saves: ScraptfSaveRows[]) => copyOf(saves).states.filter((s) => s.outcome === 'reprice-down');
    const dense = downs(series);
    const thinned = downs(kept);
    expect(thinned.length).toBeGreaterThan(0);
    expect(thinned.length).toBeLessThanOrEqual(dense.length);
    for (const s of thinned) {
      // Each thinned step spans one or more dense steps, from the price before to the price after.
      const inside = dense.filter((x) => x.endAt! > s.lastAt && x.endAt! <= s.endAt!);
      expect(inside.length).toBeGreaterThan(0);
      expect(inside[0]!.raw).toEqual(s.raw);
      expect(inside[inside.length - 1]!.nextRaw).toEqual(s.nextRaw);
    }
  });
});

describe('scraptfAssetStabilityOf (LC-5 pre-pass): pairs across looks only', () => {
  it('500 dense pairs 30 s apart count for nothing; 10 cross-look pairs with new ids are not stable', () => {
    const ids = (tag: string) => Array.from({ length: 10 }, (_, i) => card(`${i + 1};6`, 50, `${tag}-${i}`));
    const saves: ScraptfSaveRows[] = [];
    for (let r = 0; r <= 50; r++) saves.push(save(T0 + r * 30 * SEC, ids('a')));
    saves.push(save(T0 + 50 * 30 * SEC + HOUR, ids('b')));
    expect(scraptfAssetStabilityOf(saves)).toEqual({ pairs: 10, same: 0, share: 0, stable: false });
  });

  it('60 cross-look pairs with 58 the same are stable', () => {
    const second = STEADY.map((r, i) => (i < 2 ? { ...r, assetId: `moved-${i}` } : r));
    const s = scraptfAssetStabilityOf([save(T0, STEADY), save(T0 + HOUR, second)]);
    expect(s).toMatchObject({ pairs: 60, same: 58, stable: true });
    expect(s.share).toBeCloseTo(58 / 60, 10);
    expect(SCRAPTF_ASSET_STABLE_MIN_PAIRS).toBe(50);
  });

  it('a page move, an off-sale save between, a stack or a missing id give no pair', () => {
    expect(scraptfAssetStabilityOf([save(T0, [card('1;6', 5, 'a')], '/items/2'), save(T0 + HOUR, [card('1;6', 5, 'a')], '/items/3')]).pairs).toBe(0);
    expect(scraptfAssetStabilityOf([save(T0, [card('1;6', 5, 'a')]), save(T0 + HOUR, [card('1;6', 5, 'a', { stock: 0 })]), save(T0 + 2 * HOUR, [card('1;6', 5, 'a')])]).pairs).toBe(0);
    expect(scraptfAssetStabilityOf([save(T0, [card('1;6', 5, 'a')]), save(T0 + HOUR, [row('2;6', 5)]), save(T0 + 2 * HOUR, [card('1;6', 5, 'a')])]).pairs).toBe(0);
    expect(scraptfAssetStabilityOf([save(T0, [row('1;6', 5, 2, { assetId: 'a' })]), save(T0 + HOUR, [row('1;6', 5, 2, { assetId: 'a' })])]).pairs).toBe(0);
    expect(scraptfAssetStabilityOf([save(T0, [card('1;6', 5, '')]), save(T0 + HOUR, [card('1;6', 5, 'a')])]).pairs).toBe(0);
    // Exactly 30 minutes apart is a pair; 29 is not.
    expect(scraptfAssetStabilityOf([save(T0, [card('1;6', 5, 'a')]), save(T0 + 30 * MIN, [card('1;6', 5, 'a')])]).pairs).toBe(1);
    expect(scraptfAssetStabilityOf([save(T0, [card('1;6', 5, 'a')]), save(T0 + 29 * MIN, [card('1;6', 5, 'a')])]).pairs).toBe(0);
    expect(scraptfAssetStabilityOf([])).toEqual({ pairs: 0, same: 0, share: null, stable: false });
  });
});

describe("cutAt: a gap over the page's limit (at most 24 h) censors at the last sighting before it", () => {
  const GAP = SCRAPTF_TIMING_MAX_BRACKET_MS;
  it('for a state that ended after the gap and for one still at its price after it, and for its run', () => {
    const ended = copyOf([save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('1;6', 100)]), save(T0 + 2 * HOUR, [row('1;6', 100)]), save(T0 + 2 * HOUR + 30 * HOUR, [row('1;6', 90)])]);
    expect(ended.states[0]).toMatchObject({ outcome: 'reprice-down', cutAt: T0 + 2 * HOUR, endAt: T0 + 32 * HOUR });
    expect(ended.states[1]!.cutAt).toBeNull();
    expect(ended.runs[0]!.cutAt).toBe(T0 + 2 * HOUR);
    const still = copyOf([save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('1;6', 100)]), save(T0 + 2 * HOUR, [row('1;6', 100)]), save(T0 + 32 * HOUR, [row('1;6', 100)])]);
    expect(still.states).toHaveLength(1);
    expect(still.states[0]).toMatchObject({ outcome: 'open', cutAt: T0 + 2 * HOUR, lastAt: T0 + 32 * HOUR });
    // The first gap only: a later one keeps the first cut.
    const twice = copyOf([save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('1;6', 100)]), save(T0 + HOUR + 2 * GAP, [row('1;6', 100)]), save(T0 + HOUR + 4 * GAP, [row('1;6', 100)])]);
    expect(twice.states[0]!.cutAt).toBe(T0 + HOUR);
    // A gone first shown after the gap is cut too.
    const gone = copyOf([save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('1;6', 100)]), save(T0 + HOUR + GAP + MIN, [row('9;6', 5)])]);
    expect(gone.states[0]).toMatchObject({ outcome: 'gone', cutAt: T0 + HOUR });
    expect(gone.runs[0]).toMatchObject({ endedAs: 'absent', cutAt: T0 + HOUR });
  });

  it('a gap of exactly the limit does not cut (a page looked at once a day: 24 h), nor does a gap while off sale', () => {
    const exact = copyOf([save(T0, [row('9;6', 5)]), save(T0 + DAY, [row('1;6', 100)]), save(T0 + 2 * DAY, [row('1;6', 90)])]);
    expect(scraptfGapLimitMs([T0, T0 + DAY, T0 + 2 * DAY])).toBe(GAP);
    expect(exact.states[0]!.cutAt).toBeNull();
    expect(exact.runs[0]!.cutAt).toBeUndefined();
    // With one limit for every page (opts.maxGapMs), 24 h after an hour's gap does not cut either.
    const fixed = copyOf([save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('1;6', 100)]), save(T0 + HOUR + GAP, [row('1;6', 90)])], KEY, { maxGapMs: GAP });
    expect(fixed.states[0]!.cutAt).toBeNull();
    const off = copyOf([save(T0, [row('9;6', 5)]), save(T0 + HOUR, [row('1;6', 100)]), save(T0 + 2 * HOUR, [row('9;6', 5)]), save(T0 + 2 * HOUR + 2 * GAP, [row('1;6', 100)])]);
    expect(off.states.map((s) => s.cutAt)).toEqual([null, null]);
    expect(off.runs.map((r) => r.cutAt)).toEqual([undefined, undefined]);
    // But what began after that gap is left out on the start side.
    expect(off.states.map((s) => s.wideStart)).toEqual([undefined, true]);
    expect(off.runs.map((r) => r.wideStart)).toEqual([undefined, true]);
  });
});

describe("the gap limit: 1.25 x the page's usual longest gap in a day, 2 h to 24 h (review: retention's daily tier)", () => {
  const GAP = SCRAPTF_TIMING_MAX_BRACKET_MS;
  /** Hourly looks from `wake` to `sleep` (UTC hours) on each of `days` days, newest last. */
  const awake = (days: number, wake = 7, sleep = 22): number[] => {
    const out: number[] = [];
    for (let d = 0; d < days; d++) for (let h = wake; h <= sleep; h++) out.push(T0 + d * DAY + h * HOUR);
    return out;
  };

  it('keeps the nights of an hourly looker, never a day-wide gap; once a day keeps 24 h; 2 h at least', () => {
    // 07:00-22:00 hourly: each day's longest gap is the 9 h night, so 11.25 h.
    expect(SCRAPTF_TIMING_GAP_SLACK).toBe(1.25);
    expect(scraptfGapLimitMs(awake(7))).toBe(1.25 * 9 * HOUR);
    // Round the clock: 1.25 h, lifted to the 2 h floor (retention's hourly tier leaves gaps under 2 h).
    expect(scraptfGapLimitMs(Array.from({ length: 7 * 24 }, (_, i) => T0 + i * HOUR))).toBe(SCRAPTF_TIMING_MIN_GAP_MS);
    // Twice a day: 15 h; once a day: the 24 h ceiling, as are fewer than two looks.
    expect(scraptfGapLimitMs(Array.from({ length: 14 }, (_, i) => T0 + i * 12 * HOUR))).toBe(15 * HOUR);
    expect(scraptfGapLimitMs(Array.from({ length: 7 }, (_, i) => T0 + i * DAY))).toBe(GAP);
    expect(scraptfGapLimitMs([T0, T0 + 10 * MIN])).toBe(GAP);
    expect(scraptfGapLimitMs([])).toBe(GAP);
  });

  it('a median over days: one long absence does not lift it', () => {
    // Six days of hourly looks with 9 h nights, then three days away.
    const times = [...awake(4), ...awake(2).map((t) => t + 7 * DAY)];
    expect(scraptfGapLimitMs(times)).toBe(1.25 * 9 * HOUR);
  });

  it("the walk cuts retention's one save a day for an hourly page, keeps its nights and lifts nothing else", () => {
    // Day-tier saves (one a day, as bankStockThinning keeps past 7 d), then a week of hourly looks with 9 h nights.
    const daily = [T0 - 4 * DAY + 20 * HOUR, T0 - 3 * DAY + 20 * HOUR, T0 - 2 * DAY + 20 * HOUR, T0 - DAY + 20 * HOUR];
    const times = [...daily, ...awake(7)];
    const price = (t: number) => (t < T0 - 2 * DAY ? 100 : t < T0 + 3 * DAY + 12 * HOUR ? 90 : 80);
    const saves = times.map((t) => save(t, [row('9;6', 5), row('1;6', price(t))]));
    const life = lifeOf(saves);
    expect(life.lookGaps!.get(PAGE)).toBe(HOUR);
    const c = life.copies.get(KEY)!;
    // 100 from the first save (left-censored), cut at its first sighting (a 24 h gap follows); 90 shown after a 24 h
    // gap (wideStart), cut before the next one; then the 11 h into the hourly week is a night, kept, and 80 is whole.
    expect(c.states.map((s) => [s.raw.scrap, s.outcome, s.cutAt, s.wideStart ?? false])).toEqual([
      [100, 'reprice-down', daily[0], false],
      [90, 'reprice-down', daily[2], true],
      [80, 'open', null, false],
    ]);
    // The default 24 h limit (the 0.8 build before this review) pooled the day-wide brackets instead.
    const wide = lifeOf(saves, { maxGapMs: GAP }).copies.get(KEY)!;
    expect(wide.states.map((s) => [s.cutAt, s.wideStart ?? false])).toEqual([
      [null, false],
      [null, false],
      [null, false],
    ]);
  });
});

describe('the home-page rule', () => {
  it('a page move (/items/2 to /items/3) is no gone', () => {
    const c = copyOf([save(T0, [row('9;6', 5)], '/items/2'), save(T0 + HOUR, [row('9;6', 5), row('1;6', 100)], '/items/2'), save(T0 + 2 * HOUR, [row('1;6', 100)], '/items/3'), save(T0 + 3 * HOUR, [row('9;6', 5)], '/items/2')]);
    expect(c.home).toBe('/items/3');
    expect(c.runs).toHaveLength(1);
    expect(c.runs[0]).toMatchObject({ endedAt: null, saves: 2, lastOnSaleAt: T0 + 2 * HOUR });
    expect(c.states.map((s) => s.outcome)).toEqual(['open']);
    expect(c).toMatchObject({ onSale: true, lastObsAt: T0 + 2 * HOUR });
    const life = lifeOf([save(T0, [row('1;6', 5)], '/items/2'), save(T0 + HOUR, [row('2;6', 5)], '/items/3')]);
    expect([...life.pageSaves]).toEqual([
      ['/items/2', [T0]],
      ['/items/3', [T0 + HOUR]],
    ]);
    expect(life.newestSaveAt).toBe(T0 + HOUR);
  });
});

describe('runs, returns and asset ids', () => {
  it('counts returns (a known start, not after a flap) and compares the cards (stable ids only)', () => {
    const withGap = (first: BankStockStored, back: BankStockStored, bg: (h: number) => BankStockStored[]) =>
      copyOf([save(T0, bg(0)), save(T0 + HOUR, [...bg(1), first]), save(T0 + 2 * HOUR, bg(2)), save(T0 + 3 * HOUR, bg(3)), save(T0 + 4 * HOUR, [...bg(4), back])]);
    const stable = () => STEADY;
    expect(withGap(card('1;6', 100, 'a'), card('1;6', 100, 'a'), stable).runs.map((r) => r.sameAssetAsBefore)).toEqual([null, true]);
    expect(withGap(card('1;6', 100, 'a'), card('1;6', 100, 'b'), stable).runs.map((r) => r.sameAssetAsBefore)).toEqual([null, false]);
    expect(withGap(card('1;6', 100, 'a'), row('1;6', 100, 2, { assetId: 'a' }), stable).runs.map((r) => r.sameAssetAsBefore)).toEqual([null, null]);
    // The gate: unstable ids show nothing.
    expect(withGap(card('1;6', 100, 'a'), card('1;6', 100, 'a'), shuffled).runs.map((r) => r.sameAssetAsBefore)).toEqual([null, null]);
    expect(withGap(card('1;6', 100, 'a'), card('1;6', 100, 'a'), stable).returns).toBe(1);
    // Left-censored first run, then a flap and a return: one return.
    const c = copyOf([
      save(T0, [row('1;6', 100)]),
      save(T0 + HOUR, [row('9;6', 5)]),
      save(T0 + 3 * HOUR, [row('1;6', 100)]),
      save(T0 + 3 * HOUR + 20 * MIN, [row('9;6', 5)]),
      save(T0 + 3 * HOUR + 40 * MIN, [row('1;6', 100)]),
    ]);
    expect(c.runs.map((r) => [r.startAfter !== null, r.flap === true])).toEqual([
      [false, false],
      [true, true],
      [true, false],
    ]);
    expect(c.returns).toBe(1);
  });

  it('labels a card that turned untradable (stable ids), else a plain gone', () => {
    const run = (bg: (h: number) => BankStockStored[]) =>
      copyOf([save(T0, bg(0)), save(T0 + HOUR, [...bg(1), card('1;6', 100, 'x')]), save(T0 + 2 * HOUR, [...bg(2), card('1;6;untradable', 100, 'x')])]);
    const on = run(() => STEADY);
    expect(on.runs[0]!.endedAs).toBe('untradable');
    expect(on.states[0]!.outcome).toBe('untradable');
    const off = run(shuffled);
    expect(off.runs[0]!.endedAs).toBe('absent');
    expect(off.states[0]!.outcome).toBe('gone');
    // Another card under the untradable SKU is no proof.
    const other = copyOf([save(T0, STEADY), save(T0 + HOUR, [...STEADY, card('1;6', 100, 'x')]), save(T0 + 2 * HOUR, [...STEADY, card('1;6;untradable', 100, 'y')])]);
    expect(other.runs[0]!.endedAs).toBe('absent');
  });
});

/** 0.7.4's scraptfKeyStatesOf, kept here as the reference the lifecycle's keyStates must equal (ACT-10). */
function keyStates074(saves: readonly ScraptfSaveRows[]): Map<string, ScraptfKeyState> {
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const rawOf = (r: BankStockStored) => ({ keys: finite(r.costKeys) ? r.costKeys : 0, scrap: finite(r.costScrap) ? r.costScrap : 0 });
  const changed = (prev: BankStockStored | null, cur: BankStockStored | null, stock: boolean): boolean => {
    const was = bankStockOnSale(prev);
    const is = bankStockOnSale(cur);
    if (was !== is) return true;
    if (!is || !prev || !cur) return false;
    const a = rawOf(prev);
    const b = rawOf(cur);
    if (a.keys !== b.keys || a.scrap !== b.scrap) return true;
    return stock && finite(prev.stock) && finite(cur.stock) && prev.stock !== cur.stock;
  };
  type St = { state: ScraptfKeyState; home: string; last: BankStockStored | null; lastAt: UnixMs };
  const states = new Map<string, St>();
  const homeKeys = new Map<string, Set<string>>();
  const homeOf = (page: string): Set<string> => {
    let s = homeKeys.get(page);
    if (!s) homeKeys.set(page, (s = new Set()));
    return s;
  };
  const see = (st: St, at: UnixMs, r: BankStockStored | null): void => {
    if (changed(st.last, r, true)) {
      st.state.prevAt = st.lastAt;
      st.state.since = at;
    }
    if (changed(st.last, r, false)) {
      st.state.pricePrevAt = st.lastAt;
      st.state.priceSince = at;
    }
    st.state.onSale = bankStockOnSale(r);
    st.last = r;
    st.lastAt = at;
  };
  for (const s of [...saves].sort((a, b) => a.savedAt - b.savedAt || a.batchId - b.batchId)) {
    const listedHere = new Set<string>();
    for (const r of s.rows) {
      const key = bankStockKey(r.sku, r.specialKey);
      if (listedHere.has(key)) continue;
      listedHere.add(key);
      const st = states.get(key);
      if (!st) {
        states.set(key, { state: { onSale: bankStockOnSale(r), since: s.savedAt, prevAt: null, priceSince: s.savedAt, pricePrevAt: null }, home: s.page, last: r, lastAt: s.savedAt });
        homeOf(s.page).add(key);
        continue;
      }
      if (st.home !== s.page) {
        homeKeys.get(st.home)?.delete(key);
        st.home = s.page;
        homeOf(s.page).add(key);
      }
      see(st, s.savedAt, r);
    }
    for (const key of homeKeys.get(s.page) ?? []) if (!listedHere.has(key)) see(states.get(key)!, s.savedAt, null);
  }
  return new Map([...states].map(([k, st]) => [k, st.state]));
}

/** A small deterministic PRNG (mulberry32), so the fuzz is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random saves of a few pages: copies come and go, move pages, reprice, change stock, sell out, are saved twice. */
function fuzzSaves(seed: number, n = 120): ScraptfSaveRows[] {
  const rnd = prng(seed);
  const pages = ['/items/1', '/items/2', '/items/3'];
  const price = new Map<number, number>();
  const out: ScraptfSaveRows[] = [];
  let at = T0;
  for (let i = 0; i < n; i++) {
    at += rnd() < 0.15 ? 0 : Math.floor(rnd() * 3 * HOUR);
    const page = pages[Math.floor(rnd() * pages.length)]!;
    const rows: BankStockStored[] = [];
    for (let c = 1; c <= 12; c++) {
      if (rnd() < 0.35) continue;
      if (!price.has(c) || rnd() < 0.2) price.set(c, 50 + Math.floor(rnd() * 6) * 5);
      const stock = rnd() < 0.1 ? 0 : rnd() < 0.15 ? null : 1 + Math.floor(rnd() * 3);
      rows.push(row(`${c};6`, rnd() < 0.05 ? null : price.get(c)!, stock));
    }
    out.push(save(at, rows, page));
  }
  // The input order never matters.
  return out.reverse();
}

describe('ACT-10 key states and the 0.7.4 rules', () => {
  it('keyStates equal 0.7.4 scraptfKeyStatesOf (and scraptfKeyStatesOf delegates)', () => {
    const fixtures: ScraptfSaveRows[][] = [
      hourly([null, row('1;6', 100, 1), row('1;6', 90, 1), row('1;6', 90, 3), null, row('1;6', 90, 2)], () => [row('9;6', 5)]),
      [save(T0, [row('1;6', 50)], '/items/2'), save(T0 + HOUR, [row('1;6', 50)], '/items/3'), save(T0 + 2 * HOUR, [], '/items/2'), save(T0 + 3 * HOUR, [row('1;6', 40)], '/items/3')],
      [save(T0, [row('1;6', 50), row('1;6', 60)]), save(T0, [row('1;6', 55)]), save(T0 + HOUR, [row('1;6', null, 0)])],
      ...Array.from({ length: 25 }, (_, i) => fuzzSaves(i + 1)),
    ];
    for (const saves of fixtures) {
      const expected = keyStates074(saves);
      expect(lifeOf(saves).keyStates).toEqual(expected);
      expect(scraptfKeyStatesOf(saves)).toEqual(expected);
    }
  });

  it('with flapMaxMs 0, the open state starts at priceSince and the open run at scraptfRunsOf listedSince', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const saves = fuzzSaves(seed);
      const life = lifeOf(saves, { flapMaxMs: 0 });
      const runs = scraptfRunsOf(saves);
      for (const [key, c] of life.copies) {
        const st = life.keyStates.get(key)!;
        const run = runs.get(key)!;
        expect(c.onSale, key).toBe(st.onSale);
        if (!c.onSale) {
          expect(run.listedSince, key).toBeNull();
          continue;
        }
        const open = c.states[c.states.length - 1]!;
        expect(open.outcome, key).toBe('open');
        expect(open.startAt, key).toBe(st.priceSince);
        expect(c.runs[c.runs.length - 1]!.firstOnSaleAt, key).toBe(run.listedSince);
      }
      // With flaps on, runs stay factual: the last run still starts at listedSince.
      for (const [key, c] of lifeOf(saves).copies) if (c.onSale) expect(c.runs[c.runs.length - 1]!.firstOnSaleAt, key).toBe(runs.get(key)!.listedSince);
    }
  });
});

describe('scraptfCopyBankOf', () => {
  const kp: KeyPriceState = { valueScrap: K, source: 'bptf', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };
  it("equals scraptfItemHistoryOf's bank", () => {
    const now = T0 + 10 * DAY;
    for (let seed = 1; seed <= 12; seed++) {
      const banks: { bank: ScraptfBank; saves: ScraptfSaveRows[] }[] = [
        { bank: 'list', saves: fuzzSaves(seed * 3, 40) },
        { bank: 'hats', saves: fuzzSaves(seed * 3 + 1, 40) },
        { bank: 'weapons', saves: fuzzSaves(seed * 3 + 2, 40) },
      ];
      const lives = banks.map((b) => ({ bank: b.bank, life: lifeOf(b.saves) }));
      for (let c = 1; c <= 13; c++) {
        const sku = `${c};6`;
        const h = scraptfItemHistoryOf({ sku, specialKey: '', banks, events: [], keyPrice: kp, now });
        expect(scraptfCopyBankOf(lives, bankStockKey(sku, '')), `${seed} ${sku}`).toBe(h.bank);
      }
    }
    expect(scraptfCopyBankOf([], KEY)).toBeNull();
  });
});
