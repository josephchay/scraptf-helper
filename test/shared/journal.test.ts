// 0.8 (J1, J2, J5, H5, write-offs): the journal's shared rules. FIFO moved here from service/domain/journal.ts
// (test/domain/journal.test.ts still covers 0.7.4's FIFO cases through the service's re-export); these cases pin
// the closed ledger, fees, write-offs, the typical hold and the ledger CSV cells.

import { describe, expect, it } from 'vitest';
import { valueScrap } from '../../src/shared/currency';
import {
  JOURNAL_CSV_COLUMNS,
  JOURNAL_FALLBACK_KEY_SCRAP,
  TYPICAL_HOLD_MIN_ALL,
  TYPICAL_HOLD_MIN_ITEM,
  applyJournalPatch,
  closedTradesOf,
  feeOf,
  feePatchOf,
  journalCsvCells,
  journalLedger,
  journalOrder,
  journalSummary,
  journalValue,
  medianOf,
  typicalHold,
  typicalHoldOf,
  withTypicalHold,
} from '../../src/shared/journal';
import type { JournalClosedTrade, JournalEntry, JournalSummary } from '../../src/shared/types';
import { DEFAULT_KEY_SCRAP } from '../../src/service/domain/keyprice';
import * as serviceJournal from '../../src/service/domain/journal';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let seq = 0;
function row(side: JournalEntry['side'], sku: string, scrap: number, over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  return { id: seq, ts: T0 + seq * 1000, side, venue: side === 'buy' ? 'scrap.tf' : 'backpack.tf', sku, name: `Item ${sku}`, keys: 0, scrap, keyPriceScrap: 567, note: null, ...over };
}

/** The ledger's own invariants: the pairs add up to what was booked, each pair to itself. */
function expectBooksBalance(s: JournalSummary): void {
  expect(s.closed.reduce((t, c) => t + c.profitScrap, 0)).toBe(s.realizedProfitScrap);
  expect(s.closed.length).toBe(s.realizedTrades);
  expect(s.bySku.reduce((t, b) => t + b.trades, 0)).toBe(s.realizedTrades);
  expect(s.bySku.reduce((t, b) => t + b.realizedProfitScrap, 0)).toBe(s.realizedProfitScrap);
  for (const c of s.closed) {
    if (c.kind === 'writeoff') {
      expect(c.proceedsScrap).toBe(0);
      expect(c.profitScrap).toBe(-c.costScrap);
    } else expect(c.proceedsScrap).toBe(c.profitScrap + c.costScrap);
    expect(c.heldMs).toBe(Math.max(0, c.soldAt - c.boughtAt));
  }
  // Oldest sale first.
  for (let i = 1; i < s.closed.length; i++) expect(s.closed[i]!.soldAt).toBeGreaterThanOrEqual(s.closed[i - 1]!.soldAt);
}

describe('the service re-exports the shared FIFO (one function)', () => {
  it('is the same function, and the fallback key price is the service default', () => {
    expect(serviceJournal.journalSummary).toBe(journalSummary);
    expect(serviceJournal.journalOrder).toBe(journalOrder);
    expect(serviceJournal.journalValue).toBe(journalValue);
    expect(JOURNAL_FALLBACK_KEY_SCRAP).toBe(DEFAULT_KEY_SCRAP);
    expect(journalValue({ keys: 1, scrap: 0, keyPriceScrap: Number.NaN })).toBe(DEFAULT_KEY_SCRAP);
  });
});

