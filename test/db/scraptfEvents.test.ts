// F20 S2: the scraptf_events table (migration V7) and its repo methods: the write the import uses, the
// feed newest first with its filters and paging, one SKU's events, and the 90-day retention. Local
// database only; nothing here touches the network.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { MIGRATIONS, SCHEMA_VERSION, migrate, userVersion } from '../../src/service/db/migrations';
import { SCRAPTF_EVENTS_MAX_AGE_MS } from '../../src/shared/scraptfHistory';
import type { NewScraptfEvent } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function ev(over: Partial<NewScraptfEvent> = {}): NewScraptfEvent {
  return {
    at: T0,
    bank: 'hats',
    page: '/buy/hats',
    sku: '378;6',
    specialKey: '',
    name: 'Team Captain',
    kind: 'cheaper',
    fromKeys: 1,
    fromScrap: 9,
    toKeys: 1,
    toScrap: 0,
    fromStock: 2,
    toStock: 2,
    batchId: 7,
    ...over,
  };
}

describe('migration V7 on an existing version 6 database', () => {
  it('adds an empty scraptf_events table with the spec columns and indexes, and keeps every row', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const raw = new DatabaseSync(path);
    expect(migrate(raw, MIGRATIONS.slice(0, 6))).toEqual({ from: 0, to: 6, applied: [1, 2, 3, 4, 5, 6] });
    raw
      .prepare('INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, bank) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(3, 'scrap.tf - Buy Hats.html', 'buy', T0 - 10 * MIN, T0 - 9 * MIN, 1, 'hats');
    raw
      .prepare("INSERT INTO bank_stock (batch_id, bank, sku, special_key, name, cost_keys, cost_scrap, stock, asset_id, page) VALUES (3, 'hats', '378;6', '', 'Team Captain', 0, 30, 1, NULL, '/buy/hats')")
      .run();
    raw.close();

    const repo = openRepo(path);
    cleanups.push(() => repo.close());
    expect(repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([3]);
    // A 0.6 database has no events: the feed starts with the next save.
    expect(repo.scraptfEvents()).toEqual([]);

    const check = new DatabaseSync(path);
    cleanups.push(() => check.close());
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    expect(userVersion(check)).toBe(SCHEMA_VERSION);
    const cols = check.prepare('PRAGMA table_info(scraptf_events)').all();
    expect(cols.map((c) => [c['name'], c['type'], c['notnull'], c['pk']])).toEqual([
      ['id', 'INTEGER', 0, 1],
      ['at', 'INTEGER', 1, 0],
      ['bank', 'TEXT', 1, 0],
      ['page', 'TEXT', 1, 0],
      ['sku', 'TEXT', 1, 0],
      ['special_key', 'TEXT', 1, 0],
      ['name', 'TEXT', 1, 0],
      ['kind', 'TEXT', 1, 0],
      ['from_keys', 'REAL', 0, 0],
      ['from_scrap', 'INTEGER', 0, 0],
      ['to_keys', 'REAL', 0, 0],
      ['to_scrap', 'INTEGER', 0, 0],
      ['from_stock', 'INTEGER', 0, 0],
      ['to_stock', 'INTEGER', 0, 0],
      ['batch_id', 'INTEGER', 1, 0],
    ]);
    const index = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scraptf_events' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    // V8 adds (bank, id) for the feed filtered by bank (F20-UIPERF-1).
    expect(index.map((r) => r['name'])).toEqual(['scraptf_events_at', 'scraptf_events_bank_at', 'scraptf_events_bank_id', 'scraptf_events_sku']);
    expect(check.prepare('PRAGMA index_info(scraptf_events_bank_at)').all().map((r) => r['name'])).toEqual(['bank', 'at']);
    expect(check.prepare('PRAGMA index_info(scraptf_events_bank_id)').all().map((r) => r['name'])).toEqual(['bank', 'id']);
    expect(check.prepare('PRAGMA index_info(scraptf_events_at)').all().map((r) => r['name'])).toEqual(['at']);
    expect(check.prepare('PRAGMA index_info(scraptf_events_sku)').all().map((r) => r['name'])).toEqual(['sku']);
  });
});

describe('scrap.tf change events repo', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = openRepo(':memory:');
  });
  afterEach(() => {
    repo.close();
  });

  it('writes events and reads them back newest first, raw (nothing valued)', () => {
    const n = repo.insertScraptfEvents([
      ev(),
      ev({ kind: 'new', fromKeys: null, fromScrap: null, toKeys: 0, toScrap: 33.6, fromStock: null, toStock: 1, sku: '126;6', name: 'Bill' }),
      ev({ kind: 'gone', toKeys: null, toScrap: null, fromStock: 3, toStock: 0, specialKey: '[5801378,[],[],null,null,false,false]' }),
    ]);
    expect(n).toBe(3);
    const all = repo.scraptfEvents();
    expect(all.map((e) => e.kind)).toEqual(['gone', 'new', 'cheaper']);
    expect(all.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(all[2]).toEqual({ ...ev(), id: 1 });
    // Metal is whole scrap; a side with no price reads null for both keys and metal.
    expect(all[1]).toMatchObject({ fromKeys: null, fromScrap: null, toKeys: 0, toScrap: 34, fromStock: null, toStock: 1 });
    expect(all[0]).toMatchObject({ toKeys: null, toScrap: null, fromStock: 3, toStock: 0, specialKey: '[5801378,[],[],null,null,false,false]' });
  });

  it('skips an event with an unknown bank or kind, no SKU, no finite time or a bad batch id', () => {
    const n = repo.insertScraptfEvents([
      ev({ bank: 'trading-cards' as never }),
      ev({ bank: '__proto__' as never }),
      ev({ kind: 'sold' as never }),
      ev({ sku: '' }),
      ev({ sku: '  ' }),
      ev({ at: Number.NaN }),
      ev({ batchId: 0 }),
      ev({ batchId: 1.5 }),
      ev({ fromStock: -3, toStock: 2.7 }),
      null as never,
    ]);
    expect(n).toBe(1);
    expect(repo.scraptfEvents()[0]).toMatchObject({ fromStock: null, toStock: 2 });
    expect(repo.insertScraptfEvents([])).toBe(0);
  });

  it('filters the feed by bank, kinds, SKU and copy, time, and pages it by id', () => {
    repo.insertScraptfEvents([
      ev({ at: T0 - 3 * MIN }),
      ev({ at: T0 - 2 * MIN, bank: 'list', page: '/items/2', kind: 'new' }),
      ev({ at: T0 - MIN, sku: '126;6', kind: 'restocked' }),
      ev({ at: T0, specialKey: 'painted', kind: 'stock' }),
    ]);
    const ids = (q: Parameters<Repo['scraptfEvents']>[0]) => repo.scraptfEvents(q).map((e) => e.id);
    expect(ids({})).toEqual([4, 3, 2, 1]);
    expect(ids({ bank: 'hats' })).toEqual([4, 3, 1]);
    expect(ids({ bank: 'list' })).toEqual([2]);
    expect(ids({ bank: 'nope' as never })).toEqual([]);
    expect(ids({ kinds: ['new', 'restocked'] })).toEqual([3, 2]);
    // No kinds is no filter; only unknown kinds match nothing.
    expect(ids({ kinds: [] })).toEqual([4, 3, 2, 1]);
    expect(ids({ kinds: ['sold' as never] })).toEqual([]);
    expect(ids({ sku: '378;6' })).toEqual([4, 2, 1]);
    expect(ids({ sku: '378;6', specialKey: '' })).toEqual([2, 1]);
    expect(ids({ sku: '378;6', specialKey: 'painted' })).toEqual([4]);
    // A copy without the SKU is no filter (the copy belongs to a SKU).
    expect(ids({ specialKey: 'painted' })).toEqual([4, 3, 2, 1]);
    expect(ids({ sinceAt: T0 - MIN })).toEqual([4, 3]);
    expect(ids({ beforeId: 3 })).toEqual([2, 1]);
    expect(ids({ beforeId: 3, limit: 1 })).toEqual([2]);
    expect(ids({ limit: 0 })).toEqual([4]);
    expect(ids({ bank: 'hats', kinds: ['cheaper', 'stock'], beforeId: 4 })).toEqual([1]);
  });

  it("reads one base SKU's events newest first, every copy and bank", () => {
    repo.insertScraptfEvents([ev(), ev({ bank: 'list' }), ev({ sku: '126;6' }), ev({ specialKey: 'painted' })]);
    expect(repo.scraptfEventsForSku('378;6').map((e) => e.id)).toEqual([4, 2, 1]);
    expect(repo.scraptfEventsForSku('378;6', 2).map((e) => e.id)).toEqual([4, 2]);
    expect(repo.scraptfEventsForSku('')).toEqual([]);
    expect(repo.scraptfEventsForSku('5021;6')).toEqual([]);
  });

  it('keeps 90 days of events (maintenance), or another horizon when asked', () => {
    expect(SCRAPTF_EVENTS_MAX_AGE_MS).toBe(90 * DAY);
    repo.insertScraptfEvents([ev({ at: T0 - 91 * DAY }), ev({ at: T0 - 90 * DAY }), ev({ at: T0 - DAY }), ev({ at: T0 })]);
    expect(repo.pruneScraptfEvents(T0)).toBe(1);
    expect(repo.scraptfEvents().map((e) => e.at)).toEqual([T0, T0 - DAY, T0 - 90 * DAY]);
    expect(repo.pruneScraptfEvents(T0, 2 * DAY)).toBe(1);
    expect(repo.scraptfEvents().map((e) => e.at)).toEqual([T0, T0 - DAY]);
  });

  it('reads past a row a newer build wrote with a kind or bank it does not know', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const fileRepo = openRepo(path);
    fileRepo.insertScraptfEvents([ev()]);
    fileRepo.close();
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO scraptf_events (at, bank, page, sku, special_key, name, kind, batch_id) VALUES (?, 'hats', '', '378;6', '', 'x', 'teleported', 7)").run(T0);
    raw.prepare("INSERT INTO scraptf_events (at, bank, page, sku, special_key, name, kind, batch_id) VALUES (?, 'moon', '', '378;6', '', 'x', 'new', 7)").run(T0);
    raw.close();
    const again = openRepo(path);
    cleanups.push(() => again.close());
    expect(again.scraptfEvents().map((e) => e.kind)).toEqual(['cheaper']);
    expect(again.scraptfEventsForSku('378;6')).toHaveLength(1);
  });
});

