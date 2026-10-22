// 0.7.4 review (follow-up to R21): R21 made a copied price that matches no saved copy undecided whenever only the
// Craftable copy was saved and the Non-Craftable twin had any buy order. That also caught the ordinary case: the
// user saved /buy/hats with Team Captain at 1.33 ref, scrap.tf repriced it to 1.44 ref, and the copied card (or a
// price copied after "Open on scrap.tf") answered as the Non-Craftable copy, with no "Flip:" notification and no
// Save price or Bought it, although with nothing saved the same copy was a +11.88 ref Craftable flip. scrap.tf's
// hats, weapons, stranges, unusuals and skins pages list no Non-Craftable copies (in the user's saved pages every
// Non-Craftable card is on /buy/items or /buy/killstreaks), so a repriced card there is the Craftable copy again;
// a /buy/items or /buy/killstreaks card, a proven /items row (which may be any bank's item) and a family /items row
// stay undecided as R20 and R21 made them (the Non-Craftable Hue catch). Side fix: a hinted check's note names the
// item the user opened, also when its Non-Craftable twin answers.
// Real schema fixture, in-memory repo, market, list and bank stock; the mock's judge over the same shared rules.
// Local data only: nothing here touches scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import { flipNotification } from '../../src/main/liveCheck';
import { checkActions, checkBoughtInput, checkSaveInput } from '../../src/renderer/checkModel';
import { mockCheckResult, mockJudgeCheck, type MockParsedCheck } from '../../src/renderer/mockCheck';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createLiveCheck } from '../../src/service/domain/liveCheck';
import { createMarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import {
  CHECK_CRAFT_TWIN_NOTE,
  CHECK_CRAFT_UNSURE_NOTE,
  CHECK_NONCRAFT_BANKS,
  checkCraftCopy,
  checkCraftUndecided,
  checkHintedNote,
  type CheckCopyPrice,
} from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { fromString } from '../../src/shared/sku';
import type { BankStockStored, CheckHint, CheckResult, CheckSource, ItemDetail, Listing, ResolvedItem, ScraptfBank, ScraptfListRow, ScraptfListStored } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, HOUR, MIN, makeDeps, makeListing, noNetwork, silentLogger, testSettings } from './helpers';

const K = 567;
const CRAFT = '378;6';
const TWIN = '378;6;uncraftable';
/** The card as the user saved it: 1.33 ref. */
const SAVED = { keys: 0, scrap: 12 };
/** What scrap.tf shows now: 1.44 ref. */
const COPY = 'Team Captain\n1.44 refined';
/** The banks that list no Non-Craftable copies in the user's saved pages. */
const CRAFT_ONLY_BANKS: readonly ScraptfBank[] = ['hats', 'weapons', 'stranges', 'unusuals', 'skins'];

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function card(sku: string, price: { keys: number; scrap: number } = SAVED): BankStockStored {
  return { sku, specialKey: '', name: sku === TWIN ? 'Non-Craftable Team Captain' : 'Team Captain', costKeys: price.keys, costScrap: price.scrap, stock: 2, assetId: null };
}

function listRow(sku: string, craft: ScraptfListStored['craft'], price: { keys: number; scrap: number } = SAVED): ScraptfListStored {
  return { sku, name: 'Team Captain', sellsKeys: price.keys, sellsScrap: price.scrap, paysKeys: 0, paysScrap: 9, stock: 2, stockLimit: 12, batchId: 1, observedAt: 0, craft };
}

/** Craftable bot buyers at 13.33 ref seen a minute ago; Non-Craftable ones at 5 ref, `twinAgo` ago (none when `twin` is empty). */
async function setup(opts: { twin?: number[]; twinAgo?: number } = {}) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const clock = new FakeClock();
  const now = clock.now();
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: now });
  const timers = new FakeTimers(clock);
  const settings = testSettings();
  let list!: ScraptfListCache;
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow());
  list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
  const schema = createSchemaService(schemaDeps(schemaRoute(), { repo }));
  await schema.init();
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    http: noNetwork,
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    scraptfList: list,
  });
  const stock = createBankStock({ clock, log: silentLogger, repo, market, keyPrice, settings: () => settings, categoryOf: () => 'hats' });
  const buyer = (sku: string, metalScrap: number, i: number, ago: number): Listing =>
    makeListing({ id: `${sku}-${i}`, steamid: `${sku}-${i}`, sku, baseSku: sku, keys: 0, metalScrap, itemName: sku === TWIN ? 'Non-Craftable Team Captain' : 'Team Captain', lastEventAt: now - ago, userOnline: true, isBot: true });
  repo.upsertListings([...[120, 119, 118].map((m, i) => buyer(CRAFT, m, i, MIN)), ...(opts.twin ?? [45, 44, 43]).map((m, i) => buyer(TWIN, m, i, opts.twinAgo ?? MIN))]);
  market.start();
  await timers.advance(0);
  const lc = createLiveCheck({ repo, schema, log: silentLogger, settings: () => settings, keyPrice, market, scraptfList: list, bankStock: stock });
  return {
    now,
    /** A save of one bank page (what importSavedPage writes), `ago` before now. */
    bankSave(rows: BankStockStored[], bank: ScraptfBank, ago = 10 * MIN) {
      const at = now - ago;
      const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
      repo.insertBankStock(id, bank, rows, `/buy/${bank}`);
      stock.refresh();
    },
    list(rows: ScraptfListStored[]) {
      repo.upsertScraptfList(rows.map((r) => ({ ...r, observedAt: now - 20 * MIN })));
      list.refresh();
    },
    check: (text: string, source: CheckSource = 'watch', hint?: CheckHint): CheckResult => lc.check(text, source, now, hint),
  };
}

