// F17 S1 write path, beyond test/import/bankStockImport.test.ts: importSavedPage keeps one bank_stock
// row per (base SKU, extras key) for every parsed card or row with a SKU, its special_key is exactly the
// key the import files that copy's price under, and the snapshot shares the import's transaction (a
// failed write leaves no batch, price or row behind and tells core nothing). The real parser over the
// saved-page fixtures; offline, local pages only (R10).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { parseScrapTfHtml } from '../../src/service/import';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { BANK_STOCK_PLAIN_KEY, bankStockKey, bankStockOnSale, bankStockSpecialKey } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { canonical, fromObject, fromString, looksLikeSku } from '../../src/shared/sku';
import type { ScraptfBank } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 3_600_000 } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const calls: string[] = [];
  const schema = createStubSchema();
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: (event: string) => calls.push(`push:${event}`),
    pricesChanged: () => calls.push('pricesChanged'),
    scraptfListChanged: quiet,
    // F20: the change feed's import hook (writes no event in these tests).
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: (imported?: { bank: ScraptfBank; batchId: number }) => calls.push(imported ? `bankStockChanged:${imported.bank}` : 'bankStockChanged'),
  } as unknown as HandlerContext;
  const run = (html: string, mtimeMs = NOW - MIN) => importSavedPage(ctx, { html, fileName: 'page.html', mtimeMs });
  return { repo, schema, run, calls, ctx };
}

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

const FILES: [string, ScraptfBank][] = [
  ['buy_hats.html', 'hats'],
  ['buy_weapons.html', 'weapons'],
  ['buy_stranges.html', 'stranges'],
  ['buy_killstreaks.html', 'killstreaks'],
  ['buy_skins.html', 'skins'],
  ['buy_items.html', 'items'],
  ['unusuals.html', 'unusuals'],
  ['items_list.html', 'list'],
];

