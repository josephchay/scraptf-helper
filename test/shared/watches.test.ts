// 0.8 (G1, G3): the scrap.tf watch rules (src/shared/watches.ts), shared by the service (the S3 notifier, the bank
// stock rows, the engine's profit bar, 'watches.*'), the dashboard and the mock: which copy a watch covers, a target
// at the key price, what a row meets now and on a read (the stateless edge), the rows' join, a watch's cheapest copy
// on sale now, the engine's floor and the input rules. Pure; nothing is fetched.

import { describe, expect, it } from 'vitest';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import type { BankStockRow, OrderSummary, ScraptfWatch } from '../../src/shared/types';
import {
  EMPTY_WATCH_INDEX,
  WATCH_EMPTY,
  WATCH_ANY_COPY_SENTINEL,
  WATCH_NAME_MAX,
  WATCH_NOT_AN_ITEM,
  WATCH_NOT_A_COPY,
  WATCH_ZERO_PRICE,
  watchCovers,
  watchFloorOf,
  watchFresh,
  watchHitOf,
  watchIndexOf,
  watchInputProblem,
  watchJoinOf,
  watchMetOf,
  watchNowOf,
  watchRowSpecialKey,
  watchTargetScrap,
  watchTargetsText,
  watchViewsOf,
  watchWriteOf,
  watchesFor,
  type WatchPageRows,
} from '../../src/shared/watches';

const K = 600;
const T = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE = '378;6';
const PAINTED = bankStockSpecialKey({ paint: 15185211 });
const KS = bankStockSpecialKey({ sheen: 1, killstreaker: 2002 });
const PAINTED_KS = bankStockSpecialKey({ paint: 15185211, sheen: 1, killstreaker: 2002 });
const SPELLED = bankStockSpecialKey({ spells: ['Exorcism'] });

function watch(over: Partial<ScraptfWatch> = {}): ScraptfWatch {
  return {
    id: 1,
    sku: BASE,
    specialKey: '',
    name: 'Team Captain',
    maxCostKeys: 0,
    maxCostScrap: 40,
    minProfitScrap: null,
    onRestock: false,
    enabled: true,
    createdAt: T - DAY,
    updatedAt: T - DAY,
    ...over,
  };
}

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'BuyBot',
    keys: 0,
    metalScrap: 60,
    valueScrap: 60,
    isBot: true,
    online: true,
    lastEventAt: T,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function row(specialKey = '', over: Partial<BankStockRow> = {}): BankStockRow {
  return {
    sku: BASE,
    key: `${BASE}|${specialKey}`,
    name: 'Team Captain',
    category: 'hats',
    hasExtras: specialKey !== '',
    costKeys: 0,
    costScrapRaw: 36,
    costScrap: 36,
    stock: 1,
    change: null,
    previousCostScrap: 36,
    previousStock: 1,
    revenueScrap: 60,
    revenueOrder: order(),
    buyerCount: 3,
    maxCostScrap: 45,
    profitScrap: 20,
    margin: 20 / 36,
    verdict: 'flip',
    confidence: 70,
    confidenceLevel: 'high',
    listedSince: null,
    firstSeenAt: null,
    changeSinceListed: null,
    ...over,
  };
}

