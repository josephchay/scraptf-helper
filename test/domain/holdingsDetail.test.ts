// 0.8 (H7): Holdings.detail, the item drawer's "Your holding & trades" from one local read: the SKU's row (advice
// included), its open lots, its closed trades newest first, the typical hold and the base's recorded runs in the
// window (with `truncated`), and the history behind the holding. Real in-memory repo and market index, fake clock
// and timers; nothing here touches the network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { HOLDINGS_CHECK_MS, createHoldings, type Holdings } from '../../src/service/domain/holdings';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { HOLDING_DETAIL_LEAD_MS, HOLDING_DETAIL_MAX_MARKS, HOLDING_DETAIL_UNHELD_MS, holdingExitHistory } from '../../src/shared/holdingAdvice';
import type { HoldingMark, JournalEntry, Listing } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingLogger } from './helpers';

const DAY = 24 * HOUR;
const PAINTED = '378;6;p3100495';
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

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

let journalTs = T0 - 20 * DAY;
beforeEach(() => {
  journalTs = T0 - 20 * DAY;
});
function rec(repo: Repo, side: JournalEntry['side'], sku: string, scrap: number, gapMs = HOUR): JournalEntry {
  journalTs += gapMs;
  return repo.addJournal({ ts: journalTs, side, venue: side === 'buy' ? 'scrap.tf' : 'backpack.tf', sku, name: sku, keys: 0, scrap, keyPriceScrap: 567, note: null });
}

const RUN = {
  baseSku: '378;6',
  revKeys: 0,
  revIsBot: true,
  revVerified: true,
  bestKeys: 0,
  bestMetalScrap: 120,
  nextKeys: null,
  nextMetalScrap: null,
  buyerCount: 1,
  verifiedBuyerCount: 1,
  askKeys: null,
  askMetalScrap: null,
  askCount: null,
  scraptfPaysKeys: null,
  scraptfPaysScrap: null,
  keyScrap: 567,
} as const;

function insertRun(repo: Repo, fromAt: number, toAt: number, revMetalScrap = 120, baseSku = '378;6'): void {
  repo.insertHoldingMark({ ...RUN, baseSku, revMetalScrap, fromAt, toAt });
}

function setup(repo: Repo): { holdings: Holdings; clock: FakeClock; K: () => number } {
  const clock = new FakeClock(T0);
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { enabled: false } });
  const deps = makeDeps(repo, clock, () => settings, recordingLogger());
  const schema = createStubSchema();
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
  let holdings!: Holdings;
  const market = createMarketIndex({
    ...deps,
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    onBasesChanged: (b) => holdings.onBasesChanged(b),
    sliceNow: () => 0,
  });
  holdings = createHoldings({ ...deps, schema, market, timers, keyPrice, notify: () => undefined });
  market.start();
  holdings.start();
  timers.advance(0);
  timers.advance(HOLDINGS_CHECK_MS);
  return { holdings, clock, K: () => keyPrice().valueScrap };
}

