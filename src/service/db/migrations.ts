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

// F14: the user's saved copy of scrap.tf/items, one row per base SKU (newest saved list wins). Only
// pages the user saved with their own browser fill it (R10); nothing here was fetched (R1).
// sells_* are NULL for a "Sold out" row (no price to buy shown; scrap.tf still buys it), pays_* when
// the list showed no "Price we pay", stock/stock_limit when it showed no limit.
const V4_SCRAPTF_LIST = `
CREATE TABLE IF NOT EXISTS scraptf_list (
  sku         TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  sells_keys  REAL,
  sells_scrap INTEGER,
  pays_keys   REAL,
  pays_scrap  INTEGER,
  stock       INTEGER,
  stock_limit INTEGER,
  batch_id    INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scraptf_list_observed_at ON scraptf_list(observed_at);
`;

// F15: the scrap.tf page a saved batch came from (ScraptfBank), as the parser recognised it at import
// time. Older batches read NULL and are classified by their categories, as before.
const V5_BATCH_BANK = `
ALTER TABLE import_batches ADD COLUMN bank TEXT;
`;

// F17: what each saved bank page had in stock at that moment, one row per card or /items row with a
// SKU (sold out included), so two saves of a bank can be compared. Only pages the user saved fill it
// (R10); nothing here was fetched (R1). special_key is the import's extras key ('' = a clean copy), so
// painted and spelled copies stay separate rows. cost_* are NULL for a row with no price to buy. page
// is which page of the bank the save is ('/items/2'; ScrapTfParseResult.page), the same on every row of
// a batch: a save is only compared with an earlier save of the same page.
// Retention (from F20: bankStockThinning, every save of the last day, then hourly to 7 days and daily to
// 90 days, at most 300 per page) is Repo.pruneBankStock.
const V6_BANK_STOCK = `
CREATE TABLE IF NOT EXISTS bank_stock (
  batch_id    INTEGER NOT NULL,
  bank        TEXT NOT NULL,
  sku         TEXT NOT NULL,
  special_key TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  cost_keys   REAL,
  cost_scrap  INTEGER,
  stock       INTEGER NULL,
  asset_id    TEXT NULL,
  page        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (batch_id, sku, special_key)
);
CREATE INDEX IF NOT EXISTS bank_stock_bank_batch ON bank_stock(bank, batch_id);
`;

// F20: the change feed of the user's saves: one row per change between a page's save and the previous
// save of that page (scraptfEventsOf), written in the import's transaction. Prices are raw keys + metal
// (valued per read at the current key price); NULL where that side had none. Only pages the user saved
// fill it (R10); nothing was fetched (R1). Retention (90 days) is Repo.pruneScraptfEvents.
const V7_SCRAPTF_EVENTS = `
CREATE TABLE IF NOT EXISTS scraptf_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  bank        TEXT NOT NULL,
  page        TEXT NOT NULL DEFAULT '',
  sku         TEXT NOT NULL,
  special_key TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  from_keys   REAL,
  from_scrap  INTEGER,
  to_keys     REAL,
  to_scrap    INTEGER,
  from_stock  INTEGER,
  to_stock    INTEGER,
  batch_id    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scraptf_events_at ON scraptf_events(at);
CREATE INDEX IF NOT EXISTS scraptf_events_sku ON scraptf_events(sku);
CREATE INDEX IF NOT EXISTS scraptf_events_bank_at ON scraptf_events(bank, at);
`;

