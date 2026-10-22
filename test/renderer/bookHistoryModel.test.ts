// 0.9 (history, RESEARCH #6/#7): the drawer's "Order book history" texts and the scrap.tf low's lines
// (src/renderer/bookHistoryModel.ts). Order persistence is worded as order-price spells and "listed N ago", never as
// a fill rate or "at this price"; "not enough data" carries its reason; community prices are not sales; the low says
// when and since when. The bank stock price hover gains the low's sentence and is unchanged without one.

import { describe, expect, it } from 'vitest';
import { bankStockPriceTitle } from '../../src/renderer/bankStockModel';
import {
  BOOK_HISTORY_ORDERS_SHOWN,
  BOOK_HISTORY_REFRESH_MS,
  PERSISTENCE_SCOPE_SHORT,
  PERSISTENCE_SCOPE_WORDS,
  PERSISTENCE_SHORT_WORDS,
  SCRAPTF_LOW_NOTE,
  bookHistoryOrderIds,
  bookHistorySummaryText,
  bookHistorySummaryTitle,
  bookOrderWho,
  communityChartPoints,
  communityReadout,
  communitySinceText,
  fmtPersistencePct,
  orderPersistenceLine,
  scraptfLowLine,
  scraptfLowSentence,
} from '../../src/renderer/bookHistoryModel';
import { DASH, fmtDate, fmtMoney } from '../../src/renderer/format';
import { COMMUNITY_NOTE } from '../../src/shared/communityHistory';
import { ORDER_PERSISTENCE_NOTE } from '../../src/shared/orderPersistence';
import type { BankStockRow, BookOrderPersistence, CommunityHistory, CommunityHistoryStep, OrderSpellSummary, OrderSummary, ScraptfCopyLow } from '../../src/shared/types';

const K = 568;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

function summary(over: Partial<OrderSpellSummary> = {}): OrderSpellSummary {
  return { followed: 40, open: 3, deleted: 12, inactive: 0, lowered: 6, raised: 4, relisted: 0, unwatched: 15, noListedTime: 1, since: T0 - 20 * DAY, observedMs: 1000 * HOUR, ...over };
}

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: '440_76561198000000001_aaa',
    steamid: '76561198000000001',
    userName: 'Pure Buyer Bot',
    keys: 0,
    metalScrap: 100,
    valueScrap: 100,
    isBot: true,
    online: null,
    lastEventAt: T0,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function bookOrder(over: Partial<BookOrderPersistence> & { persistence: BookOrderPersistence['persistence'] }): BookOrderPersistence {
  return { listingId: 'id-1', isBot: true, valueScrap: 100, listedAt: Math.floor((T0 - 3 * HOUR) / 1000), ...over };
}

function step(over: Partial<CommunityHistoryStep> = {}): CommunityHistoryStep {
  return { at: T0 - 10 * DAY, currency: 'metal', value: 23.22, valueHigh: 29.33, lastUpdate: Math.floor((T0 - 10 * DAY) / 1000), sources: ['prices'], recordedAt: T0 - 9 * DAY, ...over };
}

describe('constants', () => {
  it('asks for at most 3 orders and refetches at most every 30 s', () => {
    expect(BOOK_HISTORY_ORDERS_SHOWN).toBe(3);
    expect(BOOK_HISTORY_REFRESH_MS).toBe(30_000);
  });

  it('words every scope and reason as order-price spells, never as fills or sales', () => {
    for (const t of [...Object.values(PERSISTENCE_SCOPE_SHORT), ...Object.values(PERSISTENCE_SCOPE_WORDS), ...Object.values(PERSISTENCE_SHORT_WORDS)]) {
      expect(t).not.toMatch(/fill|sold|sale rate|probability|chance/i);
    }
    expect(PERSISTENCE_SHORT_WORDS['few-at-risk']).toContain('order-price spells');
    expect(PERSISTENCE_SHORT_WORDS['past-the-data']).toContain('order-price spells');
    expect(PERSISTENCE_SCOPE_WORDS.all).toContain('order-price spell');
  });
});

