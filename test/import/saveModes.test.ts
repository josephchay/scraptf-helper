// F18 end to end: a page saved as "Webpage, Single File" (.mhtml) imports exactly what its .html save
// does, through 'import.html' and the folder watch alike (importSavedPage unpacks it in the service);
// and a bank page saved without its cards ("HTML only" before scrap.tf added them) warns
// 'no-cards-saved', records its bank and time, and changes neither the coverage strip, the banks
// card, nor the bank stock diff. A real in-memory repo, the real parser and bank stock cache.
// Pages the user saved only (R10); nothing is fetched (R1).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createFolderWatcher, warningCode, type WatchFactory } from '../../src/service/import';
import { createRpcHandlers, importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { bankStockKey, bankStockOnSale } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { scraptfBankSaves, scraptfCoverage } from '../../src/shared/market';
import type { ImportResult, KeyPriceState, ScraptfBank } from '../../src/shared/types';
import { buildMhtml, encodeQuotedPrintable, fixture, mhtmlOf, withoutAddress } from './mhtmlFixture';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const HATS = fixture('buy_hats.html');

const repos: Repo[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (repos.length) repos.pop()!.close();
  for (const c of cleanups.splice(0)) await c();
  vi.restoreAllMocks();
});

/** Every item has buyers far above any price on the pages. */
function entry(): MarketEval {
  const o = { listingId: 'l1', steamid: '76561198000000002', userName: 'KeyBot', keys: 0, metalScrap: 1e6, valueScrap: 1e6, isBot: true, online: true, lastEventAt: NOW - MIN, bumpedAt: null, details: '', flags: [], eligible: true };
  return {
    bestScrap: 1e6,
    consScrap: 1e6,
    instantScrap: 1e6,
    revenueScrap: 1e6,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 3,
    eligibleCount: 3,
    maxCostScrap: 1e6 - 100,
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
  ctx: HandlerContext;
  run(html: string, at: number, fileName?: string): ImportResult;
}

function setup(): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 3_600_000 } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const clock = { now: () => NOW };
  const e = entry();
  const stock = createBankStock({ clock, log, repo, market: { entryFor: () => e }, keyPrice: () => KEY, settings: () => settings, categoryOf: () => 'hats' });
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
    // F20: the change feed's import hook (writes no event in these tests).
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: () => stock.refresh(),
  } as unknown as HandlerContext;
  return { repo, stock, ctx, run: (html, at, fileName = 'Hat Trading - TF2 - Scrap.TF.html') => importSavedPage(ctx, { html, fileName, mtimeMs: at }) };
}

