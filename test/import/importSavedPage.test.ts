// importSavedPage: how a saved page's prices replace earlier imported ones.
// Offline only (R10): the pages are built here or read from test/fixtures/import.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { fromString } from '../../src/shared/sku';
import { FakeClock, FakeTimers, makeDeps } from '../domain/helpers';
import { openRepo } from '../../src/service/db';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SKIP_BANK_CARD_PRICE, SKIP_CRAFT_UNPROVEN, SKIP_SAME_OR_CHEAPER } from '../../src/shared/importCodes';
import { scraptfListKeyOf } from '../../src/shared/scraptfList';
import { KEY_SKU, type ImportResult, type ScrapPrice } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const KEY_SCRAP = 600;
const PINK = 16738740;

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup(schema: SchemaService = createStubSchema(), wrapRepo: (r: Repo) => Repo = (r) => r) {
  const real = openRepo(':memory:');
  repos.push(real);
  const repo = wrapRepo(real);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 3_600_000 } });
  const dirty: string[] = [];
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const engine = {
    keyPrice: () => ({ valueScrap: KEY_SCRAP }),
    markDirty: (skus: Iterable<string>) => dirty.push(...skus),
  } as unknown as Engine;
  /** Calls in order: pricesChanged, scraptfListChanged, push:<event>. */
  const calls: string[] = [];
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    engine,
    settings: () => settings,
    push: (event: string) => calls.push(`push:${event}`),
    pricesChanged: () => calls.push('pricesChanged'),
    scraptfListChanged: () => calls.push('scraptfListChanged'),
    // F17: not in `calls`, whose order the F14 tests pin (test/import/bankStockImport.test.ts covers it).
    // F20: the change feed's import hook (writes no event in these tests).
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: quiet,
  } as unknown as HandlerContext;
  const run = (html: string, mtimeMs: number, fileName = 'page.html'): ImportResult => importSavedPage(ctx, { html, fileName, mtimeMs });
  const imported = (sku: string): ScrapPrice[] => repo.scrapPricesForSku(sku).filter((p) => p.source === 'import');
  return { repo, run, imported, dirty, settings, calls };
}

/** A saved bank page (/buy/hats) with the given cards. */
function bankPage(cards: Record<string, string>[]): string {
  const html = cards
    .map((attrs) => {
      const a = Object.entries({ 'data-appid': '440', class: 'item hoverable quality6 rarity app440', ...attrs })
        .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
        .join(' ');
      return `<div ${a}></div>`;
    })
    .join('\n');
  return `<!DOCTYPE html>\n<!-- saved from url=(0024)https://scrap.tf/buy/hats -->\n<html><head><title>Hats</title></head><body>${html}</body></html>`;
}

/** A saved /items price list with the given rows ("n/limit" is the stock cell; "Price we pay" 1 refined unless given). */
function itemsPage(rows: { defindex: number; name: string; price: string; stock: string; pays?: string }[]): string {
  const tr = rows
    .map(
      (r) =>
        `<tr data-quality="6" data-defindex="${r.defindex}"><td></td><td>${r.name}</td><td>${r.price}</td><td>${r.pays ?? '1 refined'}</td><td><div rel="tooltip" title="${r.stock}"></div></td></tr>`,
    )
    .join('\n');
  return (
    '<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head>' +
    '<body id="pid-items"><table><thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead>' +
    `<tbody>${tr}</tbody></table></body></html>`
  );
}

