// 0.7.1 step I: the packages together in the real core, over the real saved-page fixtures.
//  (i) A card gone from a newer save of its bank (A's DM-1 delete + B's UX-2b card count): the banks card's
//      flips equal its stock page's Flips chip, the Live market has no Flip for it, and the drawer, the
//      opportunities and Shopping all agree it has no imported price.
//  (v) Heavy browsing (A's window imports + B's DM-3/CQ-1 thinning, DM-5 listed span and DM-7 coverage):
//      300 window reads of hats over 16 h, plus a busy session three days ago, on top of 60 daily saves.
//      Item history, "listed since" and "Listed > 24 h" survive, the kept saves stay bounded, and the
//      coverage strip and the banks card still date a bank saved before more than 500 newer batches.
// Offline (R1, R10): the pages are local fixture files the "user" saved or read in the window; only the
// schema host answers at start, and nothing at all is requested after it. No scrap.tf address is fetched.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { BANK_STOCK_KEEP_ALL_MS, BANK_STOCK_RECENT_TIER_MS } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type {
  BankStockResult,
  ImportBatch,
  ImportResult,
  ItemDetail,
  Listing,
  MarketListResult,
  OppListResult,
  ScraptfBanksResult,
  ScraptfItemHistory,
  ShoppingListResult,
} from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const HATS = readFileSync(path.join(FIX, 'import/buy_hats.html'), 'utf8');
const WEAPONS = readFileSync(path.join(FIX, 'import/buy_weapons.html'), 'utf8');
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
const DAY = 24 * HOUR;
const HATS_URL = 'https://scrap.tf/buy/hats';
const BASE_JUMPER = '1101;6;uncraftable';
const CAPTAIN = '378;6';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