describe('the closed ledger (J1)', () => {
  it('records each pair with both ids, times, venues, the hold and the kind', () => {
    const buy = row('buy', 'A', 90, { venue: ' Scrap.TF ' });
    const sell = row('sell', 'A', 108, { ts: buy.ts + 3 * HOUR, venue: 'bp.tf' });
    const s = journalSummary([sell, buy]);
    expect(s.closed).toEqual([
      {
        sellId: sell.id,
        buyId: buy.id,
        kind: 'sell',
        sku: 'A',
        name: 'Item A',
        boughtAt: buy.ts,
        soldAt: sell.ts,
        heldMs: 3 * HOUR,
        // As typed: stored text is never rewritten (venueLabel groups them for reports).
        buyVenue: ' Scrap.TF ',
        sellVenue: 'bp.tf',
        costScrap: 90,
        proceedsScrap: 108,
        feesScrap: null,
        feesKnown: false,
        profitScrap: 18,
        keyPriceScrap: 567,
      },
    ]);
  });

  it('balances over the mixed-currency, backfill key price and cascade fixtures', () => {
    // Mixed currencies at the sell row's key price, and a backfilled buy logged after its sale.
    const v = row('sell', 'V', 9, { keys: 3, keyPriceScrap: 600 });
    const mixed = journalSummary([
      row('buy', 'U', 0, { keys: 2, keyPriceScrap: 500 }),
      row('sell', 'U', 600, { keys: 1, keyPriceScrap: 580 }),
      v,
      row('buy', 'V', 0, { keys: 3, keyPriceScrap: 500, ts: v.ts - MIN }),
    ]);
    expect(mixed.realizedProfitScrap).toBe(20 + 9);
    expectBooksBalance(mixed);
    // A row without a key price borrows the previous one.
    const backfill = journalSummary([row('buy', 'U', 0, { keys: 1, keyPriceScrap: 560 }), row('sell', 'U', 0, { keys: 1, keyPriceScrap: 0 })]);
    expect(backfill.realizedProfitScrap).toBe(0);
    expect(backfill.closed[0]).toMatchObject({ costScrap: 560, proceedsScrap: 560, keyPriceScrap: 560 });
    expectBooksBalance(backfill);
    // The cascade: an old sale waits and never shifts later flips.
    const s0 = row('sell', 'K', 250, { keys: 1 });
    const b1 = row('buy', 'K', 90, { keys: 1 });
    const s1 = row('sell', 'K', 250, { keys: 1 });
    const b2 = row('buy', 'K', 90, { keys: 1 });
    const s2 = row('sell', 'K', 250, { keys: 1 });
    const b3 = row('buy', 'K', 90, { keys: 1 });
    const cascade = journalSummary([s0, b1, s1, b2, s2, b3]);
    expect(cascade.closed.map((c) => [c.buyId, c.sellId])).toEqual([
      [b1.id, s1.id],
      [b2.id, s2.id],
    ]);
    expectBooksBalance(cascade);
    // Everything at once, with fees and write-offs mixed in.
    const all = journalSummary([
      row('buy', 'X', 100, { feeScrap: 3 }),
      row('buy', 'X', 0, { keys: 0.5, keyPriceScrap: 561, feeKeys: 0.01 }),
      row('sell', 'X', 120, { feeScrap: 0 }),
      row('writeoff', 'X', 0, { keyPriceScrap: 571 }),
      row('sell', 'Y', 50),
      row('buy', 'Y', 40, { feeKeys: 0, feeScrap: 0 }),
      row('sell', 'Y', 45, { keys: 1, keyPriceScrap: 575, feeKeys: 0.1 }),
    ]);
    expect(all.closed.map((c) => c.kind)).toEqual(['sell', 'writeoff', 'sell']);
    expectBooksBalance(all);
  });

  it('keeps a waiting sale out of the ledger, and books a same-ts pair with a 0 hold', () => {
    const early = row('sell', 'W', 30);
    const later = row('buy', 'W', 20);
    const s = journalSummary([early, later]);
    expect(s.closed).toEqual([]);
    expect(s.waitingSales.map((w) => w.id)).toEqual([early.id]);
    // A sale recorded first at its buy's own minute.
    const sale = row('sell', 'Z', 30, { ts: T0 });
    const buy = row('buy', 'Z', 20, { ts: T0 });
    const z = journalSummary([sale, buy]);
    expect(z.closed).toEqual([expect.objectContaining({ sellId: sale.id, buyId: buy.id, heldMs: 0, profitScrap: 10 })]);
  });
});

