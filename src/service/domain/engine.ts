// The "constant check" opportunity engine (design brief §5.6).
//
// Inputs are the user's scrap.tf prices (explicit, per SKU) and enabled
// price-sheet rules (category estimates); exits are backpack.tf buy orders for
// the same base SKU. Dirty base SKUs are evaluated on a debounced tick, and a
// full sweep every 60 s re-evaluates everything so time-based confidence
// (input age, order age, bot pulse) and rule matches stay current.

import { z } from 'zod';
import { buyerPresenceText, orderSeenRecently } from '../../shared/buyerSeen';
import { categoryOfSkuOnly, scraptfBankForItem, type CategoryItemInfo } from '../../shared/categories';
import { copyExtrasWords, markSharedBuyers, opportunityCopyKey } from '../../shared/copyExtras';
import { formatScrap, valueScrap } from '../../shared/currency';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { bankForCategory } from '../../shared/links';
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
  ScraptfBank,
  ScraptfListKey,
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
import { bookBasesOf, canonicalBookBase, mergedBook, twinBasesOf } from './bookTwins';
import type { MatchContext, MatchTarget } from './matcher';
import {
  computePrices,
  isUnverifiedOrder,
  lookupReferences,
  lookupTwinReferences,
  outlierRefs,
  pickRevenueOrder,
  referencePrices,
  toOrderSummary,
  usableReferences,
  valueOrders,
} from './pricing';
import type { PriceResult, ValuedOrder } from './pricing';
import { SINGLE_EXIT_TEXT, buyerDepthOf, flipProfit, flipProfitBound, singleExitOf, singleExitReason, type ExitOrder } from '../../shared/ceiling';
import { boundRuleCost, ruleUnderScraptfReason, type ScraptfSeenPrice } from '../../shared/ruleEvidence';
import { HOLDING_MARKS_MAX_AGE_MS } from '../../shared/holdingAdvice';
import { ORDER_SPELLS_MAX_AGE_MS } from '../../shared/orderPersistence';
import { COMMUNITY_HISTORY_MAX_AGE_MS } from '../../shared/communityHistory';
import { SCRAPTF_LOWS_MAX_AGE_MS } from '../../shared/scraptfLows';
import { INPUT_KIND_ORDER, maxCostFor, profitStatus, profitTier } from './tiers';
import { withCheckoutGuard } from '../../shared/checkoutGuard';
import { depthGateOk, exitDepthOf, exitRiskAt, minProfitableDepthOf, opportunityRiskFields } from '../../shared/exitRisk';

export const DEBOUNCE_MS = 1000;
export const SWEEP_INTERVAL_MS = 60_000;
/** A profitable row emits 'changed' when its profit moves by at least 1 ref. */
export const CHANGE_PROFIT_DELTA: Scrap = 9;
/**
 * Repo meta key holding { opportunityKey: NotifyRecord } (0.7.1). Before 0.7.1 it held
 * { opportunityKey: lastNotifiedAt }; such entries still parse, as records without a fingerprint.
 */
export const NOTIFY_META_KEY = 'engine.lastNotified';
/**
 * Individual toasts per run, one per SKU (copies of one SKU share the most profitable copy's toast); the
 * rest are folded into one summary toast.
 */
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
  /** 0.7.4 (F66): Opportunity.copyKey of a price input (opportunityCopyKey); absent for rules and plain copies. */
  copyKey?: string;
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
  /**
   * 0.7.4 (F70): the input base's craftability twin for the cost check (scoreConfidence's `twin`); its
   * references are read only when the cost is far under the item's own PriceDB band. Omitted: no twin check.
   */
  twin?: { craftable: boolean; references(): ReferencePrices | null } | null;
}

export function revenueOrderOf(o: Pick<Opportunity, 'bestOrder' | 'consOrder' | 'instantOrder'>, useOrder: ProfitSettings['useOrder']): OrderSummary | null {
  return pickRevenueOrder({ best: o.bestOrder, conservative: o.consOrder, instant: o.instantOrder }, useOrder);
}

/** Row flags that keep a row from ever being toasted (the engine's notification gates), so no snapshot is spent on its upside. */
const UPSIDE_MUTED_FLAGS = ['stale-input', 'variant-suspect', 'cost-below-market', 'suspect-margin'] as const;

/**
 * 0.7.4 (F16, F24, F30): the profit a row would make on its best order when that order is unverified (no feed
 * event or snapshot for 24 h), no outlier, and would clear the profit thresholds against the row's cost
 * (profitStatus), while computePrices' preference for verified orders prices the row lower or not at all. A
 * snapshot of the row's book may confirm such a flip (core.snapshotPriority ranks it after the unconfirmed
 * profitable and below-threshold rows). Null otherwise: no best order, a verified or outlier one, an
 * any-effect order (another base's book, which a name snapshot of this item never returns), or a row the
 * notification gates mute anyway (stale input, a cost check, a suspect margin).
 */
export function unverifiedUpside(o: Pick<Opportunity, 'bestOrder' | 'costScrap' | 'flags'>, p: ProfitSettings): Scrap | null {
  const best = o.bestOrder;
  if (!best || !best.flags.includes('unverified') || best.flags.includes('outlier') || best.flags.includes('any-effect')) return null;
  if (typeof o.costScrap !== 'number' || !Number.isFinite(o.costScrap) || !Number.isFinite(best.valueScrap)) return null;
  if (UPSIDE_MUTED_FLAGS.some((f) => o.flags.includes(f))) return null;
  // 0.8 (PC-1): judged with the price-move reserve, as every buy decision is.
  const profit = flipProfit(best.valueScrap, o.costScrap, p);
  return profit !== null && profitStatus(profit, o.costScrap, p) === 'profitable' ? profit : null;
}

