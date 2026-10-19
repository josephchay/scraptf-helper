// F11 Holdings page helpers: status pills, header totals text, cell tooltips,
// the Record sale prefill (it must parse back to the order's own price), the
// buyer's profile link, the empty-state reason, the live flash and the row keys.
// Pure; no network.

import { describe, expect, it } from 'vitest';
import { parsePrice } from '../../src/shared/currency';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { holdingRow, holdingsResult } from '../../src/shared/holdings';
import type { HoldingRow, JournalPosition, OrderSummary } from '../../src/shared/types';
import { HOLDING_STATUSES } from '../../src/shared/types';
import {
  HOLDINGS_MAX_SEARCH_CHARS,
  HOLDING_STATUS_HELP,
  HOLDING_STATUS_LABELS,
  HOLDING_STATUS_TONES,
  buyerName,
  buyerProfileUrl,
  costTitle,
  diffHoldingsFlash,
  emptyHoldingsReason,
  heldForText,
  heldForTitle,
  holdingKeyAction,
  holdingSellsForTitle,
  holdingsQuery,
  holdingsSnapshot,
  noBuyerProfileText,
  plTitle,
  plTone,
  profitNowTitle,
  recordSaleInit,
  sanitizeHoldingsSearch,
  unitsText,
  worthTitle,
} from '../../src/renderer/holdingsModel';
import { fmtDateTime } from '../../src/renderer/format';
import { initialTradeForm } from '../../src/renderer/recordTradeModel';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY = 86_400_000;
const KEY = 568;
const P = DEFAULT_SETTINGS.profit;

