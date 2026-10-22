// scrap.tf price list (F14) rules shared by the service, the browser mock and the
// dashboard, so all three value a list row, call it full or fresh, and pick a held
// item's better exit the same way (as market.ts and holdings.ts do for their
// features). Pure: no I/O, no network. The list is only ever what the user saved
// from scrap.tf/items with their own browser (R10); nothing here fetches it (R1).

import { valueScrap } from './currency';
import { SCRAPTF_ITEMS_URL } from './links';
import { canonical, fromObject, fromString } from './sku';
import { HOLDING_EXIT_VENUES, KEY_SKU } from './types';
import type { HoldingExit, Scrap, ScrapPrice, ScraptfListCoverage, ScraptfListKey, ScraptfListRow, ScraptfListStored, UnixMs } from './types';

export const SCRAPTF_LIST_LABEL = 'All items';

/**
 * A list row at most this old is "fresh": it may be a held item's exit (HoldingRow.bestExit) and
 * counts as a fresh list for the Live market (S5). Older rows are still shown, with their age.
 */
export const SCRAPTF_LIST_FRESH_MS = 24 * 60 * 60_000;

/**
 * 0.7.1 (P3): the folder watch's status (ScraptfListStatus.watchError, Data health) while the item schema
 * has not loaded. Shared so the dashboard shows it as a wait, not as a watch error: the watch starts by
 * itself once the schema has loaded.
 */
export const WATCH_WAITING_FOR_SCHEMA = 'Waiting for item data to load';

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** scrap.tf is at its limit for the item (stock n of limit, n >= limit), so it will not buy more right now. */
export function scraptfListFull(stock: number | null, stockLimit: number | null): boolean {
  return finite(stock) && finite(stockLimit) && stock >= stockLimit;
}

/**
 * 0.7.4: the family an /items row stands for, as scrap.tf lists it: the SKU with craftability, killstreak
 * tier, festivizing and paint dropped (sheens, killstreakers and parts are no SKU tokens). Effect, wear and
 * paintkit, australium, quality, elevated strange, crate series and craft number stay: scrap.tf lists those
 * apart. null for a kit (its tier and target are the item) and for an unreadable SKU.
 */
export function scraptfListFamilyOf(sku: string): string | null {
  if (typeof sku !== 'string' || sku.trim() === '') return null;
  try {
    const obj = fromString(canonical(sku.trim()));
    if (!(obj.defindex > 0) || obj.target !== null || obj.output !== null) return null;
    return fromObject({ ...obj, craftable: true, killstreak: 0, festive: false, paint: null });
  } catch {
    return null;
  }
}

/**
 * 0.7.4: the stored row a lookup of `sku` reads (`get`: the stored row of a SKU, if any), shared by the
 * service's list cache (rowFor, has) and the browser mock. The SKU's own row (exact, then with paint
 * dropped), else its family's (scraptfListFamilyOf): an unmarked row ('any') stands for every copy scrap.tf
 * sells at its price, so a Non-Craftable, killstreak or festivized copy with no row of its own reads it, as
 * 'family'. Never a row proven for other copies (a 'craftable' row for a Non-Craftable copy), never past a
 * Non-Craftable row of the item's own (725;6;uncraftable keeps its row; its killstreak copies read none),
 * never for a kit.
 */
export function scraptfListLookup<T extends Pick<ScraptfListStored, 'craft'>>(get: (sku: string) => T | undefined, sku: string): { stored: T; match: 'exact' | 'family' } | null {
  if (typeof sku !== 'string' || sku.trim() === '') return null;
  const direct = get(sku);
  if (direct) return { stored: direct, match: 'exact' };
  let obj: ReturnType<typeof fromString>;
  try {
    obj = fromString(canonical(sku.trim()));
  } catch {
    return null;
  }
  const base = fromObject({ ...obj, paint: null });
  const own = get(base);
  if (own) return { stored: own, match: 'exact' };
  const family = scraptfListFamilyOf(base);
  if (family === null || family === base) return null;
  const row = get(family);
  if (!row || (row.craft ?? 'any') !== 'any') return null;
  // A Non-Craftable copy of an item scrap.tf lists Non-Craftable apart: priced apart, so not the family's.
  if (obj.craftable === false && get(fromObject({ ...fromString(family), craftable: false }))) return null;
  return { stored: row, match: 'family' };
}

/**
 * 0.7.4: the row is proven to price this very copy: looked up exactly (not as its family, ScraptfListRow.match)
 * and marked Non-Craftable, or shown Craftable beside the item's Non-Craftable row. Only such a row's price
 * is a cost ("Use as my price", quick entry's Use, the Live check's list price); a family row ('any') is
 * shown, never used as one.
 */
export function scraptfListCraftProven(row: Pick<ScraptfListRow, 'craft' | 'match'>): boolean {
  return (row.match ?? 'exact') === 'exact' && (row.craft === 'craftable' || row.craft === 'uncraftable');
}

/** 0.7.4: why a list row's price is no cost of this copy (scraptfListCraftProven false), as the drawer and quick entry say it. */
export const SCRAPTF_LIST_CRAFT_UNPROVEN =
  'The scrap.tf/items list does not show whether this is the Craftable or Non-Craftable copy; check the bank page';

/** 0.7.4: a family row's label (ScraptfListRow.match 'family', or craft 'any'): one row for every copy at its price. */
export const SCRAPTF_LIST_FAMILY_LABEL = 'One scrap.tf/items row for every copy at this price';

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
    ...(r.craft !== undefined ? { craft: r.craft } : {}),
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

/** 0.7.4: a family row: unmarked ('any', one row for every copy at its price) or read as a copy's family (match). */
export function scraptfListIsFamily(row: Pick<ScraptfListRow, 'craft' | 'match'>): boolean {
  return row.match === 'family' || (row.craft ?? 'any') === 'any';
}

/** MarketRow's scrap.tf list fields for a row (all null/false without a list row; 0.7.4: scraptfListFamily only when set). */
export function marketListFields(list: ScraptfListRow | null): {
  scraptfPaysScrap: Scrap | null;
  scraptfStock: number | null;
  scraptfStockLimit: number | null;
  scraptfFull: boolean;
  scraptfListAt: UnixMs | null;
  scraptfListFamily?: true;
} {
  return {
    scraptfPaysScrap: list?.paysScrap ?? null,
    scraptfStock: list?.stock ?? null,
    scraptfStockLimit: list?.stockLimit ?? null,
    scraptfFull: list?.full ?? false,
    scraptfListAt: list?.observedAt ?? null,
    ...(list && scraptfListIsFamily(list) ? { scraptfListFamily: true as const } : {}),
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
  scraptfListFamily?: true;
} {
  return {
    scraptfPaysScrap: list?.paysScrap ?? null,
    scraptfPaysKeys: list?.paysKeys ?? null,
    scraptfPaysScrapRaw: list?.paysScrapRaw ?? null,
    scraptfFull: list?.full ?? false,
    scraptfListAt: list?.observedAt ?? null,
    // 0.7.4: scrap.tf pays one price for every copy a family row stands for; its exit is labelled so.
    ...(list && scraptfListIsFamily(list) ? { scraptfListFamily: true as const } : {}),
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
