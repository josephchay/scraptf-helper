// 0.7.2 mock parity for killstreak kits: the browser mock (`npm run dev:renderer`) prices a kit as the
// service does. A page look stores a kit once per sheen/killstreaker combo, every copy at the page's time,
// and every specialized or professional copy has a sheen. The mock Live check reads a sheen or killstreaker
// alone as the plain item (liveCheck.ts isOtherCopy), and both the check and the Live market take the
// cheapest copy of the newest look at the key price, equal costs to the higher id (newestStoredPrice,
// market.ts knownAt). The mock Live market still flags a kit row 'has-extras', as market.ts does (the
// engine's hasExtras counts a sheen). Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockCheckResult, mockNewestStoredPrice, type MockParsedCheck } from '../../src/renderer/mockCheck';
import { MOCK_KEY_SCRAP, SEED_KIT, mockKnownAt, mockKnownPrices, mockMarketRow } from '../../src/renderer/mockData';
import { explicitInput } from '../../src/service/domain/engine';
import { newestStoredPrice, storedPriceHasExtras } from '../../src/service/domain/liveCheck';
import { CHECK_EXTRAS_NOTE } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { ItemDetail, ResolvedItem, ScrapPrice, SpecialAttrs } from '../../src/shared/types';

const KIT = { sku: '6526;6;uncraftable;kt-3;td-205', name: 'Non-Craftable Professional Killstreak Rocket Launcher Kit' };
const HAT = { sku: '378;6', name: 'Team Captain' };
const PINK = 16738740;
const K = MOCK_KEY_SCRAP;
const T = Date.UTC(2026, 9, 20, 12, 0, 0);

const NONE: SpecialAttrs = { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };
const special = (over: Partial<SpecialAttrs>): SpecialAttrs => ({ ...NONE, ...over });

function price(over: Partial<ScrapPrice>): ScrapPrice {
  return {
    id: 1,
    sku: KIT.sku,
    name: KIT.name,
    costKeys: 0,
    costScrap: 0,
    source: 'import',
    observedAt: T,
    note: null,
    importBatch: 7,
    special: special({ sheen: 1, killstreaker: 2002 }),
    assetId: null,
    stock: 1,
    ...over,
  };
}

/** Two cards of one look: Team Shine / Fire Horns at 37 keys, Hot Rod / Cerebral Discharge at 20 keys 9 scrap. */
const dear = (id: number, over: Partial<ScrapPrice> = {}) => price({ id, costKeys: 37, special: special({ sheen: 1, killstreaker: 2002 }), ...over });
const cheap = (id: number, over: Partial<ScrapPrice> = {}) => price({ id, costKeys: 20, costScrap: 9, special: special({ sheen: 7, killstreaker: 2003 }), ...over });

const item = (sku: string, name: string): ResolvedItem => ({ sku, name, skuObject: {} as ResolvedItem['skuObject'], category: 'killstreaks', match: 'sku', warnings: [] });
const parsed = (sku = KIT.sku, name = KIT.name): MockParsedCheck => ({ item: item(sku, name), price: null, pays: null, paysCopied: false, stock: null, stockLimit: null, soldOut: false });
const detail = (scrapPrices: ScrapPrice[]): ItemDetail => ({ name: KIT.name, category: 'killstreaks', scraptfList: null, scrapPrices, revenue: null, links: [] }) as unknown as ItemDetail;
const check = (scrapPrices: ScrapPrice[], p: MockParsedCheck = parsed(), keyScrap = K) =>
  mockCheckResult({ id: 1, source: 'manual', now: T + 60_000, parsed: p, detail: detail(scrapPrices), keyScrap, settings: DEFAULT_SETTINGS, confidence: null });

/** Each case: the stored prices, whether the checked SKU is plain, and the key price. */
const CASES: { name: string; prices: ScrapPrice[]; plain?: boolean; keyScrap?: number }[] = [
  { name: 'cheaper copy stored first', prices: [cheap(10), dear(11)] },
  { name: 'cheaper copy stored last', prices: [dear(10), cheap(11)] },
  { name: 'equal costs', prices: [cheap(10), cheap(12), cheap(11)] },
  { name: 'a newer look beats a cheaper older one', prices: [cheap(10, { observedAt: T - 60_000 }), dear(9)] },
  { name: 'keys against metal at the mock key price', prices: [price({ id: 10, costKeys: 1 }), price({ id: 11, costScrap: K + 1 })] },
  { name: 'keys against metal at a dearer key price', prices: [price({ id: 10, costKeys: 1 }), price({ id: 11, costScrap: K + 1 })], keyScrap: K + 50 },
  { name: 'a painted copy of the same look is cheaper', prices: [price({ id: 10, sku: HAT.sku, costScrap: 30, special: NONE }), price({ id: 11, sku: HAT.sku, costScrap: 5, special: special({ paint: PINK }) })] },
  { name: 'only a painted copy', prices: [price({ id: 10, sku: `${HAT.sku};p${PINK}`, costScrap: 5, special: NONE })] },
  { name: 'only a spelled copy', prices: [price({ id: 10, sku: HAT.sku, costScrap: 5, special: special({ spells: ['exorcism'] }) })] },
  { name: 'a painted check', prices: [price({ id: 10, sku: `${HAT.sku};p${PINK}`, costScrap: 50, special: NONE }), price({ id: 11, sku: `${HAT.sku};p${PINK}`, costScrap: 40, special: NONE })], plain: false },
  { name: 'a currency and a bad cost are never a cost', prices: [price({ id: 10, sku: '5021;6', costScrap: 1 }), price({ id: 11, costScrap: Number.NaN }), dear(9)] },
  { name: 'nothing stored', prices: [] },
];

