// F14: the saved scrap.tf/items price list store (migration V4 and the repo methods).
// Only pages the user saved fill this table; nothing here touches the network.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { SCHEMA_VERSION, openRepo } from '../../src/service/db';
import { MIGRATIONS, migrate, userVersion } from '../../src/service/db/migrations';
import type { ScraptfListStored } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_791_958_000_000;
const MIN = 60_000;

function row(over: Partial<ScraptfListStored> & { sku: string }): ScraptfListStored {
  return {
    name: 'Team Captain',
    sellsKeys: 0,
    sellsScrap: 28,
    paysKeys: 0,
    paysScrap: 24,
    stock: 2,
    stockLimit: 6,
    batchId: 1,
    observedAt: T0,
    ...over,
  };
}

let repo: Repo;
beforeEach(() => {
  repo = openRepo(':memory:');
});
afterEach(() => {
  repo.close();
});

describe('scraptf_list (V4)', () => {
  it('starts empty', () => {
    expect(repo.scraptfList()).toEqual([]);
    expect(repo.scraptfListRow('378;6')).toBeNull();
    expect(repo.scraptfListSummary()).toEqual({ items: 0, newestAt: null, oldestAt: null, batches: 0 });
  });

  it('round-trips rows, including null pays, stock and limit', () => {
    expect(
      repo.upsertScraptfList([
        row({ sku: '378;6' }),
        row({ sku: '5021;6', name: 'Mann Co. Supply Crate Key', sellsScrap: 543, paysScrap: 531, stock: 140, stockLimit: 140 }),
        row({ sku: '30177;6', name: 'Hong Kong Cone', sellsKeys: 14, sellsScrap: 9, paysKeys: null, paysScrap: null, stock: null, stockLimit: null }),
      ]),
    ).toBe(3);
    expect(repo.scraptfListRow('378;6')).toEqual(row({ sku: '378;6' }));
    expect(repo.scraptfListRow('30177;6')).toEqual(
      row({ sku: '30177;6', name: 'Hong Kong Cone', sellsKeys: 14, sellsScrap: 9, paysKeys: null, paysScrap: null, stock: null, stockLimit: null }),
    );
    expect(repo.scraptfList().map((r) => r.sku)).toEqual(['30177;6', '378;6', '5021;6']);
  });

  it('replaces a row only with one observed at the same time or later', () => {
    repo.upsertScraptfList([row({ sku: '378;6', sellsScrap: 28, observedAt: T0 })]);
    // An older saved file imported later (a catch-up scan, a copy) never wins.
    expect(repo.upsertScraptfList([row({ sku: '378;6', sellsScrap: 20, observedAt: T0 - MIN })])).toBe(0);
    expect(repo.scraptfListRow('378;6')!.sellsScrap).toBe(28);
    // A re-save of the same file replaces.
    expect(repo.upsertScraptfList([row({ sku: '378;6', sellsScrap: 27, batchId: 2, observedAt: T0 })])).toBe(1);
    expect(repo.scraptfListRow('378;6')).toMatchObject({ sellsScrap: 27, batchId: 2 });
    // A newer list replaces every field, nulls included.
    expect(repo.upsertScraptfList([row({ sku: '378;6', sellsScrap: 30, paysKeys: null, paysScrap: null, stock: null, stockLimit: null, batchId: 3, observedAt: T0 + MIN })])).toBe(1);
    expect(repo.scraptfListRow('378;6')).toMatchObject({ sellsScrap: 30, paysKeys: null, paysScrap: null, stock: null, stockLimit: null, batchId: 3, observedAt: T0 + MIN });
  });

  it('writes in one transaction and counts only the rows written', () => {
    repo.upsertScraptfList([row({ sku: 'a;6', observedAt: T0 + MIN })]);
    const n = repo.upsertScraptfList([row({ sku: 'a;6', observedAt: T0 }), row({ sku: 'b;6' }), row({ sku: 'c;6' })]);
    expect(n).toBe(2);
    expect(repo.scraptfListSummary().items).toBe(3);
  });

  it('skips rows without a SKU, any price or a finite time instead of failing the import', () => {
    const bad = [
      row({ sku: '' }),
      { ...row({ sku: 'x;6' }), sku: null as unknown as string },
      row({ sku: 'none;6', sellsScrap: Number.NaN, paysScrap: null }),
      row({ sku: 'time;6', observedAt: Number.POSITIVE_INFINITY }),
    ];
    expect(repo.upsertScraptfList([...bad, row({ sku: 'ok;6' })])).toBe(1);
    expect(repo.scraptfList().map((r) => r.sku)).toEqual(['ok;6']);
    expect(repo.upsertScraptfList([])).toBe(0);
  });

  it('keeps a "Sold out" row without a price to buy: scrap.tf still pays for it', () => {
    expect(repo.upsertScraptfList([row({ sku: '31193;6', sellsKeys: 1, sellsScrap: null, paysScrap: 12, stock: 0, stockLimit: 5 })])).toBe(1);
    expect(repo.scraptfListRow('31193;6')).toMatchObject({ sellsKeys: null, sellsScrap: null, paysScrap: 12, stock: 0, stockLimit: 5 });
    repo.upsertScraptfList([row({ sku: 'nan;6', sellsScrap: Number.NaN, paysScrap: 3 })]);
    expect(repo.scraptfListRow('nan;6')).toMatchObject({ sellsScrap: null, paysScrap: 3 });
  });

  it('stores integer scrap and whole counts', () => {
    repo.upsertScraptfList([row({ sku: '378;6', sellsScrap: 27.6, paysScrap: 23.4, stock: 2.9, stockLimit: -1 })]);
    expect(repo.scraptfListRow('378;6')).toMatchObject({ sellsScrap: 28, paysScrap: 23, stock: 2, stockLimit: null });
  });

  it('drops the pays keys when there is no pays price', () => {
    repo.upsertScraptfList([row({ sku: '378;6', paysKeys: 1, paysScrap: null })]);
    expect(repo.scraptfListRow('378;6')).toMatchObject({ paysKeys: null, paysScrap: null });
  });

  it('summarises rows, ages and the saved pages behind them', () => {
    repo.upsertScraptfList([
      row({ sku: 'a;6', batchId: 4, observedAt: T0 - 10 * MIN }),
      row({ sku: 'b;6', batchId: 4, observedAt: T0 - 10 * MIN }),
      row({ sku: 'c;6', batchId: 5, observedAt: T0 - 2 * MIN }),
    ]);
    expect(repo.scraptfListSummary()).toEqual({ items: 3, newestAt: T0 - 2 * MIN, oldestAt: T0 - 10 * MIN, batches: 2 });
  });

  it('purges rows observed before a time (retention)', () => {
    repo.upsertScraptfList([row({ sku: 'old;6', observedAt: T0 - 31 * 24 * 60 * MIN }), row({ sku: 'new;6', observedAt: T0 })]);
    expect(repo.purgeScraptfListOlderThan(T0 - 30 * 24 * 60 * MIN)).toBe(1);
    expect(repo.scraptfList().map((r) => r.sku)).toEqual(['new;6']);
  });
});

