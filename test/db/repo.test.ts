import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepo, migrate, openDatabase, openRepo } from '../../src/service/db';
import type { Repo, SchemaSnapshot } from '../../src/service/contracts';
import type { SpecialAttrs } from '../../src/shared/types';
import { tempDir } from './helpers';

let repo: Repo;
beforeEach(() => {
  repo = openRepo(':memory:');
});
afterEach(() => repo.close());

describe('meta', () => {
  it('gets, sets and overwrites values', () => {
    expect(repo.getMeta('k')).toBeNull();
    repo.setMeta('k', 'v1');
    repo.setMeta('k', 'v2');
    repo.setMeta('empty', '');
    expect(repo.getMeta('k')).toBe('v2');
    expect(repo.getMeta('empty')).toBe('');
  });
});

describe('backpack.tf names', () => {
  it('round-trips and ignores older sightings', () => {
    repo.upsertBptfNames([{ sku: '378;6', name: 'Team Captain', marketName: 'The Team Captain', lastSeen: 100 }]);
    expect(repo.getBptfName('378;6')).toEqual({ sku: '378;6', name: 'Team Captain', marketName: 'The Team Captain', lastSeen: 100 });

    repo.upsertBptfNames([{ sku: '378;6', name: 'Stale', marketName: null, lastSeen: 50 }]);
    expect(repo.getBptfName('378;6')!.name).toBe('Team Captain');

    repo.upsertBptfNames([{ sku: '378;6', name: 'Team Captain v2', marketName: null, lastSeen: 200 }]);
    // A newer row without a market name keeps the known one.
    expect(repo.getBptfName('378;6')).toEqual({ sku: '378;6', name: 'Team Captain v2', marketName: 'The Team Captain', lastSeen: 200 });
    expect(repo.getBptfName('nope')).toBeNull();
  });

  it('skips rows without a name', () => {
    repo.upsertBptfNames([
      { sku: 'a', name: '', marketName: null, lastSeen: 1 },
      { sku: 'b', name: '  ', marketName: null, lastSeen: 1 },
      { sku: 'c', name: 'C', marketName: null, lastSeen: 1 },
    ]);
    expect(repo.getBptfName('a')).toBeNull();
    expect(repo.getBptfName('b')).toBeNull();
    expect(repo.getBptfName('c')).not.toBeNull();
  });

  it('finds a SKU by name, case-insensitively, preferring exact case and the plain item', () => {
    repo.upsertBptfNames([
      { sku: '378;6;p3100495', name: 'Team Captain', marketName: null, lastSeen: 500 },
      { sku: '378;6', name: 'Team Captain', marketName: null, lastSeen: 100 },
      { sku: '154;11', name: 'Strange Pain Train', marketName: null, lastSeen: 100 },
      { sku: '999;6', name: 'strange pain train', marketName: null, lastSeen: 100 },
    ]);
    expect(repo.findSkuByBptfName('Team Captain')).toBe('378;6');
    expect(repo.findSkuByBptfName('  team captain ')).toBe('378;6');
    expect(repo.findSkuByBptfName('Strange Pain Train')).toBe('154;11');
    expect(repo.findSkuByBptfName('strange pain train')).toBe('999;6');
    expect(repo.findSkuByBptfName('STRANGE PAIN TRAIN')).not.toBeNull();
    expect(repo.findSkuByBptfName('Pain Train')).toBeNull();
    expect(repo.findSkuByBptfName('')).toBeNull();
  });

  it('searches with prefix matches before word and substring matches', () => {
    repo.upsertBptfNames([
      { sku: '1', name: 'Strange Pain Train', marketName: null, lastSeen: 1 },
      { sku: '2', name: 'Pain Train', marketName: null, lastSeen: 1 },
      { sku: '3', name: 'Painted Hat', marketName: null, lastSeen: 1 },
      { sku: '4', name: 'Unusual Thing', marketName: 'Pain Market', lastSeen: 1 },
      { sku: '5', name: 'Spain Hat', marketName: null, lastSeen: 1 },
      { sku: '6', name: 'Rocket Launcher', marketName: null, lastSeen: 1 },
    ]);
    expect(repo.searchBptfNames('pain', 10).map((r) => r.sku)).toEqual(['2', '3', '4', '1', '5']);
    expect(repo.searchBptfNames('pain', 2).map((r) => r.sku)).toEqual(['2', '3']);
    expect(repo.searchBptfNames('', 10)).toEqual([]);
    expect(repo.searchBptfNames('pain', 0)).toEqual([]);
  });

  it('escapes wildcards in searches', () => {
    repo.upsertBptfNames([
      { sku: '1', name: '100% Hat', marketName: null, lastSeen: 1 },
      { sku: '2', name: '1000 Hat', marketName: null, lastSeen: 1 },
      { sku: '3', name: 'a_b', marketName: null, lastSeen: 1 },
      { sku: '4', name: 'axb', marketName: null, lastSeen: 1 },
    ]);
    expect(repo.searchBptfNames('100%', 10).map((r) => r.sku)).toEqual(['1']);
    expect(repo.searchBptfNames('a_b', 10).map((r) => r.sku)).toEqual(['3']);
  });
});

