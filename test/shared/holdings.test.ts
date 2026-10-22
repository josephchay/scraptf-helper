// F11 holdings rules shared by the service, the mock and the dashboard: the
// figures for the next lot and for every unit, the status from profitStatus,
// the order (sellable first), the totals and the CSV cells. Pure; no network.

import { describe, expect, it } from 'vitest';
import { maxCostFor, profitStatus } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  HOLDINGS_CSV_COLUMNS,
  holdingComparator,
  holdingFigures,
  holdingMatches,
  holdingRow,
  holdingStatusOf,
  holdingsCsvCells,
  holdingsMatching,
  holdingsResult,
  holdingsTotals,
  lotCostAt,
  type HoldingBuySide,
} from '../../src/shared/holdings';
import { valueScrap } from '../../src/shared/currency';
import { HOLDING_STATUSES, type HoldingRow, type JournalPosition, type OrderSummary, type ScraptfListRow } from '../../src/shared/types';
import type { NextBuyer } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const KEY = 568;
const P = DEFAULT_SETTINGS.profit;

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'Metal Bank Bot',
    keys: 0,
    metalScrap: 60,
    valueScrap: 60,
    isBot: true,
    online: true,
    lastEventAt: NOW - 60_000,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function buy(revenueScrap: number | null, over: Partial<HoldingBuySide> = {}): HoldingBuySide {
  return {
    revenueScrap,
    bestScrap: revenueScrap,
    instantScrap: revenueScrap,
    revenueOrder: revenueScrap === null ? null : order({ valueScrap: revenueScrap, metalScrap: revenueScrap }),
    bestOrder: revenueScrap === null ? null : order({ valueScrap: revenueScrap, metalScrap: revenueScrap }),
    buyerCount: revenueScrap === null ? 0 : 3,
    confidence: 70,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: NOW - 60_000,
    ...over,
  };
}

function position(sku: string, costs: number[], name = `Item ${sku}`): JournalPosition {
  const lots = costs.map((c, i) => ({ id: i + 1, ts: NOW - (costs.length - i) * 3_600_000, costScrap: c, keys: 0, scrap: c, keyPriceScrap: KEY }));
  return { sku, name, qty: lots.length, costScrap: costs.reduce((t, c) => t + c, 0), lots };
}

const rowOf = (sku: string, costs: number[], b: HoldingBuySide | null, name?: string): HoldingRow => holdingRow(position(sku, costs, name), 'hats', b, P);

describe('holding status', () => {
  it('is profitStatus of the next lot in holding terms', () => {
    expect(holdingStatusOf('profitable')).toBe('sell');
    expect(holdingStatusOf('below-threshold')).toBe('hold');
    expect(holdingStatusOf('unprofitable')).toBe('loss');
    expect(holdingStatusOf('no-buyers')).toBe('no-buyers');
    expect(HOLDING_STATUSES).toEqual(['sell', 'hold', 'loss', 'no-buyers']);
  });

  it('sells exactly when the next lot cost is at or under the Pay up to ceiling', () => {
    const revenue = 200;
    const ceiling = maxCostFor(revenue, P)!;
    expect(holdingFigures({ revenueScrap: revenue, qty: 1, costScrap: ceiling, nextLotCostScrap: ceiling }, P).status).toBe('sell');
    expect(holdingFigures({ revenueScrap: revenue, qty: 1, costScrap: ceiling + 1, nextLotCostScrap: ceiling + 1 }, P).status).toBe('hold');
    expect(holdingFigures({ revenueScrap: revenue, qty: 1, costScrap: revenue, nextLotCostScrap: revenue }, P).status).toBe('loss');
    expect(holdingFigures({ revenueScrap: null, qty: 1, costScrap: 10, nextLotCostScrap: 10 }, P)).toEqual({
      profitNowScrap: null,
      profitAllScrap: null,
      margin: null,
      status: 'no-buyers',
    });
  });
});

