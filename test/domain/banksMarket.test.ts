// F15 banks summary over the real Live market index, saved list cache and repo: each bank's
// "what to look for" is exactly the shared rule (bankLookFor) over the market's "Not checked" rows,
// read in one lean pass; a saved page, its flips and the market move the cards as core's hooks
// invalidate them. Fake clock and timers; nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBanksSummary } from '../../src/service/domain/banks';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex, marketCategoryOf } from '../../src/service/domain/market';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { bankLookFor } from '../../src/shared/banks';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { Category, Listing, ScraptfBank } from '../../src/shared/types';
import { makeOpp } from '../db/helpers';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, recordingLogger } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

// Thousands digit of the defindex -> category; 5xxx avoids the currencies (5000-5002, 5021).
const CATS: Category[] = ['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'unusuals', 'taunts', 'other'];
const categoryOfDefindex = (d: number): Category => CATS[Math.floor(d / 1000) - 1] ?? 'other';

function world() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const log = recordingLogger();
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  // Names repeat, so ties on Pay up to fall to the name and then the SKU.
  const schema = createStubSchema({ items: [], categoryOf: categoryOfDefindex, nameOf: (s) => `Item ${Number(s.split(';')[0]) % 5}` });
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
  let marketPushes = 0;
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings, log),
    schema,
    timers,
    keyPrice,
    onChanged: () => {
      marketPushes++;
      banks.invalidate('market');
    },
    folderWatchActive: () => false,
  });
  const scraptfList = createScraptfListCache({ repo, log, keyPrice });
  const banks = createBanksSummary({
    clock,
    log,
    repo,
    market,
    scraptfList,
    settings: () => settings,
    folderWatch: () => ({ active: false, error: null }),
    timers,
    categoryOf: (sku) => marketCategoryOf(schema, sku),
  });
  const heard: number[] = [];
  banks.onChanged(() => heard.push(clock.now()));
  const card = (bank: ScraptfBank) => banks.summary(clock.now()).banks.find((b) => b.bank === bank)!;
  return { repo, clock, timers, log, market, banks, heard, card, marketPushes: () => marketPushes };
}

let seq = 0;
function buyers(sku: string, scrap: number, n = 2): Listing[] {
  return Array.from({ length: n }, () => {
    seq++;
    return makeListing({ id: `m${seq}`, sku, baseSku: sku, steamid: `M${seq}`, metalScrap: scrap, lastEventAt: T0 - MIN });
  });
}

describe('banks over the Live market', () => {
  it("gives every bank exactly the shared bankLookFor over the market's Not checked rows", () => {
    const h = world();
    const listings: Listing[] = [];
    // 8 categories x 30 bases; Pay up to repeats every 6 bases, names every 5: many ties.
    for (let c = 1; c <= 8; c++) {
      for (let i = 0; i < 30; i++) {
        const defindex = c * 1000 + 100 + i;
        listings.push(...buyers(`${defindex};6`, i % 6 === 5 ? 1 : 40 + (i % 6) * 15));
      }
    }
    h.repo.upsertListings(listings);
    // Prices of yours check some rows.
    for (const d of [1100, 1101, 3105, 7107]) h.repo.upsertScrapPrice({ sku: `${d};6`, name: 'Priced', costScrap: 30, source: 'user', observedAt: T0 });
    h.market.start();
    h.timers.advance(0);
    expect(h.market.stats().building).toBe(false);

    const rows = h.market.all({ verdicts: ['unchecked'] }, h.clock.now());
    expect(rows.length).toBe(8 * 30 - 4);
    const r = h.banks.summary(h.clock.now());
    for (const info of SCRAPTF_BANKS) {
      const b = r.banks.find((x) => x.bank === info.bank)!;
      // 0.7.4 (F36): a row is the bank's whose scrap.tf button opens that page.
      expect({ unchecked: b.unchecked, lookFor: b.lookFor }, info.bank).toEqual(bankLookFor(rows, info.categories, info.bank));
    }
    // Taunts and other, one taunt priced; 0.7.4 (F36): and the 30 killstreak-category items, which carry no
    // kit target (killstreak weapons, sold on /buy/items: /buy/killstreaks sells kits only).
    expect(r.banks.find((b) => b.bank === 'items')!.unchecked).toBe(89);
    expect(r.banks.find((b) => b.bank === 'killstreaks')!.unchecked).toBe(0);
    expect(r.banks.find((b) => b.bank === 'hats')!.lookFor).toHaveLength(5);
  });

  it('moves the cards as core invalidates them: a saved page, its flips, a price of yours, a new buyer', () => {
    const h = world();
    h.repo.upsertListings([...buyers('1100;6', 120), ...buyers('1101;6', 90), ...buyers('2100;6', 80)]);
    h.market.start();
    h.timers.advance(0);
    expect(h.card('hats')).toMatchObject({ lastSavedAt: null, unchecked: 2, lookFor: [{ sku: '1100;6' }, { sku: '1101;6' }] });

    // A saved hats page with the 1100 hat (importSavedPage: batch, price, then ctx.pricesChanged).
    const batch = h.repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: T0 - 2 * MIN, importedAt: T0, itemCount: 1, categories: { hats: 1 }, bank: 'hats' });
    const price = h.repo.upsertScrapPrice({ sku: '1100;6', name: 'Item 0', costScrap: 20, source: 'import', observedAt: T0 - 2 * MIN, importBatch: batch, stock: 2 });
    h.market.pricesChanged();
    h.banks.invalidate();
    expect(h.card('hats')).toMatchObject({ lastSavedAt: T0 - 2 * MIN, pages: 1, items: 1, inStock: 1, flips: 0, unchecked: 1, lookFor: [{ sku: '1101;6' }] });

    // The engine's opportunity for it, about a second later.
    h.repo.upsertOpportunities([makeOpp({ sku: '1100;6', name: 'Item 0', inputRef: `price:${price.id}`, inputKind: 'import', status: 'profitable', profitScrap: 70 })]);
    h.banks.invalidate('flips');
    expect(h.card('hats')).toMatchObject({ flips: 1, flipProfitScrap: 70, top: [{ sku: '1100;6', profitScrap: 70 }] });

    // A new buyer on a weapon: the market pushes, the weapons card's lookFor follows.
    const pushes = h.marketPushes();
    h.repo.upsertListings(buyers('2101;6', 200));
    h.market.markDirty(['2101;6']);
    h.timers.advance(2_000);
    expect(h.marketPushes()).toBeGreaterThan(pushes);
    expect(h.card('weapons')).toMatchObject({ unchecked: 2, lookFor: [{ sku: '2101;6' }, { sku: '2100;6' }] });
    // Every change was told, throttled.
    h.timers.advance(2_000);
    expect(h.heard.length).toBeGreaterThan(0);
    expect(h.heard.every((t, i) => i === 0 || t - h.heard[i - 1]! >= 2_000)).toBe(true);
  });
});
