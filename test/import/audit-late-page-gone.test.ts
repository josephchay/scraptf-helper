// Audit importflow-2: when a newer save of a bank showed a card gone (DM-1 removed its imported price), an
// older save of the page that arrives late (a hand import of an old file, a copied or renamed file in the
// watch folder, a catch-up file after a window read) must not bring that price back: no later save would
// ever remove it again. A copy restocked since, a gone event at or before the page, another copy of the
// item and the intended fill-in from an older page are unchanged. Real repo and scrap.tf history over
// synthetic saved pages (R10); offline, nothing is fetched.

import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SKIP_NEWER_SAVE, SKIP_NOT_ON_SALE_NEWER } from '../../src/shared/importCodes';
import type { ImportResult, KeyPriceState, ScrapPrice } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const PINK = 16738740;
const BILLS = '126;6';
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

let cardId = 9_600_000_000;
/** One hat card as scrap.tf's /buy/hats shows it, priced in scrap; `line` is an extra tooltip line (a paint). */
function card(defindex: number, title: string, scrap: number, line = ''): string {
  const ref = `${Math.floor(scrap / 9)}.${String((scrap % 9) * 11).padStart(2, '0')}`;
  return `<div data-id="${cardId++}" data-slot="head" data-classes="multi" data-content="Level 10<br/>${line}<small style='color:#3498db;'></small>" data-appid="440" data-item-value="${scrap}" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="${title}" data-defindex="${defindex}"><div class="item-value-indicator">${ref} ref</div></div>`;
}

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

/** A saved /items list with one Bill's Hat row in stock. */
const ITEMS_LIST =
  '<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head>' +
  '<body id="pid-items"><table><thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead>' +
  '<tbody><tr data-quality="6" data-defindex="126"><td></td><td>Bill\'s Hat</td><td>2 refined</td><td>1 refined</td><td><div rel="tooltip" title="2/5"></div></td></tr></tbody></table></body></html>';

/** 0.7.4: the same list, with Bill's Hat's Non-Craftable copy on a row of its own (sold out). */
const ITEMS_LIST_BOTH = ITEMS_LIST.replace(
  '</tbody>',
  '<tr data-quality="6" data-defindex="126"><td></td><td>Non-Craftable Bill\'s Hat</td><td>1 refined</td><td>0.5 refined</td><td><div rel="tooltip" title="0/5"></div></td></tr></tbody>',
);

const captain = card(378, 'Team Captain', 14);
const gibus = card(940, 'Ghostly Gibus', 10);
const WITH = (bills = 20) => [captain, card(126, "Bill's Hat", bills), gibus];
const WITHOUT = [captain, gibus];

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 24 * HOUR } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY });
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    scraptfHistory: history,
    bankStockChanged: () => history.refresh(),
  } as unknown as HandlerContext;
  const run = (cards: readonly string[], mtimeMs: number, fileName = 'Hat Trading - TF2 - Scrap.TF.html'): ImportResult =>
    importSavedPage(ctx, { html: hatsPage(cards), fileName, mtimeMs });
  const runHtml = (html: string, mtimeMs: number, fileName: string): ImportResult => importSavedPage(ctx, { html, fileName, mtimeMs });
  const imported = (sku: string): ScrapPrice[] => repo.scrapPricesForSku(sku).filter((p) => p.source === 'import');
  const prices = (sku: string) => imported(sku).map((p) => [p.observedAt, p.costScrap]);
  return { repo, run, runHtml, imported, prices };
}