describe('holdingRow', () => {
  it('prices the next FIFO lot and every unit, with friction per unit', () => {
    const p = { ...P, frictionScrap: 2 };
    const r = holdingRow(position('378;6', [40, 50]), 'hats', buy(60), p);
    expect(r).toMatchObject({ qty: 2, costScrap: 90, nextLotCostScrap: 40, heldSince: NOW - 2 * 3_600_000 });
    expect(r.profitNowScrap).toBe(60 - 40 - 2);
    expect(r.profitAllScrap).toBe(60 * 2 - 90 - 2 * 2);
    expect(r.margin).toBeCloseTo(18 / 40);
    expect(r.status).toBe(holdingStatusOf(profitStatus(18, 40, p)));
    expect(r).toMatchObject({ revenueScrap: 60, bestScrap: 60, instantScrap: 60, buyerCount: 3, confidence: 70, confidenceLevel: 'high' });
    expect(r.revenueOrder?.valueScrap).toBe(60);
  });

  it('reads no buyers as no revenue, low confidence and no order', () => {
    const r = rowOf('30359;6', [12], null);
    expect(r).toMatchObject({ status: 'no-buyers', revenueScrap: null, revenueOrder: null, bestOrder: null, buyerCount: 0, confidence: 0, confidenceLevel: 'low', profitNowScrap: null, margin: null });
  });

  it('flags a painted copy (priced against its clean base) and copies the buy flags', () => {
    const flags = ['stale-reference'];
    const r = rowOf('378;6;p15185211', [40], buy(80, { flags }));
    expect(r.flags).toEqual(['stale-reference', 'has-extras']);
    expect(flags).toEqual(['stale-reference']);
    expect(rowOf('378;6', [40], buy(80)).flags).toEqual([]);
  });

  it('has no margin for a free lot (profitStatus treats it as unbounded)', () => {
    const r = rowOf('378;6', [0], buy(30));
    expect(r.margin).toBeNull();
    expect(r.status).toBe('sell');
  });

  it('falls back to the average lot when a position has no lots listed', () => {
    const r = holdingRow({ sku: 'a', name: 'A', qty: 2, costScrap: 30, lots: [] }, 'other', buy(40), P);
    expect(r).toMatchObject({ nextLotCostScrap: 15, heldSince: 0 });
  });

  it('values key-priced lots at the key price the revenue is valued at, as the journal books a sale', () => {
    // Bought for 1 key while a key was 500; a buyer pays exactly 1 key now that it is KEY (568).
    const keyLot = (keys: number, scrap: number, k: number, id: number) => ({ id, ts: NOW - id * 3_600_000, costScrap: valueScrap(keys, scrap, k), keys, scrap, keyPriceScrap: k });
    const one: JournalPosition = { sku: '30920;6', name: 'Taunt', qty: 1, costScrap: 500, lots: [keyLot(1, 0, 500, 1)] };
    const up = holdingRow(one, 'taunts', buy(KEY), P, KEY);
    // Same keys in and out: no profit, so no "Sell:" from the key price move alone.
    expect(up).toMatchObject({ costScrap: KEY, nextLotCostScrap: KEY, profitNowScrap: 0, profitAllScrap: 0, status: 'loss' });
    // Without a key price the buy-time cost stays.
    expect(holdingRow(one, 'taunts', buy(KEY), P)).toMatchObject({ nextLotCostScrap: 500, profitNowScrap: KEY - 500 });

    // Key down: bought for 10 keys at 600, a buyer pays 10 keys + 18 scrap at 568: +18, not a loss.
    const ten: JournalPosition = { sku: '378;5;u13', name: 'Unusual', qty: 2, costScrap: 6000 + 5 * 600 + 9, lots: [keyLot(10, 0, 600, 1), keyLot(5, 9, 600, 2)] };
    const down = holdingRow(ten, 'unusuals', buy(10 * KEY + 18), P, KEY);
    expect(down).toMatchObject({ nextLotCostScrap: 10 * KEY, costScrap: 15 * KEY + 9, profitNowScrap: 18, profitAllScrap: 2 * (10 * KEY + 18) - (15 * KEY + 9) });
    expect(down.status).not.toBe('loss');
    expect(lotCostAt(ten.lots[1]!, KEY)).toBe(5 * KEY + 9);
    expect(lotCostAt({ costScrap: 77 }, KEY)).toBe(77);
    expect(lotCostAt(ten.lots[0]!, null)).toBe(6000);
  });
});

