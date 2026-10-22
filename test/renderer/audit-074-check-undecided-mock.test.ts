// 0.7.4 review (R20, R21, R14) in the browser mock: mockJudgeCheck decides a plain name's copy by the same shared
// rules as the service (checkCraftCopy, checkDecideCopy): a family /items row or a copied price no saved copy is
// at is undecided when the Non-Craftable twin trades, and kept as the Craftable copy when only it trades; and
// mockCheckResult runs the service's cost check (checkCostNote over the age-gated PriceDB rows: capped at Low,
// noted). Development data only: no network, no clipboard.

import { describe, expect, it } from 'vitest';
import { checkActions, checkPriceLine } from '../../src/renderer/checkModel';
import { mockCheckResult, mockJudgeCheck, type MockParsedCheck } from '../../src/renderer/mockCheck';
import { CHECK_COST_BELOW_MARKET_NOTE, CHECK_COST_VARIANT_NOTE, CHECK_CRAFT_UNSURE_NOTE, checkCraftUndecided } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { fromString } from '../../src/shared/sku';
import type { CheckSource, ItemDetail, ReferencePrices, ResolvedItem, ScraptfListRow } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const K = 567;
const HUE = 'A Distinctive Lack of Hue';
const CRAFT = '5040;6';
const TWIN = '5040;6;uncraftable';
const CARD = { keys: 1, scrap: 389 };
const DAY = 86_400_000;

const item = (sku: string): ResolvedItem => ({ sku, name: HUE, skuObject: fromString(sku), category: 'other', match: 'exact', warnings: [] });
const parsed = (over: Partial<MockParsedCheck> = {}): MockParsedCheck => ({
  item: item(CRAFT),
  price: { ...CARD, display: '1 key 43.22 ref', ambiguous: false },
  pays: null,
  paysCopied: false,
  stock: null,
  stockLimit: null,
  soldOut: false,
  craftStated: false,
  priceAmbiguous: false,
  ...over,
});
const pricedb = (buyScrap: number, sellScrap: number, ageMs = 0): ReferencePrices => ({ pricedb: { buyScrap, sellScrap, time: null, ageMs }, community: null });
const listRow = (sku: string, craft: ScraptfListRow['craft']): ScraptfListRow => ({ sku, name: HUE, sellsKeys: 1, sellsScrapRaw: 389, sellsScrap: 956, paysKeys: null, paysScrapRaw: null, paysScrap: null, stock: 4, stockLimit: 25, full: false, observedAt: T0, craft });

/** The mock's judge over fixed books: Craftable buyers pay 1332, Non-Craftable ones 953 (none when `twinTrades` is false). */
function judge(a: {
  p?: MockParsedCheck;
  banks?: Record<string, { keys: number; scrap: number }[]>;
  list?: Record<string, ScraptfListRow>;
  twinTrades?: boolean;
  references?: Record<string, ReferencePrices>;
  source?: CheckSource;
}) {
  const revenueOf = (sku: string): number | null => (sku === TWIN ? (a.twinTrades === false ? null : 953) : 1332);
  const detail = (sku: string) => {
    const rev = revenueOf(sku);
    return {
      name: sku === TWIN ? `Non-Craftable ${HUE}` : HUE,
      category: 'other',
      scraptfList: null,
      scrapPrices: [],
      links: [],
      references: a.references?.[sku] ?? { pricedb: null, community: null },
      revenue: rev === null ? null : { revenueScrap: rev, maxCostScrap: rev - 100 },
    } as unknown as ItemDetail;
  };
  const source = a.source ?? 'watch';
  return mockJudgeCheck({
    parsed: a.p ?? parsed(),
    source,
    listRowFor: (s) => a.list?.[s] ?? null,
    bankPricesFor: (s) => a.banks?.[s] ?? [],
    evaluate: (p, craftNote) =>
      mockCheckResult({
        id: 1,
        source,
        now: T0,
        parsed: p,
        detail: detail(p.item.sku),
        keyScrap: K,
        settings: DEFAULT_SETTINGS,
        confidence: { value: 80, level: 'high' },
        craftNote,
        twinReferences: () => a.references?.[p.item.sku === TWIN ? CRAFT : TWIN] ?? null,
      }),
  });
}

