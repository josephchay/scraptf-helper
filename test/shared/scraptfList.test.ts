// F14 shared rules: valuing a saved scrap.tf/items row, full and fresh, the key row, a held item's
// better exit, the "All items" chip and the list filter. Pure; nothing here touches the network.

import { describe, expect, it } from 'vitest';
import { SCRAPTF_ITEMS_URL, isAllowedExternalUrl } from '../../src/shared/links';
import {
  SCRAPTF_LIST_FRESH_MS,
  bestExitOf,
  holdingListFields,
  marketListFields,
  marketListSideMatches,
  scraptfListCoverage,
  scraptfListFresh,
  scraptfListFull,
  scraptfListKeyOf,
  valueScraptfListRow,
} from '../../src/shared/scraptfList';
import { KEY_SKU, type ScraptfListStored } from '../../src/shared/types';

const T0 = 1_791_958_000_000;
const K = 568;

function stored(over: Partial<ScraptfListStored> = {}): ScraptfListStored {
  return { sku: '378;6', name: 'Team Captain', sellsKeys: 1, sellsScrap: 99, paysKeys: 1, paysScrap: 9, stock: 2, stockLimit: 6, batchId: 1, observedAt: T0, ...over };
}

describe('valueScraptfListRow', () => {
  it('values keys at the given key price and keeps the listed parts', () => {
    expect(valueScraptfListRow(stored(), K)).toEqual({
      sku: '378;6',
      name: 'Team Captain',
      sellsKeys: 1,
      sellsScrapRaw: 99,
      sellsScrap: K + 99,
      paysKeys: 1,
      paysScrapRaw: 9,
      paysScrap: K + 9,
      stock: 2,
      stockLimit: 6,
      full: false,
      observedAt: T0,
    });
    expect(valueScraptfListRow(stored(), 600).sellsScrap).toBe(699);
  });

  it('keeps a missing pays price, stock and limit as null', () => {
    const r = valueScraptfListRow(stored({ paysKeys: null, paysScrap: null, stock: null, stockLimit: null }), K);
    expect(r).toMatchObject({ paysKeys: null, paysScrapRaw: null, paysScrap: null, stock: null, stockLimit: null, full: false });
  });

  it('keeps a "Sold out" row without a price to buy', () => {
    const r = valueScraptfListRow(stored({ sellsKeys: null, sellsScrap: null, stock: 0, stockLimit: 5 }), K);
    expect(r).toMatchObject({ sellsKeys: null, sellsScrapRaw: null, sellsScrap: null, paysScrap: K + 9, stock: 0, full: false });
  });

  it('marks a row full at its limit', () => {
    expect(valueScraptfListRow(stored({ stock: 6, stockLimit: 6 }), K).full).toBe(true);
    expect(valueScraptfListRow(stored({ stock: 0, stockLimit: 6 }), K).full).toBe(false);
  });
});

describe('scraptfListFull / scraptfListFresh', () => {
  it('is full only with both numbers and stock at or over the limit', () => {
    expect(scraptfListFull(5, 5)).toBe(true);
    expect(scraptfListFull(6, 5)).toBe(true);
    expect(scraptfListFull(0, 0)).toBe(true);
    expect(scraptfListFull(4, 5)).toBe(false);
    expect(scraptfListFull(null, 5)).toBe(false);
    expect(scraptfListFull(5, null)).toBe(false);
  });

  it('is fresh for 24 h', () => {
    expect(SCRAPTF_LIST_FRESH_MS).toBe(24 * 3_600_000);
    expect(scraptfListFresh({ observedAt: T0 - SCRAPTF_LIST_FRESH_MS }, T0)).toBe(true);
    expect(scraptfListFresh({ observedAt: T0 - SCRAPTF_LIST_FRESH_MS - 1 }, T0)).toBe(false);
    expect(scraptfListFresh({ observedAt: T0 + 60_000 }, T0)).toBe(true);
    expect(scraptfListFresh({ observedAt: Number.NaN }, T0)).toBe(false);
  });
});

describe('scraptfListKeyOf', () => {
  it('reads the key row raw, in metal', () => {
    expect(scraptfListKeyOf(stored({ sku: KEY_SKU, sellsKeys: 0, sellsScrap: 573, paysKeys: 0, paysScrap: 561 }))).toEqual({ sellsScrap: 573, paysScrap: 561, observedAt: T0 });
    expect(scraptfListKeyOf(stored({ sku: KEY_SKU, sellsKeys: 0, sellsScrap: 573, paysKeys: null, paysScrap: null }))).toEqual({ sellsScrap: 573, paysScrap: null, observedAt: T0 });
  });

  it('refuses another SKU, a missing row and prices listed in keys', () => {
    expect(scraptfListKeyOf(stored({ sellsKeys: 0 }))).toBeNull();
    expect(scraptfListKeyOf(null)).toBeNull();
    expect(scraptfListKeyOf(undefined)).toBeNull();
    expect(scraptfListKeyOf(stored({ sku: KEY_SKU, sellsKeys: 1, sellsScrap: 0, paysKeys: 1, paysScrap: 0 }))).toBeNull();
    expect(scraptfListKeyOf(stored({ sku: KEY_SKU, sellsKeys: 0, sellsScrap: 573, paysKeys: 1, paysScrap: 0 }))!.paysScrap).toBeNull();
    // Keys sold out: what scrap.tf pays for one still caps the key value.
    expect(scraptfListKeyOf(stored({ sku: KEY_SKU, sellsKeys: null, sellsScrap: null, paysKeys: 0, paysScrap: 561 }))).toEqual({ sellsScrap: null, paysScrap: 561, observedAt: T0 });
  });
});

