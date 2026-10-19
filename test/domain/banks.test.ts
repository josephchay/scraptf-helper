// F15 banks summary (src/service/domain/banks.ts): one summary per SCRAPTF_BANKS entry in that order,
// built in memory from the import batches (their recorded bank, the majority rule only for a batch
// without one), the prices (price -> batch -> bank, read once), the profitable opportunities on
// imported prices, the Live market's "Not checked" rows and the saved /items list; cached per part
// and invalidated by scope; a change notification throttled to one per BANKS_PUSH_MS. A real
// in-memory repo, a fake market and list cache, fake timers; nothing here reads the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NewImportBatch, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { bankCards } from '../../src/renderer/banksModel';
import { BANKS_PUSH_MS, createBanksSummary, emptyBankSummary, opportunityBank, type BanksSummaryDeps } from '../../src/service/domain/banks';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import type { MarketIndex, UncheckedGroup } from '../../src/service/domain/market';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { BANK_LOOK_FOR } from '../../src/shared/banks';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANKS, SCRAPTF_BANK_PAGES, bankForCategory, scraptfLinkFor } from '../../src/shared/links';
import { marketComparator, scraptfCoverage } from '../../src/shared/market';
import { CATEGORIES } from '../../src/shared/types';
import type {
  Category,
  DeepPartial,
  MarketRow,
  Opportunity,
  ScrapPrice,
  ScrapPriceInput,
  ScraptfBank,
  ScraptfBankSummary,
  ScraptfListRow,
  Settings,
  UnixMs,
} from '../../src/shared/types';
import { makeOpp } from '../db/helpers';
import { FakeClock, FakeTimers, HOUR, MIN, T0, recordingLogger } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

function newRepo(): Repo {
  const r = openRepo(':memory:');
  repos.push(r);
  return r;
}

function batch(repo: Repo, over: Partial<NewImportBatch> & { fileMtime: UnixMs }): number {
  return repo.createImportBatch({ fileName: 'page.html', pageKind: 'buy', importedAt: over.fileMtime + 1_000, itemCount: 0, categories: null, ...over });
}

function imported(repo: Repo, importBatch: number, sku: string, over: Partial<ScrapPriceInput> = {}): ScrapPrice {
  return repo.upsertScrapPrice({ sku, name: `Item ${sku}`, costScrap: 20, source: 'import', observedAt: T0 - HOUR, importBatch, stock: 1, ...over });
}

function flip(p: Pick<ScrapPrice, 'id' | 'sku'>, profitScrap: number, over: Partial<Opportunity> = {}): Opportunity {
  return makeOpp({ sku: p.sku, name: `Item ${p.sku}`, inputRef: `price:${p.id}`, inputKind: 'import', status: 'profitable', profitScrap, costScrap: 20, revenueScrap: 20 + profitScrap, ...over });
}

function row(over: Partial<MarketRow> & { sku: string }): MarketRow {
  return {
    name: `Item ${over.sku}`,
    category: 'hats',
    revenueScrap: 30,
    bestScrap: 31,
    consScrap: 30,
    instantScrap: 30,
    revenueOrder: null,
    buyerCount: 3,
    maxCostScrap: 20,
    confidence: 70,
    confidenceLevel: 'high',
    flags: [],
    knownCostScrap: null,
    knownSource: 'none',
    knownObservedAt: null,
    stock: null,
    ruleCostScrap: null,
    profitScrap: null,
    verdict: 'unchecked',
    lastOrderChangeAt: T0 - MIN,
    evaluatedAt: T0,
    scraptfPaysScrap: null,
    scraptfStock: null,
    scraptfStockLimit: null,
    scraptfFull: false,
    scraptfListAt: null,
    scraptfNewAt: null,
    scraptfListedSince: null,
    scraptfLink: scraptfLinkFor(over.category ?? 'hats', null),
    ...over,
  };
}

function listRow(sku: string, stock: number | null): ScraptfListRow {
  return { sku, name: `Item ${sku}`, sellsKeys: 0, sellsScrapRaw: 30, sellsScrap: 30, paysKeys: 0, paysScrapRaw: 25, paysScrap: 25, stock, stockLimit: 10, full: false, observedAt: T0 - 5 * MIN };
}

/**
 * The market index's uncheckedBy as its contract says (one pass in marketComparator's default order,
 * per group a count and the first `top` rows with a ceiling above 0 and a revenue), over `rows`.
 */
function fakeUncheckedBy(rows: () => readonly MarketRow[]) {
  return <K>(groupOf: (c: Category) => K, top: number): Map<K, UncheckedGroup> => {
    const out = new Map<K, UncheckedGroup>();
    const sorted = rows()
      .filter((r) => r.verdict === 'unchecked')
      .sort(marketComparator('ceiling', 'desc'));
    for (const r of sorted) {
      const g = groupOf(r.category);
      let s = out.get(g);
      if (!s) out.set(g, (s = { count: 0, rows: [] }));
      s.count++;
      if (s.rows.length < top && r.maxCostScrap !== null && r.maxCostScrap > 0 && r.revenueScrap !== null) s.rows.push({ ...r });
    }
    return out;
  };
}

