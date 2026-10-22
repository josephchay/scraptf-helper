// 0.7.4 in the item drawer. F65: a look of the item's page newer than the stored save its stock line and
// history read (a window read cut short, a partial look) stored its prices but no save, so the drawer says so
// and never labels the older save "Now" (the user's drawer read "6 min ago, stock 4/25" beside "20 h ago,
// stock not shown"). F68: the input card names a price row as a price, with its import batch, not as a page.
// Pure helpers; nothing here touches the network or scrap.tf.

import { describe, expect, it } from 'vitest';
import { unsavedLookOf, unsavedLookText } from '../../src/renderer/banksModel';
import { fmtSaveTime } from '../../src/renderer/changesModel';
import { historyChips, historyNowText } from '../../src/renderer/historyModel';
import { inputCardLabel } from '../../src/renderer/oppModel';
import { valueScraptfListRow } from '../../src/shared/scraptfList';
import type { ItemDetail, ScraptfItemHistory, ScraptfListStored } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 20, 11, 46, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 577;

function listRow(over: Partial<ScraptfListStored> = {}) {
  return valueScraptfListRow({ sku: '5040;6', name: 'A Distinctive Lack of Hue', sellsKeys: 1, sellsScrap: 389, paysKeys: 1, paysScrap: 333, stock: 4, stockLimit: 25, batchId: 33, observedAt: NOW - 6 * MIN, craft: 'uncraftable', ...over }, K);
}

type DrawerPart = Pick<ItemDetail, 'sku' | 'bankStock' | 'seenOn' | 'scraptfList'>;
function drawer(over: Partial<DrawerPart> = {}): DrawerPart {
  return {
    sku: '5040;6',
    // The newest stored save of the list: 20 h old.
    bankStock: { bank: 'list', savedAt: NOW - 20 * HOUR, change: null, previousCostScrap: null, stock: null },
    seenOn: null,
    scraptfList: listRow(),
    ...over,
  };
}

function listHistory(over: Partial<ScraptfItemHistory> = {}): ScraptfItemHistory {
  const at = NOW - 20 * HOUR;
  return {
    sku: '5040;6',
    specialKey: '',
    name: 'A Distinctive Lack of Hue',
    bank: 'list',
    points: [{ at, bank: 'list', costKeys: 1, costScrapRaw: 389, costScrap: K + 389, stock: null, listed: true }],
    firstSeenAt: at,
    listedSince: at,
    lastSeenAt: at,
    current: { costScrap: K + 389, stock: null, bank: 'list' },
    change: { h1: { fromScrap: K + 389, toScrap: K + 389, deltaScrap: 0, pct: 0, since: at }, h24: null, d7: null, listed: null },
    events: [],
    keyPrice: null,
    generatedAt: NOW,
    ...over,
  };
}

