// scrap.tf bank stock (F17) rules shared by the service's bank stock cache, the
// browser mock and the dashboard, so all three diff two saves, judge a row, filter,
// count, order, page and write CSV cells the same way (as market.ts and banks.ts do
// for their features). Pure: no I/O, no network. A save is a page the user saved
// from their own browser (R10); nothing here fetches anything (R1).

import { frictionOf, profitStatus, type CeilingSettings } from './ceiling';
import { formatScrap, valueScrap } from './currency';
import { scraptfBankInfo } from './links';
import { marketSearchTokens } from './market';
import { fromObject, fromString } from './sku';
import type {
  BankStockChange,
  BankStockCounts,
  BankStockFilter,
  BankStockQuery,
  BankStockResult,
  BankStockRow,
  BankStockSort,
  BankStockStored,
  BankStockVerdict,
  Category,
  ConfidenceLevel,
  ItemBankStock,
  KeyPriceState,
  OrderSummary,
  Scrap,
  ScraptfBank,
  ScraptfBankWhatsNew,
  ScraptfKeyRun,
  ScraptfPriceChange,
  SpecialAttrs,
  UnixMs,
} from './types';
import { BANK_STOCK_FILTERS, BANK_STOCK_SORTS } from './types';

/**
 * Saves per page the F17 diff reads and counts (bankStockPagePairs, BankStockResult.saves): only a page's
 * newest save and the one before it are compared. Retention is the F20 thinning below, not this.
 */
export const BANK_STOCK_KEEP_SAVES = 10;
/** Pages of one bank read (newest first); with BANK_STOCK_KEEP_SAVES, bounds the saves read per bank. */
export const BANK_STOCK_MAX_PAGES = 50;

// F20 S1 retention ("thinning", per bank page): enough saves stay for price history and time listed.
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Every save of a page from the last 24 h is kept. */
export const BANK_STOCK_KEEP_ALL_MS = DAY_MS;
/** From 24 h to 7 d, the newest save per clock hour (UTC) is kept. */
export const BANK_STOCK_HOURLY_MS = 7 * DAY_MS;
/** From 7 d to 90 d the newest save per UTC day; older saves go (but see bankStockThinning's protected saves). */
export const BANK_STOCK_MAX_AGE_MS = 90 * DAY_MS;
/** Hard cap per page, newest kept (a page saved every minute would otherwise keep 1,440 saves a day). */
export const BANK_STOCK_MAX_SAVES_PER_PAGE = 300;

/** One save as the thinning reads it (Repo.pruneBankStock lists every save with rows). */
export interface BankStockThinSave {
  batchId: number;
  savedAt: UnixMs;
  bank: ScraptfBank;
  /** bank_stock.page ('' when unknown). */
  page: string;
}

/**
 * F20 S1: the batch ids to delete, per bank page (bank + page). Keeps every save of the last 24 h, the
 * newest per UTC hour up to 7 d, the newest per UTC day up to 90 d, nothing older, and at most
 * BANK_STOCK_MAX_SAVES_PER_PAGE (the newest). A page's newest save and the save it is compared with (the
 * newest from strictly before it, previousOf) are never deleted, whatever their age or the cap: they are
 * what the stock page, its change chips and the change feed read. Buckets are clock-aligned, so a kept
 * save stays the newest of its bucket at the next run (no creeping deletes). Order: savedAt, then batch
 * id (as Repo.bankStockSaves). Pure; O(n log n).
 */
