// F16 live check in the browser mock: 'check.text' (refusals, the four text forms, a mock revenue),
// 'check.recent' and the 'check.done' push as the service sends them; the popup's
// '#/check?demo=…' results; the window kind; and quick entry's prefill with price text.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowKind } from '../../src/renderer/api';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { CHECK_DEMOS, checkDemoFromHash, mockCheckDemo, mockCheckResult, mockParseCheck, type MockParsedCheck } from '../../src/renderer/mockCheck';
import { maxCostFor } from '../../src/shared/ceiling';
import {
  CHECK_EXTRAS_NOTE,
  CHECK_MAX_CHARS,
  CHECK_NOT_ITEM_REASON,
  CHECK_RECENT_MAX,
  CHECK_REFUSALS,
  CHECK_SAMPLE_TEXT,
  CHECK_SCRAPTF_LINK_REASON,
  CHECK_SOLD_OUT_NOTE,
} from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckResult, ItemDetail, ResolvedItem, ScrapPrice, ScraptfListRow } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
});

describe('mockParseCheck', () => {
  const resolve = (t: string): ResolvedItem | null => {
    const known: Record<string, string> = { 'team captain': '378;6', '378;6': '378;6' };
    const sku = known[t.trim().toLowerCase()];
    if (sku) return { sku, name: 'Team Captain', skuObject: {} as ResolvedItem['skuObject'], category: 'hats', match: 'exact', warnings: [] };
    if (/captian/i.test(t)) return { sku: '378;6', name: 'Team Captain', skuObject: {} as ResolvedItem['skuObject'], category: 'hats', match: 'fuzzy', warnings: [] };
    return null;
  };

  it('reads the four forms', () => {
    expect(mockParseCheck('Team Captain', resolve)).toMatchObject({ ok: true, parsed: { price: null } });
    expect(mockParseCheck('Team Captain, 1.33 ref', resolve)).toMatchObject({ ok: true, parsed: { price: { keys: 0, scrap: 12 } } });
    expect(mockParseCheck('Team Captain\n1 key 5.33 ref', resolve)).toMatchObject({ ok: true, parsed: { price: { keys: 1, scrap: 48 } } });
    expect(mockParseCheck('Team Captain\t1 key 22 ref\t1 key 18 ref\t3/12', resolve)).toMatchObject({
      ok: true,
      parsed: { price: { keys: 1, scrap: 198 }, pays: { keys: 1, scrap: 162 }, stock: 3, stockLimit: 12, soldOut: false },
    });
    expect(mockParseCheck('Team Captain    Sold out    1 key 18 ref    12/12', resolve)).toMatchObject({
      ok: true,
      parsed: { price: null, soldOut: true, stock: 12, stockLimit: 12 },
    });
  });

  it('refuses before parsing and never takes a fuzzy guess', () => {
    expect(mockParseCheck('<b>Team Captain</b>', resolve)).toEqual({ ok: false, status: 'refused', reason: CHECK_REFUSALS.markup });
    expect(mockParseCheck('a\nb\nc\nd', resolve)).toEqual({ ok: false, status: 'refused', reason: CHECK_REFUSALS.list });
    expect(mockParseCheck('Team Captian', resolve)).toEqual({ ok: false, status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
  });
});

describe("'check.text' and 'check.recent'", () => {
  it('checks the Settings sample as an item with the copied price, pushes check.done and keeps it', async () => {
    const b = make();
    const done: CheckResult[] = [];
    b.on('check.done', (r) => done.push(r));
    const settings = await b.rpc('settings.get', undefined);
    const r = await b.rpc('check.text', { text: CHECK_SAMPLE_TEXT, source: 'manual' });
    expect(r).toMatchObject({ status: 'item', source: 'manual', sku: '378;6', name: 'Team Captain', checkedAt: T0 });
    expect(r.price).toEqual({ keys: 0, scrapRaw: 12, valueScrap: 12, source: 'clipboard', observedAt: T0 });
    expect(r.revenue).not.toBeNull();
    expect(r.revenue!.maxCostScrap).toBe(maxCostFor(r.revenue!.revenueScrap, settings.profit));
    expect(r.profitScrap).toBe(r.revenue!.revenueScrap! - 12 - settings.profit.frictionScrap);
    expect(r.verdict).toBe('flip');
    expect(r.keyScrap).toBeGreaterThan(0);
    expect(done).toEqual([r]);
    expect(await b.rpc('check.recent', undefined)).toEqual([r]);
  });

  it('falls back to the saved list or a stored price, and says no-price without one', async () => {
    const b = make();
    const alone = await b.rpc('check.text', { text: 'Team Captain', source: 'watch' });
    expect(alone.status).toBe('item');
    expect(alone.price === null ? 'no-price' : alone.price.source).toMatch(/^(list|typed|import|no-price)$/);
    if (alone.price === null) expect(alone.verdict).toBe('no-price');
    if (alone.price?.source === 'list') expect(alone.listAt).toBe(alone.price.observedAt);
  });

  it('answers not-item and refused without pushing or keeping them', async () => {
    const b = make();
    const done: unknown[] = [];
    b.on('check.done', (r) => done.push(r));
    expect(await b.rpc('check.text', { text: 'zzqqxx nothing', source: 'hotkey' })).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON, verdict: null });
    expect(await b.rpc('check.text', { text: '<p>x</p>', source: 'hotkey' })).toMatchObject({ status: 'refused', reason: CHECK_REFUSALS.markup });
    expect(done).toEqual([]);
    expect(await b.rpc('check.recent', undefined)).toEqual([]);
  });

  it('validates like the service, without quoting the text', async () => {
    const b = make();
    const err = await b.rpc('check.text', { text: 'SECRET'.repeat(80), source: 'manual' }).catch((e: Error) => e);
    expect((err as Error).message).toBe(`Invalid parameters for check.text: text: at most ${CHECK_MAX_CHARS} characters`);
    await expect(b.rpc('check.text', { text: 'x', source: 'evil' as never })).rejects.toThrow(/source/);
  });

  it(`keeps the last ${CHECK_RECENT_MAX} item results, newest first, with increasing ids`, async () => {
    const b = make();
    for (let i = 0; i < CHECK_RECENT_MAX + 3; i++) await b.rpc('check.text', { text: 'Team Captain, 1 ref', source: 'watch' });
    const recent = await b.rpc('check.recent', undefined);
    expect(recent).toHaveLength(CHECK_RECENT_MAX);
    expect(recent[0]!.id).toBeGreaterThan(recent[1]!.id);
  });
});

