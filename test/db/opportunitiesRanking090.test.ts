// 0.9 (ranking, #3 and #12, schema V16): the repo half of the risk-aware ranking. Three opportunity columns
// (backup_profit_scrap, profitable_depth, book_depth) round-trip, NULL reading absent (a row stored before V16, or no
// backup buyer); 'opps.list' sorts by "If this buyer leaves" and "Buyers at break-even" with missing values last in
// both directions and the same ties as every other key (profit, then name, then key); and holdingMarksSince reads
// every base's recorded runs for the suggested reserve.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { RESERVE_MAX_MARKS } from '../../src/shared/reserveSuggest';
import type { HoldingMark, Opportunity } from '../../src/shared/types';
import { makeOpp, tempDir } from './helpers';

const T0 = 1_792_496_380_093;
const HOUR = 3_600_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repo(): Repo {
  const r = openRepo(':memory:');
  cleanups.push(() => r.close());
  return r;
}

/** One opportunity per price id, so each has its own key. */
const opp = (id: number, over: Partial<Opportunity>): Opportunity => makeOpp({ inputRef: `price:${id}`, ...over });

describe('opportunities: the V16 ranking keys round-trip', () => {
  it('reads the three fields back when set (0 is a value), and none of them when NULL', () => {
    const r = repo();
    const set = opp(1, { backupProfitScrap: 40, profitableDepth: 3, bookDepth: 7 });
    const zeros = opp(2, { backupProfitScrap: 0, profitableDepth: 0, bookDepth: 0 });
    const loss = opp(3, { backupProfitScrap: -25, profitableDepth: 0, bookDepth: 1 });
    const none = opp(4, {});
    r.upsertOpportunities([set, zeros, loss, none]);
    expect(r.getOpportunity(set.key)).toEqual(set);
    expect(r.getOpportunity(zeros.key)).toEqual(zeros);
    expect(r.getOpportunity(loss.key)).toEqual(loss);
    const back = r.getOpportunity(none.key)!;
    expect(back).toEqual(none);
    for (const k of ['backupProfitScrap', 'profitableDepth', 'bookDepth']) expect(back).not.toHaveProperty(k);
  });

  it('stores NULL for an absent field, and a later write without the fields clears them', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = t.file();
    const r = openRepo(file);
    cleanups.push(() => r.close());
    const a = opp(1, { backupProfitScrap: 40, profitableDepth: 3, bookDepth: 7 });
    r.upsertOpportunities([a, opp(2, { bookDepth: 2 })]);
    r.upsertOpportunities([opp(1, {})]);
    expect(r.getOpportunity(a.key)).not.toHaveProperty('backupProfitScrap');
    r.close();
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare('SELECT key, backup_profit_scrap, profitable_depth, book_depth FROM opportunities ORDER BY key').all().map((x) => ({ ...x }));
      expect(rows).toEqual([
        { key: '378;6|price:1', backup_profit_scrap: null, profitable_depth: null, book_depth: null },
        { key: '378;6|price:2', backup_profit_scrap: null, profitable_depth: null, book_depth: 2 },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("queryOpportunities sorts 'backup' and 'depth' (OPP_SORT)", () => {
  /** Ties on the key go by profit (missing last), then name, then key; a missing key sorts last either way. */
  function seed(r: Repo, field: 'backupProfitScrap' | 'profitableDepth'): void {
    const v = (x: number | null): Partial<Opportunity> => (x === null ? {} : { [field]: x });
    r.upsertOpportunities([
      opp(1, { name: 'Alpha', profitScrap: 80, ...v(5) }),
      opp(2, { name: 'Bravo', profitScrap: 90, ...v(5) }),
      opp(3, { name: 'Charlie', profitScrap: 100, ...v(null) }),
      opp(4, { name: 'Delta', profitScrap: 20, ...v(1) }),
      opp(5, { name: 'echo', profitScrap: 90, ...v(5) }),
      opp(6, { name: 'Foxtrot', profitScrap: null, ...v(null) }),
      // The same name, profit and key value as price:2: the key decides.
      opp(7, { name: 'Bravo', profitScrap: 90, ...v(5) }),
      opp(8, { name: 'Golf', profitScrap: null, ...v(5) }),
    ]);
  }
  const ids = (rows: Opportunity[]) => rows.map((o) => o.inputRef);

  for (const [sort, field] of [
    ['backup', 'backupProfitScrap'],
    ['depth', 'profitableDepth'],
  ] as const) {
    it(`'${sort}': descending by default, missing last, ties by profit, name and key`, () => {
      const r = repo();
      seed(r, field);
      const desc = ['price:2', 'price:7', 'price:5', 'price:1', 'price:8', 'price:4', 'price:3', 'price:6'];
      expect(ids(r.queryOpportunities({ sort }))).toEqual(desc);
      expect(ids(r.queryOpportunities({ sort, dir: 'desc' }))).toEqual(desc);
    });

    it(`'${sort}': ascending keeps the missing ones last and the same ties`, () => {
      const r = repo();
      seed(r, field);
      expect(ids(r.queryOpportunities({ sort, dir: 'asc' }))).toEqual(['price:4', 'price:2', 'price:7', 'price:5', 'price:1', 'price:8', 'price:3', 'price:6']);
    });

    it(`'${sort}': pages over the same order`, () => {
      const r = repo();
      seed(r, field);
      expect(ids(r.queryOpportunities({ sort }, { limit: 3, offset: 2 }))).toEqual(['price:5', 'price:1', 'price:8']);
    });
  }

  it('leaves every existing sort as it was (profit has no profit tie of its own)', () => {
    const r = repo();
    seed(r, 'backupProfitScrap');
    expect(ids(r.queryOpportunities({ sort: 'profit' }))).toEqual(['price:3', 'price:2', 'price:7', 'price:5', 'price:1', 'price:4', 'price:6', 'price:8']);
  });
});

/** A recorded run with every side null but the times, with `over` on top. */
const mark = (over: Partial<Omit<HoldingMark, 'id'>> = {}): Omit<HoldingMark, 'id'> => ({
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

describe('holdingMarksSince (0.9, #12): every base, by to_at', () => {
  function seeded(): { r: Repo; ids: Record<string, number> } {
    const r = repo();
    const ids: Record<string, number> = {};
    const add = (name: string, m: Partial<Omit<HoldingMark, 'id'>>) => (ids[name] = r.insertHoldingMark(mark(m)));
    add('b1', { baseSku: '5021;6', fromAt: T0, toAt: T0 + 5 * HOUR });
    add('a1', { baseSku: '378;6', fromAt: T0 + HOUR, toAt: T0 + 2 * HOUR });
    add('a0', { baseSku: '378;6', fromAt: T0, toAt: T0 + 3 * HOUR });
    add('old', { baseSku: '378;6', fromAt: T0 - 10 * HOUR, toAt: T0 - 5 * HOUR });
    add('c1', { baseSku: '30469;6', fromAt: T0 + 2 * HOUR, toAt: T0 + 4 * HOUR, revKeys: 1, revMetalScrap: 9, keyScrap: 560 });
    add('a2', { baseSku: '378;6', fromAt: T0 + HOUR, toAt: T0 + HOUR });
    return { r, ids };
  }
  /** The seeded names of the rows read, in read order. */
  const order = (rows: HoldingMark[], ids: Record<string, number>): string[] => {
    const name = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
    return rows.map((m) => name.get(m.id) ?? `?${m.id}`);
  };

  it('reads runs with to_at at or after the time, of every base, ordered by base, start and id', () => {
    const { r, ids } = seeded();
    const rows = r.holdingMarksSince(T0);
    expect(order(rows, ids)).toEqual(['c1', 'a0', 'a1', 'a2', 'b1']);
    // A run ending exactly at the cut is in; the one that ended before it is not.
    expect(order(r.holdingMarksSince(T0 + 2 * HOUR), ids)).toEqual(['c1', 'a0', 'a1', 'b1']);
    // The rows read back whole.
    expect(rows.find((m) => m.id === ids['c1'])).toEqual({ id: ids['c1'], ...mark({ baseSku: '30469;6', fromAt: T0 + 2 * HOUR, toAt: T0 + 4 * HOUR, revKeys: 1, revMetalScrap: 9, keyScrap: 560 }) });
  });

  it('keeps the newest `limit` by to_at, then orders them by base', () => {
    const { r, ids } = seeded();
    // Newest by to_at: b1 (5 h), c1 (4 h), a0 (3 h).
    expect(order(r.holdingMarksSince(T0 - 100 * HOUR, 3), ids)).toEqual(['c1', 'a0', 'b1']);
    expect(order(r.holdingMarksSince(T0 - 100 * HOUR, 1), ids)).toEqual(['b1']);
  });

  it('clamps the limit: at least 1, whole, at most RESERVE_MAX_MARKS (the default)', () => {
    const { r } = seeded();
    expect(r.holdingMarksSince(T0 - 100 * HOUR, 0)).toHaveLength(1);
    expect(r.holdingMarksSince(T0 - 100 * HOUR, -5)).toHaveLength(1);
    expect(r.holdingMarksSince(T0 - 100 * HOUR, 2.9)).toHaveLength(2);
    expect(r.holdingMarksSince(T0 - 100 * HOUR, Number.NaN)).toHaveLength(6);
    expect(r.holdingMarksSince(T0 - 100 * HOUR, 10 * RESERVE_MAX_MARKS)).toHaveLength(6);
    expect(r.holdingMarksSince(T0 - 100 * HOUR)).toHaveLength(6);
    expect(RESERVE_MAX_MARKS).toBe(50_000);
  });

  it('reads nothing on an empty table or past every run', () => {
    expect(repo().holdingMarksSince(0)).toEqual([]);
    const { r } = seeded();
    expect(r.holdingMarksSince(T0 + 6 * HOUR)).toEqual([]);
  });
});
