// 0.7.4 trading accuracy audit, package G2 (review R11, R39): Holdings' "Sell:" toasts wait for a backpack.tf
// buyer the engine would wait for. A held item whose revenue order nobody has confirmed for 24 h (no feed event
// or snapshot: the feed has no catch-up after the app was closed) is listed as 'sell' but not told, and nothing
// is recorded in the dedupe, so it is told once a snapshot or a feed event confirms the order. A rise on such an
// order keeps the old baseline. A fresh order is told at once, as before. The Holdings page's "Sells now for"
// tip says so (HOLDING_UNVERIFIED_NOTE). Real in-memory repo and market index, fake clock and timers; no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { HOLDINGS_CHECK_MS, HOLDINGS_NOTIFY_META_KEY, createHoldings, unverifiedRevenue, type Holdings } from '../../src/service/domain/holdings';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { MARKET_DIRTY_BATCH_MS, MARKET_NOTIFY_MS, createMarketIndex } from '../../src/service/domain/market';
import { UNVERIFIED_AFTER_MS } from '../../src/service/domain/matcher';
import { HOLDING_UNVERIFIED_NOTE, holdingSellsForTitle } from '../../src/renderer/holdingsModel';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { DeepPartial, Listing, ScraptfListRow, Settings } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingLogger } from './helpers';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup(seed: (repo: Repo) => void, patch: DeepPartial<Settings> = {}, listRow: ScraptfListRow | null = null) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  seed(repo);
  const clock = new FakeClock(T0);
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } }), patch);
  const schema = createStubSchema();
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
  const deps = makeDeps(repo, clock, () => settings, recordingLogger());
  const notes: PushContract['notify'][] = [];
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
  // 0.7.4: Team Captain's saved scrap.tf/items row, when a test gives one (the in-memory list cache's rowFor).
  const scraptfList = listRow ? { rowFor: (b: string) => (b === '378;6' ? listRow : null) } : undefined;
  holdings = createHoldings({ ...deps, schema, market, timers, keyPrice, notify: (n) => notes.push(n), ...(scraptfList ? { scraptfList } : {}) });
  const settle = () => timers.advance(MARKET_DIRTY_BATCH_MS + MARKET_NOTIFY_MS + HOLDINGS_CHECK_MS);
  market.start();
  holdings.start();
  timers.advance(0);
  timers.advance(HOLDINGS_CHECK_MS);
  return {
    repo,
    clock,
    notes,
    titles: () => notes.map((n) => n.title),
    row: (sku: string) => holdings.list({}, clock.now()).rows.find((r) => r.sku === sku),
    /** A settings change (or a key move): every held item is checked again. */
    recheck() {
      holdings.settingsChanged();
      timers.advance(HOLDINGS_CHECK_MS);
    },
    /** A book change as the feed or a snapshot makes it: stored, marked dirty, batched, pushed, checked. */
    book(upserts: Listing[]) {
      repo.upsertListings(upserts);
      market.markDirty(upserts.map((l) => l.baseSku));
      settle();
    },
  };
}

const order = (id: string, metalScrap: number, lastEventAt: number): Listing =>
  makeListing({ id, sku: '378;6', baseSku: '378;6', steamid: `S-${id}`, userName: 'Alice', metalScrap, isBot: true, lastEventAt });

function held(repo: Repo): void {
  repo.addJournal({ ts: T0 - 40 * HOUR, side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 0, scrap: 100, keyPriceScrap: 567, note: null });
}

