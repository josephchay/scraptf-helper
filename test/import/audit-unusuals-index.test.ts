// Audit window-1 / importflow-3: scrap.tf's bare /unusuals index lists the unusual pages, never item cards
// (the user's own runs read it as 0 items every time, while /unusuals/89 read 518). A read or save of it
// with no card is neither "saved without its items" nor "layout changed": it warns 'unusuals-index', fixed
// text that says to open one of its pages. Sub-pages and an address-less pid-unusuals save keep
// 'no-cards-saved' (F18 decision 6), and an index that does show cards (the synthetic fixture) imports as before.
// The real parser and service, an in-memory repo; the pages are synthetic and nothing is fetched (R1).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { parseScrapTfHtml, warningCode } from '../../src/service/import';
import { UNUSUALS_INDEX_WARNING } from '../../src/service/import/scraptfHtml';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { importBankText, importBatchItemsRemoved } from '../../src/renderer/banksModel';
import { importNoticeToastText, importSavedWithoutCards, importUnusualsIndex, importWarningsView } from '../../src/renderer/importModel';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { UNUSUALS_INDEX } from '../../src/shared/importCodes';
import type { ImportResult, KeyPriceState } from '../../src/shared/types';
import { fixture } from './mhtmlFixture';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const INDEX_URL = 'https://scrap.tf/unusuals';

/** A made-up index page: links to the unusual pages, no item card. `tiles` adds effect tiles shaped like cards. */
function indexPage(opts: { url?: string | null; tiles?: boolean } = {}): string {
  const url = opts.url === undefined ? INDEX_URL : opts.url;
  const head = url === null ? '' : `<link rel="canonical" href="${url}" /><meta property="og:url" content="${url}" />`;
  const tiles = opts.tiles
    ? '<div class="effect-tile" data-defindex="378" data-title="Burning Flames"></div><div class="effect-tile" data-defindex="89" data-title="Sunbeams"></div>'
    : '';
  return `<html><head><title>Unusuals - Scrap.TF</title>${head}</head><body id="pid-unusuals"><div class="effects"><a href="/unusuals/378">Team Captain</a><a href="/unusuals/89">Hat</a>${tiles}</div></body></html>`;
}

const codes = (r: { warnings: readonly string[] }) => r.warnings.map(warningCode);

describe('the parser on the bare /unusuals index', () => {
  it("warns 'unusuals-index' with fixed text, not 'no-cards-saved', at every spelling of the index", () => {
    const r = parseScrapTfHtml(indexPage(), createStubSchema());
    expect([r.pageKind, r.bank, r.page]).toEqual(['unusuals', 'unusuals', '/unusuals']);
    expect(r.items).toEqual([]);
    expect(codes(r)).toEqual([UNUSUALS_INDEX]);
    expect(r.warnings[0]).toBe(UNUSUALS_INDEX_WARNING);
    for (const address of ['https://scrap.tf/buy/unusuals', 'https://scrap.tf/unusual/', 'https://scrap.tf/unusuals?x=1#y', 'https://scrap.tf/Unusuals']) {
      const at = parseScrapTfHtml(indexPage({ url: null }), createStubSchema(), { address });
      expect(codes(at), address).toEqual([UNUSUALS_INDEX]);
    }
    // Fixed text only: it names no page content.
    expect(UNUSUALS_INDEX_WARNING.startsWith(`${UNUSUALS_INDEX}: `)).toBe(true);
    expect(UNUSUALS_INDEX_WARNING).not.toMatch(/Team Captain|Burning/);
  });

  it("an index whose tiles look like cards is still the index, not 'layout-changed'; the report keeps the tiles", () => {
    const r = parseScrapTfHtml(indexPage({ tiles: true }), createStubSchema(), { diagnostics: true });
    expect(codes(r)).toEqual([UNUSUALS_INDEX]);
    expect(r.diagnostics?.counts.lookalikes).toBe(2);
    expect(r.diagnostics?.items).toHaveLength(2);
  });

  it("keeps 'no-cards-saved' for an unusuals sub-page and an address-less pid-unusuals save (F18 decision 6)", () => {
    const sub = parseScrapTfHtml(indexPage({ url: null }), createStubSchema(), { address: 'https://scrap.tf/unusuals/378' });
    expect(sub.page).toBe('/unusuals/378');
    expect(codes(sub)).toEqual(['no-cards-saved']);
    const bare = parseScrapTfHtml(indexPage({ url: null }), createStubSchema());
    expect(codes(bare)).toContain('no-cards-saved');
    expect(codes(bare)).not.toContain(UNUSUALS_INDEX);
  });

  it('an index that shows cards (the synthetic fixture) imports every card, with no index warning', () => {
    const r = parseScrapTfHtml(fixture('unusuals.html'), createStubSchema());
    expect(r.page).toBe('/unusuals');
    expect(r.items.length).toBeGreaterThan(0);
    expect(codes(r)).not.toContain(UNUSUALS_INDEX);
  });
});

