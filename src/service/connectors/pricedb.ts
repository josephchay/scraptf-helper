// PriceDB REST and socket (DESIGN_BRIEF §2.7, §2.8, §4.2). Keyless baseline
// prices and a key price; never an exit price. UI attribution: "Prices by PriceDB.io".
//
// Every method resolves (never rejects) on network or HTTP failures: the
// failure is recorded in health() and the method returns null / [] / 0.

import { io } from 'socket.io-client';
import { z } from 'zod';
import { refToScrap } from '../../shared/currency';
import { canonical, fromObject, fromString, looksLikeSku, toLegacy } from '../../shared/sku';
import type { ConnState, ConnectorHealth, HistoryPoint, KeyPriceQuote, PricedbRow, Scrap, UnixMs, UnixSec } from '../../shared/types';
import { KEY_SKU } from '../../shared/types';
import type { HttpRequestOptions, HttpResponse, PriceDb, ServiceDeps } from '../contracts';
import {
  HostBlockedError,
  HttpStatusError,
  NetworkPausedError,
  RateLimitedError,
  assertAllowed,
  parseRateLimit,
  realTimers,
  type TimerApi,
} from '../net';

export const PRICEDB_API = 'https://pricedb.io/api';
export const PRICEDB_SOCKET_URL = 'https://ws.pricedb.io';
/** The URL the network policy approves for the socket.io websocket upgrade. */
export const PRICEDB_SOCKET_POLICY_URL = 'wss://ws.pricedb.io/socket.io/';
export const BULK_CHUNK = 100;
/** /autob/items is CDN-cached for 4 h (max-age=14400); fetching sooner returns the same data. */
export const LOAD_ALL_MIN_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Pause while RateLimit-Remaining is below this (§2.0: published 360/min, our budget 60/min). */
export const RATE_LIMIT_MIN_REMAINING = 36;
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];
export const RECONNECT_SLOW_MS = 10 * 60 * 1000;
/**
 * Only a connection that stayed up this long resets the backoff, so a server
 * that accepts and then drops us still escalates to RECONNECT_SLOW_MS (§2.8).
 * Longer than socket.io's ping interval plus its ping timeout (25 s + 20 s).
 */
export const STABLE_CONNECTION_MS = 60_000;
export const META_LOAD_ALL_AT = 'pricedb.loadAllAt';

const NEGATIVE_CACHE_MS = 30 * 60 * 1000;
const NEGATIVE_CACHE_MAX = 10_000;
const KEY_HISTORY_TTL_MS = 30 * 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 60_000;
const RATE_LIMIT_MAX_SLEEP_MS = 65_000;
const CONNECT_TIMEOUT_MS = 20_000;
const SOCKET_CHECK_MS = 30_000;
const QUALITY_INVALID = 255;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const amount = z
  .union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/).transform(Number)])
  .pipe(z.number().finite().nonnegative());

const sideSchema = z.looseObject({ keys: amount.optional(), metal: amount.optional() });

/** One PriceDB price record: {sku, name, source, time, buy:{keys, metal}, sell:{keys, metal}}. */
export const pricedbRecordSchema = z.looseObject({
  sku: z.string().trim().min(3).max(300),
  name: z.string().catch(''),
  source: z.string().nullish().catch(null),
  time: amount.optional().catch(undefined),
  buy: sideSchema,
  sell: sideSchema,
});
export type PricedbRecord = z.infer<typeof pricedbRecordSchema>;

const listEnvelope = z.looseObject({
  items: z.array(z.unknown()).optional(),
  data: z.union([z.array(z.unknown()), z.looseObject({ results: z.array(z.unknown()).optional() })]).optional(),
  history: z.array(z.unknown()).optional(),
});

/** Arrays come bare (/items-bulk, /item-history) or wrapped ({items}, {data}, {history}). */
function recordList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  const env = listEnvelope.safeParse(data);
  if (!env.success) return null;
  const d = env.data;
  if (d.items) return d.items;
  if (d.history) return d.history;
  if (Array.isArray(d.data)) return d.data;
  if (d.data && Array.isArray(d.data.results)) return d.data.results;
  return null;
}

