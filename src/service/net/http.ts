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
import {
  BudgetScheduler,
  CONSECUTIVE_429_LIMIT,
  ConcurrencyGate,
  LONG_PAUSE_MS,
  MAX_PAUSE_MS,
  MIN_PAUSE_MS,
  realTimers,
  type PersistedBudgetState,
  type Permit,
  type TimerApi,
} from './ratelimit';
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
/**
 * 0.7.4 (F52): answers meaning the server, or Cloudflare in front of it, cannot serve now: 500, 502, 503, 504 and
 * Cloudflare's 520-527 and 530. Each pauses its budget like a 503 (Retry-After, else the backoff) and neither counts
 * toward nor ends a 429 streak. 501 and the 4xx answer the request itself and end a streak, as before.
 */
export const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

export function isUnavailableStatus(status: number): boolean {
  return UNAVAILABLE_STATUSES.has(status);
}

/** 0.7.4 (F52): the caller's HttpRequestOptions.isAnswer for an unavailable status; a throwing callback is no answer. */
function callerAnswer(ropts: HttpRequestOptions, status: number, data: unknown): boolean {
  if (typeof ropts.isAnswer !== 'function') return false;
  try {
    return ropts.isAnswer(status, data) === true;
  } catch {
    return false;
  }
}

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
  /**
   * Budget pauses (Retry-After, backoff, consecutive 429s) and 429 streaks from
   * an earlier run, as saved from onPausesChanged. Without them a crash restart
   * or relaunch would send again before the server's wait is over (R7).
   */
  initialPauses?: NetPauseState;
  /** Called with the current pauses and streaks whenever they change, so the caller can persist them. */
  onPausesChanged?: (state: NetPauseState) => void;
}

/** Pause state worth keeping across restarts: per budget, plus the consecutive 429s per host. */
export interface NetPauseState {
  budgets: Record<string, PersistedBudgetState>;
  hosts429: Record<string, number>;
}

/** Longest block reason kept from storage. */
const MAX_BLOCK_REASON = 500;
/** At most this many stored host blocks are loaded (the allowlist has about a dozen hosts). */
const MAX_STORED_BLOCKS = 64;
const HOST_NAME_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/** Keeps the well-formed {host: reason} entries of a stored block map, with normalised host names. */
function cleanHostBlocks(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [h, reason] of Object.entries(value as Record<string, unknown>).slice(0, MAX_STORED_BLOCKS)) {
    const host = normalizeHost(h);
    if (!HOST_NAME_RE.test(host)) continue;
    if (typeof reason !== 'string' || reason.trim() === '') continue;
    out[host] = reason.slice(0, MAX_BLOCK_REASON);
  }
  return out;
}

/** Longest pause reason kept from storage; budgets and hosts loaded at most. */
const MAX_PAUSE_REASON = 200;
const MAX_STORED_PAUSES = 64;

const storedBudgetPause = z.looseObject({
  until: z.number().catch(0),
  reason: z.string().nullable().catch(null),
  n429: z.number().catch(0),
  nBackoff: z.number().catch(0),
});
const storedPauses = z.looseObject({
  budgets: z.record(z.string(), z.unknown()).catch({}),
  hosts429: z.record(z.string(), z.unknown()).catch({}),
});

/** Keeps the well-formed entries of a stored pause state; clamping to now happens on restore. */
function cleanPauseState(value: unknown): NetPauseState {
  const out: NetPauseState = { budgets: {}, hosts429: {} };
  const parsed = storedPauses.safeParse(value);
  if (!parsed.success) return out;
  for (const [id, raw] of Object.entries(parsed.data.budgets).slice(0, MAX_STORED_PAUSES)) {
    const p = storedBudgetPause.safeParse(raw);
    if (!p.success || id.length > 100) continue;
    out.budgets[id] = {
      until: p.data.until,
      reason: p.data.reason === null ? null : p.data.reason.slice(0, MAX_PAUSE_REASON),
      n429: p.data.n429,
      nBackoff: p.data.nBackoff,
    };
  }
  for (const [h, n] of Object.entries(parsed.data.hosts429).slice(0, MAX_STORED_PAUSES)) {
    const host = normalizeHost(h);
    if (!HOST_NAME_RE.test(host) || typeof n !== 'number' || !Number.isFinite(n) || n < 1) continue;
    out.hosts429[host] = Math.min(Math.floor(n), CONSECUTIVE_429_LIMIT);
  }
  return out;
}