/** The Craftable copy, acted on as before: a flip, notified, Save price and Bought it on and writing 378;6. */
function expectCraftableFlip(r: CheckResult, now: number, label = ''): void {
  expect(r, label).toMatchObject({ status: 'item', sku: CRAFT, verdict: 'flip', price: { keys: 0, scrapRaw: 13, source: 'clipboard' } });
  expect(checkCraftUndecided(r), label).toBe(false);
  expect(flipNotification(r), label).toMatchObject({ sku: CRAFT });
  expect(checkActions(r).save.enabled, label).toBe(true);
  expect(checkActions(r).bought.enabled, label).toBe(true);
  expect(checkSaveInput(r, now), label).toMatchObject({ sku: CRAFT, costKeys: 0, costScrap: 13 });
  expect(checkBoughtInput(r), label).toMatchObject({ sku: CRAFT, keys: 0, scrap: 13 });
}

/** Undecided as R21 made it: the Non-Craftable copy answers (it sells for less), and nothing acts on it. */
function expectUndecided(r: CheckResult, now: number, label = ''): void {
  expect(r, label).toMatchObject({ status: 'item', sku: TWIN });
  expect(checkCraftUndecided(r), label).toBe(true);
  expect(flipNotification(r), label).toBeNull();
  expect(checkActions(r).save.enabled, label).toBe(false);
  expect(checkActions(r).bought.enabled, label).toBe(false);
  expect(checkSaveInput(r, now), label).toBeNull();
  expect(checkBoughtInput(r), label).toBeNull();
}

describe('checkCraftCopy: a saved Craftable card at another price (pure rule)', () => {
  const now = { keys: 0, scrap: 13 };
  const at = (bank?: ScraptfBank): CheckCopyPrice => (bank === undefined ? { ...SAVED } : { ...SAVED, bank });

  it('keeps the Craftable copy for a card of a page that lists no Non-Craftable copies', () => {
    expect([...CHECK_NONCRAFT_BANKS].sort()).toEqual(['items', 'killstreaks']);
    for (const bank of CRAFT_ONLY_BANKS) expect(checkCraftCopy({ price: now, craftable: [at(bank)], twin: [] }), bank).toBe('keep');
    expect(checkCraftCopy({ price: now, craftable: [at('hats'), at('stranges')], twin: [] })).toBe('keep');
  });

  it('stays undecided-if-the-twin-trades for /buy/items and /buy/killstreaks cards and for list evidence (no bank)', () => {
    for (const bank of ['items', 'killstreaks', 'list'] as const) expect(checkCraftCopy({ price: now, craftable: [at(bank)], twin: [] }), bank).toBe('unknown');
    expect(checkCraftCopy({ price: now, craftable: [at()], twin: [] })).toBe('unknown');
    // One price from a page that lists Non-Craftable copies is enough to leave room for one.
    expect(checkCraftCopy({ price: now, craftable: [at('hats'), at('items')], twin: [] })).toBe('unknown');
    expect(checkCraftCopy({ price: now, craftable: [at('hats'), at()], twin: [] })).toBe('unknown');
  });

  it('leaves every other R20/R21 answer as it was', () => {
    // A twin on sale still makes a price at neither copy undecided, whatever the Craftable card's bank.
    expect(checkCraftCopy({ price: now, craftable: [at('hats')], twin: [{ keys: 0, scrap: 5, bank: 'items' }] })).toBe('unsure');
    // The card's own price, or no price, keeps it; a family row alone is still 'unknown'; nothing saved keeps it.
    expect(checkCraftCopy({ price: SAVED, craftable: [at('items')], twin: [] })).toBe('keep');
    expect(checkCraftCopy({ price: null, craftable: [at('items')], twin: [] })).toBe('keep');
    expect(checkCraftCopy({ price: now, craftable: [], twin: [], familyOnSale: true })).toBe('unknown');
    expect(checkCraftCopy({ price: now, craftable: [], twin: [] })).toBe('keep');
  });
});

