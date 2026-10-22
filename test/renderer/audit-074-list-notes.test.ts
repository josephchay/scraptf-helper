// 0.7.4: what the dashboard says about scrap.tf/items family rows and the V14 clean-up. The Import page's
// result counts the rows read as one row for every copy (no cost of their own), the Import page and the
// banks page's All items card say to read scrap.tf/items again once the upgrade emptied the price list, and
// the Live market's Stock cell says a family row's stock counts every copy. Pure helpers; no network.

import { describe, expect, it } from 'vitest';
import { bankSavedText } from '../../src/renderer/banksModel';
import { holdingExitView } from '../../src/renderer/holdingsModel';
import { importListFamilyText, listRereadNote, listStockCell } from '../../src/renderer/scraptfListModel';
import { SKIP_CRAFT_UNPROVEN } from '../../src/shared/importCodes';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;

describe('the Import page after a list read', () => {
  it("counts the family rows the page gave, which are on the list but no cost of their own", () => {
    expect(importListFamilyText({ pageKind: 'items-list', skippedCounts: { [SKIP_CRAFT_UNPROVEN]: 336, 'out of stock on scrap.tf': 357 } })).toBe(
      '336 of them are rows for every copy at their price (the list does not show Craftable or Non-Craftable): kept on your price list, but no cost of their own. Your saved bank pages price each copy.',
    );
    expect(importListFamilyText({ pageKind: 'items-list', skippedCounts: { [SKIP_CRAFT_UNPROVEN]: 1 } })).toMatch(/^1 of them is a row for every copy at its price/);
    expect(importListFamilyText({ pageKind: 'items-list', skippedCounts: {} })).toBeNull();
    expect(importListFamilyText({ pageKind: 'buy', skippedCounts: { [SKIP_CRAFT_UNPROVEN]: 3 } })).toBeNull();
  });

  it('says to read scrap.tf/items again while the upgrade left the price list empty', () => {
    const lists = [{ pageKind: 'buy' as const }, { pageKind: 'items-list' as const }];
    expect(listRereadNote({ items: 0 }, lists)).toMatch(/^Your price list is empty: Flip Desk 0\.7\.4 cleared the rows/);
    // Read again (rows stored), never read, or not answered yet: nothing to say.
    expect(listRereadNote({ items: 698 }, lists)).toBeNull();
    expect(listRereadNote({ items: 0 }, [{ pageKind: 'buy' }])).toBeNull();
    expect(listRereadNote(undefined, lists)).toBeNull();
    expect(listRereadNote({ items: 0 }, undefined)).toBeNull();
  });
});

describe('the All items card', () => {
  it('says a read kept no rows and to read scrap.tf/items again', () => {
    const t = bankSavedText({ lastSavedAt: NOW - 20 * 60 * MIN, pages: 1, items: 0, inStock: 0 }, NOW, true);
    expect(t.text).toBe('read 20 h ago · no rows kept: read scrap.tf/items again');
    expect(t.title).toContain('Flip Desk 0.7.4 cleared the rows');
    // A bank page's card with no items reads as before.
    expect(bankSavedText({ lastSavedAt: NOW - 60 * MIN, pages: 1, items: 0, inStock: 0 }, NOW).text).toBe('saved 1 h ago · 0 items (0 in stock)');
  });
});

describe("Holdings' scrap.tf exit from a family row", () => {
  it('says the pays price is one row for every copy at its price', () => {
    const row = { revenueScrap: null, bestScrap: null, instantScrap: null, revenueOrder: null, buyerCount: 0, bestExit: 'scraptf' as const, exitScrap: 900, scraptfPaysScrap: 900, scraptfFull: false, scraptfListAt: NOW - 3 * MIN };
    expect(holdingExitView(row, 577, NOW).title).not.toContain('every copy');
    expect(holdingExitView({ ...row, scraptfListFamily: true }, 577, NOW).title).toContain('One scrap.tf/items row for every copy at this price: scrap.tf pays this for any copy that row stands for.');
  });
});

describe("the Live market's Stock cell", () => {
  it("says a family row's stock counts every copy", () => {
    const row = { scraptfPaysScrap: 1000, scraptfStock: 4, scraptfStockLimit: 25, scraptfFull: false, scraptfListAt: NOW - 3 * MIN };
    expect(listStockCell(row, NOW).title).not.toContain('every copy');
    const family = listStockCell({ ...row, scraptfListFamily: true }, NOW);
    expect(family.text).toBe(listStockCell(row, NOW).text);
    expect(family.title).toContain('One scrap.tf/items row for every copy at this price: its stock counts every copy');
  });
});
