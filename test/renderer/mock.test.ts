import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockJournalSummary } from '../../src/renderer/mockData';
import { CATEGORIES } from '../../src/shared/types';
import { TIER_ORDER } from '../../src/renderer/oppModel';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function make(now = () => T0): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('mock bridge', () => {
  it('serves 60+ opportunities across every category, tier and confidence level', async () => {
    const b = make();
    const res = await b.rpc('opps.list', { limit: 5000 });
    expect(res.total).toBeGreaterThanOrEqual(60);
    expect(res.rows).toHaveLength(res.total);
    const cats = new Set(res.rows.map((o) => o.category));
    for (const c of CATEGORIES) expect(cats.has(c), c).toBe(true);
    const tiers = new Set(res.rows.map((o) => o.profitTier));
    for (const t of TIER_ORDER) expect(tiers.has(t), t).toBe(true);
    expect(new Set(res.rows.map((o) => o.confidenceLevel))).toEqual(new Set(['high', 'medium', 'low']));
    expect(new Set(res.rows.map((o) => o.inputKind))).toEqual(new Set(['user', 'import', 'rule']));
    expect(res.rows.some((o) => o.sku.includes(';p'))).toBe(true);
    expect(res.rows.some((o) => o.sku.includes('australium'))).toBe(true);
    expect(res.rows.some((o) => o.costKeys > 0 && o.category === 'unusuals')).toBe(true);
    expect(res.keyPrice?.valueScrap).toBe(568);
  });

  it('keeps opportunities internally consistent', async () => {
    const b = make();
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    for (const o of rows) {
      expect(o.key).toBe(`${o.sku}|${o.inputRef}`);
      expect(o.costScrap).toBe(o.costKeys * 568 + o.costScrapRaw);
      if (o.revenueScrap === null) {
        expect(o.profitScrap).toBeNull();
        expect(o.status).toBe('no-buyers');
      } else {
        expect(o.profitScrap).toBe(o.revenueScrap - o.costScrap);
      }
      expect(o.confidence).toBeGreaterThanOrEqual(0);
      expect(o.confidence).toBeLessThanOrEqual(100);
      if (o.inputKind === 'rule') expect(o.confidence).toBeLessThan(70);
    }
  });

  it('filters, sorts, pages and groups like the service contract', async () => {
    const b = make();
    const page = await b.rpc('opps.list', { status: ['profitable'], sort: 'profit', dir: 'desc', limit: 5, offset: 0, groupBy: 'tier' });
    expect(page.rows.length).toBeLessThanOrEqual(5);
    expect(page.rows.every((o) => o.status === 'profitable')).toBe(true);
    const profits = page.rows.map((o) => o.profitScrap ?? 0);
    expect([...profits].sort((x, y) => y - x)).toEqual(profits);
    expect(page.groups.every((g) => g.by === 'tier')).toBe(true);
    expect(page.groups.reduce((t, g) => t + g.count, 0)).toBe(page.total);
  });

  it('turns a typed price into an opportunity and pushes opps.changed', async () => {
    const b = make();
    const pushes: unknown[] = [];
    b.on('opps.changed', (p) => pushes.push(p));
    const price = await b.rpc('prices.upsert', { sku: '30359;6', costScrap: 16 });
    expect(price).toMatchObject({ sku: '30359;6', name: 'Juggernaut Jacket', source: 'user', costScrap: 16 });
    expect(pushes.length).toBe(1);
    const detail = await b.rpc('item.detail', { sku: '30359;6' });
    const o = detail?.opportunities.find((x) => x.inputRef === `price:${price.id}`);
    expect(o?.status).toBe('no-buyers');
    const events = await b.rpc('opps.events', { sku: '30359;6' });
    expect(events[0]?.kind).toBe('appeared');

    await b.rpc('prices.delete', { id: price.id });
    const after = await b.rpc('opps.events', { sku: '30359;6', kinds: ['gone'] });
    expect(after).toHaveLength(1);
  });

  it('rejects invalid inputs', async () => {
    const b = make();
    await expect(b.rpc('prices.upsert', { sku: '', costScrap: 1 })).rejects.toThrow(/item/);
    await expect(b.rpc('prices.upsert', { sku: '378;6', costScrap: -1 })).rejects.toThrow(/zero or more/);
    await expect(b.rpc('rules.upsert', { name: ' ', filter: {}, costScrap: 1 })).rejects.toThrow(/name/);
    await expect(b.rpc('journal.add', { side: 'buy', venue: '', sku: '378;6', scrap: 1 })).rejects.toThrow(/venue/);
  });

  it('gates saved-page import behind settings', async () => {
    const b = make();
    await expect(b.rpc('import.pickFile', undefined)).rejects.toThrow(/turned off/);
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const r = await b.rpc('import.pickFile', undefined);
    expect(r?.stored).toBeGreaterThan(0);
    const batches = await b.rpc('import.batches', { limit: 5 });
    expect(batches[0]?.id).toBe(r?.batchId);
  });

  it('stores only whether a secret exists', async () => {
    const b = make();
    expect((await b.rpc('status.get', undefined)).setupNeeded).toContain('bptf-token');
    const s = await b.rpc('secrets.set', { name: 'bptfAccessToken', value: 'abc123' });
    expect(s.bptfAccessToken).toBe(true);
    expect(JSON.stringify(s)).not.toContain('abc123');
    expect((await b.rpc('status.get', undefined)).setupNeeded).not.toContain('bptf-token');
    expect((await b.rpc('secrets.test', { name: 'bptfAccessToken' })).ok).toBe(true);
    await b.rpc('secrets.set', { name: 'bptfAccessToken', value: null });
    expect((await b.rpc('secrets.test', { name: 'bptfAccessToken' })).ok).toBe(false);
  });

  it('previews rules against the mock schema', async () => {
    const b = make();
    const p = await b.rpc('rules.preview', { name: 'x', filter: { categories: ['unusuals'], hasEffect: true }, costScrap: 0 });
    expect(p.matchingSkus).toBeGreaterThan(0);
    expect(p.sample.length).toBeGreaterThan(0);
  });

  it('simulates the live feed only while the network runs', async () => {
    let t = T0;
    const b = make(() => t);
    let changes = 0;
    b.on('opps.changed', () => changes++);
    for (let i = 0; i < 30; i++) {
      t += 4000;
      b.tick();
    }
    expect(changes).toBeGreaterThan(0);
    await b.rpc('settings.set', { networkPaused: true });
    changes = 0;
    for (let i = 0; i < 10; i++) b.tick();
    expect(changes).toBe(0);
    expect((await b.rpc('status.get', undefined)).feed).toBe('paused');
    expect((await b.rpc('health.get', undefined)).connectors.every((c) => c.state === 'paused' || c.state === 'off')).toBe(true);
  });

  it('scales to 5k opportunities for the virtualised table', async () => {
    bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0, stressRows: 5000 });
    const res = await bridge.rpc('opps.list', { limit: 5000 });
    expect(res.total).toBeGreaterThanOrEqual(5000);
    expect(res.rows).toHaveLength(5000);
    expect(new Set(res.rows.map((o) => o.key)).size).toBe(5000);
  });

  it('exports CSV with formula-safe cells', async () => {
    const b = make();
    const r = await b.rpc('opps.exportCsv', { kind: 'opportunities' });
    expect(r.suggestedName).toMatch(/^flipdesk-opportunities-.*\.csv$/);
    expect(r.csv.split('\r\n')[0]).toBe('sku,name,category,input,cost,revenue,profit,margin,confidence,buyers,status');
    expect(r.csv).not.toMatch(/(^|,)[=+@]/m);
  });
});

describe('mock journal FIFO', () => {
  it('matches sells to the oldest buys', () => {
    const base = { venue: 'x', keyPriceScrap: 568, note: null } as const;
    const s = mockJournalSummary([
      { id: 1, ts: 1, side: 'buy', sku: 'a', name: 'A', keys: 0, scrap: 10, ...base },
      { id: 2, ts: 2, side: 'buy', sku: 'a', name: 'A', keys: 0, scrap: 20, ...base },
      { id: 3, ts: 3, side: 'sell', sku: 'a', name: 'A', keys: 0, scrap: 25, ...base },
      { id: 4, ts: 4, side: 'sell', sku: 'b', name: 'B', keys: 1, scrap: 0, ...base },
    ]);
    expect(s.realizedProfitScrap).toBe(15);
    expect(s.realizedTrades).toBe(1);
    expect(s.open).toEqual([{ sku: 'a', name: 'A', qty: 1, costScrap: 20, lots: [{ id: 2, ts: 2, costScrap: 20, keys: 0, scrap: 20, keyPriceScrap: 568 }] }]);
    expect(s.bySku).toEqual([{ sku: 'a', name: 'A', realizedProfitScrap: 15, trades: 1 }]);
  });
});
