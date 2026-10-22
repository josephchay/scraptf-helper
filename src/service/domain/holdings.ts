// Holdings (F11): the journal's open FIFO lots priced live against the local
// backpack.tf book, plus "Sell: <name>" notifications when a held item can be
// sold at a profit. No network of its own: revenue comes from the Live market
// index (or the same evaluation on demand), and held SKUs only join the budgeted
// snapshot watch list (core.watchedSet). Nothing here sells, lists or offers
// anything (R4); the user records sales in the journal.
//
// F14: a held item's other exit is scrap.tf's bank, read from the price list the
// user saved with their own browser (the in-memory list cache; never fetched, R1).
// Status, profit and "Sell:" judge the better of the two (bestExitOf).
//
// 0.8 (H1, H3, H4, H6, H7): each row also carries the copy-matched ask side (asks.ts), the age-gated
// references, the last snapshot and Sell now / List and wait / Hold / No clear signal advice over the exit
// runs recorded while the live feed was up (holdingMarks.ts). All of it is read from local data already
// stored; the runs are written from what a check computed, never from a request of their own.
//
// 0.9 (#1, #17): with the 7-day trade lock the user set, rows carry their locked units (Locked advice, left out of
// Sellable now, no "Sell:" until the unit unlocks); the key-exposure reason quotes the key's 7-day move band from the
// PriceDB key history already in memory (deps.keyHistory; reading it sends nothing).

import { z } from 'zod';
import { unverifiedRevenue } from '../../shared/buyerSeen';
import { categoryOfSkuOnly } from '../../shared/categories';
import { formatScrap } from '../../shared/currency';
import {
  HOLDING_DETAIL_LEAD_MS,
  HOLDING_DETAIL_MAX_CLOSED,
  HOLDING_DETAIL_MAX_MARKS,
  HOLDING_DETAIL_UNHELD_MS,
  HOLDING_HISTORY_MAX_RUNS,
  attachHoldingAdvice,
  holdingExitHistory,
  holdingMarkSettingsKey,
  holdingMarkValuesOf,
  keyMoveBandOf,
  tradeLockModeOf,
  withTradeLock,
} from '../../shared/holdingAdvice';
import {
  HOLDINGS_CSV_COLUMNS,
  askSideOf,
  holdingLockedNow,
  holdingRefsOf,
  holdingRow,
  holdingsCsvCells,
  holdingsMatching,
  holdingsResult,
  scraptfAlternative,
  type HoldingBuySide,
  type HoldingRowExtras,
} from '../../shared/holdings';
import { closedTradesOf, typicalHold, typicalHoldOf, withTypicalHold } from '../../shared/journal';
import type { PushContract } from '../../shared/rpc';
import { SCRAPTF_LIST_FRESH_MS } from '../../shared/scraptfList';
import { baseSku as toBaseSku, fromString } from '../../shared/sku';
import { CATEGORIES, CURRENCY_SKUS } from '../../shared/types';
import type {
  Category,
  HoldingAskSide,
  HoldingDetail,
  HoldingMark,
  HoldingMarkValues,
  HoldingRefs,
  HoldingRow,
  HoldingsQuery,
  HoldingsResult,
  JournalClosedTrade,
  JournalPosition,
  KeyMoveBand,
  KeyPriceState,
  Listing,
  LoadedKeyHistory,
  Scrap,
  ScraptfListRow,
  Settings,
  TypicalHold,
  UnixMs,
} from '../../shared/types';
import type { SchemaService, ServiceDeps } from '../contracts';
import { realTimers, type TimerApi } from '../net/ratelimit';
import { askCandidatesOf } from './asks';
import { toCsv } from './csv';
import { CHANGE_PROFIT_DELTA, MAX_NOTIFICATIONS_PER_RUN } from './engine';
import { HOLDING_MARK_HEARTBEAT_MS, createMarkRecorder } from './holdingMarks';
import { journalSummary } from './journal';
import { DEFAULT_KEY_SCRAP } from './keyprice';
import { evaluateMarketBase, type MarketEval, type MarketIndex } from './market';
import { anyEffectBaseOf, matchContext, type MatchContext } from './matcher';
import { bookBasesOf, mergedBook, twinBasesOf, withTwins } from './bookTwins';
import { lookupReferences, referencePrices, usableReferences, type RawReferences } from './pricing';
import type { ScraptfListCache } from './scraptfList';

/** Repo meta key holding { sku: lastNotifiedAt } for "Sell:" notifications (survives restarts, like engine.lastNotified). */
export const HOLDINGS_NOTIFY_META_KEY = 'holdings.lastNotified';
/**
 * 0.8 (H6): repo meta key holding { key, at }: the buyer settings (holdingMarkSettingsKey) the advice last read the
 * recorded runs under, and when they last changed (null: no change seen). Runs keep prices, not buyers, so the
 * advice compares only runs recorded since `at` (holdingExitHistory's settingsAt); kept across restarts like the runs.
 */
export const HOLDINGS_MARK_SETTINGS_META_KEY = 'holdings.markSettings';
/** Triggers (book changes, journal writes, settings and key moves) arriving this close together are checked once. */
export const HOLDINGS_CHECK_MS = 250;
/** 0.8 (H3): a base's merged sell listings are re-read after this (a sell change fires no market move). */
export const HOLDINGS_ASK_CACHE_MS = 60_000;
/** 0.8 (H4): a base's stored references are re-read after this (or on a settings change). */
export const HOLDINGS_REFS_CACHE_MS = 10 * 60_000;
/** 0.8 (H6): a held base's recorded runs are re-read after this (or on a journal change); new runs are merged in. */
export const HOLDINGS_HISTORY_CACHE_MS = 60 * 60_000;

const CURRENCY: ReadonlySet<string> = new Set(CURRENCY_SKUS);
const NO_LISTINGS: readonly Listing[] = [];
const NO_BASES: ReadonlySet<string> = new Set();
const notifyMapSchema = z.record(z.string(), z.unknown());
const markSettingsSchema = z.object({ key: z.string(), at: z.number().nullable() });

// 0.7.4 (F13, F21, F47): moved to src/shared/buyerSeen.ts in 0.8; re-exported for the service's callers.
export { unverifiedRevenue };

