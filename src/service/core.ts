// Wires the service together: SQLite repo, the policy-checked HTTP client,
// connectors, the opportunity engine, the backpack.tf feed, periodic jobs, the
// saved-page folder watcher, status/health reporting and the opportunity log.
// entry.ts runs this inside Electron's utilityProcess; tests run it headless
// with a fake fetch and websocket.

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PushContract, PushEvent, RpcMethod } from '../shared/rpc';
import { baseSku as toBaseSku, looksLikeSku } from '../shared/sku';
import type { AppStatus, ConnectorHealth, HealthReport, Listing, RequestLogRow, SecretName, Settings, UnixMs } from '../shared/types';
import { SECRET_NAMES } from '../shared/types';
import { createBptfApi } from './connectors/bptfApi';
import { createBptfSocket, type SocketTimers } from './connectors/bptfSocket';
import { META_LOAD_ALL_AT, createPriceDb, type PricedbSocketFactory } from './connectors/pricedb';
import { createSchemaService } from './connectors/schema';
import { createSteamMarket } from './connectors/steamMarket';
import type { Clock, FeedBatch, Logger, Repo, ServiceDeps, WebSocketLike } from './contracts';
import { systemClock } from './contracts';
import { SchemaVersionError, openRepo } from './db';
import { RETENTION, createEngine, createHoldings, createMarketIndex, explicitInput, selectKeyPrice } from './domain';
import { createFolderWatcher, type FolderWatcher, type WatchFactory } from './import';
import {
  BUDGETS,
  budgetById,
  buildUserAgent,
  createHttpClient,
  defaultBudgetFor,
  parseHostBlocks,
  parsePauseState,
  registerSecret,
  unregisterSecret,
  type NetPauseState,
} from './net';
import { createRpcHandlers, importSavedPage, type HandlerContext } from './rpcHandlers';
import { buildJobs, createScheduler, SNAPSHOT_STALE_MS, type Scheduler } from './scheduler';

export const DB_FILE_NAME = 'flipdesk.sqlite';
export const STATUS_INTERVAL_MS = 10_000;
/** Repo meta: id of the last opportunity event written to the JSONL log. */
export const META_OPP_LOG_LAST_ID = 'oppLog.lastEventId';
/** Request-log rows this far back are counted against the budgets at start (longest budget window: a day). */
const BUDGET_RESTORE_MS = 24 * 60 * 60_000;
/**
 * Repo meta prefix: the last request sent on a budget spaced at least
 * SLOW_BUDGET_MS apart (IGetPrices, IGetCurrencies, mannco), saved before it is
 * sent. Its request-log row only appears when the exchange ends, so without
 * this a request the service died during (OOM on a big response, a crash)
 * would not count after the restart and would be sent again at once.
 */
export const META_BUDGET_SENT_PREFIX = 'net.lastSent.';
const SLOW_BUDGET_MS = 60_000;

type RequestStart = Pick<RequestLogRow, 'ts' | 'host' | 'path'>;

/** Saved slow-budget starts that have no request-log row (the process died mid-request), as rows for seedHistory. */
export function unloggedStarts(repo: Pick<Repo, 'getMeta'>, logged: readonly RequestStart[], since: UnixMs): RequestStart[] {
  const out: RequestStart[] = [];
  for (const b of BUDGETS) {
    if (b.minIntervalMs < SLOW_BUDGET_MS) continue;
    let start: RequestStart;
    try {
      const v = JSON.parse(repo.getMeta(META_BUDGET_SENT_PREFIX + b.id) ?? 'null') as Partial<RequestStart> | null;
      if (!v || typeof v.ts !== 'number' || !Number.isFinite(v.ts) || typeof v.host !== 'string' || typeof v.path !== 'string') continue;
      start = { ts: v.ts, host: v.host, path: v.path };
    } catch {
      continue;
    }
    if (start.ts < since) continue;
    // The log row of a finished request carries the same start time.
    const budgetOf = (r: RequestStart) => defaultBudgetFor(`https://${r.host}${r.path.startsWith('/') ? r.path : `/${r.path}`}`);
    if (logged.some((r) => r.ts >= start.ts && budgetOf(r) === b.id)) continue;
    out.push(start);
  }
  return out;
}

/** opportunities-YYYY-MM-DD.jsonl files are kept as long as the events in the database. */
export const OPP_LOG_RETENTION_MS = RETENTION.eventsMs;
/** Older opportunity log files are also removed while all of them together exceed this. */
export const OPP_LOG_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const OPP_LOG_FILE_RE = /^opportunities-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Opportunity events written to the JSONL log per page, and pages per flush (the rest goes next flush). */
const OPP_LOG_PAGE = 1000;
const OPP_LOG_PAGES_PER_FLUSH = 50;
/** Feed deletes are remembered this long, so a snapshot taken earlier cannot bring the listing back. */
const FEED_TOMBSTONE_MS = 30 * 60_000;
/** A dead or missing watch folder is tried again at most this often. */
const WATCH_RETRY_MS = 60_000;
/** Repo meta: the saved page the folder watch was importing, cleared when done; a leftover means it crashed the service. */
export const META_WATCH_IMPORTING = 'import.watchImporting';
/** Repo meta: hosts disabled after a challenge page, as JSON {host: reason}; cleared only by the user (R7). */
export const META_BLOCKED_HOSTS = 'net.blockedHosts';
/**
 * Repo meta: budget pauses (429/503 Retry-After, backoff, RateLimit-Remaining)
 * and 429 streaks, as JSON NetPauseState. Restored at start so a crash restart
 * or relaunch keeps honouring the server's wait (R7); restored pauses are
 * clamped to 24 h.
 */
