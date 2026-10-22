// 0.9 (history, RESEARCH #6): the buy-order spell tracker (src/service/domain/orderSpells.ts) over a real in-memory
// repo, with stub key price and top orders. It follows tracked bases' top buy orders from feed batches only; holds a
// delete or inactive report for the 60 s relist grace (and at least one status tick); censors every followed spell
// ('unwatched') wherever the stream broke; and never writes a listing id, a SteamID or a name.

import { afterEach, describe, expect, it } from 'vitest';
import type { FeedBatch, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createOrderSpellTracker, type OrderSpellTracker } from '../../src/service/domain/orderSpells';
import { ORDER_SPELL_OPEN_MAX, ORDER_SPELL_RELIST_GRACE_MS, ORDER_SPELL_TOUCH_MS } from '../../src/shared/orderPersistence';
import type { Listing, OrderSpell } from '../../src/shared/types';
import { createLogger, type RecordingLogger } from '../bptf/helpers';
import { HOUR, MIN, T0, makeListing } from './helpers';

const DAY = 24 * HOUR;
const BASE = '378;6';
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

interface Harness {
  repo: Repo;
  tracker: OrderSpellTracker;
  log: RecordingLogger;
  tops: Map<string, number>;
  key: { scrap: number };
  tracked: Set<string>;
  batch(b: Partial<FeedBatch>, at: number): void;
  spells(): OrderSpell[];
}

function harness(wrap?: (repo: Repo) => Repo): Harness {
  const real = openRepo(':memory:');
  repos.push(real);
  const repo = wrap ? wrap(real) : real;
  const log = createLogger();
  const tops = new Map<string, number>([[BASE, 100]]);
  const key = { scrap: 500 };
  const tracked = new Set([BASE]);
  const tracker = createOrderSpellTracker({ repo, log, keyScrap: () => key.scrap, topOf: (b) => tops.get(b) ?? null });
  return {
    repo: real,
    tracker,
    log,
    tops,
    key,
    tracked,
    batch: (b, at) => tracker.onBatch({ upserts: [], deletes: [], ...b }, tracked, at),
    spells: () => real.orderSpells([BASE, '126;6'], 0, 5_000),
  };
}

/** A bot buy order of 378;6 at `metal` scrap, listed an hour before T0. */
const order = (id: string, metal: number, over: Partial<Listing> = {}): Listing =>
  makeListing({ id, steamid: `7656119800000${id.length}`, isBot: true, metalScrap: metal, listedAt: Math.floor((T0 - HOUR) / 1000), ...over });

describe('opening and continuing', () => {
  it('opens on a tracked buy update worth the share of the top, and on nothing else', () => {
    const h = harness();
    h.batch({ upserts: [order('a', 70), order('b', 69), order('c', 90, { baseSku: '126;6', sku: '126;6' }), order('d', 95, { intent: 'sell' })] }, T0);
    expect(h.tracker.following()).toBe(1);
    expect(h.spells()).toEqual([
      { id: 1, baseSku: BASE, intent: 'buy', isBot: true, keys: 0, metalScrap: 70, listedAt: Math.floor((T0 - HOUR) / 1000), firstSeenAt: T0, lastSeenAt: T0, endAt: null, endKind: null },
    ]);
  });

  it('continues the spell at the same price (a new listedAt or a bump) and ends it lowered or raised at another', () => {
    const h = harness();
    h.batch({ upserts: [order('a', 90)] }, T0);
    h.batch({ upserts: [order('a', 90, { listedAt: Math.floor(T0 / 1000), bumpedAt: Math.floor(T0 / 1000) })] }, T0 + MIN);
    expect(h.spells()).toHaveLength(1);
    h.batch({ upserts: [order('a', 80)] }, T0 + 2 * MIN);
    h.batch({ upserts: [order('a', 85)] }, T0 + 3 * MIN);
    expect(h.spells().map((s) => [s.metalScrap, s.firstSeenAt, s.endAt, s.endKind])).toEqual([
      [90, T0, T0 + 2 * MIN, 'lowered'],
      [80, T0 + 2 * MIN, T0 + 3 * MIN, 'raised'],
      [85, T0 + 3 * MIN, null, null],
    ]);
    // Lowered below the share: the spell ends and nothing new is followed.
    h.batch({ upserts: [order('a', 60)] }, T0 + 4 * MIN);
    expect(h.spells().at(-1)).toMatchObject({ metalScrap: 85, endKind: 'lowered', endAt: T0 + 4 * MIN });
    expect(h.tracker.following()).toBe(0);
  });

  it('never opens for an untracked base, a sell order, a marketplace order, a banned buyer or an impersonator', () => {
    const h = harness();
    h.tops.set('126;6', 100);
    h.batch(
      {
        upserts: [
          order('u', 90, { baseSku: '126;6', sku: '126;6' }),
          order('s', 90, { intent: 'sell' }),
          order('m', 90, { isMarketplace: true }),
          order('b', 90, { userBanned: true }),
          order('i', 90, { userImpersonated: true }),
        ],
      },
      T0,
    );
    expect(h.spells()).toEqual([]);
    // No top for the base: nothing to compare with.
    h.tops.delete(BASE);
    h.batch({ upserts: [order('a', 90)] }, T0 + MIN);
    expect(h.spells()).toEqual([]);
  });

  it('writes every spell with exactly the OrderSpell keys (no listing id, SteamID or name)', () => {
    const h = harness((repo) => ({
      ...repo,
      transaction: repo.transaction.bind(repo),
      insertOrderSpell: (s) => {
        expect(Object.keys(s).sort()).toEqual(['baseSku', 'endAt', 'endKind', 'firstSeenAt', 'intent', 'isBot', 'keys', 'listedAt', 'lastSeenAt', 'metalScrap'].sort());
        expect(JSON.stringify(s)).not.toMatch(/steamid|7656119|userName|Buyer|"a"/i);
        return repo.insertOrderSpell(s);
      },
    }));
    h.batch({ upserts: [order('a', 90, { userName: 'Buyer A', details: 'buying!' })] }, T0);
    expect(h.spells()).toHaveLength(1);
  });
});