describe('Holdings "Sell:" toasts on an unverified buyer (R11, R39)', () => {
  it('lists the row as sell but holds the toast, records nothing, and tells it once the order is confirmed', () => {
    const h = setup((repo) => {
      held(repo);
      repo.upsertListings([order('alice', 120, T0 - 30 * HOUR)]);
    });
    const r = h.row('378;6')!;
    expect(r).toMatchObject({ status: 'sell', bestExit: 'backpack', revenueScrap: 120 });
    expect(r.revenueOrder?.flags).toContain('unverified');
    expect(h.notes).toEqual([]);
    expect(h.repo.getMeta(HOLDINGS_NOTIFY_META_KEY) ?? '{}').not.toContain('378;6');

    // A snapshot (or the feed) sees the same order now: told once.
    h.clock.advance(MIN);
    h.book([order('alice', 120, h.clock.now())]);
    expect(h.titles()).toEqual(['Sell: Team Captain']);
    h.clock.advance(MIN);
    h.book([order('alice', 120, h.clock.now())]);
    expect(h.titles()).toEqual(['Sell: Team Captain']);
  });

  it('tells a fresh buyer at once, as before', () => {
    const h = setup((repo) => {
      held(repo);
      repo.upsertListings([order('alice', 120, T0 - 10 * MIN)]);
    });
    expect(h.titles()).toEqual(['Sell: Team Captain']);
  });

  it('holds the default-settings case the review reproduced (confidence 45 meets minConfidence 45)', () => {
    const h = setup(
      (repo) => {
        held(repo);
        repo.upsertListings([order('alice', 120, T0 - 72 * HOUR)]);
        repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 115, sellKeys: 0, sellScrap: 125, time: Math.floor(T0 / 1000) - 3600, fetchedAt: T0 }]);
      },
      { notifications: { minConfidence: DEFAULT_SETTINGS.notifications.minConfidence } },
    );
    expect(h.row('378;6')).toMatchObject({ status: 'sell', bestExit: 'backpack' });
    expect(h.notes).toEqual([]);
  });

  it('keeps the old baseline on a rise to an unverified order, and tells the rise once it is confirmed', () => {
    const h = setup((repo) => {
      held(repo);
      repo.upsertListings([order('alice', 120, T0 - 10 * MIN)]);
    });
    expect(h.titles()).toEqual(['Sell: Team Captain']);
    // A day passes with no feed event: the book is unverified. A richer bot order arrives by a snapshot taken
    // before the gap (its last event is old too): the profit rises, but on an order nobody has confirmed.
    h.clock.advance(25 * HOUR);
    h.book([order('bob', 200, T0 - 26 * HOUR)]);
    expect(h.row('378;6')?.revenueScrap).toBe(200);
    expect(h.titles()).toEqual(['Sell: Team Captain']);
    h.book([order('bob', 200, h.clock.now())]);
    expect(h.titles()).toEqual(['Sell: Team Captain', 'Sell: Team Captain']);
  });
});

describe('a held-back backpack.tf buyer falls back to a fresh scrap.tf exit (0.7.4 review, engine-network)', () => {
  // bestExitOf picks the exit by value only, so an unconfirmed 130-scrap order is the exit over scrap.tf's 120. Before
  // this fix the row was held back with no other exit tried: the scrap.tf sale was never told, and without an access
  // token (no snapshot) never would be. Now it is told through scrap.tf when that price clears the thresholds itself.
  const list = (over: Partial<ScraptfListRow> = {}): ScraptfListRow => ({
    sku: '378;6',
    name: 'Team Captain',
    sellsKeys: 0,
    sellsScrapRaw: 140,
    sellsScrap: 140,
    paysKeys: 0,
    paysScrapRaw: 120,
    paysScrap: 120,
    stock: 0,
    stockLimit: 3,
    full: false,
    observedAt: T0 - 10 * MIN,
    craft: 'craftable',
    ...over,
  });
  const pricedb = (repo: Repo) =>
    repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 125, sellKeys: 0, sellScrap: 135, time: Math.floor(T0 / 1000) - 3600, fetchedAt: T0 }]);
  const defaults = { notifications: { minConfidence: DEFAULT_SETTINGS.notifications.minConfidence } };
  const SCRAPTF_BODY = "scrap.tf's bank pays 13.33 ref (price list saved 10 min ago), +2.22 ref over your cost";
  const staleHeld = (repo: Repo, withPricedb = true) => {
    held(repo);
    repo.upsertListings([order('alice', 130, T0 - 30 * HOUR)]);
    if (withPricedb) pricedb(repo);
  };

  it('tells the scrap.tf sale when the only backpack.tf buyer is unconfirmed (confidence 45 meets the default 45)', () => {
    const h = setup((repo) => staleHeld(repo), defaults, list());
    expect(h.row('378;6')).toMatchObject({ status: 'sell', bestExit: 'backpack', exitScrap: 130, confidence: 45 });
    expect(h.row('378;6')?.revenueOrder?.flags).toContain('unverified');
    expect(h.notes).toEqual([{ title: 'Sell: Team Captain', body: SCRAPTF_BODY, sku: '378;6' }]);
    expect(h.repo.getMeta(HOLDINGS_NOTIFY_META_KEY) ?? '{}').toContain('378;6');
  });

  it('tells it too when the backpack.tf buyer is held back by minConfidence (no PriceDB row: confidence 25)', () => {
    const h = setup((repo) => staleHeld(repo, false), defaults, list());
    expect(h.row('378;6')?.confidence).toBeLessThan(DEFAULT_SETTINGS.notifications.minConfidence);
    expect(h.notes).toEqual([{ title: 'Sell: Team Captain', body: SCRAPTF_BODY, sku: '378;6' }]);
  });

  it('still holds the toast, recording nothing, when the list row is full, a day old or pays too little', () => {
    for (const [label, row] of [
      ['full', list({ stock: 3, full: true })],
      ['stale', list({ observedAt: T0 - 25 * HOUR })],
      ['below the thresholds', list({ paysScrapRaw: 101, paysScrap: 101 })],
    ] as const) {
      const h = setup((repo) => staleHeld(repo), defaults, row);
      expect(h.row('378;6'), label).toMatchObject({ status: 'sell', bestExit: 'backpack', exitScrap: 130 });
      expect(h.notes, label).toEqual([]);
      expect(h.repo.getMeta(HOLDINGS_NOTIFY_META_KEY) ?? '{}', label).not.toContain('378;6');
    }
  });

  it('does not tell it again: not when the order is confirmed inside the repeat time, not on a recheck after it', () => {
    const h = setup((repo) => staleHeld(repo), defaults, list());
    expect(h.titles()).toEqual(['Sell: Team Captain']);
    h.clock.advance(MIN);
    h.book([order('alice', 130, h.clock.now())]);
    expect(h.titles()).toEqual(['Sell: Team Captain']);

    // Nothing confirmed and nothing new: past the repeat time the same figures are no rise (the baseline is the
    // scrap.tf exit's profit that was told).
    const quiet = setup((repo) => staleHeld(repo), defaults, list());
    quiet.clock.advance(DEFAULT_SETTINGS.notifications.dedupMs + MIN);
    quiet.recheck();
    expect(quiet.titles()).toEqual(['Sell: Team Captain']);
    // The buyer confirmed then is a rise of 1.11 ref over what was told: told through backpack.tf.
    quiet.book([order('alice', 130, quiet.clock.now())]);
    expect(quiet.notes.map((n) => n.body)).toEqual([SCRAPTF_BODY, 'Alice pays 14.44 ref (bot), +3.33 ref over your cost']);
  });

  it('tells a confirmed backpack.tf buyer above the list as before', () => {
    const h = setup(
      (repo) => {
        held(repo);
        repo.upsertListings([order('alice', 130, T0 - 10 * MIN)]);
        pricedb(repo);
      },
      defaults,
      list(),
    );
    expect(h.notes).toEqual([{ title: 'Sell: Team Captain', body: 'Alice pays 14.44 ref (bot), +3.33 ref over your cost', sku: '378;6' }]);
  });
});

