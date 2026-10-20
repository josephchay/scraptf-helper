// 0.7.1 step I: the scrap.tf window (F21, package D) wired to the REAL service core (packages A and B), with
// Electron fakes (scraptfWindowFakes.ts): main's real window manager and IPC router, the real core over a
// temp-folder database, the real parser, bank stock, history and market index; the toolbar's and the
// dashboard's pure models (package E) read what main pushed.
//  (ii) While the item schema loads, a read imports nothing and the toolbar says item data is loading; once
//       it has loaded, Read page now imports the same page and records its batch (A + D).
//  (iii) A first window read of buy_hats.html: the toolbar's status carries stored, pageFlips and the best
//       flip; Show flips asks main for app.showBankStock, main pushes 'ui.openBankStock', and the route it
//       lands on opens the stock page on its Flips chip, which lists exactly the page's flips (A + B + D + E).
//  (iv) A load snapshot cut short (the user moved on before the settle read) holding one card of a page the
//       user saved yesterday: flushHeld imports it unsettled, so it writes no bank stock save and no change
//       events, and the next settled read is compared with yesterday's save (A + D).
// Offline (R1): the pages are synthetic fixtures, the "browser" is a list, and the service's fake fetch
// answers only the schema host (refused while the network is paused). Nothing reaches scrap.tf.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serializeOuter } from 'parse5';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { isAllowedExternalUrl, SCRAPTF_BANKS } from '../../src/shared/links';
import { READ_MANUAL_MIN_GAP_MS, READ_WORLD_ID, SCRAPTF_READ_REASONS } from '../../src/shared/scraptfWindowPolicy';
import type {
  BankStockResult,
  DeepPartial,
  HealthReport,
  ImportBatch,
  ImportResult,
  Listing,
  MarketListResult,
  ScraptfChangeEvent,
  ScraptfReadOutcome,
  ScraptfWindowRead,
  Settings,
} from '../../src/shared/types';
import { bankStockOpenPath, bankStockRouteBank, bankStockRouteFilter } from '../../src/renderer/banksModel';
import { DEFAULT_BANK_STOCK_VIEW, bankStockQueryOf } from '../../src/renderer/bankStockModel';
import { parseHash } from '../../src/renderer/hooks/useHashRoute';
import { readStatusText, showFlipsView } from '../../src/renderer/scraptfWindowModel';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';
import { fake } from './scraptfWindowFakes';

vi.mock('electron', async () => (await import('./scraptfWindowFakes')).fakeElectron);

const { createScraptfWindowManager } = await import('../../src/main/scraptfWindow');
const { createRpcRouter } = await import('../../src/main/ipc');

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const HATS_FILE = readFileSync(path.join(FIX, 'import/buy_hats.html'), 'utf8');
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

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;
const RAFFLES = 'https://scrap.tf/raffles';
const BASE_JUMPER = '1101;6;uncraftable';
const CAPTAIN = '378;6';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const temps: string[] = [];
const cores: ServiceCore[] = [];
beforeEach(() => {
  fake.FakeWin.all = [];
  fake.FakeView.all = [];
  fake.sessions.clear();
  fake.journal.length = 0;
});
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** What READ_SCRIPT gives for a loaded page: its document element serialised. */
function outerHtmlOf(html: string): string {
  const root = parse(html).childNodes.find((n) => n.nodeName === 'html');
  return serializeOuter(root!);
}

/** One card of the fixture, from its `<!-- Cnn` comment up to the next card's. */
function card(html: string, id: string): string {
  const start = html.indexOf(`<!-- ${id}`);
  const next = html.slice(start + 4).search(/<!-- [CU]\d/);
  if (start < 0 || next < 0) throw new Error(`no card ${id} in the fixture`);
  return html.slice(start, start + 4 + next);
}
const without = (html: string, id: string) => html.replace(card(html, id), '');
/** The page's shell with only the given cards in its grid: what is on screen before the rest arrive. */
function only(html: string, ...ids: string[]): string {
  const open = /<div id="buy-container"[^>]*>/.exec(html)!;
  return `${html.slice(0, open.index + open[0].length)}\n${ids.map((id) => card(html, id)).join('\n')}\n</div></div></body></html>`;
}

