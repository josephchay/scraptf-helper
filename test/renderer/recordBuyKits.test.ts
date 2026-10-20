// 0.7.2: Record buy's prefill for killstreak kits and killstreak weapons. A page look stores a kit once per
// sheen/killstreaker combo, every copy at the page's time, and every specialized or professional copy has a
// sheen. Before, a sheen counted as an extra (no copy was "this item": the dialog opened with no price while
// the Live market row showed one), and same-time copies went to the one stored last. Now the prefill takes
// the price the Live market row shows: the newest look, and of its copies the cheapest at the key price
// (equal costs the higher id), keys and metal as stored. Paint, spells, parts and custom names still make
// another copy whose price is never borrowed. The prefill only fills a dialog: nothing contacts scrap.tf.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RECORD_BUY_KEY_SCRAP, newestScrapPrice, priceIsForSku, recordBuyInit, recordTradeInit } from '../../src/renderer/itemMenuModel';
import { DEFAULT_KEY_SCRAP } from '../../src/service/domain/keyprice';
import { newestStoredPrice } from '../../src/service/domain/liveCheck';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { KeyPriceState, ScrapPrice, SpecialAttrs } from '../../src/shared/types';

const KIT = { sku: '6526;6;uncraftable;kt-3;td-205', name: 'Non-Craftable Professional Killstreak Rocket Launcher Kit' };
const PRO_WEAPON = { sku: '200;6;kt-3', name: 'Professional Killstreak Scattergun' };
const SPEC_WEAPON = { sku: '200;6;kt-2', name: 'Specialized Killstreak Scattergun' };
const HAT = { sku: '378;6', name: 'Team Captain' };
const PINK = 16738740;
const T = 1_760_000_000_000;
const PROFIT = { ...DEFAULT_SETTINGS.profit };

const NONE: SpecialAttrs = { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };

function special(over: Partial<SpecialAttrs>): SpecialAttrs {
  return { ...NONE, ...over };
}

function price(over: Partial<ScrapPrice>): ScrapPrice {
  return {
    id: 1,
    sku: KIT.sku,
    name: KIT.name,
    costKeys: 0,
    costScrap: 0,
    source: 'import',
    observedAt: T,
    note: null,
    importBatch: 7,
    special: special({ sheen: 1, killstreaker: 2002 }),
    assetId: null,
    stock: 1,
    ...over,
  };
}

function keyPrice(valueScrap: number): KeyPriceState {
  return { valueScrap, source: 'bptf', observedAt: T, stale: false, quotes: [], scraptfFromList: null };
}

const buyOf = (init: ReturnType<typeof recordBuyInit>) => ({ keys: init.keys, scrap: init.scrap });