describe('which copy a watch covers', () => {
  it('reads the copy from a row key', () => {
    expect(watchRowSpecialKey(row(''))).toBe('');
    expect(watchRowSpecialKey(row(PAINTED))).toBe(PAINTED);
  });

  it('covers every copy with any copy, its own copy (a killstreak aside) with one, never another base or when paused', () => {
    const any = watch({ specialKey: null });
    expect(watchCovers(any, { sku: BASE, specialKey: '' })).toBe(true);
    expect(watchCovers(any, { sku: BASE, specialKey: PAINTED })).toBe(true);
    const clean = watch({ specialKey: '' });
    expect(watchCovers(clean, { sku: BASE, specialKey: '' })).toBe(true);
    // A sheen and killstreaker make no other copy (bankStockIsOwnCopy).
    expect(watchCovers(clean, { sku: BASE, specialKey: KS })).toBe(true);
    expect(watchCovers(clean, { sku: BASE, specialKey: PAINTED })).toBe(false);
    expect(watchCovers(clean, { sku: BASE, specialKey: SPELLED })).toBe(false);
    const painted = watch({ specialKey: PAINTED });
    expect(watchCovers(painted, { sku: BASE, specialKey: PAINTED_KS })).toBe(true);
    expect(watchCovers(painted, { sku: BASE, specialKey: '' })).toBe(false);
    expect(watchCovers(any, { sku: '5021;6', specialKey: '' })).toBe(false);
    expect(watchCovers(watch({ specialKey: null, enabled: false }), { sku: BASE, specialKey: '' })).toBe(false);
  });

  it('indexes enabled watches by base, copy watches before any-copy ones, then by id', () => {
    const index = watchIndexOf([
      watch({ id: 1, specialKey: null }),
      watch({ id: 3, specialKey: PAINTED }),
      watch({ id: 2, specialKey: '' }),
      watch({ id: 4, specialKey: SPELLED, enabled: false }),
      watch({ id: 5, sku: '5021;6' }),
    ]);
    expect(index.get(BASE)?.map((w) => w.id)).toEqual([2, 3, 1]);
    expect(index.get('5021;6')?.map((w) => w.id)).toEqual([5]);
    expect(watchesFor(index, BASE, '').map((w) => w.id)).toEqual([2, 1]);
    expect(watchesFor(index, BASE, PAINTED).map((w) => w.id)).toEqual([3, 1]);
    // The paused spelled watch is matched by nothing: only the any-copy one covers that copy.
    expect(watchesFor(index, BASE, SPELLED).map((w) => w.id)).toEqual([1]);
    expect(watchesFor(EMPTY_WATCH_INDEX, BASE, '')).toEqual([]);
  });
});

describe('targets and what a row meets', () => {
  it('values a price target as typed, keys + metal at the key price', () => {
    expect(watchTargetScrap({ maxCostKeys: 2, maxCostScrap: 46 }, K)).toBe(1246);
    expect(watchTargetScrap({ maxCostKeys: 0, maxCostScrap: 17 }, K)).toBe(17);
    expect(watchTargetScrap({ maxCostKeys: Number.NaN, maxCostScrap: 17 }, K)).toBe(17);
    expect(watchTargetScrap({ maxCostKeys: 1, maxCostScrap: null }, K)).toBeNull();
  });

  it('meets the price at or under the target, before the profit target', () => {
    const w = watch({ maxCostScrap: 40, minProfitScrap: 18 });
    expect(watchMetOf(w, row('', { costScrap: 40 }), K, 50)).toBe('price');
    expect(watchMetOf(w, row('', { costScrap: 36 }), K, 50)).toBe('price');
    expect(watchMetOf(w, row('', { costScrap: 41 }), K, 50)).toBe('profit');
    expect(watchMetOf(watch({ maxCostScrap: 40 }), row('', { costScrap: 41 }), K, 50)).toBeNull();
    // A keys target against a metal price: compared at the same key price.
    expect(watchMetOf(watch({ maxCostKeys: 1, maxCostScrap: 0 }), row('', { costScrap: 590 }), K, 50)).toBe('price');
    expect(watchMetOf(watch({ maxCostKeys: 1, maxCostScrap: 0 }), row('', { costScrap: 610 }), K, 50)).toBeNull();
  });

  it('meets the profit target only with the confidence and a verified order', () => {
    const w = watch({ maxCostScrap: null, minProfitScrap: 18 });
    expect(watchMetOf(w, row('', { profitScrap: 18 }), K, 50)).toBe('profit');
    expect(watchMetOf(w, row('', { profitScrap: 17 }), K, 50)).toBeNull();
    expect(watchMetOf(w, row('', { profitScrap: null }), K, 50)).toBeNull();
    expect(watchMetOf(w, row('', { confidence: 40 }), K, 50)).toBeNull();
    expect(watchMetOf(w, row('', { confidence: null }), K, 50)).toBeNull();
    expect(watchMetOf(w, row('', { confidence: null }), K, 0)).toBe('profit');
    expect(watchMetOf(w, row('', { revenueOrder: order({ flags: ['unverified'] }) }), K, 50)).toBeNull();
  });

  it('meets nothing on a family row, a gone row or for a paused watch', () => {
    const w = watch({ maxCostScrap: 40, minProfitScrap: 1 });
    expect(watchMetOf(w, row('', { listFamily: true }), K, 0)).toBeNull();
    expect(watchMetOf(w, row('', { change: 'gone' }), K, 0)).toBeNull();
    expect(watchMetOf({ ...w, enabled: false }, row(''), K, 0)).toBeNull();
  });
});

