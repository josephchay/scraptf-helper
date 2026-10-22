// 0.8 (H1, H3, H4, H6): Holdings records exit runs from what its checks already computed, only while the live feed
// is up (HoldingsDeps.feedLiveSince), for held and watched bases (HoldingsDeps.markBases), with a 30-min heartbeat;
// and every row carries the copy-matched ask, the age-gated references, the last snapshot, the journal's typical
// hold and the advice. The holdings.test.ts harness: real in-memory repo and market index, fake clock and timers;
// nothing here touches the network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { HOLDINGS_ASK_CACHE_MS, HOLDINGS_CHECK_MS, HOLDINGS_MARK_SETTINGS_META_KEY, createHoldings, type Holdings } from '../../src/service/domain/holdings';
import { HOLDING_MARK_HEARTBEAT_MS } from '../../src/service/domain/holdingMarks';
import { holdingMarkSettingsKey } from '../../src/shared/holdingAdvice';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { MARKET_DIRTY_BATCH_MS, MARKET_NOTIFY_MS, createMarketIndex } from '../../src/service/domain/market';
import { formatScrap } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { DeepPartial, HoldingRow, JournalEntry, Listing, Settings, UnixMs } from '../../src/shared/types';
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

function sell(baseSku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ intent: 'sell', sku: baseSku, baseSku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

/** Team Captain 120 (Alice, bot), Bill's Hat 60 (Bob). */
function seedBooks(repo: Repo): void {
  repo.upsertListings([
    buy('378;6', 120, { id: 'tc', steamid: '76561198000000001', userName: 'Alice', isBot: true }),
    buy('126;6', 60, { id: 'bh', steamid: '76561198000000002', userName: 'Bob' }),
  ]);
}

let journalTs = T0 - 20 * DAY;
beforeEach(() => {
  journalTs = T0 - 20 * DAY;
});
function rec(repo: Repo, side: JournalEntry['side'], sku: string, scrap: number): JournalEntry {
  journalTs += HOUR;
  return repo.addJournal({ ts: journalTs, side, venue: side === 'buy' ? 'scrap.tf' : 'backpack.tf', sku, name: sku, keys: 0, scrap, keyPriceScrap: 567, note: null });
}

interface Opts {
  repo?: Repo;
  settings?: DeepPartial<Settings>;
  /** false: no feedLiveSince dep at all (0.7.4 callers, tests). */
  recording?: boolean;
  markBases?: string[];
  schema?: SchemaService;
}

function setup(opts: Opts = {}) {
  const repo = opts.repo ?? newRepo();
  const clock = new FakeClock(T0);
  const timers = new FakeTimers(clock);
  const settings = { current: mergeSettings(mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } }), opts.settings ?? {}) };
  const log = recordingLogger();
  const schema = opts.schema ?? createStubSchema();
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings.current, clock.now());
  const deps = makeDeps(repo, clock, () => settings.current, log);
  const notes: PushContract['notify'][] = [];
  const feed = { since: T0 - HOUR as UnixMs | null };
  const watched = { bases: new Set(opts.markBases ?? []) };
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
  holdings = createHoldings({
    ...deps,
    schema,
    market,
    timers,
    keyPrice,
    notify: (n) => notes.push(n),
    ...(opts.recording === false ? {} : { feedLiveSince: () => feed.since }),
    markBases: () => watched.bases,
  });
  const settle = () => timers.advance(MARKET_DIRTY_BATCH_MS + MARKET_NOTIFY_MS + HOLDINGS_CHECK_MS);
  return {
    repo,
    clock,
    timers,
    log,
    feed,
    watched,
    settings,
    holdings,
    notes,
    K: () => keyPrice().valueScrap,
    start() {
      market.start();
      holdings.start();
      timers.advance(0);
      timers.advance(HOLDINGS_CHECK_MS);
    },
    book(upserts: Listing[]) {
      repo.upsertListings(upserts);
      market.markDirty(upserts.map((l) => l.baseSku));
      settle();
    },
    runs: (base: string) => repo.holdingMarks(base, 0, 5000),
    row: (sku: string): HoldingRow | undefined => holdings.list({}, clock.now()).rows.find((r) => r.sku === sku),
  };
}

