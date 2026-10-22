// F10 Live market in the browser mock: market.list (rows, verdicts, counts,
// filters, sort, paging, the scrap.tf side, the first build), the 'market' CSV
// and the 'market.changed' pushes while mock orders move, so the page can be
// built and watched live in `npm run dev:renderer`.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge, type MockOptions } from '../../src/renderer/mock';
import { maxCostFor } from '../../src/shared/ceiling';
import { MARKET_CSV_COLUMNS, marketComparator, marketProfit, marketVerdict } from '../../src/shared/market';
import { PUSH_EVENTS, SERVICE_METHODS, type PushContract } from '../../src/shared/rpc';
import { CURRENCY_SKUS, MARKET_VERDICTS, type MarketListResult, type MarketRow } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function make(opts: MockOptions = {}): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0, ...opts });
  return bridge;
}

async function everything(b: MockBridge, q: Parameters<MockBridge['rpc']>[1] = {}): Promise<MarketListResult> {
  const first = await b.rpc('market.list', { ...(q as object), limit: 500 });
  const rows = [...first.rows];
  for (let offset = 500; offset < first.total; offset += 500) rows.push(...(await b.rpc('market.list', { ...(q as object), limit: 500, offset })).rows);
  return { ...first, rows };
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('contract', () => {
  it('market.list is a service method and market.changed a push event', () => {
    expect(SERVICE_METHODS).toContain('market.list');
    expect(PUSH_EVENTS).toContain('market.changed');
  });
});

describe('market.list rows', () => {
  it('holds one row per base SKU, priced like the engine, with a consistent verdict', async () => {
    const b = make();
    const settings = await b.rpc('settings.get', undefined);
    const res = await everything(b);
    expect(res.total).toBeGreaterThan(150);
    expect(res.rows).toHaveLength(res.total);
    expect(new Set(res.rows.map((r) => r.sku)).size).toBe(res.total);
    for (const r of res.rows) {
      expect(r.sku).not.toMatch(/;p\d/);
      expect(CURRENCY_SKUS).not.toContain(r.sku);
      expect(r.maxCostScrap).toBe(maxCostFor(r.revenueScrap, settings.profit));
      expect(r.verdict).toBe(marketVerdict(r));
      expect(r.profitScrap).toBe(marketProfit(r.revenueScrap, r.knownCostScrap, settings.profit));
      expect(r.revenueOrder?.valueScrap ?? null).toBe(r.revenueScrap);
      // Only items with buyers or a price of yours are in the market.
      expect(r.buyerCount > 0 || r.knownSource !== 'none').toBe(true);
      expect(r.knownSource === 'none').toBe(r.knownCostScrap === null);
      if (r.knownSource !== 'page') expect(r.stock).toBeNull();
      expect(r.evaluatedAt).toBe(T0);
    }
    // The real market is mostly items you have not priced.
    const counts = res.counts;
    expect(counts.unchecked).toBeGreaterThan(counts.flip);
    expect(counts.flip + counts.over).toBeGreaterThan(10);
    expect(MARKET_VERDICTS.reduce((n, v) => n + counts[v], 0)).toBe(res.total);
    expect(res.keyPrice?.valueScrap).toBeGreaterThan(0);
    expect(res.generatedAt).toBe(T0);
  });

  it('shows a typed price for an item without buyers as no-buyers, and the newest of typed and page wins', async () => {
    const b = make();
    await b.rpc('prices.upsert', { sku: '30359;6', costScrap: 20 });
    const jacket = (await b.rpc('market.list', { search: 'juggernaut' })).rows.find((r) => r.sku === '30359;6');
    expect(jacket).toMatchObject({ verdict: 'no-buyers', knownSource: 'typed', knownCostScrap: 20, buyerCount: 0, revenueScrap: null, name: 'Juggernaut Jacket' });

    await b.rpc('prices.upsert', { sku: '30359;6', costScrap: 25, source: 'import', observedAt: T0 + 1000, stock: 3 });
    const after = (await b.rpc('market.list', { search: 'juggernaut' })).rows.find((r) => r.sku === '30359;6');
    expect(after).toMatchObject({ knownSource: 'page', knownCostScrap: 25, stock: 3, knownObservedAt: T0 + 1000 });
  });

  it('joins a painted copy to its base item and flags it', async () => {
    const b = make();
    await b.rpc('prices.upsert', { sku: '105;6;p15185211', costScrap: 3, observedAt: T0 + 5000 });
    const helm = (await b.rpc('market.list', { search: 'brigade helm' })).rows.find((r) => r.sku === '105;6');
    expect(helm).toMatchObject({ knownCostScrap: 3, knownSource: 'typed' });
    expect(helm?.flags).toContain('has-extras');
  });

  it('gives a rule estimate and a rule flip when there is no known cost', async () => {
    const b = make();
    // 0.7.4 (F78): every tier, since the mock's bank saves show most Killstreak (tier 1) weapons at more than 1 scrap.
    await b.rpc('rules.upsert', { name: 'Cheap killstreaks', filter: { killstreak: [1, 2, 3] }, costScrap: 1 });
    const rows = (await everything(b, { verdicts: ['rule-flip'] })).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.knownSource).toBe('none');
      expect(r.ruleCostScrap).not.toBeNull();
      expect(r.ruleCostScrap!).toBeLessThanOrEqual(r.maxCostScrap!);
      // A rule never undercuts what a save showed: such a row is priced at it, and says so.
      expect(r.ruleCostScrap === 1 || r.flags.includes('rule-under-scraptf')).toBe(true);
    }
    expect(rows.some((r) => r.ruleCostScrap === 1)).toBe(true);
  });
});

