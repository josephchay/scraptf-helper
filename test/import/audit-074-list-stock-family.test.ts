// 0.7.4 (review R01, R06: the calibration bug through the stock path): an unmarked scrap.tf/items row is
// one entry for every copy scrap.tf sells at its price, so it is never a cost, and its stock row must not
// meet the Craftable copy's buyers either. Before, every /items row went into the list's bank stock save
// under its plain (Craftable) SKU, and the 'All items' Bank stock page, the window's "N flips on this
// page", the Changes feed and a "New on scrap.tf (All items)" toast read the user's "A Distinctive Lack of
// Hue" row (the Non-Craftable copy's price) as a flip against Craftable buy orders. Now the list's stock
// rows carry their craftability (bank_stock.craft, V14): a family row, and rows of one item that differ,
// get no buy side; a proven row still does. Real repo, parser, import, bank stock, notifications and
// scrap.tf history over synthetic pages with the real item schema subset; a fake Live market entry for the
// buy side. Offline (R1, R10).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, notifyNewBankFlips } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { bankStockListFamily } from '../../src/shared/bankStock';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { ImportResult, KeyPriceState } from '../../src/shared/types';
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

interface Row {
  defindex: number;
  name: string;
  price: string;
  stock: string;
  pays?: string;
}

const hue = (over: Partial<Row> = {}): Row => ({ defindex: 5040, name: 'A Distinctive Lack of Hue', price: '1 key, 43.22 refined', pays: '1 key, 37 refined', stock: '4/25', ...over });
const ncHue = (over: Partial<Row> = {}): Row => hue({ name: 'Non-Craftable A Distinctive Lack of Hue', ...over });
const tinge = (over: Partial<Row> = {}): Row => ({ defindex: 5039, name: 'An Extraordinary Abundance of Tinge', price: '1 key, 38 refined', pays: '1 key, 28 refined', stock: '1/25', ...over });
const filler = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ defindex: 60_000 + i, name: 'Filler', price: '1 refined', stock: '0/5' }));

function listPage(rows: readonly Row[]): string {
  const tr = rows
    .map(
      (r) =>
        `<tr data-quality="6" data-defindex="${r.defindex}"><td><img alt="Icon" class="item quality6 rev-banking-background"></td>` +
        `<td>${r.name}</td><td>${r.price}</td><td>${r.pays ?? '1 refined'}</td><td><div class="progress"><div class="bar" title="${r.stock}"></div></div></td></tr>`,
    )
    .join('\n');
  return (
    '<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head>' +
    '<body id="pid-items"><table><thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead>' +
    `<tbody>${tr}</tbody></table></body></html>`
  );
}

/** Verified Craftable bot buyers at `revenueScrap` (the Live market entry of a base SKU). */
function entry(revenueScrap: number): MarketEval {
  const settings = DEFAULT_SETTINGS;
  const o = {
    listingId: `l-${revenueScrap}`,
    steamid: '76561198000000002',
    userName: 'Buyer 1',
    keys: 0,
    metalScrap: revenueScrap,
    valueScrap: revenueScrap,
    isBot: true,
    online: true,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
  return {
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: revenueScrap,
    revenueScrap,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 3,
    eligibleCount: 3,
    maxCostScrap: maxCostFor(revenueScrap, settings.profit),
    confidence: 70,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
  };
}

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - 24 * HOUR },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - 24 * HOUR },
  });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  // The Craftable copy's buyers at 2 keys 10 ref (1290 scrap), and the Non-Craftable copy's at 1 key 50 ref.
  const entries = new Map<string, MarketEval>([
    [HUE, entry(1290)],
    [NC_HUE, entry(1050)],
    [TINGE, entry(1290)],
  ]);
  const market = { entryFor: (base: string) => entries.get(base) ?? null };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market, keyPrice: () => KEY });
  const stock = createBankStock({ clock: { now: () => NOW }, log, repo, market, keyPrice: () => KEY, settings: () => settings, categoryOf: () => 'other', history });
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    scraptfHistory: history,
    bankStock: stock,
    bankStockChanged: () => {
      history.refresh();
      stock.refresh();
    },
  } as unknown as HandlerContext;
  const window = (html: string, mtimeMs: number): ImportResult =>
    importSavedPage(ctx, { html, fileName: 'scrap.tf window /items', mtimeMs, address: 'https://scrap.tf/items', origin: 'window', settled: true });
  const sent: PushContract['notify'][] = [];
  const notify = (batchId: number): number =>
    notifyNewBankFlips({ log, repo, stock, settings: () => settings, keyPrice: () => KEY, notify: (n) => sent.push(n) }, { bank: 'list', batchId }, NOW);
  const listFlips = () => stock.list({ bank: 'list', filter: 'flips' }, NOW).rows.map((r) => r.sku);
  return { repo, stock, history, window, notify, sent, listFlips };
}

