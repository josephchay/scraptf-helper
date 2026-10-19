import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { chunk, escapeLike, isMemoryPath, openDatabase, placeholders } from '../../src/service/db/db';
import type { SqliteDb } from '../../src/service/db/db';
import { openRepo, SCHEMA_VERSION, SchemaVersionError } from '../../src/service/db';
import { MIGRATIONS, migrate, userVersion, validateMigrations } from '../../src/service/db/migrations';
import type { Migration } from '../../src/service/db/migrations';
import type { Repo } from '../../src/service/contracts';
import { makeListing, tempDir } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmp() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t;
}

function track<T extends { close(): void }>(x: T): T {
  cleanups.push(() => x.close());
  return x;
}

describe('openDatabase', () => {
  it('applies the connection PRAGMAs to a file database', () => {
    const t = tmp();
    const db = track(openDatabase(t.file()));
    expect(db.isMemory).toBe(false);
    expect(db.pragmaText('journal_mode')).toBe('wal');
    expect(db.pragmaNumber('synchronous')).toBe(1); // NORMAL
    expect(db.pragmaNumber('foreign_keys')).toBe(1);
    expect(db.pragmaNumber('busy_timeout')).toBe(5000);
    expect(db.pragmaNumber('temp_store')).toBe(2); // MEMORY
  });

  it('skips WAL for in-memory databases', () => {
    const db = track(openDatabase(':memory:'));
    expect(db.isMemory).toBe(true);
    expect(db.pragmaText('journal_mode')).toBe('memory');
    expect(db.pragmaNumber('foreign_keys')).toBe(1);
  });

  it('creates missing parent directories', () => {
    const t = tmp();
    const path = `${t.dir}/nested/deeper/app.sqlite`;
    const db = track(openDatabase(path));
    db.exec('CREATE TABLE x (a)');
    expect(existsSync(path)).toBe(true);
  });

  it('caches prepared statements', () => {
    const db = track(openDatabase(':memory:'));
    expect(db.prepare('SELECT 1 AS a')).toBe(db.prepare('SELECT 1 AS a'));
  });

  it('evicts the least recently used statement past the cache size', () => {
    const db = track(openDatabase(':memory:', { statementCacheSize: 16 }));
    const first = db.prepare('SELECT 0 AS a');
    for (let i = 1; i <= 16; i++) db.prepare(`SELECT ${i} AS a`);
    expect(db.prepare('SELECT 0 AS a')).not.toBe(first);
  });

  it('close is idempotent', () => {
    const db = openDatabase(':memory:');
    db.close();
    expect(db.isOpen()).toBe(false);
    expect(() => db.close()).not.toThrow();
  });

  it('recognises memory paths', () => {
    expect(isMemoryPath(':memory:')).toBe(true);
    expect(isMemoryPath('')).toBe(true);
    expect(isMemoryPath('file::memory:?cache=shared')).toBe(true);
    expect(isMemoryPath('C:/data/app.sqlite')).toBe(false);
  });
});

describe('transactions', () => {
  let db: SqliteDb;
  const count = () => Number(db.prepare('SELECT COUNT(*) AS n FROM t').get()!['n']);

  function setup() {
    db = track(openDatabase(':memory:'));
    db.exec('CREATE TABLE t (v INTEGER)');
  }

  it('commits on success and returns the callback value', () => {
    setup();
    const out = db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run(1);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(count()).toBe(1);
    expect(db.inTransaction()).toBe(false);
  });

  it('rolls back everything when the outer callback throws', () => {
    setup();
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?)').run(1);
        db.transaction(() => db.prepare('INSERT INTO t VALUES (?)').run(2));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count()).toBe(0);
    expect(db.inTransaction()).toBe(false);
  });

  it('a failing nested transaction only undoes its own work', () => {
    setup();
    db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run(1);
      expect(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO t VALUES (?)').run(2);
          throw new Error('inner');
        }),
      ).toThrow('inner');
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?)').run(3);
        expect(() =>
          db.transaction(() => {
            db.prepare('INSERT INTO t VALUES (?)').run(4);
            throw new Error('deepest');
          }),
        ).toThrow('deepest');
      });
    });
    const vals = db
      .prepare('SELECT v FROM t ORDER BY v')
      .all()
      .map((r) => r['v']);
    expect(vals).toEqual([1, 3]);
  });

  it('is usable again after a rollback', () => {
    setup();
    expect(() =>
      db.transaction(() => {
        throw new Error('x');
      }),
    ).toThrow();
    db.transaction(() => db.prepare('INSERT INTO t VALUES (?)').run(9));
    expect(count()).toBe(1);
  });

  it('rejects async callbacks and rolls back', async () => {
    setup();
    expect(() =>
      db.transaction(async () => {
        db.prepare('INSERT INTO t VALUES (?)').run(1);
        await Promise.resolve();
      }),
    ).toThrow(/synchronous/);
    expect(count()).toBe(0);
    expect(db.inTransaction()).toBe(false);
  });

  it('rolls back on SQL errors inside the callback', () => {
    setup();
    db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY)');
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?)').run(1);
        db.prepare('INSERT INTO u VALUES (?)').run(1);
        db.prepare('INSERT INTO u VALUES (?)').run(1);
      }),
    ).toThrow(/UNIQUE/);
    expect(count()).toBe(0);
  });
});