const plainCaptain = (value: number) => ({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': String(value) });
const pinkCaptain = (value: number) => ({ ...plainCaptain(value), 'data-content': 'Painted Pink as Hell' });
const billsHat = (value: number) => ({ 'data-defindex': '126', 'data-title': "Bill's Hat", 'data-item-value': String(value) });

describe('importSavedPage: stock on the /items price list', () => {
  it('does not store rows scrap.tf has none of, and says why', () => {
    const h = setup();
    const r = h.run(fixture('items_list.html'), NOW - 60_000, 'items.html');
    expect(r.pageKind).toBe('items-list');
    // Earbuds ("0/5", priced) and Crocodile Dandy ("0/5", "Sold out").
    expect(h.imported('143;6')).toEqual([]);
    expect(h.imported('31193;6')).toEqual([]);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { reason: 'out of stock on scrap.tf', title: 'Earbuds' },
        { reason: 'out of stock on scrap.tf', title: 'Crocodile Dandy' },
      ]),
    );
    // 0.7.4: a row in stock is a cost only when it is proven to price its copy (the Non-Craftable Tour of
    // Duty Ticket says so); an unmarked row is a family row, kept on the list only.
    expect(h.imported('725;6;uncraftable').map((p) => [p.costKeys, p.costScrap, p.stock])).toEqual([[0, 273, 44]]);
    expect(h.imported('126;6')).toEqual([]);
    expect(r.skipped).toContainEqual({ reason: SKIP_CRAFT_UNPROVEN, title: 'Bills Hat' });
    expect(r.stored).toBe(h.repo.listScrapPrices().filter((p) => p.source === 'import').length);
  });

  it("removes an earlier list price of a sold-out row, never a bank page's own prices (0.7.4)", () => {
    const h = setup();
    h.run(bankPage([plainCaptain(100), pinkCaptain(140)]), NOW - 180_000, 'hats.html');
    expect(h.imported('378;6')).toHaveLength(2);
    // A Non-Craftable row (named so) in stock is a cost, tagged to the list.
    const nc = (stock: string) => itemsPage([{ defindex: 378, name: 'Non-Craftable Team Captain', price: '2 refined', stock }]);
    h.run(nc('3/5'), NOW - 120_000, 'items.html');
    expect(h.imported('378;6;uncraftable').map((p) => [p.bank, p.costScrap])).toEqual([['list', 18]]);
    h.dirty.length = 0;

    const r = h.run(
      itemsPage([
        { defindex: 378, name: 'Team Captain', price: '2 refined', stock: '0/5' },
        { defindex: 378, name: 'Non-Craftable Team Captain', price: '2 refined', stock: '0/5' },
      ]),
      NOW - 60_000,
      'items.html',
    );
    expect(r.stored).toBe(0);
    expect(r.skipped).toEqual([
      { reason: 'out of stock on scrap.tf', title: 'Team Captain' },
      { reason: 'out of stock on scrap.tf', title: 'Non-Craftable Team Captain' },
    ]);
    expect(h.imported('378;6;uncraftable')).toEqual([]);
    // The hats bank's own plain and painted prices are that bank's to remove (its next whole save).
    const bank = h.imported('378;6').map((p) => [p.special?.paint ?? null, p.costScrap, p.bank]);
    expect(bank).toHaveLength(2);
    expect(bank).toEqual(expect.arrayContaining([[null, 100, 'hats'], [PINK, 140, 'hats']]));
    expect(h.dirty).toContain('378;6;uncraftable');
  });
});

describe('importSavedPage: the /items list replaces only plain copies', () => {
  it("never re-tags a bank page's own price of a copy, and keeps painted copies imported from a bank page (0.7.4)", () => {
    const h = setup();
    h.run(bankPage([plainCaptain(100), pinkCaptain(140)]), NOW - 120_000, 'hats.html');
    const before = h.imported('378;6');
    const plainId = before.find((p) => p.special?.paint === null)!.id;
    const pinkId = before.find((p) => p.special?.paint === PINK)!.id;

    // The page lists the Non-Craftable copy apart, so this row is proven the Craftable one: still the bank's.
    const r = h.run(
      itemsPage([
        { defindex: 378, name: 'Team Captain', price: '2 refined', stock: '3/5' },
        { defindex: 378, name: 'Non-Craftable Team Captain', price: '1 refined', stock: '0/5' },
      ]),
      NOW - 60_000,
      'items.html',
    );
    expect(r.stored).toBe(0);
    expect(r.skipped).toContainEqual({ reason: SKIP_BANK_CARD_PRICE, title: 'Team Captain' });
    const after = h.imported('378;6');
    expect(after).toHaveLength(2);
    // Its bank, price, stock and time stay the bank page's: the list's stock counts copies the bank may not offer.
    const plain = after.find((p) => p.id === plainId);
    expect(plain).toMatchObject({ costScrap: 100, bank: 'hats', observedAt: NOW - 120_000 });
    expect(after.find((p) => p.id === pinkId)).toMatchObject({ costScrap: 140, special: expect.objectContaining({ paint: PINK }) });
    expect(h.repo.scraptfListRow('378;6')).toMatchObject({ sellsScrap: 18, stock: 3, craft: 'craftable' });
  });

  it('keeps the painted Crocodile Dandy from the saved hats bank when the saved /items list follows', () => {
    const h = setup();
    h.run(fixture('buy_hats.html'), NOW - 120_000, 'hats.html');
    const painted = h.imported('31193;6').filter((p) => p.special !== null && p.special.paint !== null);
    expect(painted.length).toBeGreaterThan(0);
    h.run(fixture('items_list.html'), NOW - 60_000, 'items.html');
    const after = h.imported('31193;6');
    for (const p of painted) expect(after).toContainEqual(p);
  });

  it('still lets a bank page replace every copy of the items it lists', () => {
    const h = setup();
    h.run(bankPage([plainCaptain(100), pinkCaptain(140)]), NOW - 120_000, 'hats.html');
    h.run(bankPage([plainCaptain(90)]), NOW - 60_000, 'hats (1).html');
    expect(h.imported('378;6').map((p) => [p.special?.paint ?? null, p.costScrap])).toEqual([[null, 90]]);
  });
});