describe('fmtPersistencePct', () => {
  it('rounds and clamps to 0..100, with a space before the sign', () => {
    expect(fmtPersistencePct(0.8234)).toBe('82 %');
    expect(fmtPersistencePct(32 / 45)).toBe('71 %');
    expect(fmtPersistencePct(-0.1)).toBe('0 %');
    expect(fmtPersistencePct(1.2)).toBe('100 %');
    expect(fmtPersistencePct(Number.NaN)).toBe(DASH);
  });
});

describe('bookHistorySummaryText / bookHistorySummaryTitle', () => {
  it('counts per end, worded as order-price spells, with "still up" covering open and unwatched', () => {
    expect(bookHistorySummaryText(summary())).toBe(
      `Followed 40 order-price spells of this item's buy orders since ${fmtDate(T0 - 20 * DAY)} (one order counts again after each price change or feed restart): 12 removed, 6 lowered, 4 raised, 18 still up when last seen.`,
    );
  });

  it('adds the inactive (D9) and re-posted (review) clauses only when there are some', () => {
    expect(bookHistorySummaryText(summary({ inactive: 2, relisted: 5 }))).toBe(
      `Followed 40 order-price spells of this item's buy orders since ${fmtDate(T0 - 20 * DAY)} (one order counts again after each price change or feed restart): 12 removed, 2 turned inactive, 6 lowered, 4 raised, 5 re-posted, 18 still up when last seen.`,
    );
    expect(bookHistorySummaryText(summary({ followed: 1, open: 1, deleted: 0, lowered: 0, raised: 0, unwatched: 0 }))).toMatch(/^Followed 1 order-price spell of /);
  });

  it('is null when nothing was followed', () => {
    expect(bookHistorySummaryText(summary({ followed: 0, since: null }))).toBeNull();
    expect(bookHistorySummaryTitle(summary({ followed: 0, since: null }))).toBeNull();
  });

  it('the hover says how far back the kept spells reach, the caps included', () => {
    expect(bookHistorySummaryTitle(summary())).toBe(
      `Kept 60 days, or less where the per-item (300) or total (400,000) caps bind: ${fmtDate(T0 - 20 * DAY)} is how far back it reaches. ${ORDER_PERSISTENCE_NOTE}`,
    );
  });
});