describe('unverifiedRevenue', () => {
  it("reads the 'unverified' flag, or an order that aged past 24 h since its row was built", () => {
    const o = (flags: string[], lastEventAt: number) => ({ flags, lastEventAt });
    expect(unverifiedRevenue(null, T0)).toBe(false);
    expect(unverifiedRevenue(o(['unverified'], T0), T0)).toBe(true);
    expect(unverifiedRevenue(o([], T0 - UNVERIFIED_AFTER_MS), T0)).toBe(false);
    expect(unverifiedRevenue(o([], T0 - UNVERIFIED_AFTER_MS - 1), T0)).toBe(true);
    // A stamp ahead of the clock counts as recent; one that is not a number does not.
    expect(unverifiedRevenue(o([], T0 + HOUR), T0)).toBe(false);
    expect(unverifiedRevenue(o([], Number.NaN), T0)).toBe(true);
  });
});

describe('the Holdings page says so (R11)', () => {
  it('adds the note to "Sells now for" for an unverified buyer only', () => {
    const base = {
      revenueScrap: 120,
      bestScrap: 120,
      instantScrap: null,
      buyerCount: 1,
      revenueOrder: {
        listingId: 'alice',
        steamid: 'S-alice',
        userName: 'Alice',
        keys: 0,
        metalScrap: 120,
        valueScrap: 120,
        isBot: true,
        online: null,
        lastEventAt: T0 - 30 * HOUR,
        bumpedAt: null,
        details: '',
        flags: ['unverified'],
        eligible: true,
      },
    };
    expect(holdingSellsForTitle(base, 567, T0).endsWith(HOLDING_UNVERIFIED_NOTE)).toBe(true);
    expect(HOLDING_UNVERIFIED_NOTE).toMatch(/no "Sell:" notification for this buyer until a snapshot or the live feed confirms it/);
    expect(HOLDING_UNVERIFIED_NOTE).toMatch(/fresh scrap\.tf\/items price that clears your thresholds is still notified/);
    const fresh = { ...base, revenueOrder: { ...base.revenueOrder, flags: [], lastEventAt: T0 - MIN } };
    expect(holdingSellsForTitle(fresh, 567, T0)).not.toContain(HOLDING_UNVERIFIED_NOTE);
  });
});
