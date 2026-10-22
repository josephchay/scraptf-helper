// F15 end to end over every saved-page fixture: each page goes through importSavedPage with the real
// parser, records its bank on the batch, and the per-bank summary ('scraptf.banks') shows that save
// (lastSavedAt, items, inStock), the engine's flips on its prices, the coverage strip's chip and the
// drawer's seenOn. Offline (R1, R10): the pages are local fixtures, the engine reads a seeded book,
// and nothing here makes a request.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBanksSummary } from '../../src/service/domain/banks';
import { createEngine } from '../../src/service/domain/engine';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { buildItemDetail } from '../../src/service/domain/views';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANKS, scraptfBankInfo } from '../../src/shared/links';
import { scraptfCoverage } from '../../src/shared/market';
import type { ImportResult, ScrapPrice, ScraptfBank, ScraptfBankSummary } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, makeListing, recordingEvents } from '../domain/helpers';
import { createStubSchema } from '../import/schemaStub';

const K = 567;
const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

/** Every bank's fixture, oldest save first: the /items list first, so the bank pages take over the plain rows they share with it. */
const PAGES: [ScraptfBank, string][] = [
  ['list', 'items_list.html'],
  ['hats', 'buy_hats.html'],
  ['weapons', 'buy_weapons.html'],
  ['stranges', 'buy_stranges.html'],
  ['killstreaks', 'buy_killstreaks.html'],
  ['skins', 'buy_skins.html'],
  ['items', 'buy_items.html'],
  ['unusuals', 'unusuals.html'],
];
/** Saved a minute apart, the last one a minute ago. */
const savedAt = (i: number) => T0 - (PAGES.length - i) * MIN;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: T0 - 60 * MIN } });
  const schema = createStubSchema();
  const deps = makeDeps(repo, clock, () => settings);
  const engine = createEngine({ ...deps, schema, events: recordingEvents(), timers });
  const quiet = () => undefined;
  const ctx = {
    clock,
    log: deps.log,
    repo,
    schema,
    engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    // F20: the change feed's import hook (writes no event in these tests).
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: quiet,
  } as unknown as HandlerContext;
  const list = createScraptfListCache({ repo, log: deps.log, keyPrice: () => engine.keyPrice() });
  const banks = createBanksSummary({
    clock,
    log: deps.log,
    repo,
    // The Live market's "Not checked" rows are another test's (banksMarket); none here.
    market: { uncheckedBy: () => new Map() },
    scraptfList: list,
    settings: () => settings,
    folderWatch: () => ({ active: true, error: null }),
    timers,
  });
  return { repo, clock, schema, settings, engine, list, banks, ctx };
}

/** A plain copy this page's import still holds (its batch): not an unusual where the page has others, then the cheapest. */
function heldPlainPrice(repo: Repo, batchId: number): ScrapPrice | undefined {
  const plain = (p: ScrapPrice) => p.special === null || Object.values(p.special).every((v) => v === null || v === false || (Array.isArray(v) && v.length === 0));
  const effect = (p: ScrapPrice) => (/;u\d+/.test(p.sku) ? 1 : 0);
  return repo
    .listScrapPrices()
    .filter((p) => p.source === 'import' && p.importBatch === batchId && plain(p))
    .sort((a, b) => effect(a) - effect(b) || a.costKeys * K + a.costScrap - (b.costKeys * K + b.costScrap) || a.id - b.id)[0];
}

