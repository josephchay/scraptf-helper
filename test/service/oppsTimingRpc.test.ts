// 0.8 (T4/T7) 'opps.list': each 'import' row of the page carries the buy timing of the copy it prices
// (scraptfOpportunityTiming over ctx.scraptfHistory.timingForCopy, joined at read time, never stored); 'user' and
// 'rule' rows never do. A history that throws, or a context without timingForCopy (test stubs, older wiring),
// leaves the field out and the page reads. Real in-memory repo and history; saves are pages the user saved (R10);
// no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine, HttpClient, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import type { MarketIndex } from '../../src/service/domain/market';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { createRpcHandlers, type HandlerContext, type RpcHandler } from '../../src/service/rpcHandlers';
import { bankStockKey } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { scraptfTimingBrief } from '../../src/shared/scraptfTiming';
import type { BankStockStored, KeyPriceState, OppListResult, Opportunity, ScraptfBuyTiming } from '../../src/shared/types';
import { makeOpp } from '../db/helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const PAINT = '[15185211,[],[],null,null,false,false]';

let repo: Repo;

beforeEach(() => {
  repo = openRepo(':memory:');
});

afterEach(() => {
  repo.close();
  vi.restoreAllMocks();
});

/** A user price, an imported price of a painted copy, an imported plain one and a rule estimate, as the repo pages them. */
const PAGE: Opportunity[] = [
  makeOpp({ sku: '378;6', inputRef: 'price:1', inputKind: 'user' }),
  makeOpp({ sku: '378;6;p15185211', inputRef: 'price:2', inputKind: 'import', copyKey: PAINT, revenueScrap: 120, maxCostScrap: 111 }),
  makeOpp({ sku: '126;6', inputRef: 'price:3', inputKind: 'import', revenueScrap: null, maxCostScrap: null }),
  makeOpp({ sku: '30357;6', inputRef: 'rule:1', inputKind: 'rule' }),
];

function rpcWith(scraptfHistory: Partial<HandlerContext['scraptfHistory']>, keyPrice: () => KeyPriceState = () => KEY): RpcHandler {
  vi.spyOn(repo, 'countOpportunities').mockReturnValue(PAGE.length);
  vi.spyOn(repo, 'queryOpportunities').mockReturnValue(structuredClone(PAGE));
  const ctx = {
    clock: { now: () => NOW },
    log: quiet,
    repo,
    http: { isPaused: () => false, hostBlocked: () => null, nextAllowedAt: () => 0 } as unknown as HttpClient,
    engine: { keyPrice } as unknown as Engine,
    market: {} as unknown as MarketIndex,
    scraptfHistory,
    settings: () => DEFAULT_SETTINGS,
    secret: () => null,
    push: () => undefined,
  } as unknown as HandlerContext;
  return createRpcHandlers(ctx);
}

/** A verdict for whatever copy is asked, naming it. */
function fakeTiming(base: string, special: string): ScraptfBuyTiming {
  return {
    verdict: 'buy-now',
    why: 'flip-now',
    bank: 'hats',
    key: bankStockKey(base, special),
    costScrap: 100,
    revenueScrap: 120,
    maxCostScrap: 111,
    priceSince: NOW - 5 * HOUR,
    pricePrevAt: NOW - 7 * HOUR,
    lastSeenAt: NOW - HOUR,
    ageMs: 4 * HOUR,
    horizonMs: 6 * HOUR,
    pDrop: 0.2,
    pGone: 0.1,
    pRise: 0,
    pNone: 0.7,
    dropPct: 0.05,
    dropPctSource: 'bank',
    expectedNextScrap: 95,
    evBuyScrap: 11,
    evWaitScrap: 9,
    dropsThisRun: 0,
    steps: [],
    cadenceMs: null,
    cadenceSource: null,
    nextDropAt: null,
    earlierRunEnds: [],
    scope: 'bank',
    lookGapMs: 2 * HOUR,
    resolutionMs: 2 * HOUR,
    n: { states: 40, copies: 12, ended: 20, drops: 8, dropCopies: 5, gone: 9, rose: 3, atRisk: 10, atRiskEnd: 4, ownDrops: 0, imprecise: 2, wideGap: 0 },
  };
}