describe('migration V4', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('adds the list table to a version 3 database without touching its rows', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const raw = new DatabaseSync(path);
    expect(migrate(raw, MIGRATIONS.slice(0, 3))).toEqual({ from: 0, to: 3, applied: [1, 2, 3] });
    raw.prepare("INSERT INTO meta (key, value) VALUES ('kept', 'yes')").run();
    raw.close();

    const upgraded = openRepo(path);
    cleanups.push(() => upgraded.close());
    expect(upgraded.getMeta('kept')).toBe('yes');
    expect(upgraded.scraptfList()).toEqual([]);
    upgraded.upsertScraptfList([row({ sku: '378;6' })]);
    expect(upgraded.scraptfListRow('378;6')?.sellsScrap).toBe(28);

    const check = new DatabaseSync(path);
    cleanups.push(() => check.close());
    // Later versions (V5, F15) apply on the same open.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    expect(userVersion(check)).toBe(SCHEMA_VERSION);
    const cols = check
      .prepare('PRAGMA table_info(scraptf_list)')
      .all()
      .map((r) => r['name']);
    expect(cols).toEqual(['sku', 'name', 'sells_keys', 'sells_scrap', 'pays_keys', 'pays_scrap', 'stock', 'stock_limit', 'batch_id', 'observed_at']);
  });
});
