// F21 in the service: a read of the opt-in scrap.tf window reaches 'import.html' as the page's DOM
// (documentElement.outerHTML: no doctype, no "saved from" mark) with `address`, the page it was read at,
// and `origin: 'window'`. It imports exactly what a file save of the same page does: the address is only a
// page-address hint (like an .mhtml part's Content-Location), and the batch records its origin. A real
// in-memory repo, the real parser, bank stock cache and scrap.tf history. The fixtures are synthetic saved
// pages; nothing here is fetched (R1), and the addresses are only text.

import { parse, serializeOuter } from 'parse5';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { parseSavedPage, warningCode } from '../../src/service/import';
import { createRpcHandlers, importSavedPage, recordSkippedImport, WINDOW_NOTHING_TO_IMPORT, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANKS, SCRAPTF_HOME_URL } from '../../src/shared/links';
import { IMPORT_SCHEMA_LOADING_CODE, IMPORT_SCHEMA_LOADING_MESSAGE } from '../../src/shared/importCodes';
import { SCRAPTF_WINDOW_OFF } from '../../src/shared/scraptfWindowPolicy';
import type { ImportBatch, ImportOrigin, ImportResult, KeyPriceState, ScraptfBank } from '../../src/shared/types';
import { fixture, mhtmlOf, withoutAddress } from './mhtmlFixture';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const HATS = fixture('buy_hats.html');
const HATS_URL = bankUrl('hats');
/** A query and hash the window's address may carry; never stored, logged or pushed. */
const SECRET = 'Zq7secret';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

function bankUrl(bank: ScraptfBank): string {
  return SCRAPTF_BANKS.find((b) => b.bank === bank)!.url;
}

/** What the window's READ_SCRIPT returns for a page: the document element serialised, without the doctype and the comments before it. */
function outerHtmlOf(html: string): string {
  const root = parse(html).childNodes.find((n) => n.nodeName === 'html');
  expect(root).toBeDefined();
  return serializeOuter(root!);
}

/** Every item has buyers far above any price on the pages, so every new item is a flip. */
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
  history: ScraptfHistory;
  ctx: HandlerContext;
  pushes: { event: string; payload: unknown }[];
  logs: string[];
  rpc(params: Record<string, unknown>): Promise<ImportResult>;
  /** A page the user saved (the file picker's 'import.html'). */
  file(html: string, at: number, fileName?: string): Promise<ImportResult>;
  /** A read of the scrap.tf window, as main sends it. */
  window(html: string, address: string, at: number): Promise<ImportResult>;
}

function setup(schema: SchemaService = createStubSchema()): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  // The window's gates as the settings setter requires them: import on and acknowledged, the window's own acknowledgement.
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - HOUR },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - HOUR },
  });
  const logs: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      void logs.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  const log: Logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  const clock = { now: () => NOW };
  const e = entry();
  const stock = createBankStock({ clock, log, repo, market: { entryFor: () => e }, keyPrice: () => KEY, settings: () => settings, categoryOf: () => 'hats' });
  const history = createScraptfHistory({ clock, log, repo, market: { entryFor: () => e }, keyPrice: () => KEY });
  const pushes: { event: string; payload: unknown }[] = [];
  const quiet = () => undefined;
  const ctx = {
    clock,
    log,
    repo,
    http: {},
    schema,
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: (event: string, payload: unknown) => void pushes.push({ event, payload }),
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    bankStock: stock,
    scraptfHistory: history,
    // Core's bankStockChanged refreshes the bank stock cache and the history's runs.
    bankStockChanged: () => {
      stock.refresh();
      history.refresh();
    },
  } as unknown as HandlerContext;
  const handle = createRpcHandlers(ctx);
  const rpc = (params: Record<string, unknown>) => handle('import.html', params) as Promise<ImportResult>;
  return {
    repo,
    stock,
    history,
    ctx,
    pushes,
    logs,
    rpc,
    file: (html, at, fileName = 'C:\\Users\\me\\Downloads\\Hat Trading - TF2 - Scrap.TF.html') => rpc({ html, fileName, mtimeMs: at }),
    window: (html, address, at) => rpc({ html, fileName: `scrap.tf window ${new URL(address).pathname}`, mtimeMs: at, address, origin: 'window' }),
  };
}

