// 0.9 holdings parity in the browser mock (#1, #17, the ledger's valuation): with Settings → Trade lock at 7 days each
// 'holdings.list' row carries the shared holdingTradeLockOf over its open lots, the advice reads Locked exactly when the
// next unit is locked, and the totals are holdingsTotals' (Sellable now leaves locked rows out); with the default
// answer nothing changes; a row netting keys quotes the band of the preview's key history (keyMoveBandOf over
// mockKeyHistory); the ledger CSV values the open lots as the service does (journalValuerOf over an unfiltered
// holdings read); and the drawer's row is the list's. Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { MOCK_KEY_SCRAP, mockKeyHistory } from '../../src/renderer/mockData';
import { journalCsv } from '../../src/service/domain/csv';
import { holdingTradeLockOf, keyMoveBandOf } from '../../src/shared/holdingAdvice';
import { holdingLockedNow, holdingsTotals, holdingsValuationOf, journalValuerOf } from '../../src/shared/holdings';
import { JOURNAL_CSV_COLUMNS } from '../../src/shared/journal';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY = 86_400_000;

let bridge: MockBridge | null = null;
function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

/** A held row whose next unit is tradable (bought 10 days ago) and one with a later unit still locked (bought yesterday). */
async function addOlderAndNewer(b: MockBridge): Promise<void> {
  // The seeded sale of 378;6 (8 days ago) takes the oldest buy, so the 9-day-old seeded buy stays open; a buy
  // yesterday is a later lot.
  await b.rpc('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 1, scrap: 100, ts: T0 - 10 * DAY });
  await b.rpc('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 1, scrap: 100, ts: T0 - DAY });
}

describe('the Trade lock in the mock (#1)', () => {
  it("with '7d': each row's tradeLock is holdingTradeLockOf over its open lots, and Locked advice exactly when the next unit is locked", async () => {
    const b = make();
    await addOlderAndNewer(b);
    await b.rpc('settings.set', { tradeLock: { mode: '7d', answeredAt: T0 } });
    const res = await b.rpc('holdings.list', {});
    const summary = await b.rpc('journal.summary', undefined);
    expect(res.rows.length).toBeGreaterThan(3);
    for (const r of res.rows) {
      const pos = summary.open.find((p) => p.sku === r.sku)!;
      const lots = [...pos.lots].sort((x, y) => x.ts - y.ts || x.id - y.id);
      expect(r.tradeLock, r.sku).toEqual(holdingTradeLockOf(lots, '7d', T0) ?? undefined);
      expect(r.advice!.kind === 'locked', r.sku).toBe(holdingLockedNow(r));
      if (r.advice!.kind === 'locked') expect(r.advice!.reasons[0]).toMatchObject({ code: 'trade-locked', tradableAt: r.tradeLock!.nextLotTradableAt, boughtAt: r.heldSince });
    }
    // The seeded holdings were all bought in the last 7 days; 378;6's next unit is 10 days old, its later one is not.
    expect(res.rows.filter((r) => holdingLockedNow(r)).length).toBeGreaterThan(2);
    const captain = res.rows.find((r) => r.sku === '378;6')!;
    expect(captain.tradeLock).toMatchObject({ lockedQty: 1, nextLotTradableAt: null, firstTradableAt: T0 - DAY + 7 * DAY });
    expect(captain.advice!.kind).not.toBe('locked');
    expect(captain.advice!.reasons.some((x) => x.code === 'units-locked')).toBe(true);
  });

  it("with '7d': the totals are holdingsTotals over every row (locked rows counted, not sellable)", async () => {
    const b = make();
    await addOlderAndNewer(b);
    await b.rpc('settings.set', { tradeLock: { mode: '7d', answeredAt: T0 } });
    const res = await b.rpc('holdings.list', {});
    expect(res.totals).toEqual(holdingsTotals(res.rows));
    expect(res.totals.locked).toBe(res.rows.filter((r) => holdingLockedNow(r)).length);
    expect(res.totals.sellable).toBe(res.rows.filter((r) => r.status === 'sell' && !holdingLockedNow(r)).length);
  });

  it('with the default answer no row has a lock, the kinds stay 0.8\'s and the totals have no locked count', async () => {
    const b = make();
    await addOlderAndNewer(b);
    const res = await b.rpc('holdings.list', {});
    for (const r of res.rows) {
      expect(r).not.toHaveProperty('tradeLock');
      expect(['sell-now', 'list', 'hold', 'unclear']).toContain(r.advice!.kind);
      expect(r.advice!.reasons.some((x) => x.code === 'trade-locked' || x.code === 'units-locked')).toBe(false);
    }
    expect(res.totals).not.toHaveProperty('locked');
    expect(res.totals).toEqual(holdingsTotals(res.rows));
    // An answered 'none' is the same.
    await b.rpc('settings.set', { tradeLock: { mode: 'none', answeredAt: T0 } });
    const none = await b.rpc('holdings.list', {});
    expect(none.rows).toEqual(res.rows);
  });

  it("'holdings.detail' gives the list's row, lock and advice included", async () => {
    const b = make();
    await addOlderAndNewer(b);
    await b.rpc('settings.set', { tradeLock: { mode: '7d', answeredAt: T0 } });
    const res = await b.rpc('holdings.list', {});
    for (const r of res.rows) expect((await b.rpc('holdings.detail', { sku: r.sku })).row, r.sku).toEqual(r);
  });
});

describe('the key move band in the mock (#17)', () => {
  it("a buy paid in keys of a metal-priced item quotes the preview's key band on its key-exposure reason", async () => {
    const b = make();
    const band = keyMoveBandOf(mockKeyHistory(T0, MOCK_KEY_SCRAP), T0);
    expect(band).not.toBeNull();
    expect(band!.spans).toBe(38);
    await b.rpc('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '1118;6', name: 'Taunt: Conga', keys: 2, scrap: 0 });
    const row = (await b.rpc('holdings.list', {})).rows.find((r) => r.sku === '1118;6')!;
    expect(row.exitScrap).not.toBeNull();
    const exposure = row.advice!.reasons.find((x) => x.code === 'key-exposure');
    expect(exposure).toMatchObject({ code: 'key-exposure', netKeys: -2, band });
  });

  it('is deterministic: 45 daily points to t0, sell 12 over buy', () => {
    const a = mockKeyHistory(T0, MOCK_KEY_SCRAP);
    expect(a).toEqual(mockKeyHistory(T0, MOCK_KEY_SCRAP));
    expect(a).toHaveLength(45);
    expect(a[44]!.t).toBe(Math.floor(T0 / 1000));
    expect(a[0]!.t).toBe(Math.floor(T0 / 1000) - 44 * 86_400);
    expect(a.every((p) => p.sellScrap === p.buyScrap! + 12)).toBe(true);
    expect(a[0]!.buyScrap).toBe(MOCK_KEY_SCRAP - 9 + 0 - 4);
  });
});

describe('the ledger CSV in the mock (valuation)', () => {
  it("values the open lots as the service: journalCsv with journalValuerOf over an unfiltered holdings read", async () => {
    const b = make();
    const rows = await b.rpc('journal.list', { limit: 10_000 });
    const settings = await b.rpc('settings.get', undefined);
    const { csv } = await b.rpc('journal.exportCsv', undefined);
    expect(csv).toBe(journalCsv(rows, journalValuerOf(holdingsValuationOf(await b.rpc('holdings.list', {})), settings.profit)).replace(/^﻿/, ''));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(JOURNAL_CSV_COLUMNS.join(','));
    expect(lines[0]!.endsWith(',worth_now_ref,unrealised_ref,valued_at')).toBe(true);
    // An open buy carries the read's time; a closed row ends blank.
    const iso = new Date(T0).toISOString();
    expect(lines.some((l) => l.includes(',open,') && l.endsWith(`,${iso}`))).toBe(true);
    expect(lines.filter((l) => l.includes(',closed,')).every((l) => l.endsWith(',,,'))).toBe(true);
  });

  it("with '7d' the values are unchanged (the lock changes no number)", async () => {
    const b = make();
    const before = (await b.rpc('journal.exportCsv', undefined)).csv;
    await b.rpc('settings.set', { tradeLock: { mode: '7d', answeredAt: T0 } });
    expect((await b.rpc('journal.exportCsv', undefined)).csv).toBe(before);
  });
});
