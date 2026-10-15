// Live market index (F10): evaluation parity with the engine, verdicts, the
// user's scrap.tf side, generic any-effect books, dirty batching, chunked
// rebuilds, the onChanged throttle, and the list's filters, order and paging.
// Real in-memory repo, fake clock and timers; nothing here touches the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine, evaluateOpportunity, explicitInput, revenueOrderOf, ruleInput } from '../../src/service/domain/engine';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import {
  MARKET_DIRTY_BATCH_MS,
  MARKET_FULL_EVERY_MS,
  MARKET_NOTIFY_MS,
  MARKET_SLICE_MS,
  createMarketIndex,
  evaluateMarketBase,
  marketCsv,
  type MarketIndex,
} from '../../src/service/domain/market';
import { matchContext } from '../../src/service/domain/matcher';
import { lookupReferences, referencePrices } from '../../src/service/domain/pricing';
import { LOW_CAP } from '../../src/service/domain/tiers';
import { CSV_BOM } from '../../src/service/domain/csv';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { MARKET_CSV_COLUMNS, MARKET_SORTS, marketComparator, marketProfit, marketVerdict } from '../../src/shared/market';
import type { DeepPartial, Listing, MarketRow, MarketSort, PriceRule, Settings, UnixMs } from '../../src/shared/types';
import type { TimerApi } from '../../src/service/net/ratelimit';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, special } from './helpers';
import type { StubSchemaOptions } from './helpers';

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
});

function newRepo(): Repo {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  return repo;
}

type Changed = { changed: number; total: number; at: UnixMs };

interface Harness {
  repo: Repo;
  clock: FakeClock;
  timers: TimerApi & { advance(ms: number): void };
  settings: { current: Settings };
  /** What core's folder watcher reports (running or not). */
  watch: { on: boolean };
  market: MarketIndex;
  changes: Changed[];
  K: () => number;
}

function setup(
  opts: {
    repo?: Repo;
    settings?: DeepPartial<Settings>;
    schema?: StubSchemaOptions;
    schemaImpl?: SchemaService;
    timers?: (clock: FakeClock) => TimerApi & { advance(ms: number): void };
  } = {},
): Harness {
  const repo = opts.repo ?? newRepo();
  const clock = new FakeClock();
  const timers = opts.timers ? opts.timers(clock) : new FakeTimers(clock);
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, opts.settings ?? {}) };
  const schema = opts.schemaImpl ?? createStubSchema(opts.schema);
  const changes: Changed[] = [];
  const watch = { on: true };
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now());
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings.current),
    schema,
    timers,
    keyPrice,
    onChanged: (p) => changes.push(p),
    folderWatchActive: () => watch.on,
  });
  return { repo, clock, timers, settings, watch, market, changes, K: () => keyPrice().valueScrap };
}

/** Starts the index and runs the first build to the end (FakeTimers runs zero-delay chains at once). */
function build(h: Harness): void {
  h.market.start();
  h.timers.advance(0);
  expect(h.market.stats().building).toBe(false);
}

function rowOf(h: Harness, sku: string): MarketRow | undefined {
  return h.market.all({}, h.clock.now()).find((r) => r.sku === sku);
}

/** The Team Captain book from the engine walkthrough: a fresh online bot at 12 ref and two humans just below. */
function seedTeamCaptain(repo: Repo, now = T0): void {
  repo.upsertListings([
    makeListing({ id: 'tc-bot', steamid: 'S1', metalScrap: 108, isBot: true, uaLastPulse: Math.floor(now / 1000), userOnline: true, lastEventAt: now - MIN }),
    makeListing({ id: 'tc-h1', steamid: 'S2', metalScrap: 105, lastEventAt: now - MIN }),
    makeListing({ id: 'tc-h2', steamid: 'S3', metalScrap: 102, lastEventAt: now - 2 * MIN }),
  ]);
  repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 100, sellKeys: 0, sellScrap: 120, time: Math.floor(now / 1000), fetchedAt: now }]);
}

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

