// 0.7.4 (audit F41, F44) in the popup's model and the browser mock: a check whose craftability is undecided
// (CHECK_CRAFT_UNSURE_NOTE) shows its numbers but turns Save price and Bought it off and gives Quick entry the
// item only; a check decided as the Non-Craftable twin saves and books that SKU. The mock judges a copy as the
// service does (mockJudgeCheck: the watcher drops a number without a unit; a plain name's copy is the one the
// saved list rows and bank saves match). No network, no clipboard.

import { afterEach, describe, expect, it } from 'vitest';
import { CHECK_CRAFT_UNDECIDED_ACTION, checkActions, checkBoughtInput, checkPriceLine, checkQuickEntryParams, checkSaveInput } from '../../src/renderer/checkModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockCheckResult, mockJudgeCheck, mockParseCheck, type MockParsedCheck } from '../../src/renderer/mockCheck';
import { blankCheckResult, CHECK_BARE_REF_NOTE, CHECK_CRAFT_TWIN_NOTE, CHECK_CRAFT_UNSURE_NOTE, checkHintedNote } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { fromString } from '../../src/shared/sku';
import type { CheckResult, CheckSource, ItemDetail, ItemRevenue, ResolvedItem, ScraptfListRow } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const K = 567;
const HUE = 'A Distinctive Lack of Hue';
const CRAFT = '5040;6';
const TWIN = '5040;6;uncraftable';
const CARD = { keys: 1, scrap: 389 };

function result(over: Partial<CheckResult> = {}): CheckResult {
  const revenue: ItemRevenue = { bestScrap: 1332, consScrap: 1332, instantScrap: 1330, useOrder: 'conservative', revenueScrap: 1332, order: null, maxCostScrap: 1100, eligibleCount: 3 };
  return {
    ...blankCheckResult('not-item', 'x', 'hotkey', T0),
    id: 7,
    status: 'item',
    reason: null,
    sku: CRAFT,
    name: HUE,
    price: { keys: 1, scrapRaw: 389, valueScrap: 956, source: 'clipboard', observedAt: T0 },
    revenue,
    profitScrap: 376,
    margin: 0.39,
    verdict: 'flip',
    keyScrap: K,
    checkedAt: T0,
    ...over,
  };
}

describe('the popup with an undecided craftability (checkModel)', () => {
  it('shows the price but turns Save price and Bought it off, and Quick entry gets the item only', () => {
    for (const reason of [CHECK_CRAFT_UNSURE_NOTE, `${checkHintedNote(HUE)} ${CHECK_CRAFT_UNSURE_NOTE}`]) {
      const r = result({ reason, sku: TWIN, name: `Non-Craftable ${HUE}` });
      const a = checkActions(r);
      expect(a.save).toEqual({ enabled: false, title: CHECK_CRAFT_UNDECIDED_ACTION });
      expect(a.bought).toEqual({ enabled: false, title: CHECK_CRAFT_UNDECIDED_ACTION });
      expect(a.details.enabled).toBe(true);
      expect(a.quick).toEqual({ enabled: true, title: 'Open Quick entry with this item' });
      expect(checkSaveInput(r, T0)).toBeNull();
      expect(checkBoughtInput(r)).toBeNull();
      expect(checkQuickEntryParams(r)).toEqual({ sku: TWIN });
      const line = checkPriceLine(r, T0);
      expect(line.price).toBe('1 key 43.22 ref');
      expect(line.title).toContain(CHECK_CRAFT_UNSURE_NOTE);
    }
  });

  it('saves and books the decided copy (the twin note), and keeps a bare-ref price usable as before', () => {
    const twin = result({ reason: CHECK_CRAFT_TWIN_NOTE, sku: TWIN, name: `Non-Craftable ${HUE}` });
    expect(checkActions(twin).save.enabled).toBe(true);
    expect(checkSaveInput(twin, T0)).toMatchObject({ sku: TWIN, name: `Non-Craftable ${HUE}`, costKeys: 1, costScrap: 389, source: 'user' });
    expect(checkBoughtInput(twin)).toMatchObject({ side: 'buy', sku: TWIN, keys: 1, scrap: 389 });
    expect(checkQuickEntryParams(twin)).toEqual({ sku: TWIN, price: '1 key 43.22 ref' });
    // F44: the user asked (hotkey), so the ref reading stays usable; the note says how it was read.
    const bare = result({ reason: CHECK_BARE_REF_NOTE, price: { keys: 0, scrapRaw: 18, valueScrap: 18, source: 'clipboard', observedAt: T0 } });
    expect(checkActions(bare).save.enabled).toBe(true);
    expect(checkActions(bare).bought.enabled).toBe(true);
  });
});

