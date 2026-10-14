// The only HTTP client the service may use. Every request goes through, in
// order: host policy, network pause, host block, budget slot, an honest
// User-Agent, timeout, manual redirects (each hop re-checked against the
// policy), Retry-After/429 handling, challenge detection and a redacted
// request-log row per exchange.

import { z } from 'zod';
import type {
  BudgetSpec,
  Clock,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  Logger,
  RequestLogSink,
} from '../contracts';
import type { HostBudget, RequestLogRow, UnixMs } from '../../shared/types';
import { BUDGETS, DEFAULT_HOST_CONCURRENCY, HOST_CONCURRENCY, defaultBudgetFor, type NetBudgetSpec } from './budgets';
import { ForbiddenHostError, HostBlockedError, HttpStatusError, HttpTimeoutError, NetworkPausedError } from './errors';
import { checkUrl, isBackpackHost, normalizeHost } from './policy';
import { BudgetScheduler, ConcurrencyGate, MAX_PAUSE_MS, MIN_PAUSE_MS, realTimers, type Permit, type TimerApi } from './ratelimit';
import { DEFAULT_SECRET_HEADERS, globalSecrets, redactUrl, scrubText, type SecretRegistry } from './redact';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_WAIT_MS = 60_000;
export const MAX_REDIRECTS = 3;
/** Bodies that fail JSON parsing are kept (truncated) for diagnostics. */
export const ERROR_TEXT_LIMIT = 2_048;
/** Refuse absurd responses before buffering them (the full schema is ~21 MB). */
export const MAX_BODY_BYTES = 128 * 1024 * 1024;
/** Pause applied when RateLimit-Remaining is low but no reset time is given. */
export const RATELIMIT_RESET_FALLBACK_MS = 60_000;

/** Network failure (DNS, TLS, connection reset). The URL is already redacted. */
export class NetworkRequestError extends Error {
  override readonly name = 'NetworkRequestError';
  constructor(
    readonly url: string,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** The concrete client: the HttpClient contract plus start-up restore of budget history. */
export interface SeedableHttpClient extends HttpClient {
  /**
   * Counts earlier requests (request-log rows from before a restart) against
   * the budgets their URL maps to, so limits hold across restarts.
   */
  seedHistory(rows: readonly Pick<RequestLogRow, 'ts' | 'host' | 'path'>[]): void;
}

export interface CreateHttpClientOptions {
  clock: Clock;
  log: Logger;
  sink: RequestLogSink;
  userAgent: () => string;
  budgets?: BudgetSpec[];
  fetchImpl?: typeof fetch;
  timers?: TimerApi;
  /** Defaults to the process-wide registry from ./redact. */
  secrets?: SecretRegistry;
  /** Per-host concurrency overrides (defaults: 1 per host, 2 for pricedb.io). */
  hostConcurrency?: Record<string, number>;
  /**
   * Hosts disabled by a challenge in an earlier run, keyed by host, as saved
   * from onBlocksChanged. They stay disabled from the first request on, so a
   * restart never retries a challenged host on its own (R7, brief §2.0).
   */
  initialBlocks?: Record<string, string>;
  /** Called with every current host block whenever one is added or cleared, so the caller can persist them. */
  onBlocksChanged?: (blocks: Record<string, string>) => void;
  /**
   * Called right before each request (and redirect hop) is sent, with the
   * start time and redacted path its request-log row will carry. The log row
   * is only written when the exchange ends, so a caller can persist this to
   * keep counting a request the process died during (seedHistory).
   */
  onBeforeSend?: (start: { budget: string } & Pick<RequestLogRow, 'ts' | 'host' | 'path'>) => void;
}

/** Longest block reason kept from storage. */
const MAX_BLOCK_REASON = 500;
/** At most this many stored host blocks are loaded (the allowlist has about a dozen hosts). */
const MAX_STORED_BLOCKS = 64;

/** Keeps the well-formed {host: reason} entries of a stored block map, with normalised host names. */
function cleanHostBlocks(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [h, reason] of Object.entries(value as Record<string, unknown>).slice(0, MAX_STORED_BLOCKS)) {
    const host = normalizeHost(h);
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host)) continue;
    if (typeof reason !== 'string' || reason.trim() === '') continue;
    out[host] = reason.slice(0, MAX_BLOCK_REASON);
  }
  return out;
}

