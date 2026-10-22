// 0.7.4 (review R25): the journal's FIFO treats a buy dated exactly at a sale as "at or before" it,
// whichever was recorded first. The Record trade dialog keeps minutes only, so a sale and then its buy
// logged within one minute share a ts; the sale has the lower id and, sorted by id alone, waited while the
// buy stayed an open lot (a phantom holding with Sell: alerts). The service's journalSummary and the
// mock's mockJournalSummary both put a buy before a sale at the same ts; a buy even 1 ms later is still
// another copy (F38).

import { describe, expect, it } from 'vitest';
import { journalOrder, journalSummary } from '../../src/service/domain/journal';
import { mockJournalSummary } from '../../src/renderer/mockData';
import { checkTrade, initialTradeForm } from '../../src/renderer/recordTradeModel';
import type { JournalEntry } from '../../src/shared/types';

const T = new Date(2026, 9, 20, 12, 34, 0).getTime();

function entry(id: number, side: JournalEntry['side'], ts: number, scrap: number): JournalEntry {
  return { id, ts, side, venue: side === 'buy' ? 'scrap.tf' : 'backpack.tf', sku: '378;6', name: 'Team Captain', keys: 0, scrap, keyPriceScrap: 540, note: null };
}

const summaries = [
  ['service', (rows: JournalEntry[]) => journalSummary(rows)],
  ['mock', (rows: JournalEntry[]) => mockJournalSummary(rows)],
] as const;

describe.each(summaries)('%s journal summary at equal timestamps', (_label, summarize) => {
  it('matches a sale with a buy recorded after it at the same ts', () => {
    const s = summarize([entry(10, 'sell', T, 120), entry(11, 'buy', T, 100)]);
    expect(s.realizedTrades).toBe(1);
    expect(s.realizedProfitScrap).toBe(20);
    expect(s.open).toEqual([]);
    expect(s.waitingSales).toEqual([]);
  });

  it('still keeps a buy dated 1 ms after the sale as its own copy (F38)', () => {
    const s = summarize([entry(10, 'sell', T, 120), entry(11, 'buy', T + 1, 100)]);
    expect(s.realizedTrades).toBe(0);
    expect(s.waitingSales.map((w) => w.id)).toEqual([10]);
    expect(s.open.map((p) => p.lots.map((l) => l.id))).toEqual([[11]]);
  });

  it('keeps FIFO among buys at one ts by id', () => {
    const s = summarize([entry(12, 'buy', T, 90), entry(10, 'sell', T, 120), entry(11, 'buy', T, 100)]);
    expect(s.realizedProfitScrap).toBe(20);
    expect(s.open.map((p) => p.lots.map((l) => l.id))).toEqual([[12]]);
  });
});

describe('journalOrder', () => {
  it('sorts by time, then buy before sell, then id', () => {
    const rows = [entry(3, 'sell', T, 0), entry(4, 'buy', T, 0), entry(1, 'buy', T + 1, 0), entry(2, 'sell', T - 1, 0), entry(5, 'buy', T, 0)];
    expect([...rows].sort(journalOrder).map((r) => r.id)).toEqual([2, 4, 5, 3, 1]);
  });
});

describe('the Record trade dialog path', () => {
  it('a sale and its buy logged within one minute (When left as now) settle as one flip', () => {
    // initialTradeForm fills When to the minute; checkTrade reads it back, so both get the same ts.
    const at = (sec: number) => T + sec * 1000;
    const item = { sku: '378;6', name: 'Team Captain' };
    const sale = checkTrade({ ...initialTradeForm({ side: 'sell', ...item }, at(10)), text: '13.33', unit: 'ref' }, item, at(10));
    const buy = checkTrade({ ...initialTradeForm({ side: 'buy', ...item }, at(40)), text: '11.11', unit: 'ref' }, item, at(40));
    expect(sale.ok && buy.ok).toBe(true);
    if (!sale.ok || !buy.ok) return;
    expect(sale.input.ts).toBe(buy.input.ts);
    const rows: JournalEntry[] = [
      { ...entry(10, 'sell', sale.input.ts!, sale.input.scrap), keys: sale.input.keys ?? 0 },
      { ...entry(11, 'buy', buy.input.ts!, buy.input.scrap), keys: buy.input.keys ?? 0 },
    ];
    for (const [, summarize] of summaries) {
      const s = summarize(rows);
      expect(s.realizedTrades).toBe(1);
      expect(s.open).toEqual([]);
      expect(s.waitingSales).toEqual([]);
    }
  });
});
