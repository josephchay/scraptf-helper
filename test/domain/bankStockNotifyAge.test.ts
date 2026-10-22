// 0.7.1 (ACT-6): "New on scrap.tf" notifications say how old the save is, and a save older than
// profit.inputStaleMs (the folder watch's catch-up of pages saved while the app was closed) is told as one
// dated summary instead of a toast per item. notifyNewBankFlips over the real bank stock cache
// (BankStock.savedAtOf) and an in-memory repo. Pages the user saved only (R10); no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, notifyNewBankFlips, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { BANK_STOCK_NOTIFY_AGE_NOTE_MS, bankStockOldSaveNotice, bankStockSaveAgeText } from '../../src/shared/bankStock';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { BankStockStored, KeyPriceState, ScraptfBank, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const SETTINGS = mergeSettings(DEFAULT_SETTINGS, { notifications: { enabled: true } });

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number): BankStockStored {
  return { sku, specialKey: '', name: `Hat ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: NOW, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows);
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
    maxCostScrap: maxCostFor(revenueScrap, SETTINGS.profit),
    confidence: 80,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
  };
}

function setup(): { repo: Repo; stock: BankStock; sent: PushContract['notify'][]; run(batchId: number): number } {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const entries = new Map(['1;6', '2;6', '3;6', '4;6', '5;6'].map((sku) => [sku, entry(100)]));
  const stock = createBankStock({ clock: { now: () => NOW }, log: recordingLogger(), repo, market: { entryFor: (b) => entries.get(b) ?? null }, keyPrice: () => KEY, settings: () => SETTINGS, categoryOf: () => 'hats' });
  const sent: PushContract['notify'][] = [];
  const deps = { log: recordingLogger(), repo, stock, settings: () => SETTINGS, keyPrice: () => KEY, notify: (n: PushContract['notify']) => sent.push(n) };
  return {
    repo,
    stock,
    sent,
    run(batchId) {
      stock.refresh();
      return notifyNewBankFlips(deps, { bank: 'hats', batchId }, NOW);
    },
  };
}

const NEW = [s('1;6', 10), s('2;6', 20), s('3;6', 30), s('4;6', 40), s('5;6', 50)];

describe('the age of a told save (ACT-6)', () => {
  it('saves at T-50 h and T-48 h: one summary with the age, no toast per item', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 50 * HOUR, [s('9;6', 5)]);
    const newest = save(h.repo, 'hats', NOW - 48 * HOUR, [s('9;6', 5), ...NEW.slice(0, 3)]);
    expect(h.stock.savedAtOf(newest)).toBe(NOW - 48 * HOUR);
    expect(h.run(newest)).toBe(1);
    // 0.8 (G5): the summary opens the bank's stock page on the New chip (an in-app route, no URL).
    expect(h.sent).toEqual([{ ...bankStockOldSaveNotice(3, 'https://scrap.tf/buy/hats', 48 * HOUR), sku: null, openBankStock: { bank: 'hats', filter: 'new' } }]);
    expect(h.sent[0]!.title).toBe('3 new flips in your save of scrap.tf/buy/hats from 2 d ago');
    // Recorded in the dedupe like any told row: the same look is not told again.
    expect(h.run(newest)).toBe(0);
  });

  it('a save over 15 minutes old but still fresh says its age on each body', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 3 * HOUR, [s('9;6', 5)]);
    const newest = save(h.repo, 'hats', NOW - 40 * MIN, [s('9;6', 5), s('1;6', 10)]);
    expect(h.run(newest)).toBe(1);
    expect(h.sent[0]).toMatchObject({ title: 'New on scrap.tf (Hats): Hat 1;6', sku: '1;6' });
    expect((h.sent[0] as { body: string }).body).toMatch(/; in your save 40 min ago$/);
  });

  it('a save of the last 15 minutes is told as before, with no age', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 3 * HOUR, [s('9;6', 5)]);
    const newest = save(h.repo, 'hats', NOW - BANK_STOCK_NOTIFY_AGE_NOTE_MS + MIN, [s('9;6', 5), ...NEW]);
    expect(h.run(newest)).toBe(4);
    expect(h.sent.slice(0, 3).every((n) => !(n as { body: string }).body.includes('in your save'))).toBe(true);
    expect(h.sent[3]).toMatchObject({ title: '+2 more new flips on scrap.tf/buy/hats', sku: null });
  });

  it('words the age in whole units', () => {
    expect([bankStockSaveAgeText(0), bankStockSaveAgeText(59 * MIN), bankStockSaveAgeText(3 * HOUR + 59 * MIN), bankStockSaveAgeText(47 * HOUR), bankStockSaveAgeText(48 * HOUR), bankStockSaveAgeText(-5)]).toEqual([
      '0 min',
      '59 min',
      '3 h',
      '47 h',
      '2 d',
      '0 min',
    ]);
    expect(bankStockOldSaveNotice(1, 'https://scrap.tf/buy/hats', 3 * HOUR).title).toBe('1 new flip in your save of scrap.tf/buy/hats from 3 h ago');
  });

  it('a stock without savedAtOf (an older stand-in) tells every save as just made', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - 50 * HOUR, [s('9;6', 5)]);
    const newest = save(h.repo, 'hats', NOW - 48 * HOUR, [s('9;6', 5), s('1;6', 10)]);
    h.stock.refresh();
    const sent: PushContract['notify'][] = [];
    const n = notifyNewBankFlips(
      { log: recordingLogger(), repo: h.repo, stock: { newFlips: (b, id) => h.stock.newFlips(b, id) }, settings: () => SETTINGS, keyPrice: () => KEY, notify: (x) => sent.push(x) },
      { bank: 'hats', batchId: newest },
      NOW,
    );
    expect(n).toBe(1);
    expect(sent[0]).toMatchObject({ sku: '1;6' });
  });
});
