// 0.8 (G1, G3): watch hits through the one S3 notifier (notifyNewBankFlips) over the real bank stock cache, the real
// scrap.tf history, the real watch cache and an in-memory repo. The stateless edge (a first save, a watch made after the
// page's previous save, a new or cheaper read; never a same-price re-read), the per-watch dedupe (in repo meta, across a
// restart; exempt from the S3 key, which it records), the switches, the exclusions (an /items family row, a flagged
// cost), the texts and the summaries on the Watched chip (G5). Pages the user saved only (R10); no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { BANK_STOCK_NOTIFY_META_KEY, createBankStock, createNewFlipNotifier, notifyNewBankFlips, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { createWatchCache, type WatchCache } from '../../src/service/domain/watches';
import { BANK_STOCK_MORE_BODY, bankStockSpecialKey } from '../../src/shared/bankStock';
import { bankStockWatchNotice, bankStockWatchNotifyKey } from '../../src/shared/bankStockNotify';
import { withCheckoutGuard } from '../../src/shared/checkoutGuard';
import { watchUndoInput } from '../../src/renderer/watchesModel';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { watchRestoreOf } from '../../src/shared/watches';
import type { PushContract } from '../../src/shared/rpc';
import type { BankStockStored, DeepPartial, KeyPriceState, Scrap, ScraptfBank, ScraptfWatch, ScraptfWatchWrite, Settings, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
/** A timeline far enough back that every save is fresh at its own run (profit.inputStaleMs is 2 h). */
const T = NOW - 10 * HOUR;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Hat ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows, bank === 'list' ? '/items' : `/buy/${bank}`);
  return id;
}

function entry(revenueScrap: number, settings: Settings): MarketEval {
  const o = {
    listingId: `l-${revenueScrap}`,
    steamid: '76561198000000002',
    userName: 'KeyBot',
    keys: 0,
    metalScrap: revenueScrap,
    valueScrap: revenueScrap,
    isBot: true,
    online: true,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
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
    confidence: 80,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
  };
}

interface Harness {
  repo: Repo;
  stock: BankStock;
  history: ScraptfHistory;
  cache: WatchCache;
  settings: Settings;
  sent: PushContract['notify'][];
  /** Adds a watch at `at` (any copy unless `specialKey` is given). */
  watch(sku: string, over: Partial<ScraptfWatchWrite>, at: UnixMs): ScraptfWatch;
  run(bank: ScraptfBank, batchId: number, now: UnixMs): number;
  /** A new bank stock and watch cache over the same repo (an app restart). */
  restart(): void;
}

/** Every base sells for 200 to KeyBot (Pay up to 185), except `revenue` overrides. */
function setup(patch: DeepPartial<Settings> = {}, opts: { revenue?: Record<string, number>; costSuspect?: (base: string) => boolean } = {}): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, patch);
  const log = recordingLogger();
  const market = { entryFor: (base: string) => entry(opts.revenue?.[base] ?? 200, settings) };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market, keyPrice: () => KEY });
  const make = (cache: WatchCache) =>
    createBankStock({
      clock: { now: () => NOW },
      log,
      repo,
      market,
      keyPrice: () => KEY,
      settings: () => settings,
      categoryOf: () => 'hats',
      history: { runsFor: (bank) => history.runsFor(bank) },
      ...(opts.costSuspect ? { costSuspect: (base: string) => opts.costSuspect!(base) } : {}),
      watches: () => cache.index(),
    });
  const sent: PushContract['notify'][] = [];
  const firstCache = createWatchCache({ repo, log });
  const h: Harness = {
    repo,
    stock: make(firstCache),
    history,
    cache: firstCache,
    settings,
    sent,
    watch(sku, over, at) {
      const w = repo.upsertWatch({ sku, specialKey: null, name: `Hat ${sku}`, maxCostKeys: 0, maxCostScrap: null, minProfitScrap: null, onRestock: false, enabled: true, ...over }, at);
      h.cache.invalidate();
      return w;
    },
    run(bank, batchId, now) {
      h.stock.refresh();
      history.refresh();
      return notifyNewBankFlips({ log, repo, stock: h.stock, settings: () => settings, keyPrice: () => KEY, notify: (n) => sent.push(n), watches: () => h.cache.index() }, { bank, batchId }, now);
    },
    restart() {
      h.cache = createWatchCache({ repo, log });
      h.stock = make(h.cache);
    },
  };
  return h;
}