/** What a save stored, without ids and times: prices, then the bank stock rows. */
function storedOf(h: Harness, batchId: number) {
  const prices = h.repo
    .listScrapPrices()
    .filter((p) => p.importBatch === batchId)
    .map((p) => [p.sku, p.name, p.costKeys, p.costScrap, p.stock, p.assetId, JSON.stringify(p.special)])
    .sort();
  const stock = h.repo.bankStockRows(batchId).map((r) => ({ ...r }));
  return { prices, stock };
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

const codes = (r: ImportResult): string[] => r.warnings.map(warningCode);
const sansIds = (r: ImportResult) => ({ ...r, batchId: 0, fileName: '' });

// ---------------------------------------------------------------------------
// S2: MHTML imports exactly what HTML does
// ---------------------------------------------------------------------------

describe('a page saved as "Webpage, Single File" (.mhtml)', () => {
  it('imports exactly the items, prices, bank and bank stock of the same page saved as .html', () => {
    const fromHtml = setup();
    const a = fromHtml.run(HATS, NOW - MIN);
    // 0.7.4 (F82): saved when its file was (a Date seconds before the mtime), so both are dated alike.
    const date = new Date(NOW - MIN - 2_000).toUTCString();
    for (const file of [mhtmlOf(HATS, { date }), mhtmlOf(HATS, { encoding: 'base64', date })]) {
      const fromMhtml = setup();
      const b = fromMhtml.run(file, NOW - MIN, 'Hat Trading - TF2 - Scrap.TF.mhtml');
      expect(b.fileName).toBe('Hat Trading - TF2 - Scrap.TF.mhtml');
      expect(sansIds(b)).toEqual(sansIds(a));
      expect(b).toMatchObject({ bank: 'hats', pageKind: 'buy' });
      expect(b.stored).toBeGreaterThan(20);
      expect(storedOf(fromMhtml, b.batchId)).toEqual(storedOf(fromHtml, a.batchId));
      expect(fromMhtml.repo.bankStockSaves('hats')).toEqual(fromHtml.repo.bankStockSaves('hats'));
    }
  });

  it("reads its bank from the page part's Content-Location when the page names no address", () => {
    const h = setup();
    const r = h.run(mhtmlOf(withoutAddress(HATS), { location: 'https://scrap.tf/buy/hats', snapshot: null }), NOW - MIN, 'x.mhtml');
    expect(r).toMatchObject({ bank: 'hats', pageKind: 'buy' });
    expect(codes(r)).not.toContain('page-kind-guessed');
    expect(h.repo.bankStockSaves('hats').map((s) => s.page)).toEqual(['/buy/hats']);
  });

  it("goes through 'import.html' unchanged: the RPC carries the file's text and the service unpacks it", async () => {
    const h = setup();
    const handle = createRpcHandlers({ ...h.ctx, http: {} } as unknown as HandlerContext);
    const viaRpc = (await handle('import.html', { html: mhtmlOf(HATS), fileName: 'C:\\saves\\hats.mhtml', mtimeMs: NOW - MIN })) as ImportResult;
    expect(viaRpc).toMatchObject({ fileName: 'hats.mhtml', bank: 'hats' });
    expect(sansIds(viaRpc)).toEqual(sansIds(setup().run(HATS, NOW - MIN)));
    // The file's size bound is the RPC's, before unpacking.
    await expect(handle('import.html', { html: 'x'.repeat(20 * 1024 * 1024 + 1), fileName: 'big.mhtml', mtimeMs: 1 })).rejects.toThrow(/larger than 20 MB/);
  });

  it('records a malformed file with one warning and nothing stored', () => {
    const h = setup();
    const r = h.run('From: someone\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Type: image/png\r\n\r\nxx\r\n--b--\r\n', NOW - MIN, 'broken.mhtml');
    expect(r).toMatchObject({ pageKind: 'unknown', bank: null, parsed: 0, stored: 0 });
    expect(codes(r)).toEqual(['mhtml-no-html']);
    expect(h.repo.listImportBatches(5)).toEqual([expect.objectContaining({ id: r.batchId, fileName: 'broken.mhtml', bank: null, itemCount: 0 })]);
  });

  it('a file that ends inside its page (cut short, or read mid-write) stores no partial look: nothing gone, no newer save', () => {
    const h = setup();
    const first = h.run(HATS, NOW - 60 * MIN);
    h.stock.refresh();
    const pricesBefore = h.repo.listScrapPrices().map((p) => ({ ...p }));
    const cut = buildMhtml({
      parts: [{ type: 'text/html', encoding: 'quoted-printable', location: 'https://scrap.tf/buy/hats', body: encodeQuotedPrintable(HATS.slice(0, HATS.indexOf('<!-- C20'))) }],
      unterminated: true,
    });
    const r = h.run(cut, NOW - MIN, 'Hat Trading - TF2 - Scrap.TF.mhtml');
    h.stock.refresh();
    expect(r).toMatchObject({ pageKind: 'unknown', bank: null, parsed: 0, stored: 0 });
    expect(codes(r)).toEqual(['mhtml-truncated']);
    expect(r.warnings[0]).toMatch(/save the page again$/);
    // The cards after the cut are not read as gone, and the bank's newest save is still the whole one.
    expect(h.stock.list({ bank: 'hats', filter: 'gone' }, NOW).rows).toEqual([]);
    expect(h.stock.whatsNew('hats')).toBeNull();
    expect(h.repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([first.batchId]);
    expect(scraptfBankSaves(h.repo.listImportBatches(500), () => []).newest.get('hats')).toEqual({ at: NOW - 60 * MIN, id: first.batchId, items: first.stored });
    expect(h.repo.listScrapPrices()).toEqual(pricesBefore);
    // So the next whole save finds nothing new either.
    h.run(HATS, NOW - MIN / 2);
    h.stock.refresh();
    expect(h.stock.whatsNew('hats')).toMatchObject({ new: 0, newFlips: 0, gone: 0 });
  });

  it('is picked up by the folder watch (temp files and _files folders still skipped) and imports the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flipdesk-mhtml-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = mhtmlOf(HATS);
    await writeFile(join(dir, 'Hat Trading - TF2 - Scrap.TF.mhtml'), file);
    await writeFile(join(dir, 'Hat Trading - TF2 - Scrap.TF.mhtml.crdownload'), file);
    await mkdir(join(dir, 'page_files'));
    await writeFile(join(dir, 'page_files', 'frame.mhtml'), file);
    const delivered: { path: string; text: string }[] = [];
    const quiet = () => undefined;
    const factory: WatchFactory = () => ({ close: quiet, on: () => undefined });
    const w = createFolderWatcher({
      folder: dir,
      log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
      onFile: (path, text) => delivered.push({ path, text }),
      since: Date.now() - 60_000,
      debounceMs: 5,
      watchFactory: factory,
    });
    cleanups.push(() => w.stop());
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000, interval: 20 });
    await new Promise((r) => setTimeout(r, 100));
    expect(delivered.map((d) => d.path)).toEqual([join(dir, 'Hat Trading - TF2 - Scrap.TF.mhtml')]);
    expect(delivered[0]!.text).toBe(file);
    const h = setup();
    expect(sansIds(h.run(delivered[0]!.text, NOW - MIN, 'Hat Trading - TF2 - Scrap.TF.mhtml'))).toEqual(sansIds(setup().run(HATS, NOW - MIN)));
  });
});