// F20 sizing. (1) The feed filtered by bank reads `bank = ? ORDER BY id DESC LIMIT ?`: on (bank, at)
// SQLite sorted that bank's every event to return a page; on (bank, id) it walks back and stops at the
// limit. (2) bank_stock_saves lists each save that has rows (bank, page, row count), kept with bank_stock
// in the same transactions (insertBankStock, pruneBankStock): the save index and the per-page reads cost
// per kept save, not per import batch ever written (import_batches is never purged) or per stored row.
// Backfilled from bank_stock; a batch's rows share one bank and page.
const V8_SCRAPTF_SAVES = `
CREATE INDEX IF NOT EXISTS scraptf_events_bank_id ON scraptf_events(bank, id);
CREATE TABLE IF NOT EXISTS bank_stock_saves (
  batch_id INTEGER PRIMARY KEY NOT NULL,
  bank     TEXT NOT NULL,
  page     TEXT NOT NULL DEFAULT '',
  items    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bank_stock_saves_bank ON bank_stock_saves(bank);
INSERT OR IGNORE INTO bank_stock_saves (batch_id, bank, page, items)
  SELECT batch_id, MIN(bank), MIN(page), COUNT(*) FROM bank_stock GROUP BY batch_id;
`;

// F21: how a batch reached the import, 'file' (a saved page: the picker or the folder watch) or 'window'
// (a read of the opt-in scrap.tf window, which main alone can mark). Older batches read NULL.
const V9_BATCH_ORIGIN = `
ALTER TABLE import_batches ADD COLUMN origin TEXT;
`;

// 0.7.1: each bank's newest save over every batch (Repo.bankNewestSaves) is one index seek per bank, not a
// scan of import_batches, which is never purged and gains a row with every window read. The expression is
// a save's time as batchSavedAt reads it (repo.ts BANK_STOCK_SAVED_AT), so that query's ORDER BY walks it.
const V10_BATCH_BANK_SAVED = `
CREATE INDEX IF NOT EXISTS idx_import_batches_bank_saved
  ON import_batches(bank, (CASE WHEN file_mtime > 0 THEN file_mtime ELSE imported_at END));
`;

// Killstreak kits (6527 basic, 6523 specialized, 6526 professional) stored before 0.7.2 without their
// target weapon: every kit of a tier shared one SKU and one price. Imported rows only; a typed price and
// a kit with its target (td-) stay.
const V11_BARE_KITS = `
DELETE FROM scrap_prices
 WHERE source = 'import'
   AND (sku = '6527;6' OR sku = '6523;6' OR sku = '6526;6'
        OR sku LIKE '6527;6;%' OR sku LIKE '6523;6;%' OR sku LIKE '6526;6;%')
   AND sku NOT LIKE '%;td-%';
DELETE FROM bank_stock
 WHERE (sku = '6527;6' OR sku = '6523;6' OR sku = '6526;6'
        OR sku LIKE '6527;6;%' OR sku LIKE '6523;6;%' OR sku LIKE '6526;6;%')
   AND sku NOT LIKE '%;td-%';
DELETE FROM scraptf_events
 WHERE (sku = '6527;6' OR sku = '6523;6' OR sku = '6526;6'
        OR sku LIKE '6527;6;%' OR sku LIKE '6523;6;%' OR sku LIKE '6526;6;%')
   AND sku NOT LIKE '%;td-%';
`;

// 0.7.2: V11 shipped before the parser could read a real kit card ("Professional Rocket Launcher Kit", a
// schema item named just "Kit"), so a /buy/killstreaks look made after it stored the bare kits again. V11's
// cleanup runs once more; and since V11 left the bank stock saves it emptied listed (bank_stock_saves),
// so the next look read every kit as new, saves with no rows left are dropped and the rest recounted. The
// batches of those emptied saves count no items (import_batches.item_count 0): the Banks page and the
// coverage strip would otherwise show the bank as saved with the bare kits' count. Only V11 and V12 can
// leave a save with no rows (a save is written with its rows and pruned with them).
const V12_BARE_KITS_AGAIN = `${V11_BARE_KITS}
UPDATE import_batches SET item_count = 0
 WHERE id IN (SELECT s.batch_id FROM bank_stock_saves s
               WHERE NOT EXISTS (SELECT 1 FROM bank_stock b WHERE b.batch_id = s.batch_id));
DELETE FROM bank_stock_saves
 WHERE NOT EXISTS (SELECT 1 FROM bank_stock b WHERE b.batch_id = bank_stock_saves.batch_id);
UPDATE bank_stock_saves
   SET items = (SELECT COUNT(*) FROM bank_stock b WHERE b.batch_id = bank_stock_saves.batch_id);
`;

