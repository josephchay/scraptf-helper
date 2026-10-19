// 0.7.1 (CQ-2, DM-4's core symptom) in the bank stock cache (src/service/domain/bankStock.ts): with the
// scrap.tf window reading a page every 30 s, "What's new", the stock page's change chips and the Live
// market's New badge compare the newest read with the session baseline (yesterday's save), so the next
// read 30 s later does not empty them; S3's notifications still compare one read with the one before, so
// nothing is told twice. UX-071-2: so the toolbar's "k new" (one read at a time) is not the New chip's count,
// and Show flips lands on the Flips chip, which holds every flip it counted. Real in-memory repo, a fake
// market; pages the user saved only (R10), no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { showFlipsView } from '../../src/renderer/scraptfWindowModel';
import { createBankStock, notifyNewBankFlips, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { BankStockStored, KeyPriceState, ScraptfBank, ScraptfWindowRead, UnixMs } from '../../src/shared/types';
import { FakeClock, HOUR, MIN, T0, recordingLogger } from './helpers';

const DAY = 24 * HOUR;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank, origin: 'window' });
  repo.insertBankStock(id, bank, rows, `/buy/${bank}`);
  return id;
}

function entry(revenueScrap: number): MarketEval {
  return {
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: revenueScrap,
    revenueScrap,
    revenueOrder: null,
    bestOrder: null,
    buyerCount: 3,
    eligibleCount: 3,
    maxCostScrap: maxCostFor(revenueScrap, DEFAULT_SETTINGS.profit),
    confidence: 80,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: T0 - MIN,
    referenced: true,
  };
}

function setup(): { repo: Repo; stock: BankStock; clock: FakeClock } {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const clock = new FakeClock(T0);
  const entries = new Map<string, MarketEval>([['3;6', entry(100)]]);
  const stock = createBankStock({ clock, log: recordingLogger(), repo, market: { entryFor: (b) => entries.get(b) ?? null }, keyPrice: () => KEY, settings: () => DEFAULT_SETTINGS, categoryOf: () => 'hats' });
  return { repo, stock, clock };
}

const YESTERDAY = [s('1;6', 10), s('2;6', 20), s('5;6', 50)];
// One cheaper (1;6), one gone (2;6), one new (3;6, a flip at +80 less friction).
const READ = [s('1;6', 8), s('3;6', 15), s('5;6', 50)];

describe('the session baseline (CQ-2)', () => {
  it("keeps What's new, the chips and the New badge across window reads 30 s apart", () => {
    const h = setup();
    save(h.repo, 'hats', T0 - DAY, YESTERDAY);
    const first = save(h.repo, 'hats', T0 - 60_000, READ);
    h.stock.refresh();
    expect(h.stock.whatsNew('hats')).toMatchObject({ new: 1, gone: 1, cheaper: 1, pricier: 0, since: T0 - DAY });
    expect(h.stock.newFlips('hats', first).map((r) => r.sku)).toEqual(['3;6']);

    // The same page read again 30 s later: the same rows.
    const second = save(h.repo, 'hats', T0 - 30_000, READ);
    h.stock.refresh();
    expect(h.stock.whatsNew('hats')).toEqual({ new: 1, newFlips: 1, gone: 1, cheaper: 1, pricier: 0, since: T0 - DAY });
    expect(h.stock.newAtFor('3;6')).toBe(T0 - 30_000);
    const page = h.stock.list({ bank: 'hats', filter: 'all' }, T0);
    expect(page).toMatchObject({ savedAt: T0 - 30_000, previousSavedAt: T0 - DAY, counts: { new: 1, gone: 1, cheaper: 1 } });
    expect(h.stock.list({ bank: 'hats', filter: 'gone' }, T0).rows.map((r) => r.sku)).toEqual(['2;6']);
    expect(h.stock.detailFor('1;6')).toMatchObject({ change: 'cheaper', previousCostScrap: 10 });
    // One read at a time for S3: the second read added nothing.
    expect(h.stock.newFlips('hats', second)).toEqual([]);
  });

  it('notifies the new flip once, on the read that showed it', () => {
    const h = setup();
    const sent: PushContract['notify'][] = [];
    const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { enabled: true } });
    const notifyDeps = { log: recordingLogger(), repo: h.repo, stock: h.stock, settings: () => settings, keyPrice: () => KEY, notify: (n: PushContract['notify']) => sent.push(n) };
    save(h.repo, 'hats', T0 - DAY, YESTERDAY);
    const first = save(h.repo, 'hats', T0 - 60_000, READ);
    h.stock.refresh();
    expect(notifyNewBankFlips(notifyDeps, { bank: 'hats', batchId: first }, T0)).toBe(1);
    const second = save(h.repo, 'hats', T0 - 30_000, READ);
    h.stock.refresh();
    expect(notifyNewBankFlips(notifyDeps, { bank: 'hats', batchId: second }, T0)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('moves on once a read comes after a 30-minute pause: the last session becomes the baseline', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - DAY, YESTERDAY);
    save(h.repo, 'hats', T0 - 2 * HOUR, READ);
    save(h.repo, 'hats', T0 - 2 * HOUR + 30_000, READ);
    save(h.repo, 'hats', T0, READ);
    h.stock.refresh();
    expect(h.stock.whatsNew('hats')).toEqual({ new: 0, newFlips: 0, gone: 0, cheaper: 0, pricier: 0, since: T0 - 2 * HOUR + 30_000 });
    expect(h.stock.newAtFor('3;6')).toBeNull();
  });

  it('daily file saves compare with the save before, as before', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - 2 * DAY, YESTERDAY);
    save(h.repo, 'hats', T0 - DAY, READ);
    save(h.repo, 'hats', T0, [...READ, s('7;6', 5)]);
    h.stock.refresh();
    expect(h.stock.whatsNew('hats')).toMatchObject({ new: 1, gone: 0, cheaper: 0, since: T0 - DAY });
    expect(h.stock.newAtFor('7;6')).toBe(T0);
  });
});

