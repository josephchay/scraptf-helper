// 0.7.4 (audit F80, F39): two journal and price-sheet writes that kept a stale value.
//  - F80: Quick entry and the check popup's Save price added a typed price on every save, so the price typed
//    30 h ago stayed an input of its own beside today's (a false +12.88 ref flip). With replaceTyped (what both
//    send), 'prices.upsert' updates the newest typed price of the same copy (shared priceIsForSku), keeping
//    its extras, asset id and stock; painted, spelled and plain copies stay apart, imports are never touched,
//    and the Prices page's Add (no flag) still adds a row.
//  - F39: a backfilled journal trade was stamped with today's key price, so a mixed-currency pair booked the
//    key's move since as profit. journal.add takes the key price then.
// The real rpc handlers over a real repo, with the real item schema (schema-subset.json); nothing is fetched.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { newestTypedPriceFor, priceIsForSku } from '../../src/shared/priceCopy';
import type { JournalEntry, JournalSummary, ScrapPrice, SpecialAttrs } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PINK = 15185211;
const TOP_BRASS = '31511;6';
const SPELLED: SpecialAttrs = { paint: null, spells: ['Exorcism'], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup(keyScrap = 577) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const dirty: string[][] = [];
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    http: { isPaused: () => false },
    engine: { keyPrice: () => ({ valueScrap: keyScrap }), markDirty: (skus: Iterable<string>) => dirty.push([...skus]) } as unknown as Engine,
    settings: () => settings,
    secret: () => null,
    push: quiet,
    pricesChanged: quiet,
    journalChanged: quiet,
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  const call = async <T>(method: string, params: unknown) => (await rpc(method, params)) as T;
  const typed = (sku: string) => repo.scrapPricesForSku(sku).filter((p) => p.source === 'user');
  return { repo, call, typed, dirty };
}

/** What Quick entry sends (quickSaveInput) and the check popup's Save price: replaceTyped. */
const quick = (sku: string, costScrap: number, observedAt: number, extra: Record<string, unknown> = {}) => ({
  sku,
  name: 'The Top Brass',
  costKeys: 0,
  costScrap,
  source: 'user',
  observedAt,
  note: null,
  replaceTyped: true,
  ...extra,
});

describe("prices.upsert with replaceTyped (F80: Quick entry and the check popup's Save price)", () => {
  it('updates the newest typed price of the copy: one row, the new price and time, the same id', async () => {
    const h = setup();
    const first = await h.call<ScrapPrice>('prices.upsert', quick(TOP_BRASS, 81, NOW - 30 * HOUR, { note: 'live check' }));
    const second = await h.call<ScrapPrice>('prices.upsert', quick(TOP_BRASS, 120, NOW));
    expect(second.id).toBe(first.id);
    expect(h.typed(TOP_BRASS).map((p) => [p.id, p.costScrap, p.observedAt, p.note])).toEqual([[first.id, 120, NOW, null]]);
    expect(h.dirty.at(-1)).toEqual([TOP_BRASS]);
  });

  it("takes the price's own time, even an older one (a list price keeps its list date)", async () => {
    const h = setup();
    await h.call('prices.upsert', quick(TOP_BRASS, 120, NOW));
    await h.call('prices.upsert', quick(TOP_BRASS, 100, NOW - 20 * HOUR, { note: 'from your scrap.tf/items list' }));
    expect(h.typed(TOP_BRASS).map((p) => [p.costScrap, p.observedAt, p.note])).toEqual([[100, NOW - 20 * HOUR, 'from your scrap.tf/items list']]);
  });

  it('keeps painted, spelled and plain copies apart, and the stored extras of the row it updates', async () => {
    const h = setup();
    const plain = await h.call<ScrapPrice>('prices.upsert', quick(TOP_BRASS, 81, NOW - HOUR));
    const pink = await h.call<ScrapPrice>('prices.upsert', quick(`${TOP_BRASS};p${PINK}`, 140, NOW - HOUR));
    expect(pink.id).not.toBe(plain.id);
    const spelled = h.repo.upsertScrapPrice({ sku: TOP_BRASS, name: 'The Top Brass', costKeys: 0, costScrap: 300, source: 'user', observedAt: NOW - HOUR, note: null, special: SPELLED, assetId: '42', stock: 1 });
    // A plain save updates the plain row only; a pink one the pink row, its paint and the rest kept.
    await h.call('prices.upsert', quick(TOP_BRASS, 90, NOW));
    await h.call('prices.upsert', quick(`${TOP_BRASS};p${PINK}`, 150, NOW));
    const rows = h.typed(TOP_BRASS);
    expect(rows).toHaveLength(3);
    expect(rows.find((p) => p.id === plain.id)).toMatchObject({ costScrap: 90, observedAt: NOW });
    expect(rows.find((p) => p.id === pink.id)).toMatchObject({ costScrap: 150, special: expect.objectContaining({ paint: PINK }) });
    expect(rows.find((p) => p.id === spelled.id)).toMatchObject({ costScrap: 300, special: SPELLED, assetId: '42', stock: 1 });
  });

  it('never touches an imported price, and adds a row when there is no typed one', async () => {
    const h = setup();
    const batch = h.repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: NOW - HOUR, importedAt: NOW - HOUR, itemCount: 1, bank: 'hats' });
    const imported = h.repo.upsertScrapPrice({ sku: TOP_BRASS, name: 'The Top Brass', costKeys: 0, costScrap: 120, source: 'import', observedAt: NOW - HOUR, note: null, importBatch: batch });
    const saved = await h.call<ScrapPrice>('prices.upsert', quick(TOP_BRASS, 110, NOW));
    expect(saved.id).not.toBe(imported.id);
    expect(h.repo.getScrapPrice(imported.id)).toMatchObject({ source: 'import', costScrap: 120 });
  });

  it("leaves the Prices page's Add (no flag) and an edit by id as they were", async () => {
    const h = setup();
    const a = await h.call<ScrapPrice>('prices.upsert', { sku: TOP_BRASS, costScrap: 81, source: 'user' });
    const b = await h.call<ScrapPrice>('prices.upsert', { sku: TOP_BRASS, costScrap: 90, source: 'user' });
    expect(b.id).not.toBe(a.id);
    // An id wins over the flag.
    await h.call('prices.upsert', { id: a.id, sku: TOP_BRASS, costScrap: 70, source: 'user', replaceTyped: true });
    expect(h.typed(TOP_BRASS).map((p) => [p.id, p.costScrap]).sort()).toEqual([[a.id, 70], [b.id, 90]].sort());
  });

  it('a whole price: no keys means 0 keys, never the old row\'s', async () => {
    const h = setup();
    await h.call('prices.upsert', quick(TOP_BRASS, 30, NOW - HOUR, { costKeys: 1 }));
    await h.call('prices.upsert', { sku: TOP_BRASS, costScrap: 120, source: 'user', replaceTyped: true });
    expect(h.typed(TOP_BRASS).map((p) => [p.costKeys, p.costScrap])).toEqual([[0, 120]]);
  });

  it('shares its copy rule with the renderer (priceIsForSku, newestTypedPriceFor)', () => {
    const row = (id: number, over: Partial<ScrapPrice>): ScrapPrice =>
      ({ id, sku: TOP_BRASS, name: '', costKeys: 0, costScrap: 1, source: 'user', observedAt: NOW, note: null, importBatch: null, special: null, assetId: null, stock: null, bank: null, ...over }) as ScrapPrice;
    const rows = [row(1, { observedAt: NOW - HOUR }), row(2, {}), row(3, { special: SPELLED }), row(4, { source: 'import', observedAt: NOW + HOUR }), row(5, {})];
    expect(newestTypedPriceFor(rows, TOP_BRASS)?.id).toBe(5);
    expect(newestTypedPriceFor(rows, `${TOP_BRASS};p${PINK}`)).toBeNull();
    expect(priceIsForSku(row(6, { sku: `${TOP_BRASS};p${PINK}` }), `${TOP_BRASS};p${PINK}`)).toBe(true);
  });
});

