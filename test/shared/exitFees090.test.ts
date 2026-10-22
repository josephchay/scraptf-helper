// 0.9 (#2): the documented exit fee rules in integer cents (the Steam Market and mannco.store), the marketplace.tf
// fee setting's rule, priceoverview's dollar text and the journal hints built from them (src/shared/venues.ts).
// Pure arithmetic and text: nothing here reads a venue or sends a request.

import { describe, expect, it } from 'vitest';
import {
  FEE_MAX_CENTS,
  MARKETPLACE_FEE_DEFAULT,
  MARKETPLACE_FEE_MAX,
  SCM_FEE_RULE,
  manncoNetCents,
  marketplaceFeeOf,
  parseUsdCents,
  scmBuyerPaysCents,
  scmSellerNetCents,
  usdText,
  venueFeeHint,
} from '../../src/shared/venues';

describe('scmBuyerPaysCents (5% Steam + 10% TF2 on what the seller gets, each floored and at least 1 cent)', () => {
  it('gives the documented pairs', () => {
    expect(scmBuyerPaysCents(100)).toBe(115);
    expect(scmBuyerPaysCents(193)).toBe(221);
    expect(scmBuyerPaysCents(1)).toBe(3);
    expect(SCM_FEE_RULE).toEqual({ steamBps: 500, gameBps: 1000, minFeeCents: 1 });
    expect(Object.isFrozen(SCM_FEE_RULE)).toBe(true);
  });

  it('refuses a non-integer or an amount outside 1..FEE_MAX_CENTS', () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, FEE_MAX_CENTS + 1]) expect(scmBuyerPaysCents(v), String(v)).toBeNull();
    expect(scmBuyerPaysCents(FEE_MAX_CENTS)).toBe(FEE_MAX_CENTS + FEE_MAX_CENTS / 20 + FEE_MAX_CENTS / 10);
  });

  it('takes a custom rule: a 2-cent minimum makes one cent cost 5', () => {
    expect(scmBuyerPaysCents(1, { ...SCM_FEE_RULE, minFeeCents: 2 })).toBe(5);
    expect(scmSellerNetCents(5, { ...SCM_FEE_RULE, minFeeCents: 2 })).toBe(1);
    expect(scmSellerNetCents(4, { ...SCM_FEE_RULE, minFeeCents: 2 })).toBeNull();
  });
});

describe('scmSellerNetCents (the inverse: the most the seller gets for what the buyer pays)', () => {
  it('gives the documented pairs, and null under 3 cents', () => {
    const pairs: [number, number][] = [
      [115, 100],
      [221, 193],
      [3, 1],
      [116, 101],
      [114, 99],
      [112, 99],
      [7, 5],
      [226, 198],
      [50, 44],
    ];
    for (const [paid, net] of pairs) expect(scmSellerNetCents(paid), String(paid)).toBe(net);
    expect(scmSellerNetCents(2)).toBeNull();
    expect(scmSellerNetCents(0)).toBeNull();
    expect(scmSellerNetCents(1.5)).toBeNull();
    expect(scmSellerNetCents(FEE_MAX_CENTS + 1)).toBeNull();
  });

  it('is the largest net whose price fits, over 3..200,000, and the forward rule strictly increases', () => {
    let prev = 0;
    for (let r = 1; r <= 200_000; r++) {
      const f = scmBuyerPaysCents(r)!;
      if (!(f > prev)) expect({ r, f, prev }).toBe('strictly increasing');
      prev = f;
    }
    for (let p = 3; p <= 200_000; p++) {
      const net = scmSellerNetCents(p)!;
      const ok = scmBuyerPaysCents(net)! <= p && p < scmBuyerPaysCents(net + 1)!;
      if (!ok) expect({ p, net }).toBe('a net whose price fits');
    }
  });
});

describe('manncoNetCents (5% of the sale price, in the seller\'s favour, at least 1 cent except on a 1-cent sale)', () => {
  it('gives the documented pairs', () => {
    const pairs: [number, number][] = [
      [1, 1],
      [2, 1],
      [10, 9],
      [19, 18],
      [20, 19],
      [21, 20],
      [39, 38],
      [40, 38],
      [100, 95],
      [101, 96],
    ];
    for (const [price, net] of pairs) expect(manncoNetCents(price), String(price)).toBe(net);
    for (const v of [0, -5, 2.5, Number.NaN, FEE_MAX_CENTS + 1]) expect(manncoNetCents(v), String(v)).toBeNull();
  });

  it('equals ceil(0.95 x price) from 20 cents and never decreases', () => {
    let prev = 0;
    for (let p = 1; p <= 100_000; p++) {
      const net = manncoNetCents(p)!;
      if (net < prev) expect({ p, net, prev }).toBe('never decreasing');
      if (p >= 20 && net !== Math.ceil((95 * p) / 100)) expect({ p, net }).toBe('ceil(0.95p)');
      prev = net;
    }
  });
});

