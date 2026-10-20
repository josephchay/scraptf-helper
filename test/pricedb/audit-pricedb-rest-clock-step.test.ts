// 0.7.3 follow-up (r4-clock-1): PriceDB's REST waits are deadlines on the wall clock. A clock stepped back while
// running stretched them by the size of the step: an item PriceDB did not know stayed "not on PriceDB" (no
// request) for the step plus 30 min, and a RateLimit-Remaining pause showed as paused and made every request
// sleep 65 s for as long. Like the HTTP budgets' pauses, each now keeps at most its own length from the moment
// the step is noticed. Fake clock and HTTP; nothing is fetched.

import { describe, expect, it } from 'vitest';
import { createPriceDb } from '../../src/service/connectors/pricedb';
import { FakeClock, FakeTimers, flush, makeDeps, res } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;

function rec(sku: string) {
  return { sku, name: `Item ${sku}`, time: 1_791_960_000, buy: { keys: 0, metal: 1 }, sell: { keys: 0, metal: 2 } };
}

describe('PriceDB REST waits after the wall clock stepped back', () => {
  it('remembers an unknown item for at most 30 min from when the step is noticed', async () => {
    const deps = makeDeps(() => res({ error: 'Item not found' }, { status: 404 }));
    const pdb = createPriceDb(deps);
    expect(await pdb.item('5021;6')).toBeNull();
    const sent = deps.http.calls.length;
    expect(sent).toBeGreaterThan(0);

    deps.clock.advance(10 * MIN);
    deps.clock.advance(-8 * HOUR);
    // Still remembered (no request), but no longer for the 8 h of the step.
    expect(await pdb.item('5021;6')).toBeNull();
    expect(deps.http.calls).toHaveLength(sent);
    deps.clock.advance(30 * MIN - 1);
    await pdb.item('5021;6');
    expect(deps.http.calls).toHaveLength(sent);
    deps.clock.advance(1);
    await pdb.item('5021;6');
    expect(deps.http.calls.length).toBeGreaterThan(sent);
  });

  it('keeps a RateLimit-Remaining pause at most its own length from when the step is noticed', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    let remaining = 35;
    const deps = makeDeps(
      (url) =>
        url.includes('/item/')
          ? res(rec('5021;6'), { headers: { 'ratelimit-remaining': String(remaining), 'ratelimit-reset': '30' } })
          : res({ error: 'Item not found' }, { status: 404 }),
      { clock },
    );
    const pdb = createPriceDb(deps, { timers });
    await pdb.item('5021;6');
    expect(pdb.health()[0]!.state).toBe('paused');
    remaining = 300;

    clock.advance(10_000);
    clock.advance(-8 * HOUR);
    const rest = pdb.health()[0]!;
    expect(rest.state).toBe('paused');
    expect(rest.detail).toContain(`paused for the rate limit until ${new Date(clock.now() + 30_000).toISOString()}`);
    clock.advance(30_000);
    expect(pdb.health()[0]!.state).toBe('idle');

    // The next request goes out at once instead of sleeping 65 s first.
    const next = pdb.item('378;6');
    await flush();
    expect(deps.http.calls).toHaveLength(2);
    expect(await next).not.toBeNull();
  });
});
