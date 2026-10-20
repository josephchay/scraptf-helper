import { describe, expect, it } from 'vitest';
import { scraptfPageFor } from '../../src/shared/links';
import { CATEGORIES, CATEGORY_LABELS } from '../../src/shared/types';
import type { KeyPriceState, Opportunity, OrderSummary, ShoppingRow } from '../../src/shared/types';
import { CSV_BOM } from '../../src/service/domain/csv';
import { buildShoppingList, shoppingCsv } from '../../src/service/domain/shopping';
import { T0 } from './helpers';

const K = 567;
const KP: KeyPriceState = { valueScrap: K, source: 'pricedb', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };

function order(valueScrap: number, isBot: boolean, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: `l${valueScrap}${isBot ? 'b' : 'h'}`,
    steamid: '76561198000000001',
    userName: isBot ? 'Bot' : 'Human',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot,
    online: true,
    lastEventAt: T0,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

/** A stored row; the conservative order is the revenue order, a bot unless `bot: false`. */
function opp(sku: string, over: Partial<Opportunity> & { bot?: boolean } = {}): Opportunity {
  const { bot = true, ...rest } = over;
  const inputRef = rest.inputRef ?? 'price:1';
  const revenueScrap = rest.revenueScrap === undefined ? 150 : rest.revenueScrap;
  const cons = revenueScrap === null ? null : order(revenueScrap, bot);
  return {
    key: `${sku}|${inputRef}`,
    sku,
    name: `Item ${sku}`,
    category: 'hats',
    inputRef,
    inputKind: inputRef.startsWith('rule:') ? 'rule' : 'user',
    costKeys: 0,
    costScrapRaw: 100,
    costScrap: 100,
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: bot ? revenueScrap : null,
    revenueScrap,
    profitScrap: revenueScrap === null ? null : revenueScrap - 100,
    margin: revenueScrap === null ? null : (revenueScrap - 100) / 100,
    maxCostScrap: revenueScrap === null ? null : revenueScrap - 12,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    reasons: [],
    buyerCount: 2,
    bestOrder: cons,
    consOrder: cons,
    instantOrder: bot ? cons : null,
    references: { pricedb: null, community: null },
    profitTier: 'ref2',
    status: revenueScrap === null ? 'no-buyers' : 'profitable',
    inputObservedAt: T0,
    firstSeenAt: T0,
    updatedAt: T0,
    ...rest,
  };
}

describe('buildShoppingList', () => {
  it('keeps one row per SKU with a positive ceiling and real buyers', () => {
    const rows = [
      opp('1;6'),
      opp('2;6', { revenueScrap: null }),
      opp('3;6', { maxCostScrap: 0 }),
      opp('4;6', { maxCostScrap: null }),
      opp('5;6', { status: 'no-buyers' }),
    ];
    const r = buildShoppingList(rows, {}, KP, T0 + 5);
    expect(r.rows.map((x) => x.sku)).toEqual(['1;6']);
    expect(r.total).toBe(1);
    expect(r.keyPrice).toBe(KP);
    expect(r.generatedAt).toBe(T0 + 5);
    expect(r.rows[0]).toEqual({
      sku: '1;6',
      name: 'Item 1;6',
      category: 'hats',
      bankPageUrl: scraptfPageFor('hats'),
      maxCostScrap: 138,
      revenueScrap: 150,
      revenueOrder: rows[0]!.consOrder,
      confidence: 60,
      confidenceLevel: 'medium',
      buyerCount: 2,
      knownCostScrap: 100,
      knownMaxCostScrap: 138,
      underCeiling: true,
      inputKinds: ['user'],
      flags: [],
      updatedAt: T0,
      knownObservedAt: T0,
      knownStock: null,
      knownStale: false,
    } satisfies ShoppingRow);
  });

  it("never judges one copy's price against another copy's ceiling (plain and painted under one SKU)", () => {
    // The plain copy sells to generic orders at 100; the painted one to paint-specific orders at 200.
    const plain = (over: Partial<Opportunity>) =>
      opp('378;6', { inputRef: 'price:1', revenueScrap: 100, maxCostScrap: 91, status: 'unprofitable', ...over });
    const painted = (over: Partial<Opportunity>) =>
      opp('378;6', { inputRef: 'price:2', inputKind: 'import', revenueScrap: 200, maxCostScrap: 185, ...over });

    // Plain newest, painted chosen: the plain 150 is a 50 scrap loss, not "under the 185 ceiling".
    const [a] = buildShoppingList(
      [plain({ costScrap: 150, confidence: 60, inputObservedAt: T0 - 60_000 }), painted({ costScrap: 160, confidence: 85, inputObservedAt: T0 - 180_000 })],
      {},
      KP,
      T0,
    ).rows;
    expect(a).toMatchObject({ maxCostScrap: 185, knownCostScrap: 160, knownMaxCostScrap: 185, underCeiling: true });

    // Painted newest, plain chosen: the plain 90 is under its own 91 ceiling.
    const [b] = buildShoppingList(
      [plain({ costScrap: 90, confidence: 85, inputObservedAt: T0 - 180_000 }), painted({ costScrap: 150, confidence: 60, inputObservedAt: T0 - 60_000 })],
      {},
      KP,
      T0,
    ).rows;
    expect(b).toMatchObject({ maxCostScrap: 91, knownCostScrap: 90, knownMaxCostScrap: 91, underCeiling: true });

    // A rule chosen: the newest typed price keeps its own ceiling, even without one.
    const rule = opp('378;6', { inputRef: 'rule:1', confidence: 95, revenueScrap: 300, maxCostScrap: 276 });
    const [c] = buildShoppingList([rule, plain({ costScrap: 150, inputObservedAt: T0 })], {}, KP, T0).rows;
    expect(c).toMatchObject({ maxCostScrap: 276, knownCostScrap: 150, knownMaxCostScrap: 91, underCeiling: false });
    const [d] = buildShoppingList([rule, plain({ costScrap: 50, maxCostScrap: null, inputObservedAt: T0 })], {}, KP, T0).rows;
    expect(d).toMatchObject({ knownCostScrap: 50, knownMaxCostScrap: null, underCeiling: false });
  });

  it('takes the ceiling from the most confident input and the known cost from the newest typed or imported price', () => {
    const rows = [
      opp('7;6', { inputRef: 'price:1', confidence: 50, maxCostScrap: 300, costScrap: 120, inputObservedAt: T0 - 1000 }),
      opp('7;6', { inputRef: 'price:2', inputKind: 'import', confidence: 80, maxCostScrap: 200, costScrap: 250, inputObservedAt: T0 }),
      opp('7;6', { inputRef: 'rule:9', confidence: 90, maxCostScrap: 0, costScrap: 10, inputObservedAt: T0 + 1000 }),
    ];
    const [row] = buildShoppingList(rows, {}, KP, T0).rows;
    // The rule row has no ceiling, so it cannot win; the 80-confidence import does.
    expect(row).toMatchObject({ maxCostScrap: 200, confidence: 80, knownCostScrap: 250, underCeiling: false, inputKinds: ['user', 'import', 'rule'] });

    // Equal confidence: the higher ceiling, then the newer, cheaper copy or higher id, then the key, so the pick never flips between calls.
    const tie = [opp('8;6', { inputRef: 'price:2', maxCostScrap: 90 }), opp('8;6', { inputRef: 'price:1', maxCostScrap: 90 }), opp('8;6', { inputRef: 'price:3', maxCostScrap: 80 })];
    expect(buildShoppingList(tie, {}, KP, T0).rows[0]!.maxCostScrap).toBe(90);
    expect(buildShoppingList([...tie].reverse(), {}, KP, T0).rows[0]).toEqual(buildShoppingList(tie, {}, KP, T0).rows[0]);
  });

  it('leaves the known cost empty when only rules match', () => {
    const [row] = buildShoppingList([opp('9;6', { inputRef: 'rule:1', costScrap: 40 })], {}, KP, T0).rows;
    expect(row).toMatchObject({ knownCostScrap: null, underCeiling: null, inputKinds: ['rule'] });
  });

  it('sorts by category order, then ceiling, then name, and groups every match', () => {
    const rows = [
      opp('10;6', { category: 'weapons', maxCostScrap: 50, name: 'b' }),
      opp('11;6', { category: 'hats', maxCostScrap: 20, name: 'z' }),
      opp('12;6', { category: 'weapons', maxCostScrap: 90, name: 'a' }),
      opp('13;6', { category: 'hats', maxCostScrap: 80, name: 'y' }),
      opp('14;6', { category: 'weapons', maxCostScrap: 50, name: 'A' }),
    ];
    const r = buildShoppingList(rows, {}, KP, T0);
    expect(CATEGORIES.indexOf('hats')).toBeLessThan(CATEGORIES.indexOf('weapons'));
    expect(r.rows.map((x) => x.sku)).toEqual(['13;6', '11;6', '12;6', '14;6', '10;6']);
    expect(r.groups).toEqual([
      { category: 'hats', label: CATEGORY_LABELS.hats, count: 2, bankPageUrl: scraptfPageFor('hats') },
      { category: 'weapons', label: CATEGORY_LABELS.weapons, count: 3, bankPageUrl: scraptfPageFor('weapons') },
    ]);
  });

  it('filters by category, search tokens, minimum ceiling and bot buyers', () => {
    const rows = [
      opp('20;6', { name: 'Strange Rocket Launcher', category: 'weapons', maxCostScrap: 100 }),
      opp('21;6', { name: 'Team Captain', category: 'hats', maxCostScrap: 300, bot: false }),
      opp('22;6', { name: 'Strange Scattergun', category: 'weapons', maxCostScrap: 40 }),
      opp('23;6', { name: 'Bill’s Hat', category: 'hats', maxCostScrap: 200 }),
    ];
    const skus = (q: Parameters<typeof buildShoppingList>[1]) => buildShoppingList(rows, q, KP, T0).rows.map((r) => r.sku).sort();
    expect(skus({ categories: ['weapons'] })).toEqual(['20;6', '22;6']);
    expect(skus({ categories: [] })).toHaveLength(4);
    expect(skus({ search: '  rocket   STRANGE ' })).toEqual(['20;6']);
    expect(skus({ search: '22;6' })).toEqual(['22;6']);
    expect(skus({ search: 'bill’s' })).toEqual(['23;6']);
    expect(skus({ minCeilingScrap: 200 })).toEqual(['21;6', '23;6']);
    expect(skus({ onlyBotBuyers: true })).toEqual(['20;6', '22;6', '23;6']);
    expect(skus({ categories: ['hats'], onlyBotBuyers: true, minCeilingScrap: 1 })).toEqual(['23;6']);
    // Groups and the total count matches, not the page.
    const r = buildShoppingList(rows, { categories: ['weapons'], limit: 1 }, KP, T0);
    expect(r.total).toBe(2);
    expect(r.rows).toHaveLength(1);
    expect(r.groups).toEqual([{ category: 'weapons', label: CATEGORY_LABELS.weapons, count: 2, bankPageUrl: scraptfPageFor('weapons') }]);
  });

  it('pages with offset and limit, and returns every row when limit is omitted', () => {
    const rows = Array.from({ length: 7 }, (_, i) => opp(`${30 + i};6`, { maxCostScrap: 100 - i }));
    const all = buildShoppingList(rows, {}, KP, T0);
    expect(all.rows).toHaveLength(7);
    expect(buildShoppingList(rows, { limit: 3, offset: 2 }, KP, T0).rows.map((r) => r.sku)).toEqual(['32;6', '33;6', '34;6']);
    expect(buildShoppingList(rows, { offset: 5 }, KP, T0).rows.map((r) => r.sku)).toEqual(['35;6', '36;6']);
    expect(buildShoppingList(rows, { offset: 50, limit: 3 }, KP, T0).rows).toEqual([]);
    expect(buildShoppingList(rows, { limit: 0 }, KP, T0).rows).toHaveLength(1);
    expect(buildShoppingList(rows, { limit: Number.NaN, offset: -3 }, KP, T0).rows).toHaveLength(7);
  });

  it('finds the revenue order by value whatever useOrder chose', () => {
    const best = order(400, false, { listingId: 'whale' });
    const cons = order(150, false, { listingId: 'human' });
    const inst = order(140, true, { listingId: 'bot' });
    const base = opp('40;6', { bestOrder: best, consOrder: cons, instantOrder: inst, bestScrap: 400, consScrap: 150, instantScrap: 140 });
    const pick = (revenueScrap: number) => buildShoppingList([{ ...base, revenueScrap }], {}, KP, T0).rows[0]!.revenueOrder?.listingId;
    expect(pick(150)).toBe('human');
    expect(pick(400)).toBe('whale');
    expect(pick(140)).toBe('bot');
    expect(buildShoppingList([{ ...base, revenueScrap: 140 }], { onlyBotBuyers: true }, KP, T0).rows).toHaveLength(1);
    expect(buildShoppingList([{ ...base, revenueScrap: 150 }], { onlyBotBuyers: true }, KP, T0).rows).toHaveLength(0);
  });

  it("says how old the known price is, whether it is stale, and its stock (ACT-9)", () => {
    const HOUR = 60 * 60_000;
    const rows = [
      // A rule wins the ceiling; the known price is the newest typed or imported one, a 3 h old import.
      opp('60;6', { inputRef: 'rule:1', confidence: 95, maxCostScrap: 140 }),
      opp('60;6', { inputRef: 'price:7', inputKind: 'import', inputObservedAt: T0 - 3 * HOUR, flags: ['stale-input'] }),
      opp('61;6', { inputRef: 'price:8', inputObservedAt: T0 - 5 * 60_000 }),
      opp('62;6', { inputRef: 'rule:2' }),
    ];
    const asked: string[] = [];
    const stock: Record<string, number | null> = { 'price:7': 2, 'price:8': null };
    const r = buildShoppingList(rows, {}, KP, T0, { stockOf: (ref) => (asked.push(ref), stock[ref] ?? null) });
    const by = (sku: string) => r.rows.find((x) => x.sku === sku)!;
    expect(by('60;6')).toMatchObject({ maxCostScrap: 140, knownCostScrap: 100, knownObservedAt: T0 - 3 * HOUR, knownStale: true, knownStock: 2 });
    expect(by('61;6')).toMatchObject({ knownObservedAt: T0 - 5 * 60_000, knownStale: false, knownStock: null });
    // Only rules: nothing known, so nothing old and nothing asked.
    expect(by('62;6')).toMatchObject({ knownCostScrap: null, knownObservedAt: null, knownStale: false, knownStock: null });
    expect(asked.sort()).toEqual(['price:7', 'price:8']);

    // Only the rows returned are asked for their stock; a failing or odd answer is unknown.
    asked.length = 0;
    const page = buildShoppingList(rows, { limit: 1 }, KP, T0, { stockOf: (ref) => (asked.push(ref), 3) });
    expect(page.rows).toHaveLength(1);
    expect(asked).toHaveLength(1);
    const broken = buildShoppingList(rows, {}, KP, T0, {
      stockOf: () => {
        throw new Error('db gone');
      },
    });
    expect(broken.rows.map((x) => x.knownStock)).toEqual([null, null, null]);
    expect(buildShoppingList(rows, {}, KP, T0, { stockOf: () => -1 }).rows.map((x) => x.knownStock)).toEqual([null, null, null]);
    // Without a lookup (the default), stock is unknown.
    expect(buildShoppingList(rows, {}, KP, T0).rows.map((x) => x.knownStock)).toEqual([null, null, null]);
  });

  it('copes with an empty or missing query', () => {
    expect(buildShoppingList([], {}, null, T0)).toEqual({ rows: [], total: 0, groups: [], keyPrice: null, generatedAt: T0 });
    expect(buildShoppingList([opp('50;6')], undefined as unknown as object, KP, T0).total).toBe(1);
  });
});

describe('shoppingCsv', () => {
  it('writes the spec columns with prices as scrap.tf shows them', () => {
    const rows = buildShoppingList(
      [
        opp('378;6', { name: '=Team Captain', revenueScrap: 700, maxCostScrap: 650 }),
        opp('126;6', { inputRef: 'rule:1', revenueScrap: 90, maxCostScrap: 81, bot: false }),
      ],
      {},
      KP,
      T0,
    ).rows;
    const csv = shoppingCsv(rows, K);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('sku,name,category,pay_up_to,revenue,buyer,confidence,known_cost,under_ceiling,bank_page');
    // Same category, so the higher ceiling comes first.
    expect(lines[1]).toBe(`378;6,'=Team Captain,hats,1 key 9.22 ref,1 key 14.77 ref,Bot (bot),60,11.11 ref,true,${scraptfPageFor('hats')}`);
    expect(lines[2]).toBe(`126;6,Item 126;6,hats,9.00 ref,10.00 ref,Human (human),60,,,${scraptfPageFor('hats')}`);
    expect(lines[3]).toBe('');
    // Without a key price everything is in refined.
    expect(shoppingCsv(rows, null).split('\r\n')[1]).toContain(',72.22 ref,77.77 ref,');
  });

  it('writes a header even with no rows', () => {
    expect(shoppingCsv([], K)).toBe(`${CSV_BOM}sku,name,category,pay_up_to,revenue,buyer,confidence,known_cost,under_ceiling,bank_page\r\n`);
  });
});
