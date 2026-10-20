// 0.7.3 audit (market-1): one look of /buy/killstreaks stores a kit once per sheen/killstreaker combo, every
// copy at the page's time and each its own opportunity. They tie on confidence and ceiling, so the shopping
// list fell through to the key and showed whichever copy sorted first ('price:1' before 'price:9') as "Your
// price", often the dearest, while the Live market showed the cheapest (market.ts knownAt) and called it a
// flip. Of copies seen at one time the list now takes the cheapest, equal costs the higher id, as the market
// does; the confidence and ceiling picks are unchanged. The integration case runs the real engine and market
// index over an in-memory repo; the schema comes from a fake HTTP route, so nothing touches the network.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine } from '../../src/service/domain/engine';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { buildShoppingList } from '../../src/service/domain/shopping';
import { mockShoppingList } from '../../src/renderer/mockData';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { KeyPriceState, Opportunity, OrderSummary } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, HOUR, MIN, T0, makeDeps, makeListing, recordingEvents, special } from './helpers';

const K = 567;
const KP: KeyPriceState = { valueScrap: K, source: 'pricedb', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };
const KIT = '6526;6;uncraftable;kt-3;td-205';
/** 30 keys of revenue at a 15 750 scrap ceiling; the copies below cost 37 keys 40 ref, 20 keys and 36 keys. */
const CEILING = 15_750;
const DEAR = 37 * K + 360;
const CHEAP = 20 * K;
const MID = 36 * K;

