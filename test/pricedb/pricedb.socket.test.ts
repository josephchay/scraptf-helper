import { describe, expect, it } from 'vitest';
import {
  PRICEDB_SOCKET_URL,
  RECONNECT_DELAYS_MS,
  RECONNECT_SLOW_MS,
  STABLE_CONNECTION_MS,
  createPriceDb,
  type PricedbSocketLike,
  type PricedbSocketOptions,
} from '../../src/service/connectors/pricedb';
import type { PricedbRow } from '../../src/shared/types';
import { FakeClock, FakeTimers, T0, fixture, makeDeps, res } from './helpers';

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

function setup(settings: Parameters<typeof makeDeps>[1] = {}) {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const deps = makeDeps(() => res(null, { status: 404 }), { clock, ...settings });
  const sockets: FakeSocket[] = [];
  const pdb = createPriceDb(deps, {
    timers,
    socketFactory: (url, opts) => {
      const s = new FakeSocket(url, opts);
      sockets.push(s);
      return s;
    },
  });
  const prices: PricedbRow[] = [];
  const last = (): FakeSocket => sockets[sockets.length - 1]!;
  const sockHealth = () => pdb.health()[1]!;
  return { clock, timers, deps, sockets, pdb, prices, last, sockHealth, onPrice: (r: PricedbRow) => prices.push(r) };
}