describe('popup demos', () => {
  it("reads '#/check?demo=…' and builds each demo", () => {
    expect(checkDemoFromHash('#/check?demo=flip')).toBe('flip');
    expect(checkDemoFromHash('#/check?demo=evil')).toBeNull();
    expect(checkDemoFromHash('#/market?demo=flip')).toBeNull();
    expect(checkDemoFromHash('#/check')).toBeNull();
    const verdicts = CHECK_DEMOS.map((d) => mockCheckDemo(d, T0, 568, DEFAULT_SETTINGS));
    expect(verdicts.map((r) => [r.status, r.verdict])).toEqual([
      ['item', 'flip'],
      ['item', 'over'],
      ['item', 'no-price'],
      ['not-item', null],
    ]);
    for (const r of verdicts.slice(0, 3)) expect(r.revenue!.maxCostScrap).toBe(maxCostFor(r.revenue!.revenueScrap, DEFAULT_SETTINGS.profit));
    expect(verdicts[0]!.profitScrap! > 0 && verdicts[1]!.profitScrap! < 0).toBe(true);
  });

  it("holds the hash's demo for the popup page as 'ui.checkShow', and reports the 'check' window kind", async () => {
    vi.stubGlobal('location', { hash: '#/check?demo=over', search: '' });
    const b = make();
    expect(b.windowKind).toBe('check');
    expect(windowKind()).toBe('check');
    const seen: CheckResult[] = [];
    b.on('ui.checkShow', (r) => seen.push(r));
    await Promise.resolve();
    expect(seen.map((r) => r.verdict)).toEqual(['over']);
  });
});

describe('quick entry prefill with price text', () => {
  it('passes the price along with the SKU, and refuses bad price text', async () => {
    const b = make();
    const seen: unknown[] = [];
    b.on('ui.quickPrefill', (p) => seen.push(p));
    await b.rpc('app.showQuickEntry', { sku: '378;6', price: '1 key 5.33 ref' });
    await b.rpc('app.showQuickEntry', { sku: '378;6' });
    expect(seen).toEqual([{ sku: '378;6', price: '1 key 5.33 ref' }, { sku: '378;6' }]);
    await expect(b.rpc('app.showQuickEntry', { sku: '378;6', price: '<b>1</b>' })).rejects.toThrow(/price/);
  });
});

