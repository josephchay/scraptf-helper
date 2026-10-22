// 0.9 (#3, #12) mock parity: the browser mock answers the risk keys and the suggested reserve with the same shared
// rules as the service. Every Opportunities row carries exitRiskAt over the mock's own book at its cost (the engine's
// rule), every Live market row exitRiskAt at marketRiskCost (the service's toRow), both sorts follow the shared
// comparators, both CSVs carry the D10 columns, and 'profit.reserveSuggestion' is reserveSuggestionOf over the seeded
// exit runs, the history 'item.detail' served and the journal's typical hold. Nothing leaves the page.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { MOCK_KEY_SCRAP, mockKeyHistory } from '../../src/renderer/mockData';
import { revenueOrderOf, sortOpportunities } from '../../src/renderer/oppModel';
import { buyerDepthOf, exitOrdersOfSummaries } from '../../src/shared/ceiling';
import { formatScrap } from '../../src/shared/currency';
import { exitDepthOf, exitRiskAt, liquidityTagOf, marketRiskFields, opportunityRiskFields } from '../../src/shared/exitRisk';
import { typicalHoldOf } from '../../src/shared/journal';
import { MARKET_CSV_COLUMNS, marketComparator, marketRiskCost } from '../../src/shared/market';
import { reserveSuggestionOf } from '../../src/shared/reserveSuggest';
import { baseSku } from '../../src/shared/sku';
import type { HistoryPoint, HoldingMark, ItemDetail, MarketRow, Opportunity, Settings } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const fetchSpy = vi.fn(() => Promise.reject(new Error('the mock must not fetch')));

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, marketBuildMs: 0, now: () => T0 });
  return bridge;
}

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
});

/** Minimal RFC 4180 reader (the mock's CSV has no BOM). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The engine's rule over the drawer's book (the mock's eligible orders, its outliers flagged), at the row's cost. */
function expectedOppFields(o: Opportunity, d: ItemDetail, profit: Settings['profit']) {
  const orders = exitOrdersOfSummaries(d.buyOrders);
  const order = revenueOrderOf(o, profit.useOrder);
  const next = buyerDepthOf(orders, order?.listingId ?? null, profit.useOrder).nextBuyer;
  return opportunityRiskFields(exitRiskAt({ exitDepth: exitDepthOf(orders, profit.useOrder), nextBuyer: next }, o.costScrap, profit));
}

function riskOf(o: Partial<Pick<Opportunity, 'backupProfitScrap' | 'profitableDepth' | 'bookDepth'>> | Partial<Pick<MarketRow, 'backupProfitScrap' | 'profitableDepth' | 'bookDepth'>>) {
  const out: Record<string, unknown> = {};
  for (const k of ['backupProfitScrap', 'profitableDepth', 'bookDepth'] as const) if (k in o) out[k] = o[k];
  return out;
}

