// F17 in the browser mock: 'scraptf.bankStock' over two saves of most banks (new, gone, cheaper and
// pricier rows), a bank with one save, never-saved banks, whatsNew on the banks cards, "New on
// scrap.tf" on the Live market, ItemDetail.bankStock, the 'bankStock' CSV and an import making a new
// save, all with the shared rules in src/shared/bankStock.ts as the service uses them. Nothing leaves
// the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { BANK_STOCK_CSV_COLUMNS, BANK_STOCK_KEEP_SAVES, bankStockFilterMatches, bankStockWhatsNew } from '../../src/shared/bankStock';
import { MARKET_MAX_LIMIT } from '../../src/shared/market';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { BankStockResult, ScraptfBank } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

const stock = (b: MockBridge, bank: ScraptfBank, over: Record<string, unknown> = {}): Promise<BankStockResult> =>
  b.rpc('scraptf.bankStock', { bank, limit: 2000, ...over });

describe("'scraptf.bankStock'", () => {
  it('shows every change between the two newest saves of a bank', async () => {
    const b = make();
    for (const bank of ['hats', 'unusuals', 'stranges', 'weapons', 'list'] as const) {
      const r = await stock(b, bank);
      const info = SCRAPTF_BANKS.find((x) => x.bank === bank)!;
      // F20: each of these banks has about 20 saves; the diff reads at most BANK_STOCK_KEEP_SAVES of them.
      expect(r, bank).toMatchObject({ bank, label: info.label, url: info.url, saves: BANK_STOCK_KEEP_SAVES, generatedAt: T0 });
      expect(r.savedAt! - r.previousSavedAt!, bank).toBeGreaterThan(0);
      expect(r.counts.new, bank).toBeGreaterThan(0);
      expect(r.counts.gone, bank).toBeGreaterThan(0);
      expect(r.counts.cheaper, bank).toBeGreaterThan(0);
      expect(r.counts.pricier, bank).toBeGreaterThan(0);
      // 'all' is what is in stock now: no gone rows; they come back only under 'gone'.
      expect(r.rows.every((x) => x.change !== 'gone'), bank).toBe(true);
      expect(r.total, bank).toBe(r.counts.inStock);
      const gone = await stock(b, bank, { filter: 'gone' });
      expect(gone.total, bank).toBe(r.counts.gone);
      expect(gone.rows.every((x) => x.change === 'gone'), bank).toBe(true);
      for (const x of r.rows) {
        expect(Number.isInteger(x.costScrap)).toBe(true);
        if (x.change === 'cheaper') expect(x.costScrap).toBeLessThan(x.previousCostScrap!);
        if (x.change === 'pricier') expect(x.costScrap).toBeGreaterThan(x.previousCostScrap!);
      }
    }
    expect(T0 - (await stock(b, 'hats')).savedAt!).toBe(4 * MIN);
    expect((await stock(b, 'hats')).previousSavedAt).toBe(T0 - 4 * MIN - 3 * HOUR);
  });

  it('has new flips, joined to the Live market rows as the service joins its entries', async () => {
    const b = make();
    const all = await Promise.all(SCRAPTF_BANKS.map((x) => stock(b, x.bank)));
    expect(all.reduce((n, r) => n + r.counts.newFlips, 0)).toBeGreaterThan(0);
    const market = new Map((await b.rpc('market.list', { limit: MARKET_MAX_LIMIT })).rows.map((r) => [r.sku, r]));
    const hats = all.find((r) => r.bank === 'hats')!;
    for (const x of hats.rows) {
      const m = market.get(x.sku);
      if (m && m.buyerCount > 0) expect([x.revenueScrap, x.maxCostScrap, x.buyerCount], x.sku).toEqual([m.revenueScrap, m.maxCostScrap, m.buyerCount]);
      else expect(x.verdict, x.sku).toBe('no-buyers');
    }
    // A painted copy is its own row, flagged.
    expect(hats.rows.some((x) => x.hasExtras)).toBe(true);
  });

  it('reads a first save without changes, and a never-saved bank as empty', async () => {
    const b = make();
    const ks = await stock(b, 'killstreaks');
    expect(ks).toMatchObject({ saves: 1, previousSavedAt: null, savedAt: T0 - 26 * HOUR });
    expect(ks.total).toBeGreaterThan(0);
    expect(ks.counts).toMatchObject({ new: 0, gone: 0, cheaper: 0, pricier: 0, newFlips: 0 });
    for (const bank of ['skins', 'items'] as const) {
      expect(await stock(b, bank)).toMatchObject({ bank, saves: 0, savedAt: null, previousSavedAt: null, rows: [], total: 0 });
    }
  });

  it('filters, searches, sorts and pages with the shared rules', async () => {
    const b = make();
    const all = await stock(b, 'hats');
    const flips = await stock(b, 'hats', { filter: 'flips' });
    expect(flips.total).toBe(all.counts.flips);
    expect(flips.rows.every((x) => bankStockFilterMatches(x, 'flips'))).toBe(true);
    const changed = await stock(b, 'hats', { filter: 'changed' });
    expect(changed.total).toBe(all.counts.cheaper + all.counts.pricier);
    const byCost = await stock(b, 'hats', { sort: 'cost' });
    for (let i = 1; i < byCost.rows.length; i++) expect(byCost.rows[i - 1]!.costScrap).toBeLessThanOrEqual(byCost.rows[i]!.costScrap);
    const name = all.rows[0]!.name;
    expect((await stock(b, 'hats', { search: name })).rows.map((x) => x.name)).toContain(name);
    const page = await stock(b, 'hats', { limit: 2, offset: 1 });
    expect(page.rows.map((x) => x.key)).toEqual(all.rows.slice(1, 3).map((x) => x.key));
    expect(page.total).toBe(all.total);
  });

  it('refuses what the service zod refuses', async () => {
    const b = make();
    for (const bad of [undefined, {}, { bank: 'nope' }, { bank: '__proto__' }, { bank: 'hats', filter: 'x' }, { bank: 'hats', limit: 0 }, { bank: 'hats', search: 'x'.repeat(201) }]) {
      await expect(b.rpc('scraptf.bankStock', bad as never), JSON.stringify(bad)).rejects.toThrow(/Invalid parameters for scraptf\.bankStock/);
    }
  });
});