/** A result without what names or tells the save apart: its batch id, file name, origin and the window's flip counts. */
function sans(r: ImportResult) {
  const { batchId: _id, fileName: _name, origin: _origin, newFlips: _flips, pageFlips: _pageFlips, topFlips: _topFlips, ...rest } = r;
  return rest;
}

/** A batch without its id, name and origin. */
function sansBatch(b: ImportBatch) {
  const { id: _id, fileName: _name, origin: _origin, ...rest } = b;
  return rest;
}

/** What a save stored, without ids: prices, bank stock rows and the bank's saves (their page keys). */
function storedOf(h: Harness, batchId: number, bank: ScraptfBank | null) {
  const prices = h.repo
    .listScrapPrices()
    .filter((p) => p.importBatch === batchId)
    .map((p) => [p.sku, p.name, p.costKeys, p.costScrap, p.stock, p.assetId, p.observedAt, JSON.stringify(p.special)])
    .sort();
  const stock = h.repo.bankStockRows(batchId).map((r) => ({ ...r }));
  const saves = bank === null ? [] : h.repo.bankStockSaves(bank).map(({ batchId: _id, ...s }) => s);
  const list = h.repo.scraptfList().map(({ batchId: _id, ...r }) => r);
  return { prices, stock, saves, list };
}

/** buy_hats.html without one card (C38, the plain Wise Whiskers stack): the save before, so C38 is new. */
function hatsWithoutC38(): string {
  const from = HATS.indexOf('<!-- C38');
  const to = HATS.indexOf('<!-- not a TF2 card');
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return HATS.slice(0, from) + HATS.slice(to);
}

/** buy_hats.html before scrap.tf added its cards: the page shell, the card grid empty. */
function emptyHats(): string {
  const open = '<div id="buy-container" class="items-container rev-items-container">';
  const at = HATS.indexOf(open);
  expect(at).toBeGreaterThan(0);
  return `${HATS.slice(0, at + open.length)}\n\t\t\t</div>\n\t\t</div>\n\t</body>\n</html>\n`;
}

const FIXTURES: readonly (readonly [string, ScraptfBank])[] = [
  ['buy_hats.html', 'hats'],
  ['buy_weapons.html', 'weapons'],
  ['buy_stranges.html', 'stranges'],
  ['buy_killstreaks.html', 'killstreaks'],
  ['buy_skins.html', 'skins'],
  ['buy_items.html', 'items'],
  ['unusuals.html', 'unusuals'],
  ['items_list.html', 'list'],
];

// ---------------------------------------------------------------------------
// The spec's parity: a window read and a file save of the same page
// ---------------------------------------------------------------------------