/** A clean copy of `base` (no paint, spells or parts), with the any-effect base for an unusual: what rules and the Live market price. */
export function cleanTarget(base: string): MatchTarget {
  return { baseSku: base, special: { ...EMPTY_SPECIAL, spells: [], parts: [] }, anyEffectBase: anyEffectBaseOf(base) };
}

export interface PricedBook {
  /** Eligible orders valued at the key price, best first. */
  eligible: ValuedOrder[];
  prices: PriceResult<ValuedOrder>;
}

/**
 * A buy book priced for one target, exactly as an opportunity row is: deduplicated,
 * classified, valued, then best / conservative / instant with outliers. Shared with the
 * Live market so both read the same book the same way.
 */
export function priceBook(
  listings: readonly Listing[],
  target: MatchTarget,
  references: ReferencePrices,
  p: Pick<ProfitSettings, 'outlierVsMedian' | 'outlierVsRef' | 'referenceMaxAgeMs'>,
  keyScrap: Scrap,
  now: UnixMs,
  match: MatchContext,
): PricedBook {
  const { kept } = dedupeOrders(listings.filter((l) => l.intent === 'buy'));
  const classified = kept.map((listing) => ({ listing, ...classifyOrder(listing, target, match) }));
  const eligible = valueOrders(
    classified.filter((o) => o.eligible),
    keyScrap,
  );
  // F4: a stale reference must not mark current orders as outliers; scoreConfidence gates its own use the same way.
  const prices = computePrices(eligible, outlierRefs(usableReferences(references, p.referenceMaxAgeMs, now).references), p);
  return { eligible, prices };
}

/** Distinct buyers among eligible orders (a listing without a SteamID counts on its own). */
export function buyerCountOf(eligible: readonly { listing: Listing }[]): number {
  return new Set(eligible.map((o) => o.listing.steamid || o.listing.id)).size;
}

/** 0.8 (PC-2, H2): a priced book's eligible orders as buyerDepthOf reads them (buyerCountOf's buyer rule). */
export function exitOrdersOfBook(book: PricedBook): ExitOrder[] {
  return book.eligible.map((o) => ({
    id: o.listing.id,
    buyer: o.listing.steamid || o.listing.id,
    valueScrap: o.valueScrap,
    keys: Number.isFinite(o.listing.keys) ? o.listing.keys : 0,
    metalScrap: Number.isFinite(o.listing.metalScrap) ? o.listing.metalScrap : 0,
    isBot: o.listing.isBot === true,
    online: o.listing.userOnline ?? null,
    lastEventAt: o.listing.lastEventAt,
    outlier: book.prices.outlierIds.has(o.listing.id),
    unverified: isUnverifiedOrder(o),
  }));
}

/** The row flags derived from a priced book plus the confidence flags, in the engine's order. */
export function bookFlags(book: PricedBook, confFlags: readonly string[], revenueScrap: Scrap | null, keyScrap: Scrap): string[] {
  const { prices, eligible } = book;
  const flags: string[] = [];
  if (prices.best && prices.outlierIds.has(prices.best.listing.id)) flags.push('outlier-best');
  if (eligible.length > 0 && prices.conservative === null) flags.push('all-outliers');
  for (const f of confFlags) if (!flags.includes(f)) flags.push(f);
  // Brief §5.8: informational only, the user decides.
  if (revenueScrap !== null && keyScrap > 0 && revenueScrap > BACKGROUND_CHECK_KEYS * keyScrap) flags.push('background-check');
  return flags;
}

/**
 * A stored row's revenue order when useOrder is not at hand (CSV, shopping list).
 * computePrices sorts ties bots first and its outlier test depends only on the value, so
 * conservative and instant with the same value are the same order. 0.7.4: best may be an
 * unverified order worth exactly the verified conservative one; the conservative order is
 * checked first, so such a tie names the verified buyer (the value is the same either way).
 */
export function revenueOrderByValue(o: Pick<Opportunity, 'revenueScrap' | 'bestOrder' | 'consOrder' | 'instantOrder'>): OrderSummary | null {
  if (o.revenueScrap === null) return null;
  return [o.consOrder, o.bestOrder, o.instantOrder].find((x) => x !== null && x !== undefined && x.valueScrap === o.revenueScrap) ?? null;
}