export interface Holdings {
  /** 'holdings.list': matching rows in holdingComparator order, totals over everything held. */
  list(q: HoldingsQuery, now: UnixMs): HoldingsResult;
  /** Matching rows in the same order, for CSV. */
  all(q: HoldingsQuery, now: UnixMs): HoldingRow[];
  /** From the market index (MarketIndexDeps.onBasesChanged): base SKUs whose entry was added, removed or moved. */
  onBasesChanged(bases: ReadonlySet<string>): void;
  /** A journal row was added or deleted (core's ctx.journalChanged). */
  journalChanged(): void;
  /** settings.profit / notifications / blocklist / ownSteamIds or (0.9) tradeLock.mode changed, or the key price moved by 1 scrap or more. */
  settingsChanged(): void;
  /** Base SKUs (paint removed, currencies excluded) of every open lot; core adds them to watchedSet(). */
  heldBases(): Set<string>;
  /**
   * 'holdings.detail' (H7): `sku` canonical (the handler splits it). The SKU's row (advice included), open lots,
   * closed trades, typical hold and the base's recorded runs; local reads only, and a failed read gives empty parts.
   */
  detail(sku: string, now: UnixMs): HoldingDetail;
  /** 0.9 (#12): when the buyer settings last changed (markSettingsAt), for the reserve suggestion's recorded windows; null when none is known or the settings cannot be read. */
  buyerSettingsAt?(now: UnixMs): UnixMs | null;
  /** 0.8 (H1, D10): the watched bases changed: they are recorded from the next run. */
  markBasesChanged(): void;
  start(): void;
  stop(): void;
}

export interface HoldingsDeps extends ServiceDeps {
  schema: SchemaService;
  /** Revenue per held base: its entry (entryFor), else evaluateMarketBase on demand. */
  market: MarketIndex;
  /** The engine's key price, so holdings value keys like every other row. */
  keyPrice(): KeyPriceState;
  /** Desktop notification through main (push 'notify'); main applies notifications.silent. */
  notify(n: PushContract['notify']): void;
  /**
   * F14: the saved scrap.tf/items list (core's createScraptfListCache): a held base's row is its scrap.tf
   * exit (bestExitOf in src/shared/scraptfList.ts). Omitted: backpack.tf is the only exit (tests).
   */
  scraptfList?: Pick<ScraptfListCache, 'rowFor'>;
  /**
   * 0.8 (H1): since when the backpack.tf live feed has been 'live' without a break (core: feedLiveSince), null while
   * it is not. Exit runs are written only while it is set, so a gap in the record means "not watched". Omitted
   * (tests): nothing is recorded and no heartbeat runs.
   */
  feedLiveSince?(): UnixMs | null;
  /** 0.8 (H1, G1): base SKUs watched on scrap.tf (the alerts package wires watchCache.bases(), D10), recorded like held ones. Omitted: held bases only. */
  markBases?(): ReadonlySet<string>;
  /** 0.9 (#17): PriceDB key history already loaded (core: pricedb.loadedKeyHistory). Omitted: no key move band. */
  keyHistory?(): LoadedKeyHistory | null;
  /** Injected in tests; defaults to unref'd real timers. */
  timers?: TimerApi;
}

/** One open position and the books it is priced from. */
interface Held {
  pos: JournalPosition;
  /** Clean base SKU; null for currencies and SKUs that cannot be read (no buy side). */
  base: string | null;
  /** The generic any-effect book an effect-specific unusual also sells into. */
  generic: string | null;
}