describe('ending (H2: the relist grace)', () => {
  it("ends a delete 'deleted' at its own batch time, once a tick at least 60 s later settles it", () => {
    const h = harness();
    h.batch({ upserts: [order('a', 90)] }, T0);
    h.batch({ deletes: ['a'] }, T0 + 10_000);
    h.tracker.tick(true, T0 + 10_000 + ORDER_SPELL_RELIST_GRACE_MS - 1);
    expect(h.spells()[0]!.endKind).toBeNull();
    h.tracker.tick(true, T0 + 10_000 + ORDER_SPELL_RELIST_GRACE_MS);
    expect(h.spells()[0]).toMatchObject({ endKind: 'deleted', endAt: T0 + 10_000 });
    expect(h.tracker.following()).toBe(0);
  });

  it("ends a delete listed in the batch's inactive 'inactive' (D9), settled the same way", () => {
    const h = harness();
    h.batch({ upserts: [order('a', 90)] }, T0);
    h.batch({ deletes: ['a'], inactive: ['a'] }, T0 + 5_000);
    h.tracker.tick(true, T0 + 5_000 + ORDER_SPELL_RELIST_GRACE_MS);
    expect(h.spells()[0]).toMatchObject({ endKind: 'inactive', endAt: T0 + 5_000 });
  });

  it("does not count a relist as an end (ws-sample's 440_15860240047 shape): 'relisted' at the delete, a new spell at the new listedAt", () => {
    const h = harness();
    const listed = Math.floor((T0 - HOUR) / 1000);
    h.batch({ upserts: [order('a', 90, { listedAt: listed })] }, T0);
    h.batch({ deletes: ['a'] }, T0 + MIN);
    // The same id 5 s later, in another batch, at the same price, listedAt moved.
    h.batch({ upserts: [order('a', 90, { listedAt: listed + 1801 })] }, T0 + MIN + 5_000);
    h.tracker.tick(true, T0 + 5 * MIN);
    expect(h.spells().map((s) => [s.listedAt, s.firstSeenAt, s.endAt, s.endKind])).toEqual([
      [listed, T0, T0 + MIN, 'relisted'],
      [listed + 1801, T0 + MIN + 5_000, null, null],
    ]);
    expect(h.tracker.following()).toBe(1);
  });

  it("ends a relist at a higher price 'relisted' too, and one at a lower price 'lowered' at the delete", () => {
    const up = harness();
    up.batch({ upserts: [order('a', 90)] }, T0);
    up.batch({ deletes: ['a'] }, T0 + MIN);
    up.batch({ upserts: [order('a', 95)] }, T0 + MIN + 5_000);
    expect(up.spells().map((s) => [s.metalScrap, s.endKind, s.endAt])).toEqual([
      [90, 'relisted', T0 + MIN],
      [95, null, null],
    ]);
    const down = harness();
    down.batch({ upserts: [order('a', 90)] }, T0);
    down.batch({ deletes: ['a'], inactive: ['a'] }, T0 + MIN);
    down.batch({ upserts: [order('a', 85)] }, T0 + MIN + 5_000);
    expect(down.spells().map((s) => [s.metalScrap, s.endKind, s.endAt])).toEqual([
      [90, 'lowered', T0 + MIN],
      [85, null, null],
    ]);
  });

  it('review: never touches a held spell past its delete, so a crash in the grace censors it where it was last confirmed', () => {
    const h = harness();
    h.batch({ upserts: [order('a', 90), order('b', 90)] }, T0);
    h.batch({ deletes: ['a'] }, T0 + 10 * MIN);
    h.batch({ upserts: [] }, T0 + 10 * MIN + 30_000);
    // The tick inside a's grace touches the followed rows at the last batch, b only.
    h.tracker.tick(true, T0 + 10 * MIN + 40_000);
    expect(h.spells().map((s) => [s.endKind, s.lastSeenAt])).toEqual([
      [null, T0],
      [null, T0 + 10 * MIN + 30_000],
    ]);
    // A crash, then a restart: start() censors what the crash left followed.
    const restarted = createOrderSpellTracker({ repo: h.repo, log: h.log, keyScrap: () => 500, topOf: () => 100 });
    restarted.start();
    expect(h.spells().map((s) => [s.endKind, s.endAt])).toEqual([
      ['unwatched', T0],
      ['unwatched', T0 + 10 * MIN + 30_000],
    ]);
  });

  it("review: settles a held delete with last_seen_at at its end, even with a touch inside the grace", () => {
    const h = harness();
    h.batch({ upserts: [order('a', 90), order('b', 90)] }, T0);
    h.batch({ deletes: ['a'] }, T0 + 10 * MIN);
    h.batch({ upserts: [] }, T0 + 10 * MIN + 30_000);
    h.tracker.tick(true, T0 + 10 * MIN + 40_000);
    h.tracker.tick(true, T0 + 11 * MIN);
    expect(h.spells()[0]).toMatchObject({ endKind: 'deleted', endAt: T0 + 10 * MIN, lastSeenAt: T0 + 10 * MIN });
  });

  it("ends a held delete 'unwatched' at the delete's time when the stream breaks inside the grace", () => {
    const epoch = harness();
    epoch.batch({ upserts: [order('a', 90), order('b', 90)], epoch: 1 }, T0);
    epoch.batch({ deletes: ['a'], epoch: 1 }, T0 + MIN);
    epoch.batch({ upserts: [], epoch: 2 }, T0 + MIN + 20_000);
    expect(epoch.spells().map((s) => [s.endKind, s.endAt])).toEqual([
      ['unwatched', T0 + MIN],
      // b was last seen at the old stream's last batch.
      ['unwatched', T0 + MIN],
    ]);
    const stopped = harness();
    stopped.batch({ upserts: [order('a', 90)] }, T0);
    stopped.batch({ deletes: ['a'] }, T0 + MIN);
    stopped.tracker.tick(false, T0 + MIN + 10_000);
    expect(stopped.spells().map((s) => [s.endKind, s.endAt])).toEqual([['unwatched', T0 + MIN]]);
  });
});