// 0.7.3: a killstreaks look that stored prices but wrote no bank stock save (a partial look DM-2, an
// unsettled window snapshot ACT-4, a file import from before 0.6) kept its item_count after V11/V12 deleted
// its bare kit prices, so Repo.bankNewestSaves still dated the bank with the deleted kits' count. Only
// where a batch count can still date the bank: with any killstreaks stock save, the newest save dates it.
// And only a batch newer than every killstreaks batch that still has a price: a later look re-tags the rows
// it shares with an earlier one (importSavedPage updates them under its own batch id), thinning drops
// older saves and a sale deletes prices, so an older look with no price tagged to it is still real.
// Killstreaks only: an /items list takes over other banks' plain rows under its own batch id too.
const V13_BARE_KIT_LOOKS = `
UPDATE import_batches SET item_count = 0
 WHERE bank = 'killstreaks' AND item_count > 0
   AND NOT EXISTS (SELECT 1 FROM bank_stock_saves s WHERE s.bank = 'killstreaks')
   AND NOT EXISTS (SELECT 1 FROM scrap_prices sp WHERE sp.import_batch = import_batches.id)
   AND NOT EXISTS (SELECT 1 FROM import_batches k
                    WHERE k.bank = 'killstreaks'
                      AND EXISTS (SELECT 1 FROM scrap_prices sp2 WHERE sp2.import_batch = k.id)
                      AND ((CASE WHEN k.file_mtime > 0 THEN k.file_mtime ELSE k.imported_at END)
                             > (CASE WHEN import_batches.file_mtime > 0 THEN import_batches.file_mtime ELSE import_batches.imported_at END)
                           OR ((CASE WHEN k.file_mtime > 0 THEN k.file_mtime ELSE k.imported_at END)
                                 = (CASE WHEN import_batches.file_mtime > 0 THEN import_batches.file_mtime ELSE import_batches.imported_at END)
                               AND k.id > import_batches.id)));
`;

// 0.7.4: an unmarked scrap.tf/items row stands for every copy scrap.tf sells at its price (Craftable and
// Non-Craftable, killstreak and festivized copies alike), yet every list read before 0.7.4 stored it as the
// plain Craftable copy: its price met Craftable buy orders (false flips), its stock counted every copy, it
// took over bank pages' rows, and no later read or bank save could remove it. A stored row cannot tell which
// copy it priced (both carry the same name), so everything the list wrote goes and the user's next read of
// scrap.tf/items rebuilds it with each row's craftability (scraptf_list.craft): the list's imported prices
// (a typed price, "Use as my price" included, stays), its rows, its stock saves (the oldest held the
// pre-0.7.1 parser's rows with no stock, read as on sale) with their change events, and its batches' counts
// (item_count 0). Unlike a V12/V13 bank page, a list batch still dates the list: BANK_NEWEST_SAVE and
// isEmptyBankSave count the list with no rows, so the Banks list card reads "read <ago> · no rows kept: read
// scrap.tf/items again" (banksModel bankSavedText) until the next read. Opportunities need no SQL: the
// engine's first full run drops the ones whose price is gone. The list's new stock saves carry each row's
// craftability too (bank_stock.craft, NULL on a bank page's card), so a family row's stock is joined to no
// Craftable buyer (bankStockListFamily); a list row remembers the page it was read on (scraptf_list.page,
// F60: a whole save of that page retires the rows it no longer shows). Also key_prices.price_at (when the
// source last set the quote's price; NULL: unknown).
const V14_LIST_FAMILY_ROWS = `
DELETE FROM scrap_prices
 WHERE source = 'import'
   AND import_batch IN (SELECT id FROM import_batches WHERE page_kind = 'items-list');
DELETE FROM scraptf_list;
DELETE FROM scraptf_events WHERE bank = 'list';
DELETE FROM bank_stock WHERE bank = 'list';
DELETE FROM bank_stock_saves WHERE bank = 'list';
UPDATE import_batches SET item_count = 0 WHERE page_kind = 'items-list' AND item_count > 0;
ALTER TABLE scraptf_list ADD COLUMN craft TEXT NOT NULL DEFAULT 'any';
ALTER TABLE scraptf_list ADD COLUMN page TEXT NOT NULL DEFAULT '';
ALTER TABLE bank_stock ADD COLUMN craft TEXT;
ALTER TABLE key_prices ADD COLUMN price_at INTEGER;
`;