describe('market.list query', () => {
  it('counts every verdict over the query without its own verdict filter', async () => {
    const b = make();
    const all = await b.rpc('market.list', {});
    for (const v of MARKET_VERDICTS) {
      const only = await b.rpc('market.list', { verdicts: [v], limit: 500 });
      expect(only.counts).toEqual(all.counts);
      expect(only.total).toBe(all.counts[v]);
      expect(only.rows.every((r) => r.verdict === v)).toBe(true);
    }
    const hats = await b.rpc('market.list', { categories: ['hats'] });
    expect(MARKET_VERDICTS.reduce((n, v) => n + hats.counts[v], 0)).toBe(hats.total);
    expect(hats.total).toBeLessThan(all.total);
  });

  it('filters by search, category, source, ceiling, bot buyers and buyers', async () => {
    const b = make();
    const check = async (q: Parameters<MockBridge['rpc']>[1], ok: (r: MarketRow) => boolean) => {
      const res = await everything(b, q);
      expect(res.total).toBeGreaterThan(0);
      expect(res.rows.every(ok)).toBe(true);
    };
    await check({ search: 'team captain' }, (r) => r.name.toLowerCase().includes('team captain'));
    await check({ categories: ['unusuals', 'taunts'] }, (r) => r.category === 'unusuals' || r.category === 'taunts');
    await check({ sources: ['page'] }, (r) => r.knownSource === 'page');
    await check({ sources: ['none'] }, (r) => r.knownSource === 'none');
    await check({ minCeilingScrap: 568 }, (r) => (r.maxCostScrap ?? -1) >= 568);
    await check({ onlyBotBuyers: true }, (r) => r.revenueOrder?.isBot === true);
    await check({ minBuyers: 3 }, (r) => r.buyerCount >= 3);
  });

  it('sorts by the shared comparator and pages in 200s by default', async () => {
    const b = make();
    const full = await everything(b);
    expect(full.rows.map((r) => r.sku)).toEqual([...full.rows].sort(marketComparator('ceiling', 'desc')).map((r) => r.sku));
    const first = await b.rpc('market.list', {});
    expect(first.rows).toHaveLength(Math.min(200, first.total));
    const page = await b.rpc('market.list', { limit: 5, offset: 5 });
    expect(page.rows.map((r) => r.sku)).toEqual(full.rows.slice(5, 10).map((r) => r.sku));
    for (const sort of ['revenue', 'buyers', 'profit', 'updated', 'name'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const res = await everything(b, { sort, dir });
        expect(res.rows.map((r) => r.sku)).toEqual([...res.rows].sort(marketComparator(sort, dir)).map((r) => r.sku));
      }
    }
  });

  it('refuses out-of-range paging and over-long searches like the service', async () => {
    const b = make();
    for (const bad of [{ limit: 0 }, { limit: 2001 }, { offset: -1 }, { search: 'x'.repeat(201) }]) {
      await expect(b.rpc('market.list', bad)).rejects.toThrow(/Invalid parameters for market\.list/);
    }
  });
});