describe('an older page arriving late never brings back a card a newer save showed gone (audit importflow-2)', () => {
  it('skips the sold card, and the next whole save leaves it gone', () => {
    const h = setup();
    h.run(WITH(), NOW - 4 * HOUR);
    h.run(WITHOUT, NOW - 2 * HOUR);
    expect(h.repo.scraptfEvents({ kinds: ['gone'] }).map((e) => [e.sku, e.at])).toEqual([[BILLS, NOW - 2 * HOUR]]);
    expect(h.imported(BILLS)).toEqual([]);

    const late = h.run(WITH(), NOW - 3 * HOUR, 'older copy.html');
    expect(late.stockSave).toBe('written');
    expect(h.imported(BILLS)).toEqual([]);
    expect(late.skipped).toContainEqual({ reason: SKIP_NEWER_SAVE, title: "Bill's Hat" });
    expect(late.stored).toBe(0);

    h.run(WITHOUT, NOW - HOUR);
    expect(h.imported(BILLS)).toEqual([]);
  });

  it('keeps a restock after the gone event, priced by its own save', () => {
    const h = setup();
    h.run(WITH(), NOW - 4 * HOUR);
    h.run(WITHOUT, NOW - 2 * HOUR);
    h.run(WITH(20), NOW - 90 * MIN);
    h.run(WITH(15), NOW - 3 * HOUR, 'older copy.html');
    expect(h.prices(BILLS)).toEqual([[NOW - 90 * MIN, 20]]);
  });

  // 0.7.4 (F31, F56): before, an older page filled in a card the newer save lacked when that save had no
  // gone event for it (a first save); that price then outlived every later whole save of the bank.
  it('does not fill in a card the newer whole save lacks, even when that save is the first (no gone event)', () => {
    const h = setup();
    h.run(WITHOUT, NOW - MIN);
    const late = h.run(WITH(), NOW - 2 * MIN, 'older.html');
    expect(h.prices(BILLS)).toEqual([]);
    // 0.7.4 (R05): no newer page priced it: the newer save does not show it on sale.
    expect(late.skipped).toContainEqual({ reason: SKIP_NOT_ON_SALE_NEWER, title: "Bill's Hat" });
  });

  it('a gone event at or before the page does not block it (a restock)', () => {
    const h = setup();
    h.run(WITH(), NOW - 4 * HOUR);
    h.run(WITHOUT, NOW - 3 * HOUR);
    h.run(WITH(18), NOW - 2 * HOUR);
    expect(h.prices(BILLS)).toEqual([[NOW - 2 * HOUR, 18]]);
  });

  // 0.7.4 (F31, F56): the plain copy's gone event still blocks only the plain copy (goneAfterPage), but on a
  // one-page bank the newer whole save decides every copy: a painted copy it does not show sold too. Before,
  // the late page wrote the painted copy.
  it('a painted copy the newer whole save does not show is not written either', () => {
    const h = setup();
    h.run(WITH(), NOW - 4 * HOUR);
    h.run(WITHOUT, NOW - 2 * HOUR);
    const late = h.run([captain, card(126, "Bill's Hat", 25, 'Painted Pink as Hell<br/>'), gibus], NOW - 3 * HOUR, 'older copy.html');
    expect(h.imported(BILLS)).toEqual([]);
    expect(late.skipped).toContainEqual({ reason: SKIP_NOT_ON_SALE_NEWER, title: "Bill's Hat" });
  });

  it('a painted copy the newer whole save shows on sale keeps that save price', () => {
    const h = setup();
    h.run(WITH(), NOW - 4 * HOUR);
    h.run([captain, card(126, "Bill's Hat", 30, 'Painted Pink as Hell<br/>'), gibus], NOW - 2 * HOUR);
    h.run([captain, card(126, "Bill's Hat", 25, 'Painted Pink as Hell<br/>'), gibus], NOW - 3 * HOUR, 'older copy.html');
    expect(h.imported(BILLS).map((p) => [p.special?.paint ?? null, p.costScrap, p.observedAt])).toEqual([[PINK, 30, NOW - 2 * HOUR]]);
  });

  it('an /items list older than a whole save of its bank that lacks the copy brings no price back either (0.7.4)', () => {
    const h = setup();
    h.run(WITH(), NOW - 4 * HOUR);
    h.run(WITHOUT, NOW - 2 * HOUR);
    // An /items list saved before the gone save, imported after it. Its Bill's Hat row is proven the
    // Craftable copy (the list shows the Non-Craftable one apart), yet the hats bank's newer whole save
    // does not show it: the list's stock counted a copy the bank no longer offers.
    const list = h.runHtml(ITEMS_LIST_BOTH, NOW - 210 * MIN, 'items.html');
    expect(list.skipped).toContainEqual({ reason: SKIP_NOT_ON_SALE_NEWER, title: "Bill's Hat" });
    expect(h.imported(BILLS)).toEqual([]);
    expect(h.repo.scraptfListRow(BILLS)).toMatchObject({ craft: 'craftable', stock: 2 });

    const late = h.run(WITH(), NOW - 3 * HOUR, 'older copy.html');
    expect(late.skipped).toContainEqual({ reason: SKIP_NEWER_SAVE, title: "Bill's Hat" });
    expect(h.imported(BILLS)).toEqual([]);
  });
});
