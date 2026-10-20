// 0.7.3: /autob/items is CDN-cached up to 4 h, so the full-list load could put a newer socket, /item or
// /items-bulk price back to an older copy. The stored PriceDB row now keeps the newest record.

import { afterEach, describe, expect, it } from 'vitest';
import { LOAD_ALL_MIN_INTERVAL_MS, createPriceDb, type PricedbSocketLike, type PricedbSocketOptions } from '../../src/service/connectors/pricedb';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import type { PricedbRow } from '../../src/shared/types';
import { FakeClock, FakeTimers, T0, makeDeps, res } from './helpers';

const NOW_SEC = Math.floor(T0 / 1000);
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function rec(sku: string, buyMetal: number, time: number) {
  return { sku, name: `Item ${sku}`, time, buy: { keys: 0, metal: buyMetal }, sell: { keys: 0, metal: buyMetal + 2 } };
}

function row(time: number, buyScrap: number, fetchedAt = T0): PricedbRow {
  return { sku: '378;6', name: 'Team Captain', buyKeys: 0, buyScrap, sellKeys: 0, sellScrap: buyScrap + 18, time, fetchedAt };
}

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

describe('Repo.upsertPricedb: newest wins', () => {
  it('never replaces a newer stored row with an older record; an equal, newer or undated record writes', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertPricedb([row(1000, 180)]);

    repo.upsertPricedb([row(500, 90, T0 + 1)]);
    expect(repo.getPricedb('378;6')).toMatchObject({ buyScrap: 180, time: 1000, fetchedAt: T0 });

    repo.upsertPricedb([row(1000, 95)]);
    expect(repo.getPricedb('378;6')).toMatchObject({ buyScrap: 95, time: 1000 });

    repo.upsertPricedb([row(1001, 99)]);
    expect(repo.getPricedb('378;6')).toMatchObject({ buyScrap: 99, time: 1001 });

    repo.upsertPricedb([row(0, 42)]);
    expect(repo.getPricedb('378;6')).toMatchObject({ buyScrap: 42, time: 0 });
  });
});

describe('PriceDB full list after fresher prices', () => {
  it('keeps a socket price newer than the CDN-cached /autob/items copy, and takes a newer full-list record', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    let list: unknown = { items: [] };
    const deps = makeDeps((url) => (url.endsWith('/autob/items') ? res(list) : res(null, { status: 404 })), { clock });
    repos.push(deps.repo);
    const sockets: FakeSocket[] = [];
    const pdb = createPriceDb(deps, {
      timers,
      socketFactory: (url, opts) => {
        const s = new FakeSocket(url, opts);
        sockets.push(s);
        return s;
      },
    });
    pdb.startSocket(() => undefined);
    sockets[0]!.emit('connect');
    sockets[0]!.emit('price', rec('378;6', 20, NOW_SEC - 60));
    expect(deps.repo.getPricedb('378;6')).toMatchObject({ buyScrap: 180, time: NOW_SEC - 60 });

    // A 3 h old CDN copy: 378;6 at 10 ref, plus an item the socket never sent.
    list = { items: [rec('378;6', 10, NOW_SEC - 10_800), rec('5021;6', 50, NOW_SEC - 10_800)] };
    await pdb.loadAll();
    expect(deps.repo.getPricedb('378;6')).toMatchObject({ buyScrap: 180, time: NOW_SEC - 60 });
    expect(deps.repo.getPricedb('5021;6')).toMatchObject({ buyScrap: 450, time: NOW_SEC - 10_800 });

    clock.advance(LOAD_ALL_MIN_INTERVAL_MS);
    list = { items: [rec('378;6', 30, NOW_SEC)] };
    await pdb.loadAll();
    expect(deps.repo.getPricedb('378;6')).toMatchObject({ buyScrap: 270, time: NOW_SEC });
    pdb.stopSocket();
  });

  it('keeps the stored row when /items-bulk or /item answers an older record', async () => {
    const older = rec('378;6', 10, NOW_SEC - 10_800);
    const deps = makeDeps((url) => (url.endsWith('/items-bulk') ? res([older]) : url.includes('/item/') ? res(older) : res(null, { status: 404 })));
    repos.push(deps.repo);
    deps.repo.upsertPricedb([row(NOW_SEC - 60, 180)]);
    const pdb = createPriceDb(deps);

    await pdb.bulk(['378;6']);
    expect(deps.repo.getPricedb('378;6')).toMatchObject({ buyScrap: 180, time: NOW_SEC - 60 });
    await pdb.item('378;6');
    expect(deps.repo.getPricedb('378;6')).toMatchObject({ buyScrap: 180, time: NOW_SEC - 60 });
  });
});