describe('mockJudgeCheck: what decides nothing is undecided when the twin trades (R20, R21)', () => {
  it('R20: a family row answers with the copy that sells for less, or the Craftable copy when only it trades', () => {
    const r = judge({ list: { [CRAFT]: listRow(CRAFT, 'any') } });
    expect(r).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE });
    expect(r.verdict).not.toBe('flip');
    expect(checkCraftUndecided(r)).toBe(true);
    expect(checkActions(r).save.enabled).toBe(false);
    expect(judge({ list: { [CRAFT]: listRow(CRAFT, 'any') }, twinTrades: false })).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    // A proven Craftable row decides, as the service.
    expect(judge({ list: { [CRAFT]: listRow(CRAFT, 'craftable') } })).toMatchObject({ sku: CRAFT, reason: null });
  });

  it('R21: a copied price no saved copy is at, with either copy saved', () => {
    // S2: only the Craftable card saved, the Non-Craftable card copied.
    expect(judge({ banks: { [CRAFT]: [{ keys: 2, scrap: 0 }] } })).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE });
    // S1: only the Non-Craftable card saved, a Craftable price copied.
    const s1 = judge({ p: parsed({ price: { keys: 2, scrap: 0, display: '2 keys', ambiguous: false } }), banks: { [TWIN]: [CARD] }, source: 'hotkey' });
    expect(s1.reason).toBe(CHECK_CRAFT_UNSURE_NOTE);
    expect(checkActions(s1).save.enabled).toBe(false);
    expect(checkActions(s1).bought.enabled).toBe(false);
    // A repriced Craftable card whose twin does not trade keeps the Craftable copy.
    expect(judge({ banks: { [CRAFT]: [{ keys: 2, scrap: 0 }] }, twinTrades: false })).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
  });
});

describe('mockCheckResult: the cost check (R14)', () => {
  const refs = { [CRAFT]: pricedb(2 * K + 76, 2 * K + 213), [TWIN]: pricedb(K + 333, K + 392) };

  it('notes a price that matches the other copy on PriceDB and caps it at Low, as the service', () => {
    const r = judge({ p: parsed({ craftStated: true }), references: refs });
    expect(r).toMatchObject({ sku: CRAFT, verdict: 'flip', reason: CHECK_COST_VARIANT_NOTE, confidence: 44, confidenceLevel: 'low' });
    // The popup's price line says it too, and the buttons stay (the price may still be right: it is a warning).
    expect(checkPriceLine(r, T0).title).toContain(CHECK_COST_VARIANT_NOTE);
    expect(checkActions(r).save.enabled).toBe(true);
    const below = judge({ p: parsed({ craftStated: true, price: { keys: 2, scrap: 0, display: '2 keys', ambiguous: false } }), references: { [CRAFT]: refs[CRAFT]! } });
    expect(below.reason).toBe(CHECK_COST_BELOW_MARKET_NOTE);
  });

  it('ignores a PriceDB row past profit.referenceMaxAgeMs, and a fair price', () => {
    const old = { [CRAFT]: pricedb(2 * K + 76, 2 * K + 213, 60 * DAY), [TWIN]: pricedb(K + 333, K + 392, 60 * DAY) };
    expect(judge({ p: parsed({ craftStated: true }), references: old })).toMatchObject({ reason: null, confidenceLevel: 'high' });
    expect(judge({ p: parsed({ craftStated: true, price: { keys: 2, scrap: 80, display: '2 keys 80 scrap', ambiguous: false } }), references: refs }).reason).toBeNull();
  });
});
