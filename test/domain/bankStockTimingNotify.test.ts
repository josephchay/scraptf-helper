// 0.8 (G4): "Buy now (<Bank>): <name>" through the one S3 notifier, over real saves in an in-memory repo, the real bank
// stock cache and the real runs index. The copy's buy timing is scripted per read (the estimator itself is
// scraptfTiming's, tested there): the notifier only reads the verdict, dropsThisRun and the horizon a row carries
// (BankStockLook rows judged at the bank stock's now, D9). Opt-in: with notifications.buyTiming off (the default, D25)
// nothing is told and no bankStock.timing meta is written. A Wait on the read before, then Buy now with a drop since
// the Wait began or the Wait's horizon passed, fires once; aging alone never does. Pages the user saved only (R10).

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { BANK_STOCK_TIMING_META_KEY, createBankStock, notifyNewBankFlips, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { BANK_STOCK_MORE_BODY } from '../../src/shared/bankStock';
import { BANK_STOCK_WAIT_NOTE, bankStockWaitKey, bankStockTimingParse } from '../../src/shared/bankStockNotify';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { BankStockStored, DeepPartial, KeyPriceState, ScraptfBank, ScraptfBuyTiming, ScraptfTimingVerdict, Settings, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const T = NOW - 10 * HOUR;
/** 0.9 (#9): a G4 toast that tells a flip ends with the checkout guard's sentence (186 characters, under 200). */
const BUY_NOW_BODY =
  "11.11 ref, sells for 22.22 ref to KeyBot, +11.11 ref; your saves said wait on the read before, now buy now (an estimate from your saves, not a forecast). Accept the bot's offer promptly.";

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Hat ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank: 'hats' });
  repo.insertBankStock(id, 'hats', rows, '/buy/hats');
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

/** What the scripted estimator says of every copy on the next read. */
interface Script {
  verdict: ScraptfTimingVerdict;
  drops: number;
  horizonMs: number | null;
}

function timingOf(bank: ScraptfBank, key: string, sc: Script, at: UnixMs): ScraptfBuyTiming {
  return {
    verdict: sc.verdict,
    why: sc.verdict === 'wait' ? 'drop-likely' : sc.verdict === 'buy-now' ? 'flip-now' : sc.verdict === 'over' ? 'over' : sc.verdict === 'no-buyers' ? 'no-buyers' : 'few-drops',
    bank,
    key,
    costScrap: 100,
    revenueScrap: 200,
    maxCostScrap: 185,
    priceSince: at - HOUR,
    pricePrevAt: at - 2 * HOUR,
    lastSeenAt: at,
    ageMs: HOUR,
    horizonMs: sc.horizonMs,
    pDrop: 0.5,
    pGone: 0.1,
    pRise: 0,
    pNone: 0.4,
    dropPct: 0.05,
    dropPctSource: 'bank',
    expectedNextScrap: 95,
    evBuyScrap: 100,
    evWaitScrap: 102,
    dropsThisRun: sc.drops,
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

interface Harness {
  repo: Repo;
  stock: BankStock;
  script: Script;
  sent: PushContract['notify'][];
  /** The row keys the history was asked to judge (timingFor), in order. */
  timed: string[];
  /** A read of the hats page at `at` (101 at `cost`, then `more`), told as core tells it, `now` after it. */
  read(at: UnixMs, cost: number, now?: UnixMs, more?: readonly BankStockStored[]): number;
}

function setup(patch: DeepPartial<Settings> = { notifications: { buyTiming: true } }): Harness {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, patch);
  const log = recordingLogger();
  const market = { entryFor: () => entry(200, settings) };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market, keyPrice: () => KEY });
  const h: Harness = {
    repo,
    script: { verdict: 'not-enough-data', drops: 0, horizonMs: null },
    sent: [],
    timed: [],
    stock: null as unknown as BankStock,
    read(at, cost, now = at + MIN, more = []) {
      const id = save(repo, at, [s('101;6', cost), ...more]);
      h.stock.refresh();
      history.refresh();
      notifyNewBankFlips({ log, repo, stock: h.stock, settings: () => settings, keyPrice: () => KEY, notify: (n) => h.sent.push(n) }, { bank: 'hats', batchId: id }, now);
      return id;
    },
  };
  h.stock = createBankStock({
    clock: { now: () => NOW },
    log,
    repo,
    market,
    keyPrice: () => KEY,
    settings: () => settings,
    categoryOf: () => 'hats',
    history: {
      runsFor: (bank) => history.runsFor(bank),
      timingFor: (bank, key, _buy, at) => {
        h.timed.push(key);
        return timingOf(bank, key, h.script, at);
      },
    },
  });
  return h;
}

const titles = (h: Harness): string[] => h.sent.map((n) => n.title);
const memo = (h: Harness) => bankStockTimingParse(h.repo.getMeta(BANK_STOCK_TIMING_META_KEY));

