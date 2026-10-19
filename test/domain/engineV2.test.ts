// v0.2 engine features: the "pay up to" ceiling (F1), the stale-reference gate
// (F4), the suspect-margin guard (F5) and the notification controls (F6).

import { afterEach, describe, expect, it } from 'vitest';
import { createRepo, migrate, openDatabase, openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { profitStatus } from '../../src/shared/ceiling';
import { mergeSettings, DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { DeepPartial, Listing, ReferencePrices, Settings } from '../../src/shared/types';
import {
  createEngine,
  evaluateOpportunity,
  explicitInput,
  notificationBody,
  notificationSummaryTitle,
  notificationTitle,
  notifyKinds,
  revenueOrderByValue,
  ruleInput,
} from '../../src/service/domain/engine';
import type { EngineInput, EvaluateArgs } from '../../src/service/domain/engine';
import { matchContext } from '../../src/service/domain/matcher';
import { buildShoppingList } from '../../src/service/domain/shopping';
import { maxCostFor } from '../../src/service/domain/tiers';
import { buildItemDetail } from '../../src/service/domain/views';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, recordingLogger, special } from './helpers';

const K = 567;
const DAY = 24 * 60 * 60 * 1000;
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

function setup(opts: { repo?: Repo; settings?: DeepPartial<Settings> } = {}) {
  const repo = opts.repo ?? newRepo();
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, opts.settings ?? {}) };
  const events = recordingEvents();
  const engine = createEngine({ ...makeDeps(repo, clock, () => settings.current, recordingLogger()), schema: createStubSchema(), events, timers });
  return { repo, clock, timers, settings, events, engine };
}

/** The walkthrough's Team Captain: a fresh online bot at 12 ref and two humans just below, a fresh PriceDB price, a typed cost of 10 ref. */
function seedTeamCaptain(repo: Repo, source: 'user' | 'import' = 'user'): number {
  repo.upsertListings([
    makeListing({ id: 'tc-bot', steamid: 'S1', metalScrap: 108, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 - MIN }),
    makeListing({ id: 'tc-h1', steamid: 'S2', metalScrap: 105, lastEventAt: T0 - MIN }),
    makeListing({ id: 'tc-h2', steamid: 'S3', metalScrap: 102, lastEventAt: T0 - MIN }),
  ]);
  repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 100, sellKeys: 0, sellScrap: 120, time: Math.floor(T0 / 1000), fetchedAt: T0 }]);
  return repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 90, source, observedAt: T0 - MIN }).id;
}

/** Bill's Hat for a rule: an active online bot at 10 ref and two humans close below; no reference price. */
function seedBillsHat(repo: Repo): number {
  repo.upsertListings([
    makeListing({ id: 'bh-bot', sku: '126;6', baseSku: '126;6', steamid: 'B1', metalScrap: 90, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 - MIN }),
    makeListing({ id: 'bh-h1', sku: '126;6', baseSku: '126;6', steamid: 'B2', metalScrap: 88, lastEventAt: T0 - MIN }),
    makeListing({ id: 'bh-h2', sku: '126;6', baseSku: '126;6', steamid: 'B3', metalScrap: 86, lastEventAt: T0 - MIN }),
  ]);
  return repo.upsertRule({ name: "Bill's", filter: { defindexes: [126] }, costScrap: 60, observedAt: T0 }).id;
}

function typed(sku: string, costScrap: number, observedAt = T0 - MIN): EngineInput {
  return explicitInput({
    id: 1,
    sku,
    name: 'Item',
    costKeys: 0,
    costScrap,
    source: 'user',
    observedAt,
    note: null,
    importBatch: null,
    special: null,
    assetId: null,
    stock: null,
  })!;
}

function evalArgs(over: Partial<EvaluateArgs> = {}, profit: DeepPartial<Settings['profit']> = {}): EvaluateArgs {
  const s = mergeSettings(DEFAULT_SETTINGS, { profit });
  return {
    input: typed('378;6', 20),
    listings: [],
    references: { pricedb: null, community: null },
    category: 'hats',
    isUnusual: false,
    settings: s,
    keyScrap: K,
    now: T0,
    match: matchContext(s, T0),
    prev: null,
    ...over,
  };
}