// ---------------------------------------------------------------------------
// The service: a window read and a file save of the index
// ---------------------------------------------------------------------------

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

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

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - HOUR },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - HOUR },
  });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const clock = { now: () => NOW };
  const e = entry();
  const stock = createBankStock({ clock, log, repo, market: { entryFor: () => e }, keyPrice: () => KEY, settings: () => settings, categoryOf: () => 'hats' });
  const history = createScraptfHistory({ clock, log, repo, market: { entryFor: () => e }, keyPrice: () => KEY });
  const pushes: { event: string; payload: unknown }[] = [];
  const ctx = {
    clock,
    log,
    repo,
    http: {},
    schema: createStubSchema(),
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: (event: string, payload: unknown) => void pushes.push({ event, payload }),
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    bankStock: stock,
    scraptfHistory: history,
    bankStockChanged: () => {
      stock.refresh();
      history.refresh();
    },
  } as unknown as HandlerContext;
  const handle = createRpcHandlers(ctx);
  const rpc = (params: Record<string, unknown>) => handle('import.html', params) as Promise<ImportResult>;
  return { repo, pushes, rpc };
}

describe('the service on the bare /unusuals index', () => {
  it('a window read records nothing and keeps the index warning beside nothing-to-import', async () => {
    const h = setup();
    const r = await h.rpc({ html: indexPage({ tiles: true }), fileName: 'scrap.tf window /unusuals', mtimeMs: NOW - MIN, address: INDEX_URL, origin: 'window' });
    expect(r).toMatchObject({ batchId: 0, bank: 'unusuals', parsed: 0, stored: 0 });
    expect(codes(r)).toEqual(['nothing-to-import', UNUSUALS_INDEX]);
    expect(h.repo.listImportBatches(5)).toEqual([]);
    expect(h.pushes).toEqual([]);
  });

  it('a file save is recorded with no items, and asks for no save again (no no-cards banner or toast)', async () => {
    const h = setup();
    const r = await h.rpc({ html: indexPage(), fileName: 'C:\\Users\\me\\Downloads\\Unusuals - Scrap.TF.html', mtimeMs: NOW - MIN });
    expect(r.batchId).toBeGreaterThan(0);
    expect(codes(r)).toEqual([UNUSUALS_INDEX]);
    expect(h.repo.listImportBatches(5)).toEqual([expect.objectContaining({ id: r.batchId, bank: 'unusuals', itemCount: 0, origin: 'file' })]);
    expect(importSavedWithoutCards(r)).toBe(false);
    expect(importNoticeToastText(r)).toBeNull();
    expect(importWarningsView(r)).toEqual({ noCards: null, rest: [UNUSUALS_INDEX_WARNING] });

    // Review rv-import-db-2: the Import page's "scrap.tf page" line names the index rather than pointing at
    // skipped items (there are none) or a save again (which can never help on the index).
    expect(importUnusualsIndex(r)).toBe(true);
    const line = importBankText(r.bank, r.stored, importSavedWithoutCards(r), r.origin === 'window', false, importUnusualsIndex(r))!;
    expect(line.text).toBe('Unusuals · scrap.tf/unusuals · not counted');
    expect(line.title).toContain('Unusuals index');
    expect(line.title).toContain('scrap.tf/unusuals/<n>');
    expect(line.title).not.toMatch(/skipped items/);
    expect(line.title).not.toMatch(/save it again/i);
    // The history row keeps no warnings, so it can only hedge: it adds the index to the alternatives.
    const b = h.repo.listImportBatches(5)[0]!;
    const row = importBankText(b.bank, b.itemCount, undefined, b.origin === 'window', importBatchItemsRemoved(b))!;
    expect(row.text).toBe('Unusuals · scrap.tf/unusuals · not counted');
    expect(row.title).toMatch(/If it was saved before its items showed, save it again as 'Webpage, Complete'\. If it was the Unusuals index itself \(scrap\.tf\/unusuals\), which lists no items, save one of its pages instead\.$/);
    // Other banks keep their wording word for word.
    expect(importBankText('hats', 0)!.title).toBe(
      "Not counted as a save of scrap.tf/buy/hats: it stored no items, so the scrap.tf banks page and the Live market strip pass over it. If it was saved before its items showed, save it again as 'Webpage, Complete'.",
    );
    expect(importBankText('hats', 0, false, false, false, true)!.title).toMatch(/The skipped items say why\.$/);
  });

  it('a sub-page saved without its cards keeps the save-again advice in the result view', async () => {
    const h = setup();
    const r = await h.rpc({ html: indexPage({ url: null }), fileName: 'C:\\Users\\me\\Downloads\\Burning Flames - Scrap.TF.html', mtimeMs: NOW - MIN, address: 'https://scrap.tf/unusuals/378' });
    expect(importUnusualsIndex(r)).toBe(false);
    expect(importSavedWithoutCards(r)).toBe(true);
    const line = importBankText(r.bank, r.stored, importSavedWithoutCards(r), r.origin === 'window', false, importUnusualsIndex(r))!;
    expect(line.title).toMatch(/Save it again as 'Webpage, Complete'\.$/);
  });
});
