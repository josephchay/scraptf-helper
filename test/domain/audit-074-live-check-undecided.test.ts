// 0.7.4 review (R20, R21, R14, R22): what the Live check still read as the Craftable copy, or notified, after F41.
// - R20: a copied scrap.tf/items row of an item whose saved row is a family row (one row for every copy, 'any')
//   was judged against Craftable buyers: "An Extraordinary Abundance of Tinge" and "A Distinctive Lack of Hue"
//   gave a +37 to +42 ref "Flip:" while scrap.tf most likely held the Non-Craftable copy. Now undecided when the
//   Non-Craftable twin trades (the copy that sells for less, no Save price, no Bought it, no notification), and
//   the Craftable copy as before when only it trades.
// - R21: a copied price no saved copy is at decided by what the saves had on sale: a Craftable card read as the
//   Non-Craftable twin (Save price then replaced the twin's typed price), a Non-Craftable card as a Craftable flip.
// - R14: the Live check now runs the engine's cost check (costSanity against the age-gated PriceDB rows): capped
//   at Low, a fixed note, and no "Flip:" notification.
// - R22: a flip on a revenue order not seen for 24 h ('unverified') is shown, never notified.
// Real schema fixture (test/fixtures/pricedb/schema-subset.json), in-memory repo, market, list and bank stock.
// Local data only: nothing here touches scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import { flipNotification } from '../../src/main/liveCheck';
import { checkActions, checkBoughtInput, checkSaveInput } from '../../src/renderer/checkModel';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createLiveCheck } from '../../src/service/domain/liveCheck';
import { createMarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import {
  CHECK_COST_BELOW_MARKET_NOTE,
  CHECK_COST_VARIANT_NOTE,
  CHECK_CRAFT_UNSURE_NOTE,
  checkCostSuspect,
  checkCraftUndecided,
  checkRevenueUnverified,
} from '../../src/shared/check';
import type { BankStockStored, CheckResult, CheckSource, Listing, PricedbRow, ScraptfBank, ScraptfListStored } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, HOUR, MIN, makeDeps, makeListing, noNetwork, silentLogger, testSettings } from './helpers';

const K = 567;
const HUE = 'A Distinctive Lack of Hue';
const CRAFT = '5040;6';
const TWIN = '5040;6;uncraftable';
/** scrap.tf's Non-Craftable card on the user's save: 1 key, 43.22 refined. */
const CARD = { keys: 1, scrap: 389 };
const ROW = `${HUE}\t1 key, 43.22 refined\t1 key, 37 refined\t4/25`;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function card(sku: string, price: { keys: number; scrap: number } = CARD): BankStockStored {
  return { sku, specialKey: '', name: sku === TWIN ? `Non-Craftable ${HUE}` : HUE, costKeys: price.keys, costScrap: price.scrap, stock: 2, assetId: null };
}

function listRow(sku: string, craft: ScraptfListStored['craft'], over: Partial<ScraptfListStored> = {}): ScraptfListStored {
  return { sku, name: HUE, sellsKeys: CARD.keys, sellsScrap: CARD.scrap, paysKeys: 1, paysScrap: 333, stock: 4, stockLimit: 25, batchId: 1, observedAt: 0, craft, ...over };
}

