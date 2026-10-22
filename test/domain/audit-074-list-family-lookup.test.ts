// 0.7.4 (F01): an unmarked scrap.tf/items row stands for every copy scrap.tf sells at its price, so the list
// cache's lookups (rowFor, has: the drawer, the Live market, Holdings, the Live check) read it for a copy
// with no row of its own (a Non-Craftable, killstreak or festivized copy), as 'family'. Never a row proven
// for other copies, never past a Non-Craftable row of the item's own, never across effect, wear, paintkit,
// australium, quality or crate series, never for a kit. Plus the repo reads behind DM-3 and F60. Local only.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { scraptfListCraftProven, scraptfListFamilyOf, scraptfListLookup } from '../../src/shared/scraptfList';
import type { KeyPriceState, ScraptfListCraft, ScraptfListStored } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };
const quiet = () => undefined;
const log = { debug: quiet, info: quiet, warn: quiet, error: quiet };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function row(sku: string, craft: ScraptfListCraft, over: Partial<ScraptfListStored> = {}): ScraptfListStored {
  return { sku, name: sku, sellsKeys: 1, sellsScrap: 389, paysKeys: 1, paysScrap: 333, stock: 4, stockLimit: 25, batchId: 1, observedAt: T0, craft, ...over };
}

function cacheOf(rows: ScraptfListStored[]) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertScraptfList(rows);
  return createScraptfListCache({ repo, log, keyPrice: () => KEY });
}

describe('scraptfListFamilyOf', () => {
  it('drops craftability, killstreak tier, festivizing and paint, and keeps what scrap.tf lists apart', () => {
    expect(scraptfListFamilyOf('5040;6;uncraftable')).toBe('5040;6');
    expect(scraptfListFamilyOf('30666;6;kt-2')).toBe('30666;6');
    expect(scraptfListFamilyOf('197;11;australium;kt-2;festive')).toBe('197;11;australium');
    expect(scraptfListFamilyOf('378;6;p15185211')).toBe('378;6');
    expect(scraptfListFamilyOf('30743;5;u13')).toBe('30743;5;u13');
    expect(scraptfListFamilyOf('15013;15;u702;w3;pk214')).toBe('15013;15;u702;w3;pk214');
    expect(scraptfListFamilyOf('5981;6;c153;uncraftable')).toBe('5981;6;c153');
    expect(scraptfListFamilyOf('200;1;strange;kt-1')).toBe('200;1;strange');
    // A kit is its tier and target: no family.
    expect(scraptfListFamilyOf('6526;6;uncraftable;kt-3;td-205')).toBeNull();
    expect(scraptfListFamilyOf('')).toBeNull();
  });
});

