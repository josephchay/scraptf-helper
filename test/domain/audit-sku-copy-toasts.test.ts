// 0.7.3 audit (market-2): one look stores an item once per copy under its SKU (a killstreak weapon's or kit's
// sheen/killstreaker combos, painted or spelled copies), each its own opportunity. Every profitable copy was
// toasted on its own, so one save of three cheap copies sent three identical "Profit: <item>" toasts, all for
// the one buy order, and folded a distinct flip into the unnamed summary. Copies of one SKU now share their
// most profitable copy's toast; every copy is still logged and recorded as told. Real in-memory repo, fake
// clock and timers, no toldElsewhere hook (a first save of a bank); nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { CHANGE_PROFIT_DELTA, MAX_NOTIFICATIONS_PER_RUN, NOTIFY_META_KEY, SWEEP_INTERVAL_MS, createEngine } from '../../src/service/domain/engine';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, special } from './helpers';

const K = 567;
const RL = '205;6;kt-3';
const openRepos: Repo[] = [];

afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const events = recordingEvents();
  const engine = createEngine({ ...makeDeps(repo, clock, () => settings), schema: createStubSchema(), events, timers });
  return { repo, clock, events, engine, settings };
}

/** One online bot buying the killstreak Rocket Launcher at 30 keys (any sheen and killstreaker), and three copies of one look. */
function seedCopies(repo: Repo) {
  repo.upsertListings([
    makeListing({ id: 'rl-bot', sku: RL, baseSku: RL, steamid: 'R1', keys: 30, metalScrap: 0, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0, itemName: 'Rocket Launcher' }),
  ]);
  return [20, 21, 22].map((keys, i) =>
    repo.upsertScrapPrice({
      sku: RL,
      name: 'Professional Killstreak Rocket Launcher',
      costKeys: keys,
      costScrap: 0,
      source: 'import',
      observedAt: T0 - MIN,
      special: special({ sheen: 1 + i, killstreaker: 2001 + i }),
    }),
  );
}

/** The Team Captain book of engine.test.ts (a bot at 12 ref, two humans below) and an imported price of 10 ref. */
function seedTeamCaptain(repo: Repo): void {
  repo.upsertListings([
    makeListing({ id: 'tc-bot', steamid: 'S1', metalScrap: 108, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 - MIN }),
    makeListing({ id: 'tc-h1', steamid: 'S2', metalScrap: 105, lastEventAt: T0 - MIN }),
    makeListing({ id: 'tc-h2', steamid: 'S3', metalScrap: 102, lastEventAt: T0 - MIN }),
  ]);
  repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 100, sellKeys: 0, sellScrap: 120, time: Math.floor(T0 / 1000), fetchedAt: T0 }]);
  repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 90, source: 'import', observedAt: T0 - MIN });
}

describe('one toast per item for copies stored under one SKU (0.7.3)', () => {
  it('toasts the most profitable copy once, and a distinct flip keeps its own toast', async () => {
    const h = setup();
    seedCopies(h.repo);
    seedTeamCaptain(h.repo);
    await h.engine.runNow();

    expect(h.events.notified).toHaveLength(2);
    const [kit, tc] = h.events.notified;
    expect(kit).toMatchObject({ title: 'Profit: Professional Killstreak Rocket Launcher', sku: RL });
    expect(kit!.body.startsWith('10 keys (50%) — sell to bot buy order')).toBe(true);
    expect(tc).toEqual({ title: 'Profit: Team Captain', body: '2.00 ref (20%) — sell to bot buy order, pay up to 11.00 ref', sku: '378;6' });
    expect(h.events.notified.some((n) => n.sku === null)).toBe(false);

    // Every copy is still logged and recorded as told.
    expect(h.repo.listEvents({ kinds: ['notified'] })).toHaveLength(4);
    const told = JSON.parse(h.repo.getMeta(NOTIFY_META_KEY)!) as Record<string, { f: unknown }>;
    const profitable = h.repo.allOpportunities().filter((o) => o.status === 'profitable');
    expect(profitable).toHaveLength(4);
    expect(Object.keys(told).sort()).toEqual(profitable.map((o) => o.key).sort());
    for (const k of Object.keys(told)) expect(told[k]!.f).not.toBeNull();
  });

  it('does not toast the folded copies on a later run', async () => {
    const h = setup();
    const copies = seedCopies(h.repo);
    seedTeamCaptain(h.repo);
    await h.engine.runNow();
    expect(h.events.notified).toHaveLength(2);

    // Inside the window: the folded copies were recorded as told, so the next sweep does not toast them.
    h.clock.advance(SWEEP_INTERVAL_MS);
    await h.engine.runNow();
    expect(h.events.notified).toHaveLength(2);
    // Past it, with the buyer still online so every copy still passes the thresholds: nothing new, no toast.
    h.clock.advance(h.settings.notifications.dedupMs + MIN);
    const pulse = Math.floor(h.clock.now() / 1000);
    h.repo.upsertListings([
      makeListing({ id: 'rl-bot', sku: RL, baseSku: RL, steamid: 'R1', keys: 30, metalScrap: 0, isBot: true, uaLastPulse: pulse, userOnline: true, lastEventAt: h.clock.now(), itemName: 'Rocket Launcher' }),
    ]);
    h.engine.markDirty([RL]);
    await h.engine.runNow();
    const rows = h.repo.allOpportunities().filter((o) => o.sku === RL);
    expect(rows).toHaveLength(3);
    for (const o of rows) expect(o.confidence).toBeGreaterThanOrEqual(h.settings.notifications.minConfidence);
    expect(h.events.notified).toHaveLength(2);

    // A folded copy whose profit rises past the window is news again, and toasts alone.
    const third = copies[2]!;
    h.repo.upsertScrapPrice({ id: third.id, sku: RL, name: third.name, costKeys: 18, costScrap: 0, source: 'import', observedAt: third.observedAt, special: third.special });
    expect(18 * K).toBeLessThan(22 * K - CHANGE_PROFIT_DELTA);
    h.engine.markDirty([RL]);
    await h.engine.runNow();
    expect(h.events.notified).toHaveLength(3);
    expect(h.events.notified[2]).toMatchObject({ title: 'Profit: Professional Killstreak Rocket Launcher', sku: RL });
    expect(h.events.notified[2]!.body.startsWith('12 keys')).toBe(true);
  });

  it('counts items, not copies, in the summary toast', async () => {
    const h = setup();
    const n = MAX_NOTIFICATIONS_PER_RUN + 1;
    for (let i = 0; i < n; i++) {
      const sku = `${1000 + i};6`;
      h.repo.upsertListings([makeListing({ sku, baseSku: sku, metalScrap: 200 + i, isBot: true, uaLastPulse: Math.floor(T0 / 1000), lastEventAt: T0 })]);
      h.repo.upsertScrapPrice({ sku, name: `Item ${i}`, costScrap: 100, source: 'user', observedAt: T0 });
    }
    // A second, painted copy of the most profitable item, a little dearer: it qualifies too.
    h.repo.upsertScrapPrice({ sku: '1003;6', name: 'Item 3', costScrap: 101, source: 'user', observedAt: T0, special: special({ paint: 8208497 }) });
    await h.engine.runNow();

    expect(h.repo.listEvents({ kinds: ['notified'] })).toHaveLength(n + 1);
    expect(h.events.notified.map((x) => x.title)).toEqual(['Profit: Item 3', 'Profit: Item 2', 'Profit: Item 1', '1 more profitable flip']);
    expect(h.events.notified.at(-1)).toMatchObject({ sku: null });
  });
});