describe('bestExitOf', () => {
  const list = (paysScrap: number | null, over: { full?: boolean; observedAt?: number } = {}) => ({ paysScrap, full: false, observedAt: T0 - 60_000, ...over });

  it('picks scrap.tf when it pays more, or when there are no buyers', () => {
    expect(bestExitOf(100, list(120), T0)).toEqual({ bestExit: 'scraptf', exitScrap: 120, exitVenue: 'scrap.tf' });
    expect(bestExitOf(null, list(40), T0)).toEqual({ bestExit: 'scraptf', exitScrap: 40, exitVenue: 'scrap.tf' });
  });

  it('keeps backpack.tf on a tie and when scrap.tf pays less', () => {
    expect(bestExitOf(120, list(120), T0)).toEqual({ bestExit: 'backpack', exitScrap: 120, exitVenue: 'backpack.tf' });
    expect(bestExitOf(120, list(90), T0)).toEqual({ bestExit: 'backpack', exitScrap: 120, exitVenue: 'backpack.tf' });
    expect(bestExitOf(120, null, T0).bestExit).toBe('backpack');
  });

  it('never uses a full, stale or pay-less list row', () => {
    expect(bestExitOf(100, list(200, { full: true }), T0).bestExit).toBe('backpack');
    expect(bestExitOf(100, list(200, { observedAt: T0 - SCRAPTF_LIST_FRESH_MS - 1 }), T0).bestExit).toBe('backpack');
    expect(bestExitOf(100, list(null), T0).bestExit).toBe('backpack');
    expect(bestExitOf(null, list(200, { full: true }), T0)).toEqual({ bestExit: null, exitScrap: null, exitVenue: null });
    expect(bestExitOf(null, null, T0)).toEqual({ bestExit: null, exitScrap: null, exitVenue: null });
  });
});

describe('row fields, the chip and the filter', () => {
  it('fills the market and holdings fields from a row, or null/false without one', () => {
    // 0.7.4: a row proven to price its copy carries no family flag.
    const row = valueScraptfListRow(stored({ stock: 6, stockLimit: 6, craft: 'craftable' }), K);
    expect(marketListFields(row)).toEqual({ scraptfPaysScrap: K + 9, scraptfStock: 6, scraptfStockLimit: 6, scraptfFull: true, scraptfListAt: T0 });
    expect(marketListFields(null)).toEqual({ scraptfPaysScrap: null, scraptfStock: null, scraptfStockLimit: null, scraptfFull: false, scraptfListAt: null });
    // Holdings also carries the pays price as listed (keys and metal apart) for its Record sale prefill.
    expect(holdingListFields(row)).toEqual({ scraptfPaysScrap: K + 9, scraptfPaysKeys: 1, scraptfPaysScrapRaw: 9, scraptfFull: true, scraptfListAt: T0 });
    expect(holdingListFields(null)).toEqual({ scraptfPaysScrap: null, scraptfPaysKeys: null, scraptfPaysScrapRaw: null, scraptfFull: false, scraptfListAt: null });
    // A family row (unmarked, or read for a copy with no row of its own) says so: its stock counts every copy.
    const family = valueScraptfListRow(stored({ stock: 6, stockLimit: 6, craft: 'any' }), K);
    expect(marketListFields(family)).toMatchObject({ scraptfStock: 6, scraptfListFamily: true });
    expect(holdingListFields(family)).toMatchObject({ scraptfPaysScrap: K + 9, scraptfListFamily: true });
    expect(marketListFields({ ...row, match: 'family' }).scraptfListFamily).toBe(true);
  });

  it('builds the "All items" chip for the exact scrap.tf/items page', () => {
    expect(scraptfListCoverage({ items: 2341, newestAt: T0 })).toEqual({ label: 'All items', url: SCRAPTF_ITEMS_URL, lastSavedAt: T0, items: 2341 });
    expect(scraptfListCoverage(null)).toEqual({ label: 'All items', url: SCRAPTF_ITEMS_URL, lastSavedAt: null, items: 0 });
    expect(scraptfListCoverage({ items: 0, newestAt: T0 }).lastSavedAt).toBeNull();
    expect(isAllowedExternalUrl(scraptfListCoverage(null).url)).toBe(true);
  });

  it('filters to rows on the list only when asked', () => {
    expect(marketListSideMatches({ scraptfListAt: null }, {})).toBe(true);
    expect(marketListSideMatches({ scraptfListAt: null }, { onScraptfList: false })).toBe(true);
    expect(marketListSideMatches({ scraptfListAt: null }, { onScraptfList: true })).toBe(false);
    expect(marketListSideMatches({ scraptfListAt: T0 }, { onScraptfList: true })).toBe(true);
  });
});
