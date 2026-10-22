// 0.9 (history, RESEARCH #6/#7): the end-to-end path through a real createServiceCore (coreRobustness.test.ts's setup:
// a fake fetch that refuses every host, a FakeSocket, the cached schema fixture). A typed scrap.tf price makes the base
// tracked; a buy update shaped like ws-sample's opens a spell and records its community price; a listing-delete held
// through the relist grace (the status tick at least 60 s later) ends it 'deleted'; a closed socket ends the next one
// 'unwatched'. Nothing new reaches the network: every URL the fake fetch saw is a 0.8 host.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { META_SCHEMA_CHECKED_AT, META_SCHEMA_EXTRAS, buildSchemaSnapshot } from '../../src/service/connectors/schema';
import type { Clock } from '../../src/service/contracts';
import { DB_FILE_NAME, createServiceCore, serviceTimers, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { allowedHosts } from '../../src/service/net';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ItemBookHistory } from '../../src/shared/types';
import { FakeSocket, type WsSample } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = <T = unknown>(rel: string): T => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8')) as T;
const wsSample = load<WsSample>('bptf/ws-sample.json');
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const BASE = '378;6';
const ORDER = '440_76561198000000042_0123456789abcdef0123456789abcdef';

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A clock the test can move forward while real timers keep running. */
function offsetClock(): Clock & { offset: number } {
  const c = { offset: 0, now: () => Date.now() + c.offset };
  return c;
}

/** The first buy update of ws-sample.json, made a Team Captain order at 4.66 ref with its own community price. */
function update(clock: Clock): unknown {
  const buy = wsSample.events.find((e) => e.event === 'listing-update' && e.payload.intent === 'buy')!;
  const nowSec = Math.floor(clock.now() / 1000);
  return {
    ...buy,
    payload: {
      ...buy.payload,
      id: ORDER,
      steamid: '76561198000000042',
      item: { defindex: 378, quality: 6, name: 'Team Captain', price: { community: { value: 4.33, valueHigh: 4.44, currency: 'metal', updatedAt: 1_788_000_000 } } },
      currencies: { metal: 4.66 },
      userAgent: { client: 'TF2Autobot', lastPulse: nowSec - 10 },
      listedAt: nowSec - 3_600,
      bumpedAt: nowSec - 60,
    },
  };
}

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-history090-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const seed = openRepo(path.join(dataDir, DB_FILE_NAME));
  const now = Date.now();
  const built = buildSchemaSnapshot(load('pricedb/schema-subset.json'), load('pricedb/paint-list.json'), now, 'W/"fixture"');
  seed.replaceSchema(built.snapshot);
  seed.setMeta(META_SCHEMA_EXTRAS, JSON.stringify(built.extras));
  seed.setMeta(META_SCHEMA_CHECKED_AT, String(now));
  // A typed scrap.tf price makes the base tracked; another buyer at the same price keeps it a book with a top order.
  seed.upsertScrapPrice({ sku: BASE, name: 'Team Captain', costScrap: 30, source: 'user', observedAt: now });
  seed.upsertListings([makeListing({ id: 'other-buyer', sku: BASE, baseSku: BASE, isBot: true, metalScrap: 42, lastEventAt: now - 60_000, listedAt: Math.floor(now / 1000) - 7_200 })]);
  seed.close();

  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    throw new TypeError(`fetch failed: the test refuses ${new URL(url).hostname}`);
  }) as typeof fetch;
  const sockets: FakeSocket[] = [];
  const clock = offsetClock();
  const core = createServiceCore({
    dataDir,
    version: '0.9.0',
    settings: mergeSettings(DEFAULT_SETTINGS, {
      contactUrl: 'https://github.com/flipdesk-test',
      networkPaused: false,
      liveFeed: { enabled: true },
      connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    }),
    secrets: {},
    log: quiet,
    fetchImpl,
    clock,
    // Real timers, but every interval (the 10 s status tick, the socket's 1 s flush) runs at most every 100 ms.
    timers: { ...serviceTimers, setInterval: (fn: () => void, ms: number) => serviceTimers.setInterval(fn, Math.min(ms, 100)) },
    wsFactory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  });
  cores.push(core);
  const history = () => core.handle('item.bookHistory', { sku: BASE, orders: [ORDER] }) as Promise<ItemBookHistory>;
  return { core, clock, sockets, calls, history };
}

describe('0.9 (history): order persistence and community prices through the service core', () => {
  it('follows, holds, ends and censors spells from the live feed, and records the community price', async () => {
    const h = setup();
    await h.core.start();
    const socket = await waitFor('the feed connection', async () => h.sockets[0] ?? null);
    socket.open();

    // The update opens a spell once the Live market knows the base's top order (sent again until then: a same-price
    // update of a followed order only continues its spell).
    const opened = await waitFor('a followed spell', async () => {
      socket.send([update(h.clock)]);
      await new Promise((r) => setTimeout(r, 200));
      const r = await h.history();
      return r.summary.followed === 1 ? r : null;
    });
    expect(opened.summary).toMatchObject({ followed: 1, open: 1 });
    expect(opened.orders.map((o) => [o.listingId, o.isBot, o.valueScrap])).toEqual([[ORDER, true, 42]]);
    expect(opened.community.steps).toEqual([
      expect.objectContaining({ currency: 'metal', value: 4.33, valueHigh: 4.44, lastUpdate: 1_788_000_000, sources: ['feed'] }),
    ]);

    // A listing-delete is held for the relist grace; the status tick at least 60 s later settles it 'deleted'.
    socket.send([{ id: 'del', event: 'listing-delete', payload: { id: ORDER, appid: 440 } }]);
    await waitFor('the delete in the book', async () => ((await h.history()).orders.length === 0 ? true : null));
    expect((await h.history()).summary).toMatchObject({ open: 1, deleted: 0 });
    h.clock.offset += 61_000;
    const ended = await waitFor('the settled delete', async () => {
      const r = await h.history();
      return r.summary.deleted === 1 ? r : null;
    });
    expect(ended.summary).toMatchObject({ followed: 1, open: 0, deleted: 1 });

    // The order comes back later: a new spell; the socket closing (a reconnect) ends it 'unwatched'.
    await waitFor('a second spell', async () => {
      socket.send([update(h.clock)]);
      await new Promise((r) => setTimeout(r, 200));
      return (await h.history()).summary.open === 1 ? true : null;
    });
    socket.serverClose(1006);
    const censored = await waitFor('the censored spell', async () => {
      const r = await h.history();
      return r.summary.unwatched === 1 ? r : null;
    });
    expect(censored.summary).toMatchObject({ followed: 2, open: 0, deleted: 1, unwatched: 1 });

    // Nothing new reached the network: every URL tried is a 0.8 host (and none was needed here).
    const hosts = new Set(allowedHosts());
    for (const url of h.calls) expect(hosts.has(new URL(url).hostname), url).toBe(true);
  }, 60_000);
});