/**
 * Reads host blocks saved as JSON ({"host": "reason"}). Malformed entries are
 * skipped; anything that is not a JSON object gives {}.
 */
export function parseHostBlocks(raw: string | null | undefined): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    return cleanHostBlocks(JSON.parse(raw));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------

function cleanUaPart(s: string, max: number): string {
  return String(s ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[()]/g, '')
    .trim()
    .slice(0, max);
}

/** `TF2FlipDesk/<version> (+<contactUrl or "no-contact-set">)` (R6). */
export function buildUserAgent(version: string, contactUrl: string): string {
  const v = cleanUaPart(version, 32).replace(/\s+/g, '') || '0.0.0';
  const contact = cleanUaPart(contactUrl, 200) || 'no-contact-set';
  return `TF2FlipDesk/${v} (+${contact})`;
}

const BROWSER_UA = /^\s*mozilla|(?:applewebkit|chrome|chromium|safari|firefox|gecko|edg|edge|opr|opera|electron|trident|msie)\/\d|like gecko/i;

export function isBrowserLikeUserAgent(ua: string): boolean {
  return BROWSER_UA.test(ua);
}

/** Throws unless `ua` is a non-empty, printable-ASCII, non-browser User-Agent. */
export function assertHonestUserAgent(ua: unknown): string {
  if (typeof ua !== 'string' || ua.trim() === '') throw new Error('User-Agent is empty');
  if (/[^\x20-\x7e]/.test(ua)) throw new Error('User-Agent must be printable ASCII');
  if (isBrowserLikeUserAgent(ua)) throw new Error('Refusing to send a browser-like User-Agent (R6)');
  return ua;
}

// ---------------------------------------------------------------------------
// Retry-After and RateLimit headers
// ---------------------------------------------------------------------------

function clampDelay(ms: number): number {
  return Math.min(Math.max(ms, MIN_PAUSE_MS), MAX_PAUSE_MS);
}

/** Seconds, or a Unix timestamp (seconds above 1e9, milliseconds above 1e12), to a delay in ms. */
function numericDelayMs(n: number, now: UnixMs): number {
  if (n > 1e12) return n - now;
  if (n > 1e9) return n * 1000 - now;
  return n * 1000;
}

/**
 * Parses a Retry-After value: delta seconds, an HTTP date, or a Unix timestamp
 * (bp.tf's old docs). Returns the delay in ms clamped to [1 s, 24 h], or null.
 */
export function parseRetryAfter(value: string | null | undefined, now: UnixMs): number | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return clampDelay(numericDelayMs(Number(v), now));
  const date = Date.parse(v);
  if (Number.isFinite(date)) return clampDelay(date - now);
  return null;
}

const numberish = z.union([z.number(), z.string()]).optional().catch(undefined);
const retryHintSchema = z.looseObject({
  retry_after_ms: numberish,
  retry_after: numberish,
  message: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});
const retryBodySchema = z.looseObject({
  response: retryHintSchema.optional().catch(undefined),
});