describe('recorded exits (H1)', () => {
  it('records a run from a check, and a book change starts the next', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 90);
    const h = setup({ repo });
    h.start();
    const first = h.runs('378;6');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ revKeys: 0, revMetalScrap: 120, revIsBot: true, revVerified: true, bestMetalScrap: 120, buyerCount: 1, keyScrap: h.K() });
    // Bill's Hat is neither held nor watched: not recorded.
    expect(h.runs('126;6')).toEqual([]);

    h.book([buy('378;6', 130, { id: 'tc', steamid: '76561198000000001', userName: 'Alice', isBot: true, lastEventAt: h.clock.now() })]);
    const runs = h.runs('378;6');
    expect(runs).toHaveLength(2);
    // The first run ends at its last sighting, never at the change.
    expect(runs[0]!.toAt).toBe(first[0]!.toAt);
    expect(runs[1]).toMatchObject({ revMetalScrap: 130 });
    expect(runs[1]!.fromAt).toBeGreaterThan(first[0]!.toAt);
  });

  it('extends the run every 30 min on the heartbeat and catches an ask change no market move reports', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 90);
    const h = setup({ repo });
    h.start();
    const first = h.runs('378;6')[0]!;
    h.timers.advance(HOLDING_MARK_HEARTBEAT_MS + HOLDINGS_CHECK_MS);
    const extended = h.runs('378;6');
    expect(extended).toHaveLength(1);
    expect(extended[0]!.toAt).toBeGreaterThanOrEqual(first.toAt + HOLDING_MARK_HEARTBEAT_MS - HOLDINGS_CHECK_MS);

    // A seller lists the same copy: sell listings fire no market move, so only the heartbeat sees it.
    repo.upsertListings([sell('378;6', 150, { id: 's1', steamid: 'SELLER', lastEventAt: h.clock.now() })]);
    h.timers.advance(HOLDING_MARK_HEARTBEAT_MS + HOLDINGS_CHECK_MS);
    const runs = h.runs('378;6');
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ askKeys: 0, askMetalScrap: 150, askCount: 1, revMetalScrap: 120 });
  });

  it('records a watched base nothing holds on its own book change, without waiting for the heartbeat', () => {
    const repo = newRepo();
    seedBooks(repo);
    const h = setup({ repo, markBases: ['126;6'] });
    h.start();
    expect(h.runs('126;6')).toMatchObject([{ revMetalScrap: 60, buyerCount: 1 }]);
    expect(h.runs('378;6')).toEqual([]);
    h.book([buy('126;6', 70, { id: 'bh', steamid: '76561198000000002', userName: 'Bob', lastEventAt: h.clock.now() })]);
    expect(h.runs('126;6').map((r) => r.revMetalScrap)).toEqual([60, 70]);
  });

  it('records every watched base on a full check with nothing held, and on markBasesChanged()', () => {
    const repo = newRepo();
    seedBooks(repo);
    // No book at all: no market move ever names it.
    const h = setup({ repo, markBases: ['15000;6'] });
    h.start();
    expect(h.runs('15000;6')).toEqual([]);
    h.holdings.settingsChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.runs('15000;6')).toMatchObject([{ revMetalScrap: null, revVerified: null, buyerCount: 0, askMetalScrap: null }]);

    h.watched.bases = new Set(['15000;6', '205;6']);
    h.holdings.markBasesChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.runs('205;6')).toHaveLength(1);
  });

  it('records nothing while the feed is not live, and runs no heartbeat without feedLiveSince', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 90);
    const h = setup({ repo, markBases: ['126;6'] });
    h.feed.since = null;
    h.start();
    h.book([buy('378;6', 130, { id: 'tc', steamid: '76561198000000001', lastEventAt: T0 })]);
    h.timers.advance(2 * HOLDING_MARK_HEARTBEAT_MS);
    expect(h.runs('378;6')).toEqual([]);
    expect(h.runs('126;6')).toEqual([]);

    // The heartbeat is the only extra timer recording adds.
    const withFeed = setup({ repo: newRepo() });
    const without = setup({ repo: newRepo(), recording: false });
    withFeed.start();
    without.start();
    expect(withFeed.timers.count - without.timers.count).toBe(1);
    without.timers.advance(3 * HOLDING_MARK_HEARTBEAT_MS);
    expect(without.repo.holdingMarks('378;6', 0)).toEqual([]);
  });

  it('writes the last sighting on stop()', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 90);
    const h = setup({ repo });
    h.start();
    const first = h.runs('378;6')[0]!;
    h.timers.advance(5 * MIN);
    // A full check at the same prices: seen, not yet written (under 10 min).
    h.holdings.settingsChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(h.runs('378;6')[0]!.toAt).toBe(first.toAt);
    h.holdings.stop();
    expect(h.runs('378;6')[0]!.toAt).toBe(h.clock.now());
  });

  it('leaves the "Sell:" notifications as they were', () => {
    const notesOf = (recording: boolean) => {
      const repo = newRepo();
      seedBooks(repo);
      rec(repo, 'buy', '378;6', 100);
      const h = setup({ repo, recording, markBases: ['126;6'] });
      h.start();
      h.timers.advance(HOLDING_MARK_HEARTBEAT_MS + HOLDINGS_CHECK_MS);
      return { notes: h.notes, K: h.K() };
    };
    const on = notesOf(true);
    expect(on.notes).toEqual(notesOf(false).notes);
    expect(on.notes).toEqual([{ title: 'Sell: Team Captain', body: `Alice pays ${formatScrap(120, on.K)} (bot), +${formatScrap(20, on.K)} over your cost`, sku: '378;6' }]);
  });
});

