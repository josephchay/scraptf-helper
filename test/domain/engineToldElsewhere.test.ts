// F17 with F6: an imported item that a "New on scrap.tf" toast just named gets no second "Profit:"
// toast from the engine (EngineDeps.toldElsewhere). It is still recorded as notified, so it is not
// toasted later either, and without the hook, or when it fails, the engine toasts exactly as before.
// The other way round (F17-C3): the engine tells EngineDeps.notified what it toasted, so an import held
// for the Live market's first build, which the engine judges first, gets no second "New on scrap.tf"
// toast. In-memory repo and fake clock; nothing here touches the network.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, createNewFlipNotifier, type NewFlipNotifier } from '../../src/service/domain/bankStock';
import { NOTIFY_META_KEY, createEngine, type EngineDeps } from '../../src/service/domain/engine';
import type { MarketEval } from '../../src/service/domain/market';
import { createWatchCache } from '../../src/service/domain/watches';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import { baseSku } from '../../src/shared/sku';
import type { DeepPartial, Settings } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, recordingLogger } from './helpers';

const K = 567;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup(toldElsewhere?: EngineDeps['toldElsewhere'], patch: DeepPartial<Settings> = {}, notified?: EngineDeps['notified']) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  // Team Captain: three buyers at about 12 ref and a fresh PriceDB price; Bill's Hat: three at 10 ref.
  repo.upsertListings([
    makeListing({ id: 'tc-bot', steamid: 'S1', metalScrap: 108, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 - MIN }),
    makeListing({ id: 'tc-h1', steamid: 'S2', metalScrap: 105, lastEventAt: T0 - MIN }),
    makeListing({ id: 'tc-h2', steamid: 'S3', metalScrap: 102, lastEventAt: T0 - MIN }),
    makeListing({ id: 'bh-bot', sku: '126;6', baseSku: '126;6', steamid: 'B1', metalScrap: 90, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 - MIN }),
    makeListing({ id: 'bh-h1', sku: '126;6', baseSku: '126;6', steamid: 'B2', metalScrap: 88, lastEventAt: T0 - MIN }),
    makeListing({ id: 'bh-h2', sku: '126;6', baseSku: '126;6', steamid: 'B3', metalScrap: 86, lastEventAt: T0 - MIN }),
  ]);
  // 0.7.4: PriceDB buy prices at the costs, so neither cost is under 95% of what bots pay ('cost-below-market').
  repo.upsertPricedb([
    { sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap: 60, sellKeys: 0, sellScrap: 120, time: Math.floor(T0 / 1000), fetchedAt: T0 },
    { sku: '126;6', name: "Bill's Hat", buyKeys: 0, buyScrap: 50, sellKeys: 0, sellScrap: 95, time: Math.floor(T0 / 1000), fetchedAt: T0 },
  ]);
  // An imported Team Captain (a saved bank page) and a typed Bill's Hat, both flips.
  repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 60, source: 'import', observedAt: T0 - MIN });
  repo.upsertScrapPrice({ sku: '126;6', name: "Bill's Hat", costScrap: 50, source: 'user', observedAt: T0 - MIN });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 }, ...patch });
  const events = recordingEvents();
  const log = recordingLogger();
  const engine = createEngine({
    ...makeDeps(repo, clock, () => settings, log),
    schema: createStubSchema(),
    events,
    timers,
    ...(toldElsewhere ? { toldElsewhere } : {}),
    ...(notified ? { notified } : {}),
  });
  return { repo, clock, engine, events, log, settings };
}

const titles = (h: ReturnType<typeof setup>) => h.events.notified.map((n) => n.title).sort();

describe('the engine and the "New on scrap.tf" toast (F17)', () => {
  it('toasts every flip without the hook, as before', async () => {
    const h = setup();
    await h.engine.runNow();
    expect(titles(h)).toEqual(["Profit: Bill's Hat", 'Profit: Team Captain']);
  });

  it('skips the toast for an item told elsewhere, records it as notified, and does not toast it later', async () => {
    let told = true;
    const asked: [string, string][] = [];
    const h = setup((opp, at) => {
      asked.push([opp.sku, opp.inputKind]);
      expect(at).toBe(T0);
      return told && opp.inputKind === 'import' && opp.sku === '378;6';
    });
    await h.engine.runNow();
    expect(titles(h)).toEqual(["Profit: Bill's Hat"]);
    expect(asked.sort()).toEqual([
      ['126;6', 'user'],
      ['378;6', 'import'],
    ]);
    // Recorded like a toast in the dedupe map (no 'notified' event: the engine sent nothing).
    const keys = Object.keys(JSON.parse(h.repo.getMeta(NOTIFY_META_KEY)!) as Record<string, number>);
    expect(keys).toHaveLength(2);
    expect(h.repo.listEvents({ kinds: ['notified'] }).map((e) => e.name)).toEqual(["Bill's Hat"]);
    // Later, with the other toast forgotten, the dedupe window still holds it back.
    told = false;
    h.clock.t += 5 * MIN;
    await h.engine.runNow();
    expect(titles(h)).toEqual(["Profit: Bill's Hat"]);
  });

  it('toasts as before when the check fails', async () => {
    const h = setup(() => {
      throw new Error('notifier gone');
    });
    await h.engine.runNow();
    expect(titles(h)).toEqual(["Profit: Bill's Hat", 'Profit: Team Captain']);
    expect(h.log.lines.some((l) => l.level === 'warn' && /notification check failed/.test(l.msg))).toBe(true);
  });

  it('asks nothing while notifications are off', async () => {
    const hook = vi.fn(() => true);
    const h = setup(hook, { notifications: { enabled: false } });
    await h.engine.runNow();
    expect(hook).not.toHaveBeenCalled();
    expect(h.events.notified).toEqual([]);
  });
});

