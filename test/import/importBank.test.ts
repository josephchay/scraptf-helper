// F15 wiring: the bank the parser recognises (ScrapTfParseResult.bank) reaches the import batch
// (ImportBatch.bank), every price it stores (ScrapPrice.bank, joined on read) and ImportResult.bank.
// The first block forces the parser's answer to pin the path parser output -> importSavedPage -> repo;
// the second runs the real parser over every saved-page fixture. Offline: local pages only (R10).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { explicitInput } from '../../src/service/domain/engine';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SKIP_SAME_OR_CHEAPER } from '../../src/shared/importCodes';
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
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    // F20: the change feed's import hook (writes no event in these tests).
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: quiet,
  } as unknown as HandlerContext;
  const run = (html: string, mtimeMs = NOW - 60_000, fileName = 'page.html') => importSavedPage(ctx, { html, fileName, mtimeMs });
  return { repo, run };
}

/** A saved /buy/stranges page with one plain Team Captain card (the stub schema knows 378). */
const page =
  '<!DOCTYPE html>\n<!-- saved from url=(0028)https://scrap.tf/buy/stranges -->\n<html><head><title>Stranges</title></head><body>' +
  '<div data-appid="440" class="item hoverable quality6 rarity app440" data-defindex="378" data-title="Team Captain" data-item-value="30"></div>' +
  '</body></html>';

describe('importSavedPage stores the recognised bank (F15)', () => {
  it('on the batch, on every price it stores (read back joined), and in the result', () => {
    forced.bank = 'stranges';
    const h = setup();
    const r = h.run(page);
    expect(r.stored).toBe(1);
    expect(r.bank).toBe('stranges');
    expect(h.repo.listImportBatches(1)[0]).toMatchObject({ id: r.batchId, bank: 'stranges' });
    expect(h.repo.scrapPricesForSku('378;6').map((p) => [p.importBatch, p.bank])).toEqual([[r.batchId, 'stranges']]);
  });

  it('stores null when the page was not recognised', () => {
    forced.bank = null;
    const h = setup();
    const r = h.run(page);
    expect(r.bank).toBeNull();
    expect(h.repo.listImportBatches(1)[0]!.bank).toBeNull();
    expect(h.repo.scrapPricesForSku('378;6')[0]!.bank).toBeNull();
  });

  it('uses the bank the parser itself recognises when nothing forces one', () => {
    const h = setup();
    const r = h.run(page);
    expect(r.bank).toBe('stranges');
    expect(h.repo.listImportBatches(1)[0]!.bank).toBe('stranges');
  });

  it('a later page of another bank takes over the shared row, and its bank with it', () => {
    const h = setup();
    forced.bank = 'stranges';
    h.run(page);
    forced.bank = 'hats';
    const later = h.run(page, NOW - 1_000, 'later.html');
    expect(later.bank).toBe('hats');
    expect(h.repo.scrapPricesForSku('378;6').map((p) => [p.importBatch, p.bank])).toEqual([[later.batchId, 'hats']]);
    // The first batch keeps the page it was.
    expect(h.repo.listImportBatches(5).map((b) => b.bank)).toEqual(['hats', 'stranges']);
  });
});

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

