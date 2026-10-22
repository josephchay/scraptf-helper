// F18 wired end to end in the real core, through its folder watch: a bank page saved as "Webpage,
// Single File" (.mhtml) into the watch folder goes folder watcher -> parseSavedPage (the MHTML
// extractor) -> the parser (bank from the page part's Content-Location) -> an import batch with its
// bank -> prices and bank_stock rows, exactly as its .html twin does in a second core. Then the same
// page saved without its cards ("HTML only" before scrap.tf added them) warns 'no-cards-saved' in
// 'import.done', records its bank and time, and moves neither the Live market's coverage strip, the
// banks card nor bank stock; the next real save is compared with the last save that had cards.
//
// Offline (R1, R10): the pages are local files the "user" saved. The MHTML names scrap.tf and Steam
// image addresses in its parts; none of them is ever requested. Only the schema host answers at start.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { Repo } from '../../src/service/contracts';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { MAX_IMPORT_BYTES, warningCode, type WatchFactory } from '../../src/service/import';
import { createLogger } from '../../src/service/logger';
import { bankStockKey, bankStockOnSale } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { BankStockResult, ImportBatch, ImportResult, MarketListResult, ScraptfBanksResult } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { mhtmlOf, withoutAddress } from '../import/mhtmlFixture';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const HATS = readFileSync(path.join(FIX, 'import/buy_hats.html'), 'utf8');
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Every request any core made, start included (never reset). */
const everRequested: string[] = [];
/** Requests after start (reset once each core has started). */
const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  everRequested.push(u.hostname + u.pathname);
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
  everRequested.length = 0;
});

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(100);
  }
}

/** buy_hats.html saved before scrap.tf added its cards: the page shell, the card grid empty. */
function emptyHats(): string {
  const open = '<div id="buy-container" class="items-container rev-items-container">';
  const at = HATS.indexOf(open);
  expect(at).toBeGreaterThan(0);
  return `${HATS.slice(0, at + open.length)}\n\t\t\t</div>\n\t\t</div>\n\t</body>\n</html>\n`;
}

/** buy_hats.html without one card (C38, the plain Wise Whiskers stack). */
function hatsWithoutC38(): string {
  const from = HATS.indexOf('<!-- C38');
  const to = HATS.indexOf('<!-- not a TF2 card');
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return HATS.slice(0, from) + HATS.slice(to);
}

/** A file as the browser leaves it in the folder, dated `mtime`. */
function save(folder: string, name: string, text: string, mtime: number): string {
  const file = path.join(folder, name);
  writeFileSync(file, text);
  utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

/** The OS folder watch, replaced so the test says when the browser wrote a file (the start-up scan is the real one). */
function manualWatch(): { factory: WatchFactory; changed(fileName: string): void } {
  let listener: ((event: string, fileName: string | null) => void) | null = null;
  return {
    factory: (_folder, fn) => {
      listener = fn;
      return { close: () => undefined, on: () => undefined };
    },
    changed: (fileName) => listener?.('rename', fileName),
  };
}

async function setup(name: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), `flipdesk-f18-${name}-`));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const folder = path.join(root, 'watch');
  mkdirSync(folder, { recursive: true });
  return { root, dataDir, folder };
}

async function start(dirs: { dataDir: string; folder: string }, watch: ReturnType<typeof manualWatch>) {
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    import: { enabled: true, acknowledgedAt: NOW - 2 * HOUR, watchFolder: dirs.folder },
  });
  const core = createServiceCore({
    dataDir: dirs.dataDir,
    version: '0.6.0',
    settings,
    secrets: {},
    log: createLogger({ dataDir: dirs.dataDir }),
    fetchImpl,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
    watchFactory: watch.factory,
  });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const imports = () => pushes.filter((p) => p.event === 'import.done').map((p) => p.payload as ImportResult);
  /** A second connection to the core's database file (WAL), to see the rows exactly as stored. */
  const disk = () => {
    const r = openRepo(path.join(dirs.dataDir, DB_FILE_NAME));
    repos.push(r);
    return r;
  };
  return { core, call, pushes, imports, disk };
}

/** What a save stored, without ids and times: its prices, then its bank stock rows. */
function storedOf(repo: Repo, batchId: number) {
  const prices = repo
    .listScrapPrices()
    .filter((p) => p.importBatch === batchId)
    .map((p) => [p.sku, p.name, p.costKeys, p.costScrap, p.stock, p.assetId, p.observedAt, JSON.stringify(p.special)])
    .sort();
  const stock = repo.bankStockRows(batchId).map((r) => ({ ...r }));
  return { prices, stock };
}

