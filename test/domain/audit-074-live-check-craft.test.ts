// 0.7.4 (audit F41): scrap.tf marks a Non-Craftable copy only with the card's or row's "uncraft" class, which no
// copied text carries, so a copied /items row, a plain name or F19's hinted price resolved to the Craftable SKU
// and was judged against Craftable buyers: false flips (A Distinctive Lack of Hue +52.22 ref against a 2 keys
// 22 ref Craftable order), "Flip:" notifications, and Save price / Bought it writing the Craftable SKU. A plain
// name is now checked as the copy the user's saved scrap.tf data matches (the list rows proven for each copy,
// the bank pages' newest saves): its Non-Craftable twin when only that one matches, and, undecided, the copy
// that sells for less with a fixed note, no Save price, no Bought it and no notification. A SKU, an item link
// or a name saying its craftability is checked as written; kits and the Taunt Unusualifier are unchanged.
// The schema is TF2's own item data (test/fixtures/pricedb/schema-subset.json). Local data only: nothing here
// touches scrap.tf or any network.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flipNotification } from '../../src/main/liveCheck';
import { checkActions, checkBoughtInput, checkQuickEntryParams, checkSaveInput } from '../../src/renderer/checkModel';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createLiveCheck, parseCheckText, type ParsedCheck } from '../../src/service/domain/liveCheck';
import { createMarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import {
  CHECK_CRAFT_TWIN_NOTE,
  CHECK_CRAFT_UNSURE_NOTE,
  checkCraftCopy,
  checkCraftTwinOf,
  checkCraftUndecided,
  checkHintedNote,
  checkListCopyPrices,
  checkTextStatesCraft,
  checkWorseCopy,
} from '../../src/shared/check';
import type { BankStockStored, CheckHint, CheckResult, CheckSource, Listing, ScraptfBank, ScraptfListRow, ScraptfListStored } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, makeDeps, makeListing, noNetwork, silentLogger, testSettings } from './helpers';

const HUE = 'A Distinctive Lack of Hue';
const CRAFT = '5040;6';
const TWIN = '5040;6;uncraftable';
/** scrap.tf's price for the Non-Craftable card on the user's own save: 1 key, 43.22 refined. */
const CARD = { keys: 1, scrap: 389 };
const ROW = `${HUE}\t1 key, 43.22 refined\t1 key, 37 refined\t4/25`;

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function ok(text: string): ParsedCheck {
  const r = parseCheckText(text, (t) => schema.resolve(t));
  if (!r.ok) throw new Error(`expected an item, got ${r.status}: ${r.reason}`);
  return r.parsed;
}

function card(sku: string, price: { keys: number; scrap: number } = CARD, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: sku === TWIN ? `Non-Craftable ${HUE}` : HUE, costKeys: price.keys, costScrap: price.scrap, stock: 2, assetId: null, ...over };
}

function listRow(sku: string, craft: ScraptfListStored['craft'], price: { keys: number; scrap: number } = CARD, over: Partial<ScraptfListStored> = {}): ScraptfListStored {
  return { sku, name: HUE, sellsKeys: price.keys, sellsScrap: price.scrap, paysKeys: 1, paysScrap: 333, stock: 4, stockLimit: 25, batchId: 1, observedAt: 0, craft, ...over };
}

