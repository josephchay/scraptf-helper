// F15 in the browser mock: 'scraptf.banks' with fresh, stale and never-saved banks, flips and things
// to look for (counted with the shared rules in src/shared/banks.ts, as the service will), the
// 'scraptf.banksChanged' push, ScrapPrice.bank on every price read and ItemDetail.seenOn, so the
// banks page can be built in `npm run dev:renderer`. Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { BANK_LOOK_FOR, BANK_TOP_FLIPS, bankFlips, bankLookFor } from '../../src/shared/banks';
import { SCRAPTF_BANKS, scraptfSeenOn } from '../../src/shared/links';
import { MARKET_MAX_LIMIT } from '../../src/shared/market';
import { PUSH_EVENTS, SERVICE_METHODS, type PushContract } from '../../src/shared/rpc';
import type { ScraptfBank, ScraptfBankSummary } from '../../src/shared/types';

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

const byBank = (banks: ScraptfBankSummary[]) => new Map(banks.map((b) => [b.bank, b]));

describe('contract', () => {
  it('scraptf.banks is a service method and scraptf.banksChanged a push event', () => {
    expect(SERVICE_METHODS).toContain('scraptf.banks');
    expect(PUSH_EVENTS).toContain('scraptf.banksChanged');
  });
});

describe("'scraptf.banks'", () => {
  it('lists every bank in order: fresh, stale and never-saved pages, and the /items list', async () => {
    const b = make();
    const r = await b.rpc('scraptf.banks', undefined);
    expect(r.generatedAt).toBe(T0);
    expect(r).toMatchObject({ importEnabled: false, watchActive: false });
    expect(r.banks.map((x) => [x.bank, x.label, x.url])).toEqual(SCRAPTF_BANKS.map((x) => [x.bank, x.label, x.url]));
    const m = byBank(r.banks);
    // Minutes, hours and never, as a user who saves some pages more often than others.
    expect(T0 - m.get('hats')!.lastSavedAt!).toBe(4 * MIN);
    expect(T0 - m.get('unusuals')!.lastSavedAt!).toBe(12 * MIN);
    expect(T0 - m.get('killstreaks')!.lastSavedAt!).toBe(26 * HOUR);
    for (const never of ['skins', 'items'] as const) expect(m.get(never)).toMatchObject({ lastSavedAt: null, pages: 0, items: 0, inStock: 0 });
    expect(m.get('hats')).toMatchObject({ pages: 1, items: 48, inStock: 31 });
    // The list card is the F14 saved list.
    const list = await b.rpc('scraptf.listStatus', undefined);
    expect(m.get('list')).toMatchObject({ lastSavedAt: list.newestAt, pages: list.pages, items: list.items, unchecked: 0, lookFor: [] });
    expect(m.get('list')!.inStock).toBeLessThan(list.items);
    for (const x of r.banks) {
      expect(Number.isInteger(x.flipProfitScrap)).toBe(true);
      expect(x.top.length).toBeLessThanOrEqual(BANK_TOP_FLIPS);
      expect(x.lookFor.length).toBeLessThanOrEqual(BANK_LOOK_FOR);
    }
  });

  it('has flips and things to look for, counted with the shared rules', async () => {
    const b = make();
    const r = await b.rpc('scraptf.banks', undefined);
    const opps = await b.rpc('opps.list', { limit: 5000 });
    const prices = new Map((await b.rpc('prices.list', {})).map((p) => [p.id, p]));
    const flips = bankFlips(opps.rows, (o) => (o.inputRef.startsWith('price:') ? (prices.get(Number(o.inputRef.slice(6)))?.bank ?? null) : null));
    const market = await b.rpc('market.list', { limit: MARKET_MAX_LIMIT });
    expect(market.total).toBeLessThanOrEqual(MARKET_MAX_LIMIT);
    for (const x of r.banks) {
      const f = flips.get(x.bank) ?? { flips: 0, flipProfitScrap: 0, top: [] };
      expect({ flips: x.flips, flipProfitScrap: x.flipProfitScrap, top: x.top }, x.bank).toEqual(f);
      const info = SCRAPTF_BANKS.find((i) => i.bank === x.bank)!;
      expect({ unchecked: x.unchecked, lookFor: x.lookFor }, x.bank).toEqual(bankLookFor(market.rows, info.categories));
    }
    expect(r.banks.filter((x) => x.flips > 0).length).toBeGreaterThanOrEqual(2);
    expect(r.banks.some((x) => x.lookFor.length > 0)).toBe(true);
    // A never-saved bank still shows what to look for there.
    expect(byBank(r.banks).get('items')!.lookFor.length + byBank(r.banks).get('skins')!.lookFor.length).toBeGreaterThan(0);
    for (const x of r.banks) {
      for (let i = 1; i < x.top.length; i++) expect(x.top[i - 1]!.profitScrap).toBeGreaterThanOrEqual(x.top[i]!.profitScrap);
      for (let i = 1; i < x.lookFor.length; i++) expect(x.lookFor[i - 1]!.maxCostScrap).toBeGreaterThanOrEqual(x.lookFor[i]!.maxCostScrap);
    }
  });

  it('reports the import switches like the price list card', async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'C:\\pages' } });
    expect(await b.rpc('scraptf.banks', undefined)).toMatchObject({ importEnabled: true, watchActive: true });
  });

  it('moves a bank to "just saved" when a page of it is imported', async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const r = await b.rpc('import.pickFile', undefined);
    expect(r?.bank).toBe('hats');
    const hats = byBank((await b.rpc('scraptf.banks', undefined)).banks).get('hats')!;
    expect(hats).toMatchObject({ lastSavedAt: T0 - 30_000, pages: 2, items: 3 });
    expect((await b.rpc('import.batches', { limit: 1 }))[0]!.bank).toBe('hats');
  });
});