describe('row extras (H3, H4, H6)', () => {
  // 999;6 is filed as a twin of 378;6's book; 378;6 is the canonical base.
  const twinSchema = (): SchemaService => ({
    ...createStubSchema(),
    bookBases: (b: string) => (b === '378;6' || b === '999;6' ? ['378;6', '999;6'] : [b]),
    bookBase: (b: string) => (b === '999;6' ? '378;6' : b),
  });

  function seeded() {
    const repo = newRepo();
    seedBooks(repo);
    // Three closed sales of the clean copy (each held a day), then one open lot of each.
    for (let i = 0; i < 3; i++) {
      rec(repo, 'buy', '378;6', 80);
      journalTs += DAY - HOUR;
      rec(repo, 'sell', '378;6', 100);
    }
    rec(repo, 'buy', '378;6', 90);
    rec(repo, 'buy', PAINTED, 95);
    rec(repo, 'buy', '999;6', 50);
    repo.upsertListings([
      sell('378;6', 140, { id: 'c1', steamid: 'S1', isBot: true }),
      sell('378;6', 150, { id: 'p1', steamid: 'S2', sku: PAINTED }),
      // Filed under the twin: the same item's book.
      sell('999;6', 135, { id: 'c2', steamid: 'S3' }),
      // A spelled copy is not the held one.
      sell('378;6', 100, { id: 'spell', steamid: 'S4', special: { paint: null, spells: ['Exorcism'], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false } }),
    ]);
    const pdbTime = Math.floor((T0 - 3 * DAY) / 1000);
    repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 100, sellKeys: 0, sellScrap: 110, time: pdbTime, fetchedAt: T0 }]);
    repo.upsertCommunity([{ sku: '378;6', currency: 'metal', value: 12, valueHigh: null, lastUpdate: Math.floor((T0 - 400 * DAY) / 1000) }]);
    repo.setSnapshotAt('378;6', T0 - HOUR);
    const h = setup({ repo, schema: twinSchema(), recording: false });
    h.start();
    return { h, pdbTime };
  }

  it('carries the copy-matched ask side, twins merged', () => {
    const { h } = seeded();
    expect(h.row('378;6')!.ask).toMatchObject({ lowestScrap: 135, count: 2, botCount: 1, mayIncludeOwn: true });
    expect(h.row(PAINTED)!.ask).toMatchObject({ lowestScrap: 150, count: 1 });
    expect(h.row('999;6')!.ask).toMatchObject({ lowestScrap: 135, count: 2 });
  });

  it('keeps the sell listings for 60 s (a sell change fires no market move)', () => {
    const { h } = seeded();
    expect(h.row('378;6')!.ask?.lowestScrap).toBe(135);
    h.repo.upsertListings([sell('378;6', 120, { id: 'c3', steamid: 'S5', lastEventAt: h.clock.now() })]);
    expect(h.row('378;6')!.ask?.lowestScrap).toBe(135);
    h.timers.advance(HOLDINGS_ASK_CACHE_MS);
    expect(h.row('378;6')!.ask?.lowestScrap).toBe(120);
  });

  it("carries the usable references with the stale ones' reasons, the canonical twin's for a twin base", () => {
    const { h, pdbTime } = seeded();
    const expected = {
      pricedbBuyScrap: 100,
      pricedbSellScrap: 110,
      pricedbAgeMs: h.clock.now() - pdbTime * 1000,
      communityScrap: null,
      communityHighScrap: null,
      ignored: ['Community price is 400 days old, ignored'],
    };
    expect(h.row('378;6')!.refs).toEqual(expected);
    expect(h.row('999;6')!.refs).toEqual(expected);
    expect(h.row(PAINTED)!.refs).toEqual(expected);
  });

  it("carries the base's last snapshot, the journal's typical hold and the advice", () => {
    const { h } = seeded();
    const clean = h.row('378;6')!;
    expect(clean.snapshotAt).toBe(T0 - HOUR);
    expect(h.row(PAINTED)!.snapshotAt).toBe(T0 - HOUR);
    expect(h.row('999;6')!.snapshotAt).toBeNull();
    expect(clean.typicalHold).toMatchObject({ scope: 'item', count: 3 });
    for (const sku of ['378;6', PAINTED, '999;6']) expect(h.row(sku)!.advice?.kind).toMatch(/^(sell-now|list|hold|unclear)$/);
    // Nothing recorded yet: the advice says so.
    expect(clean.advice?.reasons.map((r) => r.code)).toContain('no-history');
    expect(clean.advice?.basis).toBeNull();
  });

  it('reads the recorded runs for the advice', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '378;6', 90);
    // Four runs of 20 h each, falling 150 -> 120, recorded before this session.
    const base = { baseSku: '378;6', revKeys: 0, revIsBot: true, revVerified: true, bestKeys: 0, bestMetalScrap: 120, nextKeys: null, nextMetalScrap: null, buyerCount: 1, verifiedBuyerCount: 1, askKeys: null, askMetalScrap: null, askCount: null, scraptfPaysKeys: null, scraptfPaysScrap: null, keyScrap: 567 };
    [150, 140, 130, 120].forEach((v, i) => repo.insertHoldingMark({ ...base, revMetalScrap: v, fromAt: T0 - (4 - i) * 20 * HOUR, toAt: T0 - (3 - i) * 20 * HOUR }));
    const h = setup({ repo, recording: false });
    h.start();
    const advice = h.row('378;6')!.advice!;
    expect(advice.basis).toMatchObject({ runs: 4 });
    expect(advice.reasons.map((r) => r.code)).toContain('falling');
  });
});

