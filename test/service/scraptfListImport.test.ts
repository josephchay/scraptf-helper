// F14 end to end through the real core: a scrap.tf/items list the user saved, imported with
// 'import.html' or dropped into the watch folder, reaches the list status, the item drawer, the Live
// market strip and the key price, with one 'scraptf.listChanged' push. Offline (R1, R10): the page is
// a local fixture, only the schema host answers at start, and the test fails on any request after it.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import type { PushEvent } from '../../src/shared/rpc';
import type {
  AppStatus,
  DeepPartial,
  HoldingsResult,
  ImportResult,
  ItemDetail,
  KeyPriceQuote,
  MarketListResult,
  ScraptfListStatus,
  Settings,
} from '../../src/shared/types';
import { listPriceAlreadySaved, listPriceInput, scraptfListView } from '../../src/renderer/itemMenuModel';
import { quickListHint } from '../../src/renderer/quickModel';
import { FakeSocket } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const LIST_HTML = readFileSync(path.join(FIX, 'import/items_list.html'), 'utf8');
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(u.hostname + u.pathname);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
  if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

const NOW = Date.now();
const MIN = 60_000;

/** A saved /items list (the fixture's layout) with these rows: [defindex, name, price to buy, price we pay, "n/limit"]. */
function listPage(rows: [number, string, string, string, string][]): string {
  const tr = rows
    .map(([d, name, sells, pays, limits]) => `<tr data-quality="6" data-defindex="${d}"><td></td><td>${name}</td><td>${sells}</td><td>${pays}</td><td><div rel="tooltip" title="${limits}"></div></td></tr>`)
    .join('');
  return (
    '<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head>' +
    '<body id="pid-items"><table><thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead>' +
    `<tbody>${tr}</tbody></table></body></html>`
  );
}