describe('mockCheckResult agrees with the service (chooseCheckPrice, liveCheck.ts)', () => {
  const K = 568;
  const item = (sku: string): ResolvedItem => ({ sku, name: 'Team Captain', skuObject: {} as ResolvedItem['skuObject'], category: 'hats', match: 'exact', warnings: [] });
  const listRow: ScraptfListRow = {
    sku: '378;6',
    name: 'Team Captain',
    sellsKeys: 0,
    sellsScrapRaw: 30,
    sellsScrap: 30,
    paysKeys: 0,
    paysScrapRaw: 25,
    paysScrap: 25,
    stock: 3,
    stockLimit: 12,
    full: false,
    observedAt: T0 - 60_000,
    // 0.7.4: proven the Craftable copy, so its price may be the check's (scraptfListCraftProven).
    craft: 'craftable',
  };
  const stored = (over: Partial<ScrapPrice>): ScrapPrice => ({
    id: 1,
    sku: '378;6',
    name: 'Team Captain',
    costKeys: 0,
    costScrap: 20,
    source: 'user',
    observedAt: T0 - 3_600_000,
    note: null,
    importBatch: null,
    special: { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false },
    assetId: null,
    stock: null,
    ...over,
  });
  const detail = (over: Partial<ItemDetail> = {}): ItemDetail => ({ name: 'Team Captain', category: 'hats', scraptfList: listRow, scrapPrices: [], revenue: null, links: [], ...over }) as unknown as ItemDetail;
  const refPrice = (scrap: number) => ({ keys: 0, scrap, display: '', ambiguous: false });
  const parsed = (p: Partial<MockParsedCheck> = {}, sku = '378;6'): MockParsedCheck => ({ item: item(sku), price: null, pays: null, paysCopied: false, stock: null, stockLimit: null, soldOut: false, ...p });
  const run = (p: MockParsedCheck, d: ItemDetail = detail()) => mockCheckResult({ id: 1, source: 'manual', now: T0, parsed: p, detail: d, keyScrap: K, settings: DEFAULT_SETTINGS, confidence: null });

  it('a copied Sold out or stock-0 row has no price at all, with the sold-out note', () => {
    for (const p of [parsed({ soldOut: true }), parsed({ price: refPrice(18), stock: 0, stockLimit: 5 })]) {
      const r = run(p, detail({ scrapPrices: [stored({})] }));
      expect(r.price).toBeNull();
      expect(r.verdict).toBe('no-price');
      expect(r.reason).toBe(CHECK_SOLD_OUT_NOTE);
    }
  });

  it('a copied pays cell, even a dash, beats the saved list', () => {
    const dash = run(parsed({ price: refPrice(18), paysCopied: true, pays: null, stock: 3, stockLimit: 12 }));
    expect(dash.scraptfPaysScrap).toBeNull();
    expect(dash.listAt).toBeNull();
    const fromList = run(parsed({ price: refPrice(18) }));
    expect(fromList.scraptfPaysScrap).toBe(25);
    expect(fromList.listAt).toBe(listRow.observedAt);
  });

  it("never takes a family row's price, as chooseCheckPrice (0.7.4): its pays and stock still show", () => {
    const family = detail({ scraptfList: { ...listRow, craft: 'any' }, scrapPrices: [stored({ costScrap: 40 })] });
    expect(run(parsed(), family)).toMatchObject({ price: { source: 'typed', scrapRaw: 40 }, scraptfPaysScrap: 25, stock: 3 });
    expect(run(parsed(), detail({ scraptfList: { ...listRow, craft: 'any', match: 'family' } })).price).toBeNull();
  });

  it('a painted check never takes the list price (the list prices plain copies)', () => {
    const painted = run(parsed({}, '378;6;p8208497'), detail({ scrapPrices: [stored({ sku: '378;6;p8208497', costScrap: 40 })] }));
    expect(painted.price).toMatchObject({ source: 'typed', scrapRaw: 40 });
    expect(run(parsed()).price).toMatchObject({ source: 'list', scrapRaw: 30 });
  });

  it('a plain check prefers a stored copy without extras', () => {
    const paintedRow = stored({ id: 2, costScrap: 90, observedAt: T0 - 1000, special: { ...stored({}).special!, paint: 8208497 } });
    const r = run(parsed(), detail({ scraptfList: null, scrapPrices: [paintedRow, stored({ id: 1, costScrap: 20 })] }));
    expect(r.price).toMatchObject({ source: 'typed', scrapRaw: 20 });
    expect(r.reason).toBeNull();
  });

  it("a plain check priced from a painted copy says so (CHECK_EXTRAS_NOTE); the painted check does not", () => {
    const paintedRow = stored({ id: 2, costScrap: 90, special: { ...stored({}).special!, paint: 8208497 } });
    const r = run(parsed(), detail({ scraptfList: null, scrapPrices: [paintedRow] }));
    expect(r).toMatchObject({ price: { source: 'typed', scrapRaw: 90 }, reason: CHECK_EXTRAS_NOTE });
    expect(run(parsed({}, '378;6;p8208497'), detail({ scraptfList: null, scrapPrices: [paintedRow] })).reason).toBeNull();
    expect(run(parsed({ price: refPrice(18) }), detail({ scraptfList: null, scrapPrices: [paintedRow] })).reason).toBeNull();
  });

  it('reads two-line Sold out copies and answers a scrap.tf link as not-item', () => {
    const resolve = (t: string): ResolvedItem | null => (t.trim().toLowerCase() === 'team captain' ? item('378;6') : null);
    expect(mockParseCheck('Team Captain\nSold out', resolve)).toMatchObject({ ok: true, parsed: { price: null, soldOut: true } });
    expect(mockParseCheck('https://scrap.tf/items', resolve)).toEqual({ ok: false, status: 'not-item', reason: CHECK_SCRAPTF_LINK_REASON });
    expect(mockParseCheck('Team Captain\t1.33 ref\t—\t3/12', resolve)).toMatchObject({ ok: true, parsed: { paysCopied: true, pays: null, stock: 3, stockLimit: 12 } });
  });
});
