// 0.7.4 (audit: the /items calibration bug, F01, F02, F28, F58, F60, F06/F53, F04/F61): what an /items read
// may store as a cost. A family row (unmarked: every copy at its price) is kept on the price list only; a row
// proven to price its copy is a cost only with its stock read, never over a bank page's own price of that copy
// (the list never re-tags one: bank, asset id and stock stay), and never when a newer whole save of its home
// bank lacks it; a later whole save of that bank removes it (DM-3). A whole /items save retires the list rows
// and prices it shows gone (F60), and an /items window snapshot cut before its settle read is a whole save
// when it read every row (F06). Real repo, parser and scrap.tf history over synthetic pages with the real
// item schema (test/fixtures/pricedb/schema-subset.json); offline (R1, R10).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { NO_STOCK_LIMIT, PARTIAL_READ, SKIP_BANK_CARD_PRICE, SKIP_CRAFT_UNPROVEN, SKIP_NEWER_SAVE, SKIP_NOT_ON_SALE_NEWER } from '../../src/shared/importCodes';
import type { ImportResult, KeyPriceState, ScrapPrice } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const HUE = '5040;6';
const NC_HUE = '5040;6;uncraftable';
const TINGE = '5039;6';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

interface Row {
  defindex: number;
  name: string;
  price: string;
  stock: string;
  pays?: string;
  iconClass?: string;
  /** data-quality (6 when absent). */
  quality?: number;
}

const hue = (over: Partial<Row> = {}): Row => ({ defindex: 5040, name: 'A Distinctive Lack of Hue', price: '1 key, 43.22 refined', pays: '1 key, 37 refined', stock: '4/25', ...over });
const ncHue = (over: Partial<Row> = {}): Row => hue({ name: 'Non-Craftable A Distinctive Lack of Hue', ...over });
const tinge = (over: Partial<Row> = {}): Row => ({ defindex: 5039, name: 'An Extraordinary Abundance of Tinge', price: '1 key, 38 refined', pays: '1 key, 28 refined', stock: '1/25', ...over });
/** Filler rows (each its own item) so a list has the rows a whole look is compared by. */
const filler = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ defindex: 60_000 + i, name: 'Filler', price: '1 refined', stock: '0/5' }));

function listPage(rows: readonly Row[], { header = true, path = '/items' } = {}): string {
  const tr = rows
    .map(
      (r) =>
        `<tr data-quality="${r.quality ?? 6}" data-defindex="${r.defindex}"><td><img alt="Icon" class="${r.iconClass ?? `item quality${r.quality ?? 6} rev-banking-background`}"></td>` +
        `<td>${r.name}</td><td>${r.price}</td><td>${r.pays ?? '1 refined'}</td><td><div class="progress"><div class="bar"${r.stock ? ` title="${r.stock}"` : ''}></div></div></td></tr>`,
    )
    .join('\n');
  const head = header ? '<thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead>' : '';
  return (
    `<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf${path}" /></head>` +
    `<body id="pid-items"><table>${head}<tbody>${tr}</tbody></table></body></html>`
  );
}

let cardId = 17_709_000_000;
/** A /buy/items card priced in keys and scrap; `uncraft` marks it Non-Craftable as scrap.tf does. */
function card(defindex: number, title: string, keys: number, scrap: number, { uncraft = false, stock = 1 } = {}): string {
  const value = keys * 600 + scrap;
  const ind = `${keys > 0 ? `${keys} key${keys > 1 ? 's' : ''} ` : ''}${Math.floor(scrap / 9)}.${String((scrap % 9) * 11).padStart(2, '0')} ref`;
  return `<div data-id="${cardId++}" data-num-available="${stock}" data-content="Level 1" data-appid="440" data-item-value="${value}" class="item hoverable quality6${uncraft ? ' uncraft' : ''} app440" data-title="${title}" data-defindex="${defindex}"><div class="item-value-indicator">${ind}</div></div>`;
}

function itemsBank(cards: readonly string[]): string {
  return [
    '<!DOCTYPE html>',
    '<!-- saved from url=(0025)https://scrap.tf/buy/items -->',
    '<html lang="en"><head><meta charset="utf-8" /><title>Item Trading - TF2 - Scrap.TF</title></head>',
    '<body id="pid-buy-items"><div class="container"><div id="buy-container" class="items-container">',
    ...cards,
    '</div></div></body></html>',
  ].join('\n');
}