async function setup(opts: { patch?: DeepPartial<Settings>; quotes?: KeyPriceQuote[] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-list-import-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  if (opts.quotes) {
    const seed = openRepo(path.join(dataDir, DB_FILE_NAME));
    for (const q of opts.quotes) seed.upsertKeyQuote(q);
    seed.close();
  }
  const settings = mergeSettings(
    mergeSettings(DEFAULT_SETTINGS, {
      contactUrl: 'https://github.com/flipdesk-test',
      liveFeed: { enabled: false },
      connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
      import: { enabled: true, acknowledgedAt: NOW - 60 * MIN },
    }),
    opts.patch ?? {},
  );
  const core = createServiceCore({
    dataDir,
    version: '0.4.0',
    settings,
    secrets: {},
    log: createLogger({ dataDir }),
    fetchImpl,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
  });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const listPushes = () => pushes.filter((p) => p.event === 'scraptf.listChanged');
  return { core, call, pushes, listPushes };
}

describe('a saved scrap.tf/items list imported with import.html', () => {
  it('reaches the list status, the drawer and the Live market strip, announced once, with no request', async () => {
    const h = await setup();
    const mtime = NOW - 2 * MIN;
    const r = await h.call<ImportResult>('import.html', { html: LIST_HTML, fileName: 'Item Trading - TF2 - Scrap.TF.html', mtimeMs: mtime });
    expect(r.pageKind).toBe('items-list');

    // One push, after the price change and before import.done (the card refetches on either).
    const order = h.pushes.map((p) => p.event).filter((e) => e === 'prices.changed' || e === 'scraptf.listChanged' || e === 'import.done');
    expect(order).toEqual(['prices.changed', 'scraptf.listChanged', 'import.done']);
    expect(h.listPushes()[0]!.payload).toEqual({ at: expect.any(Number), items: 13 });

    expect(await h.call<ScraptfListStatus>('scraptf.listStatus')).toMatchObject({ items: 13, newestAt: mtime, oldestAt: mtime, pages: 1, importEnabled: true });

    const d = (await h.call<ItemDetail | null>('item.detail', { sku: '126;6', history: false }))!;
    const K = d.keyPrice!.valueScrap;
    expect(d.scraptfList).toEqual({
      sku: '126;6',
      name: "Bill's Hat",
      sellsKeys: 3,
      sellsScrapRaw: 477,
      sellsScrap: 3 * K + 477,
      paysKeys: 3,
      paysScrapRaw: 378,
      paysScrap: 3 * K + 378,
      stock: 2,
      stockLimit: 5,
      full: false,
      observedAt: mtime,
    });
    // Out of stock: no import price (as before), but on the list with what scrap.tf pays.
    const earbuds = (await h.call<ItemDetail | null>('item.detail', { sku: '143;6', history: false }))!;
    expect(earbuds.scrapPrices.filter((p) => p.source === 'import')).toEqual([]);
    expect(earbuds.scraptfList).toMatchObject({ stock: 0, stockLimit: 5, paysScrap: 8 * K + 90, full: false });
    // "Sold out": no price to buy.
    const dandy = (await h.call<ItemDetail | null>('item.detail', { sku: '31193;6', history: false }))!;
    expect(dandy.scraptfList).toMatchObject({ sellsScrap: null, paysScrap: 12, stock: 0 });

    const m = await h.call<MarketListResult>('market.list', {});
    expect(m.scraptf.allItems).toEqual({ label: 'All items', url: SCRAPTF_ITEMS_URL, lastSavedAt: mtime, items: 13 });
    expect(r.listRows).toBe(13);

    // Live market rows join the list per read: Bill's Hat (in stock, so also a known price) carries it,
    // and the "On scrap.tf's list" filter keeps it.
    const row = await vi.waitFor(
      async () => {
        const found = (await h.call<MarketListResult>('market.list', { onScraptfList: true })).rows.find((x) => x.sku === '126;6');
        if (!found) throw new Error('not listed yet');
        return found;
      },
      { timeout: 5000, interval: 50 },
    );
    expect(row).toMatchObject({ scraptfPaysScrap: 3 * K + 378, scraptfStock: 2, scraptfStockLimit: 5, scraptfFull: false, scraptfListAt: mtime });

    // An older copy of the list arriving later changes no row and announces nothing.
    await h.call('import.html', { html: LIST_HTML, fileName: 'old.html', mtimeMs: mtime - 10 * MIN });
    expect(h.listPushes()).toHaveLength(1);
    expect((await h.call<ScraptfListStatus>('scraptf.listStatus')).newestAt).toBe(mtime);

    expect(requested).toEqual([]);
  });

  it('offers no "Use as my price" for a priced row with stock 0, as the import stores no price for it (F14-DM-1)', async () => {
    const h = await setup();
    await h.call('import.html', { html: LIST_HTML, fileName: 'items.html', mtimeMs: NOW - 2 * MIN });
    // Earbuds: "10 keys, 50 refined" to buy, 0/5 in stock. The import skips it as a price.
    const d = (await h.call<ItemDetail | null>('item.detail', { sku: '143;6', history: false }))!;
    expect(d.scraptfList).toMatchObject({ sellsKeys: 10, sellsScrapRaw: 450, stock: 0, stockLimit: 5 });
    expect(d.scrapPrices).toEqual([]);
    const K = d.keyPrice!.valueScrap;
    const view = scraptfListView(d.scraptfList!, K, NOW);
    expect(view).toMatchObject({ hasSells: true, canUse: false, sells: '10 keys 50.00 ref' });
    expect(view.unusable).toMatch(/^Out of stock on scrap\.tf/);
    expect(view.line).toContain('sells 10 keys 50.00 ref');
    expect(listPriceInput(d.scraptfList!, d)).toBeNull();
    // Quick entry shows the line, but no Use.
    const hint = quickListHint(d.scraptfList, '143;6', NOW)!;
    expect(hint).toMatchObject({ price: null });
    expect(hint.text).toMatch(/^sells 10 keys 50\.00 ref · stock 0, saved /);
    expect(hint.title).toContain('Out of stock on scrap.tf');
    // Genuine Shred Alert (0/3) likewise; Bill's Hat (2/5) still can.
    const shred = (await h.call<ItemDetail | null>('item.detail', { sku: '1015;1', history: false }))!;
    expect(shred.scraptfList).toMatchObject({ stock: 0 });
    expect(listPriceInput(shred.scraptfList!, shred)).toBeNull();
    const hat = (await h.call<ItemDetail | null>('item.detail', { sku: '126;6', history: false }))!;
    expect(listPriceInput(hat.scraptfList!, hat)).toMatchObject({ sku: '126;6', costKeys: 3, costScrap: 477 });
    expect(requested).toEqual([]);
  });

  it('tells a painted drawer that its plain copy\'s list price is already saved, so it is not added twice (UI-1)', async () => {
    const h = await setup();
    await h.call('import.html', { html: LIST_HTML, fileName: 'items.html', mtimeMs: NOW - 2 * MIN });
    const PAINTED = '126;6;p15185211';
    const d = (await h.call<ItemDetail | null>('item.detail', { sku: PAINTED, history: false }))!;
    expect(d.scraptfList?.sku).toBe('126;6');
    expect(d.scraptfListSaved).toBe(false);
    const input = listPriceInput(d.scraptfList!, d)!;
    expect(input.sku).toBe('126;6');
    await h.call('prices.upsert', input);

    const again = (await h.call<ItemDetail | null>('item.detail', { sku: PAINTED, history: false }))!;
    // The plain row is never one of the painted SKU's own prices, which is why the flag exists.
    expect(again.scrapPrices.some((p) => p.note === input.note)).toBe(false);
    expect(listPriceAlreadySaved(again.scraptfList!, again.scrapPrices)).toBe(false);
    expect(again.scraptfListSaved).toBe(true);
    // The plain drawer agrees, and a newer list (another date) is a new price to offer.
    expect((await h.call<ItemDetail | null>('item.detail', { sku: '126;6', history: false }))!.scraptfListSaved).toBe(true);
    await h.call('import.html', { html: LIST_HTML, fileName: 'items (1).html', mtimeMs: NOW - MIN });
    expect((await h.call<ItemDetail | null>('item.detail', { sku: PAINTED, history: false }))!.scraptfListSaved).toBe(false);
    expect(requested).toEqual([]);
  });

  it("feeds scrap.tf's key prices from the key row, which caps the key value and revalues the list", async () => {
    const h = await setup({ quotes: [{ source: 'bptf', buyScrap: 560, sellScrap: 565, observedAt: NOW - MIN }] });
    expect((await h.call<AppStatus>('status.get')).keyPrice).toMatchObject({ valueScrap: 560, scraptfFromList: null });

    const page = listPage([
      [5021, 'Mann Co. Supply Crate Key', '60.11 refined', '59.22 refined', '120/400'],
      [378, 'Team Captain', '1 key, 1 refined', '1 key', '5/5'],
    ]);
    await h.call('import.html', { html: page, fileName: 'items.html', mtimeMs: NOW - MIN });

    const kp = (await h.call<AppStatus>('status.get')).keyPrice!;
    expect(kp.scraptfFromList).toEqual({ sellsScrap: 541, paysScrap: 533, observedAt: NOW - MIN });
    // Keys received from buyers are never worth more than scrap.tf pays for one.
    expect(kp.valueScrap).toBe(533);
    const d = (await h.call<ItemDetail | null>('item.detail', { sku: '378;6', history: false }))!;
    expect(d.scraptfList).toMatchObject({ sellsScrap: 533 + 9, paysScrap: 533, full: true });
    expect(h.listPushes()).toHaveLength(1);
    expect(requested).toEqual([]);
  });

  it("gives a held item scrap.tf's bank as its exit, and takes it away when a newer list shows scrap.tf full", async () => {
    const h = await setup();
    await h.call('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '126;6', keys: 1, scrap: 0 });
    const held = async () => (await h.call<HoldingsResult>('holdings.list', {})).rows.find((r) => r.sku === '126;6')!;
    // No backpack.tf buyers here (the feed is off), and no list yet: no exit.
    expect(await held()).toMatchObject({ bestExit: null, exitScrap: null, scraptfPaysScrap: null, status: 'no-buyers' });

    await h.call('import.html', { html: LIST_HTML, fileName: 'items.html', mtimeMs: NOW - 2 * MIN });
    const K = (await h.call<AppStatus>('status.get')).keyPrice!.valueScrap;
    expect(await held()).toMatchObject({
      scraptfPaysScrap: 3 * K + 378,
      scraptfFull: false,
      scraptfListAt: NOW - 2 * MIN,
      bestExit: 'scraptf',
      exitScrap: 3 * K + 378,
      exitVenue: 'scrap.tf',
      status: 'sell',
    });

    // A later save shows scrap.tf at its limit for the hat: it buys no more, so it is no exit.
    await h.call('import.html', { html: listPage([[126, "Bill's Hat", '3 keys, 53 refined', '3 keys, 42 refined', '5/5']]), fileName: 'items (1).html', mtimeMs: NOW - MIN });
    expect(await held()).toMatchObject({ scraptfFull: true, scraptfListAt: NOW - MIN, bestExit: null, exitScrap: null, status: 'no-buyers' });
    expect(h.listPushes()).toHaveLength(2);
    expect(requested).toEqual([]);
  });

  it('stores nothing and announces nothing while import is off (R10)', async () => {
    const h = await setup({ patch: { import: { enabled: false } } });
    await expect(h.call('import.html', { html: LIST_HTML, fileName: 'items.html', mtimeMs: NOW - MIN })).rejects.toThrow(/turned off/);
    expect(await h.call<ScraptfListStatus>('scraptf.listStatus')).toMatchObject({ items: 0, importEnabled: false });
    expect(h.listPushes()).toEqual([]);
  });
});

describe('a scrap.tf/items list saved into the watch folder', () => {
  it('is picked up by the folder watch and reaches the list status', { timeout: 20_000 }, async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-list-watch-'));
    temps.push(folder);
    // As Ctrl+S leaves it: the page in the folder before the watch's first scan.
    const file = path.join(folder, 'Item Trading - TF2 - Scrap.TF.html');
    writeFileSync(file, LIST_HTML);
    const h = await setup({ patch: { import: { watchFolder: folder } } });

    await vi.waitFor(() => expect(h.listPushes()).toHaveLength(1), { timeout: 15_000, interval: 50 });
    const s = await h.call<ScraptfListStatus>('scraptf.listStatus');
    expect(s).toMatchObject({ items: 13, pages: 1, importEnabled: true, watchFolder: folder, watchActive: true, watchError: null });
    expect(Math.abs(s.newestAt! - statSync(file).mtimeMs)).toBeLessThan(1_000);
    expect(h.pushes.some((p) => p.event === 'import.done')).toBe(true);
    expect(requested).toEqual([]);
  });
});
