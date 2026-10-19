// F16 live check evaluation (createLiveCheck): the revenue is item.detail {history:false,
// target:'plain'}'s, the ceiling, profit and verdict agree with the Live market row for the same price,
// buyer confidence is the market entry's (or the market's own evaluation before the index has built),
// the price is the copied one, else the saved scrap.tf list's, else the newest typed or imported one,
// and the recent ring keeps 30 item results and never the text. Real in-memory repo, list cache and
// market index, fake clock and timers. Nothing here touches scrap.tf or any network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import {
  CHECK_EXTRAS_NOTE,
  CHECK_FUZZY_NOTE,
  CHECK_INCOMPLETE_NOTE,
  CHECK_SCHEMA_LOADING_REASON,
  CHECK_SOLD_OUT_NOTE,
  createLiveCheck,
  newestStoredPrice,
  storedPriceHasExtras,
  type LiveCheck,
} from '../../src/service/domain/liveCheck';
import { createMarketIndex, type MarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import { buildItemDetail } from '../../src/service/domain/views';
import { CHECK_NOT_ITEM_REASON, CHECK_RECENT_MAX } from '../../src/shared/check';
import { frictionOf, maxCostFor, profitStatus } from '../../src/shared/ceiling';
import { baseSku, fromString } from '../../src/shared/sku';
import type { CheckResult, CheckSource, ItemSuggestion, Listing, MarketRow, ResolvedItem, ScrapPrice, ScraptfListStored, Settings } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, noNetwork, recordingLogger, silentLogger, special, testSettings } from './helpers';

const PAINT = 3100495;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

const NAMES: Record<string, string> = {
  'team captain': '378;6',
  "bill's hat": '126;6',
  'rocket launcher': '205;6',
  'taunt: the bunnyhopper': '30920;6',
};

/** schema.resolve for the stub schema: SKUs, a few exact names and one closest-match guess. */
function stubResolve(t: string): ResolvedItem | null {
  const s = t.replace(/\s+/g, ' ').trim().toLowerCase();
  const of = (sku: string, match: ResolvedItem['match'], warnings: string[] = []): ResolvedItem => ({ sku, name: sku, skuObject: fromString(sku), category: 'hats', match, warnings });
  if (/^\d+;\d+(;[a-z0-9-]+)*$/.test(s)) return of(s, 'sku');
  if (Object.hasOwn(NAMES, s)) return of(NAMES[s]!, 'exact');
  if (s === 'team captian') return of('378;6', 'fuzzy', ['No exact item named "team captian"; using the closest match "Team Captain"']);
  if (s === 'unusual team captain') return of('378;5', 'exact', ['Unusual without an effect: the effect is unknown']);
  return null;
}

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

function listRow(over: Partial<ScraptfListStored> & { sku: string }): ScraptfListStored {
  return { name: 'Team Captain', sellsKeys: 0, sellsScrap: 90, paysKeys: 0, paysScrap: 75, stock: 2, stockLimit: 5, batchId: 1, observedAt: T0 - 3 * MIN, ...over };
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  settings: { current: Settings };
  list: ScraptfListCache;
  market: MarketIndex;
  lc: LiveCheck;
  http: HttpClient & { calls: number };
  log: ReturnType<typeof recordingLogger>;
  search: { hits: ItemSuggestion[] };
  K(): number;
  build(): void;
  check(text: string, source?: CheckSource): CheckResult;
  row(sku: string): MarketRow | undefined;
  detail(sku: string): ReturnType<typeof buildItemDetail>;
}

