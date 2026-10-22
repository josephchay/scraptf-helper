// 0.8 (H3, H4, H6): the Holdings advice in words. The Advice column's labels and tones, every reason code's
// sentence (each carrying the date or age it rests on, never a forecast), the hover, the ask side ("Others ask")
// and the references, and the existing hovers they join: "Sells now for" and "Profit now" are exactly as before
// for a row without an ask or references. Pure; no network.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { holdingAdvice, holdingExitHistory } from '../../src/shared/holdingAdvice';
import { holdingRow } from '../../src/shared/holdings';
import type { HoldingAdvice, HoldingAdviceReason, HoldingAskSide, HoldingMark, HoldingRefs, HoldingRow, JournalPosition, OrderSummary } from '../../src/shared/types';
import { HOLDING_ADVICE_KINDS } from '../../src/shared/types';
import { fmtAge, fmtAgo, fmtDate, fmtDateTime, fmtMoney, fmtSignedMoney } from '../../src/renderer/format';
import {
  ADVICE_BELOW_TARGET_FALLING_HELP,
  ADVICE_BELOW_TARGET_HELP,
  ADVICE_BELOW_TARGET_RESAVE_HELP,
  ADVICE_BELOW_TARGET_SINCE_SETTINGS_HELP,
  ADVICE_COLUMN_TITLE,
  ADVICE_FOOTER,
  ADVICE_HELP,
  ADVICE_LABELS,
  ADVICE_REFRESH_TITLE,
  ADVICE_TONES,
  HOLDING_STATUS_HELP,
  adviceReasonText,
  adviceTitle,
  askSideText,
  holdingExitView,
  holdingSellsForTitle,
  profitNowTitle,
  refsText,
} from '../../src/renderer/holdingsModel';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY = 568;
const P = DEFAULT_SETTINGS.profit;
const $m = (v: number) => fmtMoney(v, KEY);
const $s = (v: number) => fmtSignedMoney(v, KEY);

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
    lastEventAt: T0 - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function position(sku: string, cost: number): JournalPosition {
  return { sku, name: `Item ${sku}`, qty: 1, costScrap: cost, lots: [{ id: 1, ts: T0 - 2 * DAY, costScrap: cost, keys: 0, scrap: cost, keyPriceScrap: KEY }] };
}

function row(revenue: number | null, extras: Partial<Pick<HoldingRow, 'ask' | 'refs'>> = {}): HoldingRow {
  const o = revenue !== null ? order(revenue) : null;
  const buy = o
    ? { revenueScrap: o.valueScrap, bestScrap: o.valueScrap, instantScrap: o.valueScrap, revenueOrder: o, bestOrder: o, buyerCount: 3, confidence: 70, confidenceLevel: 'high' as const, flags: [], lastOrderChangeAt: T0 - 2 * MIN }
    : null;
  return { ...holdingRow(position('378;6', 100), 'hats', buy, P), ...extras };
}

function ask(over: Partial<HoldingAskSide> = {}): HoldingAskSide {
  return { lowestScrap: 150, lowestKeys: 0, lowestMetalScrap: 150, lowestIsBot: false, lowestSeenAt: T0 - 5 * MIN, count: 3, botCount: 1, ownLeftOut: 0, mayIncludeOwn: true, ...over };
}

function refs(over: Partial<HoldingRefs> = {}): HoldingRefs {
  return { pricedbBuyScrap: 120, pricedbSellScrap: 140, pricedbAgeMs: 3 * DAY, communityScrap: 130, communityHighScrap: null, ignored: [], ...over };
}

