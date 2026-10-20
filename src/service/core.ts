// Wires the service together: SQLite repo, the policy-checked HTTP client,
// connectors, the opportunity engine, the backpack.tf feed, periodic jobs, the
// saved-page folder watcher, status/health reporting and the opportunity log.
// entry.ts runs this inside Electron's utilityProcess; tests run it headless
// with a fake fetch and websocket.

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PushContract, PushEvent, RpcMethod } from '../shared/rpc';
import { WATCH_WAITING_FOR_SCHEMA } from '../shared/scraptfList';
import { baseSku as toBaseSku, looksLikeSku } from '../shared/sku';
import type { AppStatus, ConnectorHealth, HealthReport, JournalEntry, Listing, RequestLogRow, ScraptfBank, SecretName, Settings, UnixMs } from '../shared/types';
import { HOLDING_EXIT_VENUES, SECRET_NAMES } from '../shared/types';
import { createBptfApi } from './connectors/bptfApi';
import { createBptfSocket, type SocketTimers } from './connectors/bptfSocket';
import { META_LOAD_ALL_AT, createPriceDb, type PricedbSocketFactory } from './connectors/pricedb';
import { createSchemaService } from './connectors/schema';
import { createSteamMarket } from './connectors/steamMarket';
import type { Clock, FeedBatch, Logger, Repo, ServiceDeps, WebSocketLike } from './contracts';
import { systemClock } from './contracts';
import { SchemaVersionError, openRepo } from './db';
import {
  RETENTION,
  createBankStock,
  createBanksSummary,
  createNewFlipNotifier,
  createEngine,
  createHoldings,
  createLiveCheck,
  createMarketIndex,
  createResaveReminders,
  createScraptfHistory,
  createScraptfListCache,
  explicitInput,
  marketCategoryOf,
  selectKeyPrice,
} from './domain';
import {
  ImportTooLargeError,
  createFolderWatcher,
  decodedTooLargeWarning,
  tooLargeWarning,
  type FolderWatcher,
  type WatchFactory,
  type WatchSkipReason,
} from './import';
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
import { createRpcHandlers, importSavedPage, recordSkippedImport, type HandlerContext } from './rpcHandlers';
import { buildJobs, createScheduler, snapshotIsStale, type Scheduler } from './scheduler';

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
/**
 * P3: what the folder watch reports while the item schema has not loaded (scraptf.listStatus, the banks
 * page, Data health). It starts once it has: a page read before then would store SKUs that change later.
 * The text lives in shared/scraptfList.ts so the dashboard can tell it from a watch error.
 */
export { WATCH_WAITING_FOR_SCHEMA };
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

/**
 * ACT-7: a price the user typed or saved (the check popup's Save price, quick entry) this recently is one
 * they have just judged, so the engine records it as told instead of toasting "Profit:" about it.
 */
export const USER_PRICE_TOLD_MS = 5 * 60_000;

/**
 * ACT-3: the newest scrap.tf buy per base SKU in the journal (side 'buy', venue 'scrap.tf' in any case),
 * for EngineDeps.boughtSince. A row whose SKU cannot be read is skipped.
 */
export function newestScraptfBuys(entries: readonly Pick<JournalEntry, 'side' | 'venue' | 'sku' | 'ts'>[]): Map<string, UnixMs> {
  const venue = HOLDING_EXIT_VENUES.scraptf;
  const out = new Map<string, UnixMs>();
  for (const e of entries) {
    if (e.side !== 'buy' || typeof e.venue !== 'string' || e.venue.trim().toLowerCase() !== venue || !Number.isFinite(e.ts)) continue;
    let base: string;
    try {
      base = toBaseSku(e.sku);
    } catch {
      continue;
    }
    const prev = out.get(base);
    if (prev === undefined || e.ts > prev) out.set(base, e.ts);
  }
  return out;
}

/**
 * 0.7.3: the core's logger may buffer (ServiceLogger does); stop() flushes it. Kept off the shared
 * Logger contract, whose keys are the level names (http.ts indexes it by them).
 */