// ---------------------------------------------------------------------------
// S3: a bank page saved without its cards
// ---------------------------------------------------------------------------

describe('a bank page saved without its cards (no-cards-saved)', () => {
  it('warns, records its bank and time, stores nothing and removes nothing', () => {
    const h = setup();
    const first = h.run(HATS, NOW - 60 * MIN);
    const before = h.repo.listScrapPrices().length;
    const empty = h.run(emptyHats(), NOW - MIN);
    expect(empty).toMatchObject({ bank: 'hats', pageKind: 'buy', parsed: 0, stored: 0 });
    expect(codes(empty)).toEqual(['no-cards-saved']);
    expect(empty.warnings[0]).toContain("Save it again as 'Webpage, Complete'");
    expect(h.repo.listImportBatches(5).find((b) => b.id === empty.batchId)).toMatchObject({ bank: 'hats', fileMtime: NOW - MIN, itemCount: 0 });
    // The prices of the save before are still the ones in use.
    expect(h.repo.listScrapPrices()).toHaveLength(before);
    expect(h.repo.listScrapPrices().every((p) => p.importBatch === first.batchId)).toBe(true);
  });

  it('leaves the coverage strip and the banks card on the save before (not "fresh, 0 items")', () => {
    const h = setup();
    const first = h.run(HATS, NOW - 60 * MIN);
    h.run(emptyHats(), NOW - MIN);
    const batches = h.repo.listImportBatches(500);
    expect(scraptfBankSaves(batches, () => []).newest.get('hats')).toEqual({ at: NOW - 60 * MIN, id: first.batchId, items: first.stored });
    expect(scraptfCoverage(batches, () => []).find((c) => c.label === 'Hats')).toMatchObject({ lastSavedAt: NOW - 60 * MIN, items: first.stored });
  });

  it('never reaches bank stock: no save is written, and the next real save is compared with the last one with cards', () => {
    const h = setup();
    const first = h.run(HATS, NOW - 60 * MIN);
    h.stock.refresh();
    h.run(emptyHats(), NOW - 30 * MIN);
    h.stock.refresh();
    // Still one save of the page: no "everything gone".
    expect(h.repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([first.batchId]);
    expect(h.stock.whatsNew('hats')).toBeNull();
    expect(h.stock.list({ bank: 'hats', filter: 'gone' }, NOW).rows).toEqual([]);

    const second = h.run(hatsWithoutC38(), NOW - MIN);
    h.stock.refresh();
    const onSale = (batchId: number) => new Set(h.repo.bankStockRows(batchId).filter(bankStockOnSale).map((r) => bankStockKey(r.sku, r.specialKey)));
    const lost = [...onSale(first.batchId)].filter((k) => !onSale(second.batchId).has(k));
    expect(lost).toEqual([bankStockKey('31031;6', '')]);
    const gone = h.stock.list({ bank: 'hats', filter: 'gone' }, NOW).rows;
    expect(gone.map((r) => r.key)).toEqual(lost);
    expect(h.stock.whatsNew('hats')).toMatchObject({ new: 0, gone: 1, since: NOW - 60 * MIN });
  });

  it('warns the same for an .mhtml save without cards, and an unusuals page; never for the /items list', () => {
    const h = setup();
    const mhtml = h.run(mhtmlOf(withoutAddress(emptyHats()), { location: 'https://scrap.tf/buy/hats' }), NOW - MIN, 'hats.mhtml');
    expect(mhtml).toMatchObject({ bank: 'hats' });
    expect(codes(mhtml)).toEqual(['no-cards-saved']);
    const unusuals = fixture('unusuals.html');
    const start = unusuals.indexOf('<!-- U1');
    const end = unusuals.indexOf('\t\t\t</div>\n\t\t</div>\n\t</body>');
    const emptyUnusuals = unusuals.slice(0, start) + unusuals.slice(end);
    // 0.7.3: an unusuals sub-page (one effect's page); the bare /unusuals index never shows cards, so it says so.
    const u = h.run(emptyUnusuals.replaceAll('https://scrap.tf/unusuals"', 'https://scrap.tf/unusuals/378"'), NOW - MIN, 'unusuals.html');
    expect(u).toMatchObject({ bank: 'unusuals', stored: 0 });
    expect(codes(u)).toEqual(['no-cards-saved']);
    expect(codes(h.run(emptyUnusuals, NOW - MIN, 'unusuals index.html'))).toEqual(['unusuals-index']);
    const list = fixture('items_list.html');
    const l = h.run(list.slice(0, list.indexOf('<tbody>') + 7) + list.slice(list.indexOf('</tbody>')), NOW - MIN, 'items.html');
    expect(l).toMatchObject({ bank: 'list' satisfies ScraptfBank });
    expect(codes(l)).not.toContain('no-cards-saved');
    expect(codes(l)).toContain('no-items');
  });
});
