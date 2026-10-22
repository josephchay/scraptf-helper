// Periodic background jobs (DESIGN_BRIEF §2 cadences). Each job runs on a fixed
// cadence measured from the start of its previous run, never overlaps itself,
// is skipped while the network is paused or its connector is off/blocked (it
// then stays due and runs as soon as it may; a run cut short by a pause also
// stays due), and logs failures instead of throwing. Budgets are still
// enforced by the HTTP client underneath.

import { baseSku as toBaseSku } from '../shared/sku';
import type { CommunityPoint, KeyPriceQuote, SecretName, Settings, UnixMs } from '../shared/types';
import type { BptfApi, Clock, Engine, HttpClient, Logger, PriceDb, Repo, SchemaService } from './contracts';
import { BptfCredentialError, BptfNotConfiguredError, BptfSnapshotUnavailableError } from './connectors/bptfApi';
import { META_LOAD_ALL_AT, loadAllFresh } from './connectors/pricedb';
import { runMaintenance, type MarketIndex } from './domain';
import {
  HostBlockedError,
  HttpStatusError,
  NetworkPausedError,
  NetworkRequestError,
  RateLimitedError,
  isUnavailableStatus,
  type TimerApi,
} from './net';
import { communityHistoryPointsOf } from '../shared/communityHistory';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

export const SCHEDULER_TICK_MS = SEC;

export interface JobSpec {
  id: string;
  /** Fixed cadence, measured from the start of the previous run. */
  everyMs: number;
  /**
   * Delay before the first run after start() (default 0: run at start). A
   * function is evaluated at start(), so it can look at persisted state such as
   * when the previous process last ran the job.
   */
  firstDelayMs?: number | (() => number);
  /** After a failed run, try again after this long instead of waiting a full cadence. */
  retryMs?: number;
  /** Network jobs are skipped while the network is paused (default true). */
  network?: boolean;
  /** Why the job may not run right now (connector off, credential missing or rejected, host blocked), or null. */
  blockedReason?(): string | null;
  /**
   * 0.7.3: the tick found the job due more than a cadence ahead (the wall clock moved back) and
   * clamped it; the job clamps its own stamps the same way, so its next run is not skipped as too soon.
   */
  clockMovedBack?(now: UnixMs): void;
  /**
   * 0.7.3: how long a kick() still lets the job wait (default 0: due at once), for a job whose run would only
   * skip until then. A kick never makes a job due later than it already was.
   */
  kickDelayMs?(): number;
  /** Resolves false (or throws) when the run failed. */
  run(): Promise<boolean | void>;
}

export interface JobState {
  id: string;
  running: boolean;
  nextDueAt: UnixMs;
  lastRunAt: UnixMs | null;
  lastOkAt: UnixMs | null;
  lastError: string | null;
  /** Why the job was last skipped while due, or null. */
  skipped: string | null;
}

export interface Scheduler {
  add(job: JobSpec): void;
  start(): void;
  stop(): void;
  /** Makes a job due now (for example after a credential was added), or after its kickDelayMs. */
  kick(id: string): void;
  states(): JobState[];
  /** Resolves when no job is running (tests, shutdown). */
  whenIdle(): Promise<void>;
}

