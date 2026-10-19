import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import type { DeepPartial, Listing, Settings } from '../../src/shared/types';
import {
  MAX_NOTIFICATIONS_PER_RUN,
  MAX_NOTIFIED_EVENTS_PER_RUN,
  NOTIFY_META_KEY,
  RETENTION,
  SWEEP_INTERVAL_MS,
  createEngine,
  evaluateOpportunity,
  explicitInput,
  ruleInput,
  runMaintenance,
} from '../../src/service/domain/engine';
import type { EvaluateArgs } from '../../src/service/domain/engine';
import { matchContext } from '../../src/service/domain/matcher';
import {
  FakeClock,
  FakeTimers,
  HOUR,
  MIN,
  T0,
  createStubSchema,
  makeDeps,
  makeListing,
  recordingEvents,
  recordingLogger,
} from './helpers';
import type { StubSchemaOptions } from './helpers';
import { mergeSettings, DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { BANK_STOCK_MAX_AGE_MS } from '../../src/shared/bankStock';
import { SCRAPTF_EVENTS_MAX_AGE_MS } from '../../src/shared/scraptfHistory';

const K = 567;
const openRepos: Repo[] = [];

afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
});

function newRepo(): Repo {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  return repo;
}

interface Harness {
  repo: Repo;
  clock: FakeClock;
  timers: FakeTimers;
  events: ReturnType<typeof recordingEvents>;
  log: ReturnType<typeof recordingLogger>;
  engine: ReturnType<typeof createEngine>;
  settings: { current: Settings };
}

function setup(opts: { repo?: Repo; clock?: FakeClock; settings?: DeepPartial<Settings>; schema?: StubSchemaOptions; schemaImpl?: ReturnType<typeof createStubSchema> } = {}): Harness {
  const repo = opts.repo ?? newRepo();
  const clock = opts.clock ?? new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, opts.settings ?? {}) };
  const events = recordingEvents();
  const log = recordingLogger();
  const schema = opts.schemaImpl ?? createStubSchema(opts.schema);
  const engine = createEngine({ ...makeDeps(repo, clock, () => settings.current, log), schema, events, timers });
  return { repo, clock, timers, events, log, engine, settings };
}

/** The Team Captain book from the walkthrough: a fresh online bot at 12 ref and two humans just below. */
function seedTeamCaptain(repo: Repo, now = T0): { priceId: number; ids: string[] } {
  const ids = ['tc-bot', 'tc-h1', 'tc-h2'];
  repo.upsertListings([
    makeListing({ id: ids[0], steamid: 'S1', metalScrap: 108, isBot: true, uaLastPulse: Math.floor(now / 1000), userOnline: true, lastEventAt: now - MIN }),
    makeListing({ id: ids[1], steamid: 'S2', metalScrap: 105, lastEventAt: now - MIN }),
    makeListing({ id: ids[2], steamid: 'S3', metalScrap: 102, lastEventAt: now - MIN }),
  ]);
  repo.upsertPricedb([{ sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 100, sellKeys: 0, sellScrap: 120, time: Math.floor(now / 1000), fetchedAt: now }]);
  const price = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 90, source: 'user', observedAt: now - MIN });
  return { priceId: price.id, ids };
}

function kinds(repo: Repo): string[] {
  return repo
    .listEvents({ limit: 1000 })
    .reverse()
    .map((e) => `${e.kind}:${e.key}`);
}