/** Timers that run one callback per step, so a test can look between the rebuild's chunks. */
class StepTimers {
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  constructor(private readonly clock: FakeClock) {}
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { at: this.clock.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  /** Runs the earliest timer due within `withinMs`; false when none is. */
  step(withinMs = 0): boolean {
    let next: [number, { at: number; fn: () => void }] | null = null;
    for (const e of this.pending) if (e[1].at <= this.clock.t + withinMs && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e;
    if (!next) return false;
    this.pending.delete(next[0]);
    this.clock.t = Math.max(this.clock.t, next[1].at);
    next[1].fn();
    return true;
  }
  advance(ms: number): void {
    const end = this.clock.t + ms;
    while (this.step(end - this.clock.t));
    this.clock.t = end;
  }
}

// ---------------------------------------------------------------------------
// Pure evaluation
// ---------------------------------------------------------------------------

describe('evaluateMarketBase', () => {
  const rule: PriceRule = { id: 1, name: 'any', filter: {}, costKeys: 0, costScrap: 40, observedAt: T0, enabled: true };

  for (const useOrder of ['conservative', 'best', 'instant'] as const) {
    it(`prices the book exactly like an opportunity on a clean copy (useOrder ${useOrder})`, () => {
      const settings = mergeSettings(DEFAULT_SETTINGS, { profit: { useOrder } });
      const base = '378;6';
      const listings = [
        buy(base, 300, { id: 'spike', steamid: 'X1' }), // an outlier above 1.3x the median of the top five
        buy(base, 108, { id: 'bot', steamid: 'S1', isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true }),
        buy(base, 105, { id: 'h1', steamid: 'S2' }),
        buy(base, 104, { id: 'h1-old', steamid: 'S2', lastEventAt: T0 - HOUR }), // same buyer, older: a duplicate
        buy(base, 102, { id: 'h2', steamid: 'S3' }),
        buy(base, 400, { id: 'mptf', steamid: 'M1', isMarketplace: true }),
        buy(base, 500, { id: 'painted', steamid: 'P1', special: special({ paint: 3100495 }) }), // attribute-specific
        buy(base, 450, { id: 'banned', steamid: 'B1', userBanned: true }),
      ];
      const references = { pricedb: { buyScrap: 100, sellScrap: 120, time: Math.floor(T0 / 1000), ageMs: 0 }, community: null };
      const match = matchContext(settings, T0);
      const opp = evaluateOpportunity({
        input: ruleInput(rule, base),
        listings,
        references,
        category: 'hats',
        isUnusual: false,
        settings,
        keyScrap: 567,
        now: T0,
        match,
        prev: null,
      });
      const ev = evaluateMarketBase({ base, listings, references, isUnusual: false, settings, keyScrap: 567, now: T0, match })!;
      expect(ev).not.toBeNull();
      expect(ev).toMatchObject({
        bestScrap: opp.bestScrap,
        consScrap: opp.consScrap,
        instantScrap: opp.instantScrap,
        revenueScrap: opp.revenueScrap,
        maxCostScrap: opp.maxCostScrap,
        buyerCount: opp.buyerCount,
      });
      expect(ev.revenueOrder).toEqual(revenueOrderOf(opp, useOrder));
      expect(ev.bestScrap).toBe(300);
      expect(ev.flags).toContain('outlier-best');
      expect(ev.eligibleCount).toBe(4);
      expect(ev.lastOrderChangeAt).toBe(T0 - MIN);
      // Only the buy side: none of the input's own flags.
      for (const f of ['rule-estimate', 'stale-input', 'suspect-margin']) expect(ev.flags).not.toContain(f);
    });
  }

  it('scores buy-side confidence from a fresh neutral input, without the suspect-margin cap a free typed price gets', () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    const base = '126;6';
    const pulse = Math.floor(T0 / 1000);
    const listings = [
      buy(base, 400, { id: 'a', steamid: 'A', isBot: true, uaLastPulse: pulse, userOnline: true }),
      buy(base, 395, { id: 'b', steamid: 'B' }),
    ];
    const references = { pricedb: null, community: null };
    const match = matchContext(settings, T0);
    const ev = evaluateMarketBase({ base, listings, references, isUnusual: false, settings, keyScrap: 567, now: T0, match })!;
    // 50 + 20 active bot + 5 online + 10 confirmed + 10 two buyers within 10% - 10 no reference.
    expect(ev.confidence).toBe(85);
    expect(ev.confidenceLevel).toBe('high');
    expect(ev.flags).toEqual(['no-reference']);

    // The engine's guard reads a free item's profit as an unbounded margin and caps the row at Low.
    const free = explicitInput({ id: 9, sku: base, name: "Bill's Hat", costKeys: 0, costScrap: 0, source: 'user', observedAt: T0, note: null, importBatch: null, special: null, assetId: null, stock: null })!;
    const opp = evaluateOpportunity({ input: free, listings, references, category: 'hats', isUnusual: false, settings, keyScrap: 567, now: T0, match, prev: null });
    expect(opp.flags).toContain('suspect-margin');
    expect(opp.confidence).toBeLessThanOrEqual(LOW_CAP);
  });

  it('keeps the unverified-orders and stale-reference flags', () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    const base = '378;6';
    const listings = [buy(base, 120, { id: 'old', steamid: 'O', lastEventAt: T0 - 30 * HOUR })];
    const stale = { pricedb: { buyScrap: 100, sellScrap: 110, time: Math.floor((T0 - 400 * 24 * HOUR) / 1000), ageMs: 400 * 24 * HOUR }, community: null };
    const ev = evaluateMarketBase({ base, listings, references: stale, isUnusual: false, settings, keyScrap: 567, now: T0, match: matchContext(settings, T0) })!;
    expect(ev.flags).toEqual(expect.arrayContaining(['unverified-orders', 'stale-reference']));
    // The stale PriceDB sell price must not make the 120 order an outlier.
    expect(ev.revenueScrap).toBe(120);
  });

  it('returns null when no order is eligible', () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { blocklist: ['BL'] });
    const base = '378;6';
    const listings = [
      buy(base, 400, { id: 'm', steamid: 'M', isMarketplace: true }),
      buy(base, 200, { id: 'p', steamid: 'P', special: special({ spells: ['exorcism'] }) }),
      buy(base, 150, { id: 'bl', steamid: 'BL' }),
      buy(base, 150, { id: 's', steamid: 'S', intent: 'sell' }),
    ];
    const ev = evaluateMarketBase({ base, listings, references: { pricedb: null, community: null }, isUnusual: false, settings, keyScrap: 567, now: T0, match: matchContext(settings, T0) });
    expect(ev).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

describe('createMarketIndex: entries and the engine', () => {
  it("values a base exactly like the engine's opportunity row for the same book", async () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 90, source: 'user', observedAt: T0 - MIN });
    const clock = new FakeClock();
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    const engine = createEngine({ ...makeDeps(repo, clock, () => settings), schema: createStubSchema(), events: recordingEvents(), timers: new FakeTimers(clock) });
    await engine.runNow();
    const opp = repo.allOpportunities().find((o) => o.sku === '378;6')!;
    expect(opp.status).toBe('profitable');

    const h = setup({ repo });
    build(h);
    const row = rowOf(h, '378;6')!;
    expect(row).toMatchObject({
      name: 'Team Captain',
      category: 'hats',
      revenueScrap: opp.revenueScrap,
      bestScrap: opp.bestScrap,
      consScrap: opp.consScrap,
      instantScrap: opp.instantScrap,
      maxCostScrap: opp.maxCostScrap,
      buyerCount: opp.buyerCount,
      knownCostScrap: 90,
      knownSource: 'typed',
      knownObservedAt: T0 - MIN,
      stock: null,
      profitScrap: opp.profitScrap,
      verdict: 'flip',
      lastOrderChangeAt: T0 - MIN,
      evaluatedAt: T0,
    });
    expect(row.revenueOrder).toEqual(revenueOrderOf(opp, 'conservative'));
    expect(h.market.stats()).toMatchObject({ entries: 1, building: false, progress: 1, lastFullAt: T0, pendingDirty: 0 });
  });