describe('PriceDB', () => {
  it('upserts, reads, counts and keeps fractional keys', () => {
    const row = { sku: '5021;6', name: 'Mann Co. Supply Crate Key', buyKeys: 0, buyScrap: 540, sellKeys: 0.5, sellScrap: 545, time: 1_791_000_000, fetchedAt: 1_791_000_000_123 };
    repo.upsertPricedb([row, { ...row, sku: '5002;6', name: 'Refined Metal' }]);
    expect(repo.getPricedb('5021;6')).toEqual(row);
    expect(repo.pricedbCount()).toBe(2);
    repo.upsertPricedb([{ ...row, buyScrap: 550 }]);
    expect(repo.getPricedb('5021;6')!.buyScrap).toBe(550);
    expect(repo.pricedbCount()).toBe(2);
    expect(repo.getPricedb('nope')).toBeNull();
  });

  it('stores SKU aliases', () => {
    expect(repo.getSkuAlias('a')).toBeNull();
    repo.setSkuAlias('a', 'b');
    repo.setSkuAlias('a', 'c');
    expect(repo.getSkuAlias('a')).toBe('c');
  });
});

describe('community prices and key quotes', () => {
  it('round-trips community rows with nulls', () => {
    repo.upsertCommunity([
      { sku: 'a', currency: 'keys', value: 1.5, valueHigh: 2.25, lastUpdate: 123 },
      { sku: 'b', currency: 'metal', value: 3.33, valueHigh: null, lastUpdate: null },
    ]);
    expect(repo.getCommunity('a')).toEqual({ sku: 'a', currency: 'keys', value: 1.5, valueHigh: 2.25, lastUpdate: 123 });
    expect(repo.getCommunity('b')).toEqual({ sku: 'b', currency: 'metal', value: 3.33, valueHigh: null, lastUpdate: null });
    expect(repo.getCommunity('c')).toBeNull();
  });

  it('keeps one quote per source, newest first', () => {
    repo.upsertKeyQuote({ source: 'bptf', buyScrap: 540, sellScrap: 545, observedAt: 1 });
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: null, sellScrap: 550, observedAt: 3 });
    repo.upsertKeyQuote({ source: 'bptf', buyScrap: 541, sellScrap: 546, observedAt: 2 });
    expect(repo.keyQuotes()).toEqual([
      { source: 'pricedb', buyScrap: null, sellScrap: 550, observedAt: 3 },
      { source: 'bptf', buyScrap: 541, sellScrap: 546, observedAt: 2 },
    ]);
  });
});

