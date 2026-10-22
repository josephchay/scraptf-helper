// 0.9 (#3, #12): the dashboard's words for the risk-aware ranking keys and the suggested price-move reserve
// (src/renderer/riskModel.ts). Buyer counts are demand, never a chance of a sale; the drawer's line reads the drawer's
// own book with the Next buyer line's buyerDepthOf result; the suggestion shows its n and source and is never applied.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarketTable, type MarketTableProps } from '../../src/renderer/pages/MarketPage';
import { scraptfLinkFor } from '../../src/shared/links';
import { flipProfit } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { RESERVE_BANDS, reserveSuggestionOf } from '../../src/shared/reserveSuggest';
import type { MarketRow, OrderSummary, ReserveBandSuggestion, ReserveSuggestion } from '../../src/shared/types';
import { fmtSignedMoney } from '../../src/renderer/format';
import { DEFAULT_MARKET_SORT, marketDisplayRows, marketSellsForTitle } from '../../src/renderer/marketModel';
import { OPP_SORT_HELP, nextBuyerLine } from '../../src/renderer/oppModel';
import {
  BOOK_DEPTH_BOT_LABELS,
  BOOK_DEPTH_LABELS,
  DEMAND_NOT_SALES,
  DRAWER_RISK_HELP,
  RESERVE_BAND_LABELS,
  RESERVE_SUGGEST_HELP,
  depthCountText,
  depthPopulationNote,
  drawerRiskLine,
  marketRiskTitle,
  marketSellsTitle,
  oppBuyersTitle,
  reserveBandText,
  reserveSuggestionView,
  riskSentences,
} from '../../src/renderer/riskModel';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const K = 567;
const P = { ...DEFAULT_SETTINGS.profit };
const BANNED = /\bchance\b|probabilit|\bwill\b|seen in the last day/i;
/** Review: who the depth leaves out, when the caller passes no useOrder (both rules). */
const NOTE = 'Outlier orders are not counted, and under Instant only bots are.';

