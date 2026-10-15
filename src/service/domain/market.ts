// Live market index (F10): one in-memory entry per base SKU that has at least
// one eligible backpack.tf buy order in the local book, evaluated with the
// engine's own pricing, plus the user's scrap.tf side (typed prices, saved
// pages, rules) joined per row at read time. It only reads the book the
// websocket already fills: no network traffic of its own, and nothing ever
// goes to scrap.tf (R1, R10).
//
// Cadence: dirty bases are re-evaluated in batches at most every 2 s; a full
// rebuild runs on start (once the schema has loaded), on markAllDirty and every
// 10 min, in chunks that stop at MARKET_SLICE_MS of synchronous work, yielding
// to the event loop between chunks. Old entries stay visible until the rebuild
// replaces them. A rebuild whose candidate scan fails is reported in stats()
// and retried after 30 s, doubling to 10 min (H1).

import { categoryOfSkuOnly } from '../../shared/categories';
import { valueScrap } from '../../shared/currency';
import {
  MARKET_CSV_COLUMNS,
  MARKET_SORTS,
  emptyMarketCounts,
  marketBuySideMatches,
  marketCsvCells,
  marketPage,
  marketProfit,
  marketSearchTokens,
  marketUpdatedAt,
  marketUserSideMatches,
  marketVerdict,
  scraptfCoverage,
} from '../../shared/market';
import { baseSku as toBaseSku, fromString } from '../../shared/sku';
import { CATEGORIES, CURRENCY_SKUS } from '../../shared/types';
import type {
  Category,
  ConfidenceLevel,
  KeyPriceState,
  Listing,
  MarketListResult,
  MarketQuery,
  MarketRow,
  MarketSort,
  MarketSource,
  MarketStats,
  MarketVerdict,
  OrderSummary,
  ReferencePrices,
  RuleFilter,
  Scrap,
  ScrapPrice,
  ScraptfCoverage,
  Settings,
  SkuObject,
  UnixMs,
} from '../../shared/types';
import type { SchemaService, ServiceDeps } from '../contracts';
import { realTimers } from '../net/ratelimit';
import type { TimerApi } from '../net/ratelimit';
import { scoreConfidence } from './confidence';
import { toCsv } from './csv';
import { bookFlags, buyerCountOf, cleanTarget, explicitInput, priceBook, validRule } from './engine';
import { anyEffectBaseOf, matchContext, ruleMatches } from './matcher';
import type { MatchContext } from './matcher';
import { lookupReferences, pickRevenueOrder, referencePrices, toOrderSummary } from './pricing';
import { itemRevenue } from './views';

/** Dirty bases wait at most this long and are evaluated together. */
export const MARKET_DIRTY_BATCH_MS = 2_000;
/** onChanged fires at most this often. */
export const MARKET_NOTIFY_MS = 2_000;
/** Order age changes eligibility and flags, so everything is re-read this often. */
export const MARKET_FULL_EVERY_MS = 10 * 60_000;
/** Target synchronous work per chunk; chunk sizes adapt toward it. */
export const MARKET_SLICE_MS = 40;
/** A rebuild whose candidate scan failed (a local read error) is retried after this, doubling per failure (H1). */
export const MARKET_RETRY_MIN_MS = 30_000;
export const MARKET_RETRY_MAX_MS = 10 * 60_000;
/** Saved-page batches the coverage strip reads (newest first); a bank page saved only before them reads "never saved". */
const COVERAGE_BATCHES = 500;
const MIN_CHUNK = 100;
const MAX_CHUNK = 2_000;
const START_CHUNK = 1_000;
/** Past this many pending dirty bases a full rebuild is cheaper than tracking them. */
const MAX_DIRTY = 20_000;
const INFO_CACHE_MAX = 250_000;
/** Unranked rows a read tolerates (compared by name directly) before merging them into the cached name order. */
const RANK_MERGE_MIN = 64;

const CURRENCY: ReadonlySet<string> = new Set(CURRENCY_SKUS);
const NO_TOKENS: readonly string[] = [];
const NO_LISTINGS: readonly Listing[] = [];

export interface MarketIndex {
  start(): void;
  stop(): void;
  /** Base SKUs whose book changed (core calls this wherever it calls engine.markDirty). */
  markDirty(bases: Iterable<string>): void;
  /** Settings (profit/blocklist/notes), key price or schema changed: rebuild everything, chunked. */
  markAllDirty(): void;
  /** The scrap.tf side changed (prices.changed): refresh the known-price map only. */
  pricesChanged(): void;
  list(q: MarketQuery, now: UnixMs): MarketListResult;
  /** Rows matching q, for CSV (no paging). */
  all(q: MarketQuery, now: UnixMs): MarketRow[];
  stats(): MarketStats;
  /**
   * The current entry of a base SKU (paint dropped), or null: no eligible order, or the index has not
   * reached it yet. Holdings (F11) price held items from it.
   */
  entryFor(base: string): Readonly<MarketEval> | null;
}

export interface MarketIndexDeps extends ServiceDeps {
  schema: SchemaService;
  /** The engine's key price (engine.keyPrice), so the index values keys exactly like the opportunity rows. */
  keyPrice(): KeyPriceState;
  /** Throttled to at most once per 2 s; only when an entry was added, removed, or changed in revenue, ceiling, buyers or revenue order. */
  onChanged(p: { changed: number; total: number; at: UnixMs }): void;
  /**
   * Whether the saved-page folder watch is running right now (core's watcher), not merely configured:
   * a missing folder or a failed OS watch must not read "Folder watch on".
   */
  folderWatchActive(): boolean;
  /**
   * Holdings (F11): the bases whose entry changed, with onChanged's test (added or removed; or revenue,
   * ceiling, buyers or revenue order id moved). Core wires it to holdings.onBasesChanged.
   * Called right before onChanged, under the same throttle.
   */
  onBasesChanged?(bases: ReadonlySet<string>): void;
  /** Injected in tests; defaults to unref'd real timers (realTimers). */
  timers?: TimerApi;
}

// ---------------------------------------------------------------------------
// Pure evaluation
// ---------------------------------------------------------------------------