interface SetupOpts {
  repo?: Repo;
  patch?: DeepPartial<Settings>;
  watch?: { active: boolean; error: string | null };
  rows?: MarketRow[];
  categoryOf?: (sku: string) => Category;
}

function setup(opts: SetupOpts = {}) {
  const clock = new FakeClock(T0);
  const timers = new FakeTimers(clock);
  const log = recordingLogger();
  const repo = opts.repo ?? newRepo();
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, opts.patch ?? {}) };
  const watch = { current: opts.watch ?? { active: true, error: null as string | null } };
  const market = { rows: opts.rows ?? [] };
  const uncheckedBy = vi.fn(fakeUncheckedBy(() => market.rows));
  const list = {
    summary: { items: 0, newestAt: null as UnixMs | null, oldestAt: null as UnixMs | null, batches: 0 },
    rows: [] as ScraptfListRow[],
    version: 1,
  };
  const scraptfList = {
    summary: vi.fn(() => ({ ...list.summary })),
    all: vi.fn(() => list.rows.map((r) => ({ ...r }))),
    version: vi.fn(() => list.version),
  };
  const spies = {
    batches: vi.spyOn(repo, 'listImportBatches'),
    prices: vi.spyOn(repo, 'listScrapPrices'),
    opps: vi.spyOn(repo, 'queryOpportunities'),
    perRow: [vi.spyOn(repo, 'getScrapPrice'), vi.spyOn(repo, 'scrapPricesForSku'), vi.spyOn(repo, 'allOpportunities'), vi.spyOn(repo, 'opportunitiesForSku')],
  };
  const deps: BanksSummaryDeps = {
    clock,
    log,
    repo,
    // The mock erases the method's type parameter; it is the same function.
    market: { uncheckedBy: uncheckedBy as unknown as MarketIndex['uncheckedBy'] },
    scraptfList,
    settings: () => settings.current,
    folderWatch: () => watch.current,
    timers,
    ...(opts.categoryOf ? { categoryOf: opts.categoryOf } : {}),
  };
  const banks = createBanksSummary(deps);
  const heard: number[] = [];
  banks.onChanged(() => heard.push(clock.now()));
  const of = (bank: ScraptfBank, now: UnixMs = clock.now()): ScraptfBankSummary => banks.summary(now).banks.find((b) => b.bank === bank)!;
  return { banks, clock, timers, log, heard, repo, settings, watch, market, uncheckedBy, list, scraptfList, spies, of };
}

const saved = (b: ScraptfBankSummary) => [b.lastSavedAt, b.pages, b.items, b.inStock];

describe('summary', () => {
  it('lists every bank in SCRAPTF_BANKS order, never saved and with nothing to show, on an empty database', () => {
    const h = setup();
    const r = h.banks.summary(T0 + 5);
    expect(r.generatedAt).toBe(T0 + 5);
    expect(r.banks.map((b) => [b.bank, b.label, b.url])).toEqual(SCRAPTF_BANKS.map((b) => [b.bank, b.label, b.url]));
    for (const b of r.banks) expect(b).toEqual(emptyBankSummary(SCRAPTF_BANKS.find((x) => x.bank === b.bank)!));
  });

  it('reports import as on only when enabled and acknowledged, and the watch only then', () => {
    expect(setup().banks.summary(T0)).toMatchObject({ importEnabled: false, watchActive: false });
    expect(setup({ patch: { import: { enabled: true, acknowledgedAt: null } } }).banks.summary(T0)).toMatchObject({ importEnabled: false, watchActive: false });
    const on = { import: { enabled: true, acknowledgedAt: T0 - 1 } };
    expect(setup({ patch: on }).banks.summary(T0)).toMatchObject({ importEnabled: true, watchActive: true });
    expect(setup({ patch: on, watch: { active: false, error: 'Folder not found' } }).banks.summary(T0)).toMatchObject({ importEnabled: true, watchActive: false });
  });

  it('reads the switches live, without an invalidation', () => {
    const h = setup({ patch: { import: { enabled: true, acknowledgedAt: T0 - 1 } } });
    expect(h.banks.summary(T0)).toMatchObject({ importEnabled: true, watchActive: true });
    h.watch.current = { active: false, error: 'boom' };
    expect(h.banks.summary(T0)).toMatchObject({ importEnabled: true, watchActive: false });
    h.settings.current = mergeSettings(h.settings.current, { import: { enabled: false } });
    expect(h.banks.summary(T0)).toMatchObject({ importEnabled: false, watchActive: false });
  });
});