describe('holdingRow with the saved scrap.tf list (F14)', () => {
  const list = (paysScrap: number | null, over: Partial<ScraptfListRow> = {}): ScraptfListRow => ({
    sku: '378;6',
    name: 'Team Captain',
    sellsKeys: 0,
    sellsScrapRaw: 90,
    sellsScrap: 90,
    paysKeys: paysScrap === null ? null : 0,
    paysScrapRaw: paysScrap,
    paysScrap,
    stock: 1,
    stockLimit: 5,
    full: false,
    observedAt: NOW - 10 * 60_000,
    ...over,
  });
  const at = (l: ScraptfListRow | null) => ({ list: l, now: NOW });

  it('changes nothing without a list row: backpack.tf is the exit', () => {
    const r = holdingRow(position('378;6', [40]), 'hats', buy(60), P, KEY, at(null));
    expect(r).toMatchObject({ scraptfPaysScrap: null, scraptfFull: false, scraptfListAt: null, bestExit: 'backpack', exitScrap: 60, exitVenue: 'backpack.tf' });
    expect(r).toMatchObject(holdingFigures({ revenueScrap: 60, qty: 1, costScrap: 40, nextLotCostScrap: 40 }, P));
    expect(holdingRow(position('378;6', [40]), 'hats', buy(60), P)).toEqual(r);
  });

  it('sells through scrap.tf when it pays more, judging status and profit on it', () => {
    const p = { ...P, frictionScrap: 2 };
    const r = holdingRow(position('378;6', [40, 50]), 'hats', buy(60), p, KEY, at(list(75)));
    expect(r).toMatchObject({ revenueScrap: 60, scraptfPaysScrap: 75, scraptfListAt: NOW - 10 * 60_000, bestExit: 'scraptf', exitScrap: 75, exitVenue: 'scrap.tf' });
    expect(r.profitNowScrap).toBe(75 - 40 - 2);
    expect(r.profitAllScrap).toBe(75 * 2 - 90 - 2 * 2);
    expect(r.status).toBe(holdingStatusOf(profitStatus(33, 40, p)));
    expect(holdingsTotals([r]).worthNowScrap).toBe(150);
  });

  it('gives an item without buyers an exit through scrap.tf', () => {
    const r = holdingRow(position('30359;6', [12]), 'hats', null, P, KEY, at(list(30, { sku: '30359;6' })));
    expect(r).toMatchObject({ buyerCount: 0, revenueScrap: null, bestExit: 'scraptf', exitScrap: 30, status: 'sell' });
  });

  it('keeps backpack.tf on a tie, and never sells into a full or day-old list', () => {
    expect(holdingRow(position('378;6', [40]), 'hats', buy(60), P, KEY, at(list(60))).bestExit).toBe('backpack');
    const full = holdingRow(position('378;6', [40]), 'hats', buy(60), P, KEY, at(list(90, { stock: 5, full: true })));
    expect(full).toMatchObject({ scraptfFull: true, bestExit: 'backpack', exitScrap: 60 });
    const old = holdingRow(position('30359;6', [12]), 'hats', null, P, KEY, at(list(30, { observedAt: NOW - 25 * 3_600_000 })));
    expect(old).toMatchObject({ scraptfPaysScrap: 30, bestExit: null, exitScrap: null, status: 'no-buyers' });
  });
});