describe('marketplaceFeeOf (profit.marketplaceFeePct as applied)', () => {
  it('keeps a finite fee in [0, 0.5] and falls back to 10% otherwise', () => {
    expect(MARKETPLACE_FEE_DEFAULT).toBe(0.1);
    expect(MARKETPLACE_FEE_MAX).toBe(0.5);
    for (const v of [0, 0.15, 0.5]) expect(marketplaceFeeOf(v)).toBe(v);
    for (const v of [-0.1, 0.6, Number.NaN, undefined, '0.1', null]) expect(marketplaceFeeOf(v), String(v)).toBe(0.1);
  });
});

describe("parseUsdCents and usdText (priceoverview's dollar text)", () => {
  it('reads Steam\'s text and the mock\'s bare number', () => {
    expect(parseUsdCents('$2.21')).toBe(221);
    expect(parseUsdCents('$1,234.56')).toBe(123456);
    expect(parseUsdCents('2.21')).toBe(221);
    expect(parseUsdCents(' $0.03 ')).toBe(3);
    expect(parseUsdCents('$5')).toBe(500);
    expect(parseUsdCents('$1.5')).toBe(150);
    expect(parseUsdCents('$2.21 USD')).toBe(221);
  });

  it('refuses another currency, more decimals, a negative, an empty text and a non-string', () => {
    for (const v of ['€2,21', '2.211', '', '-$1', '$-1', '1,23.45', '$10,000.01']) expect(parseUsdCents(v), v).toBeNull();
    for (const v of [null, undefined, 221]) expect(parseUsdCents(v)).toBeNull();
  });

  it('writes cents as dollars', () => {
    expect(usdText(115)).toBe('$1.15');
    expect(usdText(3)).toBe('$0.03');
    expect(usdText(123456)).toBe('$1234.56');
  });
});

describe('the fee hints, built from the rules', () => {
  it('words the Steam Market, mannco.store and the default marketplace.tf fee exactly', () => {
    expect(venueFeeHint('Steam Community Market', 'sell')).toBe(
      'The Steam Market keeps 5% (Steam) and 10% (TF2) of what you get, each rounded down to the cent and at least $0.01, in Steam Wallet funds, not cash: the buyer pays $1.15 for $1.00 to you, $2.21 for $1.93 and $0.03 for $0.01. Enter that cut in keys or metal, at the value you log the sale at.',
    );
    expect(venueFeeHint('mannco.store', 'sell')).toBe(
      'mannco.store keeps 5% of the sale price, rounded in your favour and at least $0.01 (none on a $0.01 sale): a $1.00 sale pays you $0.95, a $0.10 sale $0.09. Enter that cut in keys or metal, at the value you log the sale at.',
    );
    expect(venueFeeHint('marketplace.tf', 'sell')).toBe(
      'marketplace.tf keeps about 10% of the sale price (your setting under Settings > Profit thresholds; about 10% rests on a 2019 forum report). Enter that cut in keys or metal, at the value you log the sale at.',
    );
  });

  it("follows the user's marketplace.tf fee, and gives a buy no hint at either cash venue", () => {
    expect(venueFeeHint('mptf', 'sell', 0.15)).toContain('about 15% of the sale price');
    expect(venueFeeHint('mptf', 'sell', 0.125)).toContain('about 12.5% of the sale price');
    expect(venueFeeHint('mptf', 'sell', 0)).toContain('about 0% of the sale price');
    // An out-of-range setting is the default.
    expect(venueFeeHint('mptf', 'sell', 0.9)).toContain('about 10% of the sale price');
    expect(venueFeeHint('mannco', 'buy')).toBeNull();
    expect(venueFeeHint('mptf', 'buy', 0.15)).toBeNull();
    expect(venueFeeHint('mptf', 'writeoff', 0.15)).toBeNull();
  });
});
