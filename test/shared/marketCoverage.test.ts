// F13 coverage strip rules (src/shared/market.ts), shared by the service and
// the mock: one entry per scrap.tf bank page in strip order, the newest saved
// page whose items fall mostly (>= 50%) into the page's categories, /items list
// pages counting for none. The URLs are the static bank pages the user opens in
// their own browser; nothing here fetches anything.

import { describe, expect, it } from 'vitest';
import { SCRAPTF_BANK_PAGES, scraptfPageFor } from '../../src/shared/links';
import { bankPageIndexOf, batchSavedAt, cleanCategoryCounts, countCategories, scraptfCoverage } from '../../src/shared/market';
import type { Category, ImportBatch } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;

function batch(id: number, over: Partial<ImportBatch> = {}): ImportBatch {
  return { id, fileName: `page ${id}.html`, pageKind: 'buy', fileMtime: T0 - id * MIN, importedAt: T0 - id * MIN + 1_000, itemCount: 10 * id, bank: null, ...over };
}

const index = (c: Category) => SCRAPTF_BANK_PAGES.findIndex((p) => p.category === c);

describe('bank pages', () => {
  it('are the six /buy pages then /unusuals, each URL the category page', () => {
    expect(SCRAPTF_BANK_PAGES.map((p) => p.label)).toEqual(['Hats', 'Weapons', 'Stranges', 'Killstreaks', 'Skins', 'Items', 'Unusuals']);
    expect(SCRAPTF_BANK_PAGES.map((p) => p.url)).toEqual([
      'https://scrap.tf/buy/hats',
      'https://scrap.tf/buy/weapons',
      'https://scrap.tf/buy/stranges',
      'https://scrap.tf/buy/killstreaks',
      'https://scrap.tf/buy/skins',
      'https://scrap.tf/buy/items',
      'https://scrap.tf/unusuals',
    ]);
    for (const p of SCRAPTF_BANK_PAGES) for (const c of p.categories) expect(scraptfPageFor(c)).toBe(p.url);
  });
});

describe('bankPageIndexOf', () => {
  it('picks the page holding at least half of the items', () => {
    expect(bankPageIndexOf('buy', ['hats', 'hats', 'weapons'])).toBe(index('hats'));
    expect(bankPageIndexOf('buy', ['hats', 'weapons'])).toBe(index('hats'));
    expect(bankPageIndexOf('buy', ['taunts', 'other', 'hats'])).toBe(index('other'));
    expect(bankPageIndexOf('unusuals', ['unusuals', 'unusuals', 'taunts'])).toBe(index('unusuals'));
  });

  it('counts no page for an /items list, an empty page, or no majority', () => {
    expect(bankPageIndexOf('items-list', ['hats', 'hats'])).toBe(-1);
    expect(bankPageIndexOf('buy', [])).toBe(-1);
    expect(bankPageIndexOf('buy', ['hats', 'weapons', 'stranges'])).toBe(-1);
  });
});