describe('mockJudgeCheck (the service judge over the mock)', () => {
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
  const revenueOf = (sku: string): number => (sku === TWIN ? 953 : 1332);
  const detail = (sku: string) =>
    ({ name: sku === TWIN ? `Non-Craftable ${HUE}` : HUE, category: 'other', scraptfList: null, scrapPrices: [], links: [], revenue: { revenueScrap: revenueOf(sku), maxCostScrap: revenueOf(sku) - 100 } }) as unknown as ItemDetail;
  // As mock.ts: a hinted check answered by the twin names the armed item (0.7.4, hintedName).
  const evaluate = (source: CheckSource, hinted = false) => (p: MockParsedCheck, craftNote: string | null) =>
    mockCheckResult({ id: 1, source, now: T0, parsed: p, detail: detail(p.item.sku), keyScrap: K, settings: DEFAULT_SETTINGS, confidence: null, hinted, hintedName: hinted && p.item.sku !== CRAFT ? HUE : null, craftNote });
  const listRow = (sku: string, craft: ScraptfListRow['craft']): ScraptfListRow => ({ sku, name: HUE, sellsKeys: 1, sellsScrapRaw: 389, sellsScrap: 956, paysKeys: null, paysScrapRaw: null, paysScrap: null, stock: 4, stockLimit: 25, full: false, observedAt: T0, craft });
  const judge = (p: MockParsedCheck, banks: Record<string, { keys: number; scrap: number }[]>, list: Record<string, ScraptfListRow> = {}, source: CheckSource = 'watch', hinted = false) =>
    mockJudgeCheck({ parsed: p, source, listRowFor: (s) => list[s] ?? null, bankPricesFor: (s) => banks[s] ?? [], evaluate: evaluate(source, hinted) });

  it('checks a plain name as the twin when only it is saved, as written when the text says, unchanged with nothing saved', () => {
    expect(judge(parsed(), { [TWIN]: [CARD] })).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_TWIN_NOTE });
    expect(judge(parsed(), {}, { [TWIN]: listRow(TWIN, 'uncraftable') })).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_TWIN_NOTE });
    expect(judge(parsed({ craftStated: true }), { [TWIN]: [CARD] })).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    expect(judge(parsed(), {})).toMatchObject({ sku: CRAFT, reason: null, verdict: 'flip' });
    // 0.7.4 (R20): a family row says nothing of one copy, so with the twin trading it is undecided, never the Craftable copy.
    expect(judge(parsed(), {}, { [CRAFT]: listRow(CRAFT, 'any') })).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE });
    // F19: the hinted note first, naming the item the user opened (0.7.4: not the twin that answers), then the twin note.
    expect(judge(parsed(), { [TWIN]: [CARD] }, {}, 'hotkey', true).reason).toBe(`${checkHintedNote(HUE)} ${CHECK_CRAFT_TWIN_NOTE}`);
  });

  it('answers an undecided copy with the one that sells for less, noted', () => {
    const r = judge(parsed(), { [TWIN]: [CARD], [CRAFT]: [CARD] });
    expect(r).toMatchObject({ sku: TWIN, reason: CHECK_CRAFT_UNSURE_NOTE });
    expect(r.verdict).not.toBe('flip');
    expect(checkActions(r).save.enabled).toBe(false);
    // A copied price only the Craftable card is at keeps the Craftable copy.
    expect(judge(parsed({ price: { keys: 2, scrap: 0, display: '2 keys', ambiguous: false } }), { [TWIN]: [CARD], [CRAFT]: [{ keys: 2, scrap: 0 }] })).toMatchObject({ sku: CRAFT, reason: null });
  });

  it('F44: from the watcher a bare number is no price; the hotkey keeps it, noted', () => {
    const bare = parsed({ item: item('378;6'), price: { keys: 0, scrap: 18, display: '2 ref', ambiguous: true }, priceAmbiguous: true, craftStated: true });
    expect(judge(bare, {}, {}, 'watch')).toMatchObject({ sku: '378;6', price: null, verdict: 'no-price', reason: null });
    expect(judge(bare, {}, {}, 'hotkey')).toMatchObject({ price: { scrapRaw: 18, source: 'clipboard' }, reason: CHECK_BARE_REF_NOTE });
  });

  it('mockParseCheck flags a bare number and whether the name says its copy, as the service parser', () => {
    const resolve = (t: string): ResolvedItem | null => {
      const s = t.trim().toLowerCase();
      if (s === 'team captain' || s === 'craftable team captain') return { ...item('378;6'), name: 'Team Captain' };
      return /^\d+;\d+/.test(s) ? item(s) : null;
    };
    expect(mockParseCheck('Team Captain 2', resolve)).toMatchObject({ ok: true, parsed: { priceAmbiguous: true, craftStated: false } });
    expect(mockParseCheck('Team Captain\n2', resolve)).toMatchObject({ ok: true, parsed: { priceAmbiguous: true } });
    expect(mockParseCheck('Team Captain, 1.33 ref', resolve)).toMatchObject({ ok: true, parsed: { priceAmbiguous: false, craftStated: false } });
    expect(mockParseCheck('Craftable Team Captain, 1.33 ref', resolve)).toMatchObject({ ok: true, parsed: { craftStated: true } });
    expect(mockParseCheck('378;6', resolve)).toMatchObject({ ok: true, parsed: { craftStated: true, priceAmbiguous: false } });
  });
});

describe("the mock's 'check.text' (F44)", () => {
  let bridge: MockBridge | null = null;
  afterEach(() => {
    bridge?.dispose();
    bridge = null;
  });

  it('checks "Team Captain 2" from the watcher as the name alone, and from the hotkey as 2 ref with the note', async () => {
    bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    const alone = await bridge.rpc('check.text', { text: 'Team Captain', source: 'watch' });
    const watched = await bridge.rpc('check.text', { text: 'Team Captain 2', source: 'watch' });
    expect(watched).toMatchObject({ status: 'item', sku: alone.sku, price: alone.price, reason: alone.reason });
    const hotkey = await bridge.rpc('check.text', { text: 'Team Captain 2', source: 'hotkey' });
    expect(hotkey).toMatchObject({ status: 'item', price: { scrapRaw: 18, source: 'clipboard' } });
    expect(hotkey.reason).toContain(CHECK_BARE_REF_NOTE);
  });
});
