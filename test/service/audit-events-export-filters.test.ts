// Audit xcontract-2: the Live log's Export CSV on the Opportunity events tab writes the events matching
// the tab's kind chips, category and search (newest first, at most EVENTS_EXPORT_MAX), like every other
// export. Without `events` it still writes every event. Real repo (in memory) and real CSV; no network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Engine, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, type HandlerContext, type RpcHandler } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { KeyPriceState } from '../../src/shared/types';
import { makeEvent } from '../db/helpers';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const KEY: KeyPriceState = { valueScrap: 450, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

let repo: Repo;
let rpc: RpcHandler;

beforeEach(() => {
  repo = openRepo(':memory:');
  repo.appendEvents([
    makeEvent({ ts: 1_000, sku: '378;6', name: 'Team Captain', category: 'hats', kind: 'appeared', summary: 'profit 1.00 ref at cost 3.00 ref' }),
    makeEvent({ ts: 2_000, sku: '378;5;u13', name: 'Burning Flames Team Captain', category: 'unusuals', kind: 'notified', summary: 'desktop notification: +5 keys' }),
    makeEvent({ ts: 3_000, sku: '18;6', name: 'Rocket Launcher', category: 'weapons', kind: 'gone', summary: 'last eligible buy order was removed' }),
    makeEvent({ ts: 4_000, sku: '378;5;u17', name: 'Sunbeams Team Captain', category: 'unusuals', kind: 'changed', summary: 'profit 1 key -> 2 keys' }),
    makeEvent({ ts: 5_000, sku: '1;5;u17', name: 'Sunbeams Hat', category: 'unusuals', kind: 'notified', summary: 'desktop notification: new buyer' }),
  ]);
  const engine = { keyPrice: () => KEY, markDirty: () => {}, markAllDirty: () => {} } as unknown as Engine;
  const ctx = {
    clock: { now: () => NOW },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    repo,
    http: {},
    schema: {},
    pricedb: {},
    bptfApi: {},
    scm: {},
    engine,
    settings: () => DEFAULT_SETTINGS,
    secret: () => null,
    push: () => {},
    status: () => ({}),
    health: () => ({}),
    pricesChanged: () => {},
    queueSnapshot: () => {},
    snapshot: async () => {},
    snapshotStale: () => false,
    hostUnblocked: () => {},
  } as unknown as HandlerContext;
  rpc = createRpcHandlers(ctx);
});

afterEach(() => {
  repo.close();
});

/** The exported rows' names, in file order (newest first). */
async function exported(params: unknown): Promise<string[]> {
  const r = (await rpc('opps.exportCsv', params)) as { csv: string; suggestedName: string };
  expect(r.suggestedName).toMatch(/^flipdesk-events-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = r.csv.split(/\r?\n/).filter(Boolean);
  expect(lines[0]).toMatch(/^﻿?id,time,kind,sku,name,category,/);
  const names = new Map(repo.listEvents({ limit: 100 }).map((e) => [String(e.id), e.name] as const));
  return lines.slice(1).map((l) => names.get(l.split(',')[0]!) ?? `? ${l}`);
}

describe("'opps.exportCsv' kind 'events'", () => {
  it('without `events` exports every event, newest first (as before)', async () => {
    expect(await exported({ kind: 'events' })).toEqual(['Sunbeams Hat', 'Sunbeams Team Captain', 'Rocket Launcher', 'Burning Flames Team Captain', 'Team Captain']);
    expect(await exported({ kind: 'events', events: {} })).toHaveLength(5);
  });

  it("exports only the kinds and category the Live log shows, newest first", async () => {
    expect(await exported({ kind: 'events', events: { kinds: ['notified'], category: 'unusuals' } })).toEqual(['Sunbeams Hat', 'Burning Flames Team Captain']);
    expect(await exported({ kind: 'events', events: { category: 'hats' } })).toEqual(['Team Captain']);
    expect(await exported({ kind: 'events', events: { kinds: ['gone', 'changed'] } })).toEqual(['Sunbeams Team Captain', 'Rocket Launcher']);
  });

  it('applies the search like the page: every word, any case, across name, SKU and summary', async () => {
    expect(await exported({ kind: 'events', events: { kinds: ['notified'], category: 'unusuals', search: 'BURNING team' } })).toEqual(['Burning Flames Team Captain']);
    expect(await exported({ kind: 'events', events: { search: 'buyer' } })).toEqual(['Sunbeams Hat']);
    expect(await exported({ kind: 'events', events: { search: '378;5' } })).toEqual(['Sunbeams Team Captain', 'Burning Flames Team Captain']);
    expect(await exported({ kind: 'events', events: { search: 'captain nothing' } })).toEqual([]);
  });

  it('validates the filters', async () => {
    for (const events of [{ kinds: ['vanished'] }, { category: 'boats' }, { search: 'x'.repeat(201) }, { kinds: 'notified' }]) {
      await expect(rpc('opps.exportCsv', { kind: 'events', events })).rejects.toThrow(/Invalid parameters for opps\.exportCsv/);
    }
  });
});