describe('review fixes (holdings)', () => {
  const markBase = { baseSku: '378;6', revKeys: 0, revIsBot: true, revVerified: true, bestKeys: 0, bestMetalScrap: 120, nextKeys: null, nextMetalScrap: null, buyerCount: 1, verifiedBuyerCount: 1, askKeys: null, askMetalScrap: null, askCount: null, scraptfPaysKeys: null, scraptfPaysScrap: null, keyScrap: 567 };

  it('a held currency asks for no refresh and waits for no history: it has no book', () => {
    const repo = newRepo();
    seedBooks(repo);
    rec(repo, 'buy', '5021;6', 567);
    const h = setup({ repo, recording: false });
    h.start();
    const row = h.row('5021;6')!;
    expect(row.status).toBe('no-buyers');
    expect(row.advice).toEqual({ kind: 'unclear', reasons: [{ code: 'no-exit' }], basis: null, refreshFirst: false });
  });

  it('dates a change to which buyers count, keeps it across a restart, and holds on no run recorded before it', () => {
    const repo = newRepo();
    seedBooks(repo);
    // Alice pays 120 for a unit that cost 115: +5, under the minimum of 9.
    rec(repo, 'buy', '378;6', 115);
    // 125 for 20 h, 160 for 20 h from a buyer the user then blocklists, 120 since.
    for (const [v, from, to] of [
      [125, 70, 50],
      [160, 50, 30],
      [120, 30, 0],
    ] as const) {
      repo.insertHoldingMark({ ...markBase, revMetalScrap: v, fromAt: T0 - from * HOUR, toAt: T0 - to * HOUR });
    }
    const h = setup({ repo, recording: false });
    h.start();
    expect(h.row('378;6')).toMatchObject({ status: 'hold' });
    expect(h.row('378;6')!.advice).toMatchObject({ kind: 'hold', reasons: [{ code: 'recorded-high', exitScrap: 160 }] });
    // The first read stores the buyer settings with no change known.
    const stored = () => JSON.parse(repo.getMeta(HOLDINGS_MARK_SETTINGS_META_KEY)!) as { key: string; at: number | null };
    expect(stored()).toEqual({ key: holdingMarkSettingsKey(h.settings.current), at: null });

    // A setting that does not pick the revenue order changes nothing here.
    h.settings.current = mergeSettings(h.settings.current, { profit: { referenceMaxAgeMs: 10 * DAY } });
    h.holdings.settingsChanged();
    h.timers.advance(HOLDINGS_CHECK_MS);
    expect(stored().at).toBeNull();
    expect(h.row('378;6')!.advice!.kind).toBe('hold');

    const changedAt = h.clock.now();
    h.settings.current = mergeSettings(h.settings.current, { blocklist: ['76561198000000009'] });
    h.holdings.settingsChanged();
    expect(stored()).toEqual({ key: holdingMarkSettingsKey(h.settings.current), at: changedAt });
    h.timers.advance(HOLDINGS_CHECK_MS);
    const after = h.row('378;6')!.advice!;
    expect(after.kind).toBe('unclear');
    expect(after.reasons[0]).toMatchObject({ code: 'no-history', settingsAt: changedAt });
    expect(after.reasons.map((r) => r.code)).not.toContain('recorded-high');
    expect(h.holdings.detail('378;6', h.clock.now()).history).toMatchObject({ settingsAt: changedAt, trend: null });

    // A restart over the same database keeps the date.
    h.holdings.stop();
    const again = setup({ repo, recording: false, settings: { blocklist: ['76561198000000009'] } });
    again.clock.advance(HOUR);
    again.start();
    const restarted = again.row('378;6')!.advice!;
    expect(restarted.kind).toBe('unclear');
    expect(restarted.reasons[0]).toMatchObject({ code: 'no-history', settingsAt: changedAt });
  });
});
