// F14 in the browser mock: a seeded scrap.tf/items list (most catalogue items, some out of stock,
// some full, pages of mixed ages, the key row), 'scraptf.listStatus', 'scraptf.listChanged' after a
// mock list import, and the list fields in market, holdings, the drawer and the key price, so the
// renderer can be built in `npm run dev:renderer`. Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG, MOCK_KEY_SCRAP, MOCK_LIST_PAGES, seedScraptfList } from '../../src/renderer/mockData';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import { MARKET_MAX_LIMIT } from '../../src/shared/market';
import { PUSH_EVENTS, SERVICE_METHODS, type PushContract } from '../../src/shared/rpc';
import { SCRAPTF_LIST_FRESH_MS, bestExitOf, scraptfListLookup, valueScraptfListRow } from '../../src/shared/scraptfList';
import { KEY_SKU } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('contract', () => {
  it('scraptf.listStatus is a service method and scraptf.listChanged a push event', () => {
    expect(SERVICE_METHODS).toContain('scraptf.listStatus');
    expect(PUSH_EVENTS).toContain('scraptf.listChanged');
  });
});

describe('seeded list', () => {
  const rows = seedScraptfList(T0);

  it('covers most catalogue items, plain copies only, with the key row', () => {
    const plain = CATALOG.filter((c) => !/;p\d/.test(c.sku));
    const listed = new Set(rows.map((r) => r.sku));
    expect(plain.filter((c) => listed.has(c.sku)).length).toBeGreaterThan(plain.length * 0.7);
    expect(rows.some((r) => /;p\d/.test(r.sku))).toBe(false);
    expect(listed.has(KEY_SKU)).toBe(true);
    expect(new Set(rows.map((r) => r.sku)).size).toBe(rows.length);
  });

  it('has out-of-stock and full rows, rows without a pays price, and pages of mixed ages', () => {
    expect(rows.some((r) => r.stock === 0)).toBe(true);
    expect(rows.some((r) => r.stock !== null && r.stockLimit !== null && r.stock >= r.stockLimit && r.stock > 0)).toBe(true);
    const ages = new Set(rows.map((r) => T0 - r.observedAt));
    expect([...ages].sort((a, b) => a - b)).toEqual(MOCK_LIST_PAGES.map((p) => p.ageMs).sort((a, b) => a - b));
    expect(MOCK_LIST_PAGES.some((p) => p.ageMs > SCRAPTF_LIST_FRESH_MS)).toBe(true);
    for (const r of rows) {
      expect(Number.isInteger(r.sellsScrap) && r.sellsScrap! >= 0).toBe(true);
      if (r.paysScrap !== null) expect(Number.isInteger(r.paysScrap)).toBe(true);
    }
  });

  it('is deterministic', () => {
    expect(seedScraptfList(T0)).toEqual(rows);
  });
});

describe("'scraptf.listStatus'", () => {
  it('reports the list and the import switches', async () => {
    const b = make();
    const rows = seedScraptfList(T0);
    const s = await b.rpc('scraptf.listStatus', undefined);
    expect(s).toEqual({
      items: rows.length,
      newestAt: T0 - Math.min(...MOCK_LIST_PAGES.map((p) => p.ageMs)),
      oldestAt: T0 - Math.max(...MOCK_LIST_PAGES.map((p) => p.ageMs)),
      pages: MOCK_LIST_PAGES.length,
      importEnabled: false,
      watchFolder: null,
      watchActive: false,
      watchError: null,
    });
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'C:\\pages' } });
    expect(await b.rpc('scraptf.listStatus', undefined)).toMatchObject({ importEnabled: true, watchFolder: 'C:\\pages', watchActive: true, watchError: null });
  });
});

