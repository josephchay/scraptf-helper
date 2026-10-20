// backpack.tf REST API (DESIGN_BRIEF §2.2-§2.5): classifieds snapshot (access
// token), IGetPrices v4 and IGetCurrencies v1 (API key), users/info v1 (token).
// Read-only: GET only, never /agent/* or listing writes. Every request goes
// through the shared HttpClient (policy, budgets, redacted request log).

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BptfApi, HttpRequestOptions, HttpResponse, SchemaService, ServiceDeps, SnapshotResult } from '../contracts';
import type { CommunityRow, ConnState, ConnectorHealth, KeyPriceQuote, Listing, SecretName, UnixMs, UnixSec } from '../../shared/types';
import { baseSku, looksLikeSku } from '../../shared/sku';
import { scrapToRef } from '../../shared/currency';
import { BPTF_API_ACCESS_URL } from '../../shared/links';
import { HttpStatusError, NetworkPausedError, RateLimitedError, scrubText } from '../net';
import { createMapStats, listingFromSnapshot, parseIGetCurrencies, parseIGetPrices, type BptfMapStats } from './bptfItem';

export const BPTF_API_BASE = 'https://api.backpack.tf/api';
export const SNAPSHOT_URL = `${BPTF_API_BASE}/classifieds/listings/snapshot`;
export const PRICES_URL = `${BPTF_API_BASE}/IGetPrices/v4`;
export const CURRENCIES_URL = `${BPTF_API_BASE}/IGetCurrencies/v1`;
export const USERS_URL = `${BPTF_API_BASE}/users/info/v1`;

export const SNAPSHOT_CACHE_MS = 10 * 60_000;
export const SNAPSHOT_CACHE_MAX = 500;
/** After a 404/410 the endpoint is probed again at most once per this interval. */
export const SNAPSHOT_REPROBE_MS = 24 * 60 * 60_000;
export const USERS_BATCH_SIZE = 100;
export const PRICES_TIMEOUT_MS = 180_000;
export const TOKEN_TEST_ITEM = 'Mann Co. Supply Crate Key';
/** Settings tests fail fast with a rate-limit message instead of waiting the default 60 s for a slot. */
export const TEST_MAX_WAIT_MS = 15_000;
/** Same for the drawer's on-click ban check (users/info with priority 'user'). */
export const USERS_USER_MAX_WAIT_MS = 15_000;
/** The click's answer timeout: slot wait plus answer stays under main's 30 s RPC timeout. */
export const USERS_USER_TIMEOUT_MS = 12_000;
export const META_TOKEN_METHOD = 'bptf.tokenMethod';
export const META_SNAPSHOT_UNAVAILABLE = 'bptf.snapshotUnavailable';

export type TokenMethod = 'header' | 'query';
type Family = 'snapshot' | 'prices' | 'currencies' | 'users';
type CredentialName = Extract<SecretName, 'bptfApiKey' | 'bptfAccessToken'>;

/**
 * What to do about a rejected credential. Only the value's shape is used, never the value:
 * a 32-hex value is a Steam Web API key, the commonest wrong paste (backpack.tf keys are 24).
 */
export function credentialHint(name: CredentialName, value: string): string {
  if (/^[0-9a-f]{32}$/i.test(value)) {
    return `This looks like a Steam Web API key. backpack.tf's own ${name === 'bptfApiKey' ? 'API key' : 'access token'} is on ${BPTF_API_ACCESS_URL}.`;
  }
  return name === 'bptfApiKey'
    ? `On ${BPTF_API_ACCESS_URL}, register a key under "API Key" (any site URL and a short comment) and copy that value, not the access token.`
    : `On ${BPTF_API_ACCESS_URL}, click "Reveal" under "Access Token" and copy that value, not the API key.`;
}

/** The connector is off in Settings or the needed key/token is missing. */
export class BptfNotConfiguredError extends Error {
  override readonly name = 'BptfNotConfiguredError';
}

