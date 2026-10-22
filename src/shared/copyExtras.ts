// 0.7.4 (F66): which copy of an item an opportunity prices. Imports store a painted hat or a kit's
// sheen/killstreaker combo under the plain base SKU with the extras in ScrapPrice.special, so two painted
// The Last Laughs, or 25 copies of one Professional Killstreak kit, used to show as identical rows under the
// plain name. Opportunity.copyKey is the copy's bank_stock special key (bankStockSpecialKey, '' for a plain
// copy and for rules), derived at read time from the input's price row (no stored column); the dashboard names
// the copy from it and opens the drawer's scrap.tf history on that copy.

import { BANK_STOCK_PLAIN_KEY, bankStockSpecialKey } from './bankStock';
import { baseSku, fromString } from './sku';
import type { Opportunity, OrderSummary, SpecialAttrs } from './types';

/**
 * 0.7.4 (F27, F33): among copies of one item whose revenue comes from the same buy order (`orderOf`, the row's
 * revenue order), every copy but the most profitable (ties by key) is flagged 'shared-buyer': each row's own
 * profit stays right for that copy alone, but the order may buy only one, so totals count it once. A row with no
 * revenue order or no profit is left alone. Mutates the rows' flags. The engine (per base) and the mock share it.
 */
export function markSharedBuyers(rows: readonly Opportunity[], orderOf: (o: Opportunity) => OrderSummary | null): void {
  const byOrder = new Map<string, Opportunity[]>();
  for (const o of rows) {
    if (o.profitScrap === null || !Number.isFinite(o.profitScrap)) continue;
    const id = orderOf(o)?.listingId;
    if (!id) continue;
    const list = byOrder.get(id);
    if (list) list.push(o);
    else byOrder.set(id, [o]);
  }
  for (const group of byOrder.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (b.profitScrap ?? 0) - (a.profitScrap ?? 0) || a.key.localeCompare(b.key));
    for (const o of group.slice(1)) if (!o.flags.includes('shared-buyer')) o.flags.push('shared-buyer');
  }
}

/**
 * 0.7.4 (R27): the summed profit of `rows` (a group's rows as a query returned them), each item's buy order
 * counted once: per base SKU and revenue order (`orderOf`), only the most profitable of these rows counts.
 * markSharedBuyers' stored flag is set once over every copy, so a filter that hid the best copy (a tier, an
 * input kind, a minimum confidence) left the rest at 0 and the buyer counted zero times; this counts the best
 * copy shown. Over every copy it equals summing all but the flagged rows. Rule rows are no copies (the engine and
 * the mock flag price inputs only), and they and rows with no order or no profit count alone (null profit as 0).
 * The repo's opportunityGroupStats does the same in SQL.
 */
export function onceByOrderProfit(rows: readonly Opportunity[], orderOf: (o: Opportunity) => OrderSummary | null): number {
  let total = 0;
  const best = new Map<string, number>();
  for (const o of rows) {
    const p = typeof o.profitScrap === 'number' && Number.isFinite(o.profitScrap) ? o.profitScrap : null;
    const id = p === null || o.inputKind === 'rule' ? undefined : orderOf(o)?.listingId;
    if (p === null || !id) {
      total += p ?? 0;
      continue;
    }
    let base: string;
    try {
      base = baseSku(o.sku);
    } catch {
      base = o.sku;
    }
    const k = JSON.stringify([base, id]);
    const cur = best.get(k);
    if (cur === undefined || p > cur) best.set(k, p);
  }
  for (const p of best.values()) total += p;
  return total;
}

/** Sheen ids as scrap.tf's cards and the item schema name them (the import parser reads the same table). */
export const SHEEN_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Team Shine',
  2: 'Deadly Daffodil',
  3: 'Manndarin',
  4: 'Mean Green',
  5: 'Agonizing Emerald',
  6: 'Villainous Violet',
  7: 'Hot Rod',
});

/** Killstreaker ids, as SHEEN_NAMES. */
export const KILLSTREAKER_NAMES: Readonly<Record<number, string>> = Object.freeze({
  2002: 'Fire Horns',
  2003: 'Cerebral Discharge',
  2004: 'Tornado',
  2005: 'Flames',
  2006: 'Singularity',
  2007: 'Incinerator',
  2008: 'Hypno-Beam',
});

/**
 * Opportunity.copyKey of a price input: its extras with the price SKU's paint moved in (as explicitInput does),
 * as bankStockSpecialKey writes them, so it equals the bank stock row of the same copy. '' for a plain copy, an
 * unknown special (a typed price) or an unreadable SKU.
 */
export function opportunityCopyKey(priceSku: string, special: Partial<SpecialAttrs> | null | undefined): string {
  let paint: number | null = null;
  try {
    const p = fromString(String(priceSku ?? '').trim()).paint;
    paint = typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    paint = null;
  }
  if (!special) return paint === null ? BANK_STOCK_PLAIN_KEY : bankStockSpecialKey({ paint });
  const own = typeof special.paint === 'number' && Number.isFinite(special.paint) && special.paint > 0 ? special.paint : null;
  return bankStockSpecialKey({ ...special, paint: own ?? paint });
}

/** A copy key read back into its extras; null for a plain copy or a key it cannot read. */
export interface CopyExtras {
  paint: number | null;
  spells: string[];
  parts: string[];
  sheen: number | null;
  killstreaker: number | null;
  nameTag: boolean;
  descTag: boolean;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The extras in a copyKey (bankStockSpecialKey's JSON array), or null for '' or an unreadable key. */
export function copyExtrasOf(copyKey: string | null | undefined): CopyExtras | null {
  if (typeof copyKey !== 'string' || copyKey === BANK_STOCK_PLAIN_KEY) return null;
  let v: unknown;
  try {
    v = JSON.parse(copyKey);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const [paint, spells, parts, sheen, killstreaker, customName, customDesc] = v as unknown[];
  const names = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : []);
  return {
    paint: finite(paint) && paint > 0 ? paint : null,
    spells: names(spells),
    parts: names(parts),
    sheen: finite(sheen) ? sheen : null,
    killstreaker: finite(killstreaker) ? killstreaker : null,
    nameTag: customName === true,
    descTag: customDesc === true,
  };
}

/**
 * 0.7.4 (F66): every extra of a copy in words ("Noble Hatter's Violet", "Team Shine", "Fire Horns", "Spell:
 * Exorcism", "Strange part: Kills", "Name tag"), or [] for a plain copy or a key it cannot read. `paintName`
 * names a paint decimal (the dashboard's table, the service's item schema). Shared by the dashboard's copy
 * labels and the engine's "Profit:" title.
 */
export function copyExtrasWords(copyKey: string | null | undefined, paintName: (decimal: number) => string): string[] {
  const x = copyExtrasOf(copyKey);
  if (!x) return [];
  const out: string[] = [];
  if (x.paint !== null) out.push(paintName(x.paint));
  if (x.sheen !== null) out.push(SHEEN_NAMES[x.sheen] ?? 'A sheen');
  if (x.killstreaker !== null) out.push(KILLSTREAKER_NAMES[x.killstreaker] ?? 'A killstreaker');
  for (const s of x.spells) out.push(`Spell: ${s}`);
  for (const s of x.parts) out.push(`Strange part: ${s}`);
  if (x.nameTag) out.push('Name tag');
  if (x.descTag) out.push('Description tag');
  return out;
}