describe('saved pages (S3, S4)', () => {
  it('dates each bank by the page it recorded, and counts its saved pages and the items on its newest save', () => {
    const repo = newRepo();
    // Two saves of the hats bank: the newest dates and counts it; the 1001 hat left from the older
    // save (sold since: the newer page no longer lists it) is not on it.
    const hatsOld = batch(repo, { bank: 'hats', fileMtime: T0 - 60 * MIN, itemCount: 2, categories: { hats: 2 } });
    imported(repo, hatsOld, '1001;6', { stock: 3 });
    const p1002 = imported(repo, hatsOld, '1002;6');
    const hatsNew = batch(repo, { bank: 'hats', fileMtime: T0 - 10 * MIN, itemCount: 3, categories: { hats: 3 } });
    imported(repo, hatsNew, '1003;6', { stock: 2 });
    imported(repo, hatsNew, '1004;6', { stock: 0 }); // a known 0 is out of stock
    imported(repo, hatsNew, '1005;6', { stock: null }); // unknown: it was on sale when saved
    // The recorded bank wins over the majority of what the page stored.
    const stranges = batch(repo, { bank: 'stranges', fileMtime: T0 - 20 * MIN, itemCount: 1, categories: { hats: 1 } });
    imported(repo, stranges, '2001;11');
    // A 0.4 page (no bank): the majority rule on the categories it stored.
    const weapons = batch(repo, { fileMtime: T0 - 30 * MIN, itemCount: 2, categories: { weapons: 2 } });
    imported(repo, weapons, '3001;6');
    imported(repo, weapons, '3002;6');
    // A recognised bank page that stored nothing: saved without its cards (F18 S3), not a save.
    batch(repo, { bank: 'skins', fileMtime: T0 - 40 * MIN, itemCount: 0 });
    // An unrecognised page with no majority counts for no bank, nor do its rows.
    const mixed = batch(repo, { fileMtime: T0 - 2 * MIN, itemCount: 3, categories: { hats: 1, weapons: 1, stranges: 1 } });
    imported(repo, mixed, '5001;6');
    // A later /items list (0.4: no bank) re-tags a plain row the hats page shared: it is the list's now.
    const list = batch(repo, { pageKind: 'items-list', fileMtime: T0 - 5 * MIN, itemCount: 1, categories: { hats: 1 } });
    imported(repo, list, '1002;6', { id: p1002.id, observedAt: T0 - 5 * MIN });
    // Typed prices are not from any page.
    repo.upsertScrapPrice({ sku: '4001;6', name: 'Typed', costScrap: 9, source: 'user', observedAt: T0 });

    const h = setup({ repo });
    h.list.summary = { items: 4, newestAt: T0 - 5 * MIN, oldestAt: T0 - 50 * MIN, batches: 2 };
    h.list.rows = [listRow('1002;6', 3), listRow('6001;6', 0), listRow('6002;6', null), listRow('6003;6', 5)];
    const r = h.banks.summary(T0);
    expect(Object.fromEntries(r.banks.map((b) => [b.bank, saved(b)]))).toEqual({
      hats: [T0 - 10 * MIN, 2, 3, 2],
      weapons: [T0 - 30 * MIN, 1, 2, 2],
      stranges: [T0 - 20 * MIN, 1, 1, 1],
      killstreaks: [null, 0, 0, 0],
      // Saved once, without its cards: still never saved (F18 S3).
      skins: [null, 0, 0, 0],
      items: [null, 0, 0, 0],
      unusuals: [null, 0, 0, 0],
      // The /items card is F14's saved list: rows, pages behind them, rows showing stock above 0.
      list: [T0 - 5 * MIN, 2, 4, 2],
    });
    // One read each, never per row.
    expect(h.spies.batches).toHaveBeenCalledTimes(1);
    expect(h.spies.batches).toHaveBeenCalledWith(500);
    expect(h.spies.prices).toHaveBeenCalledTimes(1);
    for (const s of h.spies.perRow) expect(s).not.toHaveBeenCalled();
    // A bank page's card and its coverage chip count the same newest save.
    const strip = scraptfCoverage(repo.listImportBatches(500), () => []);
    for (const page of SCRAPTF_BANK_PAGES) {
      const card = r.banks.find((b) => b.bank === page.bank)!;
      const chip = strip.find((c) => c.label === page.label)!;
      expect([card.lastSavedAt, card.items], page.bank).toEqual([chip.lastSavedAt, chip.items]);
    }
  });

  it('counts the saved pages behind the rows held today, the newest save only for its items', () => {
    const repo = newRepo();
    const first = batch(repo, { bank: 'unusuals', fileMtime: T0 - 3 * HOUR, itemCount: 2 });
    const kept = imported(repo, first, '378;5;u13', { observedAt: T0 - 3 * HOUR });
    const left = imported(repo, first, '30001;5;u14', { observedAt: T0 - 3 * HOUR }); // not on the re-save: kept from the first
    // The re-save re-tags the copy both pages list (importSavedPage rewrites it in place).
    const second = batch(repo, { bank: 'unusuals', fileMtime: T0 - 5 * MIN, itemCount: 1 });
    imported(repo, second, '378;5;u13', { id: kept.id, observedAt: T0 - 5 * MIN });
    expect(saved(setup({ repo }).of('unusuals'))).toEqual([T0 - 5 * MIN, 2, 1, 1]);

    // Once a later save took over every row, the older saves are behind none of its data: re-saving a
    // page all day must not read "from 40 saved pages".
    const third = batch(repo, { bank: 'unusuals', fileMtime: T0 - MIN, itemCount: 2 });
    imported(repo, third, '378;5;u13', { id: kept.id, observedAt: T0 - MIN });
    imported(repo, third, '30001;5;u14', { id: left.id, observedAt: T0 - MIN });
    for (let i = 0; i < 5; i++) batch(repo, { bank: 'unusuals', fileMtime: T0 - 2 * HOUR - i * MIN, itemCount: 2 });
    expect(saved(setup({ repo }).of('unusuals'))).toEqual([T0 - MIN, 1, 2, 2]);
  });

  it('classifies a pre-0.3 page (no bank, no categories) from the rows carrying its id, like the coverage strip', () => {
    const repo = newRepo();
    const old = batch(repo, { fileMtime: T0 - 3 * HOUR, itemCount: 2 });
    imported(repo, old, '7001;6');
    imported(repo, old, '7002;6');
    const categoryOf = vi.fn((sku: string): Category => (sku.startsWith('70') ? 'unusuals' : 'hats'));
    expect(saved(setup({ repo, categoryOf }).of('unusuals'))).toEqual([T0 - 3 * HOUR, 1, 2, 2]);
    expect(categoryOf).toHaveBeenCalledTimes(2);
    // Without a category source such a page counts for no bank.
    expect(setup({ repo }).banks.summary(T0).banks.every((b) => b.lastSavedAt === null)).toBe(true);
  });

  it('keeps rows of a page older than the batches it reads on their recorded bank, dated by the rows', () => {
    const repo = newRepo();
    const ks = batch(repo, { bank: 'killstreaks', fileMtime: T0 - 9 * HOUR, itemCount: 1 });
    imported(repo, ks, '8001;6;kt-3', { observedAt: T0 - 9 * HOUR });
    const hats = batch(repo, { bank: 'hats', fileMtime: T0 - MIN, itemCount: 1 });
    imported(repo, hats, '1001;6');
    const h = setup({ repo });
    // Only the newest batch is within the read window.
    h.spies.batches.mockImplementation(() => [{ id: hats, fileName: 'p', pageKind: 'buy', fileMtime: T0 - MIN, importedAt: T0, itemCount: 1, categories: null, bank: 'hats' }]);
    expect(saved(h.of('killstreaks'))).toEqual([T0 - 9 * HOUR, 1, 1, 1]);
    expect(saved(h.of('hats'))).toEqual([T0 - MIN, 1, 1, 1]);
  });
});