describe('orderPersistenceLine', () => {
  const at = `Pure Buyer Bot at ${fmtMoney(100, K)}`;

  it('without a listing time: unknown, with the reason', () => {
    const line = orderPersistenceLine(bookOrder({ listedAt: null, persistence: { ageMs: null, scope: null, windows: [], short: 'no-listed-time' } }), 'Pure Buyer Bot', K);
    expect(line).toEqual({ text: `${at} · how long it stays: unknown (backpack.tf gave no listing time for it)`, tone: 'muted', title: ORDER_PERSISTENCE_NOTE });
  });

  it('without a window: "not enough data" with its reason and the listing age', () => {
    const few = orderPersistenceLine(bookOrder({ persistence: { ageMs: 3 * HOUR, scope: null, windows: [], short: 'few-at-risk' } }), 'Pure Buyer Bot', K);
    expect(few).toEqual({ text: `${at} · listed 3 h ago · not enough data (too few order-price spells followed at its age)`, tone: 'muted', title: ORDER_PERSISTENCE_NOTE });
    const past = orderPersistenceLine(bookOrder({ persistence: { ageMs: 2 * DAY, scope: null, windows: [], short: 'past-the-data' } }), 'Human', K);
    expect(past.text).toBe(`Human at ${fmtMoney(100, K)} · listed 2 d ago · not enough data (too few order-price spells followed that long)`);
    // An absent reason reads as too few at its age.
    const none = orderPersistenceLine(bookOrder({ persistence: { ageMs: 3 * HOUR, scope: null, windows: [], short: null } }), 'Bot', K);
    expect(none.text).toContain(PERSISTENCE_SHORT_WORDS['few-at-risk']);
  });

  it('with windows: the longest one in the text, every horizon with its n in the hover', () => {
    const line = orderPersistenceLine(
      bookOrder({
        persistence: {
          ageMs: 9 * HOUR,
          scope: 'like',
          windows: [
            { horizonMs: HOUR, p: 8 / 9, atRisk: 9, minAtRisk: 9, ended: 1 },
            { horizonMs: DAY, p: 32 / 45, atRisk: 9, minAtRisk: 8, ended: 3 },
          ],
          short: null,
        },
      }),
      'Pure Buyer Bot',
      K,
    );
    expect(line.text).toBe(`${at} · listed 9 h ago · est. 71 % of orders like it still up 1 d later`);
    expect(line.tone).toBe('muted');
    expect(line.title).toBe(
      "Orders like it (the same kind, bot or human, within 15 % of its price), at the same listing age (listed 9 h ago by backpack.tf's listing time, which a price edit need not reset): " +
        '1 h later 89 % still up (9 order-price spells followed, 1 ended); 1 d later 71 % still up (9 order-price spells followed, 3 ended); 7 d later: not enough data. ' +
        `Kaplan-Meier with delayed entry over the orders Flip Desk followed. ${ORDER_PERSISTENCE_NOTE}`,
    );
  });

  it("warns under 50 % and names the scope's words", () => {
    const line = orderPersistenceLine(
      bookOrder({ persistence: { ageMs: 2 * HOUR, scope: 'all', windows: [{ horizonMs: HOUR, p: 0.4, atRisk: 12, minAtRisk: 5, ended: 7 }], short: null } }),
      'kettle',
      K,
    );
    expect(line.text).toBe(`kettle at ${fmtMoney(100, K)} · listed 2 h ago · est. 40 % of this item's orders still up 1 h later`);
    expect(line.tone).toBe('warn');
    expect(line.title.startsWith('Every order-price spell Flip Desk followed for this item, at the same listing age')).toBe(true);
    const band = orderPersistenceLine(bookOrder({ persistence: { ageMs: 2 * HOUR, scope: 'band', windows: [{ horizonMs: HOUR, p: 0.9, atRisk: 12, minAtRisk: 5, ended: 1 }], short: null } }), 'kettle', K);
    expect(band.text).toContain('of orders near its price still up 1 h later');
  });

  it('every text says "listed N ago", never "at this price", and never a fill or sale rate', () => {
    const lines = [
      orderPersistenceLine(bookOrder({ persistence: { ageMs: 3 * HOUR, scope: null, windows: [], short: 'few-at-risk' } }), 'A', K),
      orderPersistenceLine(bookOrder({ persistence: { ageMs: 3 * HOUR, scope: 'band', windows: [{ horizonMs: HOUR, p: 0.7, atRisk: 9, minAtRisk: 4, ended: 2 }], short: null } }), 'A', K),
    ];
    for (const l of lines) {
      expect(l.text).toContain('listed 3 h ago');
      for (const t of [l.text, l.title]) {
        expect(t).not.toMatch(/at this price|fill rate|filled|will sell|chance of (a )?sale/i);
      }
    }
    expect(lines[1]!.title).toContain('order-price spells');
  });
});

describe('bookHistoryOrderIds / bookOrderWho', () => {
  it('eligible, outliers skipped, one per steamid, in the drawer order, at most 3', () => {
    const orders = [
      order({ listingId: 'a', steamid: 's1', flags: ['outlier'] }),
      order({ listingId: 'b', steamid: 's2' }),
      order({ listingId: 'c', steamid: 's2' }),
      order({ listingId: 'd', steamid: 's3', eligible: false, flags: ['banned'] }),
      order({ listingId: 'e', steamid: 's4' }),
      order({ listingId: 'f', steamid: 's5' }),
      order({ listingId: 'g', steamid: 's6' }),
    ];
    expect(bookHistoryOrderIds(orders)).toEqual(['b', 'e', 'f']);
    expect(bookHistoryOrderIds([])).toEqual([]);
  });

  it("names the drawer's order, else Bot / Human", () => {
    const orders = [order({ listingId: 'b', userName: 'Alex' }), order({ listingId: 'c', userName: null })];
    expect(bookOrderWho({ listingId: 'b', isBot: false }, orders)).toBe('Alex');
    expect(bookOrderWho({ listingId: 'c', isBot: true }, orders)).toBe('Bot');
    expect(bookOrderWho({ listingId: 'x', isBot: false }, orders)).toBe('Human');
  });
});