describe('0.9 (#3): Opportunities in the mock', () => {
  it("every row's three fields are exitRiskAt over the mock's own book at its cost", async () => {
    const b = make();
    const settings = await b.rpc('settings.get', undefined);
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    expect(rows.length).toBeGreaterThan(0);
    let withBook = 0;
    let withBackup = 0;
    for (const o of rows) {
      const d = await b.rpc('item.detail', { sku: o.sku, history: false });
      expect(d, o.key).not.toBeNull();
      expect(riskOf(o), o.key).toEqual(expectedOppFields(o, d!, settings.profit));
      if (typeof o.bookDepth === 'number') withBook++;
      if (typeof o.backupProfitScrap === 'number') withBackup++;
      // Buyers at break-even never exceeds the book depth, and both are whole counts.
      if (typeof o.profitableDepth === 'number') expect(o.profitableDepth).toBeLessThanOrEqual(o.bookDepth!);
    }
    expect(withBook).toBe(rows.length);
    expect(withBackup).toBeGreaterThan(0);
  });

  it('follows friction and the price-move reserve (a higher break-even never adds buyers)', async () => {
    const b = make();
    const before = new Map((await b.rpc('opps.list', { limit: 5000 })).rows.map((o) => [o.key, o.profitableDepth]));
    const settings = await b.rpc('settings.set', { profit: { frictionScrap: 9, exitReservePct: 0.1 } });
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    let fewer = 0;
    for (const o of rows) {
      const d = await b.rpc('item.detail', { sku: o.sku, history: false });
      expect(riskOf(o), o.key).toEqual(expectedOppFields(o, d!, settings.profit));
      const was = before.get(o.key);
      if (typeof was === 'number' && typeof o.profitableDepth === 'number') {
        expect(o.profitableDepth, o.key).toBeLessThanOrEqual(was);
        if (o.profitableDepth < was) fewer++;
      }
    }
    expect(fewer).toBeGreaterThan(0);
  });

  it("'opps.list' sorted by backup or depth equals sortOpportunities", async () => {
    const b = make();
    const all = (await b.rpc('opps.list', { limit: 5000 })).rows;
    for (const sort of ['backup', 'depth'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const { rows } = await b.rpc('opps.list', { limit: 5000, sort, dir });
        expect(rows.map((o) => o.key), `${sort} ${dir}`).toEqual(sortOpportunities(all, sort, dir).map((o) => o.key));
      }
    }
  });

  it('the Opportunities CSV appends backup_profit, profitable_depth, book_depth and book_depth_tag after break_even (D10)', async () => {
    const b = make();
    const kp = (await b.rpc('status.get', undefined)).keyPrice!.valueScrap;
    const { csv } = await b.rpc('opps.exportCsv', { kind: 'opportunities' });
    const [head, ...lines] = parseCsv(csv);
    expect(head!.slice(head!.indexOf('break_even'))).toEqual(['break_even', 'backup_profit', 'profitable_depth', 'book_depth', 'book_depth_tag']);
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    const sorted = sortOpportunities(rows, 'profit', 'desc');
    expect(lines).toHaveLength(sorted.length);
    const at = head!.indexOf('backup_profit');
    lines.forEach((line, i) => {
      const o = sorted[i]!;
      expect(line[head!.indexOf('sku')], o.key).toBe(o.sku);
      expect(line.slice(at), o.key).toEqual([
        o.backupProfitScrap === undefined ? '' : formatScrap(o.backupProfitScrap, kp).replace(/^-/, "'-"),
        o.profitableDepth === undefined ? '' : String(o.profitableDepth),
        o.bookDepth === undefined ? '' : String(o.bookDepth),
        liquidityTagOf(o.bookDepth) ?? '',
      ]);
    });
  });
});

describe('0.9 (#3): the Live market in the mock', () => {
  it("every row's fields are exitRiskAt at marketRiskCost; a row with no buyers has none", async () => {
    const b = make();
    const settings = await b.rpc('settings.get', undefined);
    const { rows } = await b.rpc('market.list', { limit: 500 });
    expect(rows.length).toBeGreaterThan(0);
    let judged = 0;
    let unjudged = 0;
    for (const r of rows) {
      if (r.buyerCount === 0) {
        expect(riskOf(r), r.sku).toEqual({});
        continue;
      }
      const d = await b.rpc('item.detail', { sku: r.sku, history: false });
      const orders = exitOrdersOfSummaries(d!.buyOrders);
      const next = buyerDepthOf(orders, r.revenueOrder?.listingId ?? null, settings.profit.useOrder).nextBuyer;
      const expected = marketRiskFields(exitRiskAt({ exitDepth: exitDepthOf(orders, settings.profit.useOrder), nextBuyer: next }, marketRiskCost(r), settings.profit));
      expect(riskOf(r), r.sku).toEqual(expected);
      if (marketRiskCost(r) === null) {
        unjudged++;
        expect(r.profitableDepth, r.sku).toBeNull();
        expect(r, r.sku).not.toHaveProperty('backupProfitScrap');
      } else judged++;
    }
    expect(judged).toBeGreaterThan(0);
    expect(unjudged).toBeGreaterThan(0);
  });

  it("{ sort: 'depth' } and { sort: 'backup' } equal marketComparator", async () => {
    const b = make();
    for (const sort of ['depth', 'backup'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const { rows } = await b.rpc('market.list', { limit: 500, sort, dir });
        expect(rows.map((r) => r.sku), `${sort} ${dir}`).toEqual([...rows].sort(marketComparator(sort, dir)).map((r) => r.sku));
      }
    }
  });

  it("the market CSV's last four columns are the risk keys, the book depth and its tag", async () => {
    const b = make();
    expect(MARKET_CSV_COLUMNS.slice(-4)).toEqual(['backup_profit', 'profitable_depth', 'book_depth', 'book_depth_tag']);
    const { csv } = await b.rpc('opps.exportCsv', { kind: 'market', market: {} });
    const [head] = parseCsv(csv);
    expect(head!.slice(-4)).toEqual(['backup_profit', 'profitable_depth', 'book_depth', 'book_depth_tag']);
  });
});

