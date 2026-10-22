// 0.9: journal.exportCsv values each open buy as Holdings values it now (worth_now_ref, unrealised_ref, valued_at),
// from one local holdings.list read, through the real rpc handlers over a real repo (journalRpc.test.ts's harness).
// Closed rows stay blank in those columns, and a Holdings read that throws leaves them blank without failing the
// export. Nothing is fetched.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import type { Holdings } from '../../src/service/domain/holdings';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { scrapToRef } from '../../src/shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { holdingRow, holdingsResult, type HoldingBuySide } from '../../src/shared/holdings';
import { JOURNAL_CSV_COLUMNS, journalSummary } from '../../src/shared/journal';
import type { HoldingsResult, OrderSummary } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY = 86_400_000;
const KEY = 577;
// Holdings answered a little before the export: valued_at is its read time, not the export's.
const READ_AT = NOW - 5 * 60_000;

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup(list: (q: unknown, now: number) => HoldingsResult) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false }, profit: { frictionScrap: 1 } });
  const quiet = () => undefined;
  const warn = vi.fn();
  const log: Logger = { debug: quiet, info: quiet, warn, error: quiet };
  const holdingsList = vi.fn(list);
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    http: { isPaused: () => false },
    engine: { keyPrice: () => ({ valueScrap: KEY }), markDirty: quiet } as unknown as Engine,
    holdings: { list: holdingsList } as unknown as Holdings,
    settings: () => settings,
    secret: () => null,
    push: quiet,
    pricesChanged: quiet,
    journalChanged: quiet,
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  const call = async <T>(method: string, params?: unknown) => (await rpc(method, params)) as T;
  return { repo, call, warn, holdingsList, settings };
}

const BUY = { side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 0, scrap: 90, ts: NOW - 3 * DAY } as const;
const SELL = { side: 'sell', venue: 'backpack.tf', sku: '378;6', name: 'Team Captain', keys: 0, scrap: 108, ts: NOW - 2 * DAY } as const;
const OPEN = { ...BUY, scrap: 100, ts: NOW - DAY } as const;

function order(value: number): OrderSummary {
  return { listingId: 'o', steamid: 'S', userName: 'Buyer', keys: 0, metalScrap: value, valueScrap: value, isBot: true, online: null, lastEventAt: NOW - 60_000, bumpedAt: null, details: '', flags: [], eligible: true };
}

function side(value: number): HoldingBuySide {
  const o = order(value);
  return { revenueScrap: value, bestScrap: value, instantScrap: value, revenueOrder: o, bestOrder: o, buyerCount: 1, confidence: 60, confidenceLevel: 'medium', flags: [], lastOrderChangeAt: NOW - 60_000 };
}

/** Lines of the export without its BOM, each split into cells (no cell here holds a comma). */
async function exported(call: <T>(method: string, params?: unknown) => Promise<T>): Promise<string[][]> {
  const { csv } = await call<{ csv: string; suggestedName: string }>('journal.exportCsv');
  return csv
    .replace(/^﻿/, '')
    .trim()
    .split('\r\n')
    .map((l) => l.split(','));
}

describe('journal.exportCsv: the open lots valued (0.9)', () => {
  it("ends an open buy's line with its worth now, unrealised P/L and the read time; closed rows stay blank", async () => {
    // A fixed Holdings answer over the journal's own open position: the buyer pays 117 for the 100 scrap lot.
    let fixed: HoldingsResult | null = null;
    const h = setup(() => fixed!);
    await h.call('journal.add', BUY);
    await h.call('journal.add', SELL);
    const open = await h.call<{ id: number }>('journal.add', OPEN);
    const pos = journalSummary(h.repo.listJournal()).open[0]!;
    fixed = holdingsResult([holdingRow(pos, 'hats', side(117), h.settings.profit, KEY)], {}, { valueScrap: KEY, source: 'pricedb', observedAt: READ_AT, stale: false, quotes: [], scraptfFromList: null }, READ_AT);

    const lines = await exported(h.call);
    expect(lines[0]).toEqual([...JOURNAL_CSV_COLUMNS]);
    expect(lines).toHaveLength(4);
    expect(h.holdingsList).toHaveBeenCalledTimes(1);
    expect(h.holdingsList).toHaveBeenCalledWith({}, NOW);
    const byId = new Map(lines.slice(1).map((l) => [l[0], l]));
    // 117 - 100 - 1 friction = 16.
    expect(byId.get(String(open.id))!.slice(-3)).toEqual([String(scrapToRef(117)), String(scrapToRef(16)), new Date(READ_AT).toISOString()]);
    const closed = lines.slice(1).filter((l) => l[0] !== String(open.id));
    expect(closed).toHaveLength(2);
    for (const l of closed) {
      expect(l[JOURNAL_CSV_COLUMNS.indexOf('fifo')]).toBe('closed');
      expect(l.slice(-3)).toEqual(['', '', '']);
    }
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("leaves an open buy blank but dated when Holdings has no exit for it", async () => {
    const h = setup(() => holdingsResult([], {}, null, READ_AT));
    const open = await h.call<{ id: number }>('journal.add', OPEN);
    const lines = await exported(h.call);
    expect(lines.find((l) => l[0] === String(open.id))!.slice(-3)).toEqual(['', '', new Date(READ_AT).toISOString()]);
  });

  it('a Holdings read that throws leaves the columns blank, and the export still answers', async () => {
    const h = setup(() => {
      throw new Error('holdings down');
    });
    await h.call('journal.add', BUY);
    const lines = await exported(h.call);
    expect(lines).toHaveLength(2);
    expect(lines[1]![JOURNAL_CSV_COLUMNS.indexOf('fifo')]).toBe('open');
    expect(lines[1]!.slice(-3)).toEqual(['', '', '']);
    expect(lines[1]).toHaveLength(JOURNAL_CSV_COLUMNS.length);
    expect(h.warn).toHaveBeenCalledWith('Journal export could not value the open lots', { error: 'Error: holdings down' });
  });
});