export function bankStockThinning(
  saves: readonly BankStockThinSave[],
  now: UnixMs,
  opts: { maxSaves?: number; maxAgeMs?: number } = {},
): Set<number> {
  const maxSaves = finite(opts.maxSaves) ? Math.max(1, Math.floor(opts.maxSaves)) : BANK_STOCK_MAX_SAVES_PER_PAGE;
  const maxAge = finite(opts.maxAgeMs) ? Math.max(0, opts.maxAgeMs) : BANK_STOCK_MAX_AGE_MS;
  const byPage = new Map<string, BankStockThinSave[]>();
  for (const s of saves) {
    const k = `${s.bank}\u0000${s.page}`;
    let g = byPage.get(k);
    if (!g) byPage.set(k, (g = []));
    g.push(s);
  }
  const drop = new Set<number>();
  for (const group of byPage.values()) {
    group.sort((a, b) => b.savedAt - a.savedAt || b.batchId - a.batchId);
    const newest = group[0]!;
    const previous = group.find((s) => s.savedAt < newest.savedAt) ?? null;
    const protectedIds = new Set<number>([newest.batchId]);
    if (previous) protectedIds.add(previous.batchId);
    const seenBucket = new Set<string>();
    let kept = 0;
    for (const s of group) {
      const age = now - s.savedAt;
      // Newest first, so the first save met in a bucket is its newest (a protected one included).
      const bucket = age < BANK_STOCK_KEEP_ALL_MS || age > maxAge ? null : age < BANK_STOCK_HOURLY_MS ? `h${Math.floor(s.savedAt / HOUR_MS)}` : `d${Math.floor(s.savedAt / DAY_MS)}`;
      if (protectedIds.has(s.batchId)) {
        if (bucket !== null) seenBucket.add(bucket);
        kept++;
        continue;
      }
      let keep: boolean;
      if (age < BANK_STOCK_KEEP_ALL_MS) keep = true;
      else if (bucket === null) keep = false;
      else {
        keep = !seenBucket.has(bucket);
        seenBucket.add(bucket);
      }
      if (keep && kept >= maxSaves) keep = false;
      if (keep) kept++;
      else drop.add(s.batchId);
    }
  }
  return drop;
}
export const BANK_STOCK_DEFAULT_LIMIT = 200;
/** A whole bank page fits one call (scrap.tf banks hold a few thousand items at most). */
export const BANK_STOCK_MAX_LIMIT = 2000;
export const BANK_STOCK_MAX_SEARCH_CHARS = 200;
/** bank_stock.special_key of a clean copy (the column's default). */
export const BANK_STOCK_PLAIN_KEY = '';

/** S3 notifications: per SKU and bank, at most one per this long (persisted in repo meta). */
export const BANK_STOCK_NOTIFY_DEDUP_MS = 30 * 60_000;
/** S3: at most this many "New on scrap.tf" notifications per import, then one summary. */
export const BANK_STOCK_MAX_NOTIFICATIONS = 3;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * bank_stock.special_key: '' for a clean copy, else the import's extras key (the JSON that
 * importSavedPage's specialKey writes: paint, sorted spells, sorted parts, sheen, killstreaker, name
 * tag, description tag), so painted and spelled copies stay separate rows and match across saves.
 */
export function bankStockSpecialKey(s: Partial<SpecialAttrs> | null | undefined): string {
  if (!s) return BANK_STOCK_PLAIN_KEY;
  const paint = finite(s.paint) ? s.paint : null;
  const spells = Array.isArray(s.spells) ? [...s.spells].sort() : [];
  const parts = Array.isArray(s.parts) ? [...s.parts].sort() : [];
  const sheen = finite(s.sheen) ? s.sheen : null;
  const killstreaker = finite(s.killstreaker) ? s.killstreaker : null;
  const customName = s.customName === true;
  const customDesc = s.customDesc === true;
  if (paint === null && spells.length === 0 && parts.length === 0 && sheen === null && killstreaker === null && !customName && !customDesc) {
    return BANK_STOCK_PLAIN_KEY;
  }
  return JSON.stringify([paint, spells, parts, sheen, killstreaker, customName, customDesc]);
}

/** BankStockRow.key: a row's identity within a bank and across its saves. */
export function bankStockKey(sku: string, specialKey: string): string {
  return `${sku}|${specialKey}`;
}

/** The base SKU (paint dropped) and the special key a SKU's own copy has (its paint only), or null when unparsable. */
export function bankStockTargetOf(sku: string): { base: string; specialKey: string } | null {
  try {
    const obj = fromString(sku.trim());
    const paint = finite(obj.paint) && obj.paint > 0 ? obj.paint : null;
    return { base: fromObject({ ...obj, paint: null }), specialKey: bankStockSpecialKey(paint === null ? null : { paint }) };
  } catch {
    return null;
  }
}

/**
 * On sale on that save: a price to buy, and stock not known to be 0. Cards are on sale; a "Sold out"
 * /items row (no price) or one showing 0 in stock is not. Only on-sale rows can be new, kept or gone.
 */
export function bankStockOnSale(r: Pick<BankStockStored, 'costKeys' | 'costScrap' | 'stock'> | null | undefined): boolean {
  if (!r || !finite(r.costScrap) || !finite(r.costKeys)) return false;
  return !(finite(r.stock) && r.stock <= 0);
}

// ---------------------------------------------------------------------------
// Diff (spec S2)
// ---------------------------------------------------------------------------

/** One key of a bank's newest or previous save, with its change. Raw: nothing valued, no buy side. */
export interface BankStockDiffRow {
  key: string;
  sku: string;
  specialKey: string;
  /** The newest save's row; null when only the previous save lists it (gone). */
  current: BankStockStored | null;
  /** The previous save's row; null without a previous save, or when it did not list the key. */
  previous: BankStockStored | null;
  /** The newest save has it on sale (bankStockOnSale): the 'all' chip. */
  onSale: boolean;
  change: BankStockChange;
}