/** The backpack.tf side of one base SKU, priced exactly like an opportunity on a clean copy. */
export interface MarketEval {
  bestScrap: Scrap | null;
  consScrap: Scrap | null;
  instantScrap: Scrap | null;
  revenueScrap: Scrap | null;
  revenueOrder: OrderSummary | null;
  /** The highest eligible order (the revenue order's own object when they are one listing). */
  bestOrder: OrderSummary | null;
  buyerCount: number;
  eligibleCount: number;
  maxCostScrap: Scrap | null;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  flags: string[];
  /** Newest lastEventAt among the eligible orders. */
  lastOrderChangeAt: UnixMs | null;
}

export interface MarketEvalArgs {
  base: string;
  /** The base's own buy book plus, for an effect-specific unusual, the generic any-effect book. */
  listings: readonly Listing[];
  references: ReferencePrices;
  isUnusual: boolean;
  settings: Settings;
  keyScrap: Scrap;
  now: UnixMs;
  match: MatchContext;
}

/** Null when the book has no eligible order (the base is then not in the market). */
export function evaluateMarketBase(a: MarketEvalArgs): MarketEval | null {
  const p = a.settings.profit;
  const book = priceBook(a.listings, cleanTarget(a.base), a.references, p, a.keyScrap, a.now, a.match);
  if (book.eligible.length === 0) return null;
  const rev = itemRevenue(book.prices, book.eligible.length, a.settings);
  // A fresh typed input with no margin: input age costs nothing and the suspect-margin guard
  // (which treats a free item as an unbounded margin) stays off, so only buyers and references count.
  const conf = scoreConfidence({
    order: pickRevenueOrder(book.prices, p.useOrder),
    eligible: book.eligible,
    references: a.references,
    inputKind: 'user',
    inputObservedAt: a.now,
    isUnusual: a.isUnusual,
    revenueScrap: rev.revenueScrap,
    margin: null,
    keyScrap: a.keyScrap,
    now: a.now,
    profit: p,
  });
  const best = book.prices.best;
  // Shared with the revenue order when both are one listing ('best', or a top order that is also the
  // conservative pick), so most entries hold no second summary.
  const bestOrder =
    best === null
      ? null
      : rev.order !== null && rev.order.listingId === best.listing.id
        ? rev.order
        : toOrderSummary(best, book.prices.outlierIds.has(best.listing.id) ? ['outlier'] : []);
  let last: UnixMs | null = null;
  for (const o of book.eligible) {
    const t = o.listing.lastEventAt;
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return {
    bestScrap: rev.bestScrap,
    consScrap: rev.consScrap,
    instantScrap: rev.instantScrap,
    revenueScrap: rev.revenueScrap,
    revenueOrder: rev.order,
    bestOrder,
    buyerCount: buyerCountOf(book.eligible),
    eligibleCount: book.eligible.length,
    maxCostScrap: rev.maxCostScrap,
    confidence: conf.score,
    confidenceLevel: conf.level,
    flags: bookFlags(book, conf.flags, rev.revenueScrap, a.keyScrap),
    lastOrderChangeAt: last,
  };
}

// ---------------------------------------------------------------------------
// Index internals
// ---------------------------------------------------------------------------

interface Info {
  sku: string;
  obj: SkuObject;
  category: Category;
  isUnusual: boolean;
  name: string;
  /** `${name} ${sku}` lower-cased, the haystack marketBuySideMatches searches. */
  hay: string;
}

interface Entry extends MarketEval {
  sku: string;
  name: string;
  category: Category;
  obj: SkuObject;
  hay: string;
  evaluatedAt: UnixMs;
}

/** The newest typed or imported price of one base SKU. */
interface Known {
  source: Exclude<MarketSource, 'none'>;
  costKeys: number;
  costScrapRaw: Scrap;
  observedAt: UnixMs;
  id: number;
  stock: number | null;
  /** The price is for a painted or spelled copy; the row's ceiling is for a clean one. */
  hasExtras: boolean;
}

interface KnownState {
  byBase: Map<string, Known>;
  /** Distinct base SKUs with a typed price / with an imported one. */
  typed: number;
  pages: number;
  newestPageAt: UnixMs | null;
  /** Effect-specific known bases by their generic any-effect base (dirty fan-out). */
  byGeneric: Map<string, string[]>;
  /**
   * Base SKUs carrying each saved-page import batch id today: the F13 coverage strip's categories for
   * a batch from before 0.3, which has no ImportBatch.categories of its own.
   */
  batchBases: Map<number, string[]>;
}

interface Work {
  bases: string[];
  pos: number;
}

interface SliceCtx {
  K: Scrap;
  settings: Settings;
  now: UnixMs;
  match: MatchContext;
  known: KnownState;
}

/** One row being filtered and sorted; the full MarketRow is built only for returned rows. */
interface Cand {
  sku: string;
  name: string;
  category: Category;
  e: Entry | null;
  subject: { obj: SkuObject; category: Category; name: string };
  known: Known | null;
  knownCost: Scrap | null;
  /** undefined: not needed for the verdict, computed for returned rows only. */
  ruleCost: Scrap | null | undefined;
  verdict: MarketVerdict;
  profit: Scrap | null;
  /** The sort value (null sorts last). */
  v: number | null;
  /** Position in the cached name order, or -1. */
  r: number;
}

function newerKnown(a: Known, b: Known): boolean {
  return a.observedAt > b.observedAt || (a.observedAt === b.observedAt && a.id > b.id);
}

/** Per base: the newest typed and the newest imported price; the newer of the two is the row's. */
function buildKnown(prices: readonly ScrapPrice[]): KnownState {
  const typed = new Map<string, Known>();
  const page = new Map<string, Known>();
  let newestPageAt: UnixMs | null = null;
  const batchBases = new Map<number, string[]>();
  for (const sp of prices) {
    // Every stored item counts for its page's coverage, priced by the engine or not.
    if (sp.source === 'import' && typeof sp.importBatch === 'number' && typeof sp.sku === 'string') {
      const list = batchBases.get(sp.importBatch);
      if (list) list.push(baseOf(sp.sku));
      else batchBases.set(sp.importBatch, [baseOf(sp.sku)]);
    }
    // Skips currencies and SKUs the engine would not price either.
    const inp = explicitInput(sp);
    if (!inp) continue;
    const isPage = sp.source === 'import';
    const k: Known = {
      source: isPage ? 'page' : 'typed',
      costKeys: inp.costKeys,
      costScrapRaw: inp.costScrapRaw,
      observedAt: inp.observedAt,
      id: sp.id,
      stock: isPage && typeof sp.stock === 'number' && Number.isFinite(sp.stock) ? sp.stock : null,
      hasExtras: inp.target.hasExtras === true,
    };
    const side = isPage ? page : typed;
    const cur = side.get(inp.baseSku);
    if (!cur || newerKnown(k, cur)) side.set(inp.baseSku, k);
    if (isPage && (newestPageAt === null || k.observedAt > newestPageAt)) newestPageAt = k.observedAt;
  }
  const byBase = new Map<string, Known>(typed);
  for (const [b, k] of page) {
    const t = byBase.get(b);
    if (!t || newerKnown(k, t)) byBase.set(b, k);
  }
  const byGeneric = new Map<string, string[]>();
  for (const b of byBase.keys()) {
    const any = anyEffectBaseOf(b);
    if (any === null || any === b) continue;
    const list = byGeneric.get(any);
    if (list) list.push(b);
    else byGeneric.set(any, [b]);
  }
  return { byBase, typed: typed.size, pages: page.size, newestPageAt, byGeneric, batchBases };
}

/**
 * localeCompare without arguments is defined as the default collator's compare (ECMA-402), so this
 * orders exactly like the shared comparator, at about half the cost per call.
 */
const NAME_COLLATOR = new Intl.Collator();

/** The shared comparator's tie-break (src/shared/market.ts): name, then SKU. */
function byName(a: { name: string; sku: string }, b: { name: string; sku: string }): number {
  return NAME_COLLATOR.compare(a.name, b.name) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
}

/**
 * The name order (byName) as integer ranks. Sorting 50k rows with a localeCompare per tie
 * costs 100-200 ms; with ranks it is a numeric sort. New rows merge in linearly.
 */
class NameRanks {
  private order: { sku: string; name: string }[] = [];
  private readonly ranks = new Map<string, { name: string; rank: number }>();

  rankOf(sku: string, name: string): number {
    const r = this.ranks.get(sku);
    return r !== undefined && r.name === name ? r.rank : -1;
  }

  merge(fresh: readonly { sku: string; name: string }[], live: (sku: string) => boolean): void {
    const add = new Map<string, string>();
    for (const f of fresh) add.set(f.sku, f.name);
    const incoming = [...add].map(([sku, name]) => ({ sku, name })).sort(byName);
    // A renamed SKU is in `add` and leaves its old place; rows no longer in the market are pruned.
    const kept = this.order.filter((o) => !add.has(o.sku) && live(o.sku));
    const out: { sku: string; name: string }[] = new Array(kept.length + incoming.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < kept.length && j < incoming.length) out[k++] = byName(kept[i]!, incoming[j]!) <= 0 ? kept[i++]! : incoming[j++]!;
    while (i < kept.length) out[k++] = kept[i++]!;
    while (j < incoming.length) out[k++] = incoming[j++]!;
    this.order = out;
    this.ranks.clear();
    for (let n = 0; n < out.length; n++) this.ranks.set(out[n]!.sku, { name: out[n]!.name, rank: n });
  }
}

/**
 * A base SKU's category as the index files it: the schema's, else the SKU's own fields. Also how a
 * saved page's stored items are counted at import time (ImportBatch.categories), so the coverage
 * strip and the rows agree. Throws for an unreadable SKU (it counts for no category).
 */
export function marketCategoryOf(schema: Pick<SchemaService, 'categoryForSku'>, sku: string, obj: SkuObject = fromString(sku)): Category {
  try {
    const c = schema.categoryForSku(sku);
    return CATEGORIES.includes(c) ? c : categoryOfSkuOnly(obj);
  } catch {
    return categoryOfSkuOnly(obj);
  }
}

/** Base SKU of a SKU without a full parse in the common (unpainted) case. */
function baseOf(sku: string): string {
  if (!/;p\d/.test(sku)) return sku;
  try {
    return toBaseSku(sku);
  } catch {
    return sku;
  }
}

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export function createMarketIndex(deps: MarketIndexDeps): MarketIndex {
  const { repo, log, clock, schema } = deps;
  const timers = deps.timers ?? realTimers;

  let started = false;
  const entries = new Map<string, Entry>();
  /** Effect-specific bases with buy orders of their own (or an entry) by their generic any-effect base: a generic book change re-evaluates them. */
  const genericDeps = new Map<string, Set<string>>();
  const infoCache = new Map<string, Info>();
  const ranks = new NameRanks();
  let known: KnownState | null = null;
  let lastKeyPrice: KeyPriceState | null = null;

  // Rule estimate: valid rules cheapest first at the key price they were valued with, and the
  // cheapest matching cost per base. pricesChanged marks the rule list for a re-read; the per-base
  // cache is dropped only when the rules really changed (most writes are prices, not rules, and
  // refilling it costs a rule scan of every unchecked row) or the key price moved. Each estimate
  // remembers the name and category it matched, so a renamed or recategorised item (entry or
  // known-only row) is matched again without dropping every other base's estimate.
  let rules: { filter: RuleFilter; costKeys: number; costScrap: Scrap }[] | null = null;
  let rulesSig: string | null = null;
  let rulesStale = true;
  let rulesByCost: { filter: RuleFilter; cost: Scrap }[] = [];
  let rulesK: Scrap | null = null;
  const ruleCostCache = new Map<string, { cost: Scrap | null; name: string; category: Category }>();

  // The last select() result. A live refresh of a large window reads it as several pages in a
  // row; filtering and sorting every entry once per page cost a full pass each. Dropped by every
  // change select() reads (entries, known prices, rules, info, first-build reach); the query, the
  // key value and the profit settings are part of its key.
  let selected: { sig: string; matched: Cand[]; counts: Record<MarketVerdict, number> } | null = null;
  const invalidate = (): void => {
    selected = null;
  };

  // Full rebuild state.
  let fullRequested = false;
  let full: (Work & { startedAt: UnixMs }) | null = null;
  let firstBuildDone = false;
  /** Bases the first build (or a dirty batch) has evaluated; until it completes, only these show known-only rows. */
  const reached = new Set<string>();
  let lastFullAt: UnixMs | null = null;
  let lastSchemaLoaded: boolean | null = null;
  // H1: a candidate scan that throws (the local database) is retried with backoff instead of
  // leaving the page at "Building 0 %" until the 10-min rebuild.
  let lastError: string | null = null;
  let retryAt: UnixMs | null = null;
  let failures = 0;
  let retryTimer: unknown = null;

  // F13 coverage strip: computed from the import batches and the known prices it was built with,
  // and again only after those (pricesChanged) or the categories (infoGen) change, never per list.
  let infoGen = 0;
  let coverage: { kn: KnownState; gen: number; value: ScraptfCoverage[] } | null = null;
  let coverageFailing = false;

  // Dirty batching.
  const dirty = new Set<string>();
  let dirtyWork: Work | null = null;

  let chunkSize = START_CHUNK;

  // Change notification.
  let pendingChanged = 0;
  /** Bases behind pendingChanged, for onBasesChanged (kept only when someone listens). */
  let pendingBases = new Set<string>();
  let lastChangeAt: UnixMs | null = null;
  let lastNotifiedAt: UnixMs | null = null;

  let buildTimer: unknown = null;
  let dirtyTimer: unknown = null;
  let periodicTimer: unknown = null;
  let notifyTimer: unknown = null;

  // ----- lookups -----

  function info(sku: string): Info {
    const hit = infoCache.get(sku);
    if (hit) return hit;
    const obj = fromString(sku);
    const category = marketCategoryOf(schema, sku, obj);
    let name: string;
    try {
      const n = schema.nameForSku(sku);
      name = typeof n === 'string' && n.trim() ? n : sku;
    } catch {
      name = sku;
    }
    const i: Info = {
      sku,
      obj,
      category,
      isUnusual: obj.quality === 5 || (typeof obj.effect === 'number' && obj.effect > 0),
      name,
      hay: `${name} ${sku}`.toLowerCase(),
    };
    if (infoCache.size >= INFO_CACHE_MAX) {
      infoCache.clear();
      invalidate();
    }
    infoCache.set(sku, i);
    return i;
  }

  function knownState(): KnownState {
    if (known === null) {
      known = buildKnown(repo.listScrapPrices());
      invalidate();
    }
    return known;
  }

  /** Read once per slice and once per list(); engine.keyPrice() reads the repo on every call. */
  function readKeyPrice(): KeyPriceState {
    try {
      lastKeyPrice = deps.keyPrice();
    } catch (err) {
      log.warn('Live market could not read the key price', { error: String(err) });
      if (lastKeyPrice === null) throw err;
    }
    return lastKeyPrice!;
  }

  function schemaLoaded(): boolean {
    try {
      return schema.isLoaded() === true;
    } catch {
      return false;
    }
  }

  function folderWatchOn(): boolean {
    try {
      return deps.folderWatchActive() === true;
    } catch {
      return false;
    }
  }

  /** Names and categories come from the schema: a later load (a failed first download) rebuilds. */
  function checkSchema(): void {
    const loaded = schemaLoaded();
    if (lastSchemaLoaded !== null && loaded !== lastSchemaLoaded) {
      infoCache.clear();
      infoGen++;
      ruleCostCache.clear();
      invalidate();
      if (loaded) requestFull();
    }
    lastSchemaLoaded = loaded;
  }

  function ensureRules(K: Scrap): void {
    if (rulesStale || rules === null) {
      const next = repo
        .listRules()
        .filter(validRule)
        .map((r) => ({ filter: r.filter, costKeys: r.costKeys, costScrap: r.costScrap }));
      const sig = JSON.stringify(next.map((r) => [r.filter, r.costKeys, r.costScrap]));
      rulesStale = false;
      if (rules === null || sig !== rulesSig) {
        rules = next;
        rulesSig = sig;
        rulesK = null;
      }
    }
    if (rulesK !== K) {
      rulesByCost = rules.map((r) => ({ filter: r.filter, cost: valueScrap(r.costKeys, r.costScrap, K) })).sort((a, b) => a.cost - b.cost);
      rulesK = K;
      ruleCostCache.clear();
      invalidate();
    }
  }

  /** The cheapest enabled rule matching the item (ensureRules first). Same scope as the engine's rule rows. */
  function ruleCostOf(sku: string, subject: { obj: SkuObject; category: Category; name: string }): Scrap | null {
    if (rulesByCost.length === 0) return null;
    const hit = ruleCostCache.get(sku);
    // A rule can match on the name or the category; the SKU part never changes for a SKU.
    if (hit !== undefined && hit.name === subject.name && hit.category === subject.category) return hit.cost;
    let out: Scrap | null = null;
    if (subject.obj.tradable && !CURRENCY.has(sku)) {
      for (const r of rulesByCost) {
        if (ruleMatches(r.filter, subject)) {
          out = r.cost;
          break;
        }
      }
    }
    ruleCostCache.set(sku, { cost: out, name: subject.name, category: subject.category });
    return out;
  }

  // ----- evaluation -----

  function sliceCtx(): SliceCtx {
    const now = clock.now();
    const settings = deps.settings();
    return { K: readKeyPrice().valueScrap, settings, now, match: matchContext(settings, now), known: knownState() };
  }

  /** Own books plus the generic any-effect books the chunk's effect-specific bases also read. */
  function readBooks(chunk: readonly string[]): Map<string, Listing[]> {
    const need = new Set(chunk);
    for (const b of chunk) {
      const any = anyEffectBaseOf(b);
      if (any !== null) need.add(any);
    }
    return repo.buyListingsByBaseSkus([...need]);
  }

  function linkGeneric(base: string): void {
    const any = anyEffectBaseOf(base);
    if (any === null || any === base) return;
    let set = genericDeps.get(any);
    if (!set) genericDeps.set(any, (set = new Set()));
    set.add(base);
  }

  function unlinkGeneric(base: string): void {
    const any = anyEffectBaseOf(base);
    const set = any !== null ? genericDeps.get(any) : undefined;
    if (any === null || !set) return;
    set.delete(base);
    if (set.size === 0) genericDeps.delete(any);
  }

  /** The onChanged test: added, removed, or moved in revenue, ceiling, buyers or revenue order. */
  function moved(a: Entry, b: Entry): boolean {
    return (
      a.revenueScrap !== b.revenueScrap ||
      a.maxCostScrap !== b.maxCostScrap ||
      a.buyerCount !== b.buyerCount ||
      (a.revenueOrder?.listingId ?? null) !== (b.revenueOrder?.listingId ?? null)
    );
  }

  /** Replaces one base's entry; returns 1 when the change counts for onChanged (and onBasesChanged). */
  function put(base: string, next: Entry | null): number {
    const n = replace(base, next);
    if (n > 0 && deps.onBasesChanged) pendingBases.add(base);
    return n;
  }

  function replace(base: string, next: Entry | null): number {
    const prev = entries.get(base);
    if (next === null) {
      if (!prev) return 0;
      entries.delete(base);
      ruleCostCache.delete(base);
      invalidate();
      return 1;
    }
    // Every re-evaluation is a new Entry (evaluatedAt, flags), and cached reads hold the old one.
    entries.set(base, next);
    invalidate();
    if (!prev) return 1;
    return moved(prev, next) ? 1 : 0;
  }

  function evaluateInto(base: string, books: Map<string, Listing[]>, c: SliceCtx): number {
    const own = books.get(base) ?? NO_LISTINGS;
    const any = anyEffectBaseOf(base);
    // Generic "any effect" orders buy every effect of the item, exactly as in the engine.
    const generic = any !== null && any !== base ? (books.get(any) ?? NO_LISTINGS) : NO_LISTINGS;
    // A rebuild cannot enumerate the effects only a generic book buys (the engine has the same
    // limit), so such a base is listed only while the user has a price for it; otherwise it would
    // linger after the price is deleted and then vanish on the next restart.
    const listed = own.length > 0 || (generic.length > 0 && c.known.byBase.has(base));
    let next: Entry | null = null;
    if (listed) {
      const i = info(base);
      const ev = evaluateMarketBase({
        base,
        listings: generic.length > 0 ? [...own, ...generic] : own,
        references: referencePrices(lookupReferences(repo, base), c.K, c.now),
        isUnusual: i.isUnusual,
        settings: c.settings,
        keyScrap: c.K,
        now: c.now,
        match: c.match,
      });
      if (ev) next = { ...ev, sku: base, name: i.name, category: i.category, obj: i.obj, hay: i.hay, evaluatedAt: c.now };
    }
    if (!firstBuildDone && !reached.has(base)) {
      reached.add(base);
      // Its known-only row may show from now on.
      invalidate();
    }
    const out = put(base, next);
    // Linked after put, from the base's own book rather than its entry: an effect whose own orders
    // are all ineligible (marketplace.tf, banned, attribute-specific) has no entry, yet a generic
    // order arriving later makes it a row, exactly as a rebuild would list it.
    if (own.length > 0 || next !== null) linkGeneric(base);
    else unlinkGeneric(base);
    return out;
  }

  /**
   * Evaluates the next chunk of `w` synchronously, stopping once the slice has used MARKET_SLICE_MS.
   * The chunk size is only an upper bound, sized from earlier slices: one batch can be far costlier
   * per base than the last (a generic book's change fans out to every effect that reads it), so the
   * time is checked while evaluating instead of trusted in advance.
   */
  function runChunk(w: Work): void {
    const t0 = performance.now();
    const start = w.pos;
    const end = Math.min(w.bases.length, start + chunkSize);
    const chunk = w.bases.slice(start, end);
    // Advanced first, so a chunk whose books cannot be read is skipped instead of retried forever.
    w.pos = end;
    let c: SliceCtx;
    let books: Map<string, Listing[]>;
    try {
      c = sliceCtx();
      books = readBooks(chunk);
    } catch (err) {
      // Runs from a timer: nothing may escape into the service process.
      log.warn('Live market could not read order books', { error: String(err) });
      return;
    }
    let changed = 0;
    let failed = 0;
    let done = 0;
    for (const base of chunk) {
      // At least one base per slice, so the work always moves; the rest is re-read next slice.
      if (done > 0 && performance.now() - t0 >= MARKET_SLICE_MS) break;
      // Counted before evaluating: a base that throws is skipped, not retried.
      done++;
      try {
        changed += evaluateInto(base, books, c);
      } catch (err) {
        if (failed++ === 0) log.warn('Live market evaluation failed', { sku: base, error: String(err) });
      }
    }
    w.pos = start + done;
    const ms = performance.now() - t0;
    if (done > 0) {
      const target = ms > 0 ? Math.floor((MARKET_SLICE_MS * done) / ms) : MAX_CHUNK;
      chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, target, chunkSize * 2));
    }
    noteChanges(changed, c.now);
  }

  // ----- change notification -----

  function noteChanges(n: number, now: UnixMs): void {
    if (n <= 0) return;
    pendingChanged += n;
    lastChangeAt = now;
    flushNotify();
  }

  function fireChanged(now: UnixMs): void {
    const changed = pendingChanged;
    pendingChanged = 0;
    lastNotifiedAt = now;
    if (pendingBases.size > 0) {
      const bases = pendingBases;
      pendingBases = new Set();
      try {
        deps.onBasesChanged?.(bases);
      } catch (err) {
        log.warn('Live market change listener failed', { error: String(err) });
      }
    }
    try {
      deps.onChanged({ changed, total: entries.size, at: lastChangeAt ?? now });
    } catch (err) {
      log.warn('Live market change listener failed', { error: String(err) });
    }
  }

  function flushNotify(): void {
    if (!started || pendingChanged === 0 || notifyTimer !== null) return;
    const now = clock.now();
    // Clamped: a clock that moved back must not hold the push longer than one period.
    const wait = lastNotifiedAt === null ? 0 : Math.min(MARKET_NOTIFY_MS, lastNotifiedAt + MARKET_NOTIFY_MS - now);
    if (wait <= 0) {
      fireChanged(now);
      return;
    }
    notifyTimer = timers.setTimeout(() => {
      notifyTimer = null;
      if (started && pendingChanged > 0) fireChanged(clock.now());
    }, wait);
  }

  // ----- full rebuild -----

  function requestFull(): void {
    fullRequested = true;
    armBuild();
  }

  function armBuild(): void {
    if (!started || buildTimer !== null) return;
    buildTimer = timers.setTimeout(buildStep, 0);
  }

  function beginFull(): void {
    fullRequested = false;
    const set = new Set<string>(repo.baseSkusWithBuyOrders());
    // Known-price bases cover effect-specific items only a generic book buys; current entries
    // are re-read so one whose orders all went is removed.
    for (const b of knownState().byBase.keys()) set.add(b);
    for (const b of entries.keys()) set.add(b);
    for (const c of CURRENCY) set.delete(c);
    // Marks made before this point are covered by the rebuild; later ones are batched as usual.
    dirty.clear();
    full = { bases: [...set], pos: 0, startedAt: clock.now() };
  }

  function finishFull(): void {
    const now = clock.now();
    const ms = full ? now - full.startedAt : 0;
    full = null;
    lastFullAt = now;
    if (!firstBuildDone) {
      firstBuildDone = true;
      reached.clear();
      // Every known-only row shows from now on.
      invalidate();
    }
    armPeriodic();
    log.debug('Live market rebuilt', { entries: entries.size, ms });
  }

  function buildStep(): void {
    buildTimer = null;
    if (!started) return;
    // A request made while building restarts the rebuild: settings or the key price moved.
    if (fullRequested) {
      try {
        beginFull();
      } catch (err) {
        full = null;
        fullRequested = false;
        scanFailed(err);
        return;
      }
      scanSucceeded();
      // The candidate scan reads every base with buy orders: a slice of its own.
      armBuild();
      return;
    }
    if (full !== null) {
      runChunk(full);
      if (full.pos >= full.bases.length) finishFull();
    }
    if (fullRequested || full !== null) armBuild();
  }

  /** H1: report the failure (stats().lastError / retryAt) and try again after 30 s, doubling to 10 min. */
  function scanFailed(err: unknown): void {
    failures++;
    const delay = Math.min(MARKET_RETRY_MAX_MS, MARKET_RETRY_MIN_MS * 2 ** Math.min(failures - 1, 16));
    const msg = err instanceof Error && err.message ? err.message : String(err);
    lastError = msg.length > 300 ? `${msg.slice(0, 299)}…` : msg;
    retryAt = clock.now() + delay;
    log.warn('Live market rebuild could not start', { error: String(err), retryInMs: delay });
    // The backoff decides the next attempt; finishFull re-arms the 10-min rebuild after a success.
    if (periodicTimer !== null) timers.clearTimeout(periodicTimer);
    periodicTimer = null;
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      requestFull();
    }, delay);
  }

  function scanSucceeded(): void {
    failures = 0;
    lastError = null;
    retryAt = null;
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function armPeriodic(): void {
    if (!started) return;
    if (periodicTimer !== null) timers.clearTimeout(periodicTimer);
    periodicTimer = timers.setTimeout(() => {
      periodicTimer = null;
      checkSchema();
      // A rebuild already running covers this one (and re-arms the timer when it finishes).
      if (full === null) requestFull();
    }, MARKET_FULL_EVERY_MS);
  }

  // ----- dirty batches -----

  function armDirty(ms: number): void {
    if (!started || dirtyTimer !== null) return;
    dirtyTimer = timers.setTimeout(dirtyStep, ms);
  }

  /** A generic any-effect book changed: the effect-specific bases that read it change too. */
  function expandDirty(marked: readonly string[]): string[] {
    const out = new Set(marked);
    const byGeneric = knownState().byGeneric;
    for (const b of marked) {
      for (const d of genericDeps.get(b) ?? []) out.add(d);
      for (const d of byGeneric.get(b) ?? []) out.add(d);
    }
    return [...out];
  }

  function dirtyStep(): void {
    dirtyTimer = null;
    if (!started) return;
    checkSchema();
    try {
      if (dirtyWork === null && dirty.size > 0) {
        const marked = [...dirty];
        dirty.clear();
        dirtyWork = { bases: expandDirty(marked), pos: 0 };
      }
      if (dirtyWork !== null) {
        runChunk(dirtyWork);
        if (dirtyWork.pos >= dirtyWork.bases.length) dirtyWork = null;
      }
    } catch (err) {
      log.warn('Live market update failed', { error: String(err) });
      dirtyWork = null;
    }
    if (dirtyWork !== null) armDirty(0);
    else if (dirty.size > 0) armDirty(MARKET_DIRTY_BATCH_MS);
  }

  function markDirtyBases(bases: Iterable<string>): void {
    for (const s of bases) {
      if (typeof s !== 'string') continue;
      const t = s.trim();
      if (!t) continue;
      const base = baseOf(t);
      if (CURRENCY.has(base)) continue;
      dirty.add(base);
      if (dirty.size > MAX_DIRTY) {
        dirty.clear();
        requestFull();
        return;
      }
    }
    if (dirty.size > 0 && dirtyWork === null) armDirty(MARKET_DIRTY_BATCH_MS);
  }

  // ----- reads -----

  function stats(): MarketStats {
    // A failed candidate scan is not "building" while it waits for its retry (H1).
    const building = full !== null || (started && (fullRequested || (lastFullAt === null && lastError === null)));
    let progress = 1;
    if (full !== null) progress = full.bases.length === 0 ? 1 : full.pos / full.bases.length;
    else if (building) progress = 0;
    return {
      entries: entries.size,
      building,
      progress,
      lastFullAt,
      lastChangeAt,
      pendingDirty: dirty.size + (dirtyWork ? dirtyWork.bases.length - dirtyWork.pos : 0),
      lastError,
      retryAt,
    };
  }

  /**
   * One ScraptfCoverage per bank page (F13), from the categories each batch stored when imported (rows
   * carrying its id today only for a batch from before 0.3); cached, see `coverage`.
   */
  function coverageOf(kn: KnownState): ScraptfCoverage[] {
    if (coverage === null || coverage.kn !== kn || coverage.gen !== infoGen) {
      let value: ScraptfCoverage[];
      try {
        // No stored saved-page item: every page reads "never saved" without reading the batches.
        const batches = kn.batchBases.size > 0 ? repo.listImportBatches(COVERAGE_BATCHES) : [];
        value = scraptfCoverage(batches, (id) => {
          const cats: Category[] = [];
          for (const b of kn.batchBases.get(id) ?? []) {
            try {
              cats.push(info(b).category);
            } catch {
              // an unreadable SKU counts for no page
            }
          }
          return cats;
        });
      } catch (err) {
        // Once per failure streak: list() asks again on every page refresh until the read works.
        if (!coverageFailing) log.warn('Live market could not read the saved pages', { error: String(err) });
        coverageFailing = true;
        // Not cached, so the next list() reads the batches again (a locked database recovers). Until
        // then the last good strip beats telling the user every page was never saved.
        return (coverage?.value ?? scraptfCoverage([], () => [])).map((c) => ({ ...c }));
      }
      coverageFailing = false;
      coverage = { kn, gen: infoGen, value };
    }
    return coverage.value.map((c) => ({ ...c }));
  }

  function sortValueOf(key: MarketSort, e: Entry | null, profit: Scrap | null, knownObservedAt: UnixMs | null): number | null {
    // Mirrors the shared comparator's values (test/domain/market.test.ts pins the order to marketComparator).
    switch (key) {
      case 'ceiling':
        return finiteOrNull(e?.maxCostScrap);
      case 'revenue':
        return finiteOrNull(e?.revenueScrap);
      case 'buyers':
        return e ? finiteOrNull(e.buyerCount) : 0;
      case 'profit':
        return finiteOrNull(profit);
      case 'updated':
        return marketUpdatedAt({ lastOrderChangeAt: e?.lastOrderChangeAt ?? null, knownObservedAt });
      case 'name':
        return null;
    }
  }

  /**
   * Every row matching q in marketComparator order, the verdict counts, and the key price used.
   * Paging is not part of it: the pages of one window share one pass while nothing changed.
   */
  function select(q: MarketQuery): { matched: readonly Cand[]; counts: Record<MarketVerdict, number>; kp: KeyPriceState; kn: KnownState } {
    checkSchema();
    const kp = readKeyPrice();
    const K = kp.valueScrap;
    const p = deps.settings().profit;
    const kn = knownState();
    ensureRules(K);
    const { limit: _limit, offset: _offset, ...filters } = q;
    // The profit settings set every profit (and are read here, not through a rebuild).
    const sig = JSON.stringify([filters, K, p]);
    if (selected !== null && selected.sig === sig) return { matched: selected.matched, counts: { ...selected.counts }, kp, kn };
    const tokens = marketSearchTokens(q.search);
    const key: MarketSort = q.sort && MARKET_SORTS.includes(q.sort) ? q.sort : 'ceiling';
    const counts = emptyMarketCounts();
    const matched: Cand[] = [];

    const consider = (
      row: Pick<MarketRow, 'sku' | 'name' | 'category' | 'maxCostScrap' | 'buyerCount' | 'revenueOrder'>,
      e: Entry | null,
      subject: Cand['subject'],
      hay: string,
    ): void => {
      if (!marketBuySideMatches(row, q, NO_TOKENS)) return;
      // Same test as marketBuySideMatches' search, on the haystack built once per entry.
      for (const t of tokens) if (!hay.includes(t)) return;
      const k = kn.byBase.get(row.sku) ?? null;
      const knownCost = k ? valueScrap(k.costKeys, k.costScrapRaw, K) : null;
      // The rule estimate decides the verdict only without a known cost, with buyers and a ceiling.
      const ruleCost = knownCost === null && row.buyerCount > 0 && row.maxCostScrap !== null ? ruleCostOf(row.sku, subject) : undefined;
      const verdict = marketVerdict({ buyerCount: row.buyerCount, maxCostScrap: row.maxCostScrap, knownCostScrap: knownCost, ruleCostScrap: ruleCost ?? null });
      const side = { knownSource: k ? k.source : ('none' as const), verdict };
      if (!marketUserSideMatches(side, q, true)) return;
      counts[verdict]++;
      if (!marketUserSideMatches(side, q)) return;
      const profit = marketProfit(e?.revenueScrap ?? null, knownCost, p);
      matched.push({
        sku: row.sku,
        name: row.name,
        category: row.category,
        e,
        subject,
        known: k,
        knownCost,
        ruleCost,
        verdict,
        profit,
        v: sortValueOf(key, e, profit, k?.observedAt ?? null),
        r: ranks.rankOf(row.sku, row.name),
      });
    };

    for (const e of entries.values()) consider(e, e, e, e.hay);
    for (const base of kn.byBase.keys()) {
      // Until the first build reaches a base, its known price would flash 'no-buyers'.
      if (entries.has(base) || (!firstBuildDone && !reached.has(base))) continue;
      const i = info(base);
      consider({ sku: base, name: i.name, category: i.category, maxCostScrap: null, buyerCount: 0, revenueOrder: null }, null, i, i.hay);
    }

    let unranked = 0;
    for (const c of matched) if (c.r < 0) unranked++;
    if (unranked >= RANK_MERGE_MIN) {
      ranks.merge(
        matched.filter((c) => c.r < 0),
        (sku) => entries.has(sku) || kn.byBase.has(sku),
      );
      for (const c of matched) c.r = ranks.rankOf(c.sku, c.name);
    }

    // marketComparator's order, with the name tie-break read from the ranks where both rows have one.
    const sign = (q.dir ?? (key === 'name' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
    const tie = (a: Cand, b: Cand): number => (a.r >= 0 && b.r >= 0 ? a.r - b.r : byName(a, b));
    if (key === 'name') matched.sort((a, b) => sign * tie(a, b));
    else {
      matched.sort((a, b) => {
        const va = a.v;
        const vb = b.v;
        if (va === null || vb === null) {
          if (va !== vb) return va === null ? 1 : -1;
          return tie(a, b);
        }
        return sign * (va - vb) || tie(a, b);
      });
    }
    selected = { sig, matched, counts };
    return { matched, counts: { ...counts }, kp, kn };
  }

  function toRow(c: Cand, now: UnixMs): MarketRow {
    const e = c.e;
    const flags = e ? [...e.flags] : [];
    // The ceiling is for a clean copy; a price for a painted or spelled copy is still shown, but marked.
    if (c.known?.hasExtras && !flags.includes('has-extras')) flags.push('has-extras');
    return {
      sku: c.sku,
      name: c.name,
      category: c.category,
      revenueScrap: e?.revenueScrap ?? null,
      bestScrap: e?.bestScrap ?? null,
      consScrap: e?.consScrap ?? null,
      instantScrap: e?.instantScrap ?? null,
      revenueOrder: e?.revenueOrder ?? null,
      buyerCount: e?.buyerCount ?? 0,
      maxCostScrap: e?.maxCostScrap ?? null,
      confidence: e?.confidence ?? 0,
      confidenceLevel: e?.confidenceLevel ?? 'low',
      flags,
      knownCostScrap: c.knownCost,
      knownSource: c.known ? c.known.source : 'none',
      knownObservedAt: c.known?.observedAt ?? null,
      stock: c.known?.source === 'page' ? c.known.stock : null,
      ruleCostScrap: c.ruleCost !== undefined ? c.ruleCost : ruleCostOf(c.sku, c.subject),
      profitScrap: c.profit,
      verdict: c.verdict,
      lastOrderChangeAt: e?.lastOrderChangeAt ?? null,
      evaluatedAt: e?.evaluatedAt ?? now,
    };
  }

  return {
    start() {
      if (started) return;
      started = true;
      lastSchemaLoaded = schemaLoaded();
      // Before the schema has loaded, names and categories would be raw SKUs: core calls
      // markAllDirty once it has, and a later load is noticed by checkSchema.
      if (lastSchemaLoaded || fullRequested) requestFull();
      if (dirtyWork !== null) armDirty(0);
      else if (dirty.size > 0) armDirty(MARKET_DIRTY_BATCH_MS);
      armPeriodic();
      flushNotify();
    },

    stop() {
      started = false;
      for (const t of [buildTimer, dirtyTimer, periodicTimer, notifyTimer]) if (t !== null) timers.clearTimeout(t);
      buildTimer = null;
      dirtyTimer = null;
      periodicTimer = null;
      notifyTimer = null;
      // A rebuild cut short starts over on the next start(); the entries stay readable meanwhile.
      if (full !== null) {
        full = null;
        fullRequested = true;
      }
      // So does a retry still waiting after a failed scan (H1).
      if (retryTimer !== null) {
        timers.clearTimeout(retryTimer);
        retryTimer = null;
        retryAt = null;
        fullRequested = true;
      }
    },

    markDirty(bases) {
      if (bases === null || bases === undefined || typeof (bases as Iterable<string>)[Symbol.iterator] !== 'function') return;
      markDirtyBases(bases);
    },

    markAllDirty() {
      // Coalesces: several calls before the rebuild starts make one rebuild. Names are re-read (a
      // schema update keeps isLoaded true); the rule estimates stay, since none of the callers
      // (prices jobs, maintenance, settings, key moves) changes the rules, and an item whose name or
      // category does change is matched again by ruleCostOf. ensureRules handles rule and key moves.
      infoCache.clear();
      infoGen++;
      invalidate();
      // This rebuild already reads the schema as it is now (core calls this right after schema.init()),
      // so checkSchema must not restart it for the same load.
      lastSchemaLoaded = schemaLoaded();
      requestFull();
    },

    pricesChanged() {
      rulesStale = true;
      const prev = known;
      known = null;
      try {
        const next = knownState();
        if (prev === null) return;
        const touched: string[] = [];
        // A new price for an item without an entry may be an effect only a generic book buys.
        for (const b of next.byBase.keys()) if (!prev.byBase.has(b) && !entries.has(b)) touched.push(b);
        // A deleted price may have been the only reason such an effect was listed (evaluateInto).
        for (const b of prev.byBase.keys()) {
          if (next.byBase.has(b) || !entries.has(b)) continue;
          const any = anyEffectBaseOf(b);
          if (any !== null && any !== b) touched.push(b);
        }
        if (touched.length > 0) markDirtyBases(touched);
      } catch (err) {
        // Rebuilt on the next read instead.
        known = null;
        log.warn('Live market could not read your prices', { error: String(err) });
      }
    },

    list(q, now) {
      const { matched, counts, kp, kn } = select(q);
      const { limit, offset } = marketPage(q);
      const s = deps.settings();
      const importEnabled = s.import.enabled && s.import.acknowledgedAt !== null;
      return {
        rows: matched.slice(offset, offset + limit).map((c) => toRow(c, now)),
        total: matched.length,
        counts,
        scraptf: {
          typed: kn.typed,
          pages: kn.pages,
          newestPageAt: kn.newestPageAt,
          importEnabled,
          // The watch as it runs, not as configured: a missing folder or a failed watch is off.
          watchFolder: importEnabled && folderWatchOn(),
          coverage: coverageOf(kn),
        },
        stats: stats(),
        keyPrice: kp,
        generatedAt: now,
      };
    },

    all(q, now) {
      return select(q).matched.map((c) => toRow(c, now));
    },

    stats,

    entryFor(base) {
      if (typeof base !== 'string') return null;
      return entries.get(base) ?? entries.get(baseOf(base.trim())) ?? null;
    },
  };
}

/** Columns: sku, name, category, verdict, sells_for, buyer, buyers, pay_up_to, your_price, source, stock, rule_price, profit, confidence, updated. */
export function marketCsv(rows: readonly MarketRow[], keyScrap: Scrap | null): string {
  return toCsv([MARKET_CSV_COLUMNS, ...rows.map((r) => marketCsvCells(r, keyScrap))]);
}