describe("a read's edge (G1, stateless)", () => {
  const w = watch({ maxCostScrap: 40, updatedAt: T - DAY });
  const prev = T - HOUR;
  const at = (r: BankStockRow, ww = w) => watchHitOf(ww, r, { keyScrap: K, minConfidence: 50, fresh: watchFresh(ww, prev) });

  it('fires when the step diff says new or cheaper, or the watch is fresh for the page', () => {
    expect(at(row('', { change: 'new' }))).toBe('price');
    expect(at(row('', { change: 'cheaper', previousCostScrap: 50 }))).toBe('price');
    // Edited after the page's previous save: judged afresh on an unchanged row.
    expect(at(row('', { change: null }), { ...w, updatedAt: T - HOUR / 2 })).toBe('price');
    // A first save of the page.
    expect(watchHitOf(w, row('', { change: null }), { keyScrap: K, minConfidence: 50, fresh: watchFresh(w, null) })).toBe('price');
  });

  it('never fires on a same-price re-read, a pricier price or key drift alone', () => {
    expect(at(row('', { change: null }))).toBeNull();
    expect(at(row('', { change: 'pricier', previousCostScrap: 30 }))).toBeNull();
    // 1 key raw on both saves: diffBankStock calls it unchanged, so a lower key price that drops it under the target
    // never fires on its own.
    expect(at(row('', { change: null, costKeys: 1, costScrapRaw: 0, costScrap: 39 }))).toBeNull();
    // New, but not at the target.
    expect(at(row('', { change: 'new', costScrap: 50 }))).toBeNull();
  });

  it('is fresh with no previous save or an edit after it', () => {
    expect(watchFresh({ updatedAt: T }, null)).toBe(true);
    expect(watchFresh({ updatedAt: T }, T - 1)).toBe(true);
    expect(watchFresh({ updatedAt: T }, T)).toBe(false);
    expect(watchFresh({ updatedAt: T - DAY }, T)).toBe(false);
  });
});

describe("the rows' join", () => {
  const index = watchIndexOf([watch({ id: 1, specialKey: null, maxCostScrap: 30, minProfitScrap: 18, onRestock: true }), watch({ id: 2, specialKey: '', maxCostScrap: 40 })]);

  it("joins a copy's own watch before an any-copy one, with how far over the target it is", () => {
    expect(watchJoinOf(index, row(''), K, 50)).toEqual({
      id: 2,
      anyCopy: false,
      maxCostScrap: 40,
      minProfitScrap: null,
      onRestock: false,
      met: 'price',
      overTargetScrap: -4,
    });
    expect(watchJoinOf(index, row(PAINTED), K, 50)).toEqual({
      id: 1,
      anyCopy: true,
      maxCostScrap: 30,
      minProfitScrap: 18,
      onRestock: true,
      met: 'profit',
      overTargetScrap: 6,
    });
  });

  it('meets nothing on a gone row, values a keys target at the key price, and is absent without a watch', () => {
    expect(watchJoinOf(index, row('', { change: 'gone' }), K, 50)).toMatchObject({ id: 2, met: null, overTargetScrap: null });
    const keys = watchIndexOf([watch({ maxCostKeys: 1, maxCostScrap: 0 })]);
    expect(watchJoinOf(keys, row('', { costScrap: 590 }), K, 50)).toMatchObject({ maxCostScrap: 600, met: 'price', overTargetScrap: -10 });
    expect(watchJoinOf(watchIndexOf([watch({ maxCostScrap: null, onRestock: true })]), row(''), K, 50)).toMatchObject({ maxCostScrap: null, met: null, overTargetScrap: null });
    expect(watchJoinOf(index, { ...row(''), sku: '5021;6', key: '5021;6|' }, K, 50)).toBeUndefined();
    expect(watchJoinOf(EMPTY_WATCH_INDEX, row(''), K, 50)).toBeUndefined();
  });
});