describe("'holdings.detail' (H7)", () => {
  it('answers a held SKU: its row, open lots, closed trades newest first, the runs in the window and the history', () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'A1', isBot: true })]);
    // Two closed flips (the second a day later), then two open lots.
    rec(repo, 'buy', '378;6', 80);
    const sold1 = rec(repo, 'sell', '378;6', 100, DAY);
    rec(repo, 'buy', '378;6', 85);
    const sold2 = rec(repo, 'sell', '378;6', 105, DAY);
    const lot1 = rec(repo, 'buy', '378;6', 90);
    const lot2 = rec(repo, 'buy', '378;6', 95);
    // A run before the window, two inside it, and one of another base.
    insertRun(repo, lot1.ts - HOLDING_DETAIL_LEAD_MS - 3 * HOUR, lot1.ts - HOLDING_DETAIL_LEAD_MS - HOUR, 110);
    insertRun(repo, lot1.ts - HOUR, lot1.ts + 20 * HOUR, 115);
    insertRun(repo, lot1.ts + 20 * HOUR, T0 - HOUR, 120);
    insertRun(repo, lot1.ts, T0, 60, '126;6');
    const { holdings, K } = setup(repo);

    const d = holdings.detail('378;6', T0);
    expect(d).toMatchObject({ sku: '378;6', baseSku: '378;6', truncated: false, keyScrap: K(), generatedAt: T0 });
    expect(d.row).toMatchObject({ sku: '378;6', qty: 2, heldSince: lot1.ts, revenueScrap: 120, status: 'sell' });
    expect(d.row!.advice?.kind).toBeDefined();
    expect(d.lots.map((l) => l.id)).toEqual([lot1.id, lot2.id]);
    expect(d.closed.map((c) => c.sellId)).toEqual([sold2.id, sold1.id]);
    expect(d.closed[0]).toMatchObject({ kind: 'sell', sku: '378;6', profitScrap: 20 });
    expect(d.marks.map((m) => m.revMetalScrap)).toEqual([115, 120]);
    expect(d.history).toEqual(holdingExitHistory(d.marks, lot1.ts, K(), T0));
    expect(d.history!.runs).toBe(2);
    // Two own sales: too few for a typical hold of its own, and five are needed over every item.
    expect(d.typicalHold).toBeNull();
  });

  it("keeps the newest runs and says so when the window holds more than the drawer's cap", () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'A1' })]);
    const lot = rec(repo, 'buy', '378;6', 90);
    repo.transaction(() => {
      for (let i = 0; i <= HOLDING_DETAIL_MAX_MARKS; i++) insertRun(repo, lot.ts + i * 10 * MIN, lot.ts + i * 10 * MIN + 5 * MIN, 100 + (i % 7));
    });
    const { holdings } = setup(repo);
    const d = holdings.detail('378;6', T0);
    expect(d.truncated).toBe(true);
    expect(d.marks).toHaveLength(HOLDING_DETAIL_MAX_MARKS);
    expect(d.marks[0]!.fromAt).toBe(lot.ts + 10 * MIN);
    expect(d.marks.at(-1)!.fromAt).toBe(lot.ts + HOLDING_DETAIL_MAX_MARKS * 10 * MIN);
  });

  it("reads a painted SKU's runs from its base, beside the painted row", () => {
    const repo = newRepo();
    repo.upsertListings([buy('378;6', 120, { id: 'tc', steamid: 'A1' })]);
    const lot = rec(repo, 'buy', PAINTED, 95);
    insertRun(repo, lot.ts + HOUR, T0 - HOUR, 120);
    const { holdings } = setup(repo);
    const d = holdings.detail(PAINTED, T0);
    expect(d).toMatchObject({ sku: PAINTED, baseSku: '378;6' });
    expect(d.row).toMatchObject({ sku: PAINTED, revenueScrap: 120 });
    expect(d.row!.flags).toContain('has-extras');
    expect(d.lots.map((l) => l.id)).toEqual([lot.id]);
    expect(d.marks).toHaveLength(1);
    expect(d.history?.runs).toBe(1);
    // The clean SKU is not held: its own answer has no row.
    expect(holdings.detail('378;6', T0).row).toBeNull();
  });

  it('answers an unheld SKU with the last 30 days of runs and its past trades, no row', () => {
    const repo = newRepo();
    rec(repo, 'buy', '126;6', 50);
    const sold = rec(repo, 'sell', '126;6', 60);
    insertRun(repo, T0 - HOLDING_DETAIL_UNHELD_MS - 2 * DAY, T0 - HOLDING_DETAIL_UNHELD_MS - DAY, 60, '126;6');
    insertRun(repo, T0 - 2 * DAY, T0 - DAY, 60, '126;6');
    const { holdings } = setup(repo);
    const d = holdings.detail('126;6', T0);
    expect(d).toMatchObject({ sku: '126;6', baseSku: '126;6', row: null, lots: [], history: null, truncated: false });
    expect(d.closed.map((c) => c.sellId)).toEqual([sold.id]);
    expect(d.marks.map((m: HoldingMark) => m.fromAt)).toEqual([T0 - 2 * DAY]);
    // Nothing at all known.
    expect(holdings.detail('205;6', T0)).toMatchObject({ row: null, lots: [], closed: [], marks: [], typicalHold: null, history: null });
  });

  it('answers a currency with no base and no runs', () => {
    const repo = newRepo();
    rec(repo, 'buy', '5021;6', 0);
    const { holdings } = setup(repo);
    const d = holdings.detail('5021;6', T0);
    expect(d).toMatchObject({ sku: '5021;6', baseSku: null, marks: [], truncated: false });
    // A held currency still has its lots and row (no buy side).
    expect(d.lots).toHaveLength(1);
    expect(d.row).toMatchObject({ sku: '5021;6', status: 'no-buyers', ask: null, refs: null, snapshotAt: null });
    expect(d.history).toEqual({ runs: 0, observedMs: 0, firstAt: null, trend: null });
  });
});
