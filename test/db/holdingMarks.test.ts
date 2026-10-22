// 0.8 (H1): recorded exit runs of held and watched bases (holding_marks, schema V15). Each run is a span of
// identical prices seen while the live feed was up; the repo appends runs, moves a run's end forward, reads a
// base's runs and prunes them (180 days, at most 2,000 per base). Each price side is both or neither.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { MIGRATIONS, migrate } from '../../src/service/db/migrations';
import { HOLDING_DETAIL_MAX_MARKS, HOLDING_MARKS_MAX_AGE_MS, HOLDING_MARKS_PER_BASE_MAX } from '../../src/shared/holdingAdvice';
import type { HoldingMark } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_792_496_380_093;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repo(): Repo {
  const r = openRepo(':memory:');
  cleanups.push(() => r.close());
  return r;
}

const all = (db: DatabaseSync, sql: string): unknown[] => db.prepare(sql).all().map((r) => ({ ...r }));

/** A run with every side null (nothing seen but the times), with `over` on top. */
const empty = (over: Partial<Omit<HoldingMark, 'id'>> = {}): Omit<HoldingMark, 'id'> => ({
  baseSku: '378;6',
  fromAt: T0,
  toAt: T0,
  revKeys: null,
  revMetalScrap: null,
  revIsBot: null,
  revVerified: null,
  bestKeys: null,
  bestMetalScrap: null,
  nextKeys: null,
  nextMetalScrap: null,
  buyerCount: 0,
  verifiedBuyerCount: null,
  askKeys: null,
  askMetalScrap: null,
  askCount: null,
  scraptfPaysKeys: null,
  scraptfPaysScrap: null,
  keyScrap: null,
  ...over,
});

const full = (over: Partial<Omit<HoldingMark, 'id'>> = {}): Omit<HoldingMark, 'id'> =>
  empty({
    revKeys: 1,
    revMetalScrap: 27,
    revIsBot: true,
    revVerified: false,
    bestKeys: 1,
    bestMetalScrap: 36,
    nextKeys: 0,
    nextMetalScrap: 500,
    buyerCount: 4,
    verifiedBuyerCount: 3,
    askKeys: 1,
    askMetalScrap: 90,
    askCount: 2,
    scraptfPaysKeys: 1,
    scraptfPaysScrap: 9,
    keyScrap: 567,
    ...over,
  });

describe('holding_marks (V15)', () => {
  it('is created by V15 on a V14 database, with both indexes', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const db = new DatabaseSync(t.file());
    cleanups.push(() => db.close());
    migrate(db, MIGRATIONS.slice(0, 14));
    expect(all(db, "SELECT name FROM sqlite_master WHERE name LIKE 'holding_marks%'")).toEqual([]);
    expect(migrate(db).applied).toEqual([15]);
    expect(all(db, "SELECT type, name FROM sqlite_master WHERE name LIKE 'holding_marks%' ORDER BY name")).toEqual([
      { type: 'table', name: 'holding_marks' },
      { type: 'index', name: 'holding_marks_base_from' },
      { type: 'index', name: 'holding_marks_to_at' },
    ]);
    // The per-base read seeks the (base_sku, from_at) index.
    const plan = all(db, "EXPLAIN QUERY PLAN SELECT * FROM holding_marks WHERE base_sku = '378;6' ORDER BY from_at DESC, id DESC LIMIT 1") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/holding_marks_base_from/);
  });
});

