// 0.8.0: migration V15, the release's one migration. For the journal (J2, J6) it adds two nullable fee columns:
// every row written before V15 never recorded a fee, so NULL in both is "not recorded" and such a row reads back
// with no fee fields at all, booking exactly as before. 'writeoff' is a new side (TEXT, no change). A file database
// at V14 holding journal rows, as the user's.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import { MIGRATIONS, SCHEMA_VERSION, migrate, userVersion } from '../../src/service/db/migrations';
import { journalSummary } from '../../src/service/domain/journal';
import type { JournalEntry } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_792_496_380_093;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function v14(): { db: DatabaseSync; file: string } {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const file = t.file();
  const db = new DatabaseSync(file);
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      // closed by the test already
    }
  });
  migrate(db, MIGRATIONS.slice(0, 14));
  return { db, file };
}

const journalRow = (db: DatabaseSync, ts: number, side: string, sku: string, keys: number, scrap: number, keyPrice = 540): void => {
  db.prepare("INSERT INTO journal (ts, side, venue, sku, name, keys, scrap, key_price_scrap, note) VALUES (?, ?, 'scrap.tf', ?, 'x', ?, ?, ?, NULL)").run(ts, side, sku, keys, scrap, keyPrice);
};
const all = (db: DatabaseSync, sql: string): unknown[] => db.prepare(sql).all().map((r) => ({ ...r }));

/** A V14 journal in small: a closed pair, an open lot and a key-priced sale. */
function seed(db: DatabaseSync): void {
  journalRow(db, T0, 'buy', '378;6', 0, 90);
  journalRow(db, T0 + 1000, 'sell', '378;6', 0, 108);
  journalRow(db, T0 + 2000, 'buy', '5021;6', 1, 0, 567);
  journalRow(db, T0 + 3000, 'buy', '199;6', 0, 45);
  journalRow(db, T0 + 4000, 'sell', '5021;6', 1, 9, 576);
}

const entry = (over: Partial<Omit<JournalEntry, 'id'>> = {}): Omit<JournalEntry, 'id'> => ({
  ts: T0,
  side: 'buy',
  venue: 'scrap.tf',
  sku: '378;6',
  name: 'Team Captain',
  keys: 0,
  scrap: 90,
  keyPriceScrap: 540,
  note: null,
  ...over,
});

