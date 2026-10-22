// 0.9 (history, H3/H8): the feed socket's batches carry each base's newest community price and the stream's epoch.
// The epoch grows on every new connection and on every buffer-limit-exceeded, after a flush, so one batch never mixes
// two streams. No connection, header, cadence or cap changes. bptfSocket.test.ts's harness.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBptfSocket, resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { FeedBatch, Repo } from '../../src/service/contracts';
import { FakeHttp, FakeSocket, createLogger, createStubSchema, loadFixture, settingsWith, type WsEvent, type WsSample } from './helpers';

const T0 = new Date(2026, 9, 14, 12, 0, 0).getTime();
const sample = loadFixture<WsSample>('ws-sample.json');
const updates = sample.events.filter((e) => e.event === 'listing-update');
const buyA = updates.find((e) => e.payload.intent === 'buy')!;
const sellA = updates.find((e) => e.payload.intent === 'sell')!;

/** buyA's payload with another id and its own community price (the same item, so the same base). */
function twin(id: string, community: Record<string, unknown>, over: Record<string, unknown> = {}): WsEvent {
  return {
    ...buyA,
    payload: { ...buyA.payload, id, item: { ...buyA.payload.item, price: { community } }, ...over },
  };
}

function harness() {
  const sockets: FakeSocket[] = [];
  const batches: FeedBatch[] = [];
  const log = createLogger();
  const feed = createBptfSocket({
    clock: { now: () => Date.now() },
    log,
    repo: {} as Repo,
    http: new FakeHttp(),
    settings: () => settingsWith(),
    secret: () => null,
    schema: createStubSchema(),
    onBatch: (b) => batches.push(b),
    wsFactory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  });
  return { feed, sockets, batches, log, last: () => sockets[sockets.length - 1]! };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  resetBptfSocketGuard();
});

afterEach(() => {
  vi.useRealTimers();
  resetBptfSocketGuard();
});

describe('0.9 (history): community prices and the epoch on feed batches', () => {
  it("carries each base's newest community price, stamped with the event's time, and the stream's epoch", async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    s.send([twin('440_a', { value: 3, valueHigh: 3.22, currency: 'metal', updatedAt: 1787943523 }), sellA]);
    await vi.advanceTimersByTimeAsync(500);
    s.send(twin('440_b', { value: 3.11, currency: 'metal', updatedAt: 1787943600 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.batches).toHaveLength(1);
    const b = h.batches[0]!;
    expect(b.epoch).toBe(1);
    const base = b.upserts.find((l) => l.id === '440_a')!.baseSku;
    const mine = b.community!.filter((c) => c.sku === base);
    // The newest per base: the second update's price, seen at its own frame's time.
    expect(mine).toEqual([{ sku: base, currency: 'metal', value: 3.11, valueHigh: null, lastUpdate: 1787943600, seenAt: T0 + 500 }]);
    // sellA's item (a Strange Killstreak Pistol) has its own base and price: sell listings report one too.
    const sellBase = b.upserts.find((l) => l.intent === 'sell')!.baseSku;
    expect(sellBase).not.toBe(base);
    expect(b.community!.find((c) => c.sku === sellBase)).toEqual({ sku: sellBase, currency: 'metal', value: 23.22, valueHigh: 29.33, lastUpdate: 1788973015, seenAt: T0 });
    expect(b.community).toHaveLength(2);
    // The next window starts with no price.
    s.send({ id: 'd', event: 'listing-delete', payload: { id: '440_a' } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches[1]).toMatchObject({ deletes: ['440_a'], community: [], epoch: 1 });
    h.feed.stop();
  });

  it('carries a price in keys as the feed gave it', async () => {
    const h = harness();
    h.feed.start();
    h.last().open();
    h.last().send(twin('440_c', { value: 7, currency: 'keys' }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches[0]!.community).toHaveLength(1);
    expect(h.batches[0]!.community![0]).toMatchObject({ currency: 'keys', value: 7 });
    h.feed.stop();
  });

  it('gives a reconnected stream the next epoch; the old connection’s events go out under the old one', async () => {
    const h = harness();
    h.feed.start();
    const first = h.last();
    first.open();
    first.send(buyA);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches.map((b) => b.epoch)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(500);
    first.send(sellA);
    first.serverClose(1006);
    // The reconnect waits 1 s; the old connection's pending update is flushed under its epoch first.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.batches.map((b) => [b.epoch, b.upserts.map((l) => l.id)])).toEqual([
      [1, [buyA.payload.id]],
      [1, [sellA.payload.id]],
    ]);
    const second = h.last();
    second.open();
    second.send(buyA);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches.at(-1)!.epoch).toBe(2);
    h.feed.stop();
  });

  it("flushes the stream's events before a new connection's open bumps the epoch", async () => {
    const h = harness();
    h.feed.start();
    const first = h.last();
    first.open();
    first.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = h.last();
    expect(second).not.toBe(first);
    // Events that reached the new socket before its 'open' (none in practice) still belong to the stream before it.
    second.send(buyA);
    second.open();
    expect(h.batches.map((b) => [b.epoch, b.upserts.length])).toEqual([[1, 1]]);
    second.send(sellA);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches.map((b) => [b.epoch, b.upserts.length])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    h.feed.stop();
  });

  it('on buffer-limit-exceeded, flushes what came before, then starts the next epoch', async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    s.send([buyA, { event: 'buffer-limit-exceeded', payload: null }, sellA]);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toMatchObject({ epoch: 1 });
    expect(h.batches[0]!.upserts.map((l) => l.id)).toEqual([buyA.payload.id]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches).toHaveLength(2);
    expect(h.batches[1]).toMatchObject({ epoch: 2 });
    expect(h.batches[1]!.upserts.map((l) => l.id)).toEqual([sellA.payload.id]);
    expect(h.feed.detail().bufferLimitEvents).toBe(1);
    h.feed.stop();
  });

  it("records an inactive update's community price, with its id in the batch's inactive", async () => {
    const h = harness();
    h.feed.start();
    const s = h.last();
    s.open();
    s.send(twin('440_i', { value: 5.55, currency: 'metal', updatedAt: 1787000000 }, { status: 'notEnoughCurrency' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const b = h.batches[0]!;
    expect(b).toMatchObject({ upserts: [], deletes: ['440_i'], inactive: ['440_i'] });
    expect(b.community).toEqual([expect.objectContaining({ currency: 'metal', value: 5.55, lastUpdate: 1787000000 })]);
    h.feed.stop();
  });
});
