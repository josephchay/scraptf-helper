// 0.8 (H3, H4): the shared ask side (askSideOf), a held row's references (holdingRefsOf), scraptfAlternative in its
// new home (src/shared/holdings.ts) and unverifiedRevenue in src/shared/buyerSeen.ts. Pure; no network.

import { describe, expect, it } from 'vitest';
import { ORDER_UNVERIFIED_AFTER_MS, unverifiedRevenue } from '../../src/shared/buyerSeen';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { askSideOf, holdingRefsOf, holdingRow, scraptfAlternative, type AskCandidate, type HoldingBuySide } from '../../src/shared/holdings';
import type { JournalPosition, OrderSummary, ScraptfListRow } from '../../src/shared/types';
import { unverifiedRevenue as serviceUnverifiedRevenue } from '../../src/service/domain/holdings';
import { UNVERIFIED_AFTER_MS } from '../../src/service/domain/matcher';
import { MOCK_UNVERIFIED_AFTER_MS } from '../../src/renderer/mockData';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY = 567;
const P = DEFAULT_SETTINGS.profit;
const NONE: ReadonlySet<string> = new Set();

function ask(over: Partial<AskCandidate> = {}): AskCandidate {
  return { id: 'a1', steamid: 'S1', keys: 0, metalScrap: 100, valueScrap: 100, isBot: false, lastEventAt: NOW - MIN, excluded: false, ...over };
}

describe('askSideOf (H3)', () => {
  it('is null without a counted ask', () => {
    expect(askSideOf([], NOW, NONE)).toBeNull();
    expect(askSideOf([ask({ excluded: true }), ask({ id: 'z', valueScrap: 0 })], NOW, NONE)).toBeNull();
  });

  it("keeps each seller's lowest, lowest first, and counts sellers and bots", () => {
    const side = askSideOf(
      [
        ask({ id: 'a', steamid: 'S1', valueScrap: 120, metalScrap: 120 }),
        ask({ id: 'b', steamid: 'S1', valueScrap: 105, metalScrap: 105 }),
        ask({ id: 'c', steamid: 'S2', valueScrap: 110, metalScrap: 110, isBot: true }),
        ask({ id: 'd', steamid: 'S3', keys: 1, metalScrap: 9, valueScrap: KEY + 9, isBot: true }),
      ],
      NOW,
      NONE,
    );
    expect(side).toEqual({
      lowestScrap: 105,
      lowestKeys: 0,
      lowestMetalScrap: 105,
      lowestIsBot: false,
      lowestSeenAt: NOW - MIN,
      count: 3,
      botCount: 2,
      ownLeftOut: 0,
      mayIncludeOwn: true,
    });
  });

  it('breaks a tie by the most recently seen, then the id; a seller without a steamid counts by listing id', () => {
    const tie = askSideOf([ask({ id: 'b', steamid: 'S1', lastEventAt: NOW - 2 * MIN }), ask({ id: 'c', steamid: 'S2', lastEventAt: NOW - MIN, isBot: true })], NOW, NONE);
    expect(tie).toMatchObject({ lowestScrap: 100, lowestIsBot: true, lowestSeenAt: NOW - MIN });
    const byId = askSideOf([ask({ id: 'y', steamid: 'S1' }), ask({ id: 'x', steamid: 'S2', isBot: true })], NOW, NONE);
    expect(byId?.lowestIsBot).toBe(true);
    const anonymous = askSideOf([ask({ id: 'p', steamid: '' }), ask({ id: 'q', steamid: '' })], NOW, NONE);
    expect(anonymous?.count).toBe(2);
  });

  it('counts only asks seen within 24 h: a stamp ahead of now is recent, NaN never', () => {
    expect(askSideOf([ask({ lastEventAt: NOW - ORDER_UNVERIFIED_AFTER_MS })], NOW, NONE)?.count).toBe(1);
    expect(askSideOf([ask({ lastEventAt: NOW - ORDER_UNVERIFIED_AFTER_MS - 1 })], NOW, NONE)).toBeNull();
    expect(askSideOf([ask({ lastEventAt: NOW + HOUR })], NOW, NONE)?.lowestSeenAt).toBe(NOW + HOUR);
    expect(askSideOf([ask({ lastEventAt: Number.NaN })], NOW, NONE)).toBeNull();
  });

  it("leaves the user's own listings out (ownLeftOut) and says when none are known", () => {
    const own = new Set(['ME']);
    const side = askSideOf([ask({ id: 'mine', steamid: 'ME', valueScrap: 90, metalScrap: 90 }), ask({ id: 'theirs', steamid: 'S2' })], NOW, own);
    expect(side).toMatchObject({ lowestScrap: 100, count: 1, ownLeftOut: 1, mayIncludeOwn: false });
    expect(askSideOf([ask({ steamid: 'ME' })], NOW, own)).toBeNull();
    expect(askSideOf([ask({ steamid: 'ME', valueScrap: 90 })], NOW, NONE)).toMatchObject({ lowestScrap: 90, ownLeftOut: 0, mayIncludeOwn: true });
  });
});