describe('the /items list stock path never meets a family row with Craftable buyers (R01, R06)', () => {
  it('stores each list stock row with its craftability, and a bank page card with none', () => {
    const h = setup();
    const r = h.window(listPage([...filler(10), hue(), ncHue({ name: 'Non-Craftable An Extraordinary Abundance of Tinge', defindex: 5039 }), tinge()]), NOW - 2 * HOUR);
    expect(r.stockSave).toBe('written');
    const rows = h.repo.bankStockRows(r.batchId);
    expect(rows.find((x) => x.sku === HUE)).toMatchObject({ craft: 'any' });
    // Tinge sits beside its Non-Craftable row: proven Craftable; the Non-Craftable row proven by name.
    expect(rows.find((x) => x.sku === TINGE)).toMatchObject({ craft: 'craftable' });
    expect(rows.find((x) => x.sku === `${TINGE};uncraftable`)).toMatchObject({ craft: 'uncraftable' });
    expect(bankStockListFamily('list', rows.find((x) => x.sku === HUE))).toBe(true);
    expect(bankStockListFamily('list', rows.find((x) => x.sku === TINGE))).toBe(false);
    expect(bankStockListFamily('items', { craft: undefined })).toBe(false);
  });

  it("gives the user's unmarked Hue row no flip: stock page, What's new, page flips, toasts and the feed", () => {
    const h = setup();
    const first = h.window(listPage(filler(10)), NOW - 2 * HOUR);
    expect(first.pageFlips ?? 0).toBe(0);
    const r = h.window(listPage([...filler(10), hue()]), NOW - HOUR);
    expect(r.stockSave).toBe('written');
    expect(r.stored).toBe(0);
    // The window's toolbar counts no flip on the page, and none new.
    expect(r.pageFlips).toBe(0);
    expect(r.newFlips).toBe(0);
    expect(r.topFlips).toEqual([]);
    // The Bank stock page: the row is listed, with no buyer, Pay up to, profit or flip.
    const row = h.stock.list({ bank: 'list' }, NOW).rows.find((x) => x.sku === HUE)!;
    expect(row).toMatchObject({ change: 'new', costScrap: 989, revenueScrap: null, maxCostScrap: null, profitScrap: null, buyerCount: 0, verdict: 'no-buyers', listFamily: true });
    expect(h.listFlips()).toEqual([]);
    expect(h.stock.list({ bank: 'list' }, NOW).counts.flips).toBe(0);
    expect(h.stock.whatsNew('list')?.newFlips ?? 0).toBe(0);
    expect(h.stock.newFlips('list', r.batchId)).toEqual([]);
    expect(h.stock.pageFlips('list', r.batchId)).toEqual([]);
    // No "New on scrap.tf (All items)" toast.
    expect(h.notify(r.batchId)).toBe(0);
    expect(h.sent).toEqual([]);
    // The Changes feed: the new row is no flip and says why.
    const events = h.history.changes({ bank: 'list' }, NOW).filter((e) => e.sku === HUE);
    expect(events.map((e) => [e.kind, e.flip, e.revenueScrap, e.maxCostScrap, e.listFamily])).toEqual([['new', false, null, null, true]]);
  });

  it('rows of one item that differ (duplicate-row) are one family row: no merged flip', () => {
    const h = setup();
    h.window(listPage(filler(10)), NOW - 2 * HOUR);
    const r = h.window(listPage([...filler(10), hue({ stock: '4/25' }), hue({ price: '1 key, 50 refined', stock: '1/25' })]), NOW - HOUR);
    expect(r.stockSave).toBe('written');
    const stored = h.repo.bankStockRows(r.batchId).find((x) => x.sku === HUE)!;
    expect(stored).toMatchObject({ craft: 'any' });
    expect(h.listFlips()).toEqual([]);
    expect(h.stock.newFlips('list', r.batchId)).toEqual([]);
    expect(h.stock.pageFlips('list', r.batchId)).toEqual([]);
    expect(h.notify(r.batchId)).toBe(0);
  });

  it('a row proven to price its copy is still judged against its own book, and can flip', () => {
    const h = setup();
    h.window(listPage(filler(10)), NOW - 2 * HOUR);
    // Non-Craftable Hue by name (its own book, 1050), and Tinge proven Craftable beside its Non-Craftable row.
    const r = h.window(listPage([...filler(10), ncHue({ price: '1 key, 20 refined' }), tinge({ price: '1 key, 50 refined' }), tinge({ name: 'Non-Craftable An Extraordinary Abundance of Tinge', price: '1 key, 30 refined' })]), NOW - HOUR);
    expect(r.stockSave).toBe('written');
    const rows = h.stock.list({ bank: 'list' }, NOW).rows;
    const nc = rows.find((x) => x.sku === NC_HUE)!;
    expect(nc).toMatchObject({ revenueScrap: 1050, verdict: 'flip' });
    expect(nc.listFamily).toBeUndefined();
    expect(rows.find((x) => x.sku === TINGE)).toMatchObject({ revenueScrap: 1290, verdict: 'flip' });
    expect(h.stock.pageFlips('list', r.batchId).map((x) => x.sku).sort()).toEqual([NC_HUE, TINGE].sort());
    expect(r.pageFlips).toBe(2);
    expect(h.notify(r.batchId)).toBeGreaterThan(0);
    expect(h.sent[0]!.title).toMatch(/^New on scrap\.tf \(All items\): /);
    const feed = h.history.changes({ bank: 'list' }, NOW).filter((e) => e.sku === NC_HUE);
    expect(feed.map((e) => [e.kind, e.flip, e.listFamily])).toEqual([['new', true, undefined]]);
  });
});
