// 0.9 (#3, risk control) in the S3 notifier: with notifications.minProfitableDepth set, the flip kinds (new, cheaper,
// back, Buy now) need at least that many buyers at break-even at the row's cost (BankStock.depthOf: profitableDepthAt
// over the Live market entry's ExitDepth); an unknown depth holds the row back. Watch price and profit hits are not
// held back. At 0 (the default) the candidates are exactly 0.8's. Pages the user saved only (R10); nothing touches
// scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, notifyNewBankFlips, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import {
  bankStockNotifyCandidates,
  type BankStockLook,
  type BankStockLookRow,
  type BankStockNotifyArgs,
} from '../../src/shared/bankStockNotify';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { profitableDepthAt, type ExitDepth } from '../../src/shared/exitRisk';
import type { PushContract } from '../../src/shared/rpc';
import type { BankStockRow, BankStockStored, DeepPartial, KeyPriceState, OrderSummary, ScraptfBank, ScraptfTimingBrief, ScraptfWatch, Settings, UnixMs } from '../../src/shared/types';
import { EMPTY_WATCH_INDEX, watchIndexOf } from '../../src/shared/watches';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const K = 600;
const KEY: KeyPriceState = { valueScrap: K, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

// ---------------------------------------------------------------------------
// The shared candidate list (bankStockNotify.test's rows)
// ---------------------------------------------------------------------------

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return { listingId: 'l1', steamid: '76561198000000001', userName: 'BuyBot', keys: 0, metalScrap: 60, valueScrap: 60, isBot: true, online: true, lastEventAt: NOW, bumpedAt: null, details: '', flags: [], eligible: true, ...over };
}

/** A new flip by default: 4.00 ref, sells for 6.66 ref, +2.22 ref, Pay up to 5.00 ref. */
function row(sku: string, over: Partial<BankStockRow> = {}): BankStockRow {
  return {
    sku,
    key: `${sku}|`,
    name: 'Team Captain',
    category: 'hats',
    hasExtras: false,
    costKeys: 0,
    costScrapRaw: 36,
    costScrap: 36,
    stock: 1,
    change: 'new',
    previousCostScrap: null,
    previousStock: null,
    revenueScrap: 60,
    revenueOrder: order(),
    buyerCount: 3,
    maxCostScrap: 45,
    profitScrap: 20,
    margin: 20 / 36,
    verdict: 'flip',
    confidence: 70,
    confidenceLevel: 'high',
    listedSince: null,
    firstSeenAt: null,
    changeSinceListed: null,
    ...over,
  };
}

function buyNow(): ScraptfTimingBrief {
  return {
    verdict: 'buy-now',
    why: 'flip-now',
    bank: 'hats',
    key: '100;6|',
    dropsThisRun: 1,
    steps: [],
    lastSeenAt: NOW,
    horizonMs: 6 * HOUR,
    pDrop: null,
    pGone: null,
    pRise: null,
    nextDropAt: null,
    n: { states: 40, copies: 12, atRisk: 20, dropCopies: 6 },
  } as ScraptfTimingBrief;
}

const lr = (r: BankStockRow, restock = false): BankStockLookRow => ({ row: r, restock });

function look(rows: BankStockLookRow[]): BankStockLook {
  return { bank: 'hats', page: '', savedAt: NOW, previousSavedAt: NOW - HOUR, rows };
}

/** One row of each flip kind: timing (100), back (101), cheaper (102), new (103). */
const FLIPS = (): BankStockLookRow[] => [
  lr(row('100;6', { change: null, profitScrap: 60, timing: buyNow() })),
  lr(row('101;6', { profitScrap: 40 }), true),
  lr(row('102;6', { change: 'cheaper', previousCostScrap: 50, profitScrap: 50 })),
  lr(row('103;6', { profitScrap: 30 })),
];

function args(rows: BankStockLookRow[], over: Partial<BankStockNotifyArgs> = {}): BankStockNotifyArgs {
  return {
    look: look(rows),
    flips: true,
    watches: EMPTY_WATCH_INDEX,
    minConfidence: 50,
    minProfitScrap: 9,
    keyScrap: K,
    suspect: () => false,
    timing: true,
    waitOf: () => ({ at: NOW - HOUR, since: NOW - HOUR, drops: 0, horizonMs: 6 * HOUR }),
    ...over,
  };
}

const kindsOf = (a: BankStockNotifyArgs) => bankStockNotifyCandidates(a).map((c) => [c.kind, c.row.sku]);