describe('Record buy prefill for killstreak kits (0.7.2)', () => {
  it("prefills a kit's cheapest copy of one look, whichever was stored last and in any order", () => {
    // Two cards of one page look: Team Shine / Fire Horns at 37 keys, Hot Rod / Cerebral Discharge at 20 keys 1 ref.
    for (const [cheapId, dearId] of [
      [11, 10],
      [10, 11],
    ] as const) {
      const cheap = price({ id: cheapId, costKeys: 20, costScrap: 9, special: special({ sheen: 2, killstreaker: 2003 }) });
      const dear = price({ id: dearId, costKeys: 37, costScrap: 0, special: special({ sheen: 1, killstreaker: 2002 }) });
      for (const prices of [
        [cheap, dear],
        [dear, cheap],
      ]) {
        expect(newestScrapPrice(prices)?.id).toBe(cheapId);
        expect(recordBuyInit(KIT, prices)).toEqual({ side: 'buy', sku: KIT.sku, name: KIT.name, venue: 'scrap.tf', keys: 20, scrap: 9 });
      }
    }
  });

  it('values copies at the key price it is given, and prefills keys and metal as stored', () => {
    // 1 key against 600 scrap (66.66 ref): at 60 ref a key the key copy is cheaper, at 77.77 ref the metal one.
    const inKeys = price({ id: 1, costKeys: 1, costScrap: 0 });
    const inMetal = price({ id: 2, costKeys: 0, costScrap: 600, special: special({ sheen: 5, killstreaker: 2004 }) });
    expect(buyOf(recordBuyInit(KIT, [inKeys, inMetal], null, 540))).toEqual({ keys: 1, scrap: 0 });
    expect(buyOf(recordBuyInit(KIT, [inKeys, inMetal], null, 700))).toEqual({ keys: 0, scrap: 600 });
    // No usable key price: the service's default, 60 ref.
    expect(RECORD_BUY_KEY_SCRAP).toBe(DEFAULT_KEY_SCRAP);
    for (const k of [null, 0, -5, Number.NaN]) expect(buyOf(recordBuyInit(KIT, [inKeys, inMetal], null, k))).toEqual({ keys: 1, scrap: 0 });
    // Exactly 60 ref: 539 scrap undercuts a key there, 541 does not (a 0 or negative key price would make the key free).
    for (const k of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buyOf(recordBuyInit(KIT, [price({ id: 1, costScrap: 539 }), price({ id: 2, costKeys: 1 })], null, k))).toEqual({ keys: 0, scrap: 539 });
      expect(buyOf(recordBuyInit(KIT, [price({ id: 1, costScrap: 541 }), price({ id: 2, costKeys: 1 })], null, k))).toEqual({ keys: 1, scrap: 0 });
    }
    // Equal costs: the higher id, as the Live market row picks.
    const same = price({ id: 3, costKeys: 0, costScrap: 540, special: special({ sheen: 6, killstreaker: 2005 }) });
    expect(newestScrapPrice([same, inKeys], 540)?.id).toBe(3);
    expect(newestScrapPrice([inKeys, same], 540)?.id).toBe(3);
    // A cost that is not a number is never the cheapest, though valueScrap alone would read it as 0.
    const broken = price({ id: 4, costKeys: Number.NaN, costScrap: Number.NaN, special: special({ sheen: 7, killstreaker: 2006 }) });
    expect(newestScrapPrice([inKeys, broken], 540)?.id).toBe(1);
    expect(newestScrapPrice([broken, inKeys], 540)?.id).toBe(1);
  });

  it('the item menu values at the key price its item read carries', () => {
    const inKeys = price({ id: 1, costKeys: 1, costScrap: 0 });
    const inMetal = price({ id: 2, costKeys: 0, costScrap: 600, special: special({ sheen: 5, killstreaker: 2004 }) });
    const d = { name: KIT.name, scrapPrices: [inKeys, inMetal], revenue: null, buyOrders: [] };
    expect(recordTradeInit('buy', KIT, { ...d, keyPrice: keyPrice(700) }, PROFIT)).toMatchObject({ keys: 0, scrap: 600 });
    expect(recordTradeInit('buy', KIT, { ...d, keyPrice: keyPrice(540) }, PROFIT)).toMatchObject({ keys: 1, scrap: 0 });
    // No key price in the read (or an older service): the default.
    expect(recordTradeInit('buy', KIT, { ...d, keyPrice: null }, PROFIT)).toMatchObject({ keys: 1, scrap: 0 });
    expect(recordTradeInit('buy', KIT, d, PROFIT)).toMatchObject({ keys: 1, scrap: 0 });
  });

  it('a newer look wins over a cheaper older one', () => {
    const older = price({ id: 1, observedAt: T, costKeys: 15, costScrap: 0 });
    const newDear = price({ id: 2, observedAt: T + 60_000, costKeys: 25, costScrap: 0, special: special({ sheen: 3, killstreaker: 2006 }) });
    const newCheap = price({ id: 3, observedAt: T + 60_000, costKeys: 20, costScrap: 0, special: special({ sheen: 4, killstreaker: 2007 }) });
    expect(buyOf(recordBuyInit(KIT, [older, newDear, newCheap]))).toEqual({ keys: 20, scrap: 0 });
    expect(buyOf(recordBuyInit(KIT, [newCheap, newDear, older]))).toEqual({ keys: 20, scrap: 0 });
    // Even a typed price: the newest wins, however cheap the page was.
    const typed = price({ id: 4, observedAt: T + 120_000, costKeys: 30, costScrap: 0, source: 'user', special: null, importBatch: null });
    expect(buyOf(recordBuyInit(KIT, [older, newDear, newCheap, typed]))).toEqual({ keys: 30, scrap: 0 });
  });

  it('prefills a killstreak weapon whose only stored copy has a sheen (and a killstreaker)', () => {
    const pro = price({ id: 1, sku: PRO_WEAPON.sku, name: PRO_WEAPON.name, costKeys: 0, costScrap: 120, special: special({ sheen: 3, killstreaker: 2008 }) });
    expect(priceIsForSku(pro, PRO_WEAPON.sku)).toBe(true);
    expect(recordBuyInit(PRO_WEAPON, [pro])).toEqual({ side: 'buy', sku: PRO_WEAPON.sku, name: PRO_WEAPON.name, venue: 'scrap.tf', keys: 0, scrap: 120 });
    const spec = price({ id: 2, sku: SPEC_WEAPON.sku, name: SPEC_WEAPON.name, costKeys: 0, costScrap: 40, special: special({ sheen: 1 }) });
    expect(buyOf(recordBuyInit(SPEC_WEAPON, [spec]))).toEqual({ keys: 0, scrap: 40 });
    // The kit row the same way: no copy of it is without a sheen.
    expect(buyOf(recordBuyInit(KIT, [price({ id: 9, costKeys: 22, costScrap: 3 })]))).toEqual({ keys: 22, scrap: 3 });
  });

  it("never borrows a painted, spelled, parted or named copy's price for the plain SKU", () => {
    const plain = price({ id: 1, sku: HAT.sku, name: HAT.name, costScrap: 18, special: NONE });
    // Same look, cheaper: the pink copy is another item, even though it is the cheapest of the look.
    const pink = price({ id: 2, sku: HAT.sku, name: HAT.name, costScrap: 5, special: special({ paint: PINK }) });
    expect(buyOf(recordBuyInit(HAT, [plain, pink]))).toEqual({ keys: 0, scrap: 18 });
    expect(buyOf(recordBuyInit(HAT, [pink, plain]))).toEqual({ keys: 0, scrap: 18 });
    // A newer pink copy does not replace the plain price either, and alone it gives no price.
    const newerPink = price({ ...pink, id: 3, observedAt: T + 60_000 });
    expect(buyOf(recordBuyInit(HAT, [plain, newerPink]))).toEqual({ keys: 0, scrap: 18 });
    expect(recordBuyInit(HAT, [newerPink])).toEqual({ side: 'buy', sku: HAT.sku, name: HAT.name, venue: 'scrap.tf' });
    // The painted SKU still takes its paint's price, from the SKU's own paint token too.
    expect(recordBuyInit({ sku: `${HAT.sku};p${PINK}`, name: HAT.name }, [plain, pink])).toMatchObject({ scrap: 5 });
    expect(priceIsForSku(price({ sku: `${HAT.sku};p${PINK}`, special: null }), HAT.sku)).toBe(false);
    // A sheen does not make a spelled, parted or named killstreak copy plain.
    const pro = { sku: PRO_WEAPON.sku, name: PRO_WEAPON.name };
    const sheen = { sheen: 3, killstreaker: 2008 };
    const plainPro = price({ id: 10, ...pro, costScrap: 120, special: special(sheen) });
    for (const extra of [{ spells: ['Exorcism'] }, { parts: ['Kills'] }, { customName: true }, { customDesc: true }, { paint: PINK }]) {
      const other = price({ id: 11, ...pro, costScrap: 30, special: special({ ...sheen, ...extra }) });
      expect(priceIsForSku(other, PRO_WEAPON.sku)).toBe(false);
      expect(buyOf(recordBuyInit(PRO_WEAPON, [plainPro, other]))).toEqual({ keys: 0, scrap: 120 });
      expect(recordBuyInit(PRO_WEAPON, [other])).toEqual({ side: 'buy', sku: PRO_WEAPON.sku, name: PRO_WEAPON.name, venue: 'scrap.tf' });
    }
  });

  it("picks the same copy as the service's Live check (newestStoredPrice) for a plain SKU", () => {
    // Kit copies over three looks, varied keys and metal, a typed price among them.
    const prices: ScrapPrice[] = [
      price({ id: 1, observedAt: T, costKeys: 12, costScrap: 0, special: special({ sheen: 1, killstreaker: 2002 }) }),
      price({ id: 2, observedAt: T + 1, costKeys: 20, costScrap: 9, special: special({ sheen: 2, killstreaker: 2003 }) }),
      price({ id: 3, observedAt: T + 1, costKeys: 19, costScrap: 500, special: special({ sheen: 3, killstreaker: 2004 }) }),
      price({ id: 4, observedAt: T + 1, costKeys: 20, costScrap: 9, special: special({ sheen: 4, killstreaker: 2005 }) }),
      price({ id: 5, observedAt: T + 1, costKeys: 21, costScrap: 0, special: special({ sheen: 5, killstreaker: 2006 }) }),
    ];
    for (const k of [400, 540, 700]) {
      for (const order of [prices, [...prices].reverse()]) {
        expect(newestScrapPrice(order.filter((p) => priceIsForSku(p, KIT.sku)), k)?.id).toBe(newestStoredPrice(order, true, k)?.id);
      }
    }
  });

  it('the drawer passes the key price it shows', () => {
    const drawer = readFileSync(new URL('../../src/renderer/pages/ItemDrawer.tsx', import.meta.url), 'utf8');
    expect(drawer).toContain('recordBuyInit(d, d.scrapPrices, null, keyScrap)');
  });
});
