// F17-C1: several pages give one bank (/items and /items/2 the list, /unusuals/12 and /unusuals/378 the
// unusuals), and two different pages must never be diffed as two saves of the same page: that read as
// everything on the second page "new", everything on the first "gone", and sent "New on scrap.tf"
// notifications for items that had not changed. The page a file is (scraptfPageKey), then the real
// importSavedPage over the fixtures split into sub-pages, into the bank stock cache and the notifier
// wired as core wires them (ctx.bankStockChanged: refresh, then imported). Pages the user saved only
// (R10); the addresses below are only text inside saved files, nothing is fetched (R1).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, createNewFlipNotifier, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { pageKindFromUrl, parseScrapTfHtml, scraptfPageKey } from '../../src/service/import';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { bankStockOnSale } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { KeyPriceState, ScraptfBank } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');
const LIST = fixture('items_list.html');
const UNUSUALS = fixture('unusuals.html');

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

// ---------------------------------------------------------------------------
// The fixtures as sub-pages
// ---------------------------------------------------------------------------

/** The /items fixture's price rows, each `<tr data-quality …>…</tr>` with its leading whitespace. */
function listRows(): string[] {
  const start = LIST.indexOf('<tbody>') + '<tbody>'.length;
  const end = LIST.indexOf('</tbody>');
  const rows = LIST.slice(start, end).split(/(?=\n\s*<tr data-quality=)/).filter((r) => r.includes('<tr data-quality='));
  expect(rows).toHaveLength(13);
  return rows;
}

/** The /items fixture with only `rows`, saved from `url`. */
function listPage(rows: readonly string[], url: string): string {
  const start = LIST.indexOf('<tbody>') + '<tbody>'.length;
  const end = LIST.indexOf('</tbody>');
  const out = (LIST.slice(0, start) + rows.join('') + '\n' + LIST.slice(end)).replace('content="https://scrap.tf/items"', `content="${url}"`);
  expect(out).toContain(`content="${url}"`);
  return out;
}

/** The unusuals fixture's cards U1..U7, each from its `<!-- Un` comment. */
function unusualCards(): string[] {
  const start = UNUSUALS.indexOf('<!-- U1');
  const end = UNUSUALS.indexOf('\t\t\t</div>\n\t\t</div>\n\t</body>');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const cards = UNUSUALS.slice(start, end).split(/(?=<!-- U\d)/);
  expect(cards).toHaveLength(7);
  return cards;
}

/** The unusuals fixture with only `cards`, saved from `url` (canonical and og:url). */
function unusualsPage(cards: readonly string[], url: string): string {
  const start = UNUSUALS.indexOf('<!-- U1');
  const end = UNUSUALS.indexOf('\t\t\t</div>\n\t\t</div>\n\t</body>');
  const out = (UNUSUALS.slice(0, start) + cards.join('') + UNUSUALS.slice(end)).split('"https://scrap.tf/unusuals"').join(`"${url}"`);
  expect(out.match(new RegExp(`"${url}"`, 'g'))).toHaveLength(2);
  return out;
}

/** What one list row parses to on its own: its SKU and whether a save would list it on sale. */
function rowInfo(row: string): { sku: string | null; name: string; onSale: boolean } {
  const item = parseScrapTfHtml(listPage([row], 'https://scrap.tf/items'), createStubSchema()).items[0]!;
  return { sku: item.sku, name: item.name, onSale: item.sku !== null && bankStockOnSale({ costKeys: item.costKeys, costScrap: item.costScrap, stock: item.stock }) && item.costKeys + item.costScrap > 0 };
}

// ---------------------------------------------------------------------------
// The harness: importSavedPage -> bank stock cache -> notifier, as core wires them
// ---------------------------------------------------------------------------

/** Every item has three buyers far above any price on the pages: every row on sale is a flip. */
function flipEntry(): MarketEval {
  const revenue = 1_000_000;
  const o = {
    listingId: 'l1',
    steamid: '76561198000000002',
    userName: 'KeyBot',
    keys: 0,
    metalScrap: revenue,
    valueScrap: revenue,
    isBot: true,
    online: true,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
  return {
    bestScrap: revenue,
    consScrap: revenue,
    instantScrap: revenue,
    revenueScrap: revenue,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 3,
    eligibleCount: 3,
    maxCostScrap: revenue - 100,
    confidence: 80,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
  };
}

interface Harness {
  repo: Repo;
  stock: BankStock;
  sent: PushContract['notify'][];
  save(html: string, at: number): { batchId: number; bank?: ScraptfBank | null };
}

function setup(): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - 3_600_000 },
    notifications: { enabled: true, minConfidence: 0, minProfitScrap: 0 },
  });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const clock = { now: () => NOW };
  const sent: PushContract['notify'][] = [];
  const entry = flipEntry();
  const stock = createBankStock({ clock, log, repo, market: { entryFor: () => entry }, keyPrice: () => KEY, settings: () => settings, categoryOf: () => 'other' });
  const notifier = createNewFlipNotifier({ log, repo, clock, stock, settings: () => settings, keyPrice: () => KEY, notify: (n) => sent.push(n), marketBuilt: () => true });
  const ctx = {
    clock,
    log,
    repo,
    schema: createStubSchema(),
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    // As core's bankStockChanged: the cache re-reads the saves, then the notifier judges the import.
    // F20: the change feed's import hook (writes no event in these tests).
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: (imported?: { bank: ScraptfBank; batchId: number }) => {
      stock.refresh();
      if (imported) notifier.imported(imported);
    },
  } as unknown as HandlerContext;
  return { repo, stock, sent, save: (html, at) => importSavedPage(ctx, { html, fileName: 'Item Trading - TF2 - Scrap.TF.html', mtimeMs: at }) };
}

