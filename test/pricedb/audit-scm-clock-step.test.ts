// 0.7.3 follow-up (r4-clock-3): the Steam Market priceoverview cache (60 min) and the 6 h lockout after a 429
// are wall-clock stamps. A clock stepped back while running served a cached reading as fresh for the size of
// the step plus 60 min, and stretched the lockout by the step (across restarts too). A cached entry stamped in
// the future now has no known age and is fetched again; the lockout keeps at most its own 6 h from when the step
// is noticed, and the clamped value is saved. Fake clock and HTTP; nothing is fetched.

import { describe, expect, it } from 'vitest';
import { META_SCM_LOCKED_UNTIL, SCM_LOCKOUT_MS, createSteamMarket } from '../../src/service/connectors/steamMarket';
import { openRepo } from '../../src/service/db';
import { FakeClock, T0, makeDeps, res } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const OK = { success: true, lowest_price: '$2.14', volume: '54,396', median_price: '$2.16' };

function setup(route = () => res(OK), clock = new FakeClock(), repo = openRepo(':memory:')) {
  const deps = makeDeps(route, { clock, repo, settings: { connectors: { scm: true } } });
  return { deps, scm: createSteamMarket(deps), clock, repo };
}

describe('Steam Market after the wall clock stepped back', () => {
  it('fetches a reading cached in the future again, then caches it anew', async () => {
    const { deps, scm, clock } = setup();
    await scm.priceOverview('Hat');
    expect(deps.http.calls).toHaveLength(1);
    clock.advance(10 * MIN);
    clock.advance(-8 * HOUR);
    await scm.priceOverview('Hat');
    expect(deps.http.calls).toHaveLength(2);
    clock.advance(MIN);
    await scm.priceOverview('Hat');
    expect(deps.http.calls).toHaveLength(2);
  });

  it('keeps a 429 lockout at most 6 h from when the step is noticed, and saves it so', async () => {
    let status = 429;
    const { deps, scm, clock, repo } = setup(() => (status === 429 ? res(null, { status: 429 }) : res(OK)));
    expect(await scm.priceOverview('Hat')).toBeNull();
    status = 200;
    clock.advance(HOUR);
    clock.advance(-24 * HOUR);
    expect(await scm.priceOverview('Hat')).toBeNull();
    expect(deps.http.calls).toHaveLength(1);
    expect(scm.health().disabledReason).toContain(new Date(clock.now() + SCM_LOCKOUT_MS).toISOString());
    expect(Number(repo.getMeta(META_SCM_LOCKED_UNTIL))).toBe(clock.now() + SCM_LOCKOUT_MS);
    clock.advance(SCM_LOCKOUT_MS);
    expect(await scm.priceOverview('Hat')).not.toBeNull();
    expect(deps.http.calls).toHaveLength(2);
  });

  it('a restart clamps a stored lockout further ahead than 6 h', async () => {
    const repo = openRepo(':memory:');
    repo.setMeta(META_SCM_LOCKED_UNTIL, String(T0 + 30 * HOUR));
    const { deps, scm, clock } = setup(undefined, new FakeClock(), repo);
    expect(await scm.priceOverview('Hat')).toBeNull();
    expect(Number(repo.getMeta(META_SCM_LOCKED_UNTIL))).toBe(T0 + SCM_LOCKOUT_MS);
    clock.advance(SCM_LOCKOUT_MS);
    expect(await scm.priceOverview('Hat')).not.toBeNull();
    expect(deps.http.calls).toHaveLength(1);
  });
});