describe('flips (S4)', () => {
  it('counts profitable opportunities on imported prices by the bank of their page, read through in-memory maps', () => {
    const repo = newRepo();
    const hats = batch(repo, { bank: 'hats', fileMtime: T0 - 10 * MIN });
    const weapons = batch(repo, { fileMtime: T0 - 20 * MIN, categories: { weapons: 1 } }); // 0.4: majority
    const list = batch(repo, { bank: 'list', pageKind: 'items-list', fileMtime: T0 - 5 * MIN });
    const p = [1, 2, 3, 4, 5].map((i) => imported(repo, hats, `100${i};6`));
    const w = imported(repo, weapons, '3001;6');
    const l = imported(repo, list, '9001;6');
    const typed = repo.upsertScrapPrice({ sku: '4001;6', name: 'Typed', costScrap: 9, source: 'user', observedAt: T0 });
    repo.upsertOpportunities([
      flip(p[0]!, 50),
      flip(p[1]!, 80, { name: 'B hat' }),
      flip(p[2]!, 80, { name: 'A hat' }),
      flip(p[3]!, 10),
      flip(p[4]!, 5, { status: 'below-threshold' }),
      flip(w, 30),
      flip(l, 12),
      // Typed prices, rules and prices gone since are no page's flips.
      flip(typed, 99, { inputKind: 'user' }),
      makeOpp({ sku: '1001;6', inputRef: 'rule:1', inputKind: 'rule', status: 'profitable', profitScrap: 70 }),
      makeOpp({ sku: '1999;6', inputRef: 'price:99999', inputKind: 'import', status: 'profitable', profitScrap: 70 }),
    ]);
    const h = setup({ repo });
    const hatsCard = h.of('hats');
    expect(hatsCard).toMatchObject({ flips: 4, flipProfitScrap: 220 });
    expect(hatsCard.top.map((t) => [t.name, t.profitScrap])).toEqual([
      ['A hat', 80],
      ['B hat', 80],
      [`Item ${p[0]!.sku}`, 50],
    ]);
    expect(hatsCard.top[0]).toEqual({ sku: p[2]!.sku, name: 'A hat', profitScrap: 80, costScrap: 20, revenueScrap: 100, confidenceLevel: 'medium' });
    expect(h.of('weapons')).toMatchObject({ flips: 1, flipProfitScrap: 30 });
    // The /items card counts the prices the list wrote.
    expect(h.of('list')).toMatchObject({ flips: 1, flipProfitScrap: 12 });
    for (const bank of ['stranges', 'killstreaks', 'skins', 'items', 'unusuals'] as const) expect(h.of(bank)).toMatchObject({ flips: 0, flipProfitScrap: 0, top: [] });
    // Only rows that can be flips are parsed, once; no query per opportunity or price.
    expect(h.spies.opps).toHaveBeenCalledTimes(1);
    expect(h.spies.opps).toHaveBeenCalledWith({ status: ['profitable'], inputKinds: ['import'] });
    expect(h.spies.prices).toHaveBeenCalledTimes(1);
    for (const s of h.spies.perRow) expect(s).not.toHaveBeenCalled();
  });

  it('keeps the list card saved while its prices are flips: after the 30-day list purge, and for a 0.3 /items import', () => {
    const DAY = 24 * HOUR;
    const repo = newRepo();
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
    // An /items save 31 days ago: its in-stock rows are prices (one a flip) and list rows.
    const saved31 = T0 - 31 * DAY;
    const listBatch = batch(repo, { bank: 'list', pageKind: 'items-list', fileMtime: saved31, itemCount: 2 });
    const p1 = imported(repo, listBatch, '9001;6', { observedAt: saved31, stock: 3 });
    imported(repo, listBatch, '9002;6', { observedAt: saved31, stock: null });
    const stored = (sku: string, stock: number | null) => ({ sku, name: `Item ${sku}`, sellsKeys: 0, sellsScrap: 20, paysKeys: 0, paysScrap: 15, stock, stockLimit: 5, batchId: listBatch, observedAt: saved31 });
    repo.upsertScraptfList([stored('9001;6', 3), stored('9002;6', null)]);
    repo.upsertOpportunities([flip(p1, 12)]);

    const clock = new FakeClock(T0);
    const log = recordingLogger();
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    const scraptfList = createScraptfListCache({ repo, log, keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings, clock.now()) });
    const banks = createBanksSummary({
      clock,
      log,
      repo,
      market: { uncheckedBy: (() => new Map()) as unknown as MarketIndex['uncheckedBy'] },
      scraptfList,
      settings: () => settings,
      folderWatch: () => ({ active: true, error: null }),
      timers: new FakeTimers(clock),
    });
    const listCard = () => banks.summary(T0).banks.find((b) => b.bank === 'list')!;
    // While the list holds its rows, the card is the saved list (F14).
    expect([...saved(listCard()), listCard().flips]).toEqual([saved31, 1, 2, 1, 1]);

    // Daily maintenance purges list rows older than 30 days; the prices and the batch stay, so the flip does.
    expect(repo.purgeScraptfListOlderThan(T0 - 30 * DAY)).toBe(2);
    scraptfList.refresh();
    banks.invalidate();
    const purged = listCard();
    expect(purged).toMatchObject({ lastSavedAt: saved31, flips: 1, flipProfitScrap: 12 });
    // The card's saved half comes from the same save as its flips: never "Never saved" above them.
    expect(saved(purged)).toEqual([saved31, 1, 2, 2]);
    const view = bankCards({ banks: banks.summary(T0).banks }, 568, T0).find((c) => c.bank === 'list')!;
    expect(view.freshness.label).toBe('Stale');
    expect(view.saved.text).toMatch(/^saved .* · 2 items \(2 in stock\)$/);
    expect(view.flips.text).toBe('Flips from your price list: 1');

    // A 0.3 database: /items pages were imported as prices before the list table (V4) existed, so the
    // batch has no bank and there are no list rows.
    const repo03 = newRepo();
    const old = batch(repo03, { pageKind: 'items-list', fileMtime: T0 - 3 * DAY, itemCount: 1, categories: { hats: 1 } });
    repo03.upsertOpportunities([flip(imported(repo03, old, '9101;6', { observedAt: T0 - 3 * DAY }), 7)]);
    const h = setup({ repo: repo03 });
    expect(h.list.summary.items).toBe(0);
    expect(h.of('list')).toMatchObject({ lastSavedAt: T0 - 3 * DAY, pages: 1, items: 1, inStock: 1, flips: 1, flipProfitScrap: 7 });
    // With no list batch at all, the card stays never saved.
    expect(saved(setup().of('list'))).toEqual([null, 0, 0, 0]);
  });

  it('maps an opportunity to its bank only through an imported price reference', () => {
    const banks = new Map<number, ScraptfBank>([
      [12, 'stranges'],
      [7, 'list'],
    ]);
    expect(opportunityBank({ inputKind: 'import', inputRef: 'price:12' }, banks)).toBe('stranges');
    expect(opportunityBank({ inputKind: 'import', inputRef: 'price:7' }, banks)).toBe('list');
    expect(opportunityBank({ inputKind: 'import', inputRef: 'price:13' }, banks)).toBeNull();
    expect(opportunityBank({ inputKind: 'user', inputRef: 'price:12' }, banks)).toBeNull();
    expect(opportunityBank({ inputKind: 'rule', inputRef: 'rule:12' }, banks)).toBeNull();
    for (const ref of ['price:12x', 'price:', 'price:-12', ' price:12', 'price:1e1']) expect(opportunityBank({ inputKind: 'import', inputRef: ref }, banks)).toBeNull();
  });
});