describe("'scraptf.banksChanged'", () => {
  it('is pushed after imports, price writes and import setting changes', async () => {
    const b = make();
    const pushes: PushContract['scraptf.banksChanged'][] = [];
    b.on('scraptf.banksChanged', (p) => pushes.push(p));
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    expect(pushes).toEqual([{ at: T0 }]);
    await b.rpc('settings.set', { ui: { density: 'compact' } });
    expect(pushes).toHaveLength(1);
    await b.rpc('prices.upsert', { sku: '378;6', costScrap: 30 });
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    const before = pushes.length;
    await b.rpc('import.html', { html: '<html></html>', fileName: 'scrap.tf - Items.html', mtimeMs: T0 - 30_000 });
    expect(pushes.length).toBeGreaterThan(before);
  });
});

describe('ScrapPrice.bank and ItemDetail.seenOn', () => {
  it('joins the batch bank into every price read: imported prices name their page, typed ones none', async () => {
    const b = make();
    const prices = await b.rpc('prices.list', {});
    const imported = prices.filter((p) => p.source === 'import');
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.every((p) => p.bank !== null && p.bank !== undefined)).toBe(true);
    expect(prices.filter((p) => p.source === 'user').every((p) => p.bank === null)).toBe(true);
    // Seeded imports come from the page that sells them, else the /items list.
    const seen = new Set(imported.map((p) => p.bank));
    expect(seen.has('list')).toBe(true);
    expect([...seen].some((x) => x !== 'list')).toBe(true);
    const saved = await b.rpc('prices.upsert', { sku: '378;6', costScrap: 30 });
    expect(saved.bank).toBeNull();
  });

  it('is the bank of the newest imported price of the item', async () => {
    const b = make();
    const prices = await b.rpc('prices.list', {});
    const sku = prices.find((p) => p.source === 'import')!.sku;
    const d = (await b.rpc('item.detail', { sku }))!;
    expect(d.seenOn).not.toBeNull();
    expect(d.seenOn).toEqual(scraptfSeenOn(d.scrapPrices));
    expect(d.seenOn!.url).toBe(SCRAPTF_BANKS.find((x) => x.bank === d.seenOn!.bank)!.url);

    const typedOnly = prices.find((p) => p.source === 'user' && !prices.some((q) => q.sku === p.sku && q.source === 'import'))!;
    expect((await b.rpc('item.detail', { sku: typedOnly.sku }))!.seenOn).toBeNull();
  });

  it("dates a seeded imported price at its page's save, so 'Seen on' and the bank card agree", async () => {
    const b = make();
    const banks = byBank((await b.rpc('scraptf.banks', undefined)).banks);
    const imported = (await b.rpc('prices.list', {})).filter((p) => p.source === 'import' && p.bank && p.bank !== 'list');
    expect(imported.length).toBeGreaterThan(0);
    for (const p of imported) expect(p.observedAt).toBe(banks.get(p.bank!)!.lastSavedAt);
    const d = (await b.rpc('item.detail', { sku: imported[0]!.sku }))!;
    expect(d.seenOn!.at).toBe(banks.get(d.seenOn!.bank)!.lastSavedAt);
  });

  it('joins no bank into an imported price edited by hand (it is typed now), as the repo reads it', async () => {
    const b = make();
    const p = (await b.rpc('prices.list', {})).find((x) => x.source === 'import' && x.bank)!;
    const edited = await b.rpc('prices.upsert', { id: p.id, sku: p.sku, costScrap: p.costScrap + 1, source: 'user' });
    expect(edited).toMatchObject({ id: p.id, source: 'user', importBatch: p.importBatch, bank: null });
    expect((await b.rpc('prices.list', {})).find((x) => x.id === p.id)!.bank).toBeNull();
  });

  it('follows a new import of the item', async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    await b.rpc('import.pickFile', undefined);
    const picked = (await b.rpc('prices.list', {})).filter((p) => p.observedAt === T0 && p.source === 'import');
    expect(picked.length).toBeGreaterThan(0);
    const d = (await b.rpc('item.detail', { sku: picked[0]!.sku }))!;
    expect(d.seenOn).toEqual({ bank: 'hats' satisfies ScraptfBank, url: 'https://scrap.tf/buy/hats', at: T0 });
  });
});