let bridge: MockBridge | null = null;

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('mock Live check: which stored price (newestStoredPrice, liveCheck.ts)', () => {
  it.each(CASES)('picks what the service picks: $name', ({ prices, plain = true, keyScrap = K }) => {
    const want = newestStoredPrice(prices, plain, keyScrap);
    expect(mockNewestStoredPrice(prices, plain, keyScrap)?.id ?? null).toBe(want?.id ?? null);
    // And in any order the detail lists them.
    expect(mockNewestStoredPrice([...prices].reverse(), plain, keyScrap)?.id ?? null).toBe(want?.id ?? null);
  });

  it("checks a kit at its cheapest copy of the look, whichever was stored last", () => {
    for (const prices of [[cheap(10), dear(11)], [dear(10), cheap(11)]]) {
      const r = check(prices);
      expect(r.price).toMatchObject({ source: 'import', keys: 20, scrapRaw: 9, valueScrap: 20 * K + 9, observedAt: T });
    }
  });
});

describe("mock Live check: another copy (isOtherCopy, liveCheck.ts)", () => {
  it('a sheen or killstreaker alone is the kit itself: no extras note', () => {
    for (const s of [special({ sheen: 1 }), special({ killstreaker: 2002 }), special({ sheen: 1, killstreaker: 2002 })]) {
      const p = price({ id: 10, costKeys: 20, special: s });
      expect(storedPriceHasExtras(p)).toBe(false);
      expect(check([p]).reason).toBeNull();
    }
  });

  it('paint, spells, parts or a custom name or description still make another copy, as the service says', () => {
    const others: ScrapPrice[] = [
      price({ id: 10, special: special({ sheen: 1, paint: PINK }) }),
      price({ id: 10, special: special({ sheen: 1, spells: ['exorcism'] }) }),
      price({ id: 10, special: special({ parts: ['kills'] }) }),
      price({ id: 10, special: special({ customName: true }) }),
      price({ id: 10, special: special({ customDesc: true }) }),
    ];
    for (const p of others) {
      expect(storedPriceHasExtras(p)).toBe(true);
      expect(check([p]).reason).toBe(CHECK_EXTRAS_NOTE);
    }
  });

  it('agrees with the service on the note for every case', () => {
    for (const { prices, plain = true, keyScrap = K } of CASES) {
      const stored = newestStoredPrice(prices, plain, keyScrap);
      const p = plain ? parsed() : parsed(`${HAT.sku};p${PINK}`, HAT.name);
      const note = check(prices, p, keyScrap).reason === CHECK_EXTRAS_NOTE;
      expect(note).toBe(plain && stored !== null && storedPriceHasExtras(stored));
    }
  });
});

