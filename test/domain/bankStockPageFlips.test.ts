// 0.7.1 BankStock.pageFlips: the flips on sale on the page just read (the scrap.tf window toolbar's
// "N flips on this page"), first saves included, unlike newFlips. Gone rows, sold-out rows and suspect
// margins are left out; only the first import of a page's newest look answers. A real in-memory repo
// and a fake Live market entryFor; saves are pages the user saved (R10), nothing touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { BankStockStored, KeyPriceState, OrderSummary, ScraptfBank, Settings, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number | null, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: costScrap === null ? null : 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[], importedAt = at): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows);
  return id;
}

function order(valueScrap: number): OrderSummary {
  return {
    listingId: `l${valueScrap}`,
    steamid: '76561198000000001',
    userName: 'BuyBot',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: true,
    online: true,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
}

function entry(revenueScrap: number, settings: Settings, over: Partial<MarketEval> = {}): MarketEval {
  const o = order(revenueScrap);
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
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
    ...over,
  };
}

function setup(): { repo: Repo; stock: BankStock; set(base: string, revenue: number, over?: Partial<MarketEval>): void } {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const entries = new Map<string, MarketEval>();
  // Friction on, so profit = revenue - cost - friction is visible.
  const settings = mergeSettings(DEFAULT_SETTINGS, { profit: { frictionScrap: 2 } });
  const keyPrice: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
  const stock = createBankStock({
    clock: { now: () => NOW },
    log: recordingLogger(),
    repo,
    market: { entryFor: (base) => entries.get(base) ?? null },
    keyPrice: () => keyPrice,
    settings: () => settings,
    categoryOf: () => 'hats',
  });
  return { repo, stock, set: (base, revenue, over) => entries.set(base, entry(revenue, settings, over)) };
}

const flipsOf = (rows: readonly { sku: string; profitScrap: number | null }[]) => rows.map((r) => [r.sku, r.profitScrap]);

describe('BankStock.pageFlips', () => {
  it('lists every flip on sale on a first save, most profit first, where newFlips has none', () => {
    const h = setup();
    const first = save(h.repo, 'hats', NOW - 10 * MIN, [
      s('1;6', 30), // flip: 60 - 30 - 2 = +28
      s('2;6', 50), // over its Pay up to
      s('3;6', 20), // flip: 100 - 20 - 2 = +78
      s('4;6', 10, { stock: 0 }), // would be a flip, but sold out on this save
      s('5;6', null), // no price to buy
      s('6;6', 10), // no buyers at all
    ]);
    h.set('1;6', 60);
    h.set('2;6', 55);
    h.set('3;6', 100);
    h.set('4;6', 100);
    h.set('5;6', 100);
    const rows = h.stock.pageFlips('hats', first);
    expect(flipsOf(rows)).toEqual([
      ['3;6', 78],
      ['1;6', 28],
    ]);
    expect(rows.every((r) => r.verdict === 'flip' && r.change === null)).toBe(true);
    expect(h.stock.newFlips('hats', first)).toEqual([]);
  });

  it('leaves out gone rows and suspect margins, keeps unchanged and new ones, and answers only the newest look', () => {
    const h = setup();
    const first = save(h.repo, 'hats', NOW - 3 * HOUR, [s('1;6', 30), s('3;6', 20), s('8;6', 40)]);
    const second = save(h.repo, 'hats', NOW - 10 * MIN, [
      s('1;6', 30), // unchanged flip
      s('7;6', 10), // new flip: 50 - 10 - 2 = +38
      s('8;6', 35), // cheaper flip: 50 - 35 - 2 = +13
      s('9;6', 10), // a huge margin from 2 orders and no reference: suspect
    ]);
    h.set('1;6', 60);
    h.set('3;6', 100); // gone from the newest save: was a flip, now nothing to buy
    h.set('7;6', 50);
    h.set('8;6', 50);
    h.set('9;6', 200, { referenced: false, eligibleCount: 2 });
    expect(flipsOf(h.stock.pageFlips('hats', second))).toEqual([
      ['7;6', 38],
      ['1;6', 28],
      ['8;6', 13],
    ]);
    // newFlips keeps its own rule: new rows only.
    expect(flipsOf(h.stock.newFlips('hats', second))).toEqual([['7;6', 38]]);
    // The suspect row is still on the stock page as a flip: shown there, just never counted here.
    expect(h.stock.list({ bank: 'hats', filter: 'flips', limit: 100 }, NOW).rows.map((r) => r.sku)).toContain('9;6');
    // An older save of the page, another bank, or a batch that is not a save: nothing.
    expect(h.stock.pageFlips('hats', first)).toEqual([]);
    expect(h.stock.pageFlips('weapons', second)).toEqual([]);
    expect(h.stock.pageFlips('hats', 9_999)).toEqual([]);
  });

  it('answers the first import of a look, not the same file imported again', () => {
    const h = setup();
    const look = save(h.repo, 'hats', NOW - 10 * MIN, [s('1;6', 30)]);
    h.set('1;6', 60);
    const again = save(h.repo, 'hats', NOW - 10 * MIN, [s('1;6', 30)], NOW - MIN);
    h.stock.refresh();
    expect(h.stock.pageFlips('hats', again)).toEqual([]);
    expect(flipsOf(h.stock.pageFlips('hats', look))).toEqual([['1;6', 28]]);
  });

  it('reads the newest save on its own: a page diffed against a far older save lists the same flips', () => {
    const fresh = setup();
    const a = save(fresh.repo, 'hats', NOW - 10 * MIN, [s('1;6', 30), s('7;6', 10)]);
    const compared = setup();
    save(compared.repo, 'hats', NOW - 30 * 24 * HOUR, [s('7;6', 12), s('8;6', 5)]);
    const b = save(compared.repo, 'hats', NOW - 10 * MIN, [s('1;6', 30), s('7;6', 10)]);
    for (const h of [fresh, compared]) {
      h.set('1;6', 60);
      h.set('7;6', 50);
      h.set('8;6', 50);
    }
    expect(flipsOf(compared.stock.pageFlips('hats', b))).toEqual(flipsOf(fresh.stock.pageFlips('hats', a)));
  });
});