function setup(opts: { loaded?: boolean; repo?: Repo } = {}): Harness {
  const repo = opts.repo ?? openRepo(':memory:');
  if (!opts.repo) repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = { current: testSettings() };
  let list!: ScraptfListCache;
  // As core wires it: the key price reads the list's key row, the list values rows at the key price.
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now(), list.keyRow());
  list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
  // Any request would be counted (and fail): the check must make none.
  const http = {
    ...noNetwork,
    calls: 0,
    request(): never {
      http.calls++;
      throw new Error('live check must not make HTTP requests');
    },
  } as HttpClient & { calls: number };
  const search = { hits: [] as ItemSuggestion[] };
  const schema = { ...createStubSchema({ loaded: opts.loaded ?? true }), resolve: stubResolve, search: () => search.hits };
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings.current),
    http,
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    scraptfList: list,
  });
  const log = recordingLogger();
  const lc = createLiveCheck({ repo, schema, log, settings: () => settings.current, keyPrice, market, scraptfList: list });
  return {
    repo,
    clock,
    settings,
    list,
    market,
    lc,
    http,
    log,
    search,
    K: () => keyPrice().valueScrap,
    build() {
      market.start();
      timers.advance(0);
      expect(market.stats().building).toBe(false);
    },
    check: (text, source = 'manual') => lc.check(text, source, clock.now()),
    row: (sku) => market.all({}, clock.now()).find((r) => r.sku === sku),
    // As rpcHandlers' 'item.detail' {history:false, target:'plain'} builds it.
    detail: (sku) =>
      buildItemDetail({
        repo,
        schema,
        sku,
        keyPrice: keyPrice(),
        settings: settings.current,
        now: clock.now(),
        snapshot: { lastAt: null, available: false, nextAllowedAt: null },
        history: [],
        target: 'plain',
        scraptfList: list.rowFor(baseSku(sku), keyPrice().valueScrap),
      }),
  };
}

/** Three Team Captain buyers, one each for Bill's Hat and the Rocket Launcher; the taunt has none. */
function seedBook(repo: Repo): void {
  repo.upsertListings([
    ...['a', 'b', 'c'].map((s, i) => buy('378;6', 120 - i, { id: `tc-${s}`, steamid: `TC${s}`, isBot: i === 0, userOnline: true })),
    buy('126;6', 60, { id: 'bh', steamid: 'BH' }),
    buy('205;6', 60, { id: 'rl', steamid: 'RL' }),
  ]);
}

function typed(repo: Repo, sku: string, costScrap: number, observedAt: number, over: Partial<ScrapPrice> = {}): void {
  repo.upsertScrapPrice({ sku, name: sku, costScrap, source: 'user', observedAt, ...over });
}

