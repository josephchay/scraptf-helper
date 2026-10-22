import { describe, expect, it } from 'vitest';
import type { JournalEntry } from '../../src/shared/types';
import { journalSummary, journalValue } from '../../src/service/domain/journal';
import { T0 } from './helpers';

let seq = 0;
function row(side: JournalEntry['side'], sku: string, scrap: number, over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  return { id: seq, ts: T0 + seq * 1000, side, venue: side === 'buy' ? 'scrap.tf' : 'backpack.tf', sku, name: `Item ${sku}`, keys: 0, scrap, keyPriceScrap: 567, note: null, ...over };
}

describe('journalSummary (FIFO)', () => {
  it('realises profit when a sell closes a buy', () => {
    const buy = row('buy', 'A', 90);
    const sell = row('sell', 'A', 108);
    const s = journalSummary([buy, sell]);
    expect(s).toEqual({
      realizedProfitScrap: 18,
      realizedTrades: 1,
      open: [],
      bySku: [{ sku: 'A', name: 'Item A', realizedProfitScrap: 18, trades: 1 }],
      waitingSales: [],
      // 0.8 (J1): the pair as booked.
      closed: [
        {
          sellId: sell.id,
          buyId: buy.id,
          kind: 'sell',
          sku: 'A',
          name: 'Item A',
          boughtAt: buy.ts,
          soldAt: sell.ts,
          heldMs: 1000,
          buyVenue: 'scrap.tf',
          sellVenue: 'backpack.tf',
          costScrap: 90,
          proceedsScrap: 108,
          feesScrap: null,
          feesKnown: false,
          profitScrap: 18,
          keyPriceScrap: 567,
        },
      ],
    });
  });

  it('matches sells to the oldest buy first', () => {
    const left = row('buy', 'A', 12);
    const s = journalSummary([row('buy', 'A', 10, { ts: left.ts - 500 }), left, row('sell', 'A', 15)]);
    expect(s.realizedProfitScrap).toBe(5);
    expect(s.open).toEqual([{ sku: 'A', name: 'Item A', qty: 1, costScrap: 12, lots: [{ id: left.id, ts: left.ts, costScrap: 12, keys: 0, scrap: 12, keyPriceScrap: 567 }] }]);
  });

  it('handles partially closed positions across several SKUs', () => {
    const s = journalSummary([
      row('buy', 'A', 10),
      row('buy', 'B', 50),
      row('buy', 'A', 11),
      row('buy', 'A', 12),
      row('sell', 'A', 20),
      row('sell', 'B', 40),
      row('sell', 'A', 20),
    ]);
    expect(s.realizedTrades).toBe(3);
    expect(s.realizedProfitScrap).toBe(10 + -10 + 9);
    expect(s.open).toEqual([{ sku: 'A', name: 'Item A', qty: 1, costScrap: 12, lots: [expect.objectContaining({ costScrap: 12 })] }]);
    expect(s.bySku).toEqual([
      { sku: 'A', name: 'Item A', realizedProfitScrap: 19, trades: 2 },
      { sku: 'B', name: 'Item B', realizedProfitScrap: -10, trades: 1 },
    ]);
  });

  it('nets keys and metal per pair and values the difference at the sell row key price', () => {
    const s = journalSummary([
      row('buy', 'U', 0, { keys: 10, keyPriceScrap: 500 }),
      row('sell', 'U', 9, { keys: 10, keyPriceScrap: 520 }),
    ]);
    // The flip made 9 scrap; the key's move from 500 to 520 is not trading profit.
    expect(s.realizedProfitScrap).toBe(9);
    expect(journalValue({ keys: 1.5, scrap: 3, keyPriceScrap: 600 })).toBe(903);
  });

  it('reports 0 for a break-even key flip whichever way the key price moved', () => {
    const up = journalSummary([row('buy', 'U', 0, { keys: 20, keyPriceScrap: 560 }), row('sell', 'U', 0, { keys: 20, keyPriceScrap: 600 })]);
    expect(up.realizedProfitScrap).toBe(0);
    expect(up.bySku).toEqual([{ sku: 'U', name: 'Item U', realizedProfitScrap: 0, trades: 1 }]);
    const down = journalSummary([row('buy', 'U', 0, { keys: 20, keyPriceScrap: 600 }), row('sell', 'U', 0, { keys: 20, keyPriceScrap: 560 })]);
    expect(down.realizedProfitScrap).toBe(0);
  });

  it('values a mixed-currency pair at the sell row key price', () => {
    // Bought for 2 keys, sold for 1 key + 600 scrap when a key was worth 580: 600 - 580 = 20.
    const s = journalSummary([row('buy', 'U', 0, { keys: 2, keyPriceScrap: 500 }), row('sell', 'U', 600, { keys: 1, keyPriceScrap: 580 })]);
    expect(s.realizedProfitScrap).toBe(20);
    // A buy logged after its sale but dated before it (a backfill) also pairs at the sell's key price.
    const sell = row('sell', 'V', 9, { keys: 3, keyPriceScrap: 600 });
    const early = journalSummary([sell, row('buy', 'V', 0, { keys: 3, keyPriceScrap: 500, ts: sell.ts - 60_000 })]);
    expect(early.realizedProfitScrap).toBe(9);
  });

  it('keeps open positions at their buy-time value', () => {
    const u = row('buy', 'U', 5, { keys: 2, keyPriceScrap: 500 });
    const w = row('buy', 'W', 0, { keys: 1, keyPriceScrap: 600 });
    const s = journalSummary([u, w]);
    expect(s.open).toEqual([
      { sku: 'U', name: 'Item U', qty: 1, costScrap: 1005, lots: [{ id: u.id, ts: u.ts, costScrap: 1005, keys: 2, scrap: 5, keyPriceScrap: 500 }] },
      { sku: 'W', name: 'Item W', qty: 1, costScrap: 600, lots: [{ id: w.id, ts: w.ts, costScrap: 600, keys: 1, scrap: 0, keyPriceScrap: 600 }] },
    ]);
  });

  it('borrows the previous key price when a row has none', () => {
    const s = journalSummary([row('buy', 'U', 0, { keys: 1, keyPriceScrap: 560 }), row('sell', 'U', 0, { keys: 1, keyPriceScrap: 0 })]);
    expect(s.realizedProfitScrap).toBe(0);
    expect(journalValue({ keys: 1, scrap: 0, keyPriceScrap: Number.NaN })).toBe(540);
  });

  it('works in time order whatever order the rows arrive in', () => {
    const buy = row('buy', 'A', 10);
    const sell = row('sell', 'A', 30);
    expect(journalSummary([sell, buy]).realizedProfitScrap).toBe(20);
    // Same timestamp: the id decides.
    const b2 = row('buy', 'C', 10, { ts: T0 });
    const s2 = row('sell', 'C', 12, { ts: T0 });
    expect(journalSummary([s2, b2]).realizedTrades).toBe(1);
  });

  // 0.7.4 (F38): a sale with no buy before it never takes a later buy (in TF2 that is another copy).
  it('keeps a sell with no earlier buy waiting, and the later buy held', () => {
    const sale = row('sell', 'A', 30);
    const buy = row('buy', 'A', 20);
    const other = row('sell', 'B', 99);
    const s = journalSummary([sale, buy, other]);
    expect(s.realizedProfitScrap).toBe(0);
    expect(s.realizedTrades).toBe(0);
    expect(s.bySku).toEqual([]);
    expect(s.open).toEqual([{ sku: 'A', name: 'Item A', qty: 1, costScrap: 20, lots: [{ id: buy.id, ts: buy.ts, costScrap: 20, keys: 0, scrap: 20, keyPriceScrap: 567 }] }]);
    expect(s.waitingSales).toEqual([
      { id: sale.id, ts: sale.ts, sku: 'A', name: 'Item A', keys: 0, scrap: 30 },
      { id: other.id, ts: other.ts, sku: 'B', name: 'Item B', keys: 0, scrap: 99 },
    ]);
  });

  it('matches a sale once its buy is recorded dated before it', () => {
    const sale = row('sell', 'A', 30);
    const s = journalSummary([sale, row('buy', 'A', 20, { ts: sale.ts - 60_000 })]);
    expect(s).toMatchObject({ realizedProfitScrap: 10, realizedTrades: 1, open: [], waitingSales: [] });
  });

  it('never lets an old sale shift every later flip of the item by one (the cascade)', () => {
    // A sale of a copy owned before the app, then three flips of the same item: S0, B1, S1, B2, S2, B3.
    const s0 = row('sell', 'K', 250, { keys: 1 });
    const b1 = row('buy', 'K', 90, { keys: 1 });
    const s1 = row('sell', 'K', 250, { keys: 1 });
    const b2 = row('buy', 'K', 90, { keys: 1 });
    const s2 = row('sell', 'K', 250, { keys: 1 });
    const b3 = row('buy', 'K', 90, { keys: 1 });
    const s = journalSummary([s0, b1, s1, b2, s2, b3]);
    // The held copy is B3's; S1 and S2 closed B1 and B2; S0 has no cost basis.
    expect(s.open.map((p) => [p.sku, p.qty, p.lots.map((l) => l.id)])).toEqual([['K', 1, [b3.id]]]);
    expect(s.realizedTrades).toBe(2);
    expect(s.realizedProfitScrap).toBe(320);
    expect(s.waitingSales.map((w) => w.id)).toEqual([s0.id]);
  });

  it('uses the latest name for a SKU and sorts open positions by cost', () => {
    const s = journalSummary([
      row('buy', 'A', 10, { name: 'Old name' }),
      row('buy', 'B', 90),
      row('buy', 'A', 10, { name: 'New name' }),
      row('buy', 'A', 10, { name: '  ' }),
    ]);
    expect(s.open.map(({ lots: _lots, ...p }) => p)).toEqual([
      { sku: 'B', name: 'Item B', qty: 1, costScrap: 90 },
      { sku: 'A', name: 'New name', qty: 3, costScrap: 30 },
    ]);
  });

  it('lists each open lot oldest first, at its own buy-time key price (F11 holdings)', () => {
    const late = row('buy', 'K', 3, { keys: 1, keyPriceScrap: 600 });
    const early = row('buy', 'K', 0, { keys: 1, keyPriceScrap: 550, ts: late.ts - 60_000 });
    const sold = row('buy', 'K', 1, { keyPriceScrap: 550, ts: late.ts - 120_000 });
    const s = journalSummary([late, row('sell', 'K', 20), early, sold]);
    // The sell closed the oldest buy; the next sale closes `early`.
    expect(s.open).toEqual([
      {
        sku: 'K',
        name: 'Item K',
        qty: 2,
        costScrap: 550 + 603,
        lots: [
          { id: early.id, ts: early.ts, costScrap: 550, keys: 1, scrap: 0, keyPriceScrap: 550 },
          { id: late.id, ts: late.ts, costScrap: 603, keys: 1, scrap: 3, keyPriceScrap: 600 },
        ],
      },
    ]);
  });

  it('keeps lots in time order with their buy row ids; a sale before any buy waits and holds no lot back', () => {
    // Logged out of order: ids do not follow time.
    const third = row('buy', 'L', 30, { ts: T0 + 3_000_000 });
    const first = row('buy', 'L', 10, { ts: T0 + 1_000_000 });
    const second = row('buy', 'L', 20, { ts: T0 + 2_000_000 });
    // 0.7.4 (F38): a sale logged before any buy of M waits; M's later buys are both held.
    const earlySell = row('sell', 'M', 50, { ts: T0 + 500_000 });
    const later = row('buy', 'M', 40, { ts: T0 + 600_000 });
    const held = row('buy', 'M', 45, { ts: T0 + 700_000 });
    const s = journalSummary([third, earlySell, first, held, later, second]);
    const l = s.open.find((p) => p.sku === 'L')!;
    expect(l.lots).toEqual([
      { id: first.id, ts: first.ts, costScrap: 10, keys: 0, scrap: 10, keyPriceScrap: 567 },
      { id: second.id, ts: second.ts, costScrap: 20, keys: 0, scrap: 20, keyPriceScrap: 567 },
      { id: third.id, ts: third.ts, costScrap: 30, keys: 0, scrap: 30, keyPriceScrap: 567 },
    ]);
    expect(l.qty).toBe(l.lots.length);
    expect(l.costScrap).toBe(60);
    expect(s.open.find((p) => p.sku === 'M')!.lots).toEqual([
      { id: later.id, ts: later.ts, costScrap: 40, keys: 0, scrap: 40, keyPriceScrap: 567 },
      { id: held.id, ts: held.ts, costScrap: 45, keys: 0, scrap: 45, keyPriceScrap: 567 },
    ]);
    expect(s.waitingSales.map((w) => w.id)).toEqual([earlySell.id]);
    expect(s.realizedProfitScrap).toBe(0);
  });

  it('ignores junk rows and an empty journal', () => {
    expect(journalSummary([])).toEqual({ realizedProfitScrap: 0, realizedTrades: 0, open: [], bySku: [], waitingSales: [], closed: [] });
    const junk = [row('buy', '', 10), { ...row('buy', 'A', 10), side: 'hold' as 'buy' }];
    expect(journalSummary(junk).open).toEqual([]);
  });
});