describe('0.9 (#12): the suggested reserve in the mock', () => {
  it("is reserveSuggestionOf over the seeded runs, the history 'item.detail' served and the journal's typical hold", async () => {
    const b = make();
    // Before any drawer: no PriceDB history to read.
    const empty = await b.rpc('profit.reserveSuggestion', undefined);
    for (const band of empty.bands) expect(band.pricedb).toEqual({ windows: 0, items: 0 });

    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    const skus = [...new Set(rows.map((o) => o.sku))].slice(0, 3);
    expect(skus).toHaveLength(3);
    const histories = new Map<string, readonly HistoryPoint[]>();
    for (const sku of skus) {
      const d = await b.rpc('item.detail', { sku });
      expect(d!.history.length, sku).toBeGreaterThan(0);
      histories.set(baseSku(sku), d!.history);
    }
    // A preview without history (quick entry) adds nothing.
    await b.rpc('item.detail', { sku: rows[rows.length - 1]!.sku, history: false });

    // The seeded exit runs, as Holdings serves them per held item.
    const held = await b.rpc('holdings.list', {});
    const marks = new Map<number, HoldingMark>();
    for (const r of held.rows) for (const m of (await b.rpc('holdings.detail', { sku: r.sku })).marks) marks.set(m.id, m);
    expect(marks.size).toBeGreaterThan(0);
    const journal = await b.rpc('journal.summary', undefined);
    const keyScrap = (await b.rpc('status.get', undefined)).keyPrice!.valueScrap;

    const got = await b.rpc('profit.reserveSuggestion', undefined);
    const want = reserveSuggestionOf({
      marks: [...marks.values()].sort((x, y) => x.id - y.id),
      histories,
      hold: typicalHoldOf(journal.closed, journal.open)(''),
      keyScrap,
      settingsAt: null,
      now: T0,
      // Review: the preview's key history, as the service's pricedb.loadedKeyHistory() (Holdings' key band reads it too).
      keyHistory: { loadedAt: T0, points: mockKeyHistory(T0, MOCK_KEY_SCRAP) },
    });
    expect(got).toEqual(want);
    expect(got.bands.some((band) => band.pricedb.windows > 0)).toBe(true);
    expect(got.generatedAt).toBe(T0);
  });

  it('values recorded exits in keys at the key history the mock serves (review: as the service, never the run start price)', async () => {
    const b = make();
    const held = await b.rpc('holdings.list', {});
    const marks = new Map<number, HoldingMark>();
    for (const r of held.rows) for (const m of (await b.rpc('holdings.detail', { sku: r.sku })).marks) marks.set(m.id, m);
    const journal = await b.rpc('journal.summary', undefined);
    const keyScrap = (await b.rpc('status.get', undefined)).keyPrice!.valueScrap;
    const args = { marks: [...marks.values()].sort((x, y) => x.id - y.id), histories: new Map(), hold: typicalHoldOf(journal.closed, journal.open)(''), keyScrap, settingsAt: null, now: T0 };
    const got = await b.rpc('profit.reserveSuggestion', undefined);
    expect(got).toEqual(reserveSuggestionOf({ ...args, keyHistory: { loadedAt: T0, points: mockKeyHistory(T0, MOCK_KEY_SCRAP) } }));
    // The seeded runs include keyed exits: without the key history none of their ends is observed.
    const without = reserveSuggestionOf(args);
    for (let i = 0; i < got.bands.length; i++) expect(without.bands[i]!.recorded.windows).toBeLessThanOrEqual(got.bands[i]!.recorded.windows);
    expect(got.bands[2]!.recorded.windows).toBeGreaterThan(without.bands[2]!.recorded.windows);
  });

  it('carries the buyer-settings change stamp the advice uses (markSettings.at)', async () => {
    const b = make();
    expect((await b.rpc('profit.reserveSuggestion', undefined)).settingsAt).toBeNull();
    await b.rpc('settings.set', { profit: { useOrder: 'best' } });
    const s = await b.rpc('profit.reserveSuggestion', undefined);
    expect(s.settingsAt).toBe(T0);
  });

  it('nothing is fetched', async () => {
    const b = make();
    await b.rpc('opps.list', { limit: 5000 });
    await b.rpc('market.list', { limit: 500, sort: 'depth' });
    await b.rpc('item.detail', { sku: (await b.rpc('opps.list', { limit: 1 })).rows[0]!.sku });
    await b.rpc('profit.reserveSuggestion', undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