describe('a read of the scrap.tf window imports exactly what a file save of the same page does', () => {
  it.each(FIXTURES)('%s: the same items, bank, page key, prices, bank stock and list rows; only the origin differs', async (name, bank) => {
    const page = fixture(name);
    const dom = outerHtmlOf(page);
    expect(dom.startsWith('<html')).toBe(true);
    expect(dom).not.toMatch(/saved from url/i);

    // The parse first: every item as read from the file, from the DOM and its address.
    const schema = createStubSchema();
    const fromFile = parseSavedPage(page, name, schema);
    const fromDom = parseSavedPage(dom, '', schema, { address: bankUrl(bank) });
    expect(fromDom).toEqual(fromFile);
    expect(fromDom.bank).toBe(bank);
    expect(fromDom.items.length).toBeGreaterThan(0);

    const f = setup();
    const w = setup();
    const a = await f.file(page, NOW - MIN);
    const b = await w.window(dom, bankUrl(bank), NOW - MIN);
    expect(a.origin).toBe('file');
    expect(b.origin).toBe('window');
    expect(b.batchId).toBeGreaterThan(0);
    expect(sans(b)).toEqual(sans(a));
    expect(b).toMatchObject({ bank, fileName: `scrap.tf window ${new URL(bankUrl(bank)).pathname}` });

    const [batchA] = f.repo.listImportBatches(5);
    const [batchB] = w.repo.listImportBatches(5);
    expect(batchA!.origin).toBe('file');
    expect(batchB!.origin).toBe('window');
    expect(sansBatch(batchB!)).toEqual(sansBatch(batchA!));
    expect(storedOf(w, b.batchId, bank)).toEqual(storedOf(f, a.batchId, bank));
  });

  it('writes the same change events and finds the same new flips against the save before', async () => {
    const f = setup();
    const w = setup();
    // The save before is a file in both: the window read is compared with it as a file save would be.
    for (const h of [f, w]) await h.file(hatsWithoutC38(), NOW - HOUR);
    const a = await f.file(HATS, NOW - MIN);
    const b = await w.window(outerHtmlOf(HATS), HATS_URL, NOW - MIN);
    expect(sans(b)).toEqual(sans(a));
    expect(sansBatch(w.repo.listImportBatches(1)[0]!)).toEqual(sansBatch(f.repo.listImportBatches(1)[0]!));
    expect(storedOf(w, b.batchId, 'hats')).toEqual(storedOf(f, a.batchId, 'hats'));

    const eventsOf = (h: Harness, batchId: number) => h.repo.scraptfEvents().filter((e) => e.batchId === batchId).map(({ id: _id, batchId: _b, ...e }) => e);
    const events = eventsOf(w, b.batchId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.bank === 'hats' && e.page === '/buy/hats' && e.at === NOW - MIN)).toBe(true);
    expect(events).toEqual(eventsOf(f, a.batchId));
    expect(w.pushes.find((p) => p.event === 'scraptf.changed')?.payload).toEqual(f.pushes.find((p) => p.event === 'scraptf.changed')?.payload);

    // The bank stock diff downstream is the same, and the window's flip count is what bank stock says.
    expect(w.stock.whatsNew('hats')).toEqual(f.stock.whatsNew('hats'));
    const flips = f.stock.newFlips('hats', a.batchId).length;
    expect(flips).toBeGreaterThan(0);
    expect(b.newFlips).toBe(flips);
    // A file's result is as before 0.7: no flip count.
    expect('newFlips' in a).toBe(false);
  });

  it("pushes 'import.done' with the result, and 'import.batches' lists the batch with its origin", async () => {
    const h = setup();
    const r = await h.window(outerHtmlOf(HATS), HATS_URL, NOW - MIN);
    const done = h.pushes.filter((p) => p.event === 'import.done');
    expect(done.map((p) => p.payload)).toEqual([r]);
    const handle = createRpcHandlers(h.ctx);
    const batches = (await handle('import.batches', { limit: 5 })) as ImportBatch[];
    expect(batches).toEqual([expect.objectContaining({ id: r.batchId, origin: 'window', bank: 'hats', fileName: 'scrap.tf window /buy/hats' })]);
  });

  it('a first window read of a page counts no new flips (nothing to compare with yet)', async () => {
    const h = setup();
    const r = await h.window(outerHtmlOf(HATS), HATS_URL, NOW - MIN);
    expect(r.stored).toBeGreaterThan(20);
    expect(r.newFlips).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The address: a page-address hint, never stored, logged or pushed
// ---------------------------------------------------------------------------

describe('the window address is a page-address hint, like an .mhtml Content-Location', () => {
  it('names the page and bank of a DOM that names no address of its own', async () => {
    const dom = outerHtmlOf(withoutAddress(HATS));
    const guessed = await setup().file(dom, NOW - MIN, 'page.html');
    expect(guessed.warnings.map(warningCode)).toContain('page-kind-guessed');
    const h = setup();
    const r = await h.window(dom, HATS_URL, NOW - MIN);
    expect(r).toMatchObject({ bank: 'hats', pageKind: 'buy' });
    expect(r.warnings.map(warningCode)).not.toContain('page-kind-guessed');
    expect(h.repo.bankStockSaves('hats').map((s) => s.page)).toEqual(['/buy/hats']);
  });

  it('comes first, as the page the user is on: /items/2 is its own page of the list', async () => {
    const h = setup();
    const page = fixture('items_list.html');
    const r = await h.window(outerHtmlOf(page), 'https://scrap.tf/items/2', NOW - MIN);
    expect(r).toMatchObject({ bank: 'list', pageKind: 'items-list', fileName: 'scrap.tf window /items/2' });
    expect(h.repo.bankStockSaves('list').map((s) => s.page)).toEqual(['/items/2']);
    // The file save of the same page names /items (its og:url): never compared with page 2.
    const f = setup();
    await f.file(page, NOW - MIN);
    expect(f.repo.bankStockSaves('list').map((s) => s.page)).toEqual(['/items']);
  });

  it('a query or hash on the address changes nothing and is never stored, logged or pushed', async () => {
    const h = setup();
    const plain = await setup().window(outerHtmlOf(HATS), HATS_URL, NOW - MIN);
    const r = await h.rpc({ html: outerHtmlOf(HATS), fileName: 'scrap.tf window /buy/hats', mtimeMs: NOW - MIN, address: `${HATS_URL}?q=${SECRET}#${SECRET}`, origin: 'window' });
    expect(sans(r)).toEqual(sans(plain));
    expect(JSON.stringify(h.repo.listImportBatches(5))).not.toContain(SECRET);
    expect(JSON.stringify(h.repo.bankStockSaves('hats'))).not.toContain(SECRET);
    expect(JSON.stringify(h.repo.scraptfEvents())).not.toContain(SECRET);
    expect(JSON.stringify(h.pushes)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(h.logs.join('\n')).not.toContain(SECRET);
    expect(h.logs.join('\n')).not.toContain('https://');
  });

  it('an .mhtml file keeps the address of its own page part', () => {
    const schema = createStubSchema();
    const file = mhtmlOf(withoutAddress(HATS), { location: 'https://scrap.tf/buy/weapons', snapshot: null });
    const r = parseSavedPage(file, 'x.mhtml', schema, { address: HATS_URL });
    expect(r).toMatchObject({ format: 'mhtml', page: '/buy/weapons' });
  });
});

describe('an address that is not a scrap.tf page', () => {
  it("is refused on 'import.html' before anything is read or recorded", async () => {
    for (const address of ['https://evil.example/buy/hats', 'https://www.scrap.tf/buy/hats', 'http://scrap.tf/buy/hats', 'https://scrap.tf.evil.example/buy/hats', 'https://scrap.tf:8443/buy/hats']) {
      const h = setup();
      const msg = await h.rpc({ html: outerHtmlOf(HATS), fileName: 'scrap.tf window /buy/hats', mtimeMs: NOW - MIN, address, origin: 'window' }).then(
        () => null,
        (e: unknown) => (e as Error).message,
      );
      expect(msg, address).toBe('Invalid parameters for import.html: address: not a scrap.tf page address');
      expect(h.repo.listImportBatches(5)).toEqual([]);
      expect(h.repo.listScrapPrices()).toEqual([]);
      expect(h.pushes).toEqual([]);
    }
  });

  it('is no hint at all when it reaches importSavedPage directly (never read as the page another site saved)', () => {
    const h = setup();
    const dom = outerHtmlOf(withoutAddress(HATS));
    const r = importSavedPage(h.ctx, { html: dom, fileName: 'scrap.tf window /buy/hats', mtimeMs: NOW - MIN, address: 'https://evil.example/buy/weapons', origin: 'window' });
    const codes = r.warnings.map(warningCode);
    expect(codes).not.toContain('not-scraptf');
    // Told from the page itself, as a file with no address is.
    expect(codes).toContain('page-kind-guessed');
    expect(r).toMatchObject({ bank: 'hats', origin: 'window' });
  });
});

// ---------------------------------------------------------------------------
// The origin
// ---------------------------------------------------------------------------

describe('the origin', () => {
  it("defaults to 'file': the file picker, the folder watch and a page the watch passed over", async () => {
    const h = setup();
    const picked = await h.file(HATS, NOW - 2 * HOUR);
    const watched = importSavedPage(h.ctx, { html: HATS, fileName: 'D:\\watch\\Hat Trading - TF2 - Scrap.TF.html', mtimeMs: NOW - HOUR });
    const passedOver = recordSkippedImport(h.ctx, { fileName: 'D:\\watch\\big.mhtml', mtimeMs: NOW - MIN, warning: 'too-large: 30 MB' });
    expect([picked.origin, watched.origin, passedOver.origin]).toEqual(['file', 'file', 'file']);
    expect(h.repo.listImportBatches(5).map((b) => b.origin)).toEqual(['file', 'file', 'file']);
    expect(picked.fileName).toBe('Hat Trading - TF2 - Scrap.TF.html');
  });

  it("anything but 'window' reaching importSavedPage directly is a file", () => {
    const h = setup();
    const r = importSavedPage(h.ctx, { html: HATS, fileName: 'a/b/hats.html', mtimeMs: NOW - MIN, origin: 'browser' as unknown as ImportOrigin });
    expect(r).toMatchObject({ origin: 'file', fileName: 'hats.html' });
    expect(h.repo.listImportBatches(1)[0]!.origin).toBe('file');
  });

  it("an explicit 'file' with an address is a file save read with that hint", async () => {
    const h = setup();
    const r = await h.rpc({ html: outerHtmlOf(withoutAddress(HATS)), fileName: 'C:\\saves\\page.html', mtimeMs: NOW - MIN, address: HATS_URL, origin: 'file' });
    expect(r).toMatchObject({ origin: 'file', fileName: 'page.html', bank: 'hats' });
    expect(r.warnings.map(warningCode)).not.toContain('page-kind-guessed');
    expect('newFlips' in r).toBe(false);
  });

  it("keeps a window read's whole name, without control characters, trimmed and at most 200 characters", async () => {
    const h = setup();
    const dom = outerHtmlOf(HATS);
    const a = await h.rpc({ html: dom, fileName: '  scrap.tf window /buy/hats\u0000\u001b[31m\n ', mtimeMs: NOW - 3 * MIN, address: HATS_URL, origin: 'window' });
    expect(a.fileName).toBe('scrap.tf window /buy/hats[31m');
    const long = await h.rpc({ html: dom, fileName: `scrap.tf window /buy/${'h'.repeat(230)}`, mtimeMs: NOW - 2 * MIN, address: HATS_URL, origin: 'window' });
    expect(long.fileName).toHaveLength(200);
    expect(long.fileName.startsWith('scrap.tf window /buy/hhh')).toBe(true);
    // A page path that ends like an .mhtml name is still the page's DOM.
    const mht = await h.rpc({ html: dom, fileName: 'scrap.tf window /buy/hats.mhtml', mtimeMs: NOW - MIN, address: HATS_URL, origin: 'window' });
    expect(mht).toMatchObject({ bank: 'hats', stored: a.stored, fileName: 'scrap.tf window /buy/hats.mhtml' });
    expect(h.repo.listImportBatches(5).map((b) => b.fileName)).toEqual([mht.fileName, long.fileName, a.fileName]);
  });

  it("cuts a window read's name at a '?' or '#', so a query or hash never reaches the batch or the log", async () => {
    const h = setup();
    const dom = outerHtmlOf(HATS);
    const a = await h.rpc({ html: dom, fileName: `scrap.tf window /buy/hats?q=${SECRET}`, mtimeMs: NOW - 2 * MIN, address: HATS_URL, origin: 'window' });
    const b = await h.rpc({ html: dom, fileName: `scrap.tf window /buy/hats#${SECRET}`, mtimeMs: NOW - MIN, address: HATS_URL, origin: 'window' });
    expect([a.fileName, b.fileName]).toEqual(['scrap.tf window /buy/hats', 'scrap.tf window /buy/hats']);
    expect(JSON.stringify(h.repo.listImportBatches(5))).not.toContain(SECRET);
    expect(JSON.stringify(h.pushes)).not.toContain(SECRET);
    expect(h.logs.join('\n')).not.toContain(SECRET);
  });

  it('refuses a window read while the window is off, recording nothing; a file import goes on as before', async () => {
    const h = setup();
    const on = h.ctx.settings();
    const off = { ...h.ctx, settings: () => ({ ...on, scraptfWindow: { ...on.scraptfWindow, enabled: false } }) } as HandlerContext;
    expect(() => importSavedPage(off, { html: outerHtmlOf(HATS), fileName: 'scrap.tf window /buy/hats', mtimeMs: NOW - MIN, address: HATS_URL, origin: 'window' })).toThrow(SCRAPTF_WINDOW_OFF);
    expect(h.repo.listImportBatches(5)).toEqual([]);
    expect(h.repo.listScrapPrices()).toEqual([]);
    expect(h.pushes).toEqual([]);
    const r = importSavedPage(off, { html: HATS, fileName: 'hats.html', mtimeMs: NOW - MIN });
    expect(r).toMatchObject({ origin: 'file', bank: 'hats' });
    expect(r.batchId).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Optional rule (contract item 6): a window read with nothing to import records nothing
// ---------------------------------------------------------------------------

describe('a window read of a page with no items to import', () => {
  it("records no batch and pushes nothing: scrap.tf's front page, a profile, a bank before its cards", async () => {
    const h = setup();
    const first = await h.file(HATS, NOW - HOUR);
    const prices = h.repo.listScrapPrices();
    h.pushes.length = 0;
    const home = '<html><head><title>Scrap.TF - TF2 Trading</title></head><body id="pid-home"><h1>Welcome</h1></body></html>';
    const reads = [
      await h.window(home, SCRAPTF_HOME_URL, NOW - 3 * MIN),
      await h.window(home, 'https://scrap.tf/profile/76561198000000001', NOW - 2 * MIN),
      await h.window(outerHtmlOf(emptyHats()), HATS_URL, NOW - MIN),
    ];
    for (const r of reads) {
      expect(r).toMatchObject({ batchId: 0, parsed: 0, stored: 0, skipped: [], warnings: [WINDOW_NOTHING_TO_IMPORT], origin: 'window' });
      expect('newFlips' in r).toBe(false);
    }
    expect(reads.map((r) => [r.pageKind, r.bank])).toEqual([
      ['unknown', null],
      ['unknown', null],
      ['buy', 'hats'],
    ]);
    expect(h.repo.listImportBatches(10).map((b) => b.id)).toEqual([first.batchId]);
    expect(h.repo.listScrapPrices()).toEqual(prices);
    expect(h.repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([first.batchId]);
    expect(h.pushes).toEqual([]);
    // No path of a page browsed is logged.
    expect(h.logs.filter((l) => l.includes('profile') || l.includes('scrap.tf window /'))).toEqual([]);
  });

  it('a file save of a bank page without its cards is still recorded, as before', async () => {
    const h = setup();
    const r = await h.file(emptyHats(), NOW - MIN);
    expect(r.batchId).toBeGreaterThan(0);
    expect(r.warnings.map(warningCode)).toEqual(['no-cards-saved']);
    expect(h.repo.listImportBatches(5)).toEqual([expect.objectContaining({ id: r.batchId, bank: 'hats', itemCount: 0, origin: 'file' })]);
  });

  it('is still refused while import is off', async () => {
    const h = setup();
    const off = { ...h.ctx, settings: () => DEFAULT_SETTINGS } as HandlerContext;
    expect(() => importSavedPage(off, { html: '<html></html>', fileName: 'scrap.tf window /', mtimeMs: NOW, address: SCRAPTF_HOME_URL, origin: 'window' })).toThrow(/turned off/);
  });
});

// ---------------------------------------------------------------------------
// 0.7.1: what a window read stores must match what scrap.tf showed
// ---------------------------------------------------------------------------

describe('0.7.1: a window read of the live DOM (P1, P3, ACT-4)', () => {
  it('reads the /items list after its tooltips ran exactly as before them: nothing new, nothing more stored (P1)', async () => {
    const h = setup();
    const first = await h.window(outerHtmlOf(fixture('items_list.html')), 'https://scrap.tf/items', NOW - 10 * MIN);
    expect(first.stockSave).toBe('written');
    // The same list a few minutes later, hovered: Bootstrap moved every bar's n/limit out of title.
    const hovered = await h.window(outerHtmlOf(fixture('items_list_bs3.html')), 'https://scrap.tf/items', NOW - 5 * MIN);
    expect(hovered).toMatchObject({ stored: first.stored, newFlips: 0, stockSave: 'written' });
    expect(hovered.warnings.map(warningCode)).not.toContain('no-stock-limit');
    expect(h.stock.whatsNew('list')).toMatchObject({ new: 0, newFlips: 0, gone: 0, cheaper: 0, pricier: 0 });
    // The sold-out rows stay sold out: no price for them, no event.
    expect(h.repo.listScrapPrices().some((p) => p.sku === '143;6')).toBe(false);
    expect(h.repo.scraptfEvents()).toEqual([]);
    const bs5 = await h.window(outerHtmlOf(fixture('items_list_bs5.html')), 'https://scrap.tf/items', NOW - MIN);
    expect(bs5).toMatchObject({ stored: first.stored, newFlips: 0 });
    expect(h.repo.scraptfEvents()).toEqual([]);
  });

  it('refuses every read while the item schema loads: the schema-loading code, no batch, no prices, no bank stock (P3)', async () => {
    const h = setup(createStubSchema({ loaded: false }));
    for (const read of [() => h.window(outerHtmlOf(HATS), HATS_URL, NOW - MIN), () => h.file(HATS, NOW - MIN)]) {
      const msg = await read().then(
        () => null,
        (e: unknown) => (e as Error).message,
      );
      expect(msg).toBe(IMPORT_SCHEMA_LOADING_MESSAGE);
      expect(msg).toContain(IMPORT_SCHEMA_LOADING_CODE);
    }
    expect(h.repo.listImportBatches(5)).toEqual([]);
    expect(h.repo.listScrapPrices()).toEqual([]);
    expect(h.repo.bankStockSaves('hats')).toEqual([]);
    expect(h.pushes).toEqual([]);
    // Nothing of the page in the log either.
    expect(h.logs.join('\n')).not.toContain('/buy/hats');
  });

  it('an unsettled snapshot stores its prices and batch but no bank stock save and no events (ACT-4)', async () => {
    const h = setup();
    const before = await h.file(hatsWithoutC38(), NOW - HOUR);
    h.pushes.length = 0;
    const r = await h.rpc({ html: outerHtmlOf(HATS), fileName: 'scrap.tf window /buy/hats', mtimeMs: NOW - MIN, address: HATS_URL, origin: 'window', settled: false });
    expect(r.stockSave).toBe('unsettled');
    expect(r.batchId).toBeGreaterThan(0);
    expect(r.stored).toBeGreaterThan(20);
    expect(h.repo.listScrapPrices().filter((p) => p.importBatch === r.batchId)).toHaveLength(r.stored);
    expect(h.repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([before.batchId]);
    expect(h.repo.scraptfEvents()).toEqual([]);
    expect(h.pushes.map((p) => p.event)).not.toContain('scraptf.changed');
    for (const k of ['newFlips', 'pageFlips', 'topFlips'] as const) expect(k in r, k).toBe(false);
    // The next settled read is compared with the file save before, as if the snapshot never was.
    const settled = await h.window(outerHtmlOf(HATS), HATS_URL, NOW);
    expect(settled.stockSave).toBe('written');
    expect(h.stock.whatsNew('hats')).toMatchObject({ new: 1 });
  });

  it("only false counts, and only on a window read: true, absent or a file's flag store the save", async () => {
    const h = setup();
    const a = await h.rpc({ html: outerHtmlOf(HATS), fileName: 'scrap.tf window /buy/hats', mtimeMs: NOW - 2 * MIN, address: HATS_URL, origin: 'window', settled: true });
    const b = await h.rpc({ html: HATS, fileName: 'hats.html', mtimeMs: NOW - MIN, settled: false });
    expect([a.stockSave, b.stockSave]).toEqual(['written', 'written']);
    const bad = await h.rpc({ html: HATS, fileName: 'hats.html', mtimeMs: NOW, settled: 'no' }).then(
      () => null,
      (e: unknown) => (e as Error).message,
    );
    expect(bad).toMatch(/^Invalid parameters for import\.html: settled/);
  });

  it('a window read that wrote a save carries the page flips and the best three, named from the item data (UX-3)', async () => {
    const h = setup();
    const r = await h.window(outerHtmlOf(HATS), HATS_URL, NOW - MIN);
    expect(r.stockSave).toBe('written');
    const flips = h.stock.pageFlips('hats', r.batchId);
    expect(flips.length).toBeGreaterThan(3);
    expect(r.pageFlips).toBe(flips.length);
    expect(r.topFlips).toHaveLength(3);
    const schema = createStubSchema();
    expect(r.topFlips).toEqual(
      flips.slice(0, 3).map((f) => ({ sku: f.sku, name: schema.nameForSku(f.sku), costScrap: f.costScrap, maxCostScrap: f.maxCostScrap, profitScrap: f.profitScrap })),
    );
    // A file's result is as before: no flips on it.
    const f = await h.file(HATS, NOW);
    expect('pageFlips' in f || 'topFlips' in f).toBe(false);
  });

  it("keeps a layout-changed warning beside nothing-to-import on a bank page whose cards are in a new shape (P7)", async () => {
    const h = setup();
    const r = await h.window(outerHtmlOf(HATS.replace(/\bapp440\b/g, 'app-440')), HATS_URL, NOW - MIN);
    expect(r.batchId).toBe(0);
    expect(r.warnings.map(warningCode)).toEqual(['nothing-to-import', 'layout-changed']);
    expect(h.repo.listImportBatches(5)).toEqual([]);
  });
});
