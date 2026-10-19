// F19 S1 in the Live market index: MarketRow.scraptfLink is joined at read time from memory, the newest
// saved page listing the base SKU (an imported price's bank, or a bank stock save), a bank page before the
// scrap.tf/items list, else the category's bank. It agrees with ItemDetail.seenOn on bank pages, follows
// an import (pricesChanged) and a bank stock refresh, never reads the database per row and only ever
// names a static SCRAPTF_BANKS page. Real in-memory repo, real index and bank stock cache, fake clock and
// timers. Saves are pages the user saved (R10); nothing touches scrap.tf or any network (R1).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex, marketCategoryOf, type MarketIndex, type MarketIndexDeps } from '../../src/service/domain/market';
import { buildItemDetail } from '../../src/service/domain/views';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANKS, bankForCategory, isAllowedExternalUrl, scraptfBankInfo } from '../../src/shared/links';
import type { BankStockStored, Listing, MarketRow, ScraptfBank, Settings, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, silentLogger, special } from './helpers';

const PAINT = 3100495;
const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
  vi.restoreAllMocks();
});

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

function batch(repo: Repo, bank: ScraptfBank | null, at: UnixMs, items = 1): number {
  const pageKind = bank === 'list' ? 'items-list' : bank === 'unusuals' ? 'unusuals' : 'buy';
  return repo.createImportBatch({ fileName: `${bank ?? 'unknown'}.html`, pageKind, fileMtime: at, importedAt: at, itemCount: items, bank });
}

/** An imported price as importSavedPage stores it: under the base SKU, dated at the page's save, in its batch. */
function imported(repo: Repo, sku: string, bank: ScraptfBank | null, at: UnixMs, over: { special?: ReturnType<typeof special> } = {}): void {
  repo.upsertScrapPrice({ sku, name: sku, costScrap: 30, source: 'import', observedAt: at, importBatch: batch(repo, bank, at), stock: 1, ...over });
}

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

/** A bank stock save (the rows a recognised saved page had), as importSavedPage writes them. */
function stockSave(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = batch(repo, bank, at, rows.length);
  repo.insertBankStock(id, bank, rows);
  return id;
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  settings: { current: Settings };
  market: MarketIndex;
  stock: BankStock;
  build(): void;
  rows(): MarketRow[];
  link(sku: string): MarketRow['scraptfLink'] | undefined;
  detail(sku: string): ReturnType<typeof buildItemDetail>;
}

/** `dep`: the index's bank stock dependency (undefined: the real cache with seenFor, as core wires it). */
function setup(dep?: MarketIndexDeps['bankStock'] | null): Harness {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, {}) };
  const schema = createStubSchema();
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now());
  let stock!: BankStock;
  const wired: MarketIndexDeps['bankStock'] =
    dep === undefined ? { newAtFor: (b) => stock.newAtFor(b), version: () => stock.version(), seenFor: (b) => stock.seenFor(b) } : (dep ?? undefined);
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings.current),
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    ...(wired ? { bankStock: wired } : {}),
  });
  stock = createBankStock({ clock, log: silentLogger, repo, market, keyPrice, settings: () => settings.current, categoryOf: (sku) => marketCategoryOf(schema, sku) });
  const all = () => market.all({}, clock.now());
  return {
    repo,
    clock,
    settings,
    market,
    stock,
    build() {
      market.start();
      timers.advance(0);
      expect(market.stats().building).toBe(false);
    },
    rows: all,
    link: (sku) => all().find((r) => r.sku === sku)?.scraptfLink,
    // As rpcHandlers' 'item.detail' builds the drawer's (default target, no history).
    detail: (sku) =>
      buildItemDetail({ repo, schema, sku, keyPrice: keyPrice(), settings: settings.current, now: clock.now(), snapshot: { lastAt: null, available: false, nextAllowedAt: null } }),
  };
}