describe('the Advice column', () => {
  it('labels and tones every kind; the status pills keep their own words (D11)', () => {
    expect(HOLDING_ADVICE_KINDS.map((k) => ADVICE_LABELS[k])).toEqual(['Sell now', 'List and wait', 'Hold', 'No clear signal']);
    expect(HOLDING_ADVICE_KINDS.map((k) => ADVICE_TONES[k])).toEqual(['good', 'info', 'warn', 'muted']);
    for (const k of HOLDING_ADVICE_KINDS) expect(ADVICE_HELP[k].length).toBeGreaterThan(30);
  });

  it('never forecasts: "List and wait" says the time is unknown and nothing is listed for you, Hold that nothing says it will again', () => {
    expect(ADVICE_HELP.list).toContain('cannot say how long that takes');
    expect(ADVICE_HELP.list).toContain('never lists, bumps or trades for you');
    expect(ADVICE_HELP.hold).toContain('Nothing says it will again.');
    expect(ADVICE_FOOTER).toBe('From what Flip Desk saw while it ran; never a forecast.');
    expect(ADVICE_COLUMN_TITLE).toContain('never a forecast');
    expect(ADVICE_REFRESH_TITLE).toMatch(/^Refresh from backpack\.tf in the item panel first/);
    for (const text of [
      ...Object.values(ADVICE_HELP),
      ADVICE_BELOW_TARGET_HELP,
      ADVICE_BELOW_TARGET_FALLING_HELP,
      ADVICE_BELOW_TARGET_RESAVE_HELP,
      ADVICE_BELOW_TARGET_SINCE_SETTINGS_HELP,
    ]) {
      expect(text).not.toMatch(/\bwill (sell|rise|drop|fall)\b|\blikely\b|\bprobab/i);
    }
  });
});