  it('gives each row its verdict and counts every verdict while a verdict filter is on', () => {
    const repo = newRepo();
    repo.upsertListings([
      // flip: 378;6 sells for 105 (conservative), typed 18.
      ...['a', 'b', 'c'].map((s, i) => buy('378;6', 105 - i, { id: `tc-${s}`, steamid: `TC${s}` })),
      // over: 126;6 sells for 30, typed 500.
      buy('126;6', 30, { id: 'bh', steamid: 'BH', isBot: true }),
      // rule-flip: 205;6 sells for 60, no price, a rule at 20 for defindex 205.
      buy('205;6', 60, { id: 'rl', steamid: 'RL' }),
      // unchecked: 15000;6 sells for 80, no price, no matching rule.
      buy('15000;6', 80, { id: 'sr', steamid: 'SR' }),
      // a currency book is never a market row.
      buy('5021;6', 560, { id: 'key', steamid: 'KEY' }),
    ]);
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 18, source: 'user', observedAt: T0 - MIN });
    repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 500, source: 'user', observedAt: T0 - MIN });
    // no-buyers: a typed price, no orders at all.
    repo.upsertScrapPrice({ sku: '30920;6', name: 'Taunt: The Bunnyhopper', costScrap: 200, source: 'user', observedAt: T0 - MIN });
    repo.upsertRule({ name: 'Rocket Launchers', filter: { defindexes: [205] }, costScrap: 20, observedAt: T0 });
    const h = setup({ repo });
    build(h);

    const all = h.market.all({}, T0);
    const verdicts = Object.fromEntries(all.map((r) => [r.sku, r.verdict]));
    expect(verdicts).toEqual({ '378;6': 'flip', '126;6': 'over', '205;6': 'rule-flip', '15000;6': 'unchecked', '30920;6': 'no-buyers' });
    for (const r of all) {
      expect(r.verdict).toBe(marketVerdict(r));
      expect(r.profitScrap).toBe(marketProfit(r.revenueScrap, r.knownCostScrap, h.settings.current.profit));
    }
    expect(rowOf(h, '205;6')!.ruleCostScrap).toBe(20);
    expect(rowOf(h, '15000;6')!.ruleCostScrap).toBeNull();
    expect(rowOf(h, '30920;6')).toMatchObject({ buyerCount: 0, revenueScrap: null, maxCostScrap: null, confidence: 0, confidenceLevel: 'low', flags: [], revenueOrder: null });
    expect(h.market.stats().entries).toBe(4); // the known-only row is a row, not an entry

    const flips = h.market.list({ verdicts: ['flip'] }, T0);
    expect(flips.rows.map((r) => r.sku)).toEqual(['378;6']);
    expect(flips.total).toBe(1);
    expect(flips.counts).toEqual({ flip: 1, 'rule-flip': 1, unchecked: 1, over: 1, 'no-buyers': 1 });

    // Other filters do narrow the counts.
    const typed = h.market.list({ sources: ['typed'] }, T0);
    expect(typed.rows.map((r) => r.sku).sort()).toEqual(['126;6', '30920;6', '378;6']);
    expect(typed.counts).toEqual({ flip: 1, 'rule-flip': 0, unchecked: 0, over: 1, 'no-buyers': 1 });
    expect(h.market.list({ sources: ['none'] }, T0).rows.map((r) => r.sku).sort()).toEqual(['15000;6', '205;6']);
    expect(h.market.list({ categories: ['weapons'] }, T0).rows.map((r) => r.sku).sort()).toEqual(['15000;6', '205;6']);
    expect(h.market.list({ onlyBotBuyers: true }, T0).rows.map((r) => r.sku)).toEqual(['126;6']);
    expect(h.market.list({ minBuyers: 2 }, T0).rows.map((r) => r.sku)).toEqual(['378;6']);
    expect(h.market.list({ minCeilingScrap: 60 }, T0).rows.every((r) => (r.maxCostScrap ?? 0) >= 60)).toBe(true);
    expect(h.market.list({ search: 'team CAPTAIN' }, T0).rows.map((r) => r.sku)).toEqual(['378;6']);
    expect(h.market.list({ search: '15000;6' }, T0).rows.map((r) => r.sku)).toEqual(['15000;6']);
    expect(h.market.list({ search: 'bunny' }, T0).rows.map((r) => r.sku)).toEqual(['30920;6']);
  });

  it("joins the user's side: the newer of typed and saved page wins, stock comes from pages, extras are flagged", () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc' }), buy('126;6', 60, { id: 'bh' }), buy('205;6', 60, { id: 'rl' })]);
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 90, source: 'user', observedAt: T0 - 10 * MIN });
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 80, source: 'import', observedAt: T0 - 5 * MIN, stock: 3 });
    repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 40, source: 'user', observedAt: T0 - MIN });
    repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 30, source: 'import', observedAt: T0 - HOUR, stock: 7 });
    // A painted copy: still the row's price, but the ceiling is for a clean one.
    repo.upsertScrapPrice({ sku: '205;6', name: 'Rocket Launcher', costKeys: 1, costScrap: 9, source: 'user', observedAt: T0 - MIN, special: special({ paint: 3100495 }) });
    // Same time: the higher id wins.
    repo.upsertScrapPrice({ sku: '30920;6', name: 'Taunt', costScrap: 50, source: 'user', observedAt: T0 - 2 * MIN });
    repo.upsertScrapPrice({ sku: '30920;6', name: 'Taunt', costScrap: 55, source: 'import', observedAt: T0 - 2 * MIN, stock: 1 });
    const h = setup({ repo });
    build(h);

    expect(rowOf(h, '378;6')).toMatchObject({ knownSource: 'page', knownCostScrap: 80, knownObservedAt: T0 - 5 * MIN, stock: 3 });
    expect(rowOf(h, '126;6')).toMatchObject({ knownSource: 'typed', knownCostScrap: 40, stock: null });
    const painted = rowOf(h, '205;6')!;
    expect(painted).toMatchObject({ knownSource: 'typed', knownCostScrap: h.K() + 9 });
    expect(painted.flags).toContain('has-extras');
    expect(rowOf(h, '378;6')!.flags).not.toContain('has-extras');
    expect(rowOf(h, '30920;6')).toMatchObject({ knownSource: 'page', knownCostScrap: 55, stock: 1 });

    const r = h.market.list({}, T0);
    expect(r.scraptf).toEqual({ typed: 4, pages: 3, newestPageAt: T0 - 2 * MIN, importEnabled: false, watchFolder: false, coverage: expect.any(Array) });
    // These page prices belong to no import batch, so every bank page reads "never saved" (F13, marketHooks.test.ts).
    expect(r.scraptf.coverage.map((c) => [c.label, c.lastSavedAt, c.items])).toEqual(
      ['Hats', 'Weapons', 'Stranges', 'Killstreaks', 'Skins', 'Items', 'Unusuals'].map((l) => [l, null, 0]),
    );
    expect(h.market.list({ sources: ['page'] }, T0).rows.map((x) => x.sku).sort()).toEqual(['30920;6', '378;6']);

    h.settings.current = mergeSettings(h.settings.current, { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'C:/saved' } });
    expect(h.market.list({}, T0).scraptf).toMatchObject({ importEnabled: true, watchFolder: true });
    // A chosen folder whose watch is not running (folder missing, OS watch failed) is not "on".
    h.watch.on = false;
    expect(h.market.list({}, T0).scraptf).toMatchObject({ importEnabled: true, watchFolder: false });
    // And import switched off reads off whatever the watcher says.
    h.watch.on = true;
    h.settings.current = mergeSettings(h.settings.current, { import: { enabled: false } });
    expect(h.market.list({}, T0).scraptf).toMatchObject({ importEnabled: false, watchFolder: false });
  });

  it('reads the generic any-effect book for effect-specific unusuals and re-evaluates them when it changes', () => {
    const repo = newRepo();
    const generic = '378;5';
    const effect = '378;5;u13';
    repo.upsertListings([buy(generic, 0, { id: 'any-1', steamid: 'G1', keys: 10 }), buy(effect, 0, { id: 'own-1', steamid: 'E1', keys: 9 })]);
    // An effect with no orders of its own, known only through the user's price.
    repo.upsertScrapPrice({ sku: '378;5;u702', name: 'Isotope Team Captain', costKeys: 8, costScrap: 0, source: 'user', observedAt: T0 - MIN });
    const h = setup({ repo });
    build(h);
    const K = h.K();

    const own = rowOf(h, effect)!;
    expect(own.revenueScrap).toBe(10 * K); // the generic order beats its own 9-key one
    expect(own.revenueOrder?.flags).toContain('any-effect');
    expect(own.buyerCount).toBe(2);
    const iso = rowOf(h, '378;5;u702')!;
    expect(iso).toMatchObject({ revenueScrap: 10 * K, buyerCount: 1, knownCostScrap: 8 * K, verdict: 'flip', category: 'unusuals' });
    expect(rowOf(h, generic)).toMatchObject({ revenueScrap: 10 * K, category: 'unusuals' });

    // A better generic order: only the generic base is marked, its effects follow.
    repo.upsertListings([buy(generic, 0, { id: 'any-2', steamid: 'G2', keys: 12 })]);
    h.market.markDirty([generic]);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(rowOf(h, generic)!.revenueScrap).toBe(12 * K);
    expect(rowOf(h, effect)!.revenueScrap).toBe(12 * K);
    expect(rowOf(h, '378;5;u702')!.revenueScrap).toBe(12 * K);

    // The generic book empties: the effect without orders of its own has no buyers left.
    repo.deleteListings(['any-1', 'any-2']);
    h.market.markDirty([generic]);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(rowOf(h, generic)).toBeUndefined();
    expect(rowOf(h, effect)!.revenueScrap).toBe(9 * K);
    expect(rowOf(h, '378;5;u702')).toMatchObject({ verdict: 'no-buyers', buyerCount: 0 });
  });

  it('re-evaluates an effect whose own orders are all ineligible when the generic book changes, as a rebuild would list it', () => {
    const repo = newRepo();
    const generic = '378;5';
    const effect = '378;5;u13';
    // Only marketplace.tf buys this effect: not a row on its own.
    repo.upsertListings([buy(effect, 0, { id: 'mptf', steamid: 'M1', keys: 30, isMarketplace: true })]);
    const h = setup({ repo });
    build(h);
    const skus = () => h.market.all({}, T0).map((r) => r.sku).sort();
    expect(skus()).toEqual([]);

    // A generic order arrives: only the generic base is marked, and the effect follows in the same batch.
    repo.upsertListings([buy(generic, 0, { id: 'any-1', steamid: 'G1', keys: 10 })]);
    h.market.markDirty([generic]);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(skus()).toEqual([generic, effect]);
    expect(rowOf(h, effect)).toMatchObject({ revenueScrap: 10 * h.K(), buyerCount: 1 });

    // The generic book empties and comes back: the effect leaves and returns with it.
    repo.deleteListings(['any-1']);
    h.market.markDirty([generic]);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(skus()).toEqual([]);
    repo.upsertListings([buy(generic, 0, { id: 'any-2', steamid: 'G2', keys: 11 })]);
    h.market.markDirty([generic]);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(skus()).toEqual([generic, effect]);
    expect(rowOf(h, effect)!.revenueScrap).toBe(11 * h.K());

    // The periodic rebuild agrees with the dirty path.
    h.timers.advance(MARKET_FULL_EVERY_MS);
    expect(skus()).toEqual([generic, effect]);
  });

  it('refreshes the known prices and rule estimates on pricesChanged without a rebuild or a change push', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertRule({ name: 'Hats', filter: { categories: ['hats'] }, costScrap: 50, observedAt: T0 });
    repo.upsertRule({ name: 'Cheap hats (off)', filter: { categories: ['hats'] }, costScrap: 10, observedAt: T0, enabled: false });
    repo.upsertRule({ name: 'Everything', filter: {}, costScrap: 70, observedAt: T0 });
    const h = setup({ repo });
    build(h);
    const pushes = h.changes.length;
    const fullAt = h.market.stats().lastFullAt;
    expect(rowOf(h, '378;6')).toMatchObject({ ruleCostScrap: 50, verdict: 'rule-flip', knownSource: 'none' });

    repo.upsertRule({ name: 'Cheaper hats', filter: { categories: ['hats'] }, costScrap: 20, observedAt: T0 });
    expect(rowOf(h, '378;6')!.ruleCostScrap).toBe(50); // cached until told
    h.market.pricesChanged();
    expect(rowOf(h, '378;6')!.ruleCostScrap).toBe(20);

    // A typed price above the ceiling: the verdict moves at once.
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 300, source: 'user', observedAt: T0 });
    h.market.pricesChanged();
    expect(rowOf(h, '378;6')).toMatchObject({ verdict: 'over', knownCostScrap: 300, ruleCostScrap: 20 });
    h.timers.advance(MARKET_DIRTY_BATCH_MS * 2);
    expect(h.changes.length).toBe(pushes);
    expect(h.market.stats().lastFullAt).toBe(fullAt);
  });

  it('lists an effect only a generic book buys only while it has a price, as a rebuild after a restart would', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;5', 0, { id: 'any', steamid: 'G', keys: 3 }), buy('378;5;u13', 0, { id: 'own', steamid: 'E', keys: 2 })]);
    const iso = repo.upsertScrapPrice({ sku: '378;5;u702', name: 'Isotope Team Captain', costKeys: 2, costScrap: 0, source: 'user', observedAt: T0 });
    // An effect with orders of its own stays whether or not it has a price.
    const bf = repo.upsertScrapPrice({ sku: '378;5;u13', name: 'Burning Flames Team Captain', costKeys: 1, costScrap: 0, source: 'user', observedAt: T0 });
    const h = setup({ repo });
    build(h);
    expect(rowOf(h, '378;5;u702')).toMatchObject({ verdict: 'flip', buyerCount: 1 });
    expect(h.market.stats().entries).toBe(3);
    const pushes = h.changes.length;

    repo.deleteScrapPrice(iso.id);
    repo.deleteScrapPrice(bf.id);
    h.market.pricesChanged();
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(rowOf(h, '378;5;u702')).toBeUndefined();
    expect(rowOf(h, '378;5;u13')).toMatchObject({ knownSource: 'none', buyerCount: 2 });
    expect(h.market.stats().entries).toBe(2);
    expect(h.changes.at(-1)).toMatchObject({ total: 2 });
    expect(h.changes.length).toBe(pushes + 1);

    // The periodic rebuild agrees, and so does a fresh index (a restart).
    h.timers.advance(MARKET_FULL_EVERY_MS);
    expect(h.market.all({}, T0).map((r) => r.sku).sort()).toEqual(['378;5', '378;5;u13']);
    const fresh = setup({ repo });
    build(fresh);
    expect(fresh.market.all({}, T0).map((r) => r.sku).sort()).toEqual(['378;5', '378;5;u13']);
  });

  it('keeps rule estimates across price writes and re-reads the rules after every write', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertListings([buy('126;6', 60, { id: 'bh', steamid: 'BH' })]);
    const hats = repo.upsertRule({ name: 'Hats', filter: { categories: ['hats'] }, costScrap: 30, observedAt: T0 });
    const h = setup({ repo });
    build(h);
    expect(rowOf(h, '126;6')!.ruleCostScrap).toBe(30);
    const reads = vi.spyOn(repo, 'listRules');

    // A price write: the rule list is read again, the estimates stay.
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 50, source: 'user', observedAt: T0 });
    h.market.pricesChanged();
    expect(rowOf(h, '126;6')).toMatchObject({ ruleCostScrap: 30, verdict: 'rule-flip' });
    expect(rowOf(h, '378;6')).toMatchObject({ ruleCostScrap: 30, knownCostScrap: 50 });
    expect(reads).toHaveBeenCalledTimes(1);
    h.market.list({}, T0);
    expect(reads).toHaveBeenCalledTimes(1); // nothing written since: no re-read

    // A rule switched off: every estimate follows.
    repo.upsertRule({ id: hats.id, name: 'Hats', filter: { categories: ['hats'] }, costScrap: 30, observedAt: T0, enabled: false });
    h.market.pricesChanged();
    expect(rowOf(h, '126;6')).toMatchObject({ ruleCostScrap: null, verdict: 'unchecked' });
  });

  it('evaluates a newly priced item without an entry within one batch (an effect only a generic book buys)', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;5', 0, { id: 'any', steamid: 'G', keys: 3 })]);
    const h = setup({ repo });
    build(h);
    expect(rowOf(h, '378;5;u13')).toBeUndefined();

    repo.upsertScrapPrice({ sku: '378;5;u13', name: 'Burning Flames Team Captain', costKeys: 2, costScrap: 0, source: 'user', observedAt: T0 });
    h.market.pricesChanged();
    expect(rowOf(h, '378;5;u13')).toMatchObject({ verdict: 'no-buyers' });
    expect(h.market.stats().pendingDirty).toBe(1);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(rowOf(h, '378;5;u13')).toMatchObject({ verdict: 'flip', revenueScrap: 3 * h.K(), buyerCount: 1 });
  });
});