function order(valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: `l${valueScrap}`,
    steamid: '76561198000000001',
    userName: 'Flip Bot',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: true,
    online: true,
    lastEventAt: T0 - 60_000,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function position(sku: string, lots: number[], name = `Item ${sku}`): JournalPosition {
  return {
    sku,
    name,
    qty: lots.length,
    costScrap: lots.reduce((t, c) => t + c, 0),
    lots: lots.map((costScrap, i) => ({ id: i + 1, ts: T0 - (lots.length - i) * DAY, costScrap, keys: 0, scrap: costScrap, keyPriceScrap: 568 })),
  };
}

function row(sku: string, lots: number[], revenue: OrderSummary | null): HoldingRow {
  const buy = revenue
    ? {
        revenueScrap: revenue.valueScrap,
        bestScrap: revenue.valueScrap + 9,
        instantScrap: revenue.valueScrap,
        revenueOrder: revenue,
        bestOrder: revenue,
        buyerCount: 4,
        confidence: 72,
        confidenceLevel: 'high' as const,
        flags: [],
        lastOrderChangeAt: T0 - 120_000,
      }
    : null;
  return holdingRow(position(sku, lots), 'hats', buy, P);
}

describe('status', () => {
  it('labels, tones and explains every status', () => {
    expect(HOLDING_STATUSES.map((s) => HOLDING_STATUS_LABELS[s])).toEqual(['Sell now', 'Hold', 'Loss', 'No buyers']);
    expect(HOLDING_STATUSES.map((s) => HOLDING_STATUS_TONES[s])).toEqual(['good', 'warn', 'bad', 'muted']);
    for (const s of HOLDING_STATUSES) expect(HOLDING_STATUS_HELP[s].length).toBeGreaterThan(20);
  });
});

describe('query', () => {
  it('trims the search, caps it like the RPC, and sends nothing for an empty box', () => {
    expect(holdingsQuery('  knife ')).toEqual({ search: 'knife' });
    expect(holdingsQuery('   ')).toEqual({});
    expect(holdingsQuery('x'.repeat(500)).search).toHaveLength(HOLDINGS_MAX_SEARCH_CHARS);
    expect(sanitizeHoldingsSearch('helm')).toBe('helm');
    expect(sanitizeHoldingsSearch(42)).toBe('');
    expect(sanitizeHoldingsSearch('y'.repeat(300))).toHaveLength(HOLDINGS_MAX_SEARCH_CHARS);
  });
});

describe('header totals', () => {
  it('counts items and units', () => {
    expect(unitsText({ items: 1, units: 1 })).toBe('1 item');
    expect(unitsText({ items: 3, units: 3 })).toBe('3 items');
    expect(unitsText({ items: 4, units: 7 })).toBe('4 items (7 units)');
    expect(unitsText({ items: 1, units: 2 })).toBe('1 item (2 units)');
  });

  it('colours the P/L green for a gain and red for a loss', () => {
    expect(plTone(5)).toBe('good');
    expect(plTone(-1)).toBe('bad');
    expect(plTone(0)).toBeNull();
    expect(plTone(null)).toBeNull();
  });

  it('explains worth and P/L, with friction when set', () => {
    // F14: worth is at the better exit, a backpack.tf buyer or scrap.tf by the saved list.
    expect(worthTitle({ worthNowScrap: 450, costScrap: 300 }, KEY)).toMatch(
      /^What every unit sells for now at its better exit \(a backpack\.tf buyer, or scrap\.tf by your saved price list\): 50\.00 ref, against 33\.33 ref you paid/,
    );
    expect(worthTitle({ worthNowScrap: KEY + 9, costScrap: 300 }, KEY)).toContain('1 key 1.00 ref');
    expect(plTitle({ profitNowScrap: 27 }, KEY, { frictionScrap: 0 })).toMatch(
      /^Unrealised profit or loss if every unit with a buyer \(or a fresh scrap\.tf price\) sold now: \+3\.00 ref\. Items with no buyer/,
    );
    expect(plTitle({ profitNowScrap: -9 }, KEY, { frictionScrap: 3 })).toContain('-1.00 ref, after 0.33 ref friction per unit');
  });
});

describe('cells', () => {
  const two = row('5021;6', [40, 50], order(70));
  const one = row('143;6', [100], order(80));

  it('shows the next lot and puts the total on hover', () => {
    expect(costTitle(two, KEY)).toBe(`The next sale closes the oldest unit bought ${fmtDateTime(T0 - 2 * DAY)}, which cost 4.44 ref. All 2 units cost 10.00 ref.`);
    expect(costTitle(one, KEY)).not.toContain('All');
  });

  it('ages the oldest unit', () => {
    expect(heldForText(two, T0)).toBe('2 d');
    expect(heldForText({ heldSince: 0 }, T0)).toBe('—');
    expect(heldForTitle(two)).toMatch(/^Oldest unit bought /);
    expect(heldForTitle({ heldSince: 0 })).toBeUndefined();
  });

  it('names the buyer and explains the sale price', () => {
    expect(buyerName(order(1))).toBe('Flip Bot');
    expect(buyerName(order(1, { userName: null, isBot: false }))).toBe('Human');
    expect(holdingSellsForTitle(two, KEY)).toBe('Sells now for 7.77 ref to Flip Bot (bot, online). Best 8.77 ref, instant 7.77 ref. 4 buyers with eligible orders.');
    expect(holdingSellsForTitle(row('1;6', [9], null), KEY)).toBe('No eligible backpack.tf buy orders in the live book.');
    expect(holdingSellsForTitle({ ...row('1;6', [9], null), buyerCount: 2 }, KEY)).toMatch(/unrealistic/);
  });

  it('explains profit now with the margin, every unit and the status', () => {
    expect(two.status).toBe('sell');
    const t = profitNowTitle(two, KEY, { frictionScrap: 0 });
    expect(t).toMatch(/^Selling the oldest unit now: \+3\.33 ref \(75\.0% margin\)\. All 2 units at this price: \+5\.55 ref\. /);
    expect(t.endsWith(HOLDING_STATUS_HELP.sell)).toBe(true);
    expect(profitNowTitle(row('1;6', [9], null), KEY, null)).toBe(HOLDING_STATUS_HELP['no-buyers']);
    expect(profitNowTitle(one, KEY, { frictionScrap: 9 })).toContain('after 1.00 ref friction');
  });
});

describe('actions', () => {
  it('prefills Record sale with the buyer order, which parses back to its own keys and metal', () => {
    const r = row('30357;5;u702', [24 * KEY], order(25 * KEY + 30, { keys: 25, metalScrap: 30, userName: 'Hat Bot' }));
    const init = recordSaleInit(r);
    expect(init).toEqual({ side: 'sell', sku: '30357;5;u702', name: 'Item 30357;5;u702', venue: 'backpack.tf', keys: 25, scrap: 30, note: 'Sold to Hat Bot' });
    const f = initialTradeForm(init, T0);
    expect(parsePrice(f.text, f.unit)).toMatchObject({ keys: 25, scrap: 30 });
    expect(f.venue).toBe('backpack.tf');
  });

  it('falls back to the SteamID in the note, and to item and venue only without a buyer', () => {
    const anon = recordSaleInit(row('5021;6', [40], order(70, { userName: null })));
    expect(anon.note).toBe('Sold to 76561198000000001');
    expect(recordSaleInit(row('1;6', [9], null))).toEqual({ side: 'sell', sku: '1;6', name: 'Item 1;6', venue: 'backpack.tf' });
  });

  it("links the buyer's backpack.tf profile, only for a SteamID64", () => {
    expect(buyerProfileUrl(row('5021;6', [40], order(70)))).toBe('https://backpack.tf/profiles/76561198000000001');
    expect(buyerProfileUrl(row('5021;6', [40], order(70, { steamid: 'not-an-id' })))).toBeNull();
    expect(buyerProfileUrl(row('1;6', [9], null))).toBeNull();
  });

  it('says why the buyer key opened nothing', () => {
    expect(noBuyerProfileText(row('1;6', [9], null))).toBe('Item 1;6 has no buyer to open right now.');
    expect(noBuyerProfileText(row('5021;6', [40], order(70, { steamid: 'not-an-id' })))).toBe('Item 5021;6: this buyer has no backpack.tf profile link.');
  });

  it('tells nothing held from a search that hides everything', () => {
    const rows = [row('5021;6', [40], order(70))];
    expect(emptyHoldingsReason(holdingsResult(rows, {}, null, T0))).toBeNull();
    expect(emptyHoldingsReason(holdingsResult(rows, { search: 'zzz' }, null, T0))).toBe('search');
    expect(emptyHoldingsReason(holdingsResult([], {}, null, T0))).toBe('nothing-held');
  });

  it('maps row keys: Enter or Space opens, s records a sale, b opens the buyer; not with modifiers', () => {
    const k = (key: string, mod: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => holdingKeyAction({ key, ctrlKey: false, metaKey: false, altKey: false, ...mod });
    expect(k('Enter')).toBe('open');
    expect(k(' ')).toBe('open');
    expect(k('s')).toBe('record-sale');
    expect(k('S')).toBe('record-sale');
    expect(k('b')).toBe('buyer');
    expect(k('x')).toBeNull();
    expect(k('s', { ctrlKey: true })).toBeNull();
    expect(k('b', { altKey: true })).toBeNull();
  });
});

describe('live flash', () => {
  it('flashes rows whose profit now moved, never rows new to the list', () => {
    const prev = holdingsSnapshot([
      { sku: 'a', profitNowScrap: 10 },
      { sku: 'b', profitNowScrap: 10 },
      { sku: 'c', profitNowScrap: null },
      { sku: 'd', profitNowScrap: 5 },
      { sku: 'e', profitNowScrap: 3 },
    ]);
    const next = [
      { sku: 'a', profitNowScrap: 12 },
      { sku: 'b', profitNowScrap: 8 },
      { sku: 'c', profitNowScrap: 4 },
      { sku: 'd', profitNowScrap: null },
      { sku: 'e', profitNowScrap: 3 },
      { sku: 'new', profitNowScrap: 50 },
    ];
    expect([...diffHoldingsFlash(prev, next)]).toEqual([
      ['a', 'up'],
      ['b', 'down'],
      ['c', 'up'],
      ['d', 'down'],
    ]);
    expect(diffHoldingsFlash(null, next).size).toBe(0);
  });
});
