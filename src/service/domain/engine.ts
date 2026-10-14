// The "constant check" opportunity engine (design brief §5.6).
//
// Inputs are the user's scrap.tf prices (explicit, per SKU) and enabled
// price-sheet rules (category estimates); exits are backpack.tf buy orders for
// the same base SKU. Dirty base SKUs are evaluated on a debounced tick, and a
// full sweep every 60 s re-evaluates everything so time-based confidence
// (input age, order age, bot pulse) and rule matches stay current.

import { z } from 'zod';
import { categoryOfSkuOnly } from '../../shared/categories';
import { formatScrap, valueScrap } from '../../shared/currency';
import { baseSku as toBaseSku, fromObject, fromString, isValidSku } from '../../shared/sku';
import { CATEGORIES, CURRENCY_SKUS, EMPTY_SPECIAL } from '../../shared/types';
import type {
  Category,
  InputKind,
  KeyPriceState,
  Listing,
  Opportunity,
  OpportunityEvent,
  OpportunityStatus,
  OrderSummary,
  PriceRule,
  ProfitSettings,
  ReferencePrices,
  Scrap,
  ScrapPrice,
  Settings,
  SkuObject,
  UnixMs,
} from '../../shared/types';
import type { Engine, EngineEvents, Repo, SchemaService, ServiceDeps } from '../contracts';
import { realTimers } from '../net/ratelimit';
import type { TimerApi } from '../net/ratelimit';
import { scoreConfidence } from './confidence';
import { selectKeyPrice } from './keyprice';
import { anyEffectBaseOf, classifyOrder, dedupeOrders, isSpecialEmpty, matchContext, normalizeSpecial, ruleMatches } from './matcher';
import type { MatchContext, MatchTarget } from './matcher';
import { computePrices, lookupReferences, outlierRefs, pickRevenueOrder, referencePrices, toOrderSummary, usableReferences, valueOrders } from './pricing';
import { INPUT_KIND_ORDER, maxCostFor, profitStatus, profitTier } from './tiers';

export const DEBOUNCE_MS = 1000;
export const SWEEP_INTERVAL_MS = 60_000;
/** A profitable row emits 'changed' when its profit moves by at least 1 ref. */
export const CHANGE_PROFIT_DELTA: Scrap = 9;
/** Repo meta key holding { opportunityKey: lastNotifiedAt }. */
export const NOTIFY_META_KEY = 'engine.lastNotified';
/** Individual toasts per run; the rest are folded into one summary toast. */
export const MAX_NOTIFICATIONS_PER_RUN = 3;
/**
 * 'notified' events written per run (most profitable first). Every qualifying
 * opportunity is still marked notified; past this many the toasts already fold
 * into one summary, so the event log is not flooded by a broad rule.
 */
export const MAX_NOTIFIED_EVENTS_PER_RUN = 50;
/** Above this many keys the buyer deserves a ban/background check (brief §5.8). */
export const BACKGROUND_CHECK_KEYS = 15;

const LISTING_CHUNK = 2000;
/**
 * Listings (plus one per cached book) kept in the engine's buy-book cache. Bounds
 * memory to roughly 100 MB at worst; books past it are read on every sweep, as before.
 */
const BOOK_CACHE_MAX_LISTINGS = 100_000;
const MAX_DIRTY = 20_000;
const SKU_CACHE_MAX = 250_000;
const BEST_RAW_REFRESH_MS = 10 * 60_000;
const CURRENCY: ReadonlySet<string> = new Set(CURRENCY_SKUS);
const STORED_RULE_STATUSES: ReadonlySet<OpportunityStatus> = new Set(['profitable', 'below-threshold']);

// ---------------------------------------------------------------------------
// Pure evaluation
// ---------------------------------------------------------------------------

/** One thing to price: a scrap.tf price or a rule applied to one base SKU. */
export interface EngineInput {
  key: string;
  sku: string;
  baseSku: string;
  inputRef: string;
  inputKind: InputKind;
  name: string;
  costKeys: number;
  costScrapRaw: Scrap;
  observedAt: UnixMs;
  target: MatchTarget;
}

export interface EvaluateArgs {
  input: EngineInput;
  /** Buy listings for the input's base SKU. */
  listings: readonly Listing[];
  references: ReferencePrices;
  category: Category;
  isUnusual: boolean;
  settings: Settings;
  keyScrap: Scrap;
  now: UnixMs;
  match: MatchContext;
  prev: Opportunity | null;
}

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function revenueOrderOf(o: Pick<Opportunity, 'bestOrder' | 'consOrder' | 'instantOrder'>, useOrder: ProfitSettings['useOrder']): OrderSummary | null {
  return pickRevenueOrder({ best: o.bestOrder, conservative: o.consOrder, instant: o.instantOrder }, useOrder);
}

/**
 * A stored row's revenue order when useOrder is not at hand (CSV, shopping list).
 * Exact: computePrices sorts ties bots first and its outlier test depends only on
 * the value, so two of best/conservative/instant with the same value are the same order.
 */
export function revenueOrderByValue(o: Pick<Opportunity, 'revenueScrap' | 'bestOrder' | 'consOrder' | 'instantOrder'>): OrderSummary | null {
  if (o.revenueScrap === null) return null;
  return [o.consOrder, o.bestOrder, o.instantOrder].find((x) => x !== null && x !== undefined && x.valueScrap === o.revenueScrap) ?? null;
}

