// Versioned schema migrations tracked with PRAGMA user_version. Each migration
// runs in its own transaction together with the user_version bump, so a crash
// mid-migration leaves the previous version intact. Append new versions only;
// never edit a migration that has shipped.

import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const V1_INITIAL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- backpack.tf order book. special is JSON SpecialAttrs; NULL means no extras.
CREATE TABLE IF NOT EXISTS listings (
  id             TEXT PRIMARY KEY NOT NULL,
  sku            TEXT NOT NULL,
  base_sku       TEXT NOT NULL,
  intent         TEXT NOT NULL,
  steamid        TEXT NOT NULL,
  user_name      TEXT,
  keys           REAL NOT NULL DEFAULT 0,
  metal_scrap    INTEGER NOT NULL DEFAULT 0,
  is_bot         INTEGER NOT NULL DEFAULT 0,
  ua_client      TEXT,
  ua_last_pulse  INTEGER,
  user_online    INTEGER,
  user_banned    INTEGER NOT NULL DEFAULT 0,
  is_marketplace INTEGER NOT NULL DEFAULT 0,
  special        TEXT,
  details        TEXT NOT NULL DEFAULT '',
  listed_at      INTEGER,
  bumped_at      INTEGER,
  last_event_at  INTEGER NOT NULL,
  origin         TEXT NOT NULL,
  item_name      TEXT,
  market_name    TEXT
);
CREATE INDEX IF NOT EXISTS listings_base_sku_intent ON listings(base_sku, intent);
CREATE INDEX IF NOT EXISTS listings_last_event_at ON listings(last_event_at);
CREATE INDEX IF NOT EXISTS listings_steamid ON listings(steamid);

