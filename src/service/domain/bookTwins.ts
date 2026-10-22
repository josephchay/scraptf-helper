// 0.7.4 (F09/F14/F49/F73, F08/F43/F69): one item's backpack.tf buy book, read from every base SKU it is filed
// under. A bp.tf buy order is one per buyer and full name (its id is md5 of the name), but it keeps the defindex
// of the item document its maker sent, so the orders for "Strange Australium Rocket Launcher" sit under both
// 18;11;australium and 205;11;australium, a War Paint's under 9536 and its own 17xxx defindex, an unusual
// skin's under 5+effect, the feed's 11+effect strange form and the 0.7.3 15+effect form. SchemaService.bookBases
// names the twins (0.7.4 review: never a tool's targetless form, R17; a targeted strangifier's or Collector's set's
// other defindexes, R18; a strange skin's 11 and 15+strange forms, R19); every book read (engine, Live market,
// Holdings, the drawer, Live check) goes through here, and stored SKUs (prices, saves, the journal) are never
// rewritten. Local reads only, no request.

import type { Listing } from '../../shared/types';
import type { SchemaService } from '../contracts';

type TwinSchema = Pick<SchemaService, 'bookBases' | 'bookBase'> | null | undefined;

/** Every base SKU of `base`'s book, `base` first; [base] without a schema (or a double without bookBases). */
export function bookBasesOf(schema: TwinSchema, base: string): readonly string[] {
  try {
    const list = schema?.bookBases?.(base);
    if (!list || list.length === 0) return [base];
    if (list[0] === base) return list;
    return [base, ...list.filter((b) => b !== base)];
  } catch {
    return [base];
  }
}

/** The one base SKU that keys `base`'s merged book (a Live market row, an engine rule row); `base` without a schema. */
export function canonicalBookBase(schema: TwinSchema, base: string): string {
  try {
    const c = schema?.bookBase?.(base);
    return typeof c === 'string' && c !== '' ? c : base;
  } catch {
    return base;
  }
}

/** The other bases of `base`'s book (bookBasesOf without `base` itself). */
export function twinBasesOf(schema: TwinSchema, base: string): readonly string[] {
  const all = bookBasesOf(schema, base);
  return all.length < 2 ? [] : all.slice(1);
}

/**
 * One book from its parts' books: `base`'s own rows as they are, every twin's rows filed under `base`, so
 * dedupeOrders keys a buyer once per item (a buyer with orders under two twins keeps the newest). `bookOf`
 * returns a base's stored rows.
 */
export function mergedBook(base: string, bases: readonly string[], bookOf: (b: string) => readonly Listing[]): Listing[] {
  const own = bookOf(base);
  if (bases.length < 2) return own as Listing[];
  const out: Listing[] = [...own];
  for (const b of bases) {
    if (b === base) continue;
    for (const l of bookOf(b)) out.push(l.baseSku === base ? l : { ...l, baseSku: base });
  }
  return out;
}

/** Every base of these books and their twins, for one repo read. */
export function withTwins(schema: TwinSchema, bases: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const b of bases) for (const t of bookBasesOf(schema, b)) out.add(t);
  return out;
}
