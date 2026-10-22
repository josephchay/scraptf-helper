// Live market (F10) rules shared by the service's market index, the browser
// mock and the dashboard, so all three give a row the same verdict, the same
// filters, the same order and the same CSV cells (like ceiling.ts for F1).
// Pure: no I/O, no network. The scrap.tf side of a row is only ever what the
// user typed or saved (R10); nothing here fetches it.

import { formatScrap } from './currency';
import { flipProfit, type ExitCostSettings } from './ceiling';
import { liquidityTagOf } from './exitRisk';
import { SCRAPTF_BANK_PAGES, isScraptfBank } from './links';
import type {
  BankNewestSave,
  Category,
  CategoryCounts,
  ImportBatch,
  MarketQuery,
  MarketRow,
  MarketSort,
  MarketVerdict,
  Scrap,
  ScraptfBank,
  ScraptfCoverage,
  UnixMs,
} from './types';
import { CATEGORIES, MARKET_VERDICTS } from './types';

export const MARKET_DEFAULT_LIMIT = 200;
/** The dashboard's whole loaded window (≤ 2000 rows) fits one call, so a live refresh is one consistent read (H2). */
export const MARKET_MAX_LIMIT = 2000;
export const MARKET_MAX_SEARCH_CHARS = 200;
/** Search words past this many are ignored (a pasted paragraph must not cost a scan per word). */
const MAX_SEARCH_TOKENS = 20;

/** The Sort select's order. 0.9 (#3): 'backup' and 'depth' after 'profit' (ranking, Wave 2, fills their values). */
export const MARKET_SORTS: readonly MarketSort[] = ['ceiling', 'revenue', 'buyers', 'profit', 'backup', 'depth', 'updated', 'name', 'seen'];

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The verdict for one row (see MarketVerdict). `buyerCount` counts eligible buyers only.
 * A known cost always wins over a rule estimate: the rule is a guess, the known cost is not.
 */
export function marketVerdict(r: { buyerCount: number; maxCostScrap: Scrap | null; knownCostScrap: Scrap | null; ruleCostScrap: Scrap | null }): MarketVerdict {
  const buyers = finite(r.buyerCount) && r.buyerCount > 0;
  const ceiling = finite(r.maxCostScrap) ? r.maxCostScrap : null;
  if (finite(r.knownCostScrap)) {
    if (!buyers) return 'no-buyers';
    return ceiling !== null && r.knownCostScrap <= ceiling ? 'flip' : 'over';
  }
  if (buyers && ceiling !== null && finite(r.ruleCostScrap) && r.ruleCostScrap <= ceiling) return 'rule-flip';
  return 'unchecked';
}

/** flipProfit (friction and the price-move reserve, 0.8), when both exist. */
export function marketProfit(revenueScrap: Scrap | null, knownCostScrap: Scrap | null, p: ExitCostSettings): Scrap | null {
  return flipProfit(revenueScrap, knownCostScrap, p);
}

/**
 * 0.9 (#3): the cost a row's risk keys are judged at: your price, else a rule flip's estimate (the verdict's own cost),
 * else null. The service's select() and toRow() and the mock all call it, so the sort and the shown values agree.
 */
export function marketRiskCost(r: Pick<MarketRow, 'knownCostScrap' | 'ruleCostScrap' | 'verdict'>): Scrap | null {
  if (finite(r.knownCostScrap)) return r.knownCostScrap;
  return r.verdict === 'rule-flip' && finite(r.ruleCostScrap) ? r.ruleCostScrap : null;
}

export function emptyMarketCounts(): Record<MarketVerdict, number> {
  const out = {} as Record<MarketVerdict, number>;
  for (const v of MARKET_VERDICTS) out[v] = 0;
  return out;
}