describe('G4: "Buy now" after Wait (opt-in)', () => {
  it('wait, then a save showing a drop and buy now: one "Buy now (Hats)" toast', () => {
    const h = setup();
    h.script = { verdict: 'wait', drops: 0, horizonMs: DAY };
    h.read(T, 110);
    h.read(T + HOUR, 110);
    // The Wait streak, from its first told look, with the drops and horizon it began with.
    expect(memo(h).get(bankStockWaitKey('hats', '101;6|'))).toEqual({ at: T + HOUR, since: T, drops: 0, horizonMs: DAY });
    expect(h.sent).toEqual([]);
    h.script = { verdict: 'buy-now', drops: 1, horizonMs: DAY };
    const told = h.read(T + 2 * HOUR, 100);
    expect(h.sent).toEqual([{ title: 'Buy now (Hats): Hat 101;6', body: BUY_NOW_BODY, sku: '101;6' }]);
    // The streak ended; the row's timing is the brief the notifier read.
    expect(memo(h).size).toBe(0);
    expect(h.stock.lookOf('hats', told)!.rows[0]!.row.timing).toMatchObject({ verdict: 'buy-now', dropsThisRun: 1, horizonMs: DAY });
    // Once: still buy now on the next read, and the look told again, say nothing.
    h.read(T + 3 * HOUR, 100);
    expect(titles(h)).toEqual(['Buy now (Hats): Hat 101;6']);
  });

  it("fires when the first Wait's horizon has passed with no drop", () => {
    const h = setup();
    h.script = { verdict: 'wait', drops: 2, horizonMs: 6 * HOUR };
    h.read(T, 110);
    h.read(T + 3 * HOUR, 110);
    h.script = { verdict: 'buy-now', drops: 2, horizonMs: 6 * HOUR };
    h.read(T + 6 * HOUR, 110);
    expect(titles(h)).toEqual(['Buy now (Hats): Hat 101;6']);
  });

  it('never on aging alone: the same price and drops, inside the horizon, back and forth', () => {
    const h = setup();
    for (const [i, verdict] of (['wait', 'buy-now', 'wait', 'buy-now'] as const).entries()) {
      h.script = { verdict, drops: 1, horizonMs: DAY };
      h.read(T + i * 30 * MIN, 110);
    }
    expect(h.sent).toEqual([]);
  });

  it('never from a Wait on an older save, nor after not-enough-data', () => {
    const h = setup();
    h.script = { verdict: 'wait', drops: 0, horizonMs: DAY };
    h.read(T, 110);
    h.script = { verdict: 'not-enough-data', drops: 0, horizonMs: null };
    h.read(T + HOUR, 110);
    h.script = { verdict: 'buy-now', drops: 1, horizonMs: DAY };
    h.read(T + 2 * HOUR, 100);
    expect(h.sent).toEqual([]);
  });

  it('a stale save is one dated summary on the Flips chip', () => {
    const h = setup();
    h.script = { verdict: 'wait', drops: 0, horizonMs: DAY };
    h.read(NOW - 50 * HOUR, 110, NOW);
    h.script = { verdict: 'buy-now', drops: 1, horizonMs: DAY };
    h.read(NOW - 48 * HOUR, 100, NOW);
    expect(h.sent).toEqual([
      {
        title: '1 item in your save of scrap.tf/buy/hats from 2 d ago: 1 buy now',
        body: expect.any(String) as unknown as string,
        sku: null,
        openBankStock: { bank: 'hats', filter: 'flips' },
      },
    ]);
    expect(h.sent[0]!.body).not.toBe(BANK_STOCK_MORE_BODY);
  });

  it('off by default: the same saves tell no "Buy now" and write no bankStock.timing meta', () => {
    const h = setup({});
    h.script = { verdict: 'wait', drops: 0, horizonMs: DAY };
    h.read(T, 110);
    h.read(T + HOUR, 110);
    h.script = { verdict: 'buy-now', drops: 1, horizonMs: DAY };
    h.read(T + 2 * HOUR, 100);
    expect(h.sent).toEqual([]);
    expect(h.repo.getMeta(BANK_STOCK_TIMING_META_KEY)).toBeNull();
    // Nor with the scrap.tf flips switch off (G4 needs it).
    const off = setup({ notifications: { buyTiming: true, newOnScraptf: false } });
    off.script = { verdict: 'wait', drops: 0, horizonMs: DAY };
    off.read(T, 110);
    off.script = { verdict: 'buy-now', drops: 1, horizonMs: DAY };
    off.read(T + HOUR, 100);
    expect(off.sent).toEqual([]);
    expect(off.repo.getMeta(BANK_STOCK_TIMING_META_KEY)).toBeNull();
  });
});

describe('G4 off (the default): the told look is read untimed', () => {
  // Not flips (cost over the 200 revenue): on sale on every read, never told.
  const others = ['102;6', '103;6', '104;6', '105;6'].map((sku) => s(sku, 500));

  it('no import judges a verdict (no lifecycle is built on its path), a told flip included', () => {
    const h = setup({});
    h.script = { verdict: 'wait', drops: 0, horizonMs: DAY };
    // A first save, then the same page again: nothing to tell.
    h.read(T, 110, undefined, others);
    h.read(T + HOUR, 110, undefined, others);
    expect(h.sent).toEqual([]);
    expect(h.timed).toEqual([]);
    // A new flip is told as 0.7.4 told it, and still no verdict was asked for.
    h.read(T + 2 * HOUR, 110, undefined, [...others, s('106;6', 100)]);
    expect(titles(h)).toEqual(['New on scrap.tf (Hats): Hat 106;6']);
    // The Wait note is part of the opt-in G4: with it off the toast is 0.7.4's, whatever the row's timing reads.
    expect(h.sent[0]!.body).not.toContain(BANK_STOCK_WAIT_NOTE);
    expect(h.sent[0]!.body).not.toMatch(/your saves say it may drop/);
    expect(h.timed).toEqual([]);
    // The look itself still joins every on-sale row's timing when asked without options (D9).
    h.timed.length = 0;
    expect(h.stock.lookOf('hats', h.read(T + 3 * HOUR, 110, undefined, others))!.rows.every((r) => r.row.timing?.verdict === 'wait')).toBe(true);
  });

  it('with G4 on every on-sale row of the look is still judged (bankStockTimingNext reads them all)', () => {
    const h = setup();
    h.script = { verdict: 'wait', drops: 0, horizonMs: DAY };
    h.read(T, 110, undefined, others);
    expect([...h.timed].sort()).toEqual(['101;6|', '102;6|', '103;6|', '104;6|', '105;6|']);
  });
});