describe("'opps.list' joins Opportunity.timing (0.8, T4/T7)", () => {
  it("asks timingForCopy for 'import' rows only (base, copy key, the row's own Sells for and Pay up to, the clock)", async () => {
    const timingForCopy = vi.fn((base: string, special: string) => fakeTiming(base, special));
    const keyPrice = vi.fn(() => KEY);
    const rpc = rpcWith({ timingForCopy }, keyPrice);
    const res = (await rpc('opps.list', { limit: 50 })) as OppListResult;
    // With the page's key price and profit settings, read once for the page (no key-price query per row).
    const inputs = { keyScrap: KEY.valueScrap, profit: DEFAULT_SETTINGS.profit };
    expect(timingForCopy.mock.calls).toEqual([
      ['378;6', PAINT, { revenueScrap: 120, maxCostScrap: 111 }, NOW, inputs],
      ['126;6', '', { revenueScrap: null, maxCostScrap: null }, NOW, inputs],
    ]);
    expect(keyPrice).toHaveBeenCalledTimes(1);
    const byRef = new Map(res.rows.map((o) => [o.inputRef, o]));
    expect(byRef.get('price:2')!.timing).toEqual(scraptfTimingBrief(fakeTiming('378;6', PAINT)));
    expect(byRef.get('price:3')!.timing).toEqual(scraptfTimingBrief(fakeTiming('126;6', '')));
    expect(byRef.get('price:1')).not.toHaveProperty('timing');
    expect(byRef.get('rule:1')).not.toHaveProperty('timing');
    // Nothing else about the rows changes.
    expect(res.rows.map(({ timing: _t, references: _r, ...o }) => o)).toEqual(PAGE.map(({ references: _r, ...o }) => o));
  });

  it('a copy without a verdict leaves the field out', async () => {
    const rpc = rpcWith({ timingForCopy: () => null });
    const res = (await rpc('opps.list', {})) as OppListResult;
    expect(res.rows.some((o) => 'timing' in o)).toBe(false);
  });

  it('a history that throws leaves the field out, and the page reads', async () => {
    const rpc = rpcWith({
      timingForCopy: () => {
        throw new Error('history down');
      },
    });
    const res = (await rpc('opps.list', {})) as OppListResult;
    expect(res.rows).toHaveLength(PAGE.length);
    expect(res.rows.some((o) => 'timing' in o)).toBe(false);
  });

  it('a context without timingForCopy (a stub, older wiring) gives no timing', async () => {
    const rpc = rpcWith({});
    const res = (await rpc('opps.list', {})) as OppListResult;
    expect(res.rows).toHaveLength(PAGE.length);
    expect(res.rows.some((o) => 'timing' in o)).toBe(false);
  });

  it("with the real history: the verdict of the copy in the bank its item history reads, from the saves in memory", async () => {
    const r = (sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored => ({ sku, specialKey: '', name: sku, costKeys: 0, costScrap, stock: 1, assetId: null, ...over });
    for (let i = 0; i < 12; i++) {
      const at = NOW - 30 * MIN - (11 - i) * 2 * HOUR;
      const id = repo.createImportBatch({ fileName: 'hats.html', pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: 2, bank: 'hats' });
      repo.insertBankStock(id, 'hats', [r('378;6', 100 - i, { specialKey: PAINT }), r('126;6', 50)], '/buy/hats');
    }
    const history: ScraptfHistory = createScraptfHistory({ clock: { now: () => NOW }, log: quiet, repo, market: { entryFor: () => null }, keyPrice: () => KEY, profit: () => DEFAULT_SETTINGS.profit });
    const spy = vi.spyOn(history, 'timingForCopy');
    const rpc = rpcWith({ timingForCopy: (b, s, buy, at) => history.timingForCopy(b, s, buy, at) });
    const rows = new Map(((await rpc('opps.list', {})) as OppListResult).rows.map((o) => [o.inputRef, o]));
    const painted = history.timingForCopy('378;6', PAINT, { revenueScrap: 120, maxCostScrap: 111 }, NOW);
    expect(painted).toMatchObject({ bank: 'hats', key: bankStockKey('378;6', PAINT) });
    expect(rows.get('price:2')!.timing).toEqual(scraptfTimingBrief(painted!));
    // No Sells for: 'no-buyers', still said.
    expect(rows.get('price:3')!.timing).toMatchObject({ verdict: 'no-buyers', key: bankStockKey('126;6', '') });
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