describe('censoring where the stream broke (H3, H4)', () => {
  it("ends every followed spell 'unwatched' at the old stream's last batch on an epoch change", () => {
    const h = harness();
    h.batch({ upserts: [order('a', 90)], epoch: 3 }, T0);
    h.batch({ upserts: [order('b', 95)], epoch: 3 }, T0 + 30_000);
    // Batches without an epoch (hand-built) are the same stream.
    h.batch({ upserts: [] }, T0 + 40_000);
    expect(h.spells().every((s) => s.endKind === null)).toBe(true);
    h.batch({ upserts: [order('a', 90)], epoch: 4 }, T0 + 5 * MIN);
    expect(h.spells().map((s) => [s.metalScrap, s.firstSeenAt, s.lastSeenAt, s.endKind])).toEqual([
      [90, T0, T0 + 40_000, 'unwatched'],
      [95, T0 + 30_000, T0 + 40_000, 'unwatched'],
      [90, T0 + 5 * MIN, T0 + 5 * MIN, null],
    ]);
  });

  it('ends all on a clock moved back', () => {
    const h = harness();
    h.batch({ upserts: [order('a', 90)] }, T0);
    h.batch({ upserts: [] }, T0 - 1_000);
    expect(h.spells()[0]).toMatchObject({ endKind: 'unwatched', endAt: T0 });
    expect(h.tracker.following()).toBe(0);
  });

  it('tick(false) ends all and resets; tick(true) writes last_seen_at at most every 10 min', () => {
    const h = harness();
    h.batch({ upserts: [order('a', 90)], epoch: 1 }, T0);
    h.batch({ upserts: [] }, T0 + MIN);
    h.tracker.tick(true, T0 + MIN);
    expect(h.spells()[0]!.lastSeenAt).toBe(T0 + MIN);
    h.batch({ upserts: [] }, T0 + 2 * MIN);
    h.tracker.tick(true, T0 + 2 * MIN);
    expect(h.spells()[0]!.lastSeenAt).toBe(T0 + MIN);
    h.tracker.tick(true, T0 + MIN + ORDER_SPELL_TOUCH_MS);
    expect(h.spells()[0]!.lastSeenAt).toBe(T0 + 2 * MIN);
    h.tracker.tick(false, T0 + 20 * MIN);
    expect(h.spells()[0]).toMatchObject({ endKind: 'unwatched', endAt: T0 + 2 * MIN });
    // Reset: the same epoch afterwards is a new stream, and an earlier clock no longer counts as a step back.
    h.batch({ upserts: [order('a', 90)], epoch: 1 }, T0 + 19 * MIN);
    expect(h.spells()[1]).toMatchObject({ firstSeenAt: T0 + 19 * MIN, endKind: null });
  });

  it("start() ends rows a crash left followed; stop() ends the rest 'unwatched'", () => {
    const h = harness();
    h.repo.insertOrderSpell({ baseSku: BASE, intent: 'buy', isBot: false, keys: 0, metalScrap: 90, listedAt: null, firstSeenAt: T0 - DAY, lastSeenAt: T0 - DAY + HOUR, endAt: null, endKind: null });
    h.tracker.start();
    expect(h.spells()[0]).toMatchObject({ endKind: 'unwatched', endAt: T0 - DAY + HOUR });
    h.batch({ upserts: [order('a', 90)] }, T0);
    h.batch({ upserts: [] }, T0 + MIN);
    h.tracker.stop();
    expect(h.spells()[1]).toMatchObject({ endKind: 'unwatched', endAt: T0 + MIN });
    expect(h.tracker.following()).toBe(0);
  });

  it('logs once a day how many spells it wrote', () => {
    const h = harness();
    h.tracker.tick(true, T0);
    h.batch({ upserts: [order('a', 90), order('b', 90)] }, T0 + MIN);
    h.batch({ upserts: [order('a', 80)] }, T0 + 2 * MIN);
    h.tracker.tick(true, T0 + DAY - 1);
    expect(h.log.text()).not.toMatch(/spells written/);
    h.tracker.tick(true, T0 + DAY);
    expect(h.log.lines.filter((l) => /spells written/.test(l.msg)).map((l) => l.msg)).toEqual(['Buy-order persistence: 3 spells written in the last day, 2 followed now']);
    h.tracker.tick(true, T0 + 2 * DAY);
    expect(h.log.lines.filter((l) => /spells written/.test(l.msg)).map((l) => l.msg).at(-1)).toBe('Buy-order persistence: 0 spells written in the last day, 2 followed now');
  });
});