describe('rowFor and has: a copy with no row of its own reads its family row', () => {
  it("gives a Non-Craftable, killstreak or festivized copy the unmarked row, as 'family'", () => {
    const list = cacheOf([row('5040;6', 'any'), row('30666;6', 'any', { stock: 5 }), row('197;11;australium', 'any')]);
    expect(list.rowFor('5040;6;uncraftable')).toMatchObject({ sku: '5040;6', match: 'family', stock: 4 });
    expect(list.rowFor('30666;6;kt-2')).toMatchObject({ sku: '30666;6', match: 'family', stock: 5 });
    expect(list.rowFor('197;11;australium;kt-2;festive')).toMatchObject({ sku: '197;11;australium', match: 'family' });
    expect(list.has('30666;6;kt-1')).toBe(true);
    // The row of its own copy is exact (no match field), as before; a painted copy still reads its plain row.
    expect(list.rowFor('5040;6')!.match).toBeUndefined();
    expect(list.rowFor('5040;6;p15185211')!.match).toBeUndefined();
    // Never its cost: a family row's price is no copy's own.
    expect(scraptfListCraftProven(list.rowFor('5040;6;uncraftable')!)).toBe(false);
    expect(scraptfListCraftProven(list.rowFor('5040;6')!)).toBe(false);
  });

  it("keeps a copy scrap.tf lists apart on its own row, and never lends a proven row to another copy", () => {
    const list = cacheOf([row('725;6', 'craftable', { sellsScrap: 279 }), row('725;6;uncraftable', 'uncraftable', { sellsScrap: 273 }), row('5040;6', 'craftable')]);
    expect(list.rowFor('725;6')).toMatchObject({ sellsScrapRaw: 279, craft: 'craftable' });
    expect(list.rowFor('725;6;uncraftable')).toMatchObject({ sellsScrapRaw: 273, craft: 'uncraftable' });
    // Its killstreak copies read neither (each row prices one craftability).
    expect(list.rowFor('725;6;uncraftable;kt-1')).toBeNull();
    // A row proven Craftable says nothing of the Non-Craftable copy.
    expect(list.rowFor('5040;6;uncraftable')).toBeNull();
    expect(scraptfListCraftProven(list.rowFor('725;6;uncraftable')!)).toBe(true);
  });

  it('never resolves across effect, wear, quality or australium, nor for a kit', () => {
    const list = cacheOf([row('30743;5;u13', 'any'), row('205;11', 'any'), row('6526;6;uncraftable;kt-3;td-205', 'uncraftable')]);
    expect(list.rowFor('30743;5;u14')).toBeNull();
    expect(list.rowFor('205;11;australium')).toBeNull();
    expect(list.rowFor('205;6')).toBeNull();
    expect(list.rowFor('6526;6;uncraftable;kt-3;td-206')).toBeNull();
    expect(list.rowFor('6526;6;uncraftable;kt-3;td-205')).toMatchObject({ craft: 'uncraftable' });
  });

  it('the browser mock reads the same rows (scraptfListLookup over any store)', () => {
    const rows = new Map([row('5040;6', 'any'), row('725;6;uncraftable', 'uncraftable')].map((r) => [r.sku, r]));
    expect(scraptfListLookup((s) => rows.get(s), '5040;6;uncraftable')).toMatchObject({ match: 'family', stored: { sku: '5040;6' } });
    expect(scraptfListLookup((s) => rows.get(s), '725;6;uncraftable')).toMatchObject({ match: 'exact' });
    expect(scraptfListLookup((s) => rows.get(s), '126;6')).toBeNull();
  });
});

describe('the repo reads behind DM-3 and F60', () => {
  function repoWith(): Repo {
    const repo = openRepo(':memory:');
    repos.push(repo);
    return repo;
  }

  it("bankStockNewestBankOf: the bank of a SKU's newest bank stock row, never the list's or /unusuals'", () => {
    const repo = repoWith();
    const save = (bank: 'hats' | 'items' | 'list' | 'unusuals', at: number, sku: string) => {
      const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: 1, bank });
      repo.insertBankStock(id, bank, [{ sku, specialKey: '', name: sku, costKeys: 0, costScrap: 9, stock: 1, assetId: null }], `/${bank}`);
    };
    save('hats', T0 - 3000, '378;6');
    save('items', T0 - 2000, '378;6');
    save('list', T0 - 1000, '378;6');
    save('unusuals', T0 - 500, '378;6');
    expect(repo.bankStockNewestBankOf(['378;6'])).toBe('items');
    expect(repo.bankStockNewestBankOf(['5040;6'])).toBeNull();
    save('hats', T0 - 100, '5040;6');
    expect(repo.bankStockNewestBankOf(['378;6', '5040;6'])).toBe('hats');
    expect(repo.bankStockNewestBankOf([])).toBeNull();
  });

  it('deleteScraptfListRows: only those SKUs, only rows observed before the time', () => {
    const repo = repoWith();
    repo.upsertScraptfList([row('5040;6', 'any', { observedAt: T0 - 1000 }), row('5039;6', 'any', { observedAt: T0 }), row('126;6', 'any', { observedAt: T0 - 1000 })]);
    expect(repo.deleteScraptfListRows(['5040;6', '5039;6'], T0)).toBe(1);
    expect(repo.scraptfList().map((r) => r.sku)).toEqual(['126;6', '5039;6']);
    expect(repo.deleteScraptfListRows([], T0)).toBe(0);
  });
});
