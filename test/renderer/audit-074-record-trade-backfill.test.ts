// 0.7.4 (audit F39, F38, F80) in the renderer's pure rules, and the browser mock's parity with the service:
//  - F39: a When more than BACKFILL_MS back is a backfill; checkTrade then sends the key price then (typed in
//    ref, else today's), and refuses one that is no key price (field 'key').
//  - F38: a sale with no open buy, or dated before the open lot, is compared with no lot and says it is kept
//    apart; a waiting sale's "Record its buy" opens a scrap.tf buy dated just before the sale.
//  - F80: Quick entry's save sends replaceTyped, and the mock updates the newest typed price of the copy.
// Pure, plus the mock bridge; nothing leaves the process.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { journalSummary } from '../../src/service/domain/journal';
import type { JournalEntry, JournalSummary, OrderSummary, ScrapPrice } from '../../src/shared/types';
import { fromDateTimeLocal, toDateTimeLocal } from '../../src/renderer/format';
import { createMockBridge } from '../../src/renderer/mock';
import { mockJournalSummary } from '../../src/renderer/mockData';
import { quickSaveInput, replacedPrice } from '../../src/renderer/pages/QuickEntry';
import {
  BACKFILL_MS,
  LOT_AFTER_SALE_TEXT,
  NO_LOT_SALE_TEXT,
  WAITING_SALE_BUY_LEAD_MS,
  backfillKeyPrice,
  checkTrade,
  initialTradeForm,
  isBackfill,
  sellComparison,
  waitingSaleBuyInit,
  waitingSalesText,
  type TradeForm,
} from '../../src/renderer/recordTradeModel';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const KEY = 577;
const P = { ...DEFAULT_SETTINGS.profit };
const ITEM = { sku: '5021;6', name: 'Mann Co. Supply Crate Key' };

const form = (over: Partial<TradeForm> = {}): TradeForm => ({ side: 'sell', venue: 'backpack.tf', text: '70', unit: 'ref', when: toDateTimeLocal(T0), note: '', ...over });

function order(valueScrap: number): OrderSummary {
  return { listingId: 'l', steamid: '76561198000000001', userName: 'Bot', keys: 0, metalScrap: valueScrap, valueScrap, isBot: true, online: true, lastEventAt: T0, bumpedAt: null, details: '', flags: [], eligible: true };
}

describe('a backfilled trade and its key price (F39)', () => {
  it('is a backfill only when When is more than 10 minutes back', () => {
    expect(BACKFILL_MS).toBe(10 * MIN);
    expect(isBackfill(toDateTimeLocal(T0 - 11 * MIN), T0)).toBe(true);
    expect(isBackfill(toDateTimeLocal(T0 - 9 * MIN), T0)).toBe(false);
    expect(isBackfill('', T0)).toBe(false);
    expect(isBackfill('not a date', T0)).toBe(false);
  });

  it("sends the typed key price, else today's, for a backfill only", () => {
    const back = toDateTimeLocal(T0 - 14 * DAY);
    expect(checkTrade(form({ when: back, keyText: '60' }), ITEM, T0, KEY)).toMatchObject({ ok: true, input: { keyPriceScrap: 540, ts: fromDateTimeLocal(back) } });
    expect(checkTrade(form({ when: back, keyText: '540 scrap' }), ITEM, T0, KEY)).toMatchObject({ ok: true, input: { keyPriceScrap: 540 } });
    expect(checkTrade(form({ when: back }), ITEM, T0, KEY)).toMatchObject({ ok: true, input: { keyPriceScrap: KEY } });
    // Now: the service stamps today's; no key price known yet: none either.
    const now = checkTrade(form({ keyText: '60' }), ITEM, T0, KEY);
    expect(now.ok && 'keyPriceScrap' in now.input).toBe(false);
    const unknown = checkTrade(form({ when: back }), ITEM, T0, null);
    expect(unknown.ok && 'keyPriceScrap' in unknown.input).toBe(false);
  });

  it('refuses a key price that is no key price, on the key field', () => {
    const back = toDateTimeLocal(T0 - DAY);
    for (const keyText of ['a lot', '2 keys', '0.5', '20000']) {
      expect(checkTrade(form({ when: back, keyText }), ITEM, T0, KEY)).toMatchObject({ ok: false, field: 'key' });
    }
    expect(backfillKeyPrice('', KEY)).toEqual({ value: KEY, error: null });
    expect(backfillKeyPrice('  ', null)).toEqual({ value: null, error: null });
  });

  it('books what the dialog sent: the pair at the key price then (90, not 53)', () => {
    const buy = checkTrade(form({ side: 'buy', venue: 'scrap.tf', text: '1 key', when: toDateTimeLocal(T0 - 15 * DAY), keyText: '60' }), ITEM, T0, KEY);
    const sale = checkTrade(form({ text: '70', when: toDateTimeLocal(T0 - 14 * DAY), keyText: '60' }), ITEM, T0, KEY);
    if (!buy.ok || !sale.ok) throw new Error('not ok');
    const rows: JournalEntry[] = [buy.input, sale.input].map((i, n) => ({ id: n + 1, ts: i.ts!, side: i.side, venue: i.venue, sku: i.sku, name: i.name ?? '', keys: i.keys ?? 0, scrap: i.scrap, keyPriceScrap: i.keyPriceScrap ?? KEY, note: null }));
    expect(journalSummary(rows).realizedProfitScrap).toBe(90);
  });
});