export const META_NET_PAUSES = 'net.pauses';

/** Host whose block disables each connector, for the Data health page's "Re-enable" button. */
const CONNECTOR_HOSTS: Readonly<Record<string, string>> = {
  'bptf-ws': 'ws.backpack.tf',
  'bptf-snapshot': 'api.backpack.tf',
  'bptf-prices': 'api.backpack.tf',
  'bptf-currencies': 'api.backpack.tf',
  'bptf-users': 'api.backpack.tf',
  schema: 'sku.pricedb.io',
  pricedb: 'pricedb.io',
  'pricedb-socket': 'ws.pricedb.io',
  scm: 'steamcommunity.com',
};

/** Jobs that run again right after the user re-enables a host. */
const HOST_JOBS: Readonly<Record<string, readonly string[]>> = {
  'api.backpack.tf': ['key-bptf', 'bptf-prices'],
  'backpack.tf': ['key-bptf', 'bptf-prices'],
  'pricedb.io': ['pricedb-all', 'key-pricedb'],
  'sku.pricedb.io': ['schema'],
};

export interface ServiceCoreOptions {
  dataDir: string;
  version: string;
  settings: Settings;
  secrets: Partial<Record<SecretName, string>>;
  log: Logger;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocketLike;
  socketFactory?: PricedbSocketFactory;
  /** Folder-watch factory (tests inject watcher errors). */
  watchFactory?: WatchFactory;
  clock?: Clock;
  timers?: SocketTimers;
}

export interface ServiceCore {
  /** Starts the engine, the feed, the folder watcher and the periodic jobs; resolves after the first schema load. */
  start(): Promise<void>;
  stop(): Promise<void>;
  handle(method: RpcMethod | string, params: unknown): Promise<unknown>;
  updateSettings(settings: Settings): void;
  updateSecrets(secrets: Partial<Record<SecretName, string>>): void;
  onPush(cb: (event: PushEvent, payload: unknown) => void): () => void;
}

