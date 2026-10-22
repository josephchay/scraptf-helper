// 0.7.4 (review R01, R06) in the browser mock, as the service: the seeded scrap.tf/items stock save carries
// each row's craftability (the seeded list rows' craft), so the 'All items' Bank stock page and the change
// feed join a family row ('any': every copy at its price) to no buyer, never a flip, while a row proven to
// price its copy keeps its verdict. Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { seedScraptfList } from '../../src/renderer/mockData';
import { bankStockBuyCopy, bankStockPayTitle, bankStockSellsTitle, bankStockVerdictPill, BANK_STOCK_FAMILY_TITLE } from '../../src/renderer/bankStockModel';
import { CHANGE_FAMILY_TITLE, changeRowView } from '../../src/renderer/changesModel';
import { BANK_STOCK_MAX_LIMIT, bankStockListFamily } from '../../src/shared/bankStock';
import { SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import type { BankStockRow, ScraptfWindowRead } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('the mock list stock page joins only proven rows to buyers (R01, R06)', () => {
  it('gives every family row no buy side and no flip, as the service rule', async () => {
    const b = make();
    const res = await b.rpc('scraptf.bankStock', { bank: 'list', limit: BANK_STOCK_MAX_LIMIT });
    const craftOf = new Map(seedScraptfList(T0).map((r) => [r.sku, r.craft ?? 'any']));
    const family = res.rows.filter((r) => r.listFamily === true);
    const proven = res.rows.filter((r) => r.listFamily !== true);
    expect(family.length).toBeGreaterThan(0);
    expect(proven.length).toBeGreaterThan(0);
    for (const r of family) {
      expect(r).toMatchObject({ revenueScrap: null, maxCostScrap: null, profitScrap: null, buyerCount: 0, verdict: 'no-buyers' });
    }
    // Exactly the rows the shared rule calls family: a seeded list row not proven 'craftable' or 'uncraftable'.
    for (const r of res.rows) expect(r.listFamily === true).toBe(bankStockListFamily('list', { craft: craftOf.get(r.sku) ?? null }));
    // A proven row still meets its buyers (some do in the seed).
    expect(proven.some((r) => r.revenueScrap !== null)).toBe(true);
    const flips = await b.rpc('scraptf.bankStock', { bank: 'list', filter: 'flips', limit: BANK_STOCK_MAX_LIMIT });
    expect(flips.rows.every((r) => r.listFamily !== true)).toBe(true);
    expect(res.counts.flips).toBe(flips.rows.length);
  });

  it("counts the window's /items flips as the list page does, so a family row is no flip there either", async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 }, scraptfWindow: { enabled: true, acknowledgedAt: T0 } });
    const reads: ScraptfWindowRead[] = [];
    b.on('scraptfWindow.read', (p) => void (p !== null && reads.push(p)));
    await b.rpc('scraptfWindow.open', { start: SCRAPTF_ITEMS_URL });
    expect(reads).toHaveLength(1);
    const page = await b.rpc('scraptf.bankStock', { bank: 'list', limit: BANK_STOCK_MAX_LIMIT });
    const flips = page.rows.filter((r) => r.verdict === 'flip' && r.change !== 'gone');
    expect(flips.every((r) => r.listFamily !== true)).toBe(true);
    // Every on-sale row is counted, family rows too, but only proven rows can be flips.
    expect(page.rows.filter((r) => r.listFamily === true && r.change !== 'gone').length).toBeGreaterThan(flips.length);
    expect(reads[0]).toMatchObject({ bank: 'list', pageFlips: page.counts.flips, newFlips: page.counts.newFlips });
    expect(reads[0]!.pageFlips).toBe(flips.length);
  });

  it("marks the change feed's family events, never a flip", async () => {
    const b = make();
    const events = await b.rpc('scraptf.changes', { bank: 'list', limit: 500 });
    const family = events.filter((e) => e.listFamily === true);
    expect(family.length).toBeGreaterThan(0);
    for (const e of family) expect(e).toMatchObject({ flip: false, revenueScrap: null, maxCostScrap: null });
    const view = changeRowView(family.find((e) => e.kind !== 'gone') ?? family[0]!, 600, T0);
    expect(view.sellsTitle).toBe(CHANGE_FAMILY_TITLE);
    expect(view.payTitle).toBe(`No Pay up to: ${CHANGE_FAMILY_TITLE}`);
    expect(view.flip).toBeNull();
  });
});

describe('the Bank stock cells of a family row (R06)', () => {
  const row: Pick<BankStockRow, 'sku' | 'key' | 'verdict' | 'profitScrap' | 'margin' | 'costScrap' | 'costKeys' | 'costScrapRaw' | 'maxCostScrap' | 'hasExtras' | 'change' | 'buyerCount' | 'revenueScrap' | 'revenueOrder' | 'listFamily'> = {
    sku: '5040;6',
    key: '5040;6|',
    verdict: 'no-buyers',
    profitScrap: null,
    margin: null,
    costScrap: 989,
    costKeys: 1,
    costScrapRaw: 389,
    maxCostScrap: null,
    hasExtras: false,
    change: 'new',
    buyerCount: 0,
    revenueScrap: null,
    revenueOrder: null,
    listFamily: true,
  };

  it('says it is a row for every copy, not "No buyers"', () => {
    expect(bankStockVerdictPill(row, 600)).toEqual({ tone: 'muted', text: 'Every copy', title: BANK_STOCK_FAMILY_TITLE });
    expect(bankStockSellsTitle(row, 600)).toBe(BANK_STOCK_FAMILY_TITLE);
    expect(bankStockPayTitle(row, 600)).toBe(`No Pay up to: ${BANK_STOCK_FAMILY_TITLE}`);
    expect(BANK_STOCK_FAMILY_TITLE).toMatch(/Craftable or Non-Craftable/);
  });

  it('Record buy prefills no price for it: the price is no price of the Craftable copy (F03)', () => {
    const copy = bankStockBuyCopy(row, 'list');
    expect(copy.keys).toBeUndefined();
    expect(copy.scrap).toBeUndefined();
    expect(copy.note).toMatch(/row for every copy .*check which copy you bought/);
    // A proven row still books its price.
    expect(bankStockBuyCopy({ ...row, listFamily: undefined }, 'list')).toMatchObject({ keys: 1, scrap: 389 });
  });
});