CREATE TABLE IF NOT EXISTS bptf_names (
  sku         TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL,
  market_name TEXT,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bptf_names_name ON bptf_names(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sku_aliases (
  sku         TEXT PRIMARY KEY NOT NULL,
  pricedb_sku TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pricedb_prices (
  sku        TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL,
  buy_keys   REAL NOT NULL DEFAULT 0,
  buy_scrap  INTEGER NOT NULL DEFAULT 0,
  sell_keys  REAL NOT NULL DEFAULT 0,
  sell_scrap INTEGER NOT NULL DEFAULT 0,
  time       INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bptf_community (
  sku         TEXT PRIMARY KEY NOT NULL,
  currency    TEXT NOT NULL,
  value       REAL NOT NULL,
  value_high  REAL,
  last_update INTEGER
);

CREATE TABLE IF NOT EXISTS key_prices (
  source      TEXT PRIMARY KEY NOT NULL,
  buy_scrap   INTEGER,
  sell_scrap  INTEGER,
  observed_at INTEGER NOT NULL
);

-- AUTOINCREMENT: ids are referenced by opportunity keys ('price:<id>'), so never reuse them.
CREATE TABLE IF NOT EXISTS scrap_prices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sku          TEXT NOT NULL,
  name         TEXT NOT NULL,
  cost_keys    REAL NOT NULL DEFAULT 0,
  cost_scrap   INTEGER NOT NULL,
  source       TEXT NOT NULL,
  observed_at  INTEGER NOT NULL,
  note         TEXT,
  import_batch INTEGER,
  special      TEXT,
  asset_id     TEXT,
  stock        INTEGER
);
CREATE INDEX IF NOT EXISTS scrap_prices_sku ON scrap_prices(sku);
CREATE INDEX IF NOT EXISTS scrap_prices_import_batch ON scrap_prices(import_batch);

CREATE TABLE IF NOT EXISTS price_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  cost_keys   REAL NOT NULL DEFAULT 0,
  cost_scrap  INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS opportunities (
  key               TEXT PRIMARY KEY NOT NULL,
  sku               TEXT NOT NULL,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL,
  input_ref         TEXT NOT NULL,
  input_kind        TEXT NOT NULL,
  cost_keys         REAL NOT NULL DEFAULT 0,
  cost_scrap_raw    INTEGER NOT NULL DEFAULT 0,
  cost_scrap        INTEGER NOT NULL DEFAULT 0,
  best_scrap        INTEGER,
  cons_scrap        INTEGER,
  instant_scrap     INTEGER,
  revenue_scrap     INTEGER,
  profit_scrap      INTEGER,
  margin            REAL,
  confidence        REAL NOT NULL DEFAULT 0,
  confidence_level  TEXT NOT NULL,
  flags             TEXT NOT NULL DEFAULT '[]',
  reasons           TEXT NOT NULL DEFAULT '[]',
  buyer_count       INTEGER NOT NULL DEFAULT 0,
  best_order        TEXT,
  cons_order        TEXT,
  instant_order     TEXT,
  refs              TEXT NOT NULL,
  profit_tier       TEXT NOT NULL,
  status            TEXT NOT NULL,
  input_observed_at INTEGER NOT NULL,
  first_seen_at     INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS opportunities_sku ON opportunities(sku);
CREATE INDEX IF NOT EXISTS opportunities_status ON opportunities(status);

CREATE TABLE IF NOT EXISTS opportunity_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL,
  sku           TEXT NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  profit_scrap  INTEGER,
  cost_scrap    INTEGER,
  revenue_scrap INTEGER,
  confidence    REAL NOT NULL DEFAULT 0,
  summary       TEXT NOT NULL DEFAULT '',
  ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS opportunity_events_ts ON opportunity_events(ts);
CREATE INDEX IF NOT EXISTS opportunity_events_sku ON opportunity_events(sku, id);

CREATE TABLE IF NOT EXISTS journal (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  side            TEXT NOT NULL,
  venue           TEXT NOT NULL,
  sku             TEXT NOT NULL,
  name            TEXT NOT NULL,
  keys            REAL NOT NULL DEFAULT 0,
  scrap           INTEGER NOT NULL DEFAULT 0,
  key_price_scrap INTEGER NOT NULL DEFAULT 0,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS journal_ts ON journal(ts);

CREATE TABLE IF NOT EXISTS schema_items (
  defindex        INTEGER PRIMARY KEY NOT NULL,
  name            TEXT NOT NULL,
  item_name       TEXT NOT NULL,
  proper_name     INTEGER NOT NULL DEFAULT 0,
  item_class      TEXT NOT NULL,
  slot            TEXT,
  craft_class     TEXT,
  used_by_classes TEXT NOT NULL DEFAULT '[]',
  image_url       TEXT
);

CREATE TABLE IF NOT EXISTS effects (
  id           INTEGER PRIMARY KEY NOT NULL,
  name         TEXT NOT NULL,
  canonical_id INTEGER NOT NULL,
  type         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paints (
  decimal INTEGER PRIMARY KEY NOT NULL,
  hex     TEXT NOT NULL,
  name    TEXT NOT NULL,
  blu_hex TEXT
);

CREATE TABLE IF NOT EXISTS paintkits (
  id   INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name   TEXT NOT NULL,
  page_kind   TEXT NOT NULL,
  file_mtime  INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  item_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS request_log (
  id     INTEGER PRIMARY KEY,
  ts     INTEGER NOT NULL,
  host   TEXT NOT NULL,
  path   TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  ms     INTEGER NOT NULL,
  bytes  INTEGER NOT NULL,
  note   TEXT
);
CREATE INDEX IF NOT EXISTS request_log_ts ON request_log(ts);

CREATE TABLE IF NOT EXISTS snapshot_times (
  sku     TEXT PRIMARY KEY NOT NULL,
  last_at INTEGER NOT NULL
);
`;

// Feature F1: the "pay up to" ceiling per opportunity. Existing rows read NULL until the
// engine's start-up sweep re-evaluates them (the new value differs, so every row is rewritten).
const V2_MAX_COST = `
ALTER TABLE opportunities ADD COLUMN max_cost_scrap INTEGER;
`;

// Per-category item counts of a saved page, fixed at import time (ImportBatch.categories): later
// imports re-tag the rows they share, so the rows alone lose which page a batch was.
const V3_BATCH_CATEGORIES = `
ALTER TABLE import_batches ADD COLUMN categories TEXT;
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'initial schema', sql: V1_INITIAL },
  { version: 2, name: 'opportunity pay-up-to ceiling', sql: V2_MAX_COST },
  { version: 3, name: 'saved-page batch categories', sql: V3_BATCH_CATEGORIES },
]);

export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** The database was written by a newer build of the app; refusing to touch it avoids silent data loss. */
export class SchemaVersionError extends Error {
  override readonly name = 'SchemaVersionError';
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`Database schema version ${found} is newer than this app supports (${supported}). Update the app or use a different data folder.`);
  }
}

/** Throws when versions are not 1..n in order (guards against a bad edit of MIGRATIONS). */
export function validateMigrations(list: readonly Migration[] = MIGRATIONS): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration #${i} has version ${m.version}; expected ${i + 1}`);
    if (!m.sql.trim()) throw new Error(`Migration ${m.version} is empty`);
  });
}

export function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  const v = row ? row['user_version'] : 0;
  return typeof v === 'number' ? v : Number(v ?? 0) || 0;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
}

/** Applies every migration newer than the stored user_version. Safe to call on every open. */
export function migrate(db: DatabaseSync, list: readonly Migration[] = MIGRATIONS): MigrateResult {
  validateMigrations(list);
  const latest = list.length;
  const from = userVersion(db);
  if (from > latest) throw new SchemaVersionError(from, latest);

  const applied: number[] = [];
  for (const m of list) {
    if (m.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-check under the write lock: another connection may have migrated meanwhile.
      if (userVersion(db) >= m.version) {
        db.exec('COMMIT');
        continue;
      }
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      applied.push(m.version);
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  return { from, to: userVersion(db), applied };
}