describe('the Live check of a repriced Craftable card (real schema, repo, market, list and bank stock)', () => {
  it('a /buy/hats card saved at 1.33 ref, copied at 1.44 ref: the Craftable flip, notified, as with nothing saved', async () => {
    const h = await setup();
    const before = h.check(COPY);
    expectCraftableFlip(before, h.now, 'nothing saved');
    h.bankSave([card(CRAFT)], 'hats');
    const r = h.check(COPY);
    expectCraftableFlip(r, h.now, 'hats save');
    expect(r).toMatchObject({ reason: null, profitScrap: before.profitScrap });
    // The card's own price as before, and the hotkey and a typed check alike.
    expect(h.check('Team Captain\n1.33 refined')).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    expectCraftableFlip(h.check('Team Captain, 1.44 ref', 'hotkey'), h.now, 'hotkey');
    expectCraftableFlip(h.check('Team Captain, 1.44 ref', 'manual'), h.now, 'typed');
  });

  it('the same for a card saved on /buy/weapons, /buy/stranges, /buy/unusuals or /buy/skins', async () => {
    for (const bank of CRAFT_ONLY_BANKS) {
      const h = await setup();
      h.bankSave([card(CRAFT)], bank);
      expectCraftableFlip(h.check(COPY), h.now, bank);
    }
  });

  it('a price copied after "Open on scrap.tf" on the Craftable row is that copy, and the note names it', async () => {
    const h = await setup();
    h.bankSave([card(CRAFT)], 'hats');
    const r = h.check('1.44 ref', 'watch', { sku: CRAFT });
    expectCraftableFlip(r, h.now, 'hinted');
    expect(r.reason).toBe(checkHintedNote(r.name!));
  });

  it('days-old Non-Craftable orders and a three-day-old save change nothing', async () => {
    const h = await setup({ twinAgo: 5 * 24 * HOUR });
    h.bankSave([card(CRAFT)], 'hats', 3 * 24 * HOUR);
    expectCraftableFlip(h.check(COPY), h.now, 'stale twin');
  });

  it('keeps R21: a /buy/items or /buy/killstreaks card repriced is still undecided while the twin trades', async () => {
    for (const bank of ['items', 'killstreaks'] as const) {
      const h = await setup();
      h.bankSave([card(CRAFT)], bank);
      const r = h.check(COPY);
      expectUndecided(r, h.now, bank);
      expect(r.reason).toBe(CHECK_CRAFT_UNSURE_NOTE);
      // With the card's own price, the Craftable copy as before.
      expect(h.check('Team Captain\n1.33 refined')).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    }
    // A hats card beside a repriced /buy/items one leaves room for the other copy too.
    const both = await setup();
    both.bankSave([card(CRAFT)], 'hats');
    both.bankSave([card(CRAFT, { keys: 0, scrap: 11 })], 'items');
    expectUndecided(both.check(COPY), both.now, 'hats and items');
  });

  it('keeps R20/R21 for /items rows: a proven Craftable row at another price, and a family row, are undecided', async () => {
    const proven = await setup();
    proven.list([listRow(CRAFT, 'craftable')]);
    expectUndecided(proven.check(COPY), proven.now, 'proven row');
    const family = await setup();
    family.list([listRow(CRAFT, 'any', { keys: 0, scrap: 13 })]);
    const row = family.check('Team Captain\t1.44 refined\t1 ref\t2/12');
    expectUndecided(row, family.now, 'family row');
    expect(row.reason).toBe(CHECK_CRAFT_UNSURE_NOTE);
    // With no Non-Craftable buyers the Craftable copy is kept, as before.
    const lone = await setup({ twin: [] });
    lone.list([listRow(CRAFT, 'any', { keys: 0, scrap: 13 })]);
    expect(lone.check('Team Captain\t1.44 refined\t1 ref\t2/12')).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
  });

  it('names the item the user opened in the hinted note when the Non-Craftable twin answers', async () => {
    const h = await setup();
    const craftName = h.check(CRAFT).name!;
    expect(craftName).not.toMatch(/Non-Craftable/);
    // Undecided (a /buy/items card at another price): the twin answers, the note names the Craftable item opened.
    h.bankSave([card(CRAFT)], 'items');
    const unsure = h.check('1.44 ref', 'watch', { sku: CRAFT });
    expectUndecided(unsure, h.now, 'hinted undecided');
    expect(unsure.name).toMatch(/Non-Craftable/);
    expect(unsure.reason).toBe(`${checkHintedNote(craftName)} ${CHECK_CRAFT_UNSURE_NOTE}`);
    // Decided as the twin (only its card is at the copied price): the same note, then the twin note.
    h.bankSave([card(TWIN, { keys: 0, scrap: 13 })], 'items');
    const twin = h.check('1.44 ref', 'hotkey', { sku: CRAFT });
    expect(twin).toMatchObject({ sku: TWIN, reason: `${checkHintedNote(craftName)} ${CHECK_CRAFT_TWIN_NOTE}` });
  });
});