/** What the last check saw for one held SKU (in memory; a restart starts fresh, the dedupe does not). */
interface SellState {
  inSell: boolean;
  /** profitNow when last notified, or when it entered 'sell' without a notification. */
  baseline: Scrap | null;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function baseOf(sku: string): string | null {
  try {
    const base = /;p\d/.test(sku) ? toBaseSku(sku) : sku.trim();
    return base === '' || CURRENCY.has(base) ? null : base;
  } catch {
    return null;
  }
}

/** 0.8 (H3): the held copy's paint from its SKU token (null: a clean copy, or a SKU that cannot be read). */
function paintOf(sku: string): number | null {
  try {
    return /;p\d/.test(sku) ? (fromString(sku).paint ?? null) : null;
  } catch {
    return null;
  }
}

function buySideOf(e: Readonly<MarketEval>): HoldingBuySide {
  return {
    revenueScrap: e.revenueScrap,
    bestScrap: e.bestScrap,
    instantScrap: e.instantScrap,
    revenueOrder: e.revenueOrder,
    bestOrder: e.bestOrder ?? null,
    buyerCount: e.buyerCount,
    confidence: e.confidence,
    confidenceLevel: e.confidenceLevel,
    flags: e.flags,
    lastOrderChangeAt: e.lastOrderChangeAt,
    // 0.8 (PC-2, H2): the entry's next buyer and verified count (evaluateMarketBase always sets both).
    ...(e.nextBuyer !== undefined ? { nextBuyer: e.nextBuyer } : {}),
    ...(e.verifiedBuyerCount !== undefined ? { verifiedBuyerCount: e.verifiedBuyerCount } : {}),
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long ago the scrap.tf list was saved, as a notification says it ("just now", "12 min ago", "3 h ago"). */
export function listAgeText(at: UnixMs | null, now: UnixMs): string {
  // A clock that moved back reads "just now" rather than a negative age.
  const ms = finite(at) && finite(now) ? Math.max(0, now - at) : 0;
  if (ms < MINUTE_MS) return 'just now';
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h ago`;
  return `${Math.floor(ms / DAY_MS)} d ago`;
}

/**
 * 'Sell: <name>', with a body naming the venue of the better exit (HoldingRow.bestExit, F14):
 * backpack.tf: '<buyer> pays <revenue> (<bot|human>), +<profit> over your cost' (as in 0.3);
 * scrap.tf: "scrap.tf's bank pays <price> (price list saved 12 min ago), +<profit> over your cost".
 * `now` dates the saved list; without it the body says the price is from the saved list.
 */
export function holdingNotification(r: HoldingRow, keyScrap: Scrap | null, now?: UnixMs): PushContract['notify'] {
  const title = `Sell: ${r.name || r.sku}`;
  const profit = `+${formatScrap(r.profitNowScrap, keyScrap)} over your cost`;
  if (r.bestExit === 'scraptf') {
    // The list is as fresh as the user's last save, so the age is part of the claim.
    const when = finite(now) && finite(r.scraptfListAt) ? `price list saved ${listAgeText(r.scraptfListAt, now)}` : 'from your saved price list';
    // 0.7.4 (F01): an unmarked /items row is one price for every copy of the item, so the toast says so.
    const family = r.scraptfListFamily ? '; one list row for every copy' : '';
    return { title, body: `scrap.tf's bank pays ${formatScrap(r.exitScrap, keyScrap)} (${when}${family}), ${profit}`, sku: r.sku };
  }
  const o = r.revenueOrder;
  const buyer = o ? o.userName || o.steamid : 'A buyer';
  const kind = o?.isBot ? 'bot' : 'human';
  return { title, body: `${buyer} pays ${formatScrap(r.revenueScrap, keyScrap)} (${kind}), ${profit}`, sku: r.sku };
}

export function createHoldings(deps: HoldingsDeps): Holdings {
  const { repo, log, clock, schema, market } = deps;
  const timers = deps.timers ?? realTimers;

  let started = false;
  let held: Held[] | null = null;
  /** 0.8 (H5): the journal's closed pairs from the read behind `held` (typicalHoldOf). */
  let closed: readonly JournalClosedTrade[] = [];
  const state = new Map<string, SellState>();
  let notified: Map<string, number> | null = null;
  let listFailing = false;
  /** The held items on the saved list were queued for a check by the first start(). */
  let listChecked = false;
  /**
   * F14: base -> when its 'sell' through scrap.tf ends (its list row turns a day old). Nothing else
   * re-checks an item only scrap.tf buys, so without this the next day's save would find it still
   * marked in 'sell' and never tell it again; with it, re-entering 'sell' is told like any other. Or (0.9, #1) when
   * its next unit's trade lock ends: nothing else re-checks a locked 'sell' row the moment it becomes sellable.
   */
  const listExpiry = new Map<string, number>();
  let expiryTimer: unknown = null;

  // Checks are batched: a key move arrives with its settings change, a burst of book changes with
  // the next market push.
  let pendingAll = false;
  const pendingBases = new Set<string>();
  let timer: unknown = null;

  // 0.8 (H1): the exit-run writer, and the heartbeat that re-records every held and watched base while the feed
  // is live (a quiet book fires no market move, so its run would otherwise end at the last change).
  const recorder = createMarkRecorder({ repo, log });
  let pendingMarks = false;
  let heartbeatTimer: unknown = null;
  // 0.8 (H3, H4, H6): per-base caches, in memory and rebuilt on demand; nothing here is fetched.
  const sellsCache = new Map<string, { at: UnixMs; listings: readonly Listing[] }>();
  const refsCache = new Map<string, { at: UnixMs; raw: RawReferences }>();
  const historyCache = new Map<string, { at: UnixMs; since: UnixMs; marks: HoldingMark[] }>();
  let historyFailing = false;
  /** 0.8 (H6): HOLDINGS_MARK_SETTINGS_META_KEY as read or last written; null until first needed. */
  let markSettings: { key: string; at: UnixMs | null } | null = null;
  /** 0.9 (#17): the key move band of the key history last read, recomputed only when that history changed. */
  let bandMemo: { loadedAt: UnixMs; n: number; band: KeyMoveBand | null } | null = null;

  // ----- reads -----

  function keyPrice(): KeyPriceState | null {
    try {
      return deps.keyPrice();
    } catch (err) {
      log.warn('Holdings could not read the key price', { error: String(err) });
      return null;
    }
  }

  /** The engine's key price, null when unknown (rows value keys at it; recorded runs store it as is). */
  function keyScrapNow(): Scrap | null {
    const kv = keyPrice()?.valueScrap;
    return finite(kv) && kv > 0 ? kv : null;
  }

  /** 0.8 (H1): since when the feed has been live, null while it is not or without the dep (tests). */
  function liveSince(): UnixMs | null {
    if (!deps.feedLiveSince) return null;
    try {
      const at = deps.feedLiveSince();
      return finite(at) ? at : null;
    } catch {
      return null;
    }
  }

  /**
   * 0.9 (#17): the key's 7-day move band (keyMoveBandOf) over the PriceDB key history already in memory; null without
   * the dep, without loaded history or below its span minimum. Reading it sends nothing, and a failed read never takes
   * the rows down. Memoised on the history's load time and length.
   */
  function keyBandNow(): KeyMoveBand | null {
    if (!deps.keyHistory) return null;
    let h: LoadedKeyHistory | null;
    try {
      h = deps.keyHistory();
    } catch (err) {
      log.warn('Holdings could not read the key history', { error: String(err) });
      return null;
    }
    if (!h || !Array.isArray(h.points) || !finite(h.loadedAt)) return null;
    if (bandMemo && bandMemo.loadedAt === h.loadedAt && bandMemo.n === h.points.length) return bandMemo.band;
    let band: KeyMoveBand | null = null;
    try {
      band = keyMoveBandOf(h.points, h.loadedAt);
    } catch (err) {
      log.warn('Holdings could not read the key history', { error: String(err) });
    }
    bandMemo = { loadedAt: h.loadedAt, n: h.points.length, band };
    return band;
  }

  /** 0.8 (H1, D10): the watched bases recorded beside the held ones; none without the dep. */
  function markBases(): ReadonlySet<string> {
    if (!deps.markBases) return NO_BASES;
    try {
      const b = deps.markBases();
      return b && typeof b.has === 'function' ? b : NO_BASES;
    } catch (err) {
      log.warn('Holdings could not read the watched items', { error: String(err) });
      return NO_BASES;
    }
  }

  /** 0.8 (H3): a base's sell listings with every twin it is filed under, kept HOLDINGS_ASK_CACHE_MS. */
  function sellsOf(base: string, now: UnixMs): readonly Listing[] {
    const cur = sellsCache.get(base);
    if (cur && now >= cur.at && now - cur.at < HOLDINGS_ASK_CACHE_MS) return cur.listings;
    const listings = mergedBook(base, bookBasesOf(schema, base), (b) => repo.listingsByBaseSku(b, 'sell'));
    sellsCache.set(base, { at: now, listings });
    return listings;
  }

  /** 0.8 (H3): the copy-matched ask side of `paint` (null: a clean copy) on a base; null on a failed read. */
  function askFor(base: string, paint: number | null, match: MatchContext, Kv: Scrap, now: UnixMs, own: ReadonlySet<string>): HoldingAskSide | null {
    try {
      return askSideOf(askCandidatesOf(sellsOf(base, now), paint, match, Kv), now, own);
    } catch (err) {
      log.warn('Holdings could not read the sell listings', { sku: base, error: String(err) });
      return null;
    }
  }

  /** 0.8 (H4): a base's stored references (lookupReferences), kept HOLDINGS_REFS_CACHE_MS; evaluateOnDemand reads them too. */
  function rawRefsOf(base: string, now: UnixMs): RawReferences {
    const cur = refsCache.get(base);
    if (cur && now >= cur.at && now - cur.at < HOLDINGS_REFS_CACHE_MS) return cur.raw;
    const raw = lookupReferences(repo, base, schema);
    refsCache.set(base, { at: now, raw });
    return raw;
  }

  /** 0.8 (H4): a base's usable references valued at `Kv` now, with the reasons stale ones were left out. */
  function refsFor(base: string, Kv: Scrap, settings: Settings, now: UnixMs): HoldingRefs | null {
    try {
      const u = usableReferences(referencePrices(rawRefsOf(base, now), Kv, now), settings.profit?.referenceMaxAgeMs, now);
      return holdingRefsOf(u.references, u.stale);
    } catch (err) {
      log.warn('Holdings could not read reference prices', { sku: base, error: String(err) });
      return null;
    }
  }

  /** 0.8 (H6): a base's last backpack.tf snapshot; null when never, or on a failed read. */
  function snapshotAtOf(base: string): UnixMs | null {
    try {
      return repo.getSnapshotAt(base);
    } catch {
      return null;
    }
  }

  /**
   * 0.8 (H6): a held base's recorded runs overlapping the holding (toAt >= heldSince: holdingExitHistory reads no run
   * that ended before it), up to HOLDING_HISTORY_MAX_RUNS (every run retention keeps, so the window is bounded by time,
   * not cut by the read), kept HOLDINGS_HISTORY_CACHE_MS and re-read when the window moved earlier.
   */
  function historyFor(base: string | null, heldSince: UnixMs, now: UnixMs): HoldingMark[] {
    if (base === null) return [];
    const since = heldSince;
    const cur = historyCache.get(base);
    if (cur && now >= cur.at && now - cur.at < HOLDINGS_HISTORY_CACHE_MS && cur.since <= since) return cur.marks;
    try {
      const marks = repo.holdingMarks(base, since, HOLDING_HISTORY_MAX_RUNS);
      historyCache.set(base, { at: now, since, marks });
      historyFailing = false;
      return marks;
    } catch (err) {
      if (!historyFailing) log.warn('Holdings could not read the recorded exit prices', { sku: base, error: String(err) });
      historyFailing = true;
      return cur?.marks ?? [];
    }
  }

  /**
   * 0.8 (H6): when the buyer settings (holdingMarkSettingsKey) last changed, null when no change was seen. The first
   * call stores the current key (no change known); a different key later stamps `now` and is kept across restarts.
   * The advice compares only the runs recorded since then: a run keeps the price, not who paid it or under what rules.
   */
  function markSettingsAt(settings: Settings, now: UnixMs): UnixMs | null {
    let key: string;
    try {
      key = holdingMarkSettingsKey(settings);
    } catch {
      return markSettings?.at ?? null;
    }
    if (markSettings === null) {
      try {
        const raw = repo.getMeta(HOLDINGS_MARK_SETTINGS_META_KEY);
        const parsed = raw ? markSettingsSchema.safeParse(JSON.parse(raw)) : null;
        if (parsed?.success) markSettings = { key: parsed.data.key, at: finite(parsed.data.at) ? parsed.data.at : null };
      } catch (err) {
        log.warn('Holdings could not read when the buyer settings last changed', { error: String(err) });
      }
    }
    const next = markSettings === null ? { key, at: null } : markSettings.key !== key ? { key, at: finite(now) ? now : null } : null;
    if (next !== null) {
      markSettings = next;
      try {
        repo.setMeta(HOLDINGS_MARK_SETTINGS_META_KEY, JSON.stringify(next));
      } catch (err) {
        log.warn('Holdings could not save when the buyer settings changed', { error: String(err) });
      }
    }
    return markSettings!.at;
  }

  /** markSettingsAt for 'holdings.detail', null when the settings cannot be read (the row's own read failed too). */
  function detailSettingsAt(now: UnixMs): UnixMs | null {
    try {
      return markSettingsAt(deps.settings(), now);
    } catch {
      return null;
    }
  }

  /** 0.8 (H1): runs the recorder wrote, merged into the cached histories (replaced by id, else appended; capped). */
  function mergeHistory(runs: readonly HoldingMark[]): void {
    for (const run of runs) {
      const cur = historyCache.get(run.baseSku);
      if (!cur) continue;
      const i = cur.marks.findIndex((m) => m.id === run.id);
      if (i >= 0) cur.marks[i] = run;
      else cur.marks.push(run);
      if (cur.marks.length > HOLDING_HISTORY_MAX_RUNS) cur.marks.splice(0, cur.marks.length - HOLDING_HISTORY_MAX_RUNS);
    }
  }

  /** Open positions from the journal, cached until journalChanged; 0.8 (H5): the same read's closed pairs too. */
  function heldPositions(): Held[] {
    if (held !== null) return held;
    let open: JournalPosition[];
    try {
      const summary = journalSummary(repo.listJournal());
      closed = summary.closed;
      open = summary.open;
    } catch (err) {
      // Not cached: the next read tries again.
      log.warn('Holdings could not read the journal', { error: String(err) });
      return [];
    }
    held = open.map((pos) => {
      const base = baseOf(pos.sku);
      const any = base !== null ? genericOf(base) : null;
      return { pos, base, generic: any !== null && any !== base ? any : null };
    });
    return held;
  }

  /** One odd journal SKU must not take every row down with it. */
  function genericOf(base: string): string | null {
    try {
      return anyEffectBaseOf(base);
    } catch {
      return null;
    }
  }

  /**
   * True once the index has finished a build: from then on a base without an entry has no eligible
   * order, except an effect only the generic book buys (the index lists those only with a price of
   * yours). Lets list() skip the per-base book and reference reads for every other held item.
   */
  function indexBuilt(): boolean {
    try {
      return market.stats().lastFullAt !== null;
    } catch {
      return false;
    }
  }

  function categoryOf(h: Held): Category {
    const sku = h.base ?? h.pos.sku;
    try {
      const c = schema.categoryForSku(sku);
      if (CATEGORIES.includes(c)) return c;
    } catch {
      // the SKU's own fields below
    }
    try {
      return categoryOfSkuOnly(fromString(sku));
    } catch {
      return 'other';
    }
  }

  /** The journal keeps the name given when the row was written; a raw SKU there (schema not loaded yet) gets the schema's. */
  function named(pos: JournalPosition): JournalPosition {
    if (pos.name && pos.name !== pos.sku) return pos;
    try {
      const n = schema.nameForSku(pos.sku);
      return typeof n === 'string' && n.trim() ? { ...pos, name: n } : pos;
    } catch {
      return pos;
    }
  }

  function entryOf(base: string): Readonly<MarketEval> | null {
    try {
      return market.entryFor(base);
    } catch {
      return null;
    }
  }

  /**
   * The market's own evaluation for bases without an entry: before the index has built, or an
   * effect only the generic any-effect book buys (the index lists those only with a price of yours).
   */
  function evaluateOnDemand(bases: readonly string[], settings: Settings, K: Scrap, now: UnixMs): Map<string, MarketEval | null> {
    const out = new Map<string, MarketEval | null>();
    // 0.7.4 (F09/F14, F08): the item's book with every twin it is filed under (bookTwins.ts), as the Live market reads it.
    const need = withTwins(schema, bases);
    for (const b of bases) {
      const any = genericOf(b);
      if (any !== null) for (const t of bookBasesOf(schema, any)) need.add(t);
    }
    const books = repo.buyListingsByBaseSkus([...need]);
    const bookOf = (b: string): readonly Listing[] => books.get(b) ?? NO_LISTINGS;
    const match = matchContext(settings, now);
    for (const base of bases) {
      try {
        const own = mergedBook(base, bookBasesOf(schema, base), bookOf);
        const any = genericOf(base);
        const generic = any !== null && any !== base ? mergedBook(any, bookBasesOf(schema, any), bookOf) : NO_LISTINGS;
        if (own.length === 0 && generic.length === 0) {
          out.set(base, null);
          continue;
        }
        const obj = fromString(base);
        out.set(
          base,
          evaluateMarketBase({
            base,
            listings: generic.length > 0 ? [...own, ...generic] : own,
            references: referencePrices(rawRefsOf(base, now), K, now),
            isUnusual: obj.quality === 5 || (typeof obj.effect === 'number' && obj.effect > 0),
            settings,
            keyScrap: K,
            now,
            match,
          }),
        );
      } catch (err) {
        log.warn('Holdings could not price a held item', { sku: base, error: String(err) });
        out.set(base, null);
      }
    }
    return out;
  }

  /** The generic any-effect book a base also sells into (genericOf), null when it is its own. */
  function genericFor(base: string): string | null {
    const any = genericOf(base);
    return any !== null && any !== base ? any : null;
  }

  /**
   * The buy side per base: its market entry, else (before the index has built, or for an effect a generic order may
   * buy) the same evaluation on demand. `generic` names a base's generic book (Held.generic, genericFor).
   */
  function sidesOf(
    bases: readonly string[],
    built: boolean,
    generic: (b: string) => string | null,
    settings: Settings,
    K: Scrap | null,
    now: UnixMs,
  ): Map<string, HoldingBuySide | null> {
    const sides = new Map<string, HoldingBuySide | null>();
    const missing: string[] = [];
    for (const b of bases) {
      if (sides.has(b)) continue;
      const e = entryOf(b);
      sides.set(b, e ? buySideOf(e) : null);
      // After a build the index has the answer, except for an effect a generic order may buy.
      if (!e && (!built || generic(b) !== null)) missing.push(b);
    }
    if (missing.length > 0) {
      try {
        const evs = evaluateOnDemand(missing, settings, K ?? DEFAULT_KEY_SCRAP, now);
        for (const [b, ev] of evs) sides.set(b, ev ? buySideOf(ev) : null);
      } catch (err) {
        log.warn('Holdings could not read order books', { error: String(err) });
      }
    }
    return sides;
  }

  /** Rows for these positions, in journal order (callers sort); `sidesOut` receives the buy sides read (check's recording). */
  function rowsOf(list: readonly Held[], now: UnixMs, sidesOut?: Map<string, HoldingBuySide | null>): HoldingRow[] {
    if (list.length === 0) return [];
    const settings = deps.settings();
    const K = keyScrapNow();
    const generics = new Map<string, string | null>();
    for (const h of list) if (h.base !== null && !generics.has(h.base)) generics.set(h.base, h.generic);
    const sides = sidesOf([...generics.keys()], indexBuilt(), (b) => generics.get(b) ?? null, settings, K, now);
    if (sidesOut) for (const [b, s] of sides) sidesOut.set(b, s);
    // 0.8 (H5): the user's typical hold, over every open position (not just `list`), so stillHeld is the journal's.
    const hold = typicalHoldOf(closed, heldPositions().map((h) => h.pos));
    // 0.8 (H3, H4): the ask side and references are valued at the key price the row is.
    const Kv = K ?? DEFAULT_KEY_SCRAP;
    const match = matchContext(settings, now);
    const own: ReadonlySet<string> = new Set(settings.ownSteamIds ?? []);
    // 0.8 (H6): runs recorded before the buyer settings last changed priced other buyers; the advice leaves them out.
    const settingsAt = markSettingsAt(settings, now);
    // 0.9 (#1): the trade lock the user set (only '7d' marks rows); (#17) the key band from history already loaded.
    const lockMode = tradeLockModeOf(settings);
    const keyBand = keyBandNow();
    // Lots at the key price the revenue is valued at, so profit is what the journal will book (lotCostAt);
    // the saved scrap.tf list row at that same price is the other exit (F14, judged at `now`).
    return list.map((h) => {
      const extras: HoldingRowExtras =
        h.base === null
          ? { ask: null, refs: null, snapshotAt: null }
          : { ask: askFor(h.base, paintOf(h.pos.sku), match, Kv, now, own), refs: refsFor(h.base, Kv, settings, now), snapshotAt: snapshotAtOf(h.base) };
      const row = withTradeLock(
        withTypicalHold(
          holdingRow(
            named(h.pos),
            categoryOf(h),
            h.base !== null ? (sides.get(h.base) ?? null) : null,
            settings.profit,
            K,
            { list: h.base !== null ? listRowOf(h.base, K) : null, now },
            extras,
          ),
          hold,
        ),
        h.pos.lots,
        lockMode,
        now,
      );
      // 0.8 (H6): after withTypicalHold, so the advice can read the typical hold. A currency (no base) has no book to
      // refresh and records no runs, so its advice says neither. 0.9: after withTradeLock, so the advice reads the lock.
      if (h.base === null) return attachHoldingAdvice(row, null, settings.profit, K, now, { book: false });
      const history = holdingExitHistory(historyFor(h.base, row.heldSince, now), row.heldSince, K, now, settingsAt);
      return attachHoldingAdvice(row, history, settings.profit, K, now, { keyBand });
    });
  }

  /**
   * 0.8 (H1): records what this check saw for the held bases of `list` plus the watched ones (markBases(): all for
   * `scope` null, else those in `scope`), only while the feed is live. Sides missing from `sides` are read as the rows
   * read them; the key price is stored as it is (null stays null: no default is written as an observation).
   */
  function recordMarks(scope: ReadonlySet<string> | null, list: readonly Held[], sides: Map<string, HoldingBuySide | null>, now: UnixMs): void {
    const since = liveSince();
    if (since === null) return;
    try {
      const bases = new Set<string>();
      for (const h of list) if (h.base !== null) bases.add(h.base);
      for (const b of markBases()) if (typeof b === 'string' && b !== '' && !CURRENCY.has(b) && (scope === null || scope.has(b))) bases.add(b);
      if (bases.size === 0) return;
      const settings = deps.settings();
      const K = keyScrapNow();
      const missing = [...bases].filter((b) => !sides.has(b));
      if (missing.length > 0) for (const [b, s] of sidesOf(missing, indexBuilt(), genericFor, settings, K, now)) sides.set(b, s);
      const match = matchContext(settings, now);
      const own: ReadonlySet<string> = new Set(settings.ownSteamIds ?? []);
      const seen = new Map<string, HoldingMarkValues>();
      for (const b of bases) seen.set(b, holdingMarkValuesOf(sides.get(b) ?? null, askFor(b, null, match, K ?? DEFAULT_KEY_SCRAP, now, own), listRowOf(b, K), now));
      mergeHistory(recorder.record(seen, now, since, K));
    } catch (err) {
      log.warn('Holdings could not record exit prices', { error: String(err) });
    }
  }

  /** The base's saved scrap.tf/items row (in memory, no query); a failed read leaves backpack.tf as the only exit. */
  function listRowOf(base: string, K: Scrap | null): ScraptfListRow | null {
    const list = deps.scraptfList;
    if (!list) return null;
    try {
      const row = list.rowFor(base, K ?? undefined);
      listFailing = false;
      return row;
    } catch (err) {
      // Once per failure streak, not once per held row.
      if (!listFailing) log.warn('Holdings could not read the saved scrap.tf list', { sku: base, error: String(err) });
      listFailing = true;
      return null;
    }
  }

  // ----- sell notifications -----

  function loadNotified(): Map<string, number> {
    if (notified) return notified;
    notified = new Map();
    try {
      const raw = repo.getMeta(HOLDINGS_NOTIFY_META_KEY);
      if (raw) {
        const parsed = notifyMapSchema.safeParse(JSON.parse(raw));
        if (parsed.success) for (const [k, v] of Object.entries(parsed.data)) if (finite(v)) notified.set(k, v);
      }
    } catch (err) {
      log.warn('Could not read the holdings notification history; starting fresh', { error: String(err) });
    }
    return notified;
  }

  /** Expired by age only, as the engine's: a count cap would re-notify SKUs still inside the window. */
  function saveNotified(map: Map<string, number>, now: UnixMs, dedupMs: number): void {
    for (const [k, ts] of map) if (!(now - ts < dedupMs) || ts > now) map.delete(k);
    try {
      repo.setMeta(HOLDINGS_NOTIFY_META_KEY, JSON.stringify(Object.fromEntries(map)));
    } catch (err) {
      log.warn('Could not save the holdings notification history', { error: String(err) });
    }
  }

  function send(n: PushContract['notify']): void {
    try {
      deps.notify(n);
    } catch (err) {
      log.warn('Holdings notification failed', { error: String(err) });
    }
  }

  /**
   * Re-evaluates held positions (all, or those reading a base in `scope`) and notifies a SKU that
   * entered 'sell' (or entered below minConfidence and has reached it since), or whose profitNow
   * rose by CHANGE_PROFIT_DELTA or more since its last notification while in 'sell'. Gated on
   * notifications.enabled, .holdings and .minConfidence, deduped per SKU for
   * notifications.dedupMs across restarts; at most MAX_NOTIFICATIONS_PER_RUN, then one summary.
   * 0.7.4: a backpack.tf exit on an unverified buyer (unverifiedRevenue) waits, unrecorded, until a snapshot
   * or a feed event confirms the order, as the engine's toasts do; a scrap.tf exit is not gated. A backpack.tf
   * exit held back (unverified, or below minConfidence) is told through scrap.tf's bank instead when the saved
   * list's fresh, not-full price clears the thresholds on its own (scraptfAlternative).
   * 0.8 (H1): what the check saw is recorded as exit runs (recordMarks), watched bases in scope included, even
   * when nothing in scope is held; the notifications are unchanged.
   * 0.9 (#1): with a 7-day trade lock (Settings.tradeLock.mode '7d'), a row whose next unit is still locked
   * (holdingLockedNow) is not in 'sell' for the notifications: it is told once it unlocks, when trackListExpiry's timer
   * re-checks it.
   */
  function check(scope: ReadonlySet<string> | null): void {
    const now = clock.now();
    const all = heldPositions();
    if (scope === null) {
      const skus = new Set(all.map((h) => h.pos.sku));
      for (const sku of state.keys()) if (!skus.has(sku)) state.delete(sku);
      listExpiry.clear();
    }
    const list = scope === null ? all : all.filter((h) => h.base !== null && (scope.has(h.base) || (h.generic !== null && scope.has(h.generic))));
    if (list.length === 0) {
      // A scope of watched-only bases, or nothing held: still recorded.
      recordMarks(scope, [], new Map(), now);
      return;
    }
    const sides = new Map<string, HoldingBuySide | null>();
    const rows = rowsOf(list, now, sides);
    recordMarks(scope, list, sides, now);
    trackListExpiry(list, rows);
    const settings = deps.settings();
    const n = settings.notifications;
    const on = n?.enabled === true && n.holdings !== false;
    const minConfidence = finite(n?.minConfidence) ? n.minConfidence : 0;
    const dedupMs = finite(n?.dedupMs) && n.dedupMs > 0 ? n.dedupMs : 0;
    const last = on ? loadNotified() : null;
    const due: HoldingRow[] = [];
    for (const r of rows) {
      // 0.9 (#1): a unit inside the 7-day trade lock the user set cannot be sold yet: no "Sell:" until it unlocks (trackListExpiry re-checks then).
      if (r.status !== 'sell' || !finite(r.profitNowScrap) || holdingLockedNow(r)) {
        state.set(r.sku, { inSell: false, baseline: null });
        continue;
      }
      // The confidence scores the backpack.tf buyers. A scrap.tf exit is the bank's own price from a
      // saved list that bestExitOf already requires to be fresh and not full (and the body says how old).
      // 0.7.4 (F13, F21, F47): as the engine's "Profit:" toast, a backpack.tf buyer nobody has confirmed for 24 h
      // may be gone (the feed has no catch-up), so it is held back too.
      const heldBack = r.bestExit !== 'scraptf' && (r.confidence < minConfidence || unverifiedRevenue(r.revenueOrder, now));
      // 0.7.4: a held-back row is told through scrap.tf's bank when its fresh, not-full list price clears the
      // thresholds on its own (scraptfAlternative); its baseline is then that exit's profit, so the same figures
      // do not read as a rise later. Else null: not told.
      const told = heldBack ? scraptfAlternative(r, settings.profit, now) : r;
      const profit = (told ?? r).profitNowScrap as Scrap;
      const prev = state.get(r.sku);
      const entering = prev === undefined || !prev.inSell || prev.baseline === null;
      const baseline = entering ? profit : prev.baseline!;
      const rising = !entering && profit >= baseline + CHANGE_PROFIT_DELTA;
      // Tracked whatever the gates say, so switching notifications on does not replay every sellable item.
      state.set(r.sku, { inSell: true, baseline });
      if (!(entering || rising) || last === null) continue;
      if (told === null) {
        // Not told yet, and nothing recorded: an entry stays pending (baseline null), so more buyers raising the
        // confidence, or a snapshot (core.snapshotPriority ranks it) or a feed event confirming the order, still
        // tell it without waiting for the profit to rise; a rise keeps its old baseline.
        if (entering) state.set(r.sku, { inSell: true, baseline: null });
        continue;
      }
      const ts = last.get(r.sku);
      if (ts !== undefined && now - ts < dedupMs && now >= ts) continue;
      due.push(told);
    }
    if (due.length === 0 || last === null) return;
    due.sort((a, b) => (b.profitNowScrap ?? 0) - (a.profitNowScrap ?? 0) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
    for (const r of due) {
      last.set(r.sku, now);
      state.set(r.sku, { inSell: true, baseline: r.profitNowScrap });
    }
    saveNotified(last, now, Math.max(dedupMs, 1));
    const K = keyPrice()?.valueScrap ?? null;
    const individual = due.slice(0, MAX_NOTIFICATIONS_PER_RUN);
    for (const r of individual) send(holdingNotification(r, K, now));
    const rest = due.length - individual.length;
    if (rest > 0) {
      send({
        title: `${rest} more held item${rest === 1 ? '' : 's'} to sell`,
        body: 'They can be sold at a profit now. Open TF2 Flip Desk to see them.',
        sku: null,
      });
    }
  }

  function arm(): void {
    if (!started || timer !== null) return;
    timer = timers.setTimeout(run, HOLDINGS_CHECK_MS);
  }

  /**
   * Records when each checked row's 'sell' through scrap.tf goes stale, or (0.9, #1) when a 'sell' row's next unit
   * leaves the 7-day trade lock (rows are in `list` order); the earliest per base re-checks it.
   */
  function trackListExpiry(list: readonly Held[], rows: readonly HoldingRow[]): void {
    // Every copy of a base is in the same check, so its old time can go before the new one is set.
    for (const h of list) if (h.base !== null) listExpiry.delete(h.base);
    rows.forEach((r, i) => {
      const base = list[i]?.base ?? null;
      if (base === null) return;
      const ats: number[] = [];
      // scraptfListFresh: stale once now - observedAt > SCRAPTF_LIST_FRESH_MS.
      if (r.status === 'sell' && r.bestExit === 'scraptf' && finite(r.scraptfListAt)) ats.push(r.scraptfListAt + SCRAPTF_LIST_FRESH_MS + 1);
      // 0.9 (#1): locked while tradableAt > now, so the re-check comes 1 ms after.
      if (r.status === 'sell' && holdingLockedNow(r)) ats.push(r.tradeLock!.nextLotTradableAt! + 1);
      for (const at of ats) {
        const prev = listExpiry.get(base);
        listExpiry.set(base, prev === undefined ? at : Math.min(prev, at));
      }
    });
    armExpiry();
  }

  function armExpiry(): void {
    if (expiryTimer !== null) timers.clearTimeout(expiryTimer);
    expiryTimer = null;
    if (!started || listExpiry.size === 0) return;
    let next = Infinity;
    for (const at of listExpiry.values()) if (at < next) next = at;
    // A list dated ahead of the clock is looked at again after a day at most.
    expiryTimer = timers.setTimeout(listExpired, Math.min(Math.max(0, next - clock.now()), SCRAPTF_LIST_FRESH_MS + 1));
  }

  function listExpired(): void {
    expiryTimer = null;
    if (!started) return;
    const now = clock.now();
    for (const [base, at] of listExpiry) {
      if (at > now) continue;
      listExpiry.delete(base);
      pendingBases.add(base);
    }
    arm();
    armExpiry();
  }

  function run(): void {
    timer = null;
    if (!started) return;
    const scope = pendingAll ? null : pendingBases.size > 0 ? new Set(pendingBases) : undefined;
    pendingAll = false;
    pendingBases.clear();
    const marks = pendingMarks;
    pendingMarks = false;
    try {
      if (scope !== undefined) check(scope);
      // 0.8 (H1): the heartbeat or a watched-bases change records every held and watched base (no notifications
      // on this path); a full check above has already recorded them all.
      if (marks && scope !== null) recordMarks(null, heldPositions(), new Map(), clock.now());
    } catch (err) {
      // Runs from a timer: nothing may escape into the service process.
      log.warn('Holdings check failed', { error: String(err) });
    }
  }

  /** 0.8 (H1): re-arms the heartbeat (TimerApi has no setInterval); only while started and recording is wired. */
  function armHeartbeat(): void {
    if (heartbeatTimer !== null) timers.clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    if (!started || !deps.feedLiveSince) return;
    heartbeatTimer = timers.setTimeout(heartbeat, HOLDING_MARK_HEARTBEAT_MS);
  }

  function heartbeat(): void {
    heartbeatTimer = null;
    if (!started) return;
    pendingMarks = true;
    arm();
    armHeartbeat();
  }

  return {
    list(q, now) {
      return holdingsResult(rowsOf(heldPositions(), now), q, keyPrice(), now);
    },

    all(q, now) {
      return holdingsMatching(rowsOf(heldPositions(), now), q);
    },

    onBasesChanged(bases) {
      if (!bases || typeof bases.has !== 'function') return;
      // Only the held bases are kept: a first build reports every base in the market.
      for (const h of heldPositions()) {
        // 0.7.4 (F09/F14): the item's row may be a twin of the held base (MarketIndex.entryFor).
        if (h.base !== null && (bases.has(h.base) || twinBasesOf(schema, h.base).some((t) => bases.has(t)))) pendingBases.add(h.base);
        if (h.generic !== null && bases.has(h.generic)) pendingBases.add(h.generic);
      }
      // 0.8 (H1): a watched base's book moved: its run is recorded on the next run, not at the heartbeat.
      if (deps.feedLiveSince) for (const b of markBases()) if (bases.has(b)) pendingBases.add(b);
      if (pendingBases.size > 0) arm();
    },

    journalChanged() {
      held = null;
      // 0.8 (H6): a new buy can move a holding's start earlier than the runs read for it.
      historyCache.clear();
      pendingAll = true;
      arm();
    },

    settingsChanged() {
      // 0.8 (H4): the reference age gate may have changed.
      refsCache.clear();
      // 0.8 (H6): a change to which buyers count is dated now, not at the next read of the rows.
      try {
        markSettingsAt(deps.settings(), clock.now());
      } catch (err) {
        log.warn('Holdings could not read the settings', { error: String(err) });
      }
      pendingAll = true;
      arm();
    },

    heldBases() {
      const out = new Set<string>();
      try {
        for (const h of heldPositions()) if (h.base !== null) out.add(h.base);
      } catch (err) {
        log.warn('Holdings could not list the held items', { error: String(err) });
      }
      return out;
    },

    start() {
      if (started) return;
      started = true;
      // The market's first build reports every entry, so held items are checked then; this only
      // catches up on triggers that arrived while stopped.
      if (!listChecked && deps.scraptfList) {
        listChecked = true;
        // F14: an item only scrap.tf buys has no entry, so no build reports it. Held items on the saved
        // list are checked once at start instead, as their scrap.tf exit may already be the better one.
        try {
          // Only whether a row exists matters here; an explicit key value keeps the cache from reading
          // (and keeping) the engine's key price this early.
          for (const h of heldPositions()) if (h.base !== null && listRowOf(h.base, DEFAULT_KEY_SCRAP) !== null) pendingBases.add(h.base);
        } catch (err) {
          log.warn('Holdings could not list the held items on the scrap.tf list', { error: String(err) });
        }
      }
      if (pendingAll || pendingBases.size > 0 || pendingMarks) arm();
      armExpiry();
      armHeartbeat();
    },

    stop() {
      started = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      if (expiryTimer !== null) timers.clearTimeout(expiryTimer);
      expiryTimer = null;
      if (heartbeatTimer !== null) timers.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
      // 0.8 (H1): each open run ends at its last sighting.
      recorder.flush();
    },

    markBasesChanged() {
      pendingMarks = true;
      arm();
    },

    // 0.9 (#12): the stamp the advice reads, for 'profit.reserveSuggestion' (no recorded window is read from before it).
    buyerSettingsAt: (now) => detailSettingsAt(now),

    detail(sku, now) {
      const K = keyScrapNow();
      // Fills journal's `closed` cache too (heldPositions).
      const positions = heldPositions();
      const h = positions.find((x) => x.pos.sku === sku) ?? null;
      const base = h?.base ?? baseOf(sku);
      let row: HoldingRow | null = null;
      if (h) {
        try {
          row = rowsOf([h], now)[0] ?? null;
        } catch (err) {
          log.warn('Holdings could not price the held item', { sku, error: String(err) });
        }
      }
      const closedForSku = closedTradesOf(closed, sku).slice(0, HOLDING_DETAIL_MAX_CLOSED);
      // Lots oldest first: the next sale closes lots[0].
      const lots = h ? [...h.pos.lots].sort((a, b) => a.ts - b.ts || a.id - b.id) : [];
      const since = row ? row.heldSince - HOLDING_DETAIL_LEAD_MS : now - HOLDING_DETAIL_UNHELD_MS;
      let marks: HoldingMark[] = [];
      let truncated = false;
      if (base !== null) {
        try {
          // A direct read, not the rows' cache: the drawer shows the window as stored.
          const read = repo.holdingMarks(base, since, HOLDING_DETAIL_MAX_MARKS + 1);
          truncated = read.length > HOLDING_DETAIL_MAX_MARKS;
          marks = truncated ? read.slice(read.length - HOLDING_DETAIL_MAX_MARKS) : read;
        } catch (err) {
          log.warn('Holdings could not read the recorded exit prices', { sku: base, error: String(err) });
        }
      }
      let hold: TypicalHold | null = null;
      try {
        hold = typicalHold(closed, positions.map((x) => x.pos), sku);
      } catch {
        // No typical hold rather than no answer.
      }
      return {
        sku,
        baseSku: base,
        row,
        lots,
        closed: closedForSku,
        typicalHold: hold,
        marks,
        truncated,
        history: row ? holdingExitHistory(marks, row.heldSince, K, now, detailSettingsAt(now)) : null,
        keyScrap: K ?? DEFAULT_KEY_SCRAP,
        generatedAt: now,
      };
    },
  };
}

/**
 * Columns: sku, name, qty, cost, next_lot_cost, held_since, sells_for, buyer, profit_now, profit_all, status, confidence,
 * exit, exit_venue, scraptf_pays, and (0.8) advice (the advice kind), next_buyer (the next distinct buyer's price) and
 * lowest_ask (the lowest matching ask) (HOLDINGS_CSV_COLUMNS).
 */
export function holdingsCsv(rows: readonly HoldingRow[], keyScrap: Scrap | null): string {
  return toCsv([HOLDINGS_CSV_COLUMNS, ...rows.map((r) => holdingsCsvCells(r, keyScrap))]);
}
