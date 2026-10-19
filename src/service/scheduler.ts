// Periodic background jobs (DESIGN_BRIEF §2 cadences). Each job runs on a fixed
// cadence measured from the start of its previous run, never overlaps itself,
// is skipped while the network is paused or its connector is off/blocked (it
// then stays due and runs as soon as it may; a run cut short by a pause also
// stays due), and logs failures instead of throwing. Budgets are still
// enforced by the HTTP client underneath.

import { baseSku as toBaseSku } from '../shared/sku';
import type { KeyPriceQuote, UnixMs } from '../shared/types';
import type { BptfApi, Clock, Engine, HttpClient, Logger, PriceDb, Repo, SchemaService } from './contracts';
import { BptfCredentialError, BptfNotConfiguredError, BptfSnapshotUnavailableError } from './connectors/bptfApi';
import { META_LOAD_ALL_AT } from './connectors/pricedb';
import { runMaintenance, type MarketIndex } from './domain';
import { HostBlockedError, NetworkPausedError, NetworkRequestError, RateLimitedError, type TimerApi } from './net';
import type { Settings, SecretName } from '../shared/types';

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
  /** Why the job may not run right now (connector off, credential missing, host blocked), or null. */
  blockedReason?(): string | null;
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
  /** Makes a job due now (for example after a credential was added). */
  kick(id: string): void;
  states(): JobState[];
  /** Resolves when no job is running (tests, shutdown). */
  whenIdle(): Promise<void>;
}

interface Entry {
  spec: JobSpec;
  state: JobState;
  promise: Promise<void> | null;
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

  const runJob = (e: Entry, now: UnixMs): void => {
    const { spec, state } = e;
    state.running = true;
    state.lastRunAt = now;
    state.skipped = null;
    state.nextDueAt = now + spec.everyMs;
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
      jobs.set(spec.id, {
        spec,
        promise: null,
        state: { id: spec.id, running: false, nextDueAt: Number.POSITIVE_INFINITY, lastRunAt: null, lastOkAt: null, lastError: null, skipped: null },
      });
      if (started) jobs.get(spec.id)!.state.nextDueAt = clock.now() + firstDelay(spec);
    },
    start() {
      if (started) return;
      started = true;
      const now = clock.now();
      for (const e of jobs.values()) e.state.nextDueAt = now + firstDelay(e.spec);
      tick();
    },
    stop() {
      started = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
    kick(id) {
      const e = jobs.get(id);
      if (e && !e.state.running) e.state.nextDueAt = Math.min(e.state.nextDueAt, clock.now());
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

/** Time left until `lastAt + everyMs`, clamped to [min, everyMs] (a clock that moved back never stalls a job). */
function remainingCadence(lastAt: number | null, everyMs: number, now: UnixMs, min = 0): number {
  if (lastAt === null || !Number.isFinite(lastAt)) return min;
  return Math.max(min, Math.min(everyMs, lastAt + everyMs - now));
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
    err instanceof BptfNotConfiguredError
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
  /** Next base SKU queued for a background snapshot (e.g. a price was just added), or null. */
  nextQueuedSnapshot(): string | null;
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
  const bptfKeyBlocked = (): string | null => {
    if (!ctx.settings().connectors.bptfApi) return 'backpack.tf API turned off';
    if (!ctx.secret('bptfApiKey')) return 'no backpack.tf API key';
    return hostBlocked(http, 'api.backpack.tf');
  };
  /** Base SKU -> background snapshot failures in a row and when it may be tried again (this process only). */
  const snapFail = new Map<string, { n: number; until: UnixMs }>();
  const coolingDown = (base: string, now: UnixMs): boolean => (snapFail.get(base)?.until ?? 0) > now;

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
      id: 'pricedb-all',
      everyMs: 4 * HOUR,
      retryMs: 15 * MIN,
      blockedReason: () => (ctx.settings().connectors.pricedb ? hostBlocked(http, 'pricedb.io') : 'PriceDB turned off'),
      async run() {
        const n = await pricedb.loadAll();
        if (n > 0) {
          engine.markAllDirty();
          market?.markAllDirty();
        }
        return n > 0 || repo.getMeta(META_LOAD_ALL_AT) !== null;
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
        repo.transaction(() => {
          if (rows.length > 0) repo.upsertCommunity(rows);
          repo.setMeta(META_PRICES_CURRENT_TIME, String(currentTime));
          repo.setMeta(META_PRICES_FETCHED_AT, String(clock.now()));
        });
        log.info(`backpack.tf community prices: ${rows.length} rows (${since === null ? 'full' : 'delta'})`);
        if (rows.length > 0) {
          engine.markAllDirty();
          market?.markAllDirty();
        }
      },
    },
    {
      // Keeps watched SKUs' order books fresh: at most ONE background snapshot per minute, and only
      // when the snapshot budget has a free slot right now, so user refreshes are never starved.
      id: 'snapshot-watched',
      everyMs: MIN,
      firstDelayMs: 20 * SEC,
      blockedReason: () => {
        if (!ctx.settings().connectors.bptfApi) return 'backpack.tf API turned off';
        if (!ctx.secret('bptfAccessToken')) return 'no backpack.tf access token';
        if (!bptfApi.snapshotAvailable()) return 'snapshot endpoint unavailable';
        return hostBlocked(http, 'api.backpack.tf');
      },
      async run() {
        const now = clock.now();
        if (http.nextAllowedAt('bptf-snapshot') > now) return;
        let target = ctx.nextQueuedSnapshot();
        if (target !== null && coolingDown(toBaseSku(target), now)) target = null;
        if (target === null) {
          let oldest: { sku: string; at: number } | null = null;
          for (const sku of ctx.watchedBaseSkus()) {
            // A SKU whose snapshot keeps failing must not be picked every minute ahead of the rest.
            if (coolingDown(toBaseSku(sku), now)) continue;
            const at = repo.getSnapshotAt(sku) ?? 0;
            if (now - at < SNAPSHOT_STALE_MS) continue;
            if (!oldest || at < oldest.at) oldest = { sku, at };
          }
          target = oldest?.sku ?? null;
        }
        if (target === null) return;
        const base = toBaseSku(target);
        try {
          await ctx.snapshot(base, 'background');
          snapFail.delete(base);
        } catch (err) {
          if (!globalSnapshotFailure(err)) {
            const n = (snapFail.get(base)?.n ?? 0) + 1;
            const wait = Math.min(SNAPSHOT_FAIL_BASE_MS * 2 ** Math.min(n - 1, 16), SNAPSHOT_FAIL_MAX_MS);
            snapFail.set(base, { n, until: clock.now() + wait });
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
          `maintenance: purged ${r.listings} listings, ${r.events} events, ${r.requests} request-log rows, ${r.scraptfList} scrap.tf list rows, ${r.bankStock} bank stock rows, ${r.scraptfEvents} scrap.tf change events`,
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
      },
    },
  ];
}
