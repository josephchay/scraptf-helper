// 0.8 journal RPCs (J2 fees, write-offs, J6 edit, J5 ledger CSV) through the real rpc handlers over a real repo
// (audit-074-typed-price-replace's harness): a fee round-trips and lowers the booked profit, a bad fee or a
// write-off that receives something is refused, an edit changes venue, note and fee only and announces itself
// once, and the CSV header is the shared ledger's. Nothing is fetched.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { JOURNAL_CSV_COLUMNS, JOURNAL_ENTRY_GONE, JOURNAL_MAX_FEE_KEYS, JOURNAL_MAX_FEE_SCRAP } from '../../src/shared/journal';
import { SERVICE_METHODS } from '../../src/shared/rpc';
import type { JournalEntry, JournalSummary } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = 86_400_000;
const KEY = 577;

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const journalChanged = vi.fn();
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    http: { isPaused: () => false },
    engine: { keyPrice: () => ({ valueScrap: KEY }), markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    secret: () => null,
    push: quiet,
    pricesChanged: quiet,
    journalChanged,
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  const call = async <T>(method: string, params?: unknown) => (await rpc(method, params)) as T;
  const refusal = (method: string, params: unknown): Promise<string> =>
    rpc(method, params).then(
      () => 'answered',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
  return { repo, call, refusal, journalChanged };
}

const BUY = { side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 0, scrap: 90, ts: NOW - 2 * DAY } as const;
const SELL = { side: 'sell', venue: 'backpack.tf', sku: '378;6', name: 'Team Captain', keys: 0, scrap: 108, ts: NOW - DAY } as const;

describe('journal RPCs (0.8)', () => {
  it('lists journal.update among the service methods', () => {
    expect(SERVICE_METHODS).toContain('journal.update');
  });

  it('journal.add keeps a fee, and the summary books it off the profit', async () => {
    const h = setup();
    await h.call<JournalEntry>('journal.add', BUY);
    const sale = await h.call<JournalEntry>('journal.add', { ...SELL, feeScrap: 3 });
    expect(sale).toMatchObject({ feeKeys: 0, feeScrap: 3 });
    expect(h.repo.getJournal(sale.id)).toEqual(sale);
    const s = await h.call<JournalSummary>('journal.summary');
    expect(s.realizedProfitScrap).toBe(108 - 3 - 90);
    expect(s.closed).toHaveLength(1);
    expect(s.closed[0]).toMatchObject({ kind: 'sell', costScrap: 90, proceedsScrap: 105, feesScrap: 3, feesKnown: false, profitScrap: 15 });
  });

  it('refuses a negative fee or one over the cap', async () => {
    const h = setup();
    expect(await h.refusal('journal.add', { ...BUY, feeScrap: -1 })).toMatch(/feeScrap/);
    expect(await h.refusal('journal.add', { ...BUY, feeKeys: -0.5 })).toMatch(/feeKeys/);
    expect(await h.refusal('journal.add', { ...BUY, feeKeys: JOURNAL_MAX_FEE_KEYS + 1 })).toMatch(/feeKeys/);
    expect(await h.refusal('journal.add', { ...BUY, feeScrap: JOURNAL_MAX_FEE_SCRAP + 1 })).toMatch(/feeScrap/);
    expect(await h.call<JournalEntry[]>('journal.list', {})).toEqual([]);
  });

  it('refuses a write-off that receives anything; a plain one closes the oldest lot at its cost', async () => {
    const h = setup();
    const writeoff = { side: 'writeoff', venue: 'Written off', sku: '378;6', name: 'Team Captain', keys: 0, scrap: 0, ts: NOW - DAY };
    expect(await h.refusal('journal.add', { ...writeoff, scrap: 9 })).toMatch(/write-off receives nothing/);
    expect(await h.refusal('journal.add', { ...writeoff, keys: 1 })).toMatch(/write-off receives nothing/);
    expect(await h.refusal('journal.add', { ...writeoff, feeScrap: 0 })).toMatch(/write-off receives nothing/);
    expect(h.journalChanged).not.toHaveBeenCalled();

    await h.call('journal.add', BUY);
    const w = await h.call<JournalEntry>('journal.add', writeoff);
    expect(w).toMatchObject({ side: 'writeoff', keys: 0, scrap: 0 });
    expect(w.feeKeys).toBeUndefined();
    const s = await h.call<JournalSummary>('journal.summary');
    expect(s.open).toEqual([]);
    expect(s.closed).toEqual([expect.objectContaining({ kind: 'writeoff', sellId: w.id, costScrap: 90, proceedsScrap: 0, profitScrap: -90 })]);
    expect(s.realizedProfitScrap).toBe(-90);
  });

  it('journal.update changes venue, note and fee, announcing it once; null clears the fee', async () => {
    const h = setup();
    const sale = await h.call<JournalEntry>('journal.add', SELL);
    h.journalChanged.mockClear();

    const edited = await h.call<JournalEntry>('journal.update', { id: sale.id, venue: ' marketplace.tf ', note: ' cashed out ', feeKeys: 0, feeScrap: 10 });
    expect(h.journalChanged).toHaveBeenCalledTimes(1);
    expect(edited).toEqual({ ...sale, venue: 'marketplace.tf', note: 'cashed out', feeKeys: 0, feeScrap: 10 });
    expect(h.repo.getJournal(sale.id)).toEqual(edited);

    const cleared = await h.call<JournalEntry>('journal.update', { id: sale.id, feeKeys: null, feeScrap: null, note: null });
    expect(cleared).toEqual({ ...sale, venue: 'marketplace.tf', note: null });
    expect('feeKeys' in cleared).toBe(false);
    expect(h.journalChanged).toHaveBeenCalledTimes(2);
  });

  it('journal.update refuses an unknown row and a write-off fee', async () => {
    const h = setup();
    expect(await h.refusal('journal.update', { id: 9999, note: 'x' })).toBe(JOURNAL_ENTRY_GONE);
    await h.call('journal.add', BUY);
    const w = await h.call<JournalEntry>('journal.add', { side: 'writeoff', venue: 'Written off', sku: '378;6', keys: 0, scrap: 0, ts: NOW - DAY });
    h.journalChanged.mockClear();
    expect(await h.refusal('journal.update', { id: w.id, feeScrap: 2 })).toMatch(/write-off receives nothing/);
    expect(h.journalChanged).not.toHaveBeenCalled();
    // Its note can still change.
    expect(await h.call<JournalEntry>('journal.update', { id: w.id, note: 'lost' })).toMatchObject({ side: 'writeoff', note: 'lost' });
  });

  it("exports the shared ledger's columns", async () => {
    const h = setup();
    await h.call('journal.add', BUY);
    await h.call('journal.add', { ...SELL, feeScrap: 3 });
    const { csv } = await h.call<{ csv: string; suggestedName: string }>('journal.exportCsv');
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe(JOURNAL_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    // The sale closes the buy: fifo, matched buy and booked profit (15 scrap = 1.66 ref) appended.
    expect(lines[2]).toMatch(/,closed,1,10,11\.66,0\.33,1\.66,1$/);
  });
});
