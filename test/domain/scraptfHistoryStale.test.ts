// 0.7.1 (DM-5): old pages and sightings stop reading as current. A page saved once 60 days ago lists its
// items for 0 (lastSeenAt - listedSince), so "Listed > 24 h" rejects them and the label data says when they
// were last seen; a bank saved over a day ago marks nothing New (and the market's cached pass hears of it
// as time passes); a page far older than its bank's newest is left out of the stock page, its counts and
// "What's new" (BankStockResult.olderPages), while history keeps it. Real in-memory repo, bank stock cache,
// history and market index; fake clock. Pages the user saved only (R10); no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex, marketCategoryOf, type MarketIndex } from '../../src/service/domain/market';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { BANK_STOCK_NEW_MAX_AGE_MS, BANK_STOCK_OLDER_PAGE_MS, bankStockLongListed } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { marketListedSideMatches } from '../../src/shared/scraptfHistory';
import type { BankStockStored, Listing, ScraptfBank, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, silentLogger } from './helpers';

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[], page = bank === 'list' ? '/items' : `/buy/${bank}`): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows, page);
  return id;
}

function buy(sku: string, metalScrap: number, id: string): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, id, steamid: id });
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  market: MarketIndex;
  stock: BankStock;
  history: ScraptfHistory;
}

function setup(): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const schema = createStubSchema();
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
  let stock!: BankStock;
  let history!: ScraptfHistory;
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    bankStock: { newAtFor: (b) => stock.newAtFor(b), version: () => stock.version(), seenFor: (b) => stock.seenFor(b) },
    // As core will wire it (hand-off): the run's newest sighting too.
    history: { listedSinceFor: (b, bank) => history.listedSinceFor(b, bank), listedFor: (b, bank) => history.listedFor(b, bank), version: () => history.version() },
  });
  history = createScraptfHistory({ clock, log: silentLogger, repo, market, keyPrice });
  stock = createBankStock({ clock, log: silentLogger, repo, market, keyPrice, settings: () => settings, categoryOf: (sku) => marketCategoryOf(schema, sku), history });
  repo.upsertListings([buy('378;6', 120, 'tc'), buy('126;6', 60, 'bh')]);
  market.start();
  timers.advance(0);
  return { repo, clock, market, stock, history };
}

describe('a page saved once, long ago (DM-5)', () => {
  it('lists its items for 0, so "Listed > 24 h" rejects them, and says when they were last seen', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 60 * DAY, [s('378;6', 40)]);
    h.stock.refresh();
    h.history.refresh();
    expect(h.history.listedFor('378;6', 'hats')).toEqual({ since: T0 - 60 * DAY, lastSeenAt: T0 - 60 * DAY });
    const row = h.stock.list({ bank: 'hats' }, T0).rows.find((r) => r.sku === '378;6')!;
    expect(row).toMatchObject({ listedSince: T0 - 60 * DAY, lastSeenAt: T0 - 60 * DAY });
    expect(bankStockLongListed(row, T0)).toBe(false);
    expect(h.stock.list({ bank: 'hats', filter: 'long-listed' }, T0).total).toBe(0);
    const market = h.market.all({}, T0).find((r) => r.sku === '378;6')!;
    expect(market).toMatchObject({ scraptfListedSince: T0 - 60 * DAY, scraptfLastSeenAt: T0 - 60 * DAY });
    expect(marketListedSideMatches(market, { listedOnScraptf: true }, T0)).toBe(false);
    expect(h.market.all({ listedOnScraptf: true }, T0)).toEqual([]);
  });

  it('a page saved on two days a week apart lists for the week between, to its last sighting', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 30 * DAY, [s('378;6', 40)]);
    save(h.repo, 'hats', T0 - 23 * DAY, [s('378;6', 40)]);
    h.stock.refresh();
    h.history.refresh();
    const row = h.stock.list({ bank: 'hats' }, T0).rows[0]!;
    expect(row).toMatchObject({ listedSince: T0 - 30 * DAY, lastSeenAt: T0 - 23 * DAY });
    expect(bankStockLongListed(row, T0)).toBe(true);
    expect(h.market.all({ listedOnScraptf: true }, T0).map((r) => r.sku)).toEqual(['378;6']);
  });
});

describe('the New badge of a stale bank (DM-5)', () => {
  it('marks nothing New for a bank saved over a day ago, and moves the version when a bank goes stale', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 3 * DAY, [s('126;6', 30)]);
    save(h.repo, 'hats', T0 - 2 * DAY, [s('126;6', 30), s('378;6', 40)]);
    h.stock.refresh();
    expect(h.stock.newAtFor('378;6')).toBeNull();
    // A fresh bank: New until its newest save is a day old.
    save(h.repo, 'weapons', T0 - 2 * HOUR, [s('205;6', 10)]);
    save(h.repo, 'weapons', T0 - HOUR, [s('205;6', 10), s('199;6', 12)]);
    h.stock.refresh();
    expect(h.stock.newAtFor('199;6')).toBe(T0 - HOUR);
    const v = h.stock.version();
    h.clock.advance(BANK_STOCK_NEW_MAX_AGE_MS - HOUR + MIN);
    expect(h.stock.version()).toBeGreaterThan(v);
    expect(h.stock.newAtFor('199;6')).toBeNull();
    // The stock page still shows what changed on that save.
    expect(h.stock.list({ bank: 'weapons', filter: 'new' }, h.clock.now()).rows.map((r) => r.sku)).toEqual(['199;6']);
  });
});

describe('a page far older than its bank\'s newest (DM-5)', () => {
  it('is left out of the stock page, its counts and What\'s new, and reported as olderPages; history keeps it', () => {
    const h = setup();
    const at2 = T0 - BANK_STOCK_OLDER_PAGE_MS - DAY;
    save(h.repo, 'list', at2 - DAY, [s('300;6', 9), s('301;6', 9)], '/items/2');
    save(h.repo, 'list', at2, [s('300;6', 9)], '/items/2');
    save(h.repo, 'list', T0 - 2 * HOUR, [s('126;6', 30)], '/items');
    save(h.repo, 'list', T0 - HOUR, [s('126;6', 28), s('378;6', 40)], '/items');
    h.stock.refresh();
    h.history.refresh();
    const r = h.stock.list({ bank: 'list' }, T0);
    expect(r.olderPages).toEqual({ count: 1, newestSavedAt: at2 });
    expect(r).toMatchObject({ savedAt: T0 - HOUR, previousSavedAt: T0 - 2 * HOUR, counts: { items: 2, inStock: 2, new: 1, cheaper: 1, gone: 0 } });
    expect(r.pages).toBeUndefined();
    expect(r.rows.map((x) => x.sku).sort()).toEqual(['126;6', '378;6']);
    expect(h.stock.whatsNew('list')).toMatchObject({ new: 1, cheaper: 1, gone: 0, since: T0 - 2 * HOUR });
    // History and the drawer still read the old page.
    expect(h.stock.detailFor('300;6')).toMatchObject({ bank: 'list', savedAt: at2 });
    expect(h.history.itemHistory('300;6', null, T0).points.length).toBe(2);
    // Within 48 h of the newest page: shown as before.
    save(h.repo, 'list', T0 - 30 * HOUR, [s('300;6', 9)], '/items/2');
    h.stock.refresh();
    const again = h.stock.list({ bank: 'list' }, T0);
    expect(again.olderPages).toBeUndefined();
    expect(again.pages).toBe(2);
    expect(again.rows.map((x) => x.sku).sort()).toEqual(['126;6', '300;6', '378;6']);
  });
});
