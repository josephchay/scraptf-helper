// 'buyer.check' (feature F3): backpack.tf ban lookup for one buyer, made only
// when the user clicks "Check bans" in the drawer's order book. One users/info
// request on the existing 'bptf-users' budget (src/service/net), cached in
// memory for an hour so repeated clicks cost nothing.

import type { BuyerCheck, SecretName, Settings, UnixMs } from '../shared/types';
import { BptfCredentialError, BptfNotConfiguredError } from './connectors/bptfApi';
import type { BptfApi, Clock, HttpClient, Logger } from './contracts';
import { ForbiddenHostError, HostBlockedError, HttpStatusError, HttpTimeoutError, NetworkPausedError, RateLimitedError, scrubText } from './net';

export const BUYER_CHECK_CACHE_MS = 60 * 60_000;
export const NO_TOKEN_MESSAGE = 'Add a backpack.tf access token in Settings';
export const API_OFF_MESSAGE = 'The backpack.tf API is turned off in Settings.';
export const PAUSED_MESSAGE = 'The network is paused. Resume it from the top bar first.';
/** 0.7.3: the lookup timed out behind another backpack.tf request (RateLimitedError.busy), so there is no slot time to give. */
export const BUSY_MESSAGE = 'backpack.tf is busy with another Flip Desk request (such as the price list download); try again in a moment.';
/** Buyers remembered at once; the oldest answer goes first. A drawer session checks a handful. */
export const BUYER_CHECK_CACHE_MAX = 500;

const BPTF_API_HOST = 'api.backpack.tf';

export interface BuyerCheckDeps {
  bptfApi: Pick<BptfApi, 'usersInfo'>;
  http: Pick<HttpClient, 'isPaused' | 'hostBlocked'>;
  clock: Clock;
  log: Logger;
  settings(): Settings;
  secret(name: SecretName): string | null;
}

export interface BuyerChecker {
  /**
   * Never rejects for an expected failure (no token, API off, network paused,
   * host blocked, 429, HTTP error): the result's `error` says why and
   * `bptfBanned` is null. `steamid` is a validated SteamID64.
   */
  check(steamid: string): Promise<BuyerCheck>;
}

export function createBuyerChecker(deps: BuyerCheckDeps): BuyerChecker {
  const { bptfApi, http, clock, log } = deps;
  /** Successful lookups only: a failure is never cached, so the next click tries again (within the budget). */
  const cache = new Map<string, BuyerCheck>();
  /** Double clicks share one request. */
  const inflight = new Map<string, Promise<BuyerCheck>>();

  const token = (): string | null => {
    try {
      return deps.secret('bptfAccessToken');
    } catch {
      return null;
    }
  };

  const failed = (steamid: string, error: string): BuyerCheck => ({
    steamid,
    name: null,
    bptfBanned: null,
    banDetails: [],
    checkedAt: clock.now(),
    cached: false,
    error,
  });

  const fromCache = (steamid: string, now: UnixMs): BuyerCheck | null => {
    const hit = cache.get(steamid);
    if (!hit) return null;
    // A clock that went backwards counts as expired too.
    if (now - hit.checkedAt >= BUYER_CHECK_CACHE_MS || now < hit.checkedAt) {
      cache.delete(steamid);
      return null;
    }
    return { ...hit, banDetails: [...hit.banDetails], cached: true };
  };

  const remember = (r: BuyerCheck): void => {
    cache.delete(r.steamid);
    cache.set(r.steamid, r);
    while (cache.size > BUYER_CHECK_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  /** A plain message for the drawer; secrets are scrubbed even though the connector already cleans its own. */
  const describe = (err: unknown): string => {
    const now = clock.now();
    if (err instanceof RateLimitedError) {
      if (err.busy) return BUSY_MESSAGE;
      const s = Math.max(1, Math.ceil((err.retryAt - now) / 1000));
      return `backpack.tf user lookups are rate limited; try again in ${s} s.`;
    }
    if (err instanceof NetworkPausedError) return PAUSED_MESSAGE;
    if (err instanceof HostBlockedError) return `backpack.tf requests are disabled: ${err.reason}`;
    if (err instanceof HttpStatusError) return `backpack.tf answered HTTP ${err.status}.`;
    if (err instanceof HttpTimeoutError) return 'backpack.tf did not answer in time. Try again later.';
    if (err instanceof BptfNotConfiguredError || err instanceof BptfCredentialError || err instanceof ForbiddenHostError) {
      return err.message;
    }
    const raw = err instanceof Error ? err.message : String(err);
    const t = token();
    return `The ban check failed: ${scrubText(raw, { values: t ? [t] : [] }).slice(0, 200)}`;
  };

  const lookup = async (steamid: string): Promise<BuyerCheck> => {
    try {
      const users = await bptfApi.usersInfo([steamid], { priority: 'user' });
      const u = users.get(steamid);
      if (!u) return failed(steamid, 'backpack.tf has no user data for this SteamID64.');
      const r: BuyerCheck = {
        steamid,
        name: u.name,
        bptfBanned: u.banned,
        banDetails: [...(u.banDetails ?? [])],
        checkedAt: clock.now(),
        cached: false,
        error: null,
      };
      remember(r);
      return r;
    } catch (err) {
      const msg = describe(err);
      log.info(`buyer ban check failed: ${msg}`);
      return failed(steamid, msg);
    }
  };

  return {
    async check(steamid) {
      const id = String(steamid ?? '').trim();
      if (!/^\d{17}$/.test(id)) return failed(id.slice(0, 32), 'Not a SteamID64 (17 digits).');
      // A cached answer costs no request, so it is served even while paused.
      const hit = fromCache(id, clock.now());
      if (hit) return hit;

      const s = deps.settings();
      if (!token()) return failed(id, NO_TOKEN_MESSAGE);
      if (!s.connectors.bptfApi) return failed(id, API_OFF_MESSAGE);
      if (s.networkPaused || http.isPaused()) return failed(id, PAUSED_MESSAGE);
      const blocked = http.hostBlocked(BPTF_API_HOST);
      if (blocked) return failed(id, `backpack.tf requests are disabled: ${blocked}`);

      const running = inflight.get(id);
      if (running) return running;
      const p = lookup(id).finally(() => inflight.delete(id));
      inflight.set(id, p);
      return p;
    },
  };
}