async function setup(opts: { craftableBuyers?: number[]; twinBuyers?: number[]; seenAgo?: number; pricedb?: (sec: number) => PricedbRow[] } = {}) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const clock = new FakeClock();
  const now = clock.now();
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: now });
  if (opts.pricedb) repo.upsertPricedb(opts.pricedb(Math.floor(now / 1000)));
  const timers = new FakeTimers(clock);
  const settings = testSettings();
  let list!: ScraptfListCache;
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow());
  list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
  const real = createSchemaService(schemaDeps(schemaRoute(), { repo }));
  await real.init();
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    http: noNetwork,
    schema: real,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    scraptfList: list,
  });
  const stock = createBankStock({ clock, log: silentLogger, repo, market, keyPrice, settings: () => settings, categoryOf: () => 'other' });
  const seenAt = now - (opts.seenAgo ?? MIN);
  // Craftable buyers at 2 keys 22 ref (the Herpatron's order), Non-Craftable ones just under the card's price.
  const buyer = (sku: string, keys: number, metalScrap: number, i: number): Listing =>
    makeListing({ id: `${sku}-${i}`, steamid: `${sku}-${i}`, sku, baseSku: sku, keys, metalScrap, itemName: sku === TWIN ? `Non-Craftable ${HUE}` : HUE, lastEventAt: seenAt, userOnline: true });
  repo.upsertListings([
    ...(opts.craftableBuyers ?? [198, 197, 196]).map((m, i) => buyer(CRAFT, 2, m, i)),
    ...(opts.twinBuyers ?? [386, 385, 384]).map((m, i) => buyer(TWIN, 1, m, i)),
  ]);
  market.start();
  await timers.advance(0);
  const lc = createLiveCheck({ repo, schema: real, log: silentLogger, settings: () => settings, keyPrice, market, scraptfList: list, bankStock: stock });
  return {
    now,
    /** A save of a bank page the user made (what importSavedPage writes), `ago` before now. */
    bankSave(rows: BankStockStored[], ago = 10 * MIN, bank: ScraptfBank = 'items') {
      const at = now - ago;
      const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
      repo.insertBankStock(id, bank, rows, '/buy/items');
      stock.refresh();
    },
    list(rows: ScraptfListStored[]) {
      repo.upsertScraptfList(rows.map((r) => ({ ...r, observedAt: now - 20 * MIN })));
      list.refresh();
    },
    check: (text: string, source: CheckSource = 'watch'): CheckResult => lc.check(text, source, now),
  };
}

/** Nothing acts on the result: no notification, no Save price, no Bought it. */
function expectNothingActs(r: CheckResult, now: number): void {
  expect(flipNotification(r)).toBeNull();
  expect(checkActions(r).save.enabled).toBe(false);
  expect(checkActions(r).bought.enabled).toBe(false);
  expect(checkSaveInput(r, now)).toBeNull();
  expect(checkBoughtInput(r)).toBeNull();
}

describe('R20: a family /items row is never the Craftable copy', () => {
  it('copied from the watcher with the twin trading: undecided, the copy that sells for less, nothing acts on it', async () => {
    const h = await setup();
    h.list([listRow(CRAFT, 'any')]);
    for (const text of [ROW, `${HUE}\t1 key, 43.22 refined\t1 key, 37 refined\t4/25\n`, HUE]) {
      const r = h.check(text);
      expect(r, text).toMatchObject({ status: 'item', sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE });
      expect(r.verdict, text).not.toBe('flip');
      expect(checkCraftUndecided(r)).toBe(true);
      expectNothingActs(r, h.now);
    }
  });

  it('keeps the Craftable copy as before when only it trades (an ordinary item is not shown as "no buyers")', async () => {
    const h = await setup({ twinBuyers: [] });
    h.list([listRow(CRAFT, 'any')]);
    const r = h.check(ROW);
    expect(r).toMatchObject({ status: 'item', sku: CRAFT, reason: null, verdict: 'flip' });
    expect(flipNotification(r)).not.toBeNull();
  });

  it('keeps the Craftable copy for a proven Craftable row, and a sold-out family row is no evidence', async () => {
    const h = await setup();
    h.list([listRow(CRAFT, 'craftable')]);
    expect(h.check(ROW)).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    h.list([listRow(CRAFT, 'any', { stock: 0 })]);
    expect(h.check(`${HUE}, 1 key 43.22 ref`)).toMatchObject({ sku: CRAFT, reason: null });
  });
});