describe('a sale with no buy before it (F38)', () => {
  const held = { qty: 1, nextLotCostScrap: 400, heldSince: T0 - DAY, revenueScrap: 500, revenueOrder: order(500) };

  it('says the sale is kept apart, with no lot to compare', () => {
    expect(sellComparison(600, null, P, KEY, T0)).toMatchObject({ heldQty: 0, lotCostScrap: null, profitScrap: null, text: NO_LOT_SALE_TEXT });
    expect(NO_LOT_SALE_TEXT).toMatch(/record its buy dated before the sale/);
  });

  it('compares a sale dated before the open lot with no lot (it does not close it)', () => {
    expect(sellComparison(600, held, P, KEY, T0, 'ok', T0 - 2 * DAY)).toMatchObject({ heldQty: 0, lotCostScrap: null, profitScrap: null, text: LOT_AFTER_SALE_TEXT });
    // At or after the lot: the usual comparison.
    expect(sellComparison(600, held, P, KEY, T0, 'ok', T0 - DAY)).toMatchObject({ heldQty: 1, lotCostScrap: 400, profitScrap: 600 - 400 - P.frictionScrap });
    expect(sellComparison(600, held, P, KEY, T0)).toMatchObject({ heldQty: 1, lotCostScrap: 400 });
  });

  it('records its buy dated just before the sale, so FIFO matches the two', () => {
    const w = { id: 7, ts: T0 - 7 * DAY, sku: '5040;6', name: 'A Distinctive Lack of Hue', keys: 2, scrap: 198 };
    const init = waitingSaleBuyInit(w);
    expect(init).toEqual({ side: 'buy', sku: '5040;6', name: 'A Distinctive Lack of Hue', venue: 'scrap.tf', ts: w.ts - WAITING_SALE_BUY_LEAD_MS });
    const f = initialTradeForm(init, T0);
    expect(f.when).toBe(toDateTimeLocal(w.ts - WAITING_SALE_BUY_LEAD_MS));
    expect(fromDateTimeLocal(f.when)!).toBeLessThan(w.ts);
    // A prefill in the future (or none) is the clock's.
    expect(initialTradeForm({ ...init, ts: T0 + DAY }, T0).when).toBe(toDateTimeLocal(T0));
    expect(initialTradeForm({ side: 'buy', sku: 'x', name: 'x' }, T0).when).toBe(toDateTimeLocal(T0));
  });

  it('explains waiting sales on the Journal and Holdings pages', () => {
    expect(waitingSalesText(0)).toBeNull();
    expect(waitingSalesText(1)).toMatch(/^A sale in your journal has no buy of the item dated before it/);
    expect(waitingSalesText(3)).toMatch(/^3 sales in your journal have no buy/);
  });

  it('the mock waits a sale as the service does', () => {
    const row = (id: number, side: 'buy' | 'sell', ts: number, scrap: number): JournalEntry => ({ id, ts, side, venue: 'v', sku: 'A', name: 'A', keys: 0, scrap, keyPriceScrap: KEY, note: null });
    const rows = [row(1, 'sell', T0 - 2 * DAY, 30), row(2, 'buy', T0 - DAY, 20), row(3, 'sell', T0, 25)];
    const strip = (s: JournalSummary) => ({ realized: s.realizedProfitScrap, trades: s.realizedTrades, open: s.open.map((p) => [p.sku, p.qty]), waiting: s.waitingSales.map((w) => w.id) });
    expect(strip(mockJournalSummary(rows))).toEqual(strip(journalSummary(rows)));
    expect(strip(journalSummary(rows))).toEqual({ realized: 5, trades: 1, open: [], waiting: [1] });
  });
});

describe("Quick entry's save and the mock's replaceTyped (F80)", () => {
  it('sends replaceTyped, and names the price it replaced', () => {
    expect(quickSaveInput({ sku: '31511;6', name: 'The Top Brass' }, { keys: 0, scrap: 120 }, { observedAt: T0, note: null })).toEqual({
      sku: '31511;6',
      name: 'The Top Brass',
      costKeys: 0,
      costScrap: 120,
      source: 'user',
      observedAt: T0,
      note: null,
      replaceTyped: true,
    });
    expect(replacedPrice({ id: 4, costKeys: 0, costScrap: 81 }, { id: 4 })).toEqual({ costKeys: 0, costScrap: 81 });
    expect(replacedPrice({ id: 4, costKeys: 0, costScrap: 81 }, { id: 5 })).toBeNull();
    expect(replacedPrice(null, { id: 5 })).toBeNull();
  });

  it('the mock updates the newest typed price of the copy, as the service does', async () => {
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    try {
      const sku = '31511;6';
      const first = (await b.rpc('prices.upsert', { sku, costScrap: 81, source: 'user', observedAt: T0 - DAY, replaceTyped: true })) as ScrapPrice;
      const second = (await b.rpc('prices.upsert', { sku, costScrap: 120, source: 'user', observedAt: T0, replaceTyped: true })) as ScrapPrice;
      expect(second.id).toBe(first.id);
      const painted = (await b.rpc('prices.upsert', { sku: `${sku};p15185211`, costScrap: 150, source: 'user', replaceTyped: true })) as ScrapPrice;
      expect(painted.id).not.toBe(first.id);
      const typed = (await b.rpc('prices.list', {})).filter((p) => p.sku.startsWith('31511;6') && p.source === 'user');
      expect(typed.map((p) => p.costScrap).sort((x, y) => x - y)).toEqual([120, 150]);
      // No flag: a row is added, as the Prices page's Add does.
      const added = (await b.rpc('prices.upsert', { sku, costScrap: 90, source: 'user' })) as ScrapPrice;
      expect(added.id).not.toBe(first.id);
    } finally {
      b.dispose();
    }
  });
});