describe('engine end to end', () => {
  it('turns a price and buy orders into a profitable opportunity, an event and a notification', async () => {
    const h = setup();
    const { priceId } = seedTeamCaptain(h.repo);

    const r = await h.engine.runNow();
    expect(r.evaluated).toBe(1);

    const [o, ...rest] = h.repo.allOpportunities();
    expect(rest).toEqual([]);
    expect(o).toMatchObject({
      key: `378;6|price:${priceId}`,
      sku: '378;6',
      name: 'Team Captain',
      category: 'hats',
      inputKind: 'user',
      costScrap: 90,
      bestScrap: 108,
      consScrap: 108,
      instantScrap: 108,
      revenueScrap: 108,
      profitScrap: 18,
      margin: 0.2,
      // 99 is the largest cost that still leaves 9 scrap (minProfitScrap) at an 8%+ margin.
      maxCostScrap: 99,
      buyerCount: 3,
      status: 'profitable',
      profitTier: 'ref2',
      confidence: 100,
      confidenceLevel: 'high',
      firstSeenAt: T0,
      updatedAt: T0,
    });
    expect(o!.consOrder?.listingId).toBe('tc-bot');
    expect(o!.references.pricedb).toMatchObject({ buyScrap: 100, sellScrap: 120 });

    const events = h.repo.listEvents({});
    expect(events.map((e) => e.kind).sort()).toEqual(['appeared', 'notified']);
    expect(events.find((e) => e.kind === 'appeared')!.summary).toBe('profit 2.00 ref, 20% margin (bot, online)');
    expect(h.events.changed).toEqual([{ appeared: 1, changed: 0, gone: 0, at: T0 }]);
    expect(h.events.notified).toEqual([{ title: 'Profit: Team Captain', body: '2.00 ref (20%) — sell to bot buy order, pay up to 11.00 ref', sku: '378;6' }]);
    expect(h.engine.stats()).toMatchObject({ lastRunAt: T0, evaluated: 1 });
    expect(h.engine.keyPrice()).toMatchObject({ valueScrap: K, source: 'pricedb' });
  });

  it('does not rewrite or re-announce an unchanged opportunity', async () => {
    const h = setup();
    seedTeamCaptain(h.repo);
    await h.engine.runNow();
    const before = h.repo.allOpportunities();
    h.clock.advance(1000);
    await h.engine.runNow();
    expect(h.repo.allOpportunities()).toEqual(before);
    expect(h.repo.listEvents({})).toHaveLength(2);
    expect(h.events.changed).toHaveLength(1);
    expect(h.events.notified).toHaveLength(1);
  });

  it('reports changes, then the order disappearing, through dirty runs', () => {
    const h = setup();
    const { priceId } = seedTeamCaptain(h.repo);
    const key = `378;6|price:${priceId}`;
    h.engine.start();
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(key)?.status).toBe('profitable');

    // The bot raises its order by 1.33 ref.
    h.repo.upsertListings([makeListing({ id: 'tc-bot', steamid: 'S1', metalScrap: 120, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: h.clock.t })]);
    h.engine.markDirty(['378;6']);
    h.timers.advance(1000);
    const changed = h.repo.listEvents({ kinds: ['changed'] });
    expect(changed).toHaveLength(1);
    expect(changed[0]!.summary).toBe('profit 2.00 ref -> 3.33 ref (bot, online)');
    expect(h.repo.getOpportunity(key)?.profitScrap).toBe(30);

    // Every order goes away: the explicit price stays, with no buyers.
    h.repo.deleteListings(['tc-bot', 'tc-h1', 'tc-h2']);
    h.engine.markDirty(['378;6']);
    h.timers.advance(1000);
    const gone = h.repo.listEvents({ kinds: ['gone'] });
    expect(gone).toHaveLength(1);
    expect(gone[0]!.summary).toBe('profit 3.33 ref -> no buyers');
    expect(h.repo.getOpportunity(key)).toMatchObject({ status: 'no-buyers', profitTier: 'none', revenueScrap: null, buyerCount: 0 });
    expect(h.events.changed.at(-1)).toMatchObject({ appeared: 0, changed: 0, gone: 1 });

    // Below threshold is not "changed" and coming back is "appeared" again, but within the dedup window there is no second toast.
    h.repo.upsertListings([makeListing({ id: 'back', steamid: 'S9', metalScrap: 95, lastEventAt: h.clock.t })]);
    h.engine.markDirty(['378;6']);
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(key)?.status).toBe('below-threshold');
    h.repo.upsertListings([makeListing({ id: 'back', steamid: 'S9', metalScrap: 120, lastEventAt: h.clock.t })]);
    h.engine.markDirty(['378;6']);
    h.timers.advance(1000);
    expect(kinds(h.repo).filter((k) => k.startsWith('appeared'))).toHaveLength(2);
    expect(h.events.notified).toHaveLength(1);
    h.engine.stop();
  });

  it('emits "changed" for a confidence level change and for a new best buyer', async () => {
    const h = setup();
    const { priceId } = seedTeamCaptain(h.repo);
    await h.engine.runNow();
    // A different buyer outbids by 1 scrap: same profit band, new order.
    h.repo.upsertListings([makeListing({ id: 'new-bot', steamid: 'S7', metalScrap: 109, isBot: true, uaLastPulse: Math.floor(T0 / 1000), lastEventAt: T0 })]);
    await h.engine.runNow();
    const ev = h.repo.listEvents({ kinds: ['changed'] });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.summary).toBe('new buy order (bot)');
    expect(h.repo.getOpportunity(`378;6|price:${priceId}`)?.consOrder?.listingId).toBe('new-bot');

    // Hours later the input is stale: confidence drops a level.
    h.clock.advance(3 * HOUR);
    await h.engine.runNow();
    const level = h.repo.listEvents({ kinds: ['changed'] })[0]!;
    expect(level.summary).toMatch(/^confidence high -> (medium|low)/);
  });

  it('removes a deleted price on the next run, even if nobody marked it dirty', () => {
    const h = setup();
    const { priceId } = seedTeamCaptain(h.repo);
    h.engine.start();
    h.timers.advance(1000);
    h.repo.deleteScrapPrice(priceId);
    h.engine.markDirty(['126;6']);
    h.timers.advance(1000);
    expect(h.repo.allOpportunities()).toEqual([]);
    expect(h.repo.listEvents({ kinds: ['gone'] })[0]!.summary).toBe('profit 2.00 ref -> removed (scrap.tf price removed)');
    h.engine.stop();
  });

  it('skips currency SKUs and SKUs that are not SKUs', async () => {
    const h = setup();
    h.repo.upsertListings([makeListing({ sku: '5021;6', baseSku: '5021;6', metalScrap: 600 })]);
    h.repo.upsertScrapPrice({ sku: '5021;6', name: 'Key', costScrap: 500, source: 'user', observedAt: T0 });
    h.repo.upsertScrapPrice({ sku: 'not a sku', name: 'junk', costScrap: 5, source: 'user', observedAt: T0 });
    await h.engine.runNow();
    expect(h.repo.allOpportunities()).toEqual([]);
  });

  it('keeps explicit prices with no buy orders as "no-buyers" rows', async () => {
    const h = setup();
    h.repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 30, source: 'import', observedAt: T0 });
    await h.engine.runNow();
    const [o] = h.repo.allOpportunities();
    expect(o).toMatchObject({ sku: '126;6', status: 'no-buyers', inputKind: 'import', profitScrap: null, buyerCount: 0 });
    expect(h.repo.listEvents({})).toEqual([]);
  });

  it('matches a painted price against attribute-specific and generic orders', async () => {
    const h = setup();
    const PINK = 16738740;
    h.repo.upsertListings([
      makeListing({ id: 'generic', steamid: 'G', metalScrap: 100 }),
      makeListing({ id: 'pink', steamid: 'P', metalScrap: 150, sku: `378;6;p${PINK}`, special: { paint: PINK, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false } }),
    ]);
    h.repo.upsertScrapPrice({ sku: `378;6;p${PINK}`, name: 'Pink Team Captain', costScrap: 90, source: 'user', observedAt: T0, special: null });
    h.repo.upsertScrapPrice({
      sku: '378;6',
      name: 'Pink Team Captain (known)',
      costScrap: 90,
      source: 'import',
      observedAt: T0,
      special: { paint: PINK, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false },
    });
    await h.engine.runNow();
    const rows = h.repo.allOpportunities();
    const unknownExtras = rows.find((o) => o.sku === `378;6;p${PINK}`)!;
    const known = rows.find((o) => o.sku === '378;6')!;
    // Extras unknown: the pink order is attribute-specific; the generic one matches but undersells.
    expect(unknownExtras.consOrder?.listingId).toBe('generic');
    expect(unknownExtras.flags).toContain('has-extras');
    // Exactly pink: the pink order matches.
    expect(known.consOrder?.listingId).toBe('pink');
    expect(known.flags).not.toContain('has-extras');
  });
});

