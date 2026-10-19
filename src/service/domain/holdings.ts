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

import { z } from 'zod';
import { categoryOfSkuOnly } from '../../shared/categories';
import { formatScrap } from '../../shared/currency';
import { HOLDINGS_CSV_COLUMNS, holdingRow, holdingsCsvCells, holdingsMatching, holdingsResult, type HoldingBuySide } from '../../shared/holdings';
import type { PushContract } from '../../shared/rpc';
import { SCRAPTF_LIST_FRESH_MS } from '../../shared/scraptfList';
import { baseSku as toBaseSku, fromString } from '../../shared/sku';
import { CATEGORIES, CURRENCY_SKUS } from '../../shared/types';
import type {
  Category,
  HoldingRow,
  HoldingsQuery,
  HoldingsResult,
  JournalPosition,
  KeyPriceState,
  Listing,
  Scrap,
  ScraptfListRow,
  Settings,
  UnixMs,
} from '../../shared/types';
import type { SchemaService, ServiceDeps } from '../contracts';
import { realTimers, type TimerApi } from '../net/ratelimit';
import { toCsv } from './csv';
import { CHANGE_PROFIT_DELTA, MAX_NOTIFICATIONS_PER_RUN } from './engine';
import { journalSummary } from './journal';
import { DEFAULT_KEY_SCRAP } from './keyprice';
import { evaluateMarketBase, type MarketEval, type MarketIndex } from './market';
import { anyEffectBaseOf, matchContext } from './matcher';
import { lookupReferences, referencePrices } from './pricing';
import type { ScraptfListCache } from './scraptfList';

/** Repo meta key holding { sku: lastNotifiedAt } for "Sell:" notifications (survives restarts, like engine.lastNotified). */
export const HOLDINGS_NOTIFY_META_KEY = 'holdings.lastNotified';
/** Triggers (book changes, journal writes, settings and key moves) arriving this close together are checked once. */
export const HOLDINGS_CHECK_MS = 250;

const CURRENCY: ReadonlySet<string> = new Set(CURRENCY_SKUS);
const NO_LISTINGS: readonly Listing[] = [];
const notifyMapSchema = z.record(z.string(), z.unknown());

export interface Holdings {
  /** 'holdings.list': matching rows in holdingComparator order, totals over everything held. */
  list(q: HoldingsQuery, now: UnixMs): HoldingsResult;
  /** Matching rows in the same order, for CSV. */
  all(q: HoldingsQuery, now: UnixMs): HoldingRow[];
  /** From the market index (MarketIndexDeps.onBasesChanged): base SKUs whose entry was added, removed or moved. */
  onBasesChanged(bases: ReadonlySet<string>): void;
  /** A journal row was added or deleted (core's ctx.journalChanged). */
  journalChanged(): void;
  /** settings.profit / notifications / blocklist changed, or the key price moved by 1 scrap or more. */
  settingsChanged(): void;
  /** Base SKUs (paint removed, currencies excluded) of every open lot; core adds them to watchedSet(). */
  heldBases(): Set<string>;
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
    return { title, body: `scrap.tf's bank pays ${formatScrap(r.exitScrap, keyScrap)} (${when}), ${profit}`, sku: r.sku };
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
  const state = new Map<string, SellState>();
  let notified: Map<string, number> | null = null;
  let listFailing = false;
  /** The held items on the saved list were queued for a check by the first start(). */
  let listChecked = false;
  /**
   * F14: base -> when its 'sell' through scrap.tf ends (its list row turns a day old). Nothing else
   * re-checks an item only scrap.tf buys, so without this the next day's save would find it still
   * marked in 'sell' and never tell it again; with it, re-entering 'sell' is told like any other.
   */
  const listExpiry = new Map<string, number>();
  let expiryTimer: unknown = null;

  // Checks are batched: a key move arrives with its settings change, a burst of book changes with
  // the next market push.
  let pendingAll = false;
  const pendingBases = new Set<string>();
  let timer: unknown = null;

  // ----- reads -----

  function keyPrice(): KeyPriceState | null {
    try {
      return deps.keyPrice();
    } catch (err) {
      log.warn('Holdings could not read the key price', { error: String(err) });
      return null;
    }
  }

