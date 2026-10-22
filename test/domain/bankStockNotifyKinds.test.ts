// 0.8 (G2, LC-7, G5): the S3 notifier's new kinds over the real bank stock cache, the real scrap.tf history's runs
// index and an in-memory repo. "Cheaper on scrap.tf" for a flip a read dropped under Pay up to (once, and never for a
// row that was a flip already); "Back on scrap.tf" for a flip on sale again (listed sold out on the save before, or seen
// on an earlier save: scraptfIsRestock, the change feed's own rule) and "New on scrap.tf" for one never seen; one dedupe
// with the engine (toldRecently); the summaries' openBankStock (G5); BankStock.droppedFlips' look rules. Pages the user
// saved only (R10); nothing touches scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { BANK_STOCK_NOTIFY_META_KEY, createBankStock, createNewFlipNotifier, notifyNewBankFlips, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { BANK_STOCK_MORE_BODY, bankStockKey, bankStockOldSaveNotice } from '../../src/shared/bankStock';
import { bankStockBackNotice, bankStockDroppedFlipNotice } from '../../src/shared/bankStockNotify';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { BankStockStored, DeepPartial, KeyPriceState, ScraptfBank, Settings, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Hat ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[], page = bank === 'list' ? '/items' : `/buy/${bank}`): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows, page);
  return id;
}

function entry(revenueScrap: number, settings: Settings): MarketEval {
  const o = {
    listingId: `l-${revenueScrap}`,
    steamid: '76561198000000002',
    userName: 'KeyBot',
    keys: 0,
    metalScrap: revenueScrap,
    valueScrap: revenueScrap,
    isBot: true,
    online: true,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
  return {
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: revenueScrap,
    revenueScrap,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 3,
    eligibleCount: 3,
    maxCostScrap: maxCostFor(revenueScrap, settings.profit),
    confidence: 80,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
  };
}

interface Harness {
  repo: Repo;
  stock: BankStock;
  history: ScraptfHistory;
  settings: Settings;
  sent: PushContract['notify'][];
  /** Revenue 200 for every base: Pay up to M. */
  M: number;
  /** One import's notifications, as core runs them: the stock and the history refreshed first. */
  run(bank: ScraptfBank, batchId: number, now?: UnixMs): number;
}

function setup(patch: DeepPartial<Settings> = {}): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, patch);
  const log = recordingLogger();
  const market = { entryFor: (base: string) => (base === '100;6' ? null : entry(200, settings)) };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market, keyPrice: () => KEY });
  const stock = createBankStock({
    clock: { now: () => NOW },
    log,
    repo,
    market,
    keyPrice: () => KEY,
    settings: () => settings,
    categoryOf: () => 'hats',
    history: { runsFor: (bank) => history.runsFor(bank) },
  });
  const sent: PushContract['notify'][] = [];
  const h: Harness = {
    repo,
    stock,
    history,
    settings,
    sent,
    M: maxCostFor(200, settings.profit)!,
    run(bank, batchId, now = NOW) {
      stock.refresh();
      history.refresh();
      return notifyNewBankFlips({ log, repo, stock, settings: () => settings, keyPrice: () => KEY, notify: (n) => sent.push(n) }, { bank, batchId }, now);
    },
  };
  return h;
}