/** Reads pause state saved as JSON (see NetPauseState). Anything malformed gives no pauses. */
export function parsePauseState(raw: string | null | undefined): NetPauseState {
  if (typeof raw !== 'string' || raw.trim() === '') return { budgets: {}, hosts429: {} };
  try {
    return cleanPauseState(JSON.parse(raw));
  } catch {
    return { budgets: {}, hosts429: {} };
  }
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
 * Delay requested by a 429 or an unavailable answer (a 503, 502...), in the order node-bptf-listings uses (§6):
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

/**
 * 0.9 (#14): what marks an HTML answer as Cloudflare's challenge even without cf-mitigated: the interstitial's
 * orchestrate script (/cdn-cgi/challenge-platform/[h/<x>/]orchestrate/), its options object and form ids, the Turnstile
 * host and the "Just a moment..." title. A JSON API answering with one (a backpack.tf 429 can be an nginx page carrying
 * such a script, RESEARCH §4.2) takes R7's challenge path, never the retry path.
 * Only challenge-specific signatures count: Cloudflare injects its JavaScript-detections snippet (`__CF$cv$params`,
 * /cdn-cgi/challenge-platform/scripts/jsd/main.js) into ordinary, unchallenged pages, an nginx 429 or a 5xx outage
 * page included, so the bare challenge-platform path is no marker and such a page keeps its status's own path.
 */
export const CHALLENGE_BODY_MARKERS =
  /\/cdn-cgi\/challenge-platform\/(?:h\/[a-z]\/)?orchestrate\/|_cf_chl_opt|\bcf[-_]chl[-_]|challenges\.cloudflare\.com|<title>\s*just a moment/i;
const CHALLENGE_SCAN_CHARS = 262_144;

/** 0.9 (#14): `text` (an HTML answer's start) carries one of CHALLENGE_BODY_MARKERS. */
export function hasChallengeMarkers(text: string): boolean {
  return CHALLENGE_BODY_MARKERS.test(text.slice(0, CHALLENGE_SCAN_CHARS));
}

/** 0.9 (#14): Steam Web API results that mean a rate limit (xpaw: 25 LimitExceeded, 84 RateLimitExceeded). */
export const STEAM_RATE_LIMIT_ERESULTS: ReadonlySet<string> = new Set(['25', '84']);

/** 0.9 (#14): the x-eresult of an api.steampowered.com answer when it is a rate limit, else null. */
export function steamRateLimitEresult(host: string, headers: Record<string, string>): string | null {
  if (normalizeHost(host) !== 'api.steampowered.com') return null;
  const v = (headers['x-eresult'] ?? '').trim();
  return STEAM_RATE_LIMIT_ERESULTS.has(v) ? v : null;
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

  /**
   * 429s in a row per host, across all of its budgets (brief §2.0: "after 3
   * consecutive 429s, pause that host for 1 h"). The per-budget counters alone
   * would let 429s spread over five bp.tf budgets reach about ten in a row.
   */
  const host429 = new Map<string, number>();

  const pauseState = (): NetPauseState => {
    const now = clock.now();
    const budgets: Record<string, PersistedBudgetState> = {};
    for (const s of schedulers.values()) {
      const st = s.persistedState(now);
      if (st.until > 0 || st.n429 > 0 || st.nBackoff > 0) budgets[s.spec.id] = st;
    }
    return { budgets, hosts429: Object.fromEntries(host429) };
  };

  // Pauses from an earlier run hold from the first request on (R7).
  const savedPauses = cleanPauseState(opts.initialPauses);
  {
    const now = clock.now();
    for (const [id, st] of Object.entries(savedPauses.budgets)) schedulers.get(id)?.restore(st, now);
    for (const [host, n] of Object.entries(savedPauses.hosts429)) host429.set(host, n);
    for (const s of schedulers.values()) {
      const until = s.pausedUntil(now);
      if (until !== null) safeLog('info', `${s.spec.id} stays paused until ${new Date(until).toISOString()} (from an earlier session)`);
    }
  }
  // Compared with what was stored, not with the restored state: a pause that restore()
  // clamped to 24 h is written back, or every restart would clamp it afresh from its own now.
  let lastPauseJson = JSON.stringify(savedPauses);

  /** Saves the pause state when it differs from the last saved one. */
  const pausesChanged = (): void => {
    if (!opts.onPausesChanged) return;
    try {
      const state = pauseState();
      const json = JSON.stringify(state);
      if (json === lastPauseJson) return;
      opts.onPausesChanged(state);
      lastPauseJson = json; // after the save, so a failed one is tried again next time
    } catch (err) {
      safeLog('warn', `saving the request pauses failed: ${errorMessage(err)}`);
    }
  };
  pausesChanged();

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
        const html = looksLikeHtml(resHeaders['content-type'] ?? '', text);
        // 0.9 (#14): an HTML answer carrying Cloudflare's challenge script is a challenge whatever its status (a 429 too).
        const scripted = html && hasChallengeMarkers(text);
        if (challenged || scripted || ((status === 403 || status === 503) && html)) {
          const reason = challenged
            ? `challenge page (cf-mitigated: challenge, HTTP ${status}); re-enable after checking in a browser`
            : scripted
              ? `challenge page (Cloudflare challenge script, HTTP ${status}); re-enable after checking in a browser`
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
        const budgetHost = normalizeHost(spec.host);
        // 0.7.4 (F52): every unavailable answer (500, 502, 504, Cloudflare's 52x and 530) waits like a 503, so an
        // outage is not polled at the budget's spacing and a 5xx between two 429s does not end their streak. A 5xx
        // the caller reads as its answer about this request (ropts.isAnswer: Steam Market's 500 {"success":false},
        // no listing under that name) is no outage and counts as a success, as before F52; never a 429.
        // 0.9 (#14): Steam reports its rate limits in x-eresult (25, 84), even on a 200: counted as a 429.
        const eresult = steamRateLimitEresult(hopHost, resHeaders);
        const limited = status === 429 || eresult !== null;
        const statusText = `${status}${eresult ? ` (x-eresult ${eresult})` : ''}`;
        if (limited || (isUnavailableStatus(status) && !callerAnswer(ropts, status, data))) {
          if (parsedForHints === null && text.trim().startsWith('{')) {
            try {
              parsedForHints = JSON.parse(text);
            } catch {
              parsedForHints = null;
            }
          }
          const hinted = retryDelayFromResponse(resHeaders, parsedForHints, text, now);
          const result = limited ? scheduler.record429(hinted, now) : scheduler.recordUnavailable(hinted, now, status);
          // A 503 (or another unavailable answer) neither counts toward nor ends a host's 429 streak, like the
          // per-budget counter.
          const hostStreak = limited ? (host429.get(budgetHost) ?? 0) + 1 : 0;
          if (limited) host429.set(budgetHost, hostStreak);
          const longPause = result.longPause || hostStreak >= CONSECUTIVE_429_LIMIT;
          const streak = Math.max(result.consecutive429, hostStreak);
          const until = longPause ? Math.max(result.until, now + LONG_PAUSE_MS) : result.until;
          if (longPause) pauseHost(budgetHost, until, `${streak} consecutive 429 responses`);
          const why = hinted !== null ? 'server-requested' : 'backoff';
          notes.push(
            longPause
              ? `HTTP ${statusText} x${streak}: ${spec.host} paused ${formatDuration(until - now)}`
              : `HTTP ${statusText}: ${spec.id} paused ${formatDuration(result.pauseMs)} (${why})`,
          );
          safeLog('warn', `HTTP ${statusText} from ${hopHost}; ${spec.id} paused ${formatDuration(until - now)} (${why})`, {
            consecutive429: streak,
          });
        } else {
          scheduler.recordSuccess();
          host429.delete(budgetHost);
        }

        if (typeof spec.minRemaining === 'number') {
          const rl = parseRateLimit(resHeaders, now);
          if (rl.remaining !== null && rl.remaining < spec.minRemaining) {
            const waitMs = rl.resetMs ?? RATELIMIT_RESET_FALLBACK_MS;
            scheduler.pause(now + waitMs, `RateLimit-Remaining ${rl.remaining}`);
            notes.push(`RateLimit-Remaining ${rl.remaining}: paused ${formatDuration(waitMs)}`);
          }
        }
        pausesChanged();

        finish(notes.length > 0 ? notes.join('; ') : null);
        safeLog('debug', `${method} ${hopHost}${row.path} -> ${status} (${row.ms} ms, ${row.bytes} B)`);

        return {
          status,
          // 0.9 (#14): a Steam rate limit in x-eresult is no success, though the status stays the true one.
          ok: status >= 200 && status < 300 && eresult === null,
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
    blockHost(h: string, reason: string): void {
      const host = normalizeHost(String(h ?? '').trim());
      const why = String(reason ?? '').trim().slice(0, MAX_BLOCK_REASON) || 'disabled after a refused connection';
      if (!HOST_NAME_RE.test(host)) return;
      if (blocked.get(host) === why) return;
      blocked.set(host, why);
      safeLog('warn', `${host} disabled: ${why}`);
      blocksChanged();
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