describe('the bank stock elsewhere', () => {
  it("puts whatsNew on the banks cards: counts since the previous save, null for one save or none", async () => {
    const b = make();
    const banks = new Map((await b.rpc('scraptf.banks', undefined)).banks.map((x) => [x.bank, x]));
    for (const bank of ['hats', 'unusuals', 'stranges', 'weapons', 'list'] as const) {
      const r = await stock(b, bank);
      expect(banks.get(bank)!.whatsNew, bank).toEqual(bankStockWhatsNew(r.counts, r.previousSavedAt));
      expect(banks.get(bank)!.whatsNew!.since, bank).toBe(r.previousSavedAt);
    }
    for (const bank of ['killstreaks', 'skins', 'items'] as const) expect(banks.get(bank)!.whatsNew, bank).toBeNull();
  });

  it('marks "New on scrap.tf" market rows and filters on it', async () => {
    const b = make();
    const all = await b.rpc('market.list', { limit: MARKET_MAX_LIMIT });
    const fresh = all.rows.filter((r) => r.scraptfNewAt !== null);
    expect(fresh.length).toBeGreaterThan(0);
    expect(all.rows.some((r) => r.scraptfNewAt === null)).toBe(true);
    const only = await b.rpc('market.list', { limit: MARKET_MAX_LIMIT, newOnScraptf: true });
    expect(only.rows.map((r) => r.sku).sort()).toEqual(fresh.map((r) => r.sku).sort());
    // Every one of them is new in some bank's newest save, dated by that save.
    const saves = new Set((await Promise.all(SCRAPTF_BANKS.map((x) => stock(b, x.bank)))).map((r) => r.savedAt));
    for (const r of fresh) expect(saves.has(r.scraptfNewAt)).toBe(true);
  });

  it('puts the newest save listing an item on its detail', async () => {
    const b = make();
    // The /items list is the newest save of all (3 min), so its rows win the drawer line.
    const list = await stock(b, 'list');
    const fresh = list.rows.find((x) => x.change === 'new' && !x.hasExtras)!;
    const d = await b.rpc('item.detail', { sku: fresh.sku });
    expect(d!.bankStock).toEqual({ bank: 'list', savedAt: list.savedAt, change: 'new', previousCostScrap: fresh.previousCostScrap, stock: fresh.stock });
    // An item on an older bank page and on the list reads the list's save.
    const hats = await stock(b, 'hats');
    const both = hats.rows.find((x) => !x.hasExtras && list.rows.some((y) => y.key === x.key))!;
    expect((await b.rpc('item.detail', { sku: both.sku }))!.bankStock).toMatchObject({ bank: 'list', savedAt: list.savedAt });
    const none = await b.rpc('item.detail', { sku: '5021;6' });
    expect(none?.bankStock ?? null).toBeNull();
  });

  it("exports a bank's rows as CSV with the page's filter, and needs the bank", async () => {
    const b = make();
    const r = await b.rpc('opps.exportCsv', { kind: 'bankStock', bankStock: { bank: 'hats', filter: 'new', limit: 1 } });
    const lines = r.csv.trim().split('\r\n');
    expect(lines[0]).toBe(BANK_STOCK_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(1 + (await stock(b, 'hats')).counts.new);
    expect(r.suggestedName).toMatch(/^flipdesk-bank-stock-hats-/);
    await expect(b.rpc('opps.exportCsv', { kind: 'bankStock' })).rejects.toThrow(/bankStock: required/);
  });

  it('makes an imported hats page the newest save and pushes scraptf.banksChanged', async () => {
    const b = make();
    const before = await stock(b, 'hats');
    const pushes: unknown[] = [];
    b.on('scraptf.banksChanged', (p) => pushes.push(p));
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const at = pushes.length;
    await b.rpc('import.pickFile', undefined);
    expect(pushes.length).toBeGreaterThan(at);
    const after = await stock(b, 'hats');
    expect(after).toMatchObject({ saves: BANK_STOCK_KEEP_SAVES, savedAt: T0 - 30_000, previousSavedAt: before.savedAt });
    expect(after.counts.gone).toBeGreaterThan(0);
    const banks = new Map((await b.rpc('scraptf.banks', undefined)).banks.map((x) => [x.bank, x]));
    expect(banks.get('hats')!.whatsNew!.since).toBe(before.savedAt);
  });
});