describe('every saved scrap.tf page reaches its batch with its bank (F15, real parser)', () => {
  it.each<[string, ScraptfBank]>([
    ['buy_hats.html', 'hats'],
    ['buy_weapons.html', 'weapons'],
    ['buy_stranges.html', 'stranges'],
    ['buy_killstreaks.html', 'killstreaks'],
    ['buy_skins.html', 'skins'],
    ['buy_items.html', 'items'],
    ['unusuals.html', 'unusuals'],
    ['items_list.html', 'list'],
  ])('%s -> %s', (file, bank) => {
    const h = setup();
    const r = h.run(fixture(file), NOW - 60_000, file);
    expect(r.bank).toBe(bank);
    expect(r.stored).toBeGreaterThan(0);
    expect(h.repo.listImportBatches(1)[0]).toMatchObject({ id: r.batchId, bank });
    // Every price the page stored reads its bank back through the batch join.
    const prices = h.repo.listScrapPrices();
    expect(prices).toHaveLength(r.stored);
    expect(new Set(prices.map((p) => p.bank))).toEqual(new Set([bank]));
  });

  it('stores parts, spells and paint as extras under the clean SKU, so the engine flags the copy has-extras', () => {
    const h = setup();
    const r = h.run(fixture('buy_stranges.html'));
    expect(r.bank).toBe('stranges');
    const extras = (sku: string) =>
      h.repo
        .scrapPricesForSku(sku)
        .map((p) => [p.sku, explicitInput(p)?.target.hasExtras])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    // The clean copy and the copy with extras are two rows of one SKU; only the second has extras.
    expect(extras('205;11')).toEqual([['205;11', true]]); // strange parts
    expect(extras('200;11')).toEqual([['200;11', false], ['200;11', true]]); // a spell
    expect(extras('378;11')).toEqual([['378;11', false], ['378;11', true]]); // paint
    expect(h.repo.scrapPricesForSku('378;11').find((p) => p.special?.paint)?.special?.paint).toBe(16738740);
  });

  it('stores each killstreak kit by its weapon, two sheens of one kit as two copies, and never a bare kit (0.7.2)', () => {
    const h = setup();
    const r = h.run(fixture('buy_killstreaks.html'));
    // K15 names no weapon: skipped, not stored as the bare 6526.
    expect([r.parsed, r.stored, r.skippedCounts]).toEqual([15, 14, { 'needs-target': 1 }]);
    expect(r.skipped.map((s) => s.title)).toEqual(['Professional Kit']);
    const copies = (sku: string) =>
      h.repo
        .scrapPricesForSku(sku)
        .map((p) => [p.costKeys, p.costScrap, p.special?.sheen ?? null, p.special?.killstreaker ?? null])
        .sort((a, b) => a[0]! - b[0]!);
    expect(copies('6526;6;uncraftable;kt-3;td-205')).toEqual([
      [35, 0, 4, 2003],
      [37, 360, 1, 2008],
    ]);
    expect(copies('6523;6;uncraftable;kt-2;td-200')).toEqual([[2, 45, 3, null]]);
    expect(copies('6527;6;uncraftable;kt-1;td-199')).toEqual([[0, 27, null, null]]);
    for (const bare of ['6526;6', '6523;6', '6527;6', '6526;6;uncraftable']) expect(h.repo.scrapPricesForSku(bare)).toEqual([]);
  });

  // 0.7.2: one kit base now carries a row per sheen and killstreaker, so the cheapest-wins key must hold the
  // extras: two cards of the same combination are one copy, the cheaper, whichever comes first on the page.
  it.each([
    ['the cheaper card first', [35, 37]],
    ['the cheaper card last', [37, 35]],
  ])('stores one copy of a kit two cards show with the same sheen and killstreaker, the cheaper (%s) (0.7.2)', (_, keys) => {
    const h = setup();
    // As K11: the real /buy/killstreaks card shape.
    const kitCard = (id: number, k: number) =>
      `<div data-id="${id}" data-content="Sheen: Team Shine<br/>Killstreaker: Hypno-Beam<br/>Costs ${k} keys" data-appid="440" data-item-value="${k * 560}"` +
      ` data-num-available="1" data-num-selected="0" class="item hoverable quality6 fx1 fx2008 app440" data-title="Professional Rocket Launcher Kit" data-defindex="6526">` +
      `<div class="item-value-indicator">${k} keys</div></div>`;
    const html =
      '<!DOCTYPE html>\n<!-- saved from url=(0032)https://scrap.tf/buy/killstreaks -->\n<html><head><title>Killstreaks</title></head><body>' +
      keys.map((k, i) => kitCard(9_500_000_101 + i, k)).join('') +
      '</body></html>';
    const r = h.run(html);
    expect([r.bank, r.parsed, r.stored, r.skippedCounts]).toEqual(['killstreaks', 2, 1, { [SKIP_SAME_OR_CHEAPER]: 1 }]);
    expect(r.skipped).toEqual([{ reason: SKIP_SAME_OR_CHEAPER, title: 'Professional Rocket Launcher Kit' }]);
    expect(
      h.repo.scrapPricesForSku('6526;6;uncraftable;kt-3;td-205').map((p) => [p.name, p.costKeys, p.costScrap, p.special?.sheen, p.special?.killstreaker]),
    ).toEqual([['Non-Craftable Professional Killstreak Rocket Launcher Kit', 35, 0, 1, 2008]]);
  });

  it('stores an unrecognised /buy/<slug> page with no bank, its items and the warning', () => {
    const h = setup();
    const r = h.run(page.replace('https://scrap.tf/buy/stranges', 'https://scrap.tf/buy/crates'));
    expect(r.bank).toBeNull();
    expect(r.stored).toBe(1);
    expect(r.warnings).toEqual(['unknown-bank: crates is not a scrap.tf bank page this app knows; coverage uses the item categories']);
    expect(h.repo.listImportBatches(1)[0]!.bank).toBeNull();
  });
});