export function recordToRow(rec: PricedbRecord, sku: string, fetchedAt: UnixMs): PricedbRow {
  return {
    sku,
    name: rec.name,
    buyKeys: rec.buy.keys ?? 0,
    buyScrap: refToScrap(rec.buy.metal ?? 0),
    sellKeys: rec.sell.keys ?? 0,
    sellScrap: refToScrap(rec.sell.metal ?? 0),
    time: Math.floor(rec.time ?? 0),
    fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// SKU variants (§4.2)
// ---------------------------------------------------------------------------

function swapWearPaintkit(sku: string): string | null {
  const parts = sku.split(';');
  const w = parts.findIndex((p) => /^w\d+$/.test(p));
  const pk = parts.findIndex((p) => /^pk\d+$/.test(p));
  if (w < 0 || pk < 0) return null;
  const a = parts[w]!;
  parts[w] = parts[pk]!;
  parts[pk] = a;
  return parts.join(';');
}

/**
 * The PriceDB lookup chain for a SKU, tried in order until one exists:
 * legacy, v3, w/pk swapped, the strange-skin forms (11-primary, then 15+strange)
 * and, for crates, the same crate under its alias defindexes.
 */
export function pricedbVariants(sku: string, crateAliases: (defindex: number) => readonly number[] = () => []): string[] {
  const obj = fromString(sku);
  const out: string[] = [];
  const add = (s: string | null): void => {
    if (s && !out.includes(s)) out.push(s);
  };
  const legacy = fromObject(obj, true);
  const v3 = fromObject(obj);
  add(legacy);
  add(v3);
  add(swapWearPaintkit(legacy));
  add(swapWearPaintkit(v3));
  if (obj.paintkit !== null && (obj.quality === 11 || obj.quality2 === 11)) {
    for (const form of [fromObject({ ...obj, quality: 11, quality2: null }, true), fromObject({ ...obj, quality: 15, quality2: 11 }, true)]) {
      add(form);
      add(swapWearPaintkit(form));
    }
  }
  if (obj.crateseries !== null) {
    for (const d of crateAliases(obj.defindex)) add(fromObject({ ...obj, defindex: d }, true));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Socket abstraction (lets tests inject a fake)
// ---------------------------------------------------------------------------

export interface PricedbSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(): unknown;
  disconnect(): unknown;
}

export interface PricedbSocketOptions {
  transports: 'websocket'[];
  extraHeaders: Record<string, string>;
  reconnection: false;
  timeout: number;
}

export type PricedbSocketFactory = (url: string, opts: PricedbSocketOptions) => PricedbSocketLike;

export const defaultSocketFactory: PricedbSocketFactory = (url, opts) => {
  // forceNew: never reuse socket.io's cached Manager, so each attempt is one fresh connection.
  const s = io(url, { ...opts, forceNew: true });
  return {
    on: (event, listener) => s.on(event, listener),
    removeAllListeners: () => s.removeAllListeners(),
    disconnect: () => s.disconnect(),
  };
};

export interface PriceDbOptions {
  socketFactory?: PricedbSocketFactory;
  timers?: TimerApi;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeCanonical(sku: string): string | null {
  const t = String(sku ?? '').trim();
  if (!looksLikeSku(t)) return null;
  return canonical(t);
}

interface KeyPoint {
  t: UnixSec;
  buy: Scrap | null;
  sell: Scrap | null;
}

export function createPriceDb(deps: ServiceDeps, options: PriceDbOptions = {}): PriceDb {
  const { clock, log, repo, http } = deps;
  const timers = options.timers ?? realTimers;
  const socketFactory = options.socketFactory ?? defaultSocketFactory;

  /**
   * Set when pricedb.io answered 401/403 (§2.0: disable the connector, never
   * retry automatically). No REST request is sent while it is set; like the
   * HTTP layer's host blocks it lasts until the app restarts.
   */
  let restRefused: string | null = null;

  const enabled = (): boolean => deps.settings().connectors.pricedb;
  const socketEnabled = (): boolean => {
    const c = deps.settings().connectors;
    return c.pricedb && c.pricedbSocket;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      timers.setTimeout(resolve, ms);
    });

  // ----- REST state -----
  let restLastOkAt: UnixMs | null = null;
  let restLastErrorAt: UnixMs | null = null;
  let restLastError: string | null = null;
  let restErrorState: ConnState | null = null;
  let restDisabledReason: string | null = null;
  let rlRemaining: number | null = null;
  let rlPausedUntil: UnixMs = 0;
  let parseFailures = 0;
  let loadAllInflight: Promise<number> | null = null;
  const negative = new Map<string, UnixMs>();
  const keyHistoryCache = new Map<string, { at: UnixMs; points: KeyPoint[] }>();
  let crateGroups: { loadedAt: UnixMs | null; byName: Map<string, number[]> } | null = null;

  const markRestOk = (): void => {
    restLastOkAt = clock.now();
    restErrorState = null;
    restDisabledReason = null;
  };

  const markRestError = (err: unknown): void => {
    restLastErrorAt = clock.now();
    restLastError = errorMessage(err);
    if (err instanceof HostBlockedError) {
      restErrorState = 'blocked';
      restDisabledReason = err.reason;
    } else if (err instanceof NetworkPausedError) restErrorState = 'paused';
    else if (err instanceof RateLimitedError) restErrorState = 'backoff';
    else if (err instanceof HttpStatusError && (err.status === 429 || err.status === 503)) restErrorState = 'backoff';
    else restErrorState = 'error';
    log.warn(`PriceDB request failed: ${restLastError}`);
  };

  const noteRateLimit = (headers: Record<string, string>): void => {
    const now = clock.now();
    const rl = parseRateLimit(headers, now);
    if (rl.remaining === null) return;
    rlRemaining = rl.remaining;
    if (rl.remaining < RATE_LIMIT_MIN_REMAINING) {
      rlPausedUntil = Math.max(rlPausedUntil, now + (rl.resetMs ?? RATE_LIMIT_FALLBACK_MS));
      log.info(`PriceDB RateLimit-Remaining ${rl.remaining}; pausing until ${new Date(rlPausedUntil).toISOString()}`);
    }
  };

  const waitForRateLimit = async (): Promise<void> => {
    const wait = rlPausedUntil - clock.now();
    if (wait > 0) await sleep(Math.min(wait, RATE_LIMIT_MAX_SLEEP_MS));
  };

  /** One PriceDB request; null when it failed (already recorded). 404 is a normal answer. */
  const call = async <T = unknown>(url: string, opts: HttpRequestOptions): Promise<HttpResponse<T> | null> => {
    if (restRefused !== null) return null;
    await waitForRateLimit();
    if (restRefused !== null) return null;
    try {
      const res = await http.request<T>(url, { budget: 'pricedb', ...opts });
      noteRateLimit(res.headers);
      if (res.status === 401 || res.status === 403) {
        // An HTML 403 never gets here (the HTTP layer blocks the host); this is the API saying no.
        if (restRefused === null) {
          restRefused = `PriceDB refused requests (HTTP ${res.status}); no more PriceDB requests until the app restarts (check pricedb.io first)`;
          log.warn(`PriceDB disabled: ${restRefused}`);
        }
        markRestError(new HostBlockedError('pricedb.io', restRefused));
        return null;
      }
      if (res.ok || res.status === 404) markRestOk();
      else markRestError(new HttpStatusError(res.status, url, res.text));
      return res;
    } catch (err) {
      markRestError(err);
      return null;
    }
  };

  const crateAliases = (defindex: number): number[] => {
    try {
      const it = repo.schemaItem(defindex);
      if (!it || it.itemClass !== 'supply_crate') return [];
      const loadedAt = repo.schemaInfo().loadedAt;
      if (!crateGroups || crateGroups.loadedAt !== loadedAt) {
        const byName = new Map<string, number[]>();
        for (const row of repo.allSchemaItems()) {
          if (row.itemClass !== 'supply_crate') continue;
          const list = byName.get(row.itemName) ?? [];
          list.push(row.defindex);
          byName.set(row.itemName, list);
        }
        crateGroups = { loadedAt, byName };
      }
      return (crateGroups.byName.get(it.itemName) ?? []).filter((d) => d !== defindex);
    } catch {
      return [];
    }
  };

  const parseRecord = (raw: unknown): PricedbRecord | null => {
    const r = pricedbRecordSchema.safeParse(raw);
    if (r.success) return r.data;
    parseFailures++;
    return null;
  };

  const fetchItem = async (sku: string, priority: 'user' | 'background'): Promise<PricedbRow | null> => {
    if (!enabled()) return null;
    const canon = safeCanonical(sku);
    if (!canon) return null;
    const now = clock.now();
    const neg = negative.get(canon);
    if (neg !== undefined && neg > now) return null;

    const alias = repo.getSkuAlias(canon);
    const variants = pricedbVariants(canon, crateAliases);
    const order = alias ? [alias, ...variants.filter((v) => v !== alias)] : variants;
    for (const variant of order) {
      const res = await call<unknown>(`${PRICEDB_API}/item/${encodeURIComponent(variant)}`, { priority, maxWaitMs: 60_000 });
      if (res === null) return null;
      if (res.status === 404) continue;
      if (!res.ok) return null;
      const rec = parseRecord(res.data);
      if (!rec) continue;
      const row = recordToRow(rec, canon, clock.now());
      repo.transaction(() => {
        repo.upsertPricedb([row]);
        if (variant !== alias) repo.setSkuAlias(canon, variant);
      });
      negative.delete(canon);
      return row;
    }
    if (negative.size >= NEGATIVE_CACHE_MAX) negative.clear();
    negative.set(canon, clock.now() + NEGATIVE_CACHE_MS);
    return null;
  };

  const bulk = async (skus: string[]): Promise<PricedbRow[]> => {
    if (!enabled()) return [];
    const wanted = new Map<string, string[]>();
    for (const s of skus) {
      const canon = safeCanonical(s);
      if (!canon) continue;
      const query = repo.getSkuAlias(canon) ?? toLegacy(canon);
      const list = wanted.get(query) ?? [];
      if (!list.includes(canon)) list.push(canon);
      wanted.set(query, list);
    }
    const queries = [...wanted.keys()];
    const queryByCanonical = new Map(queries.map((q) => [canonical(q), q]));
    const out = new Map<string, PricedbRow>();

    for (let i = 0; i < queries.length; i += BULK_CHUNK) {
      const chunk = queries.slice(i, i + BULK_CHUNK);
      const res = await call<unknown>(`${PRICEDB_API}/items-bulk`, {
        method: 'POST',
        json: { skus: chunk },
        priority: 'background',
        maxWaitMs: 120_000,
      });
      if (res === null || !res.ok) break;
      const list = recordList(res.data);
      if (list === null) {
        parseFailures++;
        continue;
      }
      const now = clock.now();
      const rows: PricedbRow[] = [];
      for (const raw of list) {
        const rec = parseRecord(raw);
        if (!rec) continue;
        // Results are not in request order: map back by sku (order-insensitive as a fallback).
        let inputs = wanted.get(rec.sku);
        if (!inputs && looksLikeSku(rec.sku)) inputs = wanted.get(queryByCanonical.get(canonical(rec.sku)) ?? '');
        if (!inputs) continue;
        for (const canon of inputs) {
          const row = recordToRow(rec, canon, now);
          const prev = out.get(canon);
          if (!prev || row.time > prev.time) {
            out.set(canon, row);
            rows.push(row);
          }
        }
      }
      if (rows.length > 0) repo.upsertPricedb(rows);
    }
    return [...out.values()];
  };

  const doLoadAll = async (): Promise<number> => {
    const last = Number(repo.getMeta(META_LOAD_ALL_AT) ?? NaN);
    if (Number.isFinite(last) && clock.now() - last < LOAD_ALL_MIN_INTERVAL_MS) return 0;
    const res = await call<unknown>(`${PRICEDB_API}/autob/items`, { priority: 'background', timeoutMs: 120_000, maxWaitMs: 120_000 });
    if (res === null || !res.ok) return 0;
    const list = recordList(res.data);
    if (list === null) {
      parseFailures++;
      markRestError(new Error('/autob/items returned an unexpected shape'));
      return 0;
    }
    const now = clock.now();
    const best = new Map<string, { row: PricedbRow; pricedbSku: string }>();
    for (const raw of list) {
      const rec = parseRecord(raw);
      if (!rec || !looksLikeSku(rec.sku)) continue;
      const obj = fromString(rec.sku);
      if (obj.quality === QUALITY_INVALID) continue;
      const canon = fromObject(obj);
      const row = recordToRow(rec, canon, now);
      const prev = best.get(canon);
      if (!prev || row.time > prev.row.time) best.set(canon, { row, pricedbSku: rec.sku });
    }
    const rows = [...best.values()];
    repo.transaction(() => {
      repo.upsertPricedb(rows.map((r) => r.row));
      for (const { row, pricedbSku } of rows) {
        if (pricedbSku !== toLegacy(row.sku)) repo.setSkuAlias(row.sku, pricedbSku);
      }
      repo.setMeta(META_LOAD_ALL_AT, String(now));
    });
    negative.clear();
    log.info(`PriceDB full list: ${rows.length} prices stored`);
    return rows.length;
  };

  const loadAll = (): Promise<number> => {
    if (!enabled()) return Promise.resolve(0);
    if (loadAllInflight) return loadAllInflight;
    loadAllInflight = doLoadAll().finally(() => {
      loadAllInflight = null;
    });
    return loadAllInflight;
  };

  // ----- history -----

  const fetchHistory = async (sku: string, startSec?: UnixSec, endSec?: UnixSec): Promise<PricedbRecord[] | null> => {
    const res = await call<unknown>(`${PRICEDB_API}/item-history/${encodeURIComponent(sku)}`, {
      query: { start: startSec ?? null, end: endSec ?? null },
      priority: 'user',
      maxWaitMs: 60_000,
    });
    if (res === null) return null;
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const list = recordList(res.data);
    if (list === null) {
      parseFailures++;
      return null;
    }
    const out: PricedbRecord[] = [];
    for (const raw of list) {
      const rec = parseRecord(raw);
      if (rec && rec.time !== undefined && rec.time > 0) out.push(rec);
    }
    return out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  };

  const keyCurve = async (startSec?: UnixSec, endSec?: UnixSec): Promise<KeyPoint[]> => {
    const cacheKey = `${startSec ?? ''}|${endSec ?? ''}`;
    const hit = keyHistoryCache.get(cacheKey);
    if (hit && clock.now() - hit.at < KEY_HISTORY_TTL_MS) return hit.points;
    const recs = (await fetchHistory(KEY_SKU, startSec, endSec)) ?? [];
    const points: KeyPoint[] = recs.map((r) => ({
      t: Math.floor(r.time ?? 0),
      buy: (r.buy.keys ?? 0) === 0 && (r.buy.metal ?? 0) > 0 ? refToScrap(r.buy.metal ?? 0) : null,
      sell: (r.sell.keys ?? 0) === 0 && (r.sell.metal ?? 0) > 0 ? refToScrap(r.sell.metal ?? 0) : null,
    }));
    if (keyHistoryCache.size > 20) keyHistoryCache.clear();
    keyHistoryCache.set(cacheKey, { at: clock.now(), points });
    return points;
  };

  const latestKey = (): { buy: Scrap | null; sell: Scrap | null } => {
    try {
      const row = repo.getPricedb(KEY_SKU);
      if (row && row.buyKeys === 0 && row.buyScrap > 0) {
        return { buy: row.buyScrap, sell: row.sellKeys === 0 && row.sellScrap > 0 ? row.sellScrap : null };
      }
      const q = repo.keyQuotes().find((k) => k.buyScrap !== null || k.sellScrap !== null);
      if (q) return { buy: q.buyScrap ?? q.sellScrap, sell: q.sellScrap ?? q.buyScrap };
    } catch {
      // no stored key price
    }
    return { buy: null, sell: null };
  };

  const keyAt = (points: KeyPoint[], t: UnixSec): KeyPoint | null => {
    if (points.length === 0) return null;
    let lo = 0;
    let hi = points.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid]!.t <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return points[found >= 0 ? found : 0] ?? null;
  };

  const history = async (sku: string, startSec?: UnixSec, endSec?: UnixSec): Promise<HistoryPoint[]> => {
    if (!enabled()) return [];
    const canon = safeCanonical(sku);
    if (!canon) return [];
    const recs = await fetchHistory(repo.getSkuAlias(canon) ?? toLegacy(canon), startSec, endSec);
    if (!recs || recs.length === 0) return [];

    const needKeys = canon !== KEY_SKU && recs.some((r) => (r.buy.keys ?? 0) > 0 || (r.sell.keys ?? 0) > 0);
    const curve = needKeys ? await keyCurve(startSec, endSec) : [];
    const fallback = needKeys ? latestKey() : { buy: null, sell: null };
    const value = (keys: number, metal: number, keyScrap: Scrap | null): Scrap | null => {
      if (keys <= 0) return refToScrap(metal);
      return keyScrap === null ? null : Math.round(keys * keyScrap) + refToScrap(metal);
    };

    const byTime = new Map<UnixSec, HistoryPoint>();
    for (const r of recs) {
      const t = Math.floor(r.time ?? 0);
      const k = needKeys ? keyAt(curve, t) : null;
      const keyBuy = k?.buy ?? k?.sell ?? fallback.buy;
      const keySell = k?.sell ?? k?.buy ?? fallback.sell ?? fallback.buy;
      byTime.set(t, {
        t,
        buyScrap: value(r.buy.keys ?? 0, r.buy.metal ?? 0, keyBuy),
        sellScrap: value(r.sell.keys ?? 0, r.sell.metal ?? 0, keySell),
      });
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  };

  const keyQuote = async (): Promise<KeyPriceQuote | null> => {
    if (!enabled()) return null;
    const row = await fetchItem(KEY_SKU, 'background');
    if (!row) return null;
    const buy = row.buyKeys === 0 && row.buyScrap > 0 ? row.buyScrap : null;
    const sell = row.sellKeys === 0 && row.sellScrap > 0 ? row.sellScrap : null;
    if (buy === null && sell === null) return null;
    const quote: KeyPriceQuote = {
      source: 'pricedb',
      buyScrap: buy,
      sellScrap: sell,
      observedAt: row.time > 0 ? row.time * 1000 : row.fetchedAt,
    };
    repo.upsertKeyQuote(quote);
    return quote;
  };

  // ----- socket -----

  let sock: PricedbSocketLike | null = null;
  let generation = 0;
  let started = false;
  let onPrice: ((row: PricedbRow) => void) | null = null;
  let failures = 0;
  let retryTimer: unknown = null;
  let watchTimer: unknown = null;
  let sockState: ConnState = 'off';
  let sockLastOkAt: UnixMs | null = null;
  let sockLastErrorAt: UnixMs | null = null;
  let sockLastError: string | null = null;
  let sockDisabledReason: string | null = null;
  let connectedAt: UnixMs | null = null;
  let nextRetryAt: UnixMs | null = null;
  let lastEventAt: UnixMs | null = null;
  let events = 0;
  let socketParseFailures = 0;

  const clearTimer = (h: unknown): null => {
    if (h !== null) timers.clearTimeout(h);
    return null;
  };

  const dispose = (): void => {
    watchTimer = clearTimer(watchTimer);
    const s = sock;
    sock = null;
    connectedAt = null;
    if (!s) return;
    try {
      s.removeAllListeners();
      s.disconnect();
    } catch {
      // already closed
    }
  };

  const handlePrice = (payload: unknown): void => {
    const list = Array.isArray(payload) ? payload : [payload];
    const now = clock.now();
    const rows: PricedbRow[] = [];
    for (const raw of list) {
      const r = pricedbRecordSchema.safeParse(raw);
      if (!r.success || !looksLikeSku(r.data.sku)) {
        socketParseFailures++;
        continue;
      }
      const obj = fromString(r.data.sku);
      if (obj.quality === QUALITY_INVALID) continue;
      rows.push(recordToRow(r.data, fromObject(obj), now));
    }
    if (rows.length === 0) return;
    events += rows.length;
    lastEventAt = now;
    try {
      repo.upsertPricedb(rows);
      const key = rows.find((r) => r.sku === KEY_SKU);
      if (key && key.buyKeys === 0 && key.buyScrap > 0) {
        repo.upsertKeyQuote({
          source: 'pricedb',
          buyScrap: key.buyScrap,
          sellScrap: key.sellKeys === 0 && key.sellScrap > 0 ? key.sellScrap : null,
          observedAt: key.time > 0 ? key.time * 1000 : now,
        });
      }
    } catch (err) {
      log.warn(`storing PriceDB socket prices failed: ${errorMessage(err)}`);
    }
    for (const row of rows) {
      try {
        onPrice?.(row);
      } catch (err) {
        log.warn(`PriceDB onPrice handler threw: ${errorMessage(err)}`);
      }
    }
  };

  const scheduleConnect = (delay: number): void => {
    retryTimer = clearTimer(retryTimer);
    nextRetryAt = clock.now() + delay;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      nextRetryAt = null;
      connect();
    }, delay);
  };

  /**
   * `kicked`: the server closed the socket on purpose ('io server disconnect');
   * socket.io itself would not reconnect, so wait the slow interval at once.
   */
  const onFailure = (gen: number, err: unknown, kicked = false): void => {
    if (gen !== generation || !started) return;
    // Read before dispose() clears connectedAt.
    const stableFor = connectedAt !== null ? clock.now() - connectedAt : 0;
    generation++;
    dispose();
    sockLastErrorAt = clock.now();
    sockLastError = errorMessage(err);
    if (stableFor >= STABLE_CONNECTION_MS) failures = 0;
    failures = kicked ? Math.max(failures + 1, RECONNECT_DELAYS_MS.length + 1) : failures + 1;
    const delay = failures <= RECONNECT_DELAYS_MS.length ? RECONNECT_DELAYS_MS[failures - 1]! : RECONNECT_SLOW_MS;
    sockState = 'backoff';
    log.info(`PriceDB socket: ${sockLastError}; reconnecting in ${Math.round(delay / 1000)} s (failure ${failures})`);
    scheduleConnect(delay);
  };

  /** While live: notice a network pause or a settings change without waiting for a disconnect. */
  const watch = (gen: number): void => {
    watchTimer = timers.setTimeout(() => {
      watchTimer = null;
      if (gen !== generation || !started) return;
      if (http.isPaused() || !socketEnabled()) {
        generation++;
        dispose();
        connect();
        return;
      }
      if (connectedAt !== null && clock.now() - connectedAt >= STABLE_CONNECTION_MS) failures = 0;
      watch(gen);
    }, SOCKET_CHECK_MS);
  };

  function connect(): void {
    retryTimer = clearTimer(retryTimer);
    dispose();
    if (!started) return;
    if (!socketEnabled()) {
      sockState = 'off';
      scheduleConnect(SOCKET_CHECK_MS);
      return;
    }
    if (http.isPaused()) {
      sockState = 'paused';
      scheduleConnect(SOCKET_CHECK_MS);
      return;
    }
    try {
      assertAllowed(PRICEDB_SOCKET_POLICY_URL, 'ws');
    } catch (err) {
      sockState = 'blocked';
      sockDisabledReason = errorMessage(err);
      return;
    }

    const gen = ++generation;
    sockState = 'connecting';
    let s: PricedbSocketLike;
    try {
      s = socketFactory(PRICEDB_SOCKET_URL, {
        transports: ['websocket'],
        extraHeaders: { 'User-Agent': http.userAgent() },
        reconnection: false,
        timeout: CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      onFailure(gen, err);
      return;
    }
    sock = s;
    s.on('connect', () => {
      if (gen !== generation) return;
      // The backoff resets only once the connection proved stable (onFailure).
      sockState = 'live';
      sockLastOkAt = clock.now();
      connectedAt = sockLastOkAt;
      sockDisabledReason = null;
      watchTimer = clearTimer(watchTimer);
      watch(gen);
    });
    s.on('connect_error', (err) => onFailure(gen, err ?? new Error('connect error')));
    s.on('disconnect', (reason) =>
      onFailure(gen, new Error(`disconnected (${String(reason ?? 'unknown')})`), reason === 'io server disconnect'),
    );
    s.on('price', (payload) => {
      if (gen === generation) handlePrice(payload);
    });
    // In case the client never reports success or failure.
    watchTimer = timers.setTimeout(() => {
      if (gen === generation && sockState === 'connecting') onFailure(gen, new Error('connect timed out'));
    }, CONNECT_TIMEOUT_MS + 5_000);
  }

  const startSocket = (cb: (row: PricedbRow) => void): void => {
    onPrice = cb;
    if (started) return;
    started = true;
    failures = 0;
    connect();
  };

  const stopSocket = (): void => {
    started = false;
    generation++;
    retryTimer = clearTimer(retryTimer);
    nextRetryAt = null;
    dispose();
    sockState = 'off';
  };

  // ----- health -----

  const restHealth = (): ConnectorHealth => {
    const now = clock.now();
    let state: ConnState = 'idle';
    let detail: string;
    let count = 0;
    try {
      count = repo.pricedbCount();
    } catch {
      count = 0;
    }
    const loadedAt = Number(repo.getMeta(META_LOAD_ALL_AT) ?? NaN);
    detail = `${count} prices stored; full list ${Number.isFinite(loadedAt) ? `loaded ${new Date(loadedAt).toISOString()}` : 'not loaded yet'}`;
    if (rlRemaining !== null) detail += `; RateLimit-Remaining ${rlRemaining}`;
    if (parseFailures > 0) detail += `; ${parseFailures} unreadable records`;
    const blocked = http.hostBlocked('pricedb.io') ?? restRefused;
    if (!enabled()) {
      state = 'off';
      detail = 'Disabled in Settings';
    } else if (blocked) {
      state = 'blocked';
    } else if (http.isPaused()) {
      state = 'paused';
    } else if (rlPausedUntil > now) {
      state = 'paused';
      detail += `; paused for the rate limit until ${new Date(rlPausedUntil).toISOString()}`;
    } else if (restErrorState && restLastErrorAt !== null && (restLastOkAt === null || restLastErrorAt >= restLastOkAt)) {
      state = restErrorState;
    }
    return {
      id: 'pricedb',
      label: 'PriceDB prices',
      state,
      detail,
      lastOkAt: restLastOkAt,
      lastErrorAt: restLastErrorAt,
      lastError: restLastError,
      disabledReason: blocked ?? restDisabledReason,
    };
  };

  const socketHealth = (): ConnectorHealth => {
    const now = clock.now();
    let detail: string;
    let state = sockState;
    if (!socketEnabled()) {
      state = 'off';
      detail = 'Disabled in Settings';
    } else if (!started) {
      state = 'off';
      detail = 'Not started';
    } else if (state === 'live') {
      const since = connectedAt ? new Date(connectedAt).toISOString() : 'now';
      detail =
        events === 0
          ? `Connected since ${since}; no price events yet (PriceDB only pushes changes, silence is normal)`
          : `Connected since ${since}; ${events} price updates, last ${lastEventAt ? new Date(lastEventAt).toISOString() : 'never'}`;
    } else if (state === 'backoff') {
      const secs = nextRetryAt ? Math.max(0, Math.round((nextRetryAt - now) / 1000)) : 0;
      detail = `Reconnecting in ${secs} s (failure ${failures})`;
    } else if (state === 'paused') {
      detail = 'Network paused';
    } else if (state === 'connecting') {
      detail = 'Connecting';
    } else if (state === 'blocked') {
      detail = 'Blocked by network policy';
    } else {
      detail = 'Idle';
    }
    if (socketParseFailures > 0) detail += `; ${socketParseFailures} unreadable events`;
    return {
      id: 'pricedb-socket',
      label: 'PriceDB live updates',
      state,
      detail,
      lastOkAt: sockLastOkAt,
      lastErrorAt: sockLastErrorAt,
      lastError: sockLastError,
      disabledReason: sockDisabledReason,
    };
  };

  return {
    item: (sku) => fetchItem(sku, 'user'),
    bulk,
    loadAll,
    history,
    keyQuote,
    startSocket,
    stopSocket,
    health: () => [restHealth(), socketHealth()],
  };
}
