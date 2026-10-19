// 0.7.1 (UX-2b) in the banks summary (src/service/domain/banks.ts): a bank page's card counts the flips its
// stock page shows (the Flips chip: on sale on the shown saves, verdict flip, most profit first), so the
// card and the page agree even after a later /items save re-tagged the bank's prices to the list. Only the
// All items card, and a bank with no stock save, count the profitable opportunities on its prices. Real
// in-memory repo and bank stock cache, a fake market; pages the user saved only (R10), no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import { createBanksSummary } from '../../src/service/domain/banks';
import type { MarketEval } from '../../src/service/domain/market';
import { BANK_STOCK_MAX_LIMIT, bankStockSpecialKey } from '../../src/shared/bankStock';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { BankStockStored, KeyPriceState, Opportunity, ScrapPrice, ScraptfBank, UnixMs } from '../../src/shared/types';
import { makeOpp } from '../db/helpers';
import { FakeClock, FakeTimers, HOUR, MIN, T0, recordingLogger } from './helpers';

const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };
const PAINT = bankStockSpecialKey({ paint: 15185211 });

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows, bank === 'list' ? '/items' : `/buy/${bank}`);
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
    buyerCount: 3,
    eligibleCount: 3,
    maxCostScrap: maxCostFor(revenueScrap, DEFAULT_SETTINGS.profit),
    confidence: 80,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: T0 - MIN,
    referenced: true,
  };
}

function price(repo: Repo, sku: string, costScrap: number, importBatch: number): ScrapPrice {
  return repo.upsertScrapPrice({ sku, name: `Item ${sku}`, costScrap, source: 'import', observedAt: T0 - HOUR, importBatch, stock: 1 });
}

function flip(p: Pick<ScrapPrice, 'id' | 'sku'>, profitScrap: number): Opportunity {
  return makeOpp({ sku: p.sku, name: `Item ${p.sku}`, inputRef: `price:${p.id}`, inputKind: 'import', status: 'profitable', profitScrap, costScrap: 10, revenueScrap: 10 + profitScrap });
}

function setup(stockDep: 'real' | 'whatsNew-only' = 'real') {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const clock = new FakeClock(T0);
  const entries = new Map<string, MarketEval>([
    ['1;6', entry(60)],
    ['2;6', entry(50)],
  ]);
  const stock: BankStock = createBankStock({ clock, log: recordingLogger(), repo, market: { entryFor: (b) => entries.get(b) ?? null }, keyPrice: () => KEY, settings: () => DEFAULT_SETTINGS, categoryOf: () => 'hats' });
  const banks = createBanksSummary({
    clock,
    log: recordingLogger(),
    repo,
    market: { uncheckedBy: () => new Map() },
    scraptfList: { summary: () => ({ items: 0, newestAt: null, oldestAt: null, batches: 0 }), all: () => [], version: () => 1 },
    settings: () => DEFAULT_SETTINGS,
    folderWatch: () => ({ active: false, error: null }),
    timers: new FakeTimers(clock),
    bankStock: stockDep === 'real' ? stock : { whatsNew: (b) => stock.whatsNew(b) },
  });
  const card = (bank: ScraptfBank) => banks.summary(clock.now()).banks.find((b) => b.bank === bank)!;
  return { repo, stock, banks, card, entries };
}

/** A hats page with two flips (one painted copy too), its prices and opportunities, then an /items save that re-tags one price. */
function seed(repo: Repo): void {
  const hats = save(repo, 'hats', T0 - HOUR, [s('1;6', 10), s('1;6', 14, { specialKey: PAINT }), s('2;6', 20), s('3;6', 30)]);
  const p1 = price(repo, '1;6', 10, hats);
  const p2 = price(repo, '2;6', 20, hats);
  repo.upsertOpportunities([flip(p1, 48), flip(p2, 28)]);
  // The /items list saved after it lists 1;6 too: its price now belongs to the list's batch.
  const list = save(repo, 'list', T0 - 30 * MIN, [s('1;6', 10)]);
  repo.upsertScrapPrice({ id: p1.id, sku: '1;6', name: 'Item 1;6', costScrap: 10, source: 'import', observedAt: T0 - 30 * MIN, importBatch: list, stock: 1 });
}

describe("a bank page's card flips (UX-2b)", () => {
  it("equals its stock page's Flips chip after an /items re-tag, with the page's most profitable rows", () => {
    const h = setup();
    seed(h.repo);
    const page = h.stock.list({ bank: 'hats', filter: 'flips', sort: 'profit', dir: 'desc', limit: BANK_STOCK_MAX_LIMIT }, T0);
    expect(page.counts.flips).toBe(3);
    const hats = h.card('hats');
    expect(hats.flips).toBe(page.counts.flips);
    expect(hats.top.map((t) => [t.sku, t.profitScrap])).toEqual(page.rows.slice(0, 3).map((r) => [r.sku, r.profitScrap]));
    expect(hats.flipProfitScrap).toBe(page.rows.reduce((n, r) => n + (r.profitScrap ?? 0), 0));
    for (let i = 1; i < hats.top.length; i++) expect(hats.top[i - 1]!.profitScrap).toBeGreaterThanOrEqual(hats.top[i]!.profitScrap);
  });

  it('follows the live book like the page, with no invalidation', () => {
    const h = setup();
    seed(h.repo);
    h.entries.delete('2;6');
    expect(h.card('hats').flips).toBe(h.stock.list({ bank: 'hats' }, T0).counts.flips);
    expect(h.card('hats').flips).toBe(2);
  });

  it('keeps the price rule for the All items card and for a bank with no stock save', () => {
    const h = setup();
    seed(h.repo);
    // The re-tagged price's flip counts for the list, as F15 counts it.
    expect(h.card('list')).toMatchObject({ flips: 1, flipProfitScrap: 48 });
    // A bank whose page was saved before bank stock existed: its opportunities still count.
    const old = h.repo.createImportBatch({ fileName: 'weapons.html', pageKind: 'buy', fileMtime: T0 - 2 * HOUR, importedAt: T0 - 2 * HOUR, itemCount: 1, bank: 'weapons' });
    h.repo.upsertOpportunities([flip(price(h.repo, '205;6', 10, old), 15)]);
    h.banks.invalidate();
    expect(h.card('weapons')).toMatchObject({ flips: 1, flipProfitScrap: 15 });
  });

  it('without the stock list (an older stand-in), counts opportunities as before', () => {
    const h = setup('whatsNew-only');
    seed(h.repo);
    expect(h.card('hats')).toMatchObject({ flips: 1, flipProfitScrap: 28 });
  });
});