describe('bankStockNotifyCandidates with minDepth', () => {
  const v08 = kindsOf(args(FLIPS()));

  it('has every flip kind in 0.8 (the baseline)', () => {
    expect(v08).toEqual([
      ['new', '103;6'],
      ['cheaper', '102;6'],
      ['back', '101;6'],
      ['timing', '100;6'],
    ]);
  });

  it('holds back every flip kind with one buyer at break-even when 2 are asked for', () => {
    expect(kindsOf(args(FLIPS(), { minDepth: 2, depthOf: () => 1 }))).toEqual([]);
  });

  it('gives the 0.8 candidates with 2 buyers at break-even', () => {
    expect(kindsOf(args(FLIPS(), { minDepth: 2, depthOf: () => 2 }))).toEqual(v08);
    expect(bankStockNotifyCandidates(args(FLIPS(), { minDepth: 2, depthOf: () => 3 }))).toEqual(bankStockNotifyCandidates(args(FLIPS())));
  });

  it('holds back a row whose depth is unknown (no depthOf, or null)', () => {
    expect(kindsOf(args(FLIPS(), { minDepth: 2 }))).toEqual([]);
    expect(kindsOf(args(FLIPS(), { minDepth: 2, depthOf: () => null }))).toEqual([]);
    // Per row: only the rows with enough buyers pass.
    const depth: Record<string, number | null> = { '100;6': 5, '101;6': null, '102;6': 1, '103;6': 2 };
    expect(kindsOf(args(FLIPS(), { minDepth: 2, depthOf: (r) => depth[r.sku] ?? null }))).toEqual([
      ['new', '103;6'],
      ['timing', '100;6'],
    ]);
  });

  it('is exactly 0.8 with minDepth 0 or absent, and never asks for the depth then', () => {
    let asked = 0;
    const depthOf = (): number => {
      asked++;
      return 0;
    };
    const base = bankStockNotifyCandidates(args(FLIPS()));
    expect(bankStockNotifyCandidates(args(FLIPS(), { minDepth: 0, depthOf }))).toEqual(base);
    expect(bankStockNotifyCandidates(args(FLIPS(), { depthOf }))).toEqual(base);
    // A junk minimum is off too (minProfitableDepthOf).
    expect(bankStockNotifyCandidates(args(FLIPS(), { minDepth: Number.NaN, depthOf }))).toEqual(base);
    expect(asked).toBe(0);
  });

  it("still fires a watch price hit (the watch's own target is not held back)", () => {
    const w: ScraptfWatch = {
      id: 7,
      sku: '103;6',
      specialKey: '',
      name: 'Team Captain',
      maxCostKeys: 0,
      maxCostScrap: 40,
      minProfitScrap: null,
      onRestock: false,
      enabled: true,
      createdAt: NOW - DAY,
      updatedAt: NOW - DAY,
    };
    const cs = bankStockNotifyCandidates(args(FLIPS(), { watches: watchIndexOf([w]), minDepth: 2, depthOf: () => 0 }));
    expect(cs.map((c) => [c.kind, c.row.sku, c.hit])).toEqual([['watch', '103;6', 'price']]);
    // It no longer tells a flip the engine would tell (the gates held it back).
    expect(cs[0]).toMatchObject({ flip: false });
  });
});

// ---------------------------------------------------------------------------
// The service: BankStock.depthOf and notifyNewBankFlips (bankStockNotifyKinds' harness)
// ---------------------------------------------------------------------------

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Hat ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[], page = bank === 'list' ? '/items' : `/buy/${bank}`): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows, page);
  return id;
}

/** A Live market entry selling for `revenueScrap`, with the usable buyers `values` (highest first). */
function entry(revenueScrap: number, settings: Settings, values: number[] | null): MarketEval {
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
    ...(values ? { exitDepth: { values, buyers: values.length } satisfies ExitDepth } : {}),
  };
}

function setup(patch: DeepPartial<Settings> = {}, depths: Record<string, number[] | null> = {}) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, patch);
  const log = recordingLogger();
  let broken = false;
  const market = {
    entryFor: (base: string): MarketEval | null => {
      if (broken) throw new Error('market gone');
      if (base === '100;6') return null;
      return entry(200, settings, base in depths ? depths[base]! : [200, 190, 150]);
    },
  };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market, keyPrice: () => KEY });
  const stock = createBankStock({
    clock: { now: () => NOW },
    log,
    repo,
    market,
    keyPrice: () => KEY,
    settings: () => settings,
    categoryOf: () => 'hats',
    history: { runsFor: (bank) => history.runsFor(bank) },
  });
  const sent: PushContract['notify'][] = [];
  const M = maxCostFor(200, settings.profit)!;
  const run = (bankStock: Pick<BankStock, 'newFlips'> & Partial<BankStock>, batchId: number): number => {
    stock.refresh();
    history.refresh();
    return notifyNewBankFlips({ log, repo, stock: bankStock, settings: () => settings, keyPrice: () => KEY, notify: (n) => sent.push(n) }, { bank: 'hats', batchId }, NOW);
  };
  return { repo, stock, settings, sent, M, run, log, breakMarket: () => (broken = true) };
}