describe('the community price chart and its texts', () => {
  const h: CommunityHistory = {
    steps: [
      step({ at: T0 - 30 * DAY, value: 20, valueHigh: 20, recordedAt: T0 - 30 * DAY }),
      step({ at: T0 - 20 * DAY, currency: 'usd', value: 1.5, valueHigh: null, sources: ['feed'], recordedAt: T0 - 20 * DAY }),
      step({ at: T0 - 10 * DAY, currency: 'keys', value: 2, valueHigh: 2.5, sources: ['feed', 'prices'], recordedAt: T0 - 10 * DAY }),
    ],
    since: T0 - 30 * DAY,
    recorded: 4,
  };

  it('each step at its low value, held to now, with a gap for a currency it cannot value', () => {
    expect(communityChartPoints(h, K, T0)).toEqual([
      { at: T0 - 30 * DAY, value: 180 },
      { at: T0 - 20 * DAY, value: null },
      { at: T0 - 10 * DAY, value: 2 * K },
      { at: T0, value: 2 * K },
    ]);
    // Without a key price a keys step is a gap too; nothing is held past the newest step when now is not later.
    expect(communityChartPoints(h, null, T0 - 10 * DAY).map((p) => p.value)).toEqual([180, null, null]);
    expect(communityChartPoints({ steps: [], since: null, recorded: 0 }, K, T0)).toEqual([]);
  });

  it('reads each step with its range, its value at today\'s key price and where it came from', () => {
    expect(communityReadout(step(), K)).toBe(`${fmtDate(T0 - 10 * DAY)} · 23.22–29.33 ref · IGetPrices`);
    expect(communityReadout(step({ valueHigh: null, sources: ['feed'] }), K)).toBe(`${fmtDate(T0 - 10 * DAY)} · 23.22 ref · the live feed`);
    expect(communityReadout(step({ valueHigh: 23.22, sources: ['feed', 'prices'] }), K)).toBe(`${fmtDate(T0 - 10 * DAY)} · 23.22 ref · IGetPrices and the live feed`);
    expect(communityReadout(step({ currency: 'keys', value: 390, valueHigh: 390 }), K)).toBe(`${fmtDate(T0 - 10 * DAY)} · 390 keys (≈ ${fmtMoney(390 * K, K)} at today's key price) · IGetPrices`);
    expect(communityReadout(step({ currency: 'keys', value: 2, valueHigh: 2.5 }), null)).toBe(`${fmtDate(T0 - 10 * DAY)} · 2–2.5 keys · IGetPrices`);
    expect(communityReadout(step({ currency: 'usd', value: 1.5, valueHigh: null }), K)).toBe(`${fmtDate(T0 - 10 * DAY)} · 1.5 usd · IGetPrices`);
    expect(communityReadout(step({ recordedAt: null }), K)).toBe(`${fmtDate(T0 - 10 * DAY)} · 23.22–29.33 ref · backpack.tf now`);
    expect(communityReadout(undefined, K)).toBe('');
  });

  it('says how many prices were recorded since when; null without steps', () => {
    expect(communitySinceText(h)).toBe(`backpack.tf community price: 3 prices recorded since ${fmtDate(T0 - 30 * DAY)}.`);
    expect(communitySinceText({ steps: [step({ recordedAt: null })], since: null, recorded: 0 })).toBe(`backpack.tf community price: 1 price recorded since ${fmtDate(T0 - 10 * DAY)}.`);
    expect(communitySinceText({ steps: [], since: null, recorded: 0 })).toBeNull();
    expect(COMMUNITY_NOTE).toMatch(/not sales/);
  });
});