describe('PriceDB socket', () => {
  it('opens exactly one socket.io connection with an honest User-Agent', () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    t.pdb.startSocket(t.onPrice);
    expect(t.sockets).toHaveLength(1);
    expect(t.last().url).toBe(PRICEDB_SOCKET_URL);
    expect(t.last().opts).toEqual({
      transports: ['websocket'],
      extraHeaders: { 'User-Agent': 'TF2FlipDesk/0.1.0 (+test)' },
      reconnection: false,
      timeout: 20_000,
    });
    expect(t.sockHealth()).toMatchObject({ id: 'pricedb-socket', state: 'connecting' });
  });

  it('is live after connect and treats silence as normal', () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    t.last().emit('connect');
    const h = t.sockHealth();
    expect(h.state).toBe('live');
    expect(h.detail).toContain('no price events yet');
    expect(h.lastOkAt).toBe(T0);
  });

  it('stores price events, updates the key quote and calls onPrice', () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    t.last().emit('connect');
    t.last().emit('price', fixture('item-key.json'));
    t.last().emit('price', [
      { sku: '15000;15;pk14;w1', name: 'Night Owl Sniper Rifle (Factory New)', time: 5, buy: { keys: 0, metal: 5.11 }, sell: { keys: 0, metal: 6.77 } },
      { sku: '6522;255;td-25000', name: 'Strangifier', time: 5, buy: { keys: 0, metal: 0 }, sell: { keys: 0, metal: 0.11 } },
    ]);
    t.last().emit('price', { sku: 'garbage' });
    t.last().emit('price', 'not even an object');

    expect(t.prices.map((p) => p.sku)).toEqual(['5021;6', '15000;15;w1;pk14']);
    expect(t.deps.repo.getPricedb('15000;15;w1;pk14')).toMatchObject({ buyScrap: 46, sellScrap: 61 });
    expect(t.deps.repo.getPricedb('6522;255;td-25000')).toBeNull();
    expect(t.deps.repo.keyQuotes()).toEqual([{ source: 'pricedb', buyScrap: 569, sellScrap: 581, observedAt: 1791968059 * 1000 }]);
    const h = t.sockHealth();
    expect(h.detail).toContain('2 price updates');
    expect(h.detail).toContain('2 unreadable events');
  });

  it('survives a throwing onPrice handler', () => {
    const t = setup();
    t.pdb.startSocket(() => {
      throw new Error('handler bug');
    });
    t.last().emit('connect');
    expect(() => t.last().emit('price', fixture('item-key.json'))).not.toThrow();
    expect(t.deps.repo.getPricedb('5021;6')).not.toBeNull();
  });

  it('reconnects after 1, 2, 4, 8, 16 s, then every 10 minutes, and never gives up', async () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    const expected = [...RECONNECT_DELAYS_MS, RECONNECT_SLOW_MS, RECONNECT_SLOW_MS, RECONNECT_SLOW_MS];
    for (const [i, delay] of expected.entries()) {
      const s = t.last();
      s.emit('connect_error', new Error('websocket error'));
      expect(s.disconnected).toBe(true);
      expect(s.handlers.size).toBe(0);
      expect(t.sockHealth().state).toBe('backoff');
      expect(t.timers.delays()[0]).toBe(delay);
      await t.timers.advance(delay - 1);
      expect(t.sockets).toHaveLength(i + 1);
      await t.timers.advance(1);
      expect(t.sockets).toHaveLength(i + 2);
    }
    expect(t.sockHealth().lastError).toBe('websocket error');
  });

  it('resets the backoff after a connection that stayed up', async () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    for (const d of [1_000, 2_000, 4_000]) {
      t.last().emit('connect_error', new Error('nope'));
      await t.timers.advance(d);
    }
    t.last().emit('connect');
    await t.timers.advance(STABLE_CONNECTION_MS);
    t.last().emit('disconnect', 'transport close');
    expect(t.timers.delays()).toEqual([1_000]);
    expect(t.sockHealth().lastError).toBe('disconnected (transport close)');
  });

  it('keeps escalating when the server accepts and then drops the connection at once', async () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    const expected = [...RECONNECT_DELAYS_MS, RECONNECT_SLOW_MS, RECONNECT_SLOW_MS];
    for (const delay of expected) {
      t.last().emit('connect');
      expect(t.sockHealth().state).toBe('live');
      t.last().emit('disconnect', 'transport close');
      expect(t.timers.delays()).toEqual([delay]);
      await t.timers.advance(delay);
    }
    expect(t.sockets).toHaveLength(expected.length + 1);
  });

  it('waits the slow interval at once when the server kicks the client', async () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    t.last().emit('connect');
    t.last().emit('disconnect', 'io server disconnect');
    expect(t.timers.delays()).toEqual([RECONNECT_SLOW_MS]);
    expect(t.sockHealth()).toMatchObject({ state: 'backoff', lastError: 'disconnected (io server disconnect)' });
    await t.timers.advance(RECONNECT_SLOW_MS - 1);
    expect(t.sockets).toHaveLength(1);
    await t.timers.advance(1);
    expect(t.sockets).toHaveLength(2);
    // ... and again after a later kick, even one following a stable connection.
    t.last().emit('connect');
    await t.timers.advance(STABLE_CONNECTION_MS);
    t.last().emit('disconnect', 'io server disconnect');
    expect(t.timers.delays()).toEqual([RECONNECT_SLOW_MS]);
  });

  it('times out a connection attempt that never reports back', async () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    await t.timers.advance(25_000);
    expect(t.sockHealth().state).toBe('backoff');
    expect(t.sockHealth().lastError).toBe('connect timed out');
    await t.timers.advance(1_000);
    expect(t.sockets).toHaveLength(2);
  });

  it('ignores events from a socket it already replaced', async () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    const first = t.last();
    const handlers = first.handlers.get('price')!;
    first.emit('connect_error', new Error('x'));
    await t.timers.advance(1_000);
    handlers[0]!(fixture('item-key.json'));
    expect(t.prices).toEqual([]);
  });

  it('stops cleanly', async () => {
    const t = setup();
    t.pdb.startSocket(t.onPrice);
    t.last().emit('connect');
    t.pdb.stopSocket();
    expect(t.last().disconnected).toBe(true);
    expect(t.sockHealth().state).toBe('off');
    await t.timers.advance(60 * 60 * 1000);
    expect(t.sockets).toHaveLength(1);
    // It can be started again.
    t.pdb.startSocket(t.onPrice);
    expect(t.sockets).toHaveLength(2);
  });

  it('waits while the network is paused and disconnects when it gets paused', async () => {
    const t = setup();
    t.deps.http.paused = true;
    t.pdb.startSocket(t.onPrice);
    expect(t.sockets).toHaveLength(0);
    expect(t.sockHealth().state).toBe('paused');
    t.deps.http.paused = false;
    await t.timers.advance(30_000);
    expect(t.sockets).toHaveLength(1);
    t.last().emit('connect');

    t.deps.http.paused = true;
    await t.timers.advance(30_000);
    expect(t.last().disconnected).toBe(true);
    expect(t.sockHealth().state).toBe('paused');
  });

  it('stays off while disabled in settings', async () => {
    const t = setup({ settings: { connectors: { pricedbSocket: false } } });
    t.pdb.startSocket(t.onPrice);
    expect(t.sockets).toHaveLength(0);
    expect(t.sockHealth()).toMatchObject({ state: 'off', detail: 'Disabled in Settings' });
    t.deps.setSettings({ connectors: { pricedbSocket: true } });
    await t.timers.advance(30_000);
    expect(t.sockets).toHaveLength(1);
  });
});