describe('scrap.tf prices', () => {
  const special: SpecialAttrs = {
    paint: 15185211,
    spells: ['Exorcism'],
    parts: [],
    sheen: null,
    killstreaker: null,
    customName: false,
    customDesc: true,
  };

  it('inserts with defaults and returns the stored row', () => {
    const p = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 120, source: 'user', observedAt: 10 });
    expect(p).toEqual({
      id: p.id,
      sku: '378;6',
      name: 'Team Captain',
      costKeys: 0,
      costScrap: 120,
      source: 'user',
      observedAt: 10,
      note: null,
      importBatch: null,
      special: null,
      assetId: null,
      stock: null,
      // F15: joined from the import batch; a typed price has none.
      bank: null,
    });
    expect(p.id).toBeGreaterThan(0);
    expect(repo.getScrapPrice(p.id)).toEqual(p);
  });

  it('round-trips every optional field and distinguishes null special from empty special', () => {
    const full = repo.upsertScrapPrice({
      sku: '378;6;p15185211',
      name: 'Team Captain',
      costKeys: 2.5,
      costScrap: 13,
      source: 'import',
      observedAt: 20,
      note: 'from page',
      importBatch: 4,
      special,
      assetId: '12345678901',
      stock: 3,
    });
    expect(repo.getScrapPrice(full.id)).toMatchObject({ costKeys: 2.5, special, assetId: '12345678901', stock: 3, importBatch: 4 });

    const empty: SpecialAttrs = { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };
    const clean = repo.upsertScrapPrice({ sku: 'x', name: 'x', costScrap: 1, source: 'import', observedAt: 1, special: empty });
    expect(repo.getScrapPrice(clean.id)!.special).toEqual(empty);
  });

  it('updates by id, keeping omitted optional fields and clearing explicit nulls', () => {
    const p = repo.upsertScrapPrice({
      sku: 'a',
      name: 'A',
      costKeys: 1,
      costScrap: 5,
      source: 'import',
      observedAt: 1,
      note: 'n',
      importBatch: 2,
      special,
      assetId: 'as',
      stock: 1,
    });
    const u = repo.upsertScrapPrice({ id: p.id, sku: 'a', name: 'A2', costScrap: 7, source: 'user', observedAt: 2, note: null });
    expect(u).toEqual({ ...p, name: 'A2', costScrap: 7, source: 'user', observedAt: 2, note: null });
    expect(repo.listScrapPrices()).toHaveLength(1);
  });

  it('throws when updating an unknown id or given bad input', () => {
    expect(() => repo.upsertScrapPrice({ id: 999, sku: 'a', name: 'A', costScrap: 1, source: 'user', observedAt: 1 })).toThrow(/not found/);
    expect(() => repo.upsertScrapPrice({ sku: '', name: 'A', costScrap: 1, source: 'user', observedAt: 1 })).toThrow(/sku/);
    expect(() => repo.upsertScrapPrice({ sku: 'a', name: 'A', costScrap: Number.NaN, source: 'user', observedAt: 1 })).toThrow(/costScrap/);
    expect(() =>
      repo.upsertScrapPrice({ sku: 'a', name: 'A', costScrap: 1, source: 'web' as 'user', observedAt: 1 }),
    ).toThrow(/source/);
    expect(repo.listScrapPrices()).toEqual([]);
  });

  it('lists newest first, searches name or SKU, and filters by SKU', () => {
    const a = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 1, source: 'user', observedAt: 1 });
    const b = repo.upsertScrapPrice({ sku: '154;11', name: 'Strange Pain Train', costScrap: 1, source: 'user', observedAt: 3 });
    const c = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 2, source: 'import', observedAt: 2 });
    expect(repo.listScrapPrices().map((p) => p.id)).toEqual([b.id, c.id, a.id]);
    expect(repo.listScrapPrices('captain').map((p) => p.id)).toEqual([c.id, a.id]);
    expect(repo.listScrapPrices('154;').map((p) => p.id)).toEqual([b.id]);
    expect(repo.listScrapPrices('%')).toEqual([]);
    expect(repo.listScrapPrices('  ')).toHaveLength(3);
    expect(repo.scrapPricesForSku('378;6').map((p) => p.id)).toEqual([c.id, a.id]);
  });

  it('deletes and never reuses ids', () => {
    const a = repo.upsertScrapPrice({ sku: 'a', name: 'A', costScrap: 1, source: 'user', observedAt: 1 });
    repo.deleteScrapPrice(a.id);
    expect(repo.getScrapPrice(a.id)).toBeNull();
    const b = repo.upsertScrapPrice({ sku: 'a', name: 'A', costScrap: 1, source: 'user', observedAt: 1 });
    expect(b.id).toBeGreaterThan(a.id);
  });
});