const titles = (h: Harness): string[] => h.sent.map((n) => n.title);

describe('G1: when a watch fires (the stateless edge)', () => {
  it('a first save of a page fires a price hit, and the row carries the watch (the Watched chip)', () => {
    const h = setup();
    const w = h.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    const first = save(h.repo, 'hats', T, [s('100;6', 50), s('101;6', 100, { name: 'Ghastly Gibus' })]);
    expect(h.run('hats', first, T + MIN)).toBe(1);
    const row = h.stock.lookOf('hats', first)!.rows.find((x) => x.row.sku === '101;6')!.row;
    expect(row.watch).toEqual({ id: w.id, anyCopy: true, maxCostScrap: 120, minProfitScrap: null, onRestock: false, met: 'price', overTargetScrap: -20 });
    // 0.9 (#9): a watch hit that tells a flip gains the checkout guard's short sentence (it fits under 200).
    const n = bankStockWatchNotice('Hats', row, w, 'price', false, KEY.valueScrap, MIN);
    expect(h.sent).toEqual([{ ...n, body: withCheckoutGuard(n.body), sku: '101;6' }]);
    expect(h.sent[0]!.title).toBe('Watch (Hats): Ghastly Gibus');
    expect(h.sent[0]!.body).toBe("11.11 ref, at or under your ≤ 13.33 ref; sells for 22.22 ref to KeyBot, +11.11 ref. Accept the bot's offer promptly.");
    expect(h.stock.list({ bank: 'hats', filter: 'watched' }, NOW).rows.map((r) => r.sku)).toEqual(['101;6']);
  });

  it('a watch made after the previous save fires on the next read; a same-price re-read is silent; a further drop fires', () => {
    const h = setup();
    save(h.repo, 'hats', T, [s('101;6', 100)]);
    expect(h.run('hats', save(h.repo, 'hats', T + HOUR, [s('101;6', 100)]), T + HOUR + MIN)).toBe(0);
    h.watch('101;6', { maxCostScrap: 120 }, T + HOUR + 30 * MIN);
    expect(h.run('hats', save(h.repo, 'hats', T + 2 * HOUR, [s('101;6', 100)]), T + 2 * HOUR + MIN)).toBe(1);
    // An hour later, the same price: nothing new (the watch is older than the page's previous save now).
    expect(h.run('hats', save(h.repo, 'hats', T + 3 * HOUR, [s('101;6', 100)]), T + 3 * HOUR + MIN)).toBe(0);
    // A pricier read under the target is no news either.
    expect(h.run('hats', save(h.repo, 'hats', T + 4 * HOUR, [s('101;6', 110)]), T + 4 * HOUR + MIN)).toBe(0);
    // A further drop is.
    expect(h.run('hats', save(h.repo, 'hats', T + 5 * HOUR, [s('101;6', 95)]), T + 5 * HOUR + MIN)).toBe(1);
    expect(titles(h)).toEqual(['Watch (Hats): Hat 101;6', 'Watch (Hats): Hat 101;6']);
  });

  it('a profit target fires on the buy side\'s profit, and only at notifications.minConfidence', () => {
    const h = setup({ notifications: { minConfidence: 90 } });
    h.watch('101;6', { minProfitScrap: 50 }, T - HOUR);
    // +100 at a confidence of 80: under the bar.
    expect(h.run('hats', save(h.repo, 'hats', T, [s('101;6', 100)]), T + MIN)).toBe(0);
    const ok = setup();
    const w = ok.watch('101;6', { minProfitScrap: 50 }, T - HOUR);
    expect(ok.run('hats', save(ok.repo, 'hats', T, [s('101;6', 100)]), T + MIN)).toBe(1);
    expect(ok.sent[0]!.body).toBe("11.11 ref, sells for 22.22 ref to KeyBot, +11.11 ref: at or over your +5.55 ref. Accept the bot's offer promptly.");
    expect(w.minProfitScrap).toBe(50);
  });
});

