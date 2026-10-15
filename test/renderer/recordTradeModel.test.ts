// F12 Record trade dialog rules: the prefill, the checks before 'journal.add',
// the live comparison (a buy against Pay up to, a sale against the next FIFO
// lot, judged like the Holdings row), the toast text and the focus-trap walk.
// Pure; no network.

import { describe, expect, it } from 'vitest';
import { maxCostFor } from '../../src/shared/ceiling';
import { parsePrice } from '../../src/shared/currency';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { holdingFigures } from '../../src/shared/holdings';
import type { ItemRevenue, OrderSummary } from '../../src/shared/types';
import { toDateTimeLocal } from '../../src/renderer/format';
import {
  FUTURE_SLACK_MS,
  MAX_NOTE_CHARS,
  MAX_VENUE_CHARS,
  VENUE_SUGGESTIONS,
  afterDialogClose,
  buyComparison,
  checkTrade,
  compareTextClass,
  defaultVenue,
  detailParams,
  dialogTitle,
  holdingFor,
  initialPriceText,
  initialTradeForm,
  isTabbable,
  recordedText,
  sellComparison,
  tabbablesWithin,
  typedPrice,
  typedValueScrap,
  undoneText,
  venueForSide,
  type FocusNode,
  type TradeForm,
} from '../../src/renderer/recordTradeModel';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const KEY = 568;
const P = { ...DEFAULT_SETTINGS.profit };
const ITEM = { sku: '194;11', name: 'Strange Knife' };