describe('generic any-effect unusual buy orders', () => {
  it('counts "Unusual <item>" orders without an effect as exits for every effect, flagged any-effect', async () => {
    const h = setup();
    const conga = '30672;5;u3010';
    h.repo.upsertListings([
      makeListing({ id: 'specific', steamid: 'A', sku: conga, baseSku: conga, keys: 10, metalScrap: 0 }),
      makeListing({ id: 'generic', steamid: 'B', sku: '30672;5', baseSku: '30672;5', keys: 12, metalScrap: 0, itemName: 'Unusual Taunt: Conga' }),
      makeListing({ id: 'other-item', steamid: 'C', sku: '30673;5', baseSku: '30673;5', keys: 50, metalScrap: 0 }),
    ]);
    h.repo.upsertScrapPrice({ sku: conga, name: 'Showstopper Taunt: Conga', costKeys: 9, costScrap: 0, source: 'user', observedAt: T0 - MIN });
    await h.engine.runNow();
    const [o] = h.repo.allOpportunities();
    expect(o!.bestOrder?.listingId).toBe('generic');
    expect(o!.bestOrder?.flags).toContain('any-effect');
    expect(o!.bestScrap).toBe(12 * K);
    expect(o!.buyerCount).toBe(2);
  });

  it('re-evaluates effect-specific prices when only the generic order book changes', async () => {
    const h = setup();
    const conga = '30672;5;u3010';
    h.repo.upsertScrapPrice({ sku: conga, name: 'Showstopper Taunt: Conga', costKeys: 9, costScrap: 0, source: 'user', observedAt: T0 - MIN });
    h.engine.start();
    h.timers.advance(1000);
    expect(h.repo.allOpportunities()[0]!.status).toBe('no-buyers');
    h.repo.upsertListings([makeListing({ id: 'generic', steamid: 'B', sku: '30672;5', baseSku: '30672;5', keys: 12, metalScrap: 0 })]);
    h.engine.markDirty(['30672;5']);
    h.timers.advance(1000);
    const o = h.repo.allOpportunities()[0]!;
    expect(o.status).toBe('profitable');
    expect(o.revenueScrap).toBe(12 * K);
    h.engine.stop();
  });

  const UNUSUALS_RULE = { name: 'Unusuals', filter: { categories: ['unusuals' as const] }, costKeys: 5, costScrap: 0, observedAt: T0 };
  const genericOrder = (keys: number): Listing =>
    makeListing({ id: 'generic', steamid: 'G', sku: '378;5', baseSku: '378;5', keys, metalScrap: 0, itemName: 'Unusual Team Captain' });
  const eventsFor = (repo: Repo, key: string): string[] =>
    repo
      .listEvents({ limit: 1000 })
      .filter((e) => e.key === key)
      .map((e) => e.kind);

  it('does not flap a rule row for an effect SKU whose only orders are generic ones', () => {
    const h = setup();
    h.repo.upsertListings([genericOrder(12)]);
    const rule = h.repo.upsertRule(UNUSUALS_RULE);
    const key = `378;5;u13|rule:${rule.id}`;
    h.engine.start();
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(key)).toBeNull();
    // e.g. a PriceDB row for the effect SKU marks it dirty; the full sweep cannot see it.
    for (let i = 0; i < 3; i++) {
      h.engine.markDirty(['378;5;u13']);
      h.timers.advance(1000);
      expect(h.repo.getOpportunity(key)).toBeNull();
      h.timers.advance(SWEEP_INTERVAL_MS);
      expect(h.repo.getOpportunity(key)).toBeNull();
    }
    expect(eventsFor(h.repo, key)).toEqual([]);
    // The generic base itself still gets its rule row.
    expect(h.repo.getOpportunity(`378;5|rule:${rule.id}`)?.status).toBe('profitable');
    h.engine.stop();
  });

  it('keeps a rule row for an effect SKU with its own orders stable across dirty runs and sweeps', () => {
    const h = setup();
    h.repo.upsertListings([
      genericOrder(12),
      makeListing({ id: 'own', steamid: 'O', sku: '378;5;u13', baseSku: '378;5;u13', keys: 1, metalScrap: 0 }),
    ]);
    const rule = h.repo.upsertRule(UNUSUALS_RULE);
    const key = `378;5;u13|rule:${rule.id}`;
    h.engine.start();
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(key)).toMatchObject({ status: 'profitable', revenueScrap: 12 * K });
    h.engine.markDirty(['378;5;u13']);
    h.timers.advance(1000);
    h.timers.advance(SWEEP_INTERVAL_MS);
    expect(h.repo.getOpportunity(key)?.status).toBe('profitable');
    expect(eventsFor(h.repo, key).filter((k) => k !== 'notified')).toEqual(['appeared']);
    h.engine.stop();
  });

  it('sees a new generic order for a rule-only effect SKU on the next tick, not 10 minutes later', () => {
    const h = setup();
    h.repo.upsertListings([makeListing({ id: 'own', steamid: 'O', sku: '378;5;u13', baseSku: '378;5;u13', keys: 1, metalScrap: 0 })]);
    const rule = h.repo.upsertRule(UNUSUALS_RULE);
    const key = `378;5;u13|rule:${rule.id}`;
    h.engine.start();
    h.timers.advance(1000);
    h.timers.advance(SWEEP_INTERVAL_MS); // a sweep caches bestRaw (1 key, below the 5-key rule cost)
    expect(h.repo.getOpportunity(key)).toBeNull();

    h.repo.upsertListings([genericOrder(12)]);
    h.engine.markDirty(['378;5']);
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(key)).toMatchObject({ status: 'profitable', revenueScrap: 12 * K, profitScrap: 7 * K });
    h.timers.advance(SWEEP_INTERVAL_MS);
    expect(h.repo.getOpportunity(key)?.status).toBe('profitable');
    h.engine.stop();
  });

  it('sees a new generic order for a rule-only effect SKU when a full run consumes the dirty mark', async () => {
    const h = setup();
    h.repo.upsertListings([makeListing({ id: 'own', steamid: 'O', sku: '378;5;u13', baseSku: '378;5;u13', keys: 1, metalScrap: 0 })]);
    const rule = h.repo.upsertRule(UNUSUALS_RULE);
    const key = `378;5;u13|rule:${rule.id}`;
    await h.engine.runNow();
    expect(h.repo.getOpportunity(key)).toBeNull();
    h.clock.advance(SWEEP_INTERVAL_MS);
    h.repo.upsertListings([genericOrder(12)]);
    h.engine.markDirty(['378;5']);
    await h.engine.runNow();
    expect(h.repo.getOpportunity(key)?.status).toBe('profitable');
  });
});