describe('adviceReasonText: every code, dated', () => {
  const at = T0 - 3 * HOUR;
  const first = T0 - 4 * DAY;
  const cases: [HoldingAdviceReason, string][] = [
    [{ code: 'clears-target', profitScrap: 30, overScrap: 21, exit: 'backpack' }, `Selling now makes ${$s(30)}, ${$m(21)} over your minimum profit.`],
    [{ code: 'clears-target', profitScrap: 30, overScrap: 21, exit: 'scraptf' }, `Selling now makes ${$s(30)}, ${$m(21)} over your minimum profit (to scrap.tf).`],
    [
      { code: 'scraptf-instead', paysScrap: 130, profitScrap: 30, listAt: T0 - 2 * HOUR },
      `The backpack.tf buyer was not seen for a day, but scrap.tf's bank pays ${$m(130)} (your list saved 2 h ago): ${$s(30)}.`,
    ],
    [{ code: 'unverified-exit', seenAt: T0 - 30 * HOUR }, 'The order this rests on was last seen 1 d ago and may be gone.'],
    [{ code: 'unverified-exit', seenAt: null }, 'The order this rests on was last seen over a day ago and may be gone.'],
    [
      { code: 'list-beats-sale', listScrap: 149, askScrap: 150, gainScrap: 20, sellers: 3, bots: 1, mayIncludeOwn: true },
      `Listing at ${$m(149)} (1 scrap under the lowest of 3 matching asks, may include yours) would make ${$m(20)} more than selling now. Flip Desk sees no completed sales, so how long it takes is unknown; today's buyer stays the fallback while their order lasts.`,
    ],
    [
      { code: 'list-clears', listScrap: 149, askScrap: 150, profitScrap: 49, sellers: 1, bots: 0, mayIncludeOwn: false },
      `Listing at ${$m(149)}, 1 scrap under the lowest of 1 matching ask, would clear your thresholds (${$s(49)}). No buyer pays that now, and how long a listing takes is unknown.`,
    ],
    [
      { code: 'list-no-buyer', listScrap: 149, askScrap: 150, profitScrap: 49, sellers: 2, bots: 2, mayIncludeOwn: true },
      `No buyer now. The lowest of 2 matching asks is ${$m(150)}, may include yours; listing at ${$m(149)} would make ${$s(49)}. How long it takes is unknown.`,
    ],
    [{ code: 'asks-below-cost', askScrap: 90, sellers: 4 }, `No buyer now, and the lowest of 4 matching asks (${$m(90)}) is under what this unit cost you.`],
    [{ code: 'no-exit' }, 'No buyer, no usable scrap.tf price and no matching ask to compare with.'],
    [
      { code: 'recorded-high', exitScrap: 130, at, runs: 14, firstAt: first },
      `The best exit paid ${$m(130)} on ${fmtDateTime(at)} (14 recorded runs since ${fmtDate(first)}); nothing says it will again.`,
    ],
    [
      { code: 'reference-above', pricedbBuyScrap: 140, ageMs: 3 * DAY },
      `PriceDB's bot buy price is ${$m(140)} (3 d old). It is derived from backpack.tf and is no sale: no buyer pays it now.`,
    ],
    [{ code: 'reference-above', pricedbBuyScrap: 140, ageMs: null }, `PriceDB's bot buy price is ${$m(140)}. It is derived from backpack.tf and is no sale: no buyer pays it now.`],
    [
      { code: 'resave-list', highScrap: 130, highAt: at, listAt: T0 - 30 * HOUR },
      `Save your scrap.tf price list again: the best exit recorded, ${$m(130)} on ${fmtDateTime(at)}, was scrap.tf's price from it, and that list is 1 d old now.`,
    ],
    [
      { code: 'resave-list', highScrap: 130, highAt: at, listAt: null },
      `Save your scrap.tf price list again: the best exit recorded, ${$m(130)} on ${fmtDateTime(at)}, was scrap.tf's price from it, and that list is no longer saved now.`,
    ],
    [{ code: 'below-target', profitScrap: 4, minScrap: 9 }, `A sale now makes ${$s(4)}, under your minimum of ${$m(9)}.`],
    // Review (holdings): deciding a "Sell now" on a history that starts at a change of the buyer settings, it says so.
    [
      { code: 'below-target', profitScrap: 4, minScrap: 9, settingsAt: at },
      `A sale now makes ${$s(4)}, under your minimum of ${$m(9)}. Your blocklist, Revenue used for profit, outlier or notes settings changed on ${fmtDateTime(at)}, so runs recorded before then are not compared.`,
    ],
    [{ code: 'loss', profitScrap: -12 }, `A sale now makes ${$s(-12)}, a loss.`],
    [{ code: 'refresh-first', why: 'unverified-order', seenAt: T0 - 26 * HOUR }, 'Refresh from backpack.tf in the item panel first: the order was last seen 1 d ago.'],
    [{ code: 'refresh-first', why: 'unverified-order', seenAt: null }, 'Refresh from backpack.tf in the item panel first: the order was last seen over a day ago.'],
    [{ code: 'refresh-first', why: 'idle-book', seenAt: T0 - 2 * DAY }, 'Refresh from backpack.tf in the item panel first: no order changed and no snapshot came in for 2 d.'],
    [{ code: 'refresh-first', why: 'idle-book', seenAt: null }, 'Refresh from backpack.tf in the item panel first: no order changed and no snapshot came in for over a day.'],
    [{ code: 'single-exit', nextScrap: 104, nextProfitScrap: 4, nextUnverified: false }, `Only this buyer clears your thresholds: the next buyer pays ${$m(104)} (${$s(4)}).`],
    [
      { code: 'single-exit', nextScrap: 115, nextProfitScrap: 15, nextUnverified: true },
      `Only this buyer clears your thresholds: the next buyer pays ${$m(115)} (${$s(15)}) but was not seen in the last 24 h.`,
    ],
    [{ code: 'single-exit', nextScrap: null, nextProfitScrap: null, nextUnverified: false }, 'Only this buyer clears your thresholds; no other buyer is in the book.'],
    [
      { code: 'falling', fromScrap: 130, toScrap: 110, sinceAt: at },
      `The best exit fell in each of the last 3 recorded changes, from ${$m(130)} to ${$m(110)} since ${fmtDateTime(at)}.`,
    ],
    [
      { code: 'held-vs-typical', heldMs: 5 * DAY, typicalMs: 2 * DAY, count: 4, scope: 'item', stillHeld: 0 },
      'Held 5 d; your closed flips of this item took 2 d (median of 4, between the logged buy and sale).',
    ],
    [
      { code: 'held-vs-typical', heldMs: 5 * DAY, typicalMs: 2 * DAY, count: 7, scope: 'all', stillHeld: 1 },
      'Held 5 d; your closed flips of any item took 2 d (median of 7, between the logged buy and sale; 1 still held is not counted).',
    ],
    [
      { code: 'held-vs-typical', heldMs: 5 * DAY, typicalMs: 2 * DAY, count: 7, scope: 'all', stillHeld: 3 },
      'Held 5 d; your closed flips of any item took 2 d (median of 7, between the logged buy and sale; 3 still held are not counted).',
    ],
    // Review fix: sales logged in their buy's own minute hold 0, which fmtAge worded as "took now".
    [
      { code: 'held-vs-typical', heldMs: 5 * DAY, typicalMs: 0, count: 3, scope: 'item', stillHeld: 1 },
      'Held 5 d; your closed flips of this item took < 1 min (median of 3, between the logged buy and sale; 1 still held is not counted).',
    ],
    [
      { code: 'key-exposure', netKeys: -1, boughtKeyScrap: 560, nowKeyScrap: 568 },
      'This sale nets -1 key against what you paid, so each 1 ref the key moves changes this profit by about 1 ref. A key was 62.22 ref when you bought, 63.11 ref now.',
    ],
    [
      { code: 'key-exposure', netKeys: 2.5, boughtKeyScrap: 560, nowKeyScrap: 568 },
      'This sale nets +2.5 keys against what you paid, so each 1 ref the key moves changes this profit by about 2.5 ref. A key was 62.22 ref when you bought, 63.11 ref now.',
    ],
    [{ code: 'list-age', listAt: T0 - 3 * HOUR }, "scrap.tf's price is from your list saved 3 h ago."],
    [{ code: 'has-extras' }, 'Priced against buyers of a clean copy; the paint or extras are not valued here.'],
    [{ code: 'no-history', runs: 0, observedMs: 0, firstAt: null }, 'No exit history recorded for this item yet (Flip Desk records it while the live feed is on).'],
    [{ code: 'no-history', runs: 2, observedMs: 7 * HOUR, firstAt: first }, `Not enough recorded history yet: 2 runs over 7 h since ${fmtDate(first)}.`],
    // Review (holdings): the history starts at a change of the buyer settings, and says so.
    [
      { code: 'no-history', runs: 1, observedMs: 3 * HOUR, firstAt: at, settingsAt: at },
      `Not enough recorded history yet: 1 run over 3 h since ${fmtDate(at)}. Your blocklist, Revenue used for profit, outlier or notes settings changed on ${fmtDateTime(at)}, so runs recorded before then are not compared.`,
    ],
    [
      { code: 'no-history', runs: 0, observedMs: 0, firstAt: null, settingsAt: at },
      `No exit history recorded for this item yet (Flip Desk records it while the live feed is on). Your blocklist, Revenue used for profit, outlier or notes settings changed on ${fmtDateTime(at)}, so runs recorded before then are not compared.`,
    ],
  ];

  it.each(cases.map(([r, text]) => [r.code, r, text] as const))('%s', (_code, r, text) => {
    expect(adviceReasonText(r, KEY, T0)).toBe(text);
  });

  it('covers every reason code of the type', () => {
    const codes = new Set(cases.map(([r]) => r.code));
    expect([...codes].sort()).toEqual(
      [
        'asks-below-cost',
        'below-target',
        'clears-target',
        'falling',
        'has-extras',
        'held-vs-typical',
        'key-exposure',
        'list-age',
        'list-beats-sale',
        'list-clears',
        'list-no-buyer',
        'loss',
        'no-exit',
        'no-history',
        'recorded-high',
        'reference-above',
        'refresh-first',
        'resave-list',
        'scraptf-instead',
        'single-exit',
        'unverified-exit',
      ].sort(),
    );
  });

  it('dates every reason that rests on a time, and forecasts nothing', () => {
    for (const [r] of cases) {
      const text = adviceReasonText(r, KEY, T0);
      expect(text).not.toMatch(/\bwill (sell|rise|drop|fall|pay)\b|\blikely\b|\bprobab|\bexpect/i);
    }
  });
});