/** Three fresh buyers of `sku` at about `scrap`, a PriceDB price, and a price of `cost`: a flip. */
function addFlip(repo: Repo, sku: string, scrap: number, cost: number, source: 'user' | 'import' = 'user'): void {
  repo.upsertListings([0, 1, 2].map((i) => makeListing({ id: `${sku}-${i}`, sku, baseSku: sku, steamid: `X${sku}${i}`, metalScrap: scrap - i, lastEventAt: T0 - MIN })));
  // 0.7.4: PriceDB buy at most the cost, so the cost is not under 95% of what bots pay ('cost-below-market').
  repo.upsertPricedb([{ sku, name: sku, buyKeys: 0, buyScrap: Math.min(scrap - 5, cost), sellKeys: 0, sellScrap: scrap + 10, time: Math.floor(T0 / 1000), fetchedAt: T0 }]);
  repo.upsertScrapPrice({ sku, name: sku, costScrap: cost, source, observedAt: T0 - MIN });
}

describe('what the engine toasted, for the "New on scrap.tf" notifier (F17-C3)', () => {
  it('tells the hook every opportunity it toasted, the summary’s included, once per run', async () => {
    const seen: [string, string][][] = [];
    const h = setup(undefined, {}, (opps, at) => {
      expect(at).toBe(T0);
      seen.push(opps.map((o) => [o.sku, o.inputKind]));
    });
    addFlip(h.repo, '940;6', 100, 20);
    addFlip(h.repo, '31031;6', 100, 25, 'import');
    addFlip(h.repo, '31459;6', 100, 30);
    await h.engine.runNow();
    // Three toasts and a summary of the other two: all five were told of.
    expect(h.events.notified).toHaveLength(4);
    expect(h.events.notified[3]!.sku).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sort()).toEqual(
      [
        ['126;6', 'user'],
        ['31031;6', 'import'],
        ['31459;6', 'user'],
        ['378;6', 'import'],
        ['940;6', 'user'],
      ].sort(),
    );
    // Nothing new to toast: the hook hears nothing.
    h.clock.t += MIN;
    await h.engine.runNow();
    expect(seen).toHaveLength(1);
  });

  it('toasts as before when the hook fails', async () => {
    const h = setup(undefined, {}, () => {
      throw new Error('notifier gone');
    });
    await h.engine.runNow();
    expect(titles(h)).toEqual(["Profit: Bill's Hat", 'Profit: Team Captain']);
  });
});