describe('notes keywords in the engine', () => {
  it('runs (and flags the order) when a keyword contains a hyphen', async () => {
    const h = setup({ settings: { profit: { notesKeywords: ['paint', 'pre-fest'] } } });
    const { priceId } = seedTeamCaptain(h.repo);
    h.repo.upsertListings([makeListing({ id: 'tc-notes', steamid: 'S9', metalScrap: 110, details: 'pre-fest only, buying fast' })]);
    await expect(h.engine.runNow()).resolves.toMatchObject({ evaluated: 1 });
    const o = h.repo.getOpportunity(`378;6|price:${priceId}`)!;
    expect(o.status).toBe('profitable');
    // The flagged order still counts as an exit, with the flag.
    expect(o.bestOrder).toMatchObject({ listingId: 'tc-notes' });
    expect(o.bestOrder?.flags).toContain('notes-flag');
  });
});

describe('notifications', () => {
  it('deduplicates per key across a restart, then past the window notifies again only what changed (ACT-2)', async () => {
    const repo = newRepo();
    const clock = new FakeClock();
    seedTeamCaptain(repo);

    const first = setup({ repo, clock });
    await first.engine.runNow();
    expect(first.events.notified).toHaveLength(1);
    first.engine.stop();
    // When, and what was told: the price's observedAt, the revenue order and the profit.
    expect(JSON.parse(repo.getMeta(NOTIFY_META_KEY)!)).toEqual({ [repo.allOpportunities()[0]!.key]: { t: T0, f: { obs: T0 - MIN, lid: 'tc-bot', p: 18 } } });

    // Restart: a fresh engine on the same database must not re-announce.
    const second = setup({ repo, clock });
    clock.advance(10 * MIN);
    await second.engine.runNow();
    expect(second.events.notified).toHaveLength(0);
    expect(second.events.changed.every((c) => c.appeared === 0)).toBe(true);

    // Past the window but unchanged: still nothing.
    clock.advance(20 * MIN);
    await second.engine.runNow();
    expect(second.events.notified).toHaveLength(0);

    // The bot raises its order by 1 ref: the profit rose by CHANGE_PROFIT_DELTA, worth a toast.
    repo.upsertListings([makeListing({ id: 'tc-bot', steamid: 'S1', metalScrap: 117, isBot: true, uaLastPulse: Math.floor(clock.t / 1000), userOnline: true, lastEventAt: clock.t })]);
    second.engine.markDirty(['378;6']);
    await second.engine.runNow();
    expect(second.events.notified).toHaveLength(1);
    expect(repo.listEvents({ kinds: ['notified'] })).toHaveLength(2);
  });

  it('survives a corrupt notification history', async () => {
    const h = setup();
    seedTeamCaptain(h.repo);
    h.repo.setMeta(NOTIFY_META_KEY, '{not json');
    await h.engine.runNow();
    expect(h.events.notified).toHaveLength(1);
    expect(h.log.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('respects the confidence, profit and enabled thresholds', async () => {
    for (const notifications of [{ enabled: false }, { minConfidence: 101 }, { minProfitScrap: 19 }]) {
      const h = setup({ settings: { notifications } });
      seedTeamCaptain(h.repo);
      await h.engine.runNow();
      expect(h.events.notified).toEqual([]);
      expect(h.repo.listEvents({ kinds: ['notified'] })).toEqual([]);
      expect(h.repo.listEvents({ kinds: ['appeared'] })).toHaveLength(1);
    }
  });

  it('folds a burst into a few toasts plus a summary', async () => {
    const h = setup();
    const n = MAX_NOTIFICATIONS_PER_RUN + 2;
    for (let i = 0; i < n; i++) {
      const sku = `${1000 + i};6`;
      h.repo.upsertListings([makeListing({ sku, baseSku: sku, metalScrap: 200 + i, isBot: true, uaLastPulse: Math.floor(T0 / 1000), lastEventAt: T0 })]);
      h.repo.upsertScrapPrice({ sku, name: `Item ${i}`, costScrap: 100, source: 'user', observedAt: T0 });
    }
    await h.engine.runNow();
    expect(h.events.notified).toHaveLength(MAX_NOTIFICATIONS_PER_RUN + 1);
    expect(h.events.notified.slice(0, MAX_NOTIFICATIONS_PER_RUN).map((x) => x.title)).toEqual(['Profit: Item 4', 'Profit: Item 3', 'Profit: Item 2']);
    expect(h.events.notified.at(-1)).toMatchObject({ title: '2 more profitable flips', sku: null });
    expect(h.repo.listEvents({ kinds: ['notified'] })).toHaveLength(n);
  });

  // Regression: the dedup map used to keep only the 5,000 newest keys, so with
  // more qualifying opportunities every sweep re-notified the evicted ones.
  it('does not re-notify more than 5,000 qualifying opportunities inside the window, and caps notified events', async () => {
    const h = setup();
    const n = 6000;
    const listings: Listing[] = [];
    for (let i = 0; i < n; i++) {
      const sku = `${200_000 + i};6`;
      listings.push(makeListing({ id: `n${i}`, sku, baseSku: sku, steamid: `N${i}`, metalScrap: 200 + (i % 50), isBot: true, uaLastPulse: Math.floor(T0 / 1000), lastEventAt: T0 }));
    }
    h.repo.upsertListings(listings);
    h.repo.upsertRule({ name: 'Everything', filter: {}, costScrap: 100, observedAt: T0 });
    for (let i = 0; i < 10; i++) h.repo.upsertScrapPrice({ sku: `${200_000 + i};6`, name: `Item ${i}`, costScrap: 100, source: 'user', observedAt: T0 });

    await h.engine.runNow();
    const qualifying = h.repo
      .allOpportunities()
      .filter((o) => o.status === 'profitable' && o.confidence >= h.settings.current.notifications.minConfidence && (o.profitScrap ?? 0) >= h.settings.current.notifications.minProfitScrap);
    expect(qualifying.length).toBeGreaterThan(5000);
    expect(h.events.notified).toHaveLength(MAX_NOTIFICATIONS_PER_RUN + 1);
    expect(h.repo.listEvents({ kinds: ['notified'] })).toHaveLength(MAX_NOTIFIED_EVENTS_PER_RUN);
    expect(Object.keys(JSON.parse(h.repo.getMeta(NOTIFY_META_KEY)!))).toHaveLength(qualifying.length);

    for (let sweep = 0; sweep < 3; sweep++) {
      h.clock.advance(SWEEP_INTERVAL_MS);
      await h.engine.runNow();
    }
    expect(h.events.notified).toHaveLength(MAX_NOTIFICATIONS_PER_RUN + 1);
    expect(h.repo.listEvents({ kinds: ['notified'] })).toHaveLength(MAX_NOTIFIED_EVENTS_PER_RUN);
  }, 60_000);
});

describe('price-sheet rules', () => {
  const HATS_RULE = { name: 'Unique craftable hats', filter: { categories: ['hats' as const], qualities: [6], craftable: true }, costScrap: 5, observedAt: T0 };

  function seedBook(repo: Repo): void {
    repo.upsertListings([
      makeListing({ id: 'bill-1', sku: '126;6', baseSku: '126;6', steamid: 'B1', metalScrap: 30 }),
      makeListing({ id: 'bill-2', sku: '126;6', baseSku: '126;6', steamid: 'B2', metalScrap: 28 }),
      makeListing({ id: 'bill-nc', sku: '126;6;uncraftable', baseSku: '126;6;uncraftable', steamid: 'B3', metalScrap: 30 }),
      makeListing({ id: 'rl', sku: '205;6', baseSku: '205;6', steamid: 'R1', metalScrap: 50 }),
      makeListing({ id: 'key', sku: '5021;6', baseSku: '5021;6', steamid: 'K1', metalScrap: 600 }),
      makeListing({ id: 'tc', sku: '378;6', baseSku: '378;6', steamid: 'T1', metalScrap: 108 }),
    ]);
  }

  it('evaluates matching SKUs with buy orders, lets explicit prices win and caps confidence', async () => {
    const h = setup();
    seedBook(h.repo);
    const rule = h.repo.upsertRule(HATS_RULE);
    const weapons = h.repo.upsertRule({ name: 'Weapons', filter: { categories: ['weapons'] }, costScrap: 100, observedAt: T0 });
    const price = h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 90, source: 'user', observedAt: T0 });

    await h.engine.runNow();
    const keys = h.repo.allOpportunities().map((o) => o.key).sort();
    expect(keys).toEqual([`126;6|rule:${rule.id}`, `378;6|price:${price.id}`]);
    expect(keys).not.toContain(`205;6|rule:${weapons.id}`); // unprofitable rule results are not stored

    const bill = h.repo.getOpportunity(`126;6|rule:${rule.id}`)!;
    expect(bill).toMatchObject({ inputKind: 'rule', name: "Bill's Hat", category: 'hats', costScrap: 5, revenueScrap: 30, profitScrap: 25, status: 'profitable' });
    expect(bill.flags).toContain('rule-estimate');
    expect(bill.confidence).toBeLessThanOrEqual(69);

    // Without the explicit price the rule covers the Team Captain too.
    h.repo.deleteScrapPrice(price.id);
    await h.engine.runNow();
    expect(h.repo.getOpportunity(`378;6|rule:${rule.id}`)).toMatchObject({ profitScrap: 103, inputKind: 'rule' });
    expect(h.repo.getOpportunity(`378;6|price:${price.id}`)).toBeNull();

    // An explicit price added later replaces the rule row.
    const bills = h.repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 20, source: 'user', observedAt: T0 });
    h.engine.start();
    h.engine.markDirty(['126;6']);
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(`126;6|rule:${rule.id}`)).toBeNull();
    expect(h.repo.getOpportunity(`126;6|price:${bills.id}`)).not.toBeNull();
    expect(h.repo.listEvents({ kinds: ['gone'] }).map((e) => e.summary)).toContain('profit 2.77 ref -> removed (replaced by your own price)');

    // Disabling the rule removes its rows (rules changed -> full sweep).
    h.repo.upsertRule({ ...HATS_RULE, id: rule.id, enabled: false });
    h.engine.markDirty(['zzz;6']);
    h.timers.advance(1000);
    expect(h.repo.allOpportunities().filter((o) => o.inputKind === 'rule')).toEqual([]);
    expect(h.repo.listEvents({ kinds: ['gone'] }).map((e) => e.summary)).toContain('profit 11.44 ref -> removed (rule removed or disabled)');
    h.engine.stop();
  });

  it('drops rule rows when their orders go away', () => {
    const h = setup();
    seedBook(h.repo);
    const rule = h.repo.upsertRule(HATS_RULE);
    h.engine.start();
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(`126;6|rule:${rule.id}`)).not.toBeNull();
    h.repo.deleteListings(['bill-1', 'bill-2']);
    h.engine.markDirty(['126;6']);
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(`126;6|rule:${rule.id}`)).toBeNull();
    h.engine.stop();
  });
});

