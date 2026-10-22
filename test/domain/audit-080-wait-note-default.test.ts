// 0.8 review (ui): G4's wait note ("; your saves say it may drop again (Wait)") is part of the opt-in G4
// (notifications.buyTiming, off by default, D25). The notifier always joins a row's buy timing, so before this fix a
// default install's "New on scrap.tf" toast gained the note whenever the copy's timing read Wait, although 0.7.4 sent
// the plain text and the user never turned buy timing on. Through the real notifier over an in-memory repo, the real
// bank stock cache and runs index, with the copy's timing scripted to Wait: off, the toast is 0.7.4's text; on, it
// carries the note. Pages the user saved only (R10).

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock, notifyNewBankFlips, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { BANK_STOCK_WAIT_NOTE_FIRST } from '../../src/shared/bankStockNotify';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { BankStockStored, DeepPartial, KeyPriceState, ScraptfBank, ScraptfBuyTiming, Settings, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const T = NOW - 10 * HOUR;
const PLAIN = '11.11 ref, sells for 22.22 ref to KeyBot, +11.11 ref';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number): BankStockStored {
  return { sku, specialKey: '', name: `Hat ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null };
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

/** Every copy reads Wait ~1 d (the estimator itself is scraptfTiming's, tested there). */
function waitOf(bank: ScraptfBank, key: string, at: UnixMs): ScraptfBuyTiming {
  return {
    verdict: 'wait',
    why: 'drop-likely',
    bank,
    key,
    costScrap: 100,
    revenueScrap: 200,
    maxCostScrap: 185,
    priceSince: at - HOUR,
    pricePrevAt: at - 2 * HOUR,
    lastSeenAt: at,
    ageMs: HOUR,
    horizonMs: DAY,
    pDrop: 0.5,
    pGone: 0.1,
    pRise: 0,
    pNone: 0.4,
    dropPct: 0.05,
    dropPctSource: 'bank',
    expectedNextScrap: 95,
    evBuyScrap: 100,
    evWaitScrap: 102,
    dropsThisRun: 0,
    steps: [],
    cadenceMs: null,
    cadenceSource: null,
    nextDropAt: null,
    earlierRunEnds: [],
    scope: 'bank',
    lookGapMs: HOUR,
    resolutionMs: HOUR,
    n: { states: 40, copies: 12, ended: 30, drops: 20, dropCopies: 8, gone: 8, rose: 2, atRisk: 10, atRiskEnd: 4, ownDrops: 0, imprecise: 0, wideGap: 0 },
  };
}

/** Two saves of the hats page, the second adding a never-seen flip (106;6 at 100 against a 200 buyer); the toasts sent. */
function toastsOf(patch: DeepPartial<Settings>): PushContract['notify'][] {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, patch);
  const log = recordingLogger();
  const market = { entryFor: () => entry(200, settings) };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market, keyPrice: () => KEY });
  const stock: BankStock = createBankStock({
    clock: { now: () => NOW },
    log,
    repo,
    market,
    keyPrice: () => KEY,
    settings: () => settings,
    categoryOf: () => 'hats',
    history: { runsFor: (bank) => history.runsFor(bank), timingFor: (bank, key, _buy, at) => waitOf(bank, key, at) },
  });
  const sent: PushContract['notify'][] = [];
  const read = (at: UnixMs, rows: readonly BankStockStored[]): void => {
    const id = repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank: 'hats' });
    repo.insertBankStock(id, 'hats', rows, '/buy/hats');
    stock.refresh();
    history.refresh();
    notifyNewBankFlips({ log, repo, stock, settings: () => settings, keyPrice: () => KEY, notify: (n) => sent.push(n) }, { bank: 'hats', batchId: id }, at + MIN);
  };
  read(T, [s('101;6', 500)]);
  read(T + HOUR, [s('101;6', 500), s('106;6', 100)]);
  return sent;
}

describe("G4's wait note is opt-in, as G4 is", () => {
  it('off (the default): a new flip reading Wait is told with 0.7.4\'s text', () => {
    expect(DEFAULT_SETTINGS.notifications.buyTiming).toBe(false);
    expect(toastsOf({})).toEqual([{ title: 'New on scrap.tf (Hats): Hat 106;6', body: PLAIN, sku: '106;6' }]);
  });

  it('on: the same toast says the saves suggest waiting', () => {
    // A never-seen copy has not dropped in its run (dropsThisRun 0): "may drop", no "again" (alerts review).
    expect(toastsOf({ notifications: { buyTiming: true } })).toEqual([{ title: 'New on scrap.tf (Hats): Hat 106;6', body: `${PLAIN}${BANK_STOCK_WAIT_NOTE_FIRST}`, sku: '106;6' }]);
  });
});