/** Buyers for two hats, two weapons, a strange weapon and a taunt (every row has an entry). */
function seedBook(repo: Repo): void {
  repo.upsertListings([
    buy('378;6', 120, { id: 'tc', steamid: 'TC' }),
    buy('126;6', 60, { id: 'bh', steamid: 'BH' }),
    buy('205;6', 45, { id: 'rl', steamid: 'RL' }),
    buy('205;11', 200, { id: 'srl', steamid: 'SRL' }),
    buy('15000;6', 50, { id: 'sr', steamid: 'SR' }),
    buy('30920;6', 300, { id: 'taunt', steamid: 'TAUNT' }),
  ]);
}

const urlOf = (bank: ScraptfBank): string => scraptfBankInfo(bank)!.url;

describe('MarketRow.scraptfLink (F19 S1)', () => {
  it("is the category's bank page, never the list, until a saved page lists the item", () => {
    const h = setup();
    seedBook(h.repo);
    h.build();
    const rows = h.rows();
    expect(rows.length).toBe(6);
    for (const r of rows) {
      const bank = bankForCategory(r.category);
      expect(r.scraptfLink, r.sku).toEqual({ bank, url: urlOf(bank), seenAt: null, source: 'category' });
    }
    expect(Object.fromEntries(rows.map((r) => [r.sku, r.scraptfLink.bank]))).toEqual({
      '378;6': 'hats',
      '126;6': 'hats',
      '205;6': 'weapons',
      '205;11': 'stranges',
      '15000;6': 'weapons',
      '30920;6': 'items',
    });
  });

  it('names the bank of the newest imported price, dated at its save; typed prices and unknown pages name none', () => {
    const h = setup();
    seedBook(h.repo);
    imported(h.repo, '378;6', 'hats', T0 - 3 * HOUR);
    imported(h.repo, '378;6', 'stranges', T0 - 2 * HOUR);
    // Newer, but typed, or from an unrecognised (or 0.4) page: the user saw it on no bank page.
    h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 40, source: 'user', observedAt: T0 - MIN });
    imported(h.repo, '378;6', null, T0 - 30 * MIN);
    // A painted copy stored under the base SKU names its page for the base row too.
    imported(h.repo, '126;6', 'unusuals', T0 - HOUR, { special: special({ paint: PAINT }) });
    h.build();
    expect(h.link('378;6')).toEqual({ bank: 'stranges', url: urlOf('stranges'), seenAt: T0 - 2 * HOUR, source: 'seen' });
    expect(h.link('126;6')).toEqual({ bank: 'unusuals', url: urlOf('unusuals'), seenAt: T0 - HOUR, source: 'seen' });
    expect(h.link('205;6')).toMatchObject({ bank: 'weapons', source: 'category', seenAt: null });
  });

  it('prefers a bank page to the newer scrap.tf/items list, and names the list only when nothing else listed it', () => {
    const h = setup();
    seedBook(h.repo);
    imported(h.repo, '378;6', 'hats', T0 - 5 * HOUR);
    imported(h.repo, '378;6', 'list', T0 - MIN);
    imported(h.repo, '30920;6', 'list', T0 - 2 * MIN);
    h.build();
    expect(h.link('378;6')).toEqual({ bank: 'hats', url: urlOf('hats'), seenAt: T0 - 5 * HOUR, source: 'seen' });
    expect(h.link('30920;6')).toEqual({ bank: 'list', url: urlOf('list'), seenAt: T0 - 2 * MIN, source: 'seen' });
  });

  it("joins the bank stock's saves: the newest save listing any copy, never a copy gone from it", () => {
    const h = setup();
    seedBook(h.repo);
    // An older imported price on the hats page; a newer weapons save lists the rocket launcher.
    imported(h.repo, '378;6', 'hats', T0 - 3 * HOUR);
    stockSave(h.repo, 'weapons', T0 - 20 * MIN, [s('205;6', 40)]);
    // Two saves of the stranges page: the strange launcher left it, a painted Team Captain came.
    stockSave(h.repo, 'stranges', T0 - 2 * HOUR, [s('205;11', 150)]);
    stockSave(h.repo, 'stranges', T0 - 10 * MIN, [s('378;6', 90, { specialKey: bankStockSpecialKey({ paint: PAINT }) })]);
    h.build();
    expect(h.link('205;6')).toEqual({ bank: 'weapons', url: urlOf('weapons'), seenAt: T0 - 20 * MIN, source: 'seen' });
    // The bank stock save is newer than the imported price.
    expect(h.link('378;6')).toEqual({ bank: 'stranges', url: urlOf('stranges'), seenAt: T0 - 10 * MIN, source: 'seen' });
    // Gone from the stranges page's newest save: not where to look for it any more.
    expect(h.link('205;11')).toMatchObject({ bank: 'stranges', source: 'category', seenAt: null });
    expect(h.stock.seenFor('205;11')).toBeNull();
    // A list save loses to an older bank page there too, and names the list only for an item no page listed.
    stockSave(h.repo, 'list', T0 - MIN, [s('205;6', 41), s('30920;6', 290)]);
    h.stock.refresh();
    expect(h.link('205;6')).toMatchObject({ bank: 'weapons', seenAt: T0 - 20 * MIN });
    expect(h.link('30920;6')).toEqual({ bank: 'list', url: urlOf('list'), seenAt: T0 - MIN, source: 'seen' });
  });

  it('follows an import (pricesChanged) and a bank stock refresh on the next read', () => {
    const h = setup();
    seedBook(h.repo);
    h.build();
    expect(h.link('126;6')).toMatchObject({ source: 'category' });
    imported(h.repo, '126;6', 'hats', T0 - 30 * MIN);
    // Not before the index hears of the write: the sightings live in memory, rebuilt per change.
    expect(h.link('126;6')).toMatchObject({ source: 'category' });
    h.market.pricesChanged();
    expect(h.link('126;6')).toEqual({ bank: 'hats', url: urlOf('hats'), seenAt: T0 - 30 * MIN, source: 'seen' });

    expect(h.link('205;6')).toMatchObject({ source: 'category' });
    stockSave(h.repo, 'weapons', T0 - 5 * MIN, [s('205;6', 40)]);
    h.stock.refresh();
    expect(h.link('205;6')).toEqual({ bank: 'weapons', url: urlOf('weapons'), seenAt: T0 - 5 * MIN, source: 'seen' });
    // A price deleted again: the row falls back once the index hears of it.
    for (const p of h.repo.scrapPricesForSku('126;6')) h.repo.deleteScrapPrice(p.id);
    h.market.pricesChanged();
    expect(h.link('126;6')).toMatchObject({ bank: 'hats', source: 'category', seenAt: null });
  });

  it('reads no database per row: the sightings are in memory', () => {
    const h = setup();
    seedBook(h.repo);
    imported(h.repo, '378;6', 'hats', T0 - HOUR);
    stockSave(h.repo, 'weapons', T0 - 20 * MIN, [s('205;6', 40)]);
    h.build();
    // The first reads fill the index's caches (the known prices, the coverage strip): once, not per row.
    h.rows();
    h.market.list({}, h.clock.now());
    const spies = (['listScrapPrices', 'scrapPricesForSku', 'bankStockSaves', 'bankStockRows', 'bankStockLatestPair', 'listImportBatches'] as const).map((m) => vi.spyOn(h.repo, m));
    for (let i = 0; i < 3; i++) {
      const rows = h.rows();
      expect(rows.filter((r) => r.scraptfLink.source === 'seen').map((r) => r.sku).sort()).toEqual(['205;6', '378;6']);
      h.market.list({ limit: 2 }, h.clock.now());
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('only ever names a static SCRAPTF_BANKS page, whatever the stored data says', () => {
    const h = setup();
    seedBook(h.repo);
    for (const [i, info] of SCRAPTF_BANKS.entries()) imported(h.repo, ['378;6', '126;6', '205;6', '205;11', '15000;6', '30920;6'][i % 6]!, info.bank, T0 - (i + 1) * MIN);
    h.build();
    const allowed = new Set(SCRAPTF_BANKS.map((b) => b.url));
    for (const r of h.rows()) {
      expect(allowed.has(r.scraptfLink.url), r.sku).toBe(true);
      expect(isAllowedExternalUrl(r.scraptfLink.url)).toBe(true);
      expect(r.scraptfLink.url).toBe(urlOf(r.scraptfLink.bank));
    }
  });

  it("falls back to the prices' sighting when the bank stock cannot be read, and works without seenFor (0.6 wiring)", () => {
    const failing = setup({
      newAtFor: () => null,
      version: () => 0,
      seenFor: () => {
        throw new Error('database is locked');
      },
    });
    seedBook(failing.repo);
    imported(failing.repo, '378;6', 'hats', T0 - HOUR);
    failing.build();
    expect(failing.link('378;6')).toMatchObject({ bank: 'hats', source: 'seen', seenAt: T0 - HOUR });
    expect(failing.link('205;6')).toMatchObject({ bank: 'weapons', source: 'category' });

    const without = setup({ newAtFor: () => null, version: () => 0 });
    seedBook(without.repo);
    imported(without.repo, '126;6', 'stranges', T0 - HOUR);
    stockSave(without.repo, 'weapons', T0 - MIN, [s('205;6', 40)]);
    without.build();
    expect(without.link('126;6')).toMatchObject({ bank: 'stranges', source: 'seen' });
    expect(without.link('205;6')).toMatchObject({ bank: 'weapons', source: 'category' });

    // A bad sighting from the dependency (unknown bank, no time) is no sighting.
    const odd = setup({ newAtFor: () => null, version: () => 0, seenFor: () => ({ bank: '__proto__' as ScraptfBank, at: Number.NaN }) });
    seedBook(odd.repo);
    odd.build();
    expect(odd.link('378;6')).toMatchObject({ bank: 'hats', source: 'category', seenAt: null });
  });

  it('carries the same link on list() pages, all() and the banks summary rows (uncheckedBy)', () => {
    const h = setup();
    seedBook(h.repo);
    stockSave(h.repo, 'weapons', T0 - 20 * MIN, [s('205;6', 40)]);
    h.build();
    const byAll = new Map(h.rows().map((r) => [r.sku, r.scraptfLink]));
    for (const r of h.market.list({ limit: 2000 }, h.clock.now()).rows) expect(r.scraptfLink).toEqual(byAll.get(r.sku));
    const groups = h.market.uncheckedBy((c) => bankForCategory(c), 10, h.clock.now());
    const weapons = groups.get('weapons')!.rows.find((r) => r.sku === '205;6')!;
    expect(weapons.scraptfLink).toEqual(byAll.get('205;6'));
    expect(weapons.scraptfLink).toMatchObject({ bank: 'weapons', source: 'seen' });
  });
});

describe('parity with ItemDetail.seenOn (F19 S1)', () => {
  it("names the drawer's bank page whenever both have one, at the same time", () => {
    const h = setup();
    seedBook(h.repo);
    // Bank-page imports only, several per item at different times; the bank stock saves come from the
    // same imports (importSavedPage writes both), so they agree.
    const plan: [string, ScraptfBank, number][] = [
      ['378;6', 'hats', 4 * HOUR],
      ['378;6', 'stranges', 2 * HOUR],
      ['378;6', 'unusuals', 3 * HOUR],
      ['126;6', 'hats', 30 * MIN],
      ['126;6', 'items', 90 * MIN],
      ['205;6', 'weapons', 10 * MIN],
      ['205;11', 'stranges', 50 * MIN],
      ['205;11', 'killstreaks', 70 * MIN],
      ['15000;6', 'items', 5 * MIN],
    ];
    for (const [sku, bank, ago] of plan) {
      const at = T0 - ago;
      const id = batch(h.repo, bank, at);
      h.repo.upsertScrapPrice({ sku, name: sku, costScrap: 30, source: 'import', observedAt: at, importBatch: id, stock: 1 });
      h.repo.insertBankStock(id, bank, [s(sku, 30)]);
    }
    h.build();
    let compared = 0;
    for (const r of h.rows()) {
      const seenOn = h.detail(r.sku)?.seenOn ?? null;
      if (seenOn === null) {
        expect(r.scraptfLink.source, r.sku).toBe('category');
        continue;
      }
      expect(r.scraptfLink, r.sku).toEqual({ bank: seenOn.bank, url: seenOn.url, seenAt: seenOn.at, source: 'seen' });
      compared++;
    }
    expect(compared).toBe(5);
    expect(h.link('30920;6')).toMatchObject({ source: 'category' });
  });

  it('differs only where the spec says: a newer scrap.tf/items row loses to an older bank page', () => {
    const h = setup();
    seedBook(h.repo);
    imported(h.repo, '378;6', 'hats', T0 - 2 * HOUR);
    imported(h.repo, '378;6', 'list', T0 - MIN);
    h.build();
    // The drawer's "Seen on" names the newest import, the list; its "Open bank page" skips the list
    // (seenBankPageUrl) and opens the bank, which is what the row's button opens.
    expect(h.detail('378;6')!.seenOn).toMatchObject({ bank: 'list', at: T0 - MIN });
    expect(h.link('378;6')).toEqual({ bank: 'hats', url: urlOf('hats'), seenAt: T0 - 2 * HOUR, source: 'seen' });
  });

  it('breaks a tie at one save time the way seenOn does (the higher price id)', () => {
    const h = setup();
    seedBook(h.repo);
    imported(h.repo, '378;6', 'stranges', T0 - HOUR);
    imported(h.repo, '378;6', 'unusuals', T0 - HOUR);
    imported(h.repo, '126;6', 'unusuals', T0 - HOUR);
    imported(h.repo, '126;6', 'hats', T0 - HOUR);
    h.build();
    for (const sku of ['378;6', '126;6']) expect(h.link(sku)!.bank, sku).toBe(h.detail(sku)!.seenOn!.bank);
    expect([h.link('378;6')!.bank, h.link('126;6')!.bank]).toEqual(['unusuals', 'hats']);
  });
});

describe('BankStock.seenFor (F19)', () => {
  it("is the newest kept save listing a base, a bank page before the list; null for anything else", () => {
    const h = setup();
    stockSave(h.repo, 'hats', T0 - 2 * HOUR, [s('378;6', 40)]);
    stockSave(h.repo, 'hats', T0 - HOUR, [s('378;6', 41), s('126;6', 20)]);
    stockSave(h.repo, 'list', T0 - MIN, [s('378;6', 42), s('5021;6', 560, { stock: 0 })]);
    expect(h.stock.seenFor('378;6')).toEqual({ bank: 'hats', at: T0 - HOUR });
    expect(h.stock.seenFor('126;6')).toEqual({ bank: 'hats', at: T0 - HOUR });
    // A sold-out list row is still on the list the user saved.
    expect(h.stock.seenFor('5021;6')).toEqual({ bank: 'list', at: T0 - MIN });
    expect(h.stock.seenFor('205;6')).toBeNull();
    expect(h.stock.seenFor(42 as unknown as string)).toBeNull();
    // Copies: the caller's objects are its own.
    const a = h.stock.seenFor('378;6')!;
    a.bank = 'list';
    expect(h.stock.seenFor('378;6')).toEqual({ bank: 'hats', at: T0 - HOUR });
  });

  it('is rebuilt after a refresh changed the kept saves, and not read again otherwise', () => {
    const h = setup();
    stockSave(h.repo, 'weapons', T0 - HOUR, [s('205;6', 40)]);
    expect(h.stock.seenFor('205;6')).toEqual({ bank: 'weapons', at: T0 - HOUR });
    const saves = vi.spyOn(h.repo, 'bankStockSaves');
    const rows = vi.spyOn(h.repo, 'bankStockRows');
    for (let i = 0; i < 5; i++) h.stock.seenFor('205;6');
    expect(saves).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
    stockSave(h.repo, 'stranges', T0 - MIN, [s('205;6', 50)]);
    expect(h.stock.seenFor('205;6')).toEqual({ bank: 'weapons', at: T0 - HOUR });
    h.stock.refresh();
    expect(h.stock.seenFor('205;6')).toEqual({ bank: 'stranges', at: T0 - MIN });
  });
});
