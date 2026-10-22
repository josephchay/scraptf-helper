// 0.7.4 trading accuracy audit (package PB): toasts and confirm snapshots for unverified revenue orders.
// F13/F21/F47: a row whose revenue order (revenueOrderOf(opp, useOrder)) nobody has confirmed for 24 h is
// listed but never toasted, and not recorded, so it toasts once a feed event or snapshot confirms it;
// meanwhile core's snapshotPriority ranks its stored row for a background snapshot (F16/F24/F30; package G2
// retired the engine's separate confirm hook, see test/service/audit-074-snapshot-upside.test.ts).
// F23: the Live log's buyer tag says "last seen N ago" past 2 h instead of a frozen online flag.
// In-memory repo, fake clock; no network and no parsing (no schema fixture needed).

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { NOTIFY_META_KEY, createEngine } from '../../src/service/domain/engine';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, Listing, Settings } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents } from './helpers';

const K = 567;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup(patch: DeepPartial<Settings> = {}) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  const clock = new FakeClock();
  const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 }, ...patch });
  const events = recordingEvents();
  const engine = createEngine({
    ...makeDeps(repo, clock, () => settings),
    schema: createStubSchema(),
    events,
    timers: new FakeTimers(clock),
  });
  const titles = (): string[] => events.notified.map((n) => n.title);
  return { repo, clock, engine, events, titles };
}

type H = ReturnType<typeof setup>;

const tc = (over: Partial<Listing>): Listing => makeListing({ sku: '378;6', baseSku: '378;6', ...over });

/** A fresh import of Team Captain at 60 scrap and one bot order at 108 seen `ageMs` ago. */
function seed(h: H, ageMs: number): void {
  h.repo.upsertListings([tc({ id: 'tc-bot', steamid: 'S1', metalScrap: 108, isBot: true, userOnline: true, lastEventAt: h.clock.t - ageMs })]);
  h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: h.clock.t - MIN });
}

describe('no toast on an unverified revenue order (F13, F21, F47)', () => {
  it('lists the row, records nothing, and toasts once the order is confirmed', async () => {
    const h = setup();
    seed(h, 30 * HOUR);
    await h.engine.runNow();
    const [row] = h.repo.allOpportunities();
    expect(row).toMatchObject({ status: 'profitable', revenueScrap: 108 });
    expect(row!.flags).toContain('unverified-orders');
    expect(h.titles()).toEqual([]);
    expect(h.repo.listEvents({ kinds: ['notified'] })).toEqual([]);
    expect(JSON.parse(h.repo.getMeta(NOTIFY_META_KEY) ?? '{}')).toEqual({});

    // Still unconfirmed a minute later: still no toast.
    h.clock.advance(MIN);
    await h.engine.runNow();
    expect(h.titles()).toEqual([]);

    // A snapshot (or a feed event) confirms the order: now it is news.
    h.repo.upsertListings([tc({ id: 'tc-bot', steamid: 'S1', metalScrap: 108, isBot: true, userOnline: true, lastEventAt: h.clock.t })]);
    h.clock.advance(MIN);
    await h.engine.runNow();
    expect(h.titles()).toEqual(['Profit: Team Captain']);
  });

  it('toasts a fresh revenue order at once', async () => {
    const h = setup();
    seed(h, 10 * MIN);
    await h.engine.runNow();
    expect(h.titles()).toEqual(['Profit: Team Captain']);
  });

  it('judges the order the settings sell to: Best on a stale order is held back, Conservative on the fresh one is not', async () => {
    const book = (h: H) => {
      h.repo.upsertListings([
        tc({ id: 'stale', steamid: 'S1', metalScrap: 120, isBot: true, lastEventAt: h.clock.t - 40 * HOUR }),
        tc({ id: 'fresh', steamid: 'S2', metalScrap: 108, lastEventAt: h.clock.t - MIN }),
      ]);
      h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: h.clock.t - MIN });
    };
    const cons = setup();
    book(cons);
    await cons.engine.runNow();
    expect(cons.repo.allOpportunities()[0]).toMatchObject({ revenueScrap: 108, bestScrap: 120 });
    expect(cons.titles()).toEqual(['Profit: Team Captain']);

    const best = setup({ profit: { useOrder: 'best' } });
    book(best);
    await best.engine.runNow();
    expect(best.repo.allOpportunities()[0]).toMatchObject({ revenueScrap: 120, status: 'profitable' });
    expect(best.titles()).toEqual([]);
  });
});

describe("the Live log's buyer tag (F23)", () => {
  it('says "online" for a recent order and "last seen N ago" past 2 h', async () => {
    const fresh = setup();
    seed(fresh, 10 * MIN);
    await fresh.engine.runNow();
    expect(fresh.repo.listEvents({ kinds: ['appeared'] })[0]?.summary).toMatch(/\(bot, online\)$/);

    const aged = setup();
    seed(aged, 3 * HOUR);
    await aged.engine.runNow();
    expect(aged.repo.listEvents({ kinds: ['appeared'] })[0]?.summary).toMatch(/\(bot, last seen 3 h ago\)$/);
  });
});
