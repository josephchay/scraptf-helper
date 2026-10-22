// Optional Steam Community Market priceoverview, on click only (DESIGN_BRIEF §2.11).
// Off by default (Settings.connectors.scm). Results are cached for 60 min; a 429
// locks the connector out for 6 h, persisted so a restart does not retry early.
// pricehistory is never called (it needs cookies).

import { z } from 'zod';
import type { ConnState, ConnectorHealth, UnixMs } from '../../shared/types';
import type { ServiceDeps, SteamMarket } from '../contracts';
import { HostBlockedError, HttpStatusError, NetworkPausedError, RateLimitedError } from '../net';

export const SCM_PRICEOVERVIEW_URL = 'https://steamcommunity.com/market/priceoverview/';
export const SCM_CACHE_MS = 60 * 60 * 1000;
export const SCM_LOCKOUT_MS = 6 * 60 * 60 * 1000;
export const META_SCM_LOCKED_UNTIL = 'scm.lockedUntil';

const CACHE_MAX = 500;
const NAME_MAX = 300;

const overviewSchema = z.looseObject({
  success: z.boolean(),
  lowest_price: z.string().nullish().catch(null),
  median_price: z.string().nullish().catch(null),
  volume: z
    .union([z.string(), z.number().transform(String)])
    .nullish()
    .catch(null),
});

export interface PriceOverview {
  lowest: string | null;
  median: string | null;
  volume: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 0.7.4 (F52): priceoverview's answer for a name with no market listing, HTTP 500 with a JSON {"success":false}
 * (HttpRequestOptions.isAnswer). The same rule fetchOverview caches as "no listing"; any other 5xx is an outage.
 */
export function unknownItemAnswer(status: number, data: unknown): boolean {
  if (status !== 500) return false;
  const parsed = overviewSchema.safeParse(data);
  return parsed.success && !parsed.data.success;
}

export function createSteamMarket(deps: ServiceDeps): SteamMarket {
  const { clock, log, repo, http } = deps;
  const cache = new Map<string, { at: UnixMs; value: PriceOverview }>();
  const inflight = new Map<string, Promise<PriceOverview | null>>();

  let lockedUntil: UnixMs = 0;
  try {
    const stored = Number(repo.getMeta(META_SCM_LOCKED_UNTIL) ?? 0);
    if (Number.isFinite(stored)) lockedUntil = stored;
  } catch {
    lockedUntil = 0;
  }

  let errorState: ConnState | null = null;
  let lastOkAt: UnixMs | null = null;
  let lastErrorAt: UnixMs | null = null;
  let lastError: string | null = null;

  const enabled = (): boolean => deps.settings().connectors.scm;

  const markOk = (): void => {
    lastOkAt = clock.now();
    errorState = null;
  };

  const markError = (err: unknown, state: ConnState = 'error'): void => {
    lastErrorAt = clock.now();
    lastError = errorMessage(err);
    errorState = state;
    log.warn(`Steam Market priceoverview failed: ${lastError}`);
  };

  const saveLockout = (): void => {
    try {
      repo.setMeta(META_SCM_LOCKED_UNTIL, String(lockedUntil));
    } catch {
      // the in-memory lockout still applies
    }
  };

  const lockOut = (): void => {
    lockedUntil = clock.now() + SCM_LOCKOUT_MS;
    saveLockout();
    markError(new Error(`HTTP 429: locked out until ${new Date(lockedUntil).toISOString()}`), 'backoff');
  };

  /**
   * True while the 429 lockout holds. 0.7.3: one set (or stored) before the wall clock stepped back keeps at
   * most its own 6 h from now, and is saved clamped so a restart does not restore the stretched one.
   */
  const lockedOut = (now: UnixMs): boolean => {
    if (lockedUntil - now > SCM_LOCKOUT_MS) {
      lockedUntil = now + SCM_LOCKOUT_MS;
      saveLockout();
    }
    return lockedUntil > now;
  };

  const remember = (key: string, value: PriceOverview): void => {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: clock.now(), value });
  };

  const fetchOverview = async (key: string): Promise<PriceOverview | null> => {
    try {
      const res = await http.request<unknown>(SCM_PRICEOVERVIEW_URL, {
        query: { appid: 440, currency: 1, market_hash_name: key },
        budget: 'scm',
        priority: 'user',
        maxWaitMs: 15_000,
        // 0.7.4 (F52): Steam's "no listing under that name" is a 500 with {"success":false}, an answer about this
        // item, not an outage, so it does not pause the scm budget for every other item. Any other 5xx still does.
        isAnswer: unknownItemAnswer,
      });
      if (res.status === 429) {
        lockOut();
        return null;
      }
      const parsed = overviewSchema.safeParse(res.data);
      // Unknown names come back as {"success":false}, sometimes with HTTP 500.
      if (parsed.success && (res.ok || (res.status === 500 && !parsed.data.success))) {
        const d = parsed.data;
        const value: PriceOverview = d.success
          ? { lowest: d.lowest_price ?? null, median: d.median_price ?? null, volume: d.volume ?? null }
          : { lowest: null, median: null, volume: null };
        remember(key, value);
        markOk();
        return value;
      }
      markError(res.ok ? new Error('unexpected priceoverview response') : new HttpStatusError(res.status, SCM_PRICEOVERVIEW_URL, res.text));
      return null;
    } catch (err) {
      if (err instanceof HostBlockedError) markError(err, 'blocked');
      else if (err instanceof NetworkPausedError) markError(err, 'paused');
      else if (err instanceof RateLimitedError) markError(err, 'backoff');
      else markError(err);
      return null;
    }
  };

  const priceOverview = async (marketHashName: string): Promise<PriceOverview | null> => {
    if (!enabled()) return null;
    const key = String(marketHashName ?? '').trim();
    if (!key || key.length > NAME_MAX) return null;
    const now = clock.now();
    if (lockedOut(now)) return null;
    const hit = cache.get(key);
    // 0.7.3: an entry cached in the future (the clock moved back) has no known age: fetched again, not served.
    if (hit && hit.at <= now && now - hit.at < SCM_CACHE_MS) return hit.value;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = fetchOverview(key).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  const health = (): ConnectorHealth => {
    const now = clock.now();
    let state: ConnState = 'idle';
    let detail = `On click only; ${cache.size} cached`;
    let disabledReason: string | null = null;
    if (!enabled()) {
      state = 'off';
      detail = 'Off (enable in Settings; used on click only)';
    } else if (lockedOut(now)) {
      state = 'backoff';
      disabledReason = `Steam returned 429; paused until ${new Date(lockedUntil).toISOString()}`;
      detail = disabledReason;
    } else if (errorState && lastErrorAt !== null && (lastOkAt === null || lastErrorAt >= lastOkAt)) {
      state = errorState === 'backoff' ? 'idle' : errorState;
    }
    return { id: 'scm', label: 'Steam Community Market', state, detail, lastOkAt, lastErrorAt, lastError, disabledReason };
  };

  return { priceOverview, health };
}
