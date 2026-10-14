import { describe, expect, it } from 'vitest';
import {
  META_SCM_LOCKED_UNTIL,
  SCM_CACHE_MS,
  SCM_LOCKOUT_MS,
  SCM_PRICEOVERVIEW_URL,
  createSteamMarket,
} from '../../src/service/connectors/steamMarket';
import { openRepo } from '../../src/service/db';
import { HostBlockedError, RateLimitedError } from '../../src/service/net';
import { FakeClock, T0, makeDeps, res } from './helpers';

const OK = { success: true, lowest_price: '$2.14', volume: '54,396', median_price: '$2.16' };

function setup(route = () => res(OK), scm = true, clock = new FakeClock(), repo = openRepo(':memory:')) {
  const deps = makeDeps(route, { clock, repo, settings: { connectors: { scm } } });
  return { deps, scm: createSteamMarket(deps), clock };
}

describe('SteamMarket.priceOverview', () => {
  it('is off by default and never sends a request then', async () => {
    const { deps, scm } = setup(undefined, false);
    expect(await scm.priceOverview('The Team Captain')).toBeNull();
    expect(deps.http.calls).toHaveLength(0);
    expect(scm.health()).toMatchObject({ id: 'scm', state: 'off' });
  });

  it('fetches priceoverview with the scm budget and caches it for 60 minutes', async () => {
    const { deps, scm, clock } = setup();
    expect(await scm.priceOverview('Mann Co. Supply Crate Key')).toEqual({ lowest: '$2.14', median: '$2.16', volume: '54,396' });
    expect(deps.http.calls[0]).toEqual({
      url: SCM_PRICEOVERVIEW_URL,
      opts: {
        query: { appid: 440, currency: 1, market_hash_name: 'Mann Co. Supply Crate Key' },
        budget: 'scm',
        priority: 'user',
        maxWaitMs: 15_000,
      },
    });
    clock.advance(SCM_CACHE_MS - 1);
    await scm.priceOverview('Mann Co. Supply Crate Key');
    expect(deps.http.calls).toHaveLength(1);
    clock.advance(1);
    await scm.priceOverview('Mann Co. Supply Crate Key');
    expect(deps.http.calls).toHaveLength(2);
    expect(scm.health()).toMatchObject({ state: 'idle', lastOkAt: clock.now() });
  });

  it('shares one request for concurrent clicks', async () => {
    const { deps, scm } = setup();
    const [a, b] = await Promise.all([scm.priceOverview('Hat'), scm.priceOverview('Hat')]);
    expect(a).toEqual(b);
    expect(deps.http.calls).toHaveLength(1);
  });

  it('caches "no listing" answers (success:false, even with HTTP 500)', async () => {
    const { deps, scm } = setup(() => res({ success: false }, { status: 500 }));
    expect(await scm.priceOverview('Not An Item')).toEqual({ lowest: null, median: null, volume: null });
    await scm.priceOverview('Not An Item');
    expect(deps.http.calls).toHaveLength(1);
  });

  it('locks itself out for 6 hours after a 429, across restarts', async () => {
    const repo = openRepo(':memory:');
    const clock = new FakeClock();
    let status = 429;
    const route = () => (status === 429 ? res(null, { status: 429 }) : res(OK));
    const { deps, scm } = setup(route, true, clock, repo);
    expect(await scm.priceOverview('Hat')).toBeNull();
    expect(Number(repo.getMeta(META_SCM_LOCKED_UNTIL))).toBe(T0 + SCM_LOCKOUT_MS);
    const h = scm.health();
    expect(h.state).toBe('backoff');
    expect(h.disabledReason).toContain('429');

    status = 200;
    expect(await scm.priceOverview('Other Hat')).toBeNull();
    expect(deps.http.calls).toHaveLength(1);

    // A new instance (app restart) honours the stored lockout.
    const restarted = setup(route, true, clock, repo);
    expect(await restarted.scm.priceOverview('Hat')).toBeNull();
    expect(restarted.deps.http.calls).toHaveLength(0);

    clock.advance(SCM_LOCKOUT_MS);
    expect(await restarted.scm.priceOverview('Hat')).toEqual({ lowest: '$2.14', median: '$2.16', volume: '54,396' });
    expect(restarted.scm.health().state).toBe('idle');
  });

  it('returns null on network errors and unexpected payloads', async () => {
    const blocked = setup(() => {
      throw new HostBlockedError('steamcommunity.com', 'challenge page');
    });
    expect(await blocked.scm.priceOverview('Hat')).toBeNull();
    expect(blocked.scm.health().state).toBe('blocked');

    const limited = setup(() => {
      throw new RateLimitedError('scm', T0 + 60_000);
    });
    expect(await limited.scm.priceOverview('Hat')).toBeNull();

    const odd = setup(() => res('<html>'));
    expect(await odd.scm.priceOverview('Hat')).toBeNull();
    expect(odd.scm.health()).toMatchObject({ state: 'error', lastError: 'unexpected priceoverview response' });
  });

  it('ignores empty or absurd names', async () => {
    const { deps, scm } = setup();
    expect(await scm.priceOverview('   ')).toBeNull();
    expect(await scm.priceOverview('x'.repeat(301))).toBeNull();
    expect(deps.http.calls).toHaveLength(0);
  });
});