describe('importSavedPage: an older page never overwrites a newer one', () => {
  it('keeps the newer price when an older page arrives later, and reports it', () => {
    const h = setup();
    h.run(bankPage([plainCaptain(50)]), NOW - 60_000, 'Buy Hats - Scrap.TF (1).html');
    const r = h.run(bankPage([plainCaptain(100), billsHat(20)]), NOW - 120_000, 'Buy Hats - Scrap.TF.html');

    expect(h.imported('378;6').map((p) => [p.costScrap, p.observedAt])).toEqual([[50, NOW - 60_000]]);
    expect(r.skipped).toContainEqual({ reason: 'a newer saved page already set this price', title: 'Team Captain' });
    // 0.7.4 (F31, F56): a card the newer whole save of this one-page bank does not show sold after the older
    // page, so it is not taken from it (before, it was, and no later save ever removed it).
    expect(h.imported('126;6')).toEqual([]);
    // 0.7.4 (R05): no newer page priced it; the newer save does not show it on sale.
    expect(r.skipped).toContainEqual({ reason: 'a newer save of its bank page does not show it on sale', title: "Bill's Hat" });
    expect(r.stored).toBe(0);
  });

  it('does not delete copies a newer page stored', () => {
    const h = setup();
    h.run(bankPage([pinkCaptain(140)]), NOW - 60_000, 'new.html');
    h.run(bankPage([plainCaptain(100)]), NOW - 120_000, 'old.html');
    expect(h.imported('378;6').some((p) => p.special?.paint === PINK && p.costScrap === 140)).toBe(true);
  });

  it('does not let an older sold-out row remove a newer price', () => {
    const h = setup();
    // 0.7.4: a Non-Craftable row (named so) is proven to price its copy, so it is a cost.
    h.run(itemsPage([{ defindex: 378, name: 'Non-Craftable Team Captain', price: '2 refined', stock: '3/5' }]), NOW - 60_000, 'new.html');
    h.run(itemsPage([{ defindex: 378, name: 'Non-Craftable Team Captain', price: '2 refined', stock: '0/5' }]), NOW - 120_000, 'old.html');
    expect(h.imported('378;6;uncraftable').map((p) => [p.costScrap, p.stock])).toEqual([[18, 3]]);
  });

  it('treats a newer imported price with unrecorded extras as the plain copy, not as a second one', () => {
    const h = setup();
    // Imported before extras were recorded: special is null.
    h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 50, source: 'import', observedAt: NOW - 60_000, special: null });
    const r = h.run(bankPage([plainCaptain(100)]), NOW - 120_000, 'old.html');
    expect(h.imported('378;6').map((p) => [p.costScrap, p.observedAt])).toEqual([[50, NOW - 60_000]]);
    expect(r.skipped).toContainEqual({ reason: 'a newer saved page already set this price', title: 'Team Captain' });
    expect(r.stored).toBe(0);
  });

  it('updates an older imported price with unrecorded extras in place', () => {
    const h = setup();
    const old = h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 50, source: 'import', observedAt: NOW - 120_000, special: null });
    // 0.7.4: proven the Craftable copy by its Non-Craftable sibling row (an untagged price is no bank's card).
    h.run(
      itemsPage([
        { defindex: 378, name: 'Team Captain', price: '2 refined', stock: '3/5' },
        { defindex: 378, name: 'Non-Craftable Team Captain', price: '1 refined', stock: '0/5' },
      ]),
      NOW - 60_000,
      'items.html',
    );
    expect(h.imported('378;6').map((p) => [p.id, p.costScrap, p.special?.paint ?? null])).toEqual([[old.id, 18, null]]);
  });

  it('re-importing the same file (same mtime) still updates it', () => {
    const h = setup();
    h.run(bankPage([plainCaptain(50)]), NOW - 60_000);
    const r = h.run(bankPage([plainCaptain(45)]), NOW - 60_000);
    expect(r.stored).toBe(1);
    expect(h.imported('378;6').map((p) => p.costScrap)).toEqual([45]);
  });
});