const skusOf = (rows: readonly { sku: string }[]): string[] => [...new Set(rows.map((r) => r.sku))].sort();

// ---------------------------------------------------------------------------

describe('the page a saved file is (scraptfPageKey)', () => {
  it.each<[string, string]>([
    ['https://scrap.tf/buy/hats', '/buy/hats'],
    ['https://scrap.tf/buy/hats/', '/buy/hats'],
    ['https://SCRAP.TF/Buy/Hats?sort=price#top', '/buy/hats'],
    ['https://scrap.tf/items', '/items'],
    ['https://scrap.tf/items/2', '/items/2'],
    ['https://scrap.tf/unusuals', '/unusuals'],
    ['https://scrap.tf/unusuals/378/', '/unusuals/378'],
    ['https://scrap.tf/buy/unusuals', '/unusuals'],
    ['https://scrap.tf/unusual/378', '/unusuals/378'],
    ['https://web.archive.org/web/20261014041145/https://scrap.tf/items/3', '/items/3'],
  ])('%s -> %s', (url, page) => {
    expect(scraptfPageKey(pageKindFromUrl(url), 'pid-ignored')).toBe(page);
  });

  it('uses the body id of a file with no scrap.tf address, never a path, else nothing', () => {
    expect(scraptfPageKey(null, ' PID-BUY-HATS ')).toBe('pid-buy-hats');
    expect(scraptfPageKey(pageKindFromUrl('https://example.com/buy/hats'), 'pid-buy-hats')).toBe('pid-buy-hats');
    expect(scraptfPageKey(null, null)).toBe('');
    expect(scraptfPageKey(pageKindFromUrl(`https://scrap.tf/buy/hats/${'x'.repeat(500)}`), null)).toHaveLength(200);
  });

  it('is on every parse result, the fixtures included', () => {
    const schema = createStubSchema();
    expect(parseScrapTfHtml(fixture('buy_hats.html'), schema).page).toBe('/buy/hats');
    expect(parseScrapTfHtml(fixture('buy_skins.html'), schema).page).toBe('/buy/skins');
    expect(parseScrapTfHtml(UNUSUALS, schema).page).toBe('/unusuals');
    expect(parseScrapTfHtml(LIST, schema).page).toBe('/items');
    expect(parseScrapTfHtml(listPage(listRows().slice(4), 'https://scrap.tf/items/2'), schema).page).toBe('/items/2');
    // No address at all: the body id.
    const bare = fixture('buy_hats.html').replace(/<!-- saved from[^>]*-->/, '').replace(/<meta property="og:url"[^>]*>/, '');
    expect(parseScrapTfHtml(bare, schema)).toMatchObject({ bank: 'hats', page: 'pid-buy-hats' });
  });
});

