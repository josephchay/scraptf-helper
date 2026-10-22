// 0.9 (#9): bankStockNoticeWithGuard, the S3 notifier's toast text: bankStockNoticeOf's, with the checkout guard's short
// sentence on a toast that suggests buying (a watch hit or a G4 "Buy now" that tells a flip) when it still fits 200
// characters. Every other toast is word for word bankStockNoticeOf's, and no title changes. Pure; nothing is fetched.

import { describe, expect, it } from 'vitest';
import { bankStockNoticeOf, bankStockNoticeWithGuard, type BankStockNotifyCandidate } from '../../src/shared/bankStockNotify';
import { CHECKOUT_GUARD_TOAST, CHECKOUT_GUARD_TOAST_BODY_MAX, withCheckoutGuard } from '../../src/shared/checkoutGuard';
import type { BankStockRow, OrderSummary, ScraptfWatch } from '../../src/shared/types';

const K = 600;
const T = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY = 86_400_000;

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'BuyBot',
    keys: 0,
    metalScrap: 60,
    valueScrap: 60,
    isBot: true,
    online: true,
    lastEventAt: T,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

/** A flip: 4.00 ref, sells for 6.66 ref, +2.22 ref, Pay up to 5.00 ref. */
function row(over: Partial<BankStockRow> = {}): BankStockRow {
  return {
    sku: '378;6',
    key: '378;6|',
    name: 'Team Captain',
    category: 'hats',
    hasExtras: false,
    costKeys: 0,
    costScrapRaw: 36,
    costScrap: 36,
    stock: 1,
    change: 'new',
    previousCostScrap: null,
    previousStock: null,
    revenueScrap: 60,
    revenueOrder: order(),
    buyerCount: 3,
    maxCostScrap: 45,
    profitScrap: 20,
    margin: 20 / 36,
    verdict: 'flip',
    confidence: 70,
    confidenceLevel: 'high',
    listedSince: null,
    firstSeenAt: null,
    changeSinceListed: null,
    ...over,
  };
}

function watch(over: Partial<ScraptfWatch> = {}): ScraptfWatch {
  return {
    id: 1,
    sku: '378;6',
    specialKey: '',
    name: 'Team Captain',
    maxCostKeys: 0,
    maxCostScrap: 40,
    minProfitScrap: null,
    onRestock: false,
    enabled: true,
    createdAt: T - DAY,
    updatedAt: T - DAY,
    ...over,
  };
}

/** A watch price hit of a flip that tells it (the confirmed case). */
function hit(over: Partial<BankStockNotifyCandidate> = {}): BankStockNotifyCandidate {
  return { kind: 'watch', row: row(), restock: false, watch: watch(), hit: 'price', flip: true, doubt: null, tellsFlip: true, dedupeKey: 'w|1', chip: 'watched', ...over };
}

function plain(kind: BankStockNotifyCandidate['kind'], over: Partial<BankStockNotifyCandidate> = {}): BankStockNotifyCandidate {
  return {
    kind,
    row: row(kind === 'cheaper' ? { change: 'cheaper', previousCostScrap: 50 } : {}),
    restock: kind === 'back',
    watch: null,
    hit: null,
    flip: true,
    doubt: null,
    tellsFlip: true,
    dedupeKey: `hats|378;6|${kind}`,
    chip: kind === 'cheaper' || kind === 'timing' ? 'flips' : 'new',
    ...over,
  };
}

describe('0.9 (#9): bankStockNoticeWithGuard', () => {
  it('appends the guard to a watch hit that tells a flip, price or profit target', () => {
    for (const c of [hit(), hit({ hit: 'profit' })]) {
      const n = bankStockNoticeOf(c, 'Hats', K, null);
      const g = bankStockNoticeWithGuard(c, 'Hats', K, null);
      expect(g).toEqual({ ...n, body: withCheckoutGuard(n.body) });
      expect(g.body.endsWith(CHECKOUT_GUARD_TOAST)).toBe(true);
      expect(g.body.length).toBeLessThanOrEqual(CHECKOUT_GUARD_TOAST_BODY_MAX);
      // The title never changes.
      expect(g.title).toBe(n.title);
    }
  });

  it('appends the guard to a G4 "Buy now" (kind timing) that tells a flip', () => {
    const c = plain('timing');
    const n = bankStockNoticeOf(c, 'Hats', K, null, true);
    const g = bankStockNoticeWithGuard(c, 'Hats', K, null, true);
    expect(n.title).toBe('Buy now (Hats): Team Captain');
    expect(g).toEqual({ ...n, body: withCheckoutGuard(n.body) });
    expect(g.body).toBe(`${n.body}. ${CHECKOUT_GUARD_TOAST}`);
  });

  it('leaves an unconfirmed order (tellsFlip false), a doubt, and the new, back and cheaper toasts word for word', () => {
    const cases: BankStockNotifyCandidate[] = [
      hit({ tellsFlip: false }),
      hit({ doubt: 'suspect', tellsFlip: false }),
      // Even a candidate marked as telling a flip keeps its body while it carries a doubt.
      hit({ doubt: 'low-confidence' }),
      plain('timing', { tellsFlip: false }),
      plain('new'),
      plain('back'),
      plain('cheaper'),
      // A watched copy that is no flip ('new' with its watch) is not a hit.
      plain('new', { flip: false, watch: watch(), tellsFlip: false }),
    ];
    for (const c of cases) {
      for (const timing of [false, true]) {
        const n = bankStockNoticeOf(c, 'Hats', K, null, timing);
        expect(bankStockNoticeWithGuard(c, 'Hats', K, null, timing), `${c.kind} ${String(c.doubt)} ${c.tellsFlip}`).toEqual(n);
      }
    }
  });

  it('keeps a body that would pass 200 characters as it was', () => {
    // A long name lengthens the title only; a long buyer name lengthens the body.
    const c = hit({ row: row({ revenueOrder: order({ userName: 'B'.repeat(150) }) }) });
    const n = bankStockNoticeOf(c, 'Hats', K, 3 * 3_600_000);
    expect(n.body.length + 2 + CHECKOUT_GUARD_TOAST.length).toBeGreaterThan(CHECKOUT_GUARD_TOAST_BODY_MAX);
    expect(bankStockNoticeWithGuard(c, 'Hats', K, 3 * 3_600_000)).toEqual(n);
  });
});
