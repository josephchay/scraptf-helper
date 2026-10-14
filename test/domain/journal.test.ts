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
    const s = journalSummary([row('buy', 'A', 90), row('sell', 'A', 108)]);
    expect(s).toEqual({
      realizedProfitScrap: 18,
      realizedTrades: 1,
      open: [],
      bySku: [{ sku: 'A', name: 'Item A', realizedProfitScrap: 18, trades: 1 }],
    });
  });

  it('matches sells to the oldest buy first', () => {
    const s = journalSummary([row('buy', 'A', 10), row('buy', 'A', 12), row('sell', 'A', 15)]);
    expect(s.realizedProfitScrap).toBe(5);
    expect(s.open).toEqual([{ sku: 'A', name: 'Item A', qty: 1, costScrap: 12 }]);
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
    expect(s.open).toEqual([{ sku: 'A', name: 'Item A', qty: 1, costScrap: 12 }]);
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
    // A sell logged first and matched by a later buy also uses the sell's key price.
    const early = journalSummary([row('sell', 'V', 9, { keys: 3, keyPriceScrap: 600 }), row('buy', 'V', 0, { keys: 3, keyPriceScrap: 500 })]);
    expect(early.realizedProfitScrap).toBe(9);
  });

  it('keeps open positions at their buy-time value', () => {
    const s = journalSummary([row('buy', 'U', 5, { keys: 2, keyPriceScrap: 500 }), row('buy', 'W', 0, { keys: 1, keyPriceScrap: 600 })]);
    expect(s.open).toEqual([
      { sku: 'U', name: 'Item U', qty: 1, costScrap: 1005 },
      { sku: 'W', name: 'Item W', qty: 1, costScrap: 600 },
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

  it('pairs a sell logged before its buy with the next buy, and ignores sells that never match', () => {
    const s = journalSummary([row('sell', 'A', 30), row('buy', 'A', 20), row('sell', 'B', 99)]);
    expect(s.realizedProfitScrap).toBe(10);
    expect(s.realizedTrades).toBe(1);
    expect(s.open).toEqual([]);
    expect(s.bySku.map((x) => x.sku)).toEqual(['A']);
  });

  it('uses the latest name for a SKU and sorts open positions by cost', () => {
    const s = journalSummary([
      row('buy', 'A', 10, { name: 'Old name' }),
      row('buy', 'B', 90),
      row('buy', 'A', 10, { name: 'New name' }),
      row('buy', 'A', 10, { name: '  ' }),
    ]);
    expect(s.open).toEqual([
      { sku: 'B', name: 'Item B', qty: 1, costScrap: 90 },
      { sku: 'A', name: 'New name', qty: 3, costScrap: 30 },
    ]);
  });

  it('ignores junk rows and an empty journal', () => {
    expect(journalSummary([])).toEqual({ realizedProfitScrap: 0, realizedTrades: 0, open: [], bySku: [] });
    const junk = [row('buy', '', 10), { ...row('buy', 'A', 10), side: 'hold' as 'buy' }];
    expect(journalSummary(junk).open).toEqual([]);
  });
});