describe('price rules', () => {
  it('inserts with defaults, round-trips the filter and updates by id', () => {
    const filter = { categories: ['hats' as const], qualities: [6], craftable: true, hasEffect: null, nameContains: 'Cap' };
    const r = repo.upsertRule({ name: 'Craft hats', filter, costScrap: 12, observedAt: 1 });
    expect(r).toEqual({ id: r.id, name: 'Craft hats', filter, costKeys: 0, costScrap: 12, observedAt: 1, enabled: true });
    expect(repo.getRule(r.id)).toEqual(r);

    const u = repo.upsertRule({ id: r.id, name: 'Craft hats', filter: {}, costScrap: 13, observedAt: 2, enabled: false });
    expect(u).toEqual({ ...r, filter: {}, costScrap: 13, observedAt: 2, enabled: false });
    const u2 = repo.upsertRule({ id: r.id, name: 'Renamed', filter: {}, costScrap: 13, observedAt: 3 });
    expect(u2.enabled).toBe(false);
    expect(repo.listRules()).toEqual([u2]);
  });

  it('lists in id order, deletes, and rejects unknown ids', () => {
    const a = repo.upsertRule({ name: 'a', filter: {}, costScrap: 1, observedAt: 1 });
    const b = repo.upsertRule({ name: 'b', filter: {}, costScrap: 1, observedAt: 1, costKeys: 1.5 });
    expect(repo.listRules().map((r) => r.id)).toEqual([a.id, b.id]);
    expect(repo.getRule(b.id)!.costKeys).toBe(1.5);
    repo.deleteRule(a.id);
    expect(repo.getRule(a.id)).toBeNull();
    expect(() => repo.upsertRule({ id: 12345, name: 'x', filter: {}, costScrap: 1, observedAt: 1 })).toThrow(/not found/);
    expect(() => repo.upsertRule({ name: ' ', filter: {}, costScrap: 1, observedAt: 1 })).toThrow(/name/);
  });

  it('disables a rule whose stored filter is unreadable instead of letting it match everything', () => {
    const db = openDatabase(':memory:');
    migrate(db.raw);
    const local = createRepo(db);
    try {
      const good = local.upsertRule({ name: 'good', filter: { qualities: [6] }, costScrap: 1, observedAt: 1 });
      const bad = local.upsertRule({ name: 'bad', filter: { qualities: [6] }, costScrap: 1, observedAt: 1 });
      db.raw.prepare('UPDATE price_rules SET filter_json = ? WHERE id = ?').run('{"qualities":"six"}', bad.id);
      expect(local.getRule(good.id)).toMatchObject({ enabled: true, filter: { qualities: [6] } });
      expect(local.getRule(bad.id)).toMatchObject({ enabled: false, filter: {} });
    } finally {
      local.close();
    }
  });
});

