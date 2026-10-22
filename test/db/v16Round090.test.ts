// 0.9.0: migration V16, the release's one migration (PLAN_090 B.1, D1). Nullable columns (exits' impersonation flag,
// ranking's three keys, scraptf's bank notice and price-drop wording) and three new tables with their indexes
// (history's order spells, recorded community prices and scrap.tf lows). No row is read or rewritten: a file database
// at V15 holding 0.8 rows, as the user's, reads back exactly as before with the new columns NULL.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import { MIGRATIONS, SCHEMA_VERSION, migrate, userVersion } from '../../src/service/db/migrations';
import { tempDir } from './helpers';

const T0 = 1_792_496_380_093;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function v15(): { db: DatabaseSync; file: string } {
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
  migrate(db, MIGRATIONS.slice(0, 15));
  return { db, file };
}

const all = (db: DatabaseSync, sql: string): Record<string, unknown>[] => db.prepare(sql).all().map((r) => ({ ...r }));
const plan = (db: DatabaseSync, sql: string, ...params: (string | number)[]): string =>
  db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => String(r['detail']))
    .join(' | ');
type Col = [name: unknown, type: unknown, notnull: unknown, dflt: unknown, pk: unknown];
const cols = (db: DatabaseSync, table: string): Col[] => all(db, `PRAGMA table_info(${table})`).map((c) => [c['name'], c['type'], c['notnull'], c['dflt_value'], c['pk']]);