let seq = 0;
function buyers(sku: string, scrap: number): Listing[] {
  return Array.from({ length: 3 }, (_, i) => {
    seq++;
    return makeListing({ id: `winteg${seq}`, sku, baseSku: sku, steamid: `7656119800066${String(seq).padStart(4, '0')}`, metalScrap: scrap - i, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

/** main.ts's wiring: the real core as the service, the window manager and the router in front of it. */
async function world(o: { seed?: Listing[]; networkPaused?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-window-integ-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const seedRepo = openRepo(path.join(dataDir, DB_FILE_NAME));
  seedRepo.upsertListings(o.seed ?? []);
  seedRepo.close();
  let settings: Settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    networkPaused: o.networkPaused ?? false,
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
  const service = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const update = (p: DeepPartial<Settings>) => {
    settings = mergeSettings(settings, p);
    core.updateSettings(settings);
  };

  // The window's clock runs a little behind the service's real one: the service caps a save's time at now.
  const clock = { t: NOW - 10 * MIN };
  /** Every 'import.html' main sent the service, as sent, and what it answered (or threw). */
  const imports: { params: Record<string, unknown>; result: ImportResult | null; error: string | null }[] = [];
  const handles: { fn: () => void; cleared: boolean; fired: boolean }[] = [];
  const m = createScraptfWindowManager({
    settings: () => settings,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    preloadPath: 'C:/app/dist/preload.cjs',
    iconPath: 'C:/app/assets/icon.png',
    devTools: false,
    // main.ts: host.call('import.html', p), straight to the service.
    importHtml: async (p) => {
      const entry = { params: structuredClone(p) as unknown as Record<string, unknown>, result: null as ImportResult | null, error: null as string | null };
      imports.push(entry);
      try {
        entry.result = await service<ImportResult>('import.html', p);
        return entry.result;
      } catch (err) {
        entry.error = (err as Error).message;
        throw err;
      }
    },
    openExternal: async () => undefined,
    isQuitting: () => false,
    now: () => clock.t,
    timers: {
      setTimeout: (fn: () => void) => {
        const h = { fn, cleared: false, fired: false };
        handles.push(h);
        return h;
      },
      clearTimeout: (h: unknown) => void ((h as { cleared: boolean }).cleared = true),
    },
  });
  /** What main sent the dashboard (main.ts showBankStock: show the dashboard, then the push). */
  const dashboard: [string, unknown][] = [];
  const route = createRpcRouter({
    settings: { get: () => settings, set: () => settings },
    secrets: { status: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }), set: () => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false }) },
    service: { callRaw: (method: string, params: unknown) => core.handle(method, params) },
    showQuickEntry: () => undefined,
    openItemInDashboard: () => undefined,
    showBankStock: (bank, filter) => {
      dashboard.push(['show', null]);
      dashboard.push(['ui.openBankStock', { bank, filter }]);
    },
    appInfo: () => ({ version: '0.7.1', appDir: 'a', dataDir: 'd', logDir: 'l', platform: 'win32', electron: '44', node: '24' }),
    serviceState: () => null,
    hotkeys: () => ({ quickEntry: { accelerator: '', registered: false, error: null }, check: { accelerator: '', registered: false, error: null } }),
    armCheck: () => ({ armedUntil: null }),
    isAllowedExternalUrl,
    openExternal: async () => undefined,
    scraptfWindow: m,
    dialogs: { openHtmlFile: async () => null, openFolder: async () => null, saveFile: async () => null },
    files: { stat: async () => ({ size: 1, mtimeMs: 1, isFile: () => true }), readBytes: async () => new Uint8Array(), writeText: async () => undefined },
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  /** A call from the toolbar page, through the preload's one channel. */
  const call = <T>(method: string, params?: unknown) => route({ window: null, hideWindow: () => undefined }, method, params) as Promise<T>;

  await call('scraptfWindow.open', { start: HATS });
  const win = fake.FakeWin.all.at(-1)!;
  win.webContents.emit('did-finish-load');
  win.emit('ready-to-show');
  const view = () => fake.FakeView.all.at(-1)!.webContents;
  /** The user's browsing put `url` on screen with `dom` loaded (a new document, committed and loaded). */
  const land = (url: string, dom: string) => {
    const c = view();
    c.runScript = (w: number, scripts: unknown[]) => {
      if (w !== READ_WORLD_ID) throw new Error('not the read world');
      const code = (scripts as { code: string }[])[0]!.code;
      return new Function('document', `return (${code});`)({ documentElement: { outerHTML: dom } }) as unknown;
    };
    c.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    c.url = url;
    c.emit('did-navigate', {}, url, 200, 'OK');
    c.emit('did-finish-load');
  };
  const fireSettle = () => {
    for (const h of handles.filter((x) => !x.cleared && !x.fired)) {
      h.fired = true;
      h.fn();
    }
  };
  /** The toolbar's 'scraptfWindow.read' pushes. */
  const reads = () => win.webContents.sent.filter(([ch, ev]) => ch === 'push' && ev === 'scraptfWindow.read').map(([, , p]) => p as ScraptfWindowRead | null);
  /** Waits until main has pushed `n` reads to the toolbar (the real import awaits a few turns). */
  const readNo = (n: number) => waitFor(`read ${n}`, () => reads().length >= n && reads()[n - 1]);
  return { service, update, clock, imports, m, call, dashboard, view, land, fireSettle, reads, readNo };
}

describe('(ii) a window read while the item schema loads (A + D)', () => {
  it('imports nothing and says item data is loading; once loaded, Read page now imports and records the batch', async () => {
    const w = await world({ networkPaused: true });
    expect((await w.service<HealthReport>('health.get')).schema.loadedAt).toBeNull();
    const dom = outerHtmlOf(HATS_FILE);
    w.land(HATS, dom);
    await sleep(0);
    w.fireSettle();
    const failed = await w.readNo(1);
    // The service refused it with the fixed schema-loading message, which main mapped to the fixed toolbar line.
    expect(w.imports).toHaveLength(1);
    expect(w.imports[0]!.error).toContain('schema-loading');
    expect(failed).toMatchObject({ path: '/buy/hats', items: 0, warning: SCRAPTF_READ_REASONS.schemaLoading });
    expect(readStatusText(failed, w.clock.t)).toBe('Could not read /buy/hats · item data is still loading; press Read page now in a moment · just now');
    expect(await w.service<ImportBatch[]>('import.batches', {})).toEqual([]);
    expect((await w.service<BankStockResult>('scraptf.bankStock', { bank: 'hats' })).saves).toBe(0);

    // The network comes back and the schema loads.
    w.update({ networkPaused: false });
    await waitFor('the schema', async () => (await w.service<HealthReport>('health.get')).schema.loadedAt !== null);

    // Read page now: the same DOM is imported (a refused read is not remembered for the dedupe).
    w.clock.t += READ_MANUAL_MIN_GAP_MS;
    const outcome = await w.call<ScraptfReadOutcome>('scraptfWindow.read');
    expect(outcome.reason).toBeNull();
    expect(outcome.read).toMatchObject({ path: '/buy/hats', bank: 'hats' });
    expect(outcome.read!.items).toBeGreaterThan(20);
    expect(outcome.read!.stored).toBeGreaterThan(20);
    const batches = await w.service<ImportBatch[]>('import.batches', {});
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ origin: 'window', bank: 'hats', fileMtime: w.clock.t });
    expect(w.imports.at(-1)!.result).toMatchObject({ stockSave: 'written', batchId: batches[0]!.id });
    // Only the schema host was asked, and only once the network came back.
    expect(new Set(requested)).toEqual(new Set(['sku.pricedb.io/api/schema', 'sku.pricedb.io/api/paint/list']));
  }, 45_000);
});

describe('(iii) the flips on the page, from the toolbar to the stock page (A + B + D + E)', () => {
  it('shows stored, pageFlips and the best flip, and Show flips lands on the Flips chip listing exactly those flips', async () => {
    const w = await world({ seed: [...buyers(CAPTAIN, 300), ...buyers(BASE_JUMPER, 250), ...buyers('126;1', 400)] });
    await waitFor('the Live market build', async () => (await w.service<MarketListResult>('market.list', {})).rows.some((r) => r.sku === CAPTAIN && r.buyerCount === 3));
    w.land(HATS, outerHtmlOf(HATS_FILE));
    await sleep(0);
    w.fireSettle();
    const read = await w.readNo(1);
    const done = w.imports[0]!.result!;
    expect(done).toMatchObject({ stockSave: 'written', newFlips: 0 });
    // The status: what the service stored, the page's flips and the best of them, as the service reported.
    expect(read).toMatchObject({ bank: 'hats', newFlips: 0, stored: done.stored, pageFlips: done.pageFlips });
    expect(read!.pageFlips).toBeGreaterThanOrEqual(3);
    expect(read!.bestFlip).toEqual({ sku: done.topFlips![0]!.sku, name: done.topFlips![0]!.name, profitScrap: done.topFlips![0]!.profitScrap });
    expect(read!.bestFlip!.sku).toBe('126;1');
    const line = readStatusText(read, w.clock.t);
    expect(line).toContain(`${read!.pageFlips} flips`);
    expect(line).toContain(read!.bestFlip!.name);

    // Show flips (a first save: nothing is new, so the Flips chip) asks main, which pushes to the dashboard.
    const show = showFlipsView(read)!;
    expect(show).toMatchObject({ bank: 'hats', filter: 'flips' });
    await w.call('app.showBankStock', { bank: show.bank, filter: show.filter });
    expect(w.dashboard).toEqual([
      ['show', null],
      ['ui.openBankStock', { bank: 'hats', filter: 'flips' }],
    ]);
    // The dashboard routes the push, and the stock page reads the route's chip.
    const pathTo = bankStockOpenPath(w.dashboard[1]![1])!;
    const segments = parseHash(`#/${pathTo}`);
    expect(bankStockRouteBank(segments)).toBe('hats');
    expect(bankStockRouteFilter(segments)).toBe('flips');
    const page = await w.service<BankStockResult>(
      'scraptf.bankStock',
      bankStockQueryOf('hats', { ...DEFAULT_BANK_STOCK_VIEW, filter: bankStockRouteFilter(segments)!, search: '' }),
    );
    expect(page.total).toBe(read!.pageFlips);
    expect(page.counts.flips).toBe(read!.pageFlips);
    expect(page.rows[0]!.sku).toBe(read!.bestFlip!.sku);
    // Nothing but the user's open loaded the view.
    expect(fake.journal.filter((j) => j.startsWith('load view') || j.startsWith('reload') || j.startsWith('back') || j.startsWith('forward'))).toEqual([`load view ${HATS}`]);
    expect(requested).toEqual([]);
  }, 45_000);
});

describe('(iv) a load snapshot cut short (A + D)', () => {
  it('writes no bank stock save and no events, and the next settled read is compared with yesterday', async () => {
    const w = await world({ seed: [...buyers(BASE_JUMPER, 300), ...buyers(CAPTAIN, 300)] });
    await waitFor('the Live market build', async () => (await w.service<MarketListResult>('market.list', {})).rows.some((r) => r.sku === BASE_JUMPER && r.buyerCount === 3));
    // Yesterday's save of the page, without the B.A.S.E. Jumper (C13).
    const yesterday = NOW - DAY;
    const file = await w.service<ImportResult>('import.html', { html: without(HATS_FILE, 'C13'), fileName: 'Hat Trading - TF2 - Scrap.TF.html', mtimeMs: yesterday });
    expect(file.stockSave).toBe('written');

    // Today the window shows the page while only its first card has arrived; the load read holds that
    // snapshot, and the user follows a link before the settle read.
    const cutAt = w.clock.t;
    w.land(HATS, outerHtmlOf(only(HATS_FILE, 'C01')));
    await sleep(0);
    w.land(RAFFLES, '<html><head></head><body>raffles</body></html>');
    const flushed = await w.readNo(1);
    expect(w.imports).toHaveLength(1);
    expect(w.imports[0]!.params).toMatchObject({ address: HATS, origin: 'window', settled: false, mtimeMs: cutAt });
    expect(w.imports[0]!.result).toMatchObject({ stockSave: 'unsettled', stored: 1 });
    expect(flushed).toMatchObject({ path: '/buy/hats', items: 1, newFlips: 0 });
    // Its card's price is stored, but the bank keeps yesterday's save alone and no change was recorded.
    let stock = await w.service<BankStockResult>('scraptf.bankStock', { bank: 'hats', limit: 200 });
    expect(stock.saves).toBe(1);
    expect(stock.savedAt).toBe(yesterday);
    expect(await w.service<ScraptfChangeEvent[]>('scraptf.changes', {})).toEqual([]);

    // A minute later the user is back on the page, every card showing: a settled read.
    w.clock.t += MIN;
    w.land(HATS, outerHtmlOf(HATS_FILE));
    await sleep(0);
    w.fireSettle();
    const full = await w.readNo(2);
    const done = w.imports.at(-1)!;
    expect(done.params.settled).toBeUndefined();
    expect(done.result).toMatchObject({ stockSave: 'written', newFlips: 1 });
    expect(full).toMatchObject({ path: '/buy/hats', newFlips: 1 });
    // Compared with yesterday's save: the B.A.S.E. Jumper is new, nothing is gone or restocked.
    stock = await w.service<BankStockResult>('scraptf.bankStock', { bank: 'hats', limit: 200 });
    expect(stock.saves).toBe(2);
    expect(stock.previousSavedAt).toBe(yesterday);
    expect(stock.counts).toMatchObject({ new: 1, gone: 0 });
    const events = await w.service<ScraptfChangeEvent[]>('scraptf.changes', {});
    expect(events.map((e) => [e.kind, e.sku])).toEqual([['new', BASE_JUMPER]]);
    // The raffles page was never read, and nothing but the user's open loaded the view.
    expect(w.imports.map((i) => i.params.address)).toEqual([HATS, HATS]);
    expect(fake.journal.filter((j) => j.startsWith('load view'))).toEqual([`load view ${HATS}`]);
    expect(requested).toEqual([]);
  }, 45_000);
});