/**
 * The change of an on-sale-in-both row: null when the raw keys and metal are equal, else cheaper or
 * pricier by value at `keyScrap` (so a key price move alone never reads as a change); equal value with
 * other keys goes by keys.
 */
function priceChange(cur: BankStockStored, prev: BankStockStored, keyScrap: Scrap): BankStockChange {
  const ck = cur.costKeys ?? 0;
  const cs = cur.costScrap ?? 0;
  const pk = prev.costKeys ?? 0;
  const ps = prev.costScrap ?? 0;
  if (ck === pk && cs === ps) return null;
  const d = valueScrap(ck, cs, keyScrap) - valueScrap(pk, ps, keyScrap);
  if (d !== 0) return d < 0 ? 'cheaper' : 'pricier';
  return ck < pk ? 'cheaper' : 'pricier';
}

/**
 * Compares a bank's newest save with its previous one (null: the first save, so nothing is new), by
 * SKU + special key. One entry per key of either save, newest save's order first, then gone keys:
 * new = on sale now and absent or not on sale before; gone = on sale before and absent or not on sale
 * now; cheaper / pricier = on sale in both with another raw price (priceChange); else null. Stock
 * changes (n to m) are not a change; BankStockRow.previousStock carries them.
 */
export function diffBankStock(newest: readonly BankStockStored[], previous: readonly BankStockStored[] | null, keyScrap: Scrap): BankStockDiffRow[] {
  const prevByKey = new Map<string, BankStockStored>();
  for (const p of previous ?? []) {
    const k = bankStockKey(p.sku, p.specialKey);
    if (!prevByKey.has(k)) prevByKey.set(k, p);
  }
  const out: BankStockDiffRow[] = [];
  const seen = new Set<string>();
  for (const cur of newest) {
    const key = bankStockKey(cur.sku, cur.specialKey);
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = prevByKey.get(key) ?? null;
    const onSale = bankStockOnSale(cur);
    const wasOnSale = bankStockOnSale(prev);
    let change: BankStockChange = null;
    if (previous !== null) {
      if (onSale && !wasOnSale) change = 'new';
      else if (!onSale && wasOnSale) change = 'gone';
      else if (onSale && wasOnSale && prev) change = priceChange(cur, prev, keyScrap);
    }
    out.push({ key, sku: cur.sku, specialKey: cur.specialKey, current: cur, previous: prev, onSale, change });
  }
  for (const [key, prev] of prevByKey) {
    if (seen.has(key) || !bankStockOnSale(prev)) continue;
    out.push({ key, sku: prev.sku, specialKey: prev.specialKey, current: null, previous: prev, onSale: false, change: 'gone' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pages of a bank
// ---------------------------------------------------------------------------

/** What pairing a bank's saves by page reads of each save (BankStockSave fits; a save with no page is page ''). */
export interface BankStockPageSave {
  batchId: number;
  savedAt: UnixMs;
  page?: string;
  /** Rows of the save, when known: a save known to hold none is skipped (F18 S3). */
  items?: number;
}

/** One page of a bank: its newest kept save and the one it is compared with. */
export interface BankStockPagePair<S extends BankStockPageSave> {
  page: string;
  newest: S;
  /** The page's newest kept save from strictly before `newest` (a save at its own time is it imported again); null: a first save. */
  previous: S | null;
  /**
   * The first import of the newest look: the lowest batch id among the page's saves at `newest`'s time.
   * Only that import notifies (S3): a page imported again (same file, same time) tells nothing twice.
   */
  firstBatchId: number;
  /** Kept saves of the page read (at most BANK_STOCK_KEEP_SAVES). */
  saves: number;
}

/**
 * A bank's kept saves (newest first, as Repo.bankStockSaves orders them) by page, newest page first, at
 * most BANK_STOCK_KEEP_SAVES per page and BANK_STOCK_MAX_PAGES pages. Several pages give one bank
 * (/items and /items/2, /unusuals and /unusuals/378), and a save is only compared with an earlier save
 * of its own page: two different pages would read as everything new on one and gone from the other.
 * A save known to hold no row is no look at the page (F18 S3: a page saved before scrap.tf added its
 * cards), so it is neither a page's newest save, which would read as everything gone, nor its previous.
 * importSavedPage writes no rows for such a save; this keeps the rule if a caller ever lists one.
 */
export function bankStockPagePairs<S extends BankStockPageSave>(saves: readonly S[]): BankStockPagePair<S>[] {
  const byPage = new Map<string, S[]>();
  for (const s of saves) {
    if (typeof s.items === 'number' && Number.isFinite(s.items) && s.items <= 0) continue;
    const page = typeof s.page === 'string' ? s.page : '';
    let group = byPage.get(page);
    if (!group) {
      if (byPage.size >= BANK_STOCK_MAX_PAGES) continue;
      group = [];
      byPage.set(page, group);
    }
    if (group.length < BANK_STOCK_KEEP_SAVES) group.push(s);
  }
  const out: BankStockPagePair<S>[] = [];
  for (const [page, group] of byPage) {
    const newest = group[0]!;
    let firstBatchId = newest.batchId;
    for (const s of group) if (s.savedAt === newest.savedAt && s.batchId < firstBatchId) firstBatchId = s.batchId;
    out.push({ page, newest, previous: group.find((s) => s.savedAt < newest.savedAt) ?? null, firstBatchId, saves: group.length });
  }
  return out;
}

/**
 * A bank's pages as its stock page shows them, each diffed against its own previous save (newest page
 * first). An item on several pages shows once: from the newest page whose newest save lists it, else as
 * gone from the newest page that lost it, so an item that moved to another page of the list is not
 * "gone" from the bank. Returns each page with only the diff rows it shows; one page is returned as is.
 */
export function bankStockMergePages<P extends { diff: readonly BankStockDiffRow[] }>(pages: readonly P[]): P[] {
  if (pages.length <= 1) return [...pages];
  const listedOn = new Map<string, number>();
  pages.forEach((p, i) => {
    for (const d of p.diff) if (d.current !== null && !listedOn.has(d.key)) listedOn.set(d.key, i);
  });
  const goneTaken = new Set<string>();
  return pages.map((p, i) => ({
    ...p,
    diff: p.diff.filter((d) => {
      const on = listedOn.get(d.key);
      if (on !== undefined) return on === i;
      if (goneTaken.has(d.key)) return false;
      goneTaken.add(d.key);
      return true;
    }),
  }));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** What a row reads from the Live market entry of its base SKU (MarketEval and MarketRow both fit). */
export interface BankStockBuySide {
  revenueScrap: Scrap | null;
  revenueOrder: OrderSummary | null;
  buyerCount: number;
  maxCostScrap: Scrap | null;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
}

/** F20: "Listed > 24 h" (BankStockQuery.minListedMs's default, the Live market's listedOnScraptf). */
export const SCRAPTF_LONG_LISTED_MS = DAY_MS;

/**
 * F20 ScraptfPriceChange: `from` (saved at `since`) against `to`, both raw keys + metal valued at
 * `keyScrap`, so a key price move alone changes neither side's difference sign when the raw prices are
 * equal (delta 0). pct is delta / from, null when from is 0.
 */
export function scraptfPriceChange(from: { keys: number; scrap: Scrap }, to: { keys: number; scrap: Scrap }, since: UnixMs, keyScrap: Scrap): ScraptfPriceChange {
  const same = from.keys === to.keys && from.scrap === to.scrap;
  const fromScrap = valueScrap(from.keys, from.scrap, keyScrap);
  const toScrap = same ? fromScrap : valueScrap(to.keys, to.scrap, keyScrap);
  const deltaScrap = toScrap - fromScrap;
  return { fromScrap, toScrap, deltaScrap, pct: fromScrap > 0 ? deltaScrap / fromScrap : null, since };
}

/** profitStatus of the row's profit: profitable is 'flip', no revenue 'no-buyers', anything else 'over'. */
export function bankStockVerdict(profitScrap: Scrap | null, costScrap: Scrap, p: CeilingSettings): BankStockVerdict {
  const s = profitStatus(profitScrap, costScrap, p);
  return s === 'profitable' ? 'flip' : s === 'no-buyers' ? 'no-buyers' : 'over';
}

/**
 * A diff entry as a BankStockRow, valued at `keyScrap` and joined to its buy side (null: no eligible
 * buyer). Null for an entry the page does not show: not on sale now and not gone (sold out in both).
 * A gone row shows its last price (the previous save's) and the newest save's stock (0 when still listed).
 * F20: `run` (the runs index's entry for this key in this bank, ScraptfHistory.runsFor) fills listedSince,
 * firstSeenAt and changeSinceListed; without it they are null. A gone row has no current run.
 */
export function bankStockRow(
  d: BankStockDiffRow,
  a: { category: Category; buy: BankStockBuySide | null; keyScrap: Scrap; profit: CeilingSettings; run?: ScraptfKeyRun | null },
): BankStockRow | null {
  const shown = d.change === 'gone' ? d.previous : d.onSale ? d.current : null;
  if (!shown || !finite(shown.costScrap)) return null;
  const costKeys = finite(shown.costKeys) ? shown.costKeys : 0;
  const costScrapRaw = shown.costScrap;
  const costScrap = valueScrap(costKeys, costScrapRaw, a.keyScrap);
  const prev = d.previous;
  const previousCostScrap = prev && finite(prev.costScrap) ? valueScrap(finite(prev.costKeys) ? prev.costKeys : 0, prev.costScrap, a.keyScrap) : null;
  const buy = a.buy;
  const revenueScrap = buy && finite(buy.revenueScrap) ? buy.revenueScrap : null;
  const profitScrap = revenueScrap === null ? null : revenueScrap - costScrap - frictionOf(a.profit);
  const run = a.run ?? null;
  const listedSince = d.change !== 'gone' && run && finite(run.listedSince) ? run.listedSince : null;
  return {
    sku: d.sku,
    key: d.key,
    name: (d.current?.name || prev?.name || d.sku).trim() || d.sku,
    category: a.category,
    hasExtras: d.specialKey !== BANK_STOCK_PLAIN_KEY,
    costKeys,
    costScrapRaw,
    costScrap,
    stock: d.current ? (finite(d.current.stock) ? d.current.stock : null) : null,
    change: d.change,
    previousCostScrap,
    previousStock: prev && finite(prev.stock) ? prev.stock : null,
    revenueScrap,
    revenueOrder: buy?.revenueOrder ?? null,
    buyerCount: buy && finite(buy.buyerCount) ? buy.buyerCount : 0,
    maxCostScrap: buy && finite(buy.maxCostScrap) ? buy.maxCostScrap : null,
    profitScrap,
    margin: profitScrap !== null && costScrap > 0 ? profitScrap / costScrap : null,
    verdict: bankStockVerdict(profitScrap, costScrap, a.profit),
    confidence: buy && finite(buy.confidence) ? buy.confidence : null,
    confidenceLevel: buy?.confidenceLevel ?? null,
    listedSince,
    firstSeenAt: run && finite(run.firstSeenAt) ? run.firstSeenAt : null,
    changeSinceListed:
      listedSince !== null && run?.runStart ? scraptfPriceChange(run.runStart, { keys: costKeys, scrap: costScrapRaw }, listedSince, a.keyScrap) : null,
  };
}

/** Every row a bank's page can show (bankStockRow over diffBankStock), in diff order. `runOf` (F20) is optional. */
export function bankStockRows(a: {
  newest: readonly BankStockStored[];
  previous: readonly BankStockStored[] | null;
  keyScrap: Scrap;
  profit: CeilingSettings;
  categoryOf(sku: string): Category;
  buySideOf(sku: string): BankStockBuySide | null;
  runOf?(key: string): ScraptfKeyRun | null;
}): BankStockRow[] {
  const out: BankStockRow[] = [];
  for (const d of diffBankStock(a.newest, a.previous, a.keyScrap)) {
    const row = bankStockRow(d, { category: a.categoryOf(d.sku), buy: a.buySideOf(d.sku), keyScrap: a.keyScrap, profit: a.profit, run: a.runOf?.(d.key) ?? null });
    if (row) out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query: filter, search, order, page, counts
// ---------------------------------------------------------------------------

export function bankStockFilterOf(q: Pick<BankStockQuery, 'filter'>): BankStockFilter {
  return q.filter !== undefined && BANK_STOCK_FILTERS.includes(q.filter) ? q.filter : 'all';
}

/** BankStockQuery.minListedMs as the service clamps it: a finite value of 0 or more, else 24 h. */
export function bankStockMinListedMs(q: Pick<BankStockQuery, 'minListedMs'> | null | undefined): number {
  const v = q?.minListedMs;
  return finite(v) && v >= 0 ? v : SCRAPTF_LONG_LISTED_MS;
}

/** F20 'long-listed': on sale (not gone) and listed since at least `minListedMs` before `now`. */
export function bankStockLongListed(r: Pick<BankStockRow, 'change' | 'listedSince'>, now: UnixMs, minListedMs: number = SCRAPTF_LONG_LISTED_MS): boolean {
  return r.change !== 'gone' && finite(r.listedSince) && finite(now) && now - r.listedSince >= minListedMs;
}

/** F20 'dropped': on sale (not gone) and cheaper now than when its current run began. */
export function bankStockDropped(r: Pick<BankStockRow, 'change' | 'changeSinceListed'>): boolean {
  return r.change !== 'gone' && r.changeSinceListed !== null && finite(r.changeSinceListed.deltaScrap) && r.changeSinceListed.deltaScrap < 0;
}

/**
 * The filter chips: All (in stock), New, Flips, Price changes, Gone, and from F20 Listed > 24 h and
 * Dropped since listed (both need `now`: without it 'long-listed' matches nothing). Gone rows show
 * under 'gone' only.
 */
export function bankStockFilterMatches(
  r: Pick<BankStockRow, 'change' | 'verdict' | 'listedSince' | 'changeSinceListed'>,
  filter: BankStockFilter,
  opts: { now?: UnixMs; minListedMs?: number } = {},
): boolean {
  switch (filter) {
    case 'gone':
      return r.change === 'gone';
    case 'new':
      return r.change === 'new';
    case 'flips':
      return r.change !== 'gone' && r.verdict === 'flip';
    case 'changed':
      return r.change === 'cheaper' || r.change === 'pricier';
    case 'long-listed':
      return opts.now !== undefined && bankStockLongListed(r, opts.now, opts.minListedMs ?? SCRAPTF_LONG_LISTED_MS);
    case 'dropped':
      return bankStockDropped(r);
    case 'all':
      return r.change !== 'gone';
  }
}

/** Every word in the name or the SKU (marketSearchTokens: lower-cased, capped). */
export function bankStockSearchMatches(r: Pick<BankStockRow, 'name' | 'sku'>, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = `${r.name} ${r.sku}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * Default direction per sort: name and cost ascending (A to Z, cheapest first), sinceListed ascending
 * (the biggest drop first), the rest descending ('listed': listed longest first).
 */
export function bankStockDefaultDir(sort: BankStockSort): 'asc' | 'desc' {
  return sort === 'name' || sort === 'cost' || sort === 'sinceListed' ? 'asc' : 'desc';
}

function sortValue(r: BankStockRow, sort: Exclude<BankStockSort, 'name'>): number | null {
  switch (sort) {
    case 'profit':
      return finite(r.profitScrap) ? r.profitScrap : null;
    case 'margin':
      return finite(r.margin) ? r.margin : null;
    case 'cost':
      return finite(r.costScrap) ? r.costScrap : null;
    case 'payUpTo':
      return finite(r.maxCostScrap) ? r.maxCostScrap : null;
    case 'listed':
      // Time listed without `now`: an earlier start is a longer listing, so it sorts higher.
      return finite(r.listedSince) ? -r.listedSince : null;
    case 'sinceListed': {
      const c = r.changeSinceListed;
      if (!c) return null;
      return finite(c.pct) ? c.pct : c.deltaScrap === 0 ? 0 : null;
    }
  }
}

/**
 * Comparator for q.sort / q.dir (default profit, highest first). Missing values sort last in both
 * directions; ties go by name, then key, so paging is stable.
 */
export function bankStockComparator(sort: BankStockSort | undefined, dir: 'asc' | 'desc' | undefined): (a: BankStockRow, b: BankStockRow) => number {
  const key: BankStockSort = sort !== undefined && BANK_STOCK_SORTS.includes(sort) ? sort : 'profit';
  const sign = (dir ?? bankStockDefaultDir(key)) === 'asc' ? 1 : -1;
  const byName = (a: BankStockRow, b: BankStockRow): number => a.name.localeCompare(b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  if (key === 'name') return (a, b) => sign * byName(a, b);
  return (a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
      return byName(a, b);
    }
    return sign * (va - vb) || byName(a, b);
  };
}

/** Paging as the service clamps it: limit 1..BANK_STOCK_MAX_LIMIT (default 200), offset >= 0. */
export function bankStockPage(q: Pick<BankStockQuery, 'limit' | 'offset'>): { limit: number; offset: number } {
  const limit = finite(q.limit) ? Math.min(BANK_STOCK_MAX_LIMIT, Math.max(1, Math.floor(q.limit))) : BANK_STOCK_DEFAULT_LIMIT;
  const offset = finite(q.offset) ? Math.max(0, Math.floor(q.offset)) : 0;
  return { limit, offset };
}

/**
 * Every row matching q's filter and search, in q's order (paging ignored: the CSV export). `now` (F20)
 * decides 'long-listed'; without it that filter matches nothing.
 */
export function bankStockMatching(rows: readonly BankStockRow[], q: Omit<BankStockQuery, 'bank'>, now?: UnixMs): BankStockRow[] {
  const filter = bankStockFilterOf(q);
  const tokens = marketSearchTokens(q.search);
  const opts = { ...(now !== undefined ? { now } : {}), minListedMs: bankStockMinListedMs(q) };
  return rows.filter((r) => bankStockFilterMatches(r, filter, opts) && bankStockSearchMatches(r, tokens)).sort(bankStockComparator(q.sort, q.dir));
}

export function emptyBankStockCounts(): BankStockCounts {
  return { items: 0, inStock: 0, new: 0, gone: 0, cheaper: 0, pricier: 0, flips: 0, newFlips: 0, longListed: 0, dropped: 0 };
}

/**
 * Each chip's count over every row the bank shows, whatever the filter and search; `items` from the newest
 * save. F20's longListed needs `opts.now` (0 without it).
 */
export function bankStockCounts(rows: readonly BankStockRow[], items: number, opts: { now?: UnixMs; minListedMs?: number } = {}): BankStockCounts {
  const c = emptyBankStockCounts();
  c.items = finite(items) && items > 0 ? Math.floor(items) : 0;
  const minListed = finite(opts.minListedMs) && opts.minListedMs >= 0 ? opts.minListedMs : SCRAPTF_LONG_LISTED_MS;
  for (const r of rows) {
    if (r.change === 'gone') {
      c.gone++;
      continue;
    }
    c.inStock++;
    if (r.change === 'new') c.new++;
    else if (r.change === 'cheaper') c.cheaper++;
    else if (r.change === 'pricier') c.pricier++;
    if (r.verdict === 'flip') {
      c.flips++;
      if (r.change === 'new') c.newFlips++;
    }
    if (opts.now !== undefined && bankStockLongListed(r, opts.now, minListed)) c.longListed++;
    if (bankStockDropped(r)) c.dropped++;
  }
  return c;
}

/** ScraptfBankSummary.whatsNew: the change counts since the previous save; null with fewer than 2 saves. */
export function bankStockWhatsNew(counts: BankStockCounts, previousSavedAt: UnixMs | null): ScraptfBankWhatsNew | null {
  if (previousSavedAt === null || !finite(previousSavedAt)) return null;
  return { new: counts.new, newFlips: counts.newFlips, gone: counts.gone, cheaper: counts.cheaper, pricier: counts.pricier, since: previousSavedAt };
}

/** A whole 'scraptf.bankStock' answer from every row the bank shows (bankStockRows) and its saves. */
export function bankStockResult(a: {
  q: BankStockQuery;
  rows: readonly BankStockRow[];
  /** Rows on the newest save (BankStockSave.items). */
  items: number;
  savedAt: UnixMs | null;
  previousSavedAt: UnixMs | null;
  saves: number;
  /** Pages the rows come from and the oldest of their newest saves; left out of the answer with one page. */
  pages?: { count: number; oldestSavedAt: UnixMs | null };
  keyPrice: KeyPriceState | null;
  now: UnixMs;
}): BankStockResult {
  const info = scraptfBankInfo(a.q.bank);
  const matched = bankStockMatching(a.rows, a.q, a.now);
  const { limit, offset } = bankStockPage(a.q);
  return {
    bank: a.q.bank,
    label: info?.label ?? a.q.bank,
    url: info?.url ?? '',
    savedAt: a.savedAt,
    previousSavedAt: a.previousSavedAt,
    saves: a.saves,
    ...(a.pages && a.pages.count > 1 ? { pages: a.pages.count, oldestSavedAt: a.pages.oldestSavedAt } : {}),
    counts: bankStockCounts(a.rows, a.items, { now: a.now, minListedMs: bankStockMinListedMs(a.q) }),
    rows: matched.slice(offset, offset + limit),
    total: matched.length,
    keyPrice: a.keyPrice,
    generatedAt: a.now,
  };
}

/** A bank with no kept save ('scraptf.bankStock' for a never-saved or pruned bank). */
export function emptyBankStockResult(bank: ScraptfBank, keyPrice: KeyPriceState | null, now: UnixMs): BankStockResult {
  return bankStockResult({ q: { bank }, rows: [], items: 0, savedAt: null, previousSavedAt: null, saves: 0, keyPrice, now });
}

// ---------------------------------------------------------------------------
// Market and item detail joins (spec S4)
// ---------------------------------------------------------------------------

/**
 * One page of a bank, its newest save diffed against its previous one (what the service caches per page;
 * the mock's banks have one page each). `savedAt` is that page's newest save.
 */
export interface BankStockBankDiff {
  bank: ScraptfBank;
  savedAt: UnixMs;
  previousSavedAt: UnixMs | null;
  diff: readonly BankStockDiffRow[];
}

/** MarketRow.scraptfNewAt per base SKU: the newest save of a bank in which any copy of it is 'new'. */
export function bankStockNewAt(banks: readonly BankStockBankDiff[]): Map<string, UnixMs> {
  const out = new Map<string, UnixMs>();
  for (const b of banks) {
    for (const d of b.diff) {
      if (d.change !== 'new') continue;
      const cur = out.get(d.sku);
      if (cur === undefined || b.savedAt > cur) out.set(d.sku, b.savedAt);
    }
  }
  return out;
}

/** MarketQuery.newOnScraptf: only rows new on scrap.tf (MarketRow.scraptfNewAt not null). */
export function marketNewSideMatches(r: { scraptfNewAt: UnixMs | null }, q: { newOnScraptf?: boolean }): boolean {
  return q.newOnScraptf !== true || finite(r.scraptfNewAt);
}

/**
 * ItemDetail.bankStock for a SKU (its base and its own paint as the special key): from the newest save
 * that lists that copy, among each bank's newest save. A copy gone from a bank's newest save counts
 * there as 'gone' (stock null). Ties prefer a copy on sale, then one listed sold out, then a gone one.
 */
export function bankStockItemOf(banks: readonly BankStockBankDiff[], sku: string, keyScrap: Scrap): ItemBankStock | null {
  const target = bankStockTargetOf(sku);
  if (!target) return null;
  const key = bankStockKey(target.base, target.specialKey);
  const rank = (d: BankStockDiffRow): number => (d.onSale ? 2 : d.current ? 1 : 0);
  let best: { b: BankStockBankDiff; d: BankStockDiffRow } | null = null;
  for (const b of banks) {
    const d = b.diff.find((x) => x.key === key);
    if (!d || (d.current === null && d.change !== 'gone')) continue;
    if (!best || b.savedAt > best.b.savedAt || (b.savedAt === best.b.savedAt && rank(d) > rank(best.d))) best = { b, d };
  }
  if (!best) return null;
  const prev = best.d.previous;
  return {
    bank: best.b.bank,
    savedAt: best.b.savedAt,
    change: best.d.change,
    previousCostScrap: prev && finite(prev.costScrap) ? valueScrap(finite(prev.costKeys) ? prev.costKeys : 0, prev.costScrap, keyScrap) : null,
    stock: best.d.current && finite(best.d.current.stock) ? best.d.current.stock : null,
  };
}

// ---------------------------------------------------------------------------
// Notifications (spec S3) and CSV
// ---------------------------------------------------------------------------

/** A page path as the UI writes it: "scrap.tf/buy/hats". */
export function bankStockPagePath(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** "New on scrap.tf (<Bank>): <name>" / "<cost>, sells for <revenue> to <buyer>, +<profit>". */
export function bankStockNewFlipNotice(label: string, r: BankStockRow, keyScrap: Scrap | null): { title: string; body: string } {
  const key = finite(keyScrap) && keyScrap > 0 ? keyScrap : null;
  const o = r.revenueOrder;
  const buyer = o ? o.userName || o.steamid : 'a buyer';
  return {
    title: `New on scrap.tf (${label}): ${r.name}`,
    body: `${formatScrap(r.costScrap, key)}, sells for ${formatScrap(r.revenueScrap, key)} to ${buyer}, +${formatScrap(r.profitScrap, key)}`,
  };
}

/** The one summary after BANK_STOCK_MAX_NOTIFICATIONS: "+N more new flips on scrap.tf/buy/hats". */
export function bankStockMoreNotice(more: number, url: string): string {
  return `+${more} more new flip${more === 1 ? '' : 's'} on ${bankStockPagePath(url)}`;
}

export const BANK_STOCK_CSV_COLUMNS: readonly string[] = [
  'sku',
  'name',
  'category',
  'extras',
  'change',
  'scraptf_price',
  'previous_price',
  'stock',
  'previous_stock',
  'sells_for',
  'buyer',
  'buyers',
  'pay_up_to',
  'profit',
  'margin',
  'verdict',
  'confidence',
];

/** One CSV line's cells, in BANK_STOCK_CSV_COLUMNS order; money as keys + ref, missing values blank. */
export function bankStockCsvCells(r: BankStockRow, keyScrap: Scrap | null): (string | number | null)[] {
  const key = finite(keyScrap) && keyScrap > 0 ? keyScrap : null;
  const money = (v: Scrap | null): string => (finite(v) ? formatScrap(v, key) : '');
  const o = r.revenueOrder;
  return [
    r.sku,
    r.name,
    r.category,
    r.hasExtras ? 'yes' : '',
    r.change ?? '',
    money(r.costScrap),
    money(r.previousCostScrap),
    finite(r.stock) ? r.stock : null,
    finite(r.previousStock) ? r.previousStock : null,
    money(r.revenueScrap),
    o ? `${o.userName || o.steamid} (${o.isBot ? 'bot' : 'human'})` : '',
    r.buyerCount,
    money(r.maxCostScrap),
    money(r.profitScrap),
    finite(r.margin) ? Number(r.margin.toFixed(4)) : null,
    r.verdict,
    finite(r.confidence) ? r.confidence : null,
  ];
}