describe('the scrap.tf low', () => {
  const low: ScraptfCopyLow = { keys: 1, scrap: 9, valueScrap: K + 9, firstAt: T0 - 5 * DAY, lastAt: T0 - 3 * DAY, since: T0 - 40 * DAY };
  const when = `${fmtDate(T0 - 5 * DAY)} to ${fmtDate(T0 - 3 * DAY)}`;
  const mutedTitle = `The lowest price your saves of scrap.tf/buy/hats showed for this copy since ${fmtDate(T0 - 40 * DAY)}: 1 key 1.00 ref, ${when}, ${fmtMoney(K + 9, K)} at today's key price. ${SCRAPTF_LOW_NOTE}`;

  it("now at or under the low: 'good', the lowest since its since", () => {
    const line = scraptfLowLine({ bank: 'hats', current: { costScrap: K + 9, stock: 1, bank: 'hats' }, low }, K);
    expect(line).toEqual({
      text: `Lowest in your saves since ${fmtDate(T0 - 40 * DAY)}`,
      tone: 'good',
      title: `scrap.tf's price now (${fmtMoney(K + 9, K)}) is the lowest your saves of scrap.tf/buy/hats have shown for this copy since ${fmtDate(T0 - 40 * DAY)}, at today's key price. ${SCRAPTF_LOW_NOTE}`,
    });
  });

  it('now above the low: the low with when, and how far above it now is', () => {
    expect(scraptfLowLine({ bank: 'hats', current: { costScrap: K + 27, stock: 1, bank: 'hats' }, low }, K)).toEqual({
      text: `Lowest in your saves: ${fmtMoney(K + 9, K)} (${when}) · now +2.00 ref`,
      tone: 'muted',
      title: mutedTitle,
    });
  });

  it('not on sale now: the low with when; one save reads one date', () => {
    expect(scraptfLowLine({ bank: 'hats', current: null, low }, K)).toEqual({ text: `Lowest in your saves: ${fmtMoney(K + 9, K)} (${when})`, tone: 'muted', title: mutedTitle });
    const one = scraptfLowLine({ bank: 'hats', current: null, low: { ...low, lastAt: low.firstAt } }, K)!;
    expect(one.text).toBe(`Lowest in your saves: ${fmtMoney(K + 9, K)} (${fmtDate(T0 - 5 * DAY)})`);
  });

  it('nothing without a bank or a low', () => {
    expect(scraptfLowLine({ bank: null, current: null, low }, K)).toBeNull();
    expect(scraptfLowLine({ bank: 'hats', current: null }, K)).toBeNull();
  });

  it("the bank stock hover's sentence, both ways; '' without a low", () => {
    expect(scraptfLowSentence(low, K + 9, K)).toBe(` The lowest price in your saves of this bank since ${fmtDate(T0 - 40 * DAY)}.`);
    expect(scraptfLowSentence(low, K + 30, K)).toBe(` Lowest in your saves of this bank: ${fmtMoney(K + 9, K)} on ${fmtDate(T0 - 5 * DAY)} (since ${fmtDate(T0 - 40 * DAY)}).`);
    expect(scraptfLowSentence(undefined, K, K)).toBe('');
    expect(scraptfLowSentence(null, K, K)).toBe('');
  });

  it("bankStockPriceTitle ends with the low's sentence, and is today's text without one", () => {
    const base: Pick<BankStockRow, 'costKeys' | 'costScrapRaw' | 'costScrap' | 'change' | 'hasExtras'> = { costKeys: 1, costScrapRaw: 27, costScrap: K + 27, change: null, hasExtras: false };
    expect(bankStockPriceTitle(base, K)).toBe('scrap.tf sells it for this, as of your newest save. Listed as 1 key 3.00 ref.');
    expect(bankStockPriceTitle({ ...base, low }, K)).toBe(
      `scrap.tf sells it for this, as of your newest save. Listed as 1 key 3.00 ref. Lowest in your saves of this bank: ${fmtMoney(K + 9, K)} on ${fmtDate(T0 - 5 * DAY)} (since ${fmtDate(T0 - 40 * DAY)}).`,
    );
    expect(bankStockPriceTitle({ ...base, costScrap: K + 9, costScrapRaw: 9, low, hasExtras: true }, K)).toBe(
      `scrap.tf sells it for this, as of your newest save. Listed as 1 key 1.00 ref. This copy has extras. The lowest price in your saves of this bank since ${fmtDate(T0 - 40 * DAY)}.`,
    );
  });
});
