// 0.8 (PC-1, PC-2, H2) mock parity: with a price-move reserve set, the browser mock answers every buy decision
// through the shared flipProfit / maxCostFor / exitCostsOf, flags a flip only the revenue order's buyer makes with
// the shared singleExitOf over the drawer's own book, and carries the next buyer on Holdings rows, as the service
// does. Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockPrices, type MockBook } from '../../src/renderer/mockData';
import { revenueOrderOf } from '../../src/renderer/oppModel';
import { BANK_STOCK_MAX_LIMIT } from '../../src/shared/bankStock';
import { buyerDepthOf, exitCostsOf, exitOrdersOfSummaries, flipProfit, maxCostFor, singleExitOf } from '../../src/shared/ceiling';
import { CHECK_SAMPLE_TEXT } from '../../src/shared/check';
import type { ProfitSettings, Settings } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

/** A bridge with a 5% price-move reserve, and the profit settings it answers with. */
async function withReserve(): Promise<{ b: MockBridge; settings: Settings; p: ProfitSettings }> {
  const b = make();
  const settings = await b.rpc('settings.set', { profit: { exitReservePct: 0.05 } });
  expect(settings.profit.exitReservePct).toBe(0.05);
  return { b, settings, p: settings.profit };
}

describe('0.8 (PC-1): the mock prices every buy decision with flipProfit', () => {
  it('opportunities: profit is flipProfit and Pay up to is maxCostFor, the reserve included', async () => {
    const { b, p } = await withReserve();
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    expect(rows.length).toBeGreaterThan(0);
    let reserved = 0;
    for (const o of rows) {
      expect(o.profitScrap, o.key).toBe(flipProfit(o.revenueScrap, o.costScrap, p));
      expect(o.maxCostScrap, o.key).toBe(maxCostFor(o.revenueScrap, p));
      if (o.revenueScrap !== null && o.revenueScrap > 0) reserved++;
    }
    // The reserve is taken off real revenue, not only null rows.
    expect(reserved).toBeGreaterThan(0);
  });

  it('Live market rows: profit is flipProfit of the known cost', async () => {
    const { b, p } = await withReserve();
    const { rows } = await b.rpc('market.list', { limit: 2000 });
    expect(rows.some((r) => r.profitScrap !== null)).toBe(true);
    for (const r of rows) expect(r.profitScrap, r.sku).toBe(flipProfit(r.revenueScrap, r.knownCostScrap, p));
  });

  it('bank stock rows: profit is flipProfit in every bank', async () => {
    const { b, p } = await withReserve();
    const banks = (await b.rpc('scraptf.banks', undefined)).banks.filter((c) => c.bank !== 'list');
    let seen = 0;
    for (const card of banks) {
      const page = await b.rpc('scraptf.bankStock', { bank: card.bank, limit: BANK_STOCK_MAX_LIMIT });
      for (const r of page.rows) {
        seen++;
        expect(r.profitScrap, `${card.bank} ${r.key}`).toBe(flipProfit(r.revenueScrap, r.costScrap, p));
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("the Live check's exitCosts are exitCostsOf the revenue", async () => {
    const { b, p } = await withReserve();
    const r = await b.rpc('check.text', { text: CHECK_SAMPLE_TEXT, source: 'manual' });
    expect(r.status).toBe('item');
    const rev = r.revenue?.revenueScrap ?? null;
    expect(rev).not.toBeNull();
    expect(r.exitCosts).toEqual(exitCostsOf(rev, p));
    expect(r.exitCosts!.reserveScrap).toBe(Math.ceil((rev! * 5) / 100));
    expect(r.profitScrap).toBe(r.price ? flipProfit(rev, r.price.valueScrap, p) : null);
  });
});

describe('0.8 (PC-2, H2): the next buyer in the mock', () => {
  it("'single-exit' on exactly the profitable rows singleExitOf names over the drawer's book", async () => {
    const { b, p } = await withReserve();
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    const profitable = rows.filter((o) => o.status === 'profitable');
    expect(profitable.length).toBeGreaterThan(0);
    let thin = 0;
    for (const o of profitable) {
      const d = (await b.rpc('item.detail', { sku: o.sku }))!;
      const order = revenueOrderOf(o, p.useOrder)!;
      const single = singleExitOf(o.revenueScrap, o.costScrap, buyerDepthOf(exitOrdersOfSummaries(d.buyOrders), order.listingId, p.useOrder).nextBuyer, p);
      expect(o.flags.includes('single-exit'), o.key).toBe(single !== null);
      if (single) {
        thin++;
        // The 0-delta reason is the last one, as the engine writes it.
        expect(o.reasons.at(-1), o.key).toMatch(/^0 Only this buyer makes it a flip/);
      }
    }
    expect(thin).toBeGreaterThan(0);
    // Never on a row that is not a flip.
    for (const o of rows) if (o.status !== 'profitable') expect(o.flags, o.key).not.toContain('single-exit');
  });

  it("Live market and Holdings rows never carry 'single-exit' (the service's MarketEval flags have none)", async () => {
    const b = make();
    const market = (await b.rpc('market.list', { limit: 2000 })).rows;
    // Books with a lone buyer are in the sample, so the neutral cost-0 evaluation would flag them.
    expect(market.some((r) => r.buyerCount === 1)).toBe(true);
    for (const r of market) expect(r.flags, r.sku).not.toContain('single-exit');
    const holdings = (await b.rpc('holdings.list', {})).rows;
    expect(holdings.length).toBeGreaterThan(0);
    for (const r of holdings) expect(r.flags, r.sku).not.toContain('single-exit');
  });

  it('Holdings rows with a buy side carry nextBuyer and verifiedBuyerCount', async () => {
    const b = make();
    const { rows } = await b.rpc('holdings.list', {});
    const sided = rows.filter((r) => r.buyerCount > 0);
    expect(sided.length).toBeGreaterThan(0);
    for (const r of sided) {
      expect(typeof r.verifiedBuyerCount, r.sku).toBe('number');
      expect(r.nextBuyer, r.sku).not.toBeUndefined();
    }
  });

  it("item.detail values every order at today's key price and flags the pricing's outliers", async () => {
    const b = make();
    const settings = await b.rpc('settings.get', undefined);
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    const skus = [...new Set(rows.map((o) => o.sku))];
    let computed = 0;
    for (const sku of skus) {
      const d = (await b.rpc('item.detail', { sku }))!;
      const K = d.keyPrice!.valueScrap;
      for (const o of d.buyOrders) expect(o.valueScrap, o.listingId).toBe(Math.round(o.keys * K) + o.metalScrap);
      // The pricing's own outliers (the median and reference rules), read from the book with every flag the
      // detail added taken off: each one is flagged in the drawer's book.
      const plain = d.buyOrders.map((o) => ({ ...o, flags: o.flags.filter((f) => f !== 'outlier') }));
      const { outlierIds } = mockPrices({ buy: plain, references: d.references } as unknown as MockBook, settings, K, T0);
      for (const id of outlierIds) {
        computed++;
        expect(d.buyOrders.find((o) => o.listingId === id)!.flags, `${sku} ${id}`).toContain('outlier');
      }
    }
    expect(computed).toBeGreaterThan(0);
  });
});