describe('Repo holding marks', () => {
  it('round-trips a run with every side set, and one with every side null', () => {
    const r = repo();
    const a = r.insertHoldingMark(full());
    const b = r.insertHoldingMark(empty({ fromAt: T0 + MIN, toAt: T0 + MIN }));
    expect(b).toBeGreaterThan(a);
    expect(r.holdingMarks('378;6', 0)).toEqual([
      { id: a, ...full() },
      { id: b, ...empty({ fromAt: T0 + MIN, toAt: T0 + MIN }) },
    ]);
  });

  it('keeps each side both or neither: keys are NULL when that side has no finite metal', () => {
    const r = repo();
    const id = r.insertHoldingMark(empty({ revKeys: 2, revMetalScrap: null, askKeys: 1, askMetalScrap: Number.NaN, bestKeys: 1, bestMetalScrap: 4.4, keyScrap: null }));
    const [m] = r.holdingMarks('378;6', 0);
    expect(m).toMatchObject({ id, revKeys: null, revMetalScrap: null, askKeys: null, askMetalScrap: null, bestKeys: 1, bestMetalScrap: 4, keyScrap: null });
    // Counts are whole; a missing buyer count reads 0.
    r.insertHoldingMark(empty({ fromAt: T0 + 1, buyerCount: 2.7, verifiedBuyerCount: -1, askCount: 3.2 }));
    expect(r.holdingMarks('378;6', 0)[1]).toMatchObject({ buyerCount: 2, verifiedBuyerCount: null, askCount: 3 });
    expect(() => r.insertHoldingMark(empty({ baseSku: '' }))).toThrow(TypeError);
    expect(() => r.insertHoldingMark(empty({ toAt: Number.NaN }))).toThrow(TypeError);
  });

  it('extendHoldingMark only moves to_at forward, sets the counts when given, and is false for a missing id', () => {
    const r = repo();
    const id = r.insertHoldingMark(full({ toAt: T0 + 10 * MIN }));
    expect(r.extendHoldingMark(id, T0 + 20 * MIN)).toBe(true);
    expect(r.holdingMarks('378;6', 0)[0]).toMatchObject({ toAt: T0 + 20 * MIN, buyerCount: 4, verifiedBuyerCount: 3, askCount: 2 });
    // Never back, and still true for an existing run whose end stays.
    expect(r.extendHoldingMark(id, T0 + 5 * MIN)).toBe(true);
    expect(r.holdingMarks('378;6', 0)[0]!.toAt).toBe(T0 + 20 * MIN);
    // The latest counts of the run.
    expect(r.extendHoldingMark(id, T0 + 30 * MIN, { buyerCount: 6, verifiedBuyerCount: null, askCount: 1 })).toBe(true);
    expect(r.holdingMarks('378;6', 0)[0]).toMatchObject({ toAt: T0 + 30 * MIN, buyerCount: 6, verifiedBuyerCount: null, askCount: 1 });
    // Without counts they stay.
    r.extendHoldingMark(id, T0 + 31 * MIN);
    expect(r.holdingMarks('378;6', 0)[0]).toMatchObject({ toAt: T0 + 31 * MIN, buyerCount: 6, verifiedBuyerCount: null, askCount: 1 });
    expect(r.extendHoldingMark(9999, T0)).toBe(false);
    expect(r.extendHoldingMark(9999, T0, { buyerCount: 1, verifiedBuyerCount: 1, askCount: 1 })).toBe(false);
  });

  it('holdingMarks filters by to_at >= sinceTs, keeps the newest `limit` and returns them oldest first', () => {
    const r = repo();
    const ids = [0, 1, 2, 3, 4].map((i) => r.insertHoldingMark(empty({ fromAt: T0 + i * 10 * MIN, toAt: T0 + i * 10 * MIN + 5 * MIN })));
    r.insertHoldingMark(empty({ baseSku: '5021;6', fromAt: T0, toAt: T0 + 90 * MIN }));
    expect(r.holdingMarks('378;6', 0).map((m) => m.id)).toEqual(ids);
    // A run ending exactly at sinceTs is kept; one ending before it is not.
    expect(r.holdingMarks('378;6', T0 + 15 * MIN).map((m) => m.id)).toEqual(ids.slice(1));
    expect(r.holdingMarks('378;6', 0, 2).map((m) => m.id)).toEqual(ids.slice(3));
    expect(r.holdingMarks('378;6', 0, 0).map((m) => m.id)).toEqual(ids.slice(4));
    expect(r.holdingMarks('nope;6', 0)).toEqual([]);
    expect(r.holdingMarks('', 0)).toEqual([]);
    expect(HOLDING_DETAIL_MAX_MARKS).toBe(500);
  });

  it('latestHoldingMarks returns each base its newest run, and leaves out bases with none', () => {
    const r = repo();
    r.insertHoldingMark(empty({ fromAt: T0 }));
    const newest = r.insertHoldingMark(empty({ fromAt: T0 + MIN, buyerCount: 2 }));
    // Same from_at: the higher id wins.
    r.insertHoldingMark(empty({ baseSku: '5021;6', fromAt: T0 }));
    const tie = r.insertHoldingMark(empty({ baseSku: '5021;6', fromAt: T0 }));
    const latest = r.latestHoldingMarks(['378;6', '5021;6', '199;6', '378;6']);
    expect([...latest.keys()].sort()).toEqual(['378;6', '5021;6']);
    expect(latest.get('378;6')).toMatchObject({ id: newest, buyerCount: 2 });
    expect(latest.get('5021;6')!.id).toBe(tie);
    expect(r.latestHoldingMarks([]).size).toBe(0);
  });

  it('pruneHoldingMarks prunes by age, then each base beyond the cap (oldest first), leaving other bases alone', () => {
    const r = repo();
    const now = T0 + 200 * DAY;
    // Ended 181 days ago: older than 180.
    r.insertHoldingMark(empty({ fromAt: now - 182 * DAY, toAt: now - 181 * DAY }));
    // Started long ago but ended within 180 days: kept.
    const spanning = r.insertHoldingMark(empty({ fromAt: now - 190 * DAY, toAt: now - 100 * DAY }));
    const recent = [1, 2, 3].map((d) => r.insertHoldingMark(empty({ fromAt: now - d * MIN, toAt: now - d * MIN })));
    const other = r.insertHoldingMark(empty({ baseSku: '5021;6', fromAt: now - DAY, toAt: now - DAY }));
    expect(r.pruneHoldingMarks(now)).toBe(1);
    expect(r.holdingMarks('378;6', 0).map((m) => m.id)).toEqual([spanning, recent[2], recent[1], recent[0]]);

    // At most 2 per base: the 2 oldest of 378;6 go, 5021;6 keeps its one.
    expect(r.pruneHoldingMarks(now, { perBaseMax: 2 })).toBe(2);
    expect(r.holdingMarks('378;6', 0).map((m) => m.id)).toEqual([recent[1], recent[0]]);
    expect(r.holdingMarks('5021;6', 0).map((m) => m.id)).toEqual([other]);
    // A shorter age.
    expect(r.pruneHoldingMarks(now, { maxAgeMs: 90 * 60_000 })).toBe(1);
    expect(r.pruneHoldingMarks(now)).toBe(0);
    expect(HOLDING_MARKS_MAX_AGE_MS).toBe(180 * DAY);
    expect(HOLDING_MARKS_PER_BASE_MAX).toBe(2000);
  });
});
