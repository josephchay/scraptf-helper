// The PriceDB socket stops on a refused or challenged upgrade and stays closed
// while either PriceDB host is disabled (R7, brief §2.0); only the user's
// re-enable (net.unblock) brings it back. Other refusals back off 60 s doubling
// to 15 min, 1 h after three 429s in a row, and the wait outlives stop/start and
// restarts. Fake socket.io client, fake timers; no network.

import { describe, expect, it } from 'vitest';
import {
  META_SOCKET_RETRY,
  PRICEDB_REST_HOST,
  PRICEDB_SOCKET_HOST,
  RECONNECT_DELAYS_MS,
  UPGRADE_REFUSED_MIN_DELAY_MS,
  createPriceDb,
  upgradeRefusedStatus,
  type PricedbSocketLike,
  type PricedbSocketOptions,
} from '../../src/service/connectors/pricedb';
import { FakeClock, FakeTimers, makeDeps, res } from './helpers';

class FakeSocket implements PricedbSocketLike {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  disconnected = false;
  constructor(
    readonly url: string,
    readonly opts: PricedbSocketOptions,
  ) {}
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }
  removeAllListeners(): this {
    this.handlers.clear();
    return this;
  }
  disconnect(): this {
    this.disconnected = true;
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.handlers.get(event) ?? []) l(...args);
  }
}

/** socket.io-client's connect_error for an upgrade answered with `status` (engine.io TransportError + ws ErrorEvent). */
function refusedUpgrade(status: number): Error {
  return Object.assign(new Error('websocket error'), {
    type: 'TransportError',
    description: { type: 'error', message: `Unexpected server response: ${status}` },
  });
}

function setup() {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const deps = makeDeps(() => res(null, { status: 404 }), { clock });
  const sockets: FakeSocket[] = [];
  const pdb = createPriceDb(deps, {
    timers,
    socketFactory: (url, opts) => {
      const s = new FakeSocket(url, opts);
      sockets.push(s);
      return s;
    },
  });
  return { clock, timers, deps, sockets, pdb, last: () => sockets[sockets.length - 1]!, health: () => pdb.health()[1]! };
}

const noop = (): void => undefined;

describe('upgradeRefusedStatus', () => {
  it('reads the status from the ways socket.io reports a refused upgrade', () => {
    expect(upgradeRefusedStatus(refusedUpgrade(403))).toBe(403);
    expect(upgradeRefusedStatus({ description: { error: new Error('Unexpected server response: 429') } })).toBe(429);
    expect(upgradeRefusedStatus(new Error('Unexpected server response: 503'))).toBe(503);
    expect(upgradeRefusedStatus(new Error('websocket error'))).toBeNull();
    expect(upgradeRefusedStatus(new Error('xhr poll error'))).toBeNull();
    expect(upgradeRefusedStatus(null)).toBeNull();
    expect(upgradeRefusedStatus('Unexpected server response: 4031')).toBeNull();
  });
});