describe('G1: one dedupe with S3', () => {
  it('holds a watch for 30 min per watch, across a restart, then fires again', () => {
    const h = setup();
    const w = h.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    expect(h.run('hats', save(h.repo, 'hats', T, [s('101;6', 100)]), T + MIN)).toBe(1);
    const stored = JSON.parse(h.repo.getMeta(BANK_STOCK_NOTIFY_META_KEY)!) as Record<string, number>;
    // Its own key, and S3's key, which it records so the S3 kinds stay quiet after it.
    expect(Object.keys(stored).sort()).toEqual(['hats|101;6', bankStockWatchNotifyKey('hats', '101;6', w.id)].sort());
    h.restart();
    expect(h.run('hats', save(h.repo, 'hats', T + 10 * MIN, [s('101;6', 95)]), T + 11 * MIN)).toBe(0);
    expect(h.run('hats', save(h.repo, 'hats', T + 40 * MIN, [s('101;6', 90)]), T + 41 * MIN)).toBe(1);
  });

  it('a watch hit 5 min after a "New on scrap.tf" toast still fires; told() reaches toldRecently', () => {
    const h = setup();
    const n = createNewFlipNotifier({
      log: recordingLogger(),
      repo: h.repo,
      clock: { now: () => T + HOUR + 6 * MIN },
      stock: h.stock,
      settings: () => h.settings,
      keyPrice: () => KEY,
      notify: (x) => h.sent.push(x),
      marketBuilt: () => true,
      watches: () => h.cache.index(),
    });
    save(h.repo, 'hats', T, [s('100;6', 50)]);
    expect(h.run('hats', save(h.repo, 'hats', T + HOUR, [s('100;6', 50), s('101;6', 100)]), T + HOUR + MIN)).toBe(1);
    h.watch('101;6', { maxCostScrap: 120 }, T + HOUR + 2 * MIN);
    const read = save(h.repo, 'hats', T + HOUR + 5 * MIN, [s('100;6', 50), s('101;6', 100)]);
    h.stock.refresh();
    h.history.refresh();
    n.imported({ bank: 'hats', batchId: read });
    expect(titles(h)).toEqual(['New on scrap.tf (Hats): Hat 101;6', 'Watch (Hats): Hat 101;6']);
    expect(n.toldRecently('101;6', T + HOUR + 7 * MIN)).toBe(true);
  });

  it("the engine's toast of this read (at or after its save) holds a watch hit back, recorded; one from an earlier read does not", () => {
    const notifier = (h: Harness, now: UnixMs) =>
      createNewFlipNotifier({ log: recordingLogger(), repo: h.repo, clock: { now: () => now }, stock: h.stock, settings: () => h.settings, keyPrice: () => KEY, notify: (x) => h.sent.push(x), marketBuilt: () => true, watches: () => h.cache.index() });
    const read = (h: Harness, at: UnixMs) => {
      const id = save(h.repo, 'hats', at, [s('100;6', 50), s('101;6', 100)]);
      h.stock.refresh();
      h.history.refresh();
      return id;
    };
    // Held at start-up, the engine judged this read first and toasted it.
    const held = setup();
    const w = held.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    save(held.repo, 'hats', T - HOUR, [s('100;6', 50)]);
    const n = notifier(held, T + MIN);
    n.toastedElsewhere('101;6', T + 30_000);
    n.imported({ bank: 'hats', batchId: read(held, T) });
    expect(titles(held)).toEqual([]);
    expect(Object.keys(JSON.parse(held.repo.getMeta(BANK_STOCK_NOTIFY_META_KEY)!) as Record<string, number>).sort()).toEqual(['hats|101;6', bankStockWatchNotifyKey('hats', '101;6', w.id)].sort());
    // The engine toasted the item 10 min before this read was saved: an earlier read's find, so the watch hit is told.
    const earlier = setup();
    earlier.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    save(earlier.repo, 'hats', T - HOUR, [s('100;6', 50)]);
    const m = notifier(earlier, T + MIN);
    m.toastedElsewhere('101;6', T - 10 * MIN);
    m.imported({ bank: 'hats', batchId: read(earlier, T) });
    expect(titles(earlier)).toEqual(['Watch (Hats): Hat 101;6']);
  });

  it('Remove, then Undo (the same watch restored) tells nothing again for the same price; a new watch of the copy would', () => {
    const undo = (h: Harness, w: ScraptfWatch) => {
      h.repo.deleteWatch(w.id);
      const r = watchRestoreOf(watchUndoInput(w), () => null, T + 5 * MIN);
      h.repo.restoreWatch(r.write, r.createdAt, r.updatedAt);
      h.cache.invalidate();
    };
    const h = setup();
    const w = h.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    expect(h.run('hats', save(h.repo, 'hats', T, [s('101;6', 100)]), T + MIN)).toBe(1);
    undo(h, w);
    expect(h.repo.getWatch(w.id)).toEqual(w);
    expect(h.run('hats', save(h.repo, 'hats', T + 5 * MIN + 30_000, [s('101;6', 100)]), T + 6 * MIN)).toBe(0);
    // Past the dedupe window too: the restored watch is not judged afresh (its updatedAt is the old one).
    expect(h.run('hats', save(h.repo, 'hats', T + HOUR, [s('101;6', 100)]), T + HOUR + MIN)).toBe(0);
    expect(titles(h)).toEqual(['Watch (Hats): Hat 101;6']);
    // Before the fix Undo added a new watch (a new id, made now): the same price was told again at once.
    const h2 = setup();
    const w2 = h2.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    expect(h2.run('hats', save(h2.repo, 'hats', T, [s('101;6', 100)]), T + MIN)).toBe(1);
    h2.repo.deleteWatch(w2.id);
    h2.watch('101;6', { maxCostScrap: 120 }, T + 5 * MIN);
    expect(h2.run('hats', save(h2.repo, 'hats', T + 5 * MIN + 30_000, [s('101;6', 100)]), T + 6 * MIN)).toBe(1);
  });

  it('an S3 "new" of the same base within 30 min after a watch hit is silent', () => {
    const h = setup();
    // A watch of the clean copy; a painted copy new 10 min later is a new flip it does not cover.
    h.watch('101;6', { specialKey: '', maxCostScrap: 120 }, T - HOUR);
    expect(h.run('hats', save(h.repo, 'hats', T, [s('100;6', 50), s('101;6', 100)]), T + MIN)).toBe(1);
    const painted = s('101;6', 90, { specialKey: bankStockSpecialKey({ paint: 15185211 }) });
    const later = save(h.repo, 'hats', T + 10 * MIN, [s('100;6', 50), s('101;6', 100), painted]);
    h.stock.refresh();
    expect(h.stock.newFlips('hats', later).map((r) => r.hasExtras)).toEqual([true]);
    expect(h.run('hats', later, T + 11 * MIN)).toBe(0);
    expect(titles(h)).toEqual(['Watch (Hats): Hat 101;6']);
  });
});

