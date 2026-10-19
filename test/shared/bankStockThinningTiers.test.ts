// 0.7.1 (DM-3, CQ-1): the thinning tiers under heavy scrap.tf window use. A page read every few minutes
// for a day, on top of 90 days of history, keeps every hourly and daily bucket of that history (the 300
// cap only bounds the last 2 h), stays bounded, and never loses its newest save, the save before it or
// its session baseline. Pure (bankStockThinning in src/shared/bankStock.ts); no database, no network.

import { describe, expect, it } from 'vitest';
import {
  BANK_STOCK_HOURLY_MS,
  BANK_STOCK_KEEP_ALL_MS,
  BANK_STOCK_MAX_AGE_MS,
  BANK_STOCK_MAX_SAVES_PER_PAGE,
  BANK_STOCK_RECENT_TIER_MS,
  bankStockBaselineOf,
  bankStockThinning,
  type BankStockThinSave,
} from '../../src/shared/bankStock';
import type { UnixMs } from '../../src/shared/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

/** One page's saves at these times, batch ids in the order given. */
function pageSaves(times: readonly UnixMs[], first = 1): BankStockThinSave[] {
  return times.map((savedAt, i) => ({ batchId: first + i, savedAt, bank: 'hats', page: '/buy/hats' }));
}

/** Every `step` from `from` up to and including `to`. */
function every(from: UnixMs, to: UnixMs, step: number): UnixMs[] {
  const out: UnixMs[] = [];
  for (let t = from; t <= to; t += step) out.push(t);
  return out;
}

describe('bankStockThinning under heavy window use (0.7.1)', () => {
  // 90 days of a page saved every 2 hours, then a day of the window reading it every 3 minutes.
  const history = every(NOW - BANK_STOCK_MAX_AGE_MS + HOUR, NOW - DAY - HOUR, 2 * HOUR);
  const heavy = every(NOW - DAY + 3 * MIN, NOW, 3 * MIN);
  const saves = pageSaves([...history, ...heavy]);
  const drop = bankStockThinning(saves, NOW);
  const kept = saves.filter((s) => !drop.has(s.batchId));
  const keptAt = new Set(kept.map((s) => s.savedAt));

  it('keeps every hourly bucket from 24 h to 7 d and every daily one to 90 d', () => {
    expect(heavy.length).toBe(480);
    for (const t of history) {
      const age = NOW - t;
      if (age < BANK_STOCK_RECENT_TIER_MS || age > BANK_STOCK_MAX_AGE_MS) continue;
      const bucket = age < BANK_STOCK_HOURLY_MS ? (x: UnixMs) => Math.floor(x / HOUR) : (x: UnixMs) => Math.floor(x / DAY);
      const sameTier = (x: UnixMs) => (NOW - x < BANK_STOCK_HOURLY_MS) === age < BANK_STOCK_HOURLY_MS;
      expect(
        kept.some((s) => sameTier(s.savedAt) && bucket(s.savedAt) === bucket(t)),
        `${age / HOUR} h`,
      ).toBe(true);
    }
    // Every history save in the hourly tier is alone in its hour, so each one stays.
    for (const t of history) if (NOW - t < BANK_STOCK_HOURLY_MS) expect(keptAt.has(t), `${(NOW - t) / HOUR} h`).toBe(true);
  });

  it('keeps every read of the last 2 h and one per 10 minutes of the rest of the day, bounded under 400', () => {
    for (const t of heavy) if (NOW - t < BANK_STOCK_KEEP_ALL_MS) expect(keptAt.has(t)).toBe(true);
    const tenMinute = kept.filter((s) => NOW - s.savedAt >= BANK_STOCK_KEEP_ALL_MS && NOW - s.savedAt < BANK_STOCK_RECENT_TIER_MS);
    const buckets = new Set(tenMinute.map((s) => Math.floor(s.savedAt / (10 * MIN))));
    // Every 10-minute bucket of the day, each with its newest read.
    const dayBuckets = new Set(heavy.filter((t) => NOW - t >= BANK_STOCK_KEEP_ALL_MS && NOW - t < BANK_STOCK_RECENT_TIER_MS).map((t) => Math.floor(t / (10 * MIN))));
    expect(buckets).toEqual(dayBuckets);
    for (const b of buckets) expect(keptAt.has(Math.max(...heavy.filter((t) => Math.floor(t / (10 * MIN)) === b)))).toBe(true);
    // Beyond those, only the few that keep the day's session whole (DC-3): about one per 27 minutes.
    expect(tenMinute.length - buckets.size).toBeLessThanOrEqual(Math.ceil((22 * HOUR) / (27 * MIN)));
    expect(kept.length).toBeLessThan(400);
    // F20 before 0.7.1 kept the last day's 480 reads and capped the page at 300: no history at all.
    expect(kept.filter((s) => NOW - s.savedAt > DAY).length).toBeGreaterThan(100);
  });

  it('is stable: a second run deletes nothing', () => {
    expect(bankStockThinning(kept, NOW).size).toBe(0);
  });

  it('caps only the last 2 h: 600 reads 10 s apart keep their newest 300, the bridge past them and the whole history', () => {
    const burst = every(NOW - 6_000_000 + 10_000, NOW, 10_000);
    expect(burst.length).toBe(600);
    const all = pageSaves([...history, ...burst]);
    const gone = bankStockThinning(all, NOW);
    const left = all.filter((s) => !gone.has(s.batchId));
    const recent = left.filter((s) => NOW - s.savedAt < BANK_STOCK_KEEP_ALL_MS);
    // The newest 300, plus only the few past them that keep the session whole (DC-3: under 30 min apart).
    for (const t of burst.slice(-BANK_STOCK_MAX_SAVES_PER_PAGE)) expect(recent.some((s) => s.savedAt === t)).toBe(true);
    expect(recent.length).toBeGreaterThan(BANK_STOCK_MAX_SAVES_PER_PAGE);
    expect(recent.length).toBeLessThanOrEqual(BANK_STOCK_MAX_SAVES_PER_PAGE + 4);
    const times = recent.map((s) => s.savedAt).sort((a, b) => b - a);
    for (let i = 1; i < times.length; i++) expect(times[i - 1]! - times[i]!).toBeLessThan(30 * MIN);
    for (const t of history) if (NOW - t < BANK_STOCK_HOURLY_MS) expect(left.some((s) => s.savedAt === t)).toBe(true);
  });

  it("never deletes the newest save, the one before it or the session baseline, past the cap or 90 days", () => {
    // Saved once 100 days ago, then read every 10 s for 100 minutes: the baseline is the old save.
    const burst = every(NOW - 6_000_000 + 10_000, NOW, 10_000);
    const all = pageSaves([NOW - 120 * DAY, NOW - 100 * DAY, ...burst]);
    const newestFirst = [...all].sort((a, b) => b.savedAt - a.savedAt || b.batchId - a.batchId);
    const baseline = bankStockBaselineOf(newestFirst)!;
    expect(baseline.savedAt).toBe(NOW - 100 * DAY);
    const gone = bankStockThinning(all, NOW);
    expect(gone.has(baseline.batchId)).toBe(false);
    expect(gone.has(newestFirst[0]!.batchId)).toBe(false);
    expect(gone.has(newestFirst[1]!.batchId)).toBe(false);
    // The save before the baseline is past 90 days and protects nothing: it goes.
    expect(gone.has(1)).toBe(true);
  });
});