describe('order, search and totals', () => {
  const sell = rowOf('1', [10], buy(60), 'Sell small');
  const sellBig = rowOf('2', [10], buy(200), 'Sell big');
  const hold = rowOf('3', [55], buy(60), 'Hold');
  const loss = rowOf('4', [80], buy(60), 'Loss');
  const none = rowOf('5', [12], null, 'Nobody');

  it('puts sellable first, then the biggest profit now', () => {
    expect([none, loss, hold, sell, sellBig].sort(holdingComparator).map((r) => r.name)).toEqual(['Sell big', 'Sell small', 'Hold', 'Loss', 'Nobody']);
    // Ties go by name, then SKU.
    const a = rowOf('9', [10], buy(60), 'Alpha');
    const b = rowOf('8', [10], buy(60), 'Alpha');
    expect([a, b].sort(holdingComparator).map((r) => r.sku)).toEqual(['8', '9']);
  });

  it('searches name and SKU word by word', () => {
    expect(holdingMatches({ name: 'Strange Knife', sku: '194;11' }, ['knife', '194'])).toBe(true);
    expect(holdingMatches({ name: 'Strange Knife', sku: '194;11' }, ['knife', 'australium'])).toBe(false);
    expect(holdingsMatching([sell, hold], { search: '  hold ' }).map((r) => r.name)).toEqual(['Hold']);
    expect(holdingsMatching([hold, sell], {}).map((r) => r.name)).toEqual(['Sell small', 'Hold']);
  });

  it('totals everything held; rows without revenue add cost but no worth', () => {
    const rows = [sell, hold, none];
    expect(holdingsTotals(rows)).toEqual({
      items: 3,
      units: 3,
      costScrap: 10 + 55 + 12,
      worthNowScrap: 60 + 60,
      profitNowScrap: sell.profitAllScrap! + hold.profitAllScrap!,
      sellable: 1,
    });
    const res = holdingsResult(rows, { search: 'nobody' }, null, NOW);
    expect(res.rows.map((r) => r.name)).toEqual(['Nobody']);
    // The header is about the whole position, whatever the search.
    expect(res.totals.items).toBe(3);
    expect(res).toMatchObject({ keyPrice: null, generatedAt: NOW });
  });
});