describe('every saved scrap.tf page reaches the banks summary (F15, real parser and engine)', () => {
  it('records each bank and shows its save, flips, coverage chip and seenOn', async () => {
    const h = setup();
    const results = new Map<ScraptfBank, ImportResult>();
    PAGES.forEach(([bank, file], i) => {
      const r = importSavedPage(h.ctx, { html: fixture(file), fileName: file, mtimeMs: savedAt(i) });
      expect(r.bank).toBe(bank);
      expect(r.stored).toBeGreaterThan(0);
      results.set(bank, r);
    });
    // Each batch keeps the page the parser recognised, whatever later pages re-tagged.
    const batches = h.repo.listImportBatches(50);
    for (const [bank] of PAGES) expect(batches.find((b) => b.id === results.get(bank)!.batchId)?.bank).toBe(bank);
    h.list.refresh();

    // One flip per page: three fresh buyers at twice a plain copy's price, so the engine calls it profitable.
    const flipOf = new Map<ScraptfBank, ScrapPrice>();
    let seq = 0;
    for (const [bank] of PAGES) {
      const p = heldPlainPrice(h.repo, results.get(bank)!.batchId);
      // 0.7.4: the list holds no cost here: its unmarked rows are family rows (never a cost), and the items
      // bank's later whole save, which lists the Non-Craftable ticket too, took that one proven row over.
      if (bank === 'list') {
        expect(p, 'the list page').toBeUndefined();
        continue;
      }
      expect(p, `a plain price still held by the ${bank} page`).toBeDefined();
      flipOf.set(bank, p!);
      h.repo.upsertListings(
        Array.from({ length: 3 }, () => {
          seq++;
          return makeListing({ id: `fx${seq}`, sku: p!.sku, baseSku: p!.sku, steamid: `765611980009${String(seq).padStart(5, '0')}`, keys: p!.costKeys * 2, metalScrap: p!.costScrap * 2 + 300, itemName: p!.name });
        }),
      );
    }
    await h.engine.runNow();

    const r = h.banks.summary(T0);
    expect(r.banks.map((b) => b.bank)).toEqual(SCRAPTF_BANKS.map((b) => b.bank));
    expect(r).toMatchObject({ importEnabled: true, watchActive: true });
    const card = (bank: ScraptfBank): ScraptfBankSummary => r.banks.find((b) => b.bank === bank)!;
    const listStored = h.repo.scraptfList();

    PAGES.forEach(([bank], i) => {
      const c = card(bank);
      const res = results.get(bank)!;
      expect(c.lastSavedAt, bank).toBe(savedAt(i));
      if (bank === 'list') {
        // The list card reads the saved list (F14), out-of-stock rows included.
        expect(c.items).toBe(res.listRows);
        expect(c.inStock).toBe(listStored.filter((row) => typeof row.stock === 'number' && row.stock > 0).length);
      } else {
        // Every card a bank page stores is on sale (the import skips none in stock).
        expect([c.pages, c.items, c.inStock], bank).toEqual([1, res.stored, res.stored]);
      }
      // 0.7.4: no flip comes from the list page (no cost of its own, above).
      if (bank === 'list') return;
      const flip = flipOf.get(bank)!;
      expect(c.flips, bank).toBeGreaterThanOrEqual(1);
      expect(c.flipProfitScrap, bank).toBeGreaterThan(0);
      expect(c.top.map((t) => t.sku), bank).toContain(flip.sku);

      // The drawer says where it was seen, and every "Open bank page" goes there.
      const d = buildItemDetail({ repo: h.repo, schema: h.schema, sku: flip.sku, keyPrice: h.engine.keyPrice(), settings: h.settings, now: T0, snapshot: { lastAt: null, available: true, nextAllowedAt: null } });
      expect(d?.seenOn, bank).toEqual({ bank, url: scraptfBankInfo(bank)!.url, at: savedAt(i) });
    });

    // The Live market strip dates each bank page by the bank recorded on its batch.
    const coverage = scraptfCoverage(h.repo.listImportBatches(500), () => []);
    for (const chip of coverage) {
      const i = PAGES.findIndex(([bank]) => scraptfBankInfo(bank)!.url === chip.url);
      expect(i, chip.label).toBeGreaterThan(0);
      expect([chip.lastSavedAt, chip.items], chip.label).toEqual([savedAt(i), results.get(PAGES[i]![0])!.stored]);
    }
  });
});
