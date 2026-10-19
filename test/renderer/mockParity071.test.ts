// 0.7.1 mock parity: the browser mock answers with the fields the service now fills, by the same shared
// rules, so `npm run dev:renderer` shows them: lastSeenAt / scraptfLastSeenAt (DM-5), the session baseline
// (CQ-2), wasFlip (ACT-10), a bank card's flips equal to its stock page's Flips chip (UX-2b), shopping's
// knownObservedAt / knownStock / knownStale (ACT-9, C's semantics), an import.report sample (P4) and
// skippedTotal / skippedCounts on imports (P5). Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { BANK_STOCK_MAX_LIMIT } from '../../src/shared/bankStock';
import { IMPORT_REPORT_RING } from '../../src/shared/importCodes';
import { SCRAPTF_CHANGES_MAX_LIMIT } from '../../src/shared/scraptfHistory';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('mock parity for 0.7.1', () => {
  it('bank stock rows and Live market rows carry their newest sighting (DM-5)', async () => {
    const b = make();
    const hats = await b.rpc('scraptf.bankStock', { bank: 'hats', limit: BANK_STOCK_MAX_LIMIT });
    const listed = hats.rows.filter((r) => r.listedSince !== null);
    expect(listed.length).toBeGreaterThan(0);
    for (const r of listed) {
      expect(r.lastSeenAt, r.key).toBe(hats.savedAt);
      expect(r.lastSeenAt! - r.listedSince!).toBeGreaterThanOrEqual(0);
    }
    const market = await b.rpc('market.list', { limit: 2000 });
    const withRun = market.rows.filter((r) => r.scraptfListedSince !== null);
    expect(withRun.length).toBeGreaterThan(0);
    for (const r of withRun) expect(r.scraptfLastSeenAt, r.sku).toBeGreaterThanOrEqual(r.scraptfListedSince!);
  });

  it('a bank card counts its stock page Flips chip (UX-2b)', async () => {
    const b = make();
    const banks = (await b.rpc('scraptf.banks', undefined)).banks;
    for (const card of banks) {
      if (card.bank === 'list') continue;
      const page = await b.rpc('scraptf.bankStock', { bank: card.bank, filter: 'flips', limit: BANK_STOCK_MAX_LIMIT });
      if (page.savedAt === null) continue;
      expect(card.flips, card.bank).toBe(page.counts.flips);
    }
  });

  it('a Flip pill only on the newest event of a copy on sale; superseded ones say they were one (ACT-10)', async () => {
    const b = make();
    const events = await b.rpc('scraptf.changes', { limit: SCRAPTF_CHANGES_MAX_LIMIT });
    expect(events.some((e) => e.wasFlip === true)).toBe(true);
    // Per copy, its newest price event and its newest stock move (a stock move at the same price does not
    // supersede the price event, which the feed shows by default).
    const sortOf = (e: { bank: string; key: string; kind: string }) => `${e.bank}|${e.key}|${e.kind === 'stock' ? 'stock' : 'price'}`;
    const newestOf = new Map<string, number>();
    for (const e of events) newestOf.set(sortOf(e), Math.max(newestOf.get(sortOf(e)) ?? 0, e.id));
    for (const e of events) {
      if (e.flip) expect(e.id, e.key).toBe(newestOf.get(sortOf(e)));
      if (e.wasFlip) expect(e.flip).toBe(false);
    }
  });

  it('shopping rows say how old and how stocked the known price is, stale past profit.inputStaleMs (ACT-9)', async () => {
    const b = make();
    const r = await b.rpc('shopping.list', {});
    const known = r.rows.filter((x) => x.knownCostScrap !== null);
    expect(known.length).toBeGreaterThan(0);
    for (const x of r.rows) {
      expect(x).toHaveProperty('knownObservedAt');
      expect(x).toHaveProperty('knownStale');
      if (x.knownCostScrap === null) expect(x).toMatchObject({ knownObservedAt: null, knownStock: null, knownStale: false });
      else expect(x.knownStale, x.sku).toBe(T0 - x.knownObservedAt! > DEFAULT_SETTINGS.profit.inputStaleMs);
    }
  });

  it('answers a whitelisted import.report sample and checks its limit (P4)', async () => {
    const b = make();
    const reports = await b.rpc('import.report', undefined);
    expect(reports).toHaveLength(1);
    const [rep] = reports;
    expect(Object.keys(rep!).sort()).toEqual(['at', 'bank', 'batchId', 'counts', 'format', 'headerColumns', 'id', 'items', 'name', 'origin', 'page', 'pageKind', 'warningCodes']);
    for (const item of rep!.items) expect(Object.keys(item).every((k) => ['defindex', 'classTokens', 'title', 'contentLines', 'indicator', 'itemValue', 'numAvailable', 'numSelected', 'particleId', 'warpaintId', 'cells', 'limitAttrs', 'sku', 'warnings'].includes(k))).toBe(true);
    expect(JSON.stringify(reports)).not.toMatch(/7656119\d{10}|Gifted by|avatar/i);
    expect(await b.rpc('import.report', { limit: 1 })).toHaveLength(1);
    await expect(b.rpc('import.report', { limit: IMPORT_REPORT_RING + 1 })).rejects.toThrow(/limit/);
  });

  it('imports carry skippedTotal and skippedCounts (P5)', async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const page = await b.rpc('import.pickFile', undefined);
    expect(page).toMatchObject({ skippedTotal: page!.skipped.length });
    expect(Object.values(page!.skippedCounts ?? {}).reduce((n, c) => n + c, 0)).toBe(page!.skippedTotal);
    const list = await b.rpc('import.html', { html: '<html></html>', fileName: 'scrap.tf - Items.html', mtimeMs: T0 });
    expect(list.skippedTotal).toBe(list.skipped.length);
    if (list.skipped.length > 0) expect(list.skippedCounts).toEqual({ 'out of stock on scrap.tf': list.skippedTotal });
  });
});