describe('what to look for (S4)', () => {
  it("takes each bank's unchecked rows from the market index, grouped by bankForCategory, top 5 by Pay up to", () => {
    const rows: MarketRow[] = [
      row({ sku: '1;6', maxCostScrap: 50 }),
      row({ sku: '2;6', maxCostScrap: 40, name: 'Zed' }),
      row({ sku: '3;6', maxCostScrap: 40, name: 'Abe' }),
      row({ sku: '4;6', maxCostScrap: 30 }),
      row({ sku: '5;6', maxCostScrap: 20 }),
      row({ sku: '6;6', maxCostScrap: 10 }),
      // Unchecked but nothing to pay: counted, never listed.
      row({ sku: '7;6', maxCostScrap: 0 }),
      row({ sku: '8;6', maxCostScrap: null, revenueScrap: null }),
      // Checked rows are not what to look for.
      row({ sku: '9;6', maxCostScrap: 99, verdict: 'flip', knownSource: 'typed', knownCostScrap: 10 }),
      row({ sku: '10;6', category: 'taunts', maxCostScrap: 15 }),
      row({ sku: '11;6', category: 'other', maxCostScrap: 25 }),
      row({ sku: '12;11', category: 'stranges', maxCostScrap: 7 }),
    ];
    const h = setup({ rows });
    const r = h.banks.summary(T0);
    const by = Object.fromEntries(r.banks.map((b) => [b.bank, [b.unchecked, b.lookFor.map((x) => x.sku)]]));
    expect(by).toEqual({
      hats: [8, ['1;6', '3;6', '2;6', '4;6', '5;6']],
      weapons: [0, []],
      stranges: [1, ['12;11']],
      killstreaks: [0, []],
      skins: [0, []],
      items: [2, ['11;6', '10;6']],
      unusuals: [0, []],
      list: [0, []],
    });
    expect(r.banks[0]!.lookFor[0]).toEqual({ sku: '1;6', name: 'Item 1;6', maxCostScrap: 50, revenueScrap: 30 });
    expect(h.uncheckedBy).toHaveBeenCalledTimes(1);
    expect(h.uncheckedBy).toHaveBeenCalledWith(bankForCategory, BANK_LOOK_FOR, T0);
  });

  it('groups by the same banks the cards list: every category is in the categories of bankForCategory(category)', () => {
    for (const c of CATEGORIES) expect(SCRAPTF_BANKS.find((b) => b.bank === bankForCategory(c))!.categories).toContain(c);
    for (const b of SCRAPTF_BANKS) for (const c of b.categories) expect(bankForCategory(c)).toBe(b.bank);
  });
});