// DC-3: the newest session stays one session as it ages, so its baseline does not move inside it.
describe('bankStockThinning keeps the newest session whole as it ages (DC-3)', () => {
  const newestFirst = (s: readonly BankStockThinSave[]) => [...s].sort((a, b) => b.savedAt - a.savedAt || b.batchId - a.batchId);
  const baselineOf = (s: readonly BankStockThinSave[]) => bankStockBaselineOf(newestFirst(s))?.batchId ?? null;
  /** The largest gap between kept saves of the newest session (newest back to the save just after its baseline). */
  const widestSessionGap = (s: readonly BankStockThinSave[]) => {
    const g = newestFirst(s);
    const b = bankStockBaselineOf(g);
    const session = g.slice(0, b === null ? g.length : g.indexOf(b));
    let widest = 0;
    for (let i = 1; i < session.length; i++) widest = Math.max(widest, session[i - 1]!.savedAt - session[i]!.savedAt);
    return widest;
  };

  it('an idle page read for 3 h keeps the save before that session as its baseline, prune after prune', () => {
    // Y a day before, then the window reading the page every 30 s from 8 h to 5 h ago; nothing since.
    const y = pageSaves([NOW - 30 * HOUR])[0]!;
    let kept = [y, ...pageSaves(every(NOW - 8 * HOUR, NOW - 5 * HOUR, 30_000), 2)];
    expect(baselineOf(kept)).toBe(y.batchId);
    // A prune runs after every import of any bank: once an hour for three days here.
    for (let h = 0; h <= 72; h++) {
      const at = NOW + h * HOUR;
      const drop = bankStockThinning(kept, at);
      kept = kept.filter((s) => !drop.has(s.batchId));
      expect(baselineOf(kept), `${h} h on`).toBe(y.batchId);
      expect(widestSessionGap(kept), `${h} h on`).toBeLessThan(30 * MIN);
    }
    // Bounded: about two saves per 30 minutes of the session, plus its hourly buckets.
    expect(kept.length).toBeLessThan(25);
  });

  it('a save the 10-minute tier drops never splits the session (X+9, X+38, X+39.9, X+49, X+59 min)', () => {
    const x = NOW - 4 * HOUR;
    const y = pageSaves([x - 30 * HOUR])[0]!;
    const session = pageSaves([x + 9 * MIN, x + 38 * MIN, x + 39.9 * MIN, x + 49 * MIN, x + 59 * MIN], 2);
    const all = [y, ...session];
    expect(baselineOf(all)).toBe(y.batchId);
    const drop = bankStockThinning(all, NOW);
    const kept = all.filter((s) => !drop.has(s.batchId));
    // X+38 bridges X+9 and X+39.9 (30.9 min apart): the 10-minute bucket alone would drop it.
    expect(drop.has(session[1]!.batchId)).toBe(false);
    expect(baselineOf(kept)).toBe(y.batchId);
    expect(widestSessionGap(kept)).toBeLessThan(30 * MIN);
    expect(bankStockThinning(kept, NOW).size).toBe(0);
  });
});