/** 0.8 rows of every table V16 widens: a listing, an opportunity, an import batch, its bank stock save, a journal row. */
function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO listings (id, sku, base_sku, intent, steamid, user_name, keys, metal_scrap, is_bot, ua_client, ua_last_pulse, user_online, user_banned, is_marketplace, special, details, listed_at, bumped_at, last_event_at, origin, item_name, market_name)
     VALUES ('440_76561198000000001_abc', '378;6', '378;6', 'buy', '76561198000000001', 'buyer', 0, 99, 1, 'TF2Autobot', 1792496000, 1, 0, 0, NULL, 'buying', 1792490000, 1792495000, ?, 'ws', 'Team Captain', NULL)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO opportunities (key, sku, name, category, input_ref, input_kind, cost_keys, cost_scrap_raw, cost_scrap, best_scrap, cons_scrap, instant_scrap, revenue_scrap, profit_scrap, margin, confidence, confidence_level, flags, reasons, buyer_count, best_order, cons_order, instant_order, refs, profit_tier, status, input_observed_at, first_seen_at, updated_at, max_cost_scrap)
     VALUES ('378;6|price:1', '378;6', 'Team Captain', 'hats', 'price:1', 'user', 0, 80, 80, 99, 99, NULL, 99, 19, 0.2375, 70, 'high', '[]', '[]', 3, NULL, NULL, NULL, '{"pricedb":null,"community":null}', 'ref2', 'profitable', ?, ?, ?, 90)`,
  ).run(T0, T0, T0);
  db.prepare(
    "INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, categories, bank, origin) VALUES (7, 'scrap.tf - Buy Hats.html', 'buy', ?, ?, 1, '{\"hats\":1}', 'hats', 'file')",
  ).run(T0, T0);
  db.prepare(
    "INSERT INTO bank_stock (batch_id, bank, sku, special_key, name, cost_keys, cost_scrap, stock, asset_id, page, craft) VALUES (7, 'hats', '378;6', '', 'Team Captain', 0, 80, 1, '123', '/buy/hats', NULL)",
  ).run();
  db.prepare("INSERT INTO bank_stock_saves (batch_id, bank, page, items) VALUES (7, 'hats', '/buy/hats', 1)").run();
  db.prepare(
    "INSERT INTO journal (ts, side, venue, sku, name, keys, scrap, key_price_scrap, note, fee_keys, fee_scrap) VALUES (?, 'buy', 'scrap.tf', '378;6', 'Team Captain', 0, 80, 540, NULL, NULL, 2)",
  ).run(T0);
}

const WIDENED = ['listings', 'opportunities', 'import_batches', 'bank_stock', 'bank_stock_saves', 'journal'] as const;
const NEW_NULLS: Record<(typeof WIDENED)[number], Record<string, null>> = {
  listings: { user_impersonated: null },
  opportunities: { backup_profit_scrap: null, profitable_depth: null, book_depth: null },
  import_batches: { bank_notice: null },
  bank_stock: { markdown: null },
  bank_stock_saves: {},
  journal: {},
};

describe('migration V16 (0.9.0)', () => {
  it('is migration 16, the newest', () => {
    expect(MIGRATIONS[15]).toMatchObject({ version: 16, name: 'impersonators, ranking keys, order persistence, community history, scrap.tf lows and notices' });
    expect(SCHEMA_VERSION).toBe(16);
    expect(MIGRATIONS).toHaveLength(16);
  });

  it('applies once on a V15 database', () => {
    const { db } = v15();
    seed(db);
    expect(migrate(db).applied).toEqual([16]);
    expect(userVersion(db)).toBe(16);
    expect(migrate(db).applied).toEqual([]);
    expect(migrate(db)).toEqual({ from: 16, to: 16, applied: [] });
  });

  it('adds only nullable columns with no default to the 0.8 tables', () => {
    const { db } = v15();
    const before = Object.fromEntries(WIDENED.map((t) => [t, cols(db, t)]));
    migrate(db);
    const find = (table: string, name: string) => cols(db, table).find((c) => c[0] === name);
    expect(find('listings', 'user_impersonated')).toEqual(['user_impersonated', 'INTEGER', 0, null, 0]);
    expect(find('opportunities', 'backup_profit_scrap')).toEqual(['backup_profit_scrap', 'INTEGER', 0, null, 0]);
    expect(find('opportunities', 'profitable_depth')).toEqual(['profitable_depth', 'INTEGER', 0, null, 0]);
    expect(find('opportunities', 'book_depth')).toEqual(['book_depth', 'INTEGER', 0, null, 0]);
    expect(find('import_batches', 'bank_notice')).toEqual(['bank_notice', 'TEXT', 0, null, 0]);
    expect(find('bank_stock', 'markdown')).toEqual(['markdown', 'TEXT', 0, null, 0]);
    // Appended after every 0.8 column; nothing else changed.
    for (const t of WIDENED) {
      const added = Object.keys(NEW_NULLS[t]);
      expect(cols(db, t).map((c) => c[0])).toEqual([...before[t]!.map((c) => c[0]), ...added]);
      expect(cols(db, t).slice(0, before[t]!.length)).toEqual(before[t]);
    }
  });

  it('creates the three history tables exactly as specified', () => {
    const { db } = v15();
    migrate(db);
    expect(cols(db, 'order_spells')).toEqual([
      ['id', 'INTEGER', 0, null, 1],
      ['base_sku', 'TEXT', 1, null, 0],
      ['intent', 'TEXT', 1, null, 0],
      ['is_bot', 'INTEGER', 1, '0', 0],
      ['keys', 'REAL', 1, '0', 0],
      ['metal_scrap', 'INTEGER', 1, '0', 0],
      ['listed_at', 'INTEGER', 0, null, 0],
      ['first_seen_at', 'INTEGER', 1, null, 0],
      ['last_seen_at', 'INTEGER', 1, null, 0],
      ['end_at', 'INTEGER', 0, null, 0],
      ['end_kind', 'TEXT', 0, null, 0],
    ]);
    expect(cols(db, 'bptf_community_history')).toEqual([
      ['id', 'INTEGER', 0, null, 1],
      ['sku', 'TEXT', 1, null, 0],
      ['source', 'TEXT', 1, null, 0],
      ['currency', 'TEXT', 1, null, 0],
      ['value', 'REAL', 1, null, 0],
      ['value_high', 'REAL', 0, null, 0],
      ['last_update', 'INTEGER', 0, null, 0],
      ['recorded_at', 'INTEGER', 1, null, 0],
    ]);
    expect(cols(db, 'scraptf_lows')).toEqual([
      ['bank', 'TEXT', 1, null, 1],
      ['sku', 'TEXT', 1, null, 2],
      ['special_key', 'TEXT', 1, "''", 3],
      ['low_keys', 'REAL', 1, '0', 0],
      ['low_scrap', 'INTEGER', 1, null, 0],
      ['first_at', 'INTEGER', 1, null, 0],
      ['last_at', 'INTEGER', 1, null, 0],
      ['since_at', 'INTEGER', 1, null, 0],
      ['seen_at', 'INTEGER', 1, null, 0],
    ]);
    // Order persistence, never a trader: no SteamID, listing id, user, name, trade or listing text is stored.
    for (const t of ['order_spells', 'bptf_community_history', 'scraptf_lows']) {
      for (const [name] of cols(db, t)) expect(String(name)).not.toMatch(/steam|listing|user|name|trade|detail/);
    }
  });

  it('creates the six indexes by name, the partial and the expression index included', () => {
    const { db } = v15();
    migrate(db);
    const names = all(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('order_spells', 'bptf_community_history', 'scraptf_lows') AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r['name']);
    expect(names).toEqual([
      'bptf_community_history_point',
      'bptf_community_history_recorded',
      'order_spells_base_first',
      'order_spells_first_seen',
      'order_spells_open',
      'scraptf_lows_seen',
    ]);
    const sql = (name: string) => String(all(db, `SELECT sql FROM sqlite_master WHERE name = '${name}'`)[0]!['sql']);
    expect(sql('order_spells_open')).toMatch(/WHERE end_kind IS NULL/);
    expect(sql('bptf_community_history_point')).toMatch(/UNIQUE INDEX/);
    expect(sql('bptf_community_history_point')).toMatch(/IFNULL\(value_high, -1\), IFNULL\(last_update, -1\)/);
  });

  it('serves the reads and writes the repo makes from the right indexes', () => {
    const { db } = v15();
    migrate(db);
    // The per-base spell read selects on entry (first_seen_at), never on the end (review 0.9).
    expect(
      plan(db, 'SELECT * FROM (SELECT * FROM order_spells WHERE base_sku IN (?, ?) AND first_seen_at >= ? ORDER BY first_seen_at DESC, id DESC LIMIT ?) ORDER BY first_seen_at, id', 'a', 'b', 0, 10),
    ).toMatch(/order_spells_base_first/);
    // Both updates of every followed spell walk the partial index of open rows only.
    expect(plan(db, 'UPDATE order_spells SET last_seen_at = MAX(last_seen_at, ?) WHERE end_kind IS NULL', 1)).toMatch(/order_spells_open/);
    expect(plan(db, "UPDATE order_spells SET end_kind = 'unwatched', end_at = last_seen_at WHERE end_kind IS NULL")).toMatch(/order_spells_open/);
    expect(
      plan(db, 'SELECT * FROM (SELECT * FROM bptf_community_history WHERE sku IN (?, ?) ORDER BY recorded_at DESC, id DESC LIMIT ?) ORDER BY recorded_at, id', 'a', 'b', 10),
    ).toMatch(/bptf_community_history_point/);
  });

  it('keeps one community point per distinct price per SKU and source, NULLs folded (INSERT OR IGNORE)', () => {
    const { db } = v15();
    migrate(db);
    const ins = db.prepare('INSERT OR IGNORE INTO bptf_community_history (sku, source, currency, value, value_high, last_update, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    expect(Number(ins.run('378;6', 'prices', 'metal', 1.33, null, null, T0).changes)).toBe(1);
    expect(Number(ins.run('378;6', 'prices', 'metal', 1.33, null, null, T0 + 1).changes)).toBe(0);
    expect(Number(ins.run('378;6', 'feed', 'metal', 1.33, null, null, T0 + 2).changes)).toBe(1);
    expect(Number(ins.run('378;6', 'prices', 'metal', 1.33, 1.44, null, T0 + 3).changes)).toBe(1);
    expect(Number(ins.run('378;6', 'prices', 'metal', 1.33, 1.44, null, T0 + 4).changes)).toBe(0);
  });

  it('reads or rewrites no 0.8 row: every one reads back as it was, the new columns NULL', () => {
    const { db, file } = v15();
    seed(db);
    const before = Object.fromEntries(WIDENED.map((t) => [t, all(db, `SELECT * FROM ${t} ORDER BY rowid`)]));
    migrate(db);
    for (const t of WIDENED) {
      expect(all(db, `SELECT * FROM ${t} ORDER BY rowid`)).toEqual(before[t]!.map((r) => ({ ...r, ...NEW_NULLS[t] })));
    }
    for (const t of ['order_spells', 'bptf_community_history', 'scraptf_lows']) expect(all(db, `SELECT COUNT(*) AS n FROM ${t}`)).toEqual([{ n: 0 }]);
    db.close();
    // The repo reads the old listing with no impersonation key (NULL is "not flagged or not known").
    const repo = openRepo(file);
    cleanups.push(() => repo.close());
    const listing = repo.getListing('440_76561198000000001_abc');
    expect(listing).toMatchObject({ id: '440_76561198000000001_abc', sku: '378;6', intent: 'buy', userBanned: false });
    expect(listing).not.toHaveProperty('userImpersonated');
  });
});