describe('fees (J2)', () => {
  it("adds a buy's fee to the lot's cost basis, keys and metal apart", () => {
    const buy = row('buy', 'F', 90, { keys: 1, keyPriceScrap: 540, feeKeys: 0.02, feeScrap: 2 });
    const s = journalSummary([buy]);
    expect(s.open).toEqual([
      {
        sku: 'F',
        name: 'Item F',
        qty: 1,
        costScrap: valueScrap(1.02, 92, 540),
        lots: [{ id: buy.id, ts: buy.ts, costScrap: valueScrap(1.02, 92, 540), keys: 1.02, scrap: 92, keyPriceScrap: 540 }],
      },
    ]);
    // Closed, the same cost basis is the pair's cost.
    const sold = journalSummary([buy, row('sell', 'F', 120, { keys: 1, keyPriceScrap: 540 })]);
    expect(sold.closed[0]).toMatchObject({ costScrap: valueScrap(1.02, 92, 540), feesScrap: valueScrap(0.02, 2, 540), feesKnown: false });
    expect(sold.realizedProfitScrap).toBe(valueScrap(1 - 1.02, 120 - 92, 540));
  });

  it("takes a sale's fee off its proceeds", () => {
    const plain = journalSummary([row('buy', 'G', 90), row('sell', 'G', 108)]);
    const fee = journalSummary([row('buy', 'G', 90), row('sell', 'G', 108, { feeScrap: 5 })]);
    expect(plain.realizedProfitScrap).toBe(18);
    expect(fee.realizedProfitScrap).toBe(13);
    expect(fee.closed[0]).toMatchObject({ costScrap: 90, proceedsScrap: 103, feesScrap: 5, profitScrap: 13 });
  });

  it("values a fee in keys at the sale's key price", () => {
    const s = journalSummary([
      row('buy', 'H', 0, { keys: 1, keyPriceScrap: 500, feeKeys: 0, feeScrap: 0 }),
      row('sell', 'H', 0, { keys: 1, keyPriceScrap: 600, feeKeys: 0.1 }),
    ]);
    // 0.1 key at 600: the fee is 60 and the pair loses exactly that.
    expect(s.closed[0]).toMatchObject({ costScrap: 600, feesScrap: 60, profitScrap: -60, proceedsScrap: 540, feesKnown: true, keyPriceScrap: 600 });
  });

  it('feesScrap is null with neither fee recorded; feesKnown needs both, and a recorded 0 is known', () => {
    const pair = (buyFee: Partial<JournalEntry>, sellFee: Partial<JournalEntry>): JournalClosedTrade =>
      journalSummary([row('buy', 'P', 90, buyFee), row('sell', 'P', 108, sellFee)]).closed[0]!;
    expect(pair({}, {})).toMatchObject({ feesScrap: null, feesKnown: false });
    expect(pair({ feeScrap: 1 }, {})).toMatchObject({ feesScrap: 1, feesKnown: false });
    expect(pair({}, { feeScrap: 2 })).toMatchObject({ feesScrap: 2, feesKnown: false });
    expect(pair({ feeKeys: 0, feeScrap: 0 }, { feeKeys: 0, feeScrap: 0 })).toMatchObject({ feesScrap: 0, feesKnown: true, profitScrap: 18 });
    expect(pair({ feeScrap: 1 }, { feeScrap: 2 })).toMatchObject({ feesScrap: 3, feesKnown: true, profitScrap: 15 });
  });

  it("keeps a waiting sale's price as typed, fee aside", () => {
    const sale = row('sell', 'Q', 50, { keys: 1, feeScrap: 4 });
    expect(journalSummary([sale]).waitingSales).toEqual([{ id: sale.id, ts: sale.ts, sku: 'Q', name: 'Item Q', keys: 1, scrap: 50 }]);
  });
});

