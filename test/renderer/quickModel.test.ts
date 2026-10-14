import { describe, expect, it } from 'vitest';
import { maxCostFor, profitStatus } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { ItemRevenue, LinkSpec, OrderSummary } from '../../src/shared/types';
import {
  buyerCountLabel,
  ceilingVerdict,
  compactLinks,
  createLatestGate,
  isCheckKey,
  isChecked,
  previewRevenue,
  previewTone,
  profitPreview,
  revenueBreakdown,
  type PreviewSettings,
} from '../../src/renderer/quickModel';

const P: PreviewSettings = { ...DEFAULT_SETTINGS.profit };

function order(id: string, valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: id,
    steamid: '76561198000000000',
    userName: `buyer ${id}`,
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: false,
    online: true,
    lastEventAt: 0,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function revenue(over: Partial<ItemRevenue> = {}): ItemRevenue {
  return { bestScrap: 100, consScrap: 100, instantScrap: null, useOrder: 'conservative', revenueScrap: 100, order: null, maxCostScrap: maxCostFor(100, P), eligibleCount: 1, ...over };
}

describe('createLatestGate', () => {
  it('lets only the newest request land', () => {
    const g = createLatestGate();
    const a = g.next();
    const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });

  it('cancel makes every outstanding request stale', () => {
    const g = createLatestGate();
    const a = g.next();
    g.cancel();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(g.next())).toBe(true);
  });

  it('drops a slow answer for an earlier pick (out-of-order resolution)', async () => {
    const g = createLatestGate();
    const shown: string[] = [];
    const load = async (sku: string, ms: number) => {
      const t = g.next();
      await new Promise((r) => setTimeout(r, ms));
      if (g.isCurrent(t)) shown.push(sku);
    };
    await Promise.all([load('slow;6', 30), load('fast;6', 1)]);
    expect(shown).toEqual(['fast;6']);
  });
});

describe('previewRevenue', () => {
  it("uses the service's revenue when it sent one", () => {
    const rev = revenue({ revenueScrap: 77, maxCostScrap: 60 });
    expect(previewRevenue({ revenue: rev, buyOrders: [order('a', 500)] }, P)).toBe(rev);
  });

  it('otherwise picks from the classified book like the engine: best, conservative, instant', () => {
    const book = [
      order('outlier', 300, { flags: ['outlier'], isBot: true }),
      order('human', 200),
      order('bot', 150, { isBot: true }),
      order('banned', 400, { eligible: false, flags: ['banned'] }),
    ];
    const cons = previewRevenue({ revenue: null, buyOrders: book }, P);
    expect(cons).toMatchObject({ bestScrap: 300, consScrap: 200, instantScrap: 150, revenueScrap: 200, eligibleCount: 3, useOrder: 'conservative' });
    expect(cons.order?.listingId).toBe('human');
    expect(cons.maxCostScrap).toBe(maxCostFor(200, P));

    expect(previewRevenue({ revenue: null, buyOrders: book }, { ...P, useOrder: 'best' }).order?.listingId).toBe('outlier');
    expect(previewRevenue({ revenue: null, buyOrders: book }, { ...P, useOrder: 'instant' }).order?.listingId).toBe('bot');
  });

  it('has no revenue and no ceiling without eligible orders', () => {
    const r = previewRevenue({ revenue: null, buyOrders: [order('x', 90, { eligible: false })] }, P);
    expect(r).toMatchObject({ revenueScrap: null, order: null, maxCostScrap: null, eligibleCount: 0 });
  });
});

describe('profitPreview', () => {
  it('computes profit and margin like the engine (friction included)', () => {
    const p = { ...P, frictionScrap: 2 };
    const pv = profitPreview(50, revenue({ revenueScrap: 100, maxCostScrap: maxCostFor(100, p) }), p);
    expect(pv.profitScrap).toBe(48);
    expect(pv.margin).toBeCloseTo(48 / 50);
    expect(pv.status).toBe(profitStatus(48, 50, p));
  });

  it('is under the ceiling exactly when the price is at most Pay up to', () => {
    const ceiling = maxCostFor(100, P)!;
    const rev = revenue({ revenueScrap: 100, maxCostScrap: ceiling });
    const at = profitPreview(ceiling, rev, P);
    const over = profitPreview(ceiling + 1, rev, P);
    expect(at).toMatchObject({ underCeiling: true, headroomScrap: 0, status: 'profitable' });
    expect(over).toMatchObject({ underCeiling: false, headroomScrap: -1 });
    expect(over.status).not.toBe('profitable');
    expect(previewTone(at)).toBe('good');
  });

  it('agrees with the status for every cost (ceiling and thresholds from the same rules)', () => {
    for (const rev of [0, 5, 18, 99, 450, 2_000]) {
      const r = revenue({ revenueScrap: rev, maxCostScrap: maxCostFor(rev, P) });
      for (let cost = 0; cost <= rev + 3; cost += Math.max(1, Math.floor(rev / 40))) {
        const pv = profitPreview(cost, r, P);
        expect(pv.underCeiling).toBe(pv.status === 'profitable');
      }
    }
  });

  it('a free item has no margin, as the engine stores it', () => {
    expect(profitPreview(0, revenue(), P).margin).toBeNull();
  });

  it('has no profit and no verdict without a buyer', () => {
    const pv = profitPreview(40, null, P);
    expect(pv).toMatchObject({ profitScrap: null, margin: null, status: 'no-buyers', underCeiling: null, headroomScrap: null });
    expect(previewTone(pv)).toBe('muted');
    expect(ceilingVerdict(pv, null)).toBe('No buyer');
  });

  it('is never under the ceiling when no price clears the thresholds', () => {
    const pv = profitPreview(1, revenue({ revenueScrap: 5, maxCostScrap: null }), P);
    expect(pv.underCeiling).toBe(false);
    expect(ceilingVerdict(pv, null)).toBe('No price clears your thresholds');
  });
});

