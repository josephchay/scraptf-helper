// F11 core wiring, end to end: a recorded buy makes its base SKU "watched" (the
// feed keeps its sell listings, and the budgeted snapshot job may refresh it),
// the Live market's change for that base reaches holdings, which prices the
// row and pushes one "Sell:" notification through the existing 'notify' push;
// deleting the row takes the SKU off the watch list again. Real core and repo,
// a fake websocket replaying captured backpack.tf events; only the schema host
// answers, and nothing here makes a request of its own.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract, PushEvent } from '../../src/shared/rpc';
import type { HealthReport, HoldingsResult, JournalEntry } from '../../src/shared/types';
import { FakeSocket, type WsEvent, type WsSample } from '../bptf/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const wsSample = JSON.parse(readFileSync(path.join(FIX, 'bptf/ws-sample.json'), 'utf8')) as WsSample;

/** Strange Australium Scattergun: a 39 keys 40.44 ref buy order from a bot ("Sylvie") in the capture. */
const ITEM = '200;11;australium';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(u.hostname + u.pathname);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
  if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const temps: string[] = [];
const cores: ServiceCore[] = [];

afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const capturedBuy = (name: string): WsEvent => wsSample.events.find((e) => e.payload?.intent === 'buy' && e.payload.item?.name === name)!;

/** The captured buy order turned into someone's sell listing of the same item (same item fields, so the same SKU). */
function sellOf(e: WsEvent, assetId: string): WsEvent {
  const c = JSON.parse(JSON.stringify(e)) as WsEvent;
  c.id = `sell-${assetId}`;
  c.payload.id = `440_${assetId}`;
  c.payload.intent = 'sell';
  c.payload.steamid = '76561198000000099';
  c.payload.item.id = assetId;
  return c;
}

describe('holdings in the service core', () => {
  it('watches held SKUs, prices them from the live book, notifies once, and unwatches them when the lot goes', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-holdings-core-'));
    temps.push(root);
    const dataDir = path.join(root, 'data');
    const sockets: FakeSocket[] = [];
    const core = createServiceCore({
      dataDir,
      version: '0.3.0',
      settings: mergeSettings(DEFAULT_SETTINGS, {
        contactUrl: 'https://github.com/flipdesk-test',
        connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
        notifications: { minConfidence: 0 },
      }),
      secrets: {},
      log: createLogger({ dataDir }),
      fetchImpl,
      wsFactory: (url, headers) => {
        const s = new FakeSocket(url, headers);
        sockets.push(s);
        return s;
      },
    });
    cores.push(core);
    const pushes: { event: PushEvent; payload: unknown }[] = [];
    core.onPush((event, payload) => pushes.push({ event, payload }));
    const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
    const health = () => call<HealthReport>('health.get');
    await core.start();
    await waitFor('the feed socket', async () => sockets.length === 1);
    requested.length = 0;

    // Bought on scrap.tf for 30 keys, before any order for it is known.
    const K = (await call<HoldingsResult>('holdings.list')).keyPrice!.valueScrap;
    const bought = await call<JournalEntry>('journal.add', { side: 'buy', venue: 'scrap.tf', sku: ITEM, keys: 30, scrap: 0 });
    expect(bought.name).toBe('Strange Australium Scattergun');
    expect((await call<HoldingsResult>('holdings.list')).rows).toEqual([expect.objectContaining({ sku: ITEM, status: 'no-buyers', costScrap: 30 * K })]);

    // The feed: the captured buy order, a sell listing of the held item, and one of an item nobody holds.
    const order = capturedBuy('Strange Australium Scattergun');
    const unheldSell = wsSample.events.find((e) => e.payload?.intent === 'sell')!;
    sockets[0]!.open();
    sockets[0]!.send([order, sellOf(order, '99999999901'), unheldSell]);
    await waitFor('the feed batch', async () => ((await health()).feed.buyListings > 0 ? true : null));
    // Only the held item's sell listing is kept (keepSellListings 'watched').
    expect((await health()).feed.sellListings).toBe(1);

    // The market entry for its base reaches holdings: priced, sellable, told once.
    const revenue = 39 * K + 364; // 39 keys 40.44 ref
    const sellNotes = () => pushes.filter((p) => p.event === 'notify').map((p) => p.payload as PushContract['notify']);
    await waitFor('the sell notification', async () => sellNotes().length > 0);
    expect(sellNotes()).toEqual([{ title: 'Sell: Strange Australium Scattergun', body: expect.stringMatching(/^Sylvie pays 39 keys 40\.44 ref \(bot\), \+9 keys .* over your cost$/), sku: ITEM }]);
    const r = await call<HoldingsResult>('holdings.list');
    expect(r.rows).toEqual([
      expect.objectContaining({ sku: ITEM, qty: 1, revenueScrap: revenue, profitNowScrap: revenue - 30 * K, status: 'sell', buyerCount: 1 }),
    ]);
    expect(r.totals).toMatchObject({ items: 1, units: 1, sellable: 1, worthNowScrap: revenue });

    // Recorded as sold: the lot is gone and so is the watch; new sell listings of it are dropped again.
    await call('journal.delete', { id: bought.id });
    expect(pushes.filter((p) => p.event === 'journal.changed')).toHaveLength(2);
    expect((await call<HoldingsResult>('holdings.list')).rows).toEqual([]);
    const other = wsSample.events.find((e) => e.payload?.intent === 'buy' && e !== order)!;
    sockets[0]!.send([sellOf(order, '99999999902'), other]);
    await waitFor('the second feed batch', async () => ((await health()).feed.buyListings > 1 ? true : null));
    expect((await health()).feed.sellListings).toBe(1);

    // Nothing above made a request.
    expect(requested).toEqual([]);
    expect(sellNotes()).toHaveLength(1);
  }, 30_000);
});
