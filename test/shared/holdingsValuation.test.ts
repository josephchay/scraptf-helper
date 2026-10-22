// 0.9: the valuation of everything held, for the Journal's Unrealised P/L card and the ledger CSV. holdingsValuationOf
// reads one holdings read (Worth now's exits, unpriced items, locked items); lotValueOf values one open lot exactly as
// the row's profitAllScrap counts it (friction only, keys at the read's key price), so a SKU's lots sum to the row;
// journalLedger with a valuer dates the value on open buys only, and the ledger CSV's three appended columns stay
// blank without one. Unrealised: nothing is booked. Pure; no network.

import { describe, expect, it } from 'vitest';
import { scrapToRef } from '../../src/shared/currency';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { withTradeLock } from '../../src/shared/holdingAdvice';
import {
  holdingRow,
  holdingsResult,
  holdingsValuationOf,
  journalValuerOf,
  lotCostAt,
  lotValueOf,
  type HoldingBuySide,
} from '../../src/shared/holdings';
import { JOURNAL_CSV_COLUMNS, journalCsvCells, journalLedger, journalSummary } from '../../src/shared/journal';
import type { HoldingRow, HoldingsValuation, JournalEntry, KeyPriceState, OrderSummary, ProfitSettings } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const KEY = 567;
// Friction set, so the per-lot friction must add up to the row's.
const P: ProfitSettings = { ...DEFAULT_SETTINGS.profit, frictionScrap: 2 };

function order(value: number): OrderSummary {
  return { listingId: `o${value}`, steamid: `S${value}`, userName: 'Buyer', keys: 0, metalScrap: value, valueScrap: value, isBot: true, online: null, lastEventAt: NOW - MIN, bumpedAt: null, details: '', flags: [], eligible: true };
}

function side(value: number): HoldingBuySide {
  const o = order(value);
  return {
    revenueScrap: value,
    bestScrap: value,
    instantScrap: value,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 2,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    nextBuyer: null,
    verifiedBuyerCount: 1,
  };
}