// F18 S3 in the browser preview: a hats page saved without its cards ("... (empty).html").
describe("'import.html' of a bank page saved without its cards", () => {
  it("warns 'no-cards-saved', records the bank and time, and leaves the strip, the card and bank stock on the save before", async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const hats = async () => byBank((await b.rpc('scraptf.banks', undefined)).banks).get('hats')!;
    const chip = async () => (await b.rpc('market.list', {})).scraptf.coverage.find((c) => c.label === 'Hats')!;
    const card = await hats();
    const strip = await chip();
    const stock = await b.rpc('scraptf.bankStock', { bank: 'hats' });
    const prices = await b.rpc('prices.list', {});
    expect(card.lastSavedAt).not.toBeNull();
    const done: unknown[] = [];
    b.on('import.done', (r) => done.push(r));

    const r = await b.rpc('import.html', { html: '<html></html>', fileName: 'Hat Trading - TF2 - Scrap.TF (empty).html', mtimeMs: T0 - MIN });
    expect(r).toMatchObject({ pageKind: 'buy', bank: 'hats', parsed: 0, stored: 0 });
    expect(r.warnings).toEqual([
      "no-cards-saved: This page was saved without its items. 'HTML only' keeps the page as it first loaded, before scrap.tf added the cards. Save it again as 'Webpage, Complete'.",
    ]);
    expect(done).toEqual([r]);
    expect((await b.rpc('import.batches', { limit: 1 }))[0]).toMatchObject({ id: r.batchId, bank: 'hats', fileMtime: T0 - MIN, itemCount: 0 });
    expect(await hats()).toMatchObject({ lastSavedAt: card.lastSavedAt, items: card.items });
    expect(await chip()).toEqual(strip);
    expect(await b.rpc('scraptf.bankStock', { bank: 'hats' })).toMatchObject({ savedAt: stock.savedAt, saves: stock.saves });
    expect(await b.rpc('prices.list', {})).toEqual(prices);
  });
});
