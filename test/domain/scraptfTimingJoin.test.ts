// 0.8 (T3/T4, F20's "never a query per row"): the buy-timing join stays in memory. A bank stock list() hands every
// on-sale row's verdict the read's own key price and profit settings (ScraptfTimingInputs), so the history reads no
// key price per row (engine.keyPrice() is a key_prices query in core), and a verdict reads its page's look gap from
// the lifecycle (one sort per page and build, never per row). The values are exactly what the history gives without
// the inputs. Real in-memory repo, bank stock and history; saves are pages the user saved (R10); no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { bankStockKey } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { scraptfBankCyclesOf, scraptfLookGapMs, scraptfTimingBrief, scraptfTimingForKey } from '../../src/shared/scraptfTiming';
import type { ScraptfSaveRows } from '../../src/shared/scraptfHistory';
import type { BankStockStored, KeyPriceState, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
/** Sells for 60, Pay up to 55, for every base. */
const BUY = { revenueScrap: 60, maxCostScrap: 55 } as const;
const COPIES = 30;
const SAVES = 24;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function r(sku: string, costScrap: number): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null };
}

/** Hats saved every 2 h for 2 days: COPIES copies, each dropping 4 % every few saves. */
function rowsAt(i: number): BankStockStored[] {
  return Array.from({ length: COPIES }, (_, c) => r(`${200 + c};6`, Math.round((40 + c) * 0.96 ** Math.floor(i / (2 + (c % 4))))));
}

function savedAt(i: number): UnixMs {
  return NOW - 30 * MIN - (SAVES - 1 - i) * 2 * HOUR;
}

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const log = recordingLogger();
  const entryFor = () => BUY as unknown as MarketEval;
  let historyKeyReads = 0;
  const history = createScraptfHistory({
    clock: { now: () => NOW },
    log,
    repo,
    market: { entryFor },
    keyPrice: () => {
      historyKeyReads++;
      return KEY;
    },
    profit: () => DEFAULT_SETTINGS.profit,
  });
  const stock = createBankStock({
    clock: { now: () => NOW },
    log,
    repo,
    market: { entryFor },
    keyPrice: () => KEY,
    settings: () => DEFAULT_SETTINGS,
    categoryOf: () => 'hats',
    // As core wires it: the read's inputs pass through.
    history: {
      runsFor: (bank) => history.runsFor(bank),
      timingFor: (bank, key, buy, now, inputs) => history.timingFor(bank, key, buy, now, inputs),
      turnoverFor: (bank) => history.turnoverFor(bank),
    },
  });
  for (let i = 0; i < SAVES; i++) {
    const id = repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: savedAt(i), importedAt: savedAt(i), itemCount: COPIES, bank: 'hats' });
    repo.insertBankStock(id, 'hats', rowsAt(i), '/buy/hats');
  }
  return { repo, history, stock, keyReads: () => historyKeyReads };
}

describe('the timing join reads no key price per row (0.8, T4)', () => {
  it("bank stock list() and all(): the history reads the key price at most once per list, whatever the rows; values unchanged", () => {
    const h = setup();
    const before = h.keyReads();
    const first = h.stock.list({ bank: 'hats', filter: 'all', limit: 2000 }, NOW);
    const timed = first.rows.filter((x) => x.timing !== undefined);
    expect(timed.length).toBe(COPIES);
    // The cycles' build reads it once (the directions across a key boundary); the rows read none.
    expect(h.keyReads() - before).toBeLessThanOrEqual(1);
    const mid = h.keyReads();
    h.stock.list({ bank: 'hats', filter: 'all', limit: 2000 }, NOW);
    h.stock.all({ bank: 'hats', filter: 'all' }, NOW);
    expect(h.keyReads()).toBe(mid);
    // Exactly the verdicts the history gives when it reads both itself.
    for (const row of timed) {
      expect(row.timing, row.key).toEqual(scraptfTimingBrief(h.history.timingFor('hats', row.key, BUY, NOW)!));
    }
  });

  it('inputs without a usable key price are ignored (the history reads its own)', () => {
    const h = setup();
    const key = bankStockKey('201;6', '');
    const want = h.history.timingFor('hats', key, BUY, NOW);
    expect(want).not.toBeNull();
    expect(h.history.timingFor('hats', key, BUY, NOW, { keyScrap: Number.NaN, profit: DEFAULT_SETTINGS.profit })).toEqual(want);
    expect(h.history.timingFor('hats', key, BUY, NOW, { keyScrap: KEY.valueScrap, profit: DEFAULT_SETTINGS.profit })).toEqual(want);
  });
});

describe("a verdict reads its page's look gap from the lifecycle (one sort per page and build)", () => {
  it('scraptfTimingForKey never re-reads the save times per row', () => {
    const saves: ScraptfSaveRows[] = Array.from({ length: SAVES }, (_, i) => ({
      batchId: i + 1,
      savedAt: savedAt(i),
      page: '/buy/hats',
      rows: rowsAt(i),
    }));
    const c = scraptfBankCyclesOf('hats', saves, KEY.valueScrap);
    const key = bankStockKey('201;6', '');
    const args = { cycles: c, key, buy: BUY, profit: DEFAULT_SETTINGS.profit, keyScrap: KEY.valueScrap, now: NOW };
    const want = scraptfTimingForKey(args);
    expect(want?.lookGapMs).toBe(2 * HOUR);
    expect(want?.lookGapMs).toBe(scraptfLookGapMs(saves.map((s) => s.savedAt)));
    // The per-row path reads the gap the walk kept: emptying the page's save times afterwards changes nothing.
    c.life.pageSaves.set('/buy/hats', []);
    expect(scraptfTimingForKey(args)).toEqual(want);
  });
});