export function evaluateOpportunity(a: EvaluateArgs): Opportunity {
  const { input, settings, keyScrap, now } = a;
  const p = settings.profit;
  const costScrap = valueScrap(input.costKeys, input.costScrapRaw, keyScrap);

  const { kept } = dedupeOrders(a.listings.filter((l) => l.intent === 'buy'));
  const classified = kept.map((listing) => ({ listing, ...classifyOrder(listing, input.target, a.match) }));
  const eligible = valueOrders(
    classified.filter((o) => o.eligible),
    keyScrap,
  );
  // F4: a stale reference must not mark current orders as outliers; scoreConfidence gates its own use the same way.
  const prices = computePrices(eligible, outlierRefs(usableReferences(a.references, p.referenceMaxAgeMs, now).references), p);
  const summary = (o: (typeof eligible)[number] | null): OrderSummary | null =>
    o ? toOrderSummary(o, prices.outlierIds.has(o.listing.id) ? ['outlier'] : []) : null;

  const revenueOrder = pickRevenueOrder(prices, p.useOrder);
  const revenueScrap = revenueOrder?.valueScrap ?? null;
  const profitScrap = revenueScrap === null ? null : revenueScrap - costScrap - nonNegative(p.frictionScrap);
  const margin = profitScrap === null || costScrap <= 0 ? null : profitScrap / costScrap;
  // The suspect-margin guard treats a free item with a profit like profitStatus does: an unbounded margin.
  const guardMargin = margin ?? (profitScrap !== null && profitScrap > 0 ? Number.POSITIVE_INFINITY : null);

  const conf = scoreConfidence({
    order: revenueOrder,
    eligible,
    references: a.references,
    inputKind: input.inputKind,
    inputObservedAt: input.observedAt,
    isUnusual: a.isUnusual,
    revenueScrap,
    margin: guardMargin,
    keyScrap,
    now,
    profit: p,
  });

  const flags: string[] = [];
  if (prices.best && prices.outlierIds.has(prices.best.listing.id)) flags.push('outlier-best');
  if (eligible.length > 0 && prices.conservative === null) flags.push('all-outliers');
  for (const f of conf.flags) if (!flags.includes(f)) flags.push(f);
  // Brief §5.8: informational only, the user decides.
  if (revenueScrap !== null && keyScrap > 0 && revenueScrap > BACKGROUND_CHECK_KEYS * keyScrap) flags.push('background-check');

  return {
    key: input.key,
    sku: input.sku,
    name: input.name,
    category: a.category,
    inputRef: input.inputRef,
    inputKind: input.inputKind,
    costKeys: input.costKeys,
    costScrapRaw: input.costScrapRaw,
    costScrap,
    bestScrap: prices.best?.valueScrap ?? null,
    consScrap: prices.conservative?.valueScrap ?? null,
    instantScrap: prices.instant?.valueScrap ?? null,
    revenueScrap,
    profitScrap,
    margin,
    // F1: the scrap.tf price this row's revenue still clears the thresholds at.
    maxCostScrap: maxCostFor(revenueScrap, p),
    confidence: conf.score,
    confidenceLevel: conf.level,
    flags,
    reasons: conf.reasons,
    buyerCount: new Set(eligible.map((o) => o.listing.steamid || o.listing.id)).size,
    bestOrder: summary(prices.best),
    consOrder: summary(prices.conservative),
    instantOrder: summary(prices.instant),
    references: a.references,
    profitTier: profitTier(profitScrap, keyScrap),
    status: profitStatus(profitScrap, costScrap, p),
    inputObservedAt: input.observedAt,
    firstSeenAt: a.prev?.firstSeenAt ?? now,
    updatedAt: now,
  };
}

/** A user/import price as an engine input, or null when it cannot be evaluated (bad SKU, currency, bad cost). */
export function explicitInput(sp: ScrapPrice): EngineInput | null {
  // Strict: a token fromString would drop must not turn the price into another item.
  if (typeof sp.sku !== 'string' || !isValidSku(sp.sku)) return null;
  if (!Number.isFinite(sp.costScrap) || sp.costScrap < 0) return null;
  const costKeys = sp.costKeys ?? 0;
  if (!Number.isFinite(costKeys) || costKeys < 0) return null;

  const obj = fromString(sp.sku.trim());
  const sku = fromObject(obj);
  const base = fromObject({ ...obj, paint: null });
  if (CURRENCY.has(base)) return null;

  const paint = typeof obj.paint === 'number' && obj.paint > 0 ? obj.paint : null;
  let special = sp.special ? normalizeSpecial(sp.special) : null;
  if (special && special.paint === null && paint !== null) special = { ...special, paint };
  const inputRef = `price:${sp.id}`;
  return {
    key: `${sku}|${inputRef}`,
    sku,
    baseSku: base,
    inputRef,
    inputKind: sp.source === 'import' ? 'import' : 'user',
    name: typeof sp.name === 'string' ? sp.name.trim() : '',
    costKeys,
    costScrapRaw: sp.costScrap,
    observedAt: Number.isFinite(sp.observedAt) ? sp.observedAt : 0,
    target: {
      baseSku: base,
      special,
      hasExtras: paint !== null || (special !== null && !isSpecialEmpty(special)),
      anyEffectBase: anyEffectBaseOf(base),
    },
  };
}

