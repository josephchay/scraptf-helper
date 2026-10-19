// F17 wiring in the real core: two saves of scrap.tf/buy/hats imported through 'import.html' (as the
// folder watch does) refresh the bank stock cache, notify the new flip once ("New on scrap.tf (Hats):
// …", none for the first save), push 'scraptf.banksChanged', and reach every reader: 'scraptf.bankStock',
// the banks cards' whatsNew, the Live market's scraptfNewAt and "New on scrap.tf" filter, item.detail's
// bankStock and the CSV export. Runs against a temp repo with buy orders stored before start; the pages
// are synthetic saves (R10) and only the schema host answers at start. Nothing here requests scrap.tf
// or anything else after start (R1).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { Repo } from '../../src/service/contracts';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { BankStockResult, ItemDetail, ImportResult, Listing, MarketListResult, ScraptfBanksResult } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(u.hostname + u.pathname);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
  if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(100);
  }
}

let seq = 0;
function buyers(sku: string, scrap: number, n = 3): Listing[] {
  return Array.from({ length: n }, () => {
    seq++;
    return makeListing({ id: `bs${seq}`, sku, baseSku: sku, steamid: `7656119800088${String(seq).padStart(4, '0')}`, metalScrap: scrap, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

/** scrap.tf item cards as saved with Ctrl+S (the markup of test/fixtures/import/buy_hats.html; made-up ids and prices). */
const CARDS = {
  teamCaptain: `<div data-id="9200000001" data-slot="head" data-classes="multi" data-content="Level 10<br/><small style='color:#3498db;'></small>" data-appid="440" data-item-group-hash="aa11" data-num-available="3" data-num-selected="0" data-item-value="12" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="Team Captain" data-defindex="378"><div class="item-value-indicator">1.33 ref</div><div class="item-group-num-text" id="group-num-available">3x</div></div>`,
  billsHat: `<div data-id="9200000002" data-slot="head" data-classes="multi" data-content="Level 5<br/><small style='color:#3498db;'></small>" data-appid="440" data-item-value="15" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="Bill&apos;s Hat" data-defindex="126"><div class="item-value-indicator">1.66 refined</div></div>`,
};

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

async function setup(seed: (repo: Repo) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-bankstock-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  seed(repo);
  repo.close();
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    import: { enabled: true, acknowledgedAt: NOW - HOUR },
    // The buy side's confidence is not what this test is about (test/domain/bankStockNotify.test.ts is).
    notifications: { minConfidence: 0 },
  });
  const core = createServiceCore({ dataDir, version: '0.6.0', settings, secrets: {}, log: createLogger({ dataDir }), fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const importPage = (cards: readonly string[], mtimeMs: number) => call<ImportResult>('import.html', { html: hatsPage(cards), fileName: 'Hat Trading - TF2 - Scrap.TF.html', mtimeMs });
  const newOnScraptf = () => pushes.filter((p) => p.event === 'notify' && String((p.payload as { title?: unknown }).title).startsWith('New on scrap.tf'));
  return { core, call, pushes, importPage, newOnScraptf };
}

describe('bank stock in the core (F17)', () => {
  it('turns two saves of a bank into what is new, everywhere, and notifies the new flip once', async () => {
    const h = await setup((repo) => repo.upsertListings(buyers('378;6', 300)));
    await waitFor('the Live market build', async () => {
      const m = await h.call<MarketListResult>('market.list', {});
      return !m.stats.building && m.rows.some((r) => r.sku === '378;6' && r.buyerCount > 0);
    });

    // First save: Bill's Hat only. Nothing is new on a first save, so nothing is notified.
    const first = await h.importPage([CARDS.billsHat], NOW - 3 * HOUR);
    expect(first).toMatchObject({ bank: 'hats', stored: 1 });
    expect(h.newOnScraptf()).toEqual([]);
    const one = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' });
    expect(one).toMatchObject({ savedAt: NOW - 3 * HOUR, previousSavedAt: null, saves: 1, total: 1 });
    expect((await h.call<ScraptfBanksResult>('scraptf.banks')).banks.find((b) => b.bank === 'hats')!.whatsNew).toBeNull();

    // Second save: Team Captain appeared, and its buyers pay far more than 1.33 ref.
    h.pushes.length = 0;
    const second = await h.importPage([CARDS.teamCaptain, CARDS.billsHat], NOW - MIN);
    expect(second).toMatchObject({ bank: 'hats', stored: 2 });
    // The stock page.
    const stock = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'new' });
    expect(stock).toMatchObject({ bank: 'hats', label: 'Hats', savedAt: NOW - MIN, previousSavedAt: NOW - 3 * HOUR, saves: 2, total: 1 });
    expect(stock.counts).toMatchObject({ items: 2, inStock: 2, new: 1, newFlips: 1, gone: 0 });
    expect(stock.rows[0]).toMatchObject({ sku: '378;6', change: 'new', costScrap: 12, stock: 3, verdict: 'flip' });
    const name = stock.rows[0]!.name;
    expect(name).toMatch(/Team Captain$/);

    const told = h.newOnScraptf();
    expect(told).toHaveLength(1);
    expect(told[0]!.payload).toMatchObject({ title: `New on scrap.tf (Hats): ${name}`, sku: '378;6' });
    expect((told[0]!.payload as { body: string }).body).toMatch(/^1\.33 ref, sells for .+ to .+, \+.+ ref$/);

    // The banks card, the Live market and the drawer.
    expect((await h.call<ScraptfBanksResult>('scraptf.banks')).banks.find((b) => b.bank === 'hats')!.whatsNew).toEqual({
      new: 1,
      newFlips: 1,
      gone: 0,
      cheaper: 0,
      pricier: 0,
      since: NOW - 3 * HOUR,
    });
    const market = await h.call<MarketListResult>('market.list', { newOnScraptf: true });
    expect(market.rows.map((r) => [r.sku, r.scraptfNewAt])).toEqual([['378;6', NOW - MIN]]);
    expect(market.rows[0]!.revenueScrap).toBe(stock.rows[0]!.revenueScrap);
    expect(market.rows[0]!.maxCostScrap).toBe(stock.rows[0]!.maxCostScrap);
    const detail = await h.call<ItemDetail>('item.detail', { sku: '378;6', history: false });
    expect(detail.bankStock).toEqual({ bank: 'hats', savedAt: NOW - MIN, change: 'new', previousCostScrap: null, stock: 3 });
    const csv = await h.call<{ csv: string; suggestedName: string }>('opps.exportCsv', { kind: 'bankStock', bankStock: { bank: 'hats', filter: 'new' } });
    expect(csv.csv).toContain(`378;6,${name},hats,,new,`);

    // The banks page and the stock page hear of it (throttled push).
    await waitFor('scraptf.banksChanged', async () => h.pushes.some((p) => p.event === 'scraptf.banksChanged'), 4_000);

    // The same file imported again (the Import page's picker: same mtime, a new batch): still what changed
    // since the save before it, and nothing told twice.
    await h.importPage([CARDS.teamCaptain, CARDS.billsHat], NOW - MIN);
    expect(h.newOnScraptf()).toHaveLength(1);
    const again = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'new' });
    expect(again).toMatchObject({ savedAt: NOW - MIN, previousSavedAt: NOW - 3 * HOUR, saves: 3, total: 1 });
    expect((await h.call<MarketListResult>('market.list', { newOnScraptf: true })).rows.map((r) => r.sku)).toEqual(['378;6']);

    // The same page saved again a minute later: nothing new since the save before it, so no second
    // notification (S3 reads one save at a time). 0.7.1 (CQ-2): it is the same session, so the stock
    // page, the banks card and the New badge still show what is new since the save 3 h ago.
    await h.importPage([CARDS.teamCaptain, CARDS.billsHat], NOW);
    expect(h.newOnScraptf()).toHaveLength(1);
    expect(await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' })).toMatchObject({ savedAt: NOW, previousSavedAt: NOW - 3 * HOUR, counts: { new: 1 } });
    expect((await h.call<MarketListResult>('market.list', { newOnScraptf: true })).rows.map((r) => [r.sku, r.scraptfNewAt])).toEqual([['378;6', NOW]]);
    expect(requested).toEqual([]);
  }, 30_000);
});