describe('PriceDB socket and host blocks', () => {
  it.each([401, 403])('stops on an upgrade refused with %i, stores the block and never retries', async (status) => {
    const t = setup();
    t.pdb.startSocket(noop);
    t.last().emit('connect_error', refusedUpgrade(status));
    expect(t.last().disconnected).toBe(true);
    const h = t.health();
    expect(h.state).toBe('blocked');
    expect(h.lastError).toBe(`PriceDB refused the live-updates connection (HTTP ${status})`);
    expect(h.disabledReason).toMatch(new RegExp(`HTTP ${status}.*re-enable ws\\.pricedb\\.io`));
    expect(t.deps.http.hostBlocked(PRICEDB_SOCKET_HOST)).toBe(h.disabledReason);
    await t.timers.advance(6 * 60 * 60_000);
    expect(t.sockets).toHaveLength(1);
    // A network pause and resume (core stops and starts the socket) does not retry either.
    t.pdb.stopSocket();
    t.pdb.startSocket(noop);
    await t.timers.advance(60 * 60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.health().state).toBe('blocked');
  });

  it('connects again only after the user re-enables ws.pricedb.io', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    t.last().emit('connect_error', refusedUpgrade(403));
    await t.timers.advance(60_000);
    expect(t.sockets).toHaveLength(1);
    t.deps.http.unblockHost(PRICEDB_SOCKET_HOST); // net.unblock
    t.pdb.resumeSocket();
    expect(t.sockets).toHaveLength(2);
    t.last().emit('connect');
    expect(t.health()).toMatchObject({ state: 'live', disabledReason: null });
  });

  it('picks up a re-enable within 30 s even without resumeSocket', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    t.last().emit('connect_error', refusedUpgrade(403));
    t.deps.http.unblockHost(PRICEDB_SOCKET_HOST);
    await t.timers.advance(30_000);
    expect(t.sockets).toHaveLength(2);
  });

  it('never retries in this process when the HTTP layer did not keep the block', async () => {
    const t = setup();
    t.deps.http.blockHost = () => undefined;
    t.pdb.startSocket(noop);
    t.last().emit('connect_error', refusedUpgrade(403));
    t.pdb.resumeSocket();
    t.pdb.stopSocket();
    t.pdb.startSocket(noop);
    await t.timers.advance(24 * 60 * 60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.health().state).toBe('blocked');
  });

  it.each([PRICEDB_SOCKET_HOST, PRICEDB_REST_HOST])('does not connect while %s is disabled, and reports why', async (host) => {
    const t = setup();
    t.deps.http.blocked.set(host, 'challenge page (cf-mitigated: challenge, HTTP 403)');
    expect(t.health()).toMatchObject({ state: 'blocked', disabledReason: 'challenge page (cf-mitigated: challenge, HTTP 403)' });
    t.pdb.startSocket(noop);
    await t.timers.advance(2 * 60 * 60_000);
    expect(t.sockets).toHaveLength(0);
    expect(t.health()).toMatchObject({ state: 'blocked', detail: 'challenge page (cf-mitigated: challenge, HTTP 403)' });
    t.deps.http.unblockHost(host);
    t.pdb.resumeSocket();
    expect(t.sockets).toHaveLength(1);
  });

  it('does not connect after the REST API refused requests (401/403)', async () => {
    const t = setup();
    t.deps.http.route = () => res({ message: 'forbidden' }, { status: 403 });
    await t.pdb.item('5021;6');
    t.pdb.startSocket(noop);
    await t.timers.advance(60 * 60_000);
    expect(t.sockets).toHaveLength(0);
    expect(t.health().disabledReason).toMatch(/PriceDB refused requests \(HTTP 403\)/);
  });

  it('closes a live socket when the REST host gets disabled', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    t.last().emit('connect');
    expect(t.health().state).toBe('live');
    t.deps.http.blocked.set(PRICEDB_REST_HOST, 'challenge page');
    await t.timers.advance(30_000);
    expect(t.last().disconnected).toBe(true);
    expect(t.health().state).toBe('blocked');
    await t.timers.advance(60 * 60_000);
    expect(t.sockets).toHaveLength(1);
  });

  /** Refuses each upgrade with the given statuses and returns the wait before every next attempt, in seconds. */
  async function refusalGaps(t: ReturnType<typeof setup>, statuses: readonly number[]): Promise<number[]> {
    const gaps: number[] = [];
    for (const status of statuses) {
      const n = t.sockets.length;
      t.last().emit('connect_error', refusedUpgrade(status));
      expect(t.health().state).toBe('backoff');
      const delay = t.timers.delays()[0]!;
      await t.timers.advance(delay - 1);
      expect(t.sockets).toHaveLength(n);
      await t.timers.advance(1);
      expect(t.sockets).toHaveLength(n + 1);
      gaps.push(delay / 1000);
    }
    return gaps;
  }

  it('backs off 60 s, doubling to 15 min, after other refused upgrades (503, 502)', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    expect(await refusalGaps(t, [503, 502, 503, 503, 503, 503, 503])).toEqual([60, 120, 240, 480, 900, 900, 900]);
    expect(UPGRADE_REFUSED_MIN_DELAY_MS).toBe(60_000);
    expect(t.health().lastError).toBe('PriceDB refused the live-updates connection (HTTP 503)');
    expect(t.deps.http.hostBlocked(PRICEDB_SOCKET_HOST)).toBeNull();
  });

  it('waits at least an hour after three 429s in a row; a 503 neither counts nor ends the streak', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    expect(await refusalGaps(t, [429, 429, 429, 429])).toEqual([60, 120, 3600, 3600]);

    const u = setup();
    u.pdb.startSocket(noop);
    expect(await refusalGaps(u, [429, 503, 429, 503])).toEqual([60, 120, 240, 480]);
    u.last().emit('connect_error', refusedUpgrade(429));
    expect(u.timers.delays()).toEqual([60 * 60_000]);
    expect(u.health().detail).toBe('PriceDB refused the live-updates connection (HTTP 429); reconnecting in 60 min');
  });

  it('starts over once an upgrade is accepted', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    expect(await refusalGaps(t, [429, 429])).toEqual([60, 120]);
    t.last().emit('connect');
    expect(t.deps.repo.getMeta(META_SOCKET_RETRY)).toBe('');
    t.last().emit('disconnect', 'transport close');
    await t.timers.advance(RECONNECT_DELAYS_MS[0]!);
    expect(await refusalGaps(t, [429])).toEqual([60]);
  });

  it('keeps the wait across a network pause/resume (stop/start)', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    await refusalGaps(t, [429, 429]);
    t.last().emit('connect_error', refusedUpgrade(429));
    t.pdb.stopSocket();
    t.pdb.startSocket(noop);
    expect(t.health().state).toBe('backoff');
    await t.timers.advance(60 * 60_000 - 1_000);
    expect(t.sockets).toHaveLength(3);
    await t.timers.advance(1_000);
    expect(t.sockets).toHaveLength(4);
  });

  it('keeps the wait and the 429 streak across a restart, clamped to 24 h', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    await refusalGaps(t, [429]);
    t.last().emit('connect_error', refusedUpgrade(429));
    expect(JSON.parse(t.deps.repo.getMeta(META_SOCKET_RETRY)!)).toMatchObject({ until: t.clock.now() + 120_000, n429: 2, rejections: 2 });
    t.pdb.stopSocket();

    // A relaunch 30 s later still waits the remaining 90 s, and the next 429 is the third in a row.
    await t.timers.advance(30_000);
    const sockets: FakeSocket[] = [];
    const deps2 = makeDeps(() => res(null, { status: 404 }), { clock: t.clock, repo: t.deps.repo });
    const pdb2 = createPriceDb(deps2, {
      timers: t.timers,
      socketFactory: (url, opts) => {
        const s = new FakeSocket(url, opts);
        sockets.push(s);
        return s;
      },
    });
    pdb2.startSocket(noop);
    expect(sockets).toHaveLength(0);
    expect(pdb2.health()[1]!.state).toBe('backoff');
    await t.timers.advance(90_000 - 1);
    expect(sockets).toHaveLength(0);
    await t.timers.advance(1);
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit('connect_error', refusedUpgrade(429));
    expect(t.timers.delays()[0]).toBe(60 * 60_000);
    pdb2.stopSocket();

    // A corrupt far-future wait is clamped to 24 h, and the clamped value is written back.
    const repo = t.deps.repo;
    repo.setMeta(META_SOCKET_RETRY, JSON.stringify({ until: t.clock.now() + 30 * 24 * 60 * 60_000, why: 'x', n429: 0, rejections: 1 }));
    const pdb3 = createPriceDb(makeDeps(() => res(null, { status: 404 }), { clock: t.clock, repo }), { timers: t.timers, socketFactory: () => new FakeSocket('', {} as PricedbSocketOptions) });
    expect(JSON.parse(repo.getMeta(META_SOCKET_RETRY)!).until).toBe(t.clock.now() + 24 * 60 * 60_000);
    pdb3.stopSocket();
  });
});