describe('migrations', () => {
  it('are contiguous and non-empty', () => {
    expect(() => validateMigrations()).not.toThrow();
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('reject gaps', () => {
    const bad: Migration[] = [
      { version: 1, name: 'a', sql: 'SELECT 1' },
      { version: 3, name: 'c', sql: 'SELECT 1' },
    ];
    expect(() => validateMigrations(bad)).toThrow(/expected 2/);
  });

  it('set user_version and are idempotent when the file is opened twice', () => {
    const t = tmp();
    const path = t.file();
    const a = openRepo(path);
    a.setMeta('hello', 'world');
    a.upsertListings([makeListing({ id: 'x' })]);
    a.close();

    const b = track(openRepo(path));
    expect(b.getMeta('hello')).toBe('world');
    expect(b.getListing('x')?.id).toBe('x');

    const raw = track(new DatabaseSync(path));
    expect(userVersion(raw)).toBe(SCHEMA_VERSION);
    expect(migrate(raw)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [] });
  });

  it('applies only pending migrations, each atomically', () => {
    const raw = track(new DatabaseSync(':memory:'));
    const list: Migration[] = [
      { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER)' },
      { version: 2, name: 'two', sql: 'CREATE TABLE b (x INTEGER)' },
    ];
    expect(migrate(raw, list.slice(0, 1))).toEqual({ from: 0, to: 1, applied: [1] });
    expect(migrate(raw, list)).toEqual({ from: 1, to: 2, applied: [2] });

    const broken: Migration[] = [...list, { version: 3, name: 'bad', sql: 'CREATE TABLE c (x); THIS IS NOT SQL' }];
    expect(() => migrate(raw, broken)).toThrow();
    expect(userVersion(raw)).toBe(2);
    const c = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'c'").get();
    expect(c).toBeUndefined();
  });

  it('adds the pay-up-to column to a version 1 database without losing its rows (V2)', () => {
    const t = tmp();
    const path = t.file();
    const raw = new DatabaseSync(path);
    expect(migrate(raw, MIGRATIONS.slice(0, 1))).toEqual({ from: 0, to: 1, applied: [1] });
    raw
      .prepare(
        'INSERT INTO opportunities (key, sku, name, category, input_ref, input_kind, confidence_level, refs, profit_tier, status, input_observed_at, first_seen_at, updated_at) ' +
          "VALUES ('378;6|price:1', '378;6', 'Team Captain', 'hats', 'price:1', 'user', 'high', '{\"pricedb\":null,\"community\":null}', 'ref2', 'profitable', 1, 2, 3)",
      )
      .run();
    raw.close();

    const repo = track(openRepo(path));
    const old = repo.getOpportunity('378;6|price:1')!;
    expect(old).toMatchObject({ sku: '378;6', name: 'Team Captain', status: 'profitable', maxCostScrap: null });
    repo.upsertOpportunities([{ ...old, maxCostScrap: 99 }]);
    expect(repo.getOpportunity('378;6|price:1')!.maxCostScrap).toBe(99);

    const check = track(new DatabaseSync(path));
    expect(userVersion(check)).toBe(SCHEMA_VERSION);
    const cols = check
      .prepare('PRAGMA table_info(opportunities)')
      .all()
      .map((r) => r['name']);
    expect(cols).toContain('max_cost_scrap');
  });

  it('refuses a database written by a newer schema version', () => {
    const t = tmp();
    const path = t.file();
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    expect(() => openRepo(path)).toThrow(SchemaVersionError);
  });

  it('creates every table the repo needs', () => {
    const raw = track(new DatabaseSync(':memory:'));
    migrate(raw);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r['name']);
    expect(tables).toEqual(
      [
        'bank_stock',
        'bank_stock_saves',
        'bptf_community',
        'bptf_names',
        'effects',
        'import_batches',
        'journal',
        'key_prices',
        'listings',
        'meta',
        'opportunities',
        'opportunity_events',
        'paintkits',
        'paints',
        'price_rules',
        'pricedb_prices',
        'request_log',
        'schema_items',
        'scrap_prices',
        'scraptf_events',
        'scraptf_list',
        'sku_aliases',
        'snapshot_times',
      ].sort(),
    );
    const idx = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'listings' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r['name']);
    expect(idx).toEqual(expect.arrayContaining(['listings_base_sku_intent', 'listings_last_event_at', 'listings_steamid']));
  });
});

describe('repo lifecycle', () => {
  let repo: Repo;

  it('reports a size for file and memory databases', () => {
    const t = tmp();
    repo = track(openRepo(t.file()));
    repo.upsertListings([makeListing()]);
    expect(repo.sizeBytes()).toBeGreaterThan(0);
    expect(repo.path).toBe(t.file());

    const mem = track(openRepo(':memory:'));
    expect(mem.path).toBe(':memory:');
    expect(mem.sizeBytes()).toBeGreaterThan(0);
    mem.close();
    expect(mem.sizeBytes()).toBe(0);
  });

  it('exposes nested transactions through the repo', () => {
    repo = track(openRepo(':memory:'));
    repo.transaction(() => {
      repo.setMeta('a', '1');
      expect(() =>
        repo.transaction(() => {
          repo.setMeta('b', '2');
          repo.upsertListings([makeListing({ id: 'inner' })]);
          throw new Error('nope');
        }),
      ).toThrow('nope');
    });
    expect(repo.getMeta('a')).toBe('1');
    expect(repo.getMeta('b')).toBeNull();
    expect(repo.getListing('inner')).toBeNull();
  });
});

describe('sql helpers', () => {
  it('chunks lists', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk(Array.from({ length: 1001 }, (_, i) => i)).map((c) => c.length)).toEqual([500, 500, 1]);
  });

  it('builds placeholders', () => {
    expect(placeholders(3)).toBe('?, ?, ?');
    expect(placeholders(0)).toBe('');
  });

  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});