/** What the Updated column and the 'updated' sort use: the newer of the last order change and the user's own price. */
export function marketUpdatedAt(r: Pick<MarketRow, 'lastOrderChangeAt' | 'knownObservedAt'>): UnixMs | null {
  const a = finite(r.lastOrderChangeAt) ? r.lastOrderChangeAt : null;
  const b = finite(r.knownObservedAt) ? r.knownObservedAt : null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Paging as the service clamps it: limit 1..MARKET_MAX_LIMIT (default 200), offset >= 0. */
export function marketPage(q: Pick<MarketQuery, 'limit' | 'offset'>): { limit: number; offset: number } {
  const limit = finite(q.limit) ? Math.min(MARKET_MAX_LIMIT, Math.max(1, Math.floor(q.limit))) : MARKET_DEFAULT_LIMIT;
  const offset = finite(q.offset) ? Math.max(0, Math.floor(q.offset)) : 0;
  return { limit, offset };
}

/** Lower-cased search words, capped; empty when there is nothing to search for. */
export function marketSearchTokens(search: string | undefined): string[] {
  if (typeof search !== 'string') return [];
  return search.slice(0, MARKET_MAX_SEARCH_CHARS).toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS);
}

type BuySide = Pick<MarketRow, 'sku' | 'name' | 'category' | 'maxCostScrap' | 'buyerCount' | 'revenueOrder'>;
type UserSide = Pick<MarketRow, 'knownSource' | 'verdict'>;

/**
 * The filters that need only the backpack.tf side (search, category, ceiling, bot buyers, buyers).
 * `tokens` from marketSearchTokens, computed once per query.
 */
export function marketBuySideMatches(r: BuySide, q: MarketQuery, tokens: readonly string[]): boolean {
  if (q.categories?.length && !q.categories.includes(r.category)) return false;
  if (finite(q.minCeilingScrap) && q.minCeilingScrap > 0 && !(finite(r.maxCostScrap) && r.maxCostScrap >= q.minCeilingScrap)) return false;
  if (q.onlyBotBuyers === true && r.revenueOrder?.isBot !== true) return false;
  if (finite(q.minBuyers) && q.minBuyers > 0 && r.buyerCount < q.minBuyers) return false;
  if (tokens.length > 0) {
    const hay = `${r.name} ${r.sku}`.toLowerCase();
    for (const t of tokens) if (!hay.includes(t)) return false;
  }
  return true;
}

/** The filters on the user's side (source, and verdict unless the counts are being taken). */
export function marketUserSideMatches(r: UserSide, q: MarketQuery, ignoreVerdicts = false): boolean {
  if (q.sources?.length && !q.sources.includes(r.knownSource)) return false;
  if (!ignoreVerdicts && q.verdicts?.length && !q.verdicts.includes(r.verdict)) return false;
  return true;
}

export function marketRowMatches(r: BuySide & UserSide, q: MarketQuery, tokens: readonly string[] = marketSearchTokens(q.search)): boolean {
  return marketUserSideMatches(r, q) && marketBuySideMatches(r, q, tokens);
}

type SortSide = Pick<
  MarketRow,
  'sku' | 'name' | 'maxCostScrap' | 'revenueScrap' | 'buyerCount' | 'profitScrap' | 'backupProfitScrap' | 'profitableDepth' | 'lastOrderChangeAt' | 'knownObservedAt'
>;

function sortValue(r: SortSide, sort: Exclude<MarketSort, 'name'>): number | null {
  switch (sort) {
    case 'ceiling':
      return finite(r.maxCostScrap) ? r.maxCostScrap : null;
    case 'revenue':
      return finite(r.revenueScrap) ? r.revenueScrap : null;
    case 'buyers':
      return finite(r.buyerCount) ? r.buyerCount : null;
    case 'profit':
      return finite(r.profitScrap) ? r.profitScrap : null;
    // 0.9 (#3): absent or null (no book, no price to judge, a row before ranking fills it) sorts last.
    case 'backup':
      return finite(r.backupProfitScrap) ? r.backupProfitScrap : null;
    case 'depth':
      return finite(r.profitableDepth) ? r.profitableDepth : null;
    case 'updated':
      return marketUpdatedAt(r);
    case 'seen':
      return finite(r.knownObservedAt) ? r.knownObservedAt : null;
  }
}