describe('cache and invalidation', () => {
  function seeded() {
    const repo = newRepo();
    const hats = batch(repo, { bank: 'hats', fileMtime: T0 - 10 * MIN, itemCount: 1 });
    const p = imported(repo, hats, '1001;6');
    repo.upsertOpportunities([flip(p, 40)]);
    const h = setup({ repo, rows: [row({ sku: '2;6', maxCostScrap: 30 })] });
    h.list.summary = { items: 1, newestAt: T0 - MIN, oldestAt: T0 - MIN, batches: 1 };
    h.list.rows = [listRow('1;6', 2)];
    const reads = () => ({
      batches: h.spies.batches.mock.calls.length,
      prices: h.spies.prices.mock.calls.length,
      opps: h.spies.opps.mock.calls.length,
      market: h.uncheckedBy.mock.calls.length,
      list: h.scraptfList.summary.mock.calls.length,
    });
    return { ...h, hats, p, reads };
  }

  it('reads each part once until what it reads changes', () => {
    const h = seeded();
    const first = h.banks.summary(T0);
    for (let i = 0; i < 3; i++) expect(h.banks.summary(T0 + i).banks).toEqual(first.banks);
    expect(h.reads()).toEqual({ batches: 1, prices: 1, opps: 1, market: 1, list: 1 });

    // A Live market change: lookFor and unchecked only.
    h.banks.invalidate('market');
    h.banks.summary(T0);
    expect(h.reads()).toEqual({ batches: 1, prices: 1, opps: 1, market: 2, list: 1 });

    // The engine rewrote the opportunities: flips only, through the cached price -> bank map.
    h.banks.invalidate('flips');
    h.banks.summary(T0);
    expect(h.reads()).toEqual({ batches: 1, prices: 1, opps: 2, market: 2, list: 1 });

    // The switches are read live: nothing to rebuild.
    h.banks.invalidate('switches');
    h.banks.summary(T0);
    expect(h.reads()).toEqual({ batches: 1, prices: 1, opps: 2, market: 2, list: 1 });

    // The saved list moved (its version): the list card only.
    h.list.version++;
    h.banks.summary(T0);
    expect(h.reads()).toEqual({ batches: 1, prices: 1, opps: 2, market: 2, list: 2 });

    // An import, a price, rule or list write: everything (a price of yours also checks a market row).
    h.banks.invalidate();
    h.banks.summary(T0);
    expect(h.reads()).toEqual({ batches: 2, prices: 2, opps: 3, market: 3, list: 3 });
    h.banks.invalidate('all');
    h.banks.summary(T0);
    expect(h.reads()).toEqual({ batches: 3, prices: 3, opps: 4, market: 4, list: 4 });
  });

  it('serves the change at once after invalidate, before the throttled push', () => {
    const h = seeded();
    h.banks.invalidate();
    h.timers.advance(0);
    expect(h.heard).toEqual([T0]);
    expect(h.of('hats')).toMatchObject({ flips: 1, items: 1, unchecked: 1 });

    // Inside the push window: a new save of the page with one more item, its flip and a market row.
    h.clock.advance(100);
    const hats2 = batch(h.repo, { bank: 'hats', fileMtime: T0 - MIN, itemCount: 2 });
    imported(h.repo, hats2, h.p.sku, { id: h.p.id });
    const p2 = imported(h.repo, hats2, '1002;6');
    h.repo.upsertOpportunities([flip(p2, 60)]);
    h.market.rows.push(row({ sku: '3;6', maxCostScrap: 50 }));
    h.banks.invalidate();
    expect(h.heard).toEqual([T0]);
    // The re-save holds both rows now: one page behind the card's data.
    expect(h.of('hats')).toMatchObject({ lastSavedAt: T0 - MIN, pages: 1, items: 2, flips: 2, flipProfitScrap: 100, unchecked: 2, lookFor: [{ sku: '3;6' }, { sku: '2;6' }] });
    h.timers.advance(BANKS_PUSH_MS);
    expect(h.heard).toEqual([T0, T0 + BANKS_PUSH_MS]);
  });

  it('re-reads flips after the engine moved them, and market rows after a market change', () => {
    const h = seeded();
    expect(h.of('hats').flips).toBe(1);
    h.repo.upsertOpportunities([flip(h.p, 40, { status: 'unprofitable', profitScrap: -3 })]);
    expect(h.of('hats').flips).toBe(1); // cached until told
    h.banks.invalidate('flips');
    expect(h.of('hats')).toMatchObject({ flips: 0, flipProfitScrap: 0, top: [] });

    h.market.rows = [];
    expect(h.of('hats').unchecked).toBe(1);
    h.banks.invalidate('market');
    expect(h.of('hats')).toMatchObject({ unchecked: 0, lookFor: [] });
  });

  it('returns copies: changing a result changes nothing cached', () => {
    const h = seeded();
    const r = h.banks.summary(T0);
    const hats = r.banks[0]!;
    hats.top[0]!.profitScrap = 999;
    hats.lookFor[0]!.maxCostScrap = 999;
    hats.top.push({ ...hats.top[0]! });
    hats.items = 999;
    expect(h.of('hats')).toMatchObject({ items: 1, flips: 1, top: [{ profitScrap: 40 }], lookFor: [{ maxCostScrap: 30 }] });
  });
});

