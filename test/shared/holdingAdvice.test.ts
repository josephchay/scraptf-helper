// 0.8 (H1, H6): the shared holdings advice rules. Valuing a recorded exit run (markExitScrap, markExitSources),
// the history behind a holding (holdingExitHistory: counted runs, observed time, the trend compared only between
// runs observing the same sources) and Sell now / List and wait / Hold / No clear signal over every deciding
// branch and context reason. Pure; no network.

import { describe, expect, it } from 'vitest';
import { flipProfit, singleExitOf } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  HOLDING_LIST_MIN_GAIN_SCRAP,
  HOLDING_MARK_COUNT_KEYS,
  HOLDING_MARK_GAP_MS,
  HOLDING_MARK_MIN_RUN_MS,
  HOLDING_MARK_VALUE_KEYS,
  HOLDING_RECENT_HIGH_MIN_RUN_MS,
  HOLDING_TREND_MIN_OBSERVED_MS,
  attachHoldingAdvice,
  holdingAdvice,
  holdingExitHistory,
  holdingMarkSettingsKey,
  holdingMarkValuesOf,
  markExitScrap,
  markExitSources,
  sameHoldingMarkValues,
} from '../../src/shared/holdingAdvice';
import { holdingRow, type HoldingBuySide, type HoldingRowExtras } from '../../src/shared/holdings';
import type {
  HoldingAdviceReason,
  HoldingAskSide,
  HoldingExitHistory,
  HoldingMark,
  HoldingRow,
  HoldingTrend,
  JournalLot,
  NextBuyer,
  OrderSummary,
  ProfitSettings,
  ScraptfListRow,
} from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY = 567;
// Cost 100: the minimum profit is max(9, ceil(5)) = 9, and the margin 0.08 needs 8.
const P: ProfitSettings = DEFAULT_SETTINGS.profit;
const RESERVE: ProfitSettings = { ...P, exitReservePct: 0.1 };

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let nextId = 1;
/** A run: a 100 scrap verified revenue order from NOW - 2 h to NOW - 1 h, valued at KEY. */
function mark(over: Partial<HoldingMark> = {}): HoldingMark {
  return {
    id: nextId++,
    baseSku: '378;6',
    fromAt: NOW - 2 * HOUR,
    toAt: NOW - HOUR,
    revKeys: 0,
    revMetalScrap: 100,
    revIsBot: true,
    revVerified: true,
    bestKeys: 0,
    bestMetalScrap: 100,
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
    ...over,
  };
}

/** Back-to-back runs of `ms`, one per revenue exit (metal), the last ending at `end`. */
function series(exits: readonly (number | Partial<HoldingMark>)[], ms: number, end = NOW): HoldingMark[] {
  return exits.map((e, i) => {
    const toAt = end - (exits.length - 1 - i) * ms;
    const over = typeof e === 'number' ? { revMetalScrap: e } : e;
    return mark({ fromAt: toAt - ms, toAt, ...over });
  });
}