describe('adviceTitle', () => {
  const sellNow: HoldingAdvice = {
    kind: 'sell-now',
    reasons: [
      { code: 'clears-target', profitScrap: 30, overScrap: 21, exit: 'backpack' },
      { code: 'list-age', listAt: T0 - HOUR },
    ],
    basis: null,
    refreshFirst: false,
  };

  it('is the label and its help, one bullet per reason, then the footer', () => {
    expect(adviceTitle(sellNow, KEY, T0)).toBe(
      [`Sell now: ${ADVICE_HELP['sell-now']}`, `• ${adviceReasonText(sellNow.reasons[0]!, KEY, T0)}`, `• ${adviceReasonText(sellNow.reasons[1]!, KEY, T0)}`, ADVICE_FOOTER].join('\n'),
    );
  });

  it('uses the below-target help when below-target decides a "Sell now" (never "what your thresholds support")', () => {
    const below: HoldingAdvice = { kind: 'sell-now', reasons: [{ code: 'below-target', profitScrap: 4, minScrap: 9 }], basis: { runs: 5, firstAt: T0 - 3 * DAY }, refreshFirst: false };
    const t = adviceTitle(below, KEY, T0);
    expect(t.split('\n')[0]).toBe(`Sell now: ${ADVICE_BELOW_TARGET_HELP}`);
    expect(t).not.toContain(ADVICE_HELP['sell-now']);
    // As a supporting reason under no-history it claims nothing about the record.
    const unclear: HoldingAdvice = {
      kind: 'unclear',
      reasons: [
        { code: 'no-history', runs: 0, observedMs: 0, firstAt: null },
        { code: 'below-target', profitScrap: 4, minScrap: 9 },
      ],
      basis: null,
      refreshFirst: false,
    };
    expect(adviceTitle(unclear, KEY, T0).split('\n')[0]).toBe(`No clear signal: ${ADVICE_HELP.unclear}`);
    expect(adviceTitle(unclear, KEY, T0)).not.toContain(ADVICE_BELOW_TARGET_HELP);
  });

  it('never pairs the "none would clear" help with a falling or resave-list reason (review: holdings)', () => {
    const below = { code: 'below-target', profitScrap: 5, minScrap: 9 } as const;
    const falling = { code: 'falling', fromScrap: 140, toScrap: 105, sinceAt: T0 - 2 * DAY } as const;
    const resave = { code: 'resave-list', highScrap: 130, highAt: T0 - 2 * DAY, listAt: null } as const;
    const title = (reasons: HoldingAdviceReason[]) => adviceTitle({ kind: 'sell-now', reasons, basis: { runs: 5, firstAt: T0 - 3 * DAY }, refreshFirst: false }, KEY, T0);
    expect(title([below, falling]).split('\n')[0]).toBe(`Sell now: ${ADVICE_BELOW_TARGET_FALLING_HELP}`);
    expect(title([below, resave]).split('\n')[0]).toBe(`Sell now: ${ADVICE_BELOW_TARGET_RESAVE_HELP}`);
    // Both set the high aside: the falling streak is named.
    expect(title([below, resave, falling]).split('\n')[0]).toBe(`Sell now: ${ADVICE_BELOW_TARGET_FALLING_HELP}`);
    for (const reasons of [[below, falling], [below, resave], [below, resave, falling]]) expect(title(reasons)).not.toContain(ADVICE_BELOW_TARGET_HELP);
    expect(title([below]).split('\n')[0]).toBe(`Sell now: ${ADVICE_BELOW_TARGET_HELP}`);
  });

  it('names the settings change when the history checked starts there, never "every exit recorded while you held it" (review: holdings)', () => {
    const changedAt = T0 - 3 * DAY;
    const below = { code: 'below-target', profitScrap: 4, minScrap: 9, settingsAt: changedAt } as const;
    const title = (reasons: HoldingAdviceReason[]) => adviceTitle({ kind: 'sell-now', reasons, basis: { runs: 3, firstAt: changedAt }, refreshFirst: false }, KEY, T0);
    const t = title([below]);
    expect(t.split('\n')[0]).toBe(`Sell now: ${ADVICE_BELOW_TARGET_SINCE_SETTINGS_HELP}`);
    expect(t).not.toContain('while you held it');
    expect(t).toContain(`changed on ${fmtDateTime(changedAt)}, so runs recorded before then are not compared.`);
    // A falling streak still names what set the high aside; the reason line keeps the date.
    const falling = { code: 'falling', fromScrap: 140, toScrap: 105, sinceAt: T0 - 2 * DAY } as const;
    expect(title([below, falling]).split('\n')[0]).toBe(`Sell now: ${ADVICE_BELOW_TARGET_FALLING_HELP}`);
    expect(title([below, falling])).toContain(fmtDateTime(changedAt));
  });

  it('end to end: a high recorded before the buyer settings changed is never said to be checked while held (review: holdings)', () => {
    // Cost 100, held 4 d, the buyer pays 105 now (Below target). 150 from a buyer before the change, then 104, 106, 105 for 20 h each.
    const r = { ...row(105), heldSince: T0 - 4 * DAY };
    expect(r.status).toBe('hold');
    const base: Omit<HoldingMark, 'id' | 'fromAt' | 'toAt' | 'revMetalScrap'> = {
      baseSku: '378;6',
      revKeys: 0,
      revIsBot: true,
      revVerified: true,
      bestKeys: 0,
      bestMetalScrap: 150,
      nextKeys: null,
      nextMetalScrap: null,
      buyerCount: 2,
      verifiedBuyerCount: 2,
      askKeys: null,
      askMetalScrap: null,
      askCount: null,
      scraptfPaysKeys: null,
      scraptfPaysScrap: null,
      keyScrap: KEY,
    };
    const changedAt = T0 - 60 * HOUR;
    const marks: HoldingMark[] = [
      { ...base, id: 1, revMetalScrap: 150, fromAt: T0 - 71 * HOUR, toAt: T0 - 61 * HOUR },
      ...[104, 106, 105].map((v, i) => ({ ...base, id: i + 2, revMetalScrap: v, fromAt: changedAt + i * 20 * HOUR, toAt: changedAt + (i + 1) * 20 * HOUR })),
    ];
    const history = holdingExitHistory(marks, r.heldSince, KEY, T0, changedAt);
    expect(history.trend).not.toBeNull();
    const advice = holdingAdvice(r, history, P, KEY, T0);
    expect(advice.kind).toBe('sell-now');
    expect(advice.reasons.map((x) => x.code)).toEqual(['below-target']);
    const t = adviceTitle(advice, KEY, T0);
    expect(t.split('\n')[0]).toBe(`Sell now: ${ADVICE_BELOW_TARGET_SINCE_SETTINGS_HELP}`);
    expect(t).not.toContain(ADVICE_BELOW_TARGET_HELP);
    expect(t).toContain(`settings changed on ${fmtDateTime(changedAt)}`);
  });

  it("the review's case end to end: a falling series under target reads the falling help, never \"nothing recorded was higher\"", () => {
    // Cost 100, the buyer pays 105 now (Below target); five 16 h runs at 150, 140, 130, 120, 105.
    const r = row(105);
    expect(r.status).toBe('hold');
    const base: Omit<HoldingMark, 'id' | 'fromAt' | 'toAt' | 'revMetalScrap'> = {
      baseSku: '378;6',
      revKeys: 0,
      revIsBot: true,
      revVerified: true,
      bestKeys: 0,
      bestMetalScrap: 150,
      nextKeys: null,
      nextMetalScrap: null,
      buyerCount: 2,
      verifiedBuyerCount: 2,
      askKeys: null,
      askMetalScrap: null,
      askCount: null,
      scraptfPaysKeys: null,
      scraptfPaysScrap: null,
      keyScrap: KEY,
    };
    const marks: HoldingMark[] = [150, 140, 130, 120, 105].map((v, i) => ({ ...base, id: i + 1, revMetalScrap: v, fromAt: T0 - (5 - i) * 16 * HOUR, toAt: T0 - (4 - i) * 16 * HOUR }));
    const history = holdingExitHistory(marks, T0 - 4 * DAY, KEY, T0);
    expect(history.trend).toMatchObject({ direction: 'falling', recentHighScrap: 150 });
    const advice = holdingAdvice(r, history, P, KEY, T0);
    expect(advice.kind).toBe('sell-now');
    expect(advice.reasons.map((x) => x.code)).toEqual(['below-target', 'falling']);
    const t = adviceTitle(advice, KEY, T0);
    expect(t.split('\n')[0]).toBe(`Sell now: ${ADVICE_BELOW_TARGET_FALLING_HELP}`);
    expect(t).not.toContain('nothing Flip Desk recorded was higher');
    expect(t).not.toContain(ADVICE_BELOW_TARGET_HELP);
  });
});

