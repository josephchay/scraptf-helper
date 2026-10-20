// 0.7.3 follow-up (r4-clock-2): after PriceDB refused the live-updates upgrade, the socket waits until
// retryNotBefore, a wall-clock deadline that connect() re-checks when its timer fires. A clock stepped back
// while waiting made that check start a new wait for the size of the step, so the socket stayed closed for
// hours (and Data health said so). The wait now keeps at most its own length from when the step is noticed,
// and the clamped deadline is saved, so a restart does not restore the stretched one. Fake socket.io client,
// fake timers; no network.

import { describe, expect, it } from 'vitest';
import { META_SOCKET_RETRY, createPriceDb, type PricedbSocketLike, type PricedbSocketOptions } from '../../src/service/connectors/pricedb';
import { FakeClock, FakeTimers, makeDeps, res } from './helpers';

const HOUR = 60 * 60_000;

class FakeSocket implements PricedbSocketLike {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
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
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.handlers.get(event) ?? []) l(...args);
  }
}

/** socket.io-client's connect_error for an upgrade answered with `status`. */
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
  return { clock, timers, deps, sockets, pdb, health: () => pdb.health()[1]! };
}

/** Fires every pending timer now: real timers count elapsed time, so the wall-clock step does not delay them. */
function fireNow(timers: FakeTimers): void {
  for (const [id, t] of [...timers.pending]) {
    timers.pending.delete(id);
    t.fn();
  }
}

const noop = (): void => undefined;

describe('PriceDB socket: refused-upgrade wait after the wall clock stepped back', () => {
  it('waits its own 60 s from when the step is noticed, not the 8 h of the step', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    t.sockets[0]!.emit('connect_error', refusedUpgrade(429));
    expect(t.timers.delays()).toEqual([60_000]);

    await t.timers.advance(60_000 - 1);
    t.clock.advance(-8 * HOUR);
    fireNow(t.timers);
    expect(t.sockets).toHaveLength(1);
    expect(t.timers.delays()).toEqual([60_000]);
    expect(t.health().detail).toBe('PriceDB refused the live-updates connection (HTTP 429); reconnecting in 60 s');
    // Saved clamped, so a restart now waits the same.
    expect(JSON.parse(t.deps.repo.getMeta(META_SOCKET_RETRY)!).until).toBe(t.clock.now() + 60_000);

    await t.timers.advance(60_000);
    expect(t.sockets).toHaveLength(2);
  });

  it('shows and keeps the clamped wait across a network pause/resume (stop/start)', async () => {
    const t = setup();
    t.pdb.startSocket(noop);
    t.sockets[0]!.emit('connect_error', refusedUpgrade(503));
    await t.timers.advance(20_000);
    t.clock.advance(-8 * HOUR);
    expect(t.health().detail).toBe('PriceDB refused the live-updates connection (HTTP 503); reconnecting in 60 s');
    t.pdb.stopSocket();
    t.pdb.startSocket(noop);
    expect(t.health().state).toBe('backoff');
    expect(t.timers.delays()).toEqual([60_000]);
    await t.timers.advance(60_000);
    expect(t.sockets).toHaveLength(2);
  });
});