describe('scrap.tf side and index state', () => {
  it('counts typed and saved-page items and reports import and folder watch', async () => {
    const b = make();
    const prices = await b.rpc('prices.list', {});
    const res = await b.rpc('market.list', {});
    expect(res.scraptf.typed).toBeGreaterThan(0);
    expect(res.scraptf.pages).toBeGreaterThan(0);
    const newest = Math.max(...prices.filter((p) => p.source === 'import').map((p) => p.observedAt));
    expect(res.scraptf.newestPageAt).toBe(newest);
    expect(res.scraptf).toMatchObject({ importEnabled: false, watchFolder: false });
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'C:\\pages' } });
    expect((await b.rpc('market.list', {})).scraptf).toMatchObject({ importEnabled: true, watchFolder: true });
    expect(res.stats).toMatchObject({ building: false, progress: 1, pendingDirty: 0 });
    expect(res.stats.entries).toBe((await everything(b)).rows.filter((r) => r.buyerCount > 0).length);
  });

  it('simulates the first build: building with progress, rows filling in', async () => {
    let t = T0;
    const b = make({ now: () => t, marketBuildMs: 10_000 });
    const start = await b.rpc('market.list', { limit: 500 });
    expect(start.stats).toMatchObject({ building: true, progress: 0, lastFullAt: null });
    t = T0 + 5_000;
    const half = await b.rpc('market.list', { limit: 500 });
    expect(half.stats.building).toBe(true);
    expect(half.stats.progress).toBeCloseTo(0.5);
    expect(half.total).toBeGreaterThan(start.total);
    t = T0 + 10_000;
    const done = await b.rpc('market.list', { limit: 500 });
    expect(done.stats).toMatchObject({ building: false, progress: 1, lastFullAt: T0 + 10_000 });
    expect(done.total).toBeGreaterThan(half.total);
  });
});

describe('market CSV', () => {
  it('exports every matching row in the page order, ignoring paging', async () => {
    const b = make();
    const q = { categories: ['unusuals' as const], sort: 'name' as const, limit: 3, offset: 2 };
    const r = await b.rpc('opps.exportCsv', { kind: 'market', market: q });
    expect(r.suggestedName).toMatch(/^flipdesk-market-.*\.csv$/);
    const lines = r.csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(MARKET_CSV_COLUMNS.join(','));
    const { limit: _l, offset: _o, ...filters } = q;
    const all = await everything(b, filters);
    expect(lines).toHaveLength(all.total + 1);
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(all.rows.map((x) => x.sku));
    expect(r.csv).not.toMatch(/(^|,)[=+@]/m);
  });

  it('exports the whole market without a query', async () => {
    const b = make();
    const r = await b.rpc('opps.exportCsv', { kind: 'market' });
    const total = (await b.rpc('market.list', {})).total;
    expect(r.csv.trimEnd().split('\r\n')).toHaveLength(total + 1);
  });
});

describe('live updates', () => {
  it('pushes market.changed while orders move, and the rows follow', async () => {
    let t = T0;
    const b = make({ now: () => t });
    const pushes: PushContract['market.changed'][] = [];
    b.on('market.changed', (p) => pushes.push(p));
    const before = await everything(b);
    for (let i = 0; i < 5; i++) {
      t += 4_000;
      b.tick();
    }
    expect(pushes.length).toBeGreaterThanOrEqual(3);
    for (const p of pushes) {
      expect(p.changed).toBeGreaterThan(0);
      expect(p.total).toBeGreaterThan(100);
      expect(p.at).toBeGreaterThan(T0);
    }
    const after = await everything(b);
    const prev = new Map(before.rows.map((r) => [r.sku, r.revenueScrap]));
    expect(after.rows.some((r) => prev.get(r.sku) !== r.revenueScrap)).toBe(true);
    expect(after.stats.lastChangeAt).toBe(pushes.at(-1)!.at);
  });

  it('keeps serving the last state while the network is paused', async () => {
    let t = T0;
    const b = make({ now: () => t });
    await b.rpc('settings.set', { networkPaused: true });
    const before = await everything(b);
    const pushes: unknown[] = [];
    b.on('market.changed', (p) => pushes.push(p));
    for (let i = 0; i < 10; i++) {
      t += 4_000;
      b.tick();
    }
    expect(pushes).toHaveLength(0);
    const after = await everything(b);
    expect(after.rows.map((r) => [r.sku, r.revenueScrap, r.maxCostScrap])).toEqual(before.rows.map((r) => [r.sku, r.revenueScrap, r.maxCostScrap]));
  });

  it('pushes when a settings change moves the ceilings, but not for a price write (prices.changed covers that)', async () => {
    const b = make();
    const pushes: PushContract['market.changed'][] = [];
    const priceEvents: unknown[] = [];
    b.on('market.changed', (p) => pushes.push(p));
    b.on('prices.changed', (p) => priceEvents.push(p));
    await b.rpc('prices.upsert', { sku: '378;6', costScrap: 40 });
    expect(priceEvents).toHaveLength(1);
    expect(pushes).toHaveLength(0);
    await b.rpc('settings.set', { profit: { minProfitScrap: 90 } });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.changed).toBeGreaterThan(10);
  });
});