describe('evaluation parity', () => {
  it("returns item.detail {history:false, target:'plain'}'s revenue, links, name and category", () => {
    const h = setup();
    seedBook(h.repo);
    h.repo.upsertScraptfList([listRow({ sku: '378;6' })]);
    h.list.refresh();
    h.build();
    for (const [text, sku] of [
      ['Team Captain', '378;6'],
      ['378;6;p3100495', `378;6;p${PAINT}`],
      ["Bill's Hat, 1 ref", '126;6'],
      ['Rocket Launcher', '205;6'],
      ['30920;6', '30920;6'],
    ] as const) {
      const r = h.check(text);
      const d = h.detail(sku)!;
      expect(r.status, text).toBe('item');
      expect(r.revenue, text).toEqual(d.revenue);
      expect(r.links, text).toEqual(d.links);
      expect([r.sku, r.name, r.category], text).toEqual([d.sku, d.name, d.category]);
      expect(r.keyScrap).toBe(h.K());
      // "Pay up to" is the shared ceiling of that revenue.
      expect(r.revenue!.maxCostScrap).toBe(maxCostFor(r.revenue!.revenueScrap, h.settings.current.profit));
    }
  });

  it('agrees with the Live market row on revenue, ceiling, confidence, profit and verdict', () => {
    const h = setup();
    seedBook(h.repo);
    h.build();
    const verdicts = new Set<string>();
    for (const cost of [90, 118, 104]) {
      h.clock.advance(MIN);
      typed(h.repo, '378;6', cost, h.clock.now());
      h.market.pricesChanged();
      const row = h.row('378;6')!;
      const r = h.check('Team Captain');
      expect(r.price, `cost ${cost}`).toMatchObject({ source: 'typed', valueScrap: cost, keys: 0, scrapRaw: cost });
      expect(row.knownCostScrap).toBe(cost);
      expect(r.revenue!.revenueScrap).toBe(row.revenueScrap);
      expect(r.revenue!.maxCostScrap).toBe(row.maxCostScrap);
      expect(r.revenue!.eligibleCount).toBe(3);
      expect([r.confidence, r.confidenceLevel]).toEqual([row.confidence, row.confidenceLevel]);
      expect(r.profitScrap).toBe(row.profitScrap);
      expect(r.verdict).toBe(row.verdict);
      verdicts.add(r.verdict!);
    }
    expect([...verdicts].sort()).toEqual(['flip', 'over']);
    // An item the user priced that nobody buys: no-buyers on both sides.
    typed(h.repo, '30920;6', 200, h.clock.now());
    h.market.pricesChanged();
    const r = h.check('Taunt: The Bunnyhopper');
    expect(h.row('30920;6')!.verdict).toBe('no-buyers');
    expect(r).toMatchObject({ verdict: 'no-buyers', profitScrap: null, margin: null, confidence: null, confidenceLevel: null });
    expect(r.revenue).toMatchObject({ revenueScrap: null, maxCostScrap: null, eligibleCount: 0 });
  });

  it("scores confidence as the market does before the index has built, and reads the base's entry for a painted copy", () => {
    const h = setup();
    seedBook(h.repo);
    const before = h.check('Team Captain');
    expect(h.market.entryFor('378;6')).toBeNull();
    expect(before.confidence).toEqual(expect.any(Number));
    h.build();
    const entry = h.market.entryFor('378;6')!;
    const after = h.check('Team Captain');
    expect([after.confidence, after.confidenceLevel]).toEqual([entry.confidence, entry.confidenceLevel]);
    expect([before.confidence, before.confidenceLevel]).toEqual([entry.confidence, entry.confidenceLevel]);
    expect(h.check(`378;6;p${PAINT}`)).toMatchObject({ confidence: entry.confidence, confidenceLevel: entry.confidenceLevel });
  });

  it('computes profit with friction and judges it with profitStatus', () => {
    const h = setup();
    seedBook(h.repo);
    h.settings.current = testSettings({ profit: { frictionScrap: 2 } });
    h.build();
    for (const text of ['Team Captain, 9 ref', 'Team Captain, 11 ref', 'Team Captain, 13.33 ref', 'Team Captain, 1 key']) {
      const r = h.check(text);
      const rev = r.revenue!.revenueScrap!;
      const cost = r.price!.valueScrap;
      const profit = rev - cost - frictionOf(h.settings.current.profit);
      expect(r.profitScrap, text).toBe(profit);
      expect(r.margin, text).toBeCloseTo(profit / cost, 10);
      const status = profitStatus(profit, cost, h.settings.current.profit);
      expect(r.verdict, text).toBe(status === 'profitable' ? 'flip' : 'over');
      expect(r.verdict === 'flip', text).toBe(cost <= r.revenue!.maxCostScrap!);
    }
    expect(h.check('Team Captain, 9 ref').verdict).toBe('flip');
    expect(h.check('Team Captain, 1 key').verdict).toBe('over');
  });
});