// 0.8.0: the release's one migration (nullable columns and new tables only; no row is read or rewritten).
// J2: a fee per journal row; G1/G3: the user's scrap.tf watches; H1: recorded exit-price runs of held and watched
// items. A 0.7.4 build refuses a V15 database (SchemaVersionError), as for every migration.
const V15_ROUND_080 = `
-- 0.8 (J2): a fee per journal row, keys and metal apart. NULL in both is "not recorded" (every row written before
-- V15), 0 is "none". journal.side also takes 'writeoff' from 0.8 (TEXT; no change needed).
ALTER TABLE journal ADD COLUMN fee_keys REAL;
ALTER TABLE journal ADD COLUMN fee_scrap INTEGER;

-- 0.8 (G1, G3): the user's scrap.tf watches, one row per watched copy (special_key: the bank_stock key) or per base for
-- every copy (special_key NULL). Price targets are raw keys + metal as typed (max_cost_scrap NULL: none), the profit
-- floor whole scrap (NULL: none). remind_at is reserved for the timed look reminder (T9): 0.8 never reads or writes
-- it. User data, never pruned (at most WATCHES_MAX rows, rpcHandlers). One watch per copy: '*' stands for every copy
-- (a special key is '' or JSON, never '*'). AUTOINCREMENT, so a removed watch's id (and its dedupe key) is never reused.
CREATE TABLE IF NOT EXISTS scraptf_watches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sku              TEXT NOT NULL,
  special_key      TEXT,
  name             TEXT NOT NULL DEFAULT '',
  max_cost_keys    REAL NOT NULL DEFAULT 0,
  max_cost_scrap   INTEGER,
  min_profit_scrap INTEGER,
  on_restock       INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  remind_at        INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS scraptf_watches_copy ON scraptf_watches(sku, IFNULL(special_key, '*'));

-- 0.8 (H1): recorded exit-price runs of held and watched items, one row per run of identical values seen while the
-- backpack.tf live feed was up (holdings' MarkRecorder). Prices are raw keys + metal (valued per read at the current
-- key price, so a key move alone is never a price move); NULL where that side had nothing. Only data the app already
-- had (the live book, the kept sell listings, the saved list); nothing is fetched. A new run starts when a price
-- changes; the counts (buyer_count, verified_buyer_count, ask_count) are the latest seen in the run, updated when it is
-- extended. key_scrap is NULL when the key price was not known (never a default written as an observation).
-- Retention (180 days, at most 2,000 runs per base) is Repo.pruneHoldingMarks.
CREATE TABLE IF NOT EXISTS holding_marks (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  base_sku             TEXT NOT NULL,
  from_at              INTEGER NOT NULL,
  to_at                INTEGER NOT NULL,
  rev_keys             REAL,
  rev_metal_scrap      INTEGER,
  rev_is_bot           INTEGER,
  rev_verified         INTEGER,
  best_keys            REAL,
  best_metal_scrap     INTEGER,
  next_keys            REAL,
  next_metal_scrap     INTEGER,
  buyer_count          INTEGER NOT NULL DEFAULT 0,
  verified_buyer_count INTEGER,
  ask_keys             REAL,
  ask_metal_scrap      INTEGER,
  ask_count            INTEGER,
  scraptf_pays_keys    REAL,
  scraptf_pays_scrap   INTEGER,
  key_scrap            INTEGER
);
CREATE INDEX IF NOT EXISTS holding_marks_base_from ON holding_marks(base_sku, from_at);
CREATE INDEX IF NOT EXISTS holding_marks_to_at ON holding_marks(to_at);
`;

