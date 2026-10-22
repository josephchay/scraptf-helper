// 0.7.4 (F36): the scrap.tf bank page an item no saved page has shown is looked for on comes from its kind,
// not its category alone. The audited saves list strange cosmetics on /buy/hats (never /buy/stranges, which
// holds weapons only), killstreak and australium weapons on /buy/items, and only kits on /buy/killstreaks.
// scraptfBankForItem decides it; the Live market's scrap.tf link, the banks' "What to look for", the shopping
// list, the drawer's and item menu's "Open on scrap.tf" and ACT-8 read it. A page a save showed the item on
// still wins. Only SCRAPTF_BANKS pages ever come out (R1). Real schema fixture (schema-subset.json).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { lookForBank } from '../../src/service/domain/banks';
import { createEngine } from '../../src/service/domain/engine';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex, marketBankOfSku } from '../../src/service/domain/market';
import { buildShoppingList } from '../../src/service/domain/shopping';
import { buildItemDetail } from '../../src/service/domain/views';
import { bankPageOf, groupShoppingRows } from '../../src/renderer/shoppingModel';
import { bankPageUrl, scraptfOpenUrl } from '../../src/renderer/itemMenuModel';
import { mockBankOf } from '../../src/renderer/mockData';
import { bankLookFor } from '../../src/shared/banks';
import { scraptfBankForItem } from '../../src/shared/categories';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANKS, scraptfLinkFor } from '../../src/shared/links';
import { fromString } from '../../src/shared/sku';
import type { Opportunity, ScraptfBank } from '../../src/shared/types';
import { makeOpp } from '../db/helpers';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, makeListing, recordingEvents } from './helpers';

const K = 567;
let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function newRepo(): Repo {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  return repo;
}

const bankOf = (sku: string): ScraptfBank => {
  const obj = fromString(sku);
  return scraptfBankForItem(schema.categoryForSku(sku), obj, schema.itemByDefindex(obj.defindex));
};

describe('scraptfBankForItem', () => {
  it('sends each kind to the page that sells it', () => {
    const table: [string, string, ScraptfBank][] = [
      ['378;11', 'stranges', 'hats'], // Strange Team Captain: a strange cosmetic
      ['424;11', 'stranges', 'stranges'], // Strange Tomislav: a strange weapon
      ['205;11;australium', 'stranges', 'items'],
      ['141;11;australium;kt-1', 'killstreaks', 'items'],
      ['161;6;kt-1', 'killstreaks', 'items'], // Killstreak Big Kill: a killstreak weapon
      ['1071;11;kt-3', 'killstreaks', 'items'], // Strange Professional Killstreak Golden Frying Pan
      ['6526;6;uncraftable;kt-3;td-205', 'killstreaks', 'killstreaks'], // a Professional Killstreak Kit
      ['378;6', 'hats', 'hats'],
      ['205;6', 'weapons', 'weapons'],
      ['378;5;u13', 'unusuals', 'unusuals'],
    ];
    for (const [sku, category, bank] of table) {
      expect(schema.categoryForSku(sku), sku).toBe(category);
      expect(bankOf(sku), sku).toBe(bank);
      expect(marketBankOfSku(schema, schema.categoryForSku(sku), sku), sku).toBe(bank);
    }
  });

  it('without a schema entry reads what the SKU says, else the category page; only SCRAPTF_BANKS ids', () => {
    expect(scraptfBankForItem('killstreaks', fromString('200;6;kt-2'), null)).toBe('items');
    expect(scraptfBankForItem('killstreaks', fromString('6526;6;uncraftable;kt-3;td-474'), null)).toBe('killstreaks');
    expect(scraptfBankForItem('stranges', fromString('200;11;australium'), null)).toBe('items');
    expect(scraptfBankForItem('stranges', fromString('378;11'), null)).toBe('stranges');
    expect(scraptfBankForItem('taunts', fromString('30920;6'), null)).toBe('items');
    // The mock has no schema: the same SKU-only answers.
    expect(mockBankOf('202;11;kt-3', 'killstreaks')).toBe('items');
    expect(mockBankOf('205;11;australium', 'stranges')).toBe('items');
    expect(mockBankOf('200;11', 'stranges')).toBe('stranges');
    const ids = new Set(SCRAPTF_BANKS.map((b) => b.bank));
    for (const sku of ['378;11', '424;11', '161;6;kt-1', '6526;6;uncraftable;kt-3;td-205', '30920;6']) expect(ids.has(bankOf(sku))).toBe(true);
  });

  it('scraptfLinkFor: a page a save showed wins; else the item bank; else the category; never the list as a fallback', () => {
    expect(scraptfLinkFor('stranges', null, 'hats')).toEqual({ bank: 'hats', url: 'https://scrap.tf/buy/hats', seenAt: null, source: 'category' });
    expect(scraptfLinkFor('stranges', { bank: 'items', at: T0 }, 'hats')).toMatchObject({ bank: 'items', source: 'seen' });
    expect(scraptfLinkFor('stranges', null)).toMatchObject({ bank: 'stranges', source: 'category' });
    expect(scraptfLinkFor('stranges', null, 'list')).toMatchObject({ bank: 'stranges', source: 'category' });
  });
});