describe('importSavedPage: two cards of one item on a page', () => {
  // 0.7.2: the cheapest-wins rule, pinned for a plain item as importBank.test.ts pins it for a kit.
  it.each([
    ['the cheaper card first', [60, 100]],
    ['the cheaper card last', [100, 60]],
  ])('stores one price, the cheaper card (%s), and counts the other as skipped', (_, values) => {
    const h = setup();
    const r = h.run(bankPage(values.map((v) => plainCaptain(v))), NOW - 60_000);
    expect([r.parsed, r.stored, r.skippedCounts]).toEqual([2, 1, { [SKIP_SAME_OR_CHEAPER]: 1 }]);
    expect(r.skipped).toEqual([{ reason: SKIP_SAME_OR_CHEAPER, title: 'Team Captain' }]);
    expect(h.imported('378;6').map((p) => [p.costScrap, p.observedAt])).toEqual([[60, NOW - 60_000]]);
  });
});

describe('importSavedPage: a saved page keeps the bank page it was (F13 coverage)', () => {
  it('records the categories it stored, and a later /items list leaves its rows and its chip as they are', () => {
    const HATS = new Set([378, 126]);
    const stub = createStubSchema();
    const schema: SchemaService = { ...stub, categoryForSku: (sku) => (HATS.has(fromString(sku).defindex) ? 'hats' : 'other') };
    const h = setup(schema);
    const clock = new FakeClock(NOW);
    const timers = new FakeTimers(clock);
    const market = createMarketIndex({
      ...makeDeps(h.repo, clock, () => h.settings),
      schema,
      timers,
      keyPrice: () => selectKeyPrice([], h.settings, clock.now()),
      onChanged: () => undefined,
      folderWatchActive: () => true,
    });
    market.start();
    timers.advance(0);
    const hatsChip = () => market.list({}, clock.now()).scraptf.coverage.find((c) => c.category === 'hats');

    const page = h.run(bankPage([plainCaptain(100), billsHat(60)]), NOW - 10 * 60_000, 'hats.html');
    expect(h.repo.listImportBatches(1)[0]).toMatchObject({ id: page.batchId, pageKind: 'buy', itemCount: 2, categories: { hats: 2 } });
    market.pricesChanged();
    expect(hatsChip()).toMatchObject({ lastSavedAt: NOW - 10 * 60_000, items: 2 });

    // The /items list lists the same two items: 0.7.4, it never re-tags a bank page's rows (their bank decides).
    h.run(
      itemsPage([
        { defindex: 378, name: 'Team Captain', price: '2 refined', stock: '3/5' },
        { defindex: 126, name: "Bill's Hat", price: '1 refined', stock: '2/5' },
      ]),
      NOW - 5 * 60_000,
      'items.html',
    );
    expect([...h.imported('378;6'), ...h.imported('126;6')].map((p) => p.importBatch)).toEqual([page.batchId, page.batchId]);
    market.pricesChanged();
    // Still the hats page saved 10 minutes ago, not "never saved"; the list counts for no page.
    expect(hatsChip()).toMatchObject({ lastSavedAt: NOW - 10 * 60_000, items: 2 });
    market.stop();
  });
});

