// F20 in the browser mock: about 20 saves per bank over 10 days (drift, items coming and going,
// restocks), 'scraptf.itemHistory', 'scraptf.changes' with its CSV, the 'scraptf.changed' push after an
// import, the listed fields of bank stock and market rows, and the re-save reminder settings, all by
// the shared rules (src/shared/scraptfHistory.ts). Fake data; nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { SCRAPTF_CHANGES_CSV_COLUMNS } from '../../src/shared/scraptfHistory';
import { SCRAPTF_CHANGE_KINDS, type ScraptfChangeEvent } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

async function feed(b: MockBridge): Promise<ScraptfChangeEvent[]> {
  const out: ScraptfChangeEvent[] = [];
  let page = await b.rpc('scraptf.changes', { limit: 500 });
  while (page.length > 0) {
    out.push(...page);
    page = await b.rpc('scraptf.changes', { limit: 500, beforeId: page[page.length - 1]!.id });
  }
  return out;
}

describe('the change feed', () => {
  it('has every kind of change over about ten days of saves, newest first, valued now', async () => {
    const b = make();
    const all = await feed(b);
    expect(all.length).toBeGreaterThan(50);
    for (const kind of SCRAPTF_CHANGE_KINDS) expect(all.some((e) => e.kind === kind), kind).toBe(true);
    expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((x, y) => y - x));
    const at = all.map((e) => e.at);
    expect(Math.min(...at)).toBeLessThan(T0 - 8 * DAY);
    expect(Math.max(...at)).toBeLessThanOrEqual(T0);
    // Killstreaks has one save (a first save writes nothing); skins and items were never saved.
    expect(new Set(all.map((e) => e.bank))).toEqual(new Set(['hats', 'unusuals', 'stranges', 'weapons', 'list']));
    const cheaper = all.find((e) => e.kind === 'cheaper')!;
    expect(cheaper.deltaScrap!).toBeLessThan(0);
    expect(cheaper.key).toBe(`${cheaper.sku}|${cheaper.specialKey}`);
    // The live buy side is joined: some cheaper or new rows are flips now.
    expect(all.some((e) => e.flip && e.toValueScrap! <= e.maxCostScrap!)).toBe(true);
  });

  it('filters by bank, kind and SKU, and pages by id', async () => {
    const b = make();
    const hats = await b.rpc('scraptf.changes', { bank: 'hats', limit: 500 });
    expect(hats.length).toBeGreaterThan(0);
    expect(hats.every((e) => e.bank === 'hats')).toBe(true);
    const gone = await b.rpc('scraptf.changes', { kinds: ['gone', 'restocked'], limit: 500 });
    expect(gone.every((e) => e.kind === 'gone' || e.kind === 'restocked')).toBe(true);
    const sku = hats[0]!.sku;
    const mine = await b.rpc('scraptf.changes', { sku, limit: 500 });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.sku === sku)).toBe(true);
    const first = await b.rpc('scraptf.changes', { limit: 5 });
    expect(first).toHaveLength(5);
    const next = await b.rpc('scraptf.changes', { limit: 5, beforeId: first[4]!.id });
    expect(next[0]!.id).toBeLessThan(first[4]!.id);
    expect((await b.rpc('scraptf.changes', undefined as never)).length).toBe(100);
    for (const bad of [{ bank: 'moon' }, { kinds: ['sold'] }, { limit: 501 }, { beforeId: 0 }, { sku: 'not a sku' }]) {
      await expect(b.rpc('scraptf.changes', bad as never), JSON.stringify(bad)).rejects.toThrow(/Invalid parameters for scraptf\.changes/);
    }
  });

  it('exports the feed as CSV with its filters, paging dropped', async () => {
    const b = make();
    const r = await b.rpc('opps.exportCsv', { kind: 'scraptfChanges', scraptfChanges: { bank: 'weapons', limit: 1 } });
    const lines = r.csv.trim().split('\r\n');
    expect(lines[0]).toBe(SCRAPTF_CHANGES_CSV_COLUMNS.join(','));
    const weapons = await b.rpc('scraptf.changes', { bank: 'weapons', limit: 500 });
    expect(lines).toHaveLength(weapons.length + 1);
    expect(lines.slice(1).every((l) => l.split(',')[1] === 'weapons')).toBe(true);
    expect(r.suggestedName).toMatch(/^flipdesk-scraptf-changes-.+\.csv$/);
  });
});