describe('Show flips after a flip came back within one session (UX-071-2)', () => {
  /** The toolbar's read of a save, with the counts the import reports for it (rpcHandlers: newFlips, pageFlips). */
  const readOf = (h: ReturnType<typeof setup>, batchId: number): ScraptfWindowRead => ({
    at: T0,
    path: '/buy/hats',
    items: 3,
    bank: 'hats',
    newFlips: h.stock.newFlips('hats', batchId).length,
    warning: null,
    pageFlips: h.stock.pageFlips('hats', batchId).length,
  });

  it('lands on rows holding the flip the toolbar counted as new', () => {
    const h = setup();
    // Yesterday the flip (3;6) was listed; a read 10 min ago missed it (sold); one 5 min ago has it again.
    save(h.repo, 'hats', T0 - DAY, [s('1;6', 10), s('3;6', 15), s('5;6', 50)]);
    save(h.repo, 'hats', T0 - 10 * MIN, [s('1;6', 10), s('5;6', 50)]);
    const back = save(h.repo, 'hats', T0 - 5 * MIN, [s('1;6', 10), s('3;6', 15), s('5;6', 50)]);
    h.stock.refresh();
    const read = readOf(h, back);
    // "1 flip (1 new)": new since the read before, which the New chip (since yesterday, the baseline) is not.
    expect(read).toMatchObject({ newFlips: 1, pageFlips: 1 });
    expect(h.stock.list({ bank: 'hats', filter: 'new' }, T0).rows).toEqual([]);
    const show = showFlipsView(read)!;
    expect(show).toMatchObject({ bank: 'hats', filter: 'flips' });
    expect(h.stock.list({ bank: 'hats', filter: show.filter }, T0).rows.map((r) => r.sku)).toEqual(['3;6']);
  });

  it('on a first look of the day, lands on the flips only, not on every new item', () => {
    const h = setup();
    save(h.repo, 'hats', T0 - DAY, [s('1;6', 10), s('5;6', 50)]);
    const today = save(h.repo, 'hats', T0 - MIN, [s('1;6', 10), s('3;6', 15), s('5;6', 50), s('7;6', 5), s('8;6', 5)]);
    h.stock.refresh();
    const show = showFlipsView(readOf(h, today))!;
    expect(h.stock.list({ bank: 'hats', filter: 'new' }, T0).rows.map((r) => r.sku).sort()).toEqual(['3;6', '7;6', '8;6']);
    expect(h.stock.list({ bank: 'hats', filter: show.filter }, T0).rows.map((r) => [r.sku, r.change])).toEqual([['3;6', 'new']]);
  });
});