/** Unref'd real timers: the parent port keeps the utilityProcess alive, tests exit cleanly. */
export const serviceTimers: SocketTimers = {
  setTimeout(fn, ms) {
    const h = setTimeout(fn, Math.min(Math.max(0, ms), 2_147_000_000));
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout(h) {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
  setInterval(fn, ms) {
    const h = setInterval(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval(h) {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function localDate(ms: UnixMs): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Brief §7.1: confirm node:sqlite is compiled in and record the runtime versions. */
function selfTest(log: Logger): void {
  const v = process.versions as Record<string, string | undefined>;
  let sqlite = 'missing';
  try {
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const mod = getBuiltin ? (getBuiltin('node:sqlite') as { DatabaseSync?: unknown } | undefined) : undefined;
    sqlite = mod && typeof mod.DatabaseSync === 'function' ? `ok${v['sqlite'] ? ` (SQLite ${v['sqlite']})` : ''}` : 'missing';
  } catch (err) {
    sqlite = `failed: ${errorText(err)}`;
  }
  log.info(`service self-test: node ${v['node'] ?? '?'}, electron ${v['electron'] ?? 'n/a'}, v8 ${v['v8'] ?? '?'}, node:sqlite ${sqlite}`);
}

/** A core that only reports why it could not start (e.g. a database from a newer version). */
function failedCore(reason: string, log: Logger): ServiceCore {
  log.error(`service cannot start: ${reason}`);
  return {
    start: async () => undefined,
    stop: async () => undefined,
    handle: async () => {
      throw new Error(reason);
    },
    updateSettings: () => undefined,
    updateSecrets: () => undefined,
    onPush: () => () => undefined,
  };
}

export function createServiceCore(opts: ServiceCoreOptions): ServiceCore {
  const log = opts.log;
  const clock = opts.clock ?? systemClock;
  const timers = opts.timers ?? serviceTimers;
  const dataDir = path.resolve(opts.dataDir);
  const logDir = path.join(path.dirname(dataDir), 'logs');
  let settings: Settings = opts.settings;
  let secrets: Partial<Record<SecretName, string>> = {};
  let started = false;
  let stopped = false;

  selfTest(log);

  // ----- storage -----
  let repo: Repo;
  try {
    mkdirSync(dataDir, { recursive: true });
    repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  } catch (err) {
    if (err instanceof SchemaVersionError) return failedCore(err.message, log);
    return failedCore(`The database could not be opened: ${errorText(err)}`, log);
  }

  // ----- secrets (R8: registered for redaction before any request is made) -----
  const applySecrets = (next: Partial<Record<SecretName, string>>): void => {
    for (const name of SECRET_NAMES) {
      const before = secrets[name];
      const after = typeof next[name] === 'string' && next[name]!.trim() !== '' ? next[name] : undefined;
      if (before && before !== after) unregisterSecret(before);
      if (after) registerSecret(after);
    }
    const clean: Partial<Record<SecretName, string>> = {};
    for (const name of SECRET_NAMES) {
      const v = next[name];
      if (typeof v === 'string' && v.trim() !== '') clean[name] = v;
    }
    secrets = clean;
  };
  applySecrets(opts.secrets ?? {});

  // ----- push -----
  const pushListeners = new Set<(event: PushEvent, payload: unknown) => void>();
  const push = <E extends PushEvent>(event: E, payload: PushContract[E]): void => {
    for (const fn of pushListeners) {
      try {
        fn(event, payload);
      } catch (err) {
        log.warn(`push listener for ${event} failed: ${errorText(err)}`);
      }
    }
  };

  // ----- network and connectors -----
  // Challenge blocks survive restarts and crashes; only net.unblock clears them (R7).
  let hostBlocks: Record<string, string> = {};
  try {
    hostBlocks = parseHostBlocks(repo.getMeta(META_BLOCKED_HOSTS));
  } catch (err) {
    log.warn(`could not read the disabled hosts: ${errorText(err)}`);
  }
  // Retry-After pauses and 429 streaks survive restarts too (R7); see META_NET_PAUSES.
  let savedPauses: NetPauseState | undefined;
  try {
    savedPauses = parsePauseState(repo.getMeta(META_NET_PAUSES));
  } catch (err) {
    log.warn(`could not read the request pauses: ${errorText(err)}`);
  }
  const http = createHttpClient({
    clock,
    log,
    timers,
    sink: { record: (row) => repo.appendRequestLog(row) },
    userAgent: () => buildUserAgent(opts.version, settings.contactUrl),
    initialBlocks: hostBlocks,
    onBlocksChanged: (blocks) => {
      hostBlocks = blocks;
      repo.setMeta(META_BLOCKED_HOSTS, JSON.stringify(blocks));
    },
    ...(savedPauses ? { initialPauses: savedPauses } : {}),
    onPausesChanged: (state) => repo.setMeta(META_NET_PAUSES, JSON.stringify(state)),
    // The log row is written when the exchange ends; remember slow-budget starts before sending.
    onBeforeSend: (start) => {
      if ((budgetById(start.budget)?.minIntervalMs ?? 0) < SLOW_BUDGET_MS) return;
      repo.setMeta(META_BUDGET_SENT_PREFIX + start.budget, JSON.stringify({ ts: start.ts, host: start.host, path: start.path }));
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  // Budgets are hard ceilings across relaunches and crash restarts too (R7): count the
  // requests the previous processes made (request log) before anything new goes out.
  try {
    const rows = repo.requestsSince(clock.now() - BUDGET_RESTORE_MS);
    http.seedHistory([...rows, ...unloggedStarts(repo, rows, clock.now() - BUDGET_RESTORE_MS)]);
  } catch (err) {
    log.warn(`could not restore request budgets from the request log: ${errorText(err)}`);
  }
  http.setPaused(settings.networkPaused);

  const deps: ServiceDeps = {
    clock,
    log,
    repo,
    http,
    settings: () => settings,
    secret: (name) => secrets[name] ?? null,
  };
  const schema = createSchemaService(deps);
  const pricedb = createPriceDb(deps, { timers, ...(opts.socketFactory ? { socketFactory: opts.socketFactory } : {}) });
  const scm = createSteamMarket(deps);
  const bptfApi = createBptfApi({ ...deps, schema });

  // ----- watchlist: base SKUs with a scrap.tf price, and held ones (F11) -----
  let watched: Set<string> | null = null;
  let priceCount = 0;
  const watchedSet = (): Set<string> => {
    if (watched) return watched;
    const set = new Set<string>();
    const prices = repo.listScrapPrices();
    for (const sp of prices) {
      const inp = explicitInput(sp);
      if (inp) set.add(inp.baseSku);
    }
    // Open journal lots: the budgeted snapshot job keeps their book fresh and their sell listings are kept.
    // No new request kind: held SKUs only join the same watch list (reset by ctx.journalChanged).
    try {
      for (const b of holdings.heldBases()) set.add(b);
    } catch (err) {
      log.warn(`could not read the held items: ${errorText(err)}`);
    }
    priceCount = prices.length;
    watched = set;
    return set;
  };

  // ----- opportunity log (JSONL per local day) -----
  let lastLoggedId: number | null = null;
  const initOppLog = (): void => {
    const raw = repo.getMeta(META_OPP_LOG_LAST_ID);
    if (raw !== null && /^\d+$/.test(raw)) lastLoggedId = Number(raw);
    else {
      // First run: start after whatever is already stored instead of dumping history.
      lastLoggedId = repo.listEvents({ limit: 1 })[0]?.id ?? 0;
      repo.setMeta(META_OPP_LOG_LAST_ID, String(lastLoggedId));
    }
  };
  /**
   * Once per local day: removes opportunity log files older than the event
   * retention, then the oldest ones while all of them exceed the size cap
   * (today's file is never removed).
   */
  let lastPrunedDay = '';
  const pruneOppLogs = (now: UnixMs): void => {
    const today = localDate(now);
    if (today === lastPrunedDay) return;
    lastPrunedDay = today;
    let names: string[];
    try {
      names = readdirSync(logDir);
    } catch {
      return; // no logs folder yet
    }
    const cutoff = localDate(now - OPP_LOG_RETENTION_MS); // YYYY-MM-DD compares as text
    const files: { name: string; day: string; bytes: number }[] = [];
    for (const name of names) {
      const day = OPP_LOG_FILE_RE.exec(name)?.[1];
      if (day === undefined) continue;
      let bytes = 0;
      try {
        bytes = statSync(path.join(logDir, name)).size;
      } catch {
        continue;
      }
      files.push({ name, day, bytes });
    }
    files.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    let total = files.reduce((n, f) => n + f.bytes, 0);
    for (const f of files) {
      if (f.day >= today) break;
      if (f.day >= cutoff && total <= OPP_LOG_MAX_TOTAL_BYTES) break;
      try {
        rmSync(path.join(logDir, f.name), { force: true });
        total -= f.bytes;
        log.info(`removed old opportunity log ${f.name}`);
      } catch (err) {
        log.warn(`could not remove old opportunity log ${f.name}: ${errorText(err)}`);
      }
    }
  };

  const flushOppLog = (): void => {
    try {
      pruneOppLogs(clock.now());
      if (lastLoggedId === null) initOppLog();
      // Oldest first from the cursor, and the cursor moves after each written page,
      // so a backlog is never skipped; a very large one continues on the next flush.
      for (let page = 0; page < OPP_LOG_PAGES_PER_FLUSH; page++) {
        const rows = repo.listEvents({ afterId: lastLoggedId!, limit: OPP_LOG_PAGE });
        if (rows.length === 0) return;
        mkdirSync(logDir, { recursive: true });
        const byFile = new Map<string, string[]>();
        for (const e of rows) {
          const file = path.join(logDir, `opportunities-${localDate(e.ts)}.jsonl`);
          const lines = byFile.get(file) ?? [];
          lines.push(JSON.stringify(e));
          byFile.set(file, lines);
        }
        for (const [file, lines] of byFile) appendFileSync(file, `${lines.join('\n')}\n`);
        lastLoggedId = Math.max(lastLoggedId!, ...rows.map((e) => e.id));
        repo.setMeta(META_OPP_LOG_LAST_ID, String(lastLoggedId));
        if (rows.length < OPP_LOG_PAGE) return;
      }
    } catch (err) {
      log.warn(`opportunity log write failed: ${errorText(err)}`);
    }
  };

  // ----- status -----
  let lastStatusJson = '';
  let statusTimer: unknown = null;
  let statusSoon: unknown = null;

  const engine = createEngine({
    ...deps,
    schema,
    timers,
    events: {
      onChanged: (summary) => {
        flushOppLog();
        push('opps.changed', summary);
        scheduleStatusCheck();
      },
      onNotify: (n) => push('notify', n),
    },
  });

  // Live market (F10): reads the same local book as the engine and values keys with its key price.
  // It keeps serving its last state while the network is paused (the feed stops anyway).
  const market = createMarketIndex({
    ...deps,
    schema,
    timers,
    keyPrice: () => engine.keyPrice(),
    onChanged: (p) => push('market.changed', p),
    // syncFolderWatch drops the watcher when the folder is missing; a failed OS watch is not alive.
    // Read only from market.list, after construction, so the later `let watcher` is initialised.
    folderWatchActive: () => watcher !== null && watcher.handle.alive(),
    // Called from the index's timers only, after construction, so `holdings` below is initialised.
    onBasesChanged: (bases) => holdings.onBasesChanged(bases),
  });

  // Holdings (F11): open journal lots priced from the market index; "Sell:" notifications go through main.
  const holdings = createHoldings({
    ...deps,
    schema,
    market,
    timers,
    keyPrice: () => engine.keyPrice(),
    notify: (n) => push('notify', n),
  });

  // ----- backpack.tf feed -----
  /** Listing id -> when the feed deleted it, oldest first (lets a snapshot taken earlier not re-create it). */
  const feedDeletes = new Map<string, UnixMs>();
  const rememberFeedDeletes = (b: FeedBatch): void => {
    const now = clock.now();
    for (const id of b.deletes) {
      feedDeletes.delete(id); // keeps the map in time order
      feedDeletes.set(id, now);
    }
    // A later listing-update means the listing exists again.
    for (const l of b.upserts) feedDeletes.delete(l.id);
    for (const [id, at] of feedDeletes) {
      if (now - at < FEED_TOMBSTONE_MS) break;
      feedDeletes.delete(id);
    }
  };

  const onBatch = (b: FeedBatch): void => {
    rememberFeedDeletes(b);
    const keepAll = settings.liveFeed.keepSellListings === 'all';
    const watch = watchedSet();
    const keep = b.upserts.filter((l) => l.intent === 'buy' || keepAll || watch.has(l.baseSku));
    const affected = new Set<string>();
    repo.transaction(() => {
      if (b.names.length > 0) repo.upsertBptfNames(b.names);
      if (b.deletes.length > 0) {
        for (const id of b.deletes) {
          const old = repo.getListing(id);
          if (old && old.intent === 'buy') affected.add(old.baseSku);
        }
        repo.deleteListings(b.deletes);
      }
      if (keep.length > 0) repo.upsertListings(keep);
    });
    for (const l of keep) if (l.intent === 'buy') affected.add(l.baseSku);
    if (affected.size > 0) {
      engine.markDirty(affected);
      market.markDirty(affected);
    }
  };
  const socket = createBptfSocket({ ...deps, schema, onBatch, timers, ...(opts.wsFactory ? { wsFactory: opts.wsFactory } : {}) });

  // ----- snapshots -----
  const snapshotQueue: string[] = [];
  const queueSnapshot = (base: string): void => {
    if (!looksLikeSku(base) || snapshotQueue.includes(base)) return;
    snapshotQueue.push(base);
    if (snapshotQueue.length > 50) snapshotQueue.shift();
  };

  /** Fetches a snapshot and reconciles stored listings for that base SKU. */
  const snapshot = async (base: string, priority: 'user' | 'background'): Promise<void> => {
    const startedAt = clock.now();
    const before = repo.getSnapshotAt(base);
    const result = await bptfApi.snapshot(base, priority);
    const after = repo.getSnapshotAt(base);
    if (after === null || after === before) {
      // A cached result (served again within 10 min) predates what the feed reported since:
      // replaying it would bring back deleted orders and old prices, so the feed keeps the book.
      log.info(`snapshot ${base}: served from cache; order book left to the live feed`);
      return;
    }
    const keepAll = settings.liveFeed.keepSellListings === 'all';
    const snapshotTime = result.createdAt !== null ? Math.min(startedAt, result.createdAt * 1000) : startedAt;
    /** The feed updated or deleted this listing after the snapshot was taken, so the snapshot copy is stale. */
    const feedIsNewer = (l: Listing): boolean => {
      const deletedAt = feedDeletes.get(l.id);
      if (deletedAt !== undefined && deletedAt >= snapshotTime) return true;
      const cur = repo.getListing(l.id);
      return cur !== null && cur.lastEventAt >= snapshotTime;
    };
    const affected = new Set<string>([base]);
    let mine: Listing[] = [];
    repo.transaction(() => {
      const rows = result.listings
        .filter((l) => l.baseSku === base || l.intent === 'buy' || keepAll)
        .filter((l) => !feedIsNewer(l))
        // Seen as of the snapshot, not as of the fetch (confidence counts recent confirmations).
        .map((l) => ({ ...l, lastEventAt: Math.min(l.lastEventAt, snapshotTime) }));
      mine = rows.filter((l) => l.baseSku === base);
      repo.upsertListings(rows);
      for (const l of rows) affected.add(l.baseSku);
      for (const intent of ['buy', 'sell'] as const) {
        const keepIds = new Set(mine.filter((l) => l.intent === intent).map((l) => l.id));
        // Listings the feed reported after the snapshot was taken stay.
        for (const l of repo.listingsByBaseSku(base, intent)) if (l.lastEventAt >= snapshotTime) keepIds.add(l.id);
        repo.deleteListingsNotIn(base, intent, [...keepIds]);
      }
    });
    engine.markDirty(affected);
    market.markDirty(affected);
    log.info(`snapshot ${base}: ${mine.length} listings`);
  };

  // ----- key price moves -----
  let lastKeyScrap: number | null = null;
  const keyQuotesChanged = (): void => {
    const kp = selectKeyPrice(repo.keyQuotes(), settings, clock.now());
    if (lastKeyScrap === null || Math.abs(kp.valueScrap - lastKeyScrap) >= 1) {
      if (lastKeyScrap !== null) log.info(`key price moved ${lastKeyScrap} -> ${kp.valueScrap} scrap`);
      lastKeyScrap = kp.valueScrap;
      engine.markAllDirty();
      // Ceilings and key-priced orders move with the key value.
      market.markAllDirty();
      holdings.settingsChanged();
    }
    scheduleStatusCheck();
  };

  // ----- PriceDB socket -----
  let pricedbSocketOn = false;
  // A refused socket upgrade or a challenge on the REST host keeps the socket closed until net.unblock (R7).
  const wantPricedbSocket = (): boolean =>
    !settings.networkPaused &&
    settings.connectors.pricedb &&
    settings.connectors.pricedbSocket &&
    http.hostBlocked('ws.pricedb.io') === null &&
    http.hostBlocked('pricedb.io') === null;
  const syncPricedbSocket = (): void => {
    const want = started && wantPricedbSocket();
    if (want && !pricedbSocketOn) {
      pricedbSocketOn = true;
      pricedb.startSocket((row) => {
        // A new reference moves confidence and the outlier test of that item.
        const bases = [toBaseSku(row.sku)];
        engine.markDirty(bases);
        market.markDirty(bases);
        if (row.sku === '5021;6') keyQuotesChanged();
      });
    } else if (!want && pricedbSocketOn) {
      pricedbSocketOn = false;
      pricedb.stopSocket();
    }
  };

  const syncFeed = (): void => {
    if (started && settings.liveFeed.enabled && !settings.networkPaused) socket.start();
    else socket.stop();
  };

  // ----- saved-page folder watch (opt-in) -----
  let watcher: { folder: string; handle: FolderWatcher } | null = null;
  /** When syncFolderWatch last looked at the folder, and whether it was missing then (warn once, not every retry). */
  let watchCheckedAt = 0;
  let watchFolderMissing = false;
  const importAllowed = (): boolean => settings.import.enabled && settings.import.acknowledgedAt !== null;

  /**
   * Imports one file from the watch folder. A marker in the repo names the file
   * while it is being parsed: if the service dies or hangs on it, the next start
   * skips that exact version instead of failing on it again on every launch.
   * The leftover marker is read once at start, so the files' order does not matter.
   */
  let crashedWatchImport: string | null = null;
  try {
    crashedWatchImport = repo.getMeta(META_WATCH_IMPORTING) || null;
  } catch {
    crashedWatchImport = null;
  }
  const importWatchedFile = (file: string, html: string, mtimeMs: number): void => {
    const marker = JSON.stringify({ file, mtimeMs });
    const name = path.basename(file);
    if (crashedWatchImport !== null && crashedWatchImport === marker) {
      crashedWatchImport = null;
      log.warn(`folder watch skipped ${name}: the service stopped while importing it last time; import it by hand to retry`);
      return;
    }
    try {
      repo.setMeta(META_WATCH_IMPORTING, marker);
    } catch (err) {
      log.warn(`folder watch bookkeeping failed: ${errorText(err)}`);
    }
    try {
      const r = importSavedPage(ctx, { html, fileName: name, mtimeMs });
      log.info(`folder watch imported ${r.fileName}: ${r.stored} of ${r.parsed} items`);
    } catch (err) {
      log.warn(`folder watch could not import ${name}: ${errorText(err)}`);
    } finally {
      try {
        repo.setMeta(META_WATCH_IMPORTING, '');
      } catch {
        // the marker only guards against crash loops
      }
    }
  };

  const syncFolderWatch = (): void => {
    watchCheckedAt = clock.now();
    const folder = settings.import.watchFolder;
    let ok = false;
    if (started && importAllowed() && folder) {
      try {
        ok = existsSync(folder) && statSync(folder).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok && !watchFolderMissing) log.warn('the saved-page watch folder does not exist; folder watch is off until it is back');
      watchFolderMissing = !ok;
    } else {
      watchFolderMissing = false;
    }
    // A watch whose OS handle failed (folder removed, drive gone) is replaced, not reported as live.
    const dead = watcher !== null && !watcher.handle.alive();
    if (watcher && (!ok || watcher.folder !== folder || dead)) {
      watcher.handle.stop();
      watcher = null;
      log.info(dead ? 'saved-page folder watch stopped after an error' : 'saved-page folder watch stopped');
    }
    if (ok && folder && !watcher) {
      const last = repo.listImportBatches(1)[0]?.importedAt ?? null;
      const since = last ?? settings.import.acknowledgedAt;
      watcher = {
        folder,
        handle: createFolderWatcher({
          folder,
          log,
          since,
          now: () => clock.now(),
          onFile: importWatchedFile,
          ...(opts.watchFactory ? { watchFactory: opts.watchFactory } : {}),
        }),
      };
      log.info('saved-page folder watch started');
    }
  };

  /** Status tick: a watch that failed, or a folder that was missing, is tried again about once a minute. */
  const retryFolderWatch = (): void => {
    if (!started || !importAllowed() || !settings.import.watchFolder) return;
    if (watcher !== null && watcher.handle.alive()) return;
    if (clock.now() - watchCheckedAt < WATCH_RETRY_MS) return;
    try {
      syncFolderWatch();
    } catch (err) {
      log.warn(`folder watch retry failed: ${errorText(err)}`);
    }
  };

  // ----- status and health -----
  const feedState = (): ConnectorHealth['state'] => {
    if (!settings.liveFeed.enabled) return 'off';
    if (settings.networkPaused) return 'paused';
    return socket.health().state;
  };

  const computeStatus = (): AppStatus => {
    const setupNeeded: AppStatus['setupNeeded'] = [];
    if (!secrets.bptfAccessToken) setupNeeded.push('bptf-token');
    if (!secrets.bptfApiKey) setupNeeded.push('bptf-key');
    if (!settings.contactUrl.trim()) setupNeeded.push('contact-url');
    watchedSet();
    if (priceCount === 0 && !repo.listRules().some((r) => r.enabled)) setupNeeded.push('first-price');
    return {
      version: opts.version,
      networkPaused: settings.networkPaused,
      feed: feedState(),
      keyPrice: engine.keyPrice(),
      counts: repo.opportunityCounts(),
      lastEngineRunAt: engine.stats().lastRunAt,
      setupNeeded,
    };
  };

  const checkStatus = (): void => {
    try {
      const s = computeStatus();
      const json = JSON.stringify(s);
      if (json !== lastStatusJson) {
        lastStatusJson = json;
        push('status.changed', s);
      }
    } catch (err) {
      log.warn(`status check failed: ${errorText(err)}`);
    }
  };

  function scheduleStatusCheck(): void {
    if (statusSoon !== null) return;
    statusSoon = timers.setTimeout(() => {
      statusSoon = null;
      checkStatus();
    }, 250);
  }

  const computeHealth = (): HealthReport => {
    const feedStats = socket.stats();
    const counts = repo.listingCounts();
    const info = repo.schemaInfo();
    const loadAllAt = Number(repo.getMeta(META_LOAD_ALL_AT) ?? NaN);
    const watchDead = watcher !== null && !watcher.handle.alive();
    const listed: ConnectorHealth[] = [
      socket.health(),
      ...bptfApi.health(),
      schema.health(),
      ...pricedb.health(),
      scm.health(),
      {
        id: 'import-watch',
        label: 'Saved-page folder watch',
        state: watcher ? (watchDead ? 'error' : 'live') : 'off',
        detail: watcher
          ? watchDead
            ? 'Watching the save folder stopped after an error; trying again every minute'
            : 'Watching your save folder for new pages'
          : !importAllowed()
            ? 'Import is off (Settings)'
            : settings.import.watchFolder
              ? 'Folder not found'
              : 'No folder chosen',
        lastOkAt: null,
        lastErrorAt: null,
        lastError: watcher?.handle.lastError() ?? null,
        disabledReason: null,
      },
    ];
    const connectors = listed.map((c): ConnectorHealth => {
      const host = CONNECTOR_HOSTS[c.id];
      return host !== undefined && http.hostBlocked(host) !== null ? { ...c, blockedHost: host } : c;
    });
    const blockedHosts = Object.keys(hostBlocks)
      .map((host) => ({ host, reason: http.hostBlocked(host) }))
      .filter((b): b is { host: string; reason: string } => b.reason !== null);
    return {
      connectors,
      blockedHosts,
      budgets: http.budgets(),
      feed: {
        enabled: settings.liveFeed.enabled,
        state: feedState(),
        eventsToday: feedStats.eventsToday,
        bytesToday: feedStats.bytesToday,
        capBytes: settings.liveFeed.dailyCapBytes,
        lastFrameAt: feedStats.lastFrameAt,
        listingsTotal: counts.total,
        buyListings: counts.buy,
        sellListings: counts.sell,
        parseFailures: feedStats.parseFailures,
      },
      schema: { loadedAt: info.loadedAt, items: info.items, effects: info.effects, paintkits: info.paintkits },
      keyPrice: engine.keyPrice(),
      recentRequests: repo.recentRequests(50),
      db: { path: repo.path, sizeBytes: repo.sizeBytes() },
      engine: engine.stats(),
      pricedb: { rows: repo.pricedbCount(), loadedAt: Number.isFinite(loadAllAt) ? loadAllAt : null },
    };
  };

  // ----- handlers and jobs -----
  const ctx: HandlerContext = {
    ...deps,
    schema,
    pricedb,
    bptfApi,
    scm,
    engine,
    market,
    holdings,
    push,
    status: computeStatus,
    health: computeHealth,
    pricesChanged: () => {
      watched = null;
      // Every price and rule write: the Live market re-reads the user's side only (no rebuild).
      market.pricesChanged();
      scheduleStatusCheck();
      // Every window's price sheet and count refresh, including saves from quick entry.
      push('prices.changed', { at: clock.now() });
    },
    journalChanged: () => {
      // Held SKUs join or leave the watch list; holdings re-read the journal.
      watched = null;
      holdings.journalChanged();
      push('journal.changed', { at: clock.now() });
    },
    queueSnapshot,
    snapshot,
    snapshotStale: (base) => {
      const at = repo.getSnapshotAt(base);
      return at === null || clock.now() - at >= SNAPSHOT_STALE_MS;
    },
    hostUnblocked: (host) => {
      for (const id of HOST_JOBS[host] ?? []) scheduler.kick(id);
      if (host === 'ws.backpack.tf') {
        socket.unblock();
        syncFeed();
      }
      if (host === 'ws.pricedb.io' || host === 'pricedb.io') {
        syncPricedbSocket();
        pricedb.resumeSocket();
      }
      checkStatus();
    },
  };
  const handlers = createRpcHandlers(ctx);

  const scheduler: Scheduler = createScheduler({
    clock,
    timers,
    log,
    isPaused: () => settings.networkPaused || http.isPaused(),
  });
  for (const job of buildJobs({
    ...deps,
    schema,
    pricedb,
    bptfApi,
    engine,
    market,
    watchedBaseSkus: () => [...watchedSet()],
    nextQueuedSnapshot: () => snapshotQueue.shift() ?? null,
    snapshot,
    keyQuotesChanged,
  })) {
    scheduler.add(job);
  }

  // ----- lifecycle -----
  return {
    async start() {
      if (started || stopped) return;
      started = true;
      try {
        initOppLog();
      } catch (err) {
        log.warn(`opportunity log init failed: ${errorText(err)}`);
      }
      lastKeyScrap = selectKeyPrice(repo.keyQuotes(), settings, clock.now()).valueScrap;
      engine.start();
      market.start();
      holdings.start();
      statusTimer = timers.setInterval(() => {
        flushOppLog();
        retryFolderWatch();
        checkStatus();
      }, STATUS_INTERVAL_MS);
      checkStatus();
      // Cached schema first (a first run downloads it); listings need it for SKUs and names.
      await schema.init();
      if (stopped) return;
      scheduler.start();
      syncFeed();
      syncPricedbSocket();
      syncFolderWatch();
      engine.markAllDirty();
      // The Live market's first build, once the schema has loaded (or failed to; a later load rebuilds).
      market.markAllDirty();
      checkStatus();
      log.info(`service started (schema ${schema.isLoaded() ? 'loaded' : 'not loaded yet'})`);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      started = false;
      scheduler.stop();
      engine.stop();
      market.stop();
      holdings.stop();
      socket.stop();
      if (pricedbSocketOn) pricedb.stopSocket();
      pricedbSocketOn = false;
      watcher?.handle.stop();
      watcher = null;
      if (statusTimer !== null) timers.clearInterval(statusTimer);
      if (statusSoon !== null) timers.clearTimeout(statusSoon);
      statusTimer = null;
      statusSoon = null;
      // Abort in-flight requests so running jobs finish quickly.
      http.setPaused(true);
      await Promise.race([scheduler.whenIdle(), new Promise((r) => timers.setTimeout(() => r(undefined), 1_000))]);
      flushOppLog();
      try {
        repo.close();
      } catch (err) {
        log.warn(`closing the database failed: ${errorText(err)}`);
      }
      log.info('service stopped');
      applySecrets({});
    },

    async handle(method, params) {
      if (stopped) throw new Error('The service is shutting down');
      return handlers(method, params);
    },

    updateSettings(next) {
      const prev = settings;
      settings = next;
      http.setPaused(next.networkPaused);
      if (prev.networkPaused !== next.networkPaused || prev.liveFeed.enabled !== next.liveFeed.enabled) syncFeed();
      syncPricedbSocket();
      if (JSON.stringify(prev.import) !== JSON.stringify(next.import)) syncFolderWatch();
      const evalKey = (s: Settings) => JSON.stringify([s.profit, s.keyPrice, s.blocklist, s.notifications]);
      if (evalKey(prev) !== evalKey(next)) {
        engine.markAllDirty();
        keyQuotesChanged();
      }
      // Thresholds, notes keywords and the blocklist change every ceiling and eligibility; notifications
      // do not touch the market, and a key value move is handled by keyQuotesChanged above.
      const marketKey = (s: Settings) => JSON.stringify([s.profit, s.blocklist]);
      if (marketKey(prev) !== marketKey(next)) market.markAllDirty();
      // Holdings judge sells with the profit thresholds and gate "Sell:" notifications on settings.notifications.
      const holdingsKey = (s: Settings) => JSON.stringify([s.profit, s.blocklist, s.notifications]);
      if (holdingsKey(prev) !== holdingsKey(next)) holdings.settingsChanged();
      if (prev.connectors.bptfApi !== next.connectors.bptfApi || prev.connectors.pricedb !== next.connectors.pricedb) {
        for (const id of ['key-bptf', 'bptf-prices', 'key-pricedb', 'pricedb-all']) scheduler.kick(id);
      }
      checkStatus();
    },

    updateSecrets(next) {
      const prev = { key: secrets.bptfApiKey, token: secrets.bptfAccessToken };
      applySecrets(next);
      // A new or replaced credential (e.g. one that fixes a rejected key) is used at once
      // instead of after the failed jobs' retry delay; the HTTP budgets still space the requests (R7).
      if (secrets.bptfApiKey && secrets.bptfApiKey !== prev.key) {
        scheduler.kick('key-bptf');
        scheduler.kick('bptf-prices');
      }
      if (secrets.bptfAccessToken && secrets.bptfAccessToken !== prev.token) scheduler.kick('snapshot-watched');
      checkStatus();
    },

    onPush(cb) {
      pushListeners.add(cb);
      return () => pushListeners.delete(cb);
    },
  };
}