export function evaluateOpportunity(a: EvaluateArgs): Opportunity {
  const { input, settings, keyScrap, now } = a;
  const p = settings.profit;
  const costScrap = valueScrap(input.costKeys, input.costScrapRaw, keyScrap);

  const book = priceBook(a.listings, input.target, a.references, p, keyScrap, now, a.match);
  const { eligible, prices } = book;
  const summary = (o: (typeof eligible)[number] | null): OrderSummary | null =>
    o ? toOrderSummary(o, prices.outlierIds.has(o.listing.id) ? ['outlier'] : []) : null;

  const revenueOrder = pickRevenueOrder(prices, p.useOrder);
  const revenueScrap = revenueOrder?.valueScrap ?? null;
  const profitScrap = flipProfit(revenueScrap, costScrap, p);
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
    // 0.7.4 (F22, F70): the cost against PriceDB for this item and its craftability twin.
    costScrap,
    twin: a.twin ?? null,
    keyScrap,
    now,
    profit: p,
  });

  const flags = bookFlags(book, conf.flags, revenueScrap, keyScrap);
  const status = profitStatus(profitScrap, costScrap, p);
  // 0.9 (#3): the book read once, on every row, for the next buyer (PC-2) and the risk keys. It was read on profitable rows only.
  const orders = exitOrdersOfBook(book);
  const depth = buyerDepthOf(orders, revenueOrder?.listing.id ?? null, p.useOrder);
  // 0.8 (PC-2): the flip rests on the revenue order's buyer alone: a warning and a 0-delta reason, the score unchanged.
  const single = status === 'profitable' ? singleExitOf(revenueScrap, costScrap, depth.nextBuyer, p) : null;
  // 0.9 (#3): profit if this buyer leaves, buyers at break-even and the book depth, at this row's cost. Never a probability.
  const risk = exitRiskAt({ exitDepth: exitDepthOf(orders, p.useOrder), nextBuyer: depth.nextBuyer }, costScrap, p);
  if (single) {
    flags.push('single-exit');
    conf.reasons.push(singleExitReason(single, (v) => formatScrap(v, keyScrap > 0 ? keyScrap : null)));
  }

  return {
    key: input.key,
    sku: input.sku,
    name: input.name,
    category: a.category,
    inputRef: input.inputRef,
    inputKind: input.inputKind,
    ...(input.copyKey ? { copyKey: input.copyKey } : {}),
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
    ...opportunityRiskFields(risk),
    confidence: conf.score,
    confidenceLevel: conf.level,
    flags,
    reasons: conf.reasons,
    buyerCount: buyerCountOf(eligible),
    bestOrder: summary(prices.best),
    consOrder: summary(prices.conservative),
    instantOrder: summary(prices.instant),
    references: a.references,
    profitTier: profitTier(profitScrap, keyScrap),
    status,
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
  // 0.7.4 (F66): the copy this price is for, as the repo derives it on read.
  const copyKey = opportunityCopyKey(sp.sku, sp.special);
  return {
    key: `${sku}|${inputRef}`,
    sku,
    baseSku: base,
    inputRef,
    ...(copyKey !== '' ? { copyKey } : {}),
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
    target: cleanTarget(base),
  };
}

/**
 * 0.7.4 (F27, F33): copies of one item (one base's typed and imported prices) whose revenue comes from the same
 * buy order: every copy but the most profitable is flagged 'shared-buyer' (markSharedBuyers in
 * src/shared/copyExtras.ts, which the mock applies too), so totals count that order once.
 */
export function markSharedCopies(rows: readonly Opportunity[], useOrder: ProfitSettings['useOrder']): void {
  markSharedBuyers(rows, (o) => revenueOrderOf(o, useOrder));
}