/**
 * The 'seen' sort's tie-break (0.7.1): rows seen on the same save go most profit first, missing profit
 * last, whatever the direction (like the name tie-break). Shared with the market index so both agree.
 */
export function marketProfitTie(a: Scrap | null, b: Scrap | null): number {
  const pa = finite(a) ? a : null;
  const pb = finite(b) ? b : null;
  if (pa === null || pb === null) return pa === pb ? 0 : pa === null ? 1 : -1;
  return pb - pa;
}

/**
 * The sorts whose ties go by profit (marketProfitTie) before the name: 'seen' (0.7.1) and the 0.9 (#3) risk keys
 * 'backup' and 'depth', whose few distinct values (0-3 buyers) tie often; Opportunities ties those by profit too.
 * Shared with the market index so both agree.
 */
export function marketProfitTiesFirst(key: MarketSort): boolean {
  return key === 'seen' || key === 'backup' || key === 'depth';
}

/**
 * Comparator for q.sort / q.dir (default: ceiling, descending; name defaults to ascending).
 * Missing values sort last in both directions; ties go by name, then SKU, so paging is stable.
 * 'seen' ties go by profit first (marketProfitTie), then by name; so do the 0.9 risk keys 'backup' and 'depth'
 * (marketProfitTiesFirst), as the repo's OPP_SORT and the renderer's compareOpps.
 */
export function marketComparator(sort: MarketSort | undefined, dir: 'asc' | 'desc' | undefined): (a: SortSide, b: SortSide) => number {
  const key: MarketSort = sort && MARKET_SORTS.includes(sort) ? sort : 'ceiling';
  const sign = (dir ?? (key === 'name' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
  const byName = (a: SortSide, b: SortSide): number => a.name.localeCompare(b.name) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  if (key === 'name') return (a, b) => sign * byName(a, b);
  const tie = marketProfitTiesFirst(key) ? (a: SortSide, b: SortSide): number => marketProfitTie(a.profitScrap, b.profitScrap) || byName(a, b) : byName;
  return (a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
      return tie(a, b);
    }
    return sign * (va - vb) || tie(a, b);
  };
}

export const MARKET_CSV_COLUMNS: readonly string[] = [
  'sku',
  'name',
  'category',
  'verdict',
  'sells_for',
  'buyer',
  'buyers',
  'pay_up_to',
  'your_price',
  'source',
  'stock',
  'rule_price',
  'profit',
  'confidence',
  'updated',
  // F14, appended so existing spreadsheets keep their columns: the saved scrap.tf/items list as of its save.
  'scraptf_pays',
  'scraptf_stock',
  'scraptf_limit',
  'scraptf_list_saved',
  // 0.9 (#3): the risk keys at your price (else a rule flip's estimate), the book depth and its tag (D10).
  'backup_profit',
  'profitable_depth',
  'book_depth',
  'book_depth_tag',
];

/**
 * One CSV line's cells, in MARKET_CSV_COLUMNS order. Money as scrap.tf shows it (keys + ref),
 * since that is what the user compares against while browsing; missing values are blank.
 */
export function marketCsvCells(r: MarketRow, keyScrap: Scrap | null): (string | number | null)[] {
  const key = finite(keyScrap) && keyScrap > 0 ? keyScrap : null;
  const money = (v: Scrap | null): string => (finite(v) ? formatScrap(v, key) : '');
  const o = r.revenueOrder;
  const updated = marketUpdatedAt(r);
  return [
    r.sku,
    r.name,
    r.category,
    r.verdict,
    money(r.revenueScrap),
    o ? `${o.userName || o.steamid} (${o.isBot ? 'bot' : 'human'})` : '',
    r.buyerCount,
    money(r.maxCostScrap),
    money(r.knownCostScrap),
    r.knownSource === 'none' ? '' : r.knownSource,
    finite(r.stock) ? r.stock : null,
    money(r.ruleCostScrap),
    money(r.profitScrap),
    r.confidence,
    updated === null ? '' : new Date(updated).toISOString(),
    money(r.scraptfPaysScrap),
    finite(r.scraptfStock) ? r.scraptfStock : null,
    finite(r.scraptfStockLimit) ? r.scraptfStockLimit : null,
    finite(r.scraptfListAt) ? new Date(r.scraptfListAt).toISOString() : '',
    money(finite(r.backupProfitScrap) ? r.backupProfitScrap : null),
    finite(r.profitableDepth) ? r.profitableDepth : null,
    finite(r.bookDepth) ? r.bookDepth : null,
    liquidityTagOf(r.bookDepth) ?? '',
  ];
}

// ---------------------------------------------------------------------------
// scrap.tf saved-page coverage (F13): which bank pages the user saved, and when
// ---------------------------------------------------------------------------

/** A saved page's own time: the file's mtime when known, else when it was imported. */
export function batchSavedAt(b: Pick<ImportBatch, 'fileMtime' | 'importedAt'>): UnixMs {
  return finite(b.fileMtime) && b.fileMtime > 0 ? b.fileMtime : b.importedAt;
}

/** Items per category from untrusted data (a JSON column): known categories, whole counts of 1 or more; null when none. */
export function cleanCategoryCounts(v: unknown): CategoryCounts | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out: CategoryCounts = {};
  let any = false;
  for (const c of CATEGORIES) {
    const n = src[c];
    if (finite(n) && n >= 1) {
      out[c] = Math.floor(n);
      any = true;
    }
  }
  return any ? out : null;
}