describe('F1: pay-up-to ceiling on opportunities', () => {
  const book = (): Listing[] => [
    makeListing({ id: 'whale', steamid: 'W', metalScrap: 400 }),
    makeListing({ id: 'human', steamid: 'H', metalScrap: 150 }),
    makeListing({ id: 'bot', steamid: 'B', metalScrap: 140, isBot: true }),
    makeListing({ id: 'low', steamid: 'L', metalScrap: 130 }),
  ];

  it('is the largest cost that is still profitable against the revenue the settings choose', () => {
    const o = evaluateOpportunity(evalArgs({ listings: book() }));
    expect(o.revenueScrap).toBe(150);
    // 150 - 138 = 12 scrap clears 9 scrap and an 8% margin; 139 leaves 11/139 < 8%.
    expect(o.maxCostScrap).toBe(138);
    const p = DEFAULT_SETTINGS.profit;
    expect(profitStatus(150 - 138, 138, p)).toBe('profitable');
    expect(profitStatus(150 - 139, 139, p)).not.toBe('profitable');

    for (const profit of [{ useOrder: 'best' as const }, { useOrder: 'instant' as const }, { frictionScrap: 20 }, { minProfitScrap: 30 }, { minMargin: 0.5 }]) {
      const r = evaluateOpportunity(evalArgs({ listings: book() }, profit));
      expect(r.maxCostScrap).toBe(maxCostFor(r.revenueScrap, mergeSettings(DEFAULT_SETTINGS, { profit }).profit));
    }
    expect(evaluateOpportunity(evalArgs({ listings: book() }, { useOrder: 'best' })).maxCostScrap).toBeGreaterThan(o.maxCostScrap!);
  });

  it('does not depend on the input cost, and is null without buyers', () => {
    const cheap = evaluateOpportunity(evalArgs({ listings: book(), input: typed('378;6', 5) }));
    const dear = evaluateOpportunity(evalArgs({ listings: book(), input: typed('378;6', 1000) }));
    expect(dear.status).toBe('unprofitable');
    expect(cheap.maxCostScrap).toBe(dear.maxCostScrap);
    expect(evaluateOpportunity(evalArgs()).maxCostScrap).toBeNull();
  });

  it('is persisted, read back by every view and recomputed when the profit settings change', async () => {
    const h = setup();
    const priceId = seedTeamCaptain(h.repo);
    await h.engine.runNow();
    const key = `378;6|price:${priceId}`;
    expect(h.repo.getOpportunity(key)!.maxCostScrap).toBe(99);
    expect(h.repo.allOpportunities()[0]!.maxCostScrap).toBe(99);
    expect(h.repo.opportunitiesForSku('378;6')[0]!.maxCostScrap).toBe(99);

    h.settings.current = mergeSettings(h.settings.current, { profit: { minProfitScrap: 18 } });
    await h.engine.runNow();
    expect(h.repo.getOpportunity(key)!.maxCostScrap).toBe(90);
  });

  it('heals rows written before the column existed on the next run', async () => {
    const db = openDatabase(':memory:');
    migrate(db.raw);
    const repo = createRepo(db);
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
    const priceId = seedTeamCaptain(repo);
    await setup({ repo }).engine.runNow();
    db.raw.exec('UPDATE opportunities SET max_cost_scrap = NULL');
    expect(repo.allOpportunities()[0]!.maxCostScrap).toBeNull();

    // A restart: the new engine loads the stored rows, sees the difference and rewrites them.
    await setup({ repo }).engine.runNow();
    expect(repo.getOpportunity(`378;6|price:${priceId}`)!.maxCostScrap).toBe(99);
  });

  it('feeds the shopping list from the stored rows, for typed prices and rule candidates alike', async () => {
    for (const useOrder of ['conservative', 'instant', 'best'] as const) {
      const h = setup({ settings: { profit: { useOrder } } });
      seedTeamCaptain(h.repo);
      seedBillsHat(h.repo);
      // A human whale above both books: an outlier, so only useOrder 'best' sells to it.
      h.repo.upsertListings([makeListing({ id: 'tc-whale', steamid: 'S9', metalScrap: 200, lastEventAt: T0 - MIN })]);
      await h.engine.runNow();
      const list = buildShoppingList(h.repo.allOpportunities(), {}, h.engine.keyPrice(), h.clock.t);
      const tc = list.rows.find((r) => r.sku === '378;6')!;
      const bh = list.rows.find((r) => r.sku === '126;6')!;
      const stored = h.repo.opportunitiesForSku('378;6')[0]!;
      // The ceiling and revenue order are the engine's, whichever order the settings chose.
      expect(tc).toMatchObject({ maxCostScrap: stored.maxCostScrap, revenueScrap: stored.revenueScrap, knownCostScrap: 90, inputKinds: ['user'] });
      expect(tc.revenueOrder?.listingId).toBe({ conservative: 'tc-bot', instant: 'tc-bot', best: 'tc-whale' }[useOrder]);
      expect(tc.underCeiling).toBe(90 <= tc.maxCostScrap);
      expect(bh).toMatchObject({ maxCostScrap: 81, revenueScrap: 90, knownCostScrap: null, underCeiling: null, inputKinds: ['rule'] });
      expect(bh.revenueOrder).toMatchObject({ listingId: 'bh-bot', isBot: true });
      expect(list.groups.reduce((n, g) => n + g.count, 0)).toBe(list.total);
    }
  });

  it('marks a 3 h old price stale on the shopping list, as the engine judged its row (ACT-9)', async () => {
    const h = setup();
    seedTeamCaptain(h.repo);
    await h.engine.runNow();
    const row = () => buildShoppingList(h.repo.allOpportunities(), {}, h.engine.keyPrice(), h.clock.t).rows.find((r) => r.sku === '378;6')!;
    expect(row()).toMatchObject({ knownObservedAt: T0 - MIN, knownStale: false });
    // Three hours on (profit.inputStaleMs is 2 h): the next sweep flags the row, and the list says so.
    h.clock.advance(3 * 60 * MIN);
    await h.engine.runNow();
    expect(h.repo.allOpportunities()[0]!.flags).toContain('stale-input');
    expect(row()).toMatchObject({ knownObservedAt: T0 - MIN, knownStale: true, knownCostScrap: 90 });
  });

  it('finds the revenue order of a stored row without knowing useOrder', () => {
    for (const useOrder of ['conservative', 'best', 'instant'] as const) {
      const o = evaluateOpportunity(evalArgs({ listings: book() }, { useOrder }));
      expect(revenueOrderByValue(o)?.listingId).toBe({ conservative: 'human', best: 'whale', instant: 'bot' }[useOrder]);
    }
    expect(revenueOrderByValue(evaluateOpportunity(evalArgs()))).toBeNull();
  });
});

