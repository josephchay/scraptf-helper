// 0.9 (#3) in the engine: every row carries the risk keys at its own cost (exitRiskAt over the book it already
// read): "If this buyer leaves" (backupProfitScrap), "Buyers at break-even" (profitableDepth) and the book depth. And
// the risk control: notifications.minProfitableDepth (0, the default: off) holds back a flip's toast until enough
// buyers seen in the last 24 h clear break-even, without recording it as told. Kept out of the TIMED engine.test.ts.
// In-memory repo, fake clock; no network, nothing touches scrap.tf.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { NOTIFY_META_KEY, createEngine, evaluateOpportunity, ruleInput } from '../../src/service/domain/engine';
import type { EvaluateArgs } from '../../src/service/domain/engine';
import { matchContext } from '../../src/service/domain/matcher';
import { breakEvenFor, flipProfit } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, Listing, Opportunity, Settings } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, recordingLogger } from './helpers';

const K = 567;
const rule = { id: 3, name: 'r', filter: {}, costKeys: 0, costScrap: 225, observedAt: T0, enabled: true };

function args(listings: Listing[], profit: DeepPartial<Settings['profit']> = {}): EvaluateArgs {
  const s = mergeSettings(DEFAULT_SETTINGS, { profit });
  return {
    input: ruleInput(rule, '378;6', 'Team Captain'),
    listings,
    references: { pricedb: null, community: null },
    category: 'hats',
    isUnusual: false,
    settings: s,
    keyScrap: K,
    now: T0,
    match: matchContext(s, T0),
    prev: null,
  };
}

/** engineSingleExit's thin book: A pays 270 (the revenue), B pays `b` (another SteamID); rule cost 225. */
function thin(b: number | null, bOver: Partial<Listing> = {}, profit: DeepPartial<Settings['profit']> = {}): EvaluateArgs {
  const listings = [makeListing({ id: 'A', steamid: 'A', metalScrap: 270, lastEventAt: T0 - MIN })];
  if (b !== null) listings.push(makeListing({ id: 'B', steamid: 'B', metalScrap: b, lastEventAt: T0 - MIN, ...bOver }));
  return args(listings, profit);
}

const p0 = DEFAULT_SETTINGS.profit;

describe('0.9 (#3): evaluateOpportunity carries the risk keys at the row cost', () => {
  it('backup is flipProfit at B, depth 2 when B clears break-even, book depth 2', () => {
    for (const b of [261, 240, 225]) {
      const o = evaluateOpportunity(thin(b));
      expect(o, `B at ${b}`).toMatchObject({ revenueScrap: 270, costScrap: 225, status: 'profitable', backupProfitScrap: flipProfit(b, 225, p0), profitableDepth: 2, bookDepth: 2 });
    }
    expect(breakEvenFor(225, p0, 'buy')).toBe(225);
    // One scrap under break-even: B no longer counts, and the backup is kept negative.
    const under = evaluateOpportunity(thin(224));
    expect(under).toMatchObject({ backupProfitScrap: -1, profitableDepth: 1, bookDepth: 2 });
    const low = evaluateOpportunity(thin(180));
    expect(low).toMatchObject({ backupProfitScrap: -45, profitableDepth: 1, bookDepth: 2 });
  });

  it('an unverified B (no feed event for 25 h) is no backup and not counted', () => {
    const o = evaluateOpportunity(thin(261, { lastEventAt: T0 - 25 * HOUR }));
    expect(o.revenueScrap).toBe(270);
    expect(o).toMatchObject({ profitableDepth: 1, bookDepth: 1 });
    expect('backupProfitScrap' in o).toBe(false);
  });

  it('counts bots only under Instant', () => {
    const book = (): Listing[] => [
      makeListing({ id: 'A', steamid: 'A', metalScrap: 270, isBot: true, lastEventAt: T0 - MIN }),
      makeListing({ id: 'H', steamid: 'H', metalScrap: 261, lastEventAt: T0 - MIN }),
      makeListing({ id: 'C', steamid: 'C', metalScrap: 240, isBot: true, lastEventAt: T0 - MIN }),
    ];
    const cons = evaluateOpportunity(args(book()));
    expect(cons).toMatchObject({ revenueScrap: 270, backupProfitScrap: 36, profitableDepth: 3, bookDepth: 3 });
    const instant = evaluateOpportunity(args(book(), { useOrder: 'instant' }));
    expect(instant).toMatchObject({ revenueScrap: 270, backupProfitScrap: 15, profitableDepth: 2, bookDepth: 2 });
  });

  it('a 5% price-move reserve moves the break-even boundary', () => {
    const p = { exitReservePct: 0.05 };
    expect(breakEvenFor(225, { ...p0, ...p }, 'buy')).toBe(237);
    expect(evaluateOpportunity(thin(237, {}, p))).toMatchObject({ profitableDepth: 2, backupProfitScrap: 0 });
    expect(evaluateOpportunity(thin(236, {}, p))).toMatchObject({ profitableDepth: 1, backupProfitScrap: -1 });
    // Without the reserve both clear it.
    expect(evaluateOpportunity(thin(236))).toMatchObject({ profitableDepth: 2, backupProfitScrap: 11 });
  });

  it('a no-buyers row has depth 0 and book depth 0, and no backup', () => {
    const o = evaluateOpportunity(args([]));
    expect(o.status).toBe('no-buyers');
    expect(o).toMatchObject({ profitableDepth: 0, bookDepth: 0 });
    expect('backupProfitScrap' in o).toBe(false);
  });

  it("does not count an impersonator-flagged order (exits' 'impersonator' flag)", () => {
    const o = evaluateOpportunity(thin(261, { userImpersonated: true }));
    expect(o).toMatchObject({ revenueScrap: 270, buyerCount: 1, profitableDepth: 1, bookDepth: 1 });
    expect('backupProfitScrap' in o).toBe(false);
  });

  it('never scales profit or confidence: the 0.8 fields are unchanged by the keys', () => {
    const o = evaluateOpportunity(thin(180));
    expect(o).toMatchObject({ profitScrap: 45, maxCostScrap: expect.any(Number) });
    expect(o.flags).toContain('single-exit');
  });
});