describe('CSV cells', () => {
  it('follow the column list, money as keys + ref, blanks for missing values', () => {
    expect(HOLDINGS_CSV_COLUMNS).toEqual([
      'sku',
      'name',
      'qty',
      'cost',
      'next_lot_cost',
      'held_since',
      'sells_for',
      'buyer',
      'profit_now',
      'profit_all',
      'status',
      'confidence',
      'exit',
      'exit_venue',
      'scraptf_pays',
      // 0.8 (H6, H2, H3), appended.
      'advice',
      'next_buyer',
      'lowest_ask',
    ]);
    const r = holdingRow(position('378;6', [KEY + 18, 600]), 'hats', buy(KEY + 90), P);
    const cells = holdingsCsvCells(r, KEY);
    expect(cells).toHaveLength(HOLDINGS_CSV_COLUMNS.length);
    expect(cells.slice(0, 3)).toEqual(['378;6', 'Item 378;6', 2]);
    expect(cells[4]).toBe('1 key 2.00 ref');
    expect(cells[5]).toBe(new Date(r.heldSince).toISOString());
    expect(cells[7]).toBe('Metal Bank Bot (bot)');
    expect(cells[10]).toBe(r.status);
    // Without a list the exit is the backpack.tf revenue; no advice, next buyer or ask on this row.
    expect(cells.slice(12)).toEqual(['1 key 10.00 ref', 'backpack.tf', '', '', '', '']);
    const empty = holdingsCsvCells(rowOf('5', [12], null), KEY);
    expect([empty[6], empty[7], empty[8], empty[9], empty[10]]).toEqual(['', '', '', '', 'no-buyers']);
    expect(empty.slice(12)).toEqual(['', '', '', '', '', '']);
  });

  it('0.8: write the advice kind, the next buyer and the lowest matching ask in the appended columns', () => {
    const next: NextBuyer = { valueScrap: 55, keys: 0, metalScrap: 55, isBot: false, online: null, lastEventAt: NOW - 120_000, unverified: false };
    const ask = { lowestScrap: KEY + 9, lowestKeys: 1, lowestMetalScrap: 9, lowestIsBot: true, lowestSeenAt: NOW, count: 2, botCount: 1, ownLeftOut: 0, mayIncludeOwn: true };
    const base = holdingRow(position('378;6', [40]), 'hats', buy(60, { nextBuyer: next }), P, KEY, null, { ask, refs: null, snapshotAt: null });
    const r: HoldingRow = { ...base, advice: { kind: 'sell-now', reasons: [], basis: null, refreshFirst: false } };
    const byCol = Object.fromEntries(HOLDINGS_CSV_COLUMNS.map((c, i) => [c, holdingsCsvCells(r, KEY)[i]]));
    expect(byCol).toMatchObject({ advice: 'sell-now', next_buyer: '6.11 ref', lowest_ask: '1 key 1.00 ref' });
  });

  it('write the scrap.tf exit (F14): sells_for stays the backpack.tf revenue, profit follows the exit', () => {
    const list: ScraptfListRow = {
      sku: '378;6',
      name: 'Team Captain',
      sellsKeys: 0,
      sellsScrapRaw: 90,
      sellsScrap: 90,
      paysKeys: 0,
      paysScrapRaw: 81,
      paysScrap: 81,
      stock: 1,
      stockLimit: 5,
      full: false,
      observedAt: NOW - 60_000,
    };
    const r = holdingRow(position('378;6', [40]), 'hats', buy(60), P, KEY, { list, now: NOW });
    const byCol = Object.fromEntries(HOLDINGS_CSV_COLUMNS.map((c, i) => [c, holdingsCsvCells(r, KEY)[i]]));
    expect(byCol).toMatchObject({ sells_for: '6.66 ref', profit_now: '4.55 ref', exit: '9.00 ref', exit_venue: 'scrap.tf', scraptf_pays: '9.00 ref' });
  });
});

describe('0.8 (PC-2, H2; PC-1 R-PC1-sell): the buy side depth and the sell path', () => {
  const nextBuyer: NextBuyer = { valueScrap: 55, keys: 0, metalScrap: 55, isBot: false, online: null, lastEventAt: NOW - 120_000, unverified: false };

  it('holdingRow copies nextBuyer and verifiedBuyerCount from the buy side, and leaves them absent without', () => {
    const r = rowOf('378;6', [40], buy(60, { nextBuyer, verifiedBuyerCount: 2 }));
    expect(r.nextBuyer).toEqual(nextBuyer);
    expect(r.verifiedBuyerCount).toBe(2);
    // A null next buyer (only one buyer) is carried as null, not dropped.
    const alone = rowOf('378;6', [40], buy(60, { nextBuyer: null, verifiedBuyerCount: 1 }));
    expect(alone.nextBuyer).toBeNull();
    expect('nextBuyer' in alone).toBe(true);
    expect(alone.verifiedBuyerCount).toBe(1);
    for (const r2 of [rowOf('378;6', [40], buy(60)), rowOf('378;6', [40], null)]) {
      expect('nextBuyer' in r2).toBe(false);
      expect('verifiedBuyerCount' in r2).toBe(false);
    }
  });

  it('holdingFigures takes friction only, never the price-move reserve (a sale into a live order)', () => {
    const a = { revenueScrap: 120, qty: 2, costScrap: 180, nextLotCostScrap: 90 };
    for (const frictionScrap of [0, 2]) {
      const without = holdingFigures(a, { ...P, frictionScrap });
      expect(holdingFigures(a, { ...P, frictionScrap, exitReservePct: 0.3 })).toEqual(without);
    }
    expect(rowOf('378;6', [40], buy(60)).profitNowScrap).toBe(holdingRow(position('378;6', [40]), 'hats', buy(60), { ...P, exitReservePct: 0.3 }).profitNowScrap);
  });
});