/** One category per item, counted (ImportBatch.categories). */
export function countCategories(categories: readonly Category[]): CategoryCounts {
  const out: CategoryCounts = {};
  for (const c of categories) out[c] = (out[c] ?? 0) + 1;
  return out;
}

function isCategoryList(v: readonly Category[] | CategoryCounts): v is readonly Category[] {
  return Array.isArray(v);
}

/**
 * Index into SCRAPTF_BANK_PAGES of the page a saved page counts for: the one holding at least half
 * of its items (most items wins; an even split goes to the earlier page in strip order), or -1.
 * The items are one category each, or counted per category. An /items list page counts for no
 * bank page; neither does a page with no stored items.
 */
export function bankPageIndexOf(pageKind: ImportBatch['pageKind'], categories: readonly Category[] | CategoryCounts): number {
  if (pageKind === 'items-list') return -1;
  const counts = isCategoryList(categories) ? countCategories(categories) : (cleanCategoryCounts(categories) ?? {});
  let total = 0;
  for (const c of CATEGORIES) total += counts[c] ?? 0;
  if (total === 0) return -1;
  let best = -1;
  let bestCount = 0;
  SCRAPTF_BANK_PAGES.forEach((page, i) => {
    let n = 0;
    for (const c of new Set(page.categories)) n += counts[c] ?? 0;
    if (n > bestCount) {
      best = i;
      bestCount = n;
    }
  });
  return best >= 0 && bestCount * 2 >= total ? best : -1;
}

/** A saved page as the coverage rules read it; `bank` is optional so a pre-0.5 shape still classifies. */
export type CoverageBatch = Pick<ImportBatch, 'id' | 'pageKind' | 'fileMtime' | 'importedAt' | 'itemCount' | 'categories'> & Partial<Pick<ImportBatch, 'bank'>>;

/**
 * The scrap.tf page a saved page (import batch) counts for (F15). The bank the parser recognised and
 * recorded at import (ImportBatch.bank) decides, whatever the page held: it is fixed then, while a
 * later import re-tags the rows the page shares. Only a batch without one (imported before 0.5, or a
 * page the parser did not recognise) falls back: an /items list page is the list, any other page the
 * F13 majority rule over the categories it stored (bankPageIndexOf), or, for a batch from before 0.3,
 * over the rows carrying its id today (`categoriesOf`, asked only then). null: no page.
 */