function order(valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: `l${valueScrap}`,
    steamid: '76561198000000001',
    userName: 'Buyer Bot',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: true,
    online: true,
    lastEventAt: T0,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function revenue(revenueScrap: number | null, over: Partial<ItemRevenue> = {}): ItemRevenue {
  return {
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: revenueScrap,
    useOrder: P.useOrder,
    revenueScrap,
    order: revenueScrap === null ? null : order(revenueScrap),
    maxCostScrap: maxCostFor(revenueScrap, P),
    eligibleCount: revenueScrap === null ? 0 : 3,
    ...over,
  };
}

function form(over: Partial<TradeForm> = {}): TradeForm {
  return { side: 'buy', venue: 'scrap.tf', text: '1.33', unit: 'ref', when: toDateTimeLocal(T0), note: '', ...over };
}

describe('prefill', () => {
  it('writes the price as the user would type it, and parses back to the same keys and metal', () => {
    expect(initialPriceText({ keys: 0, scrap: 12 })).toBe('1.33 ref');
    expect(initialPriceText({ keys: 2, scrap: 46 })).toBe('2 keys 5.11 ref');
    expect(initialPriceText({ keys: 1 })).toBe('1 key');
    expect(initialPriceText({})).toBe('');
    expect(initialPriceText({ keys: 0, scrap: 0 })).toBe('');
    expect(initialPriceText({ keys: Number.NaN, scrap: -4 })).toBe('');
    for (const [keys, scrap] of [
      [0, 12],
      [2, 46],
      [1, 0],
      [3, 1],
    ] as const) {
      const p = parsePrice(initialPriceText({ keys, scrap }), 'ref');
      expect(p).toMatchObject({ keys, scrap });
    }
  });

  it('defaults the venue by side and keeps the rest of the prefill', () => {
    expect(defaultVenue('buy')).toBe('scrap.tf');
    expect(defaultVenue('sell')).toBe('backpack.tf');
    const f = initialTradeForm({ side: 'sell', ...ITEM, keys: 0, scrap: 60, note: '  Sold to Buyer Bot ' }, T0);
    expect(f).toEqual({ side: 'sell', venue: 'backpack.tf', text: '6.66 ref', unit: 'ref', when: toDateTimeLocal(T0), note: 'Sold to Buyer Bot' });
    expect(initialTradeForm({ side: 'buy', ...ITEM, venue: 'marketplace.tf' }, T0)).toMatchObject({ venue: 'marketplace.tf', text: '' });
    expect(initialTradeForm({ side: 'buy', ...ITEM, venue: '   ' }, T0).venue).toBe('scrap.tf');
    expect(initialTradeForm({ side: 'buy', ...ITEM, note: 'x'.repeat(900) }, T0).note).toHaveLength(MAX_NOTE_CHARS);
  });

  it('moves only the default venue when the side changes', () => {
    expect(venueForSide('scrap.tf', 'sell')).toBe('backpack.tf');
    expect(venueForSide('backpack.tf', 'buy')).toBe('scrap.tf');
    expect(venueForSide('Steam', 'sell')).toBe('Steam');
    expect(venueForSide('backpack.tf', 'sell')).toBe('backpack.tf');
  });

  it('suggests the spec venues and asks item.detail for a local, plain read', () => {
    expect(VENUE_SUGGESTIONS).toEqual(['scrap.tf', 'backpack.tf', 'marketplace.tf', 'Steam', 'other']);
    expect(detailParams('5021;6')).toEqual({ sku: '5021;6', history: false, target: 'plain' });
  });
});

describe('checkTrade', () => {
  it('builds the journal.add params', () => {
    const r = checkTrade(form({ side: 'sell', venue: ' backpack.tf ', text: '2 keys 5.11', note: ' Sold to X ' }), ITEM, T0);
    expect(r).toEqual({ ok: true, input: { side: 'sell', venue: 'backpack.tf', sku: '194;11', name: 'Strange Knife', keys: 2, scrap: 46, ts: new Date(toDateTimeLocal(T0)).getTime(), note: 'Sold to X' } });
  });

  it('reads bare numbers in the chosen unit and stores an empty note as null', () => {
    const r = checkTrade(form({ text: '14', unit: 'scrap' }), ITEM, T0);
    expect(r.ok && r.input).toMatchObject({ keys: 0, scrap: 14, note: null });
  });

  it('names the first field to fix', () => {
    expect(checkTrade(form({ text: '' }), ITEM, T0)).toMatchObject({ ok: false, field: 'price', error: expect.stringMatching(/Enter the price/) });
    expect(checkTrade(form({ text: 'lots' }), ITEM, T0)).toMatchObject({ ok: false, field: 'price', error: expect.stringMatching(/Can't read/) });
    expect(checkTrade(form({ venue: '  ' }), ITEM, T0)).toMatchObject({ ok: false, field: 'venue' });
    expect(checkTrade(form({ venue: 'v'.repeat(MAX_VENUE_CHARS + 1) }), ITEM, T0)).toMatchObject({ ok: false, field: 'venue' });
    expect(checkTrade(form({ when: 'not a date' }), ITEM, T0)).toMatchObject({ ok: false, field: 'when' });
  });

  it('refuses a date in the future beyond a little clock slack, and takes now when the date is cleared', () => {
    const later = toDateTimeLocal(T0 + FUTURE_SLACK_MS + 60_000);
    expect(checkTrade(form({ when: later }), ITEM, T0)).toMatchObject({ ok: false, field: 'when', error: 'That date is in the future.' });
    expect(checkTrade(form({ when: toDateTimeLocal(T0 + 60_000) }), ITEM, T0).ok).toBe(true);
    const cleared = checkTrade(form({ when: '' }), ITEM, T0);
    expect(cleared.ok && cleared.input.ts).toBe(T0);
  });

  it('values the typed price with the key price, and not keys without one', () => {
    expect(typedValueScrap({ text: '1 key 1.33', unit: 'ref' }, KEY)).toBe(KEY + 12);
    expect(typedValueScrap({ text: '1 key', unit: 'ref' }, null)).toBeNull();
    expect(typedValueScrap({ text: '1.33', unit: 'ref' }, null)).toBe(12);
    expect(typedValueScrap({ text: '', unit: 'ref' }, KEY)).toBeNull();
    expect(typedValueScrap({ text: '??', unit: 'ref' }, KEY)).toBeNull();
  });

  it('says why a typed price has no value: empty, unreadable, or keys before a key price', () => {
    expect(typedPrice({ text: '  ', unit: 'ref' }, KEY)).toEqual({ value: null, state: 'empty' });
    expect(typedPrice({ text: '??', unit: 'ref' }, KEY)).toEqual({ value: null, state: 'unreadable' });
    expect(typedPrice({ text: '2 keys', unit: 'ref' }, null)).toEqual({ value: null, state: 'no-key-price' });
    expect(typedPrice({ text: '2 keys', unit: 'ref' }, KEY)).toEqual({ value: 2 * KEY, state: 'ok' });
    expect(typedPrice({ text: '1.33', unit: 'ref' }, null)).toEqual({ value: 12, state: 'ok' });
  });
});

describe('waiting for a usable price', () => {
  const held = { qty: 1, nextLotCostScrap: 40, heldSince: T0 - 86_400_000, revenueScrap: 70, revenueOrder: order(70) };

  it("never asks to type a price that was typed: keys without a key price can't be compared yet", () => {
    const rev = { revenue: revenue(180), buyOrders: [] };
    expect(buyComparison(null, rev, P, null, 'no-key-price')).toMatchObject({ tone: 'muted', preview: null, text: "No key price yet, so a price in keys can't be compared. It still saves as typed." });
    expect(buyComparison(null, rev, P, KEY, 'unreadable').text).toBe("Can't read that price yet, so there is nothing to compare.");
    expect(buyComparison(null, rev, P, KEY, 'empty').text).toMatch(/^Type the price you paid/);
    expect(sellComparison(null, held, P, null, T0, 'no-key-price')).toMatchObject({ tone: 'muted', heldQty: 1, lotCostScrap: 40, text: expect.stringMatching(/^No key price yet/) });
    expect(sellComparison(null, held, P, KEY, T0, 'unreadable').text).toMatch(/^Can't read that price yet/);
    expect(sellComparison(null, held, P, KEY, T0).text).toMatch(/^Type the price you sold for to see the profit on the lot you bought 1 d/);
    // Nothing held: that message wins, whatever was typed.
    expect(sellComparison(null, null, P, null, T0, 'no-key-price').text).toMatch(/^No open buy of this item/);
  });

  it('can still save keys before a key price arrives (the journal keeps keys and metal apart)', () => {
    const c = checkTrade(form({ side: 'sell', venue: 'backpack.tf', text: '2 keys 1.33' }), ITEM, T0);
    expect(c).toMatchObject({ ok: true, input: { keys: 2, scrap: 12 } });
  });
});

describe('closing', () => {
  it('a late close from an older dialog leaves the newer one open', () => {
    const a = { seq: 1 };
    const b = { seq: 2 };
    expect(afterDialogClose(a, 1)).toBeNull();
    expect(afterDialogClose(b, 1)).toBe(b);
    expect(afterDialogClose(null, 1)).toBeNull();
  });
});

describe('buyComparison', () => {
  const d = (rev: ItemRevenue | null) => ({ revenue: rev, buyOrders: [] });

  it('marks a price at or under Pay up to as a flip, with the profit if it sells now', () => {
    const rev = revenue(180);
    const ceiling = rev.maxCostScrap!;
    const c = buyComparison(ceiling - 2, d(rev), P, KEY);
    expect(c).toMatchObject({ payUpToScrap: ceiling, revenueScrap: 180, buyerCount: 3, tone: 'good' });
    expect(c.preview?.profitScrap).toBe(180 - (ceiling - 2) - P.frictionScrap);
    expect(c.text).toMatch(/^0\.22 ref under Pay up to: a flip, \+/);
    expect(buyComparison(ceiling, d(rev), P, KEY).text).toMatch(/^At Pay up to: a flip/);
  });

  it('warns over Pay up to while still in profit, and calls a loss a loss', () => {
    const rev = revenue(180);
    const ceiling = rev.maxCostScrap!;
    const over = buyComparison(ceiling + 1, d(rev), P, KEY);
    expect(over.tone).toBe('warn');
    expect(over.text).toMatch(/^0\.11 ref over Pay up to: \+.*under your minimum profit\.$/);
    const loss = buyComparison(200, d(rev), P, KEY);
    expect(loss).toMatchObject({ tone: 'bad' });
    expect(loss.text).toBe("3.77 ref over Pay up to: a loss of 2.22 ref at today's buyers.");
    // Zero profit is no gain, but not a loss either.
    expect(buyComparison(180, d(rev), P, KEY)).toMatchObject({ tone: 'bad', text: "1.55 ref over Pay up to: it only breaks even at today's buyers." });
  });

  it('is quiet without buyers or without a price', () => {
    expect(buyComparison(10, d(revenue(null)), P, KEY)).toMatchObject({ tone: 'muted', payUpToScrap: null, preview: null, text: expect.stringMatching(/No eligible backpack\.tf buyer/) });
    expect(buyComparison(10, null, P, KEY)).toMatchObject({ tone: 'muted', preview: null });
    expect(buyComparison(null, d(revenue(180)), P, KEY)).toMatchObject({ tone: 'muted', preview: null, text: expect.stringMatching(/Type the price you paid/) });
  });

  it('prices from the book when the service sent no revenue (same picks as the engine)', () => {
    const c = buyComparison(50, { revenue: null, buyOrders: [order(120), order(90, { eligible: false })] }, P, KEY);
    expect(c.revenueScrap).toBe(120);
    expect(c.buyerCount).toBe(1);
  });
});

describe('sellComparison', () => {
  const held = { qty: 2, nextLotCostScrap: 40, heldSince: T0 - 3 * 86_400_000, revenueScrap: 70, revenueOrder: order(70) };

  it('judges a sale on the next lot exactly like the Holdings row', () => {
    for (const sale of [70, 45, 41, 40, 20]) {
      const c = sellComparison(sale, held, P, KEY, T0);
      const row = holdingFigures({ revenueScrap: sale, qty: 1, costScrap: 40, nextLotCostScrap: 40 }, P);
      expect(c.profitScrap).toBe(row.profitNowScrap);
      expect(c.status).toBe(row.status);
    }
  });

  it('says which lot it closes and how the sale compares', () => {
    const good = sellComparison(70, held, P, KEY, T0);
    expect(good).toMatchObject({ heldQty: 2, lotCostScrap: 40, lotTs: held.heldSince, status: 'sell', tone: 'good', bestNowScrap: 70 });
    expect(good.text).toBe('Profit +3.33 ref on the lot you bought 3 d ago for 4.44 ref.');
    expect(sellComparison(41, held, P, KEY, T0)).toMatchObject({ status: 'hold', tone: 'warn', text: expect.stringMatching(/under your minimum\.$/) });
    expect(sellComparison(40 + P.frictionScrap, held, P, KEY, T0)).toMatchObject({ status: 'loss', tone: 'bad', text: expect.stringMatching(/^Breaks even/) });
    expect(sellComparison(20, held, P, KEY, T0)).toMatchObject({ status: 'loss', tone: 'bad', text: expect.stringMatching(/^A loss of 2\.22 ref/) });
    expect(sellComparison(null, held, P, KEY, T0)).toMatchObject({ profitScrap: null, status: null, tone: 'muted', text: expect.stringMatching(/^Type the price you sold for/) });
  });

  it('explains a sale with nothing held: the journal keeps it for a later buy', () => {
    const c = sellComparison(70, null, P, KEY, T0);
    expect(c).toMatchObject({ heldQty: 0, profitScrap: null, tone: 'muted' });
    expect(c.text).toMatch(/No open buy of this item/);
    expect(sellComparison(70, { ...held, qty: 0 }, P, KEY, T0).heldQty).toBe(0);
  });

  it('colours the comparison text by tone', () => {
    expect(compareTextClass('good')).toBe('tone-text-good');
    expect(compareTextClass('muted')).toBe('muted');
  });

  it('finds the open position by the journal SKU, then case-insensitively', () => {
    const rows = [{ sku: '194;11' }, { sku: '5021;6' }, { sku: '30357;5;u702' }];
    expect(holdingFor(rows, '194;11')).toBe(rows[0]);
    expect(holdingFor(rows, ' 30357;5;U702 ')).toBe(rows[2]);
    expect(holdingFor(rows, '194;1')).toBeNull();
  });
});

describe('text', () => {
  it('titles the dialog and the toasts by side', () => {
    expect(dialogTitle('buy')).toBe('Record buy');
    expect(dialogTitle('sell')).toBe('Record sale');
    expect(recordedText({ side: 'sell', name: 'Strange Knife', keys: 0, scrap: 60 })).toBe('Recorded sale of Strange Knife at 6.66 ref.');
    expect(recordedText({ side: 'buy', name: 'Team Captain', keys: 1, scrap: 10 })).toBe('Recorded buy of Team Captain at 1 key 1.11 ref.');
    expect(undoneText({ side: 'buy', name: 'Team Captain' })).toBe('Removed the buy of Team Captain from your journal.');
  });
});

describe('focus trap walk', () => {
  function el(tag: string, attrs: Record<string, string> = {}, kids: FocusNode[] = []): FocusNode & { id: string } {
    return {
      id: attrs['id'] ?? tag,
      nodeType: 1,
      tagName: tag.toUpperCase(),
      getAttribute: (n) => attrs[n] ?? null,
      hasAttribute: (n) => n in attrs,
      childNodes: kids,
    };
  }
  const text: FocusNode = { nodeType: 3 };

  it('keeps enabled controls, links and tabindex >= 0, in document order', () => {
    const root = el('div', { tabindex: '-1' }, [
      el('button', { id: 'close' }),
      text,
      el('div', {}, [
        el('button', { id: 'roving-off', tabindex: '-1' }),
        el('button', { id: 'roving-on', tabindex: '0' }),
        el('input', { id: 'venue' }),
        el('datalist', {}, [el('option')]),
      ]),
      el('input', { id: 'hidden', type: 'hidden' }),
      el('button', { id: 'disabled', disabled: '' }),
      el('a', { id: 'nohref' }),
      el('a', { id: 'link', href: '#x' }),
      el('span', { id: 'span-tab', tabindex: '0' }),
      el('textarea', { id: 'note' }),
      el('button', { id: 'save', type: 'submit' }),
    ]);
    expect(tabbablesWithin(root).map((n) => (n as { id: string }).id)).toEqual(['close', 'roving-on', 'venue', 'link', 'span-tab', 'note', 'save']);
    expect(isTabbable(root)).toBe(false);
    expect(isTabbable(text)).toBe(false);
  });
});