describe('G2: "Cheaper on scrap.tf" (a read dropped a flip under Pay up to)', () => {
  it('toasts a cheaper row crossing Pay up to once, with prev → cost; an already-flip cheaper row does not', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 2 * HOUR, [s('100;6', 50), s('101;6', h.M + 10, { name: 'Ghastly Gibus' }), s('102;6', h.M - 10)]);
    const newest = save(h.repo, 'hats', NOW - 5 * MIN, [s('100;6', 50), s('101;6', h.M - 30, { name: 'Ghastly Gibus' }), s('102;6', h.M - 30)]);
    expect(h.run('hats', newest)).toBe(1);
    const dropped = h.stock.droppedFlips('hats', newest);
    expect(dropped.map((r) => [r.sku, r.change, r.verdict])).toEqual([['101;6', 'cheaper', 'flip']]);
    expect(h.sent).toEqual([{ ...bankStockDroppedFlipNotice('Hats', dropped[0]!, KEY.valueScrap, 5 * MIN), sku: '101;6' }]);
    expect(h.sent[0]!.title).toBe('Cheaper on scrap.tf (Hats): Ghastly Gibus');
    expect(h.sent[0]!.body).toMatch(/^[\d.]+ ref → [\d.]+ ref, now under Pay up to [\d.]+ ref; sells for [\d.]+ ref to KeyBot, \+[\d.]+ ref$/);
    // The same look told again (a re-run, the same file again): nothing.
    expect(h.run('hats', newest, NOW + 5 * MIN)).toBe(0);
    expect(h.sent).toHaveLength(1);
  });

  it('new, then cheaper under Pay up to within 30 min: one toast, and the engine hears of it (toldRecently)', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 2 * HOUR, [s('100;6', 50)]);
    const n = createNewFlipNotifier({
      log: recordingLogger(),
      repo: h.repo,
      clock: { now: () => NOW },
      stock: h.stock,
      settings: () => h.settings,
      keyPrice: () => KEY,
      notify: (x) => h.sent.push(x),
      marketBuilt: () => true,
    });
    const tell = (batchId: number): void => {
      h.stock.refresh();
      h.history.refresh();
      n.imported({ bank: 'hats', batchId });
    };
    // A flip new on a read, then repriced over Pay up to, then back under it on the next read.
    tell(save(h.repo, 'hats', NOW - 25 * MIN, [s('100;6', 50), s('101;6', h.M - 10)]));
    tell(save(h.repo, 'hats', NOW - 15 * MIN, [s('100;6', 50), s('101;6', h.M + 10)]));
    const third = save(h.repo, 'hats', NOW - 5 * MIN, [s('100;6', 50), s('101;6', h.M - 30)]);
    tell(third);
    expect(h.stock.droppedFlips('hats', third).map((r) => r.sku)).toEqual(['101;6']);
    expect(h.sent.map((x) => x.title)).toEqual(['New on scrap.tf (Hats): Hat 101;6']);
    expect(n.toldRecently('101;6', NOW)).toBe(true);
  });
});

describe('LC-7: "Back on scrap.tf" (one restock rule with the change feed)', () => {
  it('a flip listed sold out on the save before is back on sale', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 2 * HOUR, [s('100;6', 50), s('103;6', h.M - 30, { stock: 0 })]);
    const newest = save(h.repo, 'hats', NOW - 5 * MIN, [s('100;6', 50), s('103;6', h.M - 30)]);
    expect(h.run('hats', newest)).toBe(1);
    const look = h.stock.lookOf('hats', newest)!;
    const row = look.rows.find((x) => x.row.sku === '103;6')!;
    expect(row.restock).toBe(true);
    expect(h.sent).toEqual([{ ...bankStockBackNotice('Hats', row.row, KEY.valueScrap, 5 * MIN), sku: '103;6' }]);
    expect(h.sent[0]!.title).toBe('Back on scrap.tf (Hats): Hat 103;6');
    expect(h.sent[0]!.body).toMatch(/; on sale again in your saves$/);
    expect(h.sent[0]!.body).not.toMatch(/\bjust\b/);
  });

  it('one seen on an earlier save of another page of the bank is back (the runs index), one never seen is new', () => {
    const h = setup();
    const craft = { craft: 'craftable' as const };
    // /items/2 listed 104 three hours ago; /items did not list it two hours ago, and lists it now beside 105 (never seen).
    save(h.repo, 'list', NOW - 3 * HOUR, [s('104;6', h.M - 30, craft)], '/items/2');
    save(h.repo, 'list', NOW - 2 * HOUR, [s('100;6', 50, craft)], '/items');
    const newest = save(h.repo, 'list', NOW - 5 * MIN, [s('100;6', 50, craft), s('104;6', h.M - 30, craft), s('105;6', h.M - 40, craft)], '/items');
    expect(h.run('list', newest)).toBe(2);
    expect(h.history.runsFor('list').get(bankStockKey('104;6', ''))!.seenAt).toBe(NOW - 3 * HOUR);
    expect(h.sent.map((x) => [x.title, x.sku])).toEqual([
      ['New on scrap.tf (All items): Hat 105;6', '105;6'],
      ['Back on scrap.tf (All items): Hat 104;6', '104;6'],
    ]);
  });
});

