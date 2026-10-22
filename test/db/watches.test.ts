// 0.8 (G1, G3): the user's scrap.tf watches (scraptf_watches, schema V15). One watch per copy: a bank_stock
// special key ('' a clean copy) or NULL for every copy of the base, kept unique by an expression index. The repo
// adds, updates in place and removes; it judges nothing (the watches rules are src/shared/watches.ts).

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { MIGRATIONS, migrate } from '../../src/service/db/migrations';
import { WATCH_COPY_TAKEN } from '../../src/shared/watches';
import type { ScraptfWatchWrite } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_792_496_380_093;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repo(): Repo {
  const r = openRepo(':memory:');
  cleanups.push(() => r.close());
  return r;
}

const write = (over: Partial<ScraptfWatchWrite> = {}): ScraptfWatchWrite => ({
  sku: '378;6',
  specialKey: '',
  name: 'Team Captain',
  maxCostKeys: 0,
  maxCostScrap: 300,
  minProfitScrap: null,
  onRestock: false,
  enabled: true,
  ...over,
});

const all = (db: DatabaseSync, sql: string): unknown[] => db.prepare(sql).all().map((r) => ({ ...r }));

describe('scraptf_watches (V15)', () => {
  it('is created by V15 on a V14 database, with the one-watch-per-copy index', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const db = new DatabaseSync(t.file());
    cleanups.push(() => db.close());
    migrate(db, MIGRATIONS.slice(0, 14));
    expect(all(db, "SELECT name FROM sqlite_master WHERE name = 'scraptf_watches'")).toEqual([]);
    expect(migrate(db).applied).toEqual([15]);
    expect(all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scraptf_watches'")).toEqual([{ name: 'scraptf_watches' }]);
    const index = all(db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'scraptf_watches_copy'") as { sql: string }[];
    expect(index).toHaveLength(1);
    expect(index[0]!.sql).toMatch(/UNIQUE INDEX/);
    expect(index[0]!.sql).toMatch(/IFNULL\(special_key, '\*'\)/);
  });
});

describe('Repo watches', () => {
  it('adds a watch, stamping both times, and updates it by id', () => {
    const r = repo();
    const w = r.upsertWatch(write(), T0);
    expect(w).toEqual({ id: 1, sku: '378;6', specialKey: '', name: 'Team Captain', maxCostKeys: 0, maxCostScrap: 300, minProfitScrap: null, onRestock: false, enabled: true, createdAt: T0, updatedAt: T0 });
    const edited = r.upsertWatch(write({ id: w.id, maxCostKeys: 1, maxCostScrap: 4.6, minProfitScrap: 18, onRestock: true, enabled: false }), T0 + 1000);
    expect(edited).toEqual({ ...w, maxCostKeys: 1, maxCostScrap: 5, minProfitScrap: 18, onRestock: true, enabled: false, updatedAt: T0 + 1000 });
    expect(r.getWatch(w.id)).toEqual(edited);
    expect(r.listWatches()).toEqual([edited]);
    expect(() => r.upsertWatch(write({ id: 99 }), T0)).toThrow(/Watch 99 not found/);
  });

  it('updates the watch of the same copy in place when no id is given', () => {
    const r = repo();
    const w = r.upsertWatch(write(), T0);
    const again = r.upsertWatch(write({ maxCostScrap: 250, name: 'Team Captain (again)' }), T0 + 5);
    expect(again.id).toBe(w.id);
    expect(again).toMatchObject({ maxCostScrap: 250, name: 'Team Captain (again)', createdAt: T0, updatedAt: T0 + 5 });
    expect(r.countWatches()).toBe(1);
    // Another copy of the same base is another watch.
    const painted = r.upsertWatch(write({ specialKey: '{"paint":15185211}' }), T0 + 6);
    expect(painted.id).not.toBe(w.id);
    expect(r.findWatch('378;6', '{"paint":15185211}')).toEqual(painted);
    expect(r.findWatch('378;6', '')).toEqual(again);
    expect(r.findWatch('378;6', null)).toBeNull();
    expect(r.countWatches()).toBe(2);
  });

  it('keeps one any-copy watch (special key NULL) per base', () => {
    const r = repo();
    const any = r.upsertWatch(write({ specialKey: null }), T0);
    expect(any.specialKey).toBeNull();
    const same = r.upsertWatch(write({ specialKey: null, maxCostScrap: null, minProfitScrap: 9 }), T0 + 1);
    expect(same.id).toBe(any.id);
    expect(same).toMatchObject({ specialKey: null, maxCostScrap: null, minProfitScrap: 9 });
    expect(r.findWatch('378;6', null)).toEqual(same);
    // Another base has its own.
    expect(r.upsertWatch(write({ sku: '5021;6', specialKey: null }), T0 + 2).id).not.toBe(any.id);
    expect(r.countWatches()).toBe(2);
  });

  it("refuses an update onto another watch's copy", () => {
    const r = repo();
    const clean = r.upsertWatch(write(), T0);
    const any = r.upsertWatch(write({ specialKey: null }), T0);
    expect(() => r.upsertWatch(write({ id: any.id, specialKey: '' }), T0 + 1)).toThrow(WATCH_COPY_TAKEN);
    // Nothing changed.
    expect(r.getWatch(any.id)).toEqual(any);
    expect(r.getWatch(clean.id)).toEqual(clean);
    // Moving a watch to a free copy is an update.
    expect(r.upsertWatch(write({ id: any.id, sku: '5021;6', specialKey: null }), T0 + 2)).toMatchObject({ id: any.id, sku: '5021;6' });
  });

  it('deletes and counts, and never reuses an id (AUTOINCREMENT)', () => {
    const r = repo();
    const a = r.upsertWatch(write(), T0);
    const b = r.upsertWatch(write({ sku: '5021;6' }), T0);
    expect(r.countWatches()).toBe(2);
    r.deleteWatch(b.id);
    expect(r.countWatches()).toBe(1);
    expect(r.getWatch(b.id)).toBeNull();
    r.deleteWatch(9999);
    expect(r.countWatches()).toBe(1);
    const c = r.upsertWatch(write({ sku: '199;6' }), T0);
    expect(c.id).toBeGreaterThan(b.id);
    expect(r.listWatches().map((w) => w.id)).toEqual([a.id, c.id]);
  });

  it('leaves remind_at NULL (reserved for T9)', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = t.file();
    const r = openRepo(file);
    r.upsertWatch(write(), T0);
    r.upsertWatch(write({ maxCostScrap: 200 }), T0 + 1);
    r.close();
    const db = new DatabaseSync(file);
    cleanups.push(() => db.close());
    expect(all(db, 'SELECT remind_at FROM scraptf_watches')).toEqual([{ remind_at: null }]);
  });

  it('throws TypeError on a bad sku or number', () => {
    const r = repo();
    expect(() => r.upsertWatch(write({ sku: '' }), T0)).toThrow(TypeError);
    expect(() => r.upsertWatch(write(), Number.NaN)).toThrow(TypeError);
    expect(() => r.upsertWatch(write({ maxCostKeys: -1 }), T0)).toThrow(TypeError);
    expect(() => r.upsertWatch(write({ maxCostKeys: Number.POSITIVE_INFINITY }), T0)).toThrow(TypeError);
    expect(() => r.upsertWatch(write({ maxCostScrap: -5 }), T0)).toThrow(TypeError);
    expect(() => r.upsertWatch(write({ minProfitScrap: Number.NaN }), T0)).toThrow(TypeError);
    expect(() => r.upsertWatch(write({ specialKey: 7 as unknown as string }), T0)).toThrow(TypeError);
    expect(() => r.upsertWatch(write({ id: 1.5 }), T0)).toThrow(TypeError);
    expect(r.countWatches()).toBe(0);
  });

  it("refuses the index's every-copy stand-in '*' as a copy, leaving the any-copy watch as it was", () => {
    const r = repo();
    const any = r.upsertWatch(write({ specialKey: null, maxCostScrap: 90, onRestock: true }), T0);
    // '*' would find the any-copy watch as "the same copy" (IFNULL(special_key, '*')) and overwrite it.
    expect(() => r.upsertWatch(write({ specialKey: '*', maxCostScrap: null, minProfitScrap: 9 }), T0 + 1)).toThrow(TypeError);
    expect(() => r.upsertWatch(write({ id: any.id, specialKey: '*' }), T0 + 1)).toThrow(TypeError);
    expect(r.listWatches()).toEqual([any]);
  });
});
