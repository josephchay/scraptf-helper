// 0.7.3 (audit bptfnet-1): a failed Steam Market lookup (a 429 and the 6 h lockout after it, an HTTP error, a
// paused network, a blocked host) reaches the drawer as an error naming the cause, never as a reading of
// "Lowest — · median — · 0 sold in 24 h". Steam's own "no listing" answer is still a reading. Through the
// real connector over a fake HTTP client; nothing is fetched.

import { afterEach, describe, expect, it } from 'vitest';
import { createSteamMarket } from '../../src/service/connectors/steamMarket';
import type { Engine, Repo } from '../../src/service/contracts';
import { HostBlockedError, NetworkPausedError } from '../../src/service/net';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { createStubSchema } from '../import/schemaStub';
import { FakeClock, makeDeps, res, type Route } from '../pricedb/helpers';

const KEY = 'Mann Co. Supply Crate Key';
const OK = { success: true, lowest_price: '$2.14', median_price: '$2.16', volume: '54,396' };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup(route: Route, scm = true) {
  const deps = makeDeps(route, { clock: new FakeClock(), settings: { connectors: { scm } } });
  repos.push(deps.repo);
  const ctx = {
    clock: deps.clock,
    log: deps.log,
    repo: deps.repo,
    settings: deps.settings,
    scm: createSteamMarket(deps),
    schema: { ...createStubSchema(), marketHashName: () => KEY },
    engine: {} as Engine,
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  return { deps, scm: () => rpc('item.scm', { sku: '5021;6' }) };
}

describe("'item.scm' on a failed lookup (bptfnet-1)", () => {
  it('rejects on a 429 and through the lockout after it, sending nothing more', async () => {
    const h = setup(() => res(null, { status: 429 }));
    await expect(h.scm()).rejects.toThrow(/Steam Market check failed.*429/);
    await expect(h.scm()).rejects.toThrow(/Steam Market check failed.*429/);
    expect(h.deps.http.calls).toHaveLength(1);
  });

  it('rejects on an HTTP error', async () => {
    await expect(setup(() => res(null, { status: 503 })).scm()).rejects.toThrow(/HTTP 503/);
  });

  it('rejects while the network is paused', async () => {
    const h = setup(() => {
      throw new NetworkPausedError();
    });
    await expect(h.scm()).rejects.toThrow(/paused/i);
  });

  it('rejects while the host is blocked', async () => {
    const h = setup(() => {
      throw new HostBlockedError('steamcommunity.com', 'challenge page');
    });
    await expect(h.scm()).rejects.toThrow(/challenge page/);
  });

  it('answers a reading as before', async () => {
    expect(await setup(() => res(OK)).scm()).toEqual({ lowest: '$2.14', median: '$2.16', volume: '54,396', marketHashName: KEY });
  });

  it("answers Steam's 'no listing' as a reading with no prices", async () => {
    expect(await setup(() => res({ success: false }, { status: 500 })).scm()).toEqual({ lowest: null, median: null, volume: null, marketHashName: KEY });
  });

  it('answers null and sends nothing while the Steam Market is off', async () => {
    const h = setup(() => res(OK), false);
    expect(await h.scm()).toBeNull();
    expect(h.deps.http.calls).toHaveLength(0);
  });
});