describe('G1: switches and exclusions', () => {
  it('notifications.watches off: no watch toast, S3 unchanged; notifications off: none', () => {
    const h = setup({ notifications: { watches: false } });
    h.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    save(h.repo, 'hats', T, [s('100;6', 50)]);
    expect(h.run('hats', save(h.repo, 'hats', T + HOUR, [s('100;6', 50), s('101;6', 100)]), T + HOUR + MIN)).toBe(1);
    expect(titles(h)).toEqual(['New on scrap.tf (Hats): Hat 101;6']);
    // The row still shows the watch: the switch is for notifications only.
    expect(h.stock.list({ bank: 'hats', filter: 'watched' }, NOW).rows.map((r) => r.sku)).toEqual(['101;6']);

    const off = setup({ notifications: { enabled: false } });
    off.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    expect(off.run('hats', save(off.repo, 'hats', T, [s('101;6', 100)]), T + MIN)).toBe(0);
    expect(off.repo.getMeta(BANK_STOCK_NOTIFY_META_KEY)).toBeNull();

    // With the scrap.tf flips switch off, watches still fire on their own.
    const only = setup({ notifications: { newOnScraptf: false } });
    only.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    expect(only.run('hats', save(only.repo, 'hats', T, [s('101;6', 100)]), T + MIN)).toBe(1);
    expect(titles(only)).toEqual(['Watch (Hats): Hat 101;6']);
  });

  it('an /items family row (craft any) never fires, and a cost flagged by the cost checks is skipped', () => {
    const h = setup();
    h.watch('101;6', { maxCostScrap: 120 }, T - HOUR);
    expect(h.run('list', save(h.repo, 'list', T, [s('101;6', 100, { craft: 'any' })]), T + MIN)).toBe(0);
    expect(h.run('list', save(h.repo, 'list', T + HOUR, [s('101;6', 90, { craft: 'any' }), s('102;6', 50, { craft: 'any' })]), T + HOUR + MIN)).toBe(0);
    expect(h.sent).toEqual([]);

    const flagged = setup({}, { costSuspect: (base) => base === '101;6' });
    flagged.watch('101;6', { maxCostScrap: 120, onRestock: true }, T - HOUR);
    flagged.watch('102;6', { maxCostScrap: 120 }, T - HOUR);
    save(flagged.repo, 'hats', T, [s('100;6', 50)]);
    expect(flagged.run('hats', save(flagged.repo, 'hats', T + HOUR, [s('100;6', 50), s('101;6', 100), s('102;6', 100)]), T + HOUR + MIN)).toBe(1);
    expect(titles(flagged)).toEqual(['Watch (Hats): Hat 102;6']);
  });
});

