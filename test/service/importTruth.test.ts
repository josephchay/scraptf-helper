// 0.7.1 Package A end to end in the real core, over the real saved-page fixtures: what the importer stores
// matches what scrap.tf showed.
//  (a) DM-1, UX-2(a), ACT-1: a card missing from a newer save of its bank loses its imported price, so the
//      opportunities, the Live market, Shopping and Live check stop calling it a flip; a card that only
//      moved to another page of the bank keeps its price; a typed price is never touched.
//  (b) DM-2: a look that caught far fewer cards than a recent save stores its prices but no bank stock
//      save: no gone, restocked or new on the next look, "listed since" unchanged.
//  (c) a real sell-off, older than the partial-look horizon, is a save like any other.
//  (d) P5: a skipped card's reason is why it was refused, refusals first, and every skip is counted.
//  (e) UX-3: a window read that wrote a save carries the flips on its page.
//  (f) DC-1: a card only a partial or unsettled look caught, sold before the next whole look of a one-page
//      bank, loses its price too; /unusuals is left alone.
//  (g) DC-2: the banks card and the coverage strip date and count a bank by its whole save, as its stock
//      page does, never by a partial or unsettled look.
// Offline (R1, R10): the pages are local files the "user" saved or read in the window; only the schema host
// answers at start, and nothing at all is requested after it. No scrap.tf address is ever fetched.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bankCards, bankLookForTitle } from '../../src/renderer/banksModel';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { BENIGN_SKIP_REASONS, IMPORT_REFUSAL_CODES, importWarningCode } from '../../src/shared/importCodes';
import type {
  BankStockResult,
  CheckResult,
  ImportResult,
  Listing,
  MarketListResult,
  OppListResult,
  ScrapPrice,
  ScraptfBanksResult,
  ScraptfChangeEvent,
  ShoppingListResult,
} from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const HATS = readFileSync(path.join(FIX, 'import/buy_hats.html'), 'utf8');
const UNUSUALS = readFileSync(path.join(FIX, 'import/unusuals.html'), 'utf8');
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
const HATS_URL = 'https://scrap.tf/buy/hats';
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
/** Three fresh buyers of one SKU at about `scrap` each (eligible orders, so no suspect margin). */
function buyers(sku: string, scrap: number): Listing[] {
  return Array.from({ length: 3 }, (_, i) => {
    seq++;
    return makeListing({ id: `truth${seq}`, sku, baseSku: sku, steamid: `7656119800088${String(seq).padStart(4, '0')}`, metalScrap: scrap - i, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

/** One card of a fixture, from its `<!-- Cnn` (or Unn) comment up to the next card's comment. */
function card(html: string, id: string): string {
  const start = html.indexOf(`<!-- ${id}`);
  const next = html.slice(start + 4).search(/<!-- [CU]\d/);
  if (start < 0 || next < 0) throw new Error(`no card ${id} in the fixture`);
  return html.slice(start, start + 4 + next);
}

/** The page without the given cards (each removal checked, so a fixture change cannot weaken a test). */
function without(html: string, ...ids: string[]): string {
  let out = html;
  for (const id of ids) {
    const c = card(html, id);
    expect(out.includes(c), id).toBe(true);
    out = out.replace(c, '');
  }
  return out;
}

/** The page's shell with only the given cards in its grid: a look that caught a few cards. */
function only(html: string, ...ids: string[]): string {
  const open = /<div id="buy-container"[^>]*>/.exec(html)!;
  const shell = html.slice(0, open.index + open[0].length);
  return `${shell}\n${ids.map((id) => card(html, id)).join('\n')}\n</div></div></body></html>`;
}

/** The hats cards C01..C38, as the fixture numbers them. */
const HAT_IDS = Array.from({ length: 38 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);

const BASE_JUMPER = '1101;6;uncraftable';
const CAPTAIN = '378;6';
const LE_SAPEUR_U380 = '31540;5;u380';

async function setup(seed: Listing[] = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-import-truth-'));
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
  // `settled: false`: a window snapshot cut before its settle read (only main sets it).
  const window = (html: string, address: string, mtimeMs: number, extra: { settled?: boolean } = {}) =>
    call<ImportResult>('import.html', { html, fileName: `scrap.tf window ${new URL(address).pathname}`, mtimeMs, address, origin: 'window', ...extra });
  const importedPrices = async (sku: string) => (await call<ScrapPrice[]>('prices.list', {})).filter((p) => p.sku === sku && p.source === 'import');
  return { core, call, file, window, importedPrices };
}

describe('a card gone from a newer save of its bank (DM-1, UX-2a, ACT-1)', () => {
  it('loses its imported price, and every view agrees it is no flip any more', async () => {
    const h = await setup([...buyers(BASE_JUMPER, 300), ...buyers(CAPTAIN, 300)]);
    await waitFor('the Live market build', async () => (await h.call<MarketListResult>('market.list', {})).rows.some((r) => r.sku === BASE_JUMPER && r.buyerCount === 3));

    const first = await h.file(HATS, NOW - 3 * HOUR);
    expect(first.stockSave).toBe('written');
    expect(await h.importedPrices(BASE_JUMPER)).toHaveLength(1);
    // A flip everywhere while the page lists it.
    await h.call('engine.runNow');
    await waitFor('the opportunity', async () => (await h.call<OppListResult>('opps.list', { inputKinds: ['import'] })).rows.some((o) => o.sku === BASE_JUMPER && o.status === 'profitable'));
    await waitFor('the Flip verdict', async () => (await h.call<MarketListResult>('market.list', { limit: 2000 })).rows.find((r) => r.sku === BASE_JUMPER)?.verdict === 'flip');
    expect((await h.call<ShoppingListResult>('shopping.list', {})).rows.find((r) => r.sku === BASE_JUMPER)?.knownCostScrap).toBe(5);
    const before = await h.call<CheckResult>('check.text', { text: 'Non-Craftable B.A.S.E. Jumper', source: 'manual' });
    expect(before).toMatchObject({ status: 'item', sku: BASE_JUMPER, price: { source: 'import', valueScrap: 5 } });

    // The same page saved again, the card sold (C13 gone).
    const later = await h.file(without(HATS, 'C13'), NOW - MIN);
    expect(later.stockSave).toBe('written');
    expect(await h.importedPrices(BASE_JUMPER)).toEqual([]);
    // The rest of the page keeps its prices.
    expect(await h.importedPrices(CAPTAIN)).not.toEqual([]);
    const gone = await h.call<ScraptfChangeEvent[]>('scraptf.changes', { kinds: ['gone'] });
    expect(gone.map((e) => e.sku)).toEqual([BASE_JUMPER]);

    await h.call('engine.runNow');
    await waitFor('the opportunity to go', async () => !(await h.call<OppListResult>('opps.list', { inputKinds: ['import'] })).rows.some((o) => o.sku === BASE_JUMPER));
    await waitFor('the Flip verdict to go', async () => {
      const row = (await h.call<MarketListResult>('market.list', { limit: 2000 })).rows.find((r) => r.sku === BASE_JUMPER);
      return row !== undefined && row.verdict !== 'flip';
    });
    const flips = await h.call<MarketListResult>('market.list', { verdicts: ['flip'], limit: 2000 });
    expect(flips.rows.map((r) => r.sku)).not.toContain(BASE_JUMPER);
    expect(flips.rows.map((r) => r.sku)).toContain(CAPTAIN);
    expect((await h.call<ShoppingListResult>('shopping.list', {})).rows.find((r) => r.sku === BASE_JUMPER)?.knownCostScrap ?? null).toBeNull();
    const after = await h.call<CheckResult>('check.text', { text: 'Non-Craftable B.A.S.E. Jumper', source: 'manual' });
    expect(after.price?.source ?? null).not.toBe('import');
    expect(requested).toEqual([]);
  }, 45_000);

  it('keeps the price of a card that moved to another page of the bank, and never touches a typed price', async () => {
    const h = await setup();
    // /unusuals lists Le Sapeur (U1); then the user opens its effect's own page, which lists it too.
    await h.file(UNUSUALS, NOW - 3 * HOUR, 'Unusual Hat Trading - TF2 - Scrap.TF.html');
    const effectPage = await h.window(only(UNUSUALS, 'U1'), 'https://scrap.tf/unusuals/380', NOW - 2 * HOUR);
    expect(effectPage).toMatchObject({ bank: 'unusuals', stockSave: 'written' });
    // A typed price for another card that will be gone.
    await h.call('prices.upsert', { sku: '378;5;u365', costScrap: 900, source: 'user' });
    // /unusuals again, without U1 (it moved: /unusuals/380's newest save still lists it) and without U2.
    const again = await h.file(without(UNUSUALS, 'U1', 'U2'), NOW - HOUR, 'Unusual Hat Trading - TF2 - Scrap.TF.html');
    expect(again.stockSave).toBe('written');
    expect(await h.importedPrices(LE_SAPEUR_U380)).toHaveLength(1);
    // U2 really went: its imported price goes, the typed one stays.
    expect(await h.importedPrices('378;5;u365')).toEqual([]);
    const typed = (await h.call<ScrapPrice[]>('prices.list', {})).filter((p) => p.sku === '378;5;u365');
    expect(typed.map((p) => [p.source, p.costScrap])).toEqual([['user', 900]]);
    expect((await h.call<ScraptfChangeEvent[]>('scraptf.changes', { kinds: ['gone'] })).map((e) => e.sku)).toEqual(['378;5;u365']);
    expect(requested).toEqual([]);
  }, 45_000);
});

describe('a card only a partial or unsettled look caught, sold before the next whole look (DC-1)', () => {
  // No stored save ever listed it, so the whole look makes no 'gone' event for it; on a bank scrap.tf shows
  // on one page, the whole look not listing it still means it sold.
  for (const kind of ['unsettled', 'partial'] as const) {
    it(`loses its imported price when the look was ${kind}`, async () => {
      const h = await setup();
      expect((await h.file(without(HATS, 'C13'), NOW - 3 * HOUR)).stockSave).toBe('written');
      expect(await h.importedPrices(BASE_JUMPER)).toEqual([]);
      const look = kind === 'unsettled' ? await h.window(HATS, HATS_URL, NOW - 2 * HOUR, { settled: false }) : await h.window(only(HATS, 'C01', 'C13'), HATS_URL, NOW - 2 * HOUR);
      expect(look.stockSave).toBe(kind);
      expect((await h.importedPrices(BASE_JUMPER)).map((p) => [p.bank, p.observedAt])).toEqual([['hats', NOW - 2 * HOUR]]);

      const whole = await h.file(without(HATS, 'C13'), NOW - HOUR);
      expect(whole.stockSave).toBe('written');
      expect(await h.call<ScraptfChangeEvent[]>('scraptf.changes', { kinds: ['gone'] })).toEqual([]);
      expect(await h.importedPrices(BASE_JUMPER)).toEqual([]);
      // The cards the whole look shows keep theirs, from it.
      expect((await h.importedPrices(CAPTAIN)).map((p) => p.observedAt)).toEqual([NOW - HOUR]);
      expect(requested).toEqual([]);
    }, 45_000);
  }

  it('keeps a price a later look set when an older file of the page arrives late', async () => {
    const h = await setup();
    await h.file(without(HATS, 'C13'), NOW - 3 * HOUR);
    await h.window(HATS, HATS_URL, NOW - HOUR, { settled: false });
    // A catch-up file saved before that look cannot say the card sold after it.
    expect((await h.file(without(HATS, 'C13'), NOW - 2 * HOUR, 'older.html')).stockSave).toBe('written');
    expect((await h.importedPrices(BASE_JUMPER)).map((p) => p.observedAt)).toEqual([NOW - HOUR]);
  }, 45_000);

  it("leaves /unusuals alone: such a look's page is not recorded, and its card may be on sale there", async () => {
    const h = await setup();
    const unusuals = (html: string, at: number) => h.file(html, at, 'Unusual Hat Trading - TF2 - Scrap.TF.html');
    expect((await unusuals(without(UNUSUALS, 'U1'), NOW - 3 * HOUR)).stockSave).toBe('written');
    expect((await h.window(only(UNUSUALS, 'U1'), 'https://scrap.tf/unusuals/380', NOW - 2 * HOUR, { settled: false })).stockSave).toBe('unsettled');
    expect(await h.importedPrices(LE_SAPEUR_U380)).toHaveLength(1);
    expect((await unusuals(without(UNUSUALS, 'U1'), NOW - HOUR)).stockSave).toBe('written');
    expect((await h.importedPrices(LE_SAPEUR_U380)).map((p) => p.observedAt)).toEqual([NOW - 2 * HOUR]);
  }, 45_000);
});

describe('a look that caught only some cards (DM-2)', () => {
  it('stores its prices but no bank stock save, so the next full look changes nothing', async () => {
    const h = await setup([...buyers(CAPTAIN, 300)]);
    for (const [i, at] of [NOW - 5 * HOUR, NOW - 4 * HOUR, NOW - 3 * HOUR].entries()) {
      expect((await h.file(HATS, at, `hats-${i}.html`)).stockSave).toBe('written');
    }
    const listed = async () => (await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', limit: 200 })).rows.find((r) => r.sku === CAPTAIN && !r.hasExtras)?.listedSince ?? null;
    expect(await listed()).toBe(NOW - 5 * HOUR);
    const savesBefore = (await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' })).saves;

    // The window read the page while only one card had arrived.
    const partial = await h.window(only(HATS, 'C01'), HATS_URL, NOW - 20 * MIN);
    expect(partial.stockSave).toBe('partial');
    expect(partial.warnings[0]).toMatch(/^partial-read: 1 of ~\d+ items on screen; read the page again once every card shows$/);
    expect(partial.stored).toBe(1);
    expect((await h.importedPrices(CAPTAIN)).some((p) => p.importBatch === partial.batchId && p.observedAt === NOW - 20 * MIN)).toBe(true);
    expect('newFlips' in partial || 'pageFlips' in partial).toBe(false);
    expect((await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' })).saves).toBe(savesBefore);

    // Then the full look.
    const full = await h.window(HATS, HATS_URL, NOW - 10 * MIN);
    expect(full).toMatchObject({ stockSave: 'written', newFlips: 0 });
    expect(full.warnings.map(importWarningCode)).not.toContain('partial-read');
    const events = await h.call<ScraptfChangeEvent[]>('scraptf.changes', {});
    expect(events.filter((e) => e.kind === 'gone' || e.kind === 'restocked' || e.kind === 'new')).toEqual([]);
    expect(await listed()).toBe(NOW - 5 * HOUR);
    expect(requested).toEqual([]);
  }, 45_000);

  it('a real sell-off, longer ago than the partial-look horizon, is a save like any other', async () => {
    const h = await setup();
    await h.file(HATS, NOW - 8 * HOUR);
    // 60% of the cards gone, seven hours later.
    const kept = HAT_IDS.filter((_, i) => i % 5 < 2);
    const r = await h.file(only(HATS, ...kept), NOW - HOUR);
    expect(r.stockSave).toBe('written');
    expect(r.warnings.map(importWarningCode)).not.toContain('partial-read');
    expect((await h.call<ScraptfChangeEvent[]>('scraptf.changes', { kinds: ['gone'], limit: 500 })).length).toBeGreaterThan(10);
    // The same drop within the horizon is a partial look.
    const h2 = await setup();
    await h2.file(HATS, NOW - 2 * HOUR);
    expect((await h2.file(only(HATS, ...kept), NOW - HOUR)).stockSave).toBe('partial');
  }, 45_000);
});

describe('the banks card and the coverage strip after a look that stored no save (DC-2)', () => {
  for (const kind of ['partial', 'unsettled'] as const) {
    it(`date and count the bank by its whole save, as its stock page does (${kind} look)`, async () => {
      const h = await setup();
      const whole = await h.file(HATS, NOW - 3 * HOUR);
      expect(whole.stockSave).toBe('written');
      const look = kind === 'partial' ? await h.window(only(HATS, 'C01', 'C02'), HATS_URL, NOW - MIN) : await h.window(HATS, HATS_URL, NOW - MIN, { settled: false });
      expect(look.stockSave).toBe(kind);

      const stock = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' });
      expect(stock.savedAt).toBe(NOW - 3 * HOUR);
      const banks = await h.call<ScraptfBanksResult>('scraptf.banks');
      expect(banks.banks.find((b) => b.bank === 'hats')).toMatchObject({ lastSavedAt: stock.savedAt, items: whole.stored });
      const strip = (await h.call<MarketListResult>('market.list', {})).scraptf.coverage.find((c) => c.label === 'Hats');
      expect(strip).toMatchObject({ lastSavedAt: stock.savedAt, items: whole.stored });
      // "Not in your save N ago" names the whole save, not the look a minute ago that caught some cards.
      const staleMs = 6 * HOUR;
      const card = bankCards(banks, null, NOW, staleMs).find((c) => c.bank === 'hats')!;
      expect(card.lookFor?.title.text).toBe(bankLookForTitle(NOW - 3 * HOUR, NOW, staleMs, card.path).text);
      expect(card.lookFor?.title.text).not.toBe(bankLookForTitle(NOW - MIN, NOW, staleMs, card.path).text);
      expect(requested).toEqual([]);
    }, 45_000);
  }
});

describe('skip reasons and totals (P5)', () => {
  it("names a refused card's refusal, not its first warning", async () => {
    const h = await setup();
    const sapeur = [
      '<!-- C99: an Unusual card whose effect is not shown -->',
      `<div data-id="9100000099" data-content="Level 1<br/>Mysterious glowing line" data-appid="440" data-item-value="900" class="item hoverable quality5 app440" data-title="Unusual Le Sapeur" data-defindex="31540">`,
      '\t<div class="item-value-indicator">5 keys</div>',
      '</div>',
      '',
    ].join('\n');
    const r = await h.file(HATS.replace('<!-- C01', `${sapeur}<!-- C01`), NOW - MIN);
    const entry = r.skipped.find((s) => s.title === 'Unusual Le Sapeur')!;
    expect(importWarningCode(entry.reason)).toBe('unusual-without-effect');
    expect(r.skippedCounts?.['unusual-without-effect']).toBeGreaterThanOrEqual(1);
    expect(r.skippedTotal).toBe(r.skipped.length);
    // Refused entries first, then the benign ones.
    const benign = r.skipped.map((s) => BENIGN_SKIP_REASONS.includes(s.reason));
    expect(benign.indexOf(true)).toBeGreaterThan(benign.lastIndexOf(false));
  }, 45_000);

  it('counts every skip of a 9,100-row list, and keeps the refusals in the 500 it lists', async () => {
    const h = await setup();
    const row = (defindex: number, title: string, price: string, limits: string) =>
      `<tr data-quality="6" data-defindex="${defindex}"><td></td><td>${title}</td><td>${price}</td><td>1 refined</td><td><div title="${limits}"></div></td></tr>`;
    const rows: string[] = [];
    // 9,000 sold-out rows (benign), then 100 rows with a price that cannot be read (refused). 0.7.4: each its
    // own item (defindex), as an identical repeat of a row is the same row shown again and read once.
    for (let i = 0; i < 9000; i++) rows.push(row(100_000 + i, 'Earbuds', '10 keys', '0/5'));
    for (let i = 0; i < 100; i++) rows.push(row(200_000 + i, "Bill's Hat", 'a lot', '1/5'));
    const html = `<!DOCTYPE html>\n<!-- saved from url=(0022)https://scrap.tf/items -->\n<html><head><title>Item Trading - TF2 - Scrap.TF</title></head><body id="pid-items"><table><thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead><tbody>${rows.join('')}</tbody></table></body></html>`;
    const r = await h.file(html, NOW - MIN, 'Item Trading - TF2 - Scrap.TF.html');
    expect(r.skippedTotal).toBe(9100);
    expect(r.skipped).toHaveLength(500);
    expect(r.skipped.slice(0, 100).every((s) => importWarningCode(s.reason) === 'unparsed-price')).toBe(true);
    expect(r.skipped.slice(100).every((s) => BENIGN_SKIP_REASONS.includes(s.reason))).toBe(true);
    expect(r.skippedCounts).toEqual({ 'unparsed-price': 100, 'out of stock on scrap.tf': 9000 });
    for (const k of Object.keys(r.skippedCounts!)) expect(IMPORT_REFUSAL_CODES.includes(k) || BENIGN_SKIP_REASONS.includes(k)).toBe(true);
  }, 60_000);
});

describe('the flips on the page a window read saved (UX-3, ACT-5, F21-2)', () => {
  it('carries pageFlips and the best three on a first save, where newFlips is 0', async () => {
    const h = await setup([...buyers(CAPTAIN, 300), ...buyers(BASE_JUMPER, 250), ...buyers('126;1', 400)]);
    await waitFor('the Live market build', async () => (await h.call<MarketListResult>('market.list', {})).rows.some((r) => r.sku === CAPTAIN && r.buyerCount === 3));
    const r = await h.window(HATS, HATS_URL, NOW - MIN);
    expect(r).toMatchObject({ stockSave: 'written', newFlips: 0 });
    const flips = (await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'flips', limit: 200 })).rows;
    expect(r.pageFlips).toBe(flips.length);
    expect(r.pageFlips).toBeGreaterThanOrEqual(3);
    expect(r.topFlips).toHaveLength(3);
    const profits = r.topFlips!.map((f) => f.profitScrap);
    expect([...profits].sort((a, b) => b - a)).toEqual(profits);
    for (const f of r.topFlips!) {
      expect(f.maxCostScrap).toBeGreaterThanOrEqual(f.costScrap);
      expect(f.name).not.toMatch(/[<>"]/);
    }
    expect(r.topFlips![0]!.sku).toBe('126;1');
    // A file save says nothing of the page's flips (as before).
    const f = await h.file(HATS, NOW);
    expect('pageFlips' in f).toBe(false);
  }, 45_000);
});