export function ruleInput(rule: PriceRule, base: string, name = ''): EngineInput {
  const inputRef = `rule:${rule.id}`;
  return {
    key: `${base}|${inputRef}`,
    sku: base,
    baseSku: base,
    inputRef,
    inputKind: 'rule',
    name,
    costKeys: rule.costKeys,
    costScrapRaw: rule.costScrap,
    observedAt: rule.observedAt,
    // Rules describe clean copies.
    target: { baseSku: base, special: { ...EMPTY_SPECIAL, spells: [], parts: [] }, anyEffectBase: anyEffectBaseOf(base) },
  };
}

function validRule(r: PriceRule): boolean {
  return (
    r.enabled === true &&
    Number.isFinite(r.costScrap) &&
    r.costScrap >= 0 &&
    Number.isFinite(r.costKeys) &&
    r.costKeys >= 0 &&
    r.filter !== null &&
    typeof r.filter === 'object'
  );
}

// ---------------------------------------------------------------------------
// Event summaries
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<OpportunityStatus, string> = {
  profitable: 'profitable',
  'below-threshold': 'below threshold',
  unprofitable: 'unprofitable',
  'no-buyers': 'no buyers',
};

function buyerTag(o: OrderSummary | null): string {
  if (!o) return '';
  const parts = [o.isBot ? 'bot' : 'human'];
  if (o.online === true) parts.push('online');
  else if (o.online === false) parts.push('offline');
  return ` (${parts.join(', ')})`;
}

function money(v: Scrap | null, keyScrap: Scrap): string {
  return formatScrap(v, keyScrap);
}

function pct(margin: number | null): string | null {
  return margin === null || !Number.isFinite(margin) ? null : `${Math.round(margin * 100)}%`;
}