function keyPrice(valueScrap: number): KeyPriceState {
  return { valueScrap, source: 'pricedb', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
}

let nextId = 1;
function entry(side: JournalEntry['side'], sku: string, ts: number, keys: number, scrap: number, over: Partial<JournalEntry> = {}): JournalEntry {
  return { id: nextId++, ts, side, venue: side === 'buy' ? 'scrap.tf' : 'backpack.tf', sku, name: `Item ${sku}`, keys, scrap, keyPriceScrap: 540, note: null, ...over };
}

// Team Captain: a buy closed by a sale, then a metal buy and a 1-key buy (with a 2 scrap fee, bought while a key was
// 540) still open; Bill's Hat: an open buy nobody pays for.
const A = '378;6';
const B = '126;6';
const ENTRIES: JournalEntry[] = [
  entry('buy', A, NOW - 5 * DAY, 0, 100),
  entry('sell', A, NOW - 4 * DAY, 0, 150),
  entry('buy', A, NOW - 3 * DAY, 0, 110),
  entry('buy', A, NOW - 2 * DAY, 1, 5, { feeKeys: 0, feeScrap: 2 }),
  entry('buy', B, NOW - 10 * DAY, 0, 50),
];

/** Holdings' rows over the journal's open positions at KEY: A paid 600 scrap (metal) by its buyer, B no buyer. */
function rows(mode: 'none' | '7d' = 'none'): HoldingRow[] {
  const open = journalSummary(ENTRIES).open;
  return open.map((pos) => withTradeLock(holdingRow(pos, 'hats', pos.sku === A ? side(600) : null, P, KEY), pos.lots, mode, NOW));
}

describe('holdingsValuationOf', () => {
  it("reads Worth now's exits, the totals, the unpriced items and the locked ones from one holdings read", () => {
    const r = rows('7d');
    const res = holdingsResult(r, {}, keyPrice(KEY), NOW);
    const v = holdingsValuationOf(res);
    const a = r.find((x) => x.sku === A)!;
    expect(a.exitScrap).toBe(600);
    expect(v).toEqual({
      at: NOW,
      keyScrap: KEY,
      worthNowScrap: 1200,
      profitNowScrap: a.profitAllScrap!,
      costScrap: res.totals.costScrap,
      items: 2,
      units: 3,
      unpricedItems: 1,
      unpricedUnits: 1,
      lockedItems: 1,
      exitBySku: { [A]: 600, [B]: null },
    } satisfies HoldingsValuation);
    expect(v.worthNowScrap).toBe(res.totals.worthNowScrap);
    expect(v.profitNowScrap).toBe(res.totals.profitNowScrap);
    // Without a lock, nothing is locked.
    expect(holdingsValuationOf(holdingsResult(rows(), {}, keyPrice(KEY), NOW)).lockedItems).toBe(0);
  });

  it("falls back to the buyer's revenue when a row has no better exit, and has no key price without a positive one", () => {
    const r = rows().map((x) => (x.sku === A ? { ...x, exitScrap: null } : x));
    expect(holdingsValuationOf(holdingsResult(r, {}, keyPrice(KEY), NOW)).exitBySku[A]).toBe(600);
    expect(holdingsValuationOf(holdingsResult(rows(), {}, null, NOW)).keyScrap).toBeNull();
    expect(holdingsValuationOf(holdingsResult(rows(), {}, keyPrice(0), NOW)).keyScrap).toBeNull();
  });

  it('needs an unfiltered read: a searched one keeps the totals over everything but has no exit for the rows left out', () => {
    const r = rows();
    const searched = holdingsResult(r, { search: 'nothing matches this' }, keyPrice(KEY), NOW);
    expect(searched.rows).toEqual([]);
    const v = holdingsValuationOf(searched);
    expect(v.items).toBe(2);
    expect(v.exitBySku).toEqual({});
  });
});

describe('lotValueOf and journalValuerOf', () => {
  const r = rows();
  const v = holdingsValuationOf(holdingsResult(r, {}, keyPrice(KEY), NOW));
  const open = journalSummary(ENTRIES).open;

  it("sums a SKU's lots to the row's profitAllScrap and worth to exit × qty, exactly, with friction and a key lot at a moved key", () => {
    const a = r.find((x) => x.sku === A)!;
    const lots = open.find((p) => p.sku === A)!.lots;
    expect(lots.map((l) => [l.keys, l.scrap, l.keyPriceScrap])).toEqual([
      [0, 110, 540],
      [1, 7, 540],
    ]);
    const values = lots.map((l) => lotValueOf(l, A, v, P));
    // Metal lot: 600 - 110 - 2; key lot at today's key (567 + 7), not the 540 it was bought at: 600 - 574 - 2.
    expect(values).toEqual([
      { worthScrap: 600, unrealisedScrap: 488 },
      { worthScrap: 600, unrealisedScrap: 24 },
    ]);
    expect(lotCostAt(lots[1]!, KEY)).toBe(574);
    expect(values.reduce((t, x) => t + x.unrealisedScrap!, 0)).toBe(a.profitAllScrap);
    expect(values.reduce((t, x) => t + x.worthScrap!, 0)).toBe(a.exitScrap! * a.qty);
  });

  it('is null for a SKU with no exit, one not in the read, or a name on the object prototype', () => {
    const lot = open.find((p) => p.sku === B)!.lots[0]!;
    expect(lotValueOf(lot, B, v, P)).toEqual({ worthScrap: null, unrealisedScrap: null });
    expect(lotValueOf(lot, '5021;6', v, P)).toEqual({ worthScrap: null, unrealisedScrap: null });
    for (const sku of ['constructor', '__proto__', 'toString']) expect(lotValueOf(lot, sku, v, P)).toEqual({ worthScrap: null, unrealisedScrap: null });
  });

  it("the valuer is dated at the read and values each lot with lotValueOf", () => {
    const valuer = journalValuerOf(v, P);
    expect(valuer.at).toBe(NOW);
    const lot = open.find((p) => p.sku === A)!.lots[0]!;
    expect(valuer.valueOf(lot, A)).toEqual(lotValueOf(lot, A, v, P));
  });
});

describe('the ledger with a valuer (0.9)', () => {
  const v = holdingsValuationOf(holdingsResult(rows(), {}, keyPrice(KEY), NOW));
  const valuer = journalValuerOf(v, P);

  it("gives value only to open buys, dated at the read", () => {
    const ledger = journalLedger(ENTRIES, valuer);
    const byId = new Map(ledger.map((x) => [x.entry.id, x]));
    const [closedBuy, sale, metalBuy, keyBuy, hat] = ENTRIES.map((e) => byId.get(e.id)!);
    expect([closedBuy, sale, metalBuy, keyBuy, hat].map((x) => x!.fifo)).toEqual(['closed', 'closed', 'open', 'open', 'open']);
    expect('value' in closedBuy!).toBe(false);
    expect('value' in sale!).toBe(false);
    expect(metalBuy!.value).toEqual({ worthScrap: 600, unrealisedScrap: 488, at: NOW });
    expect(keyBuy!.value).toEqual({ worthScrap: 600, unrealisedScrap: 24, at: NOW });
    expect(hat!.value).toEqual({ worthScrap: null, unrealisedScrap: null, at: NOW });
    // Waiting sales and write-offs carry none either.
    const waiting = journalLedger([entry('sell', '5021;6', NOW - DAY, 0, 9)], valuer);
    expect(waiting[0]!.fifo).toBe('waiting');
    expect('value' in waiting[0]!).toBe(false);
  });

  it('without a valuer adds no value key, so 0.8 ledger rows are unchanged', () => {
    for (const row of journalLedger(ENTRIES)) expect('value' in row).toBe(false);
    expect(journalLedger(ENTRIES, null)).toEqual(journalLedger(ENTRIES));
  });

  it('writes the three appended CSV cells from the value, blank without one', () => {
    expect(JOURNAL_CSV_COLUMNS).toHaveLength(23);
    expect(JOURNAL_CSV_COLUMNS.slice(-3)).toEqual(['worth_now_ref', 'unrealised_ref', 'valued_at']);
    const valued = journalLedger(ENTRIES, valuer);
    const cells = (id: number) => journalCsvCells(valued.find((x) => x.entry.id === id)!);
    expect(cells(ENTRIES[2]!.id).slice(-3)).toEqual([scrapToRef(600), scrapToRef(488), new Date(NOW).toISOString()]);
    expect(cells(ENTRIES[4]!.id).slice(-3)).toEqual([null, null, new Date(NOW).toISOString()]);
    expect(cells(ENTRIES[1]!.id).slice(-3)).toEqual([null, null, '']);
    for (const row of journalLedger(ENTRIES)) {
      const c = journalCsvCells(row);
      expect(c).toHaveLength(JOURNAL_CSV_COLUMNS.length);
      expect(c.slice(-3)).toEqual([null, null, '']);
    }
  });
});
