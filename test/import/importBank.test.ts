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

  it('stores an unrecognised /buy/<slug> page with no bank, its items and the warning', () => {
    const h = setup();
    const r = h.run(page.replace('https://scrap.tf/buy/stranges', 'https://scrap.tf/buy/crates'));
    expect(r.bank).toBeNull();
    expect(r.stored).toBe(1);
    expect(r.warnings).toEqual(['unknown-bank: crates is not a scrap.tf bank page this app knows; coverage uses the item categories']);
    expect(h.repo.listImportBatches(1)[0]!.bank).toBeNull();
  });
});