// F20-UIPERF-1: on (bank, at) alone, the feed filtered by bank sorted that bank's every event in a temp
// B-tree to return one page. V8's (bank, id) lets it walk back from the newest and stop at the limit.
describe('the feed filtered by bank (V8 index)', () => {
  it('walks (bank, id) back from the newest, never sorting the bank, with any filter and after ANALYZE', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const repo = openRepo(path);
    const banks = ['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'items', 'unusuals', 'list'] as const;
    // Interleaved, as several banks saved through the day write them.
    const events = Array.from({ length: 4000 }, (_, i) => ev({ at: T0 - (4000 - i) * MIN, bank: banks[i % banks.length]!, kind: i % 3 === 0 ? 'restocked' : 'cheaper', sku: `${100 + (i % 50)};6` }));
    expect(repo.insertScraptfEvents(events)).toBe(4000);
    const page = repo.scraptfEvents({ bank: 'hats', limit: 100 });
    expect(page).toHaveLength(100);
    expect(page.every((e) => e.bank === 'hats')).toBe(true);
    expect(page.map((e) => e.id)).toEqual([...page.map((e) => e.id)].sort((a, b) => b - a));
    const older = repo.scraptfEvents({ bank: 'hats', beforeId: page[99]!.id, limit: 100 });
    expect(older[0]!.id).toBeLessThan(page[99]!.id);
    repo.close();

    const raw = new DatabaseSync(path);
    cleanups.push(() => raw.close());
    // db.ts runs PRAGMA optimize on close; the plan must hold with statistics too.
    raw.exec('ANALYZE');
    // The statements repo.scraptfEvents builds for a bank, with paging and kinds.
    const shapes = [
      'SELECT * FROM scraptf_events WHERE bank = ? ORDER BY id DESC LIMIT ?',
      'SELECT * FROM scraptf_events WHERE bank = ? AND id < ? ORDER BY id DESC LIMIT ?',
      'SELECT * FROM scraptf_events WHERE bank = ? AND kind IN (?) ORDER BY id DESC LIMIT ?',
      'SELECT * FROM scraptf_events WHERE bank = ? AND kind IN (?, ?) AND id < ? ORDER BY id DESC LIMIT ?',
    ];
    for (const sql of shapes) {
      const plan = raw
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'hats'))
        .map((r) => String(r['detail']));
      expect(plan.join(' | '), sql).toContain('scraptf_events_bank_id');
      expect(plan.join(' | '), sql).not.toMatch(/TEMP B-TREE/);
    }
  });
});