describe('write-offs', () => {
  it("closes the oldest lot at or before it and books exactly that lot's value as a loss, at its own key price", () => {
    const first = row('buy', 'R', 3, { keys: 0.5, keyPriceScrap: 561 });
    const second = row('buy', 'R', 9);
    const off = row('writeoff', 'R', 0, { keyPriceScrap: 567, venue: 'Written off' });
    const after = row('buy', 'R', 12);
    const s = journalSummary([after, off, second, first]);
    // Half a key at the write-off's (odd) key price: Math.round(283.5) + 3.
    const loss = valueScrap(0.5, 3, 567);
    expect(loss).toBe(287);
    expect(s.closed).toEqual([
      {
        sellId: off.id,
        buyId: first.id,
        kind: 'writeoff',
        sku: 'R',
        name: 'Item R',
        boughtAt: first.ts,
        soldAt: off.ts,
        heldMs: off.ts - first.ts,
        buyVenue: 'scrap.tf',
        sellVenue: 'Written off',
        costScrap: loss,
        proceedsScrap: 0,
        feesScrap: null,
        // A write-off has no fee to record; the buy recorded none.
        feesKnown: false,
        profitScrap: -loss,
        keyPriceScrap: 567,
      },
    ]);
    expect(s.realizedProfitScrap).toBe(-loss);
    expect(s.realizedTrades).toBe(1);
    expect(s.bySku).toEqual([{ sku: 'R', name: 'Item R', realizedProfitScrap: -loss, trades: 1 }]);
    expect(s.open[0]!.lots.map((l) => l.id)).toEqual([second.id, after.id]);
    expectBooksBalance(s);
  });

  it("is known on fees when its buy recorded one, and books the buy's fee as part of the loss", () => {
    const s = journalSummary([row('buy', 'S', 20, { feeKeys: 0, feeScrap: 1 }), row('writeoff', 'S', 0)]);
    expect(s.closed[0]).toMatchObject({ costScrap: 21, profitScrap: -21, proceedsScrap: 0, feesScrap: 1, feesKnown: true });
  });

  it('receives nothing whatever a junk row carries', () => {
    const s = journalSummary([row('buy', 'J', 20), row('writeoff', 'J', 99, { keys: 2, feeKeys: 1, feeScrap: 5 })]);
    expect(s.closed[0]).toMatchObject({ costScrap: 20, profitScrap: -20, proceedsScrap: 0, feesScrap: null });
  });

  it('waits with no lot before it, and never consumes a later buy', () => {
    const off = row('writeoff', 'N', 0);
    const buy = row('buy', 'N', 30);
    const s = journalSummary([off, buy]);
    expect(s.waitingSales).toEqual([{ id: off.id, ts: off.ts, sku: 'N', name: 'Item N', keys: 0, scrap: 0, writeoff: true }]);
    expect(s.closed).toEqual([]);
    expect(s.realizedTrades).toBe(0);
    expect(s.open.map((p) => p.lots.map((l) => l.id))).toEqual([[buy.id]]);
    // A plain waiting sale carries no writeoff key.
    expect(journalSummary([row('sell', 'N', 5)]).waitingSales[0]).not.toHaveProperty('writeoff');
  });

  it("closes a buy dated exactly at it (it ranks with the sale), and a 'hold' row is still skipped", () => {
    const off = row('writeoff', 'M', 0, { ts: T0 });
    const buy = row('buy', 'M', 10, { ts: T0 });
    expect(journalOrder(off, buy)).toBeGreaterThan(0);
    const s = journalSummary([off, buy]);
    expect(s.closed).toEqual([expect.objectContaining({ kind: 'writeoff', sellId: off.id, buyId: buy.id, heldMs: 0, profitScrap: -10 })]);
    const junk = journalSummary([row('buy', 'M', 10), { ...row('sell', 'M', 20), side: 'hold' as 'sell' }]);
    expect(junk.closed).toEqual([]);
    expect(junk.open).toHaveLength(1);
  });
});

