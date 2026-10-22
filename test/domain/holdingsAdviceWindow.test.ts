// 0.8 (H6): a holding's advice reads every recorded run since the holding began (bounded by time and retention, never
// by the newest 500): on a busy book, whose exit changes every few minutes, the trend and the 7-day recorded high are
// still read from runs older than the newest 500. Real in-memory repo and market index, fake clock and timers;
// runs as the recorder writes them; nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { HOLDINGS_CHECK_MS, createHoldings } from '../../src/service/domain/holdings';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { HOLDING_HISTORY_MAX_RUNS, HOLDING_MARKS_PER_BASE_MAX, HOLDING_TREND_MIN_OBSERVED_MS } from '../../src/shared/holdingAdvice';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingLogger } from './helpers';

const DAY = 24 * HOUR;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const MARK = {
  baseSku: '378;6',
  revKeys: 0,
  revIsBot: true,
  revVerified: true,
  bestKeys: 0,
  bestMetalScrap: 120,
  nextKeys: null,
  nextMetalScrap: null,
  buyerCount: 1,
  verifiedBuyerCount: 1,
  askKeys: null,
  askMetalScrap: null,
  askCount: null,
  scraptfPaysKeys: null,
  scraptfPaysScrap: null,
  keyScrap: 567,
};

describe('holding advice over a busy book (H6)', () => {
  it('reads every run since the holding began: the trend and an older recorded high survive 1,200 newer runs', () => {
    expect(HOLDING_HISTORY_MAX_RUNS).toBe(HOLDING_MARKS_PER_BASE_MAX);
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
    // Alice pays 120 for a unit that cost 115: +5, under the minimum profit, so the advice weighs the recorded high.
    repo.upsertListings([makeListing({ id: 'tc', sku: '378;6', baseSku: '378;6', steamid: '76561198000000001', userName: 'Alice', isBot: true, metalScrap: 120, lastEventAt: T0 - MIN })]);
    repo.addJournal({ ts: T0 - 14 * DAY, side: 'buy', venue: 'scrap.tf', sku: '378;6', name: '378;6', keys: 0, scrap: 115, keyPriceScrap: 567, note: null });
    // 160 paid for 2 h six days ago, then a book whose best exit moved between 118 and 119 every 5.5 min for 110 h:
    // the newest 500 of those runs cover under 48 h of the window.
    repo.insertHoldingMark({ ...MARK, revMetalScrap: 160, fromAt: T0 - 6 * DAY - 2 * HOUR, toAt: T0 - 6 * DAY });
    const STEP = 5.5 * MIN;
    const N = 1_200;
    for (let i = 0; i < N; i++) {
      const fromAt = T0 - (N - i) * STEP;
      repo.insertHoldingMark({ ...MARK, revMetalScrap: 118 + (i % 2), fromAt, toAt: fromAt + STEP });
    }
    expect(500 * STEP).toBeLessThan(HOLDING_TREND_MIN_OBSERVED_MS);

    const clock = new FakeClock(T0);
    const timers = new FakeTimers(clock);
    const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } });
    const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now());
    const deps = makeDeps(repo, clock, () => settings, recordingLogger());
    const schema = createStubSchema();
    const market = createMarketIndex({ ...deps, schema, timers, keyPrice, onChanged: () => undefined, folderWatchActive: () => false, sliceNow: () => 0 });
    // No feedLiveSince: nothing is recorded during the test, the advice reads the runs above only.
    const holdings = createHoldings({ ...deps, schema, market, timers, keyPrice, notify: () => undefined });
    market.start();
    holdings.start();
    timers.advance(0);
    timers.advance(HOLDINGS_CHECK_MS);

    const row = holdings.list({}, clock.now()).rows.find((r) => r.sku === '378;6')!;
    expect(row.status).toBe('hold');
    // Every run read: the trend is there (no "not enough recorded history"), and the high from six days ago holds.
    expect(row.advice!.basis).toMatchObject({ runs: N + 1 });
    expect(row.advice!.reasons.map((r) => r.code)).not.toContain('no-history');
    expect(row.advice).toMatchObject({ kind: 'hold', reasons: [{ code: 'recorded-high', exitScrap: 160 }] });
    holdings.stop();
  });
});