describe('failures', () => {
  it('logs a failed read once per streak, keeps the last good data, and reads again on the next call', () => {
    const repo = newRepo();
    const hats = batch(repo, { bank: 'hats', fileMtime: T0 - 10 * MIN, itemCount: 1 });
    repo.upsertOpportunities([flip(imported(repo, hats, '1001;6'), 40)]);
    // The real read, taken before setup spies on it.
    const real = repo.listImportBatches.bind(repo);
    const h = setup({ repo });
    expect(h.of('hats')).toMatchObject({ lastSavedAt: T0 - 10 * MIN, flips: 1 });

    let failing = true;
    h.spies.batches.mockImplementation((n) => {
      if (failing) throw new Error('database is locked');
      return real(n);
    });
    h.banks.invalidate();
    for (let i = 0; i < 3; i++) expect(h.of('hats')).toMatchObject({ lastSavedAt: T0 - 10 * MIN, items: 1, flips: 1 });
    expect(h.log.lines.filter((l) => l.level === 'warn' && /saved pages/.test(l.msg))).toHaveLength(1);
    // While the pages cannot be read, flips are not rebuilt against an empty price map.
    expect(h.spies.opps).toHaveBeenCalledTimes(1);

    failing = false;
    batch(repo, { bank: 'hats', fileMtime: T0 - MIN, itemCount: 1 });
    expect(h.of('hats')).toMatchObject({ lastSavedAt: T0 - MIN, flips: 1 });
    expect(h.spies.opps).toHaveBeenCalledTimes(2);
    // A new streak logs again.
    failing = true;
    h.banks.invalidate();
    h.of('hats');
    expect(h.log.lines.filter((l) => l.level === 'warn' && /saved pages/.test(l.msg))).toHaveLength(2);
  });

  it('never throws: a first read failing everywhere reads as never saved, with the switches off', () => {
    const repo = newRepo();
    const h = setup({ repo, patch: { import: { enabled: true, acknowledgedAt: T0 - 1 } } });
    const boom = () => {
      throw new Error('boom');
    };
    h.spies.batches.mockImplementation(boom);
    h.spies.opps.mockImplementation(boom);
    h.uncheckedBy.mockImplementation(boom);
    h.scraptfList.summary.mockImplementation(boom);
    h.scraptfList.version.mockImplementation(boom);
    h.watch.current = null as unknown as { active: boolean; error: string | null };
    const r = h.banks.summary(T0);
    for (const b of r.banks) expect(b).toEqual(emptyBankSummary(SCRAPTF_BANKS.find((x) => x.bank === b.bank)!));
    expect(r).toMatchObject({ importEnabled: true, watchActive: false });
    expect(h.log.lines.filter((l) => l.level === 'warn').map((l) => l.msg)).toEqual([
      'scrap.tf banks could not read the saved pages',
      'scrap.tf banks could not read the Live market',
      'scrap.tf banks could not read the saved price list',
    ]);
    const broken = createBanksSummary({ clock: h.clock, log: h.log, repo, market: { uncheckedBy: boom }, scraptfList: h.scraptfList, settings: boom, folderWatch: boom, timers: h.timers });
    expect(broken.summary(T0)).toMatchObject({ importEnabled: false, watchActive: false });
  });

  it('keeps the last good lookFor while the market read fails', () => {
    const h = setup({ rows: [row({ sku: '1;6', maxCostScrap: 30 })] });
    expect(h.of('hats').unchecked).toBe(1);
    h.uncheckedBy.mockImplementation(() => {
      throw new Error('index busy');
    });
    h.banks.invalidate('market');
    expect(h.of('hats')).toMatchObject({ unchecked: 1, lookFor: [{ sku: '1;6' }] });
    h.uncheckedBy.mockImplementation(fakeUncheckedBy(() => []));
    expect(h.of('hats')).toMatchObject({ unchecked: 0, lookFor: [] });
  });
});