describe('the price compared', () => {
  function seeded(): Harness {
    const h = setup();
    seedBook(h.repo);
    h.repo.upsertScraptfList([
      listRow({ sku: '378;6' }),
      // Sold out: no price to buy, but scrap.tf still pays.
      listRow({ sku: '126;6', name: "Bill's Hat", sellsKeys: null, sellsScrap: null, paysScrap: 40, stock: 0, stockLimit: 5 }),
      // Listed with a price but stock 0: nothing to buy either.
      listRow({ sku: '205;6', name: 'Rocket Launcher', sellsScrap: 50, paysScrap: 30, stock: 0, stockLimit: 3 }),
    ]);
    h.list.refresh();
    // Typed prices newer than the list: the list still comes first (spec order).
    typed(h.repo, '378;6', 100, T0 - MIN);
    typed(h.repo, '126;6', 70, T0 - MIN);
    typed(h.repo, '205;6', 58, T0 - 20 * MIN);
    h.repo.upsertScrapPrice({ sku: '205;6', name: 'Rocket Launcher', costScrap: 55, source: 'import', observedAt: T0 - 10 * MIN });
    h.build();
    return h;
  }

  it('takes the copied price first, valued at the key price', () => {
    const h = seeded();
    expect(h.check('Team Captain, 1.33 ref').price).toEqual({ keys: 0, scrapRaw: 12, valueScrap: 12, source: 'clipboard', observedAt: T0 });
    expect(h.check('Team Captain, 1 key 2 ref').price).toEqual({ keys: 1, scrapRaw: 18, valueScrap: h.K() + 18, source: 'clipboard', observedAt: T0 });
  });

  it("then the saved list's price to buy, then the newest typed or imported price", () => {
    const h = seeded();
    expect(h.check('Team Captain')).toMatchObject({ price: { keys: 0, scrapRaw: 90, valueScrap: 90, source: 'list', observedAt: T0 - 3 * MIN }, listAt: T0 - 3 * MIN });
    // Sold out on the list: the typed price, with what scrap.tf pays and its stock from the list.
    expect(h.check("Bill's Hat")).toMatchObject({ price: { valueScrap: 70, source: 'typed' }, scraptfPaysScrap: 40, stock: 0, stockLimit: 5, listAt: T0 - 3 * MIN });
    // Stock 0 on the list: the newest stored price, here an import.
    expect(h.check('Rocket Launcher')).toMatchObject({ price: { valueScrap: 55, source: 'import', observedAt: T0 - 10 * MIN } });
  });

  it("is none for a copied 'Sold out' row, whatever is stored, with the row's pays and stock", () => {
    const h = seeded();
    const r = h.check('Team Captain\tSold out\t1.22 ref\t5/5');
    expect(r).toMatchObject({ status: 'item', price: null, verdict: 'no-price', reason: CHECK_SOLD_OUT_NOTE, scraptfPaysScrap: 11, stock: 5, stockLimit: 5, listAt: null, profitScrap: null });
    // "Pay up to" is still there to lead with.
    expect(r.revenue!.maxCostScrap).toEqual(expect.any(Number));
  });

  it("takes pays and stock from the copied row, else the list, and dates the list only when it supplied something", () => {
    const h = seeded();
    expect(h.check('Team Captain\t1.33 ref\t1 ref\t4/5')).toMatchObject({ price: { source: 'clipboard' }, scraptfPaysScrap: 9, stock: 4, stockLimit: 5, listAt: null });
    expect(h.check('Team Captain\t1.33 ref\t4/5')).toMatchObject({ scraptfPaysScrap: 75, stock: 4, stockLimit: 5, listAt: T0 - 3 * MIN });
    expect(h.check('Team Captain, 1.33 ref')).toMatchObject({ scraptfPaysScrap: 75, stock: 2, stockLimit: 5, listAt: T0 - 3 * MIN });
    // A copied dash under "Price we pay" is newer than the list's 75: scrap.tf pays nothing now.
    expect(h.check('Team Captain\t1.33 ref\t—\t4/5')).toMatchObject({ price: { source: 'clipboard' }, scraptfPaysScrap: null, stock: 4, stockLimit: 5, listAt: null });
  });

  it('is none for a copied row with stock 0, as the list and the saved-page import read it', () => {
    const h = seeded();
    const r = h.check('Team Captain\t1.33 ref\t1.22 ref\t0/5');
    expect(r).toMatchObject({ status: 'item', price: null, verdict: 'no-price', reason: CHECK_SOLD_OUT_NOTE, scraptfPaysScrap: 11, stock: 0, stockLimit: 5, profitScrap: null });
  });

  it("never takes the list's price (a plain copy's) for a painted item", () => {
    const h = seeded();
    // Only the plain list row and a plain typed price: nothing prices the painted copy.
    expect(h.check(`378;6;p${PAINT}`)).toMatchObject({ price: null, verdict: 'no-price', scraptfPaysScrap: 75, stock: 2, listAt: T0 - 3 * MIN });
    typed(h.repo, '378;6', 30, T0 - 30 * MIN, { special: special({ paint: PAINT }) });
    expect(h.check(`378;6;p${PAINT}`).price).toMatchObject({ valueScrap: 30, source: 'typed' });
    // The plain item still takes the list's.
    expect(h.check('Team Captain').price).toMatchObject({ valueScrap: 90, source: 'list' });
  });

  it('is no-price when nothing is known, still with the ceiling', () => {
    const h = setup();
    seedBook(h.repo);
    h.build();
    const r = h.check('Team Captain');
    expect(r).toMatchObject({ status: 'item', price: null, verdict: 'no-price', profitScrap: null, scraptfPaysScrap: null, stock: null, listAt: null });
    expect(r.revenue!.maxCostScrap).toBe(h.row('378;6')!.maxCostScrap);
  });

  it('prefers a plain copy for a plain SKU, and the painted copy for a painted one', () => {
    const h = setup();
    seedBook(h.repo);
    typed(h.repo, '378;6', 100, T0 - 30 * MIN);
    typed(h.repo, '378;6', 30, T0 - MIN, { special: special({ paint: PAINT }) });
    expect(h.check('Team Captain').price).toMatchObject({ valueScrap: 100, source: 'typed' });
    expect(h.check(`378;6;p${PAINT}`).price).toMatchObject({ valueScrap: 30, source: 'typed' });
  });

  it("says so when a plain check falls back to a painted copy's price, as the market row flags it has-extras", () => {
    const h = setup();
    seedBook(h.repo);
    typed(h.repo, '378;6', 30, T0 - MIN, { special: special({ paint: PAINT }) });
    h.build();
    const r = h.check('Team Captain');
    // Still shown (contract: a clean copy first, else the newest), but never silently as the plain one's.
    expect(r).toMatchObject({ status: 'item', sku: '378;6', price: { valueScrap: 30, source: 'typed' }, reason: CHECK_EXTRAS_NOTE });
    expect(h.row('378;6')!.flags).toContain('has-extras');
    // The painted item's own check: its own price, no note.
    expect(h.check(`378;6;p${PAINT}`)).toMatchObject({ price: { valueScrap: 30 }, reason: null });
    // A clean copy stored later wins, and the note goes.
    typed(h.repo, '378;6', 100, T0 - 30 * MIN);
    expect(h.check('Team Captain')).toMatchObject({ price: { valueScrap: 100, source: 'typed' }, reason: null });
  });

  it("notes a spelled saved-page copy the same way, after the item's own notes, and never for a copied or listed price", () => {
    const h = setup();
    seedBook(h.repo);
    typed(h.repo, '378;5', 40, T0 - MIN, { source: 'import', special: special({ spells: ['Exorcism'] }) });
    expect(h.check('Unusual Team Captain')).toMatchObject({ price: { valueScrap: 40, source: 'import' }, reason: `${CHECK_INCOMPLETE_NOTE} ${CHECK_EXTRAS_NOTE}` });
    typed(h.repo, '378;6', 30, T0 - MIN, { special: special({ paint: PAINT }) });
    expect(h.check('Team Captain, 1.33 ref')).toMatchObject({ price: { source: 'clipboard' }, reason: null });
    h.repo.upsertScraptfList([listRow({ sku: '378;6' })]);
    h.list.refresh();
    expect(h.check('Team Captain')).toMatchObject({ price: { source: 'list' }, reason: null });
  });

  it('storedPriceHasExtras reads the engine target: paint (in the SKU or its extras), spells or parts', () => {
    const base = { id: 1, sku: '378;6', name: 'Team Captain', costKeys: 0, costScrap: 10, source: 'user' as const, observedAt: 1, note: null, importBatch: null, special: null, assetId: null, stock: null };
    expect(storedPriceHasExtras(base)).toBe(false);
    expect(storedPriceHasExtras({ ...base, special: special({}) })).toBe(false);
    expect(storedPriceHasExtras({ ...base, special: special({ paint: PAINT }) })).toBe(true);
    expect(storedPriceHasExtras({ ...base, sku: `378;6;p${PAINT}` })).toBe(true);
    expect(storedPriceHasExtras({ ...base, special: special({ spells: ['x'] }) })).toBe(true);
    expect(storedPriceHasExtras({ ...base, sku: 'not a sku' })).toBe(false);
  });

  it('newestStoredPrice: newest by time then id, valid costs only, plain first when asked', () => {
    const p = (id: number, observedAt: number, over: Partial<ScrapPrice> = {}): ScrapPrice => ({
      id,
      sku: '378;6',
      name: 'Team Captain',
      costKeys: 0,
      costScrap: 10 * id,
      source: 'user',
      observedAt,
      note: null,
      importBatch: null,
      special: null,
      assetId: null,
      stock: null,
      ...over,
    });
    expect(newestStoredPrice([p(1, 5), p(2, 9), p(3, 9)], true)?.id).toBe(3);
    expect(newestStoredPrice([p(1, 5), p(2, 9, { costScrap: -1 }), p(3, 9, { sku: '378;6;foo' })], true)?.id).toBe(1);
    expect(newestStoredPrice([p(1, 5), p(2, 9, { special: special({ spells: ['x'] }) })], true)?.id).toBe(1);
    expect(newestStoredPrice([p(1, 5), p(2, 9, { special: special({ spells: ['x'] }) })], false)?.id).toBe(2);
    expect(newestStoredPrice([p(2, 9, { special: special({ paint: PAINT }) })], true)?.id).toBe(2);
    expect(newestStoredPrice([], true)).toBeNull();
  });
});

