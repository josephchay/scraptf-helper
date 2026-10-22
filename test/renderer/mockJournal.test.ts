// 0.8 journal mock parity (J1, J2, J5, J6, H5, write-offs): the browser mock books with the shared journalSummary
// (no hand copy), refuses the fees, write-offs and edits the service refuses, announces an edit once, writes the
// service's ledger CSV cell for cell, and puts the user's typical hold on Holdings rows as the service does. Its
// seeded journal has five closed flips, one of them a write-off, so the preview's Results show rates.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockJournalSummary } from '../../src/renderer/mockData';
import { journalCsv } from '../../src/service/domain/csv';
import { JOURNAL_CSV_COLUMNS, JOURNAL_ENTRY_GONE, JOURNAL_MAX_FEE_KEYS, JOURNAL_MAX_FEE_SCRAP, journalSummary, typicalHoldOf } from '../../src/shared/journal';
import { holdingsValuationOf, journalValuerOf } from '../../src/shared/holdings';
import type { JournalInput } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = 86_400_000;

const bridges: MockBridge[] = [];
afterEach(() => {
  while (bridges.length) bridges.pop()!.dispose();
});

function mock(): MockBridge {
  const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  bridges.push(b);
  return b;
}

const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'answered',
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

const BUY: JournalInput = { side: 'buy', venue: 'scrap.tf', sku: '5021;6', name: 'Mann Co. Supply Crate Key', keys: 0, scrap: 90, ts: T0 - 2 * DAY };