describe('failures', () => {
  it(`follows at most ${ORDER_SPELL_OPEN_MAX.toLocaleString('en-US')} orders at once and says so once`, () => {
    const h = harness();
    const many = Array.from({ length: ORDER_SPELL_OPEN_MAX + 5 }, (_, i) => order(`o${i}`, 90));
    h.batch({ upserts: many }, T0);
    h.batch({ upserts: [order('x', 90), order('y', 90)] }, T0 + MIN);
    expect(h.tracker.following()).toBe(ORDER_SPELL_OPEN_MAX);
    expect(h.log.lines.filter((l) => /at most 20,000 orders/.test(l.msg))).toHaveLength(1);
  });

  it('logs a throwing repo once per streak, never throws into the feed, and ends dirty rows before following again', () => {
    let broken = false;
    const h = harness((repo) => ({
      ...repo,
      transaction: <T>(fn: () => T): T => {
        if (broken) throw new Error('database is locked');
        return repo.transaction(fn);
      },
    }));
    h.batch({ upserts: [order('a', 90)] }, T0);
    broken = true;
    expect(() => h.batch({ upserts: [order('b', 95)] }, T0 + MIN)).not.toThrow();
    expect(() => h.batch({ upserts: [order('c', 95)] }, T0 + 2 * MIN)).not.toThrow();
    expect(h.log.lines.filter((l) => l.level === 'warn' && /Could not record how long buy orders stay/.test(l.msg))).toHaveLength(1);
    expect(h.tracker.following()).toBe(0);
    broken = false;
    h.batch({ upserts: [order('a', 90)] }, T0 + 3 * MIN);
    // a (followed before the failure) was ended 'unwatched' first; then a opens again as a new spell.
    expect(h.spells().map((s) => [s.metalScrap, s.firstSeenAt, s.endKind])).toEqual([
      [90, T0, 'unwatched'],
      [90, T0 + 3 * MIN, null],
    ]);
    expect(h.tracker.following()).toBe(1);
    // A new streak logs again.
    broken = true;
    h.batch({ upserts: [order('d', 95)] }, T0 + 4 * MIN);
    expect(h.log.lines.filter((l) => /Could not record how long buy orders stay/.test(l.msg))).toHaveLength(2);
  });

  it('ignores a batch at a time that is not a number', () => {
    const h = harness();
    h.batch({ upserts: [order('a', 90)] }, Number.NaN);
    h.tracker.tick(true, Number.NaN);
    expect(h.spells()).toEqual([]);
  });
});