describe('G5: summaries open the bank stock page on a chip', () => {
  it('the "+N more" summary of new flips opens the New chip; a mixed one names its kinds', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 2 * HOUR, [s('100;6', 50)]);
    const newest = save(h.repo, 'hats', NOW - 5 * MIN, [s('100;6', 50), ...['101;6', '102;6', '103;6', '104;6', '105;6'].map((sku, i) => s(sku, 10 + i))]);
    expect(h.run('hats', newest)).toBe(4);
    expect(h.sent[3]).toEqual({ title: '+2 more new flips on scrap.tf/buy/hats', body: BANK_STOCK_MORE_BODY, sku: null, openBankStock: { bank: 'hats', filter: 'new' } });

    const m = setup();
    save(m.repo, 'hats', NOW - 2 * HOUR, [s('100;6', 50), s('106;6', m.M + 10), s('107;6', m.M - 30, { stock: 0 })]);
    const mixed = save(m.repo, 'hats', NOW - 5 * MIN, [
      s('100;6', 50),
      ...['101;6', '102;6', '103;6'].map((sku, i) => s(sku, 10 + i)),
      s('106;6', m.M - 30),
      s('107;6', m.M - 30),
    ]);
    expect(m.run('hats', mixed)).toBe(4);
    expect(m.sent.slice(0, 3).map((x) => x.sku)).toEqual(['101;6', '102;6', '103;6']);
    // The rest: a cheaper flip (chip 'flips') and a flip back on sale (chip 'new'), all flips: the Flips chip.
    expect(m.sent[3]).toEqual({ title: '+2 more on scrap.tf/buy/hats: 1 cheaper, 1 back on sale', body: BANK_STOCK_MORE_BODY, sku: null, openBankStock: { bank: 'hats', filter: 'flips' } });
  });

  it('a save older than profit.inputStaleMs is one dated summary that opens the New chip', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 50 * HOUR, [s('100;6', 50)]);
    const newest = save(h.repo, 'hats', NOW - 48 * HOUR, [s('100;6', 50), s('101;6', 10), s('102;6', 11)]);
    expect(h.run('hats', newest)).toBe(1);
    expect(h.sent).toEqual([{ ...bankStockOldSaveNotice(2, 'https://scrap.tf/buy/hats', 48 * HOUR), sku: null, openBankStock: { bank: 'hats', filter: 'new' } }]);
    // Recorded like any told row.
    expect(Object.keys(JSON.parse(h.repo.getMeta(BANK_STOCK_NOTIFY_META_KEY)!) as object).sort()).toEqual(['hats|101;6', 'hats|102;6']);
  });
});

describe('BankStock.droppedFlips: newFlips\' look rules', () => {
  it('a first save gives none, nor does the same file imported again or an older page imported late', () => {
    const h = setup();
    const first = save(h.repo, 'hats', NOW - 2 * HOUR, [s('101;6', h.M + 10)]);
    h.stock.refresh();
    expect(h.stock.droppedFlips('hats', first)).toEqual([]);
    const newest = save(h.repo, 'hats', NOW - 5 * MIN, [s('101;6', h.M - 30)]);
    h.stock.refresh();
    expect(h.stock.droppedFlips('hats', newest).map((r) => r.sku)).toEqual(['101;6']);
    // The same file again (same time, a higher batch id): no new look.
    const again = save(h.repo, 'hats', NOW - 5 * MIN, h.repo.bankStockRows(newest));
    h.stock.refresh();
    expect(again).toBeGreaterThan(newest);
    expect(h.stock.droppedFlips('hats', again)).toEqual([]);
    expect(h.stock.droppedFlips('hats', first)).toEqual([]);
    // Another bank, and a batch nobody imported.
    expect(h.stock.droppedFlips('stranges', newest)).toEqual([]);
    expect(h.stock.droppedFlips('hats', 9999)).toEqual([]);
  });
});