describe('F4: stale reference prices', () => {
  const orders = (): Listing[] => [
    makeListing({ id: 'a', steamid: 'A', metalScrap: 40 }),
    makeListing({ id: 'b', steamid: 'B', metalScrap: 38 }),
    makeListing({ id: 'c', steamid: 'C', metalScrap: 36 }),
  ];
  const oldPdb = (ageDays: number): ReferencePrices => ({
    pricedb: { buyScrap: 15, sellScrap: 18, time: Math.floor((T0 - ageDays * DAY) / 1000), ageMs: ageDays * DAY },
    community: null,
  });

  it('ignores a PriceDB price older than referenceMaxAgeMs instead of marking every order an outlier (audit repro)', () => {
    const o = evaluateOpportunity(evalArgs({ listings: orders(), references: oldPdb(400) }));
    expect(o).toMatchObject({ status: 'profitable', consScrap: 40, revenueScrap: 40, profitScrap: 20 });
    expect(o.flags).toContain('stale-reference');
    expect(o.flags).not.toContain('all-outliers');
    expect(o.reasons).toContain('PriceDB price is 400 days old, ignored');
    expect(o.reasons).toContain('-10 No recent PriceDB or community price to compare with');
    // The stored references stay as they are, for the drawer to show (faded).
    expect(o.references.pricedb?.sellScrap).toBe(18);

    // Within the window the old behaviour holds.
    const kept = evaluateOpportunity(evalArgs({ listings: orders(), references: oldPdb(400) }, { referenceMaxAgeMs: 500 * DAY }));
    expect(kept.status).toBe('no-buyers');
    expect(kept.flags).toContain('all-outliers');
    expect(kept.flags).not.toContain('stale-reference');
  });

  it('gates the community price through lastUpdate, with at least a year', () => {
    const community = (ageDays: number): ReferencePrices => ({
      pricedb: null,
      community: { valueScrap: 18, valueHighScrap: 20, lastUpdate: Math.floor((T0 - ageDays * DAY) / 1000) },
    });
    const stale = evaluateOpportunity(evalArgs({ listings: orders(), references: community(400) }));
    expect(stale.consScrap).toBe(40);
    expect(stale.flags).toContain('stale-reference');
    expect(stale.reasons).toContain('Community price is 400 days old, ignored');

    // A 100-day-old community price is still used: hand-set prices stay right for months.
    const months = evaluateOpportunity(evalArgs({ listings: orders(), references: community(100) }));
    expect(months.consScrap).toBeNull();
    expect(months.flags).not.toContain('stale-reference');

    const fresh = evaluateOpportunity(evalArgs({ listings: orders(), references: community(1) }));
    expect(fresh.consScrap).toBeNull();
    expect(fresh.flags).toEqual(expect.arrayContaining(['all-outliers']));
    expect(fresh.flags).not.toContain('stale-reference');
  });

  it('keeps a reference of unknown age', () => {
    const unknown: ReferencePrices = { pricedb: { buyScrap: 15, sellScrap: 18, time: null, ageMs: null }, community: { valueScrap: 18, valueHighScrap: null, lastUpdate: null } };
    const o = evaluateOpportunity(evalArgs({ listings: orders(), references: unknown }));
    expect(o.flags).not.toContain('stale-reference');
    expect(o.status).toBe('no-buyers');
  });

  it('flags a stored row once its PriceDB price ages past the limit, on the periodic sweep', async () => {
    const h = setup({ settings: { profit: { referenceMaxAgeMs: 2 * DAY } } });
    const priceId = seedTeamCaptain(h.repo);
    await h.engine.runNow();
    const key = `378;6|price:${priceId}`;
    expect(h.repo.getOpportunity(key)!.flags).not.toContain('stale-reference');
    h.clock.advance(3 * DAY);
    h.repo.upsertScrapPrice({ id: priceId, sku: '378;6', name: 'Team Captain', costScrap: 90, source: 'user', observedAt: h.clock.t });
    h.repo.upsertListings(['tc-bot', 'tc-h1', 'tc-h2'].map((id, i) => makeListing({ id, steamid: `S${i + 1}`, metalScrap: 108 - 3 * i, lastEventAt: h.clock.t })));
    await h.engine.runNow();
    const o = h.repo.getOpportunity(key)!;
    expect(o.flags).toContain('stale-reference');
    expect(o.reasons).toContain('PriceDB price is 3 days old, ignored');
  });
});