describe("'scraptf.itemHistory'", () => {
  it('shows a price per save, time listed and the changes of an item on a saved bank', async () => {
    const b = make();
    const stock = await b.rpc('scraptf.bankStock', { bank: 'hats', limit: 2000 });
    const listed = stock.rows.filter((r) => r.listedSince !== null && !r.hasExtras).sort((x, y) => x.listedSince! - y.listedSince!);
    expect(listed.length).toBeGreaterThan(0);
    const row = listed[0]!;
    const h = await b.rpc('scraptf.itemHistory', { sku: row.sku });
    expect(h).toMatchObject({ sku: row.sku, specialKey: '', bank: 'hats', listedSince: row.listedSince, firstSeenAt: row.firstSeenAt, generatedAt: T0 });
    expect(h.points.length).toBeGreaterThan(5);
    expect(h.points.every((p) => p.bank === 'hats')).toBe(true);
    expect(h.current).not.toBeNull();
    expect(h.change.listed).toEqual(row.changeSinceListed);
    expect(h.events.every((e) => e.sku === row.sku && e.specialKey === '')).toBe(true);
  });

  it('answers an empty history for an item no save listed, and refuses a bad SKU', async () => {
    const b = make();
    const h = await b.rpc('scraptf.itemHistory', { sku: '5021;6' });
    expect(h).toMatchObject({ bank: null, points: [], current: null, listedSince: null });
    await expect(b.rpc('scraptf.itemHistory', { sku: 'nope' })).rejects.toThrow(/Invalid parameters for scraptf\.itemHistory/);
  });
});

describe('listed fields elsewhere', () => {
  it('bank stock rows carry time listed; the Listed > 24 h and Dropped chips count and filter', async () => {
    const b = make();
    const all = await b.rpc('scraptf.bankStock', { bank: 'weapons', limit: 2000 });
    expect(all.rows.some((r) => r.listedSince !== null && T0 - r.listedSince > DAY)).toBe(true);
    const long = await b.rpc('scraptf.bankStock', { bank: 'weapons', filter: 'long-listed', limit: 2000 });
    expect(long.total).toBe(all.counts.longListed);
    expect(long.rows.every((r) => T0 - r.listedSince! >= DAY)).toBe(true);
    const dropped = await b.rpc('scraptf.bankStock', { bank: 'weapons', filter: 'dropped', limit: 2000 });
    expect(dropped.total).toBe(all.counts.dropped);
    expect(dropped.rows.every((r) => r.changeSinceListed!.deltaScrap < 0)).toBe(true);
    const sorted = await b.rpc('scraptf.bankStock', { bank: 'weapons', sort: 'listed', limit: 2000 });
    const starts = sorted.rows.map((r) => r.listedSince).filter((v): v is number => v !== null);
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
  });

  it('market rows carry scraptfListedSince, and "Listed on scrap.tf > 24 h" keeps only those', async () => {
    const b = make();
    const all = await b.rpc('market.list', { limit: 2000 });
    expect(all.rows.some((r) => r.scraptfListedSince !== null)).toBe(true);
    const long = await b.rpc('market.list', { limit: 2000, listedOnScraptf: true });
    expect(long.total).toBeGreaterThan(0);
    expect(long.total).toBeLessThan(all.total);
    expect(long.rows.every((r) => r.scraptfListedSince !== null && T0 - r.scraptfListedSince >= DAY)).toBe(true);
  });
});

describe('an import', () => {
  it("writes the new save's changes and pushes 'scraptf.changed' with their count", async () => {
    const b = make();
    const before = await b.rpc('scraptf.changes', { limit: 1 });
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const pushes: unknown[] = [];
    b.on('scraptf.changed', (p) => pushes.push(p));
    await b.rpc('import.pickFile', undefined);
    expect(pushes).toHaveLength(1);
    const p = pushes[0] as { at: number; count: number };
    expect(p.at).toBe(T0 - 30_000);
    const fresh = await b.rpc('scraptf.changes', { limit: 500 });
    const added = fresh.filter((e) => e.id > before[0]!.id);
    expect(added).toHaveLength(p.count);
    expect(added.every((e) => e.bank === 'hats' && e.at === T0 - 30_000)).toBe(true);
  });
});

describe('re-save reminder settings', () => {
  it('default off with every saved bank, and save like any setting', async () => {
    const b = make();
    expect((await b.rpc('settings.get', undefined)).import).toMatchObject({ resaveReminderMin: 0, resaveBanks: [] });
    const s = await b.rpc('settings.set', { import: { resaveReminderMin: 90, resaveBanks: ['hats', 'list'] } });
    expect(s.import).toMatchObject({ resaveReminderMin: 90, resaveBanks: ['hats', 'list'] });
  });
});
