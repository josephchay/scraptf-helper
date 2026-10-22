// 0.9 (#1): the trade lock the user set (Settings.tradeLock). Reading the mode, when a unit becomes tradable (its
// journal time + 7 days, strictly locked before), the row's locked lots, the Locked advice (today's verdict kept as a
// reason, every other reason unchanged), the units-locked context reason, and Holdings' totals leaving locked rows out
// of Sellable now. With 'none' or 'unknown' every 0.8 figure and verdict is unchanged. Pure; no network.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  TRADE_LOCK_MS,
  holdingAdvice,
  holdingTradeLockOf,
  tradableAtOf,
  tradeLockModeOf,
  withTradeLock,
} from '../../src/shared/holdingAdvice';
import { holdingLockedNow, holdingRow, holdingsTotals, type HoldingBuySide } from '../../src/shared/holdings';
import type { HoldingAdviceReason, HoldingRow, JournalLot, OrderSummary, ProfitSettings, TradeLockMode, TypicalHold } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY = 567;
const P: ProfitSettings = DEFAULT_SETTINGS.profit;
const TYPICAL: TypicalHold = { medianMs: 2 * DAY, count: 6, scope: 'all', stillHeld: 3 };

function order(value: number): OrderSummary {
  return {
    listingId: `o${value}`,
    steamid: `S${value}`,
    userName: 'Buyer',
    keys: 0,
    metalScrap: value,
    valueScrap: value,
    isBot: true,
    online: null,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
}

function side(value: number): HoldingBuySide {
  const o = order(value);
  return {
    revenueScrap: value,
    bestScrap: value,
    instantScrap: value,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 2,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    nextBuyer: null,
    verifiedBuyerCount: 1,
  };
}

let nextId = 1;
function lot(ts: number, cost = 100): JournalLot {
  return { id: nextId++, ts, costScrap: cost, keys: 0, scrap: cost, keyPriceScrap: KEY };
}

/** A held position of `lots` (oldest first) priced by the shared holdingRow, the buyer paying `revenue`. */
function row(lots: JournalLot[], revenue: number | null = 130, sku = '378;6'): HoldingRow {
  const pos = { sku, name: `Item ${sku}`, qty: lots.length, costScrap: lots.reduce((t, l) => t + l.costScrap, 0), lots };
  return holdingRow(pos, 'hats', revenue === null ? null : side(revenue), P, KEY, null, { ask: null, refs: null, snapshotAt: NOW - HOUR });
}

const codes = (rs: readonly HoldingAdviceReason[]) => rs.map((r) => r.code);

describe('tradeLockModeOf', () => {
  it("reads 'none' and '7d', and anything else as 'unknown'", () => {
    expect(tradeLockModeOf({ tradeLock: { mode: 'none' } })).toBe('none');
    expect(tradeLockModeOf({ tradeLock: { mode: '7d' } })).toBe('7d');
    expect(tradeLockModeOf({ tradeLock: { mode: 'unknown' } })).toBe('unknown');
    for (const junk of [null, undefined, {}, { tradeLock: null }, { tradeLock: {} }, { tradeLock: { mode: '7D' } }, { tradeLock: { mode: 7 } }, { tradeLock: { mode: null } }]) {
      expect(tradeLockModeOf(junk as Parameters<typeof tradeLockModeOf>[0])).toBe('unknown');
    }
    expect(tradeLockModeOf(DEFAULT_SETTINGS)).toBe('unknown');
  });
});

describe('tradableAtOf', () => {
  it("is the journal time + 7 days with '7d' only", () => {
    expect(TRADE_LOCK_MS).toBe(7 * DAY);
    expect(tradableAtOf(NOW - DAY, '7d')).toBe(NOW + 6 * DAY);
    expect(tradableAtOf(NOW - DAY, 'none')).toBeNull();
    expect(tradableAtOf(NOW - DAY, 'unknown')).toBeNull();
  });

  it('never locks a unit whose time is 0, negative or not a number', () => {
    for (const ts of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(tradableAtOf(ts, '7d')).toBeNull();
  });
});

describe('holdingTradeLockOf', () => {
  it('unlocks exactly 7 days after the buy: one ms earlier it is still locked', () => {
    expect(holdingTradeLockOf([lot(NOW - 7 * DAY)], '7d', NOW)).toBeNull();
    expect(holdingTradeLockOf([lot(NOW - 7 * DAY + 1)], '7d', NOW)).toEqual({ lockedQty: 1, nextLotTradableAt: NOW + 1, firstTradableAt: NOW + 1 });
  });

  it('locks a unit dated in the future', () => {
    expect(holdingTradeLockOf([lot(NOW + DAY)], '7d', NOW)).toEqual({ lockedQty: 1, nextLotTradableAt: NOW + 8 * DAY, firstTradableAt: NOW + 8 * DAY });
  });

  it('counts the locked lots, names the next one only when it is locked, and the earliest unlock', () => {
    // The next lot (the one a sale closes) is tradable, a later one is not.
    expect(holdingTradeLockOf([lot(NOW - 10 * DAY), lot(NOW - 2 * DAY)], '7d', NOW)).toEqual({ lockedQty: 1, nextLotTradableAt: null, firstTradableAt: NOW + 5 * DAY });
    // Every lot locked: the earliest unlock over all of them.
    expect(holdingTradeLockOf([lot(NOW - 6 * DAY), lot(NOW - DAY), lot(NOW - 3 * DAY)], '7d', NOW)).toEqual({
      lockedQty: 3,
      nextLotTradableAt: NOW + DAY,
      firstTradableAt: NOW + DAY,
    });
  });

  it("is null with another mode, no lots or nothing locked", () => {
    const fresh = [lot(NOW - DAY)];
    expect(holdingTradeLockOf(fresh, 'none', NOW)).toBeNull();
    expect(holdingTradeLockOf(fresh, 'unknown', NOW)).toBeNull();
    expect(holdingTradeLockOf([], '7d', NOW)).toBeNull();
    expect(holdingTradeLockOf(null as unknown as JournalLot[], '7d', NOW)).toBeNull();
    expect(holdingTradeLockOf([lot(NOW - 8 * DAY), lot(NOW - 30 * DAY)], '7d', NOW)).toBeNull();
    expect(holdingTradeLockOf([lot(0)], '7d', NOW)).toBeNull();
  });
});

describe('withTradeLock', () => {
  it('adds no key when nothing is locked, so 0.8 rows stay as they were', () => {
    const lots = [lot(NOW - 10 * DAY)];
    const r = row(lots);
    const same = withTradeLock(r, lots, '7d', NOW);
    expect(same).toBe(r);
    expect('tradeLock' in same).toBe(false);
    const fresh = [lot(NOW - DAY)];
    const f = row(fresh);
    for (const mode of ['none', 'unknown'] as const) {
      expect(withTradeLock(f, fresh, mode, NOW)).toBe(f);
    }
  });

  it('sets tradeLock on a copy and changes no figure', () => {
    const lots = [lot(NOW - DAY)];
    const r = row(lots);
    const locked = withTradeLock(r, lots, '7d', NOW);
    expect(locked).not.toBe(r);
    expect(locked.tradeLock).toEqual({ lockedQty: 1, nextLotTradableAt: NOW + 6 * DAY, firstTradableAt: NOW + 6 * DAY });
    const { tradeLock: _lock, ...rest } = locked;
    expect(rest).toEqual(r);
  });
});

describe('holdingAdvice with a trade lock (0.9, #1)', () => {
  /** The same holding with the user's typical hold, so held-vs-typical is among the reasons. */
  const held = (lots: JournalLot[], mode: TradeLockMode): HoldingRow => withTradeLock({ ...row(lots), typicalHold: TYPICAL }, lots, mode, NOW);

  it("reads Locked while the next unit is locked: the date first, then today's verdict and every reason unchanged", () => {
    const lots = [lot(NOW - 2 * DAY)];
    const plain = holdingAdvice(held(lots, 'none'), null, P, KEY, NOW);
    expect(plain.kind).toBe('sell-now');
    const a = holdingAdvice(held(lots, '7d'), null, P, KEY, NOW);
    expect(a.kind).toBe('locked');
    expect(a.reasons[0]).toEqual({ code: 'trade-locked', tradableAt: NOW + 5 * DAY, boughtAt: NOW - 2 * DAY, todayKind: plain.kind });
    expect(a.reasons.slice(1)).toEqual(plain.reasons);
    expect(a.basis).toEqual(plain.basis);
    expect(a.refreshFirst).toBe(plain.refreshFirst);
    expect(codes(a.reasons)).not.toContain('units-locked');
  });

  it("keeps today's verdict for each kind the book gives", () => {
    const lots = [lot(NOW - 2 * DAY)];
    for (const revenue of [130, 105, 80, null]) {
      const plain = holdingAdvice(withTradeLock(row(lots, revenue), lots, 'none', NOW), null, P, KEY, NOW);
      const a = holdingAdvice(withTradeLock(row(lots, revenue), lots, '7d', NOW), null, P, KEY, NOW);
      expect(a.kind).toBe('locked');
      expect(a.reasons[0]).toMatchObject({ code: 'trade-locked', todayKind: plain.kind });
    }
  });

  it('adds units-locked after held-vs-typical when only later units are locked, and keeps the verdict', () => {
    const lots = [lot(NOW - 10 * DAY), lot(NOW - 3 * DAY), lot(NOW - DAY)];
    const plain = holdingAdvice(held(lots, 'none'), null, P, KEY, NOW);
    const a = holdingAdvice(held(lots, '7d'), null, P, KEY, NOW);
    expect(a.kind).toBe(plain.kind);
    const c = codes(a.reasons);
    expect(c.indexOf('units-locked')).toBe(c.indexOf('held-vs-typical') + 1);
    expect(a.reasons.find((r) => r.code === 'units-locked')).toEqual({ code: 'units-locked', lockedQty: 2, qty: 3, firstTradableAt: NOW + 4 * DAY });
    // Everything else as without the lock.
    expect(a.reasons.filter((r) => r.code !== 'units-locked')).toEqual(plain.reasons);
  });

  it("reads a lock that has ended by `now` as no lock (a row read before the unlock, judged after it)", () => {
    const lots = [lot(NOW - 2 * DAY)];
    const r = held(lots, '7d');
    const later = NOW + 5 * DAY + 1;
    expect(holdingAdvice(r, null, P, KEY, later).kind).toBe(holdingAdvice(held(lots, 'none'), null, P, KEY, later).kind);
  });

  it("with 'none' or 'unknown' the advice equals 0.8's, however fresh the buys", () => {
    const lots = [lot(NOW - DAY), lot(NOW - HOUR)];
    const base = { ...row(lots), typicalHold: TYPICAL };
    const old = holdingAdvice(base, null, P, KEY, NOW);
    for (const mode of ['none', 'unknown'] as const) {
      const r = withTradeLock(base, lots, mode, NOW);
      expect(r).toBe(base);
      expect(holdingAdvice(r, null, P, KEY, NOW)).toEqual(old);
    }
  });
});

describe('holdingsTotals and holdingLockedNow (0.9, #1)', () => {
  it('leaves locked rows out of sellable and counts them in locked', () => {
    const lockedLots = [lot(NOW - DAY)];
    const sellLocked = withTradeLock(row(lockedLots, 130, '1;6'), lockedLots, '7d', NOW);
    const freeLots = [lot(NOW - 10 * DAY)];
    const sellFree = withTradeLock(row(freeLots, 130, '2;6'), freeLots, '7d', NOW);
    const holdLots = [lot(NOW - 2 * DAY)];
    const holdLocked = withTradeLock(row(holdLots, 105, '3;6'), holdLots, '7d', NOW);
    // Only later units locked: the next one can be sold.
    const laterLots = [lot(NOW - 10 * DAY), lot(NOW - DAY)];
    const sellLater = withTradeLock(row(laterLots, 130, '4;6'), laterLots, '7d', NOW);
    expect([sellLocked, sellFree, holdLocked, sellLater].map((r) => r.status)).toEqual(['sell', 'sell', 'hold', 'sell']);
    const t = holdingsTotals([sellLocked, sellFree, holdLocked, sellLater]);
    expect(t.sellable).toBe(2);
    expect(t.locked).toBe(2);
    // Worth now and P/L are unchanged by the lock.
    const plain = holdingsTotals([row(lockedLots, 130, '1;6'), row(freeLots, 130, '2;6'), row(holdLots, 105, '3;6'), row(laterLots, 130, '4;6')]);
    expect({ ...t, locked: undefined, sellable: undefined }).toEqual({ ...plain, locked: undefined, sellable: undefined });
    expect(plain.sellable).toBe(3);
  });

  it('has no locked key at 0', () => {
    const t = holdingsTotals([row([lot(NOW - 10 * DAY)])]);
    expect('locked' in t).toBe(false);
    expect(t).toEqual({ items: 1, units: 1, costScrap: 100, worthNowScrap: 130, profitNowScrap: 30, sellable: 1 });
  });

  it('holdingLockedNow is true only with a next-lot unlock time', () => {
    expect(holdingLockedNow({})).toBe(false);
    expect(holdingLockedNow({ tradeLock: undefined })).toBe(false);
    expect(holdingLockedNow({ tradeLock: { lockedQty: 1, nextLotTradableAt: null, firstTradableAt: NOW + DAY } })).toBe(false);
    expect(holdingLockedNow({ tradeLock: { lockedQty: 1, nextLotTradableAt: Number.NaN, firstTradableAt: NOW + DAY } })).toBe(false);
    expect(holdingLockedNow({ tradeLock: { lockedQty: 1, nextLotTradableAt: NOW + DAY, firstTradableAt: NOW + DAY } })).toBe(true);
  });
});