describe('G1, G3: texts', () => {
  it('names the key price when a keys target meets a metal price', () => {
    const h = setup({}, { revenue: { '101;6': 700 } });
    const w = h.watch('101;6', { maxCostKeys: 1, maxCostScrap: 0 }, T - HOUR);
    const first = save(h.repo, 'hats', T, [s('101;6', 500)]);
    expect(h.run('hats', first, T + MIN)).toBe(1);
    const row = h.stock.lookOf('hats', first)!.rows[0]!.row;
    // 0.9 (#9): the cost 500 against revenue 700 tells a flip, so the body gains the checkout guard's sentence.
    const n = bankStockWatchNotice('Hats', row, w, 'price', false, KEY.valueScrap, MIN);
    expect(h.sent[0]).toEqual({ ...n, body: withCheckoutGuard(n.body), sku: '101;6' });
    expect(h.sent[0]!.body).toMatch(/^55\.55 ref, at or under your ≤ 1 key; compared at 1 key = 66\.66 ref; sells for /);
  });

  it('"Back on scrap.tf" for a watched copy on sale again, and "New on scrap.tf" at a first sighting, flip or not', () => {
    const h = setup();
    h.watch('106;6', { onRestock: true }, T - HOUR);
    h.watch('107;6', { onRestock: true }, T - HOUR);
    save(h.repo, 'hats', T, [s('100;6', 50), s('106;6', 300, { stock: 0 })]);
    expect(h.run('hats', save(h.repo, 'hats', T + HOUR, [s('100;6', 50), s('106;6', 300), s('107;6', 310)]), T + HOUR + MIN)).toBe(2);
    expect(h.sent).toEqual([
      { title: 'New on scrap.tf (Hats): Hat 107;6', body: '34.44 ref; not a flip (sells for 22.22 ref, Pay up to 20.55 ref); you watch it (back on sale)', sku: '107;6' },
      { title: 'Back on scrap.tf (Hats): Hat 106;6', body: '33.33 ref, on sale again in your saves; not a flip (sells for 22.22 ref, Pay up to 20.55 ref); you watch it (back on sale)', sku: '106;6' },
    ]);
  });
});

