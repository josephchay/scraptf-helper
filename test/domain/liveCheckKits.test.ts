// 0.7.2: killstreak kits in the Live check. scrap.tf titles a kit "Professional Rocket Launcher Kit" (no
// "Killstreak"), which names no TF2 item, so a copied kit title was "No TF2 item recognised". It now
// resolves as Steam names that kit, keyed Non-Craftable exactly as the saved-page import keys the card
// ("6526;6;uncraftable;kt-3;td-205"), so the check meets the import's stored prices, list row and buy
// orders. Steam's and backpack.tf's own form ("Professional Killstreak Rocket Launcher Kit", backpack.tf's
// Craftable kit) is resolved as written. A kit always carries a sheen (and a killstreaker): that alone no
// longer makes its stored price "a painted or spelled copy" (CHECK_EXTRAS_NOTE), which suppressed the
// flip notification and 'Bought it'. Of a look's copies (one per combo, all at the page's time) the check
// takes the cheapest at its key price, as the Live market row does. The schema is TF2's own item data
// (test/fixtures/pricedb/schema-subset.json: every kit named just "Kit"), not a stub. Nothing here touches
// scrap.tf or any network.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import {
  CHECK_EXTRAS_NOTE,
  CHECK_MAX_RESOLVES,
  createLiveCheck,
  newestStoredPrice,
  parseCheckText,
  storedPriceHasExtras,
  type LiveCheck,
  type ParseCheckResult,
  type ParsedCheck,
} from '../../src/service/domain/liveCheck';
import { createMarketIndex, type MarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import { parseScrapTfHtml } from '../../src/service/import/scraptfHtml';
import { CHECK_NOT_ITEM_REASON, checkPriceIsOtherCopy } from '../../src/shared/check';
import { fromString } from '../../src/shared/sku';
import type { CheckResult, Listing, ResolvedItem, ScrapPrice, ScraptfListStored } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, makeListing, noNetwork, silentLogger, special, testSettings } from './helpers';

const KIT = '6526;6;uncraftable;kt-3;td-205';
const CRAFTABLE_KIT = '6526;6;kt-3;td-205';
const SPEC_MEDIGUN_KIT = '6523;6;uncraftable;kt-2;td-211';
const FABRICATOR = '20003;6;kt-3;td-205;od-6526;oq-6';
const PAINT = 3100495;

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function ok(r: ParseCheckResult): ParsedCheck {
  if (!r.ok) throw new Error(`expected an item, got ${r.status}: ${r.reason}`);
  return r.parsed;
}

/** As createLiveCheck parses: the schema's resolver, fuzzy guesses confirmed by a unique search hit. */
const parseWith = (s: SchemaService, text: string) =>
  parseCheckText(text, (t) => s.resolve(t), { confirmFuzzy: (t, i) => s.search(t, 2).length === 1 && s.search(t, 2)[0]!.sku === i.sku });
const parse = (text: string) => parseWith(schema, text);