describe('F5: suspect-margin guard', () => {
  const lone = (metalScrap = 450): Listing[] => [
    makeListing({ id: 'bot', steamid: 'B', metalScrap, isBot: true, uaLastPulse: Math.floor((T0 - MIN) / 1000), userOnline: true, lastEventAt: T0 - MIN }),
  ];
  const REASON = 'Margin over 200% with no reference and few buyers. Check the variant and units';

  it('caps a huge margin on a lone order with no reference at Low and says why (audit repro)', () => {
    const o = evaluateOpportunity(evalArgs({ listings: lone(), input: typed('378;6', 15) }));
    expect(o).toMatchObject({ status: 'profitable', profitScrap: 435, confidenceLevel: 'low' });
    expect(o.confidence).toBe(44);
    expect(o.flags).toContain('suspect-margin');
    expect(o.reasons.at(-1)).toBe(REASON);
  });

  it('needs margin over the setting, fewer than 3 orders and no usable reference', () => {
    const at = (over: Partial<EvaluateArgs>, profit: DeepPartial<Settings['profit']> = {}) => evaluateOpportunity(evalArgs(over, profit)).flags.includes('suspect-margin');
    expect(at({ listings: lone(), input: typed('378;6', 15) }, { suspectMargin: 0 })).toBe(false);
    // 435 / 15 is a margin of exactly 29.
    expect(at({ listings: lone(), input: typed('378;6', 15) }, { suspectMargin: 28 })).toBe(true);
    expect(at({ listings: lone(), input: typed('378;6', 15) }, { suspectMargin: 29 })).toBe(false);
    // Margin exactly 200% is not over it.
    expect(at({ listings: lone(45), input: typed('378;6', 15) })).toBe(false);
    expect(at({ listings: lone(46), input: typed('378;6', 15) })).toBe(true);
    // Three orders let the median rule check the price.
    const three = [...lone(), makeListing({ id: 'h1', steamid: 'H1', metalScrap: 440 }), makeListing({ id: 'h2', steamid: 'H2', metalScrap: 430 })];
    expect(at({ listings: three, input: typed('378;6', 15) })).toBe(false);
    // A current reference checks it too; a stale one does not count.
    const pdb = (ageMs: number): ReferencePrices => ({ pricedb: { buyScrap: 400, sellScrap: 460, time: null, ageMs }, community: null });
    expect(at({ listings: lone(), input: typed('378;6', 15), references: pdb(DAY) })).toBe(false);
    expect(at({ listings: lone(), input: typed('378;6', 15), references: pdb(60 * DAY) })).toBe(true);
    // A free item has an unbounded margin.
    expect(at({ listings: lone(), input: typed('378;6', 0) })).toBe(true);
    // Unprofitable rows are never suspect.
    expect(at({ listings: lone(), input: typed('378;6', 500) })).toBe(false);
  });

  it('keeps the row visible but never notifies it, whatever the confidence minimum', async () => {
    const h = setup({ settings: { notifications: { minConfidence: 0 } } });
    h.repo.upsertListings(lone());
    const p = h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 15, source: 'user', observedAt: T0 });
    await h.engine.runNow();
    const o = h.repo.getOpportunity(`378;6|price:${p.id}`)!;
    expect(o.status).toBe('profitable');
    expect(o.flags).toContain('suspect-margin');
    expect(h.repo.listEvents({ kinds: ['appeared'] })).toHaveLength(1);
    expect(h.events.notified).toEqual([]);
    expect(h.repo.listEvents({ kinds: ['notified'] })).toEqual([]);
  });
});

