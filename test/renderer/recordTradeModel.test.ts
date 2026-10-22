// F12 Record trade dialog rules: the prefill, the checks before 'journal.add',
// the live comparison (a buy against Pay up to, a sale against the next FIFO
// lot, judged like the Holdings row), the toast text and the focus-trap walk.
// Pure; no network.

import { describe, expect, it } from 'vitest';
import { maxCostFor } from '../../src/shared/ceiling';
import { parsePrice } from '../../src/shared/currency';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { holdingFigures } from '../../src/shared/holdings';
import { journalSummary } from '../../src/shared/journal';
import type { ItemRevenue, JournalEntry, JournalSide, OrderSummary } from '../../src/shared/types';
import { fmtDate, fmtDateTime, toDateTimeLocal } from '../../src/renderer/format';
import {
  FEE_FIELD_HINT,
  FEE_UNREADABLE,
  FUTURE_SLACK_MS,
  LOT_AFTER_WRITE_OFF_TEXT,
  MAX_NOTE_CHARS,
  MAX_VENUE_CHARS,
  NO_LOT_WRITE_OFF_TEXT,
  VENUE_SUGGESTIONS,
  afterDialogClose,
  bookedValue,
  buyComparison,
  checkEdit,
  checkTrade,
  compareTextClass,
  defaultVenue,
  detailParams,
  dialogTitle,
  editComparison,
  editLockedText,
  editTitle,
  editUndoneText,
  editedText,
  feeHint,
  feePrefillText,
  holdingFor,
  initialPriceText,
  initialTradeForm,
  isTabbable,
  journalUndoPatch,
  lotPhrase,
  readFee,
  recordedText,
  saleAtLessFee,
  sellComparison,
  sideWord,
  tabbablesWithin,
  typedEditFee,
  typedPrice,
  typedValueScrap,
  undoneText,
  venueForSide,
  waitingAmountHeader,
  waitingBuyTitle,
  waitingCounts,
  waitingSalesText,
  waitingTitle,
  writeoffComparison,
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
    // 0.9 (#2): mannco.store joins the journal venues.
    expect(VENUE_SUGGESTIONS).toEqual(['scrap.tf', 'backpack.tf', 'marketplace.tf', 'mannco.store', 'Steam Community Market', 'Direct trade', 'other']);
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

// ---------------------------------------------------------------------------
// 0.8: fees (J2), write-offs and edit (J6)
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

function entry(over: Partial<JournalEntry> & Pick<JournalEntry, 'id' | 'side'>): JournalEntry {
  return { ts: T0 - DAY, venue: 'scrap.tf', sku: ITEM.sku, name: ITEM.name, keys: 0, scrap: 40, keyPriceScrap: KEY, note: null, ...over };
}

describe('0.8 fees (J2)', () => {
  it('reads a typed fee: empty is not recorded, 0 is none, anything unreadable is an error', () => {
    expect(readFee('')).toEqual({ fee: null, error: null });
    expect(readFee(undefined)).toEqual({ fee: null, error: null });
    expect(readFee('  ')).toEqual({ fee: null, error: null });
    expect(readFee('0')).toEqual({ fee: { keys: 0, scrap: 0 }, error: null });
    expect(readFee('0.22')).toEqual({ fee: { keys: 0, scrap: 2 }, error: null });
    expect(readFee('2', 'scrap')).toEqual({ fee: { keys: 0, scrap: 2 }, error: null });
    expect(readFee('1 key 0.11')).toEqual({ fee: { keys: 1, scrap: 1 }, error: null });
    expect(readFee('lots')).toEqual({ fee: null, error: FEE_UNREADABLE });
    expect(readFee('99999 keys').error).toMatch(/higher than any trade/);
  });

  it("adds the fee to journal.add's params after the price and venue checks; an empty fee adds no keys", () => {
    const withFee = checkTrade(form({ side: 'sell', venue: 'marketplace.tf', text: '6.66', feeText: '0.66' }), ITEM, T0);
    expect(withFee).toMatchObject({ ok: true, input: { side: 'sell', keys: 0, scrap: 60, feeKeys: 0, feeScrap: 6 } });
    const none = checkTrade(form({ feeText: '' }), ITEM, T0);
    expect(none.ok && 'feeKeys' in none.input).toBe(false);
    expect(none.ok && 'feeScrap' in none.input).toBe(false);
    expect(checkTrade(form({ feeText: '0' }), ITEM, T0)).toMatchObject({ ok: true, input: { feeKeys: 0, feeScrap: 0 } });
    expect(checkTrade(form({ feeText: '1 key', feeUnit: 'ref' }), ITEM, T0)).toMatchObject({ ok: true, input: { feeKeys: 1, feeScrap: 0 } });
    expect(checkTrade(form({ feeText: 'lots' }), ITEM, T0)).toEqual({ ok: false, field: 'fee', error: FEE_UNREADABLE });
    // The price and the venue are checked first.
    expect(checkTrade(form({ text: '', feeText: 'lots' }), ITEM, T0)).toMatchObject({ ok: false, field: 'price' });
    expect(checkTrade(form({ venue: ' ', feeText: 'lots' }), ITEM, T0)).toMatchObject({ ok: false, field: 'venue' });
  });

  it("hints at the venue's fee (text only), else the generic hint", () => {
    expect(feeHint('scrap.tf', 'buy')).toMatch(/^scrap\.tf charges no documented fee/);
    expect(feeHint('mp.tf', 'sell')).toMatch(/^marketplace\.tf keeps about 10%/);
    expect(feeHint('marketplace.tf', 'buy')).toBe(FEE_FIELD_HINT);
    expect(feeHint('My friend', 'sell')).toBe(FEE_FIELD_HINT);
  });

  it('books a typed value as the journal does: a buy adds its fee, a sale takes it off', () => {
    expect(bookedValue('buy', 100, null, KEY)).toBe(100);
    expect(bookedValue('buy', 100, { keys: 0, scrap: 2 }, KEY)).toBe(102);
    expect(bookedValue('sell', 100, { keys: 0, scrap: 2 }, KEY)).toBe(98);
    expect(bookedValue('sell', 1000, { keys: 1, scrap: 0 }, KEY)).toBe(1000 - KEY);
    expect(bookedValue('sell', 100, { keys: 1, scrap: 0 }, null)).toBeNull();
    expect(bookedValue('buy', null, { keys: 0, scrap: 2 }, KEY)).toBeNull();
    expect(bookedValue('writeoff', 0, { keys: 0, scrap: 5 }, KEY)).toBe(0);
    const at = { keys: 2, scrap: 10, keyScrap: 540 };
    expect(saleAtLessFee(null, { keys: 0, scrap: 1 })).toBeNull();
    expect(saleAtLessFee(at, null)).toBe(at);
    expect(saleAtLessFee(at, { keys: 1, scrap: 3 })).toEqual({ keys: 1, scrap: 7, keyScrap: 540 });
  });

  it('a sale fee lowers the previewed profit to what the journal books', () => {
    const held = { qty: 1, nextLotCostScrap: 40, heldSince: T0 - 3 * DAY, revenueScrap: 70, revenueOrder: order(70), nextLotKeys: 0, nextLotScrapRaw: 40 };
    const c = sellComparison(bookedValue('sell', 70, { keys: 0, scrap: 2 }, KEY), held, P, KEY, T0);
    const booked = journalSummary([entry({ id: 1, side: 'buy', ts: T0 - 3 * DAY }), entry({ id: 2, side: 'sell', scrap: 70, ts: T0, feeKeys: 0, feeScrap: 2 })]).closed[0]!;
    expect(c.bookedScrap).toBe(booked.profitScrap);
    expect(c.bookedScrap).toBe(28);
  });
});

describe('0.8 sellComparison states what the journal books', () => {
  const held = { qty: 2, nextLotCostScrap: 40, heldSince: T0 - 3 * DAY, revenueScrap: 70, revenueOrder: order(70) };
  const P9 = { ...P, frictionScrap: 9 };
  const lot = 'the lot you bought 3 d ago for 4.44 ref';
  const fr = (profit: string) => ` That is ${profit} after your 1.00 ref per-trade friction.`;

  it('with friction 9, the text shows the booked figure and the friction-judged one, and the status is judged with friction', () => {
    for (const sale of [70, 55, 45, 40, 30]) {
      const c = sellComparison(sale, held, P9, KEY, T0);
      const row = holdingFigures({ revenueScrap: sale, qty: 1, costScrap: 40, nextLotCostScrap: 40 }, P9);
      expect(c.profitScrap).toBe(row.profitNowScrap);
      expect(c.status).toBe(row.status);
      expect(c.bookedScrap).toBe(sale - 40);
    }
    expect(sellComparison(70, held, P9, KEY, T0)).toMatchObject({ status: 'sell', tone: 'good', text: `Profit +3.33 ref on ${lot}.${fr('+2.33 ref')}` });
    expect(sellComparison(55, held, P9, KEY, T0)).toMatchObject({ status: 'hold', tone: 'warn', text: `Profit +1.66 ref on ${lot}, under your minimum.${fr('+0.66 ref')}` });
    expect(sellComparison(45, held, P9, KEY, T0)).toMatchObject({ status: 'loss', tone: 'bad', text: `Profit +0.55 ref on ${lot}, a loss after your 1.00 ref per-trade friction.` });
    expect(sellComparison(40, held, P9, KEY, T0)).toMatchObject({ status: 'loss', tone: 'bad', text: `Breaks even on ${lot}.` });
    expect(sellComparison(30, held, P9, KEY, T0)).toMatchObject({ status: 'loss', tone: 'bad', text: `A loss of 1.11 ref on ${lot}.${fr('-2.11 ref')}` });
  });

  it('at the default friction of 0 the texts are as before, and booked equals the profit', () => {
    expect(sellComparison(70, held, P, KEY, T0)).toMatchObject({ profitScrap: 30, bookedScrap: 30, text: `Profit +3.33 ref on ${lot}.` });
    expect(sellComparison(null, held, P, KEY, T0).bookedScrap).toBeNull();
    expect(sellComparison(70, null, P, KEY, T0).bookedScrap).toBeNull();
    expect(lotPhrase(T0 - 3 * DAY, 40, KEY, T0, '')).toBe(lot);
    expect(lotPhrase(null, 40, KEY, T0, " (at today's key price)")).toBe("the lot you bought for 4.44 ref (at today's key price)");
  });
});

describe('0.8 write-offs', () => {
  it('checks a write-off without a price or fee: keys and scrap 0, venue Written off', () => {
    const r = checkTrade(form({ side: 'writeoff', venue: '', text: 'lots', feeText: 'lots', note: ' lost it ' }), ITEM, T0);
    expect(r).toEqual({
      ok: true,
      input: { side: 'writeoff', venue: 'Written off', sku: ITEM.sku, name: ITEM.name, keys: 0, scrap: 0, ts: new Date(toDateTimeLocal(T0)).getTime(), note: 'lost it' },
    });
    // The When and backfill key price checks run as for a sale.
    expect(checkTrade(form({ side: 'writeoff', text: '', when: toDateTimeLocal(T0 + FUTURE_SLACK_MS + 60_000) }), ITEM, T0)).toMatchObject({ ok: false, field: 'when' });
    const back = checkTrade(form({ side: 'writeoff', text: '', when: toDateTimeLocal(T0 - 2 * DAY), keyText: '60' }), ITEM, T0, KEY);
    expect(back).toMatchObject({ ok: true, input: { keys: 0, scrap: 0, keyPriceScrap: 540 } });
  });

  it('moves the venue to Written off and back to the side default', () => {
    expect(defaultVenue('writeoff')).toBe('Written off');
    expect(venueForSide('scrap.tf', 'writeoff')).toBe('Written off');
    expect(venueForSide('My friend', 'writeoff')).toBe('Written off');
    expect(venueForSide('Written off', 'buy')).toBe('scrap.tf');
    expect(venueForSide(' Written off ', 'sell')).toBe('backpack.tf');
    expect(initialTradeForm({ side: 'writeoff', ...ITEM }, T0)).toMatchObject({ side: 'writeoff', venue: 'Written off', text: '' });
    expect(initialTradeForm({ side: 'hold' as JournalSide, ...ITEM }, T0)).toMatchObject({ side: 'buy', venue: 'scrap.tf' });
  });

  it('titles and toasts a write-off', () => {
    expect(dialogTitle('writeoff')).toBe('Write off');
    expect(editTitle('buy')).toBe('Edit buy');
    expect(editTitle('sell')).toBe('Edit sale');
    expect(editTitle('writeoff')).toBe('Edit write-off');
    expect([sideWord('buy'), sideWord('sell'), sideWord('writeoff')]).toEqual(['buy', 'sale', 'write-off']);
    expect(recordedText({ side: 'writeoff', name: 'Ghastly Gibus', keys: 0, scrap: 0 })).toBe('Recorded a write-off of Ghastly Gibus.');
    expect(undoneText({ side: 'writeoff', name: 'Ghastly Gibus' })).toBe('Removed the write-off of Ghastly Gibus from your journal.');
    expect(undoneText({ side: 'sell', name: 'Strange Knife' })).toBe('Removed the sale of Strange Knife from your journal.');
  });

  it("books the lot's cost as the loss, at the key price then for a backfill, exactly as journalSummary does", () => {
    const held = { qty: 2, nextLotCostScrap: 40, heldSince: T0 - 3 * DAY, revenueScrap: 70, revenueOrder: order(70), nextLotKeys: 0, nextLotScrapRaw: 40 };
    const c = writeoffComparison(held, P, KEY, T0, T0, null);
    expect(c).toMatchObject({ heldQty: 2, lotCostScrap: 40, profitScrap: -40, bookedScrap: -40, status: 'loss', tone: 'bad', bestNowScrap: 70 });
    expect(c.text).toBe('Writes off the lot you bought 3 d ago for 4.44 ref: a loss of 4.44 ref. Nothing is sold.');

    // A key-paid lot written off in a backfill: valued at the key price then, as the journal books it.
    const keyLot = { ...held, nextLotKeys: 1, nextLotScrapRaw: 5, nextLotCostScrap: KEY + 5 };
    const back = writeoffComparison(keyLot, P, KEY, T0, T0 - 2 * DAY, 540);
    const booked = journalSummary([
      entry({ id: 1, side: 'buy', keys: 1, scrap: 5, keyPriceScrap: 560, ts: T0 - 3 * DAY }),
      entry({ id: 2, side: 'writeoff', keys: 0, scrap: 0, keyPriceScrap: 540, ts: T0 - 2 * DAY }),
    ]).closed[0]!;
    expect(back.bookedScrap).toBe(booked.profitScrap);
    expect(back).toMatchObject({ lotCostScrap: 545, profitScrap: -545, atKeyScrap: 540 });
    expect(back.text).toMatch(/a loss of 1 key 0\.55 ref\. Nothing is sold\.$/);

    // A lot without its own currencies keeps today's math, said so.
    const plain = writeoffComparison({ ...held, nextLotKeys: undefined, nextLotScrapRaw: undefined }, P, KEY, T0, T0 - 2 * DAY, 540);
    expect(plain.text).toContain("(at today's key price)");
  });

  it('with no lot before it, waits like a sale and says so', () => {
    expect(writeoffComparison(null, P, KEY, T0, T0, null)).toMatchObject({ heldQty: 0, profitScrap: null, bookedScrap: null, status: null, tone: 'muted', text: NO_LOT_WRITE_OFF_TEXT });
    const held = { qty: 1, nextLotCostScrap: 40, heldSince: T0 - DAY, revenueScrap: null, revenueOrder: null };
    expect(writeoffComparison(held, P, KEY, T0, T0 - 2 * DAY, null)).toMatchObject({ heldQty: 0, text: LOT_AFTER_WRITE_OFF_TEXT });
  });
});

describe('0.8 edit (J6)', () => {
  const buy = entry({ id: 1, side: 'buy', ts: T0 - 3 * DAY, venue: 'scrap.tf' });
  const sale = entry({ id: 2, side: 'sell', scrap: 70, ts: T0 - DAY, venue: 'backpack.tf', note: 'to a bot' });
  const pair = journalSummary([buy, sale]).closed[0]!;

  it('opens on the row itself, its fee written as typed', () => {
    const withFee = { ...sale, feeKeys: 0, feeScrap: 2 };
    expect(initialTradeForm({ side: 'sell', ...ITEM, editOf: withFee }, T0)).toEqual({
      side: 'sell',
      venue: 'backpack.tf',
      text: '7.77 ref',
      unit: 'ref',
      when: toDateTimeLocal(sale.ts),
      note: 'to a bot',
      feeText: '0.22 ref',
      feeUnit: 'ref',
    });
    expect(initialTradeForm({ side: 'buy', ...ITEM, editOf: buy }, T0)).toMatchObject({ feeText: '', note: '' });
  });

  it('patches only the changed venue, note and fee ({} when nothing changed)', () => {
    const unchanged = initialTradeForm({ side: 'sell', ...ITEM, editOf: sale }, T0);
    expect(checkEdit(unchanged, sale)).toEqual({ ok: true, patch: {} });
    const withFee = { ...sale, feeKeys: 0, feeScrap: 2 };
    expect(checkEdit(initialTradeForm({ side: 'sell', ...ITEM, editOf: withFee }, T0), withFee)).toEqual({ ok: true, patch: {} });
    expect(checkEdit({ ...unchanged, venue: ' marketplace.tf ' }, sale)).toEqual({ ok: true, patch: { venue: 'marketplace.tf' } });
    expect(checkEdit({ ...unchanged, note: '  ' }, sale)).toEqual({ ok: true, patch: { note: null } });
    expect(checkEdit({ ...unchanged, feeText: '0.22' }, sale)).toEqual({ ok: true, patch: { feeKeys: 0, feeScrap: 2 } });
    expect(checkEdit({ ...unchanged, feeText: '' }, withFee)).toEqual({ ok: true, patch: { feeKeys: null, feeScrap: null } });
    expect(checkEdit({ ...unchanged, feeText: 'lots' }, sale)).toEqual({ ok: false, field: 'fee', error: FEE_UNREADABLE });
    expect(checkEdit({ ...unchanged, venue: '' }, sale)).toMatchObject({ ok: false, field: 'venue' });
    expect(checkEdit({ ...unchanged, venue: 'v'.repeat(MAX_VENUE_CHARS + 1) }, sale)).toMatchObject({ ok: false, field: 'venue' });
    // A write-off checks its note only (it has no venue to type and takes no fee).
    const w = entry({ id: 3, side: 'writeoff', scrap: 0, venue: 'Written off' });
    expect(checkEdit({ venue: '', note: ' lost ', feeText: 'lots' }, w)).toEqual({ ok: true, patch: { note: 'lost' } });
  });

  it("undoes with the row's old values, and words the toasts", () => {
    expect(journalUndoPatch({ ...sale, feeKeys: 0, feeScrap: 2 })).toEqual({ venue: 'backpack.tf', note: 'to a bot', feeKeys: 0, feeScrap: 2 });
    expect(journalUndoPatch(buy)).toEqual({ venue: 'scrap.tf', note: null, feeKeys: null, feeScrap: null });
    expect(editedText(sale)).toBe('Updated the sale of Strange Knife.');
    expect(editUndoneText({ side: 'writeoff', name: 'Ghastly Gibus' })).toBe('Restored the write-off of Ghastly Gibus.');
  });

  it('says what an edit cannot change', () => {
    const keyBuy = entry({ id: 4, side: 'buy', keys: 2, scrap: 46, keyPriceScrap: 568 });
    expect(editLockedText(keyBuy)).toBe(`Bought for 2 keys 5.11 ref on ${fmtDateTime(keyBuy.ts)} (key at 63.11 ref). To change the price or time, delete this trade and log it again.`);
    expect(editLockedText(sale)).toBe(`Sold for 7.77 ref on ${fmtDateTime(sale.ts)}. To change the price or time, delete this trade and log it again.`);
    expect(editLockedText(entry({ id: 5, side: 'writeoff', scrap: 0 }))).toBe(`Written off on ${fmtDateTime(T0 - DAY)}. To change the time, delete it and log it again.`);
  });

  it('compares the booked profit before and after the typed fee', () => {
    expect(pair.profitScrap).toBe(30);
    expect(editComparison(sale, { feeText: '0.22' }, { closed: pair, other: buy })).toEqual({
      tone: 'good',
      text: `This sale books +3.11 ref on the buy of ${fmtDate(buy.ts)} (scrap.tf) (was +3.33 ref).`,
    });
    expect(editComparison(sale, { feeText: '' }, { closed: pair, other: buy })).toEqual({ tone: 'good', text: `This sale books +3.33 ref on the buy of ${fmtDate(buy.ts)} (scrap.tf).` });
    expect(editComparison(buy, { feeText: '4.44' }, { closed: pair, other: sale })).toEqual({ tone: 'bad', text: `Its sale of ${fmtDate(sale.ts)} books -1.11 ref (was +3.33 ref).` });
    expect(editComparison(buy, { feeText: '3.33' }, { closed: pair, other: sale }).tone).toBe('muted');
    const w = entry({ id: 6, side: 'writeoff', scrap: 0, ts: T0 - DAY, venue: 'Written off' });
    const wPair = journalSummary([buy, w]).closed[0]!;
    expect(editComparison(w, { feeText: '' }, { closed: wPair, other: buy })).toEqual({ tone: 'bad', text: `This write-off books -4.44 ref on the buy of ${fmtDate(buy.ts)} (scrap.tf).` });
    expect(editComparison(buy, { feeText: '' }, { closed: wPair, other: w }).text).toBe(`Its write-off of ${fmtDate(w.ts)} books -4.44 ref.`);
  });

  it('keeps a recorded fee of more than 2 key decimals: opening Edit and saving rewrites nothing', () => {
    // Review fix: the prefill used formatKeysMetal ('0.13 keys'), so a save that touched nothing patched 0.13.
    const fee = { ...sale, feeKeys: 0.125, feeScrap: 0 };
    const opened = initialTradeForm({ side: 'sell', ...ITEM, editOf: fee }, T0);
    expect(opened.feeText).toBe('0.125 keys');
    expect(parsePrice(opened.feeText!, 'ref')).toMatchObject({ keys: 0.125, scrap: 0 });
    expect(checkEdit(opened, fee)).toEqual({ ok: true, patch: {} });
    expect(checkEdit({ ...opened, note: 'typo fixed' }, fee)).toEqual({ ok: true, patch: { note: 'typo fixed' } });
    // The unit toggle does not matter for a prefill written with units.
    expect(checkEdit({ ...opened, feeUnit: 'scrap' }, fee)).toEqual({ ok: true, patch: {} });
    // A typed change still goes through readFee.
    expect(checkEdit({ ...opened, feeText: '0.13 keys' }, fee)).toEqual({ ok: true, patch: { feeKeys: 0.13, feeScrap: 0 } });
    const feePair = journalSummary([buy, fee]).closed[0]!;
    expect(editComparison(fee, opened, { closed: feePair, other: buy }).text).not.toContain('(was');
    // Keys and metal together, and a key count with both exact and exponent forms.
    expect(feePrefillText({ keys: 1.375, scrap: 5 })).toBe('1.375 keys 0.55 ref');
    expect(feePrefillText({ keys: 1, scrap: 0 })).toBe('1 key');
    expect(feePrefillText({ keys: 0, scrap: 2 })).toBe('0.22 ref');
    expect(feePrefillText({ keys: 0, scrap: 0 })).toBe('0.00 ref');
    expect(feePrefillText(null)).toBe('');
    const tiny = { ...sale, feeKeys: 1e-7, feeScrap: 0 };
    const tinyForm = initialTradeForm({ side: 'sell', ...ITEM, editOf: tiny }, T0);
    expect(checkEdit(tinyForm, tiny)).toEqual({ ok: true, patch: {} });
    expect(typedEditFee(tinyForm, tiny)).toEqual({ fee: { keys: 1e-7, scrap: 0 }, error: null });
  });

  it("keeps the booked pair when its other row is not on the page (newest 2000 rows): never 'no recorded buy'", () => {
    const fee = { ...sale, feeKeys: 0, feeScrap: 2 };
    const feePair = journalSummary([buy, fee]).closed[0]!;
    const opened = initialTradeForm({ side: 'sell', ...ITEM, editOf: fee }, T0);
    expect(editComparison(fee, opened, { closed: feePair, other: null })).toEqual({ tone: 'good', text: `This sale books +3.11 ref on the buy of ${fmtDate(buy.ts)} (scrap.tf).` });
    const changed = editComparison(fee, { ...opened, feeText: '0.44' }, { closed: feePair, other: null });
    expect(changed).toEqual({
      tone: 'muted',
      text: `This sale books +3.11 ref on the buy of ${fmtDate(buy.ts)} (scrap.tf) with the fee as recorded. That buy is not among the trades loaded here, so the profit with this fee is worked out when you save.`,
    });
    expect(changed.text).not.toContain('no recorded buy');
    expect(editComparison(buy, { feeText: '0.22' }, { closed: pair, other: null }).text).toBe(
      `Its sale of ${fmtDate(sale.ts)} books +3.33 ref with the fee as recorded. That sale is not among the trades loaded here, so the profit with this fee is worked out when you save.`,
    );
    const w = entry({ id: 8, side: 'writeoff', scrap: 0, ts: T0 - DAY, venue: 'Written off' });
    const wPair = journalSummary([buy, w]).closed[0]!;
    expect(editComparison(w, { feeText: '' }, { closed: wPair, other: null })).toEqual({ tone: 'bad', text: `This write-off books -4.44 ref on the buy of ${fmtDate(buy.ts)} (scrap.tf).` });
  });

  it('says why there is nothing to compare', () => {
    expect(editComparison(sale, { feeText: 'lots' }, { closed: pair, other: buy })).toEqual({ tone: 'muted', text: "Can't read that fee yet, so there is nothing to compare." });
    expect(editComparison(buy, { feeText: '' }, null).text).toBe("Still held: its fee is part of the lot's cost, so Holdings and its sale's profit include it.");
    expect(editComparison(sale, { feeText: '' }, null).text).toBe('This sale has no recorded buy before it, so it books no profit yet.');
    expect(editComparison(entry({ id: 7, side: 'writeoff', scrap: 0 }), { feeText: '' }, null).text).toBe('This write-off has no recorded buy before it, so it books no profit yet.');
  });
});

describe('0.8 waiting write-offs are named as write-offs, never as sales', () => {
  // A write-off with no lot waits in JournalSummary.waitingSales with writeoff: true.
  const sold = entry({ id: 1, side: 'sell', scrap: 60, ts: T0 - 2 * DAY });
  const lost = entry({ id: 2, side: 'writeoff', scrap: 0, ts: T0 - DAY, venue: 'Written off' });

  it('counts sales and write-offs apart', () => {
    expect(waitingCounts(journalSummary([lost]).waitingSales)).toEqual({ sales: 0, writeoffs: 1 });
    expect(waitingCounts(journalSummary([sold, lost]).waitingSales)).toEqual({ sales: 1, writeoffs: 1 });
    expect(waitingCounts(journalSummary([sold]).waitingSales)).toEqual({ sales: 1, writeoffs: 0 });
    expect(waitingCounts(undefined)).toEqual({ sales: 0, writeoffs: 0 });
  });

  it('words the help, the heading and the Record its buy tooltip for what is waiting', () => {
    // Sales only: as in 0.7.4.
    expect(waitingSalesText(1)).toBe(waitingSalesText(1, 0));
    expect(waitingSalesText(1)).toMatch(/^A sale in your journal has no buy/);
    expect(waitingSalesText(0, 0)).toBeNull();
    const one = waitingSalesText(0, 1)!;
    expect(one).toBe(
      'A write-off in your journal has no buy of the item dated before it, so it counts as neither a loss nor a holding, and a later buy is never matched to it (that is another copy). To match one, record its buy dated before the write-off.',
    );
    expect(one).not.toMatch(/\bsale\b/);
    expect(waitingSalesText(0, 2)).toMatch(/^2 write-offs in your journal have no buy of the item dated before them, so they count as neither a loss nor a holding/);
    expect(waitingSalesText(1, 1)).toBe(
      '1 sale and 1 write-off in your journal have no buy of the item dated before them, so none of them counts as profit, loss or a holding, and a later buy is never matched to them (that is another copy). To match one, record its buy dated before the sale or write-off.',
    );
    expect(waitingTitle(1, 0)).toBe('Sales without a recorded buy');
    expect(waitingTitle(0, 1)).toBe('Write-offs without a recorded buy');
    expect(waitingTitle(2, 1)).toBe('Sales and write-offs without a recorded buy');
    expect(waitingBuyTitle({})).toBe('Record the buy of the copy you sold, dated just before the sale, so the two are matched');
    expect(waitingBuyTitle({ writeoff: true })).toBe('Record the buy of the copy you wrote off, dated just before the write-off, so the two are matched');
  });

  it('heads the amount column for what is waiting: "Sold for" only over sales (review: no "Sold for" over a write-off)', () => {
    // Sales only: as in 0.7.4.
    expect(waitingAmountHeader(1, 0)).toBe('Sold for');
    expect(waitingAmountHeader(3, 0)).toBe('Sold for');
    expect(waitingAmountHeader(2, 1)).toBe('Sold for / written off');
    expect(waitingAmountHeader(0, 1)).toBe('Recorded as');
    expect(waitingAmountHeader(0, 2)).not.toMatch(/\bsold\b/i);
  });
});