describe('createMarketIndex: cadence', () => {
  it('batches dirty bases and evaluates them at most every 2 s', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertListings([buy('126;6', 60, { id: 'bh', steamid: 'BH' })]);
    const h = setup({ repo });
    build(h);
    const reads = vi.spyOn(repo, 'buyListingsByBaseSkus');

    h.market.markDirty(['378;6']);
    h.timers.advance(500);
    h.market.markDirty(new Set(['126;6;p3100495', '5021;6', '  ', 42 as unknown as string]));
    h.market.markDirty(null as unknown as string[]);
    expect(h.market.stats().pendingDirty).toBe(2); // paint stripped, currency and junk ignored
    h.timers.advance(MARKET_DIRTY_BATCH_MS - 501);
    expect(reads).not.toHaveBeenCalled();
    h.timers.advance(1);
    expect(reads).toHaveBeenCalledTimes(1);
    expect([...reads.mock.calls[0]![0]].sort()).toEqual(['126;6', '378;6']);
    expect(h.market.stats().pendingDirty).toBe(0);

    // A mark right after a batch waits for the next one.
    h.market.markDirty(['378;6']);
    h.timers.advance(MARKET_DIRTY_BATCH_MS - 1);
    expect(reads).toHaveBeenCalledTimes(1);
    h.timers.advance(1);
    expect(reads).toHaveBeenCalledTimes(2);

    // Nothing pending: nothing is read.
    h.timers.advance(10 * MARKET_DIRTY_BATCH_MS);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('rebuilds in chunks, yielding between them, while the old entries stay visible', () => {
    const repo = newRepo();
    const N = 4_500;
    const listings: Listing[] = [];
    for (let i = 0; i < N; i++) listings.push(buy(`${100_000 + i};6`, 20 + (i % 50), { id: `l${i}`, steamid: `S${i % 997}` }));
    repo.upsertListings(listings);
    let stepper!: StepTimers;
    const h = setup({
      repo,
      schema: { items: [], categoryOf: () => 'hats', nameOf: (s) => `Item ${s}` },
      timers: (clock) => (stepper = new StepTimers(clock)),
    });

    h.market.start();
    expect(h.market.stats()).toMatchObject({ building: true, progress: 0, entries: 0 });
    // The candidate scan is a slice of its own.
    expect(stepper.step()).toBe(true);
    expect(h.market.stats()).toMatchObject({ building: true, progress: 0, entries: 0 });
    const progress: number[] = [];
    let slices = 0;
    while (h.market.stats().building) {
      expect(stepper.step()).toBe(true);
      slices++;
      progress.push(h.market.stats().progress);
      if (slices === 1) {
        // One chunk did part of the work and handed the event loop back.
        expect(h.market.stats().entries).toBeGreaterThan(0);
        expect(h.market.stats().entries).toBeLessThan(N);
        expect(h.market.stats().progress).toBeGreaterThan(0);
        expect(h.market.stats().progress).toBeLessThan(1);
      }
    }
    expect(slices).toBeGreaterThanOrEqual(3);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(h.market.stats()).toMatchObject({ entries: N, building: false, progress: 1, lastFullAt: T0 });

    // Books change behind the index's back; a rebuild replaces entries as it reaches them.
    const gone = Array.from({ length: 500 }, (_, i) => `l${N - 1 - i}`);
    repo.deleteListings(gone);
    const candidates = vi.spyOn(repo, 'baseSkusWithBuyOrders');
    h.market.markAllDirty();
    h.market.markAllDirty(); // coalesced into one rebuild
    expect(stepper.step()).toBe(true);
    expect(stepper.step()).toBe(true);
    expect(h.market.stats().building).toBe(true);
    expect(h.market.stats().progress).toBeGreaterThan(0);
    expect(h.market.stats().entries).toBe(N); // the vanished ones are re-read last and still shown
    while (h.market.stats().building) stepper.step();
    expect(candidates).toHaveBeenCalledTimes(1);
    expect(h.market.stats().entries).toBe(N - 500);

    // A request while building restarts the rebuild (settings moved mid-way).
    h.market.markAllDirty();
    stepper.step();
    stepper.step();
    expect(h.market.stats().progress).toBeGreaterThan(0);
    h.market.markAllDirty();
    stepper.step();
    expect(h.market.stats()).toMatchObject({ building: true, progress: 0 });
    while (h.market.stats().building) stepper.step();
    expect(candidates).toHaveBeenCalledTimes(3);
  });

  it('ends a slice once it has used the slice budget, even when a batch costs far more per base than the one before', () => {
    const repo = newRepo();
    const plain = Array.from({ length: 3000 }, (_, i) => `${100_000 + i};6`);
    const generic = '378;5';
    const effects = Array.from({ length: 600 }, (_, i) => `378;5;u${1000 + i}`);
    repo.upsertListings([
      ...plain.map((sku, i) => buy(sku, 30, { id: `p${i}`, steamid: `P${i}` })),
      ...effects.map((sku, i) => buy(sku, 0, { id: `e${i}`, steamid: `E${i}`, keys: 2 })),
      buy(generic, 0, { id: 'g1', steamid: 'G1', keys: 3 }),
    ]);
    // A slice clock the test controls: evaluating an effect (its own book plus the generic one,
    // which the engine also reads) costs 1 ms, a plain base 0.01 ms. Each evaluation reads its references once.
    let t = 0;
    const slices: number[] = [];
    const now = vi.spyOn(performance, 'now').mockImplementation(() => t);
    const getPricedb = repo.getPricedb.bind(repo);
    vi.spyOn(repo, 'getPricedb').mockImplementation((sku: string) => {
      t += sku.includes(';u') ? 1 : 0.01;
      return getPricedb(sku);
    });
    try {
      const h = setup({
        repo,
        schema: { items: [], categoryOf: () => 'hats' },
        timers: (clock) => {
          const inner = new FakeTimers(clock);
          return {
            setTimeout: (fn: () => void, ms: number) =>
              inner.setTimeout(() => {
                const s = t;
                fn();
                slices.push(t - s);
              }, ms),
            clearTimeout: (handle: unknown) => inner.clearTimeout(handle),
            advance: (ms: number) => inner.advance(ms),
          };
        },
      });
      // The rebuild reads the cheap plain cluster first, then the costly effect cluster (base_sku order).
      build(h);
      expect(h.market.stats().entries).toBe(plain.length + effects.length + 1);
      const limit = MARKET_SLICE_MS + 1; // the budget plus the one base that crossed it
      expect(Math.max(...slices)).toBeLessThanOrEqual(limit);

      for (let round = 0; round < 3; round++) {
        slices.length = 0;
        // A cheap batch grows the chunk size (it is sized from the last slice's cost per base)...
        h.market.markDirty(plain.slice(round * 400, round * 400 + 400));
        h.timers.advance(MARKET_DIRTY_BATCH_MS);
        // ...then one generic change fans out to every effect that reads its book.
        repo.upsertListings([buy(generic, 0, { id: `g${round + 2}`, steamid: `G${round + 2}`, keys: 4 + round })]);
        h.market.markDirty([generic]);
        h.timers.advance(MARKET_DIRTY_BATCH_MS);
        expect(Math.max(...slices), `round ${round}`).toBeLessThanOrEqual(limit);
        // Every base was still evaluated, over several slices.
        expect(slices.length).toBeGreaterThan(2);
        expect(h.market.stats().pendingDirty).toBe(0);
        for (const sku of [effects[0]!, effects[599]!]) expect(rowOf(h, sku)!.bestScrap).toBe((4 + round) * h.K());
      }
    } finally {
      now.mockRestore();
    }
  });

  it('rebuilds every 10 min, dropping entries whose orders went without a markDirty', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertListings([buy('126;6', 60, { id: 'bh', steamid: 'BH' })]);
    const h = setup({ repo });
    build(h);
    expect(h.market.stats().entries).toBe(2);
    // The daily purge deletes listings directly.
    repo.deleteListings(['bh']);
    h.clock.advance(1);
    h.timers.advance(MARKET_FULL_EVERY_MS - 2);
    expect(h.market.stats().entries).toBe(2);
    h.timers.advance(1);
    expect(h.market.stats()).toMatchObject({ entries: 1, lastFullAt: T0 + MARKET_FULL_EVERY_MS });
    expect(h.changes.at(-1)).toMatchObject({ changed: 1, total: 1 });
    // And again 10 min after that one.
    h.timers.advance(MARKET_FULL_EVERY_MS);
    expect(h.market.stats().lastFullAt).toBe(T0 + 2 * MARKET_FULL_EVERY_MS);
  });

  it('waits for the schema before the first build, and rebuilds names once it loads', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    const stub = createStubSchema();
    let loaded = false;
    const schema: SchemaService = { ...stub, isLoaded: () => loaded, nameForSku: (sku) => (loaded ? stub.nameForSku(sku) : sku) };
    const h = setup({ repo, schemaImpl: schema });
    h.market.start();
    h.timers.advance(0);
    expect(h.market.stats()).toMatchObject({ entries: 0, building: true, lastFullAt: null });
    // core.start(): schema.init() resolved without a schema (first download failed).
    h.market.markAllDirty();
    h.timers.advance(0);
    expect(rowOf(h, '378;6')!.name).toBe('378;6');
    loaded = true;
    // Noticed on the next read (or batch, or periodic tick).
    h.market.list({}, T0);
    h.timers.advance(0);
    expect(rowOf(h, '378;6')!.name).toBe('Team Captain');
  });

  it('builds once at start when core marks everything dirty right after the schema loads', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    const stub = createStubSchema();
    let loaded = false;
    let stepper!: StepTimers;
    const h = setup({ repo, schemaImpl: { ...stub, isLoaded: () => loaded }, timers: (clock) => (stepper = new StepTimers(clock)) });
    const scans = vi.spyOn(repo, 'baseSkusWithBuyOrders');
    h.market.start(); // core.start(): before schema.init()
    loaded = true; // schema.init() resolved with the cached schema
    h.market.markAllDirty();
    expect(stepper.step()).toBe(true); // the rebuild has begun
    h.market.list({}, T0); // a read now must not restart it for the same load
    while (h.market.stats().building) stepper.step();
    stepper.advance(MARKET_DIRTY_BATCH_MS);
    expect(scans).toHaveBeenCalledTimes(1);
    expect(rowOf(h, '378;6')!.name).toBe('Team Captain');
  });

  it('shows known-only rows during the first build only for bases it has reached', () => {
    const repo = newRepo();
    const N = 3_000;
    repo.upsertListings(Array.from({ length: N }, (_, i) => buy(`${100_000 + i};6`, 30, { id: `l${i}`, steamid: `S${i}` })));
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 40, source: 'user', observedAt: T0 });
    let stepper!: StepTimers;
    const h = setup({ repo, schema: { items: [], categoryOf: () => 'hats' }, timers: (clock) => (stepper = new StepTimers(clock)) });
    expect(h.market.list({}, T0).total).toBe(0); // not started: nothing is known yet
    h.market.start();
    stepper.step();
    expect(h.market.stats().building).toBe(true);
    expect(rowOf(h, '378;6')).toBeUndefined();
    while (h.market.stats().building) stepper.step();
    expect(rowOf(h, '378;6')).toMatchObject({ verdict: 'no-buyers', knownCostScrap: 40 });
  });

  it('pushes onChanged at most every 2 s and only when revenue, ceiling, buyers or the revenue order moved', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertListings([buy('126;6', 60, { id: 'bh', steamid: 'BH' })]);
    const h = setup({ repo });
    build(h);
    expect(h.changes).toEqual([{ changed: 2, total: 2, at: T0 }]);

    // Seen again by the feed: same price, same buyer, nothing the push reports.
    h.timers.advance(10_000);
    repo.upsertListings([buy('126;6', 60, { id: 'bh', steamid: 'BH', lastEventAt: h.clock.now() })]);
    h.market.markDirty(['126;6']);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    expect(h.changes).toHaveLength(1);
    expect(rowOf(h, '126;6')!.lastOrderChangeAt).toBe(T0 + 10_000);

    // A better order: pushed at once (the last push is long ago).
    repo.upsertListings([buy('126;6', 70, { id: 'bh2', steamid: 'BH2' })]);
    h.market.markDirty(['126;6']);
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    const firstAt = h.clock.now();
    expect(h.changes).toHaveLength(2);
    expect(h.changes[1]).toEqual({ changed: 1, total: 2, at: firstAt });

    // Two more moves within 2 s: one push, after the 2 s, with both counted.
    repo.upsertListings([buy('126;6', 80, { id: 'bh3', steamid: 'BH3' })]);
    h.market.markAllDirty();
    h.timers.advance(0);
    repo.deleteListings(['tc-bot', 'tc-h1', 'tc-h2']);
    h.market.markAllDirty();
    h.timers.advance(0);
    expect(h.changes).toHaveLength(2);
    h.timers.advance(MARKET_NOTIFY_MS - 1);
    expect(h.changes).toHaveLength(2);
    h.timers.advance(1);
    expect(h.changes).toHaveLength(3);
    expect(h.changes[2]).toEqual({ changed: 2, total: 1, at: firstAt });
    expect(h.market.stats().lastChangeAt).toBe(firstAt);
  });

  it('stops cleanly and keeps serving its last state', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    let stepper!: StepTimers;
    const h = setup({ repo, timers: (clock) => (stepper = new StepTimers(clock)) });
    h.market.start();
    while (h.market.stats().building) stepper.step();
    h.market.markDirty(['378;6']);
    h.market.stop();
    expect(stepper.step(MARKET_FULL_EVERY_MS * 2)).toBe(false); // no timer left behind
    expect(h.market.list({}, T0).rows.map((r) => r.sku)).toEqual(['378;6']);
    expect(h.market.stats()).toMatchObject({ building: false, pendingDirty: 1 });
  });
});