describe('change notification', () => {
  it(`tells listeners once per ${BANKS_PUSH_MS} ms at most, coalescing every change in between`, () => {
    const h = setup();
    h.banks.invalidate();
    h.banks.invalidate('market');
    expect(h.heard).toEqual([]);
    h.timers.advance(0);
    expect(h.heard).toEqual([T0]);

    // Inside the window: held until it ends, then told once.
    h.timers.advance(500);
    h.banks.invalidate();
    h.banks.invalidate();
    h.timers.advance(1_000);
    expect(h.heard).toEqual([T0]);
    h.timers.advance(500);
    expect(h.heard).toEqual([T0, T0 + BANKS_PUSH_MS]);

    // Quiet for longer than the window: the next change is told at once.
    h.timers.advance(10_000);
    h.banks.invalidate('market');
    h.timers.advance(0);
    expect(h.heard).toEqual([T0, T0 + BANKS_PUSH_MS, T0 + BANKS_PUSH_MS + 10_000]);
    expect(h.timers.count).toBe(0);
  });

  it('tells every scope, the switches included', () => {
    for (const scope of ['all', 'flips', 'market', 'switches'] as const) {
      const h = setup();
      h.banks.invalidate(scope);
      h.timers.advance(0);
      expect(h.heard, scope).toEqual([T0]);
    }
  });

  it('isolates a failing listener, unsubscribes, and stops cleanly', () => {
    const h = setup();
    const off = h.banks.onChanged(() => {
      throw new Error('boom');
    });
    h.banks.invalidate();
    h.timers.advance(0);
    expect(h.heard).toHaveLength(1);
    expect(h.log.lines.some((l) => l.level === 'warn')).toBe(true);
    off();

    h.banks.invalidate();
    expect(h.timers.count).toBe(1);
    h.banks.stop();
    expect(h.timers.count).toBe(0);
    h.banks.invalidate();
    h.timers.advance(5_000);
    expect(h.heard).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F18 S3: a bank page saved without its cards ("HTML only" keeps the page as it first loaded)
// ---------------------------------------------------------------------------

describe('a bank page saved without its cards (F18 S3)', () => {
  it('keeps the card on the save whose prices are in use, as the coverage chip does', () => {
    const repo = newRepo();
    const good = batch(repo, { bank: 'hats', fileMtime: T0 - 2 * HOUR, itemCount: 2, categories: { hats: 2 } });
    imported(repo, good, '1001;6', { observedAt: T0 - 2 * HOUR });
    imported(repo, good, '1002;6', { observedAt: T0 - 2 * HOUR, stock: 0 });
    // Saved since without its cards: the batch records its bank and time, and stored nothing.
    const empty = batch(repo, { bank: 'hats', fileMtime: T0 - MIN, itemCount: 0 });
    expect(repo.listImportBatches(10).find((b) => b.id === empty)).toMatchObject({ bank: 'hats', fileMtime: T0 - MIN, itemCount: 0 });
    const h = setup({ repo });
    // Not "Fresh, 0 items": the hats card stays on the good save (2 hours, 2 items, 1 in stock).
    expect(saved(h.of('hats'))).toEqual([T0 - 2 * HOUR, 1, 2, 1]);
    const chip = scraptfCoverage(repo.listImportBatches(500), () => []).find((c) => c.label === 'Hats')!;
    expect([chip.lastSavedAt, chip.items]).toEqual([T0 - 2 * HOUR, 2]);
    // A bank only ever saved without its cards reads never saved.
    batch(repo, { bank: 'unusuals', fileMtime: T0 - MIN, itemCount: 0 });
    h.banks.invalidate();
    expect(saved(h.of('unusuals'))).toEqual([null, 0, 0, 0]);
    // A later save with cards dates the bank again.
    const again = batch(repo, { bank: 'hats', fileMtime: T0 - 30_000, itemCount: 1, categories: { hats: 1 } });
    imported(repo, again, '1003;6', { observedAt: T0 - 30_000 });
    h.banks.invalidate();
    expect(saved(h.of('hats'))).toEqual([T0 - 30_000, 2, 1, 1]);
  });

  it('still counts a saved /items list that stored nothing: a list of sold-out rows was saved', () => {
    const repo = newRepo();
    batch(repo, { bank: 'list', pageKind: 'items-list', fileMtime: T0 - 3 * MIN, itemCount: 0 });
    const h = setup({ repo });
    // The list card reads the list's batches while the saved list holds no rows.
    expect(saved(h.of('list'))).toEqual([T0 - 3 * MIN, 1, 0, 0]);
  });
});