function eventOf(o: Opportunity, kind: OpportunityEvent['kind'], summary: string, ts: UnixMs): Omit<OpportunityEvent, 'id'> {
  return {
    key: o.key,
    sku: o.sku,
    name: o.name,
    category: o.category,
    kind,
    profitScrap: o.profitScrap,
    costScrap: o.costScrap,
    revenueScrap: o.revenueScrap,
    confidence: o.confidence,
    summary,
    ts,
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Deep equality for JSON-like values, independent of key order; undefined keys count as absent. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  let na = 0;
  for (const k in ao) {
    if (ao[k] === undefined) continue;
    na++;
    if (!sameJson(ao[k], bo[k])) return false;
  }
  let nb = 0;
  for (const k in bo) if (bo[k] !== undefined) nb++;
  return na === nb;
}

/** Equal in everything that matters to the user; the evaluation time and the PriceDB age (recomputed on read) do not. */
function materiallyEqual(a: Opportunity, b: Opportunity): boolean {
  const { updatedAt: _ua, references: ra, ...restA } = a;
  const { updatedAt: _ub, references: rb, ...restB } = b;
  const pa = ra.pricedb ? { ...ra.pricedb, ageMs: null } : null;
  const pb = rb.pricedb ? { ...rb.pricedb, ageMs: null } : null;
  return sameJson(restA, restB) && sameJson(pa, pb) && sameJson(ra.community, rb.community);
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export const RETENTION = {
  listingsMs: 14 * 24 * 60 * 60 * 1000,
  eventsMs: 90 * 24 * 60 * 60 * 1000,
  requestLogMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Daily purge: listings not seen for 14 days, events older than 90 days and
 * request-log rows older than 7 days. Call engine.markAllDirty() afterwards so
 * opportunities built on purged listings are re-evaluated.
 */
export function runMaintenance(repo: Repo, now: UnixMs): { listings: number; events: number; requests: number } {
  return {
    listings: repo.purgeListingsOlderThan(now - RETENTION.listingsMs),
    events: repo.purgeEventsOlderThan(now - RETENTION.eventsMs),
    requests: repo.purgeRequestLogOlderThan(now - RETENTION.requestLogMs),
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface EngineDeps extends ServiceDeps {
  schema: SchemaService;
  events: EngineEvents;
  /** Injected in tests; defaults to unref'd real timers. */
  timers?: TimerApi;
}

interface SkuInfo {
  obj: SkuObject;
  category: Category;
  isUnusual: boolean;
  name: string | null;
}

interface BaseWork {
  explicit: EngineInput[];
  rules: PriceRule[];
}

const notifyMapSchema = z.record(z.string(), z.unknown());

/** Base SKU of an opportunity SKU without a full parse in the common (unpainted) case. */
function baseOf(sku: string): string {
  return /;p\d/.test(sku) ? toBaseSku(sku) : sku;
}

export function createEngine(deps: EngineDeps): Engine {
  const { repo, log, clock, schema, events } = deps;
  const timers = deps.timers ?? realTimers;

  let started = false;
  let tickTimer: unknown = null;
  let sweepTimer: unknown = null;
  let running = false;
  const dirty = new Set<string>();
  let allDirty = true;
  let lastFingerprint: string | null = null;
  let lastSchemaLoaded: boolean | null = null;
  let lastKeyPrice: KeyPriceState | null = null;
  let runStats: { lastRunAt: UnixMs | null; lastRunMs: number | null; evaluated: number } = { lastRunAt: null, lastRunMs: null, evaluated: 0 };

  // In-memory mirror of the opportunities table. The engine is its only writer; it
  // is reloaded on the first run, after a failed run and on markAllDirty().
  const known = new Map<string, Opportunity>();
  const byBase = new Map<string, Set<string>>();
  const explicitKeys = new Set<string>();
  let indexLoaded = false;

  const infoCache = new Map<string, SkuInfo>();
  let notified: Map<string, number> | null = null;

  // Best raw buy-order value per base SKU, valid until the SKU is marked dirty. Lets a
  // sweep skip loading listings for rule-only SKUs whose orders cannot beat any rule cost.
  const bestRaw = new Map<string, number>();
  let bestRawSince = 0;
  // Effect-specific bases whose bestRaw includes a generic any-effect book, by that generic
  // base: a change to the generic book must invalidate them too, or a rule-only SKU with no
  // stored row keeps a stale bestRaw and the sweep shortcut hides it for up to 10 min.
  const bestRawByGeneric = new Map<string, Set<string>>();

  function setBestRaw(base: string, value: number): void {
    bestRaw.set(base, value);
    const any = anyEffectBaseOf(base);
    if (any === null || any === base) return;
    let set = bestRawByGeneric.get(any);
    if (!set) bestRawByGeneric.set(any, (set = new Set()));
    set.add(base);
  }

  // Buy book per base SKU, invalidated exactly like bestRaw (markDirty, markAllDirty,
  // fingerprint change, periodic refresh), so a warm sweep only reads the books that
  // changed since the last run. Evaluation never mutates listings, so sharing is safe.
  const bookCache = new Map<string, Listing[]>();
  let bookCacheCost = 0;

  function dropBook(base: string): void {
    const b = bookCache.get(base);
    if (b === undefined) return;
    bookCacheCost -= b.length + 1;
    bookCache.delete(base);
  }

  function clearBooks(): void {
    bookCache.clear();
    bookCacheCost = 0;
  }

  function cacheBook(base: string, listings: Listing[]): void {
    dropBook(base);
    // Past the cap new books are simply not cached (read each sweep, as before).
    if (bookCacheCost + listings.length + 1 > BOOK_CACHE_MAX_LISTINGS) return;
    bookCache.set(base, listings);
    bookCacheCost += listings.length + 1;
  }

  function forgetBase(base: string): void {
    bestRaw.delete(base);
    const any = anyEffectBaseOf(base);
    const set = any !== null ? bestRawByGeneric.get(any) : undefined;
    if (any !== null && set) {
      set.delete(base);
      if (set.size === 0) bestRawByGeneric.delete(any);
    }
    dropBook(base);
  }

  /** The effect-specific bases that read this generic book; their own books are unchanged and stay cached. */
  function forgetDependents(generic: string): string[] {
    const set = bestRawByGeneric.get(generic);
    if (!set) return [];
    bestRawByGeneric.delete(generic);
    for (const b of set) bestRaw.delete(b);
    return [...set];
  }

  function forgetAllBases(): void {
    bestRaw.clear();
    bestRawByGeneric.clear();
    clearBooks();
  }

  // ----- helpers -----

  function indexPut(o: Opportunity): void {
    known.set(o.key, o);
    const b = baseOf(o.sku);
    let set = byBase.get(b);
    if (!set) byBase.set(b, (set = new Set()));
    set.add(o.key);
    if (o.inputKind !== 'rule') explicitKeys.add(o.key);
  }

  function indexDel(key: string): void {
    const o = known.get(key);
    if (!o) return;
    known.delete(key);
    explicitKeys.delete(key);
    const b = baseOf(o.sku);
    const set = byBase.get(b);
    if (set) {
      set.delete(key);
      if (set.size === 0) byBase.delete(b);
    }
  }

  function reloadIndex(): void {
    known.clear();
    byBase.clear();
    explicitKeys.clear();
    for (const o of repo.allOpportunities()) indexPut(o);
    indexLoaded = true;
  }

  function info(sku: string): SkuInfo {
    const hit = infoCache.get(sku);
    if (hit) return hit;
    const obj = fromString(sku);
    let category: Category;
    try {
      const c = schema.categoryForSku(sku);
      category = CATEGORIES.includes(c) ? c : categoryOfSkuOnly(obj);
    } catch {
      category = categoryOfSkuOnly(obj);
    }
    const i: SkuInfo = { obj, category, isUnusual: obj.quality === 5 || (typeof obj.effect === 'number' && obj.effect > 0), name: null };
    if (infoCache.size >= SKU_CACHE_MAX) infoCache.clear();
    infoCache.set(sku, i);
    return i;
  }

  function nameOf(sku: string): string {
    const i = info(sku);
    if (i.name === null) {
      try {
        const n = schema.nameForSku(sku);
        i.name = typeof n === 'string' && n.trim() ? n : sku;
      } catch {
        i.name = sku;
      }
    }
    return i.name;
  }

  function schemaLoaded(): boolean {
    try {
      return schema.isLoaded() === true;
    } catch {
      return false;
    }
  }

  function loadNotified(): Map<string, number> {
    if (notified) return notified;
    notified = new Map();
    try {
      const raw = repo.getMeta(NOTIFY_META_KEY);
      if (raw) {
        const parsed = notifyMapSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          for (const [k, v] of Object.entries(parsed.data)) if (typeof v === 'number' && Number.isFinite(v)) notified.set(k, v);
        }
      }
    } catch (err) {
      log.warn('Could not read notification history; starting fresh', { error: String(err) });
    }
    return notified;
  }

  /**
   * Expires entries by age only. A count cap would drop keys still inside the
   * dedup window and re-notify them on the next sweep, forever. The map stays
   * bounded: it only holds keys notified within the window.
   */
  function serializeNotified(map: Map<string, number>, now: UnixMs, dedupMs: number): string {
    for (const [k, ts] of map) if (!(now - ts < dedupMs) || ts > now) map.delete(k);
    return JSON.stringify(Object.fromEntries(map));
  }

  function fingerprintOf(settings: Settings, keyScrap: Scrap, rules: readonly PriceRule[], loaded: boolean): string {
    return stableStringify({
      profit: settings.profit,
      blocklist: [...(settings.blocklist ?? [])].sort(),
      keyScrap,
      loaded,
      rules: rules.map((r) => [r.id, r.enabled, r.costKeys, r.costScrap, r.observedAt, r.filter]),
    });
  }

  // ----- the run -----

  function run(requested: 'full' | 'dirty'): { evaluated: number; ms: number } {
    if (running) return { evaluated: 0, ms: 0 };
    running = true;
    const t0 = performance.now();
    try {
      return runInner(requested, t0);
    } catch (err) {
      // The in-memory state may be ahead of the rolled-back database; resync on the next run.
      allDirty = true;
      indexLoaded = false;
      notified = null;
      throw err;
    } finally {
      running = false;
    }
  }

  function runInner(requested: 'full' | 'dirty', t0: number): { evaluated: number; ms: number } {
    const now = clock.now();
    const settings = deps.settings();
    const p = settings.profit;
    const kp = selectKeyPrice(repo.keyQuotes(), settings, now);
    lastKeyPrice = kp;
    const K = kp.valueScrap;
    const rules = repo.listRules();
    const loaded = schemaLoaded();
    if (lastSchemaLoaded !== null && loaded !== lastSchemaLoaded) infoCache.clear();
    lastSchemaLoaded = loaded;

    const fp = fingerprintOf(settings, K, rules, loaded);
    const full = requested === 'full' || allDirty || !indexLoaded || fp !== lastFingerprint;
    // Cached best values are in scrap at the old key price; also drop them now and then in
    // case a listing writer forgot to mark its SKU dirty.
    if (fp !== lastFingerprint || now - bestRawSince >= BEST_RAW_REFRESH_MS || now < bestRawSince) {
      forgetAllBases();
      bestRawSince = now;
    }
    lastFingerprint = fp;

    const enabledRules = rules.filter(validRule);
    const enabledRuleIds = new Set(enabledRules.map((r) => `rule:${r.id}`));
    const explicitByBase = new Map<string, EngineInput[]>();
    const explicitSkus = new Set<string>();
    const explicitKeyByRef = new Map<string, string>();
    for (const sp of repo.listScrapPrices()) {
      const inp = explicitInput(sp);
      if (!inp) continue;
      let list = explicitByBase.get(inp.baseSku);
      if (!list) explicitByBase.set(inp.baseSku, (list = []));
      list.push(inp);
      explicitSkus.add(inp.sku);
      explicitKeyByRef.set(inp.inputRef, inp.key);
    }

    // ----- scope -----
    let scope: string[];
    let withOrders: Set<string> | null = null;
    const extraDeletes = new Set<string>();
    if (full) {
      if (!indexLoaded) reloadIndex();
      const all = repo.baseSkusWithBuyOrders();
      withOrders = new Set(all);
      const s = new Set<string>(all);
      for (const b of explicitByBase.keys()) s.add(b);
      for (const b of byBase.keys()) s.add(b);
      scope = [...s];
      dirty.clear();
      allDirty = false;
    } else {
      const dirtyNow = new Set(dirty);
      dirty.clear();
      // Generic "any effect" unusual orders are exits for every effect of that item:
      // a change there re-evaluates the effect-specific SKUs that use them.
      if ([...dirtyNow].some((b) => /;5(;|$)/.test(b) && !/;u\d/.test(b))) {
        for (const b of [...explicitByBase.keys(), ...byBase.keys()]) {
          const any = anyEffectBaseOf(b);
          if (any !== null && dirtyNow.has(any) && !dirtyNow.has(b)) {
            dirtyNow.add(b);
            forgetBase(b);
          }
        }
      }
      scope = [...dirtyNow];
      // Prices deleted or moved to another SKU since the last run, even if nobody marked them dirty.
      for (const key of explicitKeys) {
        const o = known.get(key);
        if (o && explicitKeyByRef.get(o.inputRef) !== key) extraDeletes.add(key);
      }
    }

    const match = matchContext(settings, now);
    const friction = nonNegative(p.frictionScrap);
    const cannotProfit = (best: number, rule: PriceRule): boolean => best - valueScrap(rule.costKeys, rule.costScrap, K) - friction <= 0;
    const work = new Map<string, BaseWork>();
    const needListings: string[] = [];
    let evaluated = 0;
    for (const base of scope) {
      const explicit = explicitByBase.get(base) ?? [];
      let ruleList: PriceRule[] = [];
      if (enabledRules.length > 0 && !CURRENCY.has(base) && !explicitSkus.has(base) && (withOrders === null || withOrders.has(base))) {
        const i = info(base);
        if (i.obj.tradable) {
          const subject = { obj: i.obj, category: i.category, name: () => nameOf(base) };
          ruleList = enabledRules.filter((r) => ruleMatches(r.filter, subject));
        }
      }
      if (explicit.length === 0 && ruleList.length === 0) continue;
      if (explicit.length === 0) {
        const best = bestRaw.get(base);
        if (best !== undefined && ruleList.every((r) => cannotProfit(best, r))) {
          // Unchanged order book that cannot beat any matching rule: nothing would be stored.
          evaluated += ruleList.length;
          continue;
        }
      }
      work.set(base, { explicit, rules: ruleList });
      const any = anyEffectBaseOf(base);
      if (withOrders === null || withOrders.has(base) || (any !== null && withOrders.has(any))) needListings.push(base);
    }

    // ----- evaluate -----
    const results = new Map<string, Opportunity>();

    /**
     * `ownBuys`: the base has buy orders of its own. Rules apply only then, in both run
     * modes: a full sweep cannot enumerate effect SKUs that only a generic any-effect
     * book covers, so a dirty run must not create rule rows for them either (they
     * would appear on the tick and be deleted by the next sweep).
     */
    const evaluateBase = (base: string, listings: readonly Listing[], w: BaseWork, ownBuys: boolean): void => {
      let refs: ReferencePrices | null = null;
      const references = (): ReferencePrices => (refs ??= referencePrices(lookupReferences(repo, base), K, now));
      let maxRaw = Number.NEGATIVE_INFINITY;
      for (const l of listings) if (l.intent === 'buy') maxRaw = Math.max(maxRaw, valueScrap(l.keys, l.metalScrap, K));
      setBestRaw(base, maxRaw);

      for (const inp of w.explicit) {
        evaluated++;
        const i = info(inp.sku);
        const opp = evaluateOpportunity({
          input: inp.name ? inp : { ...inp, name: nameOf(inp.sku) },
          listings,
          references: references(),
          category: i.category,
          isUnusual: i.isUnusual,
          settings,
          keyScrap: K,
          now,
          match,
          prev: known.get(inp.key) ?? null,
        });
        results.set(opp.key, opp);
      }

      if (!ownBuys || w.rules.length === 0 || listings.length === 0) {
        evaluated += w.rules.length;
        return;
      }
      const i = info(base);
      for (const rule of w.rules) {
        evaluated++;
        // Cheap upper bound: no order at all beats cost + friction, so the rule row would not be stored.
        if (cannotProfit(maxRaw, rule)) continue;
        const inp = ruleInput(rule, base);
        const opp = evaluateOpportunity({
          input: inp,
          listings,
          references: references(),
          category: i.category,
          isUnusual: i.isUnusual,
          settings,
          keyScrap: K,
          now,
          match,
          prev: known.get(inp.key) ?? null,
        });
        if (!STORED_RULE_STATUSES.has(opp.status)) continue;
        opp.name = nameOf(base);
        results.set(opp.key, opp);
      }
    };

    const listed = new Set(needListings);
    const hasOrders = (b: string): boolean => withOrders === null || withOrders.has(b);
    for (let i = 0; i < needListings.length; i += LISTING_CHUNK) {
      const chunk = needListings.slice(i, i + LISTING_CHUNK);
      // Only books not cached since their last change are read from SQLite.
      const missing = new Set<string>();
      for (const base of chunk) {
        if (hasOrders(base) && !bookCache.has(base)) missing.add(base);
        const any = anyEffectBaseOf(base);
        if (any !== null && hasOrders(any) && !bookCache.has(any)) missing.add(any);
      }
      const read = missing.size > 0 ? repo.buyListingsByBaseSkus([...missing]) : null;
      if (read) for (const [b, list] of read) cacheBook(b, list);
      const bookOf = (b: string): Listing[] => bookCache.get(b) ?? read?.get(b) ?? [];
      for (const base of chunk) {
        const own = hasOrders(base) ? bookOf(base) : [];
        // A generic "any effect" book is combined per run: each part is invalidated by its own markDirty.
        const any = anyEffectBaseOf(base);
        const generic = any !== null && any !== base && hasOrders(any) ? bookOf(any) : [];
        const ownBuys = own.some((l) => l.intent === 'buy');
        evaluateBase(base, generic.length > 0 ? [...own, ...generic] : own, work.get(base)!, ownBuys);
      }
    }
    for (const [base, w] of work) if (!listed.has(base)) evaluateBase(base, [], w, false);

    // ----- diff against what is stored -----
    const upserts: Opportunity[] = [];
    const deletes: string[] = [];
    const evs: Omit<OpportunityEvent, 'id'>[] = [];
    let appeared = 0;
    let changed = 0;
    let gone = 0;
    const fmt = (v: Scrap | null): string => money(v, K);

    for (const [key, opp] of results) {
      const prev = known.get(key) ?? null;
      if (prev) opp.firstSeenAt = prev.firstSeenAt;
      if (!prev || !materiallyEqual(prev, opp)) upserts.push(opp);

      const order = revenueOrderOf(opp, p.useOrder);
      if (opp.status === 'profitable' && prev?.status !== 'profitable') {
        appeared++;
        const m = pct(opp.margin);
        evs.push(eventOf(opp, 'appeared', `profit ${fmt(opp.profitScrap)}${m ? `, ${m} margin` : ''}${buyerTag(order)}`, now));
      } else if (opp.status === 'profitable' && prev?.status === 'profitable') {
        const parts: string[] = [];
        if (Math.abs((opp.profitScrap ?? 0) - (prev.profitScrap ?? 0)) >= CHANGE_PROFIT_DELTA) {
          parts.push(`profit ${fmt(prev.profitScrap)} -> ${fmt(opp.profitScrap)}`);
        }
        if (opp.confidenceLevel !== prev.confidenceLevel) parts.push(`confidence ${prev.confidenceLevel} -> ${opp.confidenceLevel}`);
        const prevOrder = revenueOrderOf(prev, p.useOrder);
        if ((prevOrder?.listingId ?? null) !== (order?.listingId ?? null)) parts.push('new buy order');
        if (parts.length > 0) {
          changed++;
          evs.push(eventOf(opp, 'changed', `${parts.join('; ')}${buyerTag(order)}`, now));
        }
      } else if (prev?.status === 'profitable') {
        gone++;
        const to = opp.profitScrap === null ? 'no buyers' : `${fmt(opp.profitScrap)} (${STATUS_TEXT[opp.status]})`;
        evs.push(eventOf(opp, 'gone', `profit ${fmt(prev.profitScrap)} -> ${to}`, now));
      }
    }

    const existing = full ? [...known.keys()] : scope.flatMap((b) => [...(byBase.get(b) ?? [])]);
    const deleting = new Set<string>();
    for (const key of [...existing, ...extraDeletes]) {
      if (results.has(key) || deleting.has(key)) continue;
      const prev = known.get(key);
      if (!prev) continue;
      deleting.add(key);
      deletes.push(key);
      if (prev.status === 'profitable') {
        gone++;
        let why: string;
        if (prev.inputKind !== 'rule') why = 'scrap.tf price removed';
        else if (!enabledRuleIds.has(prev.inputRef)) why = 'rule removed or disabled';
        else if (explicitSkus.has(prev.sku)) why = 'replaced by your own price';
        else why = 'no longer profitable';
        evs.push(eventOf(prev, 'gone', `profit ${fmt(prev.profitScrap)} -> removed (${why})`, now));
      }
    }

    // ----- notifications -----
    const n = settings.notifications;
    const toNotify: Opportunity[] = [];
    let notifyMeta: string | null = null;
    if (n?.enabled) {
      const dedupMs = Number.isFinite(n.dedupMs) && n.dedupMs > 0 ? n.dedupMs : 0;
      const kinds = notifyKinds(n.inputKinds);
      const last = loadNotified();
      for (const opp of results.values()) {
        if (opp.status !== 'profitable' || opp.profitScrap === null) continue;
        if (opp.confidence < n.minConfidence || opp.profitScrap < n.minProfitScrap) continue;
        // F6: input kinds the user muted; F5: a suspect margin is shown but never toasted.
        if (!kinds.has(opp.inputKind) || opp.flags.includes('suspect-margin')) continue;
        const ts = last.get(opp.key);
        if (ts !== undefined && now - ts < dedupMs && now >= ts) continue;
        toNotify.push(opp);
      }
      if (toNotify.length > 0) {
        toNotify.sort((a, b) => (b.profitScrap ?? 0) - (a.profitScrap ?? 0) || a.key.localeCompare(b.key));
        toNotify.forEach((opp, i) => {
          last.set(opp.key, now);
          if (i < MAX_NOTIFIED_EVENTS_PER_RUN) evs.push(eventOf(opp, 'notified', notificationBody(opp, K, p.useOrder), now));
        });
        notifyMeta = serializeNotified(last, now, Math.max(dedupMs, 1));
      }
    }

    // ----- write -----
    if (upserts.length > 0 || deletes.length > 0 || evs.length > 0 || notifyMeta !== null) {
      repo.transaction(() => {
        repo.upsertOpportunities(upserts);
        repo.deleteOpportunities(deletes);
        repo.appendEvents(evs);
        if (notifyMeta !== null) repo.setMeta(NOTIFY_META_KEY, notifyMeta);
      });
      for (const o of upserts) {
        indexDel(o.key);
        indexPut(o);
      }
      for (const k of deletes) indexDel(k);
    }

    if (toNotify.length > 0) {
      const individual = toNotify.slice(0, MAX_NOTIFICATIONS_PER_RUN);
      for (const opp of individual) {
        safeCall(() => events.onNotify({ title: notificationTitle(opp), body: notificationBody(opp, K, p.useOrder), sku: opp.sku }));
      }
      const rest = toNotify.slice(individual.length);
      if (rest.length > 0) {
        safeCall(() =>
          events.onNotify({
            title: notificationSummaryTitle(rest),
            body: 'They passed your notification thresholds. Open TF2 Flip Desk to see them.',
            sku: null,
          }),
        );
      }
    }

    if (appeared + changed + gone > 0 || upserts.length > 0 || deletes.length > 0) {
      safeCall(() => events.onChanged({ appeared, changed, gone, at: now }));
    }

    const ms = Math.round(performance.now() - t0);
    runStats = { lastRunAt: now, lastRunMs: ms, evaluated };
    if (full) log.debug('Engine full sweep', { evaluated, ms, upserts: upserts.length, deletes: deletes.length });
    return { evaluated, ms };
  }

  function safeCall(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.warn('Engine event listener failed', { error: String(err) });
    }
  }

  function safeRun(mode: 'full' | 'dirty'): void {
    try {
      run(mode);
    } catch (err) {
      log.error('Opportunity engine run failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ----- scheduling -----

  function schedule(delay = DEBOUNCE_MS): void {
    if (!started || tickTimer !== null) return;
    tickTimer = timers.setTimeout(() => {
      tickTimer = null;
      if (!allDirty && dirty.size === 0) return;
      safeRun(allDirty ? 'full' : 'dirty');
    }, delay);
  }

  function armSweep(): void {
    if (!started) return;
    sweepTimer = timers.setTimeout(() => {
      sweepTimer = null;
      safeRun('full');
      armSweep();
    }, SWEEP_INTERVAL_MS);
  }

  return {
    start() {
      if (started) return;
      started = true;
      allDirty = true;
      schedule();
      armSweep();
    },

    stop() {
      started = false;
      if (tickTimer !== null) timers.clearTimeout(tickTimer);
      if (sweepTimer !== null) timers.clearTimeout(sweepTimer);
      tickTimer = null;
      sweepTimer = null;
    },

    markDirty(baseSkus) {
      if (baseSkus === null || baseSkus === undefined || typeof (baseSkus as Iterable<string>)[Symbol.iterator] !== 'function') return;
      for (const s of baseSkus) {
        if (typeof s !== 'string') continue;
        const t = s.trim();
        if (!t) continue;
        const base = baseOf(t);
        dirty.add(base);
        forgetBase(base);
        // A generic any-effect book changed: the effect SKUs that read it are re-evaluated
        // on this tick, including rule-only ones with no stored row (the run's own
        // expansion only covers SKUs with a price or a row).
        for (const b of forgetDependents(base)) dirty.add(b);
        if (dirty.size > MAX_DIRTY) {
          dirty.clear();
          forgetAllBases();
          allDirty = true;
          break;
        }
      }
      if (allDirty || dirty.size > 0) schedule();
    },

    markAllDirty() {
      allDirty = true;
      indexLoaded = false;
      infoCache.clear();
      forgetAllBases();
      schedule();
    },

    async runNow() {
      // An explicit run re-reads every order book; the periodic sweep reuses cached ones.
      if (!running) clearBooks();
      return run('full');
    },

    keyPrice() {
      try {
        return selectKeyPrice(repo.keyQuotes(), deps.settings(), clock.now());
      } catch (err) {
        log.warn('Key price lookup failed', { error: String(err) });
        return lastKeyPrice ?? selectKeyPrice([], deps.settings(), clock.now());
      }
    },

    stats() {
      return { ...runStats };
    },
  };
}

/** settings.notifications.inputKinds as a set; a missing or broken value means every kind (the default). */
export function notifyKinds(v: unknown): ReadonlySet<InputKind> {
  if (!Array.isArray(v)) return new Set(INPUT_KIND_ORDER);
  return new Set(INPUT_KIND_ORDER.filter((k) => v.includes(k)));
}

/** 'Candidate: <name>' for a rule estimate (the user still has to find it on scrap.tf), else 'Profit: <name>'. */
export function notificationTitle(o: Pick<Opportunity, 'inputKind' | 'name' | 'sku'>): string {
  return `${o.inputKind === 'rule' ? 'Candidate' : 'Profit'}: ${o.name || o.sku}`;
}

/** Title of the toast that folds the rest of a burst; rule candidates are not called flips (they are unverified). */
export function notificationSummaryTitle(rest: readonly Pick<Opportunity, 'inputKind'>[]): string {
  const n = rest.length;
  const rules = rest.filter((o) => o.inputKind === 'rule').length;
  if (rules === 0) return `${n} more profitable flip${n === 1 ? '' : 's'}`;
  if (rules === n) return `${n} more candidate${n === 1 ? '' : 's'} to check on scrap.tf`;
  return `${n} more flips and candidates`;
}

/**
 * Rule candidate: 'Check scrap.tf, pay up to <ceiling>. Sells for <revenue> (<bot/human> buyer)'.
 * Typed or imported: '<profit> (<margin>%) — sell to <bot/human> buy order, pay up to <ceiling>'.
 */
export function notificationBody(o: Opportunity, keyScrap: Scrap, useOrder: ProfitSettings['useOrder']): string {
  const order = revenueOrderOf(o, useOrder);
  const buyer = order?.isBot ? 'bot' : 'human';
  const ceiling = typeof o.maxCostScrap === 'number' && Number.isFinite(o.maxCostScrap) ? `, pay up to ${money(o.maxCostScrap, keyScrap)}` : '';
  if (o.inputKind === 'rule') return `Check scrap.tf${ceiling}. Sells for ${money(o.revenueScrap, keyScrap)} (${buyer} buyer)`;
  const m = pct(o.margin);
  return `${money(o.profitScrap, keyScrap)}${m ? ` (${m})` : ''} — sell to ${buyer} buy order${ceiling}`;
}