describe('where a watch stands now', () => {
  const hats: WatchPageRows = {
    bank: 'hats',
    savedAt: T - HOUR,
    rows: [
      row('', { costScrap: 40, costScrapRaw: 40 }),
      row(PAINTED, { costScrap: 30, costScrapRaw: 30 }),
      row(SPELLED, { costScrap: 10, change: 'gone' }),
      row(KS, { costScrap: 5, listFamily: true }),
    ],
  };
  const stranges: WatchPageRows = { bank: 'stranges', savedAt: T, rows: [row('', { costScrap: 30, costScrapRaw: 30, revenueScrap: 50, profitScrap: 14 })] };

  it('picks the cheapest copy it covers on sale, a tie going to the newer save; family and gone rows left out', () => {
    expect(watchNowOf(watch({ specialKey: null, maxCostScrap: 35 }), [hats, stranges], K, 50)).toEqual({
      bank: 'stranges',
      savedAt: T,
      costKeys: 0,
      costScrapRaw: 30,
      costScrap: 30,
      revenueScrap: 50,
      profitScrap: 14,
      verdict: 'flip',
      met: 'price',
      overTargetScrap: -5,
    });
    expect(watchNowOf(watch({ specialKey: '' }), [hats], K, 50)).toMatchObject({ bank: 'hats', costScrap: 40, met: 'price', overTargetScrap: 0 });
    expect(watchNowOf(watch({ specialKey: SPELLED }), [hats, stranges], K, 50)).toBeNull();
  });

  it('breaks a tie within one save by the lower row key', () => {
    // '378;6|' sorts before '378;6|[15185211,…]'.
    const page: WatchPageRows = { bank: 'hats', savedAt: T, rows: [row(PAINTED, { costScrap: 30, revenueScrap: 52 }), row('', { costScrap: 30, revenueScrap: 51 })] };
    expect(watchNowOf(watch({ specialKey: null }), [page], K, 50)).toMatchObject({ bank: 'hats', savedAt: T, costScrap: 30, revenueScrap: 51 });
    expect(watchNowOf(watch({ specialKey: null, maxCostScrap: null, onRestock: true }), [page], K, 50)).toMatchObject({ revenueScrap: 51, met: null, overTargetScrap: null });
  });

  it('still computes a paused watch, and lists every watch by name, then id', () => {
    const paused = watch({ id: 3, name: 'b hat', enabled: false, maxCostScrap: 45 });
    expect(watchNowOf(paused, [hats], K, 50)).toMatchObject({ costScrap: 40, met: 'price', overTargetScrap: -5 });
    const views = watchViewsOf([paused, watch({ id: 2, name: 'a hat' }), watch({ id: 1, name: 'a hat', sku: '5021;6' })], [hats], K, 50);
    expect(views.map((v) => v.id)).toEqual([1, 2, 3]);
    expect(views.map((v) => v.now?.costScrap ?? null)).toEqual([null, 40, 40]);
    expect(views[2]).toMatchObject({ enabled: false, name: 'b hat' });
  });
});

describe("the engine's floor (G1 path B)", () => {
  it("is the lowest profit target among the copy's watches", () => {
    const index = watchIndexOf([
      watch({ id: 1, specialKey: '', minProfitScrap: 12 }),
      watch({ id: 2, specialKey: null, minProfitScrap: 18 }),
      watch({ id: 3, specialKey: PAINTED, minProfitScrap: 5 }),
      watch({ id: 4, specialKey: SPELLED, minProfitScrap: null }),
      watch({ id: 5, sku: '5021;6', minProfitScrap: null }),
    ]);
    expect(watchFloorOf(index, BASE, '')).toBe(12);
    expect(watchFloorOf(index, BASE, PAINTED)).toBe(5);
    // Only the any-copy watch has a target for this copy.
    expect(watchFloorOf(index, BASE, SPELLED)).toBe(18);
    expect(watchFloorOf(index, BASE, bankStockSpecialKey({ parts: ['Kills'] }))).toBe(18);
    expect(watchFloorOf(index, '5021;6', '')).toBeNull();
    expect(watchFloorOf(index, '30000;6', '')).toBeNull();
    expect(watchFloorOf(watchIndexOf([watch({ minProfitScrap: 9, enabled: false })]), BASE, '')).toBeNull();
  });
});

