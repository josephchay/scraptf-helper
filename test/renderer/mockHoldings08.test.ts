// 0.8 holdings parity in the browser mock (H1, H3, H4, H6, H7): every 'holdings.list' row carries the ask side, the
// references, the last snapshot and the advice, each the shared rule over the same mock data (askSideOf,
// holdingRefsOf, holdingAdvice over 'holdings.detail''s history), 'holdings.detail' answers by the service's rules
// for a held, a painted, an unheld, a currency and an invalid SKU, the holdings CSV gains its three columns, and
// Settings → Your accounts changes what "Others ask" may include. Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { MOCK_KEY_SCRAP, mockKeyHistory, usableReferences } from '../../src/renderer/mockData';
import { HOLDING_DETAIL_LEAD_MS, HOLDING_DETAIL_MAX_CLOSED, HOLDING_DETAIL_UNHELD_MS, HOLDING_MARK_GAP_MS, holdingAdvice, holdingExitHistory, keyMoveBandOf } from '../../src/shared/holdingAdvice';
import { HOLDINGS_CSV_COLUMNS, askSideOf, holdingRefsOf, holdingsCsvCells, type AskCandidate } from '../../src/shared/holdings';
import { closedTradesOf, typicalHold } from '../../src/shared/journal';
import type { HoldingRow, ItemDetail, Settings } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
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

/** The held rows, after reading each item's detail first (the mock builds a book on first sight of an item it has none for). */
async function heldWithDetails(b: MockBridge): Promise<{ rows: HoldingRow[]; details: Map<string, ItemDetail>; settings: Settings; K: number }> {
  const first = await b.rpc('holdings.list', {});
  const details = new Map<string, ItemDetail>();
  for (const r of first.rows) details.set(r.sku, (await b.rpc('item.detail', { sku: r.sku, history: false }))!);
  const res = await b.rpc('holdings.list', {});
  return { rows: res.rows, details, settings: await b.rpc('settings.get', undefined), K: res.keyPrice!.valueScrap };
}

/** The service's askCandidatesOf over the drawer's sell listings: every mock sell order is a clean copy. */
function candidatesOf(d: ItemDetail, settings: Settings, K: number): AskCandidate[] {
  const blocked = new Set(settings.blocklist);
  return d.sellListings.map((o) => ({
    id: o.listingId,
    steamid: o.steamid,
    keys: o.keys,
    metalScrap: o.metalScrap,
    valueScrap: Math.round(o.keys * K) + o.metalScrap,
    isBot: o.isBot,
    lastEventAt: o.lastEventAt,
    excluded: !o.eligible || blocked.has(o.steamid) || o.flags.some((f) => f === 'marketplace' || f === 'banned' || f === 'blocklisted'),
  }));
}

describe("'holdings.list' rows (0.8)", () => {
  it('carry the ask, the references, the snapshot and the advice, the advice being holdingAdvice over the detail history', async () => {
    const b = make();
    const { rows, settings, K } = await heldWithDetails(b);
    // 0.9 (#17): the mock's book rows quote the key band of its key history, as the service's rows do.
    const keyBand = keyMoveBandOf(mockKeyHistory(T0, MOCK_KEY_SCRAP), T0);
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) {
      expect(r).toHaveProperty('ask');
      expect(r).toHaveProperty('refs');
      expect(r).toHaveProperty('snapshotAt');
      expect(r.advice).toBeDefined();
      const d = await b.rpc('holdings.detail', { sku: r.sku });
      expect(d.row).toEqual(r);
      expect(d.history).toEqual(holdingExitHistory(d.marks, r.heldSince, K, T0));
      const { advice, ...plain } = r;
      expect(advice).toEqual(holdingAdvice(plain, d.history, settings.profit, K, T0, d.baseSku === null ? { book: false } : { keyBand }));
    }
    // The band reaches the rows: a held row netting keys quotes it.
    expect(keyBand).not.toBeNull();
    expect(rows.some((r) => r.advice!.reasons.some((x) => x.code === 'key-exposure' && x.band !== undefined))).toBe(true);
    // The seeded runs give the preview more than one answer, and the reasons say what they rest on.
    expect(new Set(rows.map((r) => r.advice!.kind)).size).toBeGreaterThan(1);
    expect(rows.some((r) => r.advice!.basis !== null)).toBe(true);
    expect(rows.some((r) => r.advice!.reasons.some((x) => x.code === 'no-history'))).toBe(true);
  });

  it('take their ask and references from the shared rules over the same book, as the drawer does', async () => {
    const b = make();
    const { rows, details, settings, K } = await heldWithDetails(b);
    for (const r of rows) {
      const d = details.get(r.sku)!;
      expect(r.ask).toEqual(askSideOf(candidatesOf(d, settings, K), T0, new Set(settings.ownSteamIds)));
      // The item panel's Sell listings read the same ask.
      expect(d.ask ?? null).toEqual(r.ask);
      const u = usableReferences(d.references, settings, T0);
      expect(r.refs).toEqual(
        holdingRefsOf(
          { pricedb: u.pdbBuy !== null || u.pdbSell !== null ? d.references.pricedb : null, community: u.community !== null || u.communityHigh !== null ? d.references.community : null },
          u.stale,
        ),
      );
      expect(r.snapshotAt).toBe(d.snapshot.lastAt);
    }
    expect(rows.some((r) => r.ask !== null)).toBe(true);
    expect(rows.some((r) => r.refs !== null)).toBe(true);
    // Nobody's own ids are set yet: the lowest ask may be the user's own.
    for (const r of rows) if (r.ask) expect(r.ask).toMatchObject({ mayIncludeOwn: true, ownLeftOut: 0 });
  });

  it('Settings → Your accounts: own ids leave the ask, and "may include yours" goes', async () => {
    const b = make();
    const { rows, details, K } = await heldWithDetails(b);
    const r = rows.find((x) => x.ask !== null)!;
    expect(r).toBeDefined();
    const d = details.get(r.sku)!;
    const lowest = d.sellListings.find((o) => Math.round(o.keys * K) + o.metalScrap === r.ask!.lowestScrap)!;
    await b.rpc('settings.set', { ownSteamIds: ['76561197960287930'] });
    const other = (await b.rpc('holdings.list', {})).rows.find((x) => x.sku === r.sku)!;
    expect(other.ask).toEqual({ ...r.ask, mayIncludeOwn: false });
    const settings = await b.rpc('settings.set', { ownSteamIds: [lowest.steamid] });
    const mine = (await b.rpc('holdings.list', {})).rows.find((x) => x.sku === r.sku)!;
    expect(mine.ask).toEqual(askSideOf(candidatesOf(d, settings, K), T0, new Set([lowest.steamid])));
    expect(mine.ask?.ownLeftOut ?? 1).toBeGreaterThanOrEqual(1);
    expect((await b.rpc('item.detail', { sku: r.sku, history: false }))!.ask ?? null).toEqual(mine.ask);
  });
});