describe("parseCheckText: scrap.tf's kit titles (real schema)", () => {
  it.each<[string, string, Partial<ParsedCheck>]>([
    ['Professional Rocket Launcher Kit', KIT, { form: 'name', price: null }],
    ['  professional ROCKET launcher kit ', KIT, { form: 'name', price: null }],
    ['Specialized Medi Gun Kit', SPEC_MEDIGUN_KIT, { form: 'name' }],
    ['Basic Scattergun Kit', '6527;6;uncraftable;kt-1;td-200', { form: 'name' }],
    ['Non-Craftable Professional Rocket Launcher Kit', KIT, { form: 'name' }],
    ['Professional Black Box Kit', '6526;6;uncraftable;kt-3;td-228', { form: 'name' }],
    // With the price copied along, as the card's indicator or "Costs" line shows it.
    ['Professional Rocket Launcher Kit 37 keys, 40 ref', KIT, { form: 'priced', price: { keys: 37, scrap: 360 } }],
    ['Professional Rocket Launcher Kit, 37 keys, 40 refined', KIT, { form: 'priced', price: { keys: 37, scrap: 360 } }],
    ['Professional Rocket Launcher Kit = 35 keys', KIT, { form: 'priced', price: { keys: 35, scrap: 0 } }],
    ['Specialized Medi Gun Kit 2 keys', SPEC_MEDIGUN_KIT, { form: 'priced', price: { keys: 2, scrap: 0 } }],
    ['Professional Rocket Launcher Kit\n37 keys, 40 ref', KIT, { form: 'two-lines', price: { keys: 37, scrap: 360 } }],
    // A copied /items row (the import keys its kit rows the same way).
    ['Professional Rocket Launcher Kit\t37 keys\t30 keys\t1/5', KIT, { form: 'items-row', price: { keys: 37, scrap: 0 }, pays: { keys: 30, scrap: 0 }, stock: 1, stockLimit: 5 }],
    // A fabricator keeps its own craftability, as the import keys it.
    ['Professional Rocket Launcher Kit Fabricator', FABRICATOR, { form: 'name' }],
    ['Non-Craftable Professional Rocket Launcher Kit Fabricator', '20003;6;uncraftable;kt-3;td-205;od-6526;oq-6', { form: 'name' }],
  ])('reads %j as %s, the SKU the import stores', (text, sku, want) => {
    expect(ok(parse(text))).toMatchObject({ item: { sku, match: 'exact' }, fuzzy: false, incomplete: false, ...want });
  });

  it("resolves Steam's and backpack.tf's own form as written (backpack.tf's Craftable kit), never reinterpreted", () => {
    expect(ok(parse('Professional Killstreak Rocket Launcher Kit'))).toMatchObject({ form: 'name', item: { sku: CRAFTABLE_KIT } });
    expect(ok(parse('Professional Killstreak Rocket Launcher Kit, 40 keys'))).toMatchObject({ form: 'priced', item: { sku: CRAFTABLE_KIT }, price: { keys: 40, scrap: 0 } });
    expect(ok(parse('Non-Craftable Professional Killstreak Rocket Launcher Kit'))).toMatchObject({ item: { sku: KIT } });
    expect(ok(parse('Killstreak Scattergun Kit'))).toMatchObject({ item: { sku: '6527;6;kt-1;td-200' } });
  });

  it('agrees with the saved-page import on the same title', () => {
    const page = (title: string, defindex: number) =>
      '<!DOCTYPE html>\n<!-- saved from url=(0031)https://scrap.tf/buy/killstreaks -->\n<html><head><title>Buy Killstreaks</title></head><body>' +
      `<div class="item hoverable quality6 fx1 fx2008 app440" data-id="1" data-defindex="${defindex}" data-title="${title}" data-content="Sheen: Team Shine<br/>Killstreaker: Hypno-Beam" data-item-value="23411" data-num-available="1"><div class="item-value-indicator">37 keys, 40 ref</div></div>` +
      '</body></html>';
    for (const [title, defindex] of [
      ['Professional Rocket Launcher Kit', 6526],
      ['Specialized Medi Gun Kit', 6523],
      ['Basic Scattergun Kit', 6527],
      ['Professional Black Box Kit', 6526],
      ['Professional Rocket Launcher Kit Fabricator', 20003],
    ] as const) {
      const imported = parseScrapTfHtml(page(title, defindex), schema).items[0]!.sku;
      expect(imported, title).not.toBeNull();
      expect(ok(parse(title)).item.sku, title).toBe(imported);
    }
    // 0.7.3: a Taunt Unusualifier on /buy/items, titled with Steam's Craftable name and keyed Non-Craftable.
    const itemsPage = (title: string) =>
      '<!DOCTYPE html>\n<!-- saved from url=(0026)https://scrap.tf/buy/items -->\n<html><head><title>Buy Items</title></head><body>' +
      `<div class="item hoverable quality5 rarity app440" data-id="1" data-defindex="9258" data-title="<span class='quality5'>${title}</span>" data-content="Level 5" data-item-value="3384"><div class="item-value-indicator">6 keys</div></div>` +
      '</body></html>';
    for (const title of ['Unusual Taunt: Kazotsky Kick Unusualifier', 'Unusual Taunt: The Schadenfreude Unusualifier']) {
      const imported = parseScrapTfHtml(itemsPage(title), schema).items[0]!.sku;
      expect(imported, title).toMatch(/^9258;5;uncraftable;td-\d+$/);
      expect(ok(parse(title)).item.sku, title).toBe(imported);
    }
  });

  it('answers not-item for a kit title naming no weapon the schema knows, or a word that would make it another item', () => {
    for (const t of ['Professional Original Kit', 'Professional Rocket Launcherr Kit', 'Professional Kit', 'Scattergun Kit', 'Professional Australium Rocket Launcher Kit', 'Professional Strange Rocket Launcher Kit']) {
      expect(parse(t), t).toEqual({ ok: false, status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
    }
  });

  it("prefers the kit over a closest-match guess for scrap.tf's form, and keeps an exact match of the text itself", () => {
    const guess: ResolvedItem = { sku: '205;6', name: 'Rocket Launcher', skuObject: fromString('205;6'), category: 'weapons', match: 'fuzzy', warnings: ['No exact item named "x"; using the closest match "Rocket Launcher"'] };
    const guessing = (t: string) => (t === 'Professional Rocket Launcher Kit' ? guess : schema.resolve(t));
    expect(ok(parseCheckText('Professional Rocket Launcher Kit', guessing, { confirmFuzzy: () => true }))).toMatchObject({ item: { sku: KIT }, fuzzy: false });
    // A name the resolver knows exactly (here, learned from a listing) is never second-guessed.
    const exact: ResolvedItem = { ...guess, sku: '6526;6;kt-3;td-205', skuObject: fromString('6526;6;kt-3;td-205'), match: 'exact', warnings: [] };
    const spy = vi.fn((t: string) => (t === 'Professional Rocket Launcher Kit' ? exact : schema.resolve(t)));
    expect(ok(parseCheckText('Professional Rocket Launcher Kit', spy))).toMatchObject({ item: { sku: '6526;6;kt-3;td-205' } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses a reading of Steam's name that is only a guess or names no weapon, even with a confirmed guess", () => {
    const reading = (sku: string, match: ResolvedItem['match'], warnings: string[] = []): ResolvedItem => ({ sku, name: 'Kit', skuObject: fromString(sku), category: 'weapons', match, warnings });
    for (const r of [reading(KIT, 'fuzzy', ['No exact item named "x"; using the closest match "Kit"']), reading('6526;6;uncraftable;kt-3', 'exact')]) {
      const resolve = (t: string) => (t === 'Non-Craftable Professional Killstreak Rocket Launcher Kit' ? r : null);
      expect(parseCheckText('Professional Rocket Launcher Kit', resolve, { confirmFuzzy: () => true }), r.sku).toEqual({ ok: false, status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
    }
  });

  it('never reads the kit at another tier through a mis-tiered learned name, as the import does', async () => {
    const deps = schemaDeps(schemaRoute());
    deps.repo.upsertBptfNames([{ sku: '6526;6;uncraftable;kt-1;td-205', name: 'Non-Craftable Professional Killstreak Rocket Launcher Kit', marketName: null, lastSeen: 1 }]);
    const learned = createSchemaService(deps);
    await learned.init();
    // 0.7.4 (F72): the schema's exact parse comes first, so the learned kt-1 row no longer decides (it was refused before).
    expect(ok(parseWith(learned, 'Professional Rocket Launcher Kit'))).toMatchObject({ item: { sku: '6526;6;uncraftable;kt-3;td-205' } });
  });

  it('asks the resolver a second time only for text in the kit form, within the one budget', () => {
    const spy = vi.fn((t: string) => schema.resolve(t));
    ok(parseCheckText('Team Captain, 1 ref', spy));
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.filter(([t]) => /Killstreak/.test(t))).toEqual([]);
    spy.mockClear();
    ok(parseCheckText('Professional Rocket Launcher Kit', spy));
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['Professional Rocket Launcher Kit', 'Non-Craftable Professional Killstreak Rocket Launcher Kit']);
    const none = vi.fn(() => null);
    parseCheckText('Professional Rocket Launcher Kit, Specialized Medi Gun Kit, Professional Knife Kit, Basic Pistol Kit 1 ref', none);
    expect(none.mock.calls.length).toBeLessThanOrEqual(CHECK_MAX_RESOLVES);
  });
});

describe('the clean-copy test ignores a sheen and killstreaker', () => {
  const p = (id: number, observedAt: number, over: Partial<ScrapPrice> = {}): ScrapPrice => ({
    id,
    sku: KIT,
    name: 'Non-Craftable Professional Killstreak Rocket Launcher Kit',
    costKeys: 37,
    costScrap: 360,
    source: 'import',
    observedAt,
    note: null,
    importBatch: null,
    special: null,
    assetId: null,
    stock: null,
    ...over,
  });

  it('storedPriceHasExtras: a sheen or killstreaker alone is plain; paint, spells, parts and a custom name or description are not', () => {
    expect(storedPriceHasExtras(p(1, 1, { special: special({ sheen: 1, killstreaker: 2008 }) }))).toBe(false);
    expect(storedPriceHasExtras(p(1, 1, { special: special({ sheen: 3 }) }))).toBe(false);
    expect(storedPriceHasExtras(p(1, 1, { special: special({ killstreaker: 2002 }) }))).toBe(false);
    expect(storedPriceHasExtras(p(1, 1, { sku: '378;6', special: special({ paint: PAINT }) }))).toBe(true);
    expect(storedPriceHasExtras(p(1, 1, { sku: `378;6;p${PAINT}` }))).toBe(true);
    expect(storedPriceHasExtras(p(1, 1, { sku: '205;11;kt-3', special: special({ sheen: 1, killstreaker: 2008, spells: ['Exorcism'] }) }))).toBe(true);
    expect(storedPriceHasExtras(p(1, 1, { sku: '205;11;kt-3', special: special({ sheen: 1, parts: ['Kills'] }) }))).toBe(true);
    expect(storedPriceHasExtras(p(1, 1, { sku: '378;6', special: special({ customName: true }) }))).toBe(true);
    expect(storedPriceHasExtras(p(1, 1, { sku: '378;6', special: special({ customDesc: true }) }))).toBe(true);
  });

  it("newestStoredPrice: a kit's own copies are plain (of one look the cheapest, as the Live market picks), a spelled one is not", () => {
    // As importSavedPage stores a page: one row per sheen/killstreaker combo, all at the page's time.
    const page = [p(1, 9, { special: special({ sheen: 1, killstreaker: 2008 }) }), p(2, 9, { special: special({ sheen: 4, killstreaker: 2003 }) })];
    expect(newestStoredPrice(page, true)?.id).toBe(2);
    // The cheapest copy at the key price, whichever was stored last; equal costs keep the higher id (above).
    const cheap = p(0, 9, { costKeys: 20, costScrap: 0, special: special({ sheen: 3, killstreaker: 2005 }) });
    expect(newestStoredPrice([cheap, ...page], true)?.id).toBe(0);
    // 11 000 scrap against 20 keys: cheaper at 567 a key, dearer at 500.
    const metal = p(3, 9, { costKeys: 0, costScrap: 11_000, special: special({ sheen: 2, killstreaker: 2003 }) });
    expect(newestStoredPrice([cheap, metal, ...page], true, 567)?.id).toBe(3);
    expect(newestStoredPrice([cheap, metal, ...page], true, 500)?.id).toBe(0);
    // A newer look wins over a cheaper copy of an older one.
    expect(newestStoredPrice([cheap, p(4, 10)], true)?.id).toBe(4);
    const weapon = { sku: '205;11;kt-3' };
    const spelled = p(3, 10, { ...weapon, special: special({ sheen: 1, killstreaker: 2008, spells: ['Exorcism'] }) });
    expect(newestStoredPrice([p(1, 9, { ...weapon, special: special({ sheen: 2, killstreaker: 2002 }) }), spelled], true)?.id).toBe(1);
    expect(newestStoredPrice([spelled], true)?.id).toBe(3);
  });
});

describe('the Live check on a kit (real schema, repo, list cache and market index)', () => {
  interface Harness {
    repo: Repo;
    list: ScraptfListCache;
    market: MarketIndex;
    lc: LiveCheck;
    K(): number;
    check(text: string): CheckResult;
  }

  async function setup(): Promise<Harness> {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const settings = testSettings();
    let list!: ScraptfListCache;
    const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow());
    list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
    // The schema reads names it learned from listings out of the same database, as core wires it.
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
    market.start();
    await timers.advance(0);
    const lc = createLiveCheck({ repo, schema: real, log: silentLogger, settings: () => settings, keyPrice, market, scraptfList: list });
    return { repo, list, market, lc, K: () => keyPrice().valueScrap, check: (text) => lc.check(text, 'manual', clock.now()) };
  }

  const buyer = (sku: string, keys: number, i: number, over: Partial<Listing> = {}): Listing =>
    makeListing({ id: `kit-${sku}-${i}`, steamid: `KIT${i}`, sku, baseSku: sku, keys, metalScrap: 0, itemName: 'Kit', lastEventAt: T0 - MIN, ...over });

  /**
   * A /buy/killstreaks page's kit rows as importSavedPage stores them: one per combo, at the page's time.
   * The cheaper is stored first, so a pick by id alone would take the dearer.
   */
  function importedKitPage(repo: Repo): void {
    for (const [sheen, killstreaker, keys, scrap] of [
      [4, 2003, 35, 0],
      [1, 2008, 37, 360],
    ] as const) {
      repo.upsertScrapPrice({ sku: KIT, name: 'Non-Craftable Professional Killstreak Rocket Launcher Kit', costKeys: keys, costScrap: scrap, source: 'import', observedAt: T0 - 5 * MIN, special: special({ sheen, killstreaker }) });
    }
  }

  it("checks a copied kit title against the import's stored price and the kit's buy orders, with no other-copy note", async () => {
    const h = await setup();
    importedKitPage(h.repo);
    h.repo.upsertListings([0, 1, 2].map((i) => buyer(KIT, 45 - i, i, { userOnline: true })));
    h.market.pricesChanged();
    const r = h.check('Professional Rocket Launcher Kit');
    // The page's cheapest combo, as the Live market's row shows it (not the one stored last).
    expect(r).toMatchObject({ status: 'item', sku: KIT, reason: null, price: { keys: 35, scrapRaw: 0, source: 'import', observedAt: T0 - 5 * MIN }, verdict: 'flip' });
    expect(r.revenue!.eligibleCount).toBe(3);
    expect(checkPriceIsOtherCopy(r)).toBe(false);
    expect(h.market.all({}, T0).find((row) => row.sku === KIT)?.knownCostScrap).toBe(r.price!.valueScrap);
  });

  it("values a look's copies at the check's key price, as the Live market row does", async () => {
    const h = await setup();
    // 11 000 scrap against 20 keys: the all-metal card is the cheaper at this key price, not at the default 540.
    expect(h.K()).toBeGreaterThan(550);
    for (const [keys, scrap, sheen] of [
      [0, 11_000, 2],
      [20, 0, 3],
    ] as const) {
      h.repo.upsertScrapPrice({ sku: KIT, name: 'Non-Craftable Professional Killstreak Rocket Launcher Kit', costKeys: keys, costScrap: scrap, source: 'import', observedAt: T0 - 5 * MIN, special: special({ sheen, killstreaker: 2003 }) });
    }
    h.repo.upsertListings([buyer(KIT, 30, 0)]);
    h.market.pricesChanged();
    const r = h.check('Professional Rocket Launcher Kit');
    expect(r).toMatchObject({ sku: KIT, price: { keys: 0, scrapRaw: 11_000, valueScrap: 11_000, source: 'import' }, reason: null });
    expect(h.market.all({}, T0).find((row) => row.sku === KIT)?.knownCostScrap).toBe(11_000);
  });

  it('checks a copied kit title with its price, and takes the saved list row keyed the same way', async () => {
    const h = await setup();
    importedKitPage(h.repo);
    expect(h.check('Professional Rocket Launcher Kit 37 keys, 40 ref')).toMatchObject({
      status: 'item',
      sku: KIT,
      reason: null,
      price: { keys: 37, scrapRaw: 360, valueScrap: 37 * h.K() + 360, source: 'clipboard' },
    });
    // 0.7.4: a kit row is keyed Non-Craftable as the import keys every kit, so it is proven to price that copy.
    const row: ScraptfListStored = { sku: KIT, name: 'Professional Rocket Launcher Kit', sellsKeys: 36, sellsScrap: 0, paysKeys: 30, paysScrap: 0, stock: 1, stockLimit: 5, batchId: 1, observedAt: T0 - 3 * MIN, craft: 'uncraftable' };
    h.repo.upsertScraptfList([row]);
    h.list.refresh();
    expect(h.check('Professional Rocket Launcher Kit')).toMatchObject({ sku: KIT, price: { keys: 36, source: 'list' }, stock: 1, stockLimit: 5, listAt: T0 - 3 * MIN, reason: null });
  });

  it("keeps a Steam-form name on backpack.tf's Craftable kit, which the import's Non-Craftable prices do not price", async () => {
    const h = await setup();
    importedKitPage(h.repo);
    h.repo.upsertListings([buyer(CRAFTABLE_KIT, 50, 9)]);
    const r = h.check('Professional Killstreak Rocket Launcher Kit');
    expect(r).toMatchObject({ status: 'item', sku: CRAFTABLE_KIT, price: null, verdict: 'no-price', reason: null });
  });

  it("still notes a painted or spelled copy's price for a plain check, and not a killstreak weapon's own sheen", async () => {
    const h = await setup();
    h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 30, source: 'user', observedAt: T0 - MIN, special: special({ paint: PAINT }) });
    const painted = h.check('Team Captain');
    expect(painted).toMatchObject({ status: 'item', sku: '378;6', price: { valueScrap: 30, source: 'typed' }, reason: CHECK_EXTRAS_NOTE });
    expect(checkPriceIsOtherCopy(painted)).toBe(true);

    const weapon = '205;11;kt-3';
    h.repo.upsertScrapPrice({ sku: weapon, name: 'Strange Professional Killstreak Rocket Launcher', costKeys: 3, costScrap: 0, source: 'import', observedAt: T0 - 2 * MIN, special: special({ sheen: 1, killstreaker: 2008 }) });
    expect(h.check('Strange Professional Killstreak Rocket Launcher')).toMatchObject({ sku: weapon, price: { keys: 3, source: 'import' }, reason: null });
    // A newer spelled copy is passed over for the plain one; alone, it is noted.
    h.repo.upsertScrapPrice({ sku: weapon, name: 'Strange Professional Killstreak Rocket Launcher', costKeys: 2, costScrap: 0, source: 'import', observedAt: T0 - MIN, special: special({ sheen: 1, killstreaker: 2008, spells: ['Exorcism'] }) });
    expect(h.check('Strange Professional Killstreak Rocket Launcher')).toMatchObject({ price: { keys: 3 }, reason: null });
    for (const p of h.repo.scrapPricesForSku(weapon)) if (p.special?.spells.length === 0) h.repo.deleteScrapPrice(p.id);
    const spelled = h.check('Strange Professional Killstreak Rocket Launcher');
    expect(spelled).toMatchObject({ price: { keys: 2 }, reason: CHECK_EXTRAS_NOTE });
    expect(checkPriceIsOtherCopy(spelled)).toBe(true);
  });
});