/** A closed sale (or write-off) for the typical-hold cases; only sku, kind and heldMs matter there. */
function ct(sku: string, heldMs: number, kind: JournalClosedTrade['kind'] = 'sell', soldAt = T0, sellId = 0): JournalClosedTrade {
  return {
    sellId,
    buyId: 0,
    kind,
    sku,
    name: sku,
    boughtAt: soldAt - heldMs,
    soldAt,
    heldMs,
    buyVenue: 'scrap.tf',
    sellVenue: 'backpack.tf',
    costScrap: 10,
    proceedsScrap: 12,
    feesScrap: null,
    feesKnown: false,
    profitScrap: 2,
    keyPriceScrap: 567,
  };
}

describe('the typical hold (H5)', () => {
  it('medianOf: the middle value, an even count averaged and rounded, null when empty', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([Number.NaN])).toBeNull();
    expect(medianOf([30, 10, 20])).toBe(20);
    expect(medianOf([1, 2, 3, 10])).toBe(3);
    expect(medianOf([4, Number.POSITIVE_INFINITY, 2])).toBe(3);
  });

  it("gives the item's own median at 3 sales, every sale's at 5, else nothing", () => {
    expect(TYPICAL_HOLD_MIN_ITEM).toBe(3);
    expect(TYPICAL_HOLD_MIN_ALL).toBe(5);
    const two = [ct('A', 10 * HOUR), ct('A', 20 * HOUR)];
    expect(typicalHold(two, [], 'A')).toBeNull();
    const three = [...two, ct('A', 40 * HOUR)];
    expect(typicalHold(three, [], 'A')).toEqual({ medianMs: 20 * HOUR, count: 3, scope: 'item', stillHeld: 0 });
    // 4 sales in all: B has too few of its own and the whole journal too few as well.
    expect(typicalHold([...three, ct('B', HOUR)], [], 'B')).toBeNull();
    const five = [...three, ct('B', HOUR), ct('B', 2 * HOUR)];
    expect(typicalHold(five, [], 'B')).toEqual({ medianMs: 10 * HOUR, count: 5, scope: 'all', stillHeld: 0 });
    // A SKU never sold gets the journal's too.
    expect(typicalHold(five, [], 'C')).toMatchObject({ scope: 'all', count: 5 });
    // A keeps its own.
    expect(typicalHold(five, [], 'A')).toMatchObject({ scope: 'item', count: 3 });
  });

  it('leaves write-offs out of every hold', () => {
    const closed = [ct('A', HOUR), ct('A', 2 * HOUR), ct('A', 3 * HOUR), ct('A', 100 * DAY, 'writeoff'), ct('B', HOUR, 'writeoff')];
    expect(typicalHold(closed, [], 'A')).toEqual({ medianMs: 2 * HOUR, count: 3, scope: 'item', stillHeld: 0 });
    // 3 sales and 2 write-offs are not 5 sales.
    expect(typicalHold(closed, [], 'B')).toBeNull();
  });

  it("rounds an even count's median", () => {
    const closed = [ct('A', 1), ct('A', 2), ct('A', 3), ct('A', 10)];
    expect(typicalHold(closed, [], 'A')).toMatchObject({ medianMs: 3, count: 4 });
  });

  it('matches the SKU exactly (paint kept, as FIFO)', () => {
    const closed = [ct('5021;6', HOUR), ct('5021;6', HOUR), ct('5021;6', HOUR)];
    expect(typicalHold(closed, [], '5021;6')).toMatchObject({ scope: 'item' });
    expect(typicalHold(closed, [], '5021;6;p3100495')).toBeNull();
  });

  it("counts the SKU's open units for 'item' and every open unit for 'all'", () => {
    const closed = [ct('A', HOUR), ct('A', HOUR), ct('A', HOUR), ct('B', HOUR), ct('B', HOUR)];
    const open = [
      { sku: 'A', qty: 2 },
      { sku: 'B', qty: 1 },
      { sku: 'C', qty: 4 },
    ];
    const hold = typicalHoldOf(closed, open);
    expect(hold('A')).toMatchObject({ scope: 'item', stillHeld: 2 });
    expect(hold('B')).toMatchObject({ scope: 'all', stillHeld: 7 });
    expect(hold('C')).toMatchObject({ scope: 'all', stillHeld: 7 });
  });

  it('reads the closed pairs journalSummary books', () => {
    const rows: JournalEntry[] = [];
    for (let i = 0; i < 3; i++) {
      const b = row('buy', 'T', 10, { ts: T0 + i * DAY });
      rows.push(b, row('sell', 'T', 12, { ts: b.ts + (i + 1) * HOUR }));
    }
    rows.push(row('buy', 'T', 10, { ts: T0 + 10 * DAY }));
    const s = journalSummary(rows);
    expect(typicalHoldOf(s.closed, s.open)('T')).toEqual({ medianMs: 2 * HOUR, count: 3, scope: 'item', stillHeld: 1 });
  });
});