describe("'holdings.detail' (H7)", () => {
  it('a held SKU: its row, lots oldest first, closed trades, the marks window and the history', async () => {
    const b = make();
    const summary = await b.rpc('journal.summary', undefined);
    const knife = summary.open.find((p) => p.sku === '194;11')!;
    const d = await b.rpc('holdings.detail', { sku: ' 194;11 ' });
    const K = (await b.rpc('holdings.list', {})).keyPrice!.valueScrap;
    expect(d).toMatchObject({ sku: '194;11', baseSku: '194;11', truncated: false, keyScrap: K, generatedAt: T0 });
    expect(d.row?.sku).toBe('194;11');
    expect(d.lots).toEqual([...knife.lots].sort((a, b2) => a.ts - b2.ts));
    expect(d.lots).toHaveLength(2);
    expect(d.closed).toEqual(closedTradesOf(summary.closed, '194;11').slice(0, HOLDING_DETAIL_MAX_CLOSED));
    expect(d.typicalHold).toEqual(typicalHold(summary.closed, summary.open, '194;11'));
    // The seeded runs: 12 per held base, oldest first, all inside the window (from a week before the oldest lot).
    expect(d.marks).toHaveLength(12);
    expect(d.marks.every((m) => m.baseSku === '194;11' && m.toAt >= d.row!.heldSince - HOLDING_DETAIL_LEAD_MS)).toBe(true);
    expect(d.marks.map((m) => m.fromAt)).toEqual([...d.marks.map((m) => m.fromAt)].sort((a, b2) => a - b2));
    expect(d.marks[d.marks.length - 1]!.toAt).toBe(T0);
    // One silence longer than a run gap: the chart's 'unwatched' stretch.
    const gaps = d.marks.slice(1).map((m, i) => m.fromAt - d.marks[i]!.toAt);
    expect(gaps.filter((g) => g > HOLDING_MARK_GAP_MS)).toHaveLength(1);
    expect(d.history).toEqual(holdingExitHistory(d.marks, d.row!.heldSince, K, T0));
  });

  it('a painted SKU of a held base reads the base runs; an unheld SKU gets 30 days and no row; a currency none', async () => {
    const b = make();
    const painted = await b.rpc('holdings.detail', { sku: '143;6;p3100495' });
    expect(painted).toMatchObject({ sku: '143;6;p3100495', baseSku: '143;6', row: null, lots: [], history: null });
    expect(painted.marks).toHaveLength(12);
    expect(painted.marks.every((m) => m.baseSku === '143;6' && m.toAt >= T0 - HOLDING_DETAIL_UNHELD_MS)).toBe(true);

    const summary = await b.rpc('journal.summary', undefined);
    const sold = await b.rpc('holdings.detail', { sku: '378;6' });
    expect(sold).toMatchObject({ row: null, lots: [], marks: [], truncated: false, history: null });
    expect(sold.closed).toEqual(closedTradesOf(summary.closed, '378;6'));
    expect(sold.closed.length).toBeGreaterThan(0);

    const nothing = await b.rpc('holdings.detail', { sku: '160;3' });
    expect(nothing).toMatchObject({ row: null, lots: [], closed: [], marks: [], history: null, typicalHold: typicalHold(summary.closed, summary.open, '160;3') });

    const metal = await b.rpc('holdings.detail', { sku: '5002;6' });
    expect(metal).toMatchObject({ baseSku: null, marks: [] });
  });

  it('refuses what is not a SKU', async () => {
    const b = make();
    await expect(b.rpc('holdings.detail', { sku: 'not a sku' })).rejects.toThrow(/Invalid parameters for holdings\.detail/);
    await expect(b.rpc('holdings.detail', { sku: 7 } as unknown as { sku: string })).rejects.toThrow(/Invalid parameters for holdings\.detail/);
  });

  it('follows the journal: a sale of the last unit leaves the row and lists the trade', async () => {
    const b = make();
    const before = await b.rpc('holdings.detail', { sku: '143;6' });
    expect(before.row).not.toBeNull();
    await b.rpc('journal.add', { side: 'sell', venue: 'backpack.tf', sku: '143;6', keys: 1, scrap: 500 });
    const after = await b.rpc('holdings.detail', { sku: '143;6' });
    expect(after.row).toBeNull();
    expect(after.lots).toEqual([]);
    expect(after.closed[0]).toMatchObject({ sku: '143;6', kind: 'sell' });
    // Not held: the last 30 days of runs.
    expect(after.marks.every((m) => m.toAt >= T0 - 30 * DAY)).toBe(true);
  });
});

