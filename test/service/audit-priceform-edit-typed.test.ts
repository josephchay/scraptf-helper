// 0.7.3 (audit rpagesA-1): an imported price edited by hand is saved as a typed price (the Prices page's
// form now sends source 'user', as the drawer's does). A later save of its scrap.tf page, still listing the
// item or no longer listing it, leaves the hand price and its note alone. Local pages only; nothing is fetched.

import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ScrapPrice } from '../../src/shared/types';
import { createStubSchema } from '../import/schemaStub';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - 24 * HOUR },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
  });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    http: { isPaused: () => false },
    engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    secret: () => null,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: quiet,
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  const run = (html: string, mtimeMs: number) => importSavedPage(ctx, { html, fileName: 'hats.html', mtimeMs });
  return { repo, rpc, run };
}

const card = (defindex: number, title: string, value: number) =>
  `<div data-appid="440" class="item hoverable quality6 rarity app440" data-defindex="${defindex}" data-title="${title}" data-item-value="${value}"></div>`;
const hats = (...cards: string[]) =>
  '<!DOCTYPE html>\n<!-- saved from url=(0025)https://scrap.tf/buy/hats -->\n<html><head><title>Hat Trading - TF2 - Scrap.TF</title></head>' +
  `<body id="pid-buy-hats"><div id="buy-container">${cards.join('')}</div></body></html>`;

describe('an imported price edited by hand outlives the next save of its page (rpagesA-1)', () => {
  it('keeps the hand price and note when the page still lists the item, and when it no longer does', async () => {
    const h = setup();
    expect(h.run(hats(card(378, 'Team Captain', 100), card(126, "Bill's Hat", 15)), NOW - 3 * HOUR).stored).toBe(2);
    const imported = h.repo.scrapPricesForSku('378;6')[0]!;
    expect(imported).toMatchObject({ source: 'import', bank: 'hats' });

    // What the Prices page's form sends for the edit.
    const edited = (await h.rpc('prices.upsert', {
      id: imported.id,
      sku: imported.sku,
      name: imported.name,
      costKeys: 0,
      costScrap: 120,
      source: 'user',
      observedAt: NOW - 2 * HOUR,
      note: 'checked by hand',
    })) as ScrapPrice;
    expect(edited).toMatchObject({ id: imported.id, source: 'user', costScrap: 120, note: 'checked by hand', importBatch: imported.importBatch, bank: null });

    const survives = () => expect(h.repo.getScrapPrice(imported.id)).toMatchObject({ source: 'user', costScrap: 120, note: 'checked by hand' });
    h.run(hats(card(378, 'Team Captain', 100), card(126, "Bill's Hat", 15)), NOW - HOUR);
    survives();
    h.run(hats(card(126, "Bill's Hat", 15)), NOW - HOUR / 2);
    survives();
  });
});