describe('input rules', () => {
  const nameOf = (b: string): string | null => (b === BASE ? 'Team Captain' : null);

  it('refuses a watch with nothing to tell, and a zero price', () => {
    expect(watchInputProblem({ maxCostKeys: 0, maxCostScrap: null, minProfitScrap: null, onRestock: false })).toBe(WATCH_EMPTY);
    expect(watchInputProblem({ maxCostKeys: 0, maxCostScrap: null, minProfitScrap: null, onRestock: true })).toBeNull();
    expect(watchInputProblem({ maxCostKeys: 0, maxCostScrap: null, minProfitScrap: 0, onRestock: false })).toBeNull();
    expect(watchInputProblem({ maxCostKeys: 0, maxCostScrap: 0, minProfitScrap: null, onRestock: true })).toBe(WATCH_ZERO_PRICE);
    expect(watchInputProblem({ maxCostKeys: 2, maxCostScrap: 0, minProfitScrap: null, onRestock: false })).toBeNull();
    expect(() => watchWriteOf({ sku: BASE }, null, nameOf)).toThrow(WATCH_EMPTY);
    expect(() => watchWriteOf({ sku: BASE, maxCostScrap: 0 }, null, nameOf)).toThrow(WATCH_ZERO_PRICE);
    expect(() => watchWriteOf({ sku: 'not an item', maxCostScrap: 9 }, null, nameOf)).toThrow(WATCH_NOT_AN_ITEM);
  });

  it("keeps the SKU's base, and its copy: any, one (the SKU's own) or a given special key", () => {
    expect(watchWriteOf({ sku: `${BASE};p15185211`, copies: 'any', maxCostScrap: 40 }, null, nameOf)).toEqual({
      sku: BASE,
      specialKey: null,
      name: 'Team Captain',
      maxCostKeys: 0,
      maxCostScrap: 40,
      minProfitScrap: null,
      onRestock: false,
      enabled: true,
    });
    expect(watchWriteOf({ sku: `${BASE};p15185211`, maxCostScrap: 40 }, null, nameOf).specialKey).toBe(PAINTED);
    expect(watchWriteOf({ sku: BASE, copies: 'one', maxCostScrap: 40 }, null, nameOf).specialKey).toBe('');
    expect(watchWriteOf({ sku: `${BASE};p15185211`, copies: 'one', special: '', maxCostScrap: 40 }, null, nameOf).specialKey).toBe('');
    expect(watchWriteOf({ sku: BASE, special: SPELLED, maxCostScrap: 40 }, null, nameOf).specialKey).toBe(SPELLED);
    expect(watchWriteOf({ sku: BASE, copies: 'any', special: SPELLED, maxCostScrap: 40 }, null, nameOf).specialKey).toBeNull();
    // Keys count only with a price target.
    expect(watchWriteOf({ sku: BASE, maxCostKeys: 2, maxCostScrap: 5 }, null, nameOf)).toMatchObject({ maxCostKeys: 2, maxCostScrap: 5 });
    expect(watchWriteOf({ sku: BASE, maxCostKeys: 2, minProfitScrap: 9 }, null, nameOf)).toMatchObject({ maxCostKeys: 0, maxCostScrap: null });
  });

  it('keeps what an update leaves out, its copy included', () => {
    const existing = watch({ id: 7, specialKey: null, name: 'Old name', maxCostKeys: 1, maxCostScrap: 9, minProfitScrap: 18, onRestock: true, enabled: false });
    expect(watchWriteOf({ id: 7, sku: BASE, minProfitScrap: 20 }, existing, nameOf)).toEqual({
      id: 7,
      sku: BASE,
      specialKey: null,
      name: 'Old name',
      maxCostKeys: 1,
      maxCostScrap: 9,
      minProfitScrap: 20,
      onRestock: true,
      enabled: false,
    });
    expect(watchWriteOf({ id: 7, sku: BASE, enabled: true }, existing, nameOf)).toMatchObject({ enabled: true, minProfitScrap: 18, maxCostScrap: 9 });
    // Clearing the price drops its keys; the other targets stay.
    expect(watchWriteOf({ id: 7, sku: BASE, maxCostScrap: null }, existing, nameOf)).toMatchObject({ maxCostKeys: 0, maxCostScrap: null, minProfitScrap: 18 });
    expect(watchWriteOf({ id: 7, sku: BASE, copies: 'one' }, existing, nameOf).specialKey).toBe('');
    expect(watchWriteOf({ id: 7, sku: BASE, special: PAINTED }, existing, nameOf).specialKey).toBe(PAINTED);
  });

  it("refuses the copy index's every-copy stand-in '*' as a copy (every copy is copies 'any')", () => {
    expect(WATCH_ANY_COPY_SENTINEL).toBe('*');
    expect(() => watchWriteOf({ sku: BASE, special: '*', minProfitScrap: 9 }, null, nameOf)).toThrow(WATCH_NOT_A_COPY);
    expect(() => watchWriteOf({ sku: BASE, copies: 'one', special: '*', minProfitScrap: 9 }, null, nameOf)).toThrow(WATCH_NOT_A_COPY);
    expect(() => watchWriteOf({ id: 7, sku: BASE, minProfitScrap: 9 }, watch({ id: 7, specialKey: '*' }), nameOf)).toThrow(WATCH_NOT_A_COPY);
    // 'any' wins over a special, so '*' with copies 'any' is simply the any-copy watch.
    expect(watchWriteOf({ sku: BASE, copies: 'any', special: '*', minProfitScrap: 9 }, null, nameOf).specialKey).toBeNull();
  });

  it('names a watch: the input, else the existing name, else the item name, else the base SKU', () => {
    expect(watchWriteOf({ sku: BASE, name: '  My hat  ', onRestock: true }, null, nameOf).name).toBe('My hat');
    expect(watchWriteOf({ sku: BASE, name: '   ', onRestock: true }, watch({ name: 'Kept' }), nameOf).name).toBe('Kept');
    expect(watchWriteOf({ sku: BASE, name: '   ', onRestock: true }, null, nameOf).name).toBe('Team Captain');
    expect(watchWriteOf({ sku: '5021;6', onRestock: true }, null, nameOf).name).toBe('5021;6');
    expect(watchWriteOf({ sku: '5021;6', onRestock: true }, null, () => '  ').name).toBe('5021;6');
    expect(watchWriteOf({ sku: BASE, onRestock: true }, null, () => 'x'.repeat(400)).name).toHaveLength(WATCH_NAME_MAX);
  });

  it('words the targets that are set', () => {
    expect(watchTargetsText({ maxCostKeys: 2, maxCostScrap: 46, minProfitScrap: 12, onRestock: true }, K)).toBe('≤ 2 keys 5.11 ref · profit ≥ 1.33 ref · back on sale');
    expect(watchTargetsText({ maxCostKeys: 0, maxCostScrap: 17, minProfitScrap: null, onRestock: false }, K)).toBe('≤ 1.88 ref');
    expect(watchTargetsText({ maxCostKeys: 1, maxCostScrap: 0, minProfitScrap: 700, onRestock: false }, K)).toBe('≤ 1 key · profit ≥ 1 key 11.11 ref');
    expect(watchTargetsText({ maxCostKeys: 0, maxCostScrap: null, minProfitScrap: 700, onRestock: false }, null)).toBe('profit ≥ 77.77 ref');
    expect(watchTargetsText({ maxCostKeys: 0, maxCostScrap: null, minProfitScrap: null, onRestock: false }, K)).toBe('');
  });
});