describe('G1, G5: the cap and the summaries', () => {
  it('four hits: three toasts, then one summary that opens the Watched chip', () => {
    const h = setup();
    const skus = ['101;6', '102;6', '103;6', '104;6'];
    for (const sku of skus) h.watch(sku, { maxCostScrap: 120 }, T - HOUR);
    expect(h.run('hats', save(h.repo, 'hats', T, skus.map((sku, i) => s(sku, 100 + i))), T + MIN)).toBe(4);
    expect(titles(h).slice(0, 3)).toEqual(['Watch (Hats): Hat 101;6', 'Watch (Hats): Hat 102;6', 'Watch (Hats): Hat 103;6']);
    expect(h.sent[3]).toEqual({ title: '+1 more on scrap.tf/buy/hats: 1 watched', body: BANK_STOCK_MORE_BODY, sku: null, openBankStock: { bank: 'hats', filter: 'watched' } });
  });

  it('a stale save is one dated summary on the Watched chip', () => {
    const h = setup();
    for (const sku of ['101;6', '102;6']) h.watch(sku, { maxCostScrap: 120 }, NOW - 3 * 24 * HOUR);
    expect(h.run('hats', save(h.repo, 'hats', NOW - 48 * HOUR, [s('101;6', 100), s('102;6', 101)]), NOW)).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ title: '2 items in your save of scrap.tf/buy/hats from 2 d ago: 2 watched', sku: null, openBankStock: { bank: 'hats', filter: 'watched' } });
  });
});

describe('the watch cache feeding the notifier', () => {
  it('reads the repo once, again after invalidate(), and keeps the last good list when a read fails', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    const log = recordingLogger();
    let reads = 0;
    let fail = false;
    let t: UnixMs = NOW;
    const cache = createWatchCache({
      repo: {
        listWatches: () => {
          reads++;
          if (fail) throw new Error('db gone');
          return repo.listWatches();
        },
      },
      log,
      clock: { now: () => t },
    });
    expect(cache.all()).toEqual([]);
    const write: ScraptfWatchWrite = { sku: '101;6', specialKey: null, name: 'x', maxCostKeys: 0, maxCostScrap: 120 as Scrap, minProfitScrap: null, onRestock: false, enabled: true };
    const w = repo.upsertWatch(write, NOW);
    expect(cache.all()).toEqual([]);
    cache.invalidate();
    expect(cache.all()).toEqual([w]);
    expect([...cache.bases()]).toEqual(['101;6']);
    expect(cache.index().get('101;6')).toEqual([w]);
    expect(reads).toBe(2);
    repo.upsertWatch({ ...write, id: w.id, enabled: false }, NOW + 1);
    fail = true;
    cache.invalidate();
    expect(cache.all()).toEqual([w]);
    cache.index();
    cache.bases();
    // One failed read, logged once, and no retry before BANK_STOCK_RETRY_MS.
    expect(reads).toBe(3);
    expect(log.lines.filter((l) => l.level === 'warn' && /Could not read your scrap\.tf watches/.test(l.msg))).toHaveLength(1);
    fail = false;
    t = NOW + 60_000;
    // A paused watch stays in all() and leaves the index and the bases.
    expect(cache.all().map((x) => x.enabled)).toEqual([false]);
    expect(cache.index().size).toBe(0);
    expect(cache.bases().size).toBe(0);
  });
});
