// 0.7.1 (P7): a changed scrap.tf layout says so instead of giving misleading advice or guessed prices.
// Item-like elements in no shape the parser knows warn layout-changed (not "saved without its items" or
// "no items"); an /items table whose headers no longer say "Price to buy" reads no price at all
// (no-price-column) instead of taking the third cell, while the saved list keeps each row's stock and what
// scrap.tf pays. The real parser and importSavedPage over the local fixtures; nothing is fetched.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { NO_CARDS_SAVED_WARNING, parseScrapTfHtml, warningCode } from '../../src/service/import';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { createStubSchema } from './schemaStub';

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');
const HATS = fixture('buy_hats.html');
const LIST = fixture('items_list.html');
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const schema = createStubSchema();

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 3_600_000 } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: quiet,
  } as unknown as HandlerContext;
  return { repo, run: (html: string, fileName = 'page.html') => importSavedPage(ctx, { html, fileName, mtimeMs: NOW - MIN }) };
}

describe('item elements in a shape the parser does not know (P7)', () => {
  it('a bank page whose cards lost the app440 class warns exactly layout-changed, with the count only', () => {
    const changed = HATS.replace(/\bapp440\b/g, 'app-440');
    expect(changed).not.toMatch(/\bapp440\b/);
    const r = parseScrapTfHtml(changed, schema);
    expect(r.items).toEqual([]);
    expect(r.warnings.map(warningCode)).toEqual(['layout-changed']);
    expect(r.warnings[0]).toMatch(/^layout-changed: \d+ item elements not recognised$/);
    const n = Number(/(\d+)/.exec(r.warnings[0]!)![1]);
    // Every card of the page (the selected copies included) and the other game's card.
    expect(n).toBeGreaterThanOrEqual(38);
  });

  it('a price list whose rows lost data-quality warns layout-changed too', () => {
    const r = parseScrapTfHtml(LIST.replace(/<tr data-quality="\d+" /g, '<tr '), schema);
    expect(r.items).toEqual([]);
    expect(r.warnings.map(warningCode)).toEqual(['layout-changed']);
  });

  it('a page with no item elements at all keeps its old warnings', () => {
    const open = '<div id="buy-container" class="items-container rev-items-container">';
    const at = HATS.indexOf(open);
    const empty = `${HATS.slice(0, at + open.length)}</div></body></html>`;
    expect(parseScrapTfHtml(empty, schema).warnings).toEqual([NO_CARDS_SAVED_WARNING]);
  });

  it('stores nothing and records the batch with the warning (a file save)', () => {
    const h = setup();
    const r = h.run(HATS.replace(/\bapp440\b/g, 'app-440'));
    expect(r).toMatchObject({ parsed: 0, stored: 0, stockSave: 'none' });
    expect(r.warnings.map(warningCode)).toEqual(['layout-changed']);
    expect(h.repo.listImportBatches(5)).toHaveLength(1);
  });
});

describe('the /items price column (P7)', () => {
  const original = parseScrapTfHtml(LIST, schema).items;

  it('a renamed "Price to buy" header reads no price at all: no-price-column, every row no-price', () => {
    const renamed = LIST.replace('<th>Price to buy</th>', '<th>Buy price</th>');
    const r = parseScrapTfHtml(renamed, schema);
    expect(r.warnings.map(warningCode)).toContain('no-price-column');
    expect(r.warnings.map(warningCode)).not.toContain('no-pays-column');
    expect(r.items).toHaveLength(original.length);
    for (const it of r.items) {
      expect([it.costKeys, it.costScrap], it.title).toEqual([0, 0]);
      expect(it.warnings.map(warningCode), it.title).toContain('no-price');
    }
    // The other columns are still read by their headers: stock, limit and what scrap.tf pays.
    expect(r.items.map((i) => [i.title, i.stock, i.stockLimit, i.pays])).toEqual(original.map((i) => [i.title, i.stock, i.stockLimit, i.pays]));
  });

  it('imports it as 0 prices, with every list row kept and no price to buy', () => {
    const h = setup();
    const r = h.run(LIST.replace('<th>Price to buy</th>', '<th>Buy price</th>'), 'items.html');
    expect(r.stored).toBe(0);
    expect(r.warnings.map(warningCode)).toContain('no-price-column');
    expect(r.listRows).toBeGreaterThan(0);
    const rows = h.repo.scraptfList();
    expect(rows.length).toBe(r.listRows);
    expect(rows.every((row) => row.sellsScrap === null && row.sellsKeys === null)).toBe(true);
    expect(rows.every((row) => row.paysScrap !== null)).toBe(true);
    expect(rows.find((row) => row.sku === '143;6')).toMatchObject({ stock: 0, stockLimit: 5 });
  });

  it('an extra column does not shift the price when the table has headers', () => {
    const extra = LIST.replace('<th>Price to buy</th>', '<th>Stock</th><th>Price to buy</th>').replace(/(<td>\s*\n\s*)([^<\n]*(?:key|refined|Sold out)[^<\n]*\n\s*<\/td>\s*\n\s*<td>\s*\n\s*[^<\n]*(?:key|refined)[^<\n]*\n)/g, '<td>9</td>$1$2');
    const r = parseScrapTfHtml(extra, schema);
    // Every row got its extra cell before the price.
    expect(extra.match(/<td>9<\/td>/g)).toHaveLength(original.length);
    expect(r.items.map((i) => [i.title, i.sku, i.costKeys, i.costScrap, i.pays, i.stock, i.stockLimit])).toEqual(
      original.map((i) => [i.title, i.sku, i.costKeys, i.costScrap, i.pays, i.stock, i.stockLimit]),
    );
    expect(r.warnings.map(warningCode)).not.toContain('no-price-column');
  });

  it('a table with no header row keeps the usual layout (price in the third cell), as before', () => {
    const headerless = LIST.replace(/<thead>[\s\S]*?<\/thead>/, '');
    const r = parseScrapTfHtml(headerless, schema);
    expect(r.warnings.map(warningCode)).not.toContain('no-price-column');
    expect(r.items.map((i) => [i.title, i.costKeys, i.costScrap])).toEqual(original.map((i) => [i.title, i.costKeys, i.costScrap]));
  });
});