describe('createMarketIndex: list order, paging and CSV', () => {
  /** ~300 rows with many equal ceilings, null ceilings, equal names, known-only rows and missing values. */
  function marketOfMany(): Harness {
    const repo = newRepo();
    const listings: Listing[] = [];
    for (let i = 0; i < 280; i++) {
      const sku = `${200_000 + i};6`;
      // Values under 9 scrap have no ceiling; many share a ceiling.
      const v = i % 9 === 0 ? 5 : 20 + (i % 13) * 7;
      listings.push(buy(sku, v, { id: `m${i}`, steamid: `A${i}`, isBot: i % 4 === 0, lastEventAt: T0 - (i % 17) * MIN }));
      if (i % 3 === 0) listings.push(buy(sku, v - 1, { id: `n${i}`, steamid: `B${i}` }));
    }
    repo.upsertListings(listings);
    for (let i = 0; i < 280; i += 5) repo.upsertScrapPrice({ sku: `${200_000 + i};6`, name: 'x', costScrap: 10 + (i % 40), source: i % 10 === 0 ? 'import' : 'user', observedAt: T0 - i * MIN, stock: 2 });
    for (let i = 0; i < 25; i++) repo.upsertScrapPrice({ sku: `${300_000 + i};6`, name: 'x', costScrap: 30, source: 'user', observedAt: T0 - i * MIN });
    repo.upsertRule({ name: 'Cheap', filter: { defindexes: Array.from({ length: 50 }, (_, i) => 200_000 + i * 2) }, costScrap: 25, observedAt: T0 });
    // Few distinct names, so the SKU tie-break decides often.
    const h = setup({ repo, schema: { items: [], categoryOf: (d) => (d % 2 ? 'hats' : 'weapons'), nameOf: (s) => `Item ${Number(s.split(';')[0]) % 23}` } });
    build(h);
    return h;
  }

  it('orders every sort and direction exactly like the shared marketComparator', () => {
    const h = marketOfMany();
    const rows = h.market.all({}, T0);
    expect(rows.length).toBe(305);
    for (const sort of [...MARKET_SORTS, undefined] as (MarketSort | undefined)[]) {
      for (const dir of ['asc', 'desc', undefined] as const) {
        const got = h.market.all({ ...(sort ? { sort } : {}), ...(dir ? { dir } : {}) }, T0).map((r) => r.sku);
        const want = [...rows].sort(marketComparator(sort, dir)).map((r) => r.sku);
        expect(got, `${sort ?? 'default'} ${dir ?? 'default'}`).toEqual(want);
      }
    }

    // New rows (fewer than the merge threshold) compare by name directly and still land in place.
    h.repo.upsertListings(Array.from({ length: 5 }, (_, i) => buy(`${200_500 + i};6`, 40, { id: `late${i}`, steamid: `L${i}` })));
    h.market.markDirty(Array.from({ length: 5 }, (_, i) => `${200_500 + i};6`));
    h.timers.advance(MARKET_DIRTY_BATCH_MS);
    const after = h.market.all({}, T0);
    expect(after.length).toBe(310);
    for (const sort of ['name', 'ceiling', 'updated'] as const) {
      expect(h.market.all({ sort }, T0).map((r) => r.sku)).toEqual([...after].sort(marketComparator(sort, undefined)).map((r) => r.sku));
    }
  });

  it('pages the sorted rows and reports the total before paging', () => {
    const h = marketOfMany();
    const all = h.market.all({ sort: 'buyers' }, T0);
    const page = h.market.list({ sort: 'buyers', limit: 50, offset: 100 }, T0);
    expect(page.total).toBe(all.length);
    expect(page.rows).toEqual(all.slice(100, 150));
    expect(h.market.list({}, T0).rows).toHaveLength(200); // default page
    expect(h.market.list({ offset: 300 }, T0).rows.map((r) => r.sku)).toEqual(h.market.all({}, T0).slice(300).map((r) => r.sku));
    const filtered = h.market.list({ categories: ['hats'], verdicts: ['unchecked', 'rule-flip'], limit: 500 }, T0);
    expect(filtered.rows.every((r) => r.category === 'hats' && (r.verdict === 'unchecked' || r.verdict === 'rule-flip'))).toBe(true);
    expect(filtered.total).toBe(filtered.counts.unchecked + filtered.counts['rule-flip']);
    expect(filtered.keyPrice?.valueScrap).toBe(h.K());
    expect(filtered.generatedAt).toBe(T0);
  });

  it('writes the CSV with the shared columns, one line per row', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 80, source: 'import', observedAt: T0 - MIN, stock: 4 });
    const h = setup({ repo });
    build(h);
    const rows = h.market.all({}, T0);
    const csv = marketCsv(rows, h.K());
    const lines = csv.replace(CSV_BOM, '').trim().split(/\r?\n/);
    expect(lines[0]).toBe(MARKET_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^378;6,Team Captain,hats,flip,/);
    expect(lines[1]).toContain(',page,4,');
  });
});