describe('a newer look that stored no save (F65)', () => {
  it("finds the list read newer than the list's newest stored save, with the stock it showed", () => {
    expect(unsavedLookOf(drawer(), NOW)).toEqual({ bank: 'list', at: NOW - 6 * MIN, stock: 4, stockLimit: 25 });
    // No stored save of the list at all: the read is still newer than nothing.
    expect(unsavedLookOf(drawer({ bankStock: null }), NOW)).toMatchObject({ bank: 'list', at: NOW - 6 * MIN });
  });

  it('finds none when the stored save is the newest look, or for another copy', () => {
    expect(unsavedLookOf(drawer({ bankStock: { bank: 'list', savedAt: NOW - 6 * MIN, change: null, previousCostScrap: null, stock: 4 } }), NOW)).toBeNull();
    // Within a second: the save and its prices share the file's time.
    expect(unsavedLookOf(drawer({ bankStock: { bank: 'list', savedAt: NOW - 6 * MIN - 500, change: null, previousCostScrap: null, stock: 4 } }), NOW)).toBeNull();
    // A family row speaks for every copy, not this one's stock; a painted drawer reads the plain copy's row.
    expect(unsavedLookOf(drawer({ scraptfList: { ...listRow(), match: 'family' } }), NOW)).toBeNull();
    expect(unsavedLookOf(drawer({ sku: '5040;6;p15185211' }), NOW)).toBeNull();
    // The stock line reads another bank's save: the list read does not date it.
    expect(unsavedLookOf(drawer({ bankStock: { bank: 'items', savedAt: NOW - 20 * HOUR, change: null, previousCostScrap: null, stock: 2 } }), NOW)).toBeNull();
  });

  it("finds a bank page's look by the item's newest imported price from that bank", () => {
    const hats = drawer({ sku: '126;6', scraptfList: null, bankStock: { bank: 'hats', savedAt: NOW - 3 * HOUR, change: null, previousCostScrap: null, stock: 1 }, seenOn: { bank: 'hats', url: 'https://scrap.tf/buy/hats', at: NOW - 10 * MIN } });
    expect(unsavedLookOf(hats, NOW)).toEqual({ bank: 'hats', at: NOW - 10 * MIN, stock: null, stockLimit: null });
    expect(unsavedLookOf({ ...hats, seenOn: { bank: 'items', url: 'https://scrap.tf/buy/items', at: NOW - 10 * MIN } }, NOW)).toBeNull();
  });

  it('says so under the stock line, with the stock the look showed', () => {
    const t = unsavedLookText(unsavedLookOf(drawer(), NOW)!, NOW);
    expect(t.text).toBe('Your newer look at scrap.tf/items 6 min ago (it showed stock 4/25) stored no save, so the stock line and history are from an older save.');
    expect(t.title).toContain('Read the page again and let it finish loading');
    expect(t.title).toContain('Flip Desk never loads scrap.tf on its own.');
  });

  it('never labels the older save "Now" in the history, nor asks to save again for nothing', () => {
    const h = listHistory();
    const u = unsavedLookOf(drawer(), NOW);
    expect(historyNowText(h, K)!.text).toMatch(/^Now /);
    const now = historyNowText(h, K, u)!;
    expect(now.text).toBe(`In your save of ${fmtSaveTime(NOW - 20 * HOUR)}: 1 key 43.22 ref · that save showed no stock; your look of ${fmtSaveTime(NOW - 6 * MIN)} showed stock 4/25`);
    expect(now.text).not.toMatch(/^Now/);
    expect(now.title).toContain('stored no save');
    const h1 = historyChips(h, K, u).find((c) => c.id === 'h1')!;
    expect(h1.title).toContain('stored no save');
    expect(h1.title).not.toContain('save the page again to compare');
    // A look of another bank, or one older than the newest save, changes nothing.
    expect(historyNowText(h, K, { ...u!, bank: 'items' })!.text).toMatch(/^Now /);
    expect(historyNowText(h, K, { ...u!, at: NOW - 21 * HOUR })!.text).toMatch(/^Now /);
  });
});

describe("the input card's title (F68)", () => {
  it('names an imported price as a price with its import batch, never as a page', () => {
    expect(inputCardLabel({ inputKind: 'import', inputRef: 'price:1554' }, { importBatch: 33 })).toBe('Imported price #1554 · import #33');
    expect(inputCardLabel({ inputKind: 'import', inputRef: 'price:1554' }, null)).toBe('Imported price #1554');
    expect(inputCardLabel({ inputKind: 'import', inputRef: 'price:1554' }, { importBatch: null })).toBe('Imported price #1554');
    expect(inputCardLabel({ inputKind: 'user', inputRef: 'price:12' })).toBe('Typed price #12');
    expect(inputCardLabel({ inputKind: 'rule', inputRef: 'rule:4' }, null, 'Hats 80%')).toBe('Rule: Hats 80%');
    expect(inputCardLabel({ inputKind: 'rule', inputRef: 'rule:4' })).toBe('Rule: #4');
  });
});