describe('two pages of one bank are never compared as two saves of a page (F17-C1)', () => {
  it('/items then /items/2: nothing new or gone, no notification, and every item of both pages shown', () => {
    const h = setup();
    const rows = listRows();
    const first = h.save(listPage(rows.slice(0, 4), 'https://scrap.tf/items'), NOW - 10 * MIN);
    const second = h.save(listPage(rows.slice(4), 'https://scrap.tf/items/2'), NOW - 5 * MIN);
    expect([first.bank, second.bank]).toEqual(['list', 'list']);
    expect(h.repo.bankStockSaves('list').map((s) => [s.batchId, s.page])).toEqual([
      [second.batchId, '/items/2'],
      [first.batchId, '/items'],
    ]);

    const r = h.stock.list({ bank: 'list', limit: 2000 }, NOW);
    expect(r.counts).toMatchObject({ new: 0, gone: 0, cheaper: 0, pricier: 0, newFlips: 0 });
    // Each page's first save: nothing to compare yet, so no "What's new" and no change filters.
    expect(r).toMatchObject({ savedAt: NOW - 5 * MIN, previousSavedAt: null, saves: 2, pages: 2, oldestSavedAt: NOW - 10 * MIN });
    expect(h.stock.whatsNew('list')).toBeNull();
    expect(h.stock.list({ bank: 'list', filter: 'gone' }, NOW).rows).toEqual([]);
    // Every item on sale on either page is on the stock page, from its own page's save.
    const onSale = (part: readonly string[]) => part.map(rowInfo).filter((x) => x.onSale).map((x) => x.sku!);
    const page1 = onSale(rows.slice(0, 4));
    const page2 = onSale(rows.slice(4));
    expect(page1.length).toBeGreaterThan(0);
    expect(page2.length).toBeGreaterThan(0);
    expect(skusOf(r.rows)).toEqual([...new Set([...page1, ...page2])].sort());
    expect(h.stock.detailFor(page1[0]!)).toMatchObject({ bank: 'list', savedAt: NOW - 10 * MIN, change: null });
    expect(h.stock.detailFor(page2[0]!)).toMatchObject({ bank: 'list', savedAt: NOW - 5 * MIN, change: null });
    for (const sku of [...page1, ...page2]) expect(h.stock.newAtFor(sku), sku).toBeNull();
    // No "New on scrap.tf" toast for items that did not change on scrap.tf.
    expect(h.stock.newFlips('list', second.batchId)).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('/unusuals/12 then /unusuals/378: nothing new or gone and no notification', () => {
    const h = setup();
    const cards = unusualCards();
    const a = h.save(unusualsPage(cards.slice(0, 3), 'https://scrap.tf/unusuals/12'), NOW - 10 * MIN);
    const b = h.save(unusualsPage(cards.slice(3), 'https://scrap.tf/unusuals/378'), NOW - 5 * MIN);
    expect([a.bank, b.bank]).toEqual(['unusuals', 'unusuals']);
    expect(h.repo.bankStockSaves('unusuals').map((s) => s.page)).toEqual(['/unusuals/378', '/unusuals/12']);
    const r = h.stock.list({ bank: 'unusuals', limit: 2000 }, NOW);
    expect(r.counts).toMatchObject({ new: 0, gone: 0, newFlips: 0 });
    expect(r.total).toBeGreaterThan(0);
    expect(h.stock.whatsNew('unusuals')).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it('compares a later save of /items/2 with the earlier /items/2 only, and tells only what it made new', () => {
    const h = setup();
    const rows = listRows();
    // Two rows of page 2 that are on sale: one missing from the first save of it, one from the second.
    const page2 = rows.slice(4);
    const sale = page2.map((row, i) => ({ i, ...rowInfo(row) })).filter((x) => x.onSale);
    expect(sale.length).toBeGreaterThanOrEqual(3);
    const back = sale[0]!;
    const out = sale[1]!;
    h.save(listPage(rows.slice(0, 4), 'https://scrap.tf/items'), NOW - 30 * MIN);
    h.save(listPage(page2.filter((_, i) => i !== back.i), 'https://scrap.tf/items/2'), NOW - 20 * MIN);
    expect(h.sent).toEqual([]);
    const third = h.save(listPage(page2.filter((_, i) => i !== out.i), 'https://scrap.tf/items/2'), NOW - 10 * MIN);

    const r = h.stock.list({ bank: 'list', limit: 2000 }, NOW);
    expect(r.counts).toMatchObject({ new: 1, gone: 1, newFlips: 1 });
    expect(r).toMatchObject({ savedAt: NOW - 10 * MIN, previousSavedAt: NOW - 20 * MIN, pages: 2, oldestSavedAt: NOW - 30 * MIN });
    expect(h.stock.list({ bank: 'list', filter: 'new' }, NOW).rows.map((x) => x.sku)).toEqual([back.sku]);
    expect(h.stock.list({ bank: 'list', filter: 'gone' }, NOW).rows.map((x) => x.sku)).toEqual([out.sku]);
    // Page 1's items are neither new nor gone: /items was never compared with /items/2.
    const page1 = rows.slice(0, 4).map(rowInfo).filter((x) => x.onSale);
    for (const p of page1) expect(r.rows.find((x) => x.sku === p.sku)?.change, p.sku!).toBeNull();
    expect(h.stock.whatsNew('list')).toMatchObject({ new: 1, newFlips: 1, gone: 1, since: NOW - 20 * MIN });
    expect(h.stock.newFlips('list', third.batchId).map((x) => x.sku)).toEqual([back.sku]);
    expect(h.sent.map((n) => [n.title, n.sku])).toEqual([[`New on scrap.tf (All items): ${r.rows.find((x) => x.sku === back.sku)!.name}`, back.sku]]);
  });
});