async function setup(opts: { craftableBuyers?: number[]; twinBuyers?: number[] } = {}) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const clock = new FakeClock();
  const now = clock.now();
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: now });
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
  // Craftable buyers at 2 keys 22 ref (the Herpatron's order), Non-Craftable ones just under the card's price.
  const buyer = (sku: string, keys: number, metalScrap: number, i: number): Listing =>
    makeListing({ id: `${sku}-${i}`, steamid: `${sku}-${i}`, sku, baseSku: sku, keys, metalScrap, itemName: sku === TWIN ? `Non-Craftable ${HUE}` : HUE, lastEventAt: now - MIN, userOnline: true });
  repo.upsertListings([
    ...(opts.craftableBuyers ?? [198, 197, 196]).map((m, i) => buyer(CRAFT, 2, m, i)),
    ...(opts.twinBuyers ?? [386, 385, 384]).map((m, i) => buyer(TWIN, 1, m, i)),
  ]);
  market.start();
  await timers.advance(0);
  const lc = createLiveCheck({ repo, schema: real, log: silentLogger, settings: () => settings, keyPrice, market, scraptfList: list, bankStock: stock });
  const h = {
    repo,
    now,
    stock,
    /** A save of a bank page the user made (what importSavedPage writes), 10 minutes ago unless `at` says. */
    bankSave(rows: BankStockStored[], bank: ScraptfBank = 'items', at = now - 10 * MIN, page = bank === 'list' ? '/items' : '/buy/items') {
      const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
      repo.insertBankStock(id, bank, rows, page);
      stock.refresh();
    },
    list(rows: ScraptfListStored[]) {
      repo.upsertScraptfList(rows.map((r) => ({ ...r, observedAt: now - 20 * MIN })));
      list.refresh();
    },
    check: (text: string, source: CheckSource = 'manual', hint?: CheckHint): CheckResult => lc.check(text, source, now, hint),
  };
  return h;
}

