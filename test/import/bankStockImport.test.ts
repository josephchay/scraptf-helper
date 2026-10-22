// F17 write path: importSavedPage keeps what a recognised saved page had in stock (bank_stock, V6)
// under its own batch, in the import's transaction, then prunes and tells core (ctx.bankStockChanged)
// before pricesChanged. The real parser over the saved-page fixtures; offline, local pages only (R10).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { BANK_STOCK_KEEP_SAVES, BANK_STOCK_PLAIN_KEY, bankStockOnSale } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SKIP_CRAFT_UNPROVEN } from '../../src/shared/importCodes';
import type { ScraptfBank } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const forced = vi.hoisted(() => ({ bank: undefined as ScraptfBank | null | undefined }));

vi.mock('../../src/service/import/scraptfHtml', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/service/import/scraptfHtml')>();
  return {
    ...real,
    parseScrapTfHtml: (...args: Parameters<typeof real.parseScrapTfHtml>) => {
      const r = real.parseScrapTfHtml(...args);
      return forced.bank === undefined ? r : { ...r, bank: forced.bank };
    },
  };
});

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  forced.bank = undefined;
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 3_600_000 } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const engine = { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine;
  /** Calls in order: bankStockChanged:<bank>:<batch>, pricesChanged, push:<event>. */
  const calls: string[] = [];
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    engine,
    settings: () => settings,
    push: (event: string) => calls.push(`push:${event}`),
    pricesChanged: () => calls.push('pricesChanged'),
    scraptfListChanged: quiet,
    // F20: the change feed's import hook (writes no event in these tests).
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: (imported?: { bank: ScraptfBank; batchId: number }) => calls.push(imported ? `bankStockChanged:${imported.bank}:${imported.batchId}` : 'bankStockChanged'),
  } as unknown as HandlerContext;
  const run = (html: string, mtimeMs = NOW - MIN, fileName = 'page.html') => importSavedPage(ctx, { html, fileName, mtimeMs });
  return { repo, run, calls };
}

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