export function batchBankOf(b: Pick<CoverageBatch, 'id' | 'pageKind' | 'categories' | 'bank'>, categoriesOf: (batchId: number) => readonly Category[]): ScraptfBank | null {
  if (isScraptfBank(b.bank)) return b.bank;
  if (b.pageKind === 'items-list') return 'list';
  const i = bankPageIndexOf(b.pageKind, cleanCategoryCounts(b.categories) ?? categoriesOf(b.id));
  return i < 0 ? null : (SCRAPTF_BANK_PAGES[i]?.bank ?? null);
}

/** A bank's newest saved page (scraptfBankSaves). */
export interface BankSave {
  /** batchSavedAt of that page. */
  at: UnixMs;
  /** Its import batch id. */
  id: number;
  /** Its ImportBatch.itemCount (items stored from it). */
  items: number;
}

/**
 * F18 S3: a save of a bank page (not the /items list) that stored no item. It was saved before
 * scrap.tf added its cards ("HTML only" keeps the page as it first loaded: the import warns
 * 'no-cards-saved'), so it must not date its bank "fresh, 0 items" over the save whose prices are
 * still in use. The list counts with nothing stored: a list of sold-out rows was saved. A missing or
 * unreadable count is not a known 0.
 */
export function isEmptyBankSave(b: Pick<CoverageBatch, 'itemCount'>, bank: ScraptfBank): boolean {
  return bank !== 'list' && finite(b.itemCount) && b.itemCount <= 0;
}

/**
 * Every batch's bank (batchBankOf; a batch counting for none is absent) and each bank's newest saved
 * page (batchSavedAt, ties to the higher id). Shared by the coverage strip, the service's banks summary
 * and the mock, so all three date a bank alike. The list counts even when it stored nothing (every row
 * sold out); a bank page that stored nothing keeps its bank in `bankOf` but is never `newest`
 * (isEmptyBankSave, F18 S3).
 */
export function scraptfBankSaves(
  batches: readonly CoverageBatch[],
  categoriesOf: (batchId: number) => readonly Category[],
): { bankOf: Map<number, ScraptfBank>; newest: Map<ScraptfBank, BankSave> } {
  const bankOf = new Map<number, ScraptfBank>();
  const newest = new Map<ScraptfBank, BankSave>();
  for (const b of batches) {
    const bank = batchBankOf(b, categoriesOf);
    if (bank === null) continue;
    bankOf.set(b.id, bank);
    if (isEmptyBankSave(b, bank)) continue;
    const at = batchSavedAt(b);
    const cur = newest.get(bank);
    if (!cur || at > cur.at || (at === cur.at && b.id > cur.id)) newest.set(bank, { at, id: b.id, items: finite(b.itemCount) ? b.itemCount : 0 });
  }
  return { bankOf, newest };
}

/**
 * 0.7.1 (DM-7, CQ-3): each bank's newest save over every batch (Repo.bankNewestSaves) folded into
 * scraptfBankSaves' `newest`, the newer winning (ties to the higher id), so a bank saved before the newest
 * COVERAGE_BATCHES batches is still dated, alike on the coverage strip and the banks cards. The batches
 * read stay the only source for pre-0.5 batches without a recorded bank. Returns a new map.
 */
export function mergeBankNewestSaves(
  newest: ReadonlyMap<ScraptfBank, BankSave>,
  extra: readonly Pick<BankNewestSave, 'bank' | 'batchId' | 'savedAt' | 'itemCount'>[] | null | undefined,
): Map<ScraptfBank, BankSave> {
  const out = new Map(newest);
  for (const s of extra ?? []) {
    if (!isScraptfBank(s.bank) || !finite(s.savedAt) || !finite(s.batchId)) continue;
    // As scraptfBankSaves: a bank page that stored nothing is no save (the repo skips it already).
    if (isEmptyBankSave({ itemCount: s.itemCount }, s.bank)) continue;
    const cur = out.get(s.bank);
    if (!cur || s.savedAt > cur.at || (s.savedAt === cur.at && s.batchId > cur.id)) out.set(s.bank, { at: s.savedAt, id: s.batchId, items: finite(s.itemCount) ? s.itemCount : 0 });
  }
  return out;
}