describe('the mock journal (0.8)', () => {
  it('books with the shared journalSummary itself', async () => {
    const b = mock();
    expect(mockJournalSummary).toBe(journalSummary);
    const rows = await b.rpc('journal.list', { limit: 10_000 });
    expect(await b.rpc('journal.summary', undefined)).toEqual(journalSummary(rows));
  });

  it('seeds five closed flips, one of them a write-off, and leaves Holdings as before', async () => {
    const b = mock();
    const s = await b.rpc('journal.summary', undefined);
    expect(s.closed).toHaveLength(5);
    expect(s.closed.filter((c) => c.kind === 'writeoff').map((c) => c.name)).toEqual(['Ghastly Gibus']);
    expect(s.closed.reduce((t, c) => t + c.profitScrap, 0)).toBe(s.realizedProfitScrap);
    // The Mann Co. Cap's fees are recorded on both sides.
    expect(s.closed.find((c) => c.sku === '261;6')).toMatchObject({ feesScrap: 2, feesKnown: true, sellVenue: 'marketplace.tf' });
    const held = (await b.rpc('holdings.list', {})).rows.map((r) => r.sku);
    expect(held).not.toContain('261;6');
    expect(held).not.toContain('116;6');
  });

  it('refuses the fees and write-offs the service refuses', async () => {
    const b = mock();
    const before = (await b.rpc('journal.list', { limit: 10_000 })).length;
    expect(await refusal(b.rpc('journal.add', { ...BUY, feeScrap: -1 }))).not.toBe('answered');
    expect(await refusal(b.rpc('journal.add', { ...BUY, feeKeys: JOURNAL_MAX_FEE_KEYS + 1 }))).not.toBe('answered');
    expect(await refusal(b.rpc('journal.add', { ...BUY, feeScrap: JOURNAL_MAX_FEE_SCRAP + 1 }))).not.toBe('answered');
    const writeoff: JournalInput = { side: 'writeoff', venue: 'Written off', sku: '5021;6', keys: 0, scrap: 0, ts: T0 - DAY };
    expect(await refusal(b.rpc('journal.add', { ...writeoff, scrap: 9 }))).toMatch(/write-off receives nothing/);
    expect(await refusal(b.rpc('journal.add', { ...writeoff, keys: 1 }))).toMatch(/write-off receives nothing/);
    expect(await refusal(b.rpc('journal.add', { ...writeoff, feeScrap: 0 }))).toMatch(/write-off receives nothing/);
    expect((await b.rpc('journal.list', { limit: 10_000 })).length).toBe(before);

    // A plain write-off closes the oldest lot at its cost.
    await b.rpc('journal.add', BUY);
    const w = await b.rpc('journal.add', writeoff);
    const s = await b.rpc('journal.summary', undefined);
    expect(s.closed.find((c) => c.sellId === w.id)).toMatchObject({ kind: 'writeoff', costScrap: 90, proceedsScrap: 0, profitScrap: -90 });
  });

  it('journal.update edits venue, note and fee, emits journal.changed once, and refuses what the service refuses', async () => {
    const b = mock();
    const pushes: number[] = [];
    b.on('journal.changed', (p) => pushes.push(p.at));
    const sale = await b.rpc('journal.add', { ...BUY, side: 'sell', venue: 'backpack.tf', scrap: 120, ts: T0 - DAY });
    pushes.length = 0;
    const edited = await b.rpc('journal.update', { id: sale.id, venue: ' marketplace.tf ', note: ' cut ', feeKeys: 0, feeScrap: 12 });
    expect(edited).toEqual({ ...sale, venue: 'marketplace.tf', note: 'cut', feeKeys: 0, feeScrap: 12 });
    expect(pushes).toHaveLength(1);
    const cleared = await b.rpc('journal.update', { id: sale.id, feeKeys: null, feeScrap: null });
    expect('feeKeys' in cleared).toBe(false);
    expect(pushes).toHaveLength(2);

    expect(await refusal(b.rpc('journal.update', { id: 99_999, note: 'x' }))).toBe(JOURNAL_ENTRY_GONE);
    expect(await refusal(b.rpc('journal.update', { id: sale.id, feeScrap: -1 }))).toMatch(/fee/i);
    expect(await refusal(b.rpc('journal.update', { id: sale.id, venue: '  ' }))).toMatch(/^Invalid parameters for journal\.update: venue/);
    const w = (await b.rpc('journal.list', { limit: 10_000 })).find((e) => e.side === 'writeoff')!;
    expect(await refusal(b.rpc('journal.update', { id: w.id, feeScrap: 2 }))).toMatch(/write-off receives nothing/);
    expect(pushes).toHaveLength(2);
  });

  it("exports the service's ledger: the shared columns, one line per row, cell for cell", async () => {
    const b = mock();
    const rows = await b.rpc('journal.list', { limit: 10_000 });
    const { csv } = await b.rpc('journal.exportCsv', undefined);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(JOURNAL_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(rows.length + 1);
    // 0.9: the open lots valued as the service values them, over an unfiltered holdings read.
    const valuer = journalValuerOf(holdingsValuationOf(await b.rpc('holdings.list', {})), (await b.rpc('settings.get', undefined)).profit);
    expect(csv).toBe(journalCsv(rows, valuer).replace(/^﻿/, ''));
    // A negative profit stays a number (the service's csvCell), not a formula-guarded text.
    const writeoff = lines.find((l) => l.includes(',writeoff,'))!;
    // 0.9: then the open-lot valuation columns, blank on a write-off.
    expect(writeoff).toMatch(/,closed,\d+,1,0,,-1,\d+(\.\d+)?,,,$/);
  });

  it("puts the user's typical hold on Holdings rows, from every open position, as the service does", async () => {
    const b = mock();
    // One more sale makes five, enough for a typical hold over all sales ('all').
    await b.rpc('journal.add', { ...BUY, ts: T0 - 3 * DAY });
    await b.rpc('journal.add', { ...BUY, side: 'sell', venue: 'backpack.tf', scrap: 99, ts: T0 - DAY });
    const s = await b.rpc('journal.summary', undefined);
    const hold = typicalHoldOf(s.closed, s.open);
    const rows = (await b.rpc('holdings.list', {})).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.typicalHold).toEqual(hold(r.sku) ?? undefined);
    expect(rows[0]!.typicalHold).toMatchObject({ scope: 'all', count: 5, stillHeld: s.open.reduce((t, p) => t + p.qty, 0) });
  });

  it('adds no typicalHold key with too few sales', async () => {
    const b = mock();
    for (const r of (await b.rpc('holdings.list', {})).rows) expect('typicalHold' in r).toBe(false);
  });
});
