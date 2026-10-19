// F11 holdings in the browser mock: 'holdings.list' from the mock journal's open
// FIFO lots against the mock books (every status shows), the 'holdings' CSV,
// 'journal.changed' after journal.add / journal.delete, and the Live market's
// v0.3 fields (H1 stats, H2 limit, F13 coverage), so the pages can be built in
// `npm run dev:renderer`. Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { HOLDINGS_CSV_COLUMNS, holdingComparator, holdingFigures, holdingsTotals } from '../../src/shared/holdings';
import { SCRAPTF_BANK_PAGES } from '../../src/shared/links';
import { MARKET_MAX_LIMIT } from '../../src/shared/market';
import { PUSH_EVENTS, SERVICE_METHODS, type PushContract } from '../../src/shared/rpc';
import { HOLDING_STATUSES } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('contract', () => {
  it('holdings.list is a service method and journal.changed a push event', () => {
    expect(SERVICE_METHODS).toContain('holdings.list');
    expect(PUSH_EVENTS).toContain('journal.changed');
  });
});

describe('holdings.list', () => {
  it('lists the open lots with every status, sellable first', async () => {
    const b = make();
    const settings = await b.rpc('settings.get', undefined);
    const res = await b.rpc('holdings.list', {});
    const summary = await b.rpc('journal.summary', undefined);
    expect(res.rows.map((r) => r.sku).sort()).toEqual(summary.open.map((p) => p.sku).sort());
    expect(new Set(res.rows.map((r) => r.status))).toEqual(new Set(HOLDING_STATUSES));
    expect(res.rows.map((r) => r.sku)).toEqual([...res.rows].sort(holdingComparator).map((r) => r.sku));
    for (const r of res.rows) {
      const pos = summary.open.find((p) => p.sku === r.sku)!;
      expect(r).toMatchObject({ qty: pos.qty, costScrap: pos.costScrap, nextLotCostScrap: pos.lots[0]!.costScrap, heldSince: pos.lots[0]!.ts, name: pos.name });
      // Judged on the better exit (F14): the revenue, or scrap.tf's list price when that is better.
      expect(r).toMatchObject(holdingFigures({ ...r, revenueScrap: r.exitScrap }, settings.profit));
      expect(r.revenueOrder?.valueScrap ?? null).toBe(r.revenueScrap);
      expect(r.buyerCount > 0).toBe(r.revenueScrap !== null);
    }
    expect(res.rows.some((r) => r.qty > 1)).toBe(true);
    expect(res.totals).toEqual(holdingsTotals(res.rows));
    expect(res.keyPrice?.valueScrap).toBe(568);
    expect(res.generatedAt).toBe(T0);
  });

  it('prices a held SKU like its Live market row', async () => {
    const b = make();
    const held = (await b.rpc('holdings.list', {})).rows.filter((r) => r.buyerCount > 0);
    const market = await b.rpc('market.list', { limit: MARKET_MAX_LIMIT });
    for (const h of held) {
      const m = market.rows.find((r) => r.sku === h.sku)!;
      expect(m).toBeDefined();
      expect(h).toMatchObject({ revenueScrap: m.revenueScrap, buyerCount: m.buyerCount, confidence: m.confidence, lastOrderChangeAt: m.lastOrderChangeAt });
    }
  });

  it('searches, validates, and leaves totals over everything held', async () => {
    const b = make();
    const all = await b.rpc('holdings.list', {});
    const knife = await b.rpc('holdings.list', { search: 'knife' });
    expect(knife.rows.map((r) => r.name)).toEqual(['Strange Knife']);
    expect(knife.totals).toEqual(all.totals);
    await expect(b.rpc('holdings.list', { search: 'x'.repeat(201) })).rejects.toThrow(/Invalid parameters for holdings\.list/);
  });

  it('follows the journal: a sale closes the oldest lot, a buy adds one, and both push journal.changed', async () => {
    const b = make();
    const pushes: PushContract['journal.changed'][] = [];
    b.on('journal.changed', (p) => pushes.push(p));
    const knife = async () => (await b.rpc('holdings.list', { search: 'knife' })).rows[0];
    const before = (await knife())!;
    expect(before.qty).toBe(2);

    const sale = await b.rpc('journal.add', { side: 'sell', venue: 'backpack.tf', sku: '194;11', scrap: 60, note: 'Sold to a bot' });
    expect(pushes).toEqual([{ at: T0 }]);
    const after = (await knife())!;
    expect(after.qty).toBe(1);
    expect(after.costScrap).toBe(before.costScrap - before.nextLotCostScrap);

    await b.rpc('journal.delete', { id: sale.id });
    expect(pushes).toHaveLength(2);
    expect((await knife())!.qty).toBe(2);

    await b.rpc('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 1, scrap: 10 });
    expect(pushes).toHaveLength(3);
    expect((await b.rpc('holdings.list', { search: 'captain' })).rows[0]).toMatchObject({ sku: '378;6', qty: 1, costScrap: 568 + 10 });
  });
});

describe("opps.exportCsv kind 'holdings'", () => {
  it('writes the holdings in the page order, filtered by the search', async () => {
    const b = make();
    const r = await b.rpc('opps.exportCsv', { kind: 'holdings', holdings: {} });
    expect(r.suggestedName).toMatch(/^flipdesk-holdings-.*\.csv$/);
    const lines = r.csv.trim().split('\r\n');
    expect(lines[0]).toBe(HOLDINGS_CSV_COLUMNS.join(','));
    const rows = (await b.rpc('holdings.list', {})).rows;
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(rows.map((x) => x.sku));
    const one = await b.rpc('opps.exportCsv', { kind: 'holdings', holdings: { search: 'earbuds' } });
    expect(one.csv.trim().split('\r\n')).toHaveLength(2);
  });
});

describe('Live market v0.3 fields', () => {
  it('reports no rebuild error, takes a 2000-row window, and lists saved-page coverage', async () => {
    const b = make();
    expect(MARKET_MAX_LIMIT).toBe(2000);
    const res = await b.rpc('market.list', { limit: 2000 });
    expect(res.rows).toHaveLength(Math.min(2000, res.total));
    expect(res.stats).toMatchObject({ lastError: null, retryAt: null });
    const cov = res.scraptf.coverage;
    expect(cov.map((c) => c.url)).toEqual(SCRAPTF_BANK_PAGES.map((p) => p.url));
    const age = (label: string) => {
      const c = cov.find((x) => x.label === label)!;
      return c.lastSavedAt === null ? null : (T0 - c.lastSavedAt) / MIN;
    };
    // Minutes, hours and never, as a user who saves some pages more often than others.
    expect(age('Hats')).toBe(4);
    expect(age('Unusuals')).toBe(12);
    expect(age('Stranges')).toBe(70);
    expect(age('Weapons')).toBe(300);
    expect(age('Skins')).toBeNull();
    // The /items list page counts for no bank page.
    expect(age('Items')).toBeNull();
    expect(cov.find((x) => x.label === 'Hats')!.items).toBe(48);
  });

  it('moves a bank page to "just saved" when a page of it is imported', async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    await b.rpc('import.pickFile', undefined);
    const hats = (await b.rpc('market.list', {})).scraptf.coverage.find((c) => c.label === 'Hats')!;
    expect(hats.lastSavedAt).toBe(T0 - 30_000);
    expect(hats.items).toBe(3);
  });
});