function order(value: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: `o${value}`,
    steamid: `S${value}`,
    userName: 'Buyer',
    keys: 0,
    metalScrap: value,
    valueScrap: value,
    isBot: true,
    online: null,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function side(value: number | null, over: Partial<HoldingBuySide> = {}): HoldingBuySide | null {
  if (value === null) return null;
  const o = order(value);
  return {
    revenueScrap: value,
    bestScrap: value,
    instantScrap: value,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 2,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    nextBuyer: null,
    verifiedBuyerCount: 1,
    ...over,
  };
}

function list(over: Partial<ScraptfListRow> = {}): ScraptfListRow {
  return {
    sku: '378;6',
    name: 'Team Captain',
    sellsKeys: 0,
    sellsScrapRaw: 140,
    sellsScrap: 140,
    paysKeys: 0,
    paysScrapRaw: 120,
    paysScrap: 120,
    stock: 1,
    stockLimit: 5,
    full: false,
    observedAt: NOW - HOUR,
    ...over,
  };
}

function askSide(lowest: number, over: Partial<HoldingAskSide> = {}): HoldingAskSide {
  return { lowestScrap: lowest, lowestKeys: 0, lowestMetalScrap: lowest, lowestIsBot: true, lowestSeenAt: NOW - MIN, count: 3, botCount: 2, ownLeftOut: 0, mayIncludeOwn: true, ...over };
}

interface RowOpts {
  sku?: string;
  cost?: number;
  lot?: Partial<JournalLot>;
  buy?: HoldingBuySide | null;
  list?: ScraptfListRow | null;
  extras?: Partial<HoldingRowExtras>;
  over?: Partial<HoldingRow>;
  p?: ProfitSettings;
}

/** A held unit bought 3 d ago for `cost` (100), priced by the shared holdingRow. */
function row(o: RowOpts = {}): HoldingRow {
  const cost = o.cost ?? 100;
  const lot: JournalLot = { id: 1, ts: NOW - 3 * DAY, costScrap: cost, keys: 0, scrap: cost, keyPriceScrap: KEY, ...o.lot };
  const pos = { sku: o.sku ?? '378;6', name: 'Team Captain', qty: 1, costScrap: lot.costScrap, lots: [lot] };
  const extras: HoldingRowExtras = { ask: null, refs: null, snapshotAt: NOW - HOUR, ...o.extras };
  const r = holdingRow(pos, 'hats', o.buy === undefined ? side(120) : o.buy, o.p ?? P, KEY, { list: o.list ?? null, now: NOW }, extras);
  return { ...r, ...o.over };
}

function trend(over: Partial<HoldingTrend> = {}): HoldingTrend {
  return {
    highScrap: 130,
    highAt: NOW - 2 * DAY,
    lowScrap: 100,
    lowAt: NOW - HOUR,
    firstScrap: 110,
    lastScrap: 105,
    recentHighScrap: null,
    recentHighAt: null,
    recentHighFrom: null,
    lastChangeAt: NOW - HOUR,
    direction: 'mixed',
    streak: null,
    ...over,
  };
}

function hist(t: HoldingTrend | null, over: Partial<HoldingExitHistory> = {}): HoldingExitHistory {
  return { runs: 12, observedMs: 60 * HOUR, firstAt: NOW - 3 * DAY, trend: t, ...over };
}

const codes = (rs: readonly HoldingAdviceReason[]): string[] => rs.map((r) => r.code);
const reason = <C extends HoldingAdviceReason['code']>(rs: readonly HoldingAdviceReason[], code: C) =>
  rs.find((r) => r.code === code) as Extract<HoldingAdviceReason, { code: C }> | undefined;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

describe('a recorded run (H1)', () => {
  it('values its best exit at today\'s key price, else its own, and never guesses one', () => {
    expect(markExitScrap(mark(), KEY)).toBe(100);
    const keyed = mark({ revKeys: 1, revMetalScrap: 9, keyScrap: 540 });
    expect(markExitScrap(keyed, KEY)).toBe(KEY + 9);
    expect(markExitScrap(keyed, null)).toBe(540 + 9);
    // Keys with no key price then or now: no exit, never DEFAULT_KEY_SCRAP.
    expect(markExitScrap(mark({ revKeys: 1, revMetalScrap: 9, keyScrap: null }), null)).toBeNull();
    // Metal alone needs no key price.
    expect(markExitScrap(mark({ keyScrap: null }), null)).toBe(100);
  });

  it("takes the higher of the revenue order and scrap.tf's pays price, and leaves an unverified order out", () => {
    expect(markExitScrap(mark({ scraptfPaysKeys: 0, scraptfPaysScrap: 120 }), KEY)).toBe(120);
    expect(markExitScrap(mark({ scraptfPaysKeys: 0, scraptfPaysScrap: 90 }), KEY)).toBe(100);
    expect(markExitScrap(mark({ revVerified: false }), KEY)).toBeNull();
    expect(markExitScrap(mark({ revVerified: false, scraptfPaysKeys: 0, scraptfPaysScrap: 90 }), KEY)).toBe(90);
    expect(markExitScrap(mark({ revKeys: null, revMetalScrap: null, revIsBot: null, revVerified: null }), KEY)).toBeNull();
  });

  it('names the sources it observed', () => {
    expect(markExitSources(mark())).toEqual({ backpack: true, scraptf: false });
    expect(markExitSources(mark({ revVerified: false, scraptfPaysKeys: 0, scraptfPaysScrap: 90 }))).toEqual({ backpack: false, scraptf: true });
    expect(markExitSources(mark({ revKeys: null, revMetalScrap: null, revVerified: null }))).toEqual({ backpack: false, scraptf: false });
  });

  it('compares two runs on their prices and flags, never the counts', () => {
    expect(HOLDING_MARK_VALUE_KEYS).not.toContain('buyerCount');
    expect([...HOLDING_MARK_COUNT_KEYS]).toEqual(['buyerCount', 'verifiedBuyerCount', 'askCount']);
    const a = mark();
    expect(sameHoldingMarkValues(a, { ...a, buyerCount: 9, verifiedBuyerCount: 5, askCount: 4 })).toBe(true);
    expect(sameHoldingMarkValues(a, { ...a, revMetalScrap: 101 })).toBe(false);
    expect(sameHoldingMarkValues(a, { ...a, revVerified: false })).toBe(false);
    expect(sameHoldingMarkValues(a, { ...a, askKeys: 0, askMetalScrap: 130 })).toBe(false);
    // A different key price alone is no change: runs keep raw keys and metal.
    expect(sameHoldingMarkValues(a, mark({ id: a.id + 1, keyScrap: 600, fromAt: a.toAt, toAt: a.toAt + HOUR }))).toBe(true);
  });

  it('reads what one check saw: both numbers of a side or neither, and the pays price only from a fresh, not-full list', () => {
    const next: NextBuyer = { valueScrap: 110, keys: 0, metalScrap: 110, isBot: false, online: null, lastEventAt: NOW - MIN, unverified: false };
    const buy = side(120, { nextBuyer: next, verifiedBuyerCount: 2, buyerCount: 3, revenueOrder: order(120, { keys: 1, metalScrap: 9, isBot: false }) })!;
    const v = holdingMarkValuesOf(buy, askSide(150, { lowestKeys: 0, lowestMetalScrap: 150, count: 4 }), list(), NOW);
    expect(v).toEqual({
      revKeys: 1,
      revMetalScrap: 9,
      revIsBot: false,
      revVerified: true,
      bestKeys: 0,
      bestMetalScrap: 120,
      nextKeys: 0,
      nextMetalScrap: 110,
      buyerCount: 3,
      verifiedBuyerCount: 2,
      askKeys: 0,
      askMetalScrap: 150,
      askCount: 4,
      scraptfPaysKeys: 0,
      scraptfPaysScrap: 120,
    });
    // A list over a day old, or full, observed no pays price.
    for (const l of [list({ observedAt: NOW - 25 * HOUR }), list({ full: true }), list({ paysScrap: null, paysScrapRaw: null, paysKeys: null })]) {
      expect(holdingMarkValuesOf(buy, null, l, NOW)).toMatchObject({ scraptfPaysKeys: null, scraptfPaysScrap: null });
    }
    // An order unseen for a day is recorded, flagged unverified.
    expect(holdingMarkValuesOf(side(120, { revenueOrder: order(120, { lastEventAt: NOW - 25 * HOUR }) }), null, null, NOW).revVerified).toBe(false);
    expect(holdingMarkValuesOf(null, null, null, NOW)).toEqual({
      revKeys: null,
      revMetalScrap: null,
      revIsBot: null,
      revVerified: null,
      bestKeys: null,
      bestMetalScrap: null,
      nextKeys: null,
      nextMetalScrap: null,
      buyerCount: 0,
      verifiedBuyerCount: null,
      askKeys: null,
      askMetalScrap: null,
      askCount: null,
      scraptfPaysKeys: null,
      scraptfPaysScrap: null,
    });
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe('holdingExitHistory (H6)', () => {
  const since = NOW - 10 * DAY;

  it('skips runs shorter than 5 min but always counts the newest', () => {
    const runs = [
      mark({ fromAt: NOW - 5 * HOUR, toAt: NOW - 3 * HOUR }),
      mark({ fromAt: NOW - 2 * HOUR, toAt: NOW - 2 * HOUR + HOLDING_MARK_MIN_RUN_MS - 1 }),
      mark({ fromAt: NOW - MIN, toAt: NOW - MIN }),
    ];
    const h = holdingExitHistory(runs, since, KEY, NOW);
    expect(h.runs).toBe(2);
    expect(h.observedMs).toBe(2 * HOUR);
    expect(h.firstAt).toBe(NOW - 5 * HOUR);
  });

  it('counts observed time only inside runs and since the holding began; gaps are not counted', () => {
    const runs = [
      mark({ fromAt: since - 2 * HOUR, toAt: since + HOUR }),
      mark({ fromAt: since + 11 * HOUR, toAt: since + 13 * HOUR }),
      // Before the holding began: left out.
      mark({ fromAt: since - 9 * HOUR, toAt: since - 5 * HOUR }),
    ];
    const h = holdingExitHistory(runs, since, KEY, NOW);
    expect(h).toMatchObject({ runs: 2, observedMs: 3 * HOUR, firstAt: since, trend: null });
    expect(holdingExitHistory([], since, KEY, NOW)).toEqual({ runs: 0, observedMs: 0, firstAt: null, trend: null });
  });

  it('gives no trend from two runs, from three runs under 48 h, or from one exit', () => {
    expect(holdingExitHistory(series([110, 100], 30 * HOUR), since, KEY, NOW).trend).toBeNull();
    const short = holdingExitHistory(series([120, 110, 100], 15 * HOUR), since, KEY, NOW);
    expect(short.observedMs).toBeLessThan(HOLDING_TREND_MIN_OBSERVED_MS);
    expect(short.trend).toBeNull();
    expect(holdingExitHistory(series([100, 100, 100], 20 * HOUR), since, KEY, NOW).trend).toBeNull();
    expect(holdingExitHistory(series([120, 110, 100], 16 * HOUR), since, KEY, NOW).trend).not.toBeNull();
  });

  it('reads no fall from a key price move at the same raw price', () => {
    // One key each run, while the key fell from 600 to 540: valued at today's key price, nothing moved.
    const keyed = (keyScrap: number): Partial<HoldingMark> => ({ revKeys: 1, revMetalScrap: 0, keyScrap });
    const runs = series([500, keyed(600), keyed(580), keyed(560), keyed(540)], 20 * HOUR);
    const t = holdingExitHistory(runs, since, KEY, NOW).trend!;
    expect(t.direction).toBe('mixed');
    expect(t.streak).toBeNull();
    expect(t.lastScrap).toBe(KEY);
  });

  it('needs 3 changes in a row for a direction, and gives the streak with its start', () => {
    expect(holdingExitHistory(series([130, 120, 110], 20 * HOUR), since, KEY, NOW).trend!.direction).toBe('mixed');
    const runs = series([140, 130, 120, 110], 20 * HOUR);
    const falling = holdingExitHistory(runs, since, KEY, NOW).trend!;
    expect(falling).toMatchObject({
      direction: 'falling',
      streak: { fromScrap: 140, toScrap: 110, sinceAt: runs[1]!.fromAt },
      highScrap: 140,
      highAt: runs[0]!.toAt,
      lowScrap: 110,
      lowAt: runs[3]!.toAt,
      firstScrap: 140,
      lastScrap: 110,
      lastChangeAt: runs[3]!.fromAt,
    });
    expect(holdingExitHistory(series([100, 110, 120, 130], 20 * HOUR), since, KEY, NOW).trend).toMatchObject({ direction: 'rising', streak: { fromScrap: 100, toScrap: 130 } });
    expect(holdingExitHistory(series([140, 130, 135, 120], 20 * HOUR), since, KEY, NOW).trend).toMatchObject({ direction: 'mixed', streak: null });
  });

  it('takes the recent high over the last 7 d from runs of an hour or more only', () => {
    // A 6-minute run at 150: counted, the high, but no recorded high to hold for.
    const blip = mark({ fromAt: NOW - 30 * HOUR, toAt: NOW - 30 * HOUR + 6 * MIN, revMetalScrap: 150 });
    // 140 more than 7 d ago: the high, too old for the recent one.
    const old = mark({ fromAt: NOW - 9 * DAY, toAt: NOW - 8 * DAY, revMetalScrap: 140 });
    const runs = [old, ...series([120, 110, 100], 20 * HOUR, NOW - 31 * HOUR), blip, mark({ fromAt: NOW - 29 * HOUR, toAt: NOW, revMetalScrap: 100 })];
    const t = holdingExitHistory(runs, since, KEY, NOW).trend!;
    expect(t.highScrap).toBe(150);
    expect(blip.toAt - blip.fromAt).toBeLessThan(HOLDING_RECENT_HIGH_MIN_RUN_MS);
    expect(t.recentHighScrap).toBe(120);
    expect(t.recentHighAt).toBe(NOW - 71 * HOUR);
    expect(t.recentHighFrom).toBe('backpack');
  });

  it('reads list staleness alone as no change: the pays price once seen, then not observed, is no fall', () => {
    const pays = (scrap: number): Partial<HoldingMark> => ({ revMetalScrap: 100, scraptfPaysKeys: 0, scraptfPaysScrap: scrap });
    // scrap.tf paid 130 while the list was fresh; then the list aged past a day and only the order was seen.
    const runs = series([pays(130), pays(130), 100, 100, 100], 15 * HOUR);
    const t = holdingExitHistory(runs, since, KEY, NOW).trend!;
    expect(t).toMatchObject({ direction: 'mixed', streak: null, lastChangeAt: null, recentHighScrap: 130, recentHighFrom: 'scraptf', lastScrap: 100 });
  });

  it('reads an order turning unconfirmed as no change either', () => {
    const both = { revMetalScrap: 130, scraptfPaysKeys: 0, scraptfPaysScrap: 100 };
    const unconfirmed = { ...both, revVerified: false };
    const runs = series([both, both, unconfirmed, unconfirmed, unconfirmed], 15 * HOUR);
    const t = holdingExitHistory(runs, since, KEY, NOW).trend!;
    expect(t).toMatchObject({ direction: 'mixed', lastChangeAt: null, recentHighScrap: 130, recentHighFrom: 'backpack' });
  });
});

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

describe('holdingAdvice: deciding branches (H6)', () => {
  it('(0) a stale backpack.tf buyer: scrap.tf instead when its fresh price clears, else no clear signal', () => {
    const stale = side(140, { revenueOrder: order(140, { lastEventAt: NOW - 30 * HOUR }) });
    const viaList = row({ buy: stale, list: list({ paysScrap: 115, paysScrapRaw: 115 }) });
    expect(viaList.bestExit).toBe('backpack');
    const a = holdingAdvice(viaList, null, P, KEY, NOW);
    expect(a.kind).toBe('sell-now');
    expect(a.reasons[0]).toEqual({ code: 'scraptf-instead', paysScrap: 115, profitScrap: 15, listAt: NOW - HOUR });
    expect(a.refreshFirst).toBe(true);
    expect(reason(a.reasons, 'refresh-first')).toEqual({ code: 'refresh-first', why: 'unverified-order', seenAt: NOW - 30 * HOUR });

    const b = holdingAdvice(row({ buy: stale }), null, P, KEY, NOW);
    expect(b.kind).toBe('unclear');
    expect(b.reasons[0]).toEqual({ code: 'unverified-exit', seenAt: NOW - 30 * HOUR });
    // The deciding reason already says so: no refresh-first beside it.
    expect(codes(b.reasons)).not.toContain('refresh-first');
    expect(b.refreshFirst).toBe(true);
  });

  it('(1) no buyers: list under the lowest ask when that profits, else what the asks say, else no exit', () => {
    const list1 = holdingAdvice(row({ buy: null, extras: { ask: askSide(130) } }), null, P, KEY, NOW);
    expect(list1.kind).toBe('list');
    expect(list1.reasons[0]).toEqual({ code: 'list-no-buyer', listScrap: 129, askScrap: 130, profitScrap: 29, sellers: 3, bots: 2, mayIncludeOwn: true });
    const below = holdingAdvice(row({ buy: null, extras: { ask: askSide(95) } }), null, P, KEY, NOW);
    expect(below.kind).toBe('unclear');
    expect(below.reasons[0]).toEqual({ code: 'asks-below-cost', askScrap: 95, sellers: 3 });
    const none = holdingAdvice(row({ buy: null }), null, P, KEY, NOW);
    expect(none.kind).toBe('unclear');
    expect(none.reasons[0]).toEqual({ code: 'no-exit' });
  });

  it('(2) clears target: sell now, with the next buyer judged as a live order', () => {
    const r = row();
    expect(r.status).toBe('sell');
    const a = holdingAdvice(r, null, P, KEY, NOW);
    expect(a.kind).toBe('sell-now');
    expect(a.reasons[0]).toEqual({ code: 'clears-target', profitScrap: 20, overScrap: 11, exit: 'backpack' });
    // No other buyer in the book: only this one clears.
    expect(reason(a.reasons, 'single-exit')).toEqual({ code: 'single-exit', nextScrap: null, nextProfitScrap: null, nextUnverified: false });
    const nb = (v: number): NextBuyer => ({ valueScrap: v, keys: 0, metalScrap: v, isBot: true, online: null, lastEventAt: NOW - MIN, unverified: false });
    expect(reason(holdingAdvice(row({ buy: side(120, { nextBuyer: nb(105) }) }), null, P, KEY, NOW).reasons, 'single-exit')).toEqual({
      code: 'single-exit',
      nextScrap: 105,
      nextProfitScrap: 5,
      nextUnverified: false,
    });
    expect(codes(holdingAdvice(row({ buy: side(120, { nextBuyer: nb(115) }) }), null, P, KEY, NOW).reasons)).not.toContain('single-exit');
    // A next buyer that would clear but was not seen for a day is never a backup (R-PC2, as singleExitOf).
    const stale: NextBuyer = { ...nb(115), lastEventAt: NOW - 3 * DAY, unverified: true };
    const s = holdingAdvice(row({ buy: side(120, { nextBuyer: stale, verifiedBuyerCount: 1 }) }), null, P, KEY, NOW);
    expect(s.kind).toBe('sell-now');
    expect(reason(s.reasons, 'single-exit')).toEqual({ code: 'single-exit', nextScrap: 115, nextProfitScrap: 15, nextUnverified: true });
    expect(singleExitOf(120, 100, stale, P)).not.toBeNull();
    // Depth unknown (an older buy side): no claim about other buyers.
    const { nextBuyer: _n, ...noDepth } = side(120)!;
    expect(codes(holdingAdvice(row({ buy: noDepth }), null, P, KEY, NOW).reasons)).not.toContain('single-exit');
  });

  it('(2) switches to list and wait only for a gain of max(minimum, 9), two verified buyers, no fall and a confirmed book', () => {
    const two = side(120, { verifiedBuyerCount: 2 });
    // Lowest ask 130: listing at 129 makes 29, 9 more than selling now.
    const a = holdingAdvice(row({ buy: two, extras: { ask: askSide(130) } }), null, P, KEY, NOW);
    expect(a.kind).toBe('list');
    expect(codes(a.reasons).slice(0, 2)).toEqual(['list-beats-sale', 'clears-target']);
    expect(a.reasons[0]).toEqual({ code: 'list-beats-sale', listScrap: 129, askScrap: 130, gainScrap: HOLDING_LIST_MIN_GAIN_SCRAP, sellers: 3, bots: 2, mayIncludeOwn: true });
    // 8 more is not enough.
    expect(holdingAdvice(row({ buy: two, extras: { ask: askSide(129) } }), null, P, KEY, NOW).kind).toBe('sell-now');
    // One verified buyer.
    expect(holdingAdvice(row({ extras: { ask: askSide(150) } }), null, P, KEY, NOW).kind).toBe('sell-now');
    // A falling trend.
    const fall = hist(trend({ direction: 'falling', streak: { fromScrap: 140, toScrap: 120, sinceAt: NOW - DAY } }));
    expect(holdingAdvice(row({ buy: two, extras: { ask: askSide(150) } }), fall, P, KEY, NOW).kind).toBe('sell-now');
    // A book to refresh first: scrap.tf pays more than a stale order, which is still the book's revenue order.
    const stale = side(100, { verifiedBuyerCount: 2, revenueOrder: order(100, { lastEventAt: NOW - 30 * HOUR }) });
    const r = row({ buy: stale, list: list(), extras: { ask: askSide(160) } });
    expect(r).toMatchObject({ bestExit: 'scraptf', status: 'sell' });
    const c = holdingAdvice(r, null, P, KEY, NOW);
    expect(c.kind).toBe('sell-now');
    expect(c.refreshFirst).toBe(true);
    expect(codes(c.reasons)).toEqual(['clears-target', 'refresh-first', 'list-age', 'no-history']);
    expect(c.reasons[0]).toMatchObject({ exit: 'scraptf' });
  });

  it('(3) below target or a loss: a listing that clears, then a recorded high, never a guess', () => {
    const hold = row({ buy: side(105) });
    expect(hold.status).toBe('hold');
    const listed = holdingAdvice(row({ buy: side(105), extras: { ask: askSide(130) } }), null, P, KEY, NOW);
    expect(listed.kind).toBe('list');
    expect(listed.reasons[0]).toEqual({ code: 'list-clears', listScrap: 129, askScrap: 130, profitScrap: 29, sellers: 3, bots: 2, mayIncludeOwn: true });

    const high = hist(trend({ recentHighScrap: 130, recentHighAt: NOW - 2 * DAY, recentHighFrom: 'backpack' }));
    const held = holdingAdvice(hold, high, P, KEY, NOW);
    expect(held.kind).toBe('hold');
    expect(held.reasons[0]).toEqual({ code: 'recorded-high', exitScrap: 130, at: NOW - 2 * DAY, runs: 12, firstAt: NOW - 3 * DAY });
    expect(held.basis).toEqual({ runs: 12, firstAt: NOW - 3 * DAY });

    // Nothing recorded, or too little: no clear signal, never "Sell now".
    const first = holdingAdvice(hold, null, P, KEY, NOW);
    expect(first.kind).toBe('unclear');
    expect(first.reasons.slice(0, 2)).toEqual([
      { code: 'no-history', runs: 0, observedMs: 0, firstAt: null },
      { code: 'below-target', profitScrap: 5, minScrap: 9 },
    ]);
    expect(codes(first.reasons).filter((c) => c === 'no-history')).toHaveLength(1);
    expect(first.basis).toBeNull();
    const loss = row({ buy: side(95) });
    expect(loss.status).toBe('loss');
    expect(holdingAdvice(loss, hist(null, { runs: 2, observedMs: 3 * HOUR }), P, KEY, NOW).reasons.slice(0, 2)).toEqual([
      { code: 'no-history', runs: 2, observedMs: 3 * HOUR, firstAt: NOW - 3 * DAY },
      { code: 'loss', profitScrap: -5 },
    ]);

    // A trend and nothing higher that clears: sell now, below target deciding.
    const flat = holdingAdvice(hold, hist(trend({ recentHighScrap: 106, recentHighAt: NOW - DAY, recentHighFrom: 'backpack' })), P, KEY, NOW);
    expect(flat.kind).toBe('sell-now');
    expect(flat.reasons[0]).toEqual({ code: 'below-target', profitScrap: 5, minScrap: 9 });
    expect(codes(flat.reasons)).not.toContain('recorded-high');
    expect(codes(flat.reasons)).not.toContain('no-history');
    // A loss with a trend: no clear signal.
    expect(holdingAdvice(loss, hist(trend()), P, KEY, NOW)).toMatchObject({ kind: 'unclear', reasons: [{ code: 'loss', profitScrap: -5 }] });
  });

  it('(3) never holds on a falling streak, a scrap.tf high from a merely stale list, or a reference', () => {
    const hold = row({ buy: side(105) });
    const falling = trend({ recentHighScrap: 130, recentHighAt: NOW - 2 * DAY, recentHighFrom: 'backpack', direction: 'falling', streak: { fromScrap: 130, toScrap: 105, sinceAt: NOW - 2 * DAY } });
    const f = holdingAdvice(hold, hist(falling), P, KEY, NOW);
    expect(f.kind).toBe('sell-now');
    expect(codes(f.reasons)).toEqual(['below-target', 'falling']);
    expect(reason(f.reasons, 'falling')).toEqual({ code: 'falling', fromScrap: 130, toScrap: 105, sinceAt: NOW - 2 * DAY });

    const fromList = trend({ recentHighScrap: 130, recentHighAt: NOW - 2 * DAY, recentHighFrom: 'scraptf' });
    const s = holdingAdvice(hold, hist(fromList), P, KEY, NOW);
    expect(s.kind).toBe('sell-now');
    expect(codes(s.reasons)).toEqual(['below-target', 'resave-list']);
    expect(reason(s.reasons, 'resave-list')).toEqual({ code: 'resave-list', highScrap: 130, highAt: NOW - 2 * DAY, listAt: null });
    // With the list saved again (fresh, paying less now), the recorded scrap.tf high may decide.
    const fresh = row({ buy: side(105), list: list({ paysScrap: 90, paysScrapRaw: 90 }) });
    expect(holdingAdvice(fresh, hist(fromList), P, KEY, NOW).kind).toBe('hold');

    // PriceDB buys at 150, above every live exit: context only, never a reason to hold.
    const ref = row({ buy: side(105), extras: { refs: { pricedbBuyScrap: 150, pricedbSellScrap: 160, pricedbAgeMs: 3 * DAY, communityScrap: null, communityHighScrap: null, ignored: [] } } });
    const r = holdingAdvice(ref, null, P, KEY, NOW);
    expect(r.kind).toBe('unclear');
    expect(codes(r.reasons)).toEqual(['no-history', 'below-target', 'reference-above']);
    expect(reason(r.reasons, 'reference-above')).toEqual({ code: 'reference-above', pricedbBuyScrap: 150, ageMs: 3 * DAY });
    expect(holdingAdvice(ref, hist(trend()), P, KEY, NOW).kind).toBe('sell-now');
  });
});

describe('holdingAdvice: the price-move reserve (PC-1, R-PC1-sell)', () => {
  it('judges hypothetical sales with flipProfit, the live order and the next buyer with friction only', () => {
    expect(flipProfit(111, 100, RESERVE)).toBe(-1);
    // A listing at 111 clears without the reserve (11), not with it.
    const listed = (p: ProfitSettings) => holdingAdvice(row({ buy: side(105), extras: { ask: askSide(112) }, p }), null, p, KEY, NOW).kind;
    expect(listed(P)).toBe('list');
    expect(listed(RESERVE)).toBe('unclear');
    // A recorded high of 112 likewise.
    const high = hist(trend({ recentHighScrap: 112, recentHighAt: NOW - DAY, recentHighFrom: 'backpack' }));
    expect(holdingAdvice(row({ buy: side(105) }), high, P, KEY, NOW).kind).toBe('hold');
    expect(holdingAdvice(row({ buy: side(105), p: RESERVE }), high, RESERVE, KEY, NOW).kind).toBe('sell-now');
    // A reference of 115 is context without the reserve only.
    const refs = { pricedbBuyScrap: 115, pricedbSellScrap: null, pricedbAgeMs: null, communityScrap: null, communityHighScrap: null, ignored: [] };
    expect(codes(holdingAdvice(row({ buy: side(105), extras: { refs } }), null, P, KEY, NOW).reasons)).toContain('reference-above');
    expect(codes(holdingAdvice(row({ buy: side(105), extras: { refs }, p: RESERVE }), null, RESERVE, KEY, NOW).reasons)).not.toContain('reference-above');

    // Revenue = next = 120 at cost 100: the next buyer makes 20 (friction only) and clears; flipProfit's 8 would not.
    const nb: NextBuyer = { valueScrap: 120, keys: 0, metalScrap: 120, isBot: false, online: null, lastEventAt: NOW - MIN, unverified: false };
    expect(flipProfit(120, 100, RESERVE)).toBe(8);
    const a = holdingAdvice(row({ buy: side(120, { nextBuyer: nb }), p: RESERVE }), null, RESERVE, KEY, NOW);
    expect(a.kind).toBe('sell-now');
    expect(a.reasons[0]).toEqual({ code: 'clears-target', profitScrap: 20, overScrap: 11, exit: 'backpack' });
    expect(codes(a.reasons)).not.toContain('single-exit');
  });
});

describe('holdingAdvice: context reasons (H6)', () => {
  it('appends them in a fixed order, each once', () => {
    const r = row({
      sku: '378;6;p3100495',
      buy: side(105, { revenueOrder: order(105) }),
      lot: { keys: 1, scrap: 0, costScrap: 540, keyPriceScrap: 540 },
      cost: 540,
      extras: { refs: { pricedbBuyScrap: 700, pricedbSellScrap: null, pricedbAgeMs: DAY, communityScrap: null, communityHighScrap: null, ignored: [] } },
      over: { typicalHold: { medianMs: 2 * DAY, count: 4, scope: 'item', stillHeld: 1 } },
    });
    expect(r.flags).toContain('has-extras');
    const fromList = trend({ recentHighScrap: 700, recentHighAt: NOW - DAY, recentHighFrom: 'scraptf', direction: 'falling', streak: { fromScrap: 700, toScrap: 600, sinceAt: NOW - DAY } });
    const a = holdingAdvice({ ...r, snapshotAt: null, lastOrderChangeAt: null, revenueOrder: null, bestExit: 'backpack' }, hist(fromList), P, KEY, NOW);
    expect(codes(a.reasons)).toEqual(['loss', 'reference-above', 'resave-list', 'refresh-first', 'falling', 'held-vs-typical', 'key-exposure', 'has-extras']);
  });

  it('asks to refresh an idle book first: no buy order, no change and no snapshot for a day', () => {
    const idle = row({ buy: null, extras: { snapshotAt: null } });
    const a = holdingAdvice(idle, null, P, KEY, NOW);
    expect(a.refreshFirst).toBe(true);
    expect(reason(a.reasons, 'refresh-first')).toEqual({ code: 'refresh-first', why: 'idle-book', seenAt: null });
    const old = holdingAdvice(row({ buy: null, extras: { snapshotAt: NOW - 30 * HOUR } }), null, P, KEY, NOW);
    expect(reason(old.reasons, 'refresh-first')).toEqual({ code: 'refresh-first', why: 'idle-book', seenAt: NOW - 30 * HOUR });
    // A snapshot within the day confirms the empty book.
    expect(holdingAdvice(row({ buy: null, extras: { snapshotAt: NOW - 2 * HOUR } }), null, P, KEY, NOW).refreshFirst).toBe(false);
    // A fresh revenue order is no reason to refresh.
    expect(holdingAdvice(row(), null, P, KEY, NOW).refreshFirst).toBe(false);
  });

  it("compares the hold with the user's typical one, item or all, with the units left out", () => {
    for (const scope of ['item', 'all'] as const) {
      const r = row({ over: { typicalHold: { medianMs: 2 * DAY, count: 6, scope, stillHeld: 3 } } });
      expect(reason(holdingAdvice(r, null, P, KEY, NOW).reasons, 'held-vs-typical')).toEqual({ code: 'held-vs-typical', heldMs: 3 * DAY, typicalMs: 2 * DAY, count: 6, scope, stillHeld: 3 });
    }
    expect(codes(holdingAdvice(row(), null, P, KEY, NOW).reasons)).not.toContain('held-vs-typical');
  });

  it('names the key exposure from half a key net, at the key price then and now', () => {
    // Bought for 1 key while a key was 540; the buyer pays 600 scrap in metal: the sale nets -1 key.
    const keyLot = { lot: { keys: 1, scrap: 0, costScrap: 540, keyPriceScrap: 540 }, cost: 540 };
    const r = row({ ...keyLot, buy: side(600) });
    expect(r.nextLotKeyPriceScrap).toBe(540);
    expect(reason(holdingAdvice(r, null, P, KEY, NOW).reasons, 'key-exposure')).toEqual({ code: 'key-exposure', netKeys: -1, boughtKeyScrap: 540, nowKeyScrap: KEY });
    // Paid in keys, sold in keys: no exposure.
    const inKeys = row({ ...keyLot, buy: side(KEY + 30, { revenueOrder: order(KEY + 30, { keys: 1, metalScrap: 30 }) }) });
    expect(codes(holdingAdvice(inKeys, null, P, KEY, NOW).reasons)).not.toContain('key-exposure');
    // Without today's key price: nothing said.
    expect(codes(holdingAdvice(r, null, P, null, NOW).reasons)).not.toContain('key-exposure');
  });

  it("dates scrap.tf's price, flags extras and says what history there is", () => {
    const viaList = row({ buy: side(100), list: list() });
    expect(viaList.bestExit).toBe('scraptf');
    const a = holdingAdvice(viaList, hist(null, { runs: 2, observedMs: 5 * HOUR, firstAt: NOW - 6 * HOUR }), P, KEY, NOW);
    expect(reason(a.reasons, 'list-age')).toEqual({ code: 'list-age', listAt: NOW - HOUR });
    expect(reason(a.reasons, 'no-history')).toEqual({ code: 'no-history', runs: 2, observedMs: 5 * HOUR, firstAt: NOW - 6 * HOUR });
    expect(a.basis).toEqual({ runs: 2, firstAt: NOW - 6 * HOUR });
    expect(codes(holdingAdvice(row({ sku: '378;6;p3100495' }), null, P, KEY, NOW).reasons)).toContain('has-extras');
    expect(codes(holdingAdvice(row(), hist(trend()), P, KEY, NOW).reasons)).not.toContain('no-history');
  });

  it('attachHoldingAdvice adds the advice and keeps the row', () => {
    const r = row();
    const withAdvice = attachHoldingAdvice(r, null, P, KEY, NOW);
    expect(withAdvice).toEqual({ ...r, advice: holdingAdvice(r, null, P, KEY, NOW) });
    const key = row({ sku: '5021;6', buy: null, extras: { snapshotAt: null } });
    expect(attachHoldingAdvice(key, null, P, KEY, NOW, { book: false })).toEqual({ ...key, advice: holdingAdvice(key, null, P, KEY, NOW, { book: false }) });
  });
});

// ---------------------------------------------------------------------------
// Review fixes (holdings)
// ---------------------------------------------------------------------------

describe('holdingExitHistory: runs split only on a value the exit does not read are one stretch', () => {
  // Cost 100, held since NOW - 3 d, the buyer pays 105 now (Below target). The exit was 100 for 40 h, then the revenue
  // order stood at 150 for 160 min while only the next buyer moved every 40 min (the recorder split it into four
  // 30-minute runs, sampled every 10 min), then 105 until now.
  const t150 = NOW - 20 * HOUR;
  function recorded(next: (i: number) => number | null, gapMs = 10 * MIN): HoldingMark[] {
    const before = mark({ fromAt: t150 - 40 * HOUR - 10 * MIN, toAt: t150 - 10 * MIN, revMetalScrap: 100 });
    const subs = [0, 1, 2, 3].map((i) => {
      const fromAt = t150 + i * (30 * MIN + gapMs);
      const n = next(i);
      return mark({ fromAt, toAt: fromAt + 30 * MIN, revMetalScrap: 150, nextKeys: n === null ? null : 0, nextMetalScrap: n });
    });
    const after = mark({ fromAt: subs[3]!.toAt + 10 * MIN, toAt: NOW, revMetalScrap: 105 });
    return [before, ...subs, after];
  }

  it('holds for a buy order that stood 160 min across sub-runs split only by the next buyer', () => {
    const r = row({ buy: side(105) });
    expect(r.status).toBe('hold');
    const runs = recorded((i) => 90 + i);
    const h = holdingExitHistory(runs, r.heldSince, KEY, NOW);
    expect(h.runs).toBe(3);
    expect(h.trend).toMatchObject({ highScrap: 150, recentHighScrap: 150, recentHighAt: runs[4]!.toAt, recentHighFrom: 'backpack', direction: 'mixed' });
    const a = holdingAdvice(r, h, P, KEY, NOW);
    expect(a.kind).toBe('hold');
    expect(a.reasons[0]).toEqual({ code: 'recorded-high', exitScrap: 150, at: runs[4]!.toAt, runs: 3, firstAt: runs[0]!.fromAt });
  });

  it('keeps runs apart across a break in watching (identical values) or a silence over the gap', () => {
    const r = row({ buy: side(105) });
    // Identical values were split by a feed or app restart: four 30-minute runs, none an hour.
    const restarted = holdingExitHistory(recorded(() => 90), r.heldSince, KEY, NOW);
    expect(restarted.runs).toBe(6);
    expect(restarted.trend!.recentHighScrap).toBe(105);
    expect(holdingAdvice(r, restarted, P, KEY, NOW).kind).toBe('sell-now');
    // A silence longer than HOLDING_MARK_GAP_MS between them: not watched, so not one stretch.
    const silent = holdingExitHistory(recorded((i) => 90 + i, HOLDING_MARK_GAP_MS + MIN), r.heldSince, KEY, NOW);
    expect(silent.trend!.recentHighScrap).toBe(105);
  });

  it('applies the 5-minute rule to the stretch, not to each run', () => {
    const runs = [
      mark({ fromAt: NOW - 10 * HOUR, toAt: NOW - 5 * HOUR, revMetalScrap: 100 }),
      // Two 3-minute runs at 120, split by the lowest ask: one 7-minute stretch.
      mark({ fromAt: NOW - 4 * HOUR, toAt: NOW - 4 * HOUR + 3 * MIN, revMetalScrap: 120, askKeys: 0, askMetalScrap: 130 }),
      mark({ fromAt: NOW - 4 * HOUR + 4 * MIN, toAt: NOW - 4 * HOUR + 7 * MIN, revMetalScrap: 120, askKeys: 0, askMetalScrap: 131 }),
      mark({ fromAt: NOW - 3 * HOUR, toAt: NOW, revMetalScrap: 100 }),
    ];
    expect(runs[1]!.toAt - runs[1]!.fromAt).toBeLessThan(HOLDING_MARK_MIN_RUN_MS);
    const h = holdingExitHistory(runs, NOW - 10 * DAY, KEY, NOW);
    expect(h).toMatchObject({ runs: 3, observedMs: 5 * HOUR + 7 * MIN + 3 * HOUR });
  });

  it('names backpack.tf as the recent high when the revenue order paid that exit in any run of the stretch', () => {
    const both = (rev: number, pays: number, over: Partial<HoldingMark> = {}) => ({ revMetalScrap: rev, scraptfPaysKeys: 0, scraptfPaysScrap: pays, ...over });
    const at = (fromAt: number, toAt: number, over: Partial<HoldingMark>) => mark({ fromAt, toAt, ...over });
    const history = (a: Partial<HoldingMark>, b: Partial<HoldingMark>) =>
      holdingExitHistory(
        [at(NOW - 52 * HOUR, NOW - 22 * HOUR, both(100, 100)), at(NOW - 22 * HOUR, NOW - 21 * HOUR, a), at(NOW - 21 * HOUR, NOW - 20 * HOUR, b), at(NOW - 20 * HOUR, NOW, both(110, 100))],
        NOW - 10 * DAY,
        KEY,
        NOW,
      ).trend!;
    expect(history(both(150, 140), both(140, 150))).toMatchObject({ recentHighScrap: 150, recentHighAt: NOW - 20 * HOUR, recentHighFrom: 'backpack' });
    expect(history(both(140, 150), both(130, 150))).toMatchObject({ recentHighScrap: 150, recentHighFrom: 'scraptf' });
  });
});

describe('holdingExitHistory: runs recorded under other buyer settings are not compared', () => {
  it('holdingMarkSettingsKey moves with the blocklist, the revenue order, the outlier multiples and the notes keywords only', () => {
    const base = { blocklist: ['76561198000000001', '76561198000000002'], profit: P };
    const k = holdingMarkSettingsKey(base);
    expect(holdingMarkSettingsKey({ blocklist: ['76561198000000002', ' 76561198000000001 ', '76561198000000001'], profit: P })).toBe(k);
    expect(holdingMarkSettingsKey({ ...base, profit: { ...P, minProfitScrap: 30, minMargin: 0.5, exitReservePct: 0.2, referenceMaxAgeMs: DAY, inputStaleMs: HOUR } })).toBe(k);
    const changed = [
      { ...base, blocklist: [...base.blocklist, '76561198000000003'] },
      { ...base, profit: { ...P, useOrder: 'best' as const } },
      { ...base, profit: { ...P, outlierVsMedian: P.outlierVsMedian + 1 } },
      { ...base, profit: { ...P, outlierVsRef: P.outlierVsRef + 1 } },
      { ...base, profit: { ...P, notesKeywords: [...P.notesKeywords, 'review-test keyword'] } },
    ];
    for (const s of changed) expect(holdingMarkSettingsKey(s)).not.toBe(k);
    // Broken input never throws.
    expect(typeof holdingMarkSettingsKey(null)).toBe('string');
  });

  it("never holds for a buyer since blocklisted: the history starts at the change, and says so", () => {
    const r = row({ buy: side(105) });
    // 110 for 20 h, then 150 for 20 h from buyer X, then 105 from another buyer once X was blocklisted.
    const runs = [
      mark({ fromAt: NOW - 70 * HOUR, toAt: NOW - 50 * HOUR, revMetalScrap: 110 }),
      mark({ fromAt: NOW - 50 * HOUR, toAt: NOW - 30 * HOUR, revMetalScrap: 150, revIsBot: false }),
      mark({ fromAt: NOW - 30 * HOUR, toAt: NOW, revMetalScrap: 105 }),
    ];
    const before = holdingExitHistory(runs, r.heldSince, KEY, NOW);
    expect(before.trend!.recentHighScrap).toBe(150);
    expect(holdingAdvice(r, before, P, KEY, NOW).kind).toBe('hold');

    const changedAt = NOW - 29 * HOUR;
    const after = holdingExitHistory(runs, r.heldSince, KEY, NOW, changedAt);
    // Only the run still seen after the change; its time counts from the change.
    expect(after).toEqual({ runs: 1, observedMs: 29 * HOUR, firstAt: changedAt, trend: null, settingsAt: changedAt });
    const a = holdingAdvice(r, after, P, KEY, NOW);
    expect(a.kind).toBe('unclear');
    expect(a.reasons.slice(0, 2)).toEqual([
      { code: 'no-history', runs: 1, observedMs: 29 * HOUR, firstAt: changedAt, settingsAt: changedAt },
      { code: 'below-target', profitScrap: 5, minScrap: 9 },
    ]);
  });

  it('a below-target "Sell now" on a trend recorded after the change carries the change date (review: the hover names the cut)', () => {
    const r = row({ buy: side(105) });
    expect(r.status).toBe('hold');
    const changedAt = NOW - 60 * HOUR;
    // 150 from a buyer since blocklisted (before the change), then 104, 106, 105 for 20 h each: none of them clears.
    const after = [
      mark({ fromAt: NOW - 60 * HOUR, toAt: NOW - 40 * HOUR, revMetalScrap: 104 }),
      mark({ fromAt: NOW - 40 * HOUR, toAt: NOW - 20 * HOUR, revMetalScrap: 106 }),
      mark({ fromAt: NOW - 20 * HOUR, toAt: NOW, revMetalScrap: 105 }),
    ];
    const runs = [mark({ fromAt: NOW - 71 * HOUR, toAt: NOW - 61 * HOUR, revMetalScrap: 150, revIsBot: false }), ...after];
    // Without the change the 150 is a recorded high that clears: Hold.
    expect(holdingAdvice(r, holdingExitHistory(runs, r.heldSince, KEY, NOW), P, KEY, NOW).kind).toBe('hold');
    const history = holdingExitHistory(runs, r.heldSince, KEY, NOW, changedAt);
    expect(history).toMatchObject({ runs: 3, firstAt: changedAt, settingsAt: changedAt, trend: { recentHighScrap: 106, direction: 'mixed' } });
    const a = holdingAdvice(r, history, P, KEY, NOW);
    expect(a.kind).toBe('sell-now');
    // The trend is there, so no no-history reason names the change: the deciding reason does.
    expect(a.reasons).toEqual([{ code: 'below-target', profitScrap: 5, minScrap: 9, settingsAt: changedAt }]);
    // No change since the holding began: the reason is as before, with no date.
    const plain = holdingAdvice(r, holdingExitHistory(after, r.heldSince, KEY, NOW), P, KEY, NOW);
    expect(plain.kind).toBe('sell-now');
    expect(plain.reasons[0]).toEqual({ code: 'below-target', profitScrap: 5, minScrap: 9 });
    expect(plain.reasons[0]).not.toHaveProperty('settingsAt');
  });

  it('ignores a change before the holding began, and never cuts after now', () => {
    const runs = series([120, 110, 100], 20 * HOUR);
    const plain = holdingExitHistory(runs, NOW - 10 * DAY, KEY, NOW);
    expect(holdingExitHistory(runs, NOW - 10 * DAY, KEY, NOW, NOW - 11 * DAY)).toEqual(plain);
    expect(holdingExitHistory(runs, NOW - 10 * DAY, KEY, NOW, null)).toEqual(plain);
    // A change stamped ahead of the clock (a clock step back): only the newest run, cut at now.
    expect(holdingExitHistory(runs, NOW - 10 * DAY, KEY, NOW, NOW + HOUR)).toMatchObject({ runs: 1, observedMs: 0, firstAt: NOW, settingsAt: NOW, trend: null });
  });
});

describe('holdingAdvice: a currency has no book (review: holdings)', () => {
  it('asks for no refresh and waits for no history', () => {
    const key = row({ sku: '5021;6', buy: null, extras: { snapshotAt: null } });
    expect(key.status).toBe('no-buyers');
    // Without the option it reads as an idle book.
    expect(holdingAdvice(key, null, P, KEY, NOW).refreshFirst).toBe(true);
    const a = holdingAdvice(key, null, P, KEY, NOW, { book: false });
    expect(a).toEqual({ kind: 'unclear', reasons: [{ code: 'no-exit' }], basis: null, refreshFirst: false });
  });
});