describe('F6: notification controls and wording', () => {
  it('words typed, imported and rule-candidate toasts differently, with the ceiling', async () => {
    const h = setup();
    seedTeamCaptain(h.repo);
    seedBillsHat(h.repo);
    await h.engine.runNow();
    const byTitle = new Map(h.events.notified.map((n) => [n.title, n]));
    expect(byTitle.get('Profit: Team Captain')).toEqual({ title: 'Profit: Team Captain', body: '2.00 ref (20%) — sell to bot buy order, pay up to 11.00 ref', sku: '378;6' });
    // 90 - 81 = 9 scrap is the smallest profit allowed, so the ceiling is 9 ref.
    expect(byTitle.get("Candidate: Bill's Hat")).toEqual({ title: "Candidate: Bill's Hat", body: 'Check scrap.tf, pay up to 9.00 ref. Sells for 10.00 ref (bot buyer)', sku: '126;6' });
    expect(h.repo.listEvents({ kinds: ['notified'] }).map((e) => e.summary).sort()).toEqual([
      '2.00 ref (20%) — sell to bot buy order, pay up to 11.00 ref',
      'Check scrap.tf, pay up to 9.00 ref. Sells for 10.00 ref (bot buyer)',
    ]);

    const imported = setup();
    seedTeamCaptain(imported.repo, 'import');
    await imported.engine.runNow();
    expect(imported.events.notified.map((n) => n.title)).toEqual(['Profit: Team Captain']);
  });

  it('notifies only the input kinds the user picked', async () => {
    const cases: [Settings['notifications']['inputKinds'], string[]][] = [
      [['user', 'import', 'rule'], ["Candidate: Bill's Hat", 'Profit: Team Captain']],
      [['user'], ['Profit: Team Captain']],
      [['rule'], ["Candidate: Bill's Hat"]],
      [['import'], []],
      [[], []],
    ];
    for (const [inputKinds, titles] of cases) {
      const h = setup({ settings: { notifications: { inputKinds } } });
      seedTeamCaptain(h.repo);
      seedBillsHat(h.repo);
      await h.engine.runNow();
      expect(h.events.notified.map((n) => n.title).sort()).toEqual(titles);
      // Muted rows still appear in the list and the event log.
      expect(h.repo.listEvents({ kinds: ['appeared'] })).toHaveLength(2);
    }
  });

  it('notifies a muted kind once it is turned back on', async () => {
    const h = setup({ settings: { notifications: { inputKinds: ['user'] } } });
    seedBillsHat(h.repo);
    await h.engine.runNow();
    expect(h.events.notified).toEqual([]);
    h.settings.current = mergeSettings(h.settings.current, { notifications: { inputKinds: ['user', 'rule'] } });
    h.clock.advance(MIN);
    await h.engine.runNow();
    expect(h.events.notified.map((n) => n.title)).toEqual(["Candidate: Bill's Hat"]);
  });

  it('does not call folded rule candidates profitable flips', async () => {
    const k = (inputKind: 'user' | 'import' | 'rule') => ({ inputKind });
    expect(notificationSummaryTitle([k('user')])).toBe('1 more profitable flip');
    expect(notificationSummaryTitle([k('user'), k('import')])).toBe('2 more profitable flips');
    expect(notificationSummaryTitle([k('rule')])).toBe('1 more candidate to check on scrap.tf');
    expect(notificationSummaryTitle([k('rule'), k('rule')])).toBe('2 more candidates to check on scrap.tf');
    expect(notificationSummaryTitle([k('rule'), k('user')])).toBe('2 more flips and candidates');

    // A broad rule: three candidate toasts, then one summary for the rest.
    const h = setup();
    // A modest margin, so the suspect-margin guard (one order, no reference) stays out of it.
    const rule = { name: 'Hats', filter: { defindexes: [2000, 2001, 2002, 2003, 2004] }, costScrap: 60, observedAt: T0 };
    for (let i = 0; i < 5; i++) {
      const sku = `${2000 + i};6`;
      h.repo.upsertListings([makeListing({ id: `r${i}`, sku, baseSku: sku, steamid: `R${i}`, metalScrap: 100 + i, isBot: true, uaLastPulse: Math.floor(T0 / 1000), lastEventAt: T0 })]);
    }
    h.repo.upsertRule(rule);
    await h.engine.runNow();
    expect(h.events.notified.map((n) => n.title.split(':')[0])).toEqual(['Candidate', 'Candidate', 'Candidate', '2 more candidates to check on scrap.tf']);
  });

  it('treats a missing or broken inputKinds as every kind', () => {
    expect([...notifyKinds(undefined)]).toEqual(['user', 'import', 'rule']);
    expect([...notifyKinds('rule')]).toEqual(['user', 'import', 'rule']);
    expect([...notifyKinds(['rule', 'bogus', 'user', 'rule'])]).toEqual(['user', 'rule']);
    expect([...notifyKinds([])]).toEqual([]);
  });

  it('builds titles and bodies from the row alone', () => {
    const rule = { id: 3, name: 'r', filter: {}, costKeys: 0, costScrap: 100, observedAt: T0, enabled: true };
    const listings = [makeListing({ id: 'h', steamid: 'H', metalScrap: 200 })];
    const r = evaluateOpportunity(evalArgs({ input: ruleInput(rule, '378;6', 'Team Captain'), listings }));
    expect(notificationTitle(r)).toBe('Candidate: Team Captain');
    expect(notificationBody(r, K, 'conservative')).toBe('Check scrap.tf, pay up to 20.55 ref. Sells for 22.22 ref (human buyer)');
    expect(notificationTitle({ ...r, inputKind: 'user', name: '' })).toBe('Profit: 378;6');
    expect(notificationBody({ ...r, inputKind: 'user', maxCostScrap: null }, K, 'conservative')).toBe('11.11 ref (100%) — sell to human buy order');
  });
});