describe('mockJudgeCheck over bank-tagged prices (the mock, same shared rules)', () => {
  const NAME = 'Team Captain';
  const item = (sku: string): ResolvedItem => ({ sku, name: NAME, skuObject: fromString(sku), category: 'hats', match: 'exact', warnings: [] });
  const parsed = (over: Partial<MockParsedCheck> = {}): MockParsedCheck => ({
    item: item(CRAFT),
    price: { keys: 0, scrap: 13, display: '1.44 ref', ambiguous: false },
    pays: null,
    paysCopied: false,
    stock: null,
    stockLimit: null,
    soldOut: false,
    craftStated: false,
    priceAmbiguous: false,
    ...over,
  });
  // Craftable buyers pay 120, Non-Craftable ones 45.
  const detail = (sku: string) => {
    const rev = sku === TWIN ? 45 : 120;
    return { name: sku === TWIN ? `Non-Craftable ${NAME}` : NAME, category: 'hats', scraptfList: null, scrapPrices: [], links: [], revenue: { revenueScrap: rev, maxCostScrap: rev - 10 } } as unknown as ItemDetail;
  };
  const listRowOf = (sku: string, craft: ScraptfListRow['craft']): ScraptfListRow => ({ sku, name: NAME, sellsKeys: 0, sellsScrapRaw: 13, sellsScrap: 13, paysKeys: null, paysScrapRaw: null, paysScrap: null, stock: 2, stockLimit: 12, full: false, observedAt: 0, craft });
  const judge = (banks: Record<string, CheckCopyPrice[]>, a: { p?: MockParsedCheck; list?: Record<string, ScraptfListRow>; hinted?: boolean } = {}) =>
    mockJudgeCheck({
      parsed: a.p ?? parsed(),
      source: 'watch',
      listRowFor: (s) => a.list?.[s] ?? null,
      bankPricesFor: (s) => banks[s] ?? [],
      evaluate: (p, craftNote) =>
        mockCheckResult({
          id: 1,
          source: 'watch',
          now: 0,
          parsed: p,
          detail: detail(p.item.sku),
          keyScrap: K,
          settings: DEFAULT_SETTINGS,
          confidence: { value: 80, level: 'high' },
          hinted: a.hinted === true,
          // As mock.ts passes it: the armed item's name when the twin answers.
          hintedName: a.hinted === true && p.item.sku !== CRAFT ? NAME : null,
          craftNote,
        }),
    });

  it('keeps a repriced /buy/hats card the Craftable copy, acted on as before', () => {
    const r = judge({ [CRAFT]: [{ ...SAVED, bank: 'hats' }] });
    expect(r).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    expect(flipNotification(r)).not.toBeNull();
    expect(checkActions(r).save.enabled).toBe(true);
    expect(checkActions(r).bought.enabled).toBe(true);
  });

  it('keeps a /buy/items card, an untagged price and a family row undecided, as the service', () => {
    for (const banks of [{ [CRAFT]: [{ ...SAVED, bank: 'items' as const }] }, { [CRAFT]: [{ ...SAVED }] }]) {
      const r = judge(banks);
      expect(r).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE });
      expect(checkActions(r).save.enabled).toBe(false);
    }
    expect(judge({}, { list: { [CRAFT]: listRowOf(CRAFT, 'any') } })).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE });
  });

  it('names the armed item in the hinted note when the twin answers', () => {
    const r = judge({ [CRAFT]: [{ ...SAVED, bank: 'items' }] }, { hinted: true });
    expect(r).toMatchObject({ sku: TWIN, reason: `${checkHintedNote(NAME)} ${CHECK_CRAFT_UNSURE_NOTE}` });
    expect(judge({ [CRAFT]: [{ ...SAVED, bank: 'hats' }] }, { hinted: true })).toMatchObject({ sku: CRAFT, reason: checkHintedNote(NAME) });
  });
});