describe('helpers', () => {
  it('withTypicalHold adds the key only when the lookup gives one', () => {
    const r = { sku: 'A', qty: 1 };
    expect(withTypicalHold(r, () => null)).toBe(r);
    expect(withTypicalHold(r, () => null)).not.toHaveProperty('typicalHold');
    const t = { medianMs: HOUR, count: 3, scope: 'item' as const, stillHeld: 0 };
    expect(withTypicalHold(r, (sku) => (sku === 'A' ? t : null))).toEqual({ sku: 'A', qty: 1, typicalHold: t });
    expect(r).not.toHaveProperty('typicalHold');
  });

  it('closedTradesOf: one exact SKU, newest sale first', () => {
    const closed = [ct('A', 1, 'sell', T0, 1), ct('A;p1', 1, 'sell', T0 + 1, 2), ct('A', 1, 'writeoff', T0 + 2, 3), ct('A', 1, 'sell', T0 + 2, 4)];
    expect(closedTradesOf(closed, 'A').map((c) => c.sellId)).toEqual([4, 3, 1]);
    expect(closedTradesOf(closed, 'B')).toEqual([]);
  });

  it('feeOf: null when nothing was recorded, else both parts (unreadable or negative parts read 0)', () => {
    expect(feeOf(null)).toBeNull();
    expect(feeOf(undefined)).toBeNull();
    expect(feeOf({})).toBeNull();
    expect(feeOf({ feeKeys: Number.NaN })).toBeNull();
    expect(feeOf({ feeKeys: 0 })).toEqual({ keys: 0, scrap: 0 });
    expect(feeOf({ feeScrap: 3 })).toEqual({ keys: 0, scrap: 3 });
    expect(feeOf({ feeKeys: 0.5, feeScrap: 2.4 })).toEqual({ keys: 0.5, scrap: 2 });
    expect(feeOf({ feeKeys: Number.NaN, feeScrap: 3 })).toEqual({ keys: 0, scrap: 3 });
    expect(feeOf({ feeKeys: -1, feeScrap: -5 })).toEqual({ keys: 0, scrap: 0 });
  });

  it('feePatchOf: absent leaves it, null clears it, a number sets both', () => {
    expect(feePatchOf({})).toBeUndefined();
    expect(feePatchOf({ feeKeys: null })).toBeNull();
    expect(feePatchOf({ feeKeys: null, feeScrap: null })).toBeNull();
    expect(feePatchOf({ feeScrap: 4 })).toEqual({ keys: 0, scrap: 4 });
    expect(feePatchOf({ feeKeys: 1, feeScrap: null })).toEqual({ keys: 1, scrap: 0 });
    expect(feePatchOf({ feeScrap: 2.6 })).toEqual({ keys: 0, scrap: 3 });
  });

  it('applyJournalPatch: venue, note and fee only, without touching the row it was given', () => {
    const e = row('sell', 'A', 20, { feeKeys: 0, feeScrap: 2, note: 'old' });
    const before = { ...e };
    expect(applyJournalPatch(e, {})).toEqual(e);
    expect(applyJournalPatch(e, { venue: 'mp.tf', note: null })).toEqual({ ...e, venue: 'mp.tf', note: null });
    expect(applyJournalPatch(e, { feeScrap: 5 })).toEqual({ ...e, feeKeys: 0, feeScrap: 5 });
    const cleared = applyJournalPatch(e, { feeKeys: null, feeScrap: null });
    expect(cleared).not.toHaveProperty('feeKeys');
    expect(cleared).not.toHaveProperty('feeScrap');
    expect(e).toEqual(before);
  });
});