// ---------------------------------------------------------------------------
// The risk control and the one-time rewrite, through createEngine (engineWatchFloor's harness)
// ---------------------------------------------------------------------------

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

function setup(patch: DeepPartial<Settings> = {}, repo: Repo = newRepo()) {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 }, ...patch });
  const events = recordingEvents();
  const engine = createEngine({ ...makeDeps(repo, clock, () => settings, recordingLogger()), schema: createStubSchema(), events, timers });
  const titles = (): string[] => events.notified.map((n) => n.title);
  /** A fresh buyer of 378;6 (a bot when asked). */
  const buyer = (id: string, scrap: number, isBot = false): void => {
    repo.upsertListings([
      makeListing({ id, steamid: `S-${id}`, metalScrap: scrap, isBot, uaLastPulse: isBot ? Math.floor(clock.t / 1000) : null, userOnline: isBot ? true : null, lastEventAt: clock.t - MIN }),
    ]);
  };
  return { repo, clock, timers, engine, settings, titles, buyer };
}

describe('0.9 (#3): notifications.minProfitableDepth in the engine', () => {
  /** One buyer clears a 60-scrap typed price (108), the other (50) does not: one buyer at break-even. */
  function oneAtBreakEven(h: ReturnType<typeof setup>): void {
    h.buyer('top', 108, true);
    h.buyer('low', 50);
    h.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: 60, source: 'user', observedAt: h.clock.t - MIN });
  }

  it('holds back a flip with one buyer at break-even, records nothing, and toasts once a second buyer is seen', async () => {
    const h = setup({ notifications: { minProfitableDepth: 2 } });
    oneAtBreakEven(h);
    await h.engine.runNow();
    const row = h.repo.allOpportunities()[0]!;
    expect(row).toMatchObject({ status: 'profitable', profitScrap: 48, profitableDepth: 1, bookDepth: 2 });
    expect(h.titles()).toEqual([]);
    expect(h.repo.getMeta(NOTIFY_META_KEY)).toBeNull();
    expect(h.repo.listEvents({ kinds: ['notified'] })).toEqual([]);

    // A second verified buyer above break-even, then the base is marked dirty.
    h.engine.start();
    h.timers.advance(1000);
    expect(h.titles()).toEqual([]);
    h.buyer('second', 100);
    h.engine.markDirty(['378;6']);
    h.timers.advance(1000);
    expect(h.repo.allOpportunities()[0]).toMatchObject({ profitableDepth: 2, bookDepth: 3 });
    expect(h.titles()).toEqual(['Profit: Team Captain']);
    expect(h.repo.getMeta(NOTIFY_META_KEY)).toContain(row.key);
    h.engine.stop();
  });

  it('a minimum of 1 passes a flip whose own buyer clears break-even', async () => {
    const h = setup({ notifications: { minProfitableDepth: 1 } });
    oneAtBreakEven(h);
    await h.engine.runNow();
    expect(h.titles()).toEqual(['Profit: Team Captain']);
  });

  it('at 0 (the default) the toasts are 0.8\'s', async () => {
    expect(DEFAULT_SETTINGS.notifications.minProfitableDepth).toBe(0);
    const h = setup();
    oneAtBreakEven(h);
    await h.engine.runNow();
    expect(h.titles()).toEqual(['Profit: Team Captain']);
    expect(h.repo.getMeta(NOTIFY_META_KEY)).not.toBeNull();
  });
});

describe('0.9 (#3): the one-time rewrite of a row stored before V16', () => {
  it('upserts a row with no risk fields once on the first full run, and not again on the second', async () => {
    const repo = newRepo();
    const first = setup({ notifications: { enabled: false } }, repo);
    first.buyer('top', 108, true);
    first.buyer('next', 100);
    repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: 60, source: 'user', observedAt: T0 - MIN });
    await first.engine.runNow();
    const stored = repo.allOpportunities()[0]!;
    expect(stored).toMatchObject({ profitableDepth: 2, bookDepth: 2, backupProfitScrap: 40 });

    // As a 0.8 build left it: the V16 columns NULL.
    const { backupProfitScrap: _b, profitableDepth: _d, bookDepth: _k, ...bare } = stored;
    repo.upsertOpportunities([bare as Opportunity]);
    const read = repo.allOpportunities()[0]!;
    expect('bookDepth' in read || 'profitableDepth' in read || 'backupProfitScrap' in read).toBe(false);

    const h = setup({ notifications: { enabled: false } }, repo);
    const spy = vi.spyOn(repo, 'upsertOpportunities');
    const written = (): string[] => spy.mock.calls.flatMap(([rows]) => rows.map((o) => o.key));
    await h.engine.runNow();
    expect(written()).toEqual([stored.key]);
    expect(repo.allOpportunities()[0]).toMatchObject({ profitableDepth: 2, bookDepth: 2, backupProfitScrap: 40 });
    spy.mockClear();
    h.clock.advance(1000);
    await h.engine.runNow();
    expect(written()).toEqual([]);
    spy.mockRestore();
  });
});