describe('previewTone and ceilingVerdict', () => {
  it('only green under the ceiling; red when it loses money; amber otherwise', () => {
    expect(previewTone({ status: 'profitable', underCeiling: true })).toBe('good');
    expect(previewTone({ status: 'below-threshold', underCeiling: false })).toBe('warn');
    expect(previewTone({ status: 'unprofitable', underCeiling: false })).toBe('bad');
    expect(previewTone({ status: 'no-buyers', underCeiling: null })).toBe('muted');
  });

  it('says how far under or over the ceiling the price is', () => {
    expect(ceilingVerdict({ underCeiling: true, headroomScrap: 2 }, 500)).toBe('0.22 ref under');
    expect(ceilingVerdict({ underCeiling: false, headroomScrap: -9 }, 500)).toBe('1.00 ref over');
    expect(ceilingVerdict({ underCeiling: true, headroomScrap: 0 }, 500)).toBe('At the ceiling');
  });

  it('buyer count reads naturally', () => {
    expect(buyerCountLabel(0)).toBe('0 buyers');
    expect(buyerCountLabel(1)).toBe('1 buyer');
    expect(buyerCountLabel(7)).toBe('7 buyers');
  });

  it('revenue hover lists all three picks, with a dash for a missing one', () => {
    expect(revenueBreakdown({ bestScrap: 27, consScrap: 18, instantScrap: null }, 500)).toBe('Best 3.00 ref · conservative 2.00 ref · instant —');
  });
});

describe('compactLinks', () => {
  const link = (id: string, group: LinkSpec['group'] = 'backpack'): LinkSpec => ({ id, label: `${id} label`, url: `https://backpack.tf/${id}`, group });

  it('keeps the everyday links in a fixed order with short labels', () => {
    const all = [link('pricedb', 'tools'), link('mptf', 'market'), link('bptf-premium'), link('bptf-classifieds'), link('bptf-classifieds-accurate'), link('bptf-stats'), link('scraptf-page', 'market')];
    const out = compactLinks(all);
    expect(out.map((l) => l.short)).toEqual(['Stats', 'Classifieds', 'scrap.tf page', 'mp.tf', 'PriceDB']);
    // The accurate search wins over the basic one when both exist.
    expect(out[1]?.link.id).toBe('bptf-classifieds-accurate');
  });

  it('falls back to the basic classifieds search and honours the cap', () => {
    const out = compactLinks([link('bptf-classifieds'), link('bptf-stats'), link('stn', 'market'), link('scm', 'market')], 3);
    expect(out.map((l) => l.link.id)).toEqual(['bptf-stats', 'bptf-classifieds', 'stn']);
    expect(compactLinks([])).toEqual([]);
  });

  it('only passes through URLs the service built', () => {
    const l = link('bptf-stats');
    expect(compactLinks([l])[0]?.link).toBe(l);
  });
});

describe('isCheckKey', () => {
  const key = (over: Partial<Parameters<typeof isCheckKey>[0]> = {}) => ({ key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, ...over });

  it('is Shift+Enter only', () => {
    expect(isCheckKey(key())).toBe(true);
    expect(isCheckKey(key({ shiftKey: false }))).toBe(false);
    expect(isCheckKey(key({ ctrlKey: true }))).toBe(false);
    expect(isCheckKey(key({ altKey: true }))).toBe(false);
    expect(isCheckKey(key({ key: 'a' }))).toBe(false);
  });

  it('ignores Enter that ends an IME composition', () => {
    expect(isCheckKey(key({ isComposing: true }))).toBe(false);
  });
});

describe('isChecked', () => {
  const c = { sku: '378;6', text: '1.33', unit: 'ref' };

  it('holds while item, price text and unit are unchanged', () => {
    expect(isChecked(c, { sku: '378;6', text: '1.33', unit: 'ref' })).toBe(true);
    expect(isChecked(c, { sku: '378;6', text: '1.44', unit: 'ref' })).toBe(false);
    expect(isChecked(c, { sku: '378;6', text: '1.33', unit: 'scrap' })).toBe(false);
    expect(isChecked(c, { sku: '5021;6', text: '1.33', unit: 'ref' })).toBe(false);
    expect(isChecked(null, { sku: '378;6', text: '1.33', unit: 'ref' })).toBe(false);
  });
});
