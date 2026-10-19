// scrap.tf price list (F14) rules shared by the service, the browser mock and the
// dashboard, so all three value a list row, call it full or fresh, and pick a held
// item's better exit the same way (as market.ts and holdings.ts do for their
// features). Pure: no I/O, no network. The list is only ever what the user saved
// from scrap.tf/items with their own browser (R10); nothing here fetches it (R1).

import { valueScrap } from './currency';
import { SCRAPTF_ITEMS_URL } from './links';
import { HOLDING_EXIT_VENUES, KEY_SKU } from './types';
import type { HoldingExit, Scrap, ScrapPrice, ScraptfListCoverage, ScraptfListKey, ScraptfListRow, ScraptfListStored, UnixMs } from './types';

export const SCRAPTF_LIST_LABEL = 'All items';

/**
 * A list row at most this old is "fresh": it may be a held item's exit (HoldingRow.bestExit) and
 * counts as a fresh list for the Live market (S5). Older rows are still shown, with their age.
 */
export const SCRAPTF_LIST_FRESH_MS = 24 * 60 * 60_000;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** scrap.tf is at its limit for the item (stock n of limit, n >= limit), so it will not buy more right now. */
export function scraptfListFull(stock: number | null, stockLimit: number | null): boolean {
  return finite(stock) && finite(stockLimit) && stock >= stockLimit;
}

/** A stored row valued with key price `keyScrap` (keys and metal kept apart in the *Raw fields). */
export function valueScraptfListRow(r: ScraptfListStored, keyScrap: Scrap): ScraptfListRow {
  const sells = finite(r.sellsScrap) ? r.sellsScrap : null;
  const sellsKeys = sells === null ? null : finite(r.sellsKeys) ? r.sellsKeys : 0;
  const pays = finite(r.paysScrap) ? r.paysScrap : null;
  const paysKeys = pays === null ? null : finite(r.paysKeys) ? r.paysKeys : 0;
  const stock = finite(r.stock) ? r.stock : null;
  const stockLimit = finite(r.stockLimit) ? r.stockLimit : null;
  return {
    sku: r.sku,
    name: r.name,
    sellsKeys,
    sellsScrapRaw: sells,
    sellsScrap: sells === null ? null : valueScrap(sellsKeys ?? 0, sells, keyScrap),
    paysKeys,
    paysScrapRaw: pays,
    paysScrap: pays === null ? null : valueScrap(paysKeys ?? 0, pays, keyScrap),
    stock,
    stockLimit,
    full: scraptfListFull(stock, stockLimit),
    observedAt: r.observedAt,
  };
}

/** The row was saved at most SCRAPTF_LIST_FRESH_MS ago (a clock moved back counts as fresh). */
export function scraptfListFresh(r: Pick<ScraptfListRow, 'observedAt'>, now: UnixMs): boolean {
  return finite(r.observedAt) && now - r.observedAt <= SCRAPTF_LIST_FRESH_MS;
}

/**
 * The key row (KEY_SKU, 5021;6) as scrap.tf's own key prices, read raw: scrap.tf prices a key in
 * metal, so no key price is needed (selectKeyPrice reads this without a cycle). A price listed in keys
 * is dropped (it would value a key by itself). Null without a key row, or with neither price left.
 */
export function scraptfListKeyOf(r: ScraptfListStored | null | undefined): ScraptfListKey | null {
  if (!r || r.sku !== KEY_SKU || !finite(r.observedAt)) return null;
  const inMetal = (scrap: number | null, keys: number | null): Scrap | null => (finite(scrap) && !(finite(keys) && keys !== 0) ? scrap : null);
  const sells = inMetal(r.sellsScrap, r.sellsKeys);
  const pays = inMetal(r.paysScrap, r.paysKeys);
  if (sells === null && pays === null) return null;
  return { sellsScrap: sells, paysScrap: pays, observedAt: r.observedAt };
}

/**
 * A held item's better exit (HoldingRow.bestExit / exitScrap / exitVenue): scrap.tf when its list row
 * pays something, is not full, is fresh (SCRAPTF_LIST_FRESH_MS) and pays more than the backpack.tf
 * revenue, or there is no backpack.tf revenue; else backpack.tf when there is a revenue; else none.
 * backpack.tf wins a tie (a buyer order is a live price; the list is as old as the last save).
 */
export function bestExitOf(
  revenueScrap: Scrap | null,
  list: Pick<ScraptfListRow, 'paysScrap' | 'full' | 'observedAt'> | null,
  now: UnixMs,
): { bestExit: HoldingExit | null; exitScrap: Scrap | null; exitVenue: string | null } {
  const revenue = finite(revenueScrap) ? revenueScrap : null;
  const pays = list && finite(list.paysScrap) && !list.full && scraptfListFresh(list, now) ? list.paysScrap : null;
  if (pays !== null && (revenue === null || pays > revenue)) return { bestExit: 'scraptf', exitScrap: pays, exitVenue: HOLDING_EXIT_VENUES.scraptf };
  if (revenue !== null) return { bestExit: 'backpack', exitScrap: revenue, exitVenue: HOLDING_EXIT_VENUES.backpack };
  return { bestExit: null, exitScrap: null, exitVenue: null };
}