function market(repo: Repo, seen: Record<string, ScraptfBank> = {}) {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const m = createMarketIndex({
    ...makeDeps(repo, clock, () => DEFAULT_SETTINGS),
    schema,
    timers,
    keyPrice: () => selectKeyPrice(repo.keyQuotes(), DEFAULT_SETTINGS, clock.now()),
    onChanged: () => undefined,
    folderWatchActive: () => false,
    bankStock: { newAtFor: () => null, version: () => 1, seenFor: (sku) => (seen[sku] ? { bank: seen[sku]!, at: T0 - MIN } : null) },
  });
  m.start();
  timers.advance(0);
  return { m, clock };
}

const buyers = (sku: string, scrap: number) =>
  [0, 1].map((i) => makeListing({ id: `${sku}-${i}`, sku, baseSku: sku, steamid: `S${sku}-${i}`, metalScrap: scrap - i, lastEventAt: T0 - MIN }));

describe('the Live market and the banks cards', () => {
  it("links an unseen strange cosmetic to /buy/hats and a killstreak weapon to /buy/items; a sighting still wins", () => {
    const repo = newRepo();
    repo.upsertListings([...buyers('378;11', 90), ...buyers('424;11', 60), ...buyers('161;6;kt-1', 40), ...buyers('6526;6;uncraftable;kt-3;td-205', 700)]);
    const { m, clock } = market(repo, { '424;11': 'items' });
    const rows = m.all({ verdicts: ['unchecked'] }, clock.now());
    const link = (sku: string) => rows.find((r) => r.sku === sku)!.scraptfLink;
    expect(link('378;11')).toMatchObject({ bank: 'hats', url: 'https://scrap.tf/buy/hats', source: 'category' });
    expect(link('161;6;kt-1')).toMatchObject({ bank: 'items', source: 'category' });
    expect(link('6526;6;uncraftable;kt-3;td-205')).toMatchObject({ bank: 'killstreaks', source: 'category' });
    expect(link('424;11')).toMatchObject({ bank: 'items', source: 'seen' });
    expect(m.bankFor('378;11')).toBe('hats');
    expect(m.bankFor('424;11')).toBe('items');

    // "What to look for": the strange cosmetic is the Hats card's, not the Stranges card's.
    const groups = m.uncheckedBy(lookForBank, 5, clock.now());
    expect(groups.get('hats')?.rows.map((r) => r.sku)).toEqual(['378;11']);
    expect(groups.get('stranges')).toBeUndefined();
    expect(groups.get('items')?.rows.map((r) => r.sku).sort()).toEqual(['161;6;kt-1', '424;11']);
    expect(bankLookFor(rows, ['hats'], 'hats').lookFor.map((l) => l.sku)).toEqual(['378;11']);
    expect(bankLookFor(rows, ['stranges'], 'stranges').unchecked).toBe(0);
    // Without a bank (older callers) the category rule is unchanged.
    expect(bankLookFor(rows, ['stranges']).unchecked).toBe(2);
  });
});