describe('holdingRefsOf (H4)', () => {
  it('is null with nothing stored and nothing left out', () => {
    expect(holdingRefsOf({ pricedb: null, community: null }, [])).toBeNull();
  });

  it('copies the usable references and the reasons the stale ones were left out', () => {
    const refs = holdingRefsOf(
      { pricedb: { buyScrap: 90, sellScrap: 100, time: null, ageMs: 3 * 24 * HOUR }, community: { valueScrap: 95, valueHighScrap: null, lastUpdate: null } },
      [],
    );
    expect(refs).toEqual({ pricedbBuyScrap: 90, pricedbSellScrap: 100, pricedbAgeMs: 3 * 24 * HOUR, communityScrap: 95, communityHighScrap: null, ignored: [] });
    const reasons = ['PriceDB price is 400 days old, ignored'];
    const stale = holdingRefsOf({ pricedb: null, community: null }, reasons);
    expect(stale).toEqual({ pricedbBuyScrap: null, pricedbSellScrap: null, pricedbAgeMs: null, communityScrap: null, communityHighScrap: null, ignored: reasons });
    expect(stale!.ignored).not.toBe(reasons);
  });
});

describe('scraptfAlternative (moved to src/shared/holdings.ts)', () => {
  const order = (over: Partial<OrderSummary> = {}): OrderSummary => ({
    listingId: 'l1',
    steamid: 'S1',
    userName: 'Bot',
    keys: 0,
    metalScrap: 140,
    valueScrap: 140,
    isBot: true,
    online: null,
    lastEventAt: NOW - 30 * HOUR,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  });
  const side = (o: OrderSummary): HoldingBuySide => ({
    revenueScrap: o.valueScrap,
    bestScrap: o.valueScrap,
    instantScrap: o.valueScrap,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 1,
    confidence: 40,
    confidenceLevel: 'low',
    flags: [],
    lastOrderChangeAt: o.lastEventAt,
  });
  const pos: JournalPosition = { sku: '378;6', name: 'Team Captain', qty: 1, costScrap: 100, lots: [{ id: 1, ts: NOW - 48 * HOUR, costScrap: 100, keys: 0, scrap: 100, keyPriceScrap: KEY }] };
  const list = (over: Partial<ScraptfListRow> = {}): ScraptfListRow => ({
    sku: '378;6',
    name: 'Team Captain',
    sellsKeys: 0,
    sellsScrapRaw: 130,
    sellsScrap: 130,
    paysKeys: 0,
    paysScrapRaw: 115,
    paysScrap: 115,
    stock: 1,
    stockLimit: 5,
    full: false,
    observedAt: NOW - HOUR,
    ...over,
  });

  it("tells a held-back backpack.tf exit through scrap.tf's fresh, not-full, profitable price; friction only", () => {
    const r = holdingRow(pos, 'hats', side(order()), P, KEY, { list: list(), now: NOW });
    expect(r.bestExit).toBe('backpack');
    const alt = scraptfAlternative(r, { ...P, exitReservePct: 0.3 }, NOW);
    expect(alt).toMatchObject({ bestExit: 'scraptf', exitScrap: 115, exitVenue: 'scrap.tf', profitNowScrap: 15, status: 'sell' });
    expect(scraptfAlternative(holdingRow(pos, 'hats', side(order()), P, KEY, { list: list({ full: true }), now: NOW }), P, NOW)).toBeNull();
    expect(scraptfAlternative(holdingRow(pos, 'hats', side(order()), P, KEY, { list: list({ observedAt: NOW - 25 * HOUR }), now: NOW }), P, NOW)).toBeNull();
    expect(scraptfAlternative(holdingRow(pos, 'hats', side(order()), P, KEY, { list: list({ paysScrap: 104, paysScrapRaw: 104 }), now: NOW }), P, NOW)).toBeNull();
  });
});

describe('unverifiedRevenue (moved to src/shared/buyerSeen.ts)', () => {
  const o = (flags: string[], lastEventAt: number) => ({ flags, lastEventAt });

  it('reads an order flagged or unseen for 24 h; a stamp ahead counts as recent; the service re-exports it', () => {
    expect(unverifiedRevenue(null, NOW)).toBe(false);
    expect(unverifiedRevenue(o(['unverified'], NOW), NOW)).toBe(true);
    expect(unverifiedRevenue(o([], NOW - ORDER_UNVERIFIED_AFTER_MS), NOW)).toBe(false);
    expect(unverifiedRevenue(o([], NOW - ORDER_UNVERIFIED_AFTER_MS - 1), NOW)).toBe(true);
    expect(unverifiedRevenue(o([], NOW + HOUR), NOW)).toBe(false);
    expect(unverifiedRevenue(o([], Number.NaN), NOW)).toBe(true);
    expect(serviceUnverifiedRevenue).toBe(unverifiedRevenue);
  });

  it('is the one 24 h for the service, the mock and the shared rules', () => {
    expect(ORDER_UNVERIFIED_AFTER_MS).toBe(24 * HOUR);
    expect(UNVERIFIED_AFTER_MS).toBe(ORDER_UNVERIFIED_AFTER_MS);
    expect(MOCK_UNVERIFIED_AFTER_MS).toBe(ORDER_UNVERIFIED_AFTER_MS);
  });
});
