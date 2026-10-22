// 0.7.4 (review R23): Record sale's profit preview for a backfilled sale is what the journal books. F39 gave a
// backfill its key price then, and journalSummary books the pair at the sale row's key price (keys and metal
// netted apart), but the preview still valued the sale and the lot at today's key price: a sale of 55 ref
// against a 1-key lot, key 50 ref then and 60 ref today, previewed "a loss of 5.00 ref" while the journal
// booked +5 ref. holdingRow now carries the lot's own currencies (nextLotKeys, nextLotScrapRaw) and
// saleAtKeyPrice hands sellComparison the sale at the key price then. The mock books the same pair.
// Pure; nothing leaves the process.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { holdingRow } from '../../src/shared/holdings';
import { journalSummary } from '../../src/service/domain/journal';
import { mockJournalSummary } from '../../src/renderer/mockData';
import { toDateTimeLocal } from '../../src/renderer/format';
import { checkTrade, saleAtKeyPrice, sellComparison, type TradeForm } from '../../src/renderer/recordTradeModel';
import type { JournalEntry } from '../../src/shared/types';

const T0 = new Date(2026, 9, 20, 9, 0, 0).getTime();
const DAY = 86_400_000;
const THEN = 450;
const TODAY = 540;
const ITEM = { sku: '378;6', name: 'Team Captain' };

const P = { ...DEFAULT_SETTINGS.profit, frictionScrap: 0 };

const buyRow: JournalEntry = { id: 1, ts: T0 - 90 * DAY, side: 'buy', venue: 'scrap.tf', ...ITEM, keys: 1, scrap: 0, keyPriceScrap: THEN, note: null };
const held = holdingRow(journalSummary([buyRow]).open[0]!, 'hats', null, P, TODAY);

const saleForm = (over: Partial<TradeForm> = {}): TradeForm => ({
  side: 'sell',
  venue: 'backpack.tf',
  text: '55',
  unit: 'ref',
  when: toDateTimeLocal(T0 - 60 * DAY),
  note: '',
  keyText: '50',
  ...over,
});

/** What the journal books for the sale the dialog would send. */
function booked(form: TradeForm, summarize: (rows: JournalEntry[]) => { realizedProfitScrap: number } = journalSummary): number {
  const c = checkTrade(form, ITEM, T0, TODAY);
  if (!c.ok) throw new Error(c.error);
  const sale: JournalEntry = { id: 2, ts: c.input.ts!, side: 'sell', venue: c.input.venue, ...ITEM, keys: c.input.keys ?? 0, scrap: c.input.scrap, keyPriceScrap: c.input.keyPriceScrap ?? TODAY, note: null };
  return summarize([buyRow, sale]).realizedProfitScrap;
}

function preview(form: TradeForm) {
  const s = saleAtKeyPrice(form, TODAY, T0);
  return sellComparison(s.value, held, P, TODAY, T0, s.typed, T0 - 60 * DAY, s.saleAt);
}

describe("Record sale's backfill preview (R23)", () => {
  it('holdingRow carries the next lot in its own currencies', () => {
    expect(held).toMatchObject({ nextLotCostScrap: TODAY, nextLotKeys: 1, nextLotScrapRaw: 0 });
  });

  it('previews the profit the journal books, at the key price then (sign included)', () => {
    const form = saleForm();
    expect(booked(form)).toBe(45);
    const c = preview(form);
    expect(c.profitScrap).toBe(booked(form) - P.frictionScrap);
    expect(c.tone).not.toBe('bad');
    expect(c.atKeyScrap).toBe(THEN);
    expect(c.lotCostScrap).toBe(THEN);
    expect(c.text).toMatch(/^Profit \+5\.00 ref on the lot you bought .* for 1 key/);
  });

  it('the mock journal books the same pair', () => {
    expect(booked(saleForm(), mockJournalSummary)).toBe(45);
  });

  it("an empty Key price then is today's, as before", () => {
    const form = saleForm({ keyText: '' });
    const c = preview(form);
    expect(c.profitScrap).toBe(495 - TODAY);
    expect(c.profitScrap).toBe(booked(form));
    expect(c.text).not.toMatch(/today's key price/);
  });

  it('a sale logged now ignores Key price then', () => {
    const s = saleAtKeyPrice(saleForm({ when: toDateTimeLocal(T0) }), TODAY, T0);
    expect(s.saleAt).toBeNull();
    expect(s.value).toBe(495);
    const c = sellComparison(s.value, held, P, TODAY, T0, s.typed, T0, s.saleAt);
    expect(c).toMatchObject({ profitScrap: 495 - TODAY, atKeyScrap: null, lotCostScrap: TODAY });
  });

  it('an unreadable Key price then keeps today\'s math (the save refuses it)', () => {
    const s = saleAtKeyPrice(saleForm({ keyText: 'a lot' }), TODAY, T0);
    expect(s).toEqual({ value: 495, typed: 'ok', saleAt: null });
  });

  it('a sale in keys and metal nets each currency against the lot', () => {
    const form = saleForm({ text: '1 key 10 ref' });
    const c = preview(form);
    expect(c.profitScrap).toBe(90);
    expect(c.profitScrap).toBe(booked(form));
  });

  it("a lot without its own currencies keeps today's math and says so", () => {
    const { nextLotKeys: _k, nextLotScrapRaw: _s, ...bare } = held;
    const s = saleAtKeyPrice(saleForm(), TODAY, T0);
    const c = sellComparison(s.value, bare, P, TODAY, T0, s.typed, T0 - 60 * DAY, s.saleAt);
    expect(c.atKeyScrap).toBeNull();
    expect(c.profitScrap).toBe(495 - TODAY);
    expect(c.text).toMatch(/\(at today's key price\)/);
  });
});