describe('the ledger CSV (J5)', () => {
  it('lists every row in FIFO order with its state: a same-ts buy before the sale it closes', () => {
    const sale = row('sell', 'L', 30, { ts: T0 });
    const buy = row('buy', 'L', 20, { ts: T0 });
    const open = row('buy', 'L', 25, { ts: T0 + MIN });
    const waiting = row('sell', 'O', 9, { ts: T0 - MIN });
    const off = row('writeoff', 'O2', 0, { ts: T0 + 2 * MIN });
    const junk = { ...row('buy', 'L', 1, { ts: T0 + 3 * MIN }), side: 'hold' as 'buy' };
    const noSku = row('buy', '', 1, { ts: T0 + 4 * MIN });
    const ledger = journalLedger([sale, junk, open, off, buy, waiting, noSku]);
    expect(ledger.map((r) => [r.entry.id, r.fifo])).toEqual([
      [waiting.id, 'waiting'],
      [buy.id, 'closed'],
      [sale.id, 'closed'],
      [open.id, 'open'],
      [off.id, 'waiting'],
      [junk.id, null],
      [noSku.id, null],
    ]);
    // Only the sale carries its pair.
    expect(ledger.find((r) => r.entry.id === sale.id)!.closed).toEqual(journalSummary([sale, buy]).closed[0]);
    expect(ledger.find((r) => r.entry.id === buy.id)!.closed).toBeNull();
    expect(journalLedger([])).toEqual([]);
  });

  it('writes the 0.7.4 cells, then the fee, the FIFO state and the pair', () => {
    expect(JOURNAL_CSV_COLUMNS).toHaveLength(20);
    expect(JOURNAL_CSV_COLUMNS.slice(0, 11)).toEqual(['id', 'time', 'side', 'venue', 'sku', 'name', 'keys', 'metal_ref', 'key_price_ref', 'value_ref', 'note']);
    const buy = row('buy', 'C', 12, { ts: T0, feeKeys: 0.01, feeScrap: 1 });
    const sale = row('sell', 'C', 3, { ts: T0 + 1.5 * DAY, keys: 1, note: 'sold' });
    const [b, s] = journalLedger([buy, sale]);
    expect(journalCsvCells(b!)).toEqual([buy.id, new Date(T0).toISOString(), 'buy', 'scrap.tf', 'C', 'Item C', 0, 1.33, 63, 1.33, null, 0.01, 0.11, 'closed', null, null, null, null, null, null]);
    // Cost 12 + 1 + 0.01 key (6 at 567); proceeds 1 key + 3.
    expect(journalCsvCells(s!)).toEqual([sale.id, new Date(T0 + 1.5 * DAY).toISOString(), 'sell', 'backpack.tf', 'C', 'Item C', 1, 0.33, 63, 63.33, 'sold', null, null, 'closed', buy.id, 2.11, 63.33, 0.77, 61.22, 1.5]);
    expect(journalCsvCells(s!)).toHaveLength(JOURNAL_CSV_COLUMNS.length);
  });

  it("blanks the time of an unreadable ts and the state of a row FIFO skips", () => {
    const junk = { ...row('buy', 'C', 9), ts: Number.NaN, side: 'hold' as 'buy' };
    const cells = journalCsvCells(journalLedger([junk])[0]!);
    expect(cells[1]).toBe('');
    expect(cells.slice(11)).toEqual([null, null, '', null, null, null, null, null, null]);
  });
});