describe('BankStock.depthOf', () => {
  it("counts the entry's buyers at break-even at the row's cost; null for a family row, no entry or no ExitDepth", () => {
    const h = setup({}, { '102;6': null });
    save(h.repo, 'hats', NOW - 2 * HOUR, [s('100;6', 50)]);
    const newest = save(h.repo, 'hats', NOW - 5 * MIN, [s('100;6', 50), s('101;6', 170), s('102;6', 170), s('103;6', 195)]);
    h.stock.refresh();
    const rows = h.stock.newFlips('hats', newest);
    const byKey = new Map(rows.map((r) => [r.sku, r]));
    // 103 at 195 is over Pay up to (185): not a new flip.
    expect(h.M).toBe(185);
    expect([...byKey.keys()].sort()).toEqual(['101;6', '102;6']);
    const r101 = byKey.get('101;6')!;
    expect(h.stock.depthOf!(r101)).toBe(profitableDepthAt({ values: [200, 190, 150], buyers: 3 }, 170, h.settings.profit));
    expect(h.stock.depthOf!(r101)).toBe(2);
    expect(h.stock.depthOf!({ ...r101, costScrap: 195 })).toBe(1);
    // 102's entry carries no ExitDepth (a hand-built entry): unknown.
    expect(h.stock.depthOf!(byKey.get('102;6')!)).toBeNull();
    expect(h.stock.depthOf!({ ...r101, sku: '100;6' })).toBeNull();
    expect(h.stock.depthOf!({ ...r101, listFamily: true })).toBeNull();
  });

  it('never throws: a failing market read is null', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 2 * HOUR, [s('100;6', 50)]);
    const newest = save(h.repo, 'hats', NOW - 5 * MIN, [s('100;6', 50), s('101;6', 170)]);
    h.stock.refresh();
    const r = h.stock.newFlips('hats', newest)[0]!;
    h.breakMarket();
    expect(h.stock.depthOf!(r)).toBeNull();
  });
});

describe('notifyNewBankFlips reads notifications.minProfitableDepth', () => {
  /** Two new flips: 101 and 102. */
  function twoFlips(h: ReturnType<typeof setup>): number {
    save(h.repo, 'hats', NOW - 2 * HOUR, [s('100;6', 50)]);
    return save(h.repo, 'hats', NOW - 5 * MIN, [s('100;6', 50), s('101;6', h.M - 30), s('102;6', h.M - 20)]);
  }

  it('tells only the flips with enough buyers at break-even, read through the stock\'s depthOf', () => {
    const h = setup({ notifications: { minProfitableDepth: 2 } });
    const newest = twoFlips(h);
    const asked: string[] = [];
    const depth: Record<string, number> = { '101;6': 2, '102;6': 1 };
    const fake = {
      ...h.stock,
      depthOf: (r: BankStockRow) => {
        asked.push(r.sku);
        return depth[r.sku] ?? null;
      },
    };
    expect(h.run(fake, newest)).toBe(1);
    expect(h.sent.map((n) => n.title)).toEqual(['New on scrap.tf (Hats): Hat 101;6']);
    expect([...new Set(asked)].sort()).toEqual(['101;6', '102;6']);
  });

  it('with the default 0 tells both and never asks for the depth', () => {
    const h = setup();
    const newest = twoFlips(h);
    let asked = 0;
    const fake = {
      ...h.stock,
      depthOf: () => {
        asked++;
        return 0;
      },
    };
    expect(h.run(fake, newest)).toBe(2);
    expect(asked).toBe(0);
  });

  it('holds back every flip for an older stock without depthOf (unknown), or one whose depthOf throws', () => {
    const h = setup({ notifications: { minProfitableDepth: 2 } });
    const newest = twoFlips(h);
    const { depthOf: _d, ...older } = h.stock;
    expect(h.run(older, newest)).toBe(0);
    const throwing = {
      ...h.stock,
      depthOf: (): number => {
        throw new Error('depth gone');
      },
    };
    expect(h.run(throwing, newest)).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it('with the real stock, counts from the Live market entry', () => {
    const h = setup({ notifications: { minProfitableDepth: 3 } }, { '102;6': [200, 199, 198, 197] });
    const newest = twoFlips(h);
    // 101: 200, 190 and 150 against cost M - 30; 102: four buyers near 200 against M - 20.
    const d101 = profitableDepthAt({ values: [200, 190, 150], buyers: 3 }, h.M - 30, h.settings.profit)!;
    const d102 = profitableDepthAt({ values: [200, 199, 198, 197], buyers: 4 }, h.M - 20, h.settings.profit)!;
    expect(d101).toBeLessThan(3);
    expect(d102).toBe(4);
    expect(h.run(h.stock, newest)).toBe(1);
    expect(h.sent.map((n) => n.title)).toEqual(['New on scrap.tf (Hats): Hat 102;6']);
  });
});