describe('askSideText', () => {
  it('says what others ask, how many sellers and bots, when the lowest was seen, and that an ask is no price paid', () => {
    expect(askSideText(ask(), KEY, T0)).toBe(
      `Others ask from ${$m(150)} (3 sellers, 1 bot; may include yours), the lowest seen ${fmtAgo(T0 - 5 * MIN, T0)}. An ask is what a seller wants, not a price paid.`,
    );
    expect(askSideText(ask({ count: 1, botCount: 0, mayIncludeOwn: false, ownLeftOut: 2 }), KEY, T0)).toBe(
      `Others ask from ${$m(150)} (1 seller, 0 bots; 2 of yours left out), the lowest seen 5 min ago. An ask is what a seller wants, not a price paid.`,
    );
    expect(askSideText(ask({ mayIncludeOwn: false }), KEY, T0)).toContain('(3 sellers, 1 bot),');
  });

  it('is null without an ask', () => {
    expect(askSideText(null, KEY, T0)).toBeNull();
    expect(askSideText(undefined, KEY, T0)).toBeNull();
  });
});

describe('refsText', () => {
  it('names PriceDB with its age and the community price, as references only', () => {
    expect(refsText(refs(), KEY)).toBe(`PriceDB buys at ${$m(120)} (3 d old), sells at ${$m(140)}; community ${$m(130)}. References only, never a sale price.`);
    expect(refsText(refs({ communityHighScrap: 150 }), KEY)).toContain(`community ${$m(130)} to ${$m(150)}`);
    expect(refsText(refs({ pricedbBuyScrap: null, pricedbSellScrap: null, pricedbAgeMs: null }), KEY)).toBe(`Community ${$m(130)}. References only, never a sale price.`);
  });

  it('adds why a reference was left out for its age', () => {
    expect(refsText(refs({ communityScrap: null, ignored: ['Community price is 400 days old, ignored'] }), KEY)).toBe(
      `PriceDB buys at ${$m(120)} (3 d old), sells at ${$m(140)}. References only, never a sale price. Community price is 400 days old, ignored.`,
    );
    expect(refsText({ pricedbBuyScrap: null, pricedbSellScrap: null, pricedbAgeMs: null, communityScrap: null, communityHighScrap: null, ignored: ['PriceDB price is 90 days old, ignored'] }, KEY)).toBe(
      'PriceDB price is 90 days old, ignored.',
    );
  });

  it('is null without refs', () => {
    expect(refsText(null, KEY)).toBeNull();
    expect(refsText(undefined, KEY)).toBeNull();
    expect(refsText({ pricedbBuyScrap: null, pricedbSellScrap: null, pricedbAgeMs: null, communityScrap: null, communityHighScrap: null, ignored: [] }, KEY)).toBeNull();
  });
});

