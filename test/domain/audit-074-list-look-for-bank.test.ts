// 0.7.4 (review R26): the banks' "What to look for" puts an item seen only on scrap.tf/items on the card of the
// bank its kind is sold on, the page MarketIndex.bankFor and the Shopping list send it to. Before, a list
// sighting went back to the category's bank: a strange cosmetic (Strange Team Captain) landed on the Stranges
// card (/buy/stranges sells weapons only) and the Hats card, where scrap.tf sells it, left it out; a strange
// australium went to Stranges, not Items. MarketRow.kindBank carries the kind's bank for a list-linked row,
// uncheckedBy groups by it and bankLookFor reads it. The mock's rows carry it too. Real schema fixture.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { lookForBank } from '../../src/service/domain/banks';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { createRng, makeBook, mockBankOf, mockMarketRow } from '../../src/renderer/mockData';
import { createMockBridge } from '../../src/renderer/mock';
import { bankLookFor } from '../../src/shared/banks';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { ScraptfBank } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, makeListing } from './helpers';

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

function market(repo: Repo, seen: Record<string, ScraptfBank>) {
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

describe('a list-only sighting on the banks cards (service)', () => {
  it("groups by the kind's bank, as bankFor answers", () => {
    const repo = newRepo();
    repo.upsertListings([...buyers('378;11', 90), ...buyers('208;11;australium', 400), ...buyers('424;11', 60)]);
    const { m, clock } = market(repo, { '378;11': 'list', '208;11;australium': 'list', '424;11': 'list' });
    const rows = m.all({ verdicts: ['unchecked'] }, clock.now());
    const row = (sku: string) => rows.find((r) => r.sku === sku)!;
    expect(row('378;11')).toMatchObject({ category: 'stranges', scraptfLink: { bank: 'list', source: 'seen' }, kindBank: 'hats' });
    expect(row('208;11;australium')).toMatchObject({ scraptfLink: { bank: 'list' }, kindBank: 'items' });
    expect(row('424;11')).toMatchObject({ scraptfLink: { bank: 'list' }, kindBank: 'stranges' });

    const groups = m.uncheckedBy(lookForBank, 5, clock.now());
    expect(groups.get('hats')?.rows.map((r) => r.sku)).toEqual(['378;11']);
    expect(groups.get('items')?.rows.map((r) => r.sku)).toEqual(['208;11;australium']);
    expect(groups.get('stranges')?.rows.map((r) => r.sku)).toEqual(['424;11']);
    // The card agrees with the Shopping list's page.
    for (const sku of ['378;11', '208;11;australium', '424;11']) {
      const bank = m.bankFor(sku);
      expect(groups.get(bank)?.rows.map((r) => r.sku), sku).toContain(sku);
    }
  });

  it('bankLookFor keeps a regrouped row on its card and leaves it off its category card', () => {
    const repo = newRepo();
    repo.upsertListings([...buyers('378;11', 90), ...buyers('208;11;australium', 400)]);
    const { m, clock } = market(repo, { '378;11': 'list', '208;11;australium': 'list' });
    const rows = m.all({ verdicts: ['unchecked'] }, clock.now());
    expect(bankLookFor(rows, ['hats'], 'hats').lookFor.map((l) => l.sku)).toEqual(['378;11']);
    expect(bankLookFor(rows, ['stranges'], 'stranges').unchecked).toBe(0);
    expect(bankLookFor(rows, ['other'], 'items').lookFor.map((l) => l.sku)).toEqual(['208;11;australium']);
    // Without a bank (older callers) the category rule is unchanged.
    expect(bankLookFor(rows, ['stranges']).unchecked).toBe(2);
  });

  it('a row seen on a bank page carries no kindBank', () => {
    const repo = newRepo();
    repo.upsertListings(buyers('378;11', 90));
    const { m, clock } = market(repo, { '378;11': 'stranges' });
    const r = m.all({ verdicts: ['unchecked'] }, clock.now()).find((x) => x.sku === '378;11')!;
    expect(r.scraptfLink.bank).toBe('stranges');
    expect(r).not.toHaveProperty('kindBank');
  });
});

describe('the mock', () => {
  it("a list-linked row carries mockBankOf's bank, and bankLookFor puts it on that card", () => {
    const item = { sku: '200;6;kt-2', name: 'Specialized Killstreak Scattergun', category: 'killstreaks' as const, value: 120 };
    const row = mockMarketRow({
      item,
      book: makeBook(createRng(7), item, T0),
      known: undefined,
      rules: [],
      settings: DEFAULT_SETTINGS,
      keyScrap: K,
      now: T0,
      seen: { bank: 'list', at: T0 - MIN },
    })!;
    expect(row.verdict).toBe('unchecked');
    expect(row.kindBank).toBe(mockBankOf(item.sku, item.category));
    expect(row.kindBank).toBe('items');
    expect(bankLookFor([row], ['killstreaks'], 'killstreaks').unchecked).toBe(0);
    expect(bankLookFor([row], ['other'], 'items').unchecked).toBe(1);
  });

  it('every mock market row has kindBank exactly when its link is the list', async () => {
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    try {
      const all = await b.rpc('market.list', { limit: 2000 });
      for (const r of all.rows) {
        if (r.scraptfLink.bank === 'list') expect(r.kindBank, r.sku).toBe(mockBankOf(r.sku, r.category));
        else expect(r, r.sku).not.toHaveProperty('kindBank');
      }
    } finally {
      b.dispose();
    }
  });
});