describe('which copy a plain copied name is (pure rules)', () => {
  it('says the copy only for a SKU, an item link or a craftability word anywhere in the name', () => {
    for (const t of [CRAFT, TWIN, 'https://backpack.tf/stats/Unique/A%20Distinctive%20Lack%20of%20Hue/Tradable/Craftable', `Craftable ${HUE}`, `Non-Craftable ${HUE}`, `Strange Non-Craftable ${HUE}`, `Uncraftable ${HUE}`, `Non Craftable ${HUE}`]) {
      expect(checkTextStatesCraft(t), t).toBe(true);
    }
    for (const t of [HUE, 'Team Captain', 'Strange Professional Killstreak Rocket Launcher', 'Mann Co. Supply Crate Series #30']) expect(checkTextStatesCraft(t), t).toBe(false);
    // As the parser keeps it: the flag only, from the item part of each form.
    expect(ok(ROW)).toMatchObject({ form: 'items-row', item: { sku: CRAFT }, craftStated: false });
    expect(ok(HUE)).toMatchObject({ form: 'name', craftStated: false });
    expect(ok(`${HUE}, 1 key 43.22 ref`)).toMatchObject({ form: 'priced', craftStated: false });
    expect(ok(`${HUE}\n1 key, 43.22 refined`)).toMatchObject({ form: 'two-lines', craftStated: false });
    expect(ok(`Non-Craftable ${ROW}`)).toMatchObject({ form: 'items-row', item: { sku: TWIN }, craftStated: true });
    expect(ok(`${CRAFT}, 1 key 43.22 ref`)).toMatchObject({ form: 'priced', item: { sku: CRAFT }, craftStated: true });
  });

  it('twins a Craftable SKU only, keeping its other parts; never a kit, a Non-Craftable SKU or junk', () => {
    expect(checkCraftTwinOf(CRAFT)).toBe(TWIN);
    expect(checkCraftTwinOf('200;11;kt-3;festive')).toBe('200;11;uncraftable;kt-3;festive');
    expect(checkCraftTwinOf('378;6;p3100495')).toBe('378;6;uncraftable;p3100495');
    for (const sku of [TWIN, '6527;6;kt-3;td-205', '20003;6;od-6526;oq-6', 'not a sku', '']) expect(checkCraftTwinOf(sku), sku).toBeNull();
  });

  it('takes a list row as evidence only when it is proven for that very copy and has something to buy', () => {
    const row = (over: Partial<ScraptfListRow>): ScraptfListRow => ({ sku: TWIN, name: HUE, sellsKeys: 1, sellsScrapRaw: 389, sellsScrap: 956, paysKeys: null, paysScrapRaw: null, paysScrap: null, stock: 4, stockLimit: 25, full: false, observedAt: 0, craft: 'uncraftable', ...over });
    expect(checkListCopyPrices(row({}), 'uncraftable')).toEqual([CARD]);
    expect(checkListCopyPrices(row({ sku: CRAFT, craft: 'craftable' }), 'craftable')).toEqual([CARD]);
    expect(checkListCopyPrices(row({ craft: 'uncraftable' }), 'craftable')).toEqual([]);
    expect(checkListCopyPrices(row({ sku: CRAFT, craft: 'any' }), 'craftable')).toEqual([]);
    expect(checkListCopyPrices(row({ sku: CRAFT, craft: 'any', match: 'family' }), 'uncraftable')).toEqual([]);
    expect(checkListCopyPrices(row({ stock: 0 }), 'uncraftable')).toEqual([]);
    expect(checkListCopyPrices(row({ sellsScrapRaw: null, sellsScrap: null }), 'uncraftable')).toEqual([]);
    expect(checkListCopyPrices(null, 'uncraftable')).toEqual([]);
  });

  it('lets a copied price that only one copy is on sale at decide, else what is on sale', () => {
    const other = { keys: 2, scrap: 0 };
    expect(checkCraftCopy({ price: CARD, craftable: [], twin: [CARD] })).toBe('twin');
    expect(checkCraftCopy({ price: CARD, craftable: [other], twin: [CARD] })).toBe('twin');
    expect(checkCraftCopy({ price: other, craftable: [other], twin: [CARD] })).toBe('keep');
    expect(checkCraftCopy({ price: CARD, craftable: [CARD], twin: [CARD] })).toBe('unsure');
    expect(checkCraftCopy({ price: { keys: 3, scrap: 0 }, craftable: [other], twin: [CARD] })).toBe('unsure');
    // 0.7.4 (R21): a copied price no saved copy is at decides nothing (scrap.tf may have listed the other copy since).
    expect(checkCraftCopy({ price: { keys: 3, scrap: 0 }, craftable: [], twin: [CARD] })).toBe('unsure');
    expect(checkCraftCopy({ price: CARD, craftable: [other], twin: [] })).toBe('unknown');
    expect(checkCraftCopy({ price: null, craftable: [], twin: [CARD] })).toBe('twin');
    expect(checkCraftCopy({ price: null, craftable: [other], twin: [CARD] })).toBe('unsure');
    expect(checkCraftCopy({ price: null, craftable: [other], twin: [] })).toBe('keep');
    // Nothing saved at all: as before 0.7.4.
    expect(checkCraftCopy({ price: CARD, craftable: [], twin: [] })).toBe('keep');
    // 0.7.4 (R20): only a family /items row on sale (a row for every copy) decides nothing, priced or not.
    expect(checkCraftCopy({ price: CARD, craftable: [], twin: [], familyOnSale: true })).toBe('unknown');
    expect(checkCraftCopy({ price: null, craftable: [], twin: [], familyOnSale: true })).toBe('unknown');
    // Proven evidence still decides over it.
    expect(checkCraftCopy({ price: CARD, craftable: [CARD], twin: [], familyOnSale: true })).toBe('keep');
    expect(checkCraftCopy({ price: null, craftable: [], twin: [CARD], familyOnSale: true })).toBe('twin');
  });

  it('picks the copy that sells for less: the worse verdict, then the lower profit, then the lower revenue', () => {
    const r = (verdict: CheckResult['verdict'], profitScrap: number | null, revenueScrap: number | null) =>
      ({ verdict, profitScrap, revenue: revenueScrap === null ? null : { revenueScrap } }) as Pick<CheckResult, 'verdict' | 'profitScrap' | 'revenue'>;
    const flip = r('flip', 100, 900);
    const over = r('over', -3, 800);
    expect(checkWorseCopy(flip, over)).toBe(over);
    expect(checkWorseCopy(over, flip)).toBe(over);
    expect(checkWorseCopy(r('flip', 50, 900), flip)).toEqual(r('flip', 50, 900));
    expect(checkWorseCopy(r('no-price', null, 900), r('no-price', null, 700))).toEqual(r('no-price', null, 700));
    expect(checkWorseCopy(r('no-buyers', null, null), r('no-price', null, 700))).toEqual(r('no-buyers', null, null));
    const a = r('over', -3, 800);
    expect(checkWorseCopy(a, r('over', -3, 800))).toBe(a);
  });
});