describe('the list in every feature', () => {
  it('fills the Live market rows and the "All items" chip', async () => {
    const b = make();
    const res = await b.rpc('market.list', { limit: MARKET_MAX_LIMIT });
    expect(res.scraptf.allItems).toEqual({ label: 'All items', url: SCRAPTF_ITEMS_URL, lastSavedAt: T0 - 3 * MIN, items: seedScraptfList(T0).length });
    const K = res.keyPrice!.valueScrap;
    const byStored = new Map(seedScraptfList(T0).map((r) => [r.sku, r]));
    let onList = 0;
    for (const r of res.rows) {
      // 0.7.4: a copy with no row of its own (a killstreak or Non-Craftable one) reads its family's unmarked row.
      const s = scraptfListLookup((sku) => byStored.get(sku), r.sku)?.stored;
      if (!s) {
        expect(r).toMatchObject({ scraptfPaysScrap: null, scraptfStock: null, scraptfStockLimit: null, scraptfFull: false, scraptfListAt: null });
        continue;
      }
      onList++;
      const v = valueScraptfListRow(s, K);
      expect(r).toMatchObject({ scraptfPaysScrap: v.paysScrap, scraptfStock: v.stock, scraptfStockLimit: v.stockLimit, scraptfFull: v.full, scraptfListAt: v.observedAt });
    }
    expect(onList).toBeGreaterThan(res.rows.length / 2);
    expect(res.rows.some((r) => r.scraptfFull)).toBe(true);
  });

  it('filters to rows on the list, counting chips after the filter', async () => {
    const b = make();
    const all = await b.rpc('market.list', { limit: MARKET_MAX_LIMIT });
    const listed = await b.rpc('market.list', { limit: MARKET_MAX_LIMIT, onScraptfList: true });
    expect(listed.total).toBeLessThan(all.total);
    expect(listed.rows.every((r) => r.scraptfListAt !== null)).toBe(true);
    expect(Object.values(listed.counts).reduce((a, n) => a + n, 0)).toBe(listed.total);
  });

  it("gives held items scrap.tf's exit when it is better, and keeps every status", async () => {
    const b = make();
    const res = await b.rpc('holdings.list', {});
    for (const r of res.rows) {
      const exit = bestExitOf(r.revenueScrap, r.scraptfListAt === null ? null : { paysScrap: r.scraptfPaysScrap, full: r.scraptfFull, observedAt: r.scraptfListAt }, T0);
      expect(r).toMatchObject(exit);
    }
    // Earbuds: scrap.tf pays more than the buyers (still a loss); the jacket: scrap.tf is full.
    expect(res.rows.find((r) => r.sku === '143;6')).toMatchObject({ bestExit: 'scraptf', exitVenue: 'scrap.tf', status: 'loss' });
    expect(res.rows.find((r) => r.sku === '30359;6')).toMatchObject({ scraptfFull: true, bestExit: null, status: 'no-buyers' });
    expect(new Set(res.rows.map((r) => r.status))).toEqual(new Set(['sell', 'hold', 'loss', 'no-buyers']));
  });

  it('puts the base row in the drawer, painted copies included', async () => {
    const b = make();
    const d = (await b.rpc('item.detail', { sku: '378;6' }))!;
    expect(d.scraptfList).toMatchObject({ sku: '378;6', stock: 2, stockLimit: 5, full: false });
    const painted = await b.rpc('item.detail', { sku: '378;6;p15185211' });
    expect(painted?.scraptfList?.sku).toBe('378;6');
  });

  it("shows scrap.tf's key prices from the list without moving the mock key value", async () => {
    const b = make();
    const kp = (await b.rpc('status.get', undefined)).keyPrice!;
    expect(kp.valueScrap).toBe(MOCK_KEY_SCRAP);
    expect(kp.scraptfFromList).toEqual({ sellsScrap: MOCK_KEY_SCRAP + 15, paysScrap: MOCK_KEY_SCRAP + 6, observedAt: T0 - 3 * MIN });
    // A typed scrap.tf key price newer than the list wins, and caps the key value.
    await b.rpc('settings.set', { keyPrice: { scraptfSellScrap: 560, scraptfObservedAt: T0 } });
    expect((await b.rpc('status.get', undefined)).keyPrice!.valueScrap).toBe(560);
  });
});

describe('mock list import', () => {
  it('re-dates the list from a saved /items page and pushes scraptf.listChanged', async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const changed: PushContract['scraptf.listChanged'][] = [];
    const done: PushContract['import.done'][] = [];
    b.on('scraptf.listChanged', (p) => changed.push(p));
    b.on('import.done', (p) => done.push(p));
    const r = await b.rpc('import.html', { html: '<html></html>', fileName: 'scrap.tf - Items.html', mtimeMs: T0 - 30_000 });
    expect(r.pageKind).toBe('items-list');
    expect(r.listRows).toBe(seedScraptfList(T0).length);
    expect(changed).toEqual([{ at: T0, items: seedScraptfList(T0).length }]);
    expect(done).toHaveLength(1);
    const s = await b.rpc('scraptf.listStatus', undefined);
    expect(s).toMatchObject({ newestAt: T0 - 30_000, pages: 1 });
    // The day-old page is fresh again, so the Live market chip moves too.
    expect((await b.rpc('market.list', {})).scraptf.allItems.lastSavedAt).toBe(T0 - 30_000);
  });

  it('pushes nothing for an older copy of the list, as the service does', async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const changed: unknown[] = [];
    b.on('scraptf.listChanged', (p) => changed.push(p));
    const r = await b.rpc('import.html', { html: '<html></html>', fileName: 'items.html', mtimeMs: 1 });
    expect(r.listRows).toBe(0);
    expect(changed).toEqual([]);
  });

  it('pushes nothing for another saved page', async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const changed: unknown[] = [];
    b.on('scraptf.listChanged', (p) => changed.push(p));
    await b.rpc('import.html', { html: '<html></html>', fileName: 'scrap.tf - Buy Hats.html', mtimeMs: T0 });
    await b.rpc('import.pickFile', undefined);
    expect(changed).toEqual([]);
  });
});