const sansIds = (r: ImportResult) => ({ ...r, batchId: 0, fileName: '' });
const codes = (r: ImportResult) => r.warnings.map(warningCode);
const hatsChip = (m: MarketListResult) => m.scraptf.coverage.find((c) => c.label === 'Hats');
const hatsCard = (b: ScraptfBanksResult) => b.banks.find((x) => x.bank === 'hats');

describe('F18 through the real core and its folder watch', () => {
  it('imports an .mhtml bank save exactly as its .html twin, and passes over a later save without cards', async () => {
    const FIRST = NOW - 90 * MIN;

    // ---- The .html twin, saved into another app's watch folder. ----
    const htmlDirs = await setup('html');
    save(htmlDirs.folder, 'Hat Trading - TF2 - Scrap.TF.html', HATS, FIRST);
    const html = await start(htmlDirs, manualWatch());
    const [fromHtml] = await waitFor('the .html import', () => (html.imports().length === 1 ? html.imports() : null));

    // ---- The .mhtml save ("Webpage, Single File"), with what the watch must skip beside it. ----
    const dirs = await setup('mhtml');
    // 0.7.4 (F82): each file's Date header is its save time, as its mtime says (else the Date would date it).
    const dated = (at: number) => ({ date: new Date(at).toUTCString() });
    const file = mhtmlOf(HATS, dated(FIRST));
    // Chromium writes no address into the page itself; the Content-Location still names the bank.
    expect(mhtmlOf(withoutAddress(HATS))).toContain('Content-Location: https://scrap.tf/buy/hats');
    save(dirs.folder, 'Hat Trading - TF2 - Scrap.TF.mhtml', file, FIRST);
    save(dirs.folder, 'Hat Trading - TF2 - Scrap.TF.mhtml.crdownload', file, FIRST);
    mkdirSync(path.join(dirs.folder, 'Hat Trading - TF2 - Scrap.TF_files'));
    save(path.join(dirs.folder, 'Hat Trading - TF2 - Scrap.TF_files'), 'frame.mhtml', file, FIRST);
    const watch = manualWatch();
    const h = await start(dirs, watch);
    const [fromMhtml] = await waitFor('the .mhtml import', () => (h.imports().length === 1 ? h.imports() : null));
    await settle(300);
    // Only the page: the temp file and the _files folder were skipped.
    expect(h.imports()).toHaveLength(1);

    // The same import result, item for item, and the same page and bank.
    expect(fromMhtml!.fileName).toBe('Hat Trading - TF2 - Scrap.TF.mhtml');
    expect(fromMhtml).toMatchObject({ pageKind: 'buy', bank: 'hats' });
    expect(fromMhtml!.stored).toBeGreaterThan(20);
    expect(sansIds(fromMhtml!)).toEqual(sansIds(fromHtml!));

    // The batch records its bank and the file's time; prices and bank stock match the twin's on disk.
    const htmlDisk = html.disk();
    const mhtmlDisk = h.disk();
    const strip = (b: ImportBatch) => ({ ...b, id: 0, fileName: '', importedAt: 0 });
    expect(mhtmlDisk.listImportBatches(5).map(strip)).toEqual(htmlDisk.listImportBatches(5).map(strip));
    expect(mhtmlDisk.listImportBatches(5)).toEqual([expect.objectContaining({ id: fromMhtml!.batchId, bank: 'hats', fileMtime: FIRST, itemCount: fromMhtml!.stored })]);
    const twin = storedOf(htmlDisk, fromHtml!.batchId);
    const mine = storedOf(mhtmlDisk, fromMhtml!.batchId);
    expect(mine.prices).toHaveLength(fromMhtml!.stored);
    expect(mine).toEqual(twin);
    expect(mine.stock.filter(bankStockOnSale)).toHaveLength(fromMhtml!.stored);
    expect(mhtmlDisk.bankStockSaves('hats').map((s) => [s.savedAt, s.page])).toEqual([[FIRST, '/buy/hats']]);

    // Every reader agrees with the twin's.
    const prices = await h.call<unknown[]>('prices.list', {});
    expect(prices).toHaveLength((await html.call<unknown[]>('prices.list', {})).length);
    expect(hatsChip(await h.call<MarketListResult>('market.list', {}))).toMatchObject({ lastSavedAt: FIRST, items: fromMhtml!.stored });
    expect(hatsCard(await h.call<ScraptfBanksResult>('scraptf.banks'))).toMatchObject({ lastSavedAt: FIRST, items: fromMhtml!.stored, whatsNew: null });
    const stockBefore = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' });
    expect(stockBefore).toMatchObject({ savedAt: FIRST, saves: 1 });
    expect(stockBefore.rows.map((r) => r.key)).toEqual((await html.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' })).rows.map((r) => r.key));

    // ---- The page saved again without its cards (an .mhtml of the empty shell). ----
    const EMPTY = NOW - 30 * MIN;
    const pricesBefore = mhtmlDisk.listScrapPrices().map((p) => ({ ...p }));
    save(dirs.folder, 'Hat Trading - TF2 - Scrap.TF (1).mhtml', mhtmlOf(withoutAddress(emptyHats()), dated(EMPTY)), EMPTY);
    watch.changed('Hat Trading - TF2 - Scrap.TF (1).mhtml');
    const empty = (await waitFor('the empty save', () => (h.imports().length === 2 ? h.imports() : null)))[1]!;
    expect(empty).toMatchObject({ fileName: 'Hat Trading - TF2 - Scrap.TF (1).mhtml', pageKind: 'buy', bank: 'hats', parsed: 0, stored: 0 });
    expect(codes(empty)).toEqual(['no-cards-saved']);
    expect(empty.warnings[0]).toContain("Save it again as 'Webpage, Complete'");

    // Its batch keeps the bank and the time, and nothing it held replaced or removed a price.
    const afterEmpty = h.disk();
    expect(afterEmpty.listImportBatches(5)[0]).toMatchObject({ id: empty.batchId, bank: 'hats', fileMtime: EMPTY, itemCount: 0 });
    expect(afterEmpty.listScrapPrices()).toEqual(pricesBefore);
    // No bank stock save: never "everything gone".
    expect(afterEmpty.bankStockSaves('hats').map((s) => s.batchId)).toEqual([fromMhtml!.batchId]);

    // The strip, the banks card and the stock page still date the save with cards, not "fresh, 0 items".
    await settle(300);
    expect(hatsChip(await h.call<MarketListResult>('market.list', {}))).toMatchObject({ lastSavedAt: FIRST, items: fromMhtml!.stored });
    expect(hatsCard(await h.call<ScraptfBanksResult>('scraptf.banks'))).toMatchObject({ lastSavedAt: FIRST, items: fromMhtml!.stored, whatsNew: null });
    expect(await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' })).toMatchObject({ savedAt: FIRST, previousSavedAt: null, saves: 1 });
    expect((await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'gone' })).rows).toEqual([]);

    // ---- The next real save (one card sold since) moves them all, compared with the last save with cards. ----
    const LATER = NOW - 5 * MIN;
    save(dirs.folder, 'Hat Trading - TF2 - Scrap.TF (2).mhtml', mhtmlOf(hatsWithoutC38(), dated(LATER)), LATER);
    watch.changed('Hat Trading - TF2 - Scrap.TF (2).mhtml');
    const later = (await waitFor('the later save', () => (h.imports().length === 3 ? h.imports() : null)))[2]!;
    expect(later).toMatchObject({ bank: 'hats', stored: fromMhtml!.stored - 1 });
    expect(codes(later)).not.toContain('no-cards-saved');
    await settle(300);
    expect(hatsChip(await h.call<MarketListResult>('market.list', {}))).toMatchObject({ lastSavedAt: LATER, items: later.stored });
    expect(hatsCard(await h.call<ScraptfBanksResult>('scraptf.banks'))).toMatchObject({
      lastSavedAt: LATER,
      items: later.stored,
      whatsNew: { new: 0, gone: 1, cheaper: 0, pricier: 0, since: FIRST },
    });
    const stockAfter = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'gone' });
    expect(stockAfter).toMatchObject({ savedAt: LATER, previousSavedAt: FIRST, saves: 2 });
    expect(stockAfter.rows.map((r) => r.key)).toEqual([bankStockKey('31031;6', '')]);

    // Nothing was fetched after start, and nothing named in the saved files ever (R1).
    expect(requested).toEqual([]);
    expect(everRequested.length).toBeGreaterThan(0);
    expect(everRequested.every((r) => r.startsWith('sku.pricedb.io/'))).toBe(true);
    expect(everRequested.some((r) => /scrap\.tf|steamstatic/i.test(r))).toBe(false);
  }, 60_000);

  it('reports a save over the 20 MB limit instead of dropping it unseen: a batch and import.done saying too-large, nothing stored', async () => {
    const dirs = await setup('big');
    const watch = manualWatch();
    const h = await start(dirs, watch);
    // A Single File save holds every image of the page, so a big one goes past the import's limit.
    const BIG = NOW - 10 * MIN;
    const name = 'Item Trading - TF2 - Scrap.TF.mhtml';
    save(dirs.folder, name, `MIME-Version: 1.0\r\n${'x'.repeat(MAX_IMPORT_BYTES)}`, BIG);
    watch.changed(name);
    const [r] = await waitFor('the too-large report', () => (h.imports().length === 1 ? h.imports() : null));
    expect(r).toMatchObject({ fileName: name, pageKind: 'unknown', bank: null, parsed: 0, stored: 0, skipped: [] });
    expect(codes(r!)).toEqual(['too-large']);
    expect(r!.warnings[0]).toBe("too-large: 21 MB is over the 20 MB import limit; save the page again as 'Webpage, Complete', which keeps its images out of the page file");
    // On the Import page's Recent batches, dated by the file; it counts for no bank and stores nothing.
    const disk = h.disk();
    expect(disk.listImportBatches(5)).toEqual([expect.objectContaining({ id: r!.batchId, fileName: name, pageKind: 'unknown', bank: null, itemCount: 0, fileMtime: BIG })]);
    expect(disk.listScrapPrices()).toEqual([]);
    expect(await h.call<ImportBatch[]>('import.batches', { limit: 5 })).toEqual([expect.objectContaining({ id: r!.batchId, fileName: name })]);
    expect((await h.call<ScraptfBanksResult>('scraptf.banks')).banks.every((b) => b.lastSavedAt === null)).toBe(true);
    // The same version again is not reported twice; nothing was requested.
    watch.changed(name);
    await settle(2_000);
    expect(h.imports()).toHaveLength(1);
    expect(requested).toEqual([]);
  }, 60_000);

  it('reports a save under 20 MB on disk whose page decodes to more (an 8-bit windows-1252 part), instead of only logging it', async () => {
    const dirs = await setup('decoded');
    const watch = manualWatch();
    const h = await start(dirs, watch);
    // 7 MB of 0xE9 bytes: each is invalid UTF-8 and reads as U+FFFD (3 bytes), so the page is 21 MB of UTF-8.
    const head = [
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; type="text/html"; boundary="----b"',
      '',
      '------b',
      'Content-Type: text/html; charset=windows-1252',
      'Content-Transfer-Encoding: 8bit',
      '',
      '<html><body>',
    ].join('\r\n');
    const bytes = Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(7 * 1024 * 1024, 0xe9), Buffer.from('</body></html>\r\n------b--\r\n', 'latin1')]);
    expect(bytes.length).toBeLessThan(MAX_IMPORT_BYTES);
    const SAVED = NOW - 10 * MIN;
    const name = 'Hat Trading - TF2 - Scrap.TF.mhtml';
    const file = path.join(dirs.folder, name);
    writeFileSync(file, bytes);
    utimesSync(file, new Date(SAVED), new Date(SAVED));
    watch.changed(name);
    const [r] = await waitFor('the decoded too-large report', () => (h.imports().length === 1 ? h.imports() : null));
    expect(r).toMatchObject({ fileName: name, pageKind: 'unknown', bank: null, parsed: 0, stored: 0, skipped: [] });
    expect(codes(r!)).toEqual(['too-large']);
    expect(r!.warnings[0]).toMatch(/^too-large: the page decodes to 2[12] MB, over the 20 MB import limit; save the page again$/);
    // Its images are not the cause, so it does not repeat the on-disk advice.
    expect(r!.warnings[0]).not.toContain('images');
    const disk = h.disk();
    expect(disk.listImportBatches(5)).toEqual([expect.objectContaining({ id: r!.batchId, fileName: name, pageKind: 'unknown', bank: null, itemCount: 0, fileMtime: SAVED })]);
    expect(disk.listScrapPrices()).toEqual([]);
    expect(requested).toEqual([]);
  }, 60_000);
});