describe('journal.add with the key price then (F39)', () => {
  // Bought 1 key, sold for 70 ref two weeks ago, when a key was 540 scrap; today's is 577.
  it('stores a backfill\'s key price, so the pair is valued at it', async () => {
    const h = setup(577);
    await h.call('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '5021;6', keys: 1, scrap: 0, ts: NOW - 15 * DAY, keyPriceScrap: 540 });
    const sale = await h.call<JournalEntry>('journal.add', { side: 'sell', venue: 'backpack.tf', sku: '5021;6', keys: 0, scrap: 630, ts: NOW - 14 * DAY, keyPriceScrap: 540 });
    expect(sale.keyPriceScrap).toBe(540);
    expect((await h.call<JournalSummary>('journal.summary', undefined)).realizedProfitScrap).toBe(90);
  });

  it("stores today's without one (as before)", async () => {
    const h = setup(577);
    await h.call('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '5021;6', keys: 1, scrap: 0, ts: NOW - 15 * DAY });
    const sale = await h.call<JournalEntry>('journal.add', { side: 'sell', venue: 'backpack.tf', sku: '5021;6', keys: 0, scrap: 630, ts: NOW - 14 * DAY });
    expect(sale.keyPriceScrap).toBe(577);
    expect((await h.call<JournalSummary>('journal.summary', undefined)).realizedProfitScrap).toBe(53);
  });

  it('refuses a key price that is no key price', async () => {
    const h = setup();
    for (const keyPriceScrap of [0, -5, 1.5, 8, 100_001]) {
      await expect(h.call('journal.add', { side: 'sell', venue: 'x', sku: '5021;6', scrap: 1, ts: NOW - DAY, keyPriceScrap })).rejects.toThrow(/keyPriceScrap/);
    }
    expect(h.repo.listJournal()).toEqual([]);
  });

  it('lists a sale with no earlier buy as waiting, and keeps the later buy held (F38)', async () => {
    const h = setup();
    const sale = await h.call<JournalEntry>('journal.add', { side: 'sell', venue: 'backpack.tf', sku: '5040;6', keys: 2, scrap: 198, ts: NOW - 7 * DAY });
    const buy = await h.call<JournalEntry>('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '5040;6', keys: 1, scrap: 389 });
    const s = await h.call<JournalSummary>('journal.summary', undefined);
    expect(s.open.map((p) => [p.sku, p.qty, p.lots[0]!.id])).toEqual([['5040;6', 1, buy.id]]);
    expect(s.waitingSales.map((w) => [w.id, w.sku, w.keys, w.scrap])).toEqual([[sale.id, '5040;6', 2, 198]]);
    expect(s.realizedTrades).toBe(0);
  });
});
