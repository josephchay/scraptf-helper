// 0.8 (G1/G3) parity in the browser mock: 'watches.list', 'watches.upsert' and 'watches.delete' answer as the service
// does, by the shared rules (watchWriteOf, watchViewsOf over the kept saves' rows, the repo's one-watch-per-copy rule)
// with the shared refusal texts and the service's zod messages; every write emits 'watches.changed'; the seeded
// watches give the hats page its Watched chip and each row its watch by watchJoinOf; 'app.showBankStock' accepts the
// Watched chip; a read's droppedFlips is the shared bankStockDroppedIntoFlip count. Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockSeedWatches } from '../../src/renderer/mockData';
import { watchUndoInput } from '../../src/renderer/watchesModel';
import { BANK_STOCK_MAX_LIMIT, bankStockDroppedIntoFlip, bankStockSpecialKey } from '../../src/shared/bankStock';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { BankStockRow, ScraptfBank, ScraptfWatch, ScraptfWatchView } from '../../src/shared/types';
import {
  WATCHES_FULL,
  WATCHES_MAX,
  WATCH_COPY_TAKEN,
  WATCH_EMPTY,
  WATCH_GONE,
  WATCH_NAME_MAX,
  WATCH_NOT_A_COPY,
  WATCH_SPECIAL_MAX,
  WATCH_ZERO_PRICE,
  watchIndexOf,
  watchJoinOf,
  watchViewsOf,
  type WatchPageRows,
} from '../../src/shared/watches';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