describe('BankStock.pricesFor (the bank pages\' newest saves, for the Live check)', () => {
  it('gives the prices this very copy is on sale at, bank pages only, newest saves only, each with its bank', async () => {
    const h = await setup();
    expect(h.stock.pricesFor(TWIN)).toEqual([]);
    // An older save of the page that had the card, then the newest without it: gone, so no price.
    h.bankSave([card(TWIN)], 'items', h.now - 3 * 60 * MIN);
    expect(h.stock.pricesFor(TWIN)).toEqual([{ ...CARD, bank: 'items' }]);
    h.bankSave([card(CRAFT, { keys: 2, scrap: 0 })], 'items', h.now - 2 * 60 * MIN);
    expect(h.stock.pricesFor(TWIN)).toEqual([]);
    expect(h.stock.pricesFor(CRAFT)).toEqual([{ keys: 2, scrap: 0, bank: 'items' }]);
    // Sold out (stock 0) is not on sale; the /items list's own save says nothing of one copy.
    h.bankSave([card(TWIN, CARD, { stock: 0 }), card(CRAFT, { keys: 2, scrap: 0 })]);
    expect(h.stock.pricesFor(TWIN)).toEqual([]);
    h.bankSave([card(TWIN)], 'list');
    expect(h.stock.pricesFor(TWIN)).toEqual([]);
    // Another bank's page has it: counted, named by its bank. A page far older than its bank's newest (DM-5) is not.
    h.bankSave([card(TWIN, { keys: 1, scrap: 380 })], 'hats', h.now - 5 * MIN, '/buy/hats');
    expect(h.stock.pricesFor(TWIN)).toEqual([{ keys: 1, scrap: 380, bank: 'hats' }]);
    h.bankSave([card(TWIN, { keys: 1, scrap: 300 })], 'items', h.now - 5 * 24 * 60 * MIN, '/buy/items/2');
    expect(h.stock.pricesFor(TWIN)).toEqual([{ keys: 1, scrap: 380, bank: 'hats' }]);
    expect(h.stock.pricesFor('not a sku')).toEqual([]);
  });
});