function hatsBank(cards: readonly string[]): string {
  return [
    '<!DOCTYPE html>',
    '<!-- saved from url=(0024)https://scrap.tf/buy/hats -->',
    '<html lang="en"><head><meta charset="utf-8" /><title>Hat Trading - TF2 - Scrap.TF</title></head>',
    '<body id="pid-buy-hats"><div id="buy-container" class="items-container">',
    ...cards,
    '</div></body></html>',
  ].join('\n');
}

const ncHueCard = (stock = 2) => card(5040, 'Non-Craftable A Distinctive Lack of Hue', 1, 389, { uncraft: true, stock });
const otherCard = () => card(5039, 'An Extraordinary Abundance of Tinge', 2, 38);
const billsCard = () => card(126, "Bill's Hat", 0, 20);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - 24 * HOUR },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - 24 * HOUR },
  });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY });
  const calls: string[] = [];
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: () => calls.push('scraptfListChanged'),
    scraptfHistory: history,
    bankStockChanged: () => history.refresh(),
  } as unknown as HandlerContext;
  const file = (html: string, mtimeMs: number, fileName = 'page.html'): ImportResult => importSavedPage(ctx, { html, fileName, mtimeMs });
  const window = (html: string, address: string, mtimeMs: number, settled: boolean): ImportResult =>
    importSavedPage(ctx, { html, fileName: `scrap.tf window ${new URL(address).pathname}`, mtimeMs, address, origin: 'window', settled });
  const imported = (sku: string): ScrapPrice[] => repo.scrapPricesForSku(sku).filter((p) => p.source === 'import');
  const list = createScraptfListCache({ repo, log, keyPrice: () => KEY });
  return { repo, file, window, imported, list, calls };
}

// ---------------------------------------------------------------------------