describe('journal', () => {
  it('adds, lists newest first with an optional limit, and deletes', () => {
    const a = repo.addJournal({ ts: 1, side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 0, scrap: 120, keyPriceScrap: 540, note: null });
    const b = repo.addJournal({ ts: 5, side: 'sell', venue: 'backpack.tf', sku: '378;6', name: 'Team Captain', keys: 0.5, scrap: 10, keyPriceScrap: 541, note: 'flip' });
    const c = repo.addJournal({ ts: 3, side: 'buy', venue: 'scrap.tf', sku: 'x', name: 'X', keys: 0, scrap: 1, keyPriceScrap: 540, note: null });
    expect(a).toEqual({ id: a.id, ts: 1, side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 0, scrap: 120, keyPriceScrap: 540, note: null });
    expect(b.note).toBe('flip');
    expect(repo.listJournal().map((e) => e.id)).toEqual([b.id, c.id, a.id]);
    expect(repo.listJournal(2).map((e) => e.id)).toEqual([b.id, c.id]);
    repo.deleteJournal(c.id);
    expect(repo.listJournal().map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it('rejects an invalid side', () => {
    expect(() =>
      repo.addJournal({ ts: 1, side: 'hold' as 'buy', venue: 'v', sku: 's', name: 'n', keys: 0, scrap: 1, keyPriceScrap: 1, note: null }),
    ).toThrow(/side/);
  });
});

describe('item schema', () => {
  const snapshot: SchemaSnapshot = {
    items: [
      {
        defindex: 378,
        name: 'The Team Captain',
        itemName: 'Team Captain',
        properName: true,
        itemClass: 'tf_wearable',
        slot: 'misc',
        craftClass: 'hat',
        usedByClasses: ['Scout', 'Soldier'],
        imageUrl: 'https://steamcdn-a.akamaihd.net/x.png',
      },
      { defindex: 18, name: 'TF_WEAPON_ROCKETLAUNCHER', itemName: 'Rocket Launcher', properName: false, itemClass: 'tf_weapon_rocketlauncher', slot: null, craftClass: null, usedByClasses: [], imageUrl: null },
    ],
    effects: [
      { id: 13, name: 'Burning Flames', canonicalId: 13, type: 'cosmetic' },
      { id: 702, name: 'Isotope', canonicalId: 701, type: 'weapon' },
    ],
    paints: [
      { decimal: 3100495, hex: '2F4F4F', name: 'A Color Similar to Slate', bluHex: null },
      { decimal: 12073019, hex: 'B8383B', name: 'Team Spirit', bluHex: '5885A2' },
    ],
    paintkits: [{ id: 102, name: 'Woodland Warrior' }],
    fetchedAt: 1_791_000_000_000,
    etag: 'W/"abc"',
  };

  it('replaces atomically and reports info', () => {
    expect(repo.schemaInfo()).toEqual({ items: 0, effects: 0, paintkits: 0, loadedAt: null, etag: null });
    repo.replaceSchema(snapshot);
    expect(repo.schemaItem(378)).toEqual(snapshot.items[0]);
    expect(repo.schemaItem(18)).toEqual(snapshot.items[1]);
    expect(repo.schemaItem(1)).toBeNull();
    expect(repo.allSchemaItems().map((i) => i.defindex)).toEqual([18, 378]);
    expect(repo.effects()).toEqual(snapshot.effects);
    expect(repo.paints()).toEqual(snapshot.paints);
    expect(repo.paintkits()).toEqual(snapshot.paintkits);
    expect(repo.schemaInfo()).toEqual({ items: 2, effects: 2, paintkits: 1, loadedAt: 1_791_000_000_000, etag: 'W/"abc"' });

    repo.replaceSchema({ items: [snapshot.items[1]!], effects: [], paints: [], paintkits: [], fetchedAt: 5, etag: null });
    expect(repo.allSchemaItems().map((i) => i.defindex)).toEqual([18]);
    expect(repo.effects()).toEqual([]);
    expect(repo.schemaInfo()).toEqual({ items: 1, effects: 0, paintkits: 0, loadedAt: 5, etag: null });
  });

  it('leaves the old schema in place when the replacement fails', () => {
    repo.replaceSchema(snapshot);
    const bad = { ...snapshot, paintkits: [{ id: 1, name: 'ok' }, null as unknown as { id: number; name: string }], fetchedAt: 9 };
    expect(() => repo.replaceSchema(bad)).toThrow();
    expect(repo.schemaInfo()).toMatchObject({ items: 2, paintkits: 1, loadedAt: 1_791_000_000_000 });
  });
});

describe('imports, request log and snapshots', () => {
  it('creates and lists import batches newest first', () => {
    const a = repo.createImportBatch({ fileName: 'a.html', pageKind: 'buy', fileMtime: 1, importedAt: 10, itemCount: 3 });
    const b = repo.createImportBatch({ fileName: 'b.html', pageKind: 'unusuals', fileMtime: 2, importedAt: 20, itemCount: 0 });
    expect(b).toBeGreaterThan(a);
    expect(repo.listImportBatches(10)).toEqual([
      { id: b, fileName: 'b.html', pageKind: 'unusuals', fileMtime: 2, importedAt: 20, itemCount: 0, categories: null, bank: null },
      { id: a, fileName: 'a.html', pageKind: 'buy', fileMtime: 1, importedAt: 10, itemCount: 3, categories: null, bank: null },
    ]);
    expect(repo.listImportBatches(1)).toHaveLength(1);
  });

  it('keeps the categories a batch stored, cleaned of unknown categories and bad counts (F13)', () => {
    const id = repo.createImportBatch({
      fileName: 'hats.html',
      pageKind: 'buy',
      fileMtime: 1,
      importedAt: 10,
      itemCount: 4,
      // An unknown category (a newer build's, or damage) is dropped, like a count under 1 or not a number.
      categories: { hats: 3, weapons: 1.7, stranges: 0, unusuals: Number.NaN, ...({ nope: 9 } as object) },
    });
    expect(repo.listImportBatches(1)[0]).toMatchObject({ id, categories: { hats: 3, weapons: 1 } });
    const none = repo.createImportBatch({ fileName: 'x.html', pageKind: 'buy', fileMtime: 2, importedAt: 20, itemCount: 0, categories: {} });
    expect(repo.listImportBatches(1)[0]).toMatchObject({ id: none, categories: null });
  });

  it('appends, lists and purges the request log', () => {
    repo.appendRequestLog({ ts: 1, host: 'api.backpack.tf', path: '/api/x?token=REDACTED', method: 'GET', status: 200, ms: 120, bytes: 1000, note: null });
    repo.appendRequestLog({ ts: 2, host: 'pricedb.io', path: '/api/y', method: 'POST', status: 429, ms: 50, bytes: 10, note: 'retry-after 30' });
    expect(repo.recentRequests(10)).toEqual([
      { ts: 2, host: 'pricedb.io', path: '/api/y', method: 'POST', status: 429, ms: 50, bytes: 10, note: 'retry-after 30' },
      { ts: 1, host: 'api.backpack.tf', path: '/api/x?token=REDACTED', method: 'GET', status: 200, ms: 120, bytes: 1000, note: null },
    ]);
    expect(repo.recentRequests(1)).toHaveLength(1);
    expect(repo.purgeRequestLogOlderThan(2)).toBe(1);
    expect(repo.recentRequests(10)).toHaveLength(1);
  });

  it('tracks snapshot times per SKU', () => {
    expect(repo.getSnapshotAt('a')).toBeNull();
    repo.setSnapshotAt('a', 100);
    repo.setSnapshotAt('a', 200);
    repo.setSnapshotAt('b', 50);
    expect(repo.getSnapshotAt('a')).toBe(200);
    expect(repo.getSnapshotAt('b')).toBe(50);
  });
});

describe('persistence across reopen', () => {
  it('keeps data in a file database', () => {
    const t = tempDir();
    try {
      const path = t.file();
      const a = openRepo(path);
      const p = a.upsertScrapPrice({ sku: 's', name: 'S', costScrap: 3, source: 'user', observedAt: 1 });
      a.setSnapshotAt('s', 7);
      a.close();
      const b = openRepo(path);
      expect(b.getScrapPrice(p.id)).toEqual(p);
      expect(b.getSnapshotAt('s')).toBe(7);
      b.close();
    } finally {
      t.cleanup();
    }
  });
});