describe('migration V15: journal fees', () => {
  it('is migration 15', () => {
    expect(MIGRATIONS[14]).toMatchObject({ version: 15, name: 'journal fees, scrap.tf watches and recorded exit runs' });
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
  });

  it('adds fee_keys REAL and fee_scrap INTEGER, both nullable with no default, and rewrites no row', () => {
    const { db } = v14();
    seed(db);
    const before = all(db, 'SELECT * FROM journal ORDER BY id');
    expect(migrate(db, MIGRATIONS.slice(0, 15)).applied).toEqual([15]);
    expect(userVersion(db)).toBe(15);
    const cols = all(db, 'PRAGMA table_info(journal)') as { name: string; type: string; notnull: number; dflt_value: unknown }[];
    expect(cols.find((c) => c.name === 'fee_keys')).toMatchObject({ type: 'REAL', notnull: 0, dflt_value: null });
    expect(cols.find((c) => c.name === 'fee_scrap')).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
    // Every old row reads NULL in both (not recorded); every other column is as it was.
    expect(all(db, 'SELECT * FROM journal ORDER BY id')).toEqual((before as Record<string, unknown>[]).map((r) => ({ ...r, fee_keys: null, fee_scrap: null })));
  });

  it('reads old rows back without fee fields, and books them exactly as before', () => {
    const { db, file } = v14();
    seed(db);
    db.close();
    // The same rows as 0.7.4's repo read them: no fee keys at all.
    const legacy: JournalEntry[] = [
      { id: 1, ts: T0, side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'x', keys: 0, scrap: 90, keyPriceScrap: 540, note: null },
      { id: 2, ts: T0 + 1000, side: 'sell', venue: 'scrap.tf', sku: '378;6', name: 'x', keys: 0, scrap: 108, keyPriceScrap: 540, note: null },
      { id: 3, ts: T0 + 2000, side: 'buy', venue: 'scrap.tf', sku: '5021;6', name: 'x', keys: 1, scrap: 0, keyPriceScrap: 567, note: null },
      { id: 4, ts: T0 + 3000, side: 'buy', venue: 'scrap.tf', sku: '199;6', name: 'x', keys: 0, scrap: 45, keyPriceScrap: 540, note: null },
      { id: 5, ts: T0 + 4000, side: 'sell', venue: 'scrap.tf', sku: '5021;6', name: 'x', keys: 1, scrap: 9, keyPriceScrap: 576, note: null },
    ];
    const repo = openRepo(file);
    cleanups.push(() => repo.close());
    const rows = repo.listJournal();
    for (const r of rows) {
      expect(r).not.toHaveProperty('feeKeys');
      expect(r).not.toHaveProperty('feeScrap');
    }
    expect([...rows].sort((a, b) => a.id - b.id)).toEqual(legacy);
    expect(journalSummary(rows)).toEqual(journalSummary(legacy));
  });

  it('round-trips a fee, a recorded 0 and none (the keys then stay absent)', () => {
    const repo = openRepo(':memory:');
    cleanups.push(() => repo.close());
    const fee = repo.addJournal(entry({ feeKeys: 0.5, feeScrap: 3 }));
    expect(fee).toMatchObject({ feeKeys: 0.5, feeScrap: 3 });
    // Either part given records the fee; the other reads 0. Metal is whole scrap.
    expect(repo.addJournal(entry({ feeScrap: 2.6 }))).toMatchObject({ feeKeys: 0, feeScrap: 3 });
    const zero = repo.addJournal(entry({ feeKeys: 0, feeScrap: 0 }));
    expect(zero).toMatchObject({ feeKeys: 0, feeScrap: 0 });
    const none = repo.addJournal(entry());
    expect(none).not.toHaveProperty('feeKeys');
    expect(none).not.toHaveProperty('feeScrap');
    expect(repo.getJournal(fee.id)).toEqual(fee);
    expect(repo.getJournal(none.id)).toEqual(none);
    expect(() => repo.addJournal(entry({ feeScrap: -1 }))).toThrow(TypeError);
    expect(() => repo.addJournal(entry({ feeKeys: Number.NaN }))).toThrow(TypeError);
  });

  it("stores a 'writeoff' row and still refuses an unknown side", () => {
    const repo = openRepo(':memory:');
    cleanups.push(() => repo.close());
    const off = repo.addJournal(entry({ side: 'writeoff', scrap: 0 }));
    expect(off).toMatchObject({ side: 'writeoff', keys: 0, scrap: 0 });
    expect(off).not.toHaveProperty('feeKeys');
    expect(repo.getJournal(off.id)).toEqual(off);
    expect(() => repo.addJournal(entry({ side: 'hold' as JournalEntry['side'] }))).toThrow(TypeError);
  });

  it('getJournal reads one row; updateJournal changes only the columns given, null clears the fee, an unknown id is null', () => {
    const repo = openRepo(':memory:');
    cleanups.push(() => repo.close());
    const a = repo.addJournal(entry({ note: 'first', feeScrap: 4 }));
    const b = repo.addJournal(entry({ ts: T0 + 1, side: 'sell', scrap: 108 }));
    expect(repo.getJournal(a.id)).toEqual(a);
    expect(repo.getJournal(9999)).toBeNull();

    // Venue only: the note and the fee stay.
    expect(repo.updateJournal(a.id, { venue: 'backpack.tf' })).toEqual({ ...a, venue: 'backpack.tf' });
    // Note only, then a cleared note.
    expect(repo.updateJournal(a.id, { note: 'second' })).toMatchObject({ venue: 'backpack.tf', note: 'second', feeKeys: 0, feeScrap: 4 });
    expect(repo.updateJournal(a.id, { note: null })!.note).toBeNull();
    // A fee part sets both (the other 0); null in both clears it (not recorded).
    expect(repo.updateJournal(a.id, { feeKeys: 1 })).toMatchObject({ feeKeys: 1, feeScrap: 0 });
    const cleared = repo.updateJournal(a.id, { feeKeys: null, feeScrap: null })!;
    expect(cleared).not.toHaveProperty('feeKeys');
    expect(cleared).not.toHaveProperty('feeScrap');
    // Side, item, price and time never change, and the other row is untouched.
    expect(cleared).toMatchObject({ side: 'buy', sku: '378;6', keys: 0, scrap: 90, ts: T0, keyPriceScrap: 540 });
    expect(repo.getJournal(b.id)).toEqual(b);
    // An empty patch reads the row back; an unknown id returns null and writes nothing.
    expect(repo.updateJournal(b.id, {})).toEqual(b);
    expect(repo.updateJournal(9999, { venue: 'x', feeScrap: 1 })).toBeNull();
    expect(() => repo.updateJournal(a.id, { feeScrap: -2 })).toThrow(TypeError);
    expect(repo.listJournal()).toHaveLength(2);
  });

  it('is applied once', () => {
    const { db, file } = v14();
    seed(db);
    expect(migrate(db, MIGRATIONS.slice(0, 15)).applied).toEqual([15]);
    expect(migrate(db, MIGRATIONS.slice(0, 15)).applied).toEqual([]);
    db.close();
    const repo = openRepo(file);
    cleanups.push(() => repo.close());
    expect(repo.listJournal()).toHaveLength(5);
    const again = new DatabaseSync(file);
    cleanups.push(() => again.close());
    expect(migrate(again)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [] });
  });
});
