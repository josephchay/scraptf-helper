// F17 end to end in the real core, over the real saved-page fixture: buy_hats.html is imported, then a
// later save of the same page with one card gone (B.A.S.E. Jumper), one new (Earbuds), one cheaper
// (Genuine Bill's Hat, 5 -> 4 ref) and one pricier (Non-Craftable Bill's Hat, 1 -> 1.33 ref). Each step
// of the chain is checked where it lands: importSavedPage ('import.html', as the folder watch calls it)
// -> bank_stock rows on disk -> the diff -> the banks card's whatsNew -> 'scraptf.bankStock' rows joined
// to the live book -> the Live market's scraptfNewAt and "New on scrap.tf" filter -> item.detail's
// bankStock -> one "New on scrap.tf" toast (none for the first save, and no second "Profit:" toast from
// the engine) -> the 'scraptf.banksChanged' push. Live check and the banks page still answer as before.
//
// Offline (R1, R10): the pages are local files the "user" saved; only the schema host answers at start,
// and nothing at all is requested after it. No scrap.tf address is ever fetched.

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
import { bankStockKey, bankStockOnSale } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { BankStockResult, CheckResult, ImportResult, ItemDetail, Listing, MarketListResult, OppListResult, ScraptfBanksResult } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const HATS = readFileSync(path.join(FIX, 'import/buy_hats.html'), 'utf8');
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
const repos: Repo[] = [];
afterEach(async () => {
  while (repos.length) repos.pop()!.close();
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
/** Three buyers of one SKU, fresh, at `scrap` each (eligible orders, so no suspect margin). */
function buyers(sku: string, scrap: number): Listing[] {
  return Array.from({ length: 3 }, (_, i) => {
    seq++;
    return makeListing({ id: `wire${seq}`, sku, baseSku: sku, steamid: `7656119800077${String(seq).padStart(4, '0')}`, metalScrap: scrap - i, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

/** One card of buy_hats.html, from its `<!-- Cnn` comment up to the next card's comment. */
function card(html: string, id: string): string {
  const start = html.indexOf(`<!-- ${id}:`);
  const end = html.indexOf('<!-- C', start + 4);
  if (start < 0 || end < 0) throw new Error(`no card ${id} in the fixture`);
  return html.slice(start, end);
}

/** Earbuds (defindex 143), a hat the first save did not have; the markup of the fixture's C02. */
const EARBUDS = [
  '<!-- C99: new since the first save -->',
  `<div data-id="9100000099" data-slot="head" data-classes="multi" data-content="Level 1<br/><small style='color:#3498db;'></small>" data-appid="440" data-item-value="18" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="Earbuds" data-defindex="143">`,
  '\t<div class="item-value-indicator">2 ref</div>',
  '</div>',
  '',
  '',
].join('\n');

/** The later save: C13 gone, Earbuds added, C36 down to 4 ref, C14 up to 1.33 ref. */
function laterSave(html: string): string {
  const base = card(html, 'C13');
  const nonCraft = card(html, 'C14');
  const genuine = card(html, 'C36');
  const out = html
    .replace(base, EARBUDS)
    .replace(nonCraft, nonCraft.replace('data-item-value="9"', 'data-item-value="12"').replace('>1 ref<', '>1.33 ref<'))
    .replace(genuine, genuine.replace('data-item-value="45"', 'data-item-value="36"').replace('>5 ref<', '>4 ref<'));
  // The edits landed (each replace is checked, so a fixture change cannot silently weaken this test).
  expect(out).not.toContain('data-title="B.A.S.E. Jumper"');
  expect(out).toContain('data-title="Earbuds"');
  expect(out).toContain('>1.33 ref<');
  expect(out).toContain('>4 ref<');
  return out;
}

const GENUINE = '126;1';
const NON_CRAFT = '126;6;uncraftable';
const BASE_JUMPER = '1101;6;uncraftable';
const EARBUDS_SKU = '143;6';

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-bankstock-wire-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const dbPath = path.join(dataDir, DB_FILE_NAME);
  const seedRepo = openRepo(dbPath);
  // Buyers for the hat that stays (Team Captain), the new one, the cheaper and the pricier one.
  seedRepo.upsertListings([...buyers('378;6', 300), ...buyers(EARBUDS_SKU, 250), ...buyers(GENUINE, 400), ...buyers(NON_CRAFT, 100)]);
  seedRepo.close();
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    import: { enabled: true, acknowledgedAt: NOW - HOUR },
    // The buy side's confidence is test/domain/bankStockNotify.test.ts's subject, not this one's.
    notifications: { minConfidence: 0 },
  });
  const core = createServiceCore({ dataDir, version: '0.6.0', settings, secrets: {}, log: createLogger({ dataDir }), fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown; at: number }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload, at: Date.now() }));
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const importPage = (html: string, mtimeMs: number) => call<ImportResult>('import.html', { html, fileName: 'Hat Trading - TF2 - Scrap.TF.html', mtimeMs });
  const notes = () => pushes.filter((p) => p.event === 'notify').map((p) => p.payload as { title: string; body: string; sku: string | null });
  /** A second connection to the core's database file (WAL), to see the rows exactly as stored. */
  const disk = () => {
    const r = openRepo(dbPath);
    repos.push(r);
    return r;
  };
  return { core, call, pushes, importPage, notes, disk };
}

describe('scrap.tf bank stock, wired end to end (F17)', () => {
  it('takes two saves of buy_hats.html from the import to every reader, and notifies the one new flip once', async () => {
    const h = await setup();
    await waitFor('the Live market build', async () => {
      const m = await h.call<MarketListResult>('market.list', {});
      return !m.stats.building && m.stats.lastFullAt !== null && m.rows.some((r) => r.sku === EARBUDS_SKU && r.buyerCount === 3);
    });

    // ---- First save: a snapshot, nothing new, nothing told. ----
    const first = await h.importPage(HATS, NOW - 3 * HOUR);
    expect(first).toMatchObject({ bank: 'hats' });
    const disk1 = h.disk();
    const saves1 = disk1.bankStockSaves('hats');
    expect(saves1.map((s) => [s.batchId, s.savedAt])).toEqual([[first.batchId, NOW - 3 * HOUR]]);
    const rows1 = disk1.bankStockRows(first.batchId);
    const keys1 = new Set(rows1.map((r) => bankStockKey(r.sku, r.specialKey)));
    expect(keys1.has(`${BASE_JUMPER}|`)).toBe(true);
    expect(keys1.has(`${EARBUDS_SKU}|`)).toBe(false);
    // Every price the import stored is a row on sale in the snapshot.
    expect(rows1.filter(bankStockOnSale)).toHaveLength(first.stored);

    const once = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' });
    expect(once).toMatchObject({ bank: 'hats', savedAt: NOW - 3 * HOUR, previousSavedAt: null, saves: 1 });
    expect(once.counts).toMatchObject({ new: 0, gone: 0, cheaper: 0, pricier: 0, newFlips: 0 });
    expect(once.rows.every((r) => r.change === null)).toBe(true);
    expect((await h.call<ScraptfBanksResult>('scraptf.banks')).banks.find((b) => b.bank === 'hats')).toMatchObject({ lastSavedAt: NOW - 3 * HOUR, whatsNew: null });
    expect((await h.call<MarketListResult>('market.list', { newOnScraptf: true })).rows).toEqual([]);
    expect(h.notes().filter((n) => n.title.startsWith('New on scrap.tf'))).toEqual([]);

    // Let the engine judge the first save's prices (its own "Profit:" toasts for them) before the next save.
    await waitFor('the engine on the first save', async () => (await h.call<OppListResult>('opps.list', { inputKinds: ['import'] })).rows.some((o) => o.sku === GENUINE));
    await settle(300);

    // ---- The later save of the same page. ----
    h.pushes.length = 0;
    const later = await h.importPage(laterSave(HATS), NOW - MIN);
    expect(later).toMatchObject({ bank: 'hats' });

    // bank_stock rows on disk: both saves kept, the new card in, the removed one out.
    const disk2 = h.disk();
    expect(disk2.bankStockSaves('hats').map((s) => s.batchId)).toEqual([later.batchId, first.batchId]);
    expect(disk2.bankStockLatestPair('hats')).toMatchObject({ newest: { batchId: later.batchId }, previous: { batchId: first.batchId } });
    const keys2 = new Set(disk2.bankStockRows(later.batchId).map((r) => bankStockKey(r.sku, r.specialKey)));
    expect(keys2.has(`${EARBUDS_SKU}|`)).toBe(true);
    expect(keys2.has(`${BASE_JUMPER}|`)).toBe(false);

    // The diff, as the stock page reads it.
    const all = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' });
    expect(all).toMatchObject({ savedAt: NOW - MIN, previousSavedAt: NOW - 3 * HOUR, saves: 2 });
    expect(all.counts).toMatchObject({ new: 1, gone: 1, cheaper: 1, pricier: 1, newFlips: 1 });
    const bySku = (r: BankStockResult, sku: string) => r.rows.find((x) => x.sku === sku && !x.hasExtras);
    expect(bySku(all, EARBUDS_SKU)).toMatchObject({ change: 'new', costScrap: 18, previousCostScrap: null, verdict: 'flip' });
    expect(bySku(all, GENUINE)).toMatchObject({ change: 'cheaper', costScrap: 36, previousCostScrap: 45 });
    expect(bySku(all, NON_CRAFT)).toMatchObject({ change: 'pricier', costScrap: 12, previousCostScrap: 9 });
    expect(bySku(all, '378;6')).toMatchObject({ change: null });
    // Gone rows only under their own filter, at their last price.
    expect(bySku(all, BASE_JUMPER)).toBeUndefined();
    const gone = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'gone' });
    expect(gone.rows.map((r) => [r.sku, r.change, r.costScrap, r.stock])).toEqual([[BASE_JUMPER, 'gone', 5, null]]);
    const changed = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'changed', sort: 'name' });
    expect(changed.rows.map((r) => r.sku).sort()).toEqual([GENUINE, NON_CRAFT].sort());
    const newOnes = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'new' });
    expect(newOnes.rows.map((r) => r.sku)).toEqual([EARBUDS_SKU]);

    // Each row joined to the live book: the same buy side as the Live market's row of that item.
    const market = await h.call<MarketListResult>('market.list', { limit: 2000 });
    for (const sku of [EARBUDS_SKU, GENUINE, NON_CRAFT, '378;6']) {
      const m = market.rows.find((r) => r.sku === sku)!;
      const s = bySku(all, sku)!;
      expect(s.revenueScrap, sku).toBe(m.revenueScrap);
      expect(s.revenueScrap, sku).not.toBeNull();
      expect(s.maxCostScrap, sku).toBe(m.maxCostScrap);
      expect(s.buyerCount, sku).toBe(3);
      expect(s.revenueOrder?.listingId, sku).toBe(m.revenueOrder?.listingId);
    }
    expect(bySku(all, EARBUDS_SKU)!.profitScrap).toBe(bySku(all, EARBUDS_SKU)!.revenueScrap! - 18 - DEFAULT_SETTINGS.profit.frictionScrap);

    // The banks card's "What's new".
    const card2 = (await h.call<ScraptfBanksResult>('scraptf.banks')).banks.find((b) => b.bank === 'hats')!;
    expect(card2.whatsNew).toEqual({ new: 1, newFlips: 1, gone: 1, cheaper: 1, pricier: 1, since: NOW - 3 * HOUR });
    expect(card2.lastSavedAt).toBe(NOW - MIN);

    // The Live market: the New badge's time and the "New on scrap.tf" filter.
    expect(market.rows.find((r) => r.sku === EARBUDS_SKU)!.scraptfNewAt).toBe(NOW - MIN);
    for (const sku of [GENUINE, NON_CRAFT, '378;6']) expect(market.rows.find((r) => r.sku === sku)!.scraptfNewAt, sku).toBeNull();
    const onlyNew = await h.call<MarketListResult>('market.list', { newOnScraptf: true });
    expect(onlyNew.rows.map((r) => [r.sku, r.scraptfNewAt])).toEqual([[EARBUDS_SKU, NOW - MIN]]);

    // The item panel.
    const detail = async (sku: string) => (await h.call<ItemDetail>('item.detail', { sku, history: false })).bankStock;
    expect(await detail(EARBUDS_SKU)).toEqual({ bank: 'hats', savedAt: NOW - MIN, change: 'new', previousCostScrap: null, stock: 1 });
    expect(await detail(GENUINE)).toEqual({ bank: 'hats', savedAt: NOW - MIN, change: 'cheaper', previousCostScrap: 45, stock: 1 });
    expect(await detail(NON_CRAFT)).toMatchObject({ change: 'pricier', previousCostScrap: 9 });
    expect(await detail(BASE_JUMPER)).toEqual({ bank: 'hats', savedAt: NOW - MIN, change: 'gone', previousCostScrap: 5, stock: null });
    expect(await detail('378;6')).toMatchObject({ bank: 'hats', change: null });

    // The CSV export of a filter.
    const csv = await h.call<{ csv: string; suggestedName: string }>('opps.exportCsv', { kind: 'bankStock', bankStock: { bank: 'hats', filter: 'gone' } });
    expect(csv.suggestedName).toMatch(/^flipdesk-bank-stock-hats-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.csv.split('\n').filter((l) => l.trim() !== '')).toHaveLength(2);
    expect(csv.csv).toContain(`${BASE_JUMPER},`);

    // One "New on scrap.tf" toast, for the new flip; the banks page hears of the save.
    const earbudsName = bySku(all, EARBUDS_SKU)!.name;
    expect(earbudsName).toMatch(/Earbuds$/);
    expect(h.notes().filter((n) => n.title.startsWith('New on scrap.tf'))).toEqual([
      { title: `New on scrap.tf (Hats): ${earbudsName}`, body: expect.stringMatching(/^2\.00 ref, sells for .+ to .+, \+.+ ref$/) as unknown as string, sku: EARBUDS_SKU },
    ]);
    await waitFor('scraptf.banksChanged', async () => h.pushes.some((p) => p.event === 'scraptf.banksChanged'), 4_000);

    // The engine judges the new price about a second later: an opportunity, but no second toast.
    await waitFor('the engine on the later save', async () => (await h.call<OppListResult>('opps.list', { inputKinds: ['import'] })).rows.some((o) => o.sku === EARBUDS_SKU && o.status === 'profitable'));
    await settle(300);
    expect(h.notes().filter((n) => n.sku === EARBUDS_SKU)).toHaveLength(1);

    // Live check still answers from the same local data (no request): the imported price, the buyers.
    const check = await h.call<CheckResult>('check.text', { text: 'Earbuds', source: 'manual' });
    expect(check).toMatchObject({ status: 'item', sku: EARBUDS_SKU, verdict: 'flip' });
    expect(check.price).toMatchObject({ valueScrap: 18, source: expect.any(String) as unknown as string });
    expect(check.revenue?.revenueScrap).toBe(bySku(all, EARBUDS_SKU)!.revenueScrap);

    // Every other bank card is as it was: never saved, no "What's new".
    for (const b of (await h.call<ScraptfBanksResult>('scraptf.banks')).banks.filter((x) => x.bank !== 'hats')) {
      expect(b, b.bank).toMatchObject({ lastSavedAt: null, whatsNew: null });
      expect((await h.call<BankStockResult>('scraptf.bankStock', { bank: b.bank })).savedAt, b.bank).toBeNull();
    }

    // Nothing left this process after start: no scrap.tf, no anything (R1).
    expect(requested).toEqual([]);
  }, 45_000);
});