function summary(listingId: string, valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId,
    steamid: `S-${listingId}`,
    userName: null,
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: false,
    online: null,
    lastEventAt: T0 - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

const A = summary('a', 270);
const B = summary('b', 261);
const C = summary('c', 200);

/** The drawer's row: revenue from A (30.00 ref) at a cost of 25.00 ref, so break-even is 25.00 ref. */
function opp(cons: OrderSummary | null = A, costScrap = 225, status: 'profitable' | 'unprofitable' = 'profitable') {
  return { status, revenueScrap: cons?.valueScrap ?? null, costScrap, bestOrder: cons, consOrder: cons, instantOrder: null };
}

function row(over: Partial<MarketRow> = {}): MarketRow {
  return {
    sku: '378;6',
    name: 'Team Captain',
    category: 'hats',
    revenueScrap: 270,
    bestScrap: 270,
    consScrap: 270,
    instantScrap: null,
    revenueOrder: A,
    buyerCount: 3,
    maxCostScrap: 247,
    confidence: 72,
    confidenceLevel: 'high',
    flags: [],
    knownCostScrap: null,
    knownSource: 'none',
    knownObservedAt: null,
    stock: null,
    ruleCostScrap: null,
    profitScrap: null,
    verdict: 'unchecked',
    lastOrderChangeAt: T0 - MIN,
    evaluatedAt: T0,
    scraptfPaysScrap: null,
    scraptfStock: null,
    scraptfStockLimit: null,
    scraptfFull: false,
    scraptfListAt: null,
    scraptfNewAt: null,
    scraptfListedSince: null,
    scraptfLink: scraptfLinkFor('hats', null),
    ...over,
  };
}

describe('0.9 (#3): depthCountText and riskSentences', () => {
  it('shows "20+" at the cap', () => {
    expect(depthCountText(0)).toBe('0');
    expect(depthCountText(19)).toBe('19');
    expect(depthCountText(20)).toBe('20+');
    expect(depthCountText(31)).toBe('20+');
  });

  it('says N of M usable buyers seen in the last 24 h, the profit if this buyer leaves and the book depth, at each cost', () => {
    const r = { bookDepth: 3, profitableDepth: 2, backupProfitScrap: 36 };
    expect(riskSentences(r, K, 'this cost', true)).toEqual([
      'Buyers at break-even at this cost: 2 of 3 usable buyers seen in the last 24 h.',
      'If this buyer leaves: +4.00 ref at the next buyer seen in the last 24 h.',
      'Book depth: a few usable buyers.',
      NOTE,
    ]);
    expect(riskSentences(r, K, 'your price', true)[0]).toBe('Buyers at break-even at your price: 2 of 3 usable buyers seen in the last 24 h.');
    expect(riskSentences(r, K, 'the rule estimate', true)[0]).toBe('Buyers at break-even at the rule estimate: 2 of 3 usable buyers seen in the last 24 h.');
  });

  it('names who the depth counts (review): bot buyers under Instant, usable buyers otherwise, and who is left out', () => {
    // Under Instant five human buyers make an ExitDepth of 0: the text says no bot buyer, never no buyer.
    const instant = riskSentences({ bookDepth: 0, profitableDepth: 0 }, K, 'your price', false, 'instant');
    expect(instant).toEqual([
      'Buyers at break-even at your price: 0 of 0 bot buyers seen in the last 24 h.',
      'Book depth: no bot buyer seen in the last 24 h.',
      'Under Instant only bots count; outlier orders never do.',
    ]);
    expect(instant.join(' ')).not.toMatch(/no buyer seen|of 0 seen/);
    expect(riskSentences({ bookDepth: 3, profitableDepth: null }, K, 'the rule estimate', false, 'instant')[1]).toBe('Book depth: a few bot buyers (3 seen in the last 24 h).');
    // Conservative and Best leave out outliers only.
    for (const u of ['conservative', 'best'] as const) {
      const s = riskSentences({ bookDepth: 0, profitableDepth: 0 }, K, 'this cost', false, u);
      expect(s).toEqual(['Buyers at break-even at this cost: 0 of 0 usable buyers seen in the last 24 h.', `Book depth: ${BOOK_DEPTH_LABELS.none}.`, 'Outlier orders are not counted.']);
    }
    // Without the setting (the Live market): both rules.
    expect(depthPopulationNote()).toBe('Outlier orders are not counted, and under Instant only bots are.');
    expect(depthPopulationNote(null)).toBe(depthPopulationNote());
    expect(BOOK_DEPTH_LABELS.none).toBe('no usable buyer seen in the last 24 h');
    expect(BOOK_DEPTH_BOT_LABELS.none).toBe('no bot buyer seen in the last 24 h');
    expect(Object.keys(BOOK_DEPTH_BOT_LABELS)).toEqual(Object.keys(BOOK_DEPTH_LABELS));
  });

  it('leaves out the backup without a revenue, and says when no other buyer was seen', () => {
    expect(riskSentences({ bookDepth: 1, profitableDepth: 1, backupProfitScrap: 36 }, K, 'this cost', false)).toEqual([
      'Buyers at break-even at this cost: 1 of 1 usable buyers seen in the last 24 h.',
      'Book depth: one usable buyer.',
      NOTE,
    ]);
    expect(riskSentences({ bookDepth: 1, profitableDepth: 1 }, K, 'this cost', true)).toEqual([
      'Buyers at break-even at this cost: 1 of 1 usable buyers seen in the last 24 h.',
      'If this buyer leaves: no other buyer seen in the last 24 h.',
      'Book depth: one usable buyer.',
      NOTE,
    ]);
    // A negative profit at the next buyer is kept and shown.
    expect(riskSentences({ bookDepth: 2, profitableDepth: 1, backupProfitScrap: -25 }, K, 'this cost', true)[1]).toBe(
      `If this buyer leaves: ${fmtSignedMoney(-25, K)} at the next buyer seen in the last 24 h.`,
    );
  });

  it('says there is no price to judge, and keeps the tag and the cap', () => {
    expect(riskSentences({ bookDepth: 0, profitableDepth: null }, K, 'the rule estimate', false)).toEqual([
      'Buyers at break-even: no price of yours to judge.',
      `Book depth: ${BOOK_DEPTH_LABELS.none}.`,
      NOTE,
    ]);
    expect(riskSentences({ bookDepth: 25, profitableDepth: 20 }, K, 'this cost', false)).toEqual([
      'Buyers at break-even at this cost: 20+ of 20+ usable buyers seen in the last 24 h.',
      'Book depth: many usable buyers.',
      NOTE,
    ]);
  });

  it('with no price to judge, the depth sentence carries the count ("n shown"), as "N of M" does otherwise', () => {
    expect(riskSentences({ bookDepth: 3, profitableDepth: null }, K, 'the rule estimate', true)).toEqual([
      'Buyers at break-even: no price of yours to judge.',
      'Book depth: a few usable buyers (3 seen in the last 24 h).',
      NOTE,
    ]);
    expect(riskSentences({ bookDepth: 2 }, K, 'the rule estimate', true)[1]).toBe('Book depth: a few usable buyers (2 seen in the last 24 h).');
    expect(riskSentences({ bookDepth: 7, profitableDepth: null }, K, 'the rule estimate', false)[1]).toBe('Book depth: many usable buyers (7 seen in the last 24 h).');
    expect(riskSentences({ bookDepth: 31, profitableDepth: null }, K, 'the rule estimate', false)[1]).toBe('Book depth: many usable buyers (20+ seen in the last 24 h).');
    // "one usable buyer" and "no usable buyer seen" already say their number.
    expect(riskSentences({ bookDepth: 1, profitableDepth: null }, K, 'the rule estimate', false)[1]).toBe('Book depth: one usable buyer.');
    expect(riskSentences({ bookDepth: 0, profitableDepth: null }, K, 'the rule estimate', false)[1]).toBe(`Book depth: ${BOOK_DEPTH_LABELS.none}.`);
    // Every sentence with a few or many buyers names a number.
    for (const bookDepth of [2, 3, 4, 5, 12]) {
      for (const profitableDepth of [null, 0, 1, 2]) {
        expect(riskSentences({ bookDepth, profitableDepth }, K, 'your price', true).join(' '), `${bookDepth} ${profitableDepth}`).toMatch(
          /\d+\+? (?:of \d+\+? (?:usable|bot) buyers )?seen in the last 24 h/,
        );
      }
    }
  });

  it('is empty for a row with no risk fields (stored before V16, or no book)', () => {
    expect(riskSentences({}, K, 'this cost', true)).toEqual([]);
    expect(riskSentences({ profitableDepth: 2, backupProfitScrap: 4 }, K, 'this cost', true)).toEqual([]);
    expect(riskSentences({ bookDepth: Number.NaN }, K, 'this cost', true)).toEqual([]);
    expect(riskSentences({ bookDepth: -1 }, K, 'this cost', true)).toEqual([]);
  });
});

describe('0.9 (#3): the Opportunities Buyers hover', () => {
  it('keeps the count alone on a row stored before V16', () => {
    expect(oppBuyersTitle({ flags: [], reasons: [], buyerCount: 2, revenueScrap: 270 }, K)).toBe('2 buyers with eligible orders.');
    expect(oppBuyersTitle({ flags: [], reasons: [], buyerCount: 1, revenueScrap: 270 }, K)).toBe('1 buyer with eligible orders.');
  });

  it('follows the count with the figures and demand, not sales', () => {
    expect(oppBuyersTitle({ flags: [], reasons: [], buyerCount: 3, revenueScrap: 270, bookDepth: 3, profitableDepth: 2, backupProfitScrap: 36 }, K, 'conservative')).toBe(
      '3 buyers with eligible orders. Buyers at break-even at this cost: 2 of 3 usable buyers seen in the last 24 h. If this buyer leaves: +4.00 ref at the next buyer seen in the last 24 h. Book depth: a few usable buyers. Outlier orders are not counted. Buy orders show demand, not sales.',
    );
  });

  it('under Instant, a book of human buyers reads no bot buyer beside the Buyers count (review)', () => {
    expect(oppBuyersTitle({ flags: [], reasons: [], buyerCount: 5, revenueScrap: null, bookDepth: 0, profitableDepth: 0 }, K, 'instant')).toBe(
      '5 buyers with eligible orders. Buyers at break-even at this cost: 0 of 0 bot buyers seen in the last 24 h. Book depth: no bot buyer seen in the last 24 h. Under Instant only bots count; outlier orders never do. Buy orders show demand, not sales.',
    );
  });

  it("starts with the single-exit text on a 'single-exit' row", () => {
    expect(oppBuyersTitle({ flags: ['single-exit'], reasons: [], buyerCount: 1, revenueScrap: 270, bookDepth: 1, profitableDepth: 1 }, K)).toBe(
      `1 buyer with eligible orders. Only this buyer makes it a flip. Buyers at break-even at this cost: 1 of 1 usable buyers seen in the last 24 h. If this buyer leaves: no other buyer seen in the last 24 h. Book depth: one usable buyer. ${NOTE} Buy orders show demand, not sales.`,
    );
    // Without risk fields the single-exit text is the whole hover, as 0.8.
    expect(oppBuyersTitle({ flags: ['single-exit'], reasons: [], buyerCount: 1, revenueScrap: 270 }, K)).toBe('1 buyer with eligible orders. Only this buyer makes it a flip.');
  });

  it('names no backup without a revenue', () => {
    expect(oppBuyersTitle({ flags: [], reasons: [], buyerCount: 2, revenueScrap: null, bookDepth: 2, profitableDepth: 0 }, K)).toBe(
      `2 buyers with eligible orders. Buyers at break-even at this cost: 0 of 2 usable buyers seen in the last 24 h. Book depth: a few usable buyers. ${NOTE} Buy orders show demand, not sales.`,
    );
  });
});

describe('0.9 (#3): the Live market hovers', () => {
  it('judges at your price, else the rule estimate; null without a book', () => {
    // Without a useOrder (a caller without settings): the note gives both rules. The page passes its own (below).
    expect(marketRiskTitle(row({ knownCostScrap: 225, bookDepth: 3, profitableDepth: 2, backupProfitScrap: 36 }), K)).toBe(
      'Buyers at break-even at your price: 2 of 3 usable buyers seen in the last 24 h. If this buyer leaves: +4.00 ref at the next buyer seen in the last 24 h. Book depth: a few usable buyers. Outlier orders are not counted, and under Instant only bots are. Buy orders show demand, not sales.',
    );
    expect(marketRiskTitle(row({ ruleCostScrap: 225, verdict: 'rule-flip', bookDepth: 3, profitableDepth: 2, backupProfitScrap: 36 }), K)).toContain(
      'Buyers at break-even at the rule estimate: 2 of 3',
    );
    expect(marketRiskTitle(row({ bookDepth: 3, profitableDepth: null }), K)).toBe(
      `Buyers at break-even: no price of yours to judge. Book depth: a few usable buyers (3 seen in the last 24 h). ${NOTE} Buy orders show demand, not sales.`,
    );
    expect(marketRiskTitle(row(), K)).toBeNull();
  });

  it('keeps marketSellsForTitle first in the Sells for hover', () => {
    const r = row({ knownCostScrap: 225, bookDepth: 3, profitableDepth: 2, backupProfitScrap: 36 });
    const t = marketSellsTitle(r, K, T0);
    expect(t.startsWith(marketSellsForTitle(r, K, T0))).toBe(true);
    expect(t).toBe(`${marketSellsForTitle(r, K, T0)} ${marketRiskTitle(r, K)}`);
    // No book: the 0.8 hover unchanged.
    expect(marketSellsTitle(row(), K, T0)).toBe(marketSellsForTitle(row(), K, T0));
  });

  it("names who the depth counts with the user's useOrder, as the Opportunities hover (recheck)", () => {
    // Five human buyers and no bot under Instant: the Buyers cell shows 5, the depth (exitDepthOf, bots only) 0.
    const humans = row({ knownCostScrap: 225, buyerCount: 5, revenueScrap: null, revenueOrder: null, bookDepth: 0, profitableDepth: 0 });
    expect(marketRiskTitle(humans, K, 'instant')).toBe(
      'Buyers at break-even at your price: 0 of 0 bot buyers seen in the last 24 h. Book depth: no bot buyer seen in the last 24 h. Under Instant only bots count; outlier orders never do. Buy orders show demand, not sales.',
    );
    expect(marketSellsTitle(humans, K, T0, 'instant')).toBe(`${marketSellsForTitle(humans, K, T0)} ${marketRiskTitle(humans, K, 'instant')}`);
    expect(marketSellsTitle(humans, K, T0, 'instant')).toContain('0 of 0 bot buyers');
    // Best and Conservative count every usable buyer and say only the outlier rule.
    const r = row({ knownCostScrap: 225, bookDepth: 3, profitableDepth: 2, backupProfitScrap: 36 });
    for (const u of ['best', 'conservative'] as const) {
      expect(marketRiskTitle(r, K, u)).toBe(
        'Buyers at break-even at your price: 2 of 3 usable buyers seen in the last 24 h. If this buyer leaves: +4.00 ref at the next buyer seen in the last 24 h. Book depth: a few usable buyers. Outlier orders are not counted. Buy orders show demand, not sales.',
      );
    }
    // The same sentences as riskSentences with that useOrder, at the rule estimate too.
    const rule = row({ ruleCostScrap: 225, verdict: 'rule-flip', bookDepth: 1, profitableDepth: 1 });
    expect(marketRiskTitle(rule, K, 'instant')).toBe(`${riskSentences(rule, K, 'the rule estimate', true, 'instant').join(' ')} ${DEMAND_NOT_SALES}`);
  });

  it("the table's Sells for and Buyers cells read the table's useOrder (recheck): bot buyers under Instant", () => {
    const humans = row({ knownCostScrap: 225, buyerCount: 5, revenueScrap: null, revenueOrder: null, bookDepth: 0, profitableDepth: 0 });
    const noop = () => undefined;
    const render = (useOrder?: 'instant' | 'conservative') => {
      const props: MarketTableProps = {
        rows: marketDisplayRows([humans], 1),
        dataKey: 'q',
        keyScrap: K,
        now: T0,
        density: 'comfortable',
        selectedId: null,
        flash: { seq: 0, dirs: new Map() },
        sort: { ...DEFAULT_MARKET_SORT },
        loadingMore: false,
        frozen: false,
        onSelect: noop,
        onOpen: noop,
        onMenu: noop,
        onLoadMore: noop,
        onSort: noop,
        ...(useOrder ? { useOrder } : {}),
      };
      return renderToString(createElement(MarketTable, props));
    };
    const titleOf = (html: string, cls: string) => new RegExp(`<div role="gridcell" class="${cls}[^"]*" title="([^"]*)"`).exec(html)?.[1] ?? null;
    const instant = render('instant');
    expect(titleOf(instant, 'm-buyers num')).toBe(marketRiskTitle(humans, K, 'instant'));
    expect(titleOf(instant, 'm-buyers num')).toContain('0 of 0 bot buyers seen in the last 24 h');
    expect(titleOf(instant, 'm-sells')).toContain('Book depth: no bot buyer seen in the last 24 h.');
    expect(titleOf(render('conservative'), 'm-buyers num')).toBe(marketRiskTitle(humans, K, 'conservative'));
    // A caller without settings: both rules, as before.
    expect(titleOf(render(), 'm-buyers num')).toBe(marketRiskTitle(humans, K));
  });
});

describe("0.9 (#3): the drawer's Buyers at break-even line", () => {
  it('counts the book at this cost and agrees with the Next buyer line on a verified next buyer', () => {
    const book = [A, B, C];
    const line = drawerRiskLine(opp(), book, P, K)!;
    const next = nextBuyerLine(opp(), book, P, K, T0)!;
    const backup = flipProfit(B.valueScrap, 225, P)!;
    expect(line.text).toBe(`2 of 3 usable buyers seen in 24 h · if this buyer leaves ${fmtSignedMoney(backup, K)}`);
    expect(next.text).toContain(`profit ${fmtSignedMoney(backup, K)}`);
    expect(line.tone).toBeNull();
    expect(line.title).toBe(
      `Buyers at break-even at this cost: 2 of 3 usable buyers seen in the last 24 h. If this buyer leaves: +4.00 ref at the next buyer seen in the last 24 h. Book depth: a few usable buyers. ${depthPopulationNote(P.useOrder)} From the buy orders in this panel, as the Next buyer line. Buy orders show demand, not sales.`,
    );
  });

  it('under Instant counts bot buyers and says so, never "no buyer" when only humans are seen (review)', () => {
    const p = { ...P, useOrder: 'instant' as const };
    const bot = summary('a', 270, { isBot: true });
    const humans = [summary('h1', 265), summary('h2', 262)];
    const o = { ...opp(null), instantOrder: bot };
    const line = drawerRiskLine({ ...o, revenueScrap: 270 }, [bot, ...humans], p, K)!;
    expect(line.text.startsWith('1 of 1 bot buyers seen in 24 h')).toBe(true);
    expect(line.title).toContain('Book depth: one bot buyer.');
    expect(line.title).toContain('Under Instant only bots count; outlier orders never do.');
  });

  it('warns on a profitable row with at most one buyer at break-even', () => {
    const line = drawerRiskLine(opp(), [A, C], P, K)!;
    expect(line.text).toBe(`1 of 2 usable buyers seen in 24 h · if this buyer leaves ${fmtSignedMoney(-25, K)}`);
    expect(line.tone).toBe('warn');
    // Not a profitable row: no warning.
    expect(drawerRiskLine(opp(A, 225, 'unprofitable'), [A, C], P, K)!.tone).toBeNull();
  });

  it('counts no unverified backup, while the Next buyer line marks that order not seen in 24 h', () => {
    const stale = summary('b', 261, { flags: ['unverified'], lastEventAt: T0 - 25 * HOUR });
    const line = drawerRiskLine(opp(), [A, stale], P, K)!;
    expect(line.text).toBe('1 of 1 usable buyers seen in 24 h · if this buyer leaves none seen in 24 h');
    expect(line.tone).toBe('warn');
    expect(nextBuyerLine(opp(), [A, stale], P, K, T0)!.text).toContain('not seen in 24 h');
  });

  it('claims nothing when the revenue order is not in the book, as the Next buyer line, or without a finite cost', () => {
    expect(drawerRiskLine(opp(), [B, C], P, K)).toBeNull();
    expect(nextBuyerLine(opp(), [B, C], P, K, T0)).toBeNull();
    expect(drawerRiskLine(opp(A, Number.NaN), [A, B, C], P, K)).toBeNull();
  });

  it('names no backup without a revenue order', () => {
    const line = drawerRiskLine(opp(null), [A, B, C], P, K)!;
    expect(line.text).toBe('2 of 3 usable buyers seen in 24 h');
    expect(line.title).not.toContain('If this buyer leaves');
  });

  it("reads the drawer's book, never the stored row's figures", () => {
    const stored = { ...opp(), profitableDepth: 9, bookDepth: 9, backupProfitScrap: 999 };
    expect(drawerRiskLine(stored, [A, B, C], P, K)!.text).toBe(drawerRiskLine(opp(), [A, B, C], P, K)!.text);
    expect(drawerRiskLine(stored, [A, B, C], P, K)!.text.startsWith('2 of 3')).toBe(true);
  });

  it('follows friction and the price-move reserve (break-even moves up)', () => {
    // 5% reserve: 261 * 0.95 = 247.95 < 225 + 25 friction; only A (270 * 0.95 = 256.5 >= 250) clears.
    const p = { ...P, frictionScrap: 25, exitReservePct: 0.05 };
    expect(drawerRiskLine(opp(), [A, B, C], p, K)!.text.startsWith('1 of 3')).toBe(true);
  });
});

function band(over: Partial<ReserveBandSuggestion>): ReserveBandSuggestion {
  return { band: 'under-10-ref', source: null, p10: null, suggestedPct: null, recorded: { windows: 0, items: 0 }, pricedb: { windows: 0, items: 0 }, ...over };
}

function suggestion(over: Partial<ReserveSuggestion> = {}): ReserveSuggestion {
  return {
    holdMs: DAY,
    holdFrom: 'default',
    holdSales: 0,
    holdStillHeld: 0,
    lookbackMs: 90 * DAY,
    settingsAt: null,
    bands: RESERVE_BANDS.map((b) => band({ band: b })),
    keyScrap: K,
    generatedAt: T0,
    ...over,
  };
}

describe('0.9 (#12): the suggested reserve note', () => {
  it('words each band state with its n and source', () => {
    expect(reserveBandText(band({ band: 'under-10-ref', source: 'recorded', p10: -0.0612, suggestedPct: 0.07, recorded: { windows: 24, items: 4 } }))).toBe(
      'Under 10 ref: 7% (24 changes from 4 items, your recorded exits)',
    );
    expect(
      reserveBandText(band({ band: 'to-1-key', source: 'pricedb', p10: -0.021, suggestedPct: 0.03, recorded: { windows: 3, items: 1 }, pricedb: { windows: 40, items: 5 } })),
    ).toBe('10 ref to 1 key: 3% (40 changes from 5 items, PriceDB history of items you opened)');
    expect(reserveBandText(band({ band: 'key-plus', source: 'recorded', p10: 0.01, suggestedPct: 0, recorded: { windows: 20, items: 3 } }))).toBe(
      '1 key and up: 0% (20 changes from 3 items, your recorded exits)',
    );
    // Not enough data: the larger source's counts and what is needed.
    expect(reserveBandText(band({ band: 'key-plus', recorded: { windows: 1, items: 1 }, pricedb: { windows: 5, items: 2 } }))).toBe(
      '1 key and up: not enough data (5 changes from 2 items; needs 20 from 3 items)',
    );
    expect(reserveBandText(band({ band: 'under-10-ref', recorded: { windows: 1, items: 1 } }))).toBe('Under 10 ref: not enough data (1 change from 1 item; needs 20 from 3 items)');
    expect(Object.keys(RESERVE_BAND_LABELS)).toEqual([...RESERVE_BANDS]);
  });

  it('names the hold it used: the typical hold with its sales, or the default and why', () => {
    const j = reserveSuggestionView(suggestion({ holdMs: 2 * DAY, holdFrom: 'journal', holdSales: 6 }))!;
    expect(j.head).toBe('What your data suggests over a 2 d hold (your typical hold, from 6 sales):');
    expect(j.title).toBe(RESERVE_SUGGEST_HELP);
    expect(reserveSuggestionView(suggestion({ holdMs: 5 * HOUR, holdFrom: 'journal', holdSales: 1 }))!.head).toBe(
      'What your data suggests over a 5 h hold (your typical hold, from 1 sale):',
    );
    const d = reserveSuggestionView(suggestion())!;
    expect(d.head).toBe('What your data suggests over a 1 d hold (no typical hold yet: fewer than 5 recorded sales):');
    expect(d.lines.map((l) => l.band)).toEqual([...RESERVE_BANDS]);
    expect(d.lines.map((l) => l.text)).toEqual([
      'Under 10 ref: not enough data (0 changes from 0 items; needs 20 from 3 items)',
      '10 ref to 1 key: not enough data (0 changes from 0 items; needs 20 from 3 items)',
      '1 key and up: not enough data (0 changes from 0 items; needs 20 from 3 items)',
    ]);
  });

  it('never calls a clamped hold "your typical hold": it names the bound and gives the typical hold (review)', () => {
    expect(reserveSuggestionView(suggestion({ holdMs: HOUR, holdFrom: 'journal', holdSales: 12, holdClampedFromMs: 20 * MIN }))!.head).toBe(
      'What your data suggests over a 1 h hold (the shortest it measures; your typical hold is 20 min, from 12 sales):',
    );
    expect(reserveSuggestionView(suggestion({ holdMs: 14 * DAY, holdFrom: 'journal', holdSales: 9, holdClampedFromMs: 30 * DAY }))!.head).toBe(
      'What your data suggests over a 14 d hold (the longest it measures; your typical hold is 30 d, from 9 sales):',
    );
    expect(reserveSuggestionView(suggestion({ holdMs: HOUR, holdFrom: 'journal', holdSales: 1, holdClampedFromMs: 0 }))!.head).toBe(
      'What your data suggests over a 1 h hold (the shortest it measures; your typical hold is < 1 min, from 1 sale):',
    );
    // Not clamped (null or absent): the hold is the user's own.
    expect(reserveSuggestionView(suggestion({ holdMs: HOUR, holdFrom: 'journal', holdSales: 6, holdClampedFromMs: null }))!.head).toBe(
      'What your data suggests over a 1 h hold (your typical hold, from 6 sales):',
    );
    // From the shared rule end to end: a 20-minute typical hold.
    const s = reserveSuggestionOf({ marks: [], histories: new Map(), hold: { medianMs: 20 * MIN, count: 12, scope: 'all', stillHeld: 0 }, keyScrap: K, settingsAt: null, now: T0 });
    expect(reserveSuggestionView(s)!.head).not.toContain('(your typical hold,');
    expect(reserveSuggestionView(s)!.head).toContain('your typical hold is 20 min');
  });

  it('says how many units still held the typical hold leaves out', () => {
    expect(reserveSuggestionView(suggestion({ holdFrom: 'journal', holdSales: 7, holdStillHeld: 1 }))!.title).toBe(
      `${RESERVE_SUGGEST_HELP} Your typical hold leaves out the 1 unit you still hold, often the longer holds.`,
    );
    expect(reserveSuggestionView(suggestion({ holdFrom: 'journal', holdSales: 7, holdStillHeld: 3 }))!.title).toContain('the 3 units you still hold');
  });

  it('renders nothing without an answer', () => {
    expect(reserveSuggestionView(null)).toBeNull();
    expect(reserveSuggestionView(undefined)).toBeNull();
    expect(reserveSuggestionView({ ...suggestion(), bands: undefined } as unknown as ReserveSuggestion)).toBeNull();
  });

  it("words the shared rule's own answer (no data: not enough data in every band)", () => {
    const s = reserveSuggestionOf({ marks: [], histories: new Map(), hold: null, keyScrap: K, settingsAt: null, now: T0 });
    const v = reserveSuggestionView(s)!;
    expect(v.lines).toHaveLength(3);
    for (const l of v.lines) expect(l.text).toContain('not enough data');
  });

  it('says it is a suggestion, never a forecast, and never set for the user', () => {
    expect(RESERVE_SUGGEST_HELP).toContain('A suggestion from past data, never a forecast.');
    expect(RESERVE_SUGGEST_HELP).toContain('Flip Desk never sets the reserve for you.');
  });
});

describe('0.9 (#3, #12): honest wording', () => {
  it('every risk text ends with demand, not sales, and none claims a chance, a probability or a future', () => {
    const texts = [
      oppBuyersTitle({ flags: [], reasons: [], buyerCount: 3, revenueScrap: 270, bookDepth: 3, profitableDepth: 2, backupProfitScrap: 36 }, K),
      oppBuyersTitle({ flags: ['single-exit'], reasons: [], buyerCount: 1, revenueScrap: 270, bookDepth: 1, profitableDepth: 1 }, K),
      marketRiskTitle(row({ knownCostScrap: 225, bookDepth: 3, profitableDepth: 2, backupProfitScrap: 36 }), K)!,
      marketRiskTitle(row({ bookDepth: 0, profitableDepth: null }), K)!,
      drawerRiskLine(opp(), [A, B, C], P, K)!.title,
      drawerRiskLine(opp(), [A, summary('b', 261, { flags: ['unverified'] })], P, K)!.title,
    ];
    for (const t of texts) {
      expect(t).toContain(DEMAND_NOT_SALES);
      expect(t).not.toMatch(BANNED);
    }
    const lines = [drawerRiskLine(opp(), [A, B, C], P, K)!.text, ...reserveSuggestionView(suggestion({ holdFrom: 'journal', holdSales: 6, holdStillHeld: 2 }))!.lines.map((l) => l.text)];
    for (const t of lines) expect(t).not.toMatch(BANNED);
    const notes = [depthPopulationNote(), depthPopulationNote('instant'), depthPopulationNote('best'), depthPopulationNote('conservative')];
    for (const t of [RESERVE_SUGGEST_HELP, OPP_SORT_HELP, ...Object.values(BOOK_DEPTH_LABELS), ...Object.values(BOOK_DEPTH_BOT_LABELS), ...notes, ...Object.values(RESERVE_BAND_LABELS)]) {
      expect(t).not.toMatch(BANNED);
    }
    // The label hover names a chance only to deny one.
    expect(DRAWER_RISK_HELP.replace('never a chance of a sale', '')).not.toMatch(BANNED);
    expect(DEMAND_NOT_SALES).toBe('Buy orders show demand, not sales.');
  });
});