describe('the Live check of a copy whose text does not say its craftability (real schema, repo, market, list and bank stock)', () => {
  it('F41: the Non-Craftable card on the user\'s bank save makes the copied /items row the Non-Craftable copy, not a +52 ref flip', async () => {
    const h = await setup();
    // Before: no saved scrap.tf data at all, the Craftable copy as written (a flip against its 2 keys 22 ref order).
    const before = h.check(ROW, 'watch');
    expect(before).toMatchObject({ status: 'item', sku: CRAFT, verdict: 'flip', reason: null });

    // The /items row says nothing (a family row), and the user's /buy/items save shows only the Non-Craftable card.
    h.list([listRow(CRAFT, 'any')]);
    h.bankSave([card(TWIN)]);
    for (const source of ['watch', 'hotkey', 'manual'] as const) {
      const r = h.check(ROW, source);
      expect(r, source).toMatchObject({ status: 'item', sku: TWIN, name: `Non-Craftable ${HUE}`, price: { keys: 1, scrapRaw: 389, source: 'clipboard' }, stock: 4, stockLimit: 25 });
      expect(r.verdict, source).not.toBe('flip');
      expect(r.reason).toBe(CHECK_CRAFT_TWIN_NOTE);
      expect(flipNotification(r)).toBeNull();
      // Save price and Bought it write the copy it was checked as.
      expect(checkSaveInput(r, h.now)).toMatchObject({ sku: TWIN, costKeys: 1, costScrap: 389 });
      expect(checkBoughtInput(r)).toMatchObject({ sku: TWIN, keys: 1, scrap: 389 });
    }
    // Every copied form of the plain name, and the name alone (no copied price: the twin is the one on sale).
    expect(h.check(`${HUE}, 1 key 43.22 ref`)).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_TWIN_NOTE });
    expect(h.check(`${HUE}\n1 key, 43.22 refined`)).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_TWIN_NOTE });
    expect(h.check(HUE)).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_TWIN_NOTE });
  });

  it('F41: a price copied after "Open on scrap.tf" from the Craftable row is matched to the copy the bank save has (F19)', async () => {
    const h = await setup();
    h.bankSave([card(TWIN)]);
    const r = h.check('1 key, 43.22 ref', 'hotkey', { sku: CRAFT });
    expect(r).toMatchObject({ status: 'item', sku: TWIN, price: { keys: 1, scrapRaw: 389, source: 'clipboard' } });
    expect(r.verdict).not.toBe('flip');
    // 0.7.4: the hinted note names the item the user opened (the armed Craftable SKU), not the twin that answers;
    // the twin note follows it and says which copy was checked.
    expect(r.reason).toBe(`${checkHintedNote(HUE)} ${CHECK_CRAFT_TWIN_NOTE}`);
  });

  it('F41: the list rows proven for each copy decide too, by the copied price when both are listed', async () => {
    const h = await setup();
    // The /items page marks the Non-Craftable row (its "uncraft" class), so the row is keyed and proven so.
    h.list([listRow(TWIN, 'uncraftable')]);
    expect(h.check(ROW)).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_TWIN_NOTE });
    // Both rows listed, at different prices: the copied price says which.
    h.list([listRow(TWIN, 'uncraftable'), listRow(CRAFT, 'craftable', { keys: 2, scrap: 0 })]);
    expect(h.check(ROW)).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_TWIN_NOTE });
    const craftRow = h.check(`${HUE}\t2 keys\t1 key, 37 refined\t4/25`);
    expect(craftRow).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
  });

  it('F41: undecided (both copies on sale at the copied price) answers with the copy that sells for less, and nothing acts on it', async () => {
    const h = await setup();
    h.bankSave([card(TWIN), card(CRAFT)]);
    const r = h.check(ROW, 'watch');
    // The Non-Craftable book pays less: that is the answer, never the Craftable book alone.
    expect(r).toMatchObject({ status: 'item', sku: TWIN, price: { source: 'clipboard', scrapRaw: 389 }, reason: CHECK_CRAFT_UNSURE_NOTE });
    expect(r.verdict).not.toBe('flip');
    expect(checkCraftUndecided(r)).toBe(true);
    const actions = checkActions(r);
    expect(actions.save.enabled).toBe(false);
    expect(actions.bought.enabled).toBe(false);
    expect(checkSaveInput(r, h.now)).toBeNull();
    expect(checkBoughtInput(r)).toBeNull();
    expect(checkQuickEntryParams(r)).toEqual({ sku: TWIN });
    expect(flipNotification(r)).toBeNull();
  });

  it('F41: undecided but a flip whichever copy it is still shows the flip, and still sends no notification', async () => {
    // Non-Craftable buyers well above the card price too (1 key 560 scrap), still below the Craftable ones.
    const h = await setup({ twinBuyers: [560, 559, 558] });
    h.bankSave([card(TWIN), card(CRAFT)]);
    const r = h.check(ROW, 'watch');
    expect(r).toMatchObject({ status: 'item', sku: TWIN, verdict: 'flip', reason: CHECK_CRAFT_UNSURE_NOTE });
    expect(flipNotification(r)).toBeNull();
    // The same answer from the name alone (no copied price: both on sale).
    expect(h.check(HUE)).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE });
  });

  it('F41: a copied price that only the Craftable card is at keeps the Craftable copy, with no note', async () => {
    const h = await setup();
    h.bankSave([card(TWIN), card(CRAFT, { keys: 2, scrap: 0 })]);
    expect(h.check(`${HUE}, 2 keys`)).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    expect(h.check(`${HUE}, 1 key 43.22 ref`)).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_TWIN_NOTE });
  });

  it('keeps a SKU, an item link and a name saying its craftability as written, whatever the saves hold', async () => {
    const h = await setup();
    h.bankSave([card(TWIN)]);
    expect(h.check(`${CRAFT}, 1 key 43.22 ref`)).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    expect(h.check(`Non-Craftable ${HUE}, 1 key 43.22 ref`)).toMatchObject({ sku: TWIN, reason: null });
    expect(h.check(`https://backpack.tf/stats/Unique/A%20Distinctive%20Lack%20of%20Hue/Tradable/Craftable, 1 key 43.22 ref`)).toMatchObject({ sku: CRAFT, reason: null });
  });

  it('ignores the /items list in the bank saves, and never takes a family row for the Craftable copy (R20)', async () => {
    const h = await setup();
    // An /items save keyed as every copy (bank 'list'): no evidence either way.
    h.bankSave([card(CRAFT)], 'list');
    expect(h.check(ROW)).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    // 0.7.4 (R20): the family row (one row for every copy) is no Craftable evidence either: with the twin trading,
    // the copied row is undecided and answers with the copy that sells for less, never a +41.77 ref Craftable flip.
    h.list([listRow(CRAFT, 'any')]);
    const r = h.check(ROW, 'watch');
    expect(r).toMatchObject({ status: 'item', sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE, price: { keys: 1, scrapRaw: 389, source: 'clipboard' } });
    expect(r.verdict).not.toBe('flip');
    expect(checkCraftUndecided(r)).toBe(true);
    expect(flipNotification(r)).toBeNull();
    expect(checkActions(r).save.enabled).toBe(false);
    expect(checkActions(r).bought.enabled).toBe(false);
    expect(checkSaveInput(r, h.now)).toBeNull();
    expect(checkBoughtInput(r)).toBeNull();
    // With the Non-Craftable card on a bank page it is the twin: the list save does not count for the Craftable copy.
    h.bankSave([card(TWIN)]);
    expect(h.check(ROW)).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_TWIN_NOTE });
  });

  it('decides a painted copy by its own painted cards, never by the list\'s plain rows', async () => {
    const h = await setup();
    const PAINT = 3100495;
    const painted = `378;6;p${PAINT}`;
    // The list prices plain copies: its proven Non-Craftable row says nothing of a painted one.
    h.list([listRow('378;6;uncraftable', 'uncraftable')]);
    expect(h.check('1 key, 43.22 ref', 'hotkey', { sku: painted })).toMatchObject({ status: 'item', sku: painted });
    h.bankSave([card('378;6;uncraftable', CARD, { specialKey: bankStockSpecialKey({ paint: PAINT }), name: 'Non-Craftable Team Captain' })]);
    expect(h.check('1 key, 43.22 ref', 'hotkey', { sku: painted })).toMatchObject({ status: 'item', sku: `378;6;uncraftable;p${PAINT}` });
  });

  it('leaves the Taunt Unusualifier and kits as before (their craftability is the import\'s)', async () => {
    const h = await setup();
    h.bankSave([card('9258;5;uncraftable;td-1157', { keys: 6, scrap: 0 }), card('6527;6;uncraftable;kt-3;td-205', { keys: 3, scrap: 0 })]);
    // A Craftable unusualifier armed as is (a SKU from the app): no twin for 9258.
    expect(h.check('6 keys', 'hotkey', { sku: '9258;5;td-1157' })).toMatchObject({ sku: '9258;5;td-1157' });
    expect(h.check('6 keys', 'hotkey', { sku: '9258;5;td-1157' }).reason).not.toContain(CHECK_CRAFT_TWIN_NOTE);
    // A kit keeps its own SKU.
    expect(h.check('3 keys', 'hotkey', { sku: '6527;6;kt-3;td-205' })).toMatchObject({ sku: '6527;6;kt-3;td-205' });
  });
});