/** The coverage strip's "All items" chip from the list's row count and newest row (null: no list saved). */
export function scraptfListCoverage(summary: { items: number; newestAt: UnixMs | null } | null): ScraptfListCoverage {
  const items = summary && finite(summary.items) && summary.items > 0 ? Math.floor(summary.items) : 0;
  return { label: SCRAPTF_LIST_LABEL, url: SCRAPTF_ITEMS_URL, lastSavedAt: items > 0 && summary && finite(summary.newestAt) ? summary.newestAt : null, items };
}

/** MarketRow's scrap.tf list fields for a row (all null/false without a list row). */
export function marketListFields(
  list: ScraptfListRow | null,
): { scraptfPaysScrap: Scrap | null; scraptfStock: number | null; scraptfStockLimit: number | null; scraptfFull: boolean; scraptfListAt: UnixMs | null } {
  return {
    scraptfPaysScrap: list?.paysScrap ?? null,
    scraptfStock: list?.stock ?? null,
    scraptfStockLimit: list?.stockLimit ?? null,
    scraptfFull: list?.full ?? false,
    scraptfListAt: list?.observedAt ?? null,
  };
}

/**
 * MarketQuery.onScraptfList: only rows on the saved list. Applied with the buy-side filters (before the
 * verdict counts), so the chips count what the list filter leaves.
 */
export function marketListSideMatches(r: { scraptfListAt: UnixMs | null }, q: { onScraptfList?: boolean }): boolean {
  return q.onScraptfList !== true || finite(r.scraptfListAt);
}

/**
 * HoldingRow's scrap.tf list fields for a row (all null/false without a list row). The pays price comes
 * valued (status and profit) and as listed, keys and metal apart (Record sale books what scrap.tf hands over).
 */
export function holdingListFields(list: ScraptfListRow | null): {
  scraptfPaysScrap: Scrap | null;
  scraptfPaysKeys: number | null;
  scraptfPaysScrapRaw: Scrap | null;
  scraptfFull: boolean;
  scraptfListAt: UnixMs | null;
} {
  return {
    scraptfPaysScrap: list?.paysScrap ?? null,
    scraptfPaysKeys: list?.paysKeys ?? null,
    scraptfPaysScrapRaw: list?.paysScrapRaw ?? null,
    scraptfFull: list?.full ?? false,
    scraptfListAt: list?.observedAt ?? null,
  };
}

/** The note on a price taken from the saved list (the drawer's "Use as my price", quick entry's Use). */
export const SCRAPTF_LIST_PRICE_NOTE = 'from scrap.tf list';

/**
 * What "Use as my price" saves for a list row: scrap.tf's price to buy, keys and metal as listed. null
 * when there is nothing to buy: no price ("Sold out"), a zero price, or stock 0. The saved-page import
 * refuses a stock-0 row as a price too ("out of stock on scrap.tf"), and a typed copy would outlive later
 * imports as a known cost for an item scrap.tf cannot sell.
 */
export function scraptfListUsePrice(row: Pick<ScraptfListRow, 'sellsKeys' | 'sellsScrapRaw' | 'stock'>): { keys: number; scrap: Scrap } | null {
  if (!finite(row.sellsScrapRaw) || row.stock === 0) return null;
  const keys = finite(row.sellsKeys) && row.sellsKeys > 0 ? row.sellsKeys : 0;
  const scrap = Math.max(0, Math.round(row.sellsScrapRaw));
  return keys === 0 && scrap === 0 ? null : { keys, scrap };
}

/**
 * `prices` already holds this list row's price as "Use as my price" stores it (the plain copy under the
 * row's base SKU, the same keys, metal and list date, the list note), so another click would only add the
 * same row again (prices.upsert adds a row per call). Shared so the service can answer it for a painted
 * drawer, whose own prices leave the plain copy's out.
 */
export function scraptfListPriceSaved(
  row: Pick<ScraptfListRow, 'sku' | 'sellsKeys' | 'sellsScrapRaw' | 'stock' | 'observedAt'>,
  prices: readonly Pick<ScrapPrice, 'sku' | 'source' | 'note' | 'observedAt' | 'costKeys' | 'costScrap' | 'special'>[],
): boolean {
  const price = scraptfListUsePrice(row);
  if (!price) return false;
  const sku = row.sku.trim().toLowerCase();
  return prices.some(
    (p) =>
      p.source === 'user' &&
      p.note === SCRAPTF_LIST_PRICE_NOTE &&
      p.sku.trim().toLowerCase() === sku &&
      (p.special?.paint ?? null) === null &&
      p.observedAt === row.observedAt &&
      (p.costKeys || 0) === price.keys &&
      p.costScrap === price.scrap,
  );
}