/** An enabled rule with a usable cost and filter (the engine and the Live market skip the rest). */
export function validRule(r: PriceRule): boolean {
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

/** " (bot, online)"; 0.7.4 (F23): an order not seen for CONFIRMED_MS says " (bot, last seen 4 d ago)" instead. */
function buyerTag(o: OrderSummary | null, now: UnixMs): string {
  if (!o) return '';
  const parts = [o.isBot ? 'bot' : 'human'];
  if (!orderSeenRecently(o.lastEventAt, now)) {
    if (Number.isFinite(o.lastEventAt)) parts.push(buyerPresenceText(o, now));
  } else if (o.online === true) parts.push('online');
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

/**
 * Equal in everything that matters to the user; the evaluation time and the PriceDB age (recomputed on read) do
 * not, nor (0.7.4, F66) the copy key, which is derived from the price row on every read and never stored.
 */
function materiallyEqual(a: Opportunity, b: Opportunity): boolean {
  const { updatedAt: _ua, references: ra, copyKey: _ca, ...restA } = a;
  const { updatedAt: _ub, references: rb, copyKey: _cb, ...restB } = b;
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
  /** Saved scrap.tf/items list rows (F14): a month-old stock or price says nothing about today. */
  scraptfListMs: 30 * 24 * 60 * 60 * 1000,
  /** 0.8 (H1): recorded exit runs; each base also keeps at most HOLDING_MARKS_PER_BASE_MAX. */
  holdingMarksMs: HOLDING_MARKS_MAX_AGE_MS,
  /** 0.9 (history): ended buy-order spells by first_seen_at; also at most 300 per base and 400,000 in all (a ceiling: the caps usually bind first). */
  orderSpellsMs: ORDER_SPELLS_MAX_AGE_MS,
  /** 0.9 (history): recorded community price points by recorded_at; also at most 200 per SKU and 300,000 in all. */
  communityHistoryMs: COMMUNITY_HISTORY_MAX_AGE_MS,
  /** 0.9 (history): stored scrap.tf lows whose copy was not on sale in a save for this long. */
  scraptfLowsMs: SCRAPTF_LOWS_MAX_AGE_MS,
} as const;

/**
 * Daily purge: listings not seen for 14 days, events older than 90 days,
 * request-log rows older than 7 days, saved scrap.tf list rows older than 30
 * days, bank stock past its retention (F20 thinning: every save of the last day,
 * hourly to 7 days, daily to 90 days, at most 300 per page, a page's newest save and
 * the one it is compared with always kept; rows whose batch is gone too), scrap.tf
 * change events older than 90 days (F20), (0.8, H1) recorded exit runs older than
 * 180 days or beyond 2,000 per item, and (0.9) buy-order spells older than 60 days or
 * beyond 300 per item or 400,000, community price points older than 365 days or beyond
 * 200 per SKU or 300,000, and scrap.tf lows not on sale in a save for 365 days. Call
 * engine.markAllDirty() afterwards so opportunities built on purged listings are
 * re-evaluated, and refresh the list, bank stock and history caches when their rows went.
 */
export function runMaintenance(
  repo: Repo,
  now: UnixMs,
): {
  listings: number;
  events: number;
  requests: number;
  scraptfList: number;
  bankStock: number;
  scraptfEvents: number;
  holdingMarks: number;
  orderSpells: number;
  communityHistory: number;
  scraptfLows: number;
} {
  return {
    listings: repo.purgeListingsOlderThan(now - RETENTION.listingsMs),
    events: repo.purgeEventsOlderThan(now - RETENTION.eventsMs),
    requests: repo.purgeRequestLogOlderThan(now - RETENTION.requestLogMs),
    scraptfList: repo.purgeScraptfListOlderThan(now - RETENTION.scraptfListMs),
    bankStock: repo.pruneBankStock(now, { orphans: true }),
    scraptfEvents: repo.pruneScraptfEvents(now),
    holdingMarks: repo.pruneHoldingMarks(now),
    orderSpells: repo.pruneOrderSpells(now, { maxAgeMs: RETENTION.orderSpellsMs }),
    communityHistory: repo.pruneCommunityHistory(now, { maxAgeMs: RETENTION.communityHistoryMs }),
    scraptfLows: repo.pruneScraptfLows(now, RETENTION.scraptfLowsMs),
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
  /**
   * F14: scrap.tf's key prices from the saved scrap.tf/items list (core: scraptfList.keyRow()), passed to
   * selectKeyPrice. Omitted (tests, or no list): the key price is exactly as before.
   */
  scraptfKey?(): ScraptfListKey | null;
  /**
   * F17: whether the user was already told about this opportunity's item by another notification (core:
   * an imported item that a "New on scrap.tf" toast named moments ago, newFlipNotifier.toldRecently; from
   * 0.7.1 also a price the user typed or saved from the check popup minutes ago, ACT-7). Such an
   * opportunity is recorded as notified, fingerprint included, so it is not toasted later either unless
   * something changes, but sends no second toast. Omitted (tests): every qualifying opportunity is toasted.
   */
  toldElsewhere?(opp: Pick<Opportunity, 'sku' | 'inputKind' | 'inputObservedAt' | 'firstSeenAt'>, now: UnixMs): boolean;
  /**
   * 0.7.1 (ACT-3): the user recorded a scrap.tf buy of this base SKU at or after `at` (the input's
   * observedAt), so the toast would be about the item just bought (core: the journal's newest scrap.tf buy
   * per base). For a rule candidate `at` is the later of the rule's time and now minus
   * profit.inputStaleMs. Nothing is recorded, so a newer price of it toasts again; rows are unchanged.
   * Omitted or failing: toasted as before.
   */
  boughtSince?(baseSku: string, at: UnixMs): boolean;
  /**
   * 0.7.1 (ACT-8): when the user last saw a bank page whole (core: its newest bank stock save, which a
   * partial or unsettled look does not write), or null. A rule candidate is a base with no price of its
   * own, so on a single-page bank seen whole within profit.inputStaleMs it was not on the page: no
   * "Candidate:" toast (the row and verdict are unchanged). Omitted or failing: toasted as before.
   */
  recentBankSaveAt?(bank: ScraptfBank): UnixMs | null;
  /**
   * F17: every opportunity a run toasted, individually or in its summary (core: the import ones go to
   * newFlipNotifier.toastedElsewhere). At start-up the engine judges an import held for the Live market's
   * first build before the "New on scrap.tf" notifier can, so that notifier needs to hear of these to
   * keep one toast per find. Optional; a failing hook changes nothing here.
   */
  notified?(opps: readonly Pick<Opportunity, 'sku' | 'inputKind'>[], now: UnixMs): void;
  /**
   * 0.7.4 (F78): the highest price scrap.tf itself showed the plain copy of a base on sale for (core:
   * scraptfSeenPriceOf over the saved /items list and the history's runs of the retained bank saves, in
   * memory). A rule row is evaluated at the higher of the rule's cost and it, flagged 'rule-under-scraptf'.
   * Omitted or failing: the rule's cost, as before.
   */
  scraptfSeenPriceOf?(baseSku: string, keyScrap: Scrap): ScraptfSeenPrice | null;
  /**
   * 0.8 (G1): the profit target the user's watches set for this copy of a base (core: watchFloorOf over the watch cache
   * while notifications.watches is on), or null. A typed or imported opportunity of a watched copy is toasted at that bar
   * instead of notifications.minProfitScrap, titled "Watch: <name>"; every other gate (status 'profitable', confidence,
   * input kinds, suspect, stale input, unverified order, dedupe and fingerprint, ACT-3, ACT-8, told elsewhere) is unchanged.
   * Omitted or failing: notifications.minProfitScrap, as before.
   */
  watchFloorFor?(baseSku: string, copyKey: string): Scrap | null;
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
const notifyRecordSchema = z.union([
  // Before 0.7.1: the time alone.
  z.number(),
  z.object({ t: z.number(), f: z.object({ obs: z.number(), lid: z.string().nullable(), p: z.number().nullable() }).nullable() }),
]);

/** Base SKU of an opportunity SKU without a full parse in the common (unpainted) case. */
function baseOf(sku: string): string {
  return /;p\d/.test(sku) ? toBaseSku(sku) : sku;
}

/** DC-5: an australium SKU; an unreadable one is not (ACT-8 then judges it by its category, as before). */
function isAustralium(sku: string): boolean {
  try {
    return fromString(sku).australium === true;
  } catch {
    return false;
  }
}

export function createEngine(deps: EngineDeps): Engine {
  const { repo, log, clock, schema, events } = deps;
  const timers = deps.timers ?? realTimers;
  /** 0.7.4 (F66): a paint's name for a "Profit:" title (the item schema's); null when unknown or unreadable. */
  const paintNameOf = (decimal: number): string | null => {
    try {
      const name = schema.paintByDecimal(decimal)?.name;
      return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
    } catch {
      return null;
    }
  };
  /** F14: the saved list's key row; a failed read must not stop the key price. */
  const scraptfKey = (): ScraptfListKey | null => {
    try {
      return deps.scraptfKey?.() ?? null;
    } catch (err) {
      log.warn('Could not read the scrap.tf list key price', { error: String(err) });
      return null;
    }
  };

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
  let notified: Map<string, NotifyRecord> | null = null;

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

  function loadNotified(): Map<string, NotifyRecord> {
    if (notified) return notified;
    try {
      notified = parseNotifyRecords(repo.getMeta(NOTIFY_META_KEY));
    } catch (err) {
      notified = new Map();
      log.warn('Could not read notification history; starting fresh', { error: String(err) });
    }
    return notified;
  }

  /**
   * Never a count cap: it would drop keys still inside the dedup window and re-notify them on the next
   * sweep, forever. Inside the window every record stays. Past it a record stays only while it has a
   * fingerprint and its row is still stored (the fingerprint is what holds an unchanged row back, ACT-2),
   * so the map is bounded by the stored rows plus the keys told within the window.
   */
  function serializeNotified(map: Map<string, NotifyRecord>, now: UnixMs, dedupMs: number, stored: (key: string) => boolean): string {
    for (const [k, r] of map) {
      if (r.t > now) map.delete(k);
      else if (now - r.t >= dedupMs && (r.f === null || !stored(k))) map.delete(k);
    }
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
    const kp = selectKeyPrice(repo.keyQuotes(), settings, now, scraptfKey());
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
      // 0.7.4 (F09/F14): a book filed under defindex twins is one item, evaluated once on its canonical base.
      const s = new Set<string>(all.map((b) => canonicalBookBase(schema, b)));
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
    const cannotProfit = (best: number, rule: PriceRule): boolean => flipProfitBound(best, valueScrap(rule.costKeys, rule.costScrap, K), p) <= 0;
    const work = new Map<string, BaseWork>();
    const needListings: string[] = [];
    let evaluated = 0;
    // 0.7.4 (F09/F14): a book is the base's own rows and its twins' (bookTwins.ts).
    const ordersIn = (b: string): boolean => withOrders === null || bookBasesOf(schema, b).some((t) => withOrders!.has(t));
    for (const base of scope) {
      const explicit = explicitByBase.get(base) ?? [];
      let ruleList: PriceRule[] = [];
      // 0.7.4: rule rows only on the canonical base of a book, and not beside a price of yours on a twin.
      const ruleBase = enabledRules.length > 0 && canonicalBookBase(schema, base) === base && !bookBasesOf(schema, base).some((t) => explicitSkus.has(t));
      if (ruleBase && !CURRENCY.has(base) && !explicitSkus.has(base) && ordersIn(base)) {
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
      if (ordersIn(base) || (any !== null && ordersIn(any))) needListings.push(base);
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
      const references = (): ReferencePrices => (refs ??= referencePrices(lookupReferences(repo, base, schema), K, now));
      // 0.7.4 (F70): the craftability twin's references, read at most once per base and only when a cost
      // is far under this item's PriceDB band (scoreConfidence asks), so most bases never look it up.
      let twinRefs: ReferencePrices | null | undefined;
      const twin = {
        get craftable(): boolean {
          return !info(base).obj.craftable;
        },
        references: (): ReferencePrices | null => {
          if (twinRefs === undefined) {
            const raw = lookupTwinReferences(repo, base);
            twinRefs = raw === null ? null : referencePrices(raw, K, now);
          }
          return twinRefs;
        },
      };
      let maxRaw = Number.NEGATIVE_INFINITY;
      for (const l of listings) if (l.intent === 'buy') maxRaw = Math.max(maxRaw, valueScrap(l.keys, l.metalScrap, K));
      setBestRaw(base, maxRaw);

      const copies: Opportunity[] = [];
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
          twin,
        });
        results.set(opp.key, opp);
        copies.push(opp);
      }
      // 0.7.4 (F27, F33): several copies of the item priced against one buy order (a kit's sheen combos, two
      // painted hats); a buyer may take only one.
      if (copies.length > 1) markSharedCopies(copies, p.useOrder);

      if (!ownBuys || w.rules.length === 0 || listings.length === 0) {
        evaluated += w.rules.length;
        return;
      }
      const i = info(base);
      // 0.7.4 (F78): what scrap.tf itself showed for this item, read once per base (in memory).
      let seen: ScraptfSeenPrice | null | undefined;
      for (const rule of w.rules) {
        evaluated++;
        // Cheap upper bound: no order at all can leave a profit at this cost after friction and the price-move
        // reserve (flipProfitBound), so the rule row would not be stored.
        if (cannotProfit(maxRaw, rule)) continue;
        if (seen === undefined) seen = safeSeenPrice(base, K);
        // 0.7.4 (F78): a rule never undercuts a price scrap.tf showed; the row is then judged at that price.
        const bound = boundRuleCost(rule, seen, K);
        const own = ruleInput(rule, base);
        const inp = bound.underScraptf ? { ...own, costKeys: bound.costKeys, costScrapRaw: bound.costScrapRaw } : own;
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
        if (bound.underScraptf && seen) {
          // Before the 0.8 single-exit flag and reason, which stay last (as the mock's evaluateOpportunity writes them).
          const flagAt = opp.flags.indexOf('single-exit');
          opp.flags.splice(flagAt < 0 ? opp.flags.length : flagAt, 0, 'rule-under-scraptf');
          const reasonAt = opp.reasons.findIndex((x) => x.startsWith(`0 ${SINGLE_EXIT_TEXT}`));
          opp.reasons.splice(reasonAt < 0 ? opp.reasons.length : reasonAt, 0, ruleUnderScraptfReason(seen, valueScrap(rule.costKeys, rule.costScrap, K), K));
        }
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
        // 0.7.4 (F09/F14, F08): the twins' books too, each cached on its own base.
        for (const b of bookBasesOf(schema, base)) if (hasOrders(b) && !bookCache.has(b)) missing.add(b);
        const any = anyEffectBaseOf(base);
        if (any !== null) for (const b of bookBasesOf(schema, any)) if (hasOrders(b) && !bookCache.has(b)) missing.add(b);
      }
      const read = missing.size > 0 ? repo.buyListingsByBaseSkus([...missing]) : null;
      if (read) for (const [b, list] of read) cacheBook(b, list);
      const bookOf = (b: string): Listing[] => (hasOrders(b) ? (bookCache.get(b) ?? read?.get(b) ?? []) : []);
      for (const base of chunk) {
        const own = mergedBook(base, bookBasesOf(schema, base), bookOf);
        // A generic "any effect" book is combined per run: each part is invalidated by its own markDirty.
        const any = anyEffectBaseOf(base);
        const generic = any !== null && any !== base ? mergedBook(any, bookBasesOf(schema, any), bookOf) : [];
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
        evs.push(eventOf(opp, 'appeared', `profit ${fmt(opp.profitScrap)}${m ? `, ${m} margin` : ''}${buyerTag(order, now)}`, now));
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
          evs.push(eventOf(opp, 'changed', `${parts.join('; ')}${buyerTag(order, now)}`, now));
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
    // 0.8 (G1): the opportunities toasted at a watch's profit target ("Watch: <name>").
    const watchedKeys = new Set<string>();
    let notifyMeta: string | null = null;
    if (n?.enabled) {
      const dedupMs = Number.isFinite(n.dedupMs) && n.dedupMs > 0 ? n.dedupMs : 0;
      const kinds = notifyKinds(n.inputKinds);
      const staleMs = inputStaleMsOf(p);
      const last = loadNotified();
      let toldElsewhere = 0;
      const minDepth = minProfitableDepthOf(n.minProfitableDepth);
      for (const opp of results.values()) {
        if (opp.status !== 'profitable' || opp.profitScrap === null) continue;
        // 0.8 (G1): a watched copy's own profit target is its bar (typed and imported prices; a rule candidate never).
        const floor = opp.inputKind === 'rule' ? null : safeFloor(opp);
        if (opp.confidence < n.minConfidence || opp.profitScrap < (floor ?? n.minProfitScrap)) continue;
        // F6: input kinds the user muted; F5: a suspect margin is shown but never toasted.
        if (!kinds.has(opp.inputKind) || opp.flags.includes('suspect-margin')) continue;
        // ACT-2: a price this old may be long gone from scrap.tf. The row stays in the lists; it is not news.
        // 0.7.4 (F22, F70): nor is a cost far under what bots pay for this item (likely another copy's price).
        if (opp.flags.includes('stale-input') || opp.flags.includes('variant-suspect') || opp.flags.includes('cost-below-market')) continue;
        const print = notifyFingerprintOf(opp, p.useOrder);
        const told = last.get(opp.key);
        if (told !== undefined) {
          if (now - told.t < dedupMs && now >= told.t) continue;
          // ACT-2: past the window, only a new sighting, a new buyer or more profit is worth a toast.
          if (!notifyWorthRepeating(told.f, print)) continue;
        }
        // ACT-3 and ACT-8: the item just bought, or a candidate a fresh save shows is not on its page. Not
        // recorded: a newer price, or a save that has gone stale, toasts again.
        if (safeBought(opp, now, staleMs) || absentFromFreshSave(opp, now, staleMs)) continue;
        // 0.7.4 (F13, F21, F47): the order the profit rests on has not been seen for 24 h and may be gone
        // (the feed has no catch-up after the app or the feed was off). Not recorded: the row toasts once a
        // snapshot or a feed event confirms it. Core's snapshotPriority reads the stored row (a profitable one
        // on an unconfirmed order) and the background snapshot job confirms its book first, most profit first.
        if (revenueOrderOf(opp, p.useOrder)?.flags.includes('unverified')) continue;
        // 0.9 (#3, risk control): fewer buyers seen in the last 24 h clear break-even at this cost than notifications.
        // minProfitableDepth asks for. Not recorded: the row is told once enough are there (on a later run that evaluates it).
        if (minDepth > 0 && !depthGateOk(opp.profitableDepth, minDepth)) continue;
        // F17: the "New on scrap.tf" toast already named this item; one toast per find.
        if (deps.toldElsewhere && safeTold(opp, now)) {
          last.set(opp.key, { t: now, f: print });
          toldElsewhere++;
          continue;
        }
        if (floor !== null) watchedKeys.add(opp.key);
        toNotify.push(opp);
      }
      if (toNotify.length > 0) {
        toNotify.sort((a, b) => (b.profitScrap ?? 0) - (a.profitScrap ?? 0) || a.key.localeCompare(b.key));
        toNotify.forEach((opp, i) => {
          last.set(opp.key, { t: now, f: notifyFingerprintOf(opp, p.useOrder) });
          if (i < MAX_NOTIFIED_EVENTS_PER_RUN) evs.push(eventOf(opp, 'notified', notificationBody(opp, K, p.useOrder), now));
        });
      }
      if (toNotify.length > 0 || toldElsewhere > 0) {
        // Rows this run keeps, so a record outlives the window only while its row exists.
        const stored = (key: string): boolean => !deleting.has(key) && (results.has(key) || known.has(key));
        notifyMeta = serializeNotified(last, now, Math.max(dedupMs, 1), stored);
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
      // Before the toasts: the summary's items count as told too.
      if (deps.notified) safeCall(() => deps.notified?.(toNotify, now));
      // 0.7.3: one toast per item. Copies stored under one SKU (a kit's or killstreak weapon's sheen/killstreaker
      // combos, painted or spelled copies) share their most profitable copy's toast (toNotify is sorted by
      // profit); the others were recorded as told above, so the next run does not toast them either.
      const seenSku = new Set<string>();
      const leads = toNotify.filter((o) => {
        if (seenSku.has(o.sku)) return false;
        seenSku.add(o.sku);
        return true;
      });
      const individual = leads.slice(0, MAX_NOTIFICATIONS_PER_RUN);
      for (const opp of individual) {
        // 0.9 (#9): a watch's own toast (G1) suggests buying the scrap.tf copy, so its body gains the checkout guard's
        // short sentence when it still fits (withCheckoutGuard). "Profit:" and "Candidate:" toasts keep their bodies.
        const watched = watchedKeys.has(opp.key);
        const body = notificationBody(opp, K, p.useOrder);
        safeCall(() => events.onNotify({ title: notificationTitle(opp, paintNameOf, watched), body: watched ? withCheckoutGuard(body) : body, sku: opp.sku }));
      }
      const rest = leads.slice(individual.length);
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

  /**
   * 0.8 (G1): deps.watchFloorFor for this opportunity's copy (its base and copyKey, '' plain), a finite number >= 0 or
   * null. Without the hook, or when it fails (logged), null: notifications.minProfitScrap, as before.
   */
  function safeFloor(opp: Opportunity): Scrap | null {
    if (!deps.watchFloorFor) return null;
    try {
      const floor = deps.watchFloorFor(baseOf(opp.sku), opp.copyKey ?? '');
      return typeof floor === 'number' && Number.isFinite(floor) && floor >= 0 ? floor : null;
    } catch (err) {
      log.warn('Engine notification check failed', { error: String(err) });
      return null;
    }
  }

  /** A failing check toasts as before: a second toast beats a lost one. */
  function safeTold(opp: Opportunity, now: UnixMs): boolean {
    try {
      return deps.toldElsewhere?.(opp, now) === true;
    } catch (err) {
      log.warn('Engine notification check failed', { error: String(err) });
      return false;
    }
  }

  /**
   * ACT-3: a scrap.tf buy of this base recorded at or after the input was seen. A rule's time is when it
   * was written, not a sighting of the item, so for a candidate only a buy within `staleMs` counts (else
   * one buy would mute that base's candidates until the rule is edited). A failing check toasts.
   */
  function safeBought(opp: Opportunity, now: UnixMs, staleMs: number): boolean {
    if (!deps.boughtSince) return false;
    const at = opp.inputKind === 'rule' ? Math.max(opp.inputObservedAt, now - staleMs) : opp.inputObservedAt;
    try {
      return deps.boughtSince(baseOf(opp.sku), at) === true;
    } catch (err) {
      log.warn('Engine notification check failed', { error: String(err) });
      return false;
    }
  }

  /**
   * ACT-8: a rule candidate whose bank is one page (every bank but /unusuals), seen whole within
   * `staleMs`: the item was not on that save. 0.7.4 (F36): the bank an item of its kind is sold on
   * (scraptfBankForItem), so a strange cosmetic is judged by a /buy/hats save and a killstreak weapon by a
   * /buy/items one, not by pages that never list them. DC-5 (0.7.4, F79): an australium only when both its
   * category's page and the items bank (which sells australiums, SCRAPTF_BANKS) were seen whole within
   * `staleMs`; one of them alone is no proof. A failing check toasts.
   */
  function absentFromFreshSave(opp: Opportunity, now: UnixMs, staleMs: number): boolean {
    if (opp.inputKind !== 'rule' || !deps.recentBankSaveAt) return false;
    const banks: Exclude<ScraptfBank, 'list'>[] = isAustralium(opp.sku) ? [...new Set([bankForCategory(opp.category), 'items' as const])] : [ownBankOf(opp.sku, opp.category)];
    if (banks.includes('unusuals')) return false;
    try {
      return banks.every((bank) => {
        const at = deps.recentBankSaveAt!(bank);
        return typeof at === 'number' && Number.isFinite(at) && now - at <= staleMs;
      });
    } catch (err) {
      log.warn('Engine notification check failed', { error: String(err) });
      return false;
    }
  }

  /** 0.7.4 (F78): EngineDeps.scraptfSeenPriceOf; a failing hook is no evidence (the rule's own cost stands). */
  function safeSeenPrice(base: string, K: Scrap): ScraptfSeenPrice | null {
    if (!deps.scraptfSeenPriceOf) return null;
    try {
      return deps.scraptfSeenPriceOf(base, K) ?? null;
    } catch (err) {
      log.warn('Could not read what scrap.tf showed for a rule candidate', { error: String(err) });
      return null;
    }
  }

  /** 0.7.4 (F36): the bank page an item of this kind is sold on, from its schema entry; else its category's. */
  function ownBankOf(sku: string, category: Category): Exclude<ScraptfBank, 'list'> {
    try {
      const obj = info(sku).obj;
      let item: CategoryItemInfo | null = null;
      try {
        item = schema.itemByDefindex(obj.defindex) ?? null;
      } catch {
        item = null;
      }
      return scraptfBankForItem(category, obj, item);
    } catch {
      return bankForCategory(category);
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
        // 0.7.4 (F09/F14): every twin reads this base's rows as part of its book; their own rows stay cached.
        for (const tw of twinBasesOf(schema, base)) {
          dirty.add(tw);
          bestRaw.delete(tw);
          for (const b of forgetDependents(tw)) dirty.add(b);
        }
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
        return selectKeyPrice(repo.keyQuotes(), deps.settings(), clock.now(), scraptfKey());
      } catch (err) {
        log.warn('Key price lookup failed', { error: String(err) });
        return lastKeyPrice ?? selectKeyPrice([], deps.settings(), clock.now(), scraptfKey());
      }
    },

    stats() {
      return { ...runStats };
    },
  };
}

/**
 * 0.7.1 (ACT-2): what a toast told the user about one opportunity. `obs` is the input's observedAt (a
 * rule candidate's: the rule's update time), `lid` the revenue order's listing and `p` the profit.
 */
export interface NotifyFingerprint {
  obs: UnixMs;
  lid: string | null;
  p: Scrap | null;
}

/** One NOTIFY_META_KEY entry: when the key was last told of, and what (null: a record from before 0.7.1). */
export interface NotifyRecord {
  t: UnixMs;
  f: NotifyFingerprint | null;
}

export function notifyFingerprintOf(
  o: Pick<Opportunity, 'inputObservedAt' | 'profitScrap' | 'bestOrder' | 'consOrder' | 'instantOrder'>,
  useOrder: ProfitSettings['useOrder'],
): NotifyFingerprint {
  return { obs: o.inputObservedAt, lid: revenueOrderOf(o, useOrder)?.listingId ?? null, p: o.profitScrap };
}

/**
 * Past notifications.dedupMs, whether a row told of before is worth another toast: the price was seen
 * again (a new save or a re-typed price), another buy order pays, or the profit rose by
 * CHANGE_PROFIT_DELTA or more since that toast. A record without a fingerprint always is.
 */
export function notifyWorthRepeating(told: NotifyFingerprint | null, now: NotifyFingerprint): boolean {
  if (told === null) return true;
  if (now.obs !== told.obs || now.lid !== told.lid) return true;
  return now.p !== null && (told.p === null || now.p - told.p >= CHANGE_PROFIT_DELTA);
}

/** NOTIFY_META_KEY's value as records; entries of the pre-0.7.1 `{ key: ts }` form have no fingerprint. Throws on bad JSON. */
export function parseNotifyRecords(raw: string | null): Map<string, NotifyRecord> {
  const out = new Map<string, NotifyRecord>();
  if (!raw) return out;
  const parsed = notifyMapSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return out;
  for (const [k, v] of Object.entries(parsed.data)) {
    const r = notifyRecordSchema.safeParse(v);
    if (!r.success) continue;
    out.set(k, typeof r.data === 'number' ? { t: r.data, f: null } : r.data);
  }
  return out;
}

/** profit.inputStaleMs as the confidence score reads it: 0 or a broken value means the default (2 h). */
function inputStaleMsOf(p: Pick<ProfitSettings, 'inputStaleMs'>): number {
  return Number.isFinite(p.inputStaleMs) && p.inputStaleMs > 0 ? p.inputStaleMs : DEFAULT_SETTINGS.profit.inputStaleMs;
}

/** settings.notifications.inputKinds as a set; a missing or broken value means every kind (the default). */
export function notifyKinds(v: unknown): ReadonlySet<InputKind> {
  if (!Array.isArray(v)) return new Set(INPUT_KIND_ORDER);
  return new Set(INPUT_KIND_ORDER.filter((k) => v.includes(k)));
}

/**
 * 'Candidate: <name>' for a rule estimate (the user still has to find it on scrap.tf), else 'Profit: <name>'.
 * 0.7.4 (F66 step 2): a copy with extras (Opportunity.copyKey) is named by its first two, as the Opportunities
 * row's tag: 'Profit: The Last Laugh (After Eight)', so the toast says which copy to buy. `paintName` names a
 * paint (the item schema's); without it, or for an unknown paint, 'Paint #rrggbb'. 0.8 (G1): `watched` (a typed or
 * imported price toasted at a watch's profit target, EngineDeps.watchFloorFor) reads 'Watch: <name>'; a rule never.
 */
export function notificationTitle(
  o: Pick<Opportunity, 'inputKind' | 'name' | 'sku'> & Partial<Pick<Opportunity, 'copyKey'>>,
  paintName?: (decimal: number) => string | null,
  watched = false,
): string {
  const title = `${o.inputKind === 'rule' ? 'Candidate' : watched ? 'Watch' : 'Profit'}: ${o.name || o.sku}`;
  if (o.inputKind === 'rule') return title;
  const extras = copyExtrasWords(o.copyKey, (d) => paintName?.(d) ?? `Paint #${d.toString(16).padStart(6, '0')}`);
  if (extras.length === 0) return title;
  return `${title} (${extras.slice(0, 2).join(', ')}${extras.length > 2 ? ` +${extras.length - 2}` : ''})`;
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