let seq = 0;
/** Three fresh buyers of one SKU at about `scrap` each (eligible orders, so no suspect margin). */
function buyers(sku: string, scrap: number): Listing[] {
  return Array.from({ length: 3 }, (_, i) => {
    seq++;
    return makeListing({ id: `integ${seq}`, sku, baseSku: sku, steamid: `7656119800077${String(seq).padStart(4, '0')}`, metalScrap: scrap - i, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

/** The page without one card, from its `<!-- Cnn` comment up to the next card's (the removal is checked). */
function without(html: string, id: string): string {
  const start = html.indexOf(`<!-- ${id}`);
  const next = html.slice(start + 4).search(/<!-- [CU]\d/);
  if (start < 0 || next < 0) throw new Error(`no card ${id} in the fixture`);
  return html.slice(0, start) + html.slice(start + 4 + next);
}

async function setup(seed: Listing[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-integ071-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const seedRepo = openRepo(path.join(dataDir, DB_FILE_NAME));
  seedRepo.upsertListings(seed);
  seedRepo.close();
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    import: { enabled: true, acknowledgedAt: NOW - HOUR },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - HOUR },
    notifications: { minConfidence: 0 },
  });
  const core = createServiceCore({ dataDir, version: '0.7.1', settings, secrets: {}, log: createLogger({ dataDir }), fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const file = (html: string, mtimeMs: number, fileName = 'Hat Trading - TF2 - Scrap.TF.html') => call<ImportResult>('import.html', { html, fileName, mtimeMs });
  // As main sends a window read: the page's address and origin 'window' (only main may set them).
  const window = (html: string, address: string, mtimeMs: number) =>
    call<ImportResult>('import.html', { html, fileName: `scrap.tf window ${new URL(address).pathname}`, mtimeMs, address, origin: 'window' });
  await waitFor('the Live market build', async () => (await call<MarketListResult>('market.list', {})).rows.some((r) => r.buyerCount === 3));
  return { call, file, window };
}

type H = Awaited<ReturnType<typeof setup>>;
const hatsCard = async (h: H) => (await h.call<ScraptfBanksResult>('scraptf.banks')).banks.find((b) => b.bank === 'hats')!;
const hatsStock = (h: H, q: Record<string, unknown> = {}) => h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', limit: 2000, ...q });

describe('(i) a card gone from a newer save of its bank, across every surface (A + B)', () => {
  it('drops its imported price, and the banks card, the stock page, the market, the drawer, opps and Shopping agree', async () => {
    const h = await setup([...buyers(BASE_JUMPER, 300), ...buyers(CAPTAIN, 300)]);
    expect((await h.file(HATS, NOW - 3 * HOUR)).stockSave).toBe('written');
    await h.call('engine.runNow');
    await waitFor('the B.A.S.E. Jumper flip', async () => (await h.call<OppListResult>('opps.list', { inputKinds: ['import'] })).rows.some((o) => o.sku === BASE_JUMPER && o.status === 'profitable'));

    // While the page lists it: the card's flips are the stock page's Flips chip, and it is one of them.
    let card = await hatsCard(h);
    let stock = await hatsStock(h, { filter: 'flips', sort: 'profit' });
    expect(card.flips).toBe(stock.counts.flips);
    expect(stock.rows.map((r) => r.sku)).toContain(BASE_JUMPER);
    const flipsBefore = card.flips;

    // The same page saved again later, the card sold (C13 gone).
    const later = await h.file(without(HATS, 'C13'), NOW - 30 * MIN);
    expect(later.stockSave).toBe('written');
    await h.call('engine.runNow');
    await waitFor('the opportunity to go', async () => !(await h.call<OppListResult>('opps.list', { inputKinds: ['import'] })).rows.some((o) => o.sku === BASE_JUMPER));

    // The banks card: one flip fewer, still exactly the stock page's Flips chip; the item is not among them.
    card = await waitFor('the card to count it out', async () => {
      const c = await hatsCard(h);
      return c.flips === flipsBefore - 1 ? c : null;
    });
    stock = await hatsStock(h, { filter: 'flips', sort: 'profit' });
    expect(card.flips).toBe(stock.counts.flips);
    expect(stock.rows.map((r) => r.sku)).not.toContain(BASE_JUMPER);
    expect(card.top.map((f) => f.sku)).not.toContain(BASE_JUMPER);
    // The stock page shows it as gone, at its last price.
    const gone = await hatsStock(h, { filter: 'gone' });
    expect(gone.rows.map((r) => [r.sku, r.change])).toEqual([[BASE_JUMPER, 'gone']]);

    // The Live market: no Flip verdict for it any more; the rest of the page still flips.
    const row = await waitFor('the Flip verdict to go', async () => {
      const r = (await h.call<MarketListResult>('market.list', { limit: 2000 })).rows.find((x) => x.sku === BASE_JUMPER);
      return r !== undefined && r.verdict !== 'flip' ? r : null;
    });
    expect(row.verdict).not.toBe('flip');
    expect((await h.call<MarketListResult>('market.list', { verdicts: ['flip'], limit: 2000 })).rows.map((r) => r.sku)).toContain(CAPTAIN);

    // The drawer: no imported price, and the bank stock line says it went.
    const detail = (await h.call<ItemDetail | null>('item.detail', { sku: BASE_JUMPER, history: false }))!;
    expect(detail.scrapPrices.filter((p) => p.source === 'import')).toEqual([]);
    expect(detail.opportunities.filter((o) => o.inputKind === 'import')).toEqual([]);
    expect(detail.bankStock).toMatchObject({ bank: 'hats', change: 'gone' });

    // Opportunities and Shopping: nothing left for it from the page.
    expect((await h.call<OppListResult>('opps.list', {})).rows.filter((o) => o.sku === BASE_JUMPER && o.inputKind === 'import')).toEqual([]);
    expect((await h.call<ShoppingListResult>('shopping.list', {})).rows.find((r) => r.sku === BASE_JUMPER)?.knownCostScrap ?? null).toBeNull();
    // ACT-9 wiring: a known imported price carries its age and the stock scrap.tf showed with it.
    const captain = (await h.call<ShoppingListResult>('shopping.list', {})).rows.find((r) => r.sku === CAPTAIN)!;
    expect(captain).toMatchObject({ knownObservedAt: NOW - 30 * MIN, knownStale: false });
    expect(captain.knownStock).toBeGreaterThan(0);
    expect(requested).toEqual([]);
  }, 60_000);
});

describe('(v) heavy browsing in the window (A + B)', () => {
  it('keeps history, "listed since", "Listed > 24 h" and the coverage of other banks through 450 window reads on top of 60 daily saves', async () => {
    const h = await setup([...buyers(CAPTAIN, 300)]);
    // Weapons, saved once, before everything else.
    const weaponsAt = NOW - 62 * DAY;
    const weapons = await h.file(WEAPONS, weaponsAt, 'Weapon Trading - TF2 - Scrap.TF.html');
    expect(weapons).toMatchObject({ bank: 'weapons', stockSave: 'written' });
    // Hats: one file save a day for 60 days, the oldest 61 days ago.
    const firstDaily = NOW - 61 * DAY;
    for (let d = 0; d < 60; d++) expect((await h.file(HATS, firstDaily + d * DAY, `hats-day-${d}.html`)).stockSave).toBe('written');
    // A busy session three days ago: 150 window reads 90 s apart.
    const busy = NOW - 3 * DAY - 4 * HOUR;
    for (let i = 0; i < 150; i++) await h.window(HATS, HATS_URL, busy + i * 90_000);
    // Today: 300 window reads over the last 16 h (192 s apart), the last one a minute ago.
    const span = 16 * HOUR;
    const step = Math.floor(span / 300);
    const lastReadAt = NOW - MIN - span + 300 * step;
    const reads: ImportResult[] = [];
    for (let i = 0; i < 300; i++) reads.push(await h.window(HATS, HATS_URL, NOW - MIN - span + (i + 1) * step));
    // Every read was a whole look: a save, never partial or unsettled.
    expect(new Set(reads.map((r) => r.stockSave))).toEqual(new Set(['written']));
    // More than COVERAGE_BATCHES (500) batches came after weapons' save, so a scan of the newest 500 misses it.
    expect(reads.at(-1)!.batchId - weapons.batchId).toBe(510);
    expect((await h.call<ImportBatch[]>('import.batches', { limit: 500 })).map((b) => b.id)).not.toContain(weapons.batchId);

    // "Listed since": unbroken since the first daily save, 61 days ago.
    const all = await hatsStock(h);
    const row = all.rows.find((r) => r.sku === CAPTAIN && !r.hasExtras)!;
    expect(row.listedSince).toBe(firstDaily);
    // "Listed > 24 h" on the stock page and in the Live market (DM-5: measured between saves).
    const long = await hatsStock(h, { filter: 'long-listed' });
    expect(long.rows.map((r) => r.sku)).toContain(CAPTAIN);
    expect(long.counts.longListed).toBeGreaterThan(20);
    const listed = await h.call<MarketListResult>('market.list', { listedOnScraptf: true, limit: 2000 });
    const market = listed.rows.find((r) => r.sku === CAPTAIN)!;
    expect(market.scraptfListedSince).toBe(firstDaily);
    expect(market.scraptfLastSeenAt).toBe(lastReadAt);

    // Item history: a point for every kept save, reaching back to the first daily save.
    const history = await h.call<ScraptfItemHistory>('scraptf.itemHistory', { sku: CAPTAIN });
    expect(history.bank).toBe('hats');
    expect(history.points[0]!.at).toBe(firstDaily);
    // Thinning (DM-3, CQ-1): every daily save survives; the last 2 h keep every read, the rest of today one
    // per 10 minutes, three days ago one per hour; bounded in all.
    const ats = history.points.map((p) => p.at);
    for (let d = 0; d < 60; d++) expect(ats).toContain(firstDaily + d * DAY);
    const today = ats.filter((t) => t > NOW - DAY);
    const recent = today.filter((t) => t >= NOW - BANK_STOCK_KEEP_ALL_MS);
    expect(recent.length).toBeGreaterThanOrEqual(Math.floor((BANK_STOCK_KEEP_ALL_MS - 2 * MIN) / step));
    expect(today.length - recent.length).toBeLessThanOrEqual(Math.ceil((BANK_STOCK_RECENT_TIER_MS - BANK_STOCK_KEEP_ALL_MS) / (10 * MIN)) + 1);
    expect(today.length - recent.length).toBeGreaterThanOrEqual(80);
    const busyKept = ats.filter((t) => t >= busy && t < busy + 4 * HOUR);
    expect(busyKept.length).toBeGreaterThanOrEqual(3);
    expect(busyKept.length).toBeLessThanOrEqual(5);
    expect(history.points.length).toBeLessThan(400);

    // Coverage (DM-7, CQ-3): weapons, saved before more than 500 newer batches, is still dated.
    const strip = (await h.call<MarketListResult>('market.list', {})).scraptf.coverage;
    expect(strip.find((c) => c.category === 'weapons')!.lastSavedAt).toBe(weaponsAt);
    expect(strip.find((c) => c.category === 'hats')!.lastSavedAt).toBe(lastReadAt);
    const banks = (await h.call<ScraptfBanksResult>('scraptf.banks')).banks;
    expect(banks.find((b) => b.bank === 'weapons')!.lastSavedAt).toBe(weaponsAt);
    // What's new: nothing changed in any save, so the session baseline shows nothing new or gone.
    expect(banks.find((b) => b.bank === 'hats')!.whatsNew).toMatchObject({ new: 0, gone: 0, cheaper: 0, pricier: 0 });
    expect(requested).toEqual([]);
  }, 240_000);
});