describe('the shopping list', () => {
  const opp = (sku: string, over: Partial<Opportunity> = {}) =>
    makeOpp({ key: `${sku}|price:1`, sku, name: sku, category: schema.categoryForSku(sku), inputKind: 'import', status: 'profitable', maxCostScrap: 50, revenueScrap: 60, ...over });

  it('links each row to its own page, and a group only when every row opens one page', () => {
    const rows = [opp('378;11'), opp('424;11', { key: '424;11|price:2' })];
    const list = buildShoppingList(rows, {}, null, T0, { bankOf: (sku) => bankOf(sku) });
    expect(list.rows.map((r) => [r.sku, r.bankPageUrl])).toEqual(
      expect.arrayContaining([
        ['378;11', 'https://scrap.tf/buy/hats'],
        ['424;11', 'https://scrap.tf/buy/stranges'],
      ]),
    );
    expect(list.groups).toEqual([{ category: 'stranges', label: expect.any(String), count: 2, bankPageUrl: 'https://scrap.tf/buy/stranges', mixedBanks: true }]);
    const groups = groupShoppingRows(list.rows, list.groups);
    expect(groups[0]!.mixedBanks).toBe(true);
    expect(bankPageOf({ type: 'group', id: 'g', group: groups[0]!, collapsed: false })).toBeNull();

    const one = buildShoppingList([opp('378;11')], {}, null, T0, { bankOf: (sku) => bankOf(sku) });
    expect(one.groups[0]).toEqual({ category: 'stranges', label: expect.any(String), count: 1, bankPageUrl: 'https://scrap.tf/buy/hats' });
    // A failing or list answer falls back to the category's page, as before.
    const broken = buildShoppingList([opp('378;11')], {}, null, T0, {
      bankOf: () => {
        throw new Error('x');
      },
    });
    expect(broken.rows[0]!.bankPageUrl).toBe('https://scrap.tf/buy/stranges');
    expect(buildShoppingList([opp('378;11')], {}, null, T0, { bankOf: () => 'list' }).rows[0]!.bankPageUrl).toBe('https://scrap.tf/buy/stranges');
  });
});

describe('the drawer and the item menu', () => {
  it('ItemDetail.kindBank names the kind bank; Open on scrap.tf uses it when no save named a page', () => {
    const repo = newRepo();
    repo.upsertListings(buyers('378;11', 90));
    const d = buildItemDetail({ repo, schema, sku: '378;11', keyPrice: null, settings: DEFAULT_SETTINGS, now: T0, snapshot: null as never });
    expect(d!.kindBank).toBe('hats');
    expect(scraptfOpenUrl(d!.category, null, d!.seenOn, d!.kindBank ?? null)).toBe('https://scrap.tf/buy/hats');
    expect(scraptfOpenUrl('stranges', null, { bank: 'items' }, 'hats')).toBe('https://scrap.tf/buy/items');
    expect(scraptfOpenUrl('stranges', null, null)).toBe('https://scrap.tf/buy/stranges');
    expect(bankPageUrl(null, 'stranges', 'hats')).toBe('https://scrap.tf/buy/hats');
    expect(bankPageUrl(null, 'stranges')).toBe('https://scrap.tf/buy/stranges');
  });
});

describe('ACT-8 by the bank the item is sold on', () => {
  function engine(saves: Partial<Record<ScraptfBank, number>>) {
    const repo = newRepo();
    const clock = new FakeClock();
    const events = recordingEvents();
    const asked: ScraptfBank[] = [];
    const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } });
    const e = createEngine({
      ...makeDeps(repo, clock, () => settings),
      schema,
      events,
      timers: new FakeTimers(clock),
      recentBankSaveAt: (bank) => {
        asked.push(bank);
        return saves[bank] ?? null;
      },
    });
    const book = (sku: string, scrap: number) =>
      repo.upsertListings(
        [0, 1, 2].map((i) =>
          makeListing({ id: `${sku}-${i}`, sku, baseSku: sku, steamid: `S${sku}-${i}`, metalScrap: scrap - i, isBot: i === 0, uaLastPulse: Math.floor(clock.t / 1000), userOnline: true, lastEventAt: clock.t - MIN }),
        ),
      );
    return { repo, e, events, asked, book };
  }

  it('a strange cosmetic candidate still toasts after a fresh /buy/stranges save, and is held back by a fresh /buy/hats one', async () => {
    const strangesOnly = engine({ stranges: T0 - 10 * MIN });
    strangesOnly.book('378;11', 108);
    strangesOnly.repo.upsertRule({ name: 'Strange hats', filter: { defindexes: [378], qualities: [11] }, costScrap: 60, observedAt: T0 - 60 * MIN });
    await strangesOnly.e.runNow();
    expect(strangesOnly.events.notified.map((n) => n.title)).toEqual(['Candidate: Strange Team Captain']);
    expect(strangesOnly.asked).toEqual(['hats']);

    const hats = engine({ hats: T0 - 10 * MIN });
    hats.book('378;11', 108);
    hats.repo.upsertRule({ name: 'Strange hats', filter: { defindexes: [378], qualities: [11] }, costScrap: 60, observedAt: T0 - 60 * MIN });
    await hats.e.runNow();
    expect(hats.events.notified).toEqual([]);
    // The row stays (ACT-8 only holds the toast back).
    expect(hats.repo.opportunitiesForSku('378;11').map((o) => [o.inputKind, o.status])).toEqual([['rule', 'profitable']]);
  });
});