describe('mock Live market: the row price (knownAt, market.ts)', () => {
  const rowOf = (prices: ScrapPrice[], keyScrap = K) =>
    mockMarketRow({
      item: { sku: KIT.sku, name: KIT.name, category: 'killstreaks' },
      book: null,
      known: mockKnownPrices(prices).get(KIT.sku),
      rules: [],
      settings: DEFAULT_SETTINGS,
      keyScrap,
      now: T + 60_000,
    });

  it("shows a kit at its look's cheapest copy, whichever was stored last, flagged has-extras", () => {
    for (const prices of [[cheap(10), dear(11)], [dear(10), cheap(11)]]) {
      const row = rowOf(prices);
      expect(row).toMatchObject({ knownCostScrap: 20 * K + 9, knownSource: 'page', knownObservedAt: T, stock: 1 });
      // As market.ts: the engine's hasExtras counts a sheen and killstreaker, so the row is marked.
      expect(row?.flags).toContain('has-extras');
    }
  });

  it('equal costs keep the higher id; a newer look beats a cheaper older one', () => {
    expect(mockKnownAt(mockKnownPrices([cheap(10, { stock: 4 }), cheap(12, { stock: 2 }), cheap(11, { stock: 3 })]).get(KIT.sku), K)?.id).toBe(12);
    expect(mockKnownAt(mockKnownPrices([cheap(10, { observedAt: T - 60_000 }), dear(9)]).get(KIT.sku), K)?.id).toBe(9);
    expect(mockKnownAt(mockKnownPrices([dear(9), cheap(10, { observedAt: T - 60_000 })]).get(KIT.sku), K)?.id).toBe(9);
  });

  it('values keys at the key price it is given', () => {
    const prices = [price({ id: 10, costKeys: 1, special: NONE }), price({ id: 11, costScrap: K + 1, special: NONE })];
    expect(rowOf(prices, K)?.knownCostScrap).toBe(K);
    expect(rowOf(prices, K + 50)?.knownCostScrap).toBe(K + 1);
    expect(rowOf(prices, K)?.flags).not.toContain('has-extras');
  });

  it("flags has-extras exactly when the engine's hasExtras does (blank spells or parts are none)", () => {
    const specials = [NONE, special({ sheen: 1 }), special({ killstreaker: 2002 }), special({ spells: [' '], parts: [''] }), special({ sheen: 0, killstreaker: 0, paint: 0 }), special({ spells: ['exorcism'] }), special({ customName: true })];
    for (const s of specials) {
      const p = price({ id: 10, costKeys: 1, special: s });
      expect(rowOf([p])?.flags.includes('has-extras')).toBe(explicitInput(p)!.target.hasExtras);
    }
  });

  it('takes the cheapest of typed and page prices seen at one time, and still counts each side', () => {
    const prices = [dear(10), cheap(11, { source: 'user', importBatch: null, stock: null })];
    const known = mockKnownPrices(prices).get(KIT.sku)!;
    expect([known.typed?.id, known.page?.id]).toEqual([11, 10]);
    expect(rowOf(prices)).toMatchObject({ knownCostScrap: 20 * K + 9, knownSource: 'typed', stock: null });
  });
});

describe('the mock bridge prices a kit like the service', () => {
  it('seeds one kit look: two copies at one time, the cheaper stored first, shown at the cheaper', async () => {
    expect(SEED_KIT).toEqual(KIT);
    bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T });
    const b = bridge;
    const copies = (await b.rpc('prices.list', {})).filter((p) => p.sku === KIT.sku);
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((p) => p.observedAt)).size).toBe(1);
    expect(copies.every((p) => p.source === 'import' && p.special?.sheen !== null && p.special?.killstreaker !== null)).toBe(true);
    const [first, second] = [...copies].sort((x, y) => x.id - y.id);
    expect(first!.costKeys).toBeLessThan(second!.costKeys);
    const list = await b.rpc('market.list', { search: 'rocket launcher kit', limit: 500 });
    const kp = list.keyPrice!.valueScrap;
    const row = list.rows.find((r) => r.sku === KIT.sku);
    expect(row).toMatchObject({ knownCostScrap: first!.costKeys * kp + first!.costScrap, knownSource: 'page', knownObservedAt: first!.observedAt });
    expect(row?.flags).toContain('has-extras');
    const r = await b.rpc('check.text', { text: KIT.sku, source: 'manual' });
    expect(r).toMatchObject({ status: 'item', reason: null, price: { source: 'import', keys: first!.costKeys, scrapRaw: first!.costScrap } });
  });

  it('two copies saved at one time: the Live market row and a check by SKU take the cheaper, with no extras note', async () => {
    bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T });
    const b = bridge;
    const at = T - 5 * 60_000;
    // The cheaper copy first, so the old "stored last wins" pick would show the dearer one.
    await b.rpc('prices.upsert', { sku: KIT.sku, name: KIT.name, costKeys: 20, costScrap: 9, source: 'import', observedAt: at, stock: 1, special: special({ sheen: 7, killstreaker: 2003 }) });
    await b.rpc('prices.upsert', { sku: KIT.sku, name: KIT.name, costKeys: 37, costScrap: 0, source: 'import', observedAt: at, stock: 1, special: special({ sheen: 1, killstreaker: 2002 }) });
    const kp = (await b.rpc('market.list', { limit: 1 })).keyPrice!.valueScrap;
    const row = (await b.rpc('market.list', { search: 'rocket launcher kit', limit: 500 })).rows.find((r) => r.sku === KIT.sku);
    expect(row).toMatchObject({ knownCostScrap: 20 * kp + 9, knownSource: 'page', knownObservedAt: at });
    expect(row?.flags).toContain('has-extras');
    const r = await b.rpc('check.text', { text: KIT.sku, source: 'manual' });
    expect(r).toMatchObject({ status: 'item', sku: KIT.sku, reason: null, keyScrap: kp });
    expect(r.price).toMatchObject({ source: 'import', keys: 20, scrapRaw: 9, valueScrap: 20 * kp + 9, observedAt: at });
  });
});