let bridge: MockBridge | null = null;
function make(): { b: MockBridge; changed: () => number } {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  let n = 0;
  b.on('watches.changed', () => n++);
  return { b, changed: () => n };
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

const refusal = (b: MockBridge, method: 'watches.upsert' | 'watches.delete' | 'watches.list' | 'watches.restore', params: unknown): Promise<string> =>
  (b.rpc as (m: string, p: unknown) => Promise<unknown>)(method, params).then(
    () => 'answered',
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

/** A watch as stored: the view without where it stands. */
const stored = (v: ScraptfWatchView): ScraptfWatch => {
  const { now: _now, ...w } = v;
  return w;
};

/** Each saved bank page's on-sale rows as 'scraptf.bankStock' shows them (the watch join included). */
async function pagesOf(b: MockBridge): Promise<{ bank: ScraptfBank; savedAt: number; rows: BankStockRow[] }[]> {
  const out: { bank: ScraptfBank; savedAt: number; rows: BankStockRow[] }[] = [];
  for (const info of SCRAPTF_BANKS) {
    const r = await b.rpc('scraptf.bankStock', { bank: info.bank, limit: BANK_STOCK_MAX_LIMIT });
    if (r.savedAt !== null) out.push({ bank: info.bank, savedAt: r.savedAt, rows: r.rows });
  }
  return out;
}

describe("the mock's seeded watches", () => {
  it('lists two watches by name: every copy of a hats item at its target with "back on sale", and a paused copy watch', async () => {
    const { b } = make();
    const list = await b.rpc('watches.list', undefined);
    expect(list.map((w) => w.id).sort()).toEqual([1, 2]);
    expect(list.map((w) => w.name)).toEqual([...list.map((w) => w.name)].sort((x, y) => x.localeCompare(y)));
    const any = list.find((w) => w.id === 1)!;
    expect(any).toMatchObject({ specialKey: null, onRestock: true, enabled: true, minProfitScrap: null, createdAt: T0 - 2 * 86_400_000 });
    expect(any.now).toMatchObject({ bank: 'hats', met: 'price' });
    const paused = list.find((w) => w.id === 2)!;
    expect(paused).toMatchObject({ enabled: false, minProfitScrap: 18, maxCostScrap: null });
    expect(paused.sku).not.toBe(any.sku);
    // The seed is mockSeedWatches over the hats page's rows: its every-copy watch prices the second on-sale row + 2 scrap.
    const hats = (await b.rpc('scraptf.bankStock', { bank: 'hats', limit: BANK_STOCK_MAX_LIMIT })).rows;
    const seededRow = hats.find((r) => r.sku === any.sku && r.costScrapRaw + 2 === any.maxCostScrap && r.costKeys === any.maxCostKeys);
    expect(seededRow).toBeDefined();
    expect(mockSeedWatches([], T0)).toEqual([]);
  });

  it("says where each stands by watchViewsOf over the kept saves' newest on-sale rows", async () => {
    const { b } = make();
    const list = await b.rpc('watches.list', undefined);
    const settings = await b.rpc('settings.get', undefined);
    const K = (await b.rpc('status.get', undefined)).keyPrice!.valueScrap;
    const bases = new Set(list.map((w) => w.sku));
    const pages: WatchPageRows[] = (await pagesOf(b))
      .map((p) => ({ ...p, rows: p.rows.filter((r) => bases.has(r.sku)) }))
      .filter((p) => p.rows.length > 0);
    expect(list).toEqual(watchViewsOf(list.map(stored), pages, K, settings.notifications.minConfidence));
  });

  it("gives the hats page its Watched chip and each row its watch, by watchJoinOf over the enabled watches", async () => {
    const { b } = make();
    const list = (await b.rpc('watches.list', undefined)).map(stored);
    const settings = await b.rpc('settings.get', undefined);
    const res = await b.rpc('scraptf.bankStock', { bank: 'hats', limit: BANK_STOCK_MAX_LIMIT });
    const K = res.keyPrice!.valueScrap;
    const index = watchIndexOf(list);
    let watched = 0;
    for (const r of res.rows) {
      const { watch, ...bare } = r;
      expect(watch).toEqual(watchJoinOf(index, bare as BankStockRow, K, settings.notifications.minConfidence));
      if (watch) watched++;
    }
    expect(watched).toBeGreaterThan(0);
    expect(res.counts.watched).toBe(watched);
    const chip = await b.rpc('scraptf.bankStock', { bank: 'hats', filter: 'watched', limit: BANK_STOCK_MAX_LIMIT });
    expect(chip.rows.length).toBe(watched);
    expect(chip.rows.every((r) => r.watch?.id === 1 && r.watch.anyCopy)).toBe(true);
    expect(chip.rows.some((r) => r.watch?.met === 'price')).toBe(true);
    // The paused watch joins nothing.
    expect(res.rows.some((r) => r.watch?.id === 2)).toBe(false);
  });

  it("accepts the Watched chip for 'app.showBankStock'", async () => {
    const { b } = make();
    await expect(b.rpc('app.showBankStock', { bank: 'hats', filter: 'watched' })).resolves.toEqual({ ok: true });
  });
});

describe("'watches.upsert' and 'watches.delete' in the mock", () => {
  it.each<[string, unknown, RegExp]>([
    ['no sku', { maxCostScrap: 100 }, /: sku: /],
    ['an empty sku', { sku: ' ', maxCostScrap: 100 }, /: sku: an item is required/],
    ['text that is no SKU', { sku: '378;6;uncratable', maxCostScrap: 100 }, /: sku: not a SKU/],
    ['a long special', { sku: '378;6', special: 'x'.repeat(WATCH_SPECIAL_MAX + 1), maxCostScrap: 100 }, /: special: /],
    ["the copy index's every-copy stand-in as a special", { sku: '378;6', special: '*', minProfitScrap: 9 }, /: special: Not a copy key/],
    ['a long name', { sku: '378;6', name: 'n'.repeat(WATCH_NAME_MAX + 1), maxCostScrap: 100 }, /: name: /],
    ['negative keys', { sku: '378;6', maxCostKeys: -1, maxCostScrap: 100 }, /: maxCostKeys: /],
    ['too many keys', { sku: '378;6', maxCostKeys: 10_001, maxCostScrap: 100 }, /: maxCostKeys: /],
    ['fractional scrap', { sku: '378;6', maxCostScrap: 1.5 }, /: maxCostScrap: /],
    ['a negative profit', { sku: '378;6', minProfitScrap: -1 }, /: minProfitScrap: /],
    ['an unknown copies value', { sku: '378;6', copies: 'some', maxCostScrap: 100 }, /: copies: /],
    ['a bad id', { id: 0, sku: '378;6', maxCostScrap: 100 }, /: id: /],
    ['a non-boolean switch', { sku: '378;6', onRestock: 'yes' }, /: onRestock: /],
  ])('refuses %s as the service\'s zod does, naming the field', async (_why, params, field) => {
    const { b, changed } = make();
    const msg = await refusal(b, 'watches.upsert', params);
    expect(msg).toMatch(/^Invalid parameters for watches\.upsert: /);
    expect(msg).toMatch(field);
    expect(changed()).toBe(0);
  });

  it('refuses with the shared texts: an empty watch, a zero price, an unknown id, another watch\'s copy, the cap', async () => {
    const { b, changed } = make();
    expect(await refusal(b, 'watches.upsert', { sku: '378;6' })).toBe(WATCH_EMPTY);
    expect(await refusal(b, 'watches.upsert', { sku: '378;6', maxCostScrap: 0 })).toBe(WATCH_ZERO_PRICE);
    expect(await refusal(b, 'watches.upsert', { id: 9999, sku: '378;6', maxCostScrap: 10 })).toBe(WATCH_GONE);
    const any = await b.rpc('watches.upsert', { sku: '378;6', copies: 'any', maxCostScrap: 20 });
    await b.rpc('watches.upsert', { sku: '378;6', maxCostScrap: 30 });
    expect(await refusal(b, 'watches.upsert', { id: any.id, sku: '378;6', copies: 'one', special: '' })).toBe(WATCH_COPY_TAKEN);
    expect(changed()).toBe(2);
    const have = (await b.rpc('watches.list', undefined)).length;
    for (let i = have; i < WATCHES_MAX; i++) await b.rpc('watches.upsert', { sku: `${1000 + i};6`, maxCostScrap: 10 });
    expect(await refusal(b, 'watches.upsert', { sku: '378;6', copies: 'one', special: bankStockSpecialKey({ paint: 16738740 }), maxCostScrap: 10 })).toBe(WATCHES_FULL);
    // The same copy again is that watch, updated in place, even at the cap.
    expect(await b.rpc('watches.upsert', { sku: '378;6', maxCostScrap: 12 })).toMatchObject({ sku: '378;6', specialKey: '', maxCostScrap: 12 });
    expect((await b.rpc('watches.list', undefined)).length).toBe(WATCHES_MAX);
  });

  it("refuses a special of '*' with the service's words, adding no watch beside the any-copy one", async () => {
    const { b, changed } = make();
    const any = await b.rpc('watches.upsert', { sku: '378;6', copies: 'any', maxCostScrap: 90, onRestock: true });
    const before = await b.rpc('watches.list', undefined);
    const want = `Invalid parameters for watches.upsert: special: ${WATCH_NOT_A_COPY}`;
    expect(await refusal(b, 'watches.upsert', { sku: '378;6', special: '*', minProfitScrap: 9 })).toBe(want);
    expect(await refusal(b, 'watches.upsert', { id: any.id, sku: '378;6', copies: 'one', special: '*' })).toBe(want);
    expect(await b.rpc('watches.list', undefined)).toEqual(before);
    expect(changed()).toBe(1);
  });

  it('adds, updates (keeping what it leaves out), pauses and deletes, emitting watches.changed on every write', async () => {
    const { b, changed } = make();
    const w = await b.rpc('watches.upsert', { sku: '378;6;p16738740', maxCostKeys: 1, maxCostScrap: 9, onRestock: true });
    expect(w).toMatchObject({ id: 3, sku: '378;6', specialKey: bankStockSpecialKey({ paint: 16738740 }), maxCostKeys: 1, maxCostScrap: 9, onRestock: true, enabled: true, createdAt: T0, updatedAt: T0 });
    expect(w.name.length).toBeGreaterThan(0);
    const edited = await b.rpc('watches.upsert', { id: w.id, sku: '378;6', minProfitScrap: 30 });
    expect(edited).toMatchObject({ id: w.id, maxCostKeys: 1, maxCostScrap: 9, minProfitScrap: 30, onRestock: true, specialKey: w.specialKey });
    const paused = await b.rpc('watches.upsert', { id: w.id, sku: '378;6', enabled: false });
    expect(paused.enabled).toBe(false);
    expect(changed()).toBe(3);
    // Any SKU of the item lists its base's watches.
    expect((await b.rpc('watches.list', { sku: '378;6;p15185211' })).map((x) => x.id)).toEqual([w.id]);
    expect(await refusal(b, 'watches.list', { sku: 7 })).toMatch(/^Invalid parameters for watches\.list: sku: /);
    expect(await b.rpc('watches.delete', { id: w.id })).toEqual({ ok: true });
    expect(changed()).toBe(4);
    expect((await b.rpc('watches.list', { sku: '378;6' })).length).toBe(0);
    expect(await refusal(b, 'watches.delete', { id: -1 })).toMatch(/^Invalid parameters for watches\.delete: id: /);
  });

  it("restores a removed watch as the service does: the same id and times, a second Undo answered, a copy taken refused", async () => {
    const { b, changed } = make();
    const seeded = stored((await b.rpc('watches.list', undefined)).find((x) => x.specialKey === null)!);
    await b.rpc('watches.delete', { id: seeded.id });
    const back = await b.rpc('watches.restore', watchUndoInput(seeded));
    expect(back).toEqual(seeded);
    expect((await b.rpc('watches.list', undefined)).map(stored)).toContainEqual(seeded);
    expect(await b.rpc('watches.restore', watchUndoInput(seeded))).toEqual(seeded);
    expect(changed()).toBe(2);
    // The copy watched again since: refused with the shared text; a time in the future reads now.
    await b.rpc('watches.delete', { id: seeded.id });
    const again = await b.rpc('watches.upsert', { sku: seeded.sku, copies: 'any', maxCostScrap: 10 });
    expect(await refusal(b, 'watches.restore', watchUndoInput(seeded))).toBe(WATCH_COPY_TAKEN);
    await b.rpc('watches.delete', { id: again.id });
    expect(await b.rpc('watches.restore', { ...watchUndoInput(seeded), updatedAt: T0 + 60_000 })).toMatchObject({ id: seeded.id, updatedAt: T0 });
    expect(await refusal(b, 'watches.restore', { ...watchUndoInput(seeded), id: 0 })).toMatch(/^Invalid parameters for watches\.restore: id: /);
    expect(await refusal(b, 'watches.restore', { ...watchUndoInput(seeded), id: 77, createdAt: -1 })).toMatch(/^Invalid parameters for watches\.restore: createdAt: /);
  });
});

describe('the scrap.tf window read in the mock (G2)', () => {
  it("counts the flips a read dropped under Pay up to by bankStockDroppedIntoFlip, as the service's droppedFlips", async () => {
    const { b } = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 }, scraptfWindow: { enabled: true, acknowledgedAt: T0 } });
    const hats = SCRAPTF_BANKS.find((x) => x.bank === 'hats')!;
    await b.rpc('scraptfWindow.open', { start: hats.url });
    const out = await b.rpc('scraptfWindow.read', undefined);
    const read = 'read' in out ? out.read : null;
    const rows = (await b.rpc('scraptf.bankStock', { bank: 'hats', limit: BANK_STOCK_MAX_LIMIT })).rows;
    expect(read?.droppedFlips).toBe(rows.filter(bankStockDroppedIntoFlip).length);
  });
});