describe('scheduling and re-evaluation', () => {
  function countingRepo(repo: Repo): { repo: Repo; runs: () => number } {
    let runs = 0;
    const proxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'listRules') {
          return () => {
            runs++;
            return target.listRules();
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return { repo: proxy, runs: () => runs };
  }

  it('debounces dirty marks into one run per second and sweeps every 60 s', () => {
    const c = countingRepo(newRepo());
    const h = setup({ repo: c.repo });
    h.engine.markDirty(['378;6']);
    expect(h.timers.count).toBe(0); // not started

    h.engine.start();
    h.timers.advance(999);
    expect(c.runs()).toBe(0);
    h.timers.advance(1);
    expect(c.runs()).toBe(1);

    h.engine.markDirty(['378;6']);
    h.engine.markDirty(new Set(['126;6']));
    h.timers.advance(500);
    h.engine.markDirty(['205;6']);
    h.timers.advance(500);
    expect(c.runs()).toBe(2);
    h.timers.advance(5000);
    expect(c.runs()).toBe(2); // nothing dirty, no run

    h.timers.advance(SWEEP_INTERVAL_MS);
    expect(c.runs()).toBe(3);

    h.engine.stop();
    expect(h.timers.count).toBe(0);
    h.engine.markDirty(['378;6']);
    h.timers.advance(SWEEP_INTERVAL_MS * 2);
    expect(c.runs()).toBe(3);
  });

  it('reuses unchanged order books on the periodic sweep and re-reads only dirty ones', async () => {
    const repo = newRepo();
    const read: string[] = [];
    const spy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'buyListingsByBaseSkus') {
          return (bases: string[]) => {
            read.push(...bases);
            return target.buyListingsByBaseSkus(bases);
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const h = setup({ repo: spy });
    const { priceId } = seedTeamCaptain(repo);
    repo.upsertListings([makeListing({ id: 'bill', sku: '126;6', baseSku: '126;6', steamid: 'B1', metalScrap: 30 })]);
    repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 10, source: 'user', observedAt: T0 });
    const key = `378;6|price:${priceId}`;

    h.engine.start();
    h.timers.advance(1000);
    expect([...read].sort()).toEqual(['126;6', '378;6']);
    expect(h.repo.getOpportunity(key)?.bestScrap).toBe(108);

    // The 60 s sweep re-scores every row but reads no unchanged book.
    read.length = 0;
    h.timers.advance(SWEEP_INTERVAL_MS);
    expect(h.engine.stats().lastRunAt).toBe(T0 + SWEEP_INTERVAL_MS);
    expect(read).toEqual([]);

    // A book marked dirty is read again, and the change shows.
    h.repo.upsertListings([makeListing({ id: 'tc-new', steamid: 'S8', metalScrap: 120, isBot: true, lastEventAt: h.clock.t })]);
    h.engine.markDirty(['378;6']);
    h.timers.advance(1000);
    expect(read).toEqual(['378;6']);
    expect(h.repo.getOpportunity(key)?.bestScrap).toBe(120);

    // markAllDirty and an explicit run read everything again.
    read.length = 0;
    h.engine.markAllDirty();
    h.timers.advance(1000);
    expect([...read].sort()).toEqual(['126;6', '378;6']);
    read.length = 0;
    await h.engine.runNow();
    expect([...read].sort()).toEqual(['126;6', '378;6']);
    h.engine.stop();
  });

  it('ignores junk passed to markDirty', () => {
    const h = setup();
    h.engine.start();
    h.timers.advance(1000);
    expect(() => h.engine.markDirty(null as unknown as string[])).not.toThrow();
    expect(() => h.engine.markDirty([42, '', '  '] as unknown as string[])).not.toThrow();
    h.engine.stop();
  });

  it('re-evaluates everything when settings change', () => {
    const h = setup();
    const { priceId } = seedTeamCaptain(h.repo);
    h.engine.start();
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(`378;6|price:${priceId}`)?.status).toBe('profitable');

    h.settings.current = mergeSettings(h.settings.current, { profit: { minMargin: 0.5 } });
    h.engine.markDirty(['126;6']); // an unrelated SKU; the settings change forces a full sweep
    h.timers.advance(1000);
    expect(h.repo.getOpportunity(`378;6|price:${priceId}`)?.status).toBe('below-threshold');
    expect(h.repo.listEvents({ kinds: ['gone'] })[0]!.summary).toBe('profit 2.00 ref -> 2.00 ref (below threshold)');
    h.engine.stop();
  });

  it('revalues key-priced orders when the key price changes', async () => {
    const h = setup();
    h.repo.upsertListings([makeListing({ sku: '30920;6', baseSku: '30920;6', keys: 1, metalScrap: 0, lastEventAt: T0 })]);
    const p = h.repo.upsertScrapPrice({ sku: '30920;6', name: 'Taunt: The Bunnyhopper', costScrap: 500, source: 'user', observedAt: T0 });
    await h.engine.runNow();
    expect(h.repo.getOpportunity(`30920;6|price:${p.id}`)).toMatchObject({ revenueScrap: K, profitScrap: K - 500, category: 'taunts' });

    h.repo.upsertKeyQuote({ source: 'bptf', buyScrap: 600, sellScrap: 605, observedAt: T0 });
    await h.engine.runNow();
    expect(h.repo.getOpportunity(`30920;6|price:${p.id}`)).toMatchObject({ revenueScrap: 600, profitScrap: 100 });
    expect(h.engine.keyPrice()).toMatchObject({ source: 'bptf', valueScrap: 600 });
  });

  it('ages inputs on the periodic sweep', () => {
    const h = setup();
    const { priceId } = seedTeamCaptain(h.repo);
    h.engine.start();
    h.timers.advance(1000);
    const key = `378;6|price:${priceId}`;
    expect(h.repo.getOpportunity(key)!.reasons).toContain('0 scrap.tf price is fresh (under 15 min)');
    h.timers.advance(20 * MIN);
    const aged = h.repo.getOpportunity(key)!;
    expect(aged.reasons).toContain('-10 scrap.tf price is between 15 min and 2 h old');
    expect(aged.updatedAt).toBeGreaterThan(T0 + 1000);
    expect(aged.firstSeenAt).toBe(T0 + 1000);
    h.engine.stop();
  });

  it('recovers from a failed run and from throwing listeners', () => {
    const repo = newRepo();
    seedTeamCaptain(repo);
    let fail = true;
    const flaky = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'listScrapPrices' && fail) {
          return () => {
            fail = false;
            throw new Error('disk on fire');
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const h = setup({ repo: flaky });
    h.events.onChanged = () => {
      throw new Error('listener bug');
    };
    h.engine.start();
    h.timers.advance(1000);
    expect(h.log.lines.find((l) => l.level === 'error')?.msg).toBe('Opportunity engine run failed');
    h.engine.markDirty(['378;6']);
    h.timers.advance(1000);
    expect(repo.allOpportunities()).toHaveLength(1);
    expect(h.log.lines.some((l) => l.level === 'warn' && l.msg === 'Engine event listener failed')).toBe(true);
    h.engine.stop();
  });

  it('falls back to SKU-only categories when the schema throws', async () => {
    const schema = createStubSchema();
    schema.categoryForSku = () => {
      throw new Error('schema not ready');
    };
    schema.nameForSku = () => {
      throw new Error('schema not ready');
    };
    const h = setup({ schemaImpl: schema });
    h.repo.upsertListings([makeListing({ sku: '205;11;kt-3', baseSku: '205;11;kt-3', metalScrap: 100 })]);
    h.repo.upsertScrapPrice({ sku: '205;11;kt-3', name: '', costScrap: 50, source: 'user', observedAt: T0 });
    await h.engine.runNow();
    expect(h.repo.allOpportunities()[0]).toMatchObject({ category: 'killstreaks', name: '205;11;kt-3' });
  });
});

