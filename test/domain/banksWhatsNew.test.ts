// F17 in the banks summary (src/service/domain/banks.ts): each card's "What's new" comes from the bank
// stock cache (BankStock.whatsNew) on every summary(), outside the cached parts, so it follows the live
// book without an invalidation of its own; null with fewer than 2 saves or without the cache (0.5
// wiring); a failing read shows none and is logged once. Real in-memory repo and bank stock cache, a
// fake market; pages the user saved only (R10), nothing touches scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import { createBanksSummary, type BanksSummary } from '../../src/service/domain/banks';
import type { MarketEval } from '../../src/service/domain/market';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { BankStockStored, KeyPriceState, ScraptfBank, ScraptfBankSummary, UnixMs } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, recordingLogger } from './helpers';

const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows);
  return id;
}

function entry(revenueScrap: number): MarketEval {
  return {
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: revenueScrap,
    revenueScrap,
    revenueOrder: null,
    bestOrder: null,
    buyerCount: 2,
    eligibleCount: 2,
    maxCostScrap: maxCostFor(revenueScrap, DEFAULT_SETTINGS.profit),
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    lastOrderChangeAt: T0 - MIN,
    referenced: true,
  };
}

function setup(stockDep: 'real' | 'none' | Pick<BankStock, 'whatsNew'> = 'real') {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const clock = new FakeClock(T0);
  const timers = new FakeTimers(clock);
  const log = recordingLogger();
  const entries = new Map<string, MarketEval>();
  const stock = createBankStock({
    clock,
    log,
    repo,
    market: { entryFor: (b) => entries.get(b) ?? null },
    keyPrice: () => KEY,
    settings: () => DEFAULT_SETTINGS,
    categoryOf: () => 'hats',
  });
  const banks: BanksSummary = createBanksSummary({
    clock,
    log,
    repo,
    market: { uncheckedBy: () => new Map() },
    scraptfList: { summary: () => ({ items: 0, newestAt: null, oldestAt: null, batches: 0 }), all: () => [], version: () => 1 },
    settings: () => DEFAULT_SETTINGS,
    folderWatch: () => ({ active: false, error: null }),
    timers,
    ...(stockDep === 'real' ? { bankStock: stock } : stockDep === 'none' ? {} : { bankStock: stockDep }),
  });
  const card = (bank: ScraptfBank): ScraptfBankSummary => banks.summary(clock.now()).banks.find((b) => b.bank === bank)!;
  return { repo, stock, banks, entries, log, card };
}

/** Hats: 3 h ago, then 4 min ago with two new (one a flip), one gone, one cheaper and one pricier. Killstreaks: one save. */
function seed(repo: Repo): void {
  save(repo, 'hats', T0 - 3 * HOUR, [s('1;6', 10), s('2;6', 20), s('3;6', 30), s('4;6', 40)]);
  save(repo, 'hats', T0 - 4 * MIN, [s('1;6', 10), s('3;6', 25), s('4;6', 45), s('5;6', 10), s('6;6', 50)]);
  save(repo, 'killstreaks', T0 - 26 * HOUR, [s('200;6;kt-1', 30)]);
}

describe("each bank card's What's new (F17)", () => {
  it('counts the changes since the previous save, new flips from the live book', () => {
    const h = setup();
    seed(h.repo);
    h.entries.set('5;6', entry(100)); // new, +90: a flip
    h.entries.set('6;6', entry(40)); // new, -10: over
    expect(h.card('hats').whatsNew).toEqual({ new: 2, newFlips: 1, gone: 1, cheaper: 1, pricier: 1, since: T0 - 3 * HOUR });
    // One save: "First save"; never saved: nothing either.
    expect(h.card('killstreaks').whatsNew).toBeNull();
    expect(h.card('skins').whatsNew).toBeNull();
    expect(h.banks.summary(T0).banks.map((b) => b.bank)).toEqual(SCRAPTF_BANKS.map((b) => b.bank));
  });

  it('is read on every summary, so a new buyer shows without an invalidation', () => {
    const h = setup();
    seed(h.repo);
    expect(h.card('hats').whatsNew).toMatchObject({ new: 2, newFlips: 0 });
    h.entries.set('6;6', entry(200));
    expect(h.card('hats').whatsNew).toMatchObject({ new: 2, newFlips: 1 });
  });

  it('follows a new save once the cache refreshed (core: bankStockChanged)', () => {
    const h = setup();
    seed(h.repo);
    expect(h.card('killstreaks').whatsNew).toBeNull();
    save(h.repo, 'killstreaks', T0 - MIN, [s('200;6;kt-1', 30), s('201;6;kt-1', 12)]);
    h.stock.refresh();
    h.banks.invalidate();
    expect(h.card('killstreaks').whatsNew).toEqual({ new: 1, newFlips: 0, gone: 0, cheaper: 0, pricier: 0, since: T0 - 26 * HOUR });
  });

  it('is null without the bank stock (0.5 wiring), and when it fails (logged once)', () => {
    const none = setup('none');
    seed(none.repo);
    expect(none.banks.summary(T0).banks.every((b) => b.whatsNew === null)).toBe(true);
    const failing = setup({
      whatsNew: () => {
        throw new Error('boom');
      },
    });
    seed(failing.repo);
    failing.banks.summary(T0);
    const s2 = failing.banks.summary(T0);
    expect(s2.banks.every((b) => b.whatsNew === null)).toBe(true);
    expect(failing.log.lines.filter((l) => l.level === 'warn' && /what's new/.test(l.msg))).toHaveLength(1);
  });

  it('returns copies: changing an answer does not change the next one', () => {
    const h = setup();
    seed(h.repo);
    const w = h.card('hats').whatsNew!;
    w.new = 99;
    expect(h.card('hats').whatsNew!.new).toBe(2);
  });
});