describe('scraptfCoverage', () => {
  it('lists every page in order, never saved ones with null and 0 items', () => {
    const cov = scraptfCoverage([], () => []);
    expect(cov.map((c) => [c.category, c.label, c.url, c.lastSavedAt, c.items])).toEqual(
      SCRAPTF_BANK_PAGES.map((p) => [p.category, p.label, p.url, null, 0]),
    );
  });

  it('takes the newest page per bank page, by file time, with its item count', () => {
    const cats = new Map<number, Category[]>([
      [1, ['hats', 'hats']],
      [2, ['hats']],
      [3, ['weapons', 'hats', 'weapons']],
      [4, ['unusuals']],
    ]);
    const cov = scraptfCoverage([batch(1), batch(2), batch(3), batch(4)], (id) => cats.get(id) ?? []);
    const at = (c: Category) => cov[index(c)]!;
    expect(at('hats')).toMatchObject({ lastSavedAt: T0 - MIN, items: 10 });
    expect(at('weapons')).toMatchObject({ lastSavedAt: T0 - 3 * MIN, items: 30 });
    expect(at('unusuals')).toMatchObject({ lastSavedAt: T0 - 4 * MIN, items: 40 });
    expect(at('skins')).toMatchObject({ lastSavedAt: null, items: 0 });
  });

  it('ignores /items list pages even when newer', () => {
    const cov = scraptfCoverage([batch(5), batch(1, { pageKind: 'items-list' })], () => ['hats']);
    expect(cov[index('hats')]).toMatchObject({ lastSavedAt: T0 - 5 * MIN, items: 50 });
  });

  it('uses the import time when the file time is unknown, and the higher id on a tie', () => {
    expect(batchSavedAt({ fileMtime: 0, importedAt: T0 })).toBe(T0);
    expect(batchSavedAt({ fileMtime: Number.NaN, importedAt: T0 })).toBe(T0);
    expect(batchSavedAt({ fileMtime: T0 - MIN, importedAt: T0 })).toBe(T0 - MIN);
    const cov = scraptfCoverage([batch(7, { fileMtime: T0, itemCount: 1 }), batch(8, { fileMtime: T0, itemCount: 2 })], () => ['skins']);
    expect(cov[index('skins')]).toMatchObject({ lastSavedAt: T0, items: 2 });
  });

  it('classifies a batch from the categories it stored when imported, not the rows that carry its id today', () => {
    // A later /items list re-tagged every row of the hats page: none carry batch 2 any more.
    const rowsNow = new Map<number, Category[]>([[1, ['hats', 'hats']]]);
    const asked: number[] = [];
    const categoriesOf = (id: number) => {
      asked.push(id);
      return rowsNow.get(id) ?? [];
    };
    const hats = batch(2, { itemCount: 2, categories: { hats: 2 } });
    const list = batch(1, { pageKind: 'items-list', itemCount: 2, categories: { hats: 2 } });
    expect(scraptfCoverage([list, hats], categoriesOf)[index('hats')]).toMatchObject({ lastSavedAt: T0 - 2 * MIN, items: 2 });
    expect(asked).toEqual([]);
    // A batch from before 0.3 (no categories) still reads its rows.
    const old = batch(3, { categories: null });
    rowsNow.set(3, ['weapons']);
    expect(scraptfCoverage([old], categoriesOf)[index('weapons')]).toMatchObject({ lastSavedAt: T0 - 3 * MIN });
    expect(asked).toEqual([3]);
    // A mixed page keeps the majority it had when saved.
    expect(scraptfCoverage([batch(4, { categories: { hats: 1, weapons: 1, stranges: 1 } })], () => ['hats'])[index('hats')]!.lastSavedAt).toBeNull();
  });
});

describe('category counts', () => {
  it('decide the page like a category per item', () => {
    expect(bankPageIndexOf('buy', { hats: 2, weapons: 1 })).toBe(index('hats'));
    expect(bankPageIndexOf('buy', { taunts: 1, other: 1, hats: 1 })).toBe(index('other'));
    expect(bankPageIndexOf('buy', { hats: 1, weapons: 1, stranges: 1 })).toBe(-1);
    expect(bankPageIndexOf('items-list', { hats: 5 })).toBe(-1);
    expect(bankPageIndexOf('buy', {})).toBe(-1);
    expect(countCategories(['hats', 'weapons', 'hats'])).toEqual({ hats: 2, weapons: 1 });
  });

  it('keep only known categories with whole counts of 1 or more', () => {
    expect(cleanCategoryCounts({ hats: 2.9, weapons: 0, x: 4, unusuals: -1, skins: '3' })).toEqual({ hats: 2 });
    expect(cleanCategoryCounts({ weapons: 0 })).toBeNull();
    expect(cleanCategoryCounts(null)).toBeNull();
    expect(cleanCategoryCounts(['hats'])).toBeNull();
    expect(cleanCategoryCounts('hats')).toBeNull();
  });
});