export type CoreLogger = Logger & { flush?(): void };

export interface ServiceCoreOptions {
  dataDir: string;
  version: string;
  settings: Settings;
  secrets: Partial<Record<SecretName, string>>;
  log: CoreLogger;
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
  /**
   * 0.7.2: set only on a core that could not open its database: the reason every RPC rejects with.
   * entry.ts puts it in the 'ready' message, so main logs a warning instead of a plain "service ready".
   */
  readonly failure?: string;
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
function failedCore(reason: string, log: CoreLogger): ServiceCore {
  log.error(`service cannot start: ${reason}`);
  return {
    failure: reason,
    start: async () => undefined,
    // 0.7.3: the reason line is still buffered; write it now, as a running core's stop() does.
    stop: async () => {
      log.flush?.();
    },
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

  // F14: the user's saved scrap.tf/items list, in memory (filled only by saved pages, R10; no network).
  // Its key row feeds the key price, which values the other rows; keyRow() never reads the key price,
  // so the two do not loop. Rows load on first use; scraptfListChanged() re-reads them.
  const scraptfList = createScraptfListCache({ repo, log, keyPrice: () => engine.keyPrice() });

  // ACT-3: the journal's newest scrap.tf buy per base, read on first use and again after journalChanged.
  let scraptfBuys: Map<string, UnixMs> | null = null;
  // ACT-8: each bank's newest whole look, read per bank on first use and again after an import or a prune.
  let bankSaves: Map<ScraptfBank, UnixMs | null> | null = null;

  const engine = createEngine({
    ...deps,
    schema,
    timers,
    scraptfKey: () => scraptfList.keyRow(),
    // F17: an imported item a "New on scrap.tf" toast just named gets no second "Profit:" toast. Late-bound
    // (the notifier is built below); the engine asks only while it runs, after start().
    // ACT-7: nor does a price the user typed or saved from the check popup minutes ago (dated then, or new
    // to the engine then: the popup dates a price from the saved list at the list's save time).
    toldElsewhere: (opp, at) =>
      (opp.inputKind === 'import' && newFlipNotifier.toldRecently(toBaseSku(opp.sku), at)) ||
      (opp.inputKind === 'user' && at - opp.inputObservedAt < USER_PRICE_TOLD_MS) ||
      (opp.inputKind === 'user' && at - opp.firstSeenAt < USER_PRICE_TOLD_MS),
    // ACT-3: no toast for an item the user recorded buying on scrap.tf after its price was seen.
    boughtSince: (base, at) => {
      scraptfBuys ??= newestScraptfBuys(repo.listJournal());
      const ts = scraptfBuys.get(base);
      return ts !== undefined && ts >= at;
    },
    // ACT-8: when each bank page was last seen whole, i.e. its newest bank stock save. Not
    // repo.bankNewestSaves: a partial look (DM-2) or an unsettled window snapshot (ACT-4) records a batch
    // with cards but no bank stock save, and the cards it missed may well be on the page.
    recentBankSaveAt: (bank) => {
      bankSaves ??= new Map();
      if (!bankSaves.has(bank)) {
        const newest = repo.bankStockSaves(bank, 1)[0];
        bankSaves.set(bank, newest !== undefined && newest.items > 0 ? newest.savedAt : null);
      }
      return bankSaves.get(bank) ?? null;
    },
    // ...and the other way round: an imported item the engine toasted first (an import held for the
    // market's first build at start-up) gets no second "New on scrap.tf" toast. Late-bound the same way.
    notified: (opps, at) => {
      for (const o of opps) {
        if (o.inputKind !== 'import') continue;
        try {
          newFlipNotifier.toastedElsewhere(toBaseSku(o.sku), at);
        } catch {
          // An unreadable SKU only costs a second toast.
        }
      }
    },
    events: {
      onChanged: (summary) => {
        flushOppLog();
        push('opps.changed', summary);
        scheduleStatusCheck();
        // F15 hook: the stored opportunities moved, so each bank's flips may have (after an import too:
        // the engine re-evaluates the imported SKUs about 1 s after pricesChanged). Flips only: the
        // saved pages and the market rows did not change.
        banks.invalidate('flips');
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
    onChanged: (p) => {
      push('market.changed', p);
      // F15 hook: Live market rows feed each bank's lookFor and unchecked only.
      banks.invalidate('market');
      // F17: "New on scrap.tf" notifications held until the first build (bank stock below).
      newFlipNotifier.flush();
    },
    // syncFolderWatch drops the watcher when the folder is missing; a failed OS watch is not alive.
    // Read only from market.list, after construction, so the later `let watcher` is initialised.
    folderWatchActive: () => watcher !== null && watcher.handle.alive(),
    // Called from the index's timers only, after construction, so `holdings` below is initialised.
    onBasesChanged: (bases) => holdings.onBasesChanged(bases),
    // F14: joined per returned row at read time, and the strip's "All items" chip.
    scraptfList,
    // F17: "New on scrap.tf" (MarketRow.scraptfNewAt, MarketQuery.newOnScraptf). Late-bound, since the bank
    // stock reads market.entryFor; called only from list()/all(), after `bankStock` below is initialised.
    bankStock: {
      newAtFor: (base) => bankStock.newAtFor(base),
      version: () => bankStock.version(),
      // F19: MarketRow.scraptfLink's bank-stock side (the imported prices' is the index's own), late-bound the same way.
      seenFor: (base) => bankStock.seenFor(base),
    },
    // F20: MarketRow.scraptfListedSince and the "Listed > 24 h" filter from the history's runs, late-bound
    // the same way (the history reads market.entryFor).
    history: {
      listedSinceFor: (base, bank) => scraptfHistory.listedSinceFor(base, bank),
      // 0.7.1 (DM-5): the run's newest sighting too, so "Listed > 24 h" measures between saves, not to now.
      listedFor: (base, bank) => scraptfHistory.listedFor(base, bank),
      version: () => scraptfHistory.version(),
    },
  });

  // Holdings (F11): open journal lots priced from the market index; "Sell:" notifications go through main.
  const holdings = createHoldings({
    ...deps,
    schema,
    market,
    timers,
    keyPrice: () => engine.keyPrice(),
    notify: (n) => push('notify', n),
    // F14: a held base's saved-list row is its scrap.tf exit.
    scraptfList,
  });

  // scrap.tf bank stock (F17): each saved page's two newest saves, diffed in memory and joined to the Live
  // market per read (no network, nothing fetched from scrap.tf: only pages the user saved, R10). Feeds the
  // banks cards' "What's new", the market's scraptfNewAt, the drawer's ItemDetail.bankStock and the
  // "New on scrap.tf" notifications. Constructed after the market index it reads, before the banks summary
  // that reads it; it loads lazily on first use.
  const bankStock = createBankStock({
    clock,
    log,
    repo,
    market,
    keyPrice: () => engine.keyPrice(),
    settings: () => settings,
    categoryOf: (sku) => marketCategoryOf(schema, sku),
    schemaLoaded: () => schema.isLoaded(),
    // F20: BankStockRow's time listed from the history's runs; late-bound, read only by list()/all().
    history: { runsFor: (bank) => scraptfHistory.runsFor(bank) },
  });

  // scrap.tf banks (F15): per-page summaries from the batches, opportunities, market index and saved list,
  // in memory (no network). Invalidated at the hook points marked "F15 hook"; its throttled change
  // notification is pushed as 'scraptf.banksChanged'. Its folderWatch is read only from summary(),
  // after construction, so the later `let watcher` is initialised.
  const banks = createBanksSummary({
    clock,
    log,
    repo,
    market,
    scraptfList,
    timers,
    settings: () => settings,
    folderWatch: () => folderWatchState(),
    // A pre-0.3 batch without a bank is classified like the coverage strip does it.
    categoryOf: (sku) => marketCategoryOf(schema, sku),
    // F17: each card's "What's new", read live on every summary().
    bankStock,
  });
  banks.onChanged(() => push('scraptf.banksChanged', { at: clock.now() }));

  // scrap.tf history (F20): the user's saves read as price history, time listed and a change feed, in
  // memory plus scraptf_events (no network; only pages the user saved, R10). importSavedPage writes the
  // events through onImport; bankStockChanged refreshes the runs index.
  const scraptfHistory = createScraptfHistory({
    clock,
    log,
    repo,
    market,
    keyPrice: () => engine.keyPrice(),
    // An item history's name when no save names it (the drawer of an item never saved).
    nameOf: (sku) => schema.nameForSku(sku),
  });

  // F20 S5: opt-in re-save reminders (a notification only; the app never refreshes scrap.tf itself).
  const resaveReminders = createResaveReminders({
    clock,
    log,
    repo,
    timers,
    settings: () => settings,
    networkPaused: () => settings.networkPaused || http.isPaused(),
    notify: (n) => push('notify', n),
  });

  // S3 "New on scrap.tf" notifications. An import made before the Live market's first build (the folder
  // watch's catch-up at start) is held until it has built: flushed on its change push and the status tick.
  const newFlipNotifier = createNewFlipNotifier({
    log,
    repo,
    clock,
    stock: bankStock,
    settings: () => settings,
    keyPrice: () => engine.keyPrice(),
    notify: (n) => push('notify', n),
    marketBuilt: () => market.stats().lastFullAt !== null,
  });

  /**
   * bank_stock rows were written by an import (`imported`: its bank and batch) or pruned (no argument):
   * ctx.bankStockChanged and maintenance. The cache re-reads the saves first, so the S3 notifications
   * judge the new save against its predecessor, then the banks page hears of it.
   */
  const bankStockChanged = (imported?: { bank: ScraptfBank; batchId: number }): void => {
    bankSaves = null;
    bankStock.refresh();
    // F20: the runs index reads the same saves (a new one, or thinned ones gone).
    scraptfHistory.refresh();
    if (imported) newFlipNotifier.imported(imported);
    // The banks page's "What's new" lines and the stock page refetch on 'scraptf.banksChanged'.
    banks.invalidate();
  };

  // Live check (F16): text the user copied (read by main) or typed, judged against the local book and
  // the saved list, item.detail {history:false} style; no request of any kind. 'check.text' pushes
  // 'check.done' for item results; the recent ring lives in memory only.
  const liveCheck = createLiveCheck({
    repo,
    schema,
    log,
    settings: () => settings,
    keyPrice: () => engine.keyPrice(),
    market,
    scraptfList,
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
    const kp = selectKeyPrice(repo.keyQuotes(), settings, clock.now(), scraptfList.keyRow());
    if (lastKeyScrap === null || Math.abs(kp.valueScrap - lastKeyScrap) >= 1) {
      if (lastKeyScrap !== null) log.info(`key price moved ${lastKeyScrap} -> ${kp.valueScrap} scrap`);
      lastKeyScrap = kp.valueScrap;
      engine.markAllDirty();
      // Ceilings and key-priced orders move with the key value.
      market.markAllDirty();
      holdings.settingsChanged();
      // List prices in keys are valued at the new key price on their next read.
      scraptfList.keyPriceChanged();
      // F17: cheaper/pricier between prices in different keys is decided at the key price.
      bankStock.refresh();
    }
    scheduleStatusCheck();
  };

  // ----- scrap.tf price list (F14) -----
  /** Rows were written by an import (importSavedPage) or purged by maintenance: re-read them. */
  const scraptfListChanged = (): void => {
    scraptfList.refresh();
  };
  scraptfList.onChanged((summary) => {
    // The key row may have moved scrap.tf's key prices, which cap the key value.
    keyQuotesChanged();
    // A held item's scrap.tf exit may have appeared, moved or gone. Market rows read the list per
    // read, and the pages refetch on the push below (and on 'prices.changed' for an import).
    holdings.settingsChanged();
    push('scraptf.listChanged', { at: clock.now(), items: summary.items });
    // F15 hook: the 'list' card reads the saved list (an import wrote rows, or maintenance purged some).
    banks.invalidate();
  });

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
  /** P3: the folder is there but the item schema is not loaded yet, so the watch has not started (logged once). */
  let watchWaitingForSchema = false;
  /**
   * DC-4: the catch-up start, fixed when the watch began waiting. An import between the schema loading and
   * the tick that starts the watch (a window read, a page picked by hand) must not move it past the pages
   * saved meanwhile, or while the app was closed.
   */
  let watchWaitingSince: UnixMs | null = null;
  const catchUpSince = (): UnixMs | null => repo.listImportBatches(1)[0]?.importedAt ?? settings.import.acknowledgedAt;
  const importAllowed = (): boolean => settings.import.enabled && settings.import.acknowledgedAt !== null;
  const schemaLoaded = (): boolean => {
    try {
      return schema.isLoaded();
    } catch {
      return false;
    }
  };

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
  /** Records a watched save that imported nothing for its size (F18); a failure to record is only logged. */
  const recordWatchedSkip = (name: string, mtimeMs: number, warning: string): void => {
    try {
      recordSkippedImport(ctx, { fileName: name, mtimeMs, warning });
    } catch (err) {
      log.warn(`folder watch could not record the skip of ${name}: ${errorText(err)}`);
    }
  };

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
      // F18: under the limit on disk but over it once decoded: reported like the on-disk skip, not only logged.
      if (err instanceof ImportTooLargeError) recordWatchedSkip(name, mtimeMs, decodedTooLargeWarning(err.bytes, err.limit));
    } finally {
      try {
        repo.setMeta(META_WATCH_IMPORTING, '');
      } catch {
        // the marker only guards against crash loops
      }
    }
  };

  /**
   * F18: a page the watch would not read (over 20 MB: a Single File save holds every image) is
   * recorded with its reason and pushed as 'import.done', instead of only logged, so the user sees why
   * the save did nothing.
   */
  const skippedWatchedFile = (file: string, reason: WatchSkipReason, detail: string, mtimeMs: number): void => {
    if (reason === 'too-large') recordWatchedSkip(path.basename(file), mtimeMs, tooLargeWarning(detail));
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
    // P3: a page imported before the item schema loads would be stored under SKUs that change once it has.
    // The status tick starts the watch once it has loaded, and its catch-up scan (since the last import
    // before it began waiting, watchWaitingSince) picks up the pages saved meanwhile.
    const waiting = ok && !watcher && !schemaLoaded();
    if (waiting && !watchWaitingForSchema) {
      log.info('saved-page folder watch waits for the item data to load');
      watchWaitingSince = catchUpSince();
    }
    watchWaitingForSchema = waiting;
    if (!ok) watchWaitingSince = null;
    if (ok && folder && !watcher && !waiting) {
      const since = watchWaitingSince ?? catchUpSince();
      watchWaitingSince = null;
      watcher = {
        folder,
        handle: createFolderWatcher({
          folder,
          log,
          since,
          now: () => clock.now(),
          onFile: importWatchedFile,
          onSkip: skippedWatchedFile,
          ...(opts.watchFactory ? { watchFactory: opts.watchFactory } : {}),
        }),
      };
      log.info('saved-page folder watch started');
    }
  };

  /** The folder watch as it runs, and its last error ('scraptf.listStatus', 'scraptf.banks'). */
  const folderWatchState = (): { active: boolean; error: string | null } => {
    if (watcher !== null) {
      const alive = watcher.handle.alive();
      return { active: alive, error: alive ? null : (watcher.handle.lastError() ?? 'Watching the folder stopped after an error; trying again every minute') };
    }
    // Same wording as the Data health page's folder-watch row.
    return { active: false, error: importAllowed() && settings.import.watchFolder ? folderWatchOffReason() : null };
  };

  /** Why a chosen folder is not watched: the folder is gone, or (P3) the item schema has not loaded yet. */
  function folderWatchOffReason(): string {
    return !watchFolderMissing && !schemaLoaded() ? WATCH_WAITING_FOR_SCHEMA : 'Folder not found';
  }

  /**
   * F15: the banks summary reads watchActive live, and the watch dies or comes back (the retry below)
   * without a settings change; the status tick tells the summary's listeners when it flipped.
   */
  let banksWatchActive: boolean | null = null;
  const checkBanksWatch = (): void => {
    const active = importAllowed() && folderWatchState().active;
    if (banksWatchActive !== null && active !== banksWatchActive) banks.invalidate('switches');
    banksWatchActive = active;
  };

  /**
   * Status tick: a watch that failed, or a folder that was missing, is tried again about once a minute;
   * a watch held back for the item schema (P3) starts on the first tick after it has loaded.
   */
  const retryFolderWatch = (): void => {
    if (!started || !importAllowed() || !settings.import.watchFolder) return;
    if (watcher !== null && watcher.handle.alive()) return;
    const schemaNowLoaded = watchWaitingForSchema && schemaLoaded();
    if (!schemaNowLoaded && clock.now() - watchCheckedAt < WATCH_RETRY_MS) return;
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
              ? folderWatchOffReason()
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
    scraptfList,
    scraptfListChanged,
    banks,
    bankStock,
    bankStockChanged,
    scraptfHistory,
    liveCheck,
    folderWatch: folderWatchState,
    push,
    status: computeStatus,
    health: computeHealth,
    pricesChanged: () => {
      watched = null;
      // ACT-8: every import calls this, so the engine dates the bank saves afresh on its next run.
      bankSaves = null;
      // Every price and rule write: the Live market re-reads the user's side only (no rebuild).
      market.pricesChanged();
      scheduleStatusCheck();
      // Every window's price sheet and count refresh, including saves from quick entry.
      push('prices.changed', { at: clock.now() });
      // F15 hook: every import (importSavedPage calls this, folder watch included), price and rule write.
      banks.invalidate();
    },
    journalChanged: () => {
      // Held SKUs join or leave the watch list; holdings re-read the journal.
      watched = null;
      // ACT-3: a buy recorded or undone changes which toasts the engine holds back.
      scraptfBuys = null;
      holdings.journalChanged();
      push('journal.changed', { at: clock.now() });
    },
    queueSnapshot,
    snapshot,
    // 0.7.3: the scheduler's test, so a snapshot stamped in the future (clock moved back) is stale too.
    snapshotStale: (base) => snapshotIsStale(repo.getSnapshotAt(base), clock.now()),
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
    scraptfListChanged,
    bankStockChanged: () => bankStockChanged(),
    scraptfEventsPruned: () => scraptfHistory.refresh(),
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
      lastKeyScrap = selectKeyPrice(repo.keyQuotes(), settings, clock.now(), scraptfList.keyRow()).valueScrap;
      engine.start();
      market.start();
      holdings.start();
      resaveReminders.start();
      statusTimer = timers.setInterval(() => {
        flushOppLog();
        retryFolderWatch();
        checkBanksWatch();
        // F17: the market's last build chunk may push before it counts as built.
        newFlipNotifier.flush();
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
      // The banks summary's watch baseline (a page may have read it while the schema loaded).
      checkBanksWatch();
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
      resaveReminders.stop();
      banks.stop();
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
      // 0.7.3: write the buffer now; a late timer flush would recreate a log folder deleted after stop().
      log.flush?.();
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
      if (JSON.stringify(prev.import) !== JSON.stringify(next.import)) {
        syncFolderWatch();
        // F15 hook: importEnabled and watchActive are part of the summary (read live; nothing to rebuild).
        banks.invalidate('switches');
        banksWatchActive = importAllowed() && folderWatchState().active;
      }
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
