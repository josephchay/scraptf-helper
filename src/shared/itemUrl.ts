// Item links the app reads as an item: marketplace.tf item pages, PriceDB item pages and backpack.tf
// stats pages (classic paths and next.backpack.tf's query form). One definition of their hosts and
// path shapes, shared by the schema resolver (service, parseItemUrl) and main's clipboard filter
// (Live check, F16), which lets exactly these links past its long-token rule. Pure; nothing here
// fetches anything.

/** The query keys a next.backpack.tf stats link names its item with (parseItemUrl reads these). */
export const NEXT_STATS_PARAMS: readonly string[] = [
  'item',
  'quality',
  'tradable',
  'craftable',
  'elevatedQuality',
  'festivized',
  'killstreakTier',
  'texture',
  'australium',
  'wearTier',
  'priceindex',
];

/** PriceDB pages that take a SKU as the next path segment. */
const PRICEDB_ITEM_PAGES = ['item', 'graph', 'item-history', 'item-stats'];

/**
 * Where an item link keeps its item: a SKU path segment (marketplace.tf, PriceDB), the classic
 * backpack.tf stats segments (raw, not decoded), or next.backpack.tf's stats query.
 */
export type ItemUrlParts = { kind: 'sku'; segment: string } | { kind: 'stats'; segments: string[] } | { kind: 'next-stats'; params: URLSearchParams };

/** A link's host as these rules read it: lower case, without a leading "www.". */
export function itemUrlHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

/** The item part of `u` when it is one of the item links above, else null. Only host and path decide. */
export function itemUrlParts(u: URL): ItemUrlParts | null {
  const host = itemUrlHost(u);
  const segs = u.pathname.split('/').filter(Boolean);
  if (host === 'marketplace.tf') {
    const i = segs.findIndex((s) => s.toLowerCase() === 'tf2');
    const segment = segs[0]?.toLowerCase() === 'items' && i >= 0 ? segs[i + 1] : undefined;
    return segment ? { kind: 'sku', segment } : null;
  }
  if (host === 'pricedb.io') {
    const i = segs.findIndex((s) => PRICEDB_ITEM_PAGES.includes(s.toLowerCase()));
    const segment = i >= 0 ? segs[i + 1] : undefined;
    return segment ? { kind: 'sku', segment } : null;
  }
  if (host === 'backpack.tf' || host === 'next.backpack.tf') {
    if (segs[0]?.toLowerCase() !== 'stats') return null;
    return segs.length >= 3 ? { kind: 'stats', segments: segs } : { kind: 'next-stats', params: u.searchParams };
  }
  return null;
}