// 0.9.0: the release's one migration (nullable columns, new tables and indexes only; no row is read or rewritten).
// Exits (#11): backpack.tf's impersonation flag on a listing. Ranking (#3): risk-aware keys per opportunity. History
// (#6, #7): buy-order persistence spells, recorded community prices and scrap.tf lows. scrap.tf (#13): a bank page's
// own notice and a card's price-drop wording. A 0.8 build refuses a V16 database (SchemaVersionError), as for every
// migration.
const V16_ROUND_090 = `
-- 0.9 (exits, #11): backpack.tf's impersonation flag on a listing's user (user.flagImpersonated on the live feed),
-- treated like a ban: the order or listing is shown, flagged 'impersonator' and never used as an exit or an ask.
-- NULL: not flagged or not known (every row stored before V16, and snapshot rows, which carry no user object);
-- 1: flagged. Nullable with no default, so no row is read or rewritten. Retention: the listings table's own (a row goes
-- when the feed deletes it, it turns inactive, or the book prunes it); nothing new is kept.
ALTER TABLE listings ADD COLUMN user_impersonated INTEGER;

-- 0.9 (#3, ranking): risk-aware ranking keys per opportunity, written by the engine (exitRiskAt over the row's own
-- priced book). backup_profit_scrap: flipProfit at the best other buyer seen in the last 24 h ("profit if this buyer
-- leaves"); NULL: none. profitable_depth: distinct buyers seen in the last 24 h at or above break-even at the row's cost
-- (at most 20). book_depth: distinct buyers seen in the last 24 h at any price (the book-depth tag). All three are NULL
-- on every row stored before V16 until the engine's first full sweep rewrites it (materiallyEqual sees the new fields),
-- as V2's max_cost_scrap was. No row is read or rewritten here. No retention of their own: the rows follow the
-- opportunities table.
ALTER TABLE opportunities ADD COLUMN backup_profit_scrap INTEGER;
ALTER TABLE opportunities ADD COLUMN profitable_depth INTEGER;
ALTER TABLE opportunities ADD COLUMN book_depth INTEGER;

-- 0.9 (history, RESEARCH #6): buy-order persistence. One row per spell: one buy order at one price, followed from the
-- live feed while it ran, for watched, held and scrap.tf-priced items' top orders (orderSpellFollows). No SteamID,
-- listing id or name is stored: the tracker keeps the listing id in memory only. listed_at is backpack.tf's listedAt
-- (Unix s) on the update that opened the spell; first_seen_at / last_seen_at / end_at are Unix ms. end_kind NULL: still
-- followed (read as censored at last_seen_at); 'deleted' | 'inactive' | 'lowered' (ends) | 'raised' | 'relisted' |
-- 'unwatched' (censored). last_seen_at of an ended spell is when it ended. Retention (ended spells only: 60 days, 300
-- per base, 400,000 in all) is Repo.pruneOrderSpells. Every cut (age, caps, the read's limit) selects by first_seen_at,
-- the spell's entry, never by when it ended: a cut on the end keeps long spells and drops their short siblings, which
-- biases the Kaplan-Meier estimate up (review 0.9).
CREATE TABLE IF NOT EXISTS order_spells (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  base_sku      TEXT NOT NULL,
  intent        TEXT NOT NULL,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  keys          REAL NOT NULL DEFAULT 0,
  metal_scrap   INTEGER NOT NULL DEFAULT 0,
  listed_at     INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  end_at        INTEGER,
  end_kind      TEXT
);
CREATE INDEX IF NOT EXISTS order_spells_base_first ON order_spells(base_sku, first_seen_at);
CREATE INDEX IF NOT EXISTS order_spells_first_seen ON order_spells(first_seen_at);
CREATE INDEX IF NOT EXISTS order_spells_open ON order_spells(id) WHERE end_kind IS NULL;

-- 0.9 (history, RESEARCH #7): backpack.tf community prices kept as history: the IGetPrices rows an answer replaced and
-- the rows that replaced them (source 'prices'), and the live feed's item.price.community of watched, held and priced
-- items when it changed (source 'feed'). bptf_community is still overwritten as before; nothing here is a reference.
-- One row per distinct price per SKU and source (the unique expression index; NULLs folded, V10 precedent).
-- Retention (365 days by recorded_at, 200 per SKU, 300,000 in all) is Repo.pruneCommunityHistory.
CREATE TABLE IF NOT EXISTS bptf_community_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sku         TEXT NOT NULL,
  source      TEXT NOT NULL,
  currency    TEXT NOT NULL,
  value       REAL NOT NULL,
  value_high  REAL,
  last_update INTEGER,
  recorded_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bptf_community_history_point
  ON bptf_community_history(sku, source, currency, value, IFNULL(value_high, -1), IFNULL(last_update, -1));
CREATE INDEX IF NOT EXISTS bptf_community_history_recorded ON bptf_community_history(recorded_at);

-- 0.9 (history): the lowest price on sale each scrap.tf copy showed in the user's saves (R10), per bank, written at
-- import from 0.9 on (ScraptfHistory.recordLows): raw keys + metal, the first and last save at that price, the first
-- sighting it covers and the newest (retention: 365 days after seen_at, Repo.pruneScraptfLows). Times are Unix ms.
CREATE TABLE IF NOT EXISTS scraptf_lows (
  bank        TEXT NOT NULL,
  sku         TEXT NOT NULL,
  special_key TEXT NOT NULL DEFAULT '',
  low_keys    REAL NOT NULL DEFAULT 0,
  low_scrap   INTEGER NOT NULL,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  since_at    INTEGER NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (bank, sku, special_key)
);
CREATE INDEX IF NOT EXISTS scraptf_lows_seen ON scraptf_lows(seen_at);

-- 0.9 (scrap.tf #13): what a recognised bank page's own text said about its bank when it was saved or read
-- ('unavailable': a notice such as "Hat Banking is temporarily disabled"); NULL: nothing seen (every batch before V16).
-- Such a look stored no bank stock save. Kept with its batch (import_batches is never purged).
ALTER TABLE import_batches ADD COLUMN bank_notice TEXT;
-- 0.9 (scrap.tf #13): a bank page card's own price-drop wording on this save ('soon', 'off', or 'off soon'); NULL: none
-- seen (every row before V16, every /items row). Pruned with its save (Repo.pruneBankStock).
ALTER TABLE bank_stock ADD COLUMN markdown TEXT;
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'initial schema', sql: V1_INITIAL },
  { version: 2, name: 'opportunity pay-up-to ceiling', sql: V2_MAX_COST },
  { version: 3, name: 'saved-page batch categories', sql: V3_BATCH_CATEGORIES },
  { version: 4, name: 'scrap.tf price list', sql: V4_SCRAPTF_LIST },
  { version: 5, name: 'saved-page batch bank', sql: V5_BATCH_BANK },
  { version: 6, name: 'scrap.tf bank stock', sql: V6_BANK_STOCK },
  { version: 7, name: 'scrap.tf change events', sql: V7_SCRAPTF_EVENTS },
  { version: 8, name: 'scrap.tf feed by bank and kept saves', sql: V8_SCRAPTF_SAVES },
  { version: 9, name: 'saved-page batch origin', sql: V9_BATCH_ORIGIN },
  { version: 10, name: 'saved-page batch bank and save time', sql: V10_BATCH_BANK_SAVED },
  { version: 11, name: 'remove killstreak kits stored without their target', sql: V11_BARE_KITS },
  { version: 12, name: 'remove bare killstreak kits again and the bank stock saves they left empty', sql: V12_BARE_KITS_AGAIN },
  { version: 13, name: 'killstreaks looks left with no prices and no bank stock save count no items', sql: V13_BARE_KIT_LOOKS },
  { version: 14, name: 'remove scrap.tf/items list data stored without its craftability', sql: V14_LIST_FAMILY_ROWS },
  { version: 15, name: 'journal fees, scrap.tf watches and recorded exit runs', sql: V15_ROUND_080 },
  { version: 16, name: 'impersonators, ranking keys, order persistence, community history, scrap.tf lows and notices', sql: V16_ROUND_090 },
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