describe('importSavedPage: the bank stock rows of a save (F17 S1)', () => {
  it.each(FILES)('%s keeps one row per base SKU and extras for every parsed card with a SKU', (file, bank) => {
    const h = setup();
    const html = fixture(file);
    // The keys the import should keep: every parsed card or row with a SKU, sold out or not.
    const expected = new Set<string>();
    for (const item of parseScrapTfHtml(html, h.schema).items) {
      if (item.sku === null || !looksLikeSku(item.sku)) continue;
      const obj = fromString(canonical(item.sku));
      const paint = typeof obj.paint === 'number' && obj.paint > 0 ? obj.paint : null;
      expected.add(bankStockKey(fromObject({ ...obj, paint: null }), bankStockSpecialKey({ ...item.special, paint: item.special?.paint ?? paint })));
    }
    const r = h.run(html);
    expect(r.bank).toBe(bank);
    const rows = h.repo.bankStockRows(r.batchId);
    expect(new Set(rows.map((x) => bankStockKey(x.sku, x.specialKey)))).toEqual(expected);
    expect(rows).toHaveLength(expected.size);
  });

  it.each(FILES)('%s files each row under the same extras key as the price it stored', (file) => {
    const h = setup();
    const r = h.run(fixture(file));
    const rows = new Map(h.repo.bankStockRows(r.batchId).map((x) => [bankStockKey(x.sku, x.specialKey), x]));
    const prices = h.repo.listScrapPrices().filter((p) => p.importBatch === r.batchId);
    expect(prices.length).toBe(r.stored);
    for (const p of prices) {
      // The price's extras as the import keys them; a clean copy is the column default ''.
      const row = rows.get(bankStockKey(p.sku, bankStockSpecialKey(p.special)));
      expect(row, `${p.sku} ${JSON.stringify(p.special)}`).toBeDefined();
      expect(bankStockOnSale(row)).toBe(true);
      expect([row!.costKeys, row!.costScrap]).toEqual([p.costKeys, p.costScrap]);
    }
    // And a clean copy reads ''.
    expect([...rows.values()].some((x) => x.specialKey === BANK_STOCK_PLAIN_KEY)).toBe(true);
  });

  it('writes the snapshot in the import’s transaction: a failed write leaves nothing behind', () => {
    const h = setup();
    vi.spyOn(h.repo, 'insertBankStock').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    expect(() => h.run(fixture('buy_hats.html'))).toThrow(/disk I\/O error/);
    expect(h.repo.listImportBatches(10)).toEqual([]);
    expect(h.repo.listScrapPrices()).toEqual([]);
    expect(h.repo.bankStockSaves('hats')).toEqual([]);
    // Core heard of nothing: no refresh, no notification, no price push.
    expect(h.calls).toEqual([]);
  });

  it('keeps the saves of the other banks when one is imported, within retention', () => {
    const h = setup();
    const hats = h.run(fixture('buy_hats.html'), NOW - 20 * 24 * 60 * MIN);
    const weapons = h.run(fixture('buy_weapons.html'), NOW - 2 * MIN);
    expect(h.repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([hats.batchId]);
    expect(h.repo.bankStockSaves('weapons').map((s) => s.batchId)).toEqual([weapons.batchId]);
    expect(h.calls.filter((c) => c.startsWith('bankStockChanged'))).toEqual(['bankStockChanged:hats', 'bankStockChanged:weapons']);
  });
});

/** Two cards of one hat (the markup of buy_hats.html C01 and C33): a "3x" stack and a reserved copy of its own. */
const STACK = `<div data-id="9300000001" data-slot="head" data-classes="multi" data-content="Level 10<br/><small style='color:#3498db;'></small>" data-appid="440" data-item-group-hash="bb22" data-num-available="3" data-num-selected="0" data-item-value="12" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="Team Captain" data-defindex="378"><div class="item-value-indicator">1.33 ref</div><div class="item-group-num-text" id="group-num-available">3x</div></div>`;
const RESERVED = `<div data-id="9300000002" data-slot="head" data-classes="multi" data-content="<b>This item has been reserved.</b>" data-appid="440" data-item-value="12" class="item hoverable quality6   reserved rarity app440 " style="opacity:1;" data-title="Team Captain" data-defindex="378"><div class="item-value-indicator">1.33 ref</div></div>`;
const PRICIER = `<div data-id="9300000003" data-slot="head" data-classes="multi" data-content="Level 20<br/><small style='color:#3498db;'></small>" data-appid="440" data-item-value="14" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="Team Captain" data-defindex="378"><div class="item-value-indicator">1.55 ref</div></div>`;

function hatsPage(cards: readonly string[]): string {
  return [
    '<!DOCTYPE html>',
    '<!-- saved from url=(0025)https://scrap.tf/buy/hats -->',
    '<html lang="en"><head><meta charset="utf-8" /><title>Hat Trading - TF2 - Scrap.TF</title>',
    '<meta property="og:url" content="https://scrap.tf/buy/hats" /></head>',
    '<body class="page-theme-light" id="pid-buy-hats"><div class="container"><div id="buy-container" class="items-container rev-items-container">',
    ...cards,
    '</div></div></body></html>',
  ].join('\n');
}

describe('importSavedPage: the stock of a key on several cards (reviewer fix)', () => {
  it.each(FILES)('%s: a key’s stock is the copies on sale of all its cards', (file) => {
    const h = setup();
    const html = fixture(file);
    const want = new Map<string, number | null>();
    for (const item of parseScrapTfHtml(html, h.schema).items) {
      if (item.sku === null || !looksLikeSku(item.sku)) continue;
      const priced = (item.costKeys > 0 || item.costScrap > 0) && !item.warnings.some((w) => /^(no-price|unparsed-price)/.test(w));
      if (!priced || item.stock === 0) continue;
      const obj = fromString(canonical(item.sku));
      const paint = typeof obj.paint === 'number' && obj.paint > 0 ? obj.paint : null;
      const k = bankStockKey(fromObject({ ...obj, paint: null }), bankStockSpecialKey({ ...item.special, paint: item.special?.paint ?? paint }));
      const had = want.get(k);
      want.set(k, had === null || item.stock === null ? null : (had ?? 0) + item.stock);
    }
    const r = h.run(html);
    for (const row of h.repo.bankStockRows(r.batchId).filter(bankStockOnSale)) {
      expect(row.stock, `${row.sku} ${row.specialKey}`).toBe(want.get(bankStockKey(row.sku, row.specialKey)));
    }
  });

  it('counts the "3x" stack and the reserved copy of buy_hats.html’s Team Captain, not its unpriced card', () => {
    const h = setup();
    const r = h.run(fixture('buy_hats.html'));
    expect(h.repo.bankStockRows(r.batchId).find((x) => x.sku === '378;6' && x.specialKey === BANK_STOCK_PLAIN_KEY)).toMatchObject({ costKeys: 0, costScrap: 12, stock: 4 });
  });

  it('is the same whatever the cards’ order, with the cheapest card’s price', () => {
    const rowOf = (cards: string[]) => {
      const h = setup();
      const r = h.run(hatsPage(cards));
      return h.repo.bankStockRows(r.batchId).find((x) => x.sku === '378;6');
    };
    const a = rowOf([STACK, RESERVED, PRICIER]);
    const b = rowOf([PRICIER, RESERVED, STACK]);
    expect(a).toMatchObject({ costScrap: 12, stock: 5 });
    expect(b).toMatchObject({ costScrap: 12, stock: 5 });
  });

  it('a core failure after the commit still lets the engine hear of the new prices', () => {
    const h = setup();
    const ctx = h.ctx as unknown as { bankStockChanged: () => void };
    ctx.bankStockChanged = () => {
      throw new Error('cache gone');
    };
    const r = h.run(fixture('buy_hats.html'));
    expect(r.stored).toBeGreaterThan(0);
    expect(h.repo.bankStockSaves('hats')).toHaveLength(1);
    expect(h.calls).toContain('pricesChanged');
    expect(h.calls).toContain('push:import.done');
  });
});