  /** Open positions from the journal, cached until journalChanged. */
  function heldPositions(): Held[] {
    if (held !== null) return held;
    let open: JournalPosition[];
    try {
      open = journalSummary(repo.listJournal()).open;
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
    const need = new Set(bases);
    for (const b of bases) {
      const any = genericOf(b);
      if (any !== null) need.add(any);
    }
    const books = repo.buyListingsByBaseSkus([...need]);
    const match = matchContext(settings, now);
    for (const base of bases) {
      try {
        const own = books.get(base) ?? NO_LISTINGS;
        const any = genericOf(base);
        const generic = any !== null && any !== base ? (books.get(any) ?? NO_LISTINGS) : NO_LISTINGS;
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
            references: referencePrices(lookupReferences(repo, base), K, now),
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

  /** Rows for these positions, in journal order (callers sort). */
  function rowsOf(list: readonly Held[], now: UnixMs): HoldingRow[] {
    if (list.length === 0) return [];
    const settings = deps.settings();
    const sides = new Map<string, HoldingBuySide | null>();
    const missing: string[] = [];
    const built = indexBuilt();
    for (const h of list) {
      if (h.base === null || sides.has(h.base)) continue;
      const e = entryOf(h.base);
      sides.set(h.base, e ? buySideOf(e) : null);
      // After a build the index has the answer, except for an effect a generic order may buy.
      if (!e && (!built || h.generic !== null)) missing.push(h.base);
    }
    const kv = keyPrice()?.valueScrap;
    const K = finite(kv) && kv > 0 ? kv : null;
    if (missing.length > 0) {
      try {
        const evs = evaluateOnDemand(missing, settings, K ?? DEFAULT_KEY_SCRAP, now);
        for (const [b, ev] of evs) sides.set(b, ev ? buySideOf(ev) : null);
      } catch (err) {
        log.warn('Holdings could not read order books', { error: String(err) });
      }
    }
    // Lots at the key price the revenue is valued at, so profit is what the journal will book (lotCostAt);
    // the saved scrap.tf list row at that same price is the other exit (F14, judged at `now`).
    return list.map((h) =>
      holdingRow(named(h.pos), categoryOf(h), h.base !== null ? (sides.get(h.base) ?? null) : null, settings.profit, K, {
        list: h.base !== null ? listRowOf(h.base, K) : null,
        now,
      }),
    );
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
    if (list.length === 0) return;
    const rows = rowsOf(list, now);
    trackListExpiry(list, rows);
    const n = deps.settings().notifications;
    const on = n?.enabled === true && n.holdings !== false;
    const minConfidence = finite(n?.minConfidence) ? n.minConfidence : 0;
    const dedupMs = finite(n?.dedupMs) && n.dedupMs > 0 ? n.dedupMs : 0;
    const last = on ? loadNotified() : null;
    const due: HoldingRow[] = [];
    for (const r of rows) {
      const profit = r.profitNowScrap;
      if (r.status !== 'sell' || !finite(profit)) {
        state.set(r.sku, { inSell: false, baseline: null });
        continue;
      }
      const prev = state.get(r.sku);
      const entering = prev === undefined || !prev.inSell || prev.baseline === null;
      const baseline = entering ? profit : prev.baseline!;
      const rising = !entering && profit >= baseline + CHANGE_PROFIT_DELTA;
      // Tracked whatever the gates say, so switching notifications on does not replay every sellable item.
      state.set(r.sku, { inSell: true, baseline });
      if (!(entering || rising) || last === null) continue;
      // The confidence scores the backpack.tf buyers. A scrap.tf exit is the bank's own price from a
      // saved list that bestExitOf already requires to be fresh and not full (and the body says how old).
      if (r.bestExit !== 'scraptf' && r.confidence < minConfidence) {
        // Not told yet: an entry stays pending (baseline null), so more buyers raising the confidence
        // later still tell it, without waiting for the profit to rise.
        if (entering) state.set(r.sku, { inSell: true, baseline: null });
        continue;
      }
      const ts = last.get(r.sku);
      if (ts !== undefined && now - ts < dedupMs && now >= ts) continue;
      due.push(r);
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

  /** Records when each checked row's 'sell' through scrap.tf goes stale (rows are in `list` order). */
  function trackListExpiry(list: readonly Held[], rows: readonly HoldingRow[]): void {
    // Every copy of a base is in the same check, so its old time can go before the new one is set.
    for (const h of list) if (h.base !== null) listExpiry.delete(h.base);
    rows.forEach((r, i) => {
      const base = list[i]?.base ?? null;
      if (base === null || r.status !== 'sell' || r.bestExit !== 'scraptf' || !finite(r.scraptfListAt)) return;
      // scraptfListFresh: stale once now - observedAt > SCRAPTF_LIST_FRESH_MS.
      const at = r.scraptfListAt + SCRAPTF_LIST_FRESH_MS + 1;
      const prev = listExpiry.get(base);
      listExpiry.set(base, prev === undefined ? at : Math.min(prev, at));
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
    const scope = pendingAll ? null : new Set(pendingBases);
    pendingAll = false;
    pendingBases.clear();
    try {
      check(scope);
    } catch (err) {
      // Runs from a timer: nothing may escape into the service process.
      log.warn('Holdings check failed', { error: String(err) });
    }
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
        if (h.base !== null && bases.has(h.base)) pendingBases.add(h.base);
        if (h.generic !== null && bases.has(h.generic)) pendingBases.add(h.generic);
      }
      if (pendingBases.size > 0) arm();
    },

    journalChanged() {
      held = null;
      pendingAll = true;
      arm();
    },

    settingsChanged() {
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
      if (pendingAll || pendingBases.size > 0) arm();
      armExpiry();
    },

    stop() {
      started = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      if (expiryTimer !== null) timers.clearTimeout(expiryTimer);
      expiryTimer = null;
    },
  };
}

/**
 * Columns: sku, name, qty, cost, next_lot_cost, held_since, sells_for, buyer, profit_now, profit_all, status, confidence,
 * exit, exit_venue, scraptf_pays (HOLDINGS_CSV_COLUMNS).
 */
export function holdingsCsv(rows: readonly HoldingRow[], keyScrap: Scrap | null): string {
  return toCsv([HOLDINGS_CSV_COLUMNS, ...rows.map((r) => holdingsCsvCells(r, keyScrap))]);
}
