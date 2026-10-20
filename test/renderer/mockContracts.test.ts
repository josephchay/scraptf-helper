// The browser mock must behave like the real app where the UI depends on it,
// so it cannot hide gaps between the renderer and main or the service.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { PushEvent } from '../../src/shared/rpc';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

function collect(b: MockBridge, event: PushEvent): unknown[] {
  const seen: unknown[] = [];
  b.on(event, (p) => seen.push(p));
  return seen;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('mock contracts', () => {
  it('import.pickWatchFolder only returns the folder, like main; the page must save it', async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const changes = collect(b, 'settings.changed');
    const r = await b.rpc('import.pickWatchFolder', undefined);
    expect(r.folder).toMatch(/scrap\.tf pages$/);
    expect((await b.rpc('settings.get', undefined)).import.watchFolder).toBeNull();
    expect(changes).toHaveLength(0);
    await b.rpc('settings.set', { import: { watchFolder: r.folder } });
    expect((await b.rpc('settings.get', undefined)).import.watchFolder).toBe(r.folder);
  });

  it('pushes prices.changed for every price or rule write, so other windows refresh', async () => {
    const b = make();
    const pushes = collect(b, 'prices.changed');
    const p = await b.rpc('prices.upsert', { sku: '378;6', costScrap: 30 });
    expect(pushes).toHaveLength(1);
    await b.rpc('prices.delete', { id: p.id });
    expect(pushes).toHaveLength(2);
    const r = await b.rpc('rules.upsert', { name: 'hats', filter: {}, costScrap: 16 });
    await b.rpc('rules.delete', { id: r.id });
    expect(pushes).toHaveLength(4);
    expect(pushes[0]).toEqual({ at: T0 });
  });

  it('exports only the opportunities matching the dashboard filters', async () => {
    const b = make();
    const all = await b.rpc('opps.exportCsv', { kind: 'opportunities' });
    const profitable = await b.rpc('opps.exportCsv', { kind: 'opportunities', query: { status: ['profitable'], categories: ['hats'] } });
    const listed = await b.rpc('opps.list', { status: ['profitable'], categories: ['hats'], limit: 5000 });
    const rows = (csv: string) => csv.trim().split('\r\n').slice(1);
    expect(rows(profitable.csv)).toHaveLength(listed.total);
    expect(rows(profitable.csv).length).toBeLessThan(rows(all.csv).length);
    expect(rows(profitable.csv).every((line) => line.endsWith(',profitable') && line.includes(',hats,'))).toBe(true);
  });

  it('caps the automatic key price at the scrap.tf sell price like the service, but never a manual one', async () => {
    const b = make();
    const auto = (await b.rpc('status.get', undefined)).keyPrice!.valueScrap;
    // Dated as the Settings page dates them: the newer of these and the saved list's key row applies (F14).
    await b.rpc('settings.set', { keyPrice: { scraptfSellScrap: auto - 10, scraptfObservedAt: T0 } });
    expect((await b.rpc('status.get', undefined)).keyPrice!.valueScrap).toBe(auto - 10);
    await b.rpc('settings.set', { keyPrice: { scraptfSellScrap: auto + 10, scraptfObservedAt: T0 } });
    expect((await b.rpc('status.get', undefined)).keyPrice!.valueScrap).toBe(auto);
    await b.rpc('settings.set', { keyPrice: { mode: 'manual', manualScrap: auto + 20, scraptfSellScrap: auto - 10, scraptfObservedAt: T0 } });
    expect((await b.rpc('status.get', undefined)).keyPrice!.valueScrap).toBe(auto + 20);
  });
});

// Audit xcontract-2 (0.7.3): as the service, the events export writes the Live log's kinds, category and search.
describe('mock events export', () => {
  const ids = (csv: string) => csv.trim().split('\r\n').slice(1).map((l) => Number(l.split(',')[0]));

  it("honours the Live log's filters like the service, and refuses what the service refuses", async () => {
    const b = make();
    const all = await b.rpc('opps.events', { limit: 2000 });
    expect(ids((await b.rpc('opps.exportCsv', { kind: 'events' })).csv)).toEqual(all.map((e) => e.id));
    const want = all.filter((e) => e.kind === 'appeared' && e.category === 'hats' && `${e.name} ${e.sku} ${e.summary}`.toLowerCase().includes('profit'));
    expect(want.length).toBeGreaterThan(0);
    const filtered = await b.rpc('opps.exportCsv', { kind: 'events', events: { kinds: ['appeared'], category: 'hats', search: 'PROFIT' } });
    expect(ids(filtered.csv)).toEqual(want.map((e) => e.id));
    for (const events of [{ kinds: ['vanished'] }, { category: 'boats' }, { search: 'x'.repeat(201) }]) {
      await expect(b.rpc('opps.exportCsv', { kind: 'events', events } as never)).rejects.toThrow(/Invalid parameters for opps\.exportCsv/);
    }
  });
});