describe('review fixes (holdings), as the service', () => {
  it('a change to which buyers count starts the advice history there; a threshold change does not', async () => {
    const b = make();
    await b.rpc('settings.set', { profit: { referenceMaxAgeMs: 10 * DAY } });
    const K = (await b.rpc('holdings.list', {})).keyPrice!.valueScrap;
    for (const r of (await b.rpc('holdings.list', {})).rows) {
      const d = await b.rpc('holdings.detail', { sku: r.sku });
      expect(d.history).toEqual(holdingExitHistory(d.marks, r.heldSince, K, T0));
    }
    const settings = await b.rpc('settings.set', { blocklist: ['76561198000000009'] });
    const rows = (await b.rpc('holdings.list', {})).rows;
    // 0.9 (#17): the same options the mock passes (a book row's key band; a currency keeps { book: false }).
    const keyBand = keyMoveBandOf(mockKeyHistory(T0, MOCK_KEY_SCRAP), T0);
    for (const r of rows) {
      const d = await b.rpc('holdings.detail', { sku: r.sku });
      expect(d.history).toEqual(holdingExitHistory(d.marks, r.heldSince, K, T0, T0));
      expect(d.history!.settingsAt).toBe(T0);
      const { advice, ...plain } = r;
      expect(advice).toEqual(holdingAdvice(plain, d.history, settings.profit, K, T0, d.baseSku === null ? { book: false } : { keyBand }));
    }
    // Nothing recorded since the change can decide a hold yet.
    expect(rows.some((r) => r.advice!.kind === 'hold')).toBe(false);
    expect(rows.some((r) => r.advice!.reasons.some((x) => x.code === 'no-history' && x.settingsAt === T0))).toBe(true);
  });

  it('a held currency asks for no refresh and waits for no history', async () => {
    const b = make();
    await b.rpc('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '5021;6', keys: 1, scrap: 0 });
    const key = (await b.rpc('holdings.list', {})).rows.find((r) => r.sku === '5021;6')!;
    expect(key.status).toBe('no-buyers');
    expect(key.advice).toEqual({ kind: 'unclear', reasons: [{ code: 'no-exit' }], basis: null, refreshFirst: false });
  });
});

describe("opps.exportCsv kind 'holdings' (0.8)", () => {
  it('appends advice, next_buyer and lowest_ask, as the shared cells', async () => {
    const b = make();
    const r = await b.rpc('opps.exportCsv', { kind: 'holdings', holdings: {} });
    const lines = r.csv.trim().split('\r\n');
    expect(lines[0]).toBe(HOLDINGS_CSV_COLUMNS.join(','));
    expect(lines[0]!.endsWith('scraptf_pays,advice,next_buyer,lowest_ask')).toBe(true);
    const res = await b.rpc('holdings.list', {});
    res.rows.forEach((row, i) => {
      const tail = holdingsCsvCells(row, res.keyPrice!.valueScrap).slice(-3);
      expect(tail[0]).toBe(row.advice!.kind);
      expect(lines[i + 1]!.endsWith(`,${tail.join(',')}`)).toBe(true);
    });
  });
});