describe('one toast per find at start-up, wired as core wires it (F17-C3)', () => {
  function flipEntry(revenueScrap: number, settings: Settings): MarketEval {
    const o = { listingId: 'tc-bot', steamid: 'S1', userName: 'Bot', keys: 0, metalScrap: revenueScrap, valueScrap: revenueScrap, isBot: true, online: true, lastEventAt: T0 - MIN, bumpedAt: null, details: '', flags: [], eligible: true };
    return {
      bestScrap: revenueScrap,
      consScrap: revenueScrap,
      instantScrap: revenueScrap,
      revenueScrap,
      revenueOrder: o,
      bestOrder: o,
      buyerCount: 3,
      eligibleCount: 3,
      maxCostScrap: maxCostFor(revenueScrap, settings.profit),
      confidence: 70,
      confidenceLevel: 'high',
      flags: [],
      lastOrderChangeAt: T0 - MIN,
      referenced: true,
    };
  }

  it('an import held for the market’s first build, toasted by the engine first, gets no "New on scrap.tf" toast too', async () => {
    let notifier: NewFlipNotifier | null = null;
    // core.ts: toldElsewhere and notified, both late-bound to the notifier.
    const h = setup(
      (opp, at) => opp.inputKind === 'import' && notifier!.toldRecently(baseSku(opp.sku), at),
      {},
      (opps, at) => {
        for (const o of opps) if (o.inputKind === 'import') notifier!.toastedElsewhere(baseSku(o.sku), at);
      },
    );
    // The folder watch's catch-up: a hats save that lists Team Captain at 60 scrap; the save before it did not.
    const batch = (at: number) => h.repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: at, importedAt: T0, itemCount: 1, bank: 'hats' });
    const row = (sku: string, costScrap: number) => ({ sku, specialKey: '', name: sku === '378;6' ? 'Team Captain' : sku, costKeys: 0, costScrap, stock: 1, assetId: null });
    const prev = batch(T0 - 2 * 60 * MIN);
    h.repo.insertBankStock(prev, 'hats', [row('126;6', 50)], '/buy/hats');
    const newest = batch(T0 - 5 * MIN);
    h.repo.insertBankStock(newest, 'hats', [row('126;6', 50), row('378;6', 60)], '/buy/hats');
    const entries = new Map<string, MarketEval>();
    let built = false;
    const stock = createBankStock({
      clock: h.clock,
      log: h.log,
      repo: h.repo,
      market: { entryFor: (base) => entries.get(base) ?? null },
      keyPrice: () => h.engine.keyPrice(),
      settings: () => h.settings,
      categoryOf: () => 'hats',
    });
    const told: PushContract['notify'][] = [];
    notifier = createNewFlipNotifier({ log: h.log, repo: h.repo, clock: h.clock, stock, settings: () => h.settings, keyPrice: () => h.engine.keyPrice(), notify: (n) => told.push(n), marketBuilt: () => built });

    // core's bankStockChanged: refresh, then the notifier, which holds (no market entries yet).
    stock.refresh();
    notifier.imported({ bank: 'hats', batchId: newest });
    expect(notifier.held()).toBe(1);
    // About a second later the engine judges the imported price and toasts it.
    await h.engine.runNow();
    expect(titles(h)).toContain('Profit: Team Captain');
    // Then the Live market's first build lands and the held import is told.
    entries.set('378;6', flipEntry(300, h.settings));
    expect(stock.newFlips('hats', newest).map((r) => r.sku)).toEqual(['378;6']);
    built = true;
    notifier.flush();
    const all = [...h.events.notified, ...told].filter((n) => n.sku === '378;6');
    expect(all.map((n) => n.title)).toEqual(['Profit: Team Captain']);
    expect(notifier.held()).toBe(0);
  });

  /** A price watch of Team Captain at <= 70 scrap, the hats saves (Team Captain new at 60 scrap) and the notifier, wired as core wires them. */
  function watched(opts: { unverified: boolean }) {
    let notifier: NewFlipNotifier | null = null;
    const h = setup(
      (opp, at) => opp.inputKind === 'import' && notifier!.toldRecently(baseSku(opp.sku), at),
      {},
      (opps, at) => {
        for (const o of opps) if (o.inputKind === 'import') notifier!.toastedElsewhere(baseSku(o.sku), at);
      },
    );
    const tcOrders = (lastEventAt: number) => [
      makeListing({ id: 'tc-bot', steamid: 'S1', metalScrap: 108, isBot: true, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt }),
      makeListing({ id: 'tc-h1', steamid: 'S2', metalScrap: 105, lastEventAt }),
      makeListing({ id: 'tc-h2', steamid: 'S3', metalScrap: 102, lastEventAt }),
    ];
    // Team Captain's buy orders were last seen 30 h ago (unverified), common right after start-up.
    if (opts.unverified) h.repo.upsertListings(tcOrders(T0 - 30 * 60 * MIN));
    h.repo.upsertWatch({ sku: '378;6', specialKey: null, name: 'Team Captain', maxCostKeys: 0, maxCostScrap: 70, minProfitScrap: null, onRestock: false, enabled: true }, T0 - 3 * 60 * MIN);
    const cache = createWatchCache({ repo: h.repo, log: h.log });
    const batch = (at: number) => h.repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: at, importedAt: T0, itemCount: 1, bank: 'hats' });
    const row = (sku: string, costScrap: number) => ({ sku, specialKey: '', name: sku === '378;6' ? 'Team Captain' : sku, costKeys: 0, costScrap, stock: 1, assetId: null });
    h.repo.insertBankStock(batch(T0 - 2 * 60 * MIN), 'hats', [row('126;6', 50)], '/buy/hats');
    const newest = batch(T0 - 5 * MIN);
    h.repo.insertBankStock(newest, 'hats', [row('126;6', 50), row('378;6', 60)], '/buy/hats');
    const state = { unverified: opts.unverified, built: true };
    const entry = (): MarketEval => {
      const e = flipEntry(108, h.settings);
      return state.unverified ? { ...e, revenueOrder: { ...e.revenueOrder!, flags: ['unverified'], lastEventAt: T0 - 30 * 60 * MIN } } : e;
    };
    const stock = createBankStock({
      clock: h.clock,
      log: h.log,
      repo: h.repo,
      market: { entryFor: (base) => (base === '378;6' && state.built ? entry() : null) },
      keyPrice: () => h.engine.keyPrice(),
      settings: () => h.settings,
      categoryOf: () => 'hats',
      watches: () => cache.index(),
    });
    const told: PushContract['notify'][] = [];
    notifier = createNewFlipNotifier({
      log: h.log,
      repo: h.repo,
      clock: h.clock,
      stock,
      settings: () => h.settings,
      keyPrice: () => h.engine.keyPrice(),
      notify: (n) => told.push(n),
      marketBuilt: () => state.built,
      watches: () => cache.index(),
    });
    const tc = () => [...h.events.notified, ...told].filter((n) => n.sku === '378;6').map((n) => `${n.title} | ${n.body}`);
    return { h, notifier, stock, newest, state, told, tc, confirm: () => h.repo.upsertListings(tcOrders(h.clock.t)) };
  }

  it("a watch toast of an unconfirmed buy order leaves the engine's \"Profit:\" toast free once a snapshot confirms it", async () => {
    const w = watched({ unverified: true });
    // The engine judges the import first: an unconfirmed order is skipped, unrecorded.
    await w.h.engine.runNow();
    expect(w.tc()).toEqual([]);
    w.stock.refresh();
    w.notifier.imported({ bank: 'hats', batchId: w.newest });
    expect(w.tc()).toEqual(['Watch (Hats): Team Captain | 6.66 ref, at or under your ≤ 7.77 ref; its buy order is unconfirmed']);
    // That toast tells no flip, so the engine is not told to stay quiet.
    expect(w.notifier.toldRecently('378;6', w.h.clock.t)).toBe(false);
    // A minute later a snapshot confirms the orders: the engine tells the flip.
    w.h.clock.advance(MIN);
    w.confirm();
    w.state.unverified = false;
    w.h.clock.advance(MIN);
    await w.h.engine.runNow();
    expect(w.h.events.notified.filter((n) => n.sku === '378;6').map((n) => n.title)).toEqual(['Profit: Team Captain']);
    expect(w.told.map((n) => n.title)).toEqual(['Watch (Hats): Team Captain']);
  });

  it('a watch toast of a verified flip still tells the engine (one toast per find)', async () => {
    const w = watched({ unverified: false });
    w.stock.refresh();
    w.notifier.imported({ bank: 'hats', batchId: w.newest });
    expect(w.notifier.toldRecently('378;6', w.h.clock.t)).toBe(true);
    await w.h.engine.runNow();
    expect(w.tc().map((t) => t.split(' | ')[0])).toEqual(['Watch (Hats): Team Captain']);
  });

  it('an import held for the market’s first build, toasted by the engine first, gets no watch toast too', async () => {
    const w = watched({ unverified: false });
    w.state.built = false;
    w.stock.refresh();
    w.notifier.imported({ bank: 'hats', batchId: w.newest });
    expect(w.notifier.held()).toBe(1);
    // The engine judges the imported price first (its own market evaluation) and toasts it.
    await w.h.engine.runNow();
    w.state.built = true;
    w.notifier.flush();
    expect(w.tc().map((t) => t.split(' | ')[0])).toEqual(['Profit: Team Captain']);
    expect(w.notifier.held()).toBe(0);
  });

  it('is what core wires', () => {
    const core = readFileSync(new URL('../../src/service/core.ts', import.meta.url), 'utf8');
    // ACT-7 added the cases of a price the user just typed or saved (dated then, or new then); the F17 case is unchanged.
    expect(core).toMatch(
      /toldElsewhere: \(opp, at\) =>\s*\(opp\.inputKind === 'import' && newFlipNotifier\.toldRecently\(toBaseSku\(opp\.sku\), at\)\) \|\|\s*\(opp\.inputKind === 'user' && at - opp\.inputObservedAt < USER_PRICE_TOLD_MS\) \|\|\s*\(opp\.inputKind === 'user' && at - opp\.firstSeenAt < USER_PRICE_TOLD_MS\),/,
    );
    expect(core).toMatch(/notified: \(opps, at\) => \{\s*for \(const o of opps\) \{\s*if \(o\.inputKind !== 'import'\) continue;\s*try \{\s*newFlipNotifier\.toastedElsewhere\(toBaseSku\(o\.sku\), at\);/);
  });
});