describe('a family row is shown, never a cost (F01)', () => {
  it("stores the user's mis-keyed paint as a list row only, and the Non-Craftable card stays the cost", () => {
    const h = setup();
    h.file(itemsBank([ncHueCard()]), NOW - 3 * MIN, 'items bank.html');
    const r = h.file(listPage([hue()]), NOW - 2 * MIN, 'items.html');
    expect(r.skipped).toContainEqual({ reason: SKIP_CRAFT_UNPROVEN, title: 'A Distinctive Lack of Hue' });
    expect(r.stored).toBe(0);
    // No craftable cost to meet Craftable buy orders: the false flip is gone.
    expect(h.imported(HUE)).toEqual([]);
    expect(h.imported(NC_HUE).map((p) => [p.bank, p.costKeys, p.costScrap, p.stock])).toEqual([['items', 1, 389, 2]]);
    expect(h.repo.scraptfListRow(HUE)).toMatchObject({ craft: 'any', stock: 4, stockLimit: 25 });
    // The Non-Craftable copy reads the family row (stock for every copy), never as its own cost.
    h.list.refresh();
    expect(h.list.rowFor(NC_HUE)).toMatchObject({ sku: HUE, match: 'family', craft: 'any', stock: 4 });
    expect(h.list.rowFor(HUE)).toMatchObject({ sku: HUE, craft: 'any' });
    expect(h.list.rowFor(HUE)!.match).toBeUndefined();
  });

  it('removes a list price an older read stored for a row now read as a family row', () => {
    const h = setup();
    // Proven Craftable then (its Non-Craftable row beside it, sold out).
    h.file(listPage([hue({ price: '2 keys, 20 refined' }), ncHue({ stock: '0/25' })]), NOW - 2 * HOUR, 'items.html');
    expect(h.imported(HUE).map((p) => [p.bank, p.costKeys, p.costScrap])).toEqual([['list', 2, 180]]);
    // The next read lists only the unmarked row.
    h.file(listPage([hue({ price: '2 keys, 20 refined' })]), NOW - HOUR, 'items.html');
    expect(h.imported(HUE)).toEqual([]);
  });

  it("never keeps a row whose stock was not read as a cost, header or not (F58)", () => {
    const h = setup();
    // No "Item Limits" header and a bar with no numbers: the stock is unknown, sold out or not.
    const r = h.file(listPage([ncHue({ stock: '' }), tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge', stock: '' })], { header: false }), NOW - MIN, 'items.html');
    expect(r.stored).toBe(0);
    expect(r.skipped.map((s) => s.reason)).toEqual([`${NO_STOCK_LIMIT}: the list shows no stock for this row`, `${NO_STOCK_LIMIT}: the list shows no stock for this row`]);
    expect(r.stockSave).toBe('partial');
    expect(r.warnings).toContainEqual(expect.stringMatching(/^no-stock-limit: 2 rows with no readable stock/));
    expect(h.repo.bankStockSaves('list')).toEqual([]);
    expect(h.repo.scraptfListRow(NC_HUE)).toMatchObject({ stock: null, craft: 'uncraftable' });
  });
});

describe('a proven row and the banks (F02, F28)', () => {
  it("never re-tags a bank page's own price of the copy: its bank, asset id and stock stay", () => {
    const h = setup();
    h.file(itemsBank([ncHueCard(2)]), NOW - 3 * MIN, 'items bank.html');
    const before = h.imported(NC_HUE)[0]!;
    expect(before).toMatchObject({ bank: 'items', stock: 2 });
    expect(before.assetId).not.toBeNull();
    const r = h.file(listPage([hue({ iconClass: 'item quality6 uncraft' })]), NOW - 2 * MIN, 'items.html');
    expect(r.skipped).toContainEqual({ reason: SKIP_BANK_CARD_PRICE, title: 'A Distinctive Lack of Hue' });
    expect(h.imported(NC_HUE)).toEqual([before]);
    // The list row is still stored: what scrap.tf pays and its stock for every copy.
    expect(h.repo.scraptfListRow(NC_HUE)).toMatchObject({ craft: 'uncraftable', stock: 4 });
  });

  it('stores a list-only proven row, and the next whole save of its home bank that lacks it removes it (DM-3)', () => {
    const h = setup();
    h.file(listPage([ncHue()]), NOW - 3 * HOUR, 'items.html');
    expect(h.imported(NC_HUE).map((p) => [p.bank, p.stock])).toEqual([['list', 4]]);
    // A /buy/hats save is no home of a tool: it removes nothing.
    h.file(hatsBank([billsCard()]), NOW - 2 * HOUR, 'hats.html');
    expect(h.imported(NC_HUE)).toHaveLength(1);
    // An unsettled /buy/items window look stores no save, so it removes nothing either.
    const look = h.window(itemsBank([otherCard()]), 'https://scrap.tf/buy/items', NOW - 90 * MIN, false);
    expect(look.stockSave).toBe('unsettled');
    expect(h.imported(NC_HUE)).toHaveLength(1);
    // A typed price of the copy is the user's: never touched.
    h.repo.upsertScrapPrice({ sku: NC_HUE, name: 'Non-Craftable A Distinctive Lack of Hue', costKeys: 1, costScrap: 300, source: 'user', observedAt: NOW - 80 * MIN });
    // The whole /buy/items save does not show it: scrap.tf's list counted a copy its bank does not offer.
    const whole = h.file(itemsBank([otherCard()]), NOW - HOUR, 'items bank.html');
    expect(whole.stockSave).toBe('written');
    expect(h.imported(NC_HUE)).toEqual([]);
    expect(h.repo.scrapPricesForSku(NC_HUE).map((p) => p.source)).toEqual(['user']);
    // The list row stays: what scrap.tf pays, for the drawer and Holdings.
    expect(h.repo.scraptfListRow(NC_HUE)).not.toBeNull();
  });

  it('DM-3 reads only the list prices and asks each SKU or twin its home bank once per import (R04)', () => {
    const h = setup();
    const NC_TINGE = `${TINGE};uncraftable`;
    // Tinge proven Craftable beside its Non-Craftable row: two list prices that are each other's twin, and Hue.
    h.file(listPage([tinge(), tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge' }), ncHue()]), NOW - 3 * HOUR, 'items.html');
    expect([TINGE, NC_TINGE, NC_HUE].map((s) => h.imported(s).map((p) => p.bank))).toEqual([['list'], ['list'], ['list']]);
    const asked: string[] = [];
    const newestBankOf = h.repo.bankStockNewestBankOf.bind(h.repo);
    h.repo.bankStockNewestBankOf = (skus) => {
      asked.push(...skus);
      return newestBankOf(skus);
    };
    let everyPrice = 0;
    const listScrapPrices = h.repo.listScrapPrices.bind(h.repo);
    h.repo.listScrapPrices = (...a) => {
      everyPrice++;
      return listScrapPrices(...a);
    };
    expect(h.file(itemsBank([billsCard()]), NOW - HOUR, 'items bank.html').stockSave).toBe('written');
    // The same outcome as before: every list price whose home is /buy/items and that it lacks goes.
    expect([TINGE, NC_TINGE, NC_HUE].map((s) => h.imported(s))).toEqual([[], [], []]);
    expect(everyPrice).toBe(0);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('keeps a list price its home bank shows on sale (a bank card then takes it over)', () => {
    const h = setup();
    h.file(listPage([ncHue()]), NOW - 2 * HOUR, 'items.html');
    h.file(itemsBank([ncHueCard(3)]), NOW - HOUR, 'items bank.html');
    expect(h.imported(NC_HUE).map((p) => [p.bank, p.stock])).toEqual([['items', 3]]);
  });

  it('a list older than a whole save of its home bank that lacks the copy stores no cost for it', () => {
    const h = setup();
    // Seen on /buy/items once, then a whole save without it.
    h.file(itemsBank([ncHueCard(), otherCard()]), NOW - 4 * HOUR, 'items bank.html');
    h.file(itemsBank([otherCard()]), NOW - 2 * HOUR, 'items bank.html');
    expect(h.imported(NC_HUE)).toEqual([]);
    // An /items list saved in between, imported last (a catch-up scan): its count is no copy on offer.
    const late = h.file(listPage([ncHue()]), NOW - 3 * HOUR, 'items.html');
    // 0.7.4 (R05): its bank page's newer save does not offer it; no newer page priced it.
    expect(late.skipped).toContainEqual({ reason: SKIP_NOT_ON_SALE_NEWER, title: 'Non-Craftable A Distinctive Lack of Hue' });
    expect(late.skipped.map((s) => s.reason)).not.toContain(SKIP_NEWER_SAVE);
    expect(h.imported(NC_HUE)).toEqual([]);
    // A list newer than that save stores it (the next whole save of the bank decides).
    h.file(listPage([ncHue()]), NOW - HOUR, 'items.html');
    expect(h.imported(NC_HUE).map((p) => p.bank)).toEqual(['list']);
  });

  it('homes a strange cosmetic no bank showed on /buy/hats, where scrap.tf sells it (F36), not /buy/stranges', () => {
    const h = setup();
    const STRANGE_NC_BILLS = '126;11;uncraftable';
    h.file(listPage([{ defindex: 126, quality: 11, name: "Non-Craftable Strange Bill's Hat", price: '3 refined', pays: '2 refined', stock: '1/5' }]), NOW - 3 * HOUR, 'items.html');
    expect(h.imported(STRANGE_NC_BILLS).map((p) => p.bank)).toEqual(['list']);
    // A whole /buy/stranges save never lists cosmetics: it is no home of the hat, so it removes nothing.
    const stranges = [
      '<!DOCTYPE html>',
      '<!-- saved from url=(0028)https://scrap.tf/buy/stranges -->',
      '<html lang="en"><head><meta charset="utf-8" /><title>Strange Trading - TF2 - Scrap.TF</title></head>',
      '<body id="pid-buy-stranges"><div id="buy-container" class="items-container">',
      `<div data-id="${cardId++}" data-num-available="1" data-content="Level 1" data-appid="440" data-item-value="45" class="item hoverable quality11 app440" data-title="Strange Rocket Launcher" data-defindex="205"><div class="item-value-indicator">5.00 ref</div></div>`,
      '</div></body></html>',
    ].join('\n');
    expect(h.file(stranges, NOW - 2 * HOUR, 'stranges.html').stockSave).toBe('written');
    expect(h.imported(STRANGE_NC_BILLS)).toHaveLength(1);
    // The whole /buy/hats save that does not show it on sale does.
    expect(h.file(hatsBank([billsCard()]), NOW - HOUR, 'hats.html').stockSave).toBe('written');
    expect(h.imported(STRANGE_NC_BILLS)).toEqual([]);
  });

  it('a home bank found through the craftability twin: the Craftable card a bank showed homes the list-only copy', () => {
    const h = setup();
    // /buy/items once held the Craftable copy; the list proves a Non-Craftable one the bank never showed.
    h.file(itemsBank([card(5039, 'An Extraordinary Abundance of Tinge', 2, 38)]), NOW - 4 * HOUR, 'items bank.html');
    h.file(listPage([tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge' })]), NOW - 3 * HOUR, 'items.html');
    expect(h.imported(`${TINGE};uncraftable`)).toHaveLength(1);
    h.file(itemsBank([ncHueCard()]), NOW - 2 * HOUR, 'items bank.html');
    expect(h.imported(`${TINGE};uncraftable`)).toEqual([]);
  });
});

describe('rows of one item that differ (F04, F61)', () => {
  it("store no price and leave a bank page's price of the item as it was", () => {
    const h = setup();
    h.file(itemsBank([card(5040, 'A Distinctive Lack of Hue', 2, 180)]), NOW - 2 * HOUR, 'items bank.html');
    const bank = h.imported(HUE);
    const r = h.file(listPage([hue({ price: '2 keys, 20 refined', stock: '1/25' }), hue({ stock: '0/25' })]), NOW - HOUR, 'items.html');
    expect(r.warnings).toContainEqual(expect.stringMatching(/^duplicate-rows: 2 rows/));
    expect(r.skippedCounts?.['duplicate-row']).toBe(2);
    expect(h.imported(HUE)).toEqual(bank);
    expect(h.repo.scraptfListRow(HUE)).toBeNull();
  });
});

describe('a whole /items save retires what it shows gone (F60)', () => {
  const page = (extra: Row[]) => listPage([...filler(10), ...extra]);

  it("removes the list price and the row of a copy the page no longer lists, and keeps a sold-out one's row", () => {
    const h = setup();
    h.file(page([ncHue(), tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge' })]), NOW - 2 * HOUR, 'items.html');
    expect(h.imported(NC_HUE)).toHaveLength(1);
    expect(h.imported(`${TINGE};uncraftable`)).toHaveLength(1);
    h.calls.length = 0;
    // Hue is gone from the list; Tinge is listed sold out.
    const r = h.file(page([tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge', stock: '0/25' })]), NOW - HOUR, 'items.html');
    expect(r.stockSave).toBe('written');
    expect(h.imported(NC_HUE)).toEqual([]);
    expect(h.repo.scraptfListRow(NC_HUE)).toBeNull();
    expect(h.imported(`${TINGE};uncraftable`)).toEqual([]);
    expect(h.repo.scraptfListRow(`${TINGE};uncraftable`)).toMatchObject({ stock: 0 });
    expect(h.calls).toContain('scraptfListChanged');
  });

  it('retires a row last listed sold out once a whole save no longer lists it at all (R02)', () => {
    const h = setup();
    const NC_TINGE = `${TINGE};uncraftable`;
    h.file(page([ncHue({ stock: '3/25' }), tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge' })]), NOW - 3 * HOUR, 'items.html');
    h.file(page([ncHue({ stock: '0/25' }), tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge' })]), NOW - 2 * HOUR, 'items.html');
    expect(h.repo.scraptfListRow(NC_HUE)).toMatchObject({ stock: 0, page: '/items' });
    h.calls.length = 0;
    // Hue is no longer on the list (no 'gone' event: it was not on sale in the save before).
    const r = h.file(page([tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge' })]), NOW - HOUR, 'items.html');
    expect(r.stockSave).toBe('written');
    expect(h.repo.scraptfListRow(NC_HUE)).toBeNull();
    expect(h.imported(NC_HUE)).toEqual([]);
    expect(h.calls).toContain('scraptfListChanged');
    // A row it still shows stays, with its price.
    expect(h.repo.scraptfListRow(NC_TINGE)).not.toBeNull();
    expect(h.imported(NC_TINGE)).toHaveLength(1);
    // So scrap.tf is no longer offered as Hue's exit.
    h.list.refresh();
    expect(h.list.rowFor(NC_HUE)).toBeNull();
  });

  it('retires a row and list price only a look that stored no save wrote, at the next whole save (R02)', () => {
    const h = setup();
    expect(h.file(page([]), NOW - 3 * HOUR, 'items.html').stockSave).toBe('written');
    // A look with a row whose stock cannot be read stores no save, but its prices and rows.
    const look = h.file(page([ncHue({ stock: '3/25' }), tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge', stock: '' })]), NOW - 2 * HOUR, 'items.html');
    expect(look.stockSave).toBe('partial');
    expect(h.imported(NC_HUE).map((p) => [p.bank, p.stock])).toEqual([['list', 3]]);
    expect(h.repo.scraptfListRow(NC_HUE)).not.toBeNull();
    // The next whole save of /items does not list it: the row and the price go.
    expect(h.file(page([]), NOW - HOUR, 'items.html').stockSave).toBe('written');
    expect(h.imported(NC_HUE)).toEqual([]);
    expect(h.repo.scraptfListRow(NC_HUE)).toBeNull();
    expect(h.repo.scraptfListRow(`${TINGE};uncraftable`)).toBeNull();
  });

  it('never retires a row another list page shows, or one read on another page (R02)', () => {
    const h = setup();
    h.file(listPage([...filler(10), ncHue()], { path: '/items/2' }), NOW - 3 * HOUR, 'items 2.html');
    expect(h.repo.scraptfListRow(NC_HUE)).toMatchObject({ page: '/items/2' });
    // A whole /items save without it: the row was read on /items/2, whose newest save lists it.
    expect(h.file(page([]), NOW - 2 * HOUR, 'items.html').stockSave).toBe('written');
    expect(h.repo.scraptfListRow(NC_HUE)).not.toBeNull();
    expect(h.imported(NC_HUE)).toHaveLength(1);
    // Read on /items now (and /items/2 still lists it): an /items save without it keeps it too.
    h.file(page([ncHue()]), NOW - 90 * MIN, 'items.html');
    expect(h.repo.scraptfListRow(NC_HUE)).toMatchObject({ page: '/items' });
    h.file(page([]), NOW - HOUR, 'items.html');
    expect(h.repo.scraptfListRow(NC_HUE)).not.toBeNull();
  });

  it('retires nothing on an unsettled look short of rows, on another page, or on a first save', () => {
    const h = setup();
    // A first save: nothing to compare, so nothing goes.
    h.file(page([ncHue()]), NOW - 3 * HOUR, 'items.html');
    // Another page of the list (/items/2) never retires an /items row.
    h.file(listPage([...filler(10)], { path: '/items/2' }), NOW - 2 * HOUR, 'items 2.html');
    expect(h.repo.scraptfListRow(NC_HUE)).not.toBeNull();
    // A window snapshot of /items cut short with a third of its rows: no save, nothing retired.
    const r = h.window(listPage(filler(4)), 'https://scrap.tf/items', NOW - HOUR, false);
    expect(r.stockSave).toBe('unsettled');
    expect(h.imported(NC_HUE)).toHaveLength(1);
    expect(h.repo.scraptfListRow(NC_HUE)).not.toBeNull();
  });
});

describe('an /items window snapshot cut before its settle read (F06, F53)', () => {
  const rows = [...filler(20), ncHue()];

  it('is a whole save when it read every row of the last save, so the history moves on', () => {
    const h = setup();
    h.file(listPage(rows), NOW - 20 * HOUR, 'items.html');
    const r = h.window(listPage(rows), 'https://scrap.tf/items', NOW - MIN, false);
    expect(r.stockSave).toBe('written');
    expect(h.repo.bankStockSaves('list', 1)[0]!.batchId).toBe(r.batchId);
  });

  it('is a whole save on a first look of a plausible size, and stays unsettled when it is short', () => {
    const h = setup();
    expect(h.window(listPage(rows), 'https://scrap.tf/items', NOW - 2 * HOUR, false).stockSave).toBe('written');
    // Fewer than 90 % of that save's rows: cut short.
    expect(h.window(listPage([...filler(10), ncHue()]), 'https://scrap.tf/items', NOW - HOUR, false).stockSave).toBe('unsettled');
    // A first look of a tiny page cannot be told whole.
    const t = setup();
    expect(t.window(listPage([ncHue()]), 'https://scrap.tf/items', NOW - HOUR, false).stockSave).toBe('unsettled');
  });

  it('keeps P1 first: a row with no readable stock leaves the snapshot unsettled', () => {
    const h = setup();
    h.file(listPage(rows), NOW - 2 * HOUR, 'items.html');
    const r = h.window(listPage([...filler(20), ncHue({ stock: '' })]), 'https://scrap.tf/items', NOW - MIN, false);
    expect(r.stockSave).toBe('unsettled');
  });

  it('a settled read far short of the last save is partial, and says so', () => {
    const h = setup();
    h.file(listPage(rows), NOW - 2 * HOUR, 'items.html');
    const r = h.file(listPage([...filler(10), ncHue()]), NOW - HOUR, 'items.html');
    expect(r.stockSave).toBe('partial');
    expect(r.warnings).toContainEqual(expect.stringMatching(new RegExp(`^${PARTIAL_READ}: 11 of ~21 rows on screen`)));
    // A partial look still stores its prices and list rows, and retires nothing.
    expect(h.imported(NC_HUE)).toHaveLength(1);
  });

  it('a bank page snapshot stays unsettled (ACT-4 unchanged)', () => {
    const h = setup();
    h.file(itemsBank([ncHueCard(), otherCard()]), NOW - 2 * HOUR, 'items bank.html');
    expect(h.window(itemsBank([ncHueCard(), otherCard()]), 'https://scrap.tf/buy/items', NOW - MIN, false).stockSave).toBe('unsettled');
  });
});