describe('F2: item.detail revenue matches the engine', () => {
  it('prices the drawer book exactly like the stored row, including generic any-effect orders and stale references', async () => {
    const h = setup();
    h.repo.upsertListings([
      makeListing({ id: 'own', steamid: 'A', sku: '378;5;u13', baseSku: '378;5;u13', keys: 30, metalScrap: 0, isBot: true }),
      makeListing({ id: 'own2', steamid: 'B', sku: '378;5;u13', baseSku: '378;5;u13', keys: 28, metalScrap: 0 }),
      makeListing({ id: 'any', steamid: 'C', sku: '378;5', baseSku: '378;5', keys: 31, metalScrap: 0 }),
    ]);
    // 400 days old: it would make every order an outlier if it still counted.
    h.repo.upsertPricedb([{ sku: '378;5;u13', name: 'x', buyKeys: 5, buyScrap: 0, sellKeys: 6, sellScrap: 0, time: Math.floor((T0 - 400 * DAY) / 1000), fetchedAt: T0 }]);
    const p = h.repo.upsertScrapPrice({ sku: '378;5;u13', name: 'Burning Flames Team Captain', costKeys: 20, costScrap: 0, source: 'user', observedAt: T0 });
    for (const useOrder of ['conservative', 'best', 'instant'] as const) {
      h.settings.current = mergeSettings(DEFAULT_SETTINGS, { profit: { useOrder } });
      await h.engine.runNow();
      const o = h.repo.getOpportunity(`378;5;u13|price:${p.id}`)!;
      const d = buildItemDetail({
        repo: h.repo,
        schema: createStubSchema(),
        sku: '378;5;u13',
        keyPrice: h.engine.keyPrice(),
        settings: h.settings.current,
        now: h.clock.t,
        snapshot: { lastAt: null, available: false, nextAllowedAt: null },
      })!;
      expect(d.revenue).toEqual({
        bestScrap: o.bestScrap,
        consScrap: o.consScrap,
        instantScrap: o.instantScrap,
        useOrder,
        revenueScrap: o.revenueScrap,
        order: expect.objectContaining({ listingId: revenueOrderByValue(o)!.listingId }),
        maxCostScrap: o.maxCostScrap,
        eligibleCount: 3,
      });
      expect(o.flags).toContain('stale-reference');
    }
  });

  it("prices quick entry's plain copy like its saved row, not like a newer painted import (target:'plain')", async () => {
    const h = setup();
    const PAINT = 15185211;
    h.repo.upsertListings([
      makeListing({ id: 'generic-bot', steamid: 'G', metalScrap: 100, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true }),
      makeListing({ id: 'painted', steamid: 'P', sku: `378;6;p${PAINT}`, baseSku: '378;6', metalScrap: 200, special: special({ paint: PAINT }) }),
    ]);
    const plain = h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 120, source: 'user', observedAt: T0 - 3 * MIN });
    // The newest stored copy is an imported painted one: only the paint-specific order buys it.
    const painted = h.repo.upsertScrapPrice({
      sku: '378;6',
      name: 'Team Captain',
      costScrap: 150,
      source: 'import',
      observedAt: T0 - MIN,
      special: special({ paint: PAINT }),
    });
    await h.engine.runNow();
    const plainRow = h.repo.getOpportunity(`378;6|price:${plain.id}`)!;
    const paintedRow = h.repo.getOpportunity(`378;6|price:${painted.id}`)!;
    expect(plainRow).toMatchObject({ revenueScrap: 100, status: 'unprofitable' });
    expect(paintedRow.revenueScrap).toBe(200);

    const detail = (target?: 'newest' | 'plain') =>
      buildItemDetail({
        repo: h.repo,
        schema: createStubSchema(),
        sku: '378;6',
        keyPrice: h.engine.keyPrice(),
        settings: h.settings.current,
        now: h.clock.t,
        snapshot: { lastAt: null, available: false, nextAllowedAt: null },
        ...(target ? { target } : {}),
      })!;
    // Quick entry's preview (and its Shift+Enter check) matches the row Enter creates.
    const quick = detail('plain');
    expect(quick.revenue).toMatchObject({ revenueScrap: plainRow.revenueScrap, maxCostScrap: plainRow.maxCostScrap, eligibleCount: 1 });
    expect(quick.buyOrders.find((o) => o.listingId === 'painted')).toMatchObject({ eligible: false, flags: expect.arrayContaining(['attribute-specific']) });
    // The drawer keeps classifying against the newest copy, so its ceiling and its book agree.
    for (const d of [detail(), detail('newest')]) {
      expect(d.revenue).toMatchObject({ revenueScrap: paintedRow.revenueScrap, maxCostScrap: paintedRow.maxCostScrap });
      expect(d.buyOrders.find((o) => o.listingId === 'painted')?.eligible).toBe(true);
    }
  });
});