/** A bank page's newest whole look: its newest bank stock save (Repo.bankStockSaves(bank, 1)[0]). */
export type WholeLookSave = { batchId: number; savedAt: UnixMs; items: number };

/**
 * 0.7.1 (DC-2): a bank page is dated and counted by its newest whole look, its newest bank stock save, as
 * its stock page and the engine's ACT-8 are. A partial look (DM-2) or an unsettled window snapshot (ACT-4)
 * records a batch with cards but no stock save; it caught only some cards, so it must not date the bank,
 * count its items or head "Not in your save N ago". `items` is that batch's itemCount (`itemCountOf`), else
 * the save's own row count. The list, and a bank with no stock save (saved before 0.6, or its saves
 * pruned), keep `newest`. Returns a new map.
 */
export function wholeLookNewestSaves(
  newest: ReadonlyMap<ScraptfBank, BankSave>,
  wholeLookOf: ((bank: ScraptfBank) => WholeLookSave | null | undefined) | null | undefined,
  itemCountOf: (batchId: number) => number | null | undefined,
): Map<ScraptfBank, BankSave> {
  const out = new Map(newest);
  if (!wholeLookOf) return out;
  for (const page of SCRAPTF_BANK_PAGES) {
    const s = wholeLookOf(page.bank);
    if (!s || !finite(s.savedAt) || !finite(s.batchId)) continue;
    const n = itemCountOf(s.batchId);
    out.set(page.bank, { at: s.savedAt, id: s.batchId, items: finite(n) ? n : finite(s.items) ? s.items : 0 });
  }
  return out;
}

/** Each batch's itemCount by id, from the batches read and Repo.bankNewestSaves (wholeLookNewestSaves). */
export function batchItemCounts(
  batches: readonly Pick<CoverageBatch, 'id' | 'itemCount'>[],
  extra?: readonly Pick<BankNewestSave, 'batchId' | 'itemCount'>[] | null,
): (batchId: number) => number | null {
  const counts = new Map<number, number>();
  for (const s of extra ?? []) if (finite(s.batchId) && finite(s.itemCount)) counts.set(s.batchId, s.itemCount);
  for (const b of batches) if (finite(b.itemCount)) counts.set(b.id, b.itemCount);
  return (id) => counts.get(id) ?? null;
}

/**
 * One ScraptfCoverage per SCRAPTF_BANK_PAGES entry, in that order: the newest saved page counting
 * for it (scraptfBankSaves: the recorded bank, the majority rule only for a batch without one) and
 * that page's itemCount. The /items list counts for no bank page (it has its own "All items" chip).
 * Shared by the service (cached, refreshed on pricesChanged) and the mock, so both pick the same page.
 * 0.7.1: `extra` (Repo.bankNewestSaves) dates banks saved before the batches read (mergeBankNewestSaves),
 * and `wholeLookOf` (each bank's newest stock save) dates a bank by its newest whole look (DC-2).
 */
export function scraptfCoverage(
  batches: readonly CoverageBatch[],
  categoriesOf: (batchId: number) => readonly Category[],
  extra?: readonly Pick<BankNewestSave, 'bank' | 'batchId' | 'savedAt' | 'itemCount'>[] | null,
  wholeLookOf?: ((bank: ScraptfBank) => WholeLookSave | null | undefined) | null,
): ScraptfCoverage[] {
  const newest = wholeLookNewestSaves(mergeBankNewestSaves(scraptfBankSaves(batches, categoriesOf).newest, extra), wholeLookOf, batchItemCounts(batches, extra));
  return SCRAPTF_BANK_PAGES.map((page) => {
    const save = newest.get(page.bank);
    return { category: page.category, label: page.label, url: page.url, lastSavedAt: save?.at ?? null, items: save?.items ?? 0 };
  });
}