interface Entry {
  spec: JobSpec;
  state: JobState;
  promise: Promise<void> | null;
  /** The start delay until the first run (it may exceed everyMs), then 0. */
  startDelayMs: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createScheduler(opts: {
  clock: Clock;
  timers: TimerApi;
  log: Logger;
  isPaused(): boolean;
  tickMs?: number;
}): Scheduler {
  const { clock, timers, log } = opts;
  const tickMs = opts.tickMs ?? SCHEDULER_TICK_MS;
  const jobs = new Map<string, Entry>();
  let started = false;
  let timer: unknown = null;

  const firstDelay = (spec: JobSpec): number => {
    let ms: number;
    try {
      ms = typeof spec.firstDelayMs === 'function' ? spec.firstDelayMs() : (spec.firstDelayMs ?? 0);
    } catch (err) {
      log.warn(`job ${spec.id}: start delay could not be computed: ${errorText(err)}`);
      ms = 0;
    }
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  };

  const kickDelay = (spec: JobSpec): number => {
    let ms = 0;
    try {
      ms = spec.kickDelayMs?.() ?? 0;
    } catch (err) {
      log.warn(`job ${spec.id}: kick delay could not be computed: ${errorText(err)}`);
    }
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  };

  const schedule = (e: Entry, now: UnixMs): void => {
    e.startDelayMs = firstDelay(e.spec);
    e.state.nextDueAt = now + e.startDelayMs;
  };

  const runJob = (e: Entry, now: UnixMs): void => {
    const { spec, state } = e;
    state.running = true;
    state.lastRunAt = now;
    state.skipped = null;
    state.nextDueAt = now + spec.everyMs;
    e.startDelayMs = 0;
    e.promise = (async () => {
      let ok = true;
      let pausedFail = false;
      try {
        ok = (await spec.run()) !== false;
        if (!ok) state.lastError = state.lastError ?? 'run reported a failure';
      } catch (err) {
        ok = false;
        pausedFail = err instanceof NetworkPausedError;
        state.lastError = errorText(err);
        // Pauses and rate limits are expected; everything else is worth a warning.
        if (err instanceof NetworkPausedError || err instanceof RateLimitedError) log.info(`job ${spec.id}: ${state.lastError}`);
        else log.warn(`job ${spec.id} failed: ${state.lastError}`);
      } finally {
        state.running = false;
        e.promise = null;
      }
      if (ok) {
        state.lastOkAt = clock.now();
        state.lastError = null;
      } else if (spec.network !== false && (pausedFail || opts.isPaused())) {
        // Cut short by a network pause (some connectors swallow the pause and just
        // report failure): stay due, so the first tick after resume runs it again.
        state.nextDueAt = Math.min(state.nextDueAt, clock.now());
      } else if (spec.retryMs !== undefined) {
        state.nextDueAt = Math.min(state.nextDueAt, clock.now() + spec.retryMs);
      }
    })();
  };

  const tick = (): void => {
    timer = null;
    if (!started) return;
    const now = clock.now();
    for (const e of jobs.values()) {
      // 0.7.3: a wall clock stepped back while running leaves nextDueAt far ahead. As in
      // remainingCadence, a job never waits more than one cadence (or its start delay) from now.
      const maxAhead = Math.max(e.spec.everyMs, e.startDelayMs);
      if (e.state.nextDueAt - now > maxAhead) {
        e.state.nextDueAt = now + maxAhead;
        try {
          e.spec.clockMovedBack?.(now);
        } catch (err) {
          log.warn(`job ${e.spec.id}: clamping its stamps failed: ${errorText(err)}`);
        }
      }
      if (e.state.running || now < e.state.nextDueAt) continue;
      let reason: string | null = null;
      if (e.spec.network !== false && opts.isPaused()) reason = 'network paused';
      else {
        try {
          reason = e.spec.blockedReason?.() ?? null;
        } catch (err) {
          reason = `check failed: ${errorText(err)}`;
        }
      }
      if (reason !== null) {
        if (e.state.skipped !== reason) log.debug(`job ${e.spec.id} waiting: ${reason}`);
        e.state.skipped = reason;
        continue;
      }
      runJob(e, now);
    }
    timer = timers.setTimeout(tick, tickMs);
  };

  return {
    add(spec) {
      if (jobs.has(spec.id)) throw new Error(`duplicate job ${spec.id}`);
      const e: Entry = {
        spec,
        promise: null,
        startDelayMs: 0,
        state: { id: spec.id, running: false, nextDueAt: Number.POSITIVE_INFINITY, lastRunAt: null, lastOkAt: null, lastError: null, skipped: null },
      };
      jobs.set(spec.id, e);
      if (started) schedule(e, clock.now());
    },
    start() {
      if (started) return;
      started = true;
      const now = clock.now();
      for (const e of jobs.values()) schedule(e, now);
      tick();
    },
    stop() {
      started = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
    kick(id) {
      const e = jobs.get(id);
      if (e && !e.state.running) e.state.nextDueAt = Math.min(e.state.nextDueAt, clock.now() + kickDelay(e.spec));
    },
    states() {
      return [...jobs.values()].map((e) => ({ ...e.state }));
    },
    async whenIdle() {
      for (;;) {
        const running = [...jobs.values()].map((e) => e.promise).filter((p): p is Promise<void> => p !== null);
        if (running.length === 0) return;
        await Promise.allSettled(running);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The jobs
// ---------------------------------------------------------------------------

export const META_PRICES_CURRENT_TIME = 'bptf.pricesCurrentTime';
/** Repo meta: wall-clock time (UnixMs) of the last successful IGetPrices call, so a restart keeps the cadence. */
export const META_PRICES_FETCHED_AT = 'bptf.pricesFetchedAt';
/** Watched SKUs whose last snapshot is older than this are refreshed in the background. */
export const SNAPSHOT_STALE_MS = 30 * MIN;
/** A watched SKU whose background snapshot failed waits this long (doubling per failure, up to a day). */
export const SNAPSHOT_FAIL_BASE_MS = 30 * MIN;
export const SNAPSHOT_FAIL_MAX_MS = 24 * HOUR;
const KEY_BPTF_EVERY_MS = HOUR;
const BPTF_PRICES_EVERY_MS = 2 * HOUR;
const BPTF_PRICES_FIRST_DELAY_MS = 30 * SEC;
const PRICEDB_ALL_EVERY_MS = 4 * HOUR;

/** Time left until `lastAt + everyMs`, clamped to [min, everyMs] (a clock that moved back never stalls a job). */
function remainingCadence(lastAt: number | null, everyMs: number, now: UnixMs, min = 0): number {
  if (lastAt === null || !Number.isFinite(lastAt)) return min;
  return Math.max(min, Math.min(everyMs, lastAt + everyMs - now));
}

/**
 * A watched SKU's order book needs a snapshot: none yet, older than SNAPSHOT_STALE_MS, or (0.7.3)
 * stamped in the future, which after the clock moved back has no known age: stale, not fresh.
 */
export function snapshotIsStale(at: UnixMs | null, now: UnixMs): boolean {
  return at === null || at > now || now - at >= SNAPSHOT_STALE_MS;
}

/** How long a watched SKU waits after its n-th background snapshot failure in a row. */
export function snapshotFailWait(n: number): number {
  return Math.min(SNAPSHOT_FAIL_BASE_MS * 2 ** Math.min(n - 1, 16), SNAPSHOT_FAIL_MAX_MS);
}

/** Failures that are not the SKU's fault (pause, budget, credentials, endpoint or host down). */
function globalSnapshotFailure(err: unknown): boolean {
  return (
    err instanceof RateLimitedError ||
    err instanceof NetworkPausedError ||
    err instanceof NetworkRequestError ||
    err instanceof HostBlockedError ||
    err instanceof BptfSnapshotUnavailableError ||
    err instanceof BptfCredentialError ||
    err instanceof BptfNotConfiguredError ||
    // 0.7.4 (F52): a 500, 502-504 or Cloudflare 52x is taken as the host's fault, not the SKU's. The budget is
    // paused by then, so the job waits instead of cooling this one SKU down for 30 min. snapshot-watched still
    // rotates past a base that answered so, and cools it down once another base succeeded in between (the name
    // fails, not the host): see lastUnavailable in buildJobs.
    (err instanceof HttpStatusError && isUnavailableStatus(err.status))
  );
}

export interface JobContext {
  clock: Clock;
  log: Logger;
  repo: Repo;
  http: HttpClient;
  schema: SchemaService;
  pricedb: PriceDb;
  bptfApi: BptfApi;
  engine: Engine;
  /** Live market index (F10): told about the same book and reference changes as the engine. */
  market?: Pick<MarketIndex, 'markDirty' | 'markAllDirty'>;
  settings(): Settings;
  secret(name: SecretName): string | null;
  /** Base SKUs that have a scrap.tf price or an open journal lot (the watchlist; held SKUs since F11). */
  watchedBaseSkus(): string[];
  /** Next base SKU queued for a background snapshot (a price was just added: core's typed-prices queue), or null. */
  nextQueuedSnapshot(): string | null;
  /**
   * 0.7.4 (F16, F24, F30): watched base SKUs whose book matters most, most urgent first (core: profitable,
   * then below-threshold rows whose revenue order is unverified or not confirmed within CONFIRMED_MS, most
   * profit first, then rows whose unverified best order would be a flip (unverifiedUpside), then held items to
   * sell on such an order, then held items whose advice says refresh first (0.8)). snapshot-watched takes the first
   * stale one after the queue, before its oldest-first scan; the cadence and budget are unchanged. Optional (tests).
   */
  snapshotPriority?(): string[];
  /** Fetches a snapshot for a base SKU and reconciles the order book. */
  snapshot(baseSku: string, priority: 'user' | 'background'): Promise<void>;
  /** A key quote was stored; re-evaluate when the selected key value moved. */
  keyQuotesChanged(): void;
  /** F14: maintenance purged saved scrap.tf/items list rows (core refreshes the list cache and pushes). */
  scraptfListChanged?(): void;
  /** F17: maintenance pruned bank stock rows (core refreshes the bank stock cache; ctx.bankStockChanged without an import). */
  bankStockChanged?(): void;
  /** F20: maintenance pruned scrap.tf change events (core: scraptfHistory.refresh()). */
  scraptfEventsPruned?(): void;
}

function hostBlocked(http: HttpClient, host: string): string | null {
  const r = http.hostBlocked(host);
  return r ? `${host} disabled: ${r}` : null;
}

export function buildJobs(ctx: JobContext): JobSpec[] {
  const { repo, http, schema, pricedb, bptfApi, engine, log, clock, market } = ctx;
  // A rejected credential waits like a missing one: each run would only fail locally and warn again.
  // It clears when the user saves another value (core kicks the jobs) or a Settings test passes.
  const bptfKeyBlocked = (): string | null => {
    if (!ctx.settings().connectors.bptfApi) return 'backpack.tf API turned off';
    if (!ctx.secret('bptfApiKey')) return 'no backpack.tf API key';
    const rejected = bptfApi.credentialRejected('bptfApiKey');
    if (rejected) return rejected;
    return hostBlocked(http, 'api.backpack.tf');
  };
  /** Base SKU -> background snapshot failures in a row and when it may be tried again (this process only). */
  const snapFail = new Map<string, { n: number; until: UnixMs }>();
  const coolingDown = (base: string, now: UnixMs): boolean => {
    const f = snapFail.get(base);
    if (!f) return false;
    // 0.7.3: a wall clock stepped back leaves `until` further ahead than the wait itself. As in the
    // scheduler's tick, it never waits more than its own length from now.
    const wait = snapshotFailWait(f.n);
    if (f.until - now > wait) f.until = now + wait;
    return f.until > now;
  };
  /**
   * 0.7.4: base SKU -> when its last background snapshot returned (this process only). A snapshot served
   * from bptfApi's 10-min cache leaves snapshot_times alone, so without this the same base would take the
   * one slot a minute until the cache expired. A failed try is not recorded (snapFail covers the SKU's own
   * failures; a pause or a rate limit is retried as before).
   */
  const lastTried = new Map<string, UnixMs>();
  const triedRecently = (base: string, now: UnixMs): boolean => {
    const t = lastTried.get(base);
    return t !== undefined && t <= now && now - t < SNAPSHOT_STALE_MS;
  };
  /**
   * 0.7.4 (F52): base SKU -> when its last background snapshot answered unavailable (500, 502-504, 52x, 530;
   * this process only). Such an answer pauses the whole budget and sets no cooldown (an outage is the host's),
   * but one name that keeps failing must not take every slot once the pause ends: for SNAPSHOT_STALE_MS the job
   * prefers any other stale candidate and takes this base only when none is left. A second unavailable answer
   * for it after a real snapshot of another base (`lastFetchedAt`) means the name fails, not the host: it then
   * cools down like the SKU's own failures (snapFail). Still at most one request a run, inside the budget.
   */
  const lastUnavailable = new Map<string, UnixMs>();
  /** When a background snapshot last fetched a book (stamped snapshot_times; a cached answer does not count). */
  let lastFetchedAt: UnixMs | null = null;
  const recentlyUnavailable = (base: string, now: UnixMs): boolean => {
    const t = lastUnavailable.get(base);
    return t !== undefined && t <= now && now - t < SNAPSHOT_STALE_MS;
  };
  /** Time until PriceDB's full list is due again: 0 unless a load stamped within the last 4 h is still fresh. */
  const untilFullListDue = (): number => {
    const raw = repo.getMeta(META_LOAD_ALL_AT);
    const now = clock.now();
    return loadAllFresh(raw, now) ? remainingCadence(Number(raw), PRICEDB_ALL_EVERY_MS, now) : 0;
  };

  return [
    {
      // core.start() already ran schema.init() (cached copy first); this refreshes from
      // sku.pricedb.io once the copy is 24 h old (If-None-Match), and retries a failed first download.
      id: 'schema',
      everyMs: 24 * HOUR,
      retryMs: 15 * MIN,
      blockedReason: () => hostBlocked(http, 'sku.pricedb.io'),
      async run() {
        const before = schema.isLoaded();
        await schema.refresh(false);
        const loaded = schema.isLoaded();
        // A first download that failed at start: the market's names and categories were raw SKUs.
        if (!before && loaded) market?.markAllDirty();
        return loaded;
      },
    },
    {
      // Cold-start full PriceDB list; pricedb.loadAll() itself skips when the last load is under 4 h old.
      // 0.7.3: that stamp is the load's start, so each 4 h run loads; a failed load leaves the old stamp,
      // so the run fails and is retried after retryMs instead of counting as OK.
      id: 'pricedb-all',
      everyMs: PRICEDB_ALL_EVERY_MS,
      retryMs: 15 * MIN,
      // 0.7.3: a restart within 4 h of the last load waits out the rest of those 4 h. Run at start, it would
      // only skip, and the next load would come a full cadence later (up to 8 h after the previous one).
      firstDelayMs: untilFullListDue,
      // 0.7.3: the same for core's kicks (a PriceDB or backpack.tf API toggle, pricedb.io re-enabled): within
      // 4 h of a load the job keeps its due time; a load that is due (or a failed one) still runs at once.
      kickDelayMs: untilFullListDue,
      // 0.7.3: the tick moved this job to 4 h from now; a last-load stamp still in the future becomes now
      // too. Left as is, the clock passes it before that run, which then skips the list as fresh.
      clockMovedBack: (now) => {
        const last = Number(repo.getMeta(META_LOAD_ALL_AT) ?? NaN);
        if (Number.isFinite(last) && last > now) repo.setMeta(META_LOAD_ALL_AT, String(now));
      },
      blockedReason: () => (ctx.settings().connectors.pricedb ? hostBlocked(http, 'pricedb.io') : 'PriceDB turned off'),
      async run() {
        const n = await pricedb.loadAll();
        if (n > 0) {
          engine.markAllDirty();
          market?.markAllDirty();
        }
        // OK when this run loaded the list or skipped one that is still fresh (the same test loadAll skips on).
        return n > 0 || loadAllFresh(repo.getMeta(META_LOAD_ALL_AT), clock.now());
      },
    },
    {
      id: 'key-pricedb',
      everyMs: 30 * MIN,
      retryMs: 5 * MIN,
      blockedReason: () => (ctx.settings().connectors.pricedb ? hostBlocked(http, 'pricedb.io') : 'PriceDB turned off'),
      async run() {
        const q = await pricedb.keyQuote();
        if (q) ctx.keyQuotesChanged();
        return q !== null;
      },
    },
    {
      id: 'key-bptf',
      everyMs: KEY_BPTF_EVERY_MS,
      retryMs: 15 * MIN,
      // A restart keeps the hourly cadence of the previous process instead of calling at once.
      firstDelayMs: () => {
        let last: number | null = null;
        for (const q of repo.keyQuotes()) if (q.source === 'bptf' && (last === null || q.observedAt > last)) last = q.observedAt;
        return remainingCadence(last, KEY_BPTF_EVERY_MS, clock.now());
      },
      blockedReason: bptfKeyBlocked,
      async run() {
        const q: KeyPriceQuote | null = await bptfApi.currencies();
        if (q) {
          repo.upsertKeyQuote(q);
          ctx.keyQuotesChanged();
        }
        return q !== null;
      },
    },
    {
      // IGetPrices v4: one full fetch, then `since` deltas every 2 h (budget: never more often than 15 min).
      id: 'bptf-prices',
      everyMs: BPTF_PRICES_EVERY_MS,
      retryMs: 20 * MIN,
      // 30 s after start, or later when the previous process fetched less than 2 h ago.
      firstDelayMs: () => {
        const raw = repo.getMeta(META_PRICES_FETCHED_AT);
        const last = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
        return remainingCadence(last, BPTF_PRICES_EVERY_MS, clock.now(), BPTF_PRICES_FIRST_DELAY_MS);
      },
      blockedReason: bptfKeyBlocked,
      async run() {
        const raw = repo.getMeta(META_PRICES_CURRENT_TIME);
        const since = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
        const { rows, currentTime } = await bptfApi.prices(since);
        let kept = 0;
        repo.transaction(() => {
          if (rows.length > 0) {
            // 0.9 (history, RESEARCH #7): the prices this answer replaces are kept as history (storage only, H7). A failed
            // history step costs only the history: nested transactions roll back alone.
            let points: CommunityPoint[] = [];
            try {
              points = communityHistoryPointsOf(repo.communityFor(rows.map((r) => r.sku)), rows, { delta: since !== null, recordedAt: clock.now() });
            } catch (err) {
              log.warn(`backpack.tf community prices: could not read the stored prices for the history: ${errorText(err)}`);
            }
            repo.upsertCommunity(rows);
            if (points.length > 0) {
              try {
                kept = repo.transaction(() => repo.insertCommunityHistory(points));
              } catch (err) {
                log.warn(`backpack.tf community prices: could not keep the price history: ${errorText(err)}`);
              }
            }
          }
          repo.setMeta(META_PRICES_CURRENT_TIME, String(currentTime));
          repo.setMeta(META_PRICES_FETCHED_AT, String(clock.now()));
        });
        log.info(`backpack.tf community prices: ${rows.length} rows (${since === null ? 'full' : 'delta'}), ${kept} kept in the price history`);
        if (rows.length > 0) {
          engine.markAllDirty();
          market?.markAllDirty();
        }
      },
    },
    {
      // Keeps watched SKUs' order books fresh: at most ONE background snapshot per minute, and only
      // when the snapshot budget has a free slot right now, so user refreshes are never starved.
      // 0.7.4: the pick is the queue, then ctx.snapshotPriority (unconfirmed profitable rows first), then
      // the oldest snapshot; only the order changed, not the cadence, the budget or the watched-only rule. A base
      // whose last answer was unavailable goes behind every other stale candidate (lastUnavailable).
      id: 'snapshot-watched',
      everyMs: MIN,
      firstDelayMs: 20 * SEC,
      blockedReason: () => {
        if (!ctx.settings().connectors.bptfApi) return 'backpack.tf API turned off';
        if (!ctx.secret('bptfAccessToken')) return 'no backpack.tf access token';
        const rejected = bptfApi.credentialRejected('bptfAccessToken');
        if (rejected) return rejected;
        if (!bptfApi.snapshotAvailable()) return 'snapshot endpoint unavailable';
        return hostBlocked(http, 'api.backpack.tf');
      },
      async run() {
        const now = clock.now();
        if (http.nextAllowedAt('bptf-snapshot') > now) return;
        let target = ctx.nextQueuedSnapshot();
        if (target !== null && (coolingDown(toBaseSku(target), now) || triedRecently(toBaseSku(target), now))) target = null;
        const watched = target === null ? ctx.watchedBaseSkus() : [];
        /** 0.7.4 (F52): the first stale priority base skipped for a recent unavailable answer (used only when nothing else is stale). */
        let afterOthers: string | null = null;
        if (target === null && ctx.snapshotPriority) {
          // 0.7.4: the books the user is about to act on first, still watched ones only.
          let urgent: string[] = [];
          try {
            urgent = ctx.snapshotPriority();
          } catch (err) {
            log.warn(`could not rank the background snapshots: ${err instanceof Error ? err.message : String(err)}`);
          }
          const isWatched = new Set(watched);
          for (const sku of urgent) {
            const base = toBaseSku(sku);
            if (!isWatched.has(base) || coolingDown(base, now) || triedRecently(base, now)) continue;
            if (!snapshotIsStale(repo.getSnapshotAt(base), now)) continue;
            if (recentlyUnavailable(base, now)) {
              afterOthers ??= base;
              continue;
            }
            target = base;
            break;
          }
        }
        if (target === null) {
          let oldest: { sku: string; at: number } | null = null;
          let oldestUnavailable: { sku: string; at: number } | null = null;
          for (const sku of watched) {
            // A SKU whose snapshot keeps failing must not be picked every minute ahead of the rest.
            if (coolingDown(toBaseSku(sku), now) || triedRecently(toBaseSku(sku), now)) continue;
            const at = repo.getSnapshotAt(sku) ?? 0;
            // 0.7.3: one stamped in the future (clock moved back) has no known age: stale, not fresh.
            if (!snapshotIsStale(at, now)) continue;
            if (recentlyUnavailable(toBaseSku(sku), now)) {
              if (!oldestUnavailable || at < oldestUnavailable.at) oldestUnavailable = { sku, at };
              continue;
            }
            if (!oldest || at < oldest.at) oldest = { sku, at };
          }
          target = oldest?.sku ?? afterOthers ?? oldestUnavailable?.sku ?? null;
        }
        if (target === null) return;
        const base = toBaseSku(target);
        const stampBefore = repo.getSnapshotAt(base);
        try {
          await ctx.snapshot(base, 'background');
          snapFail.delete(base);
          lastUnavailable.delete(base);
          const done = clock.now();
          if (repo.getSnapshotAt(base) !== stampBefore) lastFetchedAt = done;
          lastTried.set(base, done);
          if (lastTried.size > 1_000) for (const [b, t] of lastTried) if (!(t <= done && done - t < SNAPSHOT_STALE_MS)) lastTried.delete(b);
        } catch (err) {
          const failedAt = clock.now();
          if (err instanceof HttpStatusError && isUnavailableStatus(err.status)) {
            // 0.7.4 (F52): the budget is paused (host's failure). The same base answering so again after another
            // base's book was fetched in between is this name's failure: it cools down like a 4xx.
            const prev = lastUnavailable.get(base);
            if (prev !== undefined && lastFetchedAt !== null && lastFetchedAt > prev) {
              const n = (snapFail.get(base)?.n ?? 0) + 1;
              snapFail.set(base, { n, until: failedAt + snapshotFailWait(n) });
            }
            lastUnavailable.set(base, failedAt);
            if (lastUnavailable.size > 1_000) for (const [b, t] of lastUnavailable) if (!(t <= failedAt && failedAt - t < SNAPSHOT_FAIL_MAX_MS)) lastUnavailable.delete(b);
          } else if (!globalSnapshotFailure(err)) {
            const n = (snapFail.get(base)?.n ?? 0) + 1;
            snapFail.set(base, { n, until: failedAt + snapshotFailWait(n) });
          }
          throw err;
        }
      },
    },
    {
      // PriceDB references for watched SKUs (bulk, 100 per request).
      id: 'pricedb-watched',
      everyMs: 30 * MIN,
      firstDelayMs: 2 * MIN,
      retryMs: 10 * MIN,
      blockedReason: () => (ctx.settings().connectors.pricedb ? hostBlocked(http, 'pricedb.io') : 'PriceDB turned off'),
      async run() {
        const watched = ctx.watchedBaseSkus();
        if (watched.length === 0) return;
        const rows = await pricedb.bulk(watched);
        if (rows.length > 0) {
          const skus = rows.map((r) => r.sku);
          engine.markDirty(skus);
          market?.markDirty(skus);
        }
      },
    },
    {
      id: 'maintenance',
      everyMs: 24 * HOUR,
      firstDelayMs: 5 * MIN,
      network: false,
      async run() {
        const r = runMaintenance(repo, clock.now());
        log.info(
          `maintenance: purged ${r.listings} listings, ${r.events} events, ${r.requests} request-log rows, ${r.scraptfList} scrap.tf list rows, ${r.bankStock} bank stock rows, ${r.scraptfEvents} scrap.tf change events, ${r.holdingMarks} exit runs, ${r.orderSpells} buy-order spells, ${r.communityHistory} community price points, ${r.scraptfLows} scrap.tf lows`,
        );
        engine.markAllDirty();
        // Purged listings were deleted without a markDirty: entries built on them must go.
        market?.markAllDirty();
        if (r.scraptfList > 0) ctx.scraptfListChanged?.();
        // F17: a pruned save may have been a bank's previous one, so its diff changes. F20: core also
        // rebuilds the history index there (thinned saves leave the runs).
        if (r.bankStock > 0) ctx.bankStockChanged?.();
        // F20: pruned change events only shorten the feed; core refreshes the history's caches.
        if (r.scraptfEvents > 0) ctx.scraptfEventsPruned?.();
        // 0.9 (history): pruned stored lows; the same refresh drops the history's stored-lows memo.
        if (r.scraptfLows > 0) ctx.scraptfEventsPruned?.();
      },
    },
  ];
}