describe('items, guesses and non-items', () => {
  it('accepts a closest-match guess only when the search finds exactly that one item', () => {
    const h = setup();
    seedBook(h.repo);
    expect(h.check('Team Captian')).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
    h.search.hits = [{ sku: '378;6', name: 'Team Captain', category: 'hats', source: 'schema' }];
    expect(h.check('Team Captian')).toMatchObject({ status: 'item', sku: '378;6', reason: CHECK_FUZZY_NOTE });
    h.search.hits = [{ sku: '378;11', name: 'Strange Team Captain', category: 'hats', source: 'bptf' }];
    expect(h.check('Team Captian').status).toBe('not-item');
    h.search.hits = [
      { sku: '378;6', name: 'Team Captain', category: 'hats', source: 'schema' },
      { sku: '378;11', name: 'Strange Team Captain', category: 'hats', source: 'bptf' },
    ];
    expect(h.check('Team Captian').status).toBe('not-item');
  });

  it('notes, in fixed words, that an incomplete name was checked as the general item', () => {
    const h = setup();
    seedBook(h.repo);
    const r = h.check('Unusual Team Captain, 40 keys');
    expect(r).toMatchObject({ status: 'item', sku: '378;5', reason: CHECK_INCOMPLETE_NOTE, price: { keys: 40, source: 'clipboard' } });
    // With a sold-out copy both notes show.
    expect(h.check('Unusual Team Captain\tSold out').reason).toBe(`${CHECK_INCOMPLETE_NOTE} ${CHECK_SOLD_OUT_NOTE}`);
    expect(h.check('Team Captain').reason).toBeNull();
  });

  it('is not-item for a SKU nothing is known about, and says so while the schema is loading', () => {
    expect(setup().check('99999;6')).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON, verdict: null, revenue: null });
    const loading = setup({ loaded: false });
    expect(loading.check('Some Hat')).toMatchObject({ status: 'not-item', reason: CHECK_SCHEMA_LOADING_REASON });
    // SKUs still resolve without the schema.
    seedBook(loading.repo);
    expect(loading.check('378;6').status).toBe('item');
  });

  it('numbers every check and keeps the source and time', () => {
    const h = setup();
    seedBook(h.repo);
    const a = h.check('Team Captain', 'hotkey');
    const b = h.check('<b>x</b>', 'watch');
    h.clock.advance(5_000);
    const c = h.check('Team Captain', 'watch');
    expect([a.id, a.source, a.checkedAt]).toEqual([1, 'hotkey', T0]);
    expect([b.id, b.status, b.verdict]).toEqual([2, 'refused', null]);
    expect([c.id, c.source, c.checkedAt]).toEqual([3, 'watch', T0 + 5_000]);
  });
});

