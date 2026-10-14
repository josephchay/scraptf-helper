// importSavedPage: how a saved page's prices replace earlier imported ones.
// Offline only (R10): the pages are built here or read from test/fixtures/import.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ImportResult, ScrapPrice } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const KEY_SCRAP = 600;
const PINK = 16738740;

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 3_600_000 } });
  const dirty: string[] = [];
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const engine = {
    keyPrice: () => ({ valueScrap: KEY_SCRAP }),
    markDirty: (skus: Iterable<string>) => dirty.push(...skus),
  } as unknown as Engine;
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
  } as unknown as HandlerContext;
  const run = (html: string, mtimeMs: number, fileName = 'page.html'): ImportResult => importSavedPage(ctx, { html, fileName, mtimeMs });
  const imported = (sku: string): ScrapPrice[] => repo.scrapPricesForSku(sku).filter((p) => p.source === 'import');
  return { repo, run, imported, dirty };
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

/** A saved /items price list with the given rows ("n/limit" is the stock cell). */
function itemsPage(rows: { defindex: number; name: string; price: string; stock: string }[]): string {
  const tr = rows
    .map((r) => `<tr data-quality="6" data-defindex="${r.defindex}"><td></td><td>${r.name}</td><td>${r.price}</td><td>1 refined</td><td><div rel="tooltip" title="${r.stock}"></div></td></tr>`)
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
    // Rows in stock are still imported.
    expect(h.imported('126;6').map((p) => [p.costKeys, p.costScrap, p.stock])).toEqual([[3, 477, 2]]);
    expect(r.stored).toBe(h.repo.listScrapPrices().filter((p) => p.source === 'import').length);
  });

  it('removes the earlier plain import of a sold-out item but keeps painted copies from bank pages', () => {
    const h = setup();
    h.run(bankPage([plainCaptain(100), pinkCaptain(140)]), NOW - 120_000, 'hats.html');
    expect(h.imported('378;6')).toHaveLength(2);
    h.dirty.length = 0;

    const r = h.run(itemsPage([{ defindex: 378, name: 'Team Captain', price: '2 refined', stock: '0/5' }]), NOW - 60_000, 'items.html');
    expect(r.stored).toBe(0);
    expect(r.skipped).toEqual([{ reason: 'out of stock on scrap.tf', title: 'Team Captain' }]);
    const left = h.imported('378;6');
    expect(left.map((p) => [p.special?.paint ?? null, p.costScrap])).toEqual([[PINK, 140]]);
    expect(h.dirty).toContain('378;6');
  });
});

describe('importSavedPage: the /items list replaces only plain copies', () => {
  it('updates the plain imported copy and keeps painted copies imported from a bank page', () => {
    const h = setup();
    h.run(bankPage([plainCaptain(100), pinkCaptain(140)]), NOW - 120_000, 'hats.html');
    const before = h.imported('378;6');
    const plainId = before.find((p) => p.special?.paint === null)!.id;
    const pinkId = before.find((p) => p.special?.paint === PINK)!.id;

    const r = h.run(itemsPage([{ defindex: 378, name: 'Team Captain', price: '2 refined', stock: '3/5' }]), NOW - 60_000, 'items.html');
    expect(r.stored).toBe(1);
    const after = h.imported('378;6');
    expect(after).toHaveLength(2);
    const plain = after.find((p) => p.id === plainId);
    expect(plain).toMatchObject({ costScrap: 18, stock: 3, importBatch: r.batchId, observedAt: NOW - 60_000 });
    expect(after.find((p) => p.id === pinkId)).toMatchObject({ costScrap: 140, special: expect.objectContaining({ paint: PINK }) });
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
    // Items the newer page did not price are still taken from the older one.
    expect(h.imported('126;6').map((p) => p.costScrap)).toEqual([20]);
    expect(r.stored).toBe(1);
  });

  it('does not delete copies a newer page stored', () => {
    const h = setup();
    h.run(bankPage([pinkCaptain(140)]), NOW - 60_000, 'new.html');
    h.run(bankPage([plainCaptain(100)]), NOW - 120_000, 'old.html');
    expect(h.imported('378;6').some((p) => p.special?.paint === PINK && p.costScrap === 140)).toBe(true);
  });

  it('does not let an older sold-out row remove a newer price', () => {
    const h = setup();
    h.run(itemsPage([{ defindex: 378, name: 'Team Captain', price: '2 refined', stock: '3/5' }]), NOW - 60_000, 'new.html');
    h.run(itemsPage([{ defindex: 378, name: 'Team Captain', price: '2 refined', stock: '0/5' }]), NOW - 120_000, 'old.html');
    expect(h.imported('378;6').map((p) => [p.costScrap, p.stock])).toEqual([[18, 3]]);
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
    h.run(itemsPage([{ defindex: 378, name: 'Team Captain', price: '2 refined', stock: '3/5' }]), NOW - 60_000, 'items.html');
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