describe('importSavedPage writes the bank stock of a recognised page (F17)', () => {
  it.each<[string, ScraptfBank, string]>([
    ['buy_hats.html', 'hats', '/buy/hats'],
    ['buy_weapons.html', 'weapons', '/buy/weapons'],
    ['buy_stranges.html', 'stranges', '/buy/stranges'],
    ['buy_killstreaks.html', 'killstreaks', '/buy/killstreaks'],
    // Saved from web.archive.org: the scrap.tf page inside the archive link.
    ['buy_skins.html', 'skins', '/buy/skins'],
    ['buy_items.html', 'items', '/buy/items'],
    ['unusuals.html', 'unusuals', '/unusuals'],
    ['items_list.html', 'list', '/items'],
  ])('%s -> one save of %s (page %s), whose rows on sale are exactly the prices it stored', (file, bank, page) => {
    const h = setup();
    const r = h.run(fixture(file), NOW - MIN, file);
    expect(r.bank).toBe(bank);
    expect(h.repo.bankStockSaves(bank)).toEqual([{ batchId: r.batchId, savedAt: NOW - MIN, items: expect.any(Number), page }]);
    const rows = h.repo.bankStockRows(r.batchId);
    expect(rows.length).toBeGreaterThan(0);
    // Keyed as the import keys prices: base SKU (no paint), the extras in the special key.
    for (const row of rows) expect(row.sku).not.toMatch(/;p\d/);
    // Every in-stock card with a price became a price, and the same card is the stock row on sale. 0.7.4: on
    // the /items list a family row (proven neither Craftable nor Non-Craftable) is on sale but no cost.
    const onSale = rows.filter(bankStockOnSale);
    expect(onSale).toHaveLength(r.stored + (r.skippedCounts?.[SKIP_CRAFT_UNPROVEN] ?? 0));
    if (bank !== 'list') expect(r.skippedCounts?.[SKIP_CRAFT_UNPROVEN]).toBeUndefined();
    const prices = h.repo.listScrapPrices().filter((p) => p.importBatch === r.batchId);
    const plainPrice = new Map(prices.filter((p) => p.special === null || (p.special.paint === null && p.special.spells.length === 0 && p.special.parts.length === 0)).map((p) => [p.sku, [p.costKeys, p.costScrap]]));
    for (const row of onSale.filter((x) => x.specialKey === BANK_STOCK_PLAIN_KEY)) {
      if (plainPrice.has(row.sku)) expect([row.costKeys, row.costScrap], row.sku).toEqual(plainPrice.get(row.sku));
    }
    // Core hears of it before the price push, so pages refetching on either read the new stock.
    expect(h.calls.slice(0, 2)).toEqual([`bankStockChanged:${bank}:${r.batchId}`, 'pricesChanged']);
    expect(h.calls).toContain('push:import.done');
  });

  it('keeps sold-out rows: a "Sold out" /items row with no price, a 0-in-stock row', () => {
    const h = setup();
    const r = h.run(fixture('items_list.html'), NOW - MIN, 'items.html');
    const rows = h.repo.bankStockRows(r.batchId);
    const soldOut = rows.filter((x) => !bankStockOnSale(x));
    expect(soldOut.length).toBeGreaterThan(0);
    for (const x of soldOut) expect(x.costScrap === null || x.stock === 0).toBe(true);
    for (const x of rows.filter((y) => y.costScrap === null)) expect(x.costKeys).toBeNull();
  });

  it('keeps painted, spelled and part copies apart from the clean one', () => {
    const h = setup();
    const r = h.run(fixture('buy_stranges.html'));
    const rows = h.repo.bankStockRows(r.batchId);
    const extras = rows.filter((x) => x.specialKey !== BANK_STOCK_PLAIN_KEY);
    expect(extras.length).toBeGreaterThan(0);
    for (const x of extras) expect(() => JSON.parse(x.specialKey)).not.toThrow();
    const keys = rows.map((x) => `${x.sku}|${x.specialKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('writes nothing for a page it did not recognise, and does not call core', () => {
    forced.bank = null;
    const h = setup();
    const r = h.run(fixture('buy_hats.html'));
    expect(r.bank).toBeNull();
    expect(h.repo.bankStockRows(r.batchId)).toEqual([]);
    expect(h.calls.some((c) => c.startsWith('bankStockChanged'))).toBe(false);
  });

  it('adds a save per import and keeps every save of the last day (F20 thinning)', () => {
    const h = setup();
    const ids: number[] = [];
    for (let i = 0; i <= BANK_STOCK_KEEP_SAVES; i++) ids.push(h.run(fixture('buy_hats.html'), NOW - (BANK_STOCK_KEEP_SAVES - i) * MIN, `hats-${i}.html`).batchId);
    expect(h.repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([...ids].reverse());
    expect(h.repo.bankStockLatestPair('hats')).toMatchObject({ newest: { batchId: ids[ids.length - 1] }, previous: { batchId: ids[ids.length - 2] } });
  });

  it('prunes an old file imported late right after writing it, once newer saves of its page exist', () => {
    const h = setup();
    // 0.7.1: a save from before the newest session (yesterday's) is the one the stock page compares with
    // and is kept, so the late file is not needed by anything.
    h.run(fixture('buy_hats.html'), NOW - 2 * 24 * 60 * MIN, 'yesterday.html');
    h.run(fixture('buy_hats.html'), NOW - 2 * MIN, 'newer.html');
    h.run(fixture('buy_hats.html'), NOW - MIN, 'newest.html');
    const r = h.run(fixture('buy_hats.html'), NOW - 91 * 24 * 60 * MIN, 'old.html');
    expect(h.repo.bankStockRows(r.batchId)).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith('bankStockChanged')).pop()).toBe(`bankStockChanged:hats:${r.batchId}`);
    // The only save of a page is its newest and is never thinned, whatever its age.
    const lone = h.run(fixture('buy_weapons.html'), NOW - 200 * 24 * 60 * MIN, 'lone.html');
    expect(h.repo.bankStockRows(lone.batchId).length).toBeGreaterThan(0);
  });

  it('tells core of a prune alone, without an import to name', () => {
    const h = setup();
    const page = (at: number) => {
      const id = h.repo.createImportBatch({ fileName: 'old.html', pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: 1, bank: 'weapons' });
      h.repo.insertBankStock(id, 'weapons', [{ sku: '5;6', specialKey: '', name: 'Shovel', costKeys: 0, costScrap: 1, stock: 1, assetId: null }], '/buy/weapons');
      return id;
    };
    const old = page(NOW - 100 * 24 * 60 * MIN);
    page(NOW - 2 * 60 * MIN);
    page(NOW - 60 * MIN);
    forced.bank = null;
    h.run(fixture('buy_hats.html'));
    expect(h.repo.bankStockRows(old)).toEqual([]);
    expect(h.calls.slice(0, 2)).toEqual(['bankStockChanged', 'pricesChanged']);
  });
});
