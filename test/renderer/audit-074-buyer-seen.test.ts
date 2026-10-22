// 0.7.4 trading accuracy audit (package PB), the renderer side:
// - F23/F63: a buyer's online flag is as old as the order's last event; past ORDER_CONFIRMED_MS (2 h) the
//   dot shows unknown and the lines say "last seen N ago" (src/shared/buyerSeen.ts); an unverified revenue
//   order is marked with a warn clock in the Opportunities row and the drawer headline.
// - F22/F70: the two new flags have written labels and help.
// - Mock parity: the browser mock prices and notifies by the same rules as the service.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnlineDot, UnverifiedOrderMark } from '../../src/renderer/components/Pills';
import { flagInfo } from '../../src/renderer/format';
import { createRng, evaluateOpportunity, makeBook, mockPrices, type MockBook } from '../../src/renderer/mockData';
import { ORDER_CONFIRMED_MS, buyerOnlineNow, buyerPresenceText, orderSeenRecently, seenAgeText } from '../../src/shared/buyerSeen';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { OrderSummary } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 3_600_000;

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'BuyBot',
    keys: 0,
    metalScrap: 120,
    valueScrap: 120,
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

describe('buyer liveness (shared)', () => {
  it('counts an order as recent for 2 h after its last event', () => {
    expect(ORDER_CONFIRMED_MS).toBe(2 * HOUR);
    expect(orderSeenRecently(NOW - 2 * HOUR, NOW)).toBe(true);
    expect(orderSeenRecently(NOW - 2 * HOUR - 1, NOW)).toBe(false);
    expect(orderSeenRecently(Number.NaN, NOW)).toBe(false);
    expect(buyerOnlineNow(order(), NOW)).toBe(true);
    expect(buyerOnlineNow(order({ lastEventAt: NOW - 5 * 24 * HOUR }), NOW)).toBeNull();
  });

  it('says online, offline or unknown while recent, else when the buyer was last seen', () => {
    expect(buyerPresenceText(order(), NOW)).toBe('online');
    expect(buyerPresenceText(order({ online: false }), NOW)).toBe('offline');
    expect(buyerPresenceText(order({ online: null }), NOW)).toBe('online status unknown');
    expect(buyerPresenceText(order({ lastEventAt: NOW - 116 * HOUR }), NOW)).toBe('last seen 4 d ago');
    expect(buyerPresenceText(order({ lastEventAt: NOW - 3 * HOUR - 1 }), NOW)).toBe('last seen 3 h ago');
    expect(buyerPresenceText(order({ lastEventAt: Number.NaN }), NOW)).toBe('online status unknown');
    expect(seenAgeText(90_000)).toBe('1 min');
  });
});

describe('OnlineDot and UnverifiedOrderMark (F23, F63)', () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

  it('shows a stale online flag as unknown, titled with what it was and when', () => {
    expect(html(createElement(OnlineDot, { online: true }))).toContain('online-dot on');
    expect(html(createElement(OnlineDot, { online: true, seenAt: NOW - 60_000, now: NOW }))).toContain('online-dot on');
    const stale = html(createElement(OnlineDot, { online: true, seenAt: NOW - 5 * 24 * HOUR, now: NOW }));
    expect(stale).toContain('online-dot unknown');
    expect(stale).toContain('title="Online when last seen, 5 d ago; not confirmed since"');
  });

  it('marks only an unverified order, with its age in the title (and in words with label)', () => {
    expect(html(createElement(UnverifiedOrderMark, { order: order(), now: NOW }))).toBe('');
    expect(html(createElement(UnverifiedOrderMark, { order: null, now: NOW }))).toBe('');
    const stale = order({ flags: ['unverified'], lastEventAt: NOW - 116 * HOUR });
    const icon = html(createElement(UnverifiedOrderMark, { order: stale, now: NOW }));
    expect(icon).toContain('tone-text-warn');
    expect(icon).toContain('title="Revenue order last seen 4 d ago: it may have been filled or removed');
    expect(html(createElement(UnverifiedOrderMark, { order: stale, now: NOW, label: true }))).toContain('order last seen 4 d ago, may be gone');
  });
});

describe('flag labels (F22, F70)', () => {
  it('explains the cost checks and says they are never notified', () => {
    for (const f of ['variant-suspect', 'cost-below-market']) {
      const info = flagInfo(f);
      expect(info.tone).toBe('bad');
      expect(info.help).not.toBe(info.label);
      expect(info.help).toMatch(/never notified/i);
    }
    expect(flagInfo('unverified-orders').help).toMatch(/over 24 h/);
  });
});

describe('mock parity', () => {
  const book = (buy: OrderSummary[], pdb: { buyScrap: number | null; sellScrap: number | null } | null = null): MockBook => ({
    ...makeBook(createRng(7), { sku: '378;6', name: 'Team Captain', category: 'hats', value: 100 }, NOW),
    buy,
    references: { pricedb: pdb ? { ...pdb, time: null, ageMs: 0 } : null, community: null },
  });

  it('prices Conservative and Instant from verified orders, and keeps zero-valued orders out of the median', () => {
    const b = book([
      order({ listingId: 'stale', valueScrap: 140, metalScrap: 140, flags: ['unverified'], lastEventAt: NOW - 30 * HOUR }),
      order({ listingId: 'fresh', valueScrap: 108, metalScrap: 108, isBot: false }),
      order({ listingId: 'bot', valueScrap: 100, metalScrap: 100 }),
    ]);
    const p = mockPrices(b, DEFAULT_SETTINGS, 567, NOW);
    expect(p.best?.listingId).toBe('stale');
    expect(p.cons?.listingId).toBe('fresh');
    expect(p.instant?.listingId).toBe('bot');
    const zeros = mockPrices(book([order({ valueScrap: 1, metalScrap: 1 }), ...[2, 3, 4].map((i) => order({ listingId: `z${i}`, steamid: `z${i}`, valueScrap: 0, metalScrap: 0 }))]), DEFAULT_SETTINGS, 567, NOW);
    expect(zeros.cons?.valueScrap).toBe(1);
  });

  it('flags a cost far under the PriceDB buy price and caps it at Low, as the service', () => {
    const b = book([order({ valueScrap: 140, metalScrap: 140 })], { buyScrap: 130, sellScrap: 150 });
    const input = { kind: 'import' as const, ref: 'price:1', costKeys: 0, costScrapRaw: 100, observedAt: NOW, special: null };
    const o = evaluateOpportunity(b, input, DEFAULT_SETTINGS, 567, NOW, null);
    expect(o.flags).toContain('cost-below-market');
    expect(o.confidence).toBeLessThanOrEqual(44);
    // With a twin priced like the cost it is the more specific variant-suspect.
    const twin = book([], { buyScrap: 95, sellScrap: 105 });
    expect(evaluateOpportunity(b, input, DEFAULT_SETTINGS, 567, NOW, null, twin).flags).toContain('variant-suspect');
    // A rule estimate is never checked.
    expect(evaluateOpportunity(b, { ...input, kind: 'rule' as const }, DEFAULT_SETTINGS, 567, NOW, null).flags).not.toContain('cost-below-market');
  });
});