function toNumber(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Delay requested by a 429/503, in the order node-bptf-listings uses (§6):
 * body retry_after_ms, body retry_after, Retry-After header, "in N seconds"
 * in the message. Null when the server gave no hint.
 */
export function retryDelayFromResponse(
  headers: Record<string, string>,
  body: unknown,
  text: string | null,
  now: UnixMs,
): number | null {
  const outer = retryHintSchema.safeParse(body);
  const inner = retryBodySchema.safeParse(body);
  const hints = [outer.success ? outer.data : null, inner.success ? (inner.data.response ?? null) : null].filter(
    (h): h is z.infer<typeof retryHintSchema> => h !== null,
  );

  for (const h of hints) {
    const ms = toNumber(h.retry_after_ms);
    if (ms !== null) return clampDelay(ms > 1e12 ? ms - now : ms);
  }
  for (const h of hints) {
    const s = toNumber(h.retry_after);
    if (s !== null) return clampDelay(numericDelayMs(s, now));
  }
  const header = parseRetryAfter(headers['retry-after'], now);
  if (header !== null) return header;

  const messages = hints.flatMap((h) => [h.message, h.error]).filter((m): m is string => typeof m === 'string');
  if (typeof text === 'string') messages.push(text.slice(0, ERROR_TEXT_LIMIT));
  for (const m of messages) {
    const match = /\bin\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i.exec(m);
    if (match) return clampDelay(Number(match[1]) * 1000);
  }
  return null;
}

/** IETF RateLimit headers (separate or combined form). */
export function parseRateLimit(
  headers: Record<string, string>,
  now: UnixMs,
): { remaining: number | null; resetMs: number | null } {
  let remainingRaw: string | undefined = headers['ratelimit-remaining'] ?? headers['x-ratelimit-remaining'];
  let resetRaw: string | undefined = headers['ratelimit-reset'] ?? headers['x-ratelimit-reset'];
  const combined = headers['ratelimit'];
  if (combined) {
    remainingRaw ??= /(?:^|[,;\s])r(?:emaining)?=(\d+)/i.exec(combined)?.[1];
    resetRaw ??= /(?:^|[,;\s])(?:t|reset)=(\d+)/i.exec(combined)?.[1];
  }
  const remaining = remainingRaw !== undefined && /^\s*\d+\s*$/.test(remainingRaw) ? Number(remainingRaw) : null;
  const resetN = resetRaw !== undefined && /^\s*\d+(\.\d+)?\s*$/.test(resetRaw) ? Number(resetRaw) : null;
  const resetMs = resetN === null ? null : clampDelay(numericDelayMs(resetN, now));
  return { remaining, resetMs };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Request headers the caller may never set: identity, cookies, proxies, hop-by-hop. */
const BLOCKED_REQUEST_HEADERS = new Set([
  'user-agent',
  'cookie',
  'cookie2',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-app-context',
  'referer',
  'origin',
]);

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function looksLikeHtml(contentType: string, text: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  return /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(text.slice(0, 512));
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round((ms / 3_600_000) * 10) / 10} h`;
}

function errorCode(err: unknown): string | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

function errorMessage(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur) && parts.length < 3) {
    seen.add(cur);
    if (cur instanceof Error) parts.push(cur.message);
    else parts.push(String(cur));
    cur = typeof cur === 'object' ? (cur as { cause?: unknown }).cause : undefined;
  }
  return parts.join(': ').slice(0, 300);
}

function secretValuesFor(url: string, opts: HttpRequestOptions): string[] {
  const values: string[] = [];
  const keys = new Set((opts.secretQuery ?? []).map((k) => k.toLowerCase()));
  if (keys.size > 0) {
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (keys.has(k.toLowerCase()) && v !== null && v !== undefined) values.push(String(v));
    }
    try {
      new URL(url).searchParams.forEach((v, k) => {
        if (keys.has(k.toLowerCase())) values.push(v);
      });
    } catch {
      // policy rejects unparseable URLs anyway
    }
  }
  const secretHeaders = new Set([...DEFAULT_SECRET_HEADERS, ...(opts.secretHeaders ?? [])].map((h) => h.toLowerCase()));
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (!secretHeaders.has(k.toLowerCase()) || typeof v !== 'string') continue;
    values.push(v);
    const bearer = /^\s*(?:bearer|token|basic)\s+(.+)$/i.exec(v);
    if (bearer?.[1]) values.push(bearer[1].trim());
  }
  return values.filter((v) => v.length >= 4);
}

function buildTarget(url: string, query: HttpRequestOptions['query']): URL {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === null || v === undefined) continue;
    u.searchParams.append(k, String(v));
  }
  u.hash = '';
  // Request the canonical host so TLS/SNI matches what the policy approved.
  const host = normalizeHost(u.hostname);
  if (host !== u.hostname) u.hostname = host;
  return u;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface InFlight {
  controller: AbortController;
  pausedAbort: boolean;
}

export function createHttpClient(opts: CreateHttpClientOptions): SeedableHttpClient {
  const { clock, log, sink } = opts;
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timers = opts.timers ?? realTimers;
  const secrets = opts.secrets ?? globalSecrets;
  const hostConcurrency = { ...HOST_CONCURRENCY, ...(opts.hostConcurrency ?? {}) };

  const gates = new Map<string, ConcurrencyGate>();
  const schedulers = new Map<string, BudgetScheduler>();
  const blocked = new Map<string, string>();
  const inflight = new Set<InFlight>();
  let paused = false;

  const gateFor = (host: string): ConcurrencyGate => {
    let g = gates.get(host);
    if (!g) {
      g = new ConcurrencyGate(hostConcurrency[host] ?? DEFAULT_HOST_CONCURRENCY);
      gates.set(host, g);
    }
    return g;
  };

  const addBudget = (spec: BudgetSpec): BudgetScheduler => {
    const s = new BudgetScheduler(spec, { clock, timers, gate: gateFor(normalizeHost(spec.host)) });
    schedulers.set(spec.id, s);
    return s;
  };

  for (const spec of opts.budgets ?? BUDGETS) {
    if (schedulers.has(spec.id)) throw new Error(`Duplicate budget id "${spec.id}"`);
    addBudget(spec);
  }

  const safeLog = (level: keyof Logger, msg: string, meta?: Record<string, string | number | null>): void => {
    try {
      const clean = scrubText(msg, { registry: secrets });
      if (meta) {
        const m: Record<string, string | number | null> = {};
        for (const [k, v] of Object.entries(meta)) m[k] = typeof v === 'string' ? scrubText(v, { registry: secrets }) : v;
        log[level](clean, m);
      } else {
        log[level](clean);
      }
    } catch {
      // logging must never break a request
    }
  };

  // Blocks from an earlier run stay in force until the user clears them (R7).
  for (const [host, reason] of Object.entries(cleanHostBlocks(opts.initialBlocks))) {
    blocked.set(host, reason);
    safeLog('info', `${host} stays disabled from an earlier session: ${reason}`);
  }

  const blocksChanged = (): void => {
    if (!opts.onBlocksChanged) return;
    try {
      opts.onBlocksChanged(Object.fromEntries(blocked));
    } catch (err) {
      safeLog('warn', `saving the disabled hosts failed: ${errorMessage(err)}`);
    }
  };

  const schedulerFor = (budgetId: string | undefined, target: URL): BudgetScheduler => {
    if (budgetId) {
      const s = schedulers.get(budgetId);
      if (!s) throw new Error(`Unknown budget "${budgetId}"`);
      return s;
    }
    const id = defaultBudgetFor(target.href);
    const existing = id ? schedulers.get(id) : undefined;
    if (existing) return existing;
    // An allowed host without a configured budget gets a conservative one.
    const host = normalizeHost(target.hostname);
    const autoId = `auto:${host}`;
    return (
      schedulers.get(autoId) ??
      addBudget({
        id: autoId,
        host,
        minIntervalMs: 5_000,
        maxPerHour: 120,
        concurrency: 1,
        description: `${host}: no configured budget, at most 1 per 5 s and 120 per hour`,
      })
    );
  };

  const pauseHost = (host: string, until: UnixMs, reason: string): void => {
    for (const s of schedulers.values()) {
      if (normalizeHost(s.spec.host) === host) s.pause(until, reason);
    }
  };

  const currentUserAgent = (): string => assertHonestUserAgent(opts.userAgent());

  const record = (row: RequestLogRow): void => {
    try {
      sink.record(row);
    } catch (err) {
      safeLog('warn', `request log write failed: ${errorMessage(err)}`);
    }
  };

  async function request<T = unknown>(url: string, ropts: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const method = String(ropts.method ?? 'GET').toUpperCase();
    const secretKeys = ropts.secretQuery ?? [];
    const values = secretValuesFor(String(url), ropts);
    const redact = (u: string): string => redactUrl(u, secretKeys, { registry: secrets, values });
    const redactPath = (u: URL): string => redactUrl(u.href, secretKeys, { registry: secrets, values, pathOnly: true });
    const scrub = (t: string): string => scrubText(t, { secretKeys, values, registry: secrets });

    // 1. Policy, before anything else (R1/R2).
    const first = checkUrl(url, 'http', method);
    if (!first.allowed) {
      safeLog('warn', `blocked by network policy: ${first.reason}`, { url: redact(String(url)) });
      throw new ForbiddenHostError(redact(String(url)), first.reason);
    }
    if (ropts.json !== undefined && method !== 'POST') throw new Error('A JSON body requires method POST');
    const target = buildTarget(url, ropts.query);
    const second = checkUrl(target.href, 'http', method);
    if (!second.allowed) {
      safeLog('warn', `blocked by network policy: ${second.reason}`, { url: redact(target.href) });
      throw new ForbiddenHostError(redact(target.href), second.reason);
    }

    // 2. Global kill switch, then hosts disabled after a challenge.
    if (paused) throw new NetworkPausedError();
    const host = normalizeHost(target.hostname);
    const blockedReason = blocked.get(host);
    if (blockedReason !== undefined) throw new HostBlockedError(host, blockedReason);

    const ua = currentUserAgent();
    const scheduler = schedulerFor(ropts.budget, target);

    // 3. Budget slot.
    const permit = await scheduler.acquire({
      priority: ropts.priority === 'user' ? 'user' : 'background',
      maxWaitMs: ropts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      signal: ropts.signal,
    });
    try {
      if (paused) throw new NetworkPausedError();
      const lateBlock = blocked.get(host);
      if (lateBlock !== undefined) throw new HostBlockedError(host, lateBlock);
      return await execute<T>({ target, method, ua, ropts, scheduler, permit, redact, redactPath, scrub, values });
    } finally {
      permit.release();
    }
  }

  interface ExecArgs {
    target: URL;
    method: string;
    ua: string;
    ropts: HttpRequestOptions;
    scheduler: BudgetScheduler;
    permit: Permit;
    redact(u: string): string;
    redactPath(u: URL): string;
    scrub(t: string): string;
    values: readonly string[];
  }

  function buildHeaders(host: string, a: ExecArgs): Record<string, string> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.ropts.headers ?? {})) {
      const name = k.toLowerCase();
      if (BLOCKED_REQUEST_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) continue;
      if (typeof v !== 'string') continue;
      h[name] = v;
    }
    h['user-agent'] = a.ua;
    if (!h['accept']) h['accept'] = 'application/json';
    if (isBackpackHost(host)) h['x-app-context'] = '440';
    if (a.ropts.ifNoneMatch) h['if-none-match'] = a.ropts.ifNoneMatch;
    if (a.ropts.json !== undefined) h['content-type'] = 'application/json';
    return h;
  }

  async function execute<T>(a: ExecArgs): Promise<HttpResponse<T>> {
    const { ropts, scheduler } = a;
    const spec = scheduler.spec as NetBudgetSpec;
    const flight: InFlight = { controller: new AbortController(), pausedAbort: false };
    const signal = flight.controller.signal;
    let timedOut = false;
    const timeoutMs =
      typeof ropts.timeoutMs === 'number' && ropts.timeoutMs > 0 ? Math.min(ropts.timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    const timer = timers.setTimeout(() => {
      timedOut = true;
      flight.controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => flight.controller.abort();
    ropts.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (ropts.signal?.aborted) flight.controller.abort();
    inflight.add(flight);

    const started = clock.now();
    const originHost = normalizeHost(a.target.hostname);
    let current = a.target;
    let method = a.method;
    let body: string | undefined = ropts.json !== undefined ? JSON.stringify(ropts.json) : undefined;
    let headers = buildHeaders(originHost, a);

    try {
      for (let hop = 0; ; hop++) {
        const hopHost = normalizeHost(current.hostname);
        const row: RequestLogRow = {
          ts: clock.now(),
          host: hopHost,
          path: a.redactPath(current),
          method,
          status: 0,
          ms: 0,
          bytes: 0,
          note: null,
        };
        const finish = (note: string | null): void => {
          row.ms = Math.max(0, clock.now() - row.ts);
          row.note = note === null ? null : a.scrub(note);
          record(row);
        };

        if (opts.onBeforeSend) {
          try {
            opts.onBeforeSend({ budget: spec.id, ts: row.ts, host: row.host, path: row.path });
          } catch (err) {
            safeLog('warn', `could not record the start of a ${spec.id} request: ${errorMessage(err)}`);
          }
        }

        let res: Response;
        let buf: Uint8Array;
        try {
          res = await fetchImpl(current.href, {
            method,
            headers,
            body,
            redirect: 'manual',
            signal,
            credentials: 'omit',
          });
          row.status = res.status;
          const declared = Number(res.headers.get('content-length'));
          if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
            flight.controller.abort();
            throw new Error(`response too large (${declared} bytes)`);
          }
          buf = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
          if (timedOut) {
            finish(`timeout after ${formatDuration(timeoutMs)}`);
            safeLog('warn', `request timed out: ${hopHost}${row.path}`);
            throw new HttpTimeoutError(a.redact(current.href));
          }
          if (flight.pausedAbort) {
            finish('aborted: network paused');
            throw new NetworkPausedError();
          }
          if (ropts.signal?.aborted) {
            finish('aborted by caller');
            throw ropts.signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
          }
          const msg = a.scrub(errorMessage(err));
          finish(`network error: ${msg}`);
          safeLog('warn', `network error for ${hopHost}${row.path}: ${msg}`);
          throw new NetworkRequestError(a.redact(current.href), errorCode(err), `Network error: ${msg}`);
        }

        row.bytes = buf.byteLength;
        const status = res.status;
        const resHeaders = headersToRecord(res.headers);

        // Redirects: follow only when the next hop also passes the policy.
        const location = resHeaders['location'];
        if (isRedirect(status) && location !== undefined) {
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            finish('redirect with an invalid Location');
            throw new HttpStatusError(status, a.redact(current.href), 'invalid redirect Location');
          }
          const nextMethod = status === 307 || status === 308 ? method : 'GET';
          const decision = checkUrl(next.href, 'http', nextMethod);
          if (!decision.allowed) {
            finish(`redirect blocked: ${decision.reason}`);
            safeLog('warn', `redirect from ${hopHost} blocked: ${decision.reason}`, { location: a.redact(next.href) });
            throw new ForbiddenHostError(a.redact(next.href), decision.reason);
          }
          const nextHost = normalizeHost(next.hostname);
          const carriesSecret =
            a.values.some((v) => next.href.includes(v) || next.href.includes(encodeURIComponent(v))) ||
            secrets.redactText(next.href) !== next.href;
          if (nextHost !== originHost && carriesSecret) {
            const reason = 'redirect would send a secret to another host (R8)';
            finish(`redirect blocked: ${reason}`);
            throw new ForbiddenHostError(a.redact(next.href), reason);
          }
          if (hop + 1 > MAX_REDIRECTS) {
            finish('too many redirects');
            throw new HttpStatusError(status, a.redact(current.href), 'too many redirects');
          }
          const nextBlock = blocked.get(nextHost);
          if (nextBlock !== undefined) {
            finish(`redirect to disabled host ${nextHost}`);
            throw new HostBlockedError(nextHost, nextBlock);
          }
          finish(`redirect -> ${nextHost}${a.redactPath(next)}`);

          next.hash = '';
          if (nextHost !== next.hostname) next.hostname = nextHost;
          if (nextMethod === 'GET') body = undefined;
          headers = buildHeaders(nextHost, a);
          if (nextMethod === 'GET') delete headers['content-type'];
          if (nextHost !== originHost) {
            // Credentials and validators belong to the issuing host only.
            const strip = new Set([...DEFAULT_SECRET_HEADERS, ...(ropts.secretHeaders ?? []), 'if-none-match'].map((x) => x.toLowerCase()));
            for (const name of Object.keys(headers)) if (strip.has(name)) delete headers[name];
          }
          current = next;
          method = nextMethod;
          a.permit.countExtra();
          continue;
        }

        const decoder = new TextDecoder('utf-8');
        const text = buf.byteLength > 0 ? decoder.decode(buf) : '';

        // Challenge pages disable the host until the user re-enables it (R7).
        const cf = resHeaders['cf-mitigated'] ?? '';
        const challenged = /challenge/i.test(cf);
        if (challenged || ((status === 403 || status === 503) && looksLikeHtml(resHeaders['content-type'] ?? '', text))) {
          const reason = challenged
            ? `challenge page (cf-mitigated: challenge, HTTP ${status}); re-enable after checking in a browser`
            : `HTML error page (HTTP ${status}) instead of JSON; re-enable after checking in a browser`;
          if (blocked.get(hopHost) !== reason) {
            blocked.set(hopHost, reason);
            blocksChanged();
          }
          finish(`host disabled: ${reason}`);
          safeLog('warn', `${hopHost} disabled: ${reason}`);
          throw new HostBlockedError(hopHost, reason);
        }

        let data: T | null = null;
        let outText: string | null = null;
        let parsedForHints: unknown = null;
        const notes: string[] = [];
        if (status === 304) {
          notes.push('not modified');
        } else if (ropts.expectJson === false) {
          outText = text;
        } else if (text.trim() !== '') {
          try {
            data = JSON.parse(text) as T;
            parsedForHints = data;
          } catch {
            outText = a.scrub(text.slice(0, ERROR_TEXT_LIMIT));
            notes.push('invalid JSON');
          }
        }

        const now = clock.now();
        if (status === 429 || status === 503) {
          if (parsedForHints === null && text.trim().startsWith('{')) {
            try {
              parsedForHints = JSON.parse(text);
            } catch {
              parsedForHints = null;
            }
          }
          const hinted = retryDelayFromResponse(resHeaders, parsedForHints, text, now);
          const result = status === 429 ? scheduler.record429(hinted, now) : scheduler.recordUnavailable(hinted, now);
          if (result.longPause) {
            pauseHost(normalizeHost(spec.host), result.until, `${result.consecutive429} consecutive 429 responses`);
          }
          const why = hinted !== null ? 'server-requested' : 'backoff';
          notes.push(
            result.longPause
              ? `HTTP 429 x${result.consecutive429}: ${spec.host} paused ${formatDuration(result.pauseMs)}`
              : `HTTP ${status}: ${spec.id} paused ${formatDuration(result.pauseMs)} (${why})`,
          );
          safeLog('warn', `HTTP ${status} from ${hopHost}; ${spec.id} paused ${formatDuration(result.pauseMs)} (${why})`, {
            consecutive429: result.consecutive429,
          });
        } else {
          scheduler.recordSuccess();
        }

        if (typeof spec.minRemaining === 'number') {
          const rl = parseRateLimit(resHeaders, now);
          if (rl.remaining !== null && rl.remaining < spec.minRemaining) {
            const waitMs = rl.resetMs ?? RATELIMIT_RESET_FALLBACK_MS;
            scheduler.pause(now + waitMs, `RateLimit-Remaining ${rl.remaining}`);
            notes.push(`RateLimit-Remaining ${rl.remaining}: paused ${formatDuration(waitMs)}`);
          }
        }

        finish(notes.length > 0 ? notes.join('; ') : null);
        safeLog('debug', `${method} ${hopHost}${row.path} -> ${status} (${row.ms} ms, ${row.bytes} B)`);

        return {
          status,
          ok: status >= 200 && status < 300,
          data,
          text: outText,
          headers: resHeaders,
          etag: resHeaders['etag'] ?? null,
          notModified: status === 304,
          bytes: buf.byteLength,
          ms: Math.max(0, clock.now() - started),
        };
      }
    } finally {
      timers.clearTimeout(timer);
      ropts.signal?.removeEventListener('abort', onCallerAbort);
      inflight.delete(flight);
    }
  }

  return {
    request,
    seedHistory(rows): void {
      const byBudget = new Map<BudgetScheduler, number[]>();
      for (const row of rows) {
        if (!row || typeof row.host !== 'string' || typeof row.path !== 'string') continue;
        const p = row.path.startsWith('/') ? row.path : `/${row.path}`;
        const id = defaultBudgetFor(`https://${normalizeHost(row.host)}${p}`);
        const s = id ? schedulers.get(id) : undefined;
        if (!s) continue;
        const list = byBudget.get(s) ?? [];
        list.push(row.ts);
        byBudget.set(s, list);
      }
      for (const [s, times] of byBudget) s.seed(times);
    },
    setPaused(p: boolean): void {
      const next = Boolean(p);
      if (next === paused) return;
      paused = next;
      if (paused) {
        for (const f of inflight) {
          f.pausedAbort = true;
          f.controller.abort();
        }
        for (const s of schedulers.values()) s.cancelAll(new NetworkPausedError());
        safeLog('info', 'network paused');
      } else {
        safeLog('info', 'network resumed');
      }
    },
    isPaused: () => paused,
    nextAllowedAt(budget: string): UnixMs {
      return schedulers.get(budget)?.nextAllowedAt() ?? clock.now();
    },
    budgets(): HostBudget[] {
      const now = clock.now();
      return [...schedulers.values()].map((s) => ({
        id: s.spec.id,
        host: s.spec.host,
        policy: s.spec.description,
        usedLastHour: s.usedLast(3_600_000, now),
        pausedUntil: s.pausedUntil(now),
        consecutive429: s.consecutive429,
      }));
    },
    hostBlocked(h: string): string | null {
      return blocked.get(normalizeHost(String(h ?? ''))) ?? null;
    },
    unblockHost(h: string): void {
      const host = normalizeHost(String(h ?? ''));
      if (blocked.delete(host)) {
        safeLog('info', `${host} re-enabled by the user`);
        blocksChanged();
      }
    },
    userAgent: currentUserAgent,
  };
}