describe('importSavedPage: the saved scrap.tf price list (F14)', () => {
  const captain = (price: string, stock: string, pays?: string) => ({ defindex: 378, name: 'Team Captain', price, stock, ...(pays !== undefined ? { pays } : {}) });

  it('stores every /items row with a SKU, out of stock included, at the file time and under the batch', () => {
    const h = setup();
    const r = h.run(fixture('items_list.html'), NOW - 60_000, 'items.html');
    const list = h.repo.scraptfList();
    expect(list).toHaveLength(13);
    expect(list.every((l) => l.batchId === r.batchId && l.observedAt === NOW - 60_000)).toBe(true);
    expect(h.repo.scraptfListRow('126;6')).toEqual({
      sku: '126;6',
      name: "Bill's Hat",
      sellsKeys: 3,
      sellsScrap: 477,
      paysKeys: 3,
      paysScrap: 378,
      stock: 2,
      stockLimit: 5,
      batchId: r.batchId,
      observedAt: NOW - 60_000,
      // 0.7.4: unmarked, with no Non-Craftable row beside it: a family row.
      craft: 'any',
      // 0.7.4 (F60): the list page it was read on.
      page: '/items',
    });
    expect(h.repo.scraptfListRow('725;6;uncraftable')).toMatchObject({ craft: 'uncraftable' });
    expect(h.repo.scraptfListRow('5833;6')).toMatchObject({ stock: 49, stockLimit: 50 });
    // Out of stock: no import price (unchanged), but scrap.tf still buys it, so it is on the list.
    expect(h.imported('143;6')).toEqual([]);
    expect(h.repo.scraptfListRow('143;6')).toMatchObject({ sellsKeys: 10, sellsScrap: 450, paysKeys: 8, paysScrap: 90, stock: 0, stockLimit: 5 });
    expect(h.repo.scraptfListRow('1015;1')).toMatchObject({ stock: 0, stockLimit: 3, paysKeys: 3, paysScrap: 180 });
    // "Sold out": no price to buy, still what scrap.tf pays.
    expect(h.repo.scraptfListRow('31193;6')).toMatchObject({ sellsKeys: null, sellsScrap: null, paysKeys: 0, paysScrap: 12, stock: 0, stockLimit: 5 });
    // 0.7.4: of the 10 rows in stock only the one proven to price its copy is a cost (the Non-Craftable
    // ticket); the 9 family rows are on the list only.
    expect(r.stored).toBe(1);
    expect(r.skippedCounts?.[SKIP_CRAFT_UNPROVEN]).toBe(9);
    // The result says how many list rows the save wrote, so the Import page can show the whole list.
    expect(r.listRows).toBe(13);
    expect(h.repo.listScrapPrices().filter((p) => p.source === 'import')).toHaveLength(1);
  });

  it('announces the list change after the price change and before import.done', () => {
    const h = setup();
    h.run(fixture('items_list.html'), NOW - 60_000, 'items.html');
    expect(h.calls).toEqual(['pricesChanged', 'scraptfListChanged', 'push:import.done']);
  });

  it('writes no list rows for a bank page, which has no "Price we pay" column, and announces none', () => {
    const h = setup();
    const r = h.run(fixture('buy_hats.html'), NOW - 60_000, 'hats.html');
    expect(r.stored).toBeGreaterThan(0);
    expect(r.listRows).toBeUndefined();
    expect(h.repo.scraptfList()).toEqual([]);
    expect(h.calls).toEqual(['pricesChanged', 'push:import.done']);
  });

  it('dates rows at the import time when the file has no usable time, and never in the future', () => {
    for (const mtime of [0, -5, Number.NaN, NOW + 3_600_000]) {
      const h = setup();
      h.run(itemsPage([captain('2 refined', '3/5')]), mtime, 'items.html');
      expect(h.repo.scraptfListRow('378;6')?.observedAt).toBe(NOW);
    }
  });

  it('merges list pages by SKU, newest wins, and an older copy saved earlier changes nothing', () => {
    const h = setup();
    const p1 = h.run(itemsPage([captain('2 refined', '3/5', '1.33 refined'), { defindex: 126, name: "Bill's Hat", price: '1 refined', stock: '2/5' }]), NOW - 60_000, 'items.html');
    const p2 = h.run(itemsPage([captain('3 refined', '4/5', '2 refined')]), NOW - 30_000, 'items (2).html');
    // 0.7.4 (F60, R02): the newer save is a whole save of the same page (/items), so the row it no longer
    // lists is retired; the row it lists is the newest.
    expect(h.repo.scraptfList().map((r) => [r.sku, r.sellsScrap, r.paysScrap, r.stock, r.batchId])).toEqual([['378;6', 27, 18, 4, p2.batchId]]);

    h.calls.length = 0;
    const old = h.run(itemsPage([captain('1 refined', '1/5')]), NOW - 120_000, 'old.html');
    expect(old.listRows).toBe(0);
    expect(h.repo.scraptfListRow('378;6')).toMatchObject({ sellsScrap: 27, stock: 4, batchId: p2.batchId, observedAt: NOW - 30_000 });
    // Nothing on the list changed, so nothing is announced.
    expect(h.calls).toEqual(['pricesChanged', 'push:import.done']);

    // Saving the same file again (same time) rewrites its rows.
    h.calls.length = 0;
    h.run(itemsPage([captain('4 refined', '5/5')]), NOW - 30_000, 'items (2).html');
    expect(h.repo.scraptfListRow('378;6')).toMatchObject({ sellsScrap: 36, stock: 5, stockLimit: 5 });
    expect(h.calls).toContain('scraptfListChanged');
  });

  it('writes no row and no price for rows of one item that differ, and says so (0.7.4)', () => {
    const h = setup();
    const r = h.run(itemsPage([captain('Sold out', '0/5', '1 refined'), captain('2 refined', '1/5', '1.33 refined'), captain('3 refined', '2/5', '1.66 refined')]), NOW - 60_000);
    expect(h.repo.scraptfList()).toHaveLength(0);
    expect(h.imported('378;6')).toEqual([]);
    expect(r.warnings).toContainEqual(expect.stringMatching(/^duplicate-rows: 3 rows/));
    expect(r.skippedCounts?.['duplicate-row']).toBe(3);
  });

  it('stores an identical repeat of a row once, with no warning (0.7.4)', () => {
    const h = setup();
    const r = h.run(itemsPage([captain('2 refined', '1/5', '1.33 refined'), captain('2 refined', '1/5', '1.33 refined')]), NOW - 60_000);
    expect(r.parsed).toBe(1);
    expect(h.repo.scraptfListRow('378;6')).toMatchObject({ sellsScrap: 18, paysScrap: 12, stock: 1 });
    expect(r.warnings.some((w) => w.startsWith('duplicate-row'))).toBe(false);
  });

  it('skips a row that shows neither price; one with either is kept', () => {
    const h = setup();
    h.run(
      itemsPage([
        captain('Sold out', '0/5', '—'),
        { defindex: 126, name: "Bill's Hat", price: '1 refined', stock: '2/5', pays: '' },
        { defindex: 30621, name: 'Burstchester', price: 'Sold out', stock: '0/2', pays: '60 keys' },
      ]),
      NOW - 60_000,
    );
    expect(h.repo.scraptfList().map((r) => [r.sku, r.sellsScrap, r.paysKeys, r.paysScrap])).toEqual([
      ['126;6', 9, null, null],
      ['30621;6', null, 60, 0],
    ]);
  });

  it("carries scrap.tf's own key prices (the Mann Co. key row) for the key price, in metal", () => {
    const h = setup();
    h.run(itemsPage([{ defindex: 5021, name: 'Mann Co. Supply Crate Key', price: '60.11 refined', stock: '120/400', pays: '59.22 refined' }]), NOW - 60_000);
    expect(scraptfListKeyOf(h.repo.scraptfListRow(KEY_SKU))).toEqual({ sellsScrap: 541, paysScrap: 533, observedAt: NOW - 60_000 });
  });

  it('writes the prices and the list in one transaction', () => {
    const failing = (r: Repo): Repo =>
      new Proxy(r, {
        get: (t, k, rcv) =>
          k === 'upsertScraptfList'
            ? () => {
                throw new Error('disk full');
              }
            : Reflect.get(t, k, rcv),
      });
    const h = setup(createStubSchema(), failing);
    expect(() => h.run(fixture('items_list.html'), NOW - 60_000, 'items.html')).toThrow(/disk full/);
    expect(h.repo.listImportBatches(10)).toEqual([]);
    expect(h.repo.listScrapPrices()).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});

describe('importSavedPage: skipped counts (0.7.1, P5)', () => {
  it('counts a skip by its code, never by the card text its warning quotes', () => {
    const h = setup();
    // A card whose indicator reads 0 ref is no price, and its first warning quotes its own tooltip.
    const card = (line: string) =>
      `<div data-appid="440" class="item hoverable quality6 app440" data-defindex="378" data-title="Team Captain" data-content="Level 1&lt;br/&gt;${line}"><div class="item-value-indicator">0 ref</div></div>`;
    const html = `<!DOCTYPE html>\n<!-- saved from url=(0024)https://scrap.tf/buy/hats -->\n<html><head><title>Hats</title></head><body><div id="buy-container">${card('Glowing line one')}${card('Glowing line two')}</div></body></html>`;
    const r = h.run(html, NOW - 60_000);
    expect(r.skipped.map((s) => s.reason)).toEqual(['unparsed-modifier: "Glowing line one"', 'unparsed-modifier: "Glowing line two"']);
    expect(r).toMatchObject({ skippedTotal: 2, skippedCounts: { 'unparsed-modifier': 2 } });
  });
});