describe('R21: a copied price no saved copy is at decides nothing', () => {
  it('S2: only the Craftable card saved (2 keys), the Non-Craftable card copied: undecided, no "Flip:"', async () => {
    const h = await setup();
    h.bankSave([card(CRAFT, { keys: 2, scrap: 0 })]);
    const r = h.check(`${HUE}\n1 key, 43.22 refined`);
    expect(r).toMatchObject({ status: 'item', sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE });
    expect(r.verdict).not.toBe('flip');
    expectNothingActs(r, h.now);
    // The Craftable card's own price still keeps the Craftable copy.
    expect(h.check(`${HUE}\n2 keys`)).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
  });

  it('S1: only the Non-Craftable card saved, a month ago, a Craftable price copied: undecided, Save price cannot overwrite the twin', async () => {
    const h = await setup();
    h.bankSave([card(TWIN)], 30 * 24 * HOUR);
    const r = h.check(`${HUE}\n2 keys`, 'hotkey');
    expect(r).toMatchObject({ status: 'item', reason: CHECK_CRAFT_UNSURE_NOTE });
    expectNothingActs(r, h.now);
    // The twin's own saved price still decides the twin (the F41 fix).
    expect(h.check(`${HUE}\n1 key, 43.22 refined`, 'hotkey')).toMatchObject({ sku: TWIN });
  });

  it('a repriced Craftable card whose twin has no buyers keeps the Craftable copy as before', async () => {
    const h = await setup({ twinBuyers: [] });
    h.bankSave([card(CRAFT, { keys: 2, scrap: 0 })]);
    const r = h.check(`${HUE}\n1 key, 43.22 refined`);
    expect(r).toMatchObject({ status: 'item', sku: CRAFT, reason: null, verdict: 'flip' });
  });
});

describe('R14: the price against PriceDB (the engine\'s cost check)', () => {
  // PriceDB as on the audited profile: Craftable 2 keys 76 to 2 keys 213, Non-Craftable 1 key 333 to 1 key 392.
  const hue = (sec: number, age = 0): PricedbRow[] => [
    { sku: CRAFT, name: HUE, buyKeys: 2, buyScrap: 76, sellKeys: 2, sellScrap: 213, time: sec - age, fetchedAt: (sec - age) * 1000 },
    { sku: TWIN, name: `Non-Craftable ${HUE}`, buyKeys: 1, buyScrap: 333, sellKeys: 1, sellScrap: 392, time: sec - age, fetchedAt: (sec - age) * 1000 },
  ];

  it('a price that matches the other copy on PriceDB: shown, capped at Low, noted, never a "Flip:"', async () => {
    const h = await setup({ pricedb: (sec) => hue(sec) });
    // The SKU says the copy, so only the cost check speaks.
    const r = h.check(`${CRAFT}, 1 key 43.22 ref`);
    expect(r).toMatchObject({ status: 'item', sku: CRAFT, verdict: 'flip', confidenceLevel: 'low' });
    expect(r.reason).toBe(CHECK_COST_VARIANT_NOTE);
    expect(r.confidence).toBeLessThanOrEqual(44);
    expect(checkCostSuspect(r)).toBe(true);
    expect(flipNotification(r)).toBeNull();
  });

  it('a price well under the PriceDB buy price: noted below market, no "Flip:"; a fair price is not', async () => {
    const h = await setup({ pricedb: (sec) => hue(sec).slice(0, 1) });
    const low = h.check(`${CRAFT}, 2 keys`);
    expect(low.reason).toBe(CHECK_COST_BELOW_MARKET_NOTE);
    expect(flipNotification(low)).toBeNull();
    const fair = h.check(`${CRAFT}, 2 keys 75 scrap`);
    expect(fair.reason).toBeNull();
  });

  it('ignores PriceDB rows past profit.referenceMaxAgeMs, as the engine does', async () => {
    const h = await setup({ pricedb: (sec) => hue(sec, 60 * 24 * 3600) });
    const r = h.check(`${CRAFT}, 1 key 43.22 ref`);
    expect(r.reason).toBeNull();
    expect(flipNotification(r)).not.toBeNull();
  });
});

describe('R22: a flip on an unverified revenue order is never notified', () => {
  it('orders not seen for 30 h: still a flip in the popup, no "Flip:" notification; seen a minute ago it notifies', async () => {
    const stale = await setup({ seenAgo: 30 * HOUR });
    const r = stale.check(`${CRAFT}, 1 key 43.22 ref`);
    expect(r).toMatchObject({ status: 'item', verdict: 'flip' });
    expect(r.revenue?.order?.flags).toContain('unverified');
    expect(checkRevenueUnverified(r)).toBe(true);
    expect(flipNotification(r)).toBeNull();
    const fresh = await setup();
    const f = fresh.check(`${CRAFT}, 1 key 43.22 ref`);
    expect(checkRevenueUnverified(f)).toBe(false);
    expect(flipNotification(f)).not.toBeNull();
  });
});