describe('the existing hovers with the ask and the references', () => {
  it('"Sells now for" ends with the ask side, and is exactly as before without one', () => {
    const plain = row(110);
    expect(holdingExitView(plain, KEY, T0).title).toBe(holdingSellsForTitle(plain, KEY));
    expect(holdingExitView({ ...plain, ask: null }, KEY, T0).title).toBe(holdingSellsForTitle(plain, KEY));
    const withAsk = row(110, { ask: ask() });
    expect(holdingExitView(withAsk, KEY, T0).title).toBe(`${holdingSellsForTitle(plain, KEY)} ${askSideText(ask(), KEY, T0)}`);
    // No buyer at all: the ask still shows after the "no buyers" line.
    const none = row(null, { ask: ask() });
    expect(holdingExitView(none, KEY, T0).title.endsWith(askSideText(ask(), KEY, T0)!)).toBe(true);
  });

  it('"Profit now" puts the references before the status help, so it still ends with what the status means', () => {
    const plain = row(130);
    const before = profitNowTitle(plain, KEY, P);
    expect(profitNowTitle({ ...plain, refs: null }, KEY, P)).toBe(before);
    const t = profitNowTitle({ ...plain, refs: refs() }, KEY, P);
    expect(t.endsWith(HOLDING_STATUS_HELP[plain.status])).toBe(true);
    expect(t).toContain(refsText(refs(), KEY)!);
    expect(t.indexOf(refsText(refs(), KEY)!)).toBeLessThan(t.indexOf(HOLDING_STATUS_HELP[plain.status]));
    // A row with no exit: the references, then the help.
    const none = row(null, { refs: refs() });
    expect(profitNowTitle(none, KEY, P)).toBe(`${refsText(refs(), KEY)} ${HOLDING_STATUS_HELP['no-buyers']}`);
  });

  it('keeps the status help free of advice words (D11)', () => {
    expect(HOLDING_STATUS_HELP.hold).toContain('This is not advice to hold');
    expect(HOLDING_STATUS_HELP.sell).toContain('The Advice column');
    expect(fmtAge(2 * DAY)).toBe('2 d');
  });
});