describe('evaluateOpportunity', () => {
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const rule = { id: 3, name: 'r', filter: {}, costKeys: 0, costScrap: 100, observedAt: T0, enabled: true };

  function args(over: Partial<EvaluateArgs> = {}, profit: DeepPartial<Settings['profit']> = {}): EvaluateArgs {
    const s = mergeSettings(settings, { profit });
    return {
      input: ruleInput(rule, '378;6', 'Team Captain'),
      listings: [
        makeListing({ id: 'whale', steamid: 'W', metalScrap: 400 }),
        makeListing({ id: 'human', steamid: 'H', metalScrap: 150 }),
        makeListing({ id: 'bot', steamid: 'B', metalScrap: 140, isBot: true }),
        makeListing({ id: 'low', steamid: 'L', metalScrap: 130 }),
      ],
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

  it('uses the conservative order by default and flags an outlier best', () => {
    const o = evaluateOpportunity(args());
    expect(o).toMatchObject({ key: '378;6|rule:3', bestScrap: 400, consScrap: 150, instantScrap: 140, revenueScrap: 150, profitScrap: 50, margin: 0.5, buyerCount: 4 });
    expect(o.flags).toEqual(['outlier-best', 'no-reference', 'rule-estimate']);
    expect(o.bestOrder?.flags).toContain('outlier');
    expect(o.consOrder?.flags).not.toContain('outlier');
  });

  it('follows useOrder and subtracts friction', () => {
    expect(evaluateOpportunity(args({}, { useOrder: 'best' })).revenueScrap).toBe(400);
    expect(evaluateOpportunity(args({}, { useOrder: 'instant' })).revenueScrap).toBe(140);
    expect(evaluateOpportunity(args({}, { frictionScrap: 20 })).profitScrap).toBe(30);
    expect(evaluateOpportunity(args({}, { frictionScrap: -5 })).profitScrap).toBe(50);
  });

  it('reports no buyers when every order is excluded or an outlier', () => {
    const none = evaluateOpportunity(args({ listings: [makeListing({ userBanned: true })] }));
    expect(none).toMatchObject({ status: 'no-buyers', profitTier: 'none', revenueScrap: null, buyerCount: 0 });
    const outliers = evaluateOpportunity(
      args({ listings: [makeListing({ metalScrap: 400 })], references: { pricedb: { buyScrap: 90, sellScrap: 100, time: null, ageMs: null }, community: null } }),
    );
    expect(outliers.status).toBe('no-buyers');
    expect(outliers.flags).toContain('all-outliers');
    expect(outliers.bestScrap).toBe(400);
  });

  it('flags a background check above 15 keys', () => {
    const big = evaluateOpportunity(args({ listings: [makeListing({ keys: 16, metalScrap: 0 })] }));
    expect(big.flags).toContain('background-check');
    const small = evaluateOpportunity(args({ listings: [makeListing({ keys: 15, metalScrap: 0 })] }));
    expect(small.flags).not.toContain('background-check');
  });

  it('keeps firstSeenAt from the previous row', () => {
    const prev = evaluateOpportunity(args({ now: T0 - HOUR }));
    expect(evaluateOpportunity(args({ prev })).firstSeenAt).toBe(T0 - HOUR);
  });
});

describe('explicitInput', () => {
  it('canonicalises the SKU and carries a paint token into the target', () => {
    const inp = explicitInput({
      id: 7,
      sku: '378;6;p16738740',
      name: 'x',
      costKeys: 0,
      costScrap: 10,
      source: 'user',
      observedAt: T0,
      note: null,
      importBatch: null,
      special: null,
      assetId: null,
      stock: null,
    })!;
    expect(inp).toMatchObject({ key: '378;6;p16738740|price:7', baseSku: '378;6', inputKind: 'user' });
    expect(inp.target).toEqual({ baseSku: '378;6', special: null, hasExtras: true, anyEffectBase: null });
  });

  it('points an unusual with an effect at the generic any-effect base SKU', () => {
    const base = { id: 8, name: '', costKeys: 10, costScrap: 0, source: 'user' as const, observedAt: T0, note: null, importBatch: null, special: null, assetId: null, stock: null };
    expect(explicitInput({ ...base, sku: '30672;5;u3010' })!.target.anyEffectBase).toBe('30672;5');
    expect(explicitInput({ ...base, sku: '378;5;u13;p16738740' })!.target.anyEffectBase).toBe('378;5');
    expect(explicitInput({ ...base, sku: '378;5' })!.target.anyEffectBase).toBeNull();
    expect(explicitInput({ ...base, sku: '378;6' })!.target.anyEffectBase).toBeNull();
  });

  it('rejects SKUs whose tokens fromString would silently drop', () => {
    const base = { id: 9, name: '', costKeys: 0, costScrap: 10, source: 'user' as const, observedAt: T0, note: null, importBatch: null, special: null, assetId: null, stock: null };
    expect(explicitInput({ ...base, sku: '205;11;KT-3' })).toBeNull();
    expect(explicitInput({ ...base, sku: '378;6;UNCRAFTABLE' })).toBeNull();
    expect(explicitInput({ ...base, sku: '378;5;U13' })).toBeNull();
    expect(explicitInput({ ...base, sku: '378;6;uncratable' })).toBeNull();
    expect(explicitInput({ ...base, sku: '205;11;kt-3' })!.sku).toBe('205;11;kt-3');
    expect(explicitInput({ ...base, sku: '378;6;uncraftable' })!.sku).toBe('378;6;uncraftable');
  });

  it('rejects broken costs', () => {
    const base = { id: 1, sku: '378;6', name: '', costKeys: 0, costScrap: 1, source: 'user' as const, observedAt: T0, note: null, importBatch: null, special: null, assetId: null, stock: null };
    expect(explicitInput({ ...base, costScrap: -1 })).toBeNull();
    expect(explicitInput({ ...base, costKeys: Number.NaN })).toBeNull();
  });
});

describe('runMaintenance', () => {
  it('purges old listings, events, request-log rows and saved scrap.tf list rows', () => {
    const repo = newRepo();
    const now = T0;
    repo.upsertListings([
      makeListing({ id: 'old', lastEventAt: now - RETENTION.listingsMs - 1 }),
      makeListing({ id: 'new', lastEventAt: now - RETENTION.listingsMs + 1 }),
    ]);
    repo.appendEvents([
      { key: 'k', sku: 's', name: 'n', category: 'hats', kind: 'appeared', profitScrap: 1, costScrap: 1, revenueScrap: 2, confidence: 50, summary: '', ts: now - RETENTION.eventsMs - 1 },
      { key: 'k', sku: 's', name: 'n', category: 'hats', kind: 'gone', profitScrap: 1, costScrap: 1, revenueScrap: 2, confidence: 50, summary: '', ts: now },
    ]);
    repo.appendRequestLog({ ts: now - RETENTION.requestLogMs - 1, host: 'h', path: '/', method: 'GET', status: 200, ms: 1, bytes: 1, note: null });
    repo.appendRequestLog({ ts: now, host: 'h', path: '/', method: 'GET', status: 200, ms: 1, bytes: 1, note: null });
    const listRow = { name: 'n', sellsKeys: 0, sellsScrap: 12, paysKeys: 0, paysScrap: 10, stock: 1, stockLimit: 5, batchId: 1 };
    repo.upsertScraptfList([
      { ...listRow, sku: '378;6', observedAt: now - RETENTION.scraptfListMs - 1 },
      { ...listRow, sku: '126;6', observedAt: now - RETENTION.scraptfListMs + 1 },
    ]);
    // F17/F20: a hats save past the retention goes; the newest and the one it is compared with stay.
    const batch = (at: number) => repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: 1, bank: 'hats' });
    const stock = { sku: '378;6', specialKey: '', name: 'Team Captain', costKeys: 0, costScrap: 30, stock: 1, assetId: null };
    const oldSave = batch(now - BANK_STOCK_MAX_AGE_MS - 1);
    const midSave = batch(now - 2 * 3_600_000);
    const freshSave = batch(now - 1);
    repo.insertBankStock(oldSave, 'hats', [stock]);
    repo.insertBankStock(midSave, 'hats', [stock]);
    repo.insertBankStock(freshSave, 'hats', [stock]);
    // F20: a change event past its 90 days goes, a fresh one stays.
    const event = { bank: 'hats' as const, page: '/buy/hats', sku: '378;6', specialKey: '', name: 'Team Captain', kind: 'cheaper' as const, fromKeys: 0, fromScrap: 31, toKeys: 0, toScrap: 30, fromStock: 1, toStock: 1, batchId: freshSave };
    repo.insertScraptfEvents([
      { ...event, at: now - SCRAPTF_EVENTS_MAX_AGE_MS - 1 },
      { ...event, at: now - 1 },
    ]);
    expect(runMaintenance(repo, now)).toEqual({ listings: 1, events: 1, requests: 1, scraptfList: 1, bankStock: 1, scraptfEvents: 1 });
    expect(repo.scraptfEvents().map((e) => e.at)).toEqual([now - 1]);
    expect(repo.getListing('new')).not.toBeNull();
    expect(repo.listEvents({})).toHaveLength(1);
    expect(repo.recentRequests(10)).toHaveLength(1);
    expect(repo.scraptfList().map((r) => r.sku)).toEqual(['126;6']);
    expect(repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([freshSave, midSave]);
  });
});

describe('performance', () => {
  it('sweeps 50k base SKUs with 2 rules in under 2 s', async () => {
    const repo = newRepo();
    const N = 50_000;
    const listings: Listing[] = [];
    // Both rules match two thirds of all items; roughly 10-20 % of those have an order above the rule cost.
    for (let i = 0; i < N; i++) {
      const sku = `${100_000 + i};6`;
      const v = 10 + (i % 40);
      listings.push(
        makeListing({ id: `a${i}`, sku, baseSku: sku, steamid: `A${i % 997}`, metalScrap: v, isBot: i % 2 === 0, lastEventAt: T0 - (i % 30) * HOUR }),
        makeListing({ id: `b${i}`, sku, baseSku: sku, steamid: `B${i % 991}`, metalScrap: v - 2, details: i % 7 === 0 ? 'clean only' : '' }),
      );
    }
    repo.upsertListings(listings);
    for (let i = 0; i < 1000; i++) {
      repo.upsertScrapPrice({ sku: `${100_000 + i * 50};6`, name: `Item ${i}`, costScrap: 20, source: 'user', observedAt: T0 - i * MIN });
    }
    repo.upsertRule({ name: 'Hats', filter: { categories: ['hats'], qualities: [6], craftable: true }, costScrap: 45, observedAt: T0 });
    repo.upsertRule({ name: 'Weapons', filter: { categories: ['weapons'] }, costScrap: 40, observedAt: T0 });

    const schema: StubSchemaOptions = {
      items: [],
      categoryOf: (d) => (d % 3 === 0 ? 'hats' : d % 3 === 1 ? 'weapons' : 'other'),
      nameOf: (s) => `Item ${s}`,
    };
    const timed = async (h: Harness): Promise<{ ms: number; evaluated: number }> => {
      const t = performance.now();
      const r = await h.engine.runNow();
      return { ms: performance.now() - t, evaluated: r.evaluated };
    };

    // Best of three, so other test files sharing the CPU do not decide the result.
    // Cold: a new engine (empty caches) and nothing stored yet, like the first sweep after start.
    const coldMs: number[] = [];
    let h: Harness | null = null;
    let evaluated = 0;
    for (let rep = 0; rep < 3; rep++) {
      h?.engine.stop();
      repo.deleteOpportunities(repo.allOpportunities().map((o) => o.key));
      h = setup({ repo, schema });
      const r = await timed(h);
      coldMs.push(r.ms);
      evaluated = r.evaluated;
    }
    const stored = repo.allOpportunities();
    console.info(`[perf] cold sweep: ${coldMs.map((x) => x.toFixed(0)).join(' / ')} ms, evaluated ${evaluated}, stored ${stored.length}`);

    // Steady state: each minute a few thousand order books have changed since the last sweep.
    const warmMs: number[] = [];
    for (let rep = 0; rep < 3; rep++) {
      h!.clock.advance(SWEEP_INTERVAL_MS);
      h!.engine.markDirty(Array.from({ length: 3000 }, (_, i) => `${100_000 + rep + i * 16};6`));
      const r = await timed(h!);
      expect(r.evaluated).toBe(evaluated);
      warmMs.push(r.ms);
    }
    console.info(`[perf] warm sweep: ${warmMs.map((x) => x.toFixed(0)).join(' / ')} ms`);

    // The periodic sweep reuses the order books cached by the last run (none marked dirty).
    h!.engine.start();
    h!.timers.advance(1000);
    const t = performance.now();
    h!.timers.advance(SWEEP_INTERVAL_MS);
    const sweepMs = performance.now() - t;
    h!.engine.stop();
    expect(h!.engine.stats().evaluated).toBe(evaluated);
    console.info(`[perf] periodic sweep with cached books: ${sweepMs.toFixed(0)} ms`);
    expect(sweepMs).toBeLessThan(2000);

    expect(stored.filter((o) => o.inputKind === 'rule').length).toBeGreaterThan(3000);
    expect(stored.filter((o) => o.inputKind === 'user')).toHaveLength(1000);
    expect(repo.allOpportunities()).toHaveLength(stored.length);
    expect(Math.min(...coldMs)).toBeLessThan(2000);
    expect(Math.min(...warmMs)).toBeLessThan(2000);
  }, 60_000);
});