describe('recent ring, privacy and the network', () => {
  it('keeps the last 30 item results, newest first, as copies', () => {
    const h = setup();
    seedBook(h.repo);
    for (let i = 0; i < 35; i++) {
      h.check(`Team Captain, ${i + 1} ref`);
      h.check('nothing here');
      h.check('<i>markup</i>');
    }
    const recent = h.lc.recent();
    expect(recent).toHaveLength(CHECK_RECENT_MAX);
    expect(recent.every((r) => r.status === 'item')).toBe(true);
    expect(recent[0]!.price!.valueScrap).toBe(35 * 9);
    expect(recent.map((r) => r.id)).toEqual([...recent.map((r) => r.id)].sort((x, y) => y - x));
    recent[0]!.name = 'changed';
    expect(h.lc.recent()[0]!.name).not.toBe('changed');
  });

  it('never keeps, returns or logs the text, and makes no request', () => {
    const MARKER = 'Zq7MARKER';
    const h = setup();
    seedBook(h.repo);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const texts = [
      // An item whose row carries the marker in its pays column.
      `Team Captain\t1.33 ref\t${MARKER}\t3/5`,
      `team CAPTAIN  ,  ${MARKER}`,
      `${MARKER}, 1 ref`,
      `<${MARKER}>`,
      `${MARKER}\n1\n2\n3`,
      `https://scrap.tf/${MARKER}`,
      `Team Captain\n${MARKER}`,
    ];
    const results = texts.map((t) => h.check(t));
    expect(results[0]).toMatchObject({ status: 'item', sku: '378;6', scraptfPaysScrap: null, stock: 3 });
    const kept = JSON.stringify([results, h.lc.recent(), h.log.lines]);
    expect(kept).not.toContain(MARKER);
    expect(kept).not.toContain('team CAPTAIN');
    expect(h.http.calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws or logs the text when the resolver, search or a read fails', () => {
    const MARKER = 'Zq7MARKER';
    const repo = openRepo(':memory:');
    repos.push(repo);
    seedBook(repo);
    // The confidence fallback's book read fails (the index has not built, so it is needed).
    const failing = new Proxy(repo, {
      get(target, prop, recv) {
        if (prop === 'buyListingsByBaseSkus') return () => { throw new RangeError(`database is locked (${MARKER})`); };
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const h = setup({ repo: failing });
    const r = h.check('Team Captain, 1 ref');
    expect(r).toMatchObject({ status: 'item', confidence: null, confidenceLevel: null });
    expect(h.log.lines).toEqual([{ level: 'warn', msg: 'Live check could not score buyer confidence', meta: { sku: '378;6', error: 'RangeError' } }]);

    const lc = createLiveCheck({
      repo,
      schema: {
        ...createStubSchema(),
        resolve: (t: string) => {
          throw new Error(`cannot resolve ${t}`);
        },
        search: (q: string) => {
          throw new Error(`cannot search ${q}`);
        },
      },
      log: h.log,
      settings: () => testSettings(),
      keyPrice: () => {
        throw new Error('no key price');
      },
      market: { entryFor: () => null },
      scraptfList: { rowFor: () => null },
    });
    expect(lc.check(`${MARKER} hat, 1 ref`, 'watch', T0)).toMatchObject({ status: 'not-item', keyScrap: null });
    expect(JSON.stringify(h.log.lines)).not.toContain(MARKER);
  });
});