/** backpack.tf rejected the API key or access token (401/403 with a JSON body). */
export class BptfCredentialError extends Error {
  override readonly name = 'BptfCredentialError';
  constructor(
    readonly secret: CredentialName,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The snapshot endpoint answered 404/410 and is treated as removed (§2.2 deprecation). */
export class BptfSnapshotUnavailableError extends Error {
  override readonly name = 'BptfSnapshotUnavailableError';
}

const FAMILIES: readonly { family: Family; id: string; label: string; secret: CredentialName }[] = [
  { family: 'snapshot', id: 'bptf-snapshot', label: 'backpack.tf classifieds snapshot', secret: 'bptfAccessToken' },
  { family: 'prices', id: 'bptf-prices', label: 'backpack.tf community prices (IGetPrices)', secret: 'bptfApiKey' },
  { family: 'currencies', id: 'bptf-currencies', label: 'backpack.tf key price (IGetCurrencies)', secret: 'bptfApiKey' },
  { family: 'users', id: 'bptf-users', label: 'backpack.tf user and ban info', secret: 'bptfAccessToken' },
];

interface FamilyState {
  lastOkAt: UnixMs | null;
  lastErrorAt: UnixMs | null;
  lastError: string | null;
  rateLimitedUntil: UnixMs | null;
}

const snapshotResponseSchema = z.looseObject({
  listings: z.array(z.unknown()).optional(),
  createdAt: z.unknown().optional(),
  sku: z.string().optional(),
});

const unavailableSchema = z.object({ status: z.number(), at: z.number() });

const usersUserSchema = z.looseObject({
  steamid: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  bans: z.unknown().optional(),
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16);
}

function toSec(v: unknown): UnixSec | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/** A ban flag: 1/true/"1", a non-empty array, or a ban object such as `{end, reason}`. */
function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '0' || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * bp.tf user `bans` (classic docs): `all` = site ban, `steamrep_scammer`,
 * `valve.economy` = Steam trade ban. Cautions, VAC and suggestion bans do not count.
 */
export function isBannedFromBans(bans: unknown): boolean {
  if (Array.isArray(bans)) return bans.length > 0;
  if (!isRecord(bans)) return false;
  if (truthy(bans['all']) || truthy(bans['steamrep_scammer']) || truthy(bans['marketplace'])) return true;
  const valve = bans['valve'];
  return isRecord(valve) && truthy(valve['economy']);
}

/** The bans isBannedFromBans counts, in that order. */
const COUNTED_BANS: readonly [string, string][] = [
  ['all', 'backpack.tf: banned from the site'],
  ['steamrep_scammer', 'SteamRep: marked as a scammer'],
  ['marketplace', 'marketplace.tf: banned'],
];
const VALVE_NOTES: readonly [string, string][] = [
  ['community', 'Steam: community ban'],
  ['vac', 'Steam: VAC ban (does not block trading)'],
  ['game', 'Steam: game ban (does not block trading)'],
];
const MAX_BAN_LINES = 12;

/** " (permanent, Scamming)" from a bp.tf ban object `{end, reason}`; "" when it has neither. */
function banSuffix(v: unknown): string {
  if (!isRecord(v)) return '';
  const parts: string[] = [];
  const end = v['end'];
  if (end === -1 || end === '-1') parts.push('permanent');
  else {
    const sec = toSec(end);
    if (sec !== null) parts.push(`until ${new Date(sec * 1000).toISOString().slice(0, 10)}`);
  }
  // Other users' text from the API: one short plain line.
  const reason = typeof v['reason'] === 'string' ? v['reason'].replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (reason) parts.push(reason);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * Human-readable lines for every ban in a bp.tf user `bans` value: the ones
 * isBannedFromBans counts first, then context that does not count (SteamRep
 * caution, VAC, other backpack.tf feature bans). Empty for a clean user.
 */
export function banDetailsFromBans(bans: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(bans)) {
    for (const b of bans) {
      const type = isRecord(b) && typeof b['type'] === 'string' && /^[a-z_ ]{1,30}$/i.test(b['type']) ? b['type'].replace(/_/g, ' ') : '';
      out.push(`backpack.tf: ${type ? `${type} ban` : 'banned'}${banSuffix(b)}`);
    }
    return out.slice(0, MAX_BAN_LINES);
  }
  if (!isRecord(bans)) return out;
  for (const [key, label] of COUNTED_BANS) if (truthy(bans[key])) out.push(label + banSuffix(bans[key]));
  const valve = isRecord(bans['valve']) ? bans['valve'] : null;
  if (valve && truthy(valve['economy'])) out.push('Steam: trade banned');
  if (truthy(bans['steamrep_caution'])) out.push('SteamRep: caution (not a ban)');
  if (valve) for (const [key, label] of VALVE_NOTES) if (truthy(valve[key])) out.push(label);
  const known = new Set(['all', 'steamrep_scammer', 'steamrep_caution', 'marketplace', 'valve']);
  for (const [key, v] of Object.entries(bans)) {
    // Feature bans such as "classifieds" or "suggestions": shown, not counted.
    if (known.has(key) || !/^[a-z_]{1,30}$/i.test(key) || !truthy(v)) continue;
    out.push(`backpack.tf: ${key.replace(/_/g, ' ')} ban${banSuffix(v)}`);
  }
  return out.slice(0, MAX_BAN_LINES);
}

/** "The Team Captain" <-> "Team Captain"; null when the name is too short to flip. */
export function alternateTheName(name: string): string | null {
  const n = name.trim();
  if (/^The\s+\S/i.test(n)) return n.replace(/^The\s+/i, '');
  if (n.length === 0) return null;
  return `The ${n}`;
}

function responseMessage(res: HttpResponse): string {
  const d = res.data;
  if (isRecord(d)) {
    if (typeof d['message'] === 'string') return d['message'];
    const inner = d['response'];
    if (isRecord(inner) && typeof inner['message'] === 'string') return inner['message'];
  }
  return typeof res.text === 'string' ? res.text.slice(0, 200) : '';
}

/** 401, or 403 with a JSON body (an HTML 403 is a challenge page and already blocked by the HTTP layer). */
function isAuthFailure(res: HttpResponse): boolean {
  return res.status === 401 || (res.status === 403 && res.data !== null);
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

export function createBptfApi(deps: ServiceDeps & { schema: SchemaService }): BptfApi & { mapStats(): BptfMapStats } {
  const { clock, log, repo, http, schema } = deps;
  const mapStats = createMapStats();
  const state: Record<Family, FamilyState> = {
    snapshot: { lastOkAt: null, lastErrorAt: null, lastError: null, rateLimitedUntil: null },
    prices: { lastOkAt: null, lastErrorAt: null, lastError: null, rateLimitedUntil: null },
    currencies: { lastOkAt: null, lastErrorAt: null, lastError: null, rateLimitedUntil: null },
    users: { lastOkAt: null, lastErrorAt: null, lastError: null, rateLimitedUntil: null },
  };
  /** Fingerprints (never the secret) of credentials backpack.tf rejected, with the reason. */
  const rejected: Record<CredentialName, { fp: string; reason: string } | null> = { bptfApiKey: null, bptfAccessToken: null };
  const cache = new Map<string, { at: UnixMs; result: SnapshotResult }>();
  /** Fingerprint of the API key backpack.tf last accepted, and when (lets a key test skip a tight budget). */
  let keyAccepted: { fp: string; at: UnixMs } | null = null;
  const inflight = new Map<string, Promise<SnapshotResult>>();

  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  const secretValues = (): string[] =>
    (['bptfApiKey', 'bptfAccessToken'] as const).map((n) => safe(() => deps.secret(n), null)).filter((v): v is string => !!v);

  const clean = (msg: string): string => scrubText(msg, { values: secretValues() }).slice(0, 300);

  const describe = (err: unknown): string => clean(err instanceof Error ? err.message : String(err));

  // ----- persisted bookkeeping -----

  let tokenMethodCache: TokenMethod | null | undefined;
  const tokenMethod = (): TokenMethod | null => {
    if (tokenMethodCache === undefined) {
      const v = safe(() => repo.getMeta(META_TOKEN_METHOD), null);
      tokenMethodCache = v === 'header' || v === 'query' ? v : null;
    }
    return tokenMethodCache;
  };
  const rememberTokenMethod = (m: TokenMethod): void => {
    if (tokenMethod() === m) return;
    tokenMethodCache = m;
    safe(() => repo.setMeta(META_TOKEN_METHOD, m), undefined);
    log.info(`backpack.tf access token works as ${m === 'header' ? 'the X-Auth-Token header' : 'a query parameter'}; remembered`);
  };

  let unavailable: { status: number; at: UnixMs } | null | undefined;
  const readUnavailable = (): { status: number; at: UnixMs } | null => {
    if (unavailable === undefined) {
      const raw = safe(() => repo.getMeta(META_SNAPSHOT_UNAVAILABLE), null);
      let parsed: { status: number; at: UnixMs } | null = null;
      if (raw) {
        try {
          const r = unavailableSchema.safeParse(JSON.parse(raw));
          parsed = r.success ? r.data : null;
        } catch {
          parsed = null;
        }
      }
      unavailable = parsed;
    }
    return unavailable;
  };
  const markUnavailable = (status: number): void => {
    unavailable = { status, at: clock.now() };
    safe(() => repo.setMeta(META_SNAPSHOT_UNAVAILABLE, JSON.stringify(unavailable)), undefined);
    log.warn(`backpack.tf snapshot endpoint answered HTTP ${status}; snapshots are off, websocket data only`);
  };
  const clearUnavailable = (): void => {
    if (readUnavailable() === null) return;
    unavailable = null;
    safe(() => repo.setMeta(META_SNAPSHOT_UNAVAILABLE, ''), undefined);
  };
  const snapshotAvailable = (): boolean => {
    const u = readUnavailable();
    const now = clock.now();
    // 0.7.3: a stamp in the future (the clock moved back) is due for a probe, like one a day old.
    return u === null || u.at > now || now - u.at >= SNAPSHOT_REPROBE_MS;
  };

  // ----- health bookkeeping -----

  const markOk = (f: Family): void => {
    state[f].lastOkAt = clock.now();
    state[f].rateLimitedUntil = null;
  };
  const markError = (f: Family, err: unknown): void => {
    const s = state[f];
    if (err instanceof NetworkPausedError) return;
    s.lastErrorAt = clock.now();
    s.lastError = describe(err);
    if (err instanceof RateLimitedError) s.rateLimitedUntil = err.retryAt;
  };

  const rejectCredential = (name: CredentialName, value: string, status: number, message: string): BptfCredentialError => {
    const what = name === 'bptfApiKey' ? 'API key' : 'access token';
    const reason = `backpack.tf rejected the ${what} (HTTP ${status}${message ? `: ${clean(message)}` : ''}). Check it in Settings. ${credentialHint(name, value)}`;
    rejected[name] = { fp: fingerprint(value), reason };
    // An earlier acceptance no longer vouches for the key in test().
    if (name === 'bptfApiKey') keyAccepted = null;
    log.warn(reason);
    return new BptfCredentialError(name, status, reason);
  };

  const rejectedReason = (name: CredentialName): string | null => {
    const r = rejected[name];
    if (!r) return null;
    const value = safe(() => deps.secret(name), null);
    if (!value || fingerprint(value) !== r.fp) {
      rejected[name] = null; // the user changed the credential
      return null;
    }
    return r.reason;
  };

  const ensureEnabled = (): void => {
    if (!deps.settings().connectors.bptfApi) throw new BptfNotConfiguredError('The backpack.tf API is turned off in Settings');
  };

  const requireCredential = (name: CredentialName): string => {
    const value = safe(() => deps.secret(name), null);
    if (!value) {
      throw new BptfNotConfiguredError(
        name === 'bptfApiKey' ? 'Add your backpack.tf API key in Settings' : 'Add your backpack.tf access token in Settings',
      );
    }
    const reason = rejectedReason(name);
    if (reason) throw new BptfCredentialError(name, 401, reason);
    return value;
  };

  /** Runs `fn`, recording success or failure for the family; errors are rethrown. */
  const tracked = async <T>(f: Family, fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn();
      markOk(f);
      return out;
    } catch (err) {
      markError(f, err);
      throw err;
    }
  };

  // ----- requests -----

  /**
   * Token-authenticated GET. Tries the remembered method first (X-Auth-Token
   * header, else ?token=), falls back to the other one on 401/403, and
   * remembers whichever succeeds.
   */
  const tokenRequest = async (
    url: string,
    query: Record<string, string | number>,
    opts: { budget: string; priority: 'user' | 'background'; methods?: TokenMethod[]; maxWaitMs?: number; timeoutMs?: number },
  ): Promise<{ res: HttpResponse; method: TokenMethod }> => {
    const token = requireCredential('bptfAccessToken');
    const remembered = tokenMethod();
    const methods: TokenMethod[] =
      opts.methods ?? (remembered === 'query' ? ['query', 'header'] : ['header', 'query']);
    let last: HttpResponse | null = null;
    for (const m of methods) {
      const ropts: HttpRequestOptions = { budget: opts.budget, priority: opts.priority };
      if (opts.maxWaitMs !== undefined) ropts.maxWaitMs = opts.maxWaitMs;
      if (opts.timeoutMs !== undefined) ropts.timeoutMs = opts.timeoutMs;
      if (m === 'header') {
        ropts.query = query;
        ropts.headers = { 'X-Auth-Token': token };
        ropts.secretHeaders = ['X-Auth-Token'];
      } else {
        ropts.query = { ...query, token };
        ropts.secretQuery = ['token'];
      }
      const res = await http.request(url, ropts);
      if (isAuthFailure(res)) {
        last = res;
        continue;
      }
      if (res.ok) rememberTokenMethod(m);
      return { res, method: m };
    }
    throw rejectCredential('bptfAccessToken', token, last?.status ?? 401, last ? responseMessage(last) : '');
  };

  /** Shared handling of a key-authenticated response (IGetPrices, IGetCurrencies). */
  const checkKeyResponse = (res: HttpResponse, key: string, budget: string, url: string): Record<string, unknown> | null => {
    if (isAuthFailure(res)) throw rejectCredential('bptfApiKey', key, res.status, responseMessage(res));
    if (res.status === 429) throw new RateLimitedError(budget, http.nextAllowedAt(budget));
    if (!res.ok) throw new HttpStatusError(res.status, url, clean(responseMessage(res)) || null);
    const d = res.data;
    const inner = isRecord(d) && isRecord(d['response']) ? d['response'] : isRecord(d) ? d : null;
    if (inner && (inner['success'] === 0 || inner['success'] === '0' || inner['success'] === false)) {
      const msg = typeof inner['message'] === 'string' ? inner['message'] : 'request failed';
      if (/\bkey\b/i.test(msg)) throw rejectCredential('bptfApiKey', key, res.status, msg);
      if (/\b(seconds?|rate|too many|every)\b/i.test(msg)) {
        throw new RateLimitedError(budget, Math.max(http.nextAllowedAt(budget), clock.now() + 15 * 60_000));
      }
      throw new Error(`backpack.tf: ${clean(msg)}`);
    }
    // Only now: a 200 with success:0 is no acceptance a key test may repeat.
    keyAccepted = { fp: fingerprint(key), at: clock.now() };
    return inner;
  };

  interface FetchedSnapshot {
    name: string;
    createdAt: UnixSec | null;
    listings: Listing[];
    rawCount: number;
  }

  /** `sku` is the SKU the name was resolved from; it fills SKU fields v1 attributes lack (recipe outputs). */
  const fetchSnapshot = async (name: string, sku: string, priority: 'user' | 'background'): Promise<FetchedSnapshot> => {
    const { res } = await tokenRequest(SNAPSHOT_URL, { sku: name, appid: 440 }, { budget: 'bptf-snapshot', priority });
    if (res.status === 404 || res.status === 410) {
      markUnavailable(res.status);
      throw new BptfSnapshotUnavailableError(`backpack.tf snapshot endpoint answered HTTP ${res.status}; using websocket data only`);
    }
    if (res.status === 429) throw new RateLimitedError('bptf-snapshot', http.nextAllowedAt('bptf-snapshot'));
    if (!res.ok) throw new HttpStatusError(res.status, SNAPSHOT_URL, clean(responseMessage(res)) || null);
    const parsed = snapshotResponseSchema.safeParse(res.data);
    if (!parsed.success) throw new Error('Unexpected snapshot response shape');
    clearUnavailable();
    // bp.tf echoes the name it used; buy-order ids hash exactly that name.
    const usedName = parsed.data.sku && parsed.data.sku.trim() !== '' ? parsed.data.sku.trim() : name;
    const now = clock.now();
    const raws = parsed.data.listings ?? [];
    const listings: Listing[] = [];
    for (const raw of raws) {
      const l = listingFromSnapshot(raw, schema, now, usedName, mapStats, sku);
      if (l) listings.push(l);
    }
    return { name: usedName, createdAt: toSec(parsed.data.createdAt), listings, rawCount: raws.length };
  };

  const resolveName = (sku: string): { name: string; learned: boolean } => {
    const fromFeed =
      safe(() => repo.getBptfName(sku)?.name ?? null, null) ?? safe(() => repo.getBptfName(baseSku(sku))?.name ?? null, null);
    if (fromFeed && fromFeed.trim() !== '') return { name: fromFeed.trim(), learned: true };
    // bp.tf names never carry paint, so name the base SKU (schema names add "(Paint: X)").
    const fromSchema = safe(() => schema.nameForSku(baseSku(sku)), '');
    if (!fromSchema || fromSchema.trim() === '' || looksLikeSku(fromSchema)) {
      throw new Error(`No backpack.tf item name is known for ${sku}`);
    }
    return { name: fromSchema.trim(), learned: false };
  };

  const remember = (key: string, result: SnapshotResult): void => {
    cache.set(key, { at: clock.now(), result });
    while (cache.size > SNAPSHOT_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const snapshotUncached = async (sku: string, name: string, learned: boolean, priority: 'user' | 'background'): Promise<SnapshotResult> => {
    let got = await fetchSnapshot(name, sku, priority);
    if (got.rawCount === 0) {
      const alt = alternateTheName(name);
      if (alt) {
        const second = await fetchSnapshot(alt, sku, priority);
        if (second.rawCount > 0) {
          got = second;
          if (!learned) {
            safe(
              () => repo.upsertBptfNames([{ sku: baseSku(sku), name: second.name, marketName: null, lastSeen: clock.now() }]),
              undefined,
            );
          }
        }
      }
    }
    const result: SnapshotResult = { name: got.name, createdAt: got.createdAt, listings: got.listings };
    remember(name, result);
    safe(() => repo.setSnapshotAt(sku, clock.now()), undefined);
    return result;
  };

  /**
   * Snapshot v1 rows carry no `user` object, but their ids are the feed's
   * (440_<steamid>_<md5(name)>, 440_<assetid>) and core upserts them over the
   * stored rows. Keep what the feed learned about the user so a snapshot never
   * clears a ban flag (§5.2) or blanks names; a later feed update still can.
   * Runs on every call (cached results too), against the rows stored right now.
   */
  const withStoredUserData = (result: SnapshotResult): SnapshotResult => {
    let changed = false;
    const listings = result.listings.map((l) => {
      const old = safe(() => repo.getListing(l.id), null);
      if (!old || old.steamid !== l.steamid) return l;
      const merged: Listing = {
        ...l,
        userBanned: l.userBanned || old.userBanned,
        userOnline: l.userOnline ?? old.userOnline,
        userName: l.userName ?? old.userName,
        marketName: l.marketName ?? old.marketName,
      };
      const same =
        merged.userBanned === l.userBanned &&
        merged.userOnline === l.userOnline &&
        merged.userName === l.userName &&
        merged.marketName === l.marketName;
      if (same) return l;
      changed = true;
      return merged;
    });
    return changed ? { ...result, listings } : result;
  };

  // ----- public API -----

  const api: BptfApi & { mapStats(): BptfMapStats } = {
    async snapshot(sku: string, priority: 'user' | 'background' = 'background'): Promise<SnapshotResult> {
      // Configuration and name problems are not endpoint failures, so they stay out of health.
      ensureEnabled();
      if (!snapshotAvailable()) {
        const u = readUnavailable();
        throw new BptfSnapshotUnavailableError(`backpack.tf snapshot endpoint answered HTTP ${u?.status ?? 404}; using websocket data only`);
      }
      const { name, learned } = resolveName(sku);
      const hit = cache.get(name);
      const now = clock.now();
      // 0.7.3: an entry cached in the future (the clock moved back) has no known age: fetched again, not served.
      if (hit && hit.at <= now && now - hit.at < SNAPSHOT_CACHE_MS) return withStoredUserData(hit.result);
      const running = inflight.get(name);
      if (running) return withStoredUserData(await running);
      const p = tracked('snapshot', () => snapshotUncached(sku, name, learned, priority)).finally(() => inflight.delete(name));
      inflight.set(name, p);
      try {
        return withStoredUserData(await p);
      } catch (err) {
        // rejectCredential already warned once; a remembered rejection is not news.
        if (!(err instanceof RateLimitedError) && !(err instanceof NetworkPausedError) && !(err instanceof BptfCredentialError)) {
          log.warn(`backpack.tf snapshot for "${name}" failed: ${describe(err)}`);
        }
        throw err;
      }
    },

    async prices(since?: UnixSec | null): Promise<{ rows: CommunityRow[]; currentTime: UnixSec }> {
      return tracked('prices', async () => {
        ensureEnabled();
        const key = requireCredential('bptfApiKey');
        const sinceSec = typeof since === 'number' && Number.isInteger(since) && since > 0 ? since : undefined;
        const res = await http.request(PRICES_URL, {
          query: { key, raw: 1, since: sinceSec },
          secretQuery: ['key'],
          budget: 'bptf-prices',
          priority: 'background',
          timeoutMs: PRICES_TIMEOUT_MS,
        });
        checkKeyResponse(res, key, 'bptf-prices', PRICES_URL);
        const parsed = parseIGetPrices(res.data, schema);
        if (parsed.skipped > 0) log.debug(`IGetPrices: ${parsed.skipped} price entries could not be mapped to a SKU`);
        return { rows: parsed.rows, currentTime: parsed.currentTime ?? Math.floor(clock.now() / 1000) };
      });
    },

    async currencies(): Promise<KeyPriceQuote | null> {
      return tracked('currencies', async () => {
        ensureEnabled();
        const key = requireCredential('bptfApiKey');
        const res = await http.request(CURRENCIES_URL, {
          query: { key, raw: 1 },
          secretQuery: ['key'],
          budget: 'bptf-currencies',
          priority: 'background',
        });
        checkKeyResponse(res, key, 'bptf-currencies', CURRENCIES_URL);
        const quote = parseIGetCurrencies(res.data, clock.now());
        if (!quote) log.warn('IGetCurrencies: no metal-priced key entry in the response');
        return quote;
      });
    },

    async usersInfo(
      steamids: string[],
      opts: { priority?: 'user' | 'background' } = {},
    ): Promise<Map<string, { banned: boolean; name: string | null; banDetails: string[] }>> {
      return tracked('users', async () => {
        ensureEnabled();
        const priority = opts.priority === 'user' ? 'user' : 'background';
        const out = new Map<string, { banned: boolean; name: string | null; banDetails: string[] }>();
        const ids = [...new Set(steamids.map((s) => String(s).trim()).filter((s) => /^\d{17}$/.test(s)))];
        for (let i = 0; i < ids.length; i += USERS_BATCH_SIZE) {
          const chunk = ids.slice(i, i + USERS_BATCH_SIZE);
          // A click waits at most USERS_USER_MAX_WAIT_MS for the 10 s budget slot, then says when to retry,
          // and stops waiting for the answer early enough to report it inside main's RPC timeout.
          const { res } = await tokenRequest(
            USERS_URL,
            { steamids: chunk.join(',') },
            {
              budget: 'bptf-users',
              priority,
              ...(priority === 'user' ? { maxWaitMs: USERS_USER_MAX_WAIT_MS, timeoutMs: USERS_USER_TIMEOUT_MS } : {}),
            },
          );
          if (res.status === 429) throw new RateLimitedError('bptf-users', http.nextAllowedAt('bptf-users'));
          if (!res.ok) throw new HttpStatusError(res.status, USERS_URL, clean(responseMessage(res)) || null);
          const users = isRecord(res.data) ? res.data['users'] : undefined;
          const entries: [string, unknown][] = Array.isArray(users)
            ? users.map((u): [string, unknown] => [isRecord(u) && u['steamid'] !== undefined ? String(u['steamid']) : '', u])
            : isRecord(users)
              ? Object.entries(users)
              : [];
          for (const [sid, raw] of entries) {
            const u = usersUserSchema.safeParse(raw);
            if (!u.success) continue;
            const steamid = u.data.steamid !== undefined ? String(u.data.steamid) : sid;
            if (!/^\d{17}$/.test(steamid)) continue;
            out.set(steamid, { banned: isBannedFromBans(u.data.bans), name: u.data.name ?? null, banDetails: banDetailsFromBans(u.data.bans) });
          }
        }
        return out;
      });
    },

    async test(name: CredentialName): Promise<{ ok: boolean; message: string }> {
      const value = safe(() => deps.secret(name), null);
      if (!value) {
        return { ok: false, message: name === 'bptfApiKey' ? 'No backpack.tf API key is set.' : 'No backpack.tf access token is set.' };
      }
      // A user-initiated test gets a fresh request; only a passing test (or a new rejection) changes the verdict.
      const prev = rejected[name];
      rejected[name] = null;
      const outcome = await (async (): Promise<{ ok: boolean; message: string }> => {
        try {
          if (name === 'bptfApiKey') {
            // IGetCurrencies allows 3 calls per hour, 5 min apart; the scheduled key-price job may
            // have used the slot moments ago. Do not queue behind it: answer from the last result.
            const now = clock.now();
            const nextAt = http.nextAllowedAt('bptf-currencies');
            if (nextAt - now > TEST_MAX_WAIT_MS) {
              if (keyAccepted && keyAccepted.fp === fingerprint(value) && now - keyAccepted.at < 2 * 3_600_000) {
                return { ok: true, message: `API key works: backpack.tf accepted it ${formatAgo(now - keyAccepted.at)}.` };
              }
              return {
                ok: false,
                message: `The backpack.tf key-price endpoint was used recently (at most 1 call per 5 min). Test again after ${new Date(nextAt).toLocaleTimeString()}.`,
              };
            }
            const quote = await tracked('currencies', async () => {
              const res = await http.request(CURRENCIES_URL, {
                query: { key: value, raw: 1 },
                secretQuery: ['key'],
                budget: 'bptf-currencies',
                priority: 'user',
                maxWaitMs: TEST_MAX_WAIT_MS,
              });
              checkKeyResponse(res, value, 'bptf-currencies', CURRENCIES_URL);
              return parseIGetCurrencies(res.data, clock.now());
            });
            return {
              ok: true,
              message: quote
                ? `API key works. Key price ${scrapToRef(quote.buyScrap ?? 0).toFixed(2)}-${scrapToRef(quote.sellScrap ?? 0).toFixed(2)} ref.`
                : 'API key works.',
            };
          }
          const result = await tracked('snapshot', async () => {
            const { res, method } = await tokenRequest(
              SNAPSHOT_URL,
              { sku: TOKEN_TEST_ITEM, appid: 440 },
              { budget: 'bptf-snapshot', priority: 'user', methods: ['header', 'query'], maxWaitMs: TEST_MAX_WAIT_MS },
            );
            if (res.status === 404 || res.status === 410) {
              markUnavailable(res.status);
              throw new BptfSnapshotUnavailableError(
                `The snapshot endpoint answered HTTP ${res.status}, so the token could not be checked there.`,
              );
            }
            if (res.status === 429) throw new RateLimitedError('bptf-snapshot', http.nextAllowedAt('bptf-snapshot'));
            if (!res.ok) throw new HttpStatusError(res.status, SNAPSHOT_URL, clean(responseMessage(res)) || null);
            clearUnavailable();
            const parsed = snapshotResponseSchema.safeParse(res.data);
            return { method, count: parsed.success ? (parsed.data.listings?.length ?? 0) : 0 };
          });
          const how = result.method === 'header' ? 'the X-Auth-Token header' : 'a token query parameter';
          return { ok: true, message: `Access token works (sent as ${how}). ${result.count} listings for ${TOKEN_TEST_ITEM}.` };
        } catch (err) {
          if (err instanceof BptfCredentialError) return { ok: false, message: err.message };
          if (err instanceof RateLimitedError) {
            // 0.7.3: timed out behind another request on the host; retryAt is only the failure time.
            if (err.busy) {
              return { ok: false, message: 'backpack.tf is busy with another Flip Desk request (such as the price list download); test again in a moment.' };
            }
            return { ok: false, message: `Rate limited; try again after ${new Date(err.retryAt).toLocaleTimeString()}.` };
          }
          if (err instanceof HttpStatusError) return { ok: false, message: `backpack.tf answered HTTP ${err.status}.` };
          return { ok: false, message: describe(err) };
        }
      })();
      // 0.7.3: a test that sent nothing ("used recently"), or ended busy, rate limited or failed, checked
      // nothing, so the jobs parked on the rejection stay parked; a rejection it recorded itself is kept.
      if (!outcome.ok && rejected[name] === null && prev && prev.fp === fingerprint(value)) rejected[name] = prev;
      return outcome;
    },

    snapshotAvailable,

    credentialRejected: rejectedReason,

    health(): ConnectorHealth[] {
      const now = clock.now();
      const settingsOn = safe(() => deps.settings().connectors.bptfApi, true);
      const hostReason = safe(() => http.hostBlocked('api.backpack.tf'), null);
      const paused = safe(() => http.isPaused(), false);
      return FAMILIES.map(({ family, id, label, secret }) => {
        const s = state[family];
        let st: ConnState;
        let detail: string;
        let disabledReason: string | null = null;
        const hasSecret = !!safe(() => deps.secret(secret), null);
        const credReason = rejectedReason(secret);
        if (!settingsOn) {
          st = 'off';
          detail = 'Turned off in Settings';
        } else if (!hasSecret) {
          st = 'off';
          detail = secret === 'bptfApiKey' ? 'Needs your backpack.tf API key' : 'Needs your backpack.tf access token';
        } else if (credReason) {
          st = 'blocked';
          detail = credReason;
          disabledReason = credReason;
        } else if (family === 'snapshot' && !snapshotAvailable()) {
          const u = readUnavailable();
          st = 'blocked';
          detail = `Endpoint answered HTTP ${u?.status ?? 404}; websocket data only`;
          disabledReason = `The snapshot endpoint answered HTTP ${u?.status ?? 404} and looks removed; retried once a day.`;
        } else if (paused) {
          st = 'paused';
          detail = 'Network is paused';
        } else if (hostReason) {
          st = 'blocked';
          detail = hostReason;
          disabledReason = hostReason;
        } else if (s.rateLimitedUntil !== null && now < s.rateLimitedUntil) {
          st = 'backoff';
          detail = `Rate limited until ${new Date(s.rateLimitedUntil).toLocaleTimeString()}`;
        } else if (s.lastErrorAt !== null && (s.lastOkAt === null || s.lastErrorAt > s.lastOkAt)) {
          st = 'error';
          detail = s.lastError ?? 'Last request failed';
        } else {
          st = 'idle';
          detail = s.lastOkAt !== null ? `Last success ${formatAgo(now - s.lastOkAt)}` : 'Ready';
        }
        return { id, label, state: st, detail, lastOkAt: s.lastOkAt, lastErrorAt: s.lastErrorAt, lastError: s.lastError, disabledReason };
      });
    },

    mapStats(): BptfMapStats {
      return { ...mapStats, unknownShapes: { ...mapStats.unknownShapes } };
    },
  };
  return api;
}