function order(valueScrap: number): OrderSummary {
  return {
    listingId: 'kit-buyer',
    steamid: '76561198000000001',
    userName: 'Bot',
    keys: 30,
    metalScrap: 0,
    valueScrap,
    isBot: true,
    online: true,
    lastEventAt: T0,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
}

/** One stored copy of the kit: an import with the same confidence, ceiling and time unless a case says otherwise. */
function copy(id: number | string, costScrap: number, over: Partial<Opportunity> = {}): Opportunity {
  const inputRef = typeof id === 'number' ? `price:${id}` : id;
  const revenueScrap = 30 * K;
  const cons = order(revenueScrap);
  return {
    key: `${KIT}|${inputRef}`,
    sku: KIT,
    name: 'Non-Craftable Professional Killstreak Rocket Launcher Kit',
    category: 'killstreaks',
    inputRef,
    inputKind: inputRef.startsWith('rule:') ? 'rule' : 'import',
    costKeys: 0,
    costScrapRaw: costScrap,
    costScrap,
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: revenueScrap,
    revenueScrap,
    profitScrap: revenueScrap - costScrap,
    margin: (revenueScrap - costScrap) / costScrap,
    maxCostScrap: CEILING,
    confidence: 70,
    confidenceLevel: 'medium',
    flags: [],
    reasons: [],
    buyerCount: 1,
    bestOrder: cons,
    consOrder: cons,
    instantOrder: cons,
    references: { pricedb: null, community: null },
    profitTier: 'key',
    status: costScrap <= CEILING ? 'profitable' : 'unprofitable',
    inputObservedAt: T0 - HOUR,
    firstSeenAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** The list's one row and the ref its stock was asked for. */
function listed(rows: readonly Opportunity[]) {
  const asked: string[] = [];
  const r = buildShoppingList(rows, {}, KP, T0, { stockOf: (ref) => (asked.push(ref), Number(ref.slice('price:'.length))) });
  expect(r.rows).toHaveLength(1);
  return { row: r.rows[0]!, ref: asked[0] ?? null };
}

/** The same through the browser mock, with its stock keyed the same way. */
function mocked(rows: readonly Opportunity[]) {
  const asked: string[] = [];
  const r = mockShoppingList(rows, {}, 'conservative', KP, T0, {
    staleMs: DEFAULT_SETTINGS.profit.inputStaleMs,
    stockOf: (o) => (asked.push(o.inputRef), Number(o.inputRef.slice('price:'.length))),
  });
  expect(r.rows).toHaveLength(1);
  return { row: r.rows[0]!, ref: asked[0] ?? null };
}

const orders = <T>(xs: readonly T[]): T[][] => [[...xs], [...xs].reverse(), [xs[1]!, xs[2]!, xs[0]!].filter((x) => x !== undefined)];

describe('shopping list: copies of one kit seen in one look (0.7.3)', () => {
  it('shows the cheapest copy as "Your price", whatever its id or the input order', () => {
    const rows = [copy(1, DEAR), copy(9, CHEAP), copy(10, MID)];
    for (const o of orders(rows)) {
      const { row, ref } = listed(o);
      expect(row).toMatchObject({ maxCostScrap: CEILING, knownCostScrap: CHEAP, knownMaxCostScrap: CEILING, underCeiling: true, knownStock: 9 });
      expect(ref).toBe('price:9');
    }
  });

  it('breaks equal costs by the higher price id (numeric, not as text)', () => {
    for (const [lo, hi] of [
      [2, 9],
      [9, 10],
    ] as const) {
      for (const o of [[copy(lo, CHEAP), copy(hi, CHEAP)], [copy(hi, CHEAP), copy(lo, CHEAP)]]) {
        expect(listed(o).ref).toBe(`price:${hi}`);
      }
    }
  });

  it('still lets a newer copy win over a cheaper one of an older look', () => {
    const newer = copy(1, DEAR, { inputObservedAt: T0 });
    const older = copy(9, CHEAP, { inputObservedAt: T0 - HOUR });
    for (const o of [[newer, older], [older, newer]]) {
      const { row, ref } = listed(o);
      expect(row).toMatchObject({ knownCostScrap: DEAR, underCeiling: false });
      expect(ref).toBe('price:1');
    }
  });

  it('picks the same copy in any input order when two looks tie on confidence (a newer look first)', () => {
    // Both looks are 15 min to 2 h old, so the engine scores them alike. Cost only breaks a tie at one time;
    // were it the key across times, the pick would cycle (5 over 1, 1 over 3, 3 over 5) with the order.
    const rows = [copy(5, CHEAP, { inputObservedAt: T0 - 90 * MIN }), copy(1, DEAR, { inputObservedAt: T0 - 90 * MIN }), copy(3, MID, { inputObservedAt: T0 - 30 * MIN })];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map((p) => p.map((i) => rows[i]!));
    for (const o of perms) {
      const service = listed(o);
      expect(service.ref).toBe('price:3');
      expect(mocked(o).ref).toBe('price:3');
    }
  });

  it('keeps the higher ceiling ahead of a cheaper copy, and judges its own price against it', () => {
    const wanted = copy(1, 21_000, { maxCostScrap: 16_000 });
    const cheap = copy(9, CHEAP);
    for (const o of [[wanted, cheap], [cheap, wanted]]) {
      expect(listed(o).row).toMatchObject({ maxCostScrap: 16_000, knownCostScrap: 21_000, knownMaxCostScrap: 16_000, underCeiling: false });
    }
  });

  it('takes the cheapest copy of the newest look when a rule sets the ceiling', () => {
    const rule = copy('rule:1', 0, { confidence: 95, maxCostScrap: 16_500 });
    for (const o of orders([rule, copy(9, DEAR), copy(10, CHEAP)])) {
      const { row, ref } = listed(o);
      expect(row).toMatchObject({ maxCostScrap: 16_500, knownCostScrap: CHEAP, underCeiling: true });
      expect(ref).toBe('price:10');
    }
    // Equal costs: the higher id. A newer, dearer copy still beats an older, cheaper one.
    expect(listed([rule, copy(10, CHEAP), copy(2, CHEAP)]).ref).toBe('price:10');
    const { row, ref } = listed([rule, copy(9, CHEAP, { inputObservedAt: T0 - 2 * HOUR }), copy(3, DEAR)]);
    expect(row).toMatchObject({ knownCostScrap: DEAR, underCeiling: false });
    expect(ref).toBe('price:3');
  });

  it('picks the same copy in the browser mock', () => {
    const rule = copy('rule:1', 0, { confidence: 95, maxCostScrap: 16_500 });
    for (const rows of [
      [copy(1, DEAR), copy(9, CHEAP), copy(10, MID)],
      [copy(2, CHEAP), copy(9, CHEAP)],
      [copy(2, CHEAP), copy(10, CHEAP)],
      [rule, copy(9, DEAR), copy(10, CHEAP)],
      [rule, copy(10, CHEAP), copy(2, CHEAP)],
    ]) {
      for (const o of orders(rows)) {
        const service = listed(o);
        const mock = mocked(o);
        expect(mock.row.knownCostScrap).toBe(service.row.knownCostScrap);
        expect(mock.row.underCeiling).toBe(service.row.underCeiling);
        expect(mock.ref).toBe(service.ref);
      }
    }
  });
});

describe('shopping list against the Live market: one look of a kit through the real engine (0.7.3)', () => {
  let schema: SchemaService;
  beforeAll(async () => {
    schema = createSchemaService(schemaDeps(schemaRoute()));
    await schema.init();
  });
  const openRepos: Repo[] = [];
  afterEach(() => {
    while (openRepos.length) openRepos.pop()!.close();
  });

  it('shows the copy the market row shows, under the ceiling, with its stock', async () => {
    const repo = openRepo(':memory:');
    openRepos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
    repo.upsertListings([
      makeListing({ id: 'kit-buyer', sku: KIT, baseSku: KIT, keys: 30, metalScrap: 0, isBot: true, uaLastPulse: Math.floor(T0 / 1000), lastEventAt: T0 - MIN, itemName: 'Kit' }),
    ]);
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    const at = T0 - HOUR;
    const batch = repo.createImportBatch({ fileName: 'scrap.tf window /buy/killstreaks', pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: 9, bank: 'killstreaks' });
    // Eight dear copies stored first (the lowest ids), the cheap one last.
    for (let i = 0; i < 8; i++) {
      repo.upsertScrapPrice({ sku: KIT, name: 'Kit', costKeys: 37, costScrap: 360, source: 'import', observedAt: at, importBatch: batch, special: special({ sheen: 1 + (i % 7), killstreaker: 2002 + i }), stock: 1 });
    }
    const cheap = repo.upsertScrapPrice({ sku: KIT, name: 'Kit', costKeys: 20, costScrap: 0, source: 'import', observedAt: at, importBatch: batch, special: special({ sheen: 3, killstreaker: 2001 }), stock: 2 });

    const engine = createEngine({ ...makeDeps(repo, clock, () => settings), schema, events: recordingEvents(), timers });
    await engine.runNow();
    const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
    const market = createMarketIndex({ ...makeDeps(repo, clock, () => settings), schema, timers, keyPrice, onChanged: () => undefined, folderWatchActive: () => false });
    market.start();
    timers.advance(0);
    const m = market.all({}, clock.now()).find((r) => r.sku === KIT)!;
    expect(m).toMatchObject({ knownCostScrap: CHEAP, verdict: 'flip', stock: 2 });

    const s = buildShoppingList(repo.allOpportunities(), {}, engine.keyPrice(), clock.now(), {
      stockOf: (ref) => {
        const id = /^price:(\d+)$/.exec(ref);
        return id ? (repo.getScrapPrice(Number(id[1]))?.stock ?? null) : null;
      },
    }).rows.find((r) => r.sku === KIT)!;
    expect(s.maxCostScrap).toBeGreaterThan(CHEAP);
    expect(s.maxCostScrap).toBeLessThan(DEAR);
    expect(s).toMatchObject({ knownCostScrap: m.knownCostScrap, underCeiling: true, knownStock: 2 });
    expect(repo.getScrapPrice(cheap.id)?.stock).toBe(2);
  });
});
